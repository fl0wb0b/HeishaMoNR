// == DT-BEGIN ==
// Verzoegerungstest (Schalt-Pruefstand): Einmal-Test, ob und wie lange sich Ausschalten bzw. Einschalten des Verdichters ueber eine Verschiebung der
// Heizkurve um +1 K hinauszoegern bzw. ausloesen laesst. REINE Funktion, ohne Zugriff auf Speicher/Dateien/MQTT (wird in der Simulation getestet).
//   dtStep(S, o, C) -> {S, shift, rows, ev, status, changed, disarm, alarm}
//   S: Zustand (ueberlebt Neustarts per Datei; nach einem Neustart wird ein laufender Test abgebrochen)
//   o: Beobachtung {now, hour, restart, arm, hpFresh, hpOn, ccMode, zones, sensorZ1, blockActive, applyOn, hz, runMin, vl, rl, soll, shiftHp, shiftCalc, corrActive,
//      at, pumpRpm, pel, defrost, dhw, heater, hc, quiet, rad: {known, on, chgMin}, rooms: [{id, name, t, ageMin, maxAgeMin, min, max}]}
//      shiftCalc = Verschiebung, die HeishaMoNR OHNE Test berechnet (Summe der Korrekturen); corrActive = Raumregelung/Nachtabsenkung/Softstart eingeschaltet
//   C: Einstellungen (Standardwerte stehen im Generator)
// Die Verschiebung wirkt nur ueber die Summenfunktion mit Frische-Pruefung (tools/delaytest_patch.py): bleibt der Aufruf aus, verfaellt sie nach 150 s.
// Die Rueckkehr auf 0 an der Anlage sichert der Rueckstellwaechter im Tab WP Managers (ebenfalls delaytest_patch.py); dieser Kern meldet nur und alarmiert.
// Schwellen der Leisha (Messung 07.-10.10.2026, 1-min-Daten): Stopp bei Vorlauf = angezeigter Soll +3,0..+3,25 K fuer 3 min; Start 6-13 min nachdem der
// Vorlauf angezeigten Soll -3,25 K erreicht hat. Handbuch (Serie J, 14.1.2.1): AUS bei Vorlauf - interner Soll > 2 K fuer 3 min, EIN bei Vorlauf - gespeicherter
// Ruecklauf < -3 K nach >= 3 min (passt zu den Starts nicht genau: Vorlauf lag dann 3,75..4,0 K unter dem Ruecklauf beim Stopp). Der Test trennt nur:
// folgt die Schwelle dem angezeigten Soll (inkl. Verschiebung) oder nicht.
function dtStep(S, o, C) {
    var MIN = 60000, ev = [], rows = [], now = o.now;
    S = S || {};
    if (!S.phase) { S.phase = 'idle'; }
    if (!S.day) { S.day = {d: '', n: 0}; }
    if (!S.tr) { S.tr = {}; }
    var tr = S.tr, prevShift = S.shift || 0, alarm = '';
    function r1(v) { return v === null || v === undefined || !isFinite(v) ? '' : String(Math.round(v * 100) / 100); }
    function pd(x) { return (x < 10 ? '0' : '') + x; }
    function hhmm(ts) { var d = new Date(ts); return pd(d.getHours()) + ':' + pd(d.getMinutes()); }
    function ymd(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pd(d.getMonth() + 1) + '-' + pd(d.getDate()); }
    function iso(ts) { return ymd(ts) + ' ' + hhmm(ts) + ':' + pd(new Date(ts).getSeconds()); }
    function de(v, d) { return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ','); }
    function sg(v, d) { return (v >= 0 ? '+' : '') + de(v, d); }
    function clean(t) { return String(t).replace(/,/g, ';'); }
    if (S.day.d !== ymd(now)) { S.day = {d: ymd(now), n: 0}; }
    var have = function (v) { return v !== null && v !== undefined && isFinite(v); };
    var running = have(o.hz) && o.hz > 0;

    // ---------- Beobachtungen verfolgen (unabhaengig vom Test)
    if (have(o.hz)) {
        if (tr.running === undefined) { tr.running = running; tr.since = now; }
        if (running !== tr.running) {
            if (!running && have(tr.rlRun)) { tr.rlStop = tr.rlRun; tr.stopTs = now; }                      // Ruecklauf beim Stopp ("gespeicherter Ruecklauf" laut Handbuch)
            tr.running = running; tr.since = now;
        }
        if (running && have(o.rl)) { tr.rlRun = o.rl; }
    }
    if (o.defrost) { tr.defrostSeen = now; } else if (tr.defrostWas) { tr.defrostEnd = now; }
    tr.defrostWas = !!o.defrost;
    if (o.dhw) { tr.dhwSeen = now; } else if (tr.dhwWas) { tr.dhwEnd = now; }
    tr.dhwWas = !!o.dhw;
    if (have(o.at) && o.at !== tr.at) { tr.at = o.at; tr.atSince = now; }                                     // Aussentemperatur seit wann unveraendert
    if (o.rad && o.rad.known) { if (tr.radOn !== undefined && tr.radOn !== o.rad.on) { tr.radChg = now; } tr.radOn = o.rad.on; }
    tr.vl = (tr.vl || []).filter(function (p) { return now - p[0] <= 26 * MIN; });
    if (have(o.vl)) { tr.vl.push([now, o.vl]); }
    var sinceMin = tr.since ? (now - tr.since) / MIN : 0;
    if (running && have(o.runMin)) { sinceMin = Math.max(sinceMin, o.runMin); }                    // Laufzeit der Anlage (ueberlebt einen Neustart von Node-RED)
    var sollBase = (have(o.soll) && have(o.shiftHp)) ? o.soll - o.shiftHp : null;       // Sollvorlauf ohne Verschiebung (Heizkurve nach Aussentemperatur)
    var vlRel = (have(o.vl) && sollBase !== null) ? o.vl - sollBase : null;
    function change(minAgo) {                                                          // Aenderung des Vorlaufs (K) seit dem Wert vor >= minAgo Minuten, mit Zeitspanne
        var old = null;
        tr.vl.forEach(function (p) { if (now - p[0] >= minAgo * MIN - 30000 && (old === null || p[0] > old[0])) { old = p; } });
        return (old && have(o.vl)) ? {k: o.vl - old[1], min: (now - old[0]) / MIN} : null;
    }
    var ch10 = change(C.einSlopeWinMin), ch20 = change(20);
    var vlSlope = ch10 ? -ch10.k / ch10.min : null;                                     // Abfall in K/min ueber >= 10 min (0,25-K-Stufen: kuerzer ist zu ungenau)
    var rise20 = ch20 ? ch20.k / ch20.min * 60 : null;                                  // Anstieg in K/h ueber >= 20 min
    var ign = C.ignoreRooms || [];
    var hotRoom = null, coldRoom = null, staleRoom = null, hotK = null, coldK = null, oddRoom = null;
    (o.rooms || []).forEach(function (r) {
        var maxAge = S.phase === 'test' ? C.roomMaxAgeTestMin : r.maxAgeMin;            // im Test zaehlt der letzte gueltige Wert bis 180 min (die Sensoren melden nur alle ~2 h)
        var fresh = have(r.t) && have(r.ageMin) && r.ageMin <= maxAge;
        if (ign.indexOf(r.id) >= 0) {                                                  // Raum mit eigener lokaler Regelung: nur grobe Plausibilitaet
            if (fresh && (r.t < C.ignoreRange[0] || r.t > C.ignoreRange[1])) { oddRoom = oddRoom || r.name; }
            return;
        }
        if (!fresh) { staleRoom = staleRoom || r.name; return; }
        if (!have(r.min) || !have(r.max)) { staleRoom = staleRoom || (r.name + ' (Band fehlt)'); return; }
        if (r.t - r.max > (hotK === null ? -99 : hotK)) { hotK = r.t - r.max; hotRoom = r.name; }
        if (r.min - r.t > (coldK === null ? -99 : coldK)) { coldK = r.min - r.t; coldRoom = r.name; }
    });
    var wantHp = have(o.shiftCalc) ? Math.ceil(o.shiftCalc) : 0;                       // was HeishaMoNR ohne Test an der Anlage will

    // ---------- gemeinsame Vorbedingungen (gelten zum Start UND waehrend des Tests); Rueckgabe: Grund oder ''
    function common() {
        if (o.stateOk === false) { return 'Zustandsdatei nicht schreibbar (ein Neustart würde den Test vergessen)'; }
        if (!o.hpFresh) { return 'Anlagenwerte veraltet'; }
        if (o.blockActive) { return 'MQTT-Befehle gesperrt'; }
        if (o.applyOn) { return 'Übernahme der Entscheidungsmaschine eingeschaltet'; }
        if (o.hpOn !== true) { return 'Wärmepumpe aus'; }
        if (o.ccMode !== true) { return 'nicht im Heizkurvenmodus'; }
        if (o.zones !== 0) { return 'nicht nur Zone 1'; }
        if (o.sensorZ1 !== 0) { return 'Zone-1-Fühler nicht „Wasser“'; }
        if (!have(o.soll) || !have(o.vl) || !have(o.shiftHp) || !have(o.hz)) { return 'Anlagenwerte unvollständig'; }
        if (o.shiftHp !== 0 && o.shiftHp !== 1) { return 'Anlage meldet Verschiebung ' + de(o.shiftHp, 0) + ' K'; }
        if (o.defrost) { return 'Abtauen'; }
        if (o.dhw) { return 'Warmwasser'; }
        if (o.heater) { return 'Heizstab aktiv'; }
        if (!have(o.at)) { return 'Außentemperatur unbekannt'; }
        if (o.corrActive) { return 'Raumregelung/Nachtabsenkung/Softstart eingeschaltet'; }
        if (oddRoom) { return 'Raum außerhalb der Plausibilität: ' + oddRoom; }
        return '';
    }
    function startOnly() {
        if (staleRoom) { return 'Raumwert veraltet: ' + staleRoom; }
        if (tr.defrostEnd && now - tr.defrostEnd < C.afterMin * MIN) { return 'kurz nach Abtauen'; }
        if (tr.dhwEnd && now - tr.dhwEnd < C.afterMin * MIN) { return 'kurz nach Warmwasser'; }
        if (o.at < C.atMin || o.at > C.atMax) { return 'Außentemperatur ' + de(o.at, 0) + ' °C außerhalb ' + de(C.atMin, 1) + '…' + de(C.atMax, 1) + ' °C'; }
        if (!tr.atSince || now - tr.atSince < C.atStableMin * MIN) { return 'Außentemperatur erst seit ' + Math.round((now - (tr.atSince || now)) / MIN) + ' min unverändert (mind. ' + C.atStableMin + ')'; }
        if (o.hour < C.fromH || o.hour >= C.toH) { return 'außerhalb ' + C.fromH + '–' + C.toH + ' Uhr'; }
        if (S.day.n >= C.maxPerDay) { return 'Tageslimit erreicht'; }
        if (S.lastEnd && now - S.lastEnd < C.cooldownMin * MIN) { return 'Abkühlzeit nach dem letzten Test'; }
        if (o.shiftHp !== 0) { return 'Heizkurvenverschiebung an der Anlage ist ' + de(o.shiftHp, 0) + ' K'; }
        if (!have(o.shiftCalc)) { return 'berechnete Verschiebung unbekannt'; }
        if (o.shiftCalc !== 0) { return 'berechnete Verschiebung ist ' + de(o.shiftCalc, 1) + ' K (nicht genau 0)'; }
        if (hotK !== null && hotK > C.roomOverK) { return 'Raum zu warm: ' + hotRoom; }
        if (coldK !== null && coldK > 0) { return 'Raum unter Minimum: ' + coldRoom; }
        if (!o.rad || !o.rad.known) { return 'Zustand Radiator Kinderzimmer oben unbekannt'; }
        if (have(o.rad.chgMin) && o.rad.chgMin < C.radQuietMin) { return 'Radiator Kinderzimmer oben vor ' + Math.round(o.rad.chgMin) + ' min geschaltet'; }
        if (tr.radChg && now - tr.radChg < C.radQuietMin * MIN) { return 'Radiator Kinderzimmer oben vor kurzem geschaltet'; }
        return '';
    }
    function testSpecific(test) {
        if (test === 'ausschalten') {
            if (!running) { return 'Verdichter steht'; }
            if (sinceMin < C.minRunMin) { return 'Lauf erst ' + Math.round(sinceMin) + ' min alt (mind. ' + C.minRunMin + ')'; }
            if (o.rad.on !== false) { return 'Radiator Kinderzimmer oben ist an (Aus-Test nur mit Relais aus)'; }
            if (vlRel === null || vlRel < C.ausLow) { return 'Vorlauf ' + (vlRel === null ? '?' : sg(vlRel, 2)) + ' K zum Soll, noch nicht nahe der Abschaltgrenze (ab ' + sg(C.ausLow, 2) + ')'; }
            if (vlRel > C.ausHigh) { return 'Vorlauf ' + sg(vlRel, 2) + ' K zum Soll, Abschaltung steht unmittelbar bevor'; }
            if (rise20 === null || ch20.min < 19) { return 'Vorlaufverlauf noch zu kurz'; }
            if (rise20 < C.ausRiseMin) { return 'Vorlauf steigt nicht deutlich (' + de(rise20, 1) + ' K/h, mind. ' + de(C.ausRiseMin, 2) + ')'; }
            return '';
        }
        if (running) { return 'Verdichter läuft'; }
        if (sinceMin < C.minStopMin) { return 'Pause erst ' + Math.round(sinceMin) + ' min alt (mind. ' + C.minStopMin + ')'; }
        if (!have(o.pumpRpm) || o.pumpRpm < C.pumpMin || o.pumpRpm > C.pumpMax) { return 'Pumpe ' + (have(o.pumpRpm) ? Math.round(o.pumpRpm) + ' U/min' : 'unbekannt') + ' (kein normaler Stillstand)'; }
        if (vlRel === null || vlRel > C.einHigh) { return 'Vorlauf ' + (vlRel === null ? '?' : sg(vlRel, 2)) + ' K zum Soll, noch zu hoch (bis ' + sg(C.einHigh, 2) + ')'; }
        if (vlRel < C.einLow) { return 'Vorlauf ' + sg(vlRel, 2) + ' K zum Soll, zu nahe an der Schwelle (ab ' + sg(C.einLow, 2) + ')'; }
        if (vlSlope === null || ch10.min < C.einSlopeWinMin - 1) { return 'Vorlaufverlauf noch zu kurz'; }
        if (vlSlope < C.einSlopeMin) { return 'Vorlauf fällt nicht oder zu langsam (' + de(vlSlope * 60, 1) + ' K/h)'; }
        if (vlSlope > C.einSlopeMax) { return 'Vorlauf fällt zu schnell (' + de(vlSlope * 60, 1) + ' K/h), Hypothesen nicht trennbar'; }
        return '';
    }

    // ---------- Ablauf
    function reset() { S.phase = 'idle'; S.test = null; S.okSince = 0; S.alarm = false; }
    function result(txt, key, extra) {
        var t = S.test || {};
        S.last = {ts: now, test: t.kind, text: txt, key: key, confound: t.confound || ''};
        if (extra) { Object.keys(extra).forEach(function (k) { S.last[k] = extra[k]; }); }
        ev.push(iso(now) + ',verzoegerungstest_ergebnis,' + t.kind + ': ' + clean(txt) + (t.confound ? ' [Hinweis: ' + clean(t.confound.trim()) + ']' : ''));
    }
    function finish() { S.phase = 'nach'; S.nachSince = now; S.shift = 0; S.lastEnd = now; S.alarm = false; S.day.n++; disarm = true; }    // Einmal-Test: danach ist der Pruefstand wieder entschaerft
    function abort(why) {
        ev.push(iso(now) + ',verzoegerungstest_abbruch,' + (S.test ? S.test.kind : '') + ': ' + clean(why));
        S.last = {ts: now, test: S.test ? S.test.kind : '', text: 'Abbruch: ' + why, key: 'abbruch'};
        finish();
    }
    function row(kind, phase, shift, note, T) {
        rows.push([iso(now), kind, phase, shift, o.soll, sollBase, o.vl, vlRel, o.rl, o.hz, o.pel, o.pumpRpm, o.at, o.shiftHp, o.shiftCalc, hotK, coldK,
                   tr.rlStop, (o.rad && o.rad.known) ? (o.rad.on ? 1 : 0) : null, (T && T.tConf) ? (now - T.tConf) / MIN : null, note]);
    }

    var armWanted = o.arm === 'ausschalten' || o.arm === 'einschalten';
    var status = '', disarm = false;
    if (o.restart && S.phase === 'test') {                                                 // Neustart waehrend eines Tests: Verschiebung sofort zuruecknehmen
        abort('Neustart von Node-RED');
    } else if (S.phase === 'test') {
        var T = S.test, min = (now - T.t0) / MIN, why = '';
        if (!T.tConf && o.shiftHp === 1) {                                                 // Zeitbasis der Auswertung: Bestaetigung durch die Anlage (TOP27 = 1)
            T.tConf = now; T.vlRelConf = vlRel;
            ev.push(iso(now) + ',verzoegerungstest_hinweis,Anlage bestätigt +1 K nach ' + Math.round(min) + ' min');
        }
        var minC = T.tConf ? (now - T.tConf) / MIN : null;
        if (T.tConf && sollBase !== null && Math.abs(sollBase - T.sollBase0) >= 0.5) { T.jump = (T.jump || 0) + 1; } else { T.jump = 0; }
        if (o.rad && o.rad.known && T.radOn0 !== undefined && o.rad.on !== T.radOn0 && !T.radChg) { T.radChg = now; T.confound += 'Radiator ' + (o.rad.on ? 'an' : 'aus') + ' ' + hhmm(now) + ' '; }
        if (!armWanted) { why = 'vom Nutzer entschärft'; }
        else if ((why = common())) { /* Grund steht */ }
        else if (o.at < C.atMin - 1 || o.at > C.atMax + 1) { why = 'Außentemperatur verlässt das Fenster'; }
        else if (o.vl > C.vlMax) { why = 'Vorlauf über ' + C.vlMax + ' °C'; }
        else if (hotK !== null && hotK > C.roomHotAbortK) { why = 'Raum zu warm: ' + hotRoom; }
        else if (coldK !== null && coldK > C.roomColdAbortK) { why = 'Raum unter Minimum: ' + coldRoom; }
        else if (o.hc !== T.hc || o.quiet !== T.quiet) { why = 'Heizregelung oder Quiet geändert'; }
        else if (!T.tConf && min >= C.confirmMin) { why = 'Verschiebung wurde nicht bestätigt (Anlage meldet ' + de(o.shiftHp, 0) + ' K)'; }
        else if (T.tConf && o.shiftHp !== 1) { why = 'Anlage meldet wieder ' + de(o.shiftHp, 0) + ' K'; }
        else if (T.jump >= C.sollJumpMin) { why = 'Sollsprung durch die Außentemperatur (Ergebnis wäre verfälscht)'; }
        else if (T.kind === 'ausschalten' && vlRel !== null && vlRel > C.vlOverMax) { why = 'Vorlauf ' + sg(vlRel, 2) + ' K über dem Soll ohne Verschiebung, Anlage schaltet nicht ab'; }
        if (why) { abort(why); }
        else {
            if (T.kind === 'ausschalten') {
                if (running) {
                    T.vlLast = o.vl; T.vlRelLast = vlRel; T.pumpLast = o.pumpRpm;
                    if (T.tConf && vlRel !== null && vlRel >= C.ausOverK) { T.overMin = (T.overMin || 0) + 1; }      // ueber der natuerlichen Grenze, ohne Abschaltung
                    if (T.tConf && !T.tNatAus && vlRel !== null && vlRel >= C.ausStopNat - 1e-9) { T.tNatAus = now; }           // natuerliche Grenze erreicht: ohne Test Stopp etwa 3 min spaeter
                }
                if (!running && T.sawRun) {
                    var other = !T.tConf ? 'vor der Bestätigung' : (!have(T.pumpLast) || T.pumpLast < C.pumpMin ? 'Pumpe stand' : (T.radChg && now - T.radChg < 15 * MIN ? 'Radiator kurz vorher geschaltet' : ''));
                    var kl = other ? 'anderer_grund' : ((T.vlRelLast >= C.ausStopShift || (T.overMin || 0) >= C.ausOverMin) ? 'folgt_soll' : (T.vlRelLast <= C.ausStopNat ? 'ohne_wirkung' : 'unklar'));
                    var txtA = {folgt_soll: 'die Abschaltgrenze folgt dem Soll mit Verschiebung (Lauf verlängert)', ohne_wirkung: 'Abschaltung an der natürlichen Grenze: die Verschiebung hat den Stopp nicht hinausgezögert',
                                unklar: 'Abschaltung zwischen beiden Grenzen: nicht eindeutig', anderer_grund: 'Abschaltung aus anderem Grund (' + other + ')'}[kl];
                    var spaet = T.tNatAus ? Math.round((now - T.tNatAus) / MIN - 3) : null;                         // Minuten spaeter als ohne Verschiebung (Stopp 3 min nach Erreichen der Grenze)
                    result('Abschaltung ' + Math.round(minC === null ? min : minC) + ' min nach der Bestätigung bei Vorlauf ' + de(T.vlLast, 2) + ' °C (' + sg(T.vlRelLast, 2) + ' K zum Soll ohne Verschiebung; natürliche Grenze +3,0…+3,25 K)' +
                           (spaet !== null ? ', etwa ' + spaet + ' min später als ohne Verschiebung' : '') + ': ' + txtA,
                           'stopp', {minuten: Math.round(minC === null ? min : minC), vlRel: T.vlRelLast, klasse: kl, ueberMin: T.overMin || 0, spaeterMin: spaet});
                    finish();
                } else if (minC !== null && minC >= C.maxMinAus) {
                    var kl2 = (T.overMin || 0) >= C.ausOverMin ? 'folgt_soll' : 'grenze_nicht_erreicht';
                    result('keine Abschaltung innerhalb von ' + C.maxMinAus + ' min (Vorlauf ' + de(o.vl, 2) + ' °C, ' + (T.overMin || 0) + ' min über ' + sg(C.ausOverK, 2) + ' K): ' + (kl2 === 'folgt_soll' ? 'die Grenze folgt dem Soll mit Verschiebung' : 'natürliche Grenze nicht erreicht, ohne Aussage'),
                           'kein_stopp', {minuten: Math.round(minC), klasse: kl2, ueberMin: T.overMin || 0});
                    finish();
                }
                if (running) { T.sawRun = true; }
            } else {
                if (!running) {
                    T.relPause = vlRel; T.vlPause = o.vl; T.pumpPause = o.pumpRpm;                                         // letzter Vorlauf (zum Soll) vor dem Start
                    if (T.tConf && !T.tCross && vlRel !== null && vlRel <= C.einShiftThr + 1e-9) { T.tCross = now; }    // verschobene Schwelle (Soll+1 -3,25) erreicht
                    if (!T.tNat && vlRel !== null && vlRel <= C.einNatThr + 1e-9) { T.tNat = now; }                        // natuerliche Schwelle (Soll -3,25) erreicht
                }
                if (running && T.tConf && !T.tCross && have(T.relPause) && T.relPause <= C.einShiftThr + 0.25 + 1e-9) { T.tCross = now; }      // Start in derselben Minute wie das Erreichen (Aufloesung 0,25 K)
                var sinceCross = T.tCross ? (now - T.tCross) / MIN : null;
                if (running) {
                    var kl3, cls;
                    if (!T.tConf) { kl3 = 'vor_bestaetigung'; cls = 'Start vor der Bestätigung durch die Anlage: ohne Aussage'; }
                    else if (!have(T.pumpPause) || T.pumpPause > C.pumpMax || T.pumpPause < C.pumpMin) { kl3 = 'anderer_grund'; cls = 'vor dem Start Spülung oder Pumpe außerhalb des normalen Stillstands: ohne Aussage'; }
                    else if (T.tCross && !T.tNat && sinceCross <= C.einTimerMax + C.einTolMin) { kl3 = 'folgt_soll'; cls = 'Start ' + Math.round(sinceCross) + ' min nach Erreichen der verschobenen Schwelle, bevor die natürliche Schwelle erreicht war: die Einschaltschwelle folgt dem Soll mit Verschiebung'; }
                    else if (!T.tCross) { kl3 = 'frueher_als_erwartet'; cls = 'Start schon vor Erreichen der verschobenen Schwelle: nicht durch die Soll-Schwelle erklärt'; }
                    else if (T.tNat && sinceCross > C.einTimerMax + C.einTolMin) { kl3 = 'ohne_wirkung'; cls = 'Start erst nach der natürlichen Schwelle, nicht in den ' + (C.einTimerMax + C.einTolMin) + ' min nach der verschobenen: die Verschiebung hat den Start nicht ausgelöst'; }
                    else { kl3 = 'unklar'; cls = 'Start weder im erwarteten Fenster der verschobenen Schwelle noch klar nach der natürlichen: nicht eindeutig'; }
                    var rlTxt = have(tr.rlStop) && have(T.vlPause) ? '; Vorlauf − Rücklauf beim Stopp ' + sg(T.vlPause - tr.rlStop, 2) + ' K' : '';
                    // erwarteter Start ohne Verschiebung: natuerliche Schwelle (gemessen oder aus der Abfallrate beim Teststart) plus Timer-Mitte 9,5 min
                    var natAt = T.tNat ? T.tNat : ((have(T.slope0) && T.slope0 > 0.005 && have(T.relPause)) ? now + (T.relPause - C.einNatThr) / T.slope0 * MIN : null);
                    var frueher = natAt === null ? null : Math.round((natAt - now) / MIN + 9.5);
                    result('Start ' + Math.round(minC === null ? min : minC) + ' min nach der Bestätigung bei Vorlauf ' + sg(T.relPause, 2) + ' K zum Soll ohne Verschiebung' + rlTxt +
                           (frueher !== null && kl3 === 'folgt_soll' ? ', etwa ' + frueher + ' min früher als ohne Verschiebung' : '') + ': ' + cls, 'start',
                           {minuten: Math.round(minC === null ? min : minC), klasse: kl3, relStart: T.relPause, abSchwelle: sinceCross === null ? null : Math.round(sinceCross), frueherMin: frueher});
                    finish();
                } else if (minC !== null && minC >= C.maxMinEin) {
                    var kl4 = (T.tCross && sinceCross > C.einTimerMax + C.einTolMin) ? 'ohne_wirkung' : 'unklar';
                    result('kein Start innerhalb von ' + C.maxMinEin + ' min trotz +1 K (Vorlauf ' + sg(vlRel, 2) + ' K zum Soll ohne Verschiebung): ' + (kl4 === 'ohne_wirkung' ? 'die Verschiebung hat den Start nicht ausgelöst' : 'verschobene Schwelle nicht lange genug erreicht, ohne Aussage'),
                           'kein_start', {minuten: Math.round(minC), klasse: kl4});
                    finish();
                }
            }
            if (S.phase === 'test') {
                S.shift = 1;
                status = 'läuft: +1 K seit ' + Math.round(min) + ' min (Test ' + T.kind + (T.tConf ? ', bestätigt seit ' + Math.round(minC) + ' min' : ', wartet auf Bestätigung') + ')';
            }
        }
        if (T && S.phase !== 'idle') { row(T.kind, S.phase, S.phase === 'test' ? 1 : 0, T.confound.trim(), T); }
    } else if (S.phase === 'nach') {
        // Rueckstellung beobachten: fertig erst, wenn die Anlage wieder den Wert meldet, den HeishaMoNR ohne Test will. Nie still aufgeben.
        S.shift = 0;
        row(S.test ? S.test.kind : '', 'nach', 0, 'Verschiebung wird zurückgenommen (Anlage ' + (have(o.shiftHp) ? de(o.shiftHp, 0) : '?') + ' K, Ziel ' + wantHp + ' K)', null);
        if (o.hpFresh && o.shiftHp === wantHp) {
            if (S.alarm) { ev.push(iso(now) + ',verzoegerungstest_hinweis,Anlage meldet wieder ' + wantHp + ' K (Alarm aufgehoben)'); }
            reset();
        } else {
            var nm = Math.round((now - S.nachSince) / MIN);
            status = 'ACHTUNG: Anlage meldet noch ' + (have(o.shiftHp) ? de(o.shiftHp, 0) : '?') + ' K (Ziel ' + wantHp + ' K) seit ' + nm + ' min';
            if (nm >= C.nachMin) {
                if (!S.alarm) { S.alarm = true; alarm = 'Verzögerungstest: Verschiebung steht seit ' + nm + ' min noch an der Anlage (' + (have(o.shiftHp) ? de(o.shiftHp, 0) : '?') + ' K)'; ev.push(iso(now) + ',verzoegerungstest_alarm,' + clean(alarm)); }
            } else { status = 'beendet, Verschiebung wird zurückgenommen (Anlage ' + (have(o.shiftHp) ? de(o.shiftHp, 0) : '?') + ' K)'; }
        }
    } else {
        // ---------- Leerlauf: bei Entschaerfung nichts tun; scharf: Bedingungen pruefen und ggf. starten
        S.shift = 0;
        if (!armWanted) { reset(); }
        else {
            var wait = common() || startOnly() || testSpecific(o.arm);
            if (wait) {
                S.okSince = 0;
                status = 'scharf (' + o.arm + '), wartet: ' + wait;
                if (!tr.lastWaitLog || now - tr.lastWaitLog >= 10 * MIN) { tr.lastWaitLog = now; row(o.arm, 'warte', 0, wait, null); }
            } else {
                if (!S.okSince) { S.okSince = now; }
                status = 'scharf (' + o.arm + '), Bedingungen erfüllt seit ' + Math.round((now - S.okSince) / MIN) + ' min';
                if (now - S.okSince >= C.dwellMin * MIN) {
                    S.phase = 'test'; S.shift = 1;
                    S.test = {kind: o.arm, t0: now, hc: o.hc, quiet: o.quiet, sollBase0: sollBase, vlRel0: vlRel, vl0: o.vl, sawRun: running, confound: '', at0: o.at, slope0: vlSlope, rise0: rise20,
                              relPause: vlRel, vlPause: o.vl, radOn0: o.rad ? o.rad.on : undefined, rlStop: tr.rlStop};
                    ev.push(iso(now) + ',verzoegerungstest_start,' + o.arm + ' (+1 K) bei Vorlauf ' + de(o.vl, 2) + ' °C, ' + sg(vlRel, 2) + ' K zum Soll ' + de(sollBase, 0) + ' °C; Außen ' + de(o.at, 1) + ' °C; ' +
                            (o.arm === 'einschalten' ? 'Abfall ' + de(vlSlope * 60, 1) + ' K/h' : 'Anstieg ' + de(rise20, 1) + ' K/h') + '; Zeitzone UTC' + (new Date(now).getTimezoneOffset() <= 0 ? '+' : '-') + Math.abs(new Date(now).getTimezoneOffset() / 60));
                    row(o.arm, 'test', 1, 'Start', S.test);
                    status = 'läuft: +1 K seit 0 min (Test ' + o.arm + ', wartet auf Bestätigung)';
                }
            }
        }
    }
    if (S.phase === 'idle' && !status) { status = armWanted ? 'scharf (' + o.arm + ')' : 'aus (nicht scharf)'; }
    var shift = (S.phase === 'test') ? 1 : 0;
    S.shift = shift;
    var last = S.last ? 'letztes Ergebnis (' + hhmm(S.last.ts) + '): ' + S.last.text : '';
    return {S: S, shift: shift, rows: rows, ev: ev, status: status + (status && last ? ' · ' : '') + last, changed: shift !== prevShift, disarm: disarm, alarm: alarm};
}
// == DT-END ==

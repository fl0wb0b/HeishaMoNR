// == DT-BEGIN ==
// Verzoegerungstest (Schalt-Pruefstand): Einmal-Test, ob und wie lange sich Ausschalten bzw. Einschalten des Verdichters ueber eine Verschiebung der
// Heizkurve um +1 K hinauszoegern bzw. ausloesen laesst. REINE Funktion, ohne Zugriff auf Speicher/Dateien/MQTT (wird in der Simulation getestet).
//   dtStep(S, o, C) -> {S, shift, rows, ev, status}
//   S: Zustand (ueberlebt Neustarts per Datei; nach einem Neustart wird ein laufender Test abgebrochen)
//   o: Beobachtung {now, hour, restart, arm, hpFresh, hpOn, ccMode, zones, blockActive, hz, runMin, vl, rl, soll, shiftHp, at, pumpRpm, pel, defrost, dhw, heater,
//      hc, quiet, rooms: [{name, t, ageMin, maxAgeMin, min, max}]}
//   C: Einstellungen (Standardwerte stehen im Generator)
// Die Verschiebung wirkt nur ueber eine Summenfunktion mit Frische-Pruefung (siehe delaytest_patch.py): bleibt der Aufruf aus, verfaellt sie nach 150 s.
function dtStep(S, o, C) {
    var MIN = 60000, ev = [], rows = [], now = o.now;
    S = S || {};
    if (!S.phase) { S.phase = 'idle'; }
    if (!S.day) { S.day = {d: '', n: 0}; }
    if (!S.tr) { S.tr = {}; }
    var tr = S.tr, prevShift = S.shift || 0;
    function r1(v) { return v === null || v === undefined || !isFinite(v) ? '' : String(Math.round(v * 100) / 100); }
    function hhmm(ts) { var d = new Date(ts), p = function (x) { return (x < 10 ? '0' : '') + x; }; return p(d.getHours()) + ':' + p(d.getMinutes()); }
    function ymd(ts) { var d = new Date(ts), p = function (x) { return (x < 10 ? '0' : '') + x; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
    function iso(ts) { return ymd(ts) + ' ' + hhmm(ts) + ':' + (function (x) { return (x < 10 ? '0' : '') + x; })(new Date(ts).getSeconds()); }
    function de(v, d) { return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ','); }
    if (S.day.d !== ymd(now)) { S.day = {d: ymd(now), n: 0}; }
    var running = (o.hz || 0) > 0;
    var have = function (v) { return v !== null && v !== undefined && isFinite(v); };

    // ---------- Beobachtungen verfolgen (unabhaengig vom Test)
    if (tr.running === undefined) { tr.running = running; tr.since = now; }
    if (running !== tr.running) { tr.running = running; tr.since = now; }
    if (o.defrost) { tr.defrostSeen = now; } else if (tr.defrostWas) { tr.defrostEnd = now; }
    tr.defrostWas = !!o.defrost;
    if (o.dhw) { tr.dhwSeen = now; } else if (tr.dhwWas) { tr.dhwEnd = now; }
    tr.dhwWas = !!o.dhw;
    tr.vl = (tr.vl || []).filter(function (p) { return now - p[0] <= 8 * MIN; });
    if (have(o.vl)) { tr.vl.push([now, o.vl]); }
    var sinceMin = (now - tr.since) / MIN;
    if (running && have(o.runMin)) { sinceMin = Math.max(sinceMin, o.runMin); }                    // Laufzeit der Anlage (ueberlebt einen Neustart von Node-RED)
    var sollBase = (have(o.soll) && have(o.shiftHp)) ? o.soll - o.shiftHp : null;       // Sollvorlauf ohne Verschiebung (Heizkurve nach Aussentemperatur)
    var vlRel = (have(o.vl) && sollBase !== null) ? o.vl - sollBase : null;
    var vlTrend = null;                                                                // K in den letzten 3 Minuten
    (function () { var old = null; tr.vl.forEach(function (p) { if (now - p[0] >= 3 * MIN - 30000 && (old === null || p[0] > old[0])) { old = p; } }); if (old && have(o.vl)) { vlTrend = o.vl - old[1]; } }());
    var vlSlope = null;                                                               // Abfall in K/min ueber 6-8 Minuten (genauer als 3 min bei 0,25-K-Aufloesung)
    (function () { var old = null; tr.vl.forEach(function (p) { if (now - p[0] >= 6 * MIN - 30000 && (old === null || p[0] > old[0])) { old = p; } }); if (old && have(o.vl)) { vlSlope = (old[1] - o.vl) / ((now - old[0]) / MIN); } }());
    var hotRoom = null, coldRoom = null, staleRoom = null, hotK = null, coldK = null;
    (o.rooms || []).forEach(function (r) {
        if (!have(r.t)) { staleRoom = staleRoom || r.name; return; }
        if (!have(r.ageMin) || r.ageMin > r.maxAgeMin) { staleRoom = staleRoom || r.name; return; }
        if (r.t - r.max > (hotK === null ? -99 : hotK)) { hotK = r.t - r.max; hotRoom = r.name; }
        if (r.min - r.t > (coldK === null ? -99 : coldK)) { coldK = r.min - r.t; coldRoom = r.name; }
    });

    // ---------- gemeinsame Vorbedingungen (gelten zum Start UND waehrend des Tests); Rueckgabe: Grund oder ''
    function common() {
        if (!o.hpFresh) { return 'Anlagenwerte veraltet'; }
        if (o.blockActive) { return 'MQTT-Befehle gesperrt'; }
        if (o.hpOn !== true) { return 'Wärmepumpe aus'; }
        if (o.ccMode !== true) { return 'nicht im Heizkurvenmodus'; }
        if (o.zones !== 0) { return 'nicht nur Zone 1'; }
        if (!have(o.soll) || !have(o.vl) || !have(o.shiftHp)) { return 'Vorlauf/Soll unbekannt'; }
        if (o.defrost) { return 'Abtauen'; }
        if (o.dhw) { return 'Warmwasser'; }
        if (o.heater) { return 'Heizstab aktiv'; }
        if (!have(o.at)) { return 'Außentemperatur unbekannt'; }
        if (staleRoom) { return 'Raumwert veraltet: ' + staleRoom; }
        return '';
    }
    function startOnly() {
        if (tr.defrostEnd && now - tr.defrostEnd < C.afterMin * MIN) { return 'kurz nach Abtauen'; }
        if (tr.dhwEnd && now - tr.dhwEnd < C.afterMin * MIN) { return 'kurz nach Warmwasser'; }
        if (o.at < C.atMin || o.at > C.atMax) { return 'Außentemperatur ' + de(o.at, 0) + ' °C außerhalb ' + C.atMin + '…' + C.atMax + ' °C'; }
        if (o.hour < C.fromH || o.hour >= C.toH) { return 'außerhalb ' + C.fromH + '–' + C.toH + ' Uhr'; }
        if (S.day.n >= C.maxPerDay) { return 'Tageslimit erreicht'; }
        if (S.lastEnd && now - S.lastEnd < C.cooldownMin * MIN) { return 'Abkühlzeit nach dem letzten Test'; }
        if (o.shiftHp !== 0) { return 'Heizkurvenverschiebung ist ' + de(o.shiftHp, 0) + ' K (Raumregelung/Nachtabsenkung/Softstart aktiv)'; }
        if (hotK !== null && hotK > C.roomOverK) { return 'Raum zu warm: ' + hotRoom; }
        if (coldK !== null && coldK > 0) { return 'Raum unter Minimum: ' + coldRoom; }
        return '';
    }
    function testSpecific(test) {
        if (test === 'ausschalten') {
            if (!running) { return 'Verdichter steht'; }
            if (sinceMin < C.minRunMin) { return 'Lauf erst ' + Math.round(sinceMin) + ' min alt (mind. ' + C.minRunMin + ')'; }
            if (vlRel === null || vlRel < C.ausLow) { return 'Vorlauf ' + (vlRel === null ? '?' : (vlRel >= 0 ? '+' : '') + de(vlRel, 2)) + ' K zum Soll, noch nicht nahe der Abschaltgrenze (ab +' + de(C.ausLow, 2) + ')'; }
            if (vlRel > C.ausHigh) { return 'Vorlauf +' + de(vlRel, 2) + ' K zum Soll, Abschaltung steht unmittelbar bevor'; }
            if (vlTrend === null || vlTrend < -0.05) { return 'Vorlauf steigt nicht'; }
            return '';
        }
        if (running) { return 'Verdichter läuft'; }
        if (sinceMin < C.minStopMin) { return 'Pause erst ' + Math.round(sinceMin) + ' min alt (mind. ' + C.minStopMin + ')'; }
        if (!have(o.pumpRpm) || o.pumpRpm < 1000) { return 'Pumpe steht (Heizgrenze, kein normaler Stillstand)'; }
        if (vlRel === null || vlRel > C.einHigh) { return 'Vorlauf ' + (vlRel === null ? '?' : de(vlRel, 2)) + ' K zum Soll, noch zu hoch (bis ' + de(C.einHigh, 2) + ')'; }
        if (vlRel < C.einLow) { return 'Vorlauf ' + de(vlRel, 2) + ' K zum Soll, Start steht unmittelbar bevor'; }
        if (vlSlope === null || vlSlope < C.einSlopeMin) { return 'Vorlauf fällt nicht oder zu langsam (' + (vlSlope === null ? 'Verlauf fehlt' : de(vlSlope * 60, 1) + ' K/h') + ')'; }
        if (vlSlope > C.einSlopeMax) { return 'Vorlauf fällt zu schnell (' + de(vlSlope * 60, 1) + ' K/h), Prognose unsicher'; }
        return '';
    }

    // ---------- Test aktiv?
    function reset() { S.phase = 'idle'; S.test = null; S.okSince = 0; }
    function result(txt, key, extra) {
        var t = S.test || {};
        S.last = {ts: now, test: t.kind, text: txt, key: key, confound: t.confound || ''};
        if (extra) { Object.keys(extra).forEach(function (k) { S.last[k] = extra[k]; }); }
        ev.push(iso(now) + ',verzoegerungstest_ergebnis,' + t.kind + ': ' + String(txt).replace(/,/g, ';') + (t.confound ? ' [verfälscht durch: ' + t.confound.trim().replace(/,/g, ';') + ']' : ''));
    }
    function finish() { S.phase = 'nach'; S.nachSince = now; S.shift = 0; S.lastEnd = now; S.day.n++; disarm = true; }                     // Einmal-Test: danach ist der Pruefstand wieder entschaerft
    function abort(why) {
        ev.push(iso(now) + ',verzoegerungstest_abbruch,' + (S.test ? S.test.kind : '') + ': ' + String(why).replace(/,/g, ';'));
        S.last = {ts: now, test: S.test ? S.test.kind : '', text: 'Abbruch: ' + why, key: 'abbruch'};
        finish();
    }

    var armWanted = o.arm === 'ausschalten' || o.arm === 'einschalten';
    var status = '', disarm = false;
    if (o.restart && S.phase !== 'idle' && S.phase !== 'nach') {                           // Neustart waehrend eines Tests: Verschiebung sofort zuruecknehmen
        abort('Neustart von Node-RED');
        S.shift = 0;
    } else if (S.phase === 'test') {
        var T = S.test, min = (now - T.t0) / MIN, why = '';
        if (!armWanted) { why = 'vom Nutzer entschärft'; }
        else if ((why = common())) { /* Grund steht */ }
        else if (o.at < C.atMin - 1 || o.at > C.atMax + 1) { why = 'Außentemperatur verlässt das Fenster'; }
        else if (o.vl > C.vlMax) { why = 'Vorlauf über ' + C.vlMax + ' °C'; }
        else if (hotK !== null && hotK > C.roomOverK + 0.5) { why = 'Raum zu warm: ' + hotRoom; }
        else if (coldK !== null && coldK > 0.3) { why = 'Raum unter Minimum: ' + coldRoom; }
        else if (o.hc !== T.hc || o.quiet !== T.quiet) { why = 'Heizregelung oder Quiet geändert'; }
        else if (min >= C.confirmMin && o.shiftHp !== 1) { why = 'Verschiebung wurde nicht bestätigt (Anlage meldet ' + de(o.shiftHp, 0) + ' K)'; }
        else if (T.kind === 'ausschalten' && vlRel !== null && o.shiftHp === 1 && sollBase !== null && o.vl - sollBase > C.vlOverMax) { why = 'Vorlauf ' + de(o.vl - sollBase, 2) + ' K über dem Soll ohne Verschiebung, Anlage schaltet nicht ab'; }
        if (why) { abort(why); }
        else {
            if (sollBase !== null && o.shiftHp === 1 && Math.abs(sollBase - T.sollBase0) >= 0.5 && T.confound.indexOf('Sollsprung ' + hhmm(now)) < 0) { T.confound += 'Sollsprung ' + hhmm(now) + ' '; T.sollBase0 = sollBase; ev.push(iso(now) + ',verzoegerungstest_hinweis,Sollsprung durch die Heizkurve (Außentemperatur)'); }
            if (T.kind === 'ausschalten') {
                if (running) { T.vlLast = o.vl; T.vlRelLast = vlRel; }
                if (!running && T.sawRun) {
                    result('Abschaltung ' + Math.round(min) + ' min nach dem Start der Verschiebung (Vorlauf zuletzt ' + de(T.vlLast, 2) + ' °C, ' + (T.vlRelLast >= 0 ? '+' : '') + de(T.vlRelLast, 2) + ' K zum Soll ohne Verschiebung; ohne Verschiebung liegt die Grenze bei +3,25 K)', 'stopp', {minuten: Math.round(min), vlRel: T.vlRelLast});
                    finish();
                } else if (min >= C.maxMinAus) { result('keine Abschaltung innerhalb von ' + C.maxMinAus + ' min (Vorlauf ' + de(o.vl, 2) + ' °C)', 'kein_stopp', {minuten: Math.round(min)}); finish(); }
                if (running) { T.sawRun = true; }
            } else {
                if (!running) { T.relPause = vlRel; }                                               // letzter Vorlauf (zum Soll) vor dem Start
                if (running) {
                    var tNat = (T.slope0 !== null && T.slope0 > 0.01) ? (T.vlRel0 - C.einNat) / T.slope0 : null;       // Minuten, bis die Schwelle ohne Verschiebung (Soll -3 K) erreicht gewesen waere
                    var tPred = tNat === null ? null : tNat + C.einTimer;                                      // erwarteter Start ohne Wirkung der Verschiebung (gemessene Verzoegerung nach der Schwelle: 6-9 min)
                    var early = tPred !== null && min <= tPred - 5;                                            // deutlich frueher als ohne Verschiebung
                    var klasse = (min <= 3.5 && (tNat === null || min < tNat - 1.5)) ? 'sofort' : (early ? 'verzoegert' : (tPred !== null && min >= tPred - 3 ? 'ohne_wirkung' : 'unklar'));
                    var cls = klasse === 'sofort' ? 'Schwelle folgt dem Soll (−3 K) ohne Verzögerung' : (klasse === 'verzoegert' ? 'Schwelle folgt dem Soll (−3 K), aber mit einer Verzögerung von etwa ' + Math.round(min) + ' min (ohne Verschiebung wäre der Start nach etwa ' + Math.round(tPred) + ' min erwartet)' : (klasse === 'ohne_wirkung' ? 'Start zur selben Zeit wie ohne Verschiebung (erwartet nach etwa ' + Math.round(tPred) + ' min): die Verschiebung hat den Start nicht vorgezogen (z. B. beim Abschalten gespeicherter Wert)' : 'Start weder klar früher noch zur erwarteten Zeit (erwartet nach etwa ' + (tPred === null ? '?' : Math.round(tPred)) + ' min): nicht eindeutig'));
                    result('Start ' + Math.round(min) + ' min nach der Verschiebung bei Vorlauf ' + (T.relPause >= 0 ? '+' : '') + de(T.relPause, 2) + ' K zum Soll (vorher ' + de(T.vlRel0, 2) + ' K): ' + cls, 'start', {minuten: Math.round(min), klasse: klasse, relStart: T.relPause});
                    finish();
                } else if (min >= C.maxMinEin) { result('kein Start innerhalb von ' + C.maxMinEin + ' min trotz +1 K (Vorlauf ' + de(o.vl, 2) + ' °C)', 'kein_start', {minuten: Math.round(min)}); finish(); }
            }
            if (S.phase === 'test') {
                S.shift = 1;
                status = 'läuft: +1 K seit ' + Math.round(min) + ' min (Test ' + T.kind + ')';
            }
        }
        if (T && S.phase !== 'idle') {
            rows.push([iso(now), T.kind, S.phase, S.shift, o.soll, sollBase, o.vl, vlRel, o.rl, o.hz, o.pel, o.pumpRpm, o.at, o.shiftHp, hotK, coldK, T.confound.trim()]);
        }
    } else if (S.phase === 'nach') {
        S.shift = 0;
        rows.push([iso(now), S.test ? S.test.kind : '', 'nach', 0, o.soll, sollBase, o.vl, vlRel, o.rl, o.hz, o.pel, o.pumpRpm, o.at, o.shiftHp, hotK, coldK, 'Verschiebung wird zurückgenommen']);
        if (o.shiftHp === 0 || now - S.nachSince >= C.nachMin * MIN) {
            if (o.shiftHp !== 0) { ev.push(iso(now) + ',verzoegerungstest_hinweis,Anlage meldet nach ' + C.nachMin + ' min noch ' + de(o.shiftHp, 0) + ' K (die Steuerung gleicht es selbst an)'); }
            reset();
        }
        status = 'beendet, setzt die Verschiebung zurück';
    } else {
        // ---------- Leerlauf: bei Entschaerfung nichts tun; scharf: Bedingungen pruefen und ggf. starten
        S.shift = 0;
        if (!armWanted) { reset(); }
        else {
            var wait = common() || startOnly() || testSpecific(o.arm);
            if (wait) {
                S.okSince = 0;
                status = 'scharf (' + o.arm + '), wartet: ' + wait;
                if (!tr.lastWaitLog || now - tr.lastWaitLog >= 10 * MIN) { tr.lastWaitLog = now; rows.push([iso(now), o.arm, 'warte', 0, o.soll, sollBase, o.vl, vlRel, o.rl, o.hz, o.pel, o.pumpRpm, o.at, o.shiftHp, hotK, coldK, wait]); }
            } else {
                if (!S.okSince) { S.okSince = now; }
                status = 'scharf (' + o.arm + '), Bedingungen erfüllt seit ' + Math.round((now - S.okSince) / MIN) + ' min';
                if (now - S.okSince >= C.dwellMin * MIN) {
                    S.phase = 'test'; S.shift = 1;
                    S.test = {kind: o.arm, t0: now, hc: o.hc, quiet: o.quiet, sollBase0: sollBase, vlRel0: vlRel, vl0: o.vl, sawRun: running, confound: '', at0: o.at, slope0: vlSlope, relPause: vlRel};
                    ev.push(iso(now) + ',verzoegerungstest_start,' + o.arm + ' (+1 K) bei Vorlauf ' + de(o.vl, 2) + ' °C, ' + (vlRel >= 0 ? '+' : '') + de(vlRel, 2) + ' K zum Soll ' + de(sollBase, 0) + ' °C; Außen ' + de(o.at, 1) + ' °C');
                    rows.push([iso(now), o.arm, 'test', 1, o.soll, sollBase, o.vl, vlRel, o.rl, o.hz, o.pel, o.pumpRpm, o.at, o.shiftHp, hotK, coldK, 'Start']);
                    status = 'läuft: +1 K seit 0 min (Test ' + o.arm + ')';
                }
            }
        }
    }
    if (S.phase === 'idle' && !status) { status = armWanted ? 'scharf (' + o.arm + ')' : 'aus (nicht scharf)'; }
    var shift = (S.phase === 'test') ? 1 : 0;
    S.shift = shift;
    var last = S.last ? ' · letztes Ergebnis (' + hhmm(S.last.ts) + '): ' + S.last.text : '';
    return {S: S, shift: shift, rows: rows, ev: ev, status: status + last, changed: shift !== prevShift, disarm: disarm};
}
// == DT-END ==

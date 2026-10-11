// == ENGINE-CORE ==
// Entscheidungsmaschine des Optimierers (Shadow): wertet jede Minute aus, was sie schalten WUERDE, wann und warum, bewertet ihre eigenen
// Vorschlaege automatisch (Punkte ohne Nutzereingabe) und prueft Klick-Uebernahmen. REINE Funktionen: kein Speicher, keine Dateien, kein MQTT,
// keine Uhr (die Zeit kommt immer aus der Eingabe). Wird vom Generator in die Node-RED-Funktionen opt_engine und opt_apply eingebettet und in
// tools/engine_sim.js sowie tools/engine_replay.js direkt getestet.
//   ENGINE.step(S, inp, cfg)            -> {S, res, prop, rec, ev, scores, ende, locks}   eine Auswertung (jede Minute)
//   ENGINE.report(S)                    -> Punktebuch je Regel mit Freigabereife (nur Anzeige)
//   ENGINE.applyRequest(A, req, ctx)    -> {A, send, toast, log, sperren}                Klick: uebernehmen / verwerfen / zuruecksetzen / sperren
//   ENGINE.applyTick(A, ctx)            -> {A, send, toast, log}                         Ruecklesen, begrenzte Wiederholung, Rueckweg (alle 15 s)
var ENGINE = (function () {
    var VER = 1;                 // Format der Entscheidungsdatensaetze
    var SCORE_VER = 3;           // Bewertungsregeln (vorab festgelegt; jede Aenderung erhoeht die Version, alte Punkte bleiben getrennt)
                                 // v2 (10.10.2026): "verpasst" waehrend einer EIGENEN Sperre/Wartezeit (Standardwerte, ohne Schaden) zaehlt neutral und
                                 // getrennt ("waehrend Sperre"). v1 bleibt nachrechenbar: cfg.sv = 1 (Replay alter Datensaetze).
                                 // v3 (11.10.2026): Verschiebungs-Arbitrierung. Sperren durch eine Gegenregel ("vorrang", "gegenrichtung") entschuldigen
                                 // "verpasst" wie eigene Sperren; eine Lage, fuer die eine andere Verschiebungs-Regel dieselbe Richtung vorschlaegt, gilt als
                                 // versorgt; Wirkung einer uebernommenen Verschiebung zaehlt fuer die Regel, deren Vorschlag uebernommen wurde. cfg.sv = 2 rechnet v2 nach.
    var MIN = 60000;

    // ------------------------------------------------------------------ Hilfen (ohne Locale, damit jede Umgebung gleich rechnet)
    function have(v) { return v !== null && v !== undefined && typeof v === 'number' && isFinite(v); }
    function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } var n = Number(v); return isFinite(n) ? n : null; }
    function r2(v) { return have(v) ? Math.round(v * 100) / 100 : null; }
    function p2(x) { return (x < 10 ? '0' : '') + x; }
    function hhmm(ts) { var d = new Date(ts); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
    function ymd(ts) { var d = new Date(ts); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
    function iso(ts) { var d = new Date(ts); return ymd(ts) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
    function isoMin(ts) { return iso(ts).slice(0, 16); }
    function de(v, d) { if (!have(v)) { return '–'; } return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ','); }
    function sg(v, d) { if (!have(v)) { return '–'; } var r = Math.round(v * Math.pow(10, d)) / Math.pow(10, d); return (r > 0 ? '+' : '') + r.toFixed(d).replace('.', ','); }
    function mins(ms) { return Math.max(0, Math.round(ms / MIN)); }
    function rueckTxt(v) { if (!have(v)) { return '–'; } return Math.abs(v) < 0.005 ? 'genau am Soll' : de(Math.abs(v), 2) + ' K ' + (v > 0 ? 'darunter' : 'darüber'); }
    function zTxt(z) { return z === 'pause' ? 'Pause' : (z === 'heizgrenze' ? 'Heizgrenze-Aus' : (z === 'lauf' ? 'Lauf' : 'Zustand unbekannt')); }
    function isoWeek(ts) {                                                       // ISO-Kalenderwoche "2026-W41"
        var d = new Date(ts), t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var day = (t.getDay() + 6) % 7; t.setDate(t.getDate() - day + 3);
        var y = t.getFullYear(), f = new Date(y, 0, 4), fd = (f.getDay() + 6) % 7; f.setDate(f.getDate() - fd + 3);
        return y + '-W' + p2(1 + Math.round((t - f) / (7 * 24 * 3600000)));
    }
    // FNV-1a 32 bit ueber eine kanonische Darstellung (Pruefsumme des angezeigten Vorschlags)
    function fnv(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
    function checksum(p) { return p ? fnv([p.id, p.rule, p.ver, p.cmd.topic, String(p.cmd.value), String(p.von), String(p.ts), String(p.bis)].join('|')) : null; }

    // ------------------------------------------------------------------ Sperren, die jede Regel erbt (mit Herkunft)
    var LOCKS = [
        {id: 'anlauf', kurz: 'Anlaufsperre', text: 'Maschine beobachtet erst seit kurzem (Neustart)', herkunft: 'Zeitgeber und Zähler müssen nach einem Neustart erst wieder Daten sammeln (10 min)'},
        {id: 'daten', kurz: 'keine HeishaMon-Daten', text: 'HeishaMon-Daten fehlen oder sind veraltet', herkunft: 'HeishaMon meldet laufend; älter als 5 min = veraltet (Wächter: 10 min)'},
        {id: 'mqtt_sperre', kurz: 'MQTT-Notbremse', text: 'Alle MQTT-Befehle sind gesperrt (MQTT.block_active)', herkunft: 'HeishaMoNR-Notbremse; sie friert den Zustand ein (Opus-Review 09.10.)'},
        {id: 'abtauen', kurz: 'Abtauen', text: 'Abtauen oder kurz danach', herkunft: 'Wächter/Quiet-Logik: keine Änderung beim und 10 min nach dem Abtauen (Opus: 10–20 min)'},
        {id: 'warmwasser', kurz: 'Warmwasser', text: 'Warmwasser oder kurz danach', herkunft: 'wie Abtauen (diese Anlage macht kein Warmwasser, die Sperre bleibt als Schutz)'},
        {id: 'sanftanlauf', kurz: 'Sanftanlauf', text: 'Sanftanlauf (HeishaMoNR SoftStart) aktiv', herkunft: 'SoftStart verschiebt die Heizkurve selbst'},
        {id: 'laufbeginn', kurz: 'Laufbeginn', text: 'Verdichter läuft erst kurz', herkunft: 'Start-Pumpenspitze 2900 U/min für 11–16 min bei jedem Start; Quiet wirkt erst nach 1–2 min'},
        {id: 'heizgrenze_aus', kurz: 'Heizgrenze-Aus', text: 'Heizgrenze-Aus (Pumpe steht)', herkunft: 'Heizgrenze 12 °C mit Hysterese: aus ab 15 °C, ein ab 12 °C, Pumpe 0, Vorlauf ohne Aussage'},
        {id: 'regler', kurz: 'anderer Regler', text: 'Ein anderer Regler stellt dieselbe Größe', herkunft: 'HeishaMoNR-Quiet-Logik/Scheduler/Solar/WP-Zeitplan bzw. Raumregelung/Nachtabsenkung/Sanftanlauf; Verschiebung nur im Heizkurvenmodus mit Wasserfühler und ohne Handeingriff am Soll'},
        {id: 'abstand', kurz: 'Mindestabstand', text: 'Mindestabstand zur letzten Änderung', herkunft: 'Wächter: 60 min Abstand; Opus: höchstens 1 Wechsel pro Stunde'},
        {id: 'tageslimit', kurz: 'Tageslimit', text: 'Tageslimit der Regel erreicht', herkunft: 'Schreibbudget (Opus: höchstens 6 Wechsel/Tag), EEPROM-Verschleiß unbekannt'},
        {id: 'abkuehlzeit', kurz: 'Wartezeit', text: 'Wartezeit nach dem letzten Vorschlag', herkunft: 'kein Flattern: ein abgelaufener oder zurückgezogener Vorschlag kommt erst nach einer Pause wieder'},
        {id: 'takt', kurz: 'Takt-Gefahr', text: 'Takt-Gefahr: Vorlauf über Soll', herkunft: 'Anlage schaltet bei Vorlauf ≥ Soll +3,25 K nach ~3 min ab (6 Stopps 07.–10.10.); Sperre ab Soll +1 K für Maßnahmen, die den Vorlauf näher an diese Grenze bringen (mehr Leistung, −1 K)'},
        {id: 'heizstab', kurz: 'Heizstab-Nähe', text: 'Heizstab-Nähe', herkunft: 'Heizstab ab Außentemperatur < Heater_On_Outdoor_Temp (0 °C) bei Vorlauf < Soll −3 K nach 15 min; ein +1-K-Schritt vergrößert den Rückstand sofort um 1 K'},
        {id: 'modell', kurz: 'Modell-Gate', text: 'Gebäudemodell noch nicht freigegeben', herkunft: 'Wärmefahrplan: Gate des Gebäudemodells (≥ 10 Tage, Fehler ≥ 10 % kleiner als der bisherige Schätzer, plausible Koeffizienten); vorher ist eine Bedarfsvorhersage nicht belegt'},
        {id: 'vorrang', kurz: 'andere Regel', text: 'Die Heizkurven-Verschiebung gehört einer anderen Regel', herkunft: 'Verschiebungs-Arbitrierung: je Zeit hat genau eine Regel die Verschiebung (laufender Vorschlag oder übernommener Wert); keine zweite Regel schlägt daneben oder dagegen vor'},
        {id: 'gegenrichtung', kurz: 'Gegenrichtung', text: 'Gegenrichtung zur letzten Verschiebung', herkunft: 'Kein Hin und Her: Gegenrichtung frühestens shiftHaltMin (60 min) nach dem Ende der letzten Verschiebung und nur mit Komfort-Notfall (Raum ≥ notK 0,3 K außerhalb des Bandes), ohne Notfall erst nach gegenMin (240 min); ANNAHME'}
    ];
    var LOCK_TEXT = {}; LOCKS.forEach(function (l) { LOCK_TEXT[l.id] = l.text; });

    // ------------------------------------------------------------------ Vorausschau: Eingabe aus Wetter und Gebaeudemodell (rein; die Huelle und das Replay rufen sie auf)
    // W  = OPT_weather {f_ts, fpts: [[t, Temperatur, Feuchte, Bewoelkung, Wind m/s], ...]}
    // PL = OPT_plan {model: {n, minDays, gate, why, aktiv, bs, bw, ua, tbal}}  (Gate und coefActivate des Waermefahrplans)
    // PI = OPT_plan_in {pv: [[Beginn, W, Dauer ms], ...]}                       (PV-Prognose; nur mit aktivem Modell verwendet)
    // -> {age, at: [jetzt, +1 h ... +6 h] (an den Fuehler angeglichen, wie der Fahrplan: Versatz klingt mit 4 h ab), n, minDays, gate, ua, tbal, aktiv
    //     [, bs, bw, wind[], pv[]]}  Sonne und Wind stehen NUR mit aktivem Modell im Datensatz; ohne coefActivate kann die Regel sie nicht verwenden.
    var VS_H = 6;
    function vorschau(W, PL, PI, at, now) {
        W = W || {};
        var pts = (Array.isArray(W.fpts) ? W.fpts : []).filter(function (p) { return p && have(num(p[0])) && have(num(p[1])); }).sort(function (a, b) { return a[0] - b[0]; });
        if (!have(num(W.f_ts)) || pts.length < 2) { return null; }
        function ip(t, i) {
            if (t < pts[0][0] - 30 * MIN || t > pts[pts.length - 1][0]) { return null; }
            if (t <= pts[0][0]) { return num(pts[0][i]); }
            for (var k = 1; k < pts.length; k++) { if (pts[k][0] >= t) { var a = num(pts[k - 1][i]), b = num(pts[k][i]); return (a === null || b === null) ? null : a + (b - a) * (t - pts[k - 1][0]) / (pts[k][0] - pts[k - 1][0]); } }
            return null;
        }
        var owmNow = ip(now, 1), atN = num(at), anchor = (have(atN) && have(owmNow)) ? Math.max(-5, Math.min(5, atN - owmNow)) : 0;
        var M = (PL && PL.model) || {}, aktiv = M.aktiv === true || M.aktiv === 1;
        var o = {age: Math.round((now - num(W.f_ts)) / MIN), at: [], n: have(num(M.n)) ? num(M.n) : 0, minDays: have(num(M.minDays)) ? num(M.minDays) : 10, gate: (M.gate === true || M.gate === 1) ? 1 : 0,
                 ua: have(num(M.ua)) ? r2(num(M.ua)) : null, tbal: have(num(M.tbal)) ? num(M.tbal) : null, aktiv: aktiv ? 1 : 0};
        for (var h = 0; h <= VS_H; h++) { var x = h === 0 && have(atN) ? atN : ip(now + h * 3600000, 1); o.at.push(have(x) ? Math.round((h === 0 ? x : x + anchor * Math.exp(-h / 4)) * 10) / 10 : null); }
        if (aktiv) {                                                                // Sonne/Wind nur mit coefActivate (und offenem Gate, das prueft der Fahrplan)
            o.bs = have(num(M.bs)) ? num(M.bs) : 0; o.bw = have(num(M.bw)) ? num(M.bw) : 0; o.wind = []; o.pv = [];
            var pv = PI && Array.isArray(PI.pv) ? PI.pv : [];
            for (var j = 0; j <= VS_H; j++) {
                var w = ip(now + j * 3600000, 4); o.wind.push(have(w) ? Math.round(w * 10) / 10 : null);
                var a0 = now + j * 3600000 - 1800000, a1 = a0 + 3600000, sw = 0, dt = 0;
                pv.forEach(function (p) { var q0 = num(p[0]), q1 = q0 + num(p[2]), ov = Math.min(q1, a1) - Math.max(q0, a0); if (have(q0) && have(num(p[1])) && ov > 0) { sw += num(p[1]) * ov; dt += ov; } });
                o.pv.push(dt >= 0.9 * 3600000 ? Math.round(sw / dt) : null);
            }
        }
        return o;
    }
    // Bedarfsaenderung aus dem WETTER (nicht aus der Uhrzeit) als Aussentemperatur-Aequivalent in K, > 0: mehr Bedarf erwartet.
    // Von Vorhersage und jetzt wird zuerst der gewoehnliche Tagesgang abgezogen (base.at = mittlere Abweichung dieser Uhrzeit vom Tagesmittel, gemessen an
    // bis zu 7 Vortagen); verglichen werden die so bereinigten Werte: Fenster gegen jetzt. Ein gewoehnlicher Abend (kaelter als der Nachmittag) ergibt ~0,
    // ein Kaelteeinbruch oder eine Milderung die Aenderung. Sonne (nur mit aktivem Modell) ebenso gegen ihren Tagesgang. null = Vorhersage/Tagesgang reicht nicht.
    function bedarfK(v, c, base) {
        if (!v || !Array.isArray(v.at) || !base || !Array.isArray(base.at) || (have(base.n) && base.n < (c.tagesgangTage || 0))) { return null; }
        var ua = have(v.ua) && v.ua > 0 ? v.ua : 0.22, tb = have(v.tbal) ? v.tbal : 15;
        function q(i) {
            if (!have(v.at[i]) || !have(base.at[i])) { return null; }
            var T = v.at[i] - base.at[i], dK = Math.max(0, tb - T), x = ua * dK;
            if (v.aktiv) {
                var w = v.wind && have(v.wind[i]) ? v.wind[i] : 0, sp = v.pv && have(v.pv[i]) ? (v.pv[i] - (base.pv && have(base.pv[i]) ? base.pv[i] : 0)) / 1000 : 0;
                x = Math.max(0, x + (v.bw || 0) * dK * w - Math.max(-0.6 * x, Math.min((v.bs || 0) * sp, 0.6 * x)));
            }
            return x;
        }
        var q0 = q(0), s = 0, n = 0;
        for (var h = c.vonH; h <= c.bisH; h++) { var qi = q(h); if (qi === null) { return null; } s += qi; n++; }
        return (q0 === null || !n) ? null : r2((s / n - q0) / ua);
    }
    function vsFenster(v, c) {                                                       // Mittel der Vorhersage ueber das Fenster +vonH ... +bisH (Text)
        var t = 0, n = 0;
        for (var h = c.vonH; h <= c.bisH; h++) { if (!have(v.at[h])) { return null; } t += v.at[h]; n++; }
        return n ? {at: t / n} : null;
    }
    // Tagesgang: stuendliche Mittel der gemessenen Aussentemperatur (Fuehler; mit aktivem Modell auch PV) der letzten 8 Tage im Zustand.
    // Fuer jetzt und +1 ... +6 h: mittlere Abweichung derselben Uhrzeit vom zentrierten 24-h-Mittel an bis zu 7 Vortagen (je Tag mindestens 20 Stunden mit
    // mindestens 30 Minuten Daten); fehlt jeder Vortag, null. n = Zahl der verwendeten Vortage (kleinster Wert ueber die Stunden).
    var HOUR = 3600000, TG_MINN = 30, TG_TAGE = 7;
    function tgUpdate(S, d) {
        var now = d.now, hs = Math.floor(now / HOUR) * HOUR, L = S.atH = Array.isArray(S.atH) ? S.atH : [];
        if (have(d.at)) {
            var e = L[L.length - 1];
            if (!e || e[0] !== hs) { e = [hs, 0, 0, 0, 0]; L.push(e); }
            e[1] += d.at; e[2]++;
            var v = d.vs; if (v && v.aktiv && v.pv && have(v.pv[0])) { e[3] += v.pv[0]; e[4]++; }
        }
        while (L.length && now - L[0][0] > (TG_TAGE + 1) * 24 * HOUR + 2 * HOUR) { L.shift(); }
    }
    function tagesgang(S, now) {
        var L = Array.isArray(S.atH) ? S.atH : [], M = {}, o = {at: [], pv: [], n: null, h: 0};
        L.forEach(function (e) { if (e[2] >= TG_MINN) { M[e[0]] = e; o.h++; } });
        function dev(t, i, cnt) {                                                    // Abweichung der Stunde t vom zentrierten 24-h-Mittel (Spalte i: 1 Temperatur, 3 PV)
            var c = M[Math.floor(t / HOUR) * HOUR]; if (!c || !c[cnt]) { return null; }
            var s = 0, n = 0; for (var j = -12; j < 12; j++) { var e = M[Math.floor(t / HOUR) * HOUR + j * HOUR]; if (e && e[cnt]) { s += e[i] / e[cnt]; n++; } }
            return n >= 20 ? c[i] / c[cnt] - s / n : null;
        }
        for (var h = 0; h <= VS_H; h++) {
            var sa = 0, na = 0, sp = 0, np = 0;
            for (var k = 1; k <= TG_TAGE; k++) { var t = now + h * HOUR - k * 24 * HOUR, a = dev(t, 1, 2), p = dev(t, 3, 4); if (a !== null) { sa += a; na++; } if (p !== null) { sp += p; np++; } }
            o.at.push(na ? Math.round(sa / na * 100) / 100 : null); o.pv.push(np ? Math.round(sp / np) : null);
            o.n = o.n === null ? na : Math.min(o.n, na);
        }
        return o;
    }
    // Arbitrierung der Heizkurven-Verschiebung (alle Regeln der Groesse "shift"). Gemeinsamer Zustand S.arb:
    //   owner/soll/von/start  laufender Vorschlag (genau einer)   applied  von der Anlage uebernommene Verschiebung einer Regel   last  letzte beendete Verschiebung
    function shiftOwnedBy(d, self) { var ap = d.arb && d.arb.applied; return (ap && ap.rule !== self && have(d.shift) && d.shift !== 0 && d.shift === ap.w) ? ap.rule : null; }
    function komfortNot(d, dir) {                                                    // Komfort-Notfall: ein gueltiger Raum >= notK ausserhalb des Bandes in der Richtung, die die Massnahme behebt, keiner auf der anderen Seite
        var v = d.rooms.filter(function (r) { return r.active && r.valid && have(r.min) && have(r.max); });
        if (dir > 0) { return v.some(function (r) { return r.t <= r.min - d.notK; }) && !v.some(function (r) { return r.t > r.max; }); }
        return v.some(function (r) { return r.t >= r.max + d.notK; }) && !v.some(function (r) { return r.t < r.min; });
    }
    function sgnOf(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
    function arbEnd(A, d) { return (A.applied && A.last && A.applied.rule === A.last.rule && d.shift === A.applied.w) ? d.now : (A.last ? A.last.end : 0); }   // steht die Verschiebung noch, laeuft sie noch
    function arbLocks(R, e, d, S, cfg, add) {
        var A = S.arb, L = cfg.locks, now = d.now;
        if (!e || !have(e.wert) || !have(e.von)) { return; }
        var dir = sgnOf(e.wert - e.von);
        if (R.sperren.indexOf('vorrang') >= 0) {
            if (A.owner && A.owner !== R.id) { add('vorrang', (A.soll === e.wert ? 'dieselbe Verschiebung ' + sg(A.soll, 0) + ' K schlägt schon „' : 'Verschiebung ' + sg(A.soll, 0) + ' K vorgeschlagen von „') + RULE[A.owner].kurz + (A.soll === e.wert ? '“ vor' : '“')); }
            else if (shiftOwnedBy(d, R.id)) { add('vorrang', 'Verschiebung ' + sg(d.shift, 0) + ' K gehört „' + RULE[A.applied.rule].kurz + '“'); }
        }
        if (R.sperren.indexOf('gegenrichtung') >= 0 && A.last && dir !== 0 && A.last.dir === -dir) {
            var ls = A.last, end = arbEnd(A, d), el = now - end;
            var was = 'letzte Verschiebung ' + sg(ls.w, 0) + ' K („' + RULE[ls.rule].kurz + '“) bis ' + hhmm(end);
            if (el < L.shiftHaltMin * MIN) { add('gegenrichtung', was + ', Mindesthaltezeit ' + L.shiftHaltMin + ' min', end + L.shiftHaltMin * MIN); }
            else if (el < L.gegenMin * MIN && !e.hart) { add('gegenrichtung', was + ', ohne Komfort-Notfall erst nach ' + L.gegenMin + ' min', end + L.gegenMin * MIN); }
        }
    }

    // ------------------------------------------------------------------ Regelwerk als Daten. Jede Schwelle: Standard, Einheit, Herkunft (Messung / Nutzerregel / ANNAHME)
    var RULES = [
        {
            id: 'quiet_freigabe', ver: 1, kurz: 'Quiet-Freigabe', name: 'Quiet-Freigabe', art: 'befehl', groesse: 'quiet', richtung: 'mehr_leistung', prio: 1,
            zweck: 'Hängt der Verdichter trotz deutlichen Rückstands am Quiet-Deckel, Quiet auf 0 freigeben (Nutzerregel: Standard ist 0, nicht schrittweise).',
            eingaenge: ['Quiet-Stufe', 'Verdichterfrequenz', 'Soll-/Ist-Vorlauf', 'Rücklauf und Ziel-Spreizung (Heat_Delta)', 'Laufzeit', 'Räume (gültig, eigenes Band)'],
            sperren: ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt'],
            befehl: {name: 'SetQuietMode', topic: 'panasonic_heat_pump/commands/SetQuietMode'},
            schwellen: [
                {key: 'capHz', std: 20, einheit: 'Hz', herkunft: 'Messung: Quiet 3 hielt 16–17 Hz (10.10. 08:25–08:40, 16 min bei 6–7 K Rücklauf-Rückstand, Efficiency); Quiet 2 ebenso (08.10. 09:33–09:37, 3,25 K, Comfort, nur 4 min nach dem Start); Startspitzen 22–35 Hz nur in Minute 0–1'},
                {key: 'laufMin', std: 15, einheit: 'min', herkunft: 'Startroutine: Pumpenspitze 11–16 min nach jedem Start; Kaltstarts haben 15–25 min lang naturgemäß Rückstand'},
                {key: 'vlRueckK', std: 1.5, einheit: 'K', herkunft: 'Auftrag/Wächter (escCapDevK 1,5)'},
                {key: 'rlRueckK', std: 1.5, einheit: 'K', herkunft: 'Messung: der Verdichter folgt dem Rücklauf-Rückstand (Soll-RL = Soll-VL − Heat_Delta). 10.10. 11:17 Quiet 0, RL-Rückstand ≤ 0,25 K: blieb trotz Vorlauf −2,25 K bei 16–17 Hz; Boost mit 2,5–6,75 K: 33–34 Hz. 1,5 K ist ANNAHME zwischen 0,25 und 2,5'},
                {key: 'haltMin', std: 10, einheit: 'min', herkunft: 'Auftrag/Wächter (escCapMin 10): Bedingungen 10 min am Stück nach der Startphase'},
                {key: 'proTag', std: 3, einheit: 'Vorschläge', herkunft: 'Schreibbudget; ANNAHME'},
                {key: 'gueltigMin', std: 30, einheit: 'min', herkunft: 'Quiet wirkt in 1–2 min; nach 30 min ist die Lage eine andere (ANNAHME)'},
                {key: 'pauseMin', std: 60, einheit: 'min', herkunft: 'wie Mindestabstand (ANNAHME)'}
            ],
            erwartung: 'Verdichter ≥ 25 Hz binnen 5 min, elektrische Leistung +350 bis +650 W, Vorlauf +2 K in 30 min (gemessen 10.10.2026 08:41 mit Heizregelung Efficiency: 29 Hz nach 1 min, 34 Hz nach 2 min, +490–590 W, Vorlauf +4 K in 20 min bei 11–12 °C; nicht gemessen: kältere Außentemperatur und Comfort – ob das Plateau 33–34 Hz eine Temperaturgrenze oder eine Begrenzung durch Efficiency ist, ist offen, siehe Messaufgabe)',
            rueckweg: 'Kein automatischer Rückweg: Quiet 0 ist der Standard des Betreibers. „Zurücksetzen“ stellt die vorherige Stufe wieder her; zurück auf 3 nur über die Regel „Laufzeit strecken“ oder von Hand.',
            prognose: {p: 0.8, h: [30, 60, 120], text: 'Ohne Freigabe bleibt der Verdichter am Deckel (≤ 20 Hz) und der Rücklauf-Rückstand ≥ 1 K'},
            kalibriert: ['2026-10-10 08:40', '2026-10-08 22:54', '2026-10-10 11:17'],
            eval: function (d, c) {
                if (!have(d.q)) { return {inaktiv: 'Quiet-Stufe unbekannt'}; }
                if (d.q === 0) { return {inaktiv: 'Quiet steht auf 0 (Standard des Betreibers)'}; }
                var rb = d.roomBelow[0];
                var cond = [
                    {k: 'lauf', kz: 'Verdichter läuft', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running},
                    {k: 'laufMin', kz: 'Laufzeit', t: 'Lauf seit mindestens ' + c.laufMin + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + c.laufMin + ' min', ok: d.runMin >= c.laufMin, ist: r2(d.runMin), soll: c.laufMin, op: '>=', u: 'min', dyn: true},
                    {k: 'deckel', kz: 'Frequenz', t: 'Verdichter am Quiet-Deckel (≤ ' + c.capHz + ' Hz)', tn: 'Verdichter nicht am Deckel (' + de(d.hz, 0) + ' Hz)', ok: have(d.hz) && d.hz > 0 && d.hz <= c.capHz, ist: d.hz, soll: c.capHz, op: '<=', u: 'Hz', dyn: true},
                    {k: 'vlRueck', kz: 'Vorlauf-Rückstand', t: 'Vorlauf mindestens ' + de(c.vlRueckK, 1) + ' K unter Soll', tn: 'Vorlauf ' + rueckTxt(d.vlRueck) + ' (Schwelle ' + de(c.vlRueckK, 1) + ' K darunter)', ok: have(d.vlRueck) && d.vlRueck >= c.vlRueckK, ist: r2(d.vlRueck), it: rueckTxt(d.vlRueck), soll: c.vlRueckK, op: '>=', u: 'K', dyn: true},
                    {k: 'rlRueck', kz: 'Rücklauf-Rückstand', t: 'Rücklauf mindestens ' + de(c.rlRueckK, 1) + ' K unter Soll-Rücklauf', tn: 'Rücklauf ' + rueckTxt(d.rlRueck) + ' (Schwelle ' + de(c.rlRueckK, 1) + ' K darunter)', ok: have(d.rlRueck) && d.rlRueck >= c.rlRueckK, ist: r2(d.rlRueck), it: rueckTxt(d.rlRueck), soll: c.rlRueckK, op: '>=', u: 'K', dyn: true},
                    {k: 'bedarf', kz: 'Bedarf', t: 'Raum unter Minimum oder Sollvorlauf noch nicht erreicht', tn: 'kein Bedarf: alle gültigen Räume ab Minimum und Sollvorlauf in diesem Lauf erreicht', ok: !!rb || !d.reached}
                ];
                return {cond: cond, halt: c.haltMin, wert: 0, von: d.q,
                        was: 'Quiet-Stufe ' + d.q + ' → 0',
                        warum: 'Verdichter ' + de(d.hz, 0) + ' Hz am Quiet-Deckel, Vorlauf ' + de(d.vlRueck, 1) + ' K und Rücklauf ' + de(d.rlRueck, 1) + ' K unter Soll, Lauf ' + de(d.runMin, 0) + ' min; ' + (rb ? rb.name + ' ' + de(rb.min - rb.t, 1) + ' K unter Minimum' : 'Sollvorlauf in diesem Lauf noch nicht erreicht')};
            }
        },
        {
            id: 'quiet_strecken', ver: 1, kurz: 'Laufzeit strecken', name: 'Laufzeit strecken (Quiet 3)', art: 'befehl', groesse: 'quiet', richtung: 'weniger_leistung', prio: 2,
            zweck: 'Läuft der Verdichter ohne Bedarf deutlich über Minimum und droht ein kurzer Lauf, die Leistung mit Quiet 3 deckeln, damit er länger bei niedriger Leistung läuft. Rückkehr auf 0, sobald der Grund endet.',
            eingaenge: ['Quiet-Stufe', 'Verdichterfrequenz', 'Vorlauf und Anstieg', 'Rücklauf-Rückstand', 'Räume', 'letzte Läufe/Starts'],
            sperren: ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'heizstab'],
            befehl: {name: 'SetQuietMode', topic: 'panasonic_heat_pump/commands/SetQuietMode'},
            schwellen: [
                {key: 'hzHoch', std: 22, einheit: 'Hz', herkunft: 'Minimum gemessen 16–17 Hz; 22 Hz = deutlich darüber (ANNAHME)'},
                {key: 'laufMin', std: 15, einheit: 'min', herkunft: 'Startroutine (siehe Quiet-Freigabe)'},
                {key: 'rlRueckMaxK', std: 1.0, einheit: 'K', herkunft: 'kein Bedarf: Rücklauf höchstens 1 K unter Soll (ANNAHME, vgl. Quiet-Freigabe 1,5 K)'},
                {key: 'stoppBaldMin', std: 45, einheit: 'min', herkunft: 'Takt-Indiz: Vorlauf erreicht beim aktuellen Anstieg binnen 45 min Soll +3,25 K (ANNAHME)'},
                {key: 'kurzerLaufMin', std: 60, einheit: 'min', herkunft: 'Takt-Indiz: letzter Lauf kürzer als 60 min (Opus: Mindestlauf 60 min)'},
                {key: 'starts3h', std: 2, einheit: 'Starts', herkunft: 'Takt-Indiz: mindestens 2 Starts in 3 h (07.–10.10.: höchstens 1)'},
                {key: 'haltMin', std: 10, einheit: 'min', herkunft: 'wie Quiet-Freigabe'},
                {key: 'proTag', std: 2, einheit: 'Vorschläge', herkunft: 'ANNAHME'},
                {key: 'gueltigMin', std: 30, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'pauseMin', std: 120, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'maxDauerMin', std: 240, einheit: 'min', herkunft: 'Rückweg spätestens nach 4 h (Nutzerregel: Standard 0)'},
                {key: 'bedarfRlK', std: 2.5, einheit: 'K', herkunft: 'Rückweg: Rücklauf-Rückstand ≥ 2,5 K seit 15 min = Leistung wird gebraucht (Boost-Messung)'}
            ],
            erwartung: 'Verdichter fällt binnen 3 min auf ≤ 20 Hz, elektrische Leistung −300 W oder mehr, der Lauf wird länger (Quiet 3 hielt 16–17 Hz bei jedem gemessenen Rückstand; COP im Mindestbetrieb 6,9 statt 6,0 bei 33 Hz, 10.10.)',
            rueckweg: 'Automatisch zurück auf 0, sobald ein Raum unter Minimum fällt, der Rücklauf-Rückstand 15 min ≥ 2,5 K beträgt oder spätestens nach 4 h.',
            prognose: {p: 0.7, h: [60], text: 'Ohne Deckel endet der Lauf binnen 60 min (kurzer Lauf)'},
            kalibriert: [],
            eval: function (d, c) {
                if (!have(d.q)) { return {inaktiv: 'Quiet-Stufe unbekannt'}; }
                if (d.q >= 3) { return {inaktiv: 'Quiet steht schon auf 3'}; }
                var taktTxt = [], takt = false, rb = d.roomBelow[0];
                if (have(d.stopEtaMin) && d.stopEtaMin <= c.stoppBaldMin) { takt = true; taktTxt.push('Vorlauf erreicht in ~' + de(d.stopEtaMin, 0) + ' min die Abschaltgrenze'); }
                if (have(d.lastRunMin) && d.lastRunMin < c.kurzerLaufMin) { takt = true; taktTxt.push('letzter Lauf nur ' + de(d.lastRunMin, 0) + ' min'); }
                if (d.starts3h >= c.starts3h) { takt = true; taktTxt.push(d.starts3h + ' Starts in 3 h'); }
                var cond = [
                    {k: 'lauf', kz: 'Verdichter läuft', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running},
                    {k: 'laufMin', kz: 'Laufzeit', t: 'Lauf seit mindestens ' + c.laufMin + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + c.laufMin + ' min', ok: d.runMin >= c.laufMin, ist: r2(d.runMin), soll: c.laufMin, op: '>=', u: 'min', dyn: true},
                    {k: 'hoch', kz: 'Frequenz', t: 'Verdichter deutlich über Minimum (≥ ' + c.hzHoch + ' Hz)', tn: 'Verdichter bei ' + de(d.hz, 0) + ' Hz (Schwelle ' + c.hzHoch + ' Hz)', ok: have(d.hz) && d.hz >= c.hzHoch, ist: d.hz, soll: c.hzHoch, op: '>=', u: 'Hz', dyn: true},
                    {k: 'keinBedarf', kz: 'Rücklauf-Rückstand', t: 'kein Raum unter Minimum und Rücklauf höchstens ' + de(c.rlRueckMaxK, 1) + ' K unter Soll', tn: rb ? 'Bedarf: ' + rb.name + ' unter Minimum' : 'Bedarf: Rücklauf ' + rueckTxt(d.rlRueck), ok: !rb && have(d.rlRueck) && d.rlRueck <= c.rlRueckMaxK, ist: rb ? null : r2(d.rlRueck), soll: c.rlRueckMaxK, op: '<=', u: 'K', dyn: !rb},
                    {k: 'takt', kz: 'Takt-Indiz', t: 'Takt-Indiz (Abschaltung binnen ' + c.stoppBaldMin + ' min, kurzer letzter Lauf oder viele Starts)', tn: 'kein Takt-Indiz' + (have(d.stopEtaMin) ? ' (Abschaltgrenze in ~' + de(d.stopEtaMin, 0) + ' min)' : ''), ok: takt}
                ];
                return {cond: cond, halt: c.haltMin, wert: 3, von: d.q,
                        was: 'Quiet-Stufe ' + d.q + ' → 3 (Laufzeit strecken)',
                        warum: 'Verdichter ' + de(d.hz, 0) + ' Hz ohne Bedarf (Rücklauf ' + rueckTxt(d.rlRueck) + ', alle Räume mindestens im Band); ' + taktTxt.join(', ')};
            }
        },
        {
            id: 'raum_offset', ver: 2, kurz: 'Raumeinfluss ±1 K', name: 'Raumeinfluss (Heizkurve ±1 K)', art: 'befehl', groesse: 'shift', richtung: 'verschiebung', prio: 3,
            zweck: 'Räume wirken nur als langsamer, kleiner Offset auf die Heizkurve (Lambda-Prinzip). Übernimmt den Raumvorschlag der Phase-2-Logik (korrektur_vorschlag −1/0/+1) erst, wenn er lange stabil ist. Nie Comfort/Efficiency. Seit v2 Teil der Verschiebungs-Arbitrierung: eine Verschiebung, die einer anderen Regel gehört (Vorausschau), gilt nicht als Abweichung; Gegenrichtung nur nach Wartezeit und mit Komfort-Notfall.',
            eingaenge: ['Raumvorschlag Phase 2 (korrektur_vorschlag, Führungsraum, Wärmeverteilung)', 'Verschiebung an der Anlage (TOP27)', 'Soll-Vorlauf und Heizkurve', 'Heizkurvenmodus/Zonenfühler', 'Eigentümer der Verschiebung (Arbitrierung)'],
            sperren: ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'heizstab'],
            befehl: {name: 'SetZ1HeatRequestTemperature', topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature'},
            schwellen: [
                {key: 'stabilMin', std: 60, einheit: 'min', herkunft: 'lange Haltezeit (Auftrag); Phase 2 wartet selbst 45–60 min. Räume reagieren träge, Shelly melden erst ab 0,5 K'},
                {key: 'minVlC', std: 29, einheit: '°C', herkunft: 'Nutzervorgabe 08.10.: Soll-Vorlauf nie unter 29 °C (Heizkörper)'},
                {key: 'proTag', std: 4, einheit: 'Vorschläge', herkunft: 'Opus: höchstens 6 Schreibbefehle/Tag'},
                {key: 'gueltigMin', std: 120, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'pauseMin', std: 120, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'maxDauerMin', std: 360, einheit: 'min', herkunft: 'Rückweg spätestens nach 6 h (ANNAHME)'}
            ],
            erwartung: '+1 K: Soll-Vorlauf +1 K binnen 3 min, im Taktbetrieb +40–60 min Laufzeit je Lauf (Sollsprünge 07.–10.10.), Strom +2,5–3 % (8,5 W/K); Raumwirkung NICHT gemessen. −1 K: umgekehrt.',
            rueckweg: 'Automatisch zurück auf 0 K, sobald der Raumvorschlag 15 min am Stück 0 ist oder spätestens nach 6 h; „Zurücksetzen“ jederzeit.',
            prognose: {p: 0.7, h: [60, 120, 240], text: 'Ohne Verschiebung bleibt der Führungsraum außerhalb seines Bandes'},
            kalibriert: [],
            eval: function (d, c, rs) {
                var k = d.korr;
                if (!k || !have(num(k.v))) { return {inaktiv: 'Raumvorschlag (Phase 2) fehlt'}; }
                if (!have(d.shift)) { return {inaktiv: 'Verschiebung der Anlage (TOP27) unbekannt'}; }
                var kv = num(k.v);
                if (kv === d.shift) { return {inaktiv: 'Raumvorschlag ' + sg(kv, 0) + ' K = Verschiebung der Anlage'}; }
                // Arbitrierung (v2): eine uebernommene Verschiebung einer anderen Regel (z. B. Vorausschau +1 K) ist kein Grund, sie auf den Raumvorschlag
                // zurueckzustellen. Raumvorschlag 0 = "Raeume brauchen nichts": nicht dagegen arbeiten; nur die Gegenrichtung (-1 gegen +1) geht weiter in die
                // Arbitrierung (Sperren "vorrang"/"gegenrichtung", Komfort-Notfall).
                var fr = shiftOwnedBy(d, 'raum_offset');
                if (fr && kv === 0) { return {inaktiv: 'Verschiebung ' + sg(d.shift, 0) + ' K gehört der Regel „' + RULE[fr].kurz + '“'}; }
                var stab = rs.korrSince ? mins(d.now - rs.korrSince) : 0, down = kv < d.shift;
                var sollNeu = have(d.soll) ? d.soll + (kv - d.shift) : null;
                var cond = [
                    {k: 'stabil', kz: 'Raumvorschlag stabil', t: 'Raumvorschlag seit mindestens ' + c.stabilMin + ' min stabil', tn: 'Raumvorschlag ' + sg(kv, 0) + ' K erst seit ' + stab + ' von ' + c.stabilMin + ' min stabil', ok: stab >= c.stabilMin, ist: stab, soll: c.stabilMin, op: '>=', u: 'min', dyn: true},
                    {k: 'untergrenze', kz: 'Soll-Vorlauf neu', t: 'Soll-Vorlauf bleibt mindestens ' + de(c.minVlC, 0) + ' °C', tn: 'Soll-Vorlauf würde ' + de(sollNeu, 0) + ' °C (Untergrenze ' + de(c.minVlC, 0) + ' °C)', ok: !down || (have(sollNeu) && sollNeu >= c.minVlC - 1e-9), ist: r2(sollNeu), soll: c.minVlC, op: '>=', u: '°C', dyn: true},
                    {k: 'verteilung', kz: 'Wärmeverteilung', t: 'kein Wärmeverteilungsproblem', tn: 'Wärmeverteilungsproblem (ein Raum zu kalt, einer zu warm)', ok: !k.distrib}
                ];
                return {cond: cond, halt: 0, wert: kv, von: d.shift, dir: kv > d.shift ? 'soll_hoch' : 'soll_runter', lead: k.lead || '', hart: komfortNot(d, kv > d.shift ? 1 : -1),
                        was: 'Heizkurve ' + sg(d.shift, 0) + ' → ' + sg(kv, 0) + ' K (Soll-Vorlauf ' + de(d.soll, 0) + ' → ' + de(sollNeu, 0) + ' °C)',
                        warum: 'Raumvorschlag ' + sg(kv, 0) + ' K seit ' + stab + ' min: ' + (k.code || '') + (k.lead ? ' (Führungsraum ' + k.lead + ')' : '')};
            }
        },
        {
            id: 'heizgrenze_hinweis', ver: 1, kurz: 'Heizgrenze 10 °C', name: 'Heizgrenze 12 → 10 °C (nur Hinweis)', art: 'hinweis', groesse: 'heizgrenze', richtung: 'weniger_waerme', prio: 4,
            zweck: 'An milden Tagen läuft die Anlage bei 11–14 °C, obwohl alle Räume Reserve haben. Eine niedrigere Heizgrenze würde solche Läufe vermeiden. Nur Hinweis: Parameteränderung, nie per Klick.',
            eingaenge: ['Außentemperatur (Fühler)', 'Heizgrenze (Heating_Off_Outdoor_Temp)', 'Räume (alle aktiv und gültig)', 'Laufzeit'],
            sperren: ['anlauf', 'daten'],
            befehl: {name: 'SetHeatingOffOutdoorTemp', topic: 'panasonic_heat_pump/commands/SetHeatingOffOutdoorTemp'},
            schwellen: [
                {key: 'zielC', std: 10, einheit: '°C', herkunft: 'Opus-Bericht: 12 → 10 hätte 07./08.10. ~1,5–1,8 kWh el gespart; 07.–10.10.: 7 von 12 Läufen starteten bei ≥ 11 °C (~3,7 von 12,6 kWh el)'},
                {key: 'reserveK', std: 0.5, einheit: 'K', herkunft: 'Wärme eines Laufs (~4 kWh) hebt die Räume um ~0,4–0,6 K (Speichermasse 7–10 kWh/K, Opus); ANNAHME'},
                {key: 'laufMin', std: 15, einheit: 'min', herkunft: 'Startroutine'},
                {key: 'haltMin', std: 15, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'proTag', std: 2, einheit: 'Hinweise', herkunft: 'ANNAHME'},
                {key: 'gueltigMin', std: 120, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'pauseMin', std: 180, einheit: 'min', herkunft: 'ANNAHME'}
            ],
            erwartung: 'Mit Heizgrenze 10 °C startet die Anlage erst bei ≤ 10 °C (Hysterese wie bei 12: aus ab +3 K, ANNAHME); Läufe bei 11–14 °C entfallen.',
            rueckweg: 'Saisonale Einstellung: der Betreiber setzt sie von Hand (SetHeatingOffOutdoorTemp) und zurück.',
            prognose: {p: 0.6, h: [180], text: 'Alle Räume bleiben mindestens Minimum + Reserve (der Lauf war nicht nötig)'},
            kalibriert: [],
            eval: function (d, c) {
                if (!have(d.heatOffAT)) { return {inaktiv: 'Heizgrenze-Einstellung unbekannt'}; }
                if (d.heatOffAT <= c.zielC) { return {inaktiv: 'Heizgrenze steht schon auf ' + de(d.heatOffAT, 0) + ' °C'}; }
                var allValid = d.roomsActive > 0 && d.roomsValid === d.roomsActive;
                var tight = null; d.rooms.forEach(function (r) { if (r.active && r.valid && (tight === null || r.t - r.min < tight.t - tight.min)) { tight = r; } });
                var cond = [
                    {k: 'lauf', kz: 'Verdichter läuft', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running},
                    {k: 'laufMin', kz: 'Laufzeit', t: 'Lauf seit mindestens ' + c.laufMin + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + c.laufMin + ' min', ok: d.runMin >= c.laufMin, ist: r2(d.runMin), soll: c.laufMin, op: '>=', u: 'min', dyn: true},
                    {k: 'aussen', kz: 'Außentemperatur', t: 'Außentemperatur über ' + de(c.zielC, 0) + ' °C', tn: 'Außentemperatur ' + de(d.at, 0) + ' °C (nicht über ' + de(c.zielC, 0) + ' °C)', ok: have(d.at) && d.at > c.zielC, ist: d.at, soll: c.zielC + 1, op: '>=', u: '°C', dyn: true},
                    {k: 'raeume', kz: 'Räume gültig', t: 'alle aktiven Räume gültig', tn: 'nur ' + d.roomsValid + ' von ' + d.roomsActive + ' Räumen gültig', ok: allValid},
                    {k: 'reserve', kz: 'Raumreserve', t: 'jeder Raum mindestens ' + de(c.reserveK, 1) + ' K über Minimum', tn: 'knappster Raum ' + (tight ? tight.name + ' ' + sg(tight.t - tight.min, 1) + ' K' : '–') + ' über Minimum (Reserve ' + de(c.reserveK, 1) + ' K)', ok: allValid && tight !== null && tight.t - tight.min >= c.reserveK, ist: tight ? r2(tight.t - tight.min) : null, soll: c.reserveK, op: '>=', u: 'K', dyn: true}
                ];
                return {cond: cond, halt: c.haltMin, wert: c.zielC, von: d.heatOffAT, dir: 'weniger_waerme',
                        was: 'Heizgrenze ' + de(d.heatOffAT, 0) + ' → ' + de(c.zielC, 0) + ' °C (nur Hinweis)',
                        warum: 'Lauf bei ' + de(d.at, 0) + ' °C Außentemperatur, knappster Raum ' + (tight ? tight.name + ' ' + sg(tight.t - tight.min, 1) + ' K über Minimum' : '–')};
            }
        },
        {
            id: 'vorausschau', ver: 1, kurz: 'Vorausschau ±1 K', name: 'Vorausschau (Heizkurve ±1 K)', art: 'befehl', groesse: 'shift', richtung: 'verschiebung', prio: 5,
            zweck: 'Verschiebt die Heizkurve um ±1 K, bevor sich der Wärmebedarf WETTERBEDINGT ändert (der gewöhnliche Tagesgang ist herausgerechnet, die Uhrzeit allein löst nichts aus): +1 K, wenn Wettervorhersage und Gebäudemodell in den nächsten Stunden deutlich mehr Bedarf erwarten und alle Räume noch im Band liegen (mit Luft nach oben); −1 K bei erwartetem Wärmegewinn (Milderung; Sonne und Wind nur mit freigegebenem Modell, coefActivate). Läuft erst mit offenem Gate des Gebäudemodells, nie gegen den aktuellen Raumzustand und nie gegen eine Verschiebung einer anderen Regel (Arbitrierung).',
            eingaenge: ['Wettervorhersage OWM (+1 … +6 h, an den Außenfühler angeglichen)', 'gewöhnlicher Tagesgang (gemessene Außentemperatur bis 7 Vortage)', 'Gebäudemodell des Wärmefahrplans (UA, Heizgrenze tbal, Gate, coefActivate)', 'Sonne (PV-Prognose) und Wind nur mit coefActivate', 'Räume (alle gültig, eigenes Band)', 'Verschiebung der Anlage (TOP27) und Eigentümer der Verschiebung', 'Soll-Vorlauf'],
            sperren: ['anlauf', 'daten', 'modell', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'heizstab'],
            befehl: {name: 'SetZ1HeatRequestTemperature', topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature'},
            schwellen: [
                {key: 'deltaK', std: 2, einheit: 'K', herkunft: 'Bedarfsänderung aus dem Wetter als Außentemperatur-Äquivalent (Mittel des Fensters gegen jetzt, beide um den gewöhnlichen Tagesgang bereinigt); OWM weicht vom Fühler 1,5–1,9 K ab (08.–10.10.), darunter ist die Vorhersage kein Signal; ANNAHME'},
                {key: 'tagesgangTage', std: 3, einheit: 'Vortage', herkunft: 'Der gewöhnliche Tagesgang wird aus den Vortagen gelernt (Abweichung jeder Uhrzeit vom 24-h-Mittel); mit nur einem Vortag steckt dessen Wetter darin (Replay: Kaltfront 08.10. abends erschien am 09.10. als −5 K); ANNAHME'},
                {key: 'vonH', std: 2, einheit: 'h', herkunft: 'Fensterbeginn: +1 K wirkt über die Laufzeit erst nach 1–3 h im Raum (Speichermasse 7–10 kWh/K, Opus); ANNAHME'},
                {key: 'bisH', std: 5, einheit: 'h', herkunft: 'Fensterende: OWM liefert 3-h-Punkte, das Vertrauen fällt mit dem Vorlauf (Fahrplan: 1 − h/48); ANNAHME'},
                {key: 'reserveK', std: 0.3, einheit: 'K', herkunft: 'Luft im Band: bei +1 K wärmster Raum mindestens 0,3 K unter Maximum, bei −1 K kältester mindestens 0,3 K über Minimum (wie guardK des Fahrplans); ANNAHME'},
                {key: 'prognoseMaxMin', std: 120, einheit: 'min', herkunft: 'Fahrplan: Vorhersage gilt bis 2 h nach dem Abruf'},
                {key: 'haltMin', std: 30, einheit: 'min', herkunft: 'Vorhersage muss mindestens einen weiteren Abruf überstehen; ANNAHME'},
                {key: 'minVlC', std: 29, einheit: '°C', herkunft: 'Nutzervorgabe 08.10.: Soll-Vorlauf nie unter 29 °C (Heizkörper)'},
                {key: 'proTag', std: 2, einheit: 'Vorschläge', herkunft: 'Schreibbudget gemeinsam mit dem Raumeinfluss (Opus: höchstens 6 Schreibbefehle/Tag); ANNAHME'},
                {key: 'gueltigMin', std: 180, einheit: 'min', herkunft: 'Fensterende 5 h minus Fensterbeginn 2 h; ANNAHME'},
                {key: 'pauseMin', std: 180, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'maxDauerMin', std: 360, einheit: 'min', herkunft: 'Rückweg spätestens nach 6 h (wie Raumeinfluss, ANNAHME)'}
            ],
            erwartung: '+1 K: Soll-Vorlauf +1 K binnen 3 min, mehr Wärme vor dem erwarteten Bedarf (Strom +2,5–3 %, 8,5 W/K); die Räume bleiben im Band, obwohl der Bedarf steigt. −1 K: umgekehrt bei erwartetem Wärmegewinn. Raumwirkung NICHT gemessen.',
            rueckweg: 'Automatisch zurück auf 0 K, sobald die Vorhersage die Änderung 15 min am Stück nicht mehr zeigt (halbe Schwelle), sofort, wenn ein Raum das Band in Gegenrichtung verlässt, spätestens nach 6 h; nicht, solange der Raumeinfluss dieselbe Verschiebung verlangt.',
            prognose: {p: 0.6, h: [120, 240, 360], text: 'Ohne Verschiebung gerät der knappste Raum an den Bandrand (+1 K: höchstens Reserve über Minimum, −1 K: höchstens Reserve unter Maximum)'},
            kalibriert: [],
            eval: function (d, c, rs) {
                var v = d.vs;
                if (!v) { return {inaktiv: 'Wettervorhersage fehlt'}; }
                if (!have(d.shift)) { return {inaktiv: 'Verschiebung der Anlage (TOP27) unbekannt'}; }
                var ap = d.arb && d.arb.applied;
                if (ap && ap.rule === 'vorausschau' && d.shift === ap.w) { return {inaktiv: 'Verschiebung ' + sg(d.shift, 0) + ' K (Vorausschau) steht'}; }
                if (d.shift !== 0) { return {inaktiv: 'Verschiebung steht auf ' + sg(d.shift, 0) + ' K (Vorausschau nur von 0 K aus)'}; }
                if (!have(v.age) || v.age > c.prognoseMaxMin) { return {inaktiv: 'Wettervorhersage ' + (have(v.age) ? de(v.age, 0) + ' min alt' : 'ohne Zeitstempel')}; }
                var dk = d.vsDk, gv = !v.gate ? {id: 'modell', text: LOCK_TEXT.modell + ' (' + (v.n || 0) + ' von ' + (v.minDays || 10) + ' Tagen)', ist: v.n || 0, s: v.minDays || 10, u: 'Tage'} : null;
                if (dk === null) {
                    var tgw = vsFenster(v, c) === null ? 'Wettervorhersage reicht nicht bis +' + c.bisH + ' h' : (d.vsBase && d.vsBase.n > 0 ? 'Tagesgang noch nicht sicher (' + d.vsBase.n + ' von ' + c.tagesgangTage + ' Vortagen)' : 'Tagesgang noch nicht bekannt (' + (d.vsBase ? d.vsBase.h : 0) + ' h gemessen, mindestens 36 h)');
                    if (gv) { return {cond: [{k: 'bedarf', kz: 'Bedarfsänderung', t: 'Vorhersage und Tagesgang vorhanden', tn: tgw, ok: false}], halt: 0, vorab: gv}; }
                    return {inaktiv: tgw};
                }
                var up = rs.prop ? rs.prop.cmd.value > 0 : dk >= 0, sgn = up ? 1 : -1;
                var thr = rs.prop ? c.deltaK / 2 : c.deltaK;                                   // laufender Vorschlag: Hysterese (halbe Schwelle), kein Flattern
                var act = d.rooms.filter(function (r) { return r.active; }), allValid = act.length > 0 && act.every(function (r) { return r.valid && have(r.min) && have(r.max); });
                var out = act.filter(function (r) { return r.valid && ((have(r.min) && r.t < r.min) || (have(r.max) && r.t > r.max)); });
                var cold = null, warm = null;
                act.forEach(function (r) { if (!r.valid) { return; } if (cold === null || r.t - r.min < cold.t - cold.min) { cold = r; } if (warm === null || r.max - r.t < warm.max - warm.t) { warm = r; } });
                var resv = up ? (warm ? warm.max - warm.t : null) : (cold ? cold.t - cold.min : null), sollNeu = have(d.soll) ? d.soll + sgn : null;
                var cond = [
                    {k: 'bedarf', kz: 'Bedarfsänderung', t: 'Vorhersage: Bedarf ' + (up ? 'steigt' : 'sinkt') + ' um mindestens ' + de(thr, 1) + ' K', tn: 'Vorhersage: Bedarf ' + sg(dk, 1) + ' K (Schwelle ' + (up ? '+' : '−') + de(thr, 1) + ' K)', ok: sgn * dk >= thr, ist: r2(sgn * dk), soll: thr, op: '>=', u: 'K', dyn: true},
                    {k: 'raeume', kz: 'Räume gültig', t: 'alle aktiven Räume gültig', tn: 'nicht alle Räume gültig', ok: allValid},
                    {k: 'band', kz: 'Räume im Band', hart: true, t: 'alle Räume im Komfortband', tn: out.length ? out[0].name + ' außerhalb des Bandes (' + de(out[0].t, 1) + ' °C)' : 'Raumlage unbekannt', ok: allValid && out.length === 0},
                    {k: 'reserve', kz: 'Luft im Band', t: (up ? 'wärmster Raum mindestens ' + de(c.reserveK, 1) + ' K unter Maximum' : 'kältester Raum mindestens ' + de(c.reserveK, 1) + ' K über Minimum'), tn: (up ? (warm ? warm.name + ' nur ' + de(resv, 1) + ' K unter Maximum' : 'kein Raum') : (cold ? cold.name + ' nur ' + de(resv, 1) + ' K über Minimum' : 'kein Raum')), ok: have(resv) && resv >= c.reserveK - 1e-9, ist: r2(resv), soll: c.reserveK, op: '>=', u: 'K', dyn: true}
                ];
                if (!up) { cond.push({k: 'untergrenze', kz: 'Soll-Vorlauf neu', t: 'Soll-Vorlauf bleibt mindestens ' + de(c.minVlC, 0) + ' °C', tn: 'Soll-Vorlauf würde ' + de(sollNeu, 0) + ' °C (Untergrenze ' + de(c.minVlC, 0) + ' °C)', ok: have(sollNeu) && sollNeu >= c.minVlC - 1e-9, ist: r2(sollNeu), soll: c.minVlC, op: '>=', u: '°C', dyn: true}); }
                var lead = up ? cold : warm, f = vsFenster(v, c), tg = 0; for (var hh = c.vonH; hh <= c.bisH; hh++) { tg += d.vsBase.at[hh]; } tg = tg / (c.bisH - c.vonH + 1);
                var e = {cond: cond, halt: c.haltMin, wert: sgn, von: d.shift, dir: up ? 'soll_hoch' : 'soll_runter', lead: lead ? lead.name : '',
                         was: 'Heizkurve 0 → ' + sg(sgn, 0) + ' K (Soll-Vorlauf ' + de(d.soll, 0) + ' → ' + de(sollNeu, 0) + ' °C)',
                         warum: 'Vorhersage +' + c.vonH + '…+' + c.bisH + ' h Ø ' + de(f.at, 1) + ' °C statt ' + de(v.at[0], 1) + ' °C jetzt, gewöhnlicher Tagesgang ' + sg(tg - d.vsBase.at[0], 1) + ' K: Bedarf ' + sg(dk, 1) + ' K aus dem Wetter' + (v.aktiv ? ' (mit Sonne/Wind)' : '') + '; ' + (lead ? lead.name + ' ' + (up ? de(lead.t - lead.min, 1) + ' K über Minimum' : de(lead.max - lead.t, 1) + ' K unter Maximum') : '')};
                if (gv) { e.vorab = gv; }
                return e;
            }
        }
    ];
    var RULE = {}; RULES.forEach(function (r) { RULE[r.id] = r; });

    // Bewertungsregeln (Version SCORE_VER, vorab festgelegt): Gewichte, Horizonte, Reife
    var SCORE = {
        brierFaktor: 100,          // Punkte je Horizont = 100 x [(b - o)^2 - (p - o)^2] / Anzahl Horizonte (b = Basisrate "bleibt, wie es ist", p = Prognose der Regel, o = Ergebnis 0/1)
        baseMinN: 5,               // Basisrate erst ab 5 Vergleichsfaellen je Horizont, vorher b = 0,5
        teilMin: 0.5,              // Horizont nur auswerten, wenn mindestens die Haelfte beobachtet ist (sonst neutral)
        trefferAnteil: 0.8,        // Problem "besteht", wenn es in >= 80 % der gueltigen Minuten vorliegt; <= 20 % = geloest; dazwischen unsicher (0)
        wirkung: 10,               // je Wirkungsgroesse: getroffen +10, daneben -10, nicht messbar 0
        schaden: {sperre_verletzt: -50, heizstab: -50, stopp10: -30, ueberschwingen: -30, zu_warm: -20, zu_kalt: -20},
        verpasst: -20,
        // ab v2: eigene Sperren/Wartezeiten der Regel entschuldigen "verpasst" (0 Punkte, als "waehrend Sperre" gezaehlt), aber nur mit den
        // dokumentierten Standardwerten (eine verlaengerte Sperre zaehlt nur bis zum Standard) und nur ohne harten Schaden im Fenster.
        verpasstSperre: {eigene: ['abstand', 'tageslimit', 'abkuehlzeit', 'haltezeit', 'stabil'], gegenregel: ['vorrang', 'gegenrichtung'], komfortK: 1.0,
                         schaden: {quiet_freigabe: ['komfort'], quiet_strecken: ['takt', 'ueberschwingen'], raum_offset: ['komfort']}},
        raumAlterMax: 360,         // Bewertung (nicht Entscheidung): ein Raumwert bis 6 h alt zaehlt, weil die Shelly H&T Gen3 nur bei Aenderung >= 0,5 K melden
        lueftungK: 1.0,            // Raum faellt >= 1 K in <= 60 min: Lueftung (Eingriff), danach keine Gegenfaktik fuer Raum-Prognosen (nach dem Replay ergaenzt: 09.10. Wohnzimmer -3,3 K)
        reife: {faelle: 10, tage: 14, skill: 0.2, wirkFaelle: 2, verpasst: 1}
    };

    // ------------------------------------------------------------------ Standardwerte (aus dem Regelwerk)
    var LOCK_CFG = {hpMaxAgeMin: 5, afterDefrostMin: 10, afterDhwMin: 10, startLockMin: 15, gapMin: 60, taktK: 1.0, stopK: 3.25, heaterMarginK: 2, warmupMin: 10, pumpOnRpm: 1000, kurveTolK: 1.5,
                    shiftHaltMin: 60, gegenMin: 240, notK: 0.3};     // Verschiebungs-Arbitrierung (alle Regeln der Groesse "shift"): gemeinsame Mindesthaltezeit, Wartezeit Gegenrichtung, Komfort-Notfall
    function defaults() {
        var c = {locks: JSON.parse(JSON.stringify(LOCK_CFG)), rules: {}};
        RULES.forEach(function (r) { var o = {}; r.schwellen.forEach(function (s) { o[s.key] = s.std; }); c.rules[r.id] = o; });
        return c;
    }
    function mergeCfg(over) {
        var c = defaults();
        if (over && typeof over === 'object') {
            if (over.locks) { Object.keys(c.locks).forEach(function (k) { if (have(num(over.locks[k]))) { c.locks[k] = num(over.locks[k]); } }); }
            if (over.rules) { Object.keys(c.rules).forEach(function (id) { var o = over.rules[id]; if (o) { Object.keys(c.rules[id]).forEach(function (k) { if (have(num(o[k]))) { c.rules[id][k] = num(o[k]); } }); } }); }
            if (num(over.sv) === 1 || num(over.sv) === 2) { c.sv = num(over.sv); }     // Bewertungsregeln v1/v2 nachrechnen (nur Replay/Tests)
        }
        return c;
    }

    // ------------------------------------------------------------------ Zustand (ueberlebt Neustarts per Datei)
    function newState(now) {
        var S = {mv: VER, born: now, last: now, run: {on: null, start: 0, reached: false, reachN: 0, sollTop: null}, lastStop: 0, lastStart: 0, runs: [], starts: [],
                 defrostEnd: 0, dhwEnd: 0, defrostWas: false, dhwWas: false, q: null, qChg: 0, shift: null, shiftChg: 0, soll: null, handWas: false, vlHist: [], needSince: 0, korr0Since: 0, vsEndSince: 0, atH: [],
                 arb: {owner: null, soll: null, von: null, start: 0, applied: null, last: null}, rules: {}, sc: newScore()};
        RULES.forEach(function (r) { S.rules[r.id] = {since: 0, failSince: 0, prop: null, cool: 0, n: 0, day: '', korrV: null, korrSince: 0, last: null}; });
        return S;
    }
    function newScore() { return {cases: [], cands: [], eff: [], gt: {}, base: {}, tot: {}, hist: [], week: {}, lastSlot: {}}; }
    function fixState(S, now) {                                                   // fehlende Felder (aeltere Datei) ergaenzen; fremdes Format -> neu
        var F = newState(now);
        if (!S || typeof S !== 'object' || S.mv !== VER || !S.rules || !S.sc) { return F; }
        Object.keys(F).forEach(function (k) { if (S[k] === undefined) { S[k] = F[k]; } });
        RULES.forEach(function (r) { if (!S.rules[r.id]) { S.rules[r.id] = F.rules[r.id]; } Object.keys(F.rules[r.id]).forEach(function (k) { if (S.rules[r.id][k] === undefined) { S.rules[r.id][k] = F.rules[r.id][k]; } }); });
        Object.keys(F.sc).forEach(function (k) { if (S.sc[k] === undefined) { S.sc[k] = F.sc[k]; } });
        return S;
    }

    // ------------------------------------------------------------------ Ableitung aus der Eingabe (Schnappschuss) und dem Zustand
    function derive(S, inp, cfg) {
        var L = cfg.locks, now = inp.t;
        var d = {now: now, hz: num(inp.hz), vl: num(inp.vl), rl: num(inp.rl), soll: num(inp.soll), dT: num(inp.dT), at: num(inp.at), q: num(inp.q), shift: num(inp.shift),
                 pump: num(inp.pump), pel: num(inp.pel), heatOffAT: num(inp.heatOffAT), korr: inp.korr || null, notK: L.notK, arb: S.arb,
                 vs: (inp.vs && typeof inp.vs === 'object' && Array.isArray(inp.vs.at)) ? inp.vs : null};
        d.fresh = have(num(inp.hpAge)) && num(inp.hpAge) <= L.hpMaxAgeMin && have(d.hz) && have(d.vl) && have(d.soll);
        d.running = have(d.hz) && d.hz > 0;
        d.zustand = d.running ? 'lauf' : (!have(d.pump) ? '?' : (d.pump >= L.pumpOnRpm ? 'pause' : 'heizgrenze'));
        d.hc = num(inp.hc); d.pth = num(inp.pth);
        d.vlRueck = (have(d.soll) && have(d.vl)) ? d.soll - d.vl : null;                                       // > 0: Vorlauf unter Soll
        d.rlRueck = (have(d.soll) && have(d.dT) && have(d.rl)) ? (d.soll - d.dT) - d.rl : null;                // > 0: Ruecklauf unter Soll-Ruecklauf
        d.rooms = (inp.rooms || []).map(function (r) { return {id: r.id, name: r.name || r.id, t: num(r.t), age: num(r.age), min: num(r.min), max: num(r.max), valid: !!r.valid && have(num(r.t)), active: r.active !== false}; });
        d.roomsActive = d.rooms.filter(function (r) { return r.active; }).length;
        d.roomsValid = d.rooms.filter(function (r) { return r.active && r.valid; }).length;
        d.roomBelow = d.rooms.filter(function (r) { return r.active && r.valid && have(r.min) && r.t < r.min; }).sort(function (a, b) { return (a.t - a.min) - (b.t - b.min); });
        d.roomAbove = d.rooms.filter(function (r) { return r.active && r.valid && have(r.max) && r.t > r.max; }).sort(function (a, b) { return (b.t - b.max) - (a.t - a.max); });
        return d;
    }
    function track(S, d, inp, cfg) {                                               // Laeufe, Starts, Abtauen, Aenderungen von Quiet/Verschiebung/Soll
        var now = d.now, R = S.run, rt = num(inp.rt);
        if (d.fresh && have(d.hz)) {
            if (d.running && R.on !== true) {
                R.on = true; R.start = (have(rt) && rt > 0 && rt < 24 * 60) ? now - rt * MIN : now; R.reached = false; R.reachN = 0; R.sollTop = d.soll;
                if (S.lastStop) { S.starts.push(R.start); }
                S.lastStart = R.start;
            } else if (!d.running && R.on === true) {
                R.on = false; S.lastStop = now; S.runs.push([R.start, mins(now - R.start)]);
            } else if (R.on === null) { R.on = false; }
            // Laufzeit der Anlage hat Vorrang, wenn sie kleiner ist (Stopp und Neustart zwischen zwei Aufrufen; nach einem Node-RED-Neustart beginnt sie bei 0 = vorsichtig)
            if (d.running && have(rt) && rt >= 0 && R.start && now - R.start > (rt + 2) * MIN) { R.start = now - rt * MIN; }
        }
        S.starts = S.starts.filter(function (t) { return now - t <= 24 * 60 * MIN; });
        S.runs = S.runs.filter(function (r) { return now - r[0] <= 48 * 60 * MIN; }).slice(-20);
        d.runMin = (d.running && R.on && R.start) ? (now - R.start) / MIN : 0;
        d.lastRunMin = S.runs.length ? S.runs[S.runs.length - 1][1] : null;
        d.starts3h = S.starts.filter(function (t) { return now - t <= 3 * 60 * MIN; }).length;
        // Sollvorlauf erreicht: 3 min am Stueck >= Soll -1 K, ab Minute 15, nicht bei Abtauen/Warmwasser; ein Sollsprung nach oben (>= 1 K) setzt zurueck
        if (d.running && have(d.soll)) {
            if (have(R.sollTop) && d.soll >= R.sollTop + 1) { R.reached = false; R.reachN = 0; }
            R.sollTop = have(R.sollTop) ? Math.max(R.sollTop, d.soll) : d.soll;
            if (have(d.vlRueck) && d.vlRueck <= 1 && num(inp.defrost) !== 1 && num(inp.dhw) !== 1) { R.reachN++; } else { R.reachN = 0; }
            if (R.reachN >= 3 && d.runMin >= cfg.locks.startLockMin) { R.reached = true; }
        }
        d.reached = !!R.reached;
        var df = num(inp.defrost) === 1, dw = num(inp.dhw) === 1;
        if (!df && S.defrostWas) { S.defrostEnd = now; } S.defrostWas = df;
        if (!dw && S.dhwWas) { S.dhwEnd = now; } S.dhwWas = dw;
        d.defrost = df; d.dhw = dw;
        // Aenderungen der Stellgroessen (von wem auch immer)
        d.qChanged = false; d.shiftChanged = false; d.sollJump = 0;
        if (have(d.q)) { if (have(S.q) && S.q !== d.q) { S.qChg = now; d.qChanged = true; d.qFrom = S.q; } S.q = d.q; }
        if (have(d.shift)) { if (have(S.shift) && S.shift !== d.shift) { S.shiftChg = now; d.shiftChanged = true; d.shiftFrom = S.shift; } S.shift = d.shift; }
        // Arbitrierung: uebernimmt die Anlage den laufenden Vorschlag einer Verschiebungs-Regel, gehoert die Verschiebung dieser Regel ("applied"), bis sie
        // sich wieder aendert; jede andere Aenderung (Hand, HeishaMoNR, Rueckweg) loest die Zuordnung
        if (d.shiftChanged) {
            var A = S.arb;
            if (A.applied && A.applied.w !== d.shift) { A.last = {rule: A.applied.rule, dir: sgnOf(A.applied.w - A.applied.von), w: A.applied.w, von: A.applied.von, start: A.applied.ts, end: now}; A.applied = null; }
            if (A.owner && d.shift === A.soll && d.shift !== 0) { A.applied = {rule: A.owner, w: d.shift, von: d.shiftFrom, ts: now}; d.shiftBy = A.owner; }
        }
        if (have(d.soll)) { if (have(S.soll) && S.soll !== d.soll) { d.sollJump = d.soll - S.soll; } S.soll = d.soll; }
        // Handeingriff am Soll (Soll weicht von der Heizkurve ab, z. B. Boost): sein Ende zaehlt fuer den Mindestabstand wie eine Aenderung der Verschiebung
        var sk = num(inp.sollKurve);
        d.hand = have(sk) && have(d.soll) && Math.abs(d.soll - (have(d.shift) ? d.shift : 0) - sk) > cfg.locks.kurveTolK;
        if (S.handWas && !d.hand && have(sk)) { S.shiftChg = now; }
        if (have(sk) && have(d.soll)) { S.handWas = d.hand; }
        // Vorlauf-Anstieg (K/h ueber ~10 min) und Zeit bis zur Abschaltgrenze Soll +3,25 K
        S.vlHist = (S.vlHist || []).filter(function (p) { return now - p[0] <= 12 * MIN; });
        if (d.running && have(d.vl)) { S.vlHist.push([now, d.vl]); } else if (!d.running) { S.vlHist = []; }
        d.vlSlope = null; d.stopEtaMin = null;
        var old = null; S.vlHist.forEach(function (p) { if (now - p[0] >= 9 * MIN && (old === null || p[0] > old[0])) { old = p; } });
        if (old && have(d.vl)) {
            d.vlSlope = (d.vl - old[1]) / ((now - old[0]) / 3600000);
            if (d.vlSlope > 0.3 && have(d.soll)) { d.stopEtaMin = Math.max(0, (d.soll + cfg.locks.stopK - d.vl) / d.vlSlope * 60); }
        }
        var htrOn = num(inp.htrOnAT), htrSd = num(inp.htrStartDelta);
        d.heaterOn = (num(inp.heaterI) || 0) > 0 || (num(inp.heaterE) || 0) > 0;
        d.htrNear = have(d.at) && have(htrOn) && d.at < htrOn + cfg.locks.heaterMarginK;
        d.htrSd = have(htrSd) ? Math.abs(htrSd) : 3;
    }

    // ------------------------------------------------------------------ Sperren je Regel (Reihenfolge = Prioritaet des angezeigten Grundes)
    function locksFor(R, d, S, cfg, inp, dirNow, e) {
        var L = cfg.locks, c = cfg.rules[R.id], rs = S.rules[R.id], now = d.now, out = [];
        function add(id, extra, until) { out.push({id: id, text: LOCK_TEXT[id] + (extra ? ' (' + extra + ')' : ''), bis: until || null}); }
        R.sperren.forEach(function (id) {
            if (id === 'anlauf' && now - S.born < L.warmupMin * MIN) { add(id, 'noch ' + Math.ceil((S.born + L.warmupMin * MIN - now) / MIN) + ' min', S.born + L.warmupMin * MIN); }
            if (id === 'daten' && !d.fresh) { add(id, have(num(inp.hpAge)) ? 'letzte Meldung vor ' + de(num(inp.hpAge), 0) + ' min' : 'keine Meldung'); }
            if (id === 'mqtt_sperre' && num(inp.block) === 1) { add(id); }
            if (id === 'abtauen' && (d.defrost || (S.defrostEnd && now - S.defrostEnd < L.afterDefrostMin * MIN))) { add(id, d.defrost ? 'läuft' : 'noch ' + Math.ceil((S.defrostEnd + L.afterDefrostMin * MIN - now) / MIN) + ' min', d.defrost ? null : S.defrostEnd + L.afterDefrostMin * MIN); }
            if (id === 'warmwasser' && (d.dhw || (S.dhwEnd && now - S.dhwEnd < L.afterDhwMin * MIN))) { add(id, d.dhw ? 'läuft' : 'noch ' + Math.ceil((S.dhwEnd + L.afterDhwMin * MIN - now) / MIN) + ' min', d.dhw ? null : S.dhwEnd + L.afterDhwMin * MIN); }
            if (id === 'sanftanlauf' && num(inp.ss) === 1) { add(id); }
            if (id === 'laufbeginn' && d.running && d.runMin < L.startLockMin) { add(id, de(d.runMin, 0) + ' von ' + L.startLockMin + ' min', S.run.start + L.startLockMin * MIN); }
            if (id === 'heizgrenze_aus' && !d.running && d.zustand === 'heizgrenze') { add(id); }
            if (id === 'modell' && !(d.vs && d.vs.gate)) { add(id, d.vs ? (d.vs.n || 0) + ' von ' + (d.vs.minDays || 10) + ' Tagen' : 'keine Vorhersage'); }
            if (id === 'vorrang' || id === 'gegenrichtung') { if (id === 'vorrang' || R.sperren.indexOf('vorrang') < 0) { arbLocks(R, e, d, S, cfg, add); } }
            if (id === 'regler') {
                if (R.groesse === 'quiet' && inp.otherQ) { add(id, inp.otherQ); }
                if (R.groesse === 'shift') {
                    var sk = num(inp.sollKurve);
                    if (inp.otherShift) { add(id, inp.otherShift); }
                    else if (num(inp.heatMode) !== 0) { add(id, 'kein Heizkurvenmodus'); }
                    else if (num(inp.z1Sensor) !== 0) { add(id, 'Zone 1 nicht über Wassertemperatur'); }
                    else if (d.hand) { add(id, 'Soll-Vorlauf ' + de(d.soll, 0) + ' °C weicht von der Heizkurve (' + de(sk, 1) + ' °C) ab: Handeingriff'); }
                }
            }
            if (id === 'abstand') {
                var chg = R.groesse === 'quiet' ? S.qChg : (R.groesse === 'shift' ? S.shiftChg : 0);
                if (chg && now - chg < L.gapMin * MIN) { add(id, 'letzte Änderung ' + hhmm(chg) + ', noch ' + Math.ceil((chg + L.gapMin * MIN - now) / MIN) + ' min', chg + L.gapMin * MIN); }
            }
            if (id === 'tageslimit' && rs.n >= c.proTag && !rs.prop) { add(id, rs.n + ' von ' + c.proTag); }
            if (id === 'abkuehlzeit' && rs.cool > now && !rs.prop) { add(id, 'bis ' + hhmm(rs.cool), rs.cool); }
            if (id === 'takt' && d.running && have(d.vl) && have(d.soll)) {
                var dir = dirNow || R.richtung, delta = dir === 'soll_runter' ? 1 : 0;      // -1 K hebt den Abstand des Vorlaufs zum (neuen) Soll um 1 K
                if ((dir === 'mehr_leistung' || dir === 'soll_runter') && d.vl - d.soll + delta > L.taktK) { add(id, 'Vorlauf ' + sg(d.vl - d.soll, 2) + ' K zum Soll' + (delta ? ', nach −1 K ' + sg(d.vl - d.soll + delta, 2) + ' K' : '')); }
            }
            if (id === 'heizstab') {
                var dir2 = dirNow || R.richtung;
                if (d.heaterOn) { add(id, 'Heizstab ist an'); }
                else if (dir2 === 'soll_hoch' && d.htrNear && have(d.vlRueck) && d.vlRueck + 1 > d.htrSd - 1) { add(id, 'Außen ' + de(d.at, 0) + ' °C, Vorlauf nach +1 K ' + de(d.vlRueck + 1, 1) + ' K unter Soll'); }
            }
        });
        return out;
    }

    // ------------------------------------------------------------------ eine Regel auswerten: Status, Grund, naechste Schwelle, Vorschlag
    function dgOf(u) { return (u === 'min' || u === 'Hz' || u === 'W') ? 0 : (u === 'K' ? 2 : 1); }
    function fmtIst(x) { if (x.it) { return x.it; } var v = num(x.ist); if (have(v)) { return de(v, dgOf(x.u)) + (x.u ? ' ' + x.u : ''); } return x.ist === undefined || x.ist === null ? '–' : String(x.ist); }
    function nextOf(x, bad, halt) {
        var v = num(x.ist), n = {b: x.k, kz: x.kz || x.k, op: x.op || '', ist: have(v) ? r2(v) : null, s: have(x.soll) ? x.soll : null, u: x.u || ''};
        if (have(v) && have(x.soll)) {
            n.abstand = r2(x.op === '<=' ? v - x.soll : x.soll - v);
            n.text = 'würde schalten, sobald ' + x.t + ' (jetzt ' + fmtIst(x) + ', fehlen ' + de(Math.abs(n.abstand), dgOf(x.u)) + (x.u ? ' ' + x.u : '') + ')';
        } else { n.text = 'würde schalten, sobald ' + x.t; }
        var more = bad.filter(function (y) { return y !== x; });
        if (more.length) { n.text += ' und ' + more.map(function (y) { return y.t; }).join(' und '); n.weitere = more.map(function (y) { return y.k; }); }
        if (halt) { n.text += ', danach ' + halt + ' min Haltezeit'; n.halt = halt; }
        return n;
    }
    function evalRule(R, d, S, cfg, inp) {
        var c = cfg.rules[R.id], rs = S.rules[R.id], now = d.now, day = ymd(now);
        if (rs.day !== day) { rs.day = day; rs.n = 0; }
        if (R.id === 'raum_offset') { var kv = d.korr && have(num(d.korr.v)) ? num(d.korr.v) : null; if (kv !== rs.korrV) { rs.korrV = kv; rs.korrSince = kv === null ? 0 : now; } }
        var res = {id: R.id, v: R.ver, st: '', grund: '', naechste: null, p: null, locks: []};
        function endProp(why) {
            if (!rs.prop) { return; }
            if (R.groesse === 'shift' && S.arb.owner === R.id) {                         // Arbitrierung: Verschiebung freigeben, Richtung und Ende merken (Gegenrichtung)
                S.arb.last = {rule: R.id, dir: sgnOf(S.arb.soll - S.arb.von), w: S.arb.soll, von: S.arb.von, start: S.arb.start, end: now};
                S.arb.owner = null; S.arb.soll = null; S.arb.von = null; S.arb.start = 0;
            }
            rs.prop = null; rs.cool = now + c.pauseMin * MIN; res.ende = why;
        }
        if (!d.fresh && R.sperren.indexOf('daten') >= 0) {                                 // ohne frische Anlagendaten wird keine Bedingung bewertet
            var ld = locksFor(R, d, S, cfg, inp, null).filter(function (l) { return l.id === 'daten'; });
            rs.since = 0; rs.failSince = 0; endProp('gesperrt: ' + ld[0].text);
            res.st = 'gesperrt'; res.grund = 'gesperrt: ' + ld[0].text; res.locks = ['daten']; res.naechste = {b: 'daten', text: 'prüft wieder, sobald HeishaMon frische Daten liefert'};
            return res;
        }
        var e = R.eval(d, c, rs);
        if (e.inaktiv) { rs.since = 0; rs.failSince = 0; endProp(e.inaktiv); res.st = 'inaktiv'; res.grund = e.inaktiv; return res; }
        var bad = e.cond.filter(function (x) { return !x.ok; });
        res.bed = e.cond.map(function (x) { return [x.kz || x.k, x.ok ? 1 : 0, x.t]; });        // Bedingungen fuer die Anzeige (nicht im Datensatz)
        res.hart = !!e.hart;
        if (e.vorab) {                                                                      // Vorbedingung fehlt (Modell-Gate): nie ein Vorschlag, die Bedingungen laufen nur zur Anzeige mit
            rs.since = 0; rs.failSince = 0; endProp('gesperrt: ' + e.vorab.text);
            res.st = 'gesperrt'; res.locks = [e.vorab.id]; res.dauer = bad.length > 0;     // Dauerzustand (nur Anzeige), solange auch eine Bedingung fehlt
            res.grund = (bad.length ? 'gesperrt: ' + e.vorab.text + '; außerdem ' + (bad[0].tn || bad[0].t) : 'würde schalten, aber gesperrt: ' + e.vorab.text);
            res.naechste = {b: e.vorab.id, ist: e.vorab.ist, s: e.vorab.s, u: e.vorab.u, text: 'prüft erst, wenn ' + LOCK_TEXT[e.vorab.id].replace('noch nicht ', '') + ' ist'};
            return res;
        }
        if (rs.prop && bad.some(function (x) { return x.hart; })) {                         // harte Bedingung (z. B. Raum ausserhalb des Bandes): sofort zurueckziehen
            var hb = bad.filter(function (x) { return x.hart; })[0];
            endProp('Bedingung entfallen: ' + (hb.tn || hb.t)); rs.since = 0; rs.failSince = 0;
        }
        if (bad.length) {
            if (rs.prop) {                                                                  // laufender Vorschlag: erst nach 3 min am Stueck zurueckziehen (kein Flattern)
                rs.failSince = rs.failSince || now;
                if (now - rs.failSince >= 3 * MIN) { endProp('Bedingung entfallen: ' + (bad[0].tn || bad[0].t)); rs.since = 0; }
            } else { rs.since = 0; rs.failSince = 0; }
            if (!rs.prop) {
                res.st = 'bereit'; res.grund = 'kein Vorschlag: ' + (bad[0].tn || (bad[0].t + ' nicht erfüllt'));
                var dyn = bad.filter(function (x) { return x.dyn && have(num(x.ist)) && have(x.soll); });
                res.naechste = nextOf(dyn.length ? dyn[0] : bad[0], bad, e.halt);
                return res;
            }
        } else { rs.failSince = 0; }
        if (!rs.prop) {                                                                     // alle Bedingungen erfuellt: Haltezeit
            rs.since = rs.since || now;
            var held = (now - rs.since) / MIN;
            if (e.halt && held < e.halt) {
                res.st = 'wartet'; res.grund = 'alle Bedingungen erfüllt, Haltezeit ' + Math.floor(held) + ' von ' + e.halt + ' min';
                res.naechste = {b: 'haltezeit', kz: 'Haltezeit', op: '>=', ist: Math.floor(held), s: e.halt, abstand: e.halt - Math.floor(held), u: 'min', text: 'würde in ' + Math.ceil(e.halt - held) + ' min schalten, wenn alles so bleibt'};
                return res;
            }
        }
        var lk = locksFor(R, d, S, cfg, inp, e.dir, e);
        res.locks = lk.map(function (l) { return l.id; });
        if (lk.length) {
            if (rs.prop) { endProp('gesperrt: ' + lk[0].text); }
            res.st = 'gesperrt'; res.grund = 'würde schalten, aber gesperrt: ' + lk[0].text;
            res.naechste = {b: lk[0].id, text: 'würde schalten, sobald diese Sperre endet' + (lk[0].bis ? ' (' + hhmm(lk[0].bis) + ')' : '') + (lk.length > 1 ? '; außerdem: ' + lk.slice(1).map(function (l) { return l.text; }).join('; ') : ''), bis: lk[0].bis};
            return res;
        }
        if (rs.prop && now >= rs.prop.bis) { endProp('abgelaufen'); res.st = 'abgelaufen'; res.grund = 'Vorschlag abgelaufen, neue Prüfung nach der Wartezeit'; return res; }
        if (!rs.prop) {
            rs.n++;
            var p = {id: R.id + '@' + isoMin(now).replace(' ', 'T'), rule: R.id, ver: R.ver, art: R.art, name: R.name, ts: now, bis: now + c.gueltigMin * MIN,
                     cmd: {name: R.befehl.name, topic: R.befehl.topic, value: e.wert}, von: e.von, dir: e.dir || R.richtung, lead: e.lead || '',
                     was: e.was, warum: e.warum, erwartung: R.erwartung, rueckweg: R.rueckweg, wann: 'ausgelöst ' + hhmm(now) + (e.halt ? ' nach ' + e.halt + ' min über allen Schwellen' : '')};
            p.sum = checksum(p);
            rs.prop = p; res.neu = true;
            if (R.groesse === 'shift') { S.arb.owner = R.id; S.arb.soll = e.wert; S.arb.von = e.von; S.arb.start = now; }      // Arbitrierung: diese Regel hat jetzt die Verschiebung
        }
        res.st = R.art === 'hinweis' ? 'hinweis' : 'vorschlag'; res.p = rs.prop.id; res.grund = rs.prop.warum;
        return res;
    }

    // ------------------------------------------------------------------ Schnappschuss fuer den Datensatz (gerundet; reicht zum Nachspielen)
    var SNAP_KEYS = ['hpAge', 'hz', 'vl', 'rl', 'soll', 'dT', 'pel', 'pth', 'flow', 'pump', 'q', 'qPrio', 'hc', 'at', 'defrost', 'dhw', 'ss', 'rt', 'shift', 'heatMode', 'z1Sensor',
                     'heaterI', 'heaterE', 'htrOnAT', 'htrStartDelta', 'heatOffAT', 'sollKurve', 'block', 'otherQ', 'otherShift', 'kzRad'];
    function snapshot(inp) {
        var o = {};
        SNAP_KEYS.forEach(function (k) { var v = inp[k]; if (v === undefined || v === null || v === '') { return; } o[k] = typeof v === 'number' ? r2(v) : v; });
        if (inp.rooms) { o.rooms = inp.rooms.map(function (r) { return [r.id, r2(num(r.t)), r2(num(r.age)), r.valid ? 1 : 0, r2(num(r.min)), r2(num(r.max)), r.active === false ? 0 : 1, r.name || r.id]; }); }
        if (inp.korr) { o.korr = {v: num(inp.korr.v), code: inp.korr.code || '', distrib: inp.korr.distrib ? 1 : 0, lead: inp.korr.lead || ''}; }
        if (inp.vs && Array.isArray(inp.vs.at)) { o.vs = {}; Object.keys(inp.vs).forEach(function (k) { var v = inp.vs[k]; if (v !== null && v !== undefined && v !== '') { o.vs[k] = typeof v === 'number' ? r2(v) : v; } }); }
        return o;
    }
    function unsnap(t, o) {                                                       // Gegenstueck: aus einem Datensatz wieder eine Eingabe machen (Nachspielen)
        var inp = {t: t};
        SNAP_KEYS.forEach(function (k) { if (o[k] !== undefined) { inp[k] = o[k]; } });
        inp.rooms = (o.rooms || []).map(function (a) { return {id: a[0], name: a[7] || a[0], t: a[1], age: a[2], valid: a[3] === 1, min: a[4], max: a[5], active: a[6] !== 0}; });
        if (o.korr) { inp.korr = o.korr; }
        if (o.vs) { inp.vs = o.vs; }
        return inp;
    }

    // ------------------------------------------------------------------ Hauptschritt
    var KORR0_MIN = 15;          // Rueckweg der Raumregel: Raumvorschlag so lange am Stueck 0
    function step(S, inp, cfg) {
        cfg = cfg || defaults();
        var now = inp.t;
        S = fixState(S, now);
        var d = derive(S, inp, cfg);
        track(S, d, inp, cfg);
        tgUpdate(S, d); d.vsBase = tagesgang(S, now); d.vsDk = bedarfK(d.vs, cfg.rules.vorausschau, d.vsBase);
        if (!S.arb.owner) {                                                          // Arbitrierung nach dem Laden eines aelteren Zustands: laufenden Vorschlag als Eigentuemer eintragen
            RULES.forEach(function (R) { var p0 = S.rules[R.id].prop; if (R.groesse === 'shift' && p0 && !S.arb.owner) { S.arb.owner = R.id; S.arb.soll = p0.cmd.value; S.arb.von = p0.von; S.arb.start = p0.ts; } });
        }
        var res = [], ev = [], locks = {};
        var owner0 = S.arb.owner;
        RULES.forEach(function (R) { res.push(evalRule(R, d, S, cfg, inp)); });
        // Uebergabe ohne Luecke: gab die Eigentuemer-Regel die Verschiebung erst nach einer anderen Verschiebungs-Regel frei (Reihenfolge der Auswertung),
        // wird diese in derselben Minute noch einmal geprueft (ein Ende-Ereignis der ersten Pruefung bleibt erhalten)
        if (owner0 && !S.arb.owner) {
            RULES.forEach(function (R, i) { if (R.groesse === 'shift' && R.id !== owner0 && res[i].locks.indexOf('vorrang') >= 0) { var e0 = res[i].ende; res[i] = evalRule(R, d, S, cfg, inp); if (e0 && !res[i].ende) { res[i].ende = e0; } } });
        }
        RULES.forEach(function (R, i) {
            var r = res[i];
            locks[R.id] = r.locks;
            if (r.neu) { ev.push([R.art === 'hinweis' ? 'optimierer_hinweis' : 'optimierer_vorschlag', R.id + ' v' + R.ver + ': ' + S.rules[R.id].prop.was + ' · ' + S.rules[R.id].prop.warum]); }
            if (r.ende) { ev.push(['optimierer_ende', R.id + ': ' + r.ende]); }
            S.rules[R.id].last = r.st;
        });
        // aktueller Vorschlag: Befehle vor Hinweisen, dann nach Prioritaet
        var act = RULES.filter(function (R) { return S.rules[R.id].prop; }).sort(function (a, b) { return (a.art === b.art ? 0 : (a.art === 'befehl' ? -1 : 1)) || a.prio - b.prio; });
        var prop = act.length ? S.rules[act[0].id].prop : null;
        var sc = scoreStep(S, d, inp, cfg, res);
        // Gruende fuer den Rueckweg einer laufenden Uebernahme (die Uebernahme-Funktion entscheidet selbst)
        var c2 = cfg.rules.quiet_strecken, ende = {};
        S.needSince = (have(d.rlRueck) && d.rlRueck >= c2.bedarfRlK && d.running) ? (S.needSince || now) : 0;
        if (d.roomBelow.length) { ende.quiet_strecken = d.roomBelow[0].name + ' unter Minimum'; }
        else if (S.needSince && now - S.needSince >= 15 * MIN) { ende.quiet_strecken = 'Rücklauf seit 15 min ≥ ' + de(c2.bedarfRlK, 1) + ' K unter Soll (Leistung wird gebraucht)'; }
        // Raumvorschlag 0 erst nach 15 min am Stueck: er flackert (Kinderzimmer-Werte gelten nach 90 min als ungueltig), eine Minute 0 darf eine
        // 60 min lang abgewartete Verschiebung nicht zuruecknehmen
        S.korr0Since = (d.korr && num(d.korr.v) === 0) ? (S.korr0Since || now) : 0;
        if (S.korr0Since && now - S.korr0Since >= KORR0_MIN * MIN) { ende.raum_offset = 'Raumvorschlag seit ' + KORR0_MIN + ' min wieder 0 K'; }
        // Vorausschau: Rueckweg sofort, wenn ein Raum das Band in Gegenrichtung verlaesst; sonst, wenn die Vorhersage 15 min am Stueck nicht mehr die halbe Schwelle zeigt
        var cv = cfg.rules.vorausschau, sh = have(d.shift) ? sgnOf(d.shift) : 0, dkv = d.vsDk;
        if (sh !== 0) {
            var gegen = sh > 0 ? d.roomAbove[0] : d.roomBelow[0];
            if (gegen) { ende.vorausschau = gegen.name + (sh > 0 ? ' über Maximum' : ' unter Minimum'); S.vsEndSince = 0; }
            else {
                S.vsEndSince = (dkv === null || sh * dkv < cv.deltaK / 2) ? (S.vsEndSince || now) : 0;
                if (S.vsEndSince && now - S.vsEndSince >= KORR0_MIN * MIN) { ende.vorausschau = 'Vorhersage zeigt die Bedarfsänderung seit ' + KORR0_MIN + ' min nicht mehr'; }
            }
        } else { S.vsEndSince = 0; }
        // Uebergabe statt Hin und Her: verlangt die andere Verschiebungs-Regel genau die stehende Verschiebung, gibt es keinen Rueckweg (Ablauf und Grund ruhen)
        var halten = {}, kvNow = d.korr && have(num(d.korr.v)) ? num(d.korr.v) : null, rV = res.filter(function (x) { return x.id === 'vorausschau'; })[0];
        if (sh !== 0 && kvNow === d.shift) { halten.vorausschau = 'Raumeinfluss verlangt dieselbe Verschiebung (' + sg(d.shift, 0) + ' K)'; }
        if (sh !== 0 && d.vs && d.vs.gate && dkv !== null && sh * dkv >= cv.deltaK && rV && rV.locks.indexOf('modell') < 0 && !(sh > 0 ? d.roomAbove.length : d.roomBelow.length)) { halten.raum_offset = 'Vorausschau verlangt dieselbe Verschiebung (' + sg(d.shift, 0) + ' K)'; }
        Object.keys(halten).forEach(function (k) { delete ende[k]; });
        S.last = now;
        var rec = {t: iso(now), mv: VER, sv: svOf(cfg), in: snapshot(inp),
                   abl: {z: d.zustand, lauf_min: r2(d.runMin), vl_rueck: r2(d.vlRueck), rl_rueck: r2(d.rlRueck), erreicht: d.reached ? 1 : 0, vl_k_h: r2(d.vlSlope), stopp_in_min: r2(d.stopEtaMin), starts_3h: d.starts3h, vs_dk: d.vsDk},
                   r: res.map(function (x) { var o = {id: x.id, v: x.v, st: x.st, grund: x.grund}; if (x.naechste) { o.naechste = recNext(x.naechste); } if (x.p) { o.p = x.p; } if (x.locks.length) { o.sperren = x.locks; } return o; }),
                   vorschlag: prop ? prop.id : null};
        return {S: S, d: d, res: res, prop: prop, rec: rec, ev: ev, scores: sc, ende: ende, halten: halten, locks: locks};
    }
    function recNext(nx) { var o = {}; ['b', 'ist', 's', 'abstand', 'u', 'weitere', 'halt', 'bis'].forEach(function (k) { if (nx[k] !== undefined && nx[k] !== null && nx[k] !== '') { o[k] = nx[k]; } }); return o; }

    // ------------------------------------------------------------------ Punktesystem (automatisch, ohne Nutzereingabe)
    // (1) Ausloeser-Prognose je Fall (Vorschlag): Brier-Prinzip gegen die Basisrate "bleibt, wie es ist" in gleichartigen Lagen.
    // (2) Wirkungsprognose nur, wenn eine gleichwertige Aenderung tatsaechlich passiert (z. B. Quiet von Hand); Kalibriermessungen zaehlen 0.
    // (3) Schaden und (4) Verpasst als feste Abzuege. Unsicher oder zu wenig Daten = 0.
    function roomScore(r) { return r.active && have(r.t) && have(r.min) && have(r.max) && (r.valid || (have(r.age) && r.age <= SCORE.raumAlterMax)); }
    function problemNow(rule, ctx, d, cfg) {                                       // liegt das vorhergesagte Problem in dieser Minute vor? 1 / 0 / null (unbekannt)
        var c = cfg.rules[rule];
        if (!d.fresh) { return null; }
        if (rule === 'quiet_freigabe') { if (!d.running) { return null; } return (have(d.hz) && d.hz <= c.capHz && have(d.rlRueck) && d.rlRueck >= 1.0) ? 1 : 0; }
        if (rule === 'raum_offset') {
            var r = d.rooms.filter(function (x) { return x.name === ctx.lead || x.id === ctx.lead; })[0];
            if (!r || !roomScore(r)) { return null; }
            return ctx.dir === 'soll_runter' ? (r.t > r.max ? 1 : 0) : (r.t < r.min ? 1 : 0);
        }
        if (rule === 'vorausschau') {                                               // Problem: der knappste Raum (bei t0) steht hoechstens reserveK am Bandrand
            var rv = d.rooms.filter(function (x) { return x.name === ctx.lead || x.id === ctx.lead; })[0];
            if (!rv || !roomScore(rv)) { return null; }
            return ctx.dir === 'soll_runter' ? (rv.t >= rv.max - c.reserveK ? 1 : 0) : (rv.t <= rv.min + c.reserveK ? 1 : 0);
        }
        if (rule === 'heizgrenze_hinweis') {
            var act = d.rooms.filter(function (x) { return x.active; });
            if (!act.length || act.some(function (x) { return !roomScore(x); })) { return null; }
            if (act.some(function (x) { return x.t < x.min; })) { return 0; }
            return act.every(function (x) { return x.t >= x.min + c.reserveK; }) ? 1 : null;
        }
        return null;
    }
    function roomRule(rule) { return rule === 'raum_offset' || rule === 'heizgrenze_hinweis' || rule === 'vorausschau'; }
    function bandsOf(d) { var o = {}; d.rooms.forEach(function (r) { o[r.id] = [r.min, r.max, r.active ? 1 : 0]; }); return o; }
    function newTracker(rule, now, ctx, d) { ctx.bands = bandsOf(d); return {rule: rule, t0: now, ctx: ctx, cut: 0, stop: 0, stopVlStop: false, wasRun: false, ser: []}; }
    function trackerUpdate(T, d, cfg) {
        var now = d.now, H = Math.max.apply(null, RULE[T.rule].prognose.h) * MIN;
        if (now - T.t0 > H || T.cut) { return; }
        if (now > T.t0 && (d.qChanged || d.shiftChanged || Math.abs(d.sollJump) >= 2)) { T.cut = now; T.cutWhy = d.qChanged ? 'Quiet geändert' : (d.shiftChanged ? 'Verschiebung geändert' + (d.shiftBy ? ' (Vorschlag „' + RULE[d.shiftBy].kurz + '“ übernommen)' : '') : 'Soll von Hand geändert'); return; }   // Eingriff von aussen: ab hier keine Gegenfaktik mehr
        if (roomRule(T.rule) && JSON.stringify(bandsOf(d)) !== JSON.stringify(T.ctx.bands)) { T.cut = now; T.cutWhy = 'Komfortband geändert'; return; }   // Komfortband geaendert = Eingriff
        if (roomRule(T.rule)) {                // Lueftungsverdacht: Raum faellt >= 1 K in <= 60 min (Heizung kann das nicht) = Eingriff von aussen
            T.rh = T.rh || {};
            var vent = null;
            d.rooms.forEach(function (r) {
                if (!r.active || !have(r.t)) { return; }
                var h = T.rh[r.id] = (T.rh[r.id] || []).filter(function (x) { return now - x[0] <= 60 * MIN; });
                if (h.length && h[h.length - 1][1] === r.t) { return; }
                h.push([now, r.t]);
                var mx = Math.max.apply(null, h.map(function (x) { return x[1]; }));
                if (mx - r.t >= SCORE.lueftungK) { vent = r.name + ' −' + de(mx - r.t, 1) + ' K in ≤ 60 min'; }
            });
            if (vent && now > T.t0) { T.cut = now; T.cutWhy = 'Lüftungsverdacht (' + vent + ')'; return; }
        }
        if (T.rule === 'quiet_strecken') { if (!T.stop && T.wasRun && !d.running && d.fresh) { T.stop = now; } if (d.running) { T.wasRun = true; } return; }
        var pr = problemNow(T.rule, T.ctx, d, cfg);
        if (pr !== null) { T.ser.push([now - T.t0, pr]); }
        if (T.rule === 'quiet_freigabe' && T.wasRun && !d.running && d.fresh && !T.stop) { T.stop = now; T.stopVlStop = have(d.vlRueck) && d.vlRueck <= -2; }
        if (d.running) { T.wasRun = true; }
    }
    function outcome(T, h) {                                                       // Ergebnis o (1 = Problem bestand, 0 = loeste sich von selbst, null = unsicher)
        var H = h * MIN, end = T.cut ? Math.min(T.cut, T.t0 + H) : T.t0 + H, span = (end - T.t0) / MIN;
        if (span < SCORE.teilMin * h) { return {o: null, why: T.cut ? 'Eingriff nach ' + Math.round(span) + ' min: ' + (T.cutWhy || '') : 'zu kurz beobachtet'}; }
        if (T.rule === 'quiet_strecken') {
            if (T.stop && T.stop - T.t0 <= H) { return {o: 1, why: 'Lauf endete nach ' + mins(T.stop - T.t0) + ' min'}; }
            if (T.cut && T.cut < T.t0 + H) { return {o: null, why: 'Eingriff'}; }
            return {o: 0, why: 'Lauf lief länger als ' + h + ' min'};
        }
        var ser = T.ser.filter(function (p) { return p[0] <= H; });
        if (T.rule === 'quiet_freigabe' && T.stop && T.stop - T.t0 <= H && T.stopVlStop) { return {o: 0, why: 'Verdichter holte auf und schaltete ab'}; }
        if (T.rule === 'raum_offset' || T.rule === 'vorausschau') {                  // Raum: letzter gueltiger Wert in den letzten 30 min vor dem Horizont
            if (T.cut && T.cut < T.t0 + H) { return {o: null, why: 'Eingriff nach ' + mins(T.cut - T.t0) + ' min: ' + (T.cutWhy || '')}; }
            var lastP = ser.filter(function (p) { return p[0] >= H - 30 * MIN; });
            if (!lastP.length) { return {o: null, why: 'Raumwert am Horizont ungültig'}; }
            if (T.rule === 'vorausschau') { return {o: lastP[lastP.length - 1][1], why: lastP[lastP.length - 1][1] ? 'Raum am Bandrand' : 'Raum mit Luft im Band'}; }
            return {o: lastP[lastP.length - 1][1], why: lastP[lastP.length - 1][1] ? 'Raum weiter außerhalb des Bandes' : 'Raum wieder im Band'};
        }
        if (ser.length < SCORE.teilMin * h * (T.rule === 'quiet_freigabe' ? 0.5 : 0.3)) { return {o: null, why: 'zu wenige gültige Minuten (' + ser.length + ')'}; }
        if (T.rule === 'heizgrenze_hinweis') { return ser.some(function (p) { return p[1] === 0; }) ? {o: 0, why: 'ein Raum fiel unter Minimum'} : {o: 1, why: 'alle Räume blieben über Minimum + Reserve'}; }
        var f = ser.reduce(function (a, p) { return a + p[1]; }, 0) / ser.length;
        if (f >= SCORE.trefferAnteil) { return {o: 1, why: 'Problem in ' + Math.round(f * 100) + ' % der Minuten'}; }
        if (f <= 1 - SCORE.trefferAnteil) { return {o: 0, why: 'Problem nur in ' + Math.round(f * 100) + ' % der Minuten'}; }
        return {o: null, why: 'unklar (' + Math.round(f * 100) + ' %)'};
    }
    function brier(p, b, o) { return SCORE.brierFaktor * (Math.pow(b - o, 2) - Math.pow(p - o, 2)); }   // > 0, wenn die Prognose p naeher am Ergebnis liegt als die Basisrate b
    function baseRate(sc, rule, h) { var b = (sc.base[rule] || {})[h]; if (!b || b[0] < SCORE.baseMinN) { return {b: 0.5, n: b ? b[0] : 0}; } return {b: (b[1] + 1) / (b[0] + 2), n: b[0]}; }
    function candidateNow(rule, d, cfg) {                                            // Vergleichslage fuer die Basisrate (schwaecher als der Ausloeser)
        var c = cfg.rules[rule];
        if (!d.fresh) { return null; }
        if (rule === 'quiet_freigabe') { return (have(d.q) && d.q >= 1 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz <= c.capHz && have(d.rlRueck) && d.rlRueck >= 1.0) ? {} : null; }
        if (rule === 'quiet_strecken') { return (have(d.q) && d.q < 3 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz >= c.hzHoch) ? {} : null; }
        if (rule === 'raum_offset') { if (d.roomBelow.length) { return {lead: d.roomBelow[0].id, dir: 'soll_hoch'}; } if (d.roomAbove.length) { return {lead: d.roomAbove[0].id, dir: 'soll_runter'}; } return null; }
        if (rule === 'vorausschau') {                                                // Vergleichslage: Vorhersage zeigt mindestens die halbe Schwelle, alle Raeume gueltig im Band (unabhaengig vom Gate)
            var dk = d.vsDk, act = d.rooms.filter(function (x) { return x.active; });
            if (dk === null || Math.abs(dk) < c.deltaK / 2 || !act.length || act.some(function (x) { return !x.valid || !have(x.min) || !have(x.max) || x.t < x.min || x.t > x.max; })) { return null; }
            var ld = null; act.forEach(function (x) { var m = dk > 0 ? x.t - x.min : x.max - x.t; if (ld === null || m < ld.m) { ld = {id: x.id, m: m}; } });
            return {lead: ld.id, dir: dk > 0 ? 'soll_hoch' : 'soll_runter'};
        }
        if (rule === 'heizgrenze_hinweis') { return (have(d.heatOffAT) && d.heatOffAT > c.zielC && d.running && d.runMin >= c.laufMin && have(d.at) && d.at > c.zielC) ? {} : null; }
        return null;
    }
    function svOf(cfg) { return cfg && (cfg.sv === 1 || cfg.sv === 2) ? cfg.sv : SCORE_VER; }
    // Summen je Regel, Regelversion und Bewertungsversion (v1 behaelt den alten Schluessel "regel|vN", damit alte Punkte unveraendert getrennt bleiben)
    function tot(sc, rule, ver, sv) { var k = rule + '|v' + ver + (sv > 1 ? '|s' + sv : ''); return sc.tot[k] = sc.tot[k] || {rule: rule, ver: ver, sv: sv, since: 0, punkte: 0, faelle: 0, bewertet: 0, treffer: 0, fehlalarm: 0, neutral: 0, bs: 0, bsRef: 0, schaden: 0, verpasst: 0, verpasstSperre: 0, wirkN: 0, wirkP: 0, kalib: 0}; }
    function book(sc, recs, rec, now) {
        recs.push(rec);
        var T = tot(sc, rec.regel, rec.v, rec.sv);
        T.punkte = Math.round((T.punkte + rec.punkte) * 100) / 100;
        rec.summe = T.punkte;
        var wk = isoWeek(now), W = sc.week[wk] = sc.week[wk] || {};
        var w = W[rec.regel] = W[rec.regel] || {punkte: 0, faelle: 0, treffer: 0, fehlalarm: 0, schaden: 0, verpasst: 0, wirkung: 0};
        if (rec.typ === 'verpasst_sperre') { w.verpasstSperre = (w.verpasstSperre || 0) + 1; }
        w.punkte = Math.round((w.punkte + rec.punkte) * 100) / 100;
        if (rec.typ === 'ausloeser') { w.faelle++; if (rec.ergebnis === 'treffer') { w.treffer++; } if (rec.ergebnis === 'fehlalarm') { w.fehlalarm++; } }
        if (rec.typ === 'schaden') { w.schaden++; }
        if (rec.typ === 'verpasst') { w.verpasst++; }
        if (rec.typ === 'wirkung') { w.wirkung++; }
        sc.hist.push([now, rec.regel, T.punkte, rec.sv]);
        if (sc.hist.length > 2000) { sc.hist = sc.hist.slice(-2000); }
        var ks = Object.keys(sc.week).sort(); while (ks.length > 12) { delete sc.week[ks.shift()]; }
    }
    var DMG_TEXT = {sperre_verletzt: 'Vorschlag trotz aktiver Sperre', heizstab: 'Heizstab lief', stopp10: 'Verdichter stoppte binnen 10 min', ueberschwingen: 'Vorlauf über der Abschaltgrenze (Soll +3,25 K)', zu_warm: 'Raum über Maximum + 0,5 K', zu_kalt: 'Raum unter Minimum − 0,3 K'};
    function scoreStep(S, d, inp, cfg, res) {
        var sc = S.sc, now = d.now, recs = [], sv = svOf(cfg);
        sc.sv = sv;
        RULES.forEach(function (R) { var T = tot(sc, R.id, R.ver, sv); if (!T.since) { T.since = now; } });
        // 1) neue Faelle aus neuen Vorschlaegen/Hinweisen
        res.forEach(function (r) {
            if (!r.neu) { return; }
            var R = RULE[r.id], p = S.rules[r.id].prop;
            var lead = p.lead || (d.roomBelow[0] ? d.roomBelow[0].name : '');
            sc.cases.push({id: p.id, rule: r.id, v: R.ver, sv: sv, t0: now, p: R.prognose.p, h: R.prognose.h.slice(), dir: p.dir, done: [], hr: [], pts: 0,
                           tr: newTracker(r.id, now, {lead: lead, dir: p.dir}, d), dmg: r.locks.length ? ['sperre_verletzt'] : []});
        });
        // 2) Faelle fortschreiben, Horizonte abschliessen
        sc.cases.forEach(function (C) {
            trackerUpdate(C.tr, d, cfg);
            damageUpdate(C, d, cfg);
            C.h.forEach(function (h) {
                if (C.done.indexOf(h) >= 0 || now - C.t0 < h * MIN) { return; }
                C.done.push(h);
                var oc = outcome(C.tr, h), br = baseRate(sc, C.rule, h), pts = 0;
                if (oc.o !== null) {
                    pts = brier(C.p, br.b, oc.o) / C.h.length;
                    var T0 = tot(sc, C.rule, C.v, C.sv || 1); T0.bs += Math.pow(C.p - oc.o, 2); T0.bsRef += Math.pow(br.b - oc.o, 2);
                }
                C.hr.push({h: h, o: oc.o, b: r2(br.b), nb: br.n, punkte: r2(pts), why: oc.why});
                C.pts += pts;
            });
            if (C.done.length === C.h.length && !C.closed) {
                C.closed = true;
                var T = tot(sc, C.rule, C.v, C.sv || 1), os = C.hr.filter(function (x) { return x.o !== null; });
                var erg = os.length ? (os.filter(function (x) { return x.o === 1; }).length * 2 >= os.length ? 'treffer' : 'fehlalarm') : 'neutral';
                T.faelle++; if (os.length) { T.bewertet++; } if (erg === 'treffer') { T.treffer++; } else if (erg === 'fehlalarm') { T.fehlalarm++; } else { T.neutral++; }
                book(sc, recs, {t: iso(now), typ: 'ausloeser', regel: C.rule, v: C.v, sv: C.sv || 1, fall: C.id, p: C.p, horizonte: C.hr, ergebnis: erg, punkte: r2(C.pts),
                                text: RULE[C.rule].prognose.text + ': ' + C.hr.map(function (x) { return x.h + ' min ' + (x.o === null ? 'neutral (' + x.why + ')' : (x.o ? 'ja' : 'nein') + ' (' + x.why + ', Basisrate ' + de(x.b, 2) + ')'); }).join(' · ')}, now);
                if (C.dmg.length) {
                    var sum = 0; C.dmg.forEach(function (k) { sum += SCORE.schaden[k]; });
                    T.schaden += C.dmg.length;
                    book(sc, recs, {t: iso(now), typ: 'schaden', regel: C.rule, v: C.v, sv: C.sv || 1, fall: C.id, arten: C.dmg.slice(), punkte: sum, text: 'Hätte nach den Daten geschadet: ' + C.dmg.map(function (k) { return DMG_TEXT[k]; }).join(', ')}, now);
                }
            }
        });
        sc.cases = sc.cases.filter(function (C) { return !C.closed; });
        // Vergleichslagen fuer die Basisrate: je Regel hoechstens eine je 15 min (Raum/Heizgrenze: je 60 min), damit sich Faelle kaum ueberlappen
        RULES.forEach(function (R) {
            var slot = roomRule(R.id) ? 60 : 15, sk = Math.floor(now / (slot * MIN));
            if (sc.lastSlot[R.id] === sk) { return; }
            var cn = candidateNow(R.id, d, cfg);
            if (cn) { sc.lastSlot[R.id] = sk; sc.cands.push({rule: R.id, t0: now, h: R.prognose.h.slice(), done: [], tr: newTracker(R.id, now, {lead: cn.lead, dir: cn.dir}, d)}); }
        });
        sc.cands.forEach(function (C) {
            trackerUpdate(C.tr, d, cfg);
            C.h.forEach(function (h) {
                if (C.done.indexOf(h) >= 0 || now - C.t0 < h * MIN) { return; }
                C.done.push(h);
                var oc = outcome(C.tr, h);
                if (oc.o !== null) { var B = sc.base[C.rule] = sc.base[C.rule] || {}; var b = B[h] = B[h] || [0, 0]; b[0]++; b[1] += oc.o; }
            });
        });
        sc.cands = sc.cands.filter(function (C) { return C.done.length < C.h.length; }).slice(-400);
        // 3) Wirkungsprognosen
        var nEff = sc.eff.length;
        effectStart(sc, d, S, cfg);
        sc.eff.slice(nEff).forEach(function (E) { E.sv = sv; });
        sc.eff.forEach(function (E) { effectUpdate(E, d, sc, recs); });
        sc.eff = sc.eff.filter(function (E) { return !E.closed; });
        // 4) Verpasst
        missedStep(S, sc, d, cfg, res, recs, sv);
        // 5) Messaufgabe (keine Punkte): Verdichterfrequenz/Leistung bei Quiet 0 und Rueckstand >= 2 K, Comfort gegen Efficiency
        messStep(sc, d, S, recs, sv);
        return recs;
    }
    function damageUpdate(C, d, cfg) {
        var now = d.now, H = Math.max.apply(null, C.h) * MIN, R = RULE[C.rule];
        if (now - C.t0 > H || C.tr.cut || !d.fresh) { return; }
        function hit(k) { if (C.dmg.indexOf(k) < 0) { C.dmg.push(k); } }
        if (d.heaterOn) { hit('heizstab'); }
        if (R.art === 'befehl' && (C.dir === 'mehr_leistung' || C.dir === 'soll_runter') && C.tr.wasRun && !d.running && now - C.t0 <= 10 * MIN) { hit('stopp10'); }
        if (now - C.t0 <= 30 * MIN && d.running && have(d.vl) && have(d.soll)) {
            var delta = C.dir === 'soll_runter' ? 1 : 0;
            if ((C.dir === 'mehr_leistung' || C.dir === 'soll_runter') && d.vl - d.soll + delta >= cfg.locks.stopK) { hit('ueberschwingen'); }
        }
        var heatUp = C.dir === 'mehr_leistung' || C.dir === 'soll_hoch', heatDown = C.dir === 'weniger_leistung' || C.dir === 'soll_runter' || C.dir === 'weniger_waerme';
        d.rooms.forEach(function (r) {
            if (!roomScore(r)) { return; }
            if (heatUp && r.t > r.max + 0.5) { hit('zu_warm'); }
            if (heatDown && r.t < r.min - 0.3) { hit('zu_kalt'); }
        });
    }
    function isKal(rule, now) {                                                    // Messungen, aus denen das Wirkungsmodell stammt (+-3 min): ausgewertet, aber 0 Punkte
        return RULE[rule].kalibriert.some(function (k) { var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(k); if (!m) { return false; } var t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime(); return Math.abs(now - t) <= 3 * MIN; });
    }
    function effectStart(sc, d, S, cfg) {
        var now = d.now;
        if (d.qChanged && have(d.qFrom) && d.fresh) {
            if (d.qFrom >= 1 && d.q === 0 && d.running) {
                if (have(d.rlRueck) && d.rlRueck >= cfg.rules.quiet_freigabe.rlRueckK) {
                    sc.eff.push({rule: 'quiet_freigabe', t0: now, art: 'freigabe', pel0: S._pelPrev, vl0: S._vlPrev, kal: isKal('quiet_freigabe', now), m: {}, text: 'Quiet ' + d.qFrom + ' → 0 bei Rücklauf ' + de(d.rlRueck, 1) + ' K unter Soll'});
                } else if (have(d.rlRueck) && d.rlRueck < 0.5) {
                    sc.eff.push({rule: 'quiet_freigabe', t0: now, art: 'ohne_bedarf', kal: isKal('quiet_freigabe', now), m: {}, text: 'Quiet ' + d.qFrom + ' → 0 ohne Rücklauf-Rückstand (' + rueckTxt(d.rlRueck) + ')'});
                }
            }
            if (d.qFrom < 3 && d.q === 3 && d.running && have(S._hzPrev) && S._hzPrev >= cfg.rules.quiet_strecken.hzHoch) {
                sc.eff.push({rule: 'quiet_strecken', t0: now, art: 'deckel', pel0: S._pelPrev, kal: isKal('quiet_strecken', now), m: {}, text: 'Quiet ' + d.qFrom + ' → 3 bei ' + de(S._hzPrev, 0) + ' Hz'});
            }
        }
        if (d.shiftChanged && have(d.shiftFrom) && Math.abs(d.shift - d.shiftFrom) === 1 && d.fresh) {
            var er = d.shiftBy && (sc.sv || SCORE_VER) >= 3 ? d.shiftBy : 'raum_offset';                // v3: die Regel, deren Vorschlag uebernommen wurde (sonst wie bisher Raumeinfluss)
            sc.eff.push({rule: er, t0: now, art: 'verschiebung', soll0: S._sollPrev, dshift: d.shift - d.shiftFrom, kal: isKal(er, now), m: {}, text: 'Verschiebung ' + sg(d.shiftFrom, 0) + ' → ' + sg(d.shift, 0) + ' K'});
        }
        if (d.fresh) { S._pelPrev = have(d.pel) ? d.pel : S._pelPrev; S._vlPrev = d.vl; S._hzPrev = d.hz; S._sollPrev = d.soll; }
    }
    function effectUpdate(E, d, sc, recs) {
        var now = d.now, dt = (now - E.t0) / MIN, m = E.m;
        if (dt > 60) { closeEffect(E, [['Messung', 0, 'abgebrochen (Daten fehlten)']], sc, recs, now); return; }
        if (!d.fresh) { return; }
        if (E.art === 'freigabe') {
            if (dt <= 5 && have(d.hz) && (m.hzMax === undefined || d.hz > m.hzMax)) { m.hzMax = d.hz; }
            if (dt >= 2 && dt <= 5 && have(d.pel)) { m.pelS = (m.pelS || 0) + d.pel; m.pelN = (m.pelN || 0) + 1; }
            if (dt <= 30 && d.running && have(d.vl)) { m.vlMax = Math.max(m.vlMax === undefined ? -99 : m.vlMax, d.vl); }
            if (!d.running && dt <= 30) { m.stop = true; }
            if (dt >= 30 || (m.stop && dt >= 5)) {
                var dp = (m.pelN && have(E.pel0)) ? m.pelS / m.pelN - E.pel0 : null, dv = (m.vlMax !== undefined && have(E.vl0) && !m.stop) ? m.vlMax - E.vl0 : null;
                closeEffect(E, [['Verdichter ≥ 25 Hz binnen 5 min', m.hzMax !== undefined ? (m.hzMax >= 25 ? 1 : -1) : 0, 'gemessen ' + de(m.hzMax, 0) + ' Hz'],
                                ['Leistung +350 bis +650 W', have(dp) ? (dp >= 350 && dp <= 650 ? 1 : -1) : 0, 'gemessen ' + sg(dp, 0) + ' W'],
                                ['Vorlauf +2 K in 30 min', have(dv) ? (dv >= 2 ? 1 : -1) : 0, have(dv) ? 'gemessen ' + sg(dv, 1) + ' K' : 'nicht messbar (Stopp)']], sc, recs, now);
            }
        } else if (E.art === 'ohne_bedarf') {
            if (dt >= 2 && dt <= 10 && have(d.hz) && d.running) { m.hzMax = Math.max(m.hzMax === undefined ? 0 : m.hzMax, d.hz); }
            if (dt >= 10) { closeEffect(E, [['ohne Rückstand bleibt der Verdichter ≤ 20 Hz (10 min)', m.hzMax !== undefined ? (m.hzMax <= 20 ? 1 : -1) : 0, 'gemessen höchstens ' + de(m.hzMax, 0) + ' Hz']], sc, recs, now); }
        } else if (E.art === 'deckel') {
            if (dt <= 3 && have(d.hz)) { m.hzMin = Math.min(m.hzMin === undefined ? 99 : m.hzMin, d.hz); }
            if (dt >= 2 && dt <= 5 && have(d.pel)) { m.pelS = (m.pelS || 0) + d.pel; m.pelN = (m.pelN || 0) + 1; }
            if (dt >= 5) {
                var dp2 = (m.pelN && have(E.pel0)) ? m.pelS / m.pelN - E.pel0 : null;
                closeEffect(E, [['Verdichter ≤ 20 Hz binnen 3 min', m.hzMin !== undefined ? (m.hzMin <= 20 ? 1 : -1) : 0, 'gemessen ' + de(m.hzMin, 0) + ' Hz'], ['Leistung −300 W oder mehr', have(dp2) ? (dp2 <= -300 ? 1 : -1) : 0, 'gemessen ' + sg(dp2, 0) + ' W']], sc, recs, now);
            }
        } else if (E.art === 'verschiebung') {
            if (dt <= 3 && have(d.soll) && have(E.soll0) && d.soll - E.soll0 === E.dshift) { m.ok = true; }
            if (dt >= 3) { closeEffect(E, [['Soll-Vorlauf folgt binnen 3 min um ' + sg(E.dshift, 0) + ' K', m.ok ? 1 : -1, m.ok ? 'ja' : 'nein']], sc, recs, now); }
        }
    }
    function closeEffect(E, parts, sc, recs, now) {
        E.closed = true;
        var raw = parts.reduce(function (a, x) { return a + x[1] * SCORE.wirkung; }, 0), pts = E.kal ? 0 : raw;
        var T = tot(sc, E.rule, RULE[E.rule].ver, E.sv || 1); T.wirkN++; T.wirkP = r2(T.wirkP + pts); if (E.kal) { T.kalib++; }
        book(sc, recs, {t: iso(now), typ: 'wirkung', regel: E.rule, v: RULE[E.rule].ver, sv: E.sv || 1, ab: iso(E.t0), kalibrierfall: E.kal ? 1 : 0, punkte: pts, roh: raw,
                        teile: parts.map(function (x) { return {prognose: x[0], ergebnis: x[1] > 0 ? 'getroffen' : (x[1] < 0 ? 'daneben' : 'nicht messbar'), messung: x[2]}; }),
                        text: E.text + ': ' + parts.map(function (x) { return x[0] + ' → ' + (x[1] > 0 ? 'getroffen' : (x[1] < 0 ? 'daneben' : 'nicht messbar')) + ' (' + x[2] + ')'; }).join(' · ') + (E.kal ? ' · Kalibrierfall: das Modell stammt aus genau dieser Messung, 0 Punkte' : '')}, now);
    }
    // Verpasst: eine unabhaengig und strenger definierte Lage, in der laut Regelwerk ein Vorschlag noetig gewesen waere, ohne dass die Regel einen machte.
    // v1: Sperren aus Daten/Sicherheit entschuldigen; die eigenen Grenzen der Regel (Tageslimit, Abstand, Wartezeit, Stabilitaet) nicht.
    // v2: zusaetzlich entschuldigen die EIGENEN Sperren/Wartezeiten (SCORE.verpasstSperre.eigene), soweit sie auch mit den Standardwerten bestanden
    //     haetten. Gezaehlt werden nur "freie" Minuten (Lage besteht, Regel nicht durch eine eigene Sperre zurueckgehalten); erst wenn diese die
    //     Dauer erreichen, ist es "verpasst" (-20). Lief die Dauer nur wegen eigener Sperren ab, gibt es einen neutralen Eintrag "verpasst_sperre"
    //     (0 Punkte, getrennt gezaehlt). Ein harter Schaden im Fenster (SCORE.verpasstSperre.schaden) hebt die Entschuldigung auf: dann -20.
    var EXCUSE = ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'regler', 'heizstab'];
    var OWN_TEXT = {abstand: 'Mindestabstand', tageslimit: 'Tageslimit', abkuehlzeit: 'Wartezeit', haltezeit: 'Haltezeit', stabil: 'Stabilitätszeit', vorrang: 'Verschiebung einer anderen Regel', gegenrichtung: 'Wartezeit Gegenrichtung'};
    var MISS_DMG_TEXT = {komfort: 'Raum mehr als 1 K unter Minimum', takt: 'Verdichter stoppte', ueberschwingen: 'Vorlauf über der Abschaltgrenze (Soll +3,25 K)'};
    function stdOf(R, key) { var x = R.schwellen.filter(function (s) { return s.key === key; })[0]; return x ? x.std : null; }
    // Haelt die Regel in dieser Minute NUR eine eigene Sperre/Wartezeit zurueck? -> {ids: [...]} (mit Standardwerten gueltig), {ext: [...]} (nur wegen
    // verlaengerter Werte) oder null (andere Gruende: Bedingung fehlt, fremde Sperre, Vorschlag ...)
    function ownBlock(R, r, d, S, cfg, sv) {
        var own = SCORE.verpasstSperre.eigene.concat(sv >= 3 ? SCORE.verpasstSperre.gegenregel : []), rs = S.rules[R.id], c = cfg.rules[R.id], now = d.now, ok = [], ext = [];
        if (!r) { return null; }
        if (r.st === 'gesperrt' && r.locks.length) {
            if (!r.locks.every(function (l) { return own.indexOf(l) >= 0; })) { return null; }
            r.locks.forEach(function (l) {
                var std = false;
                if (l === 'abstand') { var chg = R.groesse === 'quiet' ? S.qChg : (R.groesse === 'shift' ? S.shiftChg : 0); std = !!chg && now - chg < LOCK_CFG.gapMin * MIN; }
                if (l === 'tageslimit') { std = rs.n >= stdOf(R, 'proTag'); }
                if (l === 'abkuehlzeit') { std = rs.cool - (c.pauseMin - stdOf(R, 'pauseMin')) * MIN > now; }
                if (l === 'vorrang') { std = true; }                                        // Eigentum einer anderen Regel: kein Zeitwert
                if (l === 'gegenrichtung') { std = !!S.arb.last && now - arbEnd(S.arb, d) < (r.hart ? LOCK_CFG.shiftHaltMin : LOCK_CFG.gegenMin) * MIN; }
                (std ? ok : ext).push(l);
            });
            return ext.length ? {ext: ext} : {ids: ok};
        }
        if (r.st === 'wartet' && own.indexOf('haltezeit') >= 0) {
            return rs.since && now - rs.since < stdOf(R, 'haltMin') * MIN ? {ids: ['haltezeit']} : {ext: ['haltezeit']};
        }
        if (r.st === 'bereit' && own.indexOf('stabil') >= 0 && r.naechste && r.naechste.b === 'stabil' && !r.naechste.weitere) {
            return rs.korrSince && now - rs.korrSince < stdOf(R, 'stabilMin') * MIN ? {ids: ['stabil']} : {ext: ['stabil']};
        }
        return null;
    }
    function missDamage(R, d, cfg, G) {                                             // harte Schaeden im Fenster (v2), je Regel nur die, die ein Vorschlag verhindern sollte
        var kinds = SCORE.verpasstSperre.schaden[R.id] || [];
        function hit(k) { if (kinds.indexOf(k) >= 0 && G.dmg.indexOf(k) < 0) { G.dmg.push(k); } }
        if (!d.fresh) { return; }
        if (d.running) { G.wasRun = true; } else if (G.wasRun) { hit('takt'); }
        if (d.running && have(d.vl) && have(d.soll) && d.vl - d.soll >= cfg.locks.stopK) { hit('ueberschwingen'); }
        d.rooms.forEach(function (x) { if (roomScore(x) && x.t < x.min - SCORE.verpasstSperre.komfortK) { hit('komfort'); } });
    }
    function missedStep(S, sc, d, cfg, res, recs, sv) {
        var now = d.now;
        RULES.forEach(function (R) {
            if (R.art !== 'befehl') { return; }
            var G = sc.gt[R.id] = sc.gt[R.id] || {since: 0, prop: false, excused: false, booked: false, lead: ''};
            var r = res.filter(function (x) { return x.id === R.id; })[0], c = cfg.rules[R.id];
            var cond = false, need = 20, lead = '';
            if (R.id === 'quiet_freigabe') { cond = d.fresh && have(d.q) && d.q >= 1 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz <= c.capHz && have(d.rlRueck) && d.rlRueck >= 2.0; need = 20; }
            if (R.id === 'quiet_strecken') { cond = d.fresh && have(d.q) && d.q === 0 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz >= c.hzHoch && d.roomBelow.length === 0 && have(d.stopEtaMin) && d.stopEtaMin <= 20; need = 10; }
            if (R.id === 'raum_offset') {
                var cold = d.rooms.filter(function (x) { return roomScore(x) && x.t <= x.min - 0.5; });
                var warm = d.rooms.filter(function (x) { return roomScore(x) && x.t > x.max + 0.3; });
                cond = d.fresh && cold.length > 0 && warm.length === 0; need = 180; lead = cold.length ? cold[0].name : '';
            }
            function bookMiss(extra) {
                var T = tot(sc, R.id, R.ver, sv); T.verpasst++;
                book(sc, recs, {t: iso(now), typ: 'verpasst', regel: R.id, v: R.ver, sv: sv, ab: iso(G.since), punkte: SCORE.verpasst, sperre: extra.sperre, schaden: extra.schaden,
                                text: 'Seit ' + hhmm(G.since) + ' (' + need + ' min) lag eine Lage vor, die einen Vorschlag gebraucht hätte' + (G.lead ? ' (' + G.lead + ')' : '') + '; die Regel machte keinen (Stand: ' + (r ? r.grund : '–') + ')' + (extra.text || '')}, now);
            }
            if (cond) {
                if (!G.since) { G.since = now; G.prop = false; G.excused = false; G.booked = false; G.lead = lead; G.last = now; G.frei = 0; G.gesperrt = 0; G.ids = []; G.ext = []; G.dmg = []; G.wasRun = false; G.sperreBooked = false; }
                if (r && (r.st === 'vorschlag' || r.st === 'hinweis')) { G.prop = true; }
                if (r && r.locks && r.locks.some(function (l) { return EXCUSE.indexOf(l) >= 0; })) { G.excused = true; }
                if (sv === 1) {
                    if (!G.booked && now - G.since >= need * MIN) {
                        G.booked = true;
                        if (!G.prop && !G.excused) { bookMiss({}); }
                    }
                    return;
                }
                // v3: schlaegt eine andere Verschiebungs-Regel fuer diese Lage dieselbe Richtung vor, ist die Lage versorgt
                if (sv >= 3 && R.groesse === 'shift' && S.arb.owner && S.arb.owner !== R.id && sgnOf(S.arb.soll - S.arb.von) === 1) { G.prop = true; G.durch = S.arb.owner; }
                var dt = Math.min(Math.max(0, now - (G.last || now)), 2 * MIN), ob = ownBlock(R, r, d, S, cfg, sv);
                G.last = now; G.ids = G.ids || []; G.ext = G.ext || []; G.dmg = G.dmg || [];
                if (ob && ob.ids) { G.gesperrt = (G.gesperrt || 0) + dt; ob.ids.forEach(function (x) { if (G.ids.indexOf(x) < 0) { G.ids.push(x); } }); }
                else { G.frei = (G.frei || 0) + dt; if (ob && ob.ext) { ob.ext.forEach(function (x) { if (G.ext.indexOf(x) < 0) { G.ext.push(x); } }); } }
                missDamage(R, d, cfg, G);
                if (G.booked || G.prop || G.excused || now - G.since < need * MIN) { return; }
                var sp = G.ids.map(function (x) { return OWN_TEXT[x]; }).join(', '), ex = G.ext.length ? '; über den Standardwert verlängert: ' + G.ext.map(function (x) { return OWN_TEXT[x]; }).join(', ') : '';
                if (G.frei >= need * MIN) {
                    G.booked = true;
                    bookMiss({sperre: G.ids.length ? G.ids.slice() : undefined, text: G.ids.length || G.ext.length ? ' · ' + need + ' min ohne eigene Sperre' + (sp ? ' (zeitweise ' + sp + ')' : '') + ex : ''});
                } else if (G.dmg.length) {
                    G.booked = true;
                    bookMiss({sperre: G.ids.slice(), schaden: G.dmg.slice(), text: ' · während eigener Sperre (' + sp + '), aber Schaden: ' + G.dmg.map(function (k) { return MISS_DMG_TEXT[k]; }).join(', ') + ' → nicht entschuldigt'});
                } else if (!G.sperreBooked) {
                    G.sperreBooked = true;
                    var T = tot(sc, R.id, R.ver, sv); T.verpasstSperre++;
                    book(sc, recs, {t: iso(now), typ: 'verpasst_sperre', regel: R.id, v: R.ver, sv: sv, ab: iso(G.since), punkte: 0, sperre: G.ids.slice(),
                                    text: 'Seit ' + hhmm(G.since) + ' (' + need + ' min) lag eine Lage vor, die einen Vorschlag gebraucht hätte' + (G.lead ? ' (' + G.lead + ')' : '') + '; die Regel durfte nur wegen eigener Sperre (' + sp + ') keinen machen, kein Schaden: neutral' + ex}, now);
                }
            } else {
                // Fenster endet mit einem Verdichter-Stopp (Takt), nachdem die Dauer abgelaufen war: auch das hebt die Entschuldigung auf
                if (sv > 1 && G.since && !G.booked && !G.prop && !G.excused && now - G.since >= need * MIN && G.gesperrt > 0) {
                    G.dmg = G.dmg || []; missDamage(R, d, cfg, G);
                    if (G.dmg.length) { G.booked = true; bookMiss({sperre: G.ids.slice(), schaden: G.dmg.slice(), text: ' · während eigener Sperre (' + G.ids.map(function (x) { return OWN_TEXT[x]; }).join(', ') + '), aber Schaden: ' + G.dmg.map(function (k) { return MISS_DMG_TEXT[k]; }).join(', ') + ' → nicht entschuldigt'}); }
                }
                G.since = 0;
            }
        });
    }
    // Messaufgabe "Comfort gegen Efficiency" (Korrektur 10.10.: ob Efficiency den Verdichter begrenzt, ist ungeklaert, Quiet 3 hat es bisher verdeckt).
    // Sammelt Minuten mit Quiet 0, laufendem Verdichter (ab Minute 15 und 3 min nach einer Quiet-Aenderung) und Vorlauf >= 2 K unter Soll, getrennt nach
    // Heizregelung. Sobald beide Seiten >= 10 min bei aehnlicher Aussentemperatur (Mittel hoechstens 3 K auseinander) haben, wird EIN Befund festgehalten.
    var MESS = {rueckK: 2, minMin: 10, atTolK: 3, nachQuietMin: 3, laufMin: 15};
    function messStep(sc, d, S, recs, sv) {
        var M = sc.mess = sc.mess || {c: [], e: [], done: false};
        if (!d.fresh || !d.running || d.q !== 0 || !have(d.hc) || !have(d.vlRueck) || d.vlRueck < MESS.rueckK || d.runMin < MESS.laufMin || (S.qChg && d.now - S.qChg < MESS.nachQuietMin * MIN)) { return; }
        var L = d.hc === 0 ? M.c : (d.hc === 1 ? M.e : null); if (!L) { return; }
        L.push([d.now, d.at, d.hz, d.pel, d.pth, r2(d.vlRueck), r2(d.rlRueck)]); if (L.length > 600) { L.splice(0, L.length - 600); }
        if (M.done || M.c.length < MESS.minMin || M.e.length < MESS.minMin) { return; }
        var sC = messSum(M.c), sE = messSum(M.e);
        if (!have(sC.at) || !have(sE.at) || Math.abs(sC.at - sE.at) > MESS.atTolK) { return; }
        M.done = true; M.befund = {comfort: sC, efficiency: sE, t: d.now};
        book(sc, recs, {t: iso(d.now), typ: 'messaufgabe', regel: 'quiet_freigabe', v: RULE.quiet_freigabe.ver, sv: sv, punkte: 0, comfort: sC, efficiency: sE,
                        text: 'Befund (Regel-Annahme prüfen): bei Quiet 0 und Vorlauf ≥ 2 K unter Soll lief der Verdichter in Comfort bis ' + de(sC.hzMax, 0) + ' Hz (Ø ' + de(sC.hzMittel, 0) + ' Hz, ' + de(sC.pel, 0) + ' W el, ' + de(sC.pth, 0) + ' W th, ' + sC.n + ' min, Ø ' + de(sC.at, 1) + ' °C), in Efficiency bis ' + de(sE.hzMax, 0) + ' Hz (Ø ' + de(sE.hzMittel, 0) + ' Hz, ' + de(sE.pel, 0) + ' W el, ' + de(sE.pth, 0) + ' W th, ' + sE.n + ' min, Ø ' + de(sE.at, 1) + ' °C)'}, d.now);
    }
    function messSum(L) {
        function mean(i) { var v = L.map(function (x) { return x[i]; }).filter(have); return v.length ? r2(v.reduce(function (a, b) { return a + b; }, 0) / v.length) : null; }
        return {n: L.length, at: mean(1), hzMax: Math.max.apply(null, L.map(function (x) { return have(x[2]) ? x[2] : 0; })), hzMittel: mean(2), pel: mean(3), pth: mean(4), vlRueck: mean(5), rlRueck: mean(6), von: iso(L[0][0]), bis: iso(L[L.length - 1][0])};
    }
    function messStatus(S) {
        var M = (S.sc && S.sc.mess) || {c: [], e: []};
        if (M.done) { return {offen: false, text: 'erledigt: siehe Befund', befund: M.befund}; }
        return {offen: true, comfortMin: M.c.length, efficiencyMin: M.e.length, efficiency: M.e.length ? messSum(M.e) : null, comfort: M.c.length ? messSum(M.c) : null,
                text: 'offen: Comfort ' + M.c.length + ' min, Efficiency ' + M.e.length + ' min mit Quiet 0 und Vorlauf ≥ 2 K unter Soll (je ' + MESS.minMin + ' min bei ähnlicher Außentemperatur nötig; ein kurzer Boost in Comfort würde reichen)'};
    }
    function report(S, sv) {                                                         // Punktebuch je Regel/Version mit Freigabereife (nur Anzeige; die Freigabe entscheidet der Nutzer)
        var sc = S.sc, out = [];
        sv = sv || sc.sv || SCORE_VER;
        RULES.forEach(function (R) {
            var T = tot(sc, R.id, R.ver, sv), days = T.since ? (S.last - T.since) / (24 * 60 * MIN) : 0;
            var skill = T.bsRef > 0 ? 1 - T.bs / T.bsRef : null;
            var crit = [
                {k: 'faelle', ok: T.bewertet >= SCORE.reife.faelle, kurz: 'Fälle ' + T.bewertet + '/' + SCORE.reife.faelle, text: T.bewertet + ' von ' + SCORE.reife.faelle + ' bewerteten Fällen'},
                {k: 'tage', ok: days >= SCORE.reife.tage, kurz: 'Tage ' + de(days, 1) + '/' + SCORE.reife.tage, text: de(days, 1) + ' von ' + SCORE.reife.tage + ' Tagen'},
                {k: 'skill', ok: have(skill) && skill >= SCORE.reife.skill, kurz: 'Skill ' + (have(skill) ? de(skill, 2) : '–') + '/' + de(SCORE.reife.skill, 1), text: 'Brier-Skill ' + (have(skill) ? de(skill, 2) : '–') + ' (mindestens ' + de(SCORE.reife.skill, 1) + ')'},
                {k: 'schaden', ok: T.schaden === 0, kurz: 'Schaden ' + T.schaden, text: T.schaden + ' × Schaden'},
                {k: 'verpasst', ok: T.verpasst <= SCORE.reife.verpasst, kurz: 'Verpasst ' + T.verpasst + '/≤' + SCORE.reife.verpasst, text: T.verpasst + ' × verpasst (höchstens ' + SCORE.reife.verpasst + ')'}
            ];
            if (R.art === 'befehl') { crit.push({k: 'wirkung', ok: T.wirkN - T.kalib >= SCORE.reife.wirkFaelle && T.wirkP > 0, kurz: 'Wirkung ' + (T.wirkN - T.kalib) + '/' + SCORE.reife.wirkFaelle, text: (T.wirkN - T.kalib) + ' von ' + SCORE.reife.wirkFaelle + ' Wirkungsfällen (ohne Kalibrierung), ' + sg(T.wirkP, 0) + ' Punkte'}); }
            out.push({regel: R.id, name: R.name, v: R.ver, art: R.art, punkte: T.punkte, faelle: T.faelle, bewertet: T.bewertet, treffer: T.treffer, fehlalarm: T.fehlalarm, neutral: T.neutral,
                      trefferquote: T.bewertet ? r2(T.treffer / T.bewertet) : null, fehlalarmquote: T.bewertet ? r2(T.fehlalarm / T.bewertet) : null, skill: r2(skill), schaden: T.schaden, verpasst: T.verpasst, verpasstSperre: T.verpasstSperre || 0, sv: sv,
                      wirkung: {n: T.wirkN, kalib: T.kalib, punkte: T.wirkP}, tage: r2(days), reif: R.art === 'befehl' && crit.every(function (x) { return x.ok; }), kriterien: crit});
        });
        return out;
    }

    // ------------------------------------------------------------------ Ein-Klick-Uebernahme (ausgeliefert, gesperrt). Nur der Klick sendet; der Rueckweg gehoert zum geklickten Vorschlag.
    var WHITELIST = {                                                                // erlaubte Befehle, Wertebereiche, Ruecklese-Wert; alles andere wird abgelehnt
        SetQuietMode: {topic: 'panasonic_heat_pump/commands/SetQuietMode', werte: [0, 1, 2, 3], ruecklese: 'q', text: 'Quiet-Stufe'},
        SetZ1HeatRequestTemperature: {topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature', werte: [-1, 0, 1], ruecklese: 'shift', text: 'Heizkurven-Verschiebung', heizkurve: true}
    };
    var APPLY = {maxAlterMin: 2.5, hpMaxAgeMin: 5, abstandMin: 10, proTag: 6, doppelMs: 120000, rueckleseS: 90, wiederholungen: 2, rueckwegVersuche: 3};
    function newApply() { return {mv: VER, aktiv: null, pending: null, day: '', n: 0, lastSend: 0, verworfen: [], lastClick: null, alarm: null}; }
    function cmdOk(name, value) { var W = WHITELIST[name]; if (!W) { return 'Befehl ' + name + ' steht nicht auf der Whitelist'; } if (W.werte.indexOf(value) < 0) { return 'Wert ' + value + ' für ' + name + ' nicht erlaubt (' + W.werte.join(', ') + ')'; } return null; }
    function cmdMsg(name, value, source) { return {topic: WHITELIST[name].topic, payload: String(value), source: source}; }
    function fresh(plant) { return have(num(plant.hpAge)) && num(plant.hpAge) <= APPLY.hpMaxAgeMin; }
    // ctx: {now, enabled (Hauptschalter), rules (freigegebene Regel-IDs), eng (OPT_engine: {ts, prop, locks}), plant ({q, shift, hpAge, block, heatMode, z1Sensor}), cfg, endReason, halten}
    function applyRequest(A, req, ctx) {
        A = (A && A.mv === VER) ? A : newApply();
        var now = ctx.now, out = {A: A, send: [], toast: null, log: []}, act = req && req.topic, pl = (req && req.payload) || {}, plant = ctx.plant || {};
        function deny(text, color) { out.toast = {text: text, color: color || 'red'}; out.log.push({t: iso(now), aktion: act || '?', ergebnis: 'abgelehnt', grund: text, id: pl.id || null}); return out; }
        var day = ymd(now); if (A.day !== day) { A.day = day; A.n = 0; }
        if (act === 'sperren') { out.sperren = true; out.toast = {text: 'Übernahme gesperrt (Hauptschalter aus).', color: 'orange'}; out.log.push({t: iso(now), aktion: 'sperren', ergebnis: 'ok'}); return out; }
        if (act === 'verwerfen') {
            if (!pl.id) { return deny('Kein Vorschlag angegeben.'); }
            if (A.verworfen.indexOf(pl.id) < 0) { A.verworfen.push(pl.id); A.verworfen = A.verworfen.slice(-20); }
            out.toast = {text: 'Vorschlag ausgeblendet (keine Bewertung, die Punkte bleiben unberührt).', color: ''}; out.log.push({t: iso(now), aktion: 'verwerfen', ergebnis: 'ok', id: pl.id}); return out;
        }
        if (act === 'zuruecksetzen') {
            if (!A.aktiv) { return deny('Nichts zurückzusetzen: keine aktive Übernahme.', 'orange'); }
            if (num(plant.block) === 1) { return deny('Alle MQTT-Befehle sind gesperrt (MQTT.block_active). Nichts gesendet.'); }
            return startReturn(A, ctx, out, 'Zurücksetzen (Klick)');
        }
        if (act !== 'uebernehmen') { return deny('Unbekannte Aktion.'); }
        // ---- Prüfkette für "Übernehmen" (jede Stufe mit eigenem Grund; nichts vom Browser wird ungeprüft übernommen)
        if (A.lastClick && A.lastClick.id === pl.id && now - A.lastClick.ts < APPLY.doppelMs) { return deny('Schon übernommen (Doppelklick ignoriert).', 'orange'); }
        if (ctx.enabled !== true) { return deny('Übernahme gesperrt: Hauptschalter OPT_apply_enabled ist aus. Nichts gesendet.'); }
        var eng = ctx.eng || {}, p = eng.prop;
        if (!eng.ts || now - eng.ts > APPLY.maxAlterMin * MIN) { return deny('Die Entscheidungsmaschine hat seit über 2 min nicht gerechnet. Nichts gesendet.'); }
        if (!p || p.id !== pl.id) { return deny('Der angezeigte Vorschlag ist nicht mehr aktuell. Nichts gesendet.'); }
        if (checksum(p) !== pl.sum || p.sum !== pl.sum) { return deny('Prüfsumme stimmt nicht. Nichts gesendet.'); }
        if (p.art !== 'befehl') { return deny('Dies ist nur ein Hinweis, er kann nicht übernommen werden.'); }
        if ((ctx.rules || []).indexOf(p.rule) < 0) { return deny('Übernahme für die Regel „' + p.rule + '“ ist nicht freigegeben. Nichts gesendet.'); }
        if (now >= p.bis) { return deny('Der Vorschlag ist abgelaufen. Nichts gesendet.'); }
        var bad = cmdOk(p.cmd.name, p.cmd.value); if (bad) { return deny(bad + '. Nichts gesendet.'); }
        var W = WHITELIST[p.cmd.name];
        if (W.topic !== p.cmd.topic) { return deny('Topic passt nicht zur Whitelist. Nichts gesendet.'); }
        if (num(plant.block) === 1) { return deny('Alle MQTT-Befehle sind gesperrt (MQTT.block_active). Nichts gesendet.'); }
        if (!fresh(plant)) { return deny('Anlagendaten sind veraltet. Nichts gesendet.'); }
        if (eng.locks && eng.locks[p.rule] && eng.locks[p.rule].length) { return deny('Gesperrt: ' + eng.locks[p.rule].join(', ') + '. Nichts gesendet.'); }
        var ist = num(plant[W.ruecklese]);
        if (ist !== p.von) { return deny('Die Anlage steht nicht mehr auf ' + p.von + ' (jetzt ' + (ist === null ? 'unbekannt' : ist) + '). Nichts gesendet.'); }
        if (W.heizkurve && (num(plant.heatMode) !== 0 || num(plant.z1Sensor) !== 0)) { return deny('Verschiebung nur im Heizkurvenmodus mit Wasserfühler. Nichts gesendet.'); }
        if (A.pending) { return deny('Ein Befehl wartet noch auf die Bestätigung der Anlage. Nichts gesendet.', 'orange'); }
        if (A.aktiv && A.aktiv.groesse === RULE[p.rule].groesse) { return deny('Für diese Größe ist schon eine Übernahme aktiv (erst zurücksetzen). Nichts gesendet.', 'orange'); }
        if (A.lastSend && now - A.lastSend < APPLY.abstandMin * MIN) { return deny('Zu schnell: frühestens ' + hhmm(A.lastSend + APPLY.abstandMin * MIN) + '. Nichts gesendet.', 'orange'); }
        if (A.n >= APPLY.proTag) { return deny('Tageslimit von ' + APPLY.proTag + ' Befehlen erreicht. Nichts gesendet.'); }
        // ---- senden: genau der angezeigte Vorschlag
        var R = RULE[p.rule], cr = ctx.cfg && ctx.cfg.rules && ctx.cfg.rules[p.rule], maxD = cr && have(num(cr.maxDauerMin)) ? num(cr.maxDauerMin) : null;
        var until = maxD ? now + maxD * MIN : null;
        A.n++; A.lastSend = now; A.lastClick = {id: p.id, ts: now}; A.alarm = null;
        A.pending = {name: p.cmd.name, value: p.cmd.value, ts: now, versuche: 1, art: 'uebernahme', id: p.id};
        A.aktiv = {id: p.id, rule: p.rule, groesse: R.groesse, name: p.cmd.name, value: p.cmd.value, von: p.von, ts: now, bis: until, bestaetigt: false};
        out.send.push(cmdMsg(p.cmd.name, p.cmd.value, 'Optimierer (Klick)'));
        out.toast = {text: R.name + ': ' + p.was + ' gesendet. Warte auf die Bestätigung der Anlage …', color: ''};
        out.log.push({t: iso(now), aktion: 'uebernehmen', ergebnis: 'gesendet', id: p.id, sum: p.sum, regel: p.rule, v: p.ver, befehl: p.cmd.name, topic: p.cmd.topic, wert: p.cmd.value, von: p.von, bis: until ? iso(until) : null});
        return out;
    }
    function startReturn(A, ctx, out, why) {
        var now = ctx.now, a = A.aktiv, bad = cmdOk(a.name, a.von);
        if (bad) { A.alarm = {ts: now, text: 'Rückweg unmöglich: ' + bad}; out.toast = {text: A.alarm.text, color: 'red'}; out.log.push({t: iso(now), aktion: 'rueckweg', ergebnis: 'abgelehnt', grund: bad}); return out; }
        if (A.pending && A.pending.art === 'rueckweg') { out.toast = {text: 'Der Rückweg läuft bereits.', color: 'orange'}; return out; }
        A.pending = {name: a.name, value: a.von, ts: now, versuche: 1, art: 'rueckweg', id: a.id};
        A.lastSend = now;
        out.send.push(cmdMsg(a.name, a.von, 'Optimierer (Rückweg)'));
        out.toast = {text: why + ': ' + WHITELIST[a.name].text + ' zurück auf ' + a.von + ' gesendet.', color: ''};
        out.log.push({t: iso(now), aktion: 'rueckweg', ergebnis: 'gesendet', grund: why, id: a.id, befehl: a.name, wert: a.von});
        return out;
    }
    // alle 15 s: Ruecklesen (Bestaetigung), begrenzte Wiederholung, Warnung bei Abweichung, automatischer Rueckweg (Ablauf oder Grund entfallen)
    function applyTick(A, ctx) {
        A = (A && A.mv === VER) ? A : newApply();
        var now = ctx.now, out = {A: A, send: [], toast: null, log: []}, P = A.pending, plant = ctx.plant || {}, blocked = num(plant.block) === 1;
        if (P) {
            var W = WHITELIST[P.name], ist = num(plant[W.ruecklese]);
            if (ist === P.value && fresh(plant)) {
                A.pending = null;
                if (P.art === 'uebernahme' && A.aktiv) { A.aktiv.bestaetigt = true; A.aktiv.bestTs = now; out.toast = {text: W.text + ' steht jetzt auf ' + P.value + ' (von der Anlage bestätigt).', color: 'green'}; }
                if (P.art === 'rueckweg') { out.toast = {text: W.text + ' wieder auf ' + P.value + ' (bestätigt). Übernahme beendet.', color: 'green'}; A.aktiv = null; }
                out.log.push({t: iso(now), aktion: 'bestaetigt', art: P.art, befehl: P.name, wert: P.value, nach_s: Math.round((now - P.ts) / 1000)});
            } else if (now - P.ts >= APPLY.rueckleseS * 1000 && !blocked) {
                var maxV = P.art === 'rueckweg' ? APPLY.rueckwegVersuche : 1 + APPLY.wiederholungen;
                if (P.versuche < maxV) {
                    P.versuche++; P.ts = now; A.lastSend = now;
                    out.send.push(cmdMsg(P.name, P.value, P.art === 'rueckweg' ? 'Optimierer (Rückweg)' : 'Optimierer (Klick)'));
                    out.log.push({t: iso(now), aktion: 'wiederholung', art: P.art, befehl: P.name, wert: P.value, versuch: P.versuche, ist: ist});
                } else {
                    A.pending = null;
                    A.alarm = {ts: now, text: 'Keine Bestätigung: ' + W.text + ' sollte ' + P.value + ' sein, die Anlage meldet ' + (ist === null ? 'nichts' : ist) + ' (' + P.versuche + ' Versuche). Bitte prüfen.'};
                    out.toast = {text: A.alarm.text, color: 'red'};
                    out.log.push({t: iso(now), aktion: 'ruecklese_timeout', art: P.art, befehl: P.name, wert: P.value, ist: ist, versuche: P.versuche});
                    // Anlage steht nachweislich noch auf dem Ausgangswert: es gibt nichts zurueckzusetzen, die Uebernahme endet (sonst blockierte sie diese
                    // Groesse fuer jeden weiteren Klick, bei der Quiet-Freigabe ohne Ablaufzeit fuer immer). Unklarer Ist-Wert: aktiv lassen, "Zuruecksetzen" bleibt moeglich.
                    if (P.art === 'uebernahme' && A.aktiv) { if (ist === A.aktiv.von && fresh(plant)) { A.aktiv = null; } else { A.aktiv.unbestaetigt = true; } }
                }
            }
            return out;
        }
        var a = A.aktiv;
        if (!a) { return out; }
        var W2 = WHITELIST[a.name], ist2 = num(plant[W2.ruecklese]);
        if (a.bestaetigt && have(ist2) && ist2 !== a.value && fresh(plant)) {            // fremde Aenderung: nicht zuruecksetzen, nur warnen und die Uebernahme beenden
            A.alarm = {ts: now, text: W2.text + ' wurde von außen auf ' + ist2 + ' geändert (Übernahme ' + a.value + '). Kein automatischer Rückweg.'};
            out.toast = {text: A.alarm.text, color: 'orange'}; out.log.push({t: iso(now), aktion: 'fremde_aenderung', befehl: a.name, soll: a.value, ist: ist2}); A.aktiv = null; return out;
        }
        if (blocked) { return out; }                                                     // Notbremse: warten, nicht zaehlen
        var why = null;
        var halt = ctx.halten && ctx.halten[a.rule];                                     // Uebergabe: die andere Verschiebungs-Regel verlangt denselben Wert -> kein Rueckweg (kein Hin und Her)
        if (a.bis && now >= a.bis && !halt) { why = 'Rückweg nach Ablauf (' + hhmm(a.bis) + ')'; }
        else if (a.bestaetigt && ctx.endReason && ctx.endReason[a.rule]) { why = 'Rückweg: ' + ctx.endReason[a.rule]; }
        if (why && fresh(plant)) { return startReturn(A, ctx, out, why); }
        return out;
    }

    return {VER: VER, SCORE_VER: SCORE_VER, RULES: RULES, RULE: RULE, LOCKS: LOCKS, LOCK_CFG: LOCK_CFG, SCORE: SCORE, WHITELIST: WHITELIST, APPLY: APPLY,
            brier: brier, vorschau: vorschau, bedarfK: bedarfK, tagesgang: tagesgang, defaults: defaults, mergeCfg: mergeCfg, newState: newState, fixState: fixState, step: step, report: report, messStatus: messStatus, MESS: MESS, snapshot: snapshot, unsnap: unsnap,
            checksum: checksum, newApply: newApply, applyRequest: applyRequest, applyTick: applyTick, iso: iso, hhmm: hhmm, isoWeek: isoWeek, de: de, sg: sg};
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = ENGINE; }
// == ENGINE-CORE-ENDE ==

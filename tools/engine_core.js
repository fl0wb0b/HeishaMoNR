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
    var SCORE_VER = 5;           // Bewertungsregeln (vorab festgelegt; jede Aenderung erhoeht die Version, alte Punkte bleiben getrennt)
                                 // v2 (10.10.2026): "verpasst" waehrend einer EIGENEN Sperre/Wartezeit (Standardwerte, ohne Schaden) zaehlt neutral und
                                 // getrennt ("waehrend Sperre"). v1 bleibt nachrechenbar: cfg.sv = 1 (Replay alter Datensaetze).
                                 // v3 (11.10.2026): Verschiebungs-Arbitrierung. Sperren durch eine Gegenregel ("vorrang", "gegenrichtung") entschuldigen
                                 // "verpasst" wie eigene Sperren; eine Lage, fuer die eine andere Verschiebungs-Regel dieselbe Richtung vorschlaegt, gilt als
                                 // versorgt; Wirkung einer uebernommenen Verschiebung zaehlt fuer die Regel, deren Vorschlag uebernommen wurde. cfg.sv = 2 rechnet v2 nach.
                                 // v4 (12.10.2026): Hinweis-Regeln (art 'hinweis') sammeln keine Punkte mehr (Treffer/Fehlalarm/neutral/Schaden nur gezaehlt, kein
                                 // Skill, keine Freigabereife, nicht im Diagramm). Brier-Summen (bs/bsRef) kommen nur aus vollstaendig abgeschlossenen Faellen
                                 // (ein offener Fall veraendert den Skill nicht); Skill erst ab SCORE.skillMinFaelle (3) bewerteten Faellen. cfg.sv = 3 rechnet v3 nach.
                                 // v5 (12.10.2026, Entscheidung des Nutzers, Weg b): liegt die Basisrate b eines Horizonts mindestens bei der Prognose p (b >= p),
                                 // zaehlt ein Treffer dort neutral (0 Punkte, kein Beitrag zum Skill: keine Trennschaerfe messbar); ein Fehlalarm dort bleibt ein Abzug
                                 // gegen die Basisrate SCORE.fehlRefB (0,5, wie vor dem Lernen der Basisrate), weil die Brier-Formel ihn bei b > p sonst mit PLUS
                                 // belohnen wuerde. b < p: Brier wie bisher. Skill erst ab 3 Faellen mit Brier-Beitrag. cfg.sv = 4 rechnet v4 nach.
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
        {id: 'abstand', kurz: 'Mindestabstand', text: 'Mindestabstand zur letzten Änderung', herkunft: 'Wächter: 60 min Abstand; Opus: höchstens 1 Wechsel pro Stunde; seit 13.10. über Quiet und Verschiebung gemeinsam (Regel-Review 3.4: sonst ist keine Wirkung zuzuordnen und Freigabe und +1 K heizen doppelt). Ein Quiet-Notfall (Heizstab-Nähe, Raum ≥ notK unter Minimum) überbrückt ihn nach notfallMin (10 min; Regel-Review B4)'},
        {id: 'tageslimit', kurz: 'Tageslimit', text: 'Tageslimit der Regel erreicht', herkunft: 'Schreibbudget (Opus: höchstens 6 Wechsel/Tag), EEPROM-Verschleiß unbekannt. Seit 13.10. zählen bei Befehlsregeln nur übernommene Vorschläge (Regel-Review R5: Vorschläge in der Nacht ohne Klick verbrauchten sonst das Kontingent für den Tag; die Übernahme begrenzt ohnehin auf 6 Befehle am Tag); ein Quiet-Notfall ist ausgenommen'},
        {id: 'abkuehlzeit', kurz: 'Wartezeit', text: 'Wartezeit nach dem letzten Vorschlag', herkunft: 'kein Flattern: ein abgelaufener oder zurückgezogener Vorschlag kommt erst nach einer Pause wieder; ein Quiet-Notfall nach notfallMin (10 min), außer der vorige Notfall-Vorschlag ist nur abgelaufen (nachts klickt niemand, sonst käme derselbe Vorschlag alle 40 min)'},
        {id: 'takt', kurz: 'Takt-Gefahr', text: 'Takt-Gefahr: Vorlauf über Soll', herkunft: 'Anlage schaltet bei Vorlauf ≥ Soll +3,25 K nach ~3 min ab (6 Stopps 07.–10.10.); Sperre ab Soll +1 K für Maßnahmen, die den Vorlauf näher an diese Grenze bringen (mehr Leistung, −1 K)'},
        {id: 'heizstab', kurz: 'Heizstab-Nähe', text: 'Heizstab-Nähe', herkunft: 'Heizstab ab Außentemperatur < Heater_On_Outdoor_Temp (0 °C) bei Vorlauf < Soll −3 K nach 15 min; ein +1-K-Schritt vergrößert den Rückstand sofort um 1 K'},
        {id: 'modell', kurz: 'Modell-Gate', text: 'Gebäudemodell noch nicht freigegeben', herkunft: 'Wärmefahrplan: Gate des Gebäudemodells (≥ 10 Tage, Fehler ≥ 10 % kleiner als der bisherige Schätzer, plausible Koeffizienten); vorher ist eine Bedarfsvorhersage nicht belegt'},
        {id: 'vorrang', kurz: 'andere Regel', text: 'Die Stellgröße gehört einer anderen Regel', herkunft: 'Arbitrierung je Stellgröße (Heizkurven-Verschiebung: Raumeinfluss, Vorausschau, +1 K von „Deckel/Laufzeit“; Quiet: Quiet-Freigabe, Deckel/Laufzeit): je Zeit hat genau eine Regel die Größe (laufender Vorschlag oder übernommener Wert); keine zweite Regel schlägt daneben oder dagegen vor. Quiet: eine übernommene Stufe weicht nur einem Notfall (Raum ≥ notK unter Minimum oder Heizstab-Nähe), frühestens notfallMin (10 min) nach der Übernahme (Regel-Review B4; vorher 60 min)'},
        {id: 'gegenrichtung', kurz: 'Gegenrichtung', text: 'Gegenrichtung zur letzten Änderung', herkunft: 'Kein Hin und Her: Gegenrichtung frühestens shiftHaltMin bzw. quietHaltMin (60 min) nach dem Ende der letzten Änderung derselben Größe und nur mit Notfall (Verschiebung: Raum ≥ notK 0,3 K außerhalb des Bandes; Quiet: Raum ≥ notK unter Minimum oder Heizstab-Nähe, dort schon nach notfallMin 10 min), ohne Notfall erst nach gegenMin bzw. quietGegenMin (240 min); ANNAHME'}
    ];
    var LOCK_TEXT = {}; LOCKS.forEach(function (l) { LOCK_TEXT[l.id] = l.text; });

    // ------------------------------------------------------------------ Vorausschau: Eingabe aus Wetter und Gebaeudemodell (rein; die Huelle und das Replay rufen sie auf)
    // W  = OPT_weather {f_ts, fpts: [[t, Temperatur, Feuchte, Bewoelkung, Wind m/s], ...]}
    // PL = OPT_plan {model: {n, minDays, gate, why, aktiv, bs, bw, ua, tbal, windTot}}  (Gate und coefActivate des Waermefahrplans)
    // PI = OPT_plan_in {pv: [[Beginn, W, Dauer ms], ...]}                       (PV-Prognose; nur mit aktivem Modell verwendet)
    // -> {age, at: [jetzt, +1 h ... +6 h] (an den Fuehler angeglichen, wie der Fahrplan: Versatz klingt mit 4 h ab), n, minDays, gate, ua, tbal, aktiv
    //     [, bs, bw, windTot, wind[], pv[]]}  Sonne und Wind stehen NUR mit aktivem Modell im Datensatz; ohne coefActivate kann die Regel sie nicht verwenden.
    var VS_H = 6;
    // Grenzen wie im Waermefahrplan (coefSafe, Nutzerentscheidung 13.10.2026, nicht gemessen): bs <= 0,5 (oberes Ende tvofi-Bereich), bw <= 0,0125 kWh/(K*m/s*h)
    // (~ +5 % Waermeverlust je m/s bei UA 0,25 kW/K); Wind zaehlt erst ueber 4 m/s (Idee ClimateOptimizer WIND_DEADBAND_MS). OPT_plan.model.windTot hat Vorrang.
    var VS_LIM = {bs: 0.5, bw: 0.0125, windTot: 4};
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
            o.bs = have(num(M.bs)) ? Math.min(VS_LIM.bs, Math.max(0, num(M.bs))) : 0; o.bw = have(num(M.bw)) ? Math.min(VS_LIM.bw, Math.max(0, num(M.bw))) : 0; o.wind = []; o.pv = [];   // harte Grenzen wie im Fahrplan
            o.windTot = have(num(M.windTot)) ? Math.max(0, num(M.windTot)) : VS_LIM.windTot;
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
                var w = v.wind && have(v.wind[i]) ? Math.max(0, v.wind[i] - (have(v.windTot) ? v.windTot : VS_LIM.windTot)) : 0, sp = v.pv && have(v.pv[i]) ? (v.pv[i] - (base.pv && have(base.pv[i]) ? base.pv[i] : 0)) / 1000 : 0;
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
    // Arbitrierung je Stellgroesse. Gemeinsamer Zustand S.arb (Heizkurven-Verschiebung "shift": Raumeinfluss, Vorausschau, +1 K von "Deckel/Laufzeit")
    // und S.arbQ (Quiet-Stufe "quiet": Quiet-Freigabe, Deckel/Laufzeit; seit 13.10.2026, Quiet-Freigabe v2 / Deckel/Laufzeit v4):
    //   owner/soll/von/start  laufender Vorschlag (genau einer)   applied  von der Anlage uebernommener Wert einer Regel   last  letzte beendete Aenderung
    function arbOf(S, g) { return g === 'quiet' ? S.arbQ : S.arb; }
    function curOf(d, g) { return g === 'quiet' ? d.q : d.shift; }
    function ownedBy(d, A, g, self) { var ap = A && A.applied, cur = curOf(d, g); return (ap && ap.rule !== self && have(cur) && cur === ap.w && (g === 'quiet' || cur !== 0)) ? ap.rule : null; }
    function shiftOwnedBy(d, self) { return ownedBy(d, d.arb, 'shift', self); }
    function komfortNot(d, dir) {                                                    // Komfort-Notfall: ein gueltiger Raum >= notK ausserhalb des Bandes in der Richtung, die die Massnahme behebt, keiner auf der anderen Seite
        var v = d.rooms.filter(function (r) { return r.active && r.valid && have(r.min) && have(r.max); });
        if (dir > 0) { return v.some(function (r) { return r.t <= r.min - d.notK; }) && !v.some(function (r) { return r.t > r.max; }); }
        return v.some(function (r) { return r.t >= r.max + d.notK; }) && !v.some(function (r) { return r.t < r.min; });
    }
    function sgnOf(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
    function arbEnd(A, d, g) { return (A.applied && A.last && A.applied.rule === A.last.rule && curOf(d, g || 'shift') === A.applied.w) ? d.now : (A.last ? A.last.end : 0); }   // steht der Wert noch, laeuft die Aenderung noch
    function wTxt(g, w) { return g === 'quiet' ? 'Quiet ' + w : 'Verschiebung ' + sg(w, 0) + ' K'; }
    function arbLocks(R, e, d, S, cfg, add) {
        var g = (e && e.groesse) || R.groesse, A = arbOf(S, g), L = cfg.locks, now = d.now, q = g === 'quiet';
        if (!e || !have(e.wert) || !have(e.von) || !A) { return; }
        var dir = sgnOf(e.wert - e.von), halt = q ? (e.hart ? L.notfallMin : L.quietHaltMin) : L.shiftHaltMin, gegen = q ? L.quietGegenMin : L.gegenMin;   // Quiet-Notfall: 10 statt 60 min (Regel-Review B4)
        if (R.sperren.indexOf('vorrang') >= 0) {
            var ob = ownedBy(d, A, g, R.id);
            if (A.owner && A.owner !== R.id) { add('vorrang', (A.soll === e.wert ? (q ? 'dieselbe Stufe ' : 'dieselbe Verschiebung ') + (q ? A.soll : sg(A.soll, 0) + ' K') + ' schlägt schon „' : wTxt(g, A.soll) + ' vorgeschlagen von „') + RULE[A.owner].kurz + (A.soll === e.wert ? '“ vor' : '“')); }
            else if (ob && !(q && e.hart && now - A.applied.ts >= halt * MIN)) { add('vorrang', wTxt(g, curOf(d, g)) + ' gehört „' + RULE[ob].kurz + '“' + (q ? ' (Notfall frühestens ' + halt + ' min nach der Übernahme)' : ''), q && e.hart ? A.applied.ts + halt * MIN : null); }
        }
        if (R.sperren.indexOf('gegenrichtung') >= 0 && A.last && dir !== 0 && A.last.dir === -dir) {
            var ls = A.last, end = arbEnd(A, d, g), el = now - end, h0 = (q && ls.lapse) ? ls.start : end;   // Zuordnung ohne Aenderung beendet: Mindesthaltezeit ab der Uebernahme, Wartezeit ab dem Ende
            var was = 'letzte Änderung ' + wTxt(g, ls.w) + ' („' + RULE[ls.rule].kurz + '“) bis ' + hhmm(end);
            if (now - h0 < halt * MIN) { add('gegenrichtung', was + ', Mindesthaltezeit ' + halt + ' min', h0 + halt * MIN); }
            else if (el < gegen * MIN && !e.hart) { add('gegenrichtung', was + ', ohne ' + (q ? 'Notfall' : 'Komfort-Notfall') + ' erst nach ' + gegen + ' min', end + gegen * MIN); }
        }
    }

    // Laufzeit strecken (v2): Takt ist belegt, wenn der letzte Lauf ueber den Vorlauf abschaltete (Stopp-Art) und kuerzer als kurzerLaufMin war, oder bei
    // mindestens starts3h Starts in 3 h. Die Vorhersage "Abschaltgrenze in <= 45 min" (v1) loest nicht mehr aus (Replay 07.-12.10.: unzuverlaessig bei >= 22 Hz).
    // v4 (Regel-Review LS-7): Takt aus der entprellten Takt-Messung (mehr als startsTagWarn Starts in 24 h oder mehr als kurzAnteilWarn kurze Laeufe bei >= 4 Laeufen)
    // oder: letzter Lauf mit Abschaltung ueber den Vorlauf kuerzer als kurzerLaufMin UND mindestens starts3h Starts in 3 h (ein einzelner kurzer Lauf ist noch kein Takt)
    function taktBeleg(d, c) { return !!((d.takt && d.takt.takt) || (d.lastRunThermo && have(d.lastRunMin) && d.lastRunMin < c.kurzerLaufMin && d.starts3h >= c.starts3h)); }
    // ------------------------------------------------------------------ Quiet-Deckel je Stufe (seit Quiet-Freigabe v2 / Deckel/Laufzeit v4, 13.10.2026)
    // Tabelle = gemessene Untergrenze (hoechste Frequenz, die die Stufe bei Rueckstand zugelassen hat; Quelle je Zeile). Gelernt wird die hoechste Frequenz, die eine Stufe
    // mindestens deckelHaltMin Minuten am Stueck gehalten hat (Takt-Messung, je Heizregelung x Quiet x Aussenband, erst deckelNachQMin nach einem Quiet-Wechsel, weil der
    // Verdichter nach einem Wechsel nach oben bis 15 min braucht, 12.10. 09:30). Wirksamer Deckel = groesserer Wert aus Tabelle und gelerntem Wert (mit copMinMin Minuten).
    var DECKEL = [
        {q: 3, hz: 17, text: 'Messung 07.–13.10.: Quiet 3 hielt 16–17 Hz (2763 min bei 1–14 °C; 10.10. 08:25–08:40 16 Hz bei 6–7 K Rücklauf-Rückstand)'},
        {q: 2, atUnter: 7, hz: 21, text: 'Messung 12.10. 07:20–09:29: Quiet 2 bis 20–21 Hz bei 1–4 °C (168 min)'},
        {q: 2, hz: 17, text: 'Messung 08.10. 09:33 und 13.10. 16:29: Quiet 2 hielt 16–17 Hz bei 12–13 °C trotz 1,75–3,25 K Rücklauf-Rückstand'},
        {q: 1, hz: 21, text: 'Messung 13.10. 16:36–17:04: Quiet 1 bis 20–21 Hz bei 12 °C (28 min; Untergrenze, höher nicht beobachtet)'}
    ];
    function deckelTab(q, at) { for (var i = 0; i < DECKEL.length; i++) { var x = DECKEL[i]; if (x.q === q && (!have(x.atUnter) || (have(at) && at < x.atUnter))) { return x; } } return null; }
    function kombOf(d, q) {                                                         // Daten der Takt-Messung je Heizregelung x Quiet x Aussenband: Minuten, COP, gehaltene Hoechstfrequenz
        var band = have(d.at) ? bandOf(d.at) : null, mod = modusOf(d.hc), a = (band !== null && mod !== '?' && d.copSum) ? d.copSum[mod + '|' + q + '|' + band] : null;
        return a ? {q: q, min: a[2], cop: a[0] > 0 ? a[1] / a[0] : null, hzMax: have(a[4]) ? a[4] : null, held: have(a[5]) ? a[5] : null, band: band, mod: mod} : {q: q, min: 0, cop: null, hzMax: null, held: null, band: band, mod: mod};
    }
    function deckelOf(d, q) {                                                       // wirksamer Deckel der Stufe q bei der jetzigen Aussentemperatur und Heizregelung
        if (!have(q)) { return {hz: null, quelle: '', text: ''}; }
        if (q === 0) { return {hz: 59, quelle: 'Nutzer', text: 'Verdichterbereich 16–59 Hz (Nutzer 10.10.)'}; }
        var tb = deckelTab(q, d.at), k = kombOf(d, q), tc = d.tc || taktCfg(null), lern = k.min >= tc.copMinMin && have(k.held) ? k.held : null;
        if (lern !== null && (!tb || lern > tb.hz)) { return {hz: lern, quelle: 'gelernt', text: 'gelernt: ' + de(lern, 0) + ' Hz gehalten (' + k.mod + ', ' + k.band + ' °C, ' + Math.round(k.min) + ' min)'}; }
        return tb ? {hz: tb.hz, quelle: 'Messung', text: tb.text} : {hz: null, quelle: '', text: 'Deckel unbekannt'};
    }
    // Zielstufe der Quiet-Freigabe: die naechste niedrigere Stufe mit Messdaten (copMinMin je Heizregelung x Quiet x Band, Nutzerentscheidung), deren Deckel mindestens
    // mehrHz ueber dem jetzigen liegt; eine tiefere nur, wenn ihr COP um mehr als copTol besser ist. Heizstab-Naehe: Quiet 0. Sonst Rueckfall Quiet 0 (Werkszustand).
    // Laermgrenze nachts (Parameter, Standard aus): tiefste erlaubte Stufe in der Nacht oder null
    function nachtMin(d, c) {
        if (!have(c.nachtQuietMin) || c.nachtQuietMin < 0) { return null; }
        var h = new Date(d.now).getHours(), vh = c.nachtVonH, bh = c.nachtBisH;
        return (vh > bh ? (h >= vh || h < bh) : (h >= vh && h < bh)) ? c.nachtQuietMin : null;
    }
    // Zielstufe der Freigabe (Bedarf): die naechste niedrigere Stufe, deren Deckel genug Mehrleistung zulaesst (mehrHz) - mit 60 min Daten (Nutzerentscheidung) oder,
    // ohne Daten, nach der Messtabelle DECKEL (ohneDatenSchrittweise, vorlaeufig); ein Notfall ohne Daten und die Heizstab-Naehe gehen direkt auf Quiet 0.
    // Eine tiefere Stufe mit Daten nur, wenn ihr COP um mehr als copTol besser ist. Nachts nicht unter nachtQuietMin (ausser Heizstab-Naehe).
    function zielFrei(d, c, B) {
        var tc = d.tc || taktCfg(null), cur = deckelOf(d, d.q), need = have(cur.hz) ? cur.hz + c.mehrHz : null, o = {ziel: 0, warum: '', kand: [], cur: cur}, nm = nachtMin(d, c);
        if (B && B.heizstab) { o.warum = 'Heizstab-Nähe: volle Leistung'; return o; }
        var ok = [], gr = [], first = null, notfall = !!(B && B.notfall), stufen = c.ohneDatenSchrittweise === 1 && !notfall;
        for (var z = d.q - 1; z >= 1; z--) {
            if (nm !== null && z < nm) { gr.push('Quiet ' + z + ': nachts nicht unter Quiet ' + nm); continue; }
            var k = kombOf(d, z), cz = deckelOf(d, z);
            if (k.min < tc.copMinMin) {
                gr.push('Quiet ' + z + ': ' + Math.round(k.min) + ' von ' + tc.copMinMin + ' min Daten');
                var tb = deckelTab(z, d.at);
                if (stufen && !first && tb && have(need) && tb.hz >= need) { first = {q: z, deckel: tb.hz, min: k.min, cop: null, quelle: 'Messtabelle'}; }
            }
            else if (!have(cz.hz) || !have(need) || cz.hz < need) { gr.push('Quiet ' + z + ' deckelt bei ' + de(cz.hz, 0) + ' Hz (nötig ≥ ' + de(need, 0) + ' Hz)'); }
            else { k.deckel = cz.hz; k.quelle = 'Daten'; ok.push(k); if (!first) { first = k; } }
            o.kand.push({z: z, min: k.min, deckel: cz.hz});
        }
        if (!first) {
            if (nm !== null && nm > 0) { o.ziel = null; o.warum = 'nachts nicht unter Quiet ' + nm + (gr.length ? ' (' + gr.join('; ') + ')' : ''); return o; }
            o.warum = notfall && c.ohneDatenSchrittweise === 1 ? 'Quiet 0, Notfall (' + (B.raum ? B.raum.name + ' ' + de(B.raum.min - B.raum.t, 1) + ' K unter Minimum' : 'Komfort') + ')' + (gr.length ? '; ' + gr.join('; ') : '')
                                                               : (gr.length ? 'Quiet 0, weil ' + gr.join('; ') : 'Quiet 0');
            return o;
        }
        var best = first;
        if (first.quelle === 'Daten') { ok.forEach(function (k) { if (k !== first && have(k.cop) && have(best.cop) && k.cop > best.cop * (1 + c.copTol)) { best = k; } }); }
        o.ziel = best.q;
        o.warum = 'Quiet ' + best.q + ' deckelt bei ' + de(best.deckel, 0) + ' Hz (' + (best.quelle === 'Messtabelle' ? 'Messtabelle, ' + Math.round(best.min) + ' von ' + tc.copMinMin + ' min Daten' : Math.round(best.min) + ' min Daten' + (have(best.cop) ? ', COP ' + de(best.cop, 2) : '')) + ')';
        return o;
    }
    // Kaelte-Vorsorge (Regel-Review B4, vorlaeufig): unter kaltC (gemessen oder in der Vorhersage der naechsten vorsorgeH h) keine Stufe mit hartem Deckel (<= hartHz).
    // Der Deckel gilt bei der kaelteren der beiden Temperaturen. halten: Kaelte (unter kaltC + 1 K oder Vorhersage) haelt eine Freigabe aus einer harten Stufe.
    function kaltQ(d, c) {
        var o = {ja: false, kalt: false, halten: false, txt: '', cap: null, at: null};
        var fc = null, vs = d.vs && Array.isArray(d.vs.at) ? d.vs.at : [];
        for (var h = 1; h <= c.vorsorgeH && h < vs.length; h++) { if (have(num(vs[h])) && (fc === null || num(vs[h]) < fc)) { fc = num(vs[h]); } }
        var jetzt = have(d.at) && d.at < c.kaltC, vor = have(fc) && fc < c.kaltC;
        o.at = have(fc) && (!have(d.at) || fc < d.at) ? fc : d.at;
        o.kalt = jetzt || vor;
        o.halten = vor || (have(d.at) && d.at < c.kaltC + 1);
        o.txt = jetzt ? 'Außen ' + de(d.at, 0) + ' °C (unter ' + c.kaltC + ' °C)' : (vor ? 'Vorhersage ' + de(fc, 1) + ' °C in den nächsten ' + c.vorsorgeH + ' h (unter ' + c.kaltC + ' °C)' : '');
        if (have(d.q) && d.q >= 1 && o.kalt) { o.cap = deckelOf(kaltD(d, o.at), d.q).hz; o.ja = have(o.cap) && o.cap <= c.hartHz; }
        return o;
    }
    function kaltD(d, at) { var x = Object.create(d); x.at = at; return x; }
    function zielKalt(d, c, K) {                                                     // naechste niedrigere Stufe ohne harten Deckel (Daten oder Messtabelle; Quiet 0 immer)
        var dk = kaltD(d, K.at), nm = nachtMin(d, c);
        for (var z = d.q - 1; z >= 0; z--) {
            if (nm !== null && z < nm) { break; }
            var cz = deckelOf(dk, z);
            if (have(cz.hz) && cz.hz > c.hartHz) { return {ziel: z, deckel: cz.hz, quelle: z === 0 ? 'ohne Deckel' : cz.quelle, warum: 'Quiet ' + z + (z === 0 ? ' (ohne Deckel)' : ' deckelt bei ' + de(cz.hz, 0) + ' Hz (' + cz.quelle + ', ' + de(K.at, 0) + ' °C)')}; }
        }
        return {ziel: null, deckel: null, quelle: '', warum: nm !== null ? 'nachts nicht unter Quiet ' + nm : 'keine Stufe ohne harten Deckel'};
    }
    // Zielstufe des Effizienz-Deckels: die niedrigste hoehere Stufe mit Messdaten (copMinMin), deren Deckel unter hzHoch liegt (nachweislich deckelt) und deren COP
    // hoechstens copTol unter der jetzigen Stufe liegt (nur wenn beide Daten haben). Ohne Daten kein Vorschlag.
    function zielDeckel(d, c) {
        var tc = d.tc || taktCfg(null), band = have(d.at) ? bandOf(d.at) : null, mod = modusOf(d.hc), o = {band: band, mod: mod, cur: null, kand: [], ziel: null, warum: ''};
        if (!have(d.q) || band === null) { o.warum = 'Außentemperatur oder Quiet-Stufe unbekannt'; return o; }
        if (mod === '?') { o.warum = 'Heizregelung unbekannt (keine Daten je Modus)'; return o; }
        var cur = kombOf(d, d.q), gr = []; o.cur = cur;
        for (var z = d.q + 1; z <= 3 && !o.ziel; z++) {
            var k = kombOf(d, z), cz = deckelOf(d, z);
            if (k.min < tc.copMinMin) { k.warum = 'Quiet ' + z + ': ' + Math.round(k.min) + ' von ' + tc.copMinMin + ' min Daten'; }
            else if (!have(cz.hz) || cz.hz >= c.hzHoch) { k.warum = 'Quiet ' + z + ' deckelt nicht (bis ' + de(cz.hz, 0) + ' Hz)'; }
            else if (have(k.cop) && have(cur.cop) && cur.min >= tc.copMinMin && k.cop < cur.cop * (1 - c.copTol)) { k.warum = 'Quiet ' + z + ' COP ' + de(k.cop, 2) + ' statt ' + de(cur.cop, 2) + ' (mehr als ' + de(c.copTol * 100, 0) + ' % schlechter)'; }
            else { k.deckel = cz.hz; o.ziel = k; }
            o.kand.push(k); if (!o.ziel) { gr.push(k.warum); }
        }
        if (!o.ziel) { o.warum = 'keine Zielstufe aus den Daten (' + mod + ', ' + band + ' °C): ' + gr.join('; '); }
        return o;
    }
    // +1 K gegen Takt: Nutzen (vermiedene Starts) gegen Kosten (hoeherer Vorlauf) je Tag, aus dem letzten Zyklus (Lauf + Pause). Annahmen siehe Schwellen von "Deckel/Laufzeit".
    function nutzenKurve(d, c) {
        var L = d.lastRunMin, P = d.lastPauseMin;
        if (!have(L) || !have(P) || L + P <= 0) { return {ok: false, txt: 'letzter Zyklus unbekannt'}; }
        var zyk = L + P, gew = c.laufPlusMin - c.pauseMinusMin, sTag = 1440 / zyk, red = gew > 0 ? gew / (zyk + gew) : 0;
        var nutzen = sTag * red * c.startWh, kosten = c.kurveWK * (L / zyk) * 24;
        return {ok: nutzen >= kosten, nutzen: Math.round(nutzen), kosten: Math.round(kosten), starts: r2(sTag), red: r2(red),
                txt: 'Zyklus ' + de(L, 0) + ' + ' + de(P, 0) + ' min: Nutzen ~' + Math.round(nutzen) + ' Wh/Tag (' + de(sTag * red, 1) + ' Starts weniger) gegen Kosten ~' + Math.round(kosten) + ' Wh/Tag'};
    }
    // ------------------------------------------------------------------ Regelwerk als Daten. Jede Schwelle: Standard, Einheit, Herkunft (Messung / Nutzerregel / ANNAHME)
    var RULES = [
        {
            id: 'quiet_freigabe', ver: 2, kachel: 'Quiet-Freigabe', kurz: 'Quiet-Freigabe', name: 'Quiet-Freigabe (Leistung freigeben)', art: 'befehl', groesse: 'quiet', richtung: 'mehr_leistung', prio: 1, basis: 'quiet_freigabe|v2',
            zweck: 'Hält der Quiet-Deckel den Verdichter fest, obwohl ein echter Bedarf besteht (Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Boost von Hand), wird die Leistung freigegeben: auf die nächste Stufe, deren Deckel genug Mehrleistung zulässt (Daten je Heizregelung × Quiet × Außenband), bei Heizstab-Nähe und ohne Daten auf Quiet 0. Ein Vorlauf unter Soll allein ist kein Bedarf (v1 löste auch bei „Sollvorlauf in diesem Lauf noch nicht erreicht“ aus, also bei jedem langsamen Anlauf). Zurück auf die vorherige Stufe, sobald der Bedarf gedeckt ist.',
            eingaenge: ['Quiet-Stufe', 'Verdichterfrequenz und Deckel je Stufe (Messung, Takt-Messung)', 'Soll-/Ist-Vorlauf', 'Rücklauf und Ziel-Spreizung (Heat_Delta)', 'Laufzeit', 'Räume (gültig, eigenes Band, Verlauf)', 'Heizstab (Heater_On_Outdoor_Temp, Heater_Start_Delta)', 'Soll von Hand gegen Heizkurve', 'Daten je Heizregelung × Quiet × Außenband (Takt-Messung)'],
            sperren: ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt'],
            befehl: {name: 'SetQuietMode', topic: 'panasonic_heat_pump/commands/SetQuietMode'},
            schwellen: [
                {key: 'laufMin', std: 15, einheit: 'min', herkunft: 'Startroutine: Pumpenspitze 11–16 min nach jedem Start; Kaltstarts haben 15–25 min lang naturgemäß Rückstand (gilt für Raum-Bedarf und Boost)'},
                {key: 'heizstabVorlaufMin', std: 5, einheit: 'min', herkunft: 'Heizstab-Nähe: der Heizstab startet nach Heater_Delay_Time (hier 15 min, Servicehandbuch J Z. 9316–9322) Thermo-EIN unter Soll −3 K. Die Startphase endet Heater_Delay_Time − 5 min − Haltezeit, der Vorschlag kommt also 5 min vor der Heizstab-Freigabe (Regel-Review B4: Laufminute 13 war zu spät); ohne gemeldete Heater_Delay_Time 15 min; ANNAHME'},
                {key: 'heizstabAbstandK', std: 0.5, einheit: 'K', herkunft: 'Heizstab-Nähe in der Startphase: Vorlauf mindestens |Heater_Start_Delta| − 0,5 K (hier 2,5 K) unter Soll bei Außentemperatur unter Heater_On_Outdoor_Temp + 2 K (Regel-Review QF-6); ANNAHME'},
                {key: 'heizstabDauerK', std: 1.0, einheit: 'K', herkunft: 'Heizstab-Nähe im Dauerlauf (Lauf länger als Heater_Delay_Time): der Heizstab hat dann keine Verzögerung mehr, und ein natürlicher Sollsprung +1 K hebt den Rückstand in einem 5-min-Schritt um 1 K (Regel-Review B4) → Abstand 1,0 K (Vorlauf ab 2,0 K unter Soll); ANNAHME'},
                {key: 'vlRueckK', std: 1.5, einheit: 'K', herkunft: 'Auftrag/Wächter (escCapDevK 1,5); 13.10. 16:36 half die Freigabe bei 2,5–3 K'},
                {key: 'rlRueckK', std: 1.5, einheit: 'K', herkunft: 'Messung: die Freigabe wirkt nur mit Rücklauf-Rückstand: 10.10. 11:17 ≤ 0,25 K keine Reaktion; 13.10. 16:36 Quiet 2 → 1 bei 1,75 K: 17 → 20–21 Hz in 2 min; Boost 2,5–6,75 K: 33–34 Hz. Quiet 0 lief 07.–13.10. bei 1,5–2,5 K nur in 20–39 % der Minuten über 20 Hz, ab 2,5 K immer; 1,5 K bleibt ANNAHME'},
                {key: 'mehrHz', std: 3, einheit: 'Hz', herkunft: 'Zielstufe: ihr Deckel muss mindestens 3 Hz über dem jetzigen liegen, sonst bringt sie keine Leistung (Messung 13.10. 16:36: 17 → 20–21 Hz = +80–100 W el, ≈ +0,4 kW th); Quiet 2 deckelt bei Mildwetter wie Quiet 3 (16–17 Hz). Vorher 4 Hz: dann fiel Quiet 2 (21 Hz) gegen den gelernten Quiet-3-Deckel 18 Hz bei 3…7 °C aus (Regel-Review QF-3/R1)'},
                {key: 'trendKh', std: 0.2, einheit: 'K/h', herkunft: 'Raum fällt: Regression über den Verlauf der letzten 2 h im Lauf (5-min-Raster, letzte Meldung gilt weiter) mindestens 0,2 K/h abwärts, und der Raum steigt in den letzten 30 min nicht (Shelly Gen3 melden erst ab 0,5 K: 0,5 K in 2,5 h; Regel-Review B3: vorher Endpunkt gegen Endpunkt); ANNAHME'},
                {key: 'lueftungK', std: 1.0, einheit: 'K', herkunft: 'Raumtrend: fällt ein Raum um 1 K oder mehr binnen 60 min, ist das Lüften (wie der Lüftungsverdacht der Bewertung); der Verlauf zählt erst ab dem Ende des Sturzes (Regel-Review B3: 08.10. 18:33 Wohnzimmer „−6,9 K/h, Minimum in 5 min“)'},
                {key: 'prognoseMin', std: 120, einheit: 'min', herkunft: 'Prognose: Raum erreicht beim jetzigen Gefälle binnen 2 h das Minimum (Wirkzeit Raum noch nicht gemessen); ANNAHME'},
                {key: 'haltMin', std: 10, einheit: 'min', herkunft: 'Auftrag/Wächter (escCapMin 10): Bedingungen 10 min am Stück nach der Startphase'},
                {key: 'haltHeizstabMin', std: 3, einheit: 'min', herkunft: 'Heizstab-Nähe: kurze Haltezeit (Heater_Delay_Time 15 min); ANNAHME'},
                {key: 'rueckRlK', std: 0.5, einheit: 'K', herkunft: 'Rückweg: Bedarf gedeckt, wenn alle Räume mindestens notK 0,3 K über Minimum liegen, kein Bedarf mehr besteht und der Rücklauf höchstens 0,5 K unter Soll ist, 15 min am Stück (Quiet 0 lief 07.–13.10. bei ≤ 0,5 K Rückstand meist am Minimum); ANNAHME'},
                {key: 'rueckRaumMin', std: 15, einheit: 'min', herkunft: 'Rückweg, wenn ein Bedarfsraum dieser Freigabe 15 min am Stück über seinem Maximum liegt. Andere Räume über Maximum zählen nicht: das Wohnzimmer lag 29–74 % der Zeit über Maximum (Wärmeverteilung), der Rückweg pendelte (Regel-Review B2, Szenario D)'},
                {key: 'kaltC', std: 2, einheit: '°C', herkunft: 'Kälte-Vorsorge (vorläufig): unter 2 °C, gemessen oder in der Vorhersage der nächsten vorsorgeH Stunden, keine Stufe mit hartem Deckel. Nutzererfahrung 07.10. „bei 1–3 °C muss Quiet aus sein“; Regel-Review B4: vorbeugen statt nachträglich freigeben (der Heizstab ist im Dauerlauf ohne Verzögerung frei)'},
                {key: 'hartHz', std: 17, einheit: 'Hz', herkunft: 'harter Deckel: die Stufe hält höchstens 17 Hz (Quiet 3 immer, Quiet 2 ab 7 °C; Messung 07.–13.10.)'},
                {key: 'vorsorgeH', std: 6, einheit: 'h', herkunft: 'Kälte-Vorsorge: OWM-Vorhersage der nächsten 6 h (am Messwert verankert), damit der Vorschlag am Abend kommt und nicht erst in der Nacht, in der niemand klickt (Regel-Review B4); ANNAHME'},
                {key: 'boostBedarf', std: 1, einheit: 'ja/nein', herkunft: 'Boost von Hand (Soll über der Heizkurve) zählt als Bedarf: 1 = ja (Nutzer vorläufig, 13.10.)'},
                {key: 'ohneDatenSchrittweise', std: 1, einheit: 'ja/nein', herkunft: 'ohne 60 min Daten einer tieferen Stufe: 1 = schrittweise nach der Messtabelle DECKEL, ein Notfall (Heizstab-Nähe, Raum ≥ 0,3 K unter Minimum) direkt Quiet 0; 0 = immer Quiet 0 (Nutzer vorläufig, 13.10.)'},
                {key: 'nachtQuietMin', std: -1, einheit: 'Stufe', herkunft: 'Lärmgrenze nachts: die Freigabe geht nachts nicht unter diese Stufe (außer bei Heizstab-Nähe); −1 = aus (Nutzer vorläufig, 13.10.: keine Lärmgrenze)'},
                {key: 'nachtVonH', std: 22, einheit: 'Uhr', herkunft: 'Beginn der Nacht für nachtQuietMin; ANNAHME'},
                {key: 'nachtBisH', std: 6, einheit: 'Uhr', herkunft: 'Ende der Nacht für nachtQuietMin; ANNAHME'},
                {key: 'copTol', std: 0.10, einheit: 'Anteil', herkunft: 'eine tiefere Stufe statt der nächsten nur mit mehr als 10 % besserem COP: Pth ist Durchfluss × ΔT mit 0,25-K-Schritten (±10 %), bei gleicher Frequenz unterscheiden sich Quiet 0 und 3 um −9…+5 % (Tag, Feuchte, Vorlauf), Regel-Review LS-4/QF-8; Mindestdaten je Kombination copMinMin (Nutzerentscheidung 13.10.2026)'},
                {key: 'proTag', std: 3, einheit: 'Vorschläge', herkunft: 'Schreibbudget; ANNAHME'},
                {key: 'gueltigMin', std: 30, einheit: 'min', herkunft: 'Quiet wirkt in 1–2 min; nach 30 min ist die Lage eine andere (ANNAHME)'},
                {key: 'pauseMin', std: 60, einheit: 'min', herkunft: 'wie Mindestabstand (ANNAHME)'},
                {key: 'maxDauerMin', std: 240, einheit: 'min', herkunft: 'Rückweg spätestens nach 4 h, aber nicht, solange der Bedarf besteht (dann hält die Freigabe); ANNAHME'}
            ],
            erwartung: 'Ziel Quiet 0: Verdichter ≥ 25 Hz binnen 5 min, elektrische Leistung +350 bis +650 W, Vorlauf +2 K in 30 min (gemessen 10.10.2026 08:41, Efficiency, 11–12 °C). Ziel Quiet 1 oder 2: Verdichter mindestens 3 Hz über dem alten Deckel binnen 10 min, +60 W oder mehr (gemessen 13.10. 16:36 Quiet 2 → 1: 17 → 20–21 Hz, +80–100 W bei 12 °C). Nicht gemessen: Kälte, Abtauen',
            rueckweg: 'Automatisch zurück auf die Ausgangsstufe, sobald der Bedarf 15 min am Stück gedeckt ist (alle Räume ≥ Minimum + 0,3 K, Rücklauf höchstens 0,5 K unter Soll) oder ein Bedarfsraum 15 min über seinem Maximum liegt; spätestens nach 4 h, solange weder Bedarf noch Kälte-Vorsorge besteht; höchstens 3 Sendeversuche.',
            prognose: {p: 0.8, h: [30, 60, 120], text: 'Ohne Freigabe bleibt der Verdichter am Deckel und der Rücklauf-Rückstand ≥ 1 K'},
            kalibriert: ['2026-10-10 08:40', '2026-10-08 22:54', '2026-10-10 11:17', '2026-10-13 16:36'],
            eval: function (d, c) {
                if (!have(d.q)) { return {inaktiv: 'Quiet-Stufe unbekannt'}; }
                if (d.q === 0) { return {inaktiv: 'Quiet steht auf 0'}; }
                var B = d.bedQ, K = d.kaltQ || {}, cap = deckelOf(d, d.q);
                if (K.ja && !(B.notfall && d.running)) {                                   // Kaelte-Vorsorge (vor dem Bedarf, auch in der Pause): kein harter Deckel unter kaltC; ein Notfall im Lauf geht ueber den Bedarf
                    var zk = zielKalt(d, c, K);
                    return {cond: [{k: 'kalt', kz: 'Kälte', t: 'Kälte: ' + K.txt + ', Quiet ' + d.q + ' deckelt hart (' + de(K.cap, 0) + ' Hz)', ok: true},
                                   {k: 'ziel', kz: 'Zielstufe', t: 'Zielstufe ohne harten Deckel: ' + zk.warum, tn: 'keine Zielstufe: ' + zk.warum, ok: have(zk.ziel) && zk.ziel < d.q}],
                            halt: c.haltMin, wert: zk.ziel, von: d.q, hart: !!B.notfall, groesse: 'quiet', maxDauerMin: c.maxDauerMin, modus: 'kalt',
                            erwartung: 'kein harter Deckel in der Kälte: Quiet ' + zk.ziel + ' lässt bis ' + de(zk.deckel, 0) + ' Hz zu (' + zk.quelle + '); der Verdichter holt nach einem Neustart auf, bevor der Heizstab frei wird (Heater_Delay_Time ' + de(d.htrDelay, 0) + ' min)',
                            was: 'Quiet-Stufe ' + d.q + ' → ' + zk.ziel + ' (Kälte-Vorsorge)',
                            warum: 'Kälte: ' + K.txt + '; Quiet ' + d.q + ' deckelt bei ' + de(K.cap, 0) + ' Hz (höchstens ' + c.hartHz + ' Hz = harter Deckel); Ziel: ' + zk.warum};
                }
                var zl = zielFrei(d, c, B), lm = B.heizstab ? Math.max(3, d.htrDelay - c.heizstabVorlaufMin - c.haltHeizstabMin) : c.laufMin;
                var cond = [
                    {k: 'lauf', kz: 'Verdichter läuft', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running},
                    {k: 'laufMin', kz: 'Laufzeit', t: 'Lauf seit mindestens ' + lm + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + lm + ' min', ok: d.runMin >= lm, ist: r2(d.runMin), soll: lm, op: '>=', u: 'min', dyn: true},
                    {k: 'bedarf', kz: 'Bedarf', t: B.ja ? 'Bedarf: ' + B.txt : 'Bedarf (Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Boost von Hand)', tn: 'kein Bedarf: ' + B.keinTxt, ok: B.ja},
                    {k: 'deckel', kz: 'Frequenz', t: 'Verdichter am Deckel von Quiet ' + d.q + ' (' + de(cap.hz, 0) + ' Hz)', tn: 'Verdichter nicht am Deckel (' + de(d.hz, 0) + ' Hz, Deckel Quiet ' + d.q + ': ' + de(cap.hz, 0) + ' Hz)', ok: have(d.hz) && d.hz > 0 && have(cap.hz) && d.hz >= cap.hz - 1, ist: d.hz, soll: have(cap.hz) ? cap.hz - 1 : null, op: '>=', u: 'Hz', dyn: true},
                    {k: 'vlRueck', kz: 'Vorlauf-Rückstand', t: 'Vorlauf mindestens ' + de(c.vlRueckK, 1) + ' K unter Soll', tn: 'Vorlauf ' + rueckTxt(d.vlRueck) + ' (Schwelle ' + de(c.vlRueckK, 1) + ' K darunter)', ok: have(d.vlRueck) && d.vlRueck >= c.vlRueckK, ist: r2(d.vlRueck), it: rueckTxt(d.vlRueck), soll: c.vlRueckK, op: '>=', u: 'K', dyn: true},
                    {k: 'rlRueck', kz: 'Rücklauf-Rückstand', t: 'Rücklauf mindestens ' + de(c.rlRueckK, 1) + ' K unter Soll-Rücklauf', tn: 'Rücklauf ' + rueckTxt(d.rlRueck) + ' (Schwelle ' + de(c.rlRueckK, 1) + ' K darunter)', ok: have(d.rlRueck) && d.rlRueck >= c.rlRueckK, ist: r2(d.rlRueck), it: rueckTxt(d.rlRueck), soll: c.rlRueckK, op: '>=', u: 'K', dyn: true}
                ];
                cond.push({k: 'ziel', kz: 'Zielstufe', t: 'Zielstufe: ' + zl.warum, tn: 'keine Zielstufe: ' + zl.warum, ok: have(zl.ziel) && zl.ziel < d.q});
                return {cond: cond, halt: B.heizstab ? c.haltHeizstabMin : c.haltMin, wert: zl.ziel, von: d.q, hart: B.notfall, startMin: lm, groesse: 'quiet', maxDauerMin: c.maxDauerMin,
                        erwartung: zl.ziel === 0 ? 'Verdichter ≥ 25 Hz binnen 5 min, elektrische Leistung +350 bis +650 W, Vorlauf +2 K in 30 min (gemessen 10.10.2026 08:41, Efficiency, 11–12 °C: 29 Hz nach 1 min, 34 Hz nach 2 min, +490–590 W, Vorlauf +4 K in 20 min; nicht gemessen: Kälte, Abtauen)'
                                                 : 'Verdichter mindestens ' + de(have(cap.hz) ? cap.hz + 3 : null, 0) + ' Hz binnen 10 min (3 Hz über dem Deckel von Quiet ' + d.q + '), elektrische Leistung +60 W oder mehr (gemessen 13.10. 16:36 Quiet 2 → 1: 17 → 20–21 Hz, +80–100 W bei 12 °C)',
                        was: 'Quiet-Stufe ' + d.q + ' → ' + zl.ziel,
                        warum: 'Verdichter ' + de(d.hz, 0) + ' Hz am Deckel von Quiet ' + d.q + ', Vorlauf ' + de(d.vlRueck, 1) + ' K und Rücklauf ' + de(d.rlRueck, 1) + ' K unter Soll, Lauf ' + de(d.runMin, 0) + ' min; Bedarf: ' + B.txt + '; Ziel: ' + zl.warum};
            }
        },
        {
            id: 'quiet_strecken', ver: 4, kachel: 'Deckel/Laufzeit', kurz: 'Deckel/Laufzeit', name: 'Effizienz-Deckel und Laufzeit (Quiet höher oder Heizkurve +1 K)', art: 'befehl', groesse: 'quiet', richtung: 'weniger_leistung', prio: 2,
            basis: 'quiet_strecken|v4', basisKurve: 'quiet_strecken|v4|kurve',
            zweck: 'Zwei Hebel, gewählt nach Lage. Quiet höher (Effizienz-Deckel): läuft der Verdichter ohne Bedarf mit 22 Hz oder mehr (vor allem in den ersten 3 h eines Laufs bei Mildwetter), deckelt die niedrigste Stufe, die laut Messdaten unter 22 Hz hält; das spart Strom (Quiet 0, gleiches Außenband, ab Laufminute 15: COP bei 22–27 Hz 3–8 %, ab 28 Hz 10–14 % unter 16–17 Hz) und verlängert den Lauf, mit oder ohne Takt. Quiet senkt am Minimum außerdem den Lüfter (−60…−110 U/min, −10…−16 W; ein COP-Unterschied ist dort nicht messbar). Heizkurve +1 K (Laufzeit): läuft der Verdichter schon unter 22 Hz und ist Takt belegt, hilft Quiet nicht; +1 K hebt Abschalt- und Startschwelle (längere Läufe, kürzere Pausen) und kostet Strom, deshalb nur, wenn der geschätzte Nutzen (vermiedene Starts) die Kosten übersteigt. Beide Hebel nie gleichzeitig aus einem Vorschlag.',
            eingaenge: ['Quiet-Stufe', 'Heizregelung', 'Verdichterfrequenz', 'Rücklauf-Rückstand', 'Räume (Bedarf, Verlauf, Luft im Band)', 'Außentemperatur', 'letzte Läufe (Dauer, Stopp-Art), Pausen, Starts', 'Daten je Heizregelung × Quiet × Außenband (Takt-Messung: Minuten, COP, gehaltener Deckel)', 'Verschiebung der Anlage (TOP27) und Eigentümer (Arbitrierung)'],
            sperren: ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'heizstab'],
            befehl: {name: 'SetQuietMode', topic: 'panasonic_heat_pump/commands/SetQuietMode'},
            hebel: {quiet: {name: 'SetQuietMode', topic: 'panasonic_heat_pump/commands/SetQuietMode'}, shift: {name: 'SetZ1HeatRequestTemperature', topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature'}},
            schwellen: [
                {key: 'hzHoch', std: 22, einheit: 'Hz', herkunft: 'Messung 07.–13.10. (Quiet 0, gleiches Außenband, ab Laufminute 15): COP bei 22–27 Hz 3–8 %, ab 28 Hz 10–14 % unter 16–17 Hz, bei 18–21 Hz 1–5 % (im Rauschen); Quiet 0 lag in 14–25 % der Laufminuten über 20 Hz (unter 3 °C nie). Eine Zielstufe deckelt, wenn ihr Deckel (Messung oder gelernt) darunter liegt'},
                {key: 'laufMin', std: 15, einheit: 'min', herkunft: 'Startroutine (siehe Quiet-Freigabe)'},
                {key: 'rlRueckMaxK', std: 1.0, einheit: 'K', herkunft: 'kein Bedarf: Rücklauf höchstens 1 K unter Soll (ANNAHME, vgl. Quiet-Freigabe 1,5 K)'},
                {key: 'komfortK', std: 0.3, einheit: 'K', herkunft: 'Komfort sicher: jeder Raum mit Wert (bis 6 h alt) mindestens 0,3 K über Minimum (wie notK); ANNAHME'},
                {key: 'ruheMin', std: 120, einheit: 'min', herkunft: 'kein Deckel binnen 2 h nach einem Bedarf der Quiet-Freigabe (Raumwerte kommen alle 1–2 h; verhindert Hin und Her mit der Freigabe); ANNAHME'},
                {key: 'atMinC', std: 3, einheit: '°C', herkunft: 'Quiet höher nur über 3 °C: Nutzererfahrung 07.10. „bei 1–3 °C muss Quiet aus sein“; Messung: unter 3 °C lief Quiet 0 nie über 20 Hz (0 von 274 Laufminuten), dort gäbe es nichts zu deckeln'},
                {key: 'kurzerLaufMin', std: 60, einheit: 'min', herkunft: 'Takt belegt: letzter Lauf mit Abschaltung über den Vorlauf kürzer als 60 min (Opus: Mindestlauf 60 min). 07.–13.10.: 24 abgeschlossene Läufe, 20 Abschaltungen über den Vorlauf mit 97–970 min, keine unter 60 min'},
                {key: 'thermoStoppK', std: 2.75, einheit: 'K', herkunft: 'Stopp-Art: der Lauf endete mit Vorlauf ≥ Soll +2,75 K = Abschaltung über den Vorlauf (gemessen +3,0…+3,25 K bei 20 von 20; Handbuch: Vorlauf − interner Soll > 2 K für 3 min). Läufe, die an der Heizgrenze oder nach einem Sollsprung nach unten enden, sind kein Takt'},
                {key: 'starts3h', std: 2, einheit: 'Starts', herkunft: 'Takt belegt: mindestens 2 Starts in 3 h (07.–13.10.: höchstens 1)'},
                {key: 'copTol', std: 0.10, einheit: 'Anteil', herkunft: 'Veto: Zielstufe höchstens 10 % COP unter der jetzigen (nur wenn beide copMinMin Minuten haben, Nutzerentscheidung 13.10.2026). Die Matrix zeigt bei gleicher Frequenz (16–17 Hz) zwischen Quiet 0 und 3 −9…+5 % (Tag, Feuchte, Vorlauf), bei Quiet-Wechseln im Lauf am Minimum −2…+6 %, Messunsicherheit Pth ±10 % (Regel-Review LS-4): deshalb nur Veto; gewählt wird die niedrigste deckelnde Stufe'},
                {key: 'laufPlusMin', std: 40, einheit: 'min', herkunft: '+1 K verlängert den Lauf um 1 K ÷ Vorlauf-Anstieg am Laufende (Median 1,5 K/h, 07.–12.10.) ≈ 40 min (20–60); nicht gemessen, Verzögerungstest steht aus; ANNAHME'},
                {key: 'pauseMinusMin', std: 18, einheit: 'min', herkunft: '+1 K hebt auch die Startschwelle: Pause kürzer um die Zeit von Soll −2,25 bis −3,25 K, Median 18 min (11–67 min, 07.–12.10.); ANNAHME'},
                {key: 'startWh', std: 15, einheit: 'Wh', herkunft: 'ein Start kostet 7–12 Wh (Review 09.10.) plus Pumpenspitze 4–10 Wh (2900 U/min für 11–16 min); ANNAHME'},
                {key: 'kurveWK', std: 8.5, einheit: 'W/K', herkunft: 'Strom +8,5 W je K Vorlauf während des Laufs (Strommodell 08.10.); Mehrwärme in die Räume nicht eingerechnet; ANNAHME'},
                {key: 'laufVlK', std: 1.0, einheit: 'K', herkunft: '+1 K im Lauf nur, wenn der Vorlauf schon mindestens 1,0 K über dem Soll liegt: dann steigt nur die Stoppschwelle; darunter löste +1 K bei Quiet 0 einen Hochlauf aus (11.10. 03:10: 16,5 → 22–23 Hz, +48 % Strom; Regel-Review Abschnitt 2). Vorher 0,5 K: bei +0,25 K nach einem natürlichen +1-K-Sprung lief Quiet 0 schon kurz auf 20 Hz (13.10. 02:20), +1 K wirkt erst im nächsten 5-min-Takt (Regel-Review R2)'},
                {key: 'pauseVlK', std: -2, einheit: 'K', herkunft: '+1 K in der Pause nur, wenn der Vorlauf über Soll −2 K liegt: läge er nach +1 K bei ≤ neuer Soll −3,25…−3,5 K, startete die Anlage sofort (10.10. 18:20, 11.10. 19:10; Regel-Review Abschnitt 2) und die Pause würde nur kürzer'},
                {key: 'haltMin', std: 10, einheit: 'min', herkunft: 'wie Quiet-Freigabe'},
                {key: 'proTag', std: 3, einheit: 'Vorschläge', herkunft: 'ANNAHME (v3: 2; ein Effizienz-Deckel je Lauf bei 3–5 Läufen am Tag)'},
                {key: 'gueltigMin', std: 30, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'pauseMin', std: 120, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'maxDauerMin', std: 480, einheit: 'min', herkunft: 'Quiet höher: Rückweg spätestens nach 8 h (≈ zwei Zyklen: Median Lauf 184 min, Pausen 57–158 min); früher bei Bedarf, Rücklauf-Rückstand oder ≤ 3 °C; ANNAHME'},
                {key: 'maxDauerKurveMin', std: 360, einheit: 'min', herkunft: '+1 K: Rückweg spätestens nach 6 h (wie Raumeinfluss und Vorausschau); früher bei Heizstab-Nähe, wenn ein Raum mehr als 0,3 K über die Bandmitte steigt oder der Takt ausbleibt; ANNAHME'},
                {key: 'kurveTaktZyklen', std: 2, einheit: 'Läufe', herkunft: '+1 K: Rückweg, wenn nach der Übernahme zwei Läufe ohne Takt-Beleg endeten (beide mindestens kurzerLaufMin lang; Regel-Review B5); ANNAHME'},
                {key: 'bedarfRlK', std: 2.5, einheit: 'K', herkunft: 'Rückweg Quiet: Rücklauf-Rückstand ≥ 2,5 K seit 15 min = Leistung wird gebraucht (Quiet 0 lief 07.–13.10. ab 2,5 K immer über 20 Hz)'}
            ],
            erwartung: 'Quiet höher: Verdichter ≤ 21 Hz binnen 10 min, elektrische Leistung −100 W oder mehr (nach Quiet-Wechseln nach oben fiel die Frequenz binnen 5–15 min, 08.10. 09:38, 12.10. 09:30); in diesen Minuten COP +3…+14 % (Schätzung aus den Frequenz-Klassen). Heizkurve +1 K: Soll-Vorlauf +1 K binnen 3 min; Lauf länger, Pause kürzer (Messaufgabe, nicht gemessen)',
            rueckweg: 'Quiet höher: automatisch zurück auf die vorherige Stufe bei Bedarf (Raum unter Minimum oder fallend, Heizstab-Nähe, Boost), bei Rücklauf-Rückstand ≥ 2,5 K seit 15 min, bei Außentemperatur ≤ 3 °C, spätestens nach 8 h. Heizkurve +1 K: zurück auf 0 K bei Heizstab-Nähe (Außen unter Heater_On_Outdoor_Temp + 2 K), wenn ein Raum mehr als 0,3 K über die Bandmitte steigt, wenn zwei Läufe ohne Takt endeten, spätestens nach 6 h.',
            prognose: {p: 0.7, h: [30], text: 'Ohne Deckel läuft der Verdichter weiter mit 22 Hz oder mehr'},
            prognoseKurve: {p: 0.7, h: [60], text: 'Ohne +1 K endet der Lauf binnen 60 min (kurzer Lauf)'},
            kalibriert: ['2026-10-08 09:38', '2026-10-12 09:30'],
            eval: function (d, c, rs) {
                if (!have(d.q)) { return {inaktiv: 'Quiet-Stufe unbekannt'}; }
                var takt = taktBeleg(d, c), hoch = have(d.hz) && d.hz >= c.hzHoch, taktTxt = [];
                var hebel = rs.prop && rs.prop.hebel ? rs.prop.hebel : ((hoch || !takt) ? 'quiet' : 'shift');
                if (rs.hebel !== hebel) { rs.hebel = hebel; rs.since = 0; }                   // Hebelwechsel: Haltezeit beginnt neu
                if (d.lastRunThermo && have(d.lastRunMin) && d.lastRunMin < c.kurzerLaufMin) { taktTxt.push('letzter Lauf nur ' + de(d.lastRunMin, 0) + ' min (Abschaltung über den Vorlauf)'); }
                if (d.starts3h >= c.starts3h) { taktTxt.push(d.starts3h + ' Starts in 3 h'); }
                var lr = have(d.lastRunMin) ? 'letzter Lauf ' + de(d.lastRunMin, 0) + ' min' + (d.lastRunThermo ? '' : ' (Ende ohne Abschaltung über den Vorlauf)') : 'kein Lauf bekannt';
                var cLauf = {k: 'lauf', kz: 'Verdichter läuft', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running};
                var cMin = {k: 'laufMin', kz: 'Laufzeit', t: 'Lauf seit mindestens ' + c.laufMin + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + c.laufMin + ' min', ok: d.runMin >= c.laufMin, ist: r2(d.runMin), soll: c.laufMin, op: '>=', u: 'min', dyn: true};
                if (hebel === 'quiet') {
                    if (d.q >= 3) { return {inaktiv: 'Quiet steht schon auf 3'}; }
                    var B = d.bedQ, zl = zielDeckel(d, c), z = zl.ziel, ks = komfortSicher(d, c), ruhe = !d.bedT || d.now - d.bedT >= c.ruheMin * MIN;
                    var cond = [cLauf, cMin,
                        {k: 'hoch', kz: 'Frequenz', t: 'Verdichter mit ' + c.hzHoch + ' Hz oder mehr', tn: 'Verdichter bei ' + de(d.hz, 0) + ' Hz (Schwelle ' + c.hzHoch + ' Hz)', ok: hoch, ist: d.hz, soll: c.hzHoch, op: '>=', u: 'Hz', dyn: true},
                        {k: 'keinBedarf', kz: 'kein Bedarf', t: 'kein Bedarf und Rücklauf höchstens ' + de(c.rlRueckMaxK, 1) + ' K unter Soll', tn: B.ja ? 'Bedarf: ' + B.txt : 'Bedarf: Rücklauf ' + rueckTxt(d.rlRueck), ok: !B.ja && have(d.rlRueck) && d.rlRueck <= c.rlRueckMaxK, ist: B.ja ? null : r2(d.rlRueck), soll: c.rlRueckMaxK, op: '<=', u: 'K', dyn: !B.ja},
                        {k: 'komfort', kz: 'Komfort sicher', t: 'alle Räume mindestens ' + de(c.komfortK, 1) + ' K über Minimum', tn: ks.txt, ok: ks.ok},
                        {k: 'ruhe', kz: 'Ruhe nach Bedarf', t: 'seit ' + c.ruheMin + ' min kein Bedarf', tn: 'Bedarf zuletzt ' + hhmm(d.bedT) + ' (Ruhe bis ' + hhmm(d.bedT + c.ruheMin * MIN) + ')', ok: ruhe},
                        {k: 'aussen', kz: 'Außentemperatur', t: 'Außentemperatur über ' + de(c.atMinC, 0) + ' °C', tn: 'Außentemperatur ' + de(d.at, 0) + ' °C (Quiet höher erst über ' + de(c.atMinC, 0) + ' °C)', ok: have(d.at) && d.at > c.atMinC, ist: d.at, soll: c.atMinC + 1, op: '>=', u: '°C', dyn: true},
                        {k: 'ziel', kz: 'Zielstufe', t: z ? 'Zielstufe aus den Daten: Quiet ' + z.q + ' (' + zl.mod + ', ' + zl.band + ' °C: Deckel ' + de(z.deckel, 0) + ' Hz, ' + de(z.min / 60, 1) + ' h Daten' + (have(z.cop) ? ', COP ' + de(z.cop, 2) : '') + ')' : 'Zielstufe aus den Daten', tn: zl.warum, ok: !!z}
                    ];
                    return {cond: cond, halt: c.haltMin, wert: z ? z.q : null, von: d.q, groesse: 'quiet', hebel: 'quiet', dir: 'weniger_leistung', maxDauerMin: c.maxDauerMin,
                            erwartung: 'Verdichter ≤ 21 Hz binnen 10 min, elektrische Leistung −100 W oder mehr (nach Quiet-Wechseln nach oben fiel die Frequenz binnen 5–15 min, 08.10. 09:38, 12.10. 09:30); in diesen Minuten COP +3…+14 % (Schätzung aus den Frequenz-Klassen 07.–13.10.)',
                            rueckweg: 'Automatisch zurück auf Quiet ' + d.q + ' bei Bedarf (Raum unter Minimum oder fallend, Heizstab-Nähe, Boost), bei Rücklauf-Rückstand ≥ ' + de(c.bedarfRlK, 1) + ' K seit 15 min, bei Außentemperatur ≤ ' + de(c.atMinC, 0) + ' °C, spätestens nach ' + de(c.maxDauerMin / 60, 0) + ' h.',
                            was: 'Quiet-Stufe ' + d.q + ' → ' + (z ? z.q : '–') + ' (Effizienz-Deckel)',
                            warum: 'Verdichter ' + de(d.hz, 0) + ' Hz ohne Bedarf (Rücklauf ' + rueckTxt(d.rlRueck) + ', alle Räume mindestens ' + de(c.komfortK, 1) + ' K über Minimum, Außen ' + de(d.at, 0) + ' °C)' + (taktTxt.length ? '; Takt: ' + taktTxt.join(', ') : '') + (z ? '; Quiet ' + z.q + ' deckelt bei ' + de(z.deckel, 0) + ' Hz (' + zl.mod + ', ' + zl.band + ' °C, ' + de(z.min / 60, 1) + ' h Daten)' : '')};
                }
                var NK = nutzenKurve(d, c), warm = null;                              // waermster Raum relativ zur Bandmitte (Regel-Review LS-5: +1 K ist sonst Gegenspieler zu Raumeinfluss −1 K)
                d.rooms.forEach(function (r) { if (r.active && r.valid && have(r.max) && have(r.min) && (warm === null || r.t - (r.min + r.max) / 2 > warm.t - (warm.min + warm.max) / 2)) { warm = r; } });
                var luft = warm ? (warm.min + warm.max) / 2 - warm.t : null, sollNeu = have(d.soll) ? d.soll + 1 : null, vlS = have(d.vl) && have(d.soll) ? d.vl - d.soll : null;
                // +1 K auch in der Pause (hebt die Startschwelle; bei Laeufen unter 25 min gaebe es im Lauf nach Startphase und Haltezeit keine Gelegenheit)
                var cond2 = [
                    {k: 'takt', kz: 'Takt belegt', t: 'Takt belegt (' + (taktTxt.join(', ') || 'kurzer Lauf oder viele Starts') + ')', tn: 'kein Takt belegt: ' + lr + ', ' + d.starts3h + ' Start' + (d.starts3h === 1 ? '' : 's') + ' in 3 h', ok: takt},
                    {k: 'minimum', kz: 'Frequenz', t: 'Verdichter unter ' + c.hzHoch + ' Hz oder in der Pause: Quiet deckelt nichts mehr', tn: 'Verdichter bei ' + de(d.hz, 0) + ' Hz: zuerst Quiet höher', ok: !hoch},
                    {k: 'verschiebung', kz: 'Verschiebung', t: 'Verschiebung steht auf 0 K', tn: 'Verschiebung steht auf ' + sg(d.shift, 0) + ' K', ok: d.shift === 0},
                    {k: 'luft', kz: 'Räume', t: 'kein Raum über der Bandmitte', tn: warm ? warm.name + ' ' + de(-luft, 1) + ' K über der Bandmitte' : 'Raumlage unbekannt', ok: have(luft) && luft >= -1e-9, ist: r2(luft), soll: 0, op: '>=', u: 'K', dyn: true},
                    d.running ? {k: 'vorlauf', kz: 'Vorlauf', t: 'Vorlauf mindestens ' + de(c.laufVlK, 1) + ' K über Soll (nur die Stoppschwelle steigt)', tn: 'Vorlauf ' + sg(vlS, 2) + ' K zum Soll: +1 K löste einen Hochlauf aus', ok: have(vlS) && vlS >= c.laufVlK, ist: r2(vlS), soll: c.laufVlK, op: '>=', u: 'K', dyn: true}
                              : {k: 'vorlauf', kz: 'Vorlauf', t: 'Vorlauf über Soll ' + sg(c.pauseVlK, 0) + ' K (kein sofortiger Start)', tn: 'Vorlauf ' + sg(vlS, 2) + ' K zum Soll: +1 K startete den Verdichter sofort', ok: have(vlS) && vlS > c.pauseVlK, ist: r2(vlS), soll: c.pauseVlK, op: '>=', u: 'K', dyn: true},
                    {k: 'nutzen', kz: 'Nutzen > Kosten', t: 'Nutzen ≥ Kosten (' + NK.txt + ')', tn: 'Nutzen kleiner als Kosten: ' + NK.txt, ok: NK.ok}
                ];
                return {cond: cond2, halt: c.haltMin, wert: 1, von: d.shift, groesse: 'shift', hebel: 'shift', dir: 'soll_hoch', befehl: RULE.quiet_strecken.hebel.shift, maxDauerMin: c.maxDauerKurveMin,
                        erwartung: 'Soll-Vorlauf +1 K binnen 6 min (5-min-Raster); Lauf länger (Annahme +' + c.laufPlusMin + ' min), Pause kürzer (Annahme −' + c.pauseMinusMin + ' min), Strom +' + de(c.kurveWK, 1) + ' W im Lauf; Wirkung nicht gemessen (Messaufgabe)',
                        rueckweg: 'Automatisch zurück auf 0 K bei Heizstab-Nähe, wenn ein Raum mehr als ' + de(d.notK, 1) + ' K über die Bandmitte steigt, wenn ' + c.kurveTaktZyklen + ' Läufe ohne Takt endeten, spätestens nach ' + de(c.maxDauerKurveMin / 60, 0) + ' h.',
                        was: 'Heizkurve 0 → +1 K (Soll-Vorlauf ' + de(d.soll, 0) + ' → ' + de(sollNeu, 0) + ' °C, Laufzeit)',
                        warum: 'Takt: ' + taktTxt.join(', ') + '; Verdichter bei ' + de(d.hz, 0) + ' Hz, Quiet deckelt nichts mehr; ' + NK.txt};
            }
        },
        {
            id: 'raum_offset', ver: 2, kachel: 'Raumeinfluss', kurz: 'Raumeinfluss ±1 K', name: 'Raumeinfluss (Heizkurve ±1 K)', art: 'befehl', groesse: 'shift', richtung: 'verschiebung', prio: 3,
            zweck: 'Räume wirken nur als langsamer, kleiner Offset auf die Heizkurve (Lambda-Prinzip). Übernimmt den Raumvorschlag der Phase-2-Logik (korrektur_vorschlag −1/0/+1) erst, wenn er lange stabil ist. Stellt nur die Verschiebung, nicht die Heizregelung (Comfort/Efficiency richtet sich nach der gemessenen Effizienz, Takt-Messung). Seit v2 Teil der Verschiebungs-Arbitrierung: eine Verschiebung, die einer anderen Regel gehört (Vorausschau), gilt nicht als Abweichung; Gegenrichtung nur nach Wartezeit und mit Komfort-Notfall.',
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
            erwartung: '+1 K: Soll-Vorlauf +1 K binnen 6 min (5-min-Raster), im Taktbetrieb +40–60 min Laufzeit je Lauf (Sollsprünge 07.–10.10.), Strom +2,5–3 % (8,5 W/K); Raumwirkung NICHT gemessen. −1 K: umgekehrt.',
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
            id: 'heizgrenze_hinweis', ver: 1, kachel: 'Heizgrenze', kurz: 'Heizgrenze 10 °C', name: 'Heizgrenze 12 → 10 °C (nur Hinweis)', art: 'hinweis', groesse: 'heizgrenze', richtung: 'weniger_waerme', prio: 4,
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
            id: 'vorausschau', ver: 1, kachel: 'Vorausschau', kurz: 'Vorausschau ±1 K', name: 'Vorausschau (Heizkurve ±1 K)', art: 'befehl', groesse: 'shift', richtung: 'verschiebung', prio: 5,
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
            erwartung: '+1 K: Soll-Vorlauf +1 K binnen 6 min (5-min-Raster), mehr Wärme vor dem erwarteten Bedarf (Strom +2,5–3 %, 8,5 W/K); die Räume bleiben im Band, obwohl der Bedarf steigt. −1 K: umgekehrt bei erwartetem Wärmegewinn. Raumwirkung NICHT gemessen.',
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
                         schaden: {quiet_freigabe: ['komfort'], quiet_strecken: ['takt', 'ueberschwingen'], raum_offset: ['komfort'], vorausschau: ['komfort']}},
        raumAlterMax: 360,         // Bewertung (nicht Entscheidung): ein Raumwert bis 6 h alt zaehlt, weil die Shelly H&T Gen3 nur bei Aenderung >= 0,5 K melden
        lueftungK: 1.0,            // Raum faellt >= 1 K in <= 60 min: Lueftung (Eingriff), danach keine Gegenfaktik fuer Raum-Prognosen (nach dem Replay ergaenzt: 09.10. Wohnzimmer -3,3 K)
        reife: {faelle: 10, tage: 14, skill: 0.2, wirkFaelle: 2, verpasst: 1},
        skillMinFaelle: 3,         // ab v4: Brier-Skill erst ab 3 vollstaendig abgeschlossenen, bewerteten Faellen (vorher "–"; aus 1 Fall ist er wertlos); ab v5: Faelle mit Brier-Beitrag
        fehlRefB: 0.5              // ab v5: Fehlalarm bei b >= p wird gegen diese Basisrate gerechnet (Abzug wie vor dem Lernen der Basisrate: p 0,7 -> -24, p 0,8 -> -39)
    };

    // ------------------------------------------------------------------ Standardwerte (aus dem Regelwerk)
    var LOCK_CFG = {hpMaxAgeMin: 5, afterDefrostMin: 10, afterDhwMin: 10, startLockMin: 15, gapMin: 60, taktK: 1.0, stopK: 3.25, heaterMarginK: 2, warmupMin: 10, pumpOnRpm: 1000, kurveTolK: 1.5,
                    shiftHaltMin: 60, gegenMin: 240, notK: 0.3,       // Verschiebungs-Arbitrierung (alle Regeln der Groesse "shift"): gemeinsame Mindesthaltezeit, Wartezeit Gegenrichtung, Komfort-Notfall
                    quietHaltMin: 60, quietGegenMin: 240,             // Quiet-Arbitrierung (Quiet-Freigabe, Deckel/Laufzeit), wie die Verschiebung (ANNAHME)
                    notfallMin: 10};                                  // Quiet-Notfall (Heizstab-Naehe, Raum >= notK unter Minimum) ueberbrueckt Mindestabstand, Wartezeit, Vorrang und Gegenrichtung nach 10 min (Regel-Review B4; ANNAHME)
    function thermoK(cfg) { var c = cfg && cfg.rules && cfg.rules.quiet_strecken; return c && have(c.thermoStoppK) ? c.thermoStoppK : 2.75; }
    // Bedarf fuer die Quiet-Stufe (Quiet-Freigabe v2; fuer "Deckel/Laufzeit" ein Ausschlussgrund): Raum unter Minimum, Raum faellt auf das Minimum zu (Prognose),
    // Heizstab-Naehe, Boost von Hand. Ein Vorlauf unter Soll allein ist kein Bedarf.
    var TR = {fensterMin: 120, minSpanMin: 60, haltH: 6, laufMin: 15, rasterMin: 5, letzteMin: 30, minPunkte: 7};   // Raumverlauf: Gefaelle der letzten 2 h im Lauf (ab Laufminute 15, mindestens 1 h), Speicher 6 h
    // K/h per Regression (kleinste Quadrate) ueber den Verlauf im 5-min-Raster; je Rasterpunkt gilt die letzte Meldung davor (die Shelly melden nur bei Aenderung).
    // Fenster: max(jetzt − 2 h, Laufbeginn + 15 min) bis jetzt, mindestens 60 min. Lueften (Sturz um >= lueftK binnen 60 min) ist ein Eingriff von aussen: der Verlauf
    // zaehlt erst ab dem Ende des Sturzes. Steigt der Raum in den letzten 30 min, faellt er nicht (0). null = zu wenig Verlauf oder kein Lauf (Regel-Review B3).
    // Nur im Lauf: dass ein Raum in der Pause abkuehlt, ist kein Leistungsmangel (der naechste Start heizt nach); faellt er trotz Lauf am Deckel, fehlt Leistung.
    function raumTrend(S, r, now, runStart, lueftK) {
        var L = (S.rtr && S.rtr[r.id]) || [], lk = have(lueftK) ? lueftK : SCORE.lueftungK;
        if (!L.length || !have(r.t) || !runStart) { return null; }
        var t0 = Math.max(now - TR.fensterMin * MIN, runStart + TR.laufMin * MIN);
        for (var j = 1; j < L.length; j++) {                                          // Lueften: Fenster beginnt nach dem Sturz (fallende Meldung, die >= lk unter einem Wert der letzten 60 min liegt)
            if (L[j][0] < t0 - 60 * MIN || L[j][1] >= L[j - 1][1]) { continue; }
            for (var i = j - 1; i >= 0 && L[i][0] >= L[j][0] - 60 * MIN; i--) { if (L[i][1] - L[j][1] >= lk - 1e-9) { t0 = Math.max(t0, L[j][0]); break; } }
        }
        if (now - t0 < TR.minSpanMin * MIN) { return null; }
        function wert(t) { var v = null; for (var k = 0; k < L.length && L[k][0] <= t; k++) { v = L[k][1]; } return v; }
        var xs = [], ys = [];
        for (var t = now; t >= t0 - 1000; t -= TR.rasterMin * MIN) { var v = wert(t); if (have(v)) { xs.push((t - now) / 3600000); ys.push(v); } }
        if (xs.length < TR.minPunkte) { return null; }
        var mx = 0, my = 0, sxx = 0, sxy = 0, n = xs.length;
        for (var a = 0; a < n; a++) { mx += xs[a] / n; my += ys[a] / n; }
        for (var b = 0; b < n; b++) { sxx += (xs[b] - mx) * (xs[b] - mx); sxy += (xs[b] - mx) * (ys[b] - my); }
        if (sxx <= 0) { return null; }
        var kh = sxy / sxx, v30 = wert(now - TR.letzteMin * MIN);
        return (kh < 0 && have(v30) && r.t > v30) ? 0 : kh;
    }
    function bedarfQ(S, d, cfg) {
        var c = cfg.rules.quiet_freigabe, o = {ja: false, raum: null, trend: null, heizstab: false, boost: false, notfall: false, txt: '', keinTxt: 'alle gültigen Räume ab Minimum, keiner fällt darauf zu, kein Heizstab-Risiko, kein Boost von Hand'}, parts = [];
        var rb = d.roomBelow[0];
        if (rb) { o.raum = rb; parts.push(rb.name + ' ' + de(rb.min - rb.t, 1) + ' K unter Minimum'); }
        d.rooms.forEach(function (r) {
            if (!r.active || !r.valid || !have(r.min) || r.t < r.min) { return; }
            var tr = raumTrend(S, r, d.now, d.running && S.run && S.run.on ? S.run.start : 0, c.lueftungK); if (tr === null || tr > -c.trendKh) { return; }
            var eta = (r.t - r.min) / -tr * 60;
            if (eta <= c.prognoseMin && (!o.trend || eta < o.trend.eta)) { o.trend = {r: r, tr: tr, eta: eta}; }
        });
        if (o.trend) { parts.push(o.trend.r.name + ' fällt ' + de(-o.trend.tr, 1) + ' K/h (Minimum in ~' + de(o.trend.eta, 0) + ' min)'); }
        // Heizstab ab Vorlauf < Soll + Start-Delta (−3 K) nach Heater_Delay_Time bei AT < Heater_On_Outdoor_Temp; im Dauerlauf ohne Verzoegerung -> groesserer Abstand
        o.dauer = d.running && d.runMin >= d.htrDelay;
        o.heizstab = !!(d.running && d.htrNear && have(d.vlRueck) && d.vlRueck >= d.htrSd - (o.dauer ? c.heizstabDauerK : c.heizstabAbstandK));   // nur im Lauf (Thermo-EIN): in der Pause kein Heizstab
        if (o.heizstab) { parts.push('Heizstab-Nähe (Außen ' + de(d.at, 0) + ' °C, Vorlauf ' + de(d.vlRueck, 1) + ' K unter Soll, Heizstab ab ' + de(d.htrSd, 0) + ' K)'); }
        o.boost = !!d.boost && c.boostBedarf === 1;                                      // Boost von Hand als Bedarf (Nutzer vorlaeufig: ja)
        if (o.boost) { parts.push('Soll von Hand ' + de(d.soll, 0) + ' °C über der Heizkurve (' + de(d.sollKurve, 1) + ' °C)'); }
        o.ja = parts.length > 0; o.txt = parts.join(', ');
        o.notfall = o.heizstab || !!(rb && rb.t <= rb.min - d.notK);
        return o;
    }
    // Rueckweg-Gruende der Quiet-Regeln und "halten" (kein Ablauf, solange Bedarf besteht); Zeitgeber im Zustand
    function quietEnde(S, d, cfg) {
        var now = d.now, c1 = cfg.rules.quiet_freigabe, c2 = cfg.rules.quiet_strecken, B = d.bedQ, ende = {}, halten = {};
        // Deckel/Laufzeit, Hebel Quiet: zurueck bei Bedarf, bei Ruecklauf-Rueckstand >= bedarfRlK seit 15 min oder bei Aussentemperatur <= atMinC
        S.needSince = (have(d.rlRueck) && d.rlRueck >= c2.bedarfRlK && d.running) ? (S.needSince || now) : 0;
        if (B.ja) { ende.quiet_strecken = 'Bedarf: ' + B.txt; }
        else if (S.needSince && now - S.needSince >= 15 * MIN) { ende.quiet_strecken = 'Rücklauf seit 15 min ≥ ' + de(c2.bedarfRlK, 1) + ' K unter Soll (Leistung wird gebraucht)'; }
        else if (have(d.at) && d.at <= c2.atMinC) { ende.quiet_strecken = 'Außentemperatur ' + de(d.at, 0) + ' °C (Quiet höher erst über ' + de(c2.atMinC, 0) + ' °C)'; }
        // Quiet-Freigabe (v2): zurueck, sobald der Bedarf 15 min am Stueck gedeckt ist oder ein Bedarfsraum dieser Freigabe rueckRaumMin ueber seinem Maximum liegt.
        // Andere Raeume ueber Maximum zaehlen nicht (Waermeverteilung: Wohnzimmer 29-74 % der Zeit ueber Maximum; Regel-Review B2). Solange Bedarf besteht oder die
        // Kaelte-Vorsorge eine Freigabe aus einer harten Stufe braucht, ruhen Grund und Ablauf.
        var AQ = S.arbQ, fa = AQ.applied && AQ.applied.rule === 'quiet_freigabe' ? AQ.applied : null, frei = fa || AQ.owner === 'quiet_freigabe';
        S.qfRooms = Array.isArray(S.qfRooms) ? S.qfRooms : [];
        if (!frei && !B.ja) { S.qfRooms = []; }
        d.roomBelow.forEach(function (r) { if (S.qfRooms.indexOf(r.id) < 0) { S.qfRooms.push(r.id); } });
        if (B.trend && S.qfRooms.indexOf(B.trend.r.id) < 0) { S.qfRooms.push(B.trend.r.id); }
        var K = d.kaltQ || {}, von0 = fa ? (have(fa.von0) ? fa.von0 : fa.von) : null, capV = have(von0) ? deckelOf(kaltD(d, have(K.at) ? K.at : d.at), von0).hz : null;
        var kalt = !!(K.halten && fa && have(capV) && capV <= c1.hartHz);
        var deck = !B.ja && !kalt && d.fresh && (!have(d.rlRueck) || d.rlRueck <= c1.rueckRlK) && komfortSicher(d, {komfortK: d.notK}).ok;
        S.qfDeckSince = deck ? (S.qfDeckSince || now) : 0;
        var hoch = d.roomAbove.filter(function (r) { return S.qfRooms.indexOf(r.id) >= 0; })[0] || null;
        S.qfHochSince = hoch ? (S.qfHochSince || now) : 0;
        if (hoch && !B.ja && now - S.qfHochSince >= c1.rueckRaumMin * MIN) { ende.quiet_freigabe = hoch.name + ' seit ' + c1.rueckRaumMin + ' min über Maximum'; }
        else if (S.qfDeckSince && now - S.qfDeckSince >= KORR0_MIN * MIN) { ende.quiet_freigabe = 'Bedarf seit ' + KORR0_MIN + ' min gedeckt (alle Räume ≥ Minimum + ' + de(d.notK, 1) + ' K, Rücklauf höchstens ' + de(c1.rueckRlK, 1) + ' K unter Soll)'; }
        if (B.ja) { halten.quiet_freigabe = 'Bedarf besteht weiter: ' + B.txt; }
        else if (kalt) { halten.quiet_freigabe = 'Kälte-Vorsorge: ' + (K.kalt ? K.txt : 'Außen ' + de(d.at, 0) + ' °C (unter ' + (c1.kaltC + 1) + ' °C)') + ', Quiet ' + von0 + ' deckelt hart'; }
        return {ende: ende, halten: halten};
    }
    function komfortSicher(d, c) {                                                   // Effizienz-Deckel: jeder aktive Raum mit Wert (bis 6 h alt, wie die Bewertung) mindestens komfortK ueber Minimum
        var act = d.rooms.filter(function (r) { return r.active && have(r.min); }), bad = null, fehlt = null;
        if (!act.length) { return {ok: false, txt: 'keine Raumdaten'}; }
        act.forEach(function (r) {
            if (!have(r.t) || !(r.valid || (have(r.age) && r.age <= SCORE.raumAlterMax))) { fehlt = fehlt || r; return; }
            if (r.t < r.min + c.komfortK && (!bad || r.t - r.min < bad.t - bad.min)) { bad = r; }
        });
        if (fehlt) { return {ok: false, txt: fehlt.name + ': kein Raumwert'}; }
        if (bad) { return {ok: false, txt: bad.name + ' nur ' + de(bad.t - bad.min, 1) + ' K über Minimum (Reserve ' + de(c.komfortK, 1) + ' K)'}; }
        return {ok: true, txt: 'alle Räume mindestens ' + de(c.komfortK, 1) + ' K über Minimum'};
    }
    function defaults() {
        var c = {locks: JSON.parse(JSON.stringify(LOCK_CFG)), rules: {}, takt: taktCfg(null)};
        RULES.forEach(function (r) { var o = {}; r.schwellen.forEach(function (s) { o[s.key] = s.std; }); c.rules[r.id] = o; });
        return c;
    }
    function mergeCfg(over) {
        var c = defaults();
        if (over && typeof over === 'object') {
            if (over.locks) { Object.keys(c.locks).forEach(function (k) { if (have(num(over.locks[k]))) { c.locks[k] = num(over.locks[k]); } }); }
            if (over.rules) { Object.keys(c.rules).forEach(function (id) { var o = over.rules[id]; if (o) { Object.keys(c.rules[id]).forEach(function (k) { if (have(num(o[k]))) { c.rules[id][k] = num(o[k]); } }); } }); }
            if (over.takt) { c.takt = taktCfg(over.takt); }
            if ([1, 2, 3, 4].indexOf(num(over.sv)) >= 0) { c.sv = num(over.sv); }                         // Bewertungsregeln v1 ... v4 nachrechnen (nur Replay/Tests)
        }
        return c;
    }

    // ------------------------------------------------------------------ Zustand (ueberlebt Neustarts per Datei)
    function newState(now) {
        var S = {mv: VER, born: now, last: now, run: {on: null, start: 0, reached: false, reachN: 0, sollTop: null}, lastStop: 0, lastStart: 0, runs: [], starts: [],
                 defrostEnd: 0, dhwEnd: 0, defrostWas: false, dhwWas: false, q: null, qChg: 0, shift: null, shiftChg: 0, soll: null, handWas: false, vlHist: [], needSince: 0, korr0Since: 0, vsEndSince: 0, atH: [],
                 arb: {owner: null, soll: null, von: null, start: 0, applied: null, last: null}, rules: {}, sc: newScore(), takt: taktNew(),
                 arbQ: {owner: null, soll: null, von: null, start: 0, applied: null, last: null},          // Quiet-Arbitrierung (seit Quiet-Freigabe v2 / Deckel/Laufzeit v4)
                 rtr: {}, bedT: 0, qfDeckSince: 0, lastPause: null, lz: null};                               // Raumverlauf, letzter Quiet-Bedarf, Rueckweg der Freigabe, letzte Pause, Messaufgabe +1 K
        RULES.forEach(function (r) { S.rules[r.id] = {since: 0, failSince: 0, prop: null, cool: 0, n: 0, day: '', korrV: null, korrSince: 0, last: null, hebel: null}; });
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
    // Lern- und Eingangs-Hygiene (B, 13.10.2026): Werte ausserhalb dieser Bereiche gelten als fehlend (Idee tvofi INPUT_PLAUSIBLE_RANGE_C: Wasser -20..100 °C;
    // Aussenluft enger -40..45 °C, Frequenz 0..150 Hz, el. Leistung 0..6 kW, Waerme -15..15 kW wie im Waermefahrplan; ANNAHME). Der Datensatz behaelt die Rohwerte.
    var PLAUS = {at: [-40, 45], hz: [0, 150], vl: [-20, 100], rl: [-20, 100], soll: [-20, 100], pel: [0, 6000], pth: [-15000, 15000]};
    function plausV(k, v) { v = num(v); return (have(v) && v >= PLAUS[k][0] && v <= PLAUS[k][1]) ? v : null; }
    function derive(S, inp, cfg) {
        var L = cfg.locks, now = inp.t;
        var d = {now: now, hz: plausV('hz', inp.hz), vl: plausV('vl', inp.vl), rl: plausV('rl', inp.rl), soll: plausV('soll', inp.soll), dT: num(inp.dT), at: plausV('at', inp.at), q: num(inp.q), shift: num(inp.shift),
                 pump: num(inp.pump), pel: plausV('pel', inp.pel), heatOffAT: num(inp.heatOffAT), korr: inp.korr || null, notK: L.notK, arb: S.arb, arbQ: S.arbQ,
                 vs: (inp.vs && typeof inp.vs === 'object' && Array.isArray(inp.vs.at)) ? inp.vs : null};
        d.fresh = have(num(inp.hpAge)) && num(inp.hpAge) <= L.hpMaxAgeMin && have(d.hz) && have(d.vl) && have(d.soll);
        d.running = have(d.hz) && d.hz > 0;
        d.zustand = d.running ? 'lauf' : (!have(d.pump) ? '?' : (d.pump >= L.pumpOnRpm ? 'pause' : 'heizgrenze'));
        d.hc = num(inp.hc); d.pth = plausV('pth', inp.pth);
        d.unpl = Object.keys(PLAUS).filter(function (k) { return have(num(inp[k])) && plausV(k, inp[k]) === null; });
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
                R.on = true; R.start = (have(rt) && rt > 0 && rt < 24 * 60) ? now - rt * MIN : now; R.reached = false; R.reachN = 0; R.sollTop = d.soll; R.over = null;
                if (S.lastStop) { S.starts.push(R.start); S.lastPause = mins(R.start - S.lastStop); }      // Pause vor diesem Lauf (Zyklus fuer "Deckel/Laufzeit" +1 K)
                S.lastStart = R.start;
            } else if (!d.running && R.on === true) {
                R.on = false; S.lastStop = now; S.runs.push([R.start, mins(now - R.start), have(R.over) && R.over >= thermoK(cfg) ? 1 : 0]);   // [Beginn, Dauer, Abschaltung ueber den Vorlauf]
            } else if (R.on === null) { R.on = false; }
            if (d.running && have(d.vl) && have(d.soll)) { R.over = d.vl - d.soll; }          // Vorlauf zum Soll in der letzten Laufminute (Stopp-Art)
            // Laufzeit der Anlage hat Vorrang, wenn sie kleiner ist (Stopp und Neustart zwischen zwei Aufrufen; nach einem Node-RED-Neustart beginnt sie bei 0 = vorsichtig).
            // Aber nur nach einer Luecke von mehr als 4 min: der Verdichter hat eine Neustartsperre von 3 min (Servicehandbuch), zwischen zwei Minuten-Aufrufen im Lauf gibt es
            // keinen Stopp mit Neustart. Faellt die Laufzeit mitten im beobachteten Lauf, hat HeishaMoNR sie zurueckgesetzt (09.10. 03:01: 583 -> 0 min; ein 600-min-Lauf
            // erschien sonst als 17-min-Lauf mit Abschaltung ueber den Vorlauf = falscher Takt-Beleg fuer "Deckel/Laufzeit").
            if (d.running && have(rt) && rt >= 0 && R.start && now - R.start > (rt + 2) * MIN && (!S.runSeen || now - S.runSeen > 4 * MIN)) { R.start = now - rt * MIN; }
            if (d.running) { S.runSeen = now; }
        }
        S.starts = S.starts.filter(function (t) { return now - t <= 24 * 60 * MIN; });
        S.runs = S.runs.filter(function (r) { return now - r[0] <= 48 * 60 * MIN; }).slice(-20);
        d.runMin = (d.running && R.on && R.start) ? (now - R.start) / MIN : 0;
        d.lastRunMin = S.runs.length ? S.runs[S.runs.length - 1][1] : null;
        d.lastRunThermo = S.runs.length ? S.runs[S.runs.length - 1][2] === 1 : false;      // aeltere Zustaende ohne Stopp-Art: unbekannt = kein Takt-Beleg
        d.lastPauseMin = have(S.lastPause) ? S.lastPause : null;
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
        // ebenso fuer die Quiet-Stufe (Quiet-Freigabe nach unten, Deckel/Laufzeit nach oben): uebernommene Stufe gehoert der Regel, bis sie sich wieder aendert
        if (d.qChanged) {
            var AQ = S.arbQ;
            var ap0 = AQ.applied;
            if (AQ.applied && AQ.applied.w !== d.q) { AQ.last = {rule: AQ.applied.rule, dir: sgnOf(AQ.applied.w - AQ.applied.von), w: AQ.applied.w, von: AQ.applied.von, start: AQ.applied.ts, end: now}; AQ.applied = null; }
            if (AQ.owner && d.q === AQ.soll) {
                AQ.applied = {rule: AQ.owner, w: d.q, von: d.qFrom, ts: now}; d.qBy = AQ.owner;
                // Fortsetzung (Regel-Review B1): dieselbe Regel stellt in derselben Richtung weiter -> die Ausgangsstufe bleibt fuer Rueckweg und Kaelte-Vorsorge
                if (ap0 && ap0.rule === AQ.owner && ap0.w === d.qFrom && sgnOf(d.q - d.qFrom) === sgnOf(ap0.w - ap0.von)) { AQ.applied.von0 = have(ap0.von0) ? ap0.von0 : ap0.von; AQ.applied.ts0 = ap0.ts0 || ap0.ts; }
            }
        }
        if (have(d.soll)) { if (have(S.soll) && S.soll !== d.soll) { d.sollJump = d.soll - S.soll; } S.soll = d.soll; }
        // Handeingriff am Soll (Soll weicht von der Heizkurve ab, z. B. Boost): sein Ende zaehlt fuer den Mindestabstand wie eine Aenderung der Verschiebung
        var sk = num(inp.sollKurve);
        d.hand = have(sk) && have(d.soll) && Math.abs(d.soll - (have(d.shift) ? d.shift : 0) - sk) > cfg.locks.kurveTolK;
        d.sollKurve = sk; d.boost = d.hand && d.soll - (have(d.shift) ? d.shift : 0) - sk > cfg.locks.kurveTolK;   // Boost von Hand: Soll ueber der Heizkurve
        // Raumverlauf (Quiet-Freigabe v2, Prognose "Raum faellt auf das Minimum zu"): je gueltigem Raum die Werte bei Aenderung, 6 h
        S.rtr = S.rtr || {};
        d.rooms.forEach(function (r) {
            if (!r.active || !r.valid || !have(r.t)) { return; }
            var L = S.rtr[r.id] = Array.isArray(S.rtr[r.id]) ? S.rtr[r.id] : [], la = L[L.length - 1], g5 = Math.floor(now / (5 * MIN));
            if (la && la[1] !== r.t && Math.floor(la[0] / (5 * MIN)) === g5 && L.length > 1 && Math.floor(L[L.length - 2][0] / (5 * MIN)) === g5) { la[1] = r.t; }   // hoechstens zwei Werte je 5 min (EMA-Werte aendern sich jede Minute)
            else if (!la || la[1] !== r.t) { L.push([now, r.t]); }
            while (L.length > 1 && L[1][0] <= now - TR.haltH * 60 * MIN) { L.shift(); }
            if (L.length > 160) { L.splice(0, L.length - 160); }
        });
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
        var hdl = num(inp.htrDelay); d.htrDelay = have(hdl) && hdl > 0 && hdl <= 120 ? hdl : 15;   // Heater_Delay_Time (J: 15 min); ohne Meldung 15 min
    }

    // ------------------------------------------------------------------ Sperren je Regel (Reihenfolge = Prioritaet des angezeigten Grundes)
    function locksFor(R, d, S, cfg, inp, dirNow, e) {
        var L = cfg.locks, c = cfg.rules[R.id], rs = S.rules[R.id], now = d.now, out = [], g = (e && e.groesse) || R.groesse, sl = (e && have(e.startMin)) ? e.startMin : L.startLockMin;
        var nf = !!(e && e.hart) && g === 'quiet';                                       // Quiet-Notfall (Heizstab-Naehe, Raum >= notK unter Minimum): Abstand/Tageslimit/Wartezeit nach notfallMin
        function add(id, extra, until) { out.push({id: id, text: LOCK_TEXT[id] + (extra ? ' (' + extra + ')' : ''), bis: until || null}); }
        R.sperren.forEach(function (id) {
            if (id === 'anlauf' && now - S.born < L.warmupMin * MIN) { add(id, 'noch ' + Math.ceil((S.born + L.warmupMin * MIN - now) / MIN) + ' min', S.born + L.warmupMin * MIN); }
            if (id === 'daten' && !d.fresh) { add(id, have(num(inp.hpAge)) ? 'letzte Meldung vor ' + de(num(inp.hpAge), 0) + ' min' : 'keine Meldung'); }
            if (id === 'mqtt_sperre' && num(inp.block) === 1) { add(id); }
            if (id === 'abtauen' && (d.defrost || (S.defrostEnd && now - S.defrostEnd < L.afterDefrostMin * MIN))) { add(id, d.defrost ? 'läuft' : 'noch ' + Math.ceil((S.defrostEnd + L.afterDefrostMin * MIN - now) / MIN) + ' min', d.defrost ? null : S.defrostEnd + L.afterDefrostMin * MIN); }
            if (id === 'warmwasser' && (d.dhw || (S.dhwEnd && now - S.dhwEnd < L.afterDhwMin * MIN))) { add(id, d.dhw ? 'läuft' : 'noch ' + Math.ceil((S.dhwEnd + L.afterDhwMin * MIN - now) / MIN) + ' min', d.dhw ? null : S.dhwEnd + L.afterDhwMin * MIN); }
            if (id === 'sanftanlauf' && num(inp.ss) === 1) { add(id); }
            if (id === 'laufbeginn' && d.running && d.runMin < sl) { add(id, de(d.runMin, 0) + ' von ' + sl + ' min', S.run.start + sl * MIN); }      // Heizstab-Naehe (Quiet-Freigabe v2): kuerzere Startphase
            if (id === 'heizgrenze_aus' && !d.running && d.zustand === 'heizgrenze') { add(id); }
            if (id === 'modell' && !(d.vs && d.vs.gate)) { add(id, d.vs ? (d.vs.n || 0) + ' von ' + (d.vs.minDays || 10) + ' Tagen' : 'keine Vorhersage'); }
            if (id === 'vorrang' || id === 'gegenrichtung') { if (id === 'vorrang' || R.sperren.indexOf('vorrang') < 0) { arbLocks(R, e, d, S, cfg, add); } }
            if (id === 'regler') {
                if (g === 'quiet' && inp.otherQ) { add(id, inp.otherQ); }
                if (g === 'shift') {
                    var sk = num(inp.sollKurve);
                    if (inp.otherShift) { add(id, inp.otherShift); }
                    else if (num(inp.heatMode) !== 0) { add(id, 'kein Heizkurvenmodus'); }
                    else if (num(inp.z1Sensor) !== 0) { add(id, 'Zone 1 nicht über Wassertemperatur'); }
                    else if (d.hand) { add(id, 'Soll-Vorlauf ' + de(d.soll, 0) + ' °C weicht von der Heizkurve (' + de(sk, 1) + ' °C) ab: Handeingriff'); }
                }
            }
            if (id === 'abstand') {                                                        // seit 13.10. ueber beide Groessen (Regel-Review 3.4: Wirkung sonst nicht zuzuordnen, Effekte addieren sich)
                var chg = (g === 'quiet' || g === 'shift') ? Math.max(S.qChg || 0, S.shiftChg || 0) : 0;
                var gap = nf ? L.notfallMin : L.gapMin;
                if (chg && now - chg < gap * MIN) { add(id, 'letzte Änderung ' + hhmm(chg) + ', noch ' + Math.ceil((chg + gap * MIN - now) / MIN) + ' min' + (nf ? ' (Notfall)' : ''), chg + gap * MIN); }
            }
            if (id === 'tageslimit' && rs.n >= c.proTag && !rs.prop && !nf) { add(id, rs.n + ' von ' + c.proTag + (R.art === 'befehl' ? ' übernommen' : '')); }
            if (id === 'abkuehlzeit' && rs.cool > now && !rs.prop) {                     // Notfall: nach notfallMin, aber nicht nach einem nur abgelaufenen Vorschlag (sonst alle 40 min derselbe, nachts klickt niemand)
                var coolEnd = (nf && !(rs.coolAb && rs.coolNf)) ? Math.min(rs.cool, rs.cool - (c.pauseMin - L.notfallMin) * MIN) : rs.cool; if (coolEnd > now) { add(id, 'bis ' + hhmm(coolEnd), coolEnd); }
            }
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
        var res = {id: R.id, v: R.ver, st: '', grund: '', naechste: null, p: null, locks: [], groesse: R.groesse};
        function endProp(why) {
            if (!rs.prop) { return; }
            [['shift', S.arb], ['quiet', S.arbQ]].forEach(function (x) {                  // Arbitrierung: Groesse freigeben, Richtung und Ende merken (Gegenrichtung)
                var A = x[1]; if (!A || A.owner !== R.id || (rs.prop.groesse || R.groesse) !== x[0]) { return; }
                A.last = {rule: R.id, dir: sgnOf(A.soll - A.von), w: A.soll, von: A.von, start: A.start, end: now};
                A.owner = null; A.soll = null; A.von = null; A.start = 0;
            });
            rs.coolAb = why === 'abgelaufen'; rs.coolNf = !!rs.prop.hart; rs.prop = null; rs.cool = now + c.pauseMin * MIN; res.ende = why;
        }
        if (!d.fresh && R.sperren.indexOf('daten') >= 0) {                                 // ohne frische Anlagendaten wird keine Bedingung bewertet
            var ld = locksFor(R, d, S, cfg, inp, null).filter(function (l) { return l.id === 'daten'; });
            rs.since = 0; rs.failSince = 0; endProp('gesperrt: ' + ld[0].text);
            res.st = 'gesperrt'; res.grund = 'gesperrt: ' + ld[0].text; res.locks = ['daten']; res.naechste = {b: 'daten', text: 'prüft wieder, sobald HeishaMon frische Daten liefert'};
            return res;
        }
        // ein laufender Vorschlag, dessen Zielwert an der Anlage steht, ist erledigt (uebernommen, von Hand oder per Klick); die Groesse gehoert dann der Regel (applied)
        if (rs.prop && (rs.prop.groesse || R.groesse) && have(curOf(d, rs.prop.groesse || R.groesse)) && curOf(d, rs.prop.groesse || R.groesse) === rs.prop.cmd.value && R.art === 'befehl') {
            rs.since = 0; rs.failSince = 0; rs.n++; endProp('übernommen: ' + wTxt(rs.prop.groesse || R.groesse, rs.prop.cmd.value) + ' steht');   // Tageslimit: nur uebernommene Vorschlaege (R5)
        }
        var e = R.eval(d, c, rs);
        res.groesse = e.groesse || R.groesse;
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
            if (R.art !== 'befehl') { rs.n++; }                                            // Hinweise zaehlen je Hinweis, Befehlsregeln je Uebernahme (oben)
            var bf = e.befehl || R.befehl, g = e.groesse || R.groesse;
            var p = {id: R.id + '@' + isoMin(now).replace(' ', 'T'), rule: R.id, ver: R.ver, art: R.art, name: R.name, ts: now, bis: now + c.gueltigMin * MIN,
                     cmd: {name: bf.name, topic: bf.topic, value: e.wert}, von: e.von, dir: e.dir || R.richtung, lead: e.lead || '',
                     was: e.was, warum: e.warum, erwartung: e.erwartung || R.erwartung, rueckweg: e.rueckweg || R.rueckweg, wann: 'ausgelöst ' + hhmm(now) + (e.halt ? ' nach ' + e.halt + ' min über allen Schwellen' : '')};
            if (g !== R.groesse || e.hebel) { p.groesse = g; p.hebel = e.hebel || null; }                            // Deckel/Laufzeit v4: Hebel des Vorschlags (Quiet oder Heizkurve)
            if (have(e.maxDauerMin)) { p.maxDauerMin = e.maxDauerMin; }                                               // Rueckweg-Frist der Uebernahme (je Hebel)
            if (e.hart) { p.hart = true; }                                                                           // Notfall (Wartezeit danach nur fuer einen neuen Notfall verkuerzt)
            p.sum = checksum(p);
            rs.prop = p; res.neu = true;
            var A0 = arbOf(S, g); if (A0 && (g === 'shift' || g === 'quiet')) { A0.owner = R.id; A0.soll = e.wert; A0.von = e.von; A0.start = now; }      // Arbitrierung: diese Regel hat jetzt die Groesse
        }
        res.st = R.art === 'hinweis' ? 'hinweis' : 'vorschlag'; res.p = rs.prop.id; res.grund = rs.prop.warum;
        return res;
    }

    // ------------------------------------------------------------------ Takt- und Mindestleistungs-Messung (nur Messung/Anzeige; Grundlage fuer Quiet/Modus nach Effizienz; 13.10.)
    // Ideen: tvofi/heatpump_optimizer (StartCounter: entprellt, None != aus), Appesteijn/stooklijn (cycling.py; min_power.py: 10-%-Quantil je 2-K-Bin,
    // monoton als laufendes Minimum von warm nach kalt). Kein Code uebernommen (stooklijn ohne Lizenzdatei). Schwellen mit Herkunft in TAKT_SCHWELLEN (cfg.takt).
    var TAKT_SCHWELLEN = [
        {key: 'probenEin', std: 2, einheit: 'Proben', herkunft: 'Start erst nach 2 Laufproben in Folge (Idee tvofi wear.py: START_HYSTERESIS_SAMPLES = 2)'},
        {key: 'probenAus', std: 2, einheit: 'Proben', herkunft: 'Stopp erst nach 2 Proben ohne Lauf (wie probenEin; ANNAHME)'},
        {key: 'minAusMin', std: 3, einheit: 'min', herkunft: 'Pause kürzer als 3 min = derselbe Lauf (ANNAHME; Idee stooklijn cycling.py: Stopp < 60 s ist eine Messlücke, bei uns 1-min-Raster)'},
        {key: 'kurzMin', std: 60, einheit: 'min', herkunft: 'kurzer Lauf: kürzer als 60 min (Regel „Laufzeit strecken“ v2: Mindestlauf 60 min)'},
        {key: 'minutenPauseMin', std: 30, einheit: 'min', herkunft: 'Pause kürzer als 30 min = Minutenpause bei Minimalmodulation, sonst Bedarfspause (ANNAHME; OEM-Threads: Takt-Typen trennen)'},
        {key: 'stabilAbMin', std: 15, einheit: 'min', herkunft: 'Mindestleistung und COP erst ab Laufminute 15 (Messung: Pumpenspitze der Startroutine 11–16 min nach jedem Start)'},
        {key: 'binMinN', std: 30, einheit: 'min', herkunft: 'Mindestleistung je 2-K-Band erst ab 30 stabilen Minuten (Idee stooklijn min_power.py: mindestens 6 Proben à 5 min)'},
        {key: 'copMinMin', std: 60, einheit: 'min', herkunft: 'Nutzerentscheidung 13.10.2026, vorläufig: Mindestdaten je Kombination Modus × Quiet × Außenband für die Anzeige und als Schwelle, ab der eine Regel eine Umschaltung vorschlagen darf'},
        {key: 'copTage', std: 30, einheit: 'Tage', herkunft: 'COP-Vergleich über die letzten 30 Tage (ANNAHME; stooklijn: 30-Tage-Fenster, Jahreszeiten nicht mischen)'},
        {key: 'deckelNachQMin', std: 15, einheit: 'min', herkunft: 'gelernter Quiet-Deckel: Minuten bis 15 min nach einem Quiet-Wechsel zählen nicht (Messung 12.10. 09:30: nach Quiet 2 → 3 fiel der Verdichter erst nach 15 min von 20 auf 17–18 Hz)'},
        {key: 'deckelHaltMin', std: 5, einheit: 'min', herkunft: 'gelernter Quiet-Deckel: eine Frequenz zählt erst, wenn die Stufe sie 5 min am Stück gehalten hat (Messung 09.10. 01:22–01:24: Quiet 3 lief bei 4 °C ohne Rückstand 3 min mit 20 Hz, vermutlich Ölrückführung; solche Spitzen zählen nicht; ANNAHME)'},
        {key: 'startsTagWarn', std: 12, einheit: 'Starts', herkunft: 'Anzeige „Takt“ ab mehr als 12 Starts in 24 h (Richtwert HeatPump Hero, docs/optimization.md)'},
        {key: 'kurzAnteilWarn', std: 0.25, einheit: 'Anteil', herkunft: 'Anzeige „Takt“ ab mehr als 25 % kurzen Läufen bei mindestens 4 Läufen (Richtwert HeatPump Hero; dort „kurz“ = unter 10 min, bei uns unter 60 min)'}
    ];
    var TAKT = {binK: 2, quantil: 0.1, binMax: 300, maxAgeMin: 5, fensterH: 24};
    // Beobachtete Heizgrenze (Idee st03psn/heat-pump-hero advisor.py _record_heating_limit, MIT): Aussentemperatur beim Ende jedes Laufs >= 30 min, Mittel der letzten 7 Tage.
    // Nur Kennzahl (Gegenprobe zur Regel "Heizgrenze"); Auswahlverzerrung: nur lange Laeufe zaehlen.
    var HG = {laufMin: 30, tage: 7};
    function heizgrenzeBeob(T, now) { var L = ((T && T.hg) || []).filter(function (h) { return now - h[0] <= HG.tage * 24 * 60 * MIN; }); return L.length ? {at: r2(L.reduce(function (a, h) { return a + h[1]; }, 0) / L.length), n: L.length, max: Math.max.apply(null, L.map(function (h) { return h[1]; }))} : null; }       // feste Groessen der Auswertung (Band 2 K wie stooklijn, 10-%-Quantil, Datenalter wie die Sperre "daten")
    var BAENDER = [[-99, -1, '< -1'], [-1, 3, '-1…3'], [3, 7, '3…7'], [7, 11, '7…11'], [11, 15, '11…15'], [15, 99, '≥ 15']];
    function taktCfg(c) { var o = {}; TAKT_SCHWELLEN.forEach(function (s) { o[s.key] = (c && have(num(c[s.key]))) ? num(c[s.key]) : s.std; }); return o; }
    function taktNew() { return {on: null, nOn: 0, nOff: 0, tOn1: 0, tOff1: 0, t0: 0, tStop: 0, starts: [], runs: [], pausen: [], bins: {}, copT: {}}; }
    function bandOf(at) { for (var i = 0; i < BAENDER.length; i++) { if (at < BAENDER[i][1]) { return BAENDER[i][2]; } } return BAENDER[BAENDER.length - 1][2]; }
    function modusOf(hc) { return hc === 0 ? 'Comfort' : (hc === 1 ? 'Efficiency' : '?'); }
    function taktStep(T, x, c) {                                                     // x = Eingabe (t, hz, hpAge, at, pel, pth, q, hc, defrost, dhw); gibt T zurueck (dasselbe Objekt)
        if (!T || typeof T !== 'object' || !Array.isArray(T.runs)) { T = taktNew(); }
        if (!T.copT || typeof T.copT !== 'object') { T.copT = {}; }
        c = taktCfg(c);
        var now = x.t, hz = plausV('hz', x.hz), age = num(x.hpAge), qx = num(x.q);
        if (have(qx) && have(age) && age <= TAKT.maxAgeMin && T.qLast !== qx) { if (have(T.qLast)) { T.qT = now; } T.qLast = qx; }   // Quiet-Wechsel (gelernter Deckel)
        if (!have(hz) || !have(age) || age > TAKT.maxAgeMin) { T.nOn = 0; T.nOff = 0; T.hh = []; return T; }       // keine/alte/unplausible Daten: weder an noch aus (zaehlt nicht als Stopp)
        if (hz > 0) { if (!T.nOn) { T.tOn1 = now; } T.nOn++; T.nOff = 0; } else { if (!T.nOff) { T.tOff1 = now; } T.nOff++; T.nOn = 0; }
        if (T.on !== true && T.nOn >= c.probenEin) {
            if (T.on === false && T.tStop > 0 && T.tOn1 - T.tStop < c.minAusMin * MIN && T.runs.length) {  // kurze Luecke: derselbe Lauf geht weiter (kein Start)
                var L = T.runs.pop(); T.t0 = L[0];
            } else {
                T.t0 = T.tOn1;
                if (T.on === false && T.tStop) {
                    T.starts.push(T.t0);
                    if (T.tStop > 0) { var pm = Math.round((T.t0 - T.tStop) / MIN); T.pausen.push([T.tStop, pm, pm < c.minutenPauseMin ? 'minuten' : 'bedarf']); }   // -1: aus seit Datenbeginn (Pausenlaenge unbekannt)
                }
            }
            T.on = true;
        } else if (T.on !== false && T.nOff >= c.probenAus) {
            if (T.on === true) {
                var dur = Math.round((T.tOff1 - T.t0) / MIN), atS = plausV('at', x.at);
                T.runs.push([T.t0, dur, have(atS) ? r2(atS) : null]);
                if (dur >= HG.laufMin && have(atS) && !num(x.dhw)) { T.hg = (T.hg || []).concat([[T.tOff1, r2(atS)]]).filter(function (h) { return T.tOff1 - h[0] <= HG.tage * 24 * 60 * MIN; }).slice(-200); }
            }
            T.tStop = T.on === true ? T.tOff1 : -1; T.on = false;
        }
        var lim = now - 48 * 60 * MIN;
        T.starts = T.starts.filter(function (t) { return t >= lim; }); T.runs = T.runs.filter(function (r) { return r[0] >= lim; }).slice(-60); T.pausen = T.pausen.filter(function (r) { return r[0] >= lim; }).slice(-60);
        // stabile Laufminuten: Mindestleistung je 2-K-Band und COP je Modus x Quiet x Band und Tag (ohne Abtauen/Warmwasser, ab Laufminute stabilAbMin)
        var at = plausV('at', x.at), pel = plausV('pel', x.pel), pth = plausV('pth', x.pth), q = num(x.q), hc = num(x.hc);
        if (T.on === true && hz > 0 && now - T.t0 >= c.stabilAbMin * MIN && !num(x.defrost) && !num(x.dhw) && have(at) && have(pel) && have(pth) && pel > 50 && pth > 0) {
            var k = String(Math.floor(at / TAKT.binK) * TAKT.binK), B = T.bins[k] = T.bins[k] || [];
            B.push(Math.round(pth)); if (B.length > TAKT.binMax) { B.splice(0, B.length - TAKT.binMax); }
            var dk = ymd(now), D = T.copT[dk];
            if (!D) { D = T.copT[dk] = {}; var keep = Object.keys(T.copT).sort().slice(-c.copTage); Object.keys(T.copT).forEach(function (kk) { if (keep.indexOf(kk) < 0) { delete T.copT[kk]; } }); }
            var ck = modusOf(hc) + '|' + (have(q) ? q : '?') + '|' + bandOf(at), C = D[ck] = D[ck] || [0, 0, 0, 0, 0];
            C[0] += pel / 60; C[1] += pth / 60; C[2]++; C[3] = (C[3] || 0) + hz; C[4] = Math.max(C[4] || 0, hz);   // Wh el, Wh th, Minuten, Summe Hz, hoechste Hz
            // gelernter Quiet-Deckel (C[5]): hoechste Frequenz, die deckelHaltMin Minuten am Stueck gehalten wurde, erst deckelNachQMin nach einem Quiet-Wechsel
            if (!T.qT || now - T.qT >= c.deckelNachQMin * MIN) {
                var H = T.hh = Array.isArray(T.hh) ? T.hh : [], lh = H[H.length - 1];
                if (lh && (lh[2] !== ck || now - lh[0] > 1.5 * MIN)) { H.length = 0; }
                H.push([now, hz, ck]); if (H.length > c.deckelHaltMin) { H.shift(); }
                if (H.length >= c.deckelHaltMin) { var held = Math.min.apply(null, H.map(function (h) { return h[1]; })); C[5] = have(C[5]) ? Math.max(C[5], held) : held; }
            } else { T.hh = []; }
        } else { T.hh = []; }
        return T;
    }
    function quantil(a, p) { var v = a.slice().sort(function (x, y) { return x - y; }); if (!v.length) { return null; } var i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); }
    function mindestLeistung(T, c) {                                               // [[Band-Untergrenze, 10-%-Quantil W th, n, monoton W th]]; monoton = laufendes Minimum von warm nach kalt (stooklijn)
        c = taktCfg(c);
        var ks = Object.keys((T && T.bins) || {}).map(Number).sort(function (a, b) { return b - a; }), out = [], run = null;
        ks.forEach(function (k) { var B = T.bins[String(k)]; if (B.length < c.binMinN) { return; } var qv = Math.round(quantil(B, TAKT.quantil)); run = run === null ? qv : Math.min(run, qv); out.push([k, qv, B.length, run]); });
        return out.reverse();
    }
    function taktKennzahlen(T, now, c) {
        if (!T || !Array.isArray(T.starts) || !Array.isArray(T.runs) || !Array.isArray(T.pausen)) { T = taktNew(); }
        c = taktCfg(c);
        var lim = now - TAKT.fensterH * 60 * MIN, st = T.starts.filter(function (t) { return t >= lim; }), rn = T.runs.filter(function (r) { return r[0] + r[1] * MIN >= lim; }), pz = T.pausen.filter(function (r) { return r[0] >= lim; });
        var kurz = rn.filter(function (r) { return r[1] < c.kurzMin; }).length, ka = rn.length ? r2(kurz / rn.length) : null;
        return {starts24h: st.length, startsH: r2(st.length / TAKT.fensterH), starts1h: T.starts.filter(function (t) { return t >= now - 60 * MIN; }).length, laeufe: rn.length, kurz: kurz,
                kurzAnteil: ka, minutenPausen: pz.filter(function (r) { return r[2] === 'minuten'; }).length, bedarfPausen: pz.filter(function (r) { return r[2] === 'bedarf'; }).length,
                letztePause: T.pausen.length ? T.pausen[T.pausen.length - 1][2] : null, mittelLaufMin: rn.length ? Math.round(rn.reduce(function (a, r) { return a + r[1]; }, 0) / rn.length) : null,
                takt: st.length > c.startsTagWarn || (rn.length >= 4 && ka > c.kurzAnteilWarn)};
    }
    function copSumme(T, c, now) {                                                  // {Schluessel "Modus|Quiet|Band": [Wh el, Wh th, Minuten, Summe Hz, hoechste Hz, gehaltene Hz (Deckel)]} ueber die letzten copTage Tage
        c = taktCfg(c);
        var out = {}, D = (T && T.copT) || {}, ks = Object.keys(D).sort(), von = have(now) ? ymd(now - (c.copTage - 1) * 24 * 60 * MIN) : '';
        ks.forEach(function (dk) { if (dk < von) { return; } Object.keys(D[dk]).forEach(function (k) { var a = D[dk][k], o = out[k] = out[k] || [0, 0, 0, 0, null, null]; o[0] += a[0]; o[1] += a[1]; o[2] += a[2]; o[3] += a[3] || 0; if (have(a[4])) { o[4] = o[4] === null ? a[4] : Math.max(o[4], a[4]); } if (have(a[5])) { o[5] = o[5] === null ? a[5] : Math.max(o[5], a[5]); } }); });
        return out;
    }
    function copTabelle(T, c, now) {                                               // [[Modus, Quiet, Band, COP, Minuten]] ab copMinMin Minuten je Kombination (Nutzerentscheidung 13.10.2026)
        c = taktCfg(c);
        var S = copSumme(T, c, now);
        return Object.keys(S).map(function (k) { var a = S[k], p = k.split('|'); return [p[0], p[1], p[2], a[0] > 0 ? r2(a[1] / a[0]) : null, a[2]]; })
            .filter(function (r) { return r[4] >= c.copMinMin && r[3] !== null; })
            .sort(function (a, b) { var ia = BAENDER.map(function (x) { return x[2]; }).indexOf(a[2]), ib = BAENDER.map(function (x) { return x[2]; }).indexOf(b[2]); return ia - ib || (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0)))); });
    }
    // Nachladen (13.10.): S.takt einmalig aus quiet-YYYY-MM.csv (Vormonat, laufender Monat) fuellen, damit Starts, Mindestleistung und COP sofort die vorhandenen
    // Tage zeigen. Rein: die Huelle liest die Dateien stueckweise (nur ganze Zeilen) und uebergibt den Text. Spalten und Minutenraster wie tools/engine_replay.buildInputs
    // (je Minute die letzte Zeile, Alter = Abstand zu ihr); mehrere Kopfzeilen-Versionen; Zeilen mit falscher Spaltenzahl oder rueckwaerts laufender Zeit entfallen.
    var NL_SPALTEN = {hz: 'verdichter_hz', at: 'aussen', pel: 'leistung_el_w', pth: 'leistung_th_heisha_w', q: 'quiet_aktuell', hc: 'heizregelung', defrost: 'defrost', dhw: 'warmwasser'};
    function nlNeu(dateien, now) { return {laeuft: true, dateien: dateien, i: 0, pos: 0, kopf: null, prev: null, gridT: 0, zeilen: 0, minuten: 0, von: null, start: now}; }
    function nlZeit(s) { var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; }
    function nlEmit(T, nl, t, c) { var p = nl.prev; nl.minuten++; return taktStep(T, {t: t, hpAge: (t - p.t) / MIN, hz: p.hz, at: p.at, pel: p.pel, pth: p.pth, q: p.q, hc: p.hc, defrost: p.defrost, dhw: p.dhw}, c); }
    function nlZeilen(T, text, c) {
        var nl = T.nl, L = String(text || '').split('\n');
        for (var i = 0; i < L.length; i++) {
            var l = L[i]; if (!l) { continue; }
            if (l.indexOf('zeit,') === 0) { var H = l.split(','), idx = {}; Object.keys(NL_SPALTEN).forEach(function (k) { idx[k] = H.indexOf(NL_SPALTEN[k]); }); nl.kopf = {n: H.length, idx: idx}; continue; }
            if (!nl.kopf) { continue; }
            var p = l.split(','); if (p.length !== nl.kopf.n) { continue; }
            var t = nlZeit(p[0]); if (t === null || (nl.prev && t < nl.prev.t)) { continue; }
            var x = {t: t};
            Object.keys(NL_SPALTEN).forEach(function (k) { var j = nl.kopf.idx[k]; x[k] = j >= 0 ? num(p[j]) : null; });
            if (!nl.prev) { nl.gridT = Math.ceil(t / MIN) * MIN; nl.von = t; }
            else {
                while (nl.gridT < t) {
                    if (nl.gridT - nl.prev.t > (TAKT.maxAgeMin + 1) * MIN) { T = nlEmit(T, nl, nl.gridT, c); nl.gridT = Math.ceil(t / MIN) * MIN; break; }   // grosse Luecke: einmal "keine Daten", dann springen
                    T = nlEmit(T, nl, nl.gridT, c); nl.gridT += MIN;
                }
            }
            nl.prev = x; nl.zeilen++;
        }
        return T;
    }
    function nlEnde(T, c, now) {
        var nl = T.nl || {};
        if (nl.prev) { while (nl.gridT <= nl.prev.t) { T = nlEmit(T, nl, nl.gridT, c); nl.gridT += MIN; } }
        T.nl = {laeuft: false, fertig: now, zeilen: nl.zeilen || 0, minuten: nl.minuten || 0, von: nl.von || null, bis: nl.prev ? nl.prev.t : null, dateien: (nl.dateien || []).length};
        return T;
    }

    // ------------------------------------------------------------------ Wirkzeit und Heizkurven-Bias (E, nur Auswertung/Anzeige, keine Regel; 13.10.2026)
    // Wirkzeit: Teilportierung der Idee aus smefa/ClimateOptimizer custom_components/truetemp/lag.py (MIT-Lizenz, Copyright Tomas Smedberg):
    // ereignisbasiert statt Kreuzkorrelation (im geschlossenen Regelkreis haette die Kreuzkorrelation ihr Maximum bei 0). Gemessen wird die Zeit von einem
    // Sollsprung (Soll-Vorlauf >= 1 K binnen 30 min) bis der Raum (Mittel der gueltigen Raeume) die Haelfte seiner Reaktion im 6-h-Fenster erreicht hat; Anstieg und
    // Abfall getrennt; das Fenster endet vor dem naechsten Ereignis; Raum in falscher Richtung oder < 0,08 K: verworfen; Komfortband geaendert: verworfen;
    // Median aus mindestens 3 sauberen Ereignissen. Werte aus lag.py (Fenster 6 h, Puffer 4 Tage à 15 min, 0,08 K, 3 Ereignisse, Haelfte); Sollsprung 1 K und
    // 30 min sind fuer unseren ganzzahligen Soll angepasst (ANNAHME). Fehlt ein Raumwert, beginnt der Puffer neu (Luecke wird nicht ueberbrueckt).
    var LAG = {stepMin: 15, puffer: 384, fensterMin: 360, sollK: 1, maxSchritte: 2, minReaktionK: 0.08, minEreignisse: 3, anteil: 0.5, minFenster: 2, zielK: 0.3, raumAlterMax: 360};
    function lagEvents(o, rising) {
        var want = rising ? 1 : -1, ev = [], i = 1;
        while (i < o.length) {
            var dl = o[i] - o[i - 1];
            if (dl * want <= 0) { i++; continue; }
            var start = i, tr = 0, st = 0, cur = i, qual = false;
            while (cur < o.length) { var mv = o[cur] - o[cur - 1]; if (mv * want <= 0) { break; } tr += Math.abs(mv); st++; if (tr >= LAG.sollK && st <= LAG.maxSchritte) { qual = true; cur++; break; } if (st > LAG.maxSchritte) { break; } cur++; }
            if (qual) { ev.push(start); while (cur < o.length && (o[cur] - o[cur - 1]) * want > 0) { cur++; } }
            i = Math.max(cur, i + 1);
        }
        return ev;
    }
    function lagZielEvents(z, rising) { var out = []; for (var i = 1; i < z.length; i++) { if ((z[i] - z[i - 1]) * (rising ? 1 : -1) >= LAG.zielK) { out.push(i); } } return out; }
    function lagMessen(L, rising) {
        var w = Math.round(LAG.fensterMin / LAG.stepMin), cand = lagZielEvents(L.z, rising).concat(lagEvents(L.o, rising)).sort(function (a, b) { return a - b; });
        var grenzen = lagZielEvents(L.z, true).concat(lagZielEvents(L.z, false), lagEvents(L.o, true), lagEvents(L.o, false)).sort(function (a, b) { return a - b; }), res = [];
        cand.forEach(function (s) {
            var lim = w; for (var k = 0; k < grenzen.length; k++) { if (grenzen[k] > s) { lim = Math.min(w, grenzen[k] - s - 1); break; } }
            if (lim < LAG.minFenster || s + lim >= L.r.length) { return; }
            for (var j = s; j <= s + lim; j++) { if (Math.abs(L.z[j] - L.z[s]) >= LAG.zielK) { return; } }        // Komfortband geaendert: nicht lesbar
            var base = L.r[s], tot = L.r[s + lim] - base;
            if (rising ? tot < LAG.minReaktionK : tot > -LAG.minReaktionK) { return; }
            for (var m = 1; m <= lim; m++) { if (Math.abs(L.r[s + m] - base) >= Math.abs(tot) * LAG.anteil) { res.push(m * LAG.stepMin); return; } }
        });
        if (res.length < LAG.minEreignisse) { return {min: null, n: res.length}; }
        res.sort(function (a, b) { return a - b; }); var md = res.length % 2 ? res[(res.length - 1) / 2] : (res[res.length / 2 - 1] + res[res.length / 2]) / 2;
        return {min: md, n: res.length};
    }
    function lagStep(S, d, now) {                                                    // alle 15 min eine Probe: Soll-Vorlauf, Mittel der gueltigen Raeume, Mittel ihrer Bandmitten
        var L = S.lag = (S.lag && Array.isArray(S.lag.o)) ? S.lag : {o: [], r: [], z: [], next: 0, res: null};
        if (now < L.next) { return; }
        L.next = Math.floor(now / (LAG.stepMin * MIN)) * LAG.stepMin * MIN + LAG.stepMin * MIN;
        var act = d.rooms.filter(function (r) { return r.active && have(r.min) && have(r.max); }), ok = act.filter(function (r) { return have(r.t) && have(r.age) && r.age <= LAG.raumAlterMax; });
        if (!have(d.soll) || !act.length || ok.length !== act.length) { L.o = []; L.r = []; L.z = []; return; }      // Luecke: Puffer neu
        L.o.push(d.soll); L.r.push(r2(ok.reduce(function (a, r) { return a + r.t; }, 0) / ok.length)); L.z.push(r2(ok.reduce(function (a, r) { return a + (r.min + r.max) / 2; }, 0) / ok.length));
        if (L.o.length > LAG.puffer) { L.o.shift(); L.r.shift(); L.z.shift(); }
        if (L.o.length >= Math.round(LAG.fensterMin / LAG.stepMin) + 2) { L.res = {auf: lagMessen(L, true), ab: lagMessen(L, false), n: L.o.length, t: now}; }
    }
    // Heizkurven-Bias: Teilportierung tvofi/heatpump_optimizer custom_components/heatpump_optimizer/curve_learning.py (MIT-Lizenz, Copyright tvofi, Fork von strutsfarm):
    // stehende Absenkung der Heizkurve in [-4, 0] K. Je Kalendertag die knappste Luft aller gueltigen Raeume ueber ihrem Minimum: <= 0 K -> sofort zurueck auf 0
    // (Ruecksetzung), unter 0,3 K -> Zaehler 0, sonst Zaehler +1 und nach 3 solchen Tagen -0,2 K (hoechstens 0,5 K je Woche). Abwaerts langsam und belegt,
    // aufwaerts sofort. Nur Anzeige (Shadow); die Regel "Raumeinfluss" bleibt bei +-1 K und wird davon nicht beruehrt.
    var KB = {min: -4, max: 0, wocheK: 0.5, luftK: 0.3, tage: 3, schrittK: 0.2};
    function kbTag(K, luft, now) {
        if (!have(luft)) { return K; }
        if (luft <= 0) { K.tage = 0; if (K.bias < KB.max) { K.bias = 0; K.resets++; K.lastReset = now; } return K; }
        if (luft < KB.luftK) { K.tage = 0; return K; }
        K.tage++;
        if (K.tage >= KB.tage) {
            var maxNow = K.lastStep ? KB.wocheK * (now - K.lastStep) / (7 * 24 * 60 * MIN) : KB.schrittK, stp = Math.min(KB.schrittK, maxNow);
            if (stp > 0) { K.bias = Math.round(Math.min(KB.max, Math.max(KB.min, K.bias - stp)) * 100) / 100; K.tage = 0; K.lastStep = now; }
        }
        return K;
    }
    function kbStep(S, d, now) {                                                     // knappste Luft je Kalendertag (gueltige Raeume, Datenalter wie in der Bewertung), bei Tageswechsel buchen
        var K = S.kb = (S.kb && have(S.kb.bias)) ? S.kb : {bias: 0, tage: 0, resets: 0, lastStep: 0, lastReset: 0, day: '', luft: null, tageGesamt: 0};
        var dk = ymd(now);
        if (K.day && K.day !== dk) { kbTag(K, K.luft, now); if (have(K.luft)) { K.tageGesamt++; } K.luft = null; }
        K.day = dk;
        d.rooms.forEach(function (r) { if (r.active && have(r.t) && have(r.min) && have(r.age) && r.age <= SCORE.raumAlterMax) { var m = r.t - r.min; K.luft = have(K.luft) ? Math.min(K.luft, m) : m; } });
    }

    // Kennzahl "Hochlauf nach dem Start" (Nutzer vorlaeufig 13.10.: den Comfort/Quiet-0-Hochlauf nicht deckeln, nur messen): Minuten mit mindestens hzHoch in den
    // ersten HL.min Laufminuten, je Heizregelung und Tag, 7 Tage (Regel-Review LS-2)
    var HL = {min: 25, tage: 7};
    function hochlaufStep(S, d, cfg) {
        var H = S.hl = (S.hl && typeof S.hl === 'object') ? S.hl : {}, dk = ymd(d.now), m = modusOf(d.hc);
        if (!d.fresh || !d.running || d.runMin >= HL.min || !have(d.hz) || (m !== 'Comfort' && m !== 'Efficiency')) { return; }
        var T = H[dk] = H[dk] || {}, x = T[m] = T[m] || [0, 0];
        if (d.runMin < 1.5 && (!S.hlStart || S.hlStart !== S.run.start)) { x[1]++; S.hlStart = S.run.start; }       // Starts
        if (d.hz >= cfg.rules.quiet_strecken.hzHoch) { x[0]++; }
        Object.keys(H).sort().slice(0, -HL.tage).forEach(function (k) { delete H[k]; });
    }
    function hochlaufSumme(S) { var o = {Comfort: [0, 0], Efficiency: [0, 0]}; Object.keys(S.hl || {}).forEach(function (k) { ['Comfort', 'Efficiency'].forEach(function (m) { var x = S.hl[k][m]; if (x) { o[m][0] += x[0]; o[m][1] += x[1]; } }); }); return o; }

    // ------------------------------------------------------------------ Schnappschuss fuer den Datensatz (gerundet; reicht zum Nachspielen)
    var SNAP_KEYS = ['hpAge', 'hz', 'vl', 'rl', 'soll', 'dT', 'pel', 'pth', 'flow', 'pump', 'q', 'qPrio', 'hc', 'at', 'defrost', 'dhw', 'ss', 'rt', 'shift', 'heatMode', 'z1Sensor',
                     'heaterI', 'heaterE', 'htrOnAT', 'htrStartDelta', 'htrDelay', 'heatOffAT', 'sollKurve', 'block', 'otherQ', 'otherShift', 'kzRad'];
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
        if (!(S.takt && S.takt.nl && S.takt.nl.laeuft)) { S.takt = taktStep(S.takt, inp, cfg.takt); }     // waehrend des Nachladens fuehrt die Datei, nicht die Live-Eingabe
        d.takt = taktKennzahlen(S.takt, now, cfg.takt);
        d.tc = cfg.takt; d.copSum = copSumme(S.takt, cfg.takt, now);                     // Daten je Heizregelung x Quiet x Band: Zielstufen und Deckel der Quiet-Regeln
        lagStep(S, d, now); kbStep(S, d, now);                                          // Wirkzeit und Heizkurven-Bias (nur Auswertung)
        tgUpdate(S, d); d.vsBase = tagesgang(S, now); d.vsDk = bedarfK(d.vs, cfg.rules.vorausschau, d.vsBase);
        d.bedQ = bedarfQ(S, d, cfg); if (d.bedQ.ja && d.fresh) { S.bedT = now; } d.bedT = S.bedT;   // Bedarf der Quiet-Stufe (Freigabe; Ausschluss fuer den Deckel)
        d.kaltQ = kaltQ(d, cfg.rules.quiet_freigabe);                                   // Kaelte-Vorsorge (Regel-Review B4)
        hochlaufStep(S, d, cfg);                                                        // Kennzahl: Hochlauf nach dem Start (Comfort/Efficiency, nur Anzeige)
        var QE = quietEnde(S, d, cfg);                                                   // Rueckweg-Gruende der Quiet-Regeln (vor der Auswertung: sie beenden auch die Zuordnung)
        // Quiet: eine uebernommene Stufe gehoert ihrer Regel nur, solange deren Grund besteht. Gilt ihr Rueckweg-Grund oder ist die Frist abgelaufen (und kein Bedarf
        // haelt sie), endet die Zuordnung, auch wenn niemand zurueckstellt (z. B. von Hand uebernommen); danach gilt die Gegenrichtungs-Sperre ab jetzt.
        var AQ = S.arbQ;
        if (AQ.applied && d.q === AQ.applied.w) {
            var ar = AQ.applied.rule, mxD = cfg.rules[ar] && have(cfg.rules[ar].maxDauerMin) ? cfg.rules[ar].maxDauerMin : null;
            if (!QE.halten[ar] && (QE.ende[ar] || (mxD && now - AQ.applied.ts >= mxD * MIN))) {
                AQ.last = {rule: ar, dir: sgnOf(AQ.applied.w - AQ.applied.von), w: AQ.applied.w, von: AQ.applied.von, start: AQ.applied.ts, end: now, lapse: true, grund: QE.ende[ar] || 'Frist abgelaufen'}; AQ.applied = null;
            }
        }
        [['shift', S.arb], ['quiet', S.arbQ]].forEach(function (x) {                     // Arbitrierung nach dem Laden eines aelteren Zustands: laufenden Vorschlag als Eigentuemer eintragen
            var A = x[1]; if (A.owner) { return; }
            RULES.forEach(function (R) { var p0 = S.rules[R.id].prop; if (p0 && (p0.groesse || R.groesse) === x[0] && !A.owner) { A.owner = R.id; A.soll = p0.cmd.value; A.von = p0.von; A.start = p0.ts; } });
        });
        var res = [], ev = [], locks = {};
        var owner0 = S.arb.owner;
        RULES.forEach(function (R) { res.push(evalRule(R, d, S, cfg, inp)); });
        // Uebergabe ohne Luecke: gab die Eigentuemer-Regel die Verschiebung erst nach einer anderen Verschiebungs-Regel frei (Reihenfolge der Auswertung),
        // wird diese in derselben Minute noch einmal geprueft (ein Ende-Ereignis der ersten Pruefung bleibt erhalten)
        if (owner0 && !S.arb.owner) {
            RULES.forEach(function (R, i) { if ((R.groesse === 'shift' || res[i].groesse === 'shift') && R.id !== owner0 && res[i].locks.indexOf('vorrang') >= 0) { var e0 = res[i].ende; res[i] = evalRule(R, d, S, cfg, inp); if (e0 && !res[i].ende) { res[i].ende = e0; } } });
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
        // Gruende fuer den Rueckweg einer laufenden Uebernahme (die Uebernahme-Funktion entscheidet selbst; Schluessel "regel|groesse" vor "regel")
        var ende = QE.ende, halten = QE.halten;
        // Deckel/Laufzeit, Hebel Heizkurve +1 K (Regel-Review B5): zurueck bei Heizstab-Naehe, wenn ein Raum mehr als notK ueber die Bandmitte steigt (Gegenspieler
        // Raumeinfluss −1 K) oder wenn nach der Uebernahme kurveTaktZyklen Laeufe ohne Takt-Beleg endeten
        var kc = cfg.rules.quiet_strecken, ak = S.arb.applied && S.arb.applied.rule === 'quiet_strecken' ? S.arb.applied : null, mitte = null;
        d.rooms.forEach(function (r) { if (r.active && r.valid && have(r.min) && have(r.max)) { var u = r.t - (r.min + r.max) / 2; if (u > d.notK && (!mitte || u > mitte.u)) { mitte = {r: r, u: u}; } } });
        if (d.htrNear) { ende['quiet_strecken|shift'] = 'Heizstab-Nähe (Außen ' + de(d.at, 0) + ' °C)'; }
        else if (mitte) { ende['quiet_strecken|shift'] = mitte.r.name + ' ' + de(mitte.u, 1) + ' K über der Bandmitte'; }
        else if (ak) {
            var lang = S.runs.filter(function (x) { return x[0] >= ak.ts && x[1] >= kc.kurzerLaufMin; }).length;
            if (lang >= kc.kurveTaktZyklen && !taktBeleg(d, kc)) { ende['quiet_strecken|shift'] = lang + ' Läufe ohne Takt seit der Übernahme'; }
        }
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
        var kvNow = d.korr && have(num(d.korr.v)) ? num(d.korr.v) : null, rV = res.filter(function (x) { return x.id === 'vorausschau'; })[0];
        if (sh !== 0 && kvNow === d.shift) { halten.vorausschau = 'Raumeinfluss verlangt dieselbe Verschiebung (' + sg(d.shift, 0) + ' K)'; halten['quiet_strecken|shift'] = halten.vorausschau; }
        if (sh !== 0 && d.vs && d.vs.gate && dkv !== null && sh * dkv >= cv.deltaK && rV && rV.locks.indexOf('modell') < 0 && !(sh > 0 ? d.roomAbove.length : d.roomBelow.length)) { halten.raum_offset = 'Vorausschau verlangt dieselbe Verschiebung (' + sg(d.shift, 0) + ' K)'; }
        Object.keys(halten).forEach(function (k) { delete ende[k]; });
        S.last = now;
        var rec = {t: iso(now), mv: VER, sv: svOf(cfg), in: snapshot(inp),
                   abl: {z: d.zustand, lauf_min: r2(d.runMin), vl_rueck: r2(d.vlRueck), rl_rueck: r2(d.rlRueck), erreicht: d.reached ? 1 : 0, vl_k_h: r2(d.vlSlope), stopp_in_min: r2(d.stopEtaMin), starts_3h: d.starts3h, vs_dk: d.vsDk},
                   r: res.map(function (x) { var o = {id: x.id, v: x.v, st: x.st, grund: x.grund}; if (x.naechste) { o.naechste = recNext(x.naechste); } if (x.p) { o.p = x.p; } if (x.locks.length) { o.sperren = x.locks; } return o; }),
                   vorschlag: prop ? prop.id : null};
        // Takt-Kennzahlen im Datensatz kompakt [Starts 24 h, Anteil kurzer Laeufe, Minutenpausen, Bedarfspausen], nur bei Aenderung und zur vollen Stunde
        // (jede Minute waeren es ~130 kB/Tag; Budget der Datensaetze 2,7 MB/Tag)
        var tkA = [d.takt.starts24h, d.takt.kurzAnteil, d.takt.minutenPausen, d.takt.bedarfPausen], tkS = JSON.stringify(tkA);
        if (tkS !== S.tkLast || new Date(now).getMinutes() === 0) { rec.abl.tk = tkA; S.tkLast = tkS; }
        if (d.unpl.length) { rec.abl.unpl = d.unpl; }                                          // unplausible Eingaenge dieser Minute (gelten als fehlend)
        return {S: S, d: d, res: res, prop: prop, rec: rec, ev: ev, scores: sc, ende: ende, halten: halten, locks: locks};
    }
    function recNext(nx) { var o = {}; ['b', 'ist', 's', 'abstand', 'u', 'weitere', 'halt', 'bis'].forEach(function (k) { if (nx[k] !== undefined && nx[k] !== null && nx[k] !== '') { o[k] = nx[k]; } }); return o; }

    // ------------------------------------------------------------------ Punktesystem (automatisch, ohne Nutzereingabe)
    // (1) Ausloeser-Prognose je Fall (Vorschlag): Brier-Prinzip gegen die Basisrate "bleibt, wie es ist" in gleichartigen Lagen.
    // (2) Wirkungsprognose nur, wenn eine gleichwertige Aenderung tatsaechlich passiert (z. B. Quiet von Hand); Kalibriermessungen zaehlen 0.
    // (3) Schaden und (4) Verpasst als feste Abzuege. Unsicher oder zu wenig Daten = 0.
    function roomScore(r) { return r.active && have(r.t) && have(r.min) && have(r.max) && (r.valid || (have(r.age) && r.age <= SCORE.raumAlterMax)); }
    // Art des Trackers je Regel und Hebel: "deckel_frei" (Quiet-Freigabe: Verdichter am Deckel mit Rueckstand), "hz_hoch" (Deckel/Laufzeit Quiet: Verdichter >= hzHoch),
    // "lauf_ende" (Laufzeit: Lauf endet im Horizont; Deckel/Laufzeit +1 K und bis v3), sonst die Regel selbst. Aeltere Zustaende ohne Art: bisheriges Verhalten.
    function kindOf(rule, hebel, ver) {
        if (rule === 'quiet_freigabe') { return 'deckel_frei'; }
        if (rule === 'quiet_strecken') { return (ver || 1) >= 4 && hebel !== 'shift' ? 'hz_hoch' : 'lauf_ende'; }
        return rule;
    }
    function tKind(T) { return T.kind || kindOf(T.rule, null, 3); }
    function bkOf(R, hebel) { return hebel === 'shift' && R.basisKurve ? R.basisKurve : (R.basis || R.id); }   // Schluessel der Basisrate (neue Ausloesung = neue Vergleichslagen)
    function problemNow(T, d, cfg) {                                               // liegt das vorhergesagte Problem in dieser Minute vor? 1 / 0 / null (unbekannt)
        var rule = T.rule, ctx = T.ctx || {}, kind = tKind(T), c = cfg.rules[rule];
        if (!d.fresh) { return null; }
        if (kind === 'deckel_frei') { if (!d.running) { return null; } var cap = have(ctx.cap) ? ctx.cap + 1 : 20; return (have(d.hz) && d.hz <= cap && have(d.rlRueck) && d.rlRueck >= 1.0) ? 1 : 0; }   // v1: fest 20 Hz
        if (kind === 'hz_hoch') { return (d.running && have(d.hz) && d.hz >= cfg.rules.quiet_strecken.hzHoch) ? 1 : 0; }
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
    function newTracker(rule, now, ctx, d) { ctx.bands = bandsOf(d); var T = {rule: rule, t0: now, ctx: ctx, cut: 0, stop: 0, stopVlStop: false, wasRun: false, ser: []}; if (ctx.kind) { T.kind = ctx.kind; } if (ctx.H) { T.H = ctx.H; } return T; }
    function trackerUpdate(T, d, cfg) {
        var now = d.now, H = (T.H || Math.max.apply(null, RULE[T.rule].prognose.h)) * MIN, kind = tKind(T);
        if (now - T.t0 > H || T.cut) { return; }
        if (now > T.t0 && (d.qChanged || d.shiftChanged || Math.abs(d.sollJump) >= 2)) { T.cut = now; T.cutWhy = d.qChanged ? 'Quiet geändert' + (d.qBy ? ' (Vorschlag „' + RULE[d.qBy].kurz + '“ übernommen)' : '') : (d.shiftChanged ? 'Verschiebung geändert' + (d.shiftBy ? ' (Vorschlag „' + RULE[d.shiftBy].kurz + '“ übernommen)' : '') : 'Soll von Hand geändert'); return; }   // Eingriff von aussen: ab hier keine Gegenfaktik mehr
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
        if (kind === 'lauf_ende') { if (!T.stop && T.wasRun && !d.running && d.fresh) { T.stop = now; } if (d.running) { T.wasRun = true; } return; }
        var pr = problemNow(T, d, cfg);
        if (pr !== null) { T.ser.push([now - T.t0, pr]); }
        if (kind === 'deckel_frei' && T.wasRun && !d.running && d.fresh && !T.stop) { T.stop = now; T.stopVlStop = have(d.vlRueck) && d.vlRueck <= -2; }
        if (d.running) { T.wasRun = true; }
    }
    function outcome(T, h) {                                                       // Ergebnis o (1 = Problem bestand, 0 = loeste sich von selbst, null = unsicher)
        var H = h * MIN, end = T.cut ? Math.min(T.cut, T.t0 + H) : T.t0 + H, span = (end - T.t0) / MIN;
        if (span < SCORE.teilMin * h) { return {o: null, why: T.cut ? 'Eingriff nach ' + Math.round(span) + ' min: ' + (T.cutWhy || '') : 'zu kurz beobachtet'}; }
        var kind = tKind(T);
        if (kind === 'lauf_ende') {
            if (T.stop && T.stop - T.t0 <= H) { return {o: 1, why: 'Lauf endete nach ' + mins(T.stop - T.t0) + ' min'}; }
            if (T.cut && T.cut < T.t0 + H) { return {o: null, why: 'Eingriff'}; }
            return {o: 0, why: 'Lauf lief länger als ' + h + ' min'};
        }
        var ser = T.ser.filter(function (p) { return p[0] <= H; });
        if (kind === 'deckel_frei' && T.stop && T.stop - T.t0 <= H && T.stopVlStop) { return {o: 0, why: 'Verdichter holte auf und schaltete ab'}; }
        if (T.rule === 'raum_offset' || T.rule === 'vorausschau') {                  // Raum: letzter gueltiger Wert in den letzten 30 min vor dem Horizont
            if (T.cut && T.cut < T.t0 + H) { return {o: null, why: 'Eingriff nach ' + mins(T.cut - T.t0) + ' min: ' + (T.cutWhy || '')}; }
            var lastP = ser.filter(function (p) { return p[0] >= H - 30 * MIN; });
            if (!lastP.length) { return {o: null, why: 'Raumwert am Horizont ungültig'}; }
            if (T.rule === 'vorausschau') { return {o: lastP[lastP.length - 1][1], why: lastP[lastP.length - 1][1] ? 'Raum am Bandrand' : 'Raum mit Luft im Band'}; }
            return {o: lastP[lastP.length - 1][1], why: lastP[lastP.length - 1][1] ? 'Raum weiter außerhalb des Bandes' : 'Raum wieder im Band'};
        }
        if (ser.length < SCORE.teilMin * h * ((kind === 'deckel_frei' || kind === 'hz_hoch') ? 0.5 : 0.3)) { return {o: null, why: 'zu wenige gültige Minuten (' + ser.length + ')'}; }
        if (T.rule === 'heizgrenze_hinweis') { return ser.some(function (p) { return p[1] === 0; }) ? {o: 0, why: 'ein Raum fiel unter Minimum'} : {o: 1, why: 'alle Räume blieben über Minimum + Reserve'}; }
        var f = ser.reduce(function (a, p) { return a + p[1]; }, 0) / ser.length;
        if (f >= SCORE.trefferAnteil) { return {o: 1, why: 'Problem in ' + Math.round(f * 100) + ' % der Minuten'}; }
        if (f <= 1 - SCORE.trefferAnteil) { return {o: 0, why: 'Problem nur in ' + Math.round(f * 100) + ' % der Minuten'}; }
        return {o: null, why: 'unklar (' + Math.round(f * 100) + ' %)'};
    }
    function brier(p, b, o) { return SCORE.brierFaktor * (Math.pow(b - o, 2) - Math.pow(p - o, 2)); }   // > 0, wenn die Prognose p naeher am Ergebnis liegt als die Basisrate b
    // Punkte eines Horizonts (vor der Teilung durch die Anzahl Horizonte) je Bewertungsversion: {pts, bp ('' | 'neutral' | 'abzug'), bRef (Basisrate der Rechnung, null = kein Skill-Beitrag)}
    // v5 (Weg b): b >= p -> Treffer neutral (0, kein Skill-Beitrag), Fehlalarm Abzug gegen SCORE.fehlRefB (hoechstens 0); b < p und bis v4: Brier gegen b
    function hPunkte(p, b, o, sv) {
        if ((sv || 1) >= 5 && b >= p) {
            if (o === 1) { return {pts: 0, bp: 'neutral', bRef: null}; }
            return {pts: Math.min(0, brier(p, SCORE.fehlRefB, o)), bp: 'abzug', bRef: SCORE.fehlRefB};
        }
        return {pts: brier(p, b, o), bp: '', bRef: b};
    }
    function baseRate(sc, key, h) { var b = (sc.base[key] || {})[h]; if (!b || b[0] < SCORE.baseMinN) { return {b: 0.5, n: b ? b[0] : 0}; } return {b: (b[1] + 1) / (b[0] + 2), n: b[0]}; }
    function candidateNow(rule, d, cfg, hebel) {                                     // Vergleichslage fuer die Basisrate (schwaecher als der Ausloeser)
        var c = cfg.rules[rule];
        if (!d.fresh) { return null; }
        if (rule === 'quiet_freigabe') {                                             // v2: am (gelernten) Deckel mit Rueckstand UND Bedarf (wie die neue Ausloesung, ohne Haltezeit/Vorlauf-Schwelle)
            var cap = deckelOf(d, d.q).hz;
            return (have(d.q) && d.q >= 1 && d.running && d.runMin >= c.laufMin && have(d.hz) && have(cap) && d.hz >= cap - 1 && have(d.rlRueck) && d.rlRueck >= 1.0 && d.bedQ && d.bedQ.ja) ? {cap: cap} : null;
        }
        if (rule === 'quiet_strecken' && hebel === 'shift') { return (d.running && d.runMin >= c.laufMin && taktBeleg(d, c) && have(d.hz) && d.hz < c.hzHoch) ? {} : null; }
        if (rule === 'quiet_strecken') { return (have(d.q) && d.q < 3 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz >= c.hzHoch && have(d.at) && d.at > c.atMinC) ? {} : null; }
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
    function svOf(cfg) { return cfg && [1, 2, 3, 4].indexOf(cfg.sv) >= 0 ? cfg.sv : SCORE_VER; }
    function ohnePunkte(rule, sv) { return (sv || 1) >= 4 && !!RULE[rule] && RULE[rule].art === 'hinweis'; }   // v4: Hinweise werden gezaehlt, nicht gepunktet
    // Summen je Regel, Regelversion und Bewertungsversion (v1 behaelt den alten Schluessel "regel|vN", damit alte Punkte unveraendert getrennt bleiben)
    function tot(sc, rule, ver, sv) { var k = rule + '|v' + ver + (sv > 1 ? '|s' + sv : ''); return sc.tot[k] = sc.tot[k] || {rule: rule, ver: ver, sv: sv, since: 0, punkte: 0, faelle: 0, bewertet: 0, treffer: 0, fehlalarm: 0, neutral: 0, bs: 0, bsRef: 0, schaden: 0, verpasst: 0, verpasstSperre: 0, wirkN: 0, wirkP: 0, kalib: 0, trefferNeutral: 0, skillN: 0}; }
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
        if (!ohnePunkte(rec.regel, rec.sv)) { sc.hist.push([now, rec.regel, T.punkte, rec.sv]); }   // v4: Hinweise nicht im Diagramm
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
            var R = RULE[r.id], p = S.rules[r.id].prop, hb = p.hebel || null, prog = (hb === 'shift' && R.prognoseKurve) ? R.prognoseKurve : R.prognose;
            var lead = p.lead || (d.roomBelow[0] ? d.roomBelow[0].name : ''), cap = r.id === 'quiet_freigabe' ? deckelOf(d, d.q).hz : null;
            sc.cases.push({id: p.id, rule: r.id, v: R.ver, sv: sv, t0: now, p: prog.p, h: prog.h.slice(), txt: prog.text, bk: bkOf(R, hb), dir: p.dir, done: [], hr: [], pts: 0,
                           tr: newTracker(r.id, now, {lead: lead, dir: p.dir, kind: kindOf(r.id, hb, R.ver), H: Math.max.apply(null, prog.h), cap: cap}, d), dmg: r.locks.length ? ['sperre_verletzt'] : []});
        });
        // 2) Faelle fortschreiben, Horizonte abschliessen
        sc.cases.forEach(function (C) {
            trackerUpdate(C.tr, d, cfg);
            damageUpdate(C, d, cfg);
            C.h.forEach(function (h) {
                if (C.done.indexOf(h) >= 0 || now - C.t0 < h * MIN) { return; }
                C.done.push(h);
                var oc = outcome(C.tr, h), br = baseRate(sc, C.bk || C.rule, h), pts = 0, np = ohnePunkte(C.rule, C.sv), bp = '';
                if (oc.o !== null && !np) {
                    var hp = hPunkte(C.p, br.b, oc.o, C.sv || 1), bRef = hp.bRef; bp = hp.bp;
                    if (bRef !== null) {
                        pts = hp.pts / C.h.length;
                        if ((C.sv || 1) >= 4) { C.bs = (C.bs || 0) + Math.pow(C.p - oc.o, 2); C.bsRef = (C.bsRef || 0) + Math.pow(bRef - oc.o, 2); C.bsN = (C.bsN || 0) + 1; }   // v4: erst beim Abschluss des Falls in die Summen
                        else { var T0 = tot(sc, C.rule, C.v, C.sv || 1); T0.bs += Math.pow(C.p - oc.o, 2); T0.bsRef += Math.pow(bRef - oc.o, 2); }      // bis v3: schon je Horizont
                    }
                }
                var hrec = {h: h, o: oc.o, b: r2(br.b), nb: br.n, punkte: r2(pts), why: oc.why}; if (bp) { hrec.bp = bp; }
                C.hr.push(hrec);
                C.pts += pts;
            });
            if (C.done.length === C.h.length && !C.closed) {
                C.closed = true;
                var T = tot(sc, C.rule, C.v, C.sv || 1), os = C.hr.filter(function (x) { return x.o !== null; });
                var erg = os.length ? (os.filter(function (x) { return x.o === 1; }).length * 2 >= os.length ? 'treffer' : 'fehlalarm') : 'neutral';
                var nP = ohnePunkte(C.rule, C.sv);
                T.faelle++; if (os.length) { T.bewertet++; } if (erg === 'treffer') { T.treffer++; } else if (erg === 'fehlalarm') { T.fehlalarm++; } else { T.neutral++; }
                // v5: Treffer, dessen Treffer-Horizonte alle wegen b >= p neutral zaehlten (eigene Kennzahl "davon neutral")
                var hitH = os.filter(function (x) { return x.o === 1; }), tn = erg === 'treffer' && hitH.length > 0 && hitH.every(function (x) { return x.bp === 'neutral'; });
                if (tn) { T.trefferNeutral = (T.trefferNeutral || 0) + 1; }
                if ((C.sv || 1) >= 4 && os.length && !nP && ((C.sv || 1) < 5 || C.bsN)) { T.bs += C.bs || 0; T.bsRef += C.bsRef || 0; T.skillN = (T.skillN || 0) + 1; }   // v4: Brier-Summen nur aus abgeschlossenen Faellen; v5: nur mit Brier-Beitrag
                var rec0 = {t: iso(now), typ: 'ausloeser', regel: C.rule, v: C.v, sv: C.sv || 1, fall: C.id, p: C.p, horizonte: C.hr, ergebnis: erg, punkte: r2(C.pts),
                            text: (C.txt || RULE[C.rule].prognose.text) + ': ' + C.hr.map(function (x) { return x.h + ' min ' + (x.o === null ? 'neutral (' + x.why + ')' : (x.o ? 'ja' : 'nein') + ' (' + x.why + ', Basisrate ' + de(x.b, 2) + (x.bp === 'neutral' ? ' ≥ Prognose ' + de(C.p, 2) + ': neutral' : (x.bp === 'abzug' ? ' ≥ Prognose ' + de(C.p, 2) + ': Abzug gegen Basisrate ' + de(SCORE.fehlRefB, 2) : '')) + ')'); }).join(' · ') + (nP ? ' · nur Hinweis, keine Punkte' : '')};
                if (tn) { rec0.treffer_neutral = 1; }
                book(sc, recs, rec0, now);
                if (C.dmg.length) {
                    var sum = 0; if (!nP) { C.dmg.forEach(function (k) { sum += SCORE.schaden[k]; }); }
                    T.schaden += C.dmg.length;
                    book(sc, recs, {t: iso(now), typ: 'schaden', regel: C.rule, v: C.v, sv: C.sv || 1, fall: C.id, arten: C.dmg.slice(), punkte: sum, text: 'Hätte nach den Daten geschadet: ' + C.dmg.map(function (k) { return DMG_TEXT[k]; }).join(', ') + (nP ? ' (nur Hinweis, keine Punkte)' : '')}, now);
                }
            }
        });
        sc.cases = sc.cases.filter(function (C) { return !C.closed; });
        // Vergleichslagen fuer die Basisrate: je Regel hoechstens eine je 15 min (Raum/Heizgrenze: je 60 min), damit sich Faelle kaum ueberlappen
        RULES.forEach(function (R) {
            [null].concat(R.prognoseKurve ? ['shift'] : []).forEach(function (hb) {      // Deckel/Laufzeit: eigene Vergleichslagen je Hebel
                var slot = roomRule(R.id) ? 60 : 15, sk = Math.floor(now / (slot * MIN)), bk = bkOf(R, hb), prog = hb === 'shift' ? R.prognoseKurve : R.prognose;
                if (sc.lastSlot[bk] === sk) { return; }
                var cn = candidateNow(R.id, d, cfg, hb);
                if (cn) { sc.lastSlot[bk] = sk; sc.cands.push({rule: R.id, bk: bk, t0: now, h: prog.h.slice(), done: [], tr: newTracker(R.id, now, {lead: cn.lead, dir: cn.dir, kind: kindOf(R.id, hb, R.ver), H: Math.max.apply(null, prog.h), cap: cn.cap}, d)}); }
            });
        });
        sc.cands.forEach(function (C) {
            trackerUpdate(C.tr, d, cfg);
            C.h.forEach(function (h) {
                if (C.done.indexOf(h) >= 0 || now - C.t0 < h * MIN) { return; }
                C.done.push(h);
                var oc = outcome(C.tr, h), key = C.bk || C.rule;
                if (oc.o !== null) { var B = sc.base[key] = sc.base[key] || {}; var b = B[h] = B[h] || [0, 0]; b[0]++; b[1] += oc.o; }
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
        // 6) Messaufgabe Heizkurve +1 K (keine Punkte): Lauf- und Pausendauer vor und nach einer Verschiebung 0 -> +1 K (Kalibrierung von laufPlusMin/pauseMinusMin)
        lzStep(sc, d, S, cfg, recs, sv);
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
            if (d.q < d.qFrom && d.running) {                                       // Quiet-Freigabe v2: jede Senkung (Ziel 0, 1 oder 2), v1 nur auf 0
                if (have(d.rlRueck) && d.rlRueck >= cfg.rules.quiet_freigabe.rlRueckK) {
                    sc.eff.push({rule: 'quiet_freigabe', t0: now, art: 'freigabe', ziel: d.q, capAlt: deckelOf(d, d.qFrom).hz, pel0: S._pelPrev, vl0: S._vlPrev, kal: isKal('quiet_freigabe', now), m: {}, text: 'Quiet ' + d.qFrom + ' → ' + d.q + ' bei Rücklauf ' + de(d.rlRueck, 1) + ' K unter Soll'});
                } else if (have(d.rlRueck) && d.rlRueck < 0.5) {
                    sc.eff.push({rule: 'quiet_freigabe', t0: now, art: 'ohne_bedarf', kal: isKal('quiet_freigabe', now), m: {}, text: 'Quiet ' + d.qFrom + ' → ' + d.q + ' ohne Rücklauf-Rückstand (' + rueckTxt(d.rlRueck) + ')'});
                }
            }
            if (d.q > d.qFrom && d.q >= 1 && d.running && have(S._hzPrev) && S._hzPrev >= cfg.rules.quiet_strecken.hzHoch) {      // seit v3 jede Erhoehung (Zielstufe 1, 2 oder 3)
                sc.eff.push({rule: 'quiet_strecken', t0: now, art: 'deckel', pel0: S._pelPrev, kal: isKal('quiet_strecken', now), m: {}, text: 'Quiet ' + d.qFrom + ' → ' + d.q + ' bei ' + de(S._hzPrev, 0) + ' Hz'});
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
        if (E.art === 'freigabe' && have(E.ziel) && E.ziel > 0) {                      // v2, Ziel Quiet 1 oder 2: Frequenz ueber den alten Deckel (13.10. 16:36: 17 -> 20-21 Hz, +80-100 W)
            if (dt <= 10 && have(d.hz) && d.running && (m.hzMax === undefined || d.hz > m.hzMax)) { m.hzMax = d.hz; }
            if (dt >= 2 && dt <= 10 && have(d.pel) && d.running) { m.pelS = (m.pelS || 0) + d.pel; m.pelN = (m.pelN || 0) + 1; }
            if (!d.running && dt <= 10) { m.stop = true; }
            if (dt >= 10 || m.stop) {
                var dpz = (m.pelN && have(E.pel0)) ? m.pelS / m.pelN - E.pel0 : null, sollHz = have(E.capAlt) ? E.capAlt + 3 : null;
                closeEffect(E, [['Verdichter mindestens ' + de(sollHz, 0) + ' Hz binnen 10 min', m.hzMax !== undefined && have(sollHz) ? (m.hzMax >= sollHz ? 1 : -1) : 0, 'gemessen ' + de(m.hzMax, 0) + ' Hz'],
                                ['Leistung +60 W oder mehr', have(dpz) ? (dpz >= 60 ? 1 : -1) : 0, 'gemessen ' + sg(dpz, 0) + ' W']], sc, recs, now);
            }
        } else if (E.art === 'freigabe') {
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
        } else if (E.art === 'deckel') {                                               // v4: Quiet hoeher deckelt binnen 10 min auf <= 21 Hz (nach Wechseln nach oben fiel die Frequenz in 5-15 min, 12.10. 09:30)
            if (dt <= 10 && have(d.hz) && d.running) { m.hzMin = Math.min(m.hzMin === undefined ? 99 : m.hzMin, d.hz); }
            if (dt >= 5 && dt <= 10 && have(d.pel) && d.running) { m.pelS = (m.pelS || 0) + d.pel; m.pelN = (m.pelN || 0) + 1; }
            if (dt >= 10) {
                var dp2 = (m.pelN && have(E.pel0)) ? m.pelS / m.pelN - E.pel0 : null;
                closeEffect(E, [['Verdichter ≤ 21 Hz binnen 10 min', m.hzMin !== undefined ? (m.hzMin <= 21 ? 1 : -1) : 0, 'gemessen ' + de(m.hzMin, 0) + ' Hz'], ['Leistung −100 W oder mehr', have(dp2) ? (dp2 <= -100 ? 1 : -1) : 0, 'gemessen ' + sg(dp2, 0) + ' W']], sc, recs, now);
            }
        } else if (E.art === 'verschiebung') {
            if (dt <= 6 && have(d.soll) && have(E.soll0) && d.soll - E.soll0 === E.dshift) { m.ok = true; }        // der Soll folgt im 5-min-Raster (Regel-Review R3)
            if (dt >= 6 || m.ok) { closeEffect(E, [['Soll-Vorlauf folgt binnen 6 min um ' + sg(E.dshift, 0) + ' K', m.ok ? 1 : -1, m.ok ? 'ja' : 'nein']], sc, recs, now); }
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
    var EXCUSE = ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'regler', 'heizstab', 'modell'];
    var OWN_TEXT = {abstand: 'Mindestabstand', tageslimit: 'Tageslimit', abkuehlzeit: 'Wartezeit', haltezeit: 'Haltezeit', stabil: 'Stabilitätszeit', vorrang: 'Verschiebung einer anderen Regel', gegenrichtung: 'Wartezeit Gegenrichtung'};
    var MISS_DMG_TEXT = {komfort: 'Raum mehr als 1 K unter Minimum', takt: 'Verdichter stoppte', ueberschwingen: 'Vorlauf über der Abschaltgrenze (Soll +3,25 K)'};
    function stdOf(R, key) { var x = R.schwellen.filter(function (s) { return s.key === key; })[0]; return x ? x.std : null; }
    // Haelt die Regel in dieser Minute NUR eine eigene Sperre/Wartezeit zurueck? -> {ids: [...]} (mit Standardwerten gueltig), {ext: [...]} (nur wegen
    // verlaengerter Werte) oder null (andere Gruende: Bedingung fehlt, fremde Sperre, Vorschlag ...)
    function ownBlock(R, r, d, S, cfg, sv) {
        var own = SCORE.verpasstSperre.eigene.concat(sv >= 3 ? SCORE.verpasstSperre.gegenregel : []), rs = S.rules[R.id], c = cfg.rules[R.id], now = d.now, ok = [], ext = [], gr = (r && r.groesse) || R.groesse;
        if (!r) { return null; }
        if (r.st === 'gesperrt' && r.locks.length) {
            if (!r.locks.every(function (l) { return own.indexOf(l) >= 0; })) { return null; }
            r.locks.forEach(function (l) {
                var std = false;
                if (l === 'abstand') { var chg = (gr === 'quiet' || gr === 'shift') ? Math.max(S.qChg || 0, S.shiftChg || 0) : 0; std = !!chg && now - chg < LOCK_CFG.gapMin * MIN; }
                if (l === 'tageslimit') { std = rs.n >= stdOf(R, 'proTag'); }
                if (l === 'abkuehlzeit') { std = rs.cool - (c.pauseMin - stdOf(R, 'pauseMin')) * MIN > now; }
                if (l === 'vorrang') { std = true; }                                        // Eigentum einer anderen Regel: kein Zeitwert
                if (l === 'gegenrichtung') { var Ag = arbOf(S, gr), qg = gr === 'quiet', e0 = Ag && Ag.last ? (r.hart && qg && Ag.last.lapse ? Ag.last.start : arbEnd(Ag, d, gr)) : 0; std = !!(Ag && Ag.last) && now - e0 < (r.hart ? (qg ? LOCK_CFG.notfallMin : LOCK_CFG.shiftHaltMin) : (qg ? LOCK_CFG.quietGegenMin : LOCK_CFG.gegenMin)) * MIN; }
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
            if (R.id === 'vorausschau') { if (sv >= 3) { missedVs(R, S, sc, d, cfg, res, recs, sv); } return; }
            var G = sc.gt[R.id] = sc.gt[R.id] || {since: 0, prop: false, excused: false, booked: false, lead: ''};
            var r = res.filter(function (x) { return x.id === R.id; })[0], c = cfg.rules[R.id];
            var cond = false, need = 20, lead = '';
            if (R.id === 'quiet_freigabe') {                                             // v2: 20 min am (gelernten) Deckel mit >= 2 K Ruecklauf-Rueckstand UND Bedarf
                var capV = deckelOf(d, d.q).hz;
                cond = d.fresh && have(d.q) && d.q >= 1 && d.running && d.runMin >= c.laufMin && have(d.hz) && have(capV) && d.hz >= capV - 1 && have(d.rlRueck) && d.rlRueck >= 2.0 && !!(d.bedQ && d.bedQ.ja); need = 20; lead = d.bedQ && d.bedQ.raum ? d.bedQ.raum.name : '';
            }
            if (R.id === 'quiet_strecken') {                                             // v4 (Quiet-Hebel): 20 min mit >= hzHoch ohne Bedarf, Komfort sicher, ueber atMinC, Zielstufe aus den Daten
                cond = d.fresh && have(d.q) && d.q < 3 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz >= c.hzHoch && !!d.bedQ && !d.bedQ.ja && have(d.rlRueck) && d.rlRueck <= c.rlRueckMaxK &&
                       komfortSicher(d, c).ok && (!d.bedT || now - d.bedT >= c.ruheMin * MIN) && have(d.at) && d.at > c.atMinC && zielDeckel(d, c).ziel !== null; need = 20;
            }
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
 // Verpasst der Vorausschau (seit v3): Lage = Gate offen und alle Bedingungen der Regel erfuellt (Bedarfsaenderung >= Schwelle aus dem Wetter, Raeume
    // im Band mit Luft), 60 min am Stueck ohne Vorschlag (auch keiner einer anderen Verschiebungs-Regel in dieselbe Richtung) und ohne Sicherheits-/Datensperre.
    // Bewertet wird erst, ob die Lage WIRKLICH eintrat (bis zum Fensterende +bisH): ein Raum verlaesst das Band in der vorhergesagten Richtung, oder die gemessene
    // Aussentemperatur (um den Tagesgang bereinigt) zeigt mindestens die halbe Schwelle. Trat nichts ein, gibt es keinen Eintrag. Neutralitaet wie bei den
    // anderen Regeln: nur eigene/Gegenregel-Sperren mit Standardwerten -> "verpasst_sperre" (0); Raum > 1 K unter Minimum hebt das auf (+1 K).
    var VS_NEED = 60;
    function missedVs(R, S, sc, d, cfg, res, recs, sv) {
        var now = d.now, c = cfg.rules[R.id], G = sc.gt[R.id] = sc.gt[R.id] || {since: 0, pend: []}, r = res.filter(function (x) { return x.id === R.id; })[0];
        G.pend = G.pend || [];
        var cond = !!(d.fresh && d.vs && d.vs.gate && have(d.vsDk) && Math.abs(d.vsDk) >= c.deltaK && r && !r.dauer && (r.st === 'wartet' || r.st === 'vorschlag' || r.st === 'abgelaufen' || (r.st === 'gesperrt' && r.locks.indexOf('modell') < 0)));
        if (cond) {
            var dir = d.vsDk > 0 ? 1 : -1;
            if (!G.since || G.dir !== dir) { G.since = now; G.dir = dir; G.prop = false; G.excused = false; G.booked = false; G.last = now; G.frei = 0; G.gesperrt = 0; G.ids = []; G.ext = []; }
            if (r.st === 'vorschlag' || (S.arb.owner && S.arb.owner !== R.id && sgnOf(S.arb.soll - S.arb.von) === dir)) { G.prop = true; }
            if (r.locks.some(function (l) { return EXCUSE.indexOf(l) >= 0; })) { G.excused = true; }
            var dt = Math.min(Math.max(0, now - (G.last || now)), 2 * MIN), ob = ownBlock(R, r, d, S, cfg, sv);
            G.last = now;
            if (ob && ob.ids) { G.gesperrt += dt; ob.ids.forEach(function (x) { if (G.ids.indexOf(x) < 0) { G.ids.push(x); } }); }
            else { G.frei += dt; if (ob && ob.ext) { ob.ext.forEach(function (x) { if (G.ext.indexOf(x) < 0) { G.ext.push(x); } }); } }
            if (!G.booked && !G.prop && !G.excused && now - G.since >= VS_NEED * MIN) {
                G.booked = true;
                var b = d.vsBase, shW = 0; for (var h = c.vonH; h <= c.bisH; h++) { shW += b.at[h]; } shW /= (c.bisH - c.vonH + 1);
                G.pend.push({win: G.since, t0: now, ab: G.since, dir: dir, dk: d.vsDk, frei: G.frei >= VS_NEED * MIN, ids: G.ids.slice(), ext: G.ext.slice(), at0: d.at, sh0: b.at[0], shW: shW, s: 0, n: 0, raum: '', dmg: [],
                             tb: have(d.vs.tbal) ? d.vs.tbal : 15});
            }
            G.pend.forEach(function (P) { if (P.win === G.since) { P.frei = G.frei >= VS_NEED * MIN; P.ids = G.ids.slice(); P.ext = G.ext.slice(); } });   // die Lage haelt an: freie Minuten zaehlen weiter
        } else { G.since = 0; }
        G.pend = G.pend.filter(function (P) {
            var w0 = P.t0 + c.vonH * HOUR, w1 = P.t0 + c.bisH * HOUR;
            if (d.fresh && have(d.at) && now >= w0 && now <= w1) { P.s += d.at; P.n++; }
            d.rooms.forEach(function (x) {
                if (!roomScore(x)) { return; }
                if (!P.raum && (P.dir > 0 ? x.t < x.min : x.t > x.max)) { P.raum = x.name + (P.dir > 0 ? ' unter Minimum' : ' über Maximum'); }
                if (P.dir > 0 && x.t < x.min - SCORE.verpasstSperre.komfortK && P.dmg.indexOf('komfort') < 0) { P.dmg.push('komfort'); }
            });
            var ist = null;
            if (now >= w1 && P.n >= 0.5 * (w1 - w0) / MIN) { var aW = P.s / P.n; ist = r2(Math.max(0, P.tb - (aW - P.shW)) - Math.max(0, P.tb - (P.at0 - P.sh0))); }
            var real = P.raum || (ist !== null && P.dir * ist >= c.deltaK / 2);
            if (!real && now < w1) { return true; }
            if (real) {
                var why = 'Seit ' + hhmm(P.ab) + ' sagte die Vorhersage ' + sg(P.dk, 1) + ' K Bedarf aus dem Wetter voraus, ohne Vorschlag; eingetreten: ' + (P.raum || 'gemessen ' + sg(ist, 1) + ' K (um den Tagesgang bereinigt)');
                var T = tot(sc, R.id, R.ver, sv), sp = P.ids.map(function (x) { return OWN_TEXT[x]; }).join(', ');
                if (P.frei || P.dmg.length) {
                    T.verpasst++;
                    book(sc, recs, {t: iso(now), typ: 'verpasst', regel: R.id, v: R.ver, sv: sv, ab: iso(P.ab), punkte: SCORE.verpasst, sperre: P.ids.length ? P.ids : undefined, schaden: P.dmg.length ? P.dmg : undefined,
                                    text: why + (P.frei ? (P.ext.length ? '; über den Standardwert verlängert: ' + P.ext.map(function (x) { return OWN_TEXT[x] || x; }).join(', ') : '') : ' · während eigener Sperre (' + sp + '), aber Schaden: ' + P.dmg.map(function (k) { return MISS_DMG_TEXT[k]; }).join(', ') + ' → nicht entschuldigt')}, now);
                } else {
                    T.verpasstSperre++;
                    book(sc, recs, {t: iso(now), typ: 'verpasst_sperre', regel: R.id, v: R.ver, sv: sv, ab: iso(P.ab), punkte: 0, sperre: P.ids, text: why + '; die Regel durfte nur wegen eigener Sperre (' + sp + ') keinen machen, kein Schaden: neutral'}, now);
                }
            }
            return false;
        });
        if (G.pend.length > 20) { G.pend = G.pend.slice(-20); }
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
    // Messaufgabe "Heizkurve +1 K" (Deckel/Laufzeit v4): die Wirkung von +1 K auf Lauf und Pause ist nicht gemessen (Verzoegerungstest steht aus). Bei jeder Verschiebung
    // 0 -> +1 K (von wem auch immer) wird der Zyklus davor (letzter Lauf, Pause davor) mit dem ersten Lauf verglichen, der danach endet, und der Pause danach. Ein Befund je Fall.
    function lzStep(sc, d, S, cfg, recs, sv) {
        var Z = sc.lz = sc.lz || {offen: null, n: 0, letzter: null}, now = d.now, c = cfg.rules.quiet_strecken;
        if (d.shiftChanged && d.shiftFrom === 0 && d.shift === 1) { Z.offen = {t: now, laufVor: d.lastRunMin, pauseVor: d.lastPauseMin, durch: d.shiftBy || ''}; return; }
        var O = Z.offen; if (!O) { return; }
        if (d.shiftChanged) { Z.offen = null; return; }                                    // Verschiebung wieder geaendert: kein Befund
        if (!have(O.lauf)) { var lr = S.runs.length ? S.runs[S.runs.length - 1] : null; if (lr && lr[0] + lr[1] * MIN > O.t) { O.lauf = lr[1]; O.stop = lr[0] + lr[1] * MIN; } return; }
        if (S.lastStart > O.stop) {
            var pz = mins(S.lastStart - O.stop);
            Z.letzter = {t: now, lauf: [O.laufVor, O.lauf], pause: [O.pauseVor, pz]}; Z.n++; Z.offen = null;
            book(sc, recs, {t: iso(now), typ: 'messaufgabe', art: 'laufzeit_1k', regel: 'quiet_strecken', v: RULE.quiet_strecken.ver, sv: sv, punkte: 0, lauf: Z.letzter.lauf, pause: Z.letzter.pause,
                            text: 'Befund Heizkurve +1 K' + (O.durch ? ' (Vorschlag „' + RULE[O.durch].kurz + '“)' : '') + ': Lauf ' + de(O.laufVor, 0) + ' → ' + de(O.lauf, 0) + ' min, Pause ' + de(O.pauseVor, 0) + ' → ' + pz + ' min (Annahme: Lauf +' + c.laufPlusMin + ' min, Pause −' + c.pauseMinusMin + ' min)'}, now);
        }
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
            var nP = ohnePunkte(R.id, sv);
            var skill = nP || (sv >= 4 && (sv >= 5 ? T.skillN : T.bewertet) < SCORE.skillMinFaelle) ? null : (T.bsRef > 0 ? 1 - T.bs / T.bsRef : null);   // v4: erst ab 3 bewerteten Faellen, nie fuer Hinweise; v5: ab 3 Faellen mit Brier-Beitrag
            var crit = nP ? [] : [
                {k: 'faelle', ok: T.bewertet >= SCORE.reife.faelle, kurz: 'Fälle ' + T.bewertet + '/' + SCORE.reife.faelle, text: T.bewertet + ' von ' + SCORE.reife.faelle + ' bewerteten Fällen'},
                {k: 'tage', ok: days >= SCORE.reife.tage, kurz: 'Tage ' + de(days, 1) + '/' + SCORE.reife.tage, text: de(days, 1) + ' von ' + SCORE.reife.tage + ' Tagen'},
                {k: 'skill', ok: have(skill) && skill >= SCORE.reife.skill, kurz: 'Skill ' + (have(skill) ? de(skill, 2) : '–') + '/' + de(SCORE.reife.skill, 1), text: 'Brier-Skill ' + (have(skill) ? de(skill, 2) : '–') + ' (mindestens ' + de(SCORE.reife.skill, 1) + ')'},
                {k: 'schaden', ok: T.schaden === 0, kurz: 'Schaden ' + T.schaden, text: T.schaden + ' × Schaden'},
                {k: 'verpasst', ok: T.verpasst <= SCORE.reife.verpasst, kurz: 'Verpasst ' + T.verpasst + '/≤' + SCORE.reife.verpasst, text: T.verpasst + ' × verpasst (höchstens ' + SCORE.reife.verpasst + ')'}
            ];
            if (R.art === 'befehl' && !nP) { crit.push({k: 'wirkung', ok: T.wirkN - T.kalib >= SCORE.reife.wirkFaelle && T.wirkP > 0, kurz: 'Wirkung ' + (T.wirkN - T.kalib) + '/' + SCORE.reife.wirkFaelle, text: (T.wirkN - T.kalib) + ' von ' + SCORE.reife.wirkFaelle + ' Wirkungsfällen (ohne Kalibrierung), ' + sg(T.wirkP, 0) + ' Punkte'}); }
            out.push({regel: R.id, name: R.name, v: R.ver, art: R.art, punkte: nP ? null : T.punkte, ohnePunkte: nP, faelle: T.faelle, bewertet: T.bewertet, treffer: T.treffer, trefferNeutral: T.trefferNeutral || 0, skillFaelle: T.skillN || 0, fehlalarm: T.fehlalarm, neutral: T.neutral,
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
    // engMaxAlterMin/engAbbruchMin (Regel-Review B7): Rueckweg-Gruende und "halten" der Maschine gelten nur, wenn sie hoechstens 5 min alt sind (sonst gilt die Frist);
    // rechnet die Maschine 30 min nicht, geht jede bestaetigte Uebernahme auf ihren Ausgangswert zurueck (sicherer Abbruch: der Wert des Nutzers vor dem Klick)
    var APPLY = {maxAlterMin: 2.5, hpMaxAgeMin: 5, abstandMin: 10, proTag: 6, doppelMs: 120000, rueckleseS: 90, wiederholungen: 2, rueckwegVersuche: 3, engMaxAlterMin: 5, engAbbruchMin: 30};
    // Uebernahmen je Groesse (seit 13.10.2026, Regel-Review R6): A.ak = {quiet: …, shift: …}; Quiet und Verschiebung koennen nebeneinander uebernommen sein, wenn die
    // Arbitrierung der Maschine es zulaesst (Mindestabstand ueber beide Groessen). A.aktiv = die juengste (Anzeige, aeltere Leser, Kern-Guard bis zur Haertung).
    function newApply() { return {mv: VER, ak: {}, aktiv: null, pending: null, day: '', n: 0, lastSend: 0, verworfen: [], lastClick: null, alarm: null}; }
    function gOfCmd(name) { var W = WHITELIST[name]; return W && W.ruecklese === 'q' ? 'quiet' : 'shift'; }
    function fixApply(A) {
        A = (A && A.mv === VER) ? A : newApply();
        if (!A.ak || typeof A.ak !== 'object') { A.ak = {}; }
        var a0 = A.aktiv;                                                             // aelterer Zustand bzw. von aussen gesetzte Uebernahme: in A.ak eintragen
        if (a0 && a0.name && WHITELIST[a0.name]) { var g0 = gOfCmd(a0.name); if (A.ak[g0] !== a0 && !(A.ak[g0] && A.ak[g0].id === a0.id)) { A.ak[g0] = a0; } }
        return A;
    }
    function akList(A) { return ['quiet', 'shift'].map(function (g) { return A.ak[g]; }).filter(function (a) { return !!a; }); }
    function syncAktiv(A) { var L = akList(A).sort(function (x, y) { return y.ts - x.ts; }); A.aktiv = L.length ? L[0] : null; }
    // Fortsetzung einer Uebernahme (Regel-Review B1): dieselbe Regel und derselbe Befehl in derselben Richtung, die Anlage steht bestaetigt auf dem uebernommenen Wert,
    // kein Rueckweg offen. Dann ersetzt der neue Wert den alten, der Ausgangswert (Rueckweg) bleibt.
    function fortsetzung(a, p) {
        if (!a || !p || !p.cmd) { return false; }
        var dv = sgnOf(p.cmd.value - num(p.von));
        return a.rule === p.rule && a.name === p.cmd.name && a.bestaetigt === true && !a.rueckFehl && !a.zurueck && num(p.von) === a.value && dv !== 0 && dv === sgnOf(a.value - a.von);
    }
    function cmdOk(name, value) { var W = WHITELIST[name]; if (!W) { return 'Befehl ' + name + ' steht nicht auf der Whitelist'; } if (W.werte.indexOf(value) < 0) { return 'Wert ' + value + ' für ' + name + ' nicht erlaubt (' + W.werte.join(', ') + ')'; } return null; }
    function cmdMsg(name, value, source) { return {topic: WHITELIST[name].topic, payload: String(value), source: source}; }
    function fresh(plant) { return have(num(plant.hpAge)) && num(plant.hpAge) <= APPLY.hpMaxAgeMin; }
    // ctx: {now, enabled (Hauptschalter), knoten (false = Sendeknoten opt_apply_mqtt deaktiviert erzeugt), rules (freigegebene Regel-IDs), eng (OPT_engine: {ts, prop, locks}),
    //       plant ({q, shift, hpAge, block, heatMode, z1Sensor}), cfg, endReason, halten}
    function applyRequest(A, req, ctx) {
        A = fixApply(A);
        var r = applyRequest0(A, req, ctx); syncAktiv(r.A); return r;
    }
    function applyRequest0(A, req, ctx) {
        var now = ctx.now, out = {A: A, send: [], toast: null, log: []}, act = req && req.topic, pl = (req && req.payload) || {}, plant = ctx.plant || {};
        function deny(text, color) { out.toast = {text: text, color: color || 'red'}; out.log.push({t: iso(now), aktion: act || '?', ergebnis: 'abgelehnt', grund: text, id: pl.id || null}); return out; }
        var day = ymd(now); if (A.day !== day) { A.day = day; A.n = 0; }
        if (act === 'sperren') { out.sperren = true; out.toast = {text: 'Übernahme gesperrt (Hauptschalter aus).', color: 'orange'}; out.log.push({t: iso(now), aktion: 'sperren', ergebnis: 'ok'}); return out; }
        if (act === 'verwerfen') {
            if (!pl.id) { return deny('Kein Vorschlag angegeben.'); }
            if (A.verworfen.indexOf(pl.id) < 0) { A.verworfen.push(pl.id); A.verworfen = A.verworfen.slice(-20); }
            out.toast = {text: 'Vorschlag ausgeblendet (keine Bewertung, die Punkte bleiben unberührt).', color: ''}; out.log.push({t: iso(now), aktion: 'verwerfen', ergebnis: 'ok', id: pl.id}); return out;
        }
        if (act === 'zuruecksetzen') {                                                // alle Uebernahmen zurueck, nacheinander (je ein Befehl offen)
            var L0 = akList(A);
            if (!L0.length) { return deny('Nichts zurückzusetzen: keine aktive Übernahme.', 'orange'); }
            if (num(plant.block) === 1) { return deny('Alle MQTT-Befehle sind gesperrt (MQTT.block_active). Nichts gesendet.'); }
            L0.forEach(function (a) { a.zurueck = 'Zurücksetzen (Klick)'; delete a.rueckFehl; });
            return startReturn(A, ctx, out, 'Zurücksetzen (Klick)', L0.sort(function (x, y) { return y.ts - x.ts; })[0]);
        }
        if (act !== 'uebernehmen') { return deny('Unbekannte Aktion.'); }
        // ---- Prüfkette für "Übernehmen" (jede Stufe mit eigenem Grund; nichts vom Browser wird ungeprüft übernommen)
        if (A.lastClick && A.lastClick.id === pl.id && now - A.lastClick.ts < APPLY.doppelMs) { return deny('Schon übernommen (Doppelklick ignoriert).', 'orange'); }
        if (ctx.enabled !== true) { return deny('Übernahme gesperrt: Hauptschalter OPT_apply_enabled ist aus. Nichts gesendet.'); }
        if (ctx.knoten === false) { return deny('Übernahme gesperrt: der Sendeknoten opt_apply_mqtt ist deaktiviert (Flows ohne --uebernahme-knoten-aktiv erzeugt). Nichts gesendet.'); }
        var eng = ctx.eng || {}, p = eng.prop;
        if (!eng.ts || now - eng.ts > APPLY.maxAlterMin * MIN) { return deny('Die Entscheidungsmaschine hat seit über 2 min nicht gerechnet. Nichts gesendet.'); }
        if (!p || p.id !== pl.id) { return deny('Der angezeigte Vorschlag ist nicht mehr aktuell. Nichts gesendet.'); }
        if (checksum(p) !== pl.sum || p.sum !== pl.sum) { return deny('Prüfsumme stimmt nicht. Nichts gesendet.'); }
        if (p.art !== 'befehl') { return deny('Dies ist nur ein Hinweis, er kann nicht übernommen werden.'); }
        if ((ctx.rules || []).indexOf(p.rule) < 0) { return deny('Übernahme für die Regel „' + p.rule + '“ ist nicht freigegeben. Nichts gesendet.'); }
        if (now >= p.bis) { return deny('Der Vorschlag ist abgelaufen. Nichts gesendet.'); }
        var bad = cmdOk(p.cmd.name, p.cmd.value); if (bad) { return deny(bad + '. Nichts gesendet.'); }
        var badR = cmdOk(p.cmd.name, num(p.von)); if (badR) { return deny('Rückweg unmöglich: Ausgangswert ' + p.von + ' liegt außerhalb der Whitelist (' + WHITELIST[p.cmd.name].werte.join(', ') + '). Nichts gesendet.'); }
        var W = WHITELIST[p.cmd.name];
        if (W.topic !== p.cmd.topic) { return deny('Topic passt nicht zur Whitelist. Nichts gesendet.'); }
        if (num(plant.block) === 1) { return deny('Alle MQTT-Befehle sind gesperrt (MQTT.block_active). Nichts gesendet.'); }
        if (!fresh(plant)) { return deny('Anlagendaten sind veraltet. Nichts gesendet.'); }
        if (eng.locks && eng.locks[p.rule] && eng.locks[p.rule].length) { return deny('Gesperrt: ' + eng.locks[p.rule].join(', ') + '. Nichts gesendet.'); }
        var ist = num(plant[W.ruecklese]);
        if (ist !== p.von) { return deny('Die Anlage steht nicht mehr auf ' + p.von + ' (jetzt ' + (ist === null ? 'unbekannt' : ist) + '). Nichts gesendet.'); }
        if (W.heizkurve && (num(plant.heatMode) !== 0 || num(plant.z1Sensor) !== 0)) { return deny('Verschiebung nur im Heizkurvenmodus mit Wasserfühler. Nichts gesendet.'); }
        if (A.pending) { return deny('Ein Befehl wartet noch auf die Bestätigung der Anlage. Nichts gesendet.', 'orange'); }
        // je Groesse eine Uebernahme (jede hat ihren Rueckweg); dieselbe Regel darf sie in derselben Richtung fortsetzen (Regel-Review B1, R6)
        var g = gOfCmd(p.cmd.name), a0 = A.ak[g], fort = fortsetzung(a0, p);
        if (a0 && !fort) { return deny('Für ' + (g === 'quiet' ? 'die Quiet-Stufe' : 'die Verschiebung') + ' läuft schon eine Übernahme (' + (RULE[a0.rule] ? RULE[a0.rule].kurz : a0.rule) + ', ' + a0.von + ' → ' + a0.value + '); erst zurücksetzen oder den Rückweg abwarten. Nichts gesendet.', 'orange'); }
        if (A.lastSend && now - A.lastSend < APPLY.abstandMin * MIN) { return deny('Zu schnell: frühestens ' + hhmm(A.lastSend + APPLY.abstandMin * MIN) + '. Nichts gesendet.', 'orange'); }
        if (A.n >= APPLY.proTag) { return deny('Tageslimit von ' + APPLY.proTag + ' Befehlen erreicht. Nichts gesendet.'); }
        // ---- senden: genau der angezeigte Vorschlag
        var R = RULE[p.rule], cr = ctx.cfg && ctx.cfg.rules && ctx.cfg.rules[p.rule], maxD = have(num(p.maxDauerMin)) ? num(p.maxDauerMin) : (cr && have(num(cr.maxDauerMin)) ? num(cr.maxDauerMin) : null);
        var until = maxD ? now + maxD * MIN : null;
        A.n++; A.lastSend = now; A.lastClick = {id: p.id, ts: now}; A.alarm = null;
        A.pending = {name: p.cmd.name, value: p.cmd.value, ts: now, versuche: 1, art: 'uebernahme', id: p.id, g: g, vorher: num(p.von)};
        A.ak[g] = {id: p.id, rule: p.rule, groesse: p.groesse || R.groesse, name: p.cmd.name, value: p.cmd.value, von: fort ? a0.von : p.von, ts: now, bis: until, bestaetigt: false,
                   start: fort ? (a0.start || a0.ts) : now, schritte: fort ? (a0.schritte || 1) + 1 : 1};
        out.send.push(cmdMsg(p.cmd.name, p.cmd.value, 'Optimierer (Klick)'));
        out.toast = {text: R.name + ': ' + p.was + (fort ? ' (Fortsetzung; Rückweg weiter auf ' + a0.von + ')' : '') + ' gesendet. Warte auf die Bestätigung der Anlage …', color: ''};
        var lg = {t: iso(now), aktion: 'uebernehmen', ergebnis: 'gesendet', id: p.id, sum: p.sum, regel: p.rule, v: p.ver, befehl: p.cmd.name, topic: p.cmd.topic, wert: p.cmd.value, von: A.ak[g].von, bis: until ? iso(until) : null};
        if (fort) { lg.fortsetzung = A.ak[g].schritte; }
        out.log.push(lg);
        return out;
    }
    function startReturn(A, ctx, out, why, a) {
        var now = ctx.now, g = gOfCmd(a.name), bad = cmdOk(a.name, a.von);
        if (bad) { a.rueckFehl = now; delete a.zurueck; A.alarm = {ts: now, text: 'Rückweg unmöglich: ' + bad + '. Bitte von Hand einstellen.'}; out.toast = {text: A.alarm.text, color: 'red'}; out.log.push({t: iso(now), aktion: 'rueckweg', ergebnis: 'abgelehnt', grund: bad}); return out; }   // einmal melden, nicht in jedem Takt
        if (A.pending && A.pending.art === 'rueckweg') { out.toast = {text: 'Der Rückweg läuft bereits.', color: 'orange'}; return out; }
        if (A.pending && (A.pending.g || gOfCmd(A.pending.name)) !== g) { out.toast = {text: 'Ein Befehl der anderen Größe wartet noch auf die Bestätigung; der Rückweg folgt danach.', color: 'orange'}; return out; }
        A.pending = {name: a.name, value: a.von, ts: now, versuche: 1, art: 'rueckweg', id: a.id, g: g};
        A.lastSend = now;
        out.send.push(cmdMsg(a.name, a.von, 'Optimierer (Rückweg)'));
        out.toast = {text: why + ': ' + WHITELIST[a.name].text + ' zurück auf ' + a.von + ' gesendet.', color: ''};
        out.log.push({t: iso(now), aktion: 'rueckweg', ergebnis: 'gesendet', grund: why, id: a.id, befehl: a.name, wert: a.von});
        return out;
    }
    // alle 15 s: Ruecklesen (Bestaetigung), begrenzte Wiederholung, Warnung bei Abweichung, automatischer Rueckweg (Ablauf, Grund entfallen, Maschine steht)
    function applyTick(A, ctx) {
        A = fixApply(A);
        var r = applyTick0(A, ctx); syncAktiv(r.A); return r;
    }
    function applyTick0(A, ctx) {
        var now = ctx.now, out = {A: A, send: [], toast: null, log: []}, P = A.pending, plant = ctx.plant || {}, blocked = num(plant.block) === 1;
        if (P) {
            var gP = P.g || gOfCmd(P.name), aP = A.ak[gP], W = WHITELIST[P.name], ist = num(plant[W.ruecklese]);
            if (ist === P.value && fresh(plant)) {
                A.pending = null;
                if (P.art === 'uebernahme' && aP) { aP.bestaetigt = true; aP.bestTs = now; delete aP.unbestaetigt; out.toast = {text: W.text + ' steht jetzt auf ' + P.value + ' (von der Anlage bestätigt).', color: 'green'}; }
                if (P.art === 'rueckweg') { out.toast = {text: W.text + ' wieder auf ' + P.value + ' (bestätigt). Übernahme beendet.', color: 'green'}; delete A.ak[gP]; }
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
                    // Anlage steht nachweislich noch auf dem Wert vor dem Befehl: es gibt nichts zurueckzusetzen, die Uebernahme endet (eine Fortsetzung faellt auf die vorige
                    // Stufe zurueck); sonst blockierte sie diese Groesse fuer jeden weiteren Klick. Unklarer Ist-Wert: aktiv lassen, "Zuruecksetzen" bleibt moeglich.
                    if (P.art === 'uebernahme' && aP) {
                        var vorher = have(P.vorher) ? P.vorher : aP.von;
                        if (ist === vorher && fresh(plant)) { if (vorher === aP.von) { delete A.ak[gP]; } else { aP.value = vorher; aP.bestaetigt = true; aP.schritte = Math.max(1, (aP.schritte || 2) - 1); } }
                        else { aP.unbestaetigt = true; }
                    }
                    // Rueckweg ohne Bestaetigung: nicht automatisch neu starten (sonst alle 4,5 min wieder 3 Befehle, ohne Ende); "Zuruecksetzen" bleibt moeglich
                    if (P.art === 'rueckweg' && aP) { aP.rueckFehl = now; delete aP.zurueck; }
                }
            }
            return out;
        }
        // Maschine frisch? Sonst gelten nur die Fristen; steht sie engAbbruchMin, sicherer Abbruch (Regel-Review B7)
        var eng = ctx.eng || {}, engAge = num(eng.ts) ? (now - num(eng.ts)) / MIN : Infinity, engOk = engAge <= APPLY.engMaxAlterMin;
        var L = akList(A).sort(function (x, y) { return x.ts - y.ts; });
        for (var i = 0; i < L.length; i++) {
            var a = L[i], g = gOfCmd(a.name), W2 = WHITELIST[a.name], ist2 = num(plant[W2.ruecklese]);
            if (a.rueckFehl) {                                                               // Rueckweg abgebrochen: nichts mehr automatisch senden, nur den Ist-Wert beobachten
                if (have(ist2) && fresh(plant) && ist2 === a.von) {
                    delete A.ak[g]; out.toast = {text: W2.text + ' steht wieder auf ' + a.von + ' (nachträglich bestätigt). Übernahme beendet.', color: 'green'};
                    out.log.push({t: iso(now), aktion: 'bestaetigt', art: 'rueckweg', befehl: a.name, wert: a.von, nachtraeglich: true});
                } else if (have(ist2) && fresh(plant) && ist2 !== a.value) {
                    A.alarm = {ts: now, text: W2.text + ' wurde von außen auf ' + ist2 + ' geändert (Übernahme ' + a.value + '). Kein automatischer Rückweg.'};
                    out.toast = {text: A.alarm.text, color: 'orange'}; out.log.push({t: iso(now), aktion: 'fremde_aenderung', befehl: a.name, soll: a.value, ist: ist2}); delete A.ak[g];
                }
                continue;
            }
            if (a.bestaetigt && have(ist2) && ist2 !== a.value && fresh(plant)) {            // fremde Aenderung: nicht zuruecksetzen, nur warnen und die Uebernahme beenden
                if (a.zurueck && ist2 === a.von) { delete A.ak[g]; continue; }                // (Zuruecksetzen schon erledigt)
                A.alarm = {ts: now, text: W2.text + ' wurde von außen auf ' + ist2 + ' geändert (Übernahme ' + a.value + '). Kein automatischer Rückweg.'};
                out.toast = {text: A.alarm.text, color: 'orange'}; out.log.push({t: iso(now), aktion: 'fremde_aenderung', befehl: a.name, soll: a.value, ist: ist2}); delete A.ak[g]; continue;
            }
            if (blocked) { continue; }                                                       // Notbremse: warten, nicht zaehlen
            var why = null;
            var kg = a.rule + '|' + (a.groesse || ''), hk = engOk ? (ctx.halten || {}) : {}, ek = engOk ? (ctx.endReason || {}) : {};
            var haupt = !a.groesse || !RULE[a.rule] || RULE[a.rule].groesse === a.groesse;     // Schluessel "regel" gilt nur fuer die Hauptgroesse der Regel (Deckel/Laufzeit: Quiet; +1 K hat "quiet_strecken|shift")
            var halt = hk[kg] || (haupt ? hk[a.rule] : null), er = ek[kg] || (haupt ? ek[a.rule] : null);   // Uebergabe/Bedarf: die Groesse wird weiter gebraucht -> kein Rueckweg (kein Hin und Her)
            if (a.zurueck) { why = a.zurueck; }
            else if (!engOk && engAge >= APPLY.engAbbruchMin && a.bestaetigt) { why = 'Rückweg: die Entscheidungsmaschine rechnet seit ' + (num(eng.ts) ? hhmm(num(eng.ts)) : 'unbekannt') + ' nicht mehr (sicherer Abbruch)'; }
            else if (a.bis && now >= a.bis && !halt) { why = 'Rückweg nach Ablauf (' + hhmm(a.bis) + ')' + (engOk ? '' : ', Maschine ohne frische Gründe'); }
            else if (a.bestaetigt && er) { why = 'Rückweg: ' + er; }
            if (why && fresh(plant)) { return startReturn(A, ctx, out, why, a); }
        }
        return out;
    }

    return {VER: VER, SCORE_VER: SCORE_VER, RULES: RULES, RULE: RULE, LOCKS: LOCKS, LOCK_CFG: LOCK_CFG, SCORE: SCORE, WHITELIST: WHITELIST, APPLY: APPLY,
            brier: brier, hPunkte: hPunkte, vorschau: vorschau, bedarfK: bedarfK, VS_LIM: VS_LIM, PLAUS: PLAUS, tagesgang: tagesgang, defaults: defaults, mergeCfg: mergeCfg, newState: newState, fixState: fixState, step: step, report: report, messStatus: messStatus, MESS: MESS, TAKT: TAKT, TAKT_SCHWELLEN: TAKT_SCHWELLEN, taktCfg: taktCfg, taktNew: taktNew, taktStep: taktStep, taktKennzahlen: taktKennzahlen, mindestLeistung: mindestLeistung, copSumme: copSumme, copTabelle: copTabelle, bandOf: bandOf, modusOf: modusOf, nlNeu: nlNeu, nlZeilen: nlZeilen, nlEnde: nlEnde, HG: HG, heizgrenzeBeob: heizgrenzeBeob, LAG: LAG, lagMessen: lagMessen, lagStep: lagStep, KB: KB, kbTag: kbTag, kbStep: kbStep, snapshot: snapshot, unsnap: unsnap,
            checksum: checksum, newApply: newApply, applyRequest: applyRequest, applyTick: applyTick, fortsetzung: fortsetzung, gOfCmd: gOfCmd, iso: iso, ymd: ymd, zielDeckel: zielDeckel, zielFrei: zielFrei, deckelOf: deckelOf, deckelTab: deckelTab, DECKEL: DECKEL,
            bedarfQ: bedarfQ, raumTrend: raumTrend, komfortSicher: komfortSicher, nutzenKurve: nutzenKurve, kindOf: kindOf, kaltQ: kaltQ, zielKalt: zielKalt, nachtMin: nachtMin, HL: HL, hochlaufSumme: hochlaufSumme,
            hhmm: hhmm, isoWeek: isoWeek, de: de, sg: sg};
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = ENGINE; }
// == ENGINE-CORE-ENDE ==

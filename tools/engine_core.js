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
        {id: 'stoerung', kurz: 'Störung', text: 'Störung der Anlage (Fehlercode)', herkunft: 'HeishaMon Error (TOP44) meldet einen Fehlercode. H23 ist ein L-spezifischer Fehler (Kältemittelfühler Innengerät; Abhilfe Platinentausch über Panasonic, Forum 189605: 3483282, 4130989, 4571850; L5 Bj. 07/2023: 4694333). Solange ein Fehlercode ansteht: keine Vorschläge, keine Übernahme, kein automatischer Rückweg; kein automatischer Reset (Forum F9-a)'},
        {id: 'mqtt_sperre', kurz: 'MQTT-Notbremse', text: 'Alle MQTT-Befehle sind gesperrt (MQTT.block_active)', herkunft: 'HeishaMoNR-Notbremse; sie friert den Zustand ein (Opus-Review 09.10.)'},
        {id: 'abtauen', kurz: 'Abtauen', text: 'Abtauen oder kurz danach', herkunft: 'Wächter/Quiet-Logik: keine Änderung beim und 10 min nach dem Abtauen (Opus: 10–20 min)'},
        {id: 'warmwasser', kurz: 'Warmwasser', text: 'Warmwasser oder kurz danach', herkunft: 'wie Abtauen (diese Anlage macht kein Warmwasser, die Sperre bleibt als Schutz)'},
        {id: 'sanftanlauf', kurz: 'Sanftanlauf', text: 'Sanftanlauf (HeishaMoNR SoftStart) aktiv', herkunft: 'SoftStart verschiebt die Heizkurve selbst'},
        {id: 'laufbeginn', kurz: 'Laufbeginn', text: 'Verdichter läuft erst kurz', herkunft: 'Start-Pumpenspitze 2900 U/min für 11–16 min bei jedem Start; Quiet wirkt erst nach 1–2 min'},
        {id: 'heizgrenze_aus', kurz: 'Heizgrenze-Aus', text: 'Heizgrenze-Aus (Pumpe steht)', herkunft: 'Heizgrenze 12 °C mit Hysterese: aus ab 15 °C, ein ab 12 °C, Pumpe 0, Vorlauf ohne Aussage'},
        {id: 'regler', kurz: 'anderer Regler', text: 'Ein anderer Regler stellt dieselbe Größe', herkunft: 'HeishaMoNR-Quiet-Logik/Scheduler/Solar/WP-Zeitplan bzw. Raumregelung/Nachtabsenkung/Sanftanlauf; Verschiebung nur im Heizkurvenmodus mit Wasserfühler und ohne Handeingriff am Soll'},
        {id: 'abstand', kurz: 'Mindestabstand', text: 'Mindestabstand zur letzten Änderung', herkunft: 'Wächter: 60 min Abstand; Opus: höchstens 1 Wechsel pro Stunde; seit 13.10. über Quiet und Verschiebung gemeinsam (Regel-Review 3.4: sonst ist keine Wirkung zuzuordnen und Freigabe und +1 K heizen doppelt), seit 14.10. auch über die Heizregelung (Comfort/Efficiency ändert die Leistung beim Start und nach dem Abtauen). Ein Notfall der Quiet-Stufe oder der Heizregelung (Heizstab-Nähe, Raum ≥ notK unter Minimum) überbrückt ihn nach notfallMin (10 min; Regel-Review B4)'},
        {id: 'tageslimit', kurz: 'Tageslimit', text: 'Tageslimit der Regel erreicht', herkunft: 'Schreibbudget (Opus: höchstens 6 Wechsel/Tag), EEPROM-Verschleiß unbekannt. Seit 13.10. zählen bei Befehlsregeln nur übernommene Vorschläge (Regel-Review R5: Vorschläge in der Nacht ohne Klick verbrauchten sonst das Kontingent für den Tag; die Übernahme begrenzt ohnehin auf 6 Befehle am Tag); ein Quiet-Notfall ist ausgenommen'},
        {id: 'abkuehlzeit', kurz: 'Wartezeit', text: 'Wartezeit nach dem letzten Vorschlag', herkunft: 'kein Flattern: ein abgelaufener oder zurückgezogener Vorschlag kommt erst nach einer Pause wieder; ein Quiet-Notfall nach notfallMin (10 min), außer der vorige Notfall-Vorschlag ist nur abgelaufen (nachts klickt niemand, sonst käme derselbe Vorschlag alle 40 min)'},
        {id: 'takt', kurz: 'Takt-Gefahr', text: 'Takt-Gefahr: Vorlauf über Soll', herkunft: 'Anlage schaltet bei Vorlauf ≥ Soll +3,25 K nach ~3 min ab (6 Stopps 07.–10.10.); Sperre ab Soll +1 K für Maßnahmen, die den Vorlauf näher an diese Grenze bringen (mehr Leistung, −1 K). −1 K im Lauf also nur bei Vorlauf ≤ Soll: danach höchstens +1 K über dem neuen Soll, im ungünstigsten Fall (natürlicher Sollsprung −1 K an der Rundungsgrenze der Kurve, Regel-Review RE-2) +2 K; gemessen 07.–13.10.: nach einem Sollsprung −1 K kein Stopp bis +2,25 K (18 von 18), Stopp ab +2,5 K nach 11–14 min, ab +3,25 K nach 3 min'},
        {id: 'abtausprung', kurz: 'Abtauwetter', text: 'Frequenzsprung bei Abtauwetter', herkunft: 'Pseudo-Abtauungen: läuft der Verdichter lange niedrig und dreht dann hoch, reißt das Abtaukriterium ohne Vereisung (Forum 189605: L5 4540566, L7 4230252 und 4581423; Sprung > +30 % als Gefahr 4868882, Vermutung). Darum im Bereich −5…+4 °C (Fühlerwert der WP, Forum F6-a) nach mindestens 60 min mit höchstens 20 Hz keine Maßnahme, die den Verdichter um 8 Hz oder mehr anhebt; Heizstab-Nähe ist ausgenommen'},
        {id: 'heizstab', kurz: 'Heizstab-Nähe', text: 'Heizstab-Nähe', herkunft: 'Heizstab ab Außentemperatur < Heater_On_Outdoor_Temp (0 °C) bei Vorlauf < Soll −3 K nach 15 min; ein +1-K-Schritt vergrößert den Rückstand sofort um 1 K'},
        {id: 'modell', kurz: 'Modell-Gate', text: 'Gebäudemodell noch nicht freigegeben', herkunft: 'Wärmefahrplan: Gate des Gebäudemodells (≥ 10 Tage, Fehler ≥ 10 % kleiner als der bisherige Schätzer, plausible Koeffizienten); vorher ist eine Bedarfsvorhersage nicht belegt'},
        {id: 'vorrang', kurz: 'andere Regel', text: 'Die Stellgröße gehört einer anderen Regel', herkunft: 'Arbitrierung je Stellgröße (Heizkurven-Verschiebung: Raumeinfluss, Vorausschau, +1 K von „Deckel/Laufzeit“; Quiet: Quiet-Freigabe, Deckel/Laufzeit): je Zeit hat genau eine Regel die Größe (laufender Vorschlag oder übernommener Wert); keine zweite Regel schlägt daneben oder dagegen vor. Quiet: eine übernommene Stufe weicht nur einem Notfall (Raum ≥ notK unter Minimum oder Heizstab-Nähe), frühestens notfallMin (10 min) nach der Übernahme (Regel-Review B4; vorher 60 min). Leistung (seit 14.10., Heizregelung): eine Leistungsänderung zur Zeit – läuft ein Quiet-Vorschlag, wartet Comfort (zuerst Quiet: der Quiet-Deckel bindet auch Comfort, 13.10. 21:00 Comfort/Quiet 3: 17 Hz); läuft ein Heizregelungs-Vorschlag oder steht Comfort der Regel, schlägt der Effizienz-Deckel nicht vor'},
        {id: 'gegenrichtung', kurz: 'Gegenrichtung', text: 'Gegenrichtung zur letzten Änderung', herkunft: 'Kein Hin und Her: Gegenrichtung frühestens shiftHaltMin bzw. quietHaltMin (60 min) nach dem Ende der letzten Änderung derselben Größe und nur mit Notfall (Verschiebung: Raum ≥ notK 0,3 K außerhalb des Bandes; Quiet: Raum ≥ notK unter Minimum oder Heizstab-Nähe, dort schon nach notfallMin 10 min), ohne Notfall erst nach gegenMin bzw. quietGegenMin (240 min); Heizregelung wie Quiet (hcHaltMin 60, hcGegenMin 240 min, Notfall nach 10 min); ANNAHME'}
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
    // seit 14.10.2026 auch S.arbH (Heizregelung "hc": 0 = Comfort, 1 = Efficiency; Regel "Heizregelung")
    function arbOf(S, g) { return g === 'quiet' ? S.arbQ : (g === 'hc' ? S.arbH : S.arb); }
    function curOf(d, g) { return g === 'quiet' ? d.q : (g === 'hc' ? d.hc : d.shift); }
    function hcTxt(w) { return w === 0 ? 'Comfort' : (w === 1 ? 'Efficiency' : 'Heizregelung ' + w); }
    function ownedBy(d, A, g, self) { var ap = A && A.applied, cur = curOf(d, g); return (ap && ap.rule !== self && have(cur) && cur === ap.w && (g !== 'shift' || cur !== 0)) ? ap.rule : null; }
    function shiftOwnedBy(d, self) { return ownedBy(d, d.arb, 'shift', self); }
    function komfortNot(d, dir) {                                                    // Komfort-Notfall: ein gueltiger Raum >= notK ausserhalb des Bandes in der Richtung, die die Massnahme behebt, keiner auf der anderen Seite
        var v = d.rooms.filter(function (r) { return r.active && r.valid && have(r.min) && have(r.max); });
        if (dir > 0) { return v.some(function (r) { return r.t <= r.min - d.notK; }) && !v.some(function (r) { return r.t > r.max; }); }
        return v.some(function (r) { return r.t >= r.max + d.notK; }) && !v.some(function (r) { return r.t < r.min; });
    }
    function sgnOf(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
    function arbEnd(A, d, g) { return (A.applied && A.last && A.applied.rule === A.last.rule && curOf(d, g || 'shift') === A.applied.w) ? d.now : (A.last ? A.last.end : 0); }   // steht der Wert noch, laeuft die Aenderung noch
    function wTxt(g, w) { return g === 'quiet' ? 'Quiet ' + w : (g === 'hc' ? hcTxt(w) : 'Verschiebung ' + sg(w, 0) + ' K'); }
    function arbLocks(R, e, d, S, cfg, add) {
        var g = (e && e.groesse) || R.groesse, A = arbOf(S, g), L = cfg.locks, now = d.now, q = g === 'quiet', st = q || g === 'hc';   // st: Stufen-Groesse (Quiet, Heizregelung) mit Notfall
        if (!e || !have(e.wert) || !have(e.von) || !A) { return; }
        var dir = sgnOf(e.wert - e.von), halt = st ? (e.hart ? L.notfallMin : (q ? L.quietHaltMin : L.hcHaltMin)) : L.shiftHaltMin, gegen = q ? L.quietGegenMin : (st ? L.hcGegenMin : L.gegenMin);   // Notfall: 10 statt 60 min (Regel-Review B4)
        if (R.sperren.indexOf('vorrang') >= 0) {
            var ob = ownedBy(d, A, g, R.id);
            if (A.owner && A.owner !== R.id) { add('vorrang', (A.soll === e.wert ? (q ? 'dieselbe Stufe ' : 'dieselbe Verschiebung ') + (q ? A.soll : sg(A.soll, 0) + ' K') + ' schlägt schon „' : wTxt(g, A.soll) + ' vorgeschlagen von „') + RULE[A.owner].kurz + (A.soll === e.wert ? '“ vor' : '“')); }
            else if (ob && !(st && e.hart && now - A.applied.ts >= halt * MIN)) { add('vorrang', wTxt(g, curOf(d, g)) + ' gehört „' + RULE[ob].kurz + '“' + (st ? ' (Notfall frühestens ' + halt + ' min nach der Übernahme)' : ''), st && e.hart ? A.applied.ts + halt * MIN : null); }
        }
        if (R.sperren.indexOf('gegenrichtung') >= 0 && A.last && dir !== 0 && A.last.dir === -dir) {
            var ls = A.last, end = arbEnd(A, d, g), el = now - end, h0 = (st && ls.lapse) ? ls.start : end;   // Zuordnung ohne Aenderung beendet: Mindesthaltezeit ab der Uebernahme, Wartezeit ab dem Ende
            var was = 'letzte Änderung ' + wTxt(g, ls.w) + ' („' + RULE[ls.rule].kurz + '“) bis ' + hhmm(end);
            if (now - h0 < halt * MIN) { add('gegenrichtung', was + ', Mindesthaltezeit ' + halt + ' min', h0 + halt * MIN); }
            else if (el < gegen * MIN && !e.hart) { add('gegenrichtung', was + ', ohne ' + (st ? 'Notfall' : 'Komfort-Notfall') + ' erst nach ' + gegen + ' min', end + gegen * MIN); }
        }
    }

    // Laufzeit strecken (v2): Takt ist belegt, wenn der letzte Lauf ueber den Vorlauf abschaltete (Stopp-Art) und kuerzer als kurzerLaufMin war, oder bei
    // mindestens starts3h Starts in 3 h. Die Vorhersage "Abschaltgrenze in <= 45 min" (v1) loest nicht mehr aus (Replay 07.-12.10.: unzuverlaessig bei >= 22 Hz).
    // v4 (Regel-Review LS-7): Takt aus der entprellten Takt-Messung (mehr als startsTagWarn Starts in 24 h oder mehr als kurzAnteilWarn kurze Laeufe bei >= 4 Laeufen)
    // oder: letzter Lauf mit Abschaltung ueber den Vorlauf kuerzer als kurzerLaufMin UND mindestens starts3h Starts in 3 h (ein einzelner kurzer Lauf ist noch kein Takt)
    function taktBeleg(d, c) { return !!((d.takt && d.takt.takt) || (d.lastRunThermo && have(d.lastRunMin) && d.lastRunMin < c.kurzerLaufMin && d.starts3h >= c.starts3h)); }
    // ------------------------------------------------------------------ Mindestfrequenz je Aussentemperatur (Forum 189605 F1-a, 14.10.2026; Bandgrenzen = Fuehlerwert der WP, TOP14)
    // Die L5 hebt bei Kaelte die Mindestfrequenz an: ab <= -4 °C 25 Hz (~2 kW), ab <= -10 °C 35 Hz; der Fluestermodus aendert das nicht. Gelernt wird die Mindestfrequenz
    // je 2-K-Band (getrennt an den Sprungstellen -4/-10 °C) aus stabilen Laufminuten: 10-%-Quantil, aber nur, wenn sich die Minuten dort haeufen (mindestens 25 % der
    // Minuten hoechstens 1 Hz darueber), sonst lief der Verdichter nie am Minimum (hoher Bedarf) und der Wert waere zu hoch. Gelernte Werte haben Vorrang vor der Tabelle.
    var MINHZ = [
        {atBis: -10, hz: 35, text: 'Forum 189605 (L5): ab ≤ −10 °C Mindestfrequenz 35 Hz (4593782), auch mit Flüstermodus 3 (4593801); L7/L9 40 Hz (4594536, 4594690)'},
        {atBis: -4, hz: 25, text: 'Forum 189605 (L5): ab ≤ −4 °C Mindestfrequenz 25 Hz ≈ 2 kW (4596796, 4593782), unabhängig vom Flüstermodus; L7 ebenso (4594536)'},
        {atBis: 999, hz: 16, text: 'Messung 07.–13.10. (1–15 °C): 16–17 Hz am Minimum; Forum L5 16 Hz (3910931, 3961179)'}
    ];
    var MINHZ_LERN = {quantil: 0.1, haeufungHz: 1, haeufungAnteil: 0.25};
    function hzSeg(at) { return at <= -10 ? 2 : (at <= -4 ? 1 : 0); }                              // Segment zwischen den Sprungstellen der Mindestfrequenz
    function binKeyOf(at) { var s = hzSeg(at); return String(Math.floor(at / TAKT.binK) * TAKT.binK) + (s ? '|' + s : ''); }   // 2-K-Band; ab -4 °C mit Segment (sonst laege -4 und -3 °C im selben Band)
    function minHzTab(at) { for (var i = 0; i < MINHZ.length; i++) { if (at <= MINHZ[i].atBis) { return MINHZ[i]; } } return MINHZ[MINHZ.length - 1]; }
    function minHzOf(T, at, c) {                                                                   // {hz, quelle ('gelernt' | 'Tabelle'), text, n}
        if (!have(at)) { return {hz: null, quelle: '', text: 'Außentemperatur unbekannt', n: 0}; }
        c = taktCfg(c);
        var tb = minHzTab(at), B = T && T.hzB ? T.hzB[binKeyOf(at)] : null;
        if (B && B.length >= c.binMinN) {
            var q = quantil(B, MINHZ_LERN.quantil), nah = B.filter(function (h) { return h <= q + MINHZ_LERN.haeufungHz; }).length / B.length;
            if (nah >= MINHZ_LERN.haeufungAnteil) { return {hz: Math.round(q), quelle: 'gelernt', text: 'gelernt: ' + Math.round(q) + ' Hz (10-%-Quantil aus ' + B.length + ' stabilen Minuten, Band ' + binKeyOf(at).split('|')[0] + ' °C; Tabelle ' + tb.hz + ' Hz)', n: B.length}; }
        }
        return {hz: tb.hz, quelle: 'Tabelle', text: tb.text, n: B ? B.length : 0};
    }
    function minHzAt(d, at) { return minHzOf(d.T || null, at, d.tc); }
    function hartCap(d, at, cap, c) { if (!have(cap)) { return false; } var mh = minHzAt(d, at).hz; return cap <= c.hartHz || (have(mh) && cap <= mh + 1); }   // Stufe haelt nur das Minimum
    // ------------------------------------------------------------------ Startschwelle (Forum 189605 F3-a gegen Messung, 14.10.2026)
    // Forum (L7, 4004893): Start, sobald Vorlauf < Ruecklauf beim Abschalten - 3 K, ohne Wartezeit. Geprueft an 14 sauberen Pausen 08.-13.10. (Minutenraster, Pumpe an,
    // kein Sollsprung): die RL-Regel trifft den Start im Mittel 24,6 min zu frueh (7-80 min); "Vorlauf <= Soll - 3,25 K (0,25-K-Raster), dann ~9 min Verzug" trifft ihn auf
    // 1,8 min (Verzug 6-13 min, 4 Starts schon bei Soll -3,0 K). Bei dieser Anlage gilt also der Soll, nicht der gespeicherte Ruecklauf. Beide Modelle werden je Pause
    // weiter gemessen (S.sl); das Modell mit dem kleineren Fehler gilt ab START.minN Pausen, vorher das Soll-Modell (Messung).
    var START = {sollK: 3.25, rlK: 3, verzugStd: 9, minN: 5, logN: 40, tage: 14};
    function startModell(S, now) {
        var L = (Array.isArray(S && S.sl) ? S.sl : []).filter(function (x) { return !x[5] && !x[6] && (!have(now) || now - x[0] <= START.tage * 24 * 60 * MIN); });
        function med(a) { a = a.filter(have).sort(function (x, y) { return x - y; }); return a.length ? a[Math.floor(a.length / 2)] : null; }
        var mS = med(L.map(function (x) { return x[2]; })), mR = med(L.map(function (x) { return x[3]; }));
        function mae(i, m) { if (!have(m) || !L.length) { return null; } return r2(L.reduce(function (a, x) { return a + (have(x[i]) ? Math.abs(x[i] - m) : m); }, 0) / L.length); }   // Start vor der Schwelle: Fehler = Verzug
        var o = {n: L.length, verzugSoll: mS, verzugRl: mR, maeSoll: mae(2, mS), maeRl: mae(3, mR), frueh: L.filter(function (x) { return !have(x[2]); }).length};
        o.modell = (o.n >= START.minN && have(o.maeRl) && have(o.maeSoll) && o.maeRl < o.maeSoll) ? 'rl' : 'soll';
        o.verzug = o.modell === 'rl' ? (have(mR) ? mR : 0) : (o.n >= START.minN && have(mS) ? mS : START.verzugStd);
        o.quelle = o.n >= START.minN ? 'gemessen (' + o.n + ' Pausen)' : 'Messung 07.–13.10. (14 Pausen), eigene Pausen ' + o.n + ' von ' + START.minN;
        return o;
    }
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
    var Q0_HZ = 33;              // erwartete Frequenz unter Quiet 0 nach einer Freigabe (Messung: Boost 10.10. 33-34 Hz, Comfort-Start 30-35 Hz); nur fuer die Sperre "Frequenzsprung bei Abtauwetter"
    function deckelTab(q, at) { for (var i = 0; i < DECKEL.length; i++) { var x = DECKEL[i]; if (x.q === q && (!have(x.atUnter) || (have(at) && at < x.atUnter))) { return x; } } return null; }
    function kombOf(d, q) {                                                         // Daten der Takt-Messung je Heizregelung x Quiet x Aussenband: Minuten, COP, gehaltene Hoechstfrequenz
        var band = have(d.at) ? bandOf(d.at) : null, mod = modusOf(d.hc), a = (band !== null && mod !== '?' && d.copSum) ? d.copSum[mod + '|' + q + '|' + band] : null;
        return a ? {q: q, min: a[2], cop: a[0] > 0 ? a[1] / a[0] : null, hzMax: have(a[4]) ? a[4] : null, held: have(a[5]) ? a[5] : null, band: band, mod: mod} : {q: q, min: 0, cop: null, hzMax: null, held: null, band: band, mod: mod};
    }
    function deckelOf(d, q) {                                                       // wirksamer Deckel der Stufe q bei der jetzigen Aussentemperatur und Heizregelung
        if (!have(q)) { return {hz: null, quelle: '', text: ''}; }
        if (q === 0) { return {hz: 59, quelle: 'Nutzer', text: 'Verdichterbereich 16–59 Hz (Nutzer 10.10.)'}; }
        var tb = deckelTab(q, d.at), k = kombOf(d, q), tc = d.tc || taktCfg(null), lern = k.min >= tc.copMinMin && have(k.held) ? k.held : null;
        var o = (lern !== null && (!tb || lern > tb.hz)) ? {hz: lern, quelle: 'gelernt', text: 'gelernt: ' + de(lern, 0) + ' Hz gehalten (' + k.mod + ', ' + k.band + ' °C, ' + Math.round(k.min) + ' min)'}
                                                         : (tb ? {hz: tb.hz, quelle: 'Messung', text: tb.text} : {hz: null, quelle: '', text: 'Deckel unbekannt'});
        var mh = have(d.at) ? minHzAt(d, d.at) : null;                              // Forum F1-a: keine Stufe deckelt unter die Mindestfrequenz (bei Frost 25/35 Hz, auch mit Quiet 3)
        if (mh && have(mh.hz) && have(o.hz) && mh.hz > o.hz) { o = {hz: mh.hz, quelle: 'Mindestfrequenz', text: 'Mindestfrequenz bei ' + de(d.at, 0) + ' °C: ' + mh.hz + ' Hz (' + mh.text + ')'}; }
        return o;
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
        var ok = [], gr = [], first = null, notfall = !!(B && B.notfall), stufen = c.ohneDatenSchrittweise === 1 && (!notfall || !!d.abtauLage);   // Abtauwetter: auch im Notfall schrittweise (kein Frequenzsprung, Forum F6-a)
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
        if (have(d.q) && d.q >= 1 && o.kalt) { o.cap = deckelOf(kaltD(d, o.at), d.q).hz; o.ja = hartCap(d, o.at, o.cap, c); }   // hart: hoechstens hartHz oder nur die Mindestfrequenz (Frost)
        return o;
    }
    function kaltD(d, at) { var x = Object.create(d); x.at = at; return x; }
    function zielKalt(d, c, K) {                                                     // naechste niedrigere Stufe ohne harten Deckel (Daten oder Messtabelle; Quiet 0 immer)
        var dk = kaltD(d, K.at), nm = nachtMin(d, c);
        for (var z = d.q - 1; z >= 0; z--) {
            if (nm !== null && z < nm) { break; }
            var cz = deckelOf(dk, z);
            if (have(cz.hz) && !hartCap(d, K.at, cz.hz, c)) { return {ziel: z, deckel: cz.hz, quelle: z === 0 ? 'ohne Deckel' : cz.quelle, warum: 'Quiet ' + z + (z === 0 ? ' (ohne Deckel)' : ' deckelt bei ' + de(cz.hz, 0) + ' Hz (' + cz.quelle + ', ' + de(K.at, 0) + ' °C)')}; }
        }
        return {ziel: null, deckel: null, quelle: '', warum: nm !== null ? 'nachts nicht unter Quiet ' + nm : 'keine Stufe ohne harten Deckel'};
    }
    // Zielstufe des Effizienz-Deckels: die niedrigste hoehere Stufe mit Messdaten (copMinMin), deren Deckel unter hzTakt (22 Hz) liegt (nachweislich deckelt) und deren COP
    // hoechstens copTol unter der jetzigen Stufe liegt (nur wenn beide Daten haben). Ohne Daten kein Vorschlag.
    function zielDeckel(d, c) {
        var tc = d.tc || taktCfg(null), band = have(d.at) ? bandOf(d.at) : null, mod = modusOf(d.hc), o = {band: band, mod: mod, cur: null, kand: [], ziel: null, warum: ''};
        if (!have(d.q) || band === null) { o.warum = 'Außentemperatur oder Quiet-Stufe unbekannt'; return o; }
        if (mod === '?') { o.warum = 'Heizregelung unbekannt (keine Daten je Modus)'; return o; }
        var cur = kombOf(d, d.q), gr = []; o.cur = cur;
        for (var z = d.q + 1; z <= 3 && !o.ziel; z++) {
            var k = kombOf(d, z), cz = deckelOf(d, z);
            if (k.min < tc.copMinMin) { k.warum = 'Quiet ' + z + ': ' + Math.round(k.min) + ' von ' + tc.copMinMin + ' min Daten'; }
            else if (!have(cz.hz) || cz.hz >= c.hzTakt) { k.warum = 'Quiet ' + z + ' deckelt nicht (bis ' + de(cz.hz, 0) + ' Hz' + (cz.quelle === 'Mindestfrequenz' ? ', Mindestfrequenz bei Frost' : '') + ')'; }
            else if (have(k.cop) && have(cur.cop) && cur.min >= tc.copMinMin && k.cop < cur.cop * (1 - c.copTol)) { k.warum = 'Quiet ' + z + ' COP ' + de(k.cop, 2) + ' statt ' + de(cur.cop, 2) + ' (mehr als ' + de(c.copTol * 100, 0) + ' % schlechter)'; }
            else { k.deckel = cz.hz; o.ziel = k; }
            o.kand.push(k); if (!o.ziel) { gr.push(k.warum); }
        }
        if (!o.ziel) { o.warum = 'keine Zielstufe aus den Daten (' + mod + ', ' + band + ' °C): ' + gr.join('; '); }
        return o;
    }
    // Schwelle des Effizienz-Deckels (v5): ohne Takt hzHoch (28 Hz), mit belegtem Takt hzTakt (22 Hz); bei Frost mindestens Mindestfrequenz + 3 Hz (keine Stufe deckelt darunter)
    function hzSchwelle(d, c, takt) {
        var b = takt ? c.hzTakt : c.hzHoch, mh = have(d.at) ? minHzAt(d, d.at) : null, hz = b, txt = takt ? 'Takt belegt' : 'ohne Takt';
        if (mh && have(mh.hz) && mh.hz + 3 > hz) { hz = mh.hz + 3; txt += ', Mindestfrequenz ' + mh.hz + ' Hz bei ' + de(d.at, 0) + ' °C'; }
        return {hz: hz, txt: txt};
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
            id: 'quiet_freigabe', ver: 3, kachel: 'Quiet-Freigabe', kurz: 'Quiet-Freigabe', name: 'Quiet-Freigabe (Leistung freigeben)', art: 'befehl', groesse: 'quiet', richtung: 'mehr_leistung', prio: 1, basis: 'quiet_freigabe|v2',
            zweck: 'Hält der Quiet-Deckel den Verdichter fest, obwohl ein echter Bedarf besteht (Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Boost von Hand, seit v3 auch Abtau-Rückstand in Efficiency), wird die Leistung freigegeben: auf die nächste Stufe, deren Deckel genug Mehrleistung zulässt (Daten je Heizregelung × Quiet × Außenband), bei Heizstab-Nähe und ohne Daten auf Quiet 0. Ein Vorlauf unter Soll allein ist kein Bedarf (v1 löste auch bei „Sollvorlauf in diesem Lauf noch nicht erreicht“ aus, also bei jedem langsamen Anlauf). Zurück auf die vorherige Stufe, sobald der Bedarf gedeckt ist. v3 (14.10.2026, Forum 189605): Deckel nie unter der Mindestfrequenz der Außentemperatur (Frost 25/35 Hz); bei Abtauwetter keine Freigabe, die den Verdichter nach langem Niedriglauf um 8 Hz oder mehr anhebt (Pseudo-Abtauung), außer bei Heizstab-Nähe.',
            eingaenge: ['Quiet-Stufe', 'Verdichterfrequenz und Deckel je Stufe (Messung, Takt-Messung, Mindestfrequenz je Außentemperatur)', 'Soll-/Ist-Vorlauf', 'Rücklauf und Ziel-Spreizung (Heat_Delta)', 'Laufzeit', 'Räume (gültig, eigenes Band, Verlauf)', 'Heizstab (Heater_On_Outdoor_Temp, Heater_Start_Delta)', 'Soll von Hand gegen Heizkurve', 'Abtauen (Ende, Rückstand danach)', 'Daten je Heizregelung × Quiet × Außenband (Takt-Messung)'],
            sperren: ['anlauf', 'daten', 'stoerung', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'abtausprung'],
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
                {key: 'abtauNachMin', std: 30, einheit: 'min', herkunft: 'Abtau-Rückstand (v3): bis 30 min nach dem Ende einer Abtauung zählt ein Vorlauf-Rückstand in Efficiency als Bedarf. Forum 189605: Efficiency hält nach dem Abtauen ~20 min niedrige Frequenz (L5 25 Hz, 4582615; L7 4095732), das Haus kühlte in Abtauserien aus (4096011), Comfort fährt hoch. Die ersten 10 min sperrt „Abtauen“ (Forum F6-c: 10–15 min keine Eingriffe); ANNAHME'},
                {key: 'abtauRueckK', std: 3, einheit: 'K', herkunft: 'Abtau-Rückstand: Vorlauf mindestens 3 K unter Soll (Abtauen senkt den Vorlauf um 8–15 K: Forum L5 37 → 22 °C, 4288323; die Anlage startet bei Soll −3,25 K neu, Messung 07.–13.10.); ANNAHME, ohne eigene Abtau-Daten'},
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
                            halt: c.haltMin, wert: zk.ziel, von: d.q, hart: !!B.notfall, groesse: 'quiet', maxDauerMin: c.maxDauerMin, modus: 'kalt', heizstab: !!B.heizstab,
                            sprungHz: d.running && have(d.hz) && have(zk.deckel) ? (zk.ziel === 0 ? Q0_HZ : zk.deckel) - d.hz : null,
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
                var zHz = have(zl.ziel) ? (zl.ziel === 0 ? Q0_HZ : deckelOf(d, zl.ziel).hz) : null;      // erwartete Frequenz nach der Freigabe (Sperre "Frequenzsprung bei Abtauwetter")
                return {cond: cond, halt: B.heizstab ? c.haltHeizstabMin : c.haltMin, wert: zl.ziel, von: d.q, hart: B.notfall, startMin: lm, groesse: 'quiet', maxDauerMin: c.maxDauerMin,
                        heizstab: !!B.heizstab, sprungHz: have(zHz) && have(d.hz) ? zHz - d.hz : null,
                        erwartung: zl.ziel === 0 ? 'Verdichter ≥ 25 Hz binnen 5 min, elektrische Leistung +350 bis +650 W, Vorlauf +2 K in 30 min (gemessen 10.10.2026 08:41, Efficiency, 11–12 °C: 29 Hz nach 1 min, 34 Hz nach 2 min, +490–590 W, Vorlauf +4 K in 20 min; nicht gemessen: Kälte, Abtauen)'
                                                 : 'Verdichter mindestens ' + de(have(cap.hz) ? cap.hz + 3 : null, 0) + ' Hz binnen 10 min (3 Hz über dem Deckel von Quiet ' + d.q + '), elektrische Leistung +60 W oder mehr (gemessen 13.10. 16:36 Quiet 2 → 1: 17 → 20–21 Hz, +80–100 W bei 12 °C)',
                        was: 'Quiet-Stufe ' + d.q + ' → ' + zl.ziel,
                        warum: 'Verdichter ' + de(d.hz, 0) + ' Hz am Deckel von Quiet ' + d.q + ', Vorlauf ' + de(d.vlRueck, 1) + ' K und Rücklauf ' + de(d.rlRueck, 1) + ' K unter Soll, Lauf ' + de(d.runMin, 0) + ' min; Bedarf: ' + B.txt + '; Ziel: ' + zl.warum};
            }
        },
        {
            id: 'quiet_strecken', ver: 5, kachel: 'Deckel/Laufzeit', kurz: 'Deckel/Laufzeit', name: 'Effizienz-Deckel und Laufzeit (Quiet höher oder Heizkurve +1 K)', art: 'befehl', groesse: 'quiet', richtung: 'weniger_leistung', prio: 2,
            basis: 'quiet_strecken|v5', basisKurve: 'quiet_strecken|v4|kurve',
            zweck: 'Zwei Hebel, gewählt nach Lage. Quiet höher (Effizienz-Deckel): läuft der Verdichter ohne Bedarf mit 28 Hz oder mehr – bei belegtem Takt schon ab 22 Hz – (vor allem in den ersten 3 h eines Laufs bei Mildwetter), deckelt die niedrigste Stufe, die laut Messdaten unter 22 Hz hält. v5 (14.10.2026): Nach der COP-Korrektur (+80 W im Lauf, Forum 189605) ist der COP-Vorteil bei 22–27 Hz nicht mehr belegt (−0,3…+4,8 % gegen 16–17 Hz, roh −3…−7 %: das Vorzeichen hängt an der Korrektur), ab 28 Hz bleibt er bei jeder Korrektur zwischen 0 und 80 W negativ (−3 % korrigiert, −5…−15 % roh); 22–27 Hz deckelt die Regel deshalb nur noch, wenn Takt belegt ist (dann zählt die längere Laufzeit). Bei Frost deckelt keine Stufe unter die Mindestfrequenz (≤ −4 °C 25 Hz, ≤ −10 °C 35 Hz, Forum 4593782/4596796): die Schwelle steigt dort auf Mindestfrequenz + 3 Hz. Quiet senkt am Minimum außerdem den Lüfter (−60…−110 U/min, −10…−16 W; ein COP-Unterschied ist dort nicht messbar). Heizkurve +1 K (Laufzeit): läuft der Verdichter schon unter 22 Hz und ist Takt belegt, hilft Quiet nicht; +1 K hebt Abschalt- und Startschwelle (längere Läufe, kürzere Pausen) und kostet Strom, deshalb nur, wenn der geschätzte Nutzen (vermiedene Starts) die Kosten übersteigt. Beide Hebel nie gleichzeitig aus einem Vorschlag.',
            eingaenge: ['Quiet-Stufe', 'Heizregelung', 'Verdichterfrequenz', 'Rücklauf-Rückstand', 'Räume (Bedarf, Verlauf, Luft im Band)', 'Außentemperatur', 'letzte Läufe (Dauer, Stopp-Art), Pausen, Starts', 'Daten je Heizregelung × Quiet × Außenband (Takt-Messung: Minuten, COP, gehaltener Deckel)', 'Verschiebung der Anlage (TOP27) und Eigentümer (Arbitrierung)'],
            sperren: ['anlauf', 'daten', 'stoerung', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'heizstab', 'abtausprung'],
            befehl: {name: 'SetQuietMode', topic: 'panasonic_heat_pump/commands/SetQuietMode'},
            hebel: {quiet: {name: 'SetQuietMode', topic: 'panasonic_heat_pump/commands/SetQuietMode'}, shift: {name: 'SetZ1HeatRequestTemperature', topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature'}},
            schwellen: [
                {key: 'hzHoch', std: 28, einheit: 'Hz', herkunft: 'v5 (14.10.2026): Effizienz-Deckel ohne Takt erst ab 28 Hz. Messung 07.–13.10. (Quiet 0, gleiches Außenband, ab Laufminute 15): COP ab 28 Hz gegen 16–17 Hz roh −5…−15 %, mit COP-Korrektur +80 W −3,1 % (≥ 11 °C, 57 min) bzw. +4,8 % (4–8 °C, nur 12 min) – negativ bei jeder Korrektur zwischen 0 und 80 W in dem Band mit genug Daten; 22–27 Hz roh −3…−7 %, korrigiert −0,3…+4,8 % (Vorzeichen hängt an der Korrektur, Messunsicherheit Pth ±10 %). Vorher 22 Hz (Messung roh 13.10.)'},
                {key: 'hzTakt', std: 22, einheit: 'Hz', herkunft: 'mit belegtem Takt deckelt die Regel schon ab 22 Hz (der Nutzen ist dann die längere Laufzeit, nicht der COP); eine Zielstufe deckelt, wenn ihr Deckel (Messung, gelernt oder Mindestfrequenz) unter 22 Hz liegt; Hebel +1 K nur unter dieser Schwelle; Kennzahl „Hochlauf nach Start“ zählt Minuten ab 22 Hz'},
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
            erwartung: 'Quiet höher: Verdichter ≤ 21 Hz binnen 10 min, elektrische Leistung −100 W oder mehr (nach Quiet-Wechseln nach oben fiel die Frequenz binnen 5–15 min, 08.10. 09:38, 12.10. 09:30); COP-Vorteil nur ab 28 Hz belegt (korrigiert +3 %, roh +5…+15 %), darunter zählt die Laufzeit. Heizkurve +1 K: Soll-Vorlauf +1 K binnen 3 min; Lauf länger, Pause kürzer (Messaufgabe, nicht gemessen)',
            rueckweg: 'Quiet höher: automatisch zurück auf die vorherige Stufe bei Bedarf (Raum unter Minimum oder fallend, Heizstab-Nähe, Boost), bei Rücklauf-Rückstand ≥ 2,5 K seit 15 min, bei Außentemperatur ≤ 3 °C, spätestens nach 8 h. Heizkurve +1 K: zurück auf 0 K bei Heizstab-Nähe (Außen unter Heater_On_Outdoor_Temp + 2 K), wenn ein Raum mehr als 0,3 K über die Bandmitte steigt, wenn zwei Läufe ohne Takt endeten, spätestens nach 6 h.',
            prognose: {p: 0.7, h: [30], text: 'Ohne Deckel läuft der Verdichter weiter mit 28 Hz oder mehr (mit Takt: 22 Hz)'},
            prognoseKurve: {p: 0.7, h: [60], text: 'Ohne +1 K endet der Lauf binnen 60 min (kurzer Lauf)'},
            kalibriert: ['2026-10-08 09:38', '2026-10-12 09:30'],
            eval: function (d, c, rs) {
                if (!have(d.q)) { return {inaktiv: 'Quiet-Stufe unbekannt'}; }
                var takt = taktBeleg(d, c), hs = hzSchwelle(d, c, takt), hoch = have(d.hz) && d.hz >= hs.hz, taktTxt = [];
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
                        {k: 'hoch', kz: 'Frequenz', t: 'Verdichter mit ' + hs.hz + ' Hz oder mehr (' + hs.txt + ')', tn: 'Verdichter bei ' + de(d.hz, 0) + ' Hz (Schwelle ' + hs.hz + ' Hz: ' + hs.txt + ')', ok: hoch, ist: d.hz, soll: hs.hz, op: '>=', u: 'Hz', dyn: true},
                        {k: 'keinBedarf', kz: 'kein Bedarf', t: 'kein Bedarf und Rücklauf höchstens ' + de(c.rlRueckMaxK, 1) + ' K unter Soll', tn: B.ja ? 'Bedarf: ' + B.txt : 'Bedarf: Rücklauf ' + rueckTxt(d.rlRueck), ok: !B.ja && have(d.rlRueck) && d.rlRueck <= c.rlRueckMaxK, ist: B.ja ? null : r2(d.rlRueck), soll: c.rlRueckMaxK, op: '<=', u: 'K', dyn: !B.ja},
                        {k: 'komfort', kz: 'Komfort sicher', t: 'alle Räume mindestens ' + de(c.komfortK, 1) + ' K über Minimum', tn: ks.txt, ok: ks.ok},
                        {k: 'ruhe', kz: 'Ruhe nach Bedarf', t: 'seit ' + c.ruheMin + ' min kein Bedarf', tn: 'Bedarf zuletzt ' + hhmm(d.bedT) + ' (Ruhe bis ' + hhmm(d.bedT + c.ruheMin * MIN) + ')', ok: ruhe},
                        {k: 'aussen', kz: 'Außentemperatur', t: 'Außentemperatur über ' + de(c.atMinC, 0) + ' °C', tn: 'Außentemperatur ' + de(d.at, 0) + ' °C (Quiet höher erst über ' + de(c.atMinC, 0) + ' °C)', ok: have(d.at) && d.at > c.atMinC, ist: d.at, soll: c.atMinC + 1, op: '>=', u: '°C', dyn: true},
                        {k: 'ziel', kz: 'Zielstufe', t: z ? 'Zielstufe aus den Daten: Quiet ' + z.q + ' (' + zl.mod + ', ' + zl.band + ' °C: Deckel ' + de(z.deckel, 0) + ' Hz, ' + de(z.min / 60, 1) + ' h Daten' + (have(z.cop) ? ', COP ' + de(z.cop, 2) : '') + ')' : 'Zielstufe aus den Daten', tn: zl.warum, ok: !!z}
                    ];
                    return {cond: cond, halt: c.haltMin, wert: z ? z.q : null, von: d.q, groesse: 'quiet', hebel: 'quiet', dir: 'weniger_leistung', maxDauerMin: c.maxDauerMin, hzS: hs.hz,
                            erwartung: 'Verdichter ≤ 21 Hz binnen 10 min, elektrische Leistung −100 W oder mehr (nach Quiet-Wechseln nach oben fiel die Frequenz binnen 5–15 min, 08.10. 09:38, 12.10. 09:30); COP ab 28 Hz gegen 16–17 Hz korrigiert −3 %, roh −5…−15 % (07.–13.10.); unter 28 Hz zählt die längere Laufzeit (Takt belegt)',
                            rueckweg: 'Automatisch zurück auf Quiet ' + d.q + ' bei Bedarf (Raum unter Minimum oder fallend, Heizstab-Nähe, Boost), bei Rücklauf-Rückstand ≥ ' + de(c.bedarfRlK, 1) + ' K seit 15 min, bei Außentemperatur ≤ ' + de(c.atMinC, 0) + ' °C, spätestens nach ' + de(c.maxDauerMin / 60, 0) + ' h.',
                            was: 'Quiet-Stufe ' + d.q + ' → ' + (z ? z.q : '–') + ' (Effizienz-Deckel)',
                            warum: 'Verdichter ' + de(d.hz, 0) + ' Hz (Schwelle ' + hs.hz + ' Hz: ' + hs.txt + ') ohne Bedarf (Rücklauf ' + rueckTxt(d.rlRueck) + ', alle Räume mindestens ' + de(c.komfortK, 1) + ' K über Minimum, Außen ' + de(d.at, 0) + ' °C)' + (taktTxt.length ? '; Takt: ' + taktTxt.join(', ') : '') + (z ? '; Quiet ' + z.q + ' deckelt bei ' + de(z.deckel, 0) + ' Hz (' + zl.mod + ', ' + zl.band + ' °C, ' + de(z.min / 60, 1) + ' h Daten)' : '')};
                }
                var NK = nutzenKurve(d, c), warm = null;                              // waermster Raum relativ zur Bandmitte (Regel-Review LS-5: +1 K ist sonst Gegenspieler zu Raumeinfluss −1 K)
                d.rooms.forEach(function (r) { if (r.active && r.valid && have(r.max) && have(r.min) && (warm === null || r.t - (r.min + r.max) / 2 > warm.t - (warm.min + warm.max) / 2)) { warm = r; } });
                var luft = warm ? (warm.min + warm.max) / 2 - warm.t : null, sollNeu = have(d.soll) ? d.soll + 1 : null, vlS = have(d.vl) && have(d.soll) ? d.vl - d.soll : null;
                // +1 K auch in der Pause (hebt die Startschwelle; bei Laeufen unter 25 min gaebe es im Lauf nach Startphase und Haltezeit keine Gelegenheit)
                var cond2 = [
                    {k: 'takt', kz: 'Takt belegt', t: 'Takt belegt (' + (taktTxt.join(', ') || 'kurzer Lauf oder viele Starts') + ')', tn: 'kein Takt belegt: ' + lr + ', ' + d.starts3h + ' Start' + (d.starts3h === 1 ? '' : 's') + ' in 3 h', ok: takt},
                    {k: 'minimum', kz: 'Frequenz', t: 'Verdichter unter ' + hs.hz + ' Hz oder in der Pause: Quiet deckelt nichts mehr', tn: 'Verdichter bei ' + de(d.hz, 0) + ' Hz: zuerst Quiet höher', ok: !hoch},
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
            id: 'raum_offset', ver: 3, kachel: 'Raumeinfluss', kurz: 'Raumeinfluss ±1 K', name: 'Raumeinfluss (Heizkurve ±1 K)', art: 'befehl', groesse: 'shift', richtung: 'verschiebung', prio: 3,
            basis: 'raum_offset|v3', basisMinus: 'raum_offset|v3|minus',
            zweck: 'Räume wirken nur als langsamer, kleiner Offset auf die Heizkurve (Lambda-Prinzip). Seit v3 (14.10.2026) entscheidet die Regel selbst aus den Räumen (eigenes Komfortband, geglätteter Wert, Verlauf per Regression, Lüften ausgefiltert, Werte bis 6 h alt, weil die Shelly nur bei Änderung melden); der Raumvorschlag der Phase 2 ist nur noch Vergleichskennzahl. +1 K nur bei Bedarf (ein Raum unter Minimum, der sich nicht erholt; Kinderzimmer oben nur mit offenem Radiator-Relais), −1 K bei Überschuss (alle Räume mit Reserve über Minimum, einer über Maximum oder alle über der Bandmitte), bevorzugt in der Pause oder bei Vorlauf ≤ Soll, damit auch im Dauerlauf (kalte Nächte 600–970 min ohne Pause). Höchstens 1 K je Befehl. Ein Raum über Maximum und einer unter Minimum ist ein Wärmeverteilungsproblem: dann keine Verschiebung, sondern ein eigener Hinweis (hydraulischer Abgleich/Thermostatventile). Zurück auf 0 K mit Hysterese, wenn der Bedarf gedeckt bzw. die Reserve verbraucht ist, spätestens nach 6 h. Stellt nur die Verschiebung, nicht die Heizregelung; Teil der Verschiebungs-Arbitrierung mit Vorausschau und +1 K von „Deckel/Laufzeit“.',
            eingaenge: ['Räume (Wert, Alter, eigenes Band, Verlauf, Lüften)', 'Radiator-Relais Kinderzimmer oben (eigene Regelung, Tab Dashboard)', 'Verschiebung an der Anlage (TOP27) und Eigentümer (Arbitrierung)', 'Soll-Vorlauf, Heizkurve, natürliche Sollsprünge', 'Vorlauf, Rücklauf, Verdichter (Lauf/Pause)', 'Wirkzeit Raum (gemessen, sonst Annahme)', 'Raumvorschlag Phase 2 (nur Vergleich)'],
            sperren: ['anlauf', 'daten', 'stoerung', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'heizgrenze_aus', 'regler', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'heizstab', 'abtausprung'],
            befehl: {name: 'SetZ1HeatRequestTemperature', topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature'},
            schwellen: [
                {key: 'stabilMin', std: 60, einheit: 'min', herkunft: 'Bedarf bzw. Überschuss muss 60 min am Stück bestehen (Auftrag: lange Haltezeit; Räume reagieren träge, Wirkzeit 1–3 h, Shelly melden erst ab 0,5 K); ANNAHME'},
                {key: 'raumAlterMaxMin', std: 720, einheit: 'min', herkunft: 'Ein Raumwert gilt bis 12 h: die Shelly melden nur bei Änderung, Stille heißt stabil (Regel-Review RE-9; die Phase 2 stand mit 90 min in 41 % der Zeilen auf „Daten unvollständig“). Messung 07.–13.10.: das Wohnzimmer war in 14 % der Minuten älter als 6 h (12 % 6–12 h, 2 % darüber), die Kinderzimmer höchstens 6 h; ANNAHME'},
                {key: 'kaltK', std: 0.2, einheit: 'K', herkunft: 'Bedarf: Raum mindestens 0,2 K unter seinem Minimum (EMA; Phase 2: startK 0,3); ANNAHME'},
                {key: 'warmK', std: 0.2, einheit: 'K', herkunft: 'Überschuss/Verteilung: Raum mindestens 0,2 K über seinem Maximum; ANNAHME'},
                {key: 'erholKh', std: 0.2, einheit: 'K/h', herkunft: 'ein Raum, der schon mit mindestens 0,2 K/h zurück ins Band läuft (Regression), zählt nicht als Bedarf bzw. Überschuss (Phase 2: „in 1 h nicht von selbst im Band“); ANNAHME'},
                {key: 'reserveK', std: 0.5, einheit: 'K', herkunft: '−1 K nur, wenn der knappste Raum mindestens 0,5 K über seinem Minimum liegt (Review 5.2: Raum −0,5 K ≈ VL −1 K; Phase 2: probeMarginK 0,4); ANNAHME'},
                {key: 'prognoseH', std: 2, einheit: 'h', herkunft: '−1 K nur, wenn der knappste Raum auch beim jetzigen Gefälle in 2 h noch reserveK − 0,2 K über Minimum liegt (Replay 12.10. 07:40: Schlafzimmer 0,6 K Reserve, fiel bis 09:23 unter Minimum); Wirkzeit 1–3 h; ANNAHME'},
                {key: 'verteilNotK', std: 0.5, einheit: 'K', herkunft: 'Wärmeverteilungsproblem: +1 K trotzdem, wenn der kalte Raum 0,5 K oder mehr unter Minimum liegt (Komfort vor Energie); ANNAHME'},
                {key: 'verteilMin', std: 30, einheit: 'min', herkunft: 'Hinweis „hydraulischer Abgleich/Thermostatventile“, wenn ein Raum über Maximum und einer unter Minimum 30 min am Stück bestehen (Regel-Review RE-8: 12.10. Kinderzimmer unten 600 min über Maximum, Schlafzimmer 160 min unter Minimum); ANNAHME'},
                {key: 'rueckPlusK', std: 0.3, einheit: 'K', herkunft: 'Rückweg +1 K: die Bedarfsräume liegen 30 min am Stück mindestens 0,3 K über Minimum (Hysterese 0,5 K zur Auslösung; wie der Rückweg der Quiet-Freigabe, Regel-Review B2: nur die Bedarfsräume zählen, nicht das Wohnzimmer, das 29–74 % der Zeit über Maximum lag); ANNAHME'},
                {key: 'rueckMin', std: 30, einheit: 'min', herkunft: 'Rückweg +1 K: Bedarf 30 min am Stück gedeckt und frühestens nach der Wirkzeit (gemessen, sonst wirkStdMin); ANNAHME'},
                {key: 'rueckReserveK', std: 0.2, einheit: 'K', herkunft: 'Rückweg −1 K: der knappste Raum liegt 15 min am Stück weniger als 0,2 K über Minimum (Hysterese 0,3 K zur Auslösung), sofort bei Bedarf; ANNAHME'},
                {key: 'trendMin', std: 120, einheit: 'min', herkunft: 'Verlauf je Raum: Regression über 2 h im 5-min-Raster (wie Quiet-Freigabe v2), unabhängig von Lauf und Pause'},
                {key: 'lueftungK', std: 1.0, einheit: 'K', herkunft: 'Lüften: Sturz um 1 K oder mehr binnen 60 min (wie Quiet-Freigabe und Bewertung); der Raum zählt danach lueftSperreMin nicht als Bedarf, der Verlauf beginnt nach dem Sturz'},
                {key: 'lueftSperreMin', std: 60, einheit: 'min', herkunft: 'nach einem Lüftungssturz 60 min kein Bedarf aus diesem Raum; ANNAHME'},
                {key: 'lueftKh', std: 1.0, einheit: 'K/h', herkunft: 'fällt ein Raum (Regression über 2 h) mit 1 K/h oder schneller, ist das kein Heizmangel (Auskühlen in der Pause 0,2–0,5 K/h), sondern Lüften oder offene Tür: kein Bedarf (Replay 09.10. 14:27: Wohnzimmer −2,3 K/h im geglätteten Wert); ANNAHME'},
                {key: 'kurveRuhigMin', std: 10, einheit: 'min', herkunft: 'nicht im selben 5-min-Takt schreiben wie die Kurve: 10 min nach einem natürlichen Sollsprung warten (Regel-Review RE-2; 54 Sollwechsel in 5,3 Tagen, alle auf Minute ≡ 0 mod 5, 19 Abstände < 30 min)'},
                {key: 'laufMinusK', std: 0, einheit: 'K', herkunft: '−1 K im Lauf nur bei Vorlauf ≤ Soll + 0 K: danach höchstens +1 K über dem neuen Soll, im ungünstigsten Fall (natürlicher Sollsprung −1 K an der Rundungsgrenze) +2 K; gemessen 07.–13.10.: nach −1 K kein Stopp bis +2,25 K (18 von 18), Stopp ab +2,5 K nach 11–14 min. In Dauerläufen (≥ 300 min, ab Minute 30) lag der Vorlauf in 54 % der Minuten höchstens 1 K über Soll (Regel-Review RE-1). Sonst in der Pause'},
                {key: 'abtauAtC', std: 3, einheit: '°C', herkunft: 'Regel-Review RE-6: unter 3 °C −1 K nur, wenn der Rücklauf mindestens rlMinC bleibt (Servicehandbuch J: Heizstab beim Abtauen ab Wassereintritt < 27 °C; Forum: die Leisha schaltet den Heizstab dafür nicht mehr zu, 4185332/4879325 – vorsorglich)'},
                {key: 'rlMinC', std: 28, einheit: '°C', herkunft: 'Rücklauf mindestens 28 °C für −1 K unter abtauAtC (RE-6); ANNAHME'},
                {key: 'wirkStdMin', std: 120, einheit: 'min', herkunft: 'Wirkzeit Raum, solange die Messung (Wirkzeit-Messung, Sollsprung → halbe Raumreaktion, ≥ 3 Ereignisse) fehlt: frühester Rückweg „Bedarf gedeckt“ nach +1 K (Regel-Review RE-10); ANNAHME'},
                {key: 'kfMinMin', std: 180, einheit: 'min', herkunft: 'Kennzahl Kurvenform: Hinweis je Außenband erst ab 3 h Daten mit allen Räumen (7 Tage); ANNAHME'},
                {key: 'kfAnteil', std: 0.5, einheit: 'Anteil', herkunft: 'Kennzahl Kurvenform: Hinweis „Heizkurve kaltseitig senken“, wenn das Haus in einem Band unter 8 °C in mindestens der Hälfte der Zeit Überschuss hat oder −1 K steht (Regel-Review RE-7: dauerhaft gehaltenes −1 K ist eine Kurvenkorrektur; 5.2: bei < 4 °C Kinderzimmer unten 90 % über Maximum); ANNAHME'},
                {key: 'minVlC', std: 29, einheit: '°C', herkunft: 'Nutzervorgabe 08.10. (bestätigt 13.10.): Soll-Vorlauf nie unter 29 °C (Heizkörper); bei Außen ≥ ~11 °C liegt die Kurve schon dort, −1 K ist dann nicht möglich (Grenze, kein „verpasst“, RE-4)'},
                {key: 'proTag', std: 4, einheit: 'Vorschläge', herkunft: 'Opus: höchstens 6 Schreibbefehle/Tag (gezählt werden übernommene Vorschläge)'},
                {key: 'gueltigMin', std: 120, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'pauseMin', std: 120, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'maxDauerMin', std: 360, einheit: 'min', herkunft: 'Rückweg spätestens nach 6 h (Auftrag)'}
            ],
            erwartung: '+1 K: Soll-Vorlauf +1 K binnen 6 min (5-min-Raster); in der Pause startet der Verdichter sofort, wenn der Vorlauf dann bei ≤ neuer Soll −3,25 K liegt (10.10. 18:20, 11.10. 19:10), im Lauf steigt die Stoppschwelle (bei Quiet 0 und Vorlauf unter Soll Hochlauf, 11.10. 03:10: +48 % Strom); Strom +2,5–3 % (8,5 W/K). −1 K: Startschwelle 1 K tiefer (Start bei Soll −3,25 K mit ~9 min Verzug, gemessen), Pause länger, Lauf endet 1 K früher. Raumwirkung: Wirkzeit-Messung, solange sie fehlt nicht gemessen.',
            rueckweg: 'Automatisch zurück auf 0 K: +1 K, sobald die Bedarfsräume 30 min am Stück ≥ Minimum + 0,3 K liegen (frühestens nach der Wirkzeit); −1 K sofort bei einem Raum unter Minimum oder wenn der knappste Raum 15 min unter Minimum + 0,2 K liegt; spätestens nach 6 h; „Zurücksetzen“ jederzeit.',
            prognose: {p: 0.7, h: [60, 120, 240], text: 'Ohne +1 K bleibt ein Bedarfsraum unter seinem Minimum'},
            prognoseMinus: {p: 0.7, h: [120, 240, 360], text: 'Ohne −1 K bleibt das Haus überheizt (Reserve über Minimum, ein Raum über Maximum oder alle über der Bandmitte)'},
            kalibriert: [],
            eval: function (d, c, rs) {
                if (!have(d.shift)) { return {inaktiv: 'Verschiebung der Anlage (TOP27) unbekannt'}; }
                var L = d.raum;
                if (!L || L.keine) { return {inaktiv: L ? L.code : 'keine Raumdaten'}; }
                if (L.dir === 0) { return {inaktiv: (L.verteil ? 'Wärmeverteilungsproblem, keine Verschiebung: ' : 'Räume brauchen keine Verschiebung: ') + L.code}; }
                var apR = d.arb && d.arb.applied && d.arb.applied.rule === 'raum_offset' && d.arb.applied.w === d.shift ? d.arb.applied : null;
                if (apR && sgnOf(L.dir) !== sgnOf(d.shift)) { return {inaktiv: 'Verschiebung ' + sg(d.shift, 0) + ' K (Raumeinfluss) steht; zurück auf 0 über den Rückweg (' + L.code + ')'}; }   // kein zweiter Weg zurueck neben dem Rueckweg
                var ziel = Math.max(-1, Math.min(1, d.shift + L.dir));                     // hoechstens 1 K je Befehl (RE-5), Whitelist -1/0/+1
                if (ziel === d.shift) { return {inaktiv: 'Verschiebung steht schon auf ' + sg(d.shift, 0) + ' K (' + L.code + ')'}; }
                var up = ziel > d.shift, sollNeu = have(d.soll) ? d.soll + (ziel - d.shift) : null, vlS = have(d.vl) && have(d.soll) ? d.vl - d.soll : null;
                var stab = rs.korrSince ? mins(d.now - rs.korrSince) : 0, ruhig = !d.kurveChg || d.now - d.kurveChg >= c.kurveRuhigMin * MIN;
                var cond = [
                    {k: 'stabil', kz: up ? 'Bedarf stabil' : 'Überschuss stabil', t: (up ? 'Bedarf' : 'Überschuss') + ' seit mindestens ' + c.stabilMin + ' min', tn: (up ? 'Bedarf' : 'Überschuss') + ' erst seit ' + stab + ' von ' + c.stabilMin + ' min (' + L.code + ')', ok: stab >= c.stabilMin, ist: stab, soll: c.stabilMin, op: '>=', u: 'min', dyn: true},
                    {k: 'kurve', kz: 'Kurve ruhig', t: 'kein natürlicher Sollsprung in den letzten ' + c.kurveRuhigMin + ' min', tn: 'natürlicher Sollsprung um ' + hhmm(d.kurveChg) + ' (nicht im selben 5-min-Takt schreiben wie die Kurve)', ok: ruhig || !!rs.prop}   // nur fuer den Zeitpunkt des Vorschlags
                ];
                if (!up) {
                    cond.push({k: 'untergrenze', kz: 'Soll-Vorlauf neu', t: 'Soll-Vorlauf bleibt mindestens ' + de(c.minVlC, 0) + ' °C', tn: 'Untergrenze: Soll-Vorlauf würde ' + de(sollNeu, 0) + ' °C (mindestens ' + de(c.minVlC, 0) + ' °C)', ok: have(sollNeu) && sollNeu >= c.minVlC - 1e-9, ist: r2(sollNeu), soll: c.minVlC, op: '>=', u: '°C', dyn: true});
                    if (d.running) { cond.push({k: 'vorlauf', kz: 'Vorlauf ≤ Soll', t: 'Vorlauf höchstens ' + sg(c.laufMinusK, 1) + ' K zum Soll (sonst in der Pause)', tn: 'Vorlauf ' + sg(vlS, 2) + ' K zum Soll: −1 K erst in der Pause oder bei Vorlauf ≤ Soll (danach ' + sg(have(vlS) ? vlS + 1 : null, 2) + ' K über dem neuen Soll)', ok: have(vlS) && vlS <= c.laufMinusK + 1e-9, ist: r2(vlS), soll: c.laufMinusK, op: '<=', u: 'K', dyn: true}); }
                    if (have(d.at) && d.at < c.abtauAtC) { cond.push({k: 'ruecklauf', kz: 'Rücklauf', t: 'Rücklauf mindestens ' + de(c.rlMinC, 0) + ' °C (Abtauen unter ' + de(c.abtauAtC, 0) + ' °C)', tn: 'Rücklauf ' + de(d.rl, 1) + ' °C unter ' + de(c.rlMinC, 0) + ' °C bei Außen ' + de(d.at, 0) + ' °C (RE-6)', ok: have(d.rl) && d.rl >= c.rlMinC, ist: d.rl, soll: c.rlMinC, op: '>=', u: '°C', dyn: true}); }
                }
                var bed = up ? L.kaltL.map(function (x) { return x.r.id; }) : [], lead = up ? (L.kaltL[0] ? L.kaltL[0].r.name : '') : (L.ueberL[0] ? L.ueberL[0].r.name : (L.warmst ? L.warmst.r.name : ''));
                var wz = wirkzeit(d, up ? 1 : -1, c), p2 = d.korr && have(num(d.korr.v)) ? ' · Phase 2: ' + sg(num(d.korr.v), 0) + ' K' : '';
                var erw = up ? (d.running ? 'Soll-Vorlauf +1 K binnen 6 min; im Lauf steigt die Stoppschwelle um 1 K (Lauf länger)' + (have(vlS) && vlS < 0.5 && d.q === 0 ? ', bei Quiet 0 und Vorlauf unter dem neuen Soll fährt der Verdichter hoch (11.10. 03:10: +48 % Strom)' : '')
                                         : 'Soll-Vorlauf +1 K binnen 6 min; in der Pause startet der Verdichter ' + (have(vlS) && vlS - 1 <= -START.sollK ? 'sofort (Vorlauf dann ' + sg(vlS - 1, 2) + ' K zum neuen Soll; gemessen 10.10. 18:20, 11.10. 19:10)' : '~1 K früher (Startschwelle Soll −3,25 K)'))
                              : (d.running ? 'Soll-Vorlauf −1 K binnen 6 min; Vorlauf danach ' + sg(have(vlS) ? vlS + 1 : null, 2) + ' K über dem neuen Soll: kein Stopp erwartet (gemessen bis +2,25 K: 18 von 18)'
                                           : 'Soll-Vorlauf −1 K binnen 6 min; Startschwelle 1 K tiefer, die Pause wird länger (Start bei Soll −3,25 K, Verzug ~' + de(d.startM ? d.startM.verzug : START.verzugStd, 0) + ' min, gemessen), der nächste Lauf endet 1 K früher');
                erw += '; Strom ' + (up ? '+' : '−') + '2,5–3 % (8,5 W/K); Raumwirkung ' + (wz.gemessen ? 'nach ~' + de(wz.min, 0) + ' min (Wirkzeit gemessen)' : 'nicht gemessen (Annahme ' + de(wz.min, 0) + ' min)');
                return {cond: cond, halt: 0, wert: ziel, von: d.shift, dir: up ? 'soll_hoch' : 'soll_runter', lead: lead, bed: bed, hart: komfortNot(d, up ? 1 : -1), maxDauerMin: c.maxDauerMin,
                        sprungHz: up && d.running && have(vlS) && vlS < 0.5 ? (d.hc === 0 ? 15 : (d.q === 0 ? 6 : 0)) : null,          // +1 K mit Hochlauf: Efficiency/Quiet 0 gemessen +6 Hz (11.10. 03:10), Comfort faehrt auf 30-35 Hz
                        erwartung: erw,
                        was: 'Heizkurve ' + sg(d.shift, 0) + ' → ' + sg(ziel, 0) + ' K (Soll-Vorlauf ' + de(d.soll, 0) + ' → ' + de(sollNeu, 0) + ' °C)',
                        warum: (up ? 'Bedarf' : 'Überschuss') + ' seit ' + stab + ' min: ' + L.code + (d.running ? '' : ' · Pause') + p2};
            }
        },
        {
            id: 'vorausschau', ver: 2, kachel: 'Vorausschau', kurz: 'Vorausschau −1 K', name: 'Vorausschau (Heizkurve −1 K)', art: 'befehl', groesse: 'shift', richtung: 'soll_runter', prio: 5, basis: 'vorausschau|v2',
            zweck: 'Senkt die Heizkurve um 1 K, bevor der Wärmebedarf WETTERBEDINGT sinkt (Milderung; Sonne und Wind nur mit freigegebenem Modell, coefActivate; der gewöhnliche Tagesgang ist herausgerechnet, die Uhrzeit allein löst nichts aus), solange alle Räume im Band liegen und der kälteste Raum Luft über seinem Minimum hat. Läuft erst mit offenem Gate des Gebäudemodells, nie gegen den aktuellen Raumzustand und nie gegen eine Verschiebung einer anderen Regel (Arbitrierung). Seit v2 (Review-Paket 13.10.2026) ohne den Zweig +1 K vor erwartetem Mehrbedarf: Die Anlage führt die Heizkurve selbst alle 5 min mit der Fühler-Außentemperatur nach (0,375 K Vorlauf je K, Verzug ≤ 5 min), die Heizkörper haben wenig Speichermasse, und bei Kälte lagen die Räume ohnehin 0,4–1,6 K über ihrer Bandmitte (unter 4 °C Kinderzimmer unten 90 % der Zeit über Maximum); +1 K hätte überheizte Räume weiter geheizt. Unter Quiet 0 löst +1 K bei Vorlauf unter Soll außerdem einen Hochlauf aus (11.10. 03:10: +48 % Strom), die Kosten waren unterschätzt. Nur −1 K zeigt in die Energie-Richtung.',
            eingaenge: ['Wettervorhersage OWM (+1 … +6 h, an den Außenfühler angeglichen)', 'gewöhnlicher Tagesgang (gemessene Außentemperatur bis 7 Vortage)', 'Gebäudemodell des Wärmefahrplans (UA, Heizgrenze tbal, Gate, coefActivate)', 'Sonne (PV-Prognose) und Wind nur mit coefActivate', 'Räume (alle gültig, eigenes Band)', 'Verschiebung der Anlage (TOP27) und Eigentümer der Verschiebung', 'Soll-Vorlauf'],
            sperren: ['anlauf', 'daten', 'stoerung', 'modell', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'heizstab'],
            befehl: {name: 'SetZ1HeatRequestTemperature', topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature'},
            schwellen: [
                {key: 'deltaK', std: 2, einheit: 'K', herkunft: 'Bedarfsänderung aus dem Wetter als Außentemperatur-Äquivalent (Mittel des Fensters gegen jetzt, beide um den gewöhnlichen Tagesgang bereinigt); OWM weicht vom Fühler 1,5–1,9 K ab (08.–10.10.), darunter ist die Vorhersage kein Signal; ANNAHME'},
                {key: 'tagesgangTage', std: 3, einheit: 'Vortage', herkunft: 'Der gewöhnliche Tagesgang wird aus den Vortagen gelernt (Abweichung jeder Uhrzeit vom 24-h-Mittel); mit nur einem Vortag steckt dessen Wetter darin (Replay: Kaltfront 08.10. abends erschien am 09.10. als −5 K); ANNAHME'},
                {key: 'vonH', std: 2, einheit: 'h', herkunft: 'Fensterbeginn: −1 K wirkt über Lauf und Pause erst nach 1–3 h im Raum (Speichermasse 7–10 kWh/K, Opus); ANNAHME'},
                {key: 'bisH', std: 5, einheit: 'h', herkunft: 'Fensterende: OWM liefert 3-h-Punkte, das Vertrauen fällt mit dem Vorlauf (Fahrplan: 1 − h/48); ANNAHME'},
                {key: 'reserveK', std: 0.3, einheit: 'K', herkunft: 'Luft im Band: der kälteste Raum liegt mindestens 0,3 K über seinem Minimum (wie guardK des früheren Fahrplans); ANNAHME'},
                {key: 'prognoseMaxMin', std: 120, einheit: 'min', herkunft: 'Fahrplan: Vorhersage gilt bis 2 h nach dem Abruf'},
                {key: 'haltMin', std: 30, einheit: 'min', herkunft: 'Vorhersage muss mindestens einen weiteren Abruf überstehen; ANNAHME'},
                {key: 'minVlC', std: 29, einheit: '°C', herkunft: 'Nutzervorgabe 08.10.: Soll-Vorlauf nie unter 29 °C (Heizkörper)'},
                {key: 'proTag', std: 2, einheit: 'Vorschläge', herkunft: 'Schreibbudget gemeinsam mit dem Raumeinfluss (Opus: höchstens 6 Schreibbefehle/Tag); ANNAHME'},
                {key: 'gueltigMin', std: 180, einheit: 'min', herkunft: 'Fensterende 5 h minus Fensterbeginn 2 h; ANNAHME'},
                {key: 'pauseMin', std: 180, einheit: 'min', herkunft: 'ANNAHME'},
                {key: 'maxDauerMin', std: 360, einheit: 'min', herkunft: 'Rückweg spätestens nach 6 h (wie Raumeinfluss, ANNAHME)'}
            ],
            erwartung: 'Soll-Vorlauf −1 K binnen 6 min (5-min-Raster), weniger Wärme vor dem erwarteten Wärmegewinn (Strom −2,5–3 %, 8,5 W/K); die Räume bleiben im Band, obwohl der Bedarf sinkt. Raumwirkung NICHT gemessen.',
            rueckweg: 'Automatisch zurück auf 0 K, sobald die Vorhersage die Milderung 15 min am Stück nicht mehr zeigt (halbe Schwelle), sofort, wenn ein Raum unter sein Minimum fällt, spätestens nach 6 h; nicht, solange der Raumeinfluss dieselbe Verschiebung verlangt.',
            prognose: {p: 0.6, h: [120, 240, 360], text: 'Ohne −1 K gerät der wärmste Raum an den oberen Bandrand (höchstens Reserve unter Maximum)'},
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
                // v2 (Review-Paket 13.10.2026): nur noch -1 K vor einer Milderung; ein erwarteter Mehrbedarf ist kein Ausloeser mehr (die Anlage fuehrt die Kurve selbst nach)
                var thr = rs.prop ? c.deltaK / 2 : c.deltaK;                                   // laufender Vorschlag: Hysterese (halbe Schwelle), kein Flattern
                var act = d.rooms.filter(function (r) { return r.active; }), allValid = act.length > 0 && act.every(function (r) { return r.valid && have(r.min) && have(r.max); });
                var out = act.filter(function (r) { return r.valid && ((have(r.min) && r.t < r.min) || (have(r.max) && r.t > r.max)); });
                var cold = null, warm = null;
                act.forEach(function (r) { if (!r.valid) { return; } if (cold === null || r.t - r.min < cold.t - cold.min) { cold = r; } if (warm === null || r.max - r.t < warm.max - warm.t) { warm = r; } });
                var resv = cold ? cold.t - cold.min : null, sollNeu = have(d.soll) ? d.soll - 1 : null;
                var cond = [
                    {k: 'bedarf', kz: 'Bedarfsänderung', t: 'Vorhersage: Bedarf sinkt um mindestens ' + de(thr, 1) + ' K', tn: 'Vorhersage: Bedarf ' + sg(dk, 1) + ' K (Schwelle −' + de(thr, 1) + ' K' + (dk > 0 ? '; vor Mehrbedarf seit v2 keine Verschiebung' : '') + ')', ok: -dk >= thr, ist: r2(-dk), soll: thr, op: '>=', u: 'K', dyn: true},
                    {k: 'raeume', kz: 'Räume gültig', t: 'alle aktiven Räume gültig', tn: 'nicht alle Räume gültig', ok: allValid},
                    {k: 'band', kz: 'Räume im Band', hart: true, t: 'alle Räume im Komfortband', tn: out.length ? out[0].name + ' außerhalb des Bandes (' + de(out[0].t, 1) + ' °C)' : 'Raumlage unbekannt', ok: allValid && out.length === 0},
                    {k: 'reserve', kz: 'Luft im Band', t: 'kältester Raum mindestens ' + de(c.reserveK, 1) + ' K über Minimum', tn: cold ? cold.name + ' nur ' + de(resv, 1) + ' K über Minimum' : 'kein Raum', ok: have(resv) && resv >= c.reserveK - 1e-9, ist: r2(resv), soll: c.reserveK, op: '>=', u: 'K', dyn: true},
                    {k: 'untergrenze', kz: 'Soll-Vorlauf neu', t: 'Soll-Vorlauf bleibt mindestens ' + de(c.minVlC, 0) + ' °C', tn: 'Soll-Vorlauf würde ' + de(sollNeu, 0) + ' °C (Untergrenze ' + de(c.minVlC, 0) + ' °C)', ok: have(sollNeu) && sollNeu >= c.minVlC - 1e-9, ist: r2(sollNeu), soll: c.minVlC, op: '>=', u: '°C', dyn: true}
                ];
                var lead = warm, f = vsFenster(v, c), tg = 0; for (var hh = c.vonH; hh <= c.bisH; hh++) { tg += d.vsBase.at[hh]; } tg = tg / (c.bisH - c.vonH + 1);
                var e = {cond: cond, halt: c.haltMin, wert: -1, von: d.shift, dir: 'soll_runter', lead: lead ? lead.name : '',
                         was: 'Heizkurve 0 → −1 K (Soll-Vorlauf ' + de(d.soll, 0) + ' → ' + de(sollNeu, 0) + ' °C)',
                         warum: 'Vorhersage +' + c.vonH + '…+' + c.bisH + ' h Ø ' + de(f.at, 1) + ' °C statt ' + de(v.at[0], 1) + ' °C jetzt, gewöhnlicher Tagesgang ' + sg(tg - d.vsBase.at[0], 1) + ' K: Bedarf ' + sg(dk, 1) + ' K aus dem Wetter' + (v.aktiv ? ' (mit Sonne/Wind)' : '') + '; ' + (lead ? lead.name + ' ' + de(lead.max - lead.t, 1) + ' K unter Maximum' : '')};
                if (gv) { e.vorab = gv; }
                return e;
            }
        },
        {
            id: 'heizregelung', ver: 1, kachel: 'Heizregelung', kurz: 'Heizregelung', name: 'Heizregelung (Comfort/Efficiency)', art: 'befehl', groesse: 'hc', richtung: 'mehr_leistung', prio: 4,
            basis: 'heizregelung|v1', basisMinus: 'heizregelung|v1|eff',
            zweck: 'Stellt die Heizregelung (SetHeatingControl 0 = Comfort, 1 = Efficiency). Ziel ist Efficiency, solange alle Räume mit Reserve im Band liegen, kein Heizstab-Risiko besteht und kein Abtau-Rückstand aufzuholen ist. Der Unterschied liegt nur in den trägen Phasen (Messung 07.–14.10.): Comfort fährt nach dem Start sofort 30–35 Hz, Efficiency bleibt bei 16–17 Hz und geht erst ab Laufminute 39–46 zeitweise auf 21–26 Hz; nach dem Abtauen hält Efficiency ~20 min niedrig (Forum 189605: L5 4582615, L7 4095732), Comfort fährt hoch. Bei 16–17 Hz mitten im Lauf ändert ein Wechsel die Frequenz nicht (12.10. 18:28, 13.10. 07:07), nur die Pumpe (Comfort→Efficiency 1750 → 2850–2900 U/min, kein Stopp). Comfort kostet beim Hochlauf COP (ab 28 Hz korrigiert −3 %, roh −5…−15 % gegen 16–17 Hz). Deshalb Comfort nur bei echtem Komfortbedarf (wie Quiet-Freigabe v3: Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Abtau-Rückstand, Boost von Hand), solange Efficiency träge ist (Anlaufphase bis Laufminute 45, nach dem Abtauen, Heizstab-Nähe), Vorlauf und Rücklauf Rückstand haben und der Quiet-Deckel den Hochlauf zulässt – bindet der Deckel, zuerst die Quiet-Freigabe (eine Leistungsänderung zur Zeit). Zurück nach Efficiency, wenn der Bedarf 15 min gedeckt ist (Hysterese), spätestens nach 4 h. Steht Comfort ohne Regel (von Hand), schlägt sie Efficiency vor, sobald der Bedarf 15 min gedeckt ist und der Wechsel von Hand mindestens 2 h zurückliegt. Kein Wechsel in der Startphase; Sperre „Frequenzsprung bei Abtauwetter“ (Pseudo-Abtauung nach langem Niedriglauf).',
            eingaenge: ['Heizregelung (Heating_Control) und Wechsel von Hand', 'Verdichterfrequenz, Laufzeit, Lauf/Pause', 'Soll-/Ist-Vorlauf, Rücklauf und Ziel-Spreizung', 'Bedarf wie Quiet-Freigabe v3 (Räume, Verlauf, Heizstab-Nähe, Abtau-Rückstand, Boost)', 'Quiet-Stufe und Deckel je Stufe', 'Heizstab (Heater_On_Outdoor_Temp, Heater_Start_Delta, Heater_Delay_Time)', 'Abtauen (Ende)', 'Räume (Reserve über Minimum)'],
            sperren: ['anlauf', 'daten', 'stoerung', 'mqtt_sperre', 'abtauen', 'warmwasser', 'laufbeginn', 'vorrang', 'gegenrichtung', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'abtausprung'],
            befehl: {name: 'SetHeatingControl', topic: 'panasonic_heat_pump/commands/SetHeatingControl'},
            schwellen: [
                {key: 'laufMin', std: 15, einheit: 'min', herkunft: 'kein Wechsel in der Startphase (Auftrag 14.10.): Pumpenspitze der Startroutine 11–16 min nach jedem Start (Messung 07.–13.10.); Comfort davor brächte nichts, was nicht schon ein Start in Comfort brächte'},
                {key: 'heizstabVorlaufMin', std: 5, einheit: 'min', herkunft: 'wie Quiet-Freigabe: bei Heizstab-Nähe endet die Startphase Heater_Delay_Time − 5 min − Haltezeit (hier Laufminute 7), der Vorschlag kommt 5 min vor der Heizstab-Freigabe; ANNAHME'},
                {key: 'haltHeizstabMin', std: 3, einheit: 'min', herkunft: 'Heizstab-Nähe: kurze Haltezeit (wie Quiet-Freigabe); ANNAHME'},
                {key: 'traegeMin', std: 45, einheit: 'min', herkunft: 'Efficiency träge: Comfort nur bis Laufminute 45 – Efficiency hielt nach dem Start 16–17 Hz und ging erst ab Laufminute 39–46 zeitweise auf 21–26 Hz (5 von 7 längeren Läufen, 07.–13.10.); danach regelt sie bei Rückstand selbst hoch (Boost 10.10. Laufminute 68, Efficiency: Quiet 3 → 0, 29 Hz nach 1 min, 34 Hz nach 2 min). Ausnahmen: Abtau-Rückstand und Heizstab-Nähe; ANNAHME'},
                {key: 'traegeHz', std: 21, einheit: 'Hz', herkunft: 'Efficiency träge = Verdichter höchstens 21 Hz (bei Frost höchstens Mindestfrequenz + 1 Hz, 25/35 Hz ab −4/−10 °C, Forum 189605 F1-a): 21 von 21 Efficiency-Starts 08.–14.10. mit 16–17 Hz bis Laufminute 15, zeitweise 21–26 Hz; Comfort-Starts sofort 30–35 Hz (12.10. 21:32: 35 Hz bei 6 °C, 13.10. 11:58: 31 Hz bei 13 °C)'},
                {key: 'mehrHz', std: 3, einheit: 'Hz', herkunft: 'Quiet-Deckel lässt den Hochlauf zu: Quiet 0 oder Deckel der Stufe mindestens 3 Hz über der jetzigen Frequenz (wie Quiet-Freigabe); sonst bindet der Deckel auch Comfort (13.10. 21:00 Comfort/Quiet 3: 17 Hz; 16:29 Comfort/Quiet 2: 21 Hz) → zuerst die Quiet-Freigabe'},
                {key: 'vlRueckK', std: 1.5, einheit: 'K', herkunft: 'Vorlauf mindestens 1,5 K unter Soll (wie Quiet-Freigabe): ohne Rückstand ändert Comfort die Frequenz nicht (12.10. 18:28 und 13.10. 07:07 Efficiency → Comfort bei 16 Hz am Soll: 16,6 → 16,6 Hz); ANNAHME'},
                {key: 'rlRueckK', std: 1.5, einheit: 'K', herkunft: 'Rücklauf mindestens 1,5 K unter Soll-Rücklauf (wie Quiet-Freigabe: ohne Rücklauf-Rückstand regelt der Verdichter nicht hoch); ANNAHME'},
                {key: 'hochHz', std: 28, einheit: 'Hz', herkunft: 'Bewertung des Wegs nach Efficiency: „Comfort fährt ohne Bedarf hoch“ = Verdichter mindestens 28 Hz ab Laufminute 2 (ab 28 Hz COP gegen 16–17 Hz korrigiert −3 %, roh −5…−15 %; Deckel/Laufzeit v5)'},
                {key: 'rueckMin', std: 15, einheit: 'min', herkunft: 'Bedarf gedeckt (Rückweg bzw. Vorschlag Efficiency): 15 min am Stück kein Bedarf, alle Räume ≥ Minimum + komfortK, Rücklauf höchstens rueckRlK unter Soll, kein Heizstab-Risiko, nicht nach dem Abtauen (Hysterese wie der Rückweg der Quiet-Freigabe; Auftrag); ANNAHME'},
                {key: 'rueckRlK', std: 0.5, einheit: 'K', herkunft: 'Bedarf gedeckt: Rücklauf höchstens 0,5 K unter Soll (wie Quiet-Freigabe); ANNAHME'},
                {key: 'komfortK', std: 0.3, einheit: 'K', herkunft: 'Efficiency nur mit Reserve: alle Räume (Wert bis 6 h alt) mindestens 0,3 K über Minimum (wie notK); ANNAHME'},
                {key: 'heizstabHystK', std: 1, einheit: 'K', herkunft: 'kein Heizstab-Risiko: Außen mindestens Heater_On_Outdoor_Temp + heaterMarginK (2 K) + 1 K, solange Comfort steht (Hysterese wie der Heizregelungs-Hinweis; die alte Warnung flackerte bei 4,0 °C, 74 Ereignisse in 6 Tagen); ANNAHME, keine Frostdaten'},
                {key: 'abtauNachMin', std: 30, einheit: 'min', herkunft: 'nach dem Abtauen 30 min kein Wechsel nach Efficiency: Comfort holt den Abtau-Rückstand auf (Abtau-Rückstand als Bedarf wie Quiet-Freigabe v3: 30 min, Vorlauf ≥ 3 K unter Soll; Forum 189605 4582615, 4095732, 4096011); ANNAHME, ohne eigene Abtau-Daten'},
                {key: 'copTol', std: 0.10, einheit: 'Anteil', herkunft: 'Veto gegen Efficiency: kein Vorschlag nach Efficiency, wenn ihr COP bei derselben Quiet-Stufe und im selben Außenband mehr als 10 % unter dem von Comfort liegt (nur wenn beide copMinMin Minuten haben, Nutzerentscheidung 13.10.2026; wie das COP-Veto von Deckel/Laufzeit). Stand 14.10.: Comfort Quiet 0 bei 3…11 °C 7–12 % über Efficiency (je 2,3 h, stabile Minuten ab Laufminute 15, korrigiert; nicht belastbar: Tageszeit, Durchfluss 13,6 gegen 15,1 l/min, Pth ±10 %)'},
                {key: 'handRuheMin', std: 120, einheit: 'min', herkunft: 'nach einem Wechsel von Hand (Heizregelung-Schalter) 2 h kein Vorschlag zurück, außer Notfall (Heizstab-Nähe, Raum ≥ 0,3 K unter Minimum): der Nutzer schaltete 08.–13.10. siebenmal selbst (08.10. 10:02, 12.10. 18:26 und 22:00, 13.10. 07:06, 15:29, 15:40, 22:43); kein Pendeln gegen den Nutzer; ANNAHME'},
                {key: 'haltMin', std: 10, einheit: 'min', herkunft: 'wie Quiet-Freigabe: Bedingungen 10 min am Stück (Comfort-Richtung; die Efficiency-Richtung hat ihre 15 min in „Bedarf gedeckt“)'},
                {key: 'proTag', std: 3, einheit: 'Vorschläge', herkunft: 'höchstens 3 übernommene Wechsel je Tag (ein Comfort-Fenster mit Rückweg sind 2 Befehle; die Übernahme begrenzt ohnehin auf 6 Befehle am Tag); ANNAHME'},
                {key: 'gueltigMin', std: 30, einheit: 'min', herkunft: 'wie Quiet-Freigabe; ANNAHME'},
                {key: 'pauseMin', std: 60, einheit: 'min', herkunft: 'wie Mindestabstand; ANNAHME'},
                {key: 'maxDauerMin', std: 240, einheit: 'min', herkunft: 'Comfort-Rückweg spätestens nach 4 h (wie Quiet-Freigabe), aber nicht, solange Bedarf, Heizstab-Nähe oder Abtau-Nachlauf besteht (dann hält Comfort); ANNAHME'}
            ],
            erwartung: 'Comfort: Verdichter mindestens +6 Hz binnen 5 min, elektrische Leistung +100 W oder mehr (Comfort-Starts 30–35 Hz bei 764–815 W gegen Efficiency 16–17 Hz bei ~400 W, 4–8 °C, 07.–14.10.; ein Wechsel im Lauf mit Rückstand ist nicht gemessen), Pumpe bleibt ΔT-geregelt (~1750 U/min, 13,6 l/min); COP ab 28 Hz korrigiert −3 % (roh −5…−15 %) gegen 16–17 Hz. Efficiency: der nächste Start bleibt bis Laufminute 15 bei höchstens 21 Hz (21 von 21 Efficiency-Starts mit 16–17 Hz); im Lauf springt die Pumpe in ≤ 1 min auf 2850–2900 U/min (08.10. 10:03, 12.10. 22:01; nicht 13.10. 22:45), kein Stopp durch den Wechsel',
            rueckweg: 'Comfort: automatisch zurück auf Efficiency, sobald der Bedarf 15 min am Stück gedeckt ist (alle Räume ≥ Minimum + 0,3 K, Rücklauf höchstens 0,5 K unter Soll, kein Heizstab-Risiko, nicht binnen 30 min nach dem Abtauen); spätestens nach 4 h, solange weder Bedarf noch Heizstab-Nähe noch Abtau-Nachlauf besteht; höchstens 3 Sendeversuche. Efficiency: kein Rückweg (Normalzustand; die Übernahme endet mit der Bestätigung).',
            prognose: {p: 0.7, h: [15, 30], text: 'Ohne Comfort bleibt Efficiency träge: Verdichter höchstens 21 Hz und Vorlauf mindestens 1 K unter Soll'},
            prognoseMinus: {p: 0.6, h: [120, 240], text: 'Ohne Efficiency fährt der Verdichter in Comfort ohne Bedarf hoch (mindestens 28 Hz ab Laufminute 2)'},
            kalibriert: ['2026-10-08 10:03', '2026-10-12 22:01', '2026-10-13 15:31', '2026-10-13 22:45'],
            eval: function (d, c) {
                if (!have(d.hc) || (d.hc !== 0 && d.hc !== 1)) { return {inaktiv: 'Heizregelung unbekannt'}; }
                var H = d.hcL || {}, B = d.bedQ || {}, AH = d.arbH, now = d.now;
                if (d.hc === 0 && AH && AH.applied && AH.applied.rule === 'heizregelung' && AH.applied.w === 0) { return {inaktiv: 'Comfort (Heizregelung) steht; zurück auf Efficiency über den Rückweg'}; }   // kein zweiter Weg zurueck neben dem Rueckweg
                var hand = H.hand && H.hand.w === d.hc && now - H.hand.t < c.handRuheMin * MIN ? H.hand : null;          // Wechsel von Hand auf den jetzigen Modus: 2 h Ruhe (ausser Notfall)
                if (d.hc === 1) {
                    if (!B.ja) { return {inaktiv: 'Efficiency ohne Bedarf'}; }                     // Normalzustand: kurz (Datensatzgroesse; Efficiency ist das Ziel)
                    var lm = H.lm, cap = H.cap || {}, zHz = d.q === 0 ? Q0_HZ : (have(cap.hz) ? cap.hz : null);
                    var cond = [
                        {k: 'lauf', kz: 'Verdichter läuft', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running},
                        {k: 'laufMin', kz: 'Laufzeit', t: 'Lauf seit mindestens ' + lm + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + lm + ' min', ok: d.runMin >= lm, ist: r2(d.runMin), soll: lm, op: '>=', u: 'min', dyn: true},
                        {k: 'bedarf', kz: 'Bedarf', t: B.ja ? 'Bedarf: ' + B.txt : 'Bedarf (Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Abtau-Rückstand, Boost von Hand)', tn: 'kein Bedarf: ' + (B.keinTxt || '–'), ok: !!B.ja},
                        {k: 'traege', kz: 'Efficiency träge', t: 'Efficiency träge: Verdichter höchstens ' + H.traegeHz + ' Hz ' + (B.abtau ? 'nach dem Abtauen' : (B.heizstab ? 'bei Heizstab-Nähe' : 'bis Laufminute ' + c.traegeMin)),
                         tn: !have(d.hz) || d.hz > H.traegeHz ? 'Verdichter bei ' + de(d.hz, 0) + ' Hz (Efficiency regelt schon hoch)' : 'Laufminute ' + de(d.runMin, 0) + ': Efficiency regelt ab Laufminute ' + c.traegeMin + ' selbst hoch', ok: !!H.traege},
                        {k: 'deckel', kz: 'Quiet-Deckel', t: d.q === 0 ? 'Quiet 0: kein Deckel' : 'Quiet ' + d.q + ' lässt bis ' + de(cap.hz, 0) + ' Hz zu', tn: 'Quiet ' + d.q + ' deckelt bei ' + de(cap.hz, 0) + ' Hz: zuerst die Quiet-Freigabe', ok: !!H.capOk},
                        {k: 'vlRueck', kz: 'Vorlauf-Rückstand', t: 'Vorlauf mindestens ' + de(c.vlRueckK, 1) + ' K unter Soll', tn: 'Vorlauf ' + rueckTxt(d.vlRueck) + ' (Schwelle ' + de(c.vlRueckK, 1) + ' K darunter)', ok: have(d.vlRueck) && d.vlRueck >= c.vlRueckK, ist: r2(d.vlRueck), it: rueckTxt(d.vlRueck), soll: c.vlRueckK, op: '>=', u: 'K', dyn: true},
                        {k: 'rlRueck', kz: 'Rücklauf-Rückstand', t: 'Rücklauf mindestens ' + de(c.rlRueckK, 1) + ' K unter Soll-Rücklauf', tn: 'Rücklauf ' + rueckTxt(d.rlRueck) + ' (Schwelle ' + de(c.rlRueckK, 1) + ' K darunter)', ok: have(d.rlRueck) && d.rlRueck >= c.rlRueckK, ist: r2(d.rlRueck), it: rueckTxt(d.rlRueck), soll: c.rlRueckK, op: '>=', u: 'K', dyn: true}
                    ];
                    if (hand) { cond.push({k: 'hand', kz: 'Wechsel von Hand', t: 'kein Wechsel von Hand auf Efficiency in den letzten ' + c.handRuheMin + ' min (oder Notfall)', tn: 'Efficiency von Hand um ' + hhmm(hand.t) + ': Comfort frühestens ' + hhmm(hand.t + c.handRuheMin * MIN) + ' (außer Notfall)', ok: !!B.notfall}); }
                    return {cond: cond, halt: B.heizstab ? c.haltHeizstabMin : c.haltMin, wert: 0, von: 1, dir: 'mehr_leistung', groesse: 'hc', hart: !!B.notfall, startMin: lm, heizstab: !!B.heizstab, maxDauerMin: c.maxDauerMin,
                            sprungHz: have(zHz) && have(d.hz) ? zHz - d.hz : null,                    // Sperre "Frequenzsprung bei Abtauwetter": Comfort faehrt auf 30-35 Hz (unter Quiet 1/2 bis zum Deckel)
                            erwartung: 'Comfort fährt sofort hoch: Verdichter mindestens ' + de(have(d.hz) ? d.hz + 6 : null, 0) + ' Hz binnen 5 min (bis ' + (d.q === 0 ? '30–35 Hz' : de(cap.hz, 0) + ' Hz, Deckel Quiet ' + d.q) + '), elektrische Leistung +100 W oder mehr; Vorlauf holt den Rückstand in Minuten auf statt nach Laufminute 39–46 (Comfort-Starts 12.10. 21:32 und 13.10. 11:58: 31–35 Hz, Soll −1 K nach 2–6 min; Wechsel im Lauf mit Rückstand nicht gemessen); Pumpe bleibt ΔT-geregelt; COP ab 28 Hz korrigiert −3 % gegen 16–17 Hz',
                            was: 'Heizregelung Efficiency → Comfort',
                            warum: 'Efficiency hält ' + de(d.hz, 0) + ' Hz bei Vorlauf ' + de(d.vlRueck, 1) + ' K und Rücklauf ' + de(d.rlRueck, 1) + ' K unter Soll, Lauf ' + de(d.runMin, 0) + ' min, ' + (d.q === 0 ? 'Quiet 0' : 'Quiet ' + d.q + ' bis ' + de(cap.hz, 0) + ' Hz') + '; Bedarf: ' + B.txt};
                }
                // Comfort ohne Regel (von Hand oder vor dem Einspielen): Efficiency, sobald der Bedarf gedeckt ist (Ziel Efficiency)
                var gk = H.atNah === null ? 'Heizstab-Grenze unbekannt (Heater_On_Outdoor_Temp fehlt)' : 'Außen ' + de(d.at, 0) + ' °C: Heizstab-Nähe (Efficiency erst ab Heater_On_Outdoor_Temp + ' + de(H.grenzeK, 0) + ' K)';
                var cond2 = [
                    {k: 'komfort', kz: 'Komfort sicher', t: 'alle Räume mindestens ' + de(c.komfortK, 1) + ' K über Minimum, auch in 2 h beim jetzigen Gefälle über Minimum', tn: H.ks && !H.ks.ok ? H.ks.txt : (H.resPRaum || 'ein Raum') + ' fällt: in 2 h ' + de(H.resP, 1) + ' K zum Minimum', ok: !!(H.ks && H.ks.ok && H.trendOk)},
                    {k: 'hochlauf', kz: 'Quiet lässt Hochlauf zu', t: d.q === 0 ? 'Quiet 0: Comfort fährt beim Start hoch (Kosten)' : 'Quiet ' + d.q + ' lässt bis ' + de((H.cap || {}).hz, 0) + ' Hz zu (Comfort fährt hoch)', tn: 'Quiet ' + d.q + ' deckelt bei ' + de((H.cap || {}).hz, 0) + ' Hz: Comfort fährt ohnehin nicht hoch, Efficiency brächte nichts', ok: !!H.hochOk},
                    {k: 'heizstab', kz: 'kein Heizstab-Risiko', t: 'kein Heizstab-Risiko (Außen ' + de(d.at, 0) + ' °C)', tn: gk, ok: H.atNah === false},
                    {k: 'cop', kz: 'COP-Veto', t: 'Efficiency höchstens ' + de(c.copTol * 100, 0) + ' % COP unter Comfort' + (have(H.copC) && have(H.copE) ? ' (' + de(H.copE, 2) + ' gegen ' + de(H.copC, 2) + ')' : ' (zu wenig Daten je Modus, Veto ruht)'),
                     tn: 'COP Efficiency ' + de(H.copE, 2) + ' statt ' + de(H.copC, 2) + ' (Comfort, Quiet ' + d.q + ', ' + H.copBand + ' °C): mehr als ' + de(c.copTol * 100, 0) + ' % schlechter', ok: !H.copVeto},
                    {k: 'abtau', kz: 'nicht nach Abtauen', t: 'kein Abtauen in den letzten ' + c.abtauNachMin + ' min', tn: d.defrost ? 'Abtauen läuft' : 'Abtauen bis ' + hhmm(H.abtauEnde) + ' (Comfort holt den Rückstand auf)', ok: !H.abtauNach},
                    {k: 'ruecklauf', kz: 'Rücklauf', t: 'Rücklauf höchstens ' + de(c.rueckRlK, 1) + ' K unter Soll (oder Pause)', tn: 'Rücklauf ' + rueckTxt(d.rlRueck), ok: !!H.rlOk},
                    {k: 'gedeckt', kz: 'Bedarf gedeckt', t: 'Bedarf seit mindestens ' + c.rueckMin + ' min gedeckt', tn: B.ja ? 'Bedarf: ' + B.txt : (H.deck ? 'Bedarf erst seit ' + de(H.deckMin, 0) + ' von ' + c.rueckMin + ' min gedeckt' : 'Bedarf nicht gedeckt'),
                     ok: H.deckMin >= c.rueckMin, ist: Math.floor(H.deckMin), soll: c.rueckMin, op: '>=', u: 'min', dyn: !!H.deck}
                ];
                if (hand) { cond2.push({k: 'hand', kz: 'Wechsel von Hand', t: 'kein Wechsel von Hand auf Comfort in den letzten ' + c.handRuheMin + ' min', tn: 'Comfort von Hand um ' + hhmm(hand.t) + ': Efficiency frühestens ' + hhmm(hand.t + c.handRuheMin * MIN), ok: false}); }
                return {cond: cond2, halt: 0, wert: 1, von: 0, dir: 'weniger_leistung', groesse: 'hc', einmal: true,
                        erwartung: d.running ? 'Pumpe springt in ≤ 1 min auf 2850–2900 U/min (08.10. 10:03, 12.10. 22:01), kein Stopp durch den Wechsel; die Frequenz bleibt (am Minimum 16–17 Hz); der nächste Start bleibt bis Laufminute 15 bei höchstens 21 Hz statt 30–35 Hz'
                                             : 'der nächste Start bleibt bis Laufminute 15 bei höchstens 21 Hz statt 30–35 Hz (21 von 21 Efficiency-Starts mit 16–17 Hz); im Lauf hebt Efficiency den Durchfluss (15,1 statt 13,6 l/min bei 8–11 °C)',
                        rueckweg: 'kein Rückweg: Efficiency ist der Normalzustand (die Übernahme endet mit der Bestätigung); Comfort schlägt die Regel bei Bedarf wieder vor',
                        was: 'Heizregelung Comfort → Efficiency',
                        warum: 'Comfort ohne Bedarf seit ' + de(H.deckMin, 0) + ' min (alle Räume mindestens ' + de(c.komfortK, 1) + ' K über Minimum, ' + (d.running ? 'Rücklauf ' + rueckTxt(d.rlRueck) : 'Pause') + ', Außen ' + de(d.at, 0) + ' °C ohne Heizstab-Risiko)' + (H.hand && H.hand.w === 0 ? '; Comfort von Hand um ' + hhmm(H.hand.t) : '')};
            }
        }
    ];
    var RULE = {}; RULES.forEach(function (r) { RULE[r.id] = r; });
    // Stillgelegte Regeln (Review-Paket 13.10.2026): nicht mehr im Regelwerk. Ihre Summen bleiben im Zustand unter dem alten Schluessel stehen (sc.tot
    // "regel|vN|sM", Basisraten, Punkteverlauf, Wochenuebersicht); offene Faelle, Vergleichslagen und Wirkungsmessungen dieser Regeln enden beim Laden ohne
    // Buchung (fixState). Die Kennzahl "beobachtete Heizgrenze" (Takt-Messung) bleibt; neu ist die Kennzahl "Ueberheizt bei AT >= 11 °C" (UEB).
    var STILLGELEGT = [
        {id: 'heizgrenze_hinweis', ver: 1, name: 'Heizgrenze 12 → 10 °C (nur Hinweis)', seit: '2026-10-13',
         grund: 'Regel-Review 4.1: Der Hinweis verlagerte gebrauchte Wärme aus den Stunden mit dem besten COP (6,5–6,8 bei 11–14 °C) in kältere Stunden (5,0–5,6 bei 1–6 °C); bei allen Läufen mit Außentemperatur ≥ 11 °C lag mindestens ein Raum unter seiner Bandmitte; am 12.10. fiel Kinderzimmer unten nach dem Hinweis trotz der Läufe unter sein Minimum, die Bewertung zählte trotzdem einen Treffer (der Lauf, den er vermeiden wollte, fand statt).'}
    ];

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
                         schaden: {quiet_freigabe: ['komfort'], quiet_strecken: ['takt', 'ueberschwingen'], raum_offset: ['komfort'], heizregelung: ['komfort', 'heizstab']}},   // Vorausschau: "komfort" galt nur dem Zweig +1 K (bis v1)
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
                    hcHaltMin: 60, hcGegenMin: 240,                   // Heizregelung (Comfort/Efficiency, 14.10.2026): wie Quiet (ANNAHME)
                    notfallMin: 10,                                   // Quiet-Notfall (Heizstab-Naehe, Raum >= notK unter Minimum) ueberbrueckt Mindestabstand, Wartezeit, Vorrang und Gegenrichtung nach 10 min (Regel-Review B4; ANNAHME)
                    abtauAtMin: -5, abtauAtMax: 4, abtauNiedrigMin: 60, abtauNiedrigHz: 20, sprungHz: 8};   // Frequenzsprung bei Abtauwetter (Forum 189605 F6-a, 4540566/4230252/4581423; ANNAHME)
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
        // Abtau-Rueckstand (v3, Forum 189605 F2/F6): Efficiency haelt nach dem Abtauen ~20 min niedrige Frequenz, Comfort faehrt hoch -> in Efficiency ist der Rueckstand Bedarf
        o.abtau = !!(d.running && d.hc === 1 && S.defrostEnd && !d.defrost && d.now - S.defrostEnd <= c.abtauNachMin * MIN && have(d.vlRueck) && d.vlRueck >= c.abtauRueckK);
        if (o.abtau) { parts.push('Abtau-Rückstand (Abtauen bis ' + hhmm(S.defrostEnd) + ', Vorlauf ' + de(d.vlRueck, 1) + ' K unter Soll; Efficiency hält danach ~20 min niedrig)'); }
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
        var kalt = !!(K.halten && fa && have(capV) && hartCap(d, have(K.at) ? K.at : d.at, capV, c1));   // hart auch, wenn die Stufe nur die Mindestfrequenz haelt (Frost)
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
    // ------------------------------------------------------------------ Heizregelung (14.10.2026): Lage fuer Regel, Rueckweg und Datensatz
    // Comfort-Bedarf: Bedarf wie Quiet-Freigabe v3 (bedQ) UND Efficiency traege (bis Laufminute traegeMin, nach dem Abtauen oder bei Heizstab-Naehe, hoechstens traegeHz)
    // UND Rueckstand (Vorlauf/Ruecklauf) UND der Quiet-Deckel laesst den Hochlauf zu. Bedarf gedeckt (Efficiency): kein Bedarf, alle Raeume >= Minimum + komfortK,
    // Ruecklauf hoechstens rueckRlK unter Soll (oder Pause), kein Heizstab-Risiko (Aussen >= Heater_On + heaterMarginK, solange Comfort steht + heizstabHystK), nicht
    // binnen abtauNachMin nach dem Abtauen; seit wann (S.hcDeckSince). lage: +1 Comfort-Bedarf (in Efficiency), -1 Efficiency moeglich (in Comfort), 0 sonst.
    function hcLage(S, d, cfg) {
        var c = cfg.rules.heizregelung, B = d.bedQ || {}, now = d.now, o = {};
        var grenze = have(d.htrOn) ? d.htrOn + cfg.locks.heaterMarginK : null;
        o.grenzeK = cfg.locks.heaterMarginK + (d.hc === 0 ? c.heizstabHystK : 0);
        S.hcAtNah = (have(grenze) && have(d.at)) ? (d.at < grenze + (d.hc === 0 ? c.heizstabHystK : 0)) : null;
        o.atNah = S.hcAtNah;                                                                     // null = Heizstab-Grenze oder Aussentemperatur unbekannt
        o.abtauEnde = S.defrostEnd || 0;
        o.abtauNach = !!d.defrost || !!(S.defrostEnd && now - S.defrostEnd < c.abtauNachMin * MIN);
        o.ks = komfortSicher(d, {komfortK: c.komfortK});
        var L3 = d.raum; o.resP = (L3 && !L3.keine && have(L3.reserveP)) ? L3.reserveP : null; o.resPRaum = (L3 && L3.knappP) ? L3.knappP.r.name : '';   // knappster Raum in prognoseH h beim jetzigen Gefaelle (Raumeinfluss v3)
        o.trendOk = !have(o.resP) || o.resP >= 0;
        o.rlOk = !d.running || (have(d.rlRueck) && d.rlRueck <= c.rueckRlK);
        o.deck = !!(d.fresh && !B.ja && o.ks.ok && o.trendOk && o.rlOk && o.atNah === false && !o.abtauNach);
        if (d.fresh) { S.hcDeckSince = o.deck ? (S.hcDeckSince || now) : 0; }
        o.deckMin = S.hcDeckSince ? (now - S.hcDeckSince) / MIN : 0;
        o.lm = B.heizstab ? Math.max(3, d.htrDelay - c.heizstabVorlaufMin - c.haltHeizstabMin) : c.laufMin;
        o.cap = have(d.q) ? deckelOf(d, d.q) : {hz: null};
        o.capOk = d.q === 0 || (have(o.cap.hz) && have(d.hz) && o.cap.hz >= d.hz + c.mehrHz);
        o.hochOk = d.q === 0 || (have(o.cap.hz) && o.cap.hz >= c.hochHz);                     // Comfort kann ueberhaupt hochfahren (sonst kostet Comfort nichts: kein Effizienz-Gewinn durch Efficiency)
        var mh = have(d.at) ? minHzAt(d, d.at).hz : null;                                        // Frost: Efficiency haelt dann die Mindestfrequenz (25/35 Hz, Forum F1-a)
        o.traegeHz = have(mh) ? Math.max(c.traegeHz, mh + 1) : c.traegeHz;
        o.traege = !!(d.running && have(d.hz) && d.hz <= o.traegeHz && (d.runMin < c.traegeMin || B.abtau || B.heizstab));
        o.rueck = have(d.vlRueck) && d.vlRueck >= c.vlRueckK && have(d.rlRueck) && d.rlRueck >= c.rlRueckK;
        // COP-Veto gegen Efficiency (Daten je Heizregelung x Quiet x Aussenband, Takt-Messung): nur wenn beide Modi copMinMin Minuten haben
        var band = have(d.at) ? bandOf(d.at) : null, tc = d.tc || taktCfg(null), kq = have(d.q) ? d.q : '?';
        var aC = band && d.copSum ? d.copSum['Comfort|' + kq + '|' + band] : null, aE = band && d.copSum ? d.copSum['Efficiency|' + kq + '|' + band] : null;
        o.copC = aC && aC[2] >= tc.copMinMin && aC[0] > 0 ? aC[1] / aC[0] : null; o.copE = aE && aE[2] >= tc.copMinMin && aE[0] > 0 ? aE[1] / aE[0] : null; o.copBand = band;
        o.copVeto = have(o.copC) && have(o.copE) && o.copE < o.copC * (1 - c.copTol);
        o.lage = (d.hc === 1 && B.ja && o.traege && o.capOk && o.rueck && d.runMin >= o.lm) ? 1 : ((d.hc === 0 && o.deckMin >= c.rueckMin && o.hochOk && !o.copVeto) ? -1 : 0);
        o.hand = S.hcHandT ? {t: S.hcHandT, w: S.hcHandW} : null;
        return o;
    }
    // Rueckweg einer von der Regel uebernommenen Comfort-Stellung: Bedarf rueckMin gedeckt; "halten" (kein Ablauf), solange Bedarf, Heizstab-Naehe oder Abtau-Nachlauf besteht
    function hcEnde(d, cfg, H) {
        var c = cfg.rules.heizregelung, B = d.bedQ || {}, o = {ende: null, halten: null};
        if (B.ja) { o.halten = 'Bedarf besteht weiter: ' + B.txt; }
        else if (H.atNah) { o.halten = 'Heizstab-Nähe: Außen ' + de(d.at, 0) + ' °C (Comfort bis Heater_On_Outdoor_Temp + ' + de(H.grenzeK, 0) + ' K)'; }
        else if (H.abtauNach) { o.halten = 'Abtauen' + (H.abtauEnde && !d.defrost ? ' bis ' + hhmm(H.abtauEnde) : '') + ' (Efficiency hielte danach ~20 min niedrig)'; }
        else if (H.deckMin >= c.rueckMin) { o.ende = 'Bedarf seit ' + c.rueckMin + ' min gedeckt (alle Räume ≥ Minimum + ' + de(c.komfortK, 1) + ' K, Rücklauf höchstens ' + de(c.rueckRlK, 1) + ' K unter Soll, kein Heizstab-Risiko)'; }
        return o;
    }
    // ------------------------------------------------------------------ Raumeinfluss v3 (14.10.2026): Lage der Raeume direkt aus Baendern, Wert (EMA), Verlauf und Lueften
    var RELAIS_RAUM = 'ki_oben';  // Kinderzimmer oben hat eine eigene Relaisregelung (Radiator, Tab Dashboard, Soll 23,0 °C): kalt zaehlt nur bei offenem Relais (kzRad 1 oder unbekannt), RE-8
    function raumNutzbar(r, c) { return !!(r.active && have(r.t) && have(r.min) && have(r.max) && (r.valid || (have(r.age) && r.age <= c.raumAlterMaxMin))); }
    // Verlauf eines Raums: K/h per Regression im 5-min-Raster ueber trendMin (Lauf und Pause), nach einem Lueftungssturz (>= lueftungK binnen 60 min) erst ab dem Sturz;
    // lueft = Sturz in den letzten lueftSperreMin
    function raumVerlauf(S, r, now, c) {
        var L = (S.rtr && S.rtr[r.id]) || [], lk = c.lueftungK, sturz = 0;
        for (var j = 1; j < L.length; j++) {
            if (L[j][1] >= L[j - 1][1]) { continue; }
            for (var i = j - 1; i >= 0 && L[i][0] >= L[j][0] - 60 * MIN; i--) { if (L[i][1] - L[j][1] >= lk - 1e-9) { sturz = Math.max(sturz, L[j][0]); break; } }
        }
        var o = {kh: null, lueft: !!(sturz && now - sturz < c.lueftSperreMin * MIN), sturz: sturz};
        var t0 = Math.max(now - c.trendMin * MIN, sturz);
        if (!L.length || now - t0 < TR.minSpanMin * MIN) { return o; }
        function wert(t) { var v = null; for (var k = 0; k < L.length && L[k][0] <= t; k++) { v = L[k][1]; } return v; }
        var xs = [], ys = [];
        for (var t = now; t >= t0 - 1000; t -= TR.rasterMin * MIN) { var v = wert(t); if (have(v)) { xs.push((t - now) / 3600000); ys.push(v); } }
        if (xs.length < TR.minPunkte) { return o; }
        var mx = 0, my = 0, sxx = 0, sxy = 0, n = xs.length;
        for (var a = 0; a < n; a++) { mx += xs[a] / n; my += ys[a] / n; }
        for (var b = 0; b < n; b++) { sxx += (xs[b] - mx) * (xs[b] - mx); sxy += (xs[b] - mx) * (ys[b] - my); }
        if (sxx > 0) { o.kh = r2(sxy / sxx); }
        return o;
    }
    // Lage aller Raeume -> dir (+1 Bedarf, -1 Ueberschuss, 0 nichts), Gruende, Bedarfs-/Ueberschussraeume, Reserve, Waermeverteilung
    function raumLage(S, d, cfg) {
        var c = cfg.rules.raum_offset, now = d.now;
        var act = d.rooms.filter(function (r) { return r.active && have(r.min) && have(r.max); });
        var x = act.map(function (r) {
            var ok = raumNutzbar(r, c), v = ok ? raumVerlauf(S, r, now, c) : {kh: null, lueft: false}, mid = (r.min + r.max) / 2, relaisAus = r.id === RELAIS_RAUM && d.kzRad === 0;
            var erholtAuf = have(v.kh) && v.kh >= c.erholKh, erholtAb = have(v.kh) && v.kh <= -c.erholKh;
            if (ok && have(v.kh) && v.kh <= -c.lueftKh) { v.lueft = true; }                            // Sturz schneller als Heizen/Auskuehlen: Lueften (kein Bedarf)
            var kaltRoh = ok && r.t <= r.min - c.kaltK + 1e-9;
            return {r: r, ok: ok, kh: v.kh, lueft: v.lueft, mid: mid, relaisAus: relaisAus, kaltRoh: kaltRoh,
                    kalt: kaltRoh && !v.lueft && !erholtAuf && !relaisAus, ueber: ok && r.t >= r.max + c.warmK - 1e-9 && !erholtAb};
        });
        var okL = x.filter(function (y) { return y.ok; }), o = {dir: 0, rooms: x, kaltL: [], ueberL: [], reserve: null, knapp: null, warmst: null, hausWarm: false, verteil: false, keine: false, code: '', alle: okL.length === act.length && act.length > 0};
        if (!okL.length) { o.keine = true; o.code = act.length ? 'keine gültigen Raumwerte (älter als ' + c.raumAlterMaxMin + ' min)' : 'keine Räume mit Komfortband'; return o; }
        okL.forEach(function (y) { var m = y.r.t - y.r.min; if (o.knapp === null || m < o.reserve) { o.knapp = y; o.reserve = r2(m); } if (o.warmst === null || y.r.t - y.mid > o.warmst.r.t - o.warmst.mid) { o.warmst = y; } });
        o.knappP = null; o.reserveP = null;                                                            // Reserve in prognoseH Stunden beim jetzigen Gefaelle (nur fallende Raeume)
        okL.forEach(function (y) { var m = y.r.t - y.r.min + (have(y.kh) ? Math.min(0, y.kh) * c.prognoseH : 0); if (o.reserveP === null || m < o.reserveP) { o.reserveP = r2(m); o.knappP = y; } });
        o.lueftL = okL.filter(function (y) { return y.lueft; });                                       // geluefteter Raum: kein Bedarf, aber auch keine Absenkung
        o.kaltL = x.filter(function (y) { return y.kalt; }).sort(function (a, b) { return (a.r.t - a.r.min) - (b.r.t - b.r.min); });
        o.ueberL = x.filter(function (y) { return y.ueber; }).sort(function (a, b) { return (b.r.t - b.r.max) - (a.r.t - a.r.max); });
        o.hausWarm = o.alle && okL.every(function (y) { return y.r.t > y.mid; });
        o.mitte = r2(okL.reduce(function (a, y) { return a + (y.r.t - y.mid); }, 0) / okL.length);
        o.verteil = o.kaltL.length > 0 && o.ueberL.length > 0;
        function nm(y, vz) { return y.r.name + ' ' + sg(vz > 0 ? y.r.t - y.r.max : y.r.t - y.r.min, 1) + ' K'; }
        if (o.kaltL.length) {
            var not = o.kaltL.some(function (y) { return y.r.t <= y.r.min - c.verteilNotK + 1e-9; });
            o.dir = (!o.verteil || not) ? 1 : 0;
            o.code = 'Bedarf: ' + o.kaltL.map(function (y) { return nm(y, -1) + ' zum Minimum' + (have(y.kh) ? ' (' + sg(y.kh, 1) + ' K/h)' : ''); }).join(', ') +
                     (o.verteil ? '; Wärmeverteilung: ' + o.ueberL.map(function (y) { return nm(y, 1) + ' über Maximum'; }).join(', ') + (not ? ' (Komfort vor Energie: ' + c.verteilNotK + ' K unter Minimum)' : ' – Heizkurve hilft nicht, hydraulischen Abgleich/Thermostatventile prüfen') : '');
        } else if (o.alle && !o.lueftL.length && o.reserve >= c.reserveK - 1e-9 && o.reserveP >= c.reserveK - 0.2 - 1e-9 && (o.ueberL.length || o.hausWarm)) {
            o.dir = -1;
            o.code = 'Überschuss: ' + (o.ueberL.length ? o.ueberL.map(function (y) { return nm(y, 1) + ' über Maximum'; }).join(', ') : 'alle Räume über der Bandmitte (Ø ' + sg(o.mitte, 1) + ' K)') + '; knappster Raum ' + o.knapp.r.name + ' ' + de(o.reserve, 1) + ' K über Minimum';
        } else {
            var kr = x.filter(function (y) { return y.kaltRoh && !y.kalt; });
            o.code = kr.length ? kr[0].r.name + ' unter Minimum, aber ' + (kr[0].relaisAus ? 'Radiator-Relais aus (eigene Regelung)' : (kr[0].lueft ? 'gelüftet' : 'erholt sich (' + sg(kr[0].kh, 1) + ' K/h)'))
                   : (o.ueberL.length ? o.ueberL[0].r.name + ' über Maximum, aber ' + (!o.alle ? 'nicht alle Raumwerte gültig' : o.lueftL.length ? o.lueftL[0].r.name + ' wird gelüftet (' + sg(o.lueftL[0].kh, 1) + ' K/h)' : (o.reserve < c.reserveK - 1e-9 ? o.knapp.r.name + ' nur ' + de(o.reserve, 1) + ' K über Minimum (Reserve ' + de(c.reserveK, 1) + ' K)' : o.knappP.r.name + ' fällt (' + sg(o.knappP.kh, 1) + ' K/h): in ' + c.prognoseH + ' h nur ' + de(o.reserveP, 1) + ' K über Minimum'))
                   : 'alle Räume im Band (knappster ' + o.knapp.r.name + ' ' + de(o.reserve, 1) + ' K über Minimum, Ø ' + sg(o.mitte, 1) + ' K zur Bandmitte)');
        }
        return o;
    }
    function wirkzeit(d, dir, c) {                                                   // Wirkzeit Raum (E, lag): gemessen ab LAG.minEreignisse Ereignissen, sonst wirkStdMin (RE-10)
        var x = d.lag ? d.lag[dir > 0 ? 'auf' : 'ab'] : null;
        return (x && have(x.min) && x.n >= LAG.minEreignisse) ? {min: x.min, gemessen: true, n: x.n} : {min: c.wirkStdMin, gemessen: false, n: x ? x.n : 0};
    }
    // Rueckweg der Verschiebung des Raumeinflusses (gilt fuer jede stehende Verschiebung mit dem Vorzeichen der Anlage; die Uebernahme nutzt den Grund nur fuer ihre Regel).
    // +1 K: Bedarfsraeume rueckMin am Stueck >= Minimum + rueckPlusK, fruehestens nach der Wirkzeit; ein Bedarfsraum ueber Maximum + 0,5 K (zu warm). Andere Raeume ueber
    // Maximum zaehlen nicht (Regel-Review B2: das Wohnzimmer lag 29-74 % der Zeit darueber). -1 K: sofort bei Bedarf; Reserve verbraucht (knappster Raum 15 min < Minimum + rueckReserveK).
    function raumEnde(S, d, cfg) {
        var c = cfg.rules.raum_offset, R3 = S.raum3, L = d.raum, now = d.now, sh = have(d.shift) ? d.shift : 0, ap = S.arb.applied && S.arb.applied.rule === 'raum_offset' && S.arb.applied.w === sh ? S.arb.applied : null;
        if (!L || L.keine || sh === 0) { R3.deckSeit = 0; R3.resSeit = 0; return null; }
        if (sh > 0) {
            var ids = ap && Array.isArray(R3.bed) && R3.bed.length ? R3.bed : L.rooms.filter(function (y) { return y.ok; }).map(function (y) { return y.r.id; });
            var bedR = L.rooms.filter(function (y) { return y.ok && ids.indexOf(y.r.id) >= 0; });
            var heiss = bedR.filter(function (y) { return y.r.t > y.r.max + 0.5; })[0];
            if (heiss) { return heiss.r.name + ' (Bedarfsraum) ' + de(heiss.r.t - heiss.r.max, 1) + ' K über Maximum'; }
            var gedeckt = !L.kaltL.length && bedR.length > 0 && bedR.every(function (y) { return y.r.t >= y.r.min + c.rueckPlusK - 1e-9; });
            R3.deckSeit = gedeckt ? (R3.deckSeit || now) : 0;
            var wz = wirkzeit(d, 1, c), seit = ap ? now - ap.ts : Infinity;
            if (R3.deckSeit && now - R3.deckSeit >= c.rueckMin * MIN && seit >= wz.min * MIN) { return 'Bedarf gedeckt: ' + bedR.map(function (y) { return y.r.name; }).join(', ') + ' seit ' + c.rueckMin + ' min mindestens ' + de(c.rueckPlusK, 1) + ' K über Minimum'; }
            return null;
        }
        if (L.kaltL.length) { R3.resSeit = 0; return L.kaltL[0].r.name + ' unter Minimum (' + sg(L.kaltL[0].r.t - L.kaltL[0].r.min, 1) + ' K)'; }
        var knapp = L.reserve !== null && L.reserve < c.rueckReserveK - 1e-9;
        R3.resSeit = knapp ? (R3.resSeit || now) : 0;
        if (R3.resSeit && now - R3.resSeit >= KORR0_MIN * MIN) { return 'Reserve verbraucht: ' + L.knapp.r.name + ' nur ' + de(L.reserve, 1) + ' K über Minimum (seit ' + KORR0_MIN + ' min unter ' + de(c.rueckReserveK, 1) + ' K)'; }
        return null;
    }
    // Kennzahl "Kurvenform" (Regel-Review RE-7, 5.2): je Aussenband und Tag Minuten mit allen Raeumen, Summen von Reserve und Abstand zur Bandmitte, Minuten mit Ueberschuss
    // und mit Bedarf (Lage ohne Haltezeit). Dauerhafte Abweichung je Band = Hinweis auf eine Kurvenkorrektur (von Hand, SetCurves) statt taeglicher Verschiebung.
    // Getrennt je Heizkurve (Signatur aus Z1_Heat_Curve_*): nach einer Kurvenaenderung (Nutzer 13.10.: Kaltpunkt 38 -> 37 °C) beginnt die Kennzahl neu.
    var KF = {baender: [[-99, 4, '< 4'], [4, 8, '4…8'], [8, 11, '8…11'], [11, 99, '≥ 11']], tage: 7, kalt: ['< 4', '4…8']};
    function kfBand(at) { for (var i = 0; i < KF.baender.length; i++) { if (at < KF.baender[i][1]) { return KF.baender[i][2]; } } return KF.baender[KF.baender.length - 1][2]; }
    function kfStep(S, d, inp) {
        var sig = Array.isArray(inp.kurve) ? inp.kurve.join('/') : '', K = S.kf = (S.kf && typeof S.kf === 'object' && S.kf.tage) ? S.kf : {sig: sig, seit: d.now, tage: {}};
        if (sig && K.sig !== sig) { S.kf = K = {sig: sig, seit: d.now, tage: {}, vorher: K.sig || ''}; }
        var L = d.raum; if (!L || L.keine || !L.alle || !have(d.at)) { return; }
        var dk = ymd(d.now), T = K.tage[dk] = K.tage[dk] || {}, b = kfBand(d.at), a = T[b] = T[b] || [0, 0, 0, 0, 0, 0, 0];
        a[0]++; a[1] += L.reserve; a[2] += L.mitte; if (L.dir < 0) { a[3]++; } if (L.dir > 0) { a[4]++; } if (have(d.shift) && d.shift < 0) { a[5]++; }
        if (L.dir < 0 || (have(d.shift) && d.shift < 0)) { a[6] = (a[6] || 0) + 1; }                       // Ueberschuss ODER -1 K steht: dauerhafte Abweichung (RE-7)
        Object.keys(K.tage).sort().slice(0, -KF.tage).forEach(function (k) { delete K.tage[k]; });
    }
    function kurvenform(S, cfg) {
        var c = cfg.rules.raum_offset, K = S.kf || {tage: {}}, o = {baender: [], hinweis: null, sig: K.sig || '', seit: K.seit || 0};
        KF.baender.forEach(function (bd) {
            var s = [0, 0, 0, 0, 0, 0, 0], tg = 0; Object.keys(K.tage || {}).forEach(function (k) { var a = K.tage[k][bd[2]]; if (a) { tg++; for (var i = 0; i < 7; i++) { s[i] += a[i] || 0; } } });
            if (!s[0]) { return; }
            o.baender.push({band: bd[2], min: s[0], tage: tg, reserve: r2(s[1] / s[0]), mitte: r2(s[2] / s[0]), ueber: r2(s[3] / s[0]), bedarf: r2(s[4] / s[0]), minus: s[5], abw: r2(s[6] / s[0])});
        });
        var h = [];
        o.baender.forEach(function (x) {
            if (x.min < c.kfMinMin) { return; }
            if (x.abw >= c.kfAnteil && KF.kalt.indexOf(x.band) >= 0) { h.push('Heizkurve kaltseitig senken: bei ' + x.band + ' °C in ' + de(x.abw * 100, 0) + ' % der Zeit Überschuss oder −1 K (Überschuss ' + de(x.ueber * 100, 0) + ' %, Ø ' + sg(x.mitte, 1) + ' K zur Bandmitte, knappster Raum Ø ' + de(x.reserve, 1) + ' K über Minimum) – Kaltpunkt um 1 K senken (von Hand), statt täglich −1 K zu verschieben'); }
            else if (x.abw >= c.kfAnteil) { o.info = (o.info ? o.info + ' · ' : '') + 'bei ' + x.band + ' °C in ' + de(x.ueber * 100, 0) + ' % der Zeit Überschuss; die Kurve liegt dort an der Untergrenze ' + c.minVlC + ' °C (nicht über die Kurve senkbar, RE-4)'; }
            if (x.bedarf >= 0.3) { h.push('bei ' + x.band + ' °C in ' + de(x.bedarf * 100, 0) + ' % der Zeit ein Raum unter Minimum: Kurve dort zu niedrig oder Verteilung prüfen'); }
        });
        o.hinweis = h.length ? h.join(' · ') : null;
        return o;
    }
    // Phase 2 nur noch als Vergleichskennzahl: je Tag Minuten, in denen die Richtung des Raumeinflusses v3 (Lage ohne Haltezeit) mit dem Raumvorschlag der Phase 2 uebereinstimmt
    function p2Step(S, d) {
        var P = S.p2 = (S.p2 && typeof S.p2 === 'object') ? S.p2 : {}, k = d.korr && have(num(d.korr.v)) ? num(d.korr.v) : null;
        if (k === null || !d.raum || d.raum.keine || !have(d.shift)) { return; }
        var dk = ymd(d.now), x = P[dk] = P[dk] || [0, 0, 0, 0], p2dir = sgnOf(k - d.shift), v3 = d.raum.dir;
        if (v3 !== 0 && Math.max(-1, Math.min(1, d.shift + v3)) === d.shift) { v3 = 0; }                  // steht schon
        x[0]++; if (p2dir === v3) { x[1]++; } else if (p2dir === 0) { x[2]++; } else { x[3]++; }          // [Minuten, gleich, nur v3, verschieden/nur Phase 2]
        Object.keys(P).sort().slice(0, -7).forEach(function (kk) { delete P[kk]; });
    }
    function p2Summe(S) { var o = [0, 0, 0, 0]; Object.keys(S.p2 || {}).forEach(function (k) { for (var i = 0; i < 4; i++) { o[i] += S.p2[k][i]; } }); return {min: o[0], gleich: o[1], nurV3: o[2], anders: o[3], anteil: o[0] ? r2(o[1] / o[0]) : null}; }
    // ------------------------------------------------------------------ Waechter (nur Hinweise, keine Befehle, keine Punkte): Waermeverteilung, "Dornroeschenschlaf", Stoerung (H23), Kurvenform
    // Je Waechter: an nach anMin am Stueck, aus nach ausMin ohne Bedingung; Ereignis beim An- und Ausgehen (quiet-events). Herkunft in HW.
    var HW = {dornPauseMin: 120, dornUeberMin: 45, rohrWarnC: -30, verteilAusMin: 30};
    function errCode(v) { var s = (v === null || v === undefined) ? '' : String(v).trim(); return (!s || /^no ?error$/i.test(s) || s === '0' || /^none$/i.test(s) || /^keine?/i.test(s)) ? null : s; }
    function hwStep(S, id, bed, txt, anMin, ausMin, now, ev, art) {
        var H = S.hw = (S.hw && typeof S.hw === 'object') ? S.hw : {}, x = H[id] = H[id] || {an: false, kand: 0, weg: 0, seit: 0, txt: '', n: 0};
        if (bed) { x.kand = x.kand || now; x.weg = 0; if (!x.an && now - x.kand >= anMin * MIN) { x.an = true; x.seit = now; x.n++; x.txt = txt; ev.push([art || 'optimierer_hinweis', id + ': ' + txt]); } else if (x.an) { x.txt = txt; } }
        else { x.kand = 0; if (x.an) { x.weg = x.weg || now; if (now - x.weg >= ausMin * MIN) { x.an = false; x.weg = 0; ev.push(['optimierer_hinweis_ende', id + ': erledigt (' + hhmm(x.seit) + '–' + hhmm(now) + ')']); } } }
        return x;
    }
    function hinweisListe(S) { var H = S.hw || {}; return Object.keys(H).filter(function (k) { return H[k].an; }).map(function (k) { return {id: k, seit: H[k].seit, text: H[k].txt}; }); }
    function defaults() {
        var c = {locks: JSON.parse(JSON.stringify(LOCK_CFG)), rules: {}, takt: taktCfg(null), cop: {pelKorrW: COP_KORR.pelKorrW}};
        RULES.forEach(function (r) { var o = {}; r.schwellen.forEach(function (s) { o[s.key] = s.std; }); c.rules[r.id] = o; });
        return c;
    }
    function mergeCfg(over) {
        var c = defaults();
        if (over && typeof over === 'object') {
            if (over.locks) { Object.keys(c.locks).forEach(function (k) { if (have(num(over.locks[k]))) { c.locks[k] = num(over.locks[k]); } }); }
            if (over.rules) { Object.keys(c.rules).forEach(function (id) { var o = over.rules[id]; if (o) { Object.keys(c.rules[id]).forEach(function (k) { if (have(num(o[k]))) { c.rules[id][k] = num(o[k]); } }); } }); }
            if (over.takt) { c.takt = taktCfg(over.takt); }
            if (over.cop) { c.cop.pelKorrW = copKw(over); }                                                 // COP-Korrektur (ausserhalb 0..200 W: Standard)
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
                 rtr: {}, bedT: 0, qfDeckSince: 0, lastPause: null, lz: null,                                 // Raumverlauf, letzter Quiet-Bedarf, Rueckweg der Freigabe, letzte Pause, Messaufgabe +1 K
                 arbH: {owner: null, soll: null, von: null, start: 0, applied: null, last: null},          // Heizregelung (Comfort/Efficiency, 14.10.2026)
                 hc: null, hcChg: 0, hcHandT: 0, hcHandW: null, hcDeckSince: 0, hcAtNah: null};             // letzter Wechsel, Wechsel von Hand, Bedarf gedeckt seit, Heizstab-Naehe (Hysterese)
        RULES.forEach(function (r) { S.rules[r.id] = {since: 0, failSince: 0, prop: null, cool: 0, n: 0, day: '', korrV: null, korrSince: 0, last: null, hebel: null, rv: r.ver}; });
        return S;
    }
    function newScore() { return {cases: [], cands: [], eff: [], gt: {}, base: {}, tot: {}, hist: [], week: {}, lastSlot: {}}; }
    function fixState(S, now) {                                                   // fehlende Felder (aeltere Datei) ergaenzen; fremdes Format -> neu
        var F = newState(now);
        if (!S || typeof S !== 'object' || S.mv !== VER || !S.rules || !S.sc) { return F; }
        Object.keys(F).forEach(function (k) { if (S[k] === undefined) { S[k] = F[k]; } });
        RULES.forEach(function (r) { if (!S.rules[r.id]) { S.rules[r.id] = F.rules[r.id]; } Object.keys(F.rules[r.id]).forEach(function (k) { if (S.rules[r.id][k] === undefined) { S.rules[r.id][k] = k === 'rv' ? 0 : F.rules[r.id][k]; } }); });   // rv fehlt (Zustand vor 14.10.): Version unbekannt
        Object.keys(F.sc).forEach(function (k) { if (S.sc[k] === undefined) { S.sc[k] = F.sc[k]; } });
        // Review-Paket 13.10.2026: stillgelegte Regeln aus dem laufenden Zustand nehmen (Summen bleiben), Messaufgabe Comfort/Efficiency gestrichen
        STILLGELEGT.forEach(function (x) { delete S.rules[x.id]; if (S.sc.gt) { delete S.sc.gt[x.id]; } });
        ['cases', 'cands', 'eff'].forEach(function (k) { if (Array.isArray(S.sc[k])) { S.sc[k] = S.sc[k].filter(function (C) { return !!RULE[C.rule]; }); } });
        if (S.sc.mess) { delete S.sc.mess; }
        // Versionswechsel einer Regel (14.10.2026: Quiet-Freigabe v3, Deckel/Laufzeit v5, Raumeinfluss v3): ein laufender, noch nicht uebernommener Vorschlag der alten Version
        // endet (er kann nicht mehr geklickt werden, die Arbitrierung gibt die Groesse frei); uebernommene Werte (S.arb/arbQ.applied, OPT_apply) bleiben und laufen ueber den
        // Rueckweg der neuen Version zurueck; offene Faelle und Summen der alten Version bleiben unter ihrem Schluessel (regel|vN|s5).
        RULES.forEach(function (R) {
            var rs0 = S.rules[R.id]; if (rs0 && rs0.rv !== R.ver) { rs0.korrV = null; rs0.korrSince = 0; rs0.since = 0; rs0.failSince = 0; rs0.rv = R.ver; }   // Haltezeiten der alten Version gelten nicht (v2: Raumvorschlag, v3: Raumlage)
            var rs = S.rules[R.id], p = rs && rs.prop; if (!p || !have(p.ver) || p.ver === R.ver) { return; }
            [S.arb, S.arbQ, S.arbH].forEach(function (A) { if (A && A.owner === R.id) { A.owner = null; A.soll = null; A.von = null; A.start = 0; } });
            S.verWechsel = (Array.isArray(S.verWechsel) ? S.verWechsel : []).concat([{t: now, rule: R.id, von: p.ver, zu: R.ver, prop: p.id}]).slice(-20);
            rs.prop = null; rs.since = 0; rs.failSince = 0; rs.cool = 0; rs.hebel = null;
        });
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
                 pump: num(inp.pump), pel: plausV('pel', inp.pel), heatOffAT: num(inp.heatOffAT), korr: inp.korr || null, notK: L.notK, arb: S.arb, arbQ: S.arbQ, arbH: S.arbH,
                 vs: (inp.vs && typeof inp.vs === 'object' && Array.isArray(inp.vs.at)) ? inp.vs : null};
        d.fresh = have(num(inp.hpAge)) && num(inp.hpAge) <= L.hpMaxAgeMin && have(d.hz) && have(d.vl) && have(d.soll);
        d.running = have(d.hz) && d.hz > 0;
        d.zustand = d.running ? 'lauf' : (!have(d.pump) ? '?' : (d.pump >= L.pumpOnRpm ? 'pause' : 'heizgrenze'));
        d.hc = num(inp.hc); d.pth = plausV('pth', inp.pth);
        d.err = errCode(inp.err); d.kzRad = num(inp.kzRad); d.pipeIn = num(inp.pipeIn);                    // HeishaMon Error (TOP44), Radiator-Relais Kinderzimmer oben, Inside_Pipe_Temp (H23-Vorstufe)
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
                if (S.sp && S.sp.stop) {                                                          // Startschwelle: [Start, Pause min, Verzug nach Soll-Modell, Verzug nach RL-Modell, VL-Soll zuletzt, Sollsprung, Heizgrenze-Aus]
                    S.sl = (Array.isArray(S.sl) ? S.sl : []).concat([[R.start, mins(R.start - S.sp.stop), S.sp.fSoll ? mins(R.start - S.sp.fSoll) : null, S.sp.fRl ? mins(R.start - S.sp.fRl) : null, r2(S.sp.vlS), S.sp.sj ? 1 : 0, S.sp.hg ? 1 : 0]]).slice(-START.logN);
                }
                S.sp = null;
                S.lastStart = R.start;
            } else if (!d.running && R.on === true) {
                R.on = false; S.lastStop = now; S.runs.push([R.start, mins(now - R.start), have(R.over) && R.over >= thermoK(cfg) ? 1 : 0]);   // [Beginn, Dauer, Abschaltung ueber den Vorlauf]
                S.sp = {stop: now, rl: have(R.rlLast) ? R.rlLast : null, fSoll: 0, fRl: 0, sj: false, hg: false, sollP: null, vlS: null};
            } else if (R.on === null) { R.on = false; }
            if (d.running && have(d.vl) && have(d.soll)) { R.over = d.vl - d.soll; }          // Vorlauf zum Soll in der letzten Laufminute (Stopp-Art)
            if (d.running && have(d.rl)) { R.rlLast = d.rl; }                                  // Ruecklauf in der letzten Laufminute (Startschwelle nach Forum: RL beim Abschalten - 3 K)
            // Laufzeit der Anlage hat Vorrang, wenn sie kleiner ist (Stopp und Neustart zwischen zwei Aufrufen; nach einem Node-RED-Neustart beginnt sie bei 0 = vorsichtig).
            // Aber nur nach einer Luecke von mehr als 4 min: der Verdichter hat eine Neustartsperre von 3 min (Servicehandbuch), zwischen zwei Minuten-Aufrufen im Lauf gibt es
            // keinen Stopp mit Neustart. Faellt die Laufzeit mitten im beobachteten Lauf, hat HeishaMoNR sie zurueckgesetzt (09.10. 03:01: 583 -> 0 min; ein 600-min-Lauf
            // erschien sonst als 17-min-Lauf mit Abschaltung ueber den Vorlauf = falscher Takt-Beleg fuer "Deckel/Laufzeit").
            if (d.running && have(rt) && rt >= 0 && R.start && now - R.start > (rt + 2) * MIN && (!S.runSeen || now - S.runSeen > 4 * MIN)) { R.start = now - rt * MIN; }
            if (d.running) { S.runSeen = now; }
        }
        // Pause: wann erreichte der Vorlauf die Startschwelle (Soll-Modell: <= Soll - 3,25 K; RL-Modell nach Forum: < RL beim Abschalten - 3 K)?
        if (S.sp && d.fresh && !d.running && have(d.vl) && have(d.soll)) {
            if (S.sp.sollP !== null && d.soll !== S.sp.sollP) { S.sp.sj = true; } S.sp.sollP = d.soll;
            if (d.zustand === 'heizgrenze') { S.sp.hg = true; }
            if (!S.sp.fSoll && d.vl <= d.soll - START.sollK + 1e-9) { S.sp.fSoll = now; }
            if (!S.sp.fRl && have(S.sp.rl) && d.vl < S.sp.rl - START.rlK - 1e-9) { S.sp.fRl = now; }
            S.sp.vlS = d.vl - d.soll;
        }
        // Niedriglauf fuer die Sperre "Frequenzsprung bei Abtauwetter": seit wann laeuft der Verdichter (ab Laufminute 2, ohne Start-Blip) hoechstens abtauNiedrigHz?
        var rm0 = (d.running && R.on && R.start) ? (now - R.start) / MIN : 0;
        if (d.fresh) { S.niedrigSeit = (d.running && have(d.hz) && d.hz <= cfg.locks.abtauNiedrigHz && !num(inp.defrost)) ? (S.niedrigSeit || (rm0 >= 2 ? now : 0)) : 0; }
        d.niedrigSeit = S.niedrigSeit || 0;
        d.abtauLage = !!(d.niedrigSeit && now - d.niedrigSeit >= cfg.locks.abtauNiedrigMin * MIN && have(d.at) && d.at >= cfg.locks.abtauAtMin && d.at <= cfg.locks.abtauAtMax);   // Abtauwetter nach langem Niedriglauf
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
        // Heizregelung (14.10.2026): Wechsel erkennen; uebernimmt die Anlage den laufenden Vorschlag der Regel "Heizregelung", gehoert der Modus ihr (applied).
        // Jeder andere Wechsel ist "von Hand" (Schalter im Dashboard, Bediengeraet), ausser dem Rueckweg einer Uebernahme der Regel (zurueck auf ihren Ausgangswert).
        d.hcChanged = false;
        if (have(d.hc)) { if (have(S.hc) && S.hc !== d.hc) { S.hcChg = now; d.hcChanged = true; d.hcFrom = S.hc; } S.hc = d.hc; }
        if (d.hcChanged) {
            var AH = S.arbH, apH = AH.applied, lsH = AH.last;
            var rueckH = !!((apH && apH.w === d.hcFrom && apH.von === d.hc) || (lsH && lsH.lapse && lsH.w === d.hcFrom && lsH.von === d.hc && now - lsH.end <= 60 * MIN));
            if (AH.applied && AH.applied.w !== d.hc) { AH.last = {rule: AH.applied.rule, dir: sgnOf(AH.applied.w - AH.applied.von), w: AH.applied.w, von: AH.applied.von, start: AH.applied.ts, end: now}; AH.applied = null; }
            if (AH.owner && d.hc === AH.soll) { AH.applied = {rule: AH.owner, w: d.hc, von: d.hcFrom, ts: now}; d.hcBy = AH.owner; }
            else if (!rueckH) { S.hcHandT = now; S.hcHandW = d.hc; }
        }
        if (have(d.soll)) { if (have(S.soll) && S.soll !== d.soll) { d.sollJump = d.soll - S.soll; if (!d.shiftChanged) { S.kurveChg = now; } } S.soll = d.soll; }   // natuerlicher Sollsprung (Kurve, AT ganzzahlig; RE-2)
        d.kurveChg = S.kurveChg || 0;
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
        d.htrOn = have(htrOn) ? htrOn : null;                                           // Heater_On_Outdoor_Temp (Heizregelung-Hinweis mit Hysterese)
        d.htrSd = have(htrSd) ? Math.abs(htrSd) : 3;
        var hdl = num(inp.htrDelay); d.htrDelay = have(hdl) && hdl > 0 && hdl <= 120 ? hdl : 15;   // Heater_Delay_Time (J: 15 min); ohne Meldung 15 min
    }

    // Leistungs-Arbitrierung (14.10.2026, Regel "Heizregelung"): Quiet-Stufe und Heizregelung wirken beide auf die Leistung, aber verschieden: Quiet ist ein harter
    // Deckel (auch fuer Comfort: 13.10. 21:00 Comfort/Quiet 3 hielt 17 Hz, 16:29 Comfort/Quiet 2 21 Hz), Efficiency nur eine traege Phase (Start bis Laufminute
    // 39-46, ~20 min nach dem Abtauen). Darum: eine Leistungsaenderung zur Zeit, zuerst die Quiet-Stufe. Laeuft ein Quiet-Vorschlag, wartet Comfort; laeuft ein
    // Heizregelungs-Vorschlag oder steht Comfort der Regel (Bedarf), schlaegt der Effizienz-Deckel (Quiet hoeher) nicht vor.
    function leistLocks(R, e, d, S, add) {
        var g = (e && e.groesse) || R.groesse;
        if (R.id === 'heizregelung' && e && e.dir === 'mehr_leistung' && S.arbQ && S.arbQ.owner) { add('vorrang', 'Quiet-Vorschlag „' + RULE[S.arbQ.owner].kurz + '“ läuft: zuerst die Quiet-Stufe'); }
        if (R.id === 'quiet_strecken' && g === 'quiet' && S.arbH) {
            var H = S.arbH;
            if (H.owner === 'heizregelung') { add('vorrang', '„Heizregelung“ schlägt ' + hcTxt(H.soll) + ' vor'); }
            else if (H.applied && H.applied.rule === 'heizregelung' && H.applied.w === 0 && d.hc === 0) { add('vorrang', 'Comfort gehört „Heizregelung“ (Bedarf)'); }
        }
    }
    // ------------------------------------------------------------------ Sperren je Regel (Reihenfolge = Prioritaet des angezeigten Grundes)
    function locksFor(R, d, S, cfg, inp, dirNow, e) {
        var L = cfg.locks, c = cfg.rules[R.id], rs = S.rules[R.id], now = d.now, out = [], g = (e && e.groesse) || R.groesse, sl = (e && have(e.startMin)) ? e.startMin : L.startLockMin;
        var nf = !!(e && e.hart) && (g === 'quiet' || g === 'hc');                     // Notfall der Quiet-Stufe/Heizregelung (Heizstab-Naehe, Raum >= notK unter Minimum): Abstand/Tageslimit/Wartezeit nach notfallMin
        function add(id, extra, until) { out.push({id: id, text: LOCK_TEXT[id] + (extra ? ' (' + extra + ')' : ''), bis: until || null}); }
        R.sperren.forEach(function (id) {
            if (id === 'anlauf' && now - S.born < L.warmupMin * MIN) { add(id, 'noch ' + Math.ceil((S.born + L.warmupMin * MIN - now) / MIN) + ' min', S.born + L.warmupMin * MIN); }
            if (id === 'daten' && !d.fresh) { add(id, have(num(inp.hpAge)) ? 'letzte Meldung vor ' + de(num(inp.hpAge), 0) + ' min' : 'keine Meldung'); }
            if (id === 'mqtt_sperre' && num(inp.block) === 1) { add(id); }
            if (id === 'stoerung' && d.err) { add(id, d.err + (/H23/i.test(d.err) ? ': Kältemittelfühler Innengerät, L-spezifisch' : '')); }
            if (id === 'abtausprung' && e && have(e.sprungHz) && e.sprungHz >= L.sprungHz && !e.heizstab && have(d.at) && d.at >= L.abtauAtMin && d.at <= L.abtauAtMax && d.niedrigSeit && now - d.niedrigSeit >= L.abtauNiedrigMin * MIN) {
                add(id, 'Außen ' + de(d.at, 0) + ' °C, seit ' + mins(now - d.niedrigSeit) + ' min höchstens ' + L.abtauNiedrigHz + ' Hz, Sprung ~' + de(e.sprungHz, 0) + ' Hz: Pseudo-Abtauung möglich');
            }
            if (id === 'abtauen' && (d.defrost || (S.defrostEnd && now - S.defrostEnd < L.afterDefrostMin * MIN))) { add(id, d.defrost ? 'läuft' : 'noch ' + Math.ceil((S.defrostEnd + L.afterDefrostMin * MIN - now) / MIN) + ' min', d.defrost ? null : S.defrostEnd + L.afterDefrostMin * MIN); }
            if (id === 'warmwasser' && (d.dhw || (S.dhwEnd && now - S.dhwEnd < L.afterDhwMin * MIN))) { add(id, d.dhw ? 'läuft' : 'noch ' + Math.ceil((S.dhwEnd + L.afterDhwMin * MIN - now) / MIN) + ' min', d.dhw ? null : S.dhwEnd + L.afterDhwMin * MIN); }
            if (id === 'sanftanlauf' && num(inp.ss) === 1) { add(id); }
            if (id === 'laufbeginn' && d.running && d.runMin < sl) { add(id, de(d.runMin, 0) + ' von ' + sl + ' min', S.run.start + sl * MIN); }      // Heizstab-Naehe (Quiet-Freigabe v2): kuerzere Startphase
            if (id === 'heizgrenze_aus' && !d.running && d.zustand === 'heizgrenze') { add(id); }
            if (id === 'modell' && !(d.vs && d.vs.gate)) { add(id, d.vs ? (d.vs.n || 0) + ' von ' + (d.vs.minDays || 10) + ' Tagen' : 'keine Vorhersage'); }
            if (id === 'vorrang' || id === 'gegenrichtung') { if (id === 'vorrang' || R.sperren.indexOf('vorrang') < 0) { arbLocks(R, e, d, S, cfg, add); } }
            if (id === 'vorrang') { leistLocks(R, e, d, S, add); }
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
            if (id === 'abstand') {                                                        // seit 13.10. ueber beide Groessen (Regel-Review 3.4: Wirkung sonst nicht zuzuordnen, Effekte addieren sich), seit 14.10. auch Heizregelung
                var chg = (g === 'quiet' || g === 'shift' || g === 'hc') ? Math.max(S.qChg || 0, S.shiftChg || 0, S.hcChg || 0) : 0;
                var gap = nf ? L.notfallMin : L.gapMin;
                if (chg && now - chg < gap * MIN) { add(id, 'letzte Änderung ' + hhmm(chg) + ', noch ' + Math.ceil((chg + gap * MIN - now) / MIN) + ' min' + (nf ? ' (Notfall)' : ''), chg + gap * MIN); }
            }
            // Tageslimit: ein Notfall ist ausgenommen; bei der Heizregelung nur die Heizstab-Naehe (ein Raum-Notfall nicht: sonst Comfort bei jedem Start, Pendeln)
            if (id === 'tageslimit' && rs.n >= c.proTag && !rs.prop && (!nf || (g === 'hc' && !(e && e.heizstab)))) { add(id, rs.n + ' von ' + c.proTag + (R.art === 'befehl' ? ' übernommen' : '')); }
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
        if (R.id === 'raum_offset') { var kv = d.raum && !d.raum.keine ? d.raum.dir : null; if (kv !== rs.korrV) { rs.korrV = kv; rs.korrSince = kv === null ? 0 : now; } }   // v3: Haltezeit der Raumlage (Bedarf/Ueberschuss), nicht mehr des Phase-2-Vorschlags
        var res = {id: R.id, v: R.ver, st: '', grund: '', naechste: null, p: null, locks: [], groesse: R.groesse};
        function endProp(why) {
            if (!rs.prop) { return; }
            [['shift', S.arb], ['quiet', S.arbQ], ['hc', S.arbH]].forEach(function (x) {  // Arbitrierung: Groesse freigeben, Richtung und Ende merken (Gegenrichtung)
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
            if (Array.isArray(e.bed)) { p.bed = e.bed; }                                                              // Raumeinfluss v3: Bedarfsraeume (Rueckweg nur ueber diese, Regel-Review B2)
            if (have(e.hzS)) { p.hzS = e.hzS; }                                                                      // Deckel/Laufzeit v5: Frequenzschwelle der Ausloesung (Bewertung)
            if (e.hart) { p.hart = true; }                                                                           // Notfall (Wartezeit danach nur fuer einen neuen Notfall verkuerzt)
            if (e.einmal) { p.einmal = true; }                                                                       // Heizregelung -> Efficiency: Normalzustand, die Uebernahme endet mit der Bestaetigung (kein Rueckweg)
            p.sum = checksum(p);
            rs.prop = p; res.neu = true;
            var A0 = arbOf(S, g); if (A0 && (g === 'shift' || g === 'quiet' || g === 'hc')) { A0.owner = R.id; A0.soll = e.wert; A0.von = e.von; A0.start = now; }      // Arbitrierung: diese Regel hat jetzt die Groesse
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
    // COP-Korrektur (14.10.2026, Forum 189605 Frage 10 / TODO F10-a): der interne Stromwert der Leisha (TOP16 Heat_Energy_Consumption) untertreibt im Lauf.
    // Belege (im Original geprueft): L5 70-90 W unter Shelly je nach Last (Beitrag 4545989); L5 bei 16/17 Hz 2 kW Waerme / 390 W Shelly (4597230), unsere Anlage
    // zeigt dort 341-363 W; L7 Jahresstrom -14,6 % gegen Shelly bei nur -2,7 % Abweichung der Waerme (4145844) -> der Fehler liegt auf der Stromseite
    // (Pumpe, Luefter, Elektronik fehlen). pelKorrW = 80 W ist eine ANNAHME im Bereich 40-90 W, addiert NUR bei laufendem Verdichter (im Stillstand meldet
    // TOP16 15-34 W, der Wert bleibt roh). Gespeichert wird immer der Rohwert (S.takt.copT, S.ueb); die Korrektur kommt erst beim Lesen dazu (je gezaehlte
    // Laufminute pelKorrW/60 Wh). So ist jede Summe mit jeder Konstante neu rechenbar und nichts wird doppelt korrigiert. cfg.cop.pelKorrW (0..200 W).
    var COP_KORR = {pelKorrW: 80, minW: 0, maxW: 200, ver: 1};
    function copKw(cfg) { var v = (cfg && cfg.cop) ? num(cfg.cop.pelKorrW) : null; return (have(v) && v >= COP_KORR.minW && v <= COP_KORR.maxW) ? v : COP_KORR.pelKorrW; }
    function kwOf(kw) { return (have(kw) && kw >= COP_KORR.minW && kw <= COP_KORR.maxW) ? kw : COP_KORR.pelKorrW; }        // fehlt kw: Standard (korrigiert); 0 = roh
    function pelKorr(pel, laeuft, kw) { return (have(pel) && laeuft) ? pel + kwOf(kw) : pel; }                              // eine Minute: Rohwert + Korrektur nur im Lauf
    function korrTxt(kw) { return 'intern +' + de(kwOf(kw), 0) + ' W korrigiert'; }
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
            var k = binKeyOf(at), B = T.bins[k] = T.bins[k] || [];                   // 2-K-Band, ab -4 °C getrennt an den Sprungstellen der Mindestfrequenz (Forum F1-a)
            B.push(Math.round(pth)); if (B.length > TAKT.binMax) { B.splice(0, B.length - TAKT.binMax); }
            // Mindestfrequenz je Band (gelernt, Vorrang vor der Tabelle MINHZ): nur Minuten mit Quiet 0 ohne Ruecklauf-Rueckstand (<= 0,5 K), also wenn der Verdichter von sich aus
            // herunterregelt; unter Quiet 1-3 haelt der Deckel die Frequenz fest (sonst laege das "Minimum" bei Quiet 2 und 1 °C auf 21 Hz)
            var rlx = plausV('rl', x.rl), sox = plausV('soll', x.soll), dTx = num(x.dT);
            if (q === 0 && have(rlx) && have(sox) && have(dTx) && (sox - dTx) - rlx <= 0.5) { T.hzB = T.hzB || {}; var HB = T.hzB[k] = T.hzB[k] || []; HB.push(Math.round(hz)); if (HB.length > TAKT.binMax) { HB.splice(0, HB.length - TAKT.binMax); } }
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
    // [[Band-Untergrenze, 10-%-Quantil W th, n, monoton W th, Segment, Mindestfrequenz Hz]]; monoton = laufendes Minimum von warm nach kalt (stooklijn), seit 14.10.2026 getrennt je
    // Segment der Mindestfrequenz (Forum F1-a: ab -4 °C 25 Hz, ab -10 °C 35 Hz; dort steigt die Mindestleistung sprunghaft, ein durchgehendes Minimum wuerde das verdecken)
    function mindestLeistung(T, c) {
        c = taktCfg(c);
        var ks = Object.keys((T && T.bins) || {}).map(function (key) { var p = key.split('|'); return {key: key, k: Number(p[0]), s: p.length > 1 ? Number(p[1]) : 0}; })
            .filter(function (x) { return isFinite(x.k); }).sort(function (a, b) { return a.s - b.s || b.k - a.k; }), out = [], run = null, seg = null;
        ks.forEach(function (x) {
            var B = T.bins[x.key]; if (B.length < c.binMinN) { return; }
            if (seg !== x.s) { seg = x.s; run = null; }
            var qv = Math.round(quantil(B, TAKT.quantil)); run = run === null ? qv : Math.min(run, qv);
            out.push([x.k, qv, B.length, run, x.s, minHzOf(T, x.k + (x.s ? 0 : 1), c).hz]);
        });
        return out.sort(function (a, b) { return a[0] - b[0] || b[4] - a[4]; });
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
    // {Schluessel "Modus|Quiet|Band": [Wh el korrigiert, Wh th, Minuten, Summe Hz, hoechste Hz, gehaltene Hz (Deckel), Wh el roh]} ueber die letzten copTage Tage.
    // copT speichert den Rohwert (TOP16); jede Minute dort ist eine stabile Laufminute (Verdichter laeuft), deshalb kommt je Minute kw/60 Wh dazu (COP_KORR).
    // kw fehlt: cfg-Standard (80 W); kw = 0: Rohwerte (Vergleich, Tests).
    function copSumme(T, c, now, kw) {
        c = taktCfg(c); kw = kwOf(kw);
        var out = {}, D = (T && T.copT) || {}, ks = Object.keys(D).sort(), von = have(now) ? ymd(now - (c.copTage - 1) * 24 * 60 * MIN) : '';
        ks.forEach(function (dk) { if (dk < von) { return; } Object.keys(D[dk]).forEach(function (k) { var a = D[dk][k], o = out[k] = out[k] || [0, 0, 0, 0, null, null, 0]; o[0] += a[0] + a[2] * kw / 60; o[6] += a[0]; o[1] += a[1]; o[2] += a[2]; o[3] += a[3] || 0; if (have(a[4])) { o[4] = o[4] === null ? a[4] : Math.max(o[4], a[4]); } if (have(a[5])) { o[5] = o[5] === null ? a[5] : Math.max(o[5], a[5]); } }); });
        return out;
    }
    function copTabelle(T, c, now, kw) {                                           // [[Modus, Quiet, Band, COP, Minuten]] ab copMinMin Minuten je Kombination (Nutzerentscheidung 13.10.2026); COP korrigiert (kw wie copSumme)
        c = taktCfg(c);
        var S = copSumme(T, c, now, kw);
        return Object.keys(S).map(function (k) { var a = S[k], p = k.split('|'); return [p[0], p[1], p[2], a[0] > 0 ? r2(a[1] / a[0]) : null, a[2]]; })
            .filter(function (r) { return r[4] >= c.copMinMin && r[3] !== null; })
            .sort(function (a, b) { var ia = BAENDER.map(function (x) { return x[2]; }).indexOf(a[2]), ib = BAENDER.map(function (x) { return x[2]; }).indexOf(b[2]); return ia - ib || (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0)))); });
    }
    // Nachladen (13.10.): S.takt einmalig aus quiet-YYYY-MM.csv (Vormonat, laufender Monat) fuellen, damit Starts, Mindestleistung und COP sofort die vorhandenen
    // Tage zeigen. Rein: die Huelle liest die Dateien stueckweise (nur ganze Zeilen) und uebergibt den Text. Spalten und Minutenraster wie tools/engine_replay.buildInputs
    // (je Minute die letzte Zeile, Alter = Abstand zu ihr); mehrere Kopfzeilen-Versionen; Zeilen mit falscher Spaltenzahl oder rueckwaerts laufender Zeit entfallen.
    var NL_SPALTEN = {hz: 'verdichter_hz', at: 'aussen', pel: 'leistung_el_w', pth: 'leistung_th_heisha_w', q: 'quiet_aktuell', hc: 'heizregelung', defrost: 'defrost', dhw: 'warmwasser', rl: 'ist_rl', soll: 'soll_vl', dT: 'spreizung_ziel'};
    function nlNeu(dateien, now) { return {laeuft: true, dateien: dateien, i: 0, pos: 0, kopf: null, prev: null, gridT: 0, zeilen: 0, minuten: 0, von: null, start: now}; }
    function nlZeit(s) { var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; }
    function nlEmit(T, nl, t, c) { var p = nl.prev; nl.minuten++; return taktStep(T, {t: t, hpAge: (t - p.t) / MIN, hz: p.hz, at: p.at, pel: p.pel, pth: p.pth, q: p.q, hc: p.hc, defrost: p.defrost, dhw: p.dhw, rl: p.rl, soll: p.soll, dT: p.dT}, c); }
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
        if (d.hz >= cfg.rules.quiet_strecken.hzTakt) { x[0]++; }                          // Kennzahl unveraendert ab 22 Hz (v5: hzTakt)
        Object.keys(H).sort().slice(0, -HL.tage).forEach(function (k) { delete H[k]; });
    }
    function hochlaufSumme(S) { var o = {Comfort: [0, 0], Efficiency: [0, 0]}; Object.keys(S.hl || {}).forEach(function (k) { ['Comfort', 'Efficiency'].forEach(function (m) { var x = S.hl[k][m]; if (x) { o[m][0] += x[0]; o[m][1] += x[1]; } }); }); return o; }

    // Kennzahl "Ueberheizt bei AT >= 11 °C" (Review-Paket 13.10.2026, ersetzt den stillgelegten Heizgrenze-Hinweis; Regel-Review 4.1): Laufenergie bei
    // Aussentemperatur >= UEB.atC, waehrend ALLE aktiven Raeume ueber ihrer Bandmitte liegen. Nur das waere Waerme, die das Haus bei milder Witterung nicht
    // braucht (echtes Ueberheizpotenzial einer niedrigeren Heizgrenze); daneben die gesamte Laufenergie bei >= UEB.atC. Raumwerte bis 6 h alt wie in der
    // Bewertung (die Shelly melden nur bei Aenderung); fehlt ein Raumwert, zaehlt die Minute als "ohne Raumdaten". Ohne Abtauen/Warmwasser. Je Kalendertag, 7 Tage.
    // Je Tag: [Wh el alle ueber Mitte, Wh th alle ueber Mitte, Minuten alle ueber Mitte, Wh el gesamt >= atC, Minuten gesamt >= atC, Minuten ohne Raumdaten]
    var UEB = {atC: 11, tage: 7};
    function uebStep(S, d) {
        var U = S.ueb = (S.ueb && typeof S.ueb === 'object') ? S.ueb : {};
        if (!d.fresh || !d.running || d.defrost || d.dhw || !have(d.at) || d.at < UEB.atC || !have(d.pel)) { return; }
        var dk = ymd(d.now), x = U[dk] = U[dk] || [0, 0, 0, 0, 0, 0];
        var act = d.rooms.filter(function (r) { return r.active && have(r.min) && have(r.max); });
        var ok = act.length > 0 && act.every(function (r) { return roomScore(r); });
        x[3] += d.pel / 60; x[4]++;
        if (!ok) { x[5]++; }
        else if (act.every(function (r) { return r.t > (r.min + r.max) / 2; })) { x[0] += d.pel / 60; x[1] += (have(d.pth) && d.pth > 0 ? d.pth : 0) / 60; x[2]++; }
        Object.keys(U).sort().slice(0, -UEB.tage).forEach(function (k) { delete U[k]; });
    }
    function uebSumme(S, now, kw) {                                                  // Summe der letzten UEB.tage Kalendertage (kWh, Minuten); Strom korrigiert (Laufminuten x kw, COP_KORR), el*Roh = TOP16
        kw = kwOf(kw);
        var o = {el: 0, th: 0, min: 0, elAlle: 0, minAlle: 0, minOhne: 0, tage: 0, elRoh: 0, elAlleRoh: 0, kw: kw}, U = (S && S.ueb) || {}, von = have(now) ? ymd(now - (UEB.tage - 1) * 24 * 60 * MIN) : '';
        Object.keys(U).forEach(function (k) { if (k < von) { return; } var x = U[k]; o.el += (x[0] + x[2] * kw / 60) / 1000; o.elRoh += x[0] / 1000; o.th += x[1] / 1000; o.min += x[2]; o.elAlle += (x[3] + x[4] * kw / 60) / 1000; o.elAlleRoh += x[3] / 1000; o.minAlle += x[4]; o.minOhne += x[5]; o.tage++; });
        ['el', 'th', 'elAlle', 'elRoh', 'elAlleRoh'].forEach(function (k) { o[k] = Math.round(o[k] * 1000) / 1000; });
        return o;
    }

    // Heizregelung-Hinweis (nur Anzeige, keine Regel und keine Punkte; Review-Paket 13.10.2026, ersetzt die Warnung "Comfort empfohlen" des Waechters, die
    // an der 5-°C-Grenze flackerte und bei normalen Kaltstarts anschlug, Regel-Review 4.4 d). Befund 07.-13.10.: Efficiency faehrt nach dem Start mit 16-17 Hz
    // und erst ab Laufminute 39-46 zeitweise auf 21-26 Hz, Comfort sofort auf 30-35 Hz. Bei Kaelte kann der traege Hochlauf den Heizstab freigeben
    // (Servicehandbuch J Z. 9316-9322: nach Heater_Delay_Time unter Soll + Heater_Start_Delta bei Aussentemperatur unter Heater_On_Outdoor_Temp; bei der Leisha
    // nicht beobachtet, keine Daten unter 1 °C). Einzige verbleibende Bedingung ist deshalb die Heizstab-Naehe, gerechnet wie in der Quiet-Freigabe (bedarfQ):
    // Efficiency, Verdichter laeuft ab Laufminute HCW.laufMin, Aussen unter Heater_On_Outdoor_Temp + heaterMarginK (Ende erst HCW.atHystK hoeher: kein Flackern),
    // Vorlauf mindestens |Start-Delta| - heizstabAbstandK unter Soll (im Dauerlauf - heizstabDauerK); an nach HCW.anMin am Stueck, aus erst HCW.ausMin nach dem Wegfall.
    var HCW = {laufMin: 10, anMin: 3, ausMin: 10, atHystK: 1};
    function hcHinweis(S, d, cfg) {
        var H = S.hcw = (S.hcw && typeof S.hcw === 'object') ? S.hcw : {an: false, seit: 0, kand: 0, weg: 0, atNah: false}, now = d.now;
        var c = cfg.rules.quiet_freigabe, grenze = have(d.htrOn) ? d.htrOn + cfg.locks.heaterMarginK : null;
        H.atNah = have(grenze) && have(d.at) && (H.atNah ? d.at < grenze + HCW.atHystK : d.at < grenze);
        var dauer = d.running && d.runMin >= d.htrDelay, abst = d.htrSd - (dauer ? c.heizstabDauerK : c.heizstabAbstandK);
        var bed = !!(d.fresh && d.hc === 1 && d.running && d.runMin >= HCW.laufMin && H.atNah && have(d.vlRueck) && d.vlRueck >= abst);
        if (bed) { H.kand = H.kand || now; H.weg = 0; if (!H.an && now - H.kand >= HCW.anMin * MIN) { H.an = true; H.seit = now; } }
        else { H.kand = 0; if (H.an) { H.weg = H.weg || now; if (d.hc === 0 || now - H.weg >= HCW.ausMin * MIN) { H.an = false; H.weg = 0; } } }
        if (H.an && bed) { H.txt = 'Heizstab-Nähe (Außen ' + de(d.at, 0) + ' °C, Vorlauf ' + de(d.vlRueck, 1) + ' K unter Soll, Lauf ' + de(d.runMin, 0) + ' min; Heizstab ab ' + de(d.htrSd, 0) + ' K unter Soll nach ' + de(d.htrDelay, 0) + ' min); Efficiency fährt nach dem Start langsam hoch, Comfort sofort'; }
        var mode = d.hc === 0 ? 'Comfort' : (d.hc === 1 ? 'Efficiency' : null);
        return {mode: have(d.hc) ? d.hc : null, warn: H.an, seit: H.an ? H.seit : 0,
                text: mode === null ? '–' : (mode === 'Comfort' ? 'Comfort' : (H.an ? 'Efficiency · Comfort empfohlen: ' + (H.txt || 'Heizstab-Nähe') : 'Efficiency · keine Warnung'))};
    }

    // ------------------------------------------------------------------ Schnappschuss fuer den Datensatz (gerundet; reicht zum Nachspielen)
    var SNAP_KEYS = ['hpAge', 'hz', 'vl', 'rl', 'soll', 'dT', 'pel', 'pth', 'flow', 'pump', 'q', 'qPrio', 'hc', 'at', 'defrost', 'dhw', 'ss', 'rt', 'shift', 'heatMode', 'z1Sensor',
                     'heaterI', 'heaterE', 'htrOnAT', 'htrStartDelta', 'htrDelay', 'heatOffAT', 'sollKurve', 'block', 'otherQ', 'otherShift', 'kzRad', 'err', 'pipeIn', 'kurve'];   // err/pipeIn/kurve seit 14.10.2026
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
        d.copKw = copKw(cfg); d.tc = cfg.takt; d.copSum = copSumme(S.takt, cfg.takt, now, d.copKw);   // Daten je Heizregelung x Quiet x Band (COP korrigiert): Zielstufen und Deckel der Quiet-Regeln
        lagStep(S, d, now); kbStep(S, d, now);                                          // Wirkzeit und Heizkurven-Bias (nur Auswertung)
        d.T = S.takt; d.lag = S.lag && S.lag.res ? S.lag.res : null; d.startM = startModell(S, now);   // Mindestfrequenz (gelernt), Wirkzeit, Startschwelle
        S.raum3 = (S.raum3 && typeof S.raum3 === 'object') ? S.raum3 : {bed: [], deckSeit: 0, resSeit: 0};
        d.raum = raumLage(S, d, cfg); kfStep(S, d, inp); p2Step(S, d);                  // Raumeinfluss v3: Lage der Raeume; Kennzahlen Kurvenform und Vergleich Phase 2
        S.raum3.lage = d.raum.keine ? {dir: null, code: d.raum.code, t: now} : {dir: d.raum.dir, code: d.raum.code, reserve: d.raum.reserve, mitte: d.raum.mitte, t: now};   // Anzeige
        tgUpdate(S, d); d.vsBase = tagesgang(S, now); d.vsDk = bedarfK(d.vs, cfg.rules.vorausschau, d.vsBase);
        d.bedQ = bedarfQ(S, d, cfg); if (d.bedQ.ja && d.fresh) { S.bedT = now; } d.bedT = S.bedT;   // Bedarf der Quiet-Stufe (Freigabe; Ausschluss fuer den Deckel)
        d.kaltQ = kaltQ(d, cfg.rules.quiet_freigabe);                                   // Kaelte-Vorsorge (Regel-Review B4)
        d.hcL = hcLage(S, d, cfg); var HE = hcEnde(d, cfg, d.hcL);                     // Heizregelung: Lage, Rueckweg-Grund/halten (14.10.2026)
        hochlaufStep(S, d, cfg);                                                        // Kennzahl: Hochlauf nach dem Start (Comfort/Efficiency, nur Anzeige)
        uebStep(S, d);                                                                  // Kennzahl: Laufenergie bei AT >= 11 °C, alle Raeume ueber der Bandmitte (nur Anzeige)
        var hcInfo = hcHinweis(S, d, cfg);                                              // Heizregelung-Hinweis (Anzeige im Waechter und auf der Uebersicht, keine Regel)
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
        // Heizregelung: Comfort der Regel gehoert ihr nur, solange der Grund besteht (wie Quiet); Efficiency (Normalzustand) gehoert niemandem: die Zuordnung endet sofort
        var AHh = S.arbH;
        if (AHh.applied && d.hc === AHh.applied.w) {
            var mxH = cfg.rules.heizregelung.maxDauerMin;
            if (AHh.applied.w === 1 || (!HE.halten && (HE.ende || (have(mxH) && now - AHh.applied.ts >= mxH * MIN)))) {
                AHh.last = {rule: AHh.applied.rule, dir: sgnOf(AHh.applied.w - AHh.applied.von), w: AHh.applied.w, von: AHh.applied.von, start: AHh.applied.ts, end: now, lapse: true, grund: AHh.applied.w === 1 ? 'Efficiency (Normalzustand)' : (HE.ende || 'Frist abgelaufen')}; AHh.applied = null;
            }
        }
        [['shift', S.arb], ['quiet', S.arbQ], ['hc', S.arbH]].forEach(function (x) {     // Arbitrierung nach dem Laden eines aelteren Zustands: laufenden Vorschlag als Eigentuemer eintragen
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
        var rr = S.rules.raum_offset; if (rr && rr.prop && rr.prop.cmd.value > rr.prop.von && res.some(function (x) { return x.id === 'raum_offset' && x.neu; })) { S.raum3.bed = Array.isArray(rr.prop.bed) ? rr.prop.bed.slice() : []; }   // Bedarfsraeume eines +1-K-Vorschlags (Rueckweg)
        // Waechter (nur Hinweise, Ereignisse in quiet-events; keine Befehle, keine Punkte)
        var cR = cfg.rules.raum_offset, L3 = d.raum;
        hwStep(S, 'verteilung', !!(L3 && L3.verteil), L3 && L3.verteil ? 'Wärmeverteilung: ' + L3.ueberL.map(function (y) { return y.r.name + ' ' + sg(y.r.t - y.r.max, 1) + ' K über Maximum'; }).join(', ') + ' und ' + L3.kaltL.map(function (y) { return y.r.name + ' ' + sg(y.r.t - y.r.min, 1) + ' K unter Minimum'; }).join(', ') + ' – die Heizkurve hilft hier nicht (sie hebt bzw. senkt alle Räume); hydraulischen Abgleich bzw. Thermostatventile prüfen (Regel-Review RE-8)' : '', cR.verteilMin, HW.verteilAusMin, now, ev);
        var SI = d.startM, sp = S.sp, dornBed = !!(sp && sp.stop && !sp.hg && d.fresh && !d.running && d.zustand === 'pause' && now - sp.stop >= HW.dornPauseMin * MIN && sp.fSoll && now - sp.fSoll >= HW.dornUeberMin * MIN);   // nicht nach Heizgrenze-Aus (Pumpe stand)
        hwStep(S, 'dornroeschen', dornBed, dornBed ? 'Verdichter steht seit ' + mins(now - sp.stop) + ' min, Vorlauf ' + de(d.vlRueck, 1) + ' K unter Soll; die Startschwelle (Soll −3,25 K) ist seit ' + mins(now - sp.fSoll) + ' min erreicht (sonst Start nach ~' + de(SI.verzug, 0) + ' min): möglicher Startabbruch („Dornröschenschlaf“, Forum 189605: 4131809, 3935020, 4578250). Ein Sollsprung +2/+3 K startet sofort – nur von Hand, kein Befehl ohne Freigabe' : '', 0, 0, now, ev);
        hwStep(S, 'stoerung', !!d.err, d.err ? 'Fehlercode ' + d.err + (/H23/i.test(d.err) ? ' (H23: Kältemittelfühler Innengerät, L-spezifisch; Forum 189605: Platinentausch über Panasonic, 4130989, 4571850)' : '') + ': Vorschläge und Übernahme gesperrt, kein automatischer Reset' : '', 0, 0, now, ev, 'optimierer_alarm');
        var rohrBed = have(d.pipeIn) && d.pipeIn < HW.rohrWarnC;
        hwStep(S, 'rohr', rohrBed, rohrBed ? 'Leitungstemperatur Innengerät ' + de(d.pipeIn, 1) + ' °C (unter ' + HW.rohrWarnC + ' °C): mögliche Vorstufe zu H23 (Forum 189605: 4693147)' : '', 5, 30, now, ev);
        var KFo = kurvenform(S, cfg);
        hwStep(S, 'kurvenform', !!KFo.hinweis, KFo.hinweis || '', 0, 0, now, ev);
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
        // Raumeinfluss v3: Rueckweg aus der Raumlage (Hysterese; +1 K nur ueber die Bedarfsraeume, -1 K bei Bedarf oder verbrauchter Reserve), spaetestens nach 6 h (Frist der Uebernahme).
        // Gilt auch fuer eine noch mit v2 uebernommene Verschiebung (Versionswechsel): ohne gespeicherte Bedarfsraeume zaehlen alle Raeume.
        var rE = raumEnde(S, d, cfg); if (rE) { ende.raum_offset = rE; }
        if (HE.ende) { ende.heizregelung = HE.ende; } if (HE.halten) { halten.heizregelung = HE.halten; }   // Heizregelung: Rueckweg der Comfort-Uebernahme
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
        var rdir = d.raum && !d.raum.keine ? d.raum.dir : 0, rV = res.filter(function (x) { return x.id === 'vorausschau'; })[0];
        if (sh !== 0 && rdir === sh) { halten.vorausschau = 'Raumeinfluss verlangt dieselbe Verschiebung (' + sg(d.shift, 0) + ' K)'; halten['quiet_strecken|shift'] = halten.vorausschau; }
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
        var dq = have(d.q) ? deckelOf(d, d.q) : null;                                   // wirksamer Deckel der jetzigen Quiet-Stufe (Anzeige im Waechter statt eigener Annahme)
        if (d.raum && !d.raum.keine) { rec.abl.raum = d.raum.dir; }                              // Raumeinfluss v3: Lage (+1 Bedarf, -1 Ueberschuss, 0) im Datensatz
        if (have(d.hc) && d.hcL && d.hcL.lage) { rec.abl.hc = d.hcL.lage; }                                   // Heizregelung: Lage +1 (Comfort-Bedarf in Efficiency) bzw. -1 (Comfort ohne Bedarf, Efficiency moeglich), nur wenn nicht 0
        if (d.hc === 0 && d.hcL && d.hcL.deckMin > 0) { rec.abl.hc_deck = Math.floor(d.hcL.deckMin); }          // in Comfort: Minuten "Bedarf gedeckt"
        return {S: S, d: d, res: res, prop: prop, rec: rec, ev: ev, scores: sc, ende: ende, halten: halten, locks: locks, hc: hcInfo,
                deckel: dq ? {q: d.q, hz: dq.hz, quelle: dq.quelle} : null, hinweise: hinweisListe(S), stoerung: d.err ? {code: d.err, seit: (S.hw && S.hw.stoerung && S.hw.stoerung.seit) || now} : null};
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
        if (rule === 'raum_offset' && (ver || 1) >= 3) { return 'raum3'; }              // v3: Problem aus der Raumlage (Bedarfsraeume bzw. Ueberschuss)
        if (rule === 'heizregelung') { return hebel === 'minus' ? 'hc_hoch' : 'hc_traege'; }   // Heizregelung: Comfort (Efficiency bleibt traege) bzw. Efficiency (Comfort faehrt ohne Bedarf hoch)
        return rule;
    }
    function tKind(T) { return T.kind || kindOf(T.rule, null, 3); }
    function bkOf(R, hebel) { return hebel === 'shift' && R.basisKurve ? R.basisKurve : (hebel === 'minus' && R.basisMinus ? R.basisMinus : (R.basis || R.id)); }   // Schluessel der Basisrate (neue Ausloesung = neue Vergleichslagen); Raumeinfluss v3: -1 K eigene Basisrate
    function progOf(R, vt) { return vt === 'shift' && R.prognoseKurve ? R.prognoseKurve : (vt === 'minus' && R.prognoseMinus ? R.prognoseMinus : R.prognose); }
    function varianten(R) { return [null].concat(R.prognoseKurve ? ['shift'] : []).concat(R.prognoseMinus ? ['minus'] : []); }
    function problemNow(T, d, cfg) {                                               // liegt das vorhergesagte Problem in dieser Minute vor? 1 / 0 / null (unbekannt)
        var rule = T.rule, ctx = T.ctx || {}, kind = tKind(T), c = cfg.rules[rule];
        if (!d.fresh) { return null; }
        if (kind === 'deckel_frei') { if (!d.running) { return null; } var cap = have(ctx.cap) ? ctx.cap + 1 : 20; return (have(d.hz) && d.hz <= cap && have(d.rlRueck) && d.rlRueck >= 1.0) ? 1 : 0; }   // v1: fest 20 Hz
        if (kind === 'hz_hoch') { return (d.running && have(d.hz) && d.hz >= (have(ctx.hzS) ? ctx.hzS : 22)) ? 1 : 0; }      // Schwelle des Falls (v4: 22 Hz)
        if (kind === 'hc_traege') { if (!d.running) { return null; } return (have(d.hz) && d.hz <= (d.hcL ? d.hcL.traegeHz : c.traegeHz) && have(d.vlRueck) && d.vlRueck >= 1.0) ? 1 : 0; }   // Efficiency bleibt traege mit Rueckstand
        if (kind === 'raum3') {
            var L3 = d.raum; if (!L3 || L3.keine) { return null; }
            if (ctx.dir === 'soll_hoch') {
                var bedR = L3.rooms.filter(function (y) { return y.ok && (!ctx.bed || !ctx.bed.length || ctx.bed.indexOf(y.r.id) >= 0); });
                return bedR.length ? (bedR.some(function (y) { return y.r.t < y.r.min; }) ? 1 : 0) : null;
            }
            return (L3.alle && !L3.kaltL.length && L3.reserve >= c.rueckReserveK && (L3.ueberL.length || L3.hausWarm)) ? 1 : 0;   // weiter ueberheizt (mit Reserve)
        }
        if (rule === 'raum_offset') {
            var r = d.rooms.filter(function (x) { return x.name === ctx.lead || x.id === ctx.lead; })[0];
            if (!r || !roomScore(r)) { return null; }
            return ctx.dir === 'soll_runter' ? (r.t > r.max ? 1 : 0) : (r.t < r.min ? 1 : 0);
        }
        if (rule === 'vorausschau') {                                               // Problem: der knappste Raum (bei t0) steht hoechstens reserveK am Bandrand (v1 auch +1 K: am unteren Rand)
            var rv = d.rooms.filter(function (x) { return x.name === ctx.lead || x.id === ctx.lead; })[0];
            if (!rv || !roomScore(rv)) { return null; }
            return ctx.dir === 'soll_runter' ? (rv.t >= rv.max - c.reserveK ? 1 : 0) : (rv.t <= rv.min + c.reserveK ? 1 : 0);
        }
        return null;
    }
    function roomRule(rule) { return rule === 'raum_offset' || rule === 'vorausschau'; }
    function bandsOf(d) { var o = {}; d.rooms.forEach(function (r) { o[r.id] = [r.min, r.max, r.active ? 1 : 0]; }); return o; }
    function newTracker(rule, now, ctx, d) { ctx.bands = bandsOf(d); var T = {rule: rule, t0: now, ctx: ctx, cut: 0, stop: 0, stopVlStop: false, wasRun: false, ser: []}; if (ctx.kind) { T.kind = ctx.kind; } if (ctx.H) { T.H = ctx.H; } return T; }
    function trackerUpdate(T, d, cfg) {
        var now = d.now, H = (T.H || Math.max.apply(null, RULE[T.rule].prognose.h)) * MIN, kind = tKind(T);
        if (now - T.t0 > H || T.cut) { return; }
        if (now > T.t0 && (d.qChanged || d.shiftChanged || d.hcChanged || Math.abs(d.sollJump) >= 2)) { T.cut = now; T.cutWhy = d.qChanged ? 'Quiet geändert' + (d.qBy ? ' (Vorschlag „' + RULE[d.qBy].kurz + '“ übernommen)' : '') : (d.shiftChanged ? 'Verschiebung geändert' + (d.shiftBy ? ' (Vorschlag „' + RULE[d.shiftBy].kurz + '“ übernommen)' : '') : (d.hcChanged ? 'Heizregelung geändert' + (d.hcBy ? ' (Vorschlag „' + RULE[d.hcBy].kurz + '“ übernommen)' : '') : 'Soll von Hand geändert')); return; }   // Eingriff von aussen: ab hier keine Gegenfaktik mehr (seit 14.10. auch die Heizregelung)
        var rk = roomRule(T.rule) || T.rule === 'heizregelung';                          // Heizregelung (14.10.2026): Komfort zaehlt (Schaden zu kalt/zu warm), Lueften und Bandwechsel sind Eingriffe
        if (rk && JSON.stringify(bandsOf(d)) !== JSON.stringify(T.ctx.bands)) { T.cut = now; T.cutWhy = 'Komfortband geändert'; return; }   // Komfortband geaendert = Eingriff
        if (rk) {                              // Lueftungsverdacht: Raum faellt >= 1 K in <= 60 min (Heizung kann das nicht) = Eingriff von aussen
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
        if (kind === 'hc_hoch') { if (!T.hit && d.fresh && d.running && d.hc === 0 && d.runMin >= 2 && have(d.hz) && d.hz >= (have(T.ctx.hzS) ? T.ctx.hzS : 28)) { T.hit = now; T.hitHz = d.hz; } return; }   // Comfort faehrt hoch (Ereignis)
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
        if (kind === 'hc_hoch') {
            if (T.hit && T.hit - T.t0 <= H) { return {o: 1, why: 'Comfort fuhr nach ' + mins(T.hit - T.t0) + ' min auf ' + de(T.hitHz, 0) + ' Hz'}; }
            if (T.cut && T.cut < T.t0 + H) { return {o: null, why: 'Eingriff nach ' + mins(T.cut - T.t0) + ' min: ' + (T.cutWhy || '')}; }
            return {o: 0, why: 'kein Hochlauf in Comfort binnen ' + h + ' min'};
        }
        var ser = T.ser.filter(function (p) { return p[0] <= H; });
        if (kind === 'deckel_frei' && T.stop && T.stop - T.t0 <= H && T.stopVlStop) { return {o: 0, why: 'Verdichter holte auf und schaltete ab'}; }
        if (T.rule === 'raum_offset' || T.rule === 'vorausschau') {                  // Raum: letzter gueltiger Wert in den letzten 30 min vor dem Horizont
            if (T.cut && T.cut < T.t0 + H) { return {o: null, why: 'Eingriff nach ' + mins(T.cut - T.t0) + ' min: ' + (T.cutWhy || '')}; }
            var lastP = ser.filter(function (p) { return p[0] >= H - 30 * MIN; });
            if (!lastP.length) { return {o: null, why: 'Raumwert am Horizont ungültig'}; }
            if (T.rule === 'vorausschau') { return {o: lastP[lastP.length - 1][1], why: lastP[lastP.length - 1][1] ? 'Raum am Bandrand' : 'Raum mit Luft im Band'}; }
            if (kind === 'raum3' && T.ctx && T.ctx.dir === 'soll_runter') { return {o: lastP[lastP.length - 1][1], why: lastP[lastP.length - 1][1] ? 'Haus weiter überheizt' : 'nicht mehr überheizt'}; }
            return {o: lastP[lastP.length - 1][1], why: lastP[lastP.length - 1][1] ? 'Raum weiter außerhalb des Bandes' : 'Raum wieder im Band'};
        }
        if (ser.length < SCORE.teilMin * h * ((kind === 'deckel_frei' || kind === 'hz_hoch' || kind === 'hc_traege') ? 0.5 : 0.3)) { return {o: null, why: 'zu wenige gültige Minuten (' + ser.length + ')'}; }
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
        if (rule === 'quiet_strecken') { var hs = hzSchwelle(d, c, taktBeleg(d, c)); return (have(d.q) && d.q < 3 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz >= hs.hz && have(d.at) && d.at > c.atMinC) ? {hzS: hs.hz} : null; }
        if (rule === 'raum_offset') {                                                // v3: Vergleichslage = Raumlage ohne Haltezeit, je Richtung (Bedarf / Ueberschuss)
            var L3 = d.raum; if (!L3 || L3.keine) { return null; }
            if (hebel === 'minus') { return L3.dir < 0 ? {dir: 'soll_runter', lead: L3.ueberL[0] ? L3.ueberL[0].r.id : (L3.warmst ? L3.warmst.r.id : '')} : null; }
            return L3.dir > 0 ? {dir: 'soll_hoch', lead: L3.kaltL[0].r.id, bed: L3.kaltL.map(function (y) { return y.r.id; })} : null;
        }
        if (rule === 'heizregelung') {                                               // Vergleichslage: Comfort-Bedarf bzw. Comfort ohne Bedarf (ohne Haltezeit, ohne Wechsel von Hand)
            var Hc = d.hcL; if (!Hc || !have(d.hc)) { return null; }
            if (hebel === 'minus') { return (d.hc === 0 && Hc.deck) ? {dir: 'weniger_leistung', hzS: c.hochHz} : null; }
            return (d.hc === 1 && d.running && d.runMin >= Hc.lm && d.bedQ && d.bedQ.ja && Hc.traege && Hc.capOk && Hc.rueck) ? {dir: 'mehr_leistung'} : null;
        }
        if (rule === 'vorausschau') {                                                // Vergleichslage (v2): Vorhersage zeigt mindestens die halbe Schwelle Milderung, alle Raeume gueltig im Band (unabhaengig vom Gate)
            var dk = d.vsDk, act = d.rooms.filter(function (x) { return x.active; });
            if (dk === null || dk > -c.deltaK / 2 || !act.length || act.some(function (x) { return !x.valid || !have(x.min) || !have(x.max) || x.t < x.min || x.t > x.max; })) { return null; }
            var ld = null; act.forEach(function (x) { var m = x.max - x.t; if (ld === null || m < ld.m) { ld = {id: x.id, m: m}; } });
            return {lead: ld.id, dir: 'soll_runter'};
        }
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
            var R = RULE[r.id], p = S.rules[r.id].prop, hb = p.hebel || null, vt = hb || (R.prognoseMinus && (p.dir === 'soll_runter' || p.dir === 'weniger_leistung') ? 'minus' : null), prog = progOf(R, vt);
            var lead = p.lead || (d.roomBelow[0] ? d.roomBelow[0].name : ''), cap = r.id === 'quiet_freigabe' ? deckelOf(d, d.q).hz : null;
            sc.cases.push({id: p.id, rule: r.id, v: R.ver, sv: sv, t0: now, p: prog.p, h: prog.h.slice(), txt: prog.text, bk: bkOf(R, vt), dir: p.dir, done: [], hr: [], pts: 0,
                           tr: newTracker(r.id, now, {lead: lead, dir: p.dir, kind: kindOf(r.id, r.id === 'heizregelung' ? vt : hb, R.ver), H: Math.max.apply(null, prog.h), cap: cap, bed: p.bed || null, hzS: have(p.hzS) ? p.hzS : (r.id === 'heizregelung' ? cfg.rules.heizregelung.hochHz : null)}, d), dmg: r.locks.length ? ['sperre_verletzt'] : []});
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
            varianten(R).forEach(function (hb) {                                         // Deckel/Laufzeit: eigene Vergleichslagen je Hebel; Raumeinfluss v3: je Richtung
                var slot = roomRule(R.id) ? 60 : 15, sk = Math.floor(now / (slot * MIN)), bk = bkOf(R, hb), prog = progOf(R, hb);
                if (sc.lastSlot[bk] === sk) { return; }
                var cn = candidateNow(R.id, d, cfg, hb);
                if (cn) { sc.lastSlot[bk] = sk; sc.cands.push({rule: R.id, bk: bk, t0: now, h: prog.h.slice(), done: [], tr: newTracker(R.id, now, {lead: cn.lead, dir: cn.dir, kind: kindOf(R.id, R.id === 'heizregelung' ? hb : (hb === 'minus' ? null : hb), R.ver), H: Math.max.apply(null, prog.h), cap: cn.cap, bed: cn.bed || null, hzS: have(cn.hzS) ? cn.hzS : null}, d)}); }
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
        // 5) Messaufgabe Heizkurve +1 K (keine Punkte): Lauf- und Pausendauer vor und nach einer Verschiebung 0 -> +1 K (Kalibrierung von laufPlusMin/pauseMinusMin).
        //    Die Messaufgabe "Comfort gegen Efficiency" ist gestrichen (Review-Paket 13.10.2026; Befund in docs/OPTIMIERER.md 7, Kennzahl "Hochlauf nach Start")
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
            if (d.q > d.qFrom && d.q >= 1 && d.running && have(S._hzPrev) && S._hzPrev >= cfg.rules.quiet_strecken.hzTakt) {      // seit v3 jede Erhoehung (Zielstufe 1, 2 oder 3); ab 22 Hz (v5: hzTakt)
                sc.eff.push({rule: 'quiet_strecken', t0: now, art: 'deckel', pel0: S._pelPrev, kal: isKal('quiet_strecken', now), m: {}, text: 'Quiet ' + d.qFrom + ' → ' + d.q + ' bei ' + de(S._hzPrev, 0) + ' Hz'});
            }
        }
        if (d.shiftChanged && have(d.shiftFrom) && Math.abs(d.shift - d.shiftFrom) === 1 && d.fresh) {
            var er = d.shiftBy && (sc.sv || SCORE_VER) >= 3 ? d.shiftBy : 'raum_offset';                // v3: die Regel, deren Vorschlag uebernommen wurde (sonst wie bisher Raumeinfluss)
            sc.eff.push({rule: er, t0: now, art: 'verschiebung', soll0: S._sollPrev, dshift: d.shift - d.shiftFrom, kal: isKal(er, now), m: {}, text: 'Verschiebung ' + sg(d.shiftFrom, 0) + ' → ' + sg(d.shift, 0) + ' K'});
        }
        if (d.hcChanged && have(d.hcFrom) && d.fresh && RULE.heizregelung) {                           // Heizregelung (14.10.2026): jede Aenderung, von wem auch immer (Zuordnung wie Verschiebung)
            var rh = d.hcBy || 'heizregelung', ch = cfg.rules.heizregelung;
            if (d.hc === 0 && d.hcFrom === 1 && d.running && have(d.vlRueck) && d.vlRueck >= ch.vlRueckK) {
                sc.eff.push({rule: rh, t0: now, art: 'comfort', hz0: have(S._hzPrev) ? S._hzPrev : d.hz, pel0: S._pelPrev, kal: isKal(rh, now), m: {}, text: 'Efficiency → Comfort bei ' + de(have(S._hzPrev) ? S._hzPrev : d.hz, 0) + ' Hz, Vorlauf ' + de(d.vlRueck, 1) + ' K unter Soll'});
            }
            if (d.hc === 1 && d.hcFrom === 0) { sc.eff.push({rule: rh, t0: now, art: 'efficiency', maxMin: 480, lauf0: d.running, kal: isKal(rh, now), m: {}, text: 'Comfort → Efficiency ' + (d.running ? 'im Lauf' : 'in der Pause')}); }
        }
        if (d.fresh) { S._pelPrev = have(d.pel) ? d.pel : S._pelPrev; S._vlPrev = d.vl; S._hzPrev = d.hz; S._sollPrev = d.soll; }
    }
    function effectUpdate(E, d, sc, recs) {
        var now = d.now, dt = (now - E.t0) / MIN, m = E.m;
        if (dt > (E.maxMin || 60)) { closeEffect(E, [['Messung', 0, E.art === 'efficiency' ? 'kein Start binnen ' + E.maxMin + ' min' : 'abgebrochen (Daten fehlten)']], sc, recs, now); return; }
        if (!d.fresh) { return; }
        if (E.art === 'efficiency') {                                                  // naechster Start in Efficiency bleibt bis Laufminute 15 bei hoechstens 21 Hz (21 von 21 Efficiency-Starts)
            if (dt > 0 && d.hcChanged) { closeEffect(E, [['nächster Start in Efficiency höchstens 21 Hz bis Laufminute 15', 0, 'nicht messbar (Heizregelung wieder geändert)']], sc, recs, now); return; }
            if (!d.running) { m.pause = true; return; }
            if (!m.pause && E.lauf0) { return; }                                         // erst der naechste Start zaehlt
            if (!m.pause && !E.lauf0) { m.pause = true; }
            if (d.runMin >= 2 && d.runMin <= 15 && have(d.hz)) { m.hzMax = Math.max(m.hzMax || 0, d.hz); if (!have(m.q)) { m.q = d.q; } }
            if (d.runMin > 15 && m.hzMax !== undefined) {
                closeEffect(E, [['nächster Start in Efficiency höchstens 21 Hz bis Laufminute 15', m.q === 0 ? (m.hzMax <= 21 ? 1 : -1) : 0, m.q === 0 ? 'gemessen höchstens ' + de(m.hzMax, 0) + ' Hz' : 'nicht messbar (Quiet ' + m.q + ' deckelt ohnehin)']], sc, recs, now);
            }
            return;
        }
        if (E.art === 'comfort') {                                                     // Comfort faehrt bei Rueckstand sofort hoch (+6 Hz binnen 5 min, +100 W; Wechsel im Lauf mit Rueckstand nicht gemessen)
            if (dt <= 5 && have(d.hz) && d.running && (m.hzMax === undefined || d.hz > m.hzMax)) { m.hzMax = d.hz; }
            if (dt >= 2 && dt <= 5 && have(d.pel) && d.running) { m.pelS = (m.pelS || 0) + d.pel; m.pelN = (m.pelN || 0) + 1; }
            if (!d.running && dt <= 5) { m.stop = true; }
            if (dt >= 5 || m.stop) {
                var dpc = (m.pelN && have(E.pel0)) ? m.pelS / m.pelN - E.pel0 : null, sHz = have(E.hz0) ? E.hz0 + 6 : null;
                closeEffect(E, [['Verdichter mindestens ' + de(sHz, 0) + ' Hz binnen 5 min', m.hzMax !== undefined && have(sHz) ? (m.hzMax >= sHz ? 1 : -1) : 0, 'gemessen ' + de(m.hzMax, 0) + ' Hz'],
                                ['Leistung +100 W oder mehr', have(dpc) ? (dpc >= 100 ? 1 : -1) : 0, 'gemessen ' + sg(dpc, 0) + ' W']], sc, recs, now);
            }
            return;
        }
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
    var EXCUSE = ['anlauf', 'daten', 'stoerung', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'regler', 'heizstab', 'modell', 'abtausprung'];
    var OWN_TEXT = {abstand: 'Mindestabstand', tageslimit: 'Tageslimit', abkuehlzeit: 'Wartezeit', haltezeit: 'Haltezeit', stabil: 'Stabilitätszeit', vorrang: 'Verschiebung einer anderen Regel', gegenrichtung: 'Wartezeit Gegenrichtung'};
    var MISS_DMG_TEXT = {komfort: 'Raum mehr als 1 K unter Minimum', takt: 'Verdichter stoppte', ueberschwingen: 'Vorlauf über der Abschaltgrenze (Soll +3,25 K)', heizstab: 'Heizstab lief'};
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
                if (l === 'abstand') { var chg = (gr === 'quiet' || gr === 'shift' || gr === 'hc') ? Math.max(S.qChg || 0, S.shiftChg || 0, S.hcChg || 0) : 0; std = !!chg && now - chg < LOCK_CFG.gapMin * MIN; }
                if (l === 'tageslimit') { std = rs.n >= stdOf(R, 'proTag'); }
                if (l === 'abkuehlzeit') { std = rs.cool - (c.pauseMin - stdOf(R, 'pauseMin')) * MIN > now; }
                if (l === 'vorrang') { std = true; }                                        // Eigentum einer anderen Regel: kein Zeitwert
                if (l === 'gegenrichtung') { var Ag = arbOf(S, gr), qg = gr === 'quiet' || gr === 'hc', e0 = Ag && Ag.last ? (r.hart && qg && Ag.last.lapse ? Ag.last.start : arbEnd(Ag, d, gr)) : 0; std = !!(Ag && Ag.last) && now - e0 < (r.hart ? (qg ? LOCK_CFG.notfallMin : LOCK_CFG.shiftHaltMin) : (gr === 'quiet' ? LOCK_CFG.quietGegenMin : (gr === 'hc' ? LOCK_CFG.hcGegenMin : LOCK_CFG.gegenMin))) * MIN; }
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
        if (d.heaterOn) { hit('heizstab'); }
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
                cond = d.fresh && have(d.q) && d.q < 3 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz >= hzSchwelle(d, c, taktBeleg(d, c)).hz && !!d.bedQ && !d.bedQ.ja && have(d.rlRueck) && d.rlRueck <= c.rlRueckMaxK &&
                       komfortSicher(d, c).ok && (!d.bedT || now - d.bedT >= c.ruheMin * MIN) && have(d.at) && d.at > c.atMinC && zielDeckel(d, c).ziel !== null; need = 20;
            }
            if (R.id === 'raum_offset') {
                // v3: Raum 0,5 K unter Minimum (nutzbar, nicht gelueftet, Kinderzimmer oben nur mit offenem Relais), kein Raum ueber Maximum + 0,3 K, 180 min; -1 K (Energie) ist nie "verpasst" (RE-4)
                var Lm = d.raum && !d.raum.keine ? d.raum.rooms : [];
                var cold = Lm.filter(function (y) { return y.ok && !y.lueft && !y.relaisAus && y.r.t <= y.r.min - 0.5; }).map(function (y) { return y.r; });
                var warm = Lm.filter(function (y) { return y.ok && y.r.t > y.r.max + 0.3; });
                cond = d.fresh && cold.length > 0 && warm.length === 0; need = 180; lead = cold.length ? cold[0].name : '';
            }
            if (R.id === 'heizregelung') {                                               // Notfall in Efficiency (Heizstab-Naehe oder Raum >= notK unter Minimum), Efficiency traege mit Rueckstand, Quiet laesst zu: 20 min
                var Hm = d.hcL || {};
                cond = !!(d.fresh && d.hc === 1 && d.running && d.bedQ && d.bedQ.notfall && Hm.traege && Hm.capOk && Hm.rueck && d.runMin >= Hm.lm); need = 20;
                lead = d.bedQ && d.bedQ.raum ? d.bedQ.raum.name : (d.bedQ && d.bedQ.heizstab ? 'Heizstab-Nähe' : '');
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
                if (R.id === 'raum_offset' && R.ver >= 3 && have(d.shift) && d.shift >= 1) { G.prop = true; G.durch = 'Verschiebung steht schon auf +1 K'; }   // v3: hoeher geht es nicht (Whitelist)
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
    // Verpasst der Vorausschau (seit Bewertung v3): Lage = Gate offen und alle Bedingungen der Regel erfuellt (Milderung >= Schwelle aus dem Wetter, Raeume
    // im Band mit Luft), 60 min am Stueck ohne Vorschlag (auch keiner einer anderen Verschiebungs-Regel in dieselbe Richtung) und ohne Sicherheits-/Datensperre.
    // Bewertet wird erst, ob die Lage WIRKLICH eintrat (bis zum Fensterende +bisH): ein Raum steigt ueber sein Maximum, oder die gemessene Aussentemperatur
    // (um den Tagesgang bereinigt) zeigt mindestens die halbe Schwelle. Trat nichts ein, gibt es keinen Eintrag. Neutralitaet wie bei den anderen Regeln: nur
    // eigene/Gegenregel-Sperren mit Standardwerten -> "verpasst_sperre" (0). Regel v2 (Review-Paket 13.10.2026): nur noch die Milderung (-1 K); der Schaden
    // "Raum > 1 K unter Minimum" galt nur dem gestrichenen Zweig +1 K und kommt nicht mehr vor.
    var VS_NEED = 60;
    function missedVs(R, S, sc, d, cfg, res, recs, sv) {
        var now = d.now, c = cfg.rules[R.id], G = sc.gt[R.id] = sc.gt[R.id] || {since: 0, pend: []}, r = res.filter(function (x) { return x.id === R.id; })[0];
        G.pend = G.pend || [];
        var cond = !!(d.fresh && d.vs && d.vs.gate && have(d.vsDk) && d.vsDk <= -c.deltaK && r && !r.dauer && (r.st === 'wartet' || r.st === 'vorschlag' || r.st === 'abgelaufen' || (r.st === 'gesperrt' && r.locks.indexOf('modell') < 0)));   // v2: nur die Milderung (-1 K)
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
        SetZ1HeatRequestTemperature: {topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature', werte: [-1, 0, 1], ruecklese: 'shift', text: 'Heizkurven-Verschiebung', heizkurve: true},
        SetHeatingControl: {topic: 'panasonic_heat_pump/commands/SetHeatingControl', werte: [0, 1], ruecklese: 'hc', text: 'Heizregelung (0 Comfort, 1 Efficiency)'}   // seit 14.10.2026 (Regel "Heizregelung")
    };
    // engMaxAlterMin/engAbbruchMin (Regel-Review B7): Rueckweg-Gruende und "halten" der Maschine gelten nur, wenn sie hoechstens 5 min alt sind (sonst gilt die Frist);
    // rechnet die Maschine 30 min nicht, geht jede bestaetigte Uebernahme auf ihren Ausgangswert zurueck (sicherer Abbruch: der Wert des Nutzers vor dem Klick)
    var APPLY = {maxAlterMin: 2.5, hpMaxAgeMin: 5, abstandMin: 10, proTag: 6, doppelMs: 120000, rueckleseS: 90, wiederholungen: 2, rueckwegVersuche: 3, engMaxAlterMin: 5, engAbbruchMin: 30};
    // Uebernahmen je Groesse (seit 13.10.2026, Regel-Review R6): A.ak = {quiet: …, shift: …}; Quiet und Verschiebung koennen nebeneinander uebernommen sein, wenn die
    // Arbitrierung der Maschine es zulaesst (Mindestabstand ueber beide Groessen). A.aktiv = die juengste (Anzeige, aeltere Leser, Kern-Guard bis zur Haertung).
    function newApply() { return {mv: VER, ak: {}, aktiv: null, pending: null, day: '', n: 0, lastSend: 0, verworfen: [], lastClick: null, alarm: null}; }
    function gOfCmd(name) { var W = WHITELIST[name]; return W && W.ruecklese === 'q' ? 'quiet' : (W && W.ruecklese === 'hc' ? 'hc' : 'shift'); }
    function fixApply(A) {
        A = (A && A.mv === VER) ? A : newApply();
        if (!A.ak || typeof A.ak !== 'object') { A.ak = {}; }
        var a0 = A.aktiv;                                                             // aelterer Zustand bzw. von aussen gesetzte Uebernahme: in A.ak eintragen
        if (a0 && a0.name && WHITELIST[a0.name]) { var g0 = gOfCmd(a0.name); if (A.ak[g0] !== a0 && !(A.ak[g0] && A.ak[g0].id === a0.id)) { A.ak[g0] = a0; } }
        return A;
    }
    function akList(A) { return ['quiet', 'shift', 'hc'].map(function (g) { return A.ak[g]; }).filter(function (a) { return !!a; }); }
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
        if (W.heizkurve && Math.abs(p.cmd.value - num(p.von)) > 1) { return deny('Höchstens 1 K je Befehl (' + p.von + ' → ' + p.cmd.value + '; Regel-Review RE-5). Nichts gesendet.'); }
        var stE = errCode(plant.err) || (eng.stoerung && eng.stoerung.code) || null;
        if (stE) { return deny('Störung der Anlage (' + stE + '): keine Übernahme, kein automatischer Reset. Nichts gesendet.'); }
        if (num(plant.block) === 1) { return deny('Alle MQTT-Befehle sind gesperrt (MQTT.block_active). Nichts gesendet.'); }
        if (!fresh(plant)) { return deny('Anlagendaten sind veraltet. Nichts gesendet.'); }
        if (eng.locks && eng.locks[p.rule] && eng.locks[p.rule].length) { return deny('Gesperrt: ' + eng.locks[p.rule].join(', ') + '. Nichts gesendet.'); }
        var ist = num(plant[W.ruecklese]);
        if (ist !== p.von) { return deny('Die Anlage steht nicht mehr auf ' + p.von + ' (jetzt ' + (ist === null ? 'unbekannt' : ist) + '). Nichts gesendet.'); }
        if (W.heizkurve && (num(plant.heatMode) !== 0 || num(plant.z1Sensor) !== 0)) { return deny('Verschiebung nur im Heizkurvenmodus mit Wasserfühler. Nichts gesendet.'); }
        if (A.pending) { return deny('Ein Befehl wartet noch auf die Bestätigung der Anlage. Nichts gesendet.', 'orange'); }
        // je Groesse eine Uebernahme (jede hat ihren Rueckweg); dieselbe Regel darf sie in derselben Richtung fortsetzen (Regel-Review B1, R6)
        var g = gOfCmd(p.cmd.name), a0 = A.ak[g], fort = fortsetzung(a0, p);
        if (a0 && !fort) { return deny('Für ' + (g === 'quiet' ? 'die Quiet-Stufe' : (g === 'hc' ? 'die Heizregelung' : 'die Verschiebung')) + ' läuft schon eine Übernahme (' + (RULE[a0.rule] ? RULE[a0.rule].kurz : a0.rule) + ', ' + a0.von + ' → ' + a0.value + '); erst zurücksetzen oder den Rückweg abwarten. Nichts gesendet.', 'orange'); }
        if (A.lastSend && now - A.lastSend < APPLY.abstandMin * MIN) { return deny('Zu schnell: frühestens ' + hhmm(A.lastSend + APPLY.abstandMin * MIN) + '. Nichts gesendet.', 'orange'); }
        if (A.n >= APPLY.proTag) { return deny('Tageslimit von ' + APPLY.proTag + ' Befehlen erreicht. Nichts gesendet.'); }
        // ---- senden: genau der angezeigte Vorschlag
        var R = RULE[p.rule], cr = ctx.cfg && ctx.cfg.rules && ctx.cfg.rules[p.rule], maxD = have(num(p.maxDauerMin)) ? num(p.maxDauerMin) : (cr && have(num(cr.maxDauerMin)) ? num(cr.maxDauerMin) : null);
        var until = (maxD && !p.einmal) ? now + maxD * MIN : null;                     // Heizregelung -> Efficiency: Normalzustand, kein Rueckweg
        A.n++; A.lastSend = now; A.lastClick = {id: p.id, ts: now}; A.alarm = null;
        A.pending = {name: p.cmd.name, value: p.cmd.value, ts: now, versuche: 1, art: 'uebernahme', id: p.id, g: g, vorher: num(p.von)};
        A.ak[g] = {id: p.id, rule: p.rule, groesse: p.groesse || R.groesse, name: p.cmd.name, value: p.cmd.value, von: fort ? a0.von : p.von, ts: now, bis: until, bestaetigt: false,
                   start: fort ? (a0.start || a0.ts) : now, schritte: fort ? (a0.schritte || 1) + 1 : 1};
        if (p.einmal) { A.ak[g].einmal = true; }
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
        var now = ctx.now, out = {A: A, send: [], toast: null, log: []}, P = A.pending, plant = ctx.plant || {};
        var blocked = num(plant.block) === 1 || !!errCode(plant.err) || !!(ctx.eng && ctx.eng.stoerung);   // Notbremse oder Stoerung (Fehlercode, z. B. H23): nichts senden, Rueckweg wartet
        if (P) {
            var gP = P.g || gOfCmd(P.name), aP = A.ak[gP], W = WHITELIST[P.name], ist = num(plant[W.ruecklese]);
            if (ist === P.value && fresh(plant)) {
                A.pending = null;
                if (P.art === 'uebernahme' && aP && aP.einmal) { delete A.ak[gP]; out.toast = {text: W.text + ' steht jetzt auf ' + P.value + ' (von der Anlage bestätigt; Normalzustand, kein Rückweg).', color: 'green'}; }
                else if (P.art === 'uebernahme' && aP) { aP.bestaetigt = true; aP.bestTs = now; delete aP.unbestaetigt; out.toast = {text: W.text + ' steht jetzt auf ' + P.value + ' (von der Anlage bestätigt).', color: 'green'}; }
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
            brier: brier, hPunkte: hPunkte, vorschau: vorschau, bedarfK: bedarfK, VS_LIM: VS_LIM, PLAUS: PLAUS, tagesgang: tagesgang, defaults: defaults, mergeCfg: mergeCfg, newState: newState, fixState: fixState, step: step, report: report, STILLGELEGT: STILLGELEGT, UEB: UEB, uebStep: uebStep, uebSumme: uebSumme, HCW: HCW, hcHinweis: hcHinweis, TAKT: TAKT, TAKT_SCHWELLEN: TAKT_SCHWELLEN, taktCfg: taktCfg, taktNew: taktNew, taktStep: taktStep, taktKennzahlen: taktKennzahlen, mindestLeistung: mindestLeistung, copSumme: copSumme, copTabelle: copTabelle, COP_KORR: COP_KORR, copKw: copKw, pelKorr: pelKorr, korrTxt: korrTxt, bandOf: bandOf, modusOf: modusOf, nlNeu: nlNeu, nlZeilen: nlZeilen, nlEnde: nlEnde, HG: HG, heizgrenzeBeob: heizgrenzeBeob, LAG: LAG, lagMessen: lagMessen, lagStep: lagStep, KB: KB, kbTag: kbTag, kbStep: kbStep, snapshot: snapshot, unsnap: unsnap,
            checksum: checksum, newApply: newApply, applyRequest: applyRequest, applyTick: applyTick, fortsetzung: fortsetzung, gOfCmd: gOfCmd, iso: iso, ymd: ymd, zielDeckel: zielDeckel, zielFrei: zielFrei, deckelOf: deckelOf, deckelTab: deckelTab, DECKEL: DECKEL,
            bedarfQ: bedarfQ, raumTrend: raumTrend, komfortSicher: komfortSicher, nutzenKurve: nutzenKurve, kindOf: kindOf, kaltQ: kaltQ, zielKalt: zielKalt, nachtMin: nachtMin, HL: HL, hochlaufSumme: hochlaufSumme,
            hhmm: hhmm, isoWeek: isoWeek, de: de, sg: sg,
            raumLage: raumLage, raumVerlauf: raumVerlauf, raumEnde: raumEnde, kurvenform: kurvenform, KF: KF, p2Summe: p2Summe, startModell: startModell, START: START, MINHZ: MINHZ, minHzOf: minHzOf, minHzTab: minHzTab,
            binKeyOf: binKeyOf, hzSchwelle: hzSchwelle, HW: HW, errCode: errCode, hinweisListe: hinweisListe, wirkzeit: wirkzeit, RELAIS_RAUM: RELAIS_RAUM, Q0_HZ: Q0_HZ,
            hcLage: hcLage, hcEnde: hcEnde, hcTxt: hcTxt};
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = ENGINE; }
// == ENGINE-CORE-ENDE ==

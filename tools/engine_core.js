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
    var SCORE_VER = 1;           // Bewertungsregeln (vorab festgelegt; jede Aenderung erhoeht die Version, alte Punkte bleiben getrennt)
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
        {id: 'anlauf', text: 'Maschine beobachtet erst seit kurzem (Neustart)', herkunft: 'Zeitgeber und Zähler müssen nach einem Neustart erst wieder Daten sammeln (10 min)'},
        {id: 'daten', text: 'HeishaMon-Daten fehlen oder sind veraltet', herkunft: 'HeishaMon meldet laufend; älter als 5 min = veraltet (Wächter: 10 min)'},
        {id: 'mqtt_sperre', text: 'Alle MQTT-Befehle sind gesperrt (MQTT.block_active)', herkunft: 'HeishaMoNR-Notbremse; sie friert den Zustand ein (Opus-Review 09.10.)'},
        {id: 'abtauen', text: 'Abtauen oder kurz danach', herkunft: 'Wächter/Quiet-Logik: keine Änderung beim und 10 min nach dem Abtauen (Opus: 10–20 min)'},
        {id: 'warmwasser', text: 'Warmwasser oder kurz danach', herkunft: 'wie Abtauen (diese Anlage macht kein Warmwasser, die Sperre bleibt als Schutz)'},
        {id: 'sanftanlauf', text: 'Sanftanlauf (HeishaMoNR SoftStart) aktiv', herkunft: 'SoftStart verschiebt die Heizkurve selbst'},
        {id: 'laufbeginn', text: 'Verdichter läuft erst kurz', herkunft: 'Start-Pumpenspitze 2900 U/min für 11–16 min bei jedem Start; Quiet wirkt erst nach 1–2 min'},
        {id: 'heizgrenze_aus', text: 'Heizgrenze-Aus (Pumpe steht)', herkunft: 'Heizgrenze 12 °C mit Hysterese: aus ab 15 °C, ein ab 12 °C, Pumpe 0, Vorlauf ohne Aussage'},
        {id: 'regler', text: 'Ein anderer Regler stellt dieselbe Größe', herkunft: 'HeishaMoNR-Quiet-Logik/Scheduler/Solar/WP-Zeitplan bzw. Raumregelung/Nachtabsenkung/Sanftanlauf; Verschiebung nur im Heizkurvenmodus mit Wasserfühler und ohne Handeingriff am Soll'},
        {id: 'abstand', text: 'Mindestabstand zur letzten Änderung', herkunft: 'Wächter: 60 min Abstand; Opus: höchstens 1 Wechsel pro Stunde'},
        {id: 'tageslimit', text: 'Tageslimit der Regel erreicht', herkunft: 'Schreibbudget (Opus: höchstens 6 Wechsel/Tag), EEPROM-Verschleiß unbekannt'},
        {id: 'abkuehlzeit', text: 'Wartezeit nach dem letzten Vorschlag', herkunft: 'kein Flattern: ein abgelaufener oder zurückgezogener Vorschlag kommt erst nach einer Pause wieder'},
        {id: 'takt', text: 'Takt-Gefahr: Vorlauf über Soll', herkunft: 'Anlage schaltet bei Vorlauf ≥ Soll +3,25 K nach ~3 min ab (6 Stopps 07.–10.10.); Sperre ab Soll +1 K für Maßnahmen, die den Vorlauf näher an diese Grenze bringen (mehr Leistung, −1 K)'},
        {id: 'heizstab', text: 'Heizstab-Nähe', herkunft: 'Heizstab ab Außentemperatur < Heater_On_Outdoor_Temp (0 °C) bei Vorlauf < Soll −3 K nach 15 min; ein +1-K-Schritt vergrößert den Rückstand sofort um 1 K'}
    ];
    var LOCK_TEXT = {}; LOCKS.forEach(function (l) { LOCK_TEXT[l.id] = l.text; });

    // ------------------------------------------------------------------ Regelwerk als Daten. Jede Schwelle: Standard, Einheit, Herkunft (Messung / Nutzerregel / ANNAHME)
    var RULES = [
        {
            id: 'quiet_freigabe', ver: 1, name: 'Quiet-Freigabe', art: 'befehl', groesse: 'quiet', richtung: 'mehr_leistung', prio: 1,
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
                    {k: 'lauf', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running},
                    {k: 'laufMin', t: 'Lauf seit mindestens ' + c.laufMin + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + c.laufMin + ' min', ok: d.runMin >= c.laufMin, ist: r2(d.runMin), soll: c.laufMin, op: '>=', u: 'min', dyn: true},
                    {k: 'deckel', t: 'Verdichter am Quiet-Deckel (≤ ' + c.capHz + ' Hz)', tn: 'Verdichter nicht am Deckel (' + de(d.hz, 0) + ' Hz)', ok: have(d.hz) && d.hz > 0 && d.hz <= c.capHz, ist: d.hz, soll: c.capHz, op: '<=', u: 'Hz', dyn: true},
                    {k: 'vlRueck', t: 'Vorlauf mindestens ' + de(c.vlRueckK, 1) + ' K unter Soll', tn: 'Vorlauf ' + rueckTxt(d.vlRueck) + ' (Schwelle ' + de(c.vlRueckK, 1) + ' K darunter)', ok: have(d.vlRueck) && d.vlRueck >= c.vlRueckK, ist: r2(d.vlRueck), it: rueckTxt(d.vlRueck), soll: c.vlRueckK, op: '>=', u: 'K', dyn: true},
                    {k: 'rlRueck', t: 'Rücklauf mindestens ' + de(c.rlRueckK, 1) + ' K unter Soll-Rücklauf', tn: 'Rücklauf ' + rueckTxt(d.rlRueck) + ' (Schwelle ' + de(c.rlRueckK, 1) + ' K darunter)', ok: have(d.rlRueck) && d.rlRueck >= c.rlRueckK, ist: r2(d.rlRueck), it: rueckTxt(d.rlRueck), soll: c.rlRueckK, op: '>=', u: 'K', dyn: true},
                    {k: 'bedarf', t: 'Raum unter Minimum oder Sollvorlauf noch nicht erreicht', tn: 'kein Bedarf: alle gültigen Räume ab Minimum und Sollvorlauf in diesem Lauf erreicht', ok: !!rb || !d.reached}
                ];
                return {cond: cond, halt: c.haltMin, wert: 0, von: d.q,
                        was: 'Quiet-Stufe ' + d.q + ' → 0',
                        warum: 'Verdichter ' + de(d.hz, 0) + ' Hz am Quiet-Deckel, Vorlauf ' + de(d.vlRueck, 1) + ' K und Rücklauf ' + de(d.rlRueck, 1) + ' K unter Soll, Lauf ' + de(d.runMin, 0) + ' min; ' + (rb ? rb.name + ' ' + de(rb.min - rb.t, 1) + ' K unter Minimum' : 'Sollvorlauf in diesem Lauf noch nicht erreicht')};
            }
        },
        {
            id: 'quiet_strecken', ver: 1, name: 'Laufzeit strecken (Quiet 3)', art: 'befehl', groesse: 'quiet', richtung: 'weniger_leistung', prio: 2,
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
                    {k: 'lauf', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running},
                    {k: 'laufMin', t: 'Lauf seit mindestens ' + c.laufMin + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + c.laufMin + ' min', ok: d.runMin >= c.laufMin, ist: r2(d.runMin), soll: c.laufMin, op: '>=', u: 'min', dyn: true},
                    {k: 'hoch', t: 'Verdichter deutlich über Minimum (≥ ' + c.hzHoch + ' Hz)', tn: 'Verdichter bei ' + de(d.hz, 0) + ' Hz (Schwelle ' + c.hzHoch + ' Hz)', ok: have(d.hz) && d.hz >= c.hzHoch, ist: d.hz, soll: c.hzHoch, op: '>=', u: 'Hz', dyn: true},
                    {k: 'keinBedarf', t: 'kein Raum unter Minimum und Rücklauf höchstens ' + de(c.rlRueckMaxK, 1) + ' K unter Soll', tn: rb ? 'Bedarf: ' + rb.name + ' unter Minimum' : 'Bedarf: Rücklauf ' + rueckTxt(d.rlRueck), ok: !rb && have(d.rlRueck) && d.rlRueck <= c.rlRueckMaxK, ist: rb ? null : r2(d.rlRueck), soll: c.rlRueckMaxK, op: '<=', u: 'K', dyn: !rb},
                    {k: 'takt', t: 'Takt-Indiz (Abschaltung binnen ' + c.stoppBaldMin + ' min, kurzer letzter Lauf oder viele Starts)', tn: 'kein Takt-Indiz' + (have(d.stopEtaMin) ? ' (Abschaltgrenze in ~' + de(d.stopEtaMin, 0) + ' min)' : ''), ok: takt}
                ];
                return {cond: cond, halt: c.haltMin, wert: 3, von: d.q,
                        was: 'Quiet-Stufe ' + d.q + ' → 3 (Laufzeit strecken)',
                        warum: 'Verdichter ' + de(d.hz, 0) + ' Hz ohne Bedarf (Rücklauf ' + rueckTxt(d.rlRueck) + ', alle Räume mindestens im Band); ' + taktTxt.join(', ')};
            }
        },
        {
            id: 'raum_offset', ver: 1, name: 'Raumeinfluss (Heizkurve ±1 K)', art: 'befehl', groesse: 'shift', richtung: 'verschiebung', prio: 3,
            zweck: 'Räume wirken nur als langsamer, kleiner Offset auf die Heizkurve (Lambda-Prinzip). Übernimmt den Raumvorschlag der Phase-2-Logik (korrektur_vorschlag −1/0/+1) erst, wenn er lange stabil ist. Nie Comfort/Efficiency.',
            eingaenge: ['Raumvorschlag Phase 2 (korrektur_vorschlag, Führungsraum, Wärmeverteilung)', 'Verschiebung an der Anlage (TOP27)', 'Soll-Vorlauf und Heizkurve', 'Heizkurvenmodus/Zonenfühler'],
            sperren: ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'laufbeginn', 'heizgrenze_aus', 'regler', 'abstand', 'tageslimit', 'abkuehlzeit', 'takt', 'heizstab'],
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
            rueckweg: 'Automatisch zurück auf 0 K, sobald der Raumvorschlag 0 ist oder spätestens nach 6 h; „Zurücksetzen“ jederzeit.',
            prognose: {p: 0.7, h: [60, 120, 240], text: 'Ohne Verschiebung bleibt der Führungsraum außerhalb seines Bandes'},
            kalibriert: [],
            eval: function (d, c, rs) {
                var k = d.korr;
                if (!k || !have(num(k.v))) { return {inaktiv: 'Raumvorschlag (Phase 2) fehlt'}; }
                if (!have(d.shift)) { return {inaktiv: 'Verschiebung der Anlage (TOP27) unbekannt'}; }
                var kv = num(k.v);
                if (kv === d.shift) { return {inaktiv: 'Raumvorschlag ' + sg(kv, 0) + ' K = Verschiebung der Anlage'}; }
                var stab = rs.korrSince ? mins(d.now - rs.korrSince) : 0, down = kv < d.shift;
                var sollNeu = have(d.soll) ? d.soll + (kv - d.shift) : null;
                var cond = [
                    {k: 'stabil', t: 'Raumvorschlag seit mindestens ' + c.stabilMin + ' min stabil', tn: 'Raumvorschlag ' + sg(kv, 0) + ' K erst seit ' + stab + ' von ' + c.stabilMin + ' min stabil', ok: stab >= c.stabilMin, ist: stab, soll: c.stabilMin, op: '>=', u: 'min', dyn: true},
                    {k: 'untergrenze', t: 'Soll-Vorlauf bleibt mindestens ' + de(c.minVlC, 0) + ' °C', tn: 'Soll-Vorlauf würde ' + de(sollNeu, 0) + ' °C (Untergrenze ' + de(c.minVlC, 0) + ' °C)', ok: !down || (have(sollNeu) && sollNeu >= c.minVlC - 1e-9), ist: r2(sollNeu), soll: c.minVlC, op: '>=', u: '°C', dyn: true},
                    {k: 'verteilung', t: 'kein Wärmeverteilungsproblem', tn: 'Wärmeverteilungsproblem (ein Raum zu kalt, einer zu warm)', ok: !k.distrib}
                ];
                return {cond: cond, halt: 0, wert: kv, von: d.shift, dir: kv > d.shift ? 'soll_hoch' : 'soll_runter', lead: k.lead || '',
                        was: 'Heizkurve ' + sg(d.shift, 0) + ' → ' + sg(kv, 0) + ' K (Soll-Vorlauf ' + de(d.soll, 0) + ' → ' + de(sollNeu, 0) + ' °C)',
                        warum: 'Raumvorschlag ' + sg(kv, 0) + ' K seit ' + stab + ' min: ' + (k.code || '') + (k.lead ? ' (Führungsraum ' + k.lead + ')' : '')};
            }
        },
        {
            id: 'heizgrenze_hinweis', ver: 1, name: 'Heizgrenze 12 → 10 °C (nur Hinweis)', art: 'hinweis', groesse: 'heizgrenze', richtung: 'weniger_waerme', prio: 4,
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
                    {k: 'lauf', t: 'Verdichter läuft', tn: 'Verdichter steht (' + zTxt(d.zustand) + ')', ok: d.running},
                    {k: 'laufMin', t: 'Lauf seit mindestens ' + c.laufMin + ' min', tn: 'Startphase: Lauf erst ' + de(d.runMin, 0) + ' von ' + c.laufMin + ' min', ok: d.runMin >= c.laufMin, ist: r2(d.runMin), soll: c.laufMin, op: '>=', u: 'min', dyn: true},
                    {k: 'aussen', t: 'Außentemperatur über ' + de(c.zielC, 0) + ' °C', tn: 'Außentemperatur ' + de(d.at, 0) + ' °C (nicht über ' + de(c.zielC, 0) + ' °C)', ok: have(d.at) && d.at > c.zielC, ist: d.at, soll: c.zielC + 1, op: '>=', u: '°C', dyn: true},
                    {k: 'raeume', t: 'alle aktiven Räume gültig', tn: 'nur ' + d.roomsValid + ' von ' + d.roomsActive + ' Räumen gültig', ok: allValid},
                    {k: 'reserve', t: 'jeder Raum mindestens ' + de(c.reserveK, 1) + ' K über Minimum', tn: 'knappster Raum ' + (tight ? tight.name + ' ' + sg(tight.t - tight.min, 1) + ' K' : '–') + ' über Minimum (Reserve ' + de(c.reserveK, 1) + ' K)', ok: allValid && tight !== null && tight.t - tight.min >= c.reserveK, ist: tight ? r2(tight.t - tight.min) : null, soll: c.reserveK, op: '>=', u: 'K', dyn: true}
                ];
                return {cond: cond, halt: c.haltMin, wert: c.zielC, von: d.heatOffAT, dir: 'weniger_waerme',
                        was: 'Heizgrenze ' + de(d.heatOffAT, 0) + ' → ' + de(c.zielC, 0) + ' °C (nur Hinweis)',
                        warum: 'Lauf bei ' + de(d.at, 0) + ' °C Außentemperatur, knappster Raum ' + (tight ? tight.name + ' ' + sg(tight.t - tight.min, 1) + ' K über Minimum' : '–')};
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
        raumAlterMax: 360,         // Bewertung (nicht Entscheidung): ein Raumwert bis 6 h alt zaehlt, weil die Shelly H&T Gen3 nur bei Aenderung >= 0,5 K melden
        reife: {faelle: 10, tage: 14, skill: 0.2, wirkFaelle: 2, verpasst: 1}
    };

    // ------------------------------------------------------------------ Standardwerte (aus dem Regelwerk)
    var LOCK_CFG = {hpMaxAgeMin: 5, afterDefrostMin: 10, afterDhwMin: 10, startLockMin: 15, gapMin: 60, taktK: 1.0, stopK: 3.25, heaterMarginK: 2, warmupMin: 10, pumpOnRpm: 1000, kurveTolK: 1.5};
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
        }
        return c;
    }

    // ------------------------------------------------------------------ Zustand (ueberlebt Neustarts per Datei)
    function newState(now) {
        var S = {mv: VER, born: now, last: now, run: {on: null, start: 0, reached: false, reachN: 0, sollTop: null}, lastStop: 0, lastStart: 0, runs: [], starts: [],
                 defrostEnd: 0, dhwEnd: 0, defrostWas: false, dhwWas: false, q: null, qChg: 0, shift: null, shiftChg: 0, soll: null, handWas: false, vlHist: [], needSince: 0,
                 rules: {}, sc: newScore()};
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
                 pump: num(inp.pump), pel: num(inp.pel), heatOffAT: num(inp.heatOffAT), korr: inp.korr || null};
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
    function locksFor(R, d, S, cfg, inp, dirNow) {
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
        var v = num(x.ist), n = {b: x.k, ist: have(v) ? r2(v) : null, s: have(x.soll) ? x.soll : null, u: x.u || ''};
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
        function endProp(why) { if (rs.prop) { rs.prop = null; rs.cool = now + c.pauseMin * MIN; res.ende = why; } }
        if (!d.fresh && R.sperren.indexOf('daten') >= 0) {                                 // ohne frische Anlagendaten wird keine Bedingung bewertet
            var ld = locksFor(R, d, S, cfg, inp, null).filter(function (l) { return l.id === 'daten'; });
            rs.since = 0; rs.failSince = 0; endProp('gesperrt: ' + ld[0].text);
            res.st = 'gesperrt'; res.grund = 'gesperrt: ' + ld[0].text; res.locks = ['daten']; res.naechste = {b: 'daten', text: 'prüft wieder, sobald HeishaMon frische Daten liefert'};
            return res;
        }
        var e = R.eval(d, c, rs);
        if (e.inaktiv) { rs.since = 0; rs.failSince = 0; endProp(e.inaktiv); res.st = 'inaktiv'; res.grund = e.inaktiv; return res; }
        var bad = e.cond.filter(function (x) { return !x.ok; });
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
                res.naechste = {b: 'haltezeit', ist: Math.floor(held), s: e.halt, abstand: e.halt - Math.floor(held), u: 'min', text: 'würde in ' + Math.ceil(e.halt - held) + ' min schalten, wenn alles so bleibt'};
                return res;
            }
        }
        var lk = locksFor(R, d, S, cfg, inp, e.dir);
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
        return o;
    }
    function unsnap(t, o) {                                                       // Gegenstueck: aus einem Datensatz wieder eine Eingabe machen (Nachspielen)
        var inp = {t: t};
        SNAP_KEYS.forEach(function (k) { if (o[k] !== undefined) { inp[k] = o[k]; } });
        inp.rooms = (o.rooms || []).map(function (a) { return {id: a[0], name: a[7] || a[0], t: a[1], age: a[2], valid: a[3] === 1, min: a[4], max: a[5], active: a[6] !== 0}; });
        if (o.korr) { inp.korr = o.korr; }
        return inp;
    }

    // ------------------------------------------------------------------ Hauptschritt
    function step(S, inp, cfg) {
        cfg = cfg || defaults();
        var now = inp.t;
        S = fixState(S, now);
        var d = derive(S, inp, cfg);
        track(S, d, inp, cfg);
        var res = [], ev = [], locks = {};
        RULES.forEach(function (R) {
            var r = evalRule(R, d, S, cfg, inp);
            res.push(r); locks[R.id] = r.locks;
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
        if (d.korr && num(d.korr.v) === 0) { ende.raum_offset = 'Raumvorschlag ist wieder 0 K'; }
        S.last = now;
        var rec = {t: iso(now), mv: VER, sv: SCORE_VER, in: snapshot(inp),
                   abl: {z: d.zustand, lauf_min: r2(d.runMin), vl_rueck: r2(d.vlRueck), rl_rueck: r2(d.rlRueck), erreicht: d.reached ? 1 : 0, vl_k_h: r2(d.vlSlope), stopp_in_min: r2(d.stopEtaMin), starts_3h: d.starts3h},
                   r: res.map(function (x) { var o = {id: x.id, v: x.v, st: x.st, grund: x.grund}; if (x.naechste) { o.naechste = recNext(x.naechste); } if (x.p) { o.p = x.p; } if (x.locks.length) { o.sperren = x.locks; } return o; }),
                   vorschlag: prop ? prop.id : null};
        return {S: S, d: d, res: res, prop: prop, rec: rec, ev: ev, scores: sc, ende: ende, locks: locks};
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
        if (rule === 'heizgrenze_hinweis') {
            var act = d.rooms.filter(function (x) { return x.active; });
            if (!act.length || act.some(function (x) { return !roomScore(x); })) { return null; }
            if (act.some(function (x) { return x.t < x.min; })) { return 0; }
            return act.every(function (x) { return x.t >= x.min + c.reserveK; }) ? 1 : null;
        }
        return null;
    }
    function newTracker(rule, now, ctx) { return {rule: rule, t0: now, ctx: ctx, cut: 0, stop: 0, stopVlStop: false, wasRun: false, ser: []}; }
    function trackerUpdate(T, d, cfg) {
        var now = d.now, H = Math.max.apply(null, RULE[T.rule].prognose.h) * MIN;
        if (now - T.t0 > H || T.cut) { return; }
        if (now > T.t0 && (d.qChanged || d.shiftChanged || Math.abs(d.sollJump) >= 2)) { T.cut = now; return; }   // Eingriff von aussen: ab hier keine Gegenfaktik mehr
        if (T.rule === 'quiet_strecken') { if (!T.stop && T.wasRun && !d.running && d.fresh) { T.stop = now; } if (d.running) { T.wasRun = true; } return; }
        var pr = problemNow(T.rule, T.ctx, d, cfg);
        if (pr !== null) { T.ser.push([now - T.t0, pr]); }
        if (T.rule === 'quiet_freigabe' && T.wasRun && !d.running && d.fresh && !T.stop) { T.stop = now; T.stopVlStop = have(d.vlRueck) && d.vlRueck <= -2; }
        if (d.running) { T.wasRun = true; }
    }
    function outcome(T, h) {                                                       // Ergebnis o (1 = Problem bestand, 0 = loeste sich von selbst, null = unsicher)
        var H = h * MIN, end = T.cut ? Math.min(T.cut, T.t0 + H) : T.t0 + H, span = (end - T.t0) / MIN;
        if (span < SCORE.teilMin * h) { return {o: null, why: T.cut ? 'Eingriff nach ' + Math.round(span) + ' min' : 'zu kurz beobachtet'}; }
        if (T.rule === 'quiet_strecken') {
            if (T.stop && T.stop - T.t0 <= H) { return {o: 1, why: 'Lauf endete nach ' + mins(T.stop - T.t0) + ' min'}; }
            if (T.cut && T.cut < T.t0 + H) { return {o: null, why: 'Eingriff'}; }
            return {o: 0, why: 'Lauf lief länger als ' + h + ' min'};
        }
        var ser = T.ser.filter(function (p) { return p[0] <= H; });
        if (T.rule === 'quiet_freigabe' && T.stop && T.stop - T.t0 <= H && T.stopVlStop) { return {o: 0, why: 'Verdichter holte auf und schaltete ab'}; }
        if (T.rule === 'raum_offset') {                                              // Raum: letzter gueltiger Wert in den letzten 30 min vor dem Horizont
            var lastP = ser.filter(function (p) { return p[0] >= H - 30 * MIN; });
            if (!lastP.length) { return {o: null, why: 'Raumwert am Horizont ungültig'}; }
            return {o: lastP[lastP.length - 1][1], why: lastP[lastP.length - 1][1] ? 'Raum weiter außerhalb des Bandes' : 'Raum wieder im Band'};
        }
        if (ser.length < SCORE.teilMin * h * (T.rule === 'quiet_freigabe' ? 0.5 : 0.3)) { return {o: null, why: 'zu wenige gültige Minuten (' + ser.length + ')'}; }
        if (T.rule === 'heizgrenze_hinweis') { return ser.some(function (p) { return p[1] === 0; }) ? {o: 0, why: 'ein Raum fiel unter Minimum'} : {o: 1, why: 'alle Räume blieben über Minimum + Reserve'}; }
        var f = ser.reduce(function (a, p) { return a + p[1]; }, 0) / ser.length;
        if (f >= SCORE.trefferAnteil) { return {o: 1, why: 'Problem in ' + Math.round(f * 100) + ' % der Minuten'}; }
        if (f <= 1 - SCORE.trefferAnteil) { return {o: 0, why: 'Problem nur in ' + Math.round(f * 100) + ' % der Minuten'}; }
        return {o: null, why: 'unklar (' + Math.round(f * 100) + ' %)'};
    }
    function baseRate(sc, rule, h) { var b = (sc.base[rule] || {})[h]; if (!b || b[0] < SCORE.baseMinN) { return {b: 0.5, n: b ? b[0] : 0}; } return {b: (b[1] + 1) / (b[0] + 2), n: b[0]}; }
    function candidateNow(rule, d, cfg) {                                            // Vergleichslage fuer die Basisrate (schwaecher als der Ausloeser)
        var c = cfg.rules[rule];
        if (!d.fresh) { return null; }
        if (rule === 'quiet_freigabe') { return (have(d.q) && d.q >= 1 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz <= c.capHz && have(d.rlRueck) && d.rlRueck >= 1.0) ? {} : null; }
        if (rule === 'quiet_strecken') { return (have(d.q) && d.q < 3 && d.running && d.runMin >= c.laufMin && have(d.hz) && d.hz >= c.hzHoch) ? {} : null; }
        if (rule === 'raum_offset') { if (d.roomBelow.length) { return {lead: d.roomBelow[0].id, dir: 'soll_hoch'}; } if (d.roomAbove.length) { return {lead: d.roomAbove[0].id, dir: 'soll_runter'}; } return null; }
        if (rule === 'heizgrenze_hinweis') { return (have(d.heatOffAT) && d.heatOffAT > c.zielC && d.running && d.runMin >= c.laufMin && have(d.at) && d.at > c.zielC) ? {} : null; }
        return null;
    }
    function tot(sc, rule, ver) { var k = rule + '|v' + ver; return sc.tot[k] = sc.tot[k] || {rule: rule, ver: ver, since: 0, punkte: 0, faelle: 0, bewertet: 0, treffer: 0, fehlalarm: 0, neutral: 0, bs: 0, bsRef: 0, schaden: 0, verpasst: 0, wirkN: 0, wirkP: 0, kalib: 0}; }
    function book(sc, recs, rec, now) {
        recs.push(rec);
        var T = tot(sc, rec.regel, rec.v);
        T.punkte = Math.round((T.punkte + rec.punkte) * 100) / 100;
        rec.summe = T.punkte;
        var wk = isoWeek(now), W = sc.week[wk] = sc.week[wk] || {};
        var w = W[rec.regel] = W[rec.regel] || {punkte: 0, faelle: 0, treffer: 0, fehlalarm: 0, schaden: 0, verpasst: 0, wirkung: 0};
        w.punkte = Math.round((w.punkte + rec.punkte) * 100) / 100;
        if (rec.typ === 'ausloeser') { w.faelle++; if (rec.ergebnis === 'treffer') { w.treffer++; } if (rec.ergebnis === 'fehlalarm') { w.fehlalarm++; } }
        if (rec.typ === 'schaden') { w.schaden++; }
        if (rec.typ === 'verpasst') { w.verpasst++; }
        if (rec.typ === 'wirkung') { w.wirkung++; }
        sc.hist.push([now, rec.regel, T.punkte]);
        if (sc.hist.length > 2000) { sc.hist = sc.hist.slice(-2000); }
        var ks = Object.keys(sc.week).sort(); while (ks.length > 12) { delete sc.week[ks.shift()]; }
    }
    var DMG_TEXT = {sperre_verletzt: 'Vorschlag trotz aktiver Sperre', heizstab: 'Heizstab lief', stopp10: 'Verdichter stoppte binnen 10 min', ueberschwingen: 'Vorlauf über der Abschaltgrenze (Soll +3,25 K)', zu_warm: 'Raum über Maximum + 0,5 K', zu_kalt: 'Raum unter Minimum − 0,3 K'};
    function scoreStep(S, d, inp, cfg, res) {
        var sc = S.sc, now = d.now, recs = [];
        RULES.forEach(function (R) { var T = tot(sc, R.id, R.ver); if (!T.since) { T.since = now; } });
        // 1) neue Faelle aus neuen Vorschlaegen/Hinweisen
        res.forEach(function (r) {
            if (!r.neu) { return; }
            var R = RULE[r.id], p = S.rules[r.id].prop;
            var lead = p.lead || (d.roomBelow[0] ? d.roomBelow[0].name : '');
            sc.cases.push({id: p.id, rule: r.id, v: R.ver, t0: now, p: R.prognose.p, h: R.prognose.h.slice(), dir: p.dir, done: [], hr: [], pts: 0,
                           tr: newTracker(r.id, now, {lead: lead, dir: p.dir}), dmg: r.locks.length ? ['sperre_verletzt'] : []});
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
                    pts = SCORE.brierFaktor * (Math.pow(br.b - oc.o, 2) - Math.pow(C.p - oc.o, 2)) / C.h.length;
                    var T0 = tot(sc, C.rule, C.v); T0.bs += Math.pow(C.p - oc.o, 2); T0.bsRef += Math.pow(br.b - oc.o, 2);
                }
                C.hr.push({h: h, o: oc.o, b: r2(br.b), nb: br.n, punkte: r2(pts), why: oc.why});
                C.pts += pts;
            });
            if (C.done.length === C.h.length && !C.closed) {
                C.closed = true;
                var T = tot(sc, C.rule, C.v), os = C.hr.filter(function (x) { return x.o !== null; });
                var erg = os.length ? (os.filter(function (x) { return x.o === 1; }).length * 2 >= os.length ? 'treffer' : 'fehlalarm') : 'neutral';
                T.faelle++; if (os.length) { T.bewertet++; } if (erg === 'treffer') { T.treffer++; } else if (erg === 'fehlalarm') { T.fehlalarm++; } else { T.neutral++; }
                book(sc, recs, {t: iso(now), typ: 'ausloeser', regel: C.rule, v: C.v, sv: SCORE_VER, fall: C.id, p: C.p, horizonte: C.hr, ergebnis: erg, punkte: r2(C.pts),
                                text: RULE[C.rule].prognose.text + ': ' + C.hr.map(function (x) { return x.h + ' min ' + (x.o === null ? 'neutral (' + x.why + ')' : (x.o ? 'ja' : 'nein') + ' (' + x.why + ', Basisrate ' + de(x.b, 2) + ')'); }).join(' · ')}, now);
                if (C.dmg.length) {
                    var sum = 0; C.dmg.forEach(function (k) { sum += SCORE.schaden[k]; });
                    T.schaden += C.dmg.length;
                    book(sc, recs, {t: iso(now), typ: 'schaden', regel: C.rule, v: C.v, sv: SCORE_VER, fall: C.id, arten: C.dmg.slice(), punkte: sum, text: 'Hätte nach den Daten geschadet: ' + C.dmg.map(function (k) { return DMG_TEXT[k]; }).join(', ')}, now);
                }
            }
        });
        sc.cases = sc.cases.filter(function (C) { return !C.closed; });
        // Vergleichslagen fuer die Basisrate: je Regel hoechstens eine je 15 min (Raum/Heizgrenze: je 60 min), damit sich Faelle kaum ueberlappen
        RULES.forEach(function (R) {
            var slot = (R.id === 'raum_offset' || R.id === 'heizgrenze_hinweis') ? 60 : 15, sk = Math.floor(now / (slot * MIN));
            if (sc.lastSlot[R.id] === sk) { return; }
            var cn = candidateNow(R.id, d, cfg);
            if (cn) { sc.lastSlot[R.id] = sk; sc.cands.push({rule: R.id, t0: now, h: R.prognose.h.slice(), done: [], tr: newTracker(R.id, now, {lead: cn.lead, dir: cn.dir})}); }
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
        effectStart(sc, d, S, cfg);
        sc.eff.forEach(function (E) { effectUpdate(E, d, sc, recs); });
        sc.eff = sc.eff.filter(function (E) { return !E.closed; });
        // 4) Verpasst
        missedStep(sc, d, cfg, res, recs);
        // 5) Messaufgabe (keine Punkte): Verdichterfrequenz/Leistung bei Quiet 0 und Rueckstand >= 2 K, Comfort gegen Efficiency
        messStep(sc, d, S, recs);
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
            sc.eff.push({rule: 'raum_offset', t0: now, art: 'verschiebung', soll0: S._sollPrev, dshift: d.shift - d.shiftFrom, kal: isKal('raum_offset', now), m: {}, text: 'Verschiebung ' + sg(d.shiftFrom, 0) + ' → ' + sg(d.shift, 0) + ' K'});
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
        var T = tot(sc, E.rule, RULE[E.rule].ver); T.wirkN++; T.wirkP = r2(T.wirkP + pts); if (E.kal) { T.kalib++; }
        book(sc, recs, {t: iso(now), typ: 'wirkung', regel: E.rule, v: RULE[E.rule].ver, sv: SCORE_VER, ab: iso(E.t0), kalibrierfall: E.kal ? 1 : 0, punkte: pts, roh: raw,
                        teile: parts.map(function (x) { return {prognose: x[0], ergebnis: x[1] > 0 ? 'getroffen' : (x[1] < 0 ? 'daneben' : 'nicht messbar'), messung: x[2]}; }),
                        text: E.text + ': ' + parts.map(function (x) { return x[0] + ' → ' + (x[1] > 0 ? 'getroffen' : (x[1] < 0 ? 'daneben' : 'nicht messbar')) + ' (' + x[2] + ')'; }).join(' · ') + (E.kal ? ' · Kalibrierfall: das Modell stammt aus genau dieser Messung, 0 Punkte' : '')}, now);
    }
    // Verpasst: eine unabhaengig und strenger definierte Lage, in der laut Regelwerk ein Vorschlag noetig gewesen waere, ohne dass die Regel einen machte.
    // Sperren aus Daten/Sicherheit entschuldigen; die eigenen Grenzen der Regel (Tageslimit, Abstand, Wartezeit, Stabilitaet) nicht.
    var EXCUSE = ['anlauf', 'daten', 'mqtt_sperre', 'abtauen', 'warmwasser', 'sanftanlauf', 'regler', 'heizstab'];
    function missedStep(sc, d, cfg, res, recs) {
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
            if (cond) {
                if (!G.since) { G.since = now; G.prop = false; G.excused = false; G.booked = false; G.lead = lead; }
                if (r && (r.st === 'vorschlag' || r.st === 'hinweis')) { G.prop = true; }
                if (r && r.locks && r.locks.some(function (l) { return EXCUSE.indexOf(l) >= 0; })) { G.excused = true; }
                if (!G.booked && now - G.since >= need * MIN) {
                    G.booked = true;
                    if (!G.prop && !G.excused) {
                        var T = tot(sc, R.id, R.ver); T.verpasst++;
                        book(sc, recs, {t: iso(now), typ: 'verpasst', regel: R.id, v: R.ver, sv: SCORE_VER, ab: iso(G.since), punkte: SCORE.verpasst,
                                        text: 'Seit ' + hhmm(G.since) + ' (' + need + ' min) lag eine Lage vor, die einen Vorschlag gebraucht hätte' + (G.lead ? ' (' + G.lead + ')' : '') + '; die Regel machte keinen (Stand: ' + (r ? r.grund : '–') + ')'}, now);
                    }
                }
            } else { G.since = 0; }
        });
    }
    // Messaufgabe "Comfort gegen Efficiency" (Korrektur 10.10.: ob Efficiency den Verdichter begrenzt, ist ungeklaert, Quiet 3 hat es bisher verdeckt).
    // Sammelt Minuten mit Quiet 0, laufendem Verdichter (ab Minute 15 und 3 min nach einer Quiet-Aenderung) und Vorlauf >= 2 K unter Soll, getrennt nach
    // Heizregelung. Sobald beide Seiten >= 10 min bei aehnlicher Aussentemperatur (Mittel hoechstens 3 K auseinander) haben, wird EIN Befund festgehalten.
    var MESS = {rueckK: 2, minMin: 10, atTolK: 3, nachQuietMin: 3, laufMin: 15};
    function messStep(sc, d, S, recs) {
        var M = sc.mess = sc.mess || {c: [], e: [], done: false};
        if (!d.fresh || !d.running || d.q !== 0 || !have(d.hc) || !have(d.vlRueck) || d.vlRueck < MESS.rueckK || d.runMin < MESS.laufMin || (S.qChg && d.now - S.qChg < MESS.nachQuietMin * MIN)) { return; }
        var L = d.hc === 0 ? M.c : (d.hc === 1 ? M.e : null); if (!L) { return; }
        L.push([d.now, d.at, d.hz, d.pel, d.pth, r2(d.vlRueck), r2(d.rlRueck)]); if (L.length > 600) { L.splice(0, L.length - 600); }
        if (M.done || M.c.length < MESS.minMin || M.e.length < MESS.minMin) { return; }
        var sC = messSum(M.c), sE = messSum(M.e);
        if (!have(sC.at) || !have(sE.at) || Math.abs(sC.at - sE.at) > MESS.atTolK) { return; }
        M.done = true; M.befund = {comfort: sC, efficiency: sE, t: d.now};
        book(sc, recs, {t: iso(d.now), typ: 'messaufgabe', regel: 'quiet_freigabe', v: RULE.quiet_freigabe.ver, sv: SCORE_VER, punkte: 0, comfort: sC, efficiency: sE,
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
    function report(S) {                                                             // Punktebuch je Regel/Version mit Freigabereife (nur Anzeige; die Freigabe entscheidet der Nutzer)
        var sc = S.sc, out = [];
        RULES.forEach(function (R) {
            var T = tot(sc, R.id, R.ver), days = T.since ? (S.last - T.since) / (24 * 60 * MIN) : 0;
            var skill = T.bsRef > 0 ? 1 - T.bs / T.bsRef : null;
            var crit = [
                {k: 'faelle', ok: T.bewertet >= SCORE.reife.faelle, text: T.bewertet + ' von ' + SCORE.reife.faelle + ' bewerteten Fällen'},
                {k: 'tage', ok: days >= SCORE.reife.tage, text: de(days, 1) + ' von ' + SCORE.reife.tage + ' Tagen'},
                {k: 'skill', ok: have(skill) && skill >= SCORE.reife.skill, text: 'Brier-Skill ' + (have(skill) ? de(skill, 2) : '–') + ' (mindestens ' + de(SCORE.reife.skill, 1) + ')'},
                {k: 'schaden', ok: T.schaden === 0, text: T.schaden + ' × Schaden'},
                {k: 'verpasst', ok: T.verpasst <= SCORE.reife.verpasst, text: T.verpasst + ' × verpasst (höchstens ' + SCORE.reife.verpasst + ')'}
            ];
            if (R.art === 'befehl') { crit.push({k: 'wirkung', ok: T.wirkN - T.kalib >= SCORE.reife.wirkFaelle && T.wirkP > 0, text: (T.wirkN - T.kalib) + ' von ' + SCORE.reife.wirkFaelle + ' Wirkungsfällen (ohne Kalibrierung), ' + sg(T.wirkP, 0) + ' Punkte'}); }
            out.push({regel: R.id, name: R.name, v: R.ver, art: R.art, punkte: T.punkte, faelle: T.faelle, bewertet: T.bewertet, treffer: T.treffer, fehlalarm: T.fehlalarm, neutral: T.neutral,
                      trefferquote: T.bewertet ? r2(T.treffer / T.bewertet) : null, fehlalarmquote: T.bewertet ? r2(T.fehlalarm / T.bewertet) : null, skill: r2(skill), schaden: T.schaden, verpasst: T.verpasst,
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
    // ctx: {now, enabled (Hauptschalter), rules (freigegebene Regel-IDs), eng (OPT_engine: {ts, prop, locks}), plant ({q, shift, hpAge, block, heatMode, z1Sensor}), cfg, endReason}
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
                    if (P.art === 'uebernahme' && A.aktiv) { A.aktiv.unbestaetigt = true; }
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
        if (a.bis && now >= a.bis) { why = 'Rückweg nach Ablauf (' + hhmm(a.bis) + ')'; }
        else if (a.bestaetigt && ctx.endReason && ctx.endReason[a.rule]) { why = 'Rückweg: ' + ctx.endReason[a.rule]; }
        if (why && fresh(plant)) { return startReturn(A, ctx, out, why); }
        return out;
    }

    return {VER: VER, SCORE_VER: SCORE_VER, RULES: RULES, RULE: RULE, LOCKS: LOCKS, LOCK_CFG: LOCK_CFG, SCORE: SCORE, WHITELIST: WHITELIST, APPLY: APPLY,
            defaults: defaults, mergeCfg: mergeCfg, newState: newState, fixState: fixState, step: step, report: report, messStatus: messStatus, MESS: MESS, snapshot: snapshot, unsnap: unsnap,
            checksum: checksum, newApply: newApply, applyRequest: applyRequest, applyTick: applyTick, iso: iso, hhmm: hhmm, isoWeek: isoWeek, de: de, sg: sg};
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = ENGINE; }
// == ENGINE-CORE-ENDE ==

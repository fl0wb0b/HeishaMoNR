/* Anlagenschema der Leisha WH-WDG05LE5 (Monoblock, R290, Zone 1 Heizkoerper, KEIN Warmwasserspeicher, KEIN Puffer, interner Heizstab, externer Aussenfuehler).
 * Reine Funktionen, vom Generator (tools/optimizer_phase1.py) eingebettet: daten() in den Function-Knoten opt_schema, html()/mount() in die Vorlagen
 * opt_t_schema (Seite "Optimierer") und opt_t_schema_ue (Seite "Übersicht"); geprueft in tools/optimizer_sim.js, statisch gerendert in tools/opt_seiten_vorschau.js.
 *   OPTSCHEMA.daten(HP, X, korrW, now) -> Nutzlast: HP = global OPT_hp ({Name: {v, ts}}, Namen ohne TOP-Praefix), X = {freq, rt, rtLast, starts, vs, owm} (HeishaMoNR-
 *                                         Globale compressor_frequency, compressor_runtime, compressor_last_runtime, Starts_Today; vs = OPT_engine.vs mit ts,
 *                                         owm = {t, ts} aus OPT_weather), korrW = OPT_cfg.cop.pelKorrW
 *   OPTSCHEMA.modul(P) / modulMount(el, P) -> Modulkacheln "Wärmepumpe" und "Heizkreis Zone 1" (Vorlage opt_t_module, Übersicht) aus derselben Nutzlast
 *   OPTSCHEMA.html(P, opt)               -> HTML: SVG-Schema + Kennzahlen-Leiste; opt.phase = Sekunden (Fliess-Animation laeuft ueber das Neuzeichnen hinweg weiter)
 *   OPTSCHEMA.mount(el, P)               -> zeichnet in ein Element (nur wenn sich etwas geaendert hat)
 * Nur Anzeige: liest Werte, schreibt nichts. Fehlende Werte (HeishaMon -128/-127/-78/-200, aelter als 15 min, Einstellungen aelter als 24 h) zeigen "–".
 * Farben und Schrift wie tools/ui_optik.css (Text #263238, Nebentext #546e7a, Kennzahlen 20 px, Grundschrift 14 px; Textfarben >= 4,5:1, Linien >= 3:1).
 * Fuellfarben stehen als style="fill:…" (die Seiten-CSS des Dashboards ueberschreibt das SVG-Attribut fill). */
var OPTSCHEMA = (function () {
    var VER = 2, MIN = 60000, FEHLT = [-128, -127, -78, -200];
    var C = {txt: '#263238', mute: '#546e7a', box: '#b0bec5', vl: '#d32f2f', vlT: '#c62828', rl: '#1976d2', rlT: '#1565c0', luft: '#0097a7', luftT: '#00727f',
             heiss: '#d84315', fl: '#e65100', kalt: '#0288d1', saug: '#00897b', grau: '#78909c', rot: '#c62828', ok: '#2e7d32', warn: '#b45309', dunkel: '#455a64'};

    // ---------------------------------------------------------------- Daten (Function-Knoten opt_schema)
    function num(x) { if (x === null || x === undefined || x === '' || typeof x === 'boolean') { return null; } x = Number(x); return isFinite(x) ? x : null; }
    function daten(HP, X, korrW, now) {
        HP = HP || {}; X = X || {};
        var hpTs = 0;
        Object.keys(HP).forEach(function (k) { if (k.charAt(0) !== '_' && HP[k] && typeof HP[k].ts === 'number' && HP[k].ts > hpTs) { hpTs = HP[k].ts; } });
        function wert(n, maxMin) {
            var e = HP[n], v = e ? num(e.v) : null;
            if (v === null || FEHLT.indexOf(v) >= 0) { return null; }
            if (typeof e.ts === 'number' && now - e.ts > maxMin * MIN) { return null; }
            return v;
        }
        function v(n) { return wert(n, 15); }                                      // Messwerte (HeishaMon schickt alle Werte mindestens alle ~5 min)
        function s(n) { return wert(n, 24 * 60); }                                 // Einstellungen und Zaehler
        var hz = v('Compressor_Freq'); if (hz === null) { hz = num(X.freq); }
        var lauf = hz !== null && hz > 0;
        var pumpU = v('Pump_Speed'), flow = v('Pump_Flow'), fan = v('Fan1_Motor_Speed');
        var pumpe = (pumpU !== null && pumpU > 0) || (flow !== null && flow > 0.5);
        var vl = v('Main_Outlet_Temp'), rl = v('Main_Inlet_Temp');
        var kw = num(korrW); if (kw === null || kw < 0 || kw > 200) { kw = 80; }
        var pth = v('Heat_Power_Production_Extra'), pel = v('Heat_Power_Consumption_Extra');
        var korr = lauf ? kw : 0, pelK = pel !== null ? pel + korr : null;      // COP-Korrektur: TOP16 untertreibt nur im Lauf (Forum 189605), Stillstand bleibt roh
        var cop = (lauf && pth !== null && pth > 0 && pelK !== null && pelK > 100) ? pth / pelK : null;
        var errRaw = HP.Error && HP.Error.v !== undefined && HP.Error.v !== null ? String(HP.Error.v).trim() : '';
        var fehler = (errRaw && !/^(no error|0|)$/i.test(errRaw)) ? errRaw : null;
        var an = s('Heatpump_State'), abtau = v('Defrosting_State') === 1;
        var hsAn = v('Internal_Heater_State') === 1, hsFrei = s('Room_Heater_State');
        var z;
        if (fehler) { z = {c: 'stoerung', t: 'Störung'}; }
        else if (an === 0) { z = {c: 'aus', t: 'Aus'}; }
        else if (abtau) { z = {c: 'abtauen', t: 'Abtauen'}; }
        else if (lauf) { z = {c: 'lauf', t: 'läuft'}; }
        else if (pumpU === null && flow === null) { z = {c: 'unbekannt', t: '–'}; }
        else if (pumpU !== null && pumpU >= 1000) { z = {c: 'pause', t: 'Pause'}; }       // Thermo-Aus mit laufender Pumpe (wie opt_quiet: zustand "pause")
        else { z = {c: 'heizgrenze', t: 'Heizgrenze'}; }                                 // Pumpe steht
        var alter = hpTs ? Math.max(0, (now - hpTs) / MIN) : null;
        // Kopfzeile (UI-Lambda 14.10.2026): Fuehler und "modifizierte" Aussentemperatur = Fuehler - Bedarfsaenderung aus der Wettervorhersage (vsDk der
        // Entscheidungsmaschine, OPT_engine.vs; > 0 = mehr Bedarf erwartet, also tiefer). Nur wenn die Maschine frisch (<= 5 min) und die Vorhersage nicht aelter
        // als prognoseMaxMin ist; sonst nur der Fuehler. OWM-Temperatur (OPT_weather.temp) bis 120 min alt.
        var at = v('Outside_Temp'), vs = X.vs || null, mat = null, dk = null;
        if (at !== null && vs && num(vs.dk) !== null && typeof vs.ts === 'number' && now - vs.ts <= 5 * MIN && now >= vs.ts - MIN) {
            var pAlt = num(vs.age), pMax = num(vs.maxMin);
            if (pAlt !== null && pAlt + (now - vs.ts) / MIN <= (pMax !== null ? pMax : 120)) { dk = num(vs.dk); mat = Math.round((at - dk) * 10) / 10; }
        }
        var ow = X.owm || null, owm = (ow && num(ow.t) !== null && typeof ow.ts === 'number' && now - ow.ts <= 120 * MIN) ? num(ow.t) : null;
        var kopf = {at: at, mat: mat, dk: dk, von: vs ? num(vs.von) : null, bis: vs ? num(vs.bis) : null, owm: owm};
        var kv = [s('Z1_Heat_Curve_Target_High_Temp'), s('Z1_Heat_Curve_Outside_Low_Temp'), s('Z1_Heat_Curve_Target_Low_Temp'), s('Z1_Heat_Curve_Outside_High_Temp')];
        return {v: VER, ts: now, alter: alter, veraltet: alter === null || alter > 5, lauf: lauf, pumpe: pumpe, luefter: fan !== null && fan > 0, zustand: z, fehler: fehler,
                heizstab: {an: hsAn, frei: hsFrei, h: s('Room_Heater_Operations_Hours')}, kopf: kopf,
                hk: {kurve: kv.every(function (x) { return x !== null; }) ? {vlKalt: kv[0], atKalt: kv[1], vlWarm: kv[2], atWarm: kv[3]} : null,
                     plan: s('Main_Schedule_State'), ferien: s('Holiday_Mode_State'), ba: s('Operating_Mode_State')},
                w: {at: at, rohrA: v('Outside_Pipe_Temp'), evaAus: v('Eva_Outlet_Temp'), hz: hz, strom: v('Compressor_Current'), fan: fan,
                    heiss: v('Discharge_Temp'), hd: v('High_Pressure'), eev: v('Expansion_Valve'), hex: v('Main_Hex_Outlet_Temp'), rohrI: v('Inside_Pipe_Temp'),
                    vl: vl, rl: rl, soll: v('Main_Target_Temp'), shift: s('Z1_Heat_Request_Temp'), flow: flow, pumpU: pumpU, duty: v('Pump_Duty'), druck: v('Water_Pressure'),
                    grenze: s('Heating_Off_Outdoor_Temp'), pth: pth, pel: pel, pelK: pelK, korr: korr, korrW: kw, cop: cop, spreiz: (vl !== null && rl !== null) ? vl - rl : null,
                    quiet: s('Quiet_Mode_Level'), hc: s('Heating_Control'), betrH: s('Operations_Hours'), betrN: s('Operations_Counter'),
                    laufMin: lauf ? num(X.rt) : null, letzteMin: num(X.rtLast), startsHeute: num(X.starts)}};
    }

    // ---------------------------------------------------------------- Darstellung (Vorlagen)
    function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function ok(x) { return x !== null && x !== undefined && isFinite(x); }
    function dez(x, d) { var s = Number(x).toFixed(d), neg = s.charAt(0) === '-'; if (neg) { s = s.slice(1); } var p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return (neg ? '−' : '') + p.join(','); }
    function f(x, d, u) { return ok(x) ? dez(x, d) + (u ? '\u00a0' + u : '') : '–'; }                 // Zahl und Einheit bleiben zusammen (geschuetztes Leerzeichen)
    function t(x) { return ok(x) ? dez(x, Math.round(x) === x ? 0 : 1) + '\u00a0°C' : '–'; }                 // ganze Grad ohne Komma, Viertelgrade mit einer Stelle
    function sg(x, u) { if (!ok(x)) { return '–'; } return (x > 0 ? '+' : (x < 0 ? '' : '±')) + dez(x, Math.round(x) === x ? 0 : 1) + '\u00a0' + u; }
    function tx(x, y, s, o) {
        o = o || {};
        return '<text x="' + x + '" y="' + y + '" style="fill:' + (o.c || C.txt) + ';font-size:' + (o.s || 14) + 'px;font-weight:' + (o.b ? 600 : 400) + '"' + (o.a ? ' text-anchor="' + o.a + '"' : '') + '>' + s + '</text>';
    }
    function ln(pts, c, w, cls, extra) { return '<polyline points="' + pts + '" style="fill:none;stroke:' + c + ';stroke-width:' + (w || 5) + ';stroke-linejoin:round;stroke-linecap:round' + (extra || '') + '"' + (cls ? ' class="' + cls + '"' : '') + '/>'; }
    function pfeil(x, y, r, c, g) {                                        // Pfeilspitze bei (x, y) in Richtung r (r/l/u/d), Groesse g
        g = g || 8;
        var P = {r: [[x + g, y], [x - g, y - g], [x - g, y + g]], l: [[x - g, y], [x + g, y - g], [x + g, y + g]], u: [[x, y - g], [x - g, y + g], [x + g, y + g]], d: [[x, y + g], [x - g, y - g], [x + g, y - g]]}[r];
        return '<polygon points="' + P.map(function (p) { return p.join(','); }).join(' ') + '" style="fill:' + c + ';stroke:none"/>';
    }
    // Fliessen: weisse Striche ueber der farbigen Leitung, nur wenn das Medium fliesst (Pumpe, Luefter, Verdichter); sonst ruhig
    function fliess(pts, an) { return an ? ln(pts, '#ffffff', 2.5, 'osch-fl', ';stroke-dasharray:3 15;opacity:.7') : ''; }

    function svg(P) {
        var W = P.w || {}, o = [];
        o.push('<svg viewBox="0 0 900 400" role="img" aria-label="Anlagenschema Leisha: Außenluft, Kältekreis, Vorlauf und Rücklauf zum Heizkörper" xmlns="http://www.w3.org/2000/svg" style="font-family:inherit">');
        o.push('<defs><linearGradient id="osch_hk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:#ffebee"/><stop offset="1" style="stop-color:#e3f2fd"/></linearGradient></defs>');
        // Aussengeraet (Monoblock): Kaeltekreis, Pumpe und Heizstab liegen darin
        o.push('<rect x="100" y="14" width="580" height="382" rx="14" style="fill:#f7f9fa;stroke:' + C.box + ';stroke-width:1.5;stroke-dasharray:6 5"/>');
        o.push(tx(114, 38, 'Außengerät WH-WDG05LE5 · R290', {c: C.mute, s: 12, b: true}));
        // Aussenluft (cyan) durch Luefter und Verdampfer
        [160, 210, 260].forEach(function (y) {
            var seg = y === 210 ? ['6,210 116,210', '164,210 186,210'] : ['6,' + y + ' 186,' + y];
            seg.forEach(function (s) { o.push(ln(s, C.luft, 4)); o.push(fliess(s, P.luefter)); });
            o.push(pfeil(186, y, 'r', C.luft, 7));
        });
        o.push(tx(4, 112, 'Außen (Fühler)', {c: C.mute, s: 12}));
        o.push(tx(4, 138, t(W.at), {c: C.luftT, s: 20, b: true}));
        // Bauteile (UI-Lambda): grau im Stillstand, gruen in Betrieb (Luefter, Verdichter, Expansionsventil, Pumpe); Verdichter beim Abtauen im Abtau-Ton
        var fanC = P.luefter ? C.ok : C.grau;
        o.push('<g' + (P.luefter ? ' class="osch-rot"' : '') + '><circle cx="140" cy="210" r="20" style="fill:' + (P.luefter ? '#e8f5e9' : '#ffffff') + ';stroke:' + fanC + ';stroke-width:3"/>' +
               [0, 120, 240].map(function (a) { return '<path d="M140,210 q4,-15 0,-17 q-6,2 0,17" transform="rotate(' + a + ' 140 210)" style="fill:' + fanC + ';stroke:none"/>'; }).join('') + '</g>');
        o.push(tx(140, 298, 'Lüfter', {c: C.mute, s: 12, a: 'middle'}));
        o.push(tx(140, 316, f(W.fan, 0, 'U/min'), {a: 'middle'}));
        // Kaeltekreis: Verdampfer -> Sauggas -> Verdichter -> Heissgas -> Waermetauscher -> fluessig -> Expansionsventil -> kalt -> Verdampfer
        var KL = P.lauf;
        o.push(ln('210,130 210,92 332,92', C.saug)); o.push(fliess('210,130 210,92 332,92', KL)); o.push(pfeil(272, 92, 'r', C.saug, 7));
        o.push(ln('408,92 530,92 530,130', C.heiss)); o.push(fliess('408,92 530,92 530,130', KL)); o.push(pfeil(530, 116, 'd', C.heiss, 7));
        o.push(ln('530,290 530,350 392,350', C.fl)); o.push(fliess('530,290 530,350 392,350', KL)); o.push(pfeil(462, 350, 'l', C.fl, 7));
        o.push(ln('348,350 210,350 210,290', C.kalt)); o.push(fliess('348,350 210,350 210,290', KL)); o.push(pfeil(210, 316, 'u', C.kalt, 7));
        // Verdampfer (Lamellen)
        var lam = ''; for (var yy = 140; yy <= 280; yy += 10) { lam += '<line x1="198" y1="' + yy + '" x2="222" y2="' + yy + '" style="stroke:' + C.luft + ';stroke-width:1"/>'; }
        o.push('<rect x="196" y="130" width="28" height="160" rx="3" style="fill:#e0f7fa;stroke:' + C.luft + ';stroke-width:2"/>' + lam);
        o.push(tx(238, 166, 'Verdampfer', {c: C.mute, s: 12}));
        o.push(tx(238, 186, 'Rohr ' + t(W.rohrA)));
        o.push(tx(238, 206, 'Austritt ' + t(W.evaAus)));
        // Verdichter
        o.push(tx(370, 44, 'Verdichter', {c: C.mute, s: 12, a: 'middle'}));
        var abt = P.zustand && P.zustand.c === 'abtauen', vdC = !KL ? C.grau : (abt ? C.luftT : C.ok), vdF = !KL ? '#ffffff' : (abt ? '#e0f7fa' : '#e8f5e9');
        o.push('<circle cx="370" cy="92" r="38" style="fill:' + vdF + ';stroke:' + vdC + ';stroke-width:3"/>');
        if (KL) { o.push('<circle cx="370" cy="92" r="32" class="osch-rot" style="fill:none;stroke:' + vdC + ';stroke-width:2;stroke-dasharray:10 8;opacity:.6"/>'); }
        o.push(tx(370, 97, f(W.hz, 0, 'Hz'), {s: 20, b: true, a: 'middle'}));
        o.push(tx(370, 116, f(W.strom, 1, 'A'), {c: C.mute, s: 12, a: 'middle'}));
        o.push(tx(418, 60, 'Heißgas ' + t(W.heiss), {s: 13}));
        o.push(tx(418, 78, 'Hochdruck ' + f(W.hd, 1, 'bar'), {s: 13}));
        // Waermetauscher (Kondensator, Platten)
        o.push('<rect x="516" y="130" width="28" height="160" rx="3" style="fill:#fff3e0;stroke:#8d6e63;stroke-width:2"/>');
        o.push(ln('520,140 540,155 520,170 540,185 520,200 540,215 520,230 540,245 520,260 540,275 520,284', '#8d6e63', 1.5));
        o.push(tx(504, 166, 'Wärmetauscher', {c: C.mute, s: 12, a: 'end'}));
        o.push(tx(504, 186, 'Austritt ' + t(W.hex), {a: 'end'}));
        o.push(tx(504, 206, 'Rohr innen ' + t(W.rohrI), {a: 'end'}));
        // Expansionsventil
        var evC = KL ? C.ok : C.grau, evF = KL ? '#e8f5e9' : '#eceff1';
        o.push('<line x1="370" y1="350" x2="370" y2="332" style="stroke:' + evC + ';stroke-width:2"/><rect x="361" y="324" width="18" height="9" rx="2" style="fill:' + evF + ';stroke:' + evC + ';stroke-width:1.5"/>');
        o.push('<path d="M348,338 L370,350 L348,362 Z M392,338 L370,350 L392,362 Z" style="fill:' + evF + ';stroke:' + evC + ';stroke-width:2;stroke-linejoin:round"/>');
        o.push(tx(370, 384, 'Expansionsventil ' + f(W.eev, 0), {s: 13, a: 'middle'}));
        // Mitte des Kaeltekreises: Zustand
        var zc = {lauf: C.ok, stoerung: C.rot, abtauen: C.luftT, aus: C.mute, unbekannt: C.mute, pause: C.dunkel, heizgrenze: C.warn}[P.zustand.c] || C.txt;
        o.push(tx(370, 250, 'Kältekreis R290', {c: C.mute, s: 12, a: 'middle'}));
        o.push(tx(370, 276, esc(P.zustand.t) + (P.heizstab.an ? ' + Heizstab' : ''), {c: P.heizstab.an ? C.rot : zc, s: 18, b: true, a: 'middle'}));
        o.push(tx(370, 296, 'Quiet ' + f(W.quiet, 0) + ' · ' + (W.hc === 1 ? 'Efficiency' : (W.hc === 0 ? 'Comfort' : '–')), {c: C.mute, s: 12, a: 'middle'}));
        // Wasser: Vorlauf (rot) ueber den Heizstab zum Heizkoerper, Ruecklauf (blau) ueber die Pumpe zurueck
        var WA = P.pumpe;
        o.push(ln('544,150 780,150', C.vl, 6)); o.push(fliess('544,150 780,150', WA)); o.push(pfeil(700, 150, 'r', C.vl, 8));
        o.push(ln('780,270 544,270', C.rl, 6)); o.push(fliess('780,270 544,270', WA)); o.push(pfeil(700, 270, 'l', C.rl, 8));
        var hs = P.heizstab, hsC = hs.an ? C.rot : C.grau, zick = '';
        for (var xx = 588; xx < 612; xx += 6) { zick += (xx === 588 ? 'M' : 'L') + xx + ',' + (xx % 12 === 0 ? 145 : 155) + ' '; }
        o.push('<rect x="584" y="140" width="32" height="20" rx="3" style="fill:' + (hs.an ? '#ffebee' : '#eceff1') + ';stroke:' + hsC + ';stroke-width:2"/><path d="' + zick + 'L612,150" style="fill:none;stroke:' + hsC + ';stroke-width:1.5"/>');
        o.push(tx(600, 116, 'Heizstab', {c: C.mute, s: 12, a: 'middle'}));
        o.push(tx(600, 132, hs.an ? 'AN' : (hs.frei === 0 ? 'gesperrt' : (hs.frei === 1 ? 'aus · frei' : 'aus')), {c: hs.an ? C.rot : C.txt, s: 13, b: hs.an, a: 'middle'}));
        var puC = WA ? C.ok : C.grau;
        o.push('<circle cx="600" cy="270" r="16" style="fill:' + (WA ? '#e8f5e9' : '#ffffff') + ';stroke:' + puC + ';stroke-width:2.5"/>' + pfeil(598, 270, 'l', puC, 8));
        o.push(tx(558, 302, 'Pumpe', {c: C.mute, s: 12}));
        o.push(tx(558, 319, f(W.pumpU, 0, 'U/min'), {s: 13}));
        o.push(tx(558, 336, f(W.flow, 1, 'l/min'), {s: 13}));
        o.push(tx(558, 353, 'Duty ' + f(W.duty, 0), {s: 13}));
        o.push(tx(558, 370, 'Druck ' + f(W.druck, 2, 'bar'), {s: 13}));
        o.push(tx(730, 118, 'Vorlauf', {c: C.mute, s: 12, a: 'middle'}));
        o.push(tx(730, 140, t(W.vl), {c: C.vlT, s: 18, b: true, a: 'middle'}));
        o.push(tx(730, 296, 'Rücklauf', {c: C.mute, s: 12, a: 'middle'}));
        o.push(tx(730, 318, t(W.rl), {c: C.rlT, s: 18, b: true, a: 'middle'}));
        // Heizkoerper Zone 1
        var rip = ''; for (var rx = 794; rx <= 858; rx += 12) { rip += '<line x1="' + rx + '" y1="148" x2="' + rx + '" y2="272" style="stroke:#90a4ae;stroke-width:1.5"/>'; }
        o.push('<rect x="780" y="138" width="92" height="144" rx="6" style="fill:url(#osch_hk);stroke:' + C.grau + ';stroke-width:2"/>' + rip);
        o.push(tx(826, 126, 'Heizkörper Zone 1', {c: C.mute, s: 12, a: 'middle'}));
        o.push(tx(780, 306, 'Soll ' + t(W.soll), {s: 14}));
        o.push(tx(780, 324, 'Verschiebung ' + sg(W.shift, 'K'), {s: 13}));
        o.push('</svg>');
        return o.join('');
    }

    function kachel(k, v, s, cls, tip) {
        return '<div class="tile' + (cls ? ' ' + cls : '') + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + (s || '&nbsp;') + '</div></div>';
    }
    function html(P, opt) {
        if (!P || !P.w) { return '<div class="osch-leer">Noch keine Werte der Wärmepumpe.</div>'; }
        opt = opt || {};
        var W = P.w, ph = Number(opt.phase) || 0;
        var lzeit = P.lauf ? f(W.laufMin, 0, 'min') : f(W.letzteMin, 0, 'min');
        var hs = P.heizstab;
        var k = [
            kachel('Abgabe', P.lauf ? f(ok(W.pth) ? W.pth / 1000 : null, 2, 'kW') : '–', P.lauf ? 'Wärme (HeishaMon)' : 'Verdichter steht', '', 'Heat_Power_Production_Extra'),
            kachel('Aufnahme', f(W.pelK, 0, 'W'), P.lauf ? '(intern ' + f(W.pel, 0) + ' +' + f(W.korr, 0) + ')' : 'Stillstand, roh', '', 'Heat_Power_Consumption_Extra; im Lauf + ' + W.korrW + ' W (TOP16 untertreibt, Forum 189605)'),
            kachel('COP', f(W.cop, 2), 'Wärme / Aufnahme', '', 'Abgabe geteilt durch die korrigierte Aufnahme'),
            kachel('Spreizung', ok(W.spreiz) ? dez(W.spreiz, 1) + ' K' : '–', 'VL ' + t(W.vl) + ' · RL ' + t(W.rl)),
            kachel('Zustand', esc(P.zustand.t) + (hs.an ? ' + Heizstab' : ''), P.fehler ? 'Fehler ' + esc(P.fehler) : ('Außen ' + t(W.at) + ' · Grenze ' + t(W.grenze)), 'z-' + P.zustand.c + (hs.an ? ' z-hs' : '')),
            kachel('Modus', W.hc === 1 ? 'Efficiency' : (W.hc === 0 ? 'Comfort' : '–'), 'Heizregelung'),
            kachel('Quiet', f(W.quiet, 0), 'Stufe 0–3'),
            kachel('Laufzeit', lzeit, (P.lauf ? 'jetziger Lauf' : 'letzter Lauf') + ' · ' + f(W.startsHeute, 0) + ' Starts heute'),
            kachel('Betrieb', f(W.betrH, 0, 'h'), f(W.betrN, 0) + ' Starts gesamt')
        ];
        var foot = ['Wasserdruck <b>' + f(W.druck, 2, 'bar') + '</b>', 'Heizgrenze <b>' + t(W.grenze) + '</b>',
                    'Heizstab <b>' + (hs.an ? 'AN' : (hs.frei === 0 ? 'gesperrt' : (hs.frei === 1 ? 'aus, freigegeben' : 'aus'))) + '</b>' + (ok(hs.h) ? ' · ' + f(hs.h, 0, 'h') : ''),
                    'Fehler <b' + (P.fehler ? ' class="warn"' : '') + '>' + (P.fehler ? esc(P.fehler) : 'keiner') + '</b>'];
        var stand = P.veraltet ? '<div class="osch-alt">Keine aktuellen Werte' + (ok(P.alter) ? ' (letzter vor ' + Math.round(P.alter) + ' min)' : '') + '</div>' : '';
        return '<div class="osch" style="--osch-d:-' + (ph % 1.2).toFixed(2) + 's;--osch-r:-' + (ph % 2.4).toFixed(2) + 's">' + kopfZeile(P) +
               '<div class="osch-svg">' + svg(P) + '</div><div class="osch-side">' + stand + '<div class="osch-kpi">' + k.join('') + '</div>' +
               '<div class="osch-foot">' + foot.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div></div></div>';
    }
    function sigOf(P) { return JSON.stringify(P, function (key, val) { return key === 'ts' || key === 'alter' ? undefined : val; }) + (P && P.veraltet ? Math.round(P.alter || 0) : ''); }
    function mount(el, P) {
        if (!el) { return; }
        var sig = sigOf(P);
        if (el.__osch === sig) { return; }
        el.__osch = sig;
        el.innerHTML = html(P, {phase: Date.now() / 1000});
    }
    // Kopfzeile wie Lambda: Fuehler-Aussentemperatur, daneben Pfeil und die Temperatur, nach der die Vorhersage rechnet (Fuehler - Bedarfsaenderung aus dem Wetter)
    function tA(x) { return ok(x) ? (x > 0 ? '+' : '') + t(x) : '–'; }                                // Aussentemperatur mit Vorzeichen (+11 °C, −13 °C)
    function kopfZeile(P) {
        var K = P.kopf || {}, at = ok(K.at) ? K.at : P.w.at, fen = (ok(K.von) && ok(K.bis)) ? K.von + '–' + K.bis + '\u00a0h' : '';
        var h = '<span class="k">Außentemperatur</span><b class="at" title="Fühler (Outside_Temp)">' + t(at) + '</b>';
        if (ok(K.mat)) {
            h += '<span class="arr">→</span><b class="mat" title="' + esc('Fühler ' + (K.dk > 0 ? '− ' : '+ ') + dez(Math.abs(K.dk), 1) + ' K: erwartete Bedarfsänderung aus der Wettervorhersage' + (fen ? ' (+' + fen + ')' : '') +
                 ', ohne den gewohnten Tagesgang, als Außentemperatur (Entscheidungsmaschine)') + '">' + t(K.mat) + '</b><span class="s">(Prognose' + (fen ? ' ' + fen : '') + ')</span>';
        }
        if (ok(K.owm)) { h += '<span class="owm" title="OpenWeatherMap, aktuell">OWM ' + t(K.owm) + '</span>'; }
        return '<div class="osch-kopf">' + h + '</div>';
    }
    // ---------------------------------------------------------------- Modulkacheln (Übersicht, Vorlage opt_t_module), Lambda-Stil: links Werte, rechts Zustaende
    var BETRIEBSART = ['Nur Heizen', 'Nur Kühlen', 'Auto (Heizen)', 'Nur Warmwasser', 'Heizen+WW', 'Kühlen+WW', 'Auto (Heizen)+WW', 'Auto (Kühlen)', 'Auto (Kühlen)+WW'];   // TOP4, wie der Kern-Flow
    function chip(tx0, c, tip) { return '<span class="omod-ch omod-' + c + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + tx0 + '</span>'; }
    function zeile(k, v, tip) { return '<dt' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + k + '</dt><dd>' + v + '</dd>'; }
    function kachelM(titel, links, rechts) { return '<div class="omod-k"><div class="omod-t">' + titel + '</div><div class="omod-b"><dl class="omod-l">' + links.join('') + '</dl><div class="omod-r">' + rechts.join('') + '</div></div></div>'; }
    function modul(P) {
        if (!P || !P.w) { return '<div class="osch-leer">Noch keine Werte der Wärmepumpe.</div>'; }
        var W = P.w, z = (P.zustand && P.zustand.c) || 'unbekannt', hs = P.heizstab || {}, H = P.hk || {}, K = H.kurve;
        // Anforderung aus dem Zustand des Schemas (einzige Quelle): Waermepumpe wie im Schema, Heizkreis nach Lambda (Soll 0 = keine Anforderung: Standby)
        var zw = {lauf: ['Heizen', 'ok'], pause: ['Pause', 'mute'], heizgrenze: ['Heizgrenze', 'warn'], abtauen: ['Abtauen', 'kalt'], aus: ['Aus', 'mute'], stoerung: ['Störung', 'bad']}[z] || ['–', 'mute'];
        var zh = {lauf: ['Anforderung', 'ok'], abtauen: ['Anforderung', 'ok'], pause: ['Standby', 'mute'], heizgrenze: ['Standby', 'mute'], aus: ['Aus', 'mute'], stoerung: ['Störung', 'bad']}[z] || ['–', 'mute'];
        var wp = kachelM('Wärmepumpe', [
            zeile('Soll-Vorlauf', t(W.soll)),
            zeile('Vorlauf / Rücklauf', t(W.vl) + ' / ' + t(W.rl)),
            zeile('Abgabe thermisch', P.lauf ? f(ok(W.pth) ? W.pth / 1000 : null, 2, 'kW') : '–', 'Heat_Power_Production_Extra'),
            zeile('Aufnahme elektrisch', f(ok(W.pelK) ? W.pelK / 1000 : null, 2, 'kW'), 'Heat_Power_Consumption_Extra' + (P.lauf ? ' + ' + W.korrW + ' W (TOP16 untertreibt, Forum 189605)' : ', Stillstand roh')),
            zeile('COP', f(W.cop, 2), 'Wärme / korrigierte Aufnahme'),
            zeile('Betrieb', f(W.betrH, 0, 'h') + ' · ' + f(W.betrN, 0) + ' Starts'),
            zeile('Starts heute', f(W.startsHeute, 0))
        ], [chip(zw[0] + (z === 'stoerung' && P.fehler ? ' ' + esc(P.fehler) : ''), zw[1]), chip('Quiet ' + f(W.quiet, 0), ok(W.quiet) && W.quiet > 0 ? 'act' : 'mute', 'Quiet_Mode_Level 0–3'),
            chip(W.hc === 1 ? 'Efficiency' : (W.hc === 0 ? 'Comfort' : 'Heizregelung –'), 'mute', 'Heating_Control')].concat(hs.an ? [chip('Heizstab an', 'bad')] : []));
        var hk = kachelM('Heizkreis Zone 1', [
            zeile('Heizkurve', K ? t(K.vlKalt) + ' bei ' + tA(K.atKalt) + ' … ' + t(K.vlWarm) + ' bei ' + tA(K.atWarm) : '–', 'Z1_Heat_Curve_*'),
            zeile('Verschiebung', W.shift === 0 ? 'keine' : sg(W.shift, 'K'), 'Z1_Heat_Request_Temp'),
            zeile('Heizgrenze', t(W.grenze), 'Heating_Off_Outdoor_Temp'),
            zeile('Betriebsart', ok(H.ba) && BETRIEBSART[H.ba] ? BETRIEBSART[H.ba] : '–', 'Operating_Mode_State')
        ], [chip(zh[0], zh[1]), chip('Zeitplan ' + (H.plan === 1 ? 'an' : (H.plan === 0 ? 'aus' : '–')), H.plan === 1 ? 'act' : 'mute', 'Main_Schedule_State'),
            chip('Ferien ' + (H.ferien === 1 ? 'an' : (H.ferien === 0 ? 'aus' : '–')), H.ferien === 1 ? 'warn' : 'mute', 'Holiday_Mode_State')]);
        var stand = P.veraltet ? '<div class="osch-alt">Keine aktuellen Werte' + (ok(P.alter) ? ' (letzter vor ' + Math.round(P.alter) + ' min)' : '') + '</div>' : '';
        return stand + '<div class="omod">' + wp + hk + '</div>';
    }
    function modulMount(el, P) {
        if (!el) { return; }
        var sig = sigOf(P);
        if (el.__omod === sig) { return; }
        el.__omod = sig;
        el.innerHTML = modul(P);
    }
    // Stil (nur fuer die beiden Schema-Vorlagen; Grundschrift/Farben kommen aus tools/ui_optik.css)
    var CSS = '.osch{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:flex-start}' +
        '.osch-svg{flex:1 1 860px;max-width:1040px;min-width:0}.osch-svg svg{display:block;width:100%;height:auto;overflow:visible}' +
        '.osch-side{flex:1 1 300px;min-width:0}' +
        '.osch-kpi{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}' +
        '.osch .tile{border:1px solid #e0e6e9;border-radius:8px;padding:8px 10px;background:#f7f9fa;min-width:0}' +
        '.osch .tile .k{font-size:12px;color:#546e7a;line-height:1.3}' +
        '.osch .tile .v{font-size:20px;font-weight:600;color:#263238;white-space:nowrap;line-height:1.35}' +
        '.osch .tile .s{font-size:12.5px;color:#546e7a;line-height:1.35;overflow-wrap:anywhere}' +
        '.osch .z-lauf .v{color:#2e7d32}.osch .z-stoerung .v,.osch .z-hs .v{color:#c62828}.osch .z-abtauen .v{color:#00727f}.osch .z-heizgrenze .v{color:#b45309}' +
        '.osch-foot{margin-top:8px;font-size:12.5px;color:#546e7a;display:flex;flex-wrap:wrap;gap:4px 18px}.osch-foot b{font-weight:600;color:#263238}.osch-foot b.warn{color:#c62828}' +
        '.osch-alt{margin-bottom:8px;padding:6px 10px;border-radius:6px;background:#fff4e5;color:#8a4b00;font-size:13px;font-weight:600}' +
        '.osch-leer{border:1px dashed #b0bec5;border-radius:8px;padding:10px 12px;color:#546e7a;font-size:13px}' +
        '.osch-fl{animation:osch-fl 1.2s linear infinite;animation-delay:var(--osch-d,0s)}@keyframes osch-fl{to{stroke-dashoffset:-36}}' +
        '.osch-rot{animation:osch-rot 2.4s linear infinite;animation-delay:var(--osch-r,0s);transform-box:fill-box;transform-origin:center}@keyframes osch-rot{to{transform:rotate(360deg)}}' +
        '@media (prefers-reduced-motion:reduce){.osch-fl,.osch-rot{animation:none}}' +
        '.osch-kopf{flex:1 1 100%;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;color:#546e7a;font-size:14px}' +
        '.osch-kopf b{font-size:20px;font-weight:600;line-height:1.3}.osch-kopf .at{color:#00727f}.osch-kopf .mat{color:#263238}.osch-kopf .arr{font-size:20px;color:#263238}' +
        '.osch-kopf .s{font-size:12.5px}.osch-kopf .owm{margin-left:10px;font-size:12.5px}' +
        '.omod{display:grid;grid-template-columns:repeat(2,minmax(0,640px));gap:12px}' +
        '.omod-k{border:1px solid #e0e6e9;border-radius:8px;background:#f7f9fa;padding:10px 12px;min-width:0}' +
        '.omod-t{font-size:16px;font-weight:600;color:#263238;line-height:1.3;margin:0 0 8px;padding-left:8px;border-left:4px solid #0094ce}' +
        '.omod-b{display:flex;gap:12px;align-items:flex-start}' +
        '.omod-l{flex:1 1 auto;min-width:0;margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 14px}' +
        '.omod-l dt{color:#546e7a;margin:0}.omod-l dd{margin:0;font-weight:600;overflow-wrap:break-word;min-width:0}' +
        '.omod-r{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px}' +
        '.omod-ch{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12.5px;line-height:19px;font-weight:500;white-space:nowrap;background:#eceff1;color:#455a64}' +
        '.omod-r .omod-ch:first-child{font-size:14px;font-weight:600;padding:3px 12px}' +
        '.omod-ok{background:#e6f4ea;color:#1b5e20}.omod-warn{background:#fff3e0;color:#8a4b00}.omod-bad{background:#fdecea;color:#b71c1c}' +
        '.omod-kalt{background:#e0f7fa;color:#00626d}.omod-act{background:#007bb0;color:#fff}.omod-mute{background:#eceff1;color:#455a64}';
    var S = {v: VER, daten: daten, html: html, svg: svg, mount: mount, modul: modul, modulMount: modulMount, CSS: CSS, fmt: {f: f, t: t, sg: sg}};
    if (typeof window !== 'undefined') { window.optSchema = S; }
    return S;
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = OPTSCHEMA; }

/* Trend 24 h (UI-Lambda Teil 2, 14.10.2026; Vorbild: Trenddaten des Lambda-Reglers). Reine Funktionen, vom Generator (tools/optimizer_phase1.py) eingebettet:
 * Puffer im Function-Knoten opt_trend, Bedienung und Zeichnung (mit tools/ui_chart.js) in der Vorlage opt_t_trend (Seite "Auswertung"); geprueft in
 * tools/optimizer_sim.js, statisch gerendert in tools/opt_seiten_vorschau.js. NUR LESEN: liest OPT_hp/OPT_rooms/OPT_engine/OPT_weather, schreibt nichts an die Anlage.
 *   OPTTREND.katalog(rooms)              -> waehlbare Kanaele [{k, n (Name), u (Einheit), g (Gruppe), dg, st (Stufen)}], Raeume aus OPT_cfg.rooms
 *   OPTTREND.werte(HP, X, korrW, now)    -> {Kanal: Wert|null} dieser Minute (HeishaMon -128/-127/-78/-200 und Werte aelter als 15 min = null)
 *   OPTTREND.neu() / eintragen(B, w, now) -> Ringpuffer 24 h x 1 min: B = {n: 1440, m: [Minute je Platz], k: {Kanal: [Wert x 100 gerundet | null]}}
 *   OPTTREND.auszug(B, keys, kat, now)   -> {t1 (Minute), n, k: {Kanal: [aelteste ... neueste]}} fuer eine Karte (hoechstens 8 Kanaele)
 *   OPTTREND.letzte(B, now)              -> {Kanal: Wert} der neuesten Minute (Minutentakt an alle Karten)
 *   OPTTREND.sichern(B) / laden(o, now)  -> Puffer als JSON-Objekt (Datei /data/optimizer/trend-puffer.json) und zurueck (nur Minuten der letzten 24 h)
 *   OPTTREND.spec(kat, cache, sel, zoomH) -> Diagramm fuer optChart (bis 4 Kanaele, links °C, rechts die naechste Einheit, weitere Einheiten im zweiten Feld)
 *   OPTTREND.mount(el, P, scope)          -> Karte: 4 Auswahlfelder mit fester Farbe, Zeitbereich 24/12/6/2 h, Legende mit aktuellem Wert, Diagramm mit Tageslinie
 * Die Karte fragt ihre Kanaele selbst an (scope.send {topic: 'trend', payload: {id, keys}}); opt_trend antwortet nur dieser Karte (id, socketid) und schickt
 * jede Minute die neuesten Werte aller Kanaele an alle (art 'neu'). Auswahl und Zeitbereich merkt sich der Browser (localStorage, ohne Fehler, wenn gesperrt). */
var OPTTREND = (function () {
    var VER = 1, MIN = 60000, N = 1440, FEHLT = [-128, -127, -78, -200], ALT_MIN = 15, MAX_KEYS = 8;
    var FARBEN = ['#37474f', '#d32f2f', '#1976d2', '#00897b'];                                           // feste Farbe je Auswahlfeld (Kontrast >= 3:1 auf Weiss)
    var VOR = ['Outside_Temp', 'Main_Outlet_Temp', 'Main_Inlet_Temp', 'Compressor_Freq'];
    var ZOOM = [24, 12, 6, 2], LS = 'optTrend.v1';
    var BASIS = [
        ['Outside_Temp', 'Außentemperatur', '°C', 'Temperaturen', 1], ['at_mod', 'Außentemperatur modifiziert', '°C', 'Temperaturen', 1], ['at_owm', 'Außentemperatur Wetterdienst', '°C', 'Temperaturen', 1],
        ['Main_Outlet_Temp', 'Vorlauf', '°C', 'Temperaturen', 1], ['Main_Inlet_Temp', 'Rücklauf', '°C', 'Temperaturen', 1], ['Main_Target_Temp', 'Soll-Vorlauf', '°C', 'Temperaturen', 1, 1],
        ['Main_Hex_Outlet_Temp', 'Wärmetauscher-Austritt', '°C', 'Temperaturen', 1],
        ['Compressor_Freq', 'Verdichter', 'Hz', 'Kältekreis', 0], ['Compressor_Current', 'Verdichterstrom', 'A', 'Kältekreis', 1], ['Discharge_Temp', 'Heißgas', '°C', 'Kältekreis', 0],
        ['Outside_Pipe_Temp', 'Rohr außen', '°C', 'Kältekreis', 0], ['Eva_Outlet_Temp', 'Verdampfer-Austritt', '°C', 'Kältekreis', 0], ['Inside_Pipe_Temp', 'Rohr innen', '°C', 'Kältekreis', 0],
        ['High_Pressure', 'Hochdruck', 'kgf/cm²', 'Kältekreis', 1], ['Expansion_Valve', 'Expansionsventil', 'Schritte', 'Kältekreis', 0], ['Fan1_Motor_Speed', 'Ventilator', 'U/min', 'Kältekreis', 0],
        ['Heat_Power_Production', 'Wärmeleistung', 'W', 'Leistung und Wasser', 0], ['Heat_Power_Consumption', 'Leistungsaufnahme', 'W', 'Leistung und Wasser', 0],
        ['Pump_Flow', 'Durchfluss', 'l/min', 'Leistung und Wasser', 1], ['Pump_Speed', 'Pumpendrehzahl', 'U/min', 'Leistung und Wasser', 0], ['Water_Pressure', 'Wasserdruck', 'bar', 'Leistung und Wasser', 2],
        ['Quiet_Mode_Level', 'Quiet-Stufe', 'Stufe', 'Zustände', 0, 1], ['Heating_Control', 'Heizregelung Efficiency', 'an/aus', 'Zustände', 0, 1], ['Defrosting_State', 'Abtauen', 'an/aus', 'Zustände', 0, 1],
        ['Internal_Heater_State', 'Heizstab an', 'an/aus', 'Zustände', 0, 1], ['Room_Heater_State', 'Heizstab freigegeben', 'an/aus', 'Zustände', 0, 1],
        ['Z1_Heat_Request_Temp', 'Verschiebung Heizkurve', 'K', 'Zustände', 0, 1]];
    function num(x) { if (x === null || x === undefined || x === '' || typeof x === 'boolean') { return null; } x = Number(x); return isFinite(x) ? x : null; }
    function katalog(rooms) {
        var out = BASIS.map(function (b) { return {k: b[0], n: b[1], u: b[2], g: b[3], dg: b[4], st: b[5] ? 1 : 0}; });
        (rooms || []).forEach(function (r) { if (r && r.id) { out.push({k: 'raum_' + r.id, n: String(r.name || r.id), u: '°C', g: 'Räume', dg: 1, st: 0}); } });
        return out;
    }
    // ---------------------------------------------------------------- Werte dieser Minute (X = {vs (OPT_engine.vs mit ts), owm {t, ts}, rooms (OPT_rooms), cfgRooms})
    function werte(HP, X, korrW, now) {
        HP = HP || {}; X = X || {};
        var kw = num(korrW) !== null ? num(korrW) : 80, w = {};
        function v(n) { var e = HP[n]; if (!e || typeof e !== 'object') { return null; } var x = num(e.v); if (x === null || FEHLT.indexOf(x) >= 0 || (typeof e.ts === 'number' && now - e.ts > ALT_MIN * MIN)) { return null; } return x; }
        BASIS.forEach(function (b) { if (b[0] !== 'at_mod' && b[0] !== 'at_owm') { w[b[0]] = v(b[0]); } });
        var px = v('Heat_Power_Production_Extra'), pb = w.Heat_Power_Production;                           // die Leisha meldet die Leistungen in den _Extra-Werten (Basiswert -200)
        w.Heat_Power_Production = (px !== null && px > -30000 && px < 30000) ? px : (pb !== null && pb >= 0 ? pb : null);
        var cx = v('Heat_Power_Consumption_Extra'), cb = w.Heat_Power_Consumption, pel = (cx !== null && cx > -30000 && cx < 30000) ? cx : (cb !== null && cb >= 0 ? cb : null);
        w.Heat_Power_Consumption = pel === null ? null : pel + ((w.Compressor_Freq || 0) > 0 ? kw : 0);  // COP-Korrektur im Lauf wie ueberall im Optimierer
        var at = w.Outside_Temp, vs = X.vs;
        w.at_mod = null;
        if (at !== null && vs && num(vs.dk) !== null && typeof vs.ts === 'number' && now - vs.ts <= 5 * MIN && now >= vs.ts - MIN) {
            var pA = num(vs.age), pM = num(vs.maxMin);
            if (pA !== null && pA + (now - vs.ts) / MIN <= (pM !== null ? pM : 120)) { w.at_mod = Math.round((at - num(vs.dk)) * 10) / 10; }
        }
        w.at_owm = (X.owm && num(X.owm.t) !== null && typeof X.owm.ts === 'number' && now - X.owm.ts <= 120 * MIN) ? num(X.owm.t) : null;
        var R = X.rooms || {};
        (X.cfgRooms || []).forEach(function (r) {
            var e = r && R[r.id], lim = (num(r.maxAgeMin) || 90) * MIN;
            w['raum_' + r.id] = (e && num(e.last) !== null && typeof e.ts === 'number' && now - e.ts <= lim) ? num(e.last) : null;
        });
        return w;
    }
    // ---------------------------------------------------------------- Ringpuffer
    function neu() { var m = []; for (var i = 0; i < N; i++) { m.push(null); } return {v: VER, n: N, m: m, k: {}}; }
    function leer() { var a = []; for (var i = 0; i < N; i++) { a.push(null); } return a; }
    function eintragen(B, w, now) {
        var mi = Math.floor(now / MIN), s = mi % B.n;
        B.m[s] = mi;
        Object.keys(w).forEach(function (k) { if (!B.k[k]) { B.k[k] = leer(); } });
        Object.keys(B.k).forEach(function (k) { var x = w[k]; B.k[k][s] = (x === null || x === undefined || !isFinite(x)) ? null : Math.round(x * 100); });
        return B;
    }
    function auszug(B, keys, kat, now) {
        var t1 = Math.floor(now / MIN), ok = {}, out = {};
        (kat || []).forEach(function (c) { ok[c.k] = 1; });
        (Array.isArray(keys) ? keys : []).filter(function (k) { return typeof k === 'string' && ok[k]; }).slice(0, MAX_KEYS).forEach(function (k) {
            var src = B && B.k[k], a = [];
            for (var i = 0; i < N; i++) { var mi = t1 - N + 1 + i, s = mi % N; a.push(src && B.m[s] === mi && src[s] !== null ? src[s] / 100 : null); }
            out[k] = a;
        });
        return {t1: t1, n: N, k: out};
    }
    function letzte(B, now) {
        var mi = Math.floor(now / MIN), s = mi % B.n, o = {};
        Object.keys(B.k).forEach(function (k) { o[k] = B.m[s] === mi && B.k[k][s] !== null ? B.k[k][s] / 100 : null; });
        return o;
    }
    function sichern(B) { return {v: VER, n: B.n, m: B.m, k: B.k}; }
    function laden(o, now) {
        if (!o || o.v !== VER || o.n !== N || !Array.isArray(o.m) || o.m.length !== N || !o.k || typeof o.k !== 'object') { return null; }
        var B = neu(), t1 = Math.floor(now / MIN);
        Object.keys(o.k).forEach(function (k) { if (Array.isArray(o.k[k]) && o.k[k].length === N) { B.k[k] = leer(); } });
        for (var s = 0; s < N; s++) {
            var mi = o.m[s];
            if (typeof mi !== 'number' || mi > t1 || mi <= t1 - N || mi % N !== s) { continue; }
            B.m[s] = mi;
            Object.keys(B.k).forEach(function (k) { var x = o.k[k][s]; B.k[k][s] = (typeof x === 'number' && isFinite(x)) ? Math.round(x) : null; });
        }
        return B;
    }

    // ---------------------------------------------------------------- Diagramm (Browser und Tests)
    function fz(v, dg) { return v === null || v === undefined ? '–' : (Math.round(v * Math.pow(10, dg)) / Math.pow(10, dg)).toFixed(dg).replace('.', ',').replace('-', '−'); }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function kanal(kat, k) { for (var i = 0; i < (kat || []).length; i++) { if (kat[i].k === k) { return kat[i]; } } return null; }
    function aktuell(a) { for (var i = (a || []).length - 1; i >= 0; i--) { if (a[i] !== null && a[i] !== undefined) { return {v: a[i], i: i}; } } return null; }
    function spec(kat, C, sel, zoomH) {
        var t1 = (C.t1 + 1) * MIN, t0 = t1 - zoomH * 3600000, used = [];
        (sel || []).forEach(function (k, i) { var c = k && kanal(kat, k); if (c) { used.push({c: c, i: i}); } });
        var units = [];                                                                                   // Einheiten: °C zuerst (linke Achse), dann in Auswahlreihenfolge
        used.forEach(function (x) { if (x.c.u === '°C' && units.indexOf('°C') < 0) { units.unshift('°C'); } });
        used.forEach(function (x) { if (units.indexOf(x.c.u) < 0) { units.push(x.c.u); } });
        var nP = units.length > 2 ? 2 : 1, panels = [];
        for (var p = 0; p < nP; p++) {
            var uL = units[2 * p], uR = units[2 * p + 1] || null, temp = uL === '°C';
            panels.push({h: nP === 1 ? 270 : (p === 0 ? 180 : 110), unit: uL, runit: uR || undefined, zero: !temp, rzero: true, series: []});
        }
        used.forEach(function (x) {
            var ui = units.indexOf(x.c.u), pn = panels[Math.floor(ui / 2)], r = ui % 2 === 1, a = (C.k && C.k[x.c.k]) || [], d = [], n = a.length, start = (C.t1 - n + 1) * MIN;
            for (var j = 0; j < n; j++) { var t = start + j * MIN; if (t >= t0 - MIN) { d.push([t, a[j]]); } }
            pn.series.push({n: x.c.n, c: FARBEN[x.i], k: x.c.st ? 'step' : 'line', w: 1.7, r: r, dg: x.c.dg, u: x.c.u === 'an/aus' || x.c.u === 'Stufe' ? '' : x.c.u, d: d});
        });
        panels.forEach(function (pn) { if (pn.unit === 'an/aus') { pn.min = 0; pn.max = 1; } if (pn.runit === 'an/aus') { pn.rmin = 0; pn.rmax = 1; } });     // Schaltzustaende: Achse 0 … 1
        var marks = [], m0 = new Date(t1); m0 = new Date(m0.getFullYear(), m0.getMonth(), m0.getDate()).getTime();
        if (m0 > t0 && m0 < t1) { marks.push({t: m0, c: '#000000', solid: true, w: 1.5, l: 'gestern', label: 'heute'}); }
        return {t0: t0, t1: t1, legend: false, marks: marks, panels: panels.length ? panels : [{h: 270, unit: '', series: []}]};
    }
    // ---------------------------------------------------------------- Karte
    function speicherLesen() { try { var o = JSON.parse(window.localStorage.getItem(LS) || 'null'); if (o && Array.isArray(o.k) && o.k.length === 4) { return o; } } catch (e) { /* gesperrt */ } return null; }
    function speichern(st) { try { window.localStorage.setItem(LS, JSON.stringify({k: st.sel, z: st.zoom})); } catch (e) { /* gesperrt: Auswahl gilt nur bis zum Neuladen */ } }
    function mount(el, P, scope) {
        if (!el) { return; }
        var st = el.__ot;
        if (!st) {
            var sv = speicherLesen();
            st = el.__ot = {id: 't' + Math.random().toString(36).slice(2, 10), sel: sv ? sv.k.slice() : VOR.slice(), zoom: sv && ZOOM.indexOf(sv.z) >= 0 ? sv.z : 24, C: null, kat: null, sig: '', req: 0};
        }
        if (scope) { st.scope = scope; }
        if (P && Array.isArray(P.kat)) { st.kat = P.kat; }
        if (P && P.art === 'daten' && P.k && (P.id === null || P.id === undefined || P.id === st.id)) {
            if (!st.C || st.C.t1 !== P.t1) { st.C = {t1: P.t1, k: {}}; }
            Object.keys(P.k).forEach(function (k) { st.C.k[k] = P.k[k].slice(); });
        } else if (P && P.art === 'neu' && st.C && P.v) {
            if (P.t1 === st.C.t1 + 1) { Object.keys(st.C.k).forEach(function (k) { var a = st.C.k[k]; a.push(P.v[k] === undefined ? null : P.v[k]); a.shift(); }); st.C.t1 = P.t1; }
            else if (P.t1 > st.C.t1 + 1) { st.C = null; }
        }
        if (!st.kat) { el.innerHTML = '<div class="optch-leer">Noch keine Verlaufsdaten.</div>'; return; }
        st.sel = st.sel.map(function (k) { return k && kanal(st.kat, k) ? k : ''; });
        bedienung(el, st);
        anfragen(st);
        zeichnen(el, st);
    }
    function anfragen(st) {
        var fehlt = st.sel.filter(function (k) { return k && !(st.C && st.C.k[k]); });
        var keys = st.C ? fehlt : st.sel.filter(Boolean), rk = (st.C ? st.C.t1 : 'x') + ':' + keys.join();
        if (!fehlt.length || !st.scope || typeof st.scope.send !== 'function' || (rk === st.rk && Date.now() - st.req < 3000)) { return; }        // dieselbe Anfrage hoechstens alle 3 s
        st.req = Date.now(); st.rk = rk;
        try { st.scope.send({topic: 'trend', payload: {id: st.id, keys: keys}}); } catch (e) { /* naechster Versuch mit der naechsten Nachricht */ }
    }
    function bedienung(el, st) {
        var sig = st.kat.map(function (c) { return c.k + c.n; }).join('|');
        if (el.querySelector('.otr-sel') && st.sig === sig) { return; }                                  // Auswahlfelder nur neu bauen, wenn sich die Kanaele aendern (offene Liste bleibt offen)
        st.sig = sig;
        var gr = [];
        st.kat.forEach(function (c) { if (gr.indexOf(c.g) < 0) { gr.push(c.g); } });
        function opts(k) {
            return '<option value=""' + (k ? '' : ' selected') + '>(keiner)</option>' + gr.map(function (g) {
                return '<optgroup label="' + esc(g) + '">' + st.kat.filter(function (c) { return c.g === g; }).map(function (c) { return '<option value="' + esc(c.k) + '"' + (c.k === k ? ' selected' : '') + '>' + esc(c.n) + '</option>'; }).join('') + '</optgroup>';
            }).join('');
        }
        el.innerHTML = '<div class="otr"><div class="otr-bar"><div class="otr-sels">' + st.sel.map(function (k, i) {
            return '<label class="otr-sel"><span class="otr-sw" style="background:' + FARBEN[i] + '"></span><select data-i="' + i + '" aria-label="Messwert ' + (i + 1) + '">' + opts(k) + '</select></label>';
        }).join('') + '</div><div class="otr-zoom" role="group" aria-label="Zeitbereich">' + ZOOM.map(function (z) { return '<button type="button" data-z="' + z + '">' + z + ' h</button>'; }).join('') + '</div></div>' +
            '<div class="otr-leg"></div><div class="otr-ch"></div></div>';
        Array.prototype.forEach.call(el.querySelectorAll('select'), function (s) {
            s.addEventListener('change', function () { st.sel[+s.getAttribute('data-i')] = s.value; speichern(st); anfragen(st); zeichnen(el, st); });
        });
        Array.prototype.forEach.call(el.querySelectorAll('.otr-zoom button'), function (b) {
            b.addEventListener('click', function () { st.zoom = +b.getAttribute('data-z'); speichern(st); zeichnen(el, st); });
        });
    }
    function zeichnen(el, st) {
        Array.prototype.forEach.call(el.querySelectorAll('.otr-zoom button'), function (b) { var on = +b.getAttribute('data-z') === st.zoom; b.className = on ? 'on' : ''; b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
        var leg = el.querySelector('.otr-leg'), ch = el.querySelector('.otr-ch');
        if (!leg || !ch) { return; }
        leg.innerHTML = st.sel.map(function (k, i) {
            var c = k && kanal(st.kat, k); if (!c) { return ''; }
            var a = st.C && st.C.k[k], cur = aktuell(a), unit = c.u === 'an/aus' ? '' : (c.u === 'Stufe' ? '' : ' ' + c.u);
            var txt = cur ? (c.u === 'an/aus' ? (cur.v > 0 ? 'an' : 'aus') : fz(cur.v, c.dg) + unit) : '–';
            return '<span class="otr-li"><span class="otr-sw" style="background:' + FARBEN[i] + '"></span>' + esc(c.n) + ' <b>' + esc(txt) + '</b></span>';
        }).join('');
        if (!st.C) { ch.innerHTML = '<div class="optch-leer">Verlauf wird geladen …</div>'; return; }
        if (!st.sel.some(Boolean)) { ch.innerHTML = '<div class="optch-leer">Kein Messwert gewählt.</div>'; return; }
        if (typeof window !== 'undefined' && window.optChart) { window.optChart.mount(ch, spec(st.kat, st.C, st.sel, st.zoom)); st.w = ch.clientWidth; }
        if (!st.ro && typeof window !== 'undefined' && window.ResizeObserver) {                         // Breite der Karte aendert sich (Layout des Dashboards): neu zeichnen
            try { st.ro = new window.ResizeObserver(function () { var c = el.querySelector('.otr-ch'); if (c && st.C && Math.abs(c.clientWidth - (st.w || 0)) > 2) { zeichnen(el, st); } }); st.ro.observe(el); } catch (e) { st.ro = true; }
        }
    }
    var T = {v: VER, N: N, FARBEN: FARBEN, VOR: VOR, ZOOM: ZOOM, katalog: katalog, werte: werte, neu: neu, eintragen: eintragen, auszug: auszug, letzte: letzte, sichern: sichern, laden: laden,
             spec: spec, mount: mount, fz: fz};
    if (typeof window !== 'undefined') { window.optTrend = T; }
    return T;
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = OPTTREND; }

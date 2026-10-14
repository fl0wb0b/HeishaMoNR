/* Statistik Wärmepumpe (UI-Lambda Teil 2, 14.10.2026; Vorbild: Statistikseite des Lambda-WP-Moduls). Reine Funktionen, vom Generator (tools/optimizer_phase1.py)
 * eingebettet: Tageswerte, Kern-Archiv und Nutzlast im Function-Knoten opt_stat, html()/mount() in der Vorlage opt_t_stat (Seite "Effizienz"); geprueft in
 * tools/optimizer_sim.js, statisch gerendert in tools/opt_seiten_vorschau.js. NUR LESEN: schreibt nichts an die Waermepumpe und nichts in Kern-Variablen.
 *   OPTSTAT.neu()                         -> leerer Zustand (global OPT_stat): {tage, dat (Leseposition je Datei), lz (letzte Zeile), ab (laufende Abtauung), archiv}
 *   OPTSTAT.datei(S, fs, pfad, korrW)     -> liest das Minutenprotokoll quiet-YYYY-MM.csv des Optimierers AB der letzten Position (nur neue Zeilen) und zaehlt weiter
 *   OPTSTAT.text(S, text, korrW, key)     -> dasselbe fuer einen Text (Tests)
 *   OPTSTAT.kern(A, K, now)               -> Kern-Zaehler (nur lesen) ins Archiv A: kwh_HEAT_31d (Strom je Tag), HEAT_Prod_24m (Waerme je Monat), COP_HEAT_24m;
 *                                            Waerme je Tag = Differenz des Monatszaehlers (Stand zu Tagesbeginn festgehalten), keine zweite Zaehlung
 *   OPTSTAT.daten(S, X, opt, now)         -> Nutzlast der Karte (fertig formatierte Zeilen)
 *   OPTSTAT.html(P) / mount(el, P)        -> Karte: Zaehler der Anlage | Energie Heizen | Betrieb (Heute, Gestern, Monat)
 * Abtau-Energie = Aufnahme (mit COP-Korrektur) in den Minuten mit Defrosting_State = 1 plus Wiederaufheizen: danach, bis der Vorlauf wieder den Wert vor der
 * Abtauung erreicht (hoechstens nachMaxMin, Ende auch bei Verdichter aus oder Protokoll-Luecke > 3 min). Heizstab-Energie = Laufzeit x Nennleistung (Annahme).
 * Pumpe und Ventilator: nur Laufzeiten (Strom nicht messbar). Warmwasser und Kuehlen hat die Anlage nicht (DHW_Installed 0): Energie nur Heizen. */
var OPTSTAT = (function () {
    var VER = 1, MIN = 60000, LUECKE = 3 * MIN, FLOW_MIN = 0.5, TAGE_HALTEN = 70;
    var MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    function num(x) { if (x === null || x === undefined || x === '' || typeof x === 'boolean') { return null; } x = Number(x); return isFinite(x) ? x : null; }
    function p2(x) { return (x < 10 ? '0' : '') + x; }
    function tsOf(s) { var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; }
    function dk(t) { var d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
    function tag0(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    function gestern(t) { var d = new Date(tag0(t)); d.setDate(d.getDate() - 1); return d.getTime(); }
    function neu() { return {ver: VER, tage: {}, dat: {}, lz: null, ab: null, archiv: archivNeu()}; }
    function archivNeu() { return {el: {}, th: {}, cop: {}, tt: {}, last: null}; }
    function tag(S, k) { return S.tage[k] || (S.tage[k] = {n: 0, vMin: 0, st: 0, pMin: 0, pOhne: 0, fMin: 0, hsMin: 0, abN: 0, abMin: 0, abWh: 0, rhWh: 0, rhMin: 0}); }

    // ---------------------------------------------------------------- eine Minutenzeile (r = {t, dk, hz, pel (W, korrigiert), flow, fan, def, vl, hs})
    function zeile(S, r, opt) {
        var lz = S.lz, nach = (opt && opt.nachMaxMin) || 30;
        if (lz && r.t <= lz.t) { return; }                                                                  // doppelt oder aelter: schon gezaehlt
        var nah = !!(lz && r.t - lz.t <= LUECKE), lauf = r.hz !== null && r.hz > 0, T = tag(S, r.dk), wh = (r.pel !== null && r.pel >= 0) ? r.pel / 60 : 0;
        T.n++;
        if (lauf) { T.vMin++; if (nah && lz.hz === 0) { T.st++; } }
        if (r.flow !== null && r.flow > FLOW_MIN) { T.pMin++; if (r.hz === 0) { T.pOhne++; } }
        if (r.fan !== null && r.fan > 0) { T.fMin++; }
        if (r.hs) { T.hsMin++; }
        if (!r.def && S.ab && !S.ab.ende) { S.ab.ende = lz ? lz.t : r.t; }                                  // Abtauen vorbei -> Wiederaufheizen beginnt
        if (S.ab && S.ab.ende && !r.def) {
            var A = S.ab;
            if (!nah || !lauf || A.vl0 === null || (r.vl !== null && r.vl >= A.vl0) || r.t - A.ende > nach * MIN) { S.ab = null; }
            else { var TA = tag(S, A.dk); TA.rhWh += wh; TA.rhMin++; }
        }
        if (r.def) {
            if (!(S.ab && !S.ab.ende && nah)) {                                                                   // neue Abtauung (Luecken bis 3 min ueberbrueckt)
                S.ab = {dk: r.dk, s: r.t, vl0: (nah && lz.vl !== null) ? lz.vl : r.vl, ende: null};
                tag(S, r.dk).abN++;
            }
            var TB = tag(S, S.ab.dk); TB.abMin++; TB.abWh += wh;
        }
        S.lz = {t: r.t, hz: r.hz, vl: r.vl, def: r.def ? 1 : 0};
    }
    // ---------------------------------------------------------------- Text des Protokolls (Kopfzeilen: Spalten ueber den Namen zuordnen)
    function text(S, txt, korrW, key, opt) {
        var D = S.dat[key] || (S.dat[key] = {off: 0, head: null}), n = 0, kw = num(korrW) !== null ? num(korrW) : 80;
        String(txt).split('\n').forEach(function (l) {
            if (!l) { return; }
            var p = l.split(',');
            if (p[0] === 'zeit') { D.head = p; return; }
            var H = D.head; if (!H || p.length !== H.length) { return; }
            var o = {}; for (var i = 0; i < H.length; i++) { o[H[i]] = p[i]; }
            var t = tsOf(o.zeit); if (t === null) { return; }
            var hz = num(o.verdichter_hz), pk = num(o.leistung_el_korr_w), pr = num(o.leistung_el_w);
            var pel = pk !== null ? pk : (pr !== null ? pr + (hz !== null && hz > 0 ? kw : 0) : null);
            var hsI = num(o.heizstab_intern), hsE = num(o.heizstab_extern);
            zeile(S, {t: t, dk: o.zeit.slice(0, 10), hz: hz, pel: pel, flow: num(o.flow_l_min), fan: num(o.fan1), def: num(o.defrost) === 1, vl: num(o.ist_vl),
                      hs: (hsI !== null && hsI > 0) || (hsE !== null && hsE > 0)}, opt);
            n++;
        });
        return n;
    }
    // ---------------------------------------------------------------- Datei inkrementell lesen: nur die Bytes ab der letzten Position bis zur letzten vollstaendigen Zeile
    function datei(S, fs, pfad, korrW, opt) {
        var D = S.dat[pfad] || (S.dat[pfad] = {off: 0, head: null}), buf = null, start = D.off;
        try {
            if (typeof fs.openSync === 'function' && typeof fs.fstatSync === 'function' && typeof fs.readSync === 'function') {
                var fd = fs.openSync(pfad, 'r');
                try {
                    var size = fs.fstatSync(fd).size;
                    if (size < start) { start = 0; D.head = null; }                                             // Datei ersetzt: von vorn
                    if (size === start) { return 0; }
                    buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, size - start, start);
                } finally { fs.closeSync(fd); }
            } else {
                var all = fs.readFileSync(pfad); if (typeof all === 'string') { all = Buffer.from(all, 'utf8'); }
                if (all.length < start) { start = 0; D.head = null; }
                buf = all.slice(start);
            }
        } catch (e) { return 0; }                                                                          // Datei (noch) nicht da
        var cut = buf.lastIndexOf(10);
        if (cut < 0) { return 0; }
        D.off = start + cut + 1;
        return text(S, buf.slice(0, cut + 1).toString('utf8'), korrW, pfad, opt);
    }
    function aufraeumen(S, now) {
        var grenze = dk(now - TAGE_HALTEN * 86400000);
        Object.keys(S.tage).forEach(function (k) { if (k < grenze) { delete S.tage[k]; } });
        var A = S.archiv || {}, g3 = dk(now - 3 * 86400000);
        Object.keys(A.tt || {}).forEach(function (k) { if (k < g3) { delete A.tt[k]; } });
        Object.keys(S.dat).forEach(function (p) { var m = /(\d{4})-(\d\d)\.csv$/.exec(p); if (m && m[1] + '-' + m[2] < dk(now - 40 * 86400000).slice(0, 7)) { delete S.dat[p]; } });
    }

    // ---------------------------------------------------------------- Kern-Zaehler (bar-chart-data-Nachrichten, nur lesen)
    function pack(p) {
        var o = {};
        if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return null; } }
        var q = p && Array.isArray(p.payload) && p.payload[0];
        if (!q || !Array.isArray(q.labels) || !Array.isArray(q.data) || !Array.isArray(q.data[0])) { return null; }
        var keys = Array.isArray(p.bar_keys) && p.bar_keys.length === q.labels.length ? p.bar_keys : null;
        if (!keys) { return null; }                                                                        // ohne bar_keys kein sicheres Datum
        keys.forEach(function (k, i) { var v = num(q.data[0][i]); if (v !== null) { o[String(k)] = v; } });
        return o;
    }
    function ymd(t) { return dk(t).replace(/-/g, ''); }
    function kern(A, K, now) {
        A.el = A.el || {}; A.th = A.th || {}; A.cop = A.cop || {}; A.tt = A.tt || {};
        var heute = ymd(now), mon = heute.slice(0, 6);
        var el = pack(K.heat31), th = pack(K.prod), cop = pack(K.cop);
        if (el) { Object.keys(el).forEach(function (k) { if (!/^\d{8}$/.test(k) || k > heute) { return; } A.el[k] = (k === heute || A.el[k] === undefined) ? el[k] : Math.max(A.el[k], el[k]); }); }
        if (th) { Object.keys(th).forEach(function (k) { if (!/^\d{6}$/.test(k) || k > mon) { return; } A.th[k] = (k === mon || A.th[k] === undefined) ? th[k] : Math.max(A.th[k], th[k]); }); }
        if (cop) { Object.keys(cop).forEach(function (k) { if (/^\d{6}$/.test(k) && k <= mon && cop[k] > 0) { A.cop[k] = cop[k]; } }); }
        // Waerme je Tag aus dem Monatszaehler: Stand zu Tagesbeginn = letzter Stand vor Mitternacht (hoechstens 20 min davor), am Monatsersten 0
        var mv = th && th[mon] !== undefined ? th[mon] : (th ? 0 : null), dkey = dk(now);
        if (mv !== null) {
            var tt = A.tt[dkey];
            if (!tt) {
                var l = A.last, t0 = tag0(now), ok = !!(l && l.t < t0 && l.t >= t0 - 20 * MIN);
                tt = A.tt[dkey] = {a: ok ? (l.mon === mon ? l.v : 0) : mv, ok: ok, e: mv, et: now};
            }
            tt.e = mv; tt.et = now; A.last = {t: now, v: mv, mon: mon};
        }
        return A;
    }
    function waermeTag(A, t, ende) {                                                                       // ende: Tag muss bis kurz vor Mitternacht beobachtet sein
        var tt = A.tt && A.tt[dk(t)];
        if (!tt || !tt.ok) { return null; }
        if (ende && tt.et < tag0(t) + 86400000 - 20 * MIN) { return null; }
        return Math.max(0, tt.e - tt.a);
    }

    // ---------------------------------------------------------------- Formate
    function f(v, dg) {
        if (v === null || v === undefined || !isFinite(v)) { return '–'; }
        var s = (Math.round(v * Math.pow(10, dg)) / Math.pow(10, dg)).toFixed(dg), neg = s.charAt(0) === '-'; if (neg) { s = s.slice(1); }
        var p = s.split('.'), g = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        return (neg ? '−' : '') + g + (p[1] ? ',' + p[1] : '');
    }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function datum(k) { return k.slice(6, 8) + '.' + k.slice(4, 6) + '.' + k.slice(0, 4); }

    // ---------------------------------------------------------------- Nutzlast
    // X = {hp: OPT_hp, starts: Starts_Today, defrost: Kern-Objekt Defrost, err: Error_Counter, lastErr: Last_Error, opH, opC (Kern-Globale als Ersatz)}, opt = {kw (Heizstab), korr}
    function daten(S, X, opt, now) {
        X = X || {}; opt = opt || {};
        var HP = X.hp || {}, kw = num(opt.kw) !== null ? num(opt.kw) : 3, A = S.archiv || archivNeu();
        function hv(n, maxH) { var e = HP[n]; if (!e || typeof e !== 'object') { return null; } var v = num(e.v); if (v === null || v <= -127 || (typeof e.ts === 'number' && now - e.ts > (maxH || 24) * 3600000)) { return null; } return v; }
        var opH = hv('Operations_Hours'), opC = hv('Operations_Counter');
        if (opH === null) { opH = num(X.opH); } if (opC === null) { opC = num(X.opC); }
        var z = [['Betriebsstunden', opH === null ? '–' : f(opH, 0) + ' h', 'Operations_Hours'], ['Verdichterstarts gesamt', f(opC, 0), 'Operations_Counter'],
                 ['Starts heute', f(num(X.starts), 0), 'Starts_Today (Kern)']];
        var rh = hv('Room_Heater_Operations_Hours'), dh = hv('DHW_Heater_Operations_Hours');
        z.push(['Heizstab Heizen', rh === null ? '–' : f(rh, 0) + ' h', 'Room_Heater_Operations_Hours']);
        if (dh !== null && dh > 0) { z.push(['Heizstab Warmwasser', f(dh, 0) + ' h', 'DHW_Heater_Operations_Hours']); }
        var dfc = X.defrost && typeof X.defrost === 'object' ? num(X.defrost.Counter) : null;
        if (dfc !== null) { z.push(['Abtauungen gesamt', f(dfc, 0), 'Defrost.Counter (Kern)']); }
        var ec = num(X.err), le = typeof X.lastErr === 'string' && X.lastErr && X.lastErr !== 'No error' ? X.lastErr : null, cur = HP.Error && typeof HP.Error.v === 'string' && HP.Error.v !== 'No error' ? HP.Error.v : null;
        z.push(['Fehler', ec === null ? '–' : f(ec, 0) + (le ? ' · zuletzt ' + le : ''), 'Error_Counter / Last_Error (Kern)']);
        if (cur) { z.push(['Störung aktuell', cur, 'Error']); }
        // Energie Heizen (Kern): Strom je Tag, Waerme je Monat, COP je Monat; Waerme je Tag aus dem Monatszaehler
        var h = ymd(now), g = ymd(gestern(now)), mon = h.slice(0, 6), mName = MONATE[+mon.slice(4) - 1];
        var elH = A.el[h] !== undefined ? A.el[h] : null, elG = A.el[g] !== undefined ? A.el[g] : null, elM = null, elA = null, elSeit = null;
        Object.keys(A.el).sort().forEach(function (k) { var v = A.el[k]; if (k.slice(0, 6) === mon) { elM = (elM || 0) + v; } elA = (elA || 0) + v; if (v > 0 && !elSeit) { elSeit = k; } });
        var thH = waermeTag(A, now, false), thG = waermeTag(A, gestern(now), true), thM = A.th[mon] !== undefined ? A.th[mon] : null, thA = null, thSeit = null, cw = 0, ce = 0;
        Object.keys(A.th).sort().forEach(function (k) { var v = A.th[k]; thA = (thA || 0) + v; if (v > 0 && !thSeit) { thSeit = k; } if (v > 0 && A.cop[k] > 0) { cw += v; ce += v / A.cop[k]; } });
        function q(a, b) { return a !== null && b !== null && b > 0.05 ? a / b : null; }
        var seit = elSeit ? datum(elSeit).slice(0, 6) : null;
        var en = [['Heute', f(elH, 1), f(thH, 1), f(q(thH, elH), 2), 'Wärme ÷ Strom'], ['Gestern', f(elG, 1), f(thG, 1), f(q(thG, elG), 2), 'Wärme ÷ Strom'],
                  [mName, f(elM, 1), f(thM, 1), f(A.cop[mon] !== undefined ? A.cop[mon] : null, 2), 'COP wie Tabelle Effizienz (Mittel der Momentanwerte)'],
                  ['Gesamt' + (seit ? ' seit ' + seit : ''), f(elA, 1), f(thA, 1), f(ce > 0 ? cw / ce : null, 2),
                   'Monats-COP nach Wärme gewichtet' + (thSeit ? ' · Wärme seit ' + MONATE[+thSeit.slice(4) - 1] + ' ' + thSeit.slice(0, 4) : '') + (elSeit ? ' · Strom seit ' + datum(elSeit) : '')]];
        // Betrieb aus dem Minutenprotokoll
        var TH = S.tage[dk(now)] || null, TG = S.tage[dk(gestern(now))] || null, TM = null, mk = dk(now).slice(0, 7);
        Object.keys(S.tage).forEach(function (k) { if (k.slice(0, 7) !== mk) { return; } var T = S.tage[k]; TM = TM || {}; Object.keys(T).forEach(function (x) { TM[x] = (TM[x] || 0) + T[x]; }); });
        function sp(fn) { return [TH, TG, TM].map(function (T) { return T ? fn(T) : '–'; }); }
        var be = [
            ['Erfasste Zeit (h)', sp(function (T) { return f(T.n / 60, 1); }), 'Minuten im Protokoll des Optimierers'],
            ['Verdichter Laufzeit (h)', sp(function (T) { return f(T.vMin / 60, 1); }), 'Compressor_Freq > 0'],
            ['Verdichterstarts', sp(function (T) { return f(T.st, 0); }), 'Wechsel 0 → > 0 Hz im Minutenprotokoll'],
            ['Ø Laufdauer je Start (min)', sp(function (T) { return T.st ? f(T.vMin / T.st, 0) : '–'; }), 'Verdichter-Laufzeit ÷ Starts'],
            ['Abtauungen', sp(function (T) { return f(T.abN, 0); }), 'Defrosting_State = 1 (Lücken bis 3 min überbrückt)'],
            ['Abtauen Dauer (min)', sp(function (T) { return f(T.abMin, 0); }), 'Minuten mit Defrosting_State = 1'],
            ['Abtau-Energie (kWh)', sp(function (T) { return f((T.abWh + T.rhWh) / 1000, 2); }), 'Aufnahme beim Abtauen und Wiederaufheizen (bis der Vorlauf den Wert vor der Abtauung erreicht), ' + (opt.korr || 'mit COP-Korrektur')],
            ['davon Wiederaufheizen (kWh)', sp(function (T) { return f(T.rhWh / 1000, 2); }), 'nach dem Abtauen, höchstens ' + ((opt.nachMaxMin) || 30) + ' min'],
            ['Heizstab Laufzeit (h)', sp(function (T) { return f(T.hsMin / 60, 1); }), 'Internal_Heater_State oder External_Heater_State an'],
            ['Heizstab Energie geschätzt (kWh)', sp(function (T) { return f(T.hsMin / 60 * kw, 1); }), 'Laufzeit × ' + f(kw, 1) + ' kW Nennleistung (Annahme)'],
            ['Umwälzpumpe Laufzeit (h)', sp(function (T) { return f(T.pMin / 60, 1); }), 'Pump_Flow > 0,5 l/min'],
            ['davon ohne Verdichter (h)', sp(function (T) { return f(T.pOhne / 60, 1); }), 'Nachlauf und Umwälzung in der Pause'],
            ['Ventilator Laufzeit (h)', sp(function (T) { return f(T.fMin / 60, 1); }), 'Fan1_Motor_Speed > 0']];
        return {ts: now, z: z, en: en, enKopf: ['', 'Strom (kWh)', 'Wärme (kWh)', 'COP'], be: be, beKopf: ['', 'Heute', 'Gestern', mName]};
    }

    // ---------------------------------------------------------------- Darstellung
    function html(P) {
        if (!P || !P.z) { return '<div class="optch-leer">Noch keine Werte.</div>'; }
        var h = '<div class="optst"><div class="b bz"><div class="sec">Zähler der Anlage</div><table>' +
            P.z.map(function (r) { return '<tr><td title="' + esc(r[2] || '') + '">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table></div>';
        h += '<div class="b be"><div class="sec">Energie Heizen</div><table><tr>' + P.enKopf.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('') + '</tr>' +
            P.en.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td title="' + esc(r[4] || '') + '">' + esc(r[3]) + '</td></tr>'; }).join('') + '</table></div>';
        h += '<div class="b bb"><div class="sec">Betrieb</div><table><tr>' + P.beKopf.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('') + '</tr>' +
            P.be.map(function (r) { return '<tr><td title="' + esc(r[2] || '') + '">' + esc(r[0]) + '</td>' + r[1].map(function (v) { return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div></div>';
        return h;
    }
    function mount(el, P) { if (!el) { return; } var h = html(P); if (el.__h !== h) { el.innerHTML = h; el.__h = h; } }
    var S = {VER: VER, neu: neu, archivNeu: archivNeu, zeile: zeile, text: text, datei: datei, aufraeumen: aufraeumen, kern: kern, pack: pack, waermeTag: waermeTag, daten: daten, html: html, mount: mount, f: f};
    if (typeof window !== 'undefined') { window.optStat = S; }
    return S;
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = OPTSTAT; }

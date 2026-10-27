// == EVCC-CORE ==
// evcc-Abgleich (25.10.2026, Branch evcc-abgleich): reine Funktionen, NUR Anzeige und Protokoll, keine Regelwirkung, nichts wird an evcc oder die Waermepumpe gesendet.
// Vom Generator eingebettet in opt_evcc (Abruf auswerten, Protokoll evcc-plan-YYYY-MM.jsonl), opt_evcc_q (taegliche Pruefung 00:10, evcc-quality.json) und opt_energy
// (OPT_plan_in.evcc, Zeilen der Prognoseguete). Getestet in tools/evcc_core_test.js (echte Daten: tools/fixtures/evcc_state_2510.json) und tools/optimizer_sim.js.
// Einheiten (geprueft am 25.10.2026, evcc 0.318.1, an echten Zahlen): je Schritt Energie in Wh (dt Sekunden, erster Schritt angebrochen, danach 900 s):
//   req.time_series.gt = Summe der demandDetails (Haus + Heizungen), ft PV in Wh, p_N/p_E in EUR/Wh; res.batteries[0].charging_power/discharging_power trotz des Namens
//   ebenfalls Wh je Schritt (Entladen = gt, solange nichts anderes laeuft; x 4 = battery.suggestion.discharge in W), state_of_charge in Wh am ENDE des Schritts
//   (s_initial − Entladen/eta_d; Minimum stimmt mit battery.forecast.lowest ueberein), res.grid_import/grid_export Wh je Schritt.
//   EVC.kompakt(roh, now, cfg)        Antwort von /api/state (ganz oder jq-Auszug) -> kompakter Plan oder {fehler}
//   EVC.zeile(plan)                   Protokollzeile (Sekunden, gerundet);  EVC.ausZeile(obj) -> Plan (Millisekunden)
//   EVC.planIn(plan, abruf, now)      Eingang fuer den Waermefahrplan: Akku-Minimum, Netzbezugs-/Einspeisefenster, PV-Prognose evcc, Kennzahlenzeile
//   EVC.messViertel(text, d0, d1)     Stromzaehler Waermepumpe (zaehler_wp_w, quiet-YYYY-MM.csv, je Minute) -> Wh je Viertelstunde des Tages
//   EVC.tag(o)                        Vergleich eines Tages je Viertelstunde: evcc 6 h, evcc Tag, Modell Tag (+ Modell 6 h nur in der Datei) gegen die Messung
//   EVC.uebersicht(Q, now)            Tabellenzeilen (Vortag, 7-Tage-Mittel, Bewertung) und Hinweis „evcc unterschaetzt die Waermepumpe um x %“
var EVC = (function () {
    var VER = 1, MIN = 60000, Q = 900000, H = 3600000;
    // ANNAHMEN (Schwellen des Auftrags 25.10.2026): veraltet nach 60 min; Netzbezug/Einspeisung zaehlt ab 25 Wh je Viertelstunde (100 W); 6-h-Vorlauf: Schnappschuss
    // 6 h ± 45 min vor dem Schritt; Tagesprognose: juengster Schnappschuss vor Mitternacht (hoechstens 6 h alt); ein Tag zaehlt mit mindestens 75 % der Viertelstunden;
    // Messung einer Viertelstunde ab 10 Minutenwerten; Bewertung ok < 15 %, Hinweis 15–30 %, Warnung > 30 %; Engine-Hinweis ab 20 % im 7-Tage-Mittel aus mindestens 3 Tagen
    var STD = {veraltetMin: 60, schwelleWh: 25, vorlaufH: 6, vorlaufTolMin: 45, tagMaxAlterH: 6, minAnteil: 0.75, messMinN: 10, okPct: 15, warnPct: 30, hinweisPct: 20,
               hinweisMinTage: 3, mittelTage: 7, tageBehalten: 60, viertelTage: 14, heizung: 'Panasonic Leisha'};
    var REIHEN = [['e6', 'evcc Leisha (6 h)'], ['eT', 'evcc Leisha (Tag)'], ['mT', 'Modell (Tag)']];
    function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } v = Number(v); return isFinite(v) ? v : null; }
    function have(v) { return v !== null && v !== undefined && isFinite(v); }
    function rd(v, f) { return have(v) ? Math.round(v * f) / f : null; }
    function de(v, d) { return have(v) ? Number(v).toFixed(d).replace('.', ',').replace(/^-(0(,0+)?)$/, '$1') : '–'; }
    function sg(v, d) { if (!have(v)) { return '–'; } var r = Number(Number(v).toFixed(d)); return (r > 0 ? '+' : (r < 0 ? '−' : '')) + de(Math.abs(r), d); }
    function p2(x) { return (x < 10 ? '0' : '') + x; }
    function hhmm(t) { var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
    function ymd(t) { var d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
    function tag0(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
    function folgeTag(d0) { var d = new Date(d0); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); }   // 23/24/25 h (Zeitumstellung)
    function arr(a, n) { return Array.isArray(a) && a.length === n && a.every(function (x) { return have(num(x)); }) ? a.map(Number) : null; }
    function cfgOf(cfg) { var o = {}, c = (cfg && cfg.evcc) || {}; Object.keys(STD).forEach(function (k) { o[k] = (typeof STD[k] === 'number') ? (have(num(c[k])) ? num(c[k]) : STD[k]) : (typeof c[k] === 'string' && c[k] ? c[k] : STD[k]); }); return o; }

    // ---------- Abruf: /api/state (ganz, {result: ...} oder jq-Auszug {evopt, soc, tariffGrid, version}) -> kompakter Plan
    function kompakt(roh, now, cfg) {
        var C = cfgOf(cfg), r = roh && typeof roh === 'object' ? (roh.result && typeof roh.result === 'object' ? roh.result : roh) : null;
        if (!r) { return {fehler: 'keine Antwort'}; }
        var e = r.evopt;
        if (!e || typeof e !== 'object') { return {fehler: 'evcc liefert keinen Optimierer-Plan (evopt fehlt)'}; }
        var rq = e.req || {}, ts = rq.time_series || {}, rs = e.res || {}, dt = e.details || {};
        var n = Array.isArray(ts.dt) ? ts.dt.length : 0;
        if (!n || n > 400) { return {fehler: 'Plan ohne Zeitschritte'}; }
        var zeit = Array.isArray(dt.timestamp) && dt.timestamp.length === n ? dt.timestamp.map(function (s) { return Date.parse(s); }) : null;
        if (!zeit || !zeit.every(have)) { return {fehler: 'Zeitstempel fehlen oder passen nicht (' + n + ' Schritte)'}; }
        var d = arr(ts.dt, n), gt = arr(ts.gt, n), ft = arr(ts.ft, n), pN = arr(ts.p_N, n), pE = arr(ts.p_E, n);
        if (!d || !gt || !ft) { return {fehler: 'Zeitreihen unvollständig'}; }
        var dd = Array.isArray(dt.demandDetails) ? dt.demandDetails : [], hz = dd.filter(function (x) { return x && x.type === 'heating'; });
        var le = dd.filter(function (x) { return x && x.type === 'heating' && x.title === C.heizung; })[0] || (hz.length === 1 ? hz[0] : null);
        var hs = dd.filter(function (x) { return x && x.type === 'home'; })[0], ww = hz.filter(function (x) { return x !== le; });
        // Hausakku finden: evcc stellt angesteckte Fahrzeuge als weitere "batteries" voran (ohne s_capacity, d_max 0; gesehen 27.10.2026:
        // Auto 25,2/48 kWh an Index 0, Hausakku an Index 1). Der Hausakku ist der Eintrag mit s_capacity; sonst der letzte, sonst Index 0.
        var rqb = Array.isArray(rq.batteries) ? rq.batteries : [], rsb = Array.isArray(rs.batteries) ? rs.batteries : [], bi = -1;
        for (var k = 0; k < rqb.length; k++) { if (rqb[k] && have(num(rqb[k].s_capacity))) { bi = k; break; } }
        if (bi < 0) { bi = rqb.length ? rqb.length - 1 : 0; }
        var b = rsb[bi] || {}, bq = rqb[bi] || {};
        var rW = function (a) { return a ? a.map(function (x) { return Math.round(x); }) : null; };
        var sumW = function (L) { if (!L.length) { return null; } var o = []; for (var i = 0; i < n; i++) { var s = 0; for (var j = 0; j < L.length; j++) { var v = L[j] && arr(L[j].values, n); if (!v) { return null; } s += v[i]; } o.push(Math.round(s)); } return o; };
        var upd = Date.parse(e.updated);
        return {plan: {v: VER, ts: now, upd: have(upd) ? upd : null, n: n, zeit: zeit, dt: d, leisha: le ? rW(arr(le.values, n)) : null, leishaTitel: le ? String(le.title || '') : null,
                       haus: hs ? rW(arr(hs.values, n)) : null, bwwp: sumW(ww), gesamt: rW(gt), pv: rW(ft),
                       preis: pN ? pN.map(function (x) { return rd(x * 1000, 10000); }) : null, einsp: pE ? pE.map(function (x) { return rd(x * 1000, 10000); }) : null,
                       laden: rW(arr(b.charging_power, n)), entladen: rW(arr(b.discharging_power, n)), soc: rW(arr(b.state_of_charge, n)),
                       bezug: rW(arr(rs.grid_import, n)), einspeisung: rW(arr(rs.grid_export, n)),
                       kapWh: num(bq.s_capacity), sMinWh: num(bq.s_min), sStartWh: num(bq.s_initial), akkuIndex: bi, fahrzeuge: Math.max(0, rqb.length - 1), status: rs.status ? String(rs.status) : null, ziel: rd(num(rs.objective_value), 1000),
                       socPct: num(r.soc !== undefined ? r.soc : (r.battery && r.battery.soc)), tarif: num(r.tariffGrid), version: r.version ? String(r.version) : null}};
    }
    // Protokollzeile (eine je Abruf): Zeiten in Sekunden, Zeitstempel als Beginn + dt (Sekunden je Schritt), Felder wie im Plan (Wh je Schritt, Preise EUR/kWh);
    // ein Feld mit lauter gleichen Werten (fester Tarif) steht als eine Zahl; gt (Summe der Bedarfe) entfaellt (= haus + leisha + bwwp)
    var FELDER = ['leisha', 'haus', 'bwwp', 'pv', 'preis', 'einsp', 'laden', 'entladen', 'soc', 'bezug', 'einspeisung'], META = ['leishaTitel', 'kapWh', 'sMinWh', 'sStartWh', 'status', 'ziel', 'socPct', 'tarif', 'version'];
    function pack(a) { return (Array.isArray(a) && a.length && a.every(function (x) { return x === a[0]; })) ? a[0] : a; }
    function zeile(p) {
        var o = {t: Math.round(p.ts / 1000), upd: have(p.upd) ? Math.round(p.upd / 1000) : null, zeit0: Math.round(p.zeit[0] / 1000), dt: p.dt};
        FELDER.forEach(function (k) { o[k] = pack(p[k]); });
        META.forEach(function (k) { o[k] = p[k] === undefined ? null : p[k]; });
        return o;
    }
    function ausZeile(o) {
        if (!o || !Array.isArray(o.dt) || !have(num(o.t)) || !have(num(o.zeit0))) { return null; }
        var n = o.dt.length, z = [], t = o.zeit0 * 1000;
        for (var i = 0; i < n; i++) { z.push(t); t += o.dt[i] * 1000; }
        var p = {ts: o.t * 1000, upd: have(num(o.upd)) ? o.upd * 1000 : null, n: n, zeit: z, dt: o.dt};
        FELDER.forEach(function (k) { var v = o[k]; p[k] = Array.isArray(v) && v.length === n ? v : (have(num(v)) ? z.map(function () { return Number(v); }) : null); });
        META.forEach(function (k) { p[k] = o[k] === undefined ? null : o[k]; });
        return p;
    }
    // ---------- Eingang fuer den Waermefahrplan (nur Anzeige): ab jetzt (Schritte, die noch nicht vorbei sind)
    function fenster(p, feld, now, C) {
        var a = p[feld], out = [], cur = null;
        if (!a) { return out; }
        for (var i = 0; i < p.n; i++) {
            var s = p.zeit[i], e = s + p.dt[i] * 1000;
            if (e <= now) { continue; }
            if (a[i] >= C.schwelleWh) { if (cur && cur[1] === s) { cur[1] = e; cur[2] += a[i]; } else { cur = [s, e, a[i]]; out.push(cur); } }
        }
        return out.map(function (x) { return [x[0], x[1], rd(x[2] / 1000, 100)]; });
    }
    function abrufStand(abruf, plan, now, C) {
        var A = abruf || {}, alter = plan && have(plan.ts) ? (now - plan.ts) / MIN : null;
        return {alterMin: rd(alter, 10), veraltet: alter === null || alter > C.veraltetMin, fehler: A.fehler || null, abrufTs: have(A.ts) ? A.ts : null};
    }
    function planIn(plan, abruf, now, cfg) {
        var C = cfgOf(cfg), st = abrufStand(abruf, plan, now, C);
        if (!plan || !plan.zeit) { return {da: false, fehler: st.fehler, zeile: kennzeile(null, st)}; }
        var smin = null, pv = [], le24 = 0, leN = 0, pv24 = 0;
        for (var i = 0; i < plan.n; i++) {
            var s = plan.zeit[i], e = s + plan.dt[i] * 1000;
            if (e > now && plan.soc && (smin === null || plan.soc[i] < smin.wh)) { smin = {t: e, wh: plan.soc[i]}; }
            if (e > now - 2 * H && plan.pv) { pv.push([s, Math.round(plan.pv[i] * 3600 / plan.dt[i]), plan.dt[i] * 1000]); }
            if (e > now && s < now + 24 * H && plan.leisha) { le24 += plan.leisha[i]; leN++; }
            if (e > now && s < now + 24 * H && plan.pv) { pv24 += plan.pv[i]; }
        }
        var o = {da: true, ts: plan.ts, upd: plan.upd, alterMin: st.alterMin, veraltet: st.veraltet, fehler: st.fehler, status: plan.status,
                 socMin: smin ? {t: smin.t, kwh: rd(smin.wh / 1000, 100), pct: plan.kapWh ? rd(100 * smin.wh / plan.kapWh, 10) : null} : null,
                 bezug: fenster(plan, 'bezug', now, C), einsp: fenster(plan, 'einspeisung', now, C), pv: pv, pvSrc: 'evcc', pv24Kwh: plan.pv ? rd(pv24 / 1000, 10) : null, leisha24Kwh: leN ? rd(le24 / 1000, 100) : null,
                 bis: plan.zeit[plan.n - 1] + plan.dt[plan.n - 1] * 1000};
        o.zeile = kennzeile(o, st);
        return o;
    }
    // Kennzahlenzeile der Karte "Waermefahrplan": "evcc-Plan: Akku-Minimum 06:00 bei 6,4 kWh · Netzbezug geplant – · Einspeisung ab 11:30" bzw. "evcc: kein Plan"
    function kennzeile(pi, st) {
        if (!pi || !pi.da) { return {k: 'evcc', v: 'kein Plan' + (st && st.fehler ? ' (' + st.fehler + ')' : ''), c: 'warn', t: 'Kein Optimierer-Plan von evcc (/api/state, Schlüssel evopt)'}; }
        var fz = function (w) { return hhmm(w[0]) + '–' + hhmm(w[1]); }, kwh = function (L) { return L.reduce(function (a, w) { return a + w[2]; }, 0); };
        var v = 'Akku-Minimum ' + (pi.socMin ? hhmm(pi.socMin.t) + ' bei ' + de(pi.socMin.kwh, 1) + ' kWh' : '–') +
                ' · Netzbezug geplant ' + (pi.bezug.length ? fz(pi.bezug[0]) + (pi.bezug.length > 1 ? ' (+' + (pi.bezug.length - 1) + ')' : '') : '–') +
                ' · Einspeisung ' + (pi.einsp.length ? 'ab ' + hhmm(pi.einsp[0][0]) : '–') + (pi.veraltet ? ' · veraltet (' + de(pi.alterMin, 0) + ' min)' : '');
        var t = 'evcc-Optimierer, Stand ' + hhmm(pi.upd || pi.ts) + (pi.status ? ' (' + pi.status + ')' : '') + ', reicht bis ' + hhmm(pi.bis) +
                (pi.socMin && have(pi.socMin.pct) ? ' · Akku-Minimum ' + de(pi.socMin.pct, 0) + ' %' : '') +
                ' · Netzbezug ' + de(kwh(pi.bezug), 1) + ' kWh · Einspeisung ' + de(kwh(pi.einsp), 1) + ' kWh' +
                (have(pi.pv24Kwh) ? ' · PV-Prognose evcc ' + de(pi.pv24Kwh, 1) + ' kWh' : '') + (have(pi.leisha24Kwh) ? ' · Wärmepumpe laut evcc ' + de(pi.leisha24Kwh, 1) + ' kWh' : '') + (pi.fehler ? ' · letzter Abruf: ' + pi.fehler : '') +
                ' · nur Anzeige, ändert keine Entscheidung';
        return {k: 'evcc-Plan', v: v, c: pi.veraltet ? 'warn' : '', t: t};
    }
    // ---------- Messung: zaehler_wp_w je Minute (quiet-YYYY-MM.csv, Ortszeit ohne Versatz; die doppelte Stunde der Zeitumstellung ueber die Reihenfolge) -> Wh je Viertelstunde
    function messViertel(text, d0, d1, C0) {
        var C = C0 || STD, z = [], qs = {}, nQ = 0;
        for (var t = d0; t < d1; t += Q) { qs[t] = [0, 0]; z.push(t); nQ++; }
        var head = null, iz = -1, prev = null, k0 = ymd(d0 - H), k1 = ymd(d0), k2 = ymd(d1 - 1);
        String(text || '').split('\n').forEach(function (l) {
            if (l.indexOf('zeit,') === 0) { head = l.split(','); iz = head.indexOf('zaehler_wp_w'); return; }
            var dk = l.slice(0, 10);
            if (!head || iz < 0 || (dk !== k0 && dk !== k1 && dk !== k2)) { return; }
            var p = l.split(',');
            if (p.length !== head.length) { return; }
            var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(p[0]);
            if (!m) { return; }
            var tt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
            if (prev !== null && tt < prev - 30 * MIN && tt + H >= prev - 2 * MIN) { tt += H; }          // zweite 02:xx-Stunde (Ende der Sommerzeit)
            prev = tt;
            var v = num(p[iz]), q0 = Math.floor((tt - d0) / Q) * Q + d0;
            if (v === null || v < 0 || v > 20000 || !qs[q0]) { return; }
            qs[q0][0] += v; qs[q0][1]++;
        });
        return {zeit: z, wh: z.map(function (t) { var a = qs[t]; return a[1] >= C.messMinN ? rd(a[0] / a[1] * 0.25, 10) : null; }), n: z.map(function (t) { return qs[t][1]; }), nQ: nQ};
    }
    // ---------- Prognosen je Viertelstunde
    function idx(p) { if (!p._ix) { var m = {}; for (var i = 0; i < p.n; i++) { if (Math.abs(p.dt[i] - 900) <= 1) { m[p.zeit[i]] = i; } } Object.defineProperty(p, '_ix', {value: m, enumerable: false}); } return p._ix; }
    function evccWert(p, t) { if (!p || !p.leisha) { return null; } var i = idx(p)[t]; return i === undefined ? null : p.leisha[i]; }
    function modellWert(s, t) { if (!s || !Array.isArray(s.slots)) { return null; } var ic = (s.cols || []).indexOf('strom'); if (ic < 0) { return null; }
        if (!s._ix) { var m = {}; s.slots.forEach(function (r) { m[r[0] * 1000] = r[ic]; }); Object.defineProperty(s, '_ix', {value: m, enumerable: false}); }
        var v = s._ix[t]; return have(num(v)) ? v * 1000 : null; }                                                   // Plan-Schnappschuss: Strom kWh je Slot -> Wh
    function naechster(L, ziel, tol, zeitOf, wert, t) {                                              // Schnappschuss mit Zeit am naechsten zu ziel (± tol), der den Schritt t enthaelt
        var best = null, bd = null;
        L.forEach(function (s) { var d = Math.abs(zeitOf(s) - ziel); if (d <= tol && (bd === null || d < bd) && wert(s, t) !== null) { best = s; bd = d; } });
        return best;
    }
    function juengsterVor(L, grenze, maxAlter, zeitOf) { var b = null; L.forEach(function (s) { var z = zeitOf(s); if (z < grenze && z >= grenze - maxAlter && (!b || z > zeitOf(b))) { b = s; } }); return b; }
    // o = {d0, d1, mess: messViertel(...), evcc: [Plan], modell: [Plan-Schnappschuss {t0, t, cols, slots}], cfg}
    function tag(o) {
        var C = cfgOf(o.cfg), M = o.mess, ev = (o.evcc || []).filter(function (p) { return p && p.leisha; }), md = (o.modell || []).filter(function (s) { return s && Array.isArray(s.slots); });
        var eZ = function (p) { return have(p.upd) ? p.upd : p.ts; }, mZ = function (s) { return have(num(s.t)) ? s.t : s.t0; };
        var eT = juengsterVor(ev, o.d0, C.tagMaxAlterH * H, eZ), mT = juengsterVor(md, o.d0, C.tagMaxAlterH * H, mZ), tol = C.vorlaufTolMin * MIN;
        var V = {e6: [], eT: [], mT: [], m6: []};
        M.zeit.forEach(function (t) {
            var ziel = t - C.vorlaufH * H, s6 = naechster(ev, ziel, tol, eZ, evccWert, t), m6 = naechster(md, ziel, tol, mZ, modellWert, t);
            V.e6.push(s6 ? evccWert(s6, t) : null); V.eT.push(eT ? evccWert(eT, t) : null); V.mT.push(mT ? modellWert(mT, t) : null); V.m6.push(m6 ? modellWert(m6, t) : null);
        });
        var res = {tag: ymd(o.d0), d0: o.d0, nQ: M.nQ, mess: null, reihen: {}, quellen: {eT: eT ? eZ(eT) : null, mT: mT ? mZ(mT) : null}, ver: VER};
        var mk = 0, mn = 0; M.wh.forEach(function (w) { if (w !== null) { mk += w; mn++; } });
        res.mess = {kwh: mn ? rd(mk / 1000, 1000) : null, n: mn, hochgerechnet: mn ? rd(mk / mn * M.nQ / 1000, 1000) : null};
        Object.keys(V).forEach(function (k) {
            var p = 0, m = 0, n = 0, ae = 0;
            V[k].forEach(function (v, i) { var w = M.wh[i]; if (v !== null && w !== null) { p += v; m += w; n++; ae += Math.abs(v - w); } });
            res.reihen[k] = {p: rd(p / 1000, 1000), m: rd(m / 1000, 1000), n: n, mae: n ? rd(ae / n * 4, 1) : null};      // mae: mittlerer Fehler je Viertelstunde in W
        });
        res.viertel = {zeit0: Math.round(o.d0 / 1000), mess: M.wh, e6: V.e6, eT: V.eT, mT: V.mT, m6: V.m6};
        return res;
    }
    function gueltig(r, nQ, C) { return !!(r && r.n >= C.minAnteil * nQ && r.m > 0); }
    function abw(p, m) { return m > 0 ? 100 * (p - m) / m : null; }
    function bewertung(a, C) { if (!have(a)) { return ['–', '']; } var x = Math.abs(a); return x < C.okPct ? ['ok', 'ok'] : (x <= C.warnPct ? ['Hinweis', 'warn'] : ['Warnung', 'bad']); }
    // Q = Inhalt von evcc-quality.json {tage: [tag(...)]}; Zeilen: [Name, Prognose kWh, Messung kWh, Abw., 7 Tage, Bewertung, Klasse, Tooltip]
    function uebersicht(Q, now, cfg) {
        var C = cfgOf(cfg), T = (Q && Array.isArray(Q.tage) ? Q.tage : []).slice().sort(function (a, b) { return a.d0 - b.d0; }), L = T.length ? T[T.length - 1] : null;
        var zeilen = [], mittel = {};
        REIHEN.forEach(function (R) {
            var k = R[0], last7 = T.filter(function (d) { return d.d0 > tag0(now) - (C.mittelTage + 0.5) * 24 * H; }).filter(function (d) { return gueltig(d.reihen[k], d.nQ, C); });
            var sp = 0, sm = 0, sa = 0; last7.forEach(function (d) { sp += d.reihen[k].p; sm += d.reihen[k].m; sa += Math.abs(abw(d.reihen[k].p, d.reihen[k].m)); });
            var a7 = last7.length ? abw(sp, sm) : null, f7 = last7.length ? sa / last7.length : null, r = L ? L.reihen[k] : null, ok1 = L && gueltig(r, L.nQ, C), a1 = ok1 ? abw(r.p, r.m) : null;
            var bw = bewertung(have(f7) ? f7 : a1, C);                                                   // Bewertung nach dem mittleren Tagesfehler (Betrag), damit sich Tage mit + und − nicht aufheben
            mittel[k] = {abw: a7, fehler: f7, tage: last7.length};
            zeilen.push([R[1], ok1 ? de(r.p, 1) : '–', ok1 ? de(r.m, 1) : '–', ok1 ? sg(a1, 0) + ' %' : (r && r.n ? 'zu wenig (' + Math.round(100 * r.n / L.nQ) + ' %)' : '–'),
                         have(a7) ? sg(a7, 0) + ' % (' + last7.length + ' T.)' : '–', bw[0], bw[1],
                         (L ? 'Vortag ' + L.tag.slice(8, 10) + '.' + L.tag.slice(5, 7) + '.: ' : '') + (r ? r.n + ' von ' + L.nQ + ' Viertelstunden mit Prognose und Messung' + (have(r.mae) ? ', mittlerer Fehler ' + de(r.mae, 0) + ' W' : '') : 'keine Daten') +
                         (have(f7) ? ' · 7 Tage: Summe ' + sg(a7, 0) + ' %, mittlerer Tagesfehler ' + de(f7, 0) + ' %' : '') +
                         ' · Bewertung nach dem mittleren Tagesfehler der 7 Tage (sonst Vortag): ok unter ' + C.okPct + ' %, Hinweis bis ' + C.warnPct + ' %, Warnung darüber']);
        });
        var h = null, src = mittel.e6.tage >= C.hinweisMinTage ? ['e6', '6 h Vorlauf'] : (mittel.eT.tage >= C.hinweisMinTage ? ['eT', 'Tagesprognose'] : null);
        if (src && have(mittel[src[0]].abw) && Math.abs(mittel[src[0]].abw) > C.hinweisPct) {
            h = 'evcc ' + (mittel[src[0]].abw < 0 ? 'unterschätzt' : 'überschätzt') + ' die Wärmepumpe um ' + de(Math.abs(mittel[src[0]].abw), 0) + ' % (' + C.mittelTage + ' Tage, ' + src[1] + ', ' + mittel[src[0]].tage + ' Tage mit Daten)' +
                ' – den Akkuplan von evcc entsprechend einordnen';
        }
        return {zeilen: zeilen, tag: L ? L.tag : null, mess: L ? L.mess : null, hinweis: h, mittel: mittel};
    }
    return {VER: VER, STD: STD, REIHEN: REIHEN, cfgOf: cfgOf, kompakt: kompakt, zeile: zeile, ausZeile: ausZeile, planIn: planIn, kennzeile: kennzeile, fenster: fenster, abrufStand: abrufStand,
            messViertel: messViertel, evccWert: evccWert, modellWert: modellWert, tag: tag, uebersicht: uebersicht, bewertung: bewertung, tag0: tag0, folgeTag: folgeTag, ymd: ymd, hhmm: hhmm, de: de};
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = EVC; }
// == EVCC-CORE-ENDE ==

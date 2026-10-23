/* Seite "Lernen" (lern-seite 23.10.2026): was der NAS-Container optimizer-tools nachts lernt. Nur lesen, keine Regelwirkung.
 * Der Container schreibt nach /data/optimizer-tools (status.json Format 2, training/wp_params_<tag>.json bzw. kandidat_<tag>.json, kennzahlen/tage.csv,
 * replay/<tag>.json, letzter-lauf.log). Der Funktionsknoten opt_lern liest sie alle 5 min (optLern.daten), die vier Karten zeichnen mit optLern.mount.
 *   optLern.daten(fs, jetzt, cache, basis) -> {heute, param, guete, replay}   (reine Funktion bis auf fs; cache = Objekt fuer geparste Parameterdateien)
 *   optLern.html(kind, P)                   -> HTML einer Karte (kind: 'heute' | 'param' | 'guete' | 'replay')
 *   optLern.mount(el, kind, P)              -> zeichnet in ein Element (aufgeklappte Abschnitte bleiben offen); die Karten schicken nichts
 * Gelernt = Parameter mit "fit" in herkunft (vom Training geschaetzt, wie die Drift-Tabelle in wp_training.md); fest = alle uebrigen (F/H/S/N/A, M ohne Fit).
 * Lernkurve aus guete.test der Parameterdateien (je Trainingstag; Testtage = die letzten 4 Tage des jeweiligen Laufs), abgelehnte Kandidaten hohl. */
(function (root) {
    var VER = 1;
    if (root.optLern && root.optLern.v === VER) { return; }
    var L = {v: VER, OFFEN: 15}, TAG = 86400000, FENSTER = 14;

    // ---------------------------------------------------------------- Zahlen und Zeiten (Dezimalkomma, Minuszeichen, deutsch)
    function ok(v) { return v !== null && v !== undefined && v !== '' && isFinite(v); }
    function f(v, d) { if (!ok(v)) { return '–'; } var s = Number(v).toFixed(d); if (/^-0(\.0*)?$/.test(s)) { s = s.slice(1); } return s.replace('-', '−').replace('.', ','); }
    function sig(v) { if (!ok(v)) { return '–'; } var a = Math.abs(v); if (a > 0 && a < 0.001) { return Number(v).toPrecision(2).replace('-', '−').replace('.', ','); } return f(v, a >= 1000 || (a >= 10 && v === Math.round(v)) ? 0 : a >= 100 ? 1 : a >= 10 ? 1 : a >= 1 ? 2 : a === 0 ? 0 : a >= 0.1 ? 3 : 4); }
    function pz(r, d) { return ok(r) ? (r > 0 ? '+' : '') + f(100 * r, d === undefined ? 1 : d) + ' %' : '–'; }
    function dm(s) { var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(s || '')); return m ? m[3] + '.' + m[2] + '.' : '–'; }
    function dmhm(s) { var m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(String(s || '')); return m ? m[3] + '.' + m[2] + '. ' + m[4] + ':' + m[5] : '–'; }
    function tsOf(s) { var m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : null; }
    function tagN(s) { var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / TAG : null; }   // Tag als ganze Zahl (Kalender, ohne Zeitzone)
    function dauer(s) { return !ok(s) ? '–' : (s < 120 ? f(s, s < 10 ? 1 : 0) + ' s' : f(s / 60, 1) + ' min'); }
    L.f = f; L.sig = sig; L.dm = dm; L.dmhm = dmhm;

    // ---------------------------------------------------------------- Dateien lesen (nur lesen; fehlt etwas, bleibt der Teil leer)
    function leser(fs, basis) {
        var r = {};
        r.text = function (p) { try { return {t: String(fs.readFileSync(basis + '/' + p, 'utf8'))}; } catch (e) { return {e: e && e.code === 'ENOENT' ? 'fehlt' : 'nicht lesbar'}; } };
        r.json = function (p) { var x = r.text(p); if (x.e) { return x; } try { return {j: JSON.parse(x.t)}; } catch (e) { return {e: 'kein JSON'}; } };
        r.liste = function (p) { try { return fs.readdirSync(basis + '/' + p).map(String); } catch (e) { return []; } };
        r.sig = function (p) { try { var s = fs.statSync(basis + '/' + p); return s.mtimeMs + ':' + s.size; } catch (e) { return null; } };
        return r;
    }
    // Werte flach: Zahl -> name, Liste -> name[i], Objekt -> name.schluessel (z. B. fanQ[2], raeume.wohn[0]); null bleibt null
    function flach(k, v, out) {
        if (Array.isArray(v)) { v.forEach(function (x, i) { flach(k + '[' + i + ']', x, out); }); }
        else if (v && typeof v === 'object') { Object.keys(v).forEach(function (s) { flach(k + '.' + s, v[s], out); }); }
        else { out[k] = ok(v) ? Number(v) : null; }
    }
    // Einheit eines Blatts: "min, l/min, min, min" je Stelle; "K, –, –, K/kW, min, K…" -> ab der letzten Angabe mit "…" dieselbe Einheit
    function einheitBlatt(e, blatt) {
        e = String(e || ''); var m = /\[(\d+)\]$/.exec(blatt), teile = e.split(/,\s*/);
        if (!m || teile.length < 2) { return e; }
        var i = +m[1], letzte = teile[teile.length - 1];
        if (i < teile.length - 1 || (i === teile.length - 1 && !/…$/.test(letzte))) { return teile[i]; }
        return /…$/.test(letzte) ? letzte.replace(/…$/, '') : '';
    }
    // Bedeutung einzelner Stellen (wp_zwilling.js raumWert: th + [0] + [1]·(tw−th, Grenzen [5]…[6]) + [2]·(th−AT, Grenzen [7]…[8]) + [3]·PV, Glättung [4] min; fanQ je Quiet 0–3)
    var RAUM = ['Versatz', 'Heizkörper', 'Außen', 'Sonne', 'Zeitkonstante', 'Heizkörper ab', 'Heizkörper bis', 'Außen ab', 'Außen bis'];
    function etikett(b) { var m = /^raeume\.[^[]+\[(\d+)\]$/.exec(b); if (m) { return RAUM[+m[1]] || ''; } m = /^fanQ\[(\d)\]$/.exec(b); return m ? 'Quiet ' + m[1] : ''; }
    L.etikett = etikett;
    function kurzWert(v) {
        if (Array.isArray(v)) { return '[' + v.map(kurzWert).join(' ') + ']'; }
        if (v && typeof v === 'object') { return Object.keys(v).map(function (k) { return k + ' ' + kurzWert(v[k]); }).join(' · '); }
        return ok(v) ? sig(Number(v)) : (v === null || v === undefined ? '–' : String(v));
    }
    function zusammen(J, tag, art) {
        var W = J.werte || {}, H = J.herkunft || {}, R = (J.roh && J.roh.werte) || {}, gt = (J.guete && J.guete.test) || {}, te = gt.teil || {}, zs = gt.zyklenHausSimuliert || {};
        var w = {}, roh = {}, meta = {}, fest = [];
        Object.keys(W).forEach(function (k) {
            var h = H[k] || {};
            if (h.fit) {
                var o = {}; flach(k, W[k], o);
                Object.keys(o).forEach(function (b) { w[b] = o[b]; meta[b] = {e: einheitBlatt(h.einheit, b), h: h.herkunft || '', g: h.gruppe || '', q: h.quelle || '', fit: h.fit, l: etikett(b)}; });
                if (R[k] !== undefined) { flach(k, R[k], roh); }
            } else { fest.push({n: k, v: kurzWert(W[k]), e: h.einheit || '', h: h.herkunft || '', q: h.quelle || ''}); }
        });
        var tt = Array.isArray(gt.tage) && gt.tage.length ? [gt.tage[0], gt.tage[gt.tage.length - 1]] : null;
        return {tag: tag, art: art, w: w, roh: roh, meta: meta, fest: fest, test: tt, ent: (J.entscheidung && J.entscheidung.ergebnis) || (art === 'k' ? 'abgelehnt' : null),
                g: {strom: te.pelRmseW, wk: te.wasserkreisRmseK, pause: (zs.pause || {}).medianAbsMin, lauf: (zs.lauf || {}).medianAbsMin, waerme: te.pthRmseW, regler: te.reglerRmseHz, haus: te.hausRmseK},
                glaettung: J.glaettung || null};
    }
    function csvZeile(s) {
        var out = [], cur = '', q = false;
        for (var i = 0; i < s.length; i++) { var c = s[i]; if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else { q = false; } } else { cur += c; } } else if (c === '"') { q = true; } else if (c === ',') { out.push(cur); cur = ''; } else { cur += c; } }
        out.push(cur); return out;
    }
    var REGELN = {quiet_freigabe: 'Quiet-Freigabe', quiet_strecken: 'Deckel/Laufzeit', raum_offset: 'Raumeinfluss', vorausschau: 'Vorausschau', heizregelung: 'Heizregelung'};
    var SCHRITTE = {training: 'Training', cop_eta: 'COP-Gütegrad', replay: 'Replay', kennzahlen: 'Kennzahlen', sicherung: 'Sicherung'};
    L.REGELN = REGELN;

    L.daten = function (fs, jetzt, cache, basis) {
        var R = leser(fs, basis || '/data/optimizer-tools'), C = cache || {};
        var S = R.json('status.json'), st = S.j && typeof S.j === 'object' ? S.j : null, T = (st && st.training) || null;
        // ---- Parameterdateien der letzten 14 Tage (geparst nur bei neuer Datei: Zeit + Groesse)
        var namen = R.liste('training').filter(function (n) { return /^(wp_params|kandidat)_\d{4}-\d\d-\d\d\.json$/.test(n); }).sort(function (a, b) { return a.slice(-15) < b.slice(-15) ? -1 : a.slice(-15) > b.slice(-15) ? 1 : (a < b ? -1 : 1); });
        var jung = namen.length ? tagN(namen[namen.length - 1].slice(-15, -5)) : null;
        namen = namen.filter(function (n) { return jung - tagN(n.slice(-15, -5)) < FENSTER; });
        var saetze = [], fehlerDatei = [];
        namen.forEach(function (n) {
            var s = R.sig('training/' + n), c = C[n];
            if (c && s !== null && c.sig === s) { saetze.push(c.sum); return; }
            var x = R.json('training/' + n);
            if (x.j && typeof x.j === 'object') { var sum = zusammen(x.j, n.slice(-15, -5), /^kandidat/.test(n) ? 'k' : 'p'); C[n] = {sig: s, sum: sum}; saetze.push(sum); }
            else { fehlerDatei.push(n + ': ' + x.e); }
        });
        Object.keys(C).forEach(function (k) { if (namen.indexOf(k) < 0) { delete C[k]; } });
        var P = saetze.filter(function (s) { return s.art === 'p'; }), akt = P.length ? P[P.length - 1] : null;
        function satzBis(n) { var r = null; P.forEach(function (s) { if (tagN(s.tag) <= n) { r = s; } }); return r; }

        // ---- Karte 1: Heute gelernt
        var heute = {da: !!st, err: S.e || (st ? null : 'kein JSON'), aktualisiert: st && st.aktualisiert, hinweise: [], schritte: []};
        if (st) {
            var LL = st.letzter_lauf || null, ende = LL ? tsOf(LL.ende) : null;
            heute.lauf = LL ? {zeit: dmhm(LL.ende || LL.beginn), dauer: dauer(LL.dauer_s), ok: LL.ok !== false, alt: ende !== null && jetzt - ende > 26 * 3600000, art: LL.art || '', naechster: st.dienst && st.dienst.naechster_lauf ? dmhm(st.dienst.naechster_lauf) : '', version: st.version || ''} : null;
            heute.schritte = LL ? Object.keys(LL.schritte || {}).map(function (k) { var x = LL.schritte[k] || {}; return {n: SCHRITTE[k] || k, ok: !!x.ok, dauer: dauer(x.dauer_s), tag: dm(x.tag), fehler: x.fehler || ''}; }) : [];
            if (T) {
                var E = T.entscheidung || {}, GR = T.ampel_grenzen || {}, verl = (E.verletzt || []).map(function (v) { return typeof v === 'object' && v ? (v.name || v.id) : String(v); });
                var gate = {strom: 'Strom TOP16 RMSE (W)', wasserkreis: 'Wasserkreis RMSE (K)', pause: 'Pause Median-Fehler (min)'}, gateName = {};
                Object.keys(gate).forEach(function (id) { gateName[gate[id]] = id; });
                var K = E.kandidat || T.guete_test || {}, B = E.bisher || {}, RO = E.roh || {}, VT = T.guete_test_vorher || {};
                heute.guete = Object.keys(K).map(function (name) {
                    var m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name), id = gateName[name], fl = Array.isArray(K[name]);
                    var kv = K[name], bv = B[name], d = (!fl && ok(kv) && ok(bv) && bv !== 0) ? (kv - bv) / Math.abs(bv) : null;
                    return {name: m ? m[1] : name, u: m ? m[2] : '', fl: fl, k: kv, b: bv, roh: RO[name], vt: VT[name], d: d, grenze: ok(GR[name]) ? GR[name] : null,
                            gate: id ? (verl.indexOf(id) >= 0 || verl.indexOf(name) >= 0 ? 'verletzt' : 'ok') : null};
                });
                heute.ent = {ergebnis: E.ergebnis || '', grund: E.grund || '', aktiv: E.aktiv_tag ? dm(E.aktiv_tag) : '', bisher: E.bisher_tag ? dm(E.bisher_tag) : '', datei: E.kandidat_datei || T.datei || ''};
                var GL = T.glaettung || {}, BI = GL.bindung || {};
                heute.glaettung = {anteil: ok(GL.anteil) ? GL.anteil : null, bindung: BI.aktiv ? BI.gewicht : null, grund: BI.grund || ''};
                heute.ampel = {gruen: 'grün', gelb: 'gelb', rot: 'rot'}[T.ampel] || '', heute.trainingOk = T.ok !== false, heute.trainingFehler = T.fehler || '', heute.tag = dm(T.tag);
                heute.daten = T.daten ? {von: dmhm(T.daten.von), bis: dmhm(T.daten.bis), minuten: T.daten.minuten, laeufe: T.daten.laeufe} : null;
                var AB = T.abdeckung || null;
                heute.abdeckung = AB ? {tage: AB.tage, duenn: !!AB.duenn, grund: AB.grund || '', ausreichend: AB.baender_ausreichend, atMin: AB.at_min, atMax: AB.at_max, hinweis: AB.hinweis || '', minTage: AB.kriterien && AB.kriterien.tage,
                    baender: (AB.baender || []).map(function (b) { return {name: b.name || b.band, lauf: b.laufminuten, min: b.minuten, tage: b.tage, status: b.status || '', gut: b.status === 'ausreichend'}; })} : null;
                var DR = T.drift || {};
                heute.drift = {gegen: DR.gegen ? dm(DR.gegen) : '', werte: DR.werte, auffaellig: DR.auffaellig || 0, liste: (DR.liste || []).filter(function (e) { return e && typeof e === 'object'; }).map(function (e) {
                    return {name: e.name, vorher: e.vorher, roh: ok(e.roh) ? e.roh : e.heute, ueb: ok(e.uebernommen) ? e.uebernommen : e.heute, rel: e.rel, relU: ok(e.rel_uebernommen) ? e.rel_uebernommen : null};
                })};
                if (akt && akt.test && dm(akt.tag) === heute.tag) { heute.testTage = dm(akt.test[0]) + '–' + dm(akt.test[1]); }
                else { saetze.forEach(function (s) { if (dm(s.tag) === heute.tag && s.test) { heute.testTage = dm(s.test[0]) + '–' + dm(s.test[1]); } }); }
            }
        }
        // ---- Karte 2: Parameter-Verlauf
        var param = {saetze: P.length, von: P.length ? dm(P[0].tag) : '', bis: akt ? dm(akt.tag) : '', zeilen: [], gleich: [], fest: [], fehler: fehlerDatei};
        if (akt) {
            var d0 = tagN(akt.tag), s1 = satzBis(d0 - 1), s7 = satzBis(d0 - 7), drift = {};
            ((T && T.drift && T.drift.liste) || []).forEach(function (e) { if (e && e.name) { drift[e.name] = true; } });
            param.k0 = dm(akt.tag); param.k1 = s1 ? dm(s1.tag) : ''; param.k7 = s7 ? dm(s7.tag) : '';
            param.glaettung = akt.glaettung ? {anteil: akt.glaettung.anteil, bindung: akt.glaettung.bindung && akt.glaettung.bindung.aktiv ? akt.glaettung.bindung.gewicht : null, grund: (akt.glaettung.bindung && akt.glaettung.bindung.grund) || ''} : null;
            var blaetter = Object.keys(akt.w);
            param.gelernt = blaetter.length;
            blaetter.forEach(function (b) {
                var v0 = akt.w[b], sp = P.filter(function (s) { return ok(s.w[b]); }).map(function (s) { return [dm(s.tag), s.w[b]]; }), M = akt.meta[b] || {};
                var mn = Math.min.apply(null, sp.map(function (x) { return x[1]; })), mx = Math.max.apply(null, sp.map(function (x) { return x[1]; }));
                var v1 = s1 && ok(s1.w[b]) ? s1.w[b] : null, v7 = s7 && ok(s7.w[b]) ? s7.w[b] : null, wurzel = b.replace(/[[.].*$/, '');
                if (!ok(v0) || !sp.length || mx - mn <= 1e-9 * Math.max(1, Math.abs(mx))) { param.gleich.push({n: b, l: M.l || '', v: v0, e: M.e || '', h: M.h || '', q: M.q || ''}); return; }
                param.zeilen.push({n: b, l: M.l || '', e: M.e || '', h: M.h || '', g: M.g || '', q: M.q || '', v0: v0, v1: v1, v7: v7, roh: ok(akt.roh[b]) ? akt.roh[b] : null,
                                   d1: ok(v1) && v1 !== 0 ? (v0 - v1) / Math.abs(v1) : null, d7: ok(v7) && v7 !== 0 ? (v0 - v7) / Math.abs(v7) : null, sp: sp, drift: !!drift[b] || !!drift[wurzel]});
            });
            var gewicht = function (z) { return Math.abs(ok(z.d7) ? z.d7 : (ok(z.d1) ? z.d1 : 0)); };
            param.zeilen.sort(function (a, b) { return gewicht(b) - gewicht(a) || (a.n < b.n ? -1 : 1); });
            param.fest = akt.fest.slice().sort(function (a, b) { return a.h < b.h ? -1 : a.h > b.h ? 1 : (a.n < b.n ? -1 : 1); });
        }
        // ---- Karte 3: Guete je Band und Lernkurve
        var GRZ = (T && T.ampel_grenzen) || {};
        var guete = {kurve: saetze.map(function (s) { return {tag: dm(s.tag), art: s.art, ent: s.ent || (s.art === 'p' ? 'Satz' : 'abgelehnt'), strom: s.g.strom, wk: s.g.wk, pause: s.g.pause, test: s.test ? dm(s.test[0]) + '–' + dm(s.test[1]) : ''}; }),
                     grenzen: {strom: GRZ['Strom TOP16 RMSE (W)'], wk: GRZ['Wasserkreis RMSE (K)'], pause: GRZ['Pause Median-Fehler (min)']}, tag: T ? dm(T.tag) : '',
                     baender: ((T && T.guete_je_band) || []).map(function (b) {
                         return {name: b.name || b.band, min: b.minuten, lauf: b.laufminuten, strom: b['Strom TOP16 RMSE (W)'], wk: b['Wasserkreis RMSE (K)'], pause: b['Pause Median-Fehler (min)'], laufF: b['Lauf Median-Fehler (min)'],
                                 np: b.n_pausen, nl: b.n_laeufe, status: b.status || '', daten: b.status === 'Daten'};
                     })};
        // ---- Karte 4: Replay und Kennzahlen
        var RP = (st && st.replay) || null, RG = RP && RP.guete ? RP.guete : null, rpJ = RP && RP.tag ? R.json('replay/' + String(RP.tag).slice(0, 10) + '.json') : {};
        var replay = {da: !!RP, tag: RP ? dm(RP.tag) : '', prozent: RG && RG.bewertbar ? RG.prozent : null, bewertbar: !!(RG && RG.bewertbar), grund: RG && RG.grund ? RG.grund : '', vorschlaege: RP ? RP.vorschlaege : null, minuten: RP ? RP.minuten : null,
                      regeln: RG ? Object.keys(RG.regeln || {}).map(function (k) { var x = RG.regeln[k] || {}; return {n: REGELN[k] || k, p: x.prozent, b: !!x.bewertbar, min: x.minuten, grund: x.grund || ''}; }) : [],
                      liste: (rpJ.j && Array.isArray(rpJ.j.vorschlaege) ? rpJ.j.vorschlaege : []).slice(0, 6).map(function (v) { return {zeit: String(v.zeit || '').slice(11, 16), regel: REGELN[v.regel] || v.regel || '', was: v.was || '', warum: v.warum || ''}; }),
                      tage: [], hinweise: st && Array.isArray(st.hinweise) ? st.hinweise.map(String) : [], fehler: st && Array.isArray(st.fehler) ? st.fehler.map(String) : [], log: []};
        var CSV = R.text('kennzahlen/tage.csv');
        if (CSV.t) {
            var zl = CSV.t.split(/\r?\n/).filter(function (z) { return z.trim(); }), kopf = zl.length ? csvZeile(zl[0]) : [], ix = {};
            kopf.forEach(function (h, i) { ix[h] = i; });
            var num = function (r, k) { var v = r[ix[k]]; return v === undefined || v === '' || !isFinite(+v) ? null : +v; }, txt = function (r, k) { var v = r[ix[k]]; return v === undefined ? '' : v; };
            replay.tage = zl.slice(1).map(csvZeile).filter(function (r) { return /^\d{4}-\d\d-\d\d$/.test(r[ix.tag]); }).sort(function (a, b) { return a[ix.tag] < b[ix.tag] ? 1 : -1; }).slice(0, 7).map(function (r) {
                return {tag: dm(r[ix.tag]), at: num(r, 'aussen.mittel'), atMin: num(r, 'aussen.min'), atMax: num(r, 'aussen.max'), strom: num(r, 'energie.strom_kwh'), waerme: num(r, 'energie.waerme_kwh'), cop: num(r, 'energie.cop'),
                        kwhKh: num(r, 'effizienz.kwh_je_gradstunde'), komfort: num(r, 'komfort.gehalten'), verlMin: num(r, 'komfort.verletzung_min'), raum: txt(r, 'komfort.schlimmster_raum'),
                        abtau: num(r, 'abtau.anzahl'), hs: num(r, 'heizstab.minuten'), bw: num(r, 'befunde.warnung'), bh: num(r, 'befunde.hinweis'), voll: num(r, 'effizienz.vollstaendig'), abw: num(r, 'effizienz.abweichung_prozent')};
            });
        }
        replay.csvFehler = CSV.e || '';
        var LOG = R.text('letzter-lauf.log');
        if (LOG.t) { replay.log = LOG.t.split(/\r?\n/).filter(function (z) { return z.trim(); }).slice(-15); }
        return {heute: heute, param: param, guete: guete, replay: replay};
    };

    // ---------------------------------------------------------------- Darstellung (Werte wie tools/ui_optik.css und eng_ui.js: Text #263238, Nebentext #546e7a, Akzent #0094ce/#00729f,
    // ok #2e7d32, Hinweis Bernstein #b45309, Fehler #c62828 (Rot nur fuer Fehler); Grundschrift 14 px, Kennzahlen 20 px, tabellarische Ziffern)
    L.css = '<style>' +
        '.ol{font-size:14px;line-height:1.45;color:#263238;font-variant-numeric:tabular-nums}' +
        '.ol-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
        '.ol-chip{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12.5px;line-height:19px;font-weight:500;white-space:nowrap;background:#eceff1;color:#455a64}' +
        '.ol-ok{background:#e6f4ea;color:#1b5e20}.ol-warn{background:#fff3e0;color:#8a4b00}.ol-bad{background:#fdecea;color:#b71c1c}' +
        '.ol-sec{margin:16px 0 8px;font-size:12px;color:#00729f;font-weight:600;text-transform:uppercase;letter-spacing:.06em}.ol-sec span{text-transform:none;letter-spacing:0;color:#546e7a;font-weight:400;margin-left:6px}' +
        '.ol-kpis{display:grid;gap:10px}.ol-kpi{border:1px solid #e0e6e9;border-radius:8px;background:#f7f9fa;padding:8px 12px;min-width:0}' +
        '.ol-kk{font-size:12.5px;color:#546e7a;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ol-kv{font-size:20px;font-weight:600;line-height:1.35;white-space:nowrap}' +
        '.ol-ks{font-size:12.5px;color:#546e7a;min-height:19px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}' +
        '.ol-dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:0}.ol-dl>dt{color:#546e7a;margin:0}.ol-dl>dd{margin:0;overflow-wrap:anywhere}' +
        '.ol table{width:100%;border-collapse:collapse;font-size:13.5px}' +
        '.ol th{text-align:right;font-weight:600;color:#455a64;padding:5px 7px;border-bottom:2px solid #cfd8dc;font-size:12.5px;white-space:nowrap;vertical-align:bottom}' +
        '.ol td{text-align:right;padding:5px 7px;border-bottom:1px solid #eceff1;vertical-align:middle;white-space:nowrap}.ol tr:nth-child(even)>td{background:#f7f9fa}' +
        '.ol th.l,.ol td.l{text-align:left}.ol td.w{white-space:normal}.ol td.m{color:#546e7a}.ol td b{font-weight:600}' +
        '.ol .okt{color:#2e7d32}.ol .warnt{color:#b45309}.ol .badt{color:#c62828}.ol .mute{color:#546e7a}' +
        '.ol code{font-family:inherit;font-weight:600}' +
        '.ol details{margin:14px 0 4px}.ol details>summary{cursor:pointer;outline:none;font-size:12px;color:#00729f;font-weight:600;text-transform:uppercase;letter-spacing:.06em}' +
        '.ol details>summary span{text-transform:none;letter-spacing:0;color:#546e7a;font-weight:400;margin-left:6px}.ol details[open]>summary{margin-bottom:8px}' +
        '.ol-gl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 16px;font-size:13px}.ol-gl>div{display:flex;justify-content:space-between;gap:8px;padding:3px 2px;border-bottom:1px solid #eceff1;min-width:0}' +
        '.ol-gl span{color:#546e7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ol-gl b{font-weight:600;white-space:nowrap}' +
        '.ol-li{margin:0;padding:0;list-style:none;font-size:13.5px}.ol-li li{display:flex;gap:8px;align-items:baseline;padding:4px 2px;border-bottom:1px solid #eceff1}.ol-li li i{flex:0 0 8px;height:8px;border-radius:50%;margin-top:4px}' +
        '.ol pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#37474f;white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f9fa;border:1px solid #e0e6e9;border-radius:8px;padding:8px 10px}' +
        '.ol-kurve{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.ol-kurve svg{display:block;width:100%;height:auto;overflow:visible}' +
        '.ol-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:#546e7a;margin:6px 0 0}.ol-leg svg{vertical-align:middle;margin-right:4px}' +
        '.ol-leer{border:1px dashed #b0bec5;border-radius:8px;padding:10px 12px;color:#546e7a;font-size:13px}' +
        '</style>';
    function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function tt(t) { return t ? ' title="' + esc(t) + '"' : ''; }
    function chip(t, c, title) { return '<span class="ol-chip ol-' + esc(c || 'mute') + '"' + tt(title) + '>' + esc(t) + '</span>'; }
    function sec(t, neben, title) { return '<div class="ol-sec"' + tt(title) + '>' + esc(t) + (neben ? '<span>' + esc(neben) + '</span>' : '') + '</div>'; }
    function kpis(list, spalten) {
        return '<div class="ol-kpis" style="grid-template-columns:repeat(' + (spalten || list.length || 1) + ',minmax(0,1fr))">' + list.map(function (t) {
            return '<div class="ol-kpi"' + tt(t.title) + '><div class="ol-kk">' + esc(t.k) + '</div><div class="ol-kv' + (t.vc ? ' ' + t.vc : '') + '">' + esc(t.v) + '</div><div class="ol-ks">' + (t.chip ? chip(t.chip, t.c) : '') + (t.s ? '<span>' + esc(t.s) + '</span>' : '') + '</div></div>';
        }).join('') + '</div>';
    }
    function leer(t) { return '<div class="ol-leer">' + esc(t) + '</div>'; }
    function anteil(a) { return !ok(a) ? '–' : Math.abs(a - 1 / 3) < 0.002 ? '⅓' : f(a, 2); }

    // ---------------------------------------------------------------- Karte 1: Heute gelernt
    function heute(P) {
        if (!P.da) { return '<div class="ol-row">' + chip(P.err === 'fehlt' ? 'kein Lauf' : 'status.json ' + (P.err || 'nicht lesbar'), P.err === 'fehlt' ? 'warn' : 'bad') + '</div>'; }
        var L0 = P.lauf, h = '<div class="ol-row">';
        h += L0 ? chip('Lauf ' + L0.zeit + ' · ' + L0.dauer, !L0.ok ? 'bad' : (L0.alt ? 'warn' : 'ok'), (L0.alt ? 'älter als 26 h · ' : '') + 'Art ' + L0.art + (L0.naechster ? ' · nächster Lauf ' + L0.naechster : '') + (L0.version ? ' · Stand ' + L0.version : '')) : chip('kein Lauf', 'warn');
        if (P.ent) { h += chip(P.ent.ergebnis || 'keine Entscheidung', P.ent.ergebnis === 'übernommen' ? 'ok' : (P.ent.ergebnis ? 'warn' : 'mute'), P.ent.grund); }
        if (P.ampel) { h += chip('Ampel ' + P.ampel, P.ampel === 'grün' ? 'ok' : (P.ampel === 'rot' ? 'bad' : 'warn')); }
        if (P.trainingOk === false) { h += chip('Training: Fehler', 'bad', P.trainingFehler); }
        h += '</div>';
        if (P.schritte.length) {
            h += sec('Schritte', L0 && L0.naechster ? 'nächster Lauf ' + L0.naechster : '') + kpis(P.schritte.map(function (s) {
                return {k: s.n, v: s.dauer, chip: s.ok ? 'ok' : 'Fehler', c: s.ok ? 'ok' : 'bad', s: s.tag !== '–' ? 'Tag ' + s.tag : '', title: s.fehler};
            }));
        }
        if (P.ent) {
            var G = P.glaettung || {};
            h += sec('Entscheidung') + '<dl class="ol-dl">' +
                '<dt>Ergebnis</dt><dd><b class="' + (P.ent.ergebnis === 'übernommen' ? 'okt' : 'warnt') + '">' + esc(P.ent.ergebnis || '–') + '</b>' + (P.ent.grund ? ' · ' + esc(P.ent.grund) : '') + '</dd>' +
                '<dt>Parametersatz</dt><dd>' + esc((P.ent.aktiv ? 'aktiv vom ' + P.ent.aktiv : '–') + (P.ent.bisher ? ' · bisher ' + P.ent.bisher : '')) + '</dd>' +
                '<dt>Glättung</dt><dd>' + esc(anteil(G.anteil) + ' je Nacht' + (ok(G.bindung) ? ' · Bindung ' + f(G.bindung, 2) + (G.grund ? ' (' + G.grund + ')' : '') : ' · ohne Bindung')) + '</dd>' +
                (P.daten ? '<dt>Daten</dt><dd>' + esc(P.daten.von + ' bis ' + P.daten.bis + ' · ' + P.daten.minuten + ' min · ' + P.daten.laeufe + ' Läufe') + '</dd>' : '') + '</dl>';
        }
        if (P.guete && P.guete.length) {
            h += sec('Güte Kandidat gegen bisher', P.testTage ? 'Testtage ' + P.testTage : '') + '<table><tr><th class="l">Kennzahl</th><th class="l">Einheit</th><th>Kandidat</th><th>bisher</th><th>Änderung</th><th>roh gelernt</th><th title="Güte des Vortagslaufs auf dessen Testtagen">Vortag</th><th>Grenze</th><th>Gate</th></tr>' +
                P.guete.map(function (g) {
                    var v = function (x) { return Array.isArray(x) ? sig(x[0]) + ' / ' + sig(x[1]) : sig(x); };
                    var dc = !ok(g.d) ? '' : (g.d < -0.005 ? 'okt' : (g.d > 0.1 ? 'warnt' : ''));
                    return '<tr' + (g.fl ? ' title="Zwilling / Messung"' : '') + '><td class="l">' + esc(g.name) + '</td><td class="l m">' + esc(g.u) + '</td><td><b>' + v(g.k) + '</b></td><td>' + v(g.b) + '</td><td class="' + dc + '">' + pz(g.d) + '</td><td>' + v(g.roh) + '</td><td class="m">' + v(g.vt) + '</td><td class="m">' + (ok(g.grenze) ? sig(g.grenze) : '') + '</td><td>' +
                        (g.gate ? chip(g.gate, g.gate === 'ok' ? 'ok' : 'warn') : '') + '</td></tr>';
                }).join('') + '</table>';
        }
        var A = P.abdeckung;
        if (A) {
            h += sec('Abdeckung', A.tage + ' Tage' + (A.duenn ? ' (Dünn-Daten-Phase bis ' + (A.minTage || 21) + ')' : '') + ' · ' + A.ausreichend + ' von ' + A.baender.length + ' Außenbändern · Außen ' + f(A.atMin, 0) + '…' + f(A.atMax, 0) + ' °C', A.hinweis) +
                kpis(A.baender.map(function (b) { return {k: b.name, v: ok(b.lauf) ? b.lauf + ' min' : '–', chip: b.gut ? 'ausreichend' : (b.lauf ? 'wenig' : 'extrapoliert'), c: b.gut ? 'ok' : 'warn', s: (b.tage || 0) + ' Tage', title: 'Laufminuten ' + b.lauf + ' von ' + b.min + ' Minuten · ' + b.status}; }));
        }
        var D = P.drift;
        if (D) {
            h += sec('Drift', (D.gegen ? 'gegen ' + D.gegen + ' · ' : '') + D.auffaellig + (ok(D.werte) ? ' von ' + D.werte : '') + ' auffällig');
            h += D.liste.length ? '<table><tr><th class="l">Parameter</th><th>vorher</th><th>roh gelernt</th><th>Änderung roh</th><th>übernommen</th><th>Änderung übernommen</th></tr>' + D.liste.map(function (e) {
                return '<tr><td class="l"><code>' + esc(e.name) + '</code></td><td>' + sig(e.vorher) + '</td><td>' + sig(e.roh) + '</td><td class="warnt">' + pz(e.rel) + '</td><td><b>' + sig(e.ueb) + '</b></td><td>' + pz(e.relU) + '</td></tr>';
            }).join('') + '</table>' : '<div class="ol-row">' + chip('keine auffällige Drift', 'ok') + '</div>';
        }
        return h;
    }
    // ---------------------------------------------------------------- Karte 2: Was sich veraendert (Parameter-Verlauf)
    function spark(sp) {
        var W = 96, H = 22, n = sp.length, vs = sp.map(function (x) { return x[1]; }), mn = Math.min.apply(null, vs), mx = Math.max.apply(null, vs), r = mx - mn || 1;
        var pts = sp.map(function (x, i) { return [n > 1 ? 3 + i * (W - 6) / (n - 1) : W / 2, mx === mn ? H / 2 : 3 + (H - 6) * (1 - (x[1] - mn) / r)]; });
        var t = sp.map(function (x) { return x[0] + ' ' + sig(x[1]); }).join(' · '), last = pts[pts.length - 1];
        return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Verlauf"><title>' + esc(t) + '</title>' +
            '<polyline fill="none" stroke="#0094ce" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>' +
            '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.5" fill="#0094ce"/></svg>';
    }
    function param(P) {
        if (!P.saetze) { return leer('Noch keine Parametersätze (training/wp_params_<Tag>.json)'); }
        var G = P.glaettung, h = '<div class="ol-row">' + chip(P.saetze + (P.saetze === 1 ? ' Satz' : ' Sätze') + ' ' + P.von + '–' + P.bis, 'mute') + chip(P.gelernt + ' gelernte Werte', 'mute') +
            chip(P.zeilen.length + ' verändert', P.zeilen.length ? 'mute' : 'ok') + (G ? chip('Glättung ' + anteil(G.anteil) + (ok(G.bindung) ? ' · Bindung ' + f(G.bindung, 2) : ''), 'mute', G.grund) : '') +
            (P.fehler.length ? chip(P.fehler.length + ' Datei' + (P.fehler.length === 1 ? '' : 'en') + ' nicht lesbar', 'bad', P.fehler.join(' · ')) : '') + '</div>';
        if (P.zeilen.length) {
            var kopf = '<table><tr><th class="l">Parameter</th><th class="l">Einheit</th><th class="l" title="M Messung/gefittet, A Annahme, F Forum, H Servicehandbuch, S Datenblatt, N Nutzer">Herk.</th>' +
                '<th>' + esc(P.k0) + '</th><th>' + esc(P.k1 || 'Vortag') + '</th><th>' + esc(P.k7 || 'vor 7 Tagen') + '</th><th class="l">Verlauf</th><th title="heute roh gelernt, übernommen wird der geglättete Wert">roh</th><th>Änderung 7 Tage</th></tr>';
            var zeile = function (z) {
                var d = ok(z.d7) ? z.d7 : null;
                return '<tr' + tt((z.g ? z.g + ' · ' : '') + z.q) + '><td class="l"><code>' + esc(z.n) + '</code>' + (z.l ? ' <span class="mute">' + esc(z.l) + '</span>' : '') + (z.drift ? ' ' + chip('Drift', 'warn', 'heute auffällig (roh > 10 %)') : '') + '</td><td class="l m">' + esc(z.e) + '</td><td class="l m">' + esc(z.h) + '</td>' +
                    '<td><b>' + sig(z.v0) + '</b></td><td>' + sig(z.v1) + '</td><td>' + sig(z.v7) + '</td><td class="l">' + spark(z.sp) + '</td><td class="m">' + sig(z.roh) + '</td>' +
                    '<td class="' + (ok(d) && Math.abs(d) > 0.1 ? 'warnt' : '') + '"' + tt(ok(z.d1) ? 'zum Vortag ' + pz(z.d1) : '') + '>' + pz(d) + '</td></tr>';
            };
            var oben = P.zeilen.slice(0, L.OFFEN), rest = P.zeilen.slice(L.OFFEN);
            h += sec('Gelernt und verändert', rest.length ? 'die ' + oben.length + ' größten Änderungen' : 'sortiert nach Änderung') + kopf + oben.map(zeile).join('') + '</table>';
            if (rest.length) { h += '<details data-k="rest"><summary>Weitere veränderte Werte<span>' + rest.length + '</span></summary>' + kopf + rest.map(zeile).join('') + '</table></details>'; }
        } else { h += '<div class="ol-row" style="margin-top:10px">' + chip('keine Änderung in ' + P.saetze + ' Sätzen', 'ok') + '</div>'; }
        if (P.gleich.length) {
            h += '<details data-k="gleich"><summary>Gelernt, unverändert<span>' + P.gleich.length + ' Werte</span></summary><div class="ol-gl">' + P.gleich.map(function (g) {
                return '<div' + tt((g.l ? g.l + ' · ' : '') + g.q) + '><span>' + esc(g.n) + '</span><b>' + sig(g.v) + (g.e && g.e !== '–' ? ' ' + esc(g.e) : '') + '</b></div>';
            }).join('') + '</div></details>';
        }
        if (P.fest.length) {
            var zahl = {}; P.fest.forEach(function (x) { zahl[x.h] = (zahl[x.h] || 0) + 1; });
            h += '<details data-k="fest"><summary>Feste Werte<span>' + P.fest.length + ' · ' + Object.keys(zahl).sort().map(function (k) { return k + ' ' + zahl[k]; }).join(' · ') + '</span></summary>' +
                '<table><tr><th class="l">Parameter</th><th>Wert</th><th class="l">Einheit</th><th class="l">Herkunft</th></tr>' + P.fest.map(function (x) {
                    var v = x.v.length > 34 ? x.v.slice(0, 33) + '…' : x.v;
                    return '<tr' + tt(x.q) + '><td class="l"><code>' + esc(x.n) + '</code></td><td' + (v !== x.v ? tt(x.v) : '') + '>' + esc(v) + '</td><td class="l m">' + esc(x.e) + '</td><td class="l m">' + esc(x.h) + '</td></tr>';
                }).join('') + '</table></details>';
        }
        return h;
    }
    // ---------------------------------------------------------------- Karte 3: Guete je Aussenband und Lernkurve (drei kleine Diagramme, eine Achse je Groesse)
    function kurve(K, key, titel, einheit, grenze) {
        var W = 280, H = 132, l = 34, r = 8, o = 20, u = 22, pw = W - l - r, ph = H - o - u;
        var pts = K.map(function (k, i) { return {i: i, v: k[key], k: k}; }).filter(function (p) { return ok(p.v); });
        var mx = Math.max.apply(null, pts.map(function (p) { return p.v; }).concat(ok(grenze) ? [grenze] : [0])) * 1.1 || 1, n = K.length;
        var X = function (i) { return l + (n > 1 ? i * pw / (n - 1) : pw / 2); }, Y = function (v) { return o + ph * (1 - v / mx); };
        var stufe = mx / 3 > 10 ? Math.ceil(mx / 3 / 10) * 10 : mx / 3 > 1 ? Math.ceil(mx / 3) : Math.ceil(mx / 3 * 10) / 10, dec = stufe < 1 ? 1 : 0;
        var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(titel) + '"><text x="0" y="12" font-size="12.5" fill="#455a64" font-weight="600">' + esc(titel) + '</text><text x="' + W + '" y="12" font-size="12" fill="#546e7a" text-anchor="end">' + esc(einheit) + '</text>';
        for (var g = 0; g <= mx + 1e-9; g += stufe) { s += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '" stroke="#eceff1"/><text x="' + (l - 5) + '" y="' + (Y(g) + 4).toFixed(1) + '" font-size="11" fill="#546e7a" text-anchor="end">' + f(g, dec) + '</text>'; }
        if (ok(grenze)) { s += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + Y(grenze).toFixed(1) + '" y2="' + Y(grenze).toFixed(1) + '" stroke="#90a4ae" stroke-dasharray="4 3"><title>Ampelgrenze ' + sig(grenze) + ' ' + esc(einheit) + '</title></line>'; }
        var lin = pts.filter(function (p) { return p.k.art === 'p'; });
        if (lin.length > 1) { s += '<polyline fill="none" stroke="#0094ce" stroke-width="2" stroke-linejoin="round" points="' + lin.map(function (p) { return X(p.i).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ') + '"/>'; }
        pts.forEach(function (p) {
            var t = p.k.tag + ' · ' + (p.k.art === 'p' ? (p.k.ent === 'übernommen' || p.k.ent === 'Satz' ? 'Satz' : p.k.ent) : 'Kandidat abgelehnt') + ' · ' + sig(p.v) + ' ' + einheit + (p.k.test ? ' · Testtage ' + p.k.test : '');
            s += p.k.art === 'p' ? '<circle cx="' + X(p.i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="4" fill="#0094ce" stroke="#fff" stroke-width="2"><title>' + esc(t) + '</title></circle>'
                                 : '<circle cx="' + X(p.i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="4" fill="#fff" stroke="#b45309" stroke-width="2"><title>' + esc(t) + '</title></circle>';
        });
        var schritt = Math.max(1, Math.ceil(n / 5));
        K.forEach(function (k, i) { if (i % schritt === 0 || i === n - 1) { if (i !== n - 1 && n - 1 - i < schritt) { return; } s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" font-size="11" fill="#546e7a" text-anchor="' + (i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle') + '">' + esc(k.tag) + '</text>'; } });
        return s + '</svg>';
    }
    function guete(P) {
        var h = '';
        if (P.kurve.length) {
            var abg = P.kurve.some(function (k) { return k.art === 'k'; });
            h += sec('Lernkurve', 'Testfehler je Trainingstag') + '<div class="ol-kurve">' + kurve(P.kurve, 'strom', 'Strom RMSE', 'W', P.grenzen.strom) + kurve(P.kurve, 'wk', 'Wasserkreis RMSE', 'K', P.grenzen.wk) + kurve(P.kurve, 'pause', 'Pause Median-Fehler', 'min', P.grenzen.pause) + '</div>' +
                '<div class="ol-leg"><span><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#0094ce"/></svg>übernommener Satz</span>' + (abg ? '<span><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#fff" stroke="#b45309" stroke-width="2"/></svg>abgelehnter Kandidat</span>' : '') +
                '<span><svg width="18" height="12"><line x1="0" x2="18" y1="6" y2="6" stroke="#90a4ae" stroke-dasharray="4 3"/></svg>Ampelgrenze</span></div>';
        } else { h += leer('Noch keine Parametersätze für die Lernkurve'); }
        if (P.baender.length) {
            h += sec('Güte je Außenband', P.tag ? 'Testtage des Laufs vom ' + P.tag : '') + '<table><tr><th class="l">Außen</th><th>Minuten</th><th>davon Lauf</th><th>Strom W</th><th>Wasserkreis K</th><th>Pause min</th><th>Lauf min</th><th class="l">Status</th></tr>' +
                P.baender.map(function (b) {
                    var g = function (v, gr) { return '<td' + (ok(v) && ok(gr) && v > gr ? ' class="warnt"' : '') + '>' + (ok(v) ? sig(v) : '–') + '</td>'; };
                    return '<tr><td class="l">' + esc(b.name) + '</td><td>' + (ok(b.min) ? b.min : '–') + '</td><td>' + (ok(b.lauf) ? b.lauf : '–') + '</td>' + g(b.strom, P.grenzen.strom) + g(b.wk, P.grenzen.wk) +
                        '<td' + tt(ok(b.np) ? b.np + ' Pausen' : '') + (ok(b.pause) && ok(P.grenzen.pause) && b.pause > P.grenzen.pause ? ' class="warnt"' : '') + '>' + (ok(b.pause) ? sig(b.pause) : '–') + '</td><td' + tt(ok(b.nl) ? b.nl + ' Läufe' : '') + '>' + (ok(b.laufF) ? sig(b.laufF) : '–') + '</td>' +
                        '<td class="l">' + chip(b.daten ? 'Daten' : (b.status || '–'), b.daten ? 'ok' : 'warn') + '</td></tr>';
                }).join('') + '</table>';
        }
        return h;
    }
    // ---------------------------------------------------------------- Karte 4: Replay und Kennzahlen
    function replay(P) {
        var h = '';
        if (P.da) {
            h += '<div class="ol-row">' + chip('Replay ' + P.tag + ' · ' + (P.bewertbar && ok(P.prozent) ? f(P.prozent, 1) + ' % gleich wie live' : 'nicht bewertbar'), P.bewertbar && ok(P.prozent) ? (P.prozent >= 99 ? 'ok' : 'warn') : 'warn', P.grund) +
                 chip((ok(P.vorschlaege) ? P.vorschlaege : 0) + (P.vorschlaege === 1 ? ' Vorschlag' : ' Vorschläge'), 'mute') + (ok(P.minuten) ? chip(P.minuten + ' Minuten', 'mute') : '') + '</div>';
            if (P.regeln.length) {
                h += sec('Gleich wie live je Regel') + kpis(P.regeln.map(function (r) {
                    return {k: r.n, v: r.b && ok(r.p) ? f(r.p, 1) + ' %' : '–', vc: r.b && ok(r.p) && r.p < 99 ? 'warnt' : '', s: r.b ? (ok(r.min) ? r.min + ' min' : '') : 'nicht bewertbar', title: r.grund};
                }));
            }
            if (P.liste.length) {
                h += sec('Vorschläge im Replay') + '<table><tr><th class="l">Zeit</th><th class="l">Regel</th><th class="l">Was</th></tr>' + P.liste.map(function (v) {
                    return '<tr' + tt(v.warum) + '><td class="l">' + esc(v.zeit) + '</td><td class="l">' + esc(v.regel) + '</td><td class="l w">' + esc(v.was) + '</td></tr>';
                }).join('') + '</table>';
            }
        } else { h += '<div class="ol-row">' + chip('noch kein Replay', 'mute') + '</div>'; }
        if (P.tage.length) {
            h += sec('Kennzahlen', 'letzte ' + P.tage.length + ' Tage') + '<table><tr><th class="l">Tag</th><th>Außen °C</th><th>Strom kWh</th><th>Wärme kWh</th><th>COP</th><th title="kWh Strom je Gradstunde">kWh/Kh</th><th class="l">Komfort</th><th>Abtau</th><th title="Minuten Heizstab">Heizstab</th><th class="l" title="Warnungen · Hinweise">Befunde</th></tr>' +
                P.tage.map(function (t) {
                    var kom = t.komfort === 1 ? '<span class="okt">gehalten</span>' : (t.komfort === 0 ? '<span class="warnt">' + (ok(t.verlMin) ? t.verlMin + ' min' : 'verletzt') + (t.raum && t.raum !== '-' ? ' · ' + esc(t.raum) : '') + '</span>' : '–');
                    var bef = (t.bw ? '<span class="warnt">' + t.bw + ' W</span>' : '') + (t.bw && t.bh ? ' · ' : '') + (t.bh ? t.bh + ' H' : '') || '–';
                    return '<tr' + (t.voll === 0 ? ' title="Tag unvollständig"' : '') + '><td class="l">' + esc(t.tag) + (t.voll === 0 ? ' <span class="mute">(Teil)</span>' : '') + '</td><td' + tt(ok(t.atMin) ? f(t.atMin, 0) + '…' + f(t.atMax, 0) + ' °C' : '') + '>' + f(t.at, 1) + '</td><td>' + f(t.strom, 2) + '</td><td>' + f(t.waerme, 1) + '</td><td><b>' + f(t.cop, 2) + '</b></td>' +
                        '<td' + tt(ok(t.abw) ? pz(t.abw / 100, 0) + ' zum Mittel der Vortage' : '') + '>' + f(t.kwhKh, 4) + '</td><td class="l">' + kom + '</td><td>' + (ok(t.abtau) ? t.abtau : '–') + '</td><td>' + (ok(t.hs) ? t.hs : '–') + '</td><td class="l">' + bef + '</td></tr>';
                }).join('') + '</table>';
        } else if (P.csvFehler) { h += sec('Kennzahlen') + leer('kennzahlen/tage.csv ' + P.csvFehler); }
        if (P.fehler.length || P.hinweise.length) {
            h += sec('Meldungen des Laufs', (P.fehler.length ? P.fehler.length + ' Fehler · ' : '') + P.hinweise.length + ' Hinweise') + '<ul class="ol-li">' +
                P.fehler.map(function (t) { return '<li><i style="background:#c62828"></i><span class="badt">' + esc(t) + '</span></li>'; }).join('') +
                P.hinweise.map(function (t) { return '<li><i style="background:#b45309"></i><span>' + esc(t) + '</span></li>'; }).join('') + '</ul>';
        }
        if (P.log.length) { h += '<details data-k="log"><summary>Protokoll des letzten Laufs<span>' + P.log.length + ' Zeilen</span></summary><pre>' + esc(P.log.join('\n')) + '</pre></details>'; }
        return h;
    }
    L.html = function (kind, P) { P = P || {}; return '<div class="ol">' + (kind === 'heute' ? heute(P) : kind === 'param' ? param(P) : kind === 'guete' ? guete(P) : replay(P)) + '</div>'; };
    L.mount = function (el, kind, P) {
        try {
            if (!el || !P) { return; }
            if (typeof document !== 'undefined') {
                var cs = document.getElementById('ol_css');
                if (!cs || cs.getAttribute('data-v') !== String(VER)) { var d = document.createElement('div'); d.innerHTML = L.css.replace('<style>', '<style id="ol_css" data-v="' + VER + '">'); if (cs) { cs.parentNode.replaceChild(d.firstChild, cs); } else { document.head.appendChild(d.firstChild); } }
            }
            var open = el.__olOpen = el.__olOpen || {};
            el.innerHTML = L.html(kind, P);
            Array.prototype.forEach.call(el.querySelectorAll('details[data-k]'), function (dd) {
                var k = dd.getAttribute('data-k'); if (open[k]) { dd.open = true; }
                dd.addEventListener('toggle', function () { open[k] = dd.open; var F = root.__optFit; if (F && F.fns) { setTimeout(function () { Object.keys(F.fns).forEach(function (x) { F.fns[x](); }); }, 30); } });
            });
        } catch (e) { /* Karte bleibt leer */ }
    };
    root.optLern = L;
    if (typeof module !== 'undefined' && module.exports) { module.exports = L; }
})(typeof window !== 'undefined' ? window : globalThis);

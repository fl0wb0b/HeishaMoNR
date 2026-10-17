// „Training“ des Anlagen-Zwillings (tools/wp_zwilling.js) = Parameterschätzung aus den echten Minutenprotokollen (kein neuronales Netz).
// Verfahren: kleinste Quadrate (Wärme, Strom, Lüfter, Rohr), Rastersuche (Start/Stopp, Pumpenprofil), Koordinatensuche gegen Simulation
// (Verdichter-Regler, Wasserkreis, Haus, Räume). Ohne Fremdbibliotheken, deterministisch (gleiche Daten → bit-identische Ausgabe).
// Trennung Trainings-/Testtage: Fit nur auf den Trainingstagen, Güte auf beiden; die Werte für den Zwilling (werte) kommen aus dem Fit über alle Tage.
// Liest nur: quiet-YYYY-MM.csv (1 min), optimizer-v2-YYYY-MM.csv (5 min: Räume, Wetter), energy-YYYY-MM.csv (5 min: PV).
// Usage: node tools/wp_training.js <Datenordner> [--json wp_params.json] [--md bericht.md] [--train JJJJ-MM-TT..JJJJ-MM-TT] [--test JJJJ-MM-TT..JJJJ-MM-TT]
//                                  [--monat 2026-10,2026-11] [--tage 21] [--still]
//   --monat: Monatsdateien (Standard: alle quiet-*.csv im Ordner), --tage: nur die letzten n Kalendertage (nächtliches Training)
//   Standard-Trennung: die letzten 4 Kalendertage testen, alle früheren trainieren (Daten bis 15.10.: 07.–11. Training, 12.–15. Test).
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const Z = require('./wp_zwilling.js');

const MIN = 60000, VERSION = 1;
const RAEUME = ['ki_oben', 'ki_unten', 'schlaf', 'wohn'];
const HAUS_RAEUME = ['ki_unten', 'schlaf'];        // Hausmittel: immer gemessen; Wohnzimmer mit Eigenerwärmung/Lücken, Kinderzimmer oben mit eigenem Relais und Heizlüfter

// ------------------------------------------------------------------ Hilfen
const num = x => { if (x === undefined || x === null || x === '') { return null; } const v = Number(x); return isFinite(v) ? v : null; };
const pad = x => String(x).padStart(2, '0');
const ymd = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const rd = (x, k) => x === null || x === undefined || !isFinite(x) ? null : Math.round(x * Math.pow(10, k)) / Math.pow(10, k);
const de = (x, k) => x === null || x === undefined || !isFinite(x) ? '–' : Number(x).toFixed(k === undefined ? 2 : k).replace('.', ',').replace(/^-/, '−');
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => { if (!a.length) { return null; } const b = a.slice().sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };
const rmse = a => a.length ? Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) : null;
const clone = o => JSON.parse(JSON.stringify(o));

function readMulti(file) {                                                         // CSV mit wechselnden Kopfzeilen (jede Zeile „zeit,…“ setzt den Kopf neu)
    const rows = []; let head = null;
    if (!fs.existsSync(file)) { return rows; }
    fs.readFileSync(file, 'utf8').split('\n').forEach(l => {
        if (!l) { return; }
        const p = l.split(',');
        if (p[0] === 'zeit') { head = p; return; }
        if (!head || p.length !== head.length) { return; }
        const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(p[0]);
        if (!m) { return; }
        const o = {}; head.forEach((h, i) => { o[h] = p[i]; });
        o._t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        rows.push(o);
    });
    return rows.sort((a, b) => a._t - b._t);
}
function lsq(X, y, w) {                                                            // kleinste Quadrate (Normalgleichungen, Gauß mit Pivot), w optional
    const k = X[0].length, A = [], b = new Array(k).fill(0);
    for (let a = 0; a < k; a++) { A.push(new Array(k).fill(0)); }
    for (let i = 0; i < X.length; i++) { const wi = w ? w[i] : 1; for (let a = 0; a < k; a++) { b[a] += wi * X[i][a] * y[i]; for (let c = 0; c < k; c++) { A[a][c] += wi * X[i][a] * X[i][c]; } } }
    for (let a = 0; a < k; a++) { A[a][a] += 1e-9 * (1 + A[a][a]); }
    for (let i = 0; i < k; i++) {
        let p = i; for (let r = i + 1; r < k; r++) { if (Math.abs(A[r][i]) > Math.abs(A[p][i])) { p = r; } }
        [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
        for (let r = i + 1; r < k; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < k; c++) { A[r][c] -= f * A[i][c]; } b[r] -= f * b[i]; }
    }
    const x = new Array(k);
    for (let i = k - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < k; c++) { s -= A[i][c] * x[c]; } x[i] = s / A[i][i]; }
    const res = X.map((r, i) => r.reduce((s, v, j) => s + v * x[j], 0) - y[i]);
    return {x: x, rmse: rmse(res), n: X.length};
}
function lsqBox(X, y, lo, hi) {                                                   // kleinste Quadrate mit Grenzen (aktive Menge: verletzte Koeffizienten auf die Grenze, Rest neu)
    const k = X[0].length, fix = new Array(k).fill(null);
    for (let it = 0; it <= k; it++) {
        const frei = []; for (let j = 0; j < k; j++) { if (fix[j] === null) { frei.push(j); } }
        const yr = y.map((v, i) => v - fix.reduce((s, f, j) => s + (f === null ? 0 : f * X[i][j]), 0));
        const f = frei.length ? lsq(X.map(r => frei.map(j => r[j])), yr) : {x: []};
        const x = fix.slice(); frei.forEach((j, n) => { x[j] = f.x[n]; });
        let worst = -1, wv = 0; frei.forEach(j => { const v = x[j] < lo[j] ? lo[j] - x[j] : (x[j] > hi[j] ? x[j] - hi[j] : 0); if (v > wv + 1e-12) { wv = v; worst = j; } });
        if (worst < 0) { const res = X.map((r, i) => r.reduce((s, v, j) => s + v * x[j], 0) - y[i]); return {x: x, rmse: rmse(res), n: X.length}; }
        fix[worst] = x[worst] < lo[worst] ? lo[worst] : hi[worst];
    }
    return null;
}
function koordinatensuche(start, schritte, kosten, runden) {                       // deterministische Koordinatensuche: je Parameter feste Kandidaten (relativ oder absolut)
    let best = clone(start), bk = kosten(best), it = 0;
    for (let r = 0; r < (runden || 4); r++) {
        let besser = false;
        Object.keys(schritte).forEach(k => {
            const cand = schritte[k](best[k]);
            cand.forEach(v => { if (v === best[k]) { return; } const t = Object.assign({}, best); t[k] = v; const c = kosten(t); it++; if (c < bk - 1e-12) { bk = c; best = t; besser = true; } });
        });
        if (!besser) { break; }
    }
    return {p: best, kosten: bk, n: it};
}
const rel = (fs0) => v => fs0.map(f => Math.round(v * f * 1e6) / 1e6);

// ------------------------------------------------------------------ Daten
function monateIn(dir) { return fs.readdirSync(dir).map(f => /^quiet-(\d{4}-\d\d)\.csv$/.exec(f)).filter(Boolean).map(m => m[1]).sort(); }
function lade(dir, monate, tage) {                                                  // monate: Liste 'JJJJ-MM' (Standard: alle quiet-*.csv im Ordner); tage: nur die letzten n Kalendertage
    monate = monate && monate.length ? monate : monateIn(dir);
    const alle = (pre) => [].concat.apply([], monate.map(mo => readMulti(path.join(dir, pre + '-' + mo + '.csv')))).sort((a, b) => a._t - b._t);
    const Q = alle('quiet'), V = alle('optimizer-v2'), EN = alle('energy');
    if (!Q.length) { throw new Error('keine Minutenprotokolle in ' + dir); }
    let t0 = Math.ceil(Q[0]._t / MIN) * MIN; const t1 = Q[Q.length - 1]._t, M = [];
    if (tage) { const d = new Date(t1); t0 = Math.max(t0, new Date(d.getFullYear(), d.getMonth(), d.getDate() - tage + 1).getTime()); }
    let qi = 0, vi = -1, ei = -1;
    for (let t = t0; t <= t1; t += MIN) {
        while (qi + 1 < Q.length && Q[qi + 1]._t <= t) { qi++; }
        while (vi + 1 < V.length && V[vi + 1]._t <= t) { vi++; }
        while (ei + 1 < EN.length && EN[ei + 1]._t <= t) { ei++; }
        const r = Q[qi], age = (t - r._t) / MIN, v = vi >= 0 ? V[vi] : null, e = ei >= 0 ? EN[ei] : null;
        const x = {t: t, ok: age >= 0 && age <= 6, at: num(r.aussen), soll: num(r.soll_vl), vl: num(r.ist_vl), rl: num(r.ist_rl), hz: num(r.verdichter_hz), pel: num(r.leistung_el_w), pth: num(r.leistung_th_heisha_w),
            flow: num(r.flow_l_min), pump: num(r.pumpe_speed), q: num(r.quiet_aktuell), hc: num(r.heizregelung), def: num(r.defrost), dhw: num(r.warmwasser), rt: num(r.verdichter_laufzeit_min),
            fan: num(r.fan1), pipe: num(r.rohr_aussen), hI: num(r.heizstab_intern), kzRad: num(r.kz_radiator_an), kzLW: num(r.kz_heizluefter_w), zust: r.zustand || null, shift: num(r.shift_anlage),
            rooms: {}, th: null, rh: null, owm: null, pv: 0};
        if (x.hc === null) { x.hc = 1; }                                            // vor 08.10. nicht protokolliert: Efficiency (erster Wechsel von Hand 08.10. 10:02 auf Efficiency, Annahme)
        if (v && t - v._t <= 15 * MIN) {
            RAEUME.forEach(id => { const w = num(v[id + '_wert']), a = num(v[id + '_alter_min']); x.rooms[id] = (w !== null && a !== null && a + (t - v._t) / MIN <= 720 && w > 10 && w < 35) ? w : null; });
            x.rh = num(v.wetter_feuchte); x.owm = num(v.aussen_wetter);
        } else { RAEUME.forEach(id => { x.rooms[id] = null; }); }
        const hr = HAUS_RAEUME.map(id => x.rooms[id]).filter(z => z !== null);
        x.th = hr.length === HAUS_RAEUME.length ? mean(hr) : null;
        if (e && t - e._t <= 15 * MIN) { const p = num(e.pv_w); x.pv = p === null ? 0 : Math.max(0, p) / 1000; }
        x.lauf = x.hz !== null && x.hz > 0;
        x.pumpe = x.flow !== null && x.flow > 1;
        x.tag = ymd(t);
        M.push(x);
    }
    // Läufe und Pausen
    const runs = [], pausen = [];
    let i0 = null, abgeschnitten = M.length > 0 && M[0].lauf;                      // Lauf am Fensteranfang (--tage): Beginn nicht gesehen → kein Lauf (sonst M[i0 - 1] = undefined)
    for (let i = 0; i < M.length; i++) {
        if (abgeschnitten) { if (M[i].lauf) { continue; } abgeschnitten = false; }
        if (M[i].lauf && i0 === null) { i0 = i; }
        if (!M[i].lauf && i0 !== null) {
            const last = M[i - 1], art = (last.vl !== null && last.soll !== null && last.vl >= last.soll + 2.75) ? 'thermo' : (M[i].zust === 'heizgrenze' || (M[Math.min(M.length - 1, i + 2)].flow || 0) < 1 && (M[i].at || 0) >= 14 ? 'heizgrenze' : 'sonst');
            runs.push({i0: i0, i1: i, art: art, okAll: M.slice(i0, i).every(m => m.ok)});
            i0 = null;
        }
    }
    for (let k = 0; k + 1 < runs.length; k++) {
        const a = runs[k].i1, b = runs[k + 1].i0, seg = M.slice(a, b);
        pausen.push({i0: a, i1: b, pumpeAus: seg.some(m => !m.pumpe), okAll: seg.every(m => m.ok), nachArt: runs[k].art});
    }
    M.forEach(m => { m.rm = null; });
    runs.forEach(r => { for (let i = r.i0; i < r.i1; i++) { M[i].rm = i - r.i0; } });
    return {M: M, runs: runs, pausen: pausen, von: M[0].t, bis: M[M.length - 1].t};
}
function tageVon(D) { const s = []; D.M.forEach(m => { if (s[s.length - 1] !== m.tag) { s.push(m.tag); } }); return s; }
function trennung(D, opt) {
    const tage = tageVon(D);
    const parse = s => { const m = /^(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)$/.exec(s || ''); return m ? [m[1], m[2]] : null; };
    let tr = parse(opt.train), te = parse(opt.test);
    if (!te) { const k = Math.max(1, tage.length - 4); te = [tage[k], tage[tage.length - 1]]; }
    if (!tr) { const k = tage.indexOf(te[0]); tr = [tage[0], tage[Math.max(0, k - 1)]]; }
    return {train: tr, test: te, tage: tage};
}
const inTage = (m, r) => m.tag >= r[0] && m.tag <= r[1];

// ------------------------------------------------------------------ Teil-Fits (je Funktion: Daten → Werte + Fit-Kennzahl)
function stabil(D, r) { return D.M.filter(m => m.ok && inTage(m, r) && m.lauf && m.rm !== null && m.rm >= 5 && !m.def && m.pth > 0 && m.flow > 5 && m.pel > 0 && m.at !== null && m.rl !== null); }
function vlRelVor(D, m) { const i = (m.t - D.M[0].t) / MIN, v = D.M[Math.max(0, i - 1)]; return v.vl !== null && m.soll !== null ? v.vl - m.soll : 0; }
function fitPth(D, r) {
    const S = stabil(D, r);
    const f = lsq(S.map(m => [m.hz, m.hz * (m.at - 5), m.hz * Math.max(0, vlRelVor(D, m) - 1)]), S.map(m => m.pth));
    return {pthHz: rd(f.x[0], 3), pthHzAT: rd(f.x[1], 4), pthEnde: rd(f.x[2] / f.x[0], 4), _fit: {n: f.n, rmseW: rd(f.rmse, 1), modell: 'Pth = Hz · (a + b · (AT − 5)) · (1 + c · max(0, VL − Soll − 1))'}};
}
function fitPel(D, r) { const S = stabil(D, r); const f = lsq(S.map(m => [1, m.hz, m.hz * m.rl, m.hz * m.at]), S.map(m => m.pel)); return {pel0: rd(f.x[0], 2), pelHz: rd(f.x[1], 4), pelRL: rd(f.x[2], 5), pelAT: rd(f.x[3], 5), _fit: {n: f.n, rmseW: rd(f.rmse, 1), modell: 'TOP16 = c0 + Hz · (c1 + c2 · RL + c3 · AT)', dPel_dRL_16_5Hz: rd(f.x[2] * 16.5, 2), dPel_dAT_16_5Hz: rd(f.x[3] * 16.5, 2)}}; }
function fitStandby(D, r) {
    const p = D.M.filter(m => m.ok && inTage(m, r) && !m.lauf && m.pel !== null);
    const a = p.filter(m => m.pumpe).map(m => m.pel), b = p.filter(m => !m.pumpe).map(m => m.pel);
    return {pelPauseW: a.length ? median(a) : Z.PARAM.pelPauseW[0], pelAusW: b.length ? median(b) : Z.PARAM.pelAusW[0], _fit: {nPause: a.length, nAus: b.length}};
}
function fitFlow(D, r) {
    const R = D.M.filter(m => m.ok && inTage(m, r) && m.lauf && !m.def && m.flow > 5 && m.rm !== null);
    const pf = D.M.filter(m => m.ok && inTage(m, r) && !m.lauf && m.pumpe && m.flow < 30).map(m => m.flow);
    const cf = R.filter(m => m.hc === 0).map(m => m.flow);
    const eff = R.filter(m => m.hc === 1 && m.rm <= 180);
    const flowPause = rd(median(pf), 2), flowComfort = cf.length >= 60 ? rd(median(cf), 2) : flowPause;
    // Rastersuche für das Efficiency-Profil gegen die Minutenwerte
    let best = null;
    for (let a = 10; a <= 40; a += 1) { for (let b = 15; b <= 26; b += 0.5) { for (let c = a + 5; c <= 80; c += 5) { for (let d = c + 10; d <= 150; d += 5) {
        const P = {flowEff: [a, b, c, d], flowComfort: flowPause}; let s = 0;
        for (let i = 0; i < eff.length; i++) { const e = Z.flowEffOf(P, eff[i].rm) - eff[i].flow; s += e * e; }
        if (!best || s < best.s - 1e-9) { best = {s: s, v: [a, b, c, d]}; }
    } } } }
    const sp = D.M.filter(m => m.ok && inTage(m, r) && m.pumpe && m.pump > 0 && m.flow > 5 && m.flow < 30);
    const f = lsq(sp.map(m => [1, m.flow - flowPause]), sp.map(m => m.pump));
    return {flowPause: flowPause, flowComfort: flowComfort, flowEff: best.v, pumpe0: rd(f.x[0], 0), pumpeJeL: rd(f.x[1], 1), _fit: {nEff: eff.length, rmseEff: rd(Math.sqrt(best.s / Math.max(1, eff.length)), 2), nComfort: cf.length, comfortQuelle: cf.length >= 60 ? 'gemessen' : 'zu wenig Comfort-Minuten, wie Pause', rmsePumpe: rd(f.rmse, 0)}};
}
function fitFan(D, r, P) {
    const S = stabil(D, r).filter(m => m.fan > 0 && m.q !== null);
    const X = S.map(m => [m.q === 0 ? 1 : 0, m.q === 1 ? 1 : 0, m.q === 2 ? 1 : 0, m.q === 3 ? 1 : 0, Math.max(0, m.hz - P.hzMin)]);
    const cnt = [0, 1, 2, 3].map(q => S.filter(m => m.q === q).length);
    const kalt = m => (P.fanKalt && m.at !== null && m.at <= P.fanKaltAtC) ? P.fanKalt[Math.max(0, Math.min(3, m.q))] : 0;   // Winterpaket: Lüfterstufe ≤ 4 °C (fanKalt, Messung) herausrechnen
    const f = lsq(X, S.map(m => m.fan - kalt(m)));
    const fq = [0, 1, 2, 3].map(q => cnt[q] >= 200 ? Math.round(f.x[q]) : P.fanQ[q]);          // erst ab 200 min je Stufe, sonst Messtabelle
    return {fanQ: fq, fanJeHz: rd(f.x[4], 2), _fit: {n: f.n, rmse: rd(f.rmse, 0), minutenJeQuiet: cnt}};
}
function fitPipe(D, r, P) {
    let S = stabil(D, r).filter(m => m.pipe !== null && m.fan > 0), quelle = 'Trainingstage';
    if (S.length < 300) { S = D.M.filter(m => m.ok && m.lauf && m.rm >= 5 && !m.def && m.pth > 0 && m.pel > 0 && m.pipe !== null && m.fan > 0); quelle = 'alle Tage (Spalte rohr_aussen erst ab 14.10.; keine Testtrennung)'; }
    if (S.length < 100) { return {_fit: {n: S.length, quelle: 'zu wenig Daten, Vorgabe'}}; }
    const f = lsq(S.map(m => [1, Math.max(0, m.pth - m.pel) / 1000 * 300 / m.fan]), S.map(m => m.at - m.pipe));
    return {pipe0: rd(f.x[0], 3), pipeQ: rd(f.x[1], 3), _fit: {n: f.n, rmseK: rd(f.rmse, 2), quelle: quelle, atBereich: [Math.min.apply(null, S.map(m => m.at)), Math.max.apply(null, S.map(m => m.at))]}};
}
// Stopp: Vorlauf ≥ Soll + K für H Minuten am Stück; Fehler je Lauf (nur Abschaltung über den Vorlauf)
function stoppFehler(D, r, K, H) {
    const err = [];
    D.runs.filter(x => x.art === 'thermo' && x.okAll && inTage(D.M[x.i0], r)).forEach(x => {
        let z = 0, pred = null;
        for (let i = x.i0 + 2; i < Math.min(D.M.length, x.i1 + 60); i++) {
            const m = D.M[i - 1]; if (m.vl === null || m.soll === null) { continue; }
            z = m.vl >= m.soll + K - 1e-9 ? z + 1 : 0;
            if (z >= H) { pred = i; break; }
        }
        err.push(pred === null ? 60 : Math.max(-60, Math.min(60, pred - x.i1)));
    });
    return err;
}
// Start: Pause mit Pumpe, Wartezeit ab Erreichen von Soll − K (beginnt neu, wenn der Vorlauf mehr als Hy über die Schwelle steigt), Start nach Dv Minuten
function startFehler(D, r, K, Dv, Hy) {
    const err = [];
    D.pausen.filter(p => p.okAll && !p.pumpeAus && inTage(D.M[p.i0], r)).forEach(p => {
        let z = 0, pred = null;
        for (let i = p.i0 + 1; i < Math.min(D.M.length, p.i1 + 120); i++) {
            const m = D.M[i - 1]; if (m.vl === null || m.soll === null) { continue; }
            if (m.vl <= m.soll - K + 1e-9) { z++; } else if (m.vl > m.soll - K + Hy + 1e-9) { z = 0; } else if (z > 0) { z++; }
            if (z >= Dv && z > 0 && i - p.i0 >= 3) { pred = i; break; }
        }
        err.push(pred === null ? 120 : Math.max(-120, Math.min(120, pred - p.i1)));
    });
    return err;
}
function fitStartStopp(D, r) {
    let bs = null, bt = null;
    [2.75, 3.0, 3.25, 3.5].forEach(K => { [1, 2, 3, 4, 5, 6].forEach(H => { const e = stoppFehler(D, r, K, H), c = mean(e.map(Math.abs)); if (e.length && (!bs || c < bs.c - 1e-9)) { bs = {c: c, K: K, H: H, n: e.length, bias: mean(e)}; } }); });
    [2.5, 2.75, 3.0, 3.25, 3.5].forEach(K => { [0.25, 0.5, 0.75, 1.0, 99].forEach(Hy => { for (let Dv = 1; Dv <= 25; Dv++) { const e = startFehler(D, r, K, Dv, Hy), c = mean(e.map(Math.abs)); if (e.length && (!bt || c < bt.c - 1e-9)) { bt = {c: c, K: K, D: Dv, Hy: Hy, n: e.length, bias: mean(e), med: median(e.map(Math.abs))}; } } }); });
    const o = {_fit: {}};
    if (bs) { o.stopK = bs.K; o.stopHaltMin = bs.H; o._fit.stopp = {n: bs.n, maeMin: rd(bs.c, 2), biasMin: rd(bs.bias, 2)}; }
    if (bt) { o.startK = bt.K; o.startVerzugMin = bt.D; o.startHystK = bt.Hy; o._fit.start = {n: bt.n, maeMin: rd(bt.c, 2), medianMin: bt.med, biasMin: rd(bt.bias, 2)}; }
    return o;
}
// Regler: offene Schleife mit gemessenem Vorlauf/Soll/Quiet/Heizregelung → Frequenz
function reglerFehler(D, r, P) {
    let s = 0, n = 0;
    D.runs.filter(x => x.okAll && inTage(D.M[x.i0], r)).forEach(x => {
        let lvl = 0, ab = false;
        for (let i = x.i0; i < x.i1; i++) {
            const m = D.M[i], v = D.M[Math.max(x.i0, i - 1)];
            if (m.def || m.at === null || m.soll === null) { continue; }
            const res = Z.regler(P, lvl, {at: Math.round(m.at), soll: m.soll, vl: i === x.i0 ? D.M[i - 1].vl : v.vl, q: m.q === null ? 3 : m.q, hc: m.hc, rt: i - x.i0, nachAbtau: 999, comfortAb: ab});
            lvl = res.lvl; ab = res.ab; const e = res.hz - m.hz; s += e * e; n++;
        }
    });
    return {rmse: Math.sqrt(s / Math.max(1, n)), n: n};
}
function fitRegler(D, r, P0) {
    const keys = ['regSenkK', 'regAbHzMin', 'comfortWiederK', 'effT1', 'effK1', 'effL1', 'effT2', 'effK2', 'effKp', 'effKi'];
    const start = {}; keys.forEach(k => { start[k] = P0[k]; });
    const sch = {regSenkK: () => [0.75, 1, 1.25, 1.5, 1.75, 2], regAbHzMin: () => [0.25, 0.5, 1, 1.5, 2, 3], comfortWiederK: () => [0.5, 1, 1.5, 2, 3, 99], effT1: () => [12, 15, 18, 19, 20, 22, 25, 30], effK1: () => [1.5, 1.75, 2, 2.25, 2.5, 3, 4],
                 effL1: () => [19, 20, 21, 22], effT2: () => [30, 33, 36, 39, 42, 45], effK2: () => [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], effKp: () => [2, 2.5, 3, 3.5, 4, 5], effKi: () => [0, 0.02, 0.05, 0.1, 0.2]};
    const k = koordinatensuche(start, sch, p => reglerFehler(D, r, Object.assign({}, P0, p)).rmse, 4);
    const f = reglerFehler(D, r, Object.assign({}, P0, k.p));
    return Object.assign({}, k.p, {_fit: {n: f.n, rmseHz: rd(f.rmse, 3), auswertungen: k.n}});
}
// Wasserkreis: Simulation von tw (Heizkörper-Mittel) und tr (schneller Raumknoten) mit gemessener Wärme (Durchfluss × Spreizung) und gemessenem Hausmittel;
// Neustart je Segment aus der Messung (Fühler im 0,25-K-Raster)
function twAus(P, vl, rl, flow, tr) { const md = Math.max(1, flow) * Z.CP; let tw = (vl + rl) / 2; for (let k = 0; k < 6; k++) { tw = rl + Z.qrad(P, tw, tr) / (2 * md); } return tw; }
function initKreis(P, vl, rl, flow, th) { let tw = (vl + rl) / 2 + 0.5, tr = th; for (let k = 0; k < 6; k++) { tr = Z.trAus(P, tw, th); tw = twAus(P, vl, rl, flow, tr); } return {tw: tw, tr: tr}; }
function hydraulikFehler(D, r, P, segMin) {
    const e = [];
    let k = null, seg = 0;
    for (let i = 1; i < D.M.length; i++) {
        const m = D.M[i], v = D.M[i - 1];
        if (!m.ok || !inTage(m, r) || !m.pumpe || !v.pumpe || m.th === null || m.vl === null || m.rl === null || m.def || v.vl === null) { k = null; continue; }
        if (k === null || seg >= segMin) { k = initKreis(P, v.vl, v.rl, v.flow, v.th); seg = 0; }
        const md = m.flow * Z.CP, pth = m.lauf ? Math.max(0, md * (m.vl - m.rl)) : 0;
        const h = Z.heizkreis(P, k.tw, k.tr, m.th, pth); k = {tw: h.tw, tr: h.tr}; seg++;
        const rl = k.tw - Z.qrad(P, k.tw, k.tr) / (2 * md), vl = rl + pth / md;
        if (seg > 1) { e.push(vl - m.vl, rl - m.rl); }
    }
    return {rmse: rmse(e), n: e.length / 2};
}
function fitHydraulik(D, r, P0) {
    const SEG = 360, R8 = rel([0.5, 0.7, 0.85, 0.93, 1.07, 1.18, 1.4, 2]);
    const k = koordinatensuche({cw: P0.cw, krad: P0.krad, cr: P0.cr, hr: P0.hr, kv: P0.kv}, {cw: R8, krad: R8, cr: v => R8(v).filter(x => x >= 0.1 && x <= 5), hr: v => R8(v).filter(x => x >= 0.1 && x <= 2), kv: v => [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6].concat([rd(v * 0.9, 4), rd(v * 1.1, 4)])}, p => hydraulikFehler(D, r, Object.assign({}, P0, p), SEG).rmse, 10);
    const f = hydraulikFehler(D, r, Object.assign({}, P0, k.p), SEG);
    return {cw: rd(k.p.cw, 4), krad: rd(k.p.krad, 5), cr: rd(k.p.cr, 4), hr: rd(k.p.hr, 4), kv: rd(k.p.kv, 4), _fit: {n: f.n, rmseK: rd(f.rmse, 3), segmentMin: SEG, nrad: P0.nrad}};
}
// Haus: Simulation des Hausmittels; Heizkörper-Mittel aus der Messung, schneller Knoten simuliert; Segmente segMin; Fehler nur bei AT ≤ kaltBis (Heizbetrieb, winterrelevant)
function hausFehler(D, r, P, segMin, kaltBis) {
    segMin = segMin || 1440; kaltBis = kaltBis === undefined ? 99 : kaltBis;
    const e = []; let th = null, tr = null, seg = 0, twL = null, atH = null;
    for (let i = 0; i < D.M.length; i++) {
        const m = D.M[i];
        if (m.at === null) { th = null; continue; }
        atH = atH === null ? m.at : atH + (m.at - atH) / Math.max(1, P.hausAtTauMin);
        if (!inTage(m, r)) { th = null; continue; }
        if (th === null || seg >= segMin) { if (m.th === null || !m.pumpe || m.vl === null || m.rl === null) { continue; } th = m.th; const k = initKreis(P, m.vl, m.rl, m.flow, m.th); twL = k.tw; tr = k.tr; seg = 0; }
        if (m.pumpe && m.vl !== null && m.rl !== null && !m.def) { twL = twAus(P, m.vl, m.rl, m.flow, tr); }
        const h = Z.heizkreis(P, twL, tr, th, 0); tr = h.tr; if (!(m.pumpe && m.vl !== null && m.rl !== null && !m.def)) { twL = h.tw; }      // Pumpe aus: Heizkörper kühlen nach dem Modell aus
        th = Z.hausSchritt(P, th, h.qh, atH, m.pv); seg++;
        if (m.th !== null && seg > 1 && m.at <= kaltBis) { e.push(th - m.th); }
    }
    return {rmse: rmse(e), n: e.length, bias: mean(e)};
}
function hausFenster(D, r, P, stunden, schritt) {                                 // Energiebilanz je Fenster (Länge `stunden`, Beginn alle `schritt` Stunden): Wärme = UA·Kh − g·h + C·ΔTh − s·PVh
    const W = [], L = stunden * 60;
    for (let i0 = 0; i0 + L < D.M.length; i0++) {
        const m0 = D.M[i0]; if (new Date(m0.t).getMinutes() !== 0 || new Date(m0.t).getHours() % schritt !== 0 || !inTage(m0, r)) { continue; }
        const seg = D.M.slice(i0, i0 + L + 1), ok = seg.filter(m => m.th !== null && m.at !== null && m.vl !== null && m.rl !== null).length;
        if (ok < 0.95 * seg.length || !inTage(seg[seg.length - 1], r)) { continue; }
        const e = seg[seg.length - 1], twOf = m => (m.vl + m.rl) / 2;
        let q = 0, kh = 0, pv = 0; for (let i = 0; i < L; i++) { const m = seg[i]; if (m.lauf && m.flow > 1 && m.vl !== null && m.rl !== null) { q += Math.max(0, m.flow * Z.CP * (m.vl - m.rl)) / 60; } if (m.th !== null && m.at !== null) { kh += (m.th - m.at) / 60; } pv += (m.pv || 0) / 60; }
        if (seg[0].pumpe && e.pumpe) { q -= P.cw * (twOf(e) - twOf(seg[0])); }
        const th0 = seg.find(m => m.th !== null).th, th1 = seg.slice().reverse().find(m => m.th !== null).th;
        W.push({q: q, kh: kh, h: stunden, dth: th1 - th0, pv: pv, t: m0.t});
    }
    return W;
}
function fitHaus(D, r, P0) {
    // (1) Energiebilanz (Plausibilität, Startwert): 24-h-Fenster alle 2 h, Vorwert Auslegung (5 kW bei −13 °C → UA 0,154 kW/K bei 0,3 kW Gewinnen) als 2 Pseudo-Tage
    const W = hausFenster(D, r, P0, 24, 2), ch0 = P0.ch, ua0 = 0.154, g0 = 0.3, X = [], y = [];
    W.forEach(w => { X.push([w.kh, -w.h, -w.pv]); y.push(w.q - ch0 * w.dth); });
    [-5, 10].forEach(atp => { const kh = 24 * (21.3 - atp); for (let k = 0; k < 12; k++) { X.push([kh, -24, 0]); y.push(ua0 * kh - g0 * 24); } });
    let st = {ua: P0.ua, gain: P0.gain, ch: P0.ch, hausAtTauMin: P0.hausAtTauMin}, sonne = P0.sonne, bil = {fenster24h: W.length};
    if (W.length >= 12) {
        const f = lsqBox(X, y, [0.05, -0.5, 0], [0.4, 1.5, 0.5]);
        st.ua = rd(f.x[0], 4); st.gain = rd(f.x[1], 4); sonne = rd(f.x[2], 4);
        bil = {fenster24h: W.length, ua: st.ua, gain: st.gain, sonne: sonne, bilanzpunktC: rd(21.3 - st.gain / st.ua, 1), vorwert: 'UA 0,154 kW/K, Gewinne 0,3 kW als 2 Pseudo-Tage (−5/+10 °C)'};
    }
    // (2) Simulation des Hausmittels über 48-h-Segmente, Fehler nur bei AT ≤ 8 °C (Heizbetrieb, für den Winter maßgeblich)
    const P1 = Object.assign({}, P0, {sonne: sonne});
    const k = koordinatensuche(st, {ua: rel([0.7, 0.85, 0.93, 1.07, 1.18, 1.4]), gain: v => [-0.3, -0.15, -0.05, 0.05, 0.15, 0.3].map(d => rd(v + d, 4)), ch: v => rel([0.5, 0.7, 0.85, 1.18, 1.4, 2])(v).filter(x => x >= 0.5 && x <= 30), hausAtTauMin: () => [1, 60, 120, 240, 480, 720]},
        p => hausFehler(D, r, Object.assign({}, P1, p), 2880, 8).rmse, 8);
    const f = hausFehler(D, r, Object.assign({}, P1, k.p), 2880, 8), fa = hausFehler(D, r, Object.assign({}, P1, k.p), 1440);
    return {ua: rd(k.p.ua, 4), gain: rd(k.p.gain, 4), ch: rd(k.p.ch, 3), hausAtTauMin: k.p.hausAtTauMin, sonne: sonne,
            _fit: {n: f.n, rmseKKalt: rd(f.rmse, 3), biasKKalt: rd(f.bias, 3), rmseKAlle24h: rd(fa.rmse, 3), hausmittel: HAUS_RAEUME.join(' + '), bilanzpunktC: rd(21.3 - k.p.gain / k.p.ua, 1),
                   verfahren: 'UA, Gewinne, Speicher, AT-Glättung: Simulation 48 h, Fehler bei AT ≤ 8 °C; Sonne und Startwerte aus 24-h-Energiebilanzen', energiebilanz: bil}};
}
// Zyklen-Kalibrierung: Wasserkreis so nachstellen, dass der geschlossene Zwilling (Haus gemessen) Lauf- und Pausendauern trifft
// Verlust = Wasserkreis-RMSE / 0,8 K + mittlerer |ln((Zwilling + 10)/(Messung + 10))| der Lauf- und Pausendauern / 0,3
function zyklusVerlust(D, r, P) {
    const z = zyklen(D, r, P, false, true), h = hydraulikFehler(D, r, P, 360);
    return {verlust: h.rmse / 0.8 + z.logFehler / 0.3, hyd: h.rmse, log: z.logFehler};
}
function fitZyklen(D, r, P0) {
    const R6 = rel([0.7, 0.85, 0.93, 1.07, 1.18, 1.4]);
    const k = koordinatensuche({cw: P0.cw, krad: P0.krad, cr: P0.cr, hr: P0.hr, kv: P0.kv}, {cw: R6, krad: R6, cr: v => R6(v).filter(x => x >= 0.1 && x <= 5), hr: v => R6(v).filter(x => x >= 0.1 && x <= 2), kv: v => [0, 0.05, 0.1, 0.2, 0.3].concat([rd(v * 0.8, 4), rd(v * 1.25, 4)])},
        p => zyklusVerlust(D, r, Object.assign({}, P0, p)).verlust, 4);
    const v0 = zyklusVerlust(D, r, P0), v1 = zyklusVerlust(D, r, Object.assign({}, P0, k.p));
    return {cw: rd(k.p.cw, 4), krad: rd(k.p.krad, 5), cr: rd(k.p.cr, 4), hr: rd(k.p.hr, 4), kv: rd(k.p.kv, 4), _fit: {vorher: {verlust: rd(v0.verlust, 3), wasserkreisRmseK: rd(v0.hyd, 3), logFehler: rd(v0.log, 3)}, nachher: {verlust: rd(v1.verlust, 3), wasserkreisRmseK: rd(v1.hyd, 3), logFehler: rd(v1.log, 3)}, auswertungen: k.n}};
}
// Räume: Abweichung vom gemessenen Hausmittel, Merkmale aus gefiltertem Heizkörper-Mittel (aus Vor-/Rücklauf; Pumpe aus: Abkühlung nach dem Wasserkreis-Modell), AT, PV
function raumZeilen(D, r, P, id, tau) {
    const X = [], y = [], ix = []; let twF = null, atF = null, pvF = 0, tw = null;
    for (let i = 0; i < D.M.length; i++) {
        const m = D.M[i], thx = m.th !== null ? m.th : 21.5;
        if (m.at === null) { continue; }
        if (m.pumpe && m.vl !== null && m.rl !== null && !m.def) { tw = twAus(P, m.vl, m.rl, m.flow, Z.trAus(P, (m.vl + m.rl) / 2, thx)); }
        else if (tw !== null) { tw -= Z.qrad(P, tw, Z.trAus(P, tw, thx)) * Z.DT / P.cw; }
        if (tw === null) { continue; }
        twF = twF === null ? tw : twF + (tw - twF) / tau; atF = atF === null ? m.at : atF + (m.at - atF) / P.raumAtTauMin; pvF += (m.pv - pvF) / P.raumPvTauMin;
        const T = m.rooms[id];
        if (inTage(m, r) && T !== null && T !== undefined && m.th !== null) { X.push([1, twF - m.th, m.th - atF, pvF]); y.push(T - m.th); ix.push(i); }
    }
    return {X: X, y: y, ix: ix};
}
function fitRaeume(D, r, P0) {
    const out = {raeume: {}, _fit: {}};
    RAEUME.forEach(id => {
        let best = null;
        [30, 60, 120, 240, 480].forEach(tau => { const Zr = raumZeilen(D, r, P0, id, tau); if (Zr.X.length < 300) { return; } const f = lsqBox(Zr.X, Zr.y, [-10, 0, -0.3, 0], [10, 0.5, 0.3, 2]); if (!best || f.rmse < best.f.rmse - 1e-12) { best = {f: f, tau: tau}; } });
        if (!best) { out.raeume[id] = P0.raeume[id]; out._fit[id] = {n: 0, quelle: 'zu wenig Daten, Vorgabe'}; return; }
        const Zr = raumZeilen(D, r, P0, id, best.tau), x1 = Zr.X.map(x => x[1]), x2 = Zr.X.map(x => x[2]);
        const bereich = [Math.min.apply(null, x1), Math.max.apply(null, x1), Math.min.apply(null, x2), Math.max.apply(null, x2)].map(v => rd(v, 2));
        out.raeume[id] = best.f.x.map(v => rd(v, 5)).concat([best.tau]).concat(bereich); out._fit[id] = {n: best.f.n, rmseK: rd(best.f.rmse, 3)};
    });
    return out;
}
function raumFehler(D, r, P, id, pr) {
    const Zr = raumZeilen(D, r, P, id, pr[4]);
    const e = Zr.X.map((x, k) => Z.raumWert(pr, 0, x[1], -x[2], x[3]) - Zr.y[k]);
    return {rmse: rmse(e), n: e.length, bias: mean(e)};
}
// Vereisung: eisRate so, dass der Zwilling am Anker (AT, Feuchte, Mindestlast) im Mittel alle eisAnker[2] Minuten abtaut (Annahme, kalibriert)
function abtauIntervall(P, at, rh, minuten, hc, q) {
    const E = []; const t0 = new Date(2026, 11, 1, 0, 0).getTime();
    for (let i = 0; i < minuten; i++) { E.push({t: t0 + i * MIN, at: at, rh: rh, pv: 0, q: q === undefined ? 3 : q, hc: hc === undefined ? 1 : hc, shift: 0}); }
    const ab = []; let lauf = 0, vor = '';
    Z.simuliere(P, E, {modus: 'pause', th: 21.5, tw: 30}, {ohneAusgabe: true, jeMinute: A => { if (A.modus === 'lauf' || A.modus === 'abtauen') { lauf++; } if (A.modus === 'abtauen' && vor !== 'abtauen') { ab.push(lauf); } vor = A.modus; }});
    return {n: ab.length, intervallMin: ab.length >= 2 ? (ab[ab.length - 1] - ab[0]) / (ab.length - 1) : null, laufMin: lauf};
}
function kalibriereEis(P0) {
    const [at, rh, ziel] = P0.eisAnker;
    let lo = 0.0005, hi = 0.5;
    for (let k = 0; k < 30; k++) {
        const mid = Math.sqrt(lo * hi), r = abtauIntervall(Object.assign({}, P0, {eisRate: mid}), at, rh, 2880);
        if (r.intervallMin === null || r.n < 2 || r.intervallMin > ziel) { lo = mid; } else { hi = mid; }
    }
    const eisRate = rd(Math.sqrt(lo * hi), 5), P = Object.assign({}, P0, {eisRate: eisRate});
    const a1 = abtauIntervall(P, at, rh, 2880), a2 = abtauIntervall(P, 4, 95, 2880), a3 = abtauIntervall(P, -7, 85, 2880, 1, 0), a4 = abtauIntervall(P, -9, 85, 2880, 1, 0);
    return {eisRate: eisRate, _fit: {anker: {at: at, rh: rh, zielMin: ziel, ergebnisMin: rd(a1.intervallMin, 1)}, pruefung: [
        {at: 4, rh: 95, abtauungen48h: a2.n, intervallMin: rd(a2.intervallMin, 1), soll: 'Forum L5 4540566: bei 3–5 °C und Regen tagelang keine Abtauung'},
        {at: -7, rh: 85, abtauungen48h: a3.n, intervallMin: rd(a3.intervallMin, 1), soll: 'Forum J5 2911944/2913337 (nicht L): alle 1–2 h bei −5…−10 °C'},
        {at: -9, rh: 85, abtauungen48h: a4.n, intervallMin: rd(a4.intervallMin, 1), soll: 'Forum 4600685 (E): Kriterium Rohr < −13/−14 °C bei −9 °C'}]}};
}

// ------------------------------------------------------------------ Alles fitten
function fitAlles(D, r) {
    let P = Z.standard(); const fit = {};
    const nimm = (name, o) => { fit[name] = o._fit || {}; Object.keys(o).forEach(k => { if (k !== '_fit') { P[k] = o[k]; } }); };
    nimm('waerme', fitPth(D, r));
    nimm('strom', fitPel(D, r));
    nimm('standby', fitStandby(D, r));
    nimm('pumpe', fitFlow(D, r));
    nimm('luefter', fitFan(D, r, P));
    nimm('rohr', fitPipe(D, r, P));
    nimm('startStopp', fitStartStopp(D, r));
    nimm('regler', fitRegler(D, r, P));
    nimm('wasserkreis', fitHydraulik(D, r, P));
    nimm('zyklen', fitZyklen(D, r, P));
    nimm('haus', fitHaus(D, r, P));
    nimm('raeume', fitRaeume(D, r, P));
    nimm('vereisung', kalibriereEis(P));
    return {P: P, fit: fit};
}

// ------------------------------------------------------------------ Güte
function initAus(D, i, P, opts) {                                                  // Zustand des Zwillings aus der Messung in Minute i
    const m = D.M[i], th = m.th !== null ? m.th : 21.5, flow = m.pumpe ? m.flow : P.flowPause;
    const k = m.vl !== null && m.rl !== null ? initKreis(P, m.vl, m.rl, flow, th) : {tw: th + 6, tr: Z.trAus(P, th + 6, th)}, tw = k.tw;
    return Object.assign({modus: m.lauf ? 'lauf' : (m.pumpe ? 'pause' : 'aus'), tw: tw, tr: k.tr, th: th, at: m.at, rt: m.lauf ? (m.rm || 0) : 0, vl: m.vl, rl: m.rl, soll: m.soll, lvl: m.lauf ? Math.max(0, m.hz - Z.hzMinAt(P, Math.round(m.at))) : 0, pauseMin: 30}, opts || {});
}
function eingabe(m, mitHaus) { return {t: m.t, at: m.at, rh: m.rh, pv: m.pv, q: m.q === null ? 3 : m.q, hc: m.hc, shift: 0, sollHand: m.soll, kzRad: m.kzRad, kzLW: m.kzLW, th: mitHaus ? null : m.th}; }
function teilGuete(D, r, P) {
    const S = stabil(D, r);
    const ePth = S.map(m => Z.pthOf(P, m.hz, m.at, vlRelVor(D, m)) - m.pth), ePel = S.map(m => Z.pelOf(P, m.hz, m.at, m.rl) - m.pel);
    const kWhPth = [S.reduce((s, m) => s + Z.pthOf(P, m.hz, m.at, vlRelVor(D, m)), 0) / 60000, S.reduce((s, m) => s + m.pth, 0) / 60000];
    const pp = D.M.filter(m => m.ok && inTage(m, r) && m.pipe !== null && m.lauf && m.rm >= 5 && !m.def && m.pth > 0 && m.pel > 0 && m.fan > 0);
    const ePipe = pp.map(m => (m.at - (P.pipe0 + P.pipeQ * Math.max(0, m.pth - m.pel) / 1000 * 300 / m.fan)) - m.pipe);
    const reg = reglerFehler(D, r, P), hyd = hydraulikFehler(D, r, P, 360), haus = hausFehler(D, r, P, 1440);
    const raeume = {}; RAEUME.forEach(id => { const f = raumFehler(D, r, P, id, P.raeume[id]); raeume[id] = {n: f.n, rmseK: rd(f.rmse, 3), biasK: rd(f.bias, 3)}; });
    const st = stoppFehler(D, r, P.stopK, P.stopHaltMin), sa = startFehler(D, r, P.startK, P.startVerzugMin, P.startHystK);
    return {pthRmseW: rd(rmse(ePth), 1), pthBiasW: rd(mean(ePth), 1), pthKWhModellMessung: kWhPth.map(x => rd(x, 2)), pelRmseW: rd(rmse(ePel), 1), pelBiasW: rd(mean(ePel), 1), nStabil: S.length,
            pipeRmseK: pp.length ? rd(rmse(ePipe), 2) : null, nPipe: pp.length, reglerRmseHz: rd(reg.rmse, 3), wasserkreisRmseK: rd(hyd.rmse, 3), hausRmseK: rd(haus.rmse, 3), raeume: raeume,
            stoppRegelMaeMin: rd(mean(st.map(Math.abs)), 2), stoppN: st.length, startRegelMaeMin: rd(mean(sa.map(Math.abs)), 2), startN: sa.length};
}
// Zyklen: ab jedem echten Stopp (Pause) bzw. Start (Lauf) den Zwilling geschlossen laufen lassen, bis er selbst startet bzw. stoppt
function zyklen(D, r, P, mitHaus, nurVerlust) {
    const pause = [], lauf = [], detail = [];
    D.pausen.filter(p => p.okAll && inTage(D.M[p.i0], r) && p.i1 - p.i0 >= 3).forEach(p => {
        let S = Z.neu(P, initAus(D, p.i0, P, {modus: D.M[p.i0].pumpe ? 'pause' : 'aus', pauseMin: 0, rt: 0, lvl: 0})), pred = null;
        for (let i = p.i0 + 1; i < Math.min(D.M.length, p.i1 + 600); i++) { const res = Z.schritt(S, eingabe(D.M[i], mitHaus), P); S = res.S; if (res.A.start) { pred = i; break; } }
        const ist = p.i1 - p.i0, prog = pred === null ? null : pred - p.i0;
        pause.push(prog === null ? Math.min(600, D.M.length - p.i0) - ist : prog - ist); detail.push({art: 'pause', zeit: ymd(D.M[p.i0].t) + ' ' + hm(D.M[p.i0].t), istMin: ist, zwillingMin: prog, pumpeAus: p.pumpeAus});
    });
    D.runs.filter(x => x.okAll && x.i0 > 0 && inTage(D.M[x.i0], r) && x.art !== 'sonst').forEach(x => {
        let S = Z.neu(P, initAus(D, x.i0 - 1, P, {modus: 'lauf', rt: 0, lvl: 0})), pred = null;
        for (let i = x.i0; i < Math.min(D.M.length, x.i1 + 1200); i++) { const res = Z.schritt(S, eingabe(D.M[i], mitHaus), P); S = res.S; if (res.A.stopp) { pred = i; break; } }
        const ist = x.i1 - x.i0, prog = pred === null ? null : pred - x.i0;
        lauf.push(prog === null ? Math.min(1200, D.M.length - x.i0) - ist : prog - ist); detail.push({art: 'lauf', zeit: ymd(D.M[x.i0].t) + ' ' + hm(D.M[x.i0].t), istMin: ist, zwillingMin: prog, ende: x.art});
    });
    const lf = detail.map(z => Math.abs(Math.log(((z.zwillingMin === null ? (z.art === 'lauf' ? 1200 : 600) : z.zwillingMin) + 10) / (z.istMin + 10))));
    if (nurVerlust) { return {logFehler: mean(lf)}; }
    const k = a => ({n: a.length, maeMin: rd(mean(a.map(Math.abs)), 1), medianAbsMin: rd(median(a.map(Math.abs)), 1), biasMin: rd(mean(a), 1)});
    return {pause: k(pause), lauf: k(lauf), detail: detail, logFehler: rd(mean(lf), 3)};
}
// Freilauf je Tag: ab 00:00 (bzw. Datenbeginn) 24 h geschlossen (Anlage + Haus + Räume), Eingänge: AT, Feuchte, PV, Quiet, Heizregelung, Soll (gemessen)
function freilauf(D, tag, P) {
    const idx = []; D.M.forEach((m, i) => { if (m.tag === tag) { idx.push(i); } });
    if (idx.length < 600) { return null; }
    let S = Z.neu(P, initAus(D, idx[0], P));
    const e = {vl: [], pel: [], th: [], raeume: {}}; RAEUME.forEach(id => { e.raeume[id] = []; });
    const sum = {elZ: 0, elM: 0, thZ: 0, thM: 0, startsZ: 0, startsM: 0, laufZ: 0, laufM: 0, abtauZ: 0, hsZ: 0};
    idx.forEach((i, k) => {
        const m = D.M[i], res = Z.schritt(S, eingabe(m, true), P); S = res.S; const A = res.A;
        if (k > 0) {
            if (m.vl !== null && m.pumpe) { e.vl.push(A.hp.Main_Outlet_Temp - m.vl); }
            if (m.pel !== null) { e.pel.push(A.pelKorr - (m.pel + (m.lauf ? P.pelKorrW : 0))); }
            if (m.th !== null) { e.th.push(A.th - m.th); }
            RAEUME.forEach(id => { if (m.rooms[id] !== null) { e.raeume[id].push(A.raeume[id] - m.rooms[id]); } });
        }
        sum.elZ += A.pelKorr / 60000; sum.elM += m.pel === null ? 0 : (m.pel + (m.lauf ? P.pelKorrW : 0)) / 60000;
        sum.thZ += Math.max(0, A.pth) / 60000; sum.thM += m.lauf && m.flow > 1 && m.vl !== null && m.rl !== null ? Math.max(0, m.flow * Z.CP * (m.vl - m.rl)) / 60 : 0;
        if (A.start) { sum.startsZ++; } if (k > 0 && m.lauf && !D.M[i - 1].lauf) { sum.startsM++; }
        if (A.modus === 'lauf' || A.modus === 'abtauen') { sum.laufZ++; } if (m.lauf) { sum.laufM++; }
    });
    const o = {tag: tag, minuten: idx.length, kwhElZwilling: rd(sum.elZ, 2), kwhElMessung: rd(sum.elM, 2), kwhThZwilling: rd(sum.thZ, 2), kwhThMessung: rd(sum.thM, 2), startsZwilling: sum.startsZ, startsMessung: sum.startsM,
               laufMinZwilling: sum.laufZ, laufMinMessung: sum.laufM, rmseVlK: rd(rmse(e.vl), 2), rmsePelW: rd(rmse(e.pel), 1), rmseHausK: rd(rmse(e.th), 2), biasHausK: rd(mean(e.th), 2), raeume: {}};
    RAEUME.forEach(id => { o.raeume[id] = e.raeume[id].length ? {rmseK: rd(rmse(e.raeume[id]), 2), biasK: rd(mean(e.raeume[id]), 2)} : null; });
    return o;
}
function guete(D, r, P) {
    const tage = tageVon(D).filter(t => t >= r[0] && t <= r[1]);
    const fl = tage.map(t => freilauf(D, t, P)).filter(Boolean);
    const zA = zyklen(D, r, P, false), zH = zyklen(D, r, P, true);
    const sum = k => fl.reduce((s, x) => s + x[k], 0);
    return {tage: tage, teil: teilGuete(D, r, P), zyklenHausGemessen: {pause: zA.pause, lauf: zA.lauf}, zyklenHausSimuliert: {pause: zH.pause, lauf: zH.lauf}, zyklenDetail: zH.detail,
            freilauf: fl, freilaufSumme: fl.length ? {kwhElZwilling: rd(sum('kwhElZwilling'), 2), kwhElMessung: rd(sum('kwhElMessung'), 2), kwhThZwilling: rd(sum('kwhThZwilling'), 2), kwhThMessung: rd(sum('kwhThMessung'), 2),
                startsZwilling: sum('startsZwilling'), startsMessung: sum('startsMessung'), laufMinZwilling: sum('laufMinZwilling'), laufMinMessung: sum('laufMinMessung')} : null};
}

// ------------------------------------------------------------------ Hauptablauf
function trainiere(dir, opt) {
    opt = opt || {};
    const D = lade(dir, opt.monat ? opt.monat.split(',') : null, opt.tage ? Number(opt.tage) : null), T = trennung(D, opt);
    const ftr = fitAlles(D, T.train);
    const gTrain = guete(D, T.train, ftr.P), gTest = guete(D, T.test, ftr.P);
    const fall = fitAlles(D, [T.tage[0], T.tage[T.tage.length - 1]]);
    const her = Z.herkunft(), werte = {}, werteTraining = {};
    Object.keys(her).forEach(k => { werte[k] = fall.P[k]; werteTraining[k] = ftr.P[k]; });
    const fitKeys = {waerme: ['pthHz', 'pthHzAT', 'pthEnde'], strom: ['pel0', 'pelHz', 'pelRL', 'pelAT'], standby: ['pelPauseW', 'pelAusW'], pumpe: ['flowPause', 'flowComfort', 'flowEff', 'pumpe0', 'pumpeJeL'], luefter: ['fanQ', 'fanJeHz'],
                     rohr: ['pipe0', 'pipeQ'], startStopp: ['stopK', 'stopHaltMin', 'startK', 'startVerzugMin', 'startHystK'], regler: ['regSenkK', 'regAbHzMin', 'comfortWiederK', 'effT1', 'effK1', 'effL1', 'effT2', 'effK2', 'effKp', 'effKi'],
                     wasserkreis: ['cw', 'krad', 'cr', 'hr', 'kv'], zyklen: [], haus: ['ua', 'gain', 'ch', 'sonne', 'hausAtTauMin'], raeume: ['raeume'], vereisung: ['eisRate']};
    Object.keys(fitKeys).forEach(g => fitKeys[g].forEach(k => { her[k] = Object.assign({}, her[k], {fit: g === 'vereisung' ? 'kalibriert (Annahme-Anker)' : 'gefittet', gruppe: g}); }));
    return {
        version: VERSION, modell: 'wp_zwilling v' + VERSION,
        daten: {ordner: path.basename(path.resolve(dir)), von: ymd(D.von) + ' ' + hm(D.von), bis: ymd(D.bis) + ' ' + hm(D.bis), minuten: D.M.length, laeufe: D.runs.length, pausen: D.pausen.length},
        trennung: {training: T.train, test: T.test},
        werte: werte, werteTraining: werteTraining, herkunft: her,
        fit: {training: ftr.fit, alle: fall.fit},
        guete: {training: gTrain, test: gTest}
    };
}

function markdown(R) {
    const L = [], g = R.guete, tr = g.training, te = g.test;
    L.push('# Anlagen-Zwilling Leisha WH-WDG05LE5: Training', '');
    L.push('Daten `' + R.daten.ordner + '` ' + R.daten.von + ' bis ' + R.daten.bis + ' (' + R.daten.minuten + ' Minuten, ' + R.daten.laeufe + ' Läufe). Training ' + R.trennung.training.join(' … ') + ', Test ' + R.trennung.test.join(' … ') + '. Modell ' + R.modell + '.', '');
    L.push('## Güte (Parameter aus den Trainingstagen)', '', '| Größe | Training | Test |', '|---|---|---|');
    const row = (n, a, b) => L.push('| ' + n + ' | ' + a + ' | ' + b + ' |');
    row('Wärme Pth (stabile Laufminuten), RMSE / Bias', de(tr.teil.pthRmseW, 0) + ' / ' + de(tr.teil.pthBiasW, 0) + ' W', de(te.teil.pthRmseW, 0) + ' / ' + de(te.teil.pthBiasW, 0) + ' W');
    row('Strom TOP16, RMSE / Bias', de(tr.teil.pelRmseW, 1) + ' / ' + de(tr.teil.pelBiasW, 1) + ' W', de(te.teil.pelRmseW, 1) + ' / ' + de(te.teil.pelBiasW, 1) + ' W');
    row('Verdichter-Regler (gemessener Vorlauf), RMSE', de(tr.teil.reglerRmseHz, 2) + ' Hz', de(te.teil.reglerRmseHz, 2) + ' Hz');
    row('Wasserkreis Vor-/Rücklauf (Neustart je 360 min), RMSE', de(tr.teil.wasserkreisRmseK, 2) + ' K', de(te.teil.wasserkreisRmseK, 2) + ' K');
    row('Rohr außen, RMSE', tr.teil.pipeRmseK === null ? '–' : de(tr.teil.pipeRmseK, 2) + ' K', te.teil.pipeRmseK === null ? '–' : de(te.teil.pipeRmseK, 2) + ' K');
    row('Hausmittel (24-h-Segmente, gemessener Heizkreis), RMSE', de(tr.teil.hausRmseK, 2) + ' K', de(te.teil.hausRmseK, 2) + ' K');
    RAEUME.forEach(id => row('Raum ' + id + ' (Abweichung vom gemessenen Hausmittel), RMSE', de(tr.teil.raeume[id].rmseK, 2) + ' K', de(te.teil.raeume[id].rmseK, 2) + ' K'));
    row('Stopp-Regel (gemessener Vorlauf), MAE', de(tr.teil.stoppRegelMaeMin, 1) + ' min (' + tr.teil.stoppN + ')', de(te.teil.stoppRegelMaeMin, 1) + ' min (' + te.teil.stoppN + ')');
    row('Start-Regel (gemessener Vorlauf), MAE', de(tr.teil.startRegelMaeMin, 1) + ' min (' + tr.teil.startN + ')', de(te.teil.startRegelMaeMin, 1) + ' min (' + te.teil.startN + ')');
    const zz = (z) => 'MAE ' + de(z.maeMin, 0) + ', Median ' + de(z.medianAbsMin, 0) + ', Bias ' + de(z.biasMin, 0) + ' min (' + z.n + ')';
    row('Pausendauer = Startzeitpunkt, Zwilling geschlossen, Haus gemessen', zz(tr.zyklenHausGemessen.pause), zz(te.zyklenHausGemessen.pause));
    row('Laufdauer, Zwilling geschlossen, Haus gemessen', zz(tr.zyklenHausGemessen.lauf), zz(te.zyklenHausGemessen.lauf));
    row('Pausendauer, alles geschlossen (Haus simuliert)', zz(tr.zyklenHausSimuliert.pause), zz(te.zyklenHausSimuliert.pause));
    row('Laufdauer, alles geschlossen (Haus simuliert)', zz(tr.zyklenHausSimuliert.lauf), zz(te.zyklenHausSimuliert.lauf));
    const fs0 = x => x ? de(x.kwhElZwilling, 1) + ' / ' + de(x.kwhElMessung, 1) + ' kWh el, ' + de(x.kwhThZwilling, 0) + ' / ' + de(x.kwhThMessung, 0) + ' kWh th, Starts ' + x.startsZwilling + ' / ' + x.startsMessung + ', Laufminuten ' + x.laufMinZwilling + ' / ' + x.laufMinMessung : '–';
    row('Freilauf je Tag summiert (Zwilling / Messung)', fs0(tr.freilaufSumme), fs0(te.freilaufSumme));
    L.push('', '### Freilauf je Tag (24 h geschlossen ab 00:00, Eingänge AT, Feuchte, PV, Quiet, Heizregelung, gemessener Soll)', '', '| Tag | kWh el Zwilling / Messung | kWh th | Starts | Laufminuten | RMSE VL | RMSE Pel | Haus RMSE (Bias) | Räume RMSE ki_oben / ki_unten / schlaf / wohn |', '|---|---|---|---|---|---|---|---|---|');
    tr.freilauf.concat(te.freilauf).forEach(x => L.push('| ' + x.tag + (te.tage.indexOf(x.tag) >= 0 ? ' (Test)' : '') + ' | ' + de(x.kwhElZwilling, 2) + ' / ' + de(x.kwhElMessung, 2) + ' | ' + de(x.kwhThZwilling, 1) + ' / ' + de(x.kwhThMessung, 1) + ' | ' + x.startsZwilling + ' / ' + x.startsMessung + ' | ' + x.laufMinZwilling + ' / ' + x.laufMinMessung + ' | ' + de(x.rmseVlK, 2) + ' K | ' + de(x.rmsePelW, 0) + ' W | ' + de(x.rmseHausK, 2) + ' (' + de(x.biasHausK, 2) + ') K | ' + RAEUME.map(id => x.raeume[id] ? de(x.raeume[id].rmseK, 2) : '–').join(' / ') + ' K |'));
    L.push('', '### Zyklen im Test (alles geschlossen)', '', '| Beginn | Art | Messung | Zwilling |', '|---|---|---|---|');
    te.zyklenDetail.forEach(z => L.push('| ' + z.zeit + ' | ' + z.art + (z.ende ? ' (' + z.ende + ')' : '') + (z.pumpeAus ? ' (Pumpe aus)' : '') + ' | ' + z.istMin + ' min | ' + (z.zwillingMin === null ? 'kein Ende' : z.zwillingMin + ' min') + ' |'));
    L.push('', '## Parameter (für den Zwilling: Fit über alle Tage; in Klammern nur Trainingstage)', '', '| Parameter | Wert | (Training) | Einheit | Herkunft | Quelle |', '|---|---|---|---|---|---|');
    const fmt = v => v === undefined ? '–' : typeof v === 'number' ? de(v, Math.abs(v) < 0.1 ? 4 : (Math.abs(v) < 10 ? 3 : 1)) : JSON.stringify(v).replace(/\|/g, '/');
    Object.keys(R.herkunft).forEach(k => { const h = R.herkunft[k]; L.push('| `' + k + '` | ' + fmt(R.werte[k]) + ' | ' + (JSON.stringify(R.werte[k]) === JSON.stringify(R.werteTraining[k]) ? '' : fmt(R.werteTraining[k])) + ' | ' + h.einheit + ' | ' + h.herkunft + (h.fit ? ', ' + h.fit : '') + ' | ' + h.quelle.replace(/\|/g, '/') + ' |'); });
    L.push('', '## Fit-Kennzahlen (alle Tage)', '', '```json', JSON.stringify(R.fit.alle, null, 1), '```');
    return L.join('\n') + '\n';
}

module.exports = {lade, trennung, fitAlles, guete, trainiere, markdown, lsq, koordinatensuche, abtauIntervall, initAus, eingabe, readMulti, RAEUME, HAUS_RAEUME};

if (require.main === module) {
    const a = process.argv.slice(2), dir = a[0];
    if (!dir || dir.indexOf('--') === 0) { console.error('Usage: node tools/wp_training.js <Datenordner> [--json Datei] [--md Datei] [--train A..B] [--test C..D] [--monat JJJJ-MM,…] [--tage n] [--still]'); process.exit(2); }
    const arg = k => { const i = a.indexOf(k); return i > 0 && a[i + 1] && a[i + 1].indexOf('--') !== 0 ? a[i + 1] : null; };
    const R = trainiere(dir, {train: arg('--train'), test: arg('--test'), monat: arg('--monat'), tage: arg('--tage')});
    const js = JSON.stringify(R, null, 1) + '\n';
    if (arg('--json')) { fs.writeFileSync(arg('--json'), js); }
    if (arg('--md')) { fs.writeFileSync(arg('--md'), markdown(R)); }
    if (a.indexOf('--still') < 0) {
        const t = R.guete.test, tr = R.guete.training;
        console.log('Training ' + R.trennung.training.join('..') + ', Test ' + R.trennung.test.join('..'));
        console.log('Test: Pth ' + t.teil.pthRmseW + ' W, Pel ' + t.teil.pelRmseW + ' W, Regler ' + t.teil.reglerRmseHz + ' Hz, Wasserkreis ' + t.teil.wasserkreisRmseK + ' K, Haus ' + t.teil.hausRmseK + ' K');
        console.log('Test Zyklen (Haus simuliert): Pause ' + JSON.stringify(t.zyklenHausSimuliert.pause) + ' Lauf ' + JSON.stringify(t.zyklenHausSimuliert.lauf));
        console.log('Test Freilauf: ' + JSON.stringify(t.freilaufSumme));
        console.log('Training Freilauf: ' + JSON.stringify(tr.freilaufSumme));
    }
}

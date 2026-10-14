// Comfort gegen Efficiency aus den Minutenprotokollen (Grundlage der Regel "Heizregelung", 14.10.2026). Nur lesen.
// Usage: node tools/heizregelung_analyse.js <Datenordner> [Monat]
//  (1) Minuten und COP je Heizregelung x Aussenband x Laufphase (0-15, 15-60, >= 60 min), roh (TOP16) und mit COP-Korrektur +80 W, energiegewichtet
//  (2) COP je Heizregelung bei gleicher Frequenzklasse (ab Laufminute 15, Quiet 0)
//  (3) je Start: Heizregelung, hoechste Frequenz in den ersten 15/30 min, Minuten bis Soll -1 K, Laufdauer, Stopp-Art
//  (4) Wechsel der Heizregelung im Lauf: Pumpe, Frequenz und Leistung 5 min vorher/nachher
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const R = require('./engine_replay.js');
const I = R.buildInputs(process.argv[2], process.argv[3] || '2026-10');
const MIN = 60000, KW = 80;
const band = at => at < 4 ? '<4' : at < 8 ? '4-8' : at < 11 ? '8-11' : '>=11';
const cls = hz => hz <= 17 ? '16-17' : hz <= 21 ? '18-21' : hz <= 27 ? '22-27' : '>=28';
const phase = m => m < 15 ? '0-15' : m < 60 ? '15-60' : '>=60';
const mode = hc => hc === 0 ? 'C' : hc === 1 ? 'E' : '?';
const A = {}, F = {}, runs = [], wechsel = [];
let run = null, prev = null;
for (let i = 0; i < I.length; i++) {
    const x = I[i];
    if (x.hpAge > 2 || x.hz === null) { prev = null; if (run) { run.luecke = true; } continue; }
    if (x.hz > 0 && (!prev || !(prev.hz > 0))) {
        run = {t0: x.t, hc0: x.hc, at: x.at, q0: x.q, hz15: 0, hz30: 0, reach: null, min: 0, hcSet: new Set(), pel: 0, pth: 0, n: 0, soll0: x.soll, vl0: x.vl};
        runs.push(run);
    }
    if (x.hz > 0 && run) {
        const m = (x.t - run.t0) / MIN;
        run.min = m; run.hcSet.add(x.hc); run.vlEnd = x.vl; run.sollEnd = x.soll;
        if (m >= 2 && m <= 15) { run.hz15 = Math.max(run.hz15, x.hz); }
        if (m >= 2 && m <= 30) { run.hz30 = Math.max(run.hz30, x.hz); }
        if (run.reach === null && x.vl !== null && x.soll !== null && x.vl >= x.soll - 1 && m >= 2) { run.reach = m; }
        if (!x.defrost && !x.dhw && x.pel !== null && x.pth !== null && x.pel > 50 && x.pth > 0) {
            const k = mode(x.hc) + '|' + band(x.at) + '|' + phase(m), o = A[k] = A[k] || {n: 0, pel: 0, pth: 0, hz: 0};
            o.n++; o.pel += x.pel; o.pth += x.pth; o.hz += x.hz;
            if (m >= 15 && x.q === 0) { const k2 = mode(x.hc) + '|' + band(x.at) + '|' + cls(x.hz), o2 = F[k2] = F[k2] || {n: 0, pel: 0, pth: 0, flow: 0, fn: 0}; o2.n++; o2.pel += x.pel; o2.pth += x.pth; if (x.flow !== null) { o2.flow += x.flow; o2.fn++; } }
        }
    }
    if (prev && prev.hc !== null && x.hc !== null && prev.hc !== x.hc) {
        const win = (a, b) => I.slice(Math.max(0, i + a), Math.max(0, i + b)).filter(y => y.hz !== null);
        const avg = (L, k) => { const v = L.map(y => y[k]).filter(z => z !== null); return v.length ? (v.reduce((s, z) => s + z, 0) / v.length) : null; };
        const v5 = win(-5, 0), n5 = win(1, 6), n15 = win(6, 16);
        wechsel.push({t: x.t, von: mode(prev.hc), zu: mode(x.hc), lauf: x.hz > 0, at: x.at,
            vor: {hz: avg(v5, 'hz'), pump: avg(v5, 'pump'), flow: avg(v5, 'flow'), pel: avg(v5, 'pel')}, nach: {hz: avg(n5, 'hz'), pump: avg(n5, 'pump'), flow: avg(n5, 'flow'), pel: avg(n5, 'pel')}, nach15: {hz: avg(n15, 'hz'), pel: avg(n15, 'pel')}});
    }
    if (!(x.hz > 0) && run && prev && prev.hz > 0) { run.ende = x.t; run.thermo = prev.vl !== null && prev.soll !== null && prev.vl - prev.soll >= 2.75; run = null; }
    prev = x;
}
const p2 = x => String(x).padStart(2, '0'), dmt = t => { const d = new Date(t); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '. ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
const f = (v, d) => v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(d === undefined ? 2 : d);
console.log('== (1) COP je Heizregelung x Aussenband x Laufphase (energiegewichtet; roh / +' + KW + ' W), Minuten, mittlere Frequenz');
for (const b of ['<4', '4-8', '8-11', '>=11']) {
    for (const p of ['0-15', '15-60', '>=60']) {
        const row = ['C', 'E'].map(m => { const o = A[m + '|' + b + '|' + p]; if (!o) { return m + ': –'; } return m + ': ' + f(o.pth / o.pel) + ' / ' + f(o.pth / (o.pel + KW * o.n)) + ' (' + o.n + ' min, ' + f(o.hz / o.n, 1) + ' Hz, ' + f(o.pel / o.n, 0) + ' W)'; });
        console.log(b.padEnd(5), p.padEnd(6), row.join(' | '));
    }
}
console.log('\n== (2) gleiche Frequenzklasse, Quiet 0, ab Laufminute 15: COP +' + KW + ' W, Minuten, Durchfluss l/min');
for (const b of ['<4', '4-8', '8-11', '>=11']) {
    for (const c of ['16-17', '18-21', '22-27', '>=28']) {
        const row = ['C', 'E'].map(m => { const o = F[m + '|' + b + '|' + c]; if (!o) { return m + ': –'; } return m + ': ' + f(o.pth / (o.pel + KW * o.n)) + ' (' + o.n + ' min, ' + f(o.fn ? o.flow / o.fn : null, 1) + ' l/min)'; });
        if (row.every(s => / –$/.test(s))) { continue; }
        console.log(b.padEnd(5), c.padEnd(6), row.join(' | '));
    }
}
console.log('\n== (3) Starts: Heizregelung beim Start, Aussen, Quiet, max Hz 2-15/2-30 min, min bis Soll -1 K, Laufdauer, Stopp ueber Vorlauf');
const S = {C: [], E: []};
runs.forEach(r => {
    const ts = dmt(r.t0);
    console.log(ts, mode(r.hc0), 'AT', f(r.at, 0), 'Q' + r.q0, 'hz15', r.hz15, 'hz30', r.hz30, 'soll-1K nach', r.reach === null ? '–' : Math.round(r.reach), 'min, Lauf', Math.round(r.min), 'min', r.thermo ? 'Thermo-Stopp' : (r.ende ? 'Stopp' : 'laeuft/Luecke'), r.hcSet.size > 1 ? '(Wechsel im Lauf)' : '');
    if ((r.hc0 === 0 || r.hc0 === 1) && r.ende && r.hcSet.size === 1) { S[mode(r.hc0)].push(r); }
});
['C', 'E'].forEach(m => { const L = S[m]; if (!L.length) { return; } const md = a => { a = a.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    console.log(m, 'abgeschlossene Laeufe ohne Wechsel:', L.length, 'Median Lauf', md(L.map(r => r.min)).toFixed(0), 'min, Median hz15', md(L.map(r => r.hz15)), 'Median bis Soll -1 K', md(L.filter(r => r.reach !== null).map(r => r.reach)), 'min, Thermo-Stopps', L.filter(r => r.thermo).length); });
console.log('\n== (4) Wechsel der Heizregelung');
wechsel.forEach(w => { console.log(dmt(w.t), w.von + '->' + w.zu, w.lauf ? 'im Lauf' : 'in der Pause', 'AT', f(w.at, 0),
    '| vorher Hz', f(w.vor.hz, 1), 'Pumpe', f(w.vor.pump, 0), 'Flow', f(w.vor.flow, 1), 'Pel', f(w.vor.pel, 0), '| nachher 1-5 min Hz', f(w.nach.hz, 1), 'Pumpe', f(w.nach.pump, 0), 'Flow', f(w.nach.flow, 1), 'Pel', f(w.nach.pel, 0), '| 6-15 min Hz', f(w.nach15.hz, 1), 'Pel', f(w.nach15.pel, 0)); });

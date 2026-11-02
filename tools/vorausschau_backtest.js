// Backtest der Vorausschau-Schwelle (Entwurf 02.11.2026, Teil B): liest Fahrplan-Schnappschuesse und Ist-Werte, rechnet die Bedarfsaenderung je Fenster und Schwelle.
// Usage: node tools/vorausschau_backtest.js <plan-snapshots.jsonl> <plan-eval.csv> [spalte: at|at_roh]   ohne Argumente: Selbstpruefung mit erfundenen Reihen
const fs = require('fs'), assert = require('assert');
const H = 3600000, FENSTER = [[2, 5], [3, 12], [6, 12], [6, 24]], SCHWELLEN = [2, 1.5, 1], ECHT_K = 1, ENTPRELL_H = 6;
function zeit(s) { const n = Number(s); return Number.isFinite(n) && n > 1e8 ? (n < 1e11 ? n * 1000 : n) : Date.parse(String(s).replace(' ', 'T')); }
function stunde(t) { return Math.floor(t / H) * H; }
function istAusCsv(text) {                                                       // {Stunde: mittlere Fuehlertemperatur}
    const L = text.trim().split('\n'), k = L[0].split(','), iT = k.indexOf('slot_start'), iV = k.indexOf('vorlauf_soll_h'), iI = k.indexOf('ist_aussen'), S = {};
    assert(iT >= 0 && iV >= 0 && iI >= 0, 'plan-eval: Spalten slot_start, vorlauf_soll_h, ist_aussen fehlen: ' + L[0]);
    L.slice(1).forEach(z => { const c = z.split(','); if (Number(c[iV]) !== 1) { return; } const t = zeit(c[iT]), v = Number(c[iI]); if (!Number.isFinite(t) || c[iI] === '' || !Number.isFinite(v)) { return; } const h = stunde(t); (S[h] = S[h] || []).push(v); });
    const o = {}; Object.keys(S).forEach(h => { o[h] = S[h].reduce((a, b) => a + b, 0) / S[h].length; }); return o;
}
function snapsAusJsonl(text, spalte) {                                           // [{t0, at: {Stunde: Prognose}}]
    return text.trim().split('\n').map(z => JSON.parse(z)).map(j => {
        const iS = j.cols.indexOf(spalte), iT = j.cols.indexOf('t'), S = {}; if (iS < 0) { return null; }
        j.slots.forEach(r => { const t = (iT >= 0 ? r[iT] : r[0]) * 1000, v = r[iS]; if (v === null || v === undefined) { return; } const h = stunde(t); (S[h] = S[h] || []).push(v); });
        const at = {}; Object.keys(S).forEach(h => { at[h] = S[h].reduce((a, b) => a + b, 0) / S[h].length; });
        return {t0: stunde(j.t0 < 1e11 ? j.t0 * 1000 : j.t0), at: at};
    }).filter(Boolean);
}
function tagesgang(ist) {                                                        // Abweichung vom zentrierten 24-h-Mittel, gemittelt ueber bis zu 7 Vortage
    function dev(t) { if (ist[t] === undefined) { return null; } let s = 0, n = 0; for (let j = -12; j < 12; j++) { const v = ist[t + j * H]; if (v !== undefined) { s += v; n++; } } return n >= 20 ? ist[t] - s / n : null; }
    return (t, t0) => { let s = 0, n = 0; for (let k = 1; k <= 7; k++) { const u = t - k * 24 * H; if (u + 12 * H > t0) { continue; } const d = dev(u); if (d !== null) { s += d; n++; } } return n >= 3 ? s / n : null; };
}
function mittel(q, t0, a, b, base) { let s = 0; for (let h = a; h <= b; h++) { const t = t0 + h * H, v = q[t], g = base(t, t0); if (v === undefined || g === null) { return null; } s += v - g; } return s / (b - a + 1); }
function auswerten(snaps, ist) {
    const base = tagesgang(ist), R = [];
    FENSTER.forEach(([a, b]) => SCHWELLEN.forEach(th => {
        let lagen = 0, ausl = 0, echt = 0, letzte = -Infinity;
        snaps.slice().sort((x, y) => x.t0 - y.t0).forEach(s => {
            const g0 = base(s.t0, s.t0), j = ist[s.t0]; if (g0 === null || j === undefined) { return; }
            const p = mittel(s.at, s.t0, a, b, base), w = mittel(ist, s.t0, a, b, base); if (p === null || w === null) { return; }
            lagen++; const signal = p - (j - g0), real = w - (j - g0);
            if (signal >= th && s.t0 - letzte >= ENTPRELL_H * H) { ausl++; letzte = s.t0; if (real >= ECHT_K) { echt++; } }
        });
        R.push({fenster: '+' + a + '…+' + b + ' h', schwelle: th, lagen: lagen, ausloesungen: ausl, echt: echt, quote: ausl ? Math.round(100 * echt / ausl) : null});
    }));
    return R;
}
function wahl(R) { const ok = R.filter(r => r.quote !== null && r.quote >= 60); return ok.length ? ok.sort((a, b) => b.ausloesungen - a.ausloesungen || b.quote - a.quote)[0] : null; }
function selbstpruefung() {
    const t0 = stunde(Date.UTC(2026, 9, 1)), ist = {}, at = {}; const N = 14 * 24;
    for (let i = 0; i < N; i++) { const t = t0 + i * H, tag = Math.floor(i / 24); ist[t] = 5 + 3 * Math.sin(2 * Math.PI * (i % 24) / 24) + (tag === 10 && i % 24 >= 6 ? 6 : 0); }
    const snaps = []; for (let i = 8 * 24; i < N - 30; i++) { const a = {}; for (let h = 0; h <= 26; h++) { a[t0 + (i + h) * H] = ist[t0 + (i + h) * H]; } snaps.push({t0: t0 + i * H, at: a}); }
    const R = auswerten(snaps, ist), r = R.find(x => x.fenster === '+3…+12 h' && x.schwelle === 2);
    assert(r.ausloesungen >= 1 && r.quote === 100, 'perfekte Prognose mit echter Milderung muss treffen: ' + JSON.stringify(r));
    const falsch = snaps.map(s => { const a = {}; Object.keys(s.at).forEach(k => { a[k] = s.at[k] + (Number(k) > s.t0 + 2 * H ? 4 : 0); }); return {t0: s.t0, at: a}; });
    const rf = auswerten(falsch, ist).find(x => x.fenster === '+3…+12 h' && x.schwelle === 2);
    assert(rf.ausloesungen > r.ausloesungen && rf.quote < 60, 'Scheinmilderung muss unter 60 % bleiben: ' + JSON.stringify(rf));
    assert(wahl([{quote: 50, ausloesungen: 9}, {quote: 70, ausloesungen: 3}, {quote: 90, ausloesungen: 2}]).ausloesungen === 3 && wahl([{quote: 10, ausloesungen: 9}]) === null, 'Wahl');
    assert.strictEqual(istAusCsv('slot_start,vorlauf_soll_h,ist_aussen\n1000000000,1,2\n1000000000,3,9\n')[stunde(1e12)], 2);
    console.log('Selbstpruefung OK');
}
if (require.main === module) {
    if (process.argv.length < 4) { selbstpruefung(); process.exit(0); }
    const R = auswerten(snapsAusJsonl(fs.readFileSync(process.argv[2], 'utf8'), process.argv[4] || 'at'), istAusCsv(fs.readFileSync(process.argv[3], 'utf8')));
    console.table(R); console.log('Wahl (hoechste Ausloesezahl mit mindestens 60 % echt):', JSON.stringify(wahl(R)));
}
module.exports = {auswerten, wahl, istAusCsv, snapsAusJsonl};

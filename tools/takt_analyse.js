// Takt-Analyse (nur lesen): Verdichter-Laeufe aus den echten Minutenprotokollen (quiet-YYYY-MM.csv, ueber engine_replay.buildInputs), je Lauf
// Dauer, Stopp-Art, Quiet, Frequenz, Ruecklauf-Rueckstand, Vorlauf-Anstieg und die Ausloeser der Regel "Laufzeit strecken" (v1 und Vorschlag v2).
// Usage: node tools/takt_analyse.js <Datenordner> [--md]
// Stopp-Art: "Thermo" = Vorlauf in den letzten 3 Laufminuten >= Soll +2,75 K (Abschaltgrenze Soll +3,0...+3,25 K, Handbuch: Vorlauf - interner Soll > 2 K 3 min);
//            "Heizgrenze" = binnen 5 min danach Pumpe < 1000 U/min; sonst "anders" (z. B. Soll von Hand gesenkt). Laeufe am Rand des Zeitraums (offen) werden gezaehlt, aber nicht als kurz/lang gewertet.
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const path = require('path');
const E = require('./engine_core.js');
const RP = require('./engine_replay.js');
const MIN = 60000;

function have(v) { return typeof v === 'number' && isFinite(v); }
function mean(a) { const v = a.filter(have); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; }
function median(a) { const v = a.filter(have).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; }

function runs(inputs) {
    const out = []; let cur = null, lastStop = null;
    inputs.forEach((x, i) => {
        const on = have(x.hz) && x.hz > 0 && x.hpAge <= 5;
        if (on && !cur) { cur = {i0: i, t0: x.t, rows: [], pauseVor: lastStop ? (x.t - lastStop) / MIN : null, offenStart: i === 0}; }
        if (on) { cur.rows.push(x); }
        if (!on && cur && have(x.hz) && x.hpAge <= 5) {
            cur.t1 = x.t; cur.nach = inputs.slice(i, i + 5); out.push(cur); lastStop = x.t; cur = null;
        }
    });
    if (cur) { cur.t1 = inputs[inputs.length - 1].t; cur.offenEnde = true; cur.nach = []; out.push(cur); }
    return out.map(R => {
        const r = R.rows, dur = (R.t1 - R.t0) / MIN, last3 = r.slice(-3), ab15 = r.filter((x, k) => k >= 15);
        const over = last3.length ? Math.min.apply(null, last3.map(x => x.vl - x.soll)) : null;
        const pumpNach = R.nach.length ? Math.min.apply(null, R.nach.map(x => have(x.pump) ? x.pump : 9999)) : null;   // Heizgrenze: Pumpe steht binnen 5 min nach dem Stopp
        const art = R.offenEnde ? 'offen' : (have(over) && over >= 2.75 ? 'Thermo' : (pumpNach !== null && pumpNach < 1000 ? 'Heizgrenze' : 'anders'));
        const rlR = x => (x.soll - x.dT) - x.rl;
        const w = (a, b) => r.filter((x, k) => k >= a && k < b);
        const sl = (a, b) => { const s = w(a, b); return s.length >= 5 ? (s[s.length - 1].vl - s[0].vl) / ((s[s.length - 1].t - s[0].t) / 3600000) : null; };
        const qs = {}; r.forEach(x => { qs[x.q] = (qs[x.q] || 0) + 1; });
        const sollJump = r.some((x, k) => k > 0 && x.soll - r[k - 1].soll >= 1);
        return {t0: R.t0, t1: R.t1, dur: Math.round(dur), art: art, offen: !!(R.offenEnde || R.offenStart), pauseVor: R.pauseVor === null ? null : Math.round(R.pauseVor),
                q: Object.keys(qs).sort((a, b) => qs[b] - qs[a])[0], qs: qs, at: mean(r.map(x => x.at)), soll: median(r.map(x => x.soll)), sollJump: sollJump, hc: median(r.map(x => x.hc)),
                hz15_30: median(w(15, 30).map(x => x.hz)), hzMax15: ab15.length ? Math.max.apply(null, ab15.map(x => x.hz)) : null, hzMed: median(ab15.map(x => x.hz)),
                min22: ab15.filter(x => x.hz >= 22).length, rl15_30: mean(w(15, 30).map(rlR)), vl15_30: mean(w(15, 30).map(x => x.soll - x.vl)), slope15_30: sl(15, 30),
                over: over, pel: mean(ab15.map(x => x.pel)), rows: r};
    });
}

if (require.main === module) {
    const dir = process.argv[2];
    const inputs = RP.buildInputs(dir, '2026-10');
    const L = runs(inputs);
    const fx = (v, d) => v === null || v === undefined ? '–' : E.de(v, d);
    console.log('| Start | Dauer min | Ende | Pause davor | Quiet | AT | Soll | Hz 15–30 (max ab 15) | Min ≥ 22 Hz | RL-Rückstand 15–30 | VL-Anstieg K/h 15–30 | Sollsprung |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    L.forEach(r => console.log('| ' + E.iso(r.t0).slice(5, 16) + ' | ' + r.dur + (r.offen ? ' (offen)' : '') + ' | ' + r.art + (r.art === 'Thermo' ? ' ' + fx(r.over, 2) : '') + ' | ' + fx(r.pauseVor, 0) + ' | ' + JSON.stringify(r.qs).replace(/"/g, '') + ' | ' + fx(r.at, 1) + ' | ' + fx(r.soll, 0) + ' | ' + fx(r.hz15_30, 0) + ' (' + fx(r.hzMax15, 0) + ') | ' + r.min22 + ' | ' + fx(r.rl15_30, 2) + ' | ' + fx(r.slope15_30, 1) + ' | ' + (r.sollJump ? 'ja' : '') + ' |'));
    const zu = L.filter(r => !r.offen), th = zu.filter(r => r.art === 'Thermo'), kurz = zu.filter(r => r.dur < 60), d = th.map(r => r.dur).sort((a, b) => a - b);
    console.log('\nLäufe abgeschlossen: ' + zu.length + ' · Abschaltung über den Vorlauf: ' + th.length + ' (' + d[0] + '–' + d[d.length - 1] + ' min, Median ' + d[Math.floor(d.length / 2)] + ') · kürzer als 60 min: ' + kurz.length + ' (' + kurz.map(r => E.iso(r.t0).slice(5, 16) + ' ' + r.dur + ' min ' + r.art + ', AT ' + fx(r.at, 1)).join('; ') + ') · Takte (Abschaltung über den Vorlauf < 60 min): ' + th.filter(r => r.dur < 60).length);
    const q0 = th.filter(r => r.q === '0'), q3 = th.filter(r => r.q === '3'), md = a => { const v = a.map(r => r.dur).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
    console.log('Abschaltung über den Vorlauf nach Quiet: Quiet 0 ' + q0.length + ' Läufe, Median ' + md(q0) + ' min, AT Ø ' + fx(mean(q0.map(r => r.at)), 1) + ' · Quiet 3 ' + q3.length + ' Läufe, Median ' + md(q3) + ' min, AT Ø ' + fx(mean(q3.map(r => r.at)), 1));
    const h22 = zu.filter(r => r.min22 > 0 && r.q === '0' && r.rl15_30 < 2);
    console.log('Läufe mit Quiet 0 und ≥ 22 Hz ohne Boost: ' + h22.length + ' (' + h22.map(r => E.iso(r.t0).slice(5, 16) + ': ' + r.min22 + ' min ≥ 22 Hz, Pause davor ' + r.pauseVor + ' min, Lauf ' + r.dur + ' min').join('; ') + ')');
    // Vorhersage "Abschaltgrenze in <= 45 min" (Regel v1) gegen den tatsaechlichen Stopp, Minuten ab Laufminute 15
    const mins = []; RP.replay(dir, {keepRecs: false, onStep: (o, inp) => { mins.push({t: inp.t, run: o.d.running, rm: o.d.runMin, hz: o.d.hz, q: o.d.q, rl: o.d.rlRueck, eta: o.d.stopEtaMin}); }});
    let ns = null; for (let i = mins.length - 1; i >= 0; i--) { if (!mins[i].run) { ns = mins[i].t; } mins[i].rest = mins[i].run && ns ? (ns - mins[i].t) / MIN : null; }
    const e = mins.filter(m => m.run && m.rm >= 15 && have(m.eta) && m.eta <= 45 && m.rest !== null), e22 = e.filter(m => m.hz >= 22), e22o = e22.filter(m => have(m.rl) && m.rl <= 1);
    console.log('Vorhersage Abschaltgrenze ≤ 45 min (ab Laufminute 15): ' + e.length + ' Minuten, Stopp binnen Vorhersage + 15 min: ' + e.filter(m => m.rest <= m.eta + 15).length + ' · davon ≥ 22 Hz: ' + e22.length + ', Stopp binnen Vorhersage + 15 min: ' + e22.filter(m => m.rest <= m.eta + 15).length + ', binnen 60 min: ' + e22.filter(m => m.rest <= 60).length +
                ' · ≥ 22 Hz ohne Bedarf (Rücklauf ≤ 1 K unter Soll): ' + e22o.length + ' Minuten, Vorhersage ' + Math.round(Math.min.apply(null, e22o.map(m => m.eta))) + '–' + Math.round(Math.max.apply(null, e22o.map(m => m.eta))) + ' min, tatsächlich ' + Math.round(Math.min.apply(null, e22o.map(m => m.rest))) + '–' + Math.round(Math.max.apply(null, e22o.map(m => m.rest))) + ' min bis zum Stopp');
}
module.exports = {runs: runs};

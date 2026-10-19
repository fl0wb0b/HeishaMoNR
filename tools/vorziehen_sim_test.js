// Tests für tools/vorziehen_sim.js: Akku-Bilanz (Energieerhaltung, Grenzen), DESS-nah, Preise, Entscheidung nur mit vergangenen Prognosen (kein Blick in die Zukunft),
// Rückweg-Logik der Varianten, Startbefehl bei Soll-Anhebung im Zwilling, Determinismus. Synthetisch; mit Datenordner zusätzlich auf echten Protokollen (Validierung, Laufzeit).
// Usage: node tools/vorziehen_sim_test.js [Datenordner wp_params.json]
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const V = require('./vorziehen_sim.js');
const Z = require('./wp_zwilling.js');
let oks = 0, fails = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined && info !== '' ? '  -> ' + info : '')); if (cond) { oks++; } else { fails++; } }
const nah = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);
const MIN = 60000, HOUR = 60 * MIN;
const datenDir = process.argv[2] || null, paramDatei = process.argv[3] || path.join(__dirname, 'fixtures', 'wp_params.json');
const P = fs.existsSync(paramDatei) ? Z.mitWerten(JSON.parse(fs.readFileSync(paramDatei, 'utf8')).werte) : Z.standard();
const A = V.AKKU;

// Pseudozufall (deterministisch)
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

console.log('--- Akku „Eigenverbrauch“');
{
    let soc = 0.5 * A.kapKWh, ok = true, okGrenze = true, okLeistung = true, ein = 0, aus = 0, verl = 0; const soc0 = soc, dt = 1 / 60;
    for (let i = 0; i < 20000; i++) {
        const pv = rnd() < 0.4 ? 0 : rnd() * 25, last = 0.2 + rnd() * 15, b = V.akkuSchritt(soc, pv, last, dt, A);
        if (!nah(pv + b.bezug + b.entladen, last + b.laden + b.einsp, 1e-9)) { ok = false; }
        if (!nah(b.soc - soc, b.laden * A.etaLaden * dt - b.entladen / A.etaEntladen * dt, 1e-9)) { ok = false; }
        if (b.soc < A.kapKWh * A.socMinPct / 100 - 1e-9 || b.soc > A.kapKWh * A.socMaxPct / 100 + 1e-9) { okGrenze = false; }
        if (b.laden > A.pMaxKW + 1e-9 || b.entladen > A.pMaxKW + 1e-9 || b.bezug < -1e-12 || b.einsp < -1e-12 || (b.laden > 0 && b.entladen > 0)) { okLeistung = false; }
        ein += (pv + b.bezug) * dt; aus += (last + b.einsp) * dt; verl += b.verlust; soc = b.soc;
    }
    check('Bilanz je Schritt: PV + Bezug + Entladen = Last + Laden + Einspeisung; SOC-Änderung = Laden·η − Entladen/η (20 000 Zufallsschritte)', ok);
    check('Energieerhaltung gesamt: PV + Bezug = Last + Einspeisung + Verluste + Δ Akku', nah(ein, aus + verl + (soc - soc0), 1e-6), 'Verluste ' + verl.toFixed(1) + ' kWh');
    check('SOC bleibt in [Untergrenze, Obergrenze]', okGrenze);
    check('Leistungen ≤ 12 kW, nie gleichzeitig Laden und Entladen, Bezug/Einspeisung ≥ 0', okLeistung);
    const lo = A.kapKWh * A.socMinPct / 100, hi = A.kapKWh;
    const b1 = V.akkuSchritt(lo, 0, 2, 1 / 60, A), b2 = V.akkuSchritt(hi, 10, 1, 1 / 60, A), b3 = V.akkuSchritt(20, 30, 1, 1 / 60, A), b4 = V.akkuSchritt(20, 0, 20, 1 / 60, A);
    check('am Minimum: Defizit kommt ganz aus dem Netz', nah(b1.bezug, 2) && b1.entladen === 0 && nah(b1.soc, lo));
    check('voll: Überschuss wird ganz eingespeist', nah(b2.einsp, 9) && b2.laden === 0);
    check('Leistungsgrenze: 29 kW Überschuss → 12 kW Laden, 17 kW Einspeisung; 20 kW Defizit → 12 kW Entladen, 8 kW Bezug', nah(b3.laden, 12) && nah(b3.einsp, 17) && nah(b4.entladen, 12) && nah(b4.bezug, 8));
    const bU = V.akkuSchritt(lo - 1, 0, 1, 1 / 60, A);
    check('unter der Untergrenze gestartet (gemessen 9,9 %): keine Entladung, kein negativer Wert', bU.entladen === 0 && nah(bU.bezug, 1));
}
console.log('--- Akku „DESS-nah“ (gemessener Pfad + Differenz)');
{
    const m = {soc: 50, netz: 0, batt: -1, frisch: true};
    let r = V.dessSchritt({dSoc: 0}, m, 0, 1 / 60, A);
    check('ohne Differenz: gemessene Flüsse unverändert', nah(r.bezug, 0) && nah(r.einsp, 0) && nah(r.entl, 1) && nah(r.st.dSoc, 0));
    r = V.dessSchritt({dSoc: 0}, m, 0.5, 1 / 60, A);
    check('Eigenverbrauch (Netz ≈ 0): +0,5 kW WP kommt aus dem Akku', nah(r.entl, 1.5) && nah(r.bezug, 0) && nah(r.st.dSoc, -0.5 / A.etaEntladen / 60));
    r = V.dessSchritt({dSoc: 0}, {soc: 55, netz: -10, batt: 0, frisch: true}, 0.5, 1 / 60, A);
    check('Dynamic ESS speist ein (Akku hält 55 %): +0,5 kW WP mindert die Einspeisung', nah(r.einsp, 9.5) && nah(r.st.dSoc, 0));
    r = V.dessSchritt({dSoc: 0}, {soc: 10, netz: 0.6, batt: 0, frisch: false}, 0.5, 1 / 60, A);
    check('Akku am Boden: +0,5 kW WP aus dem Netz', nah(r.bezug, 1.1) && nah(r.st.dSoc, 0));
    let st = {dSoc: 0}, okS = true, sumD = 0, sumG = 0;
    for (let i = 0; i < 5000; i++) {
        const mm = {soc: 10 + rnd() * 90, netz: rnd() < 0.3 ? (rnd() - 0.5) * 10 : 0, batt: (rnd() - 0.5) * 4, frisch: rnd() < 0.8}, dP = (rnd() - 0.5) * 1.5;
        const x = V.dessSchritt(st, mm, dP, 1 / 60, A); st = x.st;
        if (x.soc < A.kapKWh * A.socMinPct / 100 - 1e-9 || x.soc > A.kapKWh + 1e-9 || x.bezug < -1e-9 || x.einsp < -1e-9) { okS = false; }
        sumD += dP; sumG += x.bezug - Math.max(0, mm.netz) - (x.einsp - Math.max(0, -mm.netz));
    }
    check('DESS-nah: SOC des Pfads bleibt in den Grenzen, Bezug/Einspeisung ≥ 0 (5000 Zufallsschritte)', okS);
}
console.log('--- Preise (VRM dynamic-ess-settings)');
{
    const t = h => new Date(2026, 9, 15, h, 30).getTime();
    check('Kauf 0,21 €/kWh 00–05 Uhr, sonst 0,31; Verkauf 0,06 € 06–22 Uhr, nachts 0', V.preisKauf(t(3)) === 0.21 && V.preisKauf(t(5)) === 0.31 && V.preisKauf(t(14)) === 0.31 && V.preisVerkauf(t(23)) === 0 && V.preisVerkauf(t(5)) === 0 && V.preisVerkauf(t(12)) === 0.06);
}

// ------------------------------------------------------------------ synthetischer Kontext: mild, sonnig, perfekte stündliche Prognose
function synth(opts) {
    opts = opts || {};
    const tage = opts.tage || 3, N = tage * 1440, t0 = new Date(2026, 9, 20, 0, 0).getTime();
    const atAt = opts.at || (h => 8 + 4 * Math.sin(2 * Math.PI * (h - 9) / 24)), pvAt = opts.pv || (h => (h > 8 && h < 17 ? 12 * Math.sin(Math.PI * (h - 8) / 9) : 0));
    const M = [], en = {pv: new Float64Array(N), rest: new Float64Array(N), soc: new Float64Array(N), netz: new Float64Array(N), batt: new Float64Array(N), frisch: new Uint8Array(N)};
    for (let i = 0; i < N; i++) { const h = (i % 1440) / 60; M.push({t: t0 + i * MIN, at: Math.round(atAt(h) * 10) / 10, rh: 80, pv: pvAt(h)}); en.pv[i] = pvAt(h); en.rest[i] = 0.6; en.soc[i] = 60; }
    const F = [];
    for (let k = 0; k < tage * 24; k++) {
        const ts = t0 + k * HOUR + 2 * MIN, owm = [], pv = [], cons = [];                  // Schnappschuss 2 min nach der vollen Stunde (wie auf der NAS)
        for (let j = 0; j <= 13; j++) { const x = ts + j * 3 * HOUR; owm.push([x, atAt(((x - t0) / HOUR) % 24), 80, 10]); }
        for (let j = 0; j < 37; j++) { const x = t0 + (k + j) * HOUR; pv.push([x / 1000, pvAt((((x - t0) / HOUR) % 24) + 0.5) * 1000, 3600]); cons.push([x / 1000, 1100]); }
        F.push({t: ts / 1000, owm: owm, pv: pv, cons: cons});
    }
    let S = Z.neu(P, {modus: 'pause', th: 21, tw: 28, at: 8});
    for (let i = 0; i < 1440; i++) { S = Z.schritt(S, {t: t0 - (1440 - i) * MIN, at: M[i].at, rh: 80, pv: M[i].pv, q: 3, hc: 1, shift: 0}, P).S; }
    return {N: N, t0: t0, M: M, en: en, F: F, S0: S, wp: new Float64Array(N)};
}

console.log('--- Prognose: nur Vergangenheit');
{
    const ctx = synth(), t = ctx.t0 + 12 * HOUR;
    const s = V.snapshotVor(ctx.F, t);
    check('snapshotVor liefert den letzten Schnappschuss mit Zeitstempel ≤ Entscheidungszeit', s && s.t * 1000 <= t && ctx.F.filter(x => x.t * 1000 <= t).every(x => x.t <= s.t), s ? new Date(s.t * 1000).toTimeString().slice(0, 5) : '–');
    check('snapshotVor vor dem ersten Schnappschuss: keiner (keine Prognose → keine Entscheidung)', V.snapshotVor(ctx.F, ctx.F[0].t * 1000 - 1) === null && V.entscheidung({t: ctx.F[0].t * 1000 - 1, F: ctx.F, socKWh: 30, akku: A}, V.POLITIK).ok === false);
    const giftig = ctx.F.map(x => x.t * 1000 > t ? {t: x.t, owm: x.owm.map(o => [o[0], 40, 80, 0]), pv: x.pv.map(p => [p[0], 0, p[2]]), cons: x.cons} : x);
    const e1 = V.entscheidung({t: t, F: ctx.F, socKWh: 30, akku: A}, V.POLITIK), e2 = V.entscheidung({t: t, F: giftig, socKWh: 30, akku: A}, V.POLITIK);
    check('Entscheidung um 12 Uhr unverändert, wenn alle späteren Schnappschüsse vergiftet sind (PV 0, AT 40 °C)', JSON.stringify(e1) === JSON.stringify(e2), 'ok ' + e1.ok + ', deckt ' + e1.deckt + ', ΔAT ' + (e1.atFenster - e1.atNacht).toFixed(1) + ' K');
    // geschlossener Lauf: Spuren bis zum Giftzeitpunkt bit-gleich, danach (ab der nächsten Entscheidung) verschieden
    const tGift = ctx.t0 + 1440 * MIN + 12 * HOUR + 30 * MIN, gift2 = ctx.F.map(x => x.t * 1000 > tGift ? {t: x.t, owm: x.owm, pv: x.pv.map(p => [p[0], 0, p[2]]), cons: x.cons} : x);
    const pol = {ohneC: true, aModus: 'deckt'};
    const r1 = V.lauf(ctx, 'B', {P: P, politik: pol, log: true}), r2 = V.lauf(Object.assign({}, ctx, {F: gift2}), 'B', {P: P, politik: pol, log: true});
    const iG = (tGift - ctx.t0) / MIN; let gleich = true, danach = false;
    for (let i = 0; i < ctx.N; i++) { const g = r1.spur.shift[i] === r2.spur.shift[i] && r1.spur.wp[i] === r2.spur.wp[i] && r1.spur.soc[i] === r2.spur.soc[i]; if (i < iG && !g) { gleich = false; } if (i >= iG && !g) { danach = true; } }
    check('geschlossener Lauf B: alle Spuren bis zum Giftzeitpunkt (Tag 2, 12:30) bit-gleich', gleich, 'Vorziehen-Tage ' + r1.summe.vzTage);
    check('… und das Gift wirkt danach (sonst prüfte der Test nichts): Abbruch bei der Neuprüfung 13 Uhr', danach && r2.politik.n.abbruchPrognose >= 1, 'Abbrüche Prognose ' + (r2.politik.n.abbruchPrognose || 0));
    check('jede protokollierte Entscheidung nutzt einen Schnappschuss mit Zeitstempel ≤ Entscheidungszeit', r1.politik.log.length > 0 && r1.politik.log.every(x => x.snapT === null || x.snapT * 1000 <= x.t), r1.politik.log.length + ' Entscheidungen');
}
console.log('--- Regeln (Rückweg, Fenster, Nacht)');
{
    const t0 = new Date(2026, 9, 20, 0, 0).getTime(), R = (a, b, c, d) => ({ki_oben: a, ki_unten: b, schlaf: c, wohn: d});
    const warm = R(23.5, 21.3, 21.3, 23.5), kalt = R(23.0, 20.2, 21.1, 23.0), mitte = R(23.0, 20.8, 20.8, 23.0), heiss = R(23.0, 22.3, 20.8, 23.0);
    const c = (t, r, extra) => Object.assign({t: t, raeume: r, socKWh: 40, F: [], akku: A, modus: 'lauf', pauseMin: 0}, extra || {});
    const seq = (v, pol, f, von, bis) => { let PS = V.politikNeu(); const out = []; for (let t = von; t < bis; t += 5 * MIN) { PS = V.politik(PS, f(t), Object.assign({}, V.POLITIK, pol || {}), v); out.push([t, PS.shift]); } return {PS: PS, out: out}; };
    // C: alle über der Bandmitte → nach 60 min −1 K; ein Raum < Minimum + 0,3 → zurück; 120 min Sperre
    const tK = t0 + 3 * HOUR;
    const s1 = seq('C', {}, t => c(t, t < tK ? warm : (t < tK + 30 * MIN ? kalt : warm)), t0, t0 + 8 * HOUR);
    const erstMinus = s1.out.find(x => x[1] === -1), zurueck = s1.out.find(x => x[0] >= tK && x[1] === 0), wieder = s1.out.find(x => x[0] > tK && x[1] === -1);
    check('C: −1 K erst nach 60 min „alle Räume über der Bandmitte“', erstMinus && erstMinus[0] - t0 === 60 * MIN, erstMinus ? (erstMinus[0] - t0) / MIN + ' min' : '–');
    check('C: Rückweg sofort, wenn ein Raum unter Minimum + 0,3 K fällt', zurueck && zurueck[0] === tK);
    check('C: nach dem Rückweg 120 min Sperre, dann erst wieder −1 K', wieder && wieder[0] - tK >= 120 * MIN, wieder ? (wieder[0] - tK) / MIN + ' min' : '–');
    // B: Fenster, Startbefehl erst nach 20 min Pause, Abbruch bei Raum über Maximum, Nacht −1 K bis 06 Uhr
    const ctx = synth({tage: 2});
    const F = ctx.F, tag = ctx.t0;
    const fB = (r, extra) => t => c(t, r(t), Object.assign({F: F, socKWh: 42}, extra ? extra(t) : {}));
    const s2 = seq('B', {aModus: 'deckt'}, fB(t => (t < tag + 17 * HOUR ? mitte : warm)), tag, tag + 30 * HOUR + 10 * MIN);
    const plus = s2.out.filter(x => x[1] === 1), minus = s2.out.filter(x => x[1] === -1);
    check('B: +1 K nur im Fenster 12–17 Uhr', plus.length > 0 && plus.every(x => new Date(x[0]).getHours() >= 12 && new Date(x[0]).getHours() < 17), plus.length * 5 + ' min');
    check('B: danach Nacht −1 K (alle Räume über der Bandmitte, 60 min) und um 06 Uhr zurück auf 0', minus.length > 0 && minus.every(x => { const h = new Date(x[0]).getHours(); return h >= 17 || h < 6; }) && s2.out.find(x => x[0] === tag + 30 * HOUR - 5 * MIN)[1] === -1 && s2.out.find(x => x[0] === tag + 30 * HOUR)[1] === 0, minus.length * 5 + ' min −1 K');
    const s3 = seq('B', {aModus: 'deckt'}, fB(() => mitte, t => ({modus: 'pause', pauseMin: (t - (tag + 12 * HOUR)) / MIN + 5})), tag + 11 * HOUR, tag + 13 * HOUR);
    const p3 = s3.out.find(x => x[1] === 1);
    check('B in der Pause: +1 K (= Startbefehl) erst ab 20 min Pause', p3 && (p3[0] - (tag + 12 * HOUR)) / MIN + 5 >= 20, p3 ? 'Pause ' + ((p3[0] - (tag + 12 * HOUR)) / MIN + 5) + ' min' : '–');
    const s4 = seq('B', {aModus: 'deckt'}, fB(t => (t >= tag + 13 * HOUR && t < tag + 13 * HOUR + 10 * MIN ? heiss : mitte)), tag + 11 * HOUR, tag + 17 * HOUR);
    const ab = s4.out.find(x => x[0] === tag + 13 * HOUR), spaeter = s4.out.filter(x => x[0] > tag + 13 * HOUR && x[1] === 1);
    check('B: Abbruch, sobald ein Raum über Maximum liegt; am selben Tag kein zweiter Start', ab && ab[1] === 0 && spaeter.length === 0 && s4.PS.n.abbruchRaum === 1);
    const s5 = seq('B', {aModus: 'deckt'}, fB(() => warm), tag + 11 * HOUR, tag + 17 * HOUR);
    check('B: (c) Räume über der Bandmitte → kein Vorziehen', s5.out.every(x => x[1] === 0));
    const s6 = seq('B', {aModus: 'deckt'}, fB(() => mitte, () => ({modus: 'heizgrenze'})), tag + 11 * HOUR, tag + 17 * HOUR);
    check('B: im Heizgrenze-Aus nie +1 K', s6.out.every(x => x[1] === 0));
    const s7 = seq('D', {aModus: 'deckt'}, fB(() => warm), tag, tag + 17 * HOUR);
    check('D: −1 K des Raumeinflusses blockiert das Vorziehen (kein Sprung −1 → +1)', s7.out.every(x => x[1] !== 1) && s7.out.some(x => x[1] === -1));
}
console.log('--- Zwilling: Soll-Anhebung in der Pause startet');
{
    let S = Z.neu(P, {modus: 'pause', th: 21, tw: 30, vl: 31, soll: 30, pauseMin: 30});
    const E = (o) => Object.assign({t: new Date(2026, 9, 20, 10, 0).getTime(), at: 8, rh: 80, pv: 0, q: 3, hc: 1, shift: 0}, o);
    const ohne = Z.schritt(S, E({shift: 1}), P), mit = Z.schritt(S, E({shift: 1, startBefehl: true}), P);
    check('ohne startBefehl kein Start (Vorlauf über der Einschaltschwelle), mit startBefehl Start sofort', !ohne.A.start && mit.A.start);
    const kurz = Z.schritt(Object.assign({}, S, {pauseMin: 1}), E({shift: 1, startBefehl: true}), P);
    check('startBefehl respektiert die Mindestpause (3 min, Handbuch)', !kurz.A.start);
    const ctx = synth({tage: 2}), r1 = V.lauf(ctx, 'C', {P: P}), r2 = V.lauf(ctx, 'C', {P: P, politik: {startBeiAnhebung: false}});
    check('Option startBeiAnhebung = false: Zwilling wie trainiert (Lauf läuft durch)', r2.summe.kwhEl > 0 && r1.summe.kwhEl > 0);
}
console.log('--- Soll-Untergrenze 29 °C und Determinismus');
{
    const ctx = synth({tage: 2, at: () => 13}), warm = V.lauf(ctx, 'N', {P: P});
    check('−1 K bei Außen 13 °C (Kurve 29 °C) wirkt nicht: Soll bleibt ≥ 29 °C', warm.summe.minMinus === 0);
    const ctx2 = synth({tage: 2}), a = V.lauf(ctx2, 'D', {P: P, politik: {aModus: 'deckt'}}), b = V.lauf(ctx2, 'D', {P: P, politik: {aModus: 'deckt'}});
    check('zwei Läufe bit-gleich (Spuren und Tageswerte)', JSON.stringify(a.tage) === JSON.stringify(b.tage) && Buffer.from(a.spur.wp.buffer).equals(Buffer.from(b.spur.wp.buffer)));
    const sumTag = a.tage.reduce((s, x) => s + x.kwhEl, 0);
    check('Tageswerte summieren sich zur Spur (kWh el)', nah(sumTag, Array.from(a.spur.wp).reduce((s, x) => s + x / 60, 0), 0.01));
}

if (datenDir && fs.existsSync(datenDir)) {
    console.log('--- Echte Protokolle: ' + datenDir);
    const t0 = process.hrtime.bigint();
    const ctx = V.ladeDaten(datenDir, '2026-10-08', '2026-10-19');
    const R = V.alles(ctx, P, {});
    const sek = Number(process.hrtime.bigint() - t0) / 1e9;
    const vt = R.validierung.taeglich, mae = vt.reduce((s, x) => s + x.socMae, 0) / vt.length;
    check('Akku-Modell (täglich auf gemessenen SOC gesetzt) bildet den SOC im Mittel auf < 10 %-Pkt. nach', mae < 10, mae.toFixed(1) + ' %-Pkt.');
    const ruhig = vt.filter(x => R.dessBefund.find(y => y.tag === x.tag).einspNichtVoll < 2);
    check('… an Tagen ohne Dynamic-ESS-Einspeisung bei nicht vollem Akku auf < 5 %-Pkt.', ruhig.length > 0 && ruhig.every(x => x.socMae < 5), ruhig.map(x => x.tag.slice(8) + ': ' + x.socMae).join(', '));
    check('Zwilling mit gemessenen Einstellungen: Strom 12 Tage ±10 % der Messung', Math.abs(R.a0.summe.kwhEl / R.messung.summe.kwhEl - 1) < 0.1, R.a0.summe.kwhEl + ' / ' + R.messung.summe.kwhEl + ' kWh');
    check('DESS-nah mit gemessener WP gibt die gemessenen Kosten wieder', Math.abs(R.dessMessung.summe.kosten - R.messung.summe.kosten) < 0.01, R.dessMessung.summe.kosten + ' / ' + R.messung.summe.kosten + ' €');
    check('Laufzeit alles (12 Tage, 4 Varianten, 10 Sätze, Winter) < 60 s', sek < 60, sek.toFixed(1) + ' s');
}
console.log('\n' + oks + ' OK, ' + fails + ' FAIL');
process.exitCode = fails ? 1 : 0;

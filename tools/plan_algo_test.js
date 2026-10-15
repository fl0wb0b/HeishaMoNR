// Tests für tools/plan_algo.js (Offline-Planer). Deterministisch, Fake-Uhr, synthetische Häuser; optional zusätzlich echte Protokolle.
// Usage: node tools/plan_algo_test.js [Datenordner]
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const P = require('./plan_algo.js');

let ok = 0, fail = 0;
function check(name, cond, info) { if (cond) { ok++; console.log('OK   ' + name); } else { fail++; console.log('FAIL ' + name + (info !== undefined ? ' – ' + JSON.stringify(info) : '')); } }

const MIN = 60000, SLOT = 15 * MIN, HOUR = 60 * MIN;
// Synthetisches Haus: Wärmepumpe liefert den Bedarf UA·(Ti − Ta) − g, Räume fest (optional je Raum Funktion der Zeit), perfekte Prognose
function synth(o) {
    o = Object.assign({tage: 3, start: new Date(2026, 10, 2, 0, 0).getTime(), ta: () => 5, rh: () => 70, ua: 0.15, g: 0.4, rl: null, defrost: () => 0, pv: () => 0, soc: 50,
        rooms: [['ki_oben', 22.8, 22, 23.5], ['ki_unten', 21.2, 20, 22], ['schlaf', 21.0, 20, 22], ['wohn', 22.0, 20, 23.5]], kzRad: 1, q: 3, hc: 1}, o);
    const slots = [];
    for (let i = 0; i < o.tage * 96; i++) {
        const t = o.start + i * SLOT, ta = o.ta(t), rooms = o.rooms.map(r => [r[0], typeof r[1] === 'function' ? r[1](t) : r[1], r[2], r[3]]);
        const ti = rooms.length ? rooms.reduce((a, r) => a + r[1], 0) / rooms.length : 22, aus = ta >= 15;
        const q = aus ? 0 : Math.max(0, o.ua * (ti - ta) - o.g) * 0.25, cop = 4.6, soll = Math.max(29, Math.ceil(P.kurve(ta, t) - 1e-9));
        slots.push({t: t, dt: 15, el: aus ? 0.005 : q / cop + 0.005, elRun: aus ? 0 : q / cop, th: q, ta: ta, soll: soll, vl: soll, rl: o.rl !== null ? o.rl : soll - 3, z: aus ? 'aus' : 'lauf',
            hzMax: aus ? 0 : 17, q: o.q, hc: o.hc, defrost: o.defrost(t), kzRad: o.kzRad, rooms: rooms, owm: ta, rh: o.rh(t), pv: o.pv(t), soc: o.soc, haus: 500, el28: 0, lauf: aus ? 0 : 15, laufMin: aus ? 0 : 60});
    }
    P.raumVerlauf(slots, P.defaults());
    const prog = {quelle: 'synthetisch (perfekt)', liste: []};
    for (let t = o.start - HOUR; t < o.start + o.tage * 24 * HOUR; t += HOUR) {
        const pts = []; for (let h = 0; h <= 27; h += 3) { pts.push([t + h * HOUR, o.ta(t + h * HOUR), o.rh(t + h * HOUR)]); }
        prog.liste.push({t: t, at: o.ta(t), pts: pts, pv: []});
    }
    const tage = P.tageBauen(slots);
    return {slots: slots, tage: tage, prog: prog, uaWahr: o.ua, gWahr: o.g, nTage: tage.filter(d => d.voll).length};
}
const pv = x => Object.assign(P.defaults(), x || {});
function laufe(B, x, w) { const p = pv(x); const r = P.lauf(B, p, w || {}); return {r: r, t: P.auswerten(B, r, p), p: p}; }

// (1) Determinismus: zweiter Lauf bit-identisch
{
    const B = synth({tage: 3, ta: t => 6 + 4 * Math.sin(2 * Math.PI * ((t / HOUR) % 24 - 9) / 24)});
    const a = JSON.stringify(P.analyse(B, {schnell: true})), b = JSON.stringify(P.analyse(B, {schnell: true}));
    check('Determinismus: zweiter Lauf bit-identisch (synthetisch)', a === b);
    const A = JSON.parse(a);
    check('Gemäßigtes Wetter mit Reserve: Plan senkt (−1 K) und spart', A.modi.spar.sum.minusH > 0 && A.modi.spar.sum.dE < 0, A.modi.spar.sum);
}
// (2) keine Räume gültig → nie eine Verschiebung
{
    const B = synth({rooms: []}), R = laufe(B, {nurMinus: false});
    check('Keine Räume gültig: kein Befehl', R.r.cmds.length === 0, R.r.cmds.slice(0, 3));
    check('Keine Räume gültig: Plan überall 0', Object.values(R.r.plaene).every(x => x.s.every(v => v === 0)));
    check('Keine Räume gültig: keine Wirkung', R.t.every(d => Math.abs(d.dE) < 1e-9));
}
// (3) Frost: Mindestfrequenz-Tabelle, Heizstab-Nähe (kein +1 K), Rücklauf-Bedingung bei −1 K
{
    check('Frost: Mindestleistung 2,0 kW ab −4 °C (25 Hz, Forum 4596796)', P.pminKW(-5, pv()) === 2.0 && P.pminKW(-12, pv()) === 2.8 && P.pminKW(5, pv()) === 2.1);
    const B = synth({ta: () => -6, rh: () => 70}), R = laufe(B, {nurMinus: false});
    check('Frost: kein +1 K (Heizstab-Nähe)', R.r.cmds.every(c => c.nach <= c.von || c.nach <= 0), R.r.cmds);
    check('Frost: −1 K bei Rücklauf ≥ 28 °C möglich', R.r.cmds.some(c => c.nach === -1), R.r.cmds.slice(0, 2));
    const B2 = synth({ta: () => -6, rl: 27}), R2 = laufe(B2, {nurMinus: true});
    check('Frost: kein −1 K bei Rücklauf < 28 °C (RE-6)', R2.r.cmds.every(c => c.nach >= 0), R2.r.cmds.slice(0, 2));
    const cm = P.copModell([], Infinity);
    check('Frost: COP ohne Messung aus Rückfall-Tabelle (−7 °C ≈ 3,0)', Math.abs(cm.cop(-7) - 3.0) < 1e-9 && cm.cop(-3) < cm.cop(1));
}
// (4) Abtauen: kein +1 K bei Abtauwetter, außer der Raum ist ≥ 0,5 K unter Minimum; kein Befehl im Abtau-Slot
{
    const rooms = [['ki_unten', 19.7, 20, 22], ['schlaf', 21.0, 20, 22]];
    const B = synth({ta: () => 2.5, rh: () => 90, rooms: rooms}), R = laufe(B, {nurMinus: false});
    check('Abtauwetter: kein +1 K bei 0,3 K unter Minimum', R.r.cmds.every(c => c.nach <= 0), R.r.cmds.slice(0, 3));
    const B2 = synth({ta: () => 2.5, rh: () => 90, rooms: [['ki_unten', 19.3, 20, 22], ['schlaf', 21.0, 20, 22]]}), R2 = laufe(B2, {nurMinus: false});
    check('Abtauwetter: +1 K bei ≥ 0,5 K unter Minimum (Komfort vor Energie)', R2.r.cmds.some(c => c.nach === 1), R2.r.cmds.slice(0, 3));
    const B3 = synth({ta: () => 6, defrost: () => 1}), R3 = laufe(B3, {nurMinus: true});
    check('Abtauen: kein Befehl während/kurz nach dem Abtauen', R3.r.cmds.filter(c => c.grund === 'Plan').length === 0, R3.r.cmds.slice(0, 3));
}
// (5) Heizgrenze-Aus: keine Wirkung, kein Befehl
{
    const B = synth({ta: () => 16}), R = laufe(B, {nurMinus: false});
    check('Heizgrenze-Aus: kein Befehl', R.r.cmds.length === 0, R.r.cmds.slice(0, 3));
    check('Heizgrenze-Aus: keine Mehr- oder Minderwärme', R.r.proSlot.every(x => x.dQ === 0));
}
// (6) Soll-Vorlauf ≥ 29 °C: bei 12 °C (Soll 29) nie −1 K
{
    const B = synth({ta: () => 12}), R = laufe(B, {nurMinus: true});
    check('VL ≥ 29 °C: bei Soll 29 kein −1 K', R.r.cmds.length === 0 && R.r.proSlot.every(x => x.s === 0), R.r.cmds.slice(0, 3));
}
// (7) Wärmeverteilung: einer über Maximum, einer unter Minimum → Hinweis statt Verschiebung; ab 0,5 K unter Minimum doch +1 K
{
    const B = synth({rooms: [['wohn', 23.9, 20, 23.5], ['schlaf', 19.7, 20, 22]]}), R = laufe(B, {nurMinus: false});
    check('Wärmeverteilung: keine Verschiebung', R.r.cmds.length === 0, R.r.cmds.slice(0, 3));
    const B2 = synth({rooms: [['wohn', 23.9, 20, 23.5], ['schlaf', 19.4, 20, 22]]}), R2 = laufe(B2, {nurMinus: false});
    check('Wärmeverteilung: +1 K, wenn ein Raum ≥ 0,5 K unter Minimum liegt', R2.r.cmds.length > 0 && R2.r.cmds.every(c => c.nach >= 0), R2.r.cmds.slice(0, 3));
}
// (8) Grenzen der Ausführung: ±1 K je Befehl, Whitelist, ≤ 6 Befehle je Tag, Mindestabstand 60 min (außer Notfall/Untergrenze)
{
    const B = synth({tage: 4, ta: t => 6 + 6 * Math.sin(2 * Math.PI * ((t / HOUR) % 24) / 24), rooms: [['schlaf', t => 20.6 + 0.8 * Math.sin(2 * Math.PI * ((t / HOUR) % 7) / 7), 20, 22], ['ki_unten', 21.5, 20, 22]]});
    const R = laufe(B, {nurMinus: false}), C = R.r.cmds, proTag = {};
    C.forEach(c => { const k = new Date(c.t).toDateString(); proTag[k] = (proTag[k] || 0) + 1; });
    check('Ausführung: höchstens 1 K je Befehl, Werte −1…+1', C.every(c => Math.abs(c.nach - c.von) === 1 && c.nach >= -1 && c.nach <= 1), C.slice(0, 4));
    check('Ausführung: höchstens 6 Befehle je Tag', Object.values(proTag).every(v => v <= 6), proTag);
    check('Ausführung: Plan-Befehle mindestens 60 min nach dem vorigen', C.every((c, i) => i === 0 || c.grund !== 'Plan' || c.t - C[i - 1].t >= 60 * MIN), C.map(c => [new Date(c.t).toTimeString().slice(0, 5), c.grund]));
}
// (9) Kein Blick in die Zukunft: Daten nach t abschneiden ändert keine Entscheidung vor t
{
    const f = t => 4 + 5 * Math.sin(2 * Math.PI * ((t / HOUR) % 24 - 8) / 24);
    const B = synth({tage: 3, ta: f, rooms: [['schlaf', t => 20.9 + 0.5 * Math.sin(t / (5 * HOUR)), 20, 22], ['ki_unten', 21.4, 20, 22]]});
    const tCut = B.slots[0].t + 40 * HOUR;
    const Bk = {slots: B.slots.filter(s => s.t < tCut), tage: P.tageBauen(B.slots.filter(s => s.t < tCut)), prog: {quelle: 'gekürzt', liste: B.prog.liste.filter(x => x.t <= tCut)}, uaWahr: B.uaWahr, gWahr: B.gWahr, nTage: 0};
    const a = laufe(B, {nurMinus: false}), b = laufe(Bk, {nurMinus: false});
    const ca = JSON.stringify(a.r.cmds.filter(c => c.t < tCut)), cb = JSON.stringify(b.r.cmds.filter(c => c.t < tCut));
    const sa = JSON.stringify(a.r.proSlot.filter(x => x.t < tCut).map(x => [x.s, Math.round(x.dT * 1e9)])), sb = JSON.stringify(b.r.proSlot.filter(x => x.t < tCut).map(x => [x.s, Math.round(x.dT * 1e9)]));
    check('Kein Blick in die Zukunft: Befehle vor t unverändert', ca === cb, [ca.slice(0, 200), cb.slice(0, 200)]);
    // Prognose bis t reicht aus; das „wahre“ Haus (uaWahr) ist bei beiden gleich gesetzt
    check('Kein Blick in die Zukunft: Verschiebung und Raumwirkung vor t unverändert', sa === sb);
}
// (10) Modellphysik: Gleichgewicht ΔT = k·s, Mehrwärme über lange Zeit = UA·k·s·Zeit (unabhängig von C)
{
    [1.5, 3, 6].forEach(c => {
        const m = {ua: 0.15, krad: 0.15, c: c}, ph = P.physik(m); let x = 0, q = 0, n = 0;
        for (let i = 0; i < 96 * 20; i++) { const r = P.slotSchritt(x, -1, true, ph, m); x = r.dT1; q += r.dQ; n++; }
        for (let i = 0; i < 96 * 20; i++) { const r = P.slotSchritt(x, 0, true, ph, m); x = r.dT1; q += r.dQ; }
        check('Physik C ' + c + ': Gleichgewicht −0,5 K und Wärmebilanz −UA·k·Zeit', Math.abs(P.slotSchritt(-0.5, -1, true, ph, m).dT1 + 0.5) < 1e-9 && Math.abs(q - (-0.15 * 0.5 * n * 0.25)) < 0.02, {q: q, soll: -0.15 * 0.5 * n * 0.25});
    });
}
// (11) Schicht 1: Lernen findet UA und Gewinne eines bekannten Hauses wieder
{
    const B = synth({tage: 8, ua: 0.13, g: 0.5, ta: t => 3 + ((Math.floor(t / (24 * HOUR)) * 7) % 9) + 2 * Math.sin(2 * Math.PI * ((t / HOUR) % 24) / 24)});
    const m = P.lerneModell(B.tage, Infinity, pv({priorTage: 0.01}));
    check('Schicht 1: UA 0,13 kW/K und g 0,5 kW wiedergefunden (±10 %)', Math.abs(m.ua - 0.13) < 0.013 && Math.abs(m.g - 0.5) < 0.05, m);
    const m0 = P.lerneModell(B.tage, B.tage[1].t0, pv());
    check('Schicht 1: vor 2 Lerntagen gilt der Vorwert', m0.ua === 0.15 && m0.g === 0.3, m0);
}

// (12) Echte Protokolle (optional): Determinismus, Ergebnisrichtung, Schicht 1 besser als das alte Modell
const dir = process.argv[2];
if (dir) {
    const D = P.ladeDaten(dir), B = P.vorbereiten(D);
    const a = JSON.stringify(P.analyse(B, {schnell: true})), b = JSON.stringify(P.analyse(P.vorbereiten(P.ladeDaten(dir)), {schnell: true}));
    check('Echtdaten: zweiter Lauf bit-identisch', a === b);
    const A = JSON.parse(a);
    check('Echtdaten: gleicher Komfort spart (ΔkWh ≤ 0)', A.modi.spar.sum.dE <= 0, A.modi.spar.sum.dE);
    const mae = k => A.s1.reduce((s, x) => s + Math.abs(x[k] - x.ist), 0) / A.s1.length;
    if (/^forecast/.test(A.prog)) { check('Echtdaten: Schicht 1 neues Modell genauer als tbal 15 (mit 24-h-Prognosen)', mae('neu') < mae('alt'), [mae('neu'), mae('alt')]); }
    else { console.log('INFO Schicht 1 ohne forecast-*.jsonl (Rückfall +6 h gehalten): neu ' + mae('neu').toFixed(1) + ' / alt ' + mae('alt').toFixed(1) + ' kWh th – kein Vergleich'); }
    check('Echtdaten: Befehle je Tag ≤ 6', A.modi.voll.tage.every(d => d.shiftCmds + d.quietCmds <= 6), A.modi.voll.tage.map(d => d.shiftCmds + d.quietCmds));
}
console.log('\n' + ok + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);

// Tests für den Anlagen-Zwilling (tools/wp_zwilling.js), das Training (tools/wp_training.js) und die Kopplung an die Maschine (tools/engine_vs_zwilling.js).
// Fake-Uhr, deterministisch. Usage: node tools/wp_zwilling_test.js [Datenordner für den Training-Test, z. B. replay_data_1310] [wp_params.json]
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const Z = require('./wp_zwilling.js');
let oks = 0, fails = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined && info !== '' ? '  -> ' + info : '')); if (cond) { oks++; } else { fails++; } }
const MIN = 60000, T0 = new Date(2026, 11, 10, 0, 0).getTime();
const datenDir = process.argv[2] || null;
const paramDatei = process.argv[3] || path.join(__dirname, 'fixtures', 'wp_params.json');
const P = fs.existsSync(paramDatei) ? Z.mitWerten(JSON.parse(fs.readFileSync(paramDatei, 'utf8')).werte) : Z.standard();
console.log('Parameter: ' + (fs.existsSync(paramDatei) ? paramDatei : 'Standard (PARAM)'));
const E = (i, o) => Object.assign({t: T0 + i * MIN, at: 5, rh: 80, pv: 0, q: 3, hc: 1, shift: 0}, o || {});
function lauf(S, n, f) { const A = []; for (let i = 0; i < n; i++) { const r = Z.schritt(S, f(i), P); S = r.S; A.push(r.A); } return {S: S, A: A}; }

console.log('--- Grundsätze');
check('Zwilling ist rein: kein Date.now, kein Math.random, kein require/fs im Code', (() => { const src = fs.readFileSync(path.join(__dirname, 'wp_zwilling.js'), 'utf8').replace(/\/\/.*$/gm, ''); return !/Date\.now|Math\.random|require\(|\bfs\./.test(src); })());
check('jeder Parameter hat Wert, Einheit, Herkunft (M/F/H/A/N/S) und Quelle', Object.keys(Z.PARAM).every(k => Z.PARAM[k].length === 4 && /^[MFHANS](\/[MFHANS])*$/.test(Z.PARAM[k][2]) && Z.PARAM[k][3].length > 10), Object.keys(Z.PARAM).length + ' Parameter');
{
    const f = i => E(i, {at: 3 + 4 * Math.sin(i / 300), rh: 85, pv: Math.max(0, Math.sin(i / 230))});
    const a = lauf(Z.neu(P, {modus: 'pause', th: 21, tw: 27}), 2 * 1440, f), b = lauf(Z.neu(P, {modus: 'pause', th: 21, tw: 27}), 2 * 1440, f);
    check('deterministisch: zwei Läufe über 2 Tage bit-identisch (Ausgabe und Zustand)', JSON.stringify(a.A) === JSON.stringify(b.A) && JSON.stringify(a.S) === JSON.stringify(b.S), a.S.n.starts + ' Starts');
    const S0 = Z.neu(P, {modus: 'pause', th: 21, tw: 27}), kopie = JSON.stringify(S0); Z.schritt(S0, E(0), P);
    check('schritt verändert den Eingangszustand nicht (reine Funktion)', JSON.stringify(S0) === kopie);
    check('Ausgabe trägt die HeishaMon-Feldnamen, die die Maschine liest', ['Main_Outlet_Temp', 'Main_Inlet_Temp', 'Z1_Water_Target_Temp', 'Compressor_Freq', 'Heat_Energy_Consumption', 'Heat_Power_Production_Extra', 'Pump_Flow', 'Pump_Speed', 'Quiet_Mode_Level', 'Heating_Control', 'Outside_Temp', 'Defrosting_State', 'Z1_Heat_Request_Temp', 'Internal_Heater_State', 'Heater_On_Outdoor_Temp', 'Heater_Start_Delta', 'Heater_Delay_Time', 'Heating_Off_Outdoor_Temp', 'Outside_Pipe_Temp', 'Error'].every(k => k in a.A[0].hp), Object.keys(a.A[0].hp).length + ' Felder');
    check('Fühlerwerte im HeishaMon-Raster: Vor-/Rücklauf 0,25 K, AT und Frequenz ganzzahlig', a.A.every(x => x.hp.Main_Outlet_Temp * 4 === Math.round(x.hp.Main_Outlet_Temp * 4) && Number.isInteger(x.hp.Outside_Temp) && Number.isInteger(x.hp.Compressor_Freq)));
}
console.log('--- Soll, Start und Stopp');
{
    check('Soll = ceil(Heizkurve(AT)) + Verschiebung: 11 °C → 29, 9 °C → 30 (29,67), −13 °C → 37, +1 K Verschiebung', Math.ceil(Z.kurveSoll(P, 11) - 1e-9) === 29 && Math.ceil(Z.kurveSoll(P, 9) - 1e-9) === 30 && Z.kurveSoll(P, -13) === 37 &&
          lauf(Z.neu(P, {modus: 'pause'}), 1, i => E(i, {at: 9, shift: 1})).A[0].soll === 31);
    // Stopp: Vorlauf dauernd über Soll + stopK → Stopp nach stopHaltMin Minuten
    const st = lauf(Z.neu(P, {modus: 'lauf', rt: 60, th: 21, tw: 36, vl: 36}), 20, i => E(i, {at: 11, th: 21}));
    const iStop = st.A.findIndex(x => x.stopp);
    check('Stopp, sobald der Vorlauf ' + P.stopHaltMin + ' Minuten am Stück ≥ Soll + ' + P.stopK + ' K war (die Vorminute zählt mit; gemessen: Soll + 3,0…3,25 K, 3 min)', iStop === P.stopHaltMin - 1, 'Stopp in Minute ' + iStop + ', Vorlauf ' + st.A[0].hp.Main_Outlet_Temp + ' bei Soll ' + st.A[0].soll);
    const st2 = lauf(Z.neu(P, {modus: 'lauf', rt: 60, th: 21, tw: 28.5, vl: 29.5}), 30, i => E(i, {at: 11, th: 21}));
    check('kein Stopp, solange der Vorlauf unter Soll + stopK bleibt', !st2.A.some(x => x.stopp) && st2.A.every(x => x.hp.Main_Outlet_Temp < 29 + P.stopK), 'Vorlauf zuletzt ' + st2.A[29].hp.Main_Outlet_Temp);
    // Start: Vorlauf dauernd ≤ Soll − startK → Start nach startVerzugMin Minuten (Pause ≥ minPauseMin)
    const sa = lauf(Z.neu(P, {modus: 'pause', pauseMin: 30, th: 21, tw: 24, vl: 24}), 60, i => E(i, {at: 11, th: 21}));
    const iStart = sa.A.findIndex(x => x.start);
    check('Start, sobald die Schwelle Soll − ' + P.startK + ' K seit ' + P.startVerzugMin + ' Minuten erreicht ist (Vorminute zählt mit; Verzug gefittet, Startschwellen-Analyse: Median 9 min ab Soll − 3,25 K)', iStart === P.startVerzugMin - 1, 'Start in Minute ' + iStart);
    const sa2 = lauf(Z.neu(P, {modus: 'pause', pauseMin: 30, th: 27.5, tw: 28, vl: 28}), 60, i => E(i, {at: 11, th: 27.5}));
    check('kein Start, solange der Vorlauf über der Startschwelle liegt', !sa2.A.some(x => x.start) && sa2.A.every(x => x.hp.Main_Outlet_Temp > 29 - P.startK), 'Vorlauf ' + sa2.A[59].hp.Main_Outlet_Temp + ', Schwelle ' + (29 - P.startK));
    const PM = Z.mitWerten(Object.assign({}, P, {startVerzugMin: 1}));
    let S3 = Z.neu(PM, {modus: 'pause', pauseMin: 0, th: 21, tw: 20, vl: 20}), i3 = -1;
    for (let i = 0; i < 10 && i3 < 0; i++) { const r = Z.schritt(S3, E(i, {at: 11, th: 21}), PM); S3 = r.S; if (r.A.start) { i3 = i; } }
    check('Mindestpause ' + P.minPauseMin + ' min nach dem Stopp (Handbuch J 16.1.1), auch bei Verzug 1 min', i3 === P.minPauseMin, 'Start in Minute ' + i3);
    const sp = lauf(Z.neu(P, {modus: 'pause', pauseMin: 30, th: 21, tw: 24, vl: 24}), 40, i => E(i, {at: 11, th: 21, q: 3}));
    const i0 = sp.A.findIndex(x => x.start);
    check('Startspitze unabhängig von Quiet (Minute 0/1: ' + P.spike.join('/') + ' Hz), danach Quiet 3 am Deckel ≤ ' + P.capQ3 + ' Hz', i0 >= 0 && sp.A[i0].hz === P.spike[0] && sp.A[i0 + 1].hz === P.spike[1] && sp.A.slice(i0 + 2).every(x => x.hz <= P.capQ3), sp.A.slice(i0, i0 + 5).map(x => x.hz).join(' '));
}
console.log('--- Heizgrenze');
{
    const at = i => i < 60 ? 11 : (i < 300 ? 15 : (i < 500 ? 13 : 12));
    const h = lauf(Z.neu(P, {modus: 'lauf', rt: 30, th: 21, tw: 27, vl: 28}), 700, i => E(i, {at: at(i), th: 21}));
    const aus = h.A.findIndex(x => x.modus === 'heizgrenze'), an = h.A.findIndex((x, i) => i > 300 && x.modus !== 'heizgrenze');
    check('Heizgrenze 12: aus ab 15 °C (Verdichter und Pumpe aus), bleibt aus bei 13 °C, an bei 12 °C (Messung 5/5)', aus === 60 && h.A[aus].hp.Pump_Flow === 0 && h.A[aus].hz === 0 && h.A.slice(60, 500).every(x => x.modus === 'heizgrenze') && an === 500, 'aus ' + aus + ', an ' + an);
    const st = h.A.findIndex((x, i) => i >= 500 && x.start);
    check('nach dem Heizgrenze-Aus: Spülen mit hohem Durchfluss, Start nach ' + P.hgStartMin + ' min (Messung 3–4 min)', st >= 500 + P.hgStartMin - 1 && st <= 500 + P.hgStartMin + 1 && h.A[500].hp.Pump_Flow === P.flowHgNeustart, 'Start in Minute ' + st + ', Durchfluss ' + h.A[500].hp.Pump_Flow);
}
console.log('--- Frost: Mindestfrequenz, Deckel, Kennlinien');
{
    const hzBei = (at, q, hc) => { const r = lauf(Z.neu(P, {modus: 'lauf', rt: 100, th: 20, tw: 30, vl: 30}), 30, i => E(i, {at: at, q: q, hc: hc, th: 20})); return r.A.slice(5).filter(x => x.modus === 'lauf').map(x => x.hz); };
    const h5 = hzBei(5, 3, 1), hm5 = hzBei(-5, 3, 1), hm11 = hzBei(-11, 3, 1), hm3 = hzBei(-3, 3, 1);
    check('Quiet 3 bei +5 °C hält ≤ 17 Hz; bei −3 °C Mindestfrequenz 16–17 Hz; ab −4 °C ≥ 25 Hz, ab −10 °C ≥ 35 Hz (Forum 4596796/4593782, Flüstermodus ändert das nicht 4593801)',
          Math.max.apply(null, h5) <= 17 && Math.min.apply(null, hm3) >= 16 && Math.max.apply(null, hm3) <= 17 && Math.min.apply(null, hm5) >= 25 && Math.min.apply(null, hm11) >= 35, [h5[0], hm3[0], hm5[0], hm11[0]].join(' / ') + ' Hz');
    check('Höchstfrequenz je AT: 35 Hz bei +5 °C, 52 Hz bei −3 °C, 59 Hz ab −4 °C (Forum, V/E)', Z.hzMaxAt(P, 5) === 35 && Z.hzMaxAt(P, -3) === 52 && Z.hzMaxAt(P, -6) === 59);
    const cop = (at, hz, rl) => Z.pthOf(P, hz, at, 0) / (Z.pelOf(P, hz, at, rl) + P.pelKorrW);
    check('Kennlinien plausibel gegen Forum/Datenblatt: COP 1 °C/16,5 Hz ≈ 4,3 (Messband < 4 °C 4,30), −3 °C ≈ 3,7 (L5 4013336), −7 °C/59 Hz ≈ 3,0 (Datenblatt) je ±0,4',
          Math.abs(cop(1, 16.5, 31) - 4.3) < 0.4 && Math.abs(cop(-3, 16.5, 31) - 3.7) < 0.4 && Math.abs(cop(-7, 59, 33) - 3.0) < 0.4, [cop(1, 16.5, 31), cop(-3, 16.5, 31), cop(-7, 59, 33)].map(x => x.toFixed(2)).join(' / '));
    check('Wärme steigt mit der Frequenz, Frost-Faktor fällt unter ' + P.pthFrostAb + ' °C bis ' + P.pthFrostMin, Z.pthOf(P, 30, 5, 0) > Z.pthOf(P, 20, 5, 0) && Z.frostFaktor(P, 5) === 1 && Z.frostFaktor(P, -20) === P.pthFrostMin);
}
console.log('--- Energieerhaltung');
{
    let S = Z.neu(P, {modus: 'pause', th: 21, tw: 27, vl: 26}), sumPth = 0, sumQh = 0;
    const tw0 = S.tw, tr0 = S.tr;
    for (let i = 0; i < 1440; i++) { const r = Z.schritt(S, E(i, {at: 4, th: 21}), P); S = r.S; sumPth += r.A.pth / 1000 / 60; sumQh += r.A.qh / 60; }
    const speicher = P.cw * (S.tw - tw0) + P.cr * (S.tr - tr0), rest = sumPth - sumQh - speicher;
    check('24 h mit Takten: Wärme der WP = Wärme ins Haus + Speicheränderung Wasser/Heizkörperluft (Rest < 0,001 kWh)', Math.abs(rest) < 1e-3, 'WP ' + sumPth.toFixed(2) + ' kWh, Haus ' + sumQh.toFixed(2) + ', Speicher ' + speicher.toFixed(3) + ', Rest ' + rest.toExponential(1) + ', Starts ' + S.n.starts);
    let H = Z.neu(P, {modus: 'pause', th: 21, tw: 21, vl: 21}), hs = 0;
    for (let i = 0; i < 3 * 1440; i++) { const r = Z.schritt(H, E(i, {at: 18, pv: 0}), P); H = r.S; hs += r.A.pth; }
    check('ohne Heizen (Heizgrenze-Aus, 18 °C außen) nähert sich das Haus dem Bilanzpunkt AT + Gewinne/UA und die WP liefert nichts', hs === 0 && Math.abs(H.th - (18 + P.gain / P.ua)) < 1.0, 'Haus ' + H.th.toFixed(2) + ' °C, Bilanz ' + (18 + P.gain / P.ua).toFixed(2));
}
console.log('--- Abtauen und Heizstab (Modell aus Forum/Handbuch, keine Messung)');
{
    const f = (at, rh) => i => E(i, {at: at, rh: rh, q: 0, hc: 1});
    const w = lauf(Z.neu(P, {modus: 'pause', th: 21, tw: 28}), 1440, f(10, 95));
    check('bei +10 °C keine Abtauung', w.S.n.abtau === 0);
    const k = lauf(Z.neu(P, {modus: 'pause', th: 21, tw: 28}), 1440, f(0, 92));
    const ia = k.A.findIndex(x => x.modus === 'abtauen'), dauer = k.A.slice(ia).findIndex(x => x.modus !== 'abtauen');
    check('bei 0 °C und 92 % Feuchte Abtauungen; je Abtauung ' + P.abtauDauerMin + ' min, ' + P.abtauHz + ' Hz, Lüfter 0, Wärmeentzug (Pth < 0), Defrosting_State = 1', k.S.n.abtau >= 3 && dauer === P.abtauDauerMin && k.A[ia].hz === P.abtauHz && k.A[ia].hp.Fan1_Motor_Speed === 0 && k.A[ia].pth < 0 && k.A[ia].hp.Defrosting_State === 1, k.S.n.abtau + ' Abtauungen in 24 h, erste nach ' + ia + ' min');
    const nach = k.A.slice(ia + dauer, ia + dauer + P.nachAbtauEffMin - 1).map(x => x.hz);
    check('Efficiency hält nach dem Abtauen ' + P.nachAbtauEffMin + ' min die Mindestfrequenz (Forum 4582615)', nach.every(h => h <= Z.hzMinAt(P, 0) + 0.01), nach.slice(0, 6).join(' '));
    const iAb = k.A.findIndex((x, i) => i > 0 && x.modus === 'abtauen' && k.A[i - 1].modus !== 'abtauen');
    check('Abtauung erst nach ' + P.abtauMinHeizMin + ' Heizminuten (Handbuch J)', iAb > P.abtauMinHeizMin, 'erste Abtauung in Minute ' + iAb);
    const kalt = (frei, at) => lauf(Z.neu(Z.mitWerten(Object.assign({}, P, {hsFrei: frei})), {modus: 'pause', th: 19, tw: 24}), 600, i => E(i, {at: at, rh: 70, q: 3, hc: 1}));
    const P1 = Z.mitWerten(Object.assign({}, P, {hsFrei: 1})), P0 = Z.mitWerten(Object.assign({}, P, {hsFrei: 0}));
    const hsLauf = (PP, at) => { let S = Z.neu(PP, {modus: 'pause', th: 19, tw: 24}); const A = []; for (let i = 0; i < 600; i++) { const r = Z.schritt(S, E(i, {at: at, rh: 70, q: 3, hc: 1}), PP); S = r.S; A.push(r.A); } return A; };
    const a1 = hsLauf(P1, -8), a0 = hsLauf(P0, -8), a2 = hsLauf(P1, 2);
    const ersterHs = a1.findIndex(x => x.hs === 1);
    check('Heizstab bei −8 °C und Quiet 3 (Leistung reicht nicht): frühestens nach ' + P.hsDelayMin + ' Laufminuten und bei Vorlauf < Soll ' + P.hsStartK + ' K; nie bei +2 °C (Freigabe unter ' + P.hsOnAT + ' °C), nie ohne Freigabe',
          ersterHs >= 0 && a1[ersterHs].rt >= P.hsDelayMin && a1[ersterHs - 1].vl < a1[ersterHs].soll + P.hsStartK + 0.5 && !a2.some(x => x.hs) && !a0.some(x => x.hs) && kalt(1, -8).S.n.hsMin > 0, 'erster Heizstab in Minute ' + ersterHs + ' (Laufminute ' + (ersterHs >= 0 ? a1[ersterHs].rt : '–') + '), Heizstab-Minuten ' + a1.filter(x => x.hs).length);
}
console.log('--- Kopplung an die Maschine (engine_core, nur gelesen)');
{
    const EN = require('./engine_core.js'), V = require('./engine_vs_zwilling.js');
    let S = Z.neu(P, {modus: 'pause', th: 21.3, tw: 28}), SE = null, err = null; const recs = [];
    try { for (let i = 0; i < 600; i++) { const r = Z.schritt(S, E(i, {at: 6}), P); S = r.S; const inp = Z.zuEngine(r.A, V.RAEUME, P); const o = EN.step(SE, inp, EN.defaults()); SE = o.S; recs.push(o.rec); } } catch (e) { err = e; }
    check('Zwilling als Datenquelle der Maschine: 600 Minuten ohne Fehler, Eingabe mit allen Feldern der Hülle opt_engine, Maschine erkennt Lauf/Pause', err === null && recs.length === 600 && recs.some(r => r.abl.z === 'lauf') && recs.some(r => r.abl.z !== 'lauf'), err ? err.message : recs.filter(r => r.abl.z === 'lauf').length + ' Laufminuten');
    const L = V.lauf(P, 'mild', 'sofort');
    const proTag = {}; L.befehle.filter(b => /^Klick/.test(b[3])).forEach(b => { proTag[b[0].slice(0, 5)] = (proTag[b[0].slice(0, 5)] || 0) + 1; });
    check('geschlossen „sofort“ (5 Tage mild): kein Fehler, höchstens 6 Übernahmen je Tag, nie mehr als 1 K Verschiebung', L.fehler === 0 && Object.keys(proTag).every(d => proTag[d] <= 6) && L.befehle.every(b => b[1] !== 'SetZ1HeatRequestTemperature' || Math.abs(b[2]) <= 1), JSON.stringify(proTag));
}
if (datenDir) {
    console.log('--- Training auf echten Daten (' + datenDir + ')');
    const T = require('./wp_training.js');
    const t0 = process.hrtime.bigint();
    const R1 = T.trainiere(datenDir, {train: '2026-10-07..2026-10-11', test: '2026-10-12..2026-10-15'});
    const sek = Number(process.hrtime.bigint() - t0) / 1e9;
    const R2 = T.trainiere(datenDir, {train: '2026-10-07..2026-10-11', test: '2026-10-12..2026-10-15'});
    check('Training läuft unter 2 min und ist bit-identisch wiederholbar', sek < 120 && JSON.stringify(R1) === JSON.stringify(R2), sek.toFixed(1) + ' s');
    const g = R1.guete.test, tr = R1.guete.training;
    console.log('     Zahlen (Test ' + R1.trennung.test.join('…') + '): Pth RMSE ' + g.teil.pthRmseW + ' W, TOP16 RMSE ' + g.teil.pelRmseW + ' W, Regler ' + g.teil.reglerRmseHz + ' Hz, Wasserkreis ' + g.teil.wasserkreisRmseK + ' K, Haus ' + g.teil.hausRmseK + ' K, Pause ' + JSON.stringify(g.zyklenHausSimuliert.pause) + ', Lauf ' + JSON.stringify(g.zyklenHausSimuliert.lauf) + ', Freilauf ' + JSON.stringify(g.freilaufSumme));
    check('Güte Test: TOP16 RMSE < 35 W, Regler < 2,5 Hz, Wasserkreis < 1,3 K, Hausmittel < 1,2 K', g.teil.pelRmseW < 35 && g.teil.reglerRmseHz < 2.5 && g.teil.wasserkreisRmseK < 1.3 && g.teil.hausRmseK < 1.2);
    const fs0 = g.freilaufSumme, fsT = tr.freilaufSumme;
    check('Freilauf (alles geschlossen) trifft die Tagesenergie: kWh Strom und Wärme je ±15 % (Training und Test)', fs0 && Math.abs(fs0.kwhElZwilling / fs0.kwhElMessung - 1) < 0.15 && Math.abs(fs0.kwhThZwilling / fs0.kwhThMessung - 1) < 0.15 && Math.abs(fsT.kwhElZwilling / fsT.kwhElMessung - 1) < 0.15,
          fs0 ? (fs0.kwhElZwilling + '/' + fs0.kwhElMessung + ' kWh el, ' + fs0.kwhThZwilling + '/' + fs0.kwhThMessung + ' kWh th') : '–');
    check('Zyklen: Median-Fehler Pause ≤ 35 min und Lauf ≤ 60 min (Training und Test, alles geschlossen; im Test 12.–13.10. nur 4 Pausen, eine davon der Dornröschenschlaf 12.10. 19:21)', g.zyklenHausSimuliert.pause.medianAbsMin <= 35 && g.zyklenHausSimuliert.lauf.medianAbsMin <= 60 && tr.zyklenHausSimuliert.pause.medianAbsMin <= 35 && tr.zyklenHausSimuliert.lauf.medianAbsMin <= 60,
          'Test Pause ' + g.zyklenHausSimuliert.pause.medianAbsMin + ' / Lauf ' + g.zyklenHausSimuliert.lauf.medianAbsMin + ' min, Training ' + tr.zyklenHausSimuliert.pause.medianAbsMin + ' / ' + tr.zyklenHausSimuliert.lauf.medianAbsMin + ' min');
    check('Parameter mit Herkunft: gefittete tragen „gefittet“, Winterteile bleiben F/H/A', R1.herkunft.cw.fit === 'gefittet' && R1.herkunft.pthHz.fit === 'gefittet' && !R1.herkunft.abtauDauerMin.fit && /F/.test(R1.herkunft.hzMinFrost.herkunft) && R1.herkunft.eisRate.fit === 'kalibriert (Annahme-Anker)');
}
console.log('\n' + oks + ' OK, ' + fails + ' FAIL');
process.exitCode = fails ? 1 : 0;

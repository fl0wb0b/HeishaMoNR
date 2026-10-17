#!/usr/bin/env node
// Tests "COP: Ziel und Ist" und Stromzähler (cop-ziel 17.10.2026): Minutenmodell und Zerlegung (engine_core), Kalibrierung (cop_eta.js), Shelly-Leser (zaehler_core,
// beide Profile, Ausfall, Vorzeichen, Heizstab), Hülle opt_zaehler aus der Flow-Datei (Abos, Speichern, Ereignisse), Karten (eng_ui), Replay auf echten Daten.
// Usage: node tools/cop_ziel_sim.js [flows.json] [Datenordner]
'use strict';
process.env.TZ = 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('./engine_core.js');
const Z = require('./zaehler_core.js');
const K = require('./cop_eta.js');
const V = require('./engine_view.js');
const U = require('./eng_ui.js');
const flowsFile = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null, dataDir = process.argv[3] || null;
let ok = 0, fail = 0;
function check(name, cond, info) { if (cond) { ok++; console.log('OK   ' + name + (info ? '  -> ' + info : '')); } else { fail++; console.log('FAIL ' + name + '  -> ' + (info || '')); } }
const MIN = 60000, T0 = new Date(2026, 9, 20, 0, 0, 0).getTime();
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);
const cfg0 = E.mergeCfg({});
// Minute erzeugen: Lauf mit Werten, die zum Modell passen (COP = eta * Carnot(VL) * F) -> Rest 0
function minute(t, o) { return Object.assign({t: t, hz: 16, vl: 33, rl: 30.9, soll: 33, at: 6, pel: 300, pth: null, defrost: 0, dhw: 0, heater: 0, rh: null, pv: null, zw: null, zAge: null, hpAge: 0}, o || {}); }
function modellPth(m, cfg) { const P = E.czParam(cfg), b = E.czBand(m.at), e = (m.pel + P.kw) / 60, c = P.eta[b] * E.carnot(m.vl, m.at + E.czSonne({pv: {}}, m.t, null), P.dT[b], E.CZ.kondK) * E.czFreq(P, m.hz) * (1 + E.CZ.sprJeK * ((m.vl - m.rl) - P.spr[b])); return c * e * 60; }

console.log('--- Minutenmodell und Zerlegung (engine_core.copZiel)');
{
    const c = E.carnot(35, 2, 4.5, 2.5);
    check('Carnot: VL 35, AT 2, dT 4,5, kondK 2,5 -> 310,65 / 40 = 7,766', near(c, 310.65 / 40, 1e-9), c.toFixed(4));
    const P = E.czParam(cfg0);
    check('Startwerte: eta 0,52/0,50/0,48/0,45 je Band, dT 4,5 K, Spreizung 2,1 K, Quelle heishamon, 80 W', ['< 4', '4…8', '8…11', '≥ 11'].map(b => P.eta[b]).join() === '0.52,0.5,0.48,0.45' && P.dT['< 4'] === 4.5 && P.spr['≥ 11'] === 2.1 && P.quelle === 'heishamon' && P.kw === 80, JSON.stringify(P.eta));
    check('Frequenzfaktor: 16–17 Hz 1, 19 Hz 0,993 (Messung), 23 Hz 1, 28 Hz ohne Daten 1 − 1 %/Hz über 25 = 0,97, 35 Hz 0,92', E.czFreq(P, 16) === 1 && E.czFreq(P, 17) === 1 && E.czFreq(P, 19) === 0.993 && E.czFreq(P, 23) === 1 && near(E.czFreq(P, 28), 0.97) && near(E.czFreq(P, 35), 0.92), [16, 19, 23, 28, 35].map(h => E.czFreq(P, h)).join('/'));
    check('Abtaufaktor: ab 4 °C 1; bis 2 °C 0,90 (ohne Feuchte oder ≥ 85 %); 3 °C 0,95; 1 °C bei 60 % 0,97', E.czAbtau(P, 6, 95) === 1 && E.czAbtau(P, 4, 95) === 1 && near(E.czAbtau(P, 2, null), 0.9) && near(E.czAbtau(P, 0, 90), 0.9) && near(E.czAbtau(P, 3, 90), 0.95) && near(E.czAbtau(P, 1, 60), 0.97), [E.czAbtau(P, 3, 90), E.czAbtau(P, 1, 60)].join('/'));
    const Zs = {pv: {'2026-10-19': 8000}}, mittag = new Date(2026, 9, 20, 12, 0).getTime(), abend = new Date(2026, 9, 20, 17, 0).getTime();
    check('Sonne (ANNAHME): 12 Uhr PV 2,4 kW von 8 kW (30 %) +1 K, 4,8 kW (60 %) +2 K, 3,6 kW +1,5 K; 17 Uhr 0; unter 30 % 0; Spitze < 1 kW 0', E.czSonne(Zs, mittag, 2400) === 1 && E.czSonne(Zs, mittag, 4800) === 2 && near(E.czSonne(Zs, mittag, 3600), 1.5) && E.czSonne(Zs, abend, 6000) === 0 && E.czSonne(Zs, mittag, 2000) === 0 && E.czSonne({pv: {a: 900}}, mittag, 800) === 0, '');
    // Modell-Minute: Rest 0, Posten 0 bei VL = Soll, Spreizung = Mittel, 16 Hz
    const S = {}, ms = [];
    for (let i = 0; i < 40; i++) { const m = minute(T0 + i * MIN, {hz: 0, pel: 30}); ms.push(E.copZielStep(S, m, cfg0)); }
    for (let i = 40; i < 120; i++) { const m = minute(T0 + i * MIN, {}); m.pth = modellPth(m, cfg0); ms.push(E.copZielStep(S, m, cfg0)); }
    const arten = {}; ms.forEach(m => { arten[m.art] = (arten[m.art] || 0) + 1; });
    check('Arten: 40 Stillstand, 10 Start (Pause ≥ 3 min davor), 70 normal', arten.stand === 40 && arten.start === 10 && arten.normal === 70, JSON.stringify(arten));
    const n = ms.filter(m => m.art === 'normal');
    check('Modell-Minute (VL = Soll, Spreizung = Band-Mittel, 16 Hz, 6 °C): Ist = Ziel, alle Posten 0', n.every(m => near(m.cist, m.cz, 1e-9) && Object.keys(m.p).every(k => near(m.p[k], 0, 1e-9))), JSON.stringify(n[0].p));
    // Zerlegung exakt: zufaellige Minuten
    let maxErr = 0, S2 = {}; let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 2000; i++) {
        const lauf = rnd() > 0.15, m = minute(T0 + i * MIN, {hz: lauf ? 16 + Math.round(rnd() * 20) : 0, vl: 28 + rnd() * 10, soll: 30 + rnd() * 5, at: -8 + rnd() * 20, pel: lauf ? 250 + rnd() * 400 : 30, pth: lauf ? 1500 + rnd() * 2500 : 0, rh: rnd() > 0.5 ? 50 + rnd() * 50 : null, defrost: rnd() > 0.98 ? 1 : 0});
        m.rl = m.vl - 1 - rnd() * 3; const r = E.copZielStep(S2, m, cfg0); const sum = Object.keys(r.p).reduce((a, k) => a + r.p[k], 0);
        if (r.art !== 'keine' && r.art !== 'ww' && r.art !== 'heizstab') { maxErr = Math.max(maxErr, Math.abs(sum - (r.e - r.ez))); }
    }
    check('Zerlegung exakt: Summe der Posten = Strom Ist − Strom Ziel (2000 Zufallsminuten, Fehler < 1e-9 Wh)', maxErr < 1e-9, maxErr.toExponential(2));
    const tage = E.copZielSumme(S2, T0 + 2000 * MIN).tage, A = tage[0][1], sumP = A.posten.reduce((a, x) => a + x.kwh, 0);
    check('Tageswert: Summe der Posten (kWh) = Strom Ist − Strom Ziel, COP-Punkte summieren sich zu Ziel − Ist', near(sumP, A.e - A.ez, 0.02) && near(A.posten.reduce((a, x) => a + x.cop, 0), A.cz - A.cist, 0.02), de(sumP) + ' / ' + de(A.e - A.ez) + ' · ' + de(A.posten.reduce((a, x) => a + x.cop, 0)) + ' / ' + de(A.cz - A.cist));
    // Vorlauf ueber/unter Soll, Frequenz, Spreizung: Vorzeichen
    const mk = o => { const Sx = {cz: Object.assign(E.czNew(), {on: true, t0: T0 - 60 * MIN, start: true})}; const m = minute(T0, o); m.pth = modellPth(m, cfg0); return E.copZiel(m, cfg0, Sx.cz); };   // Waerme passend zum Modell: Rest 0
    const vlU = mk({vl: 36, rl: 33.9, soll: 33}), vlD = mk({vl: 31, rl: 28.9, soll: 33}), fr = mk({hz: 30}), sp = mk({rl: 32}), st0 = mk({});
    check('Vorlauf 3 K über Soll -> Posten "Vorlauf über Soll" = Strom × (1 − Carnot(Ist)/Carnot(Soll)) = 7,2 % (≈ 2,4 %/K), 2 K unter Soll < 0, Rest 0', vlU.p.vl > 0 && vlD.p.vl < 0 && near(vlU.p.vl / vlU.e, 1 - E.carnot(36, 6, 4.5, 2.5) / E.carnot(33, 6, 4.5, 2.5), 1e-9) && near(vlU.p.rest, 0, 1e-9), de(vlU.p.vl / vlU.e * 100) + ' % / ' + de(vlD.p.vl / vlD.e * 100) + ' %');
    check('30 Hz statt 16 Hz -> Posten "Frequenz über Minimum" = 3 % des Stroms (26–30 Hz ohne Daten: 1 − 1 %/Hz über 25 Hz, Mitte 28 Hz), Spreizung 1 K (statt 2,1) -> "Rücklauf/Spreizung" 1,1 %', fr.p.freq > 0 && near(fr.p.freq / fr.e, 0.03, 1e-9) && sp.p.spr > 0 && near(sp.p.spr / sp.e, 0.011, 1e-9) && st0.p.freq === 0, de(fr.p.freq / fr.e * 100) + ' % / ' + de(sp.p.spr / sp.e * 100) + ' %');
    // Abtauen + Wiederaufheizen
    const S3 = {}, seq = [];
    for (let i = 0; i < 60; i++) { const m = minute(T0 + i * MIN, {at: 1, rh: 95, vl: i < 50 ? 34 : (i < 56 ? 22 : 30)}); m.pth = 2400; if (i >= 50 && i < 56) { m.defrost = 1; } seq.push(E.copZielStep(S3, m, cfg0)); }
    for (let i = 60; i < 100; i++) { const m = minute(T0 + i * MIN, {at: 1, rh: 95, vl: Math.min(34, 30 + (i - 60) * 0.25)}); m.pth = 2400; seq.push(E.copZielStep(S3, m, cfg0)); }
    const ab = seq.filter(m => m.art === 'abtau').length, wd = seq.filter(m => m.art === 'wieder').length, D3 = E.copZielSumme(S3, T0 + 100 * MIN).heute;
    check('Abtauen: 6 Minuten Abtauen, Wiederaufheizen bis Vorlauf 0,5 K unter dem Wert davor (34 → 33,5: 18 min), Nutzwärme 0 in diesen Minuten, 1 Abtauung im Tag', ab === 6 && wd === 18 && seq.filter(m => m.art === 'abtau' || m.art === 'wieder').every(m => m.q === 0 && m.ez === 0 && m.p.abtau === m.e) && D3.abtauungen === 1, ab + ' / ' + wd + ' · ' + D3.abtauungen);
    check('Abtauen im Tageswert: Posten = Abtauen Ist − im Ziel erwartet (1 °C, 95 %: Ziel enthält −10 %)', near(A3(D3).kwh, D3.abIst - D3.abErw, 0.011) && D3.abErw > 0, de(D3.abIst) + ' − ' + de(D3.abErw) + ' = ' + de(A3(D3).kwh));
    function A3(D) { return D.posten.filter(x => x.id === 'abtau')[0]; }
    // Startspitzen
    const S4 = {}; let st = [];
    for (let i = 0; i < 5; i++) { st.push(E.copZielStep(S4, minute(T0 + i * MIN, {hz: 0, pel: 30}), cfg0)); }
    for (let i = 5; i < 30; i++) { const m = minute(T0 + i * MIN, {hz: i < 15 ? 33 : 16, pel: i < 15 ? 600 : 300}); m.pth = 1800; st.push(E.copZielStep(S4, m, cfg0)); }
    const s10 = st.filter(m => m.art === 'start');
    check('Startspitzen: die ersten 10 Laufminuten ganz Posten "Startspitzen" (Strom − Wärme ÷ Ziel-COP)', s10.length === 10 && s10.every(m => near(m.p.start, m.e - m.ez, 1e-9) && Object.keys(m.p).length === 1), s10.length + ' min, ' + de(s10.reduce((a, m) => a + m.p.start, 0) / 1000) + ' kWh');
    const S5 = {}; [0, 1, 2].forEach(i => E.copZielStep(S5, minute(T0 + i * MIN, {pth: 2000}), cfg0)); E.copZielStep(S5, minute(T0 + 3 * MIN, {hz: 0, pel: 30}), cfg0); const r5 = E.copZielStep(S5, minute(T0 + 5 * MIN, {pth: 2000}), cfg0);
    check('Pause unter 3 min = derselbe Lauf (kein neuer Start), erster Lauf nach Datenbeginn ist kein Start', r5.art === 'normal' && E.copZielSumme(S5, T0 + 6 * MIN).heute.starts === 0, r5.art);
    // Warmwasser, Heizstab, alte Daten
    const S6 = {}, w = E.copZielStep(S6, minute(T0, {dhw: 1, pth: 3000}), cfg0), h = E.copZielStep(S6, minute(T0 + MIN, {heater: 1, pth: 3000}), cfg0), x = E.copZielStep(S6, minute(T0 + 2 * MIN, {hpAge: 9}), cfg0);
    check('Warmwasser und Heizstab: nicht im Heiz-COP (nur Info-kWh), HeishaMon älter als 5 min: keine Buchung', w.art === 'ww' && h.art === 'heizstab' && x.art === 'keine' && E.copZielSumme(S6, T0 + 3 * MIN).heute.e === 0 && E.copZielSumme(S6, T0 + 3 * MIN).heute.eWW > 0, [w.art, h.art, x.art].join('/'));
}

console.log('\n--- Stromquelle Zähler im Kern (Umschaltung, Ausfall, COP-Matrix)');
{
    const cZ = E.mergeCfg({zaehler: {quelle: 'zaehler'}}), Sx = {cz: Object.assign(E.czNew(), {on: true, t0: T0 - 60 * MIN, start: true})};
    const m = minute(T0, {pth: 2500, zw: 420, zAge: 1}), a = E.copZiel(m, cfg0, Sx.cz), b = E.copZiel(m, cZ, Sx.cz), c = E.copZiel(Object.assign({}, m, {zAge: 6}), cZ, Sx.cz);
    check('Standard heishamon: Strom = TOP16 + 80 W (380 W), Zähler nur Vergleich (eZ 420 W)', a.quelle === 'heishamon' && near(a.e * 60, 380) && near(a.eZ * 60, 420) && !a.rueckfall, a.e * 60 + ' W');
    check('quelle zaehler, Zähler 1 min alt: Strom = Zähler (420 W)', b.quelle === 'zaehler' && near(b.e * 60, 420) && !b.rueckfall, b.e * 60 + ' W');
    check('Ausfall: Zähler 6 min alt -> Rückfall auf TOP16 + 80 W mit Merker', c.quelle === 'heishamon' && near(c.e * 60, 380) && c.rueckfall === true, c.e * 60 + ' W');
    let T = E.taktNew(); T.on = true; T.t0 = T0 - 60 * MIN;
    for (let i = 0; i < 20; i++) { T = E.taktStep(T, {t: T0 + i * MIN, hz: 16, hpAge: 0.5, at: 6, pel: 300, pth: 2400, q: 0, hc: 1, defrost: 0, dhw: 0, vl: 33, rl: 31, soll: 33, dT: 3, zw: i < 10 ? 420 : null, zAge: i < 10 ? 1 : null}, cfg0.takt); }
    const sH = E.copSumme(T, cfg0.takt, T0 + 20 * MIN, 80), sZ = E.copSumme(T, cfg0.takt, T0 + 20 * MIN, 80, true), k = Object.keys(sH)[0];
    check('COP-Matrix (Takt-Messung): Standard TOP16 + 80 W = 20 × 380/60 Wh; mit Zähler 10 min 420 W + 10 min TOP16 + 80 W', near(sH[k][0], 20 * 380 / 60, 1e-6) && near(sZ[k][0], 10 * 420 / 60 + 10 * 380 / 60, 1e-6) && sZ[k][1] === sH[k][1] && near(sZ[k][6], 20 * 300 / 60, 1e-6), de(sH[k][0]) + ' / ' + de(sZ[k][0]) + ' Wh');
    check('mergeCfg: quelle nur "zaehler" oder Standard heishamon; copZiel durchgereicht', E.mergeCfg({zaehler: {quelle: 'x'}}).zaehler.quelle === 'heishamon' && E.mergeCfg({}).zaehler.quelle === 'heishamon' && E.mergeCfg({copZiel: {eta: {}}}).copZiel.eta !== undefined, '');
    const P1 = E.czParam(E.mergeCfg({copZiel: {erstellt: '2026-10-18 06:41', eta: {'< 4': {v: 0.5}, '4…8': {v: 9}}, dTverd: {'< 4': {v: 3}, '4…8': {v: 3}}, freq: {'26-30': {v: 0.95}, '31-35': {v: 1.4}}, abtau: {aMax: 0.07}}}));
    check('cop_eta.json: gültige Werte übernommen (eta < 4 0,50 mit dT 3 K, 26–30 Hz 0,95, aMax 7 %), ungültige verworfen (eta 9, Frequenzfaktor 1,4) -> Startwert/Annahme', P1.eta['< 4'] === 0.5 && P1.dT['< 4'] === 3 && P1.eta['4…8'] === 0.5 && P1.dT['4…8'] === 4.5 && P1.freq['26-30'] === 0.95 && near(E.czFreq(P1, 33), 0.92) && P1.aMax === 0.07 && P1.stand === '2026-10-18 06:41', JSON.stringify(P1.eta));
}

console.log('\n--- Kalibrierung (cop_eta.js)');
{
    const cfgW = E.mergeCfg({copZiel: {eta: {'< 4': 0.47, '4…8': 0.47, '8…11': 0.47, '≥ 11': 0.47}, dTverd: {'< 4': 3.5, '4…8': 3.5, '8…11': 3.5, '≥ 11': 3.5}}}), M = [];
    for (let d = 0; d < 3; d++) {
        for (let i = 0; i < 600; i++) {
            const t = T0 + (d * 1440 + i) * MIN, lauf = i % 200 >= 20, hz = i % 200 >= 150 ? 22 : 16, at = 3 + d * 4;
            const m = {t: t, hz: lauf ? hz : 0, vl: 33, rl: 30.9, soll: 33, at: at, pel: lauf ? 300 : 30, pth: null, defrost: 0, dhw: 0, heater: 0, pipe: at - 3.5, zw: null, zh: null, q: 0, hc: 1, pvW: null, rhP: 70, hpAge: 0};
            if (lauf) { m.pth = 0.47 * E.carnot(33, at, 3.5, 2.5) * (hz > 17 ? 0.96 : 1) * 380; }
            M.push(m);
        }
    }
    const o = K.kalibriere(M, cfg0);
    check('eta aus synthetischen Minuten (wahr 0,47, dT 3,5 K, AT 3/7/11 °C): 0,470 je Band, dT_verd 3,5 K aus Rohr außen, Band 8–11 ohne Daten, Frequenzfaktor 21–25 Hz 0,96 gemessen', ['< 4', '4…8', '≥ 11'].every(b => near(o.eta[b].v, 0.47, 0.001) && near(o.dTverd[b].v, 3.5, 1e-9)) && o.eta['8…11'].v === null && near(o.freq['21-25'].v, 0.96, 0.002) && o.freq['26-30'].v === null,
          JSON.stringify(o.eta) + ' · ' + JSON.stringify(o.freq['21-25']));
    check('ohne Abtauungen: aMax bleibt Standard (Quelle genannt)', o.abtau.n === 0 && o.abtau.aMax === null && /Standard/.test(o.abtau.quelle), o.abtau.quelle);
    const cfgK = E.mergeCfg({copZiel: o}), S = {}; M.forEach(m => E.copZielStep(S, K.eingabe(m), cfgK)); const G = E.czAgg(Object.keys(S.cz.d).map(k => S.cz.d[k]), true);
    check('mit kalibrierten Werten: Rest ≈ 0 (< 0,5 % des Stroms), Frequenz-Posten > 0', Math.abs(G.rest) < 0.5 && G.posten.find(x => x.id === 'freq').kwh > 0, 'Rest ' + G.rest + ' %');
    void cfgW;
}

console.log('\n--- Shelly 3EM-63 Gen3 (zaehler_core): Profile, Ausfall, Vorzeichen, Heizstab');
{
    const cT = {topic: 'shelly3em63g3-a1b2c3/status/em:0', klemme_wp: 1, klemme_heizstab: null}, now = T0;
    check('MQTT-Name: Präfix aus vollem Topic, Gerätename oder events/rpc', Z.praefix('shelly3em63g3-a1b2c3/status/em:0') === 'shelly3em63g3-a1b2c3' && Z.praefix('shelly3em63g3-a1b2c3') === 'shelly3em63g3-a1b2c3' && Z.praefix('x/y/events/rpc') === 'x/y', '');
    check('Abos: Drehstrom em:0/emdata:0, drei Kanäle em1:0–2/em1data:0–2, immer events/rpc; ohne Namen keine', Z.abos(cT).length === 9 && Z.abos(Object.assign({}, cT, {profil: 'triphase'})).join() === 'shelly3em63g3-a1b2c3/events/rpc,shelly3em63g3-a1b2c3/status/em:0,shelly3em63g3-a1b2c3/status/emdata:0' && Z.abos(Object.assign({}, cT, {profil: 'monophase'})).length === 7 && Z.abos({}).length === 0 && Z.abos({topic: '+/status/#'}).length === 0, Z.abos(cT).join(' '));
    let S = Z.neu();
    const em0 = {id: 0, a_current: 0.5, a_voltage: 231.2, a_act_power: 35.1, a_aprt_power: 60, b_current: 1.9, b_voltage: 230.4, b_act_power: 402.5, b_aprt_power: 430, c_current: 0.1, c_voltage: 232, c_act_power: 12.0, c_aprt_power: 20, total_act_power: 449.6};
    check('Drehstrom: status/em:0 (JSON-Text) -> Klemme 2 = Phase b 402,5 W', Z.lies(S, 'shelly3em63g3-a1b2c3/status/em:0', JSON.stringify(em0), now, cT) && S.profil === 'triphase' && S.k[1].w === 402.5 && S.k[0].w === 35.1, JSON.stringify(S.k[1]));
    Z.lies(S, 'shelly3em63g3-a1b2c3/status/emdata:0', {id: 0, a_total_act_energy: 1000, b_total_act_energy: 523456.7, b_total_act_ret_energy: 12, c_total_act_energy: 5, total_act: 524461.7}, now, cT);
    let st = Z.stand(S, now + 30000, cT, 0);
    check('Stand: wp_w 403 W, kWh 523,457, Alter 0,5 min, ok, Heizstab 0 (Annahme 3 kW, aus)', st.ok && st.wp_w === 403 && st.kwh_wp === 523.457 && st.alter === 0.5 && st.heizstab_w === 0 && /Annahme 3 kW/.test(st.heizstab_quelle), JSON.stringify({wp: st.wp_w, kwh: st.kwh_wp, alter: st.alter}));
    Z.lies(S, 'shelly3em63g3-a1b2c3/events/rpc', {src: 'shelly3em63g3-a1b2c3', method: 'NotifyStatus', params: {ts: 1, 'em:0': {id: 0, b_act_power: 388.0}}}, now + 60000, cT);
    check('NotifyStatus (nur geänderte Felder): b_act_power 388 übernommen, Spannung bleibt', S.k[1].w === 388 && S.k[1].v === 230.4, JSON.stringify(S.k[1]));
    check('fremdes Gerät / anderer Präfix wird ignoriert', !Z.lies(S, 'shellyplus1-xyz/status/switch:0', {output: true}, now, cT) && !Z.lies(S, 'shelly3em63g3-a1b2c3/status/sys', {x: 1}, now, cT), '');
    const cM = {topic: 'shelly3em63g3-d4e5f6', klemme_wp: 0, klemme_heizstab: 2, klemme_sonstiges: 1}, S2 = Z.neu();
    Z.lies(S2, 'shelly3em63g3-d4e5f6/status/em1:0', {id: 0, current: 1.7, voltage: 230, act_power: 395, aprt_power: 410, calibration: 'factory'}, now, cM);
    Z.lies(S2, 'shelly3em63g3-d4e5f6/events/rpc', {method: 'NotifyFullStatus', params: {ts: 2, 'em1:1': {id: 1, act_power: 120}, 'em1:2': {id: 2, act_power: 2980}, 'em1data:0': {id: 0, total_act_energy: 10500, total_act_ret_energy: 0}, 'em1data:2': {id: 2, total_act_energy: 3300}, sys: {}}}, now, cM);
    const st2 = Z.stand(S2, now, cM, 1);
    check('drei Kanäle (em1): WP 395 W, Heizstab eigene Klemme 2980 W (exakt, nicht abgezogen), Sonstiges 120 W, kWh 10,5 / 3,3', S2.profil === 'monophase' && st2.wp_w === 395 && st2.heizstab_w === 2980 && st2.sonst_w === 120 && st2.kwh_wp === 10.5 && st2.kwh_heizstab === 3.3 && /eigene Klemme 3/.test(st2.heizstab_quelle), JSON.stringify(st2.kanaele.map(k => k.w)));
    const cMt = Object.assign({}, cM, {profil: 'triphase'});
    check('Profil fest "Drehstrom": em1-Meldungen werden ignoriert', !Z.lies(Z.neu(), 'shelly3em63g3-d4e5f6/status/em1:0', {act_power: 1}, now, cMt), '');
    const S3 = Z.neu(), cI = {topic: 'sh', klemme_wp: 0, invertieren: [true, false, false]};
    Z.lies(S3, 'sh/status/em1:0', {act_power: -401}, now, cI); Z.lies(S3, 'sh/status/em1data:0', {total_act_energy: 2, total_act_ret_energy: 7700}, now, cI);
    const st3 = Z.stand(S3, now, cI, 0), st3b = Z.stand(S3, now, {topic: 'sh', klemme_wp: 0}, 0);
    check('Vorzeichen: invertierte Klemme −401 W -> 401 W, Zählerstand aus total_act_ret_energy (7,7 kWh); ohne Invertieren Hinweis „Vorzeichen prüfen“, Wert 0', st3.wp_w === 401 && st3.kwh_wp === 7.7 && !st3.vorzeichen && st3b.vorzeichen && st3b.wp_w === 0, st3.wp_w + ' / ' + st3b.wp_roh_w);
    const st4 = Z.stand(S, now + 6 * 60000, cT, 0);
    check('Ausfall: letzte Meldung 5 min alt -> ok, 6 min -> nicht ok (Rückfall auf HeishaMon)', Z.stand(S, now + 6 * 60000, cT, 0).alter === 5 && Z.stand(S, now + 6 * 60000, cT, 0).ok === true && Z.stand(S, now + 7 * 60000, cT, 0).ok === false && st4.ok, Z.stand(S, now + 7 * 60000, cT, 0).alter + ' min');
    // Heizstab ohne Klemme: Sprung 2,95 kW beim Einschalten, 2,9 kW beim Ausschalten
    const S5 = Z.neu(), c5 = {topic: 'sh', klemme_wp: 0, klemme_heizstab: null};
    let t = T0;
    const tick = (w, hs) => { t += MIN; Z.lies(S5, 'sh/status/em1:0', {act_power: w}, t, c5); const s = Z.stand(S5, t, c5, hs); Z.minute(S5, {t: t, ok: s.ok, wpW: s.wp_w, rohW: s.wp_roh_w, top16: 300, lauf: true, heizstab: hs, korrW: 80}, c5); return s; };
    for (let i = 0; i < 10; i++) { tick(400, 0); }
    const vor = tick(3350, 1);
    check('Heizstab ohne Klemme, vor der ersten Messung: Annahme 3 kW abgezogen (3350 − 3000 = 350 W)', vor.wp_w === 350 && vor.heizstab_w === 3000, vor.wp_w + ' W');
    for (let i = 0; i < 9; i++) { tick(3350, 1); }
    for (let i = 0; i < 10; i++) { tick(450, 0); }
    const HP = Z.heizParam(S5);
    check('Sprungerkennung: zwei Sprünge (Ein +2950 W, Aus +2900 W) -> Median 2925 W, Herkunft „gemessen aus 2 Sprüngen“', HP.n === 2 && HP.w === 2925 && /gemessen aus 2 Sprüngen/.test(HP.quelle), JSON.stringify(S5.hs.mess.map(x => x[1])));
    const nach = tick(3400, 1);
    check('danach: Heizstab-Minute zieht den gemessenen Wert ab (3400 − 2925 = 475 W)', nach.wp_w === 475 && nach.heizstab_w === 2925, nach.wp_w + ' W');
    // 24-h-Vergleich
    const S6 = Z.neu(); let t6 = T0;
    for (let i = 0; i < 200; i++) { t6 += MIN; Z.minute(S6, {t: t6, ok: true, wpW: 395, rohW: 395, top16: 300, lauf: true, heizstab: 0, korrW: 80}, c5); }
    for (let i = 0; i < 100; i++) { t6 += MIN; Z.minute(S6, {t: t6, ok: true, wpW: 40, rohW: 40, top16: 34, lauf: false, heizstab: 0, korrW: 80}, c5); }
    let Vg = Z.vergleich(S6, t6, 80);
    check('24-h-Vergleich: im Lauf Zähler 395 W gegen TOP16 300 W -> gemessen +95 W statt Annahme 80 W (Abweichung +15 W), Stillstand +6 W', Vg.korrGemessenW === 95 && near(Vg.lauf.diffW, 15) && near(Vg.stand.diffW, 6) && Vg.lauf.n === 200, JSON.stringify(Vg.lauf));
    Vg = Z.vergleich(S6, t6 + 25 * 3600000, 80);
    check('nach 25 h ohne neue Minuten: Vergleich leer', Vg.n === 0 && Vg.korrGemessenW === null, '');
    const p1 = Z.pruefe({topic: 'shelly3em63g3-a1b2c3', klemme_wp: 0, klemme_heizstab: 0}, {}), p2 = Z.pruefe({topic: 'x/#'}, {}), p3 = Z.pruefe({quelle: 'zaehler', topic: ''}, {}), p4 = Z.pruefe({topic: 'shelly3em63g3-a1b2c3/status/em:0', klemme_wp: 2, klemme_heizstab: '', quelle: 'zaehler', broker: 'nas', invertieren: [false, true, false]}, {klemme_heizstab: 1});
    check('Form prüfen: doppelte Klemme, Wildcard, Zähler ohne Namen -> Fehler; gültige Eingabe -> Konfiguration (Heizstab „–“ = null, Broker NAS)', p1.fehler.length === 1 && p2.fehler.length === 1 && p3.fehler.length === 1 && !p4.fehler.length && p4.cfg.klemme_wp === 2 && p4.cfg.klemme_heizstab === null && p4.cfg.broker === 'nas' && p4.cfg.quelle === 'zaehler' && p4.cfg.invertieren[1] === true && p4.cfg.prefix === undefined, JSON.stringify(p4.cfg));
    const kt = Z.karte(st, Z.vergleich(S6, t6, 80), cT, now, {top16: 300, lauf: true, korrW: 80});
    check('Karte: Status online, Drehstrom, Venus, HeishaMon; Kennzahlen Wärmepumpe (gegen TOP16 + Korrektur), Heizstab, 24 h, Korrektur gemessen „+95 W statt Annahme 80 W“, Zählerstand; Form mit Werten', kt.status[0].c === 'ok' && kt.kpi.map(x => x.k).join('|') === 'Wärmepumpe|Heizstab|Lauf · 24 h|Korrektur gemessen|Stillstand · 24 h|Zählerstand' && kt.kpi[3].v === '+95 W' && kt.kpi[3].s === 'statt Annahme 80 W' && kt.form.klemme_wp === 1, kt.kpi.map(x => x.k + ' ' + x.v).join(' · '));
}

console.log('\n--- Karten (eng_ui VER ' + U.v + ', engine_view.copBuild)');
{
    const S = {}; for (let i = 0; i < 180; i++) { const m = minute(T0 + 10 * 3600000 + i * MIN, {hz: i < 30 ? 0 : 16, pel: i < 30 ? 30 : 300, vl: i > 150 ? 35 : 33}); m.pth = 2400; E.copZielStep(S, m, cfg0); }
    const C = V.copBuild(S, T0 + 13 * 3600000, cfg0), H = U.html('cop', C);
    check('Karte COP: drei Kennzahlen (letzte Stunde 12–13 Uhr, heute, gestern) mit Ist/Ziel und Chip; Posten-Tabelle mit Rest; Grundlage (Gütegrad Startwerte, Strom HeishaMon)', C.kpi.length === 3 && /12–13 Uhr/.test(C.kpi[0].k) && C.kpi[1].v.indexOf(' / ') > 0 && C.zeilen.some(z => z.name === 'Rest (unerklärt)') && C.info[0].chip === 'Startwerte' && C.info[1].chip === 'HeishaMon' && /Posten/.test(H) && !/class="note"/.test(H),
          C.kpi.map(k => k.k + ' ' + k.v + ' ' + (k.chip || '')).join(' · '));
    check('Karte COP: nur Posten > 0 (plus Rest), Stillstand nur im Tageswert', C.zeilen.every(z => z.name === 'Rest (unerklärt)' || z.zellen.some(c => c.v !== '–')) && C.zeilen.filter(z => z.name === 'Stillstandsstrom').every(z => z.zellen[0].v === '–'), C.zeilen.map(z => z.name).join(', '));
    check('Chip: ≤ 5 % ok, ≤ 15 % Warnung, darüber Fehler, besser als Ziel ok', V.chipDiff(4).c === 'ok' && V.chipDiff(12).c === 'warn' && V.chipDiff(16).c === 'bad' && V.chipDiff(-3).c === 'ok' && V.chipDiff(-3).t === '+3,0 %', '');
    const Hz = U.html('zaehler', {status: [{t: 'online', c: 'ok'}], kpi: [], form: {topic: 'abc', broker: 'nas', profil: 'auto', klemme_wp: 0, klemme_heizstab: null, klemme_sonstiges: 2, invertieren: [false, true, false], quelle: 'heishamon'}});
    check('Karte Stromzähler: Form mit MQTT-Name, Broker, Profil, drei Klemmen (Heizstab „–“), Invertieren je Klemme, Quelle; Knopf Speichern', /data-f="topic" value="abc"/.test(Hz) && /value="nas" selected/.test(Hz) && /data-f="klemme_heizstab"><option value="" selected>–/.test(Hz) && /data-f="inv1" checked/.test(Hz) && /data-a="zaehler_speichern"/.test(Hz) && /value="heishamon" selected/.test(Hz), '');
}

if (flowsFile) {
    console.log('\n--- Hülle opt_zaehler aus ' + path.basename(flowsFile));
    const flows = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), N = {}; flows.forEach(n => { N[n.id] = n; });
    const fn = N.opt_zaehler, gs = {OPT_cfg: {zaehler: {quelle: 'heishamon', topic: '', broker: 'venus', klemme_wp: 0, klemme_heizstab: null, klemme_sonstiges: null, invertieren: [false, false, false]}, cop: {pelKorrW: 80}}, OPT_hp: {Internal_Heater_State: {v: 0, ts: T0}}, TOP16_Heat_Energy_Consumption: 300, compressor_frequency: 16};
    const fls = {}, fsM = {readFileSync: p => { if (fls[p] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return fls[p]; }, writeFileSync: (p, d) => { fls[p] = String(d); }, mkdirSync: () => {}};
    let NOW = T0, fstore = {}; const warn = [];
    class FD extends Date { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
    const run = msg => vm.runInNewContext('(function(msg,global,flow,node,fs,Date){' + fn.func + '\n})', {Buffer: Buffer, JSON: JSON, Math: Math, Object: Object, Array: Array, String: String, Number: Number, isFinite: isFinite, RegExp: RegExp})(msg, {get: k => gs[k], set: (k, v) => { gs[k] = v; }}, {get: k => fstore[k], set: (k, v) => { fstore[k] = v; }}, {warn: w => warn.push(w)}, fsM, FD);
    const wired = JSON.stringify(fn.wires) === '[["opt_mqtt_zl_v"],["opt_mqtt_zl_n"],["opt_t_zaehler"],["opt_ui_toast"],["opt_f_qev"]]' && N.opt_mqtt_zl_v.inputs === 1 && N.opt_mqtt_zl_v.broker === 'opt_broker_venus' && N.opt_mqtt_zl_n.broker === 'opt_broker_nas' && N.opt_mqtt_zl_v.topic === '' &&
                  !flows.some(n => n.z === 'opt_tab' && n.type === 'mqtt out' && n.id !== 'opt_apply_mqtt') && N.opt_g_zaehler.tab === 'opt_ui_tab_data' && N.opt_g_zaehler.width === 17 && N.opt_t_zaehler.group === 'opt_g_zaehler' && JSON.stringify(N.opt_t_zaehler.wires) === '[["opt_zaehler"]]' && N.opt_i_zl.repeat === '60' && N.opt_i_zl_init.topic === 'init';
    check('Knoten: zwei dynamische mqtt in (Venus, NAS) -> opt_zaehler (5 Ausgänge: Abos Venus/NAS, Karte, Meldung, Ereignis), Karte auf Daten & Güte 17 breit, kein neuer Sendeknoten', wired, JSON.stringify(fn.wires));
    let o = run({topic: 'init'});
    check('Start ohne MQTT-Namen: nur „alles abbestellen“ an beide Broker, Karte „nicht eingerichtet“', JSON.stringify(o[0]) === '[{"action":"unsubscribe","topic":true}]' && JSON.stringify(o[1]) === '[{"action":"unsubscribe","topic":true}]' && o[2].payload.status[0].t === 'nicht eingerichtet', JSON.stringify(o[0]));
    fls['/data/optimizer/config.json'] = JSON.stringify({rooms: [{id: 'wohn', min: 22}], engine: {rules: {heizregelung: {heizstabVorrang: 1}}}});
    o = run({topic: 'zaehler_speichern', payload: {topic: 'shelly3em63g3-a1b2c3/status/em:0', broker: 'venus', profil: 'auto', klemme_wp: 1, klemme_heizstab: null, klemme_sonstiges: null, invertieren: [false, false, false], quelle: 'heishamon'}});
    const sv = JSON.parse(fls['/data/optimizer/config.json']);
    check('Speichern: config.json bekommt nur den Schlüssel „zaehler“ (Räume, Engine bleiben), OPT_cfg aktualisiert, Abos am Venus-Broker (9 Topics), Meldung, Ereignis optimierer_zaehler', sv.rooms[0].min === 22 && sv.engine.rules.heizregelung.heizstabVorrang === 1 && sv.zaehler.klemme_wp === 1 && gs.OPT_cfg.zaehler.topic === 'shelly3em63g3-a1b2c3/status/em:0' &&
          o[0].length === 2 && o[0][1].action === 'subscribe' && o[0][1].topic.length === 9 && o[1].length === 1 && /Gespeichert/.test(o[3].payload) && /optimierer_zaehler/.test(o[4].payload), JSON.stringify(o[0][1].topic.slice(0, 2)));
    o = run({topic: 'shelly3em63g3-a1b2c3/status/em:0', payload: {id: 0, a_act_power: 30, b_act_power: 410, c_act_power: 5, b_voltage: 230}});
    check('MQTT-Nachricht -> OPT_zaehler (wp_w 410, ok), keine Ausgabe', gs.OPT_zaehler && gs.OPT_zaehler.wp_w === 410 && gs.OPT_zaehler.ok && o.every(x => x === null), JSON.stringify(gs.OPT_zaehler && {wp: gs.OPT_zaehler.wp_w, ok: gs.OPT_zaehler.ok}));
    NOW += MIN; o = run({topic: 'tick'});
    check('Minute: Karte mit Wärmepumpe 410 W gegen TOP16 + 80 W = 380 W (+30 W), Zustand gesichert (ohne Messwerte)', o[2].payload.kpi[0].v === '410 W' && /\+30 W/.test(o[2].payload.kpi[0].s) && fls['/data/optimizer/zaehler-state.json'] && JSON.parse(fls['/data/optimizer/zaehler-state.json']).k[1].w === undefined, o[2].payload.kpi[0].s);
    o = run({topic: 'zaehler_speichern', payload: {klemme_wp: 1, klemme_heizstab: 1}});
    check('Speichern mit doppelter Klemme: rote Meldung, nichts geändert', o[3].highlight === 'red' && JSON.parse(fls['/data/optimizer/config.json']).zaehler.klemme_heizstab === null, o[3].payload);
    o = run({topic: 'zaehler_speichern', payload: {quelle: 'zaehler', broker: 'nas'}});
    check('Umschalten auf Zähler (Schalter der Form) und NAS-Broker: Meldung nennt die neue Quelle, Abos wandern zum NAS-Broker, Ereignis mit „vorher heishamon“', gs.OPT_cfg.zaehler.quelle === 'zaehler' && /jetzt vom Zähler/.test(o[3].payload) && o[1].length === 2 && o[0].length === 1 && /vorher heishamon/.test(o[4].payload), o[3].payload);
    NOW += 7 * MIN; o = run({topic: 'tick'});
    check('Ausfall (7 min ohne Meldung, Quelle Zähler): Ereignis „Zähler ausgefallen … Rückfall“, Karte „Rückfall auf HeishaMon“, Abos erneuert erst nach 10 min', /Zähler ausgefallen/.test(o[4] && o[4].payload) && o[2].payload.status.some(s => s.t === 'Rückfall auf HeishaMon') && !gs.OPT_zaehler.ok && o[1] === null, o[4] && o[4].payload.trim());
    NOW += 4 * MIN; o = run({topic: 'tick'});
    check('nach 10 min ohne Meldung: Abos erneuert (Neustart des mqtt in)', o[1] && o[1].length === 2 && o[1][1].action === 'subscribe', '');
    run({topic: 'shelly3em63g3-a1b2c3/events/rpc', payload: JSON.stringify({method: 'NotifyStatus', params: {'em:0': {b_act_power: 395}}})}); NOW += MIN; o = run({topic: 'tick'});
    check('Zähler wieder da: Ereignis „wieder da nach … min“, OPT_zaehler ok', /wieder da nach/.test(o[4] && o[4].payload) && gs.OPT_zaehler.ok && gs.OPT_zaehler.wp_w === 395, o[4] && o[4].payload.trim());
    check('keine Warnungen der Hülle', !warn.length, warn.join(' | '));
    // COP_KW_JS in den anderen Knoten: pelQ = pelK im Standard
    const qf = N.opt_quiet.func;
    check('opt_quiet/opt_eval/opt_plan: Zählerspalten hinten, Anzeige mit pelQ (Zähler nur bei Quelle zaehler und frisch), Rohspalten unverändert', /'druck_bar', 'zaehler_wp_w', 'zaehler_heizstab_w'\]/.test(qf) && /function pelQ\(p, lauf\) \{ return ZQ\.aktiv \? ZQ\.w : pelK\(p, lauf\); \}/.test(qf) && /c\(pelKNow\), c\(copNowK\), COP_KW/.test(qf) && /'cop_korr_w', 'zaehler_wp_w', 'zaehler_heizstab_w'\]/.test(N.opt_eval.func) && /ACT_Z = \['ist_strom_zaehler_kwh', 'ist_zaehler_min'\]/.test(N.opt_plan.func), '');
    check('opt_engine: Zähler (zw, zAge, zh) aus OPT_zaehler, cfg mit zaehler und copZiel (OPT_cop_eta); opt_nas legt OPT_cop_eta ab', /inp\.zw = num\(ZLx\.wp_w\)/.test(N.opt_engine.func) && /zaehler: CF\.zaehler \|\| \{\}, copZiel: G\('OPT_cop_eta'\)/.test(N.opt_engine.func) && /global\.set\('OPT_cop_eta', CE\)/.test(N.opt_nas.func), '');
}

if (dataDir && fs.existsSync(path.join(dataDir, 'quiet-2026-10.csv'))) {
    console.log('\n--- Replay ' + dataDir + ' (07.–17.10.)');
    const von = new Date(2026, 9, 7).getTime(), bis = new Date(2026, 9, 18).getTime(), M = K.lade(dataDir, von, bis), base = K.cfgAus(dataDir), eta = K.kalibriere(M, base);
    const cfgR = E.mergeCfg({cop: base.cop, zaehler: base.zaehler, copZiel: eta}), S = {}; M.forEach(m => E.copZielStep(S, K.eingabe(m), cfgR));
    const days = Object.keys(S.cz.d).sort().map(k => [k, E.czAgg([S.cz.d[k]], true)]), G = E.czAgg(Object.keys(S.cz.d).map(k => S.cz.d[k]), true);
    check('Replay: 11 Tage, Kennzahlen 14.10. wie Beobachter/Container (Strom 5,37 kWh, Wärme 27,34 kWh, COP 5,09)', days.length === 11 && days.find(d => d[0] === '2026-10-14')[1].e === 5.37 && days.find(d => d[0] === '2026-10-14')[1].q === 27.34 && days.find(d => d[0] === '2026-10-14')[1].cist === 5.09, days.map(d => d[0].slice(8) + ':' + d[1].cist + '/' + d[1].cz).join(' '));
    check('Replay: Rest je Tag unter 5 % des Stroms, gesamt unter 1 %', days.every(d => Math.abs(d[1].rest) < 5) && Math.abs(G.rest) < 1, days.map(d => d[1].rest).join('/') + ' · gesamt ' + G.rest);
    check('Replay: Kalibrierung mit dT_verd aus Rohr außen (3–4 K), eta 0,44–0,51, Frequenz 18–20 Hz gemessen', Object.keys(eta.dTverd).every(b => eta.dTverd[b].v >= 3 && eta.dTverd[b].v <= 4.5) && Object.keys(eta.eta).every(b => eta.eta[b].v >= 0.44 && eta.eta[b].v <= 0.52) && eta.freq['18-20'].quelle === 'gemessen', JSON.stringify(eta.eta) + ' ' + JSON.stringify(eta.freq['18-20']));
}
console.log('\n--- Kennzahlen des Containers (kennzahlen_tag.py) mit Zählerspalte');
{
    const os = require('os'), cp = require('child_process'), d = fs.mkdtempSync(path.join(os.tmpdir(), 'czkz-')), e = fs.mkdtempSync(path.join(os.tmpdir(), 'czkz-e-'));
    const H = 'zeit,verdichter_hz,leistung_el_w,leistung_th_heisha_w,aussen,zustand,defrost,warmwasser,zaehler_wp_w,zaehler_heizstab_w', L = [H];
    for (let i = 0; i < 120; i++) { const t = new Date(2026, 9, 20, 10, i); L.push(E.iso(t.getTime()) + ',16,300,2400,8,lauf,0,0,' + (i < 60 ? '400' : '') + ','); }
    fs.writeFileSync(path.join(d, 'quiet-2026-10.csv'), L.join('\n') + '\n');
    const lauf = (q) => { fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({zaehler: {quelle: q}})); const r = cp.spawnSync('python3', [path.join(__dirname, 'kennzahlen_tag.py'), '--daten', d, '--ergebnis', e, '--tag', '2026-10-20'], {encoding: 'utf8'}); return r.status === 0 ? JSON.parse(fs.readFileSync(path.join(e, 'kennzahlen', '2026-10-20.json'), 'utf8')).fakten : null; };
    const fh = lauf('heishamon'), fz = lauf('zaehler');
    check('Kennzahlen: Standard heishamon Strom 120 min × 380 W = 0,76 kWh (Zählerspalte nur als Vergleich 0,4 kWh in 60 min); quelle zaehler: 60 min × 400 W + 60 min × 380 W = 0,78 kWh, Fakt energie.quelle',
          fh && fz && fh['energie.strom_kwh'] === 0.76 && fh['energie.strom_kwh_zaehler'] === 0.4 && fh['energie.zaehler_min'] === 60 && fh['energie.quelle'] === undefined && fz['energie.strom_kwh'] === 0.78 && fz['energie.quelle'] === 'zaehler' && fz['energie.strom_kwh_roh'] === 0.6,
          fh && fz ? [fh['energie.strom_kwh'], fz['energie.strom_kwh'], fz['energie.strom_kwh_roh']].join(' / ') : 'Lauf fehlgeschlagen');
    fs.rmSync(d, {recursive: true, force: true}); fs.rmSync(e, {recursive: true, force: true});
}
function de(v) { return (Math.round(v * 1000) / 1000).toString().replace('.', ','); }
console.log('\nERGEBNIS cop_ziel_sim: ' + ok + ' OK, ' + fail + ' FAIL');
process.exitCode = fail ? 1 : 0;

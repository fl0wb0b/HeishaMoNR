#!/usr/bin/env node
// Pruefungen der Wetterkarte (wetter-grafik 17.10.2026): reine Funktionen in tools/wx_core.js gegen den Kern (engine_core.js), Diagramm-Baukasten (ui_chart.js, VER 6:
// Zeitbaender, Zeitraster, Tooltip-Fenster) und - mit Flow-Datei - die Huelle opt_engine (OPT_cz_verlauf) und die Einbettung in opt_hist.
// Usage: node tools/wx_core_test.js ["flows.json" (vom Generator erzeugt)]
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const W = require('./wx_core.js');
const E = require('./engine_core.js');
const OC = require('./ui_chart.js');
const MIN = 60000, H = 3600000;
let ok = 0, fail = 0;
function check(name, cond, info) { if (cond) { ok++; console.log('OK   ' + name); } else { fail++; console.log('FAIL ' + name + (info !== undefined ? '  -> ' + info : '')); } }
const NOW = new Date(2026, 9, 17, 9, 40, 0).getTime();

// ---- Raster und Luecken
const fp = [[NOW, 10, 93, 100, 4.4], [NOW + 3 * H, 13, 73, 75, 5.6], [NOW + 6 * H, 7, 87, 13, 3.4]];
const ra = W.raster(fp, NOW, NOW + 36 * H, H);
check('Raster: erster Punkt jetzt (09:40), dann volle Stunden bis zum letzten Prognosepunkt (15:00), linear (jetzt 10, 12:00 12,33, 15:00 8,33), danach nichts', ra.length === 7 && ra[0][0] === NOW && ra[0][1] === 10 && ra.slice(1).every(p => new Date(p[0]).getMinutes() === 0) && Math.abs(ra[3][1] - 12.333) < 0.01 && Math.abs(ra[6][1] - 8.333) < 0.01, JSON.stringify(ra.map(p => p[1])));
const ra2 = W.raster([[NOW + 20 * MIN, 5, 80, 0, 1], [NOW + 3 * H + 20 * MIN, 8, 80, 0, 1]], NOW, NOW + 10 * H, H);
check('Raster: beginnt die Prognose nach jetzt, beginnt das Raster beim ersten Punkt (keine Werte davor)', ra2[0][0] === NOW + 20 * MIN && ra2[0][1] === 5 && ra2.every(p => p[0] >= NOW + 20 * MIN), JSON.stringify(ra2.map(p => (p[0] - NOW) / MIN)));
check('Raster: Luecke > 6 h zwischen zwei Punkten bleibt null, unsortierte Eingabe wird sortiert, Muell ignoriert', (() => { const N0 = Math.floor(NOW / H) * H, r = W.raster([[N0 + 10 * H, 3], null, 'x', [N0, 1], [N0 + 2 * H, 2]], N0, N0 + 12 * H, H); return r.length === 11 && r[1][1] === 1.5 && r[2][1] === 2 && r[5][1] === null && r[10][1] === 3; })(), '');
check('Raster: leere oder kaputte Prognose -> leeres Raster', W.raster(null, NOW, NOW + H, H).length === 0 && W.raster([], NOW, NOW + H, H).length === 0 && W.raster([[null, 1]], NOW, NOW + H, H).length === 0, '');

// ---- Abtauwetter: dieselbe Entscheidung wie ENGINE.abtauWetter (ohne Rohrwert)
const L = E.mergeCfg({}).locks, LW = W.abtauL({});
let diff = 0, n = 0;
for (let at = -8; at <= 12; at += 0.5) { for (const rh of [null, 50, 79, 80, 95]) { n++; const e = E.abtauWetter({at: at, rh: rh, pipeOut: null}, L).ja, w = W.abtauJa(at, rh, LW); if (e !== w) { diff++; } } }
check('Abtauwetter: WXC.abtauJa entscheidet in ' + n + ' Faellen (AT -8…12 °C, Feuchte leer/50/79/80/95 %) genau wie ENGINE.abtauWetter (Schwellen aus LOCK_CFG: -5 / unter 10 °C / 80 % / ohne Feuchte bis 4 °C)', diff === 0 && LW.abtauAtMin === L.abtauAtMin && LW.abtauAtMax === L.abtauAtMax && LW.abtauRhMin === L.abtauRhMin && LW.abtauAtOhne === L.abtauAtOhne, diff + ' Abweichungen');
check('Abtauwetter: Schwellen aus OPT_cfg.engine.locks ueberschreiben den Standard (nur Zahlen)', (() => { const l = W.abtauL({engine: {locks: {abtauRhMin: 90, abtauAtMax: 'x'}}}); return l.abtauRhMin === 90 && l.abtauAtMax === 10; })(), '');
const pr = [];
for (let k = 0; k < 24; k++) { pr.push([NOW + k * 15 * MIN, k < 8 ? 5 : (k < 12 ? 11 : 3), k === 20 ? 70 : 90, 15 * MIN]); }
const bd = W.abtauBaender(pr, LW);
check('Abtauband: zusammenhaengende Abschnitte (5 °C/90 % 2 h, Pause bei 11 °C, 3 °C/90 % mit einer Probe 70 % dazwischen) -> drei Baender mit halber Probendauer am Rand', bd.length === 3 && bd[0][0] === NOW - 7.5 * MIN && bd[0][1] === NOW + 2 * H - 7.5 * MIN && bd[1][0] === NOW + 3 * H - 7.5 * MIN && bd[2][0] === NOW + 5 * H + 7.5 * MIN, JSON.stringify(bd.map(b => [(b[0] - NOW) / MIN, (b[1] - NOW) / MIN])));
check('Abtauband: Proben ohne AT oder leere Liste -> keine Baender', W.abtauBaender([[NOW, null, 90, 5 * MIN]], LW).length === 0 && W.abtauBaender(null, LW).length === 0, '');

// ---- Naechte
const nf = W.naechte(NOW - 24 * H, NOW + 36 * H, null);
check('Naechte ohne Sonnenzeiten: fest 18-07 Uhr, im Fenster abgeschnitten (16.10. 18:00 - 17.10. 07:00 usw.)', nf.length === 3 && new Date(nf[0][0]).getHours() === 18 && new Date(nf[0][1]).getHours() === 7 && nf[2][1] === NOW + 36 * H, JSON.stringify(nf.map(b => new Date(b[0]).toString().slice(4, 21))));
const ns = W.naechte(NOW - 24 * H, NOW + 36 * H, [new Date(2026, 9, 17, 7, 58).getTime(), new Date(2026, 9, 17, 18, 31).getTime()]);
check('Naechte mit Sonnenzeiten (OWM): 18:31-07:58 an jedem Tag; ueber die Zeitumstellung 25.10. bleibt die Ortszeit', ns.length === 3 && new Date(ns[1][0]).getHours() === 18 && new Date(ns[1][0]).getMinutes() === 31 && new Date(ns[1][1]).getMinutes() === 58 &&
      (() => { const a = new Date(2026, 9, 24, 12).getTime(), x = W.naechte(a, a + 48 * H, [new Date(2026, 9, 17, 7, 58).getTime(), new Date(2026, 9, 17, 18, 31).getTime()]); return x.every(b => new Date(b[0]).getHours() === 18 || b[0] === a) && x.some(b => new Date(b[1]).getHours() === 7 && new Date(b[1]).getDate() === 25); })(), JSON.stringify(ns.map(b => new Date(b[0]).toString().slice(4, 21))));
check('Naechte: unplausible Sonnenzeiten (Untergang vor Aufgang) -> fest 18-07', W.naechte(NOW, NOW + 24 * H, [NOW + 10 * H, NOW]).some(b => new Date(b[0]).getHours() === 18), '');

// ---- Heizkurve wie opt_engine (sollKurve), COP-Ziel voraus mit derselben Funktion wie der Kern
const K = [-13, 11, 29, 37];
check('Heizkurve: wie sollKurve in opt_engine (unter -13 °C 37, ueber 11 °C 29, dazwischen linear; 0 °C -> 32,67)', W.kurveSoll(K, -20) === 37 && W.kurveSoll(K, 15) === 29 && Math.abs(W.kurveSoll(K, 0) - 32.667) < 0.01 && W.kurveSoll([1, 1, 2, 3], 0) === null && W.kurveSoll(null, 0) === null, '');
const cfg = E.mergeCfg({}), S = {}, t0 = new Date(2026, 9, 16, 9, 0).getTime();
// Kern-Zustand mit Stundenwerten: 26 h Laufminuten (stationaer, 17 Hz)
for (let m = 0; m < 26 * 60; m++) { E.copZielStep(S, {t: t0 + m * MIN, hz: 17, vl: 31, rl: 29, soll: 31, at: 8, pel: 300, pth: 1500, defrost: 0, dhw: 0, heater: 0, rh: 85, hpAge: 0}, cfg); }
const NOW2 = t0 + 26 * H, fps = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36].map(h => [NOW2 + h * H, h < 12 ? 2 : 12, h < 12 ? 95 : 70, 50, 3]);
const Wx = {status: 'OK', f_ts: NOW2, temp: 2, fpts: fps}, PI = {ts: NOW2, pv: [[NOW2 + 3 * H, 4000, H]]};
const cv = W.copVerlauf(E, cfg, S, Wx, PI, {shift: 1, kurve: K, soll: 33}, NOW2);
const direkt = E.copZiel({t: NOW2 + 6 * H, hz: 17, vl: W.kurveSoll(K, 2) + 1, rl: W.kurveSoll(K, 2) - 1, soll: W.kurveSoll(K, 2) + 1, at: 2, pel: 400, pth: 2000, hpAge: 0, rh: 95, defrost: 0, dhw: 0, heater: 0}, cfg, E.czNew()).cz;
check('COP-Ziel voraus: 37 Stundenwerte, je Stunde ENGINE.copZiel mit Prognose-AT/-Feuchte und Soll = Heizkurve(AT) + Verschiebung (gleicher Wert wie direkt gerechnet)', cv.zp.length === 37 && cv.quelle === 'kurve' && Math.abs(cv.zp[6][1] - direkt) < 0.006 && cv.soll === Math.round((W.kurveSoll(K, 2) + 1) * 10) / 10, JSON.stringify([cv.zp.length, cv.zp[6], direkt]));
check('COP-Ziel voraus: physikalisch plausibel (12 °C/70 % deutlich hoeher als 2 °C/95 % mit Abtaufaktor), alle Werte 2…9', cv.zp[20][1] > cv.zp[6][1] * 1.2 && cv.zp.every(p => p[1] > 2 && p[1] < 9), JSON.stringify([cv.zp[6][1], cv.zp[20][1]]));
check('COP-Ziel zurueck: Stundenwerte des Kerns (czAgg je Stunde wie die Karte "COP: Ziel und Ist") der letzten 24 h, Zeit = Stundenmitte', cv.zh.length >= 24 && cv.zh.length <= 26 && cv.zh.every(p => p[0] <= NOW2 && p[0] >= NOW2 - 25 * H && new Date(p[0]).getMinutes() === 30) && Math.abs(cv.zh[5][1] - E.czAgg([S.cz.h[Object.keys(S.cz.h).sort()[cv.zh.length > 25 ? 6 : 5 + (Object.keys(S.cz.h).length - cv.zh.length)]]], false).cz) < 0.01, JSON.stringify([cv.zh.length, cv.zh[5]]));
const cvS = W.copVerlauf(E, cfg, S, Wx, PI, {shift: 1, kurve: null, soll: 33}, NOW2), cvN = W.copVerlauf(E, cfg, S, Wx, PI, {kurve: null, soll: null}, NOW2);
check('COP-Ziel voraus ohne Heizkurve: jetziger Soll-Vorlauf (33 °C) fuer alle Stunden; ohne Kurve und Soll: kein Verlauf voraus, Vergangenheit bleibt', cvS.quelle === 'soll' && cvS.zp.length === 37 && cvS.soll === 33 && cvN.zp.length === 0 && cvN.zh.length === cv.zh.length, '');
const cvW = W.copVerlauf(E, cfg, S, {status: 'OK', f_ts: NOW2 - 7 * H, fpts: fps}, PI, {kurve: K}, NOW2), cvE = W.copVerlauf(E, cfg, null, null, null, null, NOW2);
check('COP-Ziel: Prognose aelter als 6 h -> kein Verlauf voraus; ohne Zustand/Wetter -> leere Listen, kein Fehler', cvW.zp.length === 0 && cvE.zp.length === 0 && cvE.zh.length === 0, '');

// ---- Ist-COP aus den Protokollspalten
const rows = [];
const NH = Math.floor(NOW / H) * H;
for (let k = 0; k < 24; k++) { rows.push({t: NH - 2 * H + k * 5 * MIN, verdichter_hz: k % 12 < 6 ? '17' : '0', cop_korr: k % 12 < 6 ? (k < 12 ? '4' : '6') : '', leistung_korr_w: k % 12 < 6 ? '400' : '20'}); }
const ist = W.istAusZeilen(rows);
check('Ist-COP je Stunde aus cop_korr x leistung_korr_w / Summe leistung_korr_w, nur Laufzeilen, Punkt in der Stundenmitte', ist.length === 2 && ist[0][1] === 4 && ist[1][1] === 6 && ist[0][0] === NH - 2 * H + H / 2, JSON.stringify(ist));
check('Ist-COP: Stunde mit weniger als 3 Laufzeilen faellt weg, Unsinn (COP > 15, Strom 0) wird ignoriert', W.istAusZeilen([{t: NOW, verdichter_hz: 17, cop_korr: 4, leistung_korr_w: 400}, {t: NOW, verdichter_hz: 17, cop_korr: 40, leistung_korr_w: 400}, {t: NOW, verdichter_hz: 17, cop_korr: 4, leistung_korr_w: 0}]).length === 0, '');

// ---- Diagramm-Baukasten VER 6
const spec = {t0: NOW - 24 * H, t1: NOW + 36 * H, step: 6 * H, tb: [{a: NOW - 10 * H, b: NOW - 2 * H, c: 'rgba(1,2,3,.1)'}], marks: [{t: NOW, label: 'jetzt'}], panels: [
    {h: 100, unit: '°C', tb: [{a: NOW, b: NOW + 5 * H, c: 'rgba(3,155,229,.13)', n: 'Abtauwetter'}], series: [{n: 'Prognose', c: '#ef6c00', tol: 31 * MIN, d: [[NOW, 5], [NOW + H, 6], [NOW + 2 * H, 7]]}, {n: 'leer', k: 'area', d: []}]},
    {h: 60, unit: 'kW', series: [{n: 'PV', k: 'area', d: [[NOW, 1], [NOW + H, 2]]}]}]};
const sv = OC.svg(spec, 912);
check('Diagramm-Baukasten VER 6: Zeitbaender (alle Tafeln + nur Tafel 1) als Rechtecke, festes 6-h-Raster (11 Striche bei 60 h statt 12-h-Raster), ohne NaN', OC.v === 7 && (sv.svg.match(/fill="rgba\(1,2,3,\.1\)"/g) || []).length === 2 && (sv.svg.match(/fill="rgba\(3,155,229,\.13\)"/g) || []).length === 1 && (sv.svg.match(/<text[^>]*text-anchor="middle"/g) || []).length === 10 && !/NaN|undefined|Infinity/.test(sv.svg), (sv.svg.match(/<text[^>]*text-anchor="middle"/g) || []).length + ' Zeitbeschriftungen');
const tip = OC.at(spec, NOW + 30 * MIN), tip2 = OC.at(spec, NOW + 6 * H);
check('Diagramm-Baukasten VER 6: Tooltip mit eigenem Fenster (31 min statt 20 min: Stundenpunkte ueberall lesbar), benanntes Zeitband erscheint im Tooltip ("Abtauwetter: ja"), ausserhalb nicht', tip.some(q => q.name === 'Prognose') && tip.some(q => q.name === 'Abtauwetter' && q.text === 'ja') && !tip2.some(q => q.name === 'Abtauwetter'), JSON.stringify(tip.map(q => q.name + ' ' + q.text)));
check('Diagramm-Baukasten VER 6: ohne step/tb wie bisher (60 h -> 12-h-Raster), leere Reihe nur in der Legende', (OC.svg({t0: NOW, t1: NOW + 60 * H, panels: [{h: 50, series: [{n: 'a', d: []}]}]}, 900).svg.match(/text-anchor="middle"/g) || []).length <= 6 && /leer/.test(OC.legend(spec)), '');

// ---- Wetter-Symbole (VER 7): eigene SVG-Zeichen, Symbolzeile 18 px, Abstand, Tooltip; Vergangenheit endet 90 min vor jetzt, wenn "jetzt" ein Symbol hat
const KL = ['sonne', 'mond', 'sonne_wolke', 'mond_wolke', 'wolke', 'regen', 'niesel', 'schnee', 'nebel', 'gewitter'];
check('Symbole: jede der 10 Klassen zeichnet eigene SVG-Formen (keine Bilder, keine Links, kein Text), unbekannt -> nichts', KL.every(k => { const g = OC.symbol(k, 50, 20); return g.length > 40 && /<(path|circle|line)/.test(g) && !/<image|href|<text|NaN/.test(g); }) && OC.symbol('x', 1, 1) === '' && new Set(KL.map(k => OC.symbol(k, 50, 20))).size === 10, '');
const symSpec = sym => ({t0: NOW - 24 * H, t1: NOW + 36 * H, panels: [{h: 100, sym: sym, series: [{n: 'a', d: [[NOW, 1]]}]}]});
const S12 = [...Array(13)].map((_, k) => [NOW + k * 3 * H, KL[k % 10], 'Text ' + k]);
const g1 = OC.svg(symSpec(S12), 912), g0 = OC.svg({t0: NOW - 24 * H, t1: NOW + 36 * H, panels: [{h: 100, series: [{n: 'a', d: [[NOW, 1]]}]}]}, 912), gN = OC.svg(symSpec(S12), 400);
check('Symbolzeile: genau 18 px hoeher als ohne, ein Zeichen je 3-h-Punkt bei 912 px (13), bei 400 px Breite nur jedes zweite (Abstand >= 20 px), Marke "jetzt" unterhalb der Zeile', g1.geo.H - g0.geo.H === 18 && (g1.svg.match(/class="optch-sym"/g) || []).length === 13 && (gN.svg.match(/class="optch-sym"/g) || []).length === 7 && g1.geo.panels[0].top === 36, [(g1.svg.match(/class="optch-sym"/g) || []).length, (gN.svg.match(/class="optch-sym"/g) || []).length, g1.geo.H - g0.geo.H].join('/'));
check('Symbolzeile: Tooltip "Wetter" mit der Beschreibung des naechsten Punkts (bis 90 min), weiter weg nichts', OC.at(symSpec(S12), NOW + 3 * H + 40 * MIN).some(q => q.name === 'Wetter' && q.text === 'Text 1') && !OC.at(symSpec([[NOW, 'sonne', 'x']]), NOW + 2 * H).some(q => q.name === 'Wetter'), '');
const sv7 = W.symbole({fpts: [[NOW - 40 * MIN, 5, 80, 0, 1, 800, 1], [NOW + 3 * H, 5, 80, 0, 1, 500, 1]], fdesc: {500: 'leichter Regen'}}, [{t: (NOW - 4 * H) / 1000, owm: [[NOW - 3 * H, 5, 80, 0, 1, 804, 1], [NOW - H, 5, 80, 0, 1, 804, 1]]}], NOW, NOW - 24 * H, NOW + 36 * H, []);
check('Symbole: "jetzt" (Punkt 40 min alt) steht am Strich; Vergangenheit aus Schnappschuss nur bis 90 min vor jetzt (-3 h ja, -1 h nein); Beschreibung aus fdesc, sonst Klassenname', sv7.length === 3 && sv7[0][0] === NOW - 3 * H && sv7[1][0] === NOW && sv7[1][1] === 'sonne' && sv7[1][2] === 'klar' && sv7[2][2] === 'leichter Regen', JSON.stringify(sv7.map(x => [(x[0] - NOW) / MIN, x[1], x[2]])));

// ---- Datenfunktion: Ende-zu-Ende (Messung + Prognose) und leere Faelle
const rws = [];
for (let k = 288; k >= 0; k--) { const t = NOW - k * 5 * MIN; rws.push({t: t, aussen_panasonic: k > 100 ? '3' : '12', aussen_wetter: '3.5', aussen_berechnet: '4', wetter_taupunkt: '2', wetter_feuchte: k === 150 ? '' : '90', wetter_bewoelkung: '100', wetter_wind_ms: '2.5', pv_w: k < 50 ? '800' : '0', verdichter_hz: '17', cop_korr: '4.5', leistung_korr_w: '380'}); }
const d = W.daten({now: NOW, rows: rws, W: {status: 'OK', f_ts: NOW - 20 * MIN, fpts: fp, sun: null}, PI: {ts: NOW, pvSrc: 'VRM', pv: [[Math.floor(NOW / H) * H, 2000, H], [Math.floor(NOW / H) * H + H, 3000, H]]}, CZ: null, snaps: null, cfg: {}});
check('Datenfunktion: Vergangenheit 289 Punkte, Prognose 7 Punkte, PV gemessen in kW und Prognose (erster Punkt jetzt), Ist-COP aus den Spalten (4,5), COP-Ziel leer ohne OPT_cz_verlauf', d.hist.t.length === 289 && d.prog.t.length === 7 && d.hist.pv[288] === 0.8 && d.pv[0][0] === NOW && d.pv[0][1] === 2 && d.cop.ih.length >= 24 && d.cop.ih.every(p => p[1] === 4.5) && d.cop.zh.length === 0 && d.cop.zp.length === 0, JSON.stringify([d.hist.t.length, d.prog.t.length, d.pv.slice(0, 2), d.cop.ih.length]));
check('Datenfunktion: Abtauband Vergangenheit aus Messung (3 °C/90 % bis vor 100 Zeilen, Feuchte-Luecke einer Zeile ohne Feuchte bei 3 °C zaehlt nach Kern-Regel "ohne Feuchte bis 4 °C" mit), danach 12 °C keins; Zukunft aus der Prognose (10 °C nicht, ab ~+4,5 h fallend unter 10 °C mit >= 80 %)',
      d.abtau.length === 2 && d.abtau[0][0] === NOW - 24 * H && Math.abs(d.abtau[0][1] - (NOW - 101 * 5 * MIN + 2.5 * MIN)) <= MIN && d.abtau[1][0] > NOW + 3 * H && d.abtau[1][1] <= NOW + 6 * H + 8 * MIN, JSON.stringify(d.abtau.map(b => [(b[0] - NOW) / MIN, (b[1] - NOW) / MIN])));
const d0 = W.daten({now: NOW, rows: [], W: {}, PI: null, CZ: null, snaps: null, cfg: null});
check('Datenfunktion ohne alles: n 0, leere Listen, Naechte trotzdem, kein Fehler', d0.n === 0 && d0.hist.t.length === 0 && d0.prog.t.length === 0 && d0.abtau.length === 0 && d0.pv.length === 0 && d0.gestern === null && d0.nacht.length >= 2, '');

// ---- Naechte aus dem Sonnenstand (zeitleiste 18.10.2026): OPT_sonne (frisch, <= 30 min) vor den OWM-Zeiten
{ const sunO = [new Date(2026, 9, 17, 7, 58).getTime(), new Date(2026, 9, 17, 18, 31).getTime()], SO = {ts: NOW - 5 * MIN, aufgang: new Date(2026, 9, 17, 8, 1).getTime(), untergang: new Date(2026, 9, 17, 18, 28).getTime()};
  const dS = W.daten({now: NOW, rows: [], W: {sun: sunO}, SO: SO}), dO = W.daten({now: NOW, rows: [], W: {sun: sunO}, SO: Object.assign({}, SO, {ts: NOW - 40 * MIN})}), dN = W.daten({now: NOW, rows: [], W: {sun: sunO}, SO: {ts: NOW, aufgang: null}});
  const hm = d => d.nacht.map(b => new Date(b[0]).toTimeString().slice(0, 5) + '-' + new Date(b[1]).toTimeString().slice(0, 5)).join(' ');
  check('Naechte: frischer Sonnenstand (opt_sonne: 08:01/18:28) hat Vorrang vor OWM (07:58/18:31); aelter als 30 min oder ohne Zeiten -> OWM', /18:28-08:01/.test(hm(dS)) && /18:31-07:58/.test(hm(dO)) && /18:31-07:58/.test(hm(dN)), hm(dS) + ' | ' + hm(dO)); }

// ---- Flow-Datei: Einbettung und Huelle opt_engine (OPT_cz_verlauf)
const flowsFile = process.argv[2];
if (flowsFile) {
    const flows = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), NB = id => flows.find(n => n.id === id), core = fs.readFileSync(path.join(__dirname, 'wx_core.js'), 'utf8');
    check('Flow: wx_core.js unveraendert in opt_hist und opt_engine eingebettet, opt_hist nur lesend (kein writeFileSync), Karte opt_t_ch_at in Gruppe "Wetter · 24 h zurück, 36 h voraus" (17 breit), ui_chart VER 7 in allen Diagrammkarten',
          NB('opt_hist').func.includes(core) && NB('opt_engine').func.includes(core) && !/writeFileSync|node\.send/.test(NB('opt_hist').func) && NB('opt_g_ch_at').name === 'Wetter · 24 h zurück, 36 h voraus' && NB('opt_g_ch_at').width === 17 &&
          ['opt_t_ch_wp', 'opt_t_ch_rooms', 'opt_t_ch_at', 'opt_t_plan'].every(id => NB(id).format.includes('var VER = 7;')), '');
    check('Flow: opt_owm_parse merkt Sonnenauf-/-untergang (W.sun) nur aus der Antwort, keine neuen HTTP-Abfragen (Anzahl http request-Knoten im Tab gleich), keine neuen Geheimnisse', /W\.sun = \[p\.sys\.sunrise \* 1000, p\.sys\.sunset \* 1000\]/.test(NB('opt_owm_parse').func) && !/owm\.json|vrm\.json/.test(NB('opt_hist').func), '');
    // opt_engine einmal mit Minimal-Werten ausfuehren: rechnet weiter wie bisher und legt OPT_cz_verlauf ab
    const g = {OPT_cfg: {engine: {}, rooms: []}, TOP14_Outside_Temp: 2, Z1_Heat_Curve_Outside_Low_Temp: -13, Z1_Heat_Curve_Outside_High_Temp: 11, Z1_Heat_Curve_Target_Low_Temp: 29, Z1_Heat_Curve_Target_High_Temp: 37,
               TOP42_Z1_Water_Target_Temp: 34, compressor_frequency: 17, TOP6_Main_Outlet_Temp: 33, TOP5_Main_Inlet_Temp: 31, TOP16_Heat_Energy_Consumption: 350,
               OPT_hp: {Z1_Heat_Request_Temp: {v: 1, ts: NOW2}, Quiet_Mode_Level: {v: 3, ts: NOW2}}, OPT_weather: Wx, OPT_plan_in: PI};
    const fl = {}, files = {};
    class FD extends Date { constructor(...a) { if (a.length === 0) { super(NOW2); } else { super(...a); } } static now() { return NOW2; } }
    const ctx = st => ({get: (k, s) => (s === 'file' ? undefined : st[k]), set: (k, v) => { st[k] = v; }});
    const fsM = {readFileSync: p => { if (files[p]) { return files[p]; } const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }, writeFileSync: (p, x) => { files[p] = String(x); }, mkdirSync: () => {}, openSync: () => { throw new Error('ENOENT'); }, readSync: () => 0, closeSync: () => {}};
    const fn = vm.runInNewContext('(function(msg,global,flow,context,env,node,fs,Date,Buffer){' + NB('opt_engine').func + '\n})', {});
    let res = null, err = null;
    try { res = fn({topic: 'tick'}, ctx(g), ctx(fl), ctx({}), {get: () => undefined}, {send: () => {}, warn: m => { err = m; }, error: () => {}, status: () => {}}, fsM, FD, Buffer); } catch (e) { err = e.message; }
    const cz = g.OPT_cz_verlauf;
    check('Huelle opt_engine: rechnet wie bisher (7 Ausgaenge, OPT_engine gesetzt) und legt OPT_cz_verlauf ab (36 h voraus = 37 Stundenwerte aus Kurve Z1 + Verschiebung 1 K)', Array.isArray(res) && res.length === 7 && g.OPT_engine && g.OPT_engine.ts === NOW2 && cz && cz.ts === NOW2 && cz.zp.length === 37 && cz.quelle === 'kurve' && Math.abs(cz.zp[6][1] - direkt) < 0.006, err || JSON.stringify(cz && [cz.zp.length, cz.zp[6], cz.fehler]));
    const ts1 = cz.ts; fn({topic: 'tick'}, ctx(g), ctx(fl), ctx({}), {get: () => undefined}, {send: () => {}, warn: () => {}, error: () => {}, status: () => {}}, fsM, FD, Buffer);
    g.OPT_weather = {status: 'kaputt', fpts: 'x', f_ts: 'y'}; fl.eng.czv = 0;
    let err2 = null; try { fn({topic: 'tick'}, ctx(g), ctx(fl), ctx({}), {get: () => undefined}, {send: () => {}, warn: m => { err2 = m; }, error: () => {}, status: () => {}}, fsM, FD, Buffer); } catch (e) { err2 = e.message; }
    check('Huelle opt_engine: OPT_cz_verlauf hoechstens alle 5 min; kaputtes Wetter -> leerer Verlauf voraus, Maschine laeuft weiter', ts1 === NOW2 && g.OPT_cz_verlauf.zp.length === 0 && !err2 && g.OPT_engine.ts === NOW2, err2 || '');
}
console.log('');
console.log('ERGEBNIS wx_core_test: ' + ok + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);

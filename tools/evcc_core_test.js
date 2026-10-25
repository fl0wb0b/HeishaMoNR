#!/usr/bin/env node
// Pruefungen des evcc-Abgleichs (25.10.2026): reine Funktionen in tools/evcc_core.js. Echte evcc-Antwort (jq-Auszug von /api/state, evcc 0.318.1, 25.10.2026 18:57)
// in tools/fixtures/evcc_state_2510.json: Einheiten, kompakter Plan, Protokollzeile, Eingang fuer den Waermefahrplan; die taegliche Pruefung mit nachgebauten Daten
// (Zeitumstellung 25.10.: 100 Viertelstunden, doppelte 02:xx-Stunde im Minutenprotokoll).
// Usage: node tools/evcc_core_test.js
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const EVC = require('./evcc_core.js');
const MIN = 60000, Q = 900000, H = 3600000;
let ok = 0, fail = 0;
function check(name, cond, info) { if (cond) { ok++; console.log('OK   ' + name); } else { fail++; console.log('FAIL ' + name + (info !== undefined ? '  -> ' + info : '')); } }
const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'evcc_state_2510.json'), 'utf8'));
const NOW = Date.parse('2026-10-25T19:02:37+01:00');

// ---- Einheiten an den echten Zahlen
{
    const ts = RAW.evopt.req.time_series, dd = RAW.evopt.details.demandDetails, b = RAW.evopt.res.batteries[0], n = ts.dt.length;
    let maxD = 0; for (let i = 0; i < n; i++) { maxD = Math.max(maxD, Math.abs(dd.reduce((a, x) => a + x.values[i], 0) - ts.gt[i])); }
    check('Einheiten: gt = Haus + BWWP + Leisha je Schritt (Wh), 93 Schritte, erster angebrochen (136 s), dann 900 s', n === 93 && ts.dt[0] === 136 && ts.dt.slice(1).every(x => x === 900) && maxD < 0.01, maxD);
    check('Einheiten: Entladen je Schritt = gt (Wh, nicht W): der Akku deckt den Bedarf, solange keine PV da ist', Math.abs(b.discharging_power[1] - ts.gt[1]) < 0.5 && Math.abs(b.discharging_power[5] - ts.gt[5]) < 0.5, b.discharging_power[1] + ' / ' + ts.gt[1]);
    check('Einheiten: Ladestand Wh am Ende des Schritts (s_initial − Entladen/eta_d)', Math.abs(RAW.evopt.req.batteries[0].s_initial - b.discharging_power[0] / RAW.evopt.req.eta_d - b.state_of_charge[0]) < 1, b.state_of_charge[0]);
    check('Einheiten: Leisha 60 Wh je Viertelstunde = 240 W (evcc), Preis p_N 0,0003178 EUR/Wh = 31,78 ct/kWh', Math.round(dd[2].values[1]) === 60 && Math.abs(ts.p_N[1] * 1000 - 0.3178) < 1e-6, dd[2].values[1]);
}
// ---- kompakter Plan
const K = EVC.kompakt(RAW, NOW, {}), P = K.plan;
check('kompakt: Leisha ueber den Titel "Panasonic Leisha", BWWP als uebrige Heizung, Haus, PV, Preise EUR/kWh, Akku, Netz, Status', !K.fehler && P.n === 93 && P.leishaTitel === 'Panasonic Leisha' && P.leisha[1] === 60 && P.bwwp[1] === 24 && P.haus[1] === 274 &&
      P.preis[1] === 0.3178 && P.einsp[1] === 0.07 && P.kapWh === 45000 && P.sMinWh === 4500 && P.status === 'Optimal' && P.socPct === 40 && P.version === '0.318.1' && P.upd === Date.parse('2026-10-25T18:57:44.169+01:00'), JSON.stringify({l: P.leisha && P.leisha[1], b: P.bwwp && P.bwwp[1], upd: P.upd}));
check('kompakt: Zeitstempel ms, Schritt 1 = 19:00', P.zeit[1] === Date.parse('2026-10-25T19:00:00+01:00') && P.zeit[0] === Date.parse('2026-10-25T18:57:44+01:00'), P.zeit[1]);
check('kompakt: {result: ...} (aeltere API) wird ebenso gelesen', !EVC.kompakt({result: RAW}, NOW, {}).fehler, '');
check('kompakt: Fehlerfaelle -> {fehler} (keine Antwort, kein evopt, Zeitstempel fehlen, Zeitreihe zu kurz)', EVC.kompakt(null, NOW).fehler === 'keine Antwort' && /evopt fehlt/.test(EVC.kompakt({version: 'x'}, NOW).fehler) &&
      /Zeitstempel/.test(EVC.kompakt({evopt: {req: {time_series: {dt: [900]}}, details: {}}}, NOW).fehler) &&
      /unvollständig/.test(EVC.kompakt({evopt: {req: {time_series: {dt: [900, 900], gt: [1], ft: [1, 1]}}, details: {timestamp: ['2026-10-25T19:00:00+01:00', '2026-10-25T19:15:00+01:00']}}}, NOW).fehler), '');
check('kompakt: andere Heizungs-Bezeichnung per cfg.evcc.heizung; ohne Treffer und mehreren Heizungen keine Leisha-Reihe', EVC.kompakt(RAW, NOW, {evcc: {heizung: 'BWWP'}}).plan.leisha[1] === 24 && EVC.kompakt(RAW, NOW, {evcc: {heizung: 'gibt es nicht'}}).plan.leisha === null, '');
// ---- Protokollzeile
const Z = EVC.zeile(P), ZS = JSON.stringify(Z), PB = EVC.ausZeile(JSON.parse(ZS));
check('Protokollzeile: kompakt (< 4 KB), Sekunden, fester Einspeisepreis als eine Zahl (Netzpreis HT/NT 31,78/21,8 ct als Reihe), ohne gt; zurueckgelesen gleich', ZS.length < 4000 && Z.t === Math.round(NOW / 1000) && Z.einsp === 0.07 && Array.isArray(Z.preis) && Z.preis.indexOf(0.218) > 0 && Z.gesamt === undefined &&
      ['leisha', 'haus', 'bwwp', 'pv', 'laden', 'entladen', 'soc', 'bezug', 'einspeisung', 'preis', 'einsp'].every(k => JSON.stringify(PB[k]) === JSON.stringify(P[k])) && PB.zeit.every((t, i) => t === P.zeit[i]) && PB.upd === Math.round(P.upd / 1000) * 1000, ZS.length);
// ---- Eingang Waermefahrplan
const PI = EVC.planIn(P, {ts: NOW, ok: true}, NOW + MIN, {});
check('planIn: Akku-Minimum 6,54 kWh (14,5 %) um 07:00 (Ende des Schritts; evcc battery.forecast.lowest 14,52 % 07:00), keine Netzfenster, Leisha 24 h 4,7 kWh, PV in W', PI.da && PI.socMin.kwh === 6.54 && PI.socMin.pct === 14.5 &&
      EVC.hhmm(PI.socMin.t) === '07:00' && PI.bezug.length === 0 && PI.einsp.length === 0 && PI.leisha24Kwh === 4.72 && PI.pv.length === 93 && PI.pv.some(x => x[1] > 5000) && !PI.veraltet, JSON.stringify(PI.socMin) + ' ' + PI.leisha24Kwh);
check('Kennzahlenzeile: "Akku-Minimum 07:00 bei 6,5 kWh · Netzbezug geplant – · Einspeisung –"', PI.zeile.k === 'evcc-Plan' && PI.zeile.v === 'Akku-Minimum 07:00 bei 6,5 kWh · Netzbezug geplant – · Einspeisung –' && PI.zeile.c === '' && /nur Anzeige/.test(PI.zeile.t), PI.zeile.v);
{   // Netzfenster: Bezug 02:00–04:00 (je 500 Wh), Einspeisung ab 11:30 bis 14:00 mit Luecke (zwei Fenster), Schwelle 25 Wh
    const P2 = JSON.parse(JSON.stringify(P)), at = s => P2.zeit.findIndex(t => EVC.hhmm(t) === s && t > NOW);
    for (let i = at('02:00'); i < at('04:00'); i++) { P2.bezug[i] = 500; }
    P2.bezug[at('05:00')] = 20;
    for (let i = at('11:30'); i < at('13:00'); i++) { P2.einspeisung[i] = 800; }
    for (let i = at('13:15'); i < at('14:00'); i++) { P2.einspeisung[i] = 300; }
    const p2 = EVC.planIn(P2, {ts: NOW, ok: true}, NOW + MIN, {});
    check('planIn: Netzbezug 02:00–04:00 (4,0 kWh), 20 Wh um 05:00 unter der Schwelle; Einspeisung zwei Fenster ab 11:30', p2.bezug.length === 1 && EVC.hhmm(p2.bezug[0][0]) === '02:00' && EVC.hhmm(p2.bezug[0][1]) === '04:00' && p2.bezug[0][2] === 4 &&
          p2.einsp.length === 2 && EVC.hhmm(p2.einsp[0][0]) === '11:30' && p2.zeile.v === 'Akku-Minimum 07:00 bei 6,5 kWh · Netzbezug geplant 02:00–04:00 · Einspeisung ab 11:30', p2.zeile.v);
    const p3 = EVC.planIn(P2, {ts: NOW + 70 * MIN, ok: false, fehler: 'nicht erreichbar (ECONNREFUSED)'}, NOW + 75 * MIN, {});
    check('planIn: evcc nicht erreichbar -> letzter Stand mit Alter, nach 60 min "veraltet" (Bernstein), Fehler im Tooltip', p3.da && p3.veraltet && p3.alterMin === 75 && /veraltet \(75 min\)$/.test(p3.zeile.v) && p3.zeile.c === 'warn' && /letzter Abruf: nicht erreichbar/.test(p3.zeile.t), p3.zeile.v);
    const p4 = EVC.planIn(P2, {ts: NOW + 30 * MIN, ok: true}, NOW + 30 * MIN, {});
    check('planIn: vergangene Schritte zaehlen nicht (Minimum und Fenster ab jetzt)', p4.socMin.t > NOW + 30 * MIN && !p4.veraltet, '');
}
check('Kennzahlenzeile ohne Plan: "evcc: kein Plan" (Bernstein), mit Fehlergrund', (() => { const z = EVC.planIn(null, {ts: NOW, ok: false, fehler: 'HTTP 500'}, NOW, {}); return !z.da && z.zeile.k === 'evcc' && z.zeile.v === 'kein Plan (HTTP 500)' && z.zeile.c === 'warn'; })(), '');

// ---- taegliche Pruefung: 25.10.2026 (Ende der Sommerzeit, 25 h = 100 Viertelstunden)
const D0 = new Date(2026, 9, 25).getTime(), D1 = EVC.folgeTag(D0);
check('Tag mit Zeitumstellung: 25 h', (D1 - D0) / H === 25, (D1 - D0) / H);
function p2(x) { return (x < 10 ? '0' : '') + x; }
function stamp(t) { const d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
let csv = 'zeit,quiet_aktuell,zaehler_wp_w\n';
for (let t = D0 - H; t < D1 + H; t += MIN) { csv += stamp(t + 20000) + ',2,' + (t >= D0 + 10 * H && t < D0 + 10 * H + 15 * MIN ? 800 : 400) + '\n'; }   // 10:00–10:15 (Ortszeit 09:00 CET + 1 h Umstellung) 800 W
csv += 'zeit,quiet_aktuell,neu,zaehler_wp_w\n2026-10-25 23:50:00,1,1,\n';                                                                                  // neuer Kopf, leere Werte
const M = EVC.messViertel(csv, D0, D1);
const iDoppel = M.zeit.findIndex(t => t === D0 + 3 * H);                                                                                     // 02:00 CET (zweite 02-Stunde)
check('Messung: 100 Viertelstunden, jede mit 15 Minutenwerten, auch die doppelte 02-Stunde (Reihenfolge), 400 W = 100 Wh; 800 W-Viertelstunde = 200 Wh', M.nQ === 100 && M.n.every(x => x === 15) && M.wh[iDoppel] === 100 &&
      M.wh.filter(x => x === 200).length === 1 && M.wh.filter(x => x === 100).length === 99, JSON.stringify(M.n.filter(x => x !== 15)));
check('Messung: Viertelstunde mit weniger als 10 Minutenwerten bleibt leer; Datei ohne Spalte zaehler_wp_w -> leer', (() => { const c2 = csv.split('\n').filter((l, i) => !/^2026-10-25 05:0[0-9]/.test(l)).join('\n'); const m2 = EVC.messViertel(c2, D0, D1);
      return m2.wh.filter(x => x === null).length === 1 && EVC.messViertel('zeit,a\n2026-10-25 05:00:00,1\n', D0, D1).wh.every(x => x === null); })(), '');
// evcc-Schnappschuesse alle 15 min ab D0 − 8 h, je 92 volle Schritte (23 h); Leisha 60 Wh, der letzte vor Mitternacht (23:45) 50 Wh
function evPlan(ts, wh) { const z = [ts], d = [Math.round((Math.ceil(ts / Q) * Q - ts) / 1000) || 900]; let t = z[0] + d[0] * 1000; for (let i = 0; i < 92; i++) { z.push(t); d.push(900); t += Q; } return {ts: ts + 30000, upd: ts, n: z.length, zeit: z, dt: d, leisha: z.map(() => wh)}; }
const EV = []; for (let t = D0 - 8 * H + 7 * MIN; t < D1; t += Q) { EV.push(evPlan(t, Math.abs(t - (D0 - 8 * MIN)) < MIN ? 50 : 60)); }
// Modell: stuendliche Plan-Schnappschuesse (104 Slots, Strom 0,1 kWh je Slot = 400 W)
const MD = []; for (let t0 = D0 - 8 * H; t0 < D1; t0 += H) { const sl = []; for (let i = 0; i < 104; i++) { sl.push([(t0 + i * Q) / 1000, 7, i === 0 ? null : 0.1]); } MD.push({t0: t0, t: t0 + 20000, cols: ['t', 'at', 'strom'], slots: sl}); }
const T = EVC.tag({d0: D0, d1: D1, mess: M, evcc: EV, modell: MD, cfg: {}});
check('Tag: Messung 10,1 kWh (100 Viertelstunden)', T.tag === '2026-10-25' && T.nQ === 100 && T.mess.kwh === 10.1 && T.mess.n === 100, JSON.stringify(T.mess));
check('Tag: evcc 6 h = Schnappschuss ~6 h vorher (99 x 60 Wh + 1 x 50 Wh aus dem 23:52-Plan), alle 100 Viertelstunden', T.reihen.e6.n === 100 && T.reihen.e6.p === 5.99 && T.reihen.e6.m === 10.1, JSON.stringify(T.reihen.e6));
check('Tag: evcc Tag = letzter Plan vor Mitternacht (23:52, 50 Wh), reicht 23 h -> 92 von 100 Viertelstunden', T.reihen.eT.n === 92 && T.reihen.eT.p === 4.6 && EVC.hhmm(T.quellen.eT) === '23:52', JSON.stringify(T.reihen.eT));
check('Tag: Modell Tag = letzter Plan-Schnappschuss vor Mitternacht (23:00), Strom kWh -> Wh, 100 Viertelstunden; Modell 6 h ebenso (nur Datei)', T.reihen.mT.n === 100 && T.reihen.mT.p === 10 && T.reihen.m6.n === 100 && EVC.hhmm(T.quellen.mT) === '23:00', JSON.stringify(T.reihen.mT));
check('Tag: Viertelstunden in der Datei (Messung, e6, eT, mT, m6)', T.viertel.mess.length === 100 && T.viertel.eT.filter(x => x === null).length === 8 && T.viertel.e6[T.viertel.e6.indexOf(50)] === 50, '');
check('Tag: ohne Schnappschuesse vor Mitternacht (aelter als 6 h zaehlt nicht) -> evcc Tag leer', EVC.tag({d0: D0, d1: D1, mess: M, evcc: EV.filter(p => p.upd < D0 - 7 * H || p.upd >= D0), modell: [], cfg: {}}).reihen.eT.n === 0, '');

// ---- Uebersicht, Bewertung, Hinweis
const mk = (k, pr, n) => { const d0 = new Date(2026, 9, 25 - k).getTime(); return {tag: EVC.ymd(d0), d0: d0, nQ: 96, mess: {kwh: 8, n: 96}, reihen: {e6: {p: 8 * (1 + pr), m: 8, n: n === undefined ? 96 : n}, eT: {p: 8 * (1 + pr / 2), m: 8, n: 96}, mT: {p: 8.4, m: 8, n: 96}}}; };
const N26 = new Date(2026, 9, 26, 0, 15).getTime();
const U3 = EVC.uebersicht({tage: [mk(2, -0.4), mk(1, -0.38), mk(0, -0.36)]}, N26, {});
check('Uebersicht: drei Zeilen "evcc Leisha (6 h)", "evcc Leisha (Tag)", "Modell (Tag)" mit Prognose/Messung/Abw./7 Tage/Bewertung, Vortag 25.10.', U3.zeilen.length === 3 && U3.zeilen.map(z => z[0]).join('|') === 'evcc Leisha (6 h)|evcc Leisha (Tag)|Modell (Tag)' && U3.tag === '2026-10-25' &&
      U3.zeilen[0].slice(1, 7).join('|') === '5,1|8,0|−36 %|−38 % (3 T.)|Warnung|bad' && U3.zeilen[1].slice(5, 7).join('|') === 'Hinweis|warn' && U3.zeilen[2].slice(3, 7).join('|') === '+5 %|+5 % (3 T.)|ok|ok', JSON.stringify(U3.zeilen.map(z => z.slice(1, 7))));
check('Hinweis der Maschine: "evcc unterschätzt die Wärmepumpe um 38 % (7 Tage, 6 h Vorlauf …)" ab 3 Tagen und > 20 %', U3.hinweis && /^evcc unterschätzt die Wärmepumpe um 38 % \(7 Tage, 6 h Vorlauf, 3 Tage mit Daten\)/.test(U3.hinweis), U3.hinweis);
check('Hinweis: nur 2 Tage -> keiner; 15 % -> keiner; +25 % -> "überschätzt"', EVC.uebersicht({tage: [mk(1, -0.4), mk(0, -0.4)]}, N26, {}).hinweis === null && EVC.uebersicht({tage: [mk(2, -0.15), mk(1, -0.15), mk(0, -0.15)]}, N26, {}).hinweis === null &&
      /überschätzt die Wärmepumpe um 25 %/.test(EVC.uebersicht({tage: [mk(2, 0.25), mk(1, 0.25), mk(0, 0.25)]}, N26, {}).hinweis || ''), '');
check('Hinweis: ohne 6-h-Werte faellt er auf die Tagesprognose zurueck', /Tagesprognose/.test(EVC.uebersicht({tage: [mk(2, -0.8, 0), mk(1, -0.8, 0), mk(0, -0.8, 0)]}, N26, {}).hinweis || ''), '');
check('Bewertung nach dem mittleren Tagesfehler: +40 % und −40 % heben sich im Mittel auf (0 %), die Bewertung bleibt "Warnung"', (() => { const u = EVC.uebersicht({tage: [mk(1, 0.4), mk(0, -0.4)]}, N26, {}); return u.zeilen[0][4] === '0 % (2 T.)' && u.zeilen[0][5] === 'Warnung' && /mittlerer Tagesfehler 40 %/.test(u.zeilen[0][7]) && u.mittel.e6.fehler === 40; })(), '');
check('Bewertung: < 15 % ok, 15–30 % Hinweis (Bernstein), > 30 % Warnung (Rot), ohne Wert –', EVC.bewertung(14.9, EVC.STD)[0] === 'ok' && EVC.bewertung(-15, EVC.STD)[1] === 'warn' && EVC.bewertung(30, EVC.STD)[0] === 'Hinweis' && EVC.bewertung(-30.5, EVC.STD)[1] === 'bad' && EVC.bewertung(null, EVC.STD)[0] === '–', '');
check('Uebersicht: Tag mit zu wenig Viertelstunden (< 75 %) zaehlt nicht, Zeile zeigt "zu wenig (50 %)"', (() => { const u = EVC.uebersicht({tage: [mk(0, -0.4, 48)]}, N26, {}); return u.zeilen[0][3] === 'zu wenig (50 %)' && u.zeilen[0][4] === '–'; })(), '');
check('Uebersicht: aeltere Tage als 7 zaehlen nicht im Mittel; leere Datei -> Striche', (() => { const u = EVC.uebersicht({tage: [mk(9, 0.9), mk(0, -0.1)]}, N26, {}); const v = EVC.uebersicht({tage: []}, N26, {}); return u.zeilen[0][4] === '−10 % (1 T.)' && v.zeilen.every(z => z[1] === '–' && z[5] === '–'); })(), '');

console.log('\nERGEBNIS evcc_core_test: ' + ok + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);

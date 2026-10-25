#!/usr/bin/env node
// Vorschau-Daten des evcc-Abgleichs (25.10.2026) mit ECHTEN Daten: fuehrt die echten Knoten opt_evcc, opt_evcc_q, opt_energy und opt_plan aus der Flow-Datei mit einer
// Datei-Attrappe ueber einem Datenordner aus (nur lesen; geschrieben wird nur in den Speicher) und ersetzt in der Vorschau-Nutzlast (OPT_UI_DUMP von optimizer_sim.js)
// die Karten Prognoseguete (opt_t_fq), Energie & Preise (opt_t_en), Waermefahrplan (opt_t_plan, opt_t_plan_tab). Danach: node tools/opt_seiten_vorschau.js <flows> <aus_dump> <ausgabe>.
// Datenordner: quiet-YYYY-MM.csv, plan-snapshots-YYYY-MM.jsonl, plan-state.json, forecast-YYYY-MM.jsonl (letzte Zeile: Wetter/PV), forecast-quality.json,
// forecast-recent.json, actuals-hourly.json, optimizer-v2-YYYY-MM.csv (letzte Zeile: Anlagenwerte), optional globals.json (z. B. Heizkurve Z1_Heat_Curve_*) und
// evcc/s_<epoch>.json (rohe Antworten von /api/state, ganz oder jq-Auszug).
// --naeherung: NUR VORSCHAU/Bericht, als solche gekennzeichnet: das Leisha-Profil des juengsten evcc-Plans (evcc rechnet es aus dem Mittel der Vortage ohne Wetter) wird
// nach Uhrzeit auf die Vortage gelegt (alle 15 min ein nachgebauter Plan), damit die Pruefung schon Vergleichszahlen zeigt; live entstehen sie aus dem Protokoll.
// Usage: node tools/evcc_vorschau.js <flows.json> <ui_dump.json> <datenordner> <aus_dump.json> [--naeherung]
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EVC = require('./evcc_core.js');
const args = process.argv.slice(2), pos = args.filter(a => !a.startsWith('--')), NAEH = args.includes('--naeherung');
const [flowsFile, dumpFile, dataDir, outFile] = pos;
if (!outFile) { console.error('Usage: node tools/evcc_vorschau.js <flows.json> <ui_dump.json> <datenordner> <aus_dump.json> [--naeherung]'); process.exit(2); }
const MIN = 60000, Q = 900000, H = 3600000;
const flows = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), NB = {}; flows.forEach(n => { NB[n.id] = n; });
const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
const evDir = path.join(dataDir, 'evcc'), roh = fs.readdirSync(evDir).filter(f => /^s_\d+\.json$/.test(f)).sort().map(f => ({t: Number(f.slice(2, -5)) * 1000, j: JSON.parse(fs.readFileSync(path.join(evDir, f), 'utf8'))}));
if (!roh.length) { console.error('keine evcc-Antworten in ' + evDir); process.exit(2); }
let NOW = roh[roh.length - 1].t + 2 * MIN;
class FD extends Date { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
const VIRT = {}, G = {OPT_cfg: dump.cfg || {}}, FL = {};
const fsMock = {
    readFileSync: p => { const b = path.basename(p); if (VIRT[b] !== undefined) { return VIRT[b]; } const f = path.join(dataDir, b); if (!fs.existsSync(f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return fs.readFileSync(f, 'utf8'); },
    writeFileSync: (p, d) => { VIRT[path.basename(p)] = String(d); }, mkdirSync: () => {}, existsSync: p => VIRT[path.basename(p)] !== undefined || fs.existsSync(path.join(dataDir, path.basename(p)))};
const ctx = st => ({get: (k, s) => (s === 'file' ? undefined : st[k]), set: (k, v) => { st[k] = v; }});
function run(id, msg) {
    const f = vm.runInNewContext('(function(msg,global,flow,context,env,node,fs,Date,Buffer){' + NB[id].func + '\n})', {});
    return f(msg, ctx(G), ctx(FL), ctx({}), {get: () => undefined}, {warn: m => console.log(id + ': ' + m), send: () => {}, status: () => {}, error: () => {}}, fsMock, FD, Buffer);
}
const p2 = x => (x < 10 ? '0' : '') + x, monat = t => { const d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1); };
// 1) evcc-Antworten durch opt_evcc (Protokollzeilen in der Attrappe)
let plan = '';
roh.forEach(r => { NOW = r.t; const o = run('opt_evcc', {statusCode: 200, payload: r.j}); plan += o.payload; });
console.log('evcc: ' + roh.length + ' Antworten, letzter Plan ' + new Date(G.OPT_evcc_plan.plan.upd).toLocaleString('de-DE') + ', Leisha 24 h ' + G.OPT_evcc_plan.plan.leisha.reduce((a, b) => a + b, 0) / 1000 + ' kWh');
if (NAEH) {                                                                          // Leisha-Profil nach Uhrzeit (Ortszeit) auf die 8 Tage davor legen
    const P = G.OPT_evcc_plan.plan, prof = {};
    P.zeit.forEach((t, i) => { if (P.dt[i] === 900) { const d = new Date(t); prof[p2(d.getHours()) + ':' + p2(d.getMinutes())] = P.leisha[i]; } });
    const wert = t => { const d = new Date(t); let k = p2(d.getHours()) + ':' + p2(d.getMinutes()); for (let j = 0; prof[k] === undefined && j < 96; j++) { const e = new Date(t - (j + 1) * Q); k = p2(e.getHours()) + ':' + p2(e.getMinutes()); } return prof[k]; };
    const h0 = EVC.tag0(roh[0].t), von = h0 - 8 * 24 * H - 8 * H; let syn = '', n = 0;
    for (let t = von + 7 * MIN; t < h0; t += Q) {
        const z0 = t, d = [Math.round((Math.ceil(z0 / Q) * Q - z0) / 1000)], lv = [Math.round(wert(z0) * d[0] / 900)];
        let tt = z0 + d[0] * 1000; for (let i = 0; i < 92; i++) { d.push(900); lv.push(wert(tt)); tt += Q; }
        syn += JSON.stringify({t: Math.round(t / 1000) + 20, upd: Math.round(t / 1000), zeit0: Math.round(z0 / 1000), dt: d, leisha: lv, naeherung: 1}) + '\n'; n++;
    }
    plan = syn + plan;
    console.log('NÄHERUNG (nur Vorschau): ' + n + ' nachgebaute evcc-Pläne mit dem Leisha-Profil vom ' + new Date(P.upd).toLocaleString('de-DE') + ' nach Uhrzeit');
}
VIRT['evcc-plan-' + monat(NOW) + '.jsonl'] = plan;
// 2) Pruefung: die letzten 7 abgeschlossenen Tage (Uhr = jetzt, Lauf "heute" noch offen)
delete FL.evq; const tq0 = process.hrtime.bigint(); run('opt_evcc_q', {}); console.log('opt_evcc_q: ' + (Number(process.hrtime.bigint() - tq0) / 1e6).toFixed(0) + ' ms (7 Tage)');
const QF = JSON.parse(VIRT['evcc-quality.json']);
QF.tage.forEach(d => console.log(d.tag + ': Messung ' + d.mess.kwh + ' kWh (' + d.mess.n + '/' + d.nQ + ') · ' + ['e6', 'eT', 'mT', 'm6'].map(k => k + ' ' + d.reihen[k].p + '/' + d.reihen[k].m + ' kWh n ' + d.reihen[k].n).join(' · ')));
console.log('Zeilen: ' + G.OPT_evcc_q.zeilen.map(z => z.slice(0, 6).join(' | ')).join('\n        ') + '\nHinweis: ' + G.OPT_evcc_q.hinweis);
// 3) opt_energy und opt_plan mit echten Prognosen (letzter Schnappschuss forecast-YYYY-MM.jsonl), Anlagenwerten (letzte Zeile optimizer-v2) und plan-state.json
const fcL = fs.readFileSync(path.join(dataDir, 'forecast-' + monat(NOW) + '.jsonl'), 'utf8').trim().split('\n').pop(), SN = JSON.parse(fcL);
G.OPT_weather = {status: 'OK', ts: NOW - 5 * MIN, f_ts: NOW - 5 * MIN, fpts: SN.owm, temp: SN.owm && SN.owm[0] ? SN.owm[0][1] : null};
const v2 = fs.readFileSync(path.join(dataDir, 'optimizer-v2-' + monat(NOW) + '.csv'), 'utf8').trim().split('\n'); let hd = null; v2.forEach(l => { if (l.indexOf('zeit,') === 0) { hd = l.split(','); } });
const lr = v2[v2.length - 1].split(','), V2 = {}; hd.forEach((h, i) => { V2[h] = lr[i]; });
G.TOP14_Outside_Temp = Number(V2.aussen_panasonic);
try { Object.assign(G, JSON.parse(fs.readFileSync(path.join(dataDir, 'globals.json'), 'utf8'))); } catch (e) { /* optional: weitere globale Werte, z. B. Heizkurve Z1_Heat_Curve_* (live per GET /context/global/<key> gelesen) */ }
 G.OPT_en = {vrm: {status: 'OK', ts: NOW - 10 * MIN, pv: (SN.pv || []).filter(x => (x[2] || 3600) === 3600).map(x => [x[0], x[1]])}};
VIRT['forecast-recent.json'] = fs.readFileSync(path.join(dataDir, 'forecast-recent.json'), 'utf8');
NOW = roh[roh.length - 1].t + 2 * MIN;
const eo = run('opt_energy', {});
const po = run('opt_plan', {});
const out = JSON.parse(JSON.stringify(dump));
out.msgs.opt_t_fq = {msg: eo[4]}; out.msgs.opt_t_en = {msg: eo[0]};
if (po && po[0]) { out.msgs.opt_t_plan = {msg: po[0]}; out.msgs.opt_t_plan_tab = {msg: po[0]}; }
console.log('Prognosegüte: ' + eo[4].payload.evTag + ' · ' + eo[4].payload.ev.length + ' evcc-Zeilen · Energie: ' + JSON.stringify(eo[0].payload.rows.find(r => r[0] === 'Daten evcc-Plan')));
console.log('Wärmefahrplan: ' + (po && po[0] ? JSON.stringify(po[0].payload.evcc) + ' · Status ' + (po[0].payload.rows[0] || []).join(' ') : 'keine Ausgabe'));
fs.writeFileSync(outFile, JSON.stringify(out));
console.log('geschrieben: ' + outFile);

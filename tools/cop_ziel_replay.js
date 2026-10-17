#!/usr/bin/env node
// Replay "COP: Ziel und Ist" (cop-ziel 17.10.2026) auf den echten Protokollen: Minutenmodell der Maschine (engine_core.copZielStep) Tag für Tag, Tabelle Ziel/Ist/Posten.
// Usage: node tools/cop_ziel_replay.js <datenordner> [--von JJJJ-MM-TT] [--bis JJJJ-MM-TT] [--eta start|auto|<cop_eta.json>] [--json datei]
//   start = Startwerte (cop_physik), auto = vorher mit tools/cop_eta.js auf denselben Daten kalibriert (wie der Container nachts), Datei = cop_eta.json
'use strict';
process.env.TZ = process.env.TZ || 'Europe/Berlin';
const fs = require('fs');
const E = require('./engine_core.js');
const K = require('./cop_eta.js');
const argv = process.argv.slice(2), dir = argv[0], a = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
if (!dir) { console.error('Usage: node tools/cop_ziel_replay.js <datenordner> [--von T] [--bis T] [--eta start|auto|datei] [--json datei]'); process.exit(2); }
const von = new Date((a('--von') || '2026-10-07') + 'T00:00:00').getTime(), bis = new Date((a('--bis') || '2026-10-17') + 'T00:00:00').getTime() + 24 * 3600000;
const M = K.lade(dir, von, bis), base = K.cfgAus(dir), etaArt = a('--eta') || 'auto';
let eta = null;
if (etaArt === 'auto') { eta = K.kalibriere(M, base); } else if (etaArt !== 'start') { eta = JSON.parse(fs.readFileSync(etaArt, 'utf8')); }
const cfg = E.mergeCfg({cop: base.cop, zaehler: base.zaehler, copZiel: eta || undefined}), S = {};
M.forEach(m => E.copZielStep(S, K.eingabe(m), cfg));
const de = (v, n) => v === null || v === undefined ? '–' : Number(v).toFixed(n).replace('.', ',').replace('-', '−');
const tage = Object.keys(S.cz.d).sort(), zeilen = [], P = E.CZ_POSTEN.map(x => x[0]);
const atT = {}; M.forEach(m => { const k = E.ymd(m.t); if (m.at !== null) { const x = atT[k] = atT[k] || [0, 0]; x[0] += m.at; x[1]++; } });
console.log('Minuten ' + M.length + ' · Eta ' + etaArt + (eta ? ' (' + Object.keys(eta.eta).map(b => b + ' ' + de(eta.eta[b].v, 3)).join(' / ') + '; dT ' + Object.keys(eta.dTverd).map(b => de(eta.dTverd[b].v, 1)).join('/') + ')' : '') + ' · Strom ' + cfg.zaehler.quelle + ' +' + E.copKw(cfg) + ' W');
console.log('');
console.log('| Tag | Ø AT | Lauf min | Starts | Strom kWh | Wärme kWh | COP Ist | COP Ziel | unter Ziel | ' + E.CZ_POSTEN.map(x => x[1] + ' kWh').join(' | ') + ' | Rest % | Rest Sonne % |');
console.log('|' + Array(11 + P.length).fill('---').join('|') + '|');
const sum = [];
tage.forEach(k => {
    const A = E.czAgg([S.cz.d[k]], true), at = atT[k] ? atT[k][0] / atT[k][1] : null; sum.push(S.cz.d[k]);
    const pk = id => (A.posten.filter(x => x.id === id)[0] || {}).kwh;
    zeilen.push({tag: k, at: at, A: A});
    console.log('| ' + k.slice(8, 10) + '.' + k.slice(5, 7) + '. | ' + de(at, 1) + ' | ' + A.lauf + ' | ' + A.starts + ' | ' + de(A.e, 2) + ' | ' + de(A.q, 2) + ' | ' + de(A.cist, 2) + ' | ' + de(A.cz, 2) + ' | ' + de(A.diff, 1) + ' % | ' +
                P.map(id => de(pk(id), 2)).join(' | ') + ' | ' + de(A.rest, 1) + ' | ' + (A.sonne.min ? de(A.sonne.rest, 1) + ' (' + A.sonne.min + ' min)' : '–') + ' |');
});
const G = E.czAgg(sum, true), pg = id => (G.posten.filter(x => x.id === id)[0] || {}).kwh;
console.log('| **gesamt** | | ' + G.lauf + ' | ' + G.starts + ' | ' + de(G.e, 2) + ' | ' + de(G.q, 2) + ' | ' + de(G.cist, 2) + ' | ' + de(G.cz, 2) + ' | ' + de(G.diff, 1) + ' % | ' + P.map(id => de(pg(id), 2)).join(' | ') + ' | ' + de(G.rest, 1) + ' | ' +
            (G.sonne.min ? de(G.sonne.rest, 1) + ' (' + G.sonne.min + ' min)' : '–') + ' |');
console.log('');
console.log('Rest ohne Sonne: ' + de(G.ohneSonne.rest, 1) + ' % (' + G.ohneSonne.min + ' min) · mit Sonne ' + de(G.sonne.rest, 1) + ' % (' + G.sonne.min + ' min) · Vorlauf über Soll ' + de(G.vlPlus, 2) + ' kWh, unter Soll ' + de(G.vlMinus, 2) + ' kWh · Abtauen Ist ' + de(G.abIst, 2) + ' kWh, erwartet ' + de(G.abErw, 2) + ' kWh · Minuten ' + JSON.stringify(G.min));
if (a('--json')) { fs.writeFileSync(a('--json'), JSON.stringify({eta: eta, tage: zeilen, gesamt: G}, null, 1)); }

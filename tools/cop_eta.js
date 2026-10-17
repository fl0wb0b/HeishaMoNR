#!/usr/bin/env node
// Nächtliche Nachkalibrierung des Ziel-COP (cop-ziel 17.10.2026): Gütegrad eta, Annäherung dT_verd (Rohr außen) und Spreizung je Außenband, Frequenzfaktor je Hz-Bereich,
// Abtau-Anteil (sobald Abtauungen im Fenster liegen) – alles mit dem Minutenmodell der Maschine (tools/engine_core.js: copZielStep, carnot, czParam), also derselben Formel
// wie live. Liest nur die Monatsprotokolle (quiet-*.csv Minuten, energy-*.csv PV, optimizer-v2-*.csv Feuchte, defrost-*.csv, config.json), schreibt nur cop_eta.json.
//   node tools/cop_eta.js --daten DIR --ergebnis DIR [--tag JJJJ-MM-TT] [--tage 21]      -> <ergebnis>/training/cop_eta.json (Container optimizer-tools, Schritt "cop_eta")
//   require('./cop_eta.js').lade(dir, von, bis) / .kalibriere(minuten, cfg) / .cfgAus(dir)  (tools/cop_ziel_replay.js, tools/cop_ziel_sim.js)
'use strict';
process.env.TZ = process.env.TZ || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const E = require('./engine_core.js');
const MIN = 60000;
const FORMAT = 1;
const SP = {hz: 'verdichter_hz', vl: 'ist_vl', rl: 'ist_rl', soll: 'soll_vl', at: 'aussen', pel: 'leistung_el_w', pth: 'leistung_th_heisha_w', defrost: 'defrost', dhw: 'warmwasser',
            heater: 'heizstab_intern', pipe: 'rohr_aussen', zw: 'zaehler_wp_w', zh: 'zaehler_heizstab_w', q: 'quiet_aktuell', hc: 'heizregelung'};
const KAL = {laufMin: 25, refHz: 17.5, dTminN: 60, etaMinN: 60, abtauMinN: 5};

function zeitOf(s) { const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : null; }
function num(v) { if (v === null || v === undefined || v === '') { return null; } const n = Number(v); return isFinite(n) ? n : null; }
function monate(von, bis) { const o = []; const d = new Date(von); d.setDate(1); while (d.getTime() <= bis) { o.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); d.setMonth(d.getMonth() + 1); } return o; }
// CSV mit wechselnden Kopfzeilen (Konvention "nur anhaengen"), Spalten nach Namen; f(zeile als Objekt der gewuenschten Spalten, t)
function leseCsv(datei, spalten, f) {
    if (!fs.existsSync(datei)) { return 0; }
    let H = null, n = 0;
    for (const l of fs.readFileSync(datei, 'utf8').split('\n')) {
        if (!l) { continue; }
        if (l.startsWith('zeit,')) { const h = l.split(','); H = {n: h.length, idx: {}}; Object.keys(spalten).forEach(k => { H.idx[k] = h.indexOf(spalten[k]); }); continue; }
        if (!H) { continue; }
        const p = l.split(','); if (p.length !== H.n) { continue; }
        const t = zeitOf(p[0]); if (t === null) { continue; }
        const o = {}; Object.keys(spalten).forEach(k => { const j = H.idx[k]; o[k] = j >= 0 ? num(p[j]) : null; });
        f(o, t); n++;
    }
    return n;
}
// Minuten [von, bis) mit PV (energy, hoechstens 10 min alt) und Feuchte (optimizer-v2, hoechstens 60 min alt)
function lade(dir, von, bis) {
    const M = [], pv = [], rh = [];
    monate(von, bis).forEach(mo => {
        leseCsv(path.join(dir, 'quiet-' + mo + '.csv'), SP, (o, t) => { if (t >= von && t < bis) { o.t = t; M.push(o); } });
        leseCsv(path.join(dir, 'energy-' + mo + '.csv'), {pv: 'pv_w'}, (o, t) => { if (o.pv !== null) { pv.push([t, o.pv]); } });
        leseCsv(path.join(dir, 'optimizer-v2-' + mo + '.csv'), {rh: 'wetter_feuchte'}, (o, t) => { if (o.rh !== null) { rh.push([t, o.rh]); } });
    });
    M.sort((a, b) => a.t - b.t); pv.sort((a, b) => a[0] - b[0]); rh.sort((a, b) => a[0] - b[0]);
    let ip = 0, ir = 0;
    M.forEach((m, i) => {
        while (ip + 1 < pv.length && pv[ip + 1][0] <= m.t) { ip++; }
        while (ir + 1 < rh.length && rh[ir + 1][0] <= m.t) { ir++; }
        m.pvW = pv.length && pv[ip][0] <= m.t && m.t - pv[ip][0] <= 10 * MIN ? pv[ip][1] : null;
        m.rhP = rh.length && rh[ir][0] <= m.t && m.t - rh[ir][0] <= 60 * MIN ? rh[ir][1] : null;
        m.hpAge = 0;                                                                // jede Zeile ist eine frische Minute (Luecken buchen nichts)
    });
    return M;
}
function eingabe(m) { return {t: m.t, hz: m.hz, vl: m.vl, rl: m.rl, soll: m.soll, at: m.at, pel: m.pel, pth: m.pth, defrost: m.defrost, dhw: m.dhw, heater: m.heater, rh: m.rhP, pv: m.pvW, zw: m.zw, zAge: m.zw !== null ? 0 : null, hpAge: m.hpAge}; }
function cfgAus(dir) {                                                         // nur cop.pelKorrW und zaehler.quelle aus config.json (Datei des Nutzers, keine Geheimnisse)
    let c = {}; try { c = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) || {}; } catch (e) { c = {}; }
    return E.mergeCfg({cop: c.cop || {}, zaehler: c.zaehler || {}});
}
function median(a) { if (!a.length) { return null; } const v = a.slice().sort((x, y) => x - y), i = Math.floor(v.length / 2); return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; }
function rd(v, n) { return v === null || v === undefined || !isFinite(v) ? null : Math.round(v * Math.pow(10, n)) / Math.pow(10, n); }
// Kalibrierung auf den Minuten (Fenster): Startwerte -> Minutenmodell (Art, Laufminute, Sonne) -> eta/dT/Spreizung am Minimum -> Frequenzfaktor -> Abtau-Anteil
function kalibriere(M, cfg, extra) {
    cfg = cfg || E.mergeCfg({});
    const S = {}, Z = [], P0 = E.czParam(cfg);
    M.forEach(m => { const x = eingabe(m), r = E.copZielStep(S, x, cfg), z = S.cz; Z.push({m: m, r: r, lm: z.t0 && z.on ? (m.t - z.t0) / MIN : null}); });
    const band = {}; E.KF.baender.forEach(b => { band[b[2]] = {ref: [], dT: [], spr: []}; });
    const ruhig = Z.filter(z => z.r.art === 'normal' && z.lm !== null && z.lm >= KAL.laufMin && z.r.sonneK === 0 && z.r.q > 0 && z.r.e > 0);
    ruhig.forEach(z => { if (z.m.hz <= KAL.refHz) { const B = band[z.r.band]; B.ref.push(z); if (z.m.pipe !== null && z.m.pipe > -60) { B.dT.push(z.m.at - z.m.pipe); } if (z.m.rl !== null) { B.spr.push(z.m.vl - z.m.rl); } } });
    const out = {format: FORMAT, erstellt: E.iso(Date.now()).slice(0, 16), eta: {}, dTverd: {}, sprRef: {}, freq: {}, abtau: null, quelle: cfg.zaehler.quelle, korrW: P0.kw, minuten: M.length,
                 kalibrierminuten: 0, sonne: null, herkunft: 'cop_eta.js: Minutenmodell engine_core (copZielStep), Lauf ≥ ' + KAL.laufMin + ' min, ohne Sonne, 16–17 Hz für eta/dT/Spreizung'};
    const P = {eta: {}, dT: {}, spr: {}};
    Object.keys(band).forEach(b => {
        const B = band[b], n = B.ref.length;
        const dT = B.dT.length >= KAL.dTminN ? median(B.dT) : E.CZ.dTverd, spr = B.spr.length >= KAL.etaMinN ? B.spr.reduce((a, x) => a + x, 0) / B.spr.length : E.CZ.sprRef;
        let qs = 0, ms = 0;
        B.ref.forEach(z => { const fs0 = z.m.rl !== null ? Math.max(0.8, Math.min(1.2, 1 + E.CZ.sprJeK * ((z.m.vl - z.m.rl) - spr))) : 1; qs += z.r.q; ms += z.r.e * E.carnot(z.m.vl, z.m.at, dT, E.CZ.kondK) * fs0; });
        if (n >= KAL.etaMinN && ms > 0) {
            P.eta[b] = qs / ms; P.dT[b] = dT; P.spr[b] = spr;
            out.eta[b] = {v: rd(qs / ms, 3), n: n}; out.dTverd[b] = {v: rd(dT, 2), n: B.dT.length, quelle: B.dT.length >= KAL.dTminN ? 'Rohr außen (Median)' : 'Standard 4,5 K'}; out.sprRef[b] = {v: rd(spr, 2), n: B.spr.length};
            out.kalibrierminuten += n;
        } else { out.eta[b] = {v: null, n: n, grund: 'weniger als ' + KAL.etaMinN + ' Minuten'}; }
    });
    // Frequenzfaktor je Bereich: gemessener COP / Modell (eta x Carnot(Ist-Vorlauf) x Spreizung), relativ zu 16–17 Hz; ab freqMinN Minuten, hoechstens 1
    const fb = {};
    ruhig.forEach(z => {
        const b = z.r.band; if (!P.eta[b]) { return; }
        const k = E.CZ.hzBins.filter(x => z.m.hz <= x[1] + 0.5)[0] || E.CZ.hzBins[E.CZ.hzBins.length - 1], key = k[0] + '-' + k[1];
        const fs0 = z.m.rl !== null ? Math.max(0.8, Math.min(1.2, 1 + E.CZ.sprJeK * ((z.m.vl - z.m.rl) - P.spr[b]))) : 1;
        const x = fb[key] = fb[key] || [0, 0, 0]; x[0] += z.r.q; x[1] += z.r.e * P.eta[b] * E.carnot(z.m.vl, z.m.at, P.dT[b], E.CZ.kondK) * fs0; x[2]++;
    });
    const ref = fb['16-17'] && fb['16-17'][1] > 0 ? fb['16-17'][0] / fb['16-17'][1] : 1;
    E.CZ.hzBins.forEach(k => {
        const key = k[0] + '-' + k[1], x = fb[key]; if (key === '16-17') { return; }
        const roh = x && x[1] > 0 ? x[0] / x[1] / ref : null, n = x ? x[2] : 0;
        out.freq[key] = n >= E.CZ.freqMinN && roh !== null ? {v: rd(Math.max(E.CZ.freqMin, Math.min(1, roh)), 3), roh: rd(roh, 3), n: n, quelle: 'gemessen'} : {v: null, roh: rd(roh, 3), n: n, quelle: 'zu wenige Minuten: Annahme 1 − 1 %/Hz über 25 Hz'};
    });
    // Abtau-Anteil: Strom der Abtau- und Wiederaufheizminuten gegen die erwartete Abtauung des Modells (aMax linear), erst ab abtauMinN Abtauungen
    let nDf = 0, eAb = 0, basis = 0;
    Z.forEach((z, i) => {
        if (z.r.art === 'abtau' && (i === 0 || Z[i - 1].r.art !== 'abtau')) { nDf++; }
        if (z.r.art === 'abtau' || z.r.art === 'wieder') { eAb += z.r.e; }
        if (z.r.art === 'normal' && z.r.f && z.r.f.abtau < 1) { basis += z.r.ez * z.r.f.abtau * (1 - z.r.f.abtau) / P0.aMax; }
    });
    const df = (extra && extra.defrost) || null;
    out.abtau = {n: nDf, strom_kwh: rd(eAb / 1000, 2), basis_kwh: rd(basis / 1000, 2), aMax: nDf >= KAL.abtauMinN && basis > 0 ? rd(Math.max(0, Math.min(0.4, eAb / basis)), 3) : null,
                 quelle: nDf >= KAL.abtauMinN && basis > 0 ? 'kalibriert aus ' + nDf + ' Abtauungen' : 'Standard ' + String(P0.aMax).replace('.', ',') + ' (weniger als ' + KAL.abtauMinN + ' Abtauungen im Fenster)',
                 defrost_csv: df};
    // Pruefung der Sonne-Annahme: Rest (Modell gegen Messung) in Sonnenminuten gegen ohne Sonne, mit den neuen Werten
    const cfg2 = E.mergeCfg({cop: {pelKorrW: P0.kw}, zaehler: cfg.zaehler, copZiel: out}), S2 = {};
    M.forEach(m => E.copZielStep(S2, eingabe(m), cfg2));
    const A = E.czAgg(Object.keys(S2.cz.d).map(k => S2.cz.d[k]), true);
    out.sonne = {min: A.sonne.min, rest_prozent: A.sonne.rest, ohne_min: A.ohneSonne.min, ohne_rest_prozent: A.ohneSonne.rest};
    return out;
}
function defrostCsv(dir, von, bis) {                                         // Verlust je Abtauung laut defrost-*.csv (nur Bericht)
    let n = 0, kwh = 0;
    monate(von, bis).forEach(mo => leseCsv(path.join(dir, 'defrost-' + mo + '.csv'), {s: 'strom_kwh', n2: 'strom_nach_kwh'}, (o, t) => { if (t >= von && t < bis) { n++; kwh += (o.s || 0) + (o.n2 || 0); } }));
    return n ? {n: n, strom_je_abtauung_kwh: rd(kwh / n, 2)} : null;
}
function cli(argv) {
    const a = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
    const dir = a('--daten'), erg = a('--ergebnis'), aus = a('--aus'), tage = Number(a('--tage') || 21);
    if (!dir || (!erg && !aus)) { console.error('Usage: node tools/cop_eta.js --daten DIR --ergebnis DIR [--tag JJJJ-MM-TT] [--tage 21] [--aus datei]'); return 2; }
    const tag = a('--tag'), d0 = tag ? new Date(tag + 'T00:00:00') : new Date(); d0.setHours(0, 0, 0, 0);
    const bis = tag ? d0.getTime() + 24 * 60 * MIN : Date.now(), von = d0.getTime() - (tage - 1) * 24 * 60 * MIN;
    const M = lade(dir, von, bis);
    if (!M.length) { console.error('keine Minutenzeilen im Fenster'); return 1; }
    const o = kalibriere(M, cfgAus(dir), {defrost: defrostCsv(dir, von, bis)});
    o.tag = tag || E.ymd(Date.now()); o.fenster = {von: E.iso(von).slice(0, 10), bis: E.iso(bis - 1).slice(0, 10), tage: tage};
    const ziel = aus || path.join(erg, 'training', 'cop_eta.json');
    fs.mkdirSync(path.dirname(ziel), {recursive: true});
    fs.writeFileSync(ziel + '.tmp', JSON.stringify(o, null, 1) + '\n'); fs.renameSync(ziel + '.tmp', ziel);
    console.log('cop_eta: ' + M.length + ' Minuten, ' + o.kalibrierminuten + ' Kalibrierminuten · eta ' + Object.keys(o.eta).map(b => b + ' ' + (o.eta[b].v === null ? '–' : o.eta[b].v)).join(' / ') +
                ' · dT ' + Object.keys(o.dTverd).map(b => o.dTverd[b].v).join('/') + ' · Abtauungen ' + o.abtau.n + ' -> ' + ziel);
    return 0;
}
module.exports = {lade, kalibriere, cfgAus, eingabe, defrostCsv, leseCsv, KAL, FORMAT};
if (require.main === module) { process.exitCode = cli(process.argv.slice(2)); }

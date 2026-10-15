// Rueckblick Gebaeudemodell v3 (Entscheidung 2, 15.10.2026): Tageswaerme aus der Prognose von 00:00, gelernt nur aus den Vortagen, altes Modell (Waermefahrplan bis PLAN_VER 12:
// UA = (0,22 * 300 + Summe Q) / (300 + Summe Kh(15)), Bedarf = UA * max(0, 15 - T)) gegen das neue (UA * (T_innen - T) - Gewinne, langsame Anpassung, Tagesgang Fuehler - OWM).
// Rechnet mit den reinen Funktionen des Generators (Block REIN in tools/optimizer_phase1.py, opt_plan) auf den echten Protokollen; nur lesen.
// Daten: plan-actuals-YYYY-MM.csv (15-min-Ist, wie die Rueckrechnung live), forecast-YYYY-MM.jsonl (stuendliche OWM-Schnappschuesse mit Fuehlerwert),
// optimizer-v2-YYYY-MM.csv (nur Ersatz fuer Fuehler - OWM, solange plan-actuals noch keine OWM-Spalte hatte, vor 09.10. 13:00).
// Ohne Vertrauens-Schrumpfung der Prognose (wie tools/plan_algo.js); Tage mit Lern-Gate (Warmwasser, Abtauen, ...) und unter 30 Kh(15) lernen nicht mit (wie live).
// Usage: node tools/modell_v2_replay.js <Datenordner> [--md]
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const H = 3600000, DAY = 86400000, Q15 = 900000;

function rein() {                                                                    // reine Funktionen des Waermefahrplans aus dem Generator (eine Quelle)
    const src = fs.readFileSync(path.join(__dirname, 'optimizer_phase1.py'), 'utf8');
    const m = /\/\/ == REIN-BEGIN ==[\s\S]*?\/\/ == REIN-END ==/.exec(src);
    if (!m) { throw new Error('REIN-Block nicht gefunden'); }
    return new Function(m[0] + '\n; return {parseCsv, daysFromRows, fitModel, modellSchritt, tiZiel, tgProfil, d0Of, nz, lgFlags};')();
}
// Modellparameter wie live (PLAN-Standardwerte des Generators, opt_plan MP)
const MP = {ua0: 0.15, g0: 0.3, priorTage: 2, priorX: [10, 16], uaLo: 0.07, uaHi: 0.35, gLo: 0, gHi: 1.2, lernMinTage: 2, sW: 0.01, sS: 0.10, minDays: 10, minWindDays: 7, storeC: [0, 3, 6, 10],
            tiStd: 22, tiMin: 18, tiMax: 25, stepUaRel: 0.15, stepGainKw: 0.15, stepTiK: 0.5};
function de(x, k) { return x === null || x === undefined || !isFinite(x) ? '–' : Number(x).toFixed(k === undefined ? 1 : k).replace('.', ',').replace(/^-/, '−'); }
function pz(x, k) { return x === null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + de(x, k); }
function dm(t) { const d = new Date(t); return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.'; }
function readMultiV(file) {                                                          // optimizer-v2: Kopfzeilen "zeit,..." setzen den Kopf neu
    const out = []; let head = null;
    if (!fs.existsSync(file)) { return out; }
    fs.readFileSync(file, 'utf8').split('\n').forEach(l => {
        if (!l) { return; } const p = l.split(',');
        if (p[0] === 'zeit') { head = p; return; }
        if (!head || p.length !== head.length) { return; }
        const o = {}; head.forEach((h, i) => { o[h] = p[i]; });
        const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(p[0]); if (!m) { return; }
        o._t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime(); out.push(o);
    });
    return out;
}

function analyse(dir, monat) {
    monat = monat || '2026-10';
    const P = rein();
    ['plan-actuals-', 'forecast-'].forEach(f => { const fn = path.join(dir, f + monat + (f === 'forecast-' ? '.jsonl' : '.csv')); if (!fs.existsSync(fn)) { throw new Error('fehlt: ' + fn + ' (der Datensatz braucht plan-actuals und forecast, z. B. replay_data_1510)'); } });
    const rows = P.parseCsv(fs.readFileSync(path.join(dir, 'plan-actuals-' + monat + '.csv'), 'utf8'));
    const days = P.daysFromRows(rows, 15);
    const F = fs.readFileSync(path.join(dir, 'forecast-' + monat + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(x => x && Array.isArray(x.owm) && x.owm.length >= 2)
        .map(x => ({t: x.t * 1000, at: P.nz(x.at), pts: x.owm.map(o => [o[0], P.nz(o[1])]).filter(o => o[1] !== null).sort((a, b) => a[0] - b[0])})).sort((a, b) => a.t - b.t);
    // Tagesgang Fuehler - OWM: 15-min-Slots [Tag, Stunde, Fuehler - OWM]; plan-actuals (ist_aussen_owm), sonst Ersatz aus optimizer-v2 (aussen_panasonic, aussen_wetter)
    const tg = [], belegt = {};
    rows.forEach(r => { const at = P.nz(r.ist_aussen), ow = P.nz(r.ist_aussen_owm), st = r.slot_start; if (at !== null && ow !== null && st) { const d0 = P.d0Of(st.slice(0, 10)); tg.push([d0, Number(st.slice(11, 13)), at - ow]); belegt[st] = 1; } });
    const V = readMultiV(path.join(dir, 'optimizer-v2-' + monat + '.csv')), acc = {};
    V.forEach(v => { const at = P.nz(v.aussen_panasonic), ow = P.nz(v.aussen_wetter); if (at === null || ow === null) { return; } const s0 = Math.floor(v._t / Q15) * Q15, a = acc[s0] = acc[s0] || [0, 0]; a[0] += at - ow; a[1]++; });
    let nErsatz = 0;
    Object.keys(acc).forEach(k => { const t = Number(k), d = new Date(t), st = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        if (belegt[st]) { return; } const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); tg.push([d0, d.getHours(), acc[k][0] / acc[k][1]]); nErsatz++; });
    const fcAt = D => { let b = null; F.forEach(x => { if (x.t <= D + 5 * 60000) { b = x; } }); if (!b || D - b.t > 2 * H) { b = F.find(x => x.t >= D && x.t <= D + H) || b; } return b; };
    function owmAt(pts, u) { if (u <= pts[0][0]) { return pts[0][1]; } for (let i = 1; i < pts.length; i++) { if (pts[i][0] >= u) { return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (u - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); } } return pts[pts.length - 1][1]; }
    const lernTage = D => days.filter(d => d.d0 < D && d.n >= 1200 && d.kh >= 30 && !(d.flags > 0));
    const out = []; let mdl = null, mdlFrei = null;
    days.filter(d => d.n >= 1200).forEach(d => {
        const D = d.d0, fc = fcAt(D); if (!fc) { return; }
        const L = lernTage(D), vor = days.filter(x => x.d0 < D && x.n >= 1200);
        const sQ = L.reduce((a, x) => a + x.q, 0), sH = L.reduce((a, x) => a + x.kh, 0), uaAlt = (0.22 * 300 + sQ) / (300 + sH);   // alter Plan-Schaetzer
        const fm = P.fitModel(L, MP), prev = rows.filter(r => r.slot_start && P.d0Of(r.slot_start.slice(0, 10)) < D).slice(-4);
        let tiJetzt = null; prev.forEach(r => { const v = []; Object.keys(r).forEach(k => { if (k.indexOf('ist_raum_') === 0 && P.nz(r[k]) !== null) { v.push(P.nz(r[k])); } }); if (v.length) { tiJetzt = v.reduce((a, b) => a + b, 0) / v.length; } });
        const tz = P.tiZiel(vor, 3, tiJetzt, MP), ziel = {ua: fm.gelernt ? fm.ua : MP.ua0, g: fm.gelernt ? fm.g : MP.g0, ti: tz.ti, n: fm.n, gelernt: fm.gelernt, quelle: fm.gelernt ? 'gelernt aus ' + fm.n + ' Tagen' : 'Vorwert'};
        mdl = P.modellSchritt(mdl, ziel, D, MP); mdlFrei = ziel;
        const prof = P.tgProfil(tg, D, 3), b = u => prof ? prof[new Date(u).getHours()] : 0;
        const atNow = fc.at !== null ? fc.at : (tiJetzt !== null ? null : null), ow0 = owmAt(fc.pts, fc.t);
        const anA = atNow !== null ? Math.max(-5, Math.min(5, atNow - ow0)) : 0, anN = atNow !== null ? Math.max(-5, Math.min(5, atNow - ow0 - b(fc.t))) : 0;
        let qA = 0, qN = 0, qF = 0, qOhneTg = 0, taA = 0, taN = 0;
        for (let j = 0; j < 96; j++) {
            const u = D + j * Q15 + Q15 / 2, Lh = Math.max(0, (u - fc.t) / H), ow = owmAt(fc.pts, u);
            const tA = ow + anA * Math.exp(-Lh / 4), tN = ow + b(u) + anN * Math.exp(-Lh / 4);
            taA += tA / 96; taN += tN / 96;
            qA += uaAlt * Math.max(0, 15 - tA) * 0.25;
            qN += Math.max(0, mdl.ua * (mdl.ti - tN) - mdl.g) * 0.25;
            qF += Math.max(0, mdlFrei.ua * (mdlFrei.ti - tN) - mdlFrei.g) * 0.25;
            qOhneTg += Math.max(0, mdl.ua * (mdl.ti - tA) - mdl.g) * 0.25;
        }
        const taIst = (() => { let s = 0, n = 0; rows.forEach(r => { const st = r.slot_start; if (st && P.d0Of(st.slice(0, 10)) === D && P.nz(r.ist_aussen) !== null) { s += P.nz(r.ist_aussen); n++; } }); return n ? s / n : null; })();
        out.push({tag: dm(D), d0: D, ist: d.q, n: d.n, taIst: taIst, taAlt: taA, taNeu: taN, tg: !!prof, fcT: fc.t, alt: qA, uaAlt: uaAlt, neu: qN, ua: mdl.ua, g: mdl.g, ti: mdl.ti, bil: mdl.ti - mdl.g / mdl.ua, gebremst: mdl.gebremst, quelle: mdl.quelle,
                  frei: qF, ohneTg: qOhneTg, nLern: L.length, maeBase: fm.maeBase, maeSun: fm.maeSun, gate: fm.gate ? fm.gate.ok : false, why: fm.gate ? fm.gate.why : [], lernt: L.some(x => x.d0 === D) ? 1 : 0});
    });
    return {tage: out, nErsatz: nErsatz, nFc: F.length, lernFinal: P.fitModel(lernTage(Infinity), MP)};
}

function markdown(A) {
    const L = [], mae = k => { const v = A.tage.filter(x => x.nLern >= 0); return v.length ? v.reduce((a, x) => a + Math.abs(x[k] - x.ist), 0) / v.length : null; };
    L.push('| Tag | AT Ist / Prognose alt / neu | Ist kWh th | altes Modell (tbal 15): UA, kWh (Fehler) | neues Modell: UA, Gewinne, T_innen, Bilanzpunkt | neu kWh (Fehler) | neu ohne Bremse | neu ohne Tagesgang | Lerntage | Gate: Fehler Grundmodell / mit Sonne |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    A.tage.forEach(x => L.push('| ' + x.tag + ' | ' + de(x.taIst) + ' / ' + de(x.taAlt) + ' / ' + de(x.taNeu) + (x.tg ? '' : ' (ohne Tagesgang)') + ' | ' + de(x.ist) + ' | ' + de(x.uaAlt * 1000, 0) + ' W/K, ' + de(x.alt) + ' (' + pz(x.alt - x.ist) + ') | ' +
        de(x.ua * 1000, 0) + ' W/K, ' + de(x.g, 2) + ' kW, ' + de(x.ti) + ' °C, ' + de(x.bil) + ' °C (' + x.quelle + (x.gebremst ? ', gebremst' : '') + ') | ' + de(x.neu) + ' (' + pz(x.neu - x.ist) + ') | ' + de(x.frei) + ' (' + pz(x.frei - x.ist) + ') | ' + de(x.ohneTg) + ' (' + pz(x.ohneTg - x.ist) + ') | ' + x.nLern + ' | ' +
        de(x.maeBase) + ' / ' + de(x.maeSun) + (x.gate ? ' (Gate offen)' : '') + ' |'));
    L.push('', 'Mittlerer Tagesfehler (Betrag, kWh Wärme, ' + A.tage.length + ' Tage): **altes Modell ' + de(mae('alt'), 1) + '**, **neues Modell ' + de(mae('neu'), 1) + '**, ohne Bremse ' + de(mae('frei'), 1) + ', ohne Tagesgang ' + de(mae('ohneTg'), 1) + '.');
    const v = A.tage.filter(x => x.nLern >= 2);
    if (v.length) { L.push('Nur Tage mit mindestens 2 Lerntagen (' + v.length + '): alt ' + de(v.reduce((a, x) => a + Math.abs(x.alt - x.ist), 0) / v.length) + ', neu ' + de(v.reduce((a, x) => a + Math.abs(x.neu - x.ist), 0) / v.length) + ' kWh.'); }
    const F = A.lernFinal; L.push('', 'Gelernt aus allen Lerntagen (' + F.n + '): UA ' + de(F.ua * 1000, 0) + ' W/K, Gewinne ' + de(F.g, 2) + ' kW; Fehler Grundmodell (Leave-one-day-out) ' + de(F.maeBase) + ' kWh, mit Sonne ' + de(F.maeSun) + ' kWh; Gate: ' + (F.gate ? (F.gate.ok ? 'offen' : F.gate.why.join(', ')) : '–') + '.');
    L.push('', '*Prognose von 00:00 (OWM-Schnappschuss aus forecast-*.jsonl, ' + A.nFc + ' Schnappschüsse, am Fühler verankert, Versatz klingt mit 4 h ab; neu zusätzlich Tagesgang Fühler − OWM aus 3 Vortagen, ' + A.nErsatz + ' Slots vor 09.10. 13:00 aus optimizer-v2 ersetzt), ohne Vertrauens-Schrumpfung. Ist = Wärme im Heizbetrieb aus plan-actuals.*');
    return L.join('\n');
}
module.exports = {analyse: analyse, markdown: markdown, MP: MP};
if (require.main === module) {
    const dir = process.argv[2]; if (!dir) { console.error('Usage: node tools/modell_v2_replay.js <Datenordner> [--md]'); process.exit(2); }
    const A = analyse(dir);
    if (process.argv.indexOf('--md') > 0) { console.log(markdown(A)); } else { console.log(JSON.stringify(A, null, 1)); }
}

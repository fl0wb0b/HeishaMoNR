// Entscheidungsmaschine (tools/engine_core.js, nur gelesen) geschlossen gegen den Anlagen-Zwilling (tools/wp_zwilling.js) mit Fake-Uhr.
// Je Szenario zwei Läufe: „Schatten“ (Vorschläge werden nur protokolliert, die Anlage bleibt auf Quiet/Heizregelung/Verschiebung des Ausgangs)
// und „sofort“ (jeder Befehlsvorschlag wird sofort per Klick übernommen: applyRequest/applyTick wie in engine_sim frostSim/hcFrost, Whitelist, 6 Befehle/Tag, Rückweg).
// Ausgabe je Szenario: kWh Strom (TOP16 + 80 W) und Heizstab, kWh Wärme, Starts, Läufe < 60 min, Komfortverletzungen je Raum, Abtauungen, Heizstab-Minuten,
// Vorschläge/Befehle je Regel. Das ist ein MODELL (Zwilling, im Winter aus Forum/Handbuch/Annahmen), keine Messung.
// Usage: node tools/engine_vs_zwilling.js <wp_params.json> [--szenario frost|abtau|mild|woche|alle] [--md Datei] [--json Datei] [--q 3] [--hc 1] [--set ua=0.141,hsFrei=0] [--regel heizregelung.heizstabVorrang=1]
//        node tools/engine_sim.js <flows.json> --zwilling <wp_params.json> [--szenario …]   (gleicher Ablauf; flows.json wird dort nur auf Existenz geprüft)
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const E = require('./engine_core.js');
const Z = require('./wp_zwilling.js');

const MIN = 60000;
// Raumbänder wie config.json (live 15.10.2026)
const RAEUME = [{id: 'ki_oben', name: 'Kinderzimmer oben', min: 22.5, max: 24}, {id: 'ki_unten', name: 'Kinderzimmer unten', min: 20, max: 22},
                {id: 'schlaf', name: 'Schlafzimmer', min: 20, max: 22}, {id: 'wohn', name: 'Wohnzimmer', min: 20, max: 23.5}];
const REGELN = ['quiet_freigabe', 'quiet_strecken', 'raum_offset', 'heizregelung'];

// ------------------------------------------------------------------ Szenarien (deterministisches Wetter je Minute: AT, Feuchte, PV)
// tag(d) → {mittel, amp, rh, pv}: Tagesgang AT = mittel + amp · sin(2π (h − 9) / 24) (kälteste Stunde ~03 Uhr), Feuchte nachts höher, PV als Sinusbogen 8–16 Uhr
const SZENARIEN = {
    mild: {name: 'mild (8…14 °C, Feuchte 75–90 %)', start: [2026, 9, 20], tage: 5, tag: () => ({mittel: 11, amp: 3, rh: 82, pv: 6})},
    frost: {name: 'Frost (−10…−2 °C, Feuchte 80–90 %)', start: [2026, 11, 14], tage: 5, tag: d => ({mittel: -6 - (d === 2 ? 1 : 0), amp: 4, rh: 85, pv: 3})},
    abtau: {name: 'Abtauwetter (−3…+2 °C, Feuchte 90–95 %)', start: [2026, 11, 7], tage: 5, tag: () => ({mittel: -0.5, amp: 2.5, rh: 93, pv: 1})},
    woche: {name: 'Woche (mild → Frost −10 °C → Tauwetter)', start: [2026, 11, 1], tage: 7, tag: d => [{mittel: 8, amp: 2, rh: 80, pv: 4}, {mittel: 5, amp: 3, rh: 85, pv: 3}, {mittel: -2, amp: 3, rh: 88, pv: 2},
        {mittel: -7, amp: 3, rh: 85, pv: 3}, {mittel: -7, amp: 3, rh: 82, pv: 3}, {mittel: 0, amp: 2, rh: 95, pv: 1}, {mittel: 5, amp: 2, rh: 88, pv: 2}][d]}
};
function wetter(sz, i) {
    const d = Math.floor(i / 1440), h = (i % 1440) / 60, w = sz.tag(Math.min(d, sz.tage - 1)), wn = sz.tag(Math.min(d + 1, sz.tage - 1));
    const f = h / 24, mittel = w.mittel + (wn.mittel - w.mittel) * Math.max(0, f - 0.75) / 0.25 * 0.5;           // gleitender Übergang am Abend
    const at = mittel + w.amp * Math.sin(2 * Math.PI * (h - 9) / 24);
    const rh = Math.min(98, w.rh + 6 * Math.cos(2 * Math.PI * (h - 4) / 24) - 3);
    const pv = h > 8 && h < 16 ? w.pv * Math.sin(Math.PI * (h - 8) / 8) : 0;
    return {at: Math.round(at * 10) / 10, rh: Math.round(rh), pv: Math.round(pv * 100) / 100};
}

// ------------------------------------------------------------------ Ein Lauf
function lauf(P, szName, modus, opts) {
    opts = opts || {};
    const sz = SZENARIEN[szName], t0 = new Date(sz.start[0], sz.start[1], sz.start[2], 0, 0).getTime(), N = sz.tage * 1440;
    const anl = {q: opts.q !== undefined ? opts.q : 3, hc: opts.hc !== undefined ? opts.hc : 1, sh: 0};
    const cfg = opts.cfg ? E.mergeCfg(opts.cfg) : E.defaults();                            // --regel regel.schwelle=wert (Winterpaket: Varianten der Maschine gegen denselben Zwilling)
    // Einschwingen: 1 Tag Zwilling allein mit dem Wetter des ersten Tages
    let ZS = Z.neu(P, {modus: 'pause', th: 21.3, tw: 28, raeume: {ki_oben: 23, ki_unten: 21.3, schlaf: 21, wohn: 22.5}});
    for (let i = 0; i < 1440; i++) { const w = wetter(sz, i % 1440); ZS = Z.schritt(ZS, {t: t0 - (1440 - i) * MIN, at: w.at, rh: w.rh, pv: w.pv, q: anl.q, hc: anl.hc, shift: 0}, P).S; }
    let S = null, A = E.newApply();
    const n0 = ZS.n.abtau;
    const L = {szenario: szName, modus: modus, tage: sz.tage, kwhEl: 0, kwhHs: 0, kwhTh: 0, starts: 0, kurz: 0, laufMin: 0, abtau: 0, hsMin: 0, hz28: 0, fehler: 0,
               unterMin: {}, khUnter: {}, ueberMax: {}, hausUnter20: 0, hausMittel: 0, vorschlaege: {}, befehle: [], atMin: 99, atMax: -99, laeufe: [], quietMin: [0, 0, 0, 0], comfortMin: 0,
               vStarts: 0, eStarts: 0, eLaeufe: 0, eKurz: 0, eKurzThermo: 0, taktMin: 0, starts3hMax: 0, takt24Max: 0, eAbtau: 0, eAbtPause: 0};   // abtau-starts: Takt-Sicht der Maschine
    const kc = cfg.rules.quiet_strecken;
    const taktBeleg = d => !!((d.takt && d.takt.takt) || (d.lastRunThermo && d.lastRunMin !== null && d.lastRunMin !== undefined && d.lastRunMin < kc.kurzerLaufMin && d.starts3h >= kc.starts3h));   // wie engine_core taktBeleg
    let hzVor = ZS.hz, lsVor = null, lpVor = null;
    RAEUME.forEach(r => { L.unterMin[r.id] = 0; L.khUnter[r.id] = 0; L.ueberMax[r.id] = 0; });
    let laufSeit = null;
    for (let i = 0; i < N; i++) {
        const t = t0 + i * MIN, w = wetter(sz, i);
        const r = Z.schritt(ZS, {t: t, at: w.at, rh: w.rh, pv: w.pv, q: anl.q, hc: anl.hc, shift: anl.sh}, P); ZS = r.S; const Aus = r.A;
        // Kennzahlen
        L.atMin = Math.min(L.atMin, w.at); L.atMax = Math.max(L.atMax, w.at);
        L.kwhEl += Aus.pelKorr / 60000; L.kwhHs += Aus.pelHs / 60000; L.kwhTh += Math.max(0, Aus.pth) / 60000;
        if (Aus.start) { L.starts++; laufSeit = i; }
        if (Aus.stopp && laufSeit !== null) { const d = i - laufSeit; L.laeufe.push(d); if (d < 60) { L.kurz++; } laufSeit = null; }
        if (Aus.modus === 'lauf' || Aus.modus === 'abtauen') { L.laufMin++; if (Aus.hz >= 28 && Aus.modus === 'lauf') { L.hz28++; } L.quietMin[anl.q]++; if (anl.hc === 0) { L.comfortMin++; } }
        if (Aus.hs) { L.hsMin++; }
        L.hausMittel += Aus.th / N; if (Aus.th < 20) { L.hausUnter20++; }
        RAEUME.forEach(rc => { const T = Aus.raeume[rc.id]; if (T < rc.min) { L.unterMin[rc.id]++; L.khUnter[rc.id] += (rc.min - T) / 60; } if (T > rc.max) { L.ueberMax[rc.id]++; } });
        // Maschine
        if (Aus.hz > 0 && !(hzVor > 0)) { L.vStarts++; } hzVor = Aus.hz;                    // Verdichterstarts wie der Zähler der Anlage (je Abtauung zwei)
        const inp = Z.zuEngine(Aus, RAEUME, P, {});
        try {
            const o = E.step(S, inp, cfg); S = o.S;
            if (i > 0 && S.lastStart !== lsVor) { L.eStarts++; } lsVor = S.lastStart;
            if (i > 0 && S.lastStop !== lpVor && S.lastStop) { const lr = S.runs[S.runs.length - 1]; L.eLaeufe++; if (lr && lr[1] < 60) { L.eKurz++; if (lr[2] === 1) { L.eKurzThermo++; } } } lpVor = S.lastStop;
            if (o.d) { if (taktBeleg(o.d)) { L.taktMin++; } L.starts3hMax = Math.max(L.starts3hMax, o.d.starts3h || 0); L.takt24Max = Math.max(L.takt24Max, (o.d.takt && o.d.takt.starts24h) || 0); if (o.d.abtPause) { L.eAbtPause++; } }
            if (Aus.hp.Defrosting_State === 1 && !(L._dfVor)) { L.eAbtau++; } L._dfVor = Aus.hp.Defrosting_State === 1;
            o.res.forEach(x => { if (x.neu) { L.vorschlaege[x.id] = (L.vorschlaege[x.id] || 0) + 1; } });
            if (modus === 'sofort') {
                const ctx = {now: t, enabled: true, knoten: true, rules: REGELN, eng: {ts: t, prop: o.prop, locks: o.locks, stoerung: o.stoerung}, cfg: cfg, endReason: o.ende, halten: o.halten};
                const pl = () => ({q: anl.q, shift: anl.sh, hc: anl.hc, hpAge: 0.4, block: 0, heatMode: 0, z1Sensor: 0});
                const setP = (m, art) => { const v = +m.payload; if (/Quiet/.test(m.topic)) { anl.q = v; } else if (/HeatingControl/.test(m.topic)) { anl.hc = v; } else { anl.sh = v; } L.befehle.push([E.iso(t).slice(5, 16), m.topic.split('/').pop(), v, art]); };
                if (o.prop && o.prop.art === 'befehl') { const rq = E.applyRequest(A, {topic: 'uebernehmen', payload: {id: o.prop.id, sum: o.prop.sum}}, Object.assign({}, ctx, {plant: pl()})); A = rq.A; rq.send.forEach(m => setP(m, 'Klick ' + o.prop.rule)); }
                const r2 = E.applyTick(A, Object.assign({}, ctx, {now: t + 15000, plant: pl()})); A = r2.A; r2.send.forEach(m => setP(m, 'Rückweg: ' + ((r2.log.find(l => l.aktion === 'rueckweg') || {}).grund || 'Wiederholung')));
            }
        } catch (e) { L.fehler++; if (L.fehler < 3) { console.error(e.stack); } }
    }
    L.abtau = ZS.n.abtau - n0;
    const rd = (x, k) => Math.round(x * Math.pow(10, k)) / Math.pow(10, k);
    L.kwhEl = rd(L.kwhEl, 2); L.kwhHs = rd(L.kwhHs, 2); L.kwhTh = rd(L.kwhTh, 1);
    L.kwhElGesamt = rd(L.kwhEl + L.kwhHs, 2); L.cop = rd(L.kwhTh / Math.max(0.01, L.kwhElGesamt), 2);
    L.laufMittel = L.laeufe.length ? Math.round(L.laeufe.reduce((s, x) => s + x, 0) / L.laeufe.length) : null;
    RAEUME.forEach(rc => { L.khUnter[rc.id] = rd(L.khUnter[rc.id], 1); }); L.hausMittel = rd(L.hausMittel, 2);
    L.endZustand = {q: anl.q, hc: anl.hc, shift: anl.sh}; delete L._dfVor;
    delete L.laeufe;
    return L;
}
function vergleich(P, szNamen, opts) { const out = []; szNamen.forEach(s => { out.push(lauf(P, s, 'schatten', opts)); out.push(lauf(P, s, 'sofort', opts)); }); return out; }

function markdown(R, meta) {
    const de = (x, k) => x === null || x === undefined ? '–' : Number(x).toFixed(k).replace('.', ',').replace(/^-/, '−');
    const T = ['| Szenario | Lauf | AT min…max | kWh el (+ Heizstab) | kWh th | COP | Starts | Läufe < 60 min | Ø Lauf | Abtauungen | Heizstab-min | min ≥ 28 Hz | Comfort-Laufmin | Hausmittel Ø (min < 20 °C) | Minuten unter Minimum (ki_oben/ki_unten/schlaf/wohn) | K·h unter Minimum | Vorschläge | Befehle |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
    R.forEach(L => T.push('| ' + SZENARIEN[L.szenario].name + ' | ' + L.modus + ' | ' + de(L.atMin, 1) + '…' + de(L.atMax, 1) + ' | ' + de(L.kwhEl, 1) + ' (+' + de(L.kwhHs, 1) + ') | ' + de(L.kwhTh, 0) + ' | ' + de(L.cop, 2) + ' | ' + L.starts + ' | ' + L.kurz + ' | ' + (L.laufMittel === null ? '–' : L.laufMittel + ' min') + ' | ' + L.abtau + ' | ' + L.hsMin + ' | ' + L.hz28 + ' | ' + L.comfortMin + ' | ' + de(L.hausMittel, 1) + ' °C (' + L.hausUnter20 + ') | ' +
        RAEUME.map(r => L.unterMin[r.id]).join('/') + ' | ' + de(RAEUME.reduce((s, r) => s + L.khUnter[r.id], 0), 1) + ' | ' + (Object.keys(L.vorschlaege).sort().map(k => k + ' ' + L.vorschlaege[k]).join(', ') || '–') + ' | ' + L.befehle.length + ' |'));
    T.push('', 'Takt-Sicht der Maschine (abtau-starts): Verdichterstarts wie der Zähler der Anlage gegen die Starts, die die Maschine zählt; Takt-Beleg = Bedingung von „Deckel/Laufzeit“.', '',
           '| Szenario | Lauf | Abtauungen | Verdichterstarts (Anlage) | Starts (Maschine) | Läufe beendet (Maschine) | davon < 60 min (über den Vorlauf) | min mit Takt-Beleg | max Starts in 3 h | max Starts in 24 h (Takt-Messung) | min Stillstand in der Abtauung |', '|---|---|---|---|---|---|---|---|---|---|---|');
    R.forEach(L => T.push('| ' + L.szenario + ' | ' + L.modus + ' | ' + L.abtau + ' | ' + L.vStarts + ' | ' + L.eStarts + ' | ' + L.eLaeufe + ' | ' + L.eKurz + ' (' + L.eKurzThermo + ') | ' + L.taktMin + ' | ' + L.starts3hMax + ' | ' + L.takt24Max + ' | ' + (L.eAbtPause === undefined ? '–' : L.eAbtPause) + ' |'));
    const B = R.filter(L => L.befehle.length).map(L => '- **' + L.szenario + '**: ' + L.befehle.slice(0, 14).map(b => b[0] + ' ' + b[1] + '=' + b[2] + ' (' + b[3] + ')').join('; ') + (L.befehle.length > 14 ? ' … (' + L.befehle.length + ')' : ''));
    return '_' + (meta || '') + '_\n\n' + T.join('\n') + '\n\n' + (B.length ? 'Befehle (sofort übernommen):\n\n' + B.join('\n') + '\n' : '');
}
function ladeParams(datei) { const R = JSON.parse(fs.readFileSync(datei, 'utf8')); return {P: Z.mitWerten(R.werte || R), meta: R.daten ? 'Zwilling aus ' + R.daten.ordner + ' (' + R.daten.von + ' bis ' + R.daten.bis + ')' : 'Zwilling ' + datei}; }
function cli(argv) {
    const zi = argv.indexOf('--zwilling'), pf = zi >= 0 ? argv[zi + 1] : argv.find(a => /\.json$/.test(a) && !/flows/i.test(a));
    if (!pf || !fs.existsSync(pf)) { console.error('Usage: node tools/engine_vs_zwilling.js <wp_params.json> [--szenario frost|abtau|mild|woche|alle] [--md Datei] [--json Datei]'); process.exitCode = 2; return null; }
    const arg = k => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[i + 1] : null; };
    const sz = arg('--szenario') || 'alle', namen = sz === 'alle' ? Object.keys(SZENARIEN) : sz.split(',');
    namen.forEach(n => { if (!SZENARIEN[n]) { throw new Error('unbekanntes Szenario ' + n + ' (frost, abtau, mild, woche, alle)'); } });
    const {P, meta} = ladeParams(pf), opts = {};
    if (argv.indexOf('--zwilling') > 0) { const fl = argv.find(a => !/^--/.test(a) && a !== pf && /\.json$/.test(a)); if (fl && !fs.existsSync(fl)) { console.error('Flow-Datei fehlt: ' + fl); process.exitCode = 2; return null; } }
    let gesetzt = '';
    if (arg('--set')) { arg('--set').split(',').forEach(kv => { const [k, v] = kv.split('='); if (!(k in P)) { throw new Error('unbekannter Parameter ' + k); } P[k] = JSON.parse(v); gesetzt += ', ' + k + ' = ' + v; }); }
    if (arg('--q') !== null) { opts.q = Number(arg('--q')); } if (arg('--hc') !== null) { opts.hc = Number(arg('--hc')); }
    if (arg('--regel')) { opts.cfg = {rules: {}}; arg('--regel').split(',').forEach(kv => { const [k, v] = kv.split('='), [r, sw] = k.split('.'); if (!E.RULE[r]) { throw new Error('unbekannte Regel ' + r); } (opts.cfg.rules[r] = opts.cfg.rules[r] || {})[sw] = Number(v); gesetzt += ', Maschine ' + k + ' = ' + v; }); }
    const R = vergleich(P, namen, opts);
    const md = markdown(R, meta + gesetzt + ', Ausgang Quiet ' + (opts.q !== undefined ? opts.q : 3) + ', Heizregelung ' + ((opts.hc !== undefined ? opts.hc : 1) === 1 ? 'Efficiency' : 'Comfort') + ', Maschine ' + E.VER);
    if (arg('--md')) { fs.writeFileSync(arg('--md'), md); }
    if (arg('--json')) { fs.writeFileSync(arg('--json'), JSON.stringify(R, null, 1) + '\n'); }
    console.log(md);
    return R;
}
module.exports = {SZENARIEN, RAEUME, wetter, lauf, vergleich, markdown, cli};
if (require.main === module) { cli(process.argv.slice(2)); }

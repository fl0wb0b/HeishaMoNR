// Statische Vorschau der Seite "Optimierer": spielt die echten Protokolle durch den Kern (Replay), baut die Karten-Daten mit ENGVIEW.build und
// zeichnet sie mit optEngUi in eine HTML-Datei, die das Dashboard nachbildet (Gruppen 18 Einheiten = 966 px breit, Kartentitel, grauer Grund).
// Usage: node tools/engine_ui_preview.js [Datenordner] [Ausgabe.html]
//   Schnappschuesse: A = 10.10. 08:38 (Quiet-Freigabe aktiv, Uebernahme gesperrt), B = Ende des Replays, C = wie B mit Hauptschalter AN,
//   aktiver Uebernahme und Warnung (nur Anzeige-Test, ausgedachte Uebernahme-Daten), D = 5 Tage Kaelte-Szenario mit Punkten (Spielzeug-Anlage)
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const E = require('./engine_core.js');
const VW = require('./engine_view.js');
const UI = require('./eng_ui.js');
const CH = require('./ui_chart.js');
const MIN = 60000;

function snapshots(dataDir) {
    const { replay } = require('./engine_replay.js');
    const V = {ep: [], open: {}}, out = {};
    const tA = new Date(2026, 9, 10, 8, 38).getTime();
    let last = null;
    const R = replay(dataDir, {keepRecs: false, onStep: (o, inp) => {
        VW.track(V, o.res, o.S.rules, inp.t);
        last = {t: inp.t, res: o.res, prop: o.prop, anl: {z: o.d.zustand, lauf: o.d.runMin, hz: o.d.hz, q: o.d.q, vlR: o.d.vlRueck}};
        if (inp.t === tA) { out.A = VW.build({now: inp.t, last: last, S: o.S, V: JSON.parse(JSON.stringify(V)), AP: {}, enabled: false}); }
    }});
    out.B = VW.build({now: last.t, last: last, S: R.S, V: V, AP: {}, enabled: false});
    const AP = {aktiv: {name: 'SetQuietMode', value: 0, von: 3, ts: last.t - 40 * MIN, bis: null, bestaetigt: true}, rules: ['quiet_freigabe'], alarm: null};
    out.C = VW.build({now: last.t, last: last, S: R.S, V: V, AP: AP, enabled: true});
    return out;
}
function coldScenario() {                                                         // 5 Tage kaelter werdend, Klick auf jeden Quiet-Vorschlag: Punkte, Wirkung, Episoden
    let S = null, P = {on: false, tw: 31, room: 22.3, q: 3, rt: 0, over: 0, under: 0};
    const V = {ep: [], open: {}}, start = new Date(2026, 9, 14).getTime(), cfg = E.defaults();
    let last = null, o = null;
    for (let i = 0; i < 5 * 1440; i++) {
        const t = start + i * MIN, h = (i % 1440) / 60, day = Math.floor(i / 1440), at = 4 + 4 * Math.sin(2 * Math.PI * (h - 9) / 24) - day * 1.5, atI = Math.round(at);
        const soll = Math.ceil(Math.max(29, 29 + 0.375 * (11 - atI))), spread = P.on ? 2.5 : 0, vl = Math.round((P.tw + spread / 2) * 4) / 4, rl = Math.round((P.tw - spread / 2) * 4) / 4;
        const hz = !P.on ? 0 : (P.q >= 1 ? 16 + (i % 2) : (soll - 3 - rl >= 2.5 ? 33 : 17)), pth = !P.on ? 0 : (hz >= 30 ? 5000 : 2100), qrad = 0.25 * (P.tw - P.room);
        P.tw += ((pth / 1000) - qrad) / 0.4 / 60; P.room += (qrad - 0.18 * (P.room - at) + 0.9) / 8 / 60;
        if (P.on) { P.rt++; if (vl >= soll + 3.25) { P.over++; } else { P.over = 0; } if (P.over >= 3) { P.on = false; P.rt = 0; } } else { if (vl <= soll - 3) { P.under++; } else { P.under = 0; } if (P.under >= 6) { P.on = true; P.under = 0; } }
        if (i % 1440 === 18 * 60) { P.q = 3; }                                       // abends stellt jemand Quiet 3 zurueck
        const x = {t: t, hpAge: 0.4, hz: hz, vl: vl, rl: rl, soll: soll, dT: 3, pel: hz >= 30 ? 830 : (P.on ? 300 : 15), pth: pth, flow: 13.5, pump: 1750, q: P.q, qPrio: 1, hc: 1, at: atI, defrost: 0, dhw: 0, ss: 0, rt: P.rt,
                   shift: 0, heatMode: 0, z1Sensor: 0, heaterI: 0, heaterE: 0, htrOnAT: 0, htrStartDelta: -3, heatOffAT: 12, sollKurve: soll, block: 0, otherQ: null, otherShift: null, kzRad: 1,
                   rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: Math.round(P.room * 10) / 10, age: 20, min: 22, max: 23.5, valid: true, active: true}], korr: {v: 0, code: 'alle im Band', distrib: false, lead: ''}};
        o = E.step(S, x, cfg); S = o.S; VW.track(V, o.res, S.rules, t);
        last = {t: t, res: o.res, prop: o.prop, anl: {z: o.d.zustand, lauf: o.d.runMin, hz: o.d.hz, q: o.d.q, vlR: o.d.vlRueck}};
        if (o.prop && o.prop.rule === 'quiet_freigabe' && t - o.prop.ts >= 3 * MIN) { P.q = 0; }
    }
    return VW.build({now: last.t, last: last, S: S, V: V, AP: {}, enabled: false});
}
function staticCard(kind, P) {                                                     // wie optEngUi.mount, aber ohne DOM: Diagramm direkt als SVG
    let h = UI.html(kind, P);
    if (kind === 'score' && P.series && P.series.length) { const spec = UI.chartSpec(P); h = h.replace('<div id="oe_chart" style="margin-bottom:8px"></div>', '<div id="oe_chart" style="margin-bottom:8px">' + CH.legend(spec) + CH.svg(spec, 940).svg + '</div>'); }
    return h;
}
const GROUPS = [['card', 'Entscheidungsmaschine'], ['rules', 'Regeln'], ['score', 'Punkte'], ['log', 'Entscheidungen']];
function page(snaps) {
    const css = '<style>body{margin:0;background:#eeeeee;font-family:Roboto,"Helvetica Neue",Arial,sans-serif}h1{font-size:15px;color:#37474f;margin:18px 14px 4px;font-weight:600}' +
        '.grp{width:966px;margin:8px 14px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25)}.grp>.hd{padding:8px 12px 4px;font-size:15px;color:#0094ce;font-weight:500}.grp>.bd{padding:4px 12px 12px}</style>';
    return '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Optimierer Vorschau</title>' + css + UI.css + '</head><body>' +
        Object.keys(snaps).map(k => '<h1>' + k + '</h1>' + GROUPS.map(g => '<div class="grp" data-g="' + g[0] + '"><div class="hd">' + g[1] + '</div><div class="bd">' + staticCard(g[0], snaps[k][g[0] === 'card' ? 'card' : g[0]]) + '</div></div>').join('')).join('') +
        '</body></html>';
}
module.exports = {snapshots: snapshots, coldScenario: coldScenario, staticCard: staticCard, page: page};
if (require.main === module) {
    const dataDir = process.argv[2] || path.join(__dirname, '..', '..', 'engine_brief', 'data');
    const outFile = process.argv[3] || path.join(__dirname, '..', '..', 'engine_work', 'optimierer_vorschau.html');
    const S = snapshots(dataDir);
    const snaps = {'A · 10.10. 08:38 (Replay, Quiet-Freigabe, Übernahme gesperrt)': S.A, 'B · 10.10. 13:24 (Replay-Ende)': S.B, 'C · wie B, Hauptschalter AN, Übernahme aktiv': S.C, 'D · 5 Tage kälter werdend (Spielzeug-Anlage, Klicks)': coldScenario()};
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    fs.writeFileSync(outFile, page(snaps));
    Object.keys(snaps).forEach(k => { const one = {}; one[k] = snaps[k]; fs.writeFileSync(outFile.replace(/\.html$/, '_' + k.charAt(0) + '.html'), page(one)); });   // je Schnappschuss eine Seite (Bildschirmfoto)
    console.log('geschrieben: ' + outFile);
}

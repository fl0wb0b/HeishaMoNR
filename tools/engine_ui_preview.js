// Statische Vorschau der Seite "Optimierer": spielt die echten Protokolle durch den Kern (Replay), baut die Karten-Daten mit ENGVIEW.build und
// zeichnet sie mit optEngUi in eine HTML-Datei, die das Dashboard nachbildet: Rastermasse wie ui_base (sx/sy 48, Abstaende 6), Gruppen GRUPPE_W Einheiten
// breit, Masonry (jede Gruppe an die hoechste freie Stelle, links zuerst), Karten mit fester Hoehe und innerem Scrollen wie ui_template, Einpassen wie FIT_JS.
// Ein Pruefskript in der Seite meldet inneres Scrollen, abgeschnittene Elemente, horizontales Scrollen der Seite und Ueberlappung der Gruppen
// (window.__pruef und Kopfzeile). Bilder und Pruefung je Breite: node tools/ui_vorschau_pruefen.js <seite.html> <ordner>.
// Usage: node tools/engine_ui_preview.js [Datenordner] [Ausgabe.html]
//   Schnappschuesse: A = 10.10. 08:38 (Quiet-Freigabe aktiv, Uebernahme gesperrt), B = Ende des Replays, C = wie B mit Hauptschalter AN,
//   aktiver Uebernahme und Warnung (nur Anzeige-Test, ausgedachte Uebernahme-Daten), D = 5 Tage Kaelte-Szenario mit Punkten (Spielzeug-Anlage),
//   E = wie A mit Hauptschalter AN, Sendeknoten aktiv und freigegebener Regel (Knopf "Übernehmen" aktiv)
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const E = require('./engine_core.js');
const VW = require('./engine_view.js');
const UI = require('./eng_ui.js');
const CH = require('./ui_chart.js');
const MIN = 60000;
const GRUPPE_W = 17;                                                              // wie ENG_W im Generator
// Gebaeudemodell/Lernstand des Waermefahrplans (OPT_plan) fuer die Vorschau: Werte wie im Bericht 13.10. (4 von 10 Tagen, Drift-CUSUM 3,8 von 4)
const PLAN_BSP = {model: {n: 4, minDays: 10, gate: false, why: ['weniger als 10 Tage', 'PV-Tage zu gleichfoermig'], aktiv: false},
                  lern: {heute: 0, heuteTxt: '', verw: 0, verwTxt: '', drift: {n: 2, up: 3.8, dn: 0, upAn: false, dnAn: false, h: 4}, rueckfall: null, rb: null}};

function snapshots(dataDir) {
    const { replay } = require('./engine_replay.js');
    const V = {ep: [], open: {}}, out = {};
    const tA = new Date(2026, 9, 10, 8, 38).getTime();
    let last = null;
    const R = replay(dataDir, {keepRecs: false, onStep: (o, inp) => {
        VW.track(V, o.res, o.S.rules, inp.t);
        last = {t: inp.t, res: o.res, prop: o.prop, anl: {z: o.d.zustand, lauf: o.d.runMin, hz: o.d.hz, q: o.d.q, vlR: o.d.vlRueck}};
        if (inp.t === tA) {
            out.A = VW.build({now: inp.t, last: last, S: JSON.parse(JSON.stringify(o.S)), V: JSON.parse(JSON.stringify(V)), AP: {}, enabled: false, plan: PLAN_BSP});
            out.E = VW.build({now: inp.t, last: last, S: JSON.parse(JSON.stringify(o.S)), V: JSON.parse(JSON.stringify(V)), AP: {rules: ['quiet_freigabe', 'quiet_strecken', 'raum_offset'], knoten: true, n: 0, day: E.ymd(inp.t)}, enabled: true, plan: PLAN_BSP});
        }
    }});
    out.B = VW.build({now: last.t, last: last, S: R.S, V: V, AP: {}, enabled: false, plan: PLAN_BSP});
    const AP = {aktiv: {name: 'SetQuietMode', value: 0, von: 3, ts: last.t - 40 * MIN, bis: null, bestaetigt: true, groesse: 'quiet', rule: 'quiet_freigabe'}, rules: ['quiet_freigabe', 'quiet_strecken', 'raum_offset'], alarm: null, n: 1, day: E.ymd(last.t), lastSend: last.t - 40 * MIN};
    out.C = VW.build({now: last.t, last: last, S: R.S, V: V, AP: AP, enabled: true, plan: PLAN_BSP});
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
    return VW.build({now: last.t, last: last, S: S, V: V, AP: {}, enabled: false, plan: null});
}
function staticCard(kind, P, w) {                                                  // wie optEngUi.mount, aber ohne DOM: Diagramm direkt als SVG (Breite des Karteninhalts)
    let h = UI.html(kind, P);
    if (kind === 'score' && P.series && P.series.length) { const spec = UI.chartSpec(P); h = h.replace('<div id="oe_chart" style="margin-bottom:10px"></div>', '<div id="oe_chart" style="margin-bottom:10px">' + CH.legend(spec) + CH.svg(spec, w || 880).svg + '</div>'); }
    return h;
}
// Gruppen der Seite in Generator-Reihenfolge: [Art, Titel, Starthoehe in Einheiten] (Starthoehen wie ENG_GROUPS in tools/optimizer_phase1.py)
const GROUPS = [['card', 'Aktueller Vorschlag', 4], ['rules', 'Regeln', 3], ['score', 'Punkte', 9], ['mess', 'Messwerte & Lernen', 10], ['log', 'Entscheidungen', 12]];
const PAD = 6;                                                                    // Innenabstand der Karte links/rechts (Dashboard: md-card padding 3px 6px, live vermessen 14.10.)
// Prueft im Browser: Masonry wie das Dashboard, Einpassen wie FIT_JS, dann Ueberlauf. Ergebnis in window.__pruef und in der Kopfzeile.
const CHECK_JS = `(function () {
var SX = 48, SY = 48, CX = 6, CY = 6, GX = 6, GY = 6, UNIT = SX + GX;
function masonry(box) {
    var W = box.clientWidth, cols = Math.max(1, Math.floor((W + GX) / UNIT)), hts = [], gs = box.querySelectorAll(':scope > .grp'), i, x, y;
    for (i = 0; i < cols; i++) { hts.push(0); }
    Array.prototype.forEach.call(gs, function (g) {
        var w = +g.getAttribute('data-w'), bx = 0, by = Infinity;
        for (x = 0; x + w <= Math.max(cols, w); x++) { y = 0; for (i = x; i < x + w; i++) { y = Math.max(y, hts[i] || 0); } if (y < by) { by = y; bx = x; } }
        g.style.left = (bx * UNIT) + 'px'; g.style.top = by + 'px';
        for (i = bx; i < bx + w; i++) { hts[i] = by + g.offsetHeight + GY; }
        g.setAttribute('data-pos', 'Spalte ' + (bx === 0 ? 1 : 1 + Math.round(bx / w)) + ' · y ' + by);
    });
    box.style.height = Math.max.apply(null, hts) + 'px';
}
function units(px) { return Math.max(1, Math.ceil((px + CY) / (SY + CY))); }
function hOf(u) { return u * SY + (u - 1) * CY; }
function need(card) { var last = card.querySelector('.optfit').lastElementChild; return last.getBoundingClientRect().bottom - card.getBoundingClientRect().top + card.scrollTop + 10; }
function run() {
    var res = {breite: document.documentElement.clientWidth, fehler: [], karten: [], spalten: 0};
    var boxes = document.querySelectorAll('.mas');
    Array.prototype.forEach.call(boxes, function (box) {
        Array.prototype.forEach.call(box.querySelectorAll('.crd'), function (c) { c.style.height = hOf(+c.getAttribute('data-u')) + 'px'; });
        masonry(box);
        Array.prototype.forEach.call(box.querySelectorAll('.crd'), function (c) {                        // Starthoehe reicht? (gilt, solange das Einpassen nicht gelaufen ist)
            var n = need(c); c.setAttribute('data-px', Math.round(n)); c.setAttribute('data-start', units(n) <= +c.getAttribute('data-u') ? 'reicht' : 'zu klein');
            c.setAttribute('data-need', units(n));
        });
        Array.prototype.forEach.call(box.querySelectorAll('.crd'), function (c) { c.style.height = hOf(+c.getAttribute('data-need')) + 'px'; });   // FIT_JS
        masonry(box); masonry(box);
        var gs = box.querySelectorAll(':scope > .grp'), cols = {};
        Array.prototype.forEach.call(gs, function (g) { cols[g.style.left] = 1; });
        res.spalten = Math.max(res.spalten, Object.keys(cols).length);
        Array.prototype.forEach.call(box.querySelectorAll('.crd'), function (c) {
            var k = c.getAttribute('data-k'), r = c.getBoundingClientRect(), g = c.closest('.grp');
            res.karten.push(box.getAttribute('data-s') + ':' + k + ' ' + c.getAttribute('data-need') + ' Einh. = ' + c.getAttribute('data-px') + ' px Inhalt (Start ' + c.getAttribute('data-u') + ', ' + c.getAttribute('data-start') + ') · ' + g.getAttribute('data-pos'));
            if (c.scrollHeight > c.clientHeight + 1) { res.fehler.push(k + ': inneres Scrollen senkrecht (' + c.scrollHeight + ' > ' + c.clientHeight + ')'); }
            if (c.scrollWidth > c.clientWidth + 1) { res.fehler.push(k + ': inneres Scrollen waagrecht (' + c.scrollWidth + ' > ' + c.clientWidth + ')'); }
            Array.prototype.forEach.call(c.querySelectorAll('*'), function (e) {
                var cs = getComputedStyle(e), q = e.getBoundingClientRect();
                if (q.width === 0 && q.height === 0) { return; }
                if ((cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden' || cs.overflowX === 'clip') && e.scrollWidth > e.clientWidth + 1 && e.tagName !== 'svg') { res.fehler.push(k + ': abgeschnitten <' + e.tagName.toLowerCase() + ' class="' + e.className + '"> "' + (e.textContent || '').slice(0, 40) + '"'); }
                if (q.right > r.right - ${PAD} + 1.5 && e.closest('.optfit')) { res.fehler.push(k + ': ragt rechts heraus <' + e.tagName.toLowerCase() + ' class="' + e.className + '"> um ' + Math.round(q.right - r.right + ${PAD}) + ' px'); }
            });
            Array.prototype.forEach.call(c.querySelectorAll('.oe-kpi,.oe-tile,.oe-mlc,.oe-prop,.oe-leer,.optp .tile'), function (bx) {          // nichts ragt aus seiner Kachel
                var br = bx.getBoundingClientRect();
                Array.prototype.forEach.call(bx.querySelectorAll('*'), function (e) { var q = e.getBoundingClientRect(); if ((q.width || q.height) && (q.right > br.right + 0.5 || q.left < br.left - 0.5)) { res.fehler.push(k + ': ragt aus der Kachel <' + e.tagName.toLowerCase() + ' class="' + e.className + '"> "' + (e.textContent || '').slice(0, 30) + '" um ' + Math.round(q.right - br.right) + ' px'); } });
            });
        });
        for (var i = 0; i < gs.length; i++) { for (var j = i + 1; j < gs.length; j++) { var a = gs[i].getBoundingClientRect(), b = gs[j].getBoundingClientRect(); if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) { res.fehler.push('Gruppen ueberlappen: ' + gs[i].getAttribute('data-g') + ' / ' + gs[j].getAttribute('data-g')); } } }
    });
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) { res.fehler.push('Seite scrollt waagrecht (' + document.documentElement.scrollWidth + ' > ' + document.documentElement.clientWidth + ')'); }
    window.__pruef = res;
    var pr = document.getElementById('pr');
    pr.textContent = 'Prüfung bei ' + res.breite + ' px Inhaltsbreite: ' + (res.fehler.length ? res.fehler.length + ' Fehler: ' + res.fehler.slice(0, 4).join(' | ') : 'kein inneres Scrollen, nichts abgeschnitten, kein waagrechtes Scrollen, keine Überlappung') + ' · Spalten: ' + res.spalten;
    pr.className = 'pr ' + (res.fehler.length ? 'f' : 'ok');
}
window.addEventListener('load', function () { setTimeout(run, 50); });
})();`;
function page(snaps, opt) {
    opt = opt || {};
    const W = opt.w || GRUPPE_W, gw = W * 48 + (W - 1) * 6, cw = gw - 2 * PAD;
    const css = '<style>html{overflow-y:scroll}body{margin:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif}' +
        '.tb{height:48px;background:#0094ce;color:#fff;font-size:20px;line-height:48px;padding:0 16px}.pr{font-size:12px;padding:4px 8px;font-family:monospace}.pr.ok{background:#e8f5e9;color:#1b5e20}.pr.f{background:#ffebee;color:#b71c1c}' +
        'h1{font-size:13px;color:#546e7a;margin:10px 0 4px;font-weight:600}.mas{position:relative;margin:0}' +
        '.grp{position:absolute;width:' + gw + 'px;background:#fff}.grp>.ttl{padding:10px 0 12px 12px;font-size:19.2px;font-weight:500;color:#1bbfff;line-height:32px}.crd{box-sizing:border-box;width:' + gw + 'px;padding:0 ' + PAD + 'px;overflow-y:auto;margin-bottom:6px}</style>';
    return '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Optimierer Vorschau</title>' + css + UI.css + '</head><body><div id="pr" class="pr">Prüfung läuft …</div><div class="tb">Optimierer</div>' +
        Object.keys(snaps).map(k => '<h1>' + k + '</h1><div class="mas" data-s="' + k.charAt(0) + '">' + GROUPS.map(g => '<div class="grp" data-g="' + g[0] + '" data-w="' + W + '"><div class="ttl">' + g[1] + '</div>' +
            '<div class="crd" data-k="' + g[0] + '" data-u="' + g[2] + '"><div class="optfit">' + staticCard(g[0], snaps[k][g[0]], cw) + '</div></div></div>').join('') + '</div>').join('') +
        '<script>' + CHECK_JS + '</script></body></html>';
}
module.exports = {snapshots: snapshots, coldScenario: coldScenario, staticCard: staticCard, page: page, GROUPS: GROUPS, PLAN_BSP: PLAN_BSP, GRUPPE_W: GRUPPE_W, CHECK_JS: CHECK_JS, PAD: PAD};
if (require.main === module) {
    const dataDir = process.argv[2] || path.join(__dirname, '..', '..', 'engine_brief', 'data');
    const outFile = process.argv[3] || path.join(__dirname, '..', '..', 'engine_work', 'optimierer_vorschau.html');
    const S = snapshots(dataDir);
    const snaps = {'A · 10.10. 08:38 (Replay, Quiet-Freigabe, Übernahme gesperrt)': S.A, 'B · Replay-Ende 12.10. (kein Vorschlag)': S.B, 'C · wie B, Hauptschalter AN, Übernahme aktiv': S.C, 'D · 5 Tage kälter werdend (Spielzeug-Anlage, Klicks)': coldScenario(), 'E · wie A, Hauptschalter AN, Sendeknoten aktiv, Regel frei': S.E};
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    fs.writeFileSync(outFile, page(snaps));
    Object.keys(snaps).forEach(k => { const one = {}; one[k] = snaps[k]; fs.writeFileSync(outFile.replace(/\.html$/, '_' + k.charAt(0) + '.html'), page(one)); });   // je Schnappschuss eine Seite (Bildschirmfoto)
    console.log('geschrieben: ' + outFile);
}

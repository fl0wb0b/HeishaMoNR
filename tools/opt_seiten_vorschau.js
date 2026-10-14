// Statische Vorschau der Seiten Übersicht (Anlagenschema, Modulkacheln + Kern-Gruppen als Platzhalter in live gemessener Höhe), Optimierung (Verläufe, Räume, Wärmefahrplan), Optimierer (Entscheidungsmaschine, Quiet-Messwerte) und Daten & Güte (seit 13.10.
// zusammengelegt): echte Vorlagen aus der Flow-Datei, Nachrichten aus der Simulation (OPT_UI_DUMP=<datei> node tools/optimizer_sim.js <flows.json>), Diagramm-Verläufe
// aus dem echten 5-Minuten-Protokoll (opt_hist auf optimizer-v2-YYYY-MM.csv), Karten der Maschine aus dem Replay der echten Protokolle (tools/engine_ui_preview.js:
// optimierer.html = Schnappschuss B ohne Vorschlag, optimierer_vorschlag.html = Schnappschuss A mit Vorschlag; ohne Datenordner bleiben diese Karten leer).
// Ein kleiner Angular-Ersatz (ng-repeat, ng-repeat-start/-end, ng-if, ng-class, ng-model, ng-bind-html, {{ }}) zeichnet die Karten, die Skripte der Vorlagen
// laufen mit einer Scope-Attrappe ($watch('msg') sofort). Masonry, Einpassen (FIT_JS) und Prüfung wie tools/engine_ui_preview.js (CHECK_JS): inneres Scrollen,
// abgeschnittene oder herausragende Elemente, waagrechtes Scrollen, überlappende Gruppen. Bilder und Prüfung je Breite: node tools/ui_vorschau_pruefen.js <ordner> <seite.html> ...
// Usage: node tools/opt_seiten_vorschau.js <flows.json> <ui_dump.json> <ausgabe-ordner> [Datenordner mit optimizer-v2-YYYY-MM.csv]
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PRE = require('./engine_ui_preview.js');
const [flowsFile, dumpFile, outDir, dataDir] = process.argv.slice(2);
if (!flowsFile || !dumpFile || !outDir) { console.error('Usage: node tools/opt_seiten_vorschau.js <flows.json> <ui_dump.json> <ausgabe-ordner> [datenordner]'); process.exit(2); }
const flows = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), NB = {};
flows.forEach(n => { NB[n.id] = n; });
const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
const MSG = {};
Object.keys(dump.msgs).forEach(k => { MSG[k] = dump.msgs[k].msg; });

// Diagramm-Verläufe aus dem echten Protokoll (falls vorhanden): opt_hist mit Datei-Attrappe und Uhr = letzter Protokolleintrag
if (dataDir && NB.opt_hist) {
    const files = fs.readdirSync(dataDir).filter(f => /^optimizer-v2-\d{4}-\d\d\.csv$/.test(f)).sort();
    if (files.length) {
        const lastF = fs.readFileSync(path.join(dataDir, files[files.length - 1]), 'utf8').trim().split('\n'), lastL = lastF[lastF.length - 1];
        const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(lastL), NOW = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        class FD extends Date { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
        const fsMock = {readFileSync: p => { const f = path.join(dataDir, path.basename(p)); if (!fs.existsSync(f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return fs.readFileSync(f, 'utf8'); }};
        const G = {OPT_cfg: dump.cfg || {}};
        const fn = vm.runInNewContext('(function(msg,global,flow,node,fs,Date){' + NB.opt_hist.func + '\n})', {});
        const out = fn({}, {get: k => G[k], set: () => {}}, {get: () => undefined, set: () => {}}, {warn: () => {}}, fsMock, FD);
        NB.opt_hist.wires.forEach((w, i) => { w.forEach(t => { MSG[t] = out[i]; }); });
        console.log('Verläufe aus ' + files.join(', ') + ' bis ' + lastL.slice(0, 16));
    }
}

const RENDER_JS = `(function () {
function ev(s, e) { try { var px = new Proxy(s, {has: function (t, k) { return typeof k === 'string'; }, get: function (t, k) { return k === Symbol.unscopables ? undefined : t[k]; }}); return (new Function('s', 'with (s) { return (' + e + '); }'))(px); } catch (x) { return undefined; } }      // wie Angular: unbekannte Namen sind undefined
function ip(str, s) { return str.replace(/\\{\\{([\\s\\S]+?)\\}\\}/g, function (m, e) { var v = ev(s, e.trim()); return v === undefined || v === null ? '' : String(v); }); }
function kid(s, o) { var c = Object.create(s); Object.keys(o).forEach(function (k) { c[k] = o[k]; }); return c; }
function cls(el, v) { if (!v) { return; } if (typeof v === 'string') { v.split(/\\s+/).forEach(function (c) { if (c) { el.classList.add(c); } }); } else if (Array.isArray(v)) { v.forEach(function (c) { cls(el, c); }); } else { Object.keys(v).forEach(function (c) { if (v[c]) { el.classList.add(c); } }); } }
function node(n, s) {
    if (n.nodeType === 3) { if (n.nodeValue.indexOf('{{') >= 0) { n.nodeValue = ip(n.nodeValue, s); } return; }
    if (n.nodeType !== 1) { return; }
    if (n.hasAttribute('ng-if')) { if (!ev(s, n.getAttribute('ng-if'))) { n.parentNode.removeChild(n); return; } n.removeAttribute('ng-if'); }
    Array.prototype.slice.call(n.attributes).forEach(function (a) { if (a.value.indexOf('{{') >= 0) { n.setAttribute(a.name, ip(a.value, s)); } });
    if (n.hasAttribute('ng-class')) { cls(n, ev(s, n.getAttribute('ng-class'))); }
    if (n.hasAttribute('ng-bind-html')) { n.innerHTML = String(ev(s, n.getAttribute('ng-bind-html')) || ''); }
    if (n.hasAttribute('ng-model')) { var v = ev(s, n.getAttribute('ng-model')); if (n.type === 'checkbox') { n.checked = !!v; } else if (v !== undefined && v !== null) { n.setAttribute('value', v); n.value = v; } }
    kids(n, s);
}
function kids(p, s) {
    var ks = Array.prototype.slice.call(p.childNodes);
    for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        if (k.nodeType === 1 && (k.hasAttribute('ng-repeat') || k.hasAttribute('ng-repeat-start'))) {
            var st = k.hasAttribute('ng-repeat-start'), ex = k.getAttribute(st ? 'ng-repeat-start' : 'ng-repeat'), grp = [k];
            if (st) { var j = i + 1; while (j < ks.length && !(ks[j].nodeType === 1 && ks[j].hasAttribute('ng-repeat-end'))) { grp.push(ks[j]); j++; } if (j < ks.length) { grp.push(ks[j]); } i = j; }
            var m = /^\\s*(\\w+)\\s+in\\s+([\\s\\S]+?)(\\s+track\\s+by\\s+[\\s\\S]+)?$/.exec(ex), arr = m ? ev(s, m[2]) : [], an = document.createComment('r');
            p.insertBefore(an, k); grp.forEach(function (g) { p.removeChild(g); });
            (Array.isArray(arr) ? arr : []).forEach(function (it, ix) {
                var o = {$index: ix}; o[m[1]] = it; var cs = kid(s, o);
                grp.forEach(function (g) { var c = g.cloneNode(true); if (c.nodeType === 1) { ['ng-repeat', 'ng-repeat-start', 'ng-repeat-end'].forEach(function (a) { c.removeAttribute(a); }); } p.insertBefore(c, an); node(c, cs); });
            });
            continue;
        }
        node(k, s);
    }
}
window.__tpl = function (holder) {
    var src = document.getElementById(holder.getAttribute('data-src')).textContent, tpl = JSON.parse(src), scripts = [];
    var html = tpl.format.replace(/<script>([\\s\\S]*?)<\\/script>/g, function (m, c) { scripts.push(c); return ''; });
    var scope = {msg: tpl.msg, send: function () {}, $watch: function (e, fn) { if (e === 'msg') { fn(scope.msg); } }};
    scripts.forEach(function (c) { try { (new Function('scope', c))(scope); } catch (x) { console.log('Skript: ' + x.message); } });
    var box = document.createElement('div'); box.innerHTML = html; kids(box, scope);
    while (box.firstChild) { holder.parentNode.insertBefore(box.firstChild, holder); }
    holder.parentNode.removeChild(holder);
};
Array.prototype.forEach.call(document.querySelectorAll('.tplsrc'), function (h) { window.__tpl(h); });
})();`;

// Seiten: [Tab, Titel, Datei, Schnappschuss der Maschine]; leere (ausgeblendete) Tabs werden uebersprungen
const PAGES = [['a5be8588.b8fbc8', 'Übersicht', 'uebersicht', null], ['opt_ui_tab', 'Optimierung', 'optimierung', null], ['opt_eng_ui_tab', 'Optimierer', 'optimierer', 'B'], ['opt_eng_ui_tab', 'Optimierer', 'optimierer_vorschlag', 'A'],
               ['opt_ui_tab_data', 'Daten & Güte', 'daten', null], ['opt_ui_tab_plan', 'Wärmefahrplan', 'waermefahrplan', null], ['opt_ui_tab_quiet', 'Quiet-Messwerte', 'quiet', null]];
// Karten der Entscheidungsmaschine: Nachrichten wie opt_engine sie schickt ({payload: V.card} usw.), aus dem Replay der Protokolle im Datenordner
const ENG_KIND = {opt_t_eng_prop: 'card', opt_t_eng_rules: 'rules', opt_t_eng_score: 'score', opt_t_eng_mess: 'mess', opt_t_eng_log: 'log'};
const SNAP = (dataDir && flows.some(n => ENG_KIND[n.id])) ? PRE.snapshots(dataDir) : null;
// Optional: Karte "Entscheidungen" aus einem echten Zustand (OPT_ENG_STATE=<engine-state.json> von der NAS, nur gelesen), z. B. mit Episoden stillgelegter Regeln
if (SNAP && process.env.OPT_ENG_STATE) {
    const VW = require('./engine_view.js'), ST = JSON.parse(fs.readFileSync(process.env.OPT_ENG_STATE, 'utf8')), V = ST.V || {ep: [], open: {}};
    const tEnd = Math.max.apply(null, (V.ep || []).map(e => e.t1).concat([0]));
    Object.keys(SNAP).forEach(k => { SNAP[k].log = {rows: VW.logRows(V, tEnd, 12)}; });
    console.log('Entscheidungen aus ' + process.env.OPT_ENG_STATE + ' (' + (V.ep || []).length + ' Episoden)');
}
const PAD = PRE.PAD;
// Kern-Gruppen (nicht opt_*) zeichnet die Vorschau nicht nach, sondern als Platzhalter in ihrer live gemessenen Hoehe (Titel + Inhalt, 1920 px, 14.10.2026)
const KERN_H = {bf4af523ba16d457: 644, hc_grp: 212, '1179fa790d2d89ca': 590};
const TITEL_FARBE = process.env.OPT_TITEL_FARBE || '#1bbfff';                  // Gruppentitel wie das Dashboard (theme-light); mit tools/ui_optik_patch.py: #0083b8
fs.mkdirSync(outDir, {recursive: true});
const CHECK = PRE.CHECK_JS.replace("window.addEventListener('load', function () { setTimeout(run, 50); });", "window.addEventListener('load', function () { setTimeout(run, 500); });");
PAGES.forEach(([tabId, title, file, snap]) => {
    const groups = flows.filter(n => n.type === 'ui_group' && n.tab === tabId).sort((a, b) => a.order - b.order);
    if (!groups.length) { console.log('übersprungen: ' + title + ' (' + tabId + ') hat keine Gruppen'); return; }
    Object.keys(ENG_KIND).forEach(k => { if (SNAP && snap) { MSG[k] = {payload: SNAP[snap][ENG_KIND[k]]}; } else { delete MSG[k]; } });
    let blobs = '', body = '';
    groups.forEach(g => {
        const tpls = flows.filter(n => n.type === 'ui_template' && n.group === g.id).sort((a, b) => a.order - b.order);
        const W = +g.width, gw = W * 48 + (W - 1) * 6;
        if (!g.id.startsWith('opt_')) {
            const h = KERN_H[g.id] || 300;
            body += '<div class="grp kern" data-g="' + g.name + '" data-w="' + W + '" style="width:' + gw + 'px"><div class="ttl">' + g.name + '</div><div class="kph" style="height:' + (h - 54) + 'px">Kern-Gruppe (Platzhalter, Höhe live gemessen)</div></div>';
            return;
        }
        const voll = tpls.some(t => t.format.includes('ui-card-panel[node-id="' + g.id + '"]{width:calc(100% - 12px)'));      // Gruppe nimmt per CSS die volle Inhaltsbreite
        body += '<div class="grp" data-g="' + g.name + '" data-w="' + W + '"' + (voll ? ' data-voll="1"' : '') + ' style="width:' + gw + 'px">' + (g.disp !== false ? '<div class="ttl">' + g.name + '</div>' : '');
        tpls.forEach(t => {
            const id = 'src_' + t.id;
            blobs += '<script type="application/json" id="' + id + '">' + JSON.stringify({format: t.format, msg: MSG[t.id] || null}).replace(/</g, '\\u003c') + '</script>';
            body += '<div class="crd" data-k="' + t.id + '" data-u="' + t.height + '" style="width:' + gw + 'px" node-id="' + t.id + '"><div class="tplsrc" data-src="' + id + '"></div></div>';
        });
        body += '</div>';
    });
    const css = '<style>html{overflow-y:scroll}body{margin:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;font-size:16px;color:rgba(0,0,0,.87)}' +
        '.tb{height:48px;background:#0094ce;color:#fff;font-size:20px;line-height:48px;padding:0 16px}.pr{font-size:12px;padding:4px 8px;font-family:monospace}.pr.ok{background:#e8f5e9;color:#1b5e20}.pr.f{background:#ffebee;color:#b71c1c}' +
        '.mas{position:relative;margin:0}.grp{position:absolute;background:#fff}.grp>.ttl{padding:10px 0 12px 12px;font-size:19.2px;font-weight:500;color:' + TITEL_FARBE + ';line-height:32px}' +
        '.crd{box-sizing:border-box;padding:0 ' + PAD + 'px;overflow-y:auto;margin-bottom:6px}.kph{box-sizing:border-box;margin:0 6px 6px;border:1px dashed #b0bec5;border-radius:6px;color:#546e7a;font-size:13px;padding:10px}</style>';
    const html = '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>' + title + ' Vorschau</title>' + css + '</head><body><div id="pr" class="pr">Prüfung läuft …</div><div class="tb">' + title + '</div>' +
        '<div class="mas" data-s="' + file.charAt(0).toUpperCase() + '">' + body + '</div>' + blobs + '<script>' + RENDER_JS + '</script><script>' + CHECK + '</script></body></html>';
    const f = path.join(outDir, file + '.html');
    fs.writeFileSync(f, html);
    console.log('geschrieben: ' + f + ' (' + groups.length + ' Gruppen)');
});

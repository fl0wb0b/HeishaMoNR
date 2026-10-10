/* Darstellung der Seite "Optimierer" (Entscheidungsmaschine) als HTML-Text: reine Funktionen, vom Generator in die vier Dashboard-Vorlagen eingebettet,
 * in tools/engine_sim.js geprueft und in tools/engine_ui_preview.js zu einer statischen Vorschau gerendert.
 *   optEngUi.html(kind, P)              -> HTML einer Karte (kind: 'card' | 'rules' | 'score' | 'log'), P = Nutzlast aus ENGVIEW.build
 *   optEngUi.mount(el, kind, P, scope)  -> zeichnet in ein Element, Knoepfe schicken nur Aktion + ID + Pruefsumme, Diagramm ueber optChart */
(function (root) {
    var VER = 1;
    if (root.optEngUi && root.optEngUi.v === VER) { return; }
    var U = {v: VER};
    function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function chip(t, c, title) { return '<span class="oe-chip oe-' + esc(c || 'mute') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(t) + '</span>'; }
    function bar(f, c) { return '<div class="oe-bar"><i style="width:' + Math.round(Math.max(0, Math.min(1, f)) * 100) + '%' + (c ? ';background:' + c : '') + '"></i></div>'; }
    U.css = '<style>' +
        '.oe{font-size:14px;line-height:1.4;color:#263238}' +
        '.oe-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
        '.oe-chip{display:inline-block;padding:2px 9px;border-radius:11px;font-size:12px;line-height:18px;white-space:nowrap;background:#eceff1;color:#546e7a}' +
        '.oe-ok{background:#e8f5e9;color:#2e7d32}.oe-warn{background:#fff3e0;color:#e65100}.oe-bad{background:#ffebee;color:#c62828}' +
        '.oe-act{background:#1976d2;color:#fff}.oe-lock{background:#eceff1;color:#37474f;font-weight:600}.oe-mute{background:#eceff1;color:#546e7a}' +
        '.oe-prop{margin-top:10px;border:1px solid #bbdefb;border-left:4px solid #1976d2;border-radius:6px;background:#f5f9ff;padding:10px 12px}' +
        '.oe-prop .oe-was{font-size:18px;font-weight:600;margin:0 0 2px}' +
        '.oe-prop .oe-why{color:#455a64;margin-bottom:8px}' +
        '.oe-meta{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:13px;color:#546e7a}.oe-meta b{color:#263238;font-weight:600}' +
        '.oe details{margin-top:6px;font-size:13px;color:#546e7a}.oe summary{cursor:pointer;color:#1976d2;outline:none}' +
        '.oe-btns{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}' +
        '.oe button{font:inherit;font-size:13px;padding:6px 14px;border-radius:4px;border:1px solid #1976d2;background:#1976d2;color:#fff;cursor:pointer}' +
        '.oe button.sec{background:transparent;color:#1976d2}' +
        '.oe button[disabled]{background:#eeeeee;border-color:#bdbdbd;color:#757575;cursor:not-allowed}' +
        '.oe-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}' +
        '.oe-tile{border:1px solid #e0e0e0;border-radius:6px;background:#fafafa;padding:8px 10px;min-width:0}' +
        '.oe-hd{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:6px}' +
        '.oe-nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.oe-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}' +
        '.oe-seg{display:flex;gap:3px;margin-bottom:6px}.oe-seg i{flex:1;height:5px;border-radius:2px;background:#cfd8dc}.oe-seg i.on{background:#43a047}' +
        '.oe-ln{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#546e7a;min-height:17px}' +
        '.oe-ln span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.oe-ln span.w{white-space:normal}.oe-ln b{white-space:nowrap;color:#263238;font-weight:600}' +
        '.oe-bar{height:4px;border-radius:2px;background:#e0e0e0;margin-top:4px;overflow:hidden}.oe-bar i{display:block;height:100%;background:#1976d2}' +
        '.oe-pt{font-size:22px;font-weight:600;line-height:1.2}.oe-neg{color:#c62828}' +
        '.oe-sub{font-size:12px;color:#757575;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:17px}' +
        '.oe-wr{font-size:12px;color:#c62828;min-height:17px}' +
        '.oe-kr{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}' +
        '.oe-line{margin-top:10px;font-size:13px;color:#546e7a;display:flex;gap:8px;align-items:center}' +
        '.oe table{width:100%;border-collapse:collapse;font-size:13px}' +
        '.oe th{text-align:left;font-weight:normal;color:#757575;padding:3px 6px;border-bottom:1px solid #ddd;font-size:12px}' +
        '.oe td{padding:5px 6px;border-bottom:1px solid #eee;vertical-align:middle}' +
        '.oe td.t{white-space:nowrap;color:#546e7a;width:1%}.oe td.n{white-space:nowrap;width:1%}' +
        '.oe .arr{color:#b0bec5;margin:0 2px}' +
        '</style>';

    // ---------------------------------------------------------------- Karte 1: Statuszeile, Vorschlag, Knoepfe
    function card(P) {
        var h = '<div class="oe-row">' + (P.status || []).map(function (s) { return chip((s.c === 'lock' ? '🔒 ' : '') + s.t, s.c); }).join('') + '</div>';
        var p = P.prop;
        if (p) {
            h += '<div class="oe-prop" style="border-left-color:' + esc(p.c) + '">' +
                 '<div class="oe-row" style="margin-bottom:4px">' + chip(p.hinweis ? 'Hinweis' : 'Vorschlag', 'act') + chip(p.name, 'mute') + '</div>' +
                 '<div class="oe-was">' + esc(p.was) + '</div><div class="oe-why">' + esc(p.warum) + '</div>' +
                 '<div class="oe-meta"><span>Befehl <b>' + esc(p.befehl) + '</b></span><span>seit <b>' + esc(p.seit) + '</b></span><span>gültig bis <b>' + esc(p.bis) + '</b></span><span>Rückweg <b>' + esc(p.rueck) + '</b></span></div>' +
                 '<details data-k="prop"><summary>Erwartung und Rückweg</summary><div style="margin-top:4px">' + esc(p.erwartung) + '</div><div style="margin-top:4px">' + esc(p.rueckweg) + '</div></details></div>';
        }
        var b = '';
        if (p) {
            b += '<button data-a="uebernehmen"' + (P.knopf && P.knopf.ok ? '' : ' disabled') + '>' + esc(P.knopf ? P.knopf.text : 'Übernahme gesperrt') + '</button>';
            b += '<button class="sec" data-a="verwerfen">Verwerfen</button>';
        }
        if (P.reset) { b += '<button class="sec" data-a="zuruecksetzen">Zurücksetzen</button>'; }
        if (P.enabled) { b += '<button class="sec" data-a="sperren">Übernahme sperren</button>'; }
        if (b) { h += '<div class="oe-btns">' + b + '</div>'; }
        return h;
    }
    // ---------------------------------------------------------------- Karte 2: Regelkacheln
    function rules(P) {
        return '<div class="oe-grid">' + (P.rules || []).map(function (r) {
            var seg = r.bed && r.bed.length ? '<div class="oe-seg">' + r.bed.map(function (b) { return '<i' + (b[1] ? ' class="on"' : '') + ' title="' + esc((b[1] ? '✓ ' : '✗ ') + b[2]) + '"></i>'; }).join('') + '</div>' : '<div class="oe-seg"></div>';
            var L = r.line || {}, ln = '<div class="oe-ln" title="' + esc(r.grund) + '"><span' + (L.v ? '' : ' class="w"') + '>' + (L.lock ? '🔒 ' : '') + esc(L.l) + '</span><b>' + esc(L.v) + '</b></div>';
            return '<div class="oe-tile" style="border-top:3px solid ' + esc(r.c) + '"><div class="oe-hd"><span class="oe-nm">' + esc(r.name) + '</span>' + chip(r.chip, r.cls) + '</div>' + seg + ln +
                   (L.f !== null && L.f !== undefined ? bar(L.f, r.st === 'vorschlag' || r.st === 'hinweis' ? r.c : '') : '<div class="oe-bar" style="visibility:hidden"></div>') + '</div>';
        }).join('') + '</div>';
    }
    // ---------------------------------------------------------------- Karte 3: Punkte (Diagramm, Kennzahlen, Freigabereife, Messaufgabe)
    function score(P) {
        var h = P.series && P.series.length ? '<div id="oe_chart" style="margin-bottom:8px"></div>' : '';
        h += '<div class="oe-grid">' + (P.tiles || []).map(function (t) {
            var rf = t.reife ? '<div class="oe-ln" style="margin-top:6px"><span>Freigabereife</span><b>' + t.reife.n + '/' + t.reife.m + (t.reife.reif ? ' · reif' : '') + '</b></div>' + bar(t.reife.n / t.reife.m, t.reife.reif ? '#43a047' : '#90a4ae') +
                     '<details data-k="reife_' + esc(t.id) + '"><summary>Kriterien</summary><div class="oe-kr">' + t.krit.map(function (k) { return chip((k[1] ? '✓ ' : '✗ ') + k[0], k[1] ? 'ok' : 'mute', k[2]); }).join('') + '</div></details>'
                   : '<div class="oe-ln" style="margin-top:6px"><span>nur Hinweis</span><b></b></div>';
            return '<div class="oe-tile"><div class="oe-hd"><span class="oe-nm"><i class="oe-dot" style="background:' + esc(t.c) + '"></i>' + esc(t.name) + '</span></div>' +
                   '<div class="oe-pt' + (t.neg ? ' oe-neg' : '') + '">' + esc(t.punkte) + '</div><div class="oe-sub">' + esc(t.sub) + '</div><div class="oe-sub">' + esc(t.more) + '</div><div class="oe-wr">' + esc(t.warn) + '</div>' +
                   (t.sperre !== null && t.sperre !== undefined ? '<div class="oe-ln" data-k="sperre"><span>🔒 verpasst während Sperre</span><b>' + esc(String(t.sperre)) + '</b></div>' : '<div class="oe-ln"></div>') + rf + '</div>';
        }).join('') + '</div>';
        if (P.mess) { h += '<div class="oe-line"><span>Messaufgabe Comfort/Efficiency</span>' + chip(P.mess.chip, P.mess.c) + '<span>' + esc(P.mess.t) + '</span></div>'; }
        return h;
    }
    // ---------------------------------------------------------------- Karte 4: Entscheidungen (Episoden)
    function log(P) {
        var rows = P.rows || [];
        if (!rows.length) { return '<div class="oe-sub">–</div>'; }
        return '<table><tr><th>Zeit</th><th>Regel</th><th>Verlauf</th><th>Ende</th></tr>' + rows.map(function (r) {
            return '<tr><td class="t">' + esc(r.t) + '</td><td class="n"><i class="oe-dot" style="background:' + esc(r.c) + '"></i>' + esc(r.n) + '</td><td>' +
                   r.steps.map(function (s) { return chip(s[0], s[1]); }).join('<span class="arr">›</span>') + (r.was ? ' <span style="color:#546e7a;font-size:12px">' + esc(r.was) + '</span>' : '') + '</td><td>' + (r.offen ? chip('läuft', 'ok') : esc(r.ende)) + '</td></tr>';
        }).join('') + '</table>';
    }
    U.html = function (kind, P) { P = P || {}; return '<div class="oe">' + (kind === 'card' ? card(P) : kind === 'rules' ? rules(P) : kind === 'score' ? score(P) : log(P)) + '</div>'; };
    U.chartSpec = function (P) {
        return {t0: P.t0, t1: P.now, panels: [{h: 130, zero: true, series: (P.series || []).map(function (s) { return {n: s.n, c: s.c, k: 'step', w: 1.8, dg: 1, u: 'Punkte', d: s.d}; })}]};
    };
    U.mount = function (el, kind, P, scope) {
        try {
            if (!el || !P) { return; }
            if (typeof document !== 'undefined' && !document.getElementById('oe_css')) { var st = document.createElement('div'); st.innerHTML = U.css.replace('<style>', '<style id="oe_css">'); document.head.appendChild(st.firstChild); }
            var open = el.__oeOpen = el.__oeOpen || {};
            el.innerHTML = U.html(kind, P);
            Array.prototype.forEach.call(el.querySelectorAll('details[data-k]'), function (d) { var k = d.getAttribute('data-k'); if (open[k]) { d.open = true; } d.addEventListener('toggle', function () { open[k] = d.open; }); });
            Array.prototype.forEach.call(el.querySelectorAll('button[data-a]'), function (b) {
                b.addEventListener('click', function () {
                    var a = b.getAttribute('data-a');
                    if (!scope || b.disabled) { return; }
                    if (a === 'uebernehmen' && P.prop) { scope.send({topic: 'uebernehmen', payload: {id: P.prop.id, sum: P.prop.sum}}); }
                    else if (a === 'verwerfen' && P.prop) { scope.send({topic: 'verwerfen', payload: {id: P.prop.id}}); }
                    else if (a === 'zuruecksetzen') { scope.send({topic: 'zuruecksetzen', payload: {}}); }
                    else if (a === 'sperren') { scope.send({topic: 'sperren', payload: {}}); }
                });
            });
            var ch = el.querySelector('#oe_chart');
            if (kind === 'score' && ch && root.optChart) { root.optChart.mount(ch, U.chartSpec(P)); }
        } catch (e) { /* Karte bleibt leer */ }
    };
    root.optEngUi = U;
    if (typeof module !== 'undefined' && module.exports) { module.exports = U; }
})(typeof window !== 'undefined' ? window : globalThis);

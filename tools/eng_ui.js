/* Darstellung der Seite "Optimierer" (Entscheidungsmaschine) als HTML-Text: reine Funktionen, vom Generator in die fuenf Dashboard-Vorlagen eingebettet,
 * in tools/engine_sim.js geprueft und in tools/engine_ui_preview.js zu einer statischen Vorschau gerendert.
 *   optEngUi.html(kind, P)              -> HTML einer Karte (kind: 'card' | 'rules' | 'score' | 'mess' | 'log'), P = Nutzlast aus ENGVIEW.build
 *   optEngUi.mount(el, kind, P, scope)  -> zeichnet in ein Element, Knoepfe schicken nur Aktion + ID + Pruefsumme, Diagramm ueber optChart */
(function (root) {
    var VER = 5;                                                                  // 5 (14.10.2026): Abschnitt „Räume und Wächter“ in „Messwerte & Lernen“                                                                  // 4: Vorschlag mit Befehl/Zielwert/Begruendung/Wirkung/Rueckweg offen, Karte "Messwerte & Lernen"
    if (root.optEngUi && root.optEngUi.v === VER) { return; }
    var U = {v: VER};
    function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function tt(t) { return t ? ' title="' + esc(t) + '"' : ''; }
    function chip(t, c, title) { return '<span class="oe-chip oe-' + esc(c || 'mute') + '"' + tt(title) + '>' + esc(t) + '</span>'; }
    function bar(f, c) { return '<div class="oe-bar"><i style="width:' + Math.round(Math.max(0, Math.min(1, f)) * 100) + '%' + (c ? ';background:' + c : '') + '"></i></div>'; }
    U.css = '<style>' +
        '.oe{font-size:14px;line-height:1.4;color:#263238}' +
        '.oe-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
        '.oe-chip{display:inline-block;padding:2px 9px;border-radius:11px;font-size:12px;line-height:18px;white-space:nowrap;background:#eceff1;color:#546e7a}' +
        '.oe-ok{background:#e8f5e9;color:#2e7d32}.oe-warn{background:#fff3e0;color:#e65100}.oe-bad{background:#ffebee;color:#c62828}' +
        '.oe-act{background:#1976d2;color:#fff}.oe-lock{background:#eceff1;color:#37474f;font-weight:600}.oe-mute{background:#eceff1;color:#546e7a}' +
        '.oe-prop{margin-top:10px;border:1px solid #bbdefb;border-left:4px solid #1976d2;border-radius:6px;background:#f5f9ff;padding:10px 12px}' +
        '.oe-ph{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.oe-ph .oe-zeit{margin-left:auto;font-size:13px;color:#546e7a}.oe-zeit b{color:#263238;font-weight:600}' +
        '.oe-was{font-size:18px;font-weight:600;margin:4px 0 6px}' +
        '.oe-dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 14px;font-size:13px}' +
        '.oe-dl>dt{color:#757575;margin:0}.oe-dl>dd{margin:0;color:#263238;overflow-wrap:anywhere}.oe-dl code{font-family:inherit;font-weight:600}' +
        '.oe-leer{margin-top:10px;border:1px dashed #cfd8dc;border-radius:6px;padding:10px 12px;min-height:118px;box-sizing:border-box}.oe-lt{font-size:15px;font-weight:600;color:#546e7a;margin-bottom:4px}' +
        '.oe-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}' +
        '.oe-btns{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}' +
        '.oe button{font:inherit;font-size:13px;padding:6px 14px;border-radius:4px;border:1px solid #1976d2;background:#1976d2;color:#fff;cursor:pointer}' +
        '.oe button.sec{background:transparent;color:#1976d2}' +
        '.oe button[disabled]{background:#eeeeee;border-color:#bdbdbd;color:#757575;cursor:not-allowed}' +
        '.oe-grund{font-size:13px;color:#546e7a}' +
        '.oe-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}' +
        '.oe-tile{border:1px solid #e0e0e0;border-radius:6px;background:#fafafa;padding:8px 10px;min-width:0}' +
        '.oe-hd{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:6px}' +
        '.oe-nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.oe-st{display:flex;align-items:center;gap:6px;margin-bottom:6px}.oe-st .oe-seg{flex:1;margin:0}' +
        '.oe-seg{display:flex;gap:3px;margin-bottom:6px}.oe-seg i{flex:1;height:5px;border-radius:2px;background:#cfd8dc}.oe-seg i.on{background:#43a047}' +
        '.oe-ln{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#546e7a;min-height:17px}' +
        '.oe-ln span{white-space:normal;overflow-wrap:anywhere}.oe-ln b{white-space:nowrap;color:#263238;font-weight:600}' +
        '.oe-bar{height:4px;border-radius:2px;background:#e0e0e0;margin-top:4px;overflow:hidden}.oe-bar i{display:block;height:100%;background:#1976d2}' +
        '.oe-pt{font-size:22px;font-weight:600;line-height:1.2}.oe-neg{color:#c62828}' +
        '.oe-sub{font-size:12px;color:#757575;min-height:17px}' +
        '.oe-wr{font-size:12px;color:#c62828;min-height:17px}' +
        '.oe-kr{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}' +
        '.oe details{margin-top:6px;font-size:13px;color:#546e7a}.oe summary{cursor:pointer;color:#1976d2;outline:none}' +
        '.oe-sec{margin:12px 0 6px;font-size:12px;color:#546e7a;font-weight:600;text-transform:uppercase;letter-spacing:.03em}.oe-sec:first-child{margin-top:0}' +
        '.oe-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}' +
        '.oe-kpi{border:1px solid #e0e0e0;border-radius:6px;background:#fafafa;padding:6px 10px;min-width:0}' +
        '.oe-kk{font-size:11px;color:#757575;line-height:1.3}.oe-kv{font-size:18px;font-weight:600;line-height:1.3;white-space:nowrap}.oe-okt{color:#2e7d32}.oe-warnt{color:#e65100}' +
        '.oe-ks{font-size:12px;color:#757575;min-height:17px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}' +
        '.oe-ml{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:6px}' +
        '.oe-mlc{border:1px solid #e0e0e0;border-radius:6px;background:#fafafa;padding:3px 6px;text-align:center}.oe-mlc span{display:block;font-size:11px;color:#757575}.oe-mlc b{font-weight:600}' +
        '.oe table{width:100%;border-collapse:collapse;font-size:13px}' +
        '.oe th{text-align:left;font-weight:normal;color:#757575;padding:3px 6px;border-bottom:1px solid #ddd;font-size:12px}' +
        '.oe td{padding:5px 6px;border-bottom:1px solid #eee;vertical-align:middle}' +
        '.oe td.t{white-space:nowrap;color:#546e7a;width:1%}.oe td.n{white-space:nowrap;width:1%}' +
        '.oe .arr{color:#b0bec5;margin:0 2px}' +
        '.oe table.oe-cop{width:auto;min-width:50%}.oe-cop th,.oe-cop td{text-align:right;white-space:nowrap;padding:3px 10px}.oe-cop th:first-child,.oe-cop td:first-child{text-align:left;color:#546e7a}' +
        '.oe-cop td b{font-weight:600}.oe-cop td i{font-style:normal;font-size:11px;color:#9e9e9e;margin-left:4px}' +
        '.oe-cop td.oe-grau{color:#b0bec5}.oe-cop td.oe-grau b{font-weight:normal}.oe-cop td.oe-best{background:#e8f5e9;color:#1b5e20}' +
        '</style>';

    function dl(k, v, title) { return '<dt>' + esc(k) + '</dt><dd' + tt(title) + '>' + v + '</dd>'; }
    // ---------------------------------------------------------------- Karte 1: Statuszeile, aktueller Vorschlag (Befehl, Zielwert, Begruendung, Wirkung, Rueckweg, Knopf)
    function card(P) {
        var h = '<div class="oe-row">' + (P.status || []).map(function (s) { return chip((s.c === 'lock' ? '🔒 ' : '') + s.t, s.c); }).join('') + '</div>';
        var p = P.prop, b = '';
        if (p) {
            var k = P.knopf || {ok: false, text: 'Übernehmen', grund: 'gesperrt'};
            b += '<button data-a="uebernehmen"' + (P.knopf && P.knopf.ok ? '' : ' disabled') + '>' + esc(k.text || 'Übernehmen') + '</button>';
            b += '<button class="sec" data-a="verwerfen">Verwerfen</button>';
            if (k.grund) { b += '<span class="oe-grund">' + (/^gesperrt/.test(k.grund) ? '🔒 ' : '') + esc(k.grund) + '</span>'; }
            h += '<div class="oe-prop" style="border-left-color:' + esc(p.c) + '">' +
                 '<div class="oe-ph">' + chip(p.hinweis ? 'Hinweis' : 'Vorschlag', 'act') + chip(p.name, 'mute') + '<span class="oe-zeit">seit <b>' + esc(p.seit) + '</b> · gültig bis <b>' + esc(p.bis) + '</b></span></div>' +
                 '<div class="oe-was">' + esc(p.was) + '</div>' +
                 '<dl class="oe-dl" style="margin:0">' + dl('Befehl', '<code>' + esc(p.befehl) + '</code>') + dl('Zielwert', esc(p.ziel)) + dl('Begründung', esc(p.warum)) +
                 dl('Erwartete Wirkung', esc(p.erwartung), p.erwartungLang) + dl('Rückweg', esc(p.rueck), p.rueckweg) + '</dl>' +
                 '<div class="oe-btns">' + b + '</div></div>';
            b = '';
        } else {
            var l = P.leer && P.leer.letzter;
            h += '<div class="oe-leer"><div class="oe-lt">Kein Vorschlag</div><dl class="oe-dl" style="margin:0">' +
                 dl('Letzter Vorschlag', l ? '<i class="oe-dot" style="background:' + esc(l.c) + '"></i>' + esc(l.name + ' · ' + l.was) : '–') +
                 (l ? dl('Zeitraum', esc(l.t + (l.ende ? ' · Ende: ' + l.ende : ''))) : '') + dl('Letzte 24 h', esc((P.leer && P.leer.h24) || '–')) +
                 dl('Übernahme', (P.leer && P.leer.lock ? '🔒 ' : '') + esc((P.leer && P.leer.uebernahme) || '–')) + '</dl></div>';
        }
        if (P.reset) { b += '<button class="sec" data-a="zuruecksetzen">Zurücksetzen</button>'; }
        if (P.enabled) { b += '<button class="sec" data-a="sperren">Übernahme sperren</button>'; }
        if (b) { h += '<div class="oe-btns">' + b + '</div>'; }
        return h;
    }
    // ---------------------------------------------------------------- Karte 2: Regelkacheln
    function rules(P) {
        return '<div class="oe-grid">' + (P.rules || []).map(function (r) {
            var seg = '<div class="oe-st">' + chip(r.chip, r.cls) + '<div class="oe-seg">' + (r.bed || []).map(function (b) { return '<i' + (b[1] ? ' class="on"' : '') + ' title="' + esc((b[1] ? '✓ ' : '✗ ') + b[2]) + '"></i>'; }).join('') + '</div></div>';
            var L = r.line || {}, ln = '<div class="oe-ln" title="' + esc(r.grund) + '"><span' + (L.v ? '' : ' class="w"') + '>' + (L.lock ? '🔒 ' : '') + esc(L.l) + '</span><b>' + esc(L.v) + '</b></div>';
            return '<div class="oe-tile" style="border-top:3px solid ' + esc(r.c) + '"><div class="oe-hd"><span class="oe-nm">' + esc(r.name) + '</span></div>' + seg + ln +
                   (L.f !== null && L.f !== undefined ? bar(L.f, r.st === 'vorschlag' || r.st === 'hinweis' ? r.c : '') : '<div class="oe-bar" style="visibility:hidden"></div>') + '</div>';
        }).join('') + '</div>';
    }
    // ---------------------------------------------------------------- Karte 3: Punkte (Diagramm, Kennzahlen, Freigabereife)
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
        return h;
    }
    // ---------------------------------------------------------------- Karte 4: Messwerte & Lernen (Kennzahlen mit Status-Chip, Mindestleistung je Band, COP-Matrix)
    function kpis(list) {
        return '<div class="oe-kpis">' + (list || []).map(function (t) {
            return '<div class="oe-kpi"' + tt(t.title) + '><div class="oe-kk">' + esc(t.k) + '</div><div class="oe-kv' + (t.vc ? ' oe-' + esc(t.vc) + 't' : '') + '">' + esc(t.v) + '</div>' +
                   '<div class="oe-ks">' + (t.chip ? chip(t.chip, t.c) : '') + (t.s ? '<span>' + esc(t.s) + '</span>' : '') + '</div></div>';
        }).join('') + '</div>';
    }
    function cop(C) {
        if (!C) { return '<div class="oe-row">' + chip('sammelt', 'mute') + '</div>'; }
        return '<table class="oe-cop"><tr><th>Außen</th>' + C.spalten.map(function (s) { return '<th>' + esc(s) + '</th>'; }).join('') + '</tr>' + C.zeilen.map(function (z) {
            return '<tr><td>' + esc(z.band) + '</td>' + z.zellen.map(function (c) {
                return c ? '<td class="' + (c.best ? 'oe-best' : (c.grau ? 'oe-grau' : '')) + '"' + tt(c.title) + '><b>' + esc(c.v) + '</b><i>' + esc(c.h) + '</i></td>' : '<td class="oe-grau">–</td>';
            }).join('') + '</tr>';
        }).join('') + '</table>';
    }
    function mess(P) {
        var ml = (P.ml || []).length ? '<div class="oe-ml">' + P.ml.map(function (c) { return '<div class="oe-mlc"' + tt(c.title) + '><span>' + esc(c.band) + '</span><b>' + esc(c.v) + '</b></div>'; }).join('') + '</div>'
                                    : '<div class="oe-row">' + chip(P.mlLeer || 'sammelt', 'mute') + '</div>';
        return '<div class="oe-sec">Takt und Leistung</div>' + kpis(P.takt) +
               '<div class="oe-sec">Mindestleistung je Außenband</div>' + ml +
               '<div class="oe-sec"' + tt(P.cop && P.cop.title) + '>COP je Modus und Quiet · 30 Tage</div>' + cop(P.cop) +
               '<div class="oe-sec">Lernen</div>' + kpis(P.lern) +
               ((P.raum || []).length ? '<div class="oe-sec">Räume und Wächter</div>' + kpis(P.raum) : '');
    }
    // ---------------------------------------------------------------- Karte 5: Entscheidungen (Episoden)
    function log(P) {
        var rows = P.rows || [];
        if (!rows.length) { return '<div class="oe-sub">–</div>'; }
        return '<table><tr><th>Zeit</th><th>Regel</th><th>Verlauf</th><th>Ende</th></tr>' + rows.map(function (r) {
            return '<tr><td class="t">' + esc(r.t) + '</td><td class="n"><i class="oe-dot" style="background:' + esc(r.c) + '"></i>' + esc(r.n) + '</td><td>' +
                   r.steps.map(function (s) { return chip(s[0], s[1]); }).join('<span class="arr">›</span>') + (r.was ? ' <span style="color:#546e7a;font-size:12px">' + esc(r.was) + '</span>' : '') + '</td><td>' + (r.offen ? chip('läuft', 'ok') : esc(r.ende)) + '</td></tr>';
        }).join('') + '</table>';
    }
    U.html = function (kind, P) { P = P || {}; return '<div class="oe">' + (kind === 'card' ? card(P) : kind === 'rules' ? rules(P) : kind === 'score' ? score(P) : kind === 'mess' ? mess(P) : log(P)) + '</div>'; };
    U.chartSpec = function (P) {
        return {t0: P.t0, t1: P.now, panels: [{h: 130, zero: true, series: (P.series || []).map(function (s) { return {n: s.n, c: s.c, k: 'step', w: 1.8, dg: 1, u: 'Punkte', d: s.d}; })}]};
    };
    U.mount = function (el, kind, P, scope) {
        try {
            if (!el || !P) { return; }
            if (typeof document !== 'undefined') {                                   // Stil einmal je Fassung (nach einem Deploy ersetzt die neue Fassung den alten Stil ohne Neuladen)
                var cs = document.getElementById('oe_css');
                if (!cs || cs.getAttribute('data-v') !== String(VER)) { var st = document.createElement('div'); st.innerHTML = U.css.replace('<style>', '<style id="oe_css" data-v="' + VER + '">'); if (cs) { cs.parentNode.replaceChild(st.firstChild, cs); } else { document.head.appendChild(st.firstChild); } }
            }
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

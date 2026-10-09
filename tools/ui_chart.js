/* Kleiner SVG-Diagrammbaukasten fuer die Optimierungs-Karten (kein Fremdcode). Wird vom Generator in die Dashboard-Vorlagen eingebettet.
 *   optChart.svg(spec, width)  -> {svg: '<svg ...>', geo: {...}}   reine Funktion, testbar
 *   optChart.at(spec, t)       -> [{panel, name, color, text}]      Werte nahe der Zeit t (Tooltip)
 *   optChart.mount(el, spec)   -> zeichnet in ein Element, Tooltip bei Mausbewegung
 * spec = {t0, t1, marks: [{t, label}], panels: [{h, unit, min, max, zero, rmin, rmax, bands: [{a, b, c}], series: [
 *          {n, c, d: [[t, v], ...], k: 'line'|'step'|'area'|'bar', w, dash, r: true (rechte Achse), dg: Nachkommastellen, u: Einheit, fill, bw (Balkenbreite in ms), bc: [[t, Farbe]]}]}]} */
(function (root) {
    var VER = 4;
    if (root.optChart && root.optChart.v === VER) { return; }
    var C = {v: VER};
    var MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    function p2(x) { return (x < 10 ? '0' : '') + x; }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function fmt(v, dg) { return (Math.round(v * Math.pow(10, dg)) / Math.pow(10, dg)).toFixed(dg).replace('.', ','); }
    function hhmm(t) { var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
    function nice(lo, hi, n) {                                                                      // runde Achsenwerte: [min, max, step]
        if (!(hi > lo)) { hi = lo + 1; }
        var raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), res = raw / mag, st = res <= 1 ? 1 : (res <= 2 ? 2 : (res <= 2.5 ? 2.5 : (res <= 5 ? 5 : 10))) * mag;
        return [Math.floor(lo / st) * st, Math.ceil(hi / st) * st, st];
    }
    function range(series, lo0, hi0, zero) {
        var lo = Infinity, hi = -Infinity;
        series.forEach(function (s) { s.d.forEach(function (p) { if (p[1] !== null && p[1] !== undefined && isFinite(p[1])) { if (p[1] < lo) { lo = p[1]; } if (p[1] > hi) { hi = p[1]; } } }); });
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
        var pad = (hi - lo) * 0.08 || 0.5;
        return [lo0 !== undefined && lo0 !== null ? lo0 : lo - (zero && lo >= 0 ? 0 : pad), hi0 !== undefined && hi0 !== null ? hi0 : hi + pad];
    }
    function timeTicks(t0, t1) {
        var span = t1 - t0, H = 3600000, steps = [H, 2 * H, 3 * H, 6 * H, 12 * H, 24 * H], st = steps[steps.length - 1], i;
        for (i = 0; i < steps.length; i++) { if (span / steps[i] <= 9) { st = steps[i]; break; } }
        var out = [], d0 = new Date(t0), t = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0, 0, 0).getTime();
        while (t < t0) { t += st; }
        for (; t <= t1; t += st) { out.push(t); }
        return out;
    }
    C.svg = function (spec, W) {
        W = Math.max(360, Math.round(W || 800));
        var hasR = spec.panels.some(function (p) { return p.series.some(function (s) { return s.r; }); });
        var L = 52, R = hasR ? 52 : 14, GAP = 16, BOT = 24, TOP = 8, x0 = L, x1 = W - R, t0 = spec.t0, t1 = spec.t1;
        var X = function (t) { return x0 + (t - t0) / (t1 - t0) * (x1 - x0); };
        var out = [], y = TOP, geo = {x0: x0, x1: x1, t0: t0, t1: t1, W: W, panels: []}, ticks = timeTicks(t0, t1);
        spec.panels.forEach(function (pn, pi) {
            var h = pn.h || 150, top = y, bot = y + h;
            var ls = pn.series.filter(function (s) { return !s.r; }), rs = pn.series.filter(function (s) { return s.r; });
            var lr = range(ls, pn.min, pn.max, pn.zero), lt = nice(lr[0], lr[1], 4);
            var lo = pn.min !== undefined && pn.min !== null ? pn.min : lt[0], hi = pn.max !== undefined && pn.max !== null ? pn.max : lt[1];
            var rr = rs.length ? range(rs, pn.rmin, pn.rmax, pn.rzero) : null, rt = rr ? nice(rr[0], rr[1], 4) : null;
            var rlo = rr ? (pn.rmin !== undefined && pn.rmin !== null ? pn.rmin : rt[0]) : 0, rhi = rr ? (pn.rmax !== undefined && pn.rmax !== null ? pn.rmax : rt[1]) : 1;
            var YL = function (v) { return bot - (v - lo) / (hi - lo) * h; }, YR = function (v) { return bot - (v - rlo) / (rhi - rlo) * h; };
            out.push('<rect x="' + x0 + '" y="' + top + '" width="' + (x1 - x0) + '" height="' + h + '" fill="#fafafa" stroke="#e0e0e0"/>');
            (pn.bands || []).forEach(function (b) { var ya = YL(Math.min(hi, b.b)), yb = YL(Math.max(lo, b.a)); if (yb > ya) { out.push('<rect x="' + x0 + '" y="' + ya.toFixed(1) + '" width="' + (x1 - x0) + '" height="' + (yb - ya).toFixed(1) + '" fill="' + (b.c || 'rgba(46,125,50,.10)') + '"/>'); } });
            for (var v = lt[0]; v <= lt[1] + 1e-9; v += lt[2]) { if (v < lo - 1e-9 || v > hi + 1e-9) { continue; } var yy = YL(v).toFixed(1); out.push('<line x1="' + x0 + '" x2="' + x1 + '" y1="' + yy + '" y2="' + yy + '" stroke="#eee"/><text x="' + (x0 - 6) + '" y="' + (+yy + 4) + '" text-anchor="end" font-size="11" fill="#757575">' + fmt(v, lt[2] < 1 ? 1 : 0) + '</text>'); }
            if (rt) { for (var vr = rt[0]; vr <= rt[1] + 1e-9; vr += rt[2]) { if (vr < rlo - 1e-9 || vr > rhi + 1e-9) { continue; } out.push('<text x="' + (x1 + 6) + '" y="' + (YR(vr) + 4).toFixed(1) + '" font-size="11" fill="#757575">' + fmt(vr, rt[2] < 1 ? 1 : 0) + '</text>'); } }
            ticks.forEach(function (t) { var xx = X(t).toFixed(1); out.push('<line x1="' + xx + '" x2="' + xx + '" y1="' + top + '" y2="' + bot + '" stroke="#eee"/>'); });
            if (pn.unit) { out.push('<text x="' + (x0 - 6) + '" y="' + (top - 1) + '" text-anchor="end" font-size="10" fill="#9e9e9e">' + esc(pn.unit) + '</text>'); }
            if (pn.runit && rt) { out.push('<text x="' + (x1 + 6) + '" y="' + (top - 1) + '" font-size="10" fill="#9e9e9e">' + esc(pn.runit) + '</text>'); }
            pn.series.forEach(function (s) {
                var YS = s.r ? YR : YL, base = s.r ? Math.max(rlo, Math.min(rhi, 0)) : Math.max(lo, Math.min(hi, 0)), pts = s.d.filter(function (q) { return q[0] >= t0 - 1 && q[0] <= t1 + 1; });
                var stroke = s.c || '#1976d2', k = s.k || 'line';
                if (k === 'bar') {
                    var bw = s.bw || ((x1 - x0) / Math.max(1, pts.length)) / (x1 - x0) * (t1 - t0), px = Math.max(1, bw / (t1 - t0) * (x1 - x0) * (s.bf || 0.8));
                    pts.forEach(function (q) { if (q[1] === null || q[1] === undefined) { return; } var yv = YS(q[1]), yb = YS(base), col = s.bc ? (s.bc.filter(function (z) { return z[0] === q[0]; })[0] || [0, stroke])[1] : stroke; out.push('<rect x="' + (X(q[0]) + (bw / (t1 - t0) * (x1 - x0) - px) / 2).toFixed(1) + '" y="' + Math.min(yv, yb).toFixed(1) + '" width="' + px.toFixed(1) + '" height="' + Math.max(0.5, Math.abs(yb - yv)).toFixed(1) + '" fill="' + col + '" opacity="' + (s.op || 0.85) + '"/>'); });
                    return;
                }
                var segs = [], cur = null;
                pts.forEach(function (q) {
                    if (q[1] === null || q[1] === undefined || !isFinite(q[1])) { cur = null; return; }
                    var xx = X(q[0]), yy = YS(q[1]);
                    if (!cur) { cur = []; segs.push(cur); }
                    if (k === 'step' && cur.length) { cur.push([xx, cur[cur.length - 1][1]]); }
                    cur.push([xx, yy]);
                });
                if (!segs.length) { return; }
                var d = '', ar = '', yb0 = YS(base).toFixed(1);
                segs.forEach(function (sg) {
                    d += 'M' + sg.map(function (q) { return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('L');
                    if (k === 'area') { ar += 'M' + sg[0][0].toFixed(1) + ' ' + yb0 + 'L' + sg.map(function (q) { return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('L') + 'L' + sg[sg.length - 1][0].toFixed(1) + ' ' + yb0 + 'Z'; }
                });
                if (k === 'area') { out.push('<path d="' + ar + '" style="fill:' + (s.fill || stroke) + ';fill-opacity:' + (s.op || 0.25) + ';stroke:none"/>'); }
                out.push('<path d="' + d + '" style="fill:none;stroke:' + stroke + ';stroke-width:' + (s.w || 1.6) + (s.dash ? ';stroke-dasharray:' + s.dash : '') + ';stroke-linejoin:round"/>');
            });
            geo.panels.push({top: top, bot: bot, lo: lo, hi: hi, rlo: rlo, rhi: rhi});
            y = bot + GAP;
        });
        var H = y - GAP + BOT;
        ticks.forEach(function (t) { var d = new Date(t), lab = (d.getHours() === 0) ? p2(d.getDate()) + '. ' + MONTHS[d.getMonth()] : hhmm(t); out.push('<text x="' + X(t).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle" font-size="11" fill="' + (d.getHours() === 0 ? '#424242' : '#757575') + '"' + (d.getHours() === 0 ? ' font-weight="bold"' : '') + '>' + lab + '</text>'); });
        (spec.marks || []).forEach(function (m) { if (m.t < t0 || m.t > t1) { return; } var xx = X(m.t).toFixed(1); out.push('<line x1="' + xx + '" x2="' + xx + '" y1="' + TOP + '" y2="' + (H - BOT) + '" stroke="' + (m.c || '#546e7a') + '" stroke-dasharray="4 3"/>' + (m.label ? '<text x="' + (+xx + 4) + '" y="' + (TOP + 10) + '" font-size="10" fill="' + (m.c || '#546e7a') + '">' + esc(m.label) + '</text>' : '')); });
        geo.H = H;
        return {svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;font-family:inherit">' + out.join('') + '<line class="optch-x" x1="0" x2="0" y1="' + TOP + '" y2="' + (H - BOT) + '" stroke="#37474f" stroke-width="1" visibility="hidden"/></svg>', geo: geo};
    };
    C.at = function (spec, t) {
        var res = [];
        spec.panels.forEach(function (pn, pi) {
            pn.series.forEach(function (s) {
                var best = null, bd = Infinity;
                s.d.forEach(function (q) { var dd = Math.abs(q[0] - t); if (dd < bd && q[1] !== null && q[1] !== undefined && isFinite(q[1])) { bd = dd; best = q; } });
                var tol = s.k === 'bar' ? (s.bw || 3600000) : 20 * 60000;
                if (best && bd <= tol) { res.push({panel: pi, name: s.n, color: s.c || '#1976d2', text: fmt(best[1], s.dg === undefined ? 1 : s.dg) + (s.u ? ' ' + s.u : '')}); }
            });
        });
        return res;
    };
    C.legend = function (spec) {
        var items = [];
        spec.panels.forEach(function (pn) { pn.series.forEach(function (s) { items.push('<span style="display:inline-block;margin:0 14px 2px 0;white-space:nowrap"><span style="display:inline-block;width:' + (s.k === 'bar' || s.k === 'area' ? 10 : 16) + 'px;height:' + (s.k === 'bar' || s.k === 'area' ? 10 : 3) + 'px;background:' + (s.c || '#1976d2') + ';margin-right:5px;vertical-align:middle;opacity:' + (s.k === 'area' ? 0.6 : 1) + '"></span>' + esc(s.n) + '</span>'); }); });
        return '<div style="font-size:12px;color:#546e7a;padding:2px 0 6px 52px">' + items.join('') + '</div>';
    };
    C.mount = function (el, spec) {
        try {
            if (!el) { return; }
            var W = el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 800, r = C.svg(spec, W);
            el.style.position = 'relative'; el.innerHTML = C.legend(spec) + r.svg + '<div class="optch-tip" style="position:absolute;display:none;pointer-events:none;background:rgba(38,50,56,.94);color:#fff;font-size:12px;padding:6px 8px;border-radius:4px;white-space:nowrap;z-index:5"></div>';
            var svg = el.querySelector('svg'), tip = el.querySelector('.optch-tip'), cross = el.querySelector('.optch-x'), g = r.geo;
            svg.addEventListener('mousemove', function (ev) {
                var b = svg.getBoundingClientRect(), mx = (ev.clientX - b.left) * (g.W / b.width);
                if (mx < g.x0 || mx > g.x1) { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); return; }
                var t = g.t0 + (mx - g.x0) / (g.x1 - g.x0) * (g.t1 - g.t0), rows = C.at(spec, t);
                cross.setAttribute('x1', mx); cross.setAttribute('x2', mx); cross.setAttribute('visibility', 'visible');
                if (!rows.length) { tip.style.display = 'none'; return; }
                tip.innerHTML = '<div style="font-weight:bold;margin-bottom:3px">' + hhmm(t) + ' Uhr · ' + p2(new Date(t).getDate()) + '.' + p2(new Date(t).getMonth() + 1) + '.</div>' + rows.map(function (q) { return '<div><span style="display:inline-block;width:9px;height:9px;background:' + q.color + ';margin-right:6px"></span>' + esc(q.name) + ': <b>' + esc(q.text) + '</b></div>'; }).join('');
                tip.style.display = 'block';
                var tw = tip.offsetWidth, px = (ev.clientX - b.left) + 14; if (px + tw > b.width) { px = (ev.clientX - b.left) - tw - 14; }
                tip.style.left = Math.max(0, px) + 'px'; tip.style.top = Math.max(0, (ev.clientY - b.top) - 10 + (svg.getBoundingClientRect().top - el.getBoundingClientRect().top)) + 'px';
            });
            svg.addEventListener('mouseleave', function () { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
        } catch (e) { /* kein Diagramm, die Karte bleibt leer */ }
    };
    root.optChart = C;
    if (typeof module !== 'undefined' && module.exports) { module.exports = C; }
})(typeof window !== 'undefined' ? window : globalThis);

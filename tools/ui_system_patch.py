#!/usr/bin/env python3
"""Design-System v1 (17.10.2026, v1.5 ui-review 18.10.2026: Kern-Diagramme, Platzhalter, SYSTEM-Leiste; v1.6 ui-review-b 20.10.2026: Saeulenwerte): EIN Stil fuer Kern- und Optimierer-Seiten, nur Darstellung (CSS im globalen ui_template "UI-Optik (Kopfbereich)").
Aendert genau einen Knoten (ui_optik_kopf, format). Erwartet den Stand von ui_optik_patch.py (14.10.2026); --revert stellt ihn byte-genau wieder her.
Nutzung: ui_system_patch.py <flows_v2_export.json> --out <neu.json> [--revert | --zurueck-v15]
  --revert: zurueck auf den Stand 14.10. (ALT); --zurueck-v15: nur v1.6 zurueck auf v1.5 (Live-Stand seit 18.10.)
Was der Stil macht: Grundschrift 14 px ueberall (Kern bisher 16), Gruppentitel einheitlich (Kapitaelchen 12,5 px, Blau #00729f, Linie darunter),
Karten mit Rand und 8-px-Radius, Text-Widgets: Bezeichnung grau / Wert dunkel halbfett, Knoepfe umrandet statt vollflaechig, Tacho-/Diagrammtitel wie
Gruppentitel, Trennlinien hell. Ausgeblendet (nur CSS, Knoten bleiben): Hinweiszeilen der Kernseiten, Gruppe WARMWASSER (Anlage ohne Warmwasser).
"""
import json, sys
KOPF_ID = "ui_optik_kopf"
ALT = ("<style>\n/* UI-Optik 14.10.2026 (tools/ui_optik_patch.py): Gruppentitel im Blau der Kopfzeile, Kontrast 4,7:1 (vorher #1bbfff, 2,1:1) */\n"
       "body.nr-dashboard-theme ui-card-panel p.nr-dashboard-cardtitle{color:#007bb0}\n</style>")
HINWEISE = ["36a9b7dad9d2611e", "3adf2738c40e2c50", "032ca56c8c21283e", "b22da9fe52b286cf", "4d7236c464d1c14e"]   # "X-Achse…", "Im Heizkurven-Modus…", "Dieses Diagramm…", "Modus 0=…", "Die Tabelle wird…"
GRUPPEN_AUS = ["4e9e24cca215ad4d"]   # Einstellungen > WARMWASSER (kein Warmwasser an dieser Anlage)
V1 = "<style>\n/* Design-System v1 (17.10.2026, tools/ui_system_patch.py): ein Stil fuer Kern- und Optimierer-Seiten. Nur Darstellung. */\n" + "\n".join([
    ":root{--ds-text:#263238;--ds-mute:#546e7a;--ds-line:#e3e8eb;--ds-acc:#0094ce;--ds-acc-t:#00729f;--ds-bg:#f3f5f7}",
    "body.nr-dashboard-theme{font-size:14px;font-variant-numeric:tabular-nums;color:var(--ds-text)}",
    "body.nr-dashboard-theme #main,body.nr-dashboard-theme md-content.nr-dashboard-theme,body.nr-dashboard-theme .nr-dashboard-theme.md-content{background:var(--ds-bg)}",
    "body.nr-dashboard-theme md-toolbar h1,body.nr-dashboard-theme md-toolbar .md-toolbar-tools span{font-size:17px;font-weight:500}",
    "/* Karten und Gruppentitel */",
    "body.nr-dashboard-theme ui-card-panel{background:#fff;border:1px solid var(--ds-line);border-radius:8px;box-sizing:border-box}",
    "body.nr-dashboard-theme ui-card-panel p.nr-dashboard-cardtitle{color:var(--ds-acc-t);font-size:12.5px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;line-height:32px;height:32px;padding:0 8px;margin:0;border-bottom:1px solid var(--ds-line)}",
    "/* Text-, Zahl-, Schalter-Widgets */",
    "body.nr-dashboard-theme md-card .label,body.nr-dashboard-theme md-card p.label{color:var(--ds-mute);font-size:14px;font-weight:400}",
    "body.nr-dashboard-theme md-card .value,body.nr-dashboard-theme md-card p.value{color:var(--ds-text);font-size:14px;font-weight:600}",
    "body.nr-dashboard-theme .nr-dashboard-numeric .value,body.nr-dashboard-theme .nr-dashboard-dropdown md-select{font-size:14px;font-weight:600;color:var(--ds-text)}",
    "body.nr-dashboard-theme md-card hr{border-color:var(--ds-line);border-top-width:1px;opacity:1}",
    "body.nr-dashboard-theme md-card.nr-dashboard-template{color:var(--ds-text)}",
    "/* Knoepfe: umrandet statt vollflaechig */",
    "body.nr-dashboard-theme md-card.nr-dashboard-button md-button,body.nr-dashboard-theme md-card.nr-dashboard-button .md-button{background:#fff !important;color:var(--ds-acc-t) !important;border:1px solid #9ccfe6;border-radius:6px;box-shadow:none !important;font-size:12.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;min-height:32px;line-height:30px;margin:0 2px;padding:0 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "body.nr-dashboard-theme md-card.nr-dashboard-button md-button:hover,body.nr-dashboard-theme md-card.nr-dashboard-button .md-button:hover{background:#eef7fb !important}",
    "body.nr-dashboard-theme md-card.nr-dashboard-button md-button md-icon,body.nr-dashboard-theme md-card.nr-dashboard-button md-button i,body.nr-dashboard-theme md-card.nr-dashboard-button md-button .material-icons{color:var(--ds-acc-t) !important}",
    "/* Tacho und Diagramm (Titel wie Abschnitte) */",
    "body.nr-dashboard-theme .nr-dashboard-gauge-title,body.nr-dashboard-theme .nr-dashboard-chart-title,body.nr-dashboard-theme md-card .nr-dashboard-chart-titlediv,body.nr-dashboard-theme .nr-dashboard-chart .label{color:var(--ds-mute);font-size:12.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}",
    "/* Tabellen des Kerns (Effizienz) */",
    "body.nr-dashboard-theme .nr-dashboard-table .tabulator{font-size:13.5px}body.nr-dashboard-theme .nr-dashboard-table .tabulator .tabulator-header{background:#fff;border-bottom:2px solid #cfd8dc;color:#455a64;font-weight:600}",
    "/* Hinweiszeilen und unbenutzte Gruppe ausblenden (Knoten bleiben) */",
    ",".join("body.nr-dashboard-theme md-card[node-id=\"%s\"]" % i for i in HINWEISE) + "{display:none !important}",
    ",".join("body.nr-dashboard-theme ui-card-panel[node-id=\"%s\"]" % i for i in GRUPPEN_AUS) + "{display:none !important}",
    "/* Optimierer-Karten: Abschnittstitel in derselben Familie wie die Gruppentitel */",
    ".optfit .sec,.optp .sec,.optr .sec,.optev .evh{color:var(--ds-mute)}",
]) + "\n</style>"
V11 = V1.replace("Design-System v1 (17.10.2026", "Design-System v1.1 (18.10.2026").replace(
    "font-size:12.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;min-height:32px;line-height:30px;margin:0 2px;padding:0 10px;",
    "font-size:11.5px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;min-height:32px;line-height:30px;margin:0 2px;padding:0 6px;") + "<style>\n" + "\n".join([
    "/* v1.1: Seitenhintergrund, Abschnittstitel der Kern-Vorlagen (<hr><left>…</left>), Schieberegler-Beschriftung, Tabellenzebra */",
    "body.nr-dashboard-theme{background:#f3f5f7 !important}",
    "body.nr-dashboard-theme md-card.nr-dashboard-template>hr{border:0 !important;border-top:1px solid var(--ds-line) !important;box-shadow:none !important;margin:4px 0 0 !important}",
    "body.nr-dashboard-theme md-card.nr-dashboard-template>left{display:block;color:var(--ds-mute);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding-top:8px}",
    "body.nr-dashboard-theme md-card.nr-dashboard-slider p.label{min-width:84px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "body.nr-dashboard-theme md-card.nr-dashboard-numeric .label,body.nr-dashboard-theme md-card.nr-dashboard-switch .label{white-space:normal;line-height:1.25}",
    "body.nr-dashboard-theme .nr-dashboard-table .tabulator-row.tabulator-row-even{background:#f7f9fa}",
]) + "\n</style>"
V12_ZUSATZ = "<style>\n" + "\n".join([
    "/* v1.2: Knoepfe ohne Abschneiden, Schieberegler-Beschriftung, Dezimalkomma per Skript (nur Anzeige) */",
    "body.nr-dashboard-theme md-card.nr-dashboard-button md-button,body.nr-dashboard-theme md-card.nr-dashboard-button .md-button{font-size:11px;letter-spacing:0;padding:0 4px}",
    "body.nr-dashboard-theme md-card.nr-dashboard-slider p.label{flex:0 0 auto !important;max-width:46%;min-width:0;margin-right:8px}",
    "body.nr-dashboard-theme md-card.nr-dashboard-slider md-slider{flex:1 1 auto}",
]) + "\n</style>\n<script>\n(function () { /* Dezimalpunkt -> Komma in Text-Widgets des Kerns (z. B. 33.25 °C -> 33,25 °C); nur Werte, die eine Zahl mit Einheit sind */\n" \
    "var RE = /^(-?\\d+)\\.(\\d+)(\\s.*)?$/; function fix(el) { var t = el.textContent, m = RE.exec(t.trim()); if (m) { el.textContent = m[1] + ',' + m[2] + (m[3] || ''); } }\n" \
    "function sweep(root) { (root.querySelectorAll ? root.querySelectorAll('md-card.nr-dashboard-text p.value') : []).forEach(fix); }\n" \
    "var mo = new MutationObserver(function (ms) { ms.forEach(function (m) { if (m.type === 'characterData' || m.type === 'childList') { var n = m.target.nodeType === 3 ? m.target.parentNode : m.target; if (n && n.closest && n.closest('md-card.nr-dashboard-text p.value')) { fix(n.closest('p.value')); } else if (n && n.querySelectorAll) { sweep(n); } } }); });\n" \
    "function start() { sweep(document); mo.observe(document.body, {subtree: true, childList: true, characterData: true}); }\n" \
    "if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', start); } else { start(); } })();\n</script>"
V12 = V11.replace("Design-System v1.1 (18.10.2026", "Design-System v1.2 (18.10.2026") + V12_ZUSATZ
V13_ZUSATZ = "<style>\n" + "\n".join([
    "/* v1.3: Schieberegler-Beschriftung (Kern setzt width:0), Abschnittstitel auch in verschachtelten Vorlagen, leere Kopfzeile Uebersicht > Heizen */",
    "body.nr-dashboard-theme md-card.nr-dashboard-slider p.label{width:auto !important;min-width:72px}",
    "body.nr-dashboard-theme md-card.nr-dashboard-template hr{border:0 !important;border-top:1px solid var(--ds-line) !important;box-shadow:none !important;margin:4px 0 0 !important}",
    "body.nr-dashboard-theme md-card.nr-dashboard-template left{display:block;color:var(--ds-mute);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding-top:8px}",
    "body.nr-dashboard-theme md-card[node-id=\"719e11414721599e\"]{display:none !important}",
]) + "\n</style>"
V13 = V12.replace("Design-System v1.2 (18.10.2026", "Design-System v1.3 (18.10.2026") + V13_ZUSATZ
V14_ZUSATZ = "<style>\n" + "\n".join([
    "/* v1.4: Betrieb > Schieberegler-Beschriftungen (1 Einheit breite Textwidgets) duerfen ueberlaufen; Effizienz-Ueberschriften (<hr> + Text) als Abschnittstitel */",
    ",".join("body.nr-dashboard-theme md-card[node-id=\"%s\"]" % i for i in ("dc6b3a3d39fd9593", "0a5194a2ae53226f", "ee5c4cc82116fb3a")) + "{overflow:visible !important;z-index:2}",
    ",".join("body.nr-dashboard-theme md-card[node-id=\"%s\"] p.label" % i for i in ("dc6b3a3d39fd9593", "0a5194a2ae53226f", "ee5c4cc82116fb3a")) + "{overflow:visible;white-space:nowrap;font-size:12.5px}",
    ",".join("body.nr-dashboard-theme md-card[node-id=\"%s\"]" % i for i in ("b40c0f3e82728c9d", "6cce5b6bd4157c5b", "23aa1aeed6d15e49", "68cd36d3c50eaef1")) + "{color:var(--ds-mute);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding-top:6px}",
]) + "\n</style>"
V14 = V13.replace("Design-System v1.3 (18.10.2026", "Design-System v1.4 (18.10.2026") + V14_ZUSATZ
ZEITPLAN = "2b0c8e162d47abbb"          # Zeitplan > Gruppe mit den 10 Zeilen (Papierkorb-Knoepfe 1x1)
SYSKNOEPFE = "70a5fe6af8ed1d29"        # SYSTEM > Knopfleiste (Protokoll, Hardware, Sensoren, MQTT, Menue-Konfiguration, Systemzustand, Einstellungen, Hilfe)
V15_ZUSATZ = "<style>\n" + "\n".join([
    "/* v1.5 (ui-review 18.10.2026): leere Auswahlfelder als Platzhalter (grau, normal), Papierkorb ohne Rahmen, SYSTEM-Knopfleiste als Registerleiste */",
    "body.nr-dashboard-theme md-select-value.md-select-placeholder>span:first-child{color:#90a4ae;font-weight:400}",
    "body.nr-dashboard-theme md-card.nr-dashboard-textinput .md-input{border-bottom-color:#dfe5e8}",
    "body.nr-dashboard-theme ui-card-panel[node-id=\"" + ZEITPLAN + "\"] md-card.nr-dashboard-button[ui-card-size=\"1x1\"] .md-button{border-color:transparent;background:transparent !important}",
    "body.nr-dashboard-theme ui-card-panel[node-id=\"" + ZEITPLAN + "\"] md-card.nr-dashboard-button[ui-card-size=\"1x1\"] .md-button ui-icon,body.nr-dashboard-theme ui-card-panel[node-id=\"" + ZEITPLAN + "\"] md-card.nr-dashboard-button[ui-card-size=\"1x1\"] .md-button ng-md-icon svg{color:#90a4ae !important;fill:#90a4ae !important}",
    "body.nr-dashboard-theme ui-card-panel[node-id=\"" + ZEITPLAN + "\"] md-card.nr-dashboard-button[ui-card-size=\"1x1\"] .md-button:hover ng-md-icon svg{fill:#c62828 !important}",
    "body.nr-dashboard-theme ui-card-panel[node-id=\"" + SYSKNOEPFE + "\"]{border-width:0 0 1px 0;border-radius:0;background:transparent}",
    "body.nr-dashboard-theme ui-card-panel[node-id=\"" + SYSKNOEPFE + "\"] md-card.nr-dashboard-button .md-button{border-color:transparent;border-radius:0;background:transparent !important;color:var(--ds-mute) !important;border-bottom:2px solid transparent}",
    "body.nr-dashboard-theme ui-card-panel[node-id=\"" + SYSKNOEPFE + "\"] md-card.nr-dashboard-button .md-button:hover{color:var(--ds-acc-t) !important;border-bottom-color:var(--ds-acc)}",
    "body.nr-dashboard-theme ui-card-panel[node-id=\"" + SYSKNOEPFE + "\"] md-card{background:transparent !important;box-shadow:none !important}",
]) + "\n</style>\n<script>\n" + r"""(function () { /* v1.5: Kern-Diagramme (Chart.js) in Schrift, Farben und Zahlenformat des Design-Systems; Dezimalkomma auch in Tachos, Tabellen und Zahlenfeldern. Nur Anzeige. */
var FONT = getComputedStyle(document.body).fontFamily, MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
function de(v) { var n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null); return n === null ? v : n.toLocaleString('de-DE', {maximumFractionDigits: 2}); }
function kat(v) { var m = /^(\d{4})-(\d\d)$/.exec(v), d = /^(\d\d)-(\d\d)$/.exec(v); return m ? MON[+m[2] - 1] + ' ' + m[1].slice(2) : (d ? d[2] + '.' + d[1] + '.' : v); }
function stil(c) {
    if (!c || !c.options || c.$ds) { return; }
    c.$ds = true;
    var o = c.options, L = o.legend = o.legend || {}, gen = (window.Chart.defaults.global.legend.labels || {}).generateLabels;
    L.labels = L.labels || {}; L.labels.fontFamily = FONT; L.labels.fontSize = 12; L.labels.fontColor = '#455a64'; L.labels.boxWidth = 9; L.labels.padding = 8;
    if (gen) { L.labels.generateLabels = function (ch) { return gen(ch).map(function (l) { l.fillStyle = l.strokeStyle || l.fillStyle; l.lineWidth = 0; return l; }); }; }
    ['xAxes', 'yAxes'].forEach(function (ax) { ((o.scales || {})[ax] || []).forEach(function (s) {
        var t = s.ticks = s.ticks || {}; t.fontFamily = FONT; t.fontSize = 12; t.fontColor = '#546e7a';
        s.gridLines = s.gridLines || {}; s.gridLines.color = '#eceff1'; s.gridLines.zeroLineColor = '#cfd8dc';
        if (s.type === 'time' && s.time) { s.time.displayFormats = Object.assign({}, s.time.displayFormats, {second: 'HH:mm', minute: 'HH:mm', hour: 'HH:mm', day: 'DD.MM.'}); }
        var cb = t.callback;
        if (ax === 'yAxes') { t.callback = function (v, i, a) { var r = cb ? cb.call(this, v, i, a) : v; return (typeof v === 'number' && String(r) === String(v)) ? de(v) : r; }; }   // nur unformatierte Zahlen (eigene Formate der Knoten bleiben)
        else if (s.type !== 'time') { t.callback = function (v, i, a) { return kat(cb ? cb.call(this, v, i, a) : v); }; }
    }); });
    try { c.update(0); } catch (e) { /* bleibt wie es ist */ }
}
function sweep() { try { var I = (window.Chart && window.Chart.instances) || {}; Object.keys(I).forEach(function (k) { stil(I[k]); }); } catch (e) { /* nichts */ } }
if (window.Chart && window.Chart.defaults) { var g = window.Chart.defaults.global; g.defaultFontFamily = FONT; g.defaultFontColor = '#546e7a'; g.defaultFontSize = 12; }
sweep(); setInterval(sweep, 1500);
/* Dezimalkomma auch in Tachos (Wert), Tabellenzellen und Zahlenfeldern: nur reine Zahlen mit Dezimalpunkt, z. B. 5.55 -> 5,55, +1.5 -> +1,5; genau drei Nachkommastellen gelten als Tausenderpunkt (1.750 bleibt) */
var RE = /^([+\-\u2212]?\d+)\.(\d{1,2}|\d{4,})(\s.*)?$/, SEL = 'md-card:not(.nr-dashboard-template) svg text, md-card:not(.nr-dashboard-template) svg tspan, .tabulator-cell, md-card.nr-dashboard-numeric p.value';
function fix(el) { for (var n = el.firstChild; n; n = n.nextSibling) { if (n.nodeType === 3) { var m = RE.exec(n.nodeValue.trim()); if (m) { n.nodeValue = m[1] + ',' + m[2] + (m[3] || ''); } } } }
function lauf() { document.querySelectorAll(SEL).forEach(fix); }
lauf(); setInterval(lauf, 1500);
})();
</script>"""
V15 = V14 + V15_ZUSATZ
WERTE = ["eee624aa045ae22a", "8084f5f9211ba26e"]          # Effizienz > COP pro Monat, Erzeugte Waerme pro Monat: Wert an jeder Saeule
V16_ZUSATZ = "<script>\n" + r"""(function () { /* v1.6 (ui-review-b 20.10.2026): Werte an den Monatssaeulen (Effizienz), Saeulen hoechstens 40 px breit. Nur Anzeige, nur diese Diagramme. */
var C = window.Chart; if (!C || !C.plugins) { return; }
var FONT = getComputedStyle(document.body).fontFamily, WERTE = %s;
function de(v) { return Number(v).toLocaleString('de-DE', {maximumFractionDigits: 2}); }
function nid(c) { if (c.$dsId === undefined) { var cv = c.chart && c.chart.canvas, k = cv && cv.closest ? cv.closest('md-card') : null; c.$dsId = k ? k.getAttribute('node-id') : null; } return c.$dsId; }
C.plugins.register({
    beforeUpdate: function (c) {   /* wenige Monate: Saeulen nicht breiter als 40 px */
        try { if (WERTE.indexOf(nid(c)) >= 0) { ((c.options.scales || {}).xAxes || []).forEach(function (s) { s.barThickness = 40; }); } } catch (e) { /* nichts */ }
    },
    afterDraw: function (c) {
        try {
            if (WERTE.indexOf(nid(c)) < 0) { return; }
            var ctx = c.chart.ctx, a = c.chartArea; ctx.save(); ctx.font = '600 12px ' + FONT; ctx.textAlign = 'center';
            c.data.datasets.forEach(function (d, di) { var m = c.getDatasetMeta(di); if (m.hidden) { return; } m.data.forEach(function (el, i) {
                var v = d.data[i]; if (!(Number(v) > 0) || !el._model) { return; }
                var innen = el._model.y - a.top < 16; ctx.fillStyle = innen ? '#fff' : '#263238'; ctx.textBaseline = innen ? 'top' : 'bottom';
                ctx.fillText(de(v), el._model.x, innen ? el._model.y + 3 : el._model.y - 3); }); });
            ctx.restore();
        } catch (e) { /* Diagramm bleibt wie es ist */ }
    }
});
function sweep() { try { var I = C.instances || {}; Object.keys(I).forEach(function (k) { var c = I[k]; if (!c.$dsW && WERTE.indexOf(nid(c)) >= 0) { c.$dsW = true; c.update(0); } }); } catch (e) { /* nichts */ } }
sweep(); setInterval(sweep, 1500);
})();
""" % json.dumps(WERTE) + "</script>"
V16 = V15 + V16_ZUSATZ
NEU = V16

def main():
    a = sys.argv[1:]; revert = "--revert" in a; auf15 = "--zurueck-v15" in a; out = a[a.index("--out") + 1]
    d = json.load(open(a[0], encoding="utf-8")); fl = d["flows"]; k = next(n for n in fl if n["id"] == KOPF_ID)
    assert k["type"] == "ui_template" and k.get("templateScope") == "global"
    if auf15:                                                     # Rueckbau nur der Stufe v1.6 auf den Live-Stand v1.5
        assert k["format"] in (NEU, V15), "nicht auf v1.6/v1.5"
        k["format"] = V15
    elif not revert:
        assert k["format"] in (ALT, V1, V11, V12, V13, V14, V15), "Ausgangsstand weicht ab (ui_optik_kopf nicht auf einem bekannten Stand)"
        k["format"] = NEU
    else:
        assert k["format"] in (NEU, V15, V14, V13, V12, V11, V1), "nicht gepatcht"
        k["format"] = ALT
    json.dump(d, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("rev", d["rev"], "->", out, "(CSS", len(k["format"]), "Zeichen)")
if __name__ == "__main__":
    main()

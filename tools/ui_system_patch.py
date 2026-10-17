#!/usr/bin/env python3
"""Design-System v1 (17.10.2026): EIN Stil fuer Kern- und Optimierer-Seiten, nur Darstellung (CSS im globalen ui_template "UI-Optik (Kopfbereich)").
Aendert genau einen Knoten (ui_optik_kopf, format). Erwartet den Stand von ui_optik_patch.py (14.10.2026); --revert stellt ihn byte-genau wieder her.
Nutzung: ui_system_patch.py <flows_v2_export.json> --out <neu.json> [--revert]
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
NEU = V11.replace("Design-System v1.1 (18.10.2026", "Design-System v1.2 (18.10.2026") + V12_ZUSATZ

def main():
    a = sys.argv[1:]; revert = "--revert" in a; out = a[a.index("--out") + 1]
    d = json.load(open(a[0], encoding="utf-8")); fl = d["flows"]; k = next(n for n in fl if n["id"] == KOPF_ID)
    assert k["type"] == "ui_template" and k.get("templateScope") == "global"
    if not revert:
        assert k["format"] in (ALT, V1, V11), "Ausgangsstand weicht ab (ui_optik_kopf nicht auf dem Stand vom 14.10., v1 oder v1.1)"
        k["format"] = NEU
    else:
        assert k["format"] in (NEU, V11, V1), "nicht gepatcht"
        k["format"] = ALT
    json.dump(d, open(out, "w", encoding="utf-8"), ensure_ascii=False)
    print("rev", d["rev"], "->", out, "(CSS", len(k["format"]), "Zeichen)")
if __name__ == "__main__":
    main()

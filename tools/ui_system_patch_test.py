#!/usr/bin/env python3
"""Pruefungen fuer tools/ui_system_patch.py (v1.5 ui-review 18.10.2026, v1.6 ui-review-b 20.10.2026), offline mit einer kleinen Attrappe des Flow-Exports (nur lesen, temporaere Dateien).
1. ALT (14.10.) und jeder bekannte Zwischenstand (v1 ... v1.4) -> NEU; NEU -> --revert == ALT byte-genau; nur ui_optik_kopf aendert sich
2. unbekannter Ausgangsstand wird abgelehnt
3. das Skript der Stufe v1.5 laeuft in node: Zahlenformat der Achsen (nur unformatierte Zahlen), Monats-/Tagesbeschriftung, Dezimalkomma nur fuer reine Zahlen
4. v1.6 (ui-review-b): Saeulenwerte, --zurueck-v15 byte-genau; mit Live-Export als Argument zusaetzlich: v1.5 -> v1.6 aendert nur ui_optik_kopf, zurueck byte-gleich
Usage: python3 tools/ui_system_patch_test.py [flows_live.json]
"""
import importlib.util, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("usp", os.path.join(HERE, "ui_system_patch.py")); P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
ok = fail = 0
def check(name, cond, info=""):
    global ok, fail
    if cond: ok += 1; print("OK   " + name)
    else: fail += 1; print("FAIL " + name + ("  -> " + str(info) if info else ""))
def lauf(fmt, revert=False, extra=()):
    d = {"rev": "abc", "flows": [{"id": "x1", "type": "ui_template", "format": "<p>anders</p>"}, {"id": P.KOPF_ID, "type": "ui_template", "templateScope": "global", "format": fmt}]}
    with tempfile.TemporaryDirectory() as t:
        a, b = os.path.join(t, "a.json"), os.path.join(t, "b.json")
        json.dump(d, open(a, "w", encoding="utf-8"), ensure_ascii=False)
        r = subprocess.run([sys.executable, os.path.join(HERE, "ui_system_patch.py"), a, "--out", b] + (["--revert"] if revert else []) + list(extra), capture_output=True, text=True)
        return r.returncode, (json.load(open(b, encoding="utf-8")) if r.returncode == 0 else None)
stufen = [P.ALT, P.V1, P.V11, P.V12, P.V13, P.V14, P.V15]
res = [lauf(f) for f in stufen]
check("v1.6: ALT und jeder Zwischenstand v1…v1.5 -> NEU; der andere Knoten bleibt unveraendert", all(r[0] == 0 and r[1]["flows"][1]["format"] == P.NEU and r[1]["flows"][0]["format"] == "<p>anders</p>" for r in res), [r[0] for r in res])
rc, back = lauf(P.NEU, revert=True)
check("Revert: NEU -> ALT byte-genau (Stand 14.10.)", rc == 0 and back["flows"][1]["format"] == P.ALT, rc)
check("NEU = v1.5 + Zusatz v1.6, v1.5 = v1.4 + Zusatz v1.5 (aeltere Stufen unveraendert), Zusaetze ohne externe Quellen (kein http, kein src=)", P.NEU == P.V15 + P.V16_ZUSATZ and P.V15 == P.V14 + P.V15_ZUSATZ and all("http" not in z and "src=" not in z for z in (P.V15_ZUSATZ, P.V16_ZUSATZ)), "")
rc, back = lauf(P.NEU, extra=["--zurueck-v15"])
check("--zurueck-v15: NEU -> v1.5 byte-genau (Live-Stand seit 18.10.)", rc == 0 and back["flows"][1]["format"] == P.V15, rc)
rc2, _ = lauf("<style>fremd</style>")
check("unbekannter Ausgangsstand wird abgelehnt", rc2 != 0, rc2)
js = P.V15_ZUSATZ.split("<script>")[1].split("</script>")[0]
probe = r"""
var calls = 0, updated = 0;
function Chart() {} Chart.defaults = {global: {legend: {labels: {generateLabels: function () { return [{fillStyle: 'rgba(0,0,0,0)', strokeStyle: '#ef6c00', lineWidth: 2}]; }}}}};
var inst = {options: {legend: {}, scales: {xAxes: [{type: 'category', ticks: {}}, {type: 'time', time: {displayFormats: {second: 'HH:mm:ss'}}, ticks: {}}], yAxes: [{type: 'linear', ticks: {callback: function (v) { return v >= 1000 ? (v / 1000).toFixed(3) : v; }}}, {type: 'linear', ticks: {}}]}}, update: function () { updated++; }};
Chart.instances = {a: inst};
var els = [], txt = function (s) { return {nodeType: 3, nodeValue: s}; };
function el(s) { var n = txt(s); return {firstChild: n}; }
var cells = [el('5.71'), el('270.3'), el('2026-10'), el('26.5.1 Stable'), el('1.750 U/min')];
cells[2].firstChild.nextSibling = null;
global.window = {Chart: Chart}; global.getComputedStyle = function () { return {fontFamily: 'Fira Sans'}; };
global.document = {body: {}, querySelectorAll: function () { return cells; }};
global.setInterval = function () {};
(function () { %s })();
var y0 = inst.options.scales.yAxes[0].ticks.callback, y1 = inst.options.scales.yAxes[1].ticks.callback, x0 = inst.options.scales.xAxes[0].ticks.callback;
console.log(JSON.stringify({font: Chart.defaults.global.defaultFontFamily, upd: updated, leg: inst.options.legend.labels.generateLabels({})[0], y0a: y0(4000), y0b: y0(78.75), y1a: y1(78.75), y1b: y1(4000), x1: x0('2026-10'), x2: x0('10-18'), x3: x0('Montag'),
  tf: inst.options.scales.xAxes[1].time.displayFormats, cells: cells.map(function (c) { return c.firstChild.nodeValue; })}));
""" % js
r = subprocess.run(["node", "-e", probe], capture_output=True, text=True)
try: o = json.loads(r.stdout.strip().split("\n")[-1])
except Exception: o = None
check("Skript v1.5 (node): Schrift der Seite, Diagramm einmal aktualisiert, Legendenfarbe voll (Linienfarbe), keine Umrandung", o and o["font"] == "Fira Sans" and o["upd"] == 1 and o["leg"]["fillStyle"] == "#ef6c00" and o["leg"]["lineWidth"] == 0, r.stderr[-300:] if not o else o)
check("Skript v1.5: Wertachse 78.75 -> 78,75 und 4000 -> 4.000, eigenes Format eines Knotens (4.000) bleibt; Zeitachse ohne Sekunden", o and o["y1a"] == "78,75" and o["y1b"] == "4.000" and o["y0a"] == "4.000" and o["y0b"] == "78,75" and o["tf"]["second"] == "HH:mm" and o["tf"]["day"] == "DD.MM.", o)
check("Skript v1.5: Monats-/Tagesbeschriftung deutsch (2026-10 -> Okt 26, 10-18 -> 18.10.), anderer Text bleibt", o and o["x1"] == "Okt 26" and o["x2"] == "18.10." and o["x3"] == "Montag", o)
check("Skript v1.5: Dezimalkomma nur fuer reine Zahlen (5.71 -> 5,71, 270.3 -> 270,3); 2026-10, Versionsnummer und 1.750 U/min bleiben", o and o["cells"] == ["5,71", "270,3", "2026-10", "26.5.1 Stable", "1.750 U/min"], o)
# v1.6: Skript in node mit Attrappe (Chart.plugins, Leinwand im md-card mit node-id)
js16 = P.V16_ZUSATZ.split("<script>")[1].split("</script>")[0]
probe16 = r"""
var reg = [], texte = [], upd = 0;
function karte(id) { return {closest: function () { return {getAttribute: function () { return id; }}; }}; }
function chart(id, werte) { return {chart: {canvas: karte(id), ctx: {save: function () {}, restore: function () {}, fillText: function (t, x, y) { texte.push([id, t, x, y, this.fillStyle]); }}},
  chartArea: {top: 10}, options: {scales: {xAxes: [{}], yAxes: [{}]}}, data: {datasets: [{data: werte}]}, update: function () { upd++; },
  getDatasetMeta: function () { return {hidden: false, data: werte.map(function (v, i) { return {_model: {x: 100 + i * 50, y: i === 1 ? 15 : 120}}; })}; }}; }
var a = chart('eee624aa045ae22a', [0, 5.51, 4.2]), b = chart('fremd00000000000', [3, 4]);
global.window = {Chart: {plugins: {register: function (p) { reg.push(p); }}, instances: {1: a, 2: b}}};
global.getComputedStyle = function () { return {fontFamily: 'Fira Sans'}; }; global.document = {body: {}}; global.setInterval = function () {};
(function () { %s })();
reg.forEach(function (p) { [a, b].forEach(function (c) { p.beforeUpdate && p.beforeUpdate(c); p.afterDraw && p.afterDraw(c); }); });
console.log(JSON.stringify({n: reg.length, upd: upd, bt: [a.options.scales.xAxes[0].barThickness, b.options.scales.xAxes[0].barThickness], texte: texte}));
""" % js16
r = subprocess.run(["node", "-e", probe16], capture_output=True, text=True)
try: o = json.loads(r.stdout.strip().split("\n")[-1])
except Exception: o = None
check("Skript v1.6 (node): ein Plugin, nur das Monatsdiagramm einmal nachgezeichnet, Saeulen 40 px, fremdes Diagramm unberuehrt", o and o["n"] == 1 and o["upd"] == 1 and o["bt"] == [40, None], r.stderr[-300:] if not o else o)
check("Skript v1.6: Werte mit Komma an den Saeulen (0 ohne Wert), oben anstossende Saeule mit weissem Wert innen", o and [t[1] for t in o["texte"]] == ["5,51", "4,2"] and o["texte"][0][4] == "#fff" and o["texte"][1][4] == "#263238" and o["texte"][1][3] == 117, o)
if len(sys.argv) > 1:   # gegen den Live-Export: v1.5 -> v1.6 nur ui_optik_kopf, zurueck byte-gleich
    with tempfile.TemporaryDirectory() as t:
        raw = open(sys.argv[1], encoding="utf-8").read(); L = json.loads(raw)
        a, b, c = (os.path.join(t, x) for x in ("a.json", "b.json", "c.json")); open(a, "w", encoding="utf-8").write(raw)
        r1 = subprocess.run([sys.executable, os.path.join(HERE, "ui_system_patch.py"), a, "--out", b], capture_output=True, text=True)
        r2 = subprocess.run([sys.executable, os.path.join(HERE, "ui_system_patch.py"), b, "--out", c, "--zurueck-v15"], capture_output=True, text=True)
        B = json.load(open(b, encoding="utf-8")); LA = {n["id"]: n for n in L["flows"]}; BA = {n["id"]: n for n in B["flows"]}
        diff = sorted(i for i in set(LA) | set(BA) if LA.get(i) != BA.get(i))
        check("Live-Export: Ausgang ist v1.5, nach dem Patch v1.6, nur ui_optik_kopf geaendert, rev gleich", LA[P.KOPF_ID]["format"] == P.V15 and BA[P.KOPF_ID]["format"] == P.NEU and diff == [P.KOPF_ID] and B["rev"] == L["rev"], diff)
        check("Live-Export: --zurueck-v15 ergibt die Datei byte-gleich", r2.returncode == 0 and open(c, encoding="utf-8").read() == raw, r2.stdout + r2.stderr)
print("\nERGEBNIS ui_system_patch_test: %d OK, %d FAIL" % (ok, fail)); sys.exit(1 if fail else 0)

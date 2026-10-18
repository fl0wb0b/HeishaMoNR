#!/usr/bin/env python3
"""Pruefungen fuer tools/ui_system_patch.py (v1.5, ui-review 18.10.2026), offline mit einer kleinen Attrappe des Flow-Exports (nur lesen, temporaere Dateien).
1. ALT (14.10.) und jeder bekannte Zwischenstand (v1 ... v1.4) -> NEU; NEU -> --revert == ALT byte-genau; nur ui_optik_kopf aendert sich
2. unbekannter Ausgangsstand wird abgelehnt
3. das Skript der Stufe v1.5 laeuft in node: Zahlenformat der Achsen (nur unformatierte Zahlen), Monats-/Tagesbeschriftung, Dezimalkomma nur fuer reine Zahlen
Usage: python3 tools/ui_system_patch_test.py
"""
import importlib.util, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("usp", os.path.join(HERE, "ui_system_patch.py")); P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
ok = fail = 0
def check(name, cond, info=""):
    global ok, fail
    if cond: ok += 1; print("OK   " + name)
    else: fail += 1; print("FAIL " + name + ("  -> " + str(info) if info else ""))
def lauf(fmt, revert=False):
    d = {"rev": "abc", "flows": [{"id": "x1", "type": "ui_template", "format": "<p>anders</p>"}, {"id": P.KOPF_ID, "type": "ui_template", "templateScope": "global", "format": fmt}]}
    with tempfile.TemporaryDirectory() as t:
        a, b = os.path.join(t, "a.json"), os.path.join(t, "b.json")
        json.dump(d, open(a, "w", encoding="utf-8"), ensure_ascii=False)
        r = subprocess.run([sys.executable, os.path.join(HERE, "ui_system_patch.py"), a, "--out", b] + (["--revert"] if revert else []), capture_output=True, text=True)
        return r.returncode, (json.load(open(b, encoding="utf-8")) if r.returncode == 0 else None)
stufen = [P.ALT, P.V1, P.V11, P.V12, P.V13, P.V14]
res = [lauf(f) for f in stufen]
check("v1.5: ALT und jeder Zwischenstand v1…v1.4 -> NEU; der andere Knoten bleibt unveraendert", all(r[0] == 0 and r[1]["flows"][1]["format"] == P.NEU and r[1]["flows"][0]["format"] == "<p>anders</p>" for r in res), [r[0] for r in res])
rc, back = lauf(P.NEU, revert=True)
check("Revert: NEU -> ALT byte-genau (Stand 14.10.)", rc == 0 and back["flows"][1]["format"] == P.ALT, rc)
check("NEU = v1.4 + Zusatz v1.5 (aeltere Stufen unveraendert), Zusatz enthaelt keine externen Quellen (kein http, kein src=)", P.NEU == P.V14 + P.V15_ZUSATZ and "http" not in P.V15_ZUSATZ and "src=" not in P.V15_ZUSATZ, "")
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
print("\nERGEBNIS ui_system_patch_test: %d OK, %d FAIL" % (ok, fail)); sys.exit(1 if fail else 0)

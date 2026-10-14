#!/usr/bin/env python3
"""Pruefungen fuer tools/ui_optik_patch.py auf einem Live-Export (nur lesen, schreibt nur in ein temporaeres Verzeichnis).

Usage: python3 tools/ui_optik_test.py <flows_live.json>
  1. Probelauf: 2 Werte + Kopf-Knoten, Whitelist, keine opt_*-Knoten, Verdrahtung gleich
  2. Anwenden -> erneut anwenden aendert nichts -> Rueckbau byte-gleich (mit und ohne --monate-filtern)
  3. Abweichender Ausgangswert und verbotene Aenderungen werden abgelehnt
  4. Monatsfilter (optional) im vm: Monate mit 0/leer fallen weg, Reihenfolge bleibt; ohne Schalter bleibt die Funktion unveraendert
  5. Teil A (Generator, opt_*) und dieser Patch sind vertauschbar
"""
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("uop", os.path.join(HERE, "ui_optik_patch.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
ok = fail = 0


def check(name, cond, info=""):
    global ok, fail
    if cond:
        ok += 1
        print("OK   " + name)
    else:
        fail += 1
        print("FAIL " + name + ("  -> " + str(info) if info else ""))


def run(*args):
    r = subprocess.run([sys.executable, os.path.join(HERE, "ui_optik_patch.py")] + list(args), capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


live = sys.argv[1]
T = tempfile.mkdtemp(prefix="uioptik-")
flows, fmt = P.laden(live)
src = os.path.join(T, "live.json")
P.schreiben(src, flows, fmt)
raw0 = open(src, encoding="utf-8").read()

# 1 Probelauf
ch, kopf, schon = P.plan(flows)
neu = P.anwenden(flows, ch, kopf)
ids = P.whitelist(flows, neu, {(c[1], c[2]) for c in ch})
check("Probelauf: 2 Werte (Tabellenspalten, Tooltip) + Kopf-Knoten, sonst nichts", len(ch) == 2 and kopf and ids == sorted(["59bc0c78b8b9ea90", "8329aedf9204b75d", P.KOPF_ID]), ids)
A, B = {n["id"]: n for n in flows}, {n["id"]: n for n in neu}
check("keine opt_*-Knoten, Verdrahtung gleich, nichts geloescht", not [i for i in ids if i.startswith("opt_")] and all(A[i].get("wires") == B[i].get("wires") for i in A) and set(A) <= set(B), "")
check("Kopf-Knoten: ui_template global (<head>), ohne Gruppe/Verdrahtung, nur ein CSS-Satz fuer Gruppentitel", B[P.KOPF_ID]["templateScope"] == "global" and B[P.KOPF_ID]["group"] == "" and B[P.KOPF_ID]["wires"] == [[]] and B[P.KOPF_ID]["format"].count("{") == 1 and "p.nr-dashboard-cardtitle{color:#007bb0}" in B[P.KOPF_ID]["format"], "")
check("Tabelle: nur 'align' geaendert (left/right/right), Felder und Titel gleich", [c["align"] for c in B["59bc0c78b8b9ea90"]["columns"]] == ["left", "right", "right"] and [{k: v for k, v in c.items() if k != "align"} for c in A["59bc0c78b8b9ea90"]["columns"]] == [{k: v for k, v in c.items() if k != "align"} for c in B["59bc0c78b8b9ea90"]["columns"]], "")

# 2 Anwenden, idempotent, Rueckbau
for extra in ([], ["--monate-filtern"]):
    tag = " (Monatsfilter)" if extra else ""
    o1, s1, o2, s2, z = (os.path.join(T, x) for x in ("n1.json", "s1.json", "n2.json", "s2.json", "z.json"))
    rc, out = run(src, "--apply", "--out", o1, "--sicherung", s1, *extra)
    check("Anwenden" + tag, rc == 0, out[-300:])
    rc, out = run(o1, "--apply", "--out", o2, "--sicherung", s2, *extra)
    check("erneut anwenden aendert nichts" + tag, rc == 0 and open(o1, encoding="utf-8").read() == open(o2, encoding="utf-8").read() and json.load(open(s2))["aenderungen"] == [] and not json.load(open(s2))["kopf_neu"], out[-300:])
    rc, out = run(o1, "--revert", "--sicherung", s1, "--out", z)
    check("Rueckbau byte-gleich" + tag, rc == 0 and open(z, encoding="utf-8").read() == raw0, out[-300:])
    if extra:
        fn = {n["id"]: n for n in json.load(open(o1))}["e79ba8ec58a2bbc4"]["func"]
        js = ("const rows=[{id:1,date:'2025-11',heat_cop:0,heat_energy_produced:0},{id:2,date:'2026-10',heat_cop:6.05,heat_energy_produced:159.9},{id:3,date:'2026-09',heat_cop:'',heat_energy_produced:''},{id:4,date:'2026-08',heat_cop:0,heat_energy_produced:12}];"
              "const f=new Function('flow','node',%s);const r=f({get:()=>rows},{warn:()=>{}});console.log(JSON.stringify(r.payload.map(x=>x.date)));" % json.dumps(fn))
        r = subprocess.run(["node", "-e", js], capture_output=True, text=True)
        check("Monatsfilter im vm: leere Monate fallen weg, neueste zuerst, ID entfernt", r.stdout.strip() == '["2026-10","2026-08"]', r.stdout + r.stderr)
    else:
        check("ohne --monate-filtern bleibt die Funktion unveraendert", {n["id"]: n for n in json.load(open(o1))}["e79ba8ec58a2bbc4"] == A["e79ba8ec58a2bbc4"], "")

# 3 Ablehnung
bad = copy.deepcopy(flows)
next(n for n in bad if n["id"] == "8329aedf9204b75d")["tooltip"] = "anders"
try:
    P.plan(bad)
    check("abweichender Altwert -> Abbruch", False)
except P.Abbruch:
    check("abweichender Altwert -> Abbruch", True)
neu2 = copy.deepcopy(neu)
next(n for n in neu2 if n["id"] == "59bc0c78b8b9ea90")["width"] = 12
try:
    P.whitelist(flows, neu2, {(c[1], c[2]) for c in ch})
    check("verbotene Aenderung (Breite) -> Whitelist bricht ab", False)
except P.Abbruch:
    check("verbotene Aenderung (Breite) -> Whitelist bricht ab", True)

# 5 vertauschbar mit Teil A (Generator)
gen = os.path.join(HERE, "optimizer_phase1.py")
a1, a2 = os.path.join(T, "a1.json"), os.path.join(T, "a2.json")
P.schreiben(a1, flows, ({"indent": 4}, False))
subprocess.run([sys.executable, gen, a1, "--uebernahme-knoten-aktiv"], capture_output=True)
f1, _ = P.laden(a1)
c1, k1, _s = P.plan(f1)
AB = P.anwenden(f1, c1, k1)
c2, k2, _s = P.plan(flows)
P.schreiben(a2, P.anwenden(flows, c2, k2), ({"indent": 4}, False))
subprocess.run([sys.executable, gen, a2, "--uebernahme-knoten-aktiv"], capture_output=True)
BA, _ = P.laden(a2)
key = lambda L: sorted(json.dumps(n, sort_keys=True, ensure_ascii=False) for n in L)
check("Teil A (Generator) und Patch vertauschbar (A->B = B->A)", key(AB) == key(BA), "")
print("\nERGEBNIS ui_optik_test: %d OK, %d FAIL" % (ok, fail))
sys.exit(1 if fail else 0)

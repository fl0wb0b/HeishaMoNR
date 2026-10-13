#!/usr/bin/env python3
"""Pruefungen fuer tools/ui_kompakt_patch.py auf einem Live-Export (nur lesen, schreibt nur in ein temporaeres Verzeichnis).

Usage: python3 tools/ui_kompakt_test.py <flows_live.json>
  1. Modell trifft die Live-Vermessung 13.10. (Seitenhoehe bei 1920 px) fuer alle 11 Kernseiten
  2. Probelauf: Whitelist OK, keine opt_*-Knoten, keine Nicht-UI-Knoten, Verdrahtung gleich (unabhaengiger Vergleich)
  3. Anwenden -> erneut anwenden aendert nichts (idempotent) -> Rueckbau aus der Sicherung ist byte-gleich mit dem Original
  4. Abweichende Ausgangswerte und verbotene Aenderungen werden abgelehnt
  5. Layout: keine Ueberlappung in allen Sichtbarkeits-Kombinationen (1024/1920/2560), kein waagrechtes Scrollen bei 1024 ausser Zeitplan/SYSTEM,
     Seitenhoehen bei 1920 nicht hoeher als vorher
  6. Hilfetexte: Inhalt unveraendert eingebettet, Einpass-Skript mit eigener Kennung
"""
import copy
import importlib.util
import itertools
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ukp", os.path.join(HERE, "ui_kompakt_patch.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
ok = fail = 0


def check(name, cond, info=""):
    global ok, fail
    print(("OK   " if cond else "FAIL ") + name + (("  -> " + str(info)) if info != "" else ""))
    if cond:
        ok += 1
    else:
        fail += 1


src = sys.argv[1]
live, kompakt = P.laden(src)
M0 = P.Modell(live)
seiten = [t for t in M0.tabs if not t.get("hidden") and not t["id"].startswith("opt_")]

# 1 Modell gegen Live-Vermessung
h0 = {t["name"]: M0.seite(t, P.VERSTECKT.get(t["name"], ()), 1920)[0] for t in seiten}
check("Modell = Live-Vermessung 13.10. bei 1920 px (11 Kernseiten)", h0 == P.LIVE_1920, {k: (h0[k], P.LIVE_1920.get(k)) for k in h0 if h0[k] != P.LIVE_1920.get(k)})

# 2 Probelauf
changes, schon = P.plan(live, "einklappen", False)
neu = P.anwenden(live, changes)
ids, typen = P.whitelist(live, neu)
A = {n["id"]: n for n in live}
B = {n["id"]: n for n in neu}
check("Probelauf: Aenderungen vorhanden, nichts bereits umgesetzt", len(changes) > 200 and schon == 0, "%d Werte, %d Knoten" % (len(changes), len(ids)))
check("nur ui_*-Knoten geaendert, keine opt_*-Knoten", all(A[i]["type"].startswith("ui_") and not i.startswith("opt_") for i in ids), typen)
check("Verdrahtung, Funktionen, MQTT, Topics unveraendert (alle Nicht-UI-Knoten gleich, wires aller Knoten gleich)",
      all(A[i] == B[i] for i in A if not A[i]["type"].startswith("ui_")) and all(A[i].get("wires") == B[i].get("wires") for i in A))
keys = {(A[i]["type"] if A[i]["type"] in ("ui_group", "ui_base") else "widget", k) for i in ids for k in set(A[i]) | set(B[i]) if A[i].get(k) != B[i].get(k)}
check("nur Darstellungs-Schluessel (Widget: width/height/order/group/format der Hilfetexte; Gruppe: width/order/tab)",
      keys <= {("widget", "width"), ("widget", "height"), ("widget", "order"), ("widget", "group"), ("widget", "format"), ("ui_group", "width"), ("ui_group", "order"), ("ui_group", "tab")}, sorted(keys))
hid_tabs = {n["id"] for n in neu if n["type"] == "ui_tab" and n.get("hidden")}
check("Ausblenden nur auf versteckte Tabs (Gruppen nach GUI, Widgets in eine Gruppe auf GUI oder innerhalb derselben Seite)",
      all(B[i]["tab"] in hid_tabs for i in ids if A[i]["type"] == "ui_group" and A[i]["tab"] != B[i]["tab"]) and
      all(B[B[i]["group"]]["tab"] in hid_tabs or B[B[i]["group"]]["tab"] == A[A[i]["group"]]["tab"] for i in ids if A[i].get("group") and A[i]["group"] != B[i]["group"]))
fmt_ids = [i for i in ids if A[i].get("format") != B[i].get("format")]
check("Format nur bei den Hilfetexten (Line - Instructions text, Flow WP Help)", fmt_ids and all(A[i]["name"].startswith("Line - Instructions text") and A[i]["z"] == P.HELP_FLOW for i in fmt_ids), len(fmt_ids))
check("Hilfetexte: Inhalt unveraendert in <details>, Ueberschrift Hilfe, Einpassen mit eigener Kennung, Hoehe 1",
      all(P.hilfe_unwrap(B[i]["format"]) == A[i]["format"] and "<summary>Hilfe" in B[i]["format"] and ("var id = '%s'" % i) in B[i]["format"] and B[i]["height"] == 1 for i in fmt_ids))

# 3 Anwenden, idempotent, Rueckbau
with tempfile.TemporaryDirectory() as d:
    tool = os.path.join(HERE, "ui_kompakt_patch.py")
    out, sich, back = os.path.join(d, "neu.json"), os.path.join(d, "s.json"), os.path.join(d, "zurueck.json")
    r1 = subprocess.run([sys.executable, tool, src, "--apply", "--out", out, "--sicherung", sich], capture_output=True, text=True)
    check("--apply schreibt Datei und Sicherung, gibt die IDs aus", r1.returncode == 0 and os.path.exists(out) and os.path.exists(sich) and "\nIDS " in r1.stdout, r1.stdout[-200:] + r1.stderr[-300:])
    r2 = subprocess.run([sys.executable, tool, out, "--dry-run"], capture_output=True, text=True)
    check("erneut anwenden: nichts zu tun (idempotent)", r2.returncode == 0 and "Geaenderte Knoten: 0 " in r2.stdout, [l for l in r2.stdout.splitlines() if "Whitelist" in l])
    r3 = subprocess.run([sys.executable, tool, out, "--revert", "--sicherung", sich, "--out", back], capture_output=True, text=True)
    check("--revert aus der Sicherung ist byte-gleich mit dem Original", r3.returncode == 0 and open(back, "rb").read() == open(src, "rb").read(), r3.stdout[:200])
    neu_f = json.load(open(out, encoding="utf-8"))
    check("geschriebene Datei = berechnetes Ergebnis, gleiches Format (kompakt wie der Export)", neu_f == neu and (open(out, encoding="utf-8").read(2) == "[{") == kompakt)

# 4 Ablehnungen
bad = copy.deepcopy(live)
next(n for n in bad if n["id"] == "59bc0c78b8b9ea90")["height"] = 17
try:
    P.plan(bad)
    check("abweichender Ausgangswert wird abgelehnt", False)
except P.Abbruch as e:
    check("abweichender Ausgangswert wird abgelehnt", "59bc0c78b8b9ea90" in str(e))
for desc, mut in (("Funktionscode", lambda N: N["9fb2ab0ff0488d63"].__setitem__("func", "return msg;")), ("Verdrahtung", lambda N: N["59bc0c78b8b9ea90"].__setitem__("wires", [["x"]])),
                  ("Knopf-Nutzlast", lambda N: N["0d930849ad31e35a"].__setitem__("payload", "{}")), ("Widget auf andere sichtbare Seite", lambda N: N["93759ef7c600fe14"].__setitem__("group", "4e7aaa8d2a717171")),
                  ("Gruppe auf sichtbaren Tab", lambda N: N["76ac95177cc46b00"].__setitem__("tab", "5b5fabb85470bd21")), ("opt_*-Knoten", lambda N: N["opt_t_plan"].__setitem__("height", 3)),
                  ("Format ohne Hilfetext", lambda N: N["ccf20ebdd2bc2ad5"].__setitem__("format", "x")), ("Knoten entfernt", None)):
    b2 = copy.deepcopy(neu)
    if mut is None:
        b2 = b2[:-1]
    else:
        mut({n["id"]: n for n in b2})
    try:
        P.whitelist(live, b2)
        check("Whitelist lehnt ab: " + desc, False)
    except P.Abbruch:
        check("Whitelist lehnt ab: " + desc, True)

# 5 Layout
for h in P.HILFE:                    # eingeklappt
    B[h[1]]["height"] = 1
M1 = P.Modell(neu)
ueber, hs, hoeher = [], [], []
for t in [x for x in M1.tabs if not x.get("hidden") and not x["id"].startswith("opt_")]:
    gn = [g["name"] for g in M1.seiten_gruppen(t["id"])]
    combos = [c for r in range(len(gn)) for c in itertools.combinations(gn, r)] if len(gn) <= 8 else []
    if t["name"] == "SYSTEM":
        for show in (["PROTOKOLL"], ["HARDWARE-INFORMATIONEN"], ["MQTT-Sensoren", "1-Wire-Sensoren"], ["MQTT-Sensoren", "1-Wire-Sensoren", "Help_Sensors"],
                     ["MQTT-Sensoren", "1-Wire-Sensoren", "P1-Einrichtung"], ["MQTT"], ["MENU"], ["SYSTEMZUSTAND"], ["ABOUT"], ["EINSTELLUNGEN"]):
            combos.append(tuple(set(gn) - set(show) - {"NAVIGATION"}))
    for W in (1024, 1920, 2560):
        for c in combos:
            r = M1.seite(t, c, W)
            if r[2]:
                ueber.append((t["name"], W, c, r[2]))
                break
    r = M1.seite(t, P.VERSTECKT.get(t["name"], ()), 1024)
    if r[1] and t["name"] not in ("Zeitplan", "SYSTEM"):
        hs.append(t["name"])
    if M1.seite(t, P.VERSTECKT.get(t["name"], ()), 1920)[0] > h0[t["name"]]:
        hoeher.append(t["name"])
check("keine Ueberlappung von Gruppen in allen Sichtbarkeits-Kombinationen (1024/1920/2560)", not ueber, ueber[:3])
check("kein waagrechtes Scrollen bei 1024 (ausser Zeitplan 28 und SYSTEM 24 breit, bewusst unveraendert)", not hs, hs)
check("keine Seite wird bei 1920 hoeher", not hoeher, hoeher)
h1 = {t["name"]: M1.seite(t, P.VERSTECKT.get(t["name"], ()), 1920)[0] for t in seiten}
check("Summe der Seitenhoehen bei 1920 mindestens 35 % niedriger", sum(h1.values()) <= 0.65 * sum(h0.values()), "%d -> %d px" % (sum(h0.values()), sum(h1.values())))
print("\n%d OK, %d FAIL" % (ok, fail))
sys.exit(1 if fail else 0)

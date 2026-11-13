#!/usr/bin/env python3
"""ERLEDIGTER EINMAL-TEST: tools/uebersicht_doppelwerte.py ist seit 07.11.2026 auf der Anlage eingespielt. Dieser Test braucht einen Flow-Export VOR dem Patch;
auf dem heutigen Live-Stand endet er mit Meldung und Rueckgabewert 3 (tools/einmal_test.py), nicht mit einem Fehler.

Check fuer tools/uebersicht_doppelwerte.py auf einer Kopie der Live-Flows.

Usage: python3 tools/uebersicht_doppelwerte_test.py <live-liste.json>
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import uebersicht_doppelwerte as u

import einmal_test

flows = json.load(open(einmal_test.flows_argument("uebersicht_doppelwerte_test"), encoding="utf-8"))
if isinstance(flows, dict):                          # Export im v2-Format {"flows": [...], "rev": ...}
    flows = flows.get("flows", flows)
_vor = {n["id"]: n for n in flows}
if all(_vor.get(i, {}).get("group") == u.HIDDEN for i in u.HIDE) and str(_vor.get(u.GROUP, {}).get("width")) == "6":
    einmal_test.erledigt("uebersicht_doppelwerte_test", "tools/uebersicht_doppelwerte.py", "07.11.2026",
                         "die doppelten Werte sind schon ausgeblendet und die Gruppe ist schon einspaltig")
flows = flows["flows"] if isinstance(flows, dict) else flows
before = copy.deepcopy(flows)

assert u.apply(flows) is True
by = {n["id"]: n for n in flows}
assert all(by[i]["group"] == u.HIDDEN for i in u.HIDE)
assert by[u.GROUP]["width"] == "6"
left = sorted(n.get("label") or n.get("name") for n in flows
              if n.get("group") == u.GROUP and n["type"] != "ui_template")
print("bleibt in WAERMEPUMPE:", left)
for keep in ("Wärmepumpe", "Aktuell", "Ventilstellung", "Nachtabsenkung", "Sanftanlauf"):
    assert keep in left, keep

# nur group/width geaendert, keine Verdrahtung, kein Knoten weg oder neu
old = {n["id"]: n for n in before}
assert set(old) == set(by)
for i, n in by.items():
    diff = {k for k in set(n) | set(old[i]) if n.get(k) != old[i].get(k)}
    assert diff <= {"group", "width"}, (i, diff)

assert u.apply(flows) is False          # zweiter Lauf: unveraendert
print("OK")
print("\nERGEBNIS uebersicht_doppelwerte_test: bestanden")

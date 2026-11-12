#!/usr/bin/env python3
"""Check fuer tools/uebersicht_doppelwerte.py auf einer Kopie der Live-Flows.

Usage: python3 tools/uebersicht_doppelwerte_test.py <live-liste.json>
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import uebersicht_doppelwerte as u

flows = json.load(open(sys.argv[1], encoding="utf-8"))
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

#!/usr/bin/env python3
"""Uebersicht: Werte, die Anlagenschema und Kacheln schon zeigen, aus der Gruppe WAERMEPUMPE ausblenden.

Die Widgets wandern in die vorhandene versteckte Gruppe (Muster aus tools/heating_only_de.py:
nichts wird geloescht, die Verdrahtung bleibt). Die Gruppe WAERMEPUMPE wird einspaltig (Breite 6),
es bleiben Schalter, Betriebsart und Zusatzfunktionen. Idempotent.

Usage: python3 tools/uebersicht_doppelwerte.py <flows.json>   (Liste von Knoten)
"""
import json
import sys

GROUP = "bf4af523ba16d457"        # WAERMEPUMPE auf der Uebersicht
HIDDEN = "a1c0b0000c0f0020"       # versteckte Gruppe auf dem Tab GUI
HIDE = {
    "a1c0b0000c0f0011": "COP (Heizen)",          # Kachel COP
    "a1c0b0000c0f0041": "Aussentemperatur",      # Schema Aussen (Fuehler), gleicher Wert TOP14
    "46b7fe12f60ad08b": "Linie Wassertemperatur",
    "521e419dae5882e7": "Vorlauf Soll",          # Schema Soll
    "1d51b425fba024d2": "Vorlauf Ist",           # Schema Vorlauf
    "3478273eb4693d84": "Ruecklauf Ist",         # Schema Ruecklauf
    "0e09d25e4fd17042": "Durchfluss l/min",      # Schema Pumpe l/min
    "91fcc102b422de3b": "Frequenz Hz",           # Schema Verdichter
    "592f552754e017f5": "Linie ohne Titel",
    "79dc18dd1cca1e73": "Laufzeit Verdichter",   # Kachel Laufzeit
    "1ed98a1d47eb56f0": "Luefter 1",             # Schema Luefter
    "3ac59d9a6138e620": "Pumpendrehzahl",        # Schema Pumpe U/min
    "2ae1f0e14435e803": "Heizstab intern (Text)",  # Schema Heizstab, Fusszeile
    "cb32ff75cb09ea95": "Heizstab intern (Wert)",
}


def apply(flows):
    by = {n["id"]: n for n in flows}
    missing = [i for i in [GROUP, HIDDEN, *HIDE] if i not in by]
    if missing:
        raise SystemExit("nicht gefunden, nichts geaendert: " + ", ".join(missing))
    changed = False
    for i in HIDE:
        if by[i]["group"] not in (GROUP, HIDDEN):
            raise SystemExit("%s (%s) steckt in Gruppe %s, nichts geaendert" % (i, HIDE[i], by[i]["group"]))
    for i in HIDE:
        if by[i]["group"] != HIDDEN:
            by[i]["group"] = HIDDEN
            changed = True
    if by[GROUP].get("width") != "6":
        by[GROUP]["width"] = "6"
        changed = True
    return changed


if __name__ == "__main__":
    path = sys.argv[1]
    flows = json.load(open(path, encoding="utf-8"))
    changed = apply(flows)
    if changed:
        json.dump(flows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    print("ok" if changed else "unveraendert")

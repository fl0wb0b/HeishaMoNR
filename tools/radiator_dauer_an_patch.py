#!/usr/bin/env python3
"""Kinderzimmer-Radiator: Zwangs-AUS nach 20 min Dauer-EIN entschaerfen (20 min an / 5 min aus, auch nachts bei Raum 2 K unter Soll).

Auf Wunsch des Nutzers (Tab "Dashboard", Knoten a0f2936bcfe99ce0 "CTRL Radiator (RPC)"): der Radiator soll an bleiben, solange der Raum warm werden soll.
Die Sicherung "failsafe maxOn" bleibt als Notbremse, wird aber von 20 min auf 6 h angehoben. Alles andere (Hysterese 22,7/23,3, 5 min Sperre zwischen EIN,
Abtauen, Vorlauf < 25 C, veraltete Werte, WP-Leistung bzw. Pausenmodus) bleibt unveraendert.

Aufruf:   python3 radiator_dauer_an_patch.py flows.json [--revert|--check]   (Exit bei --check: 0 drin, 1 nicht drin, 2 Anker fehlen)
"""
import json
import sys

NODE_ID = "a0f2936bcfe99ce0"
MARK = "// DAUER-AN (Nutzerwunsch)"
OLD = "const maxOnMs     = 20 * 60 * 1000;\n"
NEW = ("const maxOnMs     = 6 * 60 * 60 * 1000;   " + MARK + ": Zwangs-AUS erst nach 6 h (vorher 20 min: 20 min an / 5 min aus, auch nachts)\n")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path, flags = sys.argv[1], set(sys.argv[2:])
    flows = json.load(open(path, encoding="utf-8"))
    node = next((n for n in flows if n.get("id") == NODE_ID), None)
    if node is None or node.get("name") != "CTRL Radiator (RPC)":
        raise SystemExit("Knoten %s nicht gefunden" % NODE_ID)
    code = node["func"]
    patched = MARK in code
    if "--check" in flags:
        if patched:
            print("Dauer-AN ist drin")
            raise SystemExit(0)
        ok = code.count(OLD) == 1
        print("Dauer-AN ist NICHT drin" + ("" if ok else " (und der Anker fehlt)"))
        raise SystemExit(1 if ok else 2)
    if "--revert" in flags:
        if not patched:
            print("nichts zu tun")
            return
        if code.count(NEW) != 1:
            raise SystemExit("Revert: Anker nicht eindeutig, nichts geaendert")
        node["func"] = code.replace(NEW, OLD, 1)
    else:
        if patched:
            print("nichts zu tun")
            return
        if code.count(OLD) != 1:
            raise SystemExit("Anker nicht eindeutig gefunden, nichts geaendert")
        node["func"] = code.replace(OLD, NEW, 1)
    json.dump(flows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    print("geaendert:", NODE_ID, "(Revert)" if "--revert" in flags else "(Dauer-AN)")


if __name__ == "__main__":
    main()

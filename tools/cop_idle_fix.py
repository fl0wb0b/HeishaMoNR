#!/usr/bin/env python3
"""Idempotent patch: HeishaMoNR function "COP_calculated" reports COP 0 while the compressor is not running.

Problem: some units report a standby power (e.g. 15 W) instead of 0 W when the compressor stands still. The original code only
detects "idle" for exactly 0 W, then returns early (runtime < 2) without sending anything, so the last COP stays on the dashboard
(text "COP (Heizen)", chart) and, through "panasonic/cop" (retained), at Venus/VRM ("Pana-COP").

Fix: idle = consumption exactly 0 OR compressor frequency 0. Idle sends COP_HEAT = 0 (and COP_DHW = 0) on the line-chart output exactly
like the original code does for 0 W, and sets the global COP_HEAT to 0. Running operation is unchanged (checked by tools/cop_idle_test.js).

The text display ("COP anzeigen") shows 0 at standstill (it showed a dash before).

Usage: python3 tools/cop_idle_fix.py "<flows.json>"      (edits the file in place; prints ok / unchanged)
"""
import json
import re
import sys

FUNC_ID = "f4e55b938e645737"
DISPLAY_ID = "a1c0b0000c0f0010"
DISPLAY_OLD = "// COP fuer die Anzeige: im Stillstand (0) einen Strich zeigen\nvar v = Number(msg.payload);\nmsg.payload = (v > 0) ? v.toFixed(1) : '–';"
DISPLAY_NEW = "// COP fuer die Anzeige: im Stillstand 0 zeigen (nicht den letzten Wert)\nvar v = Number(msg.payload);\nmsg.payload = (v > 0) ? v.toFixed(1) : '0';"
MARK = "// COP-idle:"

OLD_DECL = "let msg1={}, msg2={}, msg3={}, msg10={}, msg20={};"
NEW_DECL = OLD_DECL + """
""" + MARK + """ Stillstand: manche Anlagen melden dann Bereitschaftsleistung (z. B. 15 W) statt 0 W. Dann keinen COP aus Restwaerme rechnen, sondern 0 melden.
var compFreq = Number(global.get('compressor_frequency'));
var idle = (Energy_Consumption === 0) || (isFinite(compFreq) && compFreq === 0);"""
OLD_IDLE_HEAT = """if (TOP20_ThreeWay_Valve_State === 0 && Energy_Consumption === 0)    // HEAT mode
{   msg3.topic = "COP_HEAT"; """
NEW_IDLE_HEAT = """if (TOP20_ThreeWay_Valve_State === 0 && idle)    // HEAT mode
{   global.set('COP_HEAT', 0);
    msg3.topic = "COP_HEAT"; """


def patch(func):
    if MARK in func:
        return func, False
    if OLD_DECL not in func or OLD_IDLE_HEAT not in func:
        raise SystemExit("COP_calculated sieht anders aus als erwartet, nichts geaendert")
    f = func.replace(OLD_DECL, NEW_DECL, 1).replace(OLD_IDLE_HEAT, NEW_IDLE_HEAT, 1)
    f = f.replace("Energy_Consumption !== 0", "!idle")
    f = f.replace("&& Energy_Consumption === 0)", "&& idle)")
    return f, True


if __name__ == "__main__":
    path = sys.argv[1]
    flows = json.load(open(path, encoding="utf-8"))
    node = next((n for n in flows if n["id"] == FUNC_ID), None)
    if node is None:
        raise SystemExit("Funktion COP_calculated (%s) nicht gefunden" % FUNC_ID)
    node["func"], changed = patch(node["func"])
    disp = next((n for n in flows if n["id"] == DISPLAY_ID), None)
    if disp is not None and DISPLAY_OLD in disp["func"]:
        disp["func"] = disp["func"].replace(DISPLAY_OLD, DISPLAY_NEW); changed = True
    if changed:
        json.dump(flows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    print("ok" if changed else "unveraendert")

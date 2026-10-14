#!/usr/bin/env python3
"""Kern-Patch: COP-Korrektur im HeishaMoNR-Funktionsknoten "COP_calculated" (f4e55b938e645737, Tab "WP Control").

Hintergrund (Forum 189605, 14.10.2026; Belege 4545989 / 4597230 / 4145844): die internen Stromwerte TOP16
(Heat_Power_Consumption) bzw. TOP41 (DHW_Power_Consumption) liegen bei laufendem Verdichter rund 80 W unter dem
tatsaechlich aufgenommenen Strom. Der daraus berechnete COP ist zu hoch (bei ~350 W etwa um den Faktor 1,25).

Der Patch fuegt direkt nach der Zeile
    var idle = (Energy_Consumption === 0) || (isFinite(compFreq) && compFreq === 0);
einen Block ein, der bei laufendem Verdichter (nicht idle und compressor_frequency > 0) OPT_cfg.cop.pelKorrW
(Standard 80 W, nur 0...200 W zulaessig, gleiche Konstante wie im Optimierer) auf Energy_Consumption addiert.
Wirkt damit auf COP_HEAT und COP_DHW (-> "panasonic/cop" -> Venus/VRM). Prod_HEAT/Prod_DHW (Waermeleistung) bleiben unveraendert.

Aufruf:
    python3 kern_cop_patch.py --apply  "<flows.json>"   [--out <ziel.json>]
    python3 kern_cop_patch.py --revert "<flows.json>"   [--out <ziel.json>]
    python3 kern_cop_patch.py --check  "<flows.json>"   (zeigt nur den Zustand)

Die Datei wird textuell geaendert (nur der JSON-String des func-Felds), damit Formatierung und Reihenfolge erhalten
bleiben. Danach wird geprueft, dass sich gegenueber dem Original genau dieser eine Knoten im Feld func unterscheidet.
Weicht der Knoten vom erwarteten Altwert ab (Ankerzeile fehlt/mehrfach, Block schon da bzw. beim Zuruecknehmen nicht
exakt vorhanden), bricht das Skript ohne Aenderung ab (Exit-Code 2).
"""
import argparse
import json
import sys

FUNC_ID = "f4e55b938e645737"
ANCHOR = "var idle = (Energy_Consumption === 0) || (isFinite(compFreq) && compFreq === 0);"
MARK = "// COP-Korrektur (Kern):"
BLOCK = (
    "\n" + MARK + " TOP16/TOP41 liegen bei laufendem Verdichter rund 80 W unter dem echten Strom\n"
    "// (Forum 189605, 14.10.2026; Belege 4545989/4597230/4145844). Gleiche Konstante wie im Optimierer: OPT_cfg.cop.pelKorrW\n"
    "// (Standard 80 W, nur 0...200 W). Gilt fuer COP_HEAT und COP_DHW; Prod_HEAT/Prod_DHW bleiben unveraendert.\n"
    "if (!idle && isFinite(compFreq) && compFreq > 0) {\n"
    "    var copKorrCfg = global.get('OPT_cfg');\n"
    "    var copKorrW = Number(((copKorrCfg && copKorrCfg.cop) || {}).pelKorrW);\n"
    "    if (!(isFinite(copKorrW) && copKorrW >= 0 && copKorrW <= 200)) { copKorrW = 80; }\n"
    "    Energy_Consumption = Number(Energy_Consumption) + copKorrW;\n"
    "}"
)
# Erwartete Rechenzeilen (zwei Divisionen: HEAT und DHW) als Plausibilitaetspruefung des Altwerts
DIVISION = "= Watt_heat_c / Energy_Consumption;"


def fail(text):
    print("ABBRUCH: " + text, file=sys.stderr)
    sys.exit(2)


def nodes_of(data):
    return data if isinstance(data, list) else data.get("flows", [])


def state(func):
    if func.count(ANCHOR) != 1:
        return "unbekannt (Ankerzeile %dx)" % func.count(ANCHOR)
    if MARK in func:
        return "gepatcht" if (ANCHOR + BLOCK) in func else "unbekannt (Markierung ohne exakten Block)"
    return "original"


def apply(func):
    st = state(func)
    if st != "original":
        fail("COP_calculated ist nicht im erwarteten Altzustand: " + st)
    if func.count(DIVISION) != 2:
        fail("COP_calculated: erwartet 2 Divisionen '%s', gefunden %d" % (DIVISION, func.count(DIVISION)))
    return func.replace(ANCHOR, ANCHOR + BLOCK, 1)


def revert(func):
    st = state(func)
    if st != "gepatcht":
        fail("COP_calculated ist nicht exakt gepatcht: " + st)
    return func.replace(ANCHOR + BLOCK, ANCHOR, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--apply", action="store_true")
    g.add_argument("--revert", action="store_true")
    g.add_argument("--check", action="store_true")
    ap.add_argument("flows")
    ap.add_argument("--out", help="Zieldatei (Standard: Eingabedatei ueberschreiben)")
    a = ap.parse_args()

    raw = open(a.flows, encoding="utf-8").read()
    data = json.loads(raw)
    node = next((n for n in nodes_of(data) if n.get("id") == FUNC_ID), None)
    if node is None:
        fail("Knoten COP_calculated (%s) nicht gefunden" % FUNC_ID)
    old = node["func"]
    if a.check:
        print("COP_calculated: " + state(old))
        return
    new = apply(old) if a.apply else revert(old)

    # textuell ersetzen (Formatierung bleibt), sonst abbrechen
    enc_old = json.dumps(old, ensure_ascii=False)
    if raw.count(enc_old) != 1:
        enc_old_a = json.dumps(old)
        if raw.count(enc_old_a) != 1:
            fail("func-String nicht eindeutig im Dateitext gefunden (Kodierung?)")
        out = raw.replace(enc_old_a, json.dumps(new), 1)
    else:
        out = raw.replace(enc_old, json.dumps(new, ensure_ascii=False), 1)

    # Gegenpruefung: genau ein Knoten, genau das Feld func verschieden
    before = {n.get("id"): n for n in nodes_of(data)}
    after_data = json.loads(out)
    after = {n.get("id"): n for n in nodes_of(after_data)}
    if set(before) != set(after) or len(nodes_of(data)) != len(nodes_of(after_data)):
        fail("Knotenmenge hat sich veraendert")
    diff = [i for i in before if before[i] != after[i]]
    if diff != [FUNC_ID]:
        fail("unerwartete Unterschiede: %s" % diff)
    b, c = dict(before[FUNC_ID]), dict(after[FUNC_ID])
    if b.pop("func") == c.pop("func") or b != c:
        fail("im Knoten unterscheidet sich mehr als func")
    if after[FUNC_ID]["func"] != new:
        fail("func nach dem Ersetzen nicht wie erwartet")

    with open(a.out or a.flows, "w", encoding="utf-8") as f:
        f.write(out)
    print("ok: COP_calculated %s -> %s (%s)" % (state(old), state(new), a.out or a.flows))


if __name__ == "__main__":
    main()

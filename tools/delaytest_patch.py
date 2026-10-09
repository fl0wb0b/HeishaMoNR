#!/usr/bin/env python3
"""Verzoegerungstest: Patch der Summenfunktion "Calculate new SP Zone 1 + 2" (HeishaMoNR, Tab WP Managers).

Die Summenfunktion bildet SHIFT_Final_z1 aus Heizkurven-Verschiebung, Raumregelung, Nachtabsenkung und Softstart. Der Patch addiert dazu EINE Groesse:
OPT_test_shift (vom Pruefstand opt_dt). Sie zaehlt nur, wenn sie frisch ist (OPT_test_ts hoechstens 150 s alt) und ist hart auf -1..+1 K begrenzt.
Ohne Wert, ohne frischen Zeitstempel oder bei jedem Fehler ist der Beitrag 0: die Funktion verhaelt sich dann exakt wie vorher.
Die Verschiebung laeuft danach ueber den vorhandenen Weg (Compare SP z1 und z2 -> Block? -> To MQTT (SET5) -> Command Check mit Rueckmeldung und Wiederholung).
Notbremse: global MQTT.block_active = 1 sperrt wie bisher alle Befehle.

Aufruf:   python3 delaytest_patch.py flows.json            (Patch anwenden; idempotent)
          python3 delaytest_patch.py flows.json --revert   (Patch entfernen)
          python3 delaytest_patch.py flows.json --check    (nur pruefen: Exit 0 = Patch drin, 1 = nicht drin, 2 = Anker fehlen)
Es wird NUR dieser eine Knoten geaendert (Knoten-ID unten); alles andere bleibt Byte fuer Byte gleich.
"""
import json
import sys

NODE_ID = "add6fa4d403dd143"
MARK_BEGIN = "// OPT-VERZOEGERUNGSTEST (Patch) -- Anfang"
MARK_END = "// OPT-VERZOEGERUNGSTEST (Patch) -- Ende"
ANCHOR_DEF = "var TOP94_Zones_State = global.get(\"TOP94_Zones_State\", \"file\")\n"
OLD_SUM = "SHIFT_Final_z1 = (Math.round((SP_Start_z1 + F_RTC_correction_z1 + F_NR_correction + F_SS_correction) * 10 )) / 10"
NEW_SUM = "SHIFT_Final_z1 = (Math.round((SP_Start_z1 + F_RTC_correction_z1 + F_NR_correction + F_SS_correction + OPT_TEST) * 10 )) / 10"
BLOCK = (
    MARK_BEGIN + "\n"
    "var OPT_TEST = 0;\n"
    "try {\n"
    "    var OPT_T_V = global.get('OPT_test_shift'), OPT_T_TS = global.get('OPT_test_ts'), OPT_T_AGE = Date.now() - OPT_T_TS;\n"
    "    if (typeof OPT_T_V === 'number' && isFinite(OPT_T_V) && typeof OPT_T_TS === 'number' && OPT_T_AGE <= 150000 && OPT_T_AGE >= -60000) {\n"
    "        OPT_TEST = Math.max(-1, Math.min(1, OPT_T_V));\n"
    "    }\n"
    "} catch (e) { OPT_TEST = 0; }\n"
    + MARK_END + "\n"
)


def patch(code):
    if MARK_BEGIN in code:
        return code, False
    if code.count(ANCHOR_DEF) != 1 or code.count(OLD_SUM) != 1:
        raise SystemExit("Anker nicht gefunden (Funktion wurde geaendert?): Patch bricht ab, nichts geaendert")
    code = code.replace(ANCHOR_DEF, ANCHOR_DEF + BLOCK, 1).replace(OLD_SUM, NEW_SUM, 1)
    return code, True


def revert(code):
    if MARK_BEGIN not in code:
        return code, False
    a = code.index(MARK_BEGIN)
    b = code.index(MARK_END) + len(MARK_END) + 1
    code = code[:a] + code[b:]
    if code.count(NEW_SUM) != 1:
        raise SystemExit("Summenzeile nicht gefunden: Revert bricht ab, nichts geaendert")
    return code.replace(NEW_SUM, OLD_SUM, 1), True


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    flags = set(sys.argv[2:])
    flows = json.load(open(path, encoding="utf-8"))
    node = next((n for n in flows if n.get("id") == NODE_ID), None)
    if node is None or node.get("type") != "function" or "Calculate new SP" not in node.get("name", ""):
        raise SystemExit("Knoten %s nicht gefunden" % NODE_ID)
    code = node["func"]
    if "--check" in flags:
        if MARK_BEGIN in code:
            print("Patch ist drin")
            raise SystemExit(0)
        ok = code.count(ANCHOR_DEF) == 1 and code.count(OLD_SUM) == 1
        print("Patch ist NICHT drin" + ("" if ok else " (und die Anker fehlen)"))
        raise SystemExit(1 if ok else 2)
    new, changed = revert(code) if "--revert" in flags else patch(code)
    if changed:
        node["func"] = new
        json.dump(flows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
        print("geaendert:", NODE_ID, "(Revert)" if "--revert" in flags else "(Patch)")
    else:
        print("nichts zu tun")


if __name__ == "__main__":
    main()

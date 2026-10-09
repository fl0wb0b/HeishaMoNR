#!/usr/bin/env python3
"""Kinderzimmer-Radiator: auch in der Verdichterpause an lassen, solange der Vorlauf der Waermepumpe noch warm ist.

Aenderung auf ausdruecklichen Wunsch des Nutzers (Tab "Dashboard", Gruppe "Kinderzimmer Heat Control + Heizluefter Boost"):
bisher oeffnet das Radiator-Relais nur bei laufendem Verdichter (Leistung >= 150 W). In der Pause (ca. 66-85 min, Pumpe laeuft mit 1750 U/min,
Vorlauf faellt von ~33 auf ~27 C) war es zu, obwohl noch warmes Wasser umlief; dann sprang der Heizluefter (COP 1) an.
Neu: Ist der Verdichter aus, bleibt (oder wird) das Relais an, solange
  - der Vorlauf >= 27,0 C ist (einmal an: bis < 26,5 C, damit es nicht flattert) und
  - die Pumpe umwaelzt (Durchfluss >= 3 l/min, frischer Wert) - bei Heizgrenze-Aus steht die Pumpe, dann bleibt es zu.
Alle anderen Regeln bleiben unveraendert (Raum >= Soll+0,3 -> aus, Abtauen -> aus, Vorlauf < 25 -> aus, veraltete Werte -> aus, max. 20 min am Stueck,
5 min Sperre, Heizluefter bleibt aus, solange das Relais an ist). Bei laufendem Verdichter verhaelt sich alles exakt wie vorher.

Geaendert werden: Knoten a0f2936bcfe99ce0 (CTRL Radiator (RPC)) und zwei NEUE Knoten in derselben Gruppe (Abo "Pump_Flow" + Speichern). Sonst nichts.

Aufruf:   python3 radiator_pause_patch.py flows.json            (anwenden; idempotent)
          python3 radiator_pause_patch.py flows.json --revert   (zurueck auf den Stand davor, die zwei neuen Knoten verschwinden)
          python3 radiator_pause_patch.py flows.json --check    (Exit 0 = drin, 1 = nicht drin, 2 = Anker fehlen)
"""
import json
import sys

TAB = "96730eb46df43319"
GROUP = "0942bdaa20b48a26"
NODE_ID = "a0f2936bcfe99ce0"
IN_ID = "d0a7e6f5c41b2a93"
SAVE_ID = "b3c9e1d27a5f4086"
BROKER = "d82cfde48e832830"                       # MQTT (lokal), wie die anderen Panasonic-Abos der Gruppe
MARK = "// PAUSE-MODUS (Nutzerwunsch)"

# (alt, neu): jeder Anker muss genau einmal vorkommen
EDITS = [
    ('const HPSt = flow.get("hpstate");\n',
     'const HPSt = flow.get("hpstate");\nconst PF   = Number(flow.get("pumpFlow"));            ' + MARK + ': Umwaelzung der Pumpe\n'),
    ('const agePWR = now - (flow.get("hpPower_ts") || 0);\n',
     'const agePWR = now - (flow.get("hpPower_ts") || 0);\nconst agePF  = now - (flow.get("pumpFlow_ts") || 0);\n'),
    ('const hpOnW     = 150;\n',
     'const hpOnW     = 150;\n'
     'const otKeepOn  = 27.0;      ' + MARK + ': in der Verdichterpause darf das Relais an sein, solange der Vorlauf >= 27,0 C ist\n'
     'const otKeepOff = 26.5;      // Hysterese: einmal an, bleibt es bis der Vorlauf unter 26,5 C faellt\n'
     'const pfMinLpm  = 3.0;       // Pumpe muss umwaelzen (bei Heizgrenze-Aus steht sie, der Vorlaufwert ist dann stehendes Wasser)\n'
     'const pfStaleMs = 10 * 60 * 1000;\n'),
    ('const hp_on = PWR >= hpOnW;\n',
     'const hp_on = PWR >= hpOnW;\n'
     'const pumpOk = Number.isFinite(PF) && agePF <= pfStaleMs && PF >= pfMinLpm;\n'
     'const keepWarm = !hp_on && pumpOk && OT >= (flow.get("radiator_cmd") === true ? otKeepOff : otKeepOn);   ' + MARK + '\n'),
    ('else if (!hp_on)                { cmd = false; why = `hpPower<${hpOnW}`; }',
     'else if (!hp_on && !keepWarm)   { cmd = false; why = `hpPower<${hpOnW}`; }'),
    ('else if (RT <= on_th)           { cmd = true;  why = `RT<=${on_th.toFixed(1)}`; }',
     'else if (RT <= on_th)           { cmd = true;  why = `RT<=${on_th.toFixed(1)}` + (keepWarm ? ` (Pause, OT:${OT.toFixed(1)})` : ""); }'),
]

SAVE_FUNC = (
    'let v = Number(msg.payload);\n'
    'if (!Number.isFinite(v)) {\n'
    '  node.status({fill:"red",shape:"ring",text:"PF invalid"});\n'
    '  return null;\n'
    '}\n'
    'flow.set("pumpFlow", v);\n'
    'flow.set("pumpFlow_ts", Date.now());\n'
    'node.status({fill:"blue",shape:"dot",text:`PF=${v.toFixed(1)} l/min`});\n'
    'return null;'
)


def get(flows, i):
    return next((n for n in flows if n.get("id") == i), None)


def is_patched(node):
    return MARK in node["func"]


def apply(flows):
    node = get(flows, NODE_ID)
    if node is None or node.get("z") != TAB or node.get("g") != GROUP or node.get("name") != "CTRL Radiator (RPC)":
        raise SystemExit("Knoten %s nicht an der erwarteten Stelle gefunden" % NODE_ID)
    if is_patched(node):
        return False
    code = node["func"]
    for old, new in EDITS:
        if code.count(old) != 1:
            raise SystemExit("Anker nicht eindeutig gefunden (Funktion wurde geaendert?), nichts geaendert:\n" + old)
        code = code.replace(old, new, 1)
    node["func"] = code
    grp = get(flows, GROUP)
    in_node = {"id": IN_ID, "type": "mqtt in", "z": TAB, "g": GROUP, "name": "Pump Flow (Panasonic)", "topic": "panasonic_heat_pump/main/Pump_Flow", "qos": "0",
               "datatype": "auto", "broker": BROKER, "nl": False, "rap": False, "inputs": 0, "x": 200, "y": 1280, "wires": [[SAVE_ID]]}
    save = {"id": SAVE_ID, "type": "function", "z": TAB, "g": GROUP, "name": "Save Pump Flow", "func": SAVE_FUNC, "outputs": 0, "noerr": 0, "x": 470, "y": 1280, "wires": []}
    for n in (in_node, save):
        if get(flows, n["id"]) is None:
            flows.append(n)
        if n["id"] not in grp["nodes"]:
            grp["nodes"].append(n["id"])
    return True


def revert(flows):
    node = get(flows, NODE_ID)
    if node is None or not is_patched(node):
        return False
    code = node["func"]
    for old, new in EDITS:
        if code.count(new) != 1:
            raise SystemExit("Revert: Anker nicht eindeutig gefunden, nichts geaendert:\n" + new)
        code = code.replace(new, old, 1)
    node["func"] = code
    grp = get(flows, GROUP)
    for i in (IN_ID, SAVE_ID):
        if i in grp["nodes"]:
            grp["nodes"].remove(i)
    flows[:] = [n for n in flows if n.get("id") not in (IN_ID, SAVE_ID)]
    return True


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path, flags = sys.argv[1], set(sys.argv[2:])
    flows = json.load(open(path, encoding="utf-8"))
    if "--check" in flags:
        node = get(flows, NODE_ID)
        if node is not None and is_patched(node):
            print("Pausen-Modus ist drin")
            raise SystemExit(0)
        ok = node is not None and all(node["func"].count(o) == 1 for o, _ in EDITS)
        print("Pausen-Modus ist NICHT drin" + ("" if ok else " (und die Anker fehlen)"))
        raise SystemExit(1 if ok else 2)
    changed = revert(flows) if "--revert" in flags else apply(flows)
    if changed:
        json.dump(flows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
        print("geaendert:", NODE_ID, "(Revert)" if "--revert" in flags else "(Pausen-Modus)")
    else:
        print("nichts zu tun")


if __name__ == "__main__":
    main()

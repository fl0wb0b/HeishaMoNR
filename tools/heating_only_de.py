#!/usr/bin/env python3
"""Apply the heating-only / German dashboard changes to a HeishaMoNR flow file.

Scope (phase 1): the dashboard pages "Home" and "Temperatures".
  * Hides DHW, COOL and zone 2 from Home (groups are moved to a hidden tab, nothing is deleted)
  * Replaces the DHW chart on Temperatures by a COP chart, adds a COP row on Home
  * Translates labels and the texts produced by display-only function nodes to German

Every replacement asserts that the old text is present (or the new one already is),
so after an upstream update a changed node is reported instead of silently skipped.

Usage: python3 tools/heating_only_de.py "flows (26.5.1 stable).json"
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "flows (26.5.1 stable).json"
flows = json.load(open(path, encoding="utf-8"))
B = {n["id"]: n for n in flows}

WP_DASH = "8c9d42231fd19d3c"
HIDDEN_TAB = "534382cf81d94968"          # existing hidden tab "GUI"
errors = []


def node(i):
    if i not in B:
        errors.append(f"node {i} not found")
        raise KeyError(i)
    return B[i]


def rep(i, field, old, new, count=1):
    """Replace `old` by `new` in node[field]; idempotent, asserts the expected count."""
    n = node(i)
    text = n.get(field)
    if not isinstance(text, str):
        errors.append(f"{i}.{field} is not a string")
        return
    if old not in text:
        if new in text:
            return
        errors.append(f"{i}.{field}: {old!r} not found")
        return
    if text.count(old) != count:
        errors.append(f"{i}.{field}: {old!r} found {text.count(old)}x, expected {count}")
        return
    n[field] = text.replace(old, new)


def setf(i, field, old, new):
    n = node(i)
    if n.get(field) == new:
        return
    if n.get(field) != old:
        errors.append(f"{i}.{field}: expected {old!r}, got {n.get(field)!r}")
        return
    n[field] = new


# ---------------------------------------------------------------- tabs / groups
setf("a5be8588.b8fbc8", "name", "Home", "Übersicht")
setf("5b5fabb85470bd21", "name", "Temperatures", "Temperaturen")
setf("bf4af523ba16d457", "name", "HEAT PUMP", "WÄRMEPUMPE")
setf("1179fa790d2d89ca", "name", "HEAT (zone 1)", "HEIZEN (Zone 1)")
setf("e374621a9f5ac0d6", "name", "DHW | Water temperature", "Wassertemperatur")

# hide what a heating-only installation does not use (moved, not deleted)
for gid in ("623f5d089867807d",   # HEAT (zone 2)
            "e3cc96332cd59f07",   # DHW
            "273f74f363a57507"):  # COOL
    n = node(gid)
    n["tab"] = HIDDEN_TAB

# ---------------------------------------------------------------- Home: labels
setf("7b3d20aa8c9abb1e", "label", "Heat pump power", "Wärmepumpe")
rep("43403f14c1a863a4", "format", "<left>Operating mode</left>", "<left>Betriebsart</left>")
setf("ef9758a537d81735", "label", "Actual", "Aktuell")
setf("354635fe353183fd", "label", "Valve position", "Ventilstellung")
rep("46b7fe12f60ad08b", "format", "<left>Water temperature</left>", "<left>Wassertemperatur</left>")
setf("521e419dae5882e7", "label", "Outlet setpoint", "Vorlauf Soll")
setf("1d51b425fba024d2", "label", "Outlet actual", "Vorlauf Ist")
setf("3478273eb4693d84", "label", "Inlet actual", "Rücklauf Ist")
setf("0e09d25e4fd17042", "title", "Water flow", "Durchfluss")
setf("0e09d25e4fd17042", "label", "L/min", "l/min")
setf("91fcc102b422de3b", "title", "Frequency", "Frequenz")
setf("3ac59d9a6138e620", "label", "Pump speed", "Pumpendrehzahl")
rep("3ac59d9a6138e620", "format", "rpm", "U/min")
setf("79dc18dd1cca1e73", "label", "Compressor runtime", "Laufzeit Verdichter")
setf("1ed98a1d47eb56f0", "label", "Fan 1", "Lüfter 1")
rep("1ed98a1d47eb56f0", "format", "rpm", "U/min")
setf("9faace07ea16ba4d", "label", "Fan 2", "Lüfter 2")
rep("9faace07ea16ba4d", "format", "rpm", "U/min")
setf("2ae1f0e14435e803", "label", "Internal heater", "Heizstab intern")
setf("cce68d6f8e62d22a", "label", "External heater", "Heizstab extern")
rep("f37c739180bdbc6e", "format", "Custom functions (Multi-Zone)", "Zusatzfunktionen (alle Zonen)")
setf("2b04b7dd5ea852f2", "label", "Night reduction", "Nachtabsenkung")
setf("c66f65978915e688", "label", "Softstart (experimental)", "SoftStart (experimentell)")
rep("96c650af80111193", "format", "Custom functions (Zone 1)", "Zusatzfunktionen (Zone 1)")
setf("ad1aa3d7ce882c45", "label", "<font color= {{msg.color}} >Night reduction</font>",
     "<font color= {{msg.color}} >Nachtabsenkung</font>")
setf("3b21b99348cb6165", "label", "<font color= {{msg.color}} >SoftStart</font>",
     "<font color= {{msg.color}} >SoftStart</font>")

# ---------------------------------------------------------------- Home: texts from display-only functions
# operating mode (Current state) – only feeds the ui_text
for a, b in (('"*Defrosting*"', '"*Abtauen*"'),
             ('"Heat only"', '"Nur Heizen"'),
             ('"Cool only"', '"Nur Kühlen"'),
             ('"Auto(Heat)+DHW"', '"Auto (Heizen)+WW"'),
             ('"Auto(Heat)"', '"Auto (Heizen)"'),
             ('"DHW only"', '"Nur Warmwasser"'),
             ('"Heat+DHW"', '"Heizen+WW"'),
             ('"Cool+DHW"', '"Kühlen+WW"'),
             ('"Auto(Cool)+DHW)"', '"Auto (Kühlen)+WW"'),
             ('"Auto(Cool)"', '"Auto (Kühlen)"')):
    rep("cc398f298c681782", "func", a, b)
# valve position
rep("cb7bd45634ebfb62", "func", "value = 'Room'", "value = 'Raum'")
rep("cb7bd45634ebfb62", "func", "value = 'DHW'", "value = 'Warmwasser'")
# internal heater state
rep("76b462d26dcde630", "func", 'msg.payload = "Inactive"', 'msg.payload = "Inaktiv"')
rep("76b462d26dcde630", "func", 'msg.payload = "Active"', 'msg.payload = "Aktiv"')
# zone labels ("shift vs direct", Zone 1 and Zone 2 variants)
for i in ("187c584c21359a3e", "d41450134c2d573e"):
    rep(i, "func", 'msg2.label = "Shift curve"', 'msg2.label = "Kurve verschieben"', count=2)
rep("187c584c21359a3e", "func", 'msg2.label = "Water temp. z1"', 'msg2.label = "Wassertemp. Z1"')
rep("d41450134c2d573e", "func", 'msg2.label = "Water temp. z2"', 'msg2.label = "Wassertemp. Z2"')
# "Temperature shift (undefined)" fix: only show the value in brackets when it exists
for z in ("1", "2"):
    rep("00dd6c3fd833a5cf", "func",
        f'msg{z}.label = "Temperature shift (" + SHIFT_Final_z{z} + ")";',
        f'msg{z}.label = "Temperaturverschiebung" + (SHIFT_Final_z{z} === undefined ? "" : " (" + SHIFT_Final_z{z} + ")");')
    rep("00dd6c3fd833a5cf", "func",
        f'msg{z}.label = "Final water temperature (" + SP_Final_z{z} + ")";',
        f'msg{z}.label = "Resultierende Wassertemperatur" + (SP_Final_z{z} === undefined ? "" : " (" + SP_Final_z{z} + ")");')
rep("4e6e20a608cd21dd", "func", 'msg1.label = "Temperature shift";', 'msg1.label = "Temperaturverschiebung";')

# ---------------------------------------------------------------- Temperatures
setf("8cb1aceef81045bd", "label", "Room Temperature", "Raumtemperatur")
setf("9802bf01ebf45d28", "label", "HEAT", "Heizen")
for old, new in (("msg1.topic='Setpoint';", "msg1.topic='Soll';"),
                 ("msg2.topic='Actual T(inlet)';", "msg2.topic='Rücklauf Ist';"),
                 ("msg3.topic='Actual T(outlet)';", "msg3.topic='Vorlauf Ist';")):
    rep("c9c2bf06edb19d41", "func", old, new)
for old, new in (("msg1.topic='Setpoint (Zone 1)';", "msg1.topic='Soll (Zone 1)';"),
                 ("msg3.topic='Room Actual (Zone 1)';", "msg3.topic='Raum Ist (Zone 1)';")):
    rep("9f3df8b1cba0bbda", "func", old, new)
setf("93759ef7c600fe14", "label", "Help", "Hilfe")

HELP_DE = """<h3>Informationen zu den Diagrammen</h3>
<br/>
<h3>Heizen</h3>
Dieses Diagramm zeigt den Heizbetrieb.<br>
- Soll: Ziel-Vorlauftemperatur<br>
- Vorlauf Ist: Wassertemperatur, die die Wärmepumpe verlässt<br>
- Rücklauf Ist: Wassertemperatur, die in die Wärmepumpe zurückkommt<br>
<br>

<h3>COP (Heizen)</h3>
Momentaner COP aus Wärmeleistung (Spreizung &times; Durchfluss) geteilt durch die elektrische Aufnahme.
Im Stillstand zeigt das Diagramm 0.<br>
<br>

<h3>Raumtemperatur</h3>
Dieses Diagramm zeigt die Raumtemperaturen.<br>
- Soll: Ziel-Raumtemperatur<br>
- Raum Ist: gemessene Raumtemperatur<br>
<br>
"""
n = node("56de4e61c43e26ae")
if n["format"] != HELP_DE:
    if "Information about the graphs" not in n["format"]:
        errors.append("help template has unexpected content")
    n["format"] = HELP_DE

# ---------------------------------------------------------------- new: COP row on Home + COP chart on Temperatures
SW = "a1c0b0000c0f0001"                    # "nur COP_HEAT" switch from the cop-mqtt branch
if SW not in B:
    errors.append("switch 'nur COP_HEAT' missing - apply the cop-mqtt branch first")
else:
    cop_row_is_new = "a1c0b0000c0f0011" not in B

    def add(n):
        if n["id"] in B:
            return
        flows.append(n)
        B[n["id"]] = n

    add({"id": "a1c0b0000c0f0010", "type": "function", "z": WP_DASH, "name": "COP anzeigen",
         "func": "// COP fuer die Anzeige: im Stillstand (0) einen Strich zeigen\n"
                 "var v = Number(msg.payload);\n"
                 "msg.payload = (v > 0) ? v.toFixed(1) : '–';\n"
                 "return msg;",
         "outputs": 1, "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [],
         "x": 560, "y": 2060, "wires": [["a1c0b0000c0f0011"]]})
    add({"id": "a1c0b0000c0f0011", "type": "ui_text", "z": WP_DASH, "group": "bf4af523ba16d457",
         "order": 2, "width": 6, "height": 1, "name": "COP Heizen", "label": "COP (Heizen)",
         "format": "{{msg.payload}}", "layout": "row-spread", "className": "",
         "x": 760, "y": 2060, "wires": []})
    add({"id": "a1c0b0000c0f0012", "type": "ui_chart", "z": WP_DASH, "group": "e374621a9f5ac0d6",
         "name": "COP Heizen", "label": "COP (Heizen)", "order": 5, "width": 26, "height": 7,
         "chartType": "line", "legend": "false", "xformat": "HH:mm", "interpolate": "step",
         "nodata": "", "dot": False, "ymin": "0", "ymax": "", "removeOlder": "48",
         "removeOlderPoints": "", "removeOlderUnit": "3600", "cutout": 0, "useOneColor": False,
         "useUTC": False,
         "colors": ["#2ca02c", "#aec7e8", "#ff7f0e", "#1f77b4", "#98df8a", "#d62728", "#ff9896",
                    "#9467bd", "#c5b0d5"],
         "outputs": 1, "useDifferentColor": False, "className": "",
         "x": 760, "y": 2100, "wires": [[]]})
    sw = B[SW]
    for t in ("a1c0b0000c0f0010", "a1c0b0000c0f0012"):
        if t not in sw["wires"][0]:
            sw["wires"][0].append(t)

    # the old DHW chart goes to a hidden group (kept, so nothing upstream breaks)
    HID_G = "a1c0b0000c0f0020"
    if HID_G not in B:
        flows.append({"id": HID_G, "type": "ui_group", "name": "Ausgeblendet (Warmwasser)",
                      "tab": HIDDEN_TAB, "order": 99, "disp": False, "width": 26, "collapse": False,
                      "className": ""})
        B[HID_G] = flows[-1]
    B["9789265573ab4c80"]["group"] = HID_G

    # make room on Home: widgets of the HEAT PUMP group from order 2 on move down one row
    if cop_row_is_new:
        for x in flows:
            if x.get("group") == "bf4af523ba16d457" and x["id"] != "a1c0b0000c0f0011" and x.get("order", 0) >= 2:
                x["order"] += 1

if errors:
    print("\n".join("ERROR: " + e for e in errors))
    sys.exit(1)

with open(path, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(flows, indent=4, ensure_ascii=False))
print("ok")

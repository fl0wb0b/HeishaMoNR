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
# the dashboard addresses groups as "<tab name>_<group name>", so the tab rename must be followed here
rep("93759ef7c600fe14", "payload", "Temperatures_Help", "Temperaturen_Help")
rep("7d8b052fee984598", "payload", "Temperatures_Help", "Temperaturen_Help")

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

# ================================================================ phase 2: Efficiency + Degree days
import re


def sub(i, field, pattern, repl, flags=0):
    """Regex replace in node[field]; idempotent via the replacement already being present."""
    n = node(i)
    text = n.get(field)
    new_text, k = re.subn(pattern, lambda m: repl, text, flags=flags)
    if k == 1:
        n[field] = new_text
    elif k == 0 and repl in text:
        return
    else:
        errors.append(f"{i}.{field}: pattern {pattern!r} matched {k}x")


def topic_rule(i, old, new):
    """Rename the value of a change node's 'set msg.topic' rule."""
    n = node(i)
    for r in n["rules"]:
        if r.get("p") == "topic" and r.get("to") == old:
            r["to"] = new
            return
        if r.get("p") == "topic" and r.get("to") == new:
            return
    errors.append(f"{i}: no topic rule {old!r}")


def unwire(i, target):
    for out in node(i)["wires"]:
        if target in out:
            out.remove(target)


# the dashboard addresses groups as "<tab name>_<group name>" (spaces become underscores)
setf("1a08b96c5aeb8d6e", "name", "Efficiency", "Effizienz")
setf("a681244e6db9a6a7", "name", "Degree days", "Gradtage")
rep("81b0cbf75fe9ed92", "payload", "Efficiency_Help", "Effizienz_Help")
rep("897bc542a342138d", "payload", "Efficiency_Help", "Effizienz_Help")
for b in ("03a0cd845d8efbe7", "e7626bf3192d47cb"):
    rep(b, "payload", "Efficiency_HistoryChart", "Effizienz_HistoryChart")
    rep(b, "payload", "Efficiency_HistoryTable", "Effizienz_HistoryTable")
rep("64e1f8f65ebe4711", "payload", "Degree_days_Help", "Gradtage_Help")
rep("a39a1002bb65b329", "payload", "Degree_days_Help", "Gradtage_Help")

# ---- Efficiency: labels
rep("b40c0f3e82728c9d", "format", "Current values", "Aktuelle Werte")
rep("68cd36d3c50eaef1", "format", "Historical Data", "Historische Daten")
rep("6cce5b6bd4157c5b", "format", "Trends (last 24 hours)", "Verlauf (letzte 24 Stunden)")
rep("23aa1aeed6d15e49", "format", "Historical data", "Historische Daten")
setf("d30f518b158d8bba", "label", "Energy [W]", "Leistung [W]")
setf("bd75ee928fde85b5", "label", "Water", "Wasser")
setf("fa2eba3089ca0ef4", "label", "Energy (W)", "Leistung (W)")
setf("1cbdb190d6f52cb6", "label", "Efficiency", "Effizienz")
setf("8084f5f9211ba26e", "label", "Monthly Production (kWh)", "Erzeugte Wärme pro Monat (kWh)")
setf("eee624aa045ae22a", "label", "Monthly COP", "COP pro Monat")
setf("03a0cd845d8efbe7", "label", "Charts", "Diagramme")
setf("e7626bf3192d47cb", "label", "Table", "Tabelle")
setf("f633c8957da26788", "label", "Refresh Data", "Daten aktualisieren")
setf("81b0cbf75fe9ed92", "label", "Help", "Hilfe")
setf("4d7236c464d1c14e", "label", "By default, this table is refreshed once per day (at midnight)",
     "Die Tabelle wird standardmäßig einmal täglich (um Mitternacht) aktualisiert")

# ---- Efficiency: series names of the charts (display only)
topic_rule("fae151e3fc249477", "Current [A]", "Strom [A]")
topic_rule("21857afb8366acf2", "Defrost State [-]", "Abtauzustand [-]")
topic_rule("039ca8047ee5b833", "Evaporator outlet [°C]", "Verdampfer Austritt [°C]")
topic_rule("38b10c117605255d", "Heat | Energy production", "Heizen | Erzeugte Energie")
topic_rule("53393ad3ce2b9113", "Heat | Energy consumption", "Heizen | Aufgenommene Energie")
topic_rule("6a440038dc115f96", "Heater (Internal)", "Heizstab (intern)")
topic_rule("1aa75bcd6581ca94", "Heater (External)", "Heizstab (extern)")
# heating only: take the DHW series off the power chart (the nodes stay, the wire goes)
unwire("3a6bb7844523ece7", "fa2eba3089ca0ef4")
unwire("ca8fd698c67b1cfa", "fa2eba3089ca0ef4")
rep("c94a4674e4c896e0", "func", 'msg.topic = "Consumption"', 'msg.topic = "Aufnahme"')
rep("7b9aabcb38a535d7", "func", 'msg.topic = "Production"', 'msg.topic = "Erzeugung"')
rep("3d7b8b4f9e0ef79e", "func", 'msg.topic = "Flow";', 'msg.topic = "Durchfluss";')
rep("3d7b8b4f9e0ef79e", "func", 'msg.topic = "T Inlet";', 'msg.topic = "T Rücklauf";')
rep("3d7b8b4f9e0ef79e", "func", 'msg.topic = "T Outlet";', 'msg.topic = "T Vorlauf";')
# monthly charts: heating only
rep("d4198e0e57720e55", "func", 'series: ["DHW", "HEAT"],', 'series: ["Heizen"],')
rep("d4198e0e57720e55", "func", "data: [varData1, varData2]\n};", "data: [varData2]\n};")
rep("35c15a4c210a4b20", "func", "series: [varSeries1, varSeries2],", 'series: ["Heizen"],')
rep("35c15a4c210a4b20", "func", "data: [varData1, varData2]\n};", "data: [varData2]\n};")
# history table: German headers, no DHW columns
TABLE_COLS = ("columns: [\n"
              "                { title: 'Monat', field: 'date' },\n"
              "                { title: 'COP (Heizen)', field: 'heat_cop', hozAlign: 'right', formatter: 'number', formatterParams: { precision: 2 } },\n"
              "                { title: 'Erzeugte Wärme (kWh)', field: 'heat_energy_produced', hozAlign: 'right', formatter: 'number', formatterParams: { precision: 1 } }\n"
              "            ]")
sub("02867974a58ba58f", "func", r"columns: \[\n\s*\{ title: 'Date'.*?\n\s*\]", TABLE_COLS, flags=re.S)
tbl = node("59bc0c78b8b9ea90")
keep = [c for c in tbl["columns"] if c["field"] in ("date", "heat_cop", "heat_energy_produced")]
titles = {"date": "Monat", "heat_cop": "COP (Heizen)", "heat_energy_produced": "Erzeugte Wärme (kWh)"}
for c in keep:
    c["title"] = titles[c["field"]]
tbl["columns"] = keep

HELP_EFF_DE = """<h3>Informationen zu den Diagrammen</h3>
<br/>
<h3>Leistung (W)</h3>
Dieses Diagramm zeigt die Leistung im Heizbetrieb: die aufgenommene elektrische und die erzeugte Wärmeleistung.<br>
<br>
<h3>Effizienz</h3>
- COP: Coefficient Of Performance, das Verhältnis von Wärmeleistung (Ausgang) zu elektrischer Leistung (Eingang)<br>
- Verdampfer Austritt: Temperatur des Kältemittels am Verdampfer der Wärmepumpe<br>
- Abtauzustand: zeigt an, ob gerade abgetaut wird (1 oder 0)<br>
- Strom: tatsächliche Stromaufnahme der Wärmepumpe (Ampere)<br>
<br>
<h3>Erzeugte Wärme pro Monat (kWh)</h3>
Dieses Diagramm zeigt die erzeugte Wärmemenge. Sie wird aus Durchfluss sowie Vor- und Rücklauftemperatur berechnet.<br>
Sie ist NICHT dasselbe wie der Stromverbrauch der Wärmepumpe.<br>
<br>
<h3>COP pro Monat</h3>
Dieses Diagramm gibt einen historischen Überblick über die berechneten COP-Werte im Heizbetrieb.<br>
<br>
<br>
"""
n = node("9a18b2fdbbfcef0e")
if n["format"] != HELP_EFF_DE:
    if "Information about the graphs" not in n["format"]:
        errors.append("efficiency help template has unexpected content")
    n["format"] = HELP_EFF_DE

# ---- Degree days
setf("64e1f8f65ebe4711", "label", "Help", "Hilfe")
setf("4eaa2cfa2749c551", "label", "Last 31 days", "Letzte 31 Tage")
setf("2ee679408e4ccc6f", "label", "Last 24 hours", "Letzte 24 Stunden")
SERIES_DE = "m.series    = ['Gradtage (°C)', 'Energieverbrauch Heizen (kWh)'];"
sub("2391637fadbbf190", "func", r"m\.series\s*=\s*\[[^\]]*\];", SERIES_DE)
sub("b44fca625044b56c", "func", r"m\.series\s*=\s*\[[^\]]*\];", SERIES_DE)
rep("2391637fadbbf190", "func", "m.data      = [vargraaddagen_data, varkwh_heat_data, varkwh_dhw_data];",
    "m.data      = [vargraaddagen_data, varkwh_heat_data];")
rep("b44fca625044b56c", "func", "m.data      = [vargraaddagen_data, varkwh_data_heat, varkwh_data_dhw];",
    "m.data      = [vargraaddagen_data, varkwh_data_heat];")

HELP_DD_DE = """<h3>Information</h3>
<br/>
<h3>Gradtage</h3>
Ein Gradtag (dd) ist ein Maß für den Unterschied zwischen der Außentemperatur und einer Referenztemperatur (18 °C). <br>
<br>
Ein Gradtag wird so berechnet:<br>
dd = 18 - Außentemperatur.<br>
dd wird auf 0 °C begrenzt.<br>
<br>
<b>Beispiel 1:</b>
Außentemperatur: 15 °C<br>
dd = 18 - 15 = 3 °C<br>
<br>
<b>Beispiel 2:</b>
Außentemperatur: -5 °C<br>
dd = 18 - (-5) = 23 °C<br>
<br>
<b>Beispiel 3:</b>
Außentemperatur: 30 °C<br>
dd = 18 - 30 (= -12 °C) = 0 °C<br> <br>
<br>
<b>Verbrauch pro Gradtag:</b>
Stromverbrauch der Heizung der letzten 7 Tage geteilt durch die Gradtage derselben Tage.
Sinkt der Wert nach einer Änderung an der Heizkurve, heizt die Wärmepumpe effizienter.<br>
<br>
"""
n = node("a19ced7de80acf30")
if n["format"] != HELP_DD_DE:
    if "A Degree Day (dd)" not in n["format"]:
        errors.append("degree days help template has unexpected content")
    n["format"] = HELP_DD_DE

# new KPI: electricity per degree day over the last 7 days (refreshed together with the 31 day chart)
KPI_FN, KPI_TXT, DD_GROUP, DD_TRIGGER = "a1c0b0000c0f0030", "a1c0b0000c0f0031", "87be08e6a82ef6a0", "757d35eee93ec9e7"
if KPI_TXT not in B:
    flows.append({"id": KPI_FN, "type": "function", "z": "ed155b604642d354", "name": "kWh pro Gradtag (7 Tage)",
                  "func": "// Stromverbrauch Heizung / Gradtage der letzten 7 Tage (Tageswerte aus den 31-Tage-Daten)\n"
                          "var heat = global.get('kwh_HEAT_31d', 'file');\n"
                          "var dd = global.get('degreedays_31d', 'file');\n"
                          "if (!heat || !dd) { return null; }\n"
                          "try {\n"
                          "    var h = heat.payload[0].data[0], g = dd.payload[0].data[0];\n"
                          "    var sh = 0, sg = 0;\n"
                          "    for (var i = 1; i <= 7 && i <= h.length && i <= g.length; i++) {\n"
                          "        sh += Number(h[h.length - i]) || 0;\n"
                          "        sg += Number(g[g.length - i]) || 0;\n"
                          "    }\n"
                          "    msg.payload = (sg >= 1) ? (sh / sg).toFixed(2).replace('.', ',') + ' kWh/Gradtag' : '–';\n"
                          "    return msg;\n"
                          "} catch (e) { return null; }",
                  "outputs": 1, "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [],
                  "x": 700, "y": 40, "wires": [[KPI_TXT]]})
    flows.append({"id": KPI_TXT, "type": "ui_text", "z": "ed155b604642d354", "group": DD_GROUP, "order": 4,
                  "width": 26, "height": 1, "name": "kWh pro Gradtag", "label": "Verbrauch pro Gradtag (letzte 7 Tage)",
                  "format": "{{msg.payload}}", "layout": "row-spread", "className": "", "x": 940, "y": 40, "wires": []})
    for x in flows:
        if x.get("group") == DD_GROUP and x["id"] != KPI_TXT and x.get("order", 0) >= 4:
            x["order"] += 1
    B[KPI_FN], B[KPI_TXT] = flows[-2], flows[-1]
    node(DD_TRIGGER)["wires"][0].append(KPI_FN)

# ================================================================ phase 3: outdoor temperature
# tap the final (selected) outdoor temperature at the "T_outside" link out of the WP Control tab
OUT_LIN, OUT_TXT, OUT_RBE, OUT_CHART = ("a1c0b0000c0f0040", "a1c0b0000c0f0041", "a1c0b0000c0f0042", "a1c0b0000c0f0043")
T_OUTSIDE_LINK_OUT = "d6a9c376dde9c43f"
if OUT_TXT not in B:
    out_row_is_new = True
    flows.append({"id": OUT_LIN, "type": "link in", "z": WP_DASH, "name": "Außentemperatur",
                  "links": [T_OUTSIDE_LINK_OUT], "x": 140, "y": 2160, "wires": [[OUT_TXT, OUT_RBE]], "l": True})
    flows.append({"id": OUT_TXT, "type": "ui_text", "z": WP_DASH, "group": "bf4af523ba16d457", "order": 3,
                  "width": 6, "height": 1, "name": "Außentemperatur", "label": "Außentemperatur",
                  "format": "{{msg.payload}} °C", "layout": "row-spread", "className": "", "x": 380, "y": 2140, "wires": []})
    # one point per 5 minutes for the chart (HeishaMon sends far more often than that)
    flows.append({"id": OUT_RBE, "type": "delay", "z": WP_DASH, "name": "1 Punkt / 5 min", "pauseType": "rate",
                  "timeout": "5", "timeoutUnits": "seconds", "rate": "1", "nbRateUnits": "5", "rateUnits": "minute",
                  "randomFirst": "1", "randomLast": "5", "randomUnits": "seconds", "drop": True,
                  "allowrate": False, "outputs": 1, "x": 370, "y": 2180, "wires": [[OUT_CHART]]})
    flows.append({"id": OUT_CHART, "type": "ui_chart", "z": WP_DASH, "group": "e374621a9f5ac0d6",
                  "name": "Außentemperatur", "label": "Außentemperatur (°C)", "order": 10, "width": 26, "height": 7,
                  "chartType": "line", "legend": "false", "xformat": "HH:mm", "interpolate": "step",
                  "nodata": "", "dot": False, "ymin": "", "ymax": "", "removeOlder": "48",
                  "removeOlderPoints": "2000", "removeOlderUnit": "3600", "cutout": 0, "useOneColor": False,
                  "useUTC": False,
                  "colors": ["#1f77b4", "#aec7e8", "#ff7f0e", "#2ca02c", "#98df8a", "#d62728", "#ff9896",
                             "#9467bd", "#c5b0d5"],
                  "outputs": 1, "useDifferentColor": False, "className": "", "x": 590, "y": 2180, "wires": [[]]})
    B.update({n["id"]: n for n in flows[-4:]})
    node(T_OUTSIDE_LINK_OUT)["links"].append(OUT_LIN)
    # make room on Home (order 3 is taken by the new row)
    for x in flows:
        if x.get("group") == "bf4af523ba16d457" and x["id"] != OUT_TXT and x.get("order", 0) >= 3:
            x["order"] += 1

# the value only arrives when HeishaMon sends it; replay the stored one at start and every 5 minutes
OUT_INJ, OUT_FN = "a1c0b0000c0f0044", "a1c0b0000c0f0045"
if OUT_FN not in B:
    flows.append({"id": OUT_INJ, "type": "inject", "z": WP_DASH, "name": "Außentemperatur nachreichen",
                  "props": [{"p": "payload"}], "repeat": "300", "crontab": "", "once": True, "onceDelay": "5",
                  "topic": "", "payload": "", "payloadType": "date", "x": 150, "y": 2220,
                  "wires": [[OUT_FN]]})
    flows.append({"id": OUT_FN, "type": "function", "z": WP_DASH, "name": "T_outside lesen",
                  "func": "var t = global.get('T_outside', 'file');\n"
                          "if (t === undefined || isNaN(Number(t))) { return null; }\n"
                          "msg.payload = Number(t);\n"
                          "msg.topic = 'T_outside';\n"
                          "return msg;",
                  "outputs": 1, "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [],
                  "x": 380, "y": 2220, "wires": [[OUT_TXT, OUT_RBE]]})
    B[OUT_INJ], B[OUT_FN] = flows[-2], flows[-1]

# ================================================================ phase 4: remaining pages, translation tables
import glob
import os

SCOPE_TABS = ["Settings", "Pumpspeed", "CCC", "RTC", "SoftStart", "Scheduler", "SYSTEM"]
SKIP_GROUPS = {"ABOUT"}                       # changelog / acknowledgements stay English
HIDE_TABS = ["Cool", "Solar²DHW"]             # not used with a heating-only installation

TR = {}
for _f in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "de", "*.json"))):
    TR.update(json.load(open(_f, encoding="utf-8")))

_TAG = re.compile(r"(<[^>]+>)")
_BLOCK = re.compile(r"(<(?:style|script)\b.*?</(?:style|script)>)", re.S | re.I)


def tr_str(v):
    return TR.get(v, v) if isinstance(v, str) else v


def tr_html(html):
    """Translate visible text segments of a template; style/script blocks and tags stay untouched."""
    out = []
    for part in _BLOCK.split(html):
        if _BLOCK.fullmatch(part):
            out.append(part)
            continue
        for tok in _TAG.split(part):
            if tok.startswith("<") and tok.endswith(">"):
                out.append(tok)
                continue
            key = re.sub(r"\s+", " ", tok.strip())
            if key in TR and TR[key] != key:
                lead = tok[: len(tok) - len(tok.lstrip())]
                trail = tok[len(tok.rstrip()):]
                out.append(lead + TR[key] + trail)
            else:
                out.append(tok)
    return "".join(out)


ui_tabs = {n["id"]: n for n in flows if n["type"] == "ui_tab"}
ui_groups = {n["id"]: n for n in flows if n["type"] == "ui_group"}
scope_tab_ids = {i for i, t in ui_tabs.items() if t["name"] in SCOPE_TABS or t["name"] in
                 [tr_str(x) for x in SCOPE_TABS]}
old_names = {}                                # for the "<tab>_<group>" references


def us(x):
    return x.replace(" ", "_")


# remember the old names before anything is renamed (needed to follow group show/hide references)
for gid, g in ui_groups.items():
    if g["tab"] in scope_tab_ids:
        old_names[gid] = (ui_tabs[g["tab"]]["name"], g["name"])

for tid in scope_tab_ids:
    t = ui_tabs[tid]
    t["name"] = tr_str(t["name"])
for gid, (otab, ogrp) in old_names.items():
    if ogrp not in SKIP_GROUPS:
        ui_groups[gid]["name"] = tr_str(ui_groups[gid]["name"])

# follow "<tab name>_<group name>" references (dashboard show/hide payloads) for renamed tabs/groups
ref_map = {}
for gid, (otab, ogrp) in old_names.items():
    ntab, ngrp = ui_tabs[ui_groups[gid]["tab"]]["name"], ui_groups[gid]["name"]
    if (otab, ogrp) != (ntab, ngrp):
        ref_map[us(otab) + "_" + us(ogrp)] = us(ntab) + "_" + us(ngrp)
if ref_map:
    pat = re.compile("(?<![A-Za-z0-9_])(" + "|".join(re.escape(k) for k in sorted(ref_map, key=len, reverse=True))
                     + ")(?![A-Za-z0-9_])")
    for n in flows:
        if n["type"] in ("ui_tab", "ui_group"):
            continue
        for k, v in list(n.items()):
            if isinstance(v, str) and pat.search(v):
                n[k] = pat.sub(lambda m: ref_map[m.group(1)], v)

for n in flows:
    g = ui_groups.get(n.get("group"))
    if not g or g["tab"] not in scope_tab_ids or g["id"] not in old_names or old_names[g["id"]][1] in SKIP_GROUPS:
        continue
    t = n["type"]
    if not t.startswith("ui_"):
        continue
    for k in ("label", "title", "tooltip"):
        if k in n:
            n[k] = tr_str(n[k])
    if t in ("ui_text", "ui_gauge", "ui_numeric", "ui_slider"):
        for k in ("format", "units"):
            if k in n:
                n[k] = tr_str(n[k])
    if t == "ui_dropdown":
        for o in n.get("options", []):
            if "label" in o:
                o["label"] = tr_str(o["label"])
        if "place" in n:
            n["place"] = tr_str(n["place"])
    if t == "ui_form":
        for o in n.get("options", []):
            if "label" in o:
                o["label"] = tr_str(o["label"])
        for k in ("submit", "cancel"):
            if k in n:
                n[k] = tr_str(n[k])
    if t == "ui_template" and isinstance(n.get("format"), str):
        n["format"] = tr_html(n["format"])

for tn in HIDE_TABS:
    for t in ui_tabs.values():
        if t["name"] == tn:
            t["hidden"] = True

# ================================================================ phase 5: menu configuration (SYSTEM > MENU CONFIG)
# The three forms address tabs by name ("tabs") and groups as "<tab>_<group>" ("group"/"group2"). The values are
# matched by the dashboard, so they must follow the renames; options for hidden elements are dropped.
MENU_TABS_FORM, MENU_HOME_FORM, MENU_SETTINGS_FORM = "e35b7df78bc6f722", "e4a4fc20462d5562", "7fa1754db79c4869"


def remap_form(form_id, value_map, drop):
    f = node(form_id)
    f["options"] = [dict(o, value=value_map.get(o["value"], o["value"])) for o in f["options"] if o["value"] not in drop]
    fv = {}
    for k, v in f["formValue"].items():
        if k in drop:
            continue
        fv[value_map.get(k, k)] = v
    f["formValue"] = fv


remap_form(MENU_TABS_FORM,
           {"SETTINGS": "Einstellungen", "CCC": "Heizkurve", "RTC": "Raumregelung", "Pumpspeed": "Pumpendrehzahl", "SCHEDULER": "Zeitplan",
            "TEMPERATURES": "Temperaturen", "EFFICIENCY": "Effizienz", "Degree_days": "Gradtage"},
           drop={"COOL", "Solar²DHW"})
remap_form(MENU_HOME_FORM,
           {"Home_HEAT_(zone_1)": "Übersicht_HEIZEN_(Zone_1)"},
           drop={"Home_HEAT_(zone_2)", "Home_DHW", "Home_COOL"})
remap_form(MENU_SETTINGS_FORM,
           {"Settings_HEAT_PUMP": "Einstellungen_WÄRMEPUMPE", "Settings_OPERATION": "Einstellungen_BETRIEB",
            "Settings_HEAT": "Einstellungen_HEIZEN", "Settings_DHW": "Einstellungen_WARMWASSER"},
           drop=set())

# the flow re-sends "hide Power" every 5 minutes; add the tabs of a heating-only installation to it
setf("63c695317a49ea6b", "payload", '{"tabs":{"hide":["Power"]}}', '{"tabs":{"hide":["Power","Cool","Solar²DHW"]}}')
# a string payload would be read by ui_control as "switch to tab <text>"; it has to be an object to hide tabs
setf("63c695317a49ea6b", "payloadType", "str", "json")

# ================================================================ phase 6: CCC -> Heizkurve, Pumpspeed chart legend
setf("12842f4ef6ffc342", "label", "CCC", "Heizkurve")           # Home: "CCC (13 °C)" = Heizkurve (Außentemperatur)
rep("f2ccd5d9f4518044", "func", "msg1.topic = 'Flow (L/min)';", "msg1.topic = 'Durchfluss (l/min)';")
rep("f2ccd5d9f4518044", "func", "msg2.topic = 'Maximum pumpspeed (%)';", "msg2.topic = 'Max. Pumpendrehzahl (%)';")
rep("f2ccd5d9f4518044", "func", "msg4.topic = 'Mode';", "msg4.topic = 'Modus';")

# ================================================================ phase 7: chart legends (series names = msg.topic)
def series_names(i, mapping):
    """Rename series by changing `msg.topic = 'old'` assignments; refuses if the text is also compared in the node."""
    n = node(i)
    code = n["func"]
    for old, new in mapping.items():
        pat = re.compile(r"(\.topic\s*=\s*)(['\"])" + re.escape(old) + r"\2")
        k = len(pat.findall(code))
        if k == 0:
            if new in code:
                continue
            errors.append(f"{i}: topic {old!r} not found")
            continue
        if re.search(r"(==|!=)=?\s*['\"]" + re.escape(old) + r"['\"]|['\"]" + re.escape(old) + r"['\"]\s*(==|!=)", code):
            errors.append(f"{i}: {old!r} is compared in the code, not renaming")
            continue
        code = pat.sub(lambda m: m.group(1) + m.group(2) + new + m.group(2), code)
    n["func"] = code


series_names("5b0c451c1ec63b84", {"T outside": "Außentemp.", "SP WAR": "Sollwert Heizkurve"})        # Heizkurve zone 1 profile
series_names("6500967add5c38cf", {"T outside": "Außentemp.", "SP WAR": "Sollwert Heizkurve"})        # Heizkurve zone 2 profile
for fid in ("6c95ed35d3dcaea3", "9a4c2e2328c9aa18"):                                                   # Heizkurve time chart
    series_names(fid, {"T outside": "Außentemp.", "CCC Setpoint": "Sollwert Heizkurve",
                       "T outside custom": "Außentemp. (eigener Sensor)"})
series_names("38a2e1df7e0bdb2a", {"Room SP": "Raum Soll", "Room PV": "Raum Ist", "Floor T1": "Boden T1",
                                  "Floor T2": "Boden T2", "Trigger": "Auslösen", "Revert": "Zurücknehmen",
                                  "+custom": "+eigen"})
series_names("cf7a6e8cc8d1ebce", {"Room2 SP": "Raum 2 Soll", "Room2 PV": "Raum 2 Ist", "Trigger": "Auslösen",
                                  "Revert": "Zurücknehmen", "+custom": "+eigen"})
series_names("3578d6b18ceb5727", {"Setpoint": "Sollwert", "Water inlet": "Wasser Rücklauf",
                                  "Water outlet": "Wasser Vorlauf", "Frequency": "Frequenz",
                                  "Correction": "Korrektur", "QuietMode level": "Leisemodus-Stufe"})

setf("1f5d513050d612a1", "label", "RTC", "Raumregelung")        # Home: "RTC (24 °C)" = Raumregelung (Raumtemperatur)

if errors:
    print("\n".join("ERROR: " + e for e in errors))
    sys.exit(1)

with open(path, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(flows, indent=4, ensure_ascii=False))
print("ok")

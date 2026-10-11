#!/usr/bin/env python3
"""Verzoegerungstest: Eingriff in die HeishaMoNR-Kerntabs (WP Control, WP Managers). Alles hier wird erst nach ausdruecklichem Go angewendet.

Drei Teile, alle mit Markierung und vollstaendig rueckbaubar:
 1. Summenfunktion "Calculate new SP Zone 1 + 2" (add6fa4d403dd143, Tab WP Control): addiert OPT_test_shift (vom Pruefstand opt_dt) zu SHIFT_Final_z1.
    Der Beitrag zaehlt nur, wenn er frisch ist (OPT_test_ts hoechstens 150 s alt) und Raumregelung, Softstart und Nachtabsenkung aus sind;
    er ist hart auf -1..+1 K begrenzt; ohne Wert/bei Fehler ist er 0.
 2. Takt fuer die Summenfunktion (Tab WP Control): Inject jede Minute -> Pforte (nur im Testfenster OPT_dt_window) -> vorhandener 100-ms-Trigger
    987d38642eaa3c4c -> Summenfunktion. Ohne Takt laeuft die Summenfunktion nur bei Vorlauf/Ruecklauf/Verdichter-Aenderungen (Luecken bis 53 min),
    dann wirken weder Totmann noch Rueckstellung. Ausserhalb des Testfensters bleibt HeishaMoNR rein ereignisgesteuert wie bisher.
 3. Rueckstellwaechter (Tab WP Managers): gleicht im Testfenster jede Minute die Verschiebung an der Anlage (TOP27) mit dem Wert ab, den HeishaMoNR
    OHNE Test will (gleiche Summe wie die Summenfunktion). Er sendet nur nach UNTEN, nur wenn kein Test aktiv ist, nicht bei MQTT-Sperre, nicht bei
    veralteten HeishaMon-Werten, fruehestens 2 min nach Erkennen, dann hoechstens alle 3 min (5 Befehle), danach alle 30 min, hoechstens 12 Befehle je
    Abweichung. Ausgang 1 -> vorhandene Ratenbegrenzung vor "Dynamic MQTT out" (bfa541a4cf7363ca, dahinter die globale Sperre), Ausgang 2 -> Log/Hinweis.
    Bleibt die Abweichung 15 min, meldet er einen Alarm (Hinweis im Dashboard und Ereignislog).
    Ausgang 3 -> "Filter" (78cd6de319a6d061): einmal je Node-RED-Start, sobald das Testfenster offen ist, eine Platzhalter-Nachricht. Der Filter verschluckt nach
    jedem Start die ERSTE Nachricht (er merkt sich ihre ID); ohne Platzhalter ginge der erste Teststart nach einem Neustart verloren.

Aufruf:   python3 delaytest_patch.py flows.json            (anwenden; idempotent)
          python3 delaytest_patch.py flows.json --revert   (alles entfernen; Summenfunktion wieder Byte fuer Byte wie vorher)
          python3 delaytest_patch.py flows.json --revert --pruefstand-entfernen
                                                           (zusaetzlich den Pruefstand im Optimizer-Tab entfernen: opt_dt, Takt, Protokoll, Schalter, Status, Gruppe)
          python3 delaytest_patch.py flows.json --check    (Exit 0 = alles drin, 1 = nichts drin, 2 = Anker fehlen, 3 = nur teilweise drin)
          python3 delaytest_patch.py --ids                 (die Knoten-IDs, die der Patch aendert/anlegt, fuer die Ausnahmeliste des Deploys)
          python3 delaytest_patch.py --diff vorher.json nachher.json   (prueft, dass sich ausser opt_* nur diese Knoten unterscheiden)
"""
import json
import sys

NODE_ID = "add6fa4d403dd143"          # Summenfunktion (WP Control)
TRIGGER_ID = "987d38642eaa3c4c"       # vorhandener 100-ms-Trigger vor der Summenfunktion
RATE_ID = "bfa541a4cf7363ca"          # Ratenbegrenzung 1 Nachricht / 7 s vor "Block?" -> "Dynamic MQTT out" (WP Managers)
MQTTIN_LINK_ID = "8b3d729fe630c248"   # link in "> MQTT OUT" (fuehrt auf RATE_ID)
LOG_LINK_ID = "7ddd3f5d8f76897e"      # link out "exit to INPUTlogs" (Hinweis-Toast + Debuglog)
FILTER_ID = "78cd6de319a6d061"        # "Filter" vor "Compare SP z1 and z2" (verschluckt nach jedem Start die erste Nachricht)
TICK_ID, GATE_ID, GTICK_ID, GUARD_ID = "dtpatch_sumtick", "dtpatch_sumgate", "dtpatch_guard_tick", "dtpatch_guard"
NEW_IDS = [TICK_ID, GATE_ID, GTICK_ID, GUARD_ID]
DT_IDS = ["opt_dt", "opt_i_dt", "opt_f_dt", "opt_ui_dt_arm", "opt_ui_dt_status", "opt_g_dt"]      # Pruefstand im Optimizer-Tab (vom Generator angelegt)
MARK_BEGIN = "// OPT-VERZOEGERUNGSTEST (Patch) -- Anfang"
MARK_END = "// OPT-VERZOEGERUNGSTEST (Patch) -- Ende"
ANCHOR_DEF = "var TOP94_Zones_State = global.get(\"TOP94_Zones_State\", \"file\")\n    if (TOP94_Zones_State === undefined) { return null; }\n"
OLD_SUM = "SHIFT_Final_z1 = (Math.round((SP_Start_z1 + F_RTC_correction_z1 + F_NR_correction + F_SS_correction) * 10 )) / 10"
NEW_SUM = "SHIFT_Final_z1 = (Math.round((SP_Start_z1 + F_RTC_correction_z1 + F_NR_correction + F_SS_correction + OPT_TEST) * 10 )) / 10"
BLOCK = (
    MARK_BEGIN + "\n"
    "var OPT_TEST = 0;\n"
    "try {\n"
    "    var OPT_T_V = global.get('OPT_test_shift'), OPT_T_TS = global.get('OPT_test_ts'), OPT_T_AGE = Date.now() - OPT_T_TS;\n"
    "    if (typeof OPT_T_V === 'number' && isFinite(OPT_T_V) && typeof OPT_T_TS === 'number' && OPT_T_AGE <= 150000 && OPT_T_AGE >= -60000\n"
    "        && F_RTC_state_z1 === 0 && F_SS_state === 0 && F_NR_state === 0) {          // nur ohne Raumregelung/Softstart/Nachtabsenkung: nie mehr als +1 K\n"
    "        OPT_TEST = Math.max(-1, Math.min(1, OPT_T_V));\n"
    "    }\n"
    "} catch (e) { OPT_TEST = 0; }\n"
    + MARK_END + "\n"
)

# Testfenster: vom Pruefstand (opt_dt) gesetzt und in eine Datei geschrieben, damit Takt und Waechter auch nach einem Neustart von Node-RED wirken.
WINDOW_JS = r"""
var W = global.get('OPT_dt_window');
if (W === undefined) {                                                          // nach einem Neustart: Fenster aus der Datei des Pruefstands
    try { W = JSON.parse(fs.readFileSync('/data/optimizer/delaytest-window.json', 'utf8')); } catch (e) { W = null; }
    global.set('OPT_dt_window', W);
}
var inWindow = !!(W && typeof W.until === 'number' && Date.now() <= W.until);
"""

GATE_JS = r"""// OPT-VERZOEGERUNGSTEST: Takt fuer die Summenfunktion, NUR im Testfenster (sonst bleibt HeishaMoNR ereignisgesteuert wie bisher).
// Ein Aufruf aendert nichts, solange sich die berechnete Verschiebung nicht aendert (die Summenfunktion sendet nur bei Aenderung).
""" + WINDOW_JS + r"""
if (!inWindow) { return null; }
return {topic: 'OPT-Verzoegerungstest', payload: 'tick'};
"""

GUARD_JS = r"""// OPT-VERZOEGERUNGSTEST: Rueckstellwaechter. Gleicht im Testfenster die Verschiebung an der Anlage (TOP27) mit dem Wert ab, den HeishaMoNR OHNE Test
// will (gleiche Summe wie "Calculate new SP Zone 1 + 2", ohne den Testbeitrag). Sendet NUR nach unten und nur diesen Wert, nie einen Testwert.
// Grund: die Befehlskette (Filter -> Compare SP -> Block? -> MQTT OUT -> Command Check) sendet nur bei Aenderungen und gleicht nie nach.
""" + WINDOW_JS + r"""
var now = Date.now(), MIN = 60000;
var st = context.get('st') || {since: 0, last: 0, n: 0, alarm: false, info: ''};
if (inWindow && !context.get('primed')) {                                       // Filter einmal je Start vorbereiten (siehe Kopf von delaytest_patch.py)
    context.set('primed', true);
    node.send([null, null, {topic: 'OPT-Verzoegerungstest', payload: 'OPT-Platzhalter'}]);
}
function done(text, alarmText) {
    var out2 = null;
    if (alarmText && !st.alarm) { st.alarm = true; out2 = {topic: 'Verzögerungstest', payload: alarmText}; }
    st.info = text;
    context.set('st', st);
    global.set('OPT_dt_guard', {ts: now, text: text, alarm: st.alarm, n: st.n});
    return out2;
}
function clear() { st.since = 0; st.n = 0; st.last = 0; st.alarm = false; }
if (!inWindow) { clear(); context.set('st', st); return null; }
var ov = global.get('OPT_test_shift'), ot = global.get('OPT_test_ts');
if (ov === 1 && typeof ot === 'number' && now - ot <= 150000 && now - ot >= -60000) { clear(); done('Test aktiv, der Prüfstand ist zuständig'); return null; }
function G(k) { return global.get(k, 'file'); }
function n0(v) { return v === undefined ? 0 : v; }
// Verschiebung ohne Test, genau wie die Summenfunktion im Heizkurvenmodus (Zone 1)
var base = G('F_CCC.z1.SP_DIRECT_virt'), rtc = G('F_RTC.z1.correction_value'), ss = G('F_SS.correction_value'), nr = G('NightReductionWaterTemp.correction');
var want = null;
if (typeof base === 'number' && typeof rtc === 'number' && typeof ss === 'number' && typeof nr === 'number') {
    if (n0(G('F_RTC.z1.state')) === 0) { rtc = 0; }
    if (n0(G('F_SS.state')) === 0) { ss = 0; }
    if (n0(G('NightReductionWaterTemp.state')) === 0) { nr = 0; }
    var sh = Math.round((base + rtc + nr + ss) * 10) / 10;
    sh = Math.max(-5, Math.min(5, sh));
    want = Math.ceil(sh);
}
var hp = global.get('TOP27_Z1_Heat_Request_Temp');
var HP = global.get('OPT_hp'), fresh = true;
if (HP && typeof HP === 'object') { fresh = Object.keys(HP).some(function (k) { return HP[k] && typeof HP[k].ts === 'number' && now - HP[k].ts <= 6 * MIN; }); }
var mqtt = G('MQTT.block_active') === 1;
var modeOk = G('TOP76_Heating_Mode') === 0 && G('TOP94_Zones_State') === 0 && G('TOP111_Z1_Sensor_Settings') === 0 && G('TOP0_Heatpump_State') === 1;
if (typeof hp === 'number' && want !== null && hp <= want) { clear(); return [null, done('Anlage ' + hp + ' K, HeishaMoNR will ' + want + ' K: in Ordnung')]; }
if (!modeOk) { clear(); return [null, done('Wärmepumpe aus oder nicht Heizkurvenmodus/Zone 1/Wasserfühler: keine Rückstellung')]; }
if (!st.since) { st.since = now; }
var mins = Math.round((now - st.since) / MIN);
var alarmTxt = mins >= 15 ? 'Verzögerungstest: Verschiebung an der Anlage seit ' + mins + ' min nicht zurückgestellt' : '';
if (typeof hp !== 'number' || want === null) { return [null, done('Werte fehlen (Anlage ' + hp + ', Ziel ' + want + '), warte', alarmTxt)]; }
if (hp - want > 2) { return [null, done('Anlage ' + hp + ' K, HeishaMoNR will ' + want + ' K: Abweichung größer als ein Test, keine Rückstellung', alarmTxt)]; }
if (!fresh) { return [null, done('HeishaMon meldet nicht, warte (Anlage ' + hp + ' K, Ziel ' + want + ' K)', alarmTxt)]; }
if (mqtt) { return [null, done('MQTT-Befehle gesperrt, warte (Anlage ' + hp + ' K, Ziel ' + want + ' K)', alarmTxt)]; }
var gap = st.n < 5 ? 3 * MIN : 30 * MIN;
if (now - st.since < 2 * MIN || now - st.last < gap || st.n >= 12) {
    return [null, done('Anlage ' + hp + ' K, Ziel ' + want + ' K: ' + (st.n >= 12 ? 'keine weiteren Befehle (12 gesendet)' : 'nächster Rückstellbefehl folgt'), alarmTxt)];
}
st.last = now; st.n++;
var info = done('Rückstellbefehl ' + st.n + ' gesendet (Anlage ' + hp + ' K, Ziel ' + want + ' K)', alarmTxt);
return [{topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature', payload: want, source: 'Verzögerungstest-Rückstellung'},
        info || {topic: 'Verzögerungstest', payload: 'Rückstellung: Anlage meldet ' + hp + ' K, HeishaMoNR will ' + want + ' K, Befehl ' + st.n}];
"""


def find(flows, nid):
    return next((n for n in flows if n.get("id") == nid), None)


def anchors(flows):
    """Prueft alle Anker; gibt Fehlertext oder '' zurueck."""
    s = find(flows, NODE_ID)
    if s is None or s.get("type") != "function" or "Calculate new SP" not in s.get("name", ""):
        return "Summenfunktion %s fehlt" % NODE_ID
    code = s["func"]
    if MARK_BEGIN not in code and (code.count(ANCHOR_DEF) != 1 or code.count(OLD_SUM) != 1):
        return "Anker in der Summenfunktion fehlen (Funktion geaendert?)"
    t = find(flows, TRIGGER_ID)
    if t is None or t.get("type") != "trigger" or t.get("wires") != [[NODE_ID]] or t.get("z") != s.get("z"):
        return "Trigger vor der Summenfunktion fehlt/geaendert"
    r = find(flows, RATE_ID)
    li = find(flows, MQTTIN_LINK_ID)
    if r is None or r.get("type") != "delay" or li is None or li.get("type") != "link in" or li.get("wires") != [[RATE_ID]]:
        return "Ratenbegrenzung vor MQTT OUT fehlt/geaendert"
    f = find(flows, FILTER_ID)
    if f is None or f.get("type") != "function" or f.get("name") != "Filter" or f.get("z") != r.get("z") or "last_msgid" not in f.get("func", ""):
        return "Filter vor Compare SP fehlt/geaendert"
    lo = find(flows, LOG_LINK_ID)
    if lo is None or lo.get("type") != "link out" or lo.get("z") != r.get("z"):
        return "Log-Ausgang (exit to INPUTlogs) fehlt/geaendert"
    return ""


def state(flows):
    s = find(flows, NODE_ID)
    parts = [MARK_BEGIN in (s or {}).get("func", "")] + [find(flows, i) is not None for i in NEW_IDS]
    return parts


def apply(flows):
    err = anchors(flows)
    if err:
        raise SystemExit(err + ": Patch bricht ab, nichts geaendert")
    changed = False
    s = find(flows, NODE_ID)
    if MARK_BEGIN not in s["func"]:
        s["func"] = s["func"].replace(ANCHOR_DEF, ANCHOR_DEF + BLOCK, 1).replace(OLD_SUM, NEW_SUM, 1)
        changed = True
    t, r = find(flows, TRIGGER_ID), find(flows, RATE_ID)
    new = [
        {"id": TICK_ID, "type": "inject", "z": t["z"], "name": "OPT-Test: Summenfunktion jede Minute", "props": [{"p": "payload"}], "repeat": "60", "crontab": "",
         "once": True, "onceDelay": "40", "topic": "", "payload": "tick", "payloadType": "str", "x": t["x"] - 360, "y": t["y"] + 60, "wires": [[GATE_ID]]},
        {"id": GATE_ID, "type": "function", "z": t["z"], "name": "OPT-Test: nur im Testfenster", "func": GATE_JS, "outputs": 1, "timeout": 0, "noerr": 0,
         "initialize": "", "finalize": "", "libs": [{"var": "fs", "module": "fs"}], "x": t["x"] - 160, "y": t["y"] + 60, "wires": [[TRIGGER_ID]]},
        {"id": GTICK_ID, "type": "inject", "z": r["z"], "name": "OPT-Test: Rückstellwächter jede Minute", "props": [{"p": "payload"}], "repeat": "60", "crontab": "",
         "once": True, "onceDelay": "90", "topic": "", "payload": "", "payloadType": "date", "x": r["x"] - 420, "y": r["y"] + 120, "wires": [[GUARD_ID]]},
        {"id": GUARD_ID, "type": "function", "z": r["z"], "name": "OPT-Test: Rückstellwächter Verschiebung", "func": GUARD_JS, "outputs": 3, "timeout": 0, "noerr": 0,
         "initialize": "", "finalize": "", "libs": [{"var": "fs", "module": "fs"}], "x": r["x"] - 180, "y": r["y"] + 120, "wires": [[RATE_ID], [LOG_LINK_ID], [FILTER_ID]]},
    ]
    for n in new:
        old = find(flows, n["id"])
        if old is None:
            flows.append(n)
            changed = True
        elif old != n:
            flows[flows.index(old)] = n
            changed = True
    return changed


def revert(flows):
    changed = False
    s = find(flows, NODE_ID)
    if s is not None and MARK_BEGIN in s["func"]:
        code = s["func"]
        a = code.index(MARK_BEGIN)
        b = code.index(MARK_END) + len(MARK_END) + 1
        code = code[:a] + code[b:]
        if code.count(NEW_SUM) != 1:
            raise SystemExit("Summenzeile nicht gefunden: Revert bricht ab, nichts geaendert")
        s["func"] = code.replace(NEW_SUM, OLD_SUM, 1)
        changed = True
    n = len(flows)
    flows[:] = [x for x in flows if x.get("id") not in NEW_IDS]
    return changed or len(flows) != n


def diff(a_path, b_path):
    a = {n["id"]: n for n in json.load(open(a_path, encoding="utf-8"))}
    b = {n["id"]: n for n in json.load(open(b_path, encoding="utf-8"))}
    ch = sorted(i for i in set(a) | set(b) if a.get(i) != b.get(i))
    bad = [i for i in ch if not i.startswith("opt_") and i not in [NODE_ID] + NEW_IDS]
    print("geaendert/neu/entfernt:", len(ch), "| davon Kern:", [i for i in ch if i in [NODE_ID] + NEW_IDS], "| unerlaubt:", bad)
    raise SystemExit(1 if bad else 0)


def main():
    args = sys.argv[1:]
    if "--ids" in args:
        print(" ".join([NODE_ID] + NEW_IDS))
        return
    if "--diff" in args:
        i = args.index("--diff")
        diff(args[i + 1], args[i + 2])
    if not args:
        raise SystemExit(__doc__)
    path = args[0]
    flags = set(args[1:])
    flows = json.load(open(path, encoding="utf-8"))
    if "--check" in flags:
        parts = state(flows)
        if all(parts):
            print("Patch ist vollstaendig drin")
            raise SystemExit(0)
        if any(parts):
            print("Patch ist nur TEILWEISE drin:", dict(zip(["Summenfunktion"] + NEW_IDS, parts)))
            raise SystemExit(3)
        err = anchors(flows)
        print("Patch ist NICHT drin" + ("" if not err else " (" + err + ")"))
        raise SystemExit(2 if err else 1)
    changed = revert(flows) if "--revert" in flags else apply(flows)
    if "--revert" in flags and "--pruefstand-entfernen" in flags:
        n = len(flows)
        flows[:] = [x for x in flows if x.get("id") not in DT_IDS]
        changed = changed or len(flows) != n
    if changed:
        raw = open(path, encoding="utf-8").read()
        indent = 4 if raw.lstrip("[").startswith("\n") else None          # Formatierung der Datei beibehalten (kompakt oder eingerueckt)
        json.dump(flows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=indent)
        print("geaendert:", "Revert" if "--revert" in flags else "Patch", "(" + " ".join([NODE_ID] + NEW_IDS) + ")")
    else:
        print("nichts zu tun")


if __name__ == "__main__":
    main()

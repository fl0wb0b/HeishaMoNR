#!/usr/bin/env python3
"""Kern-Robustheit der HeishaMoNR-Befehlskette (VORBEREITET, nicht im Deploy-Paket; braucht das ausdrueckliche Go des Nutzers).

Herausgeloest aus dem Verzoegerungstest (Branch delaytest-v2, tools/delaytest_patch.py), aber unabhaengig davon: kein Testbeitrag, kein Testfenster,
die Summenfunktion bleibt Byte fuer Byte unveraendert. Drei Teile, alle mit Markierung "OPT-Kern" und vollstaendig rueckbaubar:

 K1 Ist/Soll-Abgleich (Tab WP Managers, kpatch_guard + kpatch_guard_tick): jede Minute die Verschiebung an der Anlage (TOP27) gegen den Wert, den
    HeishaMoNR will (gleiche Summe wie "Calculate new SP Zone 1 + 2": CCC + Raumregelung + Nachtabsenkung + Softstart, gerundet, auf +-5 begrenzt,
    aufgerundet). Sendet NUR nach UNTEN (Anlage hoeher als gewollt) und nur genau den gewollten Wert. Nicht bei: anderem Modus (nur Heizkurvenmodus,
    Zone 1, Wasserfuehler, Waermepumpe an), MQTT-Sperre, HeishaMon-Werten aelter als 6 min, Abweichung > 2 K (dann ist es kein verlorener Befehl, sondern
    eine bewusste Einstellung), aktiver Uebernahme des Optimierers (OPT_apply.aktiv mit SetZ1HeatRequestTemperature und genau diesem Wert), Schalter
    global OPT_kern_aus = true. Zeitplan: fruehestens 2 min nach dem Erkennen, dann alle 3 min (5 Befehle), danach alle 30 min, hoechstens 12 je
    Abweichung; Alarm (Hinweis) nach 15 min. Ausgang 1 -> Ratenbegrenzung vor MQTT OUT (bfa541a4cf7363ca, dahinter die globale Sperre), Ausgang 2 -> Log.
 K2 Filter wieder durchlaessig machen (im selben Knoten, Ausgang 3 -> Filter 78cd6de319a6d061): einmal je Node-RED-Start, sobald TOP42 und TOP27 gemeldet
    sind, ein Platzhalter. Befund (geprueft mit dem echten Knotencode): der Filter selbst laesst die erste Nachricht durch; nach einem Neustart verwirft
    aber "Compare SP" sie, solange TOP42 noch nicht gemeldet ist (HeishaMon meldet nur bei Aenderung, alles erst alle 300 s), und danach haelt der Filter
    denselben Wert als "unveraendert" zurueck. Der Platzhalter setzt den gemerkten Wert des Filters zurueck.
 K3 Takt der Summenfunktion (Tab WP Control, kpatch_sumtick): Inject jede Minute -> vorhandener 100-ms-Trigger 987d38642eaa3c4c -> Summenfunktion.
    Ohne Takt rechnet sie nur bei Vorlauf-/Ruecklauf-/Verdichter-Aenderungen (Luecken bis 53 min gemessen), zeitabhaengige Teile (Nachtabsenkung,
    Raumregelung) wirken dann spaet. Die Kette sendet weiterhin nur bei Aenderung (Filter, Compare SP), es entstehen keine zusaetzlichen Befehle.

Aufruf:   python3 kern_patch.py flows.json             (anwenden; idempotent)
          python3 kern_patch.py flows.json --revert    (alles entfernen)
          python3 kern_patch.py flows.json --check     (Exit 0 = alles drin, 1 = nichts drin, 2 = Anker fehlen, 3 = nur teilweise drin)
          python3 kern_patch.py --ids                  (die Knoten-IDs fuer die Ausnahmeliste eines Deploys)
          python3 kern_patch.py --diff vorher.json nachher.json   (prueft, dass sich ausser opt_* nur diese Knoten unterscheiden)
"""
import json
import sys

SUM_ID = "add6fa4d403dd143"           # Summenfunktion (WP Control), wird NICHT geaendert
TRIGGER_ID = "987d38642eaa3c4c"       # vorhandener 100-ms-Trigger vor der Summenfunktion
RATE_ID = "bfa541a4cf7363ca"          # Ratenbegrenzung 1 Nachricht / 7 s vor "Block?" -> "Dynamic MQTT out" (WP Managers)
MQTTIN_LINK_ID = "8b3d729fe630c248"   # link in "> MQTT OUT" (fuehrt auf RATE_ID)
LOG_LINK_ID = "7ddd3f5d8f76897e"      # link out "exit to INPUTlogs" (Hinweis + Debuglog)
FILTER_ID = "78cd6de319a6d061"        # "Filter" vor "Compare SP z1 and z2"
TICK_ID, GTICK_ID, GUARD_ID = "kpatch_sumtick", "kpatch_guard_tick", "kpatch_guard"
NEW_IDS = [TICK_ID, GTICK_ID, GUARD_ID]
DT_IDS = ["dtpatch_sumtick", "dtpatch_sumgate", "dtpatch_guard_tick", "dtpatch_guard"]      # Verzoegerungstest: darf nicht gleichzeitig drin sein

GUARD_JS = r"""// OPT-Kern: Ist/Soll-Abgleich der Verschiebung (K1) und Filter vorbereiten (K2). Vorbereitet in tools/kern_patch.py (Fork fl0wb0b/HeishaMoNR).
// Grund: die Befehlskette (Filter -> Compare SP -> Block? -> MQTT OUT -> Command Check) sendet nur bei Aenderungen und gleicht nie nach.
// Sendet NUR nach unten und nur den Wert, den HeishaMoNR will; nie bei MQTT-Sperre, veralteten Werten, fremdem Modus, aktiver Optimierer-Uebernahme.
var now = Date.now(), MIN = 60000;
function G(k) { return global.get(k, 'file'); }
function n0(v) { return v === undefined ? 0 : v; }
var hp = global.get('TOP27_Z1_Heat_Request_Temp'), sp42 = global.get('TOP42_Z1_Water_Target_Temp');
if (!context.get('primed') && typeof hp === 'number' && typeof sp42 === 'number') {          // K2: einmal je Start, sobald die Anlage Soll und Verschiebung gemeldet hat
    context.set('primed', true);
    node.send([null, null, {topic: 'OPT-Kern', payload: 'OPT-Platzhalter'}]);
}
var st = context.get('st') || {since: 0, last: 0, n: 0, alarm: false, info: ''};
function done(text, alarmText) {
    var out2 = null;
    if (alarmText && !st.alarm) { st.alarm = true; out2 = {topic: 'Kern-Abgleich', payload: alarmText}; }
    st.info = text;
    context.set('st', st);
    global.set('OPT_kern_guard', {ts: now, text: text, alarm: st.alarm, n: st.n});
    return out2;
}
function clear() { st.since = 0; st.n = 0; st.last = 0; st.alarm = false; }
if (global.get('OPT_kern_aus') === true) { clear(); return [null, done('Abgleich ausgeschaltet (OPT_kern_aus)')]; }
// Verschiebung, die HeishaMoNR will (wie die Summenfunktion im Heizkurvenmodus, Zone 1)
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
var HP = global.get('OPT_hp'), fresh = true;
if (HP && typeof HP === 'object') { fresh = Object.keys(HP).some(function (k) { return HP[k] && typeof HP[k].ts === 'number' && now - HP[k].ts <= 6 * MIN; }); }
var mqtt = G('MQTT.block_active') === 1;
var modeOk = G('TOP76_Heating_Mode') === 0 && G('TOP94_Zones_State') === 0 && G('TOP111_Z1_Sensor_Settings') === 0 && G('TOP0_Heatpump_State') === 1;
var ap = global.get('OPT_apply'), apAktiv = !!(ap && ap.aktiv && ap.aktiv.name === 'SetZ1HeatRequestTemperature' && ap.aktiv.value === hp);
if (typeof hp === 'number' && want !== null && hp <= want) { clear(); return [null, done('Anlage ' + hp + ' K, HeishaMoNR will ' + want + ' K: in Ordnung')]; }
if (!modeOk) { clear(); return [null, done('Wärmepumpe aus oder nicht Heizkurvenmodus/Zone 1/Wasserfühler: kein Abgleich')]; }
if (apAktiv) { clear(); return [null, done('Übernahme des Optimierers aktiv (' + hp + ' K): kein Abgleich')]; }
if (!st.since) { st.since = now; }
var mins = Math.round((now - st.since) / MIN);
var alarmTxt = mins >= 15 ? 'Kern-Abgleich: Verschiebung an der Anlage seit ' + mins + ' min höher als HeishaMoNR will' : '';
if (typeof hp !== 'number' || want === null) { return [null, done('Werte fehlen (Anlage ' + hp + ', Ziel ' + want + '), warte', alarmTxt)]; }
if (hp - want > 2) { return [null, done('Anlage ' + hp + ' K, HeishaMoNR will ' + want + ' K: Abweichung größer als 2 K, kein Abgleich', alarmTxt)]; }
if (!fresh) { return [null, done('HeishaMon meldet nicht, warte (Anlage ' + hp + ' K, Ziel ' + want + ' K)', alarmTxt)]; }
if (mqtt) { return [null, done('MQTT-Befehle gesperrt, warte (Anlage ' + hp + ' K, Ziel ' + want + ' K)', alarmTxt)]; }
var gap = st.n < 5 ? 3 * MIN : 30 * MIN;
if (now - st.since < 2 * MIN || now - st.last < gap || st.n >= 12) {
    return [null, done('Anlage ' + hp + ' K, Ziel ' + want + ' K: ' + (st.n >= 12 ? 'keine weiteren Befehle (12 gesendet)' : 'nächster Abgleichsbefehl folgt'), alarmTxt)];
}
st.last = now; st.n++;
var info = done('Abgleichsbefehl ' + st.n + ' gesendet (Anlage ' + hp + ' K, Ziel ' + want + ' K)', alarmTxt);
return [{topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature', payload: want, source: 'Kern-Abgleich'},
        info || {topic: 'Kern-Abgleich', payload: 'Abgleich: Anlage meldet ' + hp + ' K, HeishaMoNR will ' + want + ' K, Befehl ' + st.n}];
"""


def find(flows, nid):
    return next((n for n in flows if n.get("id") == nid), None)


def anchors(flows):
    """Prueft alle Anker; gibt Fehlertext oder '' zurueck."""
    s = find(flows, SUM_ID)
    if s is None or s.get("type") != "function" or "Calculate new SP" not in s.get("name", ""):
        return "Summenfunktion %s fehlt" % SUM_ID
    t = find(flows, TRIGGER_ID)
    if t is None or t.get("type") != "trigger" or t.get("wires") != [[SUM_ID]] or t.get("z") != s.get("z"):
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
    if any(find(flows, i) is not None for i in DT_IDS):
        return "Verzoegerungstest-Patch ist drin (erst zuruecknehmen: delaytest_patch.py --revert)"
    return ""


def nodes(flows):
    t, r = find(flows, TRIGGER_ID), find(flows, RATE_ID)
    return [
        {"id": TICK_ID, "type": "inject", "z": t["z"], "name": "OPT-Kern: Summenfunktion jede Minute", "props": [{"p": "payload"}], "repeat": "60", "crontab": "",
         "once": True, "onceDelay": "40", "topic": "", "payload": "OPT-Kern-Takt", "payloadType": "str", "x": t["x"] - 200, "y": t["y"] + 60, "wires": [[TRIGGER_ID]]},
        {"id": GTICK_ID, "type": "inject", "z": r["z"], "name": "OPT-Kern: Abgleich jede Minute", "props": [{"p": "payload"}], "repeat": "60", "crontab": "",
         "once": True, "onceDelay": "90", "topic": "", "payload": "", "payloadType": "date", "x": r["x"] - 420, "y": r["y"] + 180, "wires": [[GUARD_ID]]},
        {"id": GUARD_ID, "type": "function", "z": r["z"], "name": "OPT-Kern: Ist/Soll-Abgleich Verschiebung", "func": GUARD_JS, "outputs": 3, "timeout": 0, "noerr": 0,
         "initialize": "", "finalize": "", "libs": [], "x": r["x"] - 180, "y": r["y"] + 180, "wires": [[RATE_ID], [LOG_LINK_ID], [FILTER_ID]]},
    ]


def state(flows):
    return [find(flows, i) is not None for i in NEW_IDS]


def apply(flows):
    err = anchors(flows)
    if err:
        raise SystemExit(err + ": Patch bricht ab, nichts geaendert")
    changed = False
    for n in nodes(flows):
        old = find(flows, n["id"])
        if old is None:
            flows.append(n)
            changed = True
        elif old != n:
            flows[flows.index(old)] = n
            changed = True
    return changed


def revert(flows):
    n = len(flows)
    flows[:] = [x for x in flows if x.get("id") not in NEW_IDS]
    return len(flows) != n


def diff(a_path, b_path):
    a = {n["id"]: n for n in json.load(open(a_path, encoding="utf-8"))}
    b = {n["id"]: n for n in json.load(open(b_path, encoding="utf-8"))}
    ch = sorted(i for i in set(a) | set(b) if a.get(i) != b.get(i))
    bad = [i for i in ch if not i.startswith("opt_") and i not in NEW_IDS]
    print("geaendert/neu/entfernt:", len(ch), "| davon Kern:", [i for i in ch if i in NEW_IDS], "| unerlaubt:", bad)
    raise SystemExit(1 if bad else 0)


def main():
    args = sys.argv[1:]
    if "--ids" in args:
        print(" ".join(NEW_IDS))
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
            print("Kern-Paket ist vollstaendig drin")
            raise SystemExit(0)
        if any(parts):
            print("Kern-Paket ist nur TEILWEISE drin:", dict(zip(NEW_IDS, parts)))
            raise SystemExit(3)
        err = anchors(flows)
        print("Kern-Paket ist NICHT drin" + ("" if not err else " (" + err + ")"))
        raise SystemExit(2 if err else 1)
    changed = revert(flows) if "--revert" in flags else apply(flows)
    if changed:
        raw = open(path, encoding="utf-8").read()
        indent = 4 if raw.lstrip("[").startswith("\n") else None          # Formatierung der Datei beibehalten (kompakt oder eingerueckt)
        json.dump(flows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=indent)
        print("geaendert:", "Revert" if "--revert" in flags else "Patch", "(" + " ".join(NEW_IDS) + ")")
    else:
        print("nichts zu tun")


if __name__ == "__main__":
    main()

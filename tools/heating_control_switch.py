#!/usr/bin/env python3
"""Idempotent: adds a manual switch "Heizregelung" (Comfort / Efficiency) to the dashboard page "Uebersicht".

* Sends ONE command (panasonic_heat_pump/commands/SetHeatingControl, 0 = Comfort, 1 = Efficiency) only when the operator selects a value.
  Nothing is switched automatically.
* The command takes the common path of the flow ("> MQTT OUT" in WP Managers: rate limit, block check, MQTT source marking, command budget).
* Refuses to send when the real state is unknown, the MQTT block is active, the daily budget is used up, a command is still pending or the
  last change is less than 5 minutes ago. Warns (does not forbid) for Efficiency in unfavourable conditions.
* The selection always shows the state reported by HeishaMon (main/Heating_Control); a command is confirmed or reported as unconfirmed after 90 s.

Usage: python3 tools/heating_control_switch.py "<flows.json>"
"""
import json
import sys

TAB = "8c9d42231fd19d3c"            # WP Dash
LINK_IN = "8b3d729fe630c248"        # "> MQTT OUT" (WP Managers): common command path
UI_TAB = "a5be8588.b8fbc8"          # page "Uebersicht"
BROKER = "d82cfde48e832830"         # MQTT (lokal) 10.10.10.128
GROUP = "hc_grp"

CMD_JS = r"""// Heizregelung (Comfort / Efficiency) von Hand umschalten. KEIN automatischer Eingriff: nur auf Auswahl durch den Betreiber, ein einzelner Befehl,
// ueber den gemeinsamen Befehlsweg (Sperre, Befehlsbudget, Quellen-Markierung). Der Zustand wird zurueckgelesen und bestaetigt (Funktion "Heizregelung Zustand").
var now = Date.now(), NAMES = ['Comfort', 'Efficiency'];
var want = String(msg.payload) === '1' ? 1 : (String(msg.payload) === '0' ? 0 : null);
if (want === null) { return [null, null, null]; }
function toast(text, color) { return {topic: 'Heizregelung', payload: text, highlight: color || ''}; }
var cur = global.get('HEATING_CONTROL');
var back = (cur === 0 || cur === 1) ? {payload: String(cur)} : null;                 // Auswahl zurueck auf den wirklichen Stand
var pend = flow.get('hcPending');
if (cur === want && !pend) { return [null, null, null]; }                              // ist schon so eingestellt
if (cur !== 0 && cur !== 1) { return [null, toast('Heizregelung: Der aktuelle Stand der Wärmepumpe ist unbekannt (keine Meldung von HeishaMon). Nichts gesendet.', 'red'), null]; }
var MQTT = global.get('MQTT', 'file') || {};
if (MQTT.block_active === 1) { return [null, toast('Alle MQTT-Befehle sind gesperrt. Nichts gesendet.', 'red'), back]; }
if (MQTT.message_limit !== undefined && MQTT.messages_today >= MQTT.message_limit) { return [null, toast('Das Tagesbudget für MQTT-Befehle ist aufgebraucht (' + MQTT.messages_today + ' von ' + MQTT.message_limit + '). Nichts gesendet.', 'red'), back]; }
if (pend && now - pend.ts < 120000) { return [null, toast('Ein Befehl läuft noch (warte auf die Bestätigung der Wärmepumpe). Nichts gesendet.', 'orange'), back]; }
var MIN = 5 * 60000, last = flow.get('hcLast') || 0;
if (now - last < MIN) { return [null, toast('Zu schnell: frühestens in ' + Math.ceil((MIN - (now - last)) / 60000) + ' min wieder umschalten (schont die Anlage). Nichts gesendet.', 'orange'), back]; }
// Hinweise (kein Sperrgrund, die Entscheidung bleibt beim Betreiber)
var hints = [], at = Number(global.get('TOP14_Outside_Temp')), sol = Number(global.get('TOP42_Z1_Water_Target_Temp')), vl = Number(global.get('TOP6_Main_Outlet_Temp'));
var S = global.get('OPT_state') || {};
if (want === 1) {
    if (isFinite(at) && at < 5) { hints.push('Außentemperatur ' + at.toFixed(1).replace('.', ',') + ' °C: Efficiency ist bei Kälte und Abtauen eher ungünstig'); }
    if (global.get('TOP26_Defrosting_State') === 1) { hints.push('Abtauen läuft gerade'); }
    if (S.ts && now - S.ts < 5 * 60000 && S.deficit) { hints.push('Raum unter Minimum: ' + (S.deficitRoom || '?')); }
    if (Number(global.get('compressor_frequency')) > 0 && isFinite(sol) && isFinite(vl) && sol - vl > 2) { hints.push('Vorlauf liegt ' + (sol - vl).toFixed(1).replace('.', ',') + ' K unter Soll'); }
}
flow.set('hcPending', {want: want, ts: now, from: cur}); flow.set('hcLast', now);
var out = {topic: 'panasonic_heat_pump/commands/SetHeatingControl', payload: String(want), source: 'Heizregelung-Schalter'};
return [out, toast('Heizregelung → ' + NAMES[want] + ' gesendet' + (hints.length ? '. Hinweis: ' + hints.join('; ') : '') + '. Warte auf die Bestätigung …', hints.length ? 'orange' : ''), null];
"""

STATE_JS = r"""// Heizregelung: Zustand von HeishaMon (main/Heating_Control: 0 = Comfort, 1 = Efficiency) anzeigen, einen gesendeten Befehl bestaetigen oder melden,
// dass keine Bestaetigung kam (Ausloeser "tick" alle 15 s). Sendet selbst nie etwas an die Waermepumpe.
var now = Date.now(), NAMES = ['Comfort', 'Efficiency'];
var pend = flow.get('hcPending');
function hhmm(t) { return new Date(t).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}); }
function toast(text, color) { return {topic: 'Heizregelung', payload: text, highlight: color || ''}; }
var out = [null, null, null];                                                          // [Auswahl, Textzeile, Meldung]
if (msg.topic === 'tick') {
    if (pend && now - pend.ts > 90000) {
        flow.set('hcPending', null);
        var c0 = global.get('HEATING_CONTROL');
        out[2] = toast('Heizregelung: Keine Bestätigung der Wärmepumpe nach 90 s' + ((c0 === 0 || c0 === 1) ? ' (Stand weiter ' + NAMES[c0] + ')' : '') + '. Der Befehl wurde vielleicht nicht angenommen.', 'red');
        if (c0 === 0 || c0 === 1) { out[0] = {payload: String(c0)}; }
    }
    return out;
}
var v = Number(msg.payload);
if (!(v === 0 || v === 1)) { return out; }
var before = global.get('HEATING_CONTROL');
global.set('HEATING_CONTROL', v); global.set('HEATING_CONTROL_ts', now);
var waiting = pend && now - pend.ts < 90000;
if (!(waiting && pend.want !== v)) { out[0] = {payload: String(v)}; }                  // Auswahl zeigt den gemeldeten Stand (waehrend ein Befehl laeuft nicht zurueckspringen)
out[1] = {payload: NAMES[v] + ' · gemeldet ' + hhmm(now)};
if (pend && pend.want === v) { flow.set('hcPending', null); out[2] = toast('Heizregelung steht jetzt auf ' + NAMES[v] + ' (von der Wärmepumpe bestätigt).', 'green'); }
else if (!pend && before !== undefined && before !== v) { out[2] = toast('Heizregelung wurde von außen auf ' + NAMES[v] + ' geändert.', 'orange'); }
return out;
"""


def nodes():
    y0 = 4500
    return [
        {"id": GROUP, "type": "ui_group", "name": "HEIZREGELUNG", "tab": UI_TAB, "order": 2, "disp": True, "width": "6", "collapse": False, "className": ""},
        {"id": "hc_sel", "type": "ui_dropdown", "z": TAB, "name": "", "label": "Heizregelung", "tooltip": "Comfort oder Efficiency (von Hand, ein Befehl)", "place": "Auswählen",
         "group": GROUP, "order": 1, "width": 0, "height": 0, "passthru": False, "multiple": False,
         "options": [{"label": "Comfort", "value": "0", "type": "str"}, {"label": "Efficiency", "value": "1", "type": "str"}],
         "payload": "", "topic": "topic", "topicType": "msg", "className": "", "x": 190, "y": y0, "wires": [["hc_cmd"]]},
        {"id": "hc_cmd", "type": "function", "z": TAB, "name": "Heizregelung Befehl", "func": CMD_JS, "outputs": 3, "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [],
         "x": 430, "y": y0, "wires": [["hc_out"], ["hc_toast"], ["hc_sel"]]},
        {"id": "hc_out", "type": "link out", "z": TAB, "name": "Heizregelung → MQTT OUT", "mode": "link", "links": [LINK_IN], "x": 670, "y": y0 - 30, "wires": []},
        {"id": "hc_in", "type": "mqtt in", "z": TAB, "name": "Status Heizregelung", "topic": "panasonic_heat_pump/main/Heating_Control", "qos": "0", "datatype": "auto-detect",
         "broker": BROKER, "nl": False, "rap": True, "rh": 0, "inputs": 0, "x": 200, "y": y0 + 80, "wires": [["hc_state"]]},
        {"id": "hc_tick", "type": "inject", "z": TAB, "name": "alle 15 s", "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}], "repeat": "15", "crontab": "", "once": True, "onceDelay": "10",
         "topic": "tick", "payload": "", "payloadType": "date", "x": 190, "y": y0 + 130, "wires": [["hc_state"]]},
        {"id": "hc_state", "type": "function", "z": TAB, "name": "Heizregelung Zustand", "func": STATE_JS, "outputs": 3, "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [],
         "x": 430, "y": y0 + 100, "wires": [["hc_sel"], ["hc_txt"], ["hc_toast"]]},
        {"id": "hc_txt", "type": "ui_text", "z": TAB, "group": GROUP, "order": 2, "width": 0, "height": 0, "name": "", "label": "Stand", "format": "{{msg.payload}}", "layout": "row-spread",
         "className": "", "x": 670, "y": y0 + 90, "wires": []},
        {"id": "hc_toast", "type": "ui_toast", "z": TAB, "position": "top right", "displayTime": "10", "highlight": "", "sendall": True, "outputs": 0, "ok": "OK", "cancel": "", "raw": False,
         "className": "", "topic": "", "name": "Heizregelung", "x": 670, "y": y0 + 140, "wires": []},
    ]


def apply(flows):
    index = {n["id"]: i for i, n in enumerate(flows)}
    changed = False
    for n in nodes():
        if n["id"] in index:
            if flows[index[n["id"]]] != n:
                flows[index[n["id"]]] = n
                changed = True
        else:
            flows.append(n)
            changed = True
    link_in = next((n for n in flows if n["id"] == LINK_IN), None)
    if link_in is None:
        raise SystemExit("Link-In '> MQTT OUT' (%s) nicht gefunden, nichts geaendert" % LINK_IN)
    if "hc_out" not in link_in.get("links", []):
        link_in["links"] = list(link_in.get("links", [])) + ["hc_out"]
        changed = True
    return changed


if __name__ == "__main__":
    path = sys.argv[1]
    flows = json.load(open(path, encoding="utf-8"))
    if not any(n["id"] == TAB and n["type"] == "tab" for n in flows):
        raise SystemExit("Tab WP Dash (%s) nicht gefunden, nichts geaendert" % TAB)
    changed = apply(flows)
    if changed:
        json.dump(flows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    print("ok" if changed else "unveraendert")

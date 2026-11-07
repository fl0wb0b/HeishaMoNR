#!/usr/bin/env python3
"""Idempotent: adds a manual switch "Heizregelung" (Comfort / Efficiency) to the dashboard page "Uebersicht".

* Sends ONE command (panasonic_heat_pump/commands/SetHeatingControl, 0 = Comfort, 1 = Efficiency) only when the operator selects a value.
  Nothing is switched automatically.
* The command takes the common path of the flow ("> MQTT OUT" in WP Managers: rate limit, block check, MQTT source marking, command budget).
* Refuses to send when the real state is unknown, the MQTT block is active, the daily budget is used up, a command is still pending or the
  last change is less than 5 minutes ago. Warns (does not forbid) for Efficiency in unfavourable conditions.
* The selection always shows the state reported by HeishaMon (main/Heating_Control); a command is confirmed or reported as unconfirmed after 90 s.
* Shows the optimizer's recommendation (display only, global OPT_hc_reco) in the group and raises one notice when a new warning appears.
* Automatic by outdoor temperature (07.11.2026): a switch in the group; <= 2 °C once Comfort, >= 4 °C once Efficiency + Quiet 3, only on a change of the
  condition and after it held for 30 min; nothing is enforced afterwards (log entry per trigger).
* Schedule (07.11.2026): the page "Zeitplan" gets the actions "Heizregelung - Comfort/Efficiency". "Function schedule" (WP Scheduler) sends the
  request through a new 10th output to the same command function, so every rule above applies; the result goes to the log ("Input LOGS").
  The optimizer treats a scheduled change like one by hand (no switching back for 2 h). The actions for DHW, sterilization and cooling are
  removed from the selection (the plant has neither DHW nor cooling).

Usage: python3 tools/heating_control_switch.py "<flows.json>"
"""
import json
import sys

TAB = "8c9d42231fd19d3c"            # WP Dash
LINK_IN = "8b3d729fe630c248"        # "> MQTT OUT" (WP Managers): common command path
UI_TAB = "a5be8588.b8fbc8"          # page "Uebersicht"
BROKER = "d82cfde48e832830"         # MQTT (lokal) 10.10.10.128
GROUP = "hc_grp"
SCHED_TAB = "35d210f042827344"      # WP Scheduler
SCHED_FN = "e168945122de5aa2"       # "Function schedule" (WP Scheduler)
LOG_IN = "031e62b0bf3df7d7"         # "Input LOGS": Protokoll

CMD_JS = r"""// Heizregelung (Comfort / Efficiency) umschalten: von Hand (Auswahl auf der Uebersicht, ohne msg.source), aus dem Zeitplan (Aktion "Heizregelung - Comfort/Efficiency",
// msg.source 'Zeitplan', msg.topic = Zeile) oder von der Automatik nach Aussentemperatur (msg.source 'Außentemperatur'). Ein einzelner Befehl ueber den gemeinsamen
// Befehlsweg (Sperre, Befehlsbudget, Quellen-Markierung). Der Zustand wird zurueckgelesen und bestaetigt (Funktion "Heizregelung Zustand"). Mit Quelle steht das
// Ergebnis im Protokoll (Ausgang 4).
var now = Date.now(), NAMES = ['Comfort', 'Efficiency'];
var plan = !!msg.source, wer = plan ? String(msg.topic || msg.source) : '';
var want = String(msg.payload) === '1' ? 1 : (String(msg.payload) === '0' ? 0 : null);
if (want === null) { return [null, null, null, null]; }
function toast(text, color) { return {topic: 'Heizregelung', payload: (plan ? wer + ': ' : '') + text, highlight: color || ''}; }
function prot(text) { return plan ? {topic: wer, payload: 'Heizregelung ' + text} : null; }                 // Protokollzeile, nur aus dem Zeitplan
function nein(text, color, b) { return [null, toast(text, color), b, prot(NAMES[want] + ' – ' + text)]; }
var cur = global.get('HEATING_CONTROL');
var back = (cur === 0 || cur === 1) ? {payload: String(cur)} : null;                 // Auswahl zurueck auf den wirklichen Stand
var pend = flow.get('hcPending');
if (cur === want && !pend) { return [null, null, null, prot('steht schon auf ' + NAMES[want] + ', nichts gesendet')]; }
if (cur !== 0 && cur !== 1) { return nein('Heizregelung: Der aktuelle Stand der Wärmepumpe ist unbekannt (keine Meldung von HeishaMon). Nichts gesendet.', 'red', null); }
var MQTT = global.get('MQTT', 'file') || {};
if (MQTT.block_active === 1) { return nein('Alle MQTT-Befehle sind gesperrt. Nichts gesendet.', 'red', back); }
if (MQTT.message_limit !== undefined && MQTT.messages_today >= MQTT.message_limit) { return nein('Das Tagesbudget für MQTT-Befehle ist aufgebraucht (' + MQTT.messages_today + ' von ' + MQTT.message_limit + '). Nichts gesendet.', 'red', back); }
if (pend && now - pend.ts < 120000) { return nein('Ein Befehl läuft noch (warte auf die Bestätigung der Wärmepumpe). Nichts gesendet.', 'orange', back); }
var MIN = 5 * 60000, last = flow.get('hcLast') || 0;
if (now - last < MIN) { return nein('Zu schnell: frühestens in ' + Math.ceil((MIN - (now - last)) / 60000) + ' min wieder umschalten (schont die Anlage). Nichts gesendet.', 'orange', back); }
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
var out = {topic: 'panasonic_heat_pump/commands/SetHeatingControl', payload: String(want), source: plan ? String(msg.source) : 'Heizregelung-Schalter'};
var hinw = hints.length ? '. Hinweis: ' + hints.join('; ') : '';
return [out, toast('Heizregelung → ' + NAMES[want] + ' gesendet' + hinw + '. Warte auf die Bestätigung …', hints.length ? 'orange' : ''), null, prot(NAMES[want] + ' gesendet' + hinw)];
"""

# Zeitplan (07.11.2026): Aktion "Heizregelung - Comfort/Efficiency" in "Function schedule" (WP Scheduler). Der Block steht zwischen festen Markern und wird
# bei jedem Lauf ersetzt (idempotent). Er schickt die Anforderung ueber einen neuen 10. Ausgang an "Heizregelung Befehl" (oben); dort gelten alle Schutzregeln.
SCHED_BEGIN = "        // >>> Heizregelung aus dem Zeitplan (tools/heating_control_switch.py)\n"
SCHED_END = "        // <<< Heizregelung aus dem Zeitplan\n"
SCHED_JS = SCHED_BEGIN + r"""        // Comfort/Efficiency ueber den Schalter "Heizregelung Befehl" (WP Dash): Stand bekannt, MQTT-Sperre, Tagesbudget, 5 min Abstand, Bestaetigung;
        // das Ergebnis (gesendet oder warum nicht) schreibt der Schalter ins Protokoll
        if (action === "HC_0" || action === "HC_1")
        {
            var hcWant = action === "HC_0" ? 0 : 1;
            msg99.topic = 'Scheduler (#' + scheduleNumber + ')'; msg99.payload = 'Heizregelung ' + (hcWant === 0 ? 'Comfort' : 'Efficiency') + ' angefordert';
            global.set(topic + '_last_run', CurrentTime, "file");
            return [null, null, null, null, null, null, null, null, msg99, {payload: String(hcWant), source: 'Zeitplan', topic: 'Scheduler (#' + scheduleNumber + ')'}];
        }
""" + SCHED_END
SCHED_ANCHOR = '        if (action === "QM_0")'
# Anlage ohne Warmwasser und ohne Kuehlen: diese Aktionen fallen aus der Auswahl (die Zeitplan-Logik bleibt unveraendert)
ACTION_DROP = {"DHW", "Sterilization", "OperationMode1", "OperationMode2", "OperationMode3", "OperationMode4", "OperationMode5", "OperationMode6", "DHW setpoint"}
ACTION_HC = [{"label": "------------------------------", "value": "hc_sep", "type": "str"},
             {"label": "Heizregelung - Comfort", "value": "HC_0", "type": "str"},
             {"label": "Heizregelung - Efficiency", "value": "HC_1", "type": "str"}]


def is_sep(o):
    return set(o.get("label", "")) == {"-"}


def action_options(opts):
    """Auswahl ohne Warmwasser/Kuehlen, Heizregelung nach Leisemodus 3, keine zwei Trenner hintereinander und keiner am Ende."""
    keep = [o for o in opts if o.get("value") not in ACTION_DROP and o.get("value") not in {"hc_sep", "HC_0", "HC_1"}]
    pos = next((i for i, o in enumerate(keep) if o.get("value") == "QM_3"), None)
    if pos is None:
        raise SystemExit("Aktion-Auswahl ohne 'Leisemodus 3' (QM_3), nichts geaendert")
    pos += 1
    keep[pos:pos] = [dict(o) for o in ACTION_HC]
    out = []
    for o in keep:
        if is_sep(o) and (not out or is_sep(out[-1])):
            continue
        out.append(o)
    while out and is_sep(out[-1]):
        out.pop()
    return out

STATE_JS = r"""// Heizregelung: Zustand von HeishaMon (main/Heating_Control: 0 = Comfort, 1 = Efficiency) anzeigen, einen gesendeten Befehl bestaetigen oder melden,
// dass keine Bestaetigung kam (Ausloeser "tick" alle 15 s). Sendet selbst nie etwas an die Waermepumpe.
var now = Date.now(), NAMES = ['Comfort', 'Efficiency'];
var pend = flow.get('hcPending');
function hhmm(t) { return new Date(t).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}); }
function toast(text, color) { return {topic: 'Heizregelung', payload: text, highlight: color || ''}; }
var out = [null, null, null, null];                                                    // [Auswahl, Textzeile, Meldung, Empfehlung]
if (msg.topic === 'tick') {
    if (pend && now - pend.ts > 90000) {
        flow.set('hcPending', null);
        var c0 = global.get('HEATING_CONTROL');
        out[2] = toast('Heizregelung: Keine Bestätigung der Wärmepumpe nach 90 s' + ((c0 === 0 || c0 === 1) ? ' (Stand weiter ' + NAMES[c0] + ')' : '') + '. Der Befehl wurde vielleicht nicht angenommen.', 'red');
        if (c0 === 0 || c0 === 1) { out[0] = {payload: String(c0)}; }
    }
    // Empfehlung des Optimizers (nur Anzeige): bei Efficiency prueft er Aussentemperatur, Abtauen, Vorlauf und Raeume; eine neue Warnung gibt einmal eine Meldung
    var rc = global.get('OPT_hc_reco'), fresh = !!(rc && now - rc.ts < 5 * 60000), rtxt = fresh ? rc.text : '–';
    if (flow.get('hcRecoTxt') !== rtxt) { flow.set('hcRecoTxt', rtxt); out[3] = {payload: rtxt}; }
    var isWarn = fresh && rc.warn === true;
    if (isWarn && flow.get('hcRecoWarn') !== true && now - (flow.get('hcRecoToastTs') || 0) > 60 * 60000 && !out[2]) { out[2] = toast(rc.text + '. Es wird nichts automatisch umgeschaltet.', 'orange'); flow.set('hcRecoToastTs', now); }
    flow.set('hcRecoWarn', isWarn);
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


AT_JS = r"""// Heizregelung nach Aussentemperatur (07.11.2026, Kevin): faellt die Aussentemperatur (Fuehler der WP, ganze Grad) auf 2 °C oder tiefer, einmal Comfort;
// steigt sie auf 4 °C oder hoeher, einmal Efficiency und Quiet 3 (eigene Daten 09.10.-07.11.: ueber 3 °C Quiet 3 am besten, unter 3 °C aendert Quiet bei Comfort
// die Frequenz nicht). Bei 3 °C nichts (Hysterese). Geschaltet wird nur beim Wechsel der Lage und erst, wenn sie 30 min am Stueck ansteht; danach wird nichts
// erzwungen (Handschalter und Klick-Uebernahmen des Optimierers bleiben). Heizregelung ueber "Heizregelung Befehl" (alle Schutzregeln, Protokoll), Quiet 3 ueber den
// gemeinsamen Befehlsweg. Erledigt ist eine Lage erst, wenn HeishaMon den Modus meldet; lehnt "Heizregelung Befehl" ab (Abstand, laufender Befehl, Sperre),
// fordert die Automatik nach 10 min erneut an, hoechstens 3 Versuche (Kimi 07.11.). Waehrend des Abtauens zaehlt der Fuehlerwert nicht (kurze Spruenge).
// Ausgaenge: [Heizregelung Befehl, gemeinsamer Weg (Quiet), Protokoll, Schalter, Textzeile]
var now = Date.now(), MIN = 60000, HALTEN = 30, WIEDER = 10, VERSUCHE = 3, WER = 'Heizregelung nach Außentemperatur';
var A = global.get('HC_AT', 'file') || {on: false};
function hm(t) { return new Date(t).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}); }
function lage(z) { return z === 'kalt' ? 'kalt (≤ 2 °C)' : 'warm (≥ 4 °C)'; }
function txt() {
    if (!A.on) { return 'aus'; }
    if (!A.cand) { return 'an · wartet auf ≤ 2 °C oder ≥ 4 °C'; }
    var v = A.versuch && A.versuch.lage === A.cand ? A.versuch : null;
    return 'an · ' + lage(A.cand) + ' seit ' + hm(A.seit) + (A.erledigt === A.cand ? (A.abbruch ? ' · keine Bestätigung nach ' + VERSUCHE + ' Versuchen' : ' · geschaltet ' + hm(A.erledigtTs))
        : (v ? ' · angefordert ' + hm(v.ts) + (v.n > 1 ? ' (Versuch ' + v.n + ')' : '') : ' · schaltet ab ' + hm(A.seit + HALTEN * MIN)));
}
function anfordern(kalt, at) {                                                       // Heizregelung an den Schalter-Befehl, bei warm dazu Quiet 3; liefert die Protokollzeile
    out[0] = {payload: kalt ? '0' : '1', source: 'Außentemperatur', topic: WER};
    var zeile = (kalt ? 'Comfort' : 'Efficiency') + ' angefordert';
    if (!kalt) {
        var q = Number(global.get('TOP18_Quiet_Mode_Level')), MQ = global.get('MQTT', 'file') || {};
        if (q === 3) { zeile += '; Quiet steht schon auf 3, nichts gesendet'; }
        else if (MQ.block_active === 1) { zeile += '; Quiet 3 nicht gesendet: alle MQTT-Befehle sind gesperrt'; }
        else if (MQ.message_limit !== undefined && MQ.messages_today >= MQ.message_limit) { zeile += '; Quiet 3 nicht gesendet: Tagesbudget für MQTT-Befehle aufgebraucht'; }
        else { out[1] = {topic: 'panasonic_heat_pump/commands/SetQuietMode', payload: '3', source: 'Außentemperatur'}; zeile += '; Quiet 3 gesendet'; }
    }
    return zeile;
}
var out = [null, null, null, null, null];
if (msg.topic === 'schalter') {
    var on = msg.payload === true || msg.payload === 'true' || msg.payload === 1;
    if (on !== !!A.on) {
        A = {on: on, cand: null, seit: now, erledigt: null, versuch: null};
        out[2] = {topic: WER, payload: 'Automatik ' + (on ? 'eingeschaltet' : 'ausgeschaltet')};
    }
} else {
    if (context.get('neu') !== false) { context.set('neu', false); out[3] = {payload: !!A.on}; }   // nach Neustart/Einspielen: Schalter zeigt den gemerkten Stand
    var raw = global.get('TOP14_Outside_Temp'), at = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    var z = (A.on && isFinite(at) && global.get('TOP26_Defrosting_State') !== 1) ? (at <= 2 ? 'kalt' : (at >= 4 ? 'warm' : null)) : null;
    if (A.versuch && global.get('HEATING_CONTROL') === (A.versuch.lage === 'kalt' ? 0 : 1)) { A.erledigt = A.versuch.lage; A.erledigtTs = now; A.versuch = null; A.abbruch = false; }   // von HeishaMon gemeldet: Lage erledigt (auch wenn die Temperatur inzwischen wieder wechselt)
    if (z && z !== A.cand) { A.cand = z; A.seit = now; }
    if (A.on && A.cand && A.cand !== A.erledigt && now - A.seit >= HALTEN * MIN) {
        var kalt = A.cand === 'kalt', v = A.versuch && A.versuch.lage === A.cand ? A.versuch : null;
        if (!v) { A.versuch = {lage: A.cand, ts: now, n: 1}; out[2] = {topic: WER, payload: 'Außen ' + at + ' °C seit ' + HALTEN + ' min: ' + anfordern(kalt, at)}; }
        else if (now - v.ts >= WIEDER * MIN) {
            if (v.n >= VERSUCHE) { A.erledigt = A.cand; A.erledigtTs = now; A.versuch = null; A.abbruch = true; out[2] = {topic: WER, payload: (kalt ? 'Comfort' : 'Efficiency') + ' nach ' + VERSUCHE + ' Versuchen nicht gemeldet, Automatik wartet auf den nächsten Wechsel'}; }
            else { v.n++; v.ts = now; out[2] = {topic: WER, payload: 'Versuch ' + v.n + ': ' + anfordern(kalt, at)}; }
        }
    }
}
global.set('HC_AT', A, 'file');
var t = txt();
if (context.get('txt') !== t) { context.set('txt', t); out[4] = {payload: t}; }
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
        {"id": "hc_cmd", "type": "function", "z": TAB, "name": "Heizregelung Befehl", "func": CMD_JS, "outputs": 4, "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [],
         "x": 430, "y": y0, "wires": [["hc_out"], ["hc_toast"], ["hc_sel"], ["hc_log"]]},
        {"id": "hc_sched_in", "type": "link in", "z": TAB, "name": "Heizregelung aus dem Zeitplan", "links": ["hc_sched_out"], "x": 190, "y": y0 + 40, "wires": [["hc_cmd"]]},
        {"id": "hc_log", "type": "link out", "z": TAB, "name": "Heizregelung (Zeitplan, Automatik) → Protokoll", "mode": "link", "links": [LOG_IN], "x": 670, "y": y0 + 165, "wires": []},
        {"id": "hc_at_tick", "type": "inject", "z": TAB, "name": "jede Minute", "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}], "repeat": "60", "crontab": "", "once": True,
         "onceDelay": "20", "topic": "tick", "payload": "", "payloadType": "date", "x": 190, "y": y0 + 220, "wires": [["hc_at"]]},
        {"id": "hc_at", "type": "function", "z": TAB, "name": "Heizregelung nach Außentemperatur", "func": AT_JS, "outputs": 5, "timeout": 0, "noerr": 0,
         "initialize": "context.set('neu', true);  // erster Takt stellt den Schalter auf den gemerkten Stand\n", "finalize": "", "libs": [],
         "x": 430, "y": y0 + 240, "wires": [["hc_cmd"], ["hc_out"], ["hc_log"], ["hc_at_sw"], ["hc_at_txt"]]},
        {"id": "hc_at_sw", "type": "ui_switch", "z": TAB, "name": "", "label": "Automatisch nach Außentemperatur",
         "tooltip": "≤ 2 °C: Comfort · ≥ 4 °C: Efficiency + Quiet 3 · schaltet nur beim Wechsel, wenn die Lage 30 min ansteht", "group": GROUP, "order": 4,
         "width": 0, "height": 0, "passthru": False, "decouple": "false", "topic": "schalter", "topicType": "str", "style": "", "onvalue": "true", "onvalueType": "bool",
         "onicon": "", "oncolor": "", "offvalue": "false", "offvalueType": "bool", "officon": "", "offcolor": "", "animate": False, "className": "",
         "x": 190, "y": y0 + 260, "wires": [["hc_at"]]},
        {"id": "hc_at_txt", "type": "ui_text", "z": TAB, "group": GROUP, "order": 5, "width": 0, "height": 0, "name": "", "label": "Automatik", "format": "{{msg.payload}}",
         "layout": "col-center", "className": "", "x": 670, "y": y0 + 260, "wires": []},
        {"id": "hc_out", "type": "link out", "z": TAB, "name": "Heizregelung → MQTT OUT", "mode": "link", "links": [LINK_IN], "x": 670, "y": y0 - 30, "wires": []},
        {"id": "hc_in", "type": "mqtt in", "z": TAB, "name": "Status Heizregelung", "topic": "panasonic_heat_pump/main/Heating_Control", "qos": "0", "datatype": "auto-detect",
         "broker": BROKER, "nl": False, "rap": True, "rh": 0, "inputs": 0, "x": 200, "y": y0 + 80, "wires": [["hc_state"]]},
        {"id": "hc_tick", "type": "inject", "z": TAB, "name": "alle 15 s", "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}], "repeat": "15", "crontab": "", "once": True, "onceDelay": "10",
         "topic": "tick", "payload": "", "payloadType": "date", "x": 190, "y": y0 + 130, "wires": [["hc_state"]]},
        {"id": "hc_state", "type": "function", "z": TAB, "name": "Heizregelung Zustand", "func": STATE_JS, "outputs": 4, "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [],
         "x": 430, "y": y0 + 100, "wires": [["hc_sel"], ["hc_txt"], ["hc_toast"], ["hc_reco_txt"]]},
        {"id": "hc_txt", "type": "ui_text", "z": TAB, "group": GROUP, "order": 2, "width": 0, "height": 0, "name": "", "label": "Stand", "format": "{{msg.payload}}", "layout": "row-spread",
         "className": "", "x": 670, "y": y0 + 90, "wires": []},
        {"id": "hc_reco_txt", "type": "ui_text", "z": TAB, "group": GROUP, "order": 3, "width": 0, "height": 0, "name": "", "label": "Empfehlung", "format": "{{msg.payload}}", "layout": "col-center",
         "className": "", "x": 670, "y": y0 + 115, "wires": []},
        {"id": "hc_toast", "type": "ui_toast", "z": TAB, "position": "top right", "displayTime": "10", "highlight": "", "sendall": True, "outputs": 0, "ok": "OK", "cancel": "", "raw": False,
         "className": "", "topic": "", "name": "Heizregelung", "x": 670, "y": y0 + 140, "wires": []},
    ]


def patch_schedule(fn):
    """Block "Heizregelung" in "Function schedule" (ersetzt einen vorhandenen), 10. Ausgang auf hc_sched_out. Gibt den neuen Knoten zurueck."""
    func = fn["func"]
    a, b = func.find(SCHED_BEGIN), func.find(SCHED_END)
    if (a >= 0) != (b > a):
        raise SystemExit("'Function schedule': Heizregelung-Block nur halb vorhanden (Marker von Hand geaendert?), nichts geaendert")
    if a >= 0:
        func = func[:a] + func[b + len(SCHED_END):]
    if func.count(SCHED_ANCHOR) != 1:
        raise SystemExit("'Function schedule': Ansatzpunkt %r nicht genau einmal gefunden, nichts geaendert" % SCHED_ANCHOR)
    func = func.replace(SCHED_ANCHOR, SCHED_JS + SCHED_ANCHOR)
    wires = [list(w) for w in fn["wires"][:9]]
    if len(wires) != 9:
        raise SystemExit("'Function schedule' hat %d statt 9 Ausgaenge, nichts geaendert" % len(fn["wires"]))
    labels = list(fn.get("outputLabels") or [""] * 9)[:9] + ["Heizregelung (WP Dash)"]
    return dict(fn, func=func, outputs=10, wires=wires + [["hc_sched_out"]], outputLabels=labels)


def apply(flows):
    by = {n["id"]: n for n in flows}
    for need, what in ((LINK_IN, "Link-In '> MQTT OUT'"), (LOG_IN, "Link-In 'Input LOGS'"), (SCHED_FN, "'Function schedule'")):
        if need not in by:
            raise SystemExit("%s (%s) nicht gefunden, nichts geaendert" % (what, need))
    fn = by[SCHED_FN]
    new = nodes() + [patch_schedule(fn),
                     {"id": "hc_sched_out", "type": "link out", "z": SCHED_TAB, "name": "Heizregelung → WP Dash", "mode": "link", "links": ["hc_sched_in"],
                      "x": fn["x"] + 290, "y": fn["y"] + 140, "wires": []}]
    acts = [n for n in flows if n["type"] == "ui_dropdown" and n.get("z") == SCHED_TAB and str(n.get("name", "")).startswith("Action") and str(n.get("name"))[6:].isdigit()]
    if len(acts) != 10:
        raise SystemExit("%d statt 10 Aktion-Auswahlen im Zeitplan gefunden, nichts geaendert" % len(acts))
    new += [dict(n, options=action_options(n["options"])) for n in acts]
    index = {n["id"]: i for i, n in enumerate(flows)}
    changed = False
    for n in new:
        if n["id"] in index:
            if flows[index[n["id"]]] != n:
                flows[index[n["id"]]] = n
                changed = True
        else:
            flows.append(n)
            changed = True
    for lid, sender in ((LINK_IN, "hc_out"), (LOG_IN, "hc_log")):
        link_in = flows[index[lid]]
        if sender not in link_in.get("links", []):
            link_in["links"] = list(link_in.get("links", [])) + [sender]
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

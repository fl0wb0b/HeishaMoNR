#!/usr/bin/env python3
"""Phase 1 of the Lambda-style optimisation layer: sensors, smoothing, trends, logging, dashboard. NO control action.

Adds an editor tab "WP Optimizer" and a dashboard page "Optimierung". Everything is observational:
  * room temperatures (MQTT, Venus broker): freshness, plausibility, outlier rejection, EMA, trend in K/h
  * one comfort band per room: the deviation from the room's OWN band (below min / inside / above max) decides which
    room limits the optimisation; per room switchable, weight and data-age limit, set in the dashboard
  * OpenWeatherMap (optional, needs API key + location): current, +1 h/+3 h/+6 h forecast, humidity, dew point
  * Panasonic values read from the existing global variables
  * CSV logging (/data/optimizer/…) for the later shadow-mode evaluation

The script is idempotent: re-running it replaces the nodes it owns (ids start with "opt_") and keeps the values the
user typed into the tab environment variables.

Usage: python3 tools/optimizer_phase1.py "flows (26.5.1 stable).json"
"""
import json
import os
import sys

_args = [a for a in sys.argv[1:] if not a.startswith("--")]
path = _args[0] if _args else "flows (26.5.1 stable).json"
# Ein-Klick-Uebernahme: der mqtt-out-Knoten wird GESPERRT (deaktiviert) ausgeliefert. Erst mit diesem Schalter UND apply.json (enabled + Regel) kann ein Klick senden.
APPLY_NODE_ACTIVE = "--uebernahme-knoten-aktiv" in sys.argv[1:]
flows = json.load(open(path, encoding="utf-8"))
B = {n["id"]: n for n in flows}

TAB = "opt_tab"
UI_TAB = "opt_ui_tab"
BROKER = "opt_broker_venus"


def upsert(node):
    """Replace an owned node (keeps position order in the file)."""
    i = node["id"]
    if i in B:
        flows[flows.index(B[i])] = node
    else:
        flows.append(node)
    B[i] = node


# ---------------------------------------------------------------- tab with environment variables (secrets stay out of the file)
old_env = (B.get(TAB) or {}).get("env")
env = old_env if old_env else [
    {"name": "OWM_API_KEY", "value": "", "type": "cred"},
    {"name": "OWM_LAT", "value": "", "type": "str"},
    {"name": "OWM_LON", "value": "", "type": "str"},
]
upsert({"id": TAB, "type": "tab", "label": "WP Optimizer", "disabled": False,
        "info": "Phase 1 der Lambda-artigen Optimierung: Sensorik, Glättung, Trends, Protokoll und Anzeige.\n"
                "KEIN Eingriff in die Regelung.\n\n"
                "OpenWeatherMap: API-Schlüssel und Standort werden im Dashboard unter SYSTEM > EINSTELLUNGEN "
                "eingetragen und in /data/optimizer/owm.json (Modus 0600) gespeichert.\n"
                "Ersatzweise können die Tab-Umgebungsvariablen OWM_API_KEY (Typ: Zugangsdaten), OWM_LAT und "
                "OWM_LON (Reiter 'Umgebungsvariablen' im Tab-Dialog) benutzt werden.\n"
                "Ohne Schlüssel läuft alles, nur die Wetterdaten bleiben leer.",
        "env": env})

# ---------------------------------------------------------------- broker (own client id so it never kicks other clients)
upsert({"id": BROKER, "type": "mqtt-broker", "name": "MQTT (Venus) Optimizer", "broker": "192.168.5.11", "port": "1883",
        "clientid": "nodered-optimizer", "autoConnect": True, "usetls": False, "protocolVersion": "4",
        "keepalive": "60", "cleansession": True, "autoUnsubscribe": True,
        "birthTopic": "", "birthQos": "0", "birthRetain": "false", "birthPayload": "", "birthMsg": {},
        "closeTopic": "", "closeQos": "0", "closeRetain": "false", "closePayload": "", "closeMsg": {},
        "willTopic": "", "willQos": "0", "willRetain": "false", "willPayload": "", "willMsg": {},
        "userProps": "", "sessionExpiry": ""})


UI_CHART_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui_chart.js"), encoding="utf-8").read()      # SVG-Diagramme der Oberflaeche (reine Funktionen, in der Sim getestet)
WX_CORE_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "wx_core.js"), encoding="utf-8").read()        # Wetterkarte (wetter-grafik 17.10.2026): Daten + COP-Ziel-Verlauf, reine Funktionen (tools/wx_core_test.js)
FS = [{"var": "fs", "module": "fs"}]       # core module, allowed on this instance (functionExternalModules: true)


def fn(i, name, code, outputs=1, wires=None, x=0, y=0, libs=None):
    return {"id": i, "type": "function", "z": TAB, "name": name, "func": code, "outputs": outputs, "timeout": 0,
            "noerr": 0, "initialize": "", "finalize": "", "libs": libs or [], "x": x, "y": y,
            "wires": wires if wires is not None else [[] for _ in range(outputs)]}


def inject(i, name, repeat, once_delay, wires, x, y):
    return {"id": i, "type": "inject", "z": TAB, "name": name, "props": [{"p": "payload"}],
            "repeat": str(repeat) if repeat else "", "crontab": "", "once": True, "onceDelay": str(once_delay),
            "topic": "", "payload": "", "payloadType": "date", "x": x, "y": y, "wires": [wires]}


def comment(i, text, x, y):
    return {"id": i, "type": "comment", "z": TAB, "name": text, "info": "", "x": x, "y": y, "wires": []}


# ---------------------------------------------------------------- rooms and comfort bands
# One comfort band per room. The deviation from the room's OWN band decides which room limits the optimisation, never the
# absolute temperature. Single source for the defaults function, the input validation and the dashboard inputs.
ROOMS = [
    # eigeneHeizung (Entscheidung 5 vom 15.10.2026): Raum mit eigener Nachheizung (Kinderzimmer oben: Radiator-Relais und Heizluefter, Tab "Dashboard") -> kein +1-K-/Comfort-/
    # Quiet-Bedarf fuer das ganze Haus; zaehlt weiter fuer Absenkungen (keine -1 K, solange er unter Minimum liegt) und fuer den Hinweis Waermeverteilung. config.json kann es je Raum setzen.
    # sonnenfenster (Paket 2 vom 15.10.2026): Raum mit Sonnenfenster (Wohnzimmer, Suedwest; nachmittags warm durch Sonne) -> kein Ueberschuss-Ausloeser fuer -1 K, solange Sonne
    # anliegt und er bei stehender WP bzw. fallendem Vorlauf steigt (Raumeinfluss v5, Deckel/Laufzeit v6); fuer Bedarf, Reserve und Waermeverteilung zaehlt er immer.
    {"id": "ki_oben", "name": "Kinderzimmer oben", "topic": "shellyhtg3-lucas/status/temperature:0",
     "active": True, "min": 22.5, "max": 23.5, "weight": 1, "maxAgeMin": 90, "eigeneHeizung": True, "sonnenfenster": False},
    {"id": "ki_unten", "name": "Kinderzimmer unten", "topic": "shellyhtg3-lina/status/temperature:0",
     "active": True, "min": 22.5, "max": 23.5, "weight": 1, "maxAgeMin": 90, "eigeneHeizung": False, "sonnenfenster": False},
    {"id": "schlaf", "name": "Schlafzimmer", "topic": "shellies/shellyht-Schlaf/sensor/temperature",
     "active": True, "min": 19, "max": 21, "weight": 1, "maxAgeMin": 90, "eigeneHeizung": False, "sonnenfenster": False},
    # new sensor (Shelly H&T Gen1, SHHT-1): measured and logged from the start, but inactive (no say in the room logic) until the user sets its band
    {"id": "wohn", "name": "Wohnzimmer", "topic": "shellies/shelly-ht-wohnzimmer/sensor/temperature",
     "active": False, "min": 20, "max": 22.5, "weight": 1, "maxAgeMin": 90, "eigeneHeizung": False, "sonnenfenster": True},
]
# Standard "eigene Nachheizung" je Raum-ID: Rueckfall fuer Leser, solange OPT_cfg im Speicher das Feld noch nicht hat (Deploy ohne erneutes opt_i_init)
EIGEN_STD_JS = json.dumps({r["id"]: r["eigeneHeizung"] for r in ROOMS})
SONNE_STD_JS = json.dumps({r["id"]: r["sonnenfenster"] for r in ROOMS})
EIGEN_JS = ("var EIGEN_STD = " + EIGEN_STD_JS + ";   // Raum mit eigener Nachheizung: Standard je Raum-ID (Generator), OPT_cfg.rooms[].eigeneHeizung hat Vorrang\n"
            "function eigenOf(rc) { return (rc && typeof rc.eigeneHeizung === 'boolean') ? rc.eigeneHeizung : !!(rc && EIGEN_STD[rc.id]); }\n"
            "var SONNE_STD = " + SONNE_STD_JS + ";   // Raum mit Sonnenfenster (Paket 2): Standard je Raum-ID, OPT_cfg.rooms[].sonnenfenster hat Vorrang\n"
            "function sonneOf(rc) { return (rc && typeof rc.sonnenfenster === 'boolean') ? rc.sonnenfenster : !!(rc && SONNE_STD[rc.id]); }")
# numeric settings per room: (field, lowest, highest, step, tooltip); "active" is a checkbox
ROOM_FIELDS = [
    ("min", 10, 30, 0.5, "Darunter braucht der Raum Wärme."),
    ("max", 12, 35, 0.5, "Darüber ist der Raum zu warm."),
    ("weight", 0.1, 5, 0.1,
     "Faktor für die Abweichung vom Band. Ein höherer Wert macht den Raum bei der Wahl des maßgeblichen Raums wichtiger."),
    ("maxAgeMin", 5, 720, 5, "Ältere Sensorwerte zählen für die Optimierung nicht mehr."),
]
LIMITS = {f: [lo, hi] for f, lo, hi, _step, _tip in ROOM_FIELDS}
MIN_BAND_K = 0.5
# Room logic for the correction of the heating curve (-1/0/+1 K). Shadow only for now: a proposal is computed, shown and
# logged (korrektur_vorschlag); nothing is applied (enabled stays false, and the sum function is not patched).
CONTROL = {"enabled": False, "probe": True, "minVlC": 29, "startK": 0.3, "releaseK": 0.3, "holdMin": 45, "riseDwellMin": 60, "lowerDwellMin": 30,
           "probeStableMin": 120, "probeMarginK": 0.4, "guardK": 0.15, "probeBackoffMin": 360,
           "startLockMin": 15, "afterDefrostMin": 10, "afterDhwMin": 10}


# Quiet-Waechter (shadow only, measurement and display): since the review package (13.10.2026) without its own Quiet recommendation, control test
# and escalation actions (the decision engine is the single source); only the smoothing of the return error, the run/start limits of the
# cycle display and the lock times after start/defrost/DHW remain. Nothing is written to the heat pump.
QUIET = {"errTauMin": 5, "startLockMin": 15, "afterDefrostMin": 10, "afterDhwMin": 10, "minRunMin": 20, "maxStartsDay": 24}


# Heat plan = demand/COP preview (shadow only; since the review package 13.10.2026 without tariff distribution and recommendations): every number here is a
# conservative DEFAULT, not a measured value; measured data moves them only slowly. COP per outdoor band from the measured map (at least copMinMin minutes).
# Gebaeudemodell v3 (Entscheidung 2 vom 15.10.2026, docs/ALGORITHMUS.md Schicht 1): Bedarf = UA * (T_innen - T_aussen) - Gewinne, UA, Gewinne und T_innen aus den
# Vortagen gelernt (Vorwert als 2 Pseudo-Tage bei 10 und 16 K, ab 2 Lerntagen gelernt), Grenzen UA 0,07-0,35 kW/K, Gewinne 0-1,2 kW, T_innen 18-25 °C; langsame Anpassung je Tag
# (UA hoechstens 15 %, Gewinne 0,15 kW, T_innen 0,5 K). hddRefC: nur noch Lern-Filter (Heizgradstunden unter 15 °C, Aus-Schwelle der Heizgrenze 12; Tage mit < learnMinHdd lernen nicht mit).
PLAN = {"hddRefC": 15, "uaKwPerK": 0.15, "gainKw": 0.3, "priorDays": 2, "lernMinTage": 2, "uaMin": 0.07, "uaMax": 0.35, "gainMax": 1.2,
        "tiDefaultC": 22, "tiDays": 3, "tiMin": 18, "tiMax": 25, "stepUaRel": 0.15, "stepGainKw": 0.15, "stepTiK": 0.5, "biasDays": 3, "learnDays": 21, "learnMinHdd": 30,
        "etaPrior": 0.45, "etaPriorMin": 600, "evapApproachK": 6, "condApproachK": 2, "copMinMin": 60, "copMax": 8,
        "minDemandKwh": 4, "windowH": 3, "anchorTauH": 4, "snapKeepH": 27,
        "confPrior": {"at": {"1": 0.95, "3": 0.9, "6": 0.8, "12": 0.65, "24": 0.5}, "pv": {"1": 0.85, "3": 0.75, "6": 0.6, "12": 0.45, "24": 0.35}},
        "confN0": {"at": 168, "pv": 100}, "confSigma": {"atK": 2.5, "pvRel": 0.6}, "confMin": 0.2, "confMax": 0.98}


# COP correction (14.10.2026, forum 189605 question 10 / TODO F10-a): the Leisha's internal power value TOP16 under-reports while the compressor runs
# (pump, fan, electronics missing): L5 70-90 W below a Shelly (post 4545989), 390 W Shelly at 16/17 Hz where ours shows 341-363 W (4597230), L7 -14.6 %
# energy vs Shelly with only -2.7 % on the heat side (4145844). ASSUMPTION 80 W (range 40-90 W), added ONLY while the compressor runs (standstill 15-34 W
# stays raw). Stored values stay raw; every COP/power the optimizer computes or shows adds the correction when reading. Single source: OPT_cfg.cop.pelKorrW
# (config.json may override, 0..200 W; the engine gets the same value through mergeCfg).
COP = {"pelKorrW": 80}
# Stromzaehler Shelly 3EM-63 Gen3 (cop-ziel 17.10.2026): Standard der Konfiguration OPT_cfg.zaehler (config.json "zaehler", Eingabe auf Daten & Guete). quelle 'heishamon' =
# alles wie bisher; 'zaehler' nur nach Go des Nutzers (zwei Tage Vergleich). Klemmen 0-2 = Phase a/b/c (em:0) bzw. Kanal em1:0-2; null = keine.
ZAEHLER_STD = {"quelle": "heishamon", "broker": "venus", "topic": "", "profil": "auto", "klemme_wp": 0, "klemme_heizstab": None, "klemme_sonstiges": None, "invertieren": [False, False, False]}
ZAEHLER_MAX_ALTER_MIN = 5
# JS snippet: the correction in W from OPT_cfg (falls back to the default above), used by opt_quiet, opt_plan, opt_eval, opt_hist
COP_KW_JS = ("var COP_KW = (function () { var v = Number(((typeof cfg !== 'undefined' && cfg && cfg.cop) || {}).pelKorrW); "
             "return (isFinite(v) && v >= 0 && v <= 200) ? v : " + str(COP["pelKorrW"]) + "; })();   // COP-Korrektur: + W je Laufminute (TOP16 untertreibt, Forum 189605)\n"
             "function pelK(p, lauf) { return (p !== null && p !== undefined && isFinite(p) && lauf) ? p + COP_KW : p; }\n"
             "var KORR_TXT = 'intern +' + COP_KW + ' W korrigiert';\n"
             # Stromzaehler (cop-ziel 17.10.2026): OPT_cfg.zaehler.quelle = 'zaehler' und OPT_zaehler hoechstens 5 min alt -> Zaehlerstrom (ohne Heizstab) statt TOP16 + Korrektur;
             # sonst (Standard 'heishamon', Ausfall) pelQ = pelK. Nur Anzeige und Zaehlerspalten; gespeicherte Rohwerte bleiben.
             "var ZQ = (function () { var z = global.get('OPT_zaehler'), q = (((typeof cfg !== 'undefined' && cfg && cfg.zaehler) || {}).quelle === 'zaehler'), "
             "fr = !!(z && typeof z.ts === 'number' && Date.now() - z.ts <= " + str(ZAEHLER_MAX_ALTER_MIN) + " * 60000 && typeof z.wp_w === 'number' && isFinite(z.wp_w)); "
             "return {gewaehlt: q, frisch: fr, aktiv: q && fr, w: fr ? z.wp_w : null, hs: fr && typeof z.heizstab_w === 'number' ? z.heizstab_w : null, alter: z && typeof z.ts === 'number' ? (Date.now() - z.ts) / 60000 : null}; })();   // Stromzaehler (cop-ziel)\n"
             "function pelQ(p, lauf) { return ZQ.aktiv ? ZQ.w : pelK(p, lauf); }\n"
             "var ZQ_TXT = ZQ.aktiv ? 'Zähler (Shelly)' : (ZQ.gewaehlt ? 'Zähler gewählt, Rückfall auf ' + KORR_TXT + (ZQ.alter !== null ? ' (Zähler ' + Math.round(ZQ.alter) + ' min alt)' : ' (kein Zähler)') : KORR_TXT);")


def js(code):
    """Fill the shared constants into a JS block."""
    return (code.replace("__ROOMS__", json.dumps(ROOMS, ensure_ascii=False))
                .replace("__LIMITS__", json.dumps(LIMITS))
                .replace("__MINBAND__", str(MIN_BAND_K))
                .replace("__CTL__", json.dumps(CONTROL))
                .replace("__QUIET__", json.dumps(QUIET, ensure_ascii=False))
                .replace("__PLAN__", json.dumps(PLAN, ensure_ascii=False))
                .replace("__COP__", json.dumps(COP))
                .replace("__ZAEHLER__", json.dumps(ZAEHLER_STD))
                .replace("__COPKW__", COP_KW_JS)
                .replace("__EIGEN__", EIGEN_JS))


# ---------------------------------------------------------------- defaults / configuration
DEFAULTS_JS = r"""
// Standardwerte der Optimierungsebene. Gespeicherte Einstellungen (config.json) und bereits gesetzte Werte bleiben erhalten.
// Jeder Raum hat ein eigenes Komfortband (min/max), eine Gewichtung und ein Datenalter-Limit.
var ROOM_FIELDS = ['active', 'min', 'max', 'weight', 'maxAgeMin', 'eigeneHeizung', 'sonnenfenster'];
var d = {
    rooms: __ROOMS__,
    control: __CTL__,
    quiet: __QUIET__,
    plan: __PLAN__,
    cop: __COP__,                                    // COP-Korrektur: W, die TOP16 im Lauf fehlen (Forum 189605, Annahme 80 W)
    zaehler: __ZAEHLER__,                            // Stromzaehler Shelly 3EM-63 Gen3 (cop-ziel 17.10.2026): Topic, Broker, Klemmen, Quelle (Standard heishamon)
    energy: {vrmMaxAgeH: 4, evccMaxAgeH: 6, batteryInstance: 278,
             tariff: {buy: [['00:00', '05:00', 0.21], ['05:00', '24:00', 0.31]], sell: 0.06, source: 'VRM Dynamic ESS (fester HT/NT-Tarif)'},       // Kaufpreis EUR/kWh je Zeitfenster, Verkaufspreis
             battery: {capacityKwh: 43, maxChargeKw: 12, maxDischargeKw: 12, costEurKwh: 0.01}, grid: {importKw: 32, exportKw: 32}},          // Werte aus VRM Dynamic ESS (fuer spaetere Phasen)
    calcAT: {wNow: 0.5, wHist: 0.25, wFc: 0.25, minHistH: 6},
    sensor:  {maxAgeMin: 90, min: 10, max: 35, maxJumpK: 2, emaTauMin: 30, trendWindowMin: 120, trendMinSpanMin: 30, trendMinSamples: 3},
    weather: {intervalMin: 10, maxAgeMin: 60},
    log:     {intervalMin: 5}
};
function merge(base, over) {
    if (!over || typeof over !== 'object') { return base; }
    Object.keys(over).forEach(function (k) {
        if (k === 'rooms') { return; }       // Raeume nur je Raum-ID und nur mit den Einstellungsfeldern (siehe mergeRooms)
        if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && typeof over[k] === 'object' && !Array.isArray(over[k])) {
            base[k] = merge(base[k], over[k]);
        } else if (over[k] !== undefined && over[k] !== null) { base[k] = over[k]; }
    });
    return base;
}
function mergeRooms(base, over) {
    if (!Array.isArray(over)) { return; }
    over.forEach(function (o) {
        var b = base.find(function (x) { return x.id === o.id; });
        if (!b) { return; }
        ROOM_FIELDS.forEach(function (k) { if (o[k] !== undefined && o[k] !== null) { b[k] = o[k]; } });
    });
}
// gespeicherte Einstellungen (ueberleben einen Neustart) -> dann ggf. neuere Werte aus dem Speicher
var saved = {};
try { saved = JSON.parse(fs.readFileSync('/data/optimizer/config.json', 'utf8')); } catch (e) { /* noch keine Datei */ }
if (!saved || typeof saved !== 'object') { saved = {}; }
var cur = global.get('OPT_cfg') || {};
// plan und energy sind Modellparameter, keine Eingaben der Oberflaeche: sie entstehen immer aus den aktuellen Standardwerten plus config.json.
// Die im Speicher gehaltene Konfiguration (noch von einer aelteren Version) darf sie nicht ueberschreiben, sonst wirken verbesserte Standardwerte erst nach einem Neustart.
var fresh = {plan: JSON.parse(JSON.stringify(d.plan)), energy: JSON.parse(JSON.stringify(d.energy)), cop: JSON.parse(JSON.stringify(d.cop))};
var cfg = merge(merge(d, saved), cur);
['plan', 'energy', 'cop'].forEach(function (g) { cfg[g] = merge(fresh[g], saved[g]); });
mergeRooms(cfg.rooms, saved.rooms);
mergeRooms(cfg.rooms, cur.rooms);
delete cfg.comfort;                          // fruehere globale Komfortband-Einstellung: ersetzt durch je Raum eigene Baender
global.set('OPT_cfg', cfg);
return null;
"""

SET_CFG_JS = r"""
// Eingaben der Raumkarte -> Konfiguration. msg.topic = "room:<id>:<feld>" (active, eigeneHeizung, sonnenfenster, min, max, weight, maxAgeMin) oder "gruppe.feld".
// Ausgang 1: rote Rueckmeldung bei abgelehnter Eingabe. Ausgang 2: sofort neu auswerten, damit die Karte wieder die gueltigen Werte zeigt.
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var LIMITS = __LIMITS__, MIN_BAND = __MINBAND__;
var t = String(msg.topic || ''), v = msg.payload;
var again = {payload: 'auswerten'};
function de(x) { return String(x).replace('.', ','); }
function reject(text) { return [{topic: 'Optimierung', payload: text, highlight: 'red'}, again]; }
if (t.indexOf('room:') === 0) {
    var p = t.split(':');
    var room = (cfg.rooms || []).find(function (r) { return r.id === p[1]; });
    if (!room) { return null; }
    if (p[2] === 'active' || p[2] === 'eigeneHeizung' || p[2] === 'sonnenfenster') {              // Schalter (eigene Nachheizung: kein Bedarf fuer das ganze Haus, Entscheidung 5; Sonnenfenster: kein Ueberschuss in der Sonne, Paket 2)
        room[p[2]] = (v === true || v === 'true' || v === 1);
    } else {
        var lim = LIMITS[p[2]];
        if (!lim) { return null; }
        var n = (v === null || v === undefined || v === '' || typeof v === 'boolean') ? NaN : Number(v);
        if (!isFinite(n) || n < lim[0] || n > lim[1]) {
            return reject(room.name + ': Ungültiger Wert (erlaubt: ' + de(lim[0]) + ' bis ' + de(lim[1]) + '). Nichts geändert.');
        }
        var lo = (p[2] === 'min') ? n : room.min, hi = (p[2] === 'max') ? n : room.max;
        if (hi - lo < MIN_BAND - 1e-9) {
            return reject(room.name + ': Das Komfortband muss mindestens ' + de(MIN_BAND) + ' K breit sein (Minimum unter Maximum). Nichts geändert.');
        }
        room[p[2]] = n;
    }
} else {
    var q = t.split('.'), g = Number(v);
    if (!isFinite(g) || q.length !== 2 || !cfg[q[0]] || typeof cfg[q[0]] !== 'object') { return null; }
    cfg[q[0]][q[1]] = g;
}
global.set('OPT_cfg', cfg);
try {                                        // dauerhaft speichern, damit die Einstellung einen Neustart ueberlebt
    // Nur die geaenderte Eingabe festhalten, nicht die ganze Konfiguration: sonst friert die erste Eingabe alle Standardwerte
    // (auch spaeter hinzugekommene oder verbesserte) in der Datei ein, und Aenderungen der Standardwerte wuerden nie mehr wirken.
    var cfgFile = '/data/optimizer/config.json', sv = {};
    try { sv = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { sv = {}; }
    if (!sv || typeof sv !== 'object' || Array.isArray(sv)) { sv = {}; }
    if (t.indexOf('room:') === 0) {
        if (!Array.isArray(sv.rooms)) { sv.rooms = []; }
        var sr = sv.rooms.find(function (r) { return r && r.id === p[1]; });
        if (!sr) { sr = {id: p[1]}; sv.rooms.push(sr); }
        sr[p[2]] = room[p[2]];
    } else {
        if (!sv[q[0]] || typeof sv[q[0]] !== 'object') { sv[q[0]] = {}; }
        sv[q[0]][q[1]] = g;
    }
    fs.mkdirSync('/data/optimizer', {recursive: true});
    fs.writeFileSync(cfgFile, JSON.stringify(sv, null, 1));
} catch (e) { node.warn('Einstellungen konnten nicht gespeichert werden: ' + e.message); }
return [null, again];
"""

ROOM_IN_JS = r"""
// Raumsensor: Plausibilitaet, Ausreisser, Glaettung (EMA), Trend (Regression in K/h). Keine Regelwirkung.
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var room = (cfg.rooms || []).find(function (r) { return r.topic === msg.topic; });
if (!room) { return null; }                       // anderer Shelly, nicht in der Liste

var v = msg.payload;
if (Buffer.isBuffer(v)) { v = v.toString(); }
if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { /* reine Zahl */ } }
if (v && typeof v === 'object') { v = (v.tC !== undefined) ? v.tC : ((v.temperature !== undefined) ? v.temperature : v.value); }
v = Number(v);

var s = cfg.sensor, now = Date.now();
var R = global.get('OPT_rooms') || {};
var st = R[room.id] || {name: room.name, samples: [], ok: 0, rejected: 0};
st.name = room.name;

function reject(why) {
    st.rejected++; st.last_reject = {ts: now, v: v, why: why};
    R[room.id] = st; global.set('OPT_rooms', R);
    return null;
}
if (!isFinite(v) || v < s.min || v > s.max) { return reject('unplausibel'); }
// Ausreisser: ein Sprung ueber maxJumpK gegenueber dem letzten Wert gilt erst, wenn ihn ein zweiter Wert bestaetigt
if (st.last !== undefined && (now - st.ts) < 30 * 60000 && Math.abs(v - st.last) > s.maxJumpK) {
    if (st.pending !== undefined && Math.abs(v - st.pending) <= 1.0) { delete st.pending; }
    else { st.pending = v; return reject('Sprung'); }
} else { delete st.pending; }

var dtMin = st.ts ? Math.max(0, (now - st.ts) / 60000) : 0;
var alpha = (st.ema === undefined) ? 1 : 1 - Math.exp(-dtMin / s.emaTauMin);
st.ema = (st.ema === undefined) ? v : st.ema + alpha * (v - st.ema);
st.last = v; st.ts = now; st.ok++;

var cutoff = now - 3 * 3600 * 1000;
st.samples.push([now, v]);
st.samples = st.samples.filter(function (x) { return x[0] >= cutoff; });
if (st.samples.length > 300) { st.samples = st.samples.slice(-300); }

// Trend ueber das Fenster (lineare Regression), nur mit genug Messpunkten und Zeitspanne
var from = now - s.trendWindowMin * 60000;
var pts = st.samples.filter(function (x) { return x[0] >= from; });
st.trend = null;
if (pts.length >= s.trendMinSamples && (pts[pts.length - 1][0] - pts[0][0]) >= s.trendMinSpanMin * 60000) {
    var n = pts.length, t0 = pts[0][0], sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(function (p) { var x = (p[0] - t0) / 3600000; sx += x; sy += p[1]; sxx += x * x; sxy += x * p[1]; });
    var den = n * sxx - sx * sx;
    if (den > 1e-9) { st.trend = Math.round(((n * sxy - sx * sy) / den) * 100) / 100; }
}
R[room.id] = st;
global.set('OPT_rooms', R);
return null;
"""

OWM_REQ_JS = r"""
// OpenWeatherMap abrufen (Free-Tarif: aktuelles Wetter + 3-Stunden-Vorhersage fuer 36 h). Ohne Schluessel/Standort passiert nichts.
// Schluessel + Standort: bevorzugt aus der geschuetzten Datei (Eingabe im Dashboard unter SYSTEM > EINSTELLUNGEN),
// ersatzweise aus den Tab-Umgebungsvariablen OWM_API_KEY / OWM_LAT / OWM_LON. Der Schluessel wird NIE in einer
// Variable oder Meldung abgelegt, die ueber die Admin-API lesbar waere.
var key, lat, lon, source = '';
try {
    var j = JSON.parse(fs.readFileSync('/data/optimizer/owm.json', 'utf8'));
    key = j.key; lat = j.lat; lon = j.lon; source = 'Datei';
} catch (e) { /* noch nicht gespeichert */ }
if (!key) { key = env.get('OWM_API_KEY'); if (key) { source = 'Umgebung'; } }
if (lat === undefined || lat === '') { lat = env.get('OWM_LAT'); }
if (lon === undefined || lon === '') { lon = env.get('OWM_LON'); }
var W = global.get('OPT_weather') || {};
flow.set('owmInfo', {hasKey: !!key, keyLen: key ? String(key).length : 0, lat: lat, lon: lon, source: source});
function posOf(a, b) { var la = Number(a), lo = Number(b); return (a !== '' && b !== '' && a !== undefined && b !== undefined && a !== null && b !== null && isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) ? {lat: Math.round(la * 100) / 100, lon: Math.round(lo * 100) / 100} : null; }   // Standort fuer den Sonnenstand (zeitleiste 18.10.2026): nur die zwei Zahlen, auf 0,01° (~1 km) gerundet, nie der Schluessel
W.pos = posOf(lat, lon);
if (!key || lat === undefined || lat === '' || lon === undefined || lon === '') {
    W.status = 'nicht konfiguriert';
    global.set('OPT_weather', W);
    return null;
}
W.lastTry = Date.now();
global.set('OPT_weather', W);
var base = 'https://api.openweathermap.org/data/2.5/';
var q = '?lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon) + '&units=metric&lang=de&appid=' + encodeURIComponent(key);
node.send({topic: 'current',  url: base + 'weather' + q});
node.send({topic: 'forecast', url: base + 'forecast' + q + '&cnt=12'});
return null;
"""

OWM_PARSE_JS = r"""
// Antwort von OpenWeatherMap einordnen. Fehler setzen nur den Status, die letzten gueltigen Werte bleiben (und altern).
var W = global.get('OPT_weather') || {};
if (msg.error) {                                   // aus dem catch-Node
    W.status = 'Fehler: ' + String((msg.error.message || 'unbekannt')).replace(/appid=[^&\s]+/g, 'appid=***').slice(0, 80);
    global.set('OPT_weather', W);
    return null;
}
if (msg.statusCode !== 200 || !msg.payload || typeof msg.payload !== 'object') {
    W.status = 'Fehler: HTTP ' + msg.statusCode;
    global.set('OPT_weather', W);
    return null;
}
var p = msg.payload, now = Date.now();
function dew(t, rh) { var a = 17.62, b = 243.12, g = Math.log(Math.max(rh, 1) / 100) + a * t / (b + t); return b * g / (a - g); }
// Wetter-Code (Symbole der Wetterkarte, wetter-grafik 17.10.2026): weather[0].id (2xx Gewitter, 3xx Niesel, 5xx Regen, 6xx Schnee, 7xx Nebel/Dunst, 800 klar, 801-804 Wolken),
// Tag/Nacht aus der Endung von weather[0].icon (d = 1, n = 0, sonst null); Beschreibungen je Code in W.fdesc (Tooltip)
function wcode(e) { var w = e && e.weather && e.weather[0]; return (w && typeof w.id === 'number' && isFinite(w.id)) ? w.id : null; }
function wtag(e) { var w = e && e.weather && e.weather[0], i = w && typeof w.icon === 'string' ? w.icon.slice(-1) : ''; return i === 'd' ? 1 : (i === 'n' ? 0 : null); }
function wdesc(e, D) { var w = e && e.weather && e.weather[0], id = wcode(e); if (id !== null && w && typeof w.description === 'string' && w.description) { D[id] = w.description.slice(0, 60); } }
if (msg.topic === 'current' && p.main) {
    W.temp = p.main.temp; W.rh = p.main.humidity; W.dew = Math.round(dew(p.main.temp, p.main.humidity) * 10) / 10;
    W.clouds = p.clouds ? p.clouds.all : null; W.wind = p.wind ? p.wind.speed : null; W.pressure = p.main.pressure;
    W.desc = (p.weather && p.weather[0]) ? p.weather[0].description : '';
    if (p.sys && typeof p.sys.sunrise === 'number' && typeof p.sys.sunset === 'number') { W.sun = [p.sys.sunrise * 1000, p.sys.sunset * 1000]; }     // Naechte der Wetterkarte (wetter-grafik 17.10.2026)
    W.id = wcode(p); W.tag = wtag(p); W.fdesc = W.fdesc && typeof W.fdesc === 'object' ? W.fdesc : {}; wdesc(p, W.fdesc);
    W.ts = now; W.status = 'OK';
}
if (msg.topic === 'forecast' && Array.isArray(p.list) && p.list.length) {
    // +1/+3/+6 h per linearer Interpolation. Der Startpunkt "jetzt" ist der letzte aktuelle Wert (falls frisch);
    // kommt die Prognose vor der Aktuell-Antwort an, beginnt die Kurve am ersten Prognosepunkt.
    var fresh = (W.temp !== undefined && W.ts && (now - W.ts) < 30 * 60000);
    var pts = (fresh ? [{t: now, v: W.temp, h: W.rh, c: W.clouds, w: typeof W.wind === 'number' ? W.wind : null, i: typeof W.id === 'number' ? W.id : null, g: W.tag === 0 || W.tag === 1 ? W.tag : null}] : []).concat(p.list.map(function (e) {
        return {t: e.dt * 1000, v: e.main.temp, h: e.main.humidity, c: e.clouds ? e.clouds.all : null, w: (e.wind && typeof e.wind.speed === 'number') ? e.wind.speed : null, i: wcode(e), g: wtag(e)};
    }));
    var fd = {}; if (fresh && typeof W.id === 'number' && W.fdesc && W.fdesc[W.id]) { fd[W.id] = W.fdesc[W.id]; } p.list.forEach(function (e) { wdesc(e, fd); }); W.fdesc = fd;
    function r1(x) { return Math.round(x * 10) / 10; }
    function at(hours, key) {
        var target = now + hours * 3600000;
        for (var i = 0; i < pts.length; i++) {
            if (pts[i].t >= target) {
                if (i === 0) { return r1(pts[0][key]); }
                var a = pts[i - 1], b = pts[i], f = (target - a.t) / (b.t - a.t);
                return r1(a[key] + f * (b[key] - a[key]));
            }
        }
        return null;
    }
    W.f1 = at(1, 'v'); W.f3 = at(3, 'v'); W.f6 = at(6, 'v');
    W.f3_rh = at(3, 'h'); W.f_ts = now;
    // Mittel der naechsten 24 h (stuendlich interpoliert) - nur wenn die Prognose mindestens 20 h abdeckt; Punkte fuer spaetere Phasen
    var lastPt = pts[pts.length - 1], sum24 = 0, cnt24 = 0;
    if (lastPt && lastPt.t >= now + 20 * 3600000) {
        for (var hh = 0; hh <= 24; hh++) { var vv = at(hh, 'v'); if (vv !== null) { sum24 += vv; cnt24++; } }
    }
    W.f24 = cnt24 ? r1(sum24 / cnt24) : null;
    W.fpts = pts.filter(function (q) { return q.t > now - 3600000; }).map(function (q) { return [q.t, q.v, q.h, q.c, q.w === undefined ? null : q.w, q.i === undefined ? null : q.i, q.g === undefined ? null : q.g]; });       // 5. Element: Wind in m/s (Prognosepunkt), 6.: OWM-Wetter-Code, 7.: Tag 1 / Nacht 0 (null wenn unbekannt; wetter-grafik 17.10.2026)
}
global.set('OPT_weather', W);
return null;
"""

OWM_LOAD_JS = r"""
// Beim Start: gespeicherte Zugangsdaten pruefen (nur Status merken) und den Standort ins Formular zurueckschreiben.
// Der Schluessel selbst wird weder angezeigt noch in einer Variable abgelegt.
var info = {hasKey: false, keyLen: 0, source: ''};
var fill = {owm_key: '', owm_lat: '', owm_lon: ''};
try {
    var j = JSON.parse(fs.readFileSync('/data/optimizer/owm.json', 'utf8'));
    info = {hasKey: !!j.key, keyLen: j.key ? String(j.key).length : 0, lat: j.lat, lon: j.lon, source: 'Datei'};
    fill.owm_lat = String(j.lat); fill.owm_lon = String(j.lon);
} catch (e) { /* noch nichts gespeichert */ }
flow.set('owmInfo', info);
function posOf(a, b) { var la = Number(a), lo = Number(b); return (a !== '' && b !== '' && a !== undefined && b !== undefined && a !== null && b !== null && isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) ? {lat: Math.round(la * 100) / 100, lon: Math.round(lo * 100) / 100} : null; }   // Standort fuer den Sonnenstand (zeitleiste 18.10.2026): nur die zwei Zahlen, auf 0,01° (~1 km) gerundet, nie der Schluessel
var Wp = global.get('OPT_weather') || {}, ps = posOf(info.lat !== undefined ? info.lat : env.get('OWM_LAT'), info.lon !== undefined ? info.lon : env.get('OWM_LON'));
if (ps) { Wp.pos = ps; global.set('OPT_weather', Wp); }
return {payload: fill};
"""

OWM_SAVE_JS = r"""
// Formular "OpenWeatherMap" (SYSTEM > EINSTELLUNGEN): pruefen und in /data/optimizer/owm.json speichern (nur fuer den
// Node-RED-Benutzer lesbar, Modus 0600). Der Schluessel taucht in keiner Variable und keiner Anzeige auf.
var p = msg.payload || {};
var file = '/data/optimizer/owm.json';
function toast(text, red) { var t = {topic: 'OpenWeatherMap', payload: text}; if (red) { t.highlight = 'red'; } return t; }

var cur = {};
try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* neu */ }

var key = String(p.owm_key || '').trim();
var lat = String(p.owm_lat || '').trim().replace(',', '.');
var lon = String(p.owm_lon || '').trim().replace(',', '.');
if (key && !/^[A-Za-z0-9]{16,64}$/.test(key)) {
    return [null, toast('Der API-Schlüssel hat ein ungültiges Format (16–64 Zeichen, nur Buchstaben und Ziffern). Es wurde nichts gespeichert.', true), null, null];
}
if (!key) { key = cur.key || ''; }                 // leer lassen = vorhandenen Schluessel behalten
if (lat === '' && cur.lat !== undefined) { lat = String(cur.lat); }
if (lon === '' && cur.lon !== undefined) { lon = String(cur.lon); }
var nlat = Number(lat), nlon = Number(lon);
if (!key) { return [null, toast('Bitte einen API-Schlüssel eingeben.', true), null, null]; }
if (lat === '' || !isFinite(nlat) || nlat < -90 || nlat > 90) { return [null, toast('Breitengrad ungültig (-90 bis 90, z. B. 50.1).', true), null, null]; }
if (lon === '' || !isFinite(nlon) || nlon < -180 || nlon > 180) { return [null, toast('Längengrad ungültig (-180 bis 180, z. B. 8.6).', true), null, null]; }

try {
    fs.mkdirSync('/data/optimizer', {recursive: true});
    fs.writeFileSync(file, JSON.stringify({key: key, lat: nlat, lon: nlon, saved: Date.now()}), {mode: 0o600});
    fs.chmodSync(file, 0o600);
} catch (e) {
    return [null, toast('Speichern fehlgeschlagen: ' + e.message, true), null, null];
}
flow.set('owmInfo', {hasKey: true, keyLen: key.length, lat: nlat, lon: nlon, source: 'Datei'});
return [{payload: {owm_key: '', owm_lat: String(nlat), owm_lon: String(nlon)}},      // Schluesselfeld leeren
        toast('Gespeichert. Die Wetterdaten werden jetzt abgerufen.', false),
        {payload: 'jetzt'},                                                        // sofort abrufen
        {payload: 'Schlüssel gespeichert (' + key.length + ' Zeichen) · Standort ' + nlat.toFixed(3).replace('.', ',') + ' / ' + nlon.toFixed(3).replace('.', ',') + ' · Wetterdaten werden abgerufen …'}];
"""

EN_IN_JS = r"""
// Energiedaten NUR LESEN: Venus-MQTT (PV, Netz, Batterie, Haus) und evcc (Tarife, Prognosen). Kein Einfluss auf Heizkurve, Quiet oder Warmwasser.
var en = global.get('OPT_en') || {};
var now = Date.now(), t = String(msg.topic || ''), key = null;
var m = t.match(/^N\/[^/]+\/system\/0\/(.+)$/), mb = t.match(/^N\/[^/]+\/battery\/(\d+)\/Soc$/);
if (m) { key = 'v:' + m[1]; } else if (mb) { key = 'v:battery/' + mb[1] + '/Soc'; } else if (t.indexOf('evcc/site/') === 0) { key = 'e:' + t.slice(10); }
if (key === null || !/^(v:(Ac\/(Grid|Consumption|PvOnGrid|PvOnOutput)\/L[1-3]\/Power|Dc\/(Pv|Battery)\/Power|Dc\/Battery\/Soc|battery\/\d+\/Soc)|e:(tariffGrid|tariffFeedIn|battery\/soc|forecast\/(grid|feedIn|solar)))$/.test(key)) { return null; }
var p = msg.payload;
if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { /* reine Zahl */ } }
if (key.indexOf('e:forecast/') === 0) {                       // Prognosen: Liste bzw. Objekt
    if (p === null || typeof p !== 'object') { return null; }
    en[key] = {v: p, ts: now};
} else {                                                      // Messwerte: Venus {"value": x} oder reine Zahl
    var v = (p !== null && typeof p === 'object') ? p.value : p;
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) { return null; }
    var lim = /Soc$/.test(key) ? [0, 100] : (/^e:tariff/.test(key) ? [-1, 3] : [-60000, 60000]);       // unplausible Werte nicht uebernehmen (der letzte gute Wert bleibt und altert)
    if (Number(v) < lim[0] || Number(v) > lim[1]) { return null; }
    en[key] = {v: Number(v), ts: now};
}
global.set('OPT_en', en);
return null;
"""

ENERGY_JS = r"""
// Energie & Preise: einlesen, pruefen, Datenalter ueberwachen, anzeigen, protokollieren. NUR Anzeige und Protokoll, keinerlei Regelwirkung.
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var E = cfg.energy || {};
var en = global.get('OPT_en') || {}, W = global.get('OPT_weather') || {};
var now = Date.now(), MS_MIN = 60000, H = 3600000;
function ok(v) { return v !== null && v !== undefined && isFinite(v); }
function f(v, d, unit) { if (!ok(v)) { return '–'; } return Number(v).toFixed(d).replace('.', ',') + (unit ? ' ' + unit : ''); }
function c(v) { return (v === null || v === undefined || !isFinite(v)) ? '' : String(Math.round(v * 1000) / 1000); }
function hhmm(ts) { return new Date(ts).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}); }
function ageTxt(ms) { if (ms === null) { return 'keine Daten'; } var m = Math.round(ms / MS_MIN); return m < 1 ? '< 1 min' : (m < 120 ? m + ' min' : (m / 60).toFixed(1).replace('.', ',') + ' h'); }
function ev(k, lo, hi) { var e = en[k]; if (!e || typeof e.v !== 'number' || !isFinite(e.v) || e.v < lo || e.v > hi) { return null; } return e.v; }
function age(k) { var e = en[k]; return e ? now - e.ts : null; }
function sum3(prefix, lo, hi) { var s = 0, n = 0; ['1', '2', '3'].forEach(function (l) { var v = ev(prefix + '/L' + l + '/Power', lo, hi); if (v !== null) { s += v; n++; } }); return n ? s : null; }

// ---------- Live-Werte (Venus)
var pvAc = sum3('v:Ac/PvOnOutput', -100, 60000), pvGr = sum3('v:Ac/PvOnGrid', -100, 60000), pvDc = ev('v:Dc/Pv/Power', -100, 60000);
var pv = (pvAc === null && pvGr === null && pvDc === null) ? null : Math.max(0, (pvAc || 0) + (pvGr || 0) + (pvDc || 0));
var grid = sum3('v:Ac/Grid', -60000, 60000), home = sum3('v:Ac/Consumption', -100, 60000);
var kSoc = 'v:battery/' + (isFinite(E.batteryInstance) ? Number(E.batteryInstance) : 278) + '/Soc';                      // Venus: Batterie-Instanz (278)
var batP = ev('v:Dc/Battery/Power', -60000, 60000), socV = ev(kSoc, 0, 100), socE = ev('e:battery/soc', 0, 100);          // Venus: Batterieleistung positiv = laden
var socFresh = socV !== null && age(kSoc) <= 30 * MS_MIN;                                  // Venus sendet unveraenderte Werte nicht erneut: sonst evcc als Rueckfall
var soc = socFresh ? socV : (socE !== null ? socE : socV), socSrc = socFresh ? 'Venus' : (socE !== null ? 'evcc' : (socV !== null ? 'Venus (alt)' : ''));
var liveAge = null;
Object.keys(en).forEach(function (k) { if (k.indexOf('v:') === 0 && !/\/Soc$/.test(k)) { var a = now - en[k].ts; if (liveAge === null || a < liveAge) { liveAge = a; } } });
var liveOk = liveAge !== null && liveAge < 5 * MS_MIN, socAge = socFresh ? age(kSoc) : (socE !== null ? age('e:battery/soc') : age(kSoc));
// ---------- Preise (evcc): 15-Minuten-Slots [Beginn, Ende, Preis] in Sekunden
function slots(k) {
    var e = en[k]; if (!e || !Array.isArray(e.v)) { return null; }
    var out = [];
    e.v.forEach(function (s) { if (Array.isArray(s) && isFinite(s[0]) && isFinite(s[1]) && isFinite(s[2]) && s[1] > s[0] && s[2] > -1 && s[2] < 3) { out.push({s: s[0] * 1000, e: s[1] * 1000, p: s[2]}); } });
    return out.length ? out : null;
}
var pSlots = slots('e:forecast/grid'), pCur = ev('e:tariffGrid', -1, 3), pFeed = ev('e:tariffFeedIn', -1, 3);
var eCur = pCur, eFeed = pFeed, pSrc = 'evcc';
// Preise: bevorzugt der in VRM Dynamic ESS hinterlegte HT/NT-Tarif (danach plant das System), evcc nur zum Vergleich / als Rueckfall
var TF = E.tariff;
if (TF && Array.isArray(TF.buy) && TF.buy.length) {
    var hm = function (x) { var q = String(x).split(':'); return Number(q[0]) * 60 + Number(q[1] || 0); };
    var tSl = [], tOk = true, t00 = Math.floor(now / 900000) * 900000 - 900000;
    for (var t0 = t00; t0 < now + 48 * H && tOk; t0 += 900000) {
        var dq = new Date(t0), mins = dq.getHours() * 60 + dq.getMinutes(), pr = null;
        TF.buy.forEach(function (w) { var a = hm(w[0]), b = hm(w[1]); if (b <= a || b === 1439) { b = 1440; } if (mins >= a && mins < b) { pr = Number(w[2]); } });
        if (pr === null || !isFinite(pr) || pr < -1 || pr > 3) { tOk = false; } else { tSl.push({s: t0, e: t0 + 900000, p: pr}); }
    }
    if (tOk && tSl.length) { pSlots = tSl; pSrc = 'VRM-Tarif'; pCur = null; pFeed = isFinite(TF.sell) ? Number(TF.sell) : pFeed; }
}
var priceCov = null, pMin = null, pAvg = null, pMax = null, pMinAt = null, p3 = null, p3At = null;
if (pSlots) {
    var last = pSlots[pSlots.length - 1].e;
    priceCov = Math.max(0, (last - now) / H);
    var win = pSlots.filter(function (s) { return s.e > now && s.s < now + 24 * H; });
    if (win.length) {
        var wsum = 0, psum = 0;
        win.forEach(function (s) { var d = Math.min(s.e, now + 24 * H) - Math.max(s.s, now); wsum += d; psum += d * s.p; if (pMin === null || s.p < pMin) { pMin = s.p; pMinAt = s.s; } if (pMax === null || s.p > pMax) { pMax = s.p; } });
        pAvg = wsum ? psum / wsum : null;
        var cur = win.filter(function (s) { return s.s <= now && s.e > now; })[0];
        if (cur) { pCur = cur.p; }
        for (var i = 0; i < win.length; i++) {                         // guenstigstes 3-Stunden-Fenster (Mittel ueber die Slots ab Beginn)
            var a0 = Math.max(win[i].s, now), a1 = a0 + 3 * H, s2 = 0, d2 = 0;
            for (var j = i; j < win.length && win[j].s < a1; j++) { var dd = Math.min(win[j].e, a1) - Math.max(win[j].s, a0); if (dd > 0) { s2 += dd * win[j].p; d2 += dd; } }
            if (d2 >= 3 * H - 1000 && (p3 === null || s2 / d2 < p3)) { p3 = s2 / d2; p3At = a0; }
        }
    }
}
// ---------- PV-Prognose: bevorzugt VRM (Stundenwerte in Wh), sonst evcc (15-Minuten-Werte in W) - vorlaeufig
function series(arr, dt, scale) {                                      // -> [{t (ms), w (mittlere Leistung in W), dt (ms)}]
    var out = [];
    if (!Array.isArray(arr)) { return out; }
    arr.forEach(function (x) { var t0 = Array.isArray(x) ? Number(x[0]) : NaN, v = Array.isArray(x) ? Number(x[1]) : NaN; if (isFinite(t0) && isFinite(v) && v >= 0 && v < 200000) { out.push({t: (t0 > 1e11 ? t0 : t0 * 1000), w: v * scale, dt: dt}); } });
    return out;
}
var vrm = en.vrm || {}, vrmAge = vrm.ts ? now - vrm.ts : null;
var pvSeries = [], pvSrc = '–';
var vSer = series(vrm.pv, H, 1);
var eSol = en['e:forecast/solar'] ? en['e:forecast/solar'].v : null;
var eSer = series(eSol && eSol.timeseries, 900000, 1);
if (vSer.length && vrmAge !== null && vrmAge <= (isFinite(E.vrmMaxAgeH) ? Number(E.vrmMaxAgeH) : 4) * H && vSer[vSer.length - 1].t + H - now >= 12 * H) { pvSeries = vSer; pvSrc = 'VRM'; }
else if (eSer.length && age('e:forecast/solar') !== null && age('e:forecast/solar') <= (isFinite(E.evccMaxAgeH) ? Number(E.evccMaxAgeH) : 6) * H) { pvSeries = eSer; pvSrc = 'evcc (vorläufig)'; }
function kwh24(arr) {                                                 // VRM-Stundenwerte in Wh -> kWh der naechsten 24 h
    if (!Array.isArray(arr) || !arr.length) { return null; }
    var sm = 0, cn = 0;
    arr.forEach(function (x) { var q0 = x[0] * 1000, o = Math.min(q0 + H, now + 24 * H) - Math.max(q0, now); if (o > 0 && isFinite(x[1])) { sm += x[1] * o / H; cn++; } });
    return cn ? sm / 1000 : null;
}
var vrmFresh = vrmAge !== null && vrmAge <= (isFinite(E.vrmMaxAgeH) ? Number(E.vrmMaxAgeH) : 4) * H;
var consK = vrmFresh ? kwh24(vrm.cons) : null, hpK = vrmFresh ? kwh24(vrm.hp) : null;
var pvCov = pvSeries.length ? Math.max(0, (pvSeries[pvSeries.length - 1].t + pvSeries[pvSeries.length - 1].dt - now) / H) : null;
var pvKwh24 = null, pvPeak = null, pvPeakAt = null, kToday = null, kTomorrow = null;
if (pvSeries.length) {
    pvKwh24 = 0; kToday = 0; kTomorrow = 0;
    var d0 = new Date(now); d0.setHours(0, 0, 0, 0); var day0 = d0.getTime();
    pvSeries.forEach(function (s) {
        var o = Math.min(s.t + s.dt, now + 24 * H) - Math.max(s.t, now);
        if (o > 0) { pvKwh24 += s.w * o / H / 1000; if (pvPeak === null || s.w > pvPeak) { pvPeak = s.w; pvPeakAt = s.t; } }
        var e0 = s.t + s.dt;
        if (s.t >= day0 && e0 <= day0 + 24 * H) { kToday += s.w * s.dt / H / 1000; } else if (s.t >= day0 + 24 * H && e0 <= day0 + 48 * H) { kTomorrow += s.w * s.dt / H / 1000; }
    });
}
// ---------- Anzeige
var warnS = function (okk) { return okk ? 'ok' : 'warn'; };
var priceOk = priceCov !== null && priceCov >= 24, pvOk = pvCov !== null && pvCov >= 24;
var grd = grid === null ? '–' : (grid >= 0 ? f(grid, 0, 'W') + ' Bezug' : f(-grid, 0, 'W') + ' Einspeisung');
var bat = batP === null ? '–' : (Math.abs(batP) < 20 ? '0 W' : (batP > 0 ? f(batP, 0, 'W') + ' laden' : f(-batP, 0, 'W') + ' entladen'));
var rows = [
    ['PV aktuell', f(pv, 0, 'W'), ''],
    ['Haus', f(home, 0, 'W'), ''],
    ['Netz', grd, ''],
    ['Batterie', f(soc, 0, '%') + (socSrc === 'evcc' ? ' (evcc)' : '') + ' · ' + bat, soc !== null && socSrc === 'Venus (alt)' ? 'warn' : ''],
    ['Strompreis jetzt (' + pSrc + ')', pCur !== null ? f(pCur * 100, 1, 'ct/kWh') + (pFeed !== null ? ' · Einspeisung ' + f(pFeed * 100, 1, 'ct') : '') : '–', ''],
    ['evcc-Tarif (Vergleich)', pSrc === 'VRM-Tarif' ? (eCur !== null ? f(eCur * 100, 1) + ' / ' + f(eFeed * 100, 1, 'ct') + (pCur !== null && Math.abs(eCur - pCur) > 0.005 ? ' · weicht ab' : ' · gleich') : '–') : 'ist die Quelle', ''],
    ['Preis nächste 24 h', pMin !== null ? f(pMin * 100, 1) + ' – ' + f(pAvg * 100, 1) + ' – ' + f(pMax * 100, 1, 'ct/kWh') + ' (min – Ø – max)' : '–', ''],
    ['Günstigster Slot / 3 h', pMinAt ? hhmm(pMinAt) + ' (' + f(pMin * 100, 1, 'ct') + ') / ab ' + (p3At ? hhmm(p3At) + ' (Ø ' + f(p3 * 100, 1, 'ct') + ')' : '–') : '–', ''],
    ['PV-Prognose nächste 24 h', pvKwh24 !== null ? f(pvKwh24, 1, 'kWh') + ' · Spitze ' + f(pvPeak, 0, 'W') + ' um ' + hhmm(pvPeakAt) : '–', ''],
    ['Verbrauch nächste 24 h (VRM-Prognose)', consK !== null ? f(consK, 1, 'kWh') : '–', ''],
    ['Wärmepumpe nächste 24 h (VRM-Prognose)', hpK !== null ? f(hpK, 2, 'kWh') : 'nicht geliefert', ''],
    ['PV-Prognose heute / morgen', kToday !== null ? f(kToday, 1) + ' / ' + f(kTomorrow, 1, 'kWh') : '–', ''],
    ['Daten Venus (live)', liveOk ? 'ok · Alter ' + ageTxt(liveAge) : 'veraltet · ' + ageTxt(liveAge), warnS(liveOk)],
    ['Daten Strompreise', pSlots ? pSrc + ' · ' + (priceOk ? 'ok' : 'zu kurz') + ' · reichen ' + f(priceCov, 0, 'h') + ' voraus' : 'keine Daten', warnS(priceOk)],
    ['Daten PV-Prognose', pvSeries.length ? pvSrc + (pvOk ? '' : ' (zu kurz)') + ' · reicht ' + f(pvCov, 0, 'h') + ' voraus' : 'keine · VRM: ' + (vrm.status || 'nicht konfiguriert'), warnS(pvOk)],
    ['VRM-Abruf', (vrm.status || 'nicht konfiguriert') + (vrmAge !== null ? ' · ' + ageTxt(vrmAge) : ''), vrm.status === 'OK' ? 'ok' : '']
];
var vi = flow.get('vrmInfo');
var out = [{payload: {rows: rows}}, null, null, {payload: (!vi || !vi.hasToken) ? 'Noch kein VRM-Token gespeichert. Token und Installations-ID oben eintragen und auf SPEICHERN klicken.'
    : 'Token gespeichert (' + vi.tokenLen + ' Zeichen) · Installation ' + vi.id + ' · Abruf: ' + (vrm.status || 'noch nicht abgerufen') + (vrmAge !== null ? ' (Alter ' + ageTxt(vrmAge) + ')' : '')}, null];
// ---------- Protokoll alle 5 min; stuendlicher Schnappschuss der Prognosen (zum spaeteren Vergleich mit dem, was wirklich war)
var d = new Date(now), pad = function (n) { return (n < 10 ? '0' : '') + n; };
var month = d.getFullYear() + '-' + pad(d.getMonth() + 1);
var iso = month + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
var lastLog = flow.get('enLog');
if (!lastLog || now - lastLog >= 5 * MS_MIN - 1000) {
    var cols = ['zeit', 'pv_w', 'haus_w', 'netz_w', 'batterie_w', 'batterie_soc', 'preis_netz', 'preis_einspeisung', 'preis_min_24h', 'preis_mittel_24h', 'preis_max_24h', 'preis_guenstigster_slot',
                'pv_prog_24h_kwh', 'pv_prog_spitze_w', 'pv_prog_heute_kwh', 'pv_prog_morgen_kwh', 'pv_prog_quelle', 'venus_ok', 'venus_alter_min', 'soc_alter_min', 'preise_reichen_h', 'pv_prognose_reicht_h', 'vrm_status', 'soc_quelle', 'preis_quelle', 'preis_netz_evcc', 'preis_einspeisung_evcc', 'vrm_verbrauch_24h_kwh', 'vrm_wp_24h_kwh'];
    var vals = [iso, c(pv), c(home), c(grid), c(batP), c(soc), c(pCur), c(pFeed), c(pMin), c(pAvg), c(pMax), pMinAt ? hhmm(pMinAt) : '',
                c(pvKwh24), c(pvPeak), c(kToday), c(kTomorrow), pvSrc, liveOk ? 1 : 0, liveAge === null ? '' : c(liveAge / MS_MIN), socAge === null ? '' : c(socAge / MS_MIN), c(priceCov), c(pvCov), String(vrm.status || '').replace(/,/g, ';'), socSrc, pSrc, c(eCur), c(eFeed), c(consK), c(hpK)];
    var file = '/data/optimizer/energy-' + month + '.csv', head = cols.join(','), needHead = true;
    if (flow.get('enHead') === month + '|' + head) { needHead = false; }
    else {
        flow.set('enHead', month + '|' + head);
        try { var lastH = null; String(fs.readFileSync(file, 'utf8')).split('\n').forEach(function (l) { if (l.indexOf('zeit,') === 0) { lastH = l; } }); needHead = lastH !== head; } catch (e) { needHead = true; }
    }
    out[1] = {filename: file, payload: (needHead ? head + '\n' : '') + vals.join(',') + '\n'};
    flow.set('enLog', now);
}
var lastSnap = flow.get('enSnap');
if (!lastSnap || now - lastSnap >= H - 1000) {
    var upto = now + 36 * H;
    var snap = {t: Math.round(now / 1000), at: num0(G0('TOP14_Outside_Temp')),
                owm: (W.fpts && W.f_ts && now - W.f_ts < 2 * H) ? W.fpts : null,
                price: pSlots ? pSlots.filter(function (s) { return s.e > now - 900000 && s.s < upto; }).map(function (s) { return [Math.round(s.s / 1000), s.p]; }) : null,
                pv: pvSeries.length ? pvSeries.filter(function (s) { return s.t + s.dt > now && s.t < upto; }).map(function (s) { return [Math.round(s.t / 1000), Math.round(s.w), s.dt / 1000]; }) : null, pvSrc: pvSrc,
                cons: vrmFresh && vrm.cons ? vrm.cons.filter(function (x) { return x[0] * 1000 + H > now && x[0] * 1000 < upto; }).map(function (x) { return [x[0], Math.round(x[1])]; }) : null,
                hp: vrmFresh && vrm.hp ? vrm.hp.filter(function (x) { return x[0] * 1000 + H > now && x[0] * 1000 < upto; }).map(function (x) { return [x[0], Math.round(x[1] * 10) / 10]; }) : null};
    out[2] = {filename: '/data/optimizer/forecast-' + month + '.jsonl', payload: JSON.stringify(snap) + '\n'};
    flow.set('enSnap', now);
    var sn0 = flow.get('enSnaps') || jload('/data/optimizer/forecast-recent.json', []);       // kompakte Kopie der letzten 30 Stunden fuer die Pruefung
    sn0.push({t: snap.t, owm: snap.owm, pv: snap.pv});
    while (sn0.length > 30) { sn0.shift(); }
    flow.set('enSnaps', sn0); jsave('/data/optimizer/forecast-recent.json', sn0);
}
// ---------- Prognosegueete (nur Anzeige): Prognosen der Schnappschuesse mit dem vergleichen, was dann wirklich war (Stundenwerte)
var FQ_H = [1, 3, 6, 12, 24];
var fqAct = flow.get('enAct'), fqHist = flow.get('enHist') || jload('/data/optimizer/actuals-hourly.json', []);
var fqSn = flow.get('enSnaps') || jload('/data/optimizer/forecast-recent.json', []);
var fq = flow.get('enFq') || jload('/data/optimizer/forecast-quality.json', {at: {}, pv: {}});
var h0 = Math.floor(now / H) * H, atNow = num0(G0('TOP14_Outside_Temp'));
function owmAt(sn, tMs) {                                              // Prognose der Aussentemperatur zum Zeitpunkt (linear zwischen den 3-h-Punkten)
    if (!sn || !Array.isArray(sn.owm)) { return null; }
    var pts = sn.owm;
    for (var i = 1; i < pts.length; i++) { if (pts[i][0] >= tMs && pts[i - 1][0] <= tMs) { return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (tMs - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); } }
    return null;
}
function pvMean(sn, a, b) {                                            // mittlere PV-Leistung der Prognose in [a, b] (ms)
    if (!sn || !Array.isArray(sn.pv) || !sn.pv.length) { return null; }
    var sw = 0, dt = 0;
    sn.pv.forEach(function (x) { var q0 = x[0] * 1000, q1 = q0 + (x[2] || 3600) * 1000, o = Math.min(q1, b) - Math.max(q0, a); if (o > 0) { sw += x[1] * o; dt += o; } });
    return dt >= (b - a) * 0.9 ? sw / dt : null;
}
function fqEval(S, atA, pvA) {                                         // abgeschlossene Stunde [S, S+1h] auswerten
    FQ_H.forEach(function (h) {
        var want = S - h * H, best = null;
        fqSn.forEach(function (sn) { var d = Math.abs(sn.t * 1000 - want); if (d <= 35 * MS_MIN && (best === null || d < Math.abs(best.t * 1000 - want))) { best = sn; } });
        if (!best) { return; }
        var fa = owmAt(best, S + H / 2);
        if (fa !== null && atA !== null) { var e = fq.at[h] = fq.at[h] || {n: 0, bias: 0, abs: 0}; e.n++; e.bias += fa - atA; e.abs += Math.abs(fa - atA); }
        var fp = pvMean(best, S, S + H);
        if (fp !== null && pvA !== null && Math.max(fp, pvA) > 100) { var g = fq.pv[h] = fq.pv[h] || {n: 0, fc: 0, act: 0, abs: 0}; g.n++; g.fc += fp; g.act += pvA; g.abs += Math.abs(fp - pvA); }
    });
}
if (!fqAct || fqAct.t0 !== h0) {
    if (fqAct && fqAct.n >= 20) {                                     // vorherige Stunde abschliessen (mindestens 20 Minuten Daten)
        var atA = fqAct.atN ? fqAct.atS / fqAct.atN : null, pvA = fqAct.pvN ? fqAct.pvS / fqAct.pvN : null;
        fqHist.push([fqAct.t0, atA, pvA]);
        while (fqHist.length > 240) { fqHist.shift(); }
        fqEval(fqAct.t0, atA, pvA);
        flow.set('enFq', fq); flow.set('enHist', fqHist);
        jsave('/data/optimizer/forecast-quality.json', fq); jsave('/data/optimizer/actuals-hourly.json', fqHist);
    }
    fqAct = {t0: h0, atS: 0, atN: 0, pvS: 0, pvN: 0, n: 0};
}
fqAct.n++;
if (atNow !== null) { fqAct.atS += atNow; fqAct.atN++; }
if (pv !== null) { fqAct.pvS += pv; fqAct.pvN++; }
flow.set('enAct', fqAct); flow.set('enHist', fqHist); flow.set('enSnaps', fqSn); flow.set('enFq', fq);
var fqRows = [];
FQ_H.forEach(function (h) {
    var a = fq.at[h];
    fqRows.push(['Außentemperatur +' + h + ' h (OWM)', a && a.n >= 3 ? 'Abw. ' + (a.bias / a.n >= 0 ? '+' : '') + f(a.bias / a.n, 1) + ' K · mittlerer Fehler ' + f(a.abs / a.n, 1, 'K') + ' (n ' + a.n + ')' : 'zu wenig Daten' + (a ? ' (n ' + a.n + ')' : ''), '']);
});
FQ_H.forEach(function (h) {
    var g = fq.pv[h];
    fqRows.push(['PV +' + h + ' h (' + (pvSrc === '–' ? 'Prognose' : pvSrc.split(' ')[0]) + ')', g && g.n >= 3 ? 'Prognose ' + f(100 * g.fc / g.act, 0, '%') + ' vom Ist · mittlerer Fehler ' + f(g.abs / g.n, 0, 'W') + ' (n ' + g.n + ')' : 'zu wenig Daten' + (g ? ' (n ' + g.n + ')' : ''), '']);
});
fqRows.push(['Gesammelt', fqHist.length + ' Stunden Ist-Werte · ' + fqSn.length + ' Prognose-Schnappschüsse', '']);
var fqTab = FQ_H.map(function (h) { var a = fq.at[h], g = fq.pv[h]; return ['+' + h + ' h', a && a.n >= 3 ? (a.bias / a.n >= 0 ? '+' : '') + f(a.bias / a.n, 1, 'K') : '–', a && a.n >= 3 ? f(a.abs / a.n, 1, 'K') : '–', a ? a.n : 0,
    g && g.n >= 3 ? f(100 * g.fc / g.act, 0, '%') : '–', g && g.n >= 3 ? f(g.abs / g.n, 0, 'W') : '–', g ? g.n : 0]; });   // ui-daten 18.10.: Tabelle Horizont x (Aussentemperatur, PV)
out[4] = {payload: {rows: fqRows, tab: fqTab, pvQuelle: pvSrc === '–' ? 'Prognose' : pvSrc.split(' ')[0], sammel: fqHist.length + ' Stunden Ist-Werte · ' + fqSn.length + ' Prognose-Schnappschüsse'}};
global.set('OPT_plan_in', {ts: now, price: pSlots ? pSlots.filter(function (s) { return s.e > now - 2 * H && s.s < now + 40 * H; }).map(function (s) { return [s.s, s.e, s.p]; }) : null, priceSrc: pSrc,
    pv: pvSeries.length ? pvSeries.filter(function (s) { return s.t + s.dt > now - 2 * H && s.t < now + 40 * H; }).map(function (s) { return [s.t, Math.round(s.w), s.dt]; }) : null, pvSrc: pvSrc,
    pvNow: pv, soc: soc, socSrc: socSrc, liveOk: liveOk, grid: grid, batP: batP, vrmHpKwh: hpK});
function G0(k) { return global.get(k); }
function num0(v) { v = Number(v); return (v === null || v === undefined || !isFinite(v)) ? null : v; }
function jload(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } }
function jsave(file, obj) { try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync(file, JSON.stringify(obj)); } catch (e) { /* kein Zugriff */ } }
return out;
"""

VRM_REQ_JS = r"""
// VRM-API (Prognose fuer PV und Verbrauch). Zugangsdaten stehen nur in /data/optimizer/vrm.json (Modus 0600, Eingabe im Dashboard unter
// SYSTEM > EINSTELLUNGEN); der Token wird NIE in einer Variable, Meldung oder Anzeige abgelegt.
var j = null;
try { j = JSON.parse(fs.readFileSync('/data/optimizer/vrm.json', 'utf8')); } catch (e) { /* noch nicht gespeichert */ }
var en = global.get('OPT_en') || {}; en.vrm = en.vrm || {};
if (!j || !j.token || !j.id) {
    en.vrm.status = 'nicht konfiguriert';
    global.set('OPT_en', en);
    flow.set('vrmInfo', {hasToken: false});
    return null;
}
flow.set('vrmInfo', {hasToken: true, tokenLen: String(j.token).length, id: j.id});
var nowS = Math.floor(Date.now() / 3600000) * 3600;                    // volle Stunde: VRM legt die Stundenwerte ab "start" an
return {topic: 'vrm', headers: {'x-authorization': 'Token ' + j.token},
        url: 'https://vrmapi.victronenergy.com/v2/installations/' + encodeURIComponent(j.id) + '/stats?type=forecast&interval=hours&start=' + (nowS - 3600) + '&end=' + (nowS + 48 * 3600)};
"""

VRM_PARSE_JS = r"""
// Antwort der VRM-API einordnen. Fehler setzen nur den Status, die letzten gueltigen Werte bleiben (und altern).
var en = global.get('OPT_en') || {}, V = en.vrm = en.vrm || {};
function fail(t) { V.status = t; global.set('OPT_en', en); return null; }
if (msg.error) { return fail('Fehler: ' + String(msg.error.message || 'unbekannt').replace(/Token\s+\S+/gi, 'Token ***').slice(0, 80)); }
if (msg.statusCode === 401 || msg.statusCode === 403) { return fail('Token ungültig oder ohne Berechtigung (HTTP ' + msg.statusCode + ')'); }
if (msg.statusCode !== 200 || !msg.payload || typeof msg.payload !== 'object') { return fail('Fehler: HTTP ' + msg.statusCode); }
var p = msg.payload;
if (p.success === false) { return fail('Fehler: ' + String(p.errors || p.error || 'VRM meldet einen Fehler').slice(0, 80)); }
var rec = p.records;
if (!rec || typeof rec !== 'object') { return fail('keine Prognose (Anlage ohne Solar oder noch keine Daten)'); }
function norm(arr) {                                               // [[Zeit, Wert], ...] -> Zeit in Sekunden, nur gueltige Zahlen
    var o = [];
    if (!Array.isArray(arr)) { return o; }
    arr.forEach(function (x) { if (Array.isArray(x)) { var t = Number(x[0]), v = Number(x[1]); if (isFinite(t) && isFinite(v) && v >= 0) { o.push([t > 1e11 ? Math.round(t / 1000) : t, v]); } } });
    return o;
}
var pv = norm(rec.solar_yield_forecast);                           // vrm_consum_hp_fc (Waermepumpe) gibt es erst, wenn VRM das Geraet kennt
if (!pv.length) {                                                  // sonst Wechselrichter- und Laderegler-Anteil addieren
    var a = norm(rec.vrm_pv_inverter_yield_fc), b = norm(rec.vrm_pv_charger_yield_fc), map = {};
    a.concat(b).forEach(function (x) { map[x[0]] = (map[x[0]] || 0) + x[1]; });
    pv = Object.keys(map).map(Number).sort(function (x, y) { return x - y; }).map(function (t) { return [t, map[t]]; });
}
if (!pv.length) { V.keys = Object.keys(rec).slice(0, 12); return fail('keine PV-Prognose in der Antwort (Felder: ' + V.keys.join(', ') + ')'); }
V.pv = pv; V.cons = norm(rec.vrm_consumption_fc); V.hp = norm(rec.vrm_consum_hp_fc); V.keys = Object.keys(rec).slice(0, 12); V.ts = Date.now(); V.status = 'OK';
global.set('OPT_en', en);
return null;
"""

VRM_SAVE_JS = r"""
// Formular "VRM" (SYSTEM > EINSTELLUNGEN): pruefen und in /data/optimizer/vrm.json speichern (nur fuer den Node-RED-Benutzer lesbar, Modus 0600).
var p = msg.payload || {}, file = '/data/optimizer/vrm.json';
function toast(text, red) { var t = {topic: 'VRM', payload: text}; if (red) { t.highlight = 'red'; } return t; }
var cur = {};
try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* neu */ }
var token = String(p.vrm_token || '').trim(), id = String(p.vrm_id || '').trim();
if (token && !/^[A-Za-z0-9_\-]{20,128}$/.test(token)) { return [null, toast('Der Token hat ein ungültiges Format (20–128 Zeichen, Buchstaben, Ziffern, _ und -). Es wurde nichts gespeichert.', true), null, null]; }
if (!token) { token = cur.token || ''; }                           // leer lassen = vorhandenen Token behalten
if (id === '' && cur.id !== undefined) { id = String(cur.id); }
if (!token) { return [null, toast('Bitte einen VRM-Zugriffstoken eingeben.', true), null, null]; }
if (!/^\d{3,12}$/.test(id)) { return [null, toast('Die Installations-ID ist ungültig (nur Ziffern, z. B. 123456).', true), null, null]; }
try {
    fs.mkdirSync('/data/optimizer', {recursive: true});
    fs.writeFileSync(file, JSON.stringify({token: token, id: id, saved: Date.now()}), {mode: 0o600});
    fs.chmodSync(file, 0o600);
} catch (e) { return [null, toast('Speichern fehlgeschlagen: ' + e.message, true), null, null]; }
flow.set('vrmInfo', {hasToken: true, tokenLen: token.length, id: id});
return [{payload: {vrm_token: '', vrm_id: id}}, toast('Gespeichert. Die Prognose wird jetzt abgerufen.', false), {payload: 'jetzt'},
        {payload: 'Token gespeichert (' + token.length + ' Zeichen) · Installation ' + id + ' · Prognose wird abgerufen …'}];
"""

VRM_LOAD_JS = r"""
// Beim Start: gespeicherte VRM-Zugangsdaten pruefen (nur Status merken) und die Installations-ID ins Formular zurueckschreiben.
var info = {hasToken: false}, fill = {vrm_token: '', vrm_id: ''};
try {
    var j = JSON.parse(fs.readFileSync('/data/optimizer/vrm.json', 'utf8'));
    info = {hasToken: !!j.token, tokenLen: j.token ? String(j.token).length : 0, id: j.id};
    fill.vrm_id = String(j.id);
} catch (e) { /* noch nichts gespeichert */ }
flow.set('vrmInfo', info);
return {payload: fill};
"""

HP_IN_JS = r"""
// Waermepumpen-Werte vom NAS-Broker (NUR LESEN): zusaetzliche HeishaMon-Werte (Pumpe, Leistung, Luefter ...) und alle Quiet-Mode-Befehle
// beobachten. Dieser Tab hat keinen MQTT-Ausgang und schreibt nichts an die Waermepumpe.
var hp = global.get('OPT_hp') || {};
var now = Date.now();
var parts = String(msg.topic || '').split('/');                       // panasonic_heat_pump/<main|extra|commands>/<Name>
var grp = parts[1] || '', name = parts.slice(2).join('/');
var raw = (msg.payload === undefined || msg.payload === null) ? '' : String(msg.payload);
var n = Number(raw), val = (raw !== '' && isFinite(n)) ? n : raw;
var d = new Date(now), pad = function (x) { return (x < 10 ? '0' : '') + x; };
var iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
var month = iso.slice(0, 7), file = '/data/optimizer/quiet-events-' + month + '.csv';
function event(what, change) {
    var head = '';
    try { fs.readFileSync(file, 'utf8'); } catch (e) { head = 'zeit,ereignis,wechsel\n'; }
    return {filename: file, payload: head + iso + ',' + what + ',' + String(change).replace(/,/g, ';') + '\n'};
}
if (grp === 'commands') {
    var WATCH = {SetHeatingControl: 'heizregelung_befehl', SetPumpFlowrateMode: 'pumpenmodus_befehl', SetMaxPumpDuty: 'pumpe_maxduty_befehl', SetQuietModePriority: 'quiet_prioritaet_befehl'};
    if (WATCH[name]) {                                                // Befehle, die Heizregelung (0 Comfort / 1 Efficiency) oder Pumpe veraendern: wer hat sie geschickt?
        var srcW = global.get('MQTT_Source');
        return event(WATCH[name], 'Wert ' + val + ' (Quelle: ' + (srcW === undefined ? 'unbekannt' : String(srcW)) + ')');
    }
    if (name === 'SetQuietMode') {                                    // ein Befehl an die Waermepumpe, von irgendeiner Funktion oder Quelle
        var src = global.get('MQTT_Source');
        hp._lastCmd = {ts: now, v: val, src: src === undefined ? 'unbekannt' : String(src)};
        global.set('OPT_hp', hp);
        return event('quiet_befehl', 'Stufe ' + val + ' (Quelle: ' + hp._lastCmd.src + ')');
    }
    return null;
}
var prev = hp[name];
hp[name] = {v: val, ts: now};
var res = null;
if (name === 'Quiet_Mode_Level' && prev && prev.v !== val) {          // die Stufe hat sich geaendert: mit oder ohne Befehl aus Node-RED?
    var byCmd = hp._lastCmd && now - hp._lastCmd.ts < 15000;
    res = event('quiet_stufe', prev.v + '->' + val + (byCmd ? ' (per Befehl, Quelle: ' + hp._lastCmd.src + ')' : ' (ohne Befehl aus Node-RED: Anlage, Fernbedienung oder HeishaMon)'));
}
if ((name === 'Quiet_Mode_Schedule' || name === 'Quiet_Mode_Priority') && prev && prev.v !== val) { res = event(name === 'Quiet_Mode_Schedule' ? 'quiet_zeitplan' : 'quiet_prioritaet', prev.v + '->' + val); }
var CHG = {Heating_Control: 'heizregelung', Pump_Flowrate_Mode: 'pumpenmodus', Max_Pump_Duty: 'pumpe_maxduty', Heat_Delta: 'spreizung_soll'};   // Aenderung von aussen (Anlage, Fernbedienung, HeishaMon-Seite) erkennen
if (CHG[name] && prev && prev.v !== val) { var srcC = hp._lastCmdAny && now - hp._lastCmdAny.ts < 15000; res = event(CHG[name], prev.v + '->' + val); }
if (name === 'Heating_Control' && (!prev || prev.v !== val)) { hp._hcSince = {ts: now, first: !prev}; }          // seit wann gilt der Modus (first: nur seit Beobachtungsbeginn bekannt)
global.set('OPT_hp', hp);
return res;
"""

KZ_IN_JS = r"""
// Kinderzimmer oben (NUR LESEN): Zustand von Radiator-Relais (Shelly 1 Mini, shelly-radiator) und Heizluefter (Shelly Plug S, elektrisch) vom Venus/Shelly-Broker.
// Die Regelung selbst liegt im Tab Dashboard; dieser Tab schreibt nichts an die Geraete. Ergebnis: global OPT_kz, Aenderungen als Ereignis in quiet-events.
var kz = global.get('OPT_kz') || {};
kz.rad = kz.rad || {}; kz.fan = kz.fan || {};
var now = Date.now(), t = String(msg.topic || ''), raw = msg.payload;
var d = new Date(now), pad = function (x) { return (x < 10 ? '0' : '') + x; };
var iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
var file = '/data/optimizer/quiet-events-' + iso.slice(0, 7) + '.csv';
function event(what, change) {
    var head = '';
    try { fs.readFileSync(file, 'utf8'); } catch (e) { head = 'zeit,ereignis,wechsel\n'; }
    return {filename: file, payload: head + iso + ',' + what + ',' + String(change).replace(/,/g, ';') + '\n'};
}
function bool(v) { v = String(v).trim().toLowerCase(); return (v === 'on' || v === 'true' || v === '1') ? true : ((v === 'off' || v === 'false' || v === '0') ? false : null); }
function txt(b) { return b ? 'an' : 'aus'; }
var res = null;
if (t === 'shelly-radiator/events/rpc') {                                                      // Gen3: NotifyStatus mit switch:0.output nur bei Aenderung (sonst Zaehler)
    var p = raw;
    if (Buffer.isBuffer(p)) { p = p.toString(); }
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
    var sw = p && p.params && p.params['switch:0'];
    if (sw && typeof sw.output === 'boolean') {
        var prevR = kz.rad.on;
        kz.rad.on = sw.output; kz.rad.ts = now; kz.rad.src = sw.source || '';
        if (typeof prevR === 'boolean' && prevR !== sw.output) { res = event('kz_radiator', txt(prevR) + '->' + txt(sw.output) + (sw.source ? ' (Quelle: ' + sw.source + ')' : '')); }
    }
} else if (t === 'shelly-radiator/online') {
    var oR = bool(raw);
    if (oR !== null) { var pO = kz.rad.online; kz.rad.online = oR; kz.rad.onlineTs = now; if (typeof pO === 'boolean' && pO !== oR) { res = event('kz_radiator_online', (pO ? 'online' : 'offline') + '->' + (oR ? 'online' : 'offline')); } }
} else if (t === 'shellies/shellyplug-s-heiz/relay/0') {
    var f0 = bool(raw);
    if (f0 !== null) { var pF = kz.fan.on; kz.fan.on = f0; kz.fan.ts = now; if (typeof pF === 'boolean' && pF !== f0) { res = event('kz_heizluefter', txt(pF) + '->' + txt(f0)); } }
} else if (t === 'shellies/shellyplug-s-heiz/relay/0/power') {
    var w = Number(raw);
    if (isFinite(w)) { kz.fan.w = w; kz.fan.wTs = now; }
} else if (t === 'shellies/shellyplug-s-heiz/online') {
    var oF = bool(raw);
    if (oF !== null) { var pOF = kz.fan.online; kz.fan.online = oF; kz.fan.onlineTs = now; if (typeof pOF === 'boolean' && pOF !== oF) { res = event('kz_heizluefter_online', (pOF ? 'online' : 'offline') + '->' + (oF ? 'online' : 'offline')); } }
}
global.set('OPT_kz', kz);
return res;
"""

QUIET_JS = r"""
// Quiet-Waechter (Shadow): Messung und Anzeige. Schreibt NICHTS an die Waermepumpe (kein MQTT-Ausgang in diesem Tab).
// Seit dem Review-Paket (13.10.2026) ohne eigene Quiet-Empfehlung, Kontrolltest und Eskalationsaktionen: Quiet-Regeln, gemessene Deckel und der
// Heizregelungs-Hinweis kommen aus der Entscheidungsmaschine (OPT_engine). Hier: Kennfeld je Stufe/Band, Abtauzyklen, Laeufe, Schaltpunkte, Minutenprotokoll.
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var Q = cfg.quiet || {};
var now = Date.now(), MS_MIN = 60000;
var G = function (k) { var v; try { v = global.get(k, 'file'); } catch (e) { v = undefined; } return v !== undefined ? v : global.get(k); };       // HeishaMoNR legt Anlagenwerte im Speicher "file" ab (ohne Einrichtung faellt das auf den Standardspeicher zurueck)
function num(v) { if (v === null || v === undefined || v === '') { return null; } v = Number(v); return isFinite(v) ? v : null; }
function ok(v) { return v !== null && v !== undefined && isFinite(v); }
function f(v, d, unit) { if (!ok(v)) { return '–'; } return Number(v).toFixed(d).replace('.', ',') + (unit ? ' ' + unit : ''); }
function sg(v, d, unit) { if (!ok(v)) { return '–'; } var r = Number(Number(v).toFixed(d)); return (r > 0 ? '+' : '') + r.toFixed(d).replace('.', ',') + (unit ? ' ' + unit : ''); }
function qn(v, dflt) { v = num(v); return v === null ? dflt : v; }
function c(v) { return (v === null || v === undefined || !isFinite(v)) ? '' : String(Math.round(v * 100) / 100); }
function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}) : '–'; }
function dur(ms) { var m = Math.round(ms / MS_MIN); return m < 120 ? m + ' min' : (m < 2880 ? (m / 60).toFixed(1).replace('.', ',') + ' h' : (m / 1440).toFixed(1).replace('.', ',') + ' Tage'); }

// ---------- Eingaenge
var HP = G('OPT_hp') || {};
function hpv(name) { var e = HP[name]; return (e && typeof e.v === 'number' && now - e.ts < 10 * MS_MIN) ? e.v : null; }
var solVL = num(G('TOP42_Z1_Water_Target_Temp')), istVL = num(G('TOP6_Main_Outlet_Temp')), istRL = num(G('TOP5_Main_Inlet_Temp'));
var zDelta = num(G('TOP23_Heat_Delta'));                                              // Ziel-Spreizung (Einstellung der Waermepumpe)
var solRL = (solVL !== null && zDelta !== null) ? solVL - zDelta : null;               // abgeleiteter Soll-Ruecklauf
var rlErr = (solRL !== null && istRL !== null) ? solRL - istRL : null;                 // > 0: Ruecklauf liegt unter dem Soll
var spread = (istVL !== null && istRL !== null) ? istVL - istRL : null;
var freqRaw = num(G('compressor_frequency')), freq = freqRaw || 0, running = freq > 0, hpFresh = hpv('Compressor_Freq') !== null;     // hpFresh: HeishaMon meldet noch (mindestens alle 5 min)
var pel = num(G('TOP16_Heat_Energy_Consumption')), flw = num(G('TOP1_Pump_Flow')), cop = num(G('COP_HEAT'));
var pthHs = hpv('Heat_Power_Production_Extra'); if (!running || pthHs === null || pthHs < -100) { pthHs = null; }
var pthCalc = (running && flw !== null && spread !== null) ? flw * spread * 69.7 : null;     // W = l/min * K * 4,18 kJ/(kg K) * 1000 / 60
var pth = pthHs !== null ? pthHs : pthCalc;
var copNow = (running && pel !== null && pel > 100 && pth !== null) ? pth / pel : null;      // Rohwert (Protokollspalte cop_momentan, Kennfeld)
__COPKW__
var pelKNow = pelK(pel, running), copNowK = (running && pel !== null && pel > 100 && pth !== null) ? pth / pelKNow : null;    // korrigiert (Anzeige, Spalte cop_momentan_korr)
var pelQNow = pelQ(pel, running), copQNow = (running && pelQNow !== null && pelQNow > 100 && pth !== null) ? pth / pelQNow : null;   // Anzeige: Zaehler (falls gewaehlt und frisch), sonst wie pelKNow
var qNow = num(G('TOP18_Quiet_Mode_Level'));
var rt = num(G('compressor_runtime')), rtLast = num(G('compressor_last_runtime')), startsToday = num(G('Starts_Today'));
var defrost = num(G('TOP26_Defrosting_State')) === 1, dhw = num(G('TOP20_ThreeWay_Valve_State')) === 1;
var ss = G('F_SS') || {}, ssRamp = ss.state === 1 && Math.abs(num(ss.correction_value) || 0) > 0;
var at = num(G('TOP14_Outside_Temp')), fan1 = num(G('TOP62_Fan1_Motor_Speed'));
var rohrA = (HP.Outside_Pipe_Temp && typeof HP.Outside_Pipe_Temp.v === 'number' && HP.Outside_Pipe_Temp.v > -100) ? HP.Outside_Pipe_Temp.v : null;   // Outside_Pipe_Temp (nur bei Aenderung gemeldet; -128 = kein Fuehler)
var S = G('OPT_state') || {}, sFresh = S.ts && now - S.ts < 5 * MS_MIN;
// Kinderzimmer oben (eigene Regelung im Tab Dashboard, hier nur mitgelesen): Radiator-Relais (Shelly 1 Mini) und Heizluefter (Shelly Plug S, elektrisch)
var KZ = G('OPT_kz') || {}, KZR = KZ.rad || {}, KZF = KZ.fan || {};
var kzRad = typeof KZR.on === 'boolean' ? (KZR.on ? 1 : 0) : '', kzFanOn = typeof KZF.on === 'boolean' ? (KZF.on ? 1 : 0) : '', kzFanW = typeof KZF.w === 'number' ? KZF.w : null;
var kzFanOnline = typeof KZF.online === 'boolean' ? (KZF.online ? 1 : 0) : '';

// ---------- Zustand (ueberlebt Neustarts per Datei)
var qs = flow.get('qs');
if (!qs) {
    qs = {errS: null, errTs: 0, level: null, levelSince: now, lastStart: 0, lastDefrostEnd: 0, lastDhwEnd: 0, freqOn: false, defrost: false, dhw: false,
          lastMin: 0, lastSave: 0, lastLog: 0, runStart: 0, runs: [], kf: {}};
    try {
        var sj = JSON.parse(fs.readFileSync('/data/optimizer/quiet-stats.json', 'utf8'));
        if (sj && sj.kfE) { qs.kfE = sj.kfE; }
        if (sj && sj.kf) { qs.kf = sj.kf; qs.level = sj.level; qs.levelSince = sj.since || now; qs.runs = sj.runs || []; }
    } catch (e) { /* noch keine Datei */ }
    try {                                                                                            // Wechselzeit und Abtau-/Warmwasser-Ende ueberstehen einen Neustart
        var wj = JSON.parse(fs.readFileSync('/data/optimizer/watcher-state.json', 'utf8'));
        if (wj) { qs.esc = {lastChg: wj.lastChg || 0, lastChgWhat: wj.lastChgWhat || ''}; qs.lastDefrostEnd = wj.lastDefrostEnd || 0; qs.lastDhwEnd = wj.lastDhwEnd || 0; if (wj.lastDefrostStart) { qs.lastDefrostStart = wj.lastDefrostStart; } if (wj.dfSR) { qs.dfSR = wj.dfSR; } if (wj.stPrev !== undefined) { qs.stPrev = wj.stPrev; } if (wj.echtStop) { qs.echtStop = wj.echtStop; } }      // eine alte Sperre (blockUntil) gilt nicht mehr
    } catch (e) { /* noch keine Datei */ }
    qs.born = now;
}
var tickDt = qs.tickT ? Math.max(0, Math.min(now - qs.tickT, 3 * MS_MIN)) : 0; qs.tickT = now;               // verstrichene Zeit seit dem letzten Aufruf (mehrere Aufrufe je Minute zaehlen nur die echte Zeit)
if (!qs.kf) { qs.kf = {}; }
if (!qs.kfE) { qs.kfE = {}; }                                                                // Kennfeld bei Efficiency (getrennt, Comfort bleibt unvermischt)                                                                  // Zustand einer frueheren Version (ohne Kennfeld) uebernehmen
if (qNow !== null && qs.level !== qNow) { qs.level = qNow; qs.levelSince = now; }        // Stufe geaendert (von wem auch immer) oder erste Beobachtung
// Kennfeld: je Quiet-Stufe UND Aussentemperaturbereich (damit z. B. Stufe 3 bei 8 C von Stufe 3 bei -5 C getrennt bleibt)
var BANDS = ['< 0 °C', '0–3 °C', '3–7 °C', '7–12 °C', '> 12 °C'];
var band = at === null ? null : (at < 0 ? 0 : (at < 3 ? 1 : (at < 7 ? 2 : (at < 12 ? 3 : 4))));
var hcMode = (HP.Heating_Control && typeof HP.Heating_Control.v === 'number') ? HP.Heating_Control.v : null;       // 0 Comfort, 1 Efficiency
var stat = function (lv) {
    if (band === null) { return {n: 0, starts: 0, defrosts: 0, runMin: 0, dMin: 0, s: {}}; }          // ohne Aussentemperatur nichts zuordnen
    var k = lv + '|' + band, store = hcMode === 1 ? qs.kfE : qs.kf;
    return store[k] = store[k] || {n: 0, starts: 0, defrosts: 0, runMin: 0, dMin: 0, s: {}};
};
var FIELDS = ['hz', 'pel', 'pth', 'cop', 'vl', 'rl', 'svl', 'srl', 'dt', 'flow', 'at', 'fan'];
// Wechsel erkennen: Verdichterstart/-ende, Abtauen, Warmwasser
// abtau-starts 20.10.2026: die Verdichter-Stopps vor und nach jeder Abtauung (4-Wege-Ventil schaltet nur drucklos, Forum 4899279/2917785/3724609) sind weder Laufende
// noch Start. Werte wie in der Entscheidungsmaschine (ENGINE.ABL): Signal binnen 2 min nach einem Stopp ohne Abschaltung ueber den Vorlauf, Neustart binnen 5 min
// nach dem Signalende, Stillstand hoechstens 20 min. Sieht der Waechter keinen Stopp (Stillstand kuerzer als sein Takt), aendert sich nichts.
var ABL = {vorMin: 2, nachMin: 5, maxMin: 20};
function runEnde(t, q) {
    var dm = Math.round((t - qs.runStart) / MS_MIN);
    qs.runs.push([qs.runStart, dm, q]);
    qs.runs = qs.runs.filter(function (r) { return r[0] > now - 24 * 60 * MS_MIN; });
    if (q !== null) { stat(q).runMin += dm; }
    qs.runStart = 0; qs.echtStop = t;
    return dm;
}
if (qs.ablU && (running || now - qs.ablU.t > ABL.vorMin * MS_MIN)) { qs.ablU = null; }
if (qs.ablU && defrost) {                                                                   // Signal kurz nach dem Stopp: der Stopp gehoerte zur Abtauung (zuruecknehmen)
    var ablLr = qs.runs[qs.runs.length - 1];
    if (ablLr && ablLr[0] === qs.ablU.rs) { qs.runs.pop(); var ablSt = qs.ablU.st ? (qs[qs.ablU.st[0]] || {})[qs.ablU.st[1]] : null; if (ablSt) { ablSt.runMin -= qs.ablU.dm; } }
    qs.runStart = qs.ablU.rs; qs.echtStop = qs.ablU.echtVor; qs.ablHalt = {t: qs.ablU.t, q: qs.ablU.q}; qs.ablU = null;
}
if (running && !qs.freqOn) {
    if (qs.ablHalt && qs.runStart && now - qs.ablHalt.t <= ABL.maxMin * MS_MIN) { qs.ablHalt = null; }       // Neustart in oder nach der Abtauung: derselbe Lauf
    else {
        if (qs.ablHalt && qs.runStart) { runEnde(qs.ablHalt.t, qs.ablHalt.q); }
        qs.ablHalt = null; qs.lastStart = now; qs.runStart = now; if (qNow !== null) { stat(qNow).starts++; }
    }
}
if (!running && qs.freqOn && qs.runStart && !qs.ablHalt) {
    if (defrost) { qs.ablHalt = {t: now, q: qNow}; }                                         // Stopp im Abtausignal: kein Laufende
    else {
        var ablRs = qs.runStart, ablEv = qs.echtStop || 0, ablDm = runEnde(now, qNow);
        var ablTh = istVL !== null && solVL !== null && istVL - solVL >= 2.75;               // Abschaltung ueber den Vorlauf (Schwelle wie thermoStoppK): nie zuruecknehmen
        qs.ablU = ablTh ? null : {t: now, rs: ablRs, dm: ablDm, q: qNow, st: (qNow !== null && band !== null) ? [hcMode === 1 ? 'kfE' : 'kf', qNow + '|' + band] : null, echtVor: ablEv};
    }
}
if (!running && qs.ablHalt) {                                                                // Stillstand in der Abtauung: ohne Neustart endete der Lauf mit dem Stopp
    var ablEnde = defrost ? 0 : (qs.defrost ? now : qs.lastDefrostEnd);
    if (now - qs.ablHalt.t > ABL.maxMin * MS_MIN || (ablEnde && ablEnde >= qs.ablHalt.t && now - ablEnde > ABL.nachMin * MS_MIN)) { if (qs.runStart) { runEnde(qs.ablHalt.t, qs.ablHalt.q); } qs.ablHalt = null; }
}
// Starts_Today (HeishaMoNR) zaehlt den Wechsel in und aus dem Abtauen als je einen Start, auch ohne sichtbaren 0-Hz-Wert (Knoten "Log HP data": "läuft (übersprungen)"),
// Panasonic zaehlt zwei Starts je Abtauung (2917785): Anzeige "ohne Abtauen" = Starts - 2 x Abtauungen seit dem letzten Zuruecksetzen von Starts_Today (Home Assistant 4607656)
if (startsToday !== null) { if (qs.stPrev !== undefined && qs.stPrev !== null && startsToday < qs.stPrev) { qs.dfSR = 0; } qs.stPrev = startsToday; }
if (defrost && !qs.defrost) { qs.dfSR = (qs.dfSR || 0) + 1; }
if (defrost && !qs.defrost && qNow !== null) { stat(qNow).defrosts++; }
if (!defrost && qs.defrost) { qs.lastDefrostEnd = now; }
// ---------- Abtauzyklen festhalten (Grundlage fuer die Bewertung Comfort/Efficiency): Beginn, Dauer, Strom, Waerme, Einbruch von Vor-/Ruecklauf, Wiederaufheizzeit
var dfOut = null;
function dfFinish(dfx, rec) {
    var pd = function (x) { return (x < 10 ? '0' : '') + x; }, ds = new Date(dfx.s);
    var iso = ds.getFullYear() + '-' + pd(ds.getMonth() + 1) + '-' + pd(ds.getDate()) + ' ' + pd(ds.getHours()) + ':' + pd(ds.getMinutes()) + ':' + pd(ds.getSeconds());
    var cols = ['zeit', 'dauer_min', 'wiederaufheiz_min', 'aussen', 'feuchte', 'taupunkt', 'quiet', 'heizregelung', 'soll_vl', 'vl_beginn', 'vl_min', 'rl_min', 'strom_kwh', 'waerme_kwh', 'min_seit_letzter_abtauung', 'heizstab_min',
                'ende', 'vl_einbruch_k', 'rohr_aussen_vor', 'rohr_aussen_nach', 'strom_nach_kwh'];   // Paket 2 (15.10.2026, nur angehaengt): Ende des Abtauens, Vorlauf-Einbruch, Outside_Pipe_Temp vor/nach, Strom beim Wiederaufheizen
    var de0 = dfx.end ? new Date(dfx.end) : null, isoE = de0 ? de0.getFullYear() + '-' + pd(de0.getMonth() + 1) + '-' + pd(de0.getDate()) + ' ' + pd(de0.getHours()) + ':' + pd(de0.getMinutes()) + ':' + pd(de0.getSeconds()) : '';
    var line = [iso, Math.round(((dfx.end || now) - dfx.s) / MS_MIN), rec, c(dfx.at), c(dfx.rh), c(dfx.dew), c(dfx.q), c(dfx.hc), c(dfx.sol), c(dfx.vl0), c(dfx.vlMin), c(dfx.rlMin), c(Math.round(dfx.el * 1000) / 1000), c(Math.round(dfx.th * 1000) / 1000), c(dfx.sinceLast), c(Math.round((dfx.hsMs || 0) / MS_MIN)),
                isoE, c(dfx.vlMin !== null && (dfx.vlVor !== undefined ? dfx.vlVor : dfx.vl0) !== null ? (dfx.vlVor !== undefined ? dfx.vlVor : dfx.vl0) - dfx.vlMin : null), c(dfx.rohr0), c(dfx.rohr1), c(Math.round((dfx.elN || 0) * 1000) / 1000)].join(',');
    var f0 = '/data/optimizer/defrost-' + iso.slice(0, 7) + '.csv', hd = cols.join(','), need = true;
    try { var lh = null; String(fs.readFileSync(f0, 'utf8')).split('\n').forEach(function (l) { if (l.indexOf('zeit,') === 0) { lh = l; } }); need = lh !== hd; } catch (e) { need = true; }
    return {filename: f0, payload: (need ? hd + '\n' : '') + line + '\n'};
}
if (defrost && !qs.defrost) {                                                                  // neuer Abtauzyklus (ein noch laufender Erholungs-Eintrag wird vorher abgeschlossen)
    if (qs.df && qs.df.state === 'recover') { dfOut = dfFinish(qs.df, 'unterbrochen'); }
    var W0 = G('OPT_weather') || {}, w0ok = W0.ts && now - W0.ts < 60 * MS_MIN;
    qs.df = {s: now, state: 'defrost', at: at, rh: w0ok ? W0.rh : null, dew: w0ok ? W0.dew : null, q: qNow, hc: hcMode, sol: solVL, vl0: istVL, vlVor: (qs.vlPrev !== undefined && qs.vlPrev !== null) ? qs.vlPrev : istVL, vlMin: istVL, rlMin: istRL, el: 0, th: 0, elN: 0,
             rohr0: (qs.rohrPrev !== undefined && qs.rohrPrev !== null) ? qs.rohrPrev : rohrA, rohr1: null,
             sinceLast: qs.lastDefrostStart ? Math.round((now - qs.lastDefrostStart) / MS_MIN) : null};
    qs.lastDefrostStart = now;
}
if (qs.df) {                                                                                   // Heizstab waehrend Abtauen und Wiederaufheizen (Minuten), Grundlage fuer die Winterauswertung
    var hsI = hpv('Internal_Heater_State'), hsE = hpv('External_Heater_State');
    if ((hsI !== null && hsI > 0) || (hsE !== null && hsE > 0)) { qs.df.hsMs = (qs.df.hsMs || 0) + tickDt; }
}
if (qs.df && qs.df.state === 'defrost') {
    if (defrost) {                                                                             // jede Minute aufsummieren
        qs.df.el += (pel !== null && pel >= 0 ? pel : 0) / 60000;
        var thRaw = hpv('Heat_Power_Production_Extra'); qs.df.th += (thRaw !== null && thRaw > -30000 && thRaw < 30000 ? thRaw : 0) / 60000;
        if (istVL !== null && (qs.df.vlMin === null || istVL < qs.df.vlMin)) { qs.df.vlMin = istVL; }
        if (istRL !== null && (qs.df.rlMin === null || istRL < qs.df.rlMin)) { qs.df.rlMin = istRL; }
    } else { qs.df.state = 'recover'; qs.df.end = now; qs.df.rohr1 = rohrA; }
}
if (qs.df && qs.df.state === 'recover' && !(defrost && !qs.defrost)) {
    var dfRec = Math.round((now - qs.df.end) / MS_MIN);
    if (qs.df.end !== now) { qs.df.elN = (qs.df.elN || 0) + (pel !== null && pel >= 0 ? pel : 0) * tickDt / 3600000000; }       // Strom beim Wiederaufheizen (kWh, Zeit statt Aufrufe)
    if (qs.df.rohr1 === null && rohrA !== null) { qs.df.rohr1 = rohrA; }
    if (istVL !== null && qs.df.sol !== null && istVL >= qs.df.sol - 1) { dfOut = dfFinish(qs.df, dfRec); qs.df = null; }                  // Vorlauf wieder bis 1 K unter Soll
    else if (now - qs.df.end >= 60 * MS_MIN) { dfOut = dfFinish(qs.df, '>60'); qs.df = null; }
    else if (!running) { dfOut = dfFinish(qs.df, 'Verdichter aus'); qs.df = null; }                                                       // Anforderung erfuellt, Verdichter steht
}
if (!dhw && qs.dhw) { qs.lastDhwEnd = now; }
qs.freqOn = running; qs.defrost = defrost; qs.dhw = dhw;
if (!defrost) { qs.vlPrev = istVL; qs.rohrPrev = rohrA; }                                     // Werte vor dem Abtauen (Beginn wird erst in der ersten Abtau-Minute erkannt)
// Statistik je Quiet-Stufe: nur Minuten mit laufendem Verdichter (ohne Abtauen/Warmwasser), einmal pro Minute
var mk = Math.floor(now / MS_MIN);
if (qs.lastMin !== mk) {
    qs.lastMin = mk;
    if (running && !defrost && !dhw && qNow !== null) {
        var st0 = stat(qNow), vals = {hz: freq, pel: pel, pth: pth, cop: copNow, vl: istVL, rl: istRL, svl: solVL, srl: solRL, dt: spread, flow: flw, at: at, fan: fan1};
        st0.n++;
        if (sFresh && S.deficit) { st0.dMin++; }                                   // Minuten mit Komfortdefizit
        FIELDS.forEach(function (k) { if (ok(vals[k])) { var a = st0.s[k] = st0.s[k] || [0, 0]; a[0] += vals[k]; a[1] += 1; } });
        var mxs = st0.mx = st0.mx || {};                                                       // Hoechstwerte: Frequenz jede Minute, Leistung nur im eingeschwungenen Lauf (ab 10 min)
        if (ok(freq) && (mxs.hz === undefined || freq > mxs.hz)) { mxs.hz = freq; }
        if (rt !== null && rt >= 10) { ['pth', 'pel'].forEach(function (k) { if (ok(vals[k]) && (mxs[k] === undefined || vals[k] > mxs[k])) { mxs[k] = vals[k]; } }); }
    }
}
// geglaetteter Ruecklauffehler (Zeitkonstante ~5 min)
if (rlErr !== null) {
    var tau = qn(Q.errTauMin, 5), dtm = qs.errTs ? (now - qs.errTs) / MS_MIN : 0;
    qs.errS = (qs.errS === null || dtm > 30) ? rlErr : qs.errS + (rlErr - qs.errS) * (1 - Math.exp(-dtm / tau));
    qs.errTs = now;
}
// Taktung der letzten 24 h
var runs24 = qs.runs.filter(function (r) { return r[0] > now - 24 * 60 * MS_MIN; });
var meanRun = runs24.length ? runs24.reduce(function (a, r) { return a + r[1]; }, 0) / runs24.length : null;
var rtLastOk = rtLast !== null && !(qs.lastDefrostStart && qs.lastDefrostStart > (qs.echtStop || 0));        // abtau-starts: nach einer Abtauung ist compressor_last_runtime ein Stueck des Laufs, kein Laufende
var startsOhne = startsToday !== null ? Math.max(0, startsToday - 2 * (qs.dfSR || 0)) : null;                  // ohne die zwei Starts je Abtauung
var cycleBad = (rtLastOk && rtLast < qn(Q.minRunMin, 20)) || (startsOhne !== null && startsOhne > qn(Q.maxStartsDay, 24));      // kurze Laeufe oder viele Starts

// ---------- Quellen der Quiet-Stufe (damit nichts unbemerkt gegen einen Regler arbeitet)
var mq = G('MQTT') || {}, sol = G('F_SOLAR') || {};
var srcs = ['HeishaMoNR-Quiet-Logik ' + ((ss.state === 1 && ss.QM_state === 1) ? 'AN (Stufe ' + ss.QM_active_level + ')' : 'aus'),
            'Scheduler ' + (mq.allow_scheduler === 1 ? 'darf senden' : 'aus'), 'Solar ' + (sol.state === 1 ? 'AN' : 'aus'),
            'WP-Zeitplan ' + (HP.Quiet_Mode_Schedule && HP.Quiet_Mode_Schedule.v === 1 ? 'AN' : 'aus')];
var prio = HP.Quiet_Mode_Priority ? HP.Quiet_Mode_Priority.v : null;
var lastCmd = HP._lastCmd;

// ---------- Review-Paket 13.10.2026: keine eigene Quiet-Empfehlung (sie lautete fast immer Stufe 3), kein Kontrolltest Quiet 3 -> 2, keine Eskalationsaktionen und
// keine angenommenen Deckel (35/45 Hz) mehr. Quiet-Regeln, gemessene Deckel und der Heizregelungs-Hinweis kommen aus der Entscheidungsmaschine (OPT_engine):
// eine Wahrheit, keine doppelte Logik. Dieser Knoten misst (Kennfeld, Abtauzyklen, Laeufe, Schaltpunkte) und zeigt an.
var EN = global.get('OPT_engine') || null, enFresh = !!(EN && EN.ts && now - EN.ts < 5 * MS_MIN);
var QR = {quiet_freigabe: 'Quiet-Freigabe', quiet_strecken: 'Deckel/Laufzeit'}, QST = {vorschlag: 'Vorschlag', hinweis: 'Hinweis', wartet: 'wartet', gesperrt: 'gesperrt', bereit: 'prüft', inaktiv: 'ruht', abgelaufen: 'abgelaufen'};
var qRules = '–', qRulesCls = '';
if (enFresh && Array.isArray(EN.rules)) {
    qRules = EN.rules.filter(function (r) { return QR[r.id]; }).map(function (r) {
        var p = EN.prop && EN.prop.rule === r.id ? EN.prop : null;
        return QR[r.id] + ': ' + (QST[r.st] || r.st) + (p && p.was ? ' (' + p.was + ')' : '');
    }).join(' · ') || '–';
    if (EN.prop && QR[EN.prop.rule]) { qRulesCls = 'warn'; }
} else { qRules = 'Entscheidungsmaschine ohne aktuelle Daten'; qRulesCls = 'warn'; }
var dk = enFresh && EN.deckel && EN.deckel.q === qNow ? EN.deckel : null;
var deckelTxt = dk && ok(dk.hz) ? (qNow === 0 ? 'kein Deckel (16–59 Hz)' : 'Deckel ' + f(dk.hz, 0, 'Hz') + ' (' + (dk.quelle || '?') + ')') : '';
// ---------- Heizregelung (Comfort / Efficiency): Hinweis der Maschine (nur Anzeige, schaltet NICHTS). Neue Bedingung: Efficiency, Lauf >= 10 min, Aussen unter
// Heizstab-Einschaltgrenze + Abstand (1 K Hysterese) und Vorlauf an der Heizstab-Schwelle; an nach 3 min, aus 10 min danach. Kein Flackern an der 5-°C-Grenze, kein Hinweis bei normalen Kaltstarts.
var hcE = enFresh && EN.hc ? EN.hc : null;
var hcReco = hcE ? {text: hcE.text, cls: hcE.warn ? 'warn' : (hcE.mode === 1 ? 'ok' : ''), mode: hcE.mode, warn: hcE.warn === true}
                 : {text: hcMode === 0 ? 'Comfort' : (hcMode === 1 ? 'Efficiency · keine Warnung (Maschine ohne aktuelle Daten)' : '–'), cls: '', mode: hcMode, warn: false};
global.set('OPT_hc_reco', {ts: now, mode: hcReco.mode, warn: hcReco.warn, text: hcReco.text});
var hcEvent = null;                                                                                   // Wechsel des Hinweises als Ereignis festhalten
var hcKey = hcReco.mode === 1 ? (hcReco.warn ? 'warn' : 'ok') : 'aus';
if (qs.hcKey !== undefined && qs.hcKey !== hcKey && hcReco.mode === 1) { hcEvent = hcKey === 'warn' ? 'ok->Comfort empfohlen (' + hcReco.text.replace(/^Efficiency · Comfort empfohlen: /, '').replace(/(\d),(\d)/g, '$1.$2').replace(/,/g, ';') + ')' : 'Comfort empfohlen->keine Warnung'; }
qs.hcKey = hcKey;
delete qs.testOpen; delete qs.inWin; delete qs.target; delete qs.vlBadSince;                           // Reste der gestrichenen Empfehlung / des Kontrolltests

// ---------- Laufmessung (frueher Teil des Eskalationswaechters; nur Messung, keine Aktion, keine Sperre): Sollvorlauf erreicht, Lauf zu Ende,
// Stopp kurz nach einem Wechsel von Heizregelung oder Quiet (mit gemessenem Ueberschwingen). Zeitmessung ueber Startzeitpunkte, Wechselzeit neustartfest (watcher-state.json).
var escEvents = [], escTxt = '–', escCls = '', escRunMin = null, escDev = null;
var ES = qs.esc = qs.esc || {};
var ESD = {runKey: 0, prevRt: null, obsStart: 0, late: false, reached: null, reachSince: 0, reachSinceMin: 0, lastChg: 0, lastChgWhat: '', hcPrev: null, qPrev: null, devHist: [], runHc: null, runQ: null, saved: ''};
Object.keys(ESD).forEach(function (k) { if (ES[k] === undefined) { ES[k] = ESD[k]; } });
['capSince', 'cappedAt', 'pDefiSince', 'pTrigSince', 'dropSince', 'defiSince', 'htrSince', 'trigSince', 'nearStop', 'blockUntil', 'keyCand', 'keySince', 'keyShown'].forEach(function (k) { delete ES[k]; });
var escBand = qn(Q.escReachBandK, 1), escLock = qn(Q.escStartLockMin, 15), escTakt = qn(Q.escTaktMin, 30);
var escDataOk = freqRaw !== null && hpFresh;                                                         // Verdichterwert vorhanden und HeishaMon meldet noch
var chgTxt = function (a0, b0) { if (a0 === null || a0 === undefined) { return b0 === null ? '?' : String(b0); } return (b0 === null || a0 === b0) ? String(a0) : a0 + '→' + b0; };
function escRunEnd() {                                                                              // Lauf ist zu Ende (Stillstand beobachtet oder Laufzeit-Sprung): Zusammenfassung
    var obs = Math.round((now - ES.obsStart) / MS_MIN);
    escEvents.push(['lauf_ende', (ES.late ? 'beobachtet ' + obs + ' min (Beginn unbekannt)' : 'Lauf ' + Math.round(ES.prevRt || obs) + ' min') + ' · Sollvorlauf ' + (ES.reached !== null ? (ES.late ? 'erreicht (Zeit unbekannt)' : 'erreicht nach ' + ES.reached + ' min') : 'nicht erreicht')
                    + ' · Heizregelung ' + chgTxt(ES.runHc, hcMode) + ' · Quiet ' + chgTxt(ES.runQ, qNow)]);
    var ovs = -99; ES.devHist.forEach(function (e) { if (now - e[0] <= 6 * MS_MIN && e[1] > ovs) { ovs = e[1]; } });
    if (ES.lastChg && ES.lastChg >= ES.runKey && now - ES.lastChg <= escTakt * MS_MIN) {            // Wechsel im Lauf und der Verdichter geht bald danach aus: nur festhalten
        escEvents.push(['stopp_nach_wechsel', 'Verdichter ' + Math.round((now - ES.lastChg) / MS_MIN) + ' min nach ' + (ES.lastChgWhat || 'einem Wechsel') + ' aus · Überschwingen höchstens ' + (ovs > -99 ? (ovs >= 0 ? '+' : '') + ovs.toFixed(1) + ' K' : '–') + ' über Soll']);
    }
}
if (escDataOk) {                                                                                     // Wechsel von Heizregelung oder Quiet (von wem auch immer) merken
    if (ES.hcPrev !== null && hcMode !== null && ES.hcPrev !== hcMode) { ES.lastChg = now; ES.lastChgWhat = 'Heizregelung ' + ES.hcPrev + '→' + hcMode; }
    if (ES.qPrev !== null && qNow !== null && ES.qPrev !== qNow) { ES.lastChg = now; ES.lastChgWhat = 'Quiet ' + ES.qPrev + '→' + qNow; }
    if (hcMode !== null) { ES.hcPrev = hcMode; } if (qNow !== null) { ES.qPrev = qNow; }
}
if (!escDataOk) {
    escCls = 'warn'; escTxt = 'Daten fehlen oder sind veraltet (' + (freqRaw === null ? 'Verdichterwert fehlt' : 'HeishaMon meldet nicht') + ')';
} else if (!running) {
    if (ES.runKey !== 0) { escRunEnd(); }
    qs.sawStop = true;
    ES.runKey = 0; ES.prevRt = null; ES.reached = null; ES.late = false; ES.devHist = []; ES.reachSince = 0;
    escTxt = 'Verdichter steht' + (qs.swStop ? ' seit ' + dur(now - qs.swStop) : '');
} else {
    var rtNow = rt;
    if (!ES.late && ES.runKey !== 0 && rtNow !== null && ES.prevRt !== null && rtNow < ES.prevRt - 1.5) { escRunEnd(); ES.runKey = 0; }                      // Stopp und Neustart zwischen zwei Aufrufen
    if (ES.runKey === 0) {
        ES.runKey = now; ES.obsStart = now; ES.late = !qs.sawStop;                                   // spaet: Lauf war beim ersten Hinsehen schon im Gang (Neustart/Deploy), Beginn unbekannt
        ES.reached = null; ES.devHist = []; ES.runHc = hcMode; ES.runQ = qNow; ES.reachSince = 0;
    }
    ES.prevRt = rtNow;
    escRunMin = ES.late ? (now - ES.obsStart) / MS_MIN : (rtNow !== null ? rtNow : (now - ES.runKey) / MS_MIN);
    escDev = (solVL !== null && istVL !== null) ? istVL - solVL : null;                               // > 0: Vorlauf ueber Soll
    if (escDev !== null) { ES.devHist.push([now, escDev]); ES.devHist = ES.devHist.filter(function (e) { return now - e[0] <= 8 * MS_MIN; }); }
    var escDef = defrost || now - qs.lastDefrostEnd < qn(Q.afterDefrostMin, 10) * MS_MIN, escDhw = dhw || now - qs.lastDhwEnd < qn(Q.afterDhwMin, 10) * MS_MIN;
    // Sollvorlauf erreicht: mindestens 3 min am Stueck, nicht in der Startphase, nicht durch Abtau-/Warmwasserwaerme
    if (!escDef && !escDhw && escDev !== null && escDev >= -escBand) {
        if (!ES.reachSince) { ES.reachSince = now; ES.reachSinceMin = escRunMin; }
        if (ES.reached === null && now - ES.reachSince >= 3 * MS_MIN && escRunMin >= escLock) {
            ES.reached = Math.max(0, Math.round(ES.reachSinceMin));
            escEvents.push(['sollvorlauf_erreicht', (ES.late ? 'Zeit unbekannt (Lauf war beim Beobachtungsbeginn schon im Gang)' : 'nach ' + ES.reached + ' min') + ' · Heizregelung ' + (hcMode === null ? '?' : hcMode) + ' · Quiet ' + (qNow === null ? '?' : qNow) + ' · Außen ' + (at === null ? '?' : at) + ' °C · Soll ' + f(solVL, 0)]);
        }
    } else if (escDef || escDhw || escDev === null || escDev < -escBand - 0.5) { ES.reachSince = 0; }
    escTxt = 'läuft ' + Math.round(escRunMin) + ' min' + (ES.late ? ' (Beginn unbekannt)' : '') + ' · Vorlauf ' + (escDev !== null ? sg(escDev, 1, 'K') + ' zum Soll' : '–') + ' · ' + (ES.reached !== null ? (ES.late ? 'Sollvorlauf erreicht' : 'Sollvorlauf erreicht nach ' + ES.reached + ' min') : 'Sollvorlauf noch nicht erreicht');
}
var escSave = JSON.stringify({lastChg: ES.lastChg, lastChgWhat: ES.lastChgWhat, lastDefrostEnd: qs.lastDefrostEnd, lastDhwEnd: qs.lastDhwEnd, lastDefrostStart: qs.lastDefrostStart || 0, dfSR: qs.dfSR || 0, stPrev: qs.stPrev === undefined ? null : qs.stPrev, echtStop: qs.echtStop || 0});   // Paket 2: Beginn der letzten Abtauung (Abstand im Abtau-Protokoll nach einem Neustart)
if (escSave !== ES.saved) { try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync('/data/optimizer/watcher-state.json', escSave); ES.saved = escSave; } catch (e) { /* kein Zugriff */ } }

var rows = [
    ['Soll-VL (Heizkurve)', f(solVL, 1, '°C'), ''],
    ['Ist-VL', f(istVL, 1, '°C'), ''],
    ['Soll-RL (Soll-VL − Ziel-Spreizung ' + f(zDelta, 0) + ' K)', f(solRL, 1, '°C'), ''],
    ['Ist-RL', f(istRL, 1, '°C'), ''],
    ['Rücklauffehler (Soll-RL − Ist-RL)', rlErr !== null ? sg(rlErr, 1, 'K') + (rlErr >= 0 ? ' (RL unter Soll)' : ' (RL über Soll)') : '–', ''],
    ['Spreizung Ist / Ziel', f(spread, 1) + ' / ' + f(zDelta, 1, 'K'), ''],
    ['Verdichter', running ? f(freq, 0, 'Hz') + ' · seit ' + Math.round(rt || 0) + ' min' : 'steht (letzter Lauf ' + f(rtLast, 0, 'min') + ')', ''],
    ['Leistung elektrisch', f(pelQNow, 0, 'W'), '', ZQ.aktiv ? 'Zähler (Shelly) · TOP16 ' + f(pel, 0, 'W') + ', ' + KORR_TXT + ' ' + f(pelKNow, 0, 'W') : (running ? ZQ_TXT + ' (TOP16 ' + f(pel, 0, 'W') + ')' : 'Stillstand: TOP16 roh' + (ZQ.gewaehlt ? ' · ' + ZQ_TXT : ''))],
    ['Leistung thermisch', pth !== null ? f(pth, 0, 'W') + (pthHs !== null ? ' (HeishaMon)' : ' (berechnet)') : '–', ''],
    ['COP', copQNow !== null ? f(copQNow, 1) : '–', '', 'Wärme ÷ Strom, Strom ' + ZQ_TXT + (copNow !== null ? ' (roh ' + f(copNow, 1) + (ZQ.aktiv && copNowK !== null ? ', ' + KORR_TXT + ' ' + f(copNowK, 1) : '') + ')' : '')],
    ['Flow · Pumpe (nur Beobachtung)', f(flw, 1, 'l/min') + ' · ' + (HP.Pump_Duty ? f(HP.Pump_Duty.v, 0) : '–') + ' / ' + (HP.Pump_Speed ? f(HP.Pump_Speed.v, 0, 'U/min') : '–'), ''],
    ['Kinderzimmer oben', 'Radiator ' + (kzRad === '' ? '–' : (kzRad ? 'an' : 'aus')) + ' · Heizlüfter ' + (kzFanOnline === 0 ? 'offline' : (kzFanOn === '' ? '–' : (kzFanOn ? 'an' + (kzFanW !== null ? ' (' + f(kzFanW, 0, 'W') + ')' : '') : 'aus'))), ''],
    ['Taktung', 'heute ' + f(startsToday, 0) + ' Starts' + (qs.dfSR ? ' (ohne Abtauen ' + f(startsOhne, 0) + ', ' + qs.dfSR + ' Abtauungen × 2)' : '') + ' · Ø Lauf 24 h ' + (meanRun !== null ? f(meanRun, 0, 'min') : '–') + ' (' + runs24.length + ')', cycleBad ? 'warn' : ''],
    ['Quiet aktuell', qNow !== null ? 'Stufe ' + qNow + ' seit ' + dur(now - qs.levelSince) + (deckelTxt ? ' · ' + deckelTxt : '') + (prio !== null ? ' · Priorität ' + (prio === 1 ? 'Leistung' : 'Lautstärke') : '') : '–', ''],
    ['Quiet-Regeln (Entscheidungsmaschine)', qRules, qRulesCls],
    ['Heizregelung', hcReco.text, hcReco.cls],
    ['Lauf (Messung)', escTxt, escCls],
    ['Quellen der Stufe', srcs.join(' · ') + (lastCmd ? ' · letzter Befehl ' + hhmm(lastCmd.ts) : ' · kein Befehl beobachtet'), '']
];
var tab = [];
var statRow = function (label, bn, s) {
    var m = function (k, d) { var a = s.s[k]; return a && a[1] ? f(a[0] / a[1], d) : '–'; };
    var mxv = function (k) { return s.mx && ok(s.mx[k]) ? f(s.mx[k], 0) : '–'; };
    // Strom und COP mit Korrektur (nur Laufminuten im Kennfeld: je Minute + COP_KW); COP = Ø Waerme ÷ Ø Strom (korrigiert), aus den gespeicherten Rohsummen gerechnet
    var pe = s.s.pel && s.s.pel[1] ? s.s.pel[0] / s.s.pel[1] + COP_KW : null, pt = s.s.pth && s.s.pth[1] ? s.s.pth[0] / s.s.pth[1] : null;
    return [label, bn, f(s.n, 0), m('hz', 0), m('fan', 0), f(pe, 0), m('pth', 0), mxv('hz'), mxv('pth'), (pe !== null && pt !== null && pe > 0) ? f(pt / pe, 1) : '–', m('vl', 1) + ' / ' + m('rl', 1) + ' / ' + m('dt', 1),
            m('svl', 1) + ' / ' + m('srl', 1), m('flow', 1), s.n ? f(s.starts / (s.n / 60), 2) : '–', s.starts ? f(s.runMin / s.starts, 0) : '–', f(s.defrosts, 0), s.n ? f(100 * s.dMin / s.n, 0) + ' %' : '–'];
};
[0, 1, 2, 3].forEach(function (lv) {
    var any = false;
    BANDS.forEach(function (bn, bi) {
        var s = qs.kf[lv + '|' + bi];
        if (!s || !(s.n || s.starts)) { return; }
        any = true;
        tab.push(statRow('Stufe ' + lv, bn, s));
    });
    if (!any) { tab.push(['Stufe ' + lv, 'keine Daten', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–']); }
});
[0, 1, 2, 3].forEach(function (lv) {                                                               // Messwerte bei Efficiency stehen getrennt darunter
    BANDS.forEach(function (bn, bi) { var s = qs.kfE[lv + '|' + bi]; if (s && (s.n || s.starts)) { tab.push(statRow('Stufe ' + lv + ' (Efficiency)', bn, s)); } });
});

// ---------- Protokoll: jede Minute (auch im Stillstand, damit Pumpenspuelungen und Neustarts sichtbar sind); Statistik alle 10 min sichern
var month = new Date(now).getFullYear() + '-' + ('0' + (new Date(now).getMonth() + 1)).slice(-2);
// ---------- Ereignisliste fuer die Karte: die letzten relevanten Eintraege aus quiet-events (neueste zuerst), dazu die Ereignisse dieser Minute (stehen noch nicht in der Datei)
var EVSHOW = {sollvorlauf_erreicht: ['Sollvorlauf erreicht', 'ok'], lauf_ende: ['Lauf zu Ende', ''], stopp_nach_wechsel: ['Stopp nach Wechsel', ''],     // Waechter-Ereignisse (eskalation_schatten, takt_nach_wechsel) seit dem Review-Paket gestrichen
              heizregelung_befehl: ['Heizregelung-Befehl', ''], quiet_befehl: ['Quiet-Befehl', ''], quiet_stufe: ['Quiet-Stufe', ''], pumpenmodus_befehl: ['Pumpenmodus-Befehl', ''], quiet_prioritaet_befehl: ['Quiet-Priorität-Befehl', '']};
var evList = [];
function evTime(z) { return z.slice(8, 10) + '.' + z.slice(5, 7) + '. ' + z.slice(11, 16); }
var pmD = new Date(new Date(now).getFullYear(), new Date(now).getMonth() - 1, 1), prevMonth = pmD.getFullYear() + '-' + ('0' + (pmD.getMonth() + 1)).slice(-2);
[prevMonth, month].forEach(function (mo) {                                                          // Vormonat zuerst, damit die Liste am Monatsersten nicht leer ist
    try {
        String(fs.readFileSync('/data/optimizer/quiet-events-' + mo + '.csv', 'utf8')).split('\n').slice(-600).forEach(function (l) {
            var i1 = l.indexOf(','), i2 = i1 < 0 ? -1 : l.indexOf(',', i1 + 1);
            if (i2 < 0 || l.indexOf('zeit,') === 0) { return; }
            var wh = l.slice(i1 + 1, i2);
            if (EVSHOW[wh]) { evList.push([evTime(l.slice(0, i1)), EVSHOW[wh][0], l.slice(i2 + 1), EVSHOW[wh][1]]); }
        });
    } catch (e) { /* noch keine Ereignisdatei */ }
});
var isoNow = month + '-' + ('0' + new Date(now).getDate()).slice(-2) + ' ' + ('0' + new Date(now).getHours()).slice(-2) + ':' + ('0' + new Date(now).getMinutes()).slice(-2);
escEvents.forEach(function (e) { if (EVSHOW[e[0]]) { evList.push([evTime(isoNow), EVSHOW[e[0]][0], String(e[1]).replace(/,/g, ';'), EVSHOW[e[0]][1]]); } });
evList = evList.slice(-10).reverse();
var out = [{payload: {rows: rows, events: evList}}, {payload: {stats: tab, korr: KORR_TXT}}, null, null, dfOut];
if (hcEvent) {
    var hd0 = new Date(now), hp0 = function (x) { return (x < 10 ? '0' : '') + x; };
    var hIso = hd0.getFullYear() + '-' + hp0(hd0.getMonth() + 1) + '-' + hp0(hd0.getDate()) + ' ' + hp0(hd0.getHours()) + ':' + hp0(hd0.getMinutes()) + ':' + hp0(hd0.getSeconds());
    var hFile = '/data/optimizer/quiet-events-' + hIso.slice(0, 7) + '.csv', hHead = '';
    if (!(out[3] && out[3].filename === hFile)) { try { fs.readFileSync(hFile, 'utf8'); } catch (e) { hHead = 'zeit,ereignis,wechsel\n'; } }
    out[3] = {filename: hFile, payload: (out[3] && out[3].filename === hFile ? out[3].payload : hHead) + hIso + ',heizregelung_empfehlung,' + hcEvent + '\n'};
}
// Schaltpunkte und Sollspruenge (Grundlage, um Ein-/Ausschaltregel der Anlage aus den Daten zu pruefen, ohne einzugreifen)
var pumpRpmNow = hpv('Pump_Speed'), relNow = (istVL !== null && solVL !== null) ? istVL - solVL : null;
var zustandNow = running ? 'lauf' : (pumpRpmNow === null ? '' : (pumpRpmNow >= 1000 ? 'pause' : 'heizgrenze'));       // pause: Thermo-Aus mit laufender Pumpe; heizgrenze: Pumpe steht (Spuelung mit 4300 U/min zaehlt kurz als pause)
var shiftHpNow = num(G('TOP27_Z1_Heat_Request_Temp'));
function fdot(v, d) { return ok(v) ? Number(v).toFixed(d) : '?'; }                         // Ereignisse sind CSV: Punkt als Dezimaltrenner, keine Kommas
function sdot(v, d) { return ok(v) ? (v > 0 ? '+' : '') + Number(v).toFixed(d) : '?'; }
if (hpFresh) {
    if (qs.swInit) {
        if (running && !qs.swRun) { escEvents.push(['verdichter_start', 'Pause ' + (qs.swStop ? Math.round((now - qs.swStop) / MS_MIN) : '?') + ' min · Vorlauf ' + sdot(qs.swRel, 2) + ' K zum Soll ' + fdot(qs.swSoll, 0) + ' °C · Außen ' + fdot(at, 0) + ' °C · Pumpe ' + fdot(qs.swPump, 0) + ' U/min']); qs.swStart = now; }
        if (!running && qs.swRun) { escEvents.push(['verdichter_stopp', 'Lauf ' + (qs.swStart ? Math.round((now - qs.swStart) / MS_MIN) : '?') + ' min · Vorlauf ' + sdot(qs.swRel, 2) + ' K zum Soll ' + fdot(qs.swSoll, 0) + ' °C · Außen ' + fdot(at, 0) + ' °C']); qs.swStop = now; }
        if (solVL !== null && qs.swSoll !== null && qs.swSoll !== undefined && solVL !== qs.swSoll) {
            escEvents.push(['sollsprung', (running ? 'Lauf' : (zustandNow === 'heizgrenze' ? 'Heizgrenze' : 'Pause')) + ' ' + fdot(qs.swSoll, 0) + '->' + fdot(solVL, 0) + ' °C · Vorlauf ' + fdot(istVL, 2) + ' (' + sdot(relNow, 2) + ' K zum neuen Soll) · Außen ' + fdot(at, 0) + ' °C · Anlagenverschiebung ' + fdot(shiftHpNow, 0) + ' K']);
        }
    }
    qs.swInit = true; qs.swRun = running;
    if (relNow !== null) { qs.swRel = relNow; }
    if (solVL !== null) { qs.swSoll = solVL; }
    qs.swPump = pumpRpmNow;
}
if (escEvents.length) {
    var ed0 = new Date(now), ep0 = function (x) { return (x < 10 ? '0' : '') + x; };
    var eIso = ed0.getFullYear() + '-' + ep0(ed0.getMonth() + 1) + '-' + ep0(ed0.getDate()) + ' ' + ep0(ed0.getHours()) + ':' + ep0(ed0.getMinutes()) + ':' + ep0(ed0.getSeconds());
    var eFile = '/data/optimizer/quiet-events-' + eIso.slice(0, 7) + '.csv', eHead = '';
    var eTxt = escEvents.map(function (e) { return eIso + ',' + e[0] + ',' + String(e[1]).replace(/,/g, ';') + '\n'; }).join('');
    if (out[3] && out[3].filename === eFile) { out[3].payload += eTxt; }
    else { try { fs.readFileSync(eFile, 'utf8'); } catch (e) { eHead = 'zeit,ereignis,wechsel\n'; } out[3] = {filename: eFile, payload: eHead + eTxt}; }
}
if (!qs.lastLog || now - qs.lastLog >= MS_MIN - 1000) {
    var d = new Date(now), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var iso = month + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    var cols = ['zeit', 'quiet_aktuell', 'quiet_ziel_normal', 'quiet_ziel_prioritaet', 'quiet_naechster_normal', 'quiet_naechster_prioritaet', 'quiet_grund', 'quiet_sperre', 'haltezeit_rest_min', 'soll_vl', 'ist_vl', 'soll_rl', 'ist_rl', 'rl_fehler', 'rl_fehler_gegl',
                'spreizung_ist', 'spreizung_ziel', 'verdichter_hz', 'leistung_el_w', 'leistung_th_heisha_w', 'leistung_th_berechnet_w', 'cop_momentan', 'flow_l_min', 'pumpe_duty', 'pumpe_speed',
                'pumpe_max_duty', 'fan1', 'fan2', 'verdichter_strom', 'aussen', 'verdichter_laufzeit_min', 'letzte_laufzeit_min', 'starts_heute', 'lauf_mittel_24h_min', 'defrost', 'warmwasser', 'softstart',
                'raum_defizit', 'raum_defizit_name', 'raum_trend', 'waermeverteilung', 'quiet_prioritaet', 'taktung_kritisch', 'quiet_aussen_regel', 'test_moeglich', 'heizregelung', 'pumpenmodus',
                'heizstab_intern', 'heizstab_extern', 'heizstab_raum_frei', 'heizstab_stunden', 'heizstab_start_delta', 'heizstab_verzoegerung_min',
                'waechter_zustand', 'waechter_ausloeser', 'waechter_sperre', 'zeit_bis_soll_min', 'lauf_min', 'vl_minus_soll',
                'zustand', 'shift_anlage', 'kz_radiator_an', 'kz_heizluefter_an', 'kz_heizluefter_w', 'kz_heizluefter_online',
                'leistung_el_korr_w', 'cop_momentan_korr', 'cop_korr_w', 'rohr_aussen',          // 14.10.2026 (nur angehaengt): Strom/COP mit Korrektur und ihre Konstante; Outside_Pipe_Temp fuer die Abtau-Kennzahl des Beobachters
                'heizstab_stop_delta', 'verdampfer_aus', 'heissgas', 'hochdruck', 'expansionsventil', 'rohr_innen',
                'druck_bar', 'zaehler_wp_w', 'zaehler_heizstab_w'];   // cop-ziel 17.10.2026 (nur angehaengt): Stromzaehler Shelly (Waermepumpe ohne Heizstab, Heizstab), leer ohne frischen Zaehler; Winterpaket 16.10.2026 (nur angehaengt): Water_Pressure; der Sensor zaehlt bei laufender Pumpe den Foerderdruck mit (~0,5 bar bei 4250 U/min), statisch nur bei Pumpe 0 (pumpe_speed) gueltig – Auswertung spaeter (Beobachter/Kennzahlen); Paket 2 (15.10.2026, nur angehaengt): Heater_Stop_Delta (TOP98), Eva_Outlet_Temp, Discharge_Temp, High_Pressure, Expansion_Valve, Inside_Pipe_Temp (Winter: Verdampfer/Ueberhitzung, Forum Expansionsventil)
    var hv = function (n) { return HP[n] && typeof HP[n].v === 'number' ? HP[n].v : null; };
    // Review-Paket 13.10.2026: Spalten der gestrichenen Quiet-Empfehlung, des Kontrolltests und des Eskalationswaechters bleiben im Kopf (Leser nach Spaltenname), Werte leer
    var vals2 = [iso, qNow, '', '', '', '', '', '', '', c(solVL), c(istVL), c(solRL), c(istRL), c(rlErr), c(qs.errS),
                 c(spread), c(zDelta), c(freq), c(pel), c(pthHs), c(pthCalc), c(copNow), c(flw), c(hv('Pump_Duty')), c(hv('Pump_Speed')), c(hv('Max_Pump_Duty')), c(fan1), c(hv('Fan2_Motor_Speed')),
                 c(hv('Compressor_Current')), c(at), c(rt), c(rtLast), c(startsToday), c(meanRun), defrost ? 1 : 0, dhw ? 1 : 0, ssRamp ? 1 : 0,
                 sFresh ? (S.deficit ? 1 : 0) : '', sFresh ? String(S.deficitRoom || '').replace(/,/g, ';') : '', sFresh ? c(S.coldTrend) : '', sFresh ? (S.distrib ? 1 : 0) : '', prio === null ? '' : prio, cycleBad ? 1 : 0, '', '', c(hv('Heating_Control')), c(hv('Pump_Flowrate_Mode')),
                 c(hv('Internal_Heater_State')), c(hv('External_Heater_State')), c(hv('Room_Heater_State')), c(hv('Room_Heater_Operations_Hours')), c(hv('Heater_Start_Delta')), c(hv('Heater_Delay_Time')),
                 '', '', '', (ES.reached !== null && !ES.late) ? c(ES.reached) : '', escRunMin !== null ? c(Math.round(escRunMin)) : '', c(escDev),
                 zustandNow, c(shiftHpNow), kzRad, kzFanOn, c(kzFanW), kzFanOnline,
                 c(pelKNow), c(copNowK), COP_KW, c(hv('Outside_Pipe_Temp')),
                 c(hv('Heater_Stop_Delta')), c(hv('Eva_Outlet_Temp')), c(hv('Discharge_Temp')), c(hv('High_Pressure')), c(hv('Expansion_Valve')), c(hv('Inside_Pipe_Temp')),
                 c(hv('Water_Pressure')), c(ZQ.w), c(ZQ.hs)];
    var file = '/data/optimizer/quiet-' + month + '.csv', head = cols.join(',');
    var needHead = true;
    if (flow.get('qHead') === month + '|' + head) { needHead = false; }
    else {
        flow.set('qHead', month + '|' + head);
        try { var lastH = null; String(fs.readFileSync(file, 'utf8')).split('\n').forEach(function (l) { if (l.indexOf('zeit,') === 0) { lastH = l; } }); needHead = lastH !== head; } catch (e) { needHead = true; }
    }
    out[2] = {filename: file, payload: (needHead ? head + '\n' : '') + vals2.join(',') + '\n'};
    qs.lastLog = now;
}
if (!qs.lastSave || now - qs.lastSave >= 10 * MS_MIN) {
    try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync('/data/optimizer/quiet-stats.json', JSON.stringify({kf: qs.kf, kfE: qs.kfE, level: qs.level, since: qs.levelSince, runs: qs.runs})); qs.lastSave = now; } catch (e) { /* kein Zugriff */ }
}
flow.set('qs', qs);
return out;
"""

PLAN_JS = r"""// Waermefahrplan (Shadow) = Bedarfs-/COP-Vorschau fuer die naechsten 24 h in 15-Minuten-Slots: Waermebedarf aus dem Gebaeudemodell, COP aus der Messung,
// Strom je Slot. Seit dem Review-Paket (13.10.2026) ohne Verteilung nach Tarif und ohne Empfehlungen. Schreibt NICHTS an die Waermepumpe (kein MQTT-Ausgang).
// Es werden nur Informationen benutzt, die zum Planungszeitpunkt vorlagen; jede Vorschau wird als Schnappschuss festgehalten und spaeter nie veraendert.
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var PC = cfg.plan || {};
__COPKW__
var PLAN_VER = 14;                                                                                // bei jeder Aenderung der Plan-Felder erhoehen: aeltere Plaene im Speicher werden dann sofort neu gerechnet
// PLAN_VER 14 (16.10.2026, Winterpaket): je Slot zusaetzlich COP und Strom mit Abtau-Abzug (copAb = COP · (1 − abtauAbzug · Abtaurisiko)); COP, Strom und Schnappschuss unveraendert
// PLAN_VER 13 (15.10.2026, Entscheidung 2): Gebaeudemodell UA * (T_innen - T_aussen) - Gewinne statt UA * max(0, 15 - T_aussen); Prognose mit Tagesgang Fuehler - OWM
// PLAN_VER 12 (14.10.2026): COP-Kennfeld und Strom je Slot mit der COP-Korrektur (COP_KW je Laufminute); Schnappschuss-meta cop_korr_w kennzeichnet die Version
var now = Date.now(), MS_MIN = 60000, Q15 = 900000, H = 3600000, N = 104, NDAY = 96;       // 104 Slots = 26 h (24 h Anzeige + Reserve fuer den Vergleich nach +24 h)
var G = function (k) { var v; try { v = global.get(k, 'file'); } catch (e) { v = undefined; } return v !== undefined ? v : global.get(k); };       // HeishaMoNR legt Anlagenwerte im Speicher "file" ab (ohne Einrichtung faellt das auf den Standardspeicher zurueck)
function num(v) { if (v === null || v === undefined || v === '') { return null; } v = Number(v); return isFinite(v) ? v : null; }
function ok(v) { return v !== null && v !== undefined && isFinite(v); }
function pn(k, d) { var v = num(PC[k]); return v === null ? d : v; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function lerp(x, x0, y0, x1, y1) { return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
function f(v, d, unit) { if (!ok(v)) { return '–'; } return Number(v).toFixed(d).replace('.', ',') + (unit ? ' ' + unit : ''); }
function c(v, d) { if (!ok(v)) { return ''; } var m = Math.pow(10, d === undefined ? 3 : d); return String(Math.round(v * m) / m); }
function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}) : '–'; }
function jload(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } }
function jsave(file, obj) { try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync(file, JSON.stringify(obj)); } catch (e) { /* kein Zugriff */ } }
function dayStart(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ---------- Zustand (ueberlebt Neustarts per Datei: Lernwerte und Plan-Schnappschuesse der letzten Stunden)
// == REIN-BEGIN == reine Funktionen des Gebaeudemodells (Fahrplan v2): kein Zugriff auf global, flow, fs oder die Uhr, einzeln testbar
function isN(v) { return typeof v === 'number' && isFinite(v); }
function nz(x) { if (x === '' || x === undefined || x === null) { return null; } var v = Number(x); return isFinite(v) ? v : null; }
function parseCsv(text) {                                                                            // mehrere Kopfzeilen-Abschnitte; Zuordnung strikt ueber die Spaltennamen des jeweiligen Abschnitts
    var rows = [], head = null;
    String(text || '').split('\n').forEach(function (l) {
        if (!l) { return; }
        var p = l.split(',');
        if (p[0] === 'slot_start') { head = p; return; }
        if (!head || p.length !== head.length) { return; }
        var o = {}; for (var i = 0; i < head.length; i++) { o[head[i]] = p[i]; }
        rows.push(o);
    });
    return rows;
}
function d0Of(key) { var p = key.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime(); }
function dayFromArr(a) {                                                                             // Eintrag aus learn.days (4er-Array oder 13er-Array) als Objekt
    var g = function (i) { return (a.length > i && isN(a[i])) ? a[i] : null; };
    return {d0: a[0], kh: g(1), q: g(2), n: g(3), s: g(4), wk: g(5), khW: g(6), wkW: g(7), dtr: g(8), wkT: g(13), wkWT: g(14), flags: g(15),
            khI: g(21), ti: g(22), wkI: g(23), khIW: g(24), wkIW: g(25)};                            // Modell v3: K*h gegen T_innen (Fuehler/OWM), T_innen, Wind ueber der Totzone x (T_innen - T_aussen)
}
function tiOf(r) { var s = 0, n = 0; Object.keys(r).forEach(function (k) { if (k.indexOf('ist_raum_') === 0) { var v = nz(r[k]); if (v !== null) { s += v; n++; } } }); return n ? s / n : null; }   // T_innen eines Slots: Mittel der Raeume mit Wert
function daysFromRows(rows, tbal) {                                                                  // Tagesaggregate aus plan-actuals-Zeilen (Ortszeit-Datum des Stempels, ein Slot = 15 min)
    var days = {}, order = [];
    rows.forEach(function (r) {
        var st = r.slot_start; if (!st || st.length < 16) { return; }
        var key = st.slice(0, 10), d = days[key];
        if (!d) { d = days[key] = {d0: d0Of(key), n: 0, kh: 0, q: 0, s: 0, wk: 0, khW: 0, wkW: 0, wkT: 0, wkWT: 0, sN: 0, wN: 0, owN: 0, wwN: 0, dhwM: 0, defM: 0, r0: {}, rl: {},
                                     tiS: 0, tiN: 0, khI: 0, kiN: 0, khIW: 0, kiwN: 0, wkI: 0, wiN: 0, wkIW: 0, wiwN: 0}; order.push(key); }
        d.n += 15;
        var at = nz(r.ist_aussen), q = nz(r.ist_waerme_kwh), pv = nz(r.ist_pv_w), wd = nz(r.ist_wind_ms), ow = nz(r.ist_aussen_owm);
        if (at !== null) { d.kh += Math.max(0, tbal - at) * 0.25; }
        if (q !== null) { d.q += q; }
        var wwM = nz(r.ist_ww_min), dfM = nz(r.ist_abtau_min); if (wwM !== null) { d.dhwM += wwM; } if (dfM !== null) { d.defM += dfM; }
        if (pv !== null) { d.s += pv * 0.25 / 1000; d.sN += 15; }
        if (ow !== null) { d.khW += Math.max(0, tbal - ow) * 0.25; d.owN += 15; }
        if (wd !== null && at !== null) { d.wk += Math.max(0, tbal - at) * wd * 0.25; d.wkT += Math.max(0, tbal - at) * windEff(wd) * 0.25; d.wN += 15; }
        if (wd !== null && ow !== null) { d.wkW += Math.max(0, tbal - ow) * wd * 0.25; d.wkWT += Math.max(0, tbal - ow) * windEff(wd) * 0.25; d.wwN += 15; }
        Object.keys(r).forEach(function (k) { if (k.indexOf('ist_raum_') === 0) { var v = nz(r[k]); if (v !== null) { if (d.r0[k] === undefined) { d.r0[k] = v; } d.rl[k] = v; } } });
        var ti = tiOf(r);                                                                            // Modell v3: Kelvinstunden gegen T_innen (nicht gekappt), Wind ueber der Totzone x (T_innen - T_aussen)
        if (ti !== null) {
            d.tiS += ti; d.tiN++;
            if (at !== null) { d.khI += (ti - at) * 0.25; d.kiN++; if (wd !== null) { d.wkI += (ti - at) * windEff(wd) * 0.25; d.wiN++; } }
            if (ow !== null) { d.khIW += (ti - ow) * 0.25; d.kiwN++; if (wd !== null) { d.wkIW += (ti - ow) * windEff(wd) * 0.25; d.wiwN++; } }
        }
    });
    return order.map(function (k) {
        var d = days[k], part = function (v, cnt) { return cnt >= 0.9 * d.n ? v : null; }, dl = [];
        Object.keys(d.r0).forEach(function (rk) { dl.push(d.rl[rk] - d.r0[rk]); });
        var sk = function (v, cnt) { return cnt * 15 >= 0.9 * d.n ? v * d.n / (cnt * 15) : null; };   // auf den ganzen Tag hochgerechnet, nur bei >= 90 % Abdeckung
        return {d0: d.d0, kh: d.kh, q: d.q, n: d.n, s: part(d.s, d.sN), wk: part(d.wk, d.wN), khW: part(d.khW, d.owN), wkW: part(d.wkW, d.wwN), wkT: part(d.wkT, d.wN), wkWT: part(d.wkWT, d.wwN), flags: lgFlags({dhwM: d.dhwM, defM: d.defM, gapM: 0, engM: 0, unpM: 0}), dtr: dl.length ? dl.reduce(function (x, y) { return x + y; }, 0) / dl.length : null,
                khI: sk(d.khI, d.kiN), ti: d.tiN * 15 >= 0.9 * d.n ? d.tiS / d.tiN : null, wkI: sk(d.wkI, d.wiN), khIW: sk(d.khIW, d.kiwN), wkIW: sk(d.wkIW, d.wiwN)};
    });
}
function gauss(A, b) {                                                                               // lineares Gleichungssystem, Pivotsuche; null bei singulaerer Matrix
    var n = b.length, M = A.map(function (r, i) { return r.slice().concat([b[i]]); }), i, j, k;
    for (i = 0; i < n; i++) {
        var p = i; for (j = i + 1; j < n; j++) { if (Math.abs(M[j][i]) > Math.abs(M[p][i])) { p = j; } }
        if (Math.abs(M[p][i]) < 1e-12) { return null; }
        var tmp = M[i]; M[i] = M[p]; M[p] = tmp;
        for (j = i + 1; j < n; j++) { var f0 = M[j][i] / M[i][i]; for (k = i; k <= n; k++) { M[j][k] -= f0 * M[i][k]; } }
    }
    var x = new Array(n); for (i = n - 1; i >= 0; i--) { var s = M[i][n]; for (k = i + 1; k < n; k++) { s -= M[i][k] * x[k]; } x[i] = s / M[i][i]; }
    return x;
}
function prepRows(days, o) {                                                                         // Datenzeilen {y, x1, x2, x3, x4} fuer die Regression; Tage ohne noetige Werte entfallen
    // Modell v3: x1 = K*h gegen T_innen (Fuehler bzw. OWM-Temperatur), x2 = Wind ueber der Totzone x (T_innen - T_aussen), x3 = PV-Energie, x4 = Stunden (Gewinne)
    var rows = [], vb = null, sw = 0, sk = 0;
    var X1 = function (d) { return o.tref === 'khW' ? d.khIW : d.khI; }, XW = function (d) { return o.tref === 'khW' ? d.wkIW : d.wkI; };
    days.forEach(function (d) { var x1 = X1(d), w = XW(d); if (isN(w) && isN(x1) && x1 > 0) { sw += w; sk += x1; } });
    if (sk > 0) { vb = sw / sk; }
    var nW = 0;
    days.forEach(function (d) {
        var x1 = X1(d), w = XW(d);
        if (!isN(x1) || !isN(d.q) || !isN(d.n) || (o.useS && !isN(d.s)) || ((o.C || 0) > 0 && !isN(d.dtr))) { return; }
        var y = d.q - (o.C || 0) * (isN(d.dtr) ? d.dtr : 0);
        var x2 = 0; if (o.useW) { if (isN(w)) { x2 = w; nW++; } else if (vb !== null) { x2 = x1 * vb; } }          // Tage ohne Wind: mittlere Windstaerke der Windtage annehmen
        rows.push({y: y, x1: x1, x2: x2, x3: o.useS ? d.s : 0, x4: d.n / 60, d0: d.d0});
    });
    return {rows: rows, nW: nW};
}
function mPrior(o) {                                                                                 // Vorwert (Auslegung) und Grenzen des Modells v3
    return {ua0: isN(o.ua0) ? o.ua0 : 0.15, g0: isN(o.g0) ? o.g0 : 0.3, w: isN(o.priorTage) ? o.priorTage : 2, X: Array.isArray(o.priorX) ? o.priorX : [10, 16],
            uaLo: isN(o.uaLo) ? o.uaLo : 0.07, uaHi: isN(o.uaHi) ? o.uaHi : 0.35, gLo: isN(o.gLo) ? o.gLo : 0, gHi: isN(o.gHi) ? o.gHi : 1.2};
}
function ridgeCore(rows, o) {                                                                        // y = UA*x1 + bw*x2 - bs*x3 - g*x4 (Modell v3): gewichtete kleinste Quadrate mit dem Vorwert als Pseudo-Tagen
    // (UA, Gewinne: priorTage Tage bei 10 und 16 K, wie tools/plan_algo.js) und Ridge-Prior 0 fuer Wind/Sonne; Grenzen UA [uaLo, uaHi], Gewinne [gLo, gHi], bw/bs >= 0; exakt ueber alle Faelle (aktive Grenzen)
    var n = rows.length, P = mPrior(o), sig = [0, o.sW, o.sS, 0];
    var ym = n ? rows.reduce(function (a, r) { return a + r.y; }, 0) / n : 24 * (P.ua0 * 13 - P.g0), sr = Math.max(1.0, 0.10 * Math.abs(ym)), r2 = sr * sr;
    var R = rows.map(function (r) { return {w: 1, y: r.y, f: [r.x1, r.x2, -r.x3, -r.x4]}; });
    P.X.forEach(function (X) { R.push({w: P.w, y: 24 * (P.ua0 * X - P.g0), f: [24 * X, 0, 0, -24]}); });
    var en = [true, !!o.useW, !!o.useS, true], lo = [P.uaLo, 0, 0, P.gLo], hi = [P.uaHi, Infinity, Infinity, P.gHi];
    var best = null, st = [0, 0, 0, 0];
    function tryState() {                                                                            // st[p]: 0 frei, 1 untere Grenze, 2 obere Grenze (Wind/Sonne nur 0 frei oder 1 = 0)
        var beta = [0, 0, 0, 0], free = [], p, q, a, c;
        for (p = 0; p < 4; p++) { if (!en[p]) { beta[p] = 0; } else if (st[p] === 0) { free.push(p); } else { beta[p] = st[p] === 1 ? lo[p] : hi[p]; } }
        if (free.length) {
            var m = free.length, A = [], bb = [];
            for (a = 0; a < m; a++) { A.push(new Array(m).fill(0)); bb.push(0); }
            R.forEach(function (r) {
                var resid = r.y; for (q = 0; q < 4; q++) { if (free.indexOf(q) < 0) { resid -= r.f[q] * beta[q]; } }
                for (a = 0; a < m; a++) { for (c = 0; c < m; c++) { A[a][c] += r.w * r.f[free[a]] * r.f[free[c]] / r2; } bb[a] += r.w * r.f[free[a]] * resid / r2; }
            });
            for (a = 0; a < m; a++) { if (sig[free[a]] > 0) { A[a][a] += 1 / (sig[free[a]] * sig[free[a]]); } }
            var sol = gauss(A, bb); if (!sol) { return; }
            for (a = 0; a < m; a++) { beta[free[a]] = sol[a]; }
            for (a = 0; a < m; a++) { p = free[a]; if (beta[p] < lo[p] - 1e-12 || beta[p] > hi[p] + 1e-12) { return; } }
        }
        var J = 0; R.forEach(function (r) { var e = r.y - (r.f[0] * beta[0] + r.f[1] * beta[1] + r.f[2] * beta[2] + r.f[3] * beta[3]); J += r.w * e * e / r2; });
        for (p = 1; p < 3; p++) { if (en[p]) { J += beta[p] * beta[p] / (sig[p] * sig[p]); } }
        if (best === null || J < best.J - 1e-15) { best = {ua: beta[0], bw: beta[1], bs: beta[2], g: beta[3], J: J, n: n}; }
    }
    for (st[0] = 0; st[0] < 3; st[0]++) { for (st[3] = 0; st[3] < 3; st[3]++) { for (st[1] = 0; st[1] < (en[1] ? 2 : 1); st[1]++) { for (st[2] = 0; st[2] < (en[2] ? 2 : 1); st[2]++) { tryState(); } } } }
    if (best === null) { return {ua: P.ua0, bw: 0, bs: 0, g: P.g0, J: 0, n: n}; }
    return best;
}
function predict(fit, r) { return fit.ua * r.x1 + fit.bw * r.x2 - fit.bs * r.x3 - (fit.g || 0) * (r.x4 || 0); }
function ridgeFit(rows, o) {                                                                         // robust: Tage mit Rest > 3 sigma (sigma = max(1 kWh, 10 % vom Mittel)) werden einmalig herausgenommen, dann neu gerechnet
    var f = ridgeCore(rows, o);
    if (o.robust === false || rows.length < 5) { return f; }
    var ym = rows.reduce(function (a2, r) { return a2 + r.y; }, 0) / rows.length, sr = Math.max(1.0, 0.10 * ym);
    var keep = rows.filter(function (r) { return Math.abs(r.y - predict(f, r)) <= 3 * sr; });
    if (keep.length === rows.length || keep.length < 4) { return f; }
    var g = ridgeCore(keep, o); g.removed = rows.length - keep.length; return g;
}
function looMae(rows, o) {                                                                           // Leave-one-day-out: mittlerer absoluter Tagesfehler [kWh] (der Vorwert bleibt immer drin)
    if (rows.length < 3) { return null; }
    var s = 0;
    rows.forEach(function (r, i) { var rest = rows.filter(function (x, j) { return j !== i; }); s += Math.abs(r.y - predict(ridgeFit(rest, o), r)); });
    return s / rows.length;
}
function gateCheck(n, rows, maeBase, maeCand, fit, o) {                                              // Aktivierungsbedingungen (F4.3); in S2 nur Anzeige
    var why = [];
    if (n < o.minDays) { why.push('weniger als ' + o.minDays + ' Tage'); }
    var sv = rows.map(function (r) { return r.x3; }), sm = sv.length ? sv.reduce(function (a, b) { return a + b; }, 0) / sv.length : 0;
    var lowN = sv.filter(function (v) { return v < 0.8 * sm; }).length, highN = sv.filter(function (v) { return v > 1.2 * sm; }).length;
    if (lowN < 2 || highN < 2) { why.push('PV-Tage zu gleichfoermig'); }
    if (!(maeBase > 0 && maeCand !== null && maeCand <= 0.9 * maeBase)) { why.push('Fehler nicht um 10 % besser'); }
    if (!isFinite(fit.bs) || !isFinite(fit.bw) || !isFinite(fit.ua)) { why.push('Koeffizient nicht endlich'); }
    else if (fit.bs < 0 || fit.bw < 0) { why.push('Koeffizient negativ'); }
    else if (fit.bs > COEF_LIM.bs || fit.bw > COEF_LIM.bw) { why.push('Koeffizient unplausibel'); }
    if (isN(o.maeIn) && o.maeIn > 0.1 && isN(maeCand) && maeCand / o.maeIn > UEBERANPASSUNG) { why.push('Überanpassung (Test/Training ' + (Math.round(maeCand / o.maeIn * 10) / 10).toFixed(1).replace('.', ',') + ')'); }
    return {ok: why.length === 0, why: why};
}
// Validierung (D): Fehler ausserhalb der Stichprobe (Leave-one-day-out) gegen den Fehler auf den Lerntagen; Quote > 1,5 = Ueberanpassung
// (Idee hubertciebiada/pump-ahead cross_validation.py, AGPL: nur die Idee, kein Code). 1,5 ist dort der Standard (ANNAHME fuer uns).
var UEBERANPASSUNG = 1.5;
function inMae(rows, f) { if (!rows.length) { return null; } var s = 0; rows.forEach(function (r) { s += Math.abs(r.y - predict(f, r)); }); return s / rows.length; }
// Harte Grenzen fuer Sonne/Wind (Sicherheit A, 13.10.): Vorzeichen physikalisch fest (Sonne senkt, Wind erhoeht den Bedarf), Betrag begrenzt.
// Idee aus andox/heat-pump-pilot (bounded_fit) und smefa/ClimateOptimizer (fester Sonnenterm, weil ein frei gelernter negativ wurde); kein Code uebernommen.
// Werte: Nutzerentscheidung 13.10.2026 (nicht gemessen):
//  bs <= 0,5 kWh Waerme je kWh PV: oberes Ende des gelernten Bereichs von tvofi/heatpump_optimizer (Fensterflaeche 10 m² x Ausrichtung 0,7 x g-Wert 0,7
//     = 4,9 m² wirksam, Lernfaktor 0,3-2,0 -> umgerechnet bs ~ 0,08-0,54 bei PV-Spitze ~ 18 kW); ClimateOptimizer fest +7 K bei voller Sonne ~ bs 0,1-0,2.
//  bw <= 0,0125 kWh/(K*m/s*h) (~ +5 % Waermeverlust je m/s bei UA 0,25 kW/K): ueber dem tvofi-Standard 3 %/(m/s) = 0,0075, ClimateOptimizer ~ 0,002-0,005,
//     strutsfarm 15 %/(m/s) als Ausreisser.
//  Wind zaehlt erst oberhalb von 4 m/s: Merkmal max(0, v - 4) (Idee ClimateOptimizer WIND_DEADBAND_MS 4,0); gleich in Fit, Gate, Plan, OPT_plan.model und Vorausschau.
// MODELL_VER 2 (13.10.2026): Wind-Merkmal mit Totzone; aeltere Koeffizienten (roher Wind) werden neu gerechnet und nie als aktiv uebernommen.
// MODELL_VER 3 (15.10.2026, Entscheidung 2): Grundmodell UA*(T_innen - T_aussen) - Gewinne (vorher UA*max(0, 15 - T_aussen)); Wind-Merkmal (T_innen - T_aussen) x Wind ueber der Totzone;
// Gate-Fehlermassstab = Leave-one-day-out des neuen Grundmodells; A/B, Drift und Rueckfall beginnen neu.
var COEF_LIM = {bs: 0.5, bw: 0.0125}, WIND_TOT = 4.0, MODELL_VER = 3;
function windEff(v) { return isN(v) ? Math.max(0, v - WIND_TOT) : null; }
// Lern-Hygiene (B, 13.10.2026). Ideen: tvofi/heatpump_optimizer (MIT) _learning_frozen (Lerner ruhen bei Abtauen, Warmwasser, unbrauchbarem Eingang),
// INPUT_PLAUSIBLE_RANGE_C, drift.py (CUSUM); andox/heat-pump-pilot (Apache-2.0) Lueckenverwurf. Kein Code uebernommen.
// Plausibilitaetsbereiche je Eingang (ausserhalb = fehlend, je Tag gezaehlt), alle ANNAHME mit Begruendung:
//  at/ow -40..45 °C (tvofi Aussenluft -70..70; Deutschland gemessen -37,8..41,2), wind 0..40 m/s (Orkan ab 32,7), pth -15..15 kW (Leisha 5 kW nominal, Abtauen negativ),
//  pel 0..6 kW (Verdichter bis ~2 kW plus Heizstab 3 kW), pv 0..25 kW (PV-Spitze ~18 kW, Nutzerangabe 13.10.), hz 0..150 Hz.
var PLAUS = {at: [-40, 45], ow: [-40, 45], wind: [0, 40], pth: [-15000, 15000], pel: [0, 6000], pv: [0, 25000], hz: [0, 150]};
// Tages-Gate (ein Tag mit mehr Minuten in diesen Zustaenden lernt nicht mit), alle ANNAHME: Warmwasser > 120 min, Abtauen > 90 min, Anlagendaten aelter als 5 min > 60 min,
// Eingriff (MQTT-Sperre oder Betriebsart ohne Heizen) > 60 min, unplausible Eingaenge > 60 min.
var LERN_GATE = {dhwMaxMin: 120, defMaxMin: 90, gapMaxMin: 60, engMaxMin: 60, unplMaxMin: 60};
var LG_TEXT = [[1, 'Warmwasser'], [2, 'Abtauen'], [4, 'Datenlücke'], [8, 'Eingriff'], [16, 'unplausibel']];
function lgFlags(c) { return (c.dhwM > LERN_GATE.dhwMaxMin ? 1 : 0) | (c.defM > LERN_GATE.defMaxMin ? 2 : 0) | (c.gapM > LERN_GATE.gapMaxMin ? 4 : 0) | (c.engM > LERN_GATE.engMaxMin ? 8 : 0) | (c.unpM > LERN_GATE.unplMaxMin ? 16 : 0); }
function lgTxt(f) { return LG_TEXT.filter(function (x) { return f & x[0]; }).map(function (x) { return x[1]; }).join(', '); }
// CUSUM (Idee tvofi drift.py): s = min(1,5 h, max(0, s + x - k)); Alarm ab s >= h, Ende erst bei s <= h/4 (Hysterese). k 0,5 und h 4 (Drift) bzw. 3 (Rueckfall):
// uebliche Werte der CUSUM-Literatur (k = halbe zu erkennende Verschiebung in Standardabweichungen, h 4-5), ANNAHME. Rueckfall sperrt 7 Tage (ANNAHME; tvofi Schnappschuss-Takt 7 Tage).
var DRIFT = {k: 0.5, h: 4, rbH: 3, rbSperrTage: 7, minSlots: 80, ring: 8};
function cusum(st, x, k, h) { st = (st && isN(st.s)) ? st : {s: 0, an: false}; st.s = Math.min(1.5 * h, Math.max(0, st.s + x - k)); if (!st.an && st.s >= h) { st.an = true; } else if (st.an && st.s <= h / 4) { st.an = false; } return st; }
function abSigma(q) { return Math.max(1.0, 0.10 * Math.abs(q)); }                                  // Streuung der Tagesbilanz wie in ridgeCore
function abSchritt(L, e, aktiv) {                                                                    // ein abgeschlossener A/B-Tag: Drift des Plan-Modells (beidseitig) und, bei aktivem Kandidaten, Rueckfall-Pruefung (Kandidat schlechter als Plan-Modell)
    var x = (e && e.L24 && e.L24.n >= DRIFT.minSlots) ? e.L24 : ((e && e.L6 && e.L6.n >= DRIFT.minSlots) ? e.L6 : null);
    if (!x || !isN(x.q) || !isN(x.b) || !isN(x.k)) { return {genutzt: false}; }
    var sg = abSigma(x.q), r = (x.q - x.b) / sg, out = {genutzt: true, r: r};
    L.up = cusum(L.up, r, DRIFT.k, DRIFT.h); L.dn = cusum(L.dn, -r, DRIFT.k, DRIFT.h); L.n = (L.n || 0) + 1;
    if (aktiv) { var y = (Math.abs(x.q - x.k) - Math.abs(x.q - x.b)) / sg; L.rb = cusum(L.rb, y, DRIFT.k, DRIFT.rbH); out.y = y; out.rueckfall = L.rb.an; }
    else { L.rb = {s: 0, an: false}; }
    return out;
}
function coefSafe(c) {                                                                               // wird vor JEDER Nutzung angewandt (Plan und Vorausschau): nicht endlich -> 0, negativ -> 0, zu gross -> Grenze
    var cl = function (v, hi) { return (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(0, v)) : 0; };
    var o = {bs: cl(c && c.bs, COEF_LIM.bs), bw: cl(c && c.bw, COEF_LIM.bw)};
    o.geklemmt = !c || o.bs !== c.bs || o.bw !== c.bw;
    return o;
}
function coefHardFail(gate) { return !!(gate && gate.why && gate.why.some(function (w) { return /nicht endlich|negativ|unplausibel/.test(w); })); }
function fitModel(daysIn, P) {                                                                       // alle Varianten rechnen (Anzeige; Sonne/Wind wirken nur mit coefActivate): Grundmodell (UA, Gewinne), + Sonne, + Wind, OWM-Temperatur, Speicherterm
    var o0 = {ua0: P.ua0, g0: P.g0, priorTage: P.priorTage, priorX: P.priorX, uaLo: P.uaLo, uaHi: P.uaHi, gLo: P.gLo, gHi: P.gHi, sW: P.sW, sS: P.sS, useS: false, useW: false, tref: 'kh', C: 0};
    var mk = function (patch) { var o = {}; Object.keys(o0).forEach(function (k) { o[k] = o0[k]; }); Object.keys(patch).forEach(function (k) { o[k] = patch[k]; }); return o; };
    var base = prepRows(daysIn, mk({})), pr = mPrior(o0), minT = isN(P.lernMinTage) ? P.lernMinTage : 2;
    var out = {n: base.rows.length, ts: 0, ua: pr.ua0, g: pr.g0, gelernt: false, maeBase: null, maeUA: null, maeSun: null, maeWind: null, maeOwm: null, store: {}, uaRidge: null, bs: 0, bw: 0, nW: 0, bestC: 0};
    if (base.rows.length < 1) { return out; }
    var f1 = ridgeFit(base.rows, mk({})); out.uaRidge = f1.ua; out.gRidge = f1.g;
    out.gelernt = base.rows.length >= minT;                                                          // erst ab lernMinTage Lerntagen gilt das gelernte Grundmodell, vorher der Vorwert
    if (out.gelernt) { out.ua = f1.ua; out.g = f1.g; }
    out.maeBase = looMae(base.rows, mk({})); out.maeUA = out.maeBase;                                // Fehlermassstab des Gates: Leave-one-day-out des Grundmodells UA*(T_innen - T_aussen) - Gewinne
    var oS = mk({useS: true}), pS = prepRows(daysIn, oS), fS = ridgeFit(pS.rows, oS);
    out.maeSun = looMae(pS.rows, oS); out.bs = fS.bs; out.uaSun = fS.ua; out.gSun = fS.g; out.nSun = pS.rows.length;
    var oW = mk({useS: true, useW: true}), pW = prepRows(daysIn, oW);
    out.nW = pW.nW;
    if (pW.nW >= P.minWindDays) { var fW = ridgeFit(pW.rows, oW); out.bw = fW.bw; out.bsW = fW.bs; out.uaWind = fW.ua; out.gWind = fW.g; out.maeWind = looMae(pW.rows, oW); }
    var oO = mk({tref: 'khW'}), pO = prepRows(daysIn, oO); if (pO.rows.length >= 3) { out.maeOwm = looMae(pO.rows, oO); out.nOwm = pO.rows.length; }
    var bestC = 0, bestM = null;
    P.storeC.forEach(function (C) { var oC = mk({useS: true, C: C}), pC = prepRows(daysIn, oC), m = pC.rows.length >= 3 ? looMae(pC.rows, oC) : null; out.store[C] = m; if (m !== null && (bestM === null || m < bestM)) { bestM = m; bestC = C; } });
    out.bestC = bestC;
    var cand = out.maeWind !== null ? out.maeWind : out.maeSun;
    var gp = out.maeWind !== null ? {ua: out.uaWind, bw: out.bw, bs: out.bsW || 0} : {ua: out.uaSun, bw: 0, bs: out.bs};
    out.maeIn = out.maeWind !== null ? inMae(pW.rows, fW) : inMae(pS.rows, fS);                  // Fehler auf den Lerntagen (fuer die Ueberanpassungs-Quote)
    out.gate = gateCheck(out.n, pS.rows, out.maeBase, cand, gp, {minDays: P.minDays, maeIn: out.maeIn});
    return out;
}
// Langsame Anpassung (Modell v3): je neuem Tag bewegt sich das im Plan verwendete Modell hoechstens um stepUaRel (relativ), stepGainKw und stepTiK auf das gelernte Ziel zu;
// ohne Vorstand (erster Lauf, Modellwechsel) gilt das Ziel sofort. Innerhalb eines Tages bleibt der Stand.
function modellSchritt(prev, ziel, d0, P) {
    if (!prev || !isN(prev.ua) || !isN(prev.g) || !isN(prev.ti) || !isN(prev.d0)) { return {ua: ziel.ua, g: ziel.g, ti: ziel.ti, d0: d0, n: ziel.n, gelernt: ziel.gelernt, quelle: ziel.quelle, gebremst: false}; }
    if (prev.d0 >= d0) { return prev; }
    var tage = Math.max(1, Math.round((d0 - prev.d0) / 86400000)), lim = function (a, b, m) { return a + Math.max(-m, Math.min(m, b - a)); };
    var ua = lim(prev.ua, ziel.ua, Math.abs(prev.ua) * P.stepUaRel * tage), g = lim(prev.g, ziel.g, P.stepGainKw * tage), ti = lim(prev.ti, ziel.ti, P.stepTiK * tage);
    return {ua: ua, g: g, ti: ti, d0: d0, n: ziel.n, gelernt: ziel.gelernt, quelle: ziel.quelle, gebremst: Math.abs(ua - ziel.ua) > 1e-9 || Math.abs(g - ziel.g) > 1e-9 || Math.abs(ti - ziel.ti) > 1e-9};
}
function tiZiel(tage, nTage, tiJetzt, P) {                                                          // T_innen fuer den Plan: Mittel der letzten nTage vollen Tage, sonst die Raeume jetzt, sonst tiDefaultC; in [tiMin, tiMax]
    var L = tage.filter(function (d) { return isN(d.ti); }).slice(-nTage), v = L.length ? L.reduce(function (a, d) { return a + d.ti; }, 0) / L.length : (isN(tiJetzt) ? tiJetzt : P.tiStd);
    return {ti: Math.min(P.tiMax, Math.max(P.tiMin, v)), n: L.length};
}
// Tagesgang der Abweichung Fuehler - OWM (Fuehler im Schatten: nachts bei klarem Himmel 2-4 K kaelter, docs/ALGORITHMUS.md): Mittel je Uhrzeit ueber die tage vollen Tage vor d0
// aus den 15-min-Slots [Tag d0, Stunde, Fuehler - OWM]; jede Stunde braucht mindestens 2 x tage Werte, sonst null (dann gilt die Prognose wie bisher nur mit dem abklingenden Versatz)
function tgProfil(rows, d0, tage) {
    if (!tage) { return null; }
    var S = []; for (var h = 0; h < 24; h++) { S.push([0, 0]); }
    (rows || []).forEach(function (x) { if (x[0] < d0 && x[0] >= d0 - tage * 86400000 - 3600000 && isN(x[2]) && x[1] >= 0 && x[1] < 24) { S[x[1]][0] += x[2]; S[x[1]][1]++; } });
    if (S.some(function (x) { return x[1] < 2 * tage; })) { return null; }
    return S.map(function (x) { return Math.round(x[0] / x[1] * 100) / 100; });
}
function biasFeat(hour, wind, pvW, cl) {                                                             // Merkmale der Fuehlerkorrektur OWM -> Fuehler: [1, Wind, Sonne, Nacht, Nacht*klar]
    var night = (hour >= 20 || hour < 6) ? 1 : 0, clear = isN(cl) ? 1 - Math.min(100, Math.max(0, cl)) / 100 : 0.5, sun = isN(pvW) ? Math.min(1.5, Math.max(0, pvW / 15000)) : 0;
    return [1, isN(wind) ? wind : 0, sun, night, night * clear];
}
function biasRowsFromRows(rows) {                                                                    // Lernzeilen aus plan-actuals (ab Fahrplan v2 S1 mit OWM-Temperatur und Wind): d = Fuehler - OWM
    var out = [];
    rows.forEach(function (r) {
        var at = nz(r.ist_aussen), ow = nz(r.ist_aussen_owm), wd = nz(r.ist_wind_ms), pv = nz(r.ist_pv_w), cl = nz(r.ist_bewoelkung_pct), st = r.slot_start;
        if (at === null || ow === null || wd === null || !st || st.length < 16) { return; }
        out.push({day: st.slice(0, 10), d: at - ow, f: biasFeat(Number(st.slice(11, 13)), wd, pv, cl)});
    });
    return out;
}
var BIAS_PRIOR = {sd: 1.0, sig: [2.0, 0.5, 3.0, 2.0, 2.0]};                                          // Streuung der Messung 1 K; Prior 0 mit Streuungen fuer Achsenabschnitt, Wind (K je m/s), Sonne, Nacht, Nacht klar
function biasSolve(rows) {
    var k = 5, A = [], b = [], i, j; for (i = 0; i < k; i++) { A.push(new Array(k).fill(0)); b.push(0); }
    rows.forEach(function (r) { for (i = 0; i < k; i++) { b[i] += r.f[i] * r.d; for (j = 0; j < k; j++) { A[i][j] += r.f[i] * r.f[j]; } } });
    for (i = 0; i < k; i++) { A[i][i] += BIAS_PRIOR.sd * BIAS_PRIOR.sd / (BIAS_PRIOR.sig[i] * BIAS_PRIOR.sig[i]); }
    return gauss(A, b);
}
function biasDot(c, f) { var s = 0; for (var i = 0; i < 5; i++) { s += c[i] * f[i]; } return s; }
function biasFit(rows) {                                                                             // Koeffizienten, Fehler (Leave-one-day-out) gegen "keine Korrektur" und gegen einen festen Mittelwert
    var days = {}, order = [];
    rows.forEach(function (r) { if (!days[r.day]) { days[r.day] = []; order.push(r.day); } days[r.day].push(r); });
    var out = {n: rows.length, days: order.length, coef: null, maeZero: null, maeMean: null, maeMod: null};
    if (rows.length < 20) { return out; }
    out.coef = biasSolve(rows);
    if (!out.coef) { return out; }
    if (order.length >= 3) {
        var sz = 0, sm = 0, sd = 0, cnt = 0;
        order.forEach(function (dk) {
            var rest = rows.filter(function (r) { return r.day !== dk; }), c = rest.length >= 20 ? biasSolve(rest) : null;
            if (!c) { return; }
            var mean = rest.reduce(function (a, r) { return a + r.d; }, 0) / rest.length;
            days[dk].forEach(function (r) { sz += Math.abs(r.d); sm += Math.abs(r.d - mean); sd += Math.abs(r.d - biasDot(c, r.f)); cnt++; });
        });
        if (cnt) { out.maeZero = sz / cnt; out.maeMean = sm / cnt; out.maeMod = sd / cnt; }
    }
    return out;
}
function biasGate(fit) {                                                                             // Aktivierung (spaeter, in S2b nur Anzeige): >= 7 Tage, mindestens 10 % besser als keine Korrektur, plausible Werte
    var why = [];
    if (fit.days < 7) { why.push('weniger als 7 Tage'); }
    if (!(fit.maeZero > 0 && fit.maeMod !== null && fit.maeMod <= 0.9 * fit.maeZero)) { why.push('Fehler nicht um 10 % besser'); }
    if (fit.coef && (Math.abs(fit.coef[1]) > 1.0 || Math.abs(fit.coef[2]) > 5 || Math.abs(fit.coef[3]) > 4 || Math.abs(fit.coef[4]) > 4)) { why.push('Koeffizient unplausibel'); }
    return {ok: why.length === 0, why: why};
}
// == REIN-END ==

var pl = flow.get('plan');
if (!pl) {
    pl = {acc: null, hour: null, day: null, lastTs: null, prevDefrost: false, plan: null, planSlot: 0, snaps: [], learn: {days: []}, lastSave: 0};
    var pj = jload('/data/optimizer/plan-state.json', null);
    if (pj && typeof pj === 'object') { pl.learn = pj.learn || pl.learn; pl.snaps = Array.isArray(pj.snaps) ? pj.snaps : []; pl.day = pj.day || null; }
    if (pl.snaps.length) { pl.snapHour = pl.snaps[pl.snaps.length - 1].t0; }                // diese Stunde hat schon einen Schnappschuss
}
var out = [null, null, null, null, null];                                                       // Anzeige, Ist-Protokoll, Vergleich, Schnappschuss, (frei)
if (pl.learn.mv !== MODELL_VER) { pl.learn.ab = []; pl.learn.lg = null; delete pl.learn.rueckfall; pl.learn.coefHist = []; delete pl.learn.mdl; pl.ab = null; pl.learn.mv = MODELL_VER; }   // Modellwechsel: A/B, Drift und Rueckfall des alten Modells gelten nicht weiter
if (!pl.learn.lg) { pl.learn.lg = {}; (pl.learn.ab || []).forEach(function (e) { abSchritt(pl.learn.lg, e, false); }); }   // Drift-Zaehler einmalig aus den gesicherten A/B-Tagen nachrechnen (ohne Rueckfall)

// ---------- Eingaenge: Waermepumpe (nur lesen)
var HP = G('OPT_hp') || {};
function hpv(name) { var e = HP[name]; return (e && typeof e.v === 'number' && now - e.ts < 10 * MS_MIN) ? e.v : null; }
var unpl = [];                                                                                   // Lern-Hygiene: Eingaenge ausserhalb PLAUS gelten in dieser Minute als fehlend (gezaehlt je Tag)
function plaus(k, v) { if (v === null || v === undefined) { return null; } if (!isFinite(v) || v < PLAUS[k][0] || v > PLAUS[k][1]) { unpl.push(k); return null; } return v; }
var freq = plaus('hz', num(G('compressor_frequency'))) || 0, running = freq > 0;
var pel = plaus('pel', num(G('TOP16_Heat_Energy_Consumption'))), flw = num(G('TOP1_Pump_Flow'));
var istVL = num(G('TOP6_Main_Outlet_Temp')), istRL = num(G('TOP5_Main_Inlet_Temp'));
var spread = (istVL !== null && istRL !== null) ? istVL - istRL : null;
var pthHs = hpv('Heat_Power_Production_Extra'); if (!running || pthHs === null || pthHs < -100) { pthHs = null; }
var pthCalc = (running && flw !== null && spread !== null) ? flw * spread * 69.7 : null;
var pth = plaus('pth', pthHs !== null ? pthHs : pthCalc);
var defrost = num(G('TOP26_Defrosting_State')) === 1, dhw = num(G('TOP20_ThreeWay_Valve_State')) === 1;
var atNow = plaus('at', num(G('TOP14_Outside_Temp'))), qLevel = num(G('TOP18_Quiet_Mode_Level'));
var hpTs0 = 0; Object.keys(HP).forEach(function (k) { if (k.charAt(0) !== '_' && HP[k] && typeof HP[k].ts === 'number' && HP[k].ts > hpTs0) { hpTs0 = HP[k].ts; } });
var hpFrisch = hpTs0 > 0 && now - hpTs0 <= 5 * MS_MIN;                                          // Anlagendaten hoechstens 5 min alt (wie die Sperre "daten" der Entscheidungsmaschine)
var opm = num(G('TOP4_Operating_Mode_State')), mqB = G('MQTT') || {};
var eingriff = mqB.block_active === 1 || (opm !== null && [0, 2, 4, 6].indexOf(opm) < 0);          // Eingriff: MQTT-Sperre oder Betriebsart ohne Heizen
var PI = G('OPT_plan_in') || {}, piFresh = PI.ts && now - PI.ts < 5 * MS_MIN, pvNowP = piFresh ? plaus('pv', num(PI.pvNow)) : null;
var Rr = G('OPT_rooms') || {}, Sx = G('OPT_state') || {}, sxFresh = Sx.ts && now - Sx.ts < 5 * MS_MIN;
var ROOMS = cfg.rooms || [];

// ---------- Ist-Werte je 15-Minuten-Slot (Grundlage fuer den spaeteren Vergleich) und je Tag (Lernen des Waermebedarfs)
var s0 = Math.floor(now / Q15) * Q15, dtH = pl.lastTs ? Math.min(now - pl.lastTs, 3 * MS_MIN) / H : 0;
pl.lastTs = now;
function newAcc(t) { return {windS: 0, windN: 0, clS: 0, clN: 0, owS: 0, owN: 0, toS: 0, toN: 0, tcS: 0, tcN: 0, s: t, n: 0, atS: 0, atN: 0, pvS: 0, pvN: 0, thH: 0, elH: 0, thA: 0, elA: 0, dhwMin: 0, runMin: 0, defrosts: 0, hzS: 0, hzN: 0, defMin: 0, defEl: 0, defTh: 0, spS: 0, spN: 0, vdS: 0, vdN: 0, puS: 0, puN: 0, hc: null, elAK: 0, elHK: 0, kw: COP_KW, elZ: 0, zMin: 0}; }   // elAK/elHK: Strom mit COP-Korrektur; kw fehlt = Slot von einer aelteren Version begonnen (korrigierte Spalten bleiben leer)
function fillAcc(a) { ['windS', 'windN', 'clS', 'clN', 'owS', 'owN', 'toS', 'toN', 'tcS', 'tcN'].forEach(function (k) { if (a[k] === undefined) { a[k] = 0; } }); return a; }       // Zustand aus einem aelteren Stand (Deploy ohne Neustart) um neue Zaehler ergaenzen
function fillDay(d) { ['s', 'sN', 'wk', 'wN', 'khW', 'owN', 'wkW', 'wwN', 'wkT', 'wTN', 'wkWT', 'wwTN', 'lgN', 'dhwM', 'defM', 'gapM', 'engM', 'unpM', 'tiS', 'tiN', 'khI', 'kiN', 'khIW', 'kiwN', 'wkI', 'wiN', 'wkIW', 'wiwN'].forEach(function (k) { if (d[k] === undefined) { d[k] = 0; } }); if (!d.r0) { d.r0 = {}; } if (!d.rl) { d.rl = {}; } return d; }
function priceAt(slots, t) { if (!Array.isArray(slots)) { return null; } for (var i = 0; i < slots.length; i++) { if (slots[i][0] <= t && slots[i][1] > t) { return slots[i][2]; } } return null; }
var roomIds = ROOMS.map(function (r) { return r.id; });
var ACT_K = ['ist_strom_korr_kwh', 'ist_strom_heizen_korr_kwh', 'ist_cop_korr', 'ist_cop_korr_w'];
var ACT_Z = ['ist_strom_zaehler_kwh', 'ist_zaehler_min'];                                   // cop-ziel 17.10.2026 (nur angehaengt, nur plan-actuals): Strom vom Zaehler (ohne Heizstab, Lauf und Stillstand) und Minuten mit frischem Zaehler        // 14.10.2026 (nur angehaengt): Strom/COP mit COP-Korrektur und ihre Konstante; ist_strom_kwh/ist_cop bleiben roh (TOP16)
var ACT_COLS = ['ist_aussen', 'ist_pv_w', 'ist_preis', 'ist_cop', 'ist_waerme_kwh', 'ist_strom_kwh', 'ist_abtauungen', 'ist_ww_min', 'ist_verdichter_min', 'ist_hz', 'ist_quiet_stufe', 'ist_soc', 'ist_waerme_gesamt_kwh', 'ist_strom_heizen_kwh', 'ist_abtau_min', 'ist_abtau_strom_kwh', 'ist_abtau_waerme_kwh', 'ist_spreizung', 'ist_vl_abweichung', 'ist_pumpe_u_min', 'ist_heizregelung']
    .concat(roomIds.map(function (id) { return 'ist_raum_' + id; }))
    .concat(['ist_wind_ms', 'ist_bewoelkung_pct', 'ist_aussen_owm', 'ist_aussen_regel', 'ist_t_custom']);       // Fahrplan v2: Wind, Bewoelkung, OWM-Temperatur, Regelwert T_outside, eigener Fuehler (nur anhaengen)
var EV_COLS2 = ['prog_wind_ms', 'prog_bewoelkung_pct', 'prog_aussen_korr', 'prog_sonne_kwh', 'prog_bedarf_basis_kwh', 'prog_bedarf_kand_kwh', 'prog_strom_kwh', 'prog_cop_korr_w'].concat(ACT_K);   // prog_cop_korr_w: Korrektur, mit der der Schnappschuss rechnete (leer = vor PLAN_VER 12, roh)                       // Vergleichsspalten hinter den Ist-Werten (nur anhaengen; prog_strom_kwh seit PLAN_VER 11)
function csvOut(file, head, lines) {                                                           // Kopfzeile einmal je Datei (und bei geaenderten Spalten neu)
    var needHead = true, key = file + '|' + head;
    pl.heads = pl.heads || {};
    if (pl.heads[file] === key) { needHead = false; }
    else {
        pl.heads[file] = key;
        try { var lastH = null; var key0 = head.split(',')[0] + ','; String(fs.readFileSync(file, 'utf8')).split('\n').forEach(function (l) { if (l.indexOf(key0) === 0) { lastH = l; } }); needHead = lastH !== head; } catch (e) { needHead = true; }
    }
    return {filename: file, payload: (needHead ? head + '\n' : '') + lines.join('\n') + '\n'};
}
function stamp(ts) {
    var d = new Date(ts), p2 = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
function monthOf(ts) { return stamp(ts).slice(0, 7); }
function abTag(e) {                                                                                 // Absicherung (D): abgeschlossener A/B-Tag -> Drift (Anzeige) und Rueckfall des aktiven Kandidaten
    pl.learn.lg = pl.learn.lg || {};
    var cf = pl.learn.coef, akt = !!(cf && cf.aktiv), r = abSchritt(pl.learn.lg, e, akt);
    if (r.genutzt && akt && r.rueckfall) {
        pl.learn.rueckfall = {ts: now, bis: now + DRIFT.rbSperrTage * 86400000, grund: 'Kandidat im A/B schlechter als das Plan-Modell (CUSUM ' + Math.round(pl.learn.lg.rb.s * 10) / 10 + ')', stand: (pl.learn.coefHist || []).slice(-1)[0] || null};
        cf.aktiv = false; pl.learn.lg.rb = {s: 0, an: false};
    }
}

if (pl.acc && pl.acc.s !== s0) {                                                               // Slot abgeschlossen: Ist-Werte festhalten und mit den frueheren Plaenen vergleichen
    var a = pl.acc;
    if (a.n >= 8) {
        var actual = {at: a.atN ? a.atS / a.atN : null, pv: a.pvN ? a.pvS / a.pvN : null, price: priceAt(PI.price, a.s), cop: a.elH > 0.005 ? a.thH / a.elH : null,
                      th: a.thH, el: a.elA, defr: a.defrosts, dhw: a.dhwMin, run: a.runMin, hz: a.hzN ? a.hzS / a.hzN : null, q: a.q === undefined ? null : a.q, soc: a.soc === undefined ? null : a.soc, rooms: a.rooms || {}, wind: a.windN ? a.windS / a.windN : null, cl: a.clN ? a.clS / a.clN : null, owm: a.owN ? a.owS / a.owN : null, to: a.toN ? a.toS / a.toN : null, tc: a.tcN ? a.tcS / a.tcN : null,
                      thA: a.thA, elH: a.elH, defMin: a.defMin, defEl: a.defEl, defTh: a.defTh, spread: a.spN ? a.spS / a.spN : null, vlDev: a.vdN ? a.vdS / a.vdN : null, pump: a.puN ? a.puS / a.puN : null, hc: a.hc};
        var aVals = [actual.at, actual.pv, actual.price, actual.cop, actual.th, actual.el, actual.defr, actual.dhw, actual.run, actual.hz, actual.q, actual.soc, actual.thA, actual.elH, actual.defMin, actual.defEl, actual.defTh, actual.spread, actual.vlDev, actual.pump, actual.hc].map(function (v, i) { return c(v, i === 0 || i === 9 ? 2 : 3); })
            .concat(roomIds.map(function (id) { return c(actual.rooms[id], 2); }))
            .concat([c(actual.wind, 2), c(actual.cl, 0), c(actual.owm, 2), c(actual.to, 2), c(actual.tc, 2)]);
        var kOk = ok(a.kw), kVals = kOk ? [c(a.elAK, 3), c(a.elHK, 3), c(a.elHK > 0.005 ? a.thH / a.elHK : null, 3), String(a.kw)] : ['', '', '', ''];
        var mo = monthOf(a.s);
        if (actual.pv !== null) { pl.pvHist = (pl.pvHist || []).concat([actual.pv * Q15 / H / 1000]).slice(-8); }                // PV-Energie der letzten 8 Slots (2 h): Startwert der Sonnenglaettung
        if (pl.tg && actual.at !== null && actual.owm !== null) { pl.tg.rows.push([dayStart(a.s), new Date(a.s).getHours(), Math.round((actual.at - actual.owm) * 100) / 100]); pl.tg.rows = pl.tg.rows.filter(function (x) { return x[0] >= dayStart(a.s) - 5 * 86400000; }); }   // Tagesgang Fuehler - OWM (Modell v3)
        if (pl.bias && actual.at !== null && actual.owm !== null && actual.wind !== null) {       // Lernzeile der Fuehlerkorrektur (gleiche Merkmale wie bei der Rueckrechnung); vor der Rueckrechnung noch nicht angelegt
            pl.bias.rows.push({day: stamp(a.s).slice(0, 10), d: actual.at - actual.owm, f: biasFeat(new Date(a.s).getHours(), actual.wind, actual.pv, actual.cl)});
            if (pl.bias.rows.length > 2100) { pl.bias.rows.shift(); }
        }
        var zVals = a.zMin ? [c(a.elZ, 3), String(a.zMin)] : ['', ''];
        out[1] = csvOut('/data/optimizer/plan-actuals-' + mo + '.csv', 'slot_start,' + ACT_COLS.concat(ACT_K).concat(ACT_Z).join(','), [stamp(a.s) + ',' + aVals.concat(kVals).concat(zVals).join(',')]);
        // Vergleich: was wurde damals (vor ca. 0/1/3/6/12/24 h) prognostiziert, was ist tatsaechlich passiert. Kopf unveraendert (Leser nach Spaltenname);
        // seit PLAN_VER 11 (Review-Paket) bleiben Preis, Plan, Kosten, Strafen, Reserve, Attraktivitaet, Empfehlung, Offset und Quiet leer
        var EV_COLS = ['vorlauf_soll_h', 'vorlauf_ist_h', 'plan_zeit', 'prog_aussen', 'prog_feuchte', 'prog_cop', 'prog_preis', 'prog_pv_w', 'prog_bedarf_kwh', 'plan_waerme_kwh', 'prog_kosten_ct_kwh', 'prog_defrost_risiko', 'prog_taupunkt', 'prog_kosten_basis_ct_kwh', 'prog_strafe_defrost_ct_kwh', 'prog_strafe_unsicher_ct_kwh', 'prog_reserve_hinten_kwh', 'prog_reserve_vorn_kwh',
                       'vertrauen_aussen', 'vertrauen_pv', 'attraktivitaet', 'empfehlung', 'offset_hinweis', 'quiet_hinweis'];
        var evLines = [];
        [0, 1, 3, 6, 12, 24].forEach(function (L) {
            var T0 = L === 0 ? Math.floor(a.s / H) * H : Math.round((a.s - L * H) / H) * H;
            var sn = null; (pl.snaps || []).forEach(function (x) { if (x.t0 === T0) { sn = x; } });
            if (!sn) { return; }
            var k = Math.round((a.s - sn.s0) / Q15); if (k < 0 || k >= sn.slots.length) { return; }
            var sl = sn.slots[k], K = sn.cols;
            var g = function (name) { return sl[K.indexOf(name)]; };
            if ((L === 6 || L === 24) && isN(g('bedarf_basis')) && isN(g('bedarf_kand')) && isN(actual.th) && sn.meta && sn.meta.modell_ver === MODELL_VER) {   // nur Schnappschuesse des jetzigen Gebaeudemodells   // Tagesbilanz des Waermebedarf-Modells: Plan-Modell gegen Kandidat (Sonne/Wind) bei 6 und 24 h Vorlauf
                var abD = dayStart(a.s); pl.ab = pl.ab || {d0: abD};
                if (pl.ab.d0 !== abD) { pl.learn.ab = (pl.learn.ab || []).concat([pl.ab]).slice(-21); abTag(pl.ab); pl.lastSave = 0; pl.ab = {d0: abD}; }
                var ab = pl.ab, kk = 'L' + L; ab[kk] = ab[kk] || {n: 0, q: 0, b: 0, k: 0};
                ab[kk].n++; ab[kk].q += actual.th; ab[kk].b += g('bedarf_basis'); ab[kk].k += g('bedarf_kand');
            }
            var recT = {1: 'VORZIEHEN', 0: 'NORMAL', '-1': 'VERSCHIEBEN'}[g('rec')] || '', qT = g('quiet') === undefined || g('quiet') === null ? '' : String(g('quiet')).replace(/,/g, ';');
            evLines.push([stamp(a.s), L, c((a.s - sn.t) / H, 2), stamp(sn.t), c(g('at'), 2), c(g('rh'), 0), c(g('cop'), 2), c(g('price'), 4), c(g('pv'), 0), c(g('bedarf'), 3), c(g('plan'), 3), c(g('kosten'), 2), c(g('defrost'), 2), c(g('taupunkt'), 1), c(g('kosten_basis'), 2), c(g('strafe_defrost'), 2), c(g('strafe_unsicher'), 2), c(g('reserve_hinten'), 3), c(g('reserve_vorn'), 3),
                          c(g('conf_at'), 2), c(g('conf_pv'), 2), c(g('att'), 0), recT, c(g('offset'), 1), qT].concat(aVals).concat([c(g('wind'), 1), c(g('wolken'), 0), c(g('at_korr'), 2), c(g('sonne_kwh'), 3), c(g('bedarf_basis'), 3), c(g('bedarf_kand'), 3), c(g('strom'), 3), sn.meta && ok(sn.meta.cop_korr_w) ? String(sn.meta.cop_korr_w) : ''].concat(kVals)).join(','));
        });
        if (evLines.length) { out[2] = csvOut('/data/optimizer/plan-eval-' + mo + '.csv', 'slot_start,' + EV_COLS.join(',') + ',' + ACT_COLS.join(',') + ',' + EV_COLS2.join(','), evLines); }
    }
    pl.acc = null;
}
if (!pl.acc) { pl.acc = newAcc(s0); }
var acc = fillAcc(pl.acc);
acc.n++;
if (atNow !== null) { acc.atS += atNow; acc.atN++; }
if (pvNowP !== null) { acc.pvS += pvNowP; acc.pvN++; }
var Wx = G('OPT_weather') || {}, wFresh = !!(Wx.ts && now - Wx.ts <= (num(cfg.weather && cfg.weather.maxAgeMin) || 60) * MS_MIN);       // Wetterwerte nur, solange sie frisch sind
var windNow = (wFresh && ok(Wx.wind)) ? plaus('wind', Wx.wind) : null, clNow = (wFresh && ok(Wx.clouds)) ? Wx.clouds : null, owNow = (wFresh && ok(Wx.temp)) ? plaus('ow', Wx.temp) : null;
var toNow = num(G('T_outside')), tcNow = num(G('T_outside_custom'));                              // Regelwert der Waermepumpe und eigener Fuehler (falls gesetzt)
if (windNow !== null) { acc.windS += windNow; acc.windN++; }
if (clNow !== null) { acc.clS += clNow; acc.clN++; }
if (owNow !== null) { acc.owS += owNow; acc.owN++; }
if (toNow !== null) { acc.toS += toNow; acc.toN++; }
if (tcNow !== null) { acc.tcS += tcNow; acc.tcN++; }
if (running) { acc.runMin++; acc.hzS += freq; acc.hzN++; }
var thW = (running && pth !== null) ? pth : 0, elW = (running && pel !== null) ? pel : 0, elWK = (running && pel !== null) ? pelK(pel, true) : 0;      // elWK: mit COP-Korrektur (nur im Lauf)
if (defrost) { var thRawA = hpv('Heat_Power_Production_Extra'); thW = (thRawA !== null && thRawA > -30000 && thRawA < 30000) ? thRawA : 0; }       // Abtauen: echter Waermeentzug (negativ), nicht aus Restwaerme gerechnet
acc.thA += thW * dtH / 1000; acc.elA += elW * dtH / 1000; if (ok(acc.kw)) { acc.elAK += elWK * dtH / 1000; }
if (ZQ.frisch && !dhw) { acc.elZ = (acc.elZ || 0) + ZQ.w * dtH / 1000; acc.zMin = (acc.zMin || 0) + 1; }
if (running && !dhw && !defrost) { acc.thH += thW * dtH / 1000; acc.elH += elW * dtH / 1000; if (ok(acc.kw)) { acc.elHK += elWK * dtH / 1000; } }
if (dhw) { acc.dhwMin++; }
if (defrost) {                                                                                  // Abtauen: Dauer, Strom, Waermeentzug (HeishaMon-Wert mit Vorzeichen)
    acc.defMin++; acc.defEl += elW * dtH / 1000;
    var thD = hpv('Heat_Power_Production_Extra'); if (thD !== null && thD > -30000 && thD < 30000) { acc.defTh += thD * dtH / 1000; }
}
var solVLp = num(G('TOP42_Z1_Water_Target_Temp')), puSp = hpv('Pump_Speed');
if (running && !defrost) {                                                                      // Regelguete und Hydraulik im Betrieb: Spreizung, Abweichung des Vorlaufs vom Soll, Pumpendrehzahl
    if (spread !== null) { acc.spS += spread; acc.spN++; }
    if (solVLp !== null && istVL !== null) { acc.vdS += solVLp - istVL; acc.vdN++; }
    if (puSp !== null) { acc.puS += puSp; acc.puN++; }
}
acc.hc = hpv('Heating_Control');
if (defrost && !pl.prevDefrost) { acc.defrosts++; }
pl.prevDefrost = defrost;
acc.q = qLevel; acc.soc = piFresh && ok(PI.soc) ? PI.soc : acc.soc;
acc.rooms = {}; ROOMS.forEach(function (rc) { var r = Rr[rc.id]; if (r && r.ts && now - r.ts < (rc.maxAgeMin || 90) * MS_MIN && ok(r.ema)) { acc.rooms[rc.id] = r.ema; } });
// Tagessumme fuer das Lernen: Heizgradstunden gegen gelieferte Waerme (ohne Warmwasser und Abtauen)
var d0 = dayStart(now);
if (pl.day && pl.day.d0 !== d0) {
    if (pl.day.n >= 1200) {                                                                    // Eintrag: [d0, hdd, q, n] wie bisher, dahinter (nur anhaengen) s, wk, khW, wkW, dtr, sN, wN, owN, wwN, wkT, wkWT (Wind ueber 4 m/s); Zaehler unter 90 % der Minuten -> null
        var dd = fillDay(pl.day), part = function (v, cnt, dg) { return cnt >= 0.9 * dd.n ? Math.round(v * dg) / dg : null; }, dtrL = [];
        var skI = function (v, cnt) { return cnt >= 0.9 * dd.n ? Math.round(v * dd.n / cnt * 100) / 100 : null; };     // auf den ganzen Tag hochgerechnet (Minuten ohne Raumwert fehlen)
        Object.keys(dd.r0).forEach(function (id) { if (ok(dd.rl[id])) { dtrL.push(dd.rl[id] - dd.r0[id]); } });
        var dtrM = dtrL.length ? Math.round(dtrL.reduce(function (x, y) { return x + y; }, 0) / dtrL.length * 1000) / 1000 : null;
        var entry = [dd.d0, Math.round(dd.hdd * 100) / 100, Math.round(dd.q * 1000) / 1000, dd.n, part(dd.s, dd.sN, 1000), part(dd.wk, dd.wN, 100), part(dd.khW, dd.owN, 100), part(dd.wkW, dd.wwN, 100), dtrM, dd.sN, dd.wN, dd.owN, dd.wwN, part(dd.wkT, dd.wTN, 100), part(dd.wkWT, dd.wwTN, 100),
                     dd.lgN >= 0.9 * dd.n ? lgFlags(dd) : null, dd.dhwM, dd.defM, dd.gapM, dd.engM, dd.unpM,       // 15: Lern-Gate (Bitmaske, 0 = lernt mit), 16-20: Minuten Warmwasser, Abtauen, Datenluecke, Eingriff, unplausibel
                     skI(dd.khI, dd.kiN), dd.tiN >= 0.9 * dd.n ? Math.round(dd.tiS / dd.tiN * 100) / 100 : null, skI(dd.wkI, dd.wiN), skI(dd.khIW, dd.kiwN), skI(dd.wkIW, dd.wiwN)];   // 21-25 (Modell v3): K*h gegen T_innen (Fuehler), T_innen, Wind x (T_innen - T_aussen), dasselbe mit OWM
        pl.learn.days.push(entry);
        var dayMsg = csvOut('/data/optimizer/plan-days-' + monthOf(dd.d0 + 6 * H) + '.csv', 'tag,kh_fuehler,kh_owm,waerme_kwh,minuten,pv_kwh,wk_fuehler,wk_owm,dtr_k,min_pv,min_wind,min_owm,wk_tot_fuehler,wk_tot_owm,kh_innen_fuehler,t_innen',
                            [stamp(dd.d0).slice(0, 10) + ',' + [entry[1], entry[6], entry[2], entry[3], entry[4], entry[5], entry[7], entry[8], entry[9], entry[10], entry[11], entry[13], entry[14], entry[21], entry[22]].map(function (v) { return c(v, 3); }).join(',')]);
        out[1] = out[1] ? [out[1], dayMsg] : dayMsg;                                               // Tagesblatt fuer die Auswertung (eine Zeile je abgeschlossenem Tag)
    }
    while (pl.learn.days.length > pn('learnDays', 21)) { pl.learn.days.shift(); }
    pl.day = null; pl.lastSave = 0;
}
if (!pl.day) { pl.day = {d0: d0, hdd: 0, q: 0, n: 0}; }
fillDay(pl.day);
pl.day.n++;
var HREF = pn('hddRefC', 15);                                                                    // nur Lern-Filter und die alten Merkmale (Heizgradstunden unter 15 °C)
if (atNow !== null) { pl.day.hdd += Math.max(0, HREF - atNow) / 60; }
if (running && !dhw && !defrost && pth !== null) { pl.day.q += pth * dtH / 1000; }
if (pvNowP !== null) { pl.day.s += pvNowP * dtH / 1000; pl.day.sN++; }                          // PV-Energie des Tages [kWh] (Sonnenmass, solange die Daten frisch sind)
pl.day.lgN++; if (dhw) { pl.day.dhwM++; } if (defrost) { pl.day.defM++; } if (!hpFrisch) { pl.day.gapM++; } if (eingriff) { pl.day.engM++; } if (unpl.length) { pl.day.unpM++; pl.day.unpK = pl.day.unpK || {}; unpl.forEach(function (k) { pl.day.unpK[k] = (pl.day.unpK[k] || 0) + 1; }); }
if (owNow !== null && atNow !== null) { pl.day.khW += Math.max(0, HREF - owNow) / 60; pl.day.owN++; }                      // Heizgradstunden aus der OWM-Temperatur (regional)
if (windNow !== null && atNow !== null) { pl.day.wk += Math.max(0, HREF - atNow) * windNow / 60; pl.day.wN++; }          // Wind x Heizgradstunden (Fuehler)
if (windNow !== null && owNow !== null) { pl.day.wkW += Math.max(0, HREF - owNow) * windNow / 60; pl.day.wwN++; }      // Wind x Heizgradstunden (OWM)
if (windNow !== null && atNow !== null) { pl.day.wkT += Math.max(0, HREF - atNow) * windEff(windNow) / 60; pl.day.wTN++; }     // dasselbe mit Wind ueber der Totzone (MODELL_VER 2; eigene Zaehler: ein Tag, der vor dem Deploy begann, bleibt null)
if (windNow !== null && owNow !== null) { pl.day.wkWT += Math.max(0, HREF - owNow) * windEff(windNow) / 60; pl.day.wwTN++; }
ROOMS.forEach(function (rc) { var r = Rr[rc.id]; if (r && r.ts && now - r.ts < (rc.maxAgeMin || 90) * MS_MIN && ok(r.ema)) { if (pl.day.r0[rc.id] === undefined) { pl.day.r0[rc.id] = r.ema; } pl.day.rl[rc.id] = r.ema; } });
var tiNow = (function () { var s1 = 0, n1 = 0; Object.keys(acc.rooms).forEach(function (id) { s1 += acc.rooms[id]; n1++; }); return n1 ? s1 / n1 : null; })();   // T_innen jetzt: Mittel der Raeume mit frischem Wert (wie ist_raum_*)
if (tiNow !== null) {                                                                              // Modell v3: Kelvinstunden gegen T_innen (nicht gekappt), Wind ueber der Totzone x (T_innen - T_aussen)
    pl.day.tiS += tiNow; pl.day.tiN++;
    if (atNow !== null) { pl.day.khI += (tiNow - atNow) / 60; pl.day.kiN++; if (windNow !== null) { pl.day.wkI += (tiNow - atNow) * windEff(windNow) / 60; pl.day.wiN++; } }
    if (owNow !== null) { pl.day.khIW += (tiNow - owNow) / 60; pl.day.kiwN++; if (windNow !== null) { pl.day.wkIW += (tiNow - owNow) * windEff(windNow) / 60; pl.day.wiwN++; } }
}

// ---------- Gebaeudemodell (Fahrplan v2, S2): Rueckrechnung aus plan-actuals und Regression, nur BERECHNEN und ANZEIGEN (wirkt nicht auf den Plan)
function readActualRows() {                                                                        // plan-actuals der letzten Wochen (alle Kopfzeilen-Abschnitte, Zuordnung ueber Spaltennamen)
    var rowsA = [], mo0 = new Date(now - pn('learnDays', 21) * 86400000), moN = new Date(now);
    for (var mm = new Date(mo0.getFullYear(), mo0.getMonth(), 1); mm <= moN; mm = new Date(mm.getFullYear(), mm.getMonth() + 1, 1)) {
        try { rowsA = rowsA.concat(parseCsv(fs.readFileSync('/data/optimizer/plan-actuals-' + mm.getFullYear() + '-' + ('0' + (mm.getMonth() + 1)).slice(-2) + '.csv', 'utf8'))); } catch (e) { /* keine Datei */ }
    }
    return rowsA;
}
if (!pl.bf || pl.bf.v !== MODELL_VER) {                                                          // einmal je Prozess (und nach einem Modellwechsel): abgeschlossene Tage aus den Ist-Dateien der letzten Wochen
    pl.bf = {days: [], v: MODELL_VER};
    try { pl.bf.days = daysFromRows(readActualRows(), HREF).filter(function (d) { return d.d0 < dayStart(now) && d.n >= 1200; }); } catch (e) { pl.bf.days = []; }
}
if (!pl.tg) {                                                                                      // Tagesgang Fuehler - OWM (Modell v3): Slots der letzten Tage aus den Ist-Dateien, danach je abgeschlossenem Slot
    pl.tg = {rows: []};
    try { readActualRows().forEach(function (r) { var at0 = nz(r.ist_aussen), ow0 = nz(r.ist_aussen_owm), st = r.slot_start; if (at0 !== null && ow0 !== null && st && st.length >= 16) { var d00 = d0Of(st.slice(0, 10)); if (d00 >= dayStart(now) - 5 * 86400000) { pl.tg.rows.push([d00, Number(st.slice(11, 13)), Math.round((at0 - ow0) * 100) / 100]); } } }); } catch (e) { pl.tg.rows = []; }
}
if (!pl.bias) {                                                                                    // Lernzeilen der Fuehlerkorrektur (OWM-Temperatur und Wind gibt es erst ab Fahrplan v2 S1)
    pl.bias = {rows: []};
    try { pl.bias.rows = biasRowsFromRows(readActualRows()).slice(-2100); } catch (e) { pl.bias.rows = []; }
}
function modelDays() {                                                                             // Live-Tage und Rueckrechnung zusammenfuehren (Live gilt fuer kh, q, n; fehlende Zusatzwerte kommen aus der Rueckrechnung)
    var map = {}, order = [];
    (pl.bf.days || []).forEach(function (d) { map[d.d0] = d; order.push(d.d0); });
    (pl.learn.days || []).forEach(function (a) {
        var d = dayFromArr(a), b = map[d.d0];
        if (b) { ['s', 'wk', 'khW', 'wkW', 'dtr', 'wkT', 'wkWT', 'flags', 'khI', 'ti', 'wkI', 'khIW', 'wkIW'].forEach(function (k) { if (d[k] === null && b[k] !== undefined) { d[k] = b[k]; } }); } else { order.push(d.d0); }
        map[d.d0] = d;
    });
    pl.tiTage = order.map(function (k) { return map[k]; }).filter(function (d) { return d.n >= 1200 && isN(d.ti); }).sort(function (x, y) { return x.d0 - y.d0; });   // T_innen: alle vollen Tage (auch warme)
    var alle = order.map(function (k) { return map[k]; }).filter(function (d) { return d.n >= 1200 && d.kh >= pn('learnMinHdd', 30); });
    pl.lgVerw = alle.filter(function (d) { return d.flags > 0; }).map(function (d) { return [d.d0, d.flags]; });           // Lern-Gate: Tage mit Warmwasser/Abtauen/Luecke/Eingriff/unplausibel lernen nicht mit
    return alle.filter(function (d) { return !(d.flags > 0); }).sort(function (x, y) { return x.d0 - y.d0; });
}
var MP = {ua0: pn('uaKwPerK', 0.15), g0: pn('gainKw', 0.3), priorTage: pn('priorDays', 2), priorX: [10, 16], uaLo: pn('uaMin', 0.07), uaHi: pn('uaMax', 0.35), gLo: 0, gHi: pn('gainMax', 1.2),
          lernMinTage: pn('lernMinTage', 2), sW: 0.01, sS: 0.10, minDays: pn('coefMinDays', 10), minWindDays: 7, storeC: [0, 3, 6, 10],
          tiStd: pn('tiDefaultC', 22), tiMin: pn('tiMin', 18), tiMax: pn('tiMax', 25), stepUaRel: pn('stepUaRel', 0.15), stepGainKw: pn('stepGainKw', 0.15), stepTiK: pn('stepTiK', 0.5)};
var mDays = modelDays(), mSig = 'v' + MODELL_VER + '|' + mDays.length + '|' + mDays.map(function (d) { return d.d0 + ':' + Math.round(d.q * 100) + ':' + (d.s === null ? '-' : Math.round(d.s * 10)) + ':' + (d.wkT === null || d.wkT === undefined ? '-' : Math.round(d.wkT)) + ':' + (isN(d.khI) ? Math.round(d.khI) : '-') + ':' + (isN(d.wkI) ? Math.round(d.wkI) : '-'); }).join(',');
if (!pl.learn.coef || pl.learn.coef.sig !== mSig) {
    try {
        var fm = fitModel(mDays, MP);
        var prevAkt = !!(pl.learn.coef && pl.learn.coef.aktiv && pl.learn.coef.ver === MODELL_VER), cand = fm.maeWind !== null ? fm.maeWind : fm.maeSun;   // aktiv nur aus demselben Modell (Version) uebernehmen
        fm.sig = mSig; fm.ts = now; fm.ver = MODELL_VER;
        // Aktivierung nur mit ausdruecklichem Schalter (plan.coefActivate = 1): Gate ok, oder schon aktiv und der Fehler bleibt besser als beim bisherigen Modell (Hysterese)
        // Sicherheit: die Hysterese gilt nie bei hartem Koeffizienten-Fehler (nicht endlich/negativ/zu gross); bei gleichfoermigen PV-Tagen (Sonne nicht identifizierbar) wird der Sonnenterm des bisher aktiven Modells eingefroren
        if (prevAkt && fm.gate && fm.gate.why.indexOf('PV-Tage zu gleichfoermig') >= 0 && !coefHardFail(fm.gate)) { var pc = pl.learn.coef; fm.bs = coefSafe({bs: pc.bs, bw: 0}).bs; if (fm.bsW !== undefined) { fm.bsW = coefSafe({bs: pc.bsW !== undefined ? pc.bsW : pc.bs, bw: 0}).bs; } fm.frozen = ['Sonne']; }
        var rfS = pl.learn.rueckfall && now < pl.learn.rueckfall.bis;                                  // Absicherung (D): nach einem Rueckfall bleibt der Kandidat gesperrt
        if (rfS && fm.gate) { fm.gate.why.push('Rückfall bis ' + stamp(pl.learn.rueckfall.bis).slice(8, 10) + '.' + stamp(pl.learn.rueckfall.bis).slice(5, 7) + '.'); fm.gate.ok = false; }
        fm.aktiv = !rfS && pn('coefActivate', 0) === 1 && !coefHardFail(fm.gate) && ((fm.gate && fm.gate.ok) || (prevAkt && fm.n >= pn('coefMinDays', 10) && cand !== null && fm.maeBase > 0 && cand <= fm.maeBase));
        if (fm.aktiv) { pl.learn.coefHist = (pl.learn.coefHist || []).concat([{ts: now, sig: fm.sig, ua: fm.uaWind || fm.uaSun, bs: fm.maeWind !== null ? fm.bsW : fm.bs, bw: fm.bw, maeBase: fm.maeBase, cand: cand}]).slice(-DRIFT.ring); }   // Schnappschuss der Lernwerte je aktiver Neuberechnung
        pl.learn.coef = fm; pl.lastSave = 0;                                                      // neue Koeffizienten sofort sichern (ueberstehen so einen Neustart ohne Neuberechnung)
    } catch (e) { pl.learn.coef = {n: 0, sig: mSig, ts: now, aktiv: false, error: String(e && e.message || e)}; }
}

// ---------- Gebaeudemodell v3 im Plan (Entscheidung 2): Ziel = gelerntes Grundmodell (ab lernMinTage Lerntagen, sonst Vorwert) und T_innen der Vortage; langsame Anpassung je Tag
(function () {
    var cfM = pl.learn.coef || {}, tz = tiZiel(pl.tiTage || [], pn('tiDays', 3), tiNow, MP);
    var ziel = {ua: cfM.gelernt && isN(cfM.ua) ? cfM.ua : MP.ua0, g: cfM.gelernt && isN(cfM.g) ? cfM.g : MP.g0, ti: tz.ti, n: cfM.n || 0, gelernt: !!cfM.gelernt, quelle: cfM.gelernt ? 'gelernt aus ' + cfM.n + ' Tagen' : 'Vorwert'};
    pl.learn.mdl = modellSchritt(pl.learn.mdl, ziel, dayStart(now), MP); pl.learn.mdl.tiN = tz.n; pl.learn.mdl.ziel = {ua: ziel.ua, g: ziel.g, ti: ziel.ti};
})();
var MDL = pl.learn.mdl, BIL = MDL.ti - MDL.g / MDL.ua;                                              // Bilanzpunkt: ab dieser Aussentemperatur kein Waermebedarf

// ---------- Fuehlerkorrektur OWM -> Fuehler (Fahrplan v2, S2b): stuendlich neu schaetzen, nur Anzeige und Protokoll (wirkt nicht auf den Plan)
var hBias = Math.floor(now / H) * H;
if (pl.biasHour === undefined && pl.learn.bias && pl.learn.bias.ts) { pl.biasHour = Math.floor(pl.learn.bias.ts / H) * H; }       // nach einem Neustart den gesicherten Stand dieser Stunde behalten
if (pl.biasHour !== hBias || !pl.learn.bias) {
    pl.biasHour = hBias;
    try { var bf2 = biasFit(pl.bias.rows); var bg = biasGate(bf2); pl.learn.bias = {coef: bf2.coef, n: bf2.n, days: bf2.days, maeZero: bf2.maeZero, maeMean: bf2.maeMean, maeMod: bf2.maeMod, gateOk: bg.ok, why: bg.why, aktiv: false, ts: now}; pl.lastSave = 0; }
    catch (e) { pl.learn.bias = {coef: null, n: 0, days: 0, aktiv: false, ts: now, error: String(e && e.message || e)}; }
}

// ---------- Vorschau berechnen: einmal pro 15-Minuten-Slot, bis sie gelingt jede Minute
// Review-Paket 13.10.2026: keine Verteilung nach Tarif (21/31 ct) mehr, keine Empfehlungen (VORZIEHEN/VERSCHIEBEN, Offset ±2 K, Quiet-Hinweis), keine Ersparnis.
// Begruendung (Messung 08.–12.10.): Netzbezug fast 0, Grenzkosten flach (~6–7 ct Einspeiseverguetung); bestes gegen schlechtestes 3-h-Fenster im COP 6,6 gegen 5,5
// -> 0,03 kWh Strom je verschobener kWh Waerme, der Mehrverlust des waermeren Hauses kostet 0,01–0,06 -> netto −1,2…+0,4 % des Tagesstroms; die Raeume haben im warmen
// Fenster keine Luft nach oben (−0,8…+0,1 K bis Maximum). Uebrig bleibt die Bedarfs-/COP-Vorschau: Waermebedarf, COP aus der Messung, Strom je Slot.
var SHIFT_LOSS = [0.01, 0.06];                                                                   // Mehrverlust je verschobener kWh Waerme (kWh Strom), Spanne aus UA 0,15–0,22 kW/K und C 3–10 kWh/K (Messung 08.–12.10.)
function copTable(qs0, carnotF, curveF) {                                                       // gemessener COP je Aussenband aus dem Kennfeld des Quiet-Waechters (alle Stufen, Comfort und Efficiency, ohne Abtauen/Warmwasser);
                                                                                                 // Strom mit COP-Korrektur: das Kennfeld zaehlt nur Laufminuten und speichert TOP16 roh, je Minute kommt COP_KW dazu
    var bands = {}, minMin = pn('copMinMin', 60);
    [qs0.kf || {}, qs0.kfE || {}].forEach(function (store) {
        Object.keys(store).forEach(function (k) {
            var s = store[k], bi = k.split('|')[1]; if (!s || !s.s || !(s.n > 0)) { return; }
            var a = s.s.pth, e = s.s.pel, t = s.s.at; if (!a || !e || !t || !a[1] || !e[1] || !t[1]) { return; }
            var b = bands[bi] = bands[bi] || {n: 0, th: 0, el: 0, atS: 0};
            b.n += s.n; b.th += a[0] / a[1] * s.n; b.el += (e[0] / e[1] + COP_KW) * s.n; b.atS += t[0] / t[1] * s.n;
        });
    });
    var pts = Object.keys(bands).map(function (bi) { var b = bands[bi]; return {bi: Number(bi), n: b.n, at: b.atS / b.n, cop: b.el > 0 ? b.th / b.el : null}; })
        .filter(function (p) { return p.n >= minMin && p.cop !== null && p.cop > 1 && p.cop < 12; }).sort(function (x, y) { return x.at - y.at; });
    return {pts: pts, at: function (t) {                                                         // linear zwischen den Baendern, ausserhalb mit dem Carnot-Verhaeltnis zum naechsten Band
        if (!pts.length) { return null; }
        var near = null;
        if (t <= pts[0].at) { near = pts[0]; } else if (t >= pts[pts.length - 1].at) { near = pts[pts.length - 1]; }
        if (near) {
            var c1 = carnotF(t, curveF(t)), c0 = carnotF(near.at, curveF(near.at));
            return (c1 !== null && c0 !== null && c0 > 0) ? near.cop * c1 / c0 : near.cop;
        }
        for (var j = 1; j < pts.length; j++) { if (t <= pts[j].at) { return lerp(t, pts[j - 1].at, pts[j - 1].cop, pts[j].at, pts[j].cop); } }
        return pts[pts.length - 1].cop;
    }};
}
function buildPlan() {
    var P = {s0: s0, t: now, ver: PLAN_VER, status: 'ok', why: '', slots: null};
    // Wetter-Prognose (OWM, 3-Stunden-Punkte)
    var W = G('OPT_weather') || {};
    var pts = (Array.isArray(W.fpts) ? W.fpts : []).filter(function (p) { return ok(p[0]) && ok(p[1]); }).sort(function (x, y) { return x[0] - y[0]; });
    if (!(W.f_ts && now - W.f_ts < 2 * H && pts.length >= 3 && pts[pts.length - 1][0] >= now + 18 * H)) { P.status = 'keine Wetterprognose'; P.why = 'Die Wetterprognose fehlt oder ist zu alt oder zu kurz.'; return P; }
    function wAt(t, idx) {
        if (t <= pts[0][0]) { return num(pts[0][idx]); }
        for (var i = 1; i < pts.length; i++) {
            if (pts[i][0] >= t) { var y0 = num(pts[i - 1][idx]), y1 = num(pts[i][idx]); return (y0 === null || y1 === null) ? null : lerp(t, pts[i - 1][0], y0, pts[i][0], y1); }
        }
        return num(pts[pts.length - 1][idx]);
    }
    // Heizkurve der Waermepumpe (Soll-Vorlauf je Aussentemperatur): fuer den Carnot-Wert (Rueckfall und Extrapolation des gemessenen COP)
    var cvLo = num(G('Z1_Heat_Curve_Outside_Low_Temp')), cvHi = num(G('Z1_Heat_Curve_Outside_High_Temp')), cvTl = num(G('Z1_Heat_Curve_Target_Low_Temp')), cvTh = num(G('Z1_Heat_Curve_Target_High_Temp'));
    if (cvLo === null || cvHi === null || cvTl === null || cvTh === null || cvHi <= cvLo) { P.status = 'keine Heizkurve'; P.why = 'Die Heizkurve der Wärmepumpe ist nicht bekannt.'; return P; }
    var minVlC = num((cfg.control || {}).minVlC); if (minVlC === null) { minVlC = 29; }
    var curve = function (t) { return Math.max(minVlC, t <= cvLo ? cvTh : (t >= cvHi ? cvTl : cvTh + (cvTl - cvTh) * (t - cvLo) / (cvHi - cvLo))); };

    // Prognosevertrauen je Vorlauf: konservative Standardwerte, die die gemessene Prognoseguete nur langsam (n / (n + n0)) veraendert
    var fq = flow.get('enFq') || jload('/data/optimizer/forecast-quality.json', {at: {}, pv: {}});
    var HZ = [1, 3, 6, 12, 24], cMin = pn('confMin', 0.2), cMax = pn('confMax', 0.98);
    function anchors(kind) {
        var pri = (PC.confPrior || {})[kind] || {}, n0 = num((PC.confN0 || {})[kind]), sgm = num((PC.confSigma || {})[kind === 'at' ? 'atK' : 'pvRel']);
        if (n0 === null) { n0 = kind === 'at' ? 168 : 100; }
        if (sgm === null) { sgm = kind === 'at' ? 2.5 : 0.6; }
        return HZ.map(function (h) {
            var p = num(pri[h]); if (p === null) { p = Math.max(cMin, 1 - h / 48); }
            var e = (fq[kind] || {})[h], meas = null, n = 0;
            if (e && e.n > 0) {
                if (kind === 'at') { n = e.n; meas = 1 / (1 + Math.pow((e.abs / e.n) / sgm, 2)); }
                else if (e.act > 0) { n = e.n; meas = 1 / (1 + Math.pow((e.abs / e.act) / sgm, 2)); }
            }
            var w = meas === null ? 0 : n / (n + n0);
            return {h: h, c: clamp((1 - w) * p + w * (meas === null ? p : meas), cMin, cMax), n: n, w: w, prior: p, meas: meas};
        });
    }
    var cAt = anchors('at'), cPv = anchors('pv');
    function confAt(an, L) {
        if (L <= an[0].h) { return an[0].c; }
        for (var i = 1; i < an.length; i++) { if (L <= an[i].h) { return lerp(L, an[i - 1].h, an[i - 1].c, an[i].h, an[i].c); } }
        return an[an.length - 1].c;
    }
    P.conf = {at: cAt, pv: cPv};

    // Modellparameter: Waermebedarf (Gebaeudemodell v3, oben gelernt) und COP (gemessen je Aussenband; Rueckfall: Anteil am Carnot-Wert)
    var apE = pn('evapApproachK', 6), apC = pn('condApproachK', 2);
    function carnot(t, vl) { var th = vl + apC + 273.15, tc = t - apE + 273.15; return th > tc + 5 ? th / (th - tc) : null; }
    var qs = flow.get('qs') || {}, kf = qs.kf || {}, etaS = 0, etaN = 0;
    [kf, qs.kfE || {}].forEach(function (store) { Object.keys(store).forEach(function (k) {
        var s = store[k]; if (!s || !s.s || s.n < 10 || !s.s.pth || !s.s.pel || !s.s.vl || !s.s.at || !s.s.pth[1] || !s.s.pel[1] || !s.s.vl[1] || !s.s.at[1]) { return; }
        var ca = carnot(s.s.at[0] / s.s.at[1], s.s.vl[0] / s.s.vl[1]), co = (s.s.pth[0] / s.s.pth[1]) / (s.s.pel[0] / s.s.pel[1] + COP_KW);     // COP mit COP-Korrektur (Ø Waerme ÷ Ø Strom + COP_KW)
        if (ca !== null && ca > 1 && co > 0.5 && co < 12) { etaS += (co / ca) * s.n; etaN += s.n; }
    }); });
    var etaP = pn('etaPrior', 0.45), etaW = etaN / (etaN + pn('etaPriorMin', 600)), eta = clamp((1 - etaW) * etaP + etaW * (etaN ? etaS / etaN : etaP), 0.25, 0.75);
    var CT = copTable(qs, carnot, curve), copMax = pn('copMax', 8);
    var tgP = tgProfil(pl.tg ? pl.tg.rows : [], dayStart(now), pn('biasDays', 3)), bAt = function (t) { return tgP ? tgP[new Date(t).getHours()] : 0; };   // Tagesgang Fuehler - OWM (3 Vortage)
    P.model = {ua: MDL.ua, g: MDL.g, ti: MDL.ti, tbal: BIL, uaDays: MDL.n, uaLearned: !!MDL.gelernt, quelle: MDL.quelle, gebremst: !!MDL.gebremst, ziel: MDL.ziel, tiTage: MDL.tiN, tg: tgP ? 1 : 0, ver: MODELL_VER, eta: eta, etaMin: etaN, etaW: etaW, copKw: COP_KW, copPts: CT.pts.map(function (p) { return [Math.round(p.at * 10) / 10, Math.round(p.cop * 100) / 100, p.n]; })};

    // Prognose je Slot (Aufloesung der Quellen bleibt bekannt: Temperatur 3 h, PV 1 h bzw. 15 min)
    var owmNow = wAt(now, 1), anchor = (atNow !== null && owmNow !== null) ? clamp(atNow - owmNow - bAt(now), -5, 5) : 0, tauA = pn('anchorTauH', 4);   // OWM + Tagesgang, am Fuehler verankert (Rest klingt mit 4 h ab)
    var raw = [], i;
    var pvArr = piFresh ? PI.pv : null, pvRes = Array.isArray(pvArr) && pvArr.length ? pvArr[0][2] / MS_MIN : null;
    function pvMean(a, b) {
        if (!Array.isArray(pvArr) || !pvArr.length) { return null; }
        var sw = 0, dt = 0;
        pvArr.forEach(function (x) { var q0 = x[0], q1 = x[0] + x[2], o = Math.min(q1, b) - Math.max(q0, a); if (o > 0) { sw += x[1] * o; dt += o; } });
        return dt >= (b - a) * 0.9 ? sw / dt : null;
    }
    for (i = 0; i < N; i++) {
        var t = s0 + i * Q15, ctr = t + Q15 / 2, L = Math.max(0, (ctr - now) / H);
        var atF = wAt(ctr, 1), rhF = wAt(ctr, 2);
        if (atF === null) { P.status = 'keine Wetterprognose'; P.why = 'Für ' + hhmm(t) + ' fehlen Daten.'; return P; }
        raw.push({t: t, L: L, atF: atF + bAt(ctr) + anchor * Math.exp(-L / tauA), owm: atF, rhF: rhF, pv: pvMean(t, t + Q15), windF: wAt(ctr, 4), clF: wAt(ctr, 3)});
    }
    var m24 = 0, r24 = 0, rn = 0;
    for (i = 0; i < NDAY; i++) { m24 += raw[i].atF; if (raw[i].rhF !== null) { r24 += raw[i].rhF; rn++; } }
    var atRef = m24 / NDAY, rhRef = rn ? r24 / rn : 70;                                         // Schrumpfziel: Tagesmittel der Prognose
    function defr(t, rh) {
        var rT = t <= -10 ? 0.15 : (t <= -5 ? lerp(t, -10, 0.15, -5, 0.5) : (t <= -2 ? lerp(t, -5, 0.5, -2, 0.95) : (t <= 3 ? 1 : (t <= 6 ? lerp(t, 3, 1, 6, 0.3) : (t <= 8 ? lerp(t, 6, 0.3, 8, 0) : 0)))));
        var rH = clamp((rh - 55) / 35, 0, 1);
        return rT * (0.3 + 0.7 * rH);
    }
    function dewp(t, rh) { var a = 17.62, b = 243.12, g = Math.log(Math.max(rh, 1) / 100) + a * t / (b + t); return b * g / (a - g); }
    // Abtau-Abzug (Winterpaket 16.10.2026, Forum LEISHA_WISSEN 10 Punkt 5 und (b) 8): 10–30 Abtauungen am Tag (0,3–1,6 kWh je Abtauung, ~8 min ohne Heizen: 3810731, 4076731,
    // 4084491) senken den Tages-COP um grob 5–15 %; die gemessenen Baender und Carnot enthalten keine Abtauung. Abzug je Slot = abtauAbzug (10 %, Mitte) x Abtaurisiko 0..1 (ANNAHME)
    var ABZ_PLAN = clamp(pn('abtauAbzug', 0.10), 0, 0.3);
    var slots = [];
    // Sonne und Wind im Bedarf (Fahrplan v2, S3): wirken nur, wenn die gelernten Koeffizienten aktiviert sind; sonst bit-identisch zum bisherigen Modell. Der Kandidat wird immer mitgerechnet und protokolliert.
    var cfM = pl.learn.coef || null;
    var candC = coefSafe((cfM && cfM.n >= 3) ? (cfM.maeWind !== null && cfM.maeWind !== undefined ? {bs: cfM.bsW || 0, bw: cfM.bw || 0} : {bs: cfM.bs || 0, bw: 0}) : {bs: 0, bw: 0});
    var useC = (cfM && cfM.aktiv) ? candC : {bs: 0, bw: 0};
    var solMax = pn('solarMaxShare', 0.6), tauS = pn('solarTauH', 2), alphaS = 1 - Math.exp(-(Q15 / H) / tauS), sPrev = (pl.pvHist && pl.pvHist.length >= 4) ? pl.pvHist.reduce(function (x, y) { return x + y; }, 0) / pl.pvHist.length : 0;
    var wSum = 0, wCnt = 0; for (i = 0; i < NDAY; i++) { if (ok(raw[i].windF)) { wSum += raw[i].windF; wCnt++; } }
    var windRef = wCnt ? wSum / wCnt : 0;
    raw.forEach(function (x) {
        var cA = confAt(cAt, x.L), cP = confAt(cPv, x.L);
        var atE = cA * x.atF + (1 - cA) * atRef, rhE = cA * (x.rhF === null ? rhRef : x.rhF) + (1 - cA) * rhRef;   // je schlechter die Prognose, desto weniger weicht sie vom Tagesmittel ab
        var vl = curve(atE), copM = CT.at(atE), cg = carnot(atE, vl), copSrc = copM !== null ? 'Messung' : 'Carnot';
        var cop = copM !== null ? copM : (cg === null ? 3 : eta * cg);
        cop = clamp(cop, 1.5, copMax);
        var dK = Math.max(0, MDL.ti - atE), bas = Math.max(0, MDL.ua * (MDL.ti - atE) - MDL.g) * (Q15 / H), bedarf;   // bas: Grundmodell v3 (kWh Waerme je Slot); dK: Wind-Merkmal (T_innen - T_aussen)
        var sRaw = ok(x.pv) ? cP * x.pv * (Q15 / H) / 1000 : 0; sPrev = sPrev + (sRaw - sPrev) * alphaS; var sunE = sPrev;      // PV-Energie des Slots (mit Vertrauen gewichtet), mit Waermeverzoegerung geglaettet
        var windE = ok(x.windF) ? windEff(cA * x.windF + (1 - cA) * windRef) : 0;                    // Wind ueber der Totzone (4 m/s), wie im Fit
        var solU = Math.min(useC.bs * sunE, solMax * bas), winU = useC.bw * dK * windE * (Q15 / H);
        var solK = Math.min(candC.bs * sunE, solMax * bas), winK = candC.bw * dK * windE * (Q15 / H), kand = Math.max(0, bas + winK - solK);
        bedarf = Math.max(0, bas + winU - solU);                                                    // Koeffizienten 0 -> bedarf === bas
        var atK = null, bcf = pl.learn.bias && pl.learn.bias.coef;
        if (bcf) {                                                                                  // Fuehlerkorrektur: OWM + Versatz(Merkmale des Slots) + abklingender Rest des heutigen Versatzes (nur Protokoll)
            var atO = x.owm, dHat = biasDot(bcf, biasFeat(new Date(x.t).getHours(), x.windF, x.pv, x.clF));
            var dNow = biasDot(bcf, biasFeat(new Date(now).getHours(), windNow, piFresh ? PI.pvNow : null, clNow)), rest = (atNow !== null && owmNow !== null) ? clamp((atNow - owmNow) - dNow, -5, 5) : 0;
            atK = atO + dHat + rest * Math.exp(-x.L / tauA);
        }
        var riskS = defr(atE, rhE), copAb = cop * (1 - ABZ_PLAN * riskS);                              // Winterpaket: Abtau-Abzug (Waerme beim Abtauen/Wiederaufheizen ist keine Nutzwaerme)
        slots.push({t: x.t, L: x.L, at: atE, atRaw: x.atF, rh: rhE, dew: dewp(atE, rhE), vl: vl, cop: cop, copSrc: copSrc, el: bedarf / cop, copAb: copAb, elAb: bedarf / copAb, pv: x.pv, wind: x.windF, cl: x.clF, atK: atK, sun: sunE, solK: solK, winK: winK, bas: bas, kand: kand, solU: solU, winU: winU, bedarf: bedarf, risk: defr(atE, rhE), cA: cA, cP: cP});
    });
    // Kennzahlen (24 h)
    var sumB = 0, sumEl = 0, sumElAb = 0, sumSol = 0, sumWin = 0, pvKwh = 0, pvN = 0, atMin = null, atMax = null, copMin = null, copMaxV = null, maxD = null;
    for (i = 0; i < NDAY; i++) {
        var q = slots[i]; sumB += q.bedarf; sumEl += q.el; sumElAb += q.elAb; sumSol += q.solU; sumWin += q.winU;
        if (q.pv !== null) { pvKwh += q.pv * 0.25 / 1000; pvN++; }
        if (atMin === null || q.at < atMin) { atMin = q.at; } if (atMax === null || q.at > atMax) { atMax = q.at; }
        if (q.bedarf > 0.0005) { if (copMin === null || q.cop < copMin) { copMin = q.cop; } if (copMaxV === null || q.cop > copMaxV) { copMaxV = q.cop; } }
        var dk = q.bedarf / 0.25; if (maxD === null || dk > maxD.kw) { maxD = {kw: dk, t: q.t}; }
    }
    // Verschieben nach COP (nur Rechnung, keine Empfehlung): bestes gegen schlechtestes 3-h-Fenster der naechsten 24 h
    var W3 = Math.round(pn('windowH', 3) * 4), wBest = null, wWorst = null;
    for (i = 0; i + W3 <= NDAY; i++) {
        var sc = 0; for (var j = i; j < i + W3; j++) { sc += slots[j].cop; }
        if (wBest === null || sc / W3 > wBest.v) { wBest = {i: i, v: sc / W3}; } if (wWorst === null || sc / W3 < wWorst.v) { wWorst = {i: i, v: sc / W3}; }
    }
    var gain = (wBest && wWorst && wBest.v > 0 && wWorst.v > 0) ? 1 / wWorst.v - 1 / wBest.v : null;
    P.minVlC = minVlC; P.maxDemand = maxD; P.elModel = sumEl; P.vrmHp = (PI.vrmHpKwh === undefined || PI.vrmHpKwh === null) ? null : PI.vrmHpKwh;
    P.slots = slots; P.enough = sumB >= pn('minDemandKwh', 4); P.eta = eta;
    P.sum = {solU: sumSol, winU: sumWin, bedarf: sumB, el: sumEl, cop: sumEl > 0 ? sumB / sumEl : null, elAb: sumElAb, copAb: sumElAb > 0 ? sumB / sumElAb : null, abzug: ABZ_PLAN, copMin: copMin, copMax: copMaxV, pv: pvN >= 0.9 * NDAY ? pvKwh : null, atMin: atMin, atMax: atMax,
             shift: {best: wBest, worst: wWorst, gain: gain, loss: SHIFT_LOSS}, atRef: atRef, anchor: anchor, tg: tgP, pvRes: pvRes,
             copSrc: CT.pts.length ? 'Messung' : 'Carnot'};
    return P;
}

if (!pl.plan || pl.planSlot !== s0 || pl.plan.status !== 'ok' || pl.plan.ver !== PLAN_VER) {
    pl.plan = buildPlan(); pl.planSlot = s0;
}
var P = pl.plan;

// ---------- Schnappschuss: je Stunde eine Vorschau mit allen Eingaengen (bleibt unveraendert, wird nur fuer den spaeteren Vergleich gelesen)
// Review-Paket 13.10.2026 (PLAN_VER 11): ohne Preis, Plan, Kosten, Empfehlung, Offset, Quiet und Reserve; neu Strom je Slot
var SNAP_COLS = ['t', 'at', 'rh', 'cop', 'pv', 'bedarf', 'strom', 'defrost', 'conf_at', 'conf_pv', 'taupunkt', 'wind', 'wolken', 'at_korr', 'sonne_kwh', 'solar_kand_kwh', 'wind_kand_kwh', 'bedarf_basis', 'bedarf_kand'];
var hourNow = Math.floor(now / H) * H;
if (P.status === 'ok' && P.slots && pl.snapHour !== hourNow) {
    var snap = {t0: hourNow, s0: P.s0, t: now, status: 'ok', cols: SNAP_COLS, slots: P.slots.map(function (x) {
        return [x.t, Math.round(x.at * 100) / 100, Math.round(x.rh), Math.round(x.cop * 100) / 100, x.pv === null ? null : Math.round(x.pv), Math.round(x.bedarf * 1000) / 1000, Math.round(x.el * 1000) / 1000, Math.round(x.risk * 100) / 100,
                Math.round(x.cA * 100) / 100, Math.round(x.cP * 100) / 100, Math.round(x.dew * 10) / 10,
                ok(x.wind) ? Math.round(x.wind * 10) / 10 : null, ok(x.cl) ? Math.round(x.cl) : null, ok(x.atK) ? Math.round(x.atK * 100) / 100 : null,
                Math.round(x.sun * 1000) / 1000, Math.round(x.solK * 1000) / 1000, Math.round(x.winK * 1000) / 1000, Math.round(x.bas * 1000) / 1000, Math.round(x.kand * 1000) / 1000];
    }), meta: {plan_ver: PLAN_VER, modell_ver: MODELL_VER, plan_slots: 96, el_model_24h_kwh: Math.round(P.elModel * 100) / 100, vrm_hp_24h_kwh: P.vrmHp, model: P.model, cop_quelle: P.sum.copSrc, cop_korr_w: COP_KW, res: {at_min: 180, rh_min: 180, pv_min: P.sum.pvRes},
            conf_at: P.conf.at.map(function (a) { return [a.h, Math.round(a.c * 100) / 100, a.n]; }), conf_pv: P.conf.pv.map(function (a) { return [a.h, Math.round(a.c * 100) / 100, a.n]; })}};
    pl.snaps = (pl.snaps || []).filter(function (x) { return x.t0 > now - pn('snapKeepH', 27) * H; });
    pl.snaps.push(snap); pl.snapHour = hourNow;
    var jl = {t0: snap.t0, s0: snap.s0, t: snap.t, cols: snap.cols, meta: snap.meta, slots: snap.slots.map(function (sl) { var r = sl.slice(); r[0] = Math.round(r[0] / 1000); return r; })};
    out[3] = {filename: '/data/optimizer/plan-snapshots-' + monthOf(now) + '.jsonl', payload: JSON.stringify(jl) + '\n'};
    pl.lastSave = 0;
}
if (!pl.lastSave || now - pl.lastSave >= 60 * MS_MIN) { jsave('/data/optimizer/plan-state.json', {learn: pl.learn, snaps: pl.snaps, day: pl.day}); pl.lastSave = now; }

// ---------- Anzeige
var rows = [];
if (P.status !== 'ok') { rows.push(['Status', 'Keine Vorschau: ' + P.status, 'warn'], ['Grund', P.why, '']); }
var tab = [];
if (P.status === 'ok') {
    var sm = P.sum, ml = P.model, sl0 = P.slots, shf = sm.shift;
    var copTxt = ml.copPts.length ? 'gemessen je Außenband (ohne Abtauen/Warmwasser, ab ' + pn('copMinMin', 60) + ' min): ' + ml.copPts.map(function (p) { return f(p[0], 1, '°C') + ' COP ' + f(p[1], 2) + ' (' + Math.round(p[2] / 60) + ' h)'; }).join(' · ') + '; dazwischen linear, außerhalb mit dem Carnot-Verhältnis'
                                   : 'η ' + f(ml.eta, 2) + ' vom Carnot-Wert (' + (ml.etaMin >= 60 ? 'gemessen ' + Math.round(ml.etaW * 100) + ' %, ' + ml.etaMin + ' min' : 'Standardwert') + '), noch kein Außenband mit ' + pn('copMinMin', 60) + ' min Messung';
    rows = [
        ['Status', 'Vorschau · berechnet ' + hhmm(P.t) + ' · keine Empfehlung' + (P.enough ? '' : ' · kaum Heizbedarf'), 'ok'],
        ['Wärmebedarf nächste 24 h', f(sm.bedarf, 1, 'kWh') + ' · Ø ' + f(sm.bedarf / 24, 2, 'kW') + ' (' + f(ml.ua * 1000, 0, 'W/K') + ' × (innen ' + f(ml.ti, 1, '°C') + ' − außen) − Gewinne ' + f(ml.g, 2, 'kW') + ', ' + (ml.uaLearned ? 'gelernt aus ' + ml.uaDays + ' Tagen' : 'Vorwert') + '; Bilanzpunkt ' + f(ml.tbal, 1, '°C') + ')' + (ml.tg ? ' · Tagesgang Fühler − OWM' : '') + ((sm.solU || sm.winU) ? ' · Sonne ' + f(-sm.solU, 1, 'kWh') + ' · Wind ' + f(sm.winU, 1, 'kWh') : ''), ''],
        ['Strom Wärmepumpe nächste 24 h', f(P.elModel, 1, 'kWh') + ' (Modell: Wärmebedarf ÷ COP) · VRM-Prognose ' + (P.vrmHp !== null ? f(P.vrmHp, 2, 'kWh') : 'nicht geliefert'), '', 'COP und Strom ' + KORR_TXT],
        ['Abtau-Abzug', (sm.elAb - P.elModel > 0.05 ? 'mit Abtau-Abzug ' + f(sm.elAb, 1, 'kWh') + ' Strom · COP ' + f(sm.copAb, 2) + ' statt ' + f(sm.cop, 2) : 'kein Abtaurisiko in den nächsten 24 h') + ' (Abzug ' + Math.round(sm.abzug * 100) + ' % × Abtaurisiko je Slot)', '', 'COP korrigiert um Abtauen: die gemessenen Bänder enthalten keine Abtauung (ohne Abtauen/Warmwasser); Wärme beim Abtauen und Wiederaufheizen ist keine Nutzwärme, der interne Zähler bucht sie positiv (Forum 4074654, 4752841). 10–30 Abtauungen am Tag senken den Tages-COP um 5–15 % (je Abtauung 0,3–1,6 kWh: 3810731, 4076731, 4084491); abtauAbzug ' + Math.round(sm.abzug * 100) + ' % ist die Mitte (ANNAHME)'],
        ['Höchster Bedarf', f(P.maxDemand.kw, 1, 'kW') + ' um ' + hhmm(P.maxDemand.t), ''],
        ['COP-Modell', copTxt, '', 'Strom ' + KORR_TXT + ' (TOP16 untertreibt im Lauf: Pumpe, Lüfter, Elektronik fehlen; Forum 189605, L5 70–90 W unter Shelly)'],
        ['Verschieben nach COP (nur Rechnung)', shf.gain === null ? '–' : 'bestes 3-h-Fenster ' + hhmm(sl0[shf.best.i].t) + ' COP ' + f(shf.best.v, 1) + ' · schlechtestes ' + hhmm(sl0[shf.worst.i].t) + ' COP ' + f(shf.worst.v, 1) + ' → ' + f(shf.gain, 3) + ' kWh Strom je verschobener kWh Wärme; das wärmere Haus verliert ' + f(shf.loss[0], 2) + '–' + f(shf.loss[1], 2) + ' (Messung 08.–12.10.) → keine Empfehlung', ''],
        ['Vertrauen Temperatur', P.conf.at.map(function (a) { return '+' + a.h + ' h ' + Math.round(a.c * 100) + ' %'; }).join(' · '), ''],
        ['Vertrauen PV', P.conf.pv.map(function (a) { return '+' + a.h + ' h ' + Math.round(a.c * 100) + ' %'; }).join(' · '), ''],
        ['Gewicht gemessen / Standard', 'Temperatur ' + P.conf.at.map(function (a) { return Math.round(a.w * 100); }).join('/') + ' % · PV ' + P.conf.pv.map(function (a) { return Math.round(a.w * 100); }).join('/') + ' %', ''],
        ['Auflösung der Quellen', 'Temperatur 3 h · PV ' + (sm.pvRes ? f(sm.pvRes, 0, 'min') : '–'), '']
    ];
    (function () {                                                                                 // Gebaeudemodell (nur Werte): Kandidat aus Sonne/Wind, Fehler gegen den Plan-Schaetzer
        var cf = pl.learn.coef, txt, cls = '';
        var gm = 'UA ' + f(ml.ua * 1000, 0, 'W/K') + ' · Gewinne ' + f(ml.g, 2, 'kW') + ' · innen ' + f(ml.ti, 1, '°C') + (ml.gebremst && ml.ziel ? ' (Ziel ' + f(ml.ziel.ua * 1000, 0, 'W/K') + ' · ' + f(ml.ziel.g, 2, 'kW') + ' · ' + f(ml.ziel.ti, 1, '°C') + ', je Tag begrenzt)' : '');
        if (!cf || !cf.n) { txt = gm + ' (Vorwert) · keine Daten'; }
        else if (cf.n < 3) { txt = gm + ' (Plan) · ' + cf.n + ' Tag' + (cf.n === 1 ? '' : 'e') + ' · Kandidat ab 3 Tagen'; }
        else {
            var bestE = [cf.maeSun, cf.maeWind].filter(function (v) { return v !== null && v !== undefined; }).reduce(function (m, v) { return m === null || v < m ? v : m; }, null);
            txt = gm + ' · Sonne ' + f(cf.bs, 3) + ' · Wind ' + (cf.maeWind !== null && cf.maeWind !== undefined ? f(cf.bw, 4) : 'n ' + cf.nW + ' Tage') + ' · ' + (cf.aktiv ? 'aktiv' : 'Kandidat') + ' · ' + cf.n + ' Tage · Fehler Plan ' + f(cf.maeBase, 1) + ' / Kandidat ' + f(bestE, 1, 'kWh');
            if (cf.aktiv) { cls = 'ok'; }
        }
        rows.splice(rows.findIndex(function (r) { return r[0] === 'COP-Modell'; }) + 1, 0, ['Gebäudemodell', txt, cls]);
    })();
    (function () {                                                                                 // Fuehlerkorrektur (nur Werte): Versatz Fuehler - OWM nach Wind, Sonne, Nacht
        var bi = pl.learn.bias, txt, cls = '', sgn = function (v, d, unit) { if (!ok(v)) { return '–'; } var r = Number(Number(v).toFixed(d)); return (r > 0 ? '+' : '') + r.toFixed(d).replace('.', ',') + (unit ? ' ' + unit : ''); };
        if (!bi || !bi.coef) { txt = 'keine Daten' + (bi && bi.n ? ' (' + bi.n + ' Zeilen)' : ''); }
        else {
            var cc = bi.coef, dN = biasDot(cc, biasFeat(new Date(now).getHours(), windNow, piFresh ? PI.pvNow : null, clNow));
            txt = 'jetzt ' + sgn(dN, 1, 'K') + ' · Wind ' + sgn(cc[1], 2, 'K je m/s') + ' · Sonne ' + sgn(cc[2], 1, 'K') + ' · Nacht ' + sgn(cc[3], 1, 'K') + ' · Nacht klar ' + sgn(cc[4], 1, 'K') + ' · ' + bi.days + ' Tage · Fehler OWM ' + f(bi.maeZero, 2, 'K') + ' / Korrektur ' + f(bi.maeMod, 2, 'K') + ' · ' + (bi.aktiv ? 'aktiv' : 'Kandidat');
        }
        rows.splice(rows.findIndex(function (r) { return r[0] === 'Gebäudemodell'; }) + 1, 0, ['Fühlerkorrektur', txt, cls]);
    })();
    (function () {                                                                                 // A/B des Waermebedarf-Modells (Tageswaerme gegen Ist): bisheriges Modell gegen Kandidat mit Sonne/Wind
        var days = (pl.learn.ab || []), txt;
        var part = function (key) { var ds = days.filter(function (d) { return d[key] && d[key].n >= 80; }); if (!ds.length) { return null; } var eB = 0, eK = 0; ds.forEach(function (d) { eB += Math.abs(d[key].q - d[key].b); eK += Math.abs(d[key].q - d[key].k); }); return {b: eB / ds.length, k: eK / ds.length, n: ds.length}; };
        var p6 = part('L6'), p24 = part('L24');
        if (!p6 && !p24) { txt = 'keine abgeschlossenen Tage'; }
        else { txt = [p6 ? '6 h: Plan ' + f(p6.b, 1, 'kWh') + ' · Kandidat ' + f(p6.k, 1, 'kWh') + ' (' + p6.n + ' Tage)' : null, p24 ? '24 h: Plan ' + f(p24.b, 1, 'kWh') + ' · Kandidat ' + f(p24.k, 1, 'kWh') + ' (' + p24.n + ' Tage)' : null].filter(function (x) { return x; }).join(' · '); txt = 'Tagesfehler Wärme ' + txt; }
        rows.splice(rows.findIndex(function (r) { return r[0] === 'Fühlerkorrektur'; }) + 1, 0, ['Bedarfsmodell A/B', txt, '']);
    })();
    (function () {                                                                                 // Lern-Hygiene (B) und Absicherung (D): Gate heute, verworfene Tage, Drift, Rueckfall
        var dy = pl.day || {}, fH = lgFlags({dhwM: dy.dhwM || 0, defM: dy.defM || 0, gapM: dy.gapM || 0, engM: dy.engM || 0, unpM: dy.unpM || 0}), vw = pl.lgVerw || [], cnt = {};
        vw.forEach(function (x) { LG_TEXT.forEach(function (t) { if (x[1] & t[0]) { cnt[t[1]] = (cnt[t[1]] || 0) + 1; } }); });
        var uk = dy.unpK ? Object.keys(dy.unpK).map(function (k) { return k + ' ' + dy.unpK[k] + ' min'; }).join(', ') : '';
        var txt = 'heute ' + (fH ? 'gesperrt (' + lgTxt(fH) + ')' : 'frei') + ' · verworfene Tage ' + vw.length + (vw.length ? ' (' + Object.keys(cnt).map(function (k) { return k + ' ' + cnt[k]; }).join(', ') + ')' : '') + (uk ? ' · unplausibel heute: ' + uk : '');
        rows.splice(rows.findIndex(function (r) { return r[0] === 'Bedarfsmodell A/B'; }) + 1, 0, ['Lern-Gate', txt, fH ? 'warn' : '']);
        var L = pl.learn.lg || {}, rf = pl.learn.rueckfall, rfA = rf && now < rf.bis, up = L.up && L.up.an, dn = L.dn && L.dn.an;
        var t2 = (L.n ? (up ? 'Mehrbedarf gegenüber dem Plan-Modell' : (dn ? 'Minderbedarf gegenüber dem Plan-Modell' : 'ruhig')) + ' (CUSUM + ' + f(L.up ? L.up.s : 0, 1) + ' / − ' + f(L.dn ? L.dn.s : 0, 1) + ', ' + L.n + ' Tage)' : 'noch kein A/B-Tag')
               + (rfA ? ' · Kandidat zurückgenommen ' + stamp(rf.ts).slice(8, 10) + '.' + stamp(rf.ts).slice(5, 7) + '., gesperrt bis ' + stamp(rf.bis).slice(8, 10) + '.' + stamp(rf.bis).slice(5, 7) + '.' : '')
               + ((pl.learn.coef && pl.learn.coef.aktiv && L.rb) ? ' · Rückfall-CUSUM ' + f(L.rb.s, 1) + ' von ' + f(DRIFT.rbH, 0) : '') + ((pl.learn.coefHist || []).length ? ' · ' + pl.learn.coefHist.length + ' Stände' : '');
        rows.splice(rows.findIndex(function (r) { return r[0] === 'Lern-Gate'; }) + 1, 0, ['Bedarfsmodell Drift', t2, (up || dn || rfA) ? 'warn' : '']);
    })();
    // Tabelle: 24 h in Stundenbloecken ab dem aktuellen Slot (Vorschau, keine Empfehlung)
    for (var b = 0; b < 24; b++) {
        var g = sl0.slice(b * 4, b * 4 + 4), mean = function (k) { var s = 0, cnt = 0; g.forEach(function (x) { if (x[k] !== null && x[k] !== undefined) { s += x[k]; cnt++; } }); return cnt ? s / cnt : null; };
        var sB = 0, sE = 0, rk = 0; g.forEach(function (x) { sB += x.bedarf; sE += x.el; if (x.risk > rk) { rk = x.risk; } });
        tab.push({z: hhmm(g[0].t), at: f(mean('at'), 1), b: f(sB, 2), cop: f(mean('cop'), 1), e: f(sE, 2), h: f(mean('rh'), 0, '%') + ' · ' + f(mean('dew'), 1, '°C'), pv: mean('pv') === null ? '–' : f(mean('pv'), 0),
                  d: rk >= 0.05 ? Math.round(rk * 100) + ' %' : '–', v: Math.round(mean('cA') * 100) + ' %'});
    }
}
var chartD = null, kpi = [];
if (P.status === 'ok') {                                                                         // Daten fuer Diagramm und Kennzahlen-Kacheln der Karte
    var sm2 = P.sum;
    chartD = {slots: P.slots.slice(0, 96).map(function (x) { return [x.t, Math.round(x.bedarf * 4000) / 1000, Math.round(x.el * 4000) / 1000, x.pv === null ? null : Math.round(x.pv), Math.round(x.cop * 100) / 100, Math.round(x.at * 10) / 10, ok(x.atK) ? Math.round(x.atK * 10) / 10 : null]; })};
    kpi = [{k: 'Stand', v: hhmm(P.t), s: 'Vorschau, keine Empfehlung'},
           {k: 'Wärmebedarf 24 h', v: f(sm2.bedarf, 1, 'kWh'), s: 'Ø ' + f(sm2.bedarf / 24, 2, 'kW')},
           {k: 'Strom Wärmepumpe', v: f(P.elModel, 1, 'kWh'), s: 'VRM ' + (P.vrmHp !== null ? f(P.vrmHp, 1, 'kWh') : '–'), t: 'Wärmebedarf ÷ COP, Strom ' + KORR_TXT},
           {k: 'COP (Modell)', v: f(sm2.cop, 1), s: (sm2.copMin !== null ? f(sm2.copMin, 1) + '–' + f(sm2.copMax, 1) + ' · ' : '') + sm2.copSrc, t: 'Strom ' + KORR_TXT + ' (TOP16 untertreibt im Lauf; Forum 189605) · mit Abtau-Abzug ' + f(sm2.copAb, 2) + ' (' + f(sm2.elAb, 1, 'kWh') + ' Strom; ' + Math.round(sm2.abzug * 100) + ' % × Abtaurisiko je Slot)'},
           {k: 'Höchster Bedarf', v: f(P.maxDemand.kw, 1, 'kW'), s: 'um ' + hhmm(P.maxDemand.t)},
           {k: 'Außen 24 h', v: f(sm2.atMin, 0) + ' … ' + f(sm2.atMax, 0, '°C'), s: 'Prognose (Fühler-angeglichen)'},
           {k: 'PV-Prognose 24 h', v: sm2.pv !== null ? f(sm2.pv, 0, 'kWh') : '–', s: sm2.pv !== null ? 'Anzeige' : 'keine Prognose'}];
}
out[0] = {payload: {rows: rows, plan: tab, chart: chartD, kpi: kpi, korr: KORR_TXT}};
// Gebaeudemodell fuer die Entscheidungsmaschine (Regel Vorausschau): Lernstand, Gate, coefActivate; Sonne/Wind-Koeffizienten nur bei aktivem Modell
var cfX = pl.learn.coef || {}, cfK = coefSafe((cfX.aktiv && cfX.n >= 3) ? (cfX.maeWind !== null && cfX.maeWind !== undefined ? {bs: cfX.bsW || 0, bw: cfX.bw || 0} : {bs: cfX.bs || 0, bw: 0}) : {bs: 0, bw: 0});
// Lernstand (B Lern-Gate, D Drift/Rueckfall) fuer die Seite "Optimierer", Karte "Messwerte & Lernen": dieselben Groessen wie die Zeilen "Lern-Gate" und
// "Bedarfsmodell Drift" unter "Details und Modell", aber unabhaengig davon, ob gerade ein Plan steht (nur Werte, keine Texte ausser den Gruenden)
var lern = (function () {
    var dy = pl.day || {}, fH = lgFlags({dhwM: dy.dhwM || 0, defM: dy.defM || 0, gapM: dy.gapM || 0, engM: dy.engM || 0, unpM: dy.unpM || 0}), vw = pl.lgVerw || [], cnt = {};
    vw.forEach(function (x) { LG_TEXT.forEach(function (t) { if (x[1] & t[0]) { cnt[t[1]] = (cnt[t[1]] || 0) + 1; } }); });
    var L = pl.learn.lg || {}, rf = pl.learn.rueckfall, r1 = function (v) { return Math.round((v || 0) * 10) / 10; };
    return {heute: fH, heuteTxt: lgTxt(fH), verw: vw.length, verwTxt: Object.keys(cnt).map(function (k) { return k + ' ' + cnt[k]; }).join(', '),
            drift: {n: L.n || 0, up: r1(L.up && L.up.s), dn: r1(L.dn && L.dn.s), upAn: !!(L.up && L.up.an), dnAn: !!(L.dn && L.dn.an), h: DRIFT.h},
            rueckfall: (rf && now < rf.bis) ? {ts: rf.ts, bis: rf.bis} : null, rb: (cfX.aktiv && L.rb) ? {s: r1(L.rb.s), h: DRIFT.rbH} : null};
})();
global.set('OPT_plan', {ts: now, s0: P.s0, status: P.status, slots: P.slots ? P.slots.map(function (x) { return [x.t, Math.round(x.bedarf * 1000) / 1000, Math.round(x.cop * 100) / 100, Math.round(x.el * 1000) / 1000, x.cA]; }) : null,      // Slot: [Zeit, Waerme kWh, COP, Strom kWh, Vertrauen]
                        model: {n: cfX.n || 0, minDays: pn('coefMinDays', 10), gate: !!(cfX.gate && cfX.gate.ok), why: (cfX.gate && cfX.gate.why) || [], aktiv: !!cfX.aktiv, bs: cfK.bs, bw: cfK.bw,
                                ua: Math.round(MDL.ua * 10000) / 10000, g: Math.round(MDL.g * 1000) / 1000, ti: Math.round(MDL.ti * 100) / 100, tbal: Math.round(BIL * 100) / 100, windTot: WIND_TOT, ver: MODELL_VER}, lern: lern});   // Modell v3: tbal = Bilanzpunkt T_innen - Gewinne/UA (ua * max(0, tbal - T) = max(0, UA * (T_innen - T) - Gewinne))
flow.set('plan', pl);
return out;
"""


EVAL_JS = r"""
// Einmal pro Minute: Werte zusammenfuehren, bewerten, anzeigen und protokollieren. KEIN Eingriff in die Regelung.
// Raeume werden nach der Abweichung vom EIGENEN Komfortband bewertet, nicht nach der absoluten Temperatur:
// unter dem Minimum negativ (Heizbedarf), im Band 0, ueber dem Maximum positiv (Ueberschreitung).
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
__COPKW__
var now = Date.now();
var R = global.get('OPT_rooms') || {};
var W = global.get('OPT_weather') || {};
var G = function (k) { var v; try { v = global.get(k, 'file'); } catch (e) { v = undefined; } return v !== undefined ? v : global.get(k); };       // HeishaMoNR legt Anlagenwerte im Speicher "file" ab (ohne Einrichtung faellt das auf den Standardspeicher zurueck)

function num(v) { v = Number(v); return isFinite(v) ? v : null; }
function ok(v) { return v !== null && v !== undefined && isFinite(v); }
function f(v, d, unit) { if (!ok(v)) { return '–'; } return Number(v).toFixed(d).replace('.', ',') + (unit ? ' ' + unit : ''); }
function sg(v, d, unit) { if (!ok(v)) { return '–'; } var r = Number(Number(v).toFixed(d)); return (r > 0 ? '+' : '') + r.toFixed(d).replace('.', ',') + (unit ? ' ' + unit : ''); }
function ageMin(ts) { return ts ? Math.round((now - ts) / 60000) : null; }
function arrow(t) { if (t === null || t === undefined) { return '·'; } return t >= 0.05 ? '↑' : (t <= -0.05 ? '↓' : '→'); }
function age(a) { return a === null ? 'keine Daten' : (a < 60 ? a + ' min' : (a / 60).toFixed(1).replace('.', ',') + ' h'); }
function trTxt(x) { return x.trend === null ? 'Trend n. v.' : arrow(x.trend) + ' ' + f(x.trend, 2, 'K/h'); }

// ---------- Raeume: Abweichung und Abstand zum eigenen Komfortband
__EIGEN__
var rooms = [];
(cfg.rooms || []).forEach(function (rc) {
    var r = R[rc.id] || {};
    var a = ageMin(r.ts), lim = rc.maxAgeMin || cfg.sensor.maxAgeMin;
    var band = isFinite(rc.min) && isFinite(rc.max) && rc.min < rc.max;
    var on = rc.active !== false;
    var x = {id: rc.id, name: rc.name, on: on, active: on && band, hasData: (r.ema !== undefined && a !== null), age: a, lim: lim,
             ema: r.ema, last: r.last, trend: (r.trend === undefined ? null : r.trend), min: rc.min, max: rc.max, weight: rc.weight || 1,
             dev: 0, score: 0, dLow: null, dHigh: null, eigen: eigenOf(rc), sf: sonneOf(rc)};
    x.valid = x.active && x.hasData && a <= lim;
    if (x.hasData && band) {
        x.dLow = x.ema - x.min; x.dHigh = x.max - x.ema;
        x.dev = x.ema < x.min ? x.ema - x.min : (x.ema > x.max ? x.ema - x.max : 0);   // <0 Heizbedarf, 0 im Band, >0 Ueberschreitung
        x.score = x.dev * x.weight;
    }
    rooms.push(x);
});
var valids = rooms.filter(function (x) { return x.valid; });
var heat = null, over = null, tight = null;
valids.forEach(function (x) {
    if (x.dev < 0 && (heat === null || x.score < heat.score)) { heat = x; }     // groesste (gewichtete) Unterschreitung des eigenen Minimums
    if (x.dev > 0 && (over === null || x.score > over.score)) { over = x; }     // groesste (gewichtete) Ueberschreitung des eigenen Maximums
    var m = Math.min(x.dLow, x.dHigh);
    if (tight === null || m < tight.m) { tight = {m: m, room: x}; }
});
var nActive = rooms.filter(function (x) { return x.active; }).length;
var none = !valids.length;
var sum = {
    heat: none ? '–' : (heat ? heat.name + ' · ' + f(-heat.dev, 1, 'K') + ' unter Minimum · ' + trTxt(heat) + (heat.eigen ? ' · eigene Nachheizung' : '') : 'keiner'),
    heatCls: (none || heat) ? 'warn' : 'ok',
    over: none ? '–' : (over ? over.name + ' · ' + f(over.dev, 1, 'K') + ' über Maximum · ' + trTxt(over) + (over.sf ? ' · Sonnenfenster' : '') : 'keiner'),
    overCls: (none || over) ? 'warn' : 'ok',
    tight: tight ? sg(tight.m, 1, 'K') + ' (' + tight.room.name + ')' : '–',
    tightCls: (tight && tight.m < 0.3) ? 'warn' : '',
    valid: valids.length + ' von ' + nActive + ' aktiven Räumen' + (nActive < rooms.length ? ' · ' + (rooms.length - nActive) + ' inaktiv' : ''),
    validCls: valids.length < nActive ? 'warn' : ''
};
var SOz = (function () { var o = global.get('OPT_sonne'); return (o && typeof o.ts === 'number' && now - o.ts <= 15 * 60000) ? o : null; })();      // Sonnenstand (opt_sonne, zeitleiste 18.10.2026): nur Anzeige "Sonne auf Fenster"
var roomsOut = rooms.map(function (x) {
    var why = !x.active ? 'nein (inaktiv)' : (!x.hasData ? 'nein (keine Daten)' : (!x.valid ? 'nein (veraltet)' : 'ja'));
    return {id: x.id, name: x.name,
            ist: x.hasData ? f(x.ema, 1, '°C') : '–', band: f(x.min, 1) + ' – ' + f(x.max, 1, '°C'),
            dLow: x.hasData ? sg(x.dLow, 1, 'K') : '–', dHigh: x.hasData ? sg(x.dHigh, 1, 'K') : '–',
            cLow: (x.valid && x.dLow < 0) ? 'warn' : '', cHigh: (x.valid && x.dHigh < 0) ? 'warn' : '',
            trend: x.hasData ? (x.trend === null ? 'n. v.' : trTxt(x)) : '–',
            valid: why + (x.hasData ? ' · ' + age(x.age) : ''),
            role: x === heat ? 'heat' : (x === over ? 'over' : ''),
            cls: !x.valid ? 'mute' : (x.dev !== 0 ? 'warn' : 'ok'),
            on: x.on, eigen: x.eigen, sf: x.sf, sonne: !!(x.sf && SOz && SOz.swFensterSonnig), min: x.min, max: x.max, weight: x.weight, maxAgeMin: x.lim};
});

// ---------- Aussen / Wetter
var tp = num(G('TOP14_Outside_Temp')), tw = (W.ts && ageMin(W.ts) <= cfg.weather.maxAgeMin) ? W.temp : null;
var wAge = ageMin(W.ts), wOk = (W.status === 'OK' && wAge !== null && wAge <= cfg.weather.maxAgeMin);
var rowsWx = [
    ['Außen Panasonic', f(tp, 1, '°C'), ''],
    ['Außen Wetterdienst', tw !== null ? f(tw, 1, '°C') : '–', ''],
    ['Wetter − Panasonic', (tw !== null && tp !== null) ? sg(tw - tp, 1, 'K') : '–', ''],
    ['Prognose +1 h', wOk ? f(W.f1, 1, '°C') : '–', ''],
    ['Prognose +3 h', wOk ? f(W.f3, 1, '°C') : '–', ''],
    ['Prognose +6 h', wOk ? f(W.f6, 1, '°C') : '–', ''],
    ['Luftfeuchtigkeit', wOk ? f(W.rh, 0, '%') : '–', ''],
    ['Taupunkt', wOk ? f(W.dew, 1, '°C') : '–', ''],
    ['Bewölkung', (wOk && W.clouds !== null && W.clouds !== undefined) ? f(W.clouds, 0, '%') : '–', ''],
    ['Wetterdaten', (W.status || 'noch nicht abgerufen') + (wAge !== null ? ' · ' + age(wAge) : ''), wOk ? 'ok' : ''],
    ['Regelwert Außentemperatur', f(tp, 1, '°C') + ' (Panasonic)', '']
];

// ---------- Berechnete Aussentemperatur (Lambda-artig, NUR Anzeige und Protokoll): Panasonic 1-h-Mittel + 24-h-Historie + Prognose 24 h
// -> Heizkurve der Waermepumpe an dieser Stelle -> aequivalente Verschiebung. Greift nicht in die Regelung ein (Shadow).
var AT_MIN = 60000, AT_BIN = 5 * AT_MIN;
var atCfg = cfg.calcAT || {};
var atHist = flow.get('atBins');
if (!Array.isArray(atHist)) {                                  // nach einem Neustart die gespeicherte Historie laden
    try { var atFile = JSON.parse(fs.readFileSync('/data/optimizer/at-history.json', 'utf8')); atHist = Array.isArray(atFile.bins) ? atFile.bins : []; } catch (e) { atHist = []; }
}
if (tp !== null) {                                             // 5-Minuten-Stapel: [Beginn, Summe, Anzahl]
    var atBt = Math.floor(now / AT_BIN) * AT_BIN, atLast = atHist.length ? atHist[atHist.length - 1] : null;
    if (atLast && atLast[0] === atBt) { atLast[1] += tp; atLast[2] += 1; } else if (!atLast || atBt > atLast[0]) { atHist.push([atBt, tp, 1]); }
}
while (atHist.length && atHist[0][0] < now - 24 * 60 * AT_MIN - AT_BIN) { atHist.shift(); }
flow.set('atBins', atHist);
var atSaved = flow.get('atSaved');
if (!atSaved || now - atSaved >= 10 * AT_MIN) {                // alle 10 min sichern (ueberlebt einen Neustart)
    try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync('/data/optimizer/at-history.json', JSON.stringify({bins: atHist})); flow.set('atSaved', now); } catch (e) { /* kein Zugriff */ }
}
function atMean(fromTs) {
    var s = 0, n = 0;
    atHist.forEach(function (b) { if (b[0] + AT_BIN > fromTs) { s += b[1]; n += b[2]; } });
    return n ? {m: s / n, n: n} : null;
}
var atM1 = atMean(now - 60 * AT_MIN), atM24 = atMean(now - 24 * 60 * AT_MIN);
var atSpanH = atHist.length ? (now - atHist[0][0]) / (60 * AT_MIN) : 0;                  // so viel Historie gibt es
var at1h = (atM1 && atM1.n >= 20) ? atM1.m : null;                                       // mindestens 20 Messwerte in der letzten Stunde
var at24h = (atM24 && atSpanH >= (isFinite(atCfg.minHistH) ? Number(atCfg.minHistH) : 6)) ? atM24.m : null;
var atFc24 = (wOk && W.f24 !== undefined && W.f24 !== null) ? W.f24 : null;             // Prognose-Mittel der naechsten 24 h (braucht frische Wetterdaten)
var atW = [[at1h, isFinite(atCfg.wNow) ? Number(atCfg.wNow) : 0.5], [at24h, isFinite(atCfg.wHist) ? Number(atCfg.wHist) : 0.25], [atFc24, isFinite(atCfg.wFc) ? Number(atCfg.wFc) : 0.25]];
var atUse = atW.filter(function (p) { return p[0] !== null && p[1] > 0; });
var atSum = atUse.reduce(function (a, p) { return a + p[1]; }, 0);
var atCalc = (at1h !== null && atSum > 0) ? atUse.reduce(function (a, p) { return a + p[0] * p[1]; }, 0) / atSum : tp;   // ohne 1-h-Mittel: aktueller Wert
var atBasis = at1h === null ? 'nur aktuell' : [at1h !== null ? '1 h' : '', at24h !== null ? '24 h' : '', atFc24 !== null ? 'Prognose' : ''].filter(Boolean).join(' + ');
// Heizkurve der Waermepumpe (Zone 1): zwei Eckpunkte, dazwischen linear
var cvLo = num(G('Z1_Heat_Curve_Outside_Low_Temp')), cvHi = num(G('Z1_Heat_Curve_Outside_High_Temp')), cvTl = num(G('Z1_Heat_Curve_Target_Low_Temp')), cvTh = num(G('Z1_Heat_Curve_Target_High_Temp'));
function curve(t) {
    if (t === null || cvLo === null || cvHi === null || cvTl === null || cvTh === null || cvHi <= cvLo) { return null; }
    if (t <= cvLo) { return cvTh; }
    if (t >= cvHi) { return cvTl; }
    return cvTh + (cvTl - cvTh) * (t - cvLo) / (cvHi - cvLo);
}
var sollNow = curve(tp), sollCalc = curve(atCalc);
var shiftEq = (sollNow !== null && sollCalc !== null) ? sollCalc - sollNow : null;       // Verschiebung, die die berechnete Aussentemperatur ergaebe
var rowsCalc = [
    ['Außen Panasonic (aktuell)', f(tp, 1, '°C'), ''],
    ['Mittel letzte Stunde', f(at1h, 1, '°C'), ''],
    ['Mittel letzte 24 h', at24h !== null ? f(at24h, 1, '°C') + (atSpanH < 23.5 ? ' (' + f(atSpanH, 0) + ' h)' : '') : 'sammelt (' + f(atSpanH, 1) + ' h)', ''],
    ['Prognose Ø nächste 24 h', atFc24 !== null ? f(atFc24, 1, '°C') : '–', ''],
    ['Gewichtung', atW.map(function (p) { return Math.round(p[1] * 100); }).join(' / ') + ' %', ''],
    ['Berechnete Außentemperatur', f(atCalc, 1, '°C') + ' (' + atBasis + ')', 'ok'],
    ['Soll-Vorlauf, aktuelle AT', f(sollNow, 1, '°C'), ''],
    ['Soll-Vorlauf, berechnete AT', f(sollCalc, 1, '°C'), ''],
    ['Äquivalente Verschiebung', shiftEq !== null ? sg(shiftEq, 1, 'K') : '–', ''],
    ['Modus', 'nur Anzeige, greift nicht ein', '']
];

// ---------- Waermepumpe
var freq = num(G('compressor_frequency')) || 0, valve = num(G('TOP20_ThreeWay_Valve_State')), defrost = num(G('TOP26_Defrosting_State')) === 1;
var ss = G('F_SS'), ssOn = ss && ss.state === 1;
var pOn = num(G('TOP0_Heatpump_State')) === 1;
var mode = !pOn ? 'Aus' : (defrost ? 'Abtauen' : (valve === 1 ? 'Warmwasser' : (freq > 0 ? 'Heizen' : 'Bereit')));
var shiftBase = null, ccc = G('F_CCC'); if (ccc && ccc.z1) { shiftBase = num(ccc.z1.SP_DIRECT_virt); }
var rtc = G('F_RTC'), rtcCorr = (rtc && rtc.z1) ? num(rtc.z1.correction_value) : null;
var shiftFinal = num(G('SHIFT_Final')), target = num(G('TOP42_Z1_Water_Target_Temp'));
var inl = num(G('TOP5_Main_Inlet_Temp')), outl = num(G('TOP6_Main_Outlet_Temp')), pw = num(G('TOP16_Heat_Energy_Consumption')), cop = num(G('COP_HEAT'));
var pwK = pelK(pw, freq > 0), copK = (freq > 0 && cop !== null && pw !== null && pw > 0) ? cop * pw / pwK : null;     // COP-Korrektur (Anzeige und Spalten leistung_korr_w/cop_korr)
var pwQ = pelQ(pw, freq > 0), copQ = (freq > 0 && cop !== null && pw !== null && pw > 0 && pwQ !== null && pwQ > 0) ? cop * pw / pwQ : null;     // Anzeige: Zaehler (falls gewaehlt und frisch), sonst wie pwK
var HPe = G('OPT_hp') || {}, hcV = (HPe.Heating_Control && typeof HPe.Heating_Control.v === 'number') ? HPe.Heating_Control.v : null;
var hcHm = function (ts) { return new Date(ts).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}); };
var rowsWp = [
    ['Betriebszustand', mode + (ssOn ? ' · Sanftanlauf' : ''), ''],
    ['Heizregelung', hcV === null ? '–' : (hcV === 1 ? 'Efficiency' : 'Comfort') + (HPe._hcSince ? ' · ' + (HPe._hcSince.first ? 'seit Beobachtung ' : 'seit ') + hcHm(HPe._hcSince.ts) : ''), ''],   // ui-review-b 20.10.2026: Efficiency ist ein normaler Zustand (Rot nur fuer Fehler)
    ['Soll-Vorlauf (Heizkurve)', f(target, 0, '°C'), ''],
    ['Verschiebung manuell', f(shiftBase, 0, 'K'), ''],
    ['Korrektur Raumregelung', f(rtcCorr, 0, 'K'), ''],
    ['Verschiebung final', f(shiftFinal, 0, 'K'), ''],
    ['Vorlauf / Rücklauf', f(outl, 1) + ' / ' + f(inl, 1, '°C'), ''],
    ['Verdichter', f(freq, 0, 'Hz'), ''],
    // COP-Korrektur (nur Anzeige hier): Strom = TOP16 + COP_KW im Lauf, COP = Kern-COP x TOP16 ÷ (TOP16 + COP_KW). Der Kern (COP_calculated -> panasonic/cop -> Venus/VRM) bleibt roh.
    ['Leistung · COP', f(pwQ, 0, 'W') + ' · ' + (copQ !== null ? f(copQ, 1) : '–'), '', (freq > 0 || ZQ.aktiv ? 'Strom ' + ZQ_TXT + ' (TOP16 ' + f(pw, 0, 'W') + (ZQ.aktiv ? ', ' + KORR_TXT + ' ' + f(pwK, 0, 'W') : '') + ') · Kern-COP (Venus/VRM, roh) ' + f(cop, 1) : 'Stillstand: TOP16 roh')],
    ['Starts heute', f(num(G('Starts_Today')), 0), '']
];

// ---------- Phase 2: Korrektur der Heizkurve (-1 / 0 / +1 K). Greift nur ueber OPT_shift_applied in die Summenfunktion ein, und nur wenn
// eingeschaltet. Ausgeschaltet laeuft derselbe Ablauf als Vorschlag mit (Anzeige, Protokoll), ohne Wirkung. Entscheidungsregeln:
//   1. gueltiger Raum unter seinem Minimum: nie absenken, Fuehrungsraum = groesstes Defizit, ggf. langsame +1-K-Korrektur
//   2. kein Raum unter Minimum, Raum ueber Maximum: Absenkung erlaubt, zunaechst -1 K
//   3. alle im Band: niedrigste Heizkurve suchen (0 K oder vorsichtig -1 K testen)
//   4. gleichzeitig deutlich zu kalt UND zu warm: kein Mittelwert, Waermeverteilungsproblem markieren, Heizkurve nicht aendern
// Jede Aenderung nur nach Mindesthaltezeit und nie bei Sperren (Abtauen, Warmwasser, Verdichterstart, Sanftanlauf ...).
var MS_MIN = 60000;
var ctRes = {on: false, probe: true, cur: 0, want: 0, applied: 0, code: 'Fehler', lead: '', distrib: false, locks: [], holdLeft: 0, since: 0, startK: 0.3, relK: 0.3, holdMin: 45, rtcOn: false};
try {
    var ct = cfg.control || {};
    var ctSt = flow.get('ctl') || {cur: 0, since: 0, lastStart: 0, lastDefrostEnd: 0, lastDhwEnd: 0, freqOn: false, defrost: false, dhw: false, wasOn: false, coldSince: 0, warmSince: 0, inBandSince: 0, backoffUntil: 0};
    var ctNum = function (v, dflt) { return (v !== undefined && v !== null && v !== '' && isFinite(v)) ? Number(v) : dflt; };
    var ctOn = ct.enabled === true, ctProbe = ct.probe !== false;
    var ctStart = ctNum(ct.startK, 0.3), ctRel = ctNum(ct.releaseK, 0.3), ctGuard = ctNum(ct.guardK, 0.15), ctMargin = ctNum(ct.probeMarginK, 0.4);
    var ctHold = ctNum(ct.holdMin, 45) * MS_MIN, ctRise = ctNum(ct.riseDwellMin, 60) * MS_MIN, ctLower = ctNum(ct.lowerDwellMin, 30) * MS_MIN;
    var ctStable = ctNum(ct.probeStableMin, 120) * MS_MIN, ctBackoff = ctNum(ct.probeBackoffMin, 360) * MS_MIN;
    var ctStartLock = ctNum(ct.startLockMin, 15) * MS_MIN, ctDefLock = ctNum(ct.afterDefrostMin, 10) * MS_MIN, ctDhwLock = ctNum(ct.afterDhwMin, 10) * MS_MIN;
    var dhwNow = valve === 1;
    // Zustandswechsel der Waermepumpe merken (fuer die Sperren)
    if (freq > 0 && !ctSt.freqOn) { ctSt.lastStart = now; }
    if (!defrost && ctSt.defrost) { ctSt.lastDefrostEnd = now; }
    if (!dhwNow && ctSt.dhw) { ctSt.lastDhwEnd = now; }
    ctSt.freqOn = freq > 0; ctSt.defrost = defrost; ctSt.dhw = dhwNow;
    if (ctOn && !ctSt.wasOn) { ctSt.cur = 0; ctSt.since = 0; ctSt.backoffUntil = 0; }          // beim Einschalten neutral beginnen
    ctSt.wasOn = ctOn;
    // Sperren: in diesen Zustaenden aendert sich die Korrektur nicht
    var ctOpm = num(G('TOP4_Operating_Mode_State')), ctNr = G('NightReductionWaterTemp') || {}, ctMq = G('MQTT') || {};
    var ctRtcOn = !!(rtc && rtc.z1 && rtc.z1.state === 1);
    var ctLocks = [];
    if (!pOn) { ctLocks.push('Wärmepumpe aus'); }
    if (ctOpm === null || [0, 2, 4, 6].indexOf(ctOpm) < 0) { ctLocks.push('Betriebsart'); }
    if (defrost) { ctLocks.push('Abtauen'); } else if (now - ctSt.lastDefrostEnd < ctDefLock) { ctLocks.push('nach dem Abtauen'); }
    if (dhwNow) { ctLocks.push('Warmwasser'); } else if (now - ctSt.lastDhwEnd < ctDhwLock) { ctLocks.push('nach Warmwasser'); }
    if (freq > 0 && now - ctSt.lastStart < ctStartLock) { ctLocks.push('Verdichterstart'); }
    if (ss && ss.state === 1 && Math.abs(num(ss.correction_value) || 0) > 0) { ctLocks.push('Sanftanlauf'); }
    if (ctNr.state === 1 && Math.abs(num(ctNr.correction) || 0) > 0) { ctLocks.push('Nachtabsenkung'); }
    if (ctRtcOn) { ctLocks.push('Raumregelung (bestehend) aktiv'); }
    if (ctMq.block_active === 1) { ctLocks.push('MQTT gesperrt'); }
    // Lage der gueltigen Raeume (Abstaende gewichtet, Trend in K/h)
    var ctAct = rooms.filter(function (x) { return x.active; });
    var ctAllValid = ctAct.length > 0 && valids.length === ctAct.length;
    var ci = valids.map(function (x) {
        var tr = x.trend === null ? 0 : x.trend;
        return {x: x, tr: tr, mLow: (x.ema - x.min) * x.weight, mHigh: (x.max - x.ema) * x.weight};
    });
    var ctBelow = ci.filter(function (i) { return i.mLow < 0; });                                   // unter dem eigenen Minimum
    var ctAbove = ci.filter(function (i) { return i.mHigh < 0; });                                  // ueber dem eigenen Maximum
    var ctColdClear = ctBelow.filter(function (i) { return i.mLow <= -ctStart; });                  // deutlich zu kalt
    var ctWarmClear = ctAbove.filter(function (i) { return i.mHigh <= -ctStart; });                 // deutlich zu warm
    var ctColdGo = ctColdClear.some(function (i) { return !i.x.eigen && i.x.ema + i.tr < i.x.min; });   // und in 1 h nicht von selbst im Band; ein Raum mit eigener Nachheizung hebt die Kurve nicht (Entscheidung 5)
    var ctWarmGo = ctWarmClear.some(function (i) { return i.x.ema + i.tr > i.x.max; });
    var ctNearLow = ci.some(function (i) { return (i.x.ema + Math.max(i.tr, 0) * 0.5 - i.x.min) * i.x.weight < ctRel; });   // noch nicht sicher im Band
    var ctGuardLow = ci.some(function (i) { return i.mLow < ctGuard; });                            // zu nah am Minimum fuer eine Absenkung
    var ctAllIn = ci.length > 0 && !ctBelow.length && !ctAbove.length;
    var ctPick = function (list, key) { return list.reduce(function (a, b) { return (a === null || b[key] < a[key]) ? b : a; }, null); };
    var ctLead = ctBelow.length ? ctPick(ctBelow, 'mLow') : (ctAbove.length ? ctPick(ctAbove, 'mHigh') : null);     // Fuehrungsraum
    var ctDistrib = ctColdClear.length > 0 && ctWarmClear.length > 0;
    ctSt.coldSince = ctColdGo ? (ctSt.coldSince || now) : 0;                                        // seit wann dauerhaft (Wartezeit fuer langsames Handeln)
    ctSt.warmSince = (ctWarmGo && !ctBelow.length) ? (ctSt.warmSince || now) : 0;
    ctSt.inBandSince = ctAllIn ? (ctSt.inBandSince || now) : 0;
    // Entscheidung
    var ctWant = ctSt.cur, ctCode = '', ctBypass = false, ctBack = false;
    var ctMin = function (ms) { return Math.max(1, Math.ceil(ms / MS_MIN)); };
    if (!ci.length) { ctWant = 0; ctCode = 'keine gültigen Raumdaten'; }
    else if (ctBelow.length) {                                                                      // Regel 1: Raum unter Minimum -> nie absenken
        if (ctSt.cur < 0) { ctWant = 0; ctBypass = true; ctBack = true; ctCode = 'Raum unter Minimum: Absenkung zurücknehmen'; }
        else if (ctDistrib) { ctWant = 0; ctCode = 'Wärmeverteilungsproblem: ' + ctLead.x.name + ' zu kalt, ' + ctPick(ctWarmClear, 'mHigh').x.name + ' zu warm'; }   // Regel 4
        else if (ctSt.cur > 0) { ctCode = 'Raum unter Minimum: ' + ctLead.x.name; }
        else if (ctColdGo && now - ctSt.coldSince >= ctRise) { ctWant = 1; ctCode = 'Raum unter Minimum: ' + ctLead.x.name; }
        else if (ctColdGo) { ctCode = 'Raum unter Minimum: ' + ctLead.x.name + ' (beobachte seit ' + ctMin(now - ctSt.coldSince) + ' min)'; }
        else { ctCode = ctLead.x.name + ' unter Minimum, aber unter der Schwelle oder erholt sich'; }
    } else if (ctAbove.length) {                                                                    // Regel 2: kein Raum unter Minimum, Raum ueber Maximum
        if (ctSt.cur > 0) { ctWant = ctNearLow ? 1 : 0; ctCode = ctNearLow ? 'Raum noch nahe am Minimum' : 'Raum wieder im Band'; }
        else if (ctSt.cur < 0) {
            if (ctGuardLow) { ctWant = 0; ctBack = true; ctCode = 'Absenkung beendet: Raum nahe Minimum'; }
            else { ctCode = 'Überschreitung: ' + ctLead.x.name + ' (-1 K hält)'; }
        }
        else if (!ctAllValid) { ctCode = 'Daten unvollständig: keine Absenkung'; }
        else if (now < ctSt.backoffUntil) { ctCode = 'Absenkung pausiert (' + ctMin(ctSt.backoffUntil - now) + ' min)'; }
        else if (ctWarmGo && now - ctSt.warmSince >= ctLower) { ctWant = -1; ctCode = 'Überschreitung: ' + ctLead.x.name; }
        else if (ctWarmGo) { ctCode = 'Überschreitung: ' + ctLead.x.name + ' (beobachte seit ' + ctMin(now - ctSt.warmSince) + ' min)'; }
        else { ctCode = ctLead.x.name + ' über Maximum, aber unter der Schwelle oder kühlt ab'; }
    } else {                                                                                        // Regel 3: alle im Band -> niedrigste Heizkurve suchen
        if (ctSt.cur > 0) { ctWant = ctNearLow ? 1 : 0; ctCode = ctNearLow ? 'Raum noch nahe am Minimum' : 'Raum wieder im Band'; }
        else if (ctSt.cur < 0) {
            if (ctGuardLow) { ctWant = 0; ctBack = true; ctCode = 'Absenkung beendet: Raum nahe Minimum'; }
            else { ctCode = 'niedrigste Heizkurve gefunden (-1 K hält)'; }
        }
        else if (!ctProbe) { ctCode = 'alle im Band (Absenkung testen aus)'; }
        else if (!ctAllValid) { ctCode = 'alle im Band, Daten unvollständig'; }
        else if (now < ctSt.backoffUntil) { ctCode = 'alle im Band, Test pausiert (' + ctMin(ctSt.backoffUntil - now) + ' min)'; }
        else if (now - ctSt.inBandSince < ctStable) { ctCode = 'alle im Band, Test in ' + ctMin(ctStable - (now - ctSt.inBandSince)) + ' min'; }
        else if (!ci.every(function (i) { return i.mLow >= ctMargin && i.tr >= -0.1; })) { ctCode = 'alle im Band, Abstand zum Minimum zu klein oder Raum kühlt ab (kein Test)'; }
        else { ctWant = -1; ctCode = 'Absenkung testen'; }
    }
    // Absolute Untergrenze des Vorlaufs (Heizkoerper): eine Absenkung ist nur moeglich, wenn der Soll-Vorlauf danach noch mindestens minVlC betraegt.
    // Basis ist der aktuelle Soll-Vorlauf ohne unsere eigene Verschiebung (bei Mildwetter liegt die Kurve schon auf der Untergrenze).
    var ctFloorVl = ctNum(ct.minVlC, 29), ctTgt = num(G('TOP42_Z1_Water_Target_Temp')), ctPrevApplied = num(G('OPT_shift_applied')) || 0;
    var ctBaseVl = ctTgt !== null ? ctTgt - ctPrevApplied : (sollNow !== null ? sollNow : null), ctFloorHit = false;
    if (ctWant < 0 && (ctBaseVl === null || ctBaseVl - 1 < ctFloorVl - 1e-9)) {
        if (ctSt.cur < 0) { ctBypass = true; }                                                      // eine schon angenommene Absenkung sofort zuruecknehmen
        ctWant = 0; ctFloorHit = true;
        ctCode = 'Absenkung nicht möglich: Vorlauf-Untergrenze ' + f(ctFloorVl, 0, '°C') + (ctBaseVl !== null ? ' (Soll-Vorlauf ' + f(ctBaseVl, 1, '°C') + ')' : ' (Soll-Vorlauf unbekannt)') + (ctLead ? ' · ' + ctLead.x.name + (ctAbove.length ? ' über Maximum' : '') : '');
    }
    if (ctBack) { ctSt.backoffUntil = now + ctBackoff; }                                            // nach einer zurueckgenommenen Absenkung eine Weile nicht erneut
    // Aenderung: nur nach Mindesthaltezeit (Zuruecknehmen einer Absenkung bei Raum unter Minimum sofort) und nie bei Sperren; immer nur 1 K
    var ctHoldLeft = Math.max(0, ctSt.since + ctHold - now);
    if (ctWant !== ctSt.cur && !ctLocks.length && (ctHoldLeft === 0 || ctBypass)) { ctSt.cur = ctWant; ctSt.since = now; ctHoldLeft = ctHold; }
    var ctApplied = (ctOn && !ctRtcOn) ? ctSt.cur : 0;
    global.set('OPT_shift_applied', ctApplied);                                                     // wird von der Summenfunktion gelesen (nur wenn frisch)
    global.set('OPT_shift_ts', now);
    flow.set('ctl', ctSt);
    var ctWorst = ctBelow.length ? ctPick(ctBelow, 'mLow') : null;                                  // Komfortzustand fuer die Quiet-Empfehlung
    global.set('OPT_state', {ts: now, deficit: ctBelow.length > 0, deficitRoom: ctWorst ? ctWorst.x.name : '', coldTrend: ctWorst ? ctWorst.tr : null, distrib: ctDistrib, valid: valids.length, active: ctAct.length,
                             korr: ctSt.cur, korrCode: ctCode, korrLead: ctLead ? ctLead.x.name : ''});      // korr*: Raumvorschlag (korrektur_vorschlag) fuer die Entscheidungsmaschine, nur lesen
    ctRes = {on: ctOn, probe: ctProbe, cur: ctSt.cur, want: ctWant, floorHit: ctFloorHit, applied: ctApplied, code: ctCode, lead: ctLead ? ctLead.x.name : '', distrib: ctDistrib,
             locks: ctLocks, holdLeft: ctHoldLeft, since: ctSt.since, startK: ctStart, relK: ctRel, holdMin: ctHold / MS_MIN, rtcOn: ctRtcOn};
} catch (e) {
    node.warn('Regelung (Phase 2): ' + e.message);
    global.set('OPT_shift_applied', 0);                                                            // bei jedem Fehler neutral
    global.set('OPT_shift_ts', now);
    ctRes.code = 'Fehler: ' + e.message;
}
var fmtS = function (v) { return (v > 0 ? '+' : '') + v + ' K'; };
var sgn = function (v) { return (v > 0 ? '+' : '') + v; };
var hhmm = function (ts) { return ts ? new Date(ts).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}) : '–'; };
var ctWhy = ctRes.code + (ctRes.want !== ctRes.cur ? (ctRes.locks.length ? ' · wartet: ' + ctRes.locks[0] : ' · wartet auf Haltezeit') : '');
var ctNext = ctRes.locks.length ? 'gesperrt: ' + ctRes.locks[0] : (ctRes.holdLeft > 0 ? 'frühestens in ' + Math.ceil(ctRes.holdLeft / MS_MIN) + ' min' : 'möglich');
var ctShift = ctRes.on ? fmtS(ctRes.applied) + (ctRes.applied !== 0 ? ' seit ' + hhmm(ctRes.since) : '') : '0 K · Vorschlag ' + fmtS(ctRes.cur);
var ctlOut = {enabled: ctRes.on, probe: ctRes.probe, floorHit: ctRes.floorHit === true, startK: ctRes.startK, releaseK: ctRes.relK, holdMin: ctRes.holdMin,
              status: ctRes.on ? 'Regelung aktiv · Korrektur ' + ctShift : 'Regelung aus · ' + ctShift,
              statusCls: ctRes.on ? 'ok' : '', lead: ctRes.lead || '–', why: ctWhy, next: ctNext, distrib: ctRes.distrib};

// ---------- Bewertung
var reason;
if (none) { reason = 'keine gültigen Raumdaten'; }
else if (heat && over) { reason = 'Zielkonflikt: ' + heat.name + ' zu kalt, ' + over.name + ' zu warm'; }
else if (heat) { reason = heat.name + ' zu kalt (' + f(-heat.dev, 1, 'K') + ' unter Minimum)'; }
else if (over) { reason = over.name + ' zu warm (' + f(over.dev, 1, 'K') + ' über Maximum)'; }
else { reason = 'alle gültigen Räume im eigenen Komfortband'; }

var out = [{payload: {rows: rowsWx}}, {payload: {sum: sum, rooms: roomsOut, ctl: ctlOut}}, {payload: {rows: rowsWp}}, null, null, null, null, {payload: {rows: rowsCalc}}, {payload: 'quiet'}];

// ---------- Protokoll (alle log.intervalMin Minuten, CSV) und Ereignisse
var d = new Date(now), pad = function (n) { return (n < 10 ? '0' : '') + n; };
var month = d.getFullYear() + '-' + pad(d.getMonth() + 1);
var iso = month + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
function c(v) { return (v === null || v === undefined || !isFinite(v)) ? '' : String(Math.round(v * 100) / 100); }
// Kopfzeile nur schreiben, wenn sie in der Datei fehlt oder sich die Spalten geaendert haben (auch nach einem Neustart)
function headerNeeded(key, file, headLine) {
    if (flow.get(key) === month + '|' + headLine) { return false; }
    flow.set(key, month + '|' + headLine);
    try {
        var last = null;
        String(fs.readFileSync(file, 'utf8')).split('\n').forEach(function (l) { if (l.indexOf(headLine.split(',')[0] + ',') === 0) { last = l; } });
        return last !== headLine;
    } catch (e) { return true; }                // Datei gibt es noch nicht
}
var lastLog = flow.get('lastLog');
if (!lastLog || (now - lastLog) >= cfg.log.intervalMin * 60000) {
    var cols = ['zeit', 'aussen_panasonic', 'aussen_wetter', 'diff_wetter_minus_panasonic', 'wetter_feuchte', 'wetter_taupunkt', 'wetter_bewoelkung',
                'prog_1h', 'prog_3h', 'prog_6h', 'wetter_alter_min'];
    var vals = [iso, c(tp), c(tw), c((tw !== null && tp !== null) ? tw - tp : null), c(wOk ? W.rh : null), c(wOk ? W.dew : null), c(wOk ? W.clouds : null),
                c(wOk ? W.f1 : null), c(wOk ? W.f3 : null), c(wOk ? W.f6 : null), c(wAge)];
    rooms.forEach(function (x) {
        ['wert', 'ema', 'alter_min', 'trend', 'abw', 'gueltig', 'min', 'max'].forEach(function (s) { cols.push(x.id + '_' + s); });
        vals = vals.concat([c(x.last), c(x.ema), c(x.age), c(x.trend), (x.hasData && x.active) ? c(x.dev) : '', x.valid ? 1 : 0, c(x.min), c(x.max)]);
    });
    cols = cols.concat(['raeume_gueltig', 'heizbedarf_raum', 'heizbedarf_abw', 'ueberschreitung_raum', 'ueberschreitung_abw', 'spielraum_k', 'spielraum_raum',
                        'soll_vorlauf', 'shift_basis', 'shift_rtc', 'shift_final', 'vorlauf', 'ruecklauf', 'verdichter_hz', 'verdichter_an',
                        'leistung_w', 'cop', 'defrost', 'warmwasser', 'sanftanlauf', 'zustand', 'starts_heute',
                        'regelung_an', 'korrektur_vorschlag', 'korrektur_angewendet', 'fuehrungsraum', 'waermeverteilung', 'regelung_grund', 'regelung_sperre', 'haltezeit_rest_min',
                        'aussen_1h', 'aussen_24h', 'aussen_historie_h', 'prog_24h_mittel', 'aussen_berechnet', 'kurve_soll_aktuell', 'kurve_soll_berechnet', 'verschiebung_aequivalent', 'vorlauf_untergrenze', 'heizregelung',
                        'wetter_wind_ms', 'pv_w', 'aussen_t_outside', 't_outside_custom', 'leistung_korr_w', 'cop_korr', 'cop_korr_w', 'zaehler_wp_w', 'zaehler_heizstab_w']);     // 14.10.2026 (nur angehaengt): COP-Korrektur; 17.10.2026: Stromzaehler
    vals = vals.concat([valids.length, heat ? heat.name : '', heat ? c(heat.dev) : '', over ? over.name : '', over ? c(over.dev) : '', tight ? c(tight.m) : '', tight ? tight.room.name : '',
                        c(target), c(shiftBase), c(rtcCorr), c(shiftFinal), c(outl), c(inl), c(freq), freq > 0 ? 1 : 0,
                        c(pw), c(freq > 0 ? cop : null), defrost ? 1 : 0, valve === 1 ? 1 : 0, ssOn ? 1 : 0, mode, c(num(G('Starts_Today'))),
                        ctRes.on ? 1 : 0, ctRes.cur, ctRes.applied, ctRes.lead, ctRes.distrib ? 1 : 0, String(ctRes.code).replace(/,/g, ';'), ctRes.locks.join(' + ').replace(/,/g, ';'), Math.ceil(ctRes.holdLeft / MS_MIN),
                        c(at1h), c(at24h), c(atSpanH), c(atFc24), c(atCalc), c(sollNow), c(sollCalc), c(shiftEq), ctRes.floorHit ? 1 : 0, hcV === null ? '' : hcV,
                        c(wOk ? W.wind : null), c((G('OPT_plan_in') || {}).ts && now - G('OPT_plan_in').ts < 5 * MS_MIN ? G('OPT_plan_in').pvNow : null), c(num(G('T_outside'))), c(num(G('T_outside_custom'))), c(pwK), c(copK), COP_KW, c(ZQ.w), c(ZQ.hs)]);
    var logFile = '/data/optimizer/optimizer-v2-' + month + '.csv', headLine = cols.join(',');
    out[4] = {filename: logFile, payload: (headerNeeded('logHead', logFile, headLine) ? headLine + '\n' : '') + vals.join(',') + '\n'};
    flow.set('lastLog', now);
    lastLog = now;
}
var rowsOpt = [
    ['Modus', ctRes.on ? 'Regelung aktiv (Heizkurve ±1 K)' : 'Beobachtung (Shadow), kein Eingriff', ctRes.on ? 'ok' : ''],
    ['Bewertung', reason, ''],
    ['Korrektur', ctShift, ''],
    ['Vorschlag Räume', ctWhy, ctRes.distrib ? 'warn' : ''],
    ['Nächste Änderung', ctNext, ''],
    ['Protokoll', lastLog ? 'letzter Eintrag ' + new Date(lastLog).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}) : 'noch kein Eintrag', '']
];
out[3] = {payload: {rows: rowsOpt}};

// Zustandswechsel als Ereignisse (fuer die spaetere Auswertung)
var prev = flow.get('prevState') || {};
var cur = {verdichter: freq > 0 ? 1 : 0, defrost: defrost ? 1 : 0, warmwasser: valve === 1 ? 1 : 0, sanftanlauf: ssOn ? 1 : 0,
           korrektur_vorschlag: sgn(ctRes.cur), korrektur_angewendet: sgn(ctRes.applied), waermeverteilung: ctRes.distrib ? 1 : 0,
           komfort: none ? 'unbekannt' : ((heat || over) ? [heat ? 'heizbedarf:' + heat.name : '', over ? 'ueberschreitung:' + over.name : ''].filter(Boolean).join('+') : 'ok')};
var ev = [];
Object.keys(cur).forEach(function (k) { if (prev[k] !== undefined && prev[k] !== cur[k]) { ev.push(iso + ',' + k + ',' + prev[k] + '->' + cur[k]); } });
flow.set('prevState', cur);
if (ev.length) {
    var evFile = '/data/optimizer/optimizer-events-' + month + '.csv', evHead = 'zeit,ereignis,wechsel';
    out[5] = {filename: evFile, payload: (headerNeeded('evHead', evFile, evHead) ? evHead + '\n' : '') + ev.join('\n') + '\n'};
}
// Statuszeile fuer SYSTEM > EINSTELLUNGEN (OpenWeatherMap)
var info = flow.get('owmInfo');
var owmTxt;
if (!info || !info.hasKey) { owmTxt = 'Noch kein API-Schlüssel gespeichert. Schlüssel und Standort oben eintragen und auf SPEICHERN klicken.'; }
else {
    owmTxt = 'Schlüssel gespeichert (' + info.keyLen + ' Zeichen, Quelle: ' + info.source + ')'
        + (info.lat !== undefined && info.lat !== '' ? ' · Standort ' + f(Number(info.lat), 3) + ' / ' + f(Number(info.lon), 3) : ' · Standort fehlt')
        + ' · Wetterdaten: ' + (W.status || 'noch nicht abgerufen') + (wAge !== null ? ' (Alter ' + age(wAge) + ')' : '');
}
out[6] = {payload: owmTxt};
return out;
"""

# ---------------------------------------------------------------- dashboard
upsert({"id": UI_TAB, "type": "ui_tab", "name": "Optimierung", "icon": "tune", "order": 12.5, "disabled": False, "hidden": False})
# Kartenbreite der Optimierungs-Seiten (13.10., wie ENG_W der Seite "Optimierer"): alle Karten gleich breit (Masonry-Falle: gemischte Breiten legt das
# Dashboard uebereinander). 17 Einheiten = 912 px: ab ~1840 px Fensterbreite zwei Spalten (1920 und 2560), bei 1024 px eine Spalte ohne waagrechtes Scrollen.
# Seiten zusammengelegt (13.10., Branch tabs-zusammen): "Optimierung" = Verlaeufe + Raumkarte + Waermefahrplan, "Optimierer" = Entscheidungsmaschine +
# Quiet-Messwerte, "Daten & Güte" bleibt. Die Tabs "Wärmefahrplan" und "Quiet-Messwerte" bleiben als leere, ausgeblendete Tabs stehen (IDs und Menue-
# Positionen bleiben, Lesezeichen #!/n zeigen weiter auf dieselbe Stelle; deploy_opt.sh entfernt keine Knoten).
OPT_W = 17
ENG_TAB = "opt_eng_ui_tab"                       # Seite "Optimierer" (eigenes Kennzeichen; ui_tab und Karten der Maschine weiter unten)
ENG_W = 17                                       # Gruppenbreite der Seite "Optimierer" (Begruendung bei ENG_GROUPS); gilt auch fuer die Quiet-Karten dort (keine gemischten Breiten)
UI_TAB_DATA = "opt_ui_tab_data"
upsert({"id": UI_TAB_DATA, "type": "ui_tab", "name": "Daten & Güte", "icon": "analytics", "order": 12.75, "disabled": False, "hidden": False})
GROUPS = [("opt_g_ch_wp", "Wärmepumpe · letzte 24 h", OPT_W, UI_TAB), ("opt_g_ch_rooms", "Räume · letzte 24 h", OPT_W, UI_TAB), ("opt_g_ch_at", "Wetter · 24 h zurück, 36 h voraus", OPT_W, UI_TAB),
          ("opt_g_rooms", "Räume und Komfortbänder", OPT_W, UI_TAB),
          ("opt_g_opt", "Optimierung", OPT_W, UI_TAB_DATA),
          ("opt_g_wx", "Außen & Wetter", OPT_W, UI_TAB_DATA), ("opt_g_calc", "Berechnete Außentemperatur", OPT_W, UI_TAB_DATA), ("opt_g_quiet", "Leistung & Quiet", OPT_W, UI_TAB_DATA), ("opt_g_en", "Energie & Preise", OPT_W, UI_TAB_DATA),
          ("opt_g_fq", "Prognosegüte", OPT_W, UI_TAB_DATA), ("opt_g_wp", "Wärmepumpe", OPT_W, UI_TAB_DATA),
          ("opt_g_nas", "Auswertung NAS", OPT_W, UI_TAB_DATA), ("opt_g_zaehler", "Stromzähler", OPT_W, UI_TAB_DATA)]
_ord = {}
for gid, gname, gwidth, gtab in GROUPS:
    _ord[gtab] = _ord.get(gtab, 0) + 1
    upsert({"id": gid, "type": "ui_group", "name": gname, "tab": gtab, "order": _ord[gtab], "disp": True,
            "width": gwidth, "collapse": False, "className": ""})

# Waermefahrplan auf der Seite "Optimierung" unter den Verlaeufen, zwei gleich breite Karten: Kennzahlen + Diagramm + Details | Stundenuebersicht (bei >= 1920 px
# nebeneinander); der Tab "Wärmefahrplan" bleibt leer und ausgeblendet
UI_TAB_PLAN = "opt_ui_tab_plan"
upsert({"id": UI_TAB_PLAN, "type": "ui_tab", "name": "Wärmefahrplan", "icon": "schedule", "order": 12.6, "disabled": False, "hidden": True})
upsert({"id": "opt_g_plan", "type": "ui_group", "name": "Wärmefahrplan (Vorschau)", "tab": UI_TAB, "order": 5, "disp": True, "width": OPT_W, "collapse": False, "className": ""})
upsert({"id": "opt_g_plan_tab", "type": "ui_group", "name": "Stundenübersicht", "tab": UI_TAB, "order": 6, "disp": True, "width": OPT_W, "collapse": False, "className": ""})
# Quiet-Statistik auf der Seite "Optimierer" unter den Karten der Maschine (Messgrundlage der Quiet-Regeln), zwei gleich breite Karten (dieselben Zeilen,
# Spalten aufgeteilt): Leistung | Temperaturen und Takt; der Tab "Quiet-Messwerte" bleibt leer und ausgeblendet
UI_TAB_QUIET = "opt_ui_tab_quiet"
upsert({"id": UI_TAB_QUIET, "type": "ui_tab", "name": "Quiet-Messwerte", "icon": "equalizer", "order": 12.7, "disabled": False, "hidden": True})
upsert({"id": "opt_g_qstats", "type": "ui_group", "name": "Quiet-Stufen: Leistung", "tab": ENG_TAB, "order": 6, "disp": True, "width": ENG_W, "collapse": False, "className": ""})
upsert({"id": "opt_g_qstats2", "type": "ui_group", "name": "Quiet-Stufen: Temperaturen und Takt", "tab": ENG_TAB, "order": 7, "disp": True, "width": ENG_W, "collapse": False, "className": ""})

# The dashboard measures "automatic" card heights only once, before the first data arrives, so such cards stay collapsed.
# Every card therefore starts with a static height and fits itself to its content (marked .optfit): it sets the card size
# attribute and lets the dashboard lay out the cards again. Hidden cards (other tab) are skipped; on any error the card
# simply keeps its configured height.
FIT_JS = """<script>
(function () {
    var id = '__ID__', reg = window.__optFit = window.__optFit || {fns: {}};
    function fit() {
        try {
            var card = document.querySelector('[node-id="' + id + '"]'), root = card && card.querySelector('.optfit'), last = root && root.lastElementChild;
            if (!card || !last || !card.offsetParent) { return; }
            var px = last.getBoundingClientRect().bottom - card.getBoundingClientRect().top + 10;
            if (px < 30) { return; }
            var z = angular.element(document.body).injector().get('uiSizes'), units = Math.max(1, Math.ceil((px + z.cy) / (z.sy + z.cy)));
            var attr = card.getAttribute('ui-card-size') || '', w = attr.split('x')[0] || '6';
            if (attr === w + 'x' + units) { return; }
            card.setAttribute('ui-card-size', w + 'x' + units);
            var panel = card.closest('ui-card-panel'), ctrl = angular.element(panel).controller('uiCardPanel'), mas = angular.element(panel.parentElement).controller('uiMasonry');
            ctrl.refreshLayout(function () { if (mas) { mas.refreshLayout(); } setTimeout(relayout, 150); });
        } catch (e) { /* the card keeps its configured height */ }
    }
    // The dashboard lays the cards out with the panel heights it sees at that moment, which lag one change behind (the new height only reaches
    // the DOM after its next digest). So lay the cards out again whenever any card height has changed since the last layout.
    function relayout() {
        try {
            var sig = Array.prototype.map.call(document.querySelectorAll('ui-card-panel'), function (p) { return Math.round(p.getBoundingClientRect().height); }).join(',');
            if (sig === reg.sig) { return; }
            reg.sig = sig;
            var p0 = document.querySelector('ui-card-panel'), mas = p0 && angular.element(p0.parentElement).controller('uiMasonry');
            if (mas) { mas.refreshLayout(); }
        } catch (e) { /* the layout stays as it is */ }
    }
    reg.fns[id] = fit; reg.relayout = relayout;
    if (!reg.timer) { reg.timer = setInterval(function () { if (document.visibilityState === 'visible') { Object.keys(reg.fns).forEach(function (k) { reg.fns[k](); }); if (reg.relayout) { reg.relayout(); } } }, 1500); }
    setTimeout(fit, 150);
})();
</script>"""

# Statuskarten (Seite "Daten & Güte", 17 breit, unveraendert eigene Seite): Bezeichnung/Wert-Paare in zwei Spalten (CSS-Spalten, von oben nach unten gelesen), lange Werte brechen in ihrer Spalte um
TABLE = ('<div class="optfit"><div class="optkv"><div class="kv" ng-repeat="r in msg.payload.rows track by $index" title="{{r[3]}}">'
         '<span class="l">{{r[0]}}</span><span class="v" ng-class="r[2]">{{r[1]}}</span></div></div></div>')


FQ_TABLE = ('<div class="optfit optpt optfq"><table title="{{msg.payload.sammel}}"><tr><th></th><th colspan="3">Außentemperatur (OWM)</th><th colspan="3">PV ({{msg.payload.pvQuelle}})</th></tr>'
            '<tr><th>Horizont</th><th>Abw.</th><th>Fehler</th><th>n</th><th>Prognose / Ist</th><th>Fehler</th><th>n</th></tr>'
            '<tr ng-repeat="z in msg.payload.tab track by $index"><td>{{z[0]}}</td><td>{{z[1]}}</td><td>{{z[2]}}</td><td>{{z[3]}}</td><td>{{z[4]}}</td><td>{{z[5]}}</td><td>{{z[6]}}</td></tr></table>'
            '</div>')   # ui-daten 18.10.2026: Prognoseguete als Tabelle; ui-review-b 20.10.2026: Sammelzeile ("240 Stunden Ist-Werte ...") nur noch als Tooltip der Tabelle


def template(i, gid, height, y):
    """Status card: label/value pairs in two columns; full group width, static start height (units), fits itself to the content."""
    return {"id": i, "type": "ui_template", "z": TAB, "group": gid, "name": "", "order": 1, "width": 0,
            "height": height, "format": TABLE + FIT_JS.replace("__ID__", i), "storeOutMessages": True,
            "fwdInMessages": False, "resendOnRefresh": True, "templateScope": "local", "className": "",
            "x": 1260, "y": y, "wires": [[]]}


upsert(template("opt_t_opt", "opt_g_opt", 3, 140))
upsert(template("opt_t_wx", "opt_g_wx", 4, 200))
upsert(template("opt_t_calc", "opt_g_calc", 3, 230))
_qt = template("opt_t_quiet", "opt_g_quiet", 12, 290)
# Quiet-Karte: Paare in zwei Spalten, darunter "Letzte Ereignisse" als einzeilige Liste (Zeit · Ereignis · Text)
_qt["format"] = (TABLE.replace('</div></div></div>', '</div></div>'
                 '<div class="optev" ng-if="msg.payload.events && msg.payload.events.length"><div class="evh">Letzte Ereignisse</div>'
                 '<div class="ev" ng-repeat="e in msg.payload.events track by $index"><span class="t">{{e[0]}}</span>'
                 '<span class="n" ng-class="e[3]">{{e[1]}}</span><span class="x">{{e[2]}}</span></div></div></div>') + FIT_JS.replace("__ID__", "opt_t_quiet"))
upsert(_qt)
upsert(template("opt_t_en", "opt_g_en", 4, 350))
upsert(dict(template("opt_t_fq", "opt_g_fq", 5, 400), format=FQ_TABLE + FIT_JS.replace("__ID__", "opt_t_fq")))
# Quiet-Statistik: dieselben Zeilen (Stufe x Aussenband) in zwei gleich breiten Karten, Spalten aufgeteilt (17 Spalten passen nicht ohne Scrollen in eine Karte)
QSTATS_HEAD = ['Stufe', 'Außen', 'Minuten Lauf', 'Ø Hz', 'Ø Fan', '<span title="{{msg.payload.korr}} (TOP16 untertreibt im Lauf; Forum 189605)">Ø P el. (W)</span>', 'Ø P th. (W)', 'Max Hz', 'Max P th. (W, ab 10 min Lauf)',
               '<span title="Ø Wärme ÷ Ø Strom, Strom {{msg.payload.korr}}">Ø COP</span>',
               'Ø VL / RL / ΔT (°C)', 'Ø Soll VL / RL', 'Ø Flow (l/min)', 'Starts/h', 'Ø Lauf (min)', 'Abtauungen', 'Komfortdefizit']
QSTATS_COLS = ([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [0, 1, 10, 11, 12, 13, 14, 15, 16])


QSTATS_ZU_CSS = ('<style>details.optzu>summary{cursor:pointer;outline:none;font-size:12px;color:#00729f;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:4px 0}'
                 'details.optzu[open]>summary{margin-bottom:6px}</style>')


def qstats_tpl(cols, node_id):
    """ui-review-b 20.10.2026: Tabelle zugeklappt (Messgrundlage, nicht Tagesgeschaeft); aufklappen passt die Karte sofort ein"""
    return (QSTATS_ZU_CSS + '<div class="optfit"><details class="optzu" ontoggle="var F = window.__optFit; if (F &amp;&amp; F.fns &amp;&amp; F.fns[\'' + node_id + '\']) { setTimeout(F.fns[\'' + node_id + '\'], 30); }">'
            '<summary>Tabelle · {{(msg.payload.stats || []).length}} Zeilen</summary>'
            '<table class="optq" title="Nur Minuten mit laufendem Verdichter, ohne Abtauen und Warmwasser; Zeilen nur für benutzte Stufen"><tr>'
            + ''.join('<th>' + QSTATS_HEAD[c] + '</th>' for c in cols) + '</tr>'
            '<tr ng-repeat="r in msg.payload.stats track by $index" ng-class="{leer: r[1] === \'keine Daten\'}"><td ng-repeat="c in [' + ','.join(str(c) for c in cols) + '] track by $index">{{r[c]}}</td></tr></table></details></div>')


for _qid, _qg, _qn, _qc, _qy in (("opt_t_qstats", "opt_g_qstats", "Quiet-Statistik", QSTATS_COLS[0], 320), ("opt_t_qstats2", "opt_g_qstats2", "Quiet-Statistik Temperaturen", QSTATS_COLS[1], 360)):
    upsert({"id": _qid, "type": "ui_template", "z": TAB, "group": _qg, "name": _qn, "order": 1, "width": 0, "height": 4,
            "format": qstats_tpl(_qc, _qid) + FIT_JS.replace("__ID__", _qid), "storeOutMessages": True, "fwdInMessages": False, "resendOnRefresh": True,
            "templateScope": "local", "className": "", "x": 1260, "y": _qy, "wires": [[]]})
upsert(template("opt_t_wp", "opt_g_wp", 3, 260))
HIST_JS = r"""
// Verlaufsdaten fuer die Diagramme (nur lesen): letzte 24 h aus dem 5-Minuten-Protokoll optimizer-v2-YYYY-MM.csv; Kopfzeilen-Abschnitte werden ueber die Spaltennamen zugeordnet.
// Zeitstempel einmal, Reihen als Zahlenfelder (kleine Nachrichten). Ausgang 1: Waermepumpe 24 h, 2: Raeume 24 h, 3: Wetterkarte (wetter-grafik 17.10.2026, WXC.daten): 24 h zurueck aus
// dem Protokoll, 36 h voraus aus OPT_weather.fpts, PV-Prognose OPT_plan_in, COP-Ziel OPT_cz_verlauf (opt_engine), "Prognose von gestern" aus forecast-recent.json (nur lesen).
var now = Date.now(), H = 3600000, t0 = now - 24 * H;
function pad(x) { return (x < 10 ? '0' : '') + x; }
function monthOf(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
function tsOf(s) { var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; }
function nn(x) { if (x === '' || x === undefined) { return null; } var v = Number(x); return isFinite(v) ? v : null; }
var months = [monthOf(t0)]; if (monthOf(now) !== months[0]) { months.push(monthOf(now)); }
var rows = [];
months.forEach(function (mo) {
    var head = null, text = '';
    try { text = String(fs.readFileSync('/data/optimizer/optimizer-v2-' + mo + '.csv', 'utf8')); } catch (e) { return; }
    text.split('\n').forEach(function (l) {
        if (!l) { return; }
        var p = l.split(',');
        if (p[0] === 'zeit') { head = p; return; }
        if (!head || p.length !== head.length) { return; }
        var t = tsOf(p[0]); if (t === null || t < t0 || t > now + 60000) { return; }
        var o = {t: t}; for (var i = 1; i < head.length; i++) { o[head[i]] = p[i]; }
        rows.push(o);
    });
});
rows.sort(function (a, b) { return a.t - b.t; });
function cut(hours) { var lim = now - hours * H; return rows.filter(function (r) { return r.t >= lim; }); }
function col(rs, name, f) { return rs.map(function (r) { var v = nn(r[name]); return v === null ? null : Math.round(v * f) / f; }); }
var cfg = global.get('OPT_cfg') || {}, rc = cfg.rooms || [];
__COPKW__
var r24 = cut(24);
// Strom mit COP-Korrektur fuer jede Zeile aus dem Rohwert (leistung_w = TOP16) und dem Verdichter: keine Mischung alter und neuer Zeilen
function elK(rs) { return rs.map(function (r) { var v = nn(r.leistung_w), hz = nn(r.verdichter_hz); return v === null ? null : Math.round(pelK(v, hz !== null && hz > 0)); }); }
var wp = {now: now, n: r24.length, t: r24.map(function (r) { return r.t; }), at: col(r24, 'aussen_panasonic', 10), sollVl: col(r24, 'soll_vorlauf', 100), vl: col(r24, 'vorlauf', 100), rl: col(r24, 'ruecklauf', 100), hz: col(r24, 'verdichter_hz', 10), el: elK(r24), korr: KORR_TXT};
var rm = {now: now, n: r24.length, t: wp.t, rooms: rc.map(function (x) { return {id: x.id, name: x.name, min: x.min, max: x.max, active: x.active !== false, v: col(r24, x.id + '_wert', 100)}; })};
var GX = function (k) { var v; try { v = global.get(k, 'file'); } catch (e) { v = undefined; } return v !== undefined ? v : global.get(k); };
var snaps = null; try { snaps = JSON.parse(String(fs.readFileSync('/data/optimizer/forecast-recent.json', 'utf8'))); } catch (e) { snaps = null; }
var wx;
try { wx = WXC.daten({now: now, rows: r24, W: GX('OPT_weather') || {}, PI: GX('OPT_plan_in') || null, CZ: global.get('OPT_cz_verlauf') || null, snaps: snaps, cfg: cfg, SO: global.get('OPT_sonne') || null}); }
catch (e) { node.warn('Wetterkarte: ' + e.message); wx = {now: now, n: 0}; }
return [{payload: wp}, {payload: rm}, {payload: wx}];
"""

def chart_card(cid, gid, name, units, y, body):
    """Chart card: a div for the SVG diagram, redrawn on every message and on window resize; the card fits its height to the diagram."""
    script = ("<script>" + UI_CHART_JS + "</script>"
              "<script>(function (scope) {\n"
              "var key = '" + cid + "', last = null;\n"
              "function pairs(t, a) { var o = [], i; for (i = 0; i < t.length; i++) { o.push([t[i], a[i]]); } return o; }\n"
              "function draw() {\n"
              "    var el = document.getElementById('optch_" + cid + "'), m = last;\n"
              "    if (!el || !m || !m.payload || !window.optChart) { return; }\n"
              "    var P = m.payload, H = 3600000, spec = null;\n"
              "    if (!P.n || P.n < 2) { el.innerHTML = '<div class=\"optch-leer\">Noch keine Verlaufsdaten.</div>'; return; }\n"
              + body +
              "    if (spec) { window.optChart.mount(el, spec); }\n"
              "}\n"
              "window.__optChMap = window.__optChMap || {}; window.__optChMap[key] = draw;\n"
              "if (!window.__optChRs) { window.__optChRs = true; var tm = null; window.addEventListener('resize', function () { clearTimeout(tm); tm = setTimeout(function () { Object.keys(window.__optChMap).forEach(function (k) { window.__optChMap[k](); }); }, 200); }); }\n"
              "scope.$watch('msg', function (m) { last = m; setTimeout(draw, 40); });\n"
              "})(scope);</script>")
    return {"id": "opt_t_ch_" + cid, "type": "ui_template", "z": TAB, "group": gid, "name": name, "order": 1, "width": 0, "height": units,
            "format": '<div class="optfit"><div id="optch_' + cid + '" style="min-height:40px"></div></div>' + script + FIT_JS.replace("__ID__", "opt_t_ch_" + cid),
            "storeOutMessages": True, "fwdInMessages": False, "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": y, "wires": [[]]}


CH_WP = (
    "    var t = P.t; spec = {t0: P.now - 24 * H, t1: P.now, panels: [\n"
    "        {h: 150, unit: '°C', series: [\n"
    "            {n: 'Soll-VL', c: '#1565c0', k: 'step', dash: '5 3', w: 1.4, dg: 1, u: '°C', d: pairs(t, P.sollVl)},\n"
    "            {n: 'Ist-VL', c: '#1976d2', k: 'line', dg: 2, u: '°C', d: pairs(t, P.vl)},\n"
    "            {n: 'Rücklauf', c: '#ef6c00', k: 'line', dg: 2, u: '°C', d: pairs(t, P.rl)},\n"
    "            {n: 'Außen (Fühler)', c: '#78909c', k: 'line', w: 1.2, dg: 1, u: '°C', d: pairs(t, P.at)}]},\n"
    "        {h: 72, unit: 'Hz', zero: true, runit: 'W', rzero: true, series: [\n"
    "            {n: 'Verdichter', c: '#00897b', k: 'area', dg: 0, u: 'Hz', d: pairs(t, P.hz)},\n"
    "            {n: 'Strom', t: P.korr || '', c: '#6a1b9a', k: 'line', w: 1.2, r: true, dg: 0, u: 'W', d: pairs(t, P.el)}]}]};\n")
CH_ROOMS = (
    "    var t = P.t, cols = ['#1976d2', '#43a047', '#8e24aa', '#ef6c00', '#00838f', '#6d4c41'], ser = [], bands = [];\n"
    "    P.rooms.forEach(function (r, i) { if (!r.active) { return; } var c = cols[i % cols.length]; ser.push({n: r.name + ' (' + String(r.min).replace('.', ',') + '–' + String(r.max).replace('.', ',') + ')', c: c, k: 'line', w: 1.8, dg: 2, u: '°C', d: pairs(t, r.v)}); bands.push({a: r.min, b: r.max, c: c.replace('#', '') && 'rgba(' + parseInt(c.slice(1, 3), 16) + ',' + parseInt(c.slice(3, 5), 16) + ',' + parseInt(c.slice(5, 7), 16) + ',0.07)'}); });\n"
    "    spec = {t0: P.now - 24 * H, t1: P.now, panels: [{h: 236, unit: '°C', bands: bands, series: ser}]};\n")
# Wetterkarte (wetter-grafik 17.10.2026, ersetzt "Außentemperatur · letzte 48 h"): -24 h bis +36 h, Marke "jetzt", Naechte grau, drei Tafeln: Temperatur (Messung, OWM-Prognose
# gestrichelt, Prognose von gestern, Taupunkt, Abtauwetter-Band hellblau), Feuchte/Bewoelkung/Wind, PV (gemessen | Prognose) mit COP-Ziel/-Ist. Fehlende Teile bleiben leer.
CH_WX = (
    "    var hs = P.hist || {}, pg = P.prog || {}, th = hs.t || [], tp = pg.t || [], cz = P.cop || {}, T31 = 31 * 60000;\n"
    "    function both(k) { return pairs(th, hs[k] || []).concat(pairs(tp, pg[k] || [])); }\n"
    "    function p2(x) { return (x < 10 ? '0' : '') + x; }\n"
    "    var ge = P.gestern, gd = new Date(ge ? ge.ts : 0), gTxt = ge ? 'OWM-Prognose vom ' + p2(gd.getDate()) + '.' + p2(gd.getMonth() + 1) + '. ' + p2(gd.getHours()) + ':' + p2(gd.getMinutes()) + ' Uhr' : '';\n"
    "    spec = {t0: P.t0, t1: P.t1, step: 6 * H, marks: [{t: P.now, label: 'jetzt'}], tb: (P.nacht || []).map(function (b) { return {a: b[0], b: b[1], c: 'rgba(84,110,122,.09)'}; }), panels: [\n"
    "        {h: 150, unit: '°C', sym: P.sym || [], tb: (P.abtau || []).map(function (b) { return {a: b[0], b: b[1], c: 'rgba(3,155,229,.13)', n: 'Abtauwetter'}; }), series: [\n"
    "            {n: 'Fühler (WP)', c: '#37474f', k: 'line', w: 1.8, dg: 1, u: '°C', d: pairs(th, hs.at || [])},\n"
    "            {n: 'berechnet', c: '#1976d2', k: 'line', dash: '5 3', w: 1.4, dg: 1, u: '°C', d: pairs(th, hs.calc || [])},\n"
    "            {n: 'OWM', c: '#ef6c00', k: 'line', dg: 1, u: '°C', d: pairs(th, hs.owm || [])},\n"
    "            {n: 'OWM-Prognose', c: '#ef6c00', k: 'line', dash: '6 4', w: 1.8, dg: 1, u: '°C', tol: T31, d: pairs(tp, pg.at || [])},\n"
    "            {n: 'Prognose von gestern', t: gTxt, c: '#90a4ae', k: 'line', w: 1.1, dg: 1, u: '°C', tol: T31, d: ge ? ge.d : []},\n"
    "            {n: 'Taupunkt', c: '#8e24aa', k: 'line', w: 1, dg: 1, u: '°C', tol: T31, d: both('dew')},\n"
    "            {n: 'Abtauwetter', t: 'Außen −5 bis unter 10 °C und Feuchte ≥ 80 % (wie die Sperre der Maschine); bis jetzt gemessen, danach Prognose', c: '#4fc3f7', k: 'area', d: []}]},\n"
    "        {h: 64, unit: '%', min: 0, max: 100, runit: 'm/s', rzero: true, series: [\n"
    "            {n: 'Bewölkung', c: '#b0bec5', k: 'area', op: 0.35, w: 0.8, dg: 0, u: '%', tol: T31, d: both('clouds')},\n"
    "            {n: 'Feuchte', c: '#0277bd', k: 'line', w: 1.4, dg: 0, u: '%', tol: T31, d: both('rh')},\n"
    "            {n: 'Wind', c: '#00897b', k: 'line', w: 1, r: true, dg: 1, u: 'm/s', tol: T31, d: both('wind')}]},\n"
    "        {h: 72, unit: 'kW', zero: true, runit: 'COP', series: [\n"
    "            {n: 'PV', t: 'bis jetzt gemessen, danach Prognose (' + ((P.stand && P.stand.pv) || 'VRM') + ')', c: '#f9a825', k: 'area', op: 0.45, w: 1.2, dg: 2, u: 'kW', tol: T31, d: pairs(th, hs.pv || []).concat(P.pv || [])},\n"
    "            {n: 'COP-Ziel', t: 'Stundenwerte; voraus mit OWM-Prognose und Heizkurve' + (cz.soll !== null && cz.soll !== undefined ? ' (Soll-Vorlauf jetzt ' + String(cz.soll).replace('.', ',') + ' °C)' : ''), c: '#2e7d32', k: 'line', w: 1.8, r: true, dg: 2, u: '', tol: T31, d: (cz.zh || []).concat(cz.zp || [])},\n"
    "            {n: 'COP Ist', t: 'Stundenwerte aus dem Protokoll (Wärme ÷ Strom, mit Korrektur)', c: '#5d4037', k: 'line', w: 1.1, r: true, dg: 2, u: '', tol: T31, d: cz.ih || []}]}]};\n")
# Diagrammhoehen (13.10. kompakt): je Karte 6 Rastereinheiten (318 px) bei 17 breit; Raeume mindestens so hoch wie Waermepumpe, damit die Masonry
# Waermepumpe + Aussentemperatur links und Raeume-Diagramm + Raumkarte rechts anordnet (statische Vorschau tools/opt_seiten_vorschau.js)
upsert(chart_card("wp", "opt_g_ch_wp", "Verlauf Wärmepumpe", 6, 520, CH_WP))
upsert(chart_card("rooms", "opt_g_ch_rooms", "Verlauf Räume", 6, 560, CH_ROOMS))
upsert(chart_card("at", "opt_g_ch_at", "Wetterkarte", 9, 600, CH_WX))
upsert(fn("opt_hist", "Verlaufsdaten (nur lesen)", WX_CORE_JS + HIST_JS.replace("__COPKW__", COP_KW_JS), 3, [["opt_t_ch_wp"], ["opt_t_ch_rooms"], ["opt_t_ch_at"]], 440, 520, FS))
upsert(inject("opt_i_hist", "alle 5 Minuten", 300, 20, ["opt_hist"], 140, 520))
# ---------------------------------------------------------------- Zustandsleiste (zeitleiste 18.10.2026): zwei state-trail-Widgets (node-red-contrib-ui-state-trail 1.0.2, Typ ui_statetrail)
# unter dem Diagramm "Wärmepumpe · letzte 24 h": Zustand (läuft/Pause/Abtauen/Heizstab/aus) und Quiet 0-3. Nur Anzeige. Das Widget speichert nur im Speicher (persist aus,
# Kontext nur memory): opt_zustand baut die 24 h nach Start/Deploy aus quiet-YYYY-MM.csv neu auf (Array = ersetzt die Daten) und schickt danach nur Wechsel; alle 5 min den
# jetzigen Zustand (das Widget verbindet gleiche Zustaende, der Balken reicht so bis "jetzt") und die Anteile der 24 h als Legendentext (msg.control.states: die Legende zeigt
# sonst nur Namen; die Prozent-Ansicht des Widgets gibt es nur nach einem Klick).
ZUSTAND_JS = r"""
// Zustandsleiste (nur lesen, nur Anzeige): Ausgang 1 -> Widget "Zustand", Ausgang 2 -> Widget "Quiet". msg.topic 'init' (Inject beim Start): Historie neu aus dem Minutenprotokoll.
var now = Date.now(), MIN = 60000, H = 3600000, DAY = 24 * H;
var ZS = [['lauf', 'läuft', '#00897b'], ['pause', 'Pause', '#b0bec5'], ['abtau', 'Abtauen', '#0094ce'], ['heizstab', 'Heizstab', '#c62828'], ['aus', 'aus', '#eceff1']];
var QS = [[0, 'Quiet 0', '#78909c'], [1, 'Quiet 1', '#90caf9'], [2, 'Quiet 2', '#0094ce'], [3, 'Quiet 3', '#1565c0']];
function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } v = Number(v); return isFinite(v) ? v : null; }
function p2(x) { return (x < 10 ? '0' : '') + x; }
function monthOf(ts) { var d = new Date(ts); return d.getFullYear() + '-' + p2(d.getMonth() + 1); }
function tsOf(s) { var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; }
// Vorrang: aus (Heatpump_State 0) > Abtauen > Heizstab > laeuft (Verdichter > 0) > Pause; ohne Verdichterwert unbekannt (null)
function zustandOf(hz, df, hs, hp) {
    if (hp === 0) { return 'aus'; }
    if (df === 1) { return 'abtau'; }
    if (hs === 1) { return 'heizstab'; }
    if (hz === null) { return null; }
    return hz > 0 ? 'lauf' : 'pause';
}
function maxOf(a, b) { return a === null ? b : (b === null ? a : Math.max(a, b)); }
// Wechselliste [[t, Zustand], ...]: nur Eintraege, an denen sich der Zustand aendert; der Zustand vor dem Fenster beginnt am Fensteranfang
function wechsel(L, t, v) { if (v === null || v === undefined) { return; } if (!L.length || L[L.length - 1][1] !== v) { L.push([t, v]); } }
function kuerzen(L, t0) { var pre = null; while (L.length && L[0][0] < t0) { pre = L.shift(); } if (pre && (!L.length || L[0][0] > t0)) { L.unshift([t0, pre[1]]); } return L; }
function ladeHist() {
    var t0 = now - DAY, months = [monthOf(t0)], z = [], q = [], n = 0;
    if (monthOf(now) !== months[0]) { months.push(monthOf(now)); }
    months.forEach(function (mo) {
        var text = '';
        try { text = String(fs.readFileSync('/data/optimizer/quiet-' + mo + '.csv', 'utf8')); } catch (e) { return; }
        var head = null, I = {};
        text.split('\n').forEach(function (l) {
            if (!l) { return; }
            if (l.slice(0, 5) === 'zeit,') { head = l.split(','); I = {}; head.forEach(function (h, i) { I[h] = i; }); return; }      // jede Kopfzeile setzt die Spalten neu
            if (!head) { return; }
            var t = tsOf(l); if (t === null || t < t0 - 2 * H || t > now + MIN) { return; }
            var p = l.split(','); if (p.length !== head.length) { return; }
            var g = function (k) { return I[k] === undefined ? null : num(p[I[k]]); };
            wechsel(z, t, zustandOf(g('verdichter_hz'), g('defrost'), maxOf(g('heizstab_intern'), g('heizstab_extern')), null));
            wechsel(q, t, g('quiet_aktuell'));
            n++;
        });
    });
    return {z: kuerzen(z, t0), q: kuerzen(q, t0), n: n};
}
function anteile(L) {                                                             // Anteil je Zustand an den letzten 24 h (bis jetzt), in %
    var o = {}, t0 = now - DAY, tot = 0;
    L.forEach(function (x, i) { var a = Math.max(t0, x[0]), b = i + 1 < L.length ? L[i + 1][0] : now; if (b > a) { o[x[1]] = (o[x[1]] || 0) + (b - a); tot += b - a; } });
    Object.keys(o).forEach(function (k) { o[k] = tot > 0 ? 100 * o[k] / tot : 0; });
    return o;
}
function states(DEF, L, typ) {                                                   // Legende: Name und Anteil (z. B. "läuft · 62 %"); Typ und Farbe wie konfiguriert
    var A = anteile(L);
    return DEF.map(function (d) { var v = A[d[0]] || 0; return {state: d[0], col: d[2], t: typ, label: d[1] + ' · ' + (v > 0 && v < 1 ? '<1' : String(Math.round(v))) + ' %'}; });
}
function voll(L, DEF, typ) {                                                     // ganze Historie (ersetzt die Daten im Widget) + Punkt "jetzt"
    var arr = L.map(function (x) { return {state: x[1], timestamp: x[0]}; });
    if (L.length) { arr.push({state: L[L.length - 1][1], timestamp: now}); }
    return {payload: arr, control: {states: states(DEF, L, typ)}};
}
var HP = global.get('OPT_hp') || {};
function hpv(k) { var e = HP[k]; return (e && typeof e.v === 'number' && now - e.ts < 10 * MIN) ? e.v : null; }
var ST = flow.get('zst');
if (msg.topic === 'init' || !ST) {
    var h = ladeHist();
    ST = {z: h.z, q: h.q, ka: now, voll: now, n: h.n};
    flow.set('zst', ST);
    return [h.z.length ? voll(ST.z, ZS, 'str') : null, h.q.length ? voll(ST.q, QS, 'num') : null];
}
// je Minute: Live-Werte aus OPT_hp (HeishaMon, hoechstens 10 min alt); ohne Werte nichts
var hz = hpv('Compressor_Freq'), hpS = hpv('Heatpump_State');
if (hz === null && hpS === null) { return null; }
var z = zustandOf(hz, hpv('Defrosting_State'), maxOf(hpv('Internal_Heater_State'), hpv('External_Heater_State')), hpS), q = hpv('Quiet_Mode_Level');
if (q !== null && [0, 1, 2, 3].indexOf(q) < 0) { q = null; }
var zNeu = z !== null && (!ST.z.length || ST.z[ST.z.length - 1][1] !== z), qNeu = q !== null && (!ST.q.length || ST.q[ST.q.length - 1][1] !== q);
wechsel(ST.z, now, z); wechsel(ST.q, now, q);
kuerzen(ST.z, now - DAY); kuerzen(ST.q, now - DAY);
var ka = now - (ST.ka || 0) >= 5 * MIN;                                          // alle 5 min: jetziger Zustand (Balken bis jetzt) und Anteile
if (ka) { ST.ka = now; }
// ui-review 18.10.2026: stuendlich die ganze Liste neu (Beginn genau jetzt - 24 h). Das Widget kuerzt sonst nur ab dem letzten Eintrag, der Balken beginnt dann beim
// ersten Wechsel im Fenster, und die Zeitachse beider Leisten passt nicht mehr zum Diagramm darueber (live gesehen: Zustand ab 18:52, Quiet ab 07:57).
if (now - (ST.voll || 0) >= 60 * MIN) { ST.voll = now; ST.ka = now; flow.set('zst', ST); return [ST.z.length ? voll(ST.z, ZS, 'str') : null, ST.q.length ? voll(ST.q, QS, 'num') : null]; }
flow.set('zst', ST);
var cz = ST.z.length ? ST.z[ST.z.length - 1][1] : null, cq = ST.q.length ? ST.q[ST.q.length - 1][1] : null;
var o1 = (zNeu || (ka && cz !== null)) ? {payload: {state: cz, timestamp: now}, control: {states: states(ZS, ST.z, 'str')}} : null;
var o2 = (qNeu || (ka && cq !== null)) ? {payload: {state: cq, timestamp: now}, control: {states: states(QS, ST.q, 'num')}} : null;
return (o1 || o2) ? [o1, o2] : null;
"""


def statetrail(i, label, order, states, y):
    """state-trail-Widget (node-red-contrib-ui-state-trail 1.0.2): Felder wie die defaults in ui-state-trail.html; 24 h, HH:mm, Legende mit allen Zustaenden, Hoehe 2 (Label + Legende)."""
    return {"id": i, "type": "ui_statetrail", "z": TAB, "group": "opt_g_ch_wp", "order": order, "width": 0, "height": 2, "name": label, "label": label,
            "states": states, "periodLimit": 24, "periodLimitUnit": "3600", "timeformat": "HH:mm", "tickmarks": 7, "exactticks": False, "persist": False,
            "legend": 1, "combine": True, "blanklabel": "", "x": 1260, "y": y, "wires": [[]]}


ZS_STATES = [{"state": "lauf", "col": "#00897b", "t": "str", "label": "läuft"}, {"state": "pause", "col": "#b0bec5", "t": "str", "label": "Pause"},
             {"state": "abtau", "col": "#0094ce", "t": "str", "label": "Abtauen"}, {"state": "heizstab", "col": "#c62828", "t": "str", "label": "Heizstab"},
             {"state": "aus", "col": "#eceff1", "t": "str", "label": "aus"}]
QS_STATES = [{"state": 0, "col": "#78909c", "t": "num", "label": "Quiet 0"}, {"state": 1, "col": "#90caf9", "t": "num", "label": "Quiet 1"},
             {"state": 2, "col": "#0094ce", "t": "num", "label": "Quiet 2"}, {"state": 3, "col": "#1565c0", "t": "num", "label": "Quiet 3"}]
upsert(statetrail("opt_st_zustand", "Zustand", 2, ZS_STATES, 2700))
upsert(statetrail("opt_st_quiet", "Quiet", 3, QS_STATES, 2740))
upsert(fn("opt_zustand", "Zustandsleiste (nur lesen)", ZUSTAND_JS, 2, [["opt_st_zustand"], ["opt_st_quiet"]], 900, 2720, FS))
upsert({"id": "opt_i_zst_init", "type": "inject", "z": TAB, "name": "Zustandsleiste neu aufbauen", "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}],
        "repeat": "", "crontab": "", "once": True, "onceDelay": "25", "topic": "init", "payload": "", "payloadType": "date", "x": 160, "y": 2700, "wires": [["opt_zustand"]]})
upsert(inject("opt_i_zst", "jede Minute", 60, 40, ["opt_zustand"], 140, 2740))
# ---------------------------------------------------------------- Status des NAS-Containers optimizer-tools (Paket 2, 15.10.2026; Karte auf "Daten & Güte")
# Der Container schreibt /data/optimizer-tools/status.json (Format 2, Branch nas-container: docker/optimizer-tools/README.md). opt_nas liest die Datei alle 5 min
# (nur lesen; fehlt sie: "kein Lauf") und baut kompakte Zeilen [Bezeichnung, Wert, Chip, Chip-Klasse ok/warn/fehler, Tooltip].
NAS_JS = r"""
// Status des NAS-Containers optimizer-tools: /data/optimizer-tools/status.json NUR LESEN (Format 2). Fehlt die Datei: "kein Lauf". Keine Regelwirkung.
var now = Date.now(), MS_MIN = 60000, P = '/data/optimizer-tools/status.json';
function ok(v) { return v !== null && v !== undefined && isFinite(v); }
function f(v, d) { return ok(v) ? Number(v).toFixed(d).replace('.', ',') : '–'; }
function tsOf(s) { var m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : null; }
function dm(s) { var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(s || '')); return m ? m[3] + '.' + m[2] + '.' : '–'; }
function dmhm(s) { var m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(String(s || '')); return m ? m[3] + '.' + m[2] + '. ' + m[4] + ':' + m[5] : '–'; }
function dauer(sek) { return !ok(sek) ? '–' : (sek < 120 ? Math.round(sek) + ' s' : f(sek / 60, 1) + ' min'); }
var st = null, err = null;
try { st = JSON.parse(String(fs.readFileSync(P, 'utf8'))); } catch (e) { err = (e && e.code === 'ENOENT') ? 'kein Lauf' : 'nicht lesbar'; }
// cop-ziel 17.10.2026: Guetegrad des Ziel-COP aus dem naechtlichen Training (training/cop_eta.json, Format 1, nur lesen) -> OPT_cop_eta (die Maschine liest es, fehlt es: Startwerte)
var CE = null, ceErr = null, PE = '/data/optimizer-tools/training/cop_eta.json';
try { CE = JSON.parse(String(fs.readFileSync(PE, 'utf8'))); if (!CE || typeof CE !== 'object' || CE.format !== 1 || !CE.eta) { CE = null; ceErr = 'Format unbekannt'; } } catch (e) { CE = null; ceErr = (e && e.code === 'ENOENT') ? 'noch keins' : 'nicht lesbar'; }
global.set('OPT_cop_eta', CE);
var ceTs = CE ? tsOf(CE.erstellt) : null, ceAlt = ceTs !== null && now - ceTs > 26 * 60 * MS_MIN;
var ceRow = CE ? ['COP-Gütegrad η', dmhm(CE.erstellt) + ' · ' + Object.keys(CE.eta).map(function (b) { var x = CE.eta[b] || {}; return b + ' ' + (ok(x.v) ? f(x.v, 2) : '–'); }).join(' · '), ceAlt ? 'veraltet' : 'ok', ceAlt ? 'warn' : 'ok',
                  'dT_verd ' + Object.keys(CE.dTverd || {}).map(function (b) { return b + ' ' + f((CE.dTverd[b] || {}).v, 1) + ' K'; }).join(', ') + ' · ' + (CE.kalibrierminuten || 0) + ' Kalibrierminuten von ' + (CE.minuten || 0) +
                  ' · Frequenz ' + Object.keys(CE.freq || {}).map(function (k) { var x = CE.freq[k] || {}; return k + ' Hz ' + (ok(x.v) ? f(x.v, 3) : 'Annahme') + ' (' + (x.n || 0) + ' min)'; }).join(', ') +
                  ' · Abtauen: ' + ((CE.abtau && CE.abtau.quelle) || '–') + (CE.sonne && ok(CE.sonne.rest_prozent) ? ' · Rest in Sonnenminuten ' + f(CE.sonne.rest_prozent, 1) + ' % (' + CE.sonne.min + ' min)' : '')]
                : ['COP-Gütegrad η', ceErr === 'noch keins' ? 'noch keins · Startwerte' : 'nicht lesbar · Startwerte', ceErr === 'noch keins' ? 'Startwerte' : 'Fehler', ceErr === 'noch keins' ? '' : 'fehler', PE + (ceErr === 'noch keins' ? ' fehlt (Container ohne Schritt cop_eta)' : ': ' + ceErr)];
var rows = [];
if (!st || typeof st !== 'object') {
    rows.push(['Letzter Lauf', err || 'nicht lesbar', err === 'kein Lauf' ? 'kein Lauf' : 'Fehler', err === 'kein Lauf' ? 'warn' : 'fehler', P + (err === 'kein Lauf' ? ' fehlt (Container optimizer-tools noch nicht gelaufen)' : ' ist kein gültiges JSON')]);
    rows.push(ceRow);
    return {payload: {rows: rows}};
}
var fehler = Array.isArray(st.fehler) ? st.fehler : [], hinweise = Array.isArray(st.hinweise) ? st.hinweise : [];
// Letzter Lauf
var L = st.letzter_lauf || null, lEnde = L ? tsOf(L.ende) : null, alt = lEnde !== null && now - lEnde > 26 * 60 * MS_MIN;
if (L) {
    var sch = L.schritte || {}, schT = Object.keys(sch).map(function (k) { var x = sch[k] || {}; return k + ': ' + (x.ok ? 'ok' : 'Fehler' + (x.fehler ? ' (' + x.fehler + ')' : '')) + ', ' + dauer(x.dauer_s) + (x.tag ? ', Tag ' + dm(x.tag) : ''); });
    rows.push(['Letzter Lauf', dmhm(L.ende || L.beginn) + ' · ' + dauer(L.dauer_s), L.ok === false ? 'Fehler' : (alt ? 'veraltet' : 'ok'), L.ok === false ? 'fehler' : (alt ? 'warn' : 'ok'),
               'Art ' + (L.art || '–') + ' · ' + schT.join(' · ') + (st.dienst && st.dienst.naechster_lauf ? ' · nächster Lauf ' + dmhm(st.dienst.naechster_lauf) : '') + (st.version ? ' · Stand ' + st.version : '')]);
} else { rows.push(['Letzter Lauf', 'kein Lauf', 'kein Lauf', 'warn', 'status.json ohne letzten Lauf (Dienst gestartet ' + dmhm(st.dienst && st.dienst.gestartet) + ')']); }
// Training: Ampel und Drift
var T = st.training || null;
if (T) {
    var amp = String(T.ampel || ''), ampT = {gruen: 'grün', gelb: 'gelb', rot: 'rot'}[amp] || '–', dr = T.drift || {}, nDr = ok(dr.auffaellig) ? dr.auffaellig : null, G = T.guete_test || {};
    var ent = T.entscheidung && T.entscheidung.ergebnis ? String(T.entscheidung.ergebnis) : '';                        // training-v2: Gate uebernommen/abgelehnt
    var drT = Array.isArray(dr.liste) ? dr.liste.map(function (e) {                                                  // Drift-Eintraege {name, vorher, heute, rel} lesbar (vorher "[object Object]")
        if (!e || typeof e !== 'object') { return String(e); }
        var rr = (ok(e.vorher) && ok(e.heute) && e.vorher !== 0) ? (e.heute - e.vorher) / Math.abs(e.vorher) : (ok(e.rel) ? e.rel : null);   // Prozent aus den gezeigten Zahlen (training-v2: e.rel bezieht sich auf den roh gelernten Wert)
        var rel = rr !== null ? ' (' + (rr >= 0 ? '+' : '') + f(100 * rr, 0) + ' %)' : '';
        return e.name + ' ' + (ok(e.vorher) ? f(e.vorher, Math.abs(e.vorher) < 10 ? 2 : 0) : '–') + ' → ' + (ok(e.heute) ? f(e.heute, Math.abs(e.heute) < 10 ? 2 : 0) : '–') + rel;
    }) : [];
    rows.push(['Training', dm(T.tag) + ' · Drift ' + (nDr === null ? '–' : nDr + ' auffällig') + (dr.gegen ? '' : ' (erster Lauf)') + (ent ? ' · ' + ent : ''), T.ok === false ? 'Fehler' : ampT, T.ok === false || amp === 'rot' ? 'fehler' : (amp === 'gelb' || nDr > 0 ? 'warn' : (amp === 'gruen' ? 'ok' : '')),
               Object.keys(G).filter(function (k) { return ok(G[k]); }).map(function (k) { return k + ' ' + f(G[k], G[k] < 10 ? 2 : 0); }).join(' · ') + (drT.length ? ' · Drift: ' + drT.join(', ') : '') + (T.entscheidung && T.entscheidung.grund ? ' · Gate: ' + T.entscheidung.grund : '') + (T.fehler ? ' · ' + T.fehler : '')]);
} else { rows.push(['Training', 'noch keins', '–', '', '']); }
// Replay-Güte
var R = st.replay || null, RG = R && R.guete ? R.guete : null;
if (RG) {
    var regT = Object.keys(RG.regeln || {}).map(function (k) { var x = RG.regeln[k]; return k + ': ' + (x.bewertbar ? f(x.prozent, 1) + ' %' : 'nicht bewertbar' + (x.grund ? ' (' + x.grund + ')' : '')); });
    rows.push(['Replay-Güte', dm(R.tag) + ' · ' + (RG.bewertbar && ok(RG.prozent) ? f(RG.prozent, 1) + ' % gleich live' : 'nicht bewertbar: ' + (RG.grund || 'unbekannt')),
               RG.bewertbar && ok(RG.prozent) ? (RG.prozent >= 99 ? 'ok' : 'Abweichung') : 'offen', RG.bewertbar && ok(RG.prozent) ? (RG.prozent >= 99 ? 'ok' : 'warn') : 'warn',
               regT.join(' · ') + (ok(R.vorschlaege) ? ' · Vorschläge ' + R.vorschlaege : '')]);
} else { rows.push(['Replay-Güte', R ? dm(R.tag) + ' · ohne Güte' : 'noch keins', '–', '', '']); }
// Datenluecken: Minutenprotokoll und Raumfuehler
var DL = st.datenluecken || {}, MP = DL.minutenprotokoll || null, FR = DL.frische || null, RF = DL.raumfuehler || null;
if (MP || FR) {
    var nL = MP && ok(MP.luecken_ueber_10min) ? MP.luecken_ueber_10min : null, frAlt = FR && ok(FR.alter_min) ? FR.alter_min : null;
    rows.push(['Minutenprotokoll', (MP ? dm(MP.tag) + ' · ' + (nL === null ? '–' : (nL ? nL + ' Lücken > 10 min, größte ' + f(MP.groesste_luecke_min, 0) + ' min' : 'lückenlos')) : '–'),
               frAlt !== null && frAlt > 30 ? 'veraltet' : (nL ? 'Lücken' : 'ok'), frAlt !== null && frAlt > 30 ? 'fehler' : (nL ? 'warn' : 'ok'),
               (MP ? MP.minutenzeilen + ' Minutenzeilen' : '') + (FR ? ' · jüngste Zeile ' + dmhm(FR.juengste_zeile) + ' (' + f(FR.alter_min, 1) + ' min alt)' : '') + (MP && Array.isArray(MP.liste) && MP.liste.length ? ' · ' + MP.liste.slice(0, 5).map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join(', ') : '')]);
}
if (RF && RF.raeume) {
    var RR = Object.keys(RF.raeume).map(function (k) { var x = RF.raeume[k] || {}; return {n: x.name || k, u: ok(x.ungueltig_min) ? x.ungueltig_min : 0, l: ok(x.laengste_min) ? x.laengste_min : 0}; });
    var lang = RR.filter(function (x) { return x.l > 120; }).sort(function (a, b) { return b.u - a.u; }), summe = RR.reduce(function (a, x) { return a + x.u; }, 0);
    rows.push(['Raumfühler', dm(RF.tag) + ' · ' + (lang.length ? lang.map(function (x) { return x.n + ' ' + x.u + ' min'; }).join(', ') : (summe ? summe + ' min ungültig' : 'alle gültig')), lang.length ? 'Lücke' : 'ok', lang.length ? 'warn' : 'ok',
               'ungültige Minuten (längste Lücke): ' + RR.map(function (x) { return x.n + ' ' + x.u + ' (' + x.l + ')'; }).join(' · ')]);
}
// Sicherung
var SI = st.sicherung || null;
if (SI) {
    var siAlt = SI.tag && tsOf(SI.tag + ' 23:59') !== null && now - tsOf(SI.tag + ' 23:59') > 26 * 60 * MS_MIN;
    rows.push(['Sicherung', dm(SI.tag) + ' · ' + f((SI.bytes || 0) / 1048576, 1) + ' MB', SI.geprueft === true ? (siAlt ? 'veraltet' : 'geprüft') : 'ungeprüft', SI.geprueft === true ? (siAlt ? 'warn' : 'ok') : 'fehler',
               (SI.dateien || 0) + ' Dateien, roh ' + f((SI.bytes_roh || 0) / 1048576, 1) + ' MB · ' + (SI.archive || 0) + ' Archive seit ' + dm(SI.aeltestes) + ', belegt ' + f(SI.belegt_mb, 1) + ' MB · SHA-256 ' + String(SI.sha256 || '–').slice(0, 16) + '…']);
} else { rows.push(['Sicherung', 'noch keine', 'fehlt', 'warn', '']); }
rows.push(ceRow);
if (fehler.length) { rows.push(['Fehler', fehler.length + ' im letzten Lauf', 'Fehler', 'fehler', fehler.join(' · ')]); }
return {payload: {rows: rows, stand: st.aktualisiert || '', hinweise: hinweise.length}};
"""
NAS_TPL = ('<div class="optfit"><div class="optkv"><div class="kv" ng-repeat="r in msg.payload.rows track by $index" title="{{r[4]}}">'
           '<span class="l">{{r[0]}}</span><span class="v">{{r[1]}}<span class="optchip" ng-if="r[2]" ng-class="r[3]">{{r[2]}}</span></span></div></div></div>')
upsert({"id": "opt_t_nas", "type": "ui_template", "z": TAB, "group": "opt_g_nas", "name": "Auswertung NAS", "order": 1, "width": 0,
        "height": 3, "format": NAS_TPL + FIT_JS.replace("__ID__", "opt_t_nas"), "storeOutMessages": True,
        "fwdInMessages": False, "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": 580, "wires": [[]]})
upsert(fn("opt_nas", "Status NAS-Container (nur lesen)", NAS_JS, 1, [["opt_t_nas"]], 440, 580, FS))
upsert(inject("opt_i_nas", "alle 5 Minuten", 300, 25, ["opt_nas"], 140, 580))

PLAN_TPL = """<div class="optp optfit">
<div class="kpi" ng-if="msg.payload.kpi.length"><div class="tile" ng-repeat="t in msg.payload.kpi track by $index" title="{{t.t}}"><div class="k">{{t.k}}</div><div class="v">{{t.v}}</div><div class="s" title="{{t.s}}">{{t.s}}</div></div></div>
<div id="optch_plan" style="min-height:120px"></div>
<div class="sec" style="cursor:pointer" ng-click="plOpen = !plOpen">Details und Modell {{plOpen ? '▾' : '▸'}}</div>
<div class="sum" ng-if="plOpen"><span ng-repeat-start="r in msg.payload.rows track by $index" class="k">{{r[0]}}</span><span ng-repeat-end class="v" ng-class="r[2]" title="{{r[3]}}">{{r[1]}}</span></div>
</div>"""
# Stundenuebersicht als eigene Karte (dieselbe Nachricht wie die Plan-Karte)
PLAN_TAB_TPL = """<div class="optpt optfit"><table>
<tr><th>Ab</th><th>Außen °C</th><th>Wärme kWh</th><th title="{{msg.payload.korr}}">COP</th><th title="{{msg.payload.korr}}">Strom kWh</th><th>Feuchte · Taupunkt</th><th>PV W</th><th>Abtaurisiko</th><th>Vertrauen</th></tr>
<tr ng-repeat="r in msg.payload.plan track by $index"><td>{{r.z}}</td><td>{{r.at}}</td><td>{{r.b}}</td><td>{{r.cop}}</td><td>{{r.e}}</td><td>{{r.h}}</td><td>{{r.pv}}</td><td>{{r.d}}</td><td>{{r.v}}</td></tr>
</table></div>"""
PLAN_CH_JS = ("<script>" + UI_CHART_JS + "</script><script>(function (scope) {\n"
    "var last = null;\n"
    "function draw() {\n"
    "    var el = document.getElementById('optch_plan'), m = last;\n"
    "    if (!el || !m || !m.payload || !m.payload.chart || !window.optChart) { return; }\n"
    "    var S = m.payload.chart.slots, Q = 900000, t0 = S[0][0], t1 = S[S.length - 1][0] + Q;\n"
    "    var spec = {t0: t0, t1: t1, panels: [\n"
    "        {h: 130, unit: 'kW', zero: true, series: [\n"
    "            {n: 'Wärmebedarf', c: '#b0bec5', k: 'bar', bw: Q, bf: 0.95, dg: 2, u: 'kW', d: S.map(function (r) { return [r[0], r[1]]; })},\n"
    "            {n: 'Strom (Bedarf ÷ COP)', t: m.payload.korr || '', c: '#1976d2', k: 'line', w: 1.8, dg: 2, u: 'kW', d: S.map(function (r) { return [r[0], r[2]]; })}]},\n"
    "        {h: 76, unit: '°C', runit: 'COP', rzero: false, series: [\n"
    "            {n: 'Außen (Prognose)', c: '#37474f', k: 'line', w: 1.6, dg: 1, u: '°C', d: S.map(function (r) { return [r[0], r[5]]; })},\n"
    "            {n: 'Außen (Fühler-korrigiert)', c: '#1976d2', k: 'line', dash: '5 3', w: 1.4, dg: 1, u: '°C', d: S.map(function (r) { return [r[0], r[6]]; })},\n"
    "            {n: 'COP (gemessen)', t: m.payload.korr ? 'Strom ' + m.payload.korr : '', c: '#00897b', k: 'line', w: 1.4, r: true, dg: 1, u: '', d: S.map(function (r) { return [r[0], r[4]]; })}]},\n"
    "        {h: 60, unit: 'W', zero: true, series: [\n"
    "            {n: 'PV-Prognose', c: '#fbc02d', k: 'area', dg: 0, u: 'W', d: S.map(function (r) { return [r[0], r[3]]; })}]}]};\n"
    "    window.optChart.mount(el, spec);\n"
    "}\n"
    "window.__optChMap = window.__optChMap || {}; window.__optChMap.plan = draw;\n"
    "if (!window.__optChRs) { window.__optChRs = true; var tm = null; window.addEventListener('resize', function () { clearTimeout(tm); tm = setTimeout(function () { Object.keys(window.__optChMap).forEach(function (k) { window.__optChMap[k](); }); }, 200); }); }\n"
    "scope.$watch('msg', function (m) { last = m; setTimeout(draw, 40); });\n"
    "})(scope);</script>")
upsert({"id": "opt_t_plan", "type": "ui_template", "z": TAB, "group": "opt_g_plan", "name": "Wärmefahrplan", "order": 1, "width": 0, "height": 10,
        "format": PLAN_TPL + PLAN_CH_JS + FIT_JS.replace("__ID__", "opt_t_plan"), "storeOutMessages": True, "fwdInMessages": False, "resendOnRefresh": True,
        "templateScope": "local", "className": "", "x": 1260, "y": 440, "wires": [[]]})
upsert({"id": "opt_t_plan_tab", "type": "ui_template", "z": TAB, "group": "opt_g_plan_tab", "name": "Wärmefahrplan Stunden", "order": 1, "width": 0, "height": 11,
        "format": PLAN_TAB_TPL + FIT_JS.replace("__ID__", "opt_t_plan_tab"), "storeOutMessages": True, "fwdInMessages": False, "resendOnRefresh": True,
        "templateScope": "local", "className": "", "x": 1260, "y": 480, "wires": [[]]})


def room_input(field):
    """Number input of one room setting; the change is sent to opt_set as "room:<id>:<field>"."""
    _f, lo, hi, step, tip = next(x for x in ROOM_FIELDS if x[0] == field)
    return ('<input type="number" ng-model="r.%s" ng-model-options="{updateOn: \'change blur\'}" ng-focus="edit()" ng-blur="done()" '
            'ng-change="set(r, \'%s\', r.%s)" min="%s" max="%s" step="%s" title="%s">' % (field, field, field, lo, hi, step, tip))


# room card: summary, one table with situation and settings per room (inputs write back through scope.send -> opt_set), proposal for the heating curve.
# Kompakt (13.10.): Lage und Einstellungen in einer Tabelle, Zusammenfassung und Vorschlag als zweispaltige Paare; die Erklaerungen stehen als Tooltip (title), nicht als Hinweiszeilen.
ROOMS_TPL = """<div class="optr optfit" ng-if="d">
<div class="sum">
<span class="k">Raum unter Minimum</span><span ng-class="d.sum.heatCls">{{d.sum.heat}}</span>
<span class="k">Raum über Maximum</span><span ng-class="d.sum.overCls">{{d.sum.over}}</span>
<span class="k">Geringster Abstand</span><span ng-class="d.sum.tightCls">{{d.sum.tight}}</span>
<span class="k">Gültige Räume</span><span ng-class="d.sum.validCls">{{d.sum.valid}}</span>
</div>
<table title="Abstand: positiv = noch Luft bis zur Grenze, negativ = Grenze verletzt; jeder Raum wird nach seinem eigenen Band bewertet. Änderungen gelten, sobald das Feld verlassen wird; inaktive Räume werden nur angezeigt. Die Gewichtung ist ein Faktor für die Abweichung und entscheidet bei mehreren Verstößen, welcher Raum maßgeblich ist.">
<tr><th>Raum</th><th class="n">Ist</th><th class="n">Abstand unten</th><th class="n">Abstand oben</th><th>Trend</th><th>Gültig</th><th>Aktiv</th><th title="Eigene Nachheizung: Der Raum heizt selbst nach (Radiator-Relais, Heizlüfter). Unter Minimum kein Bedarf für das ganze Haus, für Absenkungen zählt er weiter.">eigene Heizung</th><th title="Sonnenfenster: Der Raum wird nachmittags durch die Sonne warm. Steigt er zwischen 11 und 18 Uhr bei Sonne (PV ab 20 % der Spitze oder Bewölkung unter 50 %), obwohl die Wärmepumpe steht oder der Vorlauf fällt, löst er kein −1 K aus. Für Bedarf, Reserve und Wärmeverteilung zählt er immer.">Sonne</th><th class="n">Min °C</th><th class="n">Max °C</th><th class="n">Gewicht</th><th class="n">Alter max. (min)</th></tr>
<tr ng-repeat="r in d.rooms track by r.id">
<td>{{r.name}}<span class="role" ng-if="r.role==='heat'">größte Unterschreitung</span><span class="role" ng-if="r.role==='over'">größte Überschreitung</span></td>
<td class="n" ng-class="r.cls">{{r.ist}}</td>
<td class="n" ng-class="r.cLow">{{r.dLow}}</td><td class="n" ng-class="r.cHigh">{{r.dHigh}}</td>
<td>{{r.trend}}</td><td ng-class="r.cls==='mute' ? 'mute' : ''">{{r.valid}}</td>
<td><input type="checkbox" ng-model="r.on" ng-change="set(r, 'active', r.on)"></td>
<td><input type="checkbox" ng-model="r.eigen" ng-change="set(r, 'eigeneHeizung', r.eigen)"></td>
<td style="white-space:nowrap"><input type="checkbox" ng-model="r.sf" ng-change="set(r, 'sonnenfenster', r.sf)"><svg ng-if="r.sonne" class="sfs" style="vertical-align:middle;margin-left:5px" width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="Sonne auf Fenster"><title>Sonne auf Fenster</title><circle cx="7" cy="7" r="2.8" fill="#f9a825" stroke="#b45309" stroke-width="0.8"/><path d="M7 0.8v2M7 11.2v2M0.8 7h2M11.2 7h2M2.6 2.6l1.4 1.4M10 10l1.4 1.4M2.6 11.4l1.4-1.4M10 4l1.4-1.4" stroke="#b45309" stroke-width="1.1" stroke-linecap="round"/></svg></td>
<td class="n">__IN_min__</td><td class="n">__IN_max__</td><td class="n">__IN_weight__</td><td class="n">__IN_maxAgeMin__</td></tr>
</table>
<div class="sec" title="Regeln: 1. Ein Raum unter seinem Minimum: nie absenken, der Raum mit dem größten Defizit führt, langsam höchstens +1 K. 2. Kein Raum unter Minimum, aber einer über Maximum: Absenkung erlaubt, zunächst -1 K. 3. Alle im Band: niedrigste Heizkurve suchen (0 K oder vorsichtig -1 K testen). 4. Gleichzeitig deutlich zu kalt und zu warm: Wärmeverteilungsproblem, die Heizkurve bleibt unverändert. Der Soll-Vorlauf wird nie unter die Untergrenze von 29 °C gesenkt (Heizkörper). Jede Änderung nur nach der Mindesthaltezeit und nie bei Abtauen, Warmwasser, Verdichterstart oder Sanftanlauf. Der Vorschlag steht im Protokoll (korrektur_vorschlag).">Vorschlag für die Heizkurve (nur Anzeige, greift nicht ein)</div>
<div class="sum" ng-if="d.ctl">
<span class="k">Stand</span><span ng-class="d.ctl.statusCls">{{d.ctl.status}}</span>
<span class="k">Führungsraum</span><span>{{d.ctl.lead}}</span>
<span class="k">Grund</span><span class="wide" ng-class="d.ctl.distrib ? 'warn' : ''">{{d.ctl.why}}</span>
<span class="k">Nächste Änderung</span><span class="wide">{{d.ctl.next}}</span>
</div>
</div>
<script>
(function (scope) {
    scope.d = null; scope.editing = false; scope.pending = false;
    // new values from the server replace the card, except while a field is being edited (unless the update answers our own change)
    scope.$watch('msg', function (m) {
        if (m && m.payload && m.payload.rooms && (!scope.editing || scope.pending)) { scope.d = JSON.parse(JSON.stringify(m.payload)); scope.pending = false; }
    });
    scope.edit = function () { scope.editing = true; };
    scope.done = function () { scope.editing = false; };
    scope.set = function (r, field, value) { scope.pending = true; scope.send({topic: 'room:' + r.id + ':' + field, payload: value}); };
})(scope);
</script>"""
for _f in ("min", "max", "weight", "maxAgeMin"):
    ROOMS_TPL = ROOMS_TPL.replace("__IN_%s__" % _f, room_input(_f))
upsert({"id": "opt_t_rooms", "type": "ui_template", "z": TAB, "group": "opt_g_rooms", "name": "Räume", "order": 1,
        "width": 0, "height": 7, "format": ROOMS_TPL + FIT_JS.replace("__ID__", "opt_t_rooms"), "storeOutMessages": True, "fwdInMessages": False,
        "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": 320, "wires": [["opt_set"]]})

# ---------------------------------------------------------------- flow nodes
upsert(comment("opt_c1", "Phase 1: nur messen, glätten, anzeigen, protokollieren – KEIN Eingriff in die Regelung", 380, 40))
upsert(comment("opt_c2", "Raumsensoren (Venus-Broker) → Plausibilität, Ausreißer, Glättung, Trend", 380, 80))
upsert(inject("opt_i_init", "Standardwerte", 0, 3, ["opt_defaults"], 140, 140))
upsert(fn("opt_defaults", "Standardwerte setzen", js(DEFAULTS_JS), 0, [], 380, 140, FS))
# input from the room card; output 1: red message for a rejected input, output 2: evaluate now (the card shows the valid values again)
upsert(fn("opt_set", "Einstellung übernehmen und speichern", js(SET_CFG_JS), 2, [["opt_ui_toast"], ["opt_eval"]], 1500, 320, FS))

for i, (t, y) in enumerate((("+/status/temperature:0", 200), ("shellies/+/sensor/temperature", 260))):
    upsert({"id": f"opt_mqtt_{i}", "type": "mqtt in", "z": TAB, "name": "", "topic": t, "qos": "1",
            "datatype": "auto-detect", "broker": BROKER, "nl": False, "rap": True, "rh": 0, "inputs": 0,
            "x": 160, "y": y, "wires": [["opt_room_in"]]})
upsert(fn("opt_room_in", "Raumsensor verarbeiten", ROOM_IN_JS, 1, [[]], 420, 230))

upsert(comment("opt_c3", "OpenWeatherMap (optional): Schlüssel + Standort im Dashboard unter SYSTEM > EINSTELLUNGEN eintragen", 380, 540))
upsert(inject("opt_i_wx", "Wetter abrufen", 600, 20, ["opt_owm_req"], 140, 600))
upsert(fn("opt_owm_req", "OWM-Anfrage", OWM_REQ_JS, 1, [["opt_http"]], 380, 600, FS))
upsert({"id": "opt_http", "type": "http request", "z": TAB, "name": "OpenWeatherMap", "method": "GET", "ret": "obj",
        "paytoqs": "ignore", "url": "", "tls": "", "persist": False, "proxy": "", "insecureHTTPParser": False,
        "authType": "", "senderr": False, "headers": [], "x": 620, "y": 600, "wires": [["opt_owm_parse"]]})
upsert({"id": "opt_catch", "type": "catch", "z": TAB, "name": "", "scope": ["opt_http"], "uncaught": False,
        "x": 620, "y": 660, "wires": [["opt_owm_parse"]]})
upsert(fn("opt_owm_parse", "OWM-Antwort auswerten", OWM_PARSE_JS, 1, [[]], 880, 600))
# ---------------------------------------------------------------- Sonnenstand (zeitleiste 18.10.2026): node-red-contrib-sun-position 3.0.1. Der Knoten "sun-position" nimmt Breite/Laenge
# aus der Nachricht (msg.latitude / msg.longitude, 30-sun-position.js), der Konfigknoten opt_pos_cfg traegt nur Platzhalter 0/0 (der echte Standort steht nur in owm.json;
# opt_owm_req/opt_owm_load legen ihn ohne Schluessel als OPT_weather.pos ab). Azimut wie suncalc3 im Kompass-Sinn (0 = Nord, 180 = Sued). Nur Daten und Anzeige.
SONNE_IN_JS = r"""
// Alle 5 min: Standort (OPT_weather.pos, nur Breite/Laenge) an den sun-position-Knoten; ohne Standort nichts (kein Sonnenstand bei 0/0)
var W = global.get('OPT_weather') || {}, P = W.pos;
if (!P || typeof P.lat !== 'number' || typeof P.lon !== 'number' || !isFinite(P.lat) || !isFinite(P.lon) || (P.lat === 0 && P.lon === 0)) { return null; }
return {topic: 'sonne', latitude: P.lat, longitude: P.lon};
"""
SONNE_JS = r"""
// Ergebnis des sun-position-Knotens -> global OPT_sonne {ts, azimut, hoehe, aufgang, untergang, swFenster, swFensterSonnig, wolken, abwOwmMin}. Nur Anzeige, keine Regelwirkung.
// swFenster: Sonne steht im Suedwesten (Azimut 180-270°) und hoeher als 10° (Suedwestfenster Wohnzimmer); swFensterSonnig: zusaetzlich OWM-Bewoelkung unter 70 %.
// abwOwmMin: Abweichung von Auf-/Untergang gegen die OWM-Zeiten (OPT_weather.sun) in Minuten (Selbstkontrolle des Standorts).
var now = Date.now(), MIN = 60000, P = msg.payload || {}, W = global.get('OPT_weather') || {};
function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } v = Number(v); return isFinite(v) ? v : null; }
function tOf(x) { if (!x || x.valid === false) { return null; } if (typeof x.ts === 'number') { return x.ts; } var d = new Date(x.value); return isFinite(d.getTime()) ? d.getTime() : null; }
var az = num(P.azimuthDegrees !== undefined ? P.azimuthDegrees : P.azimuth), alt = num(P.altitudeDegrees !== undefined ? P.altitudeDegrees : P.altitude);
if (az === null || alt === null) { return null; }
var T = P.times || {}, auf = tOf(T.sunriseStart || T.sunrise), unt = tOf(T.sunsetEnd || T.sunset);
var wOk = typeof W.ts === 'number' && now - W.ts <= 60 * MIN && num(W.clouds) !== null, sw = az >= 180 && az <= 270 && alt > 10;
function abw(a, b) { if (a === null || typeof b !== 'number') { return null; } var d = ((a - b) / MIN) % 1440; if (d > 720) { d -= 1440; } if (d < -720) { d += 1440; } return Math.round(d); }
var o = {ts: now, azimut: Math.round(az * 10) / 10, hoehe: Math.round(alt * 10) / 10, aufgang: auf, untergang: unt, swFenster: sw, swFensterSonnig: !!(sw && wOk && num(W.clouds) < 70),
         wolken: wOk ? num(W.clouds) : null, abwOwmMin: Array.isArray(W.sun) ? [abw(auf, W.sun[0]), abw(unt, W.sun[1])] : null};
global.set('OPT_sonne', o);
return null;
"""
upsert({"id": "opt_pos_cfg", "type": "position-config", "name": "Standort (Platzhalter, echte Werte per Nachricht)", "isValide": "true", "longitude": "0", "latitude": "0",
        "angleType": "deg", "timeZoneOffset": 99, "timeZoneDST": 0, "stateTimeFormat": "3", "stateDateFormat": "12", "contextStore": "", "sunPositions": [], "predefAngles": [],
        "credentials": {"posLatitude": "0", "posLongitude": "0"}})
upsert(inject("opt_i_sonne", "alle 5 Minuten", 300, 15, ["opt_sonne_in"], 140, 2800))
upsert(fn("opt_sonne_in", "Standort an Sonnenstand", SONNE_IN_JS, 1, [["opt_sun_pos"]], 380, 2800))
upsert({"id": "opt_sun_pos", "type": "sun-position", "z": TAB, "name": "Sonnenstand", "positionConfig": "opt_pos_cfg", "rules": [], "onlyOnChange": "true", "topic": "",
        "outputs": 1, "start": "", "startType": "none", "startOffset": 0, "startOffsetType": "none", "startOffsetMultiplier": 60, "end": "", "endType": "none",
        "endOffset": 0, "endOffsetType": "none", "endOffsetMultiplier": 60, "x": 620, "y": 2800, "wires": [["opt_sonne"]]})
upsert(fn("opt_sonne", "Sonnenstand auswerten (nur Anzeige)", SONNE_JS, 1, [[]], 880, 2800))

upsert(comment("opt_c4", "Auswertung jede Minute → Anzeige + Protokoll (CSV in /data/optimizer)", 380, 700))
upsert(inject("opt_i_tick", "jede Minute", 60, 15, ["opt_eval"], 140, 760))
upsert(fn("opt_eval", "Auswerten · Anzeigen · Protokollieren", EVAL_JS.replace("__COPKW__", COP_KW_JS).replace("__EIGEN__", EIGEN_JS), 9,
          [["opt_t_wx"], ["opt_t_rooms"], ["opt_t_wp"], ["opt_t_opt"], ["opt_f_log"], ["opt_f_ev"], ["opt_ui_wxstatus"], ["opt_t_calc"], ["opt_quiet"]], 420, 760, FS))

# ---------------------------------------------------------------- phase 4 (shadow): quiet recommendation; READ ONLY, there is no mqtt out in this tab
upsert(comment("opt_c5", "Quiet-Wächter (Shadow): Anlagenwerte nur lesen, messen und anzeigen, Stufe NICHT schalten", 380, 1060))
upsert({"id": "opt_broker_nas", "type": "mqtt-broker", "name": "MQTT (NAS) Optimizer lesen", "broker": "10.10.10.128", "port": "1883",
        "clientid": "nodered-optimizer-nas", "autoConnect": True, "usetls": False, "protocolVersion": "4", "keepalive": "60",
        "cleansession": True, "autoUnsubscribe": True, "birthTopic": "", "birthQos": "0", "birthRetain": "false", "birthPayload": "",
        "birthMsg": {}, "closeTopic": "", "closeQos": "0", "closeRetain": "false", "closePayload": "", "closeMsg": {}, "willTopic": "",
        "willQos": "0", "willRetain": "false", "willPayload": "", "willMsg": {}, "userProps": "", "sessionExpiry": ""})
for _i, _t in enumerate(("panasonic_heat_pump/main/+", "panasonic_heat_pump/extra/+", "panasonic_heat_pump/commands/SetQuietMode", "panasonic_heat_pump/commands/SetHeatingControl",
                         "panasonic_heat_pump/commands/SetPumpFlowrateMode", "panasonic_heat_pump/commands/SetMaxPumpDuty", "panasonic_heat_pump/commands/SetQuietModePriority")):
    upsert({"id": f"opt_mqtt_hp_{_i}", "type": "mqtt in", "z": TAB, "name": "", "topic": _t, "qos": "0", "datatype": "auto-detect",
            "broker": "opt_broker_nas", "nl": False, "rap": True, "rh": 0, "inputs": 0, "x": 160, "y": 1120 + 60 * _i, "wires": [["opt_hp_in"]]})
upsert(fn("opt_hp_in", "Anlagenwerte lesen (nur lesen)", HP_IN_JS, 1, [["opt_f_qev"]], 440, 1180, FS))
upsert(fn("opt_quiet", "Quiet-Wächter: Messung und Anzeige (Shadow)", QUIET_JS.replace("__COPKW__", COP_KW_JS), 5, [["opt_t_quiet"], ["opt_t_qstats", "opt_t_qstats2"], ["opt_f_quiet"], ["opt_f_qev"], ["opt_f_def"]], 700, 1060, FS))
# Kinderzimmer oben: Radiator-Relais und Heizluefter nur mitlesen (Venus/Shelly-Broker); die Regelung dazu liegt im Tab Dashboard
for _i, _t in enumerate(("shelly-radiator/events/rpc", "shelly-radiator/online", "shellies/shellyplug-s-heiz/relay/0", "shellies/shellyplug-s-heiz/relay/0/power", "shellies/shellyplug-s-heiz/online")):
    upsert({"id": f"opt_mqtt_kz_{_i}", "type": "mqtt in", "z": TAB, "name": "", "topic": _t, "qos": "0", "datatype": "auto-detect",
            "broker": "opt_broker_venus", "nl": False, "rap": True, "rh": 0, "inputs": 0, "x": 160, "y": 1400 + 60 * _i, "wires": [["opt_kz_in"]]})
upsert(fn("opt_kz_in", "Kinderzimmer-Zustände lesen (nur lesen)", KZ_IN_JS, 1, [["opt_f_qev"]], 440, 1500, FS))
for _fid, _name, _y in (("opt_f_qev", "Quiet-Ereignisse", 1180), ("opt_f_quiet", "Quiet-Protokoll", 1060), ("opt_f_def", "Abtau-Protokoll", 1120)):
    upsert({"id": _fid, "type": "file", "z": TAB, "name": _name, "filename": "filename", "filenameType": "msg", "appendNewline": False,
            "createDir": True, "overwriteFile": "false", "encoding": "utf8", "x": 960, "y": _y, "wires": [[]]})
for fid, name, y in (("opt_f_log", "Protokoll", 700), ("opt_f_ev", "Ereignisse", 780)):
    upsert({"id": fid, "type": "file", "z": TAB, "name": name, "filename": "filename", "filenameType": "msg",
            "appendNewline": False, "createDir": True, "overwriteFile": "false", "encoding": "utf8",
            "x": 960, "y": y, "wires": [[]]})

# ---------------------------------------------------------------- OpenWeatherMap: Eingabe im Dashboard (SYSTEM > EINSTELLUNGEN)
import re

sys_tab = next(n for n in flows if n["type"] == "ui_tab" and n["name"] == "SYSTEM")
sys_group = next(g for g in flows if g["type"] == "ui_group" and g["tab"] == sys_tab["id"]
                 and g["name"] in ("EINSTELLUNGEN", "SETTINGS"))
SG = sys_group["id"]
base = 1 + max(n.get("order", 0) for n in flows
               if n.get("group") == SG and n["type"].startswith("ui_") and not n["id"].startswith("opt_"))

# heading in the style of the existing "Node-RED-Einstellungen" line
line = next((n for n in flows if n.get("group") == SG and n["type"] == "ui_template"
             and not n["id"].startswith("opt_")), None)
head_fmt = line["format"] if line else "<b>OpenWeatherMap</b>"
if line and re.search(r"<left>[^<]*</left>", head_fmt):
    head_fmt = re.sub(r"(<left>)[^<]*(</left>)", r"\1OpenWeatherMap (Wetterdienst für die Optimierung)\2", head_fmt)
upsert({"id": "opt_ui_head", "type": "ui_template", "z": TAB, "group": SG, "name": "Linie OpenWeatherMap", "order": base,
        "width": 24, "height": 1, "format": head_fmt, "storeOutMessages": True, "fwdInMessages": True,
        "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": 880, "wires": [[]]})

upsert({"id": "opt_ui_form", "type": "ui_form", "z": TAB, "name": "OpenWeatherMap", "label": "", "group": SG,
        "order": base + 1, "width": 12, "height": 6,
        "options": [
            {"label": "API-Schlüssel", "value": "owm_key", "type": "password", "required": False, "rows": None},
            {"label": "Breitengrad (z. B. 50.1)", "value": "owm_lat", "type": "text", "required": False, "rows": None},
            {"label": "Längengrad (z. B. 8.6)", "value": "owm_lon", "type": "text", "required": False, "rows": None}],
        "formValue": {"owm_key": "", "owm_lat": "", "owm_lon": ""}, "payload": "", "submit": "SPEICHERN",
        "cancel": "LEEREN", "topic": "owm", "topicType": "str", "splitLayout": False, "className": "",
        "x": 960, "y": 920, "wires": [["opt_owm_save"]]})

upsert({"id": "opt_ui_info", "type": "ui_template", "z": TAB, "group": SG, "name": "Hinweis OpenWeatherMap",
        "order": base + 2, "width": 12, "height": 4,
        "format": '<div style="font-size:13px;color:#666;padding:6px 4px;line-height:1.5">'
                  'Der Schlüssel (kostenlos auf openweathermap.org) wird nicht angezeigt und nur in einer geschützten '
                  'Datei auf der NAS gespeichert. Leere Felder behalten ihren gespeicherten Wert, der gespeicherte Standort '
                  'steht in der Statuszeile unten. Neue Schlüssel sind manchmal erst nach ein bis zwei Stunden freigeschaltet.<br>'
                  'Die Wetterdaten dienen vorerst nur der Anzeige und dem Protokoll, sie greifen nicht in die '
                  'Regelung ein.</div>',
        "storeOutMessages": True, "fwdInMessages": True, "resendOnRefresh": True, "templateScope": "local",
        "className": "", "x": 1260, "y": 960, "wires": [[]]})

upsert({"id": "opt_ui_wxstatus", "type": "ui_text", "z": TAB, "group": SG, "order": base + 3, "width": 24, "height": 1,
        "name": "Status OpenWeatherMap", "label": "", "format": "{{msg.payload}}", "layout": "row-left",
        "className": "", "x": 960, "y": 1000, "wires": []})

upsert({"id": "opt_ui_toast", "type": "ui_toast", "z": TAB, "position": "top right", "displayTime": "5",
        "highlight": "", "sendall": True, "outputs": 0, "ok": "OK", "cancel": "", "raw": False, "className": "",
        "topic": "", "name": "Rückmeldung", "x": 1220, "y": 920, "wires": []})

upsert(inject("opt_i_owm_load", "Zugangsdaten prüfen", 0, 6, ["opt_owm_load"], 140, 920))
upsert(fn("opt_owm_load", "Gespeicherten Standort laden", OWM_LOAD_JS, 1, [["opt_ui_form"]], 420, 920, FS))
# nodes of earlier iterations that no longer exist
_OLD = ["opt_mqtt_2", "opt_ui_ctl", "opt_ui_wait", "opt_n_low", "opt_n_high", "opt_n_age", "opt_g_room", "opt_g_roomdetail", "opt_t_room", "opt_t_roomdetail"]
_OLD += [i for i in B if i.startswith(("opt_w_", "opt_g_cfg_"))]           # per-room inputs and groups of the earlier layout
for _rid in _OLD:
    if _rid in B:
        flows.remove(B.pop(_rid))
upsert(fn("opt_owm_save", "Zugangsdaten speichern", OWM_SAVE_JS, 4,
          [["opt_ui_form"], ["opt_ui_toast"], ["opt_owm_req"], ["opt_ui_wxstatus"]], 1100, 960, FS))

# ---------------------------------------------------------------- energy and prices: display and log only, no effect on the control
# live values from the Venus MQTT (passive: this tab only listens), prices from evcc, PV forecast from the VRM API (token entered in the dashboard)
upsert(comment("opt_c6", "Energie & Preise: Venus-MQTT (live), evcc (Preise), VRM-API (PV-Prognose) - nur Anzeige und Protokoll", 380, 1360))
for _i, (_t, _b) in enumerate((("N/+/system/0/#", BROKER), ("evcc/site/+", "opt_broker_nas"), ("evcc/site/forecast/+", "opt_broker_nas"), ("evcc/site/battery/soc", "opt_broker_nas"), ("N/+/battery/278/Soc", BROKER))):
    upsert({"id": f"opt_mqtt_en{_i}", "type": "mqtt in", "z": TAB, "name": "", "topic": _t, "qos": "0", "datatype": "auto-detect",
            "broker": _b, "nl": False, "rap": True, "rh": 0, "inputs": 0, "x": 160, "y": 1400 + 50 * _i, "wires": [["opt_en_in"]]})
upsert(fn("opt_en_in", "Energiewerte lesen (nur lesen)", EN_IN_JS, 0, [], 440, 1425, FS))
upsert(inject("opt_i_en", "jede Minute", 60, 30, ["opt_energy"], 140, 1540))
upsert(fn("opt_energy", "Energie & Preise auswerten", ENERGY_JS, 5, [["opt_t_en"], ["opt_f_en"], ["opt_f_fc"], ["opt_ui_vrmstatus"], ["opt_t_fq"]], 440, 1540, FS))
for _fid, _name, _y in (("opt_f_en", "Energie-Protokoll", 1500), ("opt_f_fc", "Prognose-Schnappschüsse", 1580)):
    upsert({"id": _fid, "type": "file", "z": TAB, "name": _name, "filename": "filename", "filenameType": "msg", "appendNewline": False,
            "createDir": True, "overwriteFile": "false", "encoding": "utf8", "x": 760, "y": _y, "wires": [[]]})
upsert(inject("opt_i_plan", "jede Minute", 60, 45, ["opt_plan"], 140, 1800))
upsert(fn("opt_plan", "Wärmefahrplan berechnen (Shadow)", PLAN_JS.replace("__COPKW__", COP_KW_JS), 5, [["opt_t_plan", "opt_t_plan_tab"], ["opt_f_pact"], ["opt_f_peval"], ["opt_f_psnap"], []], 440, 1800, FS))
for _fid, _name, _y in (("opt_f_pact", "Plan: Ist-Werte je Slot", 1780), ("opt_f_peval", "Plan: Vergleich Prognose / Ist", 1840), ("opt_f_psnap", "Plan: Schnappschüsse", 1900)):
    upsert({"id": _fid, "type": "file", "z": TAB, "name": _name, "filename": "filename", "filenameType": "msg", "appendNewline": False,
            "createDir": True, "overwriteFile": "false", "encoding": "utf8", "x": 760, "y": _y, "wires": [[]]})
upsert(inject("opt_i_vrm", "VRM-Prognose abrufen", 1800, 40, ["opt_vrm_req"], 140, 1660))
upsert(fn("opt_vrm_req", "VRM-Anfrage", VRM_REQ_JS, 1, [["opt_http_vrm"]], 400, 1660, FS))
upsert({"id": "opt_http_vrm", "type": "http request", "z": TAB, "name": "VRM-API", "method": "GET", "ret": "obj", "paytoqs": "ignore",
        "url": "", "tls": "", "persist": False, "proxy": "", "insecureHTTPParser": False, "authType": "", "senderr": False,
        "headers": [], "x": 640, "y": 1660, "wires": [["opt_vrm_parse"]]})
upsert({"id": "opt_catch_vrm", "type": "catch", "z": TAB, "name": "", "scope": ["opt_http_vrm"], "uncaught": False,
        "x": 640, "y": 1720, "wires": [["opt_vrm_parse"]]})
upsert(fn("opt_vrm_parse", "VRM-Antwort auswerten", VRM_PARSE_JS, 1, [[]], 880, 1660))
head_vrm = head_fmt
if line and re.search(r"<left>[^<]*</left>", head_fmt):
    head_vrm = re.sub(r"(<left>)[^<]*(</left>)", r"\1VRM (PV-Prognose für die Optimierung)\2", head_fmt)
upsert({"id": "opt_ui_vrm_head", "type": "ui_template", "z": TAB, "group": SG, "name": "Linie VRM", "order": base + 4,
        "width": 24, "height": 1, "format": head_vrm, "storeOutMessages": True, "fwdInMessages": True,
        "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": 1660, "wires": [[]]})
upsert({"id": "opt_ui_vrm_form", "type": "ui_form", "z": TAB, "name": "VRM", "label": "", "group": SG,
        "order": base + 5, "width": 12, "height": 6,
        "options": [
            {"label": "Zugriffstoken", "value": "vrm_token", "type": "password", "required": False, "rows": None},
            {"label": "Installations-ID (Ziffern)", "value": "vrm_id", "type": "text", "required": False, "rows": None}],
        "formValue": {"vrm_token": "", "vrm_id": ""}, "payload": "", "submit": "SPEICHERN",
        "cancel": "LEEREN", "topic": "vrm", "topicType": "str", "splitLayout": False, "className": "",
        "x": 880, "y": 1720, "wires": [["opt_vrm_save"]]})
upsert({"id": "opt_ui_vrm_info", "type": "ui_template", "z": TAB, "group": SG, "name": "Hinweis VRM",
        "order": base + 6, "width": 12, "height": 4,
        "format": '<div style="font-size:13px;color:#666;padding:6px 4px;line-height:1.5">'
                  'Den Zugriffstoken legt man im VRM-Portal unter Einstellungen > Integrationen an. Er wird nicht angezeigt und nur in einer '
                  'geschützten Datei auf der NAS gespeichert. Leere Felder behalten ihren gespeicherten Wert. Die Prognose dient nur der '
                  'Anzeige und dem Protokoll, sie greift nicht in die Regelung ein.</div>',
        "storeOutMessages": True, "fwdInMessages": True, "resendOnRefresh": True, "templateScope": "local",
        "className": "", "x": 1260, "y": 1720, "wires": [[]]})
upsert({"id": "opt_ui_vrmstatus", "type": "ui_text", "z": TAB, "group": SG, "order": base + 7, "width": 24, "height": 1,
        "name": "Status VRM", "label": "", "format": "{{msg.payload}}", "layout": "row-left",
        "className": "", "x": 960, "y": 1780, "wires": []})
upsert(inject("opt_i_vrm_load", "VRM-Zugangsdaten prüfen", 0, 7, ["opt_vrm_load"], 140, 1780))
upsert(fn("opt_vrm_load", "Gespeicherte Installation laden", VRM_LOAD_JS, 1, [["opt_ui_vrm_form"]], 420, 1780, FS))
upsert(fn("opt_vrm_save", "VRM-Zugangsdaten speichern", VRM_SAVE_JS, 4,
          [["opt_ui_vrm_form"], ["opt_ui_toast"], ["opt_vrm_req"], ["opt_ui_vrmstatus"]], 1100, 1720, FS))

# ---------------------------------------------------------------- Optimierer: Entscheidungsmaschine (Shadow), Punkte, Ein-Klick-Uebernahme (GESPERRT ausgeliefert)
# Reiner Kern in tools/engine_core.js (in tools/engine_sim.js getestet). opt_engine rechnet jede Minute und schreibt nur OPT_* und Protokolle.
# opt_apply ist der EINZIGE Sendeweg im Tab: nur auf Klick in der Karte "Aktueller Vorschlag", nur mit Hauptschalter (apply.json) und freigegebener Regel,
# nur Whitelist-Befehle; der mqtt-out-Knoten ist standardmaessig deaktiviert (siehe APPLY_NODE_ACTIVE).
ENGINE_CORE_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine_core.js"), encoding="utf-8").read()

ENGINE_WRAP_JS = r"""
// ---------- Huelle der Entscheidungsmaschine (Shadow, schaltet NICHTS). Liest Anlagen- und Optimierer-Werte, ruft jede Minute den reinen Kern
// ENGINE.step, schreibt decisions-YYYY-MM.jsonl (jede Auswertung), scores-YYYY-MM.jsonl (Punkte) und Ereignisse, baut die Seite "Optimierer".
// Ausgaenge: 1 Vorschlag, 2 Regeln, 3 Punkte, 4 Entscheidungen, 5 Dateien, 6 Messwerte & Lernen, 7 COP: Ziel und Ist. msg.topic "anzeige" (von der Uebernahme): nur die Anzeige neu aufbauen.
var now = Date.now(), MIN = 60000;
var G = function (k) { var v; try { v = global.get(k, 'file'); } catch (e) { v = undefined; } return v !== undefined ? v : global.get(k); };
function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } v = Number(v); return isFinite(v) ? v : null; }
function p2(x) { return (x < 10 ? '0' : '') + x; }
function hm(ts) { return ts ? ENGINE.hhmm(ts) : '–'; }
function dmhm(ts) { if (!ts) { return '–'; } var d = new Date(ts); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '. ' + ENGINE.hhmm(ts); }
var CF = global.get('OPT_cfg') || {}, cfg = ENGINE.mergeCfg(Object.assign({}, CF.engine || {}, {cop: CF.cop || {}, zaehler: CF.zaehler || {}, copZiel: G('OPT_cop_eta') || undefined}));     // COP-Korrektur aus OPT_cfg.cop (eine Quelle); Stromquelle OPT_cfg.zaehler, Gütegrad aus cop_eta.json (opt_nas, nur lesen)
var ST = flow.get('eng');
if (!ST) {                                                                       // nach einem Neustart: Zustand aus der Datei (Faelle, Punkte, Zaehler), Zeitgeber neu
    var F0 = null;
    try { F0 = JSON.parse(fs.readFileSync('/data/optimizer/engine-state.json', 'utf8')); } catch (e) { F0 = null; }
    ST = {S: (F0 && F0.S) ? ENGINE.fixState(F0.S, now) : null, V: (F0 && F0.V && Array.isArray(F0.V.ep)) ? F0.V : {ep: [], open: {}}, saved: 0, last: null};
    if (ST.S) { ST.S.born = now; }
}
if (!ST.V) { ST.V = {ep: [], open: {}}; }                                         // aeltere Fassung im Flow-Kontext (Episoden statt Einzelzeilen)
// ---------- Eingabe (Schnappschuss) aus den globalen Werten
var HP = G('OPT_hp') || {}, hpTs = 0;
Object.keys(HP).forEach(function (k) { if (k.charAt(0) !== '_' && HP[k] && typeof HP[k].ts === 'number' && HP[k].ts > hpTs) { hpTs = HP[k].ts; } });
function hpv(n) { var e = HP[n]; return (e && typeof e.v === 'number' && now - e.ts < 30 * MIN) ? e.v : null; }
// Einstellungen (Heizstab, Heizgrenze) aendern sich selten; meldet HeishaMon sie nur bei Aenderung, gilt der letzte Wert bis 24 h (sonst fiele die Heizstab-Sperre still aus)
function hpSet(n) { var e = HP[n]; return (e && typeof e.v === 'number' && now - e.ts < 24 * 60 * MIN) ? e.v : null; }
function pick(a, b) { return a !== null ? a : b; }
var ss = G('F_SS') || {}, mq = G('MQTT') || {}, sol = G('F_SOLAR') || {}, rtc = G('F_RTC') || {}, nr = G('NightReductionWaterTemp') || {};
var otherQ = [], otherS = [];
if (ss.state === 1 && ss.QM_state === 1) { otherQ.push('HeishaMoNR-Quiet-Logik AN'); }
if (mq.allow_scheduler === 1) { otherQ.push('Scheduler darf senden'); }
if (sol.state === 1) { otherQ.push('Solar AN'); }
if (HP.Quiet_Mode_Schedule && HP.Quiet_Mode_Schedule.v === 1) { otherQ.push('WP-Zeitplan AN'); }
if (rtc.z1 && rtc.z1.state === 1) { otherS.push('Raumregelung (RTC) AN'); }
if (nr.state === 1) { otherS.push('Nachtabsenkung AN'); }
if (ss.state === 1) { otherS.push('Sanftanlauf eingeschaltet'); }
var shFin = num(G('SHIFT_Final')); if (shFin !== null && shFin !== 0) { otherS.push('HeishaMoNR-Verschiebung ' + shFin + ' K'); }
var at = num(G('TOP14_Outside_Temp'));
var cvLo = num(G('Z1_Heat_Curve_Outside_Low_Temp')), cvHi = num(G('Z1_Heat_Curve_Outside_High_Temp')), cvTl = num(G('Z1_Heat_Curve_Target_Low_Temp')), cvTh = num(G('Z1_Heat_Curve_Target_High_Temp'));
var sollKurve = (at === null || cvLo === null || cvHi === null || cvTl === null || cvTh === null || cvHi <= cvLo) ? null : (at <= cvLo ? cvTh : (at >= cvHi ? cvTl : cvTh + (cvTl - cvTh) * (at - cvLo) / (cvHi - cvLo)));
var RO = global.get('OPT_rooms') || {};
__EIGEN__
var rooms = (CF.rooms || []).map(function (rc) {
    var r = RO[rc.id] || {}, a = r.ts ? (now - r.ts) / MIN : null, lim = rc.maxAgeMin || (CF.sensor && CF.sensor.maxAgeMin) || 90;
    var band = isFinite(rc.min) && isFinite(rc.max) && rc.min < rc.max, on = rc.active !== false;
    return {id: rc.id, name: rc.name, t: r.ema !== undefined ? r.ema : null, age: a, min: rc.min, max: rc.max, active: on && band, valid: on && band && r.ema !== undefined && a !== null && a <= lim, eigeneHeizung: eigenOf(rc), sonnenfenster: sonneOf(rc)};
});
var OS = G('OPT_state') || {}, korr = (OS.ts && now - OS.ts < 5 * MIN && typeof OS.korr === 'number') ? {v: OS.korr, code: String(OS.korrCode || ''), distrib: !!OS.distrib, lead: String(OS.korrLead || '')} : null;
var KZ = G('OPT_kz') || {};
var inp = {t: now, hpAge: hpTs ? (now - hpTs) / MIN : null,
           hz: num(G('compressor_frequency')), vl: num(G('TOP6_Main_Outlet_Temp')), rl: num(G('TOP5_Main_Inlet_Temp')), soll: num(G('TOP42_Z1_Water_Target_Temp')), dT: num(G('TOP23_Heat_Delta')),
           pel: num(G('TOP16_Heat_Energy_Consumption')), pth: hpv('Heat_Power_Production_Extra'), flow: num(G('TOP1_Pump_Flow')), pump: hpv('Pump_Speed'),
           q: pick(hpv('Quiet_Mode_Level'), num(G('TOP18_Quiet_Mode_Level'))), qPrio: hpv('Quiet_Mode_Priority'), hc: hpv('Heating_Control'), at: at,
           defrost: num(G('TOP26_Defrosting_State')) === 1 ? 1 : 0, dhw: num(G('TOP20_ThreeWay_Valve_State')) === 1 ? 1 : 0, ss: (ss.state === 1 && Math.abs(num(ss.correction_value) || 0) > 0) ? 1 : 0, ssAn: ss.state === 1 ? 1 : 0,   // ssAn (wertung-wirkung 20.10.2026): Sanftanlauf eingeschaltet
           rt: num(G('compressor_runtime')), shift: pick(hpv('Z1_Heat_Request_Temp'), num(G('TOP27_Z1_Heat_Request_Temp'))), heatMode: num(G('TOP76_Heating_Mode')), z1Sensor: num(G('TOP111_Z1_Sensor_Settings')),
           heaterI: hpv('Internal_Heater_State'), heaterE: hpv('External_Heater_State'), htrOnAT: hpSet('Heater_On_Outdoor_Temp'), htrStartDelta: hpSet('Heater_Start_Delta'), htrDelay: hpSet('Heater_Delay_Time'), heatOffAT: hpSet('Heating_Off_Outdoor_Temp'),
           sollKurve: sollKurve, block: mq.block_active === 1 ? 1 : 0, otherQ: otherQ.length ? otherQ.join(', ') : null, otherShift: otherS.length ? otherS.join(', ') : null,
           kzRad: (KZ.rad && typeof KZ.rad.on === 'boolean') ? (KZ.rad.on ? 1 : 0) : null, rooms: rooms, korr: korr,
           err: (HP.Error && HP.Error.v !== undefined && HP.Error.v !== null) ? String(HP.Error.v) : null, pipeIn: hpv('Inside_Pipe_Temp'),     // 14.10.2026: Fehlercode (TOP44, H23-Waechter), Leitungstemperatur Innengeraet (H23-Vorstufe)
           kurve: (cvLo !== null && cvHi !== null && cvTl !== null && cvTh !== null) ? [cvLo, cvHi, cvTl, cvTh] : null};                      // Heizkurve Z1 (Kennzahl Kurvenform je Kurve)
// Sonnenfenster (Raumeinfluss v5): PV-Leistung jetzt (opt_energy aus OPT_en, OPT_plan_in.pvNow, hoechstens 5 min alt) und OWM-Bewoelkung (hoechstens weather.maxAgeMin alt)
var PIe = G('OPT_plan_in') || {}, WXe = G('OPT_weather') || {};
if (PIe.ts && now - PIe.ts < 5 * MIN && num(PIe.pvNow) !== null) { inp.pv = num(PIe.pvNow); }
if (WXe.ts && now - WXe.ts <= ((CF.weather && num(CF.weather.maxAgeMin)) || 60) * MIN && num(WXe.clouds) !== null) { inp.wolken = num(WXe.clouds); }
// Winterpaket 16.10.2026: Abtauwetter (Sperre "abtausprung"): OWM-Feuchte (hoechstens weather.maxAgeMin alt) und Rohr aussen (Outside_Pipe_Temp, -128 = kein Fuehler)
if (WXe.ts && now - WXe.ts <= ((CF.weather && num(CF.weather.maxAgeMin)) || 60) * MIN && num(WXe.rh) !== null) { inp.rh = num(WXe.rh); }
var pipeO = hpSet('Outside_Pipe_Temp'); if (pipeO !== null && pipeO > -100) { inp.pipeOut = pipeO; }
// cop-ziel 17.10.2026: Stromzaehler (opt_zaehler, OPT_zaehler; Waermepumpe ohne Heizstab, Heizstab) mit Alter; der Kern nutzt ihn nur bei cfg.zaehler.quelle = 'zaehler' und Alter <= 5 min
var ZLx = global.get('OPT_zaehler') || {};
if (typeof ZLx.ts === 'number' && now - ZLx.ts < 60 * MIN && num(ZLx.wp_w) !== null) { inp.zw = num(ZLx.wp_w); inp.zAge = (now - ZLx.ts) / MIN; if (num(ZLx.heizstab_w) !== null) { inp.zh = num(ZLx.heizstab_w); } }   // nur bei Aenderung gemeldet: letzter Wert gilt (wie die Einstellungen) bis 24 h
// Vorausschau: OWM-Vorhersage und Gebaeudemodell des Waermefahrplans (Gate, coefActivate); Sonne/Wind nur bei aktivem Modell (sonst nicht in der Eingabe)
var vsIn = null; try { vsIn = ENGINE.vorschau(G('OPT_weather'), G('OPT_plan'), G('OPT_plan_in'), at, now); } catch (e) { vsIn = null; }
if (vsIn) { inp.vs = vsIn; }
// ---------- Takt-Messung: einmalig aus quiet-YYYY-MM.csv (Vormonat und laufender Monat) nachladen, stueckweise (je Minute hoechstens 4 MB bzw. 300 ms);
// waehrend des Nachladens fuehrt der Kern die Live-Eingabe nicht in die Takt-Messung (die Datei enthaelt diese Minuten), danach normal weiter
var files = [], d0 = new Date(now), month = d0.getFullYear() + '-' + p2(d0.getMonth() + 1);
function nachladen(T) {
    var nl = T.nl, NLC = (CF.engine && CF.engine.nachladen) || {}, chunk = num(NLC.chunkBytes) || 1048576, maxB = num(NLC.maxBytes) || 4194304, maxMs = num(NLC.maxMs) || 300;
    var t0 = Date.now(), done = 0, buf = Buffer.alloc(chunk);
    while (T.nl.laeuft && done < maxB && Date.now() - t0 < maxMs) {
        if (nl.i >= nl.dateien.length) { ENGINE.nlEnde(T, cfg.takt, now); break; }
        var fd = null, n = 0;
        try { fd = fs.openSync(nl.dateien[nl.i], 'r'); n = fs.readSync(fd, buf, 0, chunk, nl.pos); } catch (e) { n = 0; }
        if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* egal */ } }
        var cut = n > 0 ? buf.lastIndexOf(10, n - 1) : -1;
        if (cut < 0) { if (n >= chunk) { nl.pos += n; } else { nl.i++; nl.pos = 0; } continue; }   // Datei zu Ende (oder fehlt) -> naechste; ueberlange Zeile ueberspringen
        ENGINE.nlZeilen(T, buf.toString('utf8', 0, cut + 1), cfg.takt);
        nl.pos += cut + 1; done += cut + 1;
    }
}
if (msg.topic !== 'anzeige' && ST.S) {
    if (!ST.S.takt || !ST.S.takt.nl) {
        var dP = new Date(d0.getFullYear(), d0.getMonth() - 1, 1);
        ST.S.takt = ENGINE.taktNew(); ST.S.takt.nl = ENGINE.nlNeu(['/data/optimizer/quiet-' + dP.getFullYear() + '-' + p2(dP.getMonth() + 1) + '.csv', '/data/optimizer/quiet-' + month + '.csv'], now);
    }
    if (ST.S.takt.nl.laeuft) { try { nachladen(ST.S.takt); } catch (e) { node.warn('Takt nachladen: ' + e.message); ENGINE.nlEnde(ST.S.takt, cfg.takt, now); } }
}
// ---------- rechnen (jede Minute), protokollieren
if (msg.topic !== 'anzeige') {
    var o;
    try { o = ENGINE.step(ST.S, inp, cfg); } catch (e) { node.warn('Entscheidungsmaschine: ' + e.message); global.set('OPT_engine', {ts: 0, fehler: e.message}); return null; }
    ST.S = o.S; ST.last = {t: now, res: o.res, prop: o.prop, ende: o.ende, locks: o.locks, anl: {z: o.d.zustand, lauf: o.d.runMin, hz: o.d.hz, q: o.d.q, vlR: o.d.vlRueck}};
    ENGVIEW.track(ST.V, o.res, ST.S.rules, now);
    files.push({filename: '/data/optimizer/decisions-' + month + '.jsonl', payload: JSON.stringify(o.rec) + '\n'});
    if (o.scores.length) { files.push({filename: '/data/optimizer/scores-' + month + '.jsonl', payload: o.scores.map(function (x) { return JSON.stringify(x); }).join('\n') + '\n'}); }
    var evl = o.ev.slice();
    o.scores.forEach(function (x) { evl.push(['optimierer_punkte', x.regel + ' ' + x.typ + ' ' + (x.punkte > 0 ? '+' : '') + x.punkte + ': ' + x.text]); });
    if (evl.length) {
        var ef = '/data/optimizer/quiet-events-' + month + '.csv', eh = '';
        try { fs.readFileSync(ef, 'utf8'); } catch (e) { eh = 'zeit,ereignis,wechsel\n'; }
        files.push({filename: ef, payload: eh + evl.map(function (x) { return ENGINE.iso(now) + ',' + x[0] + ',' + String(x[1]).replace(/,/g, ';').replace(/\n/g, ' ') + '\n'; }).join('')});
    }
    // hc: Heizregelung-Hinweis, deckel: wirksamer Deckel der jetzigen Quiet-Stufe (Review-Paket 13.10.2026: der Waechter opt_quiet zeigt diese Werte an, statt sie selbst zu rechnen)
    global.set('OPT_engine', {ts: now, ver: ENGINE.VER, prop: o.prop, locks: o.locks, ende: o.ende, halten: o.halten, rules: o.res.map(function (r) { return {id: r.id, st: r.st}; }), hc: o.hc, deckel: o.deckel,
                              hinweise: o.hinweise, stoerung: o.stoerung});                                    // 14.10.2026: Waechter (Waermeverteilung, Dornroeschenschlaf, Kurvenform, H23) und Stoerung (sperrt die Uebernahme)
    if (!ST.saved || now - ST.saved >= 10 * MIN || o.scores.length || o.ev.length) {
        try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync('/data/optimizer/engine-state.json', JSON.stringify({S: ST.S, V: ST.V})); ST.saved = now; } catch (e) { node.warn('engine-state.json: ' + e.message); }
    }
}
// Wetterkarte (Seite Optimierung, wetter-grafik 17.10.2026; nur Anzeige): COP-Ziel 24 h zurueck (Stundenwerte des Kerns) und 36 h voraus (ENGINE.copZiel mit OWM-Prognose,
// Heizkurve Z1 + Verschiebung, PV-Prognose) als global OPT_cz_verlauf, alle 5 min; ein Fehler hier aendert an der Maschine nichts
if (msg.topic !== 'anzeige' && (!ST.czv || now - ST.czv >= 5 * MIN)) {
    ST.czv = now;
    try { global.set('OPT_cz_verlauf', WXC.copVerlauf(ENGINE, cfg, ST.S, G('OPT_weather'), G('OPT_plan_in'), inp, now)); } catch (e) { global.set('OPT_cz_verlauf', {ts: now, fehler: String(e.message)}); }
}
flow.set('eng', ST);
if (!ST.last) { return null; }
// ---------- Anzeige (Karten-Daten aus ENGVIEW.build, gezeichnet in den Vorlagen mit optEngUi); Lernstand des Waermefahrplans aus OPT_plan (nur lesen)
var V = ENGVIEW.build({now: now, last: ST.last, S: ST.S, V: ST.V, AP: global.get('OPT_apply') || {}, enabled: global.get('OPT_apply_enabled') === true, cfg: cfg, plan: G('OPT_plan') || null});
return [{payload: V.card}, {payload: V.rules}, {payload: V.score}, {payload: V.log}, files.length ? files : null, {payload: V.mess}, {payload: V.cop}];
"""

APPLY_WRAP_JS = r"""
// ---------- Ein-Klick-Uebernahme (ausgeliefert GESPERRT). Einziger Sendeweg des Optimierer-Tabs, nur auf Klick in der Karte "Aktueller Vorschlag".
// Pruefkette im Kern (ENGINE.applyRequest): Hauptschalter (apply.json, Standard AUS), freigegebene Regel, aktueller Vorschlag (ID + Pruefsumme), Alter,
// Whitelist + Wertebereich, frische Daten, Abgleich mit dem Ist-Wert, MQTT-Notbremse, Rate und Tageslimit. Jede 15 s (tick): Ruecklesen, begrenzte
// Wiederholung, Warnung bei Abweichung, Rueckweg. Alles in applied-YYYY-MM.jsonl. Ausgaenge: 1 mqtt out (deaktiviert ausgeliefert), 2 Meldung, 3 Dateien, 4 Anzeige.
var now = Date.now(), MIN = 60000;
var KNOTEN = __KNOTEN__;                                                         // vom Generator: false = Sendeknoten opt_apply_mqtt deaktiviert erzeugt (Standard), true = mit --uebernahme-knoten-aktiv
var G = function (k) { var v; try { v = global.get(k, 'file'); } catch (e) { v = undefined; } return v !== undefined ? v : global.get(k); };
function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } v = Number(v); return isFinite(v) ? v : null; }
function p2(x) { return (x < 10 ? '0' : '') + x; }
var AC = {enabled: false, rules: []};                                            // keine Datei, kaputte Datei oder enabled != true: gesperrt
try { var j = JSON.parse(fs.readFileSync('/data/optimizer/apply.json', 'utf8')); if (j && j.enabled === true) { AC.enabled = true; } if (j && Array.isArray(j.rules)) { AC.rules = j.rules.filter(function (x) { return typeof x === 'string'; }); } } catch (e) { /* gesperrt */ }
var A = flow.get('apply');
if (!A) { try { A = JSON.parse(fs.readFileSync('/data/optimizer/apply-state.json', 'utf8')); } catch (e) { A = null; } }
var A0 = JSON.stringify(A || null);
var HP = G('OPT_hp') || {}, hpTs = 0;
Object.keys(HP).forEach(function (k) { if (k.charAt(0) !== '_' && HP[k] && typeof HP[k].ts === 'number' && HP[k].ts > hpTs) { hpTs = HP[k].ts; } });
function hpv(n) { var e = HP[n]; return (e && typeof e.v === 'number' && now - e.ts < 30 * MIN) ? e.v : null; }
function pick(a, b) { return a !== null ? a : b; }
var mq = G('MQTT') || {};
var plant = {q: pick(hpv('Quiet_Mode_Level'), num(G('TOP18_Quiet_Mode_Level'))), shift: pick(hpv('Z1_Heat_Request_Temp'), num(G('TOP27_Z1_Heat_Request_Temp'))), hpAge: hpTs ? (now - hpTs) / MIN : null,
             block: mq.block_active === 1 ? 1 : 0, heatMode: num(G('TOP76_Heating_Mode')), z1Sensor: num(G('TOP111_Z1_Sensor_Settings')),
             err: (HP.Error && HP.Error.v !== undefined && HP.Error.v !== null) ? String(HP.Error.v) : null,       // Fehlercode (TOP44): bei einer Stoerung (z. B. H23) keine Uebernahme und kein Rueckweg
             hc: hpv('Heating_Control')};                                                                         // Heizregelung 0 Comfort / 1 Efficiency (Ruecklesen SetHeatingControl, 14.10.2026)
var eng = global.get('OPT_engine') || {};
var ctx = {now: now, enabled: AC.enabled, knoten: KNOTEN, rules: AC.rules, eng: eng, plant: plant, cfg: ENGINE.mergeCfg(Object.assign({}, ((global.get('OPT_cfg') || {}).engine) || {}, {cop: (global.get('OPT_cfg') || {}).cop || {}})), endReason: eng.ende || {}, halten: eng.halten || {}};
var t = String(msg.topic || ''), r;
try { r = t === 'tick' ? ENGINE.applyTick(A, ctx) : ENGINE.applyRequest(A, {topic: t, payload: (msg.payload && typeof msg.payload === 'object') ? {id: String(msg.payload.id || ''), sum: String(msg.payload.sum || '')} : {}}, ctx); }
catch (e) { node.warn('Übernahme: ' + e.message); return [null, {topic: 'Optimierer', payload: 'Übernahme: Fehler (' + e.message + '). Nichts gesendet.', highlight: 'red'}, null, null]; }
A = r.A;
if (r.sperren) {                                                                  // Not-Aus aus dem Dashboard: Hauptschalter aus (Entsperren nur ueber apply.json)
    AC.enabled = false;
    try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync('/data/optimizer/apply.json', JSON.stringify({enabled: false, rules: AC.rules, gesperrt: ENGINE.iso(now), durch: 'Dashboard'}, null, 1)); } catch (e) { node.warn('apply.json: ' + e.message); }
}
global.set('OPT_apply_enabled', AC.enabled);
// letzte Sicherung vor dem Ausgang: nur Whitelist-Topic, nur erlaubter Wert, nie bei Notbremse
var out1 = [];
r.send.forEach(function (m) {
    var W = null; Object.keys(ENGINE.WHITELIST).forEach(function (k) { if (ENGINE.WHITELIST[k].topic === m.topic) { W = ENGINE.WHITELIST[k]; } });
    var v = num(m.payload);
    if (!W || v === null || W.werte.indexOf(v) < 0 || mq.block_active === 1) { node.warn('Übernahme: Befehl verworfen (' + m.topic + '=' + m.payload + ')'); return; }
    global.set('MQTT_Source', m.source);                                          // Quelle fuer den Waechter und das HeishaMoNR-Protokoll
    out1.push({topic: m.topic, payload: String(v), qos: 0, retain: false});
});
var d0 = new Date(now), month = d0.getFullYear() + '-' + p2(d0.getMonth() + 1), files = [];
if (r.log.length) {
    files.push({filename: '/data/optimizer/applied-' + month + '.jsonl', payload: r.log.map(function (x) { x.hauptschalter = AC.enabled; return JSON.stringify(x); }).join('\n') + '\n'});
    var ef = '/data/optimizer/quiet-events-' + month + '.csv', eh = '';
    try { fs.readFileSync(ef, 'utf8'); } catch (e) { eh = 'zeit,ereignis,wechsel\n'; }
    files.push({filename: ef, payload: eh + r.log.map(function (x) { return x.t + ',optimierer_' + x.aktion + ',' + String((x.ergebnis || '') + ' ' + (x.befehl ? x.befehl + '=' + x.wert : '') + ' ' + (x.grund || '') + ' ' + (x.id || '')).replace(/,/g, ';').trim() + '\n'; }).join('')});
}
flow.set('apply', A);
if (JSON.stringify(A) !== A0) { try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync('/data/optimizer/apply-state.json', JSON.stringify(A)); } catch (e) { node.warn('apply-state.json: ' + e.message); } }
global.set('OPT_apply', {ts: now, aktiv: A.aktiv, ak: A.ak || {}, pending: A.pending, alarm: A.alarm, verworfen: A.verworfen, n: A.n, day: A.day, lastSend: A.lastSend, enabled: AC.enabled, knoten: KNOTEN, rules: AC.rules});
var toast = r.toast ? {topic: 'Optimierer', payload: r.toast.text, highlight: r.toast.color || ''} : null;
var refresh = (t !== 'tick' || r.log.length) ? {topic: 'anzeige'} : null;
return [out1.length ? out1 : null, toast, files.length ? files : null, refresh];
"""

# Seite "Optimierer" (ENG_TAB oben bei OPT_W definiert): fuenf Karten der Maschine (Gruppen-Reihenfolge 1-5), darunter die beiden Quiet-Statistik-Karten (6, 7)
upsert({"id": ENG_TAB, "type": "ui_tab", "name": "Optimierer", "icon": "lightbulb_outline", "order": 12.55, "disabled": False, "hidden": False})
# Gruppenbreite (13.10.): alle Karten gleich breit (Masonry-Falle). 17 Einheiten = 912 px: ab ~1840 px Fensterbreite zwei Spalten (1920 und 2560),
# bei 1024 px eine Spalte ohne waagrechtes Scrollen (Inhalt ~1007 px). Breiter als 18 (966 px) scrollt bei 1024 waagrecht; 16 und schmaler schneidet
# die fuenf Kacheln je Zeile (Kachelnamen bis 17 Zeichen). Die Karte "Aktueller Vorschlag" ist immer hoeher als "Regeln" (Mindesthoehe ohne Vorschlag),
# damit die Masonry die Karten mit und ohne Vorschlag gleich anordnet: links Vorschlag, Messwerte; rechts Regeln, Punkte, Entscheidungen. Die beiden
# Quiet-Karten (gleich hoch) folgen danach und fuellen je eine Spalte nach unten auf; sie aendern die Anordnung der fuenf Karten nicht. ENG_W steht oben bei OPT_W.
# [Gruppe, Titel, Vorlage, Art, Starthoehe in Einheiten (passt ohne Einpassen fuer den ueblichen Inhalt, statische Vorschau 13.10.), y im Editor]
ENG_GROUPS = (("opt_g_eng_prop", "Aktueller Vorschlag", "opt_t_eng_prop", "card", 4, 2060), ("opt_g_eng_rules", "Regeln", "opt_t_eng_rules", "rules", 3, 2100),
              ("opt_g_eng_score", "Punkte", "opt_t_eng_score", "score", 9, 2140), ("opt_g_eng_mess", "Messwerte & Lernen", "opt_t_eng_mess", "mess", 10, 2160),
              ("opt_g_eng_log", "Entscheidungen", "opt_t_eng_log", "log", 12, 2180))
for _ord, _g in enumerate(ENG_GROUPS, start=1):
    upsert({"id": _g[0], "type": "ui_group", "name": _g[1], "tab": ENG_TAB, "order": _ord, "disp": True, "width": ENG_W, "collapse": False, "className": ""})

ENGINE_VIEW_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine_view.js"), encoding="utf-8").read()      # Karten-Daten (rein, getestet)
ENG_UI_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "eng_ui.js"), encoding="utf-8").read()              # Darstellung (rein, getestet)


def eng_format(kind, node_id, with_chart=False):
    """Karte der Seite "Optimierer": zeichnet die Nutzlast mit optEngUi (HTML aus reinen Funktionen), Knoepfe schicken nur Aktion + ID + Pruefsumme.
    Nach jedem Zeichnen passt sich die Karte sofort ein (FIT_JS dieser Karte), nicht erst im 1,5-s-Takt: der Takt ruht, solange das Fenster
    verdeckt ist (document.visibilityState), dann blieben die Starthoehen stehen und der Inhalt scrollte in der Karte."""
    return ('<div class="optfit"><div id="oe_' + kind + '"></div></div>'
            + ("<script>" + UI_CHART_JS + "</script>" if with_chart else "")
            + "<script>" + ENG_UI_JS + "</script><script>(function (scope) {\n"
            "var last = null;\n"
            "function draw() { var el = document.getElementById('oe_" + kind + "'); if (el && last && last.payload && window.optEngUi) { window.optEngUi.mount(el, '" + kind + "', last.payload, scope);"
            " var F = window.__optFit; if (F && F.fns && F.fns['" + node_id + "']) { setTimeout(F.fns['" + node_id + "'], 60); } } }\n"
            "window.__optChMap = window.__optChMap || {}; window.__optChMap.oe_" + kind + " = draw;\n"
            "if (!window.__optChRs) { window.__optChRs = true; var tm = null; window.addEventListener('resize', function () { clearTimeout(tm); tm = setTimeout(function () { Object.keys(window.__optChMap).forEach(function (k) { window.__optChMap[k](); }); }, 200); }); }\n"
            "scope.$watch('msg', function (m) { last = m; setTimeout(draw, 40); });\n"
            "})(scope);</script>")


def eng_template(i, gid, name, height, fmt, y, wires=None):
    return {"id": i, "type": "ui_template", "z": TAB, "group": gid, "name": name, "order": 1, "width": 0, "height": height,
            "format": fmt + FIT_JS.replace("__ID__", i), "storeOutMessages": True, "fwdInMessages": False, "resendOnRefresh": True,
            "templateScope": "local", "className": "", "x": 1260, "y": y, "wires": wires if wires is not None else [[]]}


upsert(comment("opt_c_eng", "Optimierer: Entscheidungsmaschine (Shadow, schaltet nichts) · Übernahme nur per Klick, GESPERRT ausgeliefert", 380, 2040))
for _g in ENG_GROUPS:
    upsert(eng_template(_g[2], _g[0], _g[1], _g[4], eng_format(_g[3], _g[2], _g[3] == "score"), _g[5], [["opt_apply"]] if _g[3] == "card" else None))
upsert(inject("opt_i_engine", "jede Minute", 60, 50, ["opt_engine"], 140, 2100))
# Ausgaenge: 1 Vorschlag, 2 Regeln, 3 Punkte, 4 Entscheidungen, 5 Dateien, 6 Messwerte & Lernen, 7 COP: Ziel und Ist (hinten angefuegt, damit die Dateien Ausgang 5 bleiben)
upsert(fn("opt_engine", "Entscheidungsmaschine (Shadow)", ENGINE_CORE_JS + ENGINE_VIEW_JS + WX_CORE_JS + ENGINE_WRAP_JS.replace("__EIGEN__", EIGEN_JS), 7,
          [["opt_t_eng_prop"], ["opt_t_eng_rules"], ["opt_t_eng_score"], ["opt_t_eng_log"], ["opt_f_eng"], ["opt_t_eng_mess"], ["opt_t_eng_cop"]], 440, 2100, FS))
# Karte "COP: Ziel und Ist" (cop-ziel 17.10.2026) auf der Seite Optimierer, gleich breit wie die anderen Karten (ENG_W), als letzte Gruppe (Reihenfolge 8 nach den beiden
# Quiet-Karten): die Anordnung der fuenf Maschinenkarten und der Quiet-Karten bleibt, die neue Karte fuellt die kuerzere Spalte auf
# ui-review-b 20.10.2026: vor den beiden (zugeklappten) Quiet-Karten (Reihenfolge 5,5), damit sie die kuerzere Spalte auffuellt und die Quiet-Karten unten folgen
upsert({"id": "opt_g_eng_cop", "type": "ui_group", "name": "COP: Ziel und Ist", "tab": ENG_TAB, "order": 5.5, "disp": True, "width": ENG_W, "collapse": False, "className": ""})
upsert(eng_template("opt_t_eng_cop", "opt_g_eng_cop", "COP: Ziel und Ist", 8, eng_format("cop", "opt_t_eng_cop"), 2200))
upsert({"id": "opt_f_eng", "type": "file", "z": TAB, "name": "Entscheidungen, Punkte, Ereignisse", "filename": "filename", "filenameType": "msg", "appendNewline": False,
        "createDir": True, "overwriteFile": "false", "encoding": "utf8", "x": 760, "y": 2160, "wires": [[]]})
# Uebernahme: Klick (Karte) und Takt alle 15 s -> opt_apply -> (1) mqtt out GESPERRT, (2) Meldung, (3) Protokoll, (4) Anzeige neu
upsert({"id": "opt_i_apply", "type": "inject", "z": TAB, "name": "alle 15 s (Rücklesen, Rückweg)", "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}],
        "repeat": "15", "crontab": "", "once": True, "onceDelay": "55", "topic": "tick", "payload": "", "payloadType": "date", "x": 160, "y": 2240, "wires": [["opt_apply"]]})
upsert(fn("opt_apply", "Übernahme per Klick (gesperrt ausgeliefert)", ENGINE_CORE_JS + APPLY_WRAP_JS.replace("__KNOTEN__", "true" if APPLY_NODE_ACTIVE else "false"), 4,
          [["opt_apply_mqtt"], ["opt_ui_toast"], ["opt_f_eng"], ["opt_engine"]], 440, 2240, FS))
upsert({"id": "opt_broker_cmd", "type": "mqtt-broker", "name": "MQTT (NAS) Optimierer Übernahme", "broker": "10.10.10.128", "port": "1883",
        "clientid": "nodered-optimizer-cmd", "autoConnect": True, "usetls": False, "protocolVersion": "4", "keepalive": "60",
        "cleansession": True, "autoUnsubscribe": True, "birthTopic": "", "birthQos": "0", "birthRetain": "false", "birthPayload": "",
        "birthMsg": {}, "closeTopic": "", "closeQos": "0", "closeRetain": "false", "closePayload": "", "closeMsg": {}, "willTopic": "",
        "willQos": "0", "willRetain": "false", "willPayload": "", "willMsg": {}, "userProps": "", "sessionExpiry": ""})
_apply_out = {"id": "opt_apply_mqtt", "type": "mqtt out", "z": TAB, "name": "Übernahme → HeishaMon (GESPERRT)", "topic": "", "qos": "0", "retain": "false",
              "respTopic": "", "contentType": "", "userProps": "", "correl": "", "expiry": "", "broker": "opt_broker_cmd", "x": 760, "y": 2220, "wires": []}
if not APPLY_NODE_ACTIVE:
    _apply_out["d"] = True                      # deaktiviert: Node-RED legt den Knoten gar nicht an, nichts kann gesendet werden
upsert(_apply_out)

# ---------------------------------------------------------------- Stromzaehler Shelly 3EM-63 Gen3 (cop-ziel 17.10.2026): NUR LESEN (dynamische Abos, kein mqtt out), Karte auf "Daten & Güte"
# opt_zaehler: Nachrichten des Shelly (Venus- oder NAS-Broker, je nach OPT_cfg.zaehler.broker) -> OPT_zaehler; jede Minute Vergleich mit TOP16 + Korrektur, Heizstab-Sprungerkennung,
# Karte; Eingabe der Karte -> config.json "zaehler" (keine Geheimnisse). Abos: beim Start, nach dem Speichern und alle 10 min, solange 5 min nichts kam.
ZAEHLER_CORE_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "zaehler_core.js"), encoding="utf-8").read()
ZAEHLER_WRAP_JS = r"""
// ---------- Huelle Stromzaehler (NUR LESEN). Eingaenge: MQTT-Nachrichten des Shelly, 'init' (Start), 'tick' (jede Minute), 'zaehler_speichern' (Karte).
// Ausgaenge: 1 Abo-Steuerung Venus-Broker, 2 Abo-Steuerung NAS-Broker, 3 Karte, 4 Meldung, 5 Ereignis (quiet-events)
var now = Date.now(), MIN = 60000;
var G = function (k) { var v; try { v = global.get(k, 'file'); } catch (e) { v = undefined; } return v !== undefined ? v : global.get(k); };
function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } v = Number(v); return isFinite(v) ? v : null; }
var cfg = global.get('OPT_cfg') || {}, c = ZAEHLER.cfgOf(cfg.zaehler);
__COPKW__
var Z = flow.get('zl');
if (!Z) { try { Z = JSON.parse(fs.readFileSync('/data/optimizer/zaehler-state.json', 'utf8')); } catch (e) { Z = null; } Z = ZAEHLER.fix(Z); Z.k = [{}, {}, {}]; Z.n = 0; Z.letzte = 0; }   // Messwerte nie aus der Datei (nur Heizstab-Spruenge, 24-h-Vergleich)
var t = String(msg.topic || ''), out = [null, null, null, null, null];
var HP = G('OPT_hp') || {}, heizer = (HP.Internal_Heater_State && typeof HP.Internal_Heater_State.v === 'number' && now - HP.Internal_Heater_State.ts < 24 * 60 * MIN) ? HP.Internal_Heater_State.v : null;
function abos(cc) {
    var L = ZAEHLER.abos(cc).map(function (x) { return {topic: x, qos: 0}; }), un = {action: 'unsubscribe', topic: true};
    out[0] = [un].concat(L.length && cc.broker === 'venus' ? [{action: 'subscribe', topic: L}] : []);
    out[1] = [{action: 'unsubscribe', topic: true}].concat(L.length && cc.broker === 'nas' ? [{action: 'subscribe', topic: L}] : []);
    Z.abo = {t: now, sig: cc.broker + '|' + ZAEHLER.abos(cc).join(',')};
}
function ereignis(text) { var mo = ENGINE_ISO(now).slice(0, 7), ef = '/data/optimizer/quiet-events-' + mo + '.csv', eh = ''; try { fs.readFileSync(ef, 'utf8'); } catch (e) { eh = 'zeit,ereignis,wechsel\n'; } out[4] = {filename: ef, payload: eh + ENGINE_ISO(now) + ',optimierer_zaehler,' + String(text).replace(/,/g, ';') + '\n'}; }
function ENGINE_ISO(ts) { var d = new Date(ts), p = function (x) { return (x < 10 ? '0' : '') + x; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function karte(st) { return {payload: ZAEHLER.karte(st, ZAEHLER.vergleich(Z, now, COP_KW), c, now, {top16: num(G('TOP16_Heat_Energy_Consumption')), lauf: (num(G('compressor_frequency')) || 0) > 0, korrW: COP_KW})}; }
if (t === 'init') { abos(c); out[2] = karte(ZAEHLER.stand(Z, now, c, heizer)); }
else if (t === 'zaehler_speichern') {
    var r = ZAEHLER.pruefe(msg.payload, cfg.zaehler);
    if (r.fehler.length) { out[3] = {topic: 'Stromzähler', payload: r.fehler.join(' · ') + '. Nichts geändert.', highlight: 'red'}; }
    else {
        var alt = c; cfg.zaehler = r.cfg; global.set('OPT_cfg', cfg); c = ZAEHLER.cfgOf(r.cfg);
        try {
            var cfgFile = '/data/optimizer/config.json', sv = {};
            try { sv = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { sv = {}; }
            if (!sv || typeof sv !== 'object' || Array.isArray(sv)) { sv = {}; }
            sv.zaehler = r.cfg; fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync(cfgFile, JSON.stringify(sv, null, 1));
        } catch (e) { node.warn('Stromzähler: config.json nicht gespeichert: ' + e.message); }
        abos(c);
        out[3] = {topic: 'Stromzähler', payload: 'Gespeichert' + (alt.quelle !== c.quelle ? ' · Strom für COP jetzt ' + (c.quelle === 'zaehler' ? 'vom Zähler' : 'HeishaMon (TOP16 + Korrektur)') : '') + '.', highlight: ''};
        ereignis('Einstellung: ' + (c.topic || 'kein MQTT-Name') + ' · Broker ' + c.broker + ' · Klemmen WP ' + (c.klemme_wp + 1) + ' Heizstab ' + (c.klemme_heizstab === null ? '–' : c.klemme_heizstab + 1) + ' · Quelle ' + c.quelle + (alt.quelle !== c.quelle ? ' (vorher ' + alt.quelle + ')' : ''));
    }
    out[2] = karte(ZAEHLER.stand(Z, now, c, heizer));
}
else if (t === 'tick') {
    var st = ZAEHLER.stand(Z, now, c, heizer), fr = num(G('compressor_frequency'));
    ZAEHLER.minute(Z, {t: now, ok: st.ok, wpW: st.wp_w, rohW: st.wp_roh_w, top16: num(G('TOP16_Heat_Energy_Consumption')), lauf: (fr || 0) > 0, heizstab: heizer, korrW: COP_KW}, c);
    st = ZAEHLER.stand(Z, now, c, heizer); global.set('OPT_zaehler', st);
    if (c.prefix && (!Z.abo || Z.abo.sig !== c.broker + '|' + ZAEHLER.abos(c).join(',') || ((!Z.letzte || now - Z.letzte > 5 * MIN) && now - Z.abo.t >= 10 * MIN))) { abos(c); }   // Abos nach Neustart/Deploy des mqtt-in erneuern
    var weg = c.quelle === 'zaehler' && !st.ok;
    if (weg && !Z.ausfall) { Z.ausfall = now; ereignis('Zähler ausgefallen (' + (st.alter === null ? 'keine Nachricht' : st.alter + ' min alt') + '): Rückfall auf TOP16 + ' + COP_KW + ' W'); }
    else if (!weg && Z.ausfall) { if (c.quelle === 'zaehler') { ereignis('Zähler wieder da nach ' + Math.round((now - Z.ausfall) / MIN) + ' min'); } Z.ausfall = 0; }
    if (!Z.saved || now - Z.saved >= 10 * MIN) { try { var Zs = Object.assign({}, Z, {k: [{}, {}, {}]}); fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync('/data/optimizer/zaehler-state.json', JSON.stringify(Zs)); Z.saved = now; } catch (e) { node.warn('zaehler-state.json: ' + e.message); } }
    out[2] = karte(st);
}
else if (ZAEHLER.lies(Z, t, msg.payload, now, c)) { global.set('OPT_zaehler', ZAEHLER.stand(Z, now, c, heizer)); }
flow.set('zl', Z);
return out;
"""
upsert(comment("opt_c_zl", "Stromzähler Shelly 3EM-63 Gen3: nur lesen (dynamische Abos), Karte auf Daten & Güte · Strom für COP nur mit Schalter (Standard HeishaMon)", 380, 2520))
for _zid, _zb, _zy in (("opt_mqtt_zl_v", BROKER, 2560), ("opt_mqtt_zl_n", "opt_broker_nas", 2620)):
    upsert({"id": _zid, "type": "mqtt in", "z": TAB, "name": "Stromzähler (dynamisch)", "topic": "", "qos": "0", "datatype": "auto-detect", "broker": _zb,
            "nl": False, "rap": True, "rh": 0, "inputs": 1, "x": 760, "y": _zy, "wires": [["opt_zaehler"]]})
upsert({"id": "opt_i_zl_init", "type": "inject", "z": TAB, "name": "Abos beim Start", "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}],
        "repeat": "", "crontab": "", "once": True, "onceDelay": "8", "topic": "init", "payload": "", "payloadType": "date", "x": 140, "y": 2560, "wires": [["opt_zaehler"]]})
upsert({"id": "opt_i_zl", "type": "inject", "z": TAB, "name": "jede Minute", "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}],
        "repeat": "60", "crontab": "", "once": True, "onceDelay": "35", "topic": "tick", "payload": "", "payloadType": "date", "x": 140, "y": 2620, "wires": [["opt_zaehler"]]})
upsert(fn("opt_zaehler", "Stromzähler lesen (nur lesen)", ZAEHLER_CORE_JS + ZAEHLER_WRAP_JS.replace("__COPKW__", COP_KW_JS), 5,
          [["opt_mqtt_zl_v"], ["opt_mqtt_zl_n"], ["opt_t_zaehler", "opt_t_zl_set"], ["opt_ui_toast"], ["opt_f_qev"]], 440, 2590, FS))
upsert(eng_template("opt_t_zaehler", "opt_g_zaehler", "Stromzähler", 6, eng_format("zaehler", "opt_t_zaehler"), 2590, [["opt_zaehler"]]))
# ui-daten 18.10.2026: Einrichtung des Zaehlers als eigene Karte auf der Kern-Seite "Einstellungen" (neben Waermepumpe/Betrieb/Heizen, Breite 8), nicht auf der Statusseite
SET_TAB = "33ece0076bfd7cb7"
upsert({"id": "opt_g_zl_set", "type": "ui_group", "name": "Stromzähler", "tab": SET_TAB, "order": 5, "disp": True, "width": 8, "collapse": False, "className": ""})
upsert(eng_template("opt_t_zl_set", "opt_g_zl_set", "Stromzähler einrichten", 8, eng_format("zlform", "opt_t_zl_set"), 2650, [["opt_zaehler"]]))

# ---------------------------------------------------------------- Anlagenschema (14.10.2026, Branch ui-schema): nur Anzeige, liest OPT_hp, schreibt nichts
# Eine SVG-Karte der Leisha WH-WDG05LE5 (Monoblock R290, Zone 1 Heizkoerper, kein Warmwasser, kein Puffer, interner Heizstab, externer Aussenfuehler) mit
# Live-Werten; Zeichnung und Daten als reine Funktionen in tools/schema_ui.js. Dieselbe Karte zweimal: Seite "Optimierer" oben links (17 breit wie alle Karten
# dort) und Seite "Übersicht" (Kern-Tab a5be8588.b8fbc8) als erste Gruppe. Gruppen-Reihenfolge 0,5: vor allen anderen, ohne deren Reihenfolge anzufassen
# (0 wuerde das Dashboard ans Ende sortieren). Auf der Übersicht stehen drei Kern-Gruppen (12 + 6 + 6 = 24 Einheiten, 1290 px). Eine feste Gruppenbreite
# passt dort nicht: 24 Einheiten scrollen bei 1024 px waagrecht, und bei 1920/2560 bleibt rechts daneben Platz, in den die Masonry die 6 breiten
# Kern-Gruppen zieht. Darum nimmt die Gruppe per CSS (nur ueber ihre node-id) die volle Inhaltsbreite: dann passt nichts daneben, die drei Kern-Gruppen
# stehen darunter wie bisher (links beginnend statt mittig), und bei 1024 scrollt nichts. Das Schema waechst bis 1040 px, daneben die Kennzahlen.
SCHEMA_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema_ui.js"), encoding="utf-8").read()
UE_TAB = "a5be8588.b8fbc8"                       # Kern-Seite "Übersicht" (#!/0)
SCHEMA_CSS = "<style>" + "".join(re.findall(r"'([^']*)'", re.search(r"var CSS = ([\s\S]*?);\n", SCHEMA_JS).group(1))) + "</style>"      # Stil aus schema_ui.js (eine Quelle)
SCHEMA_VOLL_CSS = ('<style>ui-card-panel[node-id="opt_g_schema_ue"]{width:calc(100% - 12px) !important}'
                   'ui-card-panel[node-id="opt_g_schema_ue"] .nr-dashboard-cardpanel,ui-card-panel[node-id="opt_g_schema_ue"] .nr-dashboard-cardcontainer{width:100% !important}'
                   'ui-card-panel[node-id="opt_g_schema_ue"] .nr-dashboard-cardtitle{width:auto !important}'
                   'md-card[node-id="opt_t_schema_ue"]{width:100% !important;box-sizing:border-box !important}</style>')
SCHEMA_FN_JS = r"""
// Anlagenschema: Werte der Waermepumpe fuer die beiden Schema-Karten (Optimierer, Übersicht), alle 10 s. NUR LESEN, schreibt nichts.
var G = function (k) { var v; try { v = global.get(k, 'file'); } catch (e) { v = undefined; } return v !== undefined ? v : global.get(k); };
var cfg = global.get('OPT_cfg') || {};
__COPKW__
var P = OPTSCHEMA.daten(G('OPT_hp') || {}, {freq: G('compressor_frequency'), rt: G('compressor_runtime'), rtLast: G('compressor_last_runtime'), starts: G('Starts_Today')}, COP_KW, Date.now(), (typeof ZQ !== 'undefined') ? ZQ : null);   // ZQ: Stromzaehler (Quelle "zaehler" und frisch)
return {payload: P};
"""


def schema_format(node_id, group_id, voll):
    """Schema-Karte: zeichnet die Nutzlast mit optSchema.mount, passt sich danach sofort ein (FIT_JS dieser Karte); auf der Übersicht (voll) einmal die
    Masonry neu anstossen, damit sie die volle Breite der Gruppe sieht."""
    vollJs = ("if (first) { first = false; try { var p = document.querySelector('ui-card-panel[node-id=\"" + group_id + "\"]'), mas = p && angular.element(p.parentElement).controller('uiMasonry'); "
              "if (mas) { setTimeout(function () { mas.refreshLayout(); }, 80); } } catch (e) { /* Layout bleibt */ } }\n") if voll else ""
    return (SCHEMA_CSS + (SCHEMA_VOLL_CSS if voll else "") + '<div class="optfit"><div id="osch_' + node_id + '"></div></div>'
            "<script>" + SCHEMA_JS + "</script><script>(function (scope) {\n"
            "var last = null, first = true;\n"
            "function draw() { var el = document.getElementById('osch_" + node_id + "'); if (!el || !last || !last.payload || !window.optSchema) { return; } window.optSchema.mount(el, last.payload);\n"
            " var F = window.__optFit; if (F && F.fns && F.fns['" + node_id + "']) { setTimeout(F.fns['" + node_id + "'], 60); }\n" + vollJs + "}\n"
            "scope.$watch('msg', function (m) { if (m) { last = m; setTimeout(draw, 40); } });\n"
            "})(scope);</script>")


# ui-review-b 20.10.2026: das Schema steht auf der Übersicht; die Gruppe der Seite "Optimierer" liegt auf dem ausgeblendeten Tab "Quiet-Messwerte" (Knoten bleiben,
# deploy_opt.sh entfernt nichts), die Seite wird ~700 px kürzer
upsert({"id": "opt_g_schema", "type": "ui_group", "name": "Anlagenschema", "tab": UI_TAB_QUIET, "order": 0.5, "disp": True, "width": ENG_W, "collapse": False, "className": ""})
upsert(eng_template("opt_t_schema", "opt_g_schema", "Anlagenschema (Optimierer)", 13, schema_format("opt_t_schema", "opt_g_schema", False), 2420))
_schema_out = ["opt_t_schema"]
if UE_TAB in B and B[UE_TAB]["type"] == "ui_tab":
    upsert({"id": "opt_g_schema_ue", "type": "ui_group", "name": "ANLAGENSCHEMA", "tab": UE_TAB, "order": 0.5, "disp": True, "width": 24, "collapse": False, "className": ""})
    upsert(eng_template("opt_t_schema_ue", "opt_g_schema_ue", "Anlagenschema (Übersicht)", 12, schema_format("opt_t_schema_ue", "opt_g_schema_ue", True), 2460))
    _schema_out.append("opt_t_schema_ue")
else:
    print("Hinweis: Seite Übersicht (" + UE_TAB + ") fehlt, Anlagenschema nur auf der Seite Optimierer")
# venus-link 19.10.2026: Menüpunkt "Venus (Victron)" im NAS-Dashboard zurück zum Venus-Dashboard. Das NAS-Dashboard ist auch über den Venus
# erreichbar (Venus-Node-RED reicht /nas/ui/ an 10.10.10.128:1880/ui durch, tools/venus_nasui_patch.py; so auch über den VRM-Proxy).
# Ziel je nach Aufruf: unter .../nas/ui/ -> relativ .../ui/ (Venus selbst bzw. derselbe VRM-Proxy), direkt auf der NAS -> https://192.168.5.11:1881/ui/.
VENUS_UI = "https://192.168.5.11:1881/ui/"
upsert({"id": "opt_link_venus", "type": "ui_link", "z": TAB, "name": "Venus (Victron)", "link": "../../ui/", "icon": "fa-bolt", "target": "this",
        "order": 17, "className": "", "x": 1260, "y": 4060})
VENUS_LINK_JS = ("<script>(function () {   // venus-link: Klick auf den Menüpunkt \"Venus (Victron)\" je nach Aufruf richtig umleiten\n"
                 "  if (window.__optVenusLink) { return; } window.__optVenusLink = true;\n"
                 "  function ziel() { var p = location.pathname, i = p.indexOf('/nas/ui'); return i >= 0 ? location.origin + p.slice(0, i) + '/ui/' : '" + VENUS_UI + "'; }\n"
                 "  document.addEventListener('click', function (ev) {\n"
                 "    var it = ev.target && ev.target.closest ? ev.target.closest('md-list-item, md-menu-item, .md-list-item-text, button') : null;\n"
                 "    if (!it || !/^\\s*Venus \\(Victron\\)\\s*$/.test(it.innerText || '')) { return; }\n"
                 "    ev.preventDefault(); ev.stopPropagation(); window.location.href = ziel();\n"
                 "  }, true);\n"
                 "})();</script>")
upsert({"id": "opt_venus_link_js", "type": "ui_template", "z": TAB, "group": "", "name": "Menü: Venus-Link (Kopfbereich)", "order": 0, "width": 0, "height": 0,
        "format": VENUS_LINK_JS, "storeOutMessages": False, "fwdInMessages": False, "resendOnRefresh": False, "templateScope": "global", "className": "",
        "x": 1260, "y": 4100, "wires": [[]]})

upsert(comment("opt_c_schema", "Anlagenschema (nur Anzeige): OPT_hp lesen → Karten auf Optimierer und Übersicht", 380, 2380))
upsert(inject("opt_i_schema", "alle 10 s", 10, 20, ["opt_schema"], 140, 2440))
upsert(fn("opt_schema", "Anlagenschema: Werte lesen (nur Anzeige)", SCHEMA_JS + SCHEMA_FN_JS.replace("__COPKW__", COP_KW_JS), 1, [_schema_out], 440, 2440))

# ---------------------------------------------------------------- Seite "Lernen" (lern-seite 23.10.2026): was der NAS-Container optimizer-tools nachts lernt (nur lesen)
# Der Container laeuft bewusst ohne Netz (network_mode none, read_only) und bekommt kein eigenes Web-Dashboard; diese Seite liest seine Ergebnisdateien in
# /data/optimizer-tools (status.json, training/wp_params_<tag>.json + kandidat_<tag>.json der letzten 14 Tage, kennzahlen/tage.csv, replay/<tag>.json,
# letzter-lauf.log) alle 5 min. Daten und Darstellung: tools/lern_ui.js (reine Funktionen, in tools/optimizer_sim.js geprueft). Vier gleich breite Karten
# (ENG_W, Masonry-Falle), Menuepunkt nach "Daten & Güte" (12,8 < SYSTEM 13). Die Karte "Auswertung NAS" auf Daten & Güte bleibt. Keine Regelwirkung, kein Speicher
# ausser dem Lese-Cache der geparsten Parameterdateien (Knotenkontext, nach Dateizeit und -groesse).
LERN_TAB = "opt_lern_ui_tab"
LERN_UI_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lern_ui.js"), encoding="utf-8").read()
upsert({"id": LERN_TAB, "type": "ui_tab", "name": "Lernen", "icon": "school", "order": 12.8, "disabled": False, "hidden": False})
# [Gruppe, Titel, Vorlage, Art, Starthoehe in Einheiten, y im Editor]
LERN_GROUPS = (("opt_g_lern_heute", "Heute gelernt", "opt_t_lern_heute", "heute", 17, 3800), ("opt_g_lern_param", "Was sich verändert", "opt_t_lern_param", "param", 15, 3840),
               ("opt_g_lern_guete", "Güte je Außenband und Lernkurve", "opt_t_lern_guete", "guete", 9, 3880), ("opt_g_lern_replay", "Replay und Kennzahlen", "opt_t_lern_replay", "replay", 15, 3920))
for _ord, _g in enumerate(LERN_GROUPS, start=1):
    upsert({"id": _g[0], "type": "ui_group", "name": _g[1], "tab": LERN_TAB, "order": _ord, "disp": True, "width": ENG_W, "collapse": False, "className": ""})


def lern_format(kind, node_id):
    """Karte der Seite "Lernen": zeichnet die Nutzlast mit optLern (HTML aus reinen Funktionen) und passt sich danach sofort ein; schickt nichts."""
    return ('<div class="optfit"><div id="ol_' + kind + '"></div></div>'
            + "<script>" + LERN_UI_JS + "</script><script>(function (scope) {\n"
            "var last = null;\n"
            "function draw() { var el = document.getElementById('ol_" + kind + "'); if (el && last && last.payload && window.optLern) { window.optLern.mount(el, '" + kind + "', last.payload);"
            " var F = window.__optFit; if (F && F.fns && F.fns['" + node_id + "']) { setTimeout(F.fns['" + node_id + "'], 60); } } }\n"
            "scope.$watch('msg', function (m) { last = m; setTimeout(draw, 40); });\n"
            "})(scope);</script>")


LERN_FN_JS = LERN_UI_JS + r"""
// Seite "Lernen": Ergebnisdateien des Containers optimizer-tools NUR LESEN (/data/optimizer-tools), je Karte eine Nachricht. Keine Regelwirkung.
var OL = (typeof globalThis !== 'undefined' ? globalThis : this).optLern, cache = context.get('lern_cache') || {};
var P = OL.daten(fs, Date.now(), cache, '/data/optimizer-tools');
context.set('lern_cache', cache);
return [{payload: P.heute}, {payload: P.param}, {payload: P.guete}, {payload: P.replay}];
"""
upsert(comment("opt_c_lern", "Seite Lernen: Ergebnisdateien des Containers optimizer-tools (nur lesen, alle 5 min)", 380, 3760))
for _g in LERN_GROUPS:
    upsert(eng_template(_g[2], _g[0], _g[1], _g[4], lern_format(_g[3], _g[2]), _g[5]))
upsert(fn("opt_lern", "Seite Lernen: Container-Ergebnisse (nur lesen)", LERN_FN_JS, 4, [["opt_t_lern_heute"], ["opt_t_lern_param"], ["opt_t_lern_guete"], ["opt_t_lern_replay"]], 440, 3860, FS))
upsert(inject("opt_i_lern", "alle 5 Minuten", 300, 30, ["opt_lern"], 140, 3860))

# the new page also belongs into the menu configuration (SYSTEM > menu), otherwise it can not be hidden/shown there
form = B.get("e35b7df78bc6f722")
if form and not any(o["value"] == "Optimierung" for o in form["options"]):
    form["options"].append({"label": "OPTIMIERUNG", "value": "Optimierung", "type": "checkbox", "required": False, "rows": None})
    form["formValue"]["Optimierung"] = False

# UI-Optik (14.10.2026): ein gemeinsamer Stil fuer alle Vorlagen der Optimierer-Seiten (tools/ui_optik.css), vor jede Vorlage gesetzt; nur Darstellung
UI_OPTIK_CSS = "<style>" + re.sub(r"/\*[\s\S]*?\*/", "", open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui_optik.css"), encoding="utf-8").read()).replace("\n", "") + "</style>"
for _n in flows:
    if _n["type"] == "ui_template" and _n["id"].startswith("opt_t_") and not _n["format"].startswith(UI_OPTIK_CSS):
        _n["format"] = UI_OPTIK_CSS + _n["format"]

json.dump(flows, open(path, "w", encoding="utf-8"), indent=4, ensure_ascii=False)
print("ok")

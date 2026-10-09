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

path = sys.argv[1] if len(sys.argv) > 1 else "flows (26.5.1 stable).json"
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
    {"id": "ki_oben", "name": "Kinderzimmer oben", "topic": "shellyhtg3-lucas/status/temperature:0",
     "active": True, "min": 22.5, "max": 23.5, "weight": 1, "maxAgeMin": 90},
    {"id": "ki_unten", "name": "Kinderzimmer unten", "topic": "shellyhtg3-lina/status/temperature:0",
     "active": True, "min": 22.5, "max": 23.5, "weight": 1, "maxAgeMin": 90},
    {"id": "schlaf", "name": "Schlafzimmer", "topic": "shellies/shellyht-Schlaf/sensor/temperature",
     "active": True, "min": 19, "max": 21, "weight": 1, "maxAgeMin": 90},
    # new sensor (Shelly H&T Gen1, SHHT-1): measured and logged from the start, but inactive (no say in the room logic) until the user sets its band
    {"id": "wohn", "name": "Wohnzimmer", "topic": "shellies/shelly-ht-wohnzimmer/sensor/temperature",
     "active": False, "min": 20, "max": 22.5, "weight": 1, "maxAgeMin": 90},
]
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


# Phase 4 (shadow only): Quiet recommendation as a coarse power cap. All thresholds are PROVISIONAL and meant to be derived from the
# logged data (quiet-YYYY-MM.csv); nothing is written to the heat pump.
QUIET = {"testAtRange": 2.0, "thrHigh": 3.0, "thrMid": 1.5, "thrLow": 0.5, "hyst": 0.3, "errTauMin": 5, "holdMin": 15, "startLockMin": 15,
         "afterDefrostMin": 10, "afterDhwMin": 10, "deficitMaxLevel": 1, "minRunMin": 20, "maxStartsDay": 24,
         "offAtLow": 1, "offAtHigh": 3, "offAtHyst": 0.5}


# Heat plan (shadow only): every number here is a conservative DEFAULT, not a measured value; measured data moves them only slowly.
PLAN = {"tbalC": 15, "uaKwPerK": 0.22, "uaPriorKh": 300, "learnDays": 21, "learnMinHdd": 30,
        "etaPrior": 0.45, "etaPriorMin": 600, "evapApproachK": 6, "condApproachK": 2,
        "defrostLoss": 0.15, "uncertaintyPremium": 0.05, "shiftPenaltyPct": 2,
        "bufferKwhPerK": 3, "guardK": 0.3, "trendHorizonH": 2, "staleMaxAgeMin": 240, "staleDriftKph": 0.1, "maxShiftKwh": 8, "mMin": 0.4, "mMax": 1.6, "pMaxKw": 5, "recTol": 0.1,
        "quantKwh": 0.05, "minDemandKwh": 4, "quietCapAssumedKw": {"3": 3.3}, "windowH": 3, "anchorTauH": 4, "snapKeepH": 27,
        "confPrior": {"at": {"1": 0.95, "3": 0.9, "6": 0.8, "12": 0.65, "24": 0.5}, "pv": {"1": 0.85, "3": 0.75, "6": 0.6, "12": 0.45, "24": 0.35}},
        "confN0": {"at": 168, "pv": 100}, "confSigma": {"atK": 2.5, "pvRel": 0.6}, "confMin": 0.2, "confMax": 0.98}


def js(code):
    """Fill the shared constants into a JS block."""
    return (code.replace("__ROOMS__", json.dumps(ROOMS, ensure_ascii=False))
                .replace("__LIMITS__", json.dumps(LIMITS))
                .replace("__MINBAND__", str(MIN_BAND_K))
                .replace("__CTL__", json.dumps(CONTROL))
                .replace("__QUIET__", json.dumps(QUIET, ensure_ascii=False))
                .replace("__PLAN__", json.dumps(PLAN, ensure_ascii=False)))


# ---------------------------------------------------------------- defaults / configuration
DEFAULTS_JS = r"""
// Standardwerte der Optimierungsebene. Gespeicherte Einstellungen (config.json) und bereits gesetzte Werte bleiben erhalten.
// Jeder Raum hat ein eigenes Komfortband (min/max), eine Gewichtung und ein Datenalter-Limit.
var ROOM_FIELDS = ['active', 'min', 'max', 'weight', 'maxAgeMin'];
var d = {
    rooms: __ROOMS__,
    control: __CTL__,
    quiet: __QUIET__,
    plan: __PLAN__,
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
var fresh = {plan: JSON.parse(JSON.stringify(d.plan)), energy: JSON.parse(JSON.stringify(d.energy))};
var cfg = merge(merge(d, saved), cur);
['plan', 'energy'].forEach(function (g) { cfg[g] = merge(fresh[g], saved[g]); });
mergeRooms(cfg.rooms, saved.rooms);
mergeRooms(cfg.rooms, cur.rooms);
delete cfg.comfort;                          // fruehere globale Komfortband-Einstellung: ersetzt durch je Raum eigene Baender
global.set('OPT_cfg', cfg);
return null;
"""

SET_CFG_JS = r"""
// Eingaben der Raumkarte -> Konfiguration. msg.topic = "room:<id>:<feld>" (active, min, max, weight, maxAgeMin) oder "gruppe.feld".
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
    if (p[2] === 'active') {
        room.active = (v === true || v === 'true' || v === 1);
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
if (msg.topic === 'current' && p.main) {
    W.temp = p.main.temp; W.rh = p.main.humidity; W.dew = Math.round(dew(p.main.temp, p.main.humidity) * 10) / 10;
    W.clouds = p.clouds ? p.clouds.all : null; W.wind = p.wind ? p.wind.speed : null; W.pressure = p.main.pressure;
    W.desc = (p.weather && p.weather[0]) ? p.weather[0].description : '';
    W.ts = now; W.status = 'OK';
}
if (msg.topic === 'forecast' && Array.isArray(p.list) && p.list.length) {
    // +1/+3/+6 h per linearer Interpolation. Der Startpunkt "jetzt" ist der letzte aktuelle Wert (falls frisch);
    // kommt die Prognose vor der Aktuell-Antwort an, beginnt die Kurve am ersten Prognosepunkt.
    var fresh = (W.temp !== undefined && W.ts && (now - W.ts) < 30 * 60000);
    var pts = (fresh ? [{t: now, v: W.temp, h: W.rh, c: W.clouds, w: typeof W.wind === 'number' ? W.wind : null}] : []).concat(p.list.map(function (e) {
        return {t: e.dt * 1000, v: e.main.temp, h: e.main.humidity, c: e.clouds ? e.clouds.all : null, w: (e.wind && typeof e.wind.speed === 'number') ? e.wind.speed : null};
    }));
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
    W.fpts = pts.filter(function (q) { return q.t > now - 3600000; }).map(function (q) { return [q.t, q.v, q.h, q.c, q.w === undefined ? null : q.w]; });       // 5. Element: Wind in m/s (Prognosepunkt), null wenn unbekannt
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
out[4] = {payload: {rows: fqRows}};
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
// Phase 4 (Shadow): Quiet-Empfehlung als grober Leistungsdeckel. Schreibt NICHTS an die Waermepumpe (kein MQTT-Ausgang in diesem Tab).
// Heizkurve (Temperaturniveau) und Quiet (Leistungsdeckel) bleiben getrennte Groessen; Pumpendrehzahl wird nur beobachtet.
// Ziel: moeglichst lange mit niedriger stabiler Leistung durchlaufen (Ruecklauf langsam am Soll halten), ohne zu takten.
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
var copNow = (running && pel !== null && pel > 100 && pth !== null) ? pth / pel : null;
var qNow = num(G('TOP18_Quiet_Mode_Level'));
var rt = num(G('compressor_runtime')), rtLast = num(G('compressor_last_runtime')), startsToday = num(G('Starts_Today'));
var defrost = num(G('TOP26_Defrosting_State')) === 1, dhw = num(G('TOP20_ThreeWay_Valve_State')) === 1;
var ss = G('F_SS') || {}, ssRamp = ss.state === 1 && Math.abs(num(ss.correction_value) || 0) > 0;
var at = num(G('TOP14_Outside_Temp')), fan1 = num(G('TOP62_Fan1_Motor_Speed'));
var S = G('OPT_state') || {}, sFresh = S.ts && now - S.ts < 5 * MS_MIN;
// Kinderzimmer oben (eigene Regelung im Tab Dashboard, hier nur mitgelesen): Radiator-Relais (Shelly 1 Mini) und Heizluefter (Shelly Plug S, elektrisch)
var KZ = G('OPT_kz') || {}, KZR = KZ.rad || {}, KZF = KZ.fan || {};
var kzRad = typeof KZR.on === 'boolean' ? (KZR.on ? 1 : 0) : '', kzFanOn = typeof KZF.on === 'boolean' ? (KZF.on ? 1 : 0) : '', kzFanW = typeof KZF.w === 'number' ? KZF.w : null;
var kzFanOnline = typeof KZF.online === 'boolean' ? (KZF.online ? 1 : 0) : '';

// ---------- Zustand (ueberlebt Neustarts per Datei)
var qs = flow.get('qs');
if (!qs) {
    qs = {errS: null, errTs: 0, target: null, level: null, levelSince: now, lastStart: 0, lastDefrostEnd: 0, lastDhwEnd: 0, freqOn: false, defrost: false, dhw: false,
          lastMin: 0, lastSave: 0, lastLog: 0, runStart: 0, runs: [], kf: {}, inWin: false, testOpen: null};
    try {
        var sj = JSON.parse(fs.readFileSync('/data/optimizer/quiet-stats.json', 'utf8'));
        if (sj && sj.kfE) { qs.kfE = sj.kfE; }
        if (sj && sj.kf) { qs.kf = sj.kf; qs.level = sj.level; qs.levelSince = sj.since || now; qs.runs = sj.runs || []; }
    } catch (e) { /* noch keine Datei */ }
    try {                                                                                            // Sperren des Waechters ueberstehen einen Neustart
        var wj = JSON.parse(fs.readFileSync('/data/optimizer/watcher-state.json', 'utf8'));
        if (wj) { qs.esc = {blockUntil: wj.blockUntil || 0, lastChg: wj.lastChg || 0, lastChgWhat: wj.lastChgWhat || ''}; qs.lastDefrostEnd = wj.lastDefrostEnd || 0; qs.lastDhwEnd = wj.lastDhwEnd || 0; }
    } catch (e) { /* noch keine Datei */ }
    qs.born = now;
}
var tickDt = qs.tickT ? Math.max(0, Math.min(now - qs.tickT, 3 * MS_MIN)) : 0; qs.tickT = now;               // verstrichene Zeit seit dem letzten Aufruf (mehrere Aufrufe je Minute zaehlen nur die echte Zeit)
if (!qs.kf) { qs.kf = {}; }
if (!qs.kfE) { qs.kfE = {}; }                                                                // Kennfeld bei Efficiency (getrennt, Comfort bleibt unvermischt)                                                                  // Zustand einer frueheren Version (ohne Kennfeld) uebernehmen
if (qs.inWin === undefined) { qs.inWin = false; }
if (qs.testOpen === undefined) { qs.testOpen = null; }
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
if (running && !qs.freqOn) { qs.lastStart = now; qs.runStart = now; if (qNow !== null) { stat(qNow).starts++; } }
if (!running && qs.freqOn && qs.runStart) {
    qs.runs.push([qs.runStart, Math.round((now - qs.runStart) / MS_MIN), qNow]);
    qs.runs = qs.runs.filter(function (r) { return r[0] > now - 24 * 60 * MS_MIN; });
    if (qNow !== null) { stat(qNow).runMin += Math.round((now - qs.runStart) / MS_MIN); }
    qs.runStart = 0;
}
if (defrost && !qs.defrost && qNow !== null) { stat(qNow).defrosts++; }
if (!defrost && qs.defrost) { qs.lastDefrostEnd = now; }
// ---------- Abtauzyklen festhalten (Grundlage fuer die Bewertung Comfort/Efficiency): Beginn, Dauer, Strom, Waerme, Einbruch von Vor-/Ruecklauf, Wiederaufheizzeit
var dfOut = null;
function dfFinish(dfx, rec) {
    var pd = function (x) { return (x < 10 ? '0' : '') + x; }, ds = new Date(dfx.s);
    var iso = ds.getFullYear() + '-' + pd(ds.getMonth() + 1) + '-' + pd(ds.getDate()) + ' ' + pd(ds.getHours()) + ':' + pd(ds.getMinutes()) + ':' + pd(ds.getSeconds());
    var cols = ['zeit', 'dauer_min', 'wiederaufheiz_min', 'aussen', 'feuchte', 'taupunkt', 'quiet', 'heizregelung', 'soll_vl', 'vl_beginn', 'vl_min', 'rl_min', 'strom_kwh', 'waerme_kwh', 'min_seit_letzter_abtauung', 'heizstab_min'];
    var line = [iso, Math.round(((dfx.end || now) - dfx.s) / MS_MIN), rec, c(dfx.at), c(dfx.rh), c(dfx.dew), c(dfx.q), c(dfx.hc), c(dfx.sol), c(dfx.vl0), c(dfx.vlMin), c(dfx.rlMin), c(Math.round(dfx.el * 1000) / 1000), c(Math.round(dfx.th * 1000) / 1000), c(dfx.sinceLast), c(Math.round((dfx.hsMs || 0) / MS_MIN))].join(',');
    var f0 = '/data/optimizer/defrost-' + iso.slice(0, 7) + '.csv', hd = cols.join(','), need = true;
    try { var lh = null; String(fs.readFileSync(f0, 'utf8')).split('\n').forEach(function (l) { if (l.indexOf('zeit,') === 0) { lh = l; } }); need = lh !== hd; } catch (e) { need = true; }
    return {filename: f0, payload: (need ? hd + '\n' : '') + line + '\n'};
}
if (defrost && !qs.defrost) {                                                                  // neuer Abtauzyklus (ein noch laufender Erholungs-Eintrag wird vorher abgeschlossen)
    if (qs.df && qs.df.state === 'recover') { dfOut = dfFinish(qs.df, 'unterbrochen'); }
    var W0 = G('OPT_weather') || {}, w0ok = W0.ts && now - W0.ts < 60 * MS_MIN;
    qs.df = {s: now, state: 'defrost', at: at, rh: w0ok ? W0.rh : null, dew: w0ok ? W0.dew : null, q: qNow, hc: hpv('Heating_Control'), sol: solVL, vl0: istVL, vlMin: istVL, rlMin: istRL, el: 0, th: 0,
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
    } else { qs.df.state = 'recover'; qs.df.end = now; }
}
if (qs.df && qs.df.state === 'recover' && !(defrost && !qs.defrost)) {
    var dfRec = Math.round((now - qs.df.end) / MS_MIN);
    if (istVL !== null && qs.df.sol !== null && istVL >= qs.df.sol - 1) { dfOut = dfFinish(qs.df, dfRec); qs.df = null; }                  // Vorlauf wieder bis 1 K unter Soll
    else if (now - qs.df.end >= 60 * MS_MIN) { dfOut = dfFinish(qs.df, '>60'); qs.df = null; }
    else if (!running) { dfOut = dfFinish(qs.df, 'Verdichter aus'); qs.df = null; }                                                       // Anforderung erfuellt, Verdichter steht
}
if (!dhw && qs.dhw) { qs.lastDhwEnd = now; }
qs.freqOn = running; qs.defrost = defrost; qs.dhw = dhw;
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
var cycleBad = (rtLast !== null && rtLast < qn(Q.minRunMin, 20)) || (startsToday !== null && startsToday > qn(Q.maxStartsDay, 24));      // kurze Laeufe oder viele Starts

// ---------- Empfehlung (Ziel-Stufe) aus dem Ruecklauffehler; Schwellen sind vorlaeufig und werden aus den Daten abgeleitet
var T = [qn(Q.thrHigh, 3), qn(Q.thrMid, 1.5), qn(Q.thrLow, 0.5)], H = qn(Q.hyst, 0.3);
function lvl(e) { return e >= T[0] ? 0 : (e >= T[1] ? 1 : (e >= T[2] ? 2 : 3)); }
var target = null, why = [];
var targetNormal = null;
if (!running) { why.push('Verdichter steht'); }
else if (qs.errS === null) { why.push('Rücklauf oder Soll fehlt'); }
else {
    var raw = lvl(qs.errS);
    target = raw;
    if (qs.target !== null && raw > qs.target) { target = Math.max(qs.target, lvl(qs.errS + H)); }          // weniger Leistung nur mit Abstand (Hysterese)
    why.push('RL ' + (qs.errS >= 0 ? f(qs.errS, 1, 'K') + ' unter' : f(-qs.errS, 1, 'K') + ' über') + ' Soll-RL');
    var cap = qn(Q.deficitMaxLevel, 1);
    if (sFresh && S.deficit && (S.coldTrend === null || S.coldTrend <= 0.05)) {                           // Raumkomfort hat Vorrang vor Leistungsbegrenzung
        why.push((S.deficitRoom || 'Raum') + ' unter Komfortminimum' + (S.distrib ? ' (Wärmeverteilungsproblem, Quiet kann es nicht lösen)' : ''));
        if (target > cap) { target = cap; why.push('Deckel höchstens Stufe ' + cap); }
    } else if (sFresh) { why.push('Räume im Komfortband'); }
    if (cycleBad && qNow !== null && target < qNow && !(sFresh && S.deficit)) { target = qNow; why.push('Taktungsschutz: kurze Läufe/viele Starts, nicht mehr Leistung freigeben'); }
    why.push('Verdichter seit ' + Math.round(rt || 0) + ' min aktiv');
    qs.target = target;
}
targetNormal = target;                                                           // Empfehlung ohne Prioritaetsregel (zum Vergleichen mitgeloggt)
// Erfahrungswert des Betreibers: bei 1-3 Grad Aussentemperatur muss Quiet aus sein; geht dem Taktungsschutz und dem Leistungsdeckel vor
var wLo = qn(Q.offAtLow, 1), wHi = qn(Q.offAtHigh, 3), wH = qn(Q.offAtHyst, 0.5);
var atWin = at !== null && (qs.inWin ? (at >= wLo - wH && at <= wHi + wH) : (at >= wLo && at <= wHi));
qs.inWin = atWin;
if (atWin) { target = 0; why.unshift('Außentemperatur ' + f(at, 1, '°C') + ' im Bereich ' + f(wLo, 0) + '–' + f(wHi, 0) + ' °C: Quiet muss aus sein (Erfahrung des Betreibers)'); }
if (!running) { qs.target = null; }
// naechster Schritt: hoechstens eine Stufe, nach Mindesthaltezeit, nicht bei Sperren
var locks = [];
if (defrost) { locks.push('Abtauen'); } else if (now - qs.lastDefrostEnd < qn(Q.afterDefrostMin, 10) * MS_MIN) { locks.push('nach dem Abtauen'); }
if (dhw) { locks.push('Warmwasser'); } else if (now - qs.lastDhwEnd < qn(Q.afterDhwMin, 10) * MS_MIN) { locks.push('nach Warmwasser'); }
if (running && now - qs.lastStart < qn(Q.startLockMin, 15) * MS_MIN) { locks.push('Verdichterstart'); }
if (ssRamp) { locks.push('Sanftanlauf'); }
var holdLeft = Math.max(0, qs.levelSince + qn(Q.holdMin, 15) * MS_MIN - now);
var next = (targetNormal !== null && qNow !== null && targetNormal !== qNow) ? qNow + (targetNormal > qNow ? 1 : -1) : null;                     // normal: eine Stufe
var nextP = (target !== null && qNow !== null && target !== qNow) ? (atWin ? target : qNow + (target > qNow ? 1 : -1)) : null;              // Prioritaetsregel im Fenster: direkt auf Ziel
if (!locks.length && !defrost && !dhw) { why.push(defrost ? '' : 'kein Abtauen / kein Warmwasser'); }
function stepTxt(tg, nx, direct) { return tg === null ? '–' : (nx === null ? 'keiner (Stufe passt)' : qNow + ' → ' + nx + (direct ? ' direkt' : '') + (locks.length ? ' (wartet: ' + locks[0] + ')' : ((holdLeft > 0 && !direct) ? ' (frühestens in ' + Math.ceil(holdLeft / MS_MIN) + ' min)' : ' (möglich)'))); }
var nextTxt = stepTxt(targetNormal, next, false), nextTxtP = stepTxt(target, nextP, atWin);
var lockTxt = locks.length ? locks.join(' + ') : (holdLeft > 0 ? 'Haltezeit noch ' + Math.ceil(holdLeft / MS_MIN) + ' min' : 'keine');
// Kontrolltest Quiet 3 -> 2: NUR ein Hinweis, wann die Bedingungen erfuellt sind. Es wird nie automatisch geschaltet; den Test macht der Betreiber von Hand.
var tr = [];
if (qNow !== 3) { tr.push('Stufe ist nicht 3'); }
if (!running) { tr.push('Verdichter steht'); } else if (now - qs.lastStart < qn(Q.startLockMin, 15) * MS_MIN) { tr.push('Startphase'); }
if (dhw || now - qs.lastDhwEnd < qn(Q.afterDhwMin, 10) * MS_MIN) { tr.push('Warmwasser'); }
if (defrost || now - qs.lastDefrostEnd < qn(Q.afterDefrostMin, 10) * MS_MIN) { tr.push('Abtauen'); }
if (!sFresh) { tr.push('Komfortdaten fehlen'); } else if (S.deficit) { tr.push('Komfortdefizit'); }
var bins3 = (flow.get('atBins') || []).filter(function (b) { return b[0] > now - 3 * 60 * MS_MIN; }).map(function (b) { return b[1] / b[2]; });
if (atWin || bins3.some(function (v) { return v >= wLo - wH && v <= wHi + wH; })) { tr.push('Außentemperatur im ' + f(wLo, 0) + '–' + f(wHi, 0) + '-°C-Fenster'); }
if (bins3.length < 24) { tr.push('zu wenig Außentemperatur-Historie (3 h)'); }
else if (Math.max.apply(null, bins3) - Math.min.apply(null, bins3) > qn(Q.testAtRange, 2)) { tr.push('Außentemperatur nicht stabil'); }
var testOk = tr.length === 0;

// ---------- Quellen der Quiet-Stufe (damit nichts unbemerkt gegen einen Regler arbeitet)
var mq = G('MQTT') || {}, sol = G('F_SOLAR') || {};
var srcs = ['HeishaMoNR-Quiet-Logik ' + ((ss.state === 1 && ss.QM_state === 1) ? 'AN (Stufe ' + ss.QM_active_level + ')' : 'aus'),
            'Scheduler ' + (mq.allow_scheduler === 1 ? 'darf senden' : 'aus'), 'Solar ' + (sol.state === 1 ? 'AN' : 'aus'),
            'WP-Zeitplan ' + (HP.Quiet_Mode_Schedule && HP.Quiet_Mode_Schedule.v === 1 ? 'AN' : 'aus')];
var prio = HP.Quiet_Mode_Priority ? HP.Quiet_Mode_Priority.v : null;
var lastCmd = HP._lastCmd;

// ---------- Heizregelung (Comfort / Efficiency): reine Warn-Empfehlung, schaltet NICHTS. Bei Efficiency wird fortlaufend geprueft, ob die Bedingungen noch passen
// (Erfahrung von Betreibern: Efficiency regelt bei Frost, haeufigem Abtauen und hoher Last zu zurueckhaltend und bleibt knapp unter dem Sollvorlauf haengen).
var hcReco = {text: hcMode === 0 ? 'Comfort' : '–', cls: '', mode: hcMode, warn: false, why: []};
if (hcMode === 1) {
    var hcWhy = [], Wh = G('OPT_weather') || {}, hcF6 = (Wh.ts && now - Wh.ts < 2 * 3600000) ? num(Wh.f6) : null;
    if (at !== null && at < 5) { hcWhy.push('Außentemperatur ' + f(at, 1, '°C')); }
    else if (hcF6 !== null && hcF6 < 3) { hcWhy.push('Prognose in 6 h ' + f(hcF6, 1, '°C')); }
    if (qs.lastDefrostStart && now - qs.lastDefrostStart < 6 * 3600000) { hcWhy.push('Abtauen vor ' + dur(now - qs.lastDefrostStart)); }
    var hcDev = (running && !defrost && solVL !== null && istVL !== null) ? solVL - istVL : null;
    if (hcDev !== null && hcDev > 2) { if (!qs.vlBadSince) { qs.vlBadSince = now; } } else if (hcDev === null || hcDev <= 1) { qs.vlBadSince = 0; }
    if (qs.vlBadSince && now - qs.vlBadSince >= 20 * MS_MIN) { hcWhy.push('Vorlauf seit ' + dur(now - qs.vlBadSince) + ' mehr als 2 K unter Soll'); }
    if (sFresh && S.deficit) { hcWhy.push('Raum unter Minimum: ' + (S.deficitRoom || '?')); }
    hcReco = {text: hcWhy.length ? 'Efficiency · Comfort empfohlen: ' + hcWhy.join(' · ') : 'Efficiency · keine Warnung', cls: hcWhy.length ? 'warn' : 'ok', mode: 1, warn: hcWhy.length > 0, why: hcWhy};
} else { qs.vlBadSince = 0; }
global.set('OPT_hc_reco', {ts: now, mode: hcMode, warn: hcReco.warn, text: hcReco.text});
var hcEvent = null;                                                                                   // Wechsel der Empfehlung als Ereignis festhalten
var hcKey = hcMode === 1 ? (hcReco.warn ? 'warn' : 'ok') : 'aus';
if (qs.hcKey !== undefined && qs.hcKey !== hcKey && hcMode === 1) { hcEvent = hcKey === 'warn' ? 'ok->Comfort empfohlen (' + hcReco.why.join(' + ').replace(/(\d),(\d)/g, '$1.$2').replace(/,/g, ';') + ')' : 'Comfort empfohlen->keine Warnung'; }
qs.hcKey = hcKey;

// ---------- Eskalationswaechter (SCHATTEN, schaltet nichts): wann muesste Efficiency verlassen bzw. Quiet freigegeben werden?
// Ausloeser: Sollvorlauf nach X min nicht erreicht · Vorlauf nach Erreichen laenger ueber 2 K unter Soll · Raum laenger unter Minimum · Heizstab-Schwelle naht.
// Sperren gegen Takt (aus den Logs): nur im Betrieb, nicht kurz nach Start/Abtauen/Warmwasser/Sanftanlauf, nur wenn der Vorlauf hoechstens 1 K ueber Soll liegt (der Weg zu Comfort hebt ihn um ca. 0,5-1 K,
// die Anlage schaltet bei mehr als +3 K ueber Soll ab), Mindestabstand zum letzten Wechsel. Geht der Verdichter nach einem Wechsel mit Ueberschwingen aus, wird das festgehalten und das automatische Schalten gesperrt.
// Zeitmessung ueber Startzeitpunkte (nicht ueber Aufrufe), Sperren und Wechselzeit werden in watcher-state.json gesichert (Neustart-fest), Eingaenge muessen frisch sein.
var escEvents = [], escTxt = '–', escCls = '', escKey = '', escWhyTxt = '', escGateTxt = '', escRunMin = null, escDev = null;
var ES = qs.esc = qs.esc || {};
var ESD = {runKey: 0, prevRt: null, obsStart: 0, late: false, reached: null, reachSince: 0, reachSinceMin: 0, dropSince: 0, defiSince: 0, htrSince: 0, trigSince: 0, nearStop: false,
           lastChg: 0, lastChgWhat: '', hcPrev: null, qPrev: null, blockUntil: 0, devHist: [], keyCand: 'ruhig', keySince: 0, keyShown: 'ruhig', runHc: null, runQ: null, saved: ''};
Object.keys(ESD).forEach(function (k) { if (ES[k] === undefined) { ES[k] = ESD[k]; } });
var escX = qn(Q.escReachMin, 120), escBand = qn(Q.escReachBandK, 1), escDropK = qn(Q.escDropK, 2), escDropMin = qn(Q.escDropMin, 30), escRoomMin = qn(Q.escRoomMin, 60),
    escGap = qn(Q.escMinGapMin, 60), escLock = qn(Q.escStartLockMin, 15), escMaxDev = qn(Q.escMaxDevK, 1), escWait = qn(Q.escWaitMin, 10), escTakt = qn(Q.escTaktMin, 30), escBlockH = qn(Q.escBlockH, 24),
    escOver = qn(Q.escOvershootK, 2.5), escDebounce = 3;
var escHour = new Date(now).getHours(), escNight = escHour >= 22 || escHour < 7;
var capHz = {3: 28, 2: 35, 1: 45};                                                                   // Annahme aus der Betreiberangabe (Quiet-Deckel in Hz), nicht gemessen
var escDataOk = freqRaw !== null && hpFresh;                                                         // Verdichterwert vorhanden und HeishaMon meldet noch
var pd2 = function (x) { return (x < 10 ? '0' : '') + x; };
var hd = function (ts) { var d0 = new Date(ts), n0 = new Date(now); return (d0.getDate() === n0.getDate() && d0.getMonth() === n0.getMonth() ? '' : pd2(d0.getDate()) + '.' + pd2(d0.getMonth() + 1) + '. ') + hhmm(ts); };
var chgTxt = function (a0, b0) { if (a0 === null || a0 === undefined) { return b0 === null ? '?' : String(b0); } return (b0 === null || a0 === b0) ? String(a0) : a0 + '→' + b0; };
var mins = function (since) { return since ? Math.floor((now - since) / MS_MIN) : 0; };
function escReset() { ES.dropSince = 0; ES.defiSince = 0; ES.htrSince = 0; ES.trigSince = 0; ES.reachSince = 0; }
function escRunEnd() {                                                                              // Lauf ist zu Ende (Stillstand beobachtet oder Laufzeit-Sprung): Zusammenfassung und Takt-Pruefung
    var obs = Math.round((now - ES.obsStart) / MS_MIN);
    escEvents.push(['lauf_ende', (ES.late ? 'beobachtet ' + obs + ' min (Beginn unbekannt)' : 'Lauf ' + Math.round(ES.prevRt || obs) + ' min') + ' · Sollvorlauf ' + (ES.reached !== null ? (ES.late ? 'erreicht (Zeit unbekannt)' : 'erreicht nach ' + ES.reached + ' min') : 'nicht erreicht')
                    + ' · Heizregelung ' + chgTxt(ES.runHc, hcMode) + ' · Quiet ' + chgTxt(ES.runQ, qNow)]);
    var ovs = -99; ES.devHist.forEach(function (e) { if (now - e[0] <= 6 * MS_MIN && e[1] > ovs) { ovs = e[1]; } });
    if (ES.lastChg && ES.lastChg >= ES.runKey && now - ES.lastChg <= escTakt * MS_MIN) {            // Wechsel von Heizregelung oder Quiet im Lauf und der Verdichter geht bald danach aus
        var ago = Math.round((now - ES.lastChg) / MS_MIN);
        if (ovs >= escOver) {
            ES.blockUntil = now + escBlockH * 3600000;
            escEvents.push(['takt_nach_wechsel', 'Verdichter ' + ago + ' min nach ' + (ES.lastChgWhat || 'einem Wechsel') + ' mit Überschwingen +' + ovs.toFixed(1) + ' K aus · automatisches Schalten gesperrt bis ' + hd(ES.blockUntil)]);
        } else { escEvents.push(['stopp_nach_wechsel', 'Verdichter ' + ago + ' min nach ' + (ES.lastChgWhat || 'einem Wechsel') + ' aus · kein Überschwingen (höchstens ' + (ovs > -99 ? (ovs >= 0 ? '+' : '') + ovs.toFixed(1) + ' K' : '–') + ' über Soll) · keine Sperre']); }
    }
}
if (escDataOk) {                                                                                     // Wechsel von Heizregelung oder Quiet (von wem auch immer) merken
    if (ES.hcPrev !== null && hcMode !== null && ES.hcPrev !== hcMode) { ES.lastChg = now; ES.lastChgWhat = 'Heizregelung ' + ES.hcPrev + '→' + hcMode; }
    if (ES.qPrev !== null && qNow !== null && ES.qPrev !== qNow) { ES.lastChg = now; ES.lastChgWhat = 'Quiet ' + ES.qPrev + '→' + qNow; }
    if (hcMode !== null) { ES.hcPrev = hcMode; } if (qNow !== null) { ES.qPrev = qNow; }
}
if (!escDataOk) {
    escReset(); escKey = 'daten_fehlen'; escCls = 'warn';
    escTxt = 'Daten fehlen oder sind veraltet (' + (freqRaw === null ? 'Verdichterwert fehlt' : 'HeishaMon meldet nicht') + ') · Wächter pausiert';
} else if (!running) {
    if (ES.runKey !== 0) { escRunEnd(); }
    qs.sawStop = true;
    ES.runKey = 0; ES.prevRt = null; ES.reached = null; ES.late = false; ES.nearStop = false; ES.devHist = []; ES.keyCand = 'ruhig'; ES.keyShown = 'ruhig'; escReset();
    escKey = 'ruhig'; escTxt = 'Verdichter steht · Wächter prüft im Betrieb';
} else {
    var rtNow = rt;
    if (!ES.late && ES.runKey !== 0 && rtNow !== null && ES.prevRt !== null && rtNow < ES.prevRt - 1.5) { escRunEnd(); ES.runKey = 0; }                      // Stopp und Neustart zwischen zwei Aufrufen
    if (ES.runKey === 0) {
        ES.runKey = now; ES.obsStart = now; ES.late = !qs.sawStop;                                   // spaet: Lauf war beim ersten Hinsehen schon im Gang (Neustart/Deploy), Beginn unbekannt
        ES.reached = null; ES.nearStop = false; ES.devHist = []; ES.runHc = hcMode; ES.runQ = qNow; escReset();
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
    if (ES.reached !== null && escDev !== null && escDev <= -escDropK) { ES.dropSince = ES.dropSince || now; } else if (escDev === null || escDev > -1) { ES.dropSince = 0; }
    if (sFresh && S.deficit) { ES.defiSince = ES.defiSince || now; } else { ES.defiSince = 0; }
    var htrOn = hpv('Heater_On_Outdoor_Temp'), htrSt = hpv('Heater_Start_Delta'), htrDl = hpv('Heater_Delay_Time');
    var htrThr = htrSt === null ? null : Math.max(1, Math.abs(htrSt) - 1);                          // Defizit 1 K vor der Heizstab-Schwelle (Vorzeichen des Parameters egal)
    var htrNear = (at !== null && htrOn !== null && htrThr !== null && at < htrOn + 2 && escDev !== null && escDev <= -htrThr && !defrost);
    if (htrNear) { ES.htrSince = ES.htrSince || now; } else if (!(escDev !== null && htrThr !== null && escDev <= -(htrThr - 0.5))) { ES.htrSince = 0; }
    if (escDev !== null) { if (escDev > escMaxDev) { ES.nearStop = true; } else if (escDev < escMaxDev - 0.5) { ES.nearStop = false; } }
    var escWhy = [];
    if (ES.reached === null && escDev !== null && escRunMin >= escX && !defrost) { escWhy.push('Sollvorlauf nach ' + Math.round(escRunMin) + ' min nicht erreicht (Grenze ' + escX + ' min)'); }
    if (ES.dropSince && mins(ES.dropSince) >= escDropMin) { escWhy.push('Vorlauf seit ' + mins(ES.dropSince) + ' min mehr als ' + f(escDropK, 0) + ' K unter Soll'); }
    if (ES.defiSince && mins(ES.defiSince) >= escRoomMin) { escWhy.push('Raum seit ' + mins(ES.defiSince) + ' min unter Minimum (' + (S.deficitRoom || '?') + ')'); }
    if (htrOn !== null && ES.htrSince && mins(ES.htrSince) >= Math.max(5, (htrDl === null ? 15 : htrDl) - 5)) { escWhy.push('Heizstab-Schwelle naht (Vorlauf ' + f(-escDev, 1) + ' K unter Soll seit ' + mins(ES.htrSince) + ' min, Heizstab ab ' + f(-Math.abs(htrSt), 0) + ' K nach ' + (htrDl === null ? 15 : htrDl) + ' min)'); }
    var escGate = [];
    if (escRunMin < escLock) { escGate.push('Startphase (' + Math.round(escRunMin) + ' von ' + escLock + ' min' + (ES.late ? ', Beginn unbekannt' : '') + ')'); }
    if (escDef) { escGate.push('Abtauen'); }
    if (escDhw) { escGate.push('Warmwasser'); }
    if (ssRamp) { escGate.push('Sanftanlauf'); }
    if (escDev === null) { escGate.push('Vorlauf unbekannt'); } else if (ES.nearStop) { escGate.push('Vorlauf ' + sg(escDev, 1) + ' K über Soll: Takt-Gefahr'); }
    if (ES.lastChg && now - ES.lastChg < escGap * MS_MIN) { escGate.push('Mindestabstand ' + escGap + ' min zum letzten Wechsel (noch ' + Math.ceil((escGap * MS_MIN - (now - ES.lastChg)) / MS_MIN) + ' min)'); }
    if (ES.blockUntil > now) { escGate.push('nach Takt durch Wechsel gesperrt bis ' + hd(ES.blockUntil)); }
    var escAct = null, escKeyNow = 'ruhig', whyTxt = escWhy.join(' · ');
    if (escWhy.length) {
        if (!ES.trigSince) { ES.trigSince = now; }
        if (hcMode === null || (hcMode === 0 && qNow === null)) { escKeyNow = 'modus_unbekannt'; escCls = 'warn'; escTxt = 'Auslöser: ' + whyTxt + ' · ' + (hcMode === null ? 'Heizregelung' : 'Quiet-Stufe') + ' unbekannt, keine Aktion möglich'; }
        else if (hcMode === 1) { escAct = 'Heizregelung Efficiency → Comfort'; }
        else if (qNow === 0) { escKeyNow = 'ausgeschoepft'; escCls = 'warn'; escTxt = 'Auslöser: ' + whyTxt + ' · Comfort und Quiet 0: keine weitere Stufe frei, die Leistung der Anlage reicht nicht'; }
        else if (capHz[qNow] !== undefined && freq >= capHz[qNow] - 3) { escAct = 'Quiet ' + qNow + ' → ' + (qNow - 1); }
        else { escKeyNow = 'ohne_wirkung'; escCls = ''; escTxt = 'Comfort aktiv, Auslöser: ' + whyTxt + ' · Quiet-Freigabe brächte nichts (Verdichter bei ' + f(freq, 0, 'Hz') + ', nicht am Deckel)'; }
    } else { ES.trigSince = 0; }
    if (escAct !== null) {
        escCls = 'warn';
        if (escGate.length) { escKeyNow = 'gesperrt'; escTxt = 'Auslöser: ' + whyTxt + ' → würde schalten: ' + escAct + ' · gesperrt: ' + escGate.join(' · '); }
        else if (mins(ES.trigSince) < escWait) { escKeyNow = 'wartet'; escTxt = 'Auslöser: ' + whyTxt + ' → ' + escAct + ' nach ' + escWait + ' min Wartezeit (seit ' + mins(ES.trigSince) + ' min)'; }
        else { escKeyNow = 'schalten'; escTxt = 'Auslöser: ' + whyTxt + ' → würde jetzt schalten: ' + escAct + (escNight ? ' (Nacht: automatisch)' : ' (Tag: Vorschlag zur Bestätigung)'); }
    } else if (!escWhy.length) {
        escCls = 'ok';
        escTxt = (hcMode === 1 ? 'Efficiency' : (hcMode === 0 ? 'Comfort' : 'Modus unbekannt')) + ' · kein Auslöser · ' + (ES.reached !== null ? (ES.late ? 'Sollvorlauf erreicht (Zeit unbekannt)' : 'Sollvorlauf erreicht nach ' + ES.reached + ' min') : 'läuft ' + Math.round(escRunMin) + ' min, Sollvorlauf noch nicht erreicht (Grenze ' + escX + ' min)');
    }
    escKey = escKeyNow; escWhyTxt = escWhy.join(' + '); escGateTxt = escGate.join(' + ');
    if (ES.keyCand !== escKeyNow) { ES.keyCand = escKeyNow; ES.keySince = now; }                     // Zustandswechsel erst als Ereignis, wenn er mindestens 3 min stabil ist (kein Flattern)
    if (ES.keyShown !== ES.keyCand && now - ES.keySince >= escDebounce * MS_MIN) {
        escEvents.push(['eskalation_schatten', ES.keyCand + ': ' + (escWhy.length ? escWhyTxt : 'kein Auslöser') + (escAct ? ' → ' + escAct : '') + (ES.keyCand === 'gesperrt' ? ' [' + escGate.join(' + ') + ']' : '')]);
        ES.keyShown = ES.keyCand;
    }
}
var escSave = JSON.stringify({blockUntil: ES.blockUntil, lastChg: ES.lastChg, lastChgWhat: ES.lastChgWhat, lastDefrostEnd: qs.lastDefrostEnd, lastDhwEnd: qs.lastDhwEnd});
if (escSave !== ES.saved) { try { fs.mkdirSync('/data/optimizer', {recursive: true}); fs.writeFileSync('/data/optimizer/watcher-state.json', escSave); ES.saved = escSave; } catch (e) { /* kein Zugriff */ } }

var rows = [
    ['Soll-VL (Heizkurve)', f(solVL, 1, '°C'), ''],
    ['Ist-VL', f(istVL, 1, '°C'), ''],
    ['Soll-RL (Soll-VL − Ziel-Spreizung ' + f(zDelta, 0) + ' K)', f(solRL, 1, '°C'), ''],
    ['Ist-RL', f(istRL, 1, '°C'), ''],
    ['Rücklauffehler (Soll-RL − Ist-RL)', rlErr !== null ? sg(rlErr, 1, 'K') + (rlErr >= 0 ? ' (RL unter Soll)' : ' (RL über Soll)') : '–', ''],
    ['Spreizung Ist / Ziel', f(spread, 1) + ' / ' + f(zDelta, 1, 'K'), ''],
    ['Verdichter', running ? f(freq, 0, 'Hz') + ' · seit ' + Math.round(rt || 0) + ' min' : 'steht (letzter Lauf ' + f(rtLast, 0, 'min') + ')', ''],
    ['Leistung elektrisch', f(pel, 0, 'W'), ''],
    ['Leistung thermisch', pth !== null ? f(pth, 0, 'W') + (pthHs !== null ? ' (HeishaMon)' : ' (berechnet)') : '–', ''],
    ['COP', copNow !== null ? f(copNow, 1) : '–', ''],
    ['Flow · Pumpe (nur Beobachtung)', f(flw, 1, 'l/min') + ' · ' + (HP.Pump_Duty ? f(HP.Pump_Duty.v, 0) : '–') + ' / ' + (HP.Pump_Speed ? f(HP.Pump_Speed.v, 0, 'U/min') : '–'), ''],
    ['Kinderzimmer oben', 'Radiator ' + (kzRad === '' ? '–' : (kzRad ? 'an' : 'aus')) + ' · Heizlüfter ' + (kzFanOnline === 0 ? 'offline' : (kzFanOn === '' ? '–' : (kzFanOn ? 'an' + (kzFanW !== null ? ' (' + f(kzFanW, 0, 'W') + ')' : '') : 'aus'))), ''],
    ['Taktung', 'heute ' + f(startsToday, 0) + ' Starts · Ø Lauf 24 h ' + (meanRun !== null ? f(meanRun, 0, 'min') : '–') + ' (' + runs24.length + ')', cycleBad ? 'warn' : ''],
    ['Quiet aktuell', qNow !== null ? 'Stufe ' + qNow + ' seit ' + dur(now - qs.levelSince) + (prio !== null ? ' · Priorität ' + (prio === 1 ? 'Leistung' : 'Lautstärke') : '') : '–', ''],
    ['Quiet normal (Shadow)', targetNormal !== null ? 'Stufe ' + targetNormal : '–', ''],
    ['Quiet nach Prioritätsregeln (Shadow)', target !== null ? 'Stufe ' + target : '–', target !== null && qNow !== null && target !== qNow ? 'warn' : ''],
    ['Nächster Schritt normal', nextTxt, ''],
    ['Nächster Schritt Priorität', nextTxtP, ''],
    ['Grund', why.filter(Boolean).join(' · '), ''],
    ['Sperrgrund', lockTxt, ''],
    ['Heizregelung', hcReco.text, hcReco.cls],
    ['Eskalationswächter (Schatten, schaltet nichts)', escTxt, escCls],
    ['Kontrolltest Quiet 3 → 2 (nur von Hand)', testOk ? 'Bedingungen erfüllt, jetzt möglich' : 'nicht möglich: ' + tr.join(' · '), testOk ? 'ok' : ''],
    ['Quellen der Stufe', srcs.join(' · ') + (lastCmd ? ' · letzter Befehl ' + hhmm(lastCmd.ts) : ' · kein Befehl beobachtet'), '']
];
var tab = [];
var statRow = function (label, bn, s) {
    var m = function (k, d) { var a = s.s[k]; return a && a[1] ? f(a[0] / a[1], d) : '–'; };
    var mxv = function (k) { return s.mx && ok(s.mx[k]) ? f(s.mx[k], 0) : '–'; };
    return [label, bn, f(s.n, 0), m('hz', 0), m('fan', 0), m('pel', 0), m('pth', 0), mxv('hz'), mxv('pth'), m('cop', 1), m('vl', 1) + ' / ' + m('rl', 1) + ' / ' + m('dt', 1),
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
var EVSHOW = {sollvorlauf_erreicht: ['Sollvorlauf erreicht', 'ok'], lauf_ende: ['Lauf zu Ende', ''], eskalation_schatten: ['Wächter (Schatten)', 'warn'], takt_nach_wechsel: ['Takt nach Wechsel', 'warn'], stopp_nach_wechsel: ['Stopp nach Wechsel', ''],
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
var out = [{payload: {rows: rows, events: evList}}, {payload: {stats: tab}}, null, null, dfOut];
if (qs.testOpen !== null && qs.testOpen !== testOk) {                                  // Testfenster geoeffnet/geschlossen: Ereignis fuer den Betreiber
    var evd = new Date(now), evp = function (x) { return (x < 10 ? '0' : '') + x; };
    var evIso = evd.getFullYear() + '-' + evp(evd.getMonth() + 1) + '-' + evp(evd.getDate()) + ' ' + evp(evd.getHours()) + ':' + evp(evd.getMinutes()) + ':' + evp(evd.getSeconds());
    var evFile = '/data/optimizer/quiet-events-' + evIso.slice(0, 7) + '.csv', evHead = '';
    try { fs.readFileSync(evFile, 'utf8'); } catch (e) { evHead = 'zeit,ereignis,wechsel\n'; }
    out[3] = {filename: evFile, payload: evHead + evIso + ',testfenster_quiet_3_2,' + (testOk ? 'geoeffnet' : 'geschlossen (' + tr.join(' + ').replace(/,/g, ';') + ')') + '\n'};
}
qs.testOpen = testOk;
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
                'zustand', 'shift_anlage', 'kz_radiator_an', 'kz_heizluefter_an', 'kz_heizluefter_w', 'kz_heizluefter_online'];
    var hv = function (n) { return HP[n] && typeof HP[n].v === 'number' ? HP[n].v : null; };
    var vals2 = [iso, qNow, targetNormal, target, next, nextP, why.filter(Boolean).join(' | ').replace(/,/g, ';'), locks.join(' + ').replace(/,/g, ';'), Math.ceil(holdLeft / MS_MIN), c(solVL), c(istVL), c(solRL), c(istRL), c(rlErr), c(qs.errS),
                 c(spread), c(zDelta), c(freq), c(pel), c(pthHs), c(pthCalc), c(copNow), c(flw), c(hv('Pump_Duty')), c(hv('Pump_Speed')), c(hv('Max_Pump_Duty')), c(fan1), c(hv('Fan2_Motor_Speed')),
                 c(hv('Compressor_Current')), c(at), c(rt), c(rtLast), c(startsToday), c(meanRun), defrost ? 1 : 0, dhw ? 1 : 0, ssRamp ? 1 : 0,
                 sFresh ? (S.deficit ? 1 : 0) : '', sFresh ? String(S.deficitRoom || '').replace(/,/g, ';') : '', sFresh ? c(S.coldTrend) : '', sFresh ? (S.distrib ? 1 : 0) : '', prio === null ? '' : prio, cycleBad ? 1 : 0, atWin ? 1 : 0, testOk ? 1 : 0, c(hv('Heating_Control')), c(hv('Pump_Flowrate_Mode')),
                 c(hv('Internal_Heater_State')), c(hv('External_Heater_State')), c(hv('Room_Heater_State')), c(hv('Room_Heater_Operations_Hours')), c(hv('Heater_Start_Delta')), c(hv('Heater_Delay_Time')),
                 escKey, escWhyTxt.replace(/,/g, ';'), escGateTxt.replace(/,/g, ';'), (ES.reached !== null && !ES.late) ? c(ES.reached) : '', escRunMin !== null ? c(Math.round(escRunMin)) : '', c(escDev),
                 zustandNow, c(shiftHpNow), kzRad, kzFanOn, c(kzFanW), kzFanOnline];
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

PLAN_JS = r"""// Waermefahrplan (Shadow): 15-Minuten-Plan fuer die naechsten 24 h. Verteilt die ohnehin noetige Heizwaerme auf die guenstigsten Slots,
// nur innerhalb der thermischen Reserve des Gebaeudes. Schreibt NICHTS an die Waermepumpe (kein MQTT-Ausgang), wirkt auf nichts.
// Es werden nur Informationen benutzt, die zum Planungszeitpunkt vorlagen; jeder Plan wird als Schnappschuss festgehalten und spaeter nie veraendert.
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var PC = cfg.plan || {}, QC = cfg.quiet || {};
var PLAN_VER = 10;                                                                                // bei jeder Aenderung der Plan-Felder erhoehen: aeltere Plaene im Speicher werden dann sofort neu gerechnet
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

// ---------- Optimierung der Waermeverteilung (exakt, dynamische Programmierung ueber die kumulierte Abweichung vom Normalverlauf)
// b[i]: normaler Bedarf je Slot, c[i]: Kosten je Waermeeinheit, lam: Strafe je verschobener Einheit, rd/ru: erlaubte Abweichung (Einheiten) nach unten/oben,
// Summe der Abweichungen am Ende = 0 (die Tagessumme bleibt erhalten). Ergebnis: p[i] (Einheiten je Slot).
function planDP(b, c, lam, rd, ru, mMin, mMax, cap) {
    var n = b.length, w = rd + ru + 1, off = rd, INF = 1e18, cost = [], i, s, p;
    for (s = 0; s < w; s++) { cost.push(INF); }
    cost[off] = 0;
    var chP = [], chS = [];
    for (i = 0; i < n; i++) {
        var lo = Math.ceil(mMin * b[i] - 1e-9), hi = Math.floor(mMax * b[i] + 1e-9);
        if (ok(cap)) { hi = Math.min(hi, cap); }
        lo = Math.min(lo, b[i]); hi = Math.max(hi, b[i]);                                           // der Normalverlauf ist immer erlaubt
        var nx = [], cp = [], cs = [];
        for (s = 0; s < w; s++) { nx.push(INF); cp.push(0); cs.push(0); }
        for (s = 0; s < w; s++) {
            if (cost[s] >= INF) { continue; }
            for (p = lo; p <= hi; p++) {
                var ns = s + (p - b[i]);
                if (ns < 0 || ns >= w) { continue; }
                var v = cost[s] + c[i] * p + lam * Math.abs(p - b[i]);
                if (v < nx[ns] - 1e-12) { nx[ns] = v; cp[ns] = p; cs[ns] = s; }
            }
        }
        cost = nx; chP.push(cp); chS.push(cs);
    }
    var out = new Array(n), st = off;
    for (i = n - 1; i >= 0; i--) { out[i] = chP[i][st]; st = chS[i][st]; }
    return out;
}

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
    return {d0: a[0], kh: g(1), q: g(2), n: g(3), s: g(4), wk: g(5), khW: g(6), wkW: g(7), dtr: g(8)};
}
function daysFromRows(rows, tbal) {                                                                  // Tagesaggregate aus plan-actuals-Zeilen (Ortszeit-Datum des Stempels, ein Slot = 15 min)
    var days = {}, order = [];
    rows.forEach(function (r) {
        var st = r.slot_start; if (!st || st.length < 16) { return; }
        var key = st.slice(0, 10), d = days[key];
        if (!d) { d = days[key] = {d0: d0Of(key), n: 0, kh: 0, q: 0, s: 0, wk: 0, khW: 0, wkW: 0, sN: 0, wN: 0, owN: 0, wwN: 0, r0: {}, rl: {}}; order.push(key); }
        d.n += 15;
        var at = nz(r.ist_aussen), q = nz(r.ist_waerme_kwh), pv = nz(r.ist_pv_w), wd = nz(r.ist_wind_ms), ow = nz(r.ist_aussen_owm);
        if (at !== null) { d.kh += Math.max(0, tbal - at) * 0.25; }
        if (q !== null) { d.q += q; }
        if (pv !== null) { d.s += pv * 0.25 / 1000; d.sN += 15; }
        if (ow !== null) { d.khW += Math.max(0, tbal - ow) * 0.25; d.owN += 15; }
        if (wd !== null && at !== null) { d.wk += Math.max(0, tbal - at) * wd * 0.25; d.wN += 15; }
        if (wd !== null && ow !== null) { d.wkW += Math.max(0, tbal - ow) * wd * 0.25; d.wwN += 15; }
        Object.keys(r).forEach(function (k) { if (k.indexOf('ist_raum_') === 0) { var v = nz(r[k]); if (v !== null) { if (d.r0[k] === undefined) { d.r0[k] = v; } d.rl[k] = v; } } });
    });
    return order.map(function (k) {
        var d = days[k], part = function (v, cnt) { return cnt >= 0.9 * d.n ? v : null; }, dl = [];
        Object.keys(d.r0).forEach(function (rk) { dl.push(d.rl[rk] - d.r0[rk]); });
        return {d0: d.d0, kh: d.kh, q: d.q, n: d.n, s: part(d.s, d.sN), wk: part(d.wk, d.wN), khW: part(d.khW, d.owN), wkW: part(d.wkW, d.wwN), dtr: dl.length ? dl.reduce(function (x, y) { return x + y; }, 0) / dl.length : null};
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
function prepRows(days, o) {                                                                         // Datenzeilen {y, x1, x2, x3} fuer die Regression; Tage ohne noetige Werte entfallen
    var rows = [], vb = null, sw = 0, sk = 0;
    days.forEach(function (d) {
        var x1 = o.tref === 'khW' ? d.khW : d.kh, w = o.tref === 'khW' ? d.wkW : d.wk;
        if (isN(w) && isN(x1) && x1 > 0) { sw += w; sk += x1; }
    });
    if (sk > 0) { vb = sw / sk; }
    var nW = 0;
    days.forEach(function (d) {
        var x1 = o.tref === 'khW' ? d.khW : d.kh, w = o.tref === 'khW' ? d.wkW : d.wk;
        if (!isN(x1) || !isN(d.q) || (o.useS && !isN(d.s)) || ((o.C || 0) > 0 && !isN(d.dtr))) { return; }
        var y = d.q - (o.C || 0) * (isN(d.dtr) ? d.dtr : 0);
        var x2 = 0; if (o.useW) { if (isN(w)) { x2 = w; nW++; } else if (vb !== null) { x2 = x1 * vb; } }          // Tage ohne Wind: mittlere Windstaerke der Windtage annehmen
        rows.push({y: y, x1: x1, x2: x2, x3: o.useS ? d.s : 0, d0: d.d0});
    });
    return {rows: rows, nW: nW};
}
function ridgeCore(rows, o) {                                                                        // y = UA*x1 + bw*x2 - bs*x3, Ridge mit Prior (ua0, 0, 0), Grenzen: UA in [lo, hi], bw/bs >= 0; exakt ueber alle Faelle (aktive Grenzen)
    var n = rows.length, ua0 = o.ua0, sig = [o.sUA, o.sW, o.sS], b0 = [ua0, 0, 0];
    if (!n) { return {ua: ua0, bw: 0, bs: 0, J: 0, n: 0}; }
    var ym = rows.reduce(function (a, r) { return a + r.y; }, 0) / n, sr = Math.max(1.0, 0.10 * ym), r2 = sr * sr;
    var en = [true, !!o.useW, !!o.useS], lo = [0.5 * ua0, 0, 0], hi = [2 * ua0, 0, 0];
    var best = null, stU, stW, stS;
    var feat = function (r) { return [r.x1, r.x2, -r.x3]; };
    var F = rows.map(feat);
    for (stU = 0; stU < 3; stU++) { for (stW = 0; stW < 2; stW++) { for (stS = 0; stS < 2; stS++) {
        if ((!en[1] && stW === 0) || (!en[2] && stS === 0)) { continue; }                           // abgeschaltete Merkmale bleiben bei 0
        var st = [stU, stW, stS], fixedV = [0, 0, 0], free = [], p, ok = true;
        fixedV[0] = stU === 1 ? lo[0] : (stU === 2 ? hi[0] : 0);
        for (p = 0; p < 3; p++) { if (p === 0 ? stU === 0 : (p === 1 ? (stW === 0 && en[1]) : (stS === 0 && en[2]))) { free.push(p); } }
        var beta = [fixedV[0], 0, 0];
        if (free.length) {
            var m = free.length, A = [], bb = [], a, c;
            for (a = 0; a < m; a++) { A.push(new Array(m).fill(0)); bb.push(0); }
            rows.forEach(function (r, i) {
                var f = F[i], resid = r.y; for (var q = 0; q < 3; q++) { if (free.indexOf(q) < 0) { resid -= f[q] * beta[q]; } }
                for (a = 0; a < m; a++) { for (c = 0; c < m; c++) { A[a][c] += f[free[a]] * f[free[c]] / r2; } bb[a] += f[free[a]] * resid / r2; }
            });
            for (a = 0; a < m; a++) { A[a][a] += 1 / (sig[free[a]] * sig[free[a]]); bb[a] += b0[free[a]] / (sig[free[a]] * sig[free[a]]); }
            var sol = gauss(A, bb); if (!sol) { continue; }
            for (a = 0; a < m; a++) { beta[free[a]] = sol[a]; }
            if (free.indexOf(0) >= 0 && (beta[0] < lo[0] - 1e-12 || beta[0] > hi[0] + 1e-12)) { ok = false; }
            if (free.indexOf(1) >= 0 && beta[1] < -1e-12) { ok = false; }
            if (free.indexOf(2) >= 0 && beta[2] < -1e-12) { ok = false; }
        }
        if (!ok) { continue; }
        var J = 0; rows.forEach(function (r, i) { var f = F[i], e = r.y - (f[0] * beta[0] + f[1] * beta[1] + f[2] * beta[2]); J += e * e / r2; });
        for (p = 0; p < 3; p++) { if (en[p]) { J += (beta[p] - b0[p]) * (beta[p] - b0[p]) / (sig[p] * sig[p]); } }
        if (best === null || J < best.J) { best = {ua: beta[0], bw: beta[1], bs: beta[2], J: J, n: n}; }
    } } }
    if (best === null) { return {ua: ua0, bw: 0, bs: 0, J: 0, n: n}; }
    return best;
}
function predict(fit, r) { return fit.ua * r.x1 + fit.bw * r.x2 - fit.bs * r.x3; }
function ridgeFit(rows, o) {                                                                         // robust: Tage mit Rest > 3 sigma (sigma = max(1 kWh, 10 % vom Mittel)) werden einmalig herausgenommen, dann neu gerechnet
    var f = ridgeCore(rows, o);
    if (o.robust === false || rows.length < 5) { return f; }
    var ym = rows.reduce(function (a2, r) { return a2 + r.y; }, 0) / rows.length, sr = Math.max(1.0, 0.10 * ym);
    var keep = rows.filter(function (r) { return Math.abs(r.y - predict(f, r)) <= 3 * sr; });
    if (keep.length === rows.length || keep.length < 4) { return f; }
    var g = ridgeCore(keep, o); g.removed = rows.length - keep.length; return g;
}
function looMae(rows, o) {                                                                           // Leave-one-day-out: mittlerer absoluter Tagesfehler [kWh]
    if (rows.length < 3) { return null; }
    var s = 0;
    rows.forEach(function (r, i) { var rest = rows.filter(function (x, j) { return j !== i; }); s += Math.abs(r.y - predict(ridgeFit(rest, o), r)); });
    return s / rows.length;
}
function ratioUa(rows, ua0, h0) { var sq = 0, sk = 0; rows.forEach(function (r) { sq += r.y; sk += r.x1; }); return (ua0 * h0 + sq) / (h0 + sk); }       // bisheriger Plan-Schaetzer (Prior ua0 mit h0 K*h)
function looRatio(rows, ua0, h0) {
    if (rows.length < 3) { return null; }
    var s = 0; rows.forEach(function (r, i) { var rest = rows.filter(function (x, j) { return j !== i; }); s += Math.abs(r.y - ratioUa(rest, ua0, h0) * r.x1); });
    return s / rows.length;
}
function gateCheck(n, rows, maeBase, maeCand, fit, o) {                                              // Aktivierungsbedingungen (F4.3); in S2 nur Anzeige
    var why = [];
    if (n < o.minDays) { why.push('weniger als ' + o.minDays + ' Tage'); }
    var sv = rows.map(function (r) { return r.x3; }), sm = sv.length ? sv.reduce(function (a, b) { return a + b; }, 0) / sv.length : 0;
    var lowN = sv.filter(function (v) { return v < 0.8 * sm; }).length, highN = sv.filter(function (v) { return v > 1.2 * sm; }).length;
    if (lowN < 2 || highN < 2) { why.push('PV-Tage zu gleichfoermig'); }
    if (!(maeBase > 0 && maeCand !== null && maeCand <= 0.9 * maeBase)) { why.push('Fehler nicht um 10 % besser'); }
    if (fit.bs > 0.5 || fit.bw > 0.05) { why.push('Koeffizient unplausibel'); }
    return {ok: why.length === 0, why: why};
}
function fitModel(daysIn, P) {                                                                       // alle Varianten rechnen (nur Anzeige in S2): Basis (Plan-Schaetzer), nur UA, + Sonne, + Wind, OWM-Temperatur, Speicherterm
    var o0 = {ua0: P.ua0, sUA: P.sUA, sW: P.sW, sS: P.sS, useS: false, useW: false, tref: 'kh', C: 0};
    var mk = function (patch) { var o = {}; Object.keys(o0).forEach(function (k) { o[k] = o0[k]; }); Object.keys(patch).forEach(function (k) { o[k] = patch[k]; }); return o; };
    var base = prepRows(daysIn, mk({}));
    var out = {n: base.rows.length, ts: 0, maeBase: looRatio(base.rows, P.ua0, P.h0), maeUA: null, maeSun: null, maeWind: null, maeOwm: null, store: {}, ua: ratioUa(base.rows, P.ua0, P.h0), uaRidge: null, bs: 0, bw: 0, nW: 0, bestC: 0};
    if (base.rows.length < 1) { return out; }
    var f1 = ridgeFit(base.rows, mk({})); out.uaRidge = f1.ua; out.maeUA = looMae(base.rows, mk({}));
    var oS = mk({useS: true}), pS = prepRows(daysIn, oS), fS = ridgeFit(pS.rows, oS);
    out.maeSun = looMae(pS.rows, oS); out.bs = fS.bs; out.uaSun = fS.ua; out.nSun = pS.rows.length;
    var oW = mk({useS: true, useW: true}), pW = prepRows(daysIn, oW);
    out.nW = pW.nW;
    if (pW.nW >= P.minWindDays) { var fW = ridgeFit(pW.rows, oW); out.bw = fW.bw; out.bsW = fW.bs; out.uaWind = fW.ua; out.maeWind = looMae(pW.rows, oW); }
    var oO = mk({tref: 'khW'}), pO = prepRows(daysIn, oO); if (pO.rows.length >= 3) { out.maeOwm = looMae(pO.rows, oO); out.nOwm = pO.rows.length; }
    var bestC = 0, bestM = null;
    P.storeC.forEach(function (C) { var oC = mk({useS: true, C: C}), pC = prepRows(daysIn, oC), m = pC.rows.length >= 3 ? looMae(pC.rows, oC) : null; out.store[C] = m; if (m !== null && (bestM === null || m < bestM)) { bestM = m; bestC = C; } });
    out.bestC = bestC;
    var cand = out.maeWind !== null ? out.maeWind : out.maeSun;
    var gp = out.maeWind !== null ? {ua: out.uaWind, bw: out.bw, bs: out.bsW || 0} : {ua: out.uaSun, bw: 0, bs: out.bs};
    out.gate = gateCheck(out.n, pS.rows, out.maeBase, cand, gp, {minDays: P.minDays});
    return out;
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

// ---------- Eingaenge: Waermepumpe (nur lesen)
var HP = G('OPT_hp') || {};
function hpv(name) { var e = HP[name]; return (e && typeof e.v === 'number' && now - e.ts < 10 * MS_MIN) ? e.v : null; }
var freq = num(G('compressor_frequency')) || 0, running = freq > 0;
var pel = num(G('TOP16_Heat_Energy_Consumption')), flw = num(G('TOP1_Pump_Flow'));
var istVL = num(G('TOP6_Main_Outlet_Temp')), istRL = num(G('TOP5_Main_Inlet_Temp'));
var spread = (istVL !== null && istRL !== null) ? istVL - istRL : null;
var pthHs = hpv('Heat_Power_Production_Extra'); if (!running || pthHs === null || pthHs < -100) { pthHs = null; }
var pthCalc = (running && flw !== null && spread !== null) ? flw * spread * 69.7 : null;
var pth = pthHs !== null ? pthHs : pthCalc;
var defrost = num(G('TOP26_Defrosting_State')) === 1, dhw = num(G('TOP20_ThreeWay_Valve_State')) === 1;
var atNow = num(G('TOP14_Outside_Temp')), qLevel = num(G('TOP18_Quiet_Mode_Level'));
var PI = G('OPT_plan_in') || {}, piFresh = PI.ts && now - PI.ts < 5 * MS_MIN;
var Rr = G('OPT_rooms') || {}, Sx = G('OPT_state') || {}, sxFresh = Sx.ts && now - Sx.ts < 5 * MS_MIN;
var ROOMS = cfg.rooms || [];

// ---------- Ist-Werte je 15-Minuten-Slot (Grundlage fuer den spaeteren Vergleich) und je Tag (Lernen des Waermebedarfs)
var s0 = Math.floor(now / Q15) * Q15, dtH = pl.lastTs ? Math.min(now - pl.lastTs, 3 * MS_MIN) / H : 0;
pl.lastTs = now;
function newAcc(t) { return {windS: 0, windN: 0, clS: 0, clN: 0, owS: 0, owN: 0, toS: 0, toN: 0, tcS: 0, tcN: 0, s: t, n: 0, atS: 0, atN: 0, pvS: 0, pvN: 0, thH: 0, elH: 0, thA: 0, elA: 0, dhwMin: 0, runMin: 0, defrosts: 0, hzS: 0, hzN: 0, defMin: 0, defEl: 0, defTh: 0, spS: 0, spN: 0, vdS: 0, vdN: 0, puS: 0, puN: 0, hc: null}; }
function fillAcc(a) { ['windS', 'windN', 'clS', 'clN', 'owS', 'owN', 'toS', 'toN', 'tcS', 'tcN'].forEach(function (k) { if (a[k] === undefined) { a[k] = 0; } }); return a; }       // Zustand aus einem aelteren Stand (Deploy ohne Neustart) um neue Zaehler ergaenzen
function fillDay(d) { ['s', 'sN', 'wk', 'wN', 'khW', 'owN', 'wkW', 'wwN'].forEach(function (k) { if (d[k] === undefined) { d[k] = 0; } }); if (!d.r0) { d.r0 = {}; } if (!d.rl) { d.rl = {}; } return d; }
function priceAt(slots, t) { if (!Array.isArray(slots)) { return null; } for (var i = 0; i < slots.length; i++) { if (slots[i][0] <= t && slots[i][1] > t) { return slots[i][2]; } } return null; }
var roomIds = ROOMS.map(function (r) { return r.id; });
var ACT_COLS = ['ist_aussen', 'ist_pv_w', 'ist_preis', 'ist_cop', 'ist_waerme_kwh', 'ist_strom_kwh', 'ist_abtauungen', 'ist_ww_min', 'ist_verdichter_min', 'ist_hz', 'ist_quiet_stufe', 'ist_soc', 'ist_waerme_gesamt_kwh', 'ist_strom_heizen_kwh', 'ist_abtau_min', 'ist_abtau_strom_kwh', 'ist_abtau_waerme_kwh', 'ist_spreizung', 'ist_vl_abweichung', 'ist_pumpe_u_min', 'ist_heizregelung']
    .concat(roomIds.map(function (id) { return 'ist_raum_' + id; }))
    .concat(['ist_wind_ms', 'ist_bewoelkung_pct', 'ist_aussen_owm', 'ist_aussen_regel', 'ist_t_custom']);       // Fahrplan v2: Wind, Bewoelkung, OWM-Temperatur, Regelwert T_outside, eigener Fuehler (nur anhaengen)
var EV_COLS2 = ['prog_wind_ms', 'prog_bewoelkung_pct', 'prog_aussen_korr', 'prog_sonne_kwh', 'prog_bedarf_basis_kwh', 'prog_bedarf_kand_kwh'];                                          // Vergleichsspalten hinter den Ist-Werten (nur anhaengen)
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

if (pl.acc && pl.acc.s !== s0) {                                                               // Slot abgeschlossen: Ist-Werte festhalten und mit den frueheren Plaenen vergleichen
    var a = pl.acc;
    if (a.n >= 8) {
        var actual = {at: a.atN ? a.atS / a.atN : null, pv: a.pvN ? a.pvS / a.pvN : null, price: priceAt(PI.price, a.s), cop: a.elH > 0.005 ? a.thH / a.elH : null,
                      th: a.thH, el: a.elA, defr: a.defrosts, dhw: a.dhwMin, run: a.runMin, hz: a.hzN ? a.hzS / a.hzN : null, q: a.q === undefined ? null : a.q, soc: a.soc === undefined ? null : a.soc, rooms: a.rooms || {}, wind: a.windN ? a.windS / a.windN : null, cl: a.clN ? a.clS / a.clN : null, owm: a.owN ? a.owS / a.owN : null, to: a.toN ? a.toS / a.toN : null, tc: a.tcN ? a.tcS / a.tcN : null,
                      thA: a.thA, elH: a.elH, defMin: a.defMin, defEl: a.defEl, defTh: a.defTh, spread: a.spN ? a.spS / a.spN : null, vlDev: a.vdN ? a.vdS / a.vdN : null, pump: a.puN ? a.puS / a.puN : null, hc: a.hc};
        var aVals = [actual.at, actual.pv, actual.price, actual.cop, actual.th, actual.el, actual.defr, actual.dhw, actual.run, actual.hz, actual.q, actual.soc, actual.thA, actual.elH, actual.defMin, actual.defEl, actual.defTh, actual.spread, actual.vlDev, actual.pump, actual.hc].map(function (v, i) { return c(v, i === 0 || i === 9 ? 2 : 3); })
            .concat(roomIds.map(function (id) { return c(actual.rooms[id], 2); }))
            .concat([c(actual.wind, 2), c(actual.cl, 0), c(actual.owm, 2), c(actual.to, 2), c(actual.tc, 2)]);
        var mo = monthOf(a.s);
        if (actual.pv !== null) { pl.pvHist = (pl.pvHist || []).concat([actual.pv * Q15 / H / 1000]).slice(-8); }                // PV-Energie der letzten 8 Slots (2 h): Startwert der Sonnenglaettung
        if (pl.bias && actual.at !== null && actual.owm !== null && actual.wind !== null) {       // Lernzeile der Fuehlerkorrektur (gleiche Merkmale wie bei der Rueckrechnung); vor der Rueckrechnung noch nicht angelegt
            pl.bias.rows.push({day: stamp(a.s).slice(0, 10), d: actual.at - actual.owm, f: biasFeat(new Date(a.s).getHours(), actual.wind, actual.pv, actual.cl)});
            if (pl.bias.rows.length > 2100) { pl.bias.rows.shift(); }
        }
        out[1] = csvOut('/data/optimizer/plan-actuals-' + mo + '.csv', 'slot_start,' + ACT_COLS.join(','), [stamp(a.s) + ',' + aVals.join(',')]);
        // Vergleich: was wurde damals (vor ca. 0/1/3/6/12/24 h) prognostiziert und empfohlen, was ist tatsaechlich passiert
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
            if ((L === 6 || L === 24) && isN(g('bedarf_basis')) && isN(g('bedarf_kand')) && isN(actual.th)) {   // Tagesbilanz des Waermebedarf-Modells: Plan-Modell gegen Kandidat (Sonne/Wind) bei 6 und 24 h Vorlauf
                var abD = dayStart(a.s); pl.ab = pl.ab || {d0: abD};
                if (pl.ab.d0 !== abD) { pl.learn.ab = (pl.learn.ab || []).concat([pl.ab]).slice(-21); pl.lastSave = 0; pl.ab = {d0: abD}; }
                var ab = pl.ab, kk = 'L' + L; ab[kk] = ab[kk] || {n: 0, q: 0, b: 0, k: 0};
                ab[kk].n++; ab[kk].q += actual.th; ab[kk].b += g('bedarf_basis'); ab[kk].k += g('bedarf_kand');
            }
            var recT = {1: 'VORZIEHEN', 0: 'NORMAL', '-1': 'VERSCHIEBEN'}[g('rec')];
            evLines.push([stamp(a.s), L, c((a.s - sn.t) / H, 2), stamp(sn.t), c(g('at'), 2), c(g('rh'), 0), c(g('cop'), 2), c(g('price'), 4), c(g('pv'), 0), c(g('bedarf'), 3), c(g('plan'), 3), c(g('kosten'), 2), c(g('defrost'), 2), c(g('taupunkt'), 1), c(g('kosten_basis'), 2), c(g('strafe_defrost'), 2), c(g('strafe_unsicher'), 2), c(g('reserve_hinten'), 3), c(g('reserve_vorn'), 3),
                          c(g('conf_at'), 2), c(g('conf_pv'), 2), c(g('att'), 0), recT, c(g('offset'), 1), String(g('quiet')).replace(/,/g, ';')].concat(aVals).concat([c(g('wind'), 1), c(g('wolken'), 0), c(g('at_korr'), 2), c(g('sonne_kwh'), 3), c(g('bedarf_basis'), 3), c(g('bedarf_kand'), 3)]).join(','));
        });
        if (evLines.length) { out[2] = csvOut('/data/optimizer/plan-eval-' + mo + '.csv', 'slot_start,' + EV_COLS.join(',') + ',' + ACT_COLS.join(',') + ',' + EV_COLS2.join(','), evLines); }
    }
    pl.acc = null;
}
if (!pl.acc) { pl.acc = newAcc(s0); }
var acc = fillAcc(pl.acc);
acc.n++;
if (atNow !== null) { acc.atS += atNow; acc.atN++; }
if (piFresh && ok(PI.pvNow)) { acc.pvS += PI.pvNow; acc.pvN++; }
var Wx = G('OPT_weather') || {}, wFresh = !!(Wx.ts && now - Wx.ts <= (num(cfg.weather && cfg.weather.maxAgeMin) || 60) * MS_MIN);       // Wetterwerte nur, solange sie frisch sind
var windNow = (wFresh && ok(Wx.wind)) ? Wx.wind : null, clNow = (wFresh && ok(Wx.clouds)) ? Wx.clouds : null, owNow = (wFresh && ok(Wx.temp)) ? Wx.temp : null;
var toNow = num(G('T_outside')), tcNow = num(G('T_outside_custom'));                              // Regelwert der Waermepumpe und eigener Fuehler (falls gesetzt)
if (windNow !== null) { acc.windS += windNow; acc.windN++; }
if (clNow !== null) { acc.clS += clNow; acc.clN++; }
if (owNow !== null) { acc.owS += owNow; acc.owN++; }
if (toNow !== null) { acc.toS += toNow; acc.toN++; }
if (tcNow !== null) { acc.tcS += tcNow; acc.tcN++; }
if (running) { acc.runMin++; acc.hzS += freq; acc.hzN++; }
var thW = (running && pth !== null) ? pth : 0, elW = (running && pel !== null) ? pel : 0;
if (defrost) { var thRawA = hpv('Heat_Power_Production_Extra'); thW = (thRawA !== null && thRawA > -30000 && thRawA < 30000) ? thRawA : 0; }       // Abtauen: echter Waermeentzug (negativ), nicht aus Restwaerme gerechnet
acc.thA += thW * dtH / 1000; acc.elA += elW * dtH / 1000;
if (running && !dhw && !defrost) { acc.thH += thW * dtH / 1000; acc.elH += elW * dtH / 1000; }
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
    if (pl.day.n >= 1200) {                                                                    // Eintrag: [d0, hdd, q, n] wie bisher, dahinter (nur anhaengen) s, wk, khW, wkW, dtr, sN, wN, owN, wwN; Zaehler unter 90 % der Minuten -> null
        var dd = fillDay(pl.day), part = function (v, cnt, dg) { return cnt >= 0.9 * dd.n ? Math.round(v * dg) / dg : null; }, dtrL = [];
        Object.keys(dd.r0).forEach(function (id) { if (ok(dd.rl[id])) { dtrL.push(dd.rl[id] - dd.r0[id]); } });
        var dtrM = dtrL.length ? Math.round(dtrL.reduce(function (x, y) { return x + y; }, 0) / dtrL.length * 1000) / 1000 : null;
        var entry = [dd.d0, Math.round(dd.hdd * 100) / 100, Math.round(dd.q * 1000) / 1000, dd.n, part(dd.s, dd.sN, 1000), part(dd.wk, dd.wN, 100), part(dd.khW, dd.owN, 100), part(dd.wkW, dd.wwN, 100), dtrM, dd.sN, dd.wN, dd.owN, dd.wwN];
        pl.learn.days.push(entry);
        var dayMsg = csvOut('/data/optimizer/plan-days-' + monthOf(dd.d0 + 6 * H) + '.csv', 'tag,kh_fuehler,kh_owm,waerme_kwh,minuten,pv_kwh,wk_fuehler,wk_owm,dtr_k,min_pv,min_wind,min_owm',
                            [stamp(dd.d0).slice(0, 10) + ',' + [entry[1], entry[6], entry[2], entry[3], entry[4], entry[5], entry[7], entry[8], entry[9], entry[10], entry[11]].map(function (v) { return c(v, 3); }).join(',')]);
        out[1] = out[1] ? [out[1], dayMsg] : dayMsg;                                               // Tagesblatt fuer die Auswertung (eine Zeile je abgeschlossenem Tag)
    }
    while (pl.learn.days.length > pn('learnDays', 21)) { pl.learn.days.shift(); }
    pl.day = null; pl.lastSave = 0;
}
if (!pl.day) { pl.day = {d0: d0, hdd: 0, q: 0, n: 0}; }
fillDay(pl.day);
pl.day.n++;
if (atNow !== null) { pl.day.hdd += Math.max(0, pn('tbalC', 15) - atNow) / 60; }
if (running && !dhw && !defrost && pth !== null) { pl.day.q += pth * dtH / 1000; }
if (piFresh && ok(PI.pvNow)) { pl.day.s += PI.pvNow * dtH / 1000; pl.day.sN++; }                  // PV-Energie des Tages [kWh] (Sonnenmass, solange die Daten frisch sind)
if (owNow !== null && atNow !== null) { pl.day.khW += Math.max(0, pn('tbalC', 15) - owNow) / 60; pl.day.owN++; }                      // Heizgradstunden aus der OWM-Temperatur (regional)
if (windNow !== null && atNow !== null) { pl.day.wk += Math.max(0, pn('tbalC', 15) - atNow) * windNow / 60; pl.day.wN++; }          // Wind x Heizgradstunden (Fuehler)
if (windNow !== null && owNow !== null) { pl.day.wkW += Math.max(0, pn('tbalC', 15) - owNow) * windNow / 60; pl.day.wwN++; }      // Wind x Heizgradstunden (OWM)
ROOMS.forEach(function (rc) { var r = Rr[rc.id]; if (r && r.ts && now - r.ts < (rc.maxAgeMin || 90) * MS_MIN && ok(r.ema)) { if (pl.day.r0[rc.id] === undefined) { pl.day.r0[rc.id] = r.ema; } pl.day.rl[rc.id] = r.ema; } });

// ---------- Gebaeudemodell (Fahrplan v2, S2): Rueckrechnung aus plan-actuals und Regression, nur BERECHNEN und ANZEIGEN (wirkt nicht auf den Plan)
function readActualRows() {                                                                        // plan-actuals der letzten Wochen (alle Kopfzeilen-Abschnitte, Zuordnung ueber Spaltennamen)
    var rowsA = [], mo0 = new Date(now - pn('learnDays', 21) * 86400000), moN = new Date(now);
    for (var mm = new Date(mo0.getFullYear(), mo0.getMonth(), 1); mm <= moN; mm = new Date(mm.getFullYear(), mm.getMonth() + 1, 1)) {
        try { rowsA = rowsA.concat(parseCsv(fs.readFileSync('/data/optimizer/plan-actuals-' + mm.getFullYear() + '-' + ('0' + (mm.getMonth() + 1)).slice(-2) + '.csv', 'utf8'))); } catch (e) { /* keine Datei */ }
    }
    return rowsA;
}
if (!pl.bf) {
    pl.bf = {days: []};                                                                            // einmal je Prozess: abgeschlossene Tage aus den Ist-Dateien der letzten Wochen
    try { pl.bf.days = daysFromRows(readActualRows(), pn('tbalC', 15)).filter(function (d) { return d.d0 < dayStart(now) && d.n >= 1200; }); } catch (e) { pl.bf.days = []; }
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
        if (b) { ['s', 'wk', 'khW', 'wkW', 'dtr'].forEach(function (k) { if (d[k] === null) { d[k] = b[k]; } }); } else { order.push(d.d0); }
        map[d.d0] = d;
    });
    return order.map(function (k) { return map[k]; }).filter(function (d) { return d.n >= 1200 && d.kh >= pn('learnMinHdd', 30); }).sort(function (x, y) { return x.d0 - y.d0; });
}
var mDays = modelDays(), mSig = mDays.length + '|' + mDays.map(function (d) { return d.d0 + ':' + Math.round(d.q * 100) + ':' + (d.s === null ? '-' : Math.round(d.s * 10)) + ':' + (d.wk === null ? '-' : 'w'); }).join(',');
if (!pl.learn.coef || pl.learn.coef.sig !== mSig) {
    try {
        var fm = fitModel(mDays, {ua0: pn('uaKwPerK', 0.22), h0: pn('uaPriorKh', 300), sUA: 0.10, sW: 0.01, sS: 0.10, minDays: pn('coefMinDays', 10), minWindDays: 7, storeC: [0, 3, 6, 10]});
        var prevAkt = !!(pl.learn.coef && pl.learn.coef.aktiv), cand = fm.maeWind !== null ? fm.maeWind : fm.maeSun;
        fm.sig = mSig; fm.ts = now;
        // Aktivierung nur mit ausdruecklichem Schalter (plan.coefActivate = 1): Gate ok, oder schon aktiv und der Fehler bleibt besser als beim bisherigen Modell (Hysterese)
        fm.aktiv = pn('coefActivate', 0) === 1 && ((fm.gate && fm.gate.ok) || (prevAkt && fm.n >= pn('coefMinDays', 10) && cand !== null && fm.maeBase > 0 && cand <= fm.maeBase));
        pl.learn.coef = fm; pl.lastSave = 0;                                                      // neue Koeffizienten sofort sichern (ueberstehen so einen Neustart ohne Neuberechnung)
    } catch (e) { pl.learn.coef = {n: 0, sig: mSig, ts: now, aktiv: false, error: String(e && e.message || e)}; }
}

// ---------- Fuehlerkorrektur OWM -> Fuehler (Fahrplan v2, S2b): stuendlich neu schaetzen, nur Anzeige und Protokoll (wirkt nicht auf den Plan)
var hBias = Math.floor(now / H) * H;
if (pl.biasHour === undefined && pl.learn.bias && pl.learn.bias.ts) { pl.biasHour = Math.floor(pl.learn.bias.ts / H) * H; }       // nach einem Neustart den gesicherten Stand dieser Stunde behalten
if (pl.biasHour !== hBias || !pl.learn.bias) {
    pl.biasHour = hBias;
    try { var bf2 = biasFit(pl.bias.rows); var bg = biasGate(bf2); pl.learn.bias = {coef: bf2.coef, n: bf2.n, days: bf2.days, maeZero: bf2.maeZero, maeMean: bf2.maeMean, maeMod: bf2.maeMod, gateOk: bg.ok, why: bg.why, aktiv: false, ts: now}; pl.lastSave = 0; }
    catch (e) { pl.learn.bias = {coef: null, n: 0, days: 0, aktiv: false, ts: now, error: String(e && e.message || e)}; }
}

// ---------- Plan berechnen: einmal pro 15-Minuten-Slot, bis er gelingt jede Minute
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
    // Preise
    var pr = PI.price;
    if (!piFresh || !Array.isArray(pr) || !pr.length) { P.status = 'keine Preise'; P.why = 'Die Preisdaten fehlen oder sind zu alt.'; return P; }
    // Heizkurve der Waermepumpe (Soll-Vorlauf je Aussentemperatur)
    var cvLo = num(G('Z1_Heat_Curve_Outside_Low_Temp')), cvHi = num(G('Z1_Heat_Curve_Outside_High_Temp')), cvTl = num(G('Z1_Heat_Curve_Target_Low_Temp')), cvTh = num(G('Z1_Heat_Curve_Target_High_Temp'));
    if (cvLo === null || cvHi === null || cvTl === null || cvTh === null || cvHi <= cvLo) { P.status = 'keine Heizkurve'; P.why = 'Die Heizkurve der Wärmepumpe ist nicht bekannt.'; return P; }
    var curve = function (t) { return t <= cvLo ? cvTh : (t >= cvHi ? cvTl : cvTh + (cvTl - cvTh) * (t - cvLo) / (cvHi - cvLo)); };

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

    // Modellparameter: Waermebedarf (Gebaeudeverlust, aus den Tagesdaten gelernt) und COP (Anteil am Carnot-Wert, aus der Quiet-Statistik gelernt)
    var days = (pl.learn.days || []).filter(function (d) { return d[1] >= pn('learnMinHdd', 30); }), sQ = 0, sH = 0;
    days.forEach(function (d) { sQ += d[2]; sH += d[1]; });
    var ua0 = pn('uaKwPerK', 0.22), uaH0 = pn('uaPriorKh', 300), ua = (ua0 * uaH0 + sQ) / (uaH0 + sH), tbal = pn('tbalC', 15);
    var apE = pn('evapApproachK', 6), apC = pn('condApproachK', 2);
    function carnot(t, vl) { var th = vl + apC + 273.15, tc = t - apE + 273.15; return th > tc + 5 ? th / (th - tc) : null; }
    var qs = flow.get('qs') || {}, kf = qs.kf || {}, etaS = 0, etaN = 0;
    Object.keys(kf).forEach(function (k) {
        var s = kf[k]; if (!s || !s.s || s.n < 10 || !s.s.cop || !s.s.vl || !s.s.at || !s.s.cop[1] || !s.s.vl[1] || !s.s.at[1]) { return; }
        var ca = carnot(s.s.at[0] / s.s.at[1], s.s.vl[0] / s.s.vl[1]), co = s.s.cop[0] / s.s.cop[1];
        if (ca !== null && ca > 1 && co > 0.5 && co < 9) { etaS += (co / ca) * s.n; etaN += s.n; }
    });
    var etaP = pn('etaPrior', 0.45), etaW = etaN / (etaN + pn('etaPriorMin', 600)), eta = clamp((1 - etaW) * etaP + etaW * (etaN ? etaS / etaN : etaP), 0.25, 0.65);
    P.model = {ua: ua, uaDays: days.length, uaLearned: sH > 0, tbal: tbal, eta: eta, etaMin: etaN, etaW: etaW};

    // Raeume: Reserve des Gebaeudes (wie viel Waerme darf nach vorn / hinten verschoben werden, ohne ein Komfortband zu verlassen)
    var rs = [];
    ROOMS.forEach(function (rc) {
        if (rc.active === false || !(rc.min < rc.max)) { return; }
        // Die Sensoren melden selten (Shelly H&T: oft nur alle 1-2 h). Aeltere Werte als das Limit der Raumlogik zaehlen hier bis staleMaxAgeMin mit einem Abschlag je Stunde Alter.
        var r = Rr[rc.id] || {}, a = r.ts ? (now - r.ts) / MS_MIN : null, lim = rc.maxAgeMin || cfg.sensor.maxAgeMin;
        if (!ok(r.ema) || a === null || a > pn('staleMaxAgeMin', 240)) { rs.push({name: rc.name, valid: false, age: a}); return; }
        var tr = ok(r.trend) ? r.trend : 0, th = pn('trendHorizonH', 2), stale = a > lim, allow = stale ? pn('staleDriftKph', 0.1) * a / 60 : 0;
        rs.push({name: rc.name, valid: true, stale: stale, age: a, tr: tr, dLow: r.ema - rc.min, dHigh: rc.max - r.ema, eLow: r.ema + Math.min(0, tr) * th - rc.min - allow, eHigh: rc.max - (r.ema + Math.max(0, tr) * th) - allow, min: rc.min, max: rc.max});
    });
    var val = rs.filter(function (x) { return x.valid; }), cold = val.filter(function (x) { return x.dLow < 0; }), warm = val.filter(function (x) { return x.dHigh < 0; });
    var bufK = pn('bufferKwhPerK', 3), guard = pn('guardK', 0.3), maxSh = pn('maxShiftKwh', 8), rDown = 0, rUp = 0, rState;
    var mDown = val.length ? Math.min.apply(null, val.map(function (x) { return x.eLow; })) : null, mUp = val.length ? Math.min.apply(null, val.map(function (x) { return x.eHigh; })) : null;
    if (!val.length) { rState = 'keine Raumdaten'; }
    else if (val.length < rs.length) { rState = 'Raumdaten unvollständig'; }
    else if ((cold.length && warm.length) || (sxFresh && Sx.distrib)) { rState = 'Wärmeverteilungskonflikt'; }
    else if (cold.length) { rState = 'Raum unter Minimum'; rUp = bufK * Math.max(0, mUp - guard); }
    else if (warm.length) { rState = 'Raum über Maximum'; rDown = bufK * Math.max(0, mDown - guard); }
    else { rState = 'alle im Band'; rDown = bufK * Math.max(0, mDown - guard); rUp = bufK * Math.max(0, mUp - guard); }
    rDown = Math.min(rDown, maxSh); rUp = Math.min(rUp, maxSh);
    var critDown = null, critUp = null;
    val.forEach(function (x) { if (critDown === null || x.eLow < critDown.eLow) { critDown = x; } if (critUp === null || x.eHigh < critUp.eHigh) { critUp = x; } });
    P.res = {state: rState, down: rDown, up: rUp, dnM: critDown ? critDown.eLow : null, dnTr: critDown ? critDown.tr : null, upM: critUp ? critUp.eHigh : null, upTr: critUp ? critUp.tr : null, critDown: critDown ? critDown.name : '', critUp: critUp ? critUp.name : '', valid: val.length, active: rs.length,
             stale: val.filter(function (x) { return x.stale; }).map(function (x) { return x.name + ' ' + Math.round(x.age) + ' min'; }), missing: rs.filter(function (x) { return !x.valid; }).map(function (x) { return x.name; })};
    var tRoom = ROOMS.filter(function (rc) { return rc.active !== false && rc.min < rc.max; }).map(function (rc) { return (rc.min + rc.max) / 2; });
    tRoom = tRoom.length ? tRoom.reduce(function (x, y) { return x + y; }, 0) / tRoom.length : 22;

    // Prognose je Slot (Aufloesung der Quellen bleibt bekannt: Temperatur 3 h, PV 1 h bzw. 15 min, Preis 15 min)
    var owmNow = wAt(now, 1), anchor = (atNow !== null && owmNow !== null) ? clamp(atNow - owmNow, -5, 5) : 0, tauA = pn('anchorTauH', 4);
    var raw = [], i;
    var pvArr = PI.pv, pvRes = Array.isArray(pvArr) && pvArr.length ? pvArr[0][2] / MS_MIN : null;
    function pvMean(a, b) {
        if (!Array.isArray(pvArr) || !pvArr.length) { return null; }
        var sw = 0, dt = 0;
        pvArr.forEach(function (x) { var q0 = x[0], q1 = x[0] + x[2], o = Math.min(q1, b) - Math.max(q0, a); if (o > 0) { sw += x[1] * o; dt += o; } });
        return dt >= (b - a) * 0.9 ? sw / dt : null;
    }
    for (i = 0; i < N; i++) {
        var t = s0 + i * Q15, ctr = t + Q15 / 2, L = Math.max(0, (ctr - now) / H);
        var atF = wAt(ctr, 1), rhF = wAt(ctr, 2), price = priceAt(pr, t);
        if (atF === null || price === null) { P.status = price === null ? 'keine Preise' : 'keine Wetterprognose'; P.why = 'Für ' + hhmm(t) + ' fehlen Daten.'; return P; }
        raw.push({t: t, L: L, atF: atF + anchor * Math.exp(-L / tauA), rhF: rhF, price: price, pv: pvMean(t, t + Q15), windF: wAt(ctr, 4), clF: wAt(ctr, 3)});
    }
    var m24 = 0, r24 = 0, rn = 0, p24 = 0;
    for (i = 0; i < NDAY; i++) { m24 += raw[i].atF; if (raw[i].rhF !== null) { r24 += raw[i].rhF; rn++; } }
    var atRef = m24 / NDAY, rhRef = rn ? r24 / rn : 70;                                         // Schrumpfziel: Tagesmittel der Prognose
    function defr(t, rh) {
        var rT = t <= -10 ? 0.15 : (t <= -5 ? lerp(t, -10, 0.15, -5, 0.5) : (t <= -2 ? lerp(t, -5, 0.5, -2, 0.95) : (t <= 3 ? 1 : (t <= 6 ? lerp(t, 3, 1, 6, 0.3) : (t <= 8 ? lerp(t, 6, 0.3, 8, 0) : 0)))));
        var rH = clamp((rh - 55) / 35, 0, 1);
        return rT * (0.3 + 0.7 * rH);
    }
    function dewp(t, rh) { var a = 17.62, b = 243.12, g = Math.log(Math.max(rh, 1) / 100) + a * t / (b + t); return b * g / (a - g); }
    var minVlC = num((cfg.control || {}).minVlC); if (minVlC === null) { minVlC = 29; }
    var qOffLo = num(QC.offAtLow), qOffHi = num(QC.offAtHigh); if (qOffLo === null) { qOffLo = 1; } if (qOffHi === null) { qOffHi = 3; }
    var uaKw = ua, dflLoss = pn('defrostLoss', 0.15), uncP = pn('uncertaintyPremium', 0.05), slots = [], cbarS = 0;
    // Sonne und Wind im Bedarf (Fahrplan v2, S3): wirken nur, wenn die gelernten Koeffizienten aktiviert sind; sonst bit-identisch zum bisherigen Modell. Der Kandidat wird immer mitgerechnet und protokolliert.
    var cfM = pl.learn.coef || null;
    var candC = (cfM && cfM.n >= 3) ? (cfM.maeWind !== null && cfM.maeWind !== undefined ? {bs: cfM.bsW || 0, bw: cfM.bw || 0} : {bs: cfM.bs || 0, bw: 0}) : {bs: 0, bw: 0};
    var useC = (cfM && cfM.aktiv) ? candC : {bs: 0, bw: 0};
    var solMax = pn('solarMaxShare', 0.6), tauS = pn('solarTauH', 2), alphaS = 1 - Math.exp(-(Q15 / H) / tauS), sPrev = (pl.pvHist && pl.pvHist.length >= 4) ? pl.pvHist.reduce(function (x, y) { return x + y; }, 0) / pl.pvHist.length : 0;
    var wSum = 0, wCnt = 0; for (i = 0; i < NDAY; i++) { if (ok(raw[i].windF)) { wSum += raw[i].windF; wCnt++; } }
    var windRef = wCnt ? wSum / wCnt : 0;
    raw.forEach(function (x, ix) {
        var cA = confAt(cAt, x.L), cP = confAt(cPv, x.L);
        var atE = cA * x.atF + (1 - cA) * atRef, rhE = cA * (x.rhF === null ? rhRef : x.rhF) + (1 - cA) * rhRef;   // je schlechter die Prognose, desto weniger weicht sie vom Tagesmittel ab
        var vl = Math.max(minVlC, curve(atE)), cg = carnot(atE, vl), cop = cg === null ? null : clamp(eta * cg, 1.5, 6.5);
        if (cop === null) { cop = 3; }
        var bedarf = uaKw * Math.max(0, tbal - atE) * (Q15 / H);                                   // kWh Waerme je Slot
        var dK = Math.max(0, tbal - atE), bas = bedarf;                                            // bas: bisheriges Modell
        var sRaw = ok(x.pv) ? cP * x.pv * (Q15 / H) / 1000 : 0; sPrev = sPrev + (sRaw - sPrev) * alphaS; var sunE = sPrev;      // PV-Energie des Slots (mit Vertrauen gewichtet), mit Waermeverzoegerung geglaettet
        var windE = ok(x.windF) ? cA * x.windF + (1 - cA) * windRef : 0;
        var solU = Math.min(useC.bs * sunE, solMax * bas), winU = useC.bw * dK * windE * (Q15 / H);
        var solK = Math.min(candC.bs * sunE, solMax * bas), winK = candC.bw * dK * windE * (Q15 / H), kand = Math.max(0, bas + winK - solK);
        bedarf = Math.max(0, bas + winU - solU);                                                    // Koeffizienten 0 -> bedarf === bas
        var risk = defr(atE, rhE), base = x.price * 100 / cop, dPen = base * dflLoss * risk, uPen = base * uncP * (1 - cA);
        var atK = null, bcf = pl.learn.bias && pl.learn.bias.coef;
        if (bcf) {                                                                                  // Fuehlerkorrektur: OWM + Versatz(Merkmale des Slots) + abklingender Rest des heutigen Versatzes (nur Protokoll)
            var atO = x.atF - anchor * Math.exp(-x.L / tauA), dHat = biasDot(bcf, biasFeat(new Date(x.t).getHours(), x.windF, x.pv, x.clF));
            var dNow = biasDot(bcf, biasFeat(new Date(now).getHours(), windNow, piFresh ? PI.pvNow : null, clNow)), rest = (atNow !== null && owmNow !== null) ? clamp((atNow - owmNow) - dNow, -5, 5) : 0;
            atK = atO + dHat + rest * Math.exp(-x.L / tauA);
        }
        slots.push({t: x.t, L: x.L, at: atE, atRaw: x.atF, rh: rhE, dew: dewp(atE, rhE), vl: vl, cop: cop, price: x.price, pv: x.pv, wind: x.windF, cl: x.clF, atK: atK, sun: sunE, solK: solK, winK: winK, bas: bas, kand: kand, solU: solU, winU: winU, bedarf: bedarf, risk: risk, cA: cA, cP: cP, base: base, dPen: dPen, uPen: uPen, cost: base + dPen + uPen});
        if (ix < NDAY) { cbarS += (base + dPen + uPen); }
    });
    // Leistungsgrenze der Anlage: Nennleistung (5-kW-Modell) und, wenn eine Quiet-Stufe gesetzt ist, deren Deckel. Fuer Stufe 3 gilt eine Annahme (Forenangabe ca. 3-3,5 kW,
    // nicht gemessen), bis die Quiet-Statistik im eingeschwungenen Lauf mehr zeigt (dann gilt der hoehere Messwert).
    var pMaxKw = pn('pMaxKw', 5), capKw = pMaxKw, capSrc = 'Modell', capObs = null, qLv = num(G('TOP18_Quiet_Mode_Level'));
    if (qLv !== null) {
        Object.keys(kf).forEach(function (k) { var sx = kf[k]; if (sx && sx.mx && ok(sx.mx.pth) && k.split('|')[0] === String(qLv)) { capObs = Math.max(capObs === null ? 0 : capObs, sx.mx.pth / 1000); } });
        var capAs = num((PC.quietCapAssumedKw || {})[qLv]), qPrio = HP.Quiet_Mode_Priority ? HP.Quiet_Mode_Priority.v : null;
        if (capAs !== null && qPrio === 1) { capSrc = 'Modell (Priorität Leistung: der Deckel weicht bei Bedarf, ungeprüft)'; }
        else if (capAs !== null) { capKw = Math.min(pMaxKw, Math.max(capAs, capObs === null ? 0 : capObs)); capSrc = (capObs !== null && capObs > capAs) ? 'gemessen' : 'Annahme'; }
    }
    P.cap = {kw: capKw, src: capSrc, obs: capObs, level: qLv};
    var qn = Math.max(0.01, pn('quantKwh', 0.05)), bSum = 0, cbarW = 0;
    for (i = 0; i < NDAY; i++) { bSum += slots[i].bedarf; cbarW += slots[i].cost * slots[i].bedarf; }
    var cbar = bSum > 0 ? cbarW / bSum : cbarS / NDAY;
    // Normalverlauf in ganzen Einheiten (kumuliertes Runden: Tagessumme bleibt exakt erhalten)
    var bq = [], cum = 0, prevR = 0;
    for (i = 0; i < N; i++) { cum += slots[i].bedarf / qn; var rr = Math.round(cum); bq.push(rr - prevR); prevR = rr; }
    var cq = slots.map(function (x) { return x.cost * qn; }), lam = pn('shiftPenaltyPct', 2) / 100 * cbar * qn, mMin = pn('mMin', 0.4), mMax = pn('mMax', 1.6), capQ = Math.floor(capKw * 0.25 / qn);
    var enough = bSum >= pn('minDemandKwh', 4);
    // Geplant wird genau ueber die angezeigten 24 h (Summe bleibt dort erhalten); die letzten Slots (bis 26 h) sind nur Prognose fuer den spaeteren Vergleich und bleiben im Normalverlauf
    var b24 = bq.slice(0, NDAY), c24 = cq.slice(0, NDAY), tail = bq.slice(NDAY);
    var pq = enough ? planDP(b24, c24, lam, Math.floor(rDown / qn), Math.floor(rUp / qn), mMin, mMax, capQ).concat(tail) : bq.slice();
    var pqPot = enough ? planDP(b24, c24, lam, Math.floor(maxSh / qn), Math.floor(maxSh / qn), mMin, mMax, capQ).concat(tail) : bq.slice();     // Potenzial ohne Komfortgrenze (nur zum Vergleich)
    var tol = pn('recTol', 0.1), cumD = 0;
    slots.forEach(function (x, ix) {
        x.b = bq[ix] * qn; x.p = pq[ix] * qn; x.pPot = pqPot[ix] * qn;
        cumD += x.p - x.b; x.resBack = rDown + cumD; x.resFwd = rUp - cumD;                      // Reserve, die nach diesem Slot noch uebrig ist
        var m = x.b >= 0.02 ? x.p / x.b : null;
        x.m = m;
        x.rec = (!enough || m === null) ? 0 : (m >= 1 + tol ? 1 : (m <= 1 - tol ? -1 : 0));
        x.att = Math.round(clamp(50 + 50 * (cbar - x.cost) / (0.4 * cbar), 0, 100));
        var off = 0;
        if (x.rec !== 0 && m !== null) { off = clamp(Math.round((m - 1) * Math.max(3, x.vl - tRoom) * 2) / 2, -2, 2); }
        x.offFloor = false;
        if (off < 0) {                                                                              // nie unter die absolute Vorlauf-Untergrenze (Heizkoerper)
            var vlRoom = Math.max(0, Math.floor((x.vl - minVlC) * 2) / 2);
            if (-off > vlRoom) { off = -vlRoom; x.offFloor = true; }
        }
        x.off = off;
        var needW = x.p / 0.25 * 1000, hint = '–';
        if (x.at >= qOffLo && x.at <= qOffHi) { hint = 'Stufe 0 (' + qOffLo + '–' + qOffHi + ' °C)'; }
        else {
            var bi = x.at < 0 ? 0 : (x.at < 3 ? 1 : (x.at < 7 ? 2 : (x.at < 12 ? 3 : 4)));
            [0, 1, 2, 3].forEach(function (lv) { var s = kf[lv + '|' + bi]; if (s && s.n >= 30 && s.s && s.s.pth && s.s.pth[1] >= 20 && s.s.pth[0] / s.s.pth[1] >= needW * 1.1 && needW > 0) { hint = 'Stufe ' + lv + ' (gemessen)'; } });
        }
        x.quiet = hint;
    });
    // Kennzahlen und Fenster
    var sumB = 0, sumUp = 0, costB = 0, costP = 0, costPot = 0;
    var sumSol = 0, sumWin = 0; for (i = 0; i < NDAY; i++) { sumSol += slots[i].solU; sumWin += slots[i].winU; }
    for (i = 0; i < NDAY; i++) { var q = slots[i]; sumB += q.b; sumUp += Math.max(0, q.p - q.b); costB += q.cost * q.b; costP += q.cost * q.p; costPot += q.cost * q.pPot; }
    // Ersparnis des Modells nach Ursache (wie in der Lambda-Studie): Preis, COP/Wetter, Abtaurisiko, Unsicherheitsaufschlag. Die vier Teile ergeben genau costB - costP.
    var invCopW = 0, savPrice = 0, savCop = 0, savDef = 0, savUnc = 0;
    for (i = 0; i < NDAY; i++) { invCopW += slots[i].b / slots[i].cop; }
    var cop0 = invCopW > 0 ? sumB / invCopW : 1;                                                   // mittlerer COP des Normalverlaufs (energiegewichtet)
    for (i = 0; i < NDAY; i++) {
        var qd = slots[i], dk = qd.b - qd.p;                                                       // positiv = in diesem Slot weniger Waerme als im Normalverlauf
        savPrice += qd.price * 100 / cop0 * dk; savCop += qd.price * 100 * (1 / qd.cop - 1 / cop0) * dk; savDef += qd.dPen * dk; savUnc += qd.uPen * dk;
    }
    var W3 = Math.round(pn('windowH', 3) * 4), bestT = null, bestP = null;
    for (i = 0; i + W3 <= NDAY; i++) {
        var sc = 0, sp = 0, np = 0;
        for (var j = i; j < i + W3; j++) { sc += slots[j].cost; if (slots[j].pv !== null) { sp += slots[j].pv; np++; } }
        if (bestT === null || sc / W3 < bestT.v) { bestT = {i: i, v: sc / W3}; }
        if (np === W3 && (bestP === null || sp / W3 > bestP.v)) { bestP = {i: i, v: sp / W3}; }
    }
    var maxD = null; for (i = 0; i < NDAY; i++) { var dk = slots[i].bedarf / 0.25; if (maxD === null || dk > maxD.kw) { maxD = {kw: dk, t: slots[i].t}; } }
    var elM = 0; for (i = 0; i < NDAY; i++) { elM += slots[i].bedarf / slots[i].cop; }
    P.minVlC = minVlC; P.maxDemand = maxD; P.elModel = elM; P.vrmHp = (PI.vrmHpKwh === undefined || PI.vrmHpKwh === null) ? null : PI.vrmHpKwh;
    P.slots = slots; P.cbar = cbar; P.enough = enough; P.eta = eta;
    P.sum = {solU: sumSol, winU: sumWin, bedarf: sumB, up: sumUp, costB: costB, costP: costP, costPot: costPot, savPrice: savPrice, savCop: savCop, savDef: savDef, savUnc: savUnc, savMon: savPrice + savCop, cop0: cop0, thermWin: bestT, pvWin: bestP, atRef: atRef, anchor: anchor, pvRes: pvRes, wRes: 180};
    return P;
}

if (!pl.plan || pl.planSlot !== s0 || pl.plan.status !== 'ok' || pl.plan.ver !== PLAN_VER) {
    pl.plan = buildPlan(); pl.planSlot = s0;
}
var P = pl.plan;

// ---------- Schnappschuss: je Stunde ein Plan mit allen Eingaengen (bleibt unveraendert, wird nur fuer den spaeteren Vergleich gelesen)
var SNAP_COLS = ['t', 'at', 'rh', 'cop', 'price', 'pv', 'bedarf', 'plan', 'defrost', 'conf_at', 'conf_pv', 'att', 'rec', 'kosten', 'offset', 'quiet', 'plan_pot', 'taupunkt', 'kosten_basis', 'strafe_defrost', 'strafe_unsicher', 'reserve_hinten', 'reserve_vorn', 'wind', 'wolken', 'at_korr', 'sonne_kwh', 'solar_kand_kwh', 'wind_kand_kwh', 'bedarf_basis', 'bedarf_kand'];
var hourNow = Math.floor(now / H) * H;
if (P.status === 'ok' && P.slots && pl.snapHour !== hourNow) {
    var snap = {t0: hourNow, s0: P.s0, t: now, status: 'ok', cols: SNAP_COLS, slots: P.slots.map(function (x) {
        return [x.t, Math.round(x.at * 100) / 100, Math.round(x.rh), Math.round(x.cop * 100) / 100, x.price, x.pv === null ? null : Math.round(x.pv), Math.round(x.b * 1000) / 1000, Math.round(x.p * 1000) / 1000, Math.round(x.risk * 100) / 100,
                Math.round(x.cA * 100) / 100, Math.round(x.cP * 100) / 100, x.att, x.rec, Math.round(x.cost * 100) / 100, x.off, x.quiet, Math.round(x.pPot * 1000) / 1000, Math.round(x.dew * 10) / 10, Math.round(x.base * 100) / 100, Math.round(x.dPen * 100) / 100, Math.round(x.uPen * 100) / 100,
                Math.round(x.resBack * 1000) / 1000, Math.round(x.resFwd * 1000) / 1000,
                ok(x.wind) ? Math.round(x.wind * 10) / 10 : null, ok(x.cl) ? Math.round(x.cl) : null, ok(x.atK) ? Math.round(x.atK * 100) / 100 : null,
                Math.round(x.sun * 1000) / 1000, Math.round(x.solK * 1000) / 1000, Math.round(x.winK * 1000) / 1000, Math.round(x.bas * 1000) / 1000, Math.round(x.kand * 1000) / 1000];
    }), meta: {plan_slots: 96, cap: P.cap, sav_ct: {preis: Math.round(P.sum.savPrice * 100) / 100, cop: Math.round(P.sum.savCop * 100) / 100, abtau: Math.round(P.sum.savDef * 100) / 100, unsicher: Math.round(P.sum.savUnc * 100) / 100, monetaer: Math.round(P.sum.savMon * 100) / 100, summe: Math.round((P.sum.costB - P.sum.costP) * 100) / 100, cop0: Math.round(P.sum.cop0 * 100) / 100}, el_model_24h_kwh: Math.round(P.elModel * 100) / 100, vrm_hp_24h_kwh: P.vrmHp, model: P.model, res: {at_min: 180, rh_min: 180, pv_min: P.sum.pvRes, price_min: 15}, reserve: {state: P.res.state, down: P.res.down, up: P.res.up, stale: P.res.stale, missing: P.res.missing}, conf_at: P.conf.at.map(function (a) { return [a.h, Math.round(a.c * 100) / 100, a.n]; }),
            conf_pv: P.conf.pv.map(function (a) { return [a.h, Math.round(a.c * 100) / 100, a.n]; })}};
    pl.snaps = (pl.snaps || []).filter(function (x) { return x.t0 > now - pn('snapKeepH', 27) * H; });
    pl.snaps.push(snap); pl.snapHour = hourNow;
    var jl = {t0: snap.t0, s0: snap.s0, t: snap.t, cols: snap.cols, meta: snap.meta, slots: snap.slots.map(function (sl) { var r = sl.slice(); r[0] = Math.round(r[0] / 1000); return r; })};
    out[3] = {filename: '/data/optimizer/plan-snapshots-' + monthOf(now) + '.jsonl', payload: JSON.stringify(jl) + '\n'};
    pl.lastSave = 0;
}
if (!pl.lastSave || now - pl.lastSave >= 60 * MS_MIN) { jsave('/data/optimizer/plan-state.json', {learn: pl.learn, snaps: pl.snaps, day: pl.day}); pl.lastSave = now; }

// ---------- Anzeige
var warnCls = function (okk) { return okk ? 'ok' : 'warn'; };
var rows = [];
if (P.status !== 'ok') { rows.push(['Status', 'Kein Plan: ' + P.status, 'warn'], ['Grund', P.why, '']); }
var tab = [];
if (P.status === 'ok') {
    var sm = P.sum, rsx = P.res, ml = P.model, sl0 = P.slots;
    var tw = sm.thermWin, pw = sm.pvWin;
    var win = function (w, unit, d) { return w ? hhmm(sl0[w.i].t) + ' – ' + hhmm(sl0[w.i].t + 3 * H) + ' · Ø ' + f(w.v, d, unit) : '–'; };
    var dayB = sm.bedarf, shiftK = sm.up, sav = sm.costB - sm.costP, savPot = sm.costB - sm.costPot;
    rows = [
        ['Status', 'Shadow · berechnet ' + hhmm(P.t) + (P.enough ? '' : ' · kaum Heizbedarf, es wird nichts verschoben'), P.enough ? 'ok' : ''],
        ['Wärmebedarf nächste 24 h', f(dayB, 1, 'kWh') + ' · Ø ' + f(dayB / 24, 2, 'kW') + ' (Bedarf ' + (ml.uaLearned ? 'gelernt aus ' + ml.uaDays + ' Tagen' : 'Standardwert') + ' ' + f(ml.ua * 1000, 0, 'W/K') + ')' + ((sm.solU || sm.winU) ? ' · Sonne ' + f(-sm.solU, 1, 'kWh') + ' · Wind ' + f(sm.winU, 1, 'kWh') : ''), ''],
        ['Verschobene Wärme', f(shiftK, 2, 'kWh') + ' vorgezogen · Ersparnis Modell ' + f(sav, 0, 'ct') + (dayB > 0 ? ' (' + f(100 * sav / Math.max(1, sm.costB), 1, '%') + ')' : '') + ' · ohne Komfortgrenzen ' + f(savPot, 0, 'ct'), ''],
        ['Ersparnis nach Ursache (Modell)', 'Preis ' + f(sm.savPrice, 1, 'ct') + ' · COP/Wetter ' + f(sm.savCop, 1, 'ct') + ' · Abtaurisiko ' + f(sm.savDef, 1, 'ct') + ' · Unsicherheit ' + f(sm.savUnc, 1, 'ct') + ' (mittlerer COP ' + f(sm.cop0, 2) + ') · monetär ' + f(sm.savMon, 1, 'ct') + ' (Preis + COP, ohne Modellaufschläge)', ''],
        ['Leistungsgrenze' + (P.cap.level !== null ? ' (Quiet ' + P.cap.level + ')' : ''), f(P.cap.kw, 1, 'kW') + ' (' + P.cap.src + (P.cap.obs !== null ? ' · höchster Dauerwert ' + f(P.cap.obs, 1, 'kW') : '') + ') · höchster Bedarf ' + f(P.maxDemand.kw, 1, 'kW') + ' um ' + hhmm(P.maxDemand.t) + ' · reicht bis ca. ' + f(ml.tbal - P.cap.kw / ml.ua, 0, '°C') + ' Außen', P.maxDemand.kw > P.cap.kw * 0.9 ? 'warn' : ''],
        ['Strom Wärmepumpe nächste 24 h', f(P.elModel, 1, 'kWh') + ' (Modell: Wärmebedarf ÷ COP) · VRM-Prognose ' + (P.vrmHp !== null ? f(P.vrmHp, 2, 'kWh') : 'nicht geliefert'), ''],
        ['Reserve Gebäude', 'nach hinten ' + f(rsx.down, 1, 'kWh') + (rsx.critDown ? ' (' + rsx.critDown + ': ' + f(rsx.dnM, 1, 'K') + ' bis Minimum' + (rsx.dnTr !== null && rsx.dnTr < -0.05 ? ', kühlt ' + f(-rsx.dnTr, 1, 'K/h') : '') + ')' : '') + ' · nach vorn ' + f(rsx.up, 1, 'kWh') + (rsx.critUp ? ' (' + rsx.critUp + ': ' + f(rsx.upM, 1, 'K') + ' bis Maximum' + (rsx.upTr !== null && rsx.upTr > 0.05 ? ', wärmt ' + f(rsx.upTr, 1, 'K/h') : '') + ')' : '') + ' · ' + rsx.state + (rsx.missing.length ? ' · ohne Daten: ' + rsx.missing.join(', ') : '') + (rsx.stale.length ? ' · ältere Werte mit Abschlag: ' + rsx.stale.join(', ') : ''), rsx.state === 'alle im Band' ? 'ok' : 'warn'],
        ['Thermisch günstigstes Fenster', win(tw, 'ct/kWh', 1) + ' (Tagesmittel ' + f(P.cbar, 1, 'ct') + ')', ''],
        ['PV-günstigstes Fenster', pw ? win(pw, 'W', 0) : 'keine PV-Prognose', ''],
        ['Batterie', ok(PI.soc) ? f(PI.soc, 0, '%') + ' (' + (PI.socSrc || '–') + ')' : '–', ''],
        ['Vertrauen Temperatur', P.conf.at.map(function (a) { return '+' + a.h + ' h ' + Math.round(a.c * 100) + ' %'; }).join(' · '), ''],
        ['Vertrauen PV', P.conf.pv.map(function (a) { return '+' + a.h + ' h ' + Math.round(a.c * 100) + ' %'; }).join(' · '), ''],
        ['Gewicht gemessen / Standard', 'Temperatur ' + P.conf.at.map(function (a) { return Math.round(a.w * 100); }).join('/') + ' % · PV ' + P.conf.pv.map(function (a) { return Math.round(a.w * 100); }).join('/') + ' %', ''],
        ['COP-Modell', 'η ' + f(ml.eta, 2) + ' vom Carnot-Wert (' + (ml.etaMin >= 60 ? 'gemessen ' + Math.round(ml.etaW * 100) + ' %, ' + ml.etaMin + ' min' : 'Standardwert') + ') · Heizgrenze ' + f(ml.tbal, 0, '°C'), ''],
        ['Auflösung der Quellen', 'Temperatur 3 h · PV ' + (sm.pvRes ? f(sm.pvRes, 0, 'min') : '–') + ' · Preis 15 min', '']
    ];
    (function () {                                                                                 // Gebaeudemodell (nur Werte): Kandidat aus Sonne/Wind, Fehler gegen den Plan-Schaetzer
        var cf = pl.learn.coef, txt, cls = '';
        if (!cf || !cf.n) { txt = 'UA ' + f(ml.ua * 1000, 0, 'W/K') + ' (Plan) · keine Daten'; }
        else if (cf.n < 3) { txt = 'UA ' + f(ml.ua * 1000, 0, 'W/K') + ' (Plan) · ' + cf.n + ' Tag' + (cf.n === 1 ? '' : 'e') + ' · Kandidat ab 3 Tagen'; }
        else {
            var bestE = [cf.maeUA, cf.maeSun, cf.maeWind].filter(function (v) { return v !== null && v !== undefined; }).reduce(function (m, v) { return m === null || v < m ? v : m; }, null);
            txt = 'UA ' + f((cf.uaRidge || ml.ua) * 1000, 0, 'W/K') + ' · Sonne ' + f(cf.bs, 3) + ' · Wind ' + (cf.maeWind !== null && cf.maeWind !== undefined ? f(cf.bw, 3) : 'n ' + cf.nW + ' Tage') + ' · ' + (cf.aktiv ? 'aktiv' : 'Kandidat') + ' · ' + cf.n + ' Tage · Fehler Plan ' + f(cf.maeBase, 1) + ' / Kandidat ' + f(bestE, 1, 'kWh');
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
    // Tabelle: 24 h in Stundenbloecken ab dem aktuellen Slot
    for (var b = 0; b < 24; b++) {
        var g = sl0.slice(b * 4, b * 4 + 4), n = g.length, mean = function (k) { var s = 0, cnt = 0; g.forEach(function (x) { if (x[k] !== null && x[k] !== undefined) { s += x[k]; cnt++; } }); return cnt ? s / cnt : null; };
        var sB = 0, sP = 0, rk = 0; g.forEach(function (x) { sB += x.b; sP += x.p; if (x.risk > rk) { rk = x.risk; } });
        var mh = sB >= 0.05 ? sP / sB : null, recH = (!P.enough || mh === null) ? 0 : (mh >= 1 + pn('recTol', 0.1) ? 1 : (mh <= 1 - pn('recTol', 0.1) ? -1 : 0));
        var offH = mean('off'), qh = g[0].quiet;
        tab.push({z: hhmm(g[0].t), b: f(sB, 2), p: f(sP, 2), cop: f(mean('cop'), 1), h: f(mean('rh'), 0, '%') + ' · ' + f(mean('dew'), 1, '°C'), pr: f(mean('price') * 100, 1), k: f(mean('cost'), 1), pv: mean('pv') === null ? '–' : f(mean('pv'), 0),
                  d: rk >= 0.05 ? Math.round(rk * 100) + ' %' : '–', v: Math.round(mean('cA') * 100) + ' %', a: Math.round(mean('att')),
                  r: recH === 1 ? 'VORZIEHEN' : (recH === -1 ? 'VERSCHIEBEN' : 'NORMAL'), cls: recH === 1 ? 'up' : (recH === -1 ? 'down' : ''),
                  o: recH === 0 || offH === null ? '–' : (g.some(function (x) { return x.offFloor; }) && offH === 0 ? 'Untergrenze ' + f(P.minVlC, 0, '°C') : (offH > 0 ? '+' : '') + f(offH, 1, 'K')), q: qh});
    }
}
var chartD = null, kpi = [];
if (P.status === 'ok') {                                                                         // Daten fuer Diagramm und Kennzahlen-Kacheln der Karte
    var sm2 = P.sum, rs2 = P.res || {}, wf = function (w) { return w ? hhmm(P.slots[w.i].t) + '–' + hhmm(P.slots[w.i].t + 3 * H) : '–'; };
    chartD = {slots: P.slots.slice(0, 96).map(function (x) { return [x.t, Math.round(x.b * 4000) / 1000, Math.round(x.p * 4000) / 1000, Math.round(x.price * 1000) / 10, x.pv === null ? null : Math.round(x.pv), Math.round(x.cop * 100) / 100, Math.round(x.at * 10) / 10, ok(x.atK) ? Math.round(x.atK * 10) / 10 : null, x.rec]; })};
    kpi = [{k: 'Stand', v: hhmm(P.t), s: 'Shadow, ' + (P.enough ? 'plant' : 'kaum Heizbedarf')},
           {k: 'Wärmebedarf 24 h', v: f(sm2.bedarf, 1, 'kWh'), s: 'Ø ' + f(sm2.bedarf / 24, 2, 'kW')},
           {k: 'Strom Wärmepumpe', v: f(P.elModel, 1, 'kWh'), s: 'VRM ' + (P.vrmHp !== null ? f(P.vrmHp, 1, 'kWh') : '–')},
           {k: 'Ersparnis (Modell)', v: f(sm2.costB - sm2.costP, 0, 'ct'), s: 'ohne Grenzen ' + f(sm2.costB - sm2.costPot, 0, 'ct')},
           {k: 'Reserve Gebäude', v: f(rs2.down, 1) + ' / ' + f(rs2.up, 1) + ' kWh', s: 'hinten / vorn'},
           {k: 'Günstigstes Fenster', v: wf(sm2.thermWin), s: sm2.thermWin ? 'Ø ' + f(sm2.thermWin.v, 1, 'ct/kWh') : ''},
           {k: 'PV-Fenster', v: wf(sm2.pvWin), s: sm2.pvWin ? 'Ø ' + f(sm2.pvWin.v, 0, 'W') : 'keine Prognose'}];
}
out[0] = {payload: {rows: rows, plan: tab, chart: chartD, kpi: kpi}};
global.set('OPT_plan', {ts: now, s0: P.s0, status: P.status, reserve: P.res || null, slots: P.slots ? P.slots.map(function (x) { return [x.t, x.rec, x.b, x.p, x.cost, x.cA]; }) : null});
flow.set('plan', pl);
return out;
"""


EVAL_JS = r"""
// Einmal pro Minute: Werte zusammenfuehren, bewerten, anzeigen und protokollieren. KEIN Eingriff in die Regelung.
// Raeume werden nach der Abweichung vom EIGENEN Komfortband bewertet, nicht nach der absoluten Temperatur:
// unter dem Minimum negativ (Heizbedarf), im Band 0, ueber dem Maximum positiv (Ueberschreitung).
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
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
var rooms = [];
(cfg.rooms || []).forEach(function (rc) {
    var r = R[rc.id] || {};
    var a = ageMin(r.ts), lim = rc.maxAgeMin || cfg.sensor.maxAgeMin;
    var band = isFinite(rc.min) && isFinite(rc.max) && rc.min < rc.max;
    var on = rc.active !== false;
    var x = {id: rc.id, name: rc.name, on: on, active: on && band, hasData: (r.ema !== undefined && a !== null), age: a, lim: lim,
             ema: r.ema, last: r.last, trend: (r.trend === undefined ? null : r.trend), min: rc.min, max: rc.max, weight: rc.weight || 1,
             dev: 0, score: 0, dLow: null, dHigh: null};
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
    heat: none ? '–' : (heat ? heat.name + ' · ' + f(-heat.dev, 1, 'K') + ' unter Minimum · ' + trTxt(heat) : 'keiner'),
    heatCls: (none || heat) ? 'warn' : 'ok',
    over: none ? '–' : (over ? over.name + ' · ' + f(over.dev, 1, 'K') + ' über Maximum · ' + trTxt(over) : 'keiner'),
    overCls: (none || over) ? 'warn' : 'ok',
    tight: tight ? sg(tight.m, 1, 'K') + ' (' + tight.room.name + ')' : '–',
    tightCls: (tight && tight.m < 0.3) ? 'warn' : '',
    valid: valids.length + ' von ' + nActive + ' aktiven Räumen' + (nActive < rooms.length ? ' · ' + (rooms.length - nActive) + ' inaktiv' : ''),
    validCls: valids.length < nActive ? 'warn' : ''
};
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
            on: x.on, min: x.min, max: x.max, weight: x.weight, maxAgeMin: x.lim};
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
var HPe = G('OPT_hp') || {}, hcV = (HPe.Heating_Control && typeof HPe.Heating_Control.v === 'number') ? HPe.Heating_Control.v : null;
var hcHm = function (ts) { return new Date(ts).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}); };
var rowsWp = [
    ['Betriebszustand', mode + (ssOn ? ' · Sanftanlauf' : ''), ''],
    ['Heizregelung', hcV === null ? '–' : (hcV === 1 ? 'Efficiency' : 'Comfort') + (HPe._hcSince ? ' · ' + (HPe._hcSince.first ? 'seit Beobachtung ' : 'seit ') + hcHm(HPe._hcSince.ts) : ''), hcV === 1 ? 'warn' : ''],
    ['Soll-Vorlauf (Heizkurve)', f(target, 0, '°C'), ''],
    ['Verschiebung manuell', f(shiftBase, 0, 'K'), ''],
    ['Korrektur Raumregelung', f(rtcCorr, 0, 'K'), ''],
    ['Verschiebung final', f(shiftFinal, 0, 'K'), ''],
    ['Vorlauf / Rücklauf', f(outl, 1) + ' / ' + f(inl, 1, '°C'), ''],
    ['Verdichter', f(freq, 0, 'Hz'), ''],
    ['Leistung · COP', f(pw, 0, 'W') + ' · ' + (freq > 0 ? f(cop, 1) : '–'), ''],
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
    var ctColdGo = ctColdClear.some(function (i) { return i.x.ema + i.tr < i.x.min; });             // und in 1 h nicht von selbst im Band
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
    global.set('OPT_state', {ts: now, deficit: ctBelow.length > 0, deficitRoom: ctWorst ? ctWorst.x.name : '', coldTrend: ctWorst ? ctWorst.tr : null, distrib: ctDistrib, valid: valids.length, active: ctAct.length});
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
                        'wetter_wind_ms', 'pv_w', 'aussen_t_outside', 't_outside_custom']);
    vals = vals.concat([valids.length, heat ? heat.name : '', heat ? c(heat.dev) : '', over ? over.name : '', over ? c(over.dev) : '', tight ? c(tight.m) : '', tight ? tight.room.name : '',
                        c(target), c(shiftBase), c(rtcCorr), c(shiftFinal), c(outl), c(inl), c(freq), freq > 0 ? 1 : 0,
                        c(pw), c(freq > 0 ? cop : null), defrost ? 1 : 0, valve === 1 ? 1 : 0, ssOn ? 1 : 0, mode, c(num(G('Starts_Today'))),
                        ctRes.on ? 1 : 0, ctRes.cur, ctRes.applied, ctRes.lead, ctRes.distrib ? 1 : 0, String(ctRes.code).replace(/,/g, ';'), ctRes.locks.join(' + ').replace(/,/g, ';'), Math.ceil(ctRes.holdLeft / MS_MIN),
                        c(at1h), c(at24h), c(atSpanH), c(atFc24), c(atCalc), c(sollNow), c(sollCalc), c(shiftEq), ctRes.floorHit ? 1 : 0, hcV === null ? '' : hcV,
                        c(wOk ? W.wind : null), c((G('OPT_plan_in') || {}).ts && now - G('OPT_plan_in').ts < 5 * MS_MIN ? G('OPT_plan_in').pvNow : null), c(num(G('T_outside'))), c(num(G('T_outside_custom')))]);
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
# Seite "Optimierung": nur breite Karten (Diagramme + Raumtabelle); die schmalen Statuskarten liegen auf der Seite "Daten & Güte" (der Masonry-Algorithmus legt gemischte Breiten uebereinander)
UI_TAB_DATA = "opt_ui_tab_data"
upsert({"id": UI_TAB_DATA, "type": "ui_tab", "name": "Daten & Güte", "icon": "analytics", "order": 12.75, "disabled": False, "hidden": False})
GROUPS = [("opt_g_ch_wp", "Wärmepumpe · letzte 24 h", 18, UI_TAB), ("opt_g_ch_rooms", "Räume · letzte 24 h", 18, UI_TAB), ("opt_g_ch_at", "Außentemperatur · letzte 48 h", 18, UI_TAB), ("opt_g_rooms", "Räume und Komfortbänder", 18, UI_TAB),
          ("opt_g_opt", "Optimierung", 6, UI_TAB_DATA),
          ("opt_g_wx", "Außen & Wetter", 6, UI_TAB_DATA), ("opt_g_calc", "Berechnete Außentemperatur", 6, UI_TAB_DATA), ("opt_g_quiet", "Leistung & Quiet (Shadow)", 6, UI_TAB_DATA), ("opt_g_en", "Energie & Preise (nur Anzeige)", 6, UI_TAB_DATA),
          ("opt_g_fq", "Prognosegüte (nur Anzeige)", 6, UI_TAB_DATA), ("opt_g_wp", "Wärmepumpe", 6, UI_TAB_DATA)]
_ord = {}
for gid, gname, gwidth, gtab in GROUPS:
    _ord[gtab] = _ord.get(gtab, 0) + 1
    upsert({"id": gid, "type": "ui_group", "name": gname, "tab": gtab, "order": _ord[gtab], "disp": True,
            "width": gwidth, "collapse": False, "className": ""})

# The heat plan gets its own dashboard page: the dashboard's masonry layout places cards of mixed widths (6/12/18) on top of each other.
UI_TAB_PLAN = "opt_ui_tab_plan"
upsert({"id": UI_TAB_PLAN, "type": "ui_tab", "name": "Wärmefahrplan", "icon": "schedule", "order": 12.6, "disabled": False, "hidden": False})
upsert({"id": "opt_g_plan", "type": "ui_group", "name": "Wärmefahrplan (Shadow)", "tab": UI_TAB_PLAN, "order": 1, "disp": True, "width": 18, "collapse": False, "className": ""})
# same for the Quiet statistics (12 wide table next to tall 6 wide cards was laid out on top of them)
UI_TAB_QUIET = "opt_ui_tab_quiet"
upsert({"id": UI_TAB_QUIET, "type": "ui_tab", "name": "Quiet-Messwerte", "icon": "equalizer", "order": 12.7, "disabled": False, "hidden": False})
upsert({"id": "opt_g_qstats", "type": "ui_group", "name": "Quiet-Stufen: reale Messwerte", "tab": UI_TAB_QUIET, "order": 1, "disp": True, "width": 18, "collapse": False, "className": ""})

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

TABLE = ('<style>.opt td{padding:3px 4px;vertical-align:top} .opt .l{color:#666} .opt .v{text-align:right;font-weight:bold}'
         ' .opt .warn{color:#c62828} .opt .ok{color:#2e7d32}</style>'
         '<div class="optfit"><table class="opt" style="width:100%"><tr ng-repeat="r in msg.payload.rows track by $index">'
         '<td class="l">{{r[0]}}</td><td class="v" ng-class="r[2]">{{r[1]}}</td></tr></table></div>')


def template(i, gid, height, y):
    """Status card: label/value rows; full group width, static start height (units), fits itself to the content."""
    return {"id": i, "type": "ui_template", "z": TAB, "group": gid, "name": "", "order": 1, "width": 0,
            "height": height, "format": TABLE + FIT_JS.replace("__ID__", i), "storeOutMessages": True,
            "fwdInMessages": False, "resendOnRefresh": True, "templateScope": "local", "className": "",
            "x": 1260, "y": y, "wires": [[]]}


upsert(template("opt_t_opt", "opt_g_opt", 6, 140))
upsert(template("opt_t_wx", "opt_g_wx", 7, 200))
upsert(template("opt_t_calc", "opt_g_calc", 8, 230))
_qt = template("opt_t_quiet", "opt_g_quiet", 22, 290)
_qt["format"] = (TABLE.replace('</table></div>', '</table>'
                 '<div class="opt" ng-if="msg.payload.events && msg.payload.events.length" style="margin-top:10px"><div class="l" style="padding:3px 4px;font-size:12px">Letzte Ereignisse</div>'
                 '<div ng-repeat="e in msg.payload.events track by $index" style="padding:3px 4px;border-top:1px solid #eee"><span class="l">{{e[0]}}</span> '
                 '<span ng-class="e[3]" style="font-weight:bold">{{e[1]}}</span><div class="l" style="white-space:normal;word-break:break-word">{{e[2]}}</div></div></div></div>') + FIT_JS.replace("__ID__", "opt_t_quiet"))
upsert(_qt)
upsert(template("opt_t_en", "opt_g_en", 14, 350))
upsert(template("opt_t_fq", "opt_g_fq", 12, 400))
QSTATS = """<style>.optq{width:100%;border-collapse:collapse;font-size:13px}
.optq th{text-align:left;font-weight:normal;color:#666;padding:4px 4px;border-bottom:1px solid #ccc;font-size:12px}
.optq td{padding:5px 4px;border-bottom:1px solid #eee;white-space:nowrap}
.optq-note{font-size:12px;color:#777;padding:6px 2px}</style>
<div class="optfit"><div style="overflow-x:auto"><table class="optq"><tr><th>Stufe</th><th>Außen</th><th>Minuten Lauf</th><th>Ø Hz</th><th>Ø Fan</th><th>Ø P el. (W)</th><th>Ø P th. (W)</th><th>Max Hz</th><th>Max P th. (W, ab 10 min Lauf)</th><th>Ø COP</th>
<th>Ø VL / RL / ΔT (°C)</th><th>Ø Soll VL / RL</th><th>Ø Flow (l/min)</th><th>Starts/h</th><th>Ø Lauf (min)</th><th>Abtauungen</th><th>Komfortdefizit</th></tr>
<tr ng-repeat="r in msg.payload.stats track by $index"><td ng-repeat="c in r track by $index">{{c}}</td></tr></table></div>
<div class="optq-note">Nur Minuten mit laufendem Verdichter, ohne Abtauen und Warmwasser. Die Tabelle füllt sich nur für Stufen, die tatsächlich benutzt werden.</div></div>"""
upsert({"id": "opt_t_qstats", "type": "ui_template", "z": TAB, "group": "opt_g_qstats", "name": "Quiet-Statistik", "order": 1, "width": 0, "height": 4,
        "format": QSTATS + FIT_JS.replace("__ID__", "opt_t_qstats"), "storeOutMessages": True, "fwdInMessages": False, "resendOnRefresh": True,
        "templateScope": "local", "className": "", "x": 1260, "y": 320, "wires": [[]]})
upsert(template("opt_t_wp", "opt_g_wp", 6, 260))
HIST_JS = r"""
// Verlaufsdaten fuer die Diagramme (nur lesen): letzte 48 h aus dem 5-Minuten-Protokoll optimizer-v2-YYYY-MM.csv; Kopfzeilen-Abschnitte werden ueber die Spaltennamen zugeordnet.
// Zeitstempel einmal, Reihen als Zahlenfelder (kleine Nachrichten). Ausgang 1: Waermepumpe 24 h, 2: Raeume 24 h, 3: Aussentemperatur 48 h.
var now = Date.now(), H = 3600000, t0 = now - 48 * H;
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
var r24 = cut(24), r48 = rows;
var wp = {now: now, n: r24.length, t: r24.map(function (r) { return r.t; }), at: col(r24, 'aussen_panasonic', 10), sollVl: col(r24, 'soll_vorlauf', 100), vl: col(r24, 'vorlauf', 100), rl: col(r24, 'ruecklauf', 100), hz: col(r24, 'verdichter_hz', 10), el: col(r24, 'leistung_w', 1)};
var rm = {now: now, n: r24.length, t: wp.t, rooms: rc.map(function (x) { return {id: x.id, name: x.name, min: x.min, max: x.max, active: x.active !== false, v: col(r24, x.id + '_wert', 100)}; })};
var wx = {now: now, n: r48.length, t: r48.map(function (r) { return r.t; }), at: col(r48, 'aussen_panasonic', 10), owm: col(r48, 'aussen_wetter', 10), calc: col(r48, 'aussen_berechnet', 10), wind: col(r48, 'wetter_wind_ms', 10), clouds: col(r48, 'wetter_bewoelkung', 1)};
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
              "    if (!P.n || P.n < 2) { el.innerHTML = '<div style=\"padding:24px;color:#757575\">Noch keine Verlaufsdaten.</div>'; return; }\n"
              + body +
              "    if (spec) { window.optChart.mount(el, spec); }\n"
              "}\n"
              "window.__optChMap = window.__optChMap || {}; window.__optChMap[key] = draw;\n"
              "if (!window.__optChRs) { window.__optChRs = true; var tm = null; window.addEventListener('resize', function () { clearTimeout(tm); tm = setTimeout(function () { Object.keys(window.__optChMap).forEach(function (k) { window.__optChMap[k](); }); }, 200); }); }\n"
              "scope.$watch('msg', function (m) { last = m; setTimeout(draw, 40); });\n"
              "})(scope);</script>")
    return {"id": "opt_t_ch_" + cid, "type": "ui_template", "z": TAB, "group": gid, "name": name, "order": 1, "width": 0, "height": units,
            "format": '<div class="optfit"><div id="optch_' + cid + '" style="min-height:120px"></div></div>' + script + FIT_JS.replace("__ID__", "opt_t_ch_" + cid),
            "storeOutMessages": True, "fwdInMessages": False, "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": y, "wires": [[]]}


CH_WP = (
    "    var t = P.t; spec = {t0: P.now - 24 * H, t1: P.now, panels: [\n"
    "        {h: 170, unit: '°C', series: [\n"
    "            {n: 'Soll-VL', c: '#1565c0', k: 'step', dash: '5 3', w: 1.4, dg: 1, u: '°C', d: pairs(t, P.sollVl)},\n"
    "            {n: 'Ist-VL', c: '#1976d2', k: 'line', dg: 2, u: '°C', d: pairs(t, P.vl)},\n"
    "            {n: 'Rücklauf', c: '#ef6c00', k: 'line', dg: 2, u: '°C', d: pairs(t, P.rl)},\n"
    "            {n: 'Außen (Fühler)', c: '#78909c', k: 'line', w: 1.2, dg: 1, u: '°C', d: pairs(t, P.at)}]},\n"
    "        {h: 90, unit: 'Hz', zero: true, runit: 'W', rzero: true, series: [\n"
    "            {n: 'Verdichter', c: '#00897b', k: 'area', dg: 0, u: 'Hz', d: pairs(t, P.hz)},\n"
    "            {n: 'Strom', c: '#6a1b9a', k: 'line', w: 1.2, r: true, dg: 0, u: 'W', d: pairs(t, P.el)}]}]};\n")
CH_ROOMS = (
    "    var t = P.t, cols = ['#1976d2', '#43a047', '#8e24aa', '#ef6c00', '#00838f', '#6d4c41'], ser = [], bands = [];\n"
    "    P.rooms.forEach(function (r, i) { if (!r.active) { return; } var c = cols[i % cols.length]; ser.push({n: r.name + ' (' + String(r.min).replace('.', ',') + '–' + String(r.max).replace('.', ',') + ')', c: c, k: 'line', w: 1.8, dg: 2, u: '°C', d: pairs(t, r.v)}); bands.push({a: r.min, b: r.max, c: c.replace('#', '') && 'rgba(' + parseInt(c.slice(1, 3), 16) + ',' + parseInt(c.slice(3, 5), 16) + ',' + parseInt(c.slice(5, 7), 16) + ',0.07)'}); });\n"
    "    spec = {t0: P.now - 24 * H, t1: P.now, panels: [{h: 230, unit: '°C', bands: bands, series: ser}]};\n")
CH_AT = (
    "    var t = P.t; spec = {t0: P.now - 48 * H, t1: P.now, panels: [\n"
    "        {h: 170, unit: '°C', series: [\n"
    "            {n: 'Fühler (Regelwert)', c: '#37474f', k: 'line', w: 1.8, dg: 1, u: '°C', d: pairs(t, P.at)},\n"
    "            {n: 'Wetterdienst (OWM)', c: '#ef6c00', k: 'line', dg: 1, u: '°C', d: pairs(t, P.owm)},\n"
    "            {n: 'berechnet', c: '#1976d2', k: 'line', dash: '5 3', w: 1.4, dg: 1, u: '°C', d: pairs(t, P.calc)}]},\n"
    "        {h: 80, unit: 'm/s', zero: true, runit: '%', rmin: 0, rmax: 100, series: [\n"
    "            {n: 'Bewölkung', c: '#b0bec5', k: 'area', r: true, dg: 0, u: '%', d: pairs(t, P.clouds)},\n"
    "            {n: 'Wind', c: '#00897b', k: 'line', w: 1.4, dg: 1, u: 'm/s', d: pairs(t, P.wind)}]}]};\n")
upsert(chart_card("wp", "opt_g_ch_wp", "Verlauf Wärmepumpe", 9, 520, CH_WP))
upsert(chart_card("rooms", "opt_g_ch_rooms", "Verlauf Räume", 7, 560, CH_ROOMS))
upsert(chart_card("at", "opt_g_ch_at", "Verlauf Außentemperatur", 8, 600, CH_AT))
upsert(fn("opt_hist", "Verlaufsdaten (nur lesen)", HIST_JS, 3, [["opt_t_ch_wp"], ["opt_t_ch_rooms"], ["opt_t_ch_at"]], 440, 520, FS))
upsert(inject("opt_i_hist", "alle 5 Minuten", 300, 20, ["opt_hist"], 140, 520))

PLAN_TPL = """<style>
.optp{font-size:14px;line-height:1.4}
.optp .kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:10px;margin:2px 0 14px}
.optp .tile{border:1px solid #e0e0e0;border-radius:6px;padding:8px 10px;background:#fafafa}
.optp .tile .k{font-size:11px;color:#757575;text-transform:uppercase;letter-spacing:.03em}
.optp .tile .v{font-size:19px;font-weight:600;color:#263238;white-space:nowrap}
.optp .tile .s{font-size:12px;color:#757575;min-height:16px}
.optp .sec{margin:16px 0 6px;font-size:13px;color:#546e7a;font-weight:600}
.optp .sum{display:grid;grid-template-columns:max-content 1fr;gap:3px 16px;margin:2px 0 6px}
.optp .sum .k{color:#666}
.optp .sum .v{font-weight:bold}
.optp .warn{color:#c62828}
.optp .ok{color:#2e7d32}
.optp table{width:100%;border-collapse:collapse;font-size:13px}
.optp th{text-align:right;font-weight:normal;color:#666;padding:4px 6px;border-bottom:1px solid #ccc;font-size:12px;line-height:1.25;vertical-align:bottom}
.optp td{padding:4px 6px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap}
.optp th:first-child,.optp td:first-child{text-align:left}
.optp tr.up td.r{color:#2e7d32;font-weight:bold}
.optp tr.down td.r{color:#e65100;font-weight:bold}
</style>
<div class="optp optfit">
<div class="kpi"><div class="tile" ng-repeat="t in msg.payload.kpi track by $index"><div class="k">{{t.k}}</div><div class="v">{{t.v}}</div><div class="s">{{t.s}}</div></div></div>
<div id="optch_plan" style="min-height:120px"></div>
<div class="sec">Stundenübersicht</div>
<div style="overflow-x:auto"><table>
<tr><th>Ab</th><th>Bedarf → Plan kWh</th><th>COP</th><th>Feuchte · Taupunkt</th><th>Preis ct/kWh</th><th>Kosten ct/kWh Wärme</th><th>PV W</th><th>Defrost</th><th>Vertrauen</th><th>Attraktivität</th><th>Empfehlung</th><th>Offset</th><th>Quiet</th></tr>
<tr ng-repeat="r in msg.payload.plan track by $index" ng-class="r.cls"><td>{{r.z}}</td><td>{{r.b}} → {{r.p}}</td><td>{{r.cop}}</td><td>{{r.h}}</td><td>{{r.pr}}</td><td>{{r.k}}</td><td>{{r.pv}}</td><td>{{r.d}}</td><td>{{r.v}}</td><td>{{r.a}}</td><td class="r">{{r.r}}</td><td>{{r.o}}</td><td>{{r.q}}</td></tr>
</table></div>
<div class="sec" style="cursor:pointer" ng-click="plOpen = !plOpen">Details und Modell {{plOpen ? '▾' : '▸'}}</div>
<div class="sum" ng-if="plOpen"><span ng-repeat-start="r in msg.payload.rows track by $index" class="k">{{r[0]}}</span><span ng-repeat-end class="v" ng-class="r[2]">{{r[1]}}</span></div>
</div>"""
PLAN_CH_JS = ("<script>" + UI_CHART_JS + "</script><script>(function (scope) {\n"
    "var last = null;\n"
    "function draw() {\n"
    "    var el = document.getElementById('optch_plan'), m = last;\n"
    "    if (!el || !m || !m.payload || !m.payload.chart || !window.optChart) { return; }\n"
    "    var S = m.payload.chart.slots, Q = 900000, t0 = S[0][0], t1 = S[S.length - 1][0] + Q, i, col = function (r) { return r[8] === 1 ? '#2e7d32' : (r[8] === -1 ? '#ef6c00' : '#1976d2'); };\n"
    "    var spec = {t0: t0, t1: t1, panels: [\n"
    "        {h: 150, unit: 'kW', zero: true, series: [\n"
    "            {n: 'Bedarf (normal)', c: '#b0bec5', k: 'bar', bw: Q, bf: 0.95, dg: 2, u: 'kW', d: S.map(function (r) { return [r[0], r[1]]; })},\n"
    "            {n: 'Plan (grün vorziehen · orange verschieben)', c: '#1976d2', k: 'bar', bw: Q, bf: 0.55, op: 0.95, dg: 2, u: 'kW', d: S.map(function (r) { return [r[0], r[2]]; }), bc: S.map(function (r) { return [r[0], col(r)]; })}]},\n"
    "        {h: 90, unit: 'ct/kWh', zero: true, runit: 'W', rzero: true, series: [\n"
    "            {n: 'PV-Prognose', c: '#fbc02d', k: 'area', r: true, dg: 0, u: 'W', d: S.map(function (r) { return [r[0], r[4]]; })},\n"
    "            {n: 'Strompreis', c: '#ef6c00', k: 'step', w: 1.8, dg: 1, u: 'ct/kWh', d: S.map(function (r) { return [r[0], r[3]]; })}]},\n"
    "        {h: 90, unit: '°C', runit: 'COP', rzero: false, series: [\n"
    "            {n: 'Außen (Plan)', c: '#37474f', k: 'line', w: 1.6, dg: 1, u: '°C', d: S.map(function (r) { return [r[0], r[6]]; })},\n"
    "            {n: 'Außen (Fühler-korrigiert)', c: '#1976d2', k: 'line', dash: '5 3', w: 1.4, dg: 1, u: '°C', d: S.map(function (r) { return [r[0], r[7]]; })},\n"
    "            {n: 'COP', c: '#00897b', k: 'line', w: 1.4, r: true, dg: 1, u: '', d: S.map(function (r) { return [r[0], r[5]]; })}]}]};\n"
    "    window.optChart.mount(el, spec);\n"
    "}\n"
    "window.__optChMap = window.__optChMap || {}; window.__optChMap.plan = draw;\n"
    "if (!window.__optChRs) { window.__optChRs = true; var tm = null; window.addEventListener('resize', function () { clearTimeout(tm); tm = setTimeout(function () { Object.keys(window.__optChMap).forEach(function (k) { window.__optChMap[k](); }); }, 200); }); }\n"
    "scope.$watch('msg', function (m) { last = m; setTimeout(draw, 40); });\n"
    "})(scope);</script>")
upsert({"id": "opt_t_plan", "type": "ui_template", "z": TAB, "group": "opt_g_plan", "name": "Wärmefahrplan", "order": 1, "width": 0, "height": 21,
        "format": PLAN_TPL + PLAN_CH_JS + FIT_JS.replace("__ID__", "opt_t_plan"), "storeOutMessages": True, "fwdInMessages": False, "resendOnRefresh": True,
        "templateScope": "local", "className": "", "x": 1260, "y": 440, "wires": [[]]})


def room_input(field):
    """Number input of one room setting; the change is sent to opt_set as "room:<id>:<field>"."""
    _f, lo, hi, step, tip = next(x for x in ROOM_FIELDS if x[0] == field)
    return ('<input type="number" ng-model="r.%s" ng-model-options="{updateOn: \'change blur\'}" ng-focus="edit()" ng-blur="done()" '
            'ng-change="set(r, \'%s\', r.%s)" min="%s" max="%s" step="%s" title="%s">' % (field, field, field, lo, hi, step, tip))


# room card: summary, situation per room, settings per room (inputs write back through scope.send -> opt_set)
ROOMS_TPL = """<style>
.optr{font-size:14px;line-height:1.4}
.optr .sum{display:grid;grid-template-columns:max-content 1fr;gap:3px 16px;margin:2px 0 14px}
.optr .k{color:#666}
.optr .warn{color:#c62828;font-weight:bold}
.optr .ok{color:#2e7d32;font-weight:bold}
.optr .mute{color:#999}
.optr .sec{margin:18px 0 2px;color:#666;font-size:13px}
.optr table{width:100%;border-collapse:collapse}
.optr th{text-align:left;font-weight:normal;color:#666;font-size:12px;padding:4px 6px;border-bottom:1px solid #ccc}
.optr td{padding:6px;border-bottom:1px solid #eee;vertical-align:middle}
.optr .n{text-align:right;white-space:nowrap}
.optr .role{display:block;font-size:12px;color:#c62828}
.optr input[type=number]{width:64px;padding:3px 4px;font:inherit;text-align:right;border:1px solid #bbb;border-radius:3px;background:transparent;color:inherit}
.optr input[type=checkbox]{width:18px;height:18px;vertical-align:middle}
.optr .note{margin-top:6px;font-size:12px;color:#777}
/* on narrow screens the 12-unit card would be wider than the screen: fit it, the tables scroll inside */
@media (max-width:700px){ui-card-panel:has(.optr),.nr-dashboard-cardpanel:has(.optr),.nr-dashboard-cardcontainer:has(.optr),md-card.nr-dashboard-template:has(.optr){width:100% !important;min-width:0 !important;max-width:100% !important}}
</style>
<div class="optr optfit" ng-if="d">
<div class="sum">
<span class="k">Raum unter Minimum</span><span ng-class="d.sum.heatCls">{{d.sum.heat}}</span>
<span class="k">Raum über Maximum</span><span ng-class="d.sum.overCls">{{d.sum.over}}</span>
<span class="k">Geringster Abstand</span><span ng-class="d.sum.tightCls">{{d.sum.tight}}</span>
<span class="k">Gültige Räume</span><span ng-class="d.sum.validCls">{{d.sum.valid}}</span>
</div>
<div style="overflow-x:auto"><table>
<tr><th>Raum</th><th class="n">Ist</th><th class="n">Komfortband</th><th class="n">Abstand unten</th><th class="n">Abstand oben</th><th>Trend</th><th>Gültig</th></tr>
<tr ng-repeat="r in d.rooms track by r.id">
<td>{{r.name}}<span class="role" ng-if="r.role==='heat'">größte Unterschreitung</span><span class="role" ng-if="r.role==='over'">größte Überschreitung</span></td>
<td class="n" ng-class="r.cls">{{r.ist}}</td><td class="n">{{r.band}}</td>
<td class="n" ng-class="r.cLow">{{r.dLow}}</td><td class="n" ng-class="r.cHigh">{{r.dHigh}}</td>
<td>{{r.trend}}</td><td ng-class="r.cls==='mute' ? 'mute' : ''">{{r.valid}}</td></tr>
</table></div>
<div class="note">Abstand: positiv = noch Luft bis zur Grenze, negativ = Grenze verletzt. Jeder Raum wird nach seinem eigenen Band bewertet.</div>
<div class="sec">Einstellungen je Raum</div>
<div style="overflow-x:auto"><table>
<tr><th>Raum</th><th>Aktiv</th><th class="n">Minimum °C</th><th class="n">Maximum °C</th><th class="n">Gewichtung</th><th class="n">Datenalter-Limit (min)</th></tr>
<tr ng-repeat="r in d.rooms track by r.id"><td>{{r.name}}</td>
<td><input type="checkbox" ng-model="r.on" ng-change="set(r, 'active', r.on)"></td>
<td class="n">__IN_min__</td><td class="n">__IN_max__</td><td class="n">__IN_weight__</td><td class="n">__IN_maxAgeMin__</td></tr>
</table></div>
<div class="note">Änderungen gelten, sobald das Feld verlassen wird. Inaktive Räume werden nur angezeigt, nicht bewertet. Die Gewichtung ist ein Faktor für die Abweichung und entscheidet bei mehreren Verstößen, welcher Raum maßgeblich ist.</div>
<div class="sec">Vorschlag für die Heizkurve (nur Anzeige, greift nicht ein)</div>
<div class="sum" ng-if="d.ctl">
<span class="k">Stand</span><span ng-class="d.ctl.statusCls">{{d.ctl.status}}</span>
<span class="k">Führungsraum</span><span>{{d.ctl.lead}}</span>
<span class="k">Grund</span><span ng-class="d.ctl.distrib ? 'warn' : ''">{{d.ctl.why}}</span>
<span class="k">Nächste Änderung</span><span>{{d.ctl.next}}</span>
</div>
<div class="note">Regeln: 1. Ein Raum unter seinem Minimum: nie absenken, der Raum mit dem größten Defizit führt, langsam höchstens +1 K. 2. Kein Raum unter Minimum, aber einer über Maximum: Absenkung erlaubt, zunächst -1 K. 3. Alle im Band: niedrigste Heizkurve suchen (0 K oder vorsichtig -1 K testen). 4. Gleichzeitig deutlich zu kalt und zu warm: Wärmeverteilungsproblem, die Heizkurve bleibt unverändert. Der Soll-Vorlauf wird nie unter die Untergrenze von 29 °C gesenkt (Heizkörper). Jede Änderung nur nach der Mindesthaltezeit und nie bei Abtauen, Warmwasser, Verdichterstart oder Sanftanlauf. Der Vorschlag steht im Protokoll (korrektur_vorschlag).</div>
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
        "width": 0, "height": 15, "format": ROOMS_TPL + FIT_JS.replace("__ID__", "opt_t_rooms"), "storeOutMessages": True, "fwdInMessages": False,
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

upsert(comment("opt_c4", "Auswertung jede Minute → Anzeige + Protokoll (CSV in /data/optimizer)", 380, 700))
upsert(inject("opt_i_tick", "jede Minute", 60, 15, ["opt_eval"], 140, 760))
upsert(fn("opt_eval", "Auswerten · Anzeigen · Protokollieren", EVAL_JS, 9,
          [["opt_t_wx"], ["opt_t_rooms"], ["opt_t_wp"], ["opt_t_opt"], ["opt_f_log"], ["opt_f_ev"], ["opt_ui_wxstatus"], ["opt_t_calc"], ["opt_quiet"]], 420, 760, FS))

# ---------------------------------------------------------------- phase 4 (shadow): quiet recommendation; READ ONLY, there is no mqtt out in this tab
upsert(comment("opt_c5", "Quiet-Empfehlung (Shadow): Anlagenwerte nur lesen, Stufe NICHT schalten", 380, 1060))
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
upsert(fn("opt_quiet", "Quiet-Empfehlung (Shadow)", QUIET_JS, 5, [["opt_t_quiet"], ["opt_t_qstats"], ["opt_f_quiet"], ["opt_f_qev"], ["opt_f_def"]], 700, 1060, FS))
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
upsert(fn("opt_plan", "Wärmefahrplan berechnen (Shadow)", PLAN_JS, 5, [["opt_t_plan"], ["opt_f_pact"], ["opt_f_peval"], ["opt_f_psnap"], []], 440, 1800, FS))
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

# the new page also belongs into the menu configuration (SYSTEM > menu), otherwise it can not be hidden/shown there
form = B.get("e35b7df78bc6f722")
if form and not any(o["value"] == "Optimierung" for o in form["options"]):
    form["options"].append({"label": "OPTIMIERUNG", "value": "Optimierung", "type": "checkbox", "required": False, "rows": None})
    form["formValue"]["Optimierung"] = False

json.dump(flows, open(path, "w", encoding="utf-8"), indent=4, ensure_ascii=False)
print("ok")

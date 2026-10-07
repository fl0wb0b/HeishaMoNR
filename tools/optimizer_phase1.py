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


def js(code):
    """Fill the shared constants into a JS block."""
    return (code.replace("__ROOMS__", json.dumps(ROOMS, ensure_ascii=False))
                .replace("__LIMITS__", json.dumps(LIMITS))
                .replace("__MINBAND__", str(MIN_BAND_K)))


# ---------------------------------------------------------------- defaults / configuration
DEFAULTS_JS = r"""
// Standardwerte der Optimierungsebene. Gespeicherte Einstellungen (config.json) und bereits gesetzte Werte bleiben erhalten.
// Jeder Raum hat ein eigenes Komfortband (min/max), eine Gewichtung und ein Datenalter-Limit.
var ROOM_FIELDS = ['active', 'min', 'max', 'weight', 'maxAgeMin'];
var d = {
    rooms: __ROOMS__,
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
var cfg = merge(merge(d, saved), cur);
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
    fs.mkdirSync('/data/optimizer', {recursive: true});
    fs.writeFileSync('/data/optimizer/config.json', JSON.stringify(cfg, null, 1));
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
// OpenWeatherMap abrufen (Free-Tarif: aktuelles Wetter + 3-Stunden-Vorhersage). Ohne Schluessel/Standort passiert nichts.
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
node.send({topic: 'forecast', url: base + 'forecast' + q + '&cnt=4'});
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
    var pts = (fresh ? [{t: now, v: W.temp, h: W.rh, c: W.clouds}] : []).concat(p.list.map(function (e) {
        return {t: e.dt * 1000, v: e.main.temp, h: e.main.humidity, c: e.clouds ? e.clouds.all : null};
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

EVAL_JS = r"""
// Einmal pro Minute: Werte zusammenfuehren, bewerten, anzeigen und protokollieren. KEIN Eingriff in die Regelung.
// Raeume werden nach der Abweichung vom EIGENEN Komfortband bewertet, nicht nach der absoluten Temperatur:
// unter dem Minimum negativ (Heizbedarf), im Band 0, ueber dem Maximum positiv (Ueberschreitung).
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var now = Date.now();
var R = global.get('OPT_rooms') || {};
var W = global.get('OPT_weather') || {};
var G = function (k) { return global.get(k); };

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
    over: none ? '–' : (over ? over.name + ' · ' + f(over.dev, 1, 'K') + ' über Maximum · ' + trTxt(over) : 'keine'),
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

// ---------- Waermepumpe
var freq = num(G('compressor_frequency')) || 0, valve = num(G('TOP20_ThreeWay_Valve_State')), defrost = num(G('TOP26_Defrosting_State')) === 1;
var ss = G('F_SS'), ssOn = ss && ss.state === 1;
var pOn = num(G('TOP0_Heatpump_State')) === 1;
var mode = !pOn ? 'Aus' : (defrost ? 'Abtauen' : (valve === 1 ? 'Warmwasser' : (freq > 0 ? 'Heizen' : 'Bereit')));
var shiftBase = null, ccc = G('F_CCC'); if (ccc && ccc.z1) { shiftBase = num(ccc.z1.SP_DIRECT_virt); }
var rtc = G('F_RTC'), rtcCorr = (rtc && rtc.z1) ? num(rtc.z1.correction_value) : null;
var shiftFinal = num(G('SHIFT_Final')), target = num(G('TOP42_Z1_Water_Target_Temp'));
var inl = num(G('TOP5_Main_Inlet_Temp')), outl = num(G('TOP6_Main_Outlet_Temp')), pw = num(G('TOP16_Heat_Energy_Consumption')), cop = num(G('COP_HEAT'));
var rowsWp = [
    ['Betriebszustand', mode + (ssOn ? ' · Sanftanlauf' : ''), ''],
    ['Soll-Vorlauf (Heizkurve)', f(target, 0, '°C'), ''],
    ['Verschiebung manuell', f(shiftBase, 0, 'K'), ''],
    ['Korrektur Raumregelung', f(rtcCorr, 0, 'K'), ''],
    ['Verschiebung final', f(shiftFinal, 0, 'K'), ''],
    ['Vorlauf / Rücklauf', f(outl, 1) + ' / ' + f(inl, 1, '°C'), ''],
    ['Verdichter', f(freq, 0, 'Hz'), ''],
    ['Leistung · COP', f(pw, 0, 'W') + ' · ' + (freq > 0 ? f(cop, 1) : '–'), ''],
    ['Starts heute', f(num(G('Starts_Today')), 0), '']
];

// ---------- Optimierung (Phase 1: nur Beobachtung)
var reason;
if (none) { reason = 'keine gültigen Raumdaten'; }
else if (heat && over) { reason = 'Zielkonflikt: ' + heat.name + ' zu kalt, ' + over.name + ' zu warm'; }
else if (heat) { reason = heat.name + ' zu kalt (' + f(-heat.dev, 1, 'K') + ' unter Minimum)'; }
else if (over) { reason = over.name + ' zu warm (' + f(over.dev, 1, 'K') + ' über Maximum)'; }
else { reason = 'alle gültigen Räume im eigenen Komfortband'; }

var out = [{payload: {rows: rowsWx}}, {payload: {sum: sum, rooms: roomsOut}}, {payload: {rows: rowsWp}}, null, null, null, null];

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
                        'leistung_w', 'cop', 'defrost', 'warmwasser', 'sanftanlauf', 'zustand', 'starts_heute']);
    vals = vals.concat([valids.length, heat ? heat.name : '', heat ? c(heat.dev) : '', over ? over.name : '', over ? c(over.dev) : '', tight ? c(tight.m) : '', tight ? tight.room.name : '',
                        c(target), c(shiftBase), c(rtcCorr), c(shiftFinal), c(outl), c(inl), c(freq), freq > 0 ? 1 : 0,
                        c(pw), c(freq > 0 ? cop : null), defrost ? 1 : 0, valve === 1 ? 1 : 0, ssOn ? 1 : 0, mode, c(num(G('Starts_Today')))]);
    var logFile = '/data/optimizer/optimizer-v2-' + month + '.csv', headLine = cols.join(',');
    out[4] = {filename: logFile, payload: (headerNeeded('logHead', logFile, headLine) ? headLine + '\n' : '') + vals.join(',') + '\n'};
    flow.set('lastLog', now);
    lastLog = now;
}
var rowsOpt = [
    ['Modus', 'Beobachtung, kein Eingriff', 'ok'],
    ['Bewertung', reason, ''],
    ['Korrektur', '0 K (nicht aktiv)', ''],
    ['Protokoll', lastLog ? 'letzter Eintrag ' + new Date(lastLog).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'}) : 'noch kein Eintrag', '']
];
out[3] = {payload: {rows: rowsOpt}};

// Zustandswechsel als Ereignisse (fuer die spaetere Auswertung)
var prev = flow.get('prevState') || {};
var cur = {verdichter: freq > 0 ? 1 : 0, defrost: defrost ? 1 : 0, warmwasser: valve === 1 ? 1 : 0, sanftanlauf: ssOn ? 1 : 0,
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
# one wide card for the rooms (situation + settings), three slim status cards next to it; templates: width 0 = group width
GROUPS = [("opt_g_rooms", "Räume und Komfortbänder", 12), ("opt_g_opt", "Optimierung", 6),
          ("opt_g_wx", "Außen & Wetter", 6), ("opt_g_wp", "Wärmepumpe", 6)]
for _order, (gid, gname, gwidth) in enumerate(GROUPS, 1):
    upsert({"id": gid, "type": "ui_group", "name": gname, "tab": UI_TAB, "order": _order, "disp": True,
            "width": gwidth, "collapse": False, "className": ""})

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
            ctrl.refreshLayout(function () { if (mas) { mas.refreshLayout(); } });
        } catch (e) { /* the card keeps its configured height */ }
    }
    reg.fns[id] = fit;
    if (!reg.timer) { reg.timer = setInterval(function () { if (document.visibilityState === 'visible') { Object.keys(reg.fns).forEach(function (k) { reg.fns[k](); }); } }, 1500); }
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


upsert(template("opt_t_opt", "opt_g_opt", 4, 140))
upsert(template("opt_t_wx", "opt_g_wx", 7, 200))
upsert(template("opt_t_wp", "opt_g_wp", 6, 260))


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
<span class="k">Heizbedarf</span><span ng-class="d.sum.heatCls">{{d.sum.heat}}</span>
<span class="k">Überschreitung</span><span ng-class="d.sum.overCls">{{d.sum.over}}</span>
<span class="k">Geringster Abstand</span><span ng-class="d.sum.tightCls">{{d.sum.tight}}</span>
<span class="k">Gültige Räume</span><span ng-class="d.sum.validCls">{{d.sum.valid}}</span>
</div>
<div style="overflow-x:auto"><table>
<tr><th>Raum</th><th class="n">Ist</th><th class="n">Komfortband</th><th class="n">Abstand unten</th><th class="n">Abstand oben</th><th>Trend</th><th>Gültig</th></tr>
<tr ng-repeat="r in d.rooms track by r.id">
<td>{{r.name}}<span class="role" ng-if="r.role==='heat'">bestimmt den Heizbedarf</span><span class="role" ng-if="r.role==='over'">bestimmt die Überschreitung</span></td>
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
        "width": 0, "height": 12, "format": ROOMS_TPL + FIT_JS.replace("__ID__", "opt_t_rooms"), "storeOutMessages": True, "fwdInMessages": False,
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
upsert(fn("opt_eval", "Auswerten · Anzeigen · Protokollieren", EVAL_JS, 7,
          [["opt_t_wx"], ["opt_t_rooms"], ["opt_t_wp"], ["opt_t_opt"], ["opt_f_log"], ["opt_f_ev"], ["opt_ui_wxstatus"]], 420, 760, FS))
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
_OLD = ["opt_ui_ctl", "opt_ui_wait", "opt_n_low", "opt_n_high", "opt_n_age", "opt_g_room", "opt_g_roomdetail", "opt_t_room", "opt_t_roomdetail"]
_OLD += [i for i in B if i.startswith(("opt_w_", "opt_g_cfg_"))]           # per-room inputs and groups of the earlier layout
for _rid in _OLD:
    if _rid in B:
        flows.remove(B.pop(_rid))
upsert(fn("opt_owm_save", "Zugangsdaten speichern", OWM_SAVE_JS, 4,
          [["opt_ui_form"], ["opt_ui_toast"], ["opt_owm_req"], ["opt_ui_wxstatus"]], 1100, 960, FS))

# the new page also belongs into the menu configuration (SYSTEM > menu), otherwise it can not be hidden/shown there
form = B.get("e35b7df78bc6f722")
if form and not any(o["value"] == "Optimierung" for o in form["options"]):
    form["options"].append({"label": "OPTIMIERUNG", "value": "Optimierung", "type": "checkbox", "required": False, "rows": None})
    form["formValue"]["Optimierung"] = False

json.dump(flows, open(path, "w", encoding="utf-8"), indent=4, ensure_ascii=False)
print("ok")

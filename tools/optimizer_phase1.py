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
# absolute temperature. Single source for the defaults function, the input validation and the dashboard widgets.
ROOMS = [
    {"id": "ki_oben", "name": "Kinderzimmer oben", "topic": "shellyhtg3-lucas/status/temperature:0",
     "active": True, "min": 22.5, "max": 23.5, "weight": 1, "maxAgeMin": 90},
    {"id": "ki_unten", "name": "Kinderzimmer unten", "topic": "shellyhtg3-lina/status/temperature:0",
     "active": True, "min": 22.5, "max": 23.5, "weight": 1, "maxAgeMin": 90},
    {"id": "schlaf", "name": "Schlafzimmer", "topic": "shellies/shellyht-Schlaf/sensor/temperature",
     "active": True, "min": 19, "max": 21, "weight": 1, "maxAgeMin": 90},
]
# numeric dashboard settings per room: (field, label, lowest, highest, step, tooltip); "active" is a switch
ROOM_FIELDS = [
    ("min", "Komfort-Minimum (°C)", 10, 30, 0.5, "Darunter braucht der Raum Wärme."),
    ("max", "Komfort-Maximum (°C)", 12, 35, 0.5, "Darüber ist der Raum zu warm."),
    ("weight", "Gewichtung", 0.1, 5, 0.1,
     "Faktor für die Abweichung vom Band. Ein höherer Wert macht den Raum bei der Wahl des maßgeblichen Raums wichtiger."),
    ("maxAgeMin", "Datenalter-Limit (min)", 5, 720, 5, "Ältere Sensorwerte zählen für die Optimierung nicht mehr."),
]
LIMITS = {f: [lo, hi] for f, _label, lo, hi, _step, _tip in ROOM_FIELDS}
WIDGETS = [[f"opt_w_{r['id']}_{f}", r["id"], f] for r in ROOMS for f in ["active"] + [x[0] for x in ROOM_FIELDS]]
MIN_BAND_K = 0.5


def js(code):
    """Fill the shared constants into a JS block."""
    return (code.replace("__ROOMS__", json.dumps(ROOMS, ensure_ascii=False))
                .replace("__WIDGETS__", json.dumps(WIDGETS, ensure_ascii=False))
                .replace("__LIMITS__", json.dumps(LIMITS))
                .replace("__MINBAND__", str(MIN_BAND_K)))


# ---------------------------------------------------------------- defaults / configuration
DEFAULTS_JS = r"""
// Standardwerte der Optimierungsebene. Gespeicherte Einstellungen (config.json) und bereits gesetzte Werte bleiben erhalten.
// Jeder Raum hat ein eigenes Komfortband (min/max), eine Gewichtung und ein Datenalter-Limit.
var ROOM_FIELDS = ['active', 'min', 'max', 'weight', 'maxAgeMin'];
var WIDGETS = __WIDGETS__;                  // [Widget-Id, Raum-Id, Feld]: je Dashboard-Eingabefeld ein Ausgang
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
// aktuelle Werte an die Dashboard-Eingabefelder geben (ein Ausgang je Feld)
return WIDGETS.map(function (w) {
    var r = cfg.rooms.find(function (x) { return x.id === w[1]; });
    if (!r || r[w[2]] === undefined) { return null; }
    return {payload: w[2] === 'active' ? r.active !== false : r[w[2]]};
});
"""

SET_CFG_JS = r"""
// Dashboard-Eingaben -> Konfiguration. msg.topic = "room:<id>:<feld>" (active, min, max, weight, maxAgeMin) oder "gruppe.feld".
// Ausgang 1: rote Rueckmeldung bei abgelehnter Eingabe. Ausgang 2: Eingabefelder auf die gueltigen Werte setzen
// (nach abgelehnter Eingabe und nach dem Umschalten von "Aktiv": der Schalter aendert sich nur ueber diese Nachricht).
// Ausgang 3: nach jeder uebernommenen Aenderung sofort neu auswerten, damit die Anzeige gleich nachzieht.
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var LIMITS = __LIMITS__, MIN_BAND = __MINBAND__;
var t = String(msg.topic || ''), v = msg.payload, refresh = false;
function de(x) { return String(x).replace('.', ','); }
function reject(text) { return [{topic: 'Optimierung', payload: text, highlight: 'red'}, {payload: 'zuruecksetzen'}]; }
if (t.indexOf('room:') === 0) {
    var p = t.split(':');
    var room = (cfg.rooms || []).find(function (r) { return r.id === p[1]; });
    if (!room) { return null; }
    if (p[2] === 'active') {
        room.active = (v === true || v === 'true' || v === 1);
        refresh = true;
    } else {
        var lim = LIMITS[p[2]];
        if (!lim) { return null; }
        var n = (v === null || v === '' || typeof v === 'boolean') ? NaN : Number(v);
        if (!isFinite(n) || n < lim[0] || n > lim[1]) {
            return reject(room.name + ': Der Wert muss zwischen ' + de(lim[0]) + ' und ' + de(lim[1]) + ' liegen. Nichts geändert.');
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
return [null, refresh ? {payload: 'aktualisieren'} : null, {payload: 'auswerten'}];
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
    var x = {id: rc.id, name: rc.name, active: rc.active !== false && band, hasData: (r.ema !== undefined && a !== null), age: a, lim: lim,
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
var rowsRoom = [
    ['Heizbedarf (maßgeblicher Raum)', none ? '–' : (heat ? heat.name + ' · ' + f(-heat.dev, 1, 'K') + ' unter Minimum · ' + trTxt(heat) : 'keiner'), none || heat ? 'warn' : 'ok'],
    ['Überschreitung (maßgeblicher Raum)', none ? '–' : (over ? over.name + ' · ' + f(over.dev, 1, 'K') + ' über Maximum · ' + trTxt(over) : 'keine'), none || over ? 'warn' : 'ok'],
    ['Geringster Abstand zur Grenze', tight ? sg(tight.m, 1, 'K') + ' (' + tight.room.name + ')' : '–', tight && tight.m < 0.3 ? 'warn' : ''],
    ['Gültig für die Optimierung', valids.length + ' von ' + nActive + ' aktiven Räumen' + (nActive < rooms.length ? ' · ' + (rooms.length - nActive) + ' inaktiv' : ''), valids.length < nActive ? 'warn' : '']
];
var detail = rooms.map(function (x) {
    var why = !x.active ? 'nein (inaktiv)' : (!x.hasData ? 'nein (keine Daten)' : (!x.valid ? 'nein (veraltet, Limit ' + age(x.lim) + ')' : 'ja'));
    var role = (x === heat) ? 'Heizbedarf' : ((x === over) ? 'Überschreitung' : '');
    return [x.name, x.hasData ? f(x.ema, 1, '°C') : '–', f(x.min, 1) + ' – ' + f(x.max, 1, '°C'),
            x.hasData ? sg(x.dLow, 1, 'K') : '–', x.hasData ? sg(x.dHigh, 1, 'K') : '–', x.hasData ? (x.trend === null ? 'n. v.' : trTxt(x)) : '–',
            why + (x.hasData ? ' · ' + age(x.age) : ''), role, !x.valid ? 'mute' : (x.dev !== 0 ? 'warn' : 'ok')];
});

// ---------- Aussen / Wetter
var tp = num(G('TOP14_Outside_Temp')), tw = (W.ts && ageMin(W.ts) <= cfg.weather.maxAgeMin) ? W.temp : null;
var wAge = ageMin(W.ts), wOk = (W.status === 'OK' && wAge !== null && wAge <= cfg.weather.maxAgeMin);
var rowsWx = [
    ['Außen Panasonic', f(tp, 1, '°C'), ''],
    ['Außen Wetterdienst', tw !== null ? f(tw, 1, '°C') : '–', ''],
    ['Differenz Wetter − Panasonic', (tw !== null && tp !== null) ? sg(tw - tp, 1, 'K') : '–', ''],
    ['Prognose +1 h', wOk ? f(W.f1, 1, '°C') : '–', ''],
    ['Prognose +3 h', wOk ? f(W.f3, 1, '°C') : '–', ''],
    ['Prognose +6 h', wOk ? f(W.f6, 1, '°C') : '–', ''],
    ['Luftfeuchtigkeit', wOk ? f(W.rh, 0, '%') : '–', ''],
    ['Taupunkt', wOk ? f(W.dew, 1, '°C') : '–', ''],
    ['Bewölkung', (wOk && W.clouds !== null && W.clouds !== undefined) ? f(W.clouds, 0, '%') : '–', ''],
    ['Wetterdaten', (W.status || 'noch nicht abgerufen') + (wAge !== null ? ' · Alter ' + age(wAge) : ''), wOk ? 'ok' : ''],
    ['Regelwert Außentemperatur', f(tp, 1, '°C') + ' (Panasonic, unverändert)', '']
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
    ['Betriebszustand', mode + (mode === 'Bereit' ? ' (Verdichter steht)' : '') + (ssOn ? ' · Sanftanlauf aktiv' : ''), ''],
    ['Soll-Vorlauf (Panasonic-Heizkurve)', f(target, 0, '°C'), ''],
    ['Basis-Verschiebung (manuell)', f(shiftBase, 0, 'K'), ''],
    ['Raumregelung-Korrektur (bestehend)', f(rtcCorr, 0, 'K'), ''],
    ['Finale Verschiebung', f(shiftFinal, 0, 'K'), ''],
    ['Vorlauf / Rücklauf', f(outl, 1) + ' / ' + f(inl, 1, '°C'), ''],
    ['Verdichter', f(freq, 0, 'Hz'), ''],
    ['Leistung · COP', f(pw, 0, 'W') + ' · ' + (freq > 0 ? f(cop, 1) : '–'), ''],
    ['Starts heute', f(num(G('Starts_Today')), 0), '']
];

// ---------- Optimierung (Phase 1: nur Beobachtung)
var reason;
if (none) { reason = 'Beobachtung · keine gültigen Raumdaten'; }
else if (heat && over) { reason = 'Beobachtung · Zielkonflikt: ' + heat.name + ' unter Minimum, ' + over.name + ' über Maximum'; }
else if (heat) { reason = 'Beobachtung · ' + heat.name + ' ' + f(-heat.dev, 1, 'K') + ' unter dem eigenen Minimum (' + trTxt(heat) + ')'; }
else if (over) { reason = 'Beobachtung · ' + over.name + ' ' + f(over.dev, 1, 'K') + ' über dem eigenen Maximum (' + trTxt(over) + ')'; }
else { reason = 'Beobachtung · alle gültigen Räume im eigenen Komfortband'; }

var out = [{payload: {rows: rowsWx}}, {payload: {rows: rowsRoom}}, {payload: {rows: rowsWp}}, null, null, null, null, {payload: {table: detail}}];

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
    ['Modus', 'Phase 1 · nur Beobachtung, kein Eingriff', 'ok'],
    ['Grund', reason, ''],
    ['Raumkorrektur durch Optimierung', '0 K (nicht aktiv)', ''],
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
GROUPS = [("opt_g_wx", "Außen & Wetter", 6), ("opt_g_room", "Räume & Komfort", 6), ("opt_g_roomdetail", "Räume im Detail", 12),
          ("opt_g_wp", "Wärmepumpe", 6), ("opt_g_opt", "Optimierung", 6)]
GROUPS += [(f"opt_g_cfg_{r['id']}", "Einstellungen: " + r["name"], 6) for r in ROOMS]
for _order, (gid, gname, gwidth) in enumerate(GROUPS, 1):
    upsert({"id": gid, "type": "ui_group", "name": gname, "tab": UI_TAB, "order": _order, "disp": True,
            "width": gwidth, "collapse": False, "className": ""})

TABLE = ('<style>.opt td{padding:3px 4px;vertical-align:top} .opt .l{color:#666} .opt .v{text-align:right;font-weight:bold}'
         ' .opt .warn{color:#c62828} .opt .ok{color:#2e7d32}</style>'
         '<table class="opt" style="width:100%"><tr ng-repeat="r in msg.payload.rows track by $index">'
         '<td class="l">{{r[0]}}</td><td class="v" ng-class="r[2]">{{r[1]}}</td></tr></table>')

# detail table: one row per room (name, actual, own band, distance to lower/upper limit, trend, valid, role, css class)
DETAIL = """<style>.optd{width:100%;border-collapse:collapse;font-size:13px}
.optd th{text-align:left;font-weight:normal;color:#666;padding:3px 6px;border-bottom:1px solid #ccc}
.optd td{padding:4px 6px;vertical-align:top;border-bottom:1px solid #eee} .optd .n{text-align:right;white-space:nowrap}
.optd .warn{color:#c62828;font-weight:bold} .optd .ok{color:#2e7d32;font-weight:bold} .optd .mute{color:#999}
.optd-note{font-size:12px;color:#666;padding:4px 6px}</style>
<div style="overflow-x:auto"><table class="optd"><tr><th>Raum</th><th class="n">Ist</th><th>Komfortband</th><th class="n">Abstand unten</th><th class="n">Abstand oben</th>
<th>Trend</th><th>Für Optimierung gültig</th><th>Bestimmt</th></tr>
<tr ng-repeat="r in msg.payload.table track by $index"><td>{{r[0]}}</td><td class="n" ng-class="r[8]">{{r[1]}}</td><td>{{r[2]}}</td>
<td class="n" ng-class="r[8]">{{r[3]}}</td><td class="n" ng-class="r[8]">{{r[4]}}</td><td>{{r[5]}}</td>
<td ng-class="{mute: r[8]==='mute'}">{{r[6]}}</td><td>{{r[7]}}</td></tr></table></div>
<div class="optd-note">Abstand: positiv = noch Luft bis zur Grenze, negativ = Grenze verletzt. Jeder Raum wird nach seinem eigenen Band bewertet.</div>"""


def template(i, gid, order, height, y):
    return {"id": i, "type": "ui_template", "z": TAB, "group": gid, "name": "", "order": order, "width": 6,
            "height": height, "format": TABLE, "storeOutMessages": True, "fwdInMessages": False,
            "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": y, "wires": [[]]}


upsert(template("opt_t_wx", "opt_g_wx", 1, 8, 140))
upsert(template("opt_t_room", "opt_g_room", 1, 7, 200))
upsert(template("opt_t_wp", "opt_g_wp", 1, 7, 260))
upsert(template("opt_t_opt", "opt_g_opt", 1, 3, 320))
upsert({"id": "opt_t_roomdetail", "type": "ui_template", "z": TAB, "group": "opt_g_roomdetail", "name": "Räume im Detail",
        "order": 1, "width": 12, "height": 5, "format": DETAIL, "storeOutMessages": True, "fwdInMessages": False,
        "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": 380, "wires": [[]]})


def room_widget(room, field, order, y):
    """Switch/numeric input of one room setting; sends msg.topic "room:<id>:<field>" to opt_set."""
    base = {"id": f"opt_w_{room['id']}_{field}", "z": TAB, "group": f"opt_g_cfg_{room['id']}", "order": order,
            "width": 6, "height": 1, "passthru": False, "topic": f"room:{room['id']}:{field}", "topicType": "str",
            "className": "", "x": 1500, "y": y, "wires": [["opt_set"]]}
    if field == "active":
        base.update({"type": "ui_switch", "name": "Aktiv · " + room["name"], "label": "Aktiv (für die Optimierung)",
                     "tooltip": "Inaktive Räume werden nur angezeigt, aber nicht bewertet.", "decouple": "true",
                     "style": "", "onvalue": "true", "onvalueType": "bool", "onicon": "", "oncolor": "",
                     "offvalue": "false", "offvalueType": "bool", "officon": "", "offcolor": "", "animate": False})
        return base
    _f, label, lo, hi, step, tip = next(x for x in ROOM_FIELDS if x[0] == field)
    base.update({"type": "ui_numeric", "name": label + " · " + room["name"], "label": label, "tooltip": tip, "wrap": False,
                 "format": "{{value}}", "min": lo, "max": hi, "step": step})
    return base


for _ri, _room in enumerate(ROOMS):
    for _fi, _field in enumerate(["active"] + [x[0] for x in ROOM_FIELDS]):
        upsert(room_widget(_room, _field, _fi + 1, 140 + 40 * (_ri * 5 + _fi)))

# ---------------------------------------------------------------- flow nodes
upsert(comment("opt_c1", "Phase 1: nur messen, glätten, anzeigen, protokollieren – KEIN Eingriff in die Regelung", 380, 40))
upsert(comment("opt_c2", "Raumsensoren (Venus-Broker) → Plausibilität, Ausreißer, Glättung, Trend", 380, 80))
upsert(inject("opt_i_init", "Standardwerte", 0, 3, ["opt_defaults"], 140, 140))
upsert(fn("opt_defaults", "Standardwerte setzen", js(DEFAULTS_JS), len(WIDGETS), [[w[0]] for w in WIDGETS], 380, 140, FS))
# output 1: red message for a rejected input, output 2: set the input fields to the valid values, output 3: evaluate now
upsert(fn("opt_set", "Einstellung übernehmen und speichern", js(SET_CFG_JS), 3, [["opt_ui_toast"], ["opt_defaults"], ["opt_eval"]], 1760, 440, FS))

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
upsert(fn("opt_eval", "Auswerten · Anzeigen · Protokollieren", EVAL_JS, 8,
          [["opt_t_wx"], ["opt_t_room"], ["opt_t_wp"], ["opt_t_opt"], ["opt_f_log"], ["opt_f_ev"], ["opt_ui_wxstatus"],
           ["opt_t_roomdetail"]], 420, 760, FS))
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
for _rid in ("opt_ui_ctl", "opt_ui_wait", "opt_n_low", "opt_n_high", "opt_n_age"):
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

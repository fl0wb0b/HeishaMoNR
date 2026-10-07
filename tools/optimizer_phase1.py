#!/usr/bin/env python3
"""Phase 1 of the Lambda-style optimisation layer: sensors, smoothing, trends, logging, dashboard. NO control action.

Adds an editor tab "WP Optimizer" and a dashboard page "Optimierung". Everything is observational:
  * room temperatures (MQTT, Venus broker): freshness, plausibility, outlier rejection, EMA, trend in K/h
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
                "Tab-Umgebungsvariablen (Tab-Eigenschaften > Umgebungsvariablen):\n"
                "  OWM_API_KEY  (Typ: Zugangsdaten) - OpenWeatherMap-API-Schlüssel\n"
                "  OWM_LAT, OWM_LON - Standort in Dezimalgrad\n"
                "Ohne diese Werte läuft alles, nur die Wetterdaten bleiben leer.",
        "env": env})

# ---------------------------------------------------------------- broker (own client id so it never kicks other clients)
upsert({"id": BROKER, "type": "mqtt-broker", "name": "MQTT (Venus) Optimizer", "broker": "192.168.5.11", "port": "1883",
        "clientid": "nodered-optimizer", "autoConnect": True, "usetls": False, "protocolVersion": "4",
        "keepalive": "60", "cleansession": True, "autoUnsubscribe": True,
        "birthTopic": "", "birthQos": "0", "birthRetain": "false", "birthPayload": "", "birthMsg": {},
        "closeTopic": "", "closeQos": "0", "closeRetain": "false", "closePayload": "", "closeMsg": {},
        "willTopic": "", "willQos": "0", "willRetain": "false", "willPayload": "", "willMsg": {},
        "userProps": "", "sessionExpiry": ""})


def fn(i, name, code, outputs=1, wires=None, x=0, y=0):
    return {"id": i, "type": "function", "z": TAB, "name": name, "func": code, "outputs": outputs, "timeout": 0,
            "noerr": 0, "initialize": "", "finalize": "", "libs": [], "x": x, "y": y,
            "wires": wires if wires is not None else [[] for _ in range(outputs)]}


def inject(i, name, repeat, once_delay, wires, x, y):
    return {"id": i, "type": "inject", "z": TAB, "name": name, "props": [{"p": "payload"}],
            "repeat": str(repeat) if repeat else "", "crontab": "", "once": True, "onceDelay": str(once_delay),
            "topic": "", "payload": "", "payloadType": "date", "x": x, "y": y, "wires": [wires]}


def comment(i, text, x, y):
    return {"id": i, "type": "comment", "z": TAB, "name": text, "info": "", "x": x, "y": y, "wires": []}


# ---------------------------------------------------------------- defaults / configuration
DEFAULTS_JS = r"""
// Standardwerte der Optimierungsebene. Bereits gesetzte Werte (z. B. aus dem Dashboard) bleiben erhalten.
var d = {
    rooms: [
        {id: 'ki_oben',  name: 'Kinderzimmer oben',  topic: 'shellyhtg3-lucas/status/temperature:0'},
        {id: 'ki_unten', name: 'Kinderzimmer unten', topic: 'shellyhtg3-lina/status/temperature:0'},
        {id: 'schlaf',   name: 'Schlafzimmer',       topic: 'shellies/shellyht-Schlaf/sensor/temperature'}
    ],
    comfort: {low: 22.5, high: 23.5},
    sensor:  {maxAgeMin: 90, min: 10, max: 35, maxJumpK: 2, emaTauMin: 30, trendWindowMin: 120, trendMinSpanMin: 30, trendMinSamples: 3},
    weather: {intervalMin: 10, maxAgeMin: 60},
    log:     {intervalMin: 5}
};
function merge(base, over) {
    if (!over || typeof over !== 'object') { return base; }
    Object.keys(over).forEach(function (k) {
        if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && typeof over[k] === 'object' && !Array.isArray(over[k])) {
            base[k] = merge(base[k], over[k]);
        } else if (over[k] !== undefined && over[k] !== null) { base[k] = over[k]; }
    });
    return base;
}
var cfg = merge(d, global.get('OPT_cfg'));
global.set('OPT_cfg', cfg);
// aktuelle Werte an die Dashboard-Eingabefelder geben
return [{payload: cfg.comfort.low}, {payload: cfg.comfort.high}, {payload: cfg.sensor.maxAgeMin}];
"""

SET_CFG_JS = r"""
// Eingabefelder im Dashboard -> Konfiguration (msg.topic = Pfad, z. B. comfort.low)
var cfg = global.get('OPT_cfg');
var v = Number(msg.payload);
if (!cfg || !isFinite(v)) { return null; }
var p = String(msg.topic).split('.');
if (p.length === 2 && cfg[p[0]] && typeof cfg[p[0]] === 'object') {
    cfg[p[0]][p[1]] = v;
    global.set('OPT_cfg', cfg);
}
return null;
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
var key = env.get('OWM_API_KEY'), lat = env.get('OWM_LAT'), lon = env.get('OWM_LON');
var W = global.get('OPT_weather') || {};
if (!key || !lat || !lon) {
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
if (msg.topic === 'forecast' && Array.isArray(p.list) && W.temp !== undefined) {
    // +1/+3/+6 h per linearer Interpolation zwischen "jetzt" und den 3-Stunden-Werten
    var pts = [{t: now, v: W.temp, h: W.rh, c: W.clouds}].concat(p.list.map(function (e) {
        return {t: e.dt * 1000, v: e.main.temp, h: e.main.humidity, c: e.clouds ? e.clouds.all : null};
    }));
    function at(hours, key) {
        var target = now + hours * 3600000;
        for (var i = 1; i < pts.length; i++) {
            if (pts[i].t >= target) {
                var a = pts[i - 1], b = pts[i], f = (target - a.t) / (b.t - a.t);
                return Math.round((a[key] + f * (b[key] - a[key])) * 10) / 10;
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

EVAL_JS = r"""
// Einmal pro Minute: Werte zusammenfuehren, bewerten, anzeigen und protokollieren. KEIN Eingriff in die Regelung.
var cfg = global.get('OPT_cfg');
if (!cfg) { return null; }
var now = Date.now();
var R = global.get('OPT_rooms') || {};
var W = global.get('OPT_weather') || {};
var G = function (k) { return global.get(k); };

function num(v) { v = Number(v); return isFinite(v) ? v : null; }
function f(v, d, unit) { if (v === null || v === undefined || !isFinite(v)) { return '–'; } return Number(v).toFixed(d).replace('.', ',') + (unit ? ' ' + unit : ''); }
function ageMin(ts) { return ts ? Math.round((now - ts) / 60000) : null; }
function arrow(t) { if (t === null || t === undefined) { return '·'; } return t >= 0.05 ? '↑' : (t <= -0.05 ? '↓' : '→'); }
function age(a) { return a === null ? 'keine Daten' : (a < 60 ? a + ' min' : (a / 60).toFixed(1).replace('.', ',') + ' h'); }

// ---------- Raeume
var sMax = cfg.sensor.maxAgeMin, ids = Object.keys(R);
var fresh = [];
ids.forEach(function (id) {
    var r = R[id], a = ageMin(r.ts);
    r.age = a; r.valid = (a !== null && a <= sMax && r.ema !== undefined);
    if (r.valid) { fresh.push(r); }
});
var cold = null, warm = null;
fresh.forEach(function (r) { if (cold === null || r.ema < cold.ema) { cold = r; } if (warm === null || r.ema > warm.ema) { warm = r; } });
var total = (cfg.rooms || []).length;
var low = cfg.comfort.low, high = cfg.comfort.high;
var band = 'keine Raumdaten', bandCls = 'warn', room = null;
if (cold && warm) {
    room = Math.min(cold.ema - low, high - warm.ema);
    if (cold.ema < low) { band = 'Kältester Raum unter dem Komfortband'; bandCls = 'warn'; }
    else if (warm.ema > high) { band = 'Wärmster Raum über dem Komfortband'; bandCls = 'warn'; }
    else { band = 'innerhalb · Spielraum ' + f(room, 1, 'K'); bandCls = 'ok'; }
}
var oldest = fresh.length ? Math.max.apply(null, fresh.map(function (r) { return r.age; })) : null;
var rowsRoom = [
    ['Kältester Raum', cold ? f(cold.ema, 1, '°C') + ' ' + arrow(cold.trend) + ' ' + (cold.trend === null ? 'Trend n. v.' : f(cold.trend, 2, 'K/h')) : '–', cold && cold.ema < low ? 'warn' : ''],
    ['   ' + (cold ? cold.name : ''), cold ? 'Wert ' + f(cold.last, 1, '°C') + ' · vor ' + age(cold.age) : '', ''],
    ['Wärmster Raum', warm ? f(warm.ema, 1, '°C') + ' ' + arrow(warm.trend) + ' ' + (warm.trend === null ? 'Trend n. v.' : f(warm.trend, 2, 'K/h')) : '–', warm && warm.ema > high ? 'warn' : ''],
    ['   ' + (warm ? warm.name : ''), warm ? 'Wert ' + f(warm.last, 1, '°C') + ' · vor ' + age(warm.age) : '', ''],
    ['Komfortband', f(low, 1) + ' – ' + f(high, 1, '°C'), ''],
    ['Bewertung', band, bandCls],
    ['Sensoren aktuell', fresh.length + ' von ' + total + (oldest !== null ? ' · ältester ' + age(oldest) : '') + ' · Limit ' + age(sMax), fresh.length < 2 ? 'warn' : '']
];
ids.forEach(function (id) {
    var r = R[id];
    rowsRoom.push([r.name, r.valid ? f(r.ema, 1, '°C') + ' (' + age(r.age) + ')' : 'veraltet (' + age(r.age) + ')', r.valid ? '' : 'warn']);
});

// ---------- Aussen / Wetter
var tp = num(G('TOP14_Outside_Temp')), tw = (W.ts && ageMin(W.ts) <= cfg.weather.maxAgeMin) ? W.temp : null;
var wAge = ageMin(W.ts), wOk = (W.status === 'OK' && wAge !== null && wAge <= cfg.weather.maxAgeMin);
var rowsWx = [
    ['Außen Panasonic', f(tp, 1, '°C'), ''],
    ['Außen Wetterdienst', tw !== null ? f(tw, 1, '°C') : '–', ''],
    ['Differenz Wetter − Panasonic', (tw !== null && tp !== null) ? f(tw - tp, 1, 'K') : '–', ''],
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
var mode = !pOn ? 'Aus' : (defrost ? 'Abtauen' : (valve === 1 ? 'Warmwasser' : (freq > 0 ? 'Heizen' : 'Bereit (Verdichter steht)')));
var shiftBase = null, ccc = G('F_CCC'); if (ccc && ccc.z1) { shiftBase = num(ccc.z1.SP_DIRECT_virt); }
var rtc = G('F_RTC'), rtcCorr = (rtc && rtc.z1) ? num(rtc.z1.correction_value) : null;
var shiftFinal = num(G('SHIFT_Final')), target = num(G('TOP42_Z1_Water_Target_Temp'));
var inl = num(G('TOP5_Main_Inlet_Temp')), outl = num(G('TOP6_Main_Outlet_Temp')), pw = num(G('TOP16_Heat_Energy_Consumption')), cop = num(G('COP_HEAT'));
var rowsWp = [
    ['Betriebszustand', mode + (ssOn ? ' · Sanftanlauf aktiv' : ''), ''],
    ['Soll-Vorlauf (Panasonic-Heizkurve)', f(target, 0, '°C'), ''],
    ['Basis-Verschiebung (manuell)', f(shiftBase, 0, 'K'), ''],
    ['Raumregelung-Korrektur (bestehend)', f(rtcCorr, 0, 'K'), ''],
    ['Finale Verschiebung', f(shiftFinal, 0, 'K'), ''],
    ['Vorlauf / Rücklauf', f(outl, 1) + ' / ' + f(inl, 1, '°C'), ''],
    ['Verdichter', f(freq, 0, 'Hz'), ''],
    ['Leistung · COP', f(pw, 0, 'W') + ' · ' + (freq > 0 ? f(cop, 1) : '–'), ''],
    ['Starts heute', f(num(G('Starts_Today')), 0), '']
];

// ---------- Optimierung (Phase 1)
var lastLog = flow.get('lastLog');
var reason;
if (!cold || !warm) { reason = 'Beobachtung · zu wenig aktuelle Raumdaten'; }
else if (cold.ema < low) { reason = 'Beobachtung · kältester Raum (' + cold.name + ') liegt unter dem Komfortband'; }
else if (warm.ema > high) { reason = 'Beobachtung · wärmster Raum (' + warm.name + ') liegt über dem Komfortband'; }
else { reason = 'Beobachtung · beide Räume im Komfortband'; }
var out = [{payload: {rows: rowsWx}}, {payload: {rows: rowsRoom}}, {payload: {rows: rowsWp}}, null, null, null];

// ---------- Protokoll (alle log.intervalMin Minuten) und Ereignisse
var d = new Date(now), pad = function (n) { return (n < 10 ? '0' : '') + n; };
var month = d.getFullYear() + '-' + pad(d.getMonth() + 1);
var iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
function c(v) { return (v === null || v === undefined || !isFinite(v)) ? '' : String(Math.round(v * 100) / 100); }
if (!lastLog || (now - lastLog) >= cfg.log.intervalMin * 60000) {
    var head = 'zeit,aussen_panasonic,aussen_wetter,wetter_feuchte,wetter_taupunkt,prog_1h,prog_3h,prog_6h,wetter_alter_min,' +
        'raum_kalt,raum_kalt_trend,raum_kalt_name,raum_warm,raum_warm_trend,raum_warm_name,sensoren_aktuell,' +
        'soll_vorlauf,shift_basis,shift_rtc,shift_final,vorlauf,ruecklauf,verdichter_hz,leistung_w,cop,defrost,warmwasser,sanftanlauf,starts_heute\n';
    var line = [iso, c(tp), c(tw), c(wOk ? W.rh : null), c(wOk ? W.dew : null), c(wOk ? W.f1 : null), c(wOk ? W.f3 : null), c(wOk ? W.f6 : null), c(wAge),
        c(cold ? cold.ema : null), c(cold ? cold.trend : null), cold ? cold.name : '', c(warm ? warm.ema : null), c(warm ? warm.trend : null), warm ? warm.name : '', fresh.length,
        c(target), c(shiftBase), c(rtcCorr), c(shiftFinal), c(outl), c(inl), c(freq), c(pw), c(freq > 0 ? cop : null), defrost ? 1 : 0, valve === 1 ? 1 : 0, ssOn ? 1 : 0, c(num(G('Starts_Today')))].join(',') + '\n';
    var hdr = flow.get('logHeader');
    out[4] = {filename: '/data/optimizer/optimizer-' + month + '.csv', payload: (hdr === month ? '' : head) + line};
    flow.set('logHeader', month);
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
           komfort: (cold && warm) ? ((cold.ema < low) ? 'kalt' : (warm.ema > high ? 'warm' : 'ok')) : 'unbekannt'};
var ev = [];
Object.keys(cur).forEach(function (k) { if (prev[k] !== undefined && prev[k] !== cur[k]) { ev.push(iso + ',' + k + ',' + prev[k] + '->' + cur[k]); } });
flow.set('prevState', cur);
if (ev.length) {
    var eh = flow.get('evHeader');
    out[5] = {filename: '/data/optimizer/optimizer-events-' + month + '.csv', payload: (eh === month ? '' : 'zeit,ereignis,wechsel\n') + ev.join('\n') + '\n'};
    flow.set('evHeader', month);
}
return out;
"""

# ---------------------------------------------------------------- dashboard
upsert({"id": UI_TAB, "type": "ui_tab", "name": "Optimierung", "icon": "tune", "order": 12.5, "disabled": False, "hidden": False})
GROUPS = [("opt_g_wx", "Außen & Wetter", 1), ("opt_g_room", "Räume & Komfort", 2),
          ("opt_g_wp", "Wärmepumpe", 3), ("opt_g_opt", "Optimierung & Einstellungen", 4)]
for gid, gname, order in GROUPS:
    upsert({"id": gid, "type": "ui_group", "name": gname, "tab": UI_TAB, "order": order, "disp": True,
            "width": 6, "collapse": False, "className": ""})

TABLE = ('<style>.opt td{padding:3px 4px;vertical-align:top} .opt .l{color:#666} .opt .v{text-align:right;font-weight:bold}'
         ' .opt .warn{color:#c62828} .opt .ok{color:#2e7d32}</style>'
         '<table class="opt" style="width:100%"><tr ng-repeat="r in msg.payload.rows track by $index">'
         '<td class="l">{{r[0]}}</td><td class="v" ng-class="r[2]">{{r[1]}}</td></tr></table>')


def template(i, gid, order, height, y):
    return {"id": i, "type": "ui_template", "z": TAB, "group": gid, "name": "", "order": order, "width": 6,
            "height": height, "format": TABLE, "storeOutMessages": True, "fwdInMessages": False,
            "resendOnRefresh": True, "templateScope": "local", "className": "", "x": 1260, "y": y, "wires": [[]]}


upsert(template("opt_t_wx", "opt_g_wx", 1, 8, 140))
upsert(template("opt_t_room", "opt_g_room", 1, 9, 200))
upsert(template("opt_t_wp", "opt_g_wp", 1, 7, 260))
upsert(template("opt_t_opt", "opt_g_opt", 1, 3, 320))


def numeric(i, label, topic, order, lo, hi, step, y):
    return {"id": i, "type": "ui_numeric", "z": TAB, "name": label, "label": label, "tooltip": "", "group": "opt_g_opt",
            "order": order, "width": 6, "height": 1, "wrap": False, "passthru": False, "topic": topic,
            "topicType": "str", "format": "{{value}}", "min": lo, "max": hi, "step": step, "className": "",
            "x": 560, "y": y, "wires": [["opt_set"]]}


upsert(numeric("opt_n_low", "Komfortband unten (°C)", "comfort.low", 2, 15, 26, 0.1, 400))
upsert(numeric("opt_n_high", "Komfortband oben (°C)", "comfort.high", 3, 16, 28, 0.1, 440))
upsert(numeric("opt_n_age", "Sensor gilt als veraltet nach (min)", "sensor.maxAgeMin", 4, 5, 360, 5, 480))

# ---------------------------------------------------------------- flow nodes
upsert(comment("opt_c1", "Phase 1: nur messen, glätten, anzeigen, protokollieren – KEIN Eingriff in die Regelung", 380, 40))
upsert(comment("opt_c2", "Raumsensoren (Venus-Broker) → Plausibilität, Ausreißer, Glättung, Trend", 380, 80))
upsert(inject("opt_i_init", "Standardwerte", 0, 3, ["opt_defaults"], 140, 140))
upsert(fn("opt_defaults", "Standardwerte setzen", DEFAULTS_JS, 3, [["opt_n_low"], ["opt_n_high"], ["opt_n_age"]], 380, 140))
upsert(fn("opt_set", "Einstellung übernehmen", SET_CFG_JS, 1, [[]], 780, 440))

for i, (t, y) in enumerate((("+/status/temperature:0", 200), ("shellies/+/sensor/temperature", 260))):
    upsert({"id": f"opt_mqtt_{i}", "type": "mqtt in", "z": TAB, "name": "", "topic": t, "qos": "1",
            "datatype": "auto-detect", "broker": BROKER, "nl": False, "rap": True, "rh": 0, "inputs": 0,
            "x": 160, "y": y, "wires": [["opt_room_in"]]})
upsert(fn("opt_room_in", "Raumsensor verarbeiten", ROOM_IN_JS, 1, [[]], 420, 230))

upsert(comment("opt_c3", "OpenWeatherMap (optional): Schlüssel/Standort als Tab-Umgebungsvariablen eintragen", 380, 540))
upsert(inject("opt_i_wx", "Wetter abrufen", 600, 20, ["opt_owm_req"], 140, 600))
upsert(fn("opt_owm_req", "OWM-Anfrage", OWM_REQ_JS, 1, [["opt_http"]], 380, 600))
upsert({"id": "opt_http", "type": "http request", "z": TAB, "name": "OpenWeatherMap", "method": "GET", "ret": "obj",
        "paytoqs": "ignore", "url": "", "tls": "", "persist": False, "proxy": "", "insecureHTTPParser": False,
        "authType": "", "senderr": False, "headers": [], "x": 620, "y": 600, "wires": [["opt_owm_parse"]]})
upsert({"id": "opt_catch", "type": "catch", "z": TAB, "name": "", "scope": ["opt_http"], "uncaught": False,
        "x": 620, "y": 660, "wires": [["opt_owm_parse"]]})
upsert(fn("opt_owm_parse", "OWM-Antwort auswerten", OWM_PARSE_JS, 1, [[]], 880, 600))

upsert(comment("opt_c4", "Auswertung jede Minute → Anzeige + Protokoll (CSV in /data/optimizer)", 380, 700))
upsert(inject("opt_i_tick", "jede Minute", 60, 15, ["opt_eval"], 140, 760))
upsert(fn("opt_eval", "Auswerten · Anzeigen · Protokollieren", EVAL_JS, 6,
          [["opt_t_wx"], ["opt_t_room"], ["opt_t_wp"], ["opt_t_opt"], ["opt_f_log"], ["opt_f_ev"]], 420, 760))
for fid, name, y in (("opt_f_log", "Protokoll", 700), ("opt_f_ev", "Ereignisse", 780)):
    upsert({"id": fid, "type": "file", "z": TAB, "name": name, "filename": "filename", "filenameType": "msg",
            "appendNewline": False, "createDir": True, "overwriteFile": "false", "encoding": "utf8",
            "x": 960, "y": y, "wires": [[]]})

# the new page also belongs into the menu configuration (SYSTEM > menu), otherwise it can not be hidden/shown there
form = B.get("e35b7df78bc6f722")
if form and not any(o["value"] == "Optimierung" for o in form["options"]):
    form["options"].append({"label": "OPTIMIERUNG", "value": "Optimierung", "type": "checkbox", "required": False, "rows": None})
    form["formValue"]["Optimierung"] = False

json.dump(flows, open(path, "w", encoding="utf-8"), indent=4, ensure_ascii=False)
print("ok")

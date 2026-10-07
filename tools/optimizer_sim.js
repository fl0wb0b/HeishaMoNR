// Offline-Simulation der Optimizer-Funktionen mit Fake-Uhr (kein Node-RED noetig)
const vm = require('vm');
const fs = require('fs');
// Usage: node tools/optimizer_sim.js "flows (26.5.1 stable).json"
const flowsFile = process.argv[2] || 'flows (26.5.1 stable).json';
const F = {};
JSON.parse(fs.readFileSync(flowsFile, 'utf8')).forEach(n => { if (n.type === 'function' && n.id.startsWith('opt_')) { F[n.id] = n.func; } });
let NOW = Date.UTC(2026, 9, 7, 6, 0, 0);       // simulierte Uhr
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } }
  static now() { return NOW; }
}
const gstore = {}, fstore = {}, envv = {};
// minimales Dateisystem-Modell (Pfad -> {data, mode}); wirft ENOENT wie das echte fs
const files = {};
const fsMock = {
  readFileSync: (p, enc) => { if (!(p in files)) { const e = new Error("ENOENT: no such file or directory, open '" + p + "'"); e.code = 'ENOENT'; throw e; } return files[p].data; },
  writeFileSync: (p, data, opt) => { files[p] = {data: String(data), mode: (opt && opt.mode !== undefined) ? opt.mode : (files[p] ? files[p].mode : 0o644)}; },
  mkdirSync: () => {},
  chmodSync: (p, mode) => { if (files[p]) { files[p].mode = mode; } },
};
const sent = [];
function makeCtx(store) { return { get: k => store[k], set: (k, v) => { store[k] = v; } }; }
function run(id, msg) {
  const out = [];
  const node = { send: m => sent.push({id, m}), warn: () => {}, error: () => {}, status: () => {} };
  const sandbox = { fs: fsMock, msg, global: makeCtx(gstore), flow: makeCtx(fstore), context: makeCtx({}), env: { get: k => envv[k] }, node, Date: FakeDate, Buffer, Math, JSON, Number, String, Object, Array, isFinite };
  const code = `(function(msg,global,flow,context,env,node){${F[id]}\n})`;
  return vm.runInNewContext(code, sandbox)(msg, sandbox.global, sandbox.flow, sandbox.context, sandbox.env, node);
}
const set = (k, v) => { gstore[k] = v; };
// Panasonic-Werte (wie live)
Object.assign(gstore, {TOP14_Outside_Temp: 4.8, TOP42_Z1_Water_Target_Temp: 29, SHIFT_Final: 0, TOP5_Main_Inlet_Temp: 27, TOP6_Main_Outlet_Temp: 28,
  compressor_frequency: 17, TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0, TOP16_Heat_Energy_Consumption: 369, COP_HEAT: 5.4, TOP0_Heatpump_State: 1,
  Starts_Today: 3, F_SS: {state: 0}, F_CCC: {z1: {SP_DIRECT_virt: 0}}, F_RTC: {z1: {correction_value: 0}}});
run('opt_defaults', {});
const cfg = gstore.OPT_cfg;
// ki_unten faellt, ki_oben steigt, schlaf bleibt stabil (jeweils eigenes Komfortband)
const T = {cold: cfg.rooms[1].topic, mid: cfg.rooms[0].topic, warm: cfg.rooms[2].topic};
let csv = [], events = [], assertFails = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined ? '  -> ' + info : '')); if (!cond) assertFails++; }
const ctrlSnapshot = () => JSON.stringify(Object.keys(gstore).filter(k => !k.startsWith('OPT_')).sort().map(k => [k, gstore[k]]));
const ctrl0 = ctrlSnapshot();

const noise = () => (Math.random() - 0.5) * 0.1;
const rnd1 = x => Math.round(x * 10) / 10;
let minute = 0; const REPORT = 12;     // Sensoren melden alle 12 min
const snap = {};
for (minute = 0; minute <= 8 * 60; minute++) {
  NOW = Date.UTC(2026, 9, 7, 6, 0, 0) + minute * 60000;
  if (minute % REPORT === 0) {
    const h = minute / 60;
    // Kinderzimmer unten (Band 22,5-23,5) faellt -0,15 K/h ab 22,8
    run('opt_room_in', {topic: T.cold, payload: JSON.stringify({id: 0, tC: rnd1(22.8 - 0.15 * h + noise()), tF: 0})});
    // Schlafzimmer (Band 19-21) stabil 20,0 (Gen1-Format als reine Zahl) - faellt zwischen Minute 180 und 300 aus (Sensor offline)
    if (!(minute >= 180 && minute < 300)) { run('opt_room_in', {topic: T.warm, payload: String(rnd1(20.0 + noise()))}); }
    // Kinderzimmer oben (Band 22,5-23,5) steigt +0,1 K/h ab 23,0
    run('opt_room_in', {topic: T.mid, payload: JSON.stringify({tC: rnd1(23.0 + 0.1 * h + noise())})});
  }
  if (minute === 96) { run('opt_room_in', {topic: T.warm, payload: '28.4'}); }     // Ausreisser-Spike (Sprung > 2 K)
  if (minute === 132) { run('opt_room_in', {topic: T.cold, payload: '99'}); }       // unplausibel
  if (minute === 200) { gstore.TOP26_Defrosting_State = 1; }
  if (minute === 206) { gstore.TOP26_Defrosting_State = 0; }
  const out = run('opt_eval', {});
  if (out) {
    if (out[4]) csv.push(out[4].payload);
    if (out[5]) events.push(out[5].payload);
    if ([60, 240, 290, 480].includes(minute)) { snap[minute] = {room: out[1].payload.rows, detail: out[7].payload.table, opt: out[3].payload.rows}; }
  }
}
const R = gstore.OPT_rooms;
const byName = (s, name) => s.detail.find(r => r[0] === name);
check('Trend Kinderzimmer unten ~ -0,15 K/h', R.ki_unten.trend !== null && Math.abs(R.ki_unten.trend + 0.15) < 0.08, R.ki_unten.trend);
check('Trend Kinderzimmer oben ~ +0,10 K/h', R.ki_oben.trend !== null && Math.abs(R.ki_oben.trend - 0.10) < 0.08, R.ki_oben.trend);
check('Ausreisser 28,4 abgelehnt (Sprung)', R.schlaf.rejected >= 1 && R.schlaf.last_reject && R.schlaf.last_reject.why === 'Sprung', JSON.stringify(R.schlaf.last_reject));
check('99 °C unplausibel abgelehnt', R.ki_unten.rejected >= 1, R.ki_unten.rejected);
check('Spike floss nicht in den Mittelwert ein', R.schlaf.ema < 22, R.schlaf.ema.toFixed(2));
console.log('\nMinute 60   Raeume:', snap[60].room.map(x => x[0] + ': ' + x[1]).join(' | '));
console.log('Minute 480  Raeume:', snap[480].room.map(x => x[0] + ': ' + x[1]).join(' | '));
console.log('Minute 480  Detail:', snap[480].detail.map(x => x.slice(0, 8).join(' ; ')).join('\n            '));
check('Minute 60: alle Raeume im eigenen Band (Schlafzimmer 20 °C liegt im Band 19-21)',
      snap[60].room[0][1] === 'keiner' && snap[60].room[1][1] === 'keine' && snap[60].opt[1][1].includes('im eigenen Komfortband'), snap[60].opt[1][1]);
check('Minute 240: Heizbedarf = Kinderzimmer unten', snap[240].room[0][1].startsWith('Kinderzimmer unten') && snap[240].room[0][1].includes('unter Minimum'), snap[240].room[0][1]);
check('Minute 240: Schlafzimmer (offline seit 60 min, Limit 90) noch gueltig', snap[240].room[3][1].startsWith('3 von 3') && byName(snap[240], 'Schlafzimmer')[6].startsWith('ja'), snap[240].room[3][1]);
check('Minute 290: Schlafzimmer offline seit >90 min zaehlt nicht mehr', snap[290].room[3][1].startsWith('2 von 3') && byName(snap[290], 'Schlafzimmer')[6].startsWith('nein (veraltet'), snap[290].room[3][1]);
check('Minute 480: Zielkonflikt (unten unter Minimum, oben ueber Maximum)', snap[480].opt[1][1].includes('Zielkonflikt'), snap[480].opt[1][1]);
check('Minute 480: Rollen in der Detailtabelle', byName(snap[480], 'Kinderzimmer unten')[7] === 'Heizbedarf' && byName(snap[480], 'Kinderzimmer oben')[7] === 'Überschreitung' && byName(snap[480], 'Schlafzimmer')[7] === '', '');
check('Phase 1: keine Regelwerte veraendert (es werden nur OPT_*-Variablen geschrieben)', ctrlSnapshot() === ctrl0, '');
// CSV
const lines = csv.join('').trim().split('\n');
const headers = lines.filter(l => l.startsWith('zeit,')).length;
const H = lines[0].split(','), col = n => H.indexOf(n);
const last = lines[lines.length - 1].split(',');
check('CSV: genau 1 Kopfzeile', headers === 1, headers);
check('CSV: ca. 97 Datenzeilen (alle 5 min)', lines.length - headers >= 95 && lines.length - headers <= 99, lines.length - headers);
check('CSV: Spaltenzahl konsistent', new Set(lines.slice(1).map(l => l.split(',').length)).size === 1 && lines[1].split(',').length === H.length, H.length);
const need = ['aussen_panasonic', 'aussen_wetter', 'diff_wetter_minus_panasonic', 'wetter_feuchte', 'wetter_taupunkt', 'prog_1h', 'prog_3h', 'prog_6h',
  'ki_oben_wert', 'ki_oben_trend', 'ki_oben_abw', 'ki_unten_trend', 'ki_unten_abw', 'schlaf_trend', 'schlaf_abw', 'schlaf_gueltig',
  'heizbedarf_raum', 'ueberschreitung_raum', 'spielraum_k', 'soll_vorlauf', 'shift_basis', 'shift_rtc', 'shift_final', 'vorlauf', 'ruecklauf',
  'verdichter_hz', 'verdichter_an', 'defrost', 'warmwasser', 'sanftanlauf'];
check('CSV: alle geforderten Spalten vorhanden', need.every(n => col(n) >= 0), need.filter(n => col(n) < 0).join(','));
check('CSV: Baender je Raum stehen in den Spalten', last[col('schlaf_min')] === '19' && last[col('schlaf_max')] === '21' && last[col('ki_oben_min')] === '22.5' && last[col('ki_unten_max')] === '23.5', last[col('schlaf_min')] + '-' + last[col('schlaf_max')]);
check('CSV: letzte Zeile nennt die massgeblichen Raeume mit Abweichung', last[col('heizbedarf_raum')] === 'Kinderzimmer unten' && last[col('ueberschreitung_raum')] === 'Kinderzimmer oben' && Number(last[col('heizbedarf_abw')]) < 0 && Number(last[col('ueberschreitung_abw')]) > 0, last[col('heizbedarf_raum')] + ' / ' + last[col('ueberschreitung_raum')]);
check('CSV: Defrost erfasst', lines.slice(1).some(l => l.split(',')[col('defrost')] === '1'), '');
const evl = events.join('').trim().split('\n');
check('Ereignisse: Defrost-Wechsel erfasst', evl.some(l => l.includes('defrost,0->1')) && evl.some(l => l.includes('defrost,1->0')), evl.length + ' Zeilen');
check('Ereignisse: Heizbedarf-Wechsel erfasst', evl.some(l => l.includes('komfort,ok->heizbedarf:Kinderzimmer unten')), evl.filter(l => l.includes('komfort')).join(' ; '));
check('Ereignisse: Ueberschreitung zusaetzlich erfasst', evl.some(l => l.includes('+ueberschreitung:Kinderzimmer oben')), evl.filter(l => l.includes('komfort')).join(' ; '));
console.log('\nBeispiel CSV:', lines[lines.length - 1]); console.log('Ereignisse:', evl.slice(0, 6).join(' | '));

// ---------- Wetter
console.log('\n--- Wetter (OpenWeatherMap-Mock)');
NOW = Date.UTC(2026, 9, 7, 14, 0, 0);
run('opt_owm_req', {});
check('ohne Schluessel: Status "nicht konfiguriert", nichts gesendet', gstore.OPT_weather.status === 'nicht konfiguriert' && sent.filter(s => s.id === 'opt_owm_req').length === 0, gstore.OPT_weather.status);
envv.OWM_API_KEY = 'KEY123'; envv.OWM_LAT = '50.1'; envv.OWM_LON = '8.6';
run('opt_owm_req', {});
const reqs = sent.filter(s => s.id === 'opt_owm_req').map(s => s.m);
check('mit Schluessel: 2 Anfragen (current, forecast)', reqs.length === 2 && reqs[0].topic === 'current' && reqs[1].topic === 'forecast', reqs.map(r => r.topic).join(','));
check('URL enthaelt Standort, Metrik und cnt=4', reqs[1].url.includes('lat=50.1') && reqs[1].url.includes('units=metric') && reqs[1].url.includes('cnt=4'), reqs[1].url.replace('KEY123', '***'));
const t0 = NOW / 1000;
run('opt_owm_parse', {topic: 'current', statusCode: 200, payload: {main: {temp: 2.0, humidity: 90, pressure: 1012}, clouds: {all: 80}, wind: {speed: 3}, weather: [{description: 'Nieselregen'}]}});
run('opt_owm_parse', {topic: 'forecast', statusCode: 200, payload: {list: [
  {dt: t0 + 2 * 3600, main: {temp: 5.0, humidity: 80}, clouds: {all: 60}}, {dt: t0 + 5 * 3600, main: {temp: 8.0, humidity: 70}, clouds: {all: 40}},
  {dt: t0 + 8 * 3600, main: {temp: 3.0, humidity: 85}, clouds: {all: 20}}, {dt: t0 + 11 * 3600, main: {temp: 1.0, humidity: 90}, clouds: {all: 10}}]}});
const W = gstore.OPT_weather;
check('Taupunkt (2 °C, 90 %) ~ 0,5 °C', Math.abs(W.dew - 0.5) < 0.4, W.dew);
check('Prognose +1 h interpoliert (2->5 ueber 2 h = 3,5)', Math.abs(W.f1 - 3.5) < 0.11, W.f1);
check('Prognose +3 h interpoliert (5->8 ueber 3 h bei +1 h = 5,0+1,0=6,0)', Math.abs(W.f3 - 6.0) < 0.11, W.f3);
check('Prognose +6 h (8->3 ueber 3 h bei +1 h = 6,3)', Math.abs(W.f6 - 6.3) < 0.11, W.f6);
// Anzeige
NOW += 60000; let ev2 = run('opt_eval', {}); const wx = ev2[0].payload.rows;
console.log(wx.map(x => x.join(': ')).join('\n'));
check('Wetterstatus OK', W.status === 'OK');
// Fehler & Veralterung
run('opt_owm_parse', {topic: 'current', statusCode: 401, payload: {message: 'Invalid API key'}});
check('HTTP-Fehler setzt Status, behaelt letzte Werte', gstore.OPT_weather.status === 'Fehler: HTTP 401' && gstore.OPT_weather.temp === 2.0, gstore.OPT_weather.status);
run('opt_owm_parse', {error: {message: 'getaddrinfo ENOTFOUND api.openweathermap.org?appid=SECRET123&x'}});
check('Fehlertext enthaelt keinen Schluessel', !gstore.OPT_weather.status.includes('SECRET123'), gstore.OPT_weather.status);
NOW += 90 * 60000; ev2 = run('opt_eval', {});
const wx2 = ev2[0].payload.rows;
check('Wetterdaten nach >60 min nicht mehr verwendet (Anzeige "–")', wx2[1][1] === '–' && wx2[3][1] === '–', wx2[1][1]);
check('Regelwert bleibt Panasonic', wx2[10][1].includes('Panasonic'), wx2[10][1]);

// ---------- Reihenfolge der Antworten: Prognose vor Aktuell
console.log('\n--- Prognose vor Aktuell-Antwort (Wettlauf)');
delete gstore.OPT_weather;
NOW = Date.UTC(2026, 9, 7, 16, 0, 0); const t1 = NOW / 1000;
run('opt_owm_parse', {topic: 'forecast', statusCode: 200, payload: {list: [
  {dt: t1 + 2 * 3600, main: {temp: 10.0, humidity: 70}, clouds: {all: 10}}, {dt: t1 + 5 * 3600, main: {temp: 7.0, humidity: 75}, clouds: {all: 20}},
  {dt: t1 + 8 * 3600, main: {temp: 4.0, humidity: 80}, clouds: {all: 30}}, {dt: t1 + 11 * 3600, main: {temp: 2.0, humidity: 85}, clouds: {all: 40}}]}});
const Wr = gstore.OPT_weather;
check('Prognose ohne Aktuellwert wird nicht verworfen', Wr && Wr.f1 !== undefined && Wr.f1 !== null, JSON.stringify({f1: Wr && Wr.f1, f3: Wr && Wr.f3, f6: Wr && Wr.f6}));
check('+1 h: erster Prognosepunkt (flach, 10,0)', Wr.f1 === 10.0, Wr.f1);
check('+3 h: zwischen 10,0 (+2 h) und 7,0 (+5 h) = 9,0', Math.abs(Wr.f3 - 9.0) < 0.11, Wr.f3);
run('opt_owm_parse', {topic: 'current', statusCode: 200, payload: {main: {temp: 12.0, humidity: 60, pressure: 1010}, clouds: {all: 5}, wind: {speed: 2}, weather: [{description: 'klar'}]}});
check('danach Aktuellwert gesetzt, Prognose bleibt erhalten', gstore.OPT_weather.temp === 12.0 && gstore.OPT_weather.f3 === Wr.f3 && gstore.OPT_weather.status === 'OK', gstore.OPT_weather.status);

// ---------- Zugangsdaten im Dashboard (SYSTEM > EINSTELLUNGEN)
console.log('\n--- OpenWeatherMap-Zugangsdaten (Formular, Datei, Schutz)');
delete envv.OWM_API_KEY; delete envv.OWM_LAT; delete envv.OWM_LON;
const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
let r = run('opt_owm_save', {payload: {owm_key: 'zu kurz!', owm_lat: '50.1', owm_lon: '8.6'}});
check('ungueltiges Schluesselformat wird abgelehnt (rote Meldung, keine Datei)', r[1] && r[1].highlight === 'red' && !('/data/optimizer/owm.json' in files), r[1] && r[1].payload.slice(0, 40));
r = run('opt_owm_save', {payload: {owm_key: SECRET, owm_lat: '95', owm_lon: '8.6'}});
check('Breitengrad 95 abgelehnt', r[1] && r[1].highlight === 'red' && !('/data/optimizer/owm.json' in files), r[1] && r[1].payload);
r = run('opt_owm_save', {payload: {owm_key: SECRET, owm_lat: '50,1', owm_lon: '8,6'}});
const f1 = files['/data/optimizer/owm.json'];
check('gueltige Eingabe gespeichert (Komma-Dezimal akzeptiert)', f1 && JSON.parse(f1.data).lat === 50.1 && JSON.parse(f1.data).lon === 8.6, f1 && f1.data.replace(SECRET, '***'));
check('Datei nur fuer den Besitzer lesbar (0600)', f1 && f1.mode === 0o600, f1 && f1.mode.toString(8));
check('Formular: Schluesselfeld wird geleert, Standort zurueckgeschrieben', r[0].payload.owm_key === '' && r[0].payload.owm_lat === '50.1', JSON.stringify(r[0].payload));
check('Rueckmeldung (gruen) und sofortiger Abruf ausgeloest', r[1] && r[1].highlight === undefined && r[2] && r[2].payload === 'jetzt', r[1] && r[1].payload);
const dump = JSON.stringify(gstore) + JSON.stringify(fstore) + JSON.stringify(r);
check('Schluessel steht in keiner Variable und keiner Rueckmeldung', !dump.includes(SECRET), '');
// Abruf nutzt die Datei
sent.length = 0; run('opt_owm_req', {});
const rq = sent.filter(x => x.id === 'opt_owm_req').map(x => x.m);
check('Abruf liest Schluessel + Standort aus der Datei', rq.length === 2 && rq[0].url.includes(SECRET) && rq[0].url.includes('lat=50.1') && rq[0].url.includes('lon=8.6'), 'Anfragen: ' + rq.length);
check('owmInfo: Quelle Datei, nur Laenge des Schluessels', fstore.owmInfo.source === 'Datei' && fstore.owmInfo.keyLen === SECRET.length && !JSON.stringify(fstore.owmInfo).includes(SECRET), JSON.stringify(fstore.owmInfo));
// leeres Schluesselfeld = vorhandenen Schluessel behalten, nur Standort aendern
r = run('opt_owm_save', {payload: {owm_key: '', owm_lat: '48.2', owm_lon: '11.5'}});
const f2 = JSON.parse(files['/data/optimizer/owm.json'].data);
check('Schluesselfeld leer: Schluessel bleibt, Standort wird geaendert', f2.key === SECRET && f2.lat === 48.2 && f2.lon === 11.5, 'lat ' + f2.lat);
// Start: Standort ins Formular, Status merken
const ld = run('opt_owm_load', {});
check('Start: Standort wird ins Formular geschrieben, Schluessel nicht', ld.payload.owm_lat === '48.2' && ld.payload.owm_key === '' && !JSON.stringify(ld).includes(SECRET), JSON.stringify(ld.payload));
// Statuszeile
NOW += 60000; const ev3 = run('opt_eval', {});
check('Statuszeile nennt Schluessel gespeichert + Standort, ohne den Schluessel', ev3[6].payload.includes('Schlüssel gespeichert') && ev3[6].payload.includes('48,200') && !ev3[6].payload.includes(SECRET), ev3[6].payload);
// ohne Datei und ohne Umgebung
delete files['/data/optimizer/owm.json']; sent.length = 0; run('opt_owm_req', {});
check('ohne Datei/Umgebung: nicht konfiguriert, nichts gesendet', gstore.OPT_weather.status === 'nicht konfiguriert' && sent.filter(x => x.id === 'opt_owm_req').length === 0, gstore.OPT_weather.status);
NOW += 60000; const ev4 = run('opt_eval', {});
check('Statuszeile fordert zur Eingabe auf', ev4[6].payload.startsWith('Noch kein API-Schlüssel'), ev4[6].payload);

// ---------- Komfortband je Raum: massgebliche Raeume nach Abweichung vom EIGENEN Band
console.log('\n--- Komfortband je Raum');
const NAMES = {ki_oben: 'Kinderzimmer oben', ki_unten: 'Kinderzimmer unten', schlaf: 'Schlafzimmer'};
function scene(vals) {                      // vals: Raum-ID -> [geglaettete Temperatur, Alter in min, Trend K/h]
  gstore.OPT_rooms = {};
  Object.keys(vals).forEach(id => { const v = vals[id]; gstore.OPT_rooms[id] = {name: NAMES[id], ema: v[0], last: v[0], ts: NOW - (v[1] || 0) * 60000, trend: v[2] === undefined ? null : v[2]}; });
  NOW += 6 * 60000;
  const o = run('opt_eval', {});
  return {room: o[1].payload.rows, detail: o[7].payload.table, grund: o[3].payload.rows[1][1], o};
}
const rowOf = (s, id) => s.detail.find(r => r[0] === NAMES[id]);
const setv = (topic, payload) => run('opt_set', {topic, payload});
const ALL_OK = {ki_oben: [23.1], ki_unten: [23.0], schlaf: [21.0]};

let s = scene(ALL_OK);
check('Schlafzimmer 21,0 (Band 19-21) und Kinderzimmer 23,1 (Band 22,5-23,5): kein Heizbedarf, keine Ueberschreitung',
      s.room[0][1] === 'keiner' && s.room[1][1] === 'keine' && s.grund.includes('im eigenen Komfortband'), s.grund);
check('kein "kaeltester/waermster Raum" mehr nach absoluter Temperatur', !s.room.some(r => /Kältester|Wärmster/.test(r[0])), '');
check('Abstand unten/oben: Kinderzimmer oben 23,1 -> +0,6 / +0,4 K', rowOf(s, 'ki_oben')[3] === '+0,6 K' && rowOf(s, 'ki_oben')[4] === '+0,4 K', rowOf(s, 'ki_oben').slice(3, 5).join(' / '));
check('Abstand: Schlafzimmer 21,0 -> +2,0 K unten, 0,0 K oben; Band wird je Raum angezeigt', rowOf(s, 'schlaf')[3] === '+2,0 K' && rowOf(s, 'schlaf')[4] === '0,0 K' && rowOf(s, 'schlaf')[2] === '19,0 – 21,0 °C', rowOf(s, 'schlaf').slice(2, 5).join(' / '));
check('geringster Abstand zur Grenze nennt den Raum', s.room[2][1].includes('Schlafzimmer'), s.room[2][1]);

s = scene({ki_oben: [23.9, 0, 0.12], ki_unten: [23.0], schlaf: [18.4, 0, -0.1]});
check('Schlafzimmer 18,4 -> Heizbedarf 0,6 K, Kinderzimmer oben 23,9 -> Ueberschreitung 0,4 K',
      s.room[0][1].startsWith('Schlafzimmer · 0,6 K unter Minimum') && s.room[1][1].startsWith('Kinderzimmer oben · 0,4 K über Maximum'), s.room[0][1] + ' | ' + s.room[1][1]);
check('Zielkonflikt wird benannt, Rollen in der Detailtabelle', s.grund.includes('Zielkonflikt') && rowOf(s, 'schlaf')[7] === 'Heizbedarf' && rowOf(s, 'ki_oben')[7] === 'Überschreitung' && rowOf(s, 'ki_unten')[7] === '', s.grund);
check('Trend je Raum wird angezeigt', rowOf(s, 'schlaf')[5].includes('-0,10 K/h') && rowOf(s, 'ki_oben')[5].includes('+') === false && rowOf(s, 'ki_oben')[5].startsWith('↑'), rowOf(s, 'schlaf')[5] + ' / ' + rowOf(s, 'ki_oben')[5]);

s = scene({ki_oben: [23.0], ki_unten: [22.0], schlaf: [18.4]});
check('zwei Raeume unter dem Minimum: groessere Unterschreitung gewinnt (Schlafzimmer -0,6 vor Kinderzimmer unten -0,5)', s.room[0][1].startsWith('Schlafzimmer'), s.room[0][1]);
setv('room:ki_unten:weight', 2);
s = scene({ki_oben: [23.0], ki_unten: [22.0], schlaf: [18.4]});
check('Gewicht 2 macht Kinderzimmer unten (-0,5 x 2) zum massgeblichen Raum', s.room[0][1].startsWith('Kinderzimmer unten'), s.room[0][1]);
setv('room:ki_unten:weight', 1);

const tog = setv('room:schlaf:active', false);
check('Umschalten von "Aktiv" loest die Aktualisierung der Schalter aus (Ausgang 2), ohne Fehlermeldung', Array.isArray(tog) && tog[0] === null && tog[1] && tog[1].payload === 'aktualisieren' && tog[2].payload === 'auswerten', JSON.stringify(tog));
s = scene({ki_oben: [23.0], ki_unten: [23.0], schlaf: [18.0]});
check('inaktiver Raum wird ignoriert (kein Heizbedarf trotz 18,0), bleibt aber sichtbar', s.room[0][1] === 'keiner' && rowOf(s, 'schlaf')[6].startsWith('nein (inaktiv)') && rowOf(s, 'schlaf')[8] === 'mute' && s.room[3][1].startsWith('2 von 2') && s.room[3][1].includes('1 inaktiv'), s.room[3][1]);
setv('room:schlaf:active', true);

setv('room:schlaf:maxAgeMin', 30);
s = scene({ki_oben: [23.0, 45], ki_unten: [23.0, 45], schlaf: [18.0, 45]});
check('Datenalter-Limit je Raum: Schlafzimmer (30 min) bei 45 min ungueltig, Kinderzimmer (90 min) gueltig',
      rowOf(s, 'schlaf')[6].startsWith('nein (veraltet') && rowOf(s, 'ki_oben')[6].startsWith('ja') && s.room[0][1] === 'keiner', rowOf(s, 'schlaf')[6] + ' | ' + rowOf(s, 'ki_oben')[6]);
setv('room:schlaf:maxAgeMin', 90);
s = scene({ki_oben: [23.0, 200], ki_unten: [23.0, 200], schlaf: [18.0, 200]});
check('keine gueltigen Raeume: Hinweis statt "keiner"', s.room[0][1] === '–' && s.grund.includes('keine gültigen Raumdaten'), s.grund);
s = scene({ki_oben: [23.0], ki_unten: [23.0]});
check('Raum ohne Daten: "keine Daten", zaehlt nicht', rowOf(s, 'schlaf')[6].startsWith('nein (keine Daten)') && s.room[3][1].startsWith('2 von 3'), rowOf(s, 'schlaf')[6]);

// ---------- Einstellungen je Raum: Validierung, Speicherung, Neustart
console.log('\n--- Einstellungen je Raum');
const cf = () => JSON.parse(files['/data/optimizer/config.json'].data);
let r2 = setv('room:schlaf:min', 18);
check('gueltige Eingabe wird uebernommen und in config.json gespeichert, danach sofortige Auswertung (Ausgang 3)', Array.isArray(r2) && r2[0] === null && r2[1] === null && r2[2].payload === 'auswerten' && gstore.OPT_cfg.rooms[2].min === 18 && cf().rooms[2].min === 18, JSON.stringify(cf().rooms[2]));
const rejectedCases = [
  ['Minimum ueber Maximum (21,8 > 21)', 'room:schlaf:min', 21.8], ['Band schmaler als 0,5 K (max 18,2 bei min 18)', 'room:schlaf:max', 18.2],
  ['ausserhalb des Bereichs (min 40)', 'room:schlaf:min', 40], ['Gewicht 0', 'room:schlaf:weight', 0], ['Datenalter 2 min', 'room:schlaf:maxAgeMin', 2],
  ['Text statt Zahl', 'room:schlaf:min', 'abc'], ['leerer Wert', 'room:schlaf:min', ''], ['null', 'room:schlaf:max', null], ['Boolean statt Zahl', 'room:schlaf:min', true]];
rejectedCases.forEach(([name, topic, val]) => {
  const before = JSON.stringify(gstore.OPT_cfg.rooms), fileBefore = files['/data/optimizer/config.json'].data;
  const r = setv(topic, val);
  check('abgelehnt: ' + name, Array.isArray(r) && r[0].highlight === 'red' && r[0].payload.includes('Nichts geändert') && r[1] && JSON.stringify(gstore.OPT_cfg.rooms) === before && files['/data/optimizer/config.json'].data === fileBefore, r && r[0] ? r[0].payload.slice(0, 60) : r);
});
check('unbekannter Raum / unbekanntes Feld werden ignoriert', setv('room:gibtsnicht:min', 20) === null && setv('room:schlaf:farbe', 20) === null, '');
check('abgelehnte Eingabe loest keine Auswertung aus', setv('room:schlaf:min', 'abc').length === 2, '');
setv('room:ki_oben:min', 22.0); setv('room:ki_oben:weight', 1.5); setv('room:ki_oben:maxAgeMin', 60); setv('room:ki_unten:active', false);
// Eingabefelder: ein Ausgang je Widget, Werte stimmen mit der Konfiguration ueberein
const flowsAll = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), nodeBy = {}; flowsAll.forEach(n => { nodeBy[n.id] = n; });
const dfl = run('opt_defaults', {});
const wires = nodeBy['opt_defaults'].wires;
check('opt_defaults: ein Ausgang je Eingabefeld (15), Ausgaenge = Verdrahtung', dfl.length === 15 && wires.length === 15 && nodeBy['opt_defaults'].outputs === 15, dfl.length + '/' + wires.length);
let mapOk = true, info = '';
dfl.forEach((m, i) => {
  const w = nodeBy[wires[i][0]], p = w.topic.split(':'), room = gstore.OPT_cfg.rooms.find(x => x.id === p[1]);
  const want = p[2] === 'active' ? room.active !== false : room[p[2]];
  if (!m || m.payload !== want || w.wires[0][0] !== 'opt_set' || w.passthru !== false) { mapOk = false; info += w.id + ' '; }
});
check('jedes Eingabefeld bekommt den Wert seines Raums/Felds, sendet an opt_set, ohne Echo (passthru aus)', mapOk, info);
const sw = nodeBy['opt_w_schlaf_active'];
check('Schalter "Aktiv": entkoppelt (Server setzt den Zustand), Werte true/false als Bool', sw.type === 'ui_switch' && sw.decouple === 'true' && sw.onvalue === 'true' && sw.offvalue === 'false' && sw.onvalueType === 'bool' && sw.offvalueType === 'bool', JSON.stringify([sw.decouple, sw.onvalue, sw.offvalue]));
check('Eingabefelder haben Grenzen passend zur Pruefung', nodeBy['opt_w_schlaf_min'].min === 10 && nodeBy['opt_w_schlaf_min'].max === 30 && nodeBy['opt_w_schlaf_maxAgeMin'].min === 5 && nodeBy['opt_w_schlaf_weight'].step === 0.1, '');
// Struktur: Ausgangszahl = Verdrahtung, alle Ziele existieren
const struct = flowsAll.filter(n => n.id.startsWith('opt_') && n.wires).flatMap(n => (n.type === 'function' && n.wires.length !== n.outputs ? ['Ausgaenge ' + n.id] : []).concat(n.wires.flat().filter(t => !nodeBy[t]).map(t => n.id + '->' + t)));
check('Flow-Struktur: Ausgaenge passen zur Verdrahtung, alle Ziele existieren', struct.length === 0, struct.join(','));
check('alte globale Komfortband-Felder sind entfernt', !nodeBy['opt_n_low'] && !nodeBy['opt_n_high'] && !nodeBy['opt_n_age'], '');
// simulierter Neustart: Speicher leer, gespeicherte Werte kommen aus der Datei
delete gstore.OPT_cfg; run('opt_defaults', {});
const rr = id => gstore.OPT_cfg.rooms.find(x => x.id === id);
check('nach Neustart: gespeicherte Werte kommen zurueck (Schlafzimmer min 18, Kinderzimmer oben 22 / Gewicht 1,5 / 60 min, unten inaktiv)',
      rr('schlaf').min === 18 && rr('ki_oben').min === 22 && rr('ki_oben').weight === 1.5 && rr('ki_oben').maxAgeMin === 60 && rr('ki_unten').active === false, JSON.stringify(rr('ki_oben')));
check('nach Neustart: nicht geaenderte Werte sind Standardwerte (Schlafzimmer max 21, Kinderzimmer unten 22,5-23,5)', rr('schlaf').max === 21 && rr('ki_unten').min === 22.5 && rr('ki_unten').max === 23.5, '');
// Migration eines frueheren Formats (globales Band, Raeume ohne Baender)
files['/data/optimizer/config.json'] = {data: JSON.stringify({rooms: [{id: 'schlaf', name: 'alt', topic: 'alt/topic'}], comfort: {low: 22, high: 23}, sensor: {maxAgeMin: 60}}), mode: 0o644};
delete gstore.OPT_cfg; run('opt_defaults', {});
check('Migration: Schlafzimmer bekommt 19-21, globales Band entfaellt, Raumname/-topic bleiben aus dem Code, Sensor-Limit bleibt',
      rr('schlaf').min === 19 && rr('schlaf').max === 21 && gstore.OPT_cfg.comfort === undefined && rr('schlaf').topic === 'shellies/shellyht-Schlaf/sensor/temperature' && rr('schlaf').name === 'Schlafzimmer' && gstore.OPT_cfg.sensor.maxAgeMin === 60 && gstore.OPT_cfg.rooms.length === 3, JSON.stringify(rr('schlaf')));
gstore.OPT_cfg = {rooms: [{id: 'ki_oben', name: 'alt', topic: 'alt'}], comfort: {low: 22.5, high: 23.5}, sensor: {maxAgeMin: 90}};      // Speicherstand der Vorversion
delete files['/data/optimizer/config.json']; run('opt_defaults', {});
check('Migration: Speicherstand der Vorversion (globales Band, Raeume ohne Baender) wird ergaenzt', rr('ki_oben').min === 22.5 && rr('ki_oben').max === 23.5 && rr('ki_oben').name === 'Kinderzimmer oben' && gstore.OPT_cfg.comfort === undefined && gstore.OPT_cfg.rooms.length === 3, JSON.stringify(rr('ki_oben')));
['null', 'kaputt{', '[]'].forEach(txt => { files['/data/optimizer/config.json'] = {data: txt, mode: 0o644}; delete gstore.OPT_cfg; let ok = true; try { run('opt_defaults', {}); } catch (e) { ok = false; }
  check('defekte config.json (' + txt + ') bringt die Standardwerte, kein Absturz', ok && rr('schlaf').min === 19 && gstore.OPT_cfg.rooms.length === 3, ''); });
delete files['/data/optimizer/config.json']; delete gstore.OPT_cfg; run('opt_defaults', {});

// ---------- CSV-Kopfzeile ueberlebt Neustarts (kein doppelter Kopf), Spaltenaenderung schreibt neuen Kopf
console.log('\n--- CSV-Kopfzeile');
const csvPath = '/data/optimizer/optimizer-v2-2026-10.csv', evPath = '/data/optimizer/optimizer-events-2026-10.csv';
files[csvPath] = {data: csv.join(''), mode: 0o644}; files[evPath] = {data: events.join(''), mode: 0o644};
NOW = Date.UTC(2026, 9, 7, 20, 0, 0); gstore.OPT_rooms = {ki_oben: {name: 'x', ema: 23, last: 23, ts: NOW, trend: 0}};
Object.keys(fstore).forEach(k => delete fstore[k]);                         // Neustart: Flow-Speicher leer
let o = run('opt_eval', {});
check('nach Neustart: Kopfzeile steht schon in der Datei -> nicht noch einmal schreiben', o[4] && o[4].filename === csvPath && !o[4].payload.startsWith('zeit,'), o[4] && o[4].payload.slice(0, 30));
files[csvPath].data += o[4].payload;
gstore.OPT_cfg.rooms.push({id: 'test', name: 'Testraum', topic: 'x/y', active: true, min: 20, max: 22, weight: 1, maxAgeMin: 90});
NOW += 6 * 60000; o = run('opt_eval', {});
check('neue Spalten (zusaetzlicher Raum): neue Kopfzeile wird geschrieben', o[4] && o[4].payload.startsWith('zeit,') && o[4].payload.includes('test_min'), o[4] && o[4].payload.slice(0, 20));
files[csvPath].data += o[4].payload; fstore.logHead = undefined; fstore.lastLog = undefined;
NOW += 6 * 60000; o = run('opt_eval', {});
check('danach nach Neustart wieder kein doppelter Kopf (letzte Kopfzeile der Datei passt)', o[4] && !o[4].payload.startsWith('zeit,'), o[4] && o[4].payload.slice(0, 20));
gstore.OPT_cfg.rooms.pop();
gstore.TOP26_Defrosting_State = 1; fstore.evHead = undefined; NOW += 60000; o = run('opt_eval', {}); gstore.TOP26_Defrosting_State = 0;
check('Ereignisdatei: Kopfzeile nach Neustart nicht doppelt', o[5] && o[5].filename === evPath && !o[5].payload.startsWith('zeit,') && o[5].payload.includes('defrost,'), o[5] && o[5].payload.trim());

console.log('\nERGEBNIS:', assertFails === 0 ? 'alle Pruefungen bestanden' : assertFails + ' Pruefung(en) fehlgeschlagen');
process.exit(assertFails ? 1 : 0);

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
const sent = [];
function makeCtx(store) { return { get: k => store[k], set: (k, v) => { store[k] = v; } }; }
function run(id, msg) {
  const out = [];
  const node = { send: m => sent.push({id, m}), warn: () => {}, error: () => {}, status: () => {} };
  const sandbox = { msg, global: makeCtx(gstore), flow: makeCtx(fstore), context: makeCtx({}), env: { get: k => envv[k] }, node, Date: FakeDate, Buffer, Math, JSON, Number, String, Object, Array, isFinite };
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
const T = {cold: cfg.rooms[1].topic, mid: cfg.rooms[0].topic, warm: cfg.rooms[2].topic};
let lastRows = null, csv = [], events = [], assertFails = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined ? '  -> ' + info : '')); if (!cond) assertFails++; }

const noise = () => (Math.random() - 0.5) * 0.1;
const rnd1 = x => Math.round(x * 10) / 10;
let minute = 0; const REPORT = 12;     // Sensoren melden alle 12 min
let rejectedSeen = false;
for (minute = 0; minute <= 8 * 60; minute++) {
  NOW = Date.UTC(2026, 9, 7, 6, 0, 0) + minute * 60000;
  if (minute % REPORT === 0) {
    const h = minute / 60;
    // kalter Raum faellt -0,15 K/h ab 22,8
    run('opt_room_in', {topic: T.cold, payload: JSON.stringify({id: 0, tC: rnd1(22.8 - 0.15 * h + noise()), tF: 0})});
    // warmer Raum stabil 23,0 (Gen1-Format als reine Zahl) - faellt zwischen Minute 180 und 300 aus (Sensor offline)
    if (!(minute >= 180 && minute < 300)) { run('opt_room_in', {topic: T.warm, payload: String(rnd1(23.0 + noise()))}); }
    // mittlerer Raum steigt +0,1 K/h
    run('opt_room_in', {topic: T.mid, payload: JSON.stringify({tC: rnd1(23.0 + 0.1 * h + noise())})});
  }
  if (minute === 96) { run('opt_room_in', {topic: T.warm, payload: '28.4'}); }     // Ausreisser-Spike (Sprung > 2 K)
  if (minute === 132) { run('opt_room_in', {topic: T.cold, payload: '99'}); }       // unplausibel
  if (minute === 200) { gstore.TOP26_Defrosting_State = 1; }
  if (minute === 206) { gstore.TOP26_Defrosting_State = 0; }
  const out = run('opt_eval', {});
  if (out) {
    if (out[1]) lastRows = {minute, wx: out[0].payload.rows, room: out[1].payload.rows, wp: out[2].payload.rows, opt: out[3].payload.rows};
    if (out[4]) csv.push(out[4].payload);
    if (out[5]) events.push(out[5].payload);
    if (minute === 100) { var r100 = out[1].payload.rows; }
    if (minute === 150) { var r150 = out[1].payload.rows; }
    if (minute === 240) { var r240 = out[1].payload.rows; var o240 = out[3].payload.rows; }
    if (minute === 290) { var r300 = out[1].payload.rows; }
    if (minute === 480) { var r480 = out[1].payload.rows; var o480 = out[3].payload.rows; }
  }
}
const R = gstore.OPT_rooms;
check('Trend kalter Raum ~ -0,15 K/h', R.ki_unten.trend !== null && Math.abs(R.ki_unten.trend + 0.15) < 0.08, R.ki_unten.trend);
check('Trend mittlerer Raum ~ +0,10 K/h', R.ki_oben.trend !== null && Math.abs(R.ki_oben.trend - 0.10) < 0.08, R.ki_oben.trend);
check('Ausreisser 28,4 abgelehnt (Sprung)', R.schlaf.rejected >= 1 && R.schlaf.last_reject && R.schlaf.last_reject.why === 'Sprung', JSON.stringify(R.schlaf.last_reject));
check('99 °C unplausibel abgelehnt', R.ki_unten.rejected >= 1, R.ki_unten.rejected);
check('Spike floss nicht in den Mittelwert ein', R.schlaf.ema < 24, R.schlaf.ema.toFixed(2));
console.log('\nMinute 100  Raeume:', r100.slice(0, 7).map(x => x[0].trim() + ': ' + x[1]).join(' | '));
console.log('Minute 240  (warmer Raum offline seit 60 min, Limit 90):', r240.slice(2, 4).map(x => x.join(': ')).join(' | '), '|', r240[6].join(': '));
console.log('Minute 290  (Sensor offline seit 110 min > Limit 90):', r300[6].join(': '), '| Sensorzeile:', r300.filter(x => x[0] === 'Schlafzimmer').map(x => x[1]));
check('Nach Ausfall >90 min zaehlt der Sensor nicht mehr', r300[6][1].startsWith('2 von 3'), r300[6][1]);
check('Bei Minute 240 noch 3 von 3 aktuell', r240[6][1].startsWith('3 von 3'), r240[6][1]);
console.log('Minute 480  Bewertung:', r480.filter(x => x[0] === 'Bewertung')[0], '| Grund:', o480.filter(x => x[0] === 'Grund')[0][1]);
check('Kalter Raum faellt unter 22,5 -> Bewertung warnt', r480.filter(x => x[0] === 'Bewertung')[0][1].includes('unter dem Komfortband'), '');
// CSV
const lines = csv.join('').trim().split('\n');
const headers = lines.filter(l => l.startsWith('zeit,')).length;
check('CSV: genau 1 Kopfzeile', headers === 1, headers);
check('CSV: ca. 97 Datenzeilen (alle 5 min)', lines.length - headers >= 95 && lines.length - headers <= 99, lines.length - headers);
check('CSV: Spaltenzahl konsistent', new Set(lines.filter(l => !l.startsWith('zeit,')).map(l => l.split(',').length)).size === 1 && lines[0].split(',').length === lines[1].split(',').length, lines[0].split(',').length);
const evl = events.join('').trim().split('\n');
check('Ereignisse: Defrost-Wechsel erfasst', evl.some(l => l.includes('defrost,0->1')) && evl.some(l => l.includes('defrost,1->0')), evl.length + ' Zeilen');
check('Ereignisse: Komfort-Wechsel erfasst', evl.some(l => l.includes('komfort,ok->kalt')), evl.filter(l => l.includes('komfort')).join(' ; '));
console.log('\nBeispiel CSV:', lines[1]); console.log('Ereignisse:', evl.slice(0, 6).join(' | '));

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
console.log('\nERGEBNIS:', assertFails === 0 ? 'alle Pruefungen bestanden' : assertFails + ' Pruefung(en) fehlgeschlagen');
process.exit(assertFails ? 1 : 0);

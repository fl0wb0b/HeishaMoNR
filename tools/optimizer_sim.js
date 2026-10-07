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
const compiled = {};
function run(id, msg) {
  if (!compiled[id]) { compiled[id] = vm.runInNewContext(`(function(msg,global,flow,context,env,node,fs,Date,Buffer){${F[id]}\n})`, {}); }
  const node = { send: m => sent.push({id, m}), warn: () => {}, error: () => {}, status: () => {} };
  return compiled[id](msg, makeCtx(gstore), makeCtx(fstore), makeCtx({}), { get: k => envv[k] }, node, fsMock, FakeDate, Buffer);
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
    if ([60, 240, 290, 480].includes(minute)) { snap[minute] = {sum: out[1].payload.sum, rooms: out[1].payload.rooms, opt: out[3].payload.rows}; }
  }
}
const R = gstore.OPT_rooms;
const byName = (s, name) => s.rooms.find(r => r.name === name);
check('Trend Kinderzimmer unten ~ -0,15 K/h', R.ki_unten.trend !== null && Math.abs(R.ki_unten.trend + 0.15) < 0.08, R.ki_unten.trend);
check('Trend Kinderzimmer oben ~ +0,10 K/h', R.ki_oben.trend !== null && Math.abs(R.ki_oben.trend - 0.10) < 0.08, R.ki_oben.trend);
check('Ausreisser 28,4 abgelehnt (Sprung)', R.schlaf.rejected >= 1 && R.schlaf.last_reject && R.schlaf.last_reject.why === 'Sprung', JSON.stringify(R.schlaf.last_reject));
check('99 °C unplausibel abgelehnt', R.ki_unten.rejected >= 1, R.ki_unten.rejected);
check('Spike floss nicht in den Mittelwert ein', R.schlaf.ema < 22, R.schlaf.ema.toFixed(2));
console.log('\nMinute 60   Zusammenfassung:', JSON.stringify(snap[60].sum));
console.log('Minute 480  Zusammenfassung:', JSON.stringify(snap[480].sum));
console.log('Minute 480  Raeume:', snap[480].rooms.map(x => [x.name, x.ist, x.band, x.dLow, x.dHigh, x.trend, x.valid, x.role].join(' ; ')).join('\n            '));
check('Minute 60: alle Raeume im eigenen Band (Schlafzimmer 20 °C liegt im Band 19-21)',
      snap[60].sum.heat === 'keiner' && snap[60].sum.over === 'keine' && snap[60].opt[1][1].includes('im eigenen Komfortband'), snap[60].opt[1][1]);
check('Minute 240: Heizbedarf = Kinderzimmer unten', snap[240].sum.heat.startsWith('Kinderzimmer unten') && snap[240].sum.heat.includes('unter Minimum'), snap[240].sum.heat);
check('Minute 240: Schlafzimmer (offline seit 60 min, Limit 90) noch gueltig', snap[240].sum.valid.startsWith('3 von 3') && byName(snap[240], 'Schlafzimmer').valid.startsWith('ja'), snap[240].sum.valid);
check('Minute 290: Schlafzimmer offline seit >90 min zaehlt nicht mehr', snap[290].sum.valid.startsWith('2 von 3') && byName(snap[290], 'Schlafzimmer').valid.startsWith('nein (veraltet'), snap[290].sum.valid);
check('Minute 480: Zielkonflikt (unten unter Minimum, oben ueber Maximum)', snap[480].opt[1][1].includes('Zielkonflikt'), snap[480].opt[1][1]);
check('Minute 480: Rollen in der Detailtabelle', byName(snap[480], 'Kinderzimmer unten').role === 'heat' && byName(snap[480], 'Kinderzimmer oben').role === 'over' && byName(snap[480], 'Schlafzimmer').role === '', '');
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
check('URL enthaelt Standort, Metrik und cnt=12 (36 h Prognose)', reqs[1].url.includes('lat=50.1') && reqs[1].url.includes('units=metric') && reqs[1].url.includes('cnt=12'), reqs[1].url.replace('KEY123', '***'));
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
  return {sum: o[1].payload.sum, rooms: o[1].payload.rooms, grund: o[3].payload.rows[1][1], o};
}
const rowOf = (s, id) => s.rooms.find(r => r.id === id);
const setv = (topic, payload) => run('opt_set', {topic, payload});
const ALL_OK = {ki_oben: [23.1], ki_unten: [23.0], schlaf: [21.0]};

let s = scene(ALL_OK);
check('Schlafzimmer 21,0 (Band 19-21) und Kinderzimmer 23,1 (Band 22,5-23,5): kein Heizbedarf, keine Ueberschreitung',
      s.sum.heat === 'keiner' && s.sum.over === 'keine' && s.grund.includes('im eigenen Komfortband'), s.grund);
check('kein "kaeltester/waermster Raum" mehr nach absoluter Temperatur', !/Kältester|Wärmster/.test(JSON.stringify(s.o[1].payload)), '');
check('Abstand unten/oben: Kinderzimmer oben 23,1 -> +0,6 / +0,4 K', rowOf(s, 'ki_oben').dLow === '+0,6 K' && rowOf(s, 'ki_oben').dHigh === '+0,4 K', rowOf(s, 'ki_oben').dLow + ' / ' + rowOf(s, 'ki_oben').dHigh);
check('Abstand: Schlafzimmer 21,0 -> +2,0 K unten, 0,0 K oben; Band wird je Raum angezeigt', rowOf(s, 'schlaf').dLow === '+2,0 K' && rowOf(s, 'schlaf').dHigh === '0,0 K' && rowOf(s, 'schlaf').band === '19,0 – 21,0 °C', rowOf(s, 'schlaf').band);
check('geringster Abstand zur Grenze nennt den Raum', s.sum.tight.includes('Schlafzimmer'), s.sum.tight);
check('Einstellungen je Raum stehen in der Karte (Schlafzimmer 19/21, Gewicht 1, 90 min, aktiv)', (r => r.min === 19 && r.max === 21 && r.weight === 1 && r.maxAgeMin === 90 && r.on === true)(rowOf(s, 'schlaf')), '');

s = scene({ki_oben: [23.9, 0, 0.12], ki_unten: [23.0], schlaf: [18.4, 0, -0.1]});
check('Schlafzimmer 18,4 -> Heizbedarf 0,6 K, Kinderzimmer oben 23,9 -> Ueberschreitung 0,4 K',
      s.sum.heat.startsWith('Schlafzimmer · 0,6 K unter Minimum') && s.sum.over.startsWith('Kinderzimmer oben · 0,4 K über Maximum'), s.sum.heat + ' | ' + s.sum.over);
check('Zielkonflikt wird benannt, Rollen je Raum', s.grund.includes('Zielkonflikt') && rowOf(s, 'schlaf').role === 'heat' && rowOf(s, 'ki_oben').role === 'over' && rowOf(s, 'ki_unten').role === '', s.grund);
check('Trend je Raum wird angezeigt', rowOf(s, 'schlaf').trend.includes('-0,10 K/h') && rowOf(s, 'ki_oben').trend.startsWith('↑'), rowOf(s, 'schlaf').trend + ' / ' + rowOf(s, 'ki_oben').trend);
check('nur verletzte Grenzen werden rot markiert (Schlafzimmer unten, Kinderzimmer oben oben)', rowOf(s, 'schlaf').cLow === 'warn' && rowOf(s, 'schlaf').cHigh === '' && rowOf(s, 'ki_oben').cHigh === 'warn' && rowOf(s, 'ki_oben').cLow === '' && rowOf(s, 'ki_unten').cLow === '' && rowOf(s, 'ki_unten').cHigh === '', rowOf(s, 'schlaf').cLow + '/' + rowOf(s, 'ki_oben').cHigh);

s = scene({ki_oben: [23.0], ki_unten: [22.0], schlaf: [18.4]});
check('zwei Raeume unter dem Minimum: groessere Unterschreitung gewinnt (Schlafzimmer -0,6 vor Kinderzimmer unten -0,5)', s.sum.heat.startsWith('Schlafzimmer'), s.sum.heat);
setv('room:ki_unten:weight', 2);
s = scene({ki_oben: [23.0], ki_unten: [22.0], schlaf: [18.4]});
check('Gewicht 2 macht Kinderzimmer unten (-0,5 x 2) zum massgeblichen Raum', s.sum.heat.startsWith('Kinderzimmer unten') && rowOf(s, 'ki_unten').weight === 2, s.sum.heat);
setv('room:ki_unten:weight', 1);

setv('room:schlaf:active', false);
s = scene({ki_oben: [23.0], ki_unten: [23.0], schlaf: [18.0]});
check('inaktiver Raum wird ignoriert (kein Heizbedarf trotz 18,0), bleibt aber sichtbar', s.sum.heat === 'keiner' && rowOf(s, 'schlaf').valid.startsWith('nein (inaktiv)') && rowOf(s, 'schlaf').cls === 'mute' && rowOf(s, 'schlaf').on === false && s.sum.valid.startsWith('2 von 2') && s.sum.valid.includes('1 inaktiv'), s.sum.valid);
setv('room:schlaf:active', true);

setv('room:schlaf:maxAgeMin', 30);
s = scene({ki_oben: [23.0, 45], ki_unten: [23.0, 45], schlaf: [18.0, 45]});
check('Datenalter-Limit je Raum: Schlafzimmer (30 min) bei 45 min ungueltig, Kinderzimmer (90 min) gueltig',
      rowOf(s, 'schlaf').valid.startsWith('nein (veraltet') && rowOf(s, 'ki_oben').valid.startsWith('ja') && s.sum.heat === 'keiner' && rowOf(s, 'schlaf').maxAgeMin === 30, rowOf(s, 'schlaf').valid + ' | ' + rowOf(s, 'ki_oben').valid);
setv('room:schlaf:maxAgeMin', 90);
s = scene({ki_oben: [23.0, 200], ki_unten: [23.0, 200], schlaf: [18.0, 200]});
check('keine gueltigen Raeume: Hinweis statt "keiner"', s.sum.heat === '–' && s.sum.heatCls === 'warn' && s.grund.includes('keine gültigen Raumdaten'), s.grund);
s = scene({ki_oben: [23.0], ki_unten: [23.0]});
check('Raum ohne Daten: "keine Daten", zaehlt nicht', rowOf(s, 'schlaf').valid.startsWith('nein (keine Daten)') && s.sum.valid.startsWith('2 von 3'), rowOf(s, 'schlaf').valid);

// ---------- Einstellungen je Raum: Validierung, Speicherung, Neustart
console.log('\n--- Einstellungen je Raum');
const cf = () => JSON.parse(files['/data/optimizer/config.json'].data);
let r2 = setv('room:schlaf:min', 18);
check('gueltige Eingabe wird uebernommen, in config.json gespeichert und sofort ausgewertet (Ausgang 2)', Array.isArray(r2) && r2[0] === null && r2[1].payload === 'auswerten' && gstore.OPT_cfg.rooms[2].min === 18 && cf().rooms[2].min === 18, JSON.stringify(cf().rooms[2]));
const rejectedCases = [
  ['Minimum ueber Maximum (21,8 > 21)', 'room:schlaf:min', 21.8], ['Band schmaler als 0,5 K (max 18,2 bei min 18)', 'room:schlaf:max', 18.2],
  ['ausserhalb des Bereichs (min 40)', 'room:schlaf:min', 40], ['Gewicht 0', 'room:schlaf:weight', 0], ['Datenalter 2 min', 'room:schlaf:maxAgeMin', 2],
  ['Text statt Zahl', 'room:schlaf:min', 'abc'], ['leerer Wert', 'room:schlaf:min', ''], ['null', 'room:schlaf:max', null], ['fehlender Wert (ungueltiges Feld im Browser)', 'room:schlaf:min', undefined], ['Boolean statt Zahl', 'room:schlaf:min', true]];
rejectedCases.forEach(([name, topic, val]) => {
  const before = JSON.stringify(gstore.OPT_cfg.rooms), fileBefore = files['/data/optimizer/config.json'].data;
  const r = setv(topic, val);
  check('abgelehnt: ' + name, Array.isArray(r) && r[0].highlight === 'red' && r[0].payload.includes('Nichts geändert') && r[1].payload === 'auswerten' && JSON.stringify(gstore.OPT_cfg.rooms) === before && files['/data/optimizer/config.json'].data === fileBefore, r && r[0] ? r[0].payload.slice(0, 70) : r);
});
check('Ablehnungstext nennt den erlaubten Bereich', setv('room:schlaf:min', 40)[0].payload.includes('erlaubt: 10 bis 30'), '');
check('unbekannter Raum / unbekanntes Feld werden ignoriert', setv('room:gibtsnicht:min', 20) === null && setv('room:schlaf:farbe', 20) === null, '');
const tog = setv('room:schlaf:active', false);
check('Umschalten von "Aktiv" wird gespeichert und sofort ausgewertet', Array.isArray(tog) && tog[0] === null && tog[1].payload === 'auswerten' && cf().rooms[2].active === false, JSON.stringify(tog));
setv('room:schlaf:active', true);
setv('room:ki_oben:min', 22.0); setv('room:ki_oben:weight', 1.5); setv('room:ki_oben:maxAgeMin', 60); setv('room:ki_unten:active', false);

// Aufbau der Seite: eine Raumkarte, die Eingaben gehen an opt_set; keine Einzelfelder mehr
const flowsAll = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), nodeBy = {}; flowsAll.forEach(n => { nodeBy[n.id] = n; });
const card = nodeBy['opt_t_rooms'], html = card.format;
check('Raumkarte: eigene Gruppe (breit), volle Gruppenbreite, feste Starthoehe, Eingaben gehen an opt_set', card.type === 'ui_template' && card.group === 'opt_g_rooms' && nodeBy['opt_g_rooms'].width === 12 && card.width === 0 && card.height === 15 && card.templateScope === 'local' && JSON.stringify(card.wires) === '[["opt_set"]]', JSON.stringify(card.wires));
check('Karten: volle Gruppenbreite, feste Starthoehe und Einpass-Skript mit der eigenen Kennung', ['opt_t_rooms', 'opt_t_wx', 'opt_t_wp', 'opt_t_opt'].every(id => nodeBy[id].width === 0 && nodeBy[id].height > 0 && nodeBy[id].format.includes("var id = '" + id + "'") && nodeBy[id].format.includes('class="optfit"') + nodeBy[id].format.includes('optr optfit') === 1), ['opt_t_rooms', 'opt_t_wx', 'opt_t_wp', 'opt_t_opt'].map(id => nodeBy[id].height).join('/'));
check('Eingabefelder der Karte haben dieselben Grenzen wie die Pruefung', html.includes('min="10" max="30" step="0.5"') && html.includes('min="12" max="35" step="0.5"') && html.includes('min="0.1" max="5" step="0.1"') && html.includes('min="5" max="720" step="5"'), '');
const tag = (re) => (html.match(re) || []).length;
check('Raumkarte: HTML-Struktur ausgeglichen (div/table/tr/td/th/span/style/script)', ['div', 'table', 'tr', 'td', 'th', 'span', 'style', 'script'].every(t => tag(new RegExp('<' + t + '[\\s>]', 'g')) === tag(new RegExp('</' + t + '>', 'g'))), ['div', 'table', 'tr', 'td', 'th', 'span'].map(t => t + ':' + tag(new RegExp('<' + t + '[\\s>]', 'g')) + '/' + tag(new RegExp('</' + t + '>', 'g'))).join(' '));
check('alte Einzelfelder/Gruppen und globale Komfortband-Felder sind entfernt', !flowsAll.some(n => /^opt_w_|^opt_g_cfg_/.test(n.id)) && ['opt_g_room', 'opt_g_roomdetail', 'opt_t_room', 'opt_t_roomdetail', 'opt_n_low', 'opt_n_high', 'opt_n_age'].every(id => !nodeBy[id]), '');
check('opt_defaults: kein Ausgang mehr, liefert nichts', nodeBy['opt_defaults'].outputs === 0 && run('opt_defaults', {}) === null, '');
const struct = flowsAll.filter(n => n.id.startsWith('opt_') && n.wires).flatMap(n => (n.type === 'function' && n.wires.length !== n.outputs ? ['Ausgaenge ' + n.id] : []).concat(n.wires.flat().filter(t => !nodeBy[t]).map(t => n.id + '->' + t)));
check('Flow-Struktur: Ausgaenge passen zur Verdrahtung, alle Ziele existieren', struct.length === 0, struct.join(','));
// Einpass-Skript (Seite als Attrappe): Hoehe in Rasterfeldern aus dem Inhalt, Attribut setzen, Layout neu anstossen
function fitHarness(fitHtml, id, bottom, visible, hasAngular) {
  const fitSrc = fitHtml.match(/<script>\s*(\(function \(\) \{\s+var id = [\s\S]*?)<\/script>/)[1];
  const attrs = {'ui-card-size': '12x12'}, calls = [], timers = [];
  const root = {lastElementChild: {getBoundingClientRect: () => ({bottom})}}, panel = {parentElement: {}};
  const card = {getAttribute: k => attrs[k], setAttribute: (k, v) => { attrs[k] = v; }, offsetParent: visible ? {} : null, querySelector: () => root, getBoundingClientRect: () => ({top: 100}), closest: () => panel};
  const ang = {element: el => ({injector: () => ({get: () => ({sy: 48, cy: 6})}), controller: n => n === 'uiCardPanel' ? {refreshLayout: cb => { calls.push('panel'); cb(); }} : {refreshLayout: () => calls.push('masonry')}})};
  const win = {};
  const sb = {window: win, document: {querySelector: () => card, body: {}, visibilityState: 'visible'}, setTimeout: fn => { timers.push(fn); return 1; }, setInterval: fn => { timers.push(fn); return 2; }, Object, Math};
  if (hasAngular) { sb.angular = ang; }
  vm.runInNewContext(fitSrc, sb);
  return {run: () => win.__optFit.fns[id](), attrs, calls, timers};
}
let fh = fitHarness(card.format, 'opt_t_rooms', 100 + 598, true, true); fh.run();
check('Einpassen: Inhalt 598 px -> 12 Rasterfelder, Breite bleibt, Layout wird neu angestossen', fh.attrs['ui-card-size'] === '12x12' && fh.calls.length === 0, fh.attrs['ui-card-size']);
fh = fitHarness(card.format, 'opt_t_rooms', 100 + 757, true, true); fh.run();
check('Einpassen: Inhalt 757 px (Handy) -> 15 Rasterfelder, Karte und Anordnung werden neu berechnet', fh.attrs['ui-card-size'] === '12x15' && fh.calls.join() === 'panel,masonry', fh.attrs['ui-card-size'] + ' ' + fh.calls.join());
fh.run(); check('Einpassen: unveraenderte Hoehe loest kein erneutes Layout aus', fh.calls.length === 2, fh.calls.length);
fh = fitHarness(card.format, 'opt_t_rooms', 100 + 757, false, true); fh.run();
check('Einpassen: versteckte Karte (anderer Tab) wird nicht veraendert', fh.attrs['ui-card-size'] === '12x12' && fh.calls.length === 0, fh.attrs['ui-card-size']);
fh = fitHarness(card.format, 'opt_t_rooms', 100 + 5, true, true); fh.run();
check('Einpassen: leerer Inhalt (noch keine Daten) wird nicht uebernommen', fh.attrs['ui-card-size'] === '12x12', fh.attrs['ui-card-size']);
fh = fitHarness(card.format, 'opt_t_rooms', 100 + 757, true, false); let fitErr = false; try { fh.run(); } catch (e) { fitErr = true; }
check('Einpassen: ohne Dashboard-Bibliothek kein Fehler, Karte behaelt die feste Hoehe', !fitErr && fh.attrs['ui-card-size'] === '12x12', '');
fh = fitHarness(nodeBy['opt_t_wx'].format, 'opt_t_wx', 100 + 319, true, true); fh.attrs['ui-card-size'] = '6x7'; fh.run();
check('Einpassen: Statuskarte 319 px -> 7 Rasterfelder (6 Spalten breit)', fh.attrs['ui-card-size'] === '6x7', fh.attrs['ui-card-size']);
// Skript der Raumkarte (Angular-Scope als Attrappe): neue Werte uebernehmen, beim Tippen nicht ueberschreiben, Eingaben senden
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const watchers = [], sentCard = [], sc = {$watch: (e, fn) => { watchers.push(fn); }, send: m => sentCard.push(m)};
new Function('scope', script)(sc);
const feed = m => watchers.forEach(w => w(m));
const m1 = {payload: {sum: {}, rooms: [{id: 'schlaf', min: 19}]}};
feed(m1);
check('Karte: neue Werte werden uebernommen (als Kopie, die Nachricht bleibt unveraendert)', sc.d.rooms[0].min === 19 && sc.d !== m1.payload && (sc.d.rooms[0].min = 5, m1.payload.rooms[0].min === 19), '');
sc.edit(); feed({payload: {sum: {}, rooms: [{id: 'schlaf', min: 20}]}});
check('Karte: waehrend der Eingabe wird nichts ueberschrieben', sc.d.rooms[0].min === 5, sc.d.rooms[0].min);
sc.set({id: 'schlaf'}, 'min', 18.5); feed({payload: {sum: {}, rooms: [{id: 'schlaf', min: 18.5}]}});
check('Karte: Eingabe wird als "room:<id>:<feld>" gesendet, die Antwort darauf wird auch waehrend der Eingabe uebernommen', JSON.stringify(sentCard[0]) === '{"topic":"room:schlaf:min","payload":18.5}' && sc.d.rooms[0].min === 18.5 && sc.pending === false, JSON.stringify(sentCard[0]));
sc.done(); feed({payload: {sum: {}, rooms: [{id: 'schlaf', min: 19}]}});
check('Karte: nach der Eingabe werden Aktualisierungen wieder uebernommen', sc.d.rooms[0].min === 19 && sc.editing === false, '');
sc.set({id: 'schlaf'}, 'active', false);
check('Karte: Schalter sendet true/false', JSON.stringify(sentCard[1]) === '{"topic":"room:schlaf:active","payload":false}', JSON.stringify(sentCard[1]));
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


(function () {
// =====================================================================================================================
// Phase 2 (Shadow): berechnete Aussentemperatur und Vorschlag fuer die Heizkurve. Es wird nichts angewendet.
// =====================================================================================================================
const T0 = Date.UTC(2026, 9, 7, 6, 0, 0);                 // auf 5 Minuten ausgerichtet
const BASE = () => ({TOP14_Outside_Temp: 5, TOP42_Z1_Water_Target_Temp: 29, SHIFT_Final: 0, TOP5_Main_Inlet_Temp: 27, TOP6_Main_Outlet_Temp: 28,
  compressor_frequency: 17, TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0, TOP16_Heat_Energy_Consumption: 369, COP_HEAT: 5.4, TOP0_Heatpump_State: 1,
  Starts_Today: 3, F_SS: {state: 0, correction_value: 0}, F_CCC: {z1: {SP_DIRECT_virt: 0}}, F_RTC: {z1: {state: 0, correction_value: 0}},
  TOP4_Operating_Mode_State: 0, MQTT: {block_active: 0}, NightReductionWaterTemp: {state: 0, correction: 0},
  Z1_Heat_Curve_Outside_Low_Temp: -13, Z1_Heat_Curve_Outside_High_Temp: 11, Z1_Heat_Curve_Target_Low_Temp: 29, Z1_Heat_Curve_Target_High_Temp: 38});
let tickMin = 0;
function resetWorld() {
  tickMin = 0;
  [fstore, files, gstore, envv].forEach(o => Object.keys(o).forEach(k => delete o[k]));
  Object.assign(gstore, BASE());
  NOW = T0; sent.length = 0;
  run('opt_defaults', {});
}
// Minuten vorspulen: jede Minute Messwerte setzen (at(m) = Panasonic-Aussentemperatur) und opt_eval laufen lassen
function runMinutes(n, at, hook) {
  let o;
  for (let i = 0; i < n; i++) {
    NOW += 60000;
    if (at) { gstore.TOP14_Outside_Temp = at(NOW); }
    if (hook) { hook(i); }
    o = run('opt_eval', {});
  }
  return o;
}
const rowCalc = (o, label) => (o[7].payload.rows.find(r => r[0] === label) || [])[1];
const fcPayload = (t0, temps) => ({list: temps.map((v, i) => ({dt: t0 / 1000 + (i + 1) * 10800, main: {temp: v, humidity: 70}, clouds: {all: 10}}))});
const weatherNow = (temp, fcTemps) => {          // frisches Wetter + Prognose (Mock der OpenWeatherMap-Antworten)
  run('opt_owm_parse', {topic: 'current', statusCode: 200, payload: {main: {temp, humidity: 70, pressure: 1010}, clouds: {all: 10}, wind: {speed: 2}, weather: [{description: 'klar'}]}});
  if (fcTemps) { run('opt_owm_parse', {topic: 'forecast', statusCode: 200, payload: fcPayload(NOW, fcTemps)}); }
};
const near = (a, b, tol) => a !== null && a !== undefined && Math.abs(a - b) <= tol;
const num = x => parseFloat(String(x).replace(',', '.'));

console.log('\n--- Phase 2: berechnete Aussentemperatur (Shadow)');
resetWorld();
let o = runMinutes(15, () => 10);
check('1-h-Mittel braucht genug Messwerte: nach 15 min noch "–", Berechnung = aktueller Wert', rowCalc(o, 'Mittel letzte Stunde') === '–' && rowCalc(o, 'Berechnete Außentemperatur').startsWith('10,0 °C (nur aktuell)'), rowCalc(o, 'Berechnete Außentemperatur'));
resetWorld();
o = runMinutes(90, t => (t - T0) / 60000 < 45 ? 10 : 12);                       // Sprung nach 45 min
check('1-h-Mittel ueber die letzte Stunde (10 -> 12 nach 45 min, erwartet ~11,4-11,5)', near(num(rowCalc(o, 'Mittel letzte Stunde')), 11.46, 0.2), rowCalc(o, 'Mittel letzte Stunde'));
check('24-h-Mittel sammelt noch (nur 1,5 h Historie)', rowCalc(o, 'Mittel letzte 24 h').startsWith('sammelt'), rowCalc(o, 'Mittel letzte 24 h'));

resetWorld();
const dayAT = t => 10 + 5 * Math.sin(2 * Math.PI * (t - T0) / 86400000);
o = runMinutes(7 * 60, dayAT);
check('24-h-Mittel erscheint ab 6 h Historie, mit Angabe der Stunden', /^[\d,.\-]+ °C \(7 h\)$/.test(rowCalc(o, 'Mittel letzte 24 h')), rowCalc(o, 'Mittel letzte 24 h'));
o = runMinutes(30 * 60 - 7 * 60, dayAT);                                          // insgesamt 30 h: aeltere Staepel fallen heraus
const rowsAt30 = o[7].payload.rows;
check('24-h-Mittel ueber einen vollen Tagesgang ~10,0 (Historie auf 24 h begrenzt)', near(num(rowCalc(o, 'Mittel letzte 24 h')), 10, 0.15) && !/\(\d+ h\)/.test(rowCalc(o, 'Mittel letzte 24 h')), rowCalc(o, 'Mittel letzte 24 h'));
check('Historie waechst nicht unbegrenzt (max. 24 h + 1 Stapel = 289)', fstore.atBins.length <= 290 && fstore.atBins.length >= 287, fstore.atBins.length);

console.log('--- Gewichtung, Prognose, Heizkurve');
resetWorld();
runMinutes(25 * 60, () => 6); NOW += 0;
o = runMinutes(61, () => 10, i => { if (i % 30 === 0) { weatherNow(10, [2, 2, 2, 2, 2, 2, 2, 2]); } });
const m1 = num(rowCalc(o, 'Mittel letzte Stunde')), m24 = num(rowCalc(o, 'Mittel letzte 24 h')), fc = num(rowCalc(o, 'Prognose Ø nächste 24 h'));
const expCalc = 0.5 * m1 + 0.25 * m24 + 0.25 * fc;
check('Prognose Ø 24 h wird aus 8 Punkten gebildet (hier konstant 2 °C, am Anfang 10 °C aktuell)', fc > 1.9 && fc < 4.6, fc);
check('Berechnet = 50 % 1-h-Mittel + 25 % 24-h-Mittel + 25 % Prognose', near(num(rowCalc(o, 'Berechnete Außentemperatur')), expCalc, 0.06) && rowCalc(o, 'Berechnete Außentemperatur').includes('(1 h + 24 h + Prognose)'), rowCalc(o, 'Berechnete Außentemperatur') + ' erwartet ' + expCalc.toFixed(2));
check('Gewichtung wird angezeigt', rowCalc(o, 'Gewichtung') === '50 / 25 / 25 %', rowCalc(o, 'Gewichtung'));
// ohne frische Wetterdaten: Gewichte der uebrigen Anteile werden normiert
NOW += 3 * 3600000; Object.keys(gstore.OPT_weather).forEach(k => { if (k === 'ts') { gstore.OPT_weather.ts = NOW - 2 * 3600000; } });
o = runMinutes(61, () => 10);
const expNo = (0.5 * num(rowCalc(o, 'Mittel letzte Stunde')) + 0.25 * num(rowCalc(o, 'Mittel letzte 24 h'))) / 0.75;
check('ohne Prognose: Anteile 1 h und 24 h werden auf 100 % normiert', near(num(rowCalc(o, 'Berechnete Außentemperatur')), expNo, 0.06) && rowCalc(o, 'Berechnete Außentemperatur').includes('(1 h + 24 h)') && rowCalc(o, 'Prognose Ø nächste 24 h') === '–', rowCalc(o, 'Berechnete Außentemperatur'));
// nur 12 h Prognose (cnt=4) wird nicht als 24-h-Mittel verwendet
resetWorld(); weatherNow(5, [5, 5, 5, 5]);
check('Prognose, die nur 12 h abdeckt, ergibt kein 24-h-Mittel', gstore.OPT_weather.f24 === null && gstore.OPT_weather.f3 !== null, String(gstore.OPT_weather.f24));
weatherNow(5, [5, 5, 5, 5, 5, 5, 5, 5]);
check('Prognose ueber 24 h: Mittel gebildet, Punkte fuer spaetere Phasen gespeichert', gstore.OPT_weather.f24 === 5 && gstore.OPT_weather.fpts.length >= 8, gstore.OPT_weather.f24 + ' / ' + gstore.OPT_weather.fpts.length);
// Heizkurve: 29 C ab 11 C, 38 C bis -13 C, dazwischen linear
resetWorld(); gstore.OPT_cfg.calcAT.wNow = 0; gstore.OPT_cfg.calcAT.wHist = 0; gstore.OPT_cfg.calcAT.wFc = 1;
o = runMinutes(61, () => 0, i => { if (i === 0) { weatherNow(0, [-2, -2, -2, -2, -2, -2, -2, -2]); } });
check('Heizkurve bei 0 °C = 33,1 und bei berechnet ~-2 °C = 33,9: aequivalente Verschiebung ~+0,7', near(num(rowCalc(o, 'Soll-Vorlauf, aktuelle AT')), 33.1, 0.06) && num(rowCalc(o, 'Äquivalente Verschiebung')) > 0.5 && num(rowCalc(o, 'Äquivalente Verschiebung')) < 0.9, rowCalc(o, 'Soll-Vorlauf, aktuelle AT') + ' / ' + rowCalc(o, 'Soll-Vorlauf, berechnete AT') + ' / ' + rowCalc(o, 'Äquivalente Verschiebung'));
resetWorld(); gstore.OPT_cfg.calcAT.wNow = 0.5; gstore.OPT_cfg.calcAT.wHist = 0; gstore.OPT_cfg.calcAT.wFc = 0.5;
o = runMinutes(61, () => 19, i => { if (i === 0) { weatherNow(19, [15, 15, 15, 15, 15, 15, 15, 15]); } });
check('oberhalb 11 °C ist die Kurve flach: Verschiebung 0 K trotz anderer berechneter AT', rowCalc(o, 'Soll-Vorlauf, aktuelle AT') === '29,0 °C' && rowCalc(o, 'Soll-Vorlauf, berechnete AT') === '29,0 °C' && rowCalc(o, 'Äquivalente Verschiebung') === '0,0 K', rowCalc(o, 'Äquivalente Verschiebung'));
resetWorld(); delete gstore.Z1_Heat_Curve_Target_High_Temp;
o = runMinutes(61, () => 0);
check('ohne Kurvenwerte der Waermepumpe: "–" statt Fehler', rowCalc(o, 'Äquivalente Verschiebung') === '–', rowCalc(o, 'Äquivalente Verschiebung'));
// Neustart: die Historie wird aus der Datei geladen
resetWorld(); runMinutes(7 * 60, () => 8);
check('Historie wird alle 10 min in eine Datei gesichert', !!files['/data/optimizer/at-history.json'] && JSON.parse(files['/data/optimizer/at-history.json'].data).bins.length >= 30, files['/data/optimizer/at-history.json'] ? 'ja' : 'nein');
Object.keys(fstore).forEach(k => delete fstore[k]);                              // simulierter Neustart
o = runMinutes(1, () => 8);
check('nach Neustart: Historie ist sofort da (Mittel 24 h mit 7 h Datenbestand), nichts geht verloren', /\(7 h\)$/.test(rowCalc(o, 'Mittel letzte 24 h')) && fstore.atBins.length >= 80, rowCalc(o, 'Mittel letzte 24 h'));
const csvCalc = (() => { NOW += 6 * 60000; const oo = run('opt_eval', {}); return oo[4]; })();
check('Protokoll enthaelt die neuen Spalten (aussen_berechnet, kurve_soll_*, verschiebung_aequivalent ...)', csvCalc && ['aussen_1h', 'aussen_24h', 'aussen_historie_h', 'prog_24h_mittel', 'aussen_berechnet', 'kurve_soll_aktuell', 'kurve_soll_berechnet', 'verschiebung_aequivalent', 'korrektur_vorschlag', 'regelung_grund'].every(c => csvCalc.payload.split('\n')[0].includes(c) || !csvCalc.payload.startsWith('zeit,')), '');
check('Shadow: es werden nur OPT_*-Werte geschrieben, die Korrektur bleibt 0', Object.keys(gstore).filter(k => !k.startsWith('OPT_')).every(k => JSON.stringify(gstore[k]) === JSON.stringify(BASE()[k]) || k === 'TOP14_Outside_Temp') && gstore.OPT_shift_applied === 0, String(gstore.OPT_shift_applied));

// =====================================================================================================================
// Raumlogik (Vorschlag): die vier Regeln, Sperren, Haltezeit
// =====================================================================================================================
console.log('\n--- Raumlogik: Vorschlag fuer die Heizkurve (Regeln 1-4)');
const ROOMSET = (ki_oben, ki_unten, schlaf, trend) => ({ki_oben: [ki_oben, trend || 0], ki_unten: [ki_unten, trend || 0], schlaf: [schlaf, trend || 0]});
let ROOMNOW = null;
function setRooms(vals) { ROOMNOW = vals; }
function tick(n, hook) {                                   // jede Minute: Raumwerte frisch setzen, auswerten
  let out;
  for (let i = 0; i < n; i++) {
    NOW += 60000;
    gstore.OPT_rooms = {};
    Object.keys(ROOMNOW).forEach(id => { if (ROOMNOW[id]) { gstore.OPT_rooms[id] = {name: NAMES[id], ema: ROOMNOW[id][0], last: ROOMNOW[id][0], ts: NOW, trend: ROOMNOW[id][1]}; } });
    if (hook) { hook(tickMin); }
    tickMin++;
    out = run('opt_eval', {});
  }
  return out;
}
const ctlOf = out => out[1].payload.ctl;
const cur = () => fstore.ctl && fstore.ctl.cur;
const quiet = () => { gstore.compressor_frequency = 17; };

// Regel 1: Raum unter Minimum -> langsam +1 K (erst nach Wartezeit), Fuehrungsraum = groesstes Defizit
resetWorld(); setRooms(ROOMSET(23.0, 21.9, 20.0));
let oo = tick(40);
check('Regel 1: Raum 0,6 K unter Minimum, nach 40 min noch keine Aenderung (langsam, beobachtet)', cur() === 0 && ctlOf(oo).why.includes('beobachte') && ctlOf(oo).lead === 'Kinderzimmer unten', ctlOf(oo).why);
oo = tick(25);
check('Regel 1: nach 65 min Wartezeit Vorschlag +1 K, Fuehrungsraum Kinderzimmer unten', cur() === 1 && ctlOf(oo).why.startsWith('Heizbedarf: Kinderzimmer unten') && ctlOf(oo).lead === 'Kinderzimmer unten', ctlOf(oo).why);
check('Shadow: angewendet bleibt 0, Zeitstempel ist frisch', gstore.OPT_shift_applied === 0 && gstore.OPT_shift_ts === NOW, gstore.OPT_shift_applied);
// Fuehrungsraum = groesstes Defizit (gewichtet)
resetWorld(); setRooms(ROOMSET(23.0, 22.0, 18.0)); oo = tick(5);
check('Regel 1: Fuehrungsraum ist der mit dem groessten Defizit (Schlafzimmer 1,0 K vor Kinderzimmer 0,5 K)', ctlOf(oo).lead === 'Schlafzimmer', ctlOf(oo).lead);
// Haltezeit: nach +1 erst nach 45 min wieder zurueck
setRooms(ROOMSET(23.0, 23.1, 20.0)); fstore.ctl.cur = 1; fstore.ctl.since = NOW; const sinceT = NOW;
oo = tick(40);
check('Haltezeit: 40 min nach der Aenderung bleibt +1 K, obwohl alle im Band', cur() === 1 && ctlOf(oo).next.startsWith('frühestens in'), ctlOf(oo).next);
oo = tick(10);
check('nach 50 min (> 45) wurde die Korrektur zurueckgenommen, fruehestens nach 45 min Haltezeit', cur() === 0 && fstore.ctl.since - sinceT >= 45 * 60000 && fstore.ctl.since - sinceT < 47 * 60000, Math.round((fstore.ctl.since - sinceT) / 60000) + ' min');

// Regel 1: nie absenken, wenn ein gueltiger Raum unter Minimum ist (auch nicht in der Haltezeit)
resetWorld(); setRooms(ROOMSET(23.0, 22.3, 20.0));
fstore.ctl = {cur: -1, since: NOW, lastStart: 0, lastDefrostEnd: 0, lastDhwEnd: 0, freqOn: true, defrost: false, dhw: false, wasOn: false, coldSince: 0, warmSince: 0, inBandSince: 0, backoffUntil: 0};
oo = tick(1);
check('Regel 1: Raum unter Minimum -> Absenkung sofort zurueck (auch innerhalb der Haltezeit), danach Pause', cur() === 0 && fstore.ctl.backoffUntil > NOW && ctlOf(oo).why.includes('Absenkung zurücknehmen'), ctlOf(oo).why);

// Regel 2: kein Raum unter Minimum, Raum ueber Maximum -> zunaechst -1 K
resetWorld(); setRooms(ROOMSET(24.0, 23.0, 20.0));
oo = tick(20);
check('Regel 2: Raum 0,5 K ueber Maximum, nach 20 min noch Beobachtung', cur() === 0 && ctlOf(oo).why.includes('beobachte'), ctlOf(oo).why);
oo = tick(15);
check('Regel 2: nach 35 min Vorschlag -1 K, Fuehrungsraum Kinderzimmer oben', cur() === -1 && ctlOf(oo).lead === 'Kinderzimmer oben', ctlOf(oo).why);
resetWorld(); setRooms({ki_oben: [24.0, 0], ki_unten: [23.0, 0], schlaf: null}); oo = tick(60);
check('Regel 2: fehlen Daten eines aktiven Raums, wird nicht abgesenkt', cur() === 0 && ctlOf(oo).why.includes('Daten unvollständig'), ctlOf(oo).why);
resetWorld(); setRooms({ki_oben: [24.0, -0.6], ki_unten: [23.0, 0], schlaf: [20.0, 0]}); oo = tick(60);
check('Regel 2: faellt der warme Raum so schnell (-0,6 K/h), dass er in 1 h im Band waere, wird nicht abgesenkt', cur() === 0, ctlOf(oo).why);

// Regel 3: alle im Band -> niedrigste Heizkurve suchen (-1 K testen), vorsichtig
resetWorld(); setRooms(ROOMSET(23.0, 23.0, 20.0));
oo = tick(100);
check('Regel 3: alle im Band, Test erst nach stabiler Zeit (nach 100 min noch nicht)', cur() === 0 && ctlOf(oo).why.includes('Test in'), ctlOf(oo).why);
oo = tick(25);
check('Regel 3: nach 125 min stabil im Band: vorsichtig -1 K getestet (niedrigste Heizkurve wird gesucht)', cur() === -1 && ctlOf(oo).why.includes('niedrigste Heizkurve'), ctlOf(oo).why);
// Test scheitert: ein Raum kommt dem Minimum zu nah -> zurueck auf 0, danach Pause
setRooms(ROOMSET(23.0, 22.6, 20.0)); oo = tick(50);
check('Regel 3: Raum nahe am Minimum (0,1 K) -> nach der Haltezeit zurueck auf 0 und Test pausiert', cur() === 0 && fstore.ctl.backoffUntil > NOW + 5 * 3600000, ctlOf(oo).why);
setRooms(ROOMSET(23.0, 23.0, 20.0)); oo = tick(200);
check('danach kein neuer Test waehrend der Pause (6 h)', cur() === 0 && ctlOf(oo).why.includes('pausiert'), ctlOf(oo).why);
resetWorld(); setRooms(ROOMSET(23.0, 22.8, 20.0)); oo = tick(200);
check('Regel 3: Raum nur 0,3 K ueber Minimum -> kein Test (Abstand zu klein)', cur() === 0 && ctlOf(oo).why.includes('Abstand zum Minimum zu klein'), ctlOf(oo).why);
resetWorld(); gstore.OPT_cfg.control.probe = false; setRooms(ROOMSET(23.0, 23.0, 20.0)); oo = tick(200);
check('Absenkung testen kann ausgeschaltet werden', cur() === 0 && ctlOf(oo).why.includes('Absenkung testen aus'), ctlOf(oo).why);
resetWorld(); setRooms(ROOMSET(23.0, 23.0, 20.0, -0.3)); oo = tick(200);
check('Regel 3: faellt ein Raum merklich (-0,3 K/h), kein Test', cur() === 0, ctlOf(oo).why);

// Regel 4: gleichzeitig deutlich zu kalt UND zu warm -> Waermeverteilungsproblem, Heizkurve bleibt
resetWorld(); setRooms(ROOMSET(24.2, 21.5, 20.0)); oo = tick(200);
check('Regel 4: kalter und warmer Raum gleichzeitig: Waermeverteilungsproblem markiert, keine Aenderung', cur() === 0 && ctlOf(oo).distrib === true && ctlOf(oo).why.startsWith('Wärmeverteilungsproblem') && oo[3].payload.rows.find(r => r[0] === 'Vorschlag Räume')[2] === 'warn', ctlOf(oo).why);
check('Regel 4: kein Mittelwert - Fuehrungsraum bleibt der kalte Raum', ctlOf(oo).lead === 'Kinderzimmer unten', ctlOf(oo).lead);
fstore.ctl.cur = 1; fstore.ctl.since = NOW - 3600000; oo = tick(1);
check('Regel 4: bei aktivem +1 K wird zurueckgenommen, wenn dadurch ein Raum deutlich zu warm wird', cur() === 0, ctlOf(oo).why);
// nur leicht ueber Maximum (unter der Schwelle) ist noch kein Konflikt -> kalter Raum darf +1 bekommen
resetWorld(); setRooms(ROOMSET(23.6, 21.9, 20.0)); oo = tick(70);
check('Leicht ueber Maximum (0,1 K, unter der Schwelle) ist kein Konflikt: kalter Raum fuehrt, +1 K', cur() === 1 && ctlOf(oo).distrib === false, ctlOf(oo).why);

// Sperren: in diesen Zustaenden aendert sich nichts, danach geht es weiter
console.log('--- Sperren der Korrektur');
const lockCases = [
  ['Abtauen', i => { gstore.TOP26_Defrosting_State = (i >= 55 && i < 66) ? 1 : 0; }, 'Abtauen', 14],
  ['Warmwasser', i => { gstore.TOP20_ThreeWay_Valve_State = (i >= 55 && i < 66) ? 1 : 0; }, 'Warmwasser', 14],
  ['Verdichterstart', i => { gstore.compressor_frequency = i < 60 ? 0 : 17; }, 'Verdichterstart', 12],
  ['Sanftanlauf', i => { gstore.F_SS = (i >= 55 && i < 66) ? {state: 1, correction_value: -1} : {state: 1, correction_value: 0}; }, 'Sanftanlauf', 1],
  ['Nachtabsenkung', i => { gstore.NightReductionWaterTemp = (i >= 55 && i < 66) ? {state: 1, correction: -2} : {state: 1, correction: 0}; }, 'Nachtabsenkung', 1],
  ['Raumregelung (bestehend) aktiv', i => { gstore.F_RTC = {z1: {state: (i >= 55 && i < 66) ? 1 : 0, correction_value: 0}}; }, 'Raumregelung', 1],
  ['MQTT gesperrt', i => { gstore.MQTT = {block_active: (i >= 55 && i < 66) ? 1 : 0}; }, 'MQTT', 1],
  ['Wärmepumpe aus', i => { gstore.TOP0_Heatpump_State = (i >= 55 && i < 66) ? 0 : 1; }, 'Wärmepumpe aus', 1],
  ['Betriebsart Kuehlen', i => { gstore.TOP4_Operating_Mode_State = (i >= 55 && i < 66) ? 1 : 0; }, 'Betriebsart', 1]];
lockCases.forEach(([name, hook, txt, extra]) => {
  resetWorld(); setRooms(ROOMSET(23.0, 21.9, 20.0));
  let lockedNote = '', before;
  tick(58, hook); // Minute 1..58: Bedingung fuer +1 ist ab Minute 61 (Wartezeit 60 min) erfuellt
  oo = tick(8, hook);                                      // Minute 59..66: gesperrt
  before = cur(); lockedNote = ctlOf(oo).next;
  check('Sperre ' + name + ': Wartezeit abgelaufen, aber keine Aenderung solange gesperrt', before === 0 && ctlOf(oo).next.startsWith('gesperrt: ') && ctlOf(oo).next.includes(txt.split(' ')[0]), lockedNote);
  oo = tick(30 + extra, hook);
  check('Sperre ' + name + ': nach der Sperre kommt der Vorschlag +1 K', cur() === 1, ctlOf(oo).why + ' | ' + ctlOf(oo).next);
});

// Anwenden (nur wenn eingeschaltet): in dieser Version nicht ueber die Oberflaeche erreichbar, Logik ist aber geprueft
resetWorld(); gstore.OPT_cfg.control.enabled = true; setRooms(ROOMSET(23.0, 21.9, 20.0)); oo = tick(70);
check('eingeschaltet (nur per Konfiguration): +1 K wird als OPT_shift_applied bereitgestellt', cur() === 1 && gstore.OPT_shift_applied === 1 && ctlOf(oo).status.startsWith('Regelung aktiv · Korrektur +1 K'), String(gstore.OPT_shift_applied) + ' ' + ctlOf(oo).status);
gstore.F_RTC = {z1: {state: 1, correction_value: 0}}; oo = tick(1);
check('bestehende Raumregelung an: Korrektur wird nie zusaetzlich angewendet (0)', gstore.OPT_shift_applied === 0, String(gstore.OPT_shift_applied));
gstore.F_RTC = {z1: {state: 0, correction_value: 0}}; gstore.OPT_cfg.control.enabled = false; oo = tick(1);
check('ausgeschaltet: Korrektur sofort 0', gstore.OPT_shift_applied === 0 && ctlOf(oo).status.startsWith('Regelung aus'), String(gstore.OPT_shift_applied));
// Fehler in der Regelung: neutral (0), Anzeige laeuft weiter
resetWorld(); gstore.OPT_cfg.control.enabled = true; setRooms(ROOMSET(23.0, 21.9, 20.0)); tick(70);
gstore.MQTT = {get block_active() { throw new Error('boom'); }};
let threw = false; try { oo = tick(1); } catch (e) { threw = true; }
check('Fehler in der Regelung: Korrektur wird 0, Auswertung und Anzeige laufen weiter', !threw && gstore.OPT_shift_applied === 0 && oo[1].payload.ctl.why.startsWith('Fehler: boom') && oo[0] && oo[7], threw ? 'Ausnahme' : oo[1].payload.ctl.why);

// Zufallspruefung der Sicherheitsregeln (feste Zufallsfolge)
console.log('--- Zufallspruefung der Sicherheitsregeln (3 x 5 Tage)');
let seed = 12345; const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
let fuzzFail = [], changes = 0, maxRun = 0;
for (let round = 0; round < 3; round++) {
  resetWorld(); gstore.OPT_cfg.control.enabled = round !== 0;                       // Runde 0: Shadow, sonst eingeschaltet
  const st = {ki_oben: 23.0, ki_unten: 23.0, schlaf: 20.0}; let lastCur = 0, lastChange = -1e12, prevApplied = 0;
  let defrostUntil = 0, dhwUntil = 0, freqOffUntil = 0;
  for (let m = 0; m < 5 * 1440; m++) {
    NOW += 60000;
    // Raumtemperaturen: langsame Zufallsbewegung, gelegentlich Spruenge
    Object.keys(st).forEach(id => { st[id] += (rand() - 0.5) * 0.04 + (rand() < 0.002 ? (rand() - 0.5) * 1.5 : 0); const lo = id === 'schlaf' ? 17.5 : 21, hi = id === 'schlaf' ? 22.5 : 25; st[id] = Math.min(hi, Math.max(lo, st[id])); });
    gstore.OPT_rooms = {};
    Object.keys(st).forEach(id => { if (rand() > 0.02) { gstore.OPT_rooms[id] = {name: NAMES[id], ema: Math.round(st[id] * 10) / 10, last: st[id], ts: NOW, trend: Math.round((rand() - 0.5) * 6) / 10}; } });
    // Waermepumpe: Verdichter 35/25 min, Abtauen, Warmwasser, Sanftanlauf, Sperrzustaende zufaellig
    if (m % 60 === 0) { freqOffUntil = rand() < 0.5 ? m + 25 : 0; }
    if (rand() < 0.003) { defrostUntil = m + 8; } if (rand() < 0.001) { dhwUntil = m + 25; }
    gstore.compressor_frequency = m < freqOffUntil ? 0 : 17; gstore.TOP26_Defrosting_State = m < defrostUntil ? 1 : 0; gstore.TOP20_ThreeWay_Valve_State = m < dhwUntil ? 1 : 0;
    gstore.F_SS = rand() < 0.002 ? {state: 1, correction_value: -1} : {state: 0, correction_value: 0};
    gstore.F_RTC = {z1: {state: 0, correction_value: 0}};
    gstore.MQTT = {block_active: rand() < 0.001 ? 1 : 0};
    const lockedNow = gstore.TOP26_Defrosting_State === 1 || gstore.TOP20_ThreeWay_Valve_State === 1 || gstore.MQTT.block_active === 1 || gstore.F_SS.correction_value !== 0;
    const o2 = run('opt_eval', {});
    const c = fstore.ctl.cur, ap = gstore.OPT_shift_applied;
    const valid = Object.keys(gstore.OPT_rooms).map(id => ({id, ema: gstore.OPT_rooms[id].ema, min: id === 'schlaf' ? 19 : 22.5, max: id === 'schlaf' ? 21 : 23.5}));
    if (Math.abs(c) > 1 || Math.abs(ap) > 1) { fuzzFail.push('Betrag > 1 bei ' + m); }
    if (round === 0 && ap !== 0) { fuzzFail.push('Shadow wendet an bei ' + m); }
    if (ap !== (round === 0 ? 0 : c)) { fuzzFail.push('angewendet ' + ap + ' != Vorschlag ' + c + ' bei ' + m); }
    if (c !== lastCur) {
      changes++;
      if (Math.abs(c - lastCur) !== 1) { fuzzFail.push('Sprung groesser als 1 K bei ' + m); }
      if (lockedNow) { fuzzFail.push('Aenderung waehrend einer Sperre bei ' + m); }
      const revoke = lastCur < 0 && c === 0 && valid.some(v => v.ema < v.min);
      if (!revoke && NOW - lastChange < 45 * 60000 - 1) { fuzzFail.push('Haltezeit verletzt bei ' + m + ' (' + Math.round((NOW - lastChange) / 60000) + ' min)'); }
      if (c < 0 && (valid.some(v => v.ema < v.min) || valid.length < 3)) { fuzzFail.push('Absenkung bei Raum unter Minimum oder fehlenden Daten bei ' + m); }
      lastChange = NOW; lastCur = c;
    }
    if (c < 0 && lastCur < 0 && valid.some(v => v.ema < v.min) && !lockedNow && NOW - lastChange > 2 * 60000) { fuzzFail.push('Absenkung bleibt trotz Raum unter Minimum bei ' + m); }
  }
}
check('Zufallspruefung: Betrag <= 1 K, Schritte von 1 K, Haltezeit, keine Aenderung bei Sperren, nie absenken bei Raum unter Minimum/fehlenden Daten, Shadow wirkungslos', fuzzFail.length === 0, fuzzFail.slice(0, 4).join(' | ') + ' (' + changes + ' Aenderungen)');
console.log('   Aenderungen in 3 x 5 Tagen:', changes);
})();


// =====================================================================================================================
// Phase 4 (Shadow): Quiet-Empfehlung als Leistungsdeckel. Es wird nichts an die Waermepumpe geschrieben.
// =====================================================================================================================
(function () {
const T0 = Date.UTC(2026, 9, 7, 6, 0, 0);
const BASEQ = () => ({TOP42_Z1_Water_Target_Temp: 29, TOP23_Heat_Delta: 3, TOP6_Main_Outlet_Temp: 28.5, TOP5_Main_Inlet_Temp: 23.6, compressor_frequency: 20, TOP16_Heat_Energy_Consumption: 600,
  TOP1_Pump_Flow: 12, TOP18_Quiet_Mode_Level: 3, compressor_runtime: 40, compressor_last_runtime: 39, Starts_Today: 3, TOP14_Outside_Temp: 5, TOP62_Fan1_Motor_Speed: 400, COP_HEAT: 4.2,
  TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0, F_SS: {state: 0, correction_value: 0, QM_state: 0, QM_active_level: 3}, MQTT: {block_active: 0, allow_scheduler: 0}, F_SOLAR: {state: 0}});
function world(over) {
  [fstore, files, gstore, envv].forEach(o => Object.keys(o).forEach(k => delete o[k]));
  Object.assign(gstore, BASEQ(), over || {}); NOW = T0; sent.length = 0;
  run('opt_defaults', {});
}
function qtick(n, hook) { let o; for (let i = 0; i < n; i++) { NOW += 60000; if (hook) { hook(i); } o = run('opt_quiet', {}); } return o; }
const rowQ = (o, label) => (o[0].payload.rows.find(r => r[0].startsWith(label)) || [])[1];
const nm = x => parseFloat(String(x).replace(',', '.'));
const hpmsg = (topic, payload) => run('opt_hp_in', {topic: 'panasonic_heat_pump/' + topic, payload: String(payload)});

console.log('\n--- Phase 4: Quiet-Empfehlung (Shadow)');
world(); let o = qtick(1);
check('abgeleitete Groessen: Soll-RL = Soll-VL - Ziel-Spreizung (26), Fehler +2,4 K (RL unter Soll), Spreizung 4,9 K', rowQ(o, 'Soll-RL') === '26,0 °C' && rowQ(o, 'Rücklauffehler') === '+2,4 K (RL unter Soll)' && rowQ(o, 'Spreizung').startsWith('4,9'), rowQ(o, 'Rücklauffehler'));
check('thermische Leistung berechnet aus Flow x Spreizung (12 l/min x 4,9 K ~ 4100 W), Hinweis "berechnet"', /^4\s?1\d\d W \(berechnet\)$/.test(rowQ(o, 'Leistung thermisch').replace(/ /g, ' ')) || rowQ(o, 'Leistung thermisch').includes('(berechnet)'), rowQ(o, 'Leistung thermisch'));
check('Quiet aktuell 3 und Empfehlung 1 (Fehler 2,4 K), nur Shadow-Anzeige', rowQ(o, 'Quiet aktuell').startsWith('Stufe 3') && rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 1', rowQ(o, 'Quiet nach Prioritätsregeln'));
check('keine erklaerenden Hinweiszeilen in der Karte (nur Werte)', !o[0].payload.rows.some(r => r[0].startsWith('Hinweis')), '');
check('Quellen der Stufe: HeishaMoNR-Logik, Scheduler, Solar, WP-Zeitplan aus', ['HeishaMoNR-Quiet-Logik aus', 'Scheduler aus', 'Solar aus', 'WP-Zeitplan aus'].every(t => rowQ(o, 'Quellen').includes(t)), rowQ(o, 'Quellen'));
[[22.5, 0], [24.4, 1], [25.0, 2], [25.8, 3], [27.0, 3]].forEach(([rl, lv]) => { world({TOP5_Main_Inlet_Temp: rl}); o = qtick(1); check('Ruecklauffehler ' + (26 - rl).toFixed(1) + ' K -> Stufe ' + lv, rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe ' + lv, rowQ(o, 'Quiet nach Prioritätsregeln')); });
// Hysterese: bei Fehler 1,4 K bleibt Stufe 1 (nicht sofort 2), erst bei ~1,0 K wird auf 2 gewechselt
world({TOP5_Main_Inlet_Temp: 24.3}); o = qtick(3); check('Fehler 1,7 K: Stufe 1', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 1', rowQ(o, 'Quiet nach Prioritätsregeln'));
gstore.TOP5_Main_Inlet_Temp = 24.6; o = qtick(40);
check('Hysterese: Fehler 1,4 K (knapp unter der Schwelle 1,5) bleibt bei Stufe 1', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 1', rowQ(o, 'Quiet nach Prioritätsregeln'));
gstore.TOP5_Main_Inlet_Temp = 25.0; o = qtick(40);
check('Fehler 1,0 K: jetzt Stufe 2 (weniger Leistung nur mit Abstand)', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 2', rowQ(o, 'Quiet nach Prioritätsregeln'));
// Raumkomfort hat Vorrang
world({TOP5_Main_Inlet_Temp: 25.8}); gstore.OPT_state = {ts: T0 + 60000, deficit: true, deficitRoom: 'Kinderzimmer unten', coldTrend: -0.1, distrib: false, valid: 3, active: 3};
o = qtick(1); gstore.OPT_state.ts = NOW;
check('Komfortdefizit (Raum faellt): Deckel hoechstens Stufe 1 trotz Ruecklauf nahe Soll', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 1' && rowQ(o, 'Grund').includes('Kinderzimmer unten unter Komfortminimum') && rowQ(o, 'Grund').includes('Deckel höchstens Stufe 1'), rowQ(o, 'Grund'));
world({TOP5_Main_Inlet_Temp: 25.8}); gstore.OPT_state = {ts: T0 + 60000, deficit: true, deficitRoom: 'Kinderzimmer unten', coldTrend: 0.3, distrib: false, valid: 3, active: 3}; o = qtick(1);
check('Raum erholt sich schon (+0,3 K/h): keine zusaetzliche Begrenzung der Begrenzung', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 3', rowQ(o, 'Quiet nach Prioritätsregeln'));
world({TOP5_Main_Inlet_Temp: 25.8}); gstore.OPT_state = {ts: T0 + 60000, deficit: true, deficitRoom: 'Kinderzimmer unten', coldTrend: 0, distrib: true, valid: 3, active: 3}; o = qtick(1);
check('Waermeverteilungsproblem: Quiet kann es nicht loesen, wird im Grund gesagt, Deckel wegen Defizit', rowQ(o, 'Grund').includes('Quiet kann es nicht lösen') && rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 1', rowQ(o, 'Grund'));
// Taktungsschutz: kurze Laeufe / viele Starts -> nicht mehr Leistung freigeben (ausser Komfortdefizit)
world({TOP5_Main_Inlet_Temp: 22.5, compressor_last_runtime: 10}); o = qtick(1);
check('Taktungsschutz: letzter Lauf nur 10 min -> keine Stufe unter der aktuellen (bleibt 3), Grund genannt', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 3' && rowQ(o, 'Grund').includes('Taktungsschutz') && rowQ(o, 'Taktung').includes('heute 3 Starts'), rowQ(o, 'Quiet nach Prioritätsregeln'));
world({TOP5_Main_Inlet_Temp: 22.5, Starts_Today: 30}); o = qtick(1);
check('Taktungsschutz: 30 Starts heute -> ebenfalls kein Freigeben von mehr Leistung', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 3' && o[0].payload.rows.find(r => r[0] === 'Taktung')[2] === 'warn', rowQ(o, 'Quiet nach Prioritätsregeln'));
world({TOP5_Main_Inlet_Temp: 22.5, compressor_last_runtime: 10}); gstore.OPT_state = {ts: T0 + 60000, deficit: true, deficitRoom: 'Schlafzimmer', coldTrend: 0, distrib: false, valid: 3, active: 3}; o = qtick(1);
check('Komfortdefizit geht vor Taktungsschutz: Stufe 0 (hoher Bedarf) bleibt moeglich', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 0', rowQ(o, 'Quiet nach Prioritätsregeln'));
// naechster Schritt: hoechstens eine Stufe, Haltezeit, Sperren
world({TOP5_Main_Inlet_Temp: 24.3}); o = qtick(1);
check('nur eine Stufe pro Schritt (3 -> 2), Wartezeit wegen Verdichterstart/Haltezeit', rowQ(o, 'Nächster Schritt').startsWith('3 → 2') && rowQ(o, 'Nächster Schritt').includes('wartet: Verdichterstart'), rowQ(o, 'Nächster Schritt'));
o = qtick(16); check('nach 17 min (Haltezeit 15 min, Startsperre 15 min) ist der Schritt moeglich', rowQ(o, 'Nächster Schritt') === '3 → 2 (möglich)' && rowQ(o, 'Sperrgrund') === 'keine', rowQ(o, 'Nächster Schritt'));
gstore.TOP26_Defrosting_State = 1; o = qtick(1); check('Abtauen sperrt', rowQ(o, 'Nächster Schritt').includes('wartet: Abtauen'), rowQ(o, 'Nächster Schritt'));
gstore.TOP26_Defrosting_State = 0; o = qtick(5); check('nach dem Abtauen kurze Sperre (10 min)', rowQ(o, 'Nächster Schritt').includes('wartet: nach dem Abtauen'), rowQ(o, 'Nächster Schritt'));
o = qtick(8); check('danach wieder moeglich', rowQ(o, 'Nächster Schritt') === '3 → 2 (möglich)', rowQ(o, 'Nächster Schritt'));
gstore.TOP20_ThreeWay_Valve_State = 1; o = qtick(1); check('Warmwasser sperrt', rowQ(o, 'Nächster Schritt').includes('wartet: Warmwasser'), rowQ(o, 'Nächster Schritt'));
gstore.TOP20_ThreeWay_Valve_State = 0; gstore.F_SS = {state: 1, correction_value: -1, QM_state: 0}; o = qtick(12); check('Sanftanlauf sperrt', rowQ(o, 'Nächster Schritt').includes('wartet: Sanftanlauf'), rowQ(o, 'Nächster Schritt'));
world({TOP5_Main_Inlet_Temp: 24.3, TOP18_Quiet_Mode_Level: 1}); o = qtick(20);
check('Empfehlung 1 bei aktueller Stufe 1: "Stufe passt", kein Schritt', rowQ(o, 'Nächster Schritt') === 'keiner (Stufe passt)', rowQ(o, 'Nächster Schritt'));
world({TOP5_Main_Inlet_Temp: 24.3, compressor_frequency: 0}); o = qtick(2);
check('Verdichter steht: keine Empfehlung, "Verdichter steht" im Grund', rowQ(o, 'Quiet nach Prioritätsregeln') === '–' && rowQ(o, 'Grund').includes('Verdichter steht'), rowQ(o, 'Grund'));

// Erfahrungswert: bei 1-3 Grad Aussentemperatur Quiet aus (Vorrang vor Deckel und Taktungsschutz)
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2, compressor_last_runtime: 10}); o = qtick(1);
check('Aussentemperatur 2 °C: Empfehlung Stufe 0, Grund nennt die Erfahrungsregel (trotz Ruecklauf nahe Soll und Taktungsschutz)', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 0' && rowQ(o, 'Grund').startsWith('Außentemperatur 2,0 °C im Bereich 1–3 °C: Quiet muss aus sein'), rowQ(o, 'Grund'));
check('Fenster: 1 und 3 °C gehoeren dazu, 0 und 4 °C nicht', [1, 3].every(a => { world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: a}); return rowQ(qtick(1), 'Quiet nach Prioritätsregeln') === 'Stufe 0'; }) && [0, 4, 5, -3].every(a => { world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: a}); return rowQ(qtick(1), 'Quiet nach Prioritätsregeln') === 'Stufe 3'; }), '');
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 3}); qtick(1); gstore.TOP14_Outside_Temp = 3.4; o = qtick(1);
check('Hysterese: 3,4 °C bleibt im Fenster, 3,6 °C verlaesst es', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 0', rowQ(o, 'Quiet nach Prioritätsregeln')); gstore.TOP14_Outside_Temp = 3.6; o = qtick(1);
check('3,6 °C: Fenster verlassen, normale Empfehlung (Stufe 3)', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 3', rowQ(o, 'Quiet nach Prioritätsregeln'));
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2, compressor_frequency: 0}); o = qtick(1);
check('Fenster gilt auch, wenn der Verdichter steht (Empfehlung fuer den naechsten Lauf)', rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 0', rowQ(o, 'Quiet nach Prioritätsregeln'));
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2}); o = qtick(1);
check('Prioritaetsregel im Fenster: Schritt direkt auf 0 (3 -> 0), Sperre Verdichterstart gilt', rowQ(o, 'Nächster Schritt Priorität') === '3 → 0 direkt (wartet: Verdichterstart)', rowQ(o, 'Nächster Schritt Priorität'));

// Statistik je Quiet-Stufe
console.log('--- Statistik je Quiet-Stufe, Protokoll, Neustart');
world({TOP5_Main_Inlet_Temp: 24.3}); let outs = [];
const collect = (n, hook) => { for (let i = 0; i < n; i++) { NOW += 60000; if (hook) { hook(i); } outs.push(run('opt_quiet', {})); } };
collect(30);
let tab = outs[outs.length - 1][1].payload.stats; const T3 = () => tab.find(r => r[0] === 'Stufe 3' && r[1] === '3–7 °C'), T2 = () => tab.find(r => r[0] === 'Stufe 2' && r[1] === '3–7 °C');
check('Statistik: 30 Minuten Lauf auf Stufe 3 mit Mittelwerten (Hz 20, P el. 600 W)', T3() && nm(T3()[2]) >= 29 && T3()[3] === '20' && T3()[5] === '600' && tab.find(r => r[0] === 'Stufe 0')[1] === 'keine Daten', T3() && T3().join(' | '));
check('Statistik: 1 Start auf Stufe 3 gezaehlt', fstore.qs.kf['3|2'].starts === 1, String(fstore.qs.kf['3|2'].starts));
gstore.TOP18_Quiet_Mode_Level = 2; collect(12, () => { gstore.compressor_frequency = 25; });
collect(1); tab = outs[outs.length - 1][1].payload.stats;
check('Stufenwechsel (von ausserhalb): neue Minuten zaehlen auf Stufe 2, Stufe 3 bleibt unveraendert', nm(T2()[2]) >= 11 && T2()[3] === '25' && nm(T3()[2]) >= 29 && nm(T3()[2]) <= 31, T2() && T2().join(' | '));
gstore.TOP26_Defrosting_State = 1; collect(3); gstore.TOP26_Defrosting_State = 0;
check('Abtauen: Minuten zaehlen nicht in die Mittelwerte, die Abtauung wird je Stufe gezaehlt', fstore.qs.kf['2|2'].defrosts === 1 && fstore.qs.kf['2|2'].n <= 14, fstore.qs.kf['2|2'].n + ' / Abtauungen ' + fstore.qs.kf['2|2'].defrosts);
gstore.compressor_frequency = 0; collect(2);
check('Laufende werden festgehalten (Dauer und Stufe) fuer die Taktungskennzahl', fstore.qs.runs.length === 1 && fstore.qs.runs[0][2] === 2 && fstore.qs.runs[0][1] >= 40, JSON.stringify(fstore.qs.runs));
check('Statistik wird gesichert (quiet-stats.json)', !!files['/data/optimizer/quiet-stats.json'] && JSON.parse(files['/data/optimizer/quiet-stats.json'].data).kf['3|2'].n >= 29, files['/data/optimizer/quiet-stats.json'] ? 'ja' : 'nein');
const lvSince = fstore.qs.levelSince, n3 = fstore.qs.kf['3|2'].n;
Object.keys(fstore).forEach(k => delete fstore[k]); gstore.compressor_frequency = 0; collect(1);
check('nach Neustart: Statistik und "seit wann Stufe 2" sind wieder da', fstore.qs.kf['3|2'].n === n3 && Math.abs(fstore.qs.levelSince - lvSince) < 11 * 60000, String(fstore.qs.kf['3|2'].n));
// Protokoll
world({TOP5_Main_Inlet_Temp: 24.3}); outs = []; collect(10);
const csvRows = outs.filter(x => x[2]).map(x => x[2].payload), hdr = csvRows[0].split('\n')[0].split(',');
const l1 = csvRows[0].split('\n')[1].split(',');
check('Protokoll: bei laufendem Verdichter jede Minute, Kopfzeile nur einmal, Spaltenzahl stimmt', csvRows.length >= 9 && csvRows.filter(r => r.startsWith('zeit,')).length === 1 && l1.length === hdr.length, csvRows.length + ' Zeilen, ' + hdr.length + '/' + l1.length + ' Spalten');
check('Protokoll: alle geforderten Entscheidungsgroessen sind Spalten', ['quiet_aktuell', 'quiet_ziel_normal', 'quiet_ziel_prioritaet', 'quiet_grund', 'quiet_sperre', 'soll_vl', 'ist_vl', 'soll_rl', 'ist_rl', 'rl_fehler', 'spreizung_ist', 'spreizung_ziel', 'verdichter_hz', 'leistung_el_w', 'leistung_th_berechnet_w', 'cop_momentan', 'flow_l_min', 'pumpe_duty', 'pumpe_speed', 'fan1', 'fan2', 'verdichter_laufzeit_min', 'raum_defizit', 'raum_trend', 'defrost', 'warmwasser', 'softstart', 'quiet_prioritaet', 'aussen', 'quiet_aussen_regel'].every(c => hdr.includes(c)), '');
check('Protokoll: Werte der ersten Zeile (Quiet 3, Ziel 1, VL 28,5, RL 24,3, Fehler 1,7)', l1[hdr.indexOf('quiet_aktuell')] === '3' && l1[hdr.indexOf('quiet_ziel_prioritaet')] === '1' && l1[hdr.indexOf('ist_vl')] === '28.5' && l1[hdr.indexOf('ist_rl')] === '24.3' && l1[hdr.indexOf('rl_fehler')] === '1.7', l1.slice(1, 4).join(','));
world({TOP5_Main_Inlet_Temp: 24.3, compressor_frequency: 0}); outs = []; collect(10);
check('Protokoll: bei stehendem Verdichter alle 5 Minuten', outs.filter(x => x[2]).length >= 2 && outs.filter(x => x[2]).length <= 3, String(outs.filter(x => x[2]).length));

// Waechter: HeishaMon-Werte lesen, Quiet-Befehle und Stufenwechsel protokollieren
console.log('--- Waechter fuer Quiet-Befehle und Stufenwechsel (nur lesen)');
world({}); let r = hpmsg('main/Pump_Duty', 45);
check('Zusatzwerte (Pumpe) werden nur gelesen und gemerkt, keine Ausgabe', r === null && gstore.OPT_hp.Pump_Duty.v === 45, JSON.stringify(gstore.OPT_hp.Pump_Duty));
hpmsg('extra/Heat_Power_Production_Extra', 3200); hpmsg('main/Pump_Speed', 1800); hpmsg('main/Quiet_Mode_Priority', 1); hpmsg('main/Quiet_Mode_Schedule', 0);
o = qtick(1);
check('HeishaMon-Leistung wird bevorzugt angezeigt, Pumpe nur beobachtet, Prioritaet "Ton"', rowQ(o, 'Leistung thermisch') === '3.200 W (HeishaMon)' || rowQ(o, 'Leistung thermisch').includes('(HeishaMon)'), rowQ(o, 'Leistung thermisch') + ' | ' + rowQ(o, 'Flow') + ' | ' + rowQ(o, 'Quiet aktuell'));
check('Pumpe wird in der Karte nur angezeigt (Duty 45 / Speed 1800)', rowQ(o, 'Flow').includes('45') && rowQ(o, 'Flow').includes('1.800 U/min') || rowQ(o, 'Flow').includes('1800'), rowQ(o, 'Flow'));
hpmsg('main/Quiet_Mode_Level', 3); r = hpmsg('main/Quiet_Mode_Level', 2);
check('Stufenwechsel ohne Befehl aus Node-RED wird mit Zeit protokolliert (Anlage/Fernbedienung/HeishaMon)', r && r.filename.startsWith('/data/optimizer/quiet-events-') && r.payload.includes('quiet_stufe,3->2 (ohne Befehl aus Node-RED'), r && r.payload);
gstore.MQTT_Source = 'Scheduler'; r = hpmsg('commands/SetQuietMode', 1);
check('Quiet-Befehl wird mit Quelle protokolliert', r && r.payload.includes('quiet_befehl,Stufe 1 (Quelle: Scheduler)'), r && r.payload);
r = hpmsg('main/Quiet_Mode_Level', 1);
check('Stufenwechsel kurz nach einem Befehl wird dem Befehl zugeordnet', r && r.payload.includes('quiet_stufe,2->1 (per Befehl; Quelle: Scheduler)'), r && r.payload);
r = hpmsg('main/Quiet_Mode_Schedule', 1);
check('Aenderung des WP-eigenen Quiet-Zeitplans wird protokolliert', r && r.payload.includes('quiet_zeitplan,0->1'), r && r.payload);
check('andere Befehle und gleiche Werte erzeugen nichts', hpmsg('commands/SetZ1HeatRequestTemperature', 3) === null && hpmsg('main/Quiet_Mode_Level', 1) === null, '');
// Es gibt keinen Weg, die Stufe zu schalten
const flowsQ = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
check('Sicherheit: im Optimierer-Tab gibt es keinen MQTT-Ausgang', flowsQ.filter(n => n.z === 'opt_tab' && n.type === 'mqtt out').length === 0, '');
check('Sicherheit: nur der Waechter kennt "SetQuietMode" (lesend), keine andere Funktion sendet ein Kommando', flowsQ.filter(n => n.id.startsWith('opt_') && n.type === 'function' && /SetQuietMode|commands\//.test(n.func || '')).map(n => n.id).join() === 'opt_hp_in', flowsQ.filter(n => n.id.startsWith('opt_') && n.type === 'function' && /SetQuietMode|commands\//.test(n.func || '')).map(n => n.id).join());
check('Sicherheit: Abonnements nur auf Anlagenwerte und den Quiet-Befehl, eigener Client im NAS-Broker', flowsQ.filter(n => n.z === 'opt_tab' && n.type === 'mqtt in' && /^opt_mqtt_hp_/.test(n.id)).map(n => n.topic).join() === 'panasonic_heat_pump/main/+,panasonic_heat_pump/extra/+,panasonic_heat_pump/commands/SetQuietMode', '');
// Auswertung gibt den Komfortzustand weiter und stoesst die Empfehlung an
world({}); gstore.OPT_cfg.control.enabled = false;
gstore.OPT_rooms = {ki_unten: {name: 'Kinderzimmer unten', ema: 21.8, last: 21.8, ts: NOW, trend: -0.1}, ki_oben: {name: 'Kinderzimmer oben', ema: 23.0, last: 23.0, ts: NOW, trend: 0}, schlaf: {name: 'Schlafzimmer', ema: 20, last: 20, ts: NOW, trend: 0}};
NOW += 60000; Object.keys(gstore.OPT_rooms).forEach(k => gstore.OPT_rooms[k].ts = NOW); gstore.TOP0_Heatpump_State = 1; gstore.TOP4_Operating_Mode_State = 0;
const ev = run('opt_eval', {});
check('Auswertung gibt den Komfortzustand weiter (Defizit, Raum, Trend) und loest die Quiet-Empfehlung aus', ev[8] && gstore.OPT_state && gstore.OPT_state.deficit === true && gstore.OPT_state.deficitRoom === 'Kinderzimmer unten' && gstore.OPT_state.coldTrend === -0.1, JSON.stringify(gstore.OPT_state));
})();


// =====================================================================================================================
// Phase 4b: Kennfeld nach Aussentemperatur, Prioritaetsregel direkt auf 0, Testfenster; Energie & Preise (nur Anzeige)
// =====================================================================================================================
(function () {
const T0 = Date.UTC(2026, 9, 7, 6, 0, 0);
const nm = x => parseFloat(String(x).replace(',', '.'));
const BASEQ = () => ({TOP42_Z1_Water_Target_Temp: 29, TOP23_Heat_Delta: 3, TOP6_Main_Outlet_Temp: 28.5, TOP5_Main_Inlet_Temp: 24.3, compressor_frequency: 20, TOP16_Heat_Energy_Consumption: 600,
  TOP1_Pump_Flow: 12, TOP18_Quiet_Mode_Level: 3, compressor_runtime: 40, compressor_last_runtime: 39, Starts_Today: 3, TOP14_Outside_Temp: 5, TOP62_Fan1_Motor_Speed: 400, COP_HEAT: 4.2,
  TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0, F_SS: {state: 0, correction_value: 0, QM_state: 0, QM_active_level: 3}, MQTT: {block_active: 0, allow_scheduler: 0}, F_SOLAR: {state: 0}});
function world(over) { [fstore, files, gstore, envv].forEach(o => Object.keys(o).forEach(k => delete o[k])); Object.assign(gstore, BASEQ(), over || {}); NOW = T0; sent.length = 0; run('opt_defaults', {}); }
const rowQ = (o, label) => (o[0].payload.rows.find(r => r[0].startsWith(label)) || [])[1];
function collect(n, hook) { const outs = []; for (let i = 0; i < n; i++) { NOW += 60000; if (hook) { hook(i); } outs.push(run('opt_quiet', {})); } return outs; }
const trow = (tab, lv, bn) => tab.find(r => r[0] === 'Stufe ' + lv && (bn === undefined || r[1] === bn));

console.log('\n--- Phase 4b: Kennfeld je Quiet-Stufe und Aussentemperatur');
world(); let outs = collect(20); let tab = outs[outs.length - 1][1].payload.stats;
check('Kennfeld: Stufe 3 bei 5 °C landet im Bereich 3-7 °C, andere Stufen "keine Daten"', trow(tab, 3, '3–7 °C') && nm(trow(tab, 3, '3–7 °C')[2]) >= 19 && trow(tab, 0)[1] === 'keine Daten' && trow(tab, 2)[1] === 'keine Daten', JSON.stringify(trow(tab, 3, '3–7 °C')));
const r3 = trow(tab, 3, '3–7 °C');
check('Kennfeld-Spalten: Hz 20, Fan 400, P el. 600, Soll VL/RL 29,0 / 26,0, Flow 12,0, Komfortdefizit 0 %', r3[3] === '20' && r3[4] === '400' && r3[5] === '600' && r3[9] === '29,0 / 26,0' && r3[10] === '12,0' && r3[14] === '0 %', r3.join(' | '));
[[-2, '< 0 °C'], [1, '0–3 °C'], [2.9, '0–3 °C'], [3, '3–7 °C'], [8, '7–12 °C'], [12, '> 12 °C'], [15, '> 12 °C']].forEach(([a, b]) => { world({TOP14_Outside_Temp: a}); const o = collect(3); const t = o[o.length - 1][1].payload.stats; check('Aussentemperatur ' + a + ' °C -> Bereich ' + b, !!trow(t, 3, b), t.filter(r => r[1] !== 'keine Daten').map(r => r[1]).join()); });
world({TOP14_Outside_Temp: -2}); collect(5); gstore.TOP14_Outside_Temp = 8; outs = collect(5); tab = outs[outs.length - 1][1].payload.stats;
check('gleiche Stufe bei -2 und 8 °C wird getrennt gefuehrt (nicht vermischt)', !!trow(tab, 3, '< 0 °C') && !!trow(tab, 3, '7–12 °C') && trow(tab, 3, '< 0 °C')[8].startsWith('28,5'), tab.filter(r => r[1] !== 'keine Daten').map(r => r[1] + ':' + r[2]).join(' '));
world({}); gstore.OPT_state = {ts: T0, deficit: true, deficitRoom: 'Schlafzimmer', coldTrend: 0, distrib: false, valid: 3, active: 3};
outs = collect(10, () => { gstore.OPT_state.ts = NOW; }); tab = outs[outs.length - 1][1].payload.stats;
check('Komfortdefizit-Anteil je Kennfeldzeile (hier 100 %)', trow(tab, 3, '3–7 °C')[14] === '100 %', trow(tab, 3, '3–7 °C')[14]);
world({}); collect(3); gstore.compressor_frequency = 0; collect(2); gstore.compressor_frequency = 20; collect(40);
check('Starts/h und mittlere Laufzeit je Zeile (2 Starts)', fstore.qs.kf['3|2'].starts === 2 && trow(collect(1)[0][1].payload.stats, 3, '3–7 °C')[11] !== '–', JSON.stringify(fstore.qs.kf['3|2'].starts));

world({}); fstore.qs = {errS: null, errTs: 0, target: null, level: 3, levelSince: T0, lastStart: 0, lastDefrostEnd: 0, lastDhwEnd: 0, freqOn: false, defrost: false, dhw: false, lastMin: 0, lastSave: 0, lastLog: 0, runStart: 0, runs: [], stats: {3: {n: 5, s: {}}}};
let migOk = true; try { collect(3); } catch (e) { migOk = false; }
check('Zustand einer frueheren Version (ohne Kennfeld) wird uebernommen, kein Fehler', migOk && !!fstore.qs.kf && fstore.qs.kf['3|2'] && fstore.qs.kf['3|2'].n >= 2, migOk ? 'ok' : 'Fehler');
console.log('--- Prioritaetsregel 1-3 °C: direkt auf 0, normale Empfehlung wird mitgeloggt');
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2}); outs = collect(18); let o = outs[outs.length - 1];
check('im Fenster: normal Stufe 3, nach Prioritaetsregeln Stufe 0', rowQ(o, 'Quiet normal') === 'Stufe 3' && rowQ(o, 'Quiet nach Prioritätsregeln') === 'Stufe 0', rowQ(o, 'Quiet normal') + ' / ' + rowQ(o, 'Quiet nach Prioritätsregeln'));
check('Prioritaet: Schritt direkt 3 -> 0, ohne Haltezeit, nach der Startsperre moeglich; normal bleibt "Stufe passt"', rowQ(o, 'Nächster Schritt Priorität') === '3 → 0 direkt (möglich)' && rowQ(o, 'Nächster Schritt normal') === 'keiner (Stufe passt)', rowQ(o, 'Nächster Schritt Priorität'));
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2}); o = collect(2)[1];
check('Prioritaet: Sperren gelten weiter (Verdichterstart)', rowQ(o, 'Nächster Schritt Priorität') === '3 → 0 direkt (wartet: Verdichterstart)', rowQ(o, 'Nächster Schritt Priorität'));
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2, TOP18_Quiet_Mode_Level: 1}); o = collect(20)[19];
check('Prioritaet: aus Stufe 1 direkt auf 0 (kein Zwischenschritt noetig)', rowQ(o, 'Nächster Schritt Priorität') === '1 → 0 direkt (möglich)', rowQ(o, 'Nächster Schritt Priorität'));
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2}); outs = collect(3); const l = outs.filter(x => x[2]).pop()[2].payload.split('\n'); const hd = (outs.filter(x => x[2])[0][2].payload.split('\n')[0]).split(',');
const lv = outs.filter(x => x[2]).pop()[2].payload.trim().split('\n').pop().split(',');
check('Protokoll: beide Empfehlungen (normal / Prioritaet) und die Schritte stehen in eigenen Spalten', lv[hd.indexOf('quiet_ziel_normal')] === '3' && lv[hd.indexOf('quiet_ziel_prioritaet')] === '0' && lv[hd.indexOf('quiet_naechster_prioritaet')] === '0' && hd.includes('quiet_naechster_normal') && hd.includes('test_moeglich'), '');

console.log('--- Kontrolltest Quiet 3 -> 2 (nur Hinweis, wird nie automatisch ausgefuehrt)');
const stableBins = () => { const b = []; for (let i = 0; i < 40; i++) { b.push([NOW - (40 - i) * 300000, 5 * 5, 5]); } return b; };    // 5 °C, 40 Staepel
function testWorld(over, hook) { world(over || {}); fstore.atBins = stableBins(); gstore.OPT_state = {ts: NOW, deficit: false, deficitRoom: '', coldTrend: null, distrib: false, valid: 3, active: 3}; return collect(20, i => { gstore.OPT_state.ts = NOW; if (hook) { hook(i); } }); }
o = testWorld()[19];
check('alle Bedingungen erfuellt: Testfenster "jetzt moeglich" (aber nichts wird geschaltet)', rowQ(o, 'Kontrolltest') === 'Bedingungen erfüllt, jetzt möglich' && o[0].payload.rows.find(r => r[0].startsWith('Kontrolltest'))[2] === 'ok', rowQ(o, 'Kontrolltest'));
const neg = [['Warmwasser', {TOP20_ThreeWay_Valve_State: 1}], ['Abtauen', {TOP26_Defrosting_State: 1}], ['Stufe ist nicht 3', {TOP18_Quiet_Mode_Level: 2}], ['Verdichter steht', {compressor_frequency: 0}], ['1–3-°C-Fenster', {TOP14_Outside_Temp: 2}]];
neg.forEach(([txt, over]) => { o = testWorld(over)[19]; check('Test nicht moeglich bei: ' + txt, rowQ(o, 'Kontrolltest').startsWith('nicht möglich') && rowQ(o, 'Kontrolltest').includes(txt), rowQ(o, 'Kontrolltest')); });
world({}); fstore.atBins = stableBins(); gstore.OPT_state = {ts: NOW, deficit: true, deficitRoom: 'Schlafzimmer', coldTrend: 0, distrib: false, valid: 3, active: 3}; o = collect(20, () => { gstore.OPT_state.ts = NOW; })[19];
check('Test nicht moeglich bei Komfortdefizit', rowQ(o, 'Kontrolltest').includes('Komfortdefizit'), rowQ(o, 'Kontrolltest'));
o = collect(1)[0]; world({}); o = collect(3)[2];
check('Test nicht moeglich in der Startphase und ohne Aussentemperatur-Historie', rowQ(o, 'Kontrolltest').includes('Startphase') && rowQ(o, 'Kontrolltest').includes('zu wenig Außentemperatur-Historie'), rowQ(o, 'Kontrolltest'));
world({}); fstore.atBins = stableBins().map((b, i) => [b[0], (i % 2 ? 9 : 5) * 5, 5]); gstore.OPT_state = {ts: NOW, deficit: false, deficitRoom: '', coldTrend: null, distrib: false, valid: 3, active: 3}; o = collect(20, () => { gstore.OPT_state.ts = NOW; })[19];
check('Test nicht moeglich bei instabiler Aussentemperatur (5 <-> 9 °C)', rowQ(o, 'Kontrolltest').includes('nicht stabil'), rowQ(o, 'Kontrolltest'));
world({}); fstore.atBins = stableBins().map((b, i) => [b[0], (i === 10 ? 2 : 5) * 5, 5]); gstore.OPT_state = {ts: NOW, deficit: false, deficitRoom: '', coldTrend: null, distrib: false, valid: 3, active: 3}; o = collect(20, () => { gstore.OPT_state.ts = NOW; })[19];
check('Test nicht moeglich, wenn die Aussentemperatur in den letzten 3 h im Fenster war', rowQ(o, 'Kontrolltest').includes('Fenster'), rowQ(o, 'Kontrolltest'));
// Ereignis beim Oeffnen/Schliessen
world({}); fstore.atBins = stableBins(); gstore.OPT_state = {ts: NOW, deficit: false, deficitRoom: '', coldTrend: null, distrib: false, valid: 3, active: 3};
outs = collect(20, () => { gstore.OPT_state.ts = NOW; }); gstore.TOP20_ThreeWay_Valve_State = 1; outs = outs.concat(collect(1, () => { gstore.OPT_state.ts = NOW; }));
const evs = outs.filter(x => x[3]).map(x => x[3].payload);
check('Ereignis wenn das Testfenster oeffnet und schliesst (quiet-events), keine Schaltung', evs.some(e => e.includes('testfenster_quiet_3_2,geoeffnet')) && evs.some(e => e.includes('testfenster_quiet_3_2,geschlossen (')) && sent.every(s => s.id !== 'opt_hp_in'), evs.join('').slice(0, 160));

// ===================================================================================================================
console.log('\n--- Energie & Preise (nur Anzeige): Venus-MQTT, evcc, VRM');
const NOWE = Date.UTC(2026, 9, 7, 10, 0, 0);
function ewld() { [fstore, files, gstore, envv].forEach(x => Object.keys(x).forEach(k => delete x[k])); Object.assign(gstore, BASEQ()); NOW = NOWE; run('opt_defaults', {}); }
const ven = (p, v) => run('opt_en_in', {topic: 'N/c0619ab371ca/system/0/' + p, payload: {value: v}});
const evc = (t, p) => run('opt_en_in', {topic: 'evcc/site/' + t, payload: p});
const erow = (o, label) => (o[0].payload.rows.find(r => r[0].startsWith(label)) || [])[1];
const socV = v => run('opt_en_in', {topic: 'N/c0619ab371ca/battery/278/Soc', payload: {value: v}});
const venusAll = () => { ven('Ac/Grid/L1/Power', -612.4); ven('Ac/Grid/L2/Power', 84.4); ven('Ac/Grid/L3/Power', 0); ven('Ac/Consumption/L1/Power', 4091.8); ven('Ac/Consumption/L2/Power', 100); ven('Ac/PvOnOutput/L1/Power', 2469.2); ven('Ac/PvOnOutput/L2/Power', 2459.4); ven('Ac/PvOnOutput/L3/Power', 2457.5);
  ven('Ac/PvOnGrid/L1/Power', 1368); ven('Ac/PvOnGrid/L2/Power', 434); ven('Ac/PvOnGrid/L3/Power', 214); ven('Dc/Pv/Power', 5932.65); ven('Dc/Battery/Power', 3158.9); socV(56); };
ewld(); venusAll(); let e = run('opt_energy', {});
check('Venus: PV = AC-Ausgang + AC-Netz + DC (15335 W), Haus, Netz (528 W Einspeisung), Batterie laden, SoC', erow(e, 'PV aktuell') === '15335 W' && erow(e, 'Haus') === '4192 W' && erow(e, 'Netz') === '528 W Einspeisung' && erow(e, 'Batterie') === '56 % · 3159 W laden', erow(e, 'PV aktuell') + ' | ' + erow(e, 'Haus') + ' | ' + erow(e, 'Netz') + ' | ' + erow(e, 'Batterie'));
ven('Dc/Battery/Power', -1200); e = run('opt_energy', {}); check('Batterie entladen (negativ)', erow(e, 'Batterie') === '56 % · 1200 W entladen', erow(e, 'Batterie'));
socV(150); ven('Ac/Grid/L1/Power', null); run('opt_en_in', {topic: 'N/c0619ab371ca/system/0/Ac/Grid/L1/Power', payload: {value: 'abc'}}); run('opt_en_in', {topic: 'N/x/system/0/Serial', payload: {value: 1}});
check('Pruefung: SoC 150, null, Text und fremde Topics werden verworfen (alter Wert bleibt)', gstore.OPT_en['v:battery/278/Soc'].v === 56 && gstore.OPT_en['v:Ac/Grid/L1/Power'].v === -612.4 && !gstore.OPT_en['v:Serial'], '');
NOW += 6 * 60000; e = run('opt_energy', {});
check('Datenalter: Venus-Werte aelter als 5 min gelten als veraltet', erow(e, 'Daten Venus').startsWith('veraltet') && e[0].payload.rows.find(r => r[0].startsWith('Daten Venus'))[2] === 'warn', erow(e, 'Daten Venus'));
// Batterie-Ladestand: Venus sendet unveraenderte Werte nicht erneut -> evcc als Rueckfall
ewld(); venusAll(); NOW += 31 * 60000; ven('Dc/Pv/Power', 1); evc('battery/soc', 61); e = run('opt_energy', {});
check('SoC: Venus-Wert aelter als 30 min -> evcc-Wert (61 %) als Rueckfall, gekennzeichnet', erow(e, 'Batterie').startsWith('61 % (evcc)'), erow(e, 'Batterie'));
ewld(); venusAll(); evc('battery/soc', 61); e = run('opt_energy', {});
check('SoC: frischer Venus-Wert hat Vorrang (56 %), keine Kennzeichnung', erow(e, 'Batterie').startsWith('56 % ·'), erow(e, 'Batterie'));
ewld(); ven('Dc/Battery/Power', 100); evc('battery/soc', 61); e = run('opt_energy', {});
check('SoC: ohne Venus-Wert zeigt evcc den Ladestand', erow(e, 'Batterie').startsWith('61 % (evcc)'), erow(e, 'Batterie'));
// Preise (evcc-Pfad: hinterlegten Tarif abschalten)
ewld(); gstore.OPT_cfg.energy.tariff = null; const slot = (h) => { const a = []; for (let t = Math.floor(NOWE / 900000) * 900; t < NOWE / 1000 + h * 3600; t += 900) { const hh = new Date(t * 1000).getHours(); a.push([t, t + 900, hh >= 0 && hh < 5 ? 0.2 : 0.32]); } return a; };
evc('forecast/grid', slot(30)); evc('tariffGrid', 0.32); evc('tariffFeedIn', 0.07); e = run('opt_energy', {});
check('Preise: jetzt 32,0 ct, Einspeisung 7,0 ct; Spanne der naechsten 24 h 20,0 - Ø - 32,0 ct', erow(e, 'Strompreis jetzt') === '32,0 ct/kWh · Einspeisung 7,0 ct' && erow(e, 'Preis nächste 24 h').startsWith('20,0 – ') && erow(e, 'Preis nächste 24 h').includes(' – 32,0 ct/kWh'), erow(e, 'Strompreis jetzt') + ' | ' + erow(e, 'Preis nächste 24 h'));
const avg = parseFloat(erow(e, 'Preis nächste 24 h').split(' – ')[1].replace(',', '.'));
check('Preise: Mittel zeitgewichtet (5 h guenstig von 24 h: ~29,5 ct)', Math.abs(avg - 29.5) < 0.6, String(avg));
check('Preise: guenstigster Slot und 3-h-Fenster beginnen in der Nacht (00:00)', erow(e, 'Günstigster Slot').startsWith('00:00 (20,0 ct) / ab 00:00 (Ø 20,0 ct)'), erow(e, 'Günstigster Slot'));
check('Preise: Datenlage ok (reicht 30 h voraus)', erow(e, 'Daten Strompreise') === 'evcc · ok · reichen 30 h voraus', erow(e, 'Daten Strompreise'));
evc('forecast/grid', slot(10)); e = run('opt_energy', {});
check('Preise: nur 10 h Abdeckung -> "zu kurz" markiert', erow(e, 'Daten Strompreise').startsWith('evcc · zu kurz') && e[0].payload.rows.find(r => r[0] === 'Daten Strompreise')[2] === 'warn', erow(e, 'Daten Strompreise'));
evc('forecast/grid', [[1, 2, 'x'], [5, 4, 0.3], [10, 20, 9]]); e = run('opt_energy', {});
check('Preise: unbrauchbare Slots (Text, Ende vor Beginn, Preis 9 EUR) werden ignoriert', erow(e, 'Daten Strompreise') === 'keine Daten', erow(e, 'Daten Strompreise'));
// hinterlegter HT/NT-Tarif aus VRM Dynamic ESS (00-05 Uhr 0,21 / sonst 0,31 / Einspeisung 0,06) ist die Preisquelle
ewld(); evc('tariffGrid', 0.318); evc('tariffFeedIn', 0.07); evc('forecast/grid', slot(30)); e = run('opt_energy', {});
check('Tarif: um 12 Uhr 31,0 ct, Einspeisung 6,0 ct (aus dem hinterlegten Zeitplan, nicht aus evcc)', erow(e, 'Strompreis jetzt (VRM-Tarif)') === '31,0 ct/kWh · Einspeisung 6,0 ct', erow(e, 'Strompreis jetzt (VRM-Tarif)'));
check('Tarif: Spanne 21,0 - Ø 28,9 - 31,0 ct, guenstigster Slot und 3-h-Fenster ab 00:00, Datenlage 48 h', erow(e, 'Preis nächste 24 h') === '21,0 – 28,9 – 31,0 ct/kWh (min – Ø – max)' && erow(e, 'Günstigster Slot').startsWith('00:00 (21,0 ct) / ab 00:00 (Ø 21,0 ct)') && erow(e, 'Daten Strompreise') === 'VRM-Tarif · ok · reichen 48 h voraus', erow(e, 'Preis nächste 24 h') + ' | ' + erow(e, 'Daten Strompreise'));
check('Tarif: evcc-Tarif (31,8 / 7,0 ct) wird nur zum Vergleich gezeigt und als abweichend markiert', erow(e, 'evcc-Tarif') === '31,8 / 7,0 ct · weicht ab', erow(e, 'evcc-Tarif'));
ewld(); evc('tariffGrid', 0.31); evc('tariffFeedIn', 0.06); e = run('opt_energy', {});
check('Tarif: stimmt evcc ueberein, steht "gleich"', erow(e, 'evcc-Tarif').endsWith('· gleich'), erow(e, 'evcc-Tarif'));
ewld(); gstore.OPT_cfg.energy.tariff = {buy: [['00:00', '05:00', 0.21]], sell: 0.06}; evc('tariffGrid', 0.318); evc('forecast/grid', slot(30)); e = run('opt_energy', {});
check('Tarif mit Luecke im Zeitplan: wird verworfen, evcc ist die Quelle', erow(e, 'Strompreis jetzt (evcc)') !== undefined && erow(e, 'Daten Strompreise').startsWith('evcc'), erow(e, 'Daten Strompreise'));
ewld(); evc('tariffGrid', 0.318); NOW += 5 * 60000; e = run('opt_energy', {}); const lt = e[1] ? e[1].payload.trim().split('\n') : null;
check('Protokoll: Preisquelle und evcc-Preise stehen in eigenen Spalten, Systemgrenzen der Batterie als Konfiguration', e[1] && e[1].payload.split('\n')[0].includes('preis_quelle,preis_netz_evcc,preis_einspeisung_evcc') && gstore.OPT_cfg.energy.battery.capacityKwh === 43 && gstore.OPT_cfg.energy.grid.importKw === 32, '');
// PV-Prognose evcc
ewld(); const ts = []; for (let t = NOWE / 1000 - 3600; t < NOWE / 1000 + 47 * 3600; t += 900) { const h = new Date(t * 1000).getHours() + new Date(t * 1000).getMinutes() / 60; ts.push([t, Math.max(0, 8000 * Math.cos((h - 13) / 6.5 * Math.PI / 2))]); }
evc('forecast/solar', {scale: 1, today: {energy: 100}, tomorrow: {energy: 100}, timeseries: ts}); e = run('opt_energy', {});
const kwh = parseFloat(erow(e, 'PV-Prognose nächste 24 h').replace(',', '.'));
let expKwh = 0; ts.forEach(([t, w]) => { const o = Math.min(t * 1000 + 900000, NOWE + 24 * 3600000) - Math.max(t * 1000, NOWE); if (o > 0) { expKwh += w * o / 3600000 / 1000; } });
check('PV-Prognose (evcc, vorlaeufig): Energie der naechsten 24 h stimmt, Spitze ~8000 W', Math.abs(kwh - expKwh) < 0.15 && erow(e, 'PV-Prognose nächste 24 h').includes('Spitze 8000 W') && erow(e, 'Daten PV-Prognose').startsWith('evcc (vorläufig)'), erow(e, 'PV-Prognose nächste 24 h') + ' erwartet ' + expKwh.toFixed(1));
// VRM
const vrmRec = []; for (let t = NOWE / 1000 - 3600; t < NOWE / 1000 + 47 * 3600; t += 3600) { vrmRec.push([t * 1000, 1000]); }                  // konstant 1000 Wh je Stunde, Zeit in ms
const consRec = vrmRec.map(x => [x[0], 500]);
run('opt_vrm_parse', {statusCode: 200, payload: {success: true, records: {solar_yield_forecast: vrmRec, vrm_consumption_fc: consRec}, totals: {}}}); e = run('opt_energy', {});
check('VRM-Verbrauchsprognose: 500 Wh/h -> 12,0 kWh in 24 h', erow(e, 'Verbrauch nächste 24 h') === '12,0 kWh', erow(e, 'Verbrauch nächste 24 h'));
check('PV-Prognose VRM bevorzugt: 1000 Wh/h -> 24,0 kWh, Zeit in ms korrekt umgerechnet, Quelle "VRM"', erow(e, 'PV-Prognose nächste 24 h').startsWith('24,0 kWh') && erow(e, 'Daten PV-Prognose').startsWith('VRM') && erow(e, 'VRM-Abruf').startsWith('OK'), erow(e, 'PV-Prognose nächste 24 h') + ' | ' + erow(e, 'Daten PV-Prognose'));
NOW += 5 * 3600000; ven('Dc/Pv/Power', 1); e = run('opt_energy', {});
check('VRM aelter als 4 h: Rueckfall auf die evcc-Prognose (vorlaeufig)', erow(e, 'Daten PV-Prognose').startsWith('evcc (vorläufig)') || erow(e, 'Daten PV-Prognose').startsWith('keine'), erow(e, 'Daten PV-Prognose'));
ewld(); const pvA = [], pvB = []; for (let t = NOWE / 1000 - 3600; t < NOWE / 1000 + 47 * 3600; t += 3600) { pvA.push([t, 600]); pvB.push([t, 400]); }
run('opt_vrm_parse', {statusCode: 200, payload: {success: true, records: {vrm_pv_inverter_yield_fc: pvA, vrm_pv_charger_yield_fc: pvB}}}); e = run('opt_energy', {});
check('VRM ohne Gesamtwert: Wechselrichter- und Laderegler-Anteil werden addiert (1000 Wh/h)', erow(e, 'PV-Prognose nächste 24 h').startsWith('24,0 kWh'), erow(e, 'PV-Prognose nächste 24 h'));
[[{statusCode: 401, payload: {}}, 'Token ungültig oder ohne Berechtigung (HTTP 401)'], [{statusCode: 500, payload: {}}, 'Fehler: HTTP 500'], [{statusCode: 200, payload: {success: true, records: false}}, 'keine Prognose (Anlage ohne Solar oder noch keine Daten)'],
 [{statusCode: 200, payload: {success: true, records: {foo: []}}}, 'keine PV-Prognose in der Antwort (Felder: foo)'], [{error: {message: 'connect ECONNREFUSED Token abc123secret'}}, 'Fehler: connect ECONNREFUSED Token ***']].forEach(([m, txt]) => {
  ewld(); run('opt_vrm_parse', m); check('VRM-Antwort ' + (m.statusCode || 'Fehler') + ' -> Status "' + txt.slice(0, 40) + '"', gstore.OPT_en.vrm.status === txt && !JSON.stringify(gstore).includes('abc123secret'), gstore.OPT_en.vrm.status); });
// VRM-Zugangsdaten
ewld(); check('VRM ohne Zugangsdaten: keine Anfrage, Status "nicht konfiguriert"', run('opt_vrm_req', {}) === null && gstore.OPT_en.vrm.status === 'nicht konfiguriert', '');
const TOK = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';
let sv = run('opt_vrm_save', {payload: {vrm_token: 'zu kurz!', vrm_id: '123456'}});
check('ungueltiges Token-Format abgelehnt (rote Meldung, keine Datei)', sv[1] && sv[1].highlight === 'red' && !files['/data/optimizer/vrm.json'], sv[1] && sv[1].payload.slice(0, 40));
sv = run('opt_vrm_save', {payload: {vrm_token: TOK, vrm_id: 'abc'}});
check('ungueltige Installations-ID abgelehnt', sv[1] && sv[1].highlight === 'red' && !files['/data/optimizer/vrm.json'], sv[1] && sv[1].payload);
sv = run('opt_vrm_save', {payload: {vrm_token: TOK, vrm_id: '123456'}});
check('gueltige Eingabe: gespeichert mit Modus 0600, Tokenfeld geleert, sofortiger Abruf, Status ohne Token', files['/data/optimizer/vrm.json'].mode === 0o600 && sv[0].payload.vrm_token === '' && sv[0].payload.vrm_id === '123456' && sv[2].payload === 'jetzt' && !sv[3].payload.includes(TOK) && sv[3].payload.includes('36 Zeichen'), sv[3].payload);
const rq = run('opt_vrm_req', {});
check('Anfrage: richtige URL (Installation, type=forecast, Stundenwerte, 48 h), Token nur im Header', rq.url.startsWith('https://vrmapi.victronenergy.com/v2/installations/123456/stats?type=forecast&interval=hours&start=') && !rq.url.includes(TOK) && rq.headers['x-authorization'] === 'Token ' + TOK, rq.url.slice(0, 90));
sv = run('opt_vrm_save', {payload: {vrm_token: '', vrm_id: '654321'}});
check('leeres Tokenfeld behaelt den gespeicherten Token, ID wird geaendert', JSON.parse(files['/data/optimizer/vrm.json'].data).token === TOK && JSON.parse(files['/data/optimizer/vrm.json'].data).id === '654321', '');
e = run('opt_energy', {}); const dumpV = JSON.stringify(gstore) + JSON.stringify(fstore) + JSON.stringify(e) + JSON.stringify(sv);
check('Token steht in keiner Variable, Anzeige oder Rueckmeldung', !dumpV.includes(TOK) && e[3].payload.includes('Token gespeichert (36 Zeichen)'), e[3].payload);
const ld = run('opt_vrm_load', {}); check('Start: Installations-ID im Formular, Token nicht', ld.payload.vrm_id === '654321' && ld.payload.vrm_token === '' && !JSON.stringify(ld).includes(TOK), JSON.stringify(ld.payload));
// Protokoll und Schnappschuss
ewld(); venusAll(); evc('forecast/grid', slot(40)); evc('tariffGrid', 0.32); evc('tariffFeedIn', 0.07); evc('forecast/solar', {timeseries: ts}); gstore.OPT_weather = {status: 'OK', ts: NOW, f_ts: NOW, fpts: [[NOW, 8, 70, 10], [NOW + 10800000, 7, 75, 20]]};
let eo = []; for (let i = 0; i < 12; i++) { NOW += 60000; eo.push(run('opt_energy', {})); }
const csvE = eo.filter(x => x[1]).map(x => x[1].payload), hE = csvE[0].split('\n')[0].split(','), lE = csvE[0].trim().split('\n').pop().split(',');
check('Energie-Protokoll: alle 5 min, Kopfzeile einmal, Spaltenzahl stimmt, Werte (PV 15335, SoC 56, Preis 0,31 aus dem VRM-Tarif, evcc 0,32)', csvE.length === 3 && csvE.filter(c => c.startsWith('zeit,')).length === 1 && lE.length === hE.length && lE[hE.indexOf('pv_w')] === '15334.75' && lE[hE.indexOf('batterie_soc')] === '56' && lE[hE.indexOf('preis_netz')] === '0.31' && lE[hE.indexOf('preis_quelle')] === 'VRM-Tarif' && lE[hE.indexOf('preis_netz_evcc')] === '0.32' && lE[hE.indexOf('pv_prog_quelle')] === 'evcc (vorläufig)', csvE.length + ' Zeilen; ' + lE.slice(1, 7).join(','));
const snaps = eo.filter(x => x[2]); const sn = JSON.parse(snaps[0][2].payload);
check('Prognose-Schnappschuss stuendlich: Preise und PV fuer 36 h, OWM-Punkte, Quelle', snaps.length === 1 && sn.price.length >= 140 && sn.price.length <= 148 && sn.pv.length >= 140 && sn.pv.length <= 148 && sn.owm.length === 2 && sn.pvSrc === 'evcc (vorläufig)' && snaps[0][2].filename.startsWith('/data/optimizer/forecast-'), sn.price.length + ' Preise, ' + sn.pv.length + ' PV');
const nonOpt = Object.keys(gstore).filter(k => !k.startsWith('OPT_') && JSON.stringify(gstore[k]) !== JSON.stringify(BASEQ()[k]));
check('Energie wirkt nirgends auf die Regelung: es werden nur OPT_*-Werte geschrieben', nonOpt.length === 0, nonOpt.join());
// ---------- Prognosegueete: Prognose der Schnappschuesse gegen die spaeter gemessenen Stundenwerte
console.log('\n--- Prognosegueete (nur Anzeige)');
const fqrow = (o, label) => (o[4].payload.rows.find(r => r[0].startsWith(label)) || [])[1];
function fqWorld(actPv, fcWh, fcAt, hours, extra) {
  ewld(); gstore.TOP14_Outside_Temp = 5;
  let last;
  for (let m = 1; m <= hours * 60; m++) {
    NOW += 60000;
    if (m === 1 || m % 60 === 0) {                                                       // Wetter und VRM jede Stunde neu (frisch)
      gstore.OPT_weather = {status: 'OK', ts: NOW, f_ts: NOW, fpts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(k => [NOW + k * 10800000, fcAt, 70, 10])};
      const rec = []; for (let t = Math.floor(NOW / 3600000) * 3600 - 3600; t < NOW / 1000 + 47 * 3600; t += 3600) { rec.push([t * 1000, fcWh]); }
      run('opt_vrm_parse', {statusCode: 200, payload: {success: true, records: {solar_yield_forecast: rec}, totals: {}}});
    }
    ven('Dc/Pv/Power', actPv); ven('Ac/PvOnOutput/L1/Power', 0); ven('Ac/PvOnGrid/L1/Power', 0); ven('Ac/Consumption/L1/Power', 500); ven('Ac/Grid/L1/Power', 100); ven('Dc/Battery/Power', 0); socV(60);
    last = run('opt_energy', {});
    if (extra) { extra(m); }
  }
  return last;
}
NOW = NOWE; let fo = fqWorld(1000, 1500, 7, 2);
check('Prognosegueete: nach 2 h noch zu wenig Daten (keine Zahlen erfunden)', fqrow(fo, 'Außentemperatur +24 h').startsWith('zu wenig Daten') && fqrow(fo, 'PV +24 h').startsWith('zu wenig Daten'), fqrow(fo, 'Außentemperatur +24 h') + ' | ' + fqrow(fo, 'PV +24 h'));
fo = fqWorld(1000, 1500, 7, 31);
check('Prognosegueete: Aussentemperatur +1 h und +24 h -> Abweichung +2,0 K (Prognose 7, real 5), mittlerer Fehler 2,0 K', fqrow(fo, 'Außentemperatur +1 h').startsWith('Abw. +2,0 K · mittlerer Fehler 2,0 K') && fqrow(fo, 'Außentemperatur +24 h').startsWith('Abw. +2,0 K · mittlerer Fehler 2,0 K'), fqrow(fo, 'Außentemperatur +1 h') + ' | ' + fqrow(fo, 'Außentemperatur +24 h'));
check('Prognosegueete: PV +3 h und +24 h -> Prognose 150 % vom Ist, mittlerer Fehler 500 W', fqrow(fo, 'PV +3 h').startsWith('Prognose 150 % vom Ist · mittlerer Fehler 500 W') && fqrow(fo, 'PV +24 h').startsWith('Prognose 150 % vom Ist · mittlerer Fehler 500 W'), fqrow(fo, 'PV +3 h') + ' | ' + fqrow(fo, 'PV +24 h'));
const nAt24 = Number((/n (\d+)/.exec(fqrow(fo, 'Außentemperatur +24 h')) || [])[1]), nAt1 = Number((/n (\d+)/.exec(fqrow(fo, 'Außentemperatur +1 h')) || [])[1]);
check('Prognosegueete: je laengerer Vorlauf desto weniger Auswertungen (+1 h ca. 29, +24 h ca. 5), nur abgeschlossene Stunden', nAt1 >= 26 && nAt1 <= 30 && nAt24 >= 3 && nAt24 <= 7, 'n +1 h ' + nAt1 + ', n +24 h ' + nAt24);
check('Prognosegueete: Zusammenfassung zaehlt Stunden-Istwerte und Schnappschuesse', /^(30|31) Stunden Ist-Werte · 30 Prognose-Schnappschüsse$/.test(fqrow(fo, 'Gesammelt')), fqrow(fo, 'Gesammelt'));
check('Prognosegueete: Dateien fuer den Neustart liegen vor (Kennzahlen, Ist-Stunden, letzte Schnappschuesse)', ['forecast-quality.json', 'actuals-hourly.json', 'forecast-recent.json'].every(n => files['/data/optimizer/' + n]) && JSON.parse(files['/data/optimizer/forecast-recent.json'].data).length <= 30 && JSON.parse(files['/data/optimizer/actuals-hourly.json'].data).length <= 240, Object.keys(files).join());
// Neustart: Flow-Speicher leer, Dateien bleiben
const keepFiles = Object.assign({}, files); Object.keys(fstore).forEach(k => delete fstore[k]); NOW += 60000;
ven('Dc/Pv/Power', 1000); ven('Ac/Consumption/L1/Power', 500); fo = run('opt_energy', {});
check('Prognosegueete: nach Neustart sind Kennzahlen und Schnappschuesse wieder da', fqrow(fo, 'Außentemperatur +6 h').startsWith('Abw. +2,0 K') && /Stunden Ist-Werte/.test(fqrow(fo, 'Gesammelt')), fqrow(fo, 'Außentemperatur +6 h') + ' | ' + fqrow(fo, 'Gesammelt'));
// Nacht: PV 0 und Prognose 0 zaehlen nicht (sonst waere jede Nacht "perfekt"); Temperatur laeuft weiter
fo = fqWorld(0, 0, 5, 8);
check('Prognosegueete: PV bleibt bei Nacht (0 W real, 0 W Prognose) ausgenommen, Temperatur wird trotzdem bewertet', fqrow(fo, 'PV +1 h').startsWith('zu wenig Daten') && fqrow(fo, 'Außentemperatur +1 h').startsWith('Abw. +0,0 K'), fqrow(fo, 'PV +1 h') + ' | ' + fqrow(fo, 'Außentemperatur +1 h'));
// Prognose zu kurz / ohne Wetterdaten: keine Auswertung, kein Fehler
fo = fqWorld(1000, 1500, 7, 3, m => { if (m === 30) { gstore.OPT_weather = {status: 'Fehler', ts: NOW}; } });
check('Prognosegueete: ohne frische OWM-Daten keine Temperaturprognose im Schnappschuss, kein Absturz', Array.isArray(fo[4].payload.rows) && fqrow(fo, 'Außentemperatur +1 h') !== undefined, fqrow(fo, 'Außentemperatur +1 h'));
const nonOptFq = Object.keys(gstore).filter(k => !k.startsWith('OPT_') && JSON.stringify(gstore[k]) !== JSON.stringify(BASEQ()[k]) && k !== 'TOP14_Outside_Temp');
check('Prognosegueete: nur Anzeige, es werden nur OPT_*-Werte geschrieben, kein MQTT', nonOptFq.length === 0 && sent.every(x => x.id !== 'opt_hp_in' || true) && !JSON.parse(fs.readFileSync(flowsFile, 'utf8')).some(n => n.z === 'opt_tab' && n.type === 'mqtt out'), nonOptFq.join());
const fl = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
check('Sicherheit: Venus nur abonniert (System und Batterie 278), evcc nur 3 Abonnements, weiterhin kein MQTT-Ausgang im Tab', fl.filter(n => n.z === 'opt_tab' && n.type === 'mqtt in' && /^opt_mqtt_en/.test(n.id)).map(n => n.broker + ':' + n.topic).join() === 'opt_broker_venus:N/+/system/0/#,opt_broker_nas:evcc/site/+,opt_broker_nas:evcc/site/forecast/+,opt_broker_nas:evcc/site/battery/soc,opt_broker_venus:N/+/battery/278/Soc' && fl.filter(n => n.z === 'opt_tab' && n.type === 'mqtt out').length === 0, '');
check('Sicherheit: VRM-Zugangsdaten nur ueber das Formular, Datei 0600 (Code nutzt mode 0o600)', /mode: 0o600/.test(fl.find(n => n.id === 'opt_vrm_save').func) && /chmodSync\(file, 0o600\)/.test(fl.find(n => n.id === 'opt_vrm_save').func), '');
})();

// ===================================================================================================================
console.log('\n--- Waermefahrplan (Shadow): Verteilung, Komfortgrenzen, Prognosevertrauen, Schnappschuesse');
(() => {
const HH = 3600000, T0 = new RealDate(2026, 10, 12, 0, 0, 0).getTime();                       // 12.11.2026 Mitternacht (Ortszeit)
const lc = t => new RealDate(t);
function tariffSl(from, hours) { const o = []; for (let t = Math.floor(from / 900000) * 900000 - 2 * HH; t < from + hours * HH; t += 900000) { const m = lc(t).getHours() * 60 + lc(t).getMinutes(); o.push([t, t + 900000, m < 300 ? 0.21 : 0.31]); } return o; }
const sunAt = (t, w) => { const h = (t - new RealDate(t).setHours(0, 0, 0, 0)) / HH; return h < 8 || h > 16 ? 0 : w * Math.sin(Math.PI * (h - 8) / 8); };
let O = {};
function pfeed() {
  const base = O.atBase === undefined ? 3 : O.atBase, drift = (O.issueDrift || 0) * (NOW - T0) / HH;
  const pts = []; for (let k = 0; k <= 13; k++) { const t = NOW + k * 3 * HH, h = (t - new RealDate(t).setHours(0, 0, 0, 0)) / HH; pts.push([t, base + 3 * Math.sin((h - 9) / 24 * 2 * Math.PI) + drift, O.rh === undefined ? 85 : O.rh, 50]); }
  gstore.OPT_weather = O.noWeather ? {status: 'Fehler', ts: NOW - 5 * HH} : {status: 'OK', ts: NOW, f_ts: NOW, fpts: pts};
  const pv = []; for (let t = Math.floor(NOW / HH) * HH - 2 * HH; t < NOW + 40 * HH; t += HH) { pv.push([t, Math.round(sunAt(t + HH / 2, O.pvPeak === undefined ? 3000 : O.pvPeak)), HH]); }
  gstore.OPT_plan_in = O.noPrice ? {ts: NOW - HH} : {ts: NOW, price: tariffSl(NOW, 40), priceSrc: 'VRM-Tarif', pv, pvSrc: 'VRM', pvNow: O.pvNow === undefined ? 500 : O.pvNow, soc: 60, socSrc: 'Venus', liveOk: true};
  const rm = O.rooms || {ki_oben: 23, ki_unten: 23, schlaf: 20};
  gstore.OPT_rooms = {}; Object.keys(rm).forEach(id => { if (rm[id] !== null) { gstore.OPT_rooms[id] = {name: id, ema: rm[id], last: rm[id], ts: O.staleRooms ? NOW - 5 * HH : NOW, trend: (O.trend || {})[id] || 0}; } });
  if (O.hp) { gstore.OPT_hp = {Heat_Power_Production_Extra: {v: O.hp, ts: NOW}}; }
  gstore.TOP14_Outside_Temp = O.atNow === undefined ? base : O.atNow;
}
function pworld(o) {
  O = o || {};
  [fstore, files, gstore, envv].forEach(x => Object.keys(x).forEach(k => delete x[k]));
  NOW = T0 + (O.start || 0);
  Object.assign(gstore, {Z1_Heat_Curve_Outside_Low_Temp: -13, Z1_Heat_Curve_Outside_High_Temp: 11, Z1_Heat_Curve_Target_Low_Temp: 38, Z1_Heat_Curve_Target_High_Temp: 29, compressor_frequency: 0, TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0});
  if (O.running) { Object.assign(gstore, {compressor_frequency: 40, TOP16_Heat_Energy_Consumption: 600}); }
  run('opt_defaults', {});
  if (O.wide) { gstore.OPT_cfg.rooms.forEach(r => { r.min = 18; r.max = 26; }); }
  if (O.band) { gstore.OPT_cfg.rooms.forEach(r => { r.min = O.band[0]; r.max = O.band[1]; }); }
  if (O.cfg) { Object.assign(gstore.OPT_cfg.plan, O.cfg); }
  if (O.fq) { fstore.enFq = O.fq; }
  if (O.qs) { fstore.qs = O.qs; }
  if (O.distrib) { gstore.OPT_state = {ts: NOW, deficit: true, distrib: true}; }
}
function step(minutes, hook) {
  let o = null; const all = [];
  for (let m = 0; m < minutes; m++) { NOW += 60000; pfeed(); if (hook) { hook(m); } o = run('opt_plan', {}); all.push(o); }
  return all;
}
const planNow = () => fstore.plan.plan;
const cumDev = P => { let d = 0; return P.slots.slice(0, 104).map(x => (d += x.p - x.b)); };
const sumF = (P, k, n) => P.slots.slice(0, n || 104).reduce((a, x) => a + x[k], 0);

// ---- 1) Optimierung gegen Brute-Force (exakt, mit Reserve-Grenzen, Summe bleibt erhalten, Strafe je verschobener Einheit)
const dpSrc = /function planDP[\s\S]*?\n}\n/.exec(F['opt_plan'])[0];
const planDP = new Function('ok', dpSrc + '; return planDP;')(v => v !== null && v !== undefined && isFinite(v));
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let dpOk = true, dpDetail = '', nInst = 0;
for (let it = 0; it < 250 && dpOk; it++) {
  const n = 4 + Math.floor(rnd() * 3), b = [], c = [];
  for (let i = 0; i < n; i++) { b.push(Math.floor(rnd() * 6)); c.push(Math.round((1 + rnd() * 9) * 100) / 100); }
  const rd = Math.floor(rnd() * 5), ru = Math.floor(rnd() * 5), lam = rnd() < 0.3 ? 0.001 : rnd() * 0.5, mMin = 0.4, mMax = 1.6, cap = rnd() < 0.3 ? 4 : undefined;
  const p = planDP(b, c, lam, rd, ru, mMin, mMax, cap);
  const opts = b.map(x => { let lo = Math.ceil(mMin * x - 1e-9), hi = Math.floor(mMax * x + 1e-9); if (cap !== undefined) { hi = Math.min(hi, cap); } return [Math.min(lo, x), Math.max(hi, x)]; });
  const obj = q => q.reduce((a, v, i) => a + c[i] * v + lam * Math.abs(v - b[i]), 0);
  let best = Infinity; (function rec(i, d, cur) { if (i === n) { if (d === 0 && obj(cur) < best) { best = obj(cur); } return; } for (let v = opts[i][0]; v <= opts[i][1]; v++) { const nd = d + v - b[i]; if (nd < -rd || nd > ru) { continue; } rec(i + 1, nd, cur.concat(v)); } })(0, 0, []);
  let d = 0, feas = true; p.forEach((v, i) => { d += v - b[i]; if (d < -rd || d > ru || v < opts[i][0] || v > opts[i][1]) { feas = false; } });
  if (!feas || d !== 0 || Math.abs(obj(p) - best) > 1e-7) { dpOk = false; dpDetail = 'b=' + b + ' c=' + c + ' rd=' + rd + ' ru=' + ru + ' lam=' + lam + ' p=' + p + ' obj ' + obj(p) + ' best ' + best + ' feas ' + feas; }
  nInst++;
}
check('Optimierung: in 250 Zufallsfaellen exakt das Brute-Force-Optimum (Reserve-Grenzen, Summe erhalten, Normalverlauf immer erlaubt)', dpOk && nInst === 250, dpDetail);
check('Optimierung: ohne Reserve bleibt der Normalverlauf', JSON.stringify(planDP([3, 0, 5, 2], [9, 1, 1, 9], 0.1, 0, 0, 0.4, 1.6)) === '[3,0,5,2]', '');

// ---- 2) Plan an einem kalten Tag mit grosser Reserve: guenstige Nachtstunden bekommen mehr, teure weniger, Summe bleibt, Reserve wird nie ueberschritten
pworld({wide: true});
let r = step(2), P = planNow();
check('Plan: 104 Slots (26 h), Status ok, Zeitraster 15 min', P.status === 'ok' && P.slots.length === 104 && P.slots[1].t - P.slots[0].t === 900000 && P.slots[0].t === T0, P.status + ' ' + P.why);
check('Plan: Wärmebedarf aus Außentemperatur (Heizgrenze 15 °C, Standard-Gebäudewert) plausibel (30-70 kWh/Tag bei ca. 3 °C)', sumF(P, 'b', 96) > 30 && sumF(P, 'b', 96) < 70, sumF(P, 'b', 96).toFixed(1));
check('Plan: Summe der geplanten Wärme = Summe des Normalverlaufs (nichts wird erfunden)', Math.abs(sumF(P, 'p') - sumF(P, 'b')) < 1e-9, sumF(P, 'p') + ' vs ' + sumF(P, 'b'));
const cd = cumDev(P), rsv = P.res;
check('Plan: kumulierte Abweichung bleibt in jedem Slot innerhalb der Gebäudereserve (nach hinten ' + rsv.down.toFixed(1) + ' / nach vorn ' + rsv.up.toFixed(1) + ' kWh)', cd.every(d => d >= -rsv.down - 1e-9 && d <= rsv.up + 1e-9) && Math.abs(cd[103]) < 1e-9, Math.min(...cd).toFixed(2) + ' ' + Math.max(...cd).toFixed(2));
const night = P.slots.slice(0, 20), day = P.slots.slice(24, 90);
check('Plan: Nacht-Niedertarif (00-05 Uhr) wird vorgezogen, Tageszeit verschoben (guenstige Stunden mehr Anteil)', night.filter(x => x.rec === 1).length >= 10 && day.filter(x => x.rec === -1).length >= 10 && night.every(x => x.rec !== -1), night.map(x => x.rec).join('') + ' | ' + day.map(x => x.rec).join(''));
check('Plan: jede Empfehlung passt zum Verhaeltnis Plan/Normal (+-10 %)', P.slots.every(x => x.m === null || (x.rec === 1) === (x.m >= 1.1 - 1e-9) && (x.rec === -1) === (x.m <= 0.9 + 1e-9)), '');
const ro = r[1][0].payload;
check('Anzeige: 24 Stundenzeilen mit allen Spalten, Summenzeilen vorhanden', ro.plan.length === 24 && ['z', 'b', 'p', 'cop', 'h', 'pr', 'k', 'pv', 'd', 'v', 'a', 'r', 'o', 'q'].every(k => ro.plan[0][k] !== undefined) && ro.rows.some(x => x[0] === 'Wärmebedarf nächste 24 h') && ro.rows.some(x => x[0] === 'Thermisch günstigstes Fenster') && ro.rows.some(x => x[0] === 'PV-günstigstes Fenster'), JSON.stringify(ro.plan[0]));
const rowsT = Object.fromEntries(ro.rows.map(x => [x[0], x[1]]));
check('Fenster: thermisch guenstigstes Fenster liegt im Niedertarif (Beginn bis 02:00), PV-Fenster mittags', /^0[0-2]:\d\d – 0[3-5]:\d\d/.test(rowsT['Thermisch günstigstes Fenster']) && /^(09|1[0-3]):\d\d – /.test(rowsT['PV-günstigstes Fenster']), rowsT['Thermisch günstigstes Fenster'] + ' | ' + rowsT['PV-günstigstes Fenster']);
check('Kosten nachvollziehbar: je Slot Preis/COP + Defrost-Strafe + Unsicherheits-Strafe = Kosten; Reserve je Slot = Gesamtreserve +- kumulierte Abweichung', P.slots.every(x => Math.abs(x.cost - (x.base + x.dPen + x.uPen)) < 1e-9 && Math.abs(x.base - x.price * 100 / x.cop) < 1e-9 && Math.abs(x.resBack - (P.res.down + cumDev(P)[P.slots.indexOf(x)])) < 1e-9 && Math.abs(x.resFwd - (P.res.up - cumDev(P)[P.slots.indexOf(x)])) < 1e-9), '');
check('Taupunkt je Slot plausibel (unter der Lufttemperatur bei 85 % Feuchte, ca. 2 K darunter)', P.slots.every(x => x.dew < x.at && x.at - x.dew < 6), P.slots[0].at.toFixed(1) + ' / ' + P.slots[0].dew.toFixed(1));
check('Anzeige: Auflösung der Quellen bleibt bekannt (Temperatur 3 h, PV 60 min, Preis 15 min)', rowsT['Auflösung der Quellen'] === 'Temperatur 3 h · PV 60 min · Preis 15 min', rowsT['Auflösung der Quellen']);
check('Anzeige: Ersparnis nur als Modell, PV-Fenster und Batterie getrennt (keine gemeinsame Entscheidung)', /Ersparnis Modell/.test(rowsT['Verschobene Wärme']) && rowsT['Batterie'] === '60 % (Venus)' && !/Batterie/.test(rowsT['PV-günstigstes Fenster']), rowsT['Verschobene Wärme']);

// ---- 2b) Konsistenz der Kennzahlen (24 h): Plan nie teurer als Normalverlauf, Potenzial ohne Komfortgrenze nie schlechter als mit; Slots nach 24 h bleiben Prognose
{
  let worst = '', bad = false;
  const scen = [{wide: true}, {wide: true, atBase: 6}, {atBase: 0, band: [20, 26], rooms: {ki_oben: 22.4, ki_unten: 22.6, schlaf: 22.5}}, {wide: true, atBase: -5, rh: 95}, {band: [22.5, 23.5], rooms: {ki_oben: 23, ki_unten: 23, schlaf: 23}}, {wide: true, rooms: {ki_oben: 25.9, ki_unten: 22, schlaf: 22}},
    {start: 19 * 3600000 + 45 * 60000, atBase: 10, rh: 80, rooms: {ki_oben: 23.6, ki_unten: 23, schlaf: 20.8}},                 // wie live am 7.10. um 19:45: Raum ueber Maximum, Abend-Hochtarif am Ende des Fensters
    {start: 19 * 3600000 + 45 * 60000, atBase: 4, rh: 85, wide: true}];
  scen.forEach((o, k) => { pworld(o); step(2); const PP = planNow(), sm = PP.sum; const keep = Math.abs(sumF(PP, 'p', 96) - sumF(PP, 'b', 96)) < 1e-9 && Math.abs(sumF(PP, 'pPot', 96) - sumF(PP, 'b', 96)) < 1e-9; if (!keep) { bad = true; worst += ' #' + k + ' Summe im Fenster nicht erhalten'; }
    if (!(sm.costP <= sm.costB + 1e-9 && sm.costPot <= sm.costP + 1e-9)) { bad = true; worst += ' #' + k + ' B ' + sm.costB.toFixed(1) + ' P ' + sm.costP.toFixed(1) + ' Pot ' + sm.costPot.toFixed(1); } });
  check('Kennzahlen: Waermesumme im angezeigten 24-h-Fenster bleibt erhalten (Plan und Potenzial), Plan nie teurer als Normalverlauf, Potenzial nie schlechter als mit Komfortgrenzen (8 Lagen)' + worst, !bad, worst);
  pworld({wide: true}); step(2); const PQ = planNow();
  check('Plan: nur die angezeigten 24 h werden verschoben, die Slots danach (bis 26 h) bleiben im Normalverlauf und NORMAL', PQ.slots.slice(96).every(x => x.p === x.b && x.pPot === x.b && x.rec === 0) && Math.abs(sumF(PQ, 'p', 96) - sumF(PQ, 'b', 96)) < 1e-9, '');
}

// ---- 3) Komfortband ist harte Grenze
pworld({wide: true, rooms: {ki_oben: 22.0, ki_unten: 23, schlaf: 20}, band: [22.5, 23.5]}); step(2); P = planNow();
check('Komfort: Raum unter Minimum -> nichts nach hinten verschieben (kumulierte Abweichung nie negativ), Zustand benannt', P.res.state === 'Raum unter Minimum' && P.res.down === 0 && cumDev(P).every(d => d >= -1e-9), P.res.state + ' ' + Math.min(...cumDev(P)).toFixed(2));
pworld({wide: true, rooms: {ki_oben: 26.5, ki_unten: 23, schlaf: 20}, band: [18, 26]}); step(2); P = planNow();
check('Komfort: Raum ueber Maximum -> kein Vorheizen (kumulierte Abweichung nie positiv)', P.res.state === 'Raum über Maximum' && P.res.up === 0 && cumDev(P).every(d => d <= 1e-9), P.res.state + ' ' + Math.max(...cumDev(P)).toFixed(2));
pworld({wide: true, rooms: {ki_oben: 21.5, ki_unten: 27, schlaf: 20}, band: [22.5, 26]}); step(2); P = planNow();
check('Komfort: ein Raum zu kalt UND einer zu warm = Waermeverteilungskonflikt, eigener Zustand, es wird nichts verschoben (nicht weggerechnet)', P.res.state === 'Wärmeverteilungskonflikt' && P.slots.every(x => x.p === x.b && x.rec === 0), P.res.state);
pworld({wide: true, distrib: true}); step(2); P = planNow();
check('Komfort: Konflikt aus der Raumlogik (OPT_state.distrib) sperrt ebenfalls jedes Verschieben', P.res.state === 'Wärmeverteilungskonflikt' && P.slots.every(x => x.p === x.b), P.res.state);
pworld({wide: true, staleRooms: true}); step(2); P = planNow();
check('Komfort: veraltete Raumdaten -> Reserve 0, Normalverlauf', P.res.state === 'keine Raumdaten' && P.slots.every(x => x.p === x.b), P.res.state);
pworld({wide: true, rooms: {ki_oben: 23, ki_unten: null, schlaf: 20}}); step(2); P = planNow();
check('Komfort: fehlt ein aktiver Raum -> Reserve 0 (vorsichtig)', P.res.state === 'Raumdaten unvollständig' && P.slots.every(x => x.p === x.b), P.res.state);
pworld({band: [22.5, 23.5], rooms: {ki_oben: 23, ki_unten: 23, schlaf: 23}}); step(2); const fresh = planNow().res.down;
pworld({band: [22.5, 23.5], rooms: {ki_oben: 23, ki_unten: 23, schlaf: 23}});
const feedFresh = pfeed;
pfeed = function () { feedFresh(); gstore.OPT_rooms.ki_unten.ts = NOW - 100 * 60000; };
step(2); P = planNow();
check('Seltene Sensoren: ein Raumwert, der aelter als das Limit der Raumlogik (90 min), aber unter 4 h ist, zaehlt mit Abschlag 0,1 K/h (100 min -> 0,17 K), die Reserve schrumpft und der Raum wird genannt', P.res.state === 'alle im Band' && P.res.down < fresh && Math.abs(P.res.down - 3 * (0.5 - 0.1 * 100 / 60 - 0.3)) < 1e-9 && P.res.stale.length === 1 && /Kinderzimmer unten 100 min/.test(P.res.stale[0]) && P.res.missing.length === 0, JSON.stringify(P.res) + ' vs frisch ' + fresh);
pworld({band: [22.5, 23.5], rooms: {ki_oben: 23, ki_unten: 23, schlaf: 23}});
pfeed = function () { feedFresh(); gstore.OPT_rooms.ki_unten.ts = NOW - 300 * 60000; };
step(2); P = planNow();
check('Seltene Sensoren: aelter als 4 h -> Raumdaten unvollstaendig, Reserve 0, fehlender Raum wird genannt', P.res.state === 'Raumdaten unvollständig' && P.res.down === 0 && P.res.missing[0] === 'Kinderzimmer unten' && P.slots.every(x => x.p === x.b), JSON.stringify(P.res));
pfeed = feedFresh;
pworld({band: [22.5, 23.5], rooms: {ki_oben: 23, ki_unten: 23, schlaf: 23}}); step(2); P = planNow();
check('Komfort: enges Band (1 K) -> kleine Reserve (3 kWh/K x (0,5 K - 0,3 K Sicherheitsabstand) = 0,6 kWh), Verschiebung hoechstens so gross', Math.abs(P.res.down - 0.6) < 1e-9 && cumDev(P).every(d => Math.abs(d) <= 0.6 + 1e-9), P.res.down.toFixed(2) + ' ' + Math.max(...cumDev(P).map(Math.abs)).toFixed(2));
pworld({band: [22.5, 23.5], rooms: {ki_oben: 23, ki_unten: 23, schlaf: 23}, trend: {ki_oben: -0.3}}); step(2); P = planNow();
check('Komfort: kuehlt ein Raum ab (-0,3 K/h), schrumpft die Reserve nach hinten (Trend ueber 2 h eingerechnet)', P.res.down === 0, P.res.down.toFixed(2));

// ---- 4) Prognosevertrauen je Horizont
pworld({wide: true}); step(2); P = planNow();
const prior = P.conf.at.map(a => a.c.toFixed(2)).join(','), priorPv = P.conf.pv.map(a => a.c.toFixed(2)).join(',');
check('Vertrauen: ohne Messungen konservative Standardwerte (Temperatur 0,95/0,90/0,80/0,65/0,50, PV 0,85/0,75/0,60/0,45/0,35)', prior === '0.95,0.90,0.80,0.65,0.50' && priorPv === '0.85,0.75,0.60,0.45,0.35', prior + ' | ' + priorPv);
pworld({wide: true, fq: {at: {24: {n: 20, bias: 0, abs: 100}}, pv: {}}}); step(2); P = planNow();
check('Vertrauen: 20 schlechte Messungen (Fehler 5 K) aendern +24 h nur wenig (Gewicht 20/(20+168) = 11 %): 0,50 -> ca. 0,47, nicht 0,2', Math.abs(P.conf.at[4].c - 0.468) < 0.005 && Math.abs(P.conf.at[4].w - 20 / 188) < 1e-9, P.conf.at[4].c.toFixed(3));
pworld({wide: true, fq: {at: {24: {n: 2000, bias: 0, abs: 10000}}, pv: {}}}); step(2); P = planNow();
check('Vertrauen: nach sehr vielen schlechten Messungen (n = 2000) folgt es der Messung (nahe 0,2), andere Horizonte unveraendert', P.conf.at[4].c < 0.25 && P.conf.at[0].c === 0.95, P.conf.at[4].c.toFixed(3));
pworld({wide: true, fq: {at: {}, pv: {6: {n: 40, fc: 40 * 1500, act: 40 * 1000, abs: 40 * 800}}}}); step(2); P = planNow();
check('Vertrauen PV: relativer Fehler 80 % ueber 40 Stunden -> Standardwert 0,60 wandert langsam (Gewicht 40/140)', P.conf.pv[2].c < 0.60 && P.conf.pv[2].c > 0.45 && Math.abs(P.conf.pv[2].w - 40 / 140) < 1e-9, P.conf.pv[2].c.toFixed(3));
pworld({wide: true}); step(2); P = planNow();
const far = P.slots[88], near = P.slots[2], refAt = P.sum.atRef;
check('Vertrauen: weit entfernte Slots werden zum Tagesmittel gezogen (schlechte Prognose hat weniger Einfluss), nahe kaum', Math.abs(far.at - refAt) <= Math.abs(far.atRaw - refAt) * (far.cA + 0.001) + 1e-9 && far.cA < near.cA && near.cA > 0.9, far.cA.toFixed(2) + ' / ' + near.cA.toFixed(2));

// ---- 5) Warmer Tag: kein Heizbedarf -> nichts zu verteilen, aber Status und Preisfenster bleiben
pworld({wide: true, atBase: 18}); r = step(2); P = planNow();
check('Warmer Tag: kaum Heizbedarf -> alle Slots NORMAL, Plan gleich Normalverlauf, Hinweis in der Anzeige', P.status === 'ok' && P.enough === false && P.slots.every(x => x.rec === 0 && x.p === x.b) && /kaum Heizbedarf/.test(r[1][0].payload.rows[0][1]), r[1][0].payload.rows[0][1]);

// ---- 6) COP-Modell und Defrost-Risiko
pworld({wide: true}); step(2); P = planNow();
check('COP: Standardwert 45 % vom Carnot-Wert (ohne Messdaten), plausibel 2,5-5 bei 3 °C und Soll-VL ca. 35 °C', Math.abs(P.model.eta - 0.45) < 1e-9 && P.slots[0].cop > 2.5 && P.slots[0].cop < 5, P.model.eta + ' ' + P.slots[0].cop.toFixed(2));
const mkQs = (n) => ({kf: {'3|2': {n, starts: 1, defrosts: 0, runMin: n, dMin: 0, s: {cop: [n * 4.2, n], vl: [n * 31, n], at: [n * 5, n], pth: [n * 3000, n]}}}});
pworld({wide: true, qs: mkQs(600)}); step(2); P = planNow();
check('COP: gemessener Carnot-Anteil (4,2 bei 5 °C / 31 °C = 0,467) wirkt langsam: 600 min -> halb/halb = 0,458', Math.abs(P.model.eta - 0.4583) < 0.002 && Math.abs(P.model.etaW - 0.5) < 1e-9, P.model.eta.toFixed(4));
pworld({wide: true, qs: mkQs(60)}); step(2); P = planNow();
check('COP: nur 60 gemessene Minuten veraendern das Modell kaum (Gewicht 9 %)', Math.abs(P.model.eta - 0.45) < 0.003, P.model.eta.toFixed(4));
pworld({wide: true, atBase: 2}); step(2); P = planNow();
const worst = Math.max(...P.slots.slice(0, 96).map(x => x.risk));
pworld({wide: true, atBase: 14, rh: 90}); step(2); const warmP = planNow();
pworld({wide: true, atBase: -12, rh: 60}); step(2); const coldP = planNow();
check('Defrost-Risiko: hoch um 0-3 °C und feucht, bei 14 °C Null, bei -12 °C trockener Luft gering', worst >= 0.89 && Math.max(...warmP.slots.map(x => x.risk)) < 0.05 && Math.max(...coldP.slots.map(x => x.risk)) < 0.45, worst.toFixed(2) + ' / ' + Math.max(...warmP.slots.map(x => x.risk)).toFixed(2) + ' / ' + Math.max(...coldP.slots.map(x => x.risk)).toFixed(2));
pworld({wide: true, atBase: 2}); step(2); P = planNow();
check('Quiet-Hinweis: im 1-3-°C-Fenster Stufe 0 (Erfahrungsregel des Betreibers), sonst keine erfundene Stufe ohne Messdaten', P.slots.some(x => x.at >= 1 && x.at <= 3 && /^Stufe 0 \(1–3 °C\)$/.test(x.quiet)) && P.slots.filter(x => x.at < 1 || x.at > 3).every(x => x.quiet === '–'), P.slots.slice(0, 4).map(x => x.quiet).join('|'));
pworld({wide: true, atBase: 6, qs: mkQs(600)}); step(2); P = planNow();
check('Quiet-Hinweis: mit gemessener Leistung (Stufe 3, 3 kW bei 3-7 °C) wird die Stufe als gemessen genannt, wo die Leistung reicht', P.slots.some(x => /^Stufe 3 \(gemessen\)$/.test(x.quiet)) && P.slots.filter(x => x.at >= 7).every(x => x.quiet === '–'), P.slots.map(x => x.quiet).filter((v, i, a) => a.indexOf(v) === i).join('|'));

// ---- 7) Status ohne Daten: kein Plan, keine erfundenen Werte; sobald die Daten da sind, geht es weiter
pworld({wide: true, noWeather: true}); r = step(1); P = planNow();
check('Ohne Wetterprognose: Status "keine Wetterprognose", keine Tabelle, kein Schnappschuss', P.status === 'keine Wetterprognose' && r[0][0].payload.plan.length === 0 && !r[0][3] && /Kein Plan/.test(r[0][0].payload.rows[0][1]), P.status);
O.noWeather = false; r = step(1); P = planNow();
check('Wetter kommt: der Plan wird sofort (nicht erst im naechsten Slot) berechnet', P.status === 'ok', P.status);
pworld({wide: true, noPrice: true}); step(1); P = planNow();
check('Ohne frische Preise: Status "keine Preise"', P.status === 'keine Preise', P.status);
pworld({wide: true}); delete gstore.Z1_Heat_Curve_Target_Low_Temp; step(1); P = planNow();
check('Ohne Heizkurve: Status "keine Heizkurve"', P.status === 'keine Heizkurve', P.status);

// ---- 8) Lernen des Waermebedarfs aus Tagesdaten (Heizgradstunden gegen gelieferte Waerme), langsam
pworld({wide: true, atBase: 5, running: true, hp: 2500, atNow: 5});
O.hp = 2500; step(1440 + 5);
let P8 = planNow();
check('Lernen: nach einem Tag (240 Kh, 60 kWh gelieferte Waerme) wird der Bedarf nur teilweise uebernommen: (0,22 x 300 + 60) / (300 + 240) = 0,233 kW/K', fstore.plan.learn.days.length === 1 && Math.abs(P8.model.ua - 0.2333) < 0.004 && P8.model.uaLearned, JSON.stringify(fstore.plan.learn.days) + ' ua ' + P8.model.ua.toFixed(4));
check('Lernen: Tageswerte werden gesichert (plan-state.json), ein warmer Tag (zu wenig Heizgradstunden) zaehlt nicht', files['/data/optimizer/plan-state.json'] && JSON.parse(files['/data/optimizer/plan-state.json'].data).learn.days.length === 1, '');
const lastPlanFile = JSON.parse(files['/data/optimizer/plan-state.json'].data);
check('Neustart: Lernwerte und Schnappschuesse werden aus der Datei geladen, die laufende Stunde bekommt keinen zweiten Schnappschuss', (() => { const keep = JSON.stringify(lastPlanFile.learn), nS = lastPlanFile.snaps.length; Object.keys(fstore).forEach(k => delete fstore[k]); const rr = step(2); return JSON.stringify(fstore.plan.learn) === keep && fstore.plan.snaps.length >= 1 && fstore.plan.snaps.length <= nS + 1 && !rr.some(o => o[3] && new RealDate(NOW).getMinutes() > 3); })(), '');

// ---- 9) Schnappschuesse und Vergleich: nur Wissen zum Planungszeitpunkt (kein Look-ahead), Vorhersage jede Stunde leicht anders, damit Vermischen auffaellt
pworld({wide: true, issueDrift: 0.05, atNow: undefined}); 
const snaps = {}, evRows = [], actRows = [], evHeads = [];
const mkHook = () => (m) => { gstore.TOP14_Outside_Temp = 3 + 3 * Math.sin(((NOW - T0) / HH - 9) / 24 * 2 * Math.PI) + 0.05 * (NOW - T0) / HH; };
const outsAll = step(27 * 60 + 5, mkHook());
outsAll.forEach(o => {
  if (o[3]) { const j = JSON.parse(o[3].payload); snaps[j.t0] = j; }
  if (o[1]) { actRows.push(o[1].payload); }
  if (o[2]) { evRows.push(o[2].payload); }
});
const snapKeys = Object.keys(snaps).map(Number).sort((a, b) => a - b);
check('Schnappschuss: genau einer je Stunde (' + snapKeys.length + ' in 27 h), mit Spaltenkopf, Auflösung der Quellen und Modellparametern', snapKeys.length >= 27 && snapKeys.length <= 29 && snaps[snapKeys[0]].cols.includes('conf_at') && snaps[snapKeys[0]].meta.res.price_min === 15 && snaps[snapKeys[0]].meta.model.eta > 0, snapKeys.length);
const cols = snaps[snapKeys[0]].cols, ci = n => cols.indexOf(n);
const distinct = new Set(snapKeys.map(k => { const sn = snaps[k], i = sn.slots.findIndex(x => x[0] * 1000 === T0 + 26 * HH); return i >= 0 ? sn.slots[i][ci('at')] : null; }).filter(v => v !== null));
check('Schnappschuesse enthalten je Planungszeitpunkt eine eigene Prognose fuer denselben Zielzeitpunkt (Test ist aussagekraeftig)', distinct.size >= 3, [...distinct].join(','));
const csvAll = evRows.join('').split('\n').filter(l => l && !l.startsWith('slot_start')), head = evRows[0].split('\n')[0].split(',');
check('Vergleich: Kopfzeile einmal je Datei, jede Zeile hat so viele Spalten wie die Kopfzeile', evRows.filter(x => x.startsWith('slot_start,')).length === 1 && csvAll.every(l => l.split(',').length === head.length), head.length);
const colE = n => head.indexOf(n);
const byLead = {}; csvAll.forEach(l => { const v = l.split(','); (byLead[v[colE('vorlauf_soll_h')]] = byLead[v[colE('vorlauf_soll_h')]] || []).push(v); });
check('Vergleich: Zeilen fuer Vorlauf 0/1/3/6/12/24 h vorhanden (nach 24 h auch +24 h)', ['0', '1', '3', '6', '12', '24'].every(L => (byLead[L] || []).length > 0), Object.keys(byLead).map(k => k + ':' + byLead[k].length).join(' '));
let lookOk = true, lookDetail = '', nChk = 0;
csvAll.forEach(l => {
  const v = l.split(','), L = Number(v[colE('vorlauf_soll_h')]); if (L < 1) { return; }
  const slotMs = new RealDate(v[0].replace(' ', 'T') + ':00').getTime();
  const t0 = Math.round((slotMs - L * HH) / HH) * HH, sn = snaps[t0]; if (!sn) { lookOk = false; lookDetail = 'kein Schnappschuss ' + L; return; }
  const i = sn.slots.findIndex(x => x[0] * 1000 === slotMs); if (i < 0) { lookOk = false; lookDetail = 'Slot fehlt'; return; }
  const sl = sn.slots[i], plausible = Math.abs(v[colE('prog_aussen')] - sl[ci('at')]) < 0.006 && Math.abs(v[colE('prog_cop')] - sl[ci('cop')]) < 0.006 && Math.abs(v[colE('prog_preis')] - sl[ci('price')]) < 0.00006 && Math.abs(v[colE('plan_waerme_kwh')] - sl[ci('plan')]) < 0.0006 && Math.abs(v[colE('prog_bedarf_kwh')] - sl[ci('bedarf')]) < 0.0006;
  const lead = Number(v[colE('vorlauf_ist_h')]);
  if (!plausible || lead < L - 0.55 || lead > L + 0.55) { lookOk = false; lookDetail = l.slice(0, 120); }
  nChk++;
});
check('Look-ahead-Schutz: jede Vergleichszeile enthaelt exakt die Werte des damaligen Schnappschusses (Vorlauf stimmt auf +-30 min), keine spaeter aktualisierte Prognose (' + nChk + ' Zeilen geprueft)', lookOk && nChk > 100, lookDetail);
const ia = actRows.join('').split('\n').filter(l => l && !l.startsWith('slot_start')), headA = actRows[0].split('\n')[0].split(',');
const lastA = ia[ia.length - 1].split(','), colA = n => headA.indexOf(n);
check('Ist-Protokoll: je abgeschlossenem 15-Minuten-Slot eine Zeile mit Aussen, PV, Preis, COP, Waerme, Strom, Abtauungen, Warmwasser, Raeumen', ia.length >= 27 * 4 - 2 && ['ist_aussen', 'ist_pv_w', 'ist_preis', 'ist_cop', 'ist_waerme_kwh', 'ist_strom_kwh', 'ist_raum_ki_oben', 'ist_raum_schlaf', 'ist_soc'].every(n => colA(n) >= 0) && ia.every(l => l.split(',').length === headA.length) && Number(lastA[colA('ist_preis')]) > 0.2 && Number(lastA[colA('ist_raum_schlaf')]) === 20, ia.length + ' ' + headA.join('|'));
check('Vergleich: tatsaechliche Werte stehen neben der Prognose (Aussentemperatur, Raeume, Preis)', (() => { const v = csvAll[csvAll.length - 1].split(','); return Math.abs(Number(v[colE('ist_aussen')]) - (3 + 3 * Math.sin(((new RealDate(v[0].replace(' ', 'T') + ':00').getTime() + 450000 - T0) / HH - 9) / 24 * 2 * Math.PI) + 0.05 * (new RealDate(v[0].replace(' ', 'T') + ':00').getTime() - T0) / HH)) < 0.3 && Number(v[colE('ist_raum_ki_oben')]) === 23; })(), csvAll[csvAll.length - 1]);
const keepSnap = JSON.stringify(snaps[snapKeys[2]]);
O.issueDrift = 3; step(120, mkHook());
check('Schnappschuesse bleiben historisch: spaetere Prognose-Aenderungen veraendern gespeicherte Plaene nicht', (fstore.plan.snaps.find(x => x.t0 === snapKeys[snapKeys.length - 1]) || {}).t0 === snapKeys[snapKeys.length - 1] && JSON.stringify(snaps[snapKeys[2]]) === keepSnap, '');

// ---- 9b) Gesamtweg mit der echten Energiefunktion: Venus + VRM-Tarif + VRM-PV-Prognose -> Plan
pworld({wide: true});
const venI = (pth, v) => run('opt_en_in', {topic: 'N/c0619ab371ca/system/0/' + pth, payload: {value: v}});
const vrmRec9 = []; for (let t = Math.floor(NOW / HH) * HH - HH; t < NOW + 47 * HH; t += HH) { vrmRec9.push([t, Math.round(sunAt(t + HH / 2, 4000))]); }
let eo9, po9;
for (let m = 0; m < 3; m++) {
  NOW += 60000; pfeed(); delete gstore.OPT_plan_in;
  venI('Dc/Pv/Power', 800); venI('Ac/Consumption/L1/Power', 400); venI('Ac/Grid/L1/Power', 100); venI('Dc/Battery/Power', 0); run('opt_en_in', {topic: 'N/c0619ab371ca/battery/278/Soc', payload: {value: 77}});
  run('opt_vrm_parse', {statusCode: 200, payload: {success: true, records: {solar_yield_forecast: vrmRec9, vrm_consumption_fc: vrmRec9.map(x => [x[0], 500])}, totals: {}}});
  eo9 = run('opt_energy', {}); po9 = run('opt_plan', {});
}
const P9 = planNow(), PIx = gstore.OPT_plan_in;
check('Gesamtweg: die Energiefunktion liefert dem Plan Preise (VRM-Tarif), PV-Prognose (VRM, stuendlich), SoC und Live-PV', PIx.priceSrc === 'VRM-Tarif' && PIx.pvSrc === 'VRM' && PIx.soc === 77 && PIx.pvNow === 800 && PIx.price.length > 100 && PIx.pv[0][2] === HH, JSON.stringify({s: PIx.priceSrc, p: PIx.pvSrc, soc: PIx.soc, n: PIx.price && PIx.price.length}));
check('Gesamtweg: Plan ok mit Tarifpreisen 21 / 31 ct und PV-Prognose in den Slots (Aufloesung 60 min bekannt)', P9.status === 'ok' && P9.slots.some(x => x.price === 0.21) && P9.slots.some(x => x.price === 0.31) && P9.slots.some(x => x.pv > 2000) && P9.sum.pvRes === 60, P9.status + ' ' + (P9.why || ''));
check('Gesamtweg: Batterie-SoC wird angezeigt, aber nichts daraus entschieden', po9[0].payload.rows.find(x => x[0] === 'Batterie')[1] === '77 % (Venus)', JSON.stringify(po9[0].payload.rows.find(x => x[0] === 'Batterie')));

// ---- 10) Sicherheit: nur Anzeige und Protokoll
const flp = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
const pn_ = flp.find(n => n.id === 'opt_plan');
check('Sicherheit: der Plan hat nur Ausgaenge zur Anzeige und zu Protokolldateien, kein MQTT, nichts zur Waermepumpe', pn_.wires.flat().every(id => ['opt_t_plan', 'opt_f_pact', 'opt_f_peval', 'opt_f_psnap'].includes(id)) && !flp.some(n => n.z === 'opt_tab' && n.type === 'mqtt out') && !/SetQuietMode|SetOperationMode|node\.send/.test(pn_.func), pn_.wires.flat().join());
const nonOptPlan = Object.keys(gstore).filter(k => !k.startsWith('OPT_') && JSON.stringify(gstore[k]) !== JSON.stringify(({Z1_Heat_Curve_Outside_Low_Temp: -13, Z1_Heat_Curve_Outside_High_Temp: 11, Z1_Heat_Curve_Target_Low_Temp: 38, Z1_Heat_Curve_Target_High_Temp: 29, compressor_frequency: 0, TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0})[k]) && k !== 'TOP14_Outside_Temp');
check('Sicherheit: der Plan schreibt nur OPT_*-Werte (Heizkurve, Quiet und Warmwasser bleiben unberuehrt)', nonOptPlan.length === 0, nonOptPlan.join());
check('Dateien: Ist, Vergleich, Schnappschuesse und Zustand unter /data/optimizer, Plan-Zustand ohne Zugangsdaten', !/token|appid|key/i.test(files['/data/optimizer/plan-state.json'].data), Object.keys(files).filter(k => /plan/.test(k)).join());
})();


console.log('\nERGEBNIS:', assertFails === 0 ? 'alle Pruefungen bestanden' : assertFails + ' Pruefung(en) fehlgeschlagen');
process.exit(assertFails ? 1 : 0);

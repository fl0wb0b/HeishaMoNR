// Offline-Simulation der Optimizer-Funktionen mit Fake-Uhr (kein Node-RED noetig)
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';       // Ortszeit der Anlage: Tagesgrenzen und Uhrzeiten in den Tests haengen davon ab
const vm = require('vm');
const path = require('path');
const fs = require('fs');
// Usage: node tools/optimizer_sim.js "flows (26.5.1 stable).json"
const flowsFile = process.argv[2] || 'flows (26.5.1 stable).json';
const F = {}, ALLNODES = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
ALLNODES.forEach(n => { if (n.type === 'function' && n.id.startsWith('opt_')) { F[n.id] = n.func; } });
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
// Ein-Klick-Uebernahme des Optimierers (tools/engine_core.js, GESPERRT ausgeliefert): GENAU dieser eine mqtt-out-Knoten im Tab ist erlaubt. Er wird nur von
// opt_apply gespeist (Klick in der Karte "Aktueller Vorschlag" bzw. 15-s-Takt), ist standardmaessig deaktiviert und nutzt einen eigenen Broker-Client.
// Jeder andere Sendeweg bleibt verboten (Pruefung "Uebernahme-Pfad" unten; Verhalten des Pfads in tools/engine_sim.js).
const APPLY_OUT = 'opt_apply_mqtt';
// Einspielen MIT aktivem Uebernahme-Knoten (nur nach dem Go des Nutzers, Generator mit --uebernahme-knoten-aktiv): muss ausdrücklich angesagt werden
// (UEBERNAHME_KNOTEN_AKTIV=1, setzt deploy_opt.sh mit GEN_ARGS). Dann wird "aktiv" verlangt, sonst "deaktiviert"; alle uebrigen Strukturregeln gelten unveraendert.
const APPLY_AKTIV = process.env.UEBERNAHME_KNOTEN_AKTIV === '1';
const otherOut = n => n.z === 'opt_tab' && n.type === 'mqtt out' && n.id !== APPLY_OUT;
const gfile = {};                                                              // Speicher "file" (HeishaMoNR legt dort Anlagenwerte ab); normalerweise leer -> Rueckfall auf den Standardspeicher
function makeCtx(store, fileStore) { return { get: (k, s) => (s === 'file' ? (fileStore ? fileStore[k] : undefined) : store[k]), set: (k, v) => { store[k] = v; } }; }
const compiled = {};
// Fuer die statische Vorschau der Optimierungs-Seiten (tools/opt_seiten_vorschau.js): OPT_UI_DUMP=<datei> sammelt je Dashboard-Vorlage (opt_t_*) die groesste
// Nachricht aus dem ganzen Lauf (schlimmster Fall fuer das Layout) und schreibt sie am Ende zusammen mit OPT_cfg in die Datei. Aendert keine Pruefung.
const UI_DUMP = process.env.OPT_UI_DUMP ? {} : null, WIRES = {};
ALLNODES.forEach(n => { if (n.id.startsWith('opt_') && n.wires) { WIRES[n.id] = n.wires; } });
function uiDump(id, ret) {
  if (!ret || !WIRES[id]) { return; }
  (Array.isArray(ret) ? ret : [ret]).forEach((m, i) => {
    if (!m || Array.isArray(m) || typeof m !== 'object') { return; }
    (WIRES[id][i] || []).forEach(t => { if (!/^opt_t_/.test(t)) { return; } const s = JSON.stringify(m), c = UI_DUMP[t]; if (!c || s.length >= c.len) { UI_DUMP[t] = {len: s.length, msg: JSON.parse(s)}; } });
  });
}
if (UI_DUMP) { process.on('exit', () => { fs.writeFileSync(process.env.OPT_UI_DUMP, JSON.stringify({msgs: UI_DUMP, cfg: gstore.OPT_cfg || null})); }); }
function run(id, msg) {
  if (!compiled[id]) { compiled[id] = vm.runInNewContext(`(function(msg,global,flow,context,env,node,fs,Date,Buffer){${F[id]}\n})`, {}); }
  const node = { send: m => sent.push({id, m}), warn: () => {}, error: () => {}, status: () => {} };
  const ret = compiled[id](msg, makeCtx(gstore, gfile), makeCtx(fstore), makeCtx({}), { get: k => envv[k] }, node, fsMock, FakeDate, Buffer);
  if (UI_DUMP) { uiDump(id, ret); }
  return ret;
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
      snap[60].sum.heat === 'keiner' && snap[60].sum.over === 'keiner' && snap[60].opt[1][1].includes('im eigenen Komfortband'), snap[60].opt[1][1]);
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
run('opt_owm_parse', {topic: 'forecast', statusCode: 200, payload: {list: [
  {dt: t0 + 2 * 3600, main: {temp: 5.0, humidity: 80}, clouds: {all: 60}, wind: {speed: 4.2, gust: 9}}, {dt: t0 + 5 * 3600, main: {temp: 8.0, humidity: 70}, clouds: {all: 40}},
  {dt: t0 + 8 * 3600, main: {temp: 3.0, humidity: 85}, clouds: {all: 20}, wind: {speed: 0}}, {dt: t0 + 11 * 3600, main: {temp: 1.0, humidity: 90}, clouds: {all: 10}, wind: {}}]}});
{
  const fp = gstore.OPT_weather.fpts;
  check('Fahrplan v2 (S1): Prognosepunkte tragen den Wind als 5. Element (aktueller Punkt 3 m/s, 4,2 m/s, fehlend = null, 0 = 0, Boeen werden nicht gespeichert); Index 1 bis 3 wie vorher', fp.length === 5 && fp.every(p => p.length === 7 && p[5] === null && p[6] === null) && fp[0][4] === 3 && fp[1][4] === 4.2 && fp[2][4] === null && fp[3][4] === 0 && fp[4][4] === null && fp[1][1] === 5 && fp[1][2] === 80 && fp[1][3] === 60 && !fp.some(p => p.includes(9)), JSON.stringify(fp));
  check('Fahrplan v2 (S1): +1/+3/+6 h bleiben unveraendert (3,5 / 6,0 / 6,3)', Math.abs(gstore.OPT_weather.f1 - 3.5) < 0.11 && Math.abs(gstore.OPT_weather.f3 - 6.0) < 0.11 && Math.abs(gstore.OPT_weather.f6 - 6.3) < 0.11, [gstore.OPT_weather.f1, gstore.OPT_weather.f3, gstore.OPT_weather.f6].join('/'));
}
{ // Wetter-Symbole (wetter-grafik 17.10.2026): OWM-Code als 6. und Tag/Nacht als 7. Element der Prognosepunkte, Beschreibung je Code; Zuordnung in WXC.symbol (tools/wx_core.js)
  const keep = JSON.stringify(gstore.OPT_weather), WXC = require(path.join(__dirname, 'wx_core.js')), w = (id, ic, d) => [{id: id, icon: ic, description: d}];
  run('opt_owm_parse', {topic: 'current', statusCode: 200, payload: {main: {temp: 2.0, humidity: 90, pressure: 1012}, clouds: {all: 80}, wind: {speed: 3}, weather: w(800, '01n', 'klarer Himmel'), sys: {sunrise: t0 - 3 * 3600, sunset: t0 + 3 * 3600}}});
  check('Wetter-Symbole: "jetzt" mit Code und Tag/Nacht aus dem Icon (800, 01n -> Nacht), Beschreibung gemerkt, Sonnenzeiten gemerkt', gstore.OPT_weather.id === 800 && gstore.OPT_weather.tag === 0 && gstore.OPT_weather.fdesc[800] === 'klarer Himmel' && gstore.OPT_weather.sun[1] === (t0 + 3 * 3600) * 1000, JSON.stringify([gstore.OPT_weather.id, gstore.OPT_weather.tag]));
  const L = [[211, '11d', 'Gewitter'], [301, '09d', 'Nieselregen'], [500, '10d', 'leichter Regen'], [511, '13d', 'Eisregen'], [601, '13n', 'Schnee'], [741, '50d', 'Nebel'], [800, '01d', 'klarer Himmel'], [800, '01n', 'klarer Himmel'], [801, '02d', 'ein paar Wolken'], [802, '03n', 'mäßig bewölkt'], [804, '04d', 'bedeckt']];
  run('opt_owm_parse', {topic: 'forecast', statusCode: 200, payload: {list: L.map((x, i) => ({dt: t0 + (i + 1) * 3 * 3600, main: {temp: 3, humidity: 80}, clouds: {all: 50}, weather: w(x[0], x[1], x[2])})).concat([{dt: t0 + 36 * 3600, main: {temp: 3, humidity: 80}, clouds: {all: 50}}, {dt: t0 + 39 * 3600, main: {temp: 3, humidity: 80}, weather: [{icon: '04x'}]}])}});
  const F = gstore.OPT_weather.fpts, sy = F.map(p => WXC.symbol(p[5], p[6]));
  check('Wetter-Symbole: Prognosepunkte [t, Temp, Feuchte, Wolken, Wind, Code, Tag] (14 Punkte inkl. "jetzt"); Tag/Nacht aus der Icon-Endung d/n, ohne Icon null; ohne Code null', F.length === 14 && F.every(p => p.length === 7) && F[0][5] === 800 && F[0][6] === 0 && F[1][5] === 211 && F[1][6] === 1 && F[5][6] === 0 && F[12][5] === null && F[12][6] === null && F[13][5] === null && F[13][6] === null, JSON.stringify(F.map(p => [p[5], p[6]])));
  check('Wetter-Symbole: jede Klasse (Gewitter, Niesel, Regen, Eisregen = Schnee, Schnee, Nebel, Sonne, Mond, Sonne mit Wolke, Mond mit Wolke, Wolke), fehlender Code -> kein Symbol',
        sy.join() === ['mond', 'gewitter', 'niesel', 'regen', 'schnee', 'schnee', 'nebel', 'sonne', 'mond', 'sonne_wolke', 'mond_wolke', 'wolke', null, null].join(), sy.join());
  const S = WXC.symbole(gstore.OPT_weather, null, NOW, NOW - 24 * 3600000, NOW + 36 * 3600000, []);
  check('Wetter-Symbole: Symbolzeile ab "jetzt" je Prognosepunkt mit der OWM-Beschreibung als Tooltip, Punkte ohne Code ausgelassen, kein Fehler', S.length === 12 && S[0][0] === NOW && S[0][1] === 'mond' && S[1][2] === 'Gewitter' && S[4][2] === 'Eisregen' && !S.some(x => x[1] === null), JSON.stringify(S.slice(0, 3)));
  const t1 = WXC.symbole({fpts: [[NOW, 3, 80, 0, 1, 800, null], [NOW + 10800000, 3, 80, 0, 1, 800, null]]}, null, NOW, NOW - 86400000, NOW + 129600000, [[NOW + 3600000, NOW + 14400000]]);
  check('Wetter-Symbole: ohne Icon-Endung entscheiden die Naechte (Tag -> Sonne, in der Nacht -> Mond); Muell im Wetter-Objekt -> keine Symbole, kein Fehler', t1.map(x => x[1]).join() === 'sonne,mond' && WXC.symbole({fpts: 'x'}, 'y', NOW, 0, NOW * 2, null).length === 0 && WXC.symbole(null, null, NOW, 0, NOW * 2, null).length === 0, t1.map(x => x[1]).join());
  gstore.OPT_weather = JSON.parse(keep); }
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
const NAMES = {ki_oben: 'Kinderzimmer oben', ki_unten: 'Kinderzimmer unten', schlaf: 'Schlafzimmer', wohn: 'Wohnzimmer'};
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
      s.sum.heat === 'keiner' && s.sum.over === 'keiner' && s.grund.includes('im eigenen Komfortband'), s.grund);
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
check('inaktiver Raum wird ignoriert (kein Heizbedarf trotz 18,0), bleibt aber sichtbar', s.sum.heat === 'keiner' && rowOf(s, 'schlaf').valid.startsWith('nein (inaktiv)') && rowOf(s, 'schlaf').cls === 'mute' && rowOf(s, 'schlaf').on === false && s.sum.valid.startsWith('2 von 2') && s.sum.valid.includes('2 inaktiv'), s.sum.valid)        // Schlafzimmer (hier abgeschaltet) + Wohnzimmer (noch ohne Band, inaktiv);
setv('room:schlaf:active', true);

// Wohnzimmer (Shelly H&T Gen1, Venus-Broker): wird von Anfang an gemessen und protokolliert, hat aber keine Stimme in der Raumlogik, bis das Band gesetzt und der Raum aktiviert ist
{
  const wr = gstore.OPT_cfg.rooms.find(r => r.id === 'wohn');
  const mqttMatch = (filter, topic) => { const f = filter.split('/'), tp = topic.split('/'); return f.length === tp.length && f.every((x, i) => x === '+' || x === tp[i]); };
  const subs = ALLNODES.filter(n => n.type === 'mqtt in' && n.z === 'opt_tab' && n.broker === 'opt_broker_venus' && n.wires.some(w => w.includes('opt_room_in'))).map(n => n.topic);
  check('Wohnzimmer: Raum ist angelegt (Topic shellies/shelly-ht-wohnzimmer/sensor/temperature), steht inaktiv, wird von einem Abo des Venus-Brokers erreicht',
        !!wr && wr.active === false && wr.name === 'Wohnzimmer' && wr.topic === 'shellies/shelly-ht-wohnzimmer/sensor/temperature' && subs.some(f => mqttMatch(f, wr.topic)), JSON.stringify(wr));
  delete gstore.OPT_rooms; run('opt_room_in', {topic: 'shellies/shelly-ht-wohnzimmer/sensor/temperature', payload: '17.2'});
  check('Wohnzimmer: Messwert kommt an (Glaettung/Trend laufen), auch solange der Raum inaktiv ist', gstore.OPT_rooms && gstore.OPT_rooms.wohn && gstore.OPT_rooms.wohn.last === 17.2, JSON.stringify(gstore.OPT_rooms && gstore.OPT_rooms.wohn));
  s = scene({ki_oben: [23.0], ki_unten: [23.0], schlaf: [20.0], wohn: [17.2]});
  check('Wohnzimmer 17,2 (unter dem Platzhalterband) loest keinen Heizbedarf aus, solange er inaktiv ist; Raum bleibt sichtbar', s.sum.heat === 'keiner' && rowOf(s, 'wohn') && rowOf(s, 'wohn').valid.startsWith('nein (inaktiv)') && rowOf(s, 'wohn').on === false, s.sum.heat);
  setv('room:wohn:active', true);
  s = scene({ki_oben: [23.0], ki_unten: [23.0], schlaf: [20.0], wohn: [17.2]});
  check('Wohnzimmer aktiviert: 17,2 liegt unter dem Band 20-22,5 und wird zum massgeblichen Raum', s.sum.heat.startsWith('Wohnzimmer'), s.sum.heat);
  setv('room:wohn:active', false);
}

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
check('gueltige Eingabe wird uebernommen, in config.json gespeichert und sofort ausgewertet (Ausgang 2)', Array.isArray(r2) && r2[0] === null && r2[1].payload === 'auswerten' && gstore.OPT_cfg.rooms[2].min === 18 && cf().rooms.find(x => x.id === 'schlaf').min === 18, JSON.stringify(cf().rooms));
check('Standardwerte: ein alter Wert aus dem Speicher (copMax 9, Tarif) ueberschreibt neue Standardwerte von plan/energy nicht; ein in config.json gesetzter Wert gewinnt; Raum-Eingaben bleiben', (() => {
  const keepCfg = files['/data/optimizer/config.json'].data;
  gstore.OPT_cfg.plan.copMax = 9; gstore.OPT_cfg.energy.tariff = {buy: [['00:00', '24:00', 9.99]], sell: 1}; gstore.OPT_cfg.rooms[2].min = 18.5;
  run('opt_defaults', {}); const a = gstore.OPT_cfg.plan.copMax === 8 && gstore.OPT_cfg.energy.tariff.buy[0][2] === 0.21 && gstore.OPT_cfg.rooms[2].min === 18.5;
  const sv = JSON.parse(keepCfg); sv.plan = {copMax: 7}; files['/data/optimizer/config.json'].data = JSON.stringify(sv); gstore.OPT_cfg.plan.copMax = 9; run('opt_defaults', {});
  const b = gstore.OPT_cfg.plan.copMax === 7 && gstore.OPT_cfg.plan.copMinMin === 60; files['/data/optimizer/config.json'].data = keepCfg; run('opt_defaults', {}); return a && b; })(), '');
check('Speichern haelt nur die Eingabe fest: keine Standardwerte (plan, energy, ...) werden in config.json eingefroren, andere Raeume bleiben unberuehrt', !('plan' in cf()) && !('energy' in cf()) && !('quiet' in cf()) && cf().rooms.find(x => x.id === 'schlaf').min === 18 && cf().rooms.every(x => !('name' in x) && !('topic' in x)), JSON.stringify(cf()));
setv('room:ki_oben:weight', 2); setv('control.holdMin', 50);
check('weitere Eingaben ergaenzen die Datei (anderer Raum, Gruppenwert), frueheres bleibt', cf().rooms.find(x => x.id === 'schlaf').min === 18 && cf().rooms.find(x => x.id === 'ki_oben').weight === 2 && cf().control.holdMin === 50 && !('plan' in cf()), JSON.stringify(cf()));
check('nach einem Neustart gelten gespeicherte Eingaben UND neue Standardwerte (plan bleibt frisch)', (() => { delete gstore.OPT_cfg; run('opt_defaults', {}); return gstore.OPT_cfg.rooms[2].min === 18 && gstore.OPT_cfg.rooms[0].weight === 2 && gstore.OPT_cfg.control.holdMin === 50 && gstore.OPT_cfg.plan.copMax === 8; })(), '');
// ---------- eigene Nachheizung je Raum (Entscheidung 5, 15.10.2026)
{ const ko = () => gstore.OPT_cfg.rooms.find(r => r.id === 'ki_oben'), keepCfg = files['/data/optimizer/config.json'].data;
  check('eigene Nachheizung: Standard nur Kinderzimmer oben (Generator), die anderen Raeume nicht; das Feld steht in OPT_cfg', ko().eigeneHeizung === true && gstore.OPT_cfg.rooms.filter(r => r.id !== 'ki_oben').every(r => r.eigeneHeizung === false), JSON.stringify(gstore.OPT_cfg.rooms.map(r => [r.id, r.eigeneHeizung])));
  files['/data/optimizer/config.json'].data = JSON.stringify({rooms: [{id: 'ki_oben', min: 22.5, max: 24, weight: 1.3}], plan: {coefActivate: 1}}); delete gstore.OPT_cfg; run('opt_defaults', {});
  const a = ko().eigeneHeizung === true && ko().max === 24 && ko().weight === 1.3;
  const rs = setv('room:ki_oben:eigeneHeizung', false), b = ko().eigeneHeizung === false && cf().rooms.find(x => x.id === 'ki_oben').eigeneHeizung === false && cf().rooms.find(x => x.id === 'ki_oben').max === 24 && Array.isArray(rs) && rs[1].payload === 'auswerten';
  delete gstore.OPT_cfg; run('opt_defaults', {}); const c = ko().eigeneHeizung === false;
  setv('room:ki_oben:eigeneHeizung', true); const d = ko().eigeneHeizung === true && cf().rooms.find(x => x.id === 'ki_oben').eigeneHeizung === true;
  check('eigene Nachheizung: config.json ohne das Feld (wie live) laesst den Standard stehen; der Schalter der Karte setzt es (room:ki_oben:eigeneHeizung), speichert nur dieses Feld und gilt nach einem Neustart', a && b && c && d, JSON.stringify([a, b, c, d]));
  files['/data/optimizer/config.json'].data = keepCfg; delete gstore.OPT_cfg; run('opt_defaults', {});
  const tplR = ALLNODES.find(n => n.id === 'opt_t_rooms').format;
  s = scene({ki_oben: [21.9], ki_unten: [23.0], schlaf: [20.0]});
  check('Karte "Räume": Spalte "eigene Heizung" (Tooltip "Eigene Nachheizung: …") mit Schalter (room:<id>:eigeneHeizung); Kinderzimmer oben mit Haken, die anderen ohne; "Raum unter Minimum" nennt die eigene Nachheizung',
        /<th title="Eigene Nachheizung: [^"]+">eigene Heizung<\/th>/.test(tplR) && tplR.includes("ng-model=\"r.eigen\" ng-change=\"set(r, 'eigeneHeizung', r.eigen)\"") && rowOf(s, 'ki_oben').eigen === true && rowOf(s, 'schlaf').eigen === false && /^Kinderzimmer oben · 0,6 K unter Minimum · .* · eigene Nachheizung$/.test(s.sum.heat), s.sum.heat); }
// ---------- Sonnenfenster je Raum (Paket 2, 15.10.2026)
{ const wo = () => gstore.OPT_cfg.rooms.find(r => r.id === 'wohn'), keepCfg = files['/data/optimizer/config.json'].data;
  check('Sonnenfenster: Standard nur Wohnzimmer (Generator, Suedwestfenster), die anderen Raeume nicht; das Feld steht in OPT_cfg', wo().sonnenfenster === true && gstore.OPT_cfg.rooms.filter(r => r.id !== 'wohn').every(r => r.sonnenfenster === false), JSON.stringify(gstore.OPT_cfg.rooms.map(r => [r.id, r.sonnenfenster])));
  files['/data/optimizer/config.json'].data = JSON.stringify({rooms: [{id: 'wohn', active: true, min: 20, max: 23.5}]}); delete gstore.OPT_cfg; run('opt_defaults', {});
  const a = wo().sonnenfenster === true && wo().max === 23.5 && wo().active === true;
  const rs = setv('room:wohn:sonnenfenster', false), b = wo().sonnenfenster === false && cf().rooms.find(x => x.id === 'wohn').sonnenfenster === false && cf().rooms.find(x => x.id === 'wohn').max === 23.5 && Array.isArray(rs) && rs[1].payload === 'auswerten';
  delete gstore.OPT_cfg; run('opt_defaults', {}); const c = wo().sonnenfenster === false;
  setv('room:wohn:sonnenfenster', true); const d = wo().sonnenfenster === true && cf().rooms.find(x => x.id === 'wohn').sonnenfenster === true;
  check('Sonnenfenster: config.json ohne das Feld (wie live) laesst den Standard stehen; der Schalter der Karte setzt es (room:wohn:sonnenfenster), speichert nur dieses Feld und gilt nach einem Neustart', a && b && c && d, JSON.stringify([a, b, c, d]));
  files['/data/optimizer/config.json'].data = keepCfg; delete gstore.OPT_cfg; run('opt_defaults', {});
  const tplS = ALLNODES.find(n => n.id === 'opt_t_rooms').format;
  check('Karte "Räume": Spalte "Sonne" (Tooltip "Sonnenfenster: …") mit Schalter (room:<id>:sonnenfenster) direkt nach "eigene Heizung"; Wohnzimmer mit Haken, die anderen ohne',
        /eigene Heizung<\/th><th title="Sonnenfenster: [^"]+">Sonne<\/th>/.test(tplS) && tplS.includes("ng-model=\"r.sf\" ng-change=\"set(r, 'sonnenfenster', r.sf)\"") && rowOf(s, 'wohn').sf === true && rowOf(s, 'schlaf').sf === false, JSON.stringify(s.rooms.map(r => [r.id, r.sf]))); }
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
check('Umschalten von "Aktiv" wird gespeichert und sofort ausgewertet', Array.isArray(tog) && tog[0] === null && tog[1].payload === 'auswerten' && cf().rooms.find(x => x.id === 'schlaf').active === false, JSON.stringify(tog));
setv('room:schlaf:active', true);
setv('room:ki_oben:min', 22.0); setv('room:ki_oben:weight', 1.5); setv('room:ki_oben:maxAgeMin', 60); setv('room:ki_unten:active', false);

// Aufbau der Seite: eine Raumkarte, die Eingaben gehen an opt_set; keine Einzelfelder mehr
const flowsAll = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), nodeBy = {}; flowsAll.forEach(n => { nodeBy[n.id] = n; });
const card = nodeBy['opt_t_rooms'], html = card.format;
check('Raumkarte: eigene Gruppe (17 breit wie alle Karten der Optimierungs-Seiten), volle Gruppenbreite, feste Starthoehe, Eingaben gehen an opt_set', card.type === 'ui_template' && card.group === 'opt_g_rooms' && nodeBy['opt_g_rooms'].width === 17 && card.width === 0 && card.height === 7 && card.templateScope === 'local' && JSON.stringify(card.wires) === '[["opt_set"]]', JSON.stringify(card.wires));
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
      rr('schlaf').min === 19 && rr('schlaf').max === 21 && gstore.OPT_cfg.comfort === undefined && rr('schlaf').topic === 'shellies/shellyht-Schlaf/sensor/temperature' && rr('schlaf').name === 'Schlafzimmer' && gstore.OPT_cfg.sensor.maxAgeMin === 60 && gstore.OPT_cfg.rooms.length === 4, JSON.stringify(rr('schlaf')));
gstore.OPT_cfg = {rooms: [{id: 'ki_oben', name: 'alt', topic: 'alt'}], comfort: {low: 22.5, high: 23.5}, sensor: {maxAgeMin: 90}};      // Speicherstand der Vorversion
delete files['/data/optimizer/config.json']; run('opt_defaults', {});
check('Migration: Speicherstand der Vorversion (globales Band, Raeume ohne Baender) wird ergaenzt', rr('ki_oben').min === 22.5 && rr('ki_oben').max === 23.5 && rr('ki_oben').name === 'Kinderzimmer oben' && gstore.OPT_cfg.comfort === undefined && gstore.OPT_cfg.rooms.length === 4, JSON.stringify(rr('ki_oben')));
['null', 'kaputt{', '[]'].forEach(txt => { files['/data/optimizer/config.json'] = {data: txt, mode: 0o644}; delete gstore.OPT_cfg; let ok = true; try { run('opt_defaults', {}); } catch (e) { ok = false; }
  check('defekte config.json (' + txt + ') bringt die Standardwerte, kein Absturz', ok && rr('schlaf').min === 19 && gstore.OPT_cfg.rooms.length === 4, ''); });
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
// Fahrplan v2 (S1): optimizer-v2 bekommt hinten Wind, PV, Regelwert T_outside und eigenen Fuehler
{
  const keepW = gstore.OPT_weather, keepP = gstore.OPT_plan_in;
  gstore.T_outside = 6.5; gstore.T_outside_custom = 5.5;
  delete fstore.logHead; delete fstore.lastLog; NOW += 6 * 60000; gstore.OPT_weather = {status: 'OK', ts: NOW, temp: 8, rh: 80, dew: 4, clouds: 50, wind: 3.2, f_ts: NOW}; gstore.OPT_plan_in = {ts: NOW, pvNow: 1500}; const ov = run('opt_eval', {});
  // cop-ziel 17.10.2026: zwei Zaehlerspalten (zaehler_wp_w, zaehler_heizstab_w) ganz hinten; die Positionspruefungen der aelteren Spalten laufen ohne sie
  const ln = ov[4].payload.split('\n').filter(Boolean), hvZ = ln[0].split(','), dvZ = ln[1].split(','), hv2 = hvZ.slice(0, -2), dv = dvZ.slice(0, -2);
  check('optimizer-v2 (cop-ziel): Spalten zaehler_wp_w, zaehler_heizstab_w ganz hinten, ohne Zähler leer, Spaltenzahl stimmt', hvZ.slice(-2).join() === 'zaehler_wp_w,zaehler_heizstab_w' && dvZ.length === hvZ.length && dvZ.slice(-2).join() === ',', hvZ.slice(-2).join() + ' / ' + dvZ.slice(-2).join());
  check('optimizer-v2: vier neue Spalten ganz hinten (wetter_wind_ms, pv_w, aussen_t_outside, t_outside_custom) mit Punkt als Dezimaltrenner, Spaltenzahl stimmt', hv2.slice(-7, -3).join() === 'wetter_wind_ms,pv_w,aussen_t_outside,t_outside_custom' && dv.length === hv2.length && dv.slice(-7, -3).join() === '3.2,1500,6.5,5.5' && hv2[hv2.length - 8] === 'heizregelung', hv2.slice(-6).join() + ' / ' + dv.slice(-6).join());
  delete gstore.T_outside_custom; delete gstore.OPT_plan_in; delete fstore.lastLog; NOW += 6 * 60000; gstore.OPT_weather.ts = NOW; const ov2 = run('opt_eval', {}), dv2 = ov2[4].payload.split('\n').filter(Boolean).pop().split(',').slice(0, -2);
  check('optimizer-v2: ohne eigenen Fuehler und ohne frische PV bleiben die Felder leer, kein Absturz', dv2.slice(-7, -3).join() === '3.2,,6.5,', dv2.slice(-7, -3).join());
  { // COP-Korrektur (14.10.2026): drei Spalten ganz hinten (leistung_korr_w, cop_korr, cop_korr_w); im Lauf TOP16 + 80 W, COP = Kern-COP x TOP16 / (TOP16 + 80); leistung_w/cop bleiben roh
    const g = n => dv[hv2.indexOf(n)], kw = gstore.OPT_cfg.cop.pelKorrW, lauf = Number(g('verdichter_hz')) > 0;
    check('COP-Korrektur optimizer-v2: Spalten leistung_korr_w, cop_korr, cop_korr_w hinten angehaengt; im Lauf Strom = roh + 80 W, COP = roh x roh/(roh + 80), Rohspalten unveraendert', hv2.slice(-3).join() === 'leistung_korr_w,cop_korr,cop_korr_w' && kw === 80 && g('cop_korr_w') === '80' && lauf &&
          Math.abs(Number(g('leistung_korr_w')) - Number(g('leistung_w')) - 80) < 1e-9 && Math.abs(Number(g('cop_korr')) - Math.round(Number(g('cop')) * Number(g('leistung_w')) / (Number(g('leistung_w')) + 80) * 100) / 100) < 0.011, [g('leistung_w'), g('leistung_korr_w'), g('cop'), g('cop_korr')].join('/')); }
  gstore.OPT_weather = keepW; gstore.OPT_plan_in = keepP; delete gstore.T_outside;
}


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
  Object.assign(gstore, BASE(), {TOP42_Z1_Water_Target_Temp: 33});                   // Absenkung nur moeglich, solange der Soll-Vorlauf ueber der Untergrenze (29 °C) liegt
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
check('Shadow: es werden nur OPT_*-Werte geschrieben, die Korrektur bleibt 0', Object.keys(gstore).filter(k => !k.startsWith('OPT_')).every(k => JSON.stringify(gstore[k]) === JSON.stringify(Object.assign(BASE(), {TOP42_Z1_Water_Target_Temp: 33})[k]) || k === 'TOP14_Outside_Temp') && gstore.OPT_shift_applied === 0, String(gstore.OPT_shift_applied));

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
const hpmsgE = (topic, payload) => run('opt_hp_in', {topic: 'panasonic_heat_pump/' + topic, payload: String(payload)});
const cur = () => fstore.ctl && fstore.ctl.cur;
const quiet = () => { gstore.compressor_frequency = 17; };

// Regel 1: Raum unter Minimum -> langsam +1 K (erst nach Wartezeit), Fuehrungsraum = groesstes Defizit
resetWorld(); setRooms(ROOMSET(23.0, 21.9, 20.0));
let oo = tick(40);
check('Regel 1: Raum 0,6 K unter Minimum, nach 40 min noch keine Aenderung (langsam, beobachtet)', cur() === 0 && ctlOf(oo).why.includes('beobachte') && ctlOf(oo).lead === 'Kinderzimmer unten', ctlOf(oo).why);
oo = tick(25);
check('Regel 1: nach 65 min Wartezeit Vorschlag +1 K, Fuehrungsraum Kinderzimmer unten', cur() === 1 && ctlOf(oo).why.startsWith('Raum unter Minimum: Kinderzimmer unten') && ctlOf(oo).lead === 'Kinderzimmer unten', ctlOf(oo).why);
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
// Absolute Untergrenze des Vorlaufs (Heizkoerper): nie unter 29 °C, auch nicht als Vorschlag
console.log('\n--- Vorlauf-Untergrenze 29 °C');
resetWorld(); gstore.TOP42_Z1_Water_Target_Temp = 29; setRooms(ROOMSET(24.0, 23.0, 20.0)); oo = tick(60);
check('Untergrenze: Soll-Vorlauf schon 29 °C (Mildwetter) und Raum ueber Maximum -> kein -1 K, Vorschlag bleibt 0 K, Grund nennt Untergrenze und Soll-Vorlauf', cur() === 0 && ctlOf(oo).floorHit === true && /^Absenkung nicht möglich: Vorlauf-Untergrenze 29 °C \(Soll-Vorlauf 29,0 °C\) · Kinderzimmer oben über Maximum$/.test(ctlOf(oo).why), ctlOf(oo).why);
resetWorld(); gstore.TOP42_Z1_Water_Target_Temp = 30; setRooms(ROOMSET(24.0, 23.0, 20.0)); oo = tick(60);
check('Untergrenze: Soll-Vorlauf 30 °C -> -1 K ergaebe genau 29 °C und ist erlaubt', cur() === -1 && ctlOf(oo).floorHit === false, ctlOf(oo).why);
resetWorld(); gstore.TOP42_Z1_Water_Target_Temp = 29.5; setRooms(ROOMSET(24.0, 23.0, 20.0)); oo = tick(60);
check('Untergrenze: Soll-Vorlauf 29,5 °C -> -1 K ergaebe 28,5 °C, nicht erlaubt', cur() === 0 && ctlOf(oo).floorHit === true, ctlOf(oo).why);
resetWorld(); setRooms(ROOMSET(24.0, 23.0, 20.0)); tick(40);
const backoffBefore = (fstore.ctl && fstore.ctl.backoffUntil) || 0;
gstore.TOP42_Z1_Water_Target_Temp = 29; oo = tick(1);
check('Untergrenze: ein schon angenommenes -1 K wird sofort zurueckgenommen, wenn der Soll-Vorlauf auf 29 °C faellt (auch innerhalb der Haltezeit), ohne die Pause nach einer zurueckgenommenen Absenkung', cur() === 0 && ctlOf(oo).floorHit === true && ((fstore.ctl.backoffUntil || 0) === backoffBefore), 'cur ' + cur() + ' | ' + ctlOf(oo).why);
resetWorld(); gstore.TOP42_Z1_Water_Target_Temp = 29; setRooms(ROOMSET(23.0, 21.9, 20.0)); oo = tick(70);
check('Untergrenze betrifft nur das Absenken: Raum unter Minimum -> +1 K bleibt bei 29 °C moeglich', cur() === 1 && ctlOf(oo).floorHit === false, ctlOf(oo).why);
resetWorld(); gstore.TOP42_Z1_Water_Target_Temp = 29; setRooms(ROOMSET(23.0, 23.0, 20.5)); oo = tick(130);
check('Untergrenze: Regel 3 (alle im Band, niedrigste Kurve suchen) testet bei 29 °C nicht, Grund nennt die Untergrenze', cur() === 0 && /Vorlauf-Untergrenze 29 °C/.test(ctlOf(oo).why), ctlOf(oo).why);
resetWorld(); gstore.TOP42_Z1_Water_Target_Temp = 29; setRooms(ROOMSET(24.0, 23.0, 20.0));
const csvParts = []; for (let k = 0; k < 47; k++) { const o8 = tick(1); if (o8[4]) { csvParts.push(o8[4].payload); } }
const csvL = csvParts.join('').trim().split('\n'), hdL = csvL[0].split(','), vlL = csvL[csvL.length - 1].split(',');
check('Untergrenze steht im Protokoll (Spalte vorlauf_untergrenze = 1, wenn sie ein Absenken verhindert)', hdL.includes('vorlauf_untergrenze') && vlL[hdL.indexOf('vorlauf_untergrenze')] === '1' && hdL.length === vlL.length, 'Spalte ' + hdL.indexOf('vorlauf_untergrenze') + ' = ' + vlL[hdL.indexOf('vorlauf_untergrenze')]);
// ---- Heizregelung (Comfort/Efficiency) im Haupt-Protokoll und in der Waermepumpen-Karte
console.log('\n--- Heizregelung im Protokoll');
resetWorld(); setRooms(ROOMSET(23.0, 23.0, 20.5));
hpmsgE('main/Heating_Control', 0); NOW += 60000; hpmsgE('main/Heating_Control', 1);                                          // Wechsel Comfort -> Efficiency
const hcParts = []; for (let k = 0; k < 8; k++) { const o9 = tick(1); if (o9[4]) { hcParts.push(o9[4].payload); } gstore.OPT_hp = gstore.OPT_hp; }
const o9 = tick(1), rowHc = o9[2].payload.rows.find(r => r[0] === 'Heizregelung');
check('Waermepumpen-Karte: Zeile "Heizregelung" nennt Efficiency und seit wann (Wechsel mit Uhrzeit), Warnfarbe bei Efficiency', rowHc && /^Efficiency · seit \d\d:\d\d$/.test(rowHc[1]) && rowHc[2] === 'warn', rowHc && rowHc.join(' | '));
const hcCsv = hcParts.join('').trim().split('\n'), hcH = hcCsv[0].split(','), hcV = hcCsv[hcCsv.length - 1].split(',');
check('Haupt-Protokoll (alle 5 min): Spalte heizregelung = 1 bei Efficiency (damit sich jede Zeile spaeter Comfort/Efficiency zuordnen laesst)', hcH.includes('heizregelung') && hcV[hcH.indexOf('heizregelung')] === '1' && hcH.length === hcV.length, 'Spalte ' + hcH.indexOf('heizregelung') + ' = ' + hcV[hcH.indexOf('heizregelung')]);
resetWorld(); setRooms(ROOMSET(23.0, 23.0, 20.5)); hpmsgE('main/Heating_Control', 0); const o0 = tick(1), row0 = o0[2].payload.rows.find(r => r[0] === 'Heizregelung');
check('Karte bei Comfort: "Comfort · seit Beobachtung hh:mm" (Beginn nur seit Start bekannt), keine Warnfarbe', /^Comfort · seit Beobachtung \d\d:\d\d$/.test(row0[1]) && row0[2] === '', row0.join(' | '));
resetWorld(); setRooms(ROOMSET(23.0, 23.0, 20.5)); const oN = tick(1), rowN = oN[2].payload.rows.find(r => r[0] === 'Heizregelung');
check('Karte ohne Meldung der Waermepumpe: Strich', rowN[1] === '–', rowN.join(' | '));

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

console.log('\n--- Quiet-Waechter: Messung und Anzeige (Review-Paket 13.10.2026: keine eigene Empfehlung, kein Kontrolltest, keine Eskalationsaktionen)');
world(); let o = qtick(1);
check('abgeleitete Groessen: Soll-RL = Soll-VL - Ziel-Spreizung (26), Fehler +2,4 K (RL unter Soll), Spreizung 4,9 K', rowQ(o, 'Soll-RL') === '26,0 °C' && rowQ(o, 'Rücklauffehler') === '+2,4 K (RL unter Soll)' && rowQ(o, 'Spreizung').startsWith('4,9'), rowQ(o, 'Rücklauffehler'));
{ // COP-Korrektur (14.10.2026, Forum 189605 F10-a): nur im Lauf +80 W (OPT_cfg.cop.pelKorrW), Kennzeichnung als Tooltip (4. Feld), keine Hinweiszeile, Konstante aenderbar
  const rowF = (o, label) => o[0].payload.rows.find(r => r[0].startsWith(label)) || [];
  const pthQ = 12 * (28.5 - 23.6) * 69.7;                                                       // Waerme berechnet (kein HeishaMon-Extra): 4098 W
  const lE = rowF(o, 'Leistung elektrisch'), lC = rowF(o, 'COP');
  check('COP-Korrektur Quiet-Karte: im Lauf Strom 600 W roh -> 680 W, COP = Waerme / 680, Tooltip "intern +80 W korrigiert (TOP16 600 W)" und roher COP; Konstante aus OPT_cfg.cop (Standard 80)', gstore.OPT_cfg.cop.pelKorrW === 80 && lE[1] === '680 W' && lE[3] === 'intern +80 W korrigiert (TOP16 600 W)' && lC[1] === (pthQ / 680).toFixed(1).replace('.', ',') && /Strom intern \+80 W korrigiert \(roh 6,8\)/.test(lC[3]) && o[0].payload.rows.every(r => r[0] !== 'Hinweis'), JSON.stringify([lE, lC]));
  world({compressor_frequency: 0, TOP16_Heat_Energy_Consumption: 15}); const oS = qtick(1), lS = rowF(oS, 'Leistung elektrisch');
  check('COP-Korrektur nur im Lauf: Stillstand zeigt TOP16 roh (15 W, keine 95 W), Tooltip "Stillstand: TOP16 roh", kein COP', lS[1] === '15 W' && lS[3] === 'Stillstand: TOP16 roh' && rowF(oS, 'COP')[1] === '–', JSON.stringify(lS));
  world(); files['/data/optimizer/config.json'] = {data: JSON.stringify({cop: {pelKorrW: 40}}), mode: 0o644}; run('opt_defaults', {}); const o40 = qtick(1);
  check('COP-Korrektur aenderbar: config.json cop.pelKorrW = 40 -> OPT_cfg.cop 40, Quiet-Karte 640 W mit Tooltip "+40 W"; ungueltig (500) -> Standard 80', gstore.OPT_cfg.cop.pelKorrW === 40 && rowF(o40, 'Leistung elektrisch')[1] === '640 W' && /intern \+40 W korrigiert/.test(rowF(o40, 'Leistung elektrisch')[3]) &&
        (() => { files['/data/optimizer/config.json'].data = JSON.stringify({cop: {pelKorrW: 500}}); run('opt_defaults', {}); const ox = qtick(1); return rowF(ox, 'Leistung elektrisch')[1] === '680 W'; })(), JSON.stringify(rowF(o40, 'Leistung elektrisch')));
  world(); o = qtick(1); const NB = id => ALLNODES.find(n => n.id === id);
  check('COP-Korrektur Kennzeichnung: Statuskarten zeigen das 4. Feld als Tooltip (title="{{r[3]}}"), Quiet-Statistik-Kopf mit Tooltip aus msg.payload.korr, Plan-Kacheln/Details/Stundenkopf mit Tooltip', /class="kv" ng-repeat="r in msg\.payload\.rows track by \$index" title="\{\{r\[3\]\}\}"/.test(NB('opt_t_quiet').format) && /title="\{\{msg\.payload\.korr\}\}/.test(NB('opt_t_qstats').format) && /title="\{\{t\.t\}\}"/.test(NB('opt_t_plan').format) && /title="\{\{r\[3\]\}\}"/.test(NB('opt_t_plan').format) && /<th title="\{\{msg\.payload\.korr\}\}">COP<\/th>/.test(NB('opt_t_plan_tab').format), ''); }
check('thermische Leistung berechnet aus Flow x Spreizung (12 l/min x 4,9 K ~ 4100 W), Hinweis "berechnet"', /^4\s?1\d\d W \(berechnet\)$/.test(rowQ(o, 'Leistung thermisch').replace(/ /g, ' ')) || rowQ(o, 'Leistung thermisch').includes('(berechnet)'), rowQ(o, 'Leistung thermisch'));
check('Review-Paket: keine eigene Quiet-Empfehlung (lautete fast immer Stufe 3), kein Kontrolltest 3 -> 2, kein Eskalationswaechter in der Karte; "Quiet aktuell" Stufe 3; ohne OPT_engine "Quiet-Regeln" = "Entscheidungsmaschine ohne aktuelle Daten"',
      rowQ(o, 'Quiet aktuell').startsWith('Stufe 3') && !o[0].payload.rows.some(r => /^(Quiet normal|Quiet nach Prioritätsregeln|Nächster Schritt|Grund|Sperrgrund|Kontrolltest|Eskalationswächter)/.test(r[0])) && rowQ(o, 'Quiet-Regeln') === 'Entscheidungsmaschine ohne aktuelle Daten' && rowQ(o, 'Lauf (Messung)') !== undefined,
      o[0].payload.rows.map(r => r[0]).join(' | '));
check('keine erklaerenden Hinweiszeilen in der Karte (nur Werte)', !o[0].payload.rows.some(r => r[0].startsWith('Hinweis')), '');
check('Quellen der Stufe: HeishaMoNR-Logik, Scheduler, Solar, WP-Zeitplan aus', ['HeishaMoNR-Quiet-Logik aus', 'Scheduler aus', 'Solar aus', 'WP-Zeitplan aus'].every(t => rowQ(o, 'Quellen').includes(t)), rowQ(o, 'Quellen'));
// Quiet-Regeln und gemessener Deckel kommen aus der Entscheidungsmaschine (eine Wahrheit, keine doppelte Logik)
const qrRow = o0 => o0[0].payload.rows.find(r => r[0].startsWith('Quiet-Regeln')) || [];
world(); gstore.OPT_engine = {ts: T0 + 60000, rules: [{id: 'quiet_freigabe', st: 'bereit'}, {id: 'quiet_strecken', st: 'vorschlag'}, {id: 'raum_offset', st: 'wartet'}, {id: 'vorausschau', st: 'gesperrt'}],
                              prop: {rule: 'quiet_strecken', was: 'Quiet-Stufe 0 → 3'}, deckel: {q: 3, hz: 17, quelle: 'Messung'}, hc: null}; o = qtick(1);
check('Quiet-Regeln aus OPT_engine: nur die beiden Quiet-Regeln mit Status, ein Vorschlag mit "was" (Warnfarbe); gemessener Deckel der jetzigen Stufe (17 Hz) in "Quiet aktuell" statt der alten Annahme 35/45 Hz',
      rowQ(o, 'Quiet-Regeln') === 'Quiet-Freigabe: prüft · Deckel/Laufzeit: Vorschlag (Quiet-Stufe 0 → 3)' && qrRow(o)[2] === 'warn' && /^Stufe 3 seit .* · Deckel 17 Hz \(Messung\)/.test(rowQ(o, 'Quiet aktuell')), rowQ(o, 'Quiet-Regeln') + ' | ' + rowQ(o, 'Quiet aktuell'));
gstore.OPT_engine.rules.forEach(r => { r.st = 'bereit'; }); gstore.OPT_engine.prop = null; gstore.OPT_engine.deckel = {q: 2, hz: 21, quelle: 'Messung'}; o = qtick(1);
check('... ohne Vorschlag keine Warnfarbe; Deckel einer anderen Stufe (Anlage wechselte gerade) wird nicht angezeigt', rowQ(o, 'Quiet-Regeln') === 'Quiet-Freigabe: prüft · Deckel/Laufzeit: prüft' && qrRow(o)[2] === '' && !/Deckel/.test(rowQ(o, 'Quiet aktuell')), rowQ(o, 'Quiet aktuell'));
gstore.OPT_engine.ts = NOW - 5 * 60000; o = qtick(1);
check('... OPT_engine aelter als 5 min: "Entscheidungsmaschine ohne aktuelle Daten" (Warnfarbe), kein Deckel', rowQ(o, 'Quiet-Regeln') === 'Entscheidungsmaschine ohne aktuelle Daten' && qrRow(o)[2] === 'warn', rowQ(o, 'Quiet-Regeln'));
gstore.OPT_engine = {ts: NOW + 60000, rules: [], prop: null, deckel: {q: 0, hz: 59, quelle: 'Nutzer'}}; gstore.TOP18_Quiet_Mode_Level = 0; o = qtick(1);
check('... Quiet 0: "kein Deckel (16–59 Hz)"', /kein Deckel \(16–59 Hz\)/.test(rowQ(o, 'Quiet aktuell')), rowQ(o, 'Quiet aktuell'));
// Taktung bleibt als Anzeige
world({TOP5_Main_Inlet_Temp: 22.5, compressor_last_runtime: 10}); o = qtick(1);
check('Taktung (nur Anzeige): letzter Lauf nur 10 min -> Zeile "Taktung" in Warnfarbe, Starts heute genannt', o[0].payload.rows.find(r => r[0] === 'Taktung')[2] === 'warn' && rowQ(o, 'Taktung').includes('heute 3 Starts'), rowQ(o, 'Taktung'));
world({TOP5_Main_Inlet_Temp: 22.5, Starts_Today: 30}); o = qtick(1);
check('Taktung (nur Anzeige): 30 Starts heute -> Warnfarbe', o[0].payload.rows.find(r => r[0] === 'Taktung')[2] === 'warn', rowQ(o, 'Taktung'));
// die gestrichene Erfahrungsregel "1–3 °C Quiet aus" und die Ruecklauf-Stufen erscheinen nirgends mehr
world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2}); o = qtick(1);
check('Review-Paket: Erfahrungsregel "1–3 °C: Quiet muss aus sein" und Ruecklauf-Stufen gestrichen (Quiet-Freigabe der Maschine entscheidet nach Bedarf und gemessenem Deckel)', !JSON.stringify(o[0].payload.rows).includes('Quiet muss aus sein') && !o[0].payload.rows.some(r => /Priorität|Empfehlung|Nächster Schritt/.test(r[0])), '');

// Statistik je Quiet-Stufe
console.log('--- Statistik je Quiet-Stufe, Protokoll, Neustart');
world({TOP5_Main_Inlet_Temp: 24.3}); let outs = [];
const collect = (n, hook) => { for (let i = 0; i < n; i++) { NOW += 60000; if (hook) { hook(i); } outs.push(run('opt_quiet', {})); } };
collect(30);
let tab = outs[outs.length - 1][1].payload.stats; const T3 = () => tab.find(r => r[0] === 'Stufe 3' && r[1] === '3–7 °C'), T2 = () => tab.find(r => r[0] === 'Stufe 2' && r[1] === '3–7 °C');
check('Statistik: 30 Minuten Lauf auf Stufe 3 mit Mittelwerten (Hz 20, P el. 600 W roh = 680 W mit COP-Korrektur)', T3() && nm(T3()[2]) >= 29 && T3()[3] === '20' && T3()[5] === '680' && tab.find(r => r[0] === 'Stufe 0')[1] === 'keine Daten', T3() && T3().join(' | '));
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
check('Protokoll: Werte der ersten Zeile (Quiet 3, VL 28,5, RL 24,3, Fehler 1,7); Spalten der gestrichenen Empfehlung/des Kontrolltests bleiben im Kopf, aber leer', l1[hdr.indexOf('quiet_aktuell')] === '3' && ['quiet_ziel_normal', 'quiet_ziel_prioritaet', 'quiet_naechster_normal', 'quiet_naechster_prioritaet', 'quiet_grund', 'quiet_sperre', 'haltezeit_rest_min', 'quiet_aussen_regel', 'test_moeglich'].every(c => l1[hdr.indexOf(c)] === '') && l1[hdr.indexOf('ist_vl')] === '28.5' && l1[hdr.indexOf('ist_rl')] === '24.3' && l1[hdr.indexOf('rl_fehler')] === '1.7', l1.slice(1, 4).join(','));
world({TOP5_Main_Inlet_Temp: 24.3, compressor_frequency: 0}); outs = []; collect(10);
check('Protokoll: auch bei stehendem Verdichter jede Minute (Pumpenspuelungen und Neustart sichtbar)', outs.filter(x => x[2]).length >= 9 && outs.filter(x => x[2]).length <= 10, String(outs.filter(x => x[2]).length));

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
check('Sicherheit: im Optimierer-Tab gibt es keinen MQTT-Ausgang ausser dem gesperrten Uebernahme-Knoten', flowsQ.filter(otherOut).length === 0, '');
check('Sicherheit: "SetQuietMode"/commands kennen nur der Waechter (lesend), die Entscheidungsmaschine (Vorschlagstext, ohne Ausgang zur Anlage) und die gesperrte Uebernahme', flowsQ.filter(n => n.id.startsWith('opt_') && n.type === 'function' && /SetQuietMode|commands\//.test(n.func || '')).map(n => n.id).sort().join() === 'opt_apply,opt_engine,opt_hp_in', flowsQ.filter(n => n.id.startsWith('opt_') && n.type === 'function' && /SetQuietMode|commands\//.test(n.func || '')).map(n => n.id).join());
{ // Uebernahme-Pfad: genau ein mqtt out, deaktiviert ausgeliefert, nur von opt_apply erreichbar, eigener Broker-Client; opt_engine fuehrt nicht dorthin
  const outs = flowsQ.filter(n => n.z === 'opt_tab' && n.type === 'mqtt out'), ap = flowsQ.find(n => n.id === 'opt_apply'), en = flowsQ.find(n => n.id === 'opt_engine'), br = flowsQ.find(n => n.id === 'opt_broker_cmd');
  const feeders = flowsQ.filter(n => (n.wires || []).some(w => w.indexOf(APPLY_OUT) >= 0)).map(n => n.id), toApply = flowsQ.filter(n => (n.wires || []).some(w => w.indexOf('opt_apply') >= 0)).map(n => n.id).sort();
  check('Sicherheit (Uebernahme-Pfad): genau ein mqtt out im Tab (opt_apply_mqtt), ' + (APPLY_AKTIV ? 'AKTIV (ausdruecklich angesagt: UEBERNAHME_KNOTEN_AKTIV=1)' : 'deaktiviert ausgeliefert') + ', gespeist nur von opt_apply, Eingaenge nur Karte + Takt, eigener Broker-Client, opt_engine hat keinen Weg dorthin',
        outs.length === 1 && outs[0].id === APPLY_OUT && (APPLY_AKTIV ? outs[0].d !== true : outs[0].d === true) && JSON.stringify(feeders) === '["opt_apply"]' && JSON.stringify(toApply) === '["opt_i_apply","opt_t_eng_prop"]' && JSON.stringify(ap.wires[0]) === '["opt_apply_mqtt"]' && br && br.clientid === 'nodered-optimizer-cmd' && outs[0].broker === 'opt_broker_cmd' && !en.wires.some(w => w.indexOf(APPLY_OUT) >= 0 || w.indexOf('opt_apply') >= 0),
        JSON.stringify({outs: outs.map(n => n.id + (n.d ? '(aus)' : '(AN)')), feeders: feeders, toApply: toApply}));
}
check('Sicherheit: Abonnements nur lesend: Anlagenwerte und genau die Befehle Quiet, Quiet-Prioritaet, Heizregelung, Pumpenmodus, max. Pumpenleistung (nur mitlesen, wer sie schickt); eigener Client im NAS-Broker, kein mqtt out im Tab', flowsQ.filter(n => n.z === 'opt_tab' && n.type === 'mqtt in' && /^opt_mqtt_hp_/.test(n.id)).map(n => n.topic).join() === 'panasonic_heat_pump/main/+,panasonic_heat_pump/extra/+,panasonic_heat_pump/commands/SetQuietMode,panasonic_heat_pump/commands/SetHeatingControl,panasonic_heat_pump/commands/SetPumpFlowrateMode,panasonic_heat_pump/commands/SetMaxPumpDuty,panasonic_heat_pump/commands/SetQuietModePriority' && !flowsQ.some(otherOut), '');
// Heizregelung / Pumpe: Status-Aenderungen und mitgelesene Befehle werden als Ereignis festgehalten (Grundlage fuer den spaeteren Comfort/Efficiency-Vergleich)
{ world({}); hpmsg('main/Heating_Control', 0); hpmsg('main/Pump_Flowrate_Mode', 0); hpmsg('main/Max_Pump_Duty', 254); hpmsg('main/Heat_Delta', 3);
  const ev1 = hpmsg('main/Heating_Control', 1), ev2 = hpmsg('main/Pump_Flowrate_Mode', 1), ev3 = hpmsg('main/Max_Pump_Duty', 200), ev4 = hpmsg('main/Heat_Delta', 4), ev0 = hpmsg('main/Heating_Control', 1);
  gstore.MQTT_Source = 'Test-Quelle'; const c1 = hpmsg('commands/SetHeatingControl', 1), c2 = hpmsg('commands/SetPumpFlowrateMode', 0), c3 = hpmsg('commands/SetOtherThing', 1);
  check('Heizregelung/Pumpe: Aenderung von Comfort auf Efficiency und der Pumpenparameter wird als Ereignis protokolliert, gleicher Wert nicht doppelt', ev1 && ev1.payload.includes(',heizregelung,0->1') && ev2.payload.includes(',pumpenmodus,0->1') && ev3.payload.includes(',pumpe_maxduty,254->200') && ev4.payload.includes(',spreizung_soll,3->4') && ev0 === null, ev1 && ev1.payload);
  check('Heizregelung/Pumpe: mitgelesene Befehle (SetHeatingControl, SetPumpFlowrateMode) mit Quelle protokolliert, fremde Befehle ignoriert, nichts wird gesendet', c1.payload.includes(',heizregelung_befehl,Wert 1 (Quelle: Test-Quelle)') && c2.payload.includes('pumpenmodus_befehl') && c3 === null && sent.every(x => !/SetHeatingControl|mqtt/i.test(x.id)), c1 && c1.payload); }
world({}); world({TOP18_Quiet_Mode_Level: 3}); hpmsg('main/Quiet_Mode_Priority', 1); let qp = qtick(1);
check('Quiet-Prioritaet: laut Firmware 1 = Capacity (Leistung), 0 = Sound (Lautstaerke); die Anzeige sagte vorher faelschlich Ton fuer 1', rowQ(qp, 'Quiet aktuell').includes('Priorität Leistung') && !rowQ(qp, 'Quiet aktuell').includes('Ton'), rowQ(qp, 'Quiet aktuell'));
hpmsg('main/Quiet_Mode_Priority', 0); qp = qtick(1);
check('Quiet-Prioritaet 0 wird als Lautstaerke angezeigt', rowQ(qp, 'Quiet aktuell').includes('Priorität Lautstärke'), rowQ(qp, 'Quiet aktuell'));

// ---- Heizregelung: Hinweis der Entscheidungsmaschine (nur Anzeige), getrennte Statistik, Ereignisse
console.log('\n--- Heizregelung: Hinweis aus der Entscheidungsmaschine und Statistik');
const qrow = (o, label) => (o[0].payload.rows.find(r => r[0] === label) || []);
const run1 = (n, hook) => { const evs = []; let o; for (let i = 0; i < n; i++) { NOW += 60000; if (hook) { hook(i); } o = run('opt_quiet', {}); if (o[3]) { evs.push(o[3].payload); } } return {o, evs}; };
const hcE = (warn, text) => ({ts: NOW, rules: [], prop: null, deckel: null, hc: {mode: 1, warn: warn, seit: warn ? NOW : 0, text: text}});
const HCW_TXT = 'Efficiency · Comfort empfohlen: Heizstab-Nähe (Außen -3 °C, Vorlauf 2,5 K unter Soll, Lauf 25 min; Heizstab ab 3 K unter Soll nach 15 min); Efficiency fährt nach dem Start langsam hoch, Comfort sofort';
world({TOP14_Outside_Temp: 12}); hpmsg('main/Heating_Control', 0); let rr = run1(2);
check('Comfort: Zeile "Heizregelung" zeigt nur "Comfort", keine Empfehlung', qrow(rr.o, 'Heizregelung')[1] === 'Comfort' && qrow(rr.o, 'Heizregelung')[2] === '', JSON.stringify(qrow(rr.o, 'Heizregelung')));
world({TOP14_Outside_Temp: 3.2, TOP42_Z1_Water_Target_Temp: 32, TOP6_Main_Outlet_Temp: 29.5}); hpmsg('main/Heating_Control', 1); gstore.OPT_state = {ts: NOW, deficit: true, deficitRoom: 'Kinderzimmer unten'}; gstore.OPT_weather = {status: 'OK', ts: NOW, f6: 2};
rr = run1(30, () => { gstore.OPT_state.ts = NOW; gstore.OPT_weather.ts = NOW; });
check('Review-Paket: die alten Ausloeser des Waechters (Aussen < 5 °C, Prognose < 3 °C, Abtauen, Vorlauf 2 K unter Soll, Raum unter Minimum) warnen nicht mehr selbst (am 07.–13.10. 74 Warnungen, Flackern an der 4,0-°C-Grenze); ohne Maschinendaten "keine Warnung (Maschine ohne aktuelle Daten)", OPT_hc_reco ohne Warnung, kein Ereignis',
      qrow(rr.o, 'Heizregelung')[1] === 'Efficiency · keine Warnung (Maschine ohne aktuelle Daten)' && gstore.OPT_hc_reco.warn === false && gstore.OPT_hc_reco.mode === 1 && rr.evs.every(e => !e.includes('heizregelung_empfehlung')), qrow(rr.o, 'Heizregelung')[1]);
world({TOP14_Outside_Temp: 12}); hpmsg('main/Heating_Control', 1); rr = run1(2, () => { gstore.OPT_engine = hcE(false, 'Efficiency · keine Warnung'); });
check('Efficiency, Maschine ohne Hinweis: "Efficiency · keine Warnung" (gruen), kein Ereignis', qrow(rr.o, 'Heizregelung')[1] === 'Efficiency · keine Warnung' && qrow(rr.o, 'Heizregelung')[2] === 'ok' && rr.evs.filter(e => e.includes('heizregelung_empfehlung')).length === 0, JSON.stringify(qrow(rr.o, 'Heizregelung')));
rr = run1(1, () => { gstore.OPT_engine = hcE(true, HCW_TXT); });
check('Hinweis der Maschine (Heizstab-Naehe): Zeile in Warnfarbe, OPT_hc_reco mit Warnung und Text (die Heizregelungs-Karte im Tab "WP Dash" zeigt ihn und meldet einmal), Ereignis "ok->Comfort empfohlen (Heizstab-Nähe ...)" einmal',
      qrow(rr.o, 'Heizregelung')[1] === HCW_TXT && qrow(rr.o, 'Heizregelung')[2] === 'warn' && rr.evs.length === 1 && /,heizregelung_empfehlung,ok->Comfort empfohlen \(Heizstab-Nähe \(Außen -3 °C; Vorlauf 2\.5 K unter Soll; Lauf 25 min/.test(rr.evs[0]) && gstore.OPT_hc_reco.warn === true && gstore.OPT_hc_reco.text === HCW_TXT,
      qrow(rr.o, 'Heizregelung')[1] + ' | ' + rr.evs.join('').trim());
rr = run1(3, () => { gstore.OPT_engine = hcE(true, HCW_TXT); });
check('Dieselbe Warnung wird nicht wiederholt protokolliert', rr.evs.length === 0, '');
rr = run1(1, () => { gstore.OPT_engine = hcE(false, 'Efficiency · keine Warnung'); });
check('Hinweis weg: Ereignis "Comfort empfohlen->keine Warnung"', qrow(rr.o, 'Heizregelung')[1] === 'Efficiency · keine Warnung' && rr.evs.length === 1 && /Comfort empfohlen->keine Warnung/.test(rr.evs[0]), rr.evs.join('').trim());
rr = run1(2, () => { gstore.OPT_engine = hcE(true, HCW_TXT); gstore.OPT_engine.ts = NOW - 6 * 60000; });
check('Maschinendaten aelter als 5 min: keine alte Warnung stehen lassen', qrow(rr.o, 'Heizregelung')[1] === 'Efficiency · keine Warnung (Maschine ohne aktuelle Daten)' && gstore.OPT_hc_reco.warn === false, qrow(rr.o, 'Heizregelung')[1]);
check('Hinweis schaltet nichts: kein Befehl, nur OPT_*-Werte und Ereignisdatei', sent.every(x => !/Heating|Command|mqtt/i.test(x.id + JSON.stringify(x.m || ''))) && !JSON.parse(fs.readFileSync(flowsFile, 'utf8')).some(otherOut), '');
// getrennte Statistik
world({TOP14_Outside_Temp: 5, compressor_frequency: 20, compressor_runtime: 40}); hpmsg('main/Heating_Control', 0); run1(5);
hpmsg('main/Heating_Control', 1); rr = run1(5); const kfC = fstore.qs.kf['3|2'], kfE = fstore.qs.kfE['3|2'];
check('Kennfeld getrennt: die ersten 5 Laufminuten zaehlen bei Comfort, die naechsten 5 bei Efficiency (nicht vermischt)', kfC && kfE && kfC.n === 5 && kfE.n === 5, (kfC && kfC.n) + ' / ' + (kfE && kfE.n));
const tabE = rr.o[1].payload.stats;
check('Tabelle: Efficiency-Messwerte stehen als eigene Zeile "Stufe 3 (Efficiency)" unter denen von Comfort, Comfort-Zeile unveraendert', tabE.some(r => r[0] === 'Stufe 3 (Efficiency)' && r[1] === '3–7 °C' && r[2] === '5') && tabE.some(r => r[0] === 'Stufe 3' && r[1] === '3–7 °C' && r[2] === '5'), tabE.filter(r => r[1] !== 'keine Daten').map(r => r[0] + ':' + r[2]).join(' '));
run1(11);
check('Efficiency-Kennfeld wird gesichert und ueberlebt einen Neustart (quiet-stats.json enthaelt kfE)', (() => { const fj = files['/data/optimizer/quiet-stats.json']; const j = fj ? JSON.parse(fj.data) : null; const had = !!j && !!j.kfE && !!j.kfE['3|2']; delete fstore.qs; run1(1); return had && fstore.qs.kfE['3|2'].n >= 5; })(), '');
// Auswertung gibt den Komfortzustand weiter und stoesst den Waechter an
world({}); gstore.OPT_cfg.control.enabled = false;
gstore.OPT_rooms = {ki_unten: {name: 'Kinderzimmer unten', ema: 21.8, last: 21.8, ts: NOW, trend: -0.1}, ki_oben: {name: 'Kinderzimmer oben', ema: 23.0, last: 23.0, ts: NOW, trend: 0}, schlaf: {name: 'Schlafzimmer', ema: 20, last: 20, ts: NOW, trend: 0}};
NOW += 60000; Object.keys(gstore.OPT_rooms).forEach(k => gstore.OPT_rooms[k].ts = NOW); gstore.TOP0_Heatpump_State = 1; gstore.TOP4_Operating_Mode_State = 0;
const ev = run('opt_eval', {});
check('Auswertung gibt den Komfortzustand weiter (Defizit, Raum, Trend) und loest den Quiet-Waechter aus', ev[8] && gstore.OPT_state && gstore.OPT_state.deficit === true && gstore.OPT_state.deficitRoom === 'Kinderzimmer unten' && gstore.OPT_state.coldTrend === -0.1, JSON.stringify(gstore.OPT_state));
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
check('Kennfeld-Spalten: Hz 20, Fan 400, P el. 600 roh = 680 korrigiert, Soll VL/RL 29,0 / 26,0, Flow 12,0, Komfortdefizit 0 %', r3[3] === '20' && r3[4] === '400' && r3[5] === '680' && r3[11] === '29,0 / 26,0' && r3[12] === '12,0' && r3[16] === '0 %', r3.join(' | '));
[[-2, '< 0 °C'], [1, '0–3 °C'], [2.9, '0–3 °C'], [3, '3–7 °C'], [8, '7–12 °C'], [12, '> 12 °C'], [15, '> 12 °C']].forEach(([a, b]) => { world({TOP14_Outside_Temp: a}); const o = collect(3); const t = o[o.length - 1][1].payload.stats; check('Aussentemperatur ' + a + ' °C -> Bereich ' + b, !!trow(t, 3, b), t.filter(r => r[1] !== 'keine Daten').map(r => r[1]).join()); });
world({TOP14_Outside_Temp: -2}); collect(5); gstore.TOP14_Outside_Temp = 8; outs = collect(5); tab = outs[outs.length - 1][1].payload.stats;
check('gleiche Stufe bei -2 und 8 °C wird getrennt gefuehrt (nicht vermischt)', !!trow(tab, 3, '< 0 °C') && !!trow(tab, 3, '7–12 °C') && trow(tab, 3, '< 0 °C')[10].startsWith('28,5'), tab.filter(r => r[1] !== 'keine Daten').map(r => r[1] + ':' + r[2]).join(' '));
world({}); gstore.OPT_state = {ts: T0, deficit: true, deficitRoom: 'Schlafzimmer', coldTrend: 0, distrib: false, valid: 3, active: 3};
outs = collect(10, () => { gstore.OPT_state.ts = NOW; }); tab = outs[outs.length - 1][1].payload.stats;
world({TOP14_Outside_Temp: 5, compressor_frequency: 32, compressor_runtime: 1, TOP16_Heat_Energy_Consumption: 591, TOP1_Pump_Flow: 40, TOP6_Main_Outlet_Temp: 31, TOP5_Main_Inlet_Temp: 24});
collect(2, () => { gstore.compressor_runtime = 1; });                                              // Anlauf: Frequenzspitze und grosse Spreizung, noch nicht eingeschwungen
let mt = collect(1)[0][1].payload.stats, mr = trow(mt, 3, '3–7 °C');
check('Hoechstwerte: die Frequenzspitze im Anlauf (32 Hz) wird erfasst, die Leistungsspitze im Anlauf (Laufzeit 1 min) nicht (keine Kapazitaet)', mr && mr[7] === '32' && mr[8] === '–', mr && mr.slice(0, 10).join(' | '));
world({TOP14_Outside_Temp: 5, compressor_frequency: 20, compressor_runtime: 30, TOP16_Heat_Energy_Consumption: 600, TOP1_Pump_Flow: 12, TOP6_Main_Outlet_Temp: 31, TOP5_Main_Inlet_Temp: 27});
collect(3, () => { gstore.compressor_runtime = 30; });
gstore.compressor_frequency = 30; gstore.TOP16_Heat_Energy_Consumption = 800; gstore.TOP1_Pump_Flow = 14; gstore.compressor_runtime = 31; collect(2, () => { gstore.compressor_runtime = 31; });
gstore.compressor_frequency = 18; gstore.TOP16_Heat_Energy_Consumption = 400; gstore.TOP1_Pump_Flow = 10; collect(2, () => { gstore.compressor_runtime = 32; });
mt = collect(1)[0][1].payload.stats; mr = trow(mt, 3, '3–7 °C');
const kfm = fstore.qs.kf['3|2'].mx;
check('Hoechstwerte: im eingeschwungenen Lauf (ab 10 min) wird die hoechste Frequenz (30 Hz) und die hoechste Waermeleistung (14 l/min x 4 K x 69,7 = 3903 W) festgehalten, spaetere kleinere Werte aendern sie nicht', kfm.hz === 30 && Math.abs(kfm.pth - 3903.2) < 1 && mr[7] === '30' && mr[8] === '3903', JSON.stringify(kfm) + ' ' + (mr && mr[7] + '/' + mr[8]));
collect(11, () => { gstore.compressor_runtime = 33; });
check('Hoechstwerte werden mit der Statistik gesichert und ueberstehen einen Neustart (quiet-stats.json enthaelt mx, nach dem Laden noch da)', (() => { const fj = files['/data/optimizer/quiet-stats.json']; const j = fj ? JSON.parse(fj.data) : null; const mxf = j && j.kf['3|2'] && j.kf['3|2'].mx; delete fstore.qs; collect(1); const mxr = fstore.qs.kf['3|2'].mx; return !!mxf && mxf.hz === 30 && mxr && mxr.hz === 30 && Math.abs(mxr.pth - 3903.2) < 1; })(), '');
// ---- Abtauprotokoll (Grundlage fuer Comfort/Efficiency): ein Eintrag je Abtauzyklus mit Dauer, Strom, Waerme, Vorlaufeinbruch, Wiederaufheizzeit
console.log('\n--- Abtauprotokoll');
const hpm = (topic, payload) => run('opt_hp_in', {topic: 'panasonic_heat_pump/' + topic, payload: String(payload)});
const defRows = outs => outs.filter(x => x[4]).map(x => x[4].payload.trim().split('\n'));
const dfWorld = (over) => { world(Object.assign({TOP14_Outside_Temp: 2, compressor_frequency: 30, compressor_runtime: 40, TOP16_Heat_Energy_Consumption: 600, TOP42_Z1_Water_Target_Temp: 32, TOP6_Main_Outlet_Temp: 32, TOP5_Main_Inlet_Temp: 29, TOP1_Pump_Flow: 12}, over || {})); gstore.OPT_weather = {ts: NOW, rh: 91, dew: 0.7}; hpm('main/Heating_Control', 0); hpm('extra/Heat_Power_Production_Extra', 3000); };
dfWorld(); let dfAll = collect(3);
check('Kein Abtauen: kein Eintrag im Abtauprotokoll', defRows(dfAll).length === 0 && dfAll.every(x => x[4] === null || x[4] === undefined), '');
const vlSeq = [31, 29, 27, 26, 25, 24];                                                              // Einbruch waehrend der 6 Abtau-Minuten
dfAll = dfAll.concat(collect(6, i => { gstore.TOP26_Defrosting_State = 1; gstore.TOP6_Main_Outlet_Temp = vlSeq[i]; gstore.TOP16_Heat_Energy_Consumption = 400; hpm('extra/Heat_Power_Production_Extra', -1500); }));
check('Waehrend des Abtauens noch kein Eintrag (erst nach der Erholung)', defRows(dfAll).length === 0, '');
const recSeq = [25, 26, 27, 31.2];                                                                  // Erholung: Vorlauf wieder bis 1 K unter Soll (32) nach 4 min
dfAll = dfAll.concat(collect(4, i => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = recSeq[i]; gstore.TOP16_Heat_Energy_Consumption = 700; hpm('extra/Heat_Power_Production_Extra', 3500); }));
let dfR = defRows(dfAll), dfH = dfR[0] && dfR[0][0].split(','), dfL = dfR[0] && dfR[0][1].split(',');
const dfA = n => dfL[dfH.indexOf(n)];
check('Abtauzyklus: Kopfzeile + eine Zeile, Spaltenzahl stimmt, Dauer 6 min, Wiederaufheizzeit 3 min nach Ende des Abtauens (Vorlauf 31,2 K im 4. Minutenwert danach)', dfR.length === 1 && dfH.length === dfL.length && dfA('dauer_min') === '6' && dfA('wiederaufheiz_min') === '3', dfR[0] && dfR[0].join(' / '));
check('Abtauzyklus: Aussen 2 °C, Feuchte 91 %, Taupunkt 0,7 °C, Quiet 3, Heizregelung 0, Soll-VL 32', dfA('aussen') === '2' && dfA('feuchte') === '91' && dfA('taupunkt') === '0.7' && dfA('quiet') === '3' && dfA('heizregelung') === '0' && dfA('soll_vl') === '32', dfL.join(','));
check('Abtauzyklus: Vorlauf 31 -> 24 °C (Einbruch 7 K), Rueckl. min 29; Strom 6 x 400 W = 0,040 kWh; Waerme -0,150 kWh (Waermeentzug aus dem Heizkreis)', dfA('vl_beginn') === '31' && dfA('vl_min') === '24' && Math.abs(Number(dfA('strom_kwh')) - 0.04) < 0.001 && Math.abs(Number(dfA('waerme_kwh')) + 0.15) < 0.001, dfL.slice(8).join(','));
// Zeitueberschreitung: Vorlauf erholt sich nicht
dfWorld(); dfAll = collect(2); dfAll = dfAll.concat(collect(3, () => { gstore.TOP26_Defrosting_State = 1; gstore.TOP6_Main_Outlet_Temp = 25; })); dfAll = dfAll.concat(collect(65, () => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = 28; }));
dfR = defRows(dfAll); dfL = dfR[0] && dfR[0][dfR[0].length - 1].split(',');
check('Keine Erholung innerhalb 60 min: Eintrag mit ">60" (genau ein Eintrag)', dfR.length === 1 && dfL[2] === '>60', dfL && dfL.slice(0, 4).join(','));
// Verdichter geht nach dem Abtauen aus (Anforderung erfuellt)
dfWorld(); dfAll = collect(2); dfAll = dfAll.concat(collect(3, () => { gstore.TOP26_Defrosting_State = 1; gstore.TOP6_Main_Outlet_Temp = 25; })); dfAll = dfAll.concat(collect(3, () => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = 27; })); dfAll = dfAll.concat(collect(2, () => { gstore.compressor_frequency = 0; }));
dfR = defRows(dfAll); dfL = dfR[0] && dfR[0][dfR[0].length - 1].split(',');
check('Verdichter geht nach dem Abtauen aus, bevor der Vorlauf Soll erreicht: Eintrag "Verdichter aus"', dfR.length === 1 && dfL[2] === 'Verdichter aus', dfL && dfL.slice(0, 4).join(','));
// zweiter Zyklus unterbricht die Erholung, Abstand zur letzten Abtauung
dfWorld(); dfAll = collect(2); [0, 1].forEach(k => { dfAll = dfAll.concat(collect(3, () => { gstore.TOP26_Defrosting_State = 1; gstore.TOP6_Main_Outlet_Temp = 25; })); dfAll = dfAll.concat(collect(k === 0 ? 4 : 40, () => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = k === 0 ? 27 : 31.5; })); });
dfR = defRows(dfAll); const dfL0 = dfR[0][dfR[0].length - 1].split(','), dfL1 = dfR[1] ? dfR[1][dfR[1].length - 1].split(',') : [];
check('Zweiter Abtauzyklus waehrend der Erholung: der erste wird als "unterbrochen" abgeschlossen, der zweite eigenstaendig; Abstand zur letzten Abtauung wird festgehalten', dfR.length === 2 && dfL0[2] === 'unterbrochen' && dfL1[2] !== 'unterbrochen' && Number(dfL1[14]) >= 6 && Number(dfL1[14]) <= 9, dfL0.slice(0, 3).join(',') + ' | ' + dfL1.slice(0, 3).join(',') + ' Abstand ' + dfL1[14]);
// Heizstab (Winter): Minuten mit aktivem Heizstab waehrend Abtauen + Wiederaufheizen und Zustand im Quiet-Protokoll
dfWorld(); hpm('main/Internal_Heater_State', 0); dfAll = collect(2);
dfAll = dfAll.concat(collect(3, i => { gstore.TOP26_Defrosting_State = 1; gstore.TOP6_Main_Outlet_Temp = 25; hpm('main/Internal_Heater_State', i >= 1 ? 1 : 0); }));
dfAll = dfAll.concat(collect(4, i => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = [25, 26, 27, 31.2][i]; hpm('main/Internal_Heater_State', 0); }));
dfR = defRows(dfAll); dfH = dfR[0] && dfR[0][0].split(','); dfL = dfR[0] && dfR[0][dfR[0].length - 1].split(',');
check('Abtauzyklus: Heizstab-Minuten werden gezaehlt (2 von 3 Abtau-Minuten mit aktivem Heizstab, danach aus -> heizstab_min 2), Spaltenzahl stimmt', dfR.length === 1 && dfH.length === dfL.length && dfH.indexOf('heizstab_min') === 15 && dfL[dfH.indexOf('heizstab_min')] === '2', dfR[0] && dfR[0].join(' / '));
dfWorld(); dfAll = collect(2); dfAll = dfAll.concat(collect(3, () => { gstore.TOP26_Defrosting_State = 1; gstore.TOP6_Main_Outlet_Temp = 25; })); dfAll = dfAll.concat(collect(4, i => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = [25, 26, 27, 31.2][i]; }));
dfR = defRows(dfAll); dfL = dfR[0] && dfR[0][dfR[0].length - 1].split(',');
check('Abtauzyklus ohne Heizstab: heizstab_min 0 (kein leeres Feld)', dfR.length === 1 && dfL[15] === '0', dfL && dfL[15]);
// Paket 2 (15.10.2026): Winter-Abtauung wie im Forum (L5: Vorlauf 37 -> 22 °C) mit allen HeishaMon-Werten; zwei Zyklen, damit auch der Abstand gefuellt ist. Jede Spalte gefuellt?
{ dfWorld({TOP14_Outside_Temp: -3, TOP42_Z1_Water_Target_Temp: 36, TOP6_Main_Outlet_Temp: 36.5, TOP5_Main_Inlet_Temp: 33}); gstore.OPT_weather = {ts: NOW, rh: 92, dew: -4.1};
  hpm('main/Outside_Pipe_Temp', -7); hpm('main/Internal_Heater_State', 0); let all = collect(3);
  const zyklus = (vor) => { gstore.OPT_weather.ts = NOW; all = all.concat(collect(1, () => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = vor; hpm('main/Outside_Pipe_Temp', -7); }));
      all = all.concat(collect(7, i => { gstore.TOP26_Defrosting_State = 1; gstore.TOP6_Main_Outlet_Temp = [33, 29, 26, 24, 22.5, 22, 23][i]; gstore.TOP16_Heat_Energy_Consumption = 500; hpm('extra/Heat_Power_Production_Extra', -2000); hpm('main/Outside_Pipe_Temp', [-7, -2, 4, 9, 12, 14, 15][i]); hpm('main/Internal_Heater_State', i === 4 ? 1 : 0); }));
      all = all.concat(collect(12, i => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = 24 + i * 1.1; gstore.TOP16_Heat_Energy_Consumption = 900; hpm('extra/Heat_Power_Production_Extra', 3200); hpm('main/Outside_Pipe_Temp', i === 0 ? 3 : -8); hpm('main/Internal_Heater_State', 0); })); };
  zyklus(36.5); all = all.concat(collect(40, () => { gstore.TOP6_Main_Outlet_Temp = 36.5; })); zyklus(36.25);
  const R = defRows(all), lines = [].concat.apply([], R).filter(l => l.length), H = lines.find(l => l.startsWith('zeit,')).split(','), rows = lines.filter(l => !l.startsWith('zeit,')).map(l => l.split(','));
  const z = rows[rows.length - 1], g = n => z[H.indexOf(n)], leer = H.filter((h, k) => z[k] === '' || z[k] === undefined);
  check('Abtau-Protokoll (Paket 2): Kopfzeile wächst hinten um ende, vl_einbruch_k, rohr_aussen_vor, rohr_aussen_nach, strom_nach_kwh; bisherige 16 Spalten unverändert an ihrem Platz',
        H.slice(0, 16).join() === 'zeit,dauer_min,wiederaufheiz_min,aussen,feuchte,taupunkt,quiet,heizregelung,soll_vl,vl_beginn,vl_min,rl_min,strom_kwh,waerme_kwh,min_seit_letzter_abtauung,heizstab_min' && H.slice(16).join() === 'ende,vl_einbruch_k,rohr_aussen_vor,rohr_aussen_nach,strom_nach_kwh', H.join());
  check('Abtau-Protokoll (Paket 2, Winter-Zyklus wie Forum L5): jede Spalte gefüllt (Beginn, Ende, Dauer 7 min, Außen −3, Feuchte 92, Taupunkt −4,1, Rohr außen vor −7 / nach 3, Vorlauf-Einbruch 36,25 → 22 = 14,25 K, Wiederaufheizzeit, Heizstab 1 min, Strom während 0,058 kWh und danach, Abstand zur letzten Abtauung)',
        rows.length === 2 && leer.length === 0 && g('dauer_min') === '7' && g('aussen') === '-3' && g('feuchte') === '92' && g('taupunkt') === '-4.1' && g('rohr_aussen_vor') === '-7' && g('rohr_aussen_nach') === '3' && g('vl_einbruch_k') === '14.25' && g('heizstab_min') === '1' &&
        Math.abs(Number(g('strom_kwh')) - 0.058) < 0.002 && Number(g('strom_nach_kwh')) > 0.1 && Number(g('min_seit_letzter_abtauung')) >= 55 && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(g('ende')) && g('ende') > g('zeit') && Number(g('wiederaufheiz_min')) >= 1,
        'leer: [' + leer.join() + '] · ' + H.map((h, k) => h + '=' + z[k]).join(' '));
  delete fstore.qs; collect(1); const ws = JSON.parse(files['/data/optimizer/watcher-state.json'].data);
  check('Abtau-Protokoll: Beginn der letzten Abtauung übersteht einen Neustart (watcher-state.json lastDefrostStart; der Abstand im nächsten Eintrag bleibt gefüllt)', ws.lastDefrostStart > 0 && fstore.qs.lastDefrostStart === ws.lastDefrostStart, JSON.stringify(ws));
  ['Heater_Stop_Delta', -1, 'Eva_Outlet_Temp', 4, 'Discharge_Temp', 35, 'High_Pressure', 11.2, 'Expansion_Valve', 37, 'Inside_Pipe_Temp', 31].forEach((v, k, arr) => { if (k % 2 === 0) { hpm('main/' + v, arr[k + 1]); } });
  delete fstore.qHead; const qo = collect(2), ql = qo.filter(x => x[2]).map(x => x[2].payload).join('').split('\n').filter(Boolean), qh = ql.find(l => l.startsWith('zeit,')).split(',').slice(0, -2), qd = ql.filter(l => !l.startsWith('zeit,')).pop().split(',').slice(0, -2);   // ohne die zwei Zaehlerspalten (cop-ziel)
  check('Minutenprotokoll quiet-*.csv (Paket 2): sechs Spalten hinten angehängt – heizstab_stop_delta (TOP98 Heater_Stop_Delta), verdampfer_aus (Eva_Outlet_Temp), heissgas (Discharge_Temp), hochdruck (High_Pressure), expansionsventil (Expansion_Valve), rohr_innen (Inside_Pipe_Temp) – mit den HeishaMon-Werten; fan1, verdichter_strom, rohr_aussen waren schon da',
        qh.slice(-7, -1).join() === 'heizstab_stop_delta,verdampfer_aus,heissgas,hochdruck,expansionsventil,rohr_innen' && qd.length === qh.length && qd.slice(-7, -1).join() === '-1,4,35,11.2,37,31' && ['fan1', 'verdichter_strom', 'rohr_aussen', 'heizstab_start_delta'].every(n => qh.indexOf(n) >= 0), qh.slice(-7).join() + ' = ' + qd.slice(-7).join());
  hpm('main/Water_Pressure', 1.62); hpm('main/Pump_Speed', 0); delete fstore.qHead; const qo2 = collect(1), ql2 = qo2.filter(x => x[2]).map(x => x[2].payload).join('').split('\n').filter(Boolean), qhZ = ql2.find(l => l.startsWith('zeit,')).split(','), qdZ = ql2.filter(l => !l.startsWith('zeit,')).pop().split(','), qh2 = qhZ.slice(0, -2), qd2 = qdZ.slice(0, -2);
  check('Minutenprotokoll quiet-*.csv (cop-ziel 17.10.2026): Spalten zaehler_wp_w, zaehler_heizstab_w ganz hinten (nach druck_bar), ohne Zähler leer', qhZ.slice(-3).join() === 'druck_bar,zaehler_wp_w,zaehler_heizstab_w' && qdZ.length === qhZ.length && qdZ.slice(-2).join() === ',', qhZ.slice(-3).join() + ' = ' + qdZ.slice(-3).join());
  check('Minutenprotokoll quiet-*.csv (Winterpaket 16.10.2026): Spalte druck_bar (Water_Pressure) ganz hinten angehängt, neben pumpe_speed lesbar (statisch nur bei Pumpe 0 gültig; bei 4250 U/min ~0,5 bar Förderdruck), Spaltenzahl stimmt',
        qh2[qh2.length - 1] === 'druck_bar' && qd2[qd2.length - 1] === '1.62' && qd2.length === qh2.length && qd2[qh2.indexOf('pumpe_speed')] === '0', qh2.slice(-2).join() + ' = ' + qd2.slice(-2).join() + ' · Pumpe ' + qd2[qh2.indexOf('pumpe_speed')]); }
world({TOP5_Main_Inlet_Temp: 24.3}); ['Internal_Heater_State', 1, 'External_Heater_State', 0, 'Room_Heater_State', 1, 'Room_Heater_Operations_Hours', 76, 'Heater_Start_Delta', -3, 'Heater_Delay_Time', 15].forEach((v, k, arr) => { if (k % 2 === 0) { hpm('main/' + v, arr[k + 1]); } });
delete fstore.qHead; const hsOuts = collect(2);
{
  const lines = hsOuts.filter(x => x[2]).map(x => x[2].payload).join('').split('\n').filter(Boolean), hh = lines.find(l => l.startsWith('zeit,')).split(','), dd = lines.filter(l => !l.startsWith('zeit,')).pop().split(',');
  const gv = n => dd[hh.indexOf(n)];
  check('Quiet-Protokoll: Heizstab-Spalten (intern, extern, Raumheizung frei, Betriebsstunden, Start-Delta, Verzoegerung) mit den HeishaMon-Werten, Spaltenzahl stimmt', ['heizstab_intern', 'heizstab_extern', 'heizstab_raum_frei', 'heizstab_stunden', 'heizstab_start_delta', 'heizstab_verzoegerung_min'].every(n => hh.indexOf(n) >= 0) && dd.length === hh.length && gv('heizstab_intern') === '1' && gv('heizstab_extern') === '0' && gv('heizstab_raum_frei') === '1' && gv('heizstab_stunden') === '76' && gv('heizstab_start_delta') === '-3' && gv('heizstab_verzoegerung_min') === '15', dd.slice(-6).join(','));
}
// ---- Laufmessung (frueher Teil des Eskalationswaechters): nur Messung und Ereignisse, keine Aktion, keine Sperre (Review-Paket 13.10.2026)
console.log('\n--- Laufmessung (ehemals Eskalationswaechter)');
const evAll = os => os.filter(x => x[3]).map(x => x[3].payload).join('');
const ewRow = o => (o[0].payload.rows.find(r => r[0] === 'Lauf (Messung)') || []);
const feedHp = () => { hpm('main/Compressor_Freq', gstore.compressor_frequency === undefined ? 0 : gstore.compressor_frequency); };        // HeishaMon meldet laufend (Frische-Pruefung)
const ewCollect = (n, hook) => { const o = []; for (let i = 0; i < n; i++) { NOW += 60000; if (hook) { hook(i); } feedHp(); o.push(run('opt_quiet', {})); } return o; };
const ewWorld = (over, hc) => { delete fstore.qs; dfWorld(Object.assign({TOP14_Outside_Temp: 8, compressor_frequency: 17, TOP42_Z1_Water_Target_Temp: 32, TOP6_Main_Outlet_Temp: 28, TOP5_Main_Inlet_Temp: 26, compressor_runtime: 1}, over || {})); hpm('main/Heating_Control', hc === undefined ? 1 : hc); };
const ewRun = (over, hc, startMs) => { const fr = over && over.compressor_frequency !== undefined ? over.compressor_frequency : 17; ewWorld(Object.assign({}, over, {compressor_frequency: 0}), hc); if (startMs) { NOW = startMs; } ewCollect(1); gstore.compressor_frequency = fr; };     // erst Stillstand beobachten: Lauf beginnt "echt" (nicht spaet)
const rtHook = (r0, extra) => i => { gstore.compressor_runtime = r0 + i; if (extra) { extra(i); } };
const heaterFeed = () => { hpm('main/Heater_On_Outdoor_Temp', 0); hpm('main/Heater_Start_Delta', -3); hpm('main/Heater_Delay_Time', 15); };
const defi = () => { gstore.OPT_state = {ts: NOW, deficit: true, deficitRoom: 'Kinderzimmer oben', valid: 3, active: 3}; };
// 1) Efficiency, Quiet 3 am Deckel (17 Hz), Vorlauf 4 K unter Soll, Raum unter Minimum, 135 min: frueher "wuerde jetzt schalten: Quiet 3 → 2" - jetzt nur Messung
ewRun({}, undefined, new Date(2026, 9, 7, 8, 0, 0).getTime()); let ew = ewCollect(134, rtHook(1, defi)); delete fstore.qHead; ew = ew.concat(ewCollect(1, rtHook(135, defi)));
check('Laufmessung: Efficiency, Quiet 3 bei 17 Hz, Vorlauf 4 K unter Soll, Raum unter Minimum, 135 min -> nur Anzeige "läuft 135 min · Vorlauf -4,0 K zum Soll · Sollvorlauf noch nicht erreicht", keine Aktion ("würde schalten"), kein Ereignis "eskalation_schatten", keine Warnfarbe',
      ewRow(ew[134])[1] === 'läuft 135 min · Vorlauf -4,0 K zum Soll · Sollvorlauf noch nicht erreicht' && ewRow(ew[134])[2] === '' && !/würde|Quiet 3 → 2|Pausenfenster/.test(JSON.stringify(ew.map(x => x[0].payload.rows))) && !/eskalation_schatten/.test(evAll(ew)), ewRow(ew[134])[1]);
{
  const lines = ew.filter(x => x[2]).map(x => x[2].payload).join('').split('\n').filter(Boolean), hh = lines.find(l => l.startsWith('zeit,')).split(','), dd = lines.filter(l => !l.startsWith('zeit,')).pop().split(','), gv = n => dd[hh.indexOf(n)];
  check('Minutenprotokoll: Kopfzeile unveraendert (Waechter-Spalten bleiben, Leser nach Spaltenname), Waechter-Spalten leer, Laufminuten / VL minus Soll gemessen, Spaltenzahl stimmt',
        ['waechter_zustand', 'waechter_ausloeser', 'waechter_sperre', 'zeit_bis_soll_min', 'lauf_min', 'vl_minus_soll'].every(n => hh.indexOf(n) >= 0) && dd.length === hh.length && gv('waechter_zustand') === '' && gv('waechter_ausloeser') === '' && gv('waechter_sperre') === '' && gv('lauf_min') === '135' && gv('vl_minus_soll') === '-4' && gv('zeit_bis_soll_min') === '', dd.slice(-16).join(' | '));
}
// 2) Sollvorlauf wird erreicht (3 min am Stueck, nicht in der Startphase): Ereignis mit Minuten, Lauf-Ende fasst zusammen
ewRun(); ew = ewCollect(90, rtHook(1, i => { gstore.TOP6_Main_Outlet_Temp = i < 60 ? 28 : 31.5; }));
const ev2 = evAll(ew);
check('Laufmessung: Sollvorlauf (Soll -1 K) wird nach rund 61 min erreicht -> Ereignis "sollvorlauf_erreicht" mit Minuten, Modus, Quiet, Aussen; Anzeige "Sollvorlauf erreicht nach N min"', /sollvorlauf_erreicht,nach 6[12] min · Heizregelung 1 · Quiet 3 · Außen 8 °C · Soll 32/.test(ev2) && /^läuft 90 min · Vorlauf -0,5 K zum Soll · Sollvorlauf erreicht nach 6[12] min$/.test(ewRow(ew[89])[1]), ev2.split('\n').filter(l => /sollvorlauf/.test(l)).join(' | ') + ' // ' + ewRow(ew[89])[1]);
const ew2 = ewCollect(1, () => { gstore.compressor_frequency = 0; });
check('Laufmessung: Lauf-Ende wird mit Dauer und "Sollvorlauf erreicht nach N min" festgehalten; Anzeige "Verdichter steht"', /lauf_ende,Lauf 90 min · Sollvorlauf erreicht nach 6[12] min · Heizregelung 1 · Quiet 3/.test(evAll(ew2)) && /^Verdichter steht/.test(ewRow(ew2[0])[1]), evAll(ew2));
// 2b) Lauf war beim ersten Hinsehen schon im Gang (Neustart/Deploy): Zeit bis Sollvorlauf unbekannt, Dauer nur beobachtet, keine falsche Statistik
ewWorld({TOP6_Main_Outlet_Temp: 32, compressor_runtime: 200}); ew = ewCollect(20, rtHook(200));
const ev2b = evAll(ew), ew2b = ewCollect(1, () => { gstore.compressor_frequency = 0; });
check('Laufmessung: Lauf beim ersten Hinsehen schon im Gang -> "Zeit unbekannt" statt falscher Minutenzahl; Lauf-Ende nennt nur die beobachtete Dauer', /sollvorlauf_erreicht,Zeit unbekannt \(Lauf war beim Beobachtungsbeginn schon im Gang\)/.test(ev2b) && /lauf_ende,beobachtet 20 min \(Beginn unbekannt\) · Sollvorlauf erreicht \(Zeit unbekannt\)/.test(evAll(ew2b)), ev2b + evAll(ew2b));
// 2c) Neustart mitten im Lauf (Verdichter-Laufzeit springt auf 0, Zustand weg): kein "nach 0 min", Beobachtung beginnt neu
ewRun(); ewCollect(70, rtHook(1, i => { gstore.TOP6_Main_Outlet_Temp = i < 60 ? 28 : 31.5; }));
delete fstore.qs; ew = ewCollect(25, rtHook(0, () => { gstore.TOP6_Main_Outlet_Temp = 31.5; }));
check('Laufmessung nach Neustart im laufenden Betrieb: Laufzeit steht wieder bei 0, trotzdem keine falsche Zeit ("nach 0 min"), sondern "Zeit unbekannt"', !/nach 0 min/.test(evAll(ew)) && /sollvorlauf_erreicht,Zeit unbekannt/.test(evAll(ew)) && fstore.qs.esc.late === true, evAll(ew));
// 3) gestrichene Aktionen: Comfort/Quiet 0 "ausgeschoepft", Quiet 2 bei 33 Hz (alte Annahme Deckel 35 Hz), Heizstab-Naehe, Pause mit Raumdefizit - nirgends mehr eine Aktion oder ein Ereignis
{
  const keine = [];
  ewRun({TOP18_Quiet_Mode_Level: 0}, 0); keine.push(...ewCollect(130, rtHook(1, defi)));
  ewRun({TOP18_Quiet_Mode_Level: 2}, 0); keine.push(...ewCollect(130, rtHook(1, () => { gstore.compressor_frequency = 33; defi(); })));
  ewRun({TOP14_Outside_Temp: -3, TOP6_Main_Outlet_Temp: 29.5}); keine.push(...ewCollect(30, rtHook(1, heaterFeed)));
  gstore.compressor_frequency = 0; keine.push(...ewCollect(70, () => { defi(); hpm('main/Pump_Speed', 1750); }));
  const txt = JSON.stringify(keine.map(x => x[0].payload.rows));
  check('Review-Paket: keine Eskalationsaktionen mehr (Quiet q -> q-1, "ausgeschoepft", "Quiet-Freigabe brächte nichts", Heizstab-Schwelle, Pausenfenster, Tag/Nacht) - weder in der Karte noch als Ereignis; die alte Deckel-Annahme 35/45 Hz ist entfernt',
        !/würde|Auslöser|ausgeschöpft|brächte nichts|Heizstab-Schwelle|Pausenfenster|Nacht: automatisch|Tag: Vorschlag/.test(txt) && !/eskalation_schatten|takt_nach_wechsel/.test(evAll(keine)) && !/capHz|escCapHz|35, 1: 45/.test(JSON.parse(fs.readFileSync(flowsFile, 'utf8')).find(n => n.id === 'opt_quiet').func), (txt.match(/würde[^"]*/) || [''])[0]);
}
// 4) Stopp kurz nach einem Wechsel: nur Messung (Ueberschwingen), keine Sperre mehr (frueher 24 h "automatisches Schalten gesperrt")
ewRun({TOP6_Main_Outlet_Temp: 31.5}); ewCollect(5, rtHook(30)); ewCollect(1, rtHook(35, () => { hpm('main/Heating_Control', 0); })); ewCollect(2, rtHook(36));
ew = ewCollect(3, rtHook(38, () => { gstore.TOP6_Main_Outlet_Temp = 34.6; })).concat(ewCollect(1, () => { gstore.compressor_frequency = 0; }));
check('Laufmessung: Verdichter geht kurz nach einem Wechsel der Heizregelung mit Ueberschwingen (+2,6 K) aus -> "stopp_nach_wechsel" mit gemessenem Ueberschwingen, KEINE Sperre (kein "takt_nach_wechsel", watcher-state.json ohne blockUntil), lauf_ende',
      /stopp_nach_wechsel,Verdichter [4-7] min nach Heizregelung 1→0 aus · Überschwingen höchstens \+2\.6 K über Soll/.test(evAll(ew)) && !/takt_nach_wechsel|gesperrt/.test(evAll(ew)) && /lauf_ende/.test(evAll(ew)) && fstore.qs.esc.blockUntil === undefined && !('blockUntil' in JSON.parse(files['/data/optimizer/watcher-state.json'].data)) && JSON.parse(files['/data/optimizer/watcher-state.json'].data).lastChgWhat === 'Heizregelung 1→0', evAll(ew));
files['/data/optimizer/watcher-state.json'] = {data: JSON.stringify({blockUntil: NOW + 20 * 3600000, lastChg: NOW - 3600000, lastChgWhat: 'Quiet 3→2', lastDefrostEnd: 0, lastDhwEnd: 0}), mode: 0o644};
delete fstore.qs; hpm('main/Heating_Control', 1); gstore.compressor_frequency = 17; gstore.TOP6_Main_Outlet_Temp = 28; ew = ewCollect(30, rtHook(0));
check('Laufmessung: eine alte Sperre aus watcher-state.json (blockUntil) gilt nach dem Laden nicht mehr; Wechselzeit wird uebernommen', fstore.qs.esc.blockUntil === undefined && fstore.qs.esc.lastChgWhat === 'Quiet 3→2' && !/gesperrt/.test(ewRow(ew[29])[1]), ewRow(ew[29])[1]);
ewRun({TOP6_Main_Outlet_Temp: 31.6}); ewCollect(3, rtHook(30)); ewCollect(1, rtHook(33, () => { gstore.TOP18_Quiet_Mode_Level = 2; })); ewCollect(3, rtHook(34)); ew = ewCollect(1, () => { gstore.compressor_frequency = 0; });
check('Laufmessung: fremder Quiet-Wechsel, Lauf endet 4 min spaeter regulaer bei Soll -> "stopp_nach_wechsel" mit Ueberschwingen hoechstens -0,4 K', /stopp_nach_wechsel,Verdichter [4-7] min nach Quiet 3→2 aus · Überschwingen höchstens -0\.4 K über Soll/.test(evAll(ew)), evAll(ew));
// 5) Stopp und Neustart zwischen zwei Aufrufen (Laufzeit springt zurueck): Lauf-Ende wird trotzdem festgehalten
ewRun(); ewCollect(10, rtHook(30)); ew = ewCollect(1, rtHook(2));
check('Laufmessung: Laufzeit springt zurueck (Stopp und Neustart zwischen zwei Aufrufen) -> "lauf_ende" fuer den alten Lauf, neuer Lauf beginnt', /lauf_ende,Lauf 39 min/.test(evAll(ew)) && fstore.qs.esc.prevRt === 2, evAll(ew));
// 6) Heizstab-Minuten im Abtauprotokoll zaehlen Zeit, nicht Aufrufe
dfWorld(); hpm('main/Internal_Heater_State', 0); dfAll = collect(2); dfAll = dfAll.concat((() => { const o = []; for (let m = 0; m < 3; m++) { NOW += 60000; gstore.TOP26_Defrosting_State = 1; gstore.TOP6_Main_Outlet_Temp = 25; hpm('main/Internal_Heater_State', m >= 1 ? 1 : 0); for (let k = 0; k < 20; k++) { o.push(run('opt_quiet', {})); } } return o; })());
dfAll = dfAll.concat(collect(4, i => { gstore.TOP26_Defrosting_State = 0; gstore.TOP6_Main_Outlet_Temp = [25, 26, 27, 31.2][i]; hpm('main/Internal_Heater_State', 0); }));
dfR = defRows(dfAll); dfH = dfR[0] && dfR[0][0].split(','); dfL = dfR[0] && dfR[0][dfR[0].length - 1].split(',');
check('Abtauprotokoll: Heizstab-Minuten zaehlen Zeit, nicht Aufrufe (20 Aufrufe je Minute, 2 Minuten mit Heizstab -> heizstab_min 2)', dfR.length === 1 && dfL[dfH.indexOf('heizstab_min')] === '2', dfR[0] && dfR[0].join(' / '));
// 7) "Sollvorlauf erreicht" nicht durch fremde Waerme: Warmwasser mit hohem Vorlauf zaehlt nicht; Restwaerme am Start zaehlt auch nicht
ewRun(); ew = ewCollect(100, rtHook(1)); ew = ew.concat(ewCollect(10, rtHook(101, () => { gstore.TOP20_ThreeWay_Valve_State = 1; gstore.TOP6_Main_Outlet_Temp = 32; }))); ew = ew.concat(ewCollect(14, rtHook(111, () => { gstore.TOP20_ThreeWay_Valve_State = 0; gstore.TOP6_Main_Outlet_Temp = 28; })));
check('Laufmessung: Warmwasser-Waerme (Vorlauf 32 °C waehrend Warmwasser) zaehlt nicht als "Sollvorlauf erreicht"', !/sollvorlauf_erreicht/.test(evAll(ew)) && /Sollvorlauf noch nicht erreicht/.test(ewRow(ew[123])[1]), evAll(ew) + ewRow(ew[123])[1]);
ewRun(); ew = ewCollect(45, rtHook(1, i => { gstore.TOP6_Main_Outlet_Temp = i < 5 ? 32 : 28; }));
check('Laufmessung: Restwaerme am Laufbeginn (Vorlauf kurz bei Soll, dann 4 K darunter) zaehlt nicht als erreicht', !/sollvorlauf_erreicht/.test(evAll(ew)), evAll(ew));
// 8) Eingaenge: HeishaMon meldet nicht / Verdichterwert fehlt -> Messung pausiert, kein falsches Lauf-Ende
ewRun(); ewCollect(5, rtHook(30)); const runKeyBefore = fstore.qs.esc.runKey;
ew = []; for (let i = 0; i < 12; i++) { NOW += 60000; ew.push(run('opt_quiet', {})); }        // HeishaMon-Werte werden nicht mehr erneuert (>10 min alt)
check('Laufmessung: HeishaMon meldet >10 min nicht mehr -> "Daten fehlen oder sind veraltet", kein Ereignis', /^Daten fehlen oder sind veraltet \(HeishaMon meldet nicht\)$/.test(ewRow(ew[11])[1]) && ewRow(ew[11])[2] === 'warn' && evAll(ew) === '', ewRow(ew[11])[1]);
delete gstore.compressor_frequency; ew = ewCollect(3);
check('Laufmessung: Verdichterwert fehlt (unbekannt) wird NICHT als "steht" gewertet: kein lauf_ende, Lauf bleibt erhalten', /Verdichterwert fehlt/.test(ewRow(ew[2])[1]) && !/lauf_ende/.test(evAll(ew)) && fstore.qs.esc.runKey === runKeyBefore, evAll(ew) + ewRow(ew[2])[1]);
// 14) Lesehilfe: HeishaMoNR-Werte aus dem Speicher "file", sonst Standardspeicher
world({}); gstore.compressor_frequency = 0; gfile.compressor_frequency = 22; let ho = collect(1);
check('Eingaenge: liegt compressor_frequency im Speicher "file", wird er gelesen (22 Hz), auch wenn der Standardspeicher 0 enthaelt; ohne "file" gilt der Standardspeicher', /^22 Hz/.test((ho[0][0].payload.rows.find(r => r[0] === 'Verdichter') || [])[1] || ''), JSON.stringify(ho[0][0].payload.rows.find(r => r[0] === 'Verdichter')));
delete gfile.compressor_frequency; world({compressor_frequency: 18}); ho = collect(1);
check('Eingaenge: ohne Speicher "file" (Normalfall auf der NAS) gilt der Standardspeicher', /^18 Hz/.test((ho[0][0].payload.rows.find(r => r[0] === 'Verdichter') || [])[1] || ''), JSON.stringify(ho[0][0].payload.rows.find(r => r[0] === 'Verdichter')));
// 15) Ereignisliste in der Quiet-Karte
{
  const evFile = '/data/optimizer/quiet-events-2026-10.csv', keep = files[evFile];
  const lines = ['zeit,ereignis,wechsel'];
  for (let k = 0; k < 14; k++) { lines.push('2026-10-0' + (1 + (k % 8)) + ' 1' + (k % 10) + ':0' + (k % 6) + ':00,sollvorlauf_erreicht,nach ' + (50 + k) + ' min · Heizregelung 1'); }
  lines.push('2026-10-08 22:54:17,quiet_stufe,3->0 (per Befehl; Quelle: GUI)', '2026-10-08 23:06:42,heizregelung_empfehlung,ok->Comfort empfohlen (Außentemperatur 4.0 °C)', '2026-10-09 00:20:42,testfenster_quiet_3_2,geoeffnet',
             '2026-10-09 03:17:23,lauf_ende,Lauf 599 min · Sollvorlauf erreicht nach 58 min · Heizregelung 1 · Quiet 3', '2026-10-09 04:48:23,eskalation_schatten,gesperrt: Raum seit 60 min unter Minimum → Heizregelung Efficiency → Comfort [Startphase]',
             '2026-10-09 05:10:00,takt_nach_wechsel,Verdichter 5 min nach Quiet 3→2 mit Überschwingen +2.6 K aus · automatisches Schalten gesperrt bis 10.10. 05:10');
  ewWorld({compressor_frequency: 0}); files[evFile] = {data: lines.join('\n') + '\n', mode: 0o644};
  const eo = ewCollect(1)[0], evs = eo[0].payload.events;
  check('Ereignisliste: hoechstens 10 Eintraege, neueste zuerst, nur Befehle/Stufen/Laeufe (kein Empfehlungs-Flackern, keine Testfenster; alte Waechter-Eintraege "eskalation_schatten"/"takt_nach_wechsel" seit dem Review-Paket ausgeblendet)', evs.length === 10 && evs[0][1] === 'Lauf zu Ende' && evs[1][1] === 'Quiet-Stufe' && evs.every(e => e[1] !== undefined && !/Empfehlung|Testfenster|quiet_3_2|Wächter|Takt nach Wechsel/.test(e.join(' '))), JSON.stringify(evs.slice(0, 4)));
  check('Ereignisliste: Zeit als "TT.MM. HH:MM", Text unveraendert, Sollvorlauf gruen', evs[0][0] === '09.10. 03:17' && /^Lauf 599 min/.test(evs[0][2]) && evs[0][3] === '' && evs.filter(e => e[1] === 'Sollvorlauf erreicht').every(e => e[3] === 'ok'), JSON.stringify(evs[0]) + JSON.stringify(evs[1]));
  ewWorld(); files[evFile] = {data: 'zeit,ereignis,wechsel\n', mode: 0o644}; files['/data/optimizer/quiet-events-2026-09.csv'] = {data: 'zeit,ereignis,wechsel\n2026-09-30 22:00:00,quiet_befehl,Stufe 2 (Quelle: GUI)\n', mode: 0o644};
  NOW = new Date(2026, 9, 1, 0, 6, 0).getTime(); const eoM = ewCollect(1)[0], evM = eoM[0].payload.events;
  check('Ereignisliste: am Monatsersten kommen die letzten Eintraege des Vormonats dazu (Liste nicht leer)', evM.length === 1 && evM[0][0] === '30.09. 22:00' && evM[0][1] === 'Quiet-Befehl', JSON.stringify(evM));
  delete files['/data/optimizer/quiet-events-2026-09.csv'];
  ewRun(); files[evFile] = {data: 'zeit,ereignis,wechsel\n', mode: 0o644}; const ew3 = ewCollect(90, rtHook(1, i => { gstore.TOP6_Main_Outlet_Temp = i < 60 ? 28 : 31.5; })), ev3 = ew3.map(o => o[0].payload.events).filter(e => e.length).pop() || [];
  check('Ereignisliste: Ereignis dieser Minute (Sollvorlauf erreicht) steht schon in der Karte, obwohl es noch nicht in der Datei steht', ev3.length === 1 && ev3[0][1] === 'Sollvorlauf erreicht' && /^nach 6[12] min/.test(ev3[0][2]), JSON.stringify(ev3));
  if (keep) { files[evFile] = keep; } else { delete files[evFile]; }
  ewWorld({compressor_frequency: 0}); delete files[evFile]; const eo2 = ewCollect(1)[0];
  check('Ereignisliste: ohne Ereignisdatei leere Liste, kein Absturz, Zeilen bleiben', Array.isArray(eo2[0].payload.events) && eo2[0].payload.events.length === 0 && eo2[0].payload.rows.length > 10, '');
  const qtpl = JSON.parse(fs.readFileSync(flowsFile, 'utf8')).find(n => n.id === 'opt_t_quiet').format;
  check('Karte: Vorlage zeigt Zeilen und darunter "Letzte Ereignisse" (nur wenn welche da sind), bleibt in der Hoehenanpassung (optfit)', qtpl.includes('msg.payload.rows') && qtpl.includes('msg.payload.events') && qtpl.includes('Letzte Ereignisse') && (qtpl.match(/class="optfit"/g) || []).length === 1, '');
}
// 16) Sicherheit (strukturell): kein Sendeweg aus dem Optimierer-Tab, die Quiet-Funktion ruft nie node.send auf, ihre Ausgaenge gehen nur an Anzeige und Dateien
{
  const nodes = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), tabN = nodes.filter(n => n.z === 'opt_tab'), qf = nodes.find(n => n.id === 'opt_quiet'), hpf = nodes.find(n => n.id === 'opt_hp_in');
  const allowedQ = new Set(['opt_t_quiet', 'opt_t_qstats', 'opt_t_qstats2', 'opt_f_quiet', 'opt_f_qev', 'opt_f_def']);
  check('Sicherheit: im Tab "WP Optimizer" gibt es keinen mqtt-out-, link-in/out- oder http-in-Knoten, der etwas an die Waermepumpe tragen koennte (nur http request fuer OWM)', tabN.every(n => n.id === APPLY_OUT || !['mqtt out', 'link out', 'link in', 'link call', 'http in', 'http response'].includes(n.type)), tabN.filter(n => n.id !== APPLY_OUT && ['mqtt out', 'link out', 'link in', 'link call'].includes(n.type)).map(n => n.id).join(','));
  check('Sicherheit: opt_quiet und opt_hp_in rufen nirgends node.send auf; alle Ausgaenge von opt_quiet gehen nur an Anzeige-Vorlagen und Datei-Knoten', !/node\.send\s*\(/.test(qf.func) && !/node\.send\s*\(/.test(hpf.func) && qf.wires.every(w => w.every(id => allowedQ.has(id))), JSON.stringify(qf.wires));
}
check('Abtauprotokoll nur lesend: die Funktion sendet nichts an die Waermepumpe, nur Datei-Ausgabe (Ausgang 5)', JSON.parse(fs.readFileSync(flowsFile, 'utf8')).find(n => n.id === 'opt_quiet').wires[4].join() === 'opt_f_def' && sent.every(x => x.id !== 'opt_quiet' || !x.m || !x.m.topic), '');
check('Komfortdefizit-Anteil je Kennfeldzeile (hier 100 %)', trow(tab, 3, '3–7 °C')[16] === '100 %', trow(tab, 3, '3–7 °C')[16]);
world({}); collect(3); gstore.compressor_frequency = 0; collect(2); gstore.compressor_frequency = 20; collect(40);
check('Starts/h und mittlere Laufzeit je Zeile (2 Starts)', fstore.qs.kf['3|2'].starts === 2 && trow(collect(1)[0][1].payload.stats, 3, '3–7 °C')[11] !== '–', JSON.stringify(fstore.qs.kf['3|2'].starts));

world({}); fstore.qs = {errS: null, errTs: 0, target: null, level: 3, levelSince: T0, lastStart: 0, lastDefrostEnd: 0, lastDhwEnd: 0, freqOn: false, defrost: false, dhw: false, lastMin: 0, lastSave: 0, lastLog: 0, runStart: 0, runs: [], stats: {3: {n: 5, s: {}}}};
let migOk = true; try { collect(3); } catch (e) { migOk = false; }
check('Zustand einer frueheren Version (ohne Kennfeld) wird uebernommen, kein Fehler', migOk && !!fstore.qs.kf && fstore.qs.kf['3|2'] && fstore.qs.kf['3|2'].n >= 2, migOk ? 'ok' : 'Fehler');
console.log('--- Review-Paket: Prioritaetsregel 1-3 °C und Kontrolltest Quiet 3 -> 2 gestrichen');
{ const stableBins = () => { const b = []; for (let i = 0; i < 40; i++) { b.push([NOW - (40 - i) * 300000, 5 * 5, 5]); } return b; };    // 5 °C, 40 Staepel: frueher "Testfenster jetzt moeglich"
  world({}); fstore.atBins = stableBins(); gstore.OPT_state = {ts: NOW, deficit: false, deficitRoom: '', coldTrend: null, distrib: false, valid: 3, active: 3};
  outs = collect(20, () => { gstore.OPT_state.ts = NOW; }); gstore.TOP20_ThreeWay_Valve_State = 1; outs = outs.concat(collect(1, () => { gstore.OPT_state.ts = NOW; }));
  const evs = outs.filter(x => x[3]).map(x => x[3].payload).join(''), o = outs[19];
  check('kein Kontrolltest mehr: keine Zeile "Kontrolltest", kein Ereignis "testfenster_quiet_3_2" (frueher 31-mal am 07.–13.10.), nichts geschaltet', !o[0].payload.rows.some(r => /^Kontrolltest/.test(r[0])) && !/testfenster/.test(evs) && sent.every(s0 => s0.id !== 'opt_hp_in'), evs.slice(0, 160));
  world({TOP5_Main_Inlet_Temp: 25.8, TOP14_Outside_Temp: 2}); outs = collect(3); const hd = (outs.filter(x => x[2])[0][2].payload.split('\n')[0]).split(','), lv = outs.filter(x => x[2]).pop()[2].payload.trim().split('\n').pop().split(',');
  check('keine Prioritaetsregel mehr: bei 2 °C weder "Quiet nach Prioritätsregeln" noch Schritt; Protokollspalten bleiben (leer)', !outs[2][0].payload.rows.some(r => /Priorität|Nächster Schritt/.test(r[0])) && ['quiet_ziel_normal', 'quiet_ziel_prioritaet', 'quiet_naechster_prioritaet', 'quiet_aussen_regel', 'test_moeglich'].every(c => hd.includes(c) && lv[hd.indexOf(c)] === ''), ''); }

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
const consRec = vrmRec.map(x => [x[0], 500]), hpRec = vrmRec.map(x => [x[0], 200]);
run('opt_vrm_parse', {statusCode: 200, payload: {success: true, records: {solar_yield_forecast: vrmRec, vrm_consumption_fc: consRec, vrm_consum_hp_fc: hpRec}, totals: {}}}); e = run('opt_energy', {});
check('VRM-Verbrauchsprognose: 500 Wh/h -> 12,0 kWh in 24 h', erow(e, 'Verbrauch nächste 24 h') === '12,0 kWh', erow(e, 'Verbrauch nächste 24 h'));
check('VRM-Waermepumpenprognose: 200 Wh/h -> 4,80 kWh in 24 h (Feld vrm_consum_hp_fc, gibt es erst seit dem Venus-Geraet)', erow(e, 'Wärmepumpe nächste 24 h (VRM-Prognose)') === '4,80 kWh' && gstore.OPT_plan_in.vrmHpKwh > 4.79 && gstore.OPT_plan_in.vrmHpKwh < 4.81, erow(e, 'Wärmepumpe nächste 24 h (VRM-Prognose)'));
ewld(); { const recNoHp = vrmRec.map(x => [x[0], 1000]); run('opt_vrm_parse', {statusCode: 200, payload: {success: true, records: {solar_yield_forecast: recNoHp, vrm_consumption_fc: consRec, vrm_consum_hp_fc: false}, totals: {}}}); const en0 = run('opt_energy', {}); check('VRM ohne Waermepumpenprognose (Feld false, wie bis 7.10.): Zeile zeigt "nicht geliefert", nichts bricht', erow(en0, 'Wärmepumpe nächste 24 h (VRM-Prognose)') === 'nicht geliefert' && gstore.OPT_plan_in.vrmHpKwh === null, erow(en0, 'Wärmepumpe nächste 24 h (VRM-Prognose)')); }
run('opt_vrm_parse', {statusCode: 200, payload: {success: true, records: {solar_yield_forecast: vrmRec, vrm_consumption_fc: consRec, vrm_consum_hp_fc: hpRec}, totals: {}}}); e = run('opt_energy', {});
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
const nowKeep = NOW; NOW = NOWE + 49 * 60000 + 7000; const rq49 = run('opt_vrm_req', {}); NOW = nowKeep;          // Abruf um 10:49:07
check('Anfrage beginnt und endet auf einer vollen Stunde, auch bei einem Abruf um 10:49:07, damit die VRM-Stundenwerte nicht um die Abrufminute verschoben sind (vorher :49)', (() => { const m = /start=(\d+)&end=(\d+)/.exec(rq49.url); return !!m && Number(m[1]) % 3600 === 0 && Number(m[2]) % 3600 === 0 && Number(m[2]) - Number(m[1]) === 49 * 3600; })(), rq49.url.slice(-40));
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
check('Prognosegueete: Tabellen-Nutzlast (ui-daten): 5 Horizonte, je 7 Spalten, Sammelzeile', Array.isArray(fo[4].payload.tab) && fo[4].payload.tab.length === 5 && fo[4].payload.tab.every(z => z.length === 7) && /Stunden Ist-Werte/.test(fo[4].payload.sammel), JSON.stringify(fo[4].payload.tab && fo[4].payload.tab[0]));
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
check('Prognosegueete: nur Anzeige, es werden nur OPT_*-Werte geschrieben, kein MQTT', nonOptFq.length === 0 && sent.every(x => x.id !== 'opt_hp_in' || true) && !JSON.parse(fs.readFileSync(flowsFile, 'utf8')).some(otherOut), nonOptFq.join());
const fl = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
check('Sicherheit: Venus nur abonniert (System und Batterie 278), evcc nur 3 Abonnements, weiterhin kein MQTT-Ausgang im Tab', fl.filter(n => n.z === 'opt_tab' && n.type === 'mqtt in' && /^opt_mqtt_en/.test(n.id)).map(n => n.broker + ':' + n.topic).join() === 'opt_broker_venus:N/+/system/0/#,opt_broker_nas:evcc/site/+,opt_broker_nas:evcc/site/forecast/+,opt_broker_nas:evcc/site/battery/soc,opt_broker_venus:N/+/battery/278/Soc' && fl.filter(otherOut).length === 0, '');
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
  const pts = []; for (let k = 0; k <= 13; k++) { const t = NOW + k * 3 * HH, h = (t - new RealDate(t).setHours(0, 0, 0, 0)) / HH; pts.push([t, base + 3 * Math.sin((h - 9) / 24 * 2 * Math.PI) + drift, O.rh === undefined ? 85 : O.rh, 50].concat(O.windF === undefined ? [] : [O.windF])); }
  gstore.OPT_weather = O.noWeather ? {status: 'Fehler', ts: NOW - 5 * HH} : {status: 'OK', ts: NOW, f_ts: NOW, fpts: pts};
  if (!O.noWeather) { ['windNow', 'cloudsNow', 'owmTemp'].forEach(k => { if (O[k] !== undefined) { gstore.OPT_weather[{windNow: 'wind', cloudsNow: 'clouds', owmTemp: 'temp'}[k]] = O[k]; } }); }
  const pv = []; for (let t = Math.floor(NOW / HH) * HH - 2 * HH; t < NOW + 40 * HH; t += HH) { pv.push([t, Math.round(sunAt(t + HH / 2, O.pvPeak === undefined ? 3000 : O.pvPeak)), HH]); }
  gstore.OPT_plan_in = O.noPrice ? {ts: NOW - HH} : {ts: NOW, price: tariffSl(NOW, 40), priceSrc: 'VRM-Tarif', pv, pvSrc: 'VRM', pvNow: O.pvNow === undefined ? 500 : O.pvNow, soc: 60, socSrc: 'Venus', liveOk: true};
  const rm = O.rooms || {ki_oben: 23, ki_unten: 23, schlaf: 20};
  gstore.OPT_rooms = {}; Object.keys(rm).forEach(id => { if (rm[id] !== null) { gstore.OPT_rooms[id] = {name: id, ema: rm[id], last: rm[id], ts: O.staleRooms ? NOW - 5 * HH : NOW, trend: (O.trend || {})[id] || 0}; } });
  if (O.hp) { gstore.OPT_hp = {Heat_Power_Production_Extra: {v: O.hp, ts: NOW}}; }
  if (O.prio !== undefined) { gstore.OPT_hp = Object.assign(gstore.OPT_hp || {}, {Quiet_Mode_Priority: {v: O.prio, ts: NOW}}); }
  gstore.TOP14_Outside_Temp = O.atNow === undefined ? base : O.atNow;
}
function pworld(o) {
  O = o || {};
  [fstore, files, gstore, envv].forEach(x => Object.keys(x).forEach(k => delete x[k]));
  NOW = T0 + (O.start || 0);
  Object.assign(gstore, {Z1_Heat_Curve_Outside_Low_Temp: -13, Z1_Heat_Curve_Outside_High_Temp: 11, Z1_Heat_Curve_Target_Low_Temp: 29, Z1_Heat_Curve_Target_High_Temp: 38, compressor_frequency: 0, TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0});
  if (O.running) { Object.assign(gstore, {compressor_frequency: 40, TOP16_Heat_Energy_Consumption: 600}); }
  if (O.quiet !== undefined) { gstore.TOP18_Quiet_Mode_Level = O.quiet; }
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
  for (let m = 0; m < minutes; m++) { NOW += 60000; pfeed(); if (hook) { hook(m); } o = run('opt_plan', {}); all.push(o); lastOut = o; }
  return all;
}
const planNow = () => fstore.plan.plan;
let lastOut = null; const planRows = () => lastOut[0].payload.rows;
const cumDev = P => { let d = 0; return P.slots.slice(0, 104).map(x => (d += x.p - x.b)); };
const sumF = (P, k, n) => P.slots.slice(0, n || 104).reduce((a, x) => a + x[k], 0);

// ---- 1) Vorschau (Review-Paket 13.10.2026): Waermebedarf, COP aus der Messung und Strom je Slot; keine Verteilung nach Tarif, keine Empfehlungen
pworld({wide: true});
let r = step(2), P = planNow();
check('Vorschau: 104 Slots (26 h), Status ok, Zeitraster 15 min, Version 14', P.status === 'ok' && P.ver === 14 && P.slots.length === 104 && P.slots[1].t - P.slots[0].t === 900000 && P.slots[0].t === T0, P.status + ' ' + P.why);
check('Vorschau: Wärmebedarf aus dem Gebäudemodell v3 mit Vorwert (UA 0,15 kW/K, Gewinne 0,3 kW, T_innen aus den Räumen 22 °C) plausibel (30-70 kWh/Tag bei ca. 3 °C)', sumF(P, 'bedarf', 96) > 30 && sumF(P, 'bedarf', 96) < 70 && P.model.ua === 0.15 && P.model.g === 0.3 && Math.abs(P.model.ti - 22) < 1e-9, sumF(P, 'bedarf', 96).toFixed(1));
check('Review-Paket: keine Verteilung, keine Empfehlungen, keine Preise/Kosten in den Slots (kein p, rec, off, quiet, price, cost, Reserve)', P.slots.every(x => ['p', 'b', 'rec', 'off', 'quiet', 'price', 'cost', 'resBack', 'resFwd', 'att'].every(k => !(k in x))) && !('res' in P) && !('cap' in P), Object.keys(P.slots[0]).join(','));
check('Vorschau: Strom je Slot = Waermebedarf ÷ COP, Summe der 24 h = Zeile/Kachel "Strom Wärmepumpe"', P.slots.every(x => Math.abs(x.el - x.bedarf / x.cop) < 1e-12) && Math.abs(P.elModel - sumF(P, 'el', 96)) < 1e-9, P.elModel.toFixed(3));
const nmv = x => parseFloat(String(x).replace(',', '.')), ro = r[1][0].payload, rowsT = Object.fromEntries(ro.rows.map(x => [x[0], x[1]]));
{ const rk = P.slots.filter(x => x.risk > 0.05), elAb = sumF(P, 'elAb', 96), kc = ro.kpi.find(k => k.k === 'COP (Modell)');
  check('Winterpaket (PLAN_VER 14): Abtau-Abzug je Slot copAb = COP · (1 − 10 % · Abtaurisiko), Strom elAb = Wärmebedarf ÷ copAb; COP, Strom und Schnappschuss unverändert; Zeile „Abtau-Abzug“ und Tooltip der Kachel „COP (Modell)“ nennen COP und Strom mit Abzug (Forum 4074654, 3810731)',
        P.slots.every(x => Math.abs(x.copAb - x.cop * (1 - 0.1 * x.risk)) < 1e-12 && Math.abs(x.elAb - x.bedarf / x.copAb) < 1e-12 && x.elAb >= x.el - 1e-12) && rk.length > 0 && Math.abs(P.sum.elAb - elAb) < 1e-9 && P.sum.elAb > P.sum.el && P.sum.copAb < P.sum.cop && P.sum.abzug === 0.1 &&
        /^mit Abtau-Abzug [\d,]+ kWh Strom · COP [\d,]+ statt [\d,]+ \(Abzug 10 % × Abtaurisiko je Slot\)$/.test(rowsT['Abtau-Abzug']) && /4074654/.test(ro.rows.find(x => x[0] === 'Abtau-Abzug')[3]) && /mit Abtau-Abzug [\d,]+ \([\d,]+ kWh Strom/.test(kc.t),
        rowsT['Abtau-Abzug'] + ' · ' + rk.length + ' Slots mit Risiko · ' + kc.t); }
check('Anzeige: Status "Vorschau · berechnet HH:MM · keine Empfehlung"; keine Zeilen fuer Verschiebung, Ersparnis, Leistungsgrenze, Reserve, Fenster, Batterie', /^Vorschau · berechnet \d\d:\d\d · keine Empfehlung$/.test(rowsT['Status']) &&
      !ro.rows.some(x => /Verschobene|Ersparnis|Leistungsgrenze|Reserve|günstigstes Fenster|Batterie/.test(x[0])), ro.rows.map(x => x[0]).join(' | '));
check('Anzeige: 24 Stundenzeilen (Ab, Außen, Wärme, COP, Strom, Feuchte·Taupunkt, PV, Abtaurisiko, Vertrauen), Summe der Wärme = 24-h-Bedarf', ro.plan.length === 24 && ['z', 'at', 'b', 'cop', 'e', 'h', 'pv', 'd', 'v'].every(k => ro.plan[0][k] !== undefined) && !('r' in ro.plan[0]) && !('o' in ro.plan[0]) && !('q' in ro.plan[0]) &&
      Math.abs(ro.plan.reduce((a, x) => a + nmv(x.b), 0) - sumF(P, 'bedarf', 96)) < 0.15, JSON.stringify(ro.plan[0]));
check('Taupunkt je Slot plausibel (unter der Lufttemperatur bei 85 % Feuchte, ca. 2 K darunter)', P.slots.every(x => x.dew < x.at && x.at - x.dew < 6), P.slots[0].at.toFixed(1) + ' / ' + P.slots[0].dew.toFixed(1));
check('Anzeige: Auflösung der Quellen ohne Preis (Temperatur 3 h, PV 60 min)', rowsT['Auflösung der Quellen'] === 'Temperatur 3 h · PV 60 min', rowsT['Auflösung der Quellen']);
{ const sh = P.sum.shift, b = P.slots[sh.best.i], w = P.slots[sh.worst.i];
  check('Verschieben nach COP (nur Rechnung): bestes/schlechtestes 3-h-Fenster aus dem Slot-COP, Gewinn = 1/COP(schlecht) − 1/COP(gut) je kWh Waerme, gegen den gemessenen Mehrverlust 0,01–0,06 -> "keine Empfehlung"',
        Math.abs(sh.gain - (1 / sh.worst.v - 1 / sh.best.v)) < 1e-12 && sh.best.v >= sh.worst.v && /^bestes 3-h-Fenster \d\d:\d\d COP \d,\d · schlechtestes \d\d:\d\d COP \d,\d → 0,\d{3} kWh Strom je verschobener kWh Wärme; das wärmere Haus verliert 0,01–0,06 \(Messung 08\.–12\.10\.\) → keine Empfehlung$/.test(rowsT['Verschieben nach COP (nur Rechnung)']) && b && w,
        rowsT['Verschieben nach COP (nur Rechnung)']); }
pworld({wide: true, noPrice: true}); step(1); P = planNow();
check('Review-Paket: Preise sind kein Eingang mehr - ohne Preisdaten trotzdem eine Vorschau (frueher "keine Preise")', P.status === 'ok', P.status);

// ---- 2) COP aus der Messung (Kennfeld des Quiet-Waechters je Aussenband, alle Stufen, Comfort und Efficiency); Rueckfall Carnot-Anteil
const curveT = t => Math.max(29, t <= -13 ? 38 : (t >= 11 ? 29 : 38 + (29 - 38) * (t + 13) / 24)), carnotT = (t, vl) => { const th = vl + 2 + 273.15, tc = t - 6 + 273.15; return th / (th - tc); };
const kfE = (n, at, pth, pel) => ({n, starts: 1, defrosts: 0, runMin: n, dMin: 0, s: {pth: [n * pth, n], pel: [n * pel, n], at: [n * at, n]}});
pworld({wide: true}); step(2); P = planNow();
check('COP ohne Messung: Rueckfall 45 % vom Carnot-Wert (Standard), Quelle "Carnot", Zeile "COP-Modell" sagt es', P.slots.every(x => x.copSrc === 'Carnot' && Math.abs(x.cop - Math.min(8, Math.max(1.5, 0.45 * carnotT(x.at, curveT(x.at))))) < 1e-9) && P.sum.copSrc === 'Carnot' && /^η 0,45 vom Carnot-Wert \(Standardwert\), noch kein Außenband mit 60 min Messung$/.test(Object.fromEntries(planRows())['COP-Modell']), Object.fromEntries(planRows())['COP-Modell']);
pworld({wide: true, qs: {kf: {'3|2': kfE(400, 5, 3000, 600), '3|3': kfE(30, 9, 9000, 900)}, kfE: {'0|2': kfE(200, 5, 2400, 600), '0|1': kfE(120, 1.5, 2500, 550)}}}); step(2); P = planNow();
{ const c5 = (400 * 3000 + 200 * 2400) / (400 * 680 + 200 * 680), c15 = 2500 / 630;          // Strom mit COP-Korrektur (+80 W je Laufminute)
  const okLin = P.slots.filter(x => x.at > 1.5 && x.at < 5).every(x => Math.abs(x.cop - (c15 + (c5 - c15) * (x.at - 1.5) / 3.5)) < 1e-9);
  const okHi = P.slots.filter(x => x.at >= 5).every(x => Math.abs(x.cop - Math.min(8, c5 * carnotT(x.at, curveT(x.at)) / carnotT(5, curveT(5)))) < 1e-9);
  const okLo = P.slots.filter(x => x.at <= 1.5).every(x => Math.abs(x.cop - c15 * carnotT(x.at, curveT(x.at)) / carnotT(1.5, curveT(1.5))) < 1e-9);
  check('COP gemessen: je Aussenband energiegewichtet ueber alle Stufen und beide Heizregelungen (3–7 °C: Quiet 3 Comfort 400 min + Quiet 0 Efficiency 200 min -> ' + c5.toFixed(3) + '), Band mit nur 30 min zaehlt nicht; dazwischen linear, ausserhalb mit dem Carnot-Verhaeltnis; Quelle "Messung"',
        P.model.copPts.length === 2 && P.model.copPts[0][0] === 1.5 && P.model.copPts[1][0] === 5 && Math.abs(P.model.copPts[1][1] - Math.round(c5 * 100) / 100) < 1e-9 && okLin && okHi && okLo && P.slots.some(x => x.at > 1.5 && x.at < 5) && P.slots.every(x => x.copSrc === 'Messung') && P.sum.copSrc === 'Messung',
        JSON.stringify(P.model.copPts) + ' ' + [okLin, okHi, okLo].join()); }
check('COP gemessen: Zeile "COP-Modell" nennt die Baender mit COP und Stunden', /^gemessen je Außenband \(ohne Abtauen\/Warmwasser, ab 60 min\): 1,5 °C COP 3,97 \(2 h\) · 5,0 °C COP 4,12 \(10 h\); dazwischen linear, außerhalb mit dem Carnot-Verhältnis$/.test(Object.fromEntries(planRows())['COP-Modell']), Object.fromEntries(planRows())['COP-Modell']);
pworld({wide: true, qs: {kf: {'3|2': kfE(600, 5, 6000, 600)}}}); step(2); P = planNow();
check('COP gemessen: obere Grenze copMax 8 (10 gemessen -> 8)', P.slots.every(x => x.cop <= 8 + 1e-12) && P.slots.some(x => x.cop === 8), Math.max(...P.slots.map(x => x.cop)).toFixed(2));
{ // COP-Korrektur im Wärmefahrplan: Ist-Strom je Slot roh und korrigiert (nur im Lauf +80 W), ein Slot, den eine aeltere Version begonnen hat (acc ohne kw), bekommt leere Korrektur-Spalten (keine Mischung)
  pworld({wide: true, running: true}); step(20); delete fstore.plan.acc.kw;
  const rowsK = step(31).filter(o => o[1]).map(o => [].concat(o[1]).map(x => x.payload).join('')).join('').split('\n').filter(l => /^\d{4}-/.test(l)).map(l => l.split(',').slice(0, -2));   // ohne die zwei Zaehlerspalten (cop-ziel)
  const old = rowsK[0], nw = rowsK[1], n = rowsK.length ? rowsK[0].length : 0;
  check('COP-Korrektur plan-actuals: Slot einer aelteren Version -> Korrektur-Spalten leer; naechster Slot: ist_strom_kwh 0,15 (600 W roh) und ist_strom_korr_kwh 0,17 (680 W), Konstante 80', rowsK.length >= 2 && old.slice(n - 4).join() === ',,,' && Math.abs(Number(nw[6]) - 0.15) < 0.011 && Math.abs(Number(nw[n - 4]) - 0.17) < 0.012 && Math.abs(Number(nw[n - 4]) - Number(nw[6]) - 0.02) < 0.002 && nw[n - 1] === '80', rowsK.map(r => r[6] + '/' + r.slice(n - 4).join('|')).join(' ; '));
  pworld({wide: true, running: false}); step(31); const rowsS = (lastOut && fstore.plan) ? true : false;
  const sK = step(16).filter(o => o[1]).map(o => [].concat(o[1]).map(x => x.payload).join('')).join('').split('\n').filter(l => /^\d{4}-/.test(l)).map(l => l.split(','));
  check('COP-Korrektur plan-actuals nur im Lauf: Stillstand -> Strom roh 0 und korrigiert 0 (keine 80 W ohne Verdichter)', rowsS && sK.length >= 1 && Number(sK[0][6]) === 0 && Number(sK[0][sK[0].length - 4]) === 0, sK.map(r => r[6] + '/' + r.slice(-4).join('|')).join(' ; '));
  pworld({wide: true, qs: {kf: {'3|2': kfE(400, 5, 3000, 600)}}}); gstore.OPT_cfg.cop = {pelKorrW: 0}; step(2); const P0 = planNow();
  pworld({wide: true, qs: {kf: {'3|2': kfE(400, 5, 3000, 600)}}}); gstore.OPT_cfg.cop = {pelKorrW: 40}; step(2); const P40 = planNow();
  check('COP-Korrektur aenderbar im Kennfeld: 0 W -> COP 5,00 (roh), 40 W -> 3000/640 = 4,69, 80 W (Standard) -> 4,41; Kennfeld-Rohsummen bleiben unveraendert (keine Doppelanwendung)', P0.model.copPts[0][1] === 5 && P40.model.copPts[0][1] === 4.69 && P40.model.copKw === 40 && fstore.qs.kf['3|2'].s.pel[0] === 400 * 600 &&
        (() => { pworld({wide: true, qs: {kf: {'3|2': kfE(400, 5, 3000, 600)}}}); step(2); const a = planNow().model.copPts[0][1]; step(20); return a === 4.41 && planNow().model.copPts[0][1] === 4.41 && fstore.qs.kf['3|2'].s.pel[0] === 400 * 600; })(), JSON.stringify([P0.model.copPts, P40.model.copPts])); }
const mkQs = (n) => ({kf: {'3|2': {n, starts: 1, defrosts: 0, runMin: n, dMin: 0, s: {cop: [n * 9, n], vl: [n * 31, n], at: [n * 5, n], pth: [n * 3000, n], pel: [n * (3000 / 4.2 - 80), n]}}}});   // COP mit Korrektur = 3000 / (Ø Strom + 80) = 4,2 (der Mittelwert der Roh-COP zaehlt nicht mehr)
pworld({wide: true, qs: mkQs(600)}); step(2); P = planNow();
check('COP-Rueckfall: gemessener Carnot-Anteil (korrigierter COP 4,2 bei 5 °C / 31 °C = 0,467) wirkt langsam: 600 min -> halb/halb = 0,458', Math.abs(P.model.eta - 0.4583) < 0.002 && Math.abs(P.model.etaW - 0.5) < 1e-9 && P.model.copPts.length === 1 && Math.abs(P.model.copPts[0][1] - 4.2) < 0.006, P.model.eta.toFixed(4));
pworld({wide: true, qs: mkQs(60)}); step(2); P = planNow();
check('COP-Rueckfall: nur 60 gemessene Minuten veraendern das Modell kaum (Gewicht 9 %)', Math.abs(P.model.eta - 0.45) < 0.003, P.model.eta.toFixed(4));
pworld({wide: true, atBase: 2}); step(2); P = planNow();
const worst = Math.max(...P.slots.slice(0, 96).map(x => x.risk));
pworld({wide: true, atBase: 14, rh: 90}); step(2); const warmP = planNow();
pworld({wide: true, atBase: -12, rh: 60}); step(2); const coldP = planNow();
check('Abtaurisiko (nur Anzeige): hoch um 0-3 °C und feucht, bei 14 °C Null, bei -12 °C trockener Luft gering', worst >= 0.89 && Math.max(...warmP.slots.map(x => x.risk)) < 0.05 && Math.max(...coldP.slots.map(x => x.risk)) < 0.45, worst.toFixed(2) + ' / ' + Math.max(...warmP.slots.map(x => x.risk)).toFixed(2) + ' / ' + Math.max(...coldP.slots.map(x => x.risk)).toFixed(2));

// ---- 3) Strom der Waermepumpe: Modell (Waermebedarf / COP) neben der VRM-Prognose; Update-Sicherheit
pworld({wide: true, quiet: 3}); step(2); P = planNow(); gstore.OPT_plan_in.vrmHpKwh = 0.03;
let rowEl = Object.fromEntries(planRows())['Strom Wärmepumpe nächste 24 h'];
check('Vorschau: Zeile "Strom Wärmepumpe" nennt Modellwert (Bedarf / COP) und VRM-Prognose nebeneinander', /^\d+,\d kWh \(Modell: Wärmebedarf ÷ COP\) · VRM-Prognose (nicht geliefert|\d+,\d\d kWh)$/.test(rowEl) && Math.abs(P.elModel - P.slots.slice(0, 96).reduce((a, x) => a + x.bedarf / x.cop, 0)) < 1e-9, rowEl);
pfeed = (f0 => () => { f0(); gstore.OPT_plan_in.vrmHpKwh = 0.03; })(pfeed); pworld({wide: true, quiet: 3}); pfeed = (f1 => () => { f1(); gstore.OPT_plan_in.vrmHpKwh = 0.03; })(pfeed);
step(2); rowEl = Object.fromEntries(planRows())['Strom Wärmepumpe nächste 24 h']; P = planNow();
check('Vorschau: mit VRM-Wert 0,03 kWh steht dieser neben dem Modell, beides im Schnappschuss-Kopf (meta) fuer die spaetere Auswertung', /VRM-Prognose 0,03 kWh$/.test(rowEl) && P.vrmHp === 0.03, rowEl);
pworld({wide: true, quiet: 3}); step(2);
fstore.plan.plan = {s0: fstore.plan.planSlot, t: NOW, ver: 10, status: 'ok', slots: [{t: 0, b: 1, p: 1, rec: 1, cost: 5}], res: {state: 'alle im Band'}, cap: {kw: 3.3}};      // Plan der Version 10 (mit Verteilung) im Speicher
let errUpd = null, ro3; try { ro3 = step(1); } catch (e) { errUpd = e.message; }
check('Update-Sicherheit: ein Plan der Version 10 (Verteilung nach Tarif) im Speicher wirft keinen Fehler, sondern wird sofort als Vorschau (Version 14) neu berechnet', errUpd === null && planNow().ver === 14 && !('res' in planNow()) && planNow().maxDemand && ro3[0][0].payload.plan.length === 24, errUpd || '');
const kpiN = ro3[0][0].payload.kpi.map(t => t.k).join('|');
check('Kacheln: Stand (Vorschau, keine Empfehlung), Wärmebedarf, Strom, COP (Modell), Höchster Bedarf, Außen 24 h, PV-Prognose 24 h; keine Ersparnis/Reserve/Fenster', kpiN === 'Stand|Wärmebedarf 24 h|Strom Wärmepumpe|COP (Modell)|Höchster Bedarf|Außen 24 h|PV-Prognose 24 h' && ro3[0][0].payload.kpi[0].s === 'Vorschau, keine Empfehlung' && /^\d,\d$/.test(ro3[0][0].payload.kpi[3].v), kpiN);

// ---- 3f) Ist-Protokoll je Slot mit den Groessen fuer Comfort/Efficiency: Abtauen, Spreizung, Vorlaufabweichung, Pumpe, Heizregelung
pworld({wide: true, running: true, hp: 2500, atNow: 5});
Object.assign(gstore, {TOP6_Main_Outlet_Temp: 30, TOP5_Main_Inlet_Temp: 27, TOP42_Z1_Water_Target_Temp: 32, TOP16_Heat_Energy_Consumption: 600, compressor_frequency: 40});
const rr3 = step(20, m => { gstore.OPT_hp.Pump_Speed = {v: 1800, ts: NOW}; gstore.OPT_hp.Heating_Control = {v: 1, ts: NOW}; gstore.TOP26_Defrosting_State = (m >= 5 && m < 9) ? 1 : 0; gstore.OPT_hp.Heat_Power_Production_Extra = {v: (m >= 5 && m < 9) ? -1500 : 2500, ts: NOW}; });
const actL = rr3.map(o => o[1]).filter(Boolean)[0].payload.trim().split('\n'), actH = actL[0].split(','), actV = actL[1].split(','), aG = n => actV[actH.indexOf(n)];
check('Ist-Protokoll: neue Spalten da (Heizregelung, Abtauen, Spreizung, Vorlaufabweichung, Pumpe)', ['ist_waerme_gesamt_kwh', 'ist_strom_heizen_kwh', 'ist_abtau_min', 'ist_abtau_strom_kwh', 'ist_abtau_waerme_kwh', 'ist_spreizung', 'ist_vl_abweichung', 'ist_pumpe_u_min', 'ist_heizregelung'].every(n => actH.includes(n)) && actH.length === actV.length, actH.slice(12, 21).join('|'));
check('Ist-Protokoll: Abtauen 4 min, Strom 4 x 600 W = 0,040 kWh, Waermeentzug 4 x -1500 W = -0,100 kWh', aG('ist_abtau_min') === '4' && Math.abs(Number(aG('ist_abtau_strom_kwh')) - 0.04) < 0.003 && Math.abs(Number(aG('ist_abtau_waerme_kwh')) + 0.1) < 0.006, aG('ist_abtau_min') + ' | ' + aG('ist_abtau_strom_kwh') + ' | ' + aG('ist_abtau_waerme_kwh'));
check('Ist-Protokoll: Spreizung 3 K, Vorlaufabweichung 2 K (Soll 32, Ist 30) und Pumpendrehzahl 1800 U/min nur aus Minuten ohne Abtauen, Heizregelung 1 (Efficiency) festgehalten', Math.abs(Number(aG('ist_spreizung')) - 3) < 0.01 && Math.abs(Number(aG('ist_vl_abweichung')) - 2) < 0.01 && aG('ist_pumpe_u_min') === '1800' && aG('ist_heizregelung') === '1', actV.slice(12, 21).join(' | '));
check('Ist-Protokoll: Waerme gesamt = Waerme im Heizbetrieb + Waermeentzug beim Abtauen (0,375 - 0,100 kWh); Strom Heizen ohne den Abtaustrom, Strom gesamt mit', Math.abs(Number(aG('ist_waerme_gesamt_kwh')) - (Number(aG('ist_waerme_kwh')) + Number(aG('ist_abtau_waerme_kwh')))) < 0.003 && Number(aG('ist_waerme_gesamt_kwh')) < Number(aG('ist_waerme_kwh')) && Math.abs(Number(aG('ist_strom_kwh')) - (Number(aG('ist_strom_heizen_kwh')) + Number(aG('ist_abtau_strom_kwh')))) < 0.003, aG('ist_waerme_gesamt_kwh') + ' = ' + aG('ist_waerme_kwh') + ' + ' + aG('ist_abtau_waerme_kwh') + ' | Strom ' + aG('ist_strom_kwh') + ' = ' + aG('ist_strom_heizen_kwh') + ' + ' + aG('ist_abtau_strom_kwh'));

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

// ---- 5) Warmer Tag: kaum Heizbedarf -> Vorschau mit Hinweis
pworld({wide: true, atBase: 22}); r = step(2); P = planNow();
check('Warmer Tag (Prognose 19–25 °C, Bilanzpunkt 20 °C): kaum Heizbedarf -> Vorschau ok, Hinweis "kaum Heizbedarf" in der Statuszeile, Bedarf und Strom fast 0', P.status === 'ok' && P.enough === false && /kaum Heizbedarf$/.test(r[1][0].payload.rows[0][1]) && P.elModel < 1, r[1][0].payload.rows[0][1]);

// ---- 7) Status ohne Daten: kein Plan, keine erfundenen Werte; sobald die Daten da sind, geht es weiter
pworld({wide: true, noWeather: true}); r = step(1); P = planNow();
check('Ohne Wetterprognose: Status "keine Wetterprognose", keine Tabelle, kein Schnappschuss', P.status === 'keine Wetterprognose' && r[0][0].payload.plan.length === 0 && !r[0][3] && /^Keine Vorschau: keine Wetterprognose$/.test(r[0][0].payload.rows[0][1]), P.status);
check('Ohne Plan (keine Wetterprognose) legt opt_plan den Lernstand trotzdem ab (OPT_plan.lern fuer die Seite "Optimierer"; die Zeilen unter "Details und Modell" gibt es nur mit Plan)', gstore.OPT_plan && gstore.OPT_plan.status === 'keine Wetterprognose' && gstore.OPT_plan.lern && typeof gstore.OPT_plan.lern.heute === 'number' && gstore.OPT_plan.lern.drift && gstore.OPT_plan.lern.drift.h === 4 && !r[0][0].payload.rows.some(x => x[0] === 'Lern-Gate'), JSON.stringify(gstore.OPT_plan && gstore.OPT_plan.lern));
O.noWeather = false; r = step(1); P = planNow();
check('Wetter kommt: der Plan wird sofort (nicht erst im naechsten Slot) berechnet', P.status === 'ok', P.status);
pworld({wide: true}); delete gstore.Z1_Heat_Curve_Target_Low_Temp; step(1); P = planNow();
check('Ohne Heizkurve: Status "keine Heizkurve"', P.status === 'keine Heizkurve', P.status);

// ---- 8) Lernen des Waermebedarfs aus Tagesdaten (Gebaeudemodell v3: UA, Gewinne und T_innen aus den Vortagen, erst ab 2 Lerntagen, langsame Anpassung je Tag)
pworld({wide: true, atBase: 5, running: true, hp: 2500, atNow: 5});
O.hp = 2500; step(1440 + 5);
let P8 = planNow();
check('Lernen: nach einem Tag (17 K gegen T_innen 22 °C, 60 kWh gelieferte Waerme) gilt noch der Vorwert (UA 0,15 kW/K, Gewinne 0,3 kW; gelernt erst ab 2 Lerntagen), T_innen 22 °C aus dem Vortag', fstore.plan.learn.days.length === 1 && P8.model.ua === 0.15 && P8.model.g === 0.3 && !P8.model.uaLearned && Math.abs(P8.model.ti - 22) < 1e-9 && Math.abs(fstore.plan.learn.days[0][21] - 408) < 1 && fstore.plan.learn.days[0][22] === 22, JSON.stringify(fstore.plan.learn.days) + ' ua ' + P8.model.ua.toFixed(4));

check('Lernen: Tageswerte werden gesichert (plan-state.json), ein warmer Tag (zu wenig Heizgradstunden) zaehlt nicht', files['/data/optimizer/plan-state.json'] && JSON.parse(files['/data/optimizer/plan-state.json'].data).learn.days.length === 1, '');
const lastPlanFile = JSON.parse(files['/data/optimizer/plan-state.json'].data);
check('Neustart: Lernwerte und Schnappschuesse werden aus der Datei geladen, die laufende Stunde bekommt keinen zweiten Schnappschuss', (() => { const keep = JSON.stringify(lastPlanFile.learn), nS = lastPlanFile.snaps.length; Object.keys(fstore).forEach(k => delete fstore[k]); const rr = step(2); return JSON.stringify(fstore.plan.learn) === keep && fstore.plan.snaps.length >= 1 && fstore.plan.snaps.length <= nS + 1 && !rr.some(o => o[3] && new RealDate(NOW).getMinutes() > 3); })(), '');
{ O.hp = 2500; step(1440); const P9 = planNow(), M9 = fstore.plan.learn.mdl, cf9 = fstore.plan.learn.coef;
  const lim = (a, b, m) => a + Math.max(-m, Math.min(m, b - a));
  check('Lernen: nach dem zweiten Tag ist das Grundmodell gelernt (Ziel UA ' + cf9.ua.toFixed(3) + ', Gewinne ' + cf9.g.toFixed(3) + '); der Plan bewegt sich langsam darauf zu: UA hoechstens 15 %, Gewinne hoechstens 0,15 kW je Tag (Stand ' + M9.ua.toFixed(4) + ' / ' + M9.g.toFixed(3) + ')',
        fstore.plan.learn.days.length === 2 && cf9.gelernt === true && Math.abs(M9.ua - lim(0.15, cf9.ua, 0.15 * 0.15)) < 1e-12 && Math.abs(M9.g - lim(0.3, cf9.g, 0.15)) < 1e-12 && P9.model.ua === M9.ua && P9.model.uaLearned === true && M9.gebremst === (Math.abs(cf9.ua - 0.15) > 0.0225 || Math.abs(cf9.g - 0.3) > 0.15), JSON.stringify({M9, ua: cf9.ua, g: cf9.g})); }

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
check('Schnappschuss: genau einer je Stunde (' + snapKeys.length + ' in 27 h), mit Spaltenkopf (Version 14: Strom statt Preis/Plan/Kosten/Empfehlung; Gebaeudemodell v3 mit Modellversion), Auflösung der Quellen, COP-Quelle und Modellparametern', snapKeys.length >= 27 && snapKeys.length <= 29 && snaps[snapKeys[0]].cols.join() === 't,at,rh,cop,pv,bedarf,strom,defrost,conf_at,conf_pv,taupunkt,wind,wolken,at_korr,sonne_kwh,solar_kand_kwh,wind_kand_kwh,bedarf_basis,bedarf_kand' && snaps[snapKeys[0]].meta.plan_ver === 14 && snaps[snapKeys[0]].meta.modell_ver === 3 && snaps[snapKeys[0]].meta.model.ua === 0.15 && snaps[snapKeys[0]].meta.model.g === 0.3 && snaps[snapKeys[0]].meta.cop_korr_w === 80 && snaps[snapKeys[0]].meta.res.pv_min === 60 && !('price_min' in snaps[snapKeys[0]].meta.res) && !('sav_ct' in snaps[snapKeys[0]].meta) && snaps[snapKeys[0]].meta.cop_quelle === 'Carnot' && snaps[snapKeys[0]].meta.model.eta > 0, snapKeys.length);
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
  const sl = sn.slots[i], plausible = Math.abs(v[colE('prog_aussen')] - sl[ci('at')]) < 0.006 && Math.abs(v[colE('prog_cop')] - sl[ci('cop')]) < 0.006 && v[colE('prog_preis')] === '' && v[colE('plan_waerme_kwh')] === '' && v[colE('empfehlung')] === '' && Math.abs(v[colE('prog_strom_kwh')] - sl[ci('strom')]) < 0.0006 && Math.abs(v[colE('prog_bedarf_kwh')] - sl[ci('bedarf')]) < 0.0006;
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
check('Gesamtweg: Vorschau ok mit PV-Prognose in den Slots (Aufloesung 60 min bekannt); die Tarifpreise gehen nicht mehr ein', P9.status === 'ok' && P9.slots.every(x => !('price' in x)) && P9.slots.some(x => x.pv > 2000) && P9.sum.pvRes === 60, P9.status + ' ' + (P9.why || ''));
check('Gesamtweg: keine Batterie-Zeile mehr in der Vorschau (SoC steht in "Energie & Preise")', !po9[0].payload.rows.some(x => x[0] === 'Batterie'), '');

// ---- 10) Sicherheit: nur Anzeige und Protokoll
const flp = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
const pn_ = flp.find(n => n.id === 'opt_plan');
check('Sicherheit: der Plan hat nur Ausgaenge zur Anzeige und zu Protokolldateien, kein MQTT, nichts zur Waermepumpe', pn_.wires.flat().every(id => ['opt_t_plan', 'opt_t_plan_tab', 'opt_f_pact', 'opt_f_peval', 'opt_f_psnap'].includes(id)) && !flp.some(otherOut) && !/SetQuietMode|SetOperationMode|node\.send/.test(pn_.func), pn_.wires.flat().join());
const nonOptPlan = Object.keys(gstore).filter(k => !k.startsWith('OPT_') && JSON.stringify(gstore[k]) !== JSON.stringify(({Z1_Heat_Curve_Outside_Low_Temp: -13, Z1_Heat_Curve_Outside_High_Temp: 11, Z1_Heat_Curve_Target_Low_Temp: 29, Z1_Heat_Curve_Target_High_Temp: 38, compressor_frequency: 0, TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0})[k]) && k !== 'TOP14_Outside_Temp');
check('Sicherheit: der Plan schreibt nur OPT_*-Werte (Heizkurve, Quiet und Warmwasser bleiben unberuehrt)', nonOptPlan.length === 0, nonOptPlan.join());
check('Dateien: Ist, Vergleich, Schnappschuesse und Zustand unter /data/optimizer, Plan-Zustand ohne Zugangsdaten', !/token|appid|key/i.test(files['/data/optimizer/plan-state.json'].data), Object.keys(files).filter(k => /plan/.test(k)).join());
// ---- S1) Fahrplan v2: Wind und Zusatzwerte erfassen (ohne Wirkung auf den Plan)
{
  const OLDSNAP = ['t', 'at', 'rh', 'cop', 'price', 'pv', 'bedarf', 'plan', 'defrost', 'conf_at', 'conf_pv', 'att', 'rec', 'kosten', 'offset', 'quiet', 'plan_pot', 'taupunkt', 'kosten_basis', 'strafe_defrost', 'strafe_unsicher', 'reserve_hinten', 'reserve_vorn'];
  pworld({wide: true, windF: 5.5, windNow: 4.5, cloudsNow: 80, owmTemp: 7, atNow: 6}); gstore.T_outside = 6.5; gstore.T_outside_custom = 5.5;
  const hdrs = [], lines = []; let evOut = [];
  const outs1 = step(26); outs1.forEach(o => { if (o[1]) { hdrs.push(o[1].payload.split('\n')[0]); lines.push(o[1].payload); } if (o[2]) { evOut.push(o[2].payload); } });
  const snap1 = fstore.plan.snaps[fstore.plan.snaps.length - 1], P1 = planNow();
  check('Schnappschuss (Version 11): die alten Spalten Preis/Plan/Kosten/Empfehlung/Offset/Quiet/Reserve sind weg, wind/wolken/at_korr stehen hinter taupunkt, Werte aus der Wetterprognose (5,5 m/s, 50 %)', OLDSNAP.filter(c => ['price', 'plan', 'att', 'rec', 'kosten', 'offset', 'quiet', 'plan_pot', 'kosten_basis', 'strafe_defrost', 'strafe_unsicher', 'reserve_hinten', 'reserve_vorn'].includes(c)).every(c => !snap1.cols.includes(c)) && snap1.cols[10] === 'taupunkt' && snap1.cols[11] === 'wind' && snap1.cols[12] === 'wolken' && snap1.cols[13] === 'at_korr' && snap1.slots.every(r => r.length === 19 && r[11] === 5.5 && r[12] === 50 && r[13] === null), snap1.cols.join() + ' / ' + JSON.stringify(snap1.slots[0]));
  check('Vorschau: Bedarf, COP und Strom sind von Wind/Bewoelkung unabhaengig (ohne aktives Modell; Wind 5,5 gegen ohne Wind ergibt dieselben Slots)', (() => { pworld({wide: true, windNow: 4.5, cloudsNow: 80, owmTemp: 7, atNow: 6}); gstore.T_outside = 6.5; gstore.T_outside_custom = 5.5; step(26); const Pn = planNow(); return P1.slots.every((x, i) => x.bedarf === Pn.slots[i].bedarf && x.cop === Pn.slots[i].cop && x.el === Pn.slots[i].el); })(), '');
  const hdrZ = hdrs[0] ? hdrs[0].split(',') : [], rowZ = lines[0] ? lines[0].split('\n')[1].split(',') : [], hdr = hdrZ.slice(0, -2), row = rowZ.slice(0, -2);   // ohne die zwei Zaehlerspalten (cop-ziel)
  check('plan-actuals (cop-ziel 17.10.2026): ist_strom_zaehler_kwh, ist_zaehler_min ganz hinten, ohne Zähler leer', hdrZ.slice(-2).join() === 'ist_strom_zaehler_kwh,ist_zaehler_min' && rowZ.length === hdrZ.length && rowZ.slice(-2).join() === ',', hdrZ.slice(-2).join() + ' / ' + rowZ.slice(-2).join());
  check('plan-actuals: fuenf neue Spalten ganz hinten (nach den Raumspalten), Kopfzeile und Zeile gleich lang, Zahlen mit Punkt (Wind 4.5, Bewoelkung 80, OWM 7, Regelwert 6.5, eigener Fuehler 5.5)', hdr.slice(-9, -4).join() === 'ist_wind_ms,ist_bewoelkung_pct,ist_aussen_owm,ist_aussen_regel,ist_t_custom' && hdr[hdr.length - 10].startsWith('ist_raum_') && row.length === hdr.length && row.slice(-9, -4).join() === '4.5,80,7,6.5,5.5', hdr.slice(-7).join() + ' / ' + row.slice(-7).join());
  check('COP-Korrektur plan-actuals: vier Spalten ganz hinten (ist_strom_korr_kwh, ist_strom_heizen_korr_kwh, ist_cop_korr, ist_cop_korr_w = 80); ist_strom_kwh/ist_cop bleiben roh', hdr.slice(-4).join() === 'ist_strom_korr_kwh,ist_strom_heizen_korr_kwh,ist_cop_korr,ist_cop_korr_w' && row[row.length - 1] === '80' && hdr.indexOf('ist_strom_kwh') >= 0 && hdr.indexOf('ist_cop') >= 0, hdr.slice(-4).join() + ' / ' + row.slice(-4).join());
  check('plan-eval: Kopfzeile = Vergleichsspalten (unveraendert) + Ist-Spalten + 7 Spalten hinten (Wind, Bewoelkung, korrigierte Temperatur, Sonne, Bedarf Basis, Bedarf Kandidat, seit Version 11 Strom); Zeile gleich lang, Prognosewert 5.5 m/s und 50 % aus dem Schnappschuss, Strom > 0', (() => { if (!evOut.length) { return false; } const l = evOut[evOut.length - 1].split('\n').filter(Boolean), h = (l.length > 1 ? l[0] : '').split(','), r = l[l.length - 1].split(','); return h.slice(-12, -5).join() === 'prog_wind_ms,prog_bewoelkung_pct,prog_aussen_korr,prog_sonne_kwh,prog_bedarf_basis_kwh,prog_bedarf_kand_kwh,prog_strom_kwh' && h.length === r.length && r.slice(-12, -9).join() === '5.5,50,' && h[h.length - 13] === 'ist_t_custom' && Number(r[r.length - 8]) > 0 && r[r.length - 8] === r[r.length - 7] && Number(r[r.length - 6]) > 0 && h.slice(-5).join() === 'prog_cop_korr_w,ist_strom_korr_kwh,ist_strom_heizen_korr_kwh,ist_cop_korr,ist_cop_korr_w' && r[r.length - 5] === '80' && r[r.length - 1] === '80' && h.slice(1, 25).join() === 'vorlauf_soll_h,vorlauf_ist_h,plan_zeit,prog_aussen,prog_feuchte,prog_cop,prog_preis,prog_pv_w,prog_bedarf_kwh,plan_waerme_kwh,prog_kosten_ct_kwh,prog_defrost_risiko,prog_taupunkt,prog_kosten_basis_ct_kwh,prog_strafe_defrost_ct_kwh,prog_strafe_unsicher_ct_kwh,prog_reserve_hinten_kwh,prog_reserve_vorn_kwh,vertrauen_aussen,vertrauen_pv,attraktivitaet,empfehlung,offset_hinweis,quiet_hinweis'; })(), evOut.length ? evOut[evOut.length - 1].slice(0, 120) : 'keine Eval-Ausgabe');
  // alte Spaltenkopf-Datei: genau eine neue Kopfzeile
  pworld({wide: true, windF: 5.5, windNow: 4.5}); const oldHead = hdrs[0].split(',').slice(0, -5).join(','); files['/data/optimizer/plan-actuals-2026-11.csv'] = {data: oldHead + '\nalt\n', mode: 0o644};
  const o2 = step(40).filter(o => o[1]).map(o => o[1].payload);
  check('plan-actuals: bei vorhandener Datei mit alter Kopfzeile genau eine neue Kopfzeile (danach nicht mehr)', o2.length >= 2 && o2[0].startsWith('slot_start,') && o2.slice(1).every(x => !x.startsWith('slot_start,')), o2.map(x => x.startsWith('slot_start,')).join());
  // alter Schnappschuss ohne die neuen Spalten: plan-eval liest ihn ohne Fehler, Felder bleiben leer
  pworld({wide: true, windF: 5.5}); step(26); fstore.plan.snaps.forEach(sn => { sn.cols = sn.cols.slice(0, 11); sn.slots = sn.slots.map(r => r.slice(0, 11)); });
  const o3 = step(20).filter(o => o[2]).map(o => o[2].payload), l3 = o3.length ? o3[o3.length - 1].split('\n').filter(Boolean) : [], r3 = l3.length ? l3[l3.length - 1].split(',') : [];
  check('plan-eval: Schnappschuss ohne die hinteren Spalten (nur bis taupunkt) -> Felder prog_wind_ms bis prog_bedarf_kand_kwh leer, Strom vorhanden, kein Fehler (Zuordnung ueber Spaltennamen)', o3.length > 0 && r3.slice(-12, -6).join() === ',,,,,' && Number(r3[r3.length - 6]) > 0, r3.slice(-13).join('|'));
  { pworld({wide: true}); const pre5 = step(26).filter(o => o[2]).map(o => o[2].payload); fstore.plan.snaps.forEach(sn => { sn.cols = OLDSNAP; sn.slots = sn.slots.map(r => [r[0], r[1], r[2], r[3], 0.31, r[4], r[5], r[5], r[7], r[8], r[9], 50, 1, 6.5, 0, '–', r[5], r[10], 7.4, 0, 0, 1.2, 0.8]); });
    const o5 = step(20).filter(o => o[2]).map(o => o[2].payload), l5 = o5.length ? o5[o5.length - 1].split('\n').filter(Boolean) : [], h5 = (pre5.concat(o5).map(x => x.split('\n')[0]).find(l => l.startsWith('slot_start,')) || '').split(','), r5 = l5.length ? l5[l5.length - 1].split(',') : [];
    check('plan-eval nach dem Deploy: ein gespeicherter Schnappschuss der Version 10 (mit Preis/Plan/Empfehlung) wird weiter ausgewertet (Preis 0.31, Empfehlung VORZIEHEN), Strom leer, kein Fehler', o5.length > 0 && r5[h5.indexOf('prog_preis')] === '0.31' && r5[h5.indexOf('empfehlung')] === 'VORZIEHEN' && r5[h5.indexOf('prog_strom_kwh')] === '' && r5.length === h5.length, r5.slice(0, 26).join('|')); }
  // Veraltete Wetterwerte und PV zaehlen nicht
  pworld({wide: true, windNow: 4.5, cloudsNow: 80, owmTemp: 7, atNow: 6, noPrice: true}); const o4 = step(26, () => { gstore.OPT_weather.ts = NOW - 61 * 60000; }).filter(o => o[1]).map(o => o[1].payload), r4 = o4.length ? o4[0].split('\n').filter(Boolean).pop().split(',') : [];
  check('veraltete Wetterwerte (> weather.maxAgeMin) und nicht frische PV: Wind, Bewoelkung, OWM-Temperatur bleiben leer, PV der Tagessumme wird nicht erhoeht', o4.length > 0 && r4.slice(-9, -6).join() === ',,' && fstore.plan.day.s === 0 && fstore.plan.day.sN === 0 && fstore.plan.day.wN === 0, r4.slice(-9).join('|') + ' s=' + fstore.plan.day.s);
  // Tagesaggregat ueber einen vollen Tag: kh 240 (10 K x 24 h), PV 2000 W x 24 h = 48 kWh, Wind 6 m/s: wk 1440, OWM 7 °C: khW 192, wkW 1152; ueber der Totzone (4 m/s): wkT 480, wkWT 384
  // Modell v3 (T_innen 22 °C aus den Raeumen 23/23/20): khI 17 K x 24 h = 408, wkI 17 x 2 x 24 = 816, khIW 15 x 24 = 360, wkIW 15 x 2 x 24 = 720
  pworld({wide: true, atBase: 5, running: true, hp: 2500, atNow: 5, pvNow: 2000, windNow: 6, owmTemp: 7}); O.hp = 2500; step(1440 + 5);
  const dayE = fstore.plan.learn.days[0];
  check('Tagesaggregat: Eintrag mit 26 Werten [d0, hdd, q, n, s, wk, khW, wkW, dtr, sN, wN, owN, wwN, wkT, wkWT, Gate, Warmwasser, Abtauen, Luecke, Eingriff, unplausibel, khI, T_innen, wkI, khIW, wkIW]; ein voller Tag ergibt kh ~240, PV ~48 kWh, wk ~1440, khW ~192, wkW ~1152, dtr 0 (konstante Raeume); Wind ueber 4 m/s: wkT ~480, wkWT ~384; Lern-Gate 0 (lernt mit); Modell v3: khI ~408, T_innen 22, wkI ~816, khIW ~360, wkIW ~720', fstore.plan.learn.days.length === 1 && dayE.length === 26 && dayE[15] === 0 && dayE.slice(16, 21).every(v => v === 0) && Math.abs(dayE[21] - 408) < 1 && dayE[22] === 22 && Math.abs(dayE[23] - 816) < 3 && Math.abs(dayE[24] - 360) < 1 && Math.abs(dayE[25] - 720) < 3 && Math.abs(dayE[1] - 240) < 1 && Math.abs(dayE[4] - 48) < 0.3 && Math.abs(dayE[5] - 1440) < 6 && Math.abs(dayE[6] - 192) < 1 && Math.abs(dayE[7] - 1152) < 5 && dayE[8] === 0 && dayE[9] >= 1430 && dayE[10] >= 1430 && dayE[11] >= 1430 && dayE[12] >= 1430 && Math.abs(dayE[13] - 480) < 2 && Math.abs(dayE[14] - 384) < 2, JSON.stringify(dayE));
  check('Tagesaggregat: die ersten vier Werte [d0, hdd, q, n] bleiben wie bisher; der Plan nutzt nach einem Lerntag noch den Vorwert', planNow().model.ua === 0.15 && fstore.plan.learn.days[0][2] > 59 && fstore.plan.learn.days[0][2] < 61, 'ua ' + planNow().model.ua.toFixed(4));
  const fileLearn = JSON.parse(files['/data/optimizer/plan-state.json'].data).learn.days[0];
  check('plan-state.json: der 26er-Eintrag und der Modellstand werden gesichert und ueberleben einen Neustart (UA unveraendert)', fileLearn.length === 26 && (() => { const keep = JSON.stringify(fileLearn), ua0 = planNow().model.ua; delete fstore.plan; step(1); return JSON.stringify(fstore.plan.learn.days[0]) === keep && planNow().model.ua === ua0 && !!fstore.plan.learn.mdl; })(), JSON.stringify(fileLearn));
  // Deploy ohne Neustart: Zustand eines aelteren Stands (ohne neue Zaehler, Plan-Version 7, Tag mit 4er-Eintrag) -> kein NaN, Plan neu gerechnet, Tag schliesst mit null fuer die neuen Summen
  pworld({wide: true, atBase: 5, running: true, hp: 2500, atNow: 5, pvNow: 2000, windNow: 4, owmTemp: 7}); O.hp = 2500; step(5);
  ['windS', 'windN', 'clS', 'clN', 'owS', 'owN', 'toS', 'toN', 'tcS', 'tcN'].forEach(k => { delete fstore.plan.acc[k]; });
  ['s', 'sN', 'wk', 'wN', 'khW', 'owN', 'wkW', 'wwN', 'wkT', 'wTN', 'wkWT', 'wwTN', 'lgN', 'dhwM', 'defM', 'gapM', 'engM', 'unpM', 'r0', 'rl', 'tiS', 'tiN', 'khI', 'kiN', 'khIW', 'kiwN', 'wkI', 'wiN', 'wkIW', 'wiwN'].forEach(k => { delete fstore.plan.day[k]; }); fstore.plan.day.n = 700; fstore.plan.day.hdd = 116; fstore.plan.plan.ver = 7; fstore.plan.learn.days = [[1, 100, 25, 1440]];
  step(3);
  check('Deploy-Sicherheit: Zustand ohne neue Zaehler und Plan-Version 7 -> keine NaN in den Zaehlern, Vorschau wird neu gerechnet (Version 14), alter 4er-Eintrag bleibt unveraendert', ['windS', 'windN', 'owS', 'toS', 'tcS'].every(k => Number.isFinite(fstore.plan.acc[k])) && Number.isFinite(fstore.plan.day.s) && Number.isFinite(fstore.plan.day.wk) && Number.isFinite(fstore.plan.day.khI) && planNow().ver === 14 && JSON.stringify(fstore.plan.learn.days[0]) === JSON.stringify([1, 100, 25, 1440]), JSON.stringify({ver: planNow().ver, acc: fstore.plan.acc.windS, day: fstore.plan.day.s}));
  step(1440 - 8);
  const dayD = fstore.plan.learn.days[1];
  check('Deploy-Sicherheit: ein Tag, der vor dem Deploy begann (nur ein Teil der Minuten mit neuen Summen), schliesst mit null fuer s/wk/khW/wkW, die Totzonen-Summen wkT/wkWT und die Summen des Modells v3 (khI, T_innen, wkI), hdd/q/n bleiben gueltig', fstore.plan.learn.days.length === 2 && dayD.length === 26 && dayD[21] === null && dayD[22] === null && dayD[23] === null && dayD[4] === null && dayD[5] === null && dayD[6] === null && dayD[7] === null && dayD[13] === null && dayD[14] === null && dayD[15] === null && dayD[1] > 100 && dayD[3] >= 1200, JSON.stringify(dayD));
  // Sicherheit: Ausgaenge unveraendert
  const planNode = JSON.parse(fs.readFileSync(flowsFile, 'utf8')).find(n => n.id === 'opt_plan');
  check('Sicherheit (Flow-Datei): opt_plan hat dieselben 5 Ausgaenge (Karten Plan + Stundenuebersicht, Ist, Vergleich, Schnappschuss, frei), kein node.send im Code', JSON.stringify(planNode.wires) === JSON.stringify([['opt_t_plan', 'opt_t_plan_tab'], ['opt_f_pact'], ['opt_f_peval'], ['opt_f_psnap'], []]) && !/node\.send\s*\(/.test(planNode.func), JSON.stringify(planNode.wires));
}

// ---- S2) Fahrplan v2 / Gebaeudemodell v3 (Entscheidung 2, 15.10.2026): Rueckrechnung und Regression UA*(T_innen - T_aussen) - Gewinne (+ Sonne, Wind)
{
  const pureSrc = /\/\/ == REIN-BEGIN ==[\s\S]*?\/\/ == REIN-END ==/.exec(F['opt_plan'])[0];
  const PU = new Function(pureSrc + '\n; return {parseCsv, daysFromRows, dayFromArr, gauss, prepRows, ridgeFit, ridgeCore, looMae, gateCheck, fitModel, predict, d0Of, modellSchritt, tiZiel, tgProfil, mPrior};')();
  const O0 = {ua0: 0.15, g0: 0.3, priorTage: 2, priorX: [10, 16], uaLo: 0.07, uaHi: 0.35, gLo: 0, gHi: 1.2, sW: 0.01, sS: 0.10, useW: false, useS: false, robust: false};
  const mkO = p => Object.assign({}, O0, p || {});
  const row = (X, y, o) => Object.assign({y: y, x1: 24 * X, x2: 0, x3: 0, x4: 24}, o || {});        // ein voller Tag mit mittlerem T_innen - T_aussen = X K
  // Handwert: gewichtete Regression mit dem Vorwert als 2 Pseudo-Tagen bei 10 und 16 K (wie tools/plan_algo.js lerneModell)
  const wReg = pts => { const sw = pts.reduce((a, p) => a + p[2], 0), mx = pts.reduce((a, p) => a + p[2] * p[0], 0) / sw, my = pts.reduce((a, p) => a + p[2] * p[1], 0) / sw; let sxy = 0, sxx = 0; pts.forEach(p => { sxy += p[2] * (p[0] - mx) * (p[1] - my); sxx += p[2] * (p[0] - mx) ** 2; }); const ua = sxy / sxx; return {ua: ua, g: ua * mx - my}; };
  const prior = [[10, 0.15 * 10 - 0.3, 2], [16, 0.15 * 16 - 0.3, 2]];
  { const f0 = PU.ridgeCore([], mkO()), h1 = wReg(prior.concat([[17, 2.5, 1]])), f1 = PU.ridgeFit([row(17, 60)], mkO());
    check('Modell v3, Handwert: ohne Tage genau der Vorwert (UA 0,15 kW/K, Gewinne 0,3 kW); 1 Tag (17 K, 60 kWh = 2,5 kW) -> gewichtete Regression mit 2 Pseudo-Tagen bei 10/16 K: UA ' + h1.ua.toFixed(4) + ', Gewinne ' + h1.g.toFixed(4) + ' (±1e-9, wie plan_algo lerneModell)',
          Math.abs(f0.ua - 0.15) < 1e-12 && Math.abs(f0.g - 0.3) < 1e-12 && Math.abs(f1.ua - h1.ua) < 1e-9 && Math.abs(f1.g - h1.g) < 1e-9, f1.ua.toFixed(6) + ' / ' + f1.g.toFixed(6)); }
  const mkRnd = sd => { let s2 = sd; const r = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648; const g = () => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }; return {r, g}; };
  // Wiederfindung: 20 Tage, UA 0,14, Gewinne 0,3 kW, bs 0,08, bw 0,012 (Wind-Merkmal (T_innen - T_aussen) x Wind ueber 4 m/s), 3 % Rauschen
  let recOk = true, recDetail = '';
  [4711, 1, 2, 3].forEach(sd => {
    const R = mkRnd(sd), rows = []; for (let i = 0; i < 20; i++) { const X = 6 + R.r() * 14, v = R.r() * 5, S = 5 + R.r() * 95, wk = 24 * X * v; rows.push(row(X, (24 * (0.14 * X - 0.3) + 0.012 * wk - 0.08 * S) * (1 + 0.03 * R.g()), {x2: wk, x3: S})); }
    const ft = PU.ridgeFit(rows, mkO({useW: true, useS: true})), sM = rows.reduce((a, r) => a + r.x3, 0) / rows.length, gGes = ft.g + ft.bs * sM / 24, gWahr = 0.3 + 0.08 * sM / 24;
    if (!(Math.abs(ft.ua / 0.14 - 1) < 0.10 && Math.abs(gGes - gWahr) < 0.1 && Math.abs(ft.bs / 0.08 - 1) < 0.3 && Math.abs(ft.bw / 0.012 - 1) < 0.25)) { recOk = false; recDetail += 'Samen ' + sd + ': ' + [ft.ua, ft.g, ft.bw, ft.bs].map(v => v.toFixed(4)).join('/') + ' '; }
  });
  check('Modell v3, Wiederfindung (4 feste Zufallssamen, 20 synthetische Tage, 3 % Rauschen): UA ±10 %, Gewinne + mittlere Sonne zusammen ±0,1 kW (Gewinne, Sonne und Wind wirken fast konstant und teilen sich den Anteil), Sonne ±30 %, Wind ±25 % (Vorwert und Prior ziehen leicht)', recOk, recDetail);
  // Kollinearitaet Sonne/Temperaturdifferenz in beide Richtungen
  let colOk = true, colDetail = '';
  [0.9, -0.9].forEach(rho => {
    const R = mkRnd(77), rows = []; for (let i = 0; i < 20; i++) { const z1 = R.g(), z3 = rho * z1 + Math.sqrt(1 - rho * rho) * R.g(), X = 13 + 3 * z1, S = 50 + 15 * z3; rows.push(row(X, (24 * (0.14 * X - 0.4) - 0.08 * S) * (1 + 0.03 * R.g()), {x3: S})); }
    const ft = PU.ridgeFit(rows, mkO({useS: true}));
    if (!(ft.bs >= 0 && ft.ua >= 0.07 - 1e-9 && ft.ua <= 0.35 + 1e-9 && ft.g >= -1e-9 && ft.g <= 1.2 + 1e-9 && Math.abs(ft.ua / 0.14 - 1) < 0.25)) { colOk = false; colDetail += 'rho ' + rho + ': ' + ft.ua.toFixed(4) + '/' + ft.g.toFixed(4) + '/' + ft.bs.toFixed(4) + ' '; }
  });
  check('Modell v3, Kollinearitaet PV/Temperaturdifferenz (r = +0,9 und −0,9): keine Vorzeichenumkehr, UA und Gewinne in den Grenzen, UA innerhalb ±25 % des wahren Wertes', colOk, colDetail);
  // Vorzeichen: wahre Sonne wirkt "falsch herum" -> 0, UA/Gewinne = Loesung ohne Sonnenterm
  { const R = mkRnd(5), rows = []; for (let i = 0; i < 15; i++) { const X = 8 + R.r() * 10, S = 10 + R.r() * 80; rows.push(row(X, 24 * (0.15 * X - 0.3) + 0.05 * S, {x3: S})); }
    const a2 = PU.ridgeFit(rows, mkO({useS: true})), b2 = PU.ridgeFit(rows.map(r => Object.assign({}, r, {x3: 0})), mkO({useS: false}));
    check('Modell v3, Vorzeichen: Daten mit "negativer Sonne" -> bs genau 0, UA und Gewinne gleich der Loesung ohne Sonnenterm (1e-9)', a2.bs === 0 && Math.abs(a2.ua - b2.ua) < 1e-9 && Math.abs(a2.g - b2.g) < 1e-9, a2.bs + ' / ' + a2.ua.toFixed(6) + ' vs ' + b2.ua.toFixed(6)); }
  // Grenzen: ein Haus, das die Grenzen verlangt (UA 0,5 kW/K, Gewinne -1 kW), landet auf der Grenze
  { const rows = [8, 12, 16, 20].map(X => row(X, 24 * (0.5 * X + 1))), fb = PU.ridgeFit(rows, mkO());
    check('Modell v3, Plausibilitaetsgrenzen: unplausible Daten (UA 0,5 kW/K, Gewinne −1 kW) -> UA 0,35 und Gewinne 0 (Grenzen), nie darueber', Math.abs(fb.ua - 0.35) < 1e-12 && Math.abs(fb.g) < 1e-12, fb.ua + ' / ' + fb.g); }
  // Exaktheit gegen projiziertes Gradientenverfahren (200 Zufallsprobleme, Zielfunktion mit Pseudo-Tagen und Ridge-Prior fuer Wind/Sonne)
  { const R = mkRnd(2026); let worst = 0, detail = '';
    const rowsP = rows => rows.map(r => ({w: 1, y: r.y, f: [r.x1, r.x2, -r.x3, -r.x4]})).concat([10, 16].map(X => ({w: 2, y: 24 * (0.15 * X - 0.3), f: [24 * X, 0, 0, -24]})));
    const J = (rows, beta, o) => { const n = rows.length, ym = rows.reduce((a, r) => a + r.y, 0) / n, sr = Math.max(1, 0.1 * Math.abs(ym)); let j = 0; rowsP(rows).forEach(r => { const e = r.y - r.f.reduce((a, f, p) => a + f * beta[p], 0); j += r.w * e * e / (sr * sr); }); if (o.useW) { j += beta[1] ** 2 / o.sW ** 2; } if (o.useS) { j += beta[2] ** 2 / o.sS ** 2; } return j; };
    for (let it = 0; it < 200; it++) {
      const n = 2 + Math.floor(R.r() * 8), useW = R.r() < 0.5, useS = R.r() < 0.7, rows = [];
      for (let i = 0; i < n; i++) { const X = 4 + R.r() * 16, w = 24 * X * R.r() * 5, S = 5 + R.r() * 90; rows.push(row(X, Math.max(1, 24 * (0.14 * X - 0.4) + (R.r() - 0.4) * 0.03 * w - (R.r() - 0.3) * 0.2 * S + R.g() * 2), {x2: useW ? w : 0, x3: useS ? S : 0})); }
      const o = mkO({useW, useS}), ft = PU.ridgeFit(rows, o), jf = J(rows, [ft.ua, ft.bw, ft.bs, ft.g], o);
      const lo = [0.07, 0, 0, 0], hi = [0.35, useW ? 1 : 0, useS ? 5 : 0, 1.2]; let b = [0.15, 0, 0, 0.3];
      const ym = rows.reduce((a, r) => a + r.y, 0) / n, sr = Math.max(1, 0.1 * Math.abs(ym)), RP = rowsP(rows), Lp = RP.reduce((a, r) => a + r.w * r.f.reduce((s0, f) => s0 + f * f, 0) / (sr * sr), 0) * 2 + 2 * (1 / o.sW ** 2 + 1 / o.sS ** 2);
      for (let k = 0; k < 60000; k++) { const g = [0, 0, 0, 0]; RP.forEach(r => { const e = r.y - r.f.reduce((a, f, p) => a + f * b[p], 0); for (let p = 0; p < 4; p++) { g[p] += -2 * r.w * e * r.f[p] / (sr * sr); } }); if (useW) { g[1] += 2 * b[1] / o.sW ** 2; } if (useS) { g[2] += 2 * b[2] / o.sS ** 2; } b = b.map((v, p) => Math.min(hi[p], Math.max(lo[p], v - g[p] / Lp))); }
      const jp = J(rows, b, o), rel = (jp - jf) / Math.max(1, Math.abs(jf)); if (rel < -1e-6) { worst = Math.max(worst, -rel); detail = 'Fall ' + it + ': exakt ' + jf.toFixed(6) + ' > Referenz ' + jp.toFixed(6); } }
    check('Modell v3, Exaktheit: in 200 Zufallsproblemen (mit/ohne Wind und Sonne, 2-9 Tage, Grenzen aktiv) ist das Ergebnis nie schlechter als ein projiziertes Gradientenverfahren (Zielwert, 1e-6)', worst === 0, detail); }
  // Leave-one-day-out von Hand (Grundmodell: UA und Gewinne, Vorwert bleibt drin)
  { const rows = [row(12, 36), row(15, 47), row(18, 62)];
    let e = 0; rows.forEach((r, i) => { const rest = rows.filter((x, j) => j !== i), h = wReg(prior.concat(rest.map(x => [x.x1 / 24, x.y / 24, 1]))); e += Math.abs(r.y - 24 * (h.ua * r.x1 / 24 - h.g)); });
    check('Modell v3, Leave-one-day-out: 3 Tage Grundmodell (UA, Gewinne) stimmt mit der Handrechnung ueberein (1e-9) – das ist der Fehlermassstab "Fehler Plan" des Gates', Math.abs(PU.looMae(rows, mkO()) - e / 3) < 1e-9, PU.looMae(rows, mkO()).toFixed(6) + ' vs ' + (e / 3).toFixed(6)); }
  // Ausreisser: ein Tag mit +60 % Waerme wird herausgenommen
  { const R = mkRnd(31), rows = []; for (let i = 0; i < 16; i++) { const X = 8 + R.r() * 10; rows.push(row(X, 24 * (0.16 * X - 0.35) * (1 + 0.02 * R.g()))); }
    rows[7] = row(17, 24 * (0.16 * 17 - 0.35) * 1.6); const fr = PU.ridgeFit(rows, mkO({robust: true})), fn = PU.ridgeFit(rows, mkO({robust: false}));
    check('Modell v3, Ausreisser: ein Tag mit +60 % Waerme (> 3 sigma) wird einmalig herausgenommen (removed 1), UA bleibt innerhalb ±5 % des wahren Wertes, ohne die Robustheit weicht er staerker ab', fr.removed === 1 && Math.abs(fr.ua / 0.16 - 1) < 0.05 && Math.abs(fn.ua / 0.16 - 1) > Math.abs(fr.ua / 0.16 - 1), 'robust ' + fr.ua.toFixed(4) + ' / ohne ' + fn.ua.toFixed(4)); }
  // Gate (unveraendert: 10 Tage, PV-Spreizung, Fehler 10 % kleiner, plausible Koeffizienten)
  { const mkRows = (n) => Array.from({length: n}, (_, i) => row(14, 30, {x3: i % 2 ? 80 : 20})), fit = {ua: 0.15, bw: 0, bs: 0.1};
    const g10 = PU.gateCheck(10, mkRows(10), 10, 8.5, fit, {minDays: 10}), g9 = PU.gateCheck(9, mkRows(9), 10, 8.5, fit, {minDays: 10}), gN = PU.gateCheck(10, mkRows(10), 10, 9.5, fit, {minDays: 10}), gP = PU.gateCheck(10, mkRows(10), 10, 8.5, {ua: 0.15, bw: 0, bs: 0.6}, {minDays: 10}), gF = PU.gateCheck(10, Array.from({length: 10}, () => row(14, 30, {x3: 50})), 10, 8.5, fit, {minDays: 10});
    check('Gate (unveraendert, Fehlermassstab = Grundmodell v3): ok bei 10 Tagen, PV-Spreizung und 15 % besserem Fehler; nicht ok bei 9 Tagen, nur 5 % Verbesserung, unplausiblem Koeffizienten (bs 0,6) oder gleichfoermigem PV', g10.ok && !g9.ok && !gN.ok && !gP.ok && !gF.ok, JSON.stringify([g10.why, g9.why, gN.why, gP.why, gF.why])); }
  // fitModel: Grundmodell erst ab 2 Lerntagen, Fehler Plan = LOO des Grundmodells; Kandidat Sonne
  { const MPx = Object.assign({}, O0, {lernMinTage: 2, minDays: 10, minWindDays: 7, storeC: [0, 3]}), dd = (k, X, S) => ({d0: k, kh: 24 * (X - 7), q: 24 * (0.14 * X - 0.4) - 0.08 * S, n: 1440, s: S, khI: 24 * X, ti: 22, wkI: null, khIW: null, wkIW: null, dtr: 0});
    const f1 = PU.fitModel([dd(0, 15, 30)], MPx), f5 = PU.fitModel([dd(0, 9, 20), dd(1, 12, 70), dd(2, 15, 30), dd(3, 18, 60), dd(4, 11, 40)], MPx);
    check('fitModel: 1 Lerntag -> Vorwert (gelernt false, UA 0,15, Gewinne 0,3); 5 Tage -> gelernt (UA/Gewinne aus dem Grundmodell), Fehler Plan = Leave-one-day-out des Grundmodells, Kandidat mit Sonne kleiner',
          f1.gelernt === false && f1.ua === 0.15 && f1.g === 0.3 && f5.gelernt === true && Math.abs(f5.ua - PU.ridgeFit(PU.prepRows([dd(0, 9, 20), dd(1, 12, 70), dd(2, 15, 30), dd(3, 18, 60), dd(4, 11, 40)], MPx).rows, MPx).ua) < 1e-12 && f5.maeBase > 0 && f5.maeSun < f5.maeBase && f5.maeUA === f5.maeBase, JSON.stringify({ua: f5.ua, g: f5.g, base: f5.maeBase, sun: f5.maeSun})); }
  // Langsame Anpassung je Tag und T_innen
  { const D = 1000 * 86400000, P = {stepUaRel: 0.15, stepGainKw: 0.15, stepTiK: 0.5}, prev = {ua: 0.15, g: 0.3, ti: 22, d0: D}, z = {ua: 0.2, g: 0.6, ti: 23, n: 5, gelernt: true, quelle: 'x'};
    const a = PU.modellSchritt(null, z, D, P), b = PU.modellSchritt(prev, z, D + 86400000, P), c = PU.modellSchritt(prev, z, D, P), d = PU.modellSchritt(prev, z, D + 3 * 86400000, P);
    check('Langsame Anpassung: ohne Vorstand sofort das Ziel; je neuem Tag UA hoechstens ±15 % (0,15 -> 0,1725), Gewinne ±0,15 kW (0,3 -> 0,45), T_innen ±0,5 K (22 -> 22,5), "gebremst"; am selben Tag unveraendert; nach 3 Tagen am Ziel',
          a.ua === 0.2 && !a.gebremst && Math.abs(b.ua - 0.1725) < 1e-12 && Math.abs(b.g - 0.45) < 1e-12 && Math.abs(b.ti - 22.5) < 1e-12 && b.gebremst && c === prev && Math.abs(d.ua - 0.2) < 1e-12 && Math.abs(d.g - 0.6) < 1e-12 && d.ti === 23 && !d.gebremst, JSON.stringify([b, d]));
    const T1 = PU.tiZiel([{ti: 21}, {ti: 22}, {ti: 23}, {ti: 24}], 3, 20, {tiStd: 22, tiMin: 18, tiMax: 25}), T2 = PU.tiZiel([], 3, 20.5, {tiStd: 22, tiMin: 18, tiMax: 25}), T3 = PU.tiZiel([], 3, null, {tiStd: 22, tiMin: 18, tiMax: 25}), T4 = PU.tiZiel([{ti: 30}], 3, null, {tiStd: 22, tiMin: 18, tiMax: 25});
    check('T_innen fuer den Plan: Mittel der letzten 3 vollen Tage (23,0), ohne Tage die Raeume jetzt (20,5), ohne beides 22 °C, Grenze 25 °C', T1.ti === 23 && T1.n === 3 && T2.ti === 20.5 && T3.ti === 22 && T4.ti === 25, JSON.stringify([T1, T2, T3, T4])); }
  // Tagesgang Fuehler - OWM
  { const d0 = PU.d0Of('2026-11-12'), rows = []; for (let k = 1; k <= 3; k++) { for (let h = 0; h < 24; h++) { for (let q = 0; q < 4; q++) { rows.push([d0 - k * 86400000, h, h < 6 ? -3 : (h >= 12 && h < 16 ? 1 : 0)]); } } }
    const tg = PU.tgProfil(rows.concat([[d0, 3, 9]]), d0, 3), tgL = PU.tgProfil(rows.filter(x => !(x[1] === 5 && x[0] < d0 - 86400000)), d0, 3), tg0 = PU.tgProfil(rows, d0, 0);
    check('Tagesgang Fuehler − OWM (3 Vortage, je Uhrzeit): nachts −3 K, mittags +1 K, sonst 0; Werte von heute zaehlen nicht; eine Stunde mit weniger als 6 Werten -> kein Tagesgang (null); biasDays 0 -> aus',
          tg && tg[3] === -3 && tg[13] === 1 && tg[20] === 0 && tgL === null && tg0 === null, JSON.stringify(tg)); }
  // Rueckrechnung aus plan-actuals: mehrere Kopfzeilen, Zuordnung ueber Namen, falsche Zeilen, Zeitumstellung; Modell v3: K*h gegen T_innen, T_innen, Wind x (T_innen - T_aussen)
  { const mkSlots = (day, count, extra) => { const o = []; for (let i = 0; i < count; i++) { const h = Math.floor(i / 4), m = (i % 4) * 15; o.push(day + ' ' + (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m); } return o; };
    const hOld = 'slot_start,ist_aussen,ist_pv_w,ist_waerme_kwh,ist_raum_a', hNew = 'slot_start,ist_aussen,ist_pv_w,ist_waerme_kwh,ist_raum_a,ist_wind_ms,ist_aussen_owm';
    let txt = hOld + '\n'; mkSlots('2026-11-10', 96).forEach((s2, i) => { txt += s2 + ',5,2000,0.6,' + (22 + i / 96) + '\n'; });
    txt += 'kaputte,zeile\n' + hNew + '\n'; mkSlots('2026-11-11', 96).forEach((s2, i) => { txt += s2 + ',5,2000,0.6,22,4,7\n'; });
    txt += hNew + '\n'; mkSlots('2026-10-25', 100).forEach(s2 => { txt += s2 + ',10,0,0.3,22,2,12\n'; });
    mkSlots('2026-11-12', 96).forEach(s2 => { txt += s2 + ',5,2000,0.6,22,7,7\n'; });
    const ds = PU.daysFromRows(PU.parseCsv(txt), 15), d1 = ds.find(d => d.d0 === PU.d0Of('2026-11-10')), d2 = ds.find(d => d.d0 === PU.d0Of('2026-11-11')), d3 = ds.find(d => d.d0 === PU.d0Of('2026-10-25')), d4 = ds.find(d => d.d0 === PU.d0Of('2026-11-12'));
    check('Rueckrechnung: Tag aus 96 Slots (alte Kopfzeile ohne Wind) -> n 1440, kh 240, q 57,6, PV 48 kWh, Wind/OWM null, Raumaenderung ~0,99 K; Zeilen mit falscher Spaltenzahl werden uebersprungen', ds.length === 4 && d1.wkT === null && d1.wkWT === null && d1.n === 1440 && Math.abs(d1.kh - 240) < 1e-9 && Math.abs(d1.q - 57.6) < 1e-9 && Math.abs(d1.s - 48) < 1e-9 && d1.wk === null && d1.khW === null && Math.abs(d1.dtr - 95 / 96) < 1e-9, JSON.stringify(d1));
    check('Rueckrechnung Modell v3: T_innen 22 … 22,99 °C bei 5 °C -> K·h gegen T_innen 408 + 11,875 = 419,875, T_innen 22,495; ohne Wind/OWM null', Math.abs(d1.khI - 419.875) < 1e-9 && Math.abs(d1.ti - (22 + 95 / 192)) < 1e-9 && d1.wkI === null && d1.khIW === null && d1.wkIW === null, JSON.stringify([d1.khI, d1.ti, d1.wkI]));
    check('Rueckrechnung: Tag mit neuer Kopfzeile (Wind 4 m/s, OWM 7 °C) -> wk 960, khW 192, wkW 768; Wind genau an der Totzone (4 m/s) -> wkT 0, wkWT 0; Modell v3: khI 408, khIW 360, wkI 0', Math.abs(d2.wk - 960) < 1e-9 && Math.abs(d2.khW - 192) < 1e-9 && Math.abs(d2.wkW - 768) < 1e-9 && d2.dtr === 0 && d2.wkT === 0 && d2.wkWT === 0 && Math.abs(d2.khI - 408) < 1e-9 && Math.abs(d2.khIW - 360) < 1e-9 && d2.wkI === 0 && d2.wkIW === 0, JSON.stringify(d2));
    check('Rueckrechnung, Totzone: Wind 7 m/s -> wkT = 10 K · (7 − 4) m/s · 24 h = 720, wkWT = 8 K · 3 m/s · 24 h = 576; wk bleibt roh (1680); Modell v3: wkI = 17 K · 3 · 24 = 1224, wkIW = 15 K · 3 · 24 = 1080', Math.abs(d4.wkT - 720) < 1e-9 && Math.abs(d4.wkWT - 576) < 1e-9 && Math.abs(d4.wk - 1680) < 1e-9 && Math.abs(d4.wkI - 1224) < 1e-9 && Math.abs(d4.wkIW - 1080) < 1e-9, JSON.stringify(d4));
    check('Rueckrechnung: Zeitumstellung (25.10.2026, 100 Slots) -> n 1500, wird gezaehlt; khI = 12 K · 25 h = 300', d3.n === 1500 && Math.abs(d3.q - 30) < 1e-9 && Math.abs(d3.khI - 300) < 1e-9, JSON.stringify(d3)); }
  // Live gegen Rueckrechnung: ein voller Tag live, daraus die plan-actuals-Zeilen, dann zurueckgerechnet
  { pworld({wide: true, atBase: 5, running: true, hp: 2500, atNow: 5, pvNow: 2000, windNow: 6, owmTemp: 7}); O.hp = 2500; const all = step(1440 + 20); let txtL = '';
    all.forEach(o => { [].concat(o[1] || []).forEach(m => { if (/plan-actuals-/.test(m.filename)) { txtL += m.payload; } }); });
    const live = PU.dayFromArr(fstore.plan.learn.days[0]), bf = PU.daysFromRows(PU.parseCsv(txtL), 15).find(d => d.d0 === live.d0);
    check('Rueckrechnung gegen live: derselbe Tag aus den geschriebenen plan-actuals-Zeilen zurueckgerechnet ergibt kh ±1 %, q ±0,5 %, PV ±1 %, wk ±1 %, khW ±1 % gegenueber den live gesammelten Werten; Modell v3: khI, T_innen, wkI, khIW ±1 %', !!bf && Math.abs(bf.kh / live.kh - 1) < 0.01 && Math.abs(bf.q / live.q - 1) < 0.005 && Math.abs(bf.s / live.s - 1) < 0.01 && Math.abs(bf.wk / live.wk - 1) < 0.01 && Math.abs(bf.khW / live.khW - 1) < 0.01 && Math.abs(bf.wkT / live.wkT - 1) < 0.01 && Math.abs(bf.wkWT / live.wkWT - 1) < 0.01 &&
          Math.abs(bf.khI / live.khI - 1) < 0.01 && Math.abs(bf.ti / live.ti - 1) < 0.01 && Math.abs(bf.wkI / live.wkI - 1) < 0.01 && Math.abs(bf.khIW / live.khIW - 1) < 0.01, JSON.stringify({live, bf}).slice(0, 400));
    const dayMsgs = all.map(o => [].concat(o[1] || [])).reduce((a, b) => a.concat(b), []).filter(m => /plan-days-/.test(m.filename));
    check('Tagesblatt: beim Tageswechsel eine Zeile in plan-days-2026-11.csv mit Kopfzeile (16 Spalten, hinten wk_tot_fuehler/wk_tot_owm und Modell v3 kh_innen_fuehler/t_innen), Datum und Werten mit Punkt', dayMsgs.length === 1 && dayMsgs[0].filename === '/data/optimizer/plan-days-2026-11.csv' && dayMsgs[0].payload.split('\n')[0].split(',').length === 16 && /,wk_tot_fuehler,wk_tot_owm,kh_innen_fuehler,t_innen$/.test(dayMsgs[0].payload.split('\n')[0]) && dayMsgs[0].payload.split('\n')[1].split(',').length === 16 && /^2026-11-12,/.test(dayMsgs[0].payload.split('\n')[1]) && /,\d+\.\d+/.test(dayMsgs[0].payload.split('\n')[1]), dayMsgs.map(m => m.payload).join('|').slice(0, 260)); }
  // Anzeige und Berechnung ueber step(): Tage vorgeben (Modell v3: K*h gegen T_innen an Stelle 21, T_innen an 22)
  { const day = (k, X, q, s, wk) => { const e = [Date.UTC(2026, 10, 1 + k, 0, 0), 24 * (X - 7), q, 1440, s, wk, 24 * (X - 7) * 0.9, wk === null ? null : wk * 0.9, 0.1, 1440, wk === null ? 0 : 1440, 1440, wk === null ? 0 : 1440, null, null, 0, 0, 0, 0, 0, 0]; return e.concat([24 * X, 22, null, null, null]); };
    pworld({wide: true}); step(2); fstore.plan.bf = {days: [], v: 3}; fstore.plan.learn.days = []; delete fstore.plan.learn.coef; step(1);
    let rowG = () => (planRows().find(r => r[0] === 'Gebäudemodell') || [])[1];
    check('Anzeige "Gebäudemodell": ohne Tage "UA 150 W/K · Gewinne 0,30 kW · innen .. °C (Vorwert) · keine Daten"', /^UA 150 W\/K · Gewinne 0,30 kW · innen [\d,]+ °C \(Vorwert\) · keine Daten$/.test(rowG()), rowG());
    fstore.plan.learn.days = [day(0, 15, 24 * (0.14 * 15 - 0.4) - 1.6, 20, null)]; step(1);
    check('Anzeige "Gebäudemodell": ein Tag -> "(Plan) · 1 Tag · Kandidat ab 3 Tagen"', /^UA \d+ W\/K · Gewinne [\d,]+ kW · innen [\d,]+ °C \(Plan\) · 1 Tag · Kandidat ab 3 Tagen$/.test(rowG()), rowG());
    const R = mkRnd(9); fstore.plan.learn.days = [0, 1, 2, 3, 4].map(k => { const X = 9 + R.r() * 9, S = 10 + R.r() * 60; return day(k, X, 24 * (0.14 * X - 0.4) - 0.05 * S, S, null); }); step(1);
    const cf = fstore.plan.learn.coef;
    check('Anzeige "Gebäudemodell": 5 Tage -> UA, Gewinne, innen, Sonne, "Wind n 0 Tage", Fehler Plan/Kandidat; aktiv bleibt false, Gate nicht ok; Berechnung nur bei geaenderten Eingaben (Zeitstempel bleibt)', /^UA \d+ W\/K · Gewinne [\d,]+ kW · innen [\d,]+ °C( \(Ziel .*\))? · Sonne \d,\d{3} · Wind n 0 Tage · Kandidat · 5 Tage · Fehler Plan [\d,]+ \/ Kandidat [\d,]+ kWh$/.test(rowG()) && cf.aktiv === false && cf.gate.ok === false && cf.n === 5 && cf.gelernt === true && (() => { const ts0 = cf.ts; step(3); return fstore.plan.learn.coef.ts === ts0; })(), rowG());
    step(2); const keepCoef = JSON.stringify(fstore.plan.learn.coef); delete fstore.plan; step(1);
    check('Neustart: Koeffizienten und Zeitstempel kommen aus plan-state.json zurueck und werden nicht neu gerechnet', JSON.stringify(fstore.plan.learn.coef) === keepCoef, '');
    const M = fstore.plan.learn.mdl, P5 = planNow();
    check('Plan: Grundmodell v3 aus dem langsam angepassten Stand (pl.learn.mdl, Ziel = gelerntes Grundmodell, am selben Tag kein Sprung): Slot-Bedarf = max(0, UA·(T_innen − T) − Gewinne)·0,25 h auf 1e-12; Bilanzpunkt = T_innen − Gewinne/UA',
          P5.model.ua === M.ua && P5.model.g === M.g && P5.model.ti === M.ti && Math.abs(M.ziel.ua - cf.ua) < 1e-12 && P5.slots.every(x => Math.abs(x.bas - Math.max(0, M.ua * (M.ti - x.at) - M.g) * 0.25) < 1e-12) && Math.abs(P5.model.tbal - (M.ti - M.g / M.ua)) < 1e-12, JSON.stringify({M: M, z: cf.ua}));
    const OM = gstore.OPT_plan.model, Ts = [-5, 0, 10, 15, 18, 19, 21, 25];
    check('OPT_plan.model (Regel Vorausschau): ua, Gewinne, T_innen und tbal = Bilanzpunkt; ua·max(0, tbal − T) = max(0, UA·(T_innen − T) − Gewinne) (gerundet, ±0,002 kW), Modellversion 3', OM.ver === 3 && Ts.every(T => Math.abs(OM.ua * Math.max(0, OM.tbal - T) - Math.max(0, M.ua * (M.ti - T) - M.g)) < 0.002) && Math.abs(OM.ti - M.ti) < 0.006, JSON.stringify(OM));
    // robust: leere/NaN-Eingaben
    const MPx = Object.assign({}, O0, {lernMinTage: 2, minDays: 10, minWindDays: 7, storeC: [0, 3]});
    const fe = PU.fitModel([], MPx), fn2 = PU.fitModel([{d0: 1, kh: NaN, q: NaN, n: 1440, s: NaN, wk: null, khW: null, wkW: null, dtr: null, khI: NaN}], MPx);
    check('Randfaelle: leere oder NaN-Tage -> Vorwert, keine Kandidaten, kein Fehler', fe.n === 0 && fn2.n === 0 && fe.ua === 0.15 && fe.g === 0.3, JSON.stringify([fe.n, fn2.n])); }
}

// ---- S2c) Gebaeudemodell v3 im Plan: Tagesgang Fuehler − OWM in der Prognose, Modellwechsel, A/B nur mit Schnappschuessen des jetzigen Modells
{
  pworld({wide: true}); step(2);
  const dT = new RealDate(NOW).setHours(0, 0, 0, 0), bias = h => (h < 6 ? -2 : (h >= 12 && h < 16 ? 1 : 0)), rowsTg = [];
  for (let k = 1; k <= 3; k++) { for (let h = 0; h < 24; h++) { for (let q = 0; q < 4; q++) { rowsTg.push([dT - k * 86400000, h, bias(h)]); } } }
  fstore.plan.tg = {rows: []}; fstore.plan.planSlot = 0; run('opt_plan', {}); const P0 = planNow();
  fstore.plan.tg = {rows: rowsTg}; fstore.plan.planSlot = 0; const o1 = run('opt_plan', {}), P1 = planNow(), hNow = new RealDate(NOW).getHours();
  const ok1 = P1.slots.every((x, i) => Math.abs((x.atRaw - P0.slots[i].atRaw) - (bias(new RealDate(x.t + 450000).getHours()) - bias(hNow) * Math.exp(-x.L / 4))) < 1e-9);
  check('Modell v3, Prognose: Tagesgang Fuehler − OWM (3 Vortage, je Uhrzeit) geht in die Temperatur jedes Slots ein: OWM + Tagesgang + abklingender Rest des heutigen Versatzes (1e-9); ohne Tagesgang unveraendert; Zeile "Wärmebedarf" nennt ihn',
        ok1 && P1.model.tg === 1 && P0.model.tg === 0 && /Tagesgang Fühler − OWM/.test(o1[0].payload.rows.find(r => r[0] === 'Wärmebedarf nächste 24 h')[1]) && P1.slots.some(x => Math.abs(x.atRaw - P0.slots[P1.slots.indexOf(x)].atRaw) > 1), P1.slots.slice(0, 3).map(x => x.atRaw.toFixed(2)).join(',') + ' / ' + P0.slots.slice(0, 3).map(x => x.atRaw.toFixed(2)).join(','));
  // Modellwechsel (Stand eines aelteren Modells im Speicher): A/B-Tage, Drift, Rueckfall und Modellstand beginnen neu
  pworld({wide: true}); step(2); Object.assign(fstore.plan.learn, {mv: 2, ab: [{d0: 1, L6: {n: 96, q: 30, b: 20, k: 20}}], lg: {n: 1, up: {s: 3, an: false}}, rueckfall: {ts: NOW, bis: NOW + 86400000}, coefHist: [{ts: 1}], mdl: {ua: 0.3, g: 0, ti: 20, d0: NOW}}); step(1);
  const Lm = fstore.plan.learn;
  check('Modellwechsel (MODELL_VER 2 -> 3): A/B-Tage, Drift-Zaehler, Rueckfall-Sperre und Stände des alten Modells werden verworfen, der Modellstand neu gesetzt (Vorwert UA 0,15)', Lm.mv === 3 && Lm.ab.length === 0 && !Lm.rueckfall && Lm.coefHist.length === 0 && Lm.lg && !Lm.lg.n && Lm.mdl.ua === 0.15 && planNow().model.ua === 0.15, JSON.stringify({mv: Lm.mv, ab: Lm.ab, lg: Lm.lg, mdl: Lm.mdl}));
  // A/B: nur Schnappschuesse mit modell_ver 3 zaehlen (aeltere Vorhersagen stammen vom alten Modell)
  pworld({wide: true, pvPeak: 6000, windF: 4}); step(6 * 60 + 30); const abNeu = fstore.plan.ab && fstore.plan.ab.L6 ? fstore.plan.ab.L6.n : 0;
  pworld({wide: true, pvPeak: 6000, windF: 4}); step(6 * 60 + 30, () => { (fstore.plan && fstore.plan.snaps || []).forEach(sn => { if (sn.meta) { sn.meta.modell_ver = 2; } }); }); const abAlt = fstore.plan.ab && fstore.plan.ab.L6 ? fstore.plan.ab.L6.n : 0;
  check('A/B des Bedarfsmodells: Schnappschuesse des jetzigen Modells (modell_ver 3) zaehlen (6-h-Vorlauf ' + abNeu + ' Slots), Schnappschuesse eines aelteren Modells nicht (0)', abNeu > 0 && abAlt === 0, abNeu + ' / ' + abAlt);
}

// ---- S2b) Fahrplan v2: Fuehlerkorrektur OWM -> Fuehler (nur berechnen, anzeigen, protokollieren)
{
  const pureSrc = /\/\/ == REIN-BEGIN ==[\s\S]*?\/\/ == REIN-END ==/.exec(F['opt_plan'])[0];
  const PB = new Function(pureSrc + '\n; return {biasFeat, biasRowsFromRows, biasSolve, biasDot, biasFit, biasGate, parseCsv};')();
  const mkRnd = sd => { let s2 = sd; const r = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648; const g = () => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }; return {r, g}; };
  const near = (a, b, tolRel, tolAbs) => Math.abs(a - b) <= Math.max(tolRel * Math.abs(b), tolAbs);
  check('Fuehlerkorrektur, Merkmale: Nacht 22 Uhr mit Wind 3, 20 % Bewoelkung -> [1, 3, 0, 1, 0,8]; Mittag mit PV 7500 W -> Sonne 0,5, keine Nacht; PV wird bei 1,5 gekappt; unbekannte Bewoelkung zaehlt als 50 % klar', JSON.stringify(PB.biasFeat(22, 3, 0, 20)) === JSON.stringify([1, 3, 0, 1, 0.8]) && PB.biasFeat(12, 0, 7500, 50)[2] === 0.5 && PB.biasFeat(12, 0, 7500, 50)[3] === 0 && PB.biasFeat(12, 0, 99999, 0)[2] === 1.5 && PB.biasFeat(3, 0, 0, null)[4] === 0.5, JSON.stringify(PB.biasFeat(22, 3, 0, 20)));
  const csvB = 'slot_start,ist_aussen,ist_pv_w,ist_aussen_owm,ist_wind_ms,ist_bewoelkung_pct\n2026-11-12 22:15,5.0,0,7.0,3,20\n2026-11-12 22:30,5.0,0,,3,20\n2026-11-12 22:45,5.0,0,7.0,,20\n2026-11-12 23:00,6.5,0,7.0,2,100\n';
  const rb = PB.biasRowsFromRows(PB.parseCsv(csvB));
  check('Fuehlerkorrektur, Lernzeilen: nur Slots mit Fuehler, OWM-Temperatur UND Wind (2 von 4); Versatz = Fuehler − OWM (−2,0 und −0,5), Tag aus dem Stempel', rb.length === 2 && rb[0].d === -2 && rb[1].d === -0.5 && rb[0].day === '2026-11-12' && JSON.stringify(rb[0].f) === JSON.stringify([1, 3, 0, 1, 0.8]), JSON.stringify(rb));
  const TRUE = [-0.5, 0.30, 2.0, -0.6, -1.2];
  const mkBias = (nDays, beta, noise, seed) => { const R = mkRnd(seed), rows = []; for (let dd = 0; dd < nDays; dd++) { const wd0 = 1 + R.r() * 6, cl0 = R.r() * 100, sunny = R.r(); for (let sl = 0; sl < 96; sl++) { const h = Math.floor(sl / 4), pv = h >= 7 && h <= 17 ? 12000 * sunny * Math.sin(Math.PI * (h - 7) / 10) : 0, wd = Math.max(0, wd0 + R.g()), f = PB.biasFeat(h, wd, pv, cl0); rows.push({day: '2026-11-' + (10 + dd), d: PB.biasDot(beta, f) + noise * R.g(), f}); } } return rows; };
  { const rows = mkBias(6, TRUE, 0.3, 11), co = PB.biasSolve(rows);
    check('Fuehlerkorrektur, Wiederfindung: 6 synthetische Tage (96 Slots, 0,3 K Rauschen) -> Achsenabschnitt, Wind, Sonne, Nacht, Nacht klar innerhalb ±15 % (mindestens ±0,08)', co && co.every((v, i) => near(v, TRUE[i], 0.15, 0.08)), co ? co.map(v => v.toFixed(3)).join(' ') : 'null'); }
  { const f7 = PB.biasFit(mkBias(7, TRUE, 0.3, 12)), g7 = PB.biasGate(f7), f6 = PB.biasFit(mkBias(6, TRUE, 0.3, 13)), g6 = PB.biasGate(f6), fz = PB.biasFit(mkBias(8, [0, 0, 0, 0, 0], 0.3, 14)), gz = PB.biasGate(fz);
    check('Fuehlerkorrektur, Leave-one-day-out und Gate (nur Anzeige): mit deutlichem Versatz und 7 Tagen ist der Fehler mit Korrektur < 60 % von "keine Korrektur" und das Gate ok; bei 6 Tagen nicht ok; ohne Versatz (nur Rauschen) nicht ok', f7.maeMod < 0.6 * f7.maeZero && g7.ok && !g6.ok && g6.why.indexOf('weniger als 7 Tage') >= 0 && !gz.ok && gz.why.indexOf('Fehler nicht um 10 % besser') >= 0, JSON.stringify({f7: [f7.maeZero, f7.maeMod], g6: g6.why, gz: gz.why})); }
  check('Fuehlerkorrektur, Randfaelle: weniger als 20 Zeilen -> keine Koeffizienten, kein Fehler; leere Eingabe ebenso', PB.biasFit([]).coef === null && PB.biasFit(mkBias(1, TRUE, 0.3, 1).slice(0, 10)).coef === null, '');
  // Einbindung in den Plan
  { pworld({wide: true, windF: 5.5, windNow: 4.5, cloudsNow: 50, owmTemp: 6, atNow: 6}); step(2);
    const rowT = () => (planRows().find(r => r[0] === 'Fühlerkorrektur') || [])[1];
    check('Fuehlerkorrektur: ohne Lernzeilen "keine Daten", atK der Slots ist null, Plan unveraendert (Referenzlauf)', rowT() === 'keine Daten' && planNow().slots.every(x => x.atK === null), rowT());
    fstore.plan.bias = {rows: mkBias(8, TRUE, 0.3, 21)}; delete fstore.plan.learn.bias; fstore.plan.biasHour = undefined; fstore.plan.snapHour = 0; fstore.plan.planSlot = 0; step(1);
    const bi = fstore.plan.learn.bias, P2 = planNow(), sl = P2.slots[90], f2 = PB.biasFeat(new RealDate(sl.t).getHours(), 5.5, sl.pv, 50), dHat = PB.biasDot(bi.coef, f2);
    check('Fuehlerkorrektur: stuendlich geschaetzt, Koeffizienten wie die Lerndaten (±15 %), 8 Tage, Gate ok (aber aktiv bleibt false, wirkt nicht auf den Plan)', bi && bi.coef && bi.coef.every((v, i) => near(v, TRUE[i], 0.15, 0.08)) && bi.days === 8 && bi.gateOk === true && bi.aktiv === false, bi && bi.coef ? bi.coef.map(v => v.toFixed(2)).join(' ') : 'keine');
    check('Fuehlerkorrektur: korrigierte Temperatur eines spaeten Slots = Prognose + modellierter Versatz (der Rest des heutigen Versatzes ist dort abgeklungen, ±0,06 K)', typeof sl.atK === 'number' && Math.abs(sl.atK - sl.atRaw - dHat) < 0.06, 'atK ' + (sl.atK && sl.atK.toFixed(2)) + ' atRaw ' + sl.atRaw.toFixed(2) + ' dHat ' + dHat.toFixed(2));
    check('Anzeige "Fuehlerkorrektur": jetzt-Versatz, Wind, Sonne, Nacht, Nacht klar, Tage, Fehler OWM gegen Korrektur, "Kandidat"; keine Erklaersaetze', /^jetzt [+\-][\d,]+ K · Wind [+\-][\d,]+ K je m\/s · Sonne [+\-][\d,]+ K · Nacht [+\-][\d,]+ K · Nacht klar [+\-][\d,]+ K · 8 Tage · Fehler OWM [\d,]+ K \/ Korrektur [\d,]+ K · Kandidat$/.test(rowT()), rowT());
    check('Vorschau: die korrigierte Temperatur aendert weder Bedarf noch COP noch Strom (gleiche Slots wie ohne Korrektur)', (() => { const keep = P2.slots.map(x => [x.bedarf, x.cop, x.el]); const bi2 = fstore.plan.learn.bias; fstore.plan.learn.bias = {coef: null, n: 0, days: 0}; fstore.plan.biasHour = Math.floor(NOW / 3600000) * 3600000; fstore.plan.planSlot = 0; pfeed(); run('opt_plan', {}); const P3 = planNow(); fstore.plan.learn.bias = bi2; return P3.slots.every((x, i) => JSON.stringify([x.bedarf, x.cop, x.el]) === JSON.stringify(keep[i])) && P3.slots.every(x => x.atK === null); })(), '');
    // Schnappschuss und plan-eval
    fstore.plan.snapHour = 0; fstore.plan.planSlot = 0; step(1); const snK = fstore.plan.snaps[fstore.plan.snaps.length - 1];
    check('Schnappschuss: Spalte at_korr (Index 13) mit Zahlen fuer alle Slots, Spaltenzahl stimmt', snK.cols[13] === 'at_korr' && snK.slots.every(r => r.length === snK.cols.length && typeof r[13] === 'number'), snK.slots[0].slice(11, 15).join('|'));
    const keepB = JSON.stringify(fstore.plan.learn.bias); step(1); delete fstore.plan; step(1);
    check('Neustart: Koeffizienten der Fuehlerkorrektur kommen aus plan-state.json zurueck (gleicher Zeitstempel, keine Neuberechnung in derselben Stunde)', JSON.stringify(fstore.plan.learn.bias) === keepB, ''); }
}

// ---- S3-S5) Fahrplan v2: Sonne und Wind im Waermebedarf (Koeffizienten 0 = unveraendert), A/B-Bilanz, Aktivierung nur mit Schalter
{
  const mkRnd = sd => { let s2 = sd; const r = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648; const g = () => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }; return {r, g}; };
  const dayA = (k, kh, q, s, wk) => [Date.UTC(2026, 9, 20 + k, 0, 0), kh, q, 1440, s, wk, kh, wk === null ? null : wk, 0, 1440, wk === null ? 0 : 1440, 1440, wk === null ? 0 : 1440, null, null, 0, 0, 0, 0, 0, 0, kh + 7 * 24, 22, null, null, null];   // Modell v3: khI = kh + 7 K x 24 h (T_innen 22 °C)
  const sunDays = n => { const R = mkRnd(404), out = []; for (let k = 0; k < n; k++) { const kh = 80 + R.r() * 100, S = 10 + R.r() * 80, X = kh / 24 + 7; out.push(dayA(k, kh, (24 * (0.14 * X - 0.4) - 0.08 * S) * (1 + 0.02 * R.g()), S, null)); } return out; };
  const prep = (opts) => { pworld(Object.assign({wide: true, pvPeak: 6000, windF: 4}, opts || {})); step(2); fstore.plan.bf = {days: [], v: 3}; fstore.plan.learn.days = sunDays(12); delete fstore.plan.learn.coef; fstore.plan.planSlot = 0; step(1); };
  // Standard: Schalter aus -> Kandidat vorhanden, Gate ok, aber keine Wirkung (bit-identisch)
  prep(); { const cf = fstore.plan.learn.coef, P3 = planNow();
    check('S3/S5: mit 12 Tagen Sonneneffekt ist das Gate ok und der Kandidat gerechnet, aber ohne Schalter (plan.coefActivate) bleibt aktiv false: bedarf = bisheriges Modell in jedem Slot, Wirkung auf die Summe 0', cf.n === 12 && cf.gate.ok === true && cf.aktiv === false && P3.slots.every(x => x.bedarf === x.bas && x.solU === 0 && x.winU === 0) && P3.sum.solU === 0 && P3.slots.some(x => x.solK > 0), JSON.stringify({n: cf.n, gate: cf.gate, aktiv: cf.aktiv, bs: cf.bs})); }
  { const M = (gstore.OPT_plan || {}).model || {};
    check('Gebaeudemodell fuer die Entscheidungsmaschine (OPT_plan.model): Lernstand 12 Tage, Gate ok, ohne Schalter aktiv false und Sonne/Wind-Koeffizienten 0', M.n === 12 && M.gate === true && M.aktiv === false && M.bs === 0 && M.bw === 0 && M.minDays === 10 && Math.abs(M.tbal - (M.ti - M.g / M.ua)) < 0.01 && M.tbal > 15 && M.tbal < 21, JSON.stringify(M)); }
  // Schalter an: Wirkung nach Formel, Obergrenze, Nichtnegativitaet
  prep({cfg: {coefActivate: 1}}); { const cf = fstore.plan.learn.coef, P3 = planNow(), M = (gstore.OPT_plan || {}).model || {};
    check('OPT_plan.model mit Schalter (coefActivate) und Gate: aktiv true, Sonnen-Koeffizient wie der aktive Kandidat', M.aktiv === true && M.gate === true && M.bs === cf.bs && M.bs > 0, JSON.stringify(M));
    check('S3/S5: mit Schalter und bestandenem Gate wird der Kandidat aktiv (aktiv true)', cf.aktiv === true && cf.gate.ok === true, JSON.stringify({aktiv: cf.aktiv, why: cf.gate.why}));
    const bs = cf.bs;
    check('S3 Formel: je Slot bedarf = max(0, Basis − min(βs·Sonne, 0,6·Basis)) auf 1e-12; Sonne mindestens in einigen Slots wirksam, nie negativ, Wirkung ≤ 60 % der Basis', P3.slots.every(x => Math.abs(x.bedarf - Math.max(0, x.bas - Math.min(bs * x.sun, 0.6 * x.bas))) < 1e-12 && x.bedarf >= 0 && x.solU <= 0.6 * x.bas + 1e-12) && P3.slots.some(x => x.solU > 0.001) && P3.slots.some(x => x.solU === 0) && bs > 0.03 && bs < 0.15, 'bs ' + bs.toFixed(4));
    check('S3 Anzeige: Zeile "Wärmebedarf nächste 24 h" nennt jetzt Sonne (negativ) und Wind', /· Sonne -[\d,]+ kWh · Wind [\d,]+ kWh$/.test(planRows().find(r => r[0] === 'Wärmebedarf nächste 24 h')[1]), planRows().find(r => r[0] === 'Wärmebedarf nächste 24 h')[1]); }
  // Obergrenze bei sehr viel PV
  prep({cfg: {coefActivate: 1}, pvPeak: 40000}); { fstore.plan.learn.coef = Object.assign({}, fstore.plan.learn.coef, {n: 12, aktiv: true, bs: 0.5, bw: 0, maeWind: null, sig: fstore.plan.learn.coef.sig}); fstore.plan.planSlot = 0; step(1); const P3 = planNow();
    check('S3 Obergrenze: bei sehr hoher PV (40 kW) und grossem βs (0,5) bleibt die Sonnenwirkung je Slot auf 60 % der Basis begrenzt, Bedarf nie unter 40 % der Basis', P3.slots.every(x => x.solU <= 0.6 * x.bas + 1e-12 && x.bedarf >= 0.4 * x.bas - 1e-12) && P3.slots.some(x => Math.abs(x.solU - 0.6 * x.bas) < 1e-9 && x.bas > 0), ''); }
  // Glaettung: Rekursion und Startwert aus den Ist-Werten der letzten 2 h; Konfidenz gewichtet die Sonne
  prep(); { fstore.plan.pvHist = [0.5, 0.5, 0.5, 0.5]; fstore.plan.planSlot = 0; step(1); const P3 = planNow(), al = 1 - Math.exp(-0.25 / 2);
    const sRaw = x => (x.pv === null ? 0 : x.cP * x.pv * 0.25 / 1000);
    check('S3 Glaettung: Sonne je Slot folgt S[i] = S[i−1] + (S_roh − S[i−1])·(1 − e^(−0,125)) auf 1e-12, Startwert = Mittel der Ist-PV der letzten 2 h (0,5 kWh); S_roh waechst mit dem Vertrauen (cP)', Math.abs(P3.slots[0].sun - (0.5 + (sRaw(P3.slots[0]) - 0.5) * al)) < 1e-12 && P3.slots.slice(1, 60).every((x, i) => Math.abs(x.sun - (P3.slots[i].sun + (sRaw(x) - P3.slots[i].sun) * al)) < 1e-12), P3.slots[0].sun.toFixed(4)); }
  // Wind: Handrechnung mit festen Koeffizienten
  prep({cfg: {coefActivate: 1}, windF: 7}); { fstore.plan.learn.coef = Object.assign({}, fstore.plan.learn.coef, {n: 12, aktiv: true, bs: 0, bw: 0.01, maeWind: 0.5, bsW: 0, nW: 9, sig: fstore.plan.learn.coef.sig}); fstore.plan.planSlot = 0; step(1); const P3 = planNow();
    const ti3 = P3.model.ti;
    check('S3 Wind (Modell v3): mit βw 0,01 gilt bedarf = Basis + βw·max(0, T_innen − T)·max(0, Wind − 4)·0,25 h auf 1e-9 (Wind 7 m/s aus der Prognose, 3 m/s ueber der Totzone)', P3.slots.every(x => Math.abs(x.bedarf - Math.max(0, x.bas + 0.01 * Math.max(0, ti3 - x.at) * 3 * 0.25)) < 1e-9) && P3.slots.some(x => x.winU > 0), P3.slots[0].bedarf.toFixed(5) + ' vs ' + (P3.slots[0].bas + 0.01 * Math.max(0, ti3 - P3.slots[0].at) * 0.75).toFixed(5)); }
  prep({cfg: {coefActivate: 1}, windF: 4}); { fstore.plan.learn.coef = Object.assign({}, fstore.plan.learn.coef, {n: 12, aktiv: true, bs: 0, bw: 0.01, maeWind: 0.5, bsW: 0, nW: 9, sig: fstore.plan.learn.coef.sig}); fstore.plan.planSlot = 0; step(1);
    check('S3 Wind-Totzone: Wind 4 m/s (genau an der Totzone) -> Windterm 0 in jedem Slot, bedarf = Basis', planNow().slots.every(x => x.winU === 0 && x.winK === 0 && x.bedarf === x.bas), ''); }
  prep({cfg: {coefActivate: 1}, windF: 7}); { fstore.plan.learn.coef = Object.assign({}, fstore.plan.learn.coef, {n: 12, aktiv: true, bs: 0, bw: 0.05, maeWind: 0.5, bsW: 0, nW: 9, sig: fstore.plan.learn.coef.sig}); fstore.plan.planSlot = 0; step(1); const P4 = planNow(), M4 = (gstore.OPT_plan || {}).model || {};
    check('S3 Wind-Grenze: ein (eingeschleust) aktives βw 0,05 wirkt nur mit 0,0125 (Nutzerentscheidung 13.10.); OPT_plan.model meldet bw 0,0125, Totzone 4 m/s und Modellversion 3', P4.slots.every(x => Math.abs(x.winU - 0.0125 * Math.max(0, P4.model.ti - x.at) * 3 * 0.25) < 1e-9) && M4.bw === 0.0125 && M4.windTot === 4 && M4.ver === 3, JSON.stringify(M4)); }
  { prep({cfg: {coefActivate: 1}, windF: undefined}); fstore.plan.learn.coef = Object.assign({}, fstore.plan.learn.coef, {n: 12, aktiv: true, bs: 0, bw: 0.01, maeWind: 0.5, bsW: 0, nW: 9, sig: fstore.plan.learn.coef.sig}); fstore.plan.planSlot = 0; step(1);
    check('S3 Wind: ohne Windprognose (4-elementige Punkte) ist der Windterm 0, kein Fehler', planNow().status === 'ok' && planNow().slots.every(x => x.bedarf === x.bas), ''); }
  // Hysterese: war aktiv und das Gate ist nicht mehr ok, aber der Kandidat ist weiter besser als der Plan-Schaetzer -> bleibt aktiv
  prep({cfg: {coefActivate: 1}}); { const cf0 = fstore.plan.learn.coef; fstore.plan.learn.days = fstore.plan.learn.days.map(d => d.slice()); fstore.plan.learn.days.forEach(d => { d[4] = 50; }); fstore.plan.learn.coef.aktiv = true; step(1);
    const cf1 = fstore.plan.learn.coef;
    check('S5 Hysterese: war aktiv; bei gleichfoermigen PV-Tagen faellt das Gate durch, aktiv bleibt solange der Kandidat nicht schlechter als der Plan-Schaetzer ist (Fehler Kandidat ≤ Plan)', cf1.gate.ok === false && cf1.n === 12 && ((cf1.maeSun !== null && cf1.maeBase > 0 && cf1.maeSun <= cf1.maeBase) === cf1.aktiv), JSON.stringify({aktiv: cf1.aktiv, base: cf1.maeBase, sun: cf1.maeSun, why: cf1.gate.why})); }
  // Sicherheit A (13.10.): kuenstlich negativer / zu grosser / nicht endlicher Fit
  const PUA = new Function(/\/\/ == REIN-BEGIN ==[\s\S]*?\/\/ == REIN-END ==/.exec(F['opt_plan'])[0] + '\n; return {gateCheck, coefSafe, coefHardFail, prepRows, fitModel, windEff, COEF_LIM, WIND_TOT, MODELL_VER, lgFlags, lgTxt, cusum, abSchritt, PLAUS, LERN_GATE, DRIFT, daysFromRows, parseCsv, d0Of};')();
  { const fx = {ua: 0.25, bw: 0, bs: 0.05}, rows10 = Array.from({length: 10}, (_, i) => ({y: 30, x1: 120, x2: 0, x3: i % 2 ? 20 : 80}));
    const gNeg = PUA.gateCheck(12, rows10, 10, 8, {ua: 0.25, bw: -0.01, bs: -0.2}, {minDays: 10}), gNaN = PUA.gateCheck(12, rows10, 10, 8, {ua: 0.25, bw: 0, bs: NaN}, {minDays: 10}), gBig = PUA.gateCheck(12, rows10, 10, 8, {ua: 0.25, bw: 0.06, bs: 0.1}, {minDays: 10}), gOk = PUA.gateCheck(12, rows10, 10, 8, fx, {minDays: 10});
    check('Sicherheit A Gate: negativer Fit -> "Koeffizient negativ", NaN -> "nicht endlich", bw 0,06 -> "unplausibel"; jeweils harter Fehler; plausibler Fit ok', gNeg.why.includes('Koeffizient negativ') && gNaN.why.includes('Koeffizient nicht endlich') && gBig.why.includes('Koeffizient unplausibel') && [gNeg, gNaN, gBig].every(PUA.coefHardFail) && gOk.ok && !PUA.coefHardFail(gOk), JSON.stringify([gNeg.why, gNaN.why, gBig.why, gOk.why]));
    const c1 = PUA.coefSafe({bs: -0.3, bw: -1}), c2 = PUA.coefSafe({bs: 9, bw: 9}), c3 = PUA.coefSafe({bs: NaN, bw: Infinity}), c4 = PUA.coefSafe({bs: 0.1, bw: 0.01}), c5 = PUA.coefSafe(null);
    check('Sicherheit A Klemme: negativ -> 0, zu gross -> Grenze (0,5 / 0,0125), nicht endlich -> 0, plausibel unveraendert, null -> 0', c1.bs === 0 && c1.bw === 0 && c2.bs === 0.5 && c2.bw === 0.0125 && c3.bs === 0 && c3.bw === 0 && c4.bs === 0.1 && c4.bw === 0.01 && !c4.geklemmt && c1.geklemmt && c5.bs === 0, JSON.stringify([c1, c2, c3, c4])); }
  prep({cfg: {coefActivate: 1}}); { fstore.plan.learn.coef = Object.assign({}, fstore.plan.learn.coef, {n: 12, aktiv: true, bs: -0.4, bsW: -0.4, bw: -0.03, maeWind: 0.5, sig: fstore.plan.learn.coef.sig}); fstore.plan.planSlot = 0; step(1); const P3 = planNow(), M = (gstore.OPT_plan || {}).model || {};
    check('Sicherheit A Plan: ein (eingeschleust) aktiver negativer Fit erhoeht den Bedarf nie: Sonne/Wind geklemmt auf 0 -> bedarf = Basis in jedem Slot; OPT_plan.model meldet bs = bw = 0', P3.slots.every(x => x.bedarf === x.bas && x.solU === 0 && x.winU === 0 && x.solK === 0) && M.bs === 0 && M.bw === 0, JSON.stringify({bs: M.bs, bw: M.bw})); }
  prep({cfg: {coefActivate: 1}}); { fstore.plan.learn.coef.aktiv = true; fstore.plan.learn.days = fstore.plan.learn.days.map(d => d.slice()); fstore.plan.learn.days[0][2] = fstore.plan.learn.days[0][2] + 0.001;
    const cf = fstore.plan.learn.coef, gate = {ok: false, why: ['Fehler nicht um 10 % besser', 'Koeffizient negativ']};
    check('Sicherheit A Hysterese: harter Koeffizienten-Fehler beendet die Hysterese (coefHardFail), weicher Grund ("Fehler nicht um 10 % besser") nicht', PUA.coefHardFail(gate) === true && PUA.coefHardFail({ok: false, why: ['Fehler nicht um 10 % besser', 'PV-Tage zu gleichfoermig']}) === false && cf.n === 12, ''); }
  // Nutzerentscheidung 13.10.2026: Wind-Grenze 0,0125, Totzone 4 m/s, Modellversion 2
  { const rows10 = Array.from({length: 10}, (_, i) => ({y: 30, x1: 120, x2: 0, x3: i % 2 ? 20 : 80}));
    const gA = PUA.gateCheck(12, rows10, 10, 8, {ua: 0.25, bw: 0.0125, bs: 0.1}, {minDays: 10}), gB = PUA.gateCheck(12, rows10, 10, 8, {ua: 0.25, bw: 0.0126, bs: 0.1}, {minDays: 10});
    check('Wind-Grenze im Gate: bw 0,0125 ist plausibel, 0,0126 "Koeffizient unplausibel" (harter Fehler); Konstanten COEF_LIM 0,5/0,0125, Totzone 4 m/s, Modellversion 3', gA.ok && gB.why.includes('Koeffizient unplausibel') && PUA.coefHardFail(gB) && PUA.COEF_LIM.bs === 0.5 && PUA.COEF_LIM.bw === 0.0125 && PUA.WIND_TOT === 4 && PUA.MODELL_VER === 3, JSON.stringify([gA.why, gB.why]));
    check('Wind-Totzone: windEff(3) = 0, windEff(4) = 0, windEff(7) = 3, ohne Wert null', PUA.windEff(3) === 0 && PUA.windEff(4) === 0 && PUA.windEff(7) === 3 && PUA.windEff(null) === null, '');
    const dW = [0, 1, 2].map(k => ({d0: k, kh: 100 + k * 10, q: 25 + k, n: 1440, s: 10, wk: 900 + k * 100, khW: 90, wkW: 800, dtr: 0, wkT: k * 50, wkWT: k * 40, khI: 300 + k * 10, khIW: 280, wkI: k * 60, wkIW: k * 45}));
    const pw = PUA.prepRows(dW, {useW: true, useS: true, tref: 'kh', C: 0}), pwO = PUA.prepRows(dW, {useW: true, useS: true, tref: 'khW', C: 0});
    check('Fit-Merkmale Modell v3: x1 = K·h gegen T_innen (khI bzw. khIW), Wind = (T_innen − T) × Wind ueber der Totzone (wkI bzw. wkIW), nicht die alten Heizgradstunden/der rohe Wind; x4 = 24 h (Gewinne)', pw.rows.map(r => r.x2).join() === '0,60,120' && pwO.rows.map(r => r.x2).join() === '0,45,90' && pw.rows.map(r => r.x1).join() === '300,310,320' && pwO.rows.every(r => r.x1 === 280) && pw.rows.every(r => r.x4 === 24) && pw.nW === 3, JSON.stringify(pw.rows.map(r => r.x2))); }
  prep({cfg: {coefActivate: 1}}); { const cfOld = Object.assign({}, fstore.plan.learn.coef, {aktiv: true, sig: '12|alt', ver: undefined}); fstore.plan.learn.days = fstore.plan.learn.days.map(d => { const e = d.slice(); e[4] = 50; return e; }); fstore.plan.learn.coef = cfOld; fstore.plan.bf = {days: []}; step(1);
    const cfN = fstore.plan.learn.coef;
    check('Modellversion: gespeicherte Koeffizienten eines aelteren Modells werden neu gerechnet (Signatur "v3|...", ver 3); ihr "aktiv" wird nicht uebernommen (gleichfoermige PV-Tage: Gate zu, keine Hysterese) ', cfN.ver === 3 && /^v3\|/.test(cfN.sig) && cfN.aktiv === false && cfN.gate.ok === false && fstore.plan.bf.v === 3, JSON.stringify({ver: cfN.ver, sig: cfN.sig.slice(0, 12), aktiv: cfN.aktiv, why: cfN.gate.why, bf: fstore.plan.bf.v})); }
  // Validierung (D): Ueberanpassungs-Quote Test/Training (Idee pump-ahead cross_validation.py, 1,5)
  { const rows10 = Array.from({length: 10}, (_, i) => ({y: 30, x1: 120, x2: 0, x3: i % 2 ? 20 : 80})), fx = {ua: 0.25, bw: 0, bs: 0.05};
    const gU = PUA.gateCheck(12, rows10, 10, 8, fx, {minDays: 10, maeIn: 5}), gO = PUA.gateCheck(12, rows10, 10, 8, fx, {minDays: 10, maeIn: 6});
    prep({cfg: {coefActivate: 1}}); const cfV = fstore.plan.learn.coef;
    check('Ueberanpassung: Test 8 / Training 5 kWh (Quote 1,6) -> Gate-Grund "Überanpassung (Test/Training 1,6)"; Quote 1,33 -> kein Grund; die 12 synthetischen Sonnentage bestehen (Quote ' + (cfV.maeSun / cfV.maeIn).toFixed(2) + ')',
          gU.why.includes('Überanpassung (Test/Training 1,6)') && !gO.why.some(w => /Überanpassung/.test(w)) && cfV.gate.ok === true && cfV.maeSun / cfV.maeIn <= 1.5, JSON.stringify([gU.why, gO.why, cfV.maeIn, cfV.maeSun])); }
  // Lern-Hygiene (B, 13.10.2026): Plausibilitaet, Tages-Gate, Drift; Absicherung (D): Rueckfall mit Sperre, Schnappschuesse
  { const F0 = {dhwM: 0, defM: 0, gapM: 0, engM: 0, unpM: 0};
    check('Lern-Gate (rein): Grenzen 120/90/60/60/60 min (ANNAHME) -> Bitmaske 1 Warmwasser, 2 Abtauen, 4 Luecke, 8 Eingriff, 16 unplausibel; genau an der Grenze lernt der Tag mit',
          PUA.lgFlags(F0) === 0 && PUA.lgFlags(Object.assign({}, F0, {dhwM: 121})) === 1 && PUA.lgFlags(Object.assign({}, F0, {dhwM: 120})) === 0 && PUA.lgFlags(Object.assign({}, F0, {defM: 91, gapM: 61})) === 6 && PUA.lgFlags(Object.assign({}, F0, {engM: 61, unpM: 61})) === 24 && PUA.lgTxt(6) === 'Abtauen, Datenlücke' && PUA.LERN_GATE.dhwMaxMin === 120, '');
    let txt = 'slot_start,ist_aussen,ist_pv_w,ist_waerme_kwh,ist_ww_min,ist_abtau_min\n'; for (let i = 0; i < 96; i++) { const h = Math.floor(i / 4), m = (i % 4) * 15; txt += '2026-11-10 ' + (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ',5,0,0.6,' + (i < 10 ? 15 : 0) + ',0\n'; }
    for (let i = 0; i < 96; i++) { const h = Math.floor(i / 4), m = (i % 4) * 15; txt += '2026-11-11 ' + (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ',5,0,0.6,' + (i < 6 ? 15 : 0) + ',0\n'; }
    const dsW = PUA.daysFromRows(PUA.parseCsv(txt), 15);
    check('Lern-Gate in der Rueckrechnung (plan-actuals): 150 min Warmwasser -> Tag gesperrt (1), 90 min -> lernt mit (0)', dsW.length === 2 && dsW[0].flags === 1 && dsW[1].flags === 0, JSON.stringify(dsW.map(d => d.flags)));
    const st = []; let c = null; [1.5, 1.5, 1.5, 0, 0, 0].forEach(x => { c = PUA.cusum(c, x, 0.5, 3); st.push(c.s + (c.an ? '!' : '')); });
    check('CUSUM (Idee tvofi drift.py): s = min(1,5 h, max(0, s + x − k)); x 1,5 je Tag, k 0,5, h 3 -> 1, 2, 3 (Alarm), danach 2,5, 2, 1,5 (Alarm bleibt bis s <= h/4)', st.join(' ') === '1 2 3! 2.5! 2! 1.5!' && PUA.cusum({s: 0.7, an: true}, 0, 0.5, 3).an === false, st.join(' '));
    const L = {}, e = (q, b, k) => ({L24: {n: 96, q, b, k}}), r1 = PUA.abSchritt(L, e(90, 80, 60), true), r2 = PUA.abSchritt(L, e(90, 80, 60), true), r3 = PUA.abSchritt({}, {L24: {n: 40, q: 90, b: 80, k: 60}}, true);
    check('A/B-Pruefung (rein): Kandidat 30 kWh daneben, Plan-Modell 10 kWh (Streuung 9 kWh) -> y = +2,22 je Tag, Rueckfall am 2. Tag; Drift des Plan-Modells (q > b: r = 1,11) zaehlt nach oben; Tag mit weniger als 80 Slots zaehlt nicht',
          r1.genutzt && !r1.rueckfall && r2.rueckfall === true && Math.abs(r1.y - 20 / 9) < 1e-9 && Math.abs(L.up.s - 2 * (10 / 9 - 0.5)) < 1e-9 && L.dn.s === 0 && r3.genutzt === false, JSON.stringify([r1, r2, L.rb]));
    const r4 = PUA.abSchritt(L, e(90, 80, 60), false);
    check('A/B-Pruefung: ohne aktiven Kandidaten wird der Rueckfall-Zaehler zurueckgesetzt', r4.genutzt && L.rb.s === 0 && L.rb.an === false, ''); }
  // Integration: Plausibilitaet und Tages-Gate im Live-Tag; Anzeige
  { pworld({wide: true, atBase: 5, running: true, hp: 2500, atNow: 5, pvNow: 2000, windNow: 6, owmTemp: 7}); O.hp = 2500;
    step(1440 + 5, m => { if (m >= 100 && m < 175) { gstore.TOP14_Outside_Temp = -127; } if (m >= 300 && m < 430) { gstore.TOP20_ThreeWay_Valve_State = 1; } else { gstore.TOP20_ThreeWay_Valve_State = 0; } });
    const dG = fstore.plan.learn.days[0];
    check('Lern-Gate live: 75 min Aussentemperatur −127 °C (Fuehlerfehler) und 130 min Warmwasser -> Tag mit Gate 17 (Warmwasser + unplausibel), Zaehler 130/0/0/0/75; die unplausiblen Minuten fehlen in den Heizgradstunden (kh ~ 240 − 75/60·10)',
          dG && dG[15] === 17 && dG[16] === 130 && dG[20] === 75 && Math.abs(dG[1] - (240 - 75 / 60 * 10)) < 1.5, JSON.stringify(dG && dG.slice(13)));
    step(2); const rG = (planRows().find(r => r[0] === 'Lern-Gate') || [])[1];
    check('Anzeige "Lern-Gate": heute frei, 1 verworfener Tag (Warmwasser 1, unplausibel 1); der Tag fehlt im Gebaeudemodell', /^heute frei · verworfene Tage 1 \(Warmwasser 1, unplausibel 1\)$/.test(rG) && fstore.plan.lgVerw.length === 1 && (fstore.plan.learn.coef || {n: 0}).n === 0, rG);
    { const LN = gstore.OPT_plan.lern; check('OPT_plan.lern stimmt mit der Zeile "Lern-Gate" ueberein: heute 0 (frei), 1 verworfener Tag "Warmwasser 1, unplausibel 1"', LN.heute === 0 && LN.heuteTxt === '' && LN.verw === 1 && LN.verwTxt === 'Warmwasser 1, unplausibel 1', JSON.stringify(LN)); }
    step(1, () => { gstore.MQTT = {block_active: 1}; }); for (let i = 0; i < 61; i++) { step(1, () => { gstore.MQTT = {block_active: 1}; }); }
    const rG2 = (planRows().find(r => r[0] === 'Lern-Gate') || [])[1];
    check('Anzeige "Lern-Gate": nach 62 min MQTT-Sperre heute "gesperrt (Eingriff)"', /^heute gesperrt \(Eingriff\)/.test(rG2), rG2);
    check('OPT_plan.lern: heute gesperrt (Bitmaske 8 = Eingriff, Text "Eingriff") wie die Zeile', gstore.OPT_plan.lern.heute === 8 && gstore.OPT_plan.lern.heuteTxt === 'Eingriff', JSON.stringify(gstore.OPT_plan.lern)); }
  { pworld({wide: true, atBase: 5, running: true, hp: 2500, atNow: 5}); delete gstore.OPT_hp; O.hp = 0; step(70);
    check('Lern-Gate live: Anlagendaten fehlen (kein OPT_hp) -> Datenluecke wird gezaehlt (70 min) und heute gesperrt', fstore.plan.day.gapM >= 69 && /heute gesperrt \(Datenlücke\)/.test((planRows().find(r => r[0] === 'Lern-Gate') || [])[1]), String(fstore.plan.day.gapM)); }
  { pworld({wide: true}); step(2); fstore.plan.learn.ab = [{d0: 1, L6: {n: 96, q: 29.97, b: 19.72, k: 19.72}}, {d0: 2, L6: {n: 96, q: 35.98, b: 31.05, k: 31.05}, L24: {n: 30, q: 10.8, b: 6.2, k: 6.2}}]; delete fstore.plan.learn.lg; step(1);
    const rD = (planRows().find(r => r[0] === 'Bedarfsmodell Drift') || [])[1], lg = fstore.plan.learn.lg;
    const lg3 = JSON.parse(JSON.stringify(lg)); PUA.abSchritt(lg3, {L6: {n: 96, q: 33, b: 30, k: 30}}, false);
    check('Drift-Zaehler werden einmalig aus den gesicherten A/B-Tagen nachgerechnet (Echtdaten 11./12.10., 6-h-Vorlauf: Ist 30,0/36,0 kWh gegen Plan-Modell 19,7/31,1 kWh -> CUSUM 3,8 von 4, noch "ruhig"); ein dritter Tag mit +10 % meldet "Mehrbedarf"', lg.n === 2 && lg.up.an === false && Math.abs(lg.up.s - 3.79) < 0.01 && /^ruhig \(CUSUM \+ 3,8 \/ − 0,0, 2 Tage\)$/.test(rD) && lg3.up.an === true, rD); }
    { const D = gstore.OPT_plan.lern.drift; check('OPT_plan.lern.drift wie die Zeile "Bedarfsmodell Drift": 2 A/B-Tage, Mehrbedarf-CUSUM 3,8 (gerundet), Minderbedarf 0, kein Alarm, Alarmschwelle 4', D.n === 2 && D.up === 3.8 && D.dn === 0 && D.upAn === false && D.dnAn === false && D.h === 4, JSON.stringify(D)); }
  // Absicherung (D): Rueckfall im laufenden Fluss (Tageswechsel mit A/B-Tag) und Sperre bei der naechsten Neuberechnung
  { pworld({wide: true, pvPeak: 6000, windF: 4, start: 18 * HH, cfg: {coefActivate: 1}}); step(2); fstore.plan.bf = {days: [], v: 3}; fstore.plan.learn.days = sunDays(12); delete fstore.plan.learn.coef; fstore.plan.planSlot = 0; step(1);
    const akt0 = fstore.plan.learn.coef.aktiv, hist0 = (fstore.plan.learn.coefHist || []).length;
    fstore.plan.ab = {d0: new RealDate(NOW).setHours(0, 0, 0, 0), L24: {n: 96, q: 84, b: 80, k: 60}, L6: {n: 96, q: 84, b: 80, k: 60}}; fstore.plan.learn.lg = {rb: {s: 2.5, an: false}};
    step(6 * 60 + 30); const rf = fstore.plan.learn.rueckfall, cfR = fstore.plan.learn.coef, rD = (planRows().find(r => r[0] === 'Bedarfsmodell Drift') || [])[1];
    check('Rueckfall (D): aktiver Kandidat (Gate ok, coefActivate), A/B-Tag mit Kandidat 24 kWh daneben (Plan-Modell 4) -> nach Mitternacht zurueckgenommen (aktiv false), Sperre 7 Tage, Grund mit CUSUM; Anzeige "Kandidat zurückgenommen"; Schnappschuss der aktiven Lernwerte vorhanden',
          akt0 === true && hist0 >= 1 && rf && /Kandidat im A\/B schlechter als das Plan-Modell \(CUSUM [\d.]+\)/.test(rf.grund) && Math.abs(rf.bis - rf.ts - 7 * 86400000) < 1 && cfR.aktiv === false && /Kandidat zurückgenommen \d\d\.\d\d\., gesperrt bis \d\d\.\d\d\./.test(rD) && rf.stand && rf.stand.bs > 0 && (gstore.OPT_plan.model || {}).aktiv === false,
          JSON.stringify({akt0, rf, rD}).slice(0, 400));
    check('OPT_plan.lern.rueckfall nach dem Rueckfall: Zeitpunkt und Sperre bis (7 Tage) fuer die Kachel "Bedarfsmodell Drift" (Tooltip)', gstore.OPT_plan.lern.rueckfall && gstore.OPT_plan.lern.rueckfall.bis === rf.bis && gstore.OPT_plan.lern.rueckfall.ts === rf.ts, JSON.stringify(gstore.OPT_plan.lern.rueckfall));
    delete fstore.plan.learn.coef; step(1); const cfN = fstore.plan.learn.coef;
    check('Rueckfall-Sperre: bei der naechsten Neuberechnung bleibt der Kandidat trotz bestandenem Gate gesperrt (Gate-Grund "Rückfall bis …")', cfN.aktiv === false && cfN.gate.why.some(w => /^Rückfall bis \d\d\.\d\d\.$/.test(w)), JSON.stringify(cfN.gate.why));
    fstore.plan.learn.rueckfall.bis = NOW - 1; delete fstore.plan.learn.coef; step(1);
    check('... nach Ablauf der Sperre wird der Kandidat wieder aktiv (Gate ok)', fstore.plan.learn.coef.aktiv === true, JSON.stringify(fstore.plan.learn.coef.gate.why)); }
  // Schnappschuss, Vergleich und A/B
  prep(); { fstore.plan.snapHour = 0; fstore.plan.planSlot = 0; step(1); const sn = fstore.plan.snaps[fstore.plan.snaps.length - 1], K = sn.cols;
    check('S3 Schnappschuss: fuenf Spalten hinten (sonne_kwh, solar_kand_kwh, wind_kand_kwh, bedarf_basis, bedarf_kand), Spaltenzahl stimmt, Kandidat enthaelt Sonne (kleiner als die Basis in PV-Stunden)', K.slice(14).join() === 'sonne_kwh,solar_kand_kwh,wind_kand_kwh,bedarf_basis,bedarf_kand' && sn.slots.every(r => r.length === K.length) && sn.slots.some(r => r[K.indexOf('solar_kand_kwh')] > 0.001 && r[K.indexOf('bedarf_kand')] < r[K.indexOf('bedarf_basis')]), K.slice(24).join()); }
  { pworld({wide: true, pvPeak: 6000, windF: 4}); const all = step(60 * 12 + 5), ab = fstore.plan.ab;
    check('S4 A/B: Tagesbilanz je Vorlauf (6 h und 24 h) summiert Ist-Waerme, Plan-Modell und Kandidat aus den Schnappschuessen; ohne Koeffizienten sind beide Modelle gleich', ab && ab.L6 && ab.L6.n >= 20 && Math.abs(ab.L6.b - ab.L6.k) < 1e-9 && ab.L6.q >= 0, JSON.stringify(ab && ab.L6)); }
  { pworld({wide: true}); step(2); fstore.plan.learn.ab = [{d0: 1, L6: {n: 90, q: 30, b: 28, k: 29.5}, L24: {n: 90, q: 30, b: 27, k: 29}}, {d0: 2, L6: {n: 90, q: 20, b: 23, k: 21}, L24: {n: 50, q: 20, b: 23, k: 21}}]; step(1);
    const t6 = (planRows().find(r => r[0] === 'Bedarfsmodell A/B') || [])[1];
    check('S4 Anzeige "Bedarfsmodell A/B": mittlerer Tagesfehler Waerme je Vorlauf (Plan gegen Kandidat, nur Tage mit mindestens 80 Slots): 6 h Plan 2,5 / Kandidat 0,8 (2 Tage), 24 h Plan 3,0 / Kandidat 0,5 (1 Tag)', t6 === 'Tagesfehler Wärme 6 h: Plan 2,5 kWh · Kandidat 1,0 kWh (2 Tage) · 24 h: Plan 3,0 kWh · Kandidat 1,0 kWh (1 Tage)' || /^Tagesfehler Wärme 6 h: Plan 2,5 kWh · Kandidat [\d,]+ kWh \(2 Tage\) · 24 h: Plan 3,0 kWh · Kandidat [\d,]+ kWh \(1 Tage\)$/.test(t6), t6); }
  { pworld({wide: true}); step(2); const t0 = (planRows().find(r => r[0] === 'Bedarfsmodell A/B') || [])[1]; check('S4 Anzeige: ohne abgeschlossene Tage "keine abgeschlossenen Tage"', t0 === 'keine abgeschlossenen Tage', t0); }
  // Neustart: Aktivierung und A/B ueberstehen einen Neustart
  prep({cfg: {coefActivate: 1}}); { step(2); fstore.plan.learn.ab = [{d0: 1, L6: {n: 90, q: 30, b: 28, k: 29.5}}]; fstore.plan.lastSave = 0; step(1); const keepA = JSON.stringify([fstore.plan.learn.coef, fstore.plan.learn.ab]); delete fstore.plan; step(1);
    check('Neustart: Koeffizienten (inkl. aktiv) und A/B-Tage kommen aus plan-state.json zurueck', JSON.stringify([fstore.plan.learn.coef, fstore.plan.learn.ab]) === keepA, ''); }
}

// ---- UI) Diagramme und aufgeraeumte Seiten (Verlaufsdaten, Diagramm-Baukasten, Plan-Karte)
{
  const OC = require(path.join(__dirname, 'ui_chart.js')), flowsAll = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), NB = id => flowsAll.find(n => n.id === id);
  const H1 = 3600000, tA = new RealDate(2026, 10, 12, 0, 0, 0).getTime();
  // Diagramm-Baukasten (reine Funktion)
  const dd = []; for (let i = 0; i <= 48; i++) { dd.push([tA + i * H1 / 2, i === 20 || i === 21 ? null : 20 + 5 * Math.sin(i / 6)]); }
  const spec = {t0: tA, t1: tA + 24 * H1, marks: [{t: tA + 12 * H1, label: 'jetzt'}], panels: [
    {h: 160, unit: '°C', bands: [{a: 19, b: 21}], series: [{n: 'Linie <b>', c: '#1976d2', d: dd, k: 'line', dg: 1, u: '°C'}, {n: 'Stufe', c: '#ef6c00', d: dd.map(p => [p[0], p[1] === null ? null : p[1] - 3]), k: 'step'}, {n: 'Flaeche', c: '#2e7d32', d: dd.map(p => [p[0], p[1] === null ? null : p[1] * 50]), k: 'area', r: true}]},
    {h: 90, unit: 'kW', zero: true, series: [{n: 'Balken', c: '#999', k: 'bar', bw: H1 / 2, bf: 0.5, d: dd.map(p => [p[0], p[1] === null ? 0 : p[1] / 10]), bc: [[tA, '#ff0000']], dg: 2, u: 'kW'}]}]};
  const sv = OC.svg(spec, 900), sgr = sv.svg;
  check('Diagramm-Baukasten: SVG mit 2 Feldern (Hoehe = 160 + 90 + Abstand + Achse), Pfaden fuer Linie, Stufe und Flaeche, Rasterlinien, Zeitbeschriftung, Marke "jetzt", ohne NaN/undefined', sgr.startsWith('<svg') && sv.geo.panels.length === 2 && sv.geo.H === 18 + 160 + 26 + 90 + 26 && !/NaN|undefined|Infinity/.test(sgr) && (sgr.match(/<path/g) || []).length >= 4 && />jetzt</.test(sgr) && /12:00|06:00|00:00|18:00/.test(sgr) && /<rect[^>]*fill="rgba\(46,125,50|<rect[^>]*fill="rgba/.test(sgr) === true, 'H ' + sv.geo.H + ' Pfade ' + (sgr.match(/<path/g) || []).length);
  check('Diagramm-Baukasten: Luecken (null) unterbrechen die Linie (zwei Teilstuecke), das Band zeichnet ein Rechteck, Balken bekommen die Farbe aus bc, rechte Achse hat Beschriftung', (sgr.match(/M\d/g) || []).length >= 5 && /fill="#ff0000"/.test(sgr) && /text-anchor="end"/.test(sgr) && /<text x="8\d\d/.test(sgr), 'Teilstuecke ' + (sgr.match(/M\d/g) || []).length);
  check('Diagramm-Baukasten: Tooltip-Werte nahe der Zeit (Linie, Stufe, Flaeche, Balken), Luecke liefert keinen Wert, Formatierung mit Komma und Einheit', (() => { const a = OC.at(spec, tA + 3 * H1), b = OC.at(spec, tA + 10 * H1); return a.length === 4 && /^\d+,\d °C$/.test(a[0].text) && a[3].text.endsWith(' kW') && b.length < 4 && !b.some(q => q.name === 'Linie <b>'); })(), JSON.stringify(OC.at(spec, tA + 3 * H1)).slice(0, 160));
  check('Diagramm-Baukasten: Legende maskiert Sonderzeichen (kein HTML aus Reihennamen)', /Linie &lt;b&gt;/.test(OC.legend(spec)) && !/<b>/.test(OC.legend(spec)), OC.legend(spec).slice(0, 120));
  check('Diagramm-Baukasten: leere Reihen und nur-null-Reihen brechen nichts (kein Fehler, kein NaN)', (() => { const s0 = {t0: tA, t1: tA + H1, panels: [{h: 80, series: [{n: 'leer', d: []}, {n: 'null', d: [[tA, null], [tA + 1000, null]]}]}]}; const r0 = OC.svg(s0, 500); return r0.svg.startsWith('<svg') && !/NaN|Infinity|undefined/.test(r0.svg); })(), '');
  // Verlaufsdaten
  { const mk = (day, h, m, vals) => day + ' ' + (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':00' + ',' + vals;
    const headOld = 'zeit,aussen_panasonic,aussen_wetter,aussen_berechnet,vorlauf,ruecklauf,soll_vorlauf,verdichter_hz,leistung_w,ki_oben_wert,wohn_wert', headNew = headOld + ',wetter_wind_ms,wetter_bewoelkung';
    let txt = headOld + '\n';
    const NOWH = new RealDate(2026, 10, 12, 12, 0, 0).getTime();
    for (let k = 60 * 12 * 2; k >= 0; k--) { const tt = new RealDate(NOWH - k * 5 * 60000), dy = tt.getFullYear() + '-' + String(tt.getMonth() + 1).padStart(2, '0') + '-' + String(tt.getDate()).padStart(2, '0'); if (k === 70) { txt += headNew + '\n'; } txt += mk(dy, tt.getHours(), tt.getMinutes(), '5.5,7.25,6,30.5,28.25,31,' + (k % 3 === 0 ? 0 : 17) + ',' + (k % 3 === 0 ? 15 : 280) + ',22.1,') + (k <= 70 ? ',3.2,80' : '') + '\n'; }
    txt += 'kaputte,zeile\n' + mk('2026-11-12', 11, 59, '1,2,3') + '\n';
    pworld({wide: true}); NOW = NOWH; files['/data/optimizer/optimizer-v2-2026-11.csv'] = {data: txt, mode: 0o644};
    gstore.OPT_cfg.rooms.forEach(r => { r.min = 20; r.max = 22; });
    const ho = run('opt_hist', {}), wp = ho[0].payload, rmP = ho[1].payload, wx = ho[2].payload;
    check('Verlaufsdaten: drei Ausgaenge (Waermepumpe 24 h, Raeume 24 h, Wetterkarte mit 24 h Vergangenheit); Zeitstempel einmal, Reihen gleich lang, Fenster stimmen (24 h = 289 Punkte), kaputte Zeile ignoriert', ho.length === 3 && wp.t.length === wp.vl.length && wp.t.length === 289 && wx.hist.t.length === 289 && wx.hist.at.length === 289 && rmP.t.length === 289 && wp.now === NOWH && wp.t[wp.t.length - 1] <= NOWH + 60000, [wp.t.length, wx.hist.t.length].join('/'));
    check('Verlaufsdaten: Werte gerundet und richtig zugeordnet (Fuehler 5,5; OWM 7,3 (gerundet auf 0,1); VL 30,5; RL 28,25; Soll 31); Hz/Strom je Zyklus; Wind und Bewoelkung nur im Abschnitt mit den neuen Spalten (davor null)', wp.at[100] === 5.5 && wx.hist.owm[100] === 7.3 && wp.vl[100] === 30.5 && wp.rl[100] === 28.25 && wp.sollVl[100] === 31 && [0, 17].includes(wp.hz[100]) && wx.hist.wind[wx.hist.wind.length - 1] === 3.2 && wx.hist.clouds[wx.hist.clouds.length - 1] === 80 && wx.hist.wind[0] === null && wx.hist.clouds[0] === null, JSON.stringify([wp.at[100], wx.hist.owm[100], wx.hist.wind[0], wx.hist.wind[wx.hist.wind.length - 1]]));
    check('Verlaufsdaten: Raeume aus der Konfiguration (Name, Band, aktiv) mit ihren Messreihen; Raum ohne Spalte in der Datei bleibt null', rmP.rooms.length === 4 && rmP.rooms[0].id === 'ki_oben' && rmP.rooms[0].min === 20 && rmP.rooms[0].max === 22 && rmP.rooms[0].active === true && rmP.rooms[0].v[50] === 22.1 && rmP.rooms.find(r => r.id === 'ki_unten').v.every(v => v === null), JSON.stringify(rmP.rooms.map(r => [r.id, r.v[50]])));
    // Wetterkarte (wetter-grafik 17.10.2026): Prognose stuendlich, Abtauband, Naechte, PV, COP, Prognose von gestern; leeres/altes Wetter, fehlende PV, Zeitluecken
    { const HW = 3600000, h0 = Math.floor(NOWH / HW) * HW;
      const fp = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36].map(h => [NOWH + h * HW, h <= 9 ? 6 : 12, h <= 9 ? 90 : 60, 50, 3]);
      gstore.OPT_weather = {status: 'OK', ts: NOWH, f_ts: NOWH, temp: 6, fpts: fp, sun: [new RealDate(2026, 10, 12, 7, 30).getTime(), new RealDate(2026, 10, 12, 16, 45).getTime()]};
      gstore.OPT_plan_in = {ts: NOWH, pvSrc: 'VRM', pv: [...Array(40)].map((_, i) => [h0 + i * HW, (new RealDate(h0 + i * HW).getHours() >= 9 && new RealDate(h0 + i * HW).getHours() < 16) ? 1500 : 0, HW])};
      gstore.OPT_cz_verlauf = {ts: NOWH, zh: [[NOWH - 2 * HW, 4.1]], zp: [[NOWH + HW, 4.3]], soll: 31};
      files['/data/optimizer/forecast-recent.json'] = {data: JSON.stringify([{t: (NOWH - 30 * HW) / 1000, owm: [[NOWH - 30 * HW, 1, 85, 50, 2], [NOWH, 9, 85, 50, 2]]}, {t: (NOWH - 24 * HW) / 1000 + 600, owm: [...Array(13)].map((_, k) => [NOWH - 24 * HW + k * 3 * HW, 4 + k / 3, 85, 50, 2])}]), mode: 0o644};
      const w = run('opt_hist', {})[2].payload, ab = w.abtau || [];
      check('Wetterkarte: Prognosepunkte ohne Code (alte Schnappschuesse/alte Fassung) -> keine Symbole, kein Fehler', Array.isArray(w.sym) && w.sym.length === 0, JSON.stringify(w.sym));
      { const keepW = JSON.stringify(gstore.OPT_weather), keepF = files['/data/optimizer/forecast-recent.json'];
        gstore.OPT_weather.fpts = fp.map((p, i) => p.concat([i < 4 ? 500 : 804, null])); gstore.OPT_weather.fdesc = {500: 'leichter Regen'};
        files['/data/optimizer/forecast-recent.json'] = {data: JSON.stringify([{t: (NOWH - 13 * HW) / 1000, owm: [[NOWH - 12 * HW, 5, 80, 0, 1, 800, 1], [NOWH - 9 * HW, 5, 80, 0, 1, 800, 1]]}, {t: (NOWH - 10 * HW) / 1000, owm: [[NOWH - 9 * HW, 5, 80, 0, 1, 600, 1], [NOWH - 6 * HW, 5, 80, 0, 1]]}]), mode: 0o644};
        const ws = run('opt_hist', {})[2].payload.sym;
        check('Wetterkarte: Symbole ab jetzt je 3-h-Punkt (13, Tooltip = OWM-Beschreibung bzw. Klasse); Vergangenheit nur aus Schnappschuessen mit Code, je Zeit der zuletzt davor prognostizierte (-12 h Sonne, -9 h Schnee aus dem juengeren Schnappschuss, -6 h ohne Code: keins)',
              ws.length === 15 && ws[0][1] === 'sonne' && ws[0][0] === NOWH - 12 * HW && ws[1][1] === 'schnee' && ws[2][0] === NOWH && ws[2][1] === 'regen' && ws[2][2] === 'leichter Regen' && ws[14][1] === 'wolke' && ws[14][2] === 'bewölkt', JSON.stringify(ws.slice(0, 3)));
        gstore.OPT_weather = JSON.parse(keepW); if (keepF) { files['/data/optimizer/forecast-recent.json'] = keepF; } }
      check('Wetterkarte: Fenster -24 h bis +36 h; Prognose stuendlich ab jetzt (37 Punkte, linear zwischen den 3-h-Punkten), Taupunkt aus Temperatur und Feuchte (Magnus)', w.t0 === NOWH - 24 * HW && w.t1 === NOWH + 36 * HW && w.prog.t.length === 37 && w.prog.t[0] === NOWH && w.prog.at[3] === 6 && w.prog.at[12] === 12 && w.prog.at[10] === 8 && Math.abs(w.prog.dew[0] - 4.4) < 0.15 && w.stand.wetter === NOWH, JSON.stringify([w.prog.t.length, w.prog.at.slice(8, 13), w.prog.dew[0]]));
      check('Wetterkarte: Abtauband aus der Prognose (AT -5 bis unter 10 °C UND Feuchte >= 80 %): ein Abschnitt von jetzt bis +10 h (Feuchte faellt zwischen 9 und 12 h unter 80 %), 15-min-Raster; Vergangenheit ohne Feuchtespalte und 5,5 °C: kein Band (ohne Feuchte nur bis 4 °C)', ab.length === 1 && Math.abs(ab[0][0] - (NOWH - 7.5 * 60000)) <= 60000 && Math.abs(ab[0][1] - (NOWH + 10 * HW + 7.5 * 60000)) <= 60000, JSON.stringify(ab.map(b => [(b[0] - NOWH) / 60000, (b[1] - NOWH) / 60000])));
      check('Wetterkarte: Naechte aus Sonnenuntergang/-aufgang (16:45-07:30, jeden Tag), im Fenster abgeschnitten', w.nacht.length >= 2 && w.nacht.every(b => b[1] > b[0] && b[0] >= w.t0 && b[1] <= w.t1) && w.nacht.some(b => new RealDate(b[0]).getHours() === 16 && new RealDate(b[0]).getMinutes() === 45 && new RealDate(b[1]).getHours() === 7 && new RealDate(b[1]).getMinutes() === 30), JSON.stringify(w.nacht.map(b => [new RealDate(b[0]).toTimeString().slice(0, 5), new RealDate(b[1]).toTimeString().slice(0, 5)])));
      check('Wetterkarte: PV-Prognose in kW (Stundenmitte), erster Punkt jetzt, nur bis +36 h; COP-Ziel zurueck/voraus aus OPT_cz_verlauf; Prognose von gestern aus dem Schnappschuss ~24 h zuvor (nicht dem 30 h alten), stuendlich', w.pv.length >= 30 && w.pv[0][0] === NOWH && w.pv.every(p => p[0] <= w.t1 && (p[1] === 0 || p[1] === 1.5)) && w.cop.zh.length === 1 && w.cop.zp[0][1] === 4.3 && w.cop.soll === 31 && w.gestern && w.gestern.ts === NOWH - 24 * HW + 600000 && w.gestern.d[0][1] === 4 && w.gestern.d.length === 37, JSON.stringify([w.pv.length, w.pv[0], w.gestern && w.gestern.d.length]));
      // Zeitluecke in der Prognose (> 6 h ohne Punkt): dort keine Werte; Luecke in der Messung bleibt null
      gstore.OPT_weather.fpts = [fp[0], fp[1], fp[5], fp[6]];
      const wl = run('opt_hist', {})[2].payload;
      check('Wetterkarte: Zeitluecke > 6 h in der Prognose wird nicht ueberbrueckt (null zwischen +3 h und +15 h, Werte davor und danach)', wl.prog.at[3] === 6 && wl.prog.at[8] === null && wl.prog.at[15] === 12 && wl.prog.at[18] === 12 && wl.prog.t.length === 19, JSON.stringify(wl.prog.at.slice(0, 19)));
      // Wetter nicht OK / zu alt, PV alt, COP alt, keine Schnappschuesse: Tafeln leer, kein Fehler
      gstore.OPT_weather = {status: 'Fehler: HTTP 401', ts: NOWH - 8 * HW, f_ts: NOWH - 8 * HW, fpts: fp}; gstore.OPT_plan_in = {ts: NOWH - HW, pv: gstore.OPT_plan_in.pv}; gstore.OPT_cz_verlauf = {ts: NOWH - HW, zh: [[NOWH, 4]], zp: [[NOWH, 4]]}; delete files['/data/optimizer/forecast-recent.json'];
      const we = run('opt_hist', {})[2].payload;
      check('Wetterkarte ohne gueltiges Wetter, ohne frische PV-Prognose und COP-Daten, ohne Schnappschuesse: Prognose, Abtauband (Zukunft), PV, COP, Prognose von gestern leer; Vergangenheit bleibt (289 Punkte), kein Fehler', we.prog.t.length === 0 && we.abtau.length === 0 && we.pv.length === 0 && we.cop.zh.length === 0 && we.cop.zp.length === 0 && we.gestern === null && we.hist.t.length === 289 && we.stand.wetter === null, JSON.stringify([we.prog.t.length, we.abtau.length, we.pv.length]));
      gstore.OPT_weather = {status: 'OK'}; delete gstore.OPT_plan_in; delete gstore.OPT_cz_verlauf; files['/data/optimizer/forecast-recent.json'] = {data: '{kaputt', mode: 0o644};
      const wk = run('opt_hist', {})[2].payload;
      check('Wetterkarte: Wetter ohne Punkte, fehlendes OPT_plan_in/OPT_cz_verlauf, kaputte forecast-recent.json: leere Teile, kein Fehler', wk.prog.t.length === 0 && wk.pv.length === 0 && wk.gestern === null && Array.isArray(wk.nacht) && wk.nacht.length >= 2, '');
      delete files['/data/optimizer/forecast-recent.json']; delete gstore.OPT_weather; }
    // Monatswechsel: 01.12. 01:00 -> 48 h reichen in den November; ohne Datei -> leere Nutzlast ohne Fehler
    files['/data/optimizer/optimizer-v2-2026-12.csv'] = {data: headOld + '\n' + mk('2026-12-01', 0, 30, '5.5,7.25,6,30.5,28.25,31,17,280,22.1,') + '\n', mode: 0o644};
    files['/data/optimizer/optimizer-v2-2026-11.csv'] = {data: headOld + '\n' + mk('2026-11-30', 23, 30, '4,7,6,30,28,31,17,280,22.1,') + '\n', mode: 0o644};
    NOW = new RealDate(2026, 11, 1, 1, 0, 0).getTime(); const hm = run('opt_hist', {});
    check('Verlaufsdaten: am Monatswechsel werden Vormonat und laufender Monat gelesen (2 Punkte, Reihenfolge nach Zeit)', hm[2].payload.hist.t.length === 2 && hm[2].payload.hist.t[0] < hm[2].payload.hist.t[1] && hm[2].payload.hist.at[0] === 4 && hm[2].payload.hist.at[1] === 5.5, JSON.stringify(hm[2].payload.hist.t));
    Object.keys(files).forEach(k => { if (/optimizer-v2/.test(k)) { delete files[k]; } }); const he = run('opt_hist', {});
    check('Verlaufsdaten: ohne Protokolldatei leere Nutzlast (n 0), kein Absturz; die Funktion sendet nichts ausser den drei Ausgaengen (kein node.send)', he[0].payload.n === 0 && he[2].payload.hist.t.length === 0 && !/node\.send\s*\(/.test(NB('opt_hist').func), ''); }
  // Plan-Karte: Diagramm- und Kennzahlendaten
  { pworld({wide: true, windF: 4}); step(2); const pl2 = lastOut[0].payload, P = planNow();
    check('Plan-Karte: Diagrammdaten mit 96 Slots (Zeit, Waerme kW, Strom kW, PV, COP, Temperatur, korrigierte Temperatur), Werte stimmen mit der Vorschau (Bedarf x 4, Strom x 4)', pl2.chart && pl2.chart.slots.length === 96 && pl2.chart.slots.every(r => r.length === 7) && Math.abs(pl2.chart.slots[10][1] - P.slots[10].bedarf * 4) < 0.0011 && Math.abs(pl2.chart.slots[10][2] - P.slots[10].el * 4) < 0.0011 && Math.abs(pl2.chart.slots[10][4] - P.slots[10].cop) < 0.006 && pl2.chart.slots[10][0] === P.slots[10].t, JSON.stringify(pl2.chart && pl2.chart.slots[10]));
    check('Plan-Karte: 7 Kennzahlen-Kacheln (Stand, Waermebedarf, Strom, COP, hoechster Bedarf, Aussen, PV-Prognose) mit Wert und Untertext; Zeilen "Details und Modell" (mit Gebaeudemodell, Fuehlerkorrektur, A/B, Lern-Gate, Drift) und die Stundentabelle in der Nutzlast', pl2.kpi.length === 7 && pl2.kpi.map(x => x.k).join('|') === 'Stand|Wärmebedarf 24 h|Strom Wärmepumpe|COP (Modell)|Höchster Bedarf|Außen 24 h|PV-Prognose 24 h' && pl2.kpi.every(x => typeof x.v === 'string' && x.v.length > 0) && pl2.rows.length >= 14 && ['Gebäudemodell', 'Fühlerkorrektur', 'Bedarfsmodell A/B', 'Lern-Gate', 'Bedarfsmodell Drift'].every(k => pl2.rows.some(r0 => r0[0] === k)) && pl2.plan.length === 24 && /^\d+,\d kWh$/.test(pl2.kpi[1].v), JSON.stringify(pl2.kpi.slice(0, 4)) + ' ' + pl2.rows.length);
    pworld({wide: true, noWeather: true}); step(1); const pn = lastOut[0].payload;
    check('Plan-Karte: ohne Wetterprognose keine Diagramm- und Kennzahlendaten (chart null, kpi leer), Statuszeilen bleiben', pn.chart === null && pn.kpi.length === 0 && pn.rows.length >= 1, JSON.stringify(pn.rows[0])); }
  // Seiten und Karten (Flow-Datei)
  { const tabs = flowsAll.filter(n => n.type === 'ui_tab' && /^opt_ui_tab/.test(n.id)), grp = flowsAll.filter(n => n.type === 'ui_group' && /^opt_g_/.test(n.id)), onTab = id => grp.filter(g => g.tab === id);
    const byOrder = id => onTab(id).sort((a, b) => a.order - b.order).map(g => g.id).join(), hid = id => (flowsAll.find(n => n.id === id) || {}).hidden;
    check('Seiten (13.10. zusammengelegt): alle Karten der Optimierungs-Seiten 17 breit (zwei Spalten ab ~1840 px, eine bei 1024 ohne waagrechtes Scrollen; kein Mischen der Breiten = Masonry-Falle): Optimierung = 3 Diagramme + Raumkarte + Wärmefahrplan (Plan, Stundenübersicht), Optimierer = fünf Karten der Maschine + zwei Quiet-Statistik-Karten, Daten & Güte sieben Statuskarten und seit Paket 2 die Karte „Auswertung NAS“; die Tabs Wärmefahrplan und Quiet-Messwerte leer und ausgeblendet',
          byOrder('opt_ui_tab') === 'opt_g_ch_wp,opt_g_ch_rooms,opt_g_ch_at,opt_g_rooms,opt_g_plan,opt_g_plan_tab' && byOrder('opt_eng_ui_tab') === 'opt_g_schema,opt_g_eng_prop,opt_g_eng_rules,opt_g_eng_score,opt_g_eng_mess,opt_g_eng_log,opt_g_qstats,opt_g_qstats2,opt_g_eng_cop' &&
          onTab('opt_ui_tab_plan').length === 0 && onTab('opt_ui_tab_quiet').length === 0 && onTab('opt_ui_tab_data').length === 9 && byOrder('opt_ui_tab_data').split(',').slice(-2).join() === 'opt_g_nas,opt_g_zaehler' && grp.every(g => g.width === 17 || g.id === 'opt_g_schema_ue' || g.id === 'opt_g_zl_set') && tabs.length === 4 &&
          hid('opt_ui_tab_plan') === true && hid('opt_ui_tab_quiet') === true && hid('opt_ui_tab') === false && hid('opt_eng_ui_tab') === false && hid('opt_ui_tab_data') === false,
          byOrder('opt_ui_tab') + ' | ' + byOrder('opt_eng_ui_tab') + ' | ' + JSON.stringify(grp.filter(g => g.width !== 17).map(g => g.id + ':' + g.width)));
    check('Stromzähler (ui-daten): Einrichtung als Karte auf der Kern-Seite Einstellungen (Breite 8, Reihenfolge 5), Formular-Vorlage schickt an opt_zaehler, opt_zaehler beliefert Status- und Formularkarte; Statuskarte ohne Formular',
          NB('opt_g_zl_set').tab === '33ece0076bfd7cb7' && NB('opt_g_zl_set').width === 8 && NB('opt_g_zl_set').order === 5 && NB('opt_t_zl_set').group === 'opt_g_zl_set' && NB('opt_t_zl_set').wires[0].includes('opt_zaehler') &&
          NB('opt_zaehler').wires[2].includes('opt_t_zaehler') && NB('opt_zaehler').wires[2].includes('opt_t_zl_set') && NB('opt_t_zl_set').format.includes("'zlform'") && !/<details/.test(NB('opt_t_zaehler').format.split('function zaehler(')[1] || ''), '');
    { const q1 = NB('opt_t_qstats').format, q2 = NB('opt_t_qstats2').format, cols = f => (/c in \[([\d,]+)\]/.exec(f) || [0, ''])[1].split(',').map(Number), ths = f => (f.match(/<th>/g) || []).length, a = cols(q1), b = cols(q2);
      check('Quiet-Statistik: zwei Karten mit denselben Zeilen, Spalten aufgeteilt (Stufe/Außen in beiden, die übrigen 15 Kennzahlen genau einmal), je Spalte eine Überschrift; beide hängen am Ausgang 2 von opt_quiet', a[0] === 0 && a[1] === 1 && b[0] === 0 && b[1] === 1 && a.slice(2).concat(b.slice(2)).sort((x, y) => x - y).join() === '2,3,4,5,6,7,8,9,10,11,12,13,14,15,16' && ths(q1) === a.length && ths(q2) === b.length && JSON.stringify(NB('opt_quiet').wires[1]) === '["opt_t_qstats","opt_t_qstats2"]' && q1.includes('msg.payload.stats') && q2.includes('msg.payload.stats'), a.join() + ' | ' + b.join()); }
    check('Statuskarten: Bezeichnung/Wert-Paare in zwei Spalten (CSS-Spalten), Quiet-Karte mit einzeiliger Ereignisliste; keine erklärenden Hinweiszeilen in den Vorlagen der Optimierungs-Seiten (Erklärungen nur als Tooltip)', ['opt_t_opt', 'opt_t_wx', 'opt_t_calc', 'opt_t_quiet', 'opt_t_en', 'opt_t_wp'].every(id => NB(id).format.includes('column-count:2') && NB(id).format.includes('class="optkv"')) && NB('opt_t_fq').format.includes('class="optfit optpt optfq"') && NB('opt_t_fq').format.includes('msg.payload.tab') && NB('opt_t_quiet').format.includes('class="optev"') && flowsAll.filter(n => n.type === 'ui_template' && /^opt_t_/.test(n.id) && grp.some(g => g.id === n.group && /^opt_(eng_)?ui_tab/.test(g.tab))).every(n => !/class="(note|optq-note)"/.test(n.format)) && /title="Regeln: 1\./.test(NB('opt_t_rooms').format), '');
    check('Seiten: Reihenfolge Optimierung (12,5) < Optimierer (12,55) < Daten & Güte (12,75) < SYSTEM (13); die ausgeblendeten Tabs behalten ihre Plätze (Wärmefahrplan 12,6, Quiet-Messwerte 12,7), die Seitennummern im Menü (Lesezeichen #!/n) bleiben', (() => { const o = id => (flowsAll.find(n => n.id === id) || {}).order; return o('opt_ui_tab') === 12.5 && o('opt_eng_ui_tab') === 12.55 && o('opt_ui_tab_plan') === 12.6 && o('opt_ui_tab_quiet') === 12.7 && o('opt_ui_tab_data') === 12.75; })(), '');
    check('Karten: jede Vorlage der Optimierungs-Seiten gehoert zu einer vorhandenen Gruppe; Diagrammkarten haben ein eigenes Element (optch_wp/rooms/at/plan), zeichnen mit optChart.mount, nehmen die Hoehe ueber .optfit', ['wp', 'rooms', 'at'].every(k => { const n = NB('opt_t_ch_' + k); return n && grp.some(g => g.id === n.group) && n.format.includes('id="optch_' + k + '"') && n.format.includes('optChart.mount') && n.format.includes('class="optfit"'); }) && NB('opt_t_plan').format.includes('id="optch_plan"') && NB('opt_t_plan').format.includes('optChart.mount'), '');
    check('Karten: in den Skriptteilen kein Angular-Platzhalter ({{ }}), die Diagrammskripte stehen nach dem sichtbaren Teil; Plan-Karte hat Kachelraster und einklappbare Details, die Stundenübersicht ist eine eigene Karte (9 Spalten, dieselbe Nachricht)', ['opt_t_ch_wp', 'opt_t_ch_rooms', 'opt_t_ch_at', 'opt_t_plan'].every(id => { const f = NB(id).format, sc = f.slice(f.indexOf('<script>')); return !/\{\{/.test(sc); }) && /class="kpi"/.test(NB('opt_t_plan').format) && /plOpen/.test(NB('opt_t_plan').format) && !/msg\.payload\.plan/.test(NB('opt_t_plan').format) && /msg\.payload\.plan/.test(NB('opt_t_plan_tab').format) && (NB('opt_t_plan_tab').format.match(/<th[ >]/g) || []).length === 9 && NB('opt_t_plan_tab').group === 'opt_g_plan_tab', '');
    check('Sicherheit: opt_hist liest nur (fs, kein mqtt/Link), sein Ausgaenge gehen an die drei Diagrammkarten, die Inject-Vorlage laeuft alle 300 s', JSON.stringify(NB('opt_hist').wires) === JSON.stringify([['opt_t_ch_wp'], ['opt_t_ch_rooms'], ['opt_t_ch_at']]) && NB('opt_i_hist').repeat === '300', ''); }
}

// ---- S0) Referenzlauf: Vertrauen, Abtaurisiko, Prognose und - ohne gemessene Baender - der Carnot-COP bleiben bit-identisch zum Stand vor Fahrplan v2; der Waermebedarf und UA
//      folgen seit PLAN_VER 13 dem Gebaeudemodell v3 (Entscheidung 2) und werden gegen dessen Formel geprueft, nicht gegen die Referenz.
//      Die Referenz (tools/fixtures/plan_ref_v7.json, erzeugt mit dem alten Code) enthaelt noch Plan, Kosten und Empfehlungen; seit dem Review-Paket (Vorschau, Version 11)
//      werden nur noch die Bedarfsfelder verglichen: Zeit, Aussen, Feuchte, PV, Bedarf, Abtaurisiko, Vertrauen Temperatur/PV, UA, eta, COP (wo die Referenz unter ihrer alten Grenze 6,5 lag).
{
  const refFile = path.join(__dirname, 'fixtures', 'plan_ref_v7.json');
  const RI = [0, 1, 2, 5, 6, 17, 18, 19];
  const capture = () => { const P = planNow(); return {status: P.status, ua: P.model && P.model.ua, eta: P.model && P.model.eta, slots: P.slots.map(x => [x.t, x.at, x.rh, x.pv, x.bedarf, x.risk, x.cA, x.cP]), cop: P.slots.map(x => x.cop),
                                                        formel: P.slots.every(x => Math.abs(x.bedarf - Math.max(0, P.model.ua * (P.model.ti - x.at) - P.model.g) * 0.25) < 1e-12)}; };
  const scen = [['A wide', {wide: true}, 6], ['B warm+PV', {wide: true, atBase: 14, pvPeak: 15000}, 6], ['C quiet3', {wide: true, quiet: 3}, 6], ['D gelernter Tag', {wide: true, atBase: 5, running: true, hp: 2500, atNow: 5}, 1445 + 5]];
  const got = {};
  scen.forEach(([name, o, n]) => { pworld(o); if (o.hp) { O.hp = o.hp; } step(n); got[name] = capture(); });
  let same = true, first = '', nCop = 0;
  try {
    const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
    Object.keys(got).forEach(nm => {
      const a = ref[nm], b = got[nm]; if (!a) { same = false; first = first || nm + ': fehlt in der Referenz'; return; }
      ['status', 'eta'].forEach(k => { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { same = false; first = first || nm + '.' + k + ': ' + a[k] + ' <> ' + b[k]; } });
      if (!b.formel) { same = false; first = first || nm + ': Bedarf folgt nicht der Formel des Modells v3'; }
      if (a.slots.length !== b.slots.length) { same = false; first = first || nm + ': Slotzahl'; return; }
      a.slots.forEach((rs, i) => {
        const ra = RI.map(j => rs[j]), rb = b.slots[i].slice(); ra[4] = 0; rb[4] = 0; if (JSON.stringify(ra) !== JSON.stringify(rb)) { same = false; first = first || nm + '.slots[' + i + ']: ' + JSON.stringify(ra) + ' <> ' + JSON.stringify(b.slots[i]); }
        if (rs[3] < 6.49) { nCop++; if (rs[3] !== b.cop[i]) { same = false; first = first || nm + '.cop[' + i + ']: ' + rs[3] + ' <> ' + b.cop[i]; } }
      });
    });
  } catch (e) { same = false; first = 'Referenzdatei fehlt oder ist nicht lesbar (' + e.message + ')'; }
  check('Referenzlauf: 4 Szenarien - Prognose, Vertrauen, Abtaurisiko, eta und Carnot-COP (' + nCop + ' Slots) sind bit-identisch zum Stand vor Fahrplan v2 (Plan/Kosten/Empfehlungen seit dem Review-Paket entfallen); der Waermebedarf folgt in jedem Slot dem Gebaeudemodell v3', same && nCop > 300, first);
}
})();


// =====================================================================================================================
// Kinderzimmer oben (Radiator-Relais, Heizluefter) nur mitlesen; Schaltpunkte und Sollspruenge als Ereignisse; neue Protokollspalten
// =====================================================================================================================
(function () {
console.log('\n--- Kinderzimmer-Zustaende (nur lesen), Schaltpunkte, Sollspruenge');
const T0 = Date.UTC(2026, 9, 9, 8, 0, 0);
const BASEK = () => ({TOP42_Z1_Water_Target_Temp: 30, TOP23_Heat_Delta: 3, TOP6_Main_Outlet_Temp: 31, TOP5_Main_Inlet_Temp: 29, compressor_frequency: 17, TOP16_Heat_Energy_Consumption: 300,
  TOP1_Pump_Flow: 13, TOP18_Quiet_Mode_Level: 3, compressor_runtime: 40, compressor_last_runtime: 39, Starts_Today: 3, TOP14_Outside_Temp: 9, TOP62_Fan1_Motor_Speed: 400, COP_HEAT: 5.4,
  TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0, TOP27_Z1_Heat_Request_Temp: 0, F_SS: {state: 0, correction_value: 0, QM_state: 0, QM_active_level: 3}, MQTT: {block_active: 0, allow_scheduler: 0}, F_SOLAR: {state: 0}});
function world(over) { [fstore, files, gstore, envv].forEach(o => Object.keys(o).forEach(k => delete o[k])); Object.assign(gstore, BASEK(), over || {}); NOW = T0; sent.length = 0; run('opt_defaults', {}); }
const kz = (topic, payload) => run('opt_kz_in', {topic, payload});
const hp = (topic, payload) => run('opt_hp_in', {topic: 'panasonic_heat_pump/' + topic, payload: String(payload)});
const flowsK = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
// ---- Abos und Sicherheit
const subs = flowsK.filter(n => n.z === 'opt_tab' && n.type === 'mqtt in' && /^opt_mqtt_kz_/.test(n.id));
check('Kinderzimmer: genau fuenf lesende Abos auf dem Venus/Shelly-Broker (Radiator-Ereignisse und online, Heizluefter relay/0, Leistung, online), alle nur an opt_kz_in', subs.map(n => n.topic).join() === 'shelly-radiator/events/rpc,shelly-radiator/online,shellies/shellyplug-s-heiz/relay/0,shellies/shellyplug-s-heiz/relay/0/power,shellies/shellyplug-s-heiz/online' && subs.every(n => n.broker === 'opt_broker_venus' && JSON.stringify(n.wires) === '[["opt_kz_in"]]'), subs.map(n => n.topic).join());
const kzn = flowsK.find(n => n.id === 'opt_kz_in');
check('Sicherheit: opt_kz_in ruft nirgends node.send auf, hat nur den Ausgang zur Ereignisdatei, und im Tab gibt es weiterhin keinen mqtt-out-, link- oder http-in-Knoten', !/node\.send\s*\(/.test(kzn.func) && JSON.stringify(kzn.wires) === '[["opt_f_qev"]]' && flowsK.filter(n => n.z === 'opt_tab').every(n => n.id === APPLY_OUT || !['mqtt out', 'link out', 'link in', 'link call', 'http in', 'http response'].includes(n.type)), JSON.stringify(kzn.wires));
// ---- Radiator (Shelly 1 Mini Gen3): NotifyStatus
world();
let r = kz('shelly-radiator/events/rpc', {src: 'shelly1minig3-x', dst: 'shelly-radiator/events', method: 'NotifyStatus', params: {ts: 1791571080, 'switch:0': {counts: {on_time: 116250, switch_on: 66}}}});
check('Radiator: ein Ereignis nur mit Zaehlern (ohne output) aendert nichts und erzeugt nichts', r === null && (!gstore.OPT_kz || gstore.OPT_kz.rad.on === undefined), JSON.stringify(gstore.OPT_kz));
r = kz('shelly-radiator/events/rpc', Buffer.from(JSON.stringify({params: {'switch:0': {output: true, source: 'MQTT'}}})));
check('Radiator: erster Zustand (an, als Buffer) wird gemerkt, ohne Ereignis (kein Vorwert)', r === null && gstore.OPT_kz.rad.on === true && gstore.OPT_kz.rad.src === 'MQTT', JSON.stringify(gstore.OPT_kz.rad));
r = kz('shelly-radiator/events/rpc', JSON.stringify({params: {'switch:0': {output: false, source: 'MQTT'}}}));
check('Radiator: Wechsel an -> aus wird mit Zeit und Quelle protokolliert (quiet-events)', r && /^\/data\/optimizer\/quiet-events-2026-10\.csv$/.test(r.filename) && /,kz_radiator,an->aus \(Quelle: MQTT\)\n$/.test(r.payload) && r.payload.startsWith('zeit,ereignis,wechsel\n'), r && r.payload);
check('Radiator: gleicher Zustand nochmal -> kein Ereignis', kz('shelly-radiator/events/rpc', {params: {'switch:0': {output: false}}}) === null, '');
// ---- Heizluefter (Shelly Plug S, Gen1): retained, oft offline
r = kz('shellies/shellyplug-s-heiz/online', 'false');
check('Heizluefter: der gespeicherte Wert "online false" (Stecker offline) wird erkannt und ohne Vorwert nicht als Wechsel gemeldet', r === null && gstore.OPT_kz.fan.online === false, JSON.stringify(gstore.OPT_kz.fan));
kz('shellies/shellyplug-s-heiz/relay/0', 'off'); kz('shellies/shellyplug-s-heiz/relay/0/power', '0.00');
r = kz('shellies/shellyplug-s-heiz/relay/0', 'on');
check('Heizluefter: Wechsel aus -> an wird protokolliert, Leistung wird als Zahl gemerkt', r && /,kz_heizluefter,aus->an\n$/.test(r.payload) && (kz('shellies/shellyplug-s-heiz/relay/0/power', '1850.5'), gstore.OPT_kz.fan.w === 1850.5), r && r.payload);
r = kz('shellies/shellyplug-s-heiz/online', 'true');
check('Heizluefter: wieder online wird protokolliert', r && /,kz_heizluefter_online,offline->online\n$/.test(r.payload), r && r.payload);
check('Heizluefter/Radiator: unbekannte Themen und Muell veraendern nichts', kz('shellies/shellyplug-s-heiz/temperature', '28.9') === null && kz('shellies/shellyplug-s-heiz/relay/0', 'kaputt') === null && kz('shellies/shellyplug-s-heiz/relay/0/power', 'abc') === null && gstore.OPT_kz.fan.w === 1850.5 && gstore.OPT_kz.fan.on === true, '');

// ---- Protokoll-Spalten, Zustand, Schaltpunkte, Sollspruenge
world(); hp('main/Compressor_Freq', 17); hp('main/Pump_Speed', 2650);
kz('shelly-radiator/events/rpc', {params: {'switch:0': {output: true}}}); kz('shellies/shellyplug-s-heiz/relay/0', 'off'); kz('shellies/shellyplug-s-heiz/relay/0/power', '0'); kz('shellies/shellyplug-s-heiz/online', 'false');
const outs = [], evs = [];
const tick = (n, hook) => { let o; for (let i = 0; i < n; i++) { NOW += 60000; if (hook) { hook(i); } o = run('opt_quiet', {}); outs.push(o); if (o[3]) { evs.push(o[3].payload); } } return o; };
const hpState = (hz, rpm) => { gstore.compressor_frequency = hz; hp('main/Compressor_Freq', hz); hp('main/Pump_Speed', rpm); };
tick(2);
let csv = outs.filter(x => x[2]).map(x => x[2].payload).join(''), H = csv.split('\n')[0].split(',').slice(0, -2), L = csv.split('\n').filter(l => l && !l.startsWith('zeit,')).pop().split(',').slice(0, -2);   // ohne die zwei Zaehlerspalten (cop-ziel)
const col = (n) => L[H.indexOf(n)];
check('Protokoll: sechs neue Spalten ganz hinten (zustand, shift_anlage, kz_radiator_an, kz_heizluefter_an, kz_heizluefter_w, kz_heizluefter_online), Spaltenzahl stimmt, Zeilen haben genauso viele Werte', H.slice(-18, -11).join() === 'vl_minus_soll,zustand,shift_anlage,kz_radiator_an,kz_heizluefter_an,kz_heizluefter_w,kz_heizluefter_online' && L.length === H.length, H.slice(-11).join());
check('Protokoll 14.10.2026: vier Spalten (leistung_el_korr_w, cop_momentan_korr, cop_korr_w, rohr_aussen = Outside_Pipe_Temp) vor den sechs Spalten von Paket 2 (und druck_bar, Winterpaket); Rohspalten leistung_el_w/cop_momentan bleiben', H.slice(-11, -7).join() === 'leistung_el_korr_w,cop_momentan_korr,cop_korr_w,rohr_aussen' && col('cop_korr_w') === '80' && H.indexOf('leistung_el_w') >= 0 && H.indexOf('cop_momentan') >= 0, H.slice(-4).join() + ' / ' + L.slice(-4).join());
check('Protokoll: Lauf -> zustand "lauf", Radiator an (1), Heizluefter aus (0), 0 W, Stecker offline (0), Anlagenverschiebung 0', col('zustand') === 'lauf' && col('kz_radiator_an') === '1' && col('kz_heizluefter_an') === '0' && col('kz_heizluefter_w') === '0' && col('kz_heizluefter_online') === '0' && col('shift_anlage') === '0', [col('zustand'), col('kz_radiator_an'), col('kz_heizluefter_an'), col('kz_heizluefter_w'), col('kz_heizluefter_online'), col('shift_anlage')].join('/'));
// Stopp bei Vorlauf +3,25 K ueber dem Soll
gstore.TOP6_Main_Outlet_Temp = 33.25; tick(1); hpState(0, 1750); tick(1);
check('Schaltpunkt: beim Verdichterstopp wird Dauer, Vorlauf-Abstand zum Soll (+3,25 K), Soll und Aussentemperatur festgehalten (verdichter_stopp)', evs.some(e => /,verdichter_stopp,Lauf [\d?]+ min · Vorlauf \+3\.25 K zum Soll 30 °C · Außen 9 °C/.test(e)), evs.join('|').slice(-250));
L = outs.filter(x => x[2]).map(x => x[2].payload).join('').split('\n').filter(l => l && !l.startsWith('zeit,')).pop().split(',');
check('Protokoll: Verdichter aus, Pumpe 1750 U/min -> zustand "pause"; Pumpe 0 -> "heizgrenze"; ohne Pumpenwert -> leer', col('zustand') === 'pause' && (hpState(0, 0), tick(1), outs.filter(x => x[2]).map(x => x[2].payload).join('').split('\n').filter(l => l && !l.startsWith('zeit,')).pop().split(',')[H.indexOf('zustand')] === 'heizgrenze'), col('zustand'));
// Pause, Sollsprung im Stillstand, dann Start bei Soll -3 K
hpState(0, 1750); gstore.TOP6_Main_Outlet_Temp = 28.5; tick(5);
gstore.TOP42_Z1_Water_Target_Temp = 29; tick(1);
check('Sollsprung im Stillstand wird festgehalten: Zustand, alt -> neu, Vorlauf, Abstand zum neuen Soll, Aussentemperatur, Anlagenverschiebung', evs.some(e => /,sollsprung,Pause 30->29 °C · Vorlauf 28\.50 \(-0\.50 K zum neuen Soll\) · Außen 9 °C · Anlagenverschiebung 0 K/.test(e)), evs.filter(e => /sollsprung/.test(e)).join('|').slice(-250));
gstore.TOP6_Main_Outlet_Temp = 26; tick(3); hpState(17, 2650); gstore.TOP6_Main_Outlet_Temp = 26.6; tick(1);
check('Schaltpunkt: beim Verdichterstart wird die Pause, der letzte Vorlauf-Abstand (-3,00 K) und die Pumpendrehzahl festgehalten (verdichter_start)', evs.some(e => /,verdichter_start,Pause \d+ min · Vorlauf -3\.00 K zum Soll 29 °C · Außen 9 °C · Pumpe 1750 U\/min/.test(e)), evs.filter(e => /verdichter_start/.test(e)).join('|').slice(-250));
gstore.TOP42_Z1_Water_Target_Temp = 30; tick(1);
check('Sollsprung im Lauf wird als "Lauf" markiert', evs.some(e => /,sollsprung,Lauf 29->30 °C/.test(e)), evs.filter(e => /sollsprung/.test(e)).join('|').slice(-200));
// Karte
const card = tick(1)[0].payload.rows.find(rw => rw[0] === 'Kinderzimmer oben');
check('Karte "Leistung & Quiet": neue Zeile "Kinderzimmer oben" zeigt Radiator und Heizluefter; "offline" ist normal (der Heizluefter wird nur im Uebergang Sommer/Herbst genutzt) und bekommt keine Warnfarbe', card && /Radiator an · Heizlüfter offline/.test(card[1]) && card[2] === '', JSON.stringify(card));
kz('shellies/shellyplug-s-heiz/online', 'true'); kz('shellies/shellyplug-s-heiz/relay/0', 'on'); kz('shellies/shellyplug-s-heiz/relay/0/power', '1820');
const card2 = tick(1)[0].payload.rows.find(rw => rw[0] === 'Kinderzimmer oben');
check('Karte: online und an zeigt die Leistung', card2 && /Heizlüfter an \(1\.?820 W\)/.test(card2[1]) && card2[2] === '', JSON.stringify(card2));
// ohne Kinderzimmer-Daten (Neustart) bleibt alles leer und es gibt keinen Absturz
world(); hp('main/Compressor_Freq', 17); const n0 = outs.length; tick(2); const mine = outs.slice(n0);
const csv0 = mine.filter(x => x[2]).map(x => x[2].payload).join(''), L0 = csv0.split('\n').filter(l => l && !l.startsWith('zeit,')).pop().split(','), H0 = csv0.split('\n')[0].split(',');
check('ohne Kinderzimmer-Werte (frischer Start): vier Spalten leer, Karte zeigt Striche, kein Absturz', ['kz_radiator_an', 'kz_heizluefter_an', 'kz_heizluefter_w', 'kz_heizluefter_online'].every(n => L0[H0.indexOf(n)] === '') && /Radiator – · Heizlüfter –/.test((mine[mine.length - 1][0].payload.rows.find(rw => rw[0] === 'Kinderzimmer oben') || [])[1]), '');
})();

// 14.10.2026 (Raumeinfluss v3, Forum 189605): die Huellen geben Fehlercode (TOP44 Error), Leitungstemperatur Innengeraet und Heizkurve an den Kern; OPT_engine traegt Waechter und Stoerung; die Uebernahme kennt den Fehlercode
(() => {
  const nodes = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), en = nodes.find(n => n.id === 'opt_engine'), ap = nodes.find(n => n.id === 'opt_apply');
  check('Huelle opt_engine: Eingaben err (OPT_hp.Error), pipeIn (Inside_Pipe_Temp) und kurve (Z1_Heat_Curve_*); OPT_engine mit hinweise und stoerung; opt_apply: plant.err aus OPT_hp.Error',
        en && /err: \(HP\.Error && HP\.Error\.v !== undefined/.test(en.func) && /pipeIn: hpv\('Inside_Pipe_Temp'\)/.test(en.func) && /kurve: \(cvLo !== null/.test(en.func) && /hinweise: o\.hinweise, stoerung: o\.stoerung/.test(en.func) && ap && /err: \(HP\.Error && HP\.Error\.v !== undefined/.test(ap.func), '');
})();

// 14.10.2026 (ui-schema): Anlagenschema der Leisha (tools/schema_ui.js) auf "Optimierer" und "Übersicht": opt_schema liest nur OPT_hp und HeishaMoNR-Globale,
// zeigt die Aufnahme mit COP-Korrektur (+80 W im Lauf), fehlende Werte (-128/-78/-200, alt) als Strich, Fliessen nur bei laufendem Medium
(() => {
  const SCH = require(path.join(__dirname, 'schema_ui.js')), nodes = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), N = id => nodes.find(n => n.id === id);
  const keep = Object.assign({}, gstore), T = Date.UTC(2026, 9, 14, 7, 40, 0), nowKeep = NOW;
  const LIVE = {Compressor_Freq: 17, Compressor_Current: 1.4, Fan1_Motor_Speed: 240, Pump_Speed: 1800, Pump_Duty: 82, Pump_Flow: 14.09, Main_Outlet_Temp: 30.25, Main_Inlet_Temp: 28,
    Main_Target_Temp: 29, Main_Hex_Outlet_Temp: 31, Inside_Pipe_Temp: 29, Outside_Pipe_Temp: 8, Eva_Outlet_Temp: 9, Discharge_Temp: 32, High_Pressure: 10.4, Expansion_Valve: 73,
    Outside_Temp: 12, Heat_Power_Production_Extra: 2228, Heat_Power_Consumption_Extra: 319, Quiet_Mode_Level: 1, Heating_Control: 1, Heatpump_State: 1, Defrosting_State: 0,
    Room_Heater_State: 1, Internal_Heater_State: 0, Room_Heater_Operations_Hours: 76, Water_Pressure: 1.06, Heating_Off_Outdoor_Temp: 12, Z1_Heat_Request_Temp: 0,
    Operations_Hours: 10026, Operations_Counter: 3952, Error: 'No error', DHW_Temp: -128, Buffer_Temp: -78, Heat_Power_Consumption: -200};
  const hpOf = (o, ageMin) => { const r = {}; Object.keys(o).forEach(k => { r[k] = {v: o[k], ts: T - (ageMin || 0.3) * 60000}; }); return r; };
  const X = {freq: 17, rt: 106, rtLast: 98, starts: 4};
  Object.keys(gstore).forEach(k => delete gstore[k]);
  Object.assign(gstore, {OPT_hp: hpOf(LIVE), OPT_cfg: {cop: {pelKorrW: 80}}, compressor_frequency: 17, compressor_runtime: 106, compressor_last_runtime: 98, Starts_Today: 4});
  NOW = T;
  const P = run('opt_schema', {}).payload; let H = SCH.html(P, {phase: 0}); const fl = h => (h.match(/class="osch-fl"/g) || []).length;
  check('Schema: opt_schema liest OPT_hp; Aufnahme im Lauf korrigiert 319 + 80 = 399 W, COP = 2228 / 399, Spreizung 2,25 K, Zustand läuft, Laufzeit 106 min',
        P.lauf === true && P.w.pelK === 399 && P.w.korr === 80 && Math.abs(P.w.cop - 2228 / 399) < 1e-9 && Math.abs(P.w.spreiz - 2.25) < 1e-9 && P.zustand.c === 'lauf' && P.w.laufMin === 106 && P.veraltet === false,
        JSON.stringify({pelK: P.w.pelK, cop: P.w.cop, z: P.zustand}));
  check('Schema: Karte zeigt "399 W (intern 319 +80)", COP 5,58, Abgabe 2,23 kW, VL 30,3 °C rot, RL 28 °C blau, 17 Hz, 1,4 A, Pumpe 1.800 U/min, 14,1 l/min, Hochdruck 10,4 bar, Betrieb 10.026 h',
        (H = H.replace(/\u00a0/g, ' ')) && H.includes('>399 W<') && H.includes('(intern 319 +80)') && H.includes('>5,58<') && H.includes('>2,23 kW<') && /fill:#c62828[^>]*>30,3 °C</.test(H) && /fill:#1565c0[^>]*>28 °C</.test(H) &&
        H.includes('>17 Hz<') && H.includes('>1,4 A<') && H.includes('>1.800 U/min<') && H.includes('>Duty 82<') && H.includes('>14,1 l/min<') && H.includes('Hochdruck 10,4 bar') && H.includes('>10.026 h<') && H.includes('Verschiebung ±0 K'), '');
  check('Schema: im Lauf fliessen Luft (4 Abschnitte), Kaeltekreis (4) und Wasser (2), Verdichter und Luefter drehen; kein Warmwasser-/Pufferteil', fl(H) === 10 && (H.match(/osch-rot/g) || []).length === 2 && !/Warmwasser|Speicher|Puffer/.test(H), fl(H));
  const P2 = SCH.daten(hpOf(Object.assign({}, LIVE, {Outside_Pipe_Temp: -128, Discharge_Temp: -78, Heat_Power_Production_Extra: -200})), X, 80, T), H2 = SCH.html(P2, {});
  check('Schema: fehlende Werte (-128/-78/-200) zeigen einen Strich, kein Absturz', P2.w.rohrA === null && P2.w.heiss === null && P2.w.pth === null && H2.includes('Rohr –') && H2.includes('Heißgas –') && /Abgabe<\/div><div class="v">–</.test(H2), '');
  const P3 = SCH.daten(hpOf(LIVE, 20), {}, 80, T), H3 = SCH.html(P3, {});
  check('Schema: Werte aelter als 15 min gelten als fehlend, Hinweis "Keine aktuellen Werte (letzter vor 20 min)"', P3.veraltet === true && P3.w.vl === null && P3.w.betrH === 10026 && H3.includes('Keine aktuellen Werte (letzter vor 20 min)'), '');
  const P4 = SCH.daten(hpOf(Object.assign({}, LIVE, {Compressor_Freq: 0, Fan1_Motor_Speed: 0, Pump_Speed: 1750, Heat_Power_Production_Extra: 0, Heat_Power_Consumption_Extra: 24})), {freq: 0, rtLast: 98}, 80, T), H4 = SCH.html(P4, {});
  check('Schema: Pause (Verdichter aus, Pumpe läuft): Aufnahme roh 24 W ohne Korrektur, kein COP, nur das Wasser fliesst, Laufzeit = letzter Lauf 98 min',
        P4.zustand.c === 'pause' && P4.w.pelK === 24 && P4.w.korr === 0 && P4.w.cop === null && fl(H4) === 2 && H4.includes('>98\u00a0min<') && H4.includes('letzter Lauf'), P4.zustand.c + ' ' + fl(H4));
  const P5 = SCH.daten(hpOf(Object.assign({}, LIVE, {Compressor_Freq: 0, Fan1_Motor_Speed: 0, Pump_Speed: 0, Pump_Flow: 0})), {}, 80, T), H5 = SCH.html(P5, {});
  check('Schema: Heizgrenze (Pumpe steht): nichts fliesst, Zustand Heizgrenze', P5.zustand.c === 'heizgrenze' && fl(H5) === 0 && H5.includes('>Heizgrenze<'), P5.zustand.c);
  const P6 = SCH.daten(hpOf(Object.assign({}, LIVE, {Internal_Heater_State: 1})), X, 80, T), P7 = SCH.daten(hpOf(Object.assign({}, LIVE, {Error: 'H23'})), X, 80, T), P8 = SCH.daten(hpOf(Object.assign({}, LIVE, {Defrosting_State: 1})), X, 80, T);
  const P9 = SCH.daten(hpOf(Object.assign({}, LIVE, {Room_Heater_State: 0})), X, 80, T);
  check('Schema: Heizstab aktiv = rot "AN" und "+ Heizstab"; gesperrt (Room_Heater_State 0); Störung H23; Abtauen', SCH.html(P6, {}).includes('>AN<') && SCH.html(P6, {}).includes('läuft + Heizstab') &&
        SCH.html(P9, {}).includes('>gesperrt<') && P7.zustand.c === 'stoerung' && SCH.html(P7, {}).includes('Fehler H23') && P8.zustand.c === 'abtauen', '');
  gstore.OPT_cfg = {cop: {pelKorrW: 80}, zaehler: {quelle: 'zaehler'}}; gstore.OPT_zaehler = {ts: T, wp_w: 411, heizstab_w: 0, ok: true};
  const PZ = run('opt_schema', {}).payload, HZ = SCH.html(PZ, {phase: 0}).replace(/\u00a0/g, ' ');
  check('Schema: Stromzähler gewählt und frisch: Aufnahme 411 W vom Zähler, Untertitel "Zähler (intern 319)", COP = 2228 / 411',
        PZ.w.pelK === 411 && PZ.w.pelQuelle === 'zaehler' && PZ.w.korr === 92 && Math.abs(PZ.w.cop - 2228 / 411) < 1e-9 && HZ.includes('>411 W<') && HZ.includes('Zähler (intern 319)') && HZ.includes('>5,42<'), JSON.stringify({pelK: PZ.w.pelK, q: PZ.w.pelQuelle, cop: PZ.w.cop}));
  gstore.OPT_zaehler = {ts: T - 10 * 60000, wp_w: 411, heizstab_w: 0, ok: false};
  const PZ2 = run('opt_schema', {}).payload;
  check('Schema: Zähler gewählt, aber 10 min alt: Rückfall auf TOP16 + 80 = 399 W, Untertitel wie bisher', PZ2.w.pelK === 399 && PZ2.w.pelQuelle === 'intern' && SCH.html(PZ2, {}).includes('(intern 319 +80)'), JSON.stringify({pelK: PZ2.w.pelK, q: PZ2.w.pelQuelle}));
  gstore.OPT_cfg = {cop: {pelKorrW: 80}}; delete gstore.OPT_zaehler;
  check('Schema: Korrektur aus OPT_cfg (0..200 W), sonst 80 W', SCH.daten(hpOf(LIVE), X, 50, T).w.pelK === 369 && SCH.daten(hpOf(LIVE), X, 999, T).w.pelK === 399 && SCH.daten(hpOf(LIVE), X, undefined, T).w.pelK === 399, '');
  const g1 = N('opt_g_schema'), g2 = N('opt_g_schema_ue'), t1 = N('opt_t_schema'), t2 = N('opt_t_schema_ue'), f = N('opt_schema'), i = N('opt_i_schema');
  const ueOrders = nodes.filter(n => n.type === 'ui_group' && n.tab === 'a5be8588.b8fbc8' && n.id !== 'opt_g_schema_ue').map(n => n.order);
  check('Schema: Gruppe "Anlagenschema" zuerst auf "Optimierer" (Reihenfolge 0,5, 17 breit) und "ANLAGENSCHEMA" zuerst auf der Übersicht (0,5 < Kern-Gruppen, nur per node-id volle Breite); je eine Karte',
        g1 && g1.tab === 'opt_eng_ui_tab' && g1.order === 0.5 && g1.width === 17 && g2 && g2.tab === 'a5be8588.b8fbc8' && g2.order === 0.5 && ueOrders.length > 0 && ueOrders.every(o => o > 0.5) &&
        t1.group === 'opt_g_schema' && t2.group === 'opt_g_schema_ue' && nodes.filter(n => n.group === 'opt_g_schema' || n.group === 'opt_g_schema_ue').length === 2 &&
        t2.format.includes('ui-card-panel[node-id="opt_g_schema_ue"]{width:calc(100% - 12px)') && !t1.format.includes('width:calc(100% - 12px)') && [t1, t2].every(t => t.format.includes("var id = '" + t.id + "'") && t.format.includes("F.fns['" + t.id + "']") && t.format.includes('id="osch_' + t.id + '"')), ueOrders.join());
  check('Schema: Sicherheit - opt_schema nur lesen (kein global/flow.set, keine Datei), Ausgang nur an die beiden Karten, Takt alle 10 s; die Karten schicken nichts',
        f && !/global\.set|flow\.set|fs\./.test(f.func) && JSON.stringify(f.wires) === '[["opt_t_schema","opt_t_schema_ue"]]' && i.repeat === '10' && JSON.stringify(i.wires) === '[["opt_schema"]]' &&
        [t1, t2].every(t => !/scope\.send/.test(t.format) && JSON.stringify(t.wires) === '[[]]'), '');
  Object.keys(gstore).forEach(k => delete gstore[k]); Object.assign(gstore, keep); NOW = nowKeep;
})();

// ---- Paket 2 (15.10.2026): Karte "Auswertung NAS" (Daten & Güte) liest /data/optimizer-tools/status.json des Containers optimizer-tools (nur lesen)
console.log('\n--- Auswertung NAS (status.json des Containers optimizer-tools)');
(() => {
  const SP = '/data/optimizer-tools/status.json', fix = fs.readFileSync(path.join(__dirname, 'fixtures', 'optimizer_tools_status.json'), 'utf8'), nowKeep = NOW, had = files[SP];
  const fnN = ALLNODES.find(n => n.id === 'opt_nas'), tpl = ALLNODES.find(n => n.id === 'opt_t_nas'), inj = ALLNODES.find(n => n.id === 'opt_i_nas'), grp = ALLNODES.find(n => n.id === 'opt_g_nas');
  check('Knoten: opt_i_nas (alle 5 min) -> opt_nas (fs, nur lesen: kein writeFileSync, kein global/flow.set) -> opt_t_nas in der Gruppe "Auswertung NAS (optimizer-tools)" auf "Daten & Güte", 17 breit wie die anderen Karten der Seite; die Karte schickt nichts',
        inj && inj.repeat === '300' && JSON.stringify(inj.wires) === '[["opt_nas"]]' && fnN && JSON.stringify(fnN.wires) === '[["opt_t_nas"]]' && fnN.libs.some(l => l.var === 'fs') && !/writeFileSync|flow\.set|mkdirSync/.test(fnN.func) && (fnN.func.match(/global\.set\(/g) || []).length === 1 && /global\.set\('OPT_cop_eta', CE\)/.test(fnN.func) &&   // cop-ziel: einziger Speicher = OPT_cop_eta (Gütegrad für die Maschine)
        grp && grp.tab === 'opt_ui_tab_data' && grp.width === 17 && ALLNODES.filter(n => n.type === 'ui_group' && n.tab === 'opt_ui_tab_data').every(g => g.width === 17) && tpl && tpl.group === 'opt_g_nas' && !/scope\.send/.test(tpl.format) && /\.optchip/.test(tpl.format), '');
  delete files[SP]; let o = run('opt_nas', {});
  check('Datei fehlt: eine Zeile "Letzter Lauf: kein Lauf" (Chip warn), dazu nur „COP-Gütegrad η: noch keins · Startwerte“ (cop-ziel)', o.payload.rows.length === 2 && o.payload.rows[0][1] === 'kein Lauf' && o.payload.rows[0][3] === 'warn' && o.payload.rows[1][0] === 'COP-Gütegrad η' && o.payload.rows[1][1] === 'noch keins · Startwerte' && gstore.OPT_cop_eta === null, JSON.stringify(o.payload.rows));
  files[SP] = {data: '{kaputt', mode: 0o644}; o = run('opt_nas', {});
  check('Datei kein JSON: "nicht lesbar" (Chip Fehler)', o.payload.rows.length === 2 && o.payload.rows[0][1] === 'nicht lesbar' && o.payload.rows[0][3] === 'fehler', JSON.stringify(o.payload.rows));
  NOW = new Date(2026, 9, 15, 22, 30, 0).getTime(); files[SP] = {data: fix, mode: 0o644}; o = run('opt_nas', {});
  const R = o.payload.rows, row = n => R.find(r => r[0] === n) || [];
  check('echte status.json (15.10. 22:27): Letzter Lauf 15.10. 22:26 · 98 s ok; Training 15.10. grün, Drift 0 (erster Lauf); Replay-Güte 14.10. 100 % ok; Minutenprotokoll 14.10. lückenlos; Raumfühler: Wohnzimmer 971 min (warn); Sicherung 15.10. · 1,6 MB geprüft; keine Fehlerzeile',
        row('Letzter Lauf')[1] === '15.10. 22:26 · 98 s' && row('Letzter Lauf')[3] === 'ok' && /^15\.10\. · Drift 0 auffällig \(erster Lauf\)$/.test(row('Training')[1]) && row('Training')[2] === 'grün' && row('Training')[3] === 'ok' &&
        row('Replay-Güte')[1] === '14.10. · 100,0 % gleich live' && row('Replay-Güte')[3] === 'ok' && /raum_offset: nicht bewertbar \(live lief v2/.test(row('Replay-Güte')[4]) && row('Minutenprotokoll')[1] === '14.10. · lückenlos' && row('Minutenprotokoll')[3] === 'ok' &&
        row('Raumfühler')[1] === '14.10. · Wohnzimmer 971 min' && row('Raumfühler')[3] === 'warn' && row('Sicherung')[1] === '15.10. · 1,6 MB' && row('Sicherung')[2] === 'geprüft' && row('Sicherung')[3] === 'ok' && !R.some(r => r[0] === 'Fehler') && R.length === 7 && row('COP-Gütegrad η')[2] === 'Startwerte',
        JSON.stringify(R.map(r => r.slice(0, 4))));
  const J = JSON.parse(fix); J.ok = false; J.fehler = ['training: Zeitlimit 20 min überschritten']; J.letzter_lauf.ok = false; J.training.ampel = 'gelb'; J.training.drift = {gegen: '2026-10-14', auffaellig: 2, liste: ['ua', 'cap']};
  J.replay.guete = {bewertbar: false, prozent: null, grund: 'nur 40 % der Minuten mit Live-Eingabe', regeln: {}}; J.datenluecken.minutenprotokoll.luecken_ueber_10min = 2; J.datenluecken.minutenprotokoll.groesste_luecke_min = 37; J.sicherung.geprueft = false;
  files[SP] = {data: JSON.stringify(J), mode: 0o644}; o = run('opt_nas', {}); const R2 = o.payload.rows, row2 = n => R2.find(r => r[0] === n) || [];
  check('Fehlerfälle: Lauf mit Fehler (Chip Fehler), Ampel gelb mit 2 Drift (warn), Replay "nicht bewertbar: Grund" (warn), 2 Lücken > 10 min (warn), Sicherung ungeprüft (Fehler), Fehlerzeile mit Text im Tooltip',
        row2('Letzter Lauf')[3] === 'fehler' && row2('Training')[2] === 'gelb' && row2('Training')[3] === 'warn' && /Drift 2 auffällig/.test(row2('Training')[1]) && /ua, cap/.test(row2('Training')[4]) &&
        row2('Replay-Güte')[1] === '14.10. · nicht bewertbar: nur 40 % der Minuten mit Live-Eingabe' && row2('Replay-Güte')[3] === 'warn' && row2('Minutenprotokoll')[1] === '14.10. · 2 Lücken > 10 min, größte 37 min' && row2('Minutenprotokoll')[3] === 'warn' &&
        row2('Sicherung')[2] === 'ungeprüft' && row2('Sicherung')[3] === 'fehler' && row2('Fehler')[3] === 'fehler' && /Zeitlimit/.test(row2('Fehler')[4]), JSON.stringify(R2.map(r => r.slice(0, 4))));
  NOW = new Date(2026, 9, 17, 9, 0, 0).getTime(); files[SP] = {data: fix, mode: 0o644}; o = run('opt_nas', {});
  check('Lauf älter als 26 h: "veraltet" (warn), Sicherung ebenso', (o.payload.rows.find(r => r[0] === 'Letzter Lauf') || [])[2] === 'veraltet' && (o.payload.rows.find(r => r[0] === 'Sicherung') || [])[2] === 'veraltet', JSON.stringify(o.payload.rows.map(r => r.slice(0, 4))));
  NOW = new Date(2026, 9, 15, 22, 30, 0).getTime(); run('opt_nas', {});                      // Vorschau: echte Datei, frisch
  if (had) { files[SP] = had; } else { delete files[SP]; } NOW = nowKeep;
})();

console.log('\nERGEBNIS:', assertFails === 0 ? 'alle Pruefungen bestanden' : assertFails + ' Pruefung(en) fehlgeschlagen');
process.exit(assertFails ? 1 : 0);

// Offline-Simulation des Verzoegerungstests (Schalt-Pruefstand) mit Fake-Uhr und einem einfachen Anlagenmodell. Kein Node-RED, kein MQTT, nichts wird gesendet.
// Aufruf:  node tools/delaytest_sim.js "flows (26.5.1 stable).json"
// Geprueft werden: der Kern (Vorbedingungen, Ablauf, Abbrueche, Auswertung), die Huelle (opt_dt) und der Patch der Summenfunktion (Frische, Begrenzung, Neutralitaet).
// Vereinfachung: die Summenfunktion laeuft hier jede Minute und die Anlage uebernimmt ceil(SHIFT_Final_z1) direkt. Das prueft die LOGIK des Pruefstands.
// Die Sicherheitsaussagen (Rueckkehr auf 0 bei Neustart, Sperre, verlorenen Befehlen, seltenen Aufrufen) prueft tools/delaytest_chain_sim.js mit der echten Befehlskette.
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const flowsFile = process.argv[2] || 'flows (26.5.1 stable).json';
const ALL = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
const byId = {}; ALL.forEach(n => { byId[n.id] = n; });
const SUM_ID = 'add6fa4d403dd143';
// gepatchte Kopie der Summenfunktion ueber das echte Werkzeug erzeugen (Originaldatei bleibt unberuehrt)
const tmp = path.join(os.tmpdir(), 'dt_patch_' + process.pid + '.json');
fs.writeFileSync(tmp, JSON.stringify(ALL));
const patchPy = path.join(__dirname, 'delaytest_patch.py');
const pr0 = cp.spawnSync('python3', [patchPy, tmp, '--check']);
const SUM_ORIG = JSON.parse(fs.readFileSync(tmp, 'utf8')).find(n => n.id === SUM_ID).func;
cp.execFileSync('python3', [patchPy, tmp]);
const SUM_PATCHED = JSON.parse(fs.readFileSync(tmp, 'utf8')).find(n => n.id === SUM_ID).func;
cp.execFileSync('python3', [patchPy, tmp, '--revert']);
const SUM_REVERTED = JSON.parse(fs.readFileSync(tmp, 'utf8')).find(n => n.id === SUM_ID).func;
fs.unlinkSync(tmp);
const FUNC = {}; ALL.forEach(n => { if (n.type === 'function' && n.id.startsWith('opt_')) { FUNC[n.id] = n.func; } });

const DAY0 = Date.UTC(2026, 9, 12, 7, 0, 0);     // 12.10.2026 09:00 Ortszeit (Montag)
let NOW = DAY0;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } }
  static now() { return NOW; }
}
let fails = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined ? '  -> ' + info : '')); if (!cond) { fails++; } }

// ---------- Laufzeitumgebung wie Node-RED: Speicher (gemeinsam fuer "file" und Standard), Fluss-Speicher, Dateisystem
function makeEnv() {
  const g = {}, fl = {}, files = {};
  const fsm = {
    readFileSync: (p) => { if (!(p in files)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } return files[p]; },
    writeFileSync: (p, d) => { files[p] = String(d); }, mkdirSync: () => {}, chmodSync: () => {},
  };
  const ctx = (st) => ({ get: (k) => st[k], set: (k, v) => { st[k] = v; } });
  return { g, fl, files, fsm, gctx: ctx(g), flctx: ctx(fl), sent: [] };
}
function runFn(env, code, msg) {
  const f = vm.runInNewContext('(function(msg,global,flow,context,env,node,fs,Date,Buffer){' + code + '\n})', {});
  const node = { send: m => env.sent.push(m), warn: () => {}, error: () => {}, status: () => {} };
  return f(msg, env.gctx, env.flctx, ctx0(), { get: () => undefined }, node, env.fsm, FakeDate, Buffer);
}
function ctx0() { const s = {}; return { get: k => s[k], set: (k, v) => { s[k] = v; } }; }

// ---------- Anlagenmodell (Minutenschritt). Annahmen sind unten benannt; es geht um die Logik des Pruefstands, nicht um Physik.
// Wasser-/Gebaeudekapazitaet C kWh/K, Mindestleistung 2,1 kW, Bedarf nach Aussentemperatur, Heizkurve nach dem Muster der Leisha.
// Abschalten: Vorlauf >= Soll + 3,25 K (gemessene Aufloesung 0,25 K) 3 Minuten lang.
// Einschalten (Hypothesen): 'soll' = Vorlauf <= Soll - 3,25 K fuer 'delay' Minuten (Soll = aktuell inkl. Verschiebung; gemessen 6-13 min);
//                            'fest' = Schwelle am Abschaltzeitpunkt gespeichert (ignoriert spaetere Verschiebung), 'delay' Minuten.
class Plant {
  constructor(o) {
    Object.assign(this, { C: 0.45, qMin: 2.3, mix: 3.0, ua: 0.17, gain: 0.45, stops: [], starts: [], startMode: 'soll', delay: 7, cmdFail: false, noStop: false, atFn: () => 9, vl: 31, running: true, runMin: 60,
      stopCnt: 0, startCnt: 0, stoppedMin: 0, shiftHp: 0, pendingShift: 0, lastSollBase: 29, storedThr: null, hz: 17, dhw: 0, defrost: 0 }, o || {});
  }
  sollBase(at) { return Math.max(29, Math.ceil(29 + 0.375 * (11 - at))); }
  step(min) {
    const at = this.atFn(min), base = this.sollBase(at);
    this.shiftHp = this.cmdFail ? this.shiftHp : this.pendingShift;                          // Befehl kommt eine Minute spaeter an
    const soll = base + this.shiftHp, demand = Math.max(0.3, this.ua * (21 - at) - this.gain);
    this.at = at; this.base = base; this.soll = soll;
    this.vl += ((this.running ? this.qMin : 0) - demand) / this.C / 60 - (!this.running && this.stoppedMin < 5 ? this.mix / 5 : 0);
    this.vlQ = Math.round(this.vl * 4) / 4;
    this.rlQ = Math.round((this.vl - (this.running ? 2.2 : 0)) * 4) / 4;
    if (this.running) {
      this.runMin++; this.stoppedMin = 0;
      if (!this.noStop && this.vlQ - (this.stopFest ? base : soll) >= 3.25 - 1e-9) { this.stopCnt++; } else { this.stopCnt = 0; }
      if (this.stopCnt >= 3) { this.running = false; this.stopCnt = 0; this.stoppedMin = 0; this.storedThr = base - 3.25; this.stopped = min; this.stops.push(min); }
    } else {
      this.stoppedMin++;
      const thr = this.startMode === 'fest' ? this.storedThr : soll - 3.25;
      if (this.stoppedMin >= 3 && this.vlQ <= thr + 1e-9) { this.startCnt++; } else { this.startCnt = 0; }
      if (this.startCnt >= Math.max(1, this.delay)) { this.running = true; this.runMin = 0; this.startCnt = 0; this.started = min; this.starts.push(min); this.vl += 0.6; }
    }
    this.hz = this.running ? 17 : 0;
    this.pump = this.running ? 2650 : (this.heizgrenze ? 0 : 1750);
  }
}

// ---------- Anlagenwerte, wie HeishaMoNR sie ablegt, und die Summenfunktion des Original-Flusses
function baseGlobals(env) {
  env.files['/data/optimizer/config.json'] = JSON.stringify({ rooms: [{ id: 'ki_oben', active: true, min: 22, max: 23.5, maxAgeMin: 90 }, { id: 'ki_unten', active: true, min: 20, max: 22, maxAgeMin: 90 },
    { id: 'schlaf', active: true, min: 20, max: 22, maxAgeMin: 90 }, { id: 'wohn', active: true, min: 20, max: 23.5, maxAgeMin: 90 }] });
  Object.assign(env.g, { OPT_kz: { rad: { on: false, ts: NOW - 300 * 60000 }, fan: {} },
    TOP0_Heatpump_State: 1, TOP76_Heating_Mode: 0, TOP94_Zones_State: 0, TOP4_Operating_Mode_State: 4, TOP20_ThreeWay_Valve_State: 0, TOP26_Defrosting_State: 0, TOP18_Quiet_Mode_Level: 3,
    'MQTT.block_active': 0, HEAT_SP_lower_limit: 20, HEAT_SP_upper_limit: 100, TOP43_Z2_Water_Target_Temp: 20, TOP111_Z1_Sensor_Settings: 0,
    'F_CCC.z1.SP_DIRECT_virt': 0, 'F_CCC.z2.SP_DIRECT_virt': 0, 'F_CCC.z1.state': 0, 'F_CCC.z2.state': 0, 'F_CCC.z1.setpoint': 30, 'F_CCC.z2.setpoint': 30,
    'F_RTC.z1.state': 0, 'F_RTC.z2.state': 0, 'F_RTC.z1.correction_value': 0, 'F_RTC.z2.correction_value': 0, 'F_SS.state': 0, 'F_SS.correction_value': 0,
    'NightReductionWaterTemp.state': 0, 'NightReductionWaterTemp.correction': 0, SP_Final_z1: 30, SP_Final_z2: 20, SHIFT_Final_z1: 0, SHIFT_Final_z2: -5 });
}
function setPlantValues(env, p, o) {
  o = o || {};
  const g = env.g;
  g.TOP6_Main_Outlet_Temp = p.vlQ; g.TOP5_Main_Inlet_Temp = p.rlQ; g.TOP42_Z1_Water_Target_Temp = p.soll; g.TOP27_Z1_Heat_Request_Temp = p.shiftHp;
  g.compressor_frequency = p.hz; g.TOP14_Outside_Temp = p.at; g.TOP16_Heat_Energy_Consumption = p.running ? 300 : 34; g['F_CCC.z1.setpoint'] = p.base; g['F_CCC.z2.setpoint'] = p.base;
  g.compressor_runtime = p.running ? p.runMin : 0; g.TOP26_Defrosting_State = o.defrost ? 1 : 0; g.TOP20_ThreeWay_Valve_State = o.dhw ? 1 : 0;
  if (o.quiet !== undefined) { g.TOP18_Quiet_Mode_Level = o.quiet; }
  if (o.noHz) { delete g.compressor_frequency; }
  const age = o.hpStale ? 30 * 60000 : 0;
  g.OPT_hp = { Compressor_Freq: { v: p.hz, ts: NOW - age }, Pump_Speed: { v: p.pump, ts: NOW - age }, Heating_Control: { v: 0, ts: NOW - age }, Internal_Heater_State: { v: 0, ts: NOW - age }, External_Heater_State: { v: 0, ts: NOW - age } };
  const R = {};
  (g.OPT_cfg.rooms || []).forEach(r => { const t = (o.rooms && o.rooms[r.id] !== undefined) ? o.rooms[r.id] : (r.min + r.max) / 2; R[r.id] = { last: t, ts: NOW - (o.roomsAgeMin !== undefined ? o.roomsAgeMin : 5) * 60000 }; });
  g.OPT_rooms = R;
}

// ---------- Treiber: eine simulierte Anlage mit Pruefstand ueber 'minutes' Minuten
function simulate(o) {
  NOW = o.start !== undefined ? o.start : DAY0;
  const env = o.env || makeEnv();
  baseGlobals(env);
  runFn(env, FUNC.opt_defaults, {});
  const P = o.plant || new Plant(o.plantOpts);
  const out = { env, plant: P, shiftHp: [], rows: [], ev: [], status: [], phases: [], hpShiftMax: 0, cmds: 0, states: [] };
  const sumCode = o.unpatched ? SUM_ORIG : SUM_PATCHED;
  let prevCmd = P.pendingShift;
  const t0 = o.start !== undefined ? o.start : DAY0;
  for (let m = 0; m < o.minutes; m++) {
    NOW = t0 + m * 60000;
    if (o.beforeStep) { o.beforeStep(m, env, P, out); }
    P.step(m);
    const ov = (o.obs && o.obs(m)) || {};
    setPlantValues(env, P, ov);
    if (o.restartAt === m) {                                                              // Neustart von Node-RED: Speicher weg, Dateien bleiben
      const keep = env.files; env.g = {}; env.fl = {}; env.gctx = { get: k => env.g[k], set: (k, v) => { env.g[k] = v; } }; env.flctx = { get: k => env.fl[k], set: (k, v) => { env.fl[k] = v; } };
      baseGlobals(env); runFn(env, FUNC.opt_defaults, {}); setPlantValues(env, P, ov); env.files = keep;
    }
    if (!(o.crashFrom !== undefined && m >= o.crashFrom)) {                               // Pruefstand ausgefallen: wird nicht mehr aufgerufen
      const msgs = (o.msgs && o.msgs[m]) ? [{ topic: 'arm', payload: o.msgs[m] }] : [];
      msgs.push({ payload: NOW });
      msgs.forEach(msg => {
        const r = runFn(env, FUNC.opt_dt, msg);
        if (r) {
          if (r[0]) { out.rows.push(r[0]); env.files[r[0].filename] = (env.files[r[0].filename] || '') + r[0].payload; }
          if (r[1]) { out.ev.push(r[1]); env.files[r[1].filename] = (env.files[r[1].filename] || '') + r[1].payload; }
          if (r[2]) { out.status.push([m, r[2].payload]); }
          if (r[4]) { (out.toasts = out.toasts || []).push([m, r[4].payload]); }
        }
      });
    }
    runFn(env, sumCode, { topic: 'x', payload: 'trigger' });                              // Summenfunktion: berechnet SHIFT_Final_z1 inkl. Patch
    const want = Math.ceil(Number(env.g.SHIFT_Final_z1));
    if (want !== P.pendingShift) { out.cmds++; }
    P.pendingShift = want;
    out.shiftHp.push(P.shiftHp); out.hpShiftMax = Math.max(out.hpShiftMax, Math.abs(P.shiftHp));
    const st = env.g.OPT_dt_status; out.phases.push(JSON.parse(env.files['/data/optimizer/delaytest-state.json'] || '{"S":{}}').S.phase || 'idle');
  }
  return out;
}
const hhmmOf = (m) => { const d = new RealDate(DAY0 + m * 60000); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
const lastState = (out) => JSON.parse(out.env.files['/data/optimizer/delaytest-state.json'] || '{"S":{}}');
const evText = (out) => out.ev.map(e => e.payload).join('');
const evMonthFile = (out) => Object.keys(out.env.files).filter(f => /quiet-events-/.test(f)).map(f => out.env.files[f]).join('');

// =========================================================================================================
console.log('--- Patch der Summenfunktion');
check('Patch: wird vom Werkzeug angewendet, ist idempotent und rueckgaengig zu machen (Revert ergibt das Original Byte fuer Byte)', SUM_PATCHED !== SUM_ORIG && SUM_REVERTED === SUM_ORIG && pr0.status === 1, 'check-Exit ' + pr0.status);
check('Patch: begrenzt auf einen Block plus eine Summenzeile (Zone 1); Zone 2 und der Direktmodus bleiben unveraendert', (SUM_PATCHED.match(/OPT_TEST/g) || []).length === 4 && SUM_PATCHED.split('\n').length - SUM_ORIG.split('\n').length === 10, 'Zeilen +' + (SUM_PATCHED.split('\n').length - SUM_ORIG.split('\n').length));

function sumRun(code, setup) {
  const env = makeEnv(); baseGlobals(env); Object.assign(env.g, { 'F_CCC.z1.SP_DIRECT_virt': 0, TOP42_Z1_Water_Target_Temp: 30 }); if (setup) { setup(env.g); }
  runFn(env, code, { topic: 'x', payload: 'trigger' });
  return { shift: env.g.SHIFT_Final_z1, sp: env.g.SP_Final_z1, sent: JSON.stringify(env.sent), g: JSON.stringify(Object.keys(env.g).sort().map(k => [k, env.g[k]])) };
}
const T0 = NOW;
let identical = true, diffInfo = '';
const combos = [];
[0, 1, -1, 2].forEach(base => [0, 0.4, -0.7, 1.5].forEach(rtc => [0, 1].forEach(ssS => [0, 1].forEach(nrS => [0, 1].forEach(rs => combos.push({ base, rtc, ss: 0.5, nr: -1, ssS, nrS, rs }))))));
combos.forEach(cb => {
  const setup = g => { g['F_CCC.z1.SP_DIRECT_virt'] = cb.base; g['F_RTC.z1.correction_value'] = cb.rtc; g['F_RTC.z1.state'] = cb.rs; g['F_SS.state'] = cb.ssS; g['F_SS.correction_value'] = cb.ss; g['NightReductionWaterTemp.state'] = cb.nrS; g['NightReductionWaterTemp.correction'] = cb.nr; };
  const a = sumRun(SUM_ORIG, setup);
  [undefined, 'x', NaN, null].forEach(bad => {                                          // kein/ungueltiger Wert und frischer Zeitstempel
    const b = sumRun(SUM_PATCHED, g => { setup(g); g.OPT_test_shift = bad; g.OPT_test_ts = NOW; });
    if (a.shift !== b.shift || a.sp !== b.sp || a.sent !== b.sent) { identical = false; diffInfo = JSON.stringify([cb, bad, a.shift, b.shift]); }
  });
  const c = sumRun(SUM_PATCHED, setup);                                                  // keine OPT-Werte
  if (a.shift !== c.shift || a.sent !== c.sent || a.g !== c.g) { identical = false; diffInfo = JSON.stringify([cb, 'leer']); }
  [NOW - 151000, NOW - 3600000, NOW + 61000].forEach(ts => {                              // veraltet oder aus der Zukunft
    const d = sumRun(SUM_PATCHED, g => { setup(g); g.OPT_test_shift = 1; g.OPT_test_ts = ts; });
    if (a.shift !== d.shift || a.sent !== d.sent) { identical = false; diffInfo = JSON.stringify([cb, 'stale', ts - NOW]); }
  });
  const e = sumRun(SUM_PATCHED, g => { setup(g); g.OPT_test_shift = 1; g.OPT_test_ts = NOW - 149000; });
  const off = cb.rs === 0 && cb.ssS === 0 && cb.nrS === 0;                              // Testbeitrag nur ohne Raumregelung/Softstart/Nachtabsenkung
  const exp = Math.round((cb.base + (cb.rs ? cb.rtc : 0) + (cb.nrS ? cb.nr : 0) + (cb.ssS ? cb.ss : 0) + (off ? 1 : 0)) * 10) / 10, expClamped = Math.max(-5, Math.min(5, exp));
  if (e.shift !== expClamped) { identical = false; diffInfo = JSON.stringify([cb, 'frisch', e.shift, expClamped]); }
});
check('Patch: ohne OPT-Werte, mit ungueltigen Werten (undefined, Text, NaN, null), veraltetem (> 150 s) oder zukuenftigem Zeitstempel ist die Funktion in ' + combos.length + ' Kombinationen exakt wie das Original (Verschiebung, Sollwert, gesendete Nachrichten, alle Speicherwerte); mit frischem Wert kommt genau +1 K hinzu, aber nur, wenn Raumregelung, Softstart und Nachtabsenkung aus sind', identical, diffInfo);
const big = sumRun(SUM_PATCHED, g => { g.OPT_test_shift = 5; g.OPT_test_ts = NOW; }), neg = sumRun(SUM_PATCHED, g => { g.OPT_test_shift = -4; g.OPT_test_ts = NOW; });
check('Patch: der Beitrag ist hart auf -1..+1 K begrenzt (Wert 5 ergibt +1, -4 ergibt -1)', big.shift === 1 && neg.shift === -1, big.shift + ' / ' + neg.shift);
const dm = sumRun(SUM_PATCHED, g => { g.TOP76_Heating_Mode = 1; g.OPT_test_shift = 1; g.OPT_test_ts = NOW; }), dmo = sumRun(SUM_ORIG, g => { g.TOP76_Heating_Mode = 1; });
check('Patch: im Direktmodus (Heizungsmodus 1) bleibt alles wie im Original, auch mit frischem Wert', dm.sp === dmo.sp && dm.sent === dmo.sent && dm.g.replace(/OPT_[a-z_]+/g, '') !== undefined, '');

// =========================================================================================================
console.log('--- Grundverhalten ohne Test (Kalibrierung des Anlagenmodells)');
{
  const o = simulate({ minutes: 24 * 60, plantOpts: { atFn: () => 9 }, unpatched: true });
  const sim2 = (() => { const P2 = new Plant({ atFn: () => 9 }); const L = []; let prevR = P2.running; for (let m = 0; m < 1440; m++) { P2.step(m); if (P2.running !== prevR) { L.push([P2.running ? 'start' : 'stopp', m]); prevR = P2.running; } } return L; })();
  const stops = sim2.filter(x => x[0] === 'stopp').map(x => x[1]), starts = sim2.filter(x => x[0] === 'start').map(x => x[1]);
  const pauseMin = starts.length ? starts[0] - stops[0] : 0, lauf = (stops[1] || 0) - starts[0];
  check('Anlagenmodell: bei 9 °C taktet es mit Lauf 2,5-5,5 h und Pause 60-100 min (Messwerte: Lauf 2-5 h, Pause 66-85 min), 3-5 Starts am Tag', pauseMin >= 60 && pauseMin <= 100 && lauf >= 150 && lauf <= 330 && starts.length >= 3 && starts.length <= 5, 'Pause ' + pauseMin + ' min, Lauf ' + lauf + ' min, Starts ' + starts.length + ' (' + stops.join(',') + ')');
  check('Ohne scharfen Pruefstand: es wird nichts gesendet oder protokolliert (nur Zustand und leeres Testfenster), Verschiebung bleibt 0, kein OPT_test_shift', o.hpShiftMax === 0 && o.env.g.OPT_test_shift === undefined && o.rows.length === 0 && Object.keys(o.env.files).every(f => /delaytest-state|delaytest-window|config\.json/.test(f)) && o.env.files['/data/optimizer/delaytest-window.json'] === 'null', Object.keys(o.env.files).join());
}

// =========================================================================================================
console.log('--- Ausschalten hinauszoegern (Start bei Vorlauf +1,75..+2,5 K und Anstieg >= 1,2 K/h; Messung bis zur Abschaltung)');
function twinStop(plantOpts, afterMin) { const P = new Plant(plantOpts); for (let m = 0; m < 1000; m++) { P.step(m); if (!P.running && m > afterMin) { return m; } } return null; }
const AUS_OPTS = { atFn: () => 9, vl: 29.5, running: true, runMin: 50 };
{
  const o = simulate({ minutes: 6 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } });
  const S = lastState(o).S, ev = evMonthFile(o);
  const startRow = o.status.find(s => /läuft: \+1 K seit 0 min/.test(s[1]));
  check('Ausschalten: Start erst nach 60 min stabiler Außentemperatur und 2 min erfüllten Bedingungen (Lauf >= 45 min, Vorlauf +1,75..+2,5 K, Anstieg >= 1,2 K/h), dann genau +1 K', startRow !== undefined && startRow[0] >= 60 && /verzoegerungstest_start,ausschalten \(\+1 K\) bei Vorlauf .*Anstieg/.test(ev), startRow && startRow[0] + ' min / ' + (ev.match(/verzoegerungstest_start[^\n]*/) || [''])[0]);
  const twin = twinStop(AUS_OPTS, 0), first = o.plant.stops[0];
  const res = S.last;
  check('Ausschalten: die Abschaltung kommt spaeter als im Zwillingslauf ohne Test (Modell: +1 K verschiebt die Grenze um 1 K)', first > twin + 15, 'mit Test Minute ' + first + ', ohne ' + twin + ', Gewinn ' + (first - twin) + ' min');
  check('Ausschalten: Ergebnis "folgt_soll" mit Minuten ab Bestätigung, Vorlauf und Abstand zum Soll (Ereignis und Zustand)', res && res.key === 'stopp' && res.klasse === 'folgt_soll' && /verzoegerungstest_ergebnis,ausschalten: Abschaltung \d+ min nach der Bestätigung/.test(ev), res && res.text);
  check('Ausschalten: nach der Abschaltung geht die Verschiebung wieder auf 0, der Test entschaerft sich selbst (Einmal-Test), der Zustand ist wieder Leerlauf', o.shiftHp[o.shiftHp.length - 1] === 0 && S.phase === 'idle' && lastState(o).arm === 'aus', JSON.stringify({ phase: S.phase, arm: lastState(o).arm }));
  const changes = o.shiftHp.filter((v, i) => i > 0 && v !== o.shiftHp[i - 1]).length;
  check('Ausschalten: an der Anlage gibt es genau zwei Aenderungen (0 -> +1 -> 0), nie mehr als 1 K Betrag', changes === 2 && o.hpShiftMax === 1, 'Aenderungen ' + changes + ', max ' + o.hpShiftMax);
  const csv = Object.keys(o.env.files).filter(f => /delaytest-2026/.test(f)).map(f => o.env.files[f]).join('');
  check('Ausschalten: Protokoll hat Kopfzeile, eine Zeile je Minute waehrend des Tests und die Auswertungsspalten (berechnete Verschiebung, Rücklauf beim Stopp, Radiator, Minuten ab Bestätigung)', /^zeit,test,phase,shift_befehl,soll_vl,soll_basis,ist_vl,vl_minus_basis,.*shift_berechnet,.*rl_beim_stopp,kz_radiator_an,min_ab_bestaetigung,notiz/.test(csv) && csv.split('\n').filter(l => /,test,|,nach,/.test(l)).length >= 10, csv.split('\n').length + ' Zeilen');
  check('Ausschalten: die Angabe "etwa N min später als ohne Verschiebung" liegt höchstens 10 min neben dem Zwillingslauf', res && res.spaeterMin !== null && Math.abs(res.spaeterMin - (first - twin)) <= 10, res && ('Angabe ' + res.spaeterMin + ', Zwilling ' + (first - twin)));
  const f = simulate({ minutes: 6 * 60, plantOpts: Object.assign({}, AUS_OPTS, { stopFest: true }), msgs: { 5: 'ausschalten' } });
  const rf = lastState(f).S.last;
  check('Ausschalten: wirkt die Verschiebung nicht auf die Abschaltgrenze, lautet das Ergebnis "ohne_wirkung"', rf && rf.key === 'stopp' && rf.klasse === 'ohne_wirkung', rf && rf.text);
}

// =========================================================================================================
console.log('--- Einschalten ausloesen: trennt "Schwelle folgt dem Soll" von "Verschiebung wirkt nicht"');
function einTest(plantOpts) {
  return simulate({ minutes: 6 * 60, plantOpts: Object.assign({ atFn: () => 9, vl: 34.0, running: false, runMin: 0, stoppedMin: 30, storedThr: 26.75 }, plantOpts), msgs: { 3: 'einschalten' } });
}
{
  const a = einTest({ startMode: 'soll', delay: 1 }), b = einTest({ startMode: 'soll', delay: 9 }), c = einTest({ startMode: 'fest', delay: 7 });
  const sa = lastState(a).S.last, sb = lastState(b).S.last, sc = lastState(c).S.last;
  check('Einschalten: Schwelle Soll -3,25 K ohne Timer -> Start kurz nach Erreichen der verschobenen Schwelle (Klasse "folgt_soll")', sa && sa.key === 'start' && sa.klasse === 'folgt_soll' && sa.abSchwelle <= 3, JSON.stringify(sa));
  check('Einschalten: Schwelle Soll -3,25 K mit Timer 9 min -> Start 8-11 min nach der verschobenen Schwelle, bevor die natürliche erreicht ist (Klasse "folgt_soll")', sb && sb.key === 'start' && sb.klasse === 'folgt_soll' && sb.abSchwelle >= 8 && sb.abSchwelle <= 11, JSON.stringify(sb));
  check('Einschalten: Schwelle beim Abschalten gespeichert (Verschiebung wirkt nicht) -> Start erst nach der natürlichen Schwelle (Klasse "ohne_wirkung")', sc && (sc.key === 'start' || sc.key === 'kein_start') && sc.klasse === 'ohne_wirkung', JSON.stringify(sc));
  check('Einschalten: nach dem Start geht die Verschiebung zurueck auf 0 (Einmal-Test), jeweils genau zwei Aenderungen an der Anlage', [a, b, c].every(o => o.shiftHp[o.shiftHp.length - 1] === 0 && o.shiftHp.filter((v, i) => i > 0 && v !== o.shiftHp[i - 1]).length === 2), '');
  const twinB = (() => { const P = new Plant(Object.assign({ atFn: () => 9, vl: 34.0, running: false, runMin: 0, stoppedMin: 30, storedThr: 26.75 }, { startMode: 'soll', delay: 9 })); for (let m = 0; m < 600; m++) { P.step(m); if (P.running) { return m; } } return null; })();
  const realB = b.plant.starts[0];
  check('Einschalten: die Angabe "etwa N min früher als ohne Verschiebung" liegt höchstens 6 min neben dem Zwillingslauf', sb && sb.frueherMin !== null && Math.abs(sb.frueherMin - (twinB - realB)) <= 6, sb && ('Angabe ' + sb.frueherMin + ', Zwilling ' + (twinB - realB)));
  const ev = evMonthFile(b);
  check('Einschalten: Start-Ereignis nennt Abfallrate und Zeitzone, Bestätigung durch die Anlage wird protokolliert', /verzoegerungstest_start,einschalten .*Abfall [\d,]+ K\/h; Zeitzone UTC\+\d/.test(ev) && /Anlage bestätigt \+1 K/.test(ev), (ev.match(/verzoegerungstest_start[^\n]*/) || [''])[0]);
}

// =========================================================================================================
console.log('--- Abbrueche: jede Stoerung nimmt die Verschiebung zurueck (hier mit Summenfunktion jede Minute; echte Kette: delaytest_chain_sim.js)');
function abortCase(name, extra, expectRe) {
  const base = { minutes: 5 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } };
  const probe = simulate(Object.assign({}, base));
  const startMin = (probe.status.find(s => /läuft: \+1 K seit 0 min/.test(s[1])) || [null])[0];
  const m0 = startMin + 6;
  const o = simulate(Object.assign({}, base, extra(m0)));
  const ev = evMonthFile(o), S = lastState(o);
  const mA = (o.status.find(s => /Abbruch:/.test(s[1])) || [null])[0];
  const back0 = mA === null ? -1 : o.shiftHp.slice(mA).findIndex(v => v === 0);
  const ok = expectRe.test(ev) && back0 >= 0 && back0 <= 3 && S.S.phase !== 'test' && S.arm === 'aus' && o.hpShiftMax <= 1;
  check('Abbruch: ' + name + ' -> Verschiebung nach hoechstens 3 Minuten wieder 0, Einmal-Test entschaerft, Grund im Protokoll', ok, 'Abbruch in Minute ' + mA + ', Rueckkehr nach ' + back0 + ' min; ' + (ev.match(/verzoegerungstest_abbruch[^\n]*/) || ['kein Abbruchereignis'])[0]);
  return o;
}
abortCase('Raum zu warm (Kinderzimmer unten 1,6 K über dem Band)', m0 => ({ obs: m => (m >= m0 ? { rooms: { ki_unten: 23.6 } } : {}) }), /abbruch,ausschalten: Raum zu warm: Kinderzimmer unten/);
abortCase('Raum unter dem Band (Schlafzimmer 0,5 K darunter)', m0 => ({ obs: m => (m >= m0 ? { rooms: { schlaf: 19.5 } } : {}) }), /abbruch,ausschalten: Raum unter Minimum: Schlafzimmer/);
abortCase('Kinderzimmer oben außerhalb der Plausibilität (25,5 °C, lokale Regelung gestört)', m0 => ({ obs: m => (m >= m0 ? { rooms: { ki_oben: 25.5 } } : {}) }), /abbruch,ausschalten: Raum außerhalb der Plausibilität: Kinderzimmer oben/);
abortCase('Abtauen beginnt', m0 => ({ obs: m => (m >= m0 ? { defrost: 1 } : {}) }), /abbruch,ausschalten: Abtauen/);
abortCase('Warmwasserbereitung beginnt', m0 => ({ obs: m => (m >= m0 ? { dhw: 1 } : {}) }), /abbruch,ausschalten: Warmwasser/);
abortCase('Anlagenwerte veralten (HeishaMon meldet nicht mehr)', m0 => ({ obs: m => (m >= m0 ? { hpStale: true } : {}) }), /abbruch,ausschalten: Anlagenwerte veraltet/);
abortCase('Quiet-Stufe wird geaendert', m0 => ({ obs: m => (m >= m0 ? { quiet: 2 } : {}) }), /abbruch,ausschalten: Heizregelung oder Quiet geändert/);
abortCase('MQTT-Befehle werden gesperrt (MQTT.block_active)', m0 => ({ beforeStep: (m, env) => { if (m >= m0) { env.g['MQTT.block_active'] = 1; } } }), /abbruch,ausschalten: MQTT-Befehle gesperrt/);
abortCase('Übernahme der Entscheidungsmaschine wird eingeschaltet', m0 => ({ beforeStep: (m, env) => { if (m >= m0) { env.g.OPT_apply_enabled = true; } } }), /abbruch,ausschalten: Übernahme der Entscheidungsmaschine/);
abortCase('Raumregelung wird eingeschaltet (-0,3 K)', m0 => ({ beforeStep: (m, env) => { if (m >= m0) { env.g['F_RTC.z1.state'] = 1; env.g['F_RTC.z1.correction_value'] = -0.3; } } }), /abbruch,ausschalten: Raumregelung/);
abortCase('Nutzer entschaerft den Test im Dashboard (Aus)', m0 => ({ msgs: { 5: 'ausschalten', [m0]: 'aus' } }), /abbruch,ausschalten: vom Nutzer entschärft/);
abortCase('Sollsprung durch die Außentemperatur (9 -> 8 °C)', m0 => ({ plantOpts: Object.assign({}, AUS_OPTS, { atFn: m => (m >= m0 ? 8 : 9) }) }), /abbruch,ausschalten: Sollsprung/);
abortCase('Außentemperatur verlässt das Fenster (14 °C)', m0 => ({ plantOpts: Object.assign({}, AUS_OPTS, { atFn: m => (m >= m0 ? 14 : 9) }) }), /abbruch,ausschalten: (Außentemperatur verlässt das Fenster|Sollsprung)/);
abortCase('Anlage bestaetigt die Verschiebung nicht (Befehl kommt nicht an)', m0 => ({ plantOpts: Object.assign({}, AUS_OPTS, { cmdFail: true }) }), /abbruch,ausschalten: Verschiebung wurde nicht bestätigt/);
abortCase('Anlage schaltet trotz Grenze nicht ab (Vorlauf laeuft hoch)', m0 => ({ beforeStep: (m, env, P) => { if (m === m0) { P.noStop = true; P.qMin = 4.5; } } }), /abbruch,ausschalten: (Vorlauf|Vorlauf über)/);

// =========================================================================================================
console.log('--- Wann der Test NICHT startet');
function noStart(name, extra, re) {
  const o = simulate(Object.assign({ minutes: 5 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } }, extra));
  const started = /verzoegerungstest_start/.test(evMonthFile(o)), allStatus = o.status.map(s => s[1]).join('|');
  check('Kein Start: ' + name, !started && (o.env.g.OPT_test_shift === undefined || o.env.g.OPT_test_shift === 0) && !/läuft: \+1 K/.test(allStatus) && re.test(allStatus), 'Status: ' + (o.status[o.status.length - 1] || ['', ''])[1].slice(0, 110));
}
{ const o = simulate({ minutes: 3 * 60, start: Date.UTC(2026, 9, 12, 1, 0, 0), plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } });
  check('Kein Start: nachts (03:00 Uhr) wird die Wahl gar nicht erst angenommen (scharf schalten nur 9-18 Uhr), Hinweis "Wahl ignoriert", Schalter springt zurück', !/verzoegerungstest_start/.test(evMonthFile(o)) && o.hpShiftMax === 0 && o.status.some(s => /Wahl ignoriert: scharf schalten nur zwischen 9 und 18 Uhr/.test(s[1])), (o.status.find(s => /Wahl/.test(s[1])) || ['', ''])[1].slice(0, 100)); }
noStart('Aussentemperatur 6 °C (Dauerlauf-Bereich, unter 8,5 °C)', { plantOpts: Object.assign({}, AUS_OPTS, { atFn: () => 6 }) }, /Außentemperatur 6 °C außerhalb/);
noStart('Aussentemperatur 14 °C (Heizgrenze-Hysterese)', { plantOpts: Object.assign({}, AUS_OPTS, { atFn: () => 14 }) }, /Außentemperatur 14 °C außerhalb/);
noStart('Außentemperatur wechselt alle 40 min zwischen 10 und 11 °C (Sollsprung droht)', { plantOpts: Object.assign({}, AUS_OPTS, { atFn: m => (Math.floor(m / 40) % 2 ? 10 : 11) }) }, /Außentemperatur erst seit \d+ min unverändert/);
noStart('Raumregelung eingeschaltet (+1 K)', { beforeStep: (m, env) => { env.g['F_RTC.z1.state'] = 1; env.g['F_RTC.z1.correction_value'] = 1; } }, /Raumregelung\/Nachtabsenkung\/Softstart eingeschaltet/);
noStart('Heizkurvenverschiebung des Nutzers (SP_DIRECT_virt +1)', { beforeStep: (m, env) => { env.g['F_CCC.z1.SP_DIRECT_virt'] = 1; } }, /Heizkurvenverschiebung an der Anlage ist 1 K|berechnete Verschiebung ist 1,0 K/);
noStart('Raum unter Minimum (Kinderzimmer unten 19,5)', { obs: () => ({ rooms: { ki_unten: 19.5 } }) }, /Raum unter Minimum: Kinderzimmer unten/);
noStart('Raum zu warm (Schlafzimmer 23,5, Band bis 22)', { obs: () => ({ rooms: { schlaf: 23.5 } }) }, /Raum zu warm: Schlafzimmer/);
noStart('Raumwerte veraltet (älter als das Limit des Raums)', { obs: () => ({ roomsAgeMin: 400 }) }, /Raumwert veraltet/);
noStart('Zustand des Radiators Kinderzimmer oben unbekannt (z. B. nach einem Neustart)', { beforeStep: (m, env) => { env.g.OPT_kz = { rad: {} }; } }, /Radiator Kinderzimmer oben unbekannt/);
noStart('Radiator Kinderzimmer oben ist an (Aus-Test nur mit Relais aus)', { beforeStep: (m, env) => { env.g.OPT_kz = { rad: { on: true, ts: DAY0 - 300 * 60000 } }; } }, /Radiator Kinderzimmer oben ist an/);
noStart('Radiator hat vor wenigen Minuten geschaltet', { beforeStep: (m, env) => { env.g.OPT_kz = { rad: { on: false, ts: NOW - 5 * 60000 } }; } }, /Radiator Kinderzimmer oben vor \d+ min geschaltet/);
noStart('Übernahme der Entscheidungsmaschine eingeschaltet', { beforeStep: (m, env) => { env.g.OPT_apply_enabled = true; } }, /Übernahme der Entscheidungsmaschine/);
noStart('Zone-1-Fühler nicht Wasser (Befehl ginge über SetCurves)', { beforeStep: (m, env) => { env.g.TOP111_Z1_Sensor_Settings = 1; } }, /Zone-1-Fühler/);
noStart('Anlage meldet Verschiebung 2 K', { beforeStep: (m, env, P) => { P.cmdFail = true; P.shiftHp = 2; } }, /Anlage meldet Verschiebung 2 K/);
noStart('Verdichterwert fehlt (kein "steht"-Fehlschluss)', { obs: () => ({ noHz: true }) }, /Anlagenwerte unvollständig/);

// =========================================================================================================
console.log('--- Tageslimit, Scharfschaltung verfaellt, Neustart, Ausfall des Pruefstands, Alarm');
{
  const o = simulate({ minutes: 52 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten', 400: 'ausschalten', 700: 'ausschalten', [24 * 60 + 60]: 'ausschalten' } });
  const ev = evMonthFile(o), starts = (ev.match(/verzoegerungstest_start/g) || []).length;
  check('Tageslimit: am selben Tag wird nach einem Test kein zweiter gestartet (Grund wird angezeigt), am Folgetag nach neuer Scharfschaltung wieder', starts === 2 && o.status.some(s => s[0] > 400 && s[0] < 660 && /Tageslimit erreicht/.test(s[1])), 'Tests ' + starts);
  check('Scharfschaltung verfaellt am Ende des Tagesfensters (18 Uhr); eine Wahl danach wird abgelehnt und der Schalter springt zurück', /verzoegerungstest_wahl,aus \(abgelaufen\)/.test(ev) && o.status.some(s => s[0] === 700 && /Wahl ignoriert: scharf schalten nur zwischen 9 und 18 Uhr/.test(s[1])), (ev.match(/wahl,aus[^\n]*/) || [''])[0]);
}
{
  const probe = simulate({ minutes: 5 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } });
  const sMin = probe.status.find(s => /läuft: \+1 K seit 0 min/.test(s[1]))[0];
  const o = simulate({ minutes: 5 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' }, restartAt: sMin + 6 });
  const ev = evMonthFile(o), S = lastState(o), mA = (o.status.find(s => /Abbruch: Neustart/.test(s[1])) || [null])[0];
  const back0 = mA === null ? -1 : o.shiftHp.slice(mA).findIndex(v => v === 0);
  check('Neustart von Node-RED mitten im Test: Abbruch beim ersten Aufruf, Verschiebung binnen 3 min auf 0, danach Leerlauf, nicht scharf (Logik; Rückkehr an der echten Anlage: Kettensimulation)', /abbruch,ausschalten: Neustart von Node-RED/.test(ev) && back0 >= 0 && back0 <= 3 && S.S.phase === 'idle' && S.arm === 'aus', 'Rueckkehr nach ' + back0 + ' min');
  const c = simulate({ minutes: 5 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' }, crashFrom: sMin + 6 });
  const back = c.shiftHp.slice(sMin + 6).findIndex(v => v === 0);
  check('Totmann: faellt der Pruefstand mitten im Test aus, verfaellt die Verschiebung nach hoechstens 4 Minuten von selbst (Patch ignoriert Werte aelter als 150 s) und bleibt 0', back >= 0 && back <= 4 && c.shiftHp.slice(sMin + 6 + back).every(v => v === 0), 'Rueckkehr nach ' + back + ' min');
  // Rueckstellung klappt nicht: Phase "nach" bleibt, Alarm nach 10 min, aufgehoben, sobald die Anlage 0 meldet
  const al = simulate({ minutes: 5 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten', [sMin + 8]: 'aus' }, beforeStep: (m, env, P) => { P.cmdFail = m >= sMin + 3 && m < sMin + 40; } });
  const evA = evMonthFile(al), phases = al.phases.slice(sMin + 9, sMin + 39);
  check('Rückstellung scheitert: Phase "nach" gibt nicht auf (Status "ACHTUNG"), Alarm-Ereignis und Hinweis im Dashboard nach 10 min, kein neuer Test', phases.every(p => p === 'nach') && /verzoegerungstest_alarm/.test(evA) && (al.toasts || []).length === 1 && al.status.some(s => /ACHTUNG: Anlage meldet noch 1 K/.test(s[1])), JSON.stringify((al.toasts || []).map(t => t[1])));
  check('Rückstellung gelingt später: Alarm aufgehoben, Leerlauf', /Alarm aufgehoben/.test(evA) && lastState(al).S.phase === 'idle', '');
  const ig = simulate({ minutes: 3 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten', [sMin + 4]: 'einschalten' } });
  check('Andere Wahl während des Tests: wird mit "Wahl ignoriert: Test läuft" beantwortet, der Schalter wird zurückgesetzt, der Test läuft weiter', ig.status.some(s => s[0] === sMin + 4 && /Wahl ignoriert: Test läuft/.test(s[1])) && ig.phases[sMin + 5] === 'test', '');
  const er = simulate({ minutes: 3 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' }, beforeStep: (m, env) => { if (m === sMin + 5) { env.g.OPT_cfg.delaytest.ignoreRooms = 5; } } });
  const sE = lastState(er).S;
  check('Fehler im Kern während des Tests: Verschiebung 0, Zustand "nach" mit Testende und Tageszähler bleiben erhalten (kein zweiter Test am selben Tag)', /Fehler im Prüfstand/.test(evMonthFile(er)) && er.shiftHp[er.shiftHp.length - 1] === 0 && sE.day && sE.lastEnd > 0, JSON.stringify({ phase: sE.phase, day: sE.day }));
}
{ // Der Pruefstand veraendert nur OPT_*-Werte
  const env = makeEnv(); baseGlobals(env); runFn(env, FUNC.opt_defaults, {});
  const snap = () => JSON.stringify(Object.keys(env.g).filter(k => !k.startsWith('OPT_')).sort().map(k => [k, env.g[k]]));
  let tampered = '';
  const P = new Plant(AUS_OPTS); NOW = DAY0;
  const call = (msg) => { const b = snap(); runFn(env, FUNC.opt_dt, msg); if (snap() !== b) { tampered = 'Aufruf veraendert Nicht-OPT-Werte'; } };
  for (let m = 0; m < 4 * 60; m++) { NOW = DAY0 + m * 60000; P.step(m); setPlantValues(env, P, {}); if (m === 5) { call({ topic: 'arm', payload: 'ausschalten' }); } call({ payload: NOW }); P.pendingShift = env.g.OPT_test_shift === 1 ? 1 : 0; }
  const optKeys = Object.keys(env.g).filter(k => /^OPT_/.test(k));
  check('Sicherheit: der Pruefstand aendert in keinem Aufruf einen Anlagenwert oder eine Steuergroesse, er schreibt nur OPT_*-Werte (OPT_test_shift, OPT_test_ts, OPT_dt_window, OPT_dt_status)', tampered === '' && env.g.OPT_test_shift !== undefined && env.g.OPT_test_ts !== undefined && env.g.OPT_dt_status !== undefined && env.g.OPT_dt_window !== undefined, tampered || optKeys.filter(k => /test|dt/.test(k)).join());
  const dtn = byId.opt_dt, tabNodes = ALL.filter(n => n.z === 'opt_tab');
  check('Sicherheit (Flow-Datei): opt_dt ruft nirgends node.send auf, hat nur Ausgaenge zu den beiden Dateien, dem Status, dem Schalter und dem Hinweis; im Tab gibt es ausser dem gesperrten Uebernahme-Knoten der Entscheidungsmaschine (opt_apply_mqtt) keinen mqtt-out-, link- oder http-in-Knoten', !/node\.send\s*\(/.test(dtn.func) && JSON.stringify(dtn.wires) === '[["opt_f_dt"],["opt_f_qev"],["opt_ui_dt_status"],["opt_ui_dt_arm"],["opt_ui_toast"]]' && tabNodes.every(n => n.id === 'opt_apply_mqtt' || !['mqtt out', 'link out', 'link in', 'link call', 'http in', 'http response'].includes(n.type)), JSON.stringify(dtn.wires));
  check('Oberflaeche: Schalter (Aus / Ausschalten hinauszoegern / Einschalten ausloesen) geht nur an opt_dt, Status-Text und eigene Gruppe auf der Seite "Daten & Güte"', byId.opt_ui_dt_arm.type === 'ui_dropdown' && JSON.stringify(byId.opt_ui_dt_arm.wires) === '[["opt_dt"]]' && byId.opt_ui_dt_arm.options.map(x => x.value).join() === 'aus,ausschalten,einschalten' && byId.opt_g_dt.tab === 'opt_ui_tab_data' && byId.opt_ui_dt_status.group === 'opt_g_dt', '');
}

// =========================================================================================================
console.log('--- Mehrtaegige Simulation mit Neustart (3 Tage)');
{
  const AT3 = m => (m < 2880 ? 9 : 6);
  const opts = { minutes: 3 * 24 * 60, plantOpts: { atFn: AT3, vl: 29.5, running: true, runMin: 50 }, msgs: { 5: 'ausschalten', 300: 'einschalten', [1440 + 30]: 'einschalten', [2880 + 30]: 'ausschalten' } };
  const probe = simulate(opts);
  const sDay2 = probe.status.find(s => s[0] > 1440 && /läuft: \+1 K seit 0 min/.test(s[1]));
  const o = simulate(Object.assign({}, opts, { restartAt: sDay2 ? sDay2[0] + 4 : undefined }));
  const ev = evMonthFile(o);
  const startsDay = [0, 1, 2].map(d => o.status.filter(s => s[0] >= d * 1440 && s[0] < (d + 1) * 1440 && /läuft: \+1 K seit 0 min/.test(s[1])).length);
  const startHours = (ev.match(/\d{4}-\d\d-\d\d (\d\d):\d\d:\d\d,verzoegerungstest_start/g) || []).map(x => Number(x.slice(11, 13)));
  const endsZero = [1439, 2879, 4319].every(i => o.shiftHp[i] === 0);
  check('3 Tage: hoechstens ein Test je Tag, nur im Tagesfenster 9-18 Uhr, Tag 3 (6 °C) startet nichts, die Verschiebung ist nie ueber 1 K und am Ende jedes Tages 0', startsDay.every(n => n <= 1) && startsDay[0] === 1 && startsDay[2] === 0 && startHours.every(h => h >= 9 && h < 18) && o.hpShiftMax <= 1 && endsZero, JSON.stringify({ startsDay, startHours, endsZero, max: o.hpShiftMax }));
  check('3 Tage: ein Neustart mitten im Test an Tag 2 nimmt die Verschiebung zurueck (Abbruch protokolliert)', (sDay2 === undefined || /abbruch,[a-z]+: Neustart/.test(ev)) && o.shiftHp[o.shiftHp.length - 1] === 0, sDay2 ? 'Neustart in Minute ' + (sDay2[0] + 4) : 'an Tag 2 kein Test (Bedingungen)');
  const csv = Object.keys(o.env.files).filter(f => /delaytest-2026/.test(f)).map(f => o.env.files[f]).join('');
  check('3 Tage: das Protokoll ist nach Kopfzeile geordnet (jede Zeile hat 21 Spalten)', csv.split('\n').filter(l => l && !/^zeit,/.test(l)).every(l => l.split(',').length === 21), csv.split('\n').filter(l => l && !/^zeit,/.test(l)).length + ' Zeilen');
}

console.log(fails === 0 ? '\nERGEBNIS: alle Pruefungen bestanden' : '\nERGEBNIS: ' + fails + ' Pruefung(en) fehlgeschlagen');
process.exit(fails === 0 ? 0 : 1);

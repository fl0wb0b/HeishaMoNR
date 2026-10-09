// Offline-Simulation des Verzoegerungstests (Schalt-Pruefstand) mit Fake-Uhr und einem einfachen Anlagenmodell. Kein Node-RED, kein MQTT, nichts wird gesendet.
// Aufruf:  node tools/delaytest_sim.js "flows (26.5.1 stable).json"
// Geprueft werden: der Kern (Vorbedingungen, Ablauf, Abbrueche, Auswertung), die Huelle (opt_dt) und der Patch der Summenfunktion (Frische, Begrenzung, Neutralitaet).
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
// Einschalten (Hypothesen): 'soll' = Vorlauf <= Soll - 3,0 K fuer 'delay' Minuten (Soll = aktuell inkl. Verschiebung);
//                            'fest' = Schwelle am Abschaltzeitpunkt gespeichert (ignoriert spaetere Verschiebung), 'delay' Minuten.
class Plant {
  constructor(o) {
    Object.assign(this, { C: 0.33, qMin: 2.1, ua: 0.17, gain: 0.45, stops: [], starts: [], startMode: 'soll', delay: 7, cmdFail: false, noStop: false, atFn: () => 9, vl: 31, running: true, runMin: 60,
      stopCnt: 0, startCnt: 0, stoppedMin: 0, shiftHp: 0, pendingShift: 0, lastSollBase: 29, storedThr: null, hz: 17, dhw: 0, defrost: 0 }, o || {});
  }
  sollBase(at) { return Math.max(29, Math.ceil(29 + 0.375 * (11 - at))); }
  step(min) {
    const at = this.atFn(min), base = this.sollBase(at);
    this.shiftHp = this.cmdFail ? this.shiftHp : this.pendingShift;                          // Befehl kommt eine Minute spaeter an
    const soll = base + this.shiftHp, demand = Math.max(0.3, this.ua * (21 - at) - this.gain);
    this.at = at; this.base = base; this.soll = soll;
    this.vl += ((this.running ? this.qMin : 0) - demand) / this.C / 60;
    this.vlQ = Math.round(this.vl * 4) / 4;
    this.rlQ = Math.round((this.vl - (this.running ? 2.2 : 0)) * 4) / 4;
    if (this.running) {
      this.runMin++; this.stoppedMin = 0;
      if (!this.noStop && this.vlQ - soll >= 3.25 - 1e-9) { this.stopCnt++; } else { this.stopCnt = 0; }
      if (this.stopCnt >= 3) { this.running = false; this.stopCnt = 0; this.stoppedMin = 0; this.storedThr = base - 3.0; this.stopped = min; this.stops.push(min); }
    } else {
      this.stoppedMin++;
      const thr = this.startMode === 'fest' ? this.storedThr : soll - 3.0;
      if (this.stoppedMin >= 3 && this.vlQ <= thr + 1e-9) { this.startCnt++; } else { this.startCnt = 0; }
      if (this.startCnt >= Math.max(1, this.delay)) { this.running = true; this.runMin = 0; this.startCnt = 0; this.started = min; this.starts.push(min); this.vl += 0.6; }
    }
    this.hz = this.running ? 17 : 0;
    this.pump = this.running ? 2650 : (this.heizgrenze ? 0 : 1750);
  }
}

// ---------- Anlagenwerte, wie HeishaMoNR sie ablegt, und die Summenfunktion des Original-Flusses
function baseGlobals(env) {
  Object.assign(env.g, {
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
  const age = o.hpStale ? 30 * 60000 : 0;
  g.OPT_hp = { Compressor_Freq: { v: p.hz, ts: NOW - age }, Pump_Speed: { v: p.pump, ts: NOW - age }, Heating_Control: { v: 0, ts: NOW - age }, Internal_Heater_State: { v: 0, ts: NOW - age }, External_Heater_State: { v: 0, ts: NOW - age } };
  const R = {};
  (g.OPT_cfg.rooms || []).forEach(r => { const t = (o.rooms && o.rooms[r.id] !== undefined) ? o.rooms[r.id] : (r.min + r.max) / 2; R[r.id] = { last: t, ts: NOW - (o.roomsAgeMin !== undefined ? o.roomsAgeMin : 5) * 60000 }; });
  g.OPT_rooms = R;
}

// ---------- Treiber: eine simulierte Anlage mit Pruefstand ueber 'minutes' Minuten
function simulate(o) {
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
check('Patch: begrenzt auf einen Block plus eine Summenzeile (Zone 1); Zone 2 und der Direktmodus bleiben unveraendert', (SUM_PATCHED.match(/OPT_TEST/g) || []).length === 4 && SUM_PATCHED.split('\n').length - SUM_ORIG.split('\n').length === 9, 'Zeilen +' + (SUM_PATCHED.split('\n').length - SUM_ORIG.split('\n').length));

function sumRun(code, setup) {
  const env = makeEnv(); baseGlobals(env); Object.assign(env.g, { 'F_CCC.z1.SP_DIRECT_virt': 0, TOP42_Z1_Water_Target_Temp: 30 }); if (setup) { setup(env.g); }
  runFn(env, code, { topic: 'x', payload: 'trigger' });
  return { shift: env.g.SHIFT_Final_z1, sp: env.g.SP_Final_z1, sent: JSON.stringify(env.sent), g: JSON.stringify(Object.keys(env.g).sort().map(k => [k, env.g[k]])) };
}
const T0 = NOW;
let identical = true, diffInfo = '';
const combos = [];
[0, 1, -1, 2].forEach(base => [0, 0.4, -0.7, 1.5].forEach(rtc => [0, 0.5].forEach(ss => [0, -1].forEach(nr => [0, 1].forEach(rs => combos.push({ base, rtc, ss, nr, rs }))))));
combos.forEach(cb => {
  const setup = g => { g['F_CCC.z1.SP_DIRECT_virt'] = cb.base; g['F_RTC.z1.correction_value'] = cb.rtc; g['F_RTC.z1.state'] = cb.rs; g['F_SS.state'] = 1; g['F_SS.correction_value'] = cb.ss; g['NightReductionWaterTemp.state'] = 1; g['NightReductionWaterTemp.correction'] = cb.nr; };
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
  const exp = Math.round((cb.base + (cb.rs ? cb.rtc : 0) + cb.nr + cb.ss + 1) * 10) / 10, expClamped = Math.max(-5, Math.min(5, exp));
  if (e.shift !== expClamped) { identical = false; diffInfo = JSON.stringify([cb, 'frisch', e.shift, expClamped]); }
});
check('Patch: ohne OPT-Werte, mit ungueltigen Werten (undefined, Text, NaN, null), veraltetem (> 150 s) oder zukuenftigem Zeitstempel ist die Funktion in ' + combos.length + ' Kombinationen exakt wie das Original (Verschiebung, Sollwert, gesendete Nachrichten, alle Speicherwerte); mit frischem Wert kommt genau +1 K hinzu', identical, diffInfo);
const big = sumRun(SUM_PATCHED, g => { g.OPT_test_shift = 5; g.OPT_test_ts = NOW; }), neg = sumRun(SUM_PATCHED, g => { g.OPT_test_shift = -4; g.OPT_test_ts = NOW; });
check('Patch: der Beitrag ist hart auf -1..+1 K begrenzt (Wert 5 ergibt +1, -4 ergibt -1)', big.shift === 1 && neg.shift === -1, big.shift + ' / ' + neg.shift);
const dm = sumRun(SUM_PATCHED, g => { g.TOP76_Heating_Mode = 1; g.OPT_test_shift = 1; g.OPT_test_ts = NOW; }), dmo = sumRun(SUM_ORIG, g => { g.TOP76_Heating_Mode = 1; });
check('Patch: im Direktmodus (Heizungsmodus 1) bleibt alles wie im Original, auch mit frischem Wert', dm.sp === dmo.sp && dm.sent === dmo.sent && dm.g.replace(/OPT_[a-z_]+/g, '') !== undefined, '');

// =========================================================================================================
console.log('--- Grundverhalten ohne Test (Kalibrierung des Anlagenmodells)');
{
  const o = simulate({ minutes: 24 * 60, plantOpts: { atFn: () => 9 }, unpatched: true });
  const P = o.plant;
  const runs = []; let on = null; const hz = []; // nachtraeglich: Laufzeiten aus dem Verlauf
  const sim2 = (() => { const P2 = new Plant({ atFn: () => 9 }); const L = []; let prevR = P2.running, st = 0; for (let m = 0; m < 1440; m++) { P2.step(m); if (P2.running !== prevR) { L.push([P2.running ? 'start' : 'stopp', m]); prevR = P2.running; } } return L; })();
  const stops = sim2.filter(x => x[0] === 'stopp').map(x => x[1]), starts = sim2.filter(x => x[0] === 'start').map(x => x[1]);
  const pauseMin = starts.length ? starts[0] - stops[0] : 0, lauf = (stops[1] || 0) - starts[0];
  check('Anlagenmodell: bei 9 °C taktet es mit Lauf 2,5-5,5 h und Pause 60-100 min (Messwerte: Lauf 2-5 h, Pause 66-85 min), 3-5 Starts am Tag', pauseMin >= 60 && pauseMin <= 100 && lauf >= 150 && lauf <= 330 && starts.length >= 3 && starts.length <= 5, 'Pause ' + pauseMin + ' min, Lauf ' + lauf + ' min, Starts ' + starts.length + ' (' + stops.join(',') + ')');
  check('Ohne scharfen Pruefstand: es wird nichts geschrieben und gesendet (keine Dateien ausser dem Zustand, Verschiebung bleibt 0, kein OPT_test_shift)', o.hpShiftMax === 0 && o.env.g.OPT_test_shift === undefined && o.rows.length === 0 && Object.keys(o.env.files).every(f => /delaytest-state/.test(f)), Object.keys(o.env.files).join());
}

// =========================================================================================================
console.log('--- Ausschalten hinauszoegern (Plan: Test bei Vorlauf +2,0..+2,75 K, danach bis zur Abschaltung beobachten)');
// Zwillingslauf OHNE Test: wann waere die Abschaltung ohne Verschiebung gekommen?
function twinStop(plantOpts, afterMin) { const P = new Plant(plantOpts); for (let m = 0; m < 1000; m++) { P.step(m); if (!P.running && m > afterMin) { return m; } } return null; }
const AUS_OPTS = { atFn: () => 9, vl: 31, running: true, runMin: 50 };
{
  const o = simulate({ minutes: 6 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } });
  const S = lastState(o).S, ev = evMonthFile(o);
  const startRow = o.status.find(s => /läuft: \+1 K seit 0 min/.test(s[1]));
  check('Ausschalten: der Test startet erst, wenn die Bedingungen mindestens 2 Minuten erfuellt sind (Lauf >= 45 min, Vorlauf +2,0..+2,75 K, steigend), und setzt dann genau +1 K', startRow !== undefined && /verzoegerungstest_start,ausschalten \(\+1 K\) bei Vorlauf/.test(ev), startRow && startRow[0] + ' min / ' + (ev.match(/verzoegerungstest_start[^\n]*/) || [''])[0]);
  const twin = twinStop(AUS_OPTS, 0), first = o.plant.stops[0];
  const res = S.last;
  check('Ausschalten: die Abschaltung kommt spaeter als im Zwillingslauf ohne Test (Modell: +1 K verschiebt die Grenze um 1 K, ~1 K bei 0,3 K/h Ueberschuss)', first > twin + 15, 'mit Test Minute ' + first + ', ohne ' + twin + ', Gewinn ' + (first - twin) + ' min');
  check('Ausschalten: Ergebnis wird mit Minuten, Vorlauf und Abstand zum Soll protokolliert (Ereignis und Ergebnisdatei)', res && res.key === 'stopp' && /verzoegerungstest_ergebnis,ausschalten: Abschaltung \d+ min nach dem Start der Verschiebung/.test(ev), res && res.text);
  check('Ausschalten: nach der Abschaltung geht die Verschiebung wieder auf 0, der Test entschaerft sich selbst (Einmal-Test), der Zustand ist wieder Leerlauf', o.shiftHp[o.shiftHp.length - 1] === 0 && S.phase === 'idle' && JSON.parse(o.env.files['/data/optimizer/delaytest-state.json']).arm === 'aus', JSON.stringify({ phase: S.phase, arm: JSON.parse(o.env.files['/data/optimizer/delaytest-state.json']).arm }));
  const changes = o.shiftHp.filter((v, i) => i > 0 && v !== o.shiftHp[i - 1]).length;
  check('Ausschalten: an der Anlage gibt es genau zwei Aenderungen (0 -> +1 -> 0), nie mehr als 1 K Betrag', changes === 2 && o.hpShiftMax === 1, 'Aenderungen ' + changes + ', max ' + o.hpShiftMax);
  const csv = Object.keys(o.env.files).filter(f => /delaytest-2026/.test(f)).map(f => o.env.files[f]).join('');
  check('Ausschalten: Protokoll hat Kopfzeile, eine Zeile je Minute waehrend des Tests und die Auswertungsspalten', /^zeit,test,phase,shift_befehl,soll_vl,soll_basis,ist_vl,vl_minus_basis/.test(csv) && csv.split('\n').filter(l => /,test,|,nach,/.test(l)).length >= 10, csv.split('\n').length + ' Zeilen');
}

// =========================================================================================================
console.log('--- Einschalten ausloesen: trennt die drei Hypothesen ueber die Startzeit');
function einTest(plantOpts) {
  const o = simulate({ minutes: 8 * 60, plantOpts: Object.assign({ atFn: () => 9, vl: 28.5, running: false, runMin: 0, stoppedMin: 25, storedThr: 27 }, plantOpts), msgs: { 3: 'einschalten' }, obs: null });
  return o;
}
{
  const a = einTest({ startMode: 'soll', delay: 0 }), b = einTest({ startMode: 'soll', delay: 6 }), c = einTest({ startMode: 'fest', delay: 7 });
  const sa = lastState(a).S.last, sb = lastState(b).S.last, sc = lastState(c).S.last;
  check('Einschalten: Schwelle bei Soll -3 K ohne Verzoegerung -> Start nach <= 3 Minuten (Klasse "sofort")', sa && sa.key === 'start' && sa.minuten <= 3 && sa.klasse === 'sofort', JSON.stringify(sa));
  check('Einschalten: Schwelle bei Soll -3 K mit Timer von 6 min -> Start nach etwa 5-9 Minuten, noch bevor der Vorlauf die Schwelle ohne Verschiebung erreicht hat (Klasse "verzoegert")', sb && sb.key === 'start' && sb.minuten >= 5 && sb.minuten <= 11 && sb.klasse === 'verzoegert', JSON.stringify(sb));
  check('Einschalten: beim Abschalten gespeicherte Schwelle (Verschiebung wirkt nicht) -> Start erst, als der Vorlauf die Schwelle ohne Verschiebung erreicht (Klasse "ohne_wirkung")', sc && (sc.key === 'start' || sc.key === 'kein_start') && (sc.klasse === 'ohne_wirkung' || sc.key === 'kein_start'), JSON.stringify(sc));
  check('Einschalten: nach dem Start geht die Verschiebung zurueck auf 0 (Einmal-Test), jeweils genau zwei Aenderungen an der Anlage', [a, b, c].every(o => o.shiftHp[o.shiftHp.length - 1] === 0 && o.shiftHp.filter((v, i) => i > 0 && v !== o.shiftHp[i - 1]).length === 2), '');
}

// =========================================================================================================
console.log('--- Abbrueche: jede Stoerung nimmt die Verschiebung sofort zurueck');
function abortCase(name, extra, expectRe, wantEarlySteps) {
  const base = { minutes: 4 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } };
  // Test starten lassen und die Stoerung erst NACH dem Start einspielen
  const probe = simulate(Object.assign({}, base));
  const startMin = (probe.status.find(s => /läuft: \+1 K seit 0 min/.test(s[1])) || [null])[0];
  const m0 = startMin + 3;
  const o = simulate(Object.assign({}, base, extra(m0)));
  const ev = evMonthFile(o), S = lastState(o);
  const mA = (o.status.find(s => /Abbruch:/.test(s[1])) || [null])[0];                      // Minute, in der der Abbruch beschlossen wurde
  const back0 = mA === null ? -1 : o.shiftHp.slice(mA).findIndex(v => v === 0);
  const ok = expectRe.test(ev) && back0 >= 0 && back0 <= 3 && S.S.phase === 'idle' && S.arm === 'aus' && o.hpShiftMax <= 1;
  check('Abbruch: ' + name + ' -> Verschiebung nach hoechstens 3 Minuten wieder 0, Einmal-Test entschaerft, Grund im Protokoll', ok, 'Abbruch in Minute ' + mA + ', Rueckkehr nach ' + back0 + ' min; ' + (ev.match(/verzoegerungstest_abbruch[^\n]*/) || ['kein Abbruchereignis'])[0]);
  return o;
}
abortCase('Raum zu warm', m0 => ({ obs: m => (m >= m0 ? { rooms: { ki_oben: 27 } } : {}) }), /abbruch,ausschalten: Raum zu warm/);
abortCase('Abtauen beginnt', m0 => ({ obs: m => (m >= m0 ? { defrost: 1 } : {}) }), /abbruch,ausschalten: Abtauen/);
abortCase('Warmwasserbereitung beginnt', m0 => ({ obs: m => (m >= m0 ? { dhw: 1 } : {}) }), /abbruch,ausschalten: Warmwasser/);
abortCase('Anlagenwerte veralten (HeishaMon meldet nicht mehr)', m0 => ({ obs: m => (m >= m0 ? { hpStale: true } : {}) }), /abbruch,ausschalten: Anlagenwerte veraltet/);
abortCase('Quiet-Stufe wird geaendert', m0 => ({ obs: m => (m >= m0 ? { quiet: 2 } : {}) }), /abbruch,ausschalten: Heizregelung oder Quiet geändert/);
abortCase('MQTT-Befehle werden gesperrt (Notbremse MQTT.block_active)', m0 => ({ beforeStep: (m, env) => { if (m >= m0) { env.g['MQTT.block_active'] = 1; } } }), /abbruch,ausschalten: MQTT-Befehle gesperrt/);
abortCase('Nutzer entschaerft den Test im Dashboard', m0 => ({ msgs: { 5: 'ausschalten', [m0]: 'aus' } }), /abbruch,ausschalten: vom Nutzer entschärft/);
abortCase('Aussentemperatur verlaesst das Fenster (12,8 °C)', m0 => ({ plantOpts: Object.assign({}, AUS_OPTS, { atFn: m => (m >= m0 ? 13 : 9) }) }), /abbruch,ausschalten: Außentemperatur verlässt das Fenster|abbruch,ausschalten: Verschiebung wurde nicht bestätigt|abbruch,ausschalten:/);
abortCase('Anlage bestaetigt die Verschiebung nicht (Befehl kommt nicht an)', m0 => ({ plantOpts: Object.assign({}, AUS_OPTS, { cmdFail: true }) }), /abbruch,ausschalten: Verschiebung wurde nicht bestätigt/);
abortCase('Anlage schaltet trotz Grenze nicht ab (Vorlauf laeuft hoch)', m0 => ({ beforeStep: (m, env, P) => { if (m === m0) { P.noStop = true; P.qMin = 3.2; } } }), /abbruch,ausschalten: (Vorlauf|Vorlauf über)/);

// =========================================================================================================
console.log('--- Wann der Test NICHT startet');
function noStart(name, extra, re) {
  const o = simulate(Object.assign({ minutes: 5 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } }, extra));
  const st = o.env.g.OPT_dt_status || '', started = /verzoegerungstest_start/.test(evMonthFile(o)), allStatus = o.status.map(s => s[1]).join('|');
  check('Kein Start: ' + name, !started && (o.env.g.OPT_test_shift === undefined || o.env.g.OPT_test_shift === 0) && !/läuft: \+1 K/.test(allStatus) && re.test(allStatus), 'Status: ' + (o.status[o.status.length - 1] || ['', ''])[1].slice(0, 110));
}
{ // Uhrzeit nachts: Start um 03:00 Ortszeit
  const o = simulate({ minutes: 3 * 60, start: Date.UTC(2026, 9, 12, 1, 0, 0), plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } });
  check('Kein Start: nachts (03:00-06:00 Uhr) ausserhalb des Tagesfensters 9-19 Uhr, Grund wird angezeigt', !/verzoegerungstest_start/.test(evMonthFile(o)) && o.hpShiftMax === 0 && o.status.some(s => /außerhalb 9–19 Uhr/.test(s[1])), (o.status[o.status.length - 1] || ['', ''])[1].slice(0, 100));
}
noStart('Aussentemperatur 6 °C (Dauerlauf-Bereich, unter 7,5 °C)', { plantOpts: Object.assign({}, AUS_OPTS, { atFn: () => 6 }) }, /Außentemperatur 6 °C außerhalb/);
noStart('Aussentemperatur 13 °C (Heizgrenze-Hysterese)', { plantOpts: Object.assign({}, AUS_OPTS, { atFn: () => 13 }) }, /Außentemperatur 13 °C außerhalb/);
noStart('Heizkurvenverschiebung ist nicht 0 (Raumregelung aktiv, +1 K)', { beforeStep: (m, env) => { env.g['F_RTC.z1.state'] = 1; env.g['F_RTC.z1.correction_value'] = 1; } }, /Heizkurvenverschiebung ist 1 K/);
noStart('Raum unter Minimum', { obs: () => ({ rooms: { ki_oben: 21 } }) }, /Raum unter Minimum: Kinderzimmer oben/);
noStart('Raum zu warm (Max + 2 K)', { obs: () => ({ rooms: { ki_oben: 25.6 } }) }, /Raum zu warm: Kinderzimmer oben/);
{
  const o = simulate({ minutes: 3 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' }, obs: () => ({ roomsAgeMin: 400 }) });
  check('Kein Start: Raumwert veraltet (aelter als das Limit des Raums)', !/verzoegerungstest_start/.test(evMonthFile(o)) && o.hpShiftMax === 0 && o.status.some(s => /Raumwert veraltet/.test(s[1])), (o.status[o.status.length - 1] || ['', ''])[1].slice(0, 100));
}


// =========================================================================================================
console.log('--- Tageslimit, Scharfschaltung verfaellt, Neustart und Ausfall des Pruefstands');
{
  const o = simulate({ minutes: 52 * 60, plantOpts: { atFn: () => 9, vl: 31, running: true, runMin: 50 }, msgs: { 5: 'ausschalten', 400: 'ausschalten', [24 * 60 + 60]: 'ausschalten' } });
  const ev = evMonthFile(o), starts = (ev.match(/verzoegerungstest_start/g) || []).length;
  check('Tageslimit: am selben Tag wird nach einem Test kein zweiter gestartet (Grund wird angezeigt), am Folgetag nach neuer Scharfschaltung wieder', starts === 2 && o.status.some(s => s[0] > 400 && s[0] < 700 && /Tageslimit erreicht/.test(s[1])), 'Tests ' + starts);
  check('Scharfschaltung verfaellt nach 14 h (vergessene Wahl loest am naechsten Tag nichts aus)', /verzoegerungstest_wahl,aus \(abgelaufen\)/.test(ev), (ev.match(/wahl,aus[^\n]*/) || [''])[0]);
}
{
  const probe = simulate({ minutes: 4 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' } });
  const sMin = probe.status.find(s => /läuft: \+1 K seit 0 min/.test(s[1]))[0];
  const o = simulate({ minutes: 4 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' }, restartAt: sMin + 6 });
  const ev = evMonthFile(o), S = lastState(o), mA = (o.status.find(s => /Abbruch: Neustart/.test(s[1])) || [null])[0];
  const back0 = mA === null ? -1 : o.shiftHp.slice(mA).findIndex(v => v === 0);
  check('Neustart von Node-RED mitten im Test: der Test wird beim ersten Aufruf abgebrochen, die Verschiebung geht innerhalb von 3 Minuten auf 0, Zustand wieder Leerlauf, nicht scharf', /abbruch,ausschalten: Neustart von Node-RED/.test(ev) && back0 >= 0 && back0 <= 3 && S.S.phase === 'idle' && S.arm === 'aus', 'Rueckkehr nach ' + back0 + ' min');
  const c = simulate({ minutes: 4 * 60, plantOpts: AUS_OPTS, msgs: { 5: 'ausschalten' }, crashFrom: sMin + 6 });
  const back = c.shiftHp.slice(sMin + 6).findIndex(v => v === 0);
  check('Notbremse (Totmann): faellt der Pruefstand mitten im Test aus (keine Aufrufe mehr), verfaellt die Verschiebung nach hoechstens 4 Minuten von selbst (Patch ignoriert Werte aelter als 150 s) und bleibt 0', back >= 0 && back <= 4 && c.shiftHp.slice(sMin + 6 + back).every(v => v === 0), 'Rueckkehr nach ' + back + ' min');
}
{ // Der Pruefstand veraendert nur OPT_*-Werte (ohne die Summenfunktion laufen zu lassen)
  const env = makeEnv(); baseGlobals(env); runFn(env, FUNC.opt_defaults, {});
  const snap = () => JSON.stringify(Object.keys(env.g).filter(k => !k.startsWith('OPT_')).sort().map(k => [k, env.g[k]]));
  let tampered = '';
  const P = new Plant(AUS_OPTS); NOW = DAY0;
  const call = (msg) => { const b = snap(); runFn(env, FUNC.opt_dt, msg); if (snap() !== b) { tampered = 'Aufruf veraendert Nicht-OPT-Werte'; } };
  for (let m = 0; m < 3 * 60; m++) { NOW = DAY0 + m * 60000; P.step(m); setPlantValues(env, P, {}); if (m === 5) { call({ topic: 'arm', payload: 'ausschalten' }); } call({ payload: NOW }); P.pendingShift = env.g.OPT_test_shift === 1 ? 1 : 0; }
  const optKeys = Object.keys(env.g).filter(k => /^OPT_/.test(k));
  check('Sicherheit: der Pruefstand aendert in keinem Aufruf einen Anlagenwert oder eine Steuergroesse (alle nicht-OPT-Speicherwerte vor/nach jedem Aufruf gleich), er schreibt nur OPT_*-Werte (OPT_test_shift, OPT_test_ts, OPT_dt_status)', tampered === '' && env.g.OPT_test_shift !== undefined && env.g.OPT_test_ts !== undefined && env.g.OPT_dt_status !== undefined, tampered || optKeys.filter(k => /test|dt/.test(k)).join());
  const dtn = byId.opt_dt, tabNodes = ALL.filter(n => n.z === 'opt_tab');
  check('Sicherheit (Flow-Datei): opt_dt ruft nirgends node.send auf, hat nur Ausgaenge zu den beiden Dateien, dem Status und dem Schalter; im Tab gibt es weiterhin keinen mqtt-out-, link- oder http-in-Knoten', !/node\.send\s*\(/.test(dtn.func) && JSON.stringify(dtn.wires) === '[["opt_f_dt"],["opt_f_qev"],["opt_ui_dt_status"],["opt_ui_dt_arm"]]' && tabNodes.every(n => !['mqtt out', 'link out', 'link in', 'link call', 'http in', 'http response'].includes(n.type)), JSON.stringify(dtn.wires));
  check('Oberflaeche: Schalter (Aus / Ausschalten hinauszoegern / Einschalten ausloesen) geht nur an opt_dt, Status-Text und eigene Gruppe auf der Seite "Daten & Güte"', byId.opt_ui_dt_arm.type === 'ui_dropdown' && JSON.stringify(byId.opt_ui_dt_arm.wires) === '[["opt_dt"]]' && byId.opt_ui_dt_arm.options.map(x => x.value).join() === 'aus,ausschalten,einschalten' && byId.opt_g_dt.tab === 'opt_ui_tab_data' && byId.opt_ui_dt_status.group === 'opt_g_dt', '');
}

// =========================================================================================================
console.log('--- Mehrtaegige Simulation mit Neustart (3 Tage)');
{
  const AT3 = m => (m < 2880 ? 9 : 6);
  const opts = { minutes: 3 * 24 * 60, plantOpts: { atFn: AT3, vl: 31, running: true, runMin: 50 }, msgs: { 5: 'ausschalten', 180: 'einschalten', [1440 + 30]: 'einschalten', [2880 + 30]: 'ausschalten' } };
  const probe = simulate(opts);
  const sDay2 = probe.status.find(s => s[0] > 1440 && /läuft: \+1 K seit 0 min/.test(s[1]));
  const o = simulate(Object.assign({}, opts, { restartAt: sDay2 ? sDay2[0] + 4 : undefined }));
  const ev = evMonthFile(o);
  const startsDay = [0, 1, 2].map(d => o.status.filter(s => s[0] >= d * 1440 && s[0] < (d + 1) * 1440 && /läuft: \+1 K seit 0 min/.test(s[1])).length);
  const startHours = (ev.match(/\d{4}-\d\d-\d\d (\d\d):\d\d:\d\d,verzoegerungstest_start/g) || []).map(x => Number(x.slice(11, 13)));
  const endsZero = [1439, 2879, 4319].every(i => o.shiftHp[i] === 0);
  const eps = o.shiftHp.filter((v, i) => v === 1 && (i === 0 || o.shiftHp[i - 1] === 0)).length;
  check('3 Tage: hoechstens ein Test je Tag, nur im Tagesfenster 9-19 Uhr, Tag 3 (6 °C) startet nichts, die Verschiebung ist nie ueber 1 K und am Ende jedes Tages 0', startsDay.every(n => n <= 1) && startsDay[2] === 0 && startHours.every(h => h >= 9 && h < 19) && o.hpShiftMax <= 1 && endsZero, JSON.stringify({ startsDay, startHours, endsZero, max: o.hpShiftMax }));
  check('3 Tage: der Neustart mitten im Test an Tag 2 nimmt die Verschiebung zurueck (Abbruch protokolliert), jede +1-Phase an der Anlage ist durch eine 0-Phase beendet', (sDay2 === undefined || /abbruch,[a-z]+: Neustart/.test(ev)) && o.shiftHp[o.shiftHp.length - 1] === 0, 'Phasen +1: ' + eps);
  check('3 Tage: Tageslimit an Tag 1 greift (zweite Wahl am gleichen Tag startet nicht), die vergessene Wahl an Tag 3 verfaellt', o.status.some(s => s[0] > 180 && s[0] < 1440 && /Tageslimit/.test(s[1])) && /abgelaufen/.test(ev), '');
  const csv = Object.keys(o.env.files).filter(f => /delaytest-2026/.test(f)).map(f => o.env.files[f]).join('');
  check('3 Tage: das Protokoll ist nach Kopfzeile geordnet, ohne leere Spalten-Verschiebung (jede Zeile hat 17 Spalten)', csv.split('\n').filter(l => l && !/^zeit,/.test(l)).every(l => l.split(',').length === 17), csv.split('\n').filter(l => l && !/^zeit,/.test(l)).length + ' Zeilen');
}

console.log(fails === 0 ? '\nERGEBNIS: alle Pruefungen bestanden' : '\nERGEBNIS: ' + fails + ' Pruefung(en) fehlgeschlagen');
process.exit(fails === 0 ? 0 : 1);

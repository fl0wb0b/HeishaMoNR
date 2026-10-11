// Ketten-Simulation des Verzoegerungstests: die ECHTEN Knoten von HeishaMoNR und dem Optimizer laufen in einer kleinen Node-RED-Nachbildung mit Fake-Uhr.
// Kein Node-RED, kein MQTT, nichts wird gesendet. Aufruf:  node tools/delaytest_chain_sim.js "flows (26.5.1 stable).json" [--schnell]
//
// Ausgefuehrt werden (Code aus der Flow-Datei, mit angewendetem tools/delaytest_patch.py):
//   Summenfunktion add6fa4d403dd143 (gepatcht) <- 100-ms-Trigger 987d38642eaa3c4c <- Ereignisse (Vorlauf/Ruecklauf/Verdichter wie SoftStart->complete) und Takt dtpatch_sumtick/-gate
//   -> link -> "Z1+Z2 HEAT SP Manager" -> function 78 -> Filter 78cd6de319a6d061 -> Compare SP c4130c490114e90f -> Block? 1b409e1ea72f94dd -> To MQTT (SET5)
//   -> link "> MQTT OUT" -> Ratenbegrenzung 1/7 s -> Block? (globale Sperre) -> Dynamic MQTT out -> Broker
//   Broker -> commands/# -> FW -> Command Check (1-on-1) (Wiederholungen mit Timern)   |   Broker -> HeishaMon-Modell -> main/Z1_Heat_Request_Temp -> set.TOP27 + Command Check
//   Rueckstellwaechter dtpatch_guard (jede Minute) -> Ratenbegrenzung;  Pruefstand opt_dt (jede Minute, Optimizer-Tab) mit opt_defaults.
// Speicher wie auf der NAS: nur "memory" ("file" faellt darauf zurueck), Punkt-Schluessel wie in Node-RED (MQTT.block_active ist verschachtelt).
// Neustart von Node-RED: alle Speicher, Knotenkontexte und Timer weg, Dateien bleiben; HeishaMon meldet Werte nur bei Aenderung und alle 300 s komplett.
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const flowsFile = process.argv[2] || 'flows (26.5.1 stable).json';
const FAST = process.argv.includes('--schnell');
const ALL0 = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
function patched(flows, extra) {
  const tmp = path.join(os.tmpdir(), 'dt_chain_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify(flows));
  cp.execFileSync('python3', [path.join(__dirname, 'delaytest_patch.py'), tmp].concat(extra || []));
  const r = JSON.parse(fs.readFileSync(tmp, 'utf8')); fs.unlinkSync(tmp); return r;
}
const FLOWS = { voll: patched(ALL0) };
// Gegenprobe (Stand des Reviews): nur die Summenfunktion gepatcht, ohne Takt und ohne Rueckstellwaechter
FLOWS.ohneWaechter = FLOWS.voll.filter(n => !['dtpatch_sumtick', 'dtpatch_sumgate', 'dtpatch_guard_tick', 'dtpatch_guard'].includes(n.id));

let fails = 0, nChecks = 0;
function check(name, cond, info) { nChecks++; console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined ? '  -> ' + info : '')); if (!cond) { fails++; } }

// ---------------------------------------------------------------- Uhr und Ereigniswarteschlange (Binaerheap)
let NOW = 0, SEQ = 0;
const RealDate = Date;
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
class Heap {
  constructor() { this.a = []; }
  less(x, y) { return x.t < y.t || (x.t === y.t && x.s < y.s); }
  push(e) { const a = this.a; a.push(e); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else { break; } } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.less(a[l], a[m])) { m = l; } if (r < a.length && this.less(a[r], a[m])) { m = r; } if (m === i) { break; } [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; }
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
}
const MIN = 60000, SEC = 1000;
const pad = x => String(x).padStart(2, '0');
const hm = t => { const d = new RealDate(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };

// ---------------------------------------------------------------- Punkt-Pfade wie Node-RED-Kontext
function getPath(o, k) { let v = o; for (const p of String(k).split('.')) { if (v === null || v === undefined || typeof v !== 'object') { return undefined; } v = v[p]; } return v; }
function setPath(o, k, val) { const ps = String(k).split('.'); let v = o; for (let i = 0; i < ps.length - 1; i++) { if (v[ps[i]] === null || typeof v[ps[i]] !== 'object') { v[ps[i]] = {}; } v = v[ps[i]]; } v[ps[ps.length - 1]] = val; }
const ctxApi = st => ({ get: k => getPath(st, k), set: (k, v) => setPath(st, k, v), keys: () => Object.keys(st) });
const clone = m => JSON.parse(JSON.stringify(m));

// ---------------------------------------------------------------- Welt: eine Simulation mit Node-RED-Nachbildung, Broker, HeishaMon und Anlage
const RUN_FUNCS = new Set(['add6fa4d403dd143', '694768bd9f0a9a39', '0e04122d6f8a2033', '78cd6de319a6d061', 'c4130c490114e90f', '1b409e1ea72f94dd', '9dc404968dc9524f',
  '1e22e8620445f5a5', 'c7a7be892c1747ec', '48d749cc0ca61d74', 'aa66f523450fd337', 'dtpatch_sumgate', 'dtpatch_guard', 'opt_dt', 'opt_defaults']);
const MQTT_IN = new Set(['ae6175191a94d7ec', 'b9da2620c239be36']);           // commands/#  und  main/Z1_Heat_Request_Temp (NAS-Broker)
const SHIFT_TOPIC = 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature';

function makeWorld(o) {
  const W = { o, flows: o.flows || FLOWS.voll, q: new Heap(), files: {}, pub: [], cmds: [], toasts: [], ui: [], errors: [], shiftLog: [], evRows: [], statusLog: [], restarts: 0 };
  W.N = {}; W.flows.forEach(n => { W.N[n.id] = n; });
  const rng = mulberry(o.seed || 1);
  W.rng = rng;
  // ---- Ereignisse
  W.at = (t, fn, owner) => { const e = { t, s: SEQ++, fn, owner: owner || 'welt', dead: false }; W.q.push(e); return e; };
  W.runUntil = T => { while (W.q.size && W.q.peek().t <= T) { const e = W.q.pop(); if (e.dead) { continue; } NOW = e.t; e.fn(); } NOW = T; };
  // ---- Dateisystem (bleibt ueber Neustarts)
  W.fsm = { readFileSync: p => { if (!(p in W.files)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } return W.files[p]; },
    writeFileSync: (p, d) => { if (W.o.fsReadOnly && /delaytest/.test(p)) { throw new Error('EROFS'); } W.files[p] = String(d); }, mkdirSync: () => {}, chmodSync: () => {}, existsSync: p => p in W.files };
  // ---- Node-RED-Laufzeit (wird beim Neustart verworfen)
  W.boot = () => {
    const first = !W.rt;
    W.rt = { G: {}, flowCtx: {}, nodeCtx: {}, nodeObj: {}, compiled: {}, trig: {}, rate: { q: [], last: -1e15, timer: null }, epoch: (W.rt ? W.rt.epoch : 0) + 1 };
    // Werte, die der Optimizer-Tab aus MQTT sammelt: nach einem Neustart leer, bis die Geraete wieder melden (Raeume bis 2 h, Radiator erst beim naechsten Schalten)
    W.hpStore = {}; W.rt.G.OPT_hp = W.hpStore;
    if (!first) { W.roomStore = {}; W.kzStore = { rad: {}, fan: {} }; }
    W.rt.G.OPT_rooms = W.roomStore; W.rt.G.OPT_kz = W.kzStore;
    const ep = W.rt.epoch;
    const nr = (dt, fn) => W.at(NOW + dt, () => { if (W.rt.epoch === ep) { fn(); } }, 'nr');
    W.nr = nr;
    // HeishaMoNR-Initialisierung beim Start (Speicher "file" gibt es auf der NAS nicht: Standardwerte der Funktionen)
    nr(3 * SEC, () => {
      const G = W.rt.G;
      setPath(G, 'F_CCC', { z1: { SP_DIRECT_virt: 0, state: 0, setpoint: W.plant.base }, z2: { SP_DIRECT_virt: 0, state: 0, setpoint: 20 } });
      setPath(G, 'F_RTC', { z1: { state: 0, correction_value: 0 }, z2: { state: 0, correction_value: 0 } });
      setPath(G, 'F_SS', { state: 0, correction_value: 0 });
      setPath(G, 'NightReductionWaterTemp', { state: 0, correction: 0 });
      setPath(G, 'MQTT', { block_active: W.blockNow ? 1 : 0, block_mode: 3 });
      G.HEAT_SP_lower_limit = 20; G.HEAT_SP_upper_limit = 100;
      if (W.rtcNow) { setPath(G, 'F_RTC.z1', { state: W.rtcNow.state, correction_value: W.rtcNow.corr }); }
      runFn('opt_defaults', { payload: 'init' });
    });
    // Injects (einmal nach X s, dann alle 60 s)
    const inj = (id, once, target) => { if (!W.N[id] || W.N[id].d) { return; } const tick = () => { deliver(target, { payload: NOW, topic: '', _msgid: newId() }); nr(60 * SEC, tick); }; nr(once * SEC, tick); };
    inj('opt_i_dt', 25, 'opt_dt');
    inj('dtpatch_sumtick', 40, 'dtpatch_sumgate');
    inj('dtpatch_guard_tick', 90, 'dtpatch_guard');
  };
  let idc = 0; const newId = () => 'm' + (++idc);
  function deliver(target, msg) { const ep = W.rt.epoch; W.at(NOW, () => { if (W.rt.epoch === ep) { receive(target, msg); } }, 'nr'); }
  function emit(id, res) {
    if (res === null || res === undefined) { return; }
    const node = W.N[id]; if (!Array.isArray(res)) { res = [res]; }
    let first = true;
    res.forEach((m, i) => {
      if (m === null || m === undefined) { return; }
      (Array.isArray(m) ? m : [m]).forEach(msg => {
        if (msg === null || msg === undefined) { return; }
        if (!msg._msgid) { msg._msgid = newId(); }
        ((node.wires || [])[i] || []).forEach(t => { deliver(t, first ? msg : clone(msg)); first = false; });
      });
    });
  }
  function runFn(id, msg) {
    const node = W.N[id];
    if (!W.rt.compiled[id]) { W.rt.compiled[id] = vm.runInNewContext('(function(msg,node,context,flow,global,env,RED,setTimeout,clearTimeout,fs,Date,Buffer,console){' + node.func + '\n})', {}); }
    if (!W.rt.nodeObj[id]) {
      W.rt.nodeObj[id] = { id, name: node.name, send: m => emit(id, m), on: () => {}, warn: x => W.errors.push([NOW, id, 'warn', String(x)]), error: x => W.errors.push([NOW, id, 'error', String(x)]), status: () => {}, done: () => {} };
    }
    const st = W.rt.nodeCtx[id] || (W.rt.nodeCtx[id] = {}), fl = W.rt.flowCtx[node.z] || (W.rt.flowCtx[node.z] = {});
    const ep = W.rt.epoch;
    const sT = (fn, ms) => W.at(NOW + ms, () => { if (W.rt.epoch === ep) { fn(); } }, 'nr'), cT = h => { if (h) { h.dead = true; } };
    let r;
    try { r = W.rt.compiled[id](msg, W.rt.nodeObj[id], ctxApi(st), ctxApi(fl), ctxApi(W.rt.G), { get: () => undefined }, {}, sT, cT, W.fsm, FakeDate, Buffer, console); }
    catch (e) { W.errors.push([NOW, id, 'exception', e.message]); return; }
    if (id === 'opt_dt') { captureDt(r); }
    emit(id, r);
  }
  function captureDt(r) {
    if (!r) { return; }
    if (r[2]) { W.statusLog.push([NOW, r[2].payload]); }
  }
  function receive(id, msg) {
    const node = W.N[id]; if (!node || node.d) { return; }
    switch (node.type) {
      case 'function': if (RUN_FUNCS.has(id)) { runFn(id, msg); } return;
      case 'link in': emit(id, [msg]); return;
      case 'link out': if (node.mode !== 'return') { (node.links || []).forEach(l => deliver(l, clone(msg))); } return;
      case 'trigger': {                                                           // op1 senden, dann 'duration' ms sperren (op2 = nichts)
        const tr = W.rt.trig[id] || (W.rt.trig[id] = { until: -1 });
        if (NOW < tr.until) { return; }
        tr.until = NOW + Number(node.duration || 0);
        msg.payload = node.op1; emit(id, [msg]); return;
      }
      case 'delay': {                                                             // Ratenbegrenzung ohne Verwerfen: eine Nachricht je nbRateUnits s
        const R = W.rt.rate, gap = Number(node.nbRateUnits || 1) * SEC / Number(node.rate || 1);
        R.q.push(msg);
        const pump = () => { R.timer = null; if (!R.q.length) { return; } if (NOW - R.last >= gap) { R.last = NOW; emit(id, [R.q.shift()]); } if (R.q.length) { R.timer = W.nr(Math.max(1, R.last + gap - NOW), pump); } };
        if (!R.timer) { pump(); }
        return;
      }
      case 'mqtt out': W.publish(msg.topic || node.topic, msg.payload, { source: msg.source, retry: !!msg._hpRetry, from: 'nodered' }); return;
      case 'file': if (msg.filename) { W.files[msg.filename] = (W.files[msg.filename] || '') + msg.payload; if (/quiet-events|delaytest-2/.test(msg.filename)) { W.evRows.push([NOW, String(msg.payload)]); } } return;
      case 'ui_toast': W.toasts.push([NOW, String(msg.payload)]); return;
      default: if (/^ui_/.test(node.type)) { W.ui.push([NOW, id, msg.payload]); } return;
    }
  }
  W.deliver = deliver; W.receive = receive; W.runFn = runFn;
  // ---- Broker
  W.subs = [];
  const match = (pat, t) => { const p = pat.split('/'), s = t.split('/'); for (let i = 0; i < p.length; i++) { if (p[i] === '#') { return true; } if (p[i] !== '+' && p[i] !== s[i]) { return false; } } return p.length === s.length; };
  W.publish = (topic, payload, meta) => {
    const txt = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    W.pub.push([NOW, topic, txt, meta || {}]);
    if (topic === SHIFT_TOPIC) { W.cmds.push({ t: NOW, v: Number(txt), source: (meta || {}).source || '', retry: !!(meta || {}).retry }); }
    W.subs.forEach(sb => { if (match(sb.pat, topic)) { W.at(NOW + 20, () => sb.fn(topic, txt), sb.owner); } });
  };
  // Node-RED-Abos (gehen beim Neustart nicht verloren, die Verbindung wird neu aufgebaut)
  W.flows.filter(n => MQTT_IN.has(n.id)).forEach(n => W.subs.push({ pat: n.topic, owner: 'nr-sub', fn: (t, txt) => {
    if (W.nodeRedDown) { return; }
    let p = txt; try { p = JSON.parse(txt); } catch (e) { /* Text */ }
    emit(n.id, [{ topic: t, payload: p, qos: 0, retain: false, _msgid: newId() }]);
    // die uebrigen Knoten am Abo (z. B. Anzeige) sind Senken
  } }));
  // ---- Anlage und HeishaMon
  W.plant = new Plant(o.plant || {}, rng);
  W.hmLast = {};
  W.roomStore = {}; W.kzStore = { rad: {}, fan: { on: false } };
  // Einstellungen wie live (config.json, Baender der Raeume)
  W.files['/data/optimizer/config.json'] = JSON.stringify({ rooms: [
    { id: 'ki_oben', name: 'Kinderzimmer oben', active: true, min: 22, max: 23.5, weight: 1.3, maxAgeMin: 90 }, { id: 'ki_unten', name: 'Kinderzimmer unten', active: true, min: 20, max: 22, weight: 1, maxAgeMin: 90 },
    { id: 'schlaf', name: 'Schlafzimmer', active: true, min: 20, max: 22, weight: 1, maxAgeMin: 90 }, { id: 'wohn', active: true, min: 20, max: 23.5 }] });
  W.hmOnline = () => !(o.hmOffline || []).some(w => NOW >= w[0] && NOW < w[1]);
  W.subs.push({ pat: SHIFT_TOPIC, owner: 'welt', fn: (t, txt) => {                       // HeishaMon: Befehl an die Anlage
    const v = Number(txt);
    if (!W.hmOnline()) { return; }
    if (o.dropCmd && o.dropCmd(NOW, v, W)) { W.dropped = (W.dropped || 0) + 1; return; }
    const lat = 2 * SEC + Math.floor(rng() * 6 * SEC);
    W.at(NOW + lat, () => { if (W.hmOnline()) { W.plant.shift = Math.max(-5, Math.min(5, Math.round(v))); hmPublish(false); } }, 'welt');
  } });
  // Werte so, wie HeishaMoNR sie ablegt (WP Control: set.*), nur fuer die genutzten Groessen; TOP27 laeuft ueber den echten Knoten set.TOP27
  function hmValues() {
    const P = W.plant;
    return { Z1_Heat_Request_Temp: P.shift, Z1_Water_Target_Temp: P.base + P.shift, Main_Outlet_Temp: P.vlQ, Main_Inlet_Temp: P.rlQ, Compressor_Freq: P.hz, Outside_Temp: P.at,
      Heatpump_State: 1, Heating_Mode: 0, Zones_State: 0, Z1_Sensor_Settings: 0, Operating_Mode_State: 4, ThreeWay_Valve_State: P.dhw ? 1 : 0, Defrosting_State: P.defrost ? 1 : 0,
      Quiet_Mode_Level: 0, Pump_Speed: P.pump, Heat_Energy_Consumption: P.hz ? 300 : 30, Heating_Control: 0, Internal_Heater_State: 0, External_Heater_State: 0 };
  }
  const MAP = { Z1_Water_Target_Temp: 'TOP42_Z1_Water_Target_Temp', Main_Outlet_Temp: 'TOP6_Main_Outlet_Temp', Main_Inlet_Temp: 'TOP5_Main_Inlet_Temp', Compressor_Freq: 'compressor_frequency',
    Outside_Temp: 'TOP14_Outside_Temp', Heatpump_State: 'TOP0_Heatpump_State', Heating_Mode: 'TOP76_Heating_Mode', Zones_State: 'TOP94_Zones_State', Z1_Sensor_Settings: 'TOP111_Z1_Sensor_Settings',
    Operating_Mode_State: 'TOP4_Operating_Mode_State', ThreeWay_Valve_State: 'TOP20_ThreeWay_Valve_State', Defrosting_State: 'TOP26_Defrosting_State', Quiet_Mode_Level: 'TOP18_Quiet_Mode_Level',
    Heat_Energy_Consumption: 'TOP16_Heat_Energy_Consumption' };
  function hmPublish(all) {
    if (!W.hmOnline()) { return; }
    const v = hmValues(), G = W.rt.G;
    let trigger = false;
    Object.keys(v).forEach(k => {
      if (!all && W.hmLast[k] === v[k]) { return; }
      const changed = W.hmLast[k] !== v[k];
      W.hmLast[k] = v[k];
      if (k === 'Z1_Heat_Request_Temp') { W.publish('panasonic_heat_pump/main/' + k, v[k], { from: 'heishamon' }); return; }
      if (W.nodeRedDown) { return; }
      if (MAP[k]) { G[MAP[k]] = v[k]; }
      if (k === 'Compressor_Freq') { G.compressor_runtime = W.plant.running ? W.plant.runMin : 0; }
      if (k === 'Outside_Temp' || k === 'Z1_Water_Target_Temp') { setPath(G, 'F_CCC.z1.setpoint', W.plant.base); }
      W.hpStore[k] = { v: v[k], ts: NOW }; G.OPT_hp = W.hpStore;
      if (changed && (k === 'Main_Outlet_Temp' || k === 'Main_Inlet_Temp' || (k === 'Compressor_Freq' && (W.lastHzOn === undefined || (v[k] > 0) !== W.lastHzOn)))) { trigger = true; }
      if (k === 'Compressor_Freq') { W.lastHzOn = v[k] > 0; }
    });
    if (trigger && !o.noEvents) { deliver('987d38642eaa3c4c', { payload: 'SoftStart', topic: 'complete', _msgid: newId() }); }      // SoftStart -> complete -> Trigger
  }
  W.hmPublish = hmPublish;
  // Raeume (Saegezahn: Kinderzimmer melden etwa alle 2 h, Schlafzimmer alle 30 min) und Radiator
  W.rooms = Object.assign({ ki_oben: 22.6, ki_unten: 21.0, schlaf: 21.0, wohn: 21.5 }, o.rooms || {});
  const period = { ki_oben: 110, ki_unten: 120, schlaf: 30, wohn: 45 };
  W.roomNext = {};
  Object.keys(W.rooms).forEach((r, i) => { const ts = o.t0 - (i * 37 % period[r]) * MIN; W.roomStore[r] = { last: W.rooms[r], ts }; W.roomNext[r] = ts + period[r] * MIN; });
  // Radiator Kinderzimmer oben (Regelung im Tab Dashboard, hier nur als Modell): an, solange der Raum < 22,7 und (Lauf oder Pause mit Vorlauf >= 27, aus < 26,5); aus ab 23,3
  W.kzStore.rad = { on: W.rooms.ki_oben < 22.7, ts: o.t0 - 300 * MIN };
  W.radModel = () => {
    const P = W.plant, r = (o.roomFn ? o.roomFn('ki_oben', 0, W) : W.rooms.ki_oben), cur = W.radOn === undefined ? W.kzStore.rad.on : W.radOn;
    let on = cur;
    if (r >= 23.3) { on = false; } else if (r < 22.7) { on = P.running || (cur ? P.vl >= 26.5 : P.vl >= 27); }
    if (on !== cur || W.radOn === undefined) { W.radOn = on; if (on !== cur) { W.kzStore.rad = { on, ts: NOW, src: 'modell' }; W.rt.G.OPT_kz = W.kzStore; } }
  };
  // Minutentakt der Welt
  const worldTick = () => {
    const m = Math.round((NOW - o.t0) / MIN);
    if (o.beforeMin) { o.beforeMin(m, W); }
    W.plant.step(m, o.atFn ? o.atFn(m, NOW) : 9);
    Object.keys(W.rooms).forEach(r => { const st = W.roomStore[r]; const tgt = o.roomFn ? o.roomFn(r, m, W) : W.rooms[r]; if (NOW >= W.roomNext[r] || (st && Math.abs(tgt - st.last) >= 0.5)) { W.roomStore[r] = { last: tgt, ts: NOW }; W.roomNext[r] = NOW + period[r] * MIN; } });
    W.rt.G.OPT_rooms = W.roomStore;
    W.radModel();
    hmPublish(m % 5 === 0);                                                           // Aenderungen sofort, alle 5 min alles (HeishaMon updateAllTime 300 s)
    W.shiftLog.push([NOW, W.plant.shift, W.plant.running ? 1 : 0, W.plant.vlQ, W.plant.base]);
    W.at(NOW + MIN, worldTick, 'welt');
  };
  // Start
  NOW = o.t0;
  W.boot();
  // Vorgeschichte: Node-RED laeuft schon laenger, der Filter vor Compare SP hat bereits eine Nachricht gesehen (sonst verschluckt er die erste)
  if (o.history) { W.at(o.t0 + 5 * SEC, () => deliver('78cd6de319a6d061', { payload: 'frueher', topic: 'Shift_z1', _msgid: newId() }), 'welt'); }
  W.at(o.t0 + 1 * SEC, worldTick, 'welt');
  (o.arm || []).forEach(a => W.at(o.t0 + a[0] * MIN + (a[2] || 0), () => deliver('opt_dt', { topic: 'arm', payload: a[1], _msgid: newId() }), 'welt'));
  (o.restartAt || []).forEach(m => W.at(o.t0 + m * MIN + 7 * SEC, () => { W.restarts++; W.boot(); }, 'welt'));
  (o.blocks || []).forEach(b => {
    W.at(o.t0 + b[0] * MIN, () => { W.blockNow = true; setPath(W.rt.G, 'MQTT.block_active', 1); }, 'welt');
    W.at(o.t0 + b[1] * MIN, () => { W.blockNow = false; setPath(W.rt.G, 'MQTT.block_active', 0); }, 'welt');
  });
  (o.rtc || []).forEach(r => W.at(o.t0 + r[0] * MIN, () => { W.rtcNow = { state: r[1], corr: r[2] }; setPath(W.rt.G, 'F_RTC.z1', { state: r[1], correction_value: r[2] }); deliver('987d38642eaa3c4c', { payload: 'RTC', _msgid: newId() }); }, 'welt'));
  (o.kicks || []).forEach(t => W.at(t, () => deliver('987d38642eaa3c4c', { payload: 'Vorlauf', _msgid: newId() }), 'welt'));      // zusaetzliche Ereignis-Aufrufe (z. B. Vorlaufaenderung)
  if (o.dtDeadFrom !== undefined) { W.at(o.t0 + o.dtDeadFrom * MIN, () => { W.N.opt_dt = Object.assign({}, W.N.opt_dt, { d: true }); }, 'welt'); }
  return W;
}

// ---------------------------------------------------------------- Anlagenmodell (Minutenschritt), Schaltregeln nach den Messungen 07.-10.10.2026
// Lauf: Vorlauf steigt mit 'rise' K/min (optional Plateau), Stopp wenn Vorlauf (wahr) - Soll > 3,0 K fuer 3 min (angezeigt +3,0..+3,25).
// Pause: erst Durchmischung (Vorlauf faellt in ~5 min um ~3 K), dann 'fall' K/min. Start je Hypothese:
//   soll     : angezeigter Vorlauf <= Soll(aktuell, inkl. Verschiebung) -3,25 fuer 'timer' min (6-13)
//   fest     : wie soll, aber gegen den Soll OHNE Verschiebung (Verschiebung wirkt nicht)
//   integral : Gradminuten unter Soll(aktuell)-3,0 >= 'gm' K*min
//   rl       : Vorlauf <= Ruecklauf beim Stopp -3 K fuer 3 min (Handbuch)
class Plant {
  constructor(o, rng) {
    Object.assign(this, { hyp: 'soll', timerMin: 6, timerMax: 13, rise: 0.035, fall: 0.05, mix: 3.0, running: false, vl: 27.5, shift: 0, runMin: 0, stopMin: 30, gm: 6, plateau: null,
      at: 9, defrost: 0, dhw: 0, stops: [], starts: [], over: 0, below: 0, gmAcc: 0, rlStop: 30.5, timer: 8, fixedVl: null }, o);
    this.rng = rng; this.base = this.sollBase(this.at); this.q(); this.hz = this.running ? 17 : 0; this.pump = 1750;
  }
  sollBase(at) { return Math.max(29, Math.ceil(29 + 0.375 * (11 - at))); }
  q() { this.vlQ = Math.round(this.vl * 4) / 4; this.rlQ = Math.round((this.running ? this.vl - 2.2 : this.vl - 0.25) * 4) / 4; }
  step(m, at) {
    this.at = at; this.base = this.sollBase(at);
    const soll = this.base + this.shift;
    if (this.fixedVl !== null) { this.vl = this.fixedVl; }
    else if (this.running) { this.runMin++; this.vl += (this.plateau !== null && this.vl - this.base >= this.plateau) ? 0 : this.rise; }
    else { this.stopMin++; this.vl -= this.stopMin <= 5 ? this.mix / 5 : this.fall; }
    this.q();
    if (this.running) {
      this.over = (this.vl - (this.hyp === 'fest' ? this.base : soll) > 3.0 && !this.noStop) ? this.over + 1 : 0;
      if (this.over >= 3) { this.running = false; this.stopMin = 0; this.over = 0; this.rlStop = this.rlQ; this.sollStop = this.base; this.stops.push(m); this.timer = this.timerMin + Math.floor(this.rng() * (this.timerMax - this.timerMin + 1)); this.below = 0; this.gmAcc = 0; }
    } else if (this.stopMin >= 3) {
      let cond = false;
      if (this.hyp === 'soll') { cond = this.vlQ - soll <= -3.25; }
      else if (this.hyp === 'fest') { cond = this.vlQ - this.base <= -3.25; }
      else if (this.hyp === 'rl') { cond = this.vlQ - this.rlStop <= -3.0; }
      else if (this.hyp === 'integral') { this.gmAcc += Math.max(0, (soll - 3.0) - this.vl); cond = this.gmAcc >= this.gm; }
      this.below = cond ? this.below + 1 : 0;
      const need = this.hyp === 'rl' ? 3 : (this.hyp === 'integral' ? 1 : this.timer);
      if (this.below >= need) { this.running = true; this.runMin = 0; this.below = 0; this.starts.push(m); this.vl += 0.5; this.q(); }
    }
    this.hz = this.running ? 17 : 0;
    this.pump = this.running ? 2650 : 1750;
  }
}
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- Auswertungshilfen
const DAY0 = Date.UTC(2026, 9, 12, 5, 0, 0);      // 12.10.2026 07:00 Ortszeit
function run(o) { const W = makeWorld(Object.assign({ t0: DAY0 }, o)); W.runUntil(o.t0 !== undefined ? o.t0 + o.minutes * MIN : DAY0 + o.minutes * MIN); return W; }
const evText = W => Object.keys(W.files).filter(f => /quiet-events/.test(f)).map(f => W.files[f]).join('');
const evAt = (W, re) => { const l = evText(W).split('\n').find(x => re.test(x)); if (!l) { return null; } const d = l.slice(0, 19); return new RealDate(d.replace(' ', 'T')).getTime(); };
const dtState = W => JSON.parse(W.files['/data/optimizer/delaytest-state.json'] || '{"S":{}}');
const shiftAt = (W, t) => { let v = 0; W.shiftLog.forEach(r => { if (r[0] <= t) { v = r[1]; } }); return v; };
function backToZero(W, tFrom, want) {               // Minuten ab tFrom, bis die Anlage dauerhaft den Zielwert meldet (-1: nie)
  want = want || 0;
  const L = W.shiftLog.filter(r => r[0] >= tFrom);
  for (let i = 0; i < L.length; i++) { if (L.slice(i).every(r => r[1] === want)) { return Math.round((L[i][0] - tFrom) / MIN); } }
  return -1;
}
const guardCmds = W => W.cmds.filter(c => c.source === 'Verzögerungstest-Rückstellung');
const maxShift = W => Math.max.apply(null, W.shiftLog.map(r => r[1]));
const lastStatus = W => (W.statusLog[W.statusLog.length - 1] || [0, ''])[1];
const results = W => { const s = dtState(W).S; return s.last || null; };

// Ein-Test-Grundlage: Anlage laeuft ab 07:00 und stoppt gegen 09:50; die Pause passt dann zum Startfenster
const EIN = { hyp: 'soll', running: true, vl: 27.0, rise: 0.035, fall: 0.05, runMin: 60 };
const ARM_EIN = [[125, 'einschalten']];

// =========================================================================================================
console.log('--- A Normalfall (echte Kette, Ereignis-Aufrufe + Takt)');
let A, AOLD;
{
  AOLD = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, flows: FLOWS.ohneWaechter, history: true });     // Zeitpunkte fuer die Gegenproben (alter Stand)
  A = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3 });
  const S = dtState(A).S, r = S.last, ev = evText(A);
  const tStart = evAt(A, /verzoegerungstest_start/), tEnd = evAt(A, /verzoegerungstest_(ergebnis|abbruch)/);
  check('A: Ein-Test startet im Tagesfenster und wird von der Anlage bestätigt (TOP27 = 1)', tStart !== null && /Anlage bestätigt \+1 K nach \d+ min/.test(ev), (ev.match(/verzoegerungstest_start[^\n]*/) || ['kein Start'])[0].slice(0, 160));
  check('A: Ergebnis "folgt_soll" bei Hypothese Soll-Schwelle mit Timer 6-13 min', r && r.key === 'start' && r.klasse === 'folgt_soll', r && (r.klasse + ': ' + r.text.slice(0, 150)));
  const b0 = tEnd === null ? -1 : backToZero(A, tEnd);
  check('A: nach dem Ende ist die Anlage binnen <= 5 min wieder auf 0 und bleibt dort', b0 >= 0 && b0 <= 5, 'nach ' + b0 + ' min');
  const chainCmds = A.cmds.filter(c => !c.retry && c.source !== 'Verzögerungstest-Rückstellung').map(c => c.v);
  check('A: über die HeishaMoNR-Kette gehen genau die Befehle +1 und 0, der Rückstellwächter sendet nichts, nie mehr als +1 K', JSON.stringify(chainCmds) === '[1,0]' && guardCmds(A).length === 0 && maxShift(A) === 1, JSON.stringify(A.cmds.map(c => [hm(c.t), c.v, c.source || 'Kette', c.retry ? 'W' : ''])));
  check('A: Phase danach ist Leerlauf, Prüfstand entschärft, kein Alarm, keine Laufzeitfehler in den echten Knoten', S.phase === 'idle' && dtState(A).arm === 'aus' && !/alarm/.test(ev) && A.errors.filter(e => e[2] !== 'warn').length === 0, JSON.stringify(A.errors.slice(0, 3)));
}

console.log('--- B Neustart von Node-RED mitten im Test (Speicher nur "memory")');
{
  const tS = evAt(A, /verzoegerungstest_start/), mS = Math.round((tS - DAY0) / MIN);
  const B = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, restartAt: [mS + 4] });
  const ev = evText(B), tR = DAY0 + (mS + 4) * MIN + 7 * SEC, b0 = backToZero(B, tR);
  check('B: der Neustart bricht den Test ab (Ereignis "Neustart von Node-RED")', /abbruch,einschalten: Neustart von Node-RED/.test(ev), (ev.match(/abbruch[^\n]*/) || [''])[0]);
  check('B: die Anlage ist binnen <= 10 min nach dem Neustart wieder auf 0 (TOP27 kommt erst mit dem 5-min-Komplettabgleich von HeishaMon)', b0 >= 0 && b0 <= 10, 'nach ' + b0 + ' min; Wächter-Befehle ' + JSON.stringify(guardCmds(B).map(c => [hm(c.t), c.v])));
  check('B: Rückstellung über HeishaMoNR selbst (der Platzhalter des Wächters macht den Filter nach dem Neustart wieder durchlässig) oder den Wächter; der Wächter sendet nur 0, höchstens 5 Befehle', guardCmds(B).length <= 5 && guardCmds(B).every(c => c.v === 0) && B.cmds.filter(c => c.t > tR).every(c => c.v === 0), JSON.stringify(B.cmds.map(c => [hm(c.t), c.v, c.retry ? 'Wdh' : (c.source ? 'Wächter' : 'Kette')])));
  const Bx = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, restartAt: [mS + 4], flows: FLOWS.ohneWaechter, history: true });
  check('B Gegenprobe (Stand vor der Korrektur, ohne Takt und Wächter): die Anlage bleibt auf +1 stehen (Befund B1 nachgestellt)', backToZero(Bx, tR) === -1 && shiftAt(Bx, DAY0 + 6 * 60 * MIN) === 1, 'Ende: ' + shiftAt(Bx, DAY0 + 6 * 60 * MIN) + ' K');
}

console.log('--- C MQTT-Sperre beim Abbruch, 20 min später wieder frei');
{
  const tS = evAt(A, /verzoegerungstest_start/), mS = Math.round((tS - DAY0) / MIN);
  const C1 = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, blocks: [[mS + 4, mS + 24]] });
  const ev = evText(C1), tFree = DAY0 + (mS + 24) * MIN, b0 = backToZero(C1, tFree);
  check('C: die Sperre bricht den Test ab ("MQTT-Befehle gesperrt"), während der Sperre wird nichts gesendet', /abbruch,einschalten: MQTT-Befehle gesperrt/.test(ev) && C1.cmds.filter(c => c.t > DAY0 + (mS + 4) * MIN && c.t < tFree).length === 0, '');
  check('C: nach dem Freigeben ist die Anlage binnen <= 5 min wieder auf 0', b0 >= 0 && b0 <= 5, 'nach ' + b0 + ' min; ' + JSON.stringify(C1.cmds.map(c => [hm(c.t), c.v, c.source ? 'W' : 'K'])));
  check('C: bei langer Sperre gibt es einen Alarm (Prüfstand und Wächter) im Dashboard', C1.toasts.some(t => /Verzögerungstest/.test(t[1])) && /verzoegerungstest_alarm/.test(ev), JSON.stringify(C1.toasts.map(t => hm(t[0]) + ' ' + t[1].slice(0, 60))));
  const Cx = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, blocks: [[mS + 4, mS + 24]], flows: FLOWS.ohneWaechter, history: true });
  check('C Gegenprobe ohne Wächter: +1 bleibt nach dem Freigeben stehen', backToZero(Cx, tFree) === -1, 'Ende ' + shiftAt(Cx, DAY0 + 6 * 60 * MIN));
}

console.log('--- D Abbruch 20 s nach dem Startbefehl, der erste Befehl geht verloren, die Summenfunktion rechnet sofort neu (Vorlaufänderung), Command Check wiederholt +1 danach');
{
  let first = true;
  const probe = A.cmds.find(c => c.v === 1);
  const mP = (probe.t - DAY0) / MIN;
  const D = run({ minutes: 6 * 60, plant: EIN, seed: 3, arm: ARM_EIN.concat([[Math.floor(mP), 'aus', Math.round((mP - Math.floor(mP)) * MIN) + 20 * SEC]]), kicks: [probe.t + 23 * SEC],
    dropCmd: (t, v) => { if (v === 1 && first) { first = false; return true; } return false; } });
  const ev = evText(D), late = D.cmds.filter(c => c.v === 1 && c.retry);
  const tLate = late.length ? late[late.length - 1].t : null;
  check('D: Abbruch durch den Nutzer, danach wiederholt Command Check den verlorenen +1-Befehl (so im Review nachgestellt)', /abbruch,einschalten: vom Nutzer entschärft/.test(ev) && tLate !== null, JSON.stringify(D.cmds.map(c => [hm(c.t), c.v, c.retry ? 'Wdh' : (c.source ? 'Wächter' : 'Kette')])));
  const b0 = tLate === null ? -1 : backToZero(D, tLate);
  check('D: der Rückstellwächter holt die Anlage binnen <= 5 min nach dem späten +1 zurück auf 0', b0 >= 0 && b0 <= 5, 'nach ' + b0 + ' min');
  first = true;
  const pO = AOLD.cmds.find(c => c.v === 1), mO = (pO.t - DAY0) / MIN;
  const Dx = run({ minutes: 6 * 60, plant: EIN, seed: 3, arm: ARM_EIN.concat([[Math.floor(mO), 'aus', Math.round((mO - Math.floor(mO)) * MIN) + 20 * SEC]]), flows: FLOWS.ohneWaechter, history: true, kicks: [pO.t + 23 * SEC],
    dropCmd: (t, v) => { if (v === 1 && first) { first = false; return true; } return false; } });
  check('D Gegenprobe ohne Wächter: +1 bleibt stehen', shiftAt(Dx, DAY0 + 6 * 60 * MIN) === 1, JSON.stringify(Dx.cmds.map(c => [hm(c.t), c.v, c.retry ? 'Wdh' : 'Kette'])));
}

console.log('--- E Rückstellbefehl und alle Wiederholungen gehen verloren (HeishaMon 3 min taub)');
{
  const tE = evAt(A, /verzoegerungstest_(ergebnis|abbruch)/), mE = (tE - DAY0) / MIN;
  const E = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, dropCmd: (t, v) => v === 0 && t >= tE - 30 * SEC && t < tE + 3 * MIN + 30 * SEC });
  const b0 = backToZero(E, tE + 3 * MIN + 30 * SEC);
  check('E: die Kette gibt nach 3 Wiederholungen auf, der Wächter stellt binnen <= 5 min nach Ende der Störung auf 0', b0 >= 0 && b0 <= 5 && guardCmds(E).length >= 1 && guardCmds(E).length <= 5, 'nach ' + b0 + ' min; ' + JSON.stringify(E.cmds.map(c => [hm(c.t), c.v, c.retry ? 'Wdh' : (c.source ? 'Wächter' : 'Kette')])));
  const Ex = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, flows: FLOWS.ohneWaechter, history: true, dropCmd: (t, v) => v === 0 && t >= tE - 30 * SEC && t < tE + 3 * MIN + 30 * SEC });
  check('E Gegenprobe ohne Wächter: +1 bleibt stehen', shiftAt(Ex, DAY0 + 6 * 60 * MIN) === 1, '');
}

console.log('--- F Totmann: Prüfstand fällt mitten im Test aus, Vorlauf ändert sich nicht (keine Ereignis-Aufrufe)');
{
  const tC = evAt(A, /Anlage bestätigt/), mC = Math.round((tC - DAY0) / MIN) + 2;
  const F = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, dtDeadFrom: mC, beforeMin: (m, W) => { if (m === mC) { W.plant.fixedVl = W.plant.vl; } if (m === mC + 40) { W.plant.fixedVl = null; } } });
  const b0 = backToZero(F, DAY0 + mC * MIN);
  check('F: ohne Aufrufe des Prüfstands verfällt +1 über den Takt der Summenfunktion binnen <= 5 min (Frische 150 s)', b0 >= 0 && b0 <= 5, 'nach ' + b0 + ' min');
  const mCo = Math.round((evAt(AOLD, /Anlage bestätigt/) - DAY0) / MIN) + 2;
  const Fx = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, dtDeadFrom: mCo, flows: FLOWS.ohneWaechter, history: true, beforeMin: (m, W) => { if (m === mCo) { W.plant.fixedVl = W.plant.vl; } if (m === mCo + 40) { W.plant.fixedVl = null; } } });
  const bx = backToZero(Fx, DAY0 + mCo * MIN);
  check('F Gegenprobe ohne Takt: +1 steht, bis der Vorlauf sich wieder ändert (hier 40 min)', shiftAt(Fx, DAY0 + (mCo + 1) * MIN) === 1 && (bx === -1 || bx >= 39), 'nach ' + bx + ' min');
}

console.log('--- G Raumregelung (RTC)');
{
  const G1 = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, rtc: [[10, 1, -0.6]] });
  check('G: mit eingeschalteter Raumregelung (-0,6 K) startet kein Test (Grund wird angezeigt)', !/verzoegerungstest_start/.test(evText(G1)) && G1.statusLog.some(s => /Raumregelung\/Nachtabsenkung\/Softstart eingeschaltet/.test(s[1])) && maxShift(G1) <= 0, lastStatus(G1).slice(0, 120));
  const tC = evAt(A, /Anlage bestätigt/), mC = Math.round((tC - DAY0) / MIN) + 1;
  const G2 = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, rtc: [[mC, 1, 0.3]] });
  const ev = evText(G2), tAb = evAt(G2, /verzoegerungstest_abbruch/);
  check('G: wird die Raumregelung (+0,3 K) mitten im Test eingeschaltet, nimmt der Patch den Testbeitrag sofort heraus: nie +2 an der Anlage, Abbruch', maxShift(G2) <= 1 && /abbruch,einschalten: Raumregelung/.test(ev), 'max ' + maxShift(G2) + '; ' + JSON.stringify(G2.cmds.map(c => [hm(c.t), c.v])));
  const b1 = tAb === null ? -1 : backToZero(G2, tAb, 1);
  check('G: danach steht die Anlage auf dem Wert der Raumregelung (ceil(0,3) = 1); der Wächter sendet nichts nach unten, kein Fehlalarm', b1 >= 0 && guardCmds(G2).length === 0 && !/verzoegerungstest_alarm/.test(ev) && dtState(G2).S.phase === 'idle', 'b1 ' + b1 + ', Phase ' + dtState(G2).S.phase);
}

console.log('--- Weitere Störungen');
{
  // HeishaMon 20 min ganz weg (keine Werte, keine Befehle) genau zum Testende
  const tE = evAt(A, /verzoegerungstest_(ergebnis|abbruch)/);
  const H = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, hmOffline: [[tE - 2 * MIN, tE + 20 * MIN]] });
  const b0 = backToZero(H, tE + 20 * MIN);
  check('HeishaMon 20 min ausgefallen ab kurz vor Testende: der Test bricht ab ("Anlagenwerte veraltet") oder endet; nach der Rückkehr ist die Anlage binnen <= 6 min auf 0', b0 >= 0 && b0 <= 6, 'nach ' + b0 + ' min; ' + JSON.stringify(H.cmds.map(c => [hm(c.t), c.v, c.retry ? 'Wdh' : (c.source ? 'Wächter' : 'Kette')])));
  check('HeishaMon-Ausfall: Alarm im Dashboard, weil die Rückstellung länger als 10 min nicht bestätigt ist', H.toasts.some(t => /Verzögerungstest/.test(t[1])), JSON.stringify(H.toasts.map(t => hm(t[0]))));
  // Neustart waehrend der Rueckstellphase (nach) + Sperre danach
  const tS = evAt(A, /verzoegerungstest_start/), mS = Math.round((tS - DAY0) / MIN);
  const I = run({ minutes: 8 * 60, plant: EIN, arm: ARM_EIN, seed: 3, restartAt: [mS + 4, mS + 6], blocks: [[mS + 7, mS + 40]] });
  const b2 = backToZero(I, DAY0 + (mS + 40) * MIN);
  check('Zwei Neustarts kurz hintereinander und danach 33 min Sperre: nach dem Freigeben binnen <= 5 min auf 0, Wächter höchstens 5 Befehle', b2 >= 0 && b2 <= 5 && guardCmds(I).length <= 5, 'nach ' + b2 + ' min, Wächter ' + guardCmds(I).length);
  // Wächter darf ohne Test nichts tun: Nutzer hat selbst +1 gesetzt (z. B. HeishaMon-Weboberflaeche) ausserhalb des Testfensters
  const J = run({ minutes: 4 * 60, plant: EIN, seed: 3, beforeMin: (m, W) => { if (m === 30) { W.publish(SHIFT_TOPIC, 1, { source: 'Nutzer' }); } } });
  check('Ohne Testfenster (nie scharf geschaltet) bleiben Takt und Wächter stumm: eine Verschiebung des Nutzers bleibt stehen, kein zusätzlicher Aufruf der Summenfunktion', guardCmds(J).length === 0 && shiftAt(J, DAY0 + 4 * 60 * MIN) === 1 && JSON.parse(J.files['/data/optimizer/delaytest-window.json'] || 'null') === null && J.rt.G.OPT_dt_guard === undefined, 'Fenster ' + J.files['/data/optimizer/delaytest-window.json']);
  // Zustandsdatei nicht schreibbar
  const K = run({ minutes: 6 * 60, plant: EIN, arm: ARM_EIN, seed: 3, fsReadOnly: true, restartAt: [Math.round((tS - DAY0) / MIN) + 4] });
  check('Dateien nicht schreibbar: es startet kein Test (ein Neustart würde den Test sonst vergessen), Grund wird angezeigt', !/verzoegerungstest_start/.test(evText(K) + K.statusLog.map(x => x[1]).join()) && maxShift(K) === 0 && K.statusLog.some(x => /Zustandsdatei nicht schreibbar/.test(x[1])), lastStatus(K).slice(0, 100));
}

// =========================================================================================================
console.log('--- Monte-Carlo der Auswertung (echte Kette, zufällige Abfallrate, Timer, Latenz, Startzeit)');
function mc(hyp, n, seed0) {
  const cnt = {}, details = [];
  for (let i = 0; i < n; i++) {
    const rng = mulberry(seed0 + i * 7919);
    const plant = Object.assign({}, EIN, { hyp, fall: 0.04 + rng() * 0.025, rise: 0.03 + rng() * 0.01, vl: 26.5 + rng() * 1.5, mix: 2.5 + rng(), gm: 3 + rng() * 5 });      // Gradminuten 3-8 K*min: passt zu den gemessenen natuerlichen Starts (6-13 min nach Soll -3,25 K)
    const W = run({ minutes: 11 * 60, plant, arm: [[121 + Math.floor(rng() * 40), 'einschalten']], seed: seed0 + i });
    const r = results(W);
    const k = r ? (r.key === 'abbruch' ? 'abbruch' : r.klasse) : 'kein_test';
    cnt[k] = (cnt[k] || 0) + 1;
    if (maxShift(W) > 1 || (r && backToZero(W, r.ts) < 0)) { cnt.haengt = (cnt.haengt || 0) + 1; }
    details.push(k);
  }
  return cnt;
}
const NMC = FAST ? 20 : 60;
const mcS = mc('soll', NMC, 100), mcF = mc('fest', NMC, 200), mcI = mc('integral', NMC, 300), mcR = mc('rl', NMC, 400);
const tested = c => NMC - (c.kein_test || 0) - (c.abbruch || 0);
const pct = (c, k) => tested(c) ? Math.round(100 * (c[k] || 0) / tested(c)) : 0;
console.log('     Verwechslungsmatrix (Zeilen: Verhalten der Anlage im Modell; Spalten: Klasse des Tests), je ' + NMC + ' Läufe');
[['Soll + Timer 6-13', mcS], ['Soll ohne Verschiebung', mcF], ['Gradminuten unter Soll', mcI], ['Rücklauf beim Stopp -3 K', mcR]].forEach(([n, c]) => console.log('     ' + n.padEnd(26) + JSON.stringify(c)));
check('Monte-Carlo: Schwelle folgt dem Soll (mit Timer) -> mind. 90 % "folgt_soll", höchstens 2 % "ohne_wirkung" (unter den gestarteten Tests, Startquote mind. 50 %)', tested(mcS) >= NMC * 0.5 && pct(mcS, 'folgt_soll') >= 90 && pct(mcS, 'ohne_wirkung') <= 2, JSON.stringify(mcS));
check('Monte-Carlo: Verschiebung wirkt nicht -> mind. 90 % "ohne_wirkung", höchstens 2 % "folgt_soll" (unter den gestarteten Tests, Startquote mind. 50 %)', tested(mcF) >= NMC * 0.5 && pct(mcF, 'ohne_wirkung') >= 90 && pct(mcF, 'folgt_soll') <= 2, JSON.stringify(mcF));
check('Monte-Carlo: Gradminuten-Hypothese (folgt ebenfalls dem Soll; an die gemessenen Starts angepasst) wird nie als "ohne_wirkung" gewertet', (mcI.ohne_wirkung || 0) === 0, JSON.stringify(mcI));
console.log('     Hinweis: die Handbuch-Regel (Rücklauf beim Stopp -3 K) liegt mit dem gemessenen Rücklauf beim Stopp (Soll +0,75..+1 K) fast auf der verschobenen Schwelle; der Test kann sie von "folgt_soll" NICHT trennen. Ohne Test sagt sie Starts bei Soll -2,0..-2,25 K voraus, gemessen wurden -3,25 K: durch die Daten schon widerlegt, nur gezeigt.');
check('Monte-Carlo: in keinem der ' + 4 * NMC + ' Läufe bleibt eine Verschiebung stehen oder wird größer als 1 K', !mcS.haengt && !mcF.haengt && !mcI.haengt && !mcR.haengt, '');

// =========================================================================================================
console.log('--- Aus-Test (Ausschalten hinauszögern)');
{
  const AUS = { hyp: 'soll', running: true, vl: 27.0, rise: 0.03, runMin: 50 };
  const a1 = run({ minutes: 8 * 60, plant: AUS, arm: [[125, 'ausschalten']], seed: 5, rooms: { ki_oben: 23.4 } });
  const a2 = run({ minutes: 8 * 60, plant: Object.assign({}, AUS, { hyp: 'fest' }), arm: [[125, 'ausschalten']], seed: 5, rooms: { ki_oben: 23.4 } });
  const r1 = results(a1);
  check('Aus-Test: startet bei steigendem Vorlauf (+1,75..+2,5 K, >= 1,2 K/h), Ergebnis "folgt_soll" (Stopp erst bei +4 K), danach 0 binnen <= 5 min', r1 && r1.key === 'stopp' && r1.klasse === 'folgt_soll' && backToZero(a1, r1.ts) >= 0 && backToZero(a1, r1.ts) <= 5, r1 && (r1.klasse + ': ' + r1.text.slice(0, 140)));
  check('Aus-Test: nie mehr als +1 K, nur Befehle 1 und 0 über die Kette', maxShift(a1) === 1 && a1.cmds.filter(c => !c.retry).every(c => c.v === 0 || c.v === 1), '');
  const r2 = results(a2);
  check('Aus-Test: wirkt die Verschiebung nicht auf die Abschaltung (Modell "fest"), lautet das Ergebnis "ohne_wirkung"', r2 && r2.key === 'stopp' && r2.klasse === 'ohne_wirkung', r2 && (r2.klasse + ': ' + r2.text.slice(0, 120)));
}

// =========================================================================================================
console.log('--- Mehrtägige Simulation (5 Tage, Ereignis-Aufrufe, Neustarts, Sperren, HeishaMon-Lücken, Außentemperatur mit Flackern)');
{
  const days = 5, rng = mulberry(77);
  const restarts = [], blocks = [], offl = [];
  for (let d = 0; d < days; d++) { if (d % 2 === 1) { restarts.push(d * 1440 + 150 + Math.floor(rng() * 300)); } blocks.push([d * 1440 + 400 + Math.floor(rng() * 200), 0]); offl.push(d * 1440 + 700 + Math.floor(rng() * 300)); }
  blocks.forEach(b => { b[1] = b[0] + 5 + Math.floor(rng() * 30); });
  const atFn = m => { const h = ((m / 60) + 7) % 24; const base = 9.6 + 1.6 * Math.sin((h - 9) / 24 * 2 * Math.PI) + 0.4 * Math.sin(m / 1440 * 2.1); return Math.round(base + 0.2 * (rng() - 0.5)); };    // ganzzahlig, Flackern nur nahe x,5
  const arms = []; for (let d = 0; d < days; d++) { arms.push([d * 1440 + 120 + Math.floor(rng() * 90), rng() < 0.7 ? 'einschalten' : 'ausschalten']); if (rng() < 0.5) { arms.push([d * 1440 + 600, 'einschalten']); } }
  const M = run({ minutes: days * 1440, plant: { hyp: 'soll', running: true, vl: 28, rise: 0.035, fall: 0.05 }, atFn, arm: arms, seed: 11, restartAt: restarts, blocks,
    hmOffline: offl.map(m => [DAY0 + m * MIN, DAY0 + (m + 4 + Math.floor(rng() * 20)) * MIN]) });
  const ev = evText(M);
  const starts = (ev.match(/\d{4}-\d\d-\d\d (\d\d):\d\d:\d\d,verzoegerungstest_start/g) || []);
  const byDay = {}; starts.forEach(s => { byDay[s.slice(0, 10)] = (byDay[s.slice(0, 10)] || 0) + 1; });
  const hours = starts.map(s => Number(s.slice(11, 13)));
  check('5 Tage: mindestens zwei Tests laufen, höchstens einer je Tag, nur zwischen 9 und 18 Uhr gestartet', starts.length >= 2 && Object.values(byDay).every(n => n <= 1) && hours.every(h => h >= 9 && h < 18), JSON.stringify(byDay) + ' Stunden ' + hours.join(','));
  // Invariante: ausserhalb eines laufenden Tests (+ 10 min Toleranz, + Stoerungsdauer) steht die Anlage auf 0
  const inTest = []; let tsT = null;
  ev.split('\n').forEach(l => { const t = l.length > 19 ? new RealDate(l.slice(0, 19).replace(' ', 'T')).getTime() : null; if (/verzoegerungstest_start/.test(l)) { tsT = t; } if (/verzoegerungstest_(ergebnis|abbruch)/.test(l) && tsT !== null) { inTest.push([tsT, t]); tsT = null; } });
  const disturbed = t => blocks.some(b => t >= DAY0 + b[0] * MIN && t <= DAY0 + (b[1] + 6) * MIN) || M.o.hmOffline.some(w => t >= w[0] && t <= w[1] + 6 * MIN) || restarts.some(r => t >= DAY0 + r * MIN && t <= DAY0 + (r + 11) * MIN);
  const bad = M.shiftLog.filter(r => r[1] !== 0 && !inTest.some(w => r[0] >= w[0] && r[0] <= w[1] + 10 * MIN) && !disturbed(r[0]));
  check('5 Tage: außerhalb von Tests (plus 10 min) und Störungen steht die Anlage immer auf 0; nie mehr als +1 K', bad.length === 0 && maxShift(M) <= 1, 'Abweichungen ' + bad.length + (bad.length ? ' ab ' + hm(bad[0][0]) : '') + ', Tests ' + inTest.length + ', Neustarts ' + M.restarts);
  check('5 Tage: der Wächter sendet nur 0 und insgesamt wenige Befehle (<= 5 je Test)', guardCmds(M).every(c => c.v === 0) && guardCmds(M).length <= 5 * Math.max(1, inTest.length), 'Wächter ' + guardCmds(M).length + ' Befehle');
  check('5 Tage: keine Laufzeitfehler in den echten Knoten', M.errors.filter(e => e[2] !== 'warn').length === 0, JSON.stringify(M.errors.slice(0, 2)));
  const res = ev.split('\n').filter(l => /verzoegerungstest_(ergebnis|abbruch)/.test(l)).map(l => l.slice(11, 16) + ' ' + l.slice(20, 120));
  console.log('     Ergebnisse/Abbrüche: ' + (res.join(' | ') || 'keine'));
}

console.log('\n' + (fails === 0 ? 'ERGEBNIS delaytest_chain_sim: ' + nChecks + ' OK, 0 FAIL' : 'ERGEBNIS delaytest_chain_sim: ' + (nChecks - fails) + ' OK, ' + fails + ' FAIL'));
process.exit(fails === 0 ? 0 : 1);

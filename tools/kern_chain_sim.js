// Ketten-Simulation des Kern-Pakets (tools/kern_patch.py, VORBEREITET, nicht eingespielt): die ECHTEN Knoten von HeishaMoNR laufen in einer kleinen
// Node-RED-Nachbildung mit Fake-Uhr. Kein Node-RED, kein MQTT, nichts wird gesendet. Aufruf:  node tools/kern_chain_sim.js "flows.json"
// Grundlage: tools/delaytest_chain_sim.js (Branch delaytest-v2), ohne Pruefstand und ohne Testfenster.
//
// Ausgefuehrt werden (Code aus der Flow-Datei, mit angewendetem tools/kern_patch.py bzw. ohne fuer die Gegenproben):
//   Summenfunktion add6fa4d403dd143 (unveraendert) <- 100-ms-Trigger 987d38642eaa3c4c <- Ereignisse (Vorlauf/Ruecklauf/Verdichter wie SoftStart->complete) und Takt kpatch_sumtick
//   -> link -> "Z1+Z2 HEAT SP Manager" -> function 78 -> Filter 78cd6de319a6d061 -> Compare SP c4130c490114e90f -> Block? 1b409e1ea72f94dd -> To MQTT (SET5)
//   -> link "> MQTT OUT" -> Ratenbegrenzung 1/7 s -> Block? (globale Sperre) -> Dynamic MQTT out -> Broker
//   Broker -> commands/# -> FW -> Command Check (1-on-1) (Wiederholungen mit Timern)   |   Broker -> HeishaMon-Modell -> main/Z1_Heat_Request_Temp -> set.TOP27 + Command Check
//   Ist/Soll-Abgleich kpatch_guard (jede Minute) -> Ratenbegrenzung, Platzhalter -> Filter.
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
  const tmp = path.join(os.tmpdir(), 'kern_chain_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmp, JSON.stringify(flows));
  cp.execFileSync('python3', [path.join(__dirname, 'kern_patch.py'), tmp].concat(extra || []));
  const r = JSON.parse(fs.readFileSync(tmp, 'utf8')); fs.unlinkSync(tmp); return r;
}
const FLOWS = { voll: patched(ALL0), ohne: ALL0 };                               // ohne = heutiger Stand (Gegenprobe)
FLOWS.nurTakt = FLOWS.voll.filter(n => !['kpatch_guard_tick', 'kpatch_guard'].includes(n.id));
FLOWS.nurAbgleich = FLOWS.voll.filter(n => n.id !== 'kpatch_sumtick');

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
  '1e22e8620445f5a5', 'c7a7be892c1747ec', '48d749cc0ca61d74', 'aa66f523450fd337', 'kpatch_guard']);
const MQTT_IN = new Set(['ae6175191a94d7ec', 'b9da2620c239be36']);           // commands/#  und  main/Z1_Heat_Request_Temp (NAS-Broker)
const SHIFT_TOPIC = 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature';

function makeWorld(o) {
  const W = { o, flows: o.flows || FLOWS.voll, q: new Heap(), files: {}, pub: [], cmds: [], toasts: [], ui: [], errors: [], shiftLog: [], evRows: [], statusLog: [], restarts: 0, sumRuns: 0 };
  W.N = {}; W.flows.forEach(n => { W.N[n.id] = n; });
  const rng = mulberry(o.seed || 1);
  W.rng = rng;
  // ---- Ereignisse
  W.at = (t, fn, owner) => { const e = { t, s: SEQ++, fn, owner: owner || 'welt', dead: false }; W.q.push(e); return e; };
  W.runUntil = T => { while (W.q.size && W.q.peek().t <= T) { const e = W.q.pop(); if (e.dead) { continue; } NOW = e.t; e.fn(); } NOW = T; };
  // ---- Dateisystem (bleibt ueber Neustarts)
  W.fsm = { readFileSync: p => { if (!(p in W.files)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } return W.files[p]; },
    writeFileSync: (p, d) => { W.files[p] = String(d); }, mkdirSync: () => {}, chmodSync: () => {}, existsSync: p => p in W.files };
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
      if (W.rtcNow && !W.o.rtcVergessen) { setPath(G, 'F_RTC.z1', { state: W.rtcNow.state, correction_value: W.rtcNow.corr }); }
      if (W.applyNow) { G.OPT_apply = Object.assign({}, W.applyNow, { ts: NOW }); }
      if (W.kernAus) { G.OPT_kern_aus = true; }
    });
    // Injects (einmal nach X s, dann alle 60 s)
    const inj = (id, once, target) => { if (!W.N[id] || W.N[id].d) { return; } const tick = () => { deliver(target, { payload: NOW, topic: '', _msgid: newId() }); nr(60 * SEC, tick); }; nr(once * SEC, tick); };
    inj('kpatch_sumtick', 40, '987d38642eaa3c4c');
    inj('kpatch_guard_tick', 90, 'kpatch_guard');
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
    if (id === 'add6fa4d403dd143') { W.sumRuns++; }
    emit(id, r);
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
  (o.restartAt || []).forEach(m => W.at(o.t0 + m * MIN + 7 * SEC, () => { W.restarts++; W.boot(); }, 'welt'));
  (o.blocks || []).forEach(b => {
    W.at(o.t0 + b[0] * MIN, () => { W.blockNow = true; setPath(W.rt.G, 'MQTT.block_active', 1); }, 'welt');
    W.at(o.t0 + b[1] * MIN, () => { W.blockNow = false; setPath(W.rt.G, 'MQTT.block_active', 0); }, 'welt');
  });
  (o.rtc || []).forEach(r => W.at(o.t0 + r[0] * MIN, () => { W.rtcNow = { state: r[1], corr: r[2] }; setPath(W.rt.G, 'F_RTC.z1', { state: r[1], correction_value: r[2] }); deliver('987d38642eaa3c4c', { payload: 'RTC', _msgid: newId() }); }, 'welt'));
  (o.kicks || []).forEach(t => W.at(t, () => deliver('987d38642eaa3c4c', { payload: 'Vorlauf', _msgid: newId() }), 'welt'));      // zusaetzliche Ereignis-Aufrufe (z. B. Vorlaufaenderung)
  (o.apply || []).forEach(a => W.at(o.t0 + a[0] * MIN, () => { W.applyNow = a[1]; W.rt.G.OPT_apply = Object.assign({}, a[1], { ts: NOW }); if (a[2] !== undefined) { W.publish(SHIFT_TOPIC, a[2], { source: 'Optimierer (Klick)' }); } }, 'welt'));
  // OPT_apply wie die Huelle opt_apply: alle 15 s neu geschrieben (ts); o.applyStehtAb (min): ab dann nicht mehr (Optimierer-Tab steht)
  const applyTick = () => { if (W.applyNow && !(o.applyStehtAb !== undefined && NOW >= o.t0 + o.applyStehtAb * MIN)) { W.rt.G.OPT_apply = Object.assign({}, W.applyNow, { ts: NOW }); } W.at(NOW + 15 * SEC, applyTick, 'welt'); };
  W.at(o.t0 + 2 * SEC, applyTick, 'welt');
  (o.user || []).forEach(a => W.at(o.t0 + a[0] * MIN, () => W.publish(SHIFT_TOPIC, a[1], { source: 'Nutzer' }), 'welt'));
  if (o.kernAus) { W.at(o.t0, () => { W.kernAus = true; W.rt.G.OPT_kern_aus = true; }, 'welt'); }
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
const shiftAt = (W, t) => { let v = 0; W.shiftLog.forEach(r => { if (r[0] <= t) { v = r[1]; } }); return v; };
function backToZero(W, tFrom, want) {               // Minuten ab tFrom, bis die Anlage dauerhaft den Zielwert meldet (-1: nie)
  want = want || 0;
  const L = W.shiftLog.filter(r => r[0] >= tFrom);
  for (let i = 0; i < L.length; i++) { if (L.slice(i).every(r => r[1] === want)) { return Math.round((L[i][0] - tFrom) / MIN); } }
  return -1;
}
const guardCmds = W => W.cmds.filter(c => c.source === 'Kern-Abgleich');
const maxShift = W => Math.max.apply(null, W.shiftLog.map(r => r[1]));

// Anlage laeuft ab 07:00 (wie im Verzoegerungstest), Aussentemperatur 9 °C (Basis-Soll 30 °C)
const EIN = { hyp: 'soll', running: true, vl: 27.0, rise: 0.035, fall: 0.05, runMin: 60 };
const lastShift = W => shiftAt(W, NOW);
const backTo = (W, tFrom, want) => backToZero(W, tFrom, want);
const nonRetry = W => W.cmds.filter(c => !c.retry);
const fmt = W => JSON.stringify(W.cmds.map(c => [hm(c.t), c.v, c.retry ? 'Wdh' : (c.source || 'Kette')]));

// =========================================================================================================
console.log('--- R1 Verlorener Rückstellbefehl (Raumregelung aus, die 0 und alle Wiederholungen gehen bei HeishaMon verloren)');
{
  const drop = (t, v) => v === 0 && t >= DAY0 + 119.5 * MIN && t < DAY0 + 126 * MIN;
  const R = run({ minutes: 5 * 60, plant: EIN, seed: 3, history: true, rtc: [[30, 1, 0.6], [120, 0, 0]], dropCmd: drop });
  const Rx = run({ minutes: 5 * 60, plant: EIN, seed: 3, history: true, rtc: [[30, 1, 0.6], [120, 0, 0]], dropCmd: drop, flows: FLOWS.ohne });
  const b = backTo(R, DAY0 + 126 * MIN, 0);
  check('R1: mit Kern-Paket ist die Anlage binnen <= 5 min nach dem Ende der Störung wieder auf dem Wert von HeishaMoNR (0), der Abgleich sendet nur 0 (<= 2 Befehle)', b >= 0 && b <= 5 && guardCmds(R).length >= 1 && guardCmds(R).length <= 2 && guardCmds(R).every(c => c.v === 0), 'nach ' + b + ' min; ' + fmt(R));
  check('R1 Gegenprobe (heutiger Stand): +1 bleibt bis zum Ende stehen (Befund 1 nachgestellt)', backTo(Rx, DAY0 + 126 * MIN, 0) === -1 && shiftAt(Rx, DAY0 + 5 * 60 * MIN) === 1, fmt(Rx));
}

console.log('--- R2 Neustart von Node-RED, Raumregelung danach aus (Wert der Raumregelung verloren)');
{
  const R = run({ minutes: 5 * 60, plant: EIN, seed: 4, history: true, rtc: [[30, 1, 0.6]], restartAt: [120], rtcVergessen: true });
  const Rx = run({ minutes: 5 * 60, plant: EIN, seed: 4, history: true, rtc: [[30, 1, 0.6]], restartAt: [120], rtcVergessen: true, flows: FLOWS.ohne });
  const tR = DAY0 + 120 * MIN + 7 * SEC, b = backTo(R, tR, 0);
  check('R2: nach dem Neustart ist die Anlage binnen <= 10 min auf 0 (HeishaMon meldet TOP27/TOP42 erst mit dem 5-min-Abgleich), keine Laufzeitfehler', b >= 0 && b <= 10 && R.errors.filter(e => e[2] !== 'warn').length === 0, 'nach ' + b + ' min; ' + fmt(R));
  check('R2 Gegenprobe: ohne Paket bleibt +1 stehen, bis sich der Wert wieder ändert', backTo(Rx, tR, 0) === -1 || backTo(Rx, tR, 0) > 30, 'Gegenprobe nach ' + backTo(Rx, tR, 0) + ' min; ' + fmt(Rx));
  const Rt = run({ minutes: 5 * 60, plant: EIN, seed: 4, history: true, rtc: [[30, 1, 0.6]], restartAt: [120], rtcVergessen: true, flows: FLOWS.nurTakt });
  console.log('     nur Takt (ohne Abgleich und Platzhalter): zurück nach ' + backTo(Rt, tR, 0) + ' min; ' + fmt(Rt));
}

console.log('--- R3 Takt: Nachtabsenkung (−1 K) wird ohne Ereignis-Aufruf eingeschaltet, Vorlauf ändert sich nicht');
{
  const hook = (m, W) => { if (m === 60) { W.plant.fixedVl = W.plant.vl; setPath(W.rt.G, 'NightReductionWaterTemp', { state: 1, correction: -1 }); } if (m === 150) { W.plant.fixedVl = null; } };
  const R = run({ minutes: 4 * 60, plant: EIN, seed: 5, history: true, beforeMin: hook });
  const Rx = run({ minutes: 4 * 60, plant: EIN, seed: 5, history: true, beforeMin: hook, flows: FLOWS.ohne });
  const b = backTo(R, DAY0 + 60 * MIN, -1), bx = backTo(Rx, DAY0 + 60 * MIN, -1);
  check('R3: mit Takt folgt die Anlage der Nachtabsenkung binnen <= 3 min (Summenfunktion jede Minute)', b >= 0 && b <= 3, 'nach ' + b + ' min; ' + fmt(R));
  check('R3 Gegenprobe: ohne Takt erst, wenn sich der Vorlauf wieder ändert (hier nach 90 min)', bx === -1 || bx >= 85, 'nach ' + bx + ' min');
}

console.log('--- R4 Ruhiger Tag: keine zusätzlichen Befehle');
{
  const R = run({ minutes: 24 * 60, plant: EIN, seed: 6, history: true, rtc: [[200, 1, 0.4], [500, 1, -0.6], [900, 0, 0]] });
  const Rx = run({ minutes: 24 * 60, plant: EIN, seed: 6, history: true, rtc: [[200, 1, 0.4], [500, 1, -0.6], [900, 0, 0]], flows: FLOWS.ohne });
  const c = nonRetry(R).filter(x => x.source !== 'Kern-Abgleich').map(x => x.v), cx = nonRetry(Rx).map(x => x.v);
  check('R4: 24 h mit drei Raumregelungs-Wechseln: dieselben Befehle wie heute (' + JSON.stringify(cx) + '), der Abgleich sendet nichts, keine Laufzeitfehler; die Summenfunktion rechnet jede Minute (' + R.sumRuns + ' gegen ' + Rx.sumRuns + ' Aufrufe)',
        JSON.stringify(c) === JSON.stringify(cx) && guardCmds(R).length === 0 && R.errors.filter(e => e[2] !== 'warn').length === 0 && R.sumRuns >= 24 * 60 - 5, JSON.stringify(c));
}

console.log('--- R5 Übernahme des Optimierers (+1 K per Klick): kein Abgleich, solange sie aktiv ist');
{
  const ap = { aktiv: { id: 'x', rule: 'raum_offset', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: 1, von: 0, bestaetigt: true } };
  const R = run({ minutes: 5 * 60, plant: EIN, seed: 7, history: true, apply: [[60, ap, 1], [240, { aktiv: null }]] });
  check('R5: während der aktiven Übernahme bleibt +1 stehen (kein Abgleichsbefehl bis 240 min), danach holt der Abgleich die Anlage binnen <= 5 min auf 0', shiftAt(R, DAY0 + 230 * MIN) === 1 && guardCmds(R).filter(c => c.t < DAY0 + 240 * MIN).length === 0 && backTo(R, DAY0 + 240 * MIN, 0) >= 0 && backTo(R, DAY0 + 240 * MIN, 0) <= 5,
        fmt(R) + ' · ' + (R.rt.G.OPT_kern_guard || {}).text);
}

console.log('--- R5b Ausnahme im Kern-Guard gehärtet (Regel-Review B6): nur frische, bestätigte, gültige Übernahme');
{
  const sh1 = (o2) => ({ aktiv: Object.assign({ id: 'x', rule: 'quiet_strecken', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: 1, von: 0, bestaetigt: true }, o2 || {}) });
  const back = R => backTo(R, DAY0 + 60 * MIN, 0);
  const Rst = run({ minutes: 4 * 60, plant: EIN, seed: 11, history: true, apply: [[60, sh1(), 1]], applyStehtAb: 120 });
  const Rbis = run({ minutes: 4 * 60, plant: EIN, seed: 12, history: true, apply: [[60, sh1({ bis: DAY0 + 150 * MIN }), 1]] });
  const Rfe = run({ minutes: 3 * 60, plant: EIN, seed: 13, history: true, apply: [[60, sh1({ rueckFehl: DAY0 + 61 * MIN }), 1]] });
  const Run = run({ minutes: 3 * 60, plant: EIN, seed: 14, history: true, apply: [[60, sh1({ bestaetigt: false }), 1]] });
  const Rak = run({ minutes: 4 * 60, plant: EIN, seed: 15, history: true, apply: [[60, { ak: { shift: sh1().aktiv, quiet: { id: 'q', rule: 'quiet_freigabe', name: 'SetQuietMode', value: 0, von: 3, bestaetigt: true } }, aktiv: { id: 'q', rule: 'quiet_freigabe', name: 'SetQuietMode', value: 0, von: 3, bestaetigt: true } }, 1]] });
  const t1 = backTo(Rst, DAY0 + 120 * MIN, 0), t2 = backTo(Rbis, DAY0 + 150 * MIN, 0), t3 = back(Rfe), t4 = back(Run);
  check('R5b: Optimierer-Tab steht (OPT_apply ab 120 min nicht mehr geschrieben): +1 bleibt bis 120 min, danach holt der Abgleich die Anlage binnen <= 8 min auf 0 (OPT_apply älter als 2 min zählt nicht)', shiftAt(Rst, DAY0 + 115 * MIN) === 1 && guardCmds(Rst).filter(c => c.t < DAY0 + 120 * MIN).length === 0 && t1 >= 0 && t1 <= 8, 't ' + t1 + ' · ' + fmt(Rst));
  check('R5b: Übernahme abgelaufen (aktiv.bis 150 min, Rückweg kam nicht): +1 bis 150 min geschützt, danach Abgleich auf 0 binnen <= 6 min', shiftAt(Rbis, DAY0 + 145 * MIN) === 1 && guardCmds(Rbis).filter(c => c.t < DAY0 + 150 * MIN).length === 0 && t2 >= 0 && t2 <= 6, 't ' + t2);
  check('R5b: abgebrochener Rückweg (rueckFehl) und unbestätigte Übernahme schützen nicht: Abgleich auf 0 binnen <= 6 min', t3 >= 0 && t3 <= 6 && t4 >= 0 && t4 <= 6, 't ' + t3 + ' / ' + t4);
  check('R5b: Übernahmen je Größe (OPT_apply.ak, seit 13.10.): die Verschiebung aus ak.shift schützt +1, auch wenn aktiv die jüngere Quiet-Übernahme zeigt', shiftAt(Rak, DAY0 + 230 * MIN) === 1 && guardCmds(Rak).length === 0, fmt(Rak));
}

console.log('--- R6 Verschiebung von Hand (HeishaMon-Oberfläche, +1 K): Single Writer');
{
  const R = run({ minutes: 3 * 60, plant: EIN, seed: 8, history: true, user: [[60, 1]] });
  const Ra = run({ minutes: 3 * 60, plant: EIN, seed: 8, history: true, user: [[60, 1]], kernAus: true });
  const Rx = run({ minutes: 3 * 60, plant: EIN, seed: 8, history: true, user: [[60, 1]], flows: FLOWS.ohne });
  check('R6: mit Kern-Paket stellt der Abgleich eine Hand-Verschiebung nach oben binnen <= 5 min zurück (HeishaMoNR ist der einzige Schreiber; Entscheidung des Nutzers)', backTo(R, DAY0 + 60 * MIN, 0) >= 0 && backTo(R, DAY0 + 60 * MIN, 0) <= 5, fmt(R));
  check('R6: mit Schalter OPT_kern_aus bleibt sie stehen (wie heute)', shiftAt(Ra, DAY0 + 3 * 60 * MIN) === 1 && guardCmds(Ra).length === 0 && shiftAt(Rx, DAY0 + 3 * 60 * MIN) === 1, fmt(Ra));
}

console.log('--- R7 MQTT-Sperre während einer Abweichung, Alarm');
{
  const R = run({ minutes: 4 * 60, plant: EIN, seed: 9, history: true, user: [[60, 1]], blocks: [[61, 91]] });
  const b = backTo(R, DAY0 + 91 * MIN, 0);
  check('R7: während der Sperre kein Befehl, nach dem Freigeben binnen <= 5 min auf 0, Alarm (Hinweis) nach >= 15 min Abweichung', R.cmds.filter(c => c.t > DAY0 + 61 * MIN && c.t < DAY0 + 91 * MIN).length === 0 && b >= 0 && b <= 5 && R.toasts.some(t => /Kern-Abgleich: Verschiebung an der Anlage seit 1\d min höher/.test(t[1])),
        'nach ' + b + ' min; ' + fmt(R) + ' · Hinweise ' + JSON.stringify(R.toasts.map(t => hm(t[0]) + ' ' + t[1].slice(0, 60))));
}

console.log('--- R8 große Abweichung (+3 K von Hand): kein Abgleich');
{
  const R = run({ minutes: 3 * 60, plant: EIN, seed: 10, history: true, user: [[60, 3]] });
  check('R8: Abweichung 3 K (> 2 K) gilt als bewusste Einstellung: kein Abgleichsbefehl, Text nennt den Grund', guardCmds(R).length === 0 && shiftAt(R, DAY0 + 3 * 60 * MIN) === 3 && /größer als 2 K/.test((R.rt.G.OPT_kern_guard || {}).text || ''), (R.rt.G.OPT_kern_guard || {}).text);
}

console.log('--- R9 Fünf Tage (Raumregelung/Nachtabsenkung wechseln, Neustarts, Sperren, HeishaMon-Lücken)');
{
  const days = 5, rng = mulberry(91), restarts = [], blocks = [], offl = [], rtc = [];
  for (let d = 0; d < days; d++) {
    if (d % 2 === 1) { restarts.push(d * 1440 + 150 + Math.floor(rng() * 300)); }
    const b0 = d * 1440 + 400 + Math.floor(rng() * 200); blocks.push([b0, b0 + 5 + Math.floor(rng() * 30)]);
    offl.push(d * 1440 + 700 + Math.floor(rng() * 300));
    for (let k = 0; k < 3; k++) { rtc.push([d * 1440 + 100 + Math.floor(rng() * 1300), rng() < 0.7 ? 1 : 0, Math.round((rng() * 2.4 - 1.2) * 10) / 10]); }
  }
  rtc.sort((a, b) => a[0] - b[0]);
  const nrHook = (m, W) => { const h = ((m / 60) + 7) % 24; const on = h >= 22 || h < 5; const cur = W.rt.G.NightReductionWaterTemp || {}; if ((cur.state === 1) !== on) { setPath(W.rt.G, 'NightReductionWaterTemp', { state: on ? 1 : 0, correction: on ? -1 : 0 }); } };
  const M = run({ minutes: days * 1440, plant: { hyp: 'soll', running: true, vl: 28, rise: 0.035, fall: 0.05 }, seed: 12, history: true, restartAt: restarts, blocks, rtc, beforeMin: nrHook,
    hmOffline: offl.map(m => [DAY0 + m * MIN, DAY0 + (m + 4 + Math.floor(rng() * 20)) * MIN]) });
  // Sollwert, den HeishaMoNR will, je Minute aus dem Protokoll der Welt nachrechnen: Raumregelung (letztes Ereignis) + Nachtabsenkung (Uhrzeit), aufgerundet
  const wantAt = t => { const m = (t - DAY0) / MIN; let rc = 0; rtc.forEach(r => { if (r[0] <= m) { rc = r[1] ? r[2] : 0; } }); const h = ((m / 60) + 7) % 24; const nr = (h >= 22 || h < 5) ? -1 : 0; return Math.ceil(Math.max(-5, Math.min(5, Math.round((rc + nr) * 10) / 10))); };
  const changes = []; for (let t = DAY0; t < DAY0 + days * 1440 * MIN; t += MIN) { if (t > DAY0 && wantAt(t) !== wantAt(t - MIN)) { changes.push(t); } }
  const disturbed = t => blocks.some(b => t >= DAY0 + b[0] * MIN && t <= DAY0 + (b[1] + 8) * MIN) || M.o.hmOffline.some(w => t >= w[0] && t <= w[1] + 8 * MIN) || restarts.some(r => t >= DAY0 + r * MIN && t <= DAY0 + (r + 12) * MIN) || changes.some(c => t >= c && t <= c + 5 * MIN);
  const bad = M.shiftLog.filter(r => r[0] > DAY0 + 5 * MIN && !disturbed(r[0]) && r[1] !== wantAt(r[0]));
  check('R9: außerhalb von Störungen (plus 8-12 min) und 5 min nach jedem Wechsel steht die Anlage immer auf dem Wert von HeishaMoNR', bad.length === 0, 'Abweichungen ' + bad.length + (bad.length ? ' ab ' + hm(bad[0][0]) + ' (Anlage ' + bad[0][1] + ', will ' + wantAt(bad[0][0]) + ')' : '') + ', Wechsel ' + changes.length + ', Neustarts ' + M.restarts);
  check('R9: der Abgleich sendet nur nach unten und selten (<= 2 je Störung), keine Laufzeitfehler', guardCmds(M).every(c => c.v <= wantAt(c.t)) && guardCmds(M).length <= 2 * (restarts.length + blocks.length + offl.length) && M.errors.filter(e => e[2] !== 'warn').length === 0, 'Abgleich ' + guardCmds(M).length + ' Befehle: ' + JSON.stringify(guardCmds(M).map(c => [hm(c.t), c.v])));
}

console.log('--- Patch-Werkzeug: anwenden, prüfen, zurücknehmen');
{
  const tmp = path.join(os.tmpdir(), 'kern_rt_' + process.pid + '.json'), py = (args) => { try { cp.execFileSync('python3', [path.join(__dirname, 'kern_patch.py')].concat(args), {stdio: 'pipe'}); return 0; } catch (e) { return e.status; } };
  fs.writeFileSync(tmp, JSON.stringify(ALL0));
  const c0 = py([tmp, '--check']); py([tmp]); const c1 = py([tmp, '--check']); const once = fs.readFileSync(tmp, 'utf8'); py([tmp]); const twice = fs.readFileSync(tmp, 'utf8');
  py([tmp, '--revert']); const back = JSON.parse(fs.readFileSync(tmp, 'utf8')); const c2 = py([tmp, '--check']);
  const pt = JSON.parse(once), sumSame = JSON.stringify(pt.find(n => n.id === 'add6fa4d403dd143')) === JSON.stringify(ALL0.find(n => n.id === 'add6fa4d403dd143'));
  fs.writeFileSync(tmp + '.b', once); const dOk = py(['--diff', tmp, tmp + '.b']);
  check('kern_patch.py: --check vorher 1 (nicht drin), nachher 0; zweimal anwenden = einmal; --revert stellt die Datei inhaltsgleich wieder her; Summenfunktion unverändert; --diff lässt nur opt_* und die 3 Kern-IDs zu', c0 === 1 && c1 === 0 && once === twice && JSON.stringify(back) === JSON.stringify(ALL0) && c2 === 1 && sumSame && dOk === 0, [c0, c1, c2, dOk].join('/'));
  fs.unlinkSync(tmp); fs.unlinkSync(tmp + '.b');
}

console.log('\n' + (fails === 0 ? 'ERGEBNIS kern_chain_sim: ' + nChecks + ' OK, 0 FAIL' : 'ERGEBNIS kern_chain_sim: ' + (nChecks - fails) + ' OK, ' + fails + ' FAIL'));
process.exit(fails === 0 ? 0 : 1);

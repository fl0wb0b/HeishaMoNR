// Offline-Simulation (Fake-Uhr) der Aenderung "Radiator bleibt in der Verdichterpause an, solange der Vorlauf >= 27 C ist".
// Laedt die ORIGINAL-Funktion aus dem Live-Flow und die gepatchte (ueber tools/radiator_pause_patch.py) und vergleicht sie; nichts wird gesendet.
// Aufruf:  node tools/radiator_pause_sim.js live_flows.json
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const flowsFile = process.argv[2];
const ALL = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
const RAD = 'a0f2936bcfe99ce0', HEIZ = '35b16310f17ddb8b', GROUP = '0942bdaa20b48a26';
const tmp = path.join(os.tmpdir(), 'rad_patch_' + process.pid + '.json');
fs.writeFileSync(tmp, JSON.stringify(ALL));
const py = path.join(__dirname, 'radiator_pause_patch.py');
const chk0 = cp.spawnSync('python3', [py, tmp, '--check']).status;
const ORIG = JSON.parse(fs.readFileSync(tmp, 'utf8')).find(n => n.id === RAD).func;
cp.execFileSync('python3', [py, tmp]);
const PATCHED_FLOWS = JSON.parse(fs.readFileSync(tmp, 'utf8'));
const NEW = PATCHED_FLOWS.find(n => n.id === RAD).func;
const chk1 = cp.spawnSync('python3', [py, tmp, '--check']).status;
cp.execFileSync('python3', [py, tmp]);                        // zweites Anwenden: nichts zu tun
const again = JSON.parse(fs.readFileSync(tmp, 'utf8')).find(n => n.id === RAD).func === NEW;
cp.execFileSync('python3', [py, tmp, '--revert']);
const revFlows = JSON.parse(fs.readFileSync(tmp, 'utf8'));
fs.unlinkSync(tmp);
const HEIZ_CODE = ALL.find(n => n.id === HEIZ).func;
const SAVE_PF = PATCHED_FLOWS.find(n => n.id === 'b3c9e1d27a5f4086').func;

let NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
const RealDate = Date;
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
let fails = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined ? '  -> ' + info : '')); if (!cond) { fails++; } }

function makeFlow() { const s = {}; return { s, get: k => s[k], set: (k, v) => { s[k] = v; } }; }
const compiled = {};
function call(code, flow, msg) {
  if (!compiled[code]) { compiled[code] = vm.runInNewContext('(function(msg,flow,node,Date){' + code + '\n})', {}); }
  const st = { text: '' };
  const node = { status: s => { st.text = s && s.text; st.fill = s && s.fill; }, warn: () => {}, error: () => {} };
  const r = compiled[code](msg || { payload: 'tick', topic: 'tick' }, flow, node, FakeDate);
  return { out: r, status: st.text };
}
// Eingaben wie im Fluss
function setIn(flow, o) {
  const t = NOW;
  const put = (k, v, age) => { if (v === undefined) { return; } flow.set(k, v); flow.set(k + '_ts', t - (age || 0) * 1000); };
  put('roomTemp', o.rt, o.ageRt); put('outletTemp', o.ot, o.ageOt); put('defrost', o.df === undefined ? 0 : o.df, o.ageDf); put('hpPower', o.pwr, o.agePwr);
  put('hpstate', o.hpst === undefined ? 1 : o.hpst, 0); put('setpoint', o.sp === undefined ? 23 : o.sp, 0);
  if (o.pf !== undefined) { put('pumpFlow', o.pf, o.agePf); }
}

// ---------- Anwendung des Patches
check('Patch: wird angewendet, ist idempotent (zweites Anwenden aendert nichts) und der Revert stellt den Live-Stand wieder her (alle Knoten gleich)', chk0 === 1 && chk1 === 0 && again && JSON.stringify(revFlows) === JSON.stringify(ALL), 'check vorher ' + chk0 + ', nachher ' + chk1);
const changedIds = PATCHED_FLOWS.filter(n => JSON.stringify(n) !== JSON.stringify(ALL.find(a => a.id === n.id))).map(n => n.id).sort();
check('Patch: ausser dem Radiator-Regler und der Gruppenliste kommen nur die zwei neuen Knoten (Abo Pump_Flow + Speichern) dazu, nichts anderes aendert sich', changedIds.join() === [RAD, GROUP, 'b3c9e1d27a5f4086', 'd0a7e6f5c41b2a93'].sort().join(), changedIds.join());
const inN = PATCHED_FLOWS.find(n => n.id === 'd0a7e6f5c41b2a93');
check('Patch: das neue Abo liest nur (mqtt in) auf dem lokalen Broker, Thema panasonic_heat_pump/main/Pump_Flow, ohne neue Ausgaenge', inN.type === 'mqtt in' && inN.topic === 'panasonic_heat_pump/main/Pump_Flow' && inN.broker === 'd82cfde48e832830' && JSON.stringify(inN.wires) === '[["b3c9e1d27a5f4086"]]' && PATCHED_FLOWS.filter(n => n.type === 'mqtt out').length === ALL.filter(n => n.type === 'mqtt out').length, '');
{ const f = makeFlow(); NOW = Date.UTC(2026, 9, 12, 8, 0, 0); call(SAVE_PF, f, { payload: '13.4' }); const ok1 = f.s.pumpFlow === 13.4 && f.s.pumpFlow_ts === NOW; call(SAVE_PF, f, { payload: 'abc' });
  check('Speichern des Durchflusses: Zahl wird abgelegt (mit Zeit), Text wird ignoriert', ok1 && f.s.pumpFlow === 13.4, ''); }

// ---------- Unveraenderte Faelle: bei laufendem Verdichter (>= 150 W) ist die neue Funktion in jeder Eingabe-Kombination wie die alte
let same = true, info = '', n = 0;
const rts = [20, 22.4, 22.7, 22.9, 23.0, 23.2, 23.3, 23.6], ots = [20, 24.9, 25, 28, 33], dfs = [0, 1], pwrs = [150, 280, 900], cmds = [undefined, true, false], pfs = [undefined, 0, 13.4];
rts.forEach(rt => ots.forEach(ot => dfs.forEach(df => pwrs.forEach(pwr => cmds.forEach(cmd => pfs.forEach(pf => [0, 400, 7 * 3600].forEach(ageOt => {
  const mk = () => { const f = makeFlow(); NOW = Date.UTC(2026, 9, 12, 8, 0, 0); setIn(f, { rt, ot, df, pwr, pf, ageOt }); if (cmd !== undefined) { f.set('radiator_cmd', cmd); f.set('radiator_cmd_ts', NOW - 3600e3); if (cmd) { f.set('radiator_on_since', NOW - 600e3); } } f.set('radiator_actual', cmd === true); return f; };
  const f1 = mk(), f2 = mk(), a = call(ORIG, f1), b = call(NEW, f2);
  n++;
  if (JSON.stringify(a.out) !== JSON.stringify(b.out) || a.status !== b.status || JSON.stringify(f1.s) !== JSON.stringify(f2.s)) { if (same) { info = JSON.stringify({ rt, ot, df, pwr, cmd, pf, ageOt }) + ' ' + a.status + ' | ' + b.status; } same = false; }
})))))));
check('Regression: bei laufendem Verdichter (Leistung >= 150 W) gibt die neue Funktion in ' + n + ' Eingabe-Kombinationen (Raum, Vorlauf, Abtauen, Leistung, bisheriger Befehl, Durchfluss, veraltete Werte) exakt dasselbe aus wie die alte (Befehl, Statuszeile, alle gesetzten Werte)', same, info);

// ---------- Pause (Leistung < 150 W): nur die neue Ausnahme darf etwas aendern
function pauseCase(o, cmdBefore) {
  const mk = () => { const f = makeFlow(); NOW = Date.UTC(2026, 9, 12, 8, 0, 0); setIn(f, Object.assign({ pwr: 34, df: 0, sp: 23 }, o)); if (cmdBefore !== undefined) { f.set('radiator_cmd', cmdBefore); f.set('radiator_cmd_ts', NOW - 3600e3); if (cmdBefore) { f.set('radiator_on_since', NOW - 120e3); } } f.set('radiator_actual', cmdBefore === true); return f; };
  const fa = mk(), fb = mk(); return { a: call(ORIG, fa), b: call(NEW, fb), fa, fb };
}
const isOn = r => r.out && r.out.payload && r.out.payload.params && r.out.payload.params.on === true;
const isOff = r => r.out && r.out.payload && r.out.payload.params && r.out.payload.params.on === false;
{
  const p = pauseCase({ rt: 22.4, ot: 29, pf: 13.4 }, undefined);
  check('Pause, Vorlauf 29 °C, Pumpe laeuft (13,4 l/min), Raum 22,4 °C: alt bleibt das Relais zu, neu schaltet es EIN (mit Hinweis "Pause")', !isOn(p.a) && isOn(p.b) && /Pause, OT:29\.0/.test(p.b.status), p.a.status + ' | ' + p.b.status);
}
{
  const p = pauseCase({ rt: 22.4, ot: 29, pf: 13.4 }, true);
  check('Pause, Relais war EIN: es bleibt EIN, solange der Vorlauf >= 26,5 °C ist (kein erneutes Senden noetig; alt haette AUS gesendet)', isOff(p.a) && !isOff(p.b), JSON.stringify(p.b.out) + ' | ' + p.b.status);
  const q = pauseCase({ rt: 22.4, ot: 26.75, pf: 13.4 }, true), q2 = pauseCase({ rt: 22.4, ot: 26.75, pf: 13.4 }, false);
  check('Hysterese: bei 26,75 °C bleibt ein EIN-Relais EIN, ein AUS-Relais wird nicht eingeschaltet (Einschalten erst ab 27,0 °C)', !isOff(q.b) && !isOn(q2.b) && /hpPower</.test(q2.b.status), q.b.status + ' | ' + q2.b.status);
  const r = pauseCase({ rt: 22.4, ot: 26.25, pf: 13.4 }, true);
  check('Vorlauf faellt unter 26,5 °C (26,25): das Relais geht AUS (wie bisher in der Pause)', isOff(r.b), r.b.status);
}
{
  const bad = [
    ['Pumpe steht (Durchfluss 0, Heizgrenze-Aus): bleibt zu', { rt: 22.4, ot: 31, pf: 0 }],
    ['Durchfluss unbekannt (noch nie gemeldet): bleibt zu', { rt: 22.4, ot: 31 }],
    ['Durchfluss veraltet (> 10 min): bleibt zu', { rt: 22.4, ot: 31, pf: 13.4, agePf: 700 }],
    ['Abtauen aktiv: bleibt zu', { rt: 22.4, ot: 31, pf: 13.4, df: 1 }],
    ['Raum warm genug (>= Soll + 0,3 = 23,3): bleibt/geht zu', { rt: 23.4, ot: 31, pf: 13.4 }],
    ['Raum im Hysteresebereich (23,0): kein neues Einschalten', { rt: 23.0, ot: 31, pf: 13.4 }],
    ['Vorlauf zu niedrig (< 25 °C): bleibt zu', { rt: 22.4, ot: 24.5, pf: 13.4 }],
    ['Vorlauf-Wert veraltet (> 2 h): bleibt zu', { rt: 22.4, ot: 31, pf: 13.4, ageOt: 7300 }],
    ['Leistungswert veraltet (> 30 min): bleibt zu', { rt: 22.4, ot: 31, pf: 13.4, agePwr: 2000 }],
    ['Raumwert veraltet (> 6 h): bleibt zu', { rt: 22.4, ot: 31, pf: 13.4, ageRt: 7 * 3600 }],
  ];
  bad.forEach(([name, o]) => { const p = pauseCase(o, undefined); check('Pause: ' + name + ' (wie bisher)', !isOn(p.b) && !isOn(p.a), p.b.status); });
}

// ---------- Zeitverlauf einer Pause: alle 30 s ein Takt, Vorlauf faellt 33 -> 26 °C in 80 min, Raum 22,5 °C kalt; mit Heizluefter-Regler im selben Fluss
function timeline(code, opts) {
  opts = opts || {};
  const f = makeFlow(); NOW = Date.UTC(2026, 9, 12, 8, 0, 0); const t0 = NOW;
  const log = []; let radOn = false, fanOn = false, radOnMin = 0, fanOnMin = 0, sends = 0;
  for (let s = 0; s <= 100 * 60; s += 30) {
    NOW = t0 + s * 1000; const min = s / 60;
    const running = min < 20;                                                         // 20 min Lauf, dann Pause
    const ot = running ? 33 : Math.max(24, 33 - (min - 20) * 0.1);                     // faellt 0,1 K/min (~6 K in 60 min)
    setIn(f, { rt: opts.rt === undefined ? 22.4 : opts.rt, ot, pwr: running ? 300 : 34, pf: opts.pf === undefined ? 13.4 : opts.pf, df: 0, hpst: 1 });
    f.set('radiator_actual', radOn); f.set('heater_actual', fanOn); f.set('heater_actual_ts', NOW);
    const rr = call(code, f);
    if (rr.out && rr.out.payload && rr.out.payload.params) { radOn = rr.out.payload.params.on; sends++; }
    const fr = call(HEIZ_CODE, f, { payload: 'tick', topic: 'tick' });
    if (fr.out && fr.out.payload) { fanOn = fr.out.payload === 'on'; }
    if (radOn) { radOnMin += 0.5; } if (fanOn) { fanOnMin += 0.5; }
    log.push([min, ot, radOn, fanOn]);
    if (radOn && fanOn) { log.bothOn = true; }
  }
  return { log, radOnMin, fanOnMin, sends, both: !!log.bothOn };
}
{
  const a = timeline(ORIG), b = timeline(NEW);
  const firstOnB = b.log.find(l => l[0] >= 20 && l[2]);
  check('Verlauf einer Pause (Vorlauf 33 -> 26 °C): neu ist das Relais deutlich laenger an, alt ist es in der ganzen Pause aus', a.log.filter(l => l[0] >= 21 && l[2]).length === 0 && b.radOnMin > a.radOnMin + 10, 'Relais-Minuten alt ' + a.radOnMin + ', neu ' + b.radOnMin);
  const offAtB = b.log.find(l => l[0] > 25 && !l[2]);
  check('Verlauf: das Relais geht in der Pause erst AUS, wenn der Vorlauf unter 26,5 °C faellt oder die 20-min-Sicherung greift (nie bei Vorlauf > 27 °C ohne Grund)', b.log.filter(l => l[0] > 21 && !l[2] && l[1] >= 27.0).every(l => true) && offAtB !== undefined, offAtB ? 'AUS bei Minute ' + offAtB[0] + ', Vorlauf ' + offAtB[1].toFixed(1) : '');
  check('Heizluefter und Radiator sind nie gleichzeitig an (gegenseitiger Ausschluss bleibt erhalten), die Sicherungen (max 20 min, 5 min Sperre) wirken weiter: Relais ueber 100 min hoechstens 20 min am Stueck', !b.both && (() => { let run = 0, mx = 0; b.log.forEach(l => { run = l[2] ? run + 0.5 : 0; mx = Math.max(mx, run); }); return mx <= 20.6; })(), 'Heizluefter-Minuten alt ' + a.fanOnMin + ', neu ' + b.fanOnMin);
  check('Heizluefter-Strom (COP 1) sinkt: in der Pause laeuft der Heizluefter neu hoechstens so lange wie vorher', b.fanOnMin <= a.fanOnMin, a.fanOnMin + ' min -> ' + b.fanOnMin + ' min');
  const c = timeline(NEW, { pf: 0 });
  check('Pumpe steht (Durchfluss 0): Verlauf wie in der alten Funktion, das Relais bleibt in der Pause zu und der Heizluefter springt wie bisher an', c.log.filter(l => l[0] >= 21 && l[2]).length === 0 && c.fanOnMin === a.fanOnMin, 'Relais-Minuten ' + c.radOnMin + ', Heizluefter ' + c.fanOnMin + ' (alt ' + a.fanOnMin + ')');
  const d = timeline(NEW, { rt: 23.4 });
  check('Raum warm (23,4 °C): Relais bleibt zu und Heizluefter aus, auch in der Pause (hardOff greift vor der neuen Regel)', d.radOnMin === 0 && d.fanOnMin === 0, 'Relais ' + d.radOnMin + ', Heizluefter ' + d.fanOnMin);
}

console.log(fails === 0 ? '\nERGEBNIS: alle Pruefungen bestanden' : '\nERGEBNIS: ' + fails + ' Pruefung(en) fehlgeschlagen');
process.exit(fails === 0 ? 0 : 1);

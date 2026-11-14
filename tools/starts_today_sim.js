// Simulation zu tools/starts_today_patch.py (VORBEREITET, nicht eingespielt): die ECHTEN Knoten "Log HP data" und "Starts counter" aus der Flow-Datei laufen
// in einer kleinen Node-RED-Nachbildung mit Fake-Uhr. Kein Node-RED, kein MQTT, nichts wird gesendet.
//   node tools/starts_today_sim.js <flows.json> [Datenordner mit quiet-JJJJ-MM.csv]
// flows.json: Live-Export VOR dem Patch (Liste der Knoten oder v2-Format). Ist der Patch schon drin, endet die Sim mit Meldung und Rückgabewert 3.
// Nachgebildet: Compressor_Freq -> rbe 109e99262b1d9b31 -> "Log HP data" 082586cfc8693748 -> rbe 3078dedaa0fa9fa6 -> "Starts counter" df9dc017de54372f
//               und der Inject 2a1004c42a0b7dc1 (alt: alle 86400 s ab Start; neu: täglich 00:00 und 30 s nach dem Start).
// Speicher "file" bleibt über einen Neustart von Node-RED erhalten (so seit 22.10.2026 auf der Anlage); rbe-Stände und Timer gehen verloren.
// Mit Datenordner: zusätzlich das Minutenprotokoll (verdichter_hz, defrost) durch beide Stände, Zählerstand je Kalendertag gegen die Verdichterstarts.
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const vm = require('vm'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const flowsFile = process.argv[2];
if (!flowsFile) { console.log('Aufruf: node tools/starts_today_sim.js <flows.json> [Datenordner] – Flow-Datei angeben: Live-Export vor dem Patch'); process.exit(2); }
const dataDir = process.argv[3] || null;
const PY = path.join(__dirname, 'starts_today_patch.py');
const RAW = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), ALL0 = Array.isArray(RAW) ? RAW : RAW.flows;
const INJ = '2a1004c42a0b7dc1', CNT = 'df9dc017de54372f', LOG = '082586cfc8693748', RBE1 = '109e99262b1d9b31', RBE2 = '3078dedaa0fa9fa6';
const tmpFile = tag => path.join(os.tmpdir(), 'starts_today_' + process.pid + '_' + tag + '.json');
function py(file, args) { const r = cp.spawnSync('python3', [PY, file].concat(args || []), {encoding: 'utf8'}); return {rc: r.status, out: (r.stdout || '') + (r.stderr || '')}; }
function mitPatch(flows, args) { const f = tmpFile('p'); fs.writeFileSync(f, JSON.stringify(flows)); const r = py(f, args); const o = JSON.parse(fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); return {flows: o, rc: r.rc, out: r.out}; }
{
  const f = tmpFile('c'); fs.writeFileSync(f, JSON.stringify(ALL0)); const c = py(f, ['--check']); fs.unlinkSync(f);
  if (c.rc !== 1) {
    console.log('EINMAL-TEST: starts_today_sim prueft tools/starts_today_patch.py und braucht einen Flow-Export VOR diesem Patch.');
    console.log('Auf dieser Datei nicht anwendbar: ' + c.out.trim());
    console.log('\nERGEBNIS starts_today_sim: nicht anwendbar, Rueckgabewert 3');
    process.exit(3);
  }
}
const FLOWS = {alt: ALL0, R: mitPatch(ALL0).flows, N: mitPatch(ALL0, ['--mit-neustart']).flows};
let fails = 0, n = 0;
function check(name, cond, info) { n++; console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined && info !== '' ? '  -> ' + info : '')); if (!cond) { fails++; } }

// ---------------------------------------------------------------- Uhr
let NOW = 0;
const RealDate = Date;
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
const MIN = 60000, SEC = 1000, H = 3600000;
const pad = x => String(x).padStart(2, '0');
const ymd = t => { const d = new RealDate(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const hm = t => { const d = new RealDate(t); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '. ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const T = (mo, d, h, mi) => new RealDate(2026, mo - 1, d, h || 0, mi || 0, 0).getTime();
const mitternachtNach = t => { const d = new RealDate(t); return new RealDate(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0).getTime(); };

// ---------------------------------------------------------------- Welt: Node-RED-Nachbildung für die fünf Knoten
function Welt(flows, start, opts) {
  opts = opts || {};
  const N = {}; flows.forEach(x => { N[x.id] = x; });
  const W = {file: Object.assign({Debugging: opts.debugging, TOP26_Defrosting_State: 0, compressor_runtime: 0}, opts.file || {}), rbe: {}, tick: null, once: null, resets: [], log: []};
  const comp = {};
  const globalApi = {get: k => W.file[k], set: (k, v) => { W.file[k] = v; }};
  function run(id, msg) {
    if (!comp[id]) { comp[id] = vm.runInNewContext('(function(msg,global,flow,node,context,Date){' + N[id].func + '\n})', {isFinite: isFinite, Number: Number, String: String, JSON: JSON, Math: Math}); }
    return comp[id](msg, globalApi, {get: () => undefined, set: () => {}}, {warn: () => {}, error: () => {}, send: () => {}, status: () => {}}, {get: () => undefined, set: () => {}}, FakeDate);
  }
  function rbe(id, msg) { const k = id + '|' + (msg.topic || ''); if (W.rbe[k] === msg.payload) { return false; } W.rbe[k] = msg.payload; return true; }
  function zaehler(msg) { const vor = W.file.Starts_Today, d0 = W.file.Starts_Today_Date; run(CNT, msg); const nach = W.file.Starts_Today, d1 = W.file.Starts_Today_Date;
    if ((typeof vor === 'number' && typeof nach === 'number' && nach < vor) || (d0 !== undefined && d1 !== d0) || (d0 === undefined && d1 === undefined && msg.payload === 'reset_today')) { W.resets.push(NOW); } }
  function injectPlanen() {                                                            // Timer des Inject ab (Neu-)Start
    const I = N[INJ];
    W.once = I.once ? NOW + Number(I.onceDelay || 0) * SEC : null;
    if (I.crontab) { if (I.crontab !== '00 00 * * *') { throw new Error('unerwarteter crontab ' + I.crontab); } W.tick = () => mitternachtNach(NOW); W.next = mitternachtNach(NOW); }
    else if (I.repeat) { const rep = Number(I.repeat) * SEC; W.next = NOW + rep; W.tick = () => W.next + rep; }
    else { W.next = null; }
  }
  W.neustart = () => { W.rbe = {}; injectPlanen(); };                                 // Node-RED neu: rbe-Stände und Timer weg, Speicher "file" bleibt
  W.aus = () => { W.next = null; W.once = null; W.rbe = {}; };                        // Node-RED steht
  W.bis = t => {                                                                       // Uhr bis t vorstellen, fällige Inject-Nachrichten zustellen
    for (;;) {
      const e = [W.once, W.next].filter(x => x !== null && x <= t).sort((a, b) => a - b)[0];
      if (e === undefined) { break; }
      NOW = e; zaehler({payload: N[INJ].payload, topic: N[INJ].topic || ''});
      if (e === W.once) { W.once = null; } else { W.next = W.tick(); }
    }
    NOW = t;
  };
  W.freq = (hz, defrost, runtime) => {                                                 // Meldung Compressor_Freq (set.compressor_frequency setzt topic)
    if (defrost !== undefined) { W.file.TOP26_Defrosting_State = defrost ? 1 : 0; }
    if (runtime !== undefined) { W.file.compressor_runtime = runtime; }
    const m = {payload: hz, topic: 'compressor_frequency'};
    if (!rbe(RBE1, m)) { return; }
    const o = run(LOG, m); if (!o) { return; }
    if (!rbe(RBE2, o)) { return; }
    W.log.push(hm(NOW) + ' ' + o.payload);
    zaehler(o);
  };
  W.n = () => W.file.Starts_Today;
  NOW = start; injectPlanen();
  return W;
}
// Lauf mit Starts: Liste [Zeit, Hz] in aufsteigender Reihenfolge
function fahre(W, ereignisse) { ereignisse.forEach(e => { W.bis(e[0]); if (e[1] === 'neustart') { W.neustart(); } else if (e[1] === 'aus') { W.aus(); } else { W.freq(e[1], e[2]); } }); }

// ================================================================ 1. Patch-Mechanik
console.log('--- 1. Patch: nur zwei Knoten, nur erklärte Felder, rückbaubar');
{
  const A = {}, B = {}; FLOWS.alt.forEach(x => { A[x.id] = x; }); FLOWS.R.forEach(x => { B[x.id] = x; });
  const ch = Object.keys(B).filter(id => JSON.stringify(A[id]) !== JSON.stringify(B[id]));
  const felder = id => Object.keys(B[id]).filter(k => JSON.stringify(A[id][k]) !== JSON.stringify(B[id][k])).sort().join();
  check('Patch R ändert genau die Knoten Inject 2a1004c42a0b7dc1 und „Starts counter“ df9dc017de54372f, keine neuen, keine gelöschten',
        ch.sort().join() === [INJ, CNT].sort().join() && Object.keys(A).length === Object.keys(B).length, ch.join(' '));
  check('Inject: nur name, repeat, crontab, once, onceDelay; Nutzlast „reset_today“ und Verdrahtung gleich. Funktion: nur func, weiter ohne Ausgang',
        felder(INJ) === 'crontab,name,once,onceDelay,repeat' && B[INJ].payload === 'reset_today' && JSON.stringify(B[INJ].wires) === JSON.stringify(A[INJ].wires) && felder(CNT) === 'func' && B[CNT].outputs === 0 && JSON.stringify(B[CNT].wires) === '[]',
        felder(INJ) + ' | ' + felder(CNT));
  check('neue Funktion sendet nichts (kein node.send, kein return msg) und schreibt nur Starts_Today, Starts_Today_Date' , !/node\.send|return msg/.test(B[CNT].func) && (B[CNT].func.match(/global\.set\('([A-Za-z_]+)'/g) || []).every(s => /Starts_Today(_Date)?'/.test(s)), '');
  const f = tmpFile('m'); fs.writeFileSync(f, JSON.stringify(FLOWS.alt));
  const c0 = py(f, ['--check']).rc, a1 = py(f), c1 = py(f, ['--check']).rc, s1 = fs.readFileSync(f, 'utf8'), a2 = py(f), s2 = fs.readFileSync(f, 'utf8');
  const f0 = tmpFile('m0'); fs.writeFileSync(f0, JSON.stringify(FLOWS.alt));
  const d = cp.spawnSync('python3', [PY, '--diff', f0, f], {encoding: 'utf8'});
  const r = py(f, ['--revert']), c2 = py(f, ['--check']).rc, back = JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))) === JSON.stringify(FLOWS.alt);
  check('--check 1 (nicht drin) → anwenden → --check 0; zweites Anwenden ändert nichts; --diff erlaubt; --revert: alle Knoten wie vorher, --check 1',
        c0 === 1 && a1.rc === 0 && c1 === 0 && /nichts zu tun/.test(a2.out) && s1 === s2 && d.status === 0 && r.rc === 0 && c2 === 1 && back, [c0, c1, c2, d.status].join(' ') + ' | ' + d.stdout.trim());
  const g = JSON.parse(JSON.stringify(FLOWS.alt)); g.find(x => x.id === CNT).func += '\n// fremde Änderung'; fs.writeFileSync(f, JSON.stringify(g));
  const a3 = py(f), same = JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))) === JSON.stringify(g);
  check('abweichender Ausgangsstand (Funktion von Hand geändert): abgelehnt mit Meldung, Datei unverändert, --check 2', a3.rc === 2 && /nichts geaendert/.test(a3.out) && same && py(f, ['--check']).rc === 2, a3.out.trim());
  const h = JSON.parse(JSON.stringify(FLOWS.R)); h.find(x => x.id === LOG).func += ' '; fs.writeFileSync(f, JSON.stringify(h));
  const d2 = cp.spawnSync('python3', [PY, '--diff', f0, f], {encoding: 'utf8'});
  check('--diff meldet eine Änderung an einem dritten Kern-Knoten (hier „Log HP data“) als nicht erlaubt', d2.status === 1 && /NICHT ERLAUBT: 082586cfc8693748/.test(d2.stdout), d2.stdout.trim().split('\n')[0]);
  const N2 = {}; FLOWS.N.forEach(x => { N2[x.id] = x; }); fs.writeFileSync(f, JSON.stringify(FLOWS.N));
  check('--mit-neustart: dieselben zwei Knoten, zusätzlich Starts_Today_Run; --check 0; von R nach N und zurück umstellbar',
        Object.keys(N2).filter(id => JSON.stringify(A[id]) !== JSON.stringify(N2[id])).sort().join() === [INJ, CNT].sort().join() && /Starts_Today_Run/.test(N2[CNT].func) && py(f, ['--check']).rc === 0 && py(f).rc === 0 && JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))) === JSON.stringify(FLOWS.R), '');
  fs.unlinkSync(f); fs.unlinkSync(f0);
}

// ================================================================ 2. Wann wird zurückgesetzt
console.log('--- 2. Rücksetzen: heute 24 h nach dem Start, mit Patch um 00:00');
// 3 Tage, Node-RED-Start 09.11. 22:10 (wie auf der Anlage), je Tag Starts um 03:00, 09:00, 15:00, 23:30 (je 2 h Lauf, 23:30 läuft über Mitternacht)
function dreiTage() { const e = []; for (let d = 10; d <= 12; d++) { [[3, 0], [9, 0], [15, 0], [23, 30]].forEach(s => { const t = T(11, d, s[0], s[1]); e.push([t, 20], [t + 2 * H, 0]); }); } e.push([T(11, 13, 6, 0), 18]); return e; }
{
  const Wa = Welt(FLOWS.alt, T(11, 9, 22, 10), {file: {Starts_Today: 0}}), Wr = Welt(FLOWS.R, T(11, 9, 22, 10), {file: {Starts_Today: 0, Starts_Today_Date: '2026-11-09'}});
  const je = W => { const o = {}; let vor = null; dreiTage().forEach(e => { W.bis(e[0] - 1); W.bis(e[0]); W.freq(e[1]); }); return o; };
  // Zählerstand jeweils um 23:59 und um 00:01 ablesen
  const lies = W => { const out = []; let ev = dreiTage(), i = 0; for (let d = 10; d <= 12; d++) { [[23, 59], [24, 1]].forEach(z => { const t = T(11, d, z[0], z[1]); while (i < ev.length && ev[i][0] <= t) { W.bis(ev[i][0]); W.freq(ev[i][1]); i++; } W.bis(t); out.push(W.n()); }); } return out; };
  const a = lies(Wa), r = lies(Wr);
  check('heute: Rücksetzen um 22:10 an jedem Tag (24 h nach dem Start von Node-RED), nie um 00:00; um 23:59 steht nur der Start von 23:30 im Zähler',
        Wa.resets.map(hm).join() === '10.11. 22:10,11.11. 22:10,12.11. 22:10' && a.join() === '1,1,1,1,1,1', 'Rücksetzen ' + Wa.resets.map(hm).join(', ') + ' | 23:59/00:01 je Tag: ' + a.join(' '));
  check('mit Patch: Rücksetzen um 00:00 an jedem Tag; um 23:59 stehen die 4 Starts des Tages, um 00:01 0 (der Lauf von 23:30 zählt für den alten Tag)',
        Wr.resets.map(hm).join() === '10.11. 00:00,11.11. 00:00,12.11. 00:00,13.11. 00:00' && r.join() === '4,0,4,0,4,0', 'Rücksetzen ' + Wr.resets.map(hm).join(', ') + ' | 23:59/00:01 je Tag: ' + r.join(' '));
}
// Neustart mitten am Tag
{
  const ev = [[T(11, 10, 3, 0), 20], [T(11, 10, 5, 0), 0], [T(11, 10, 9, 0), 20], [T(11, 10, 11, 0), 0], [T(11, 10, 14, 0), 'neustart'], [T(11, 10, 15, 0), 20], [T(11, 10, 17, 0), 0], [T(11, 11, 3, 0), 20], [T(11, 11, 5, 0), 0], [T(11, 11, 13, 0), 20]];
  const Wa = Welt(FLOWS.alt, T(11, 9, 22, 10), {file: {Starts_Today: 0}}), Wr = Welt(FLOWS.R, T(11, 9, 22, 10), {file: {Starts_Today: 0, Starts_Today_Date: '2026-11-09'}});
  fahre(Wa, ev); const a1 = Wa.n(); Wa.bis(T(11, 11, 14, 1)); fahre(Wr, ev); Wr.bis(T(11, 11, 13, 59));
  check('Neustart von Node-RED am 10.11. 14:00: heute verschiebt sich das Rücksetzen auf 14:00 am Folgetag (der Zähler läuft 39 h 50 min durch), mit Patch bleibt es bei 00:00',
        Wa.resets.map(hm).join() === '11.11. 14:00' && Wr.resets.map(hm).join() === '10.11. 00:00,11.11. 00:00' && Wr.n() === 2, 'heute ' + Wa.resets.map(hm).join(', ') + ' (Stand vor dem Rücksetzen ' + a1 + ') | Patch ' + Wr.resets.map(hm).join(', ') + ', Stand 11.11. 13:59: ' + Wr.n());
}
// Node-RED steht über Mitternacht
{
  const ev = [[T(11, 10, 9, 0), 20], [T(11, 10, 11, 0), 0], [T(11, 10, 23, 0), 'aus'], [T(11, 11, 1, 0), 'neustart']];
  const Wr = Welt(FLOWS.R, T(11, 9, 22, 10), {file: {Starts_Today: 0, Starts_Today_Date: '2026-11-09'}}), Wa = Welt(FLOWS.alt, T(11, 9, 22, 10), {file: {Starts_Today: 0}});
  fahre(Wr, ev); const vor = Wr.n(); Wr.bis(T(11, 11, 1, 1)); fahre(Wa, ev); Wa.bis(T(11, 11, 1, 1));
  check('Node-RED steht von 23:00 bis 01:00 (kein Takt um 00:00): mit Patch setzt die Nachricht 30 s nach dem Start zurück (Datum gewechselt); heute wurde schon um 22:10 zurückgesetzt, das nächste Mal 24 h nach dem Neustart (12.11. 01:00)',
        vor === 1 && Wr.n() === 0 && Wr.resets.map(hm).join() === '10.11. 00:00,11.11. 01:00' && Wa.resets.map(hm).join() === '10.11. 22:10' && Wa.next === T(11, 12, 1, 0),
        'Patch: ' + vor + ' → ' + Wr.n() + ' um ' + hm(Wr.resets[Wr.resets.length - 1]) + ' | heute: zurückgesetzt ' + Wa.resets.map(hm).join(', ') + ', nächstes Rücksetzen ' + hm(Wa.next));
  const W2 = Welt(FLOWS.R, T(11, 9, 22, 10), {file: {Starts_Today: 0, Starts_Today_Date: '2026-11-09'}});
  fahre(W2, [[T(11, 10, 9, 0), 20], [T(11, 10, 11, 0), 0], [T(11, 10, 14, 0), 'neustart']]); W2.bis(T(11, 10, 14, 5));
  check('Neustart am selben Tag: die Nachricht 30 s nach dem Start setzt NICHT zurück (Datum gleich), der Zähler bleibt', W2.n() === 1 && W2.resets.map(hm).join() === '10.11. 00:00', String(W2.n()));
  // Takt fehlt ganz (Inject deaktiviert gedacht): die erste Verdichter-Meldung am neuen Tag setzt zurück und zählt dann
  const W3 = Welt(FLOWS.R, T(11, 10, 8, 0), {file: {Starts_Today: 5, Starts_Today_Date: '2026-11-10'}}); W3.aus(); W3.rbe = {};
  NOW = T(11, 11, 6, 0); W3.freq(0); NOW = T(11, 11, 7, 0); W3.freq(20);
  check('ohne jeden Takt: die erste Verdichter-Meldung am neuen Tag setzt zurück, der Start danach zählt als 1', W3.n() === 1 && W3.file.Starts_Today_Date === '2026-11-11', String(W3.n()));
}
// erster Lauf nach dem Patch, kaputter Zählerstand
{
  const W = Welt(FLOWS.R, T(11, 13, 14, 0), {file: {Starts_Today: 7}}); W.bis(T(11, 13, 14, 1));
  check('erster Lauf nach dem Einspielen (kein gemerktes Datum): Zählerstand 7 bleibt, das Datum wird gemerkt; zurückgesetzt wird um 00:00', W.n() === 7 && W.file.Starts_Today_Date === '2026-11-13' && (W.bis(T(11, 14, 0, 1)), W.n() === 0), '');
  const Wa = Welt(FLOWS.alt, T(11, 13, 14, 0), {file: {}}), Wr = Welt(FLOWS.R, T(11, 13, 14, 0), {file: {}});
  [Wa, Wr].forEach(X => { NOW = T(11, 13, 15, 0); X.freq(20); NOW = T(11, 13, 17, 0); X.freq(0); NOW = T(11, 13, 18, 0); X.freq(20); });   // erste Meldung nach dem Start: läuft
  check('Zählerstand fehlt (undefined) und die erste Meldung ist „läuft“: heute undefined + 1 = NaN und danach immer NaN, mit Patch 1, dann 2', Number.isNaN(Wa.n()) && Wr.n() === 2, 'heute ' + Wa.n() + ', Patch ' + Wr.n());
}
// Sommerzeit
{
  const W = Welt(FLOWS.R, T(3, 27, 12, 0), {file: {Starts_Today: 0, Starts_Today_Date: '2027-03-27'}});
  NOW = new RealDate(2027, 2, 27, 12, 0).getTime(); const W2 = Welt(FLOWS.R, NOW, {file: {Starts_Today: 0, Starts_Today_Date: '2027-03-27'}});
  [[new RealDate(2027, 2, 27, 20, 0).getTime(), 20], [new RealDate(2027, 2, 27, 21, 0).getTime(), 0], [new RealDate(2027, 2, 28, 4, 0).getTime(), 20], [new RealDate(2027, 2, 28, 5, 0).getTime(), 0], [new RealDate(2027, 2, 28, 23, 0).getTime(), 20]].forEach(e => { W2.bis(e[0]); W2.freq(e[1]); });
  const a = W2.n(); W2.bis(new RealDate(2027, 2, 29, 0, 1).getTime());
  check('Zeitumstellung 28.03.2027 (Tag mit 23 h): Rücksetzen um 00:00 Ortszeit am 28. und am 29., 2 Starts am 28.', W2.resets.map(hm).join() === '28.03. 00:00,29.03. 00:00' && a === 2 && W2.n() === 0, W2.resets.map(hm).join(', '));
}

// ================================================================ 3. Was gezählt wird
console.log('--- 3. Zählen: Verdichterstarts (0 → > 0 Hz), Abtauung, Neustart');
// Abtauung wie am 13.11. 02:56: 25 Hz, Abtauflag, 31, 0, 24, 40, 58, 58, 0, 0, 34, 24 Hz
function abtauung(W, t0) { [[0, 25, 0], [1, 31, 1], [2, 0, 1], [3, 24, 1], [4, 40, 1], [5, 58, 1], [7, 0, 1], [9, 34, 1], [10, 24, 0], [11, 25, 0]].forEach(e => { W.bis(t0 + e[0] * MIN); W.freq(e[1], e[2]); }); }
[[undefined, 'nicht gesetzt'], [0, '0'], [1, '1']].forEach(dbg => {
  const mk = F => { const W = Welt(F, T(11, 12, 12, 0), {debugging: dbg[0], file: {Starts_Today: 0, Starts_Today_Date: '2026-11-12', Starts_Today_Run: false}}); W.bis(T(11, 12, 20, 0)); W.freq(0); W.bis(T(11, 12, 21, 0)); W.freq(20); abtauung(W, T(11, 12, 22, 0)); return W; };
  const a = mk(FLOWS.alt).n(), r = mk(FLOWS.R).n(), nn = mk(FLOWS.N).n();
  if (dbg[0] === undefined) {
    check('1 Start + 1 Abtauung, Debugging ' + dbg[1] + ': heute und mit Patch R gleich (3 = Start + 2 Verdichterstarts in der Abtauung), N ebenso', a === 3 && r === 3 && nn === 3, 'heute ' + a + ', R ' + r + ', N ' + nn);
  } else {
    check('1 Start + 1 Abtauung, Debugging ' + dbg[1] + ' (Text wechselt im Abtauen auf „läuft ' + (dbg[0] ? '[Abtauen]' : '(übersprungen)') + '“): Patch R zählt wie heute (' + a + ', je Textwechsel einmal), N zählt die 3 echten Starts',
          r === a && a > 3 && nn === 3, 'heute ' + a + ', R ' + r + ', N ' + nn);
  }
});
{
  const ev = [[T(11, 12, 9, 0), 0], [T(11, 12, 10, 0), 20], [T(11, 12, 12, 0), 'neustart'], [T(11, 12, 12, 1), 20], [T(11, 12, 12, 5), 21]];
  const mk = F => { const W = Welt(F, T(11, 12, 8, 0), {file: {Starts_Today: 0, Starts_Today_Date: '2026-11-12', Starts_Today_Run: false}}); fahre(W, ev); return W.n(); };
  check('Neustart von Node-RED bei laufendem Verdichter: heute und mit R ein Phantom-Start (2 statt 1), mit N nicht (1)', mk(FLOWS.alt) === 2 && mk(FLOWS.R) === 2 && mk(FLOWS.N) === 1, 'heute ' + mk(FLOWS.alt) + ', R ' + mk(FLOWS.R) + ', N ' + mk(FLOWS.N));
  const W = Welt(FLOWS.N, T(11, 12, 8, 0), {file: {Starts_Today: 0, Starts_Today_Date: '2026-11-12'}}); fahre(W, [[T(11, 12, 9, 0), 20]]);
  check('N, erster Lauf nach dem Einspielen bei laufendem Verdichter (Zustand noch nicht gemerkt): zählt diese eine Meldung als Start (wie heute nach einem Neustart)', W.n() === 1 && W.file.Starts_Today_Run === true, String(W.n()));
}

// ================================================================ 4. Minutenprotokoll (optional)
if (dataDir) {
  console.log('--- 4. Minutenprotokoll durch beide Stände (' + dataDir + ')');
  const Z = [];
  fs.readdirSync(dataDir).filter(f => /^quiet-\d{4}-\d\d\.csv$/.test(f)).sort().forEach(f => {
    let H0 = null; fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n').forEach(l => { if (!l) { return; } const p = l.split(','); if (p[0] === 'zeit') { H0 = p; return; } if (!H0 || p.length !== H0.length) { return; }
      const g = k => { const i = H0.indexOf(k); return i < 0 || p[i] === '' ? null : Number(p[i]); };
      const t = new RealDate(p[0].replace(' ', 'T')).getTime(); if (isFinite(t) && g('verdichter_hz') !== null) { Z.push({t: t, hz: g('verdichter_hz'), df: g('defrost') ? 1 : 0, sh: g('starts_heute')}); } }); });
  const t0 = Z[0].t, tage = {};
  const echte = {}; Z.forEach((z, i) => { if (i > 0 && Z[i - 1].hz === 0 && z.hz > 0) { echte[ymd(z.t)] = (echte[ymd(z.t)] || 0) + 1; } });
  const lauf = (F, file) => { const W = Welt(F, t0 - MIN, {file: file}); const ende = {}; Z.forEach((z, i) => { if (i > 0 && ymd(z.t) !== ymd(Z[i - 1].t)) { W.bis(Z[i - 1].t + 1); ende[ymd(Z[i - 1].t)] = W.n(); } W.bis(z.t); W.freq(z.hz, z.df); }); return {W: W, ende: ende}; };
  const A = lauf(FLOWS.alt, {Starts_Today: 0}), R = lauf(FLOWS.R, {Starts_Today: 0, Starts_Today_Date: ymd(t0)});
  const dn = Object.keys(R.ende).sort().slice(1);                                    // erster (angebrochener) Tag außen vor
  const gleich = dn.filter(d => R.ende[d] === (echte[d] || 0)).length, gleichA = dn.filter(d => A.ende[d] === (echte[d] || 0)).length;
  console.log('     Tag: Verdichterstarts im Protokoll / Zähler um 24:00 heute (ohne Neustarts) / mit Patch');
  console.log('     ' + dn.map(d => d.slice(8) + '.' + d.slice(5, 7) + '.: ' + (echte[d] || 0) + '/' + A.ende[d] + '/' + R.ende[d]).join('  '));
  check('mit Patch steht um 24:00 an jedem der ' + dn.length + ' vollen Kalendertage genau die Zahl der Verdichterstarts des Tages; heute an ' + gleichA + ' Tagen (Rücksetzen zur Startzeit der Sim, ' + hm(t0 - MIN).slice(7) + ')',
        gleich === dn.length && gleichA < dn.length, gleich + ' von ' + dn.length);
  const nichtNull = R.W.resets.filter(t => { const d = new RealDate(t); return !(d.getHours() === 0 && d.getMinutes() === 0); });
  check('mit Patch wird nur um 00:00 zurückgesetzt (' + R.W.resets.length + ' Rücksetzungen, je Tageswechsel eine)', nichtNull.length === 0 && R.W.resets.length === dn.length + 1, nichtNull.map(hm).join(', '));
}

console.log('\nERGEBNIS starts_today_sim: ' + (n - fails) + ' OK, ' + fails + ' FAIL');
process.exit(fails ? 1 : 0);

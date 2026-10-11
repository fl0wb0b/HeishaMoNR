// Offline-Simulation (Fake-Uhr): Radiator bleibt an (Zwangs-AUS erst nach 6 h statt 20 min). Vergleicht die Live-Funktion mit der gepatchten; nichts wird gesendet.
// Aufruf:  node tools/radiator_dauer_an_sim.js live_flows.json
const vm = require('vm'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ALL = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const RAD = 'a0f2936bcfe99ce0', py = path.join(__dirname, 'radiator_dauer_an_patch.py');
const tmp = path.join(os.tmpdir(), 'rad_da_' + process.pid + '.json');
fs.writeFileSync(tmp, JSON.stringify(ALL));
const chk0 = cp.spawnSync('python3', [py, tmp, '--check']).status;
const ORIG = ALL.find(n => n.id === RAD).func;
cp.execFileSync('python3', [py, tmp]);
const PATCHED = JSON.parse(fs.readFileSync(tmp, 'utf8'));
const NEW = PATCHED.find(n => n.id === RAD).func;
const chk1 = cp.spawnSync('python3', [py, tmp, '--check']).status;
cp.execFileSync('python3', [py, tmp]);
const again = JSON.parse(fs.readFileSync(tmp, 'utf8')).find(n => n.id === RAD).func === NEW;
cp.execFileSync('python3', [py, tmp, '--revert']);
const rev = JSON.parse(fs.readFileSync(tmp, 'utf8'));
fs.unlinkSync(tmp);
let NOW = Date.UTC(2026, 9, 10, 4, 0, 0);
class FakeDate extends Date { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
let fails = 0;
const check = (n, c, i) => { console.log((c ? 'OK   ' : 'FAIL ') + n + (i !== undefined ? '  -> ' + i : '')); if (!c) { fails++; } };
const mkFlow = () => { const s = {}; return { s, get: k => s[k], set: (k, v) => { s[k] = v; } }; };
const comp = {};
function call(code, flow) {
  if (!comp[code]) { comp[code] = vm.runInNewContext('(function(msg,flow,node,Date){' + code + '\n})', {}); }
  const st = { text: '' }, node = { status: s => { st.text = s && s.text; }, warn: () => {}, error: () => {} };
  const r = comp[code]({ payload: 'tick', topic: 'tick' }, flow, node, FakeDate);
  return { out: r, status: st.text };
}
function setIn(f, o) {
  const put = (k, v) => { f.set(k, v); f.set(k + '_ts', NOW); };
  put('roomTemp', o.rt); put('outletTemp', o.ot); put('defrost', 0); put('hpPower', o.pwr); put('hpstate', 1); put('setpoint', 23); put('pumpFlow', o.pf === undefined ? 19.8 : o.pf);
}
check('Patch: wird angewendet, ist idempotent und der Revert stellt den Live-Stand wieder her; geaendert wird nur dieser Knoten und nur eine Zeile', chk0 === 1 && chk1 === 0 && again && JSON.stringify(rev) === JSON.stringify(ALL)
  && PATCHED.filter(n => JSON.stringify(n) !== JSON.stringify(ALL.find(a => a.id === n.id))).map(n => n.id).join() === RAD && NEW.split('\n').length === ORIG.split('\n').length && NEW.split('\n').filter((l, i) => l !== ORIG.split('\n')[i]).length === 1, '');
// Verlauf: Verdichter laeuft 3 h, Raum bleibt kalt (20,4 C), Vorlauf 29,5 C; alle 30 s ein Takt
function timeline(code, hours, rtFn) {
  const f = mkFlow(); NOW = Date.UTC(2026, 9, 10, 4, 0, 0); const t0 = NOW; let on = false; const ev = []; let onMin = 0, switches = 0;
  for (let s = 0; s <= hours * 3600; s += 30) {
    NOW = t0 + s * 1000; setIn(f, { rt: rtFn ? rtFn(s / 60) : 20.4, ot: 29.5, pwr: 300 }); f.set('radiator_actual', on);
    const r = call(code, f);
    if (r.out && r.out.payload && r.out.payload.params) { const n = r.out.payload.params.on; if (n !== on) { ev.push([Math.round(s / 60), n ? 'an' : 'aus']); switches++; } on = n; }
    if (on) { onMin += 0.5; }
  }
  return { ev, onMin, switches, on };
}
{
  const a = timeline(ORIG, 3), b = timeline(NEW, 3);
  check('Verlauf 3 h Lauf, Raum 20,4 °C (kalt): alt schaltet das Relais im 20/5-Takt (mehrere AUS-Zwangsschaltungen), neu bleibt es nach dem ersten EIN durchgehend an', a.ev.filter(e => e[1] === 'aus').length >= 6 && b.ev.length === 1 && b.ev[0][1] === 'an' && b.on === true, 'alt ' + a.ev.map(e => e.join(' ')).join(', ') + ' | neu ' + b.ev.map(e => e.join(' ')).join(', '));
  check('Einschaltzeit: alt etwa 75-80 % der 3 h, neu praktisch 100 %', a.onMin / 180 < 0.85 && b.onMin / 180 > 0.95, Math.round(a.onMin / 1.8) + ' % -> ' + Math.round(b.onMin / 1.8) + ' %');
}
{
  const b = timeline(NEW, 8);
  const offs = b.ev.filter(e => e[1] === 'aus');
  check('Notbremse bleibt: nach 6 h Dauer-EIN schaltet die Sicherung doch ab (dann 5 min Sperre bis zum naechsten EIN)', offs.length >= 1 && offs[0][0] >= 355 && offs[0][0] <= 366 && b.ev.some(e => e[1] === 'an' && e[0] > offs[0][0] && e[0] - offs[0][0] >= 4 && e[0] - offs[0][0] <= 7), b.ev.map(e => e.join(' ')).join(', '));
}
{
  // Raum wird warm: normales AUS bei >= 23,3 und Hysterese unveraendert
  const b = timeline(NEW, 4, m => (m < 60 ? 20.4 : (m < 120 ? 23.0 : 23.4)));
  check('Raum steigt auf 23,0 (Hysterese): Relais bleibt an; ab 23,4 (>= Soll + 0,3) geht es wie bisher AUS', b.ev[0][1] === 'an' && b.ev.some(e => e[1] === 'aus' && e[0] >= 120 && e[0] <= 122), b.ev.map(e => e.join(' ')).join(', '));
}
// Regression: alle Kombinationen, die nicht die 20-min-Sicherung betreffen, liefern dasselbe
let same = true, info = '', n = 0;
[20, 22.4, 22.7, 22.9, 23.0, 23.3, 23.6].forEach(rt => [20, 24.9, 25, 28, 33].forEach(ot => [34, 150, 292, 900].forEach(pwr => [undefined, true, false].forEach(cmd => [0, 5, 18].forEach(onMin => [0, 19.8].forEach(pf => {
  const mk = () => { const f = mkFlow(); NOW = Date.UTC(2026, 9, 10, 4, 0, 0); setIn(f, { rt, ot, pwr, pf }); if (cmd !== undefined) { f.set('radiator_cmd', cmd); f.set('radiator_cmd_ts', NOW - 3600e3); if (cmd) { f.set('radiator_on_since', NOW - onMin * 60e3); } } f.set('radiator_actual', cmd === true); return f; };
  const f1 = mk(), f2 = mk(), a = call(ORIG, f1), b = call(NEW, f2); n++;
  if (JSON.stringify(a.out) !== JSON.stringify(b.out) || a.status !== b.status || JSON.stringify(f1.s) !== JSON.stringify(f2.s)) { if (same) { info = JSON.stringify({ rt, ot, pwr, cmd, onMin, pf }) + ' ' + a.status + ' | ' + b.status; } same = false; }
}))))));
check('Regression: in ' + n + ' Eingabe-Kombinationen (Raum, Vorlauf, Leistung/Pause, bisheriger Befehl, bisherige EIN-Dauer bis 18 min, Durchfluss) ist die neue Funktion identisch zur bisherigen', same, info);
console.log(fails === 0 ? '\nERGEBNIS: alle Pruefungen bestanden' : '\nERGEBNIS: ' + fails + ' Pruefung(en) fehlgeschlagen');
process.exit(fails === 0 ? 0 : 1);

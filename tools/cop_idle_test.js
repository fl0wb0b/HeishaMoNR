// Pruefung der Korrektur "COP 0 bei Stillstand" (tools/cop_idle_fix.py): Betrieb unveraendert, Stillstand meldet 0.
// Usage: python3 tools/cop_idle_fix.py <kopie.json> && node tools/cop_idle_test.js <kopie.json>   (ohne Argument: die Repo-Flowdatei, vorher gepatcht)
const fs = require('fs'), vm = require('vm');
const file = process.argv[2] || 'flows (26.5.1 stable).json';
const flows = JSON.parse(fs.readFileSync(file, 'utf8')), node0 = flows.find(n => n.id === 'f4e55b938e645737');
const orig = fs.readFileSync(require('path').join(__dirname, 'fixtures', 'cop_calculated_original.js'), 'utf8');      // unveraenderte Originalfunktion (vor dem Patch), fest im Repo
const compile = f => vm.runInNewContext('(function(msg,global,node){' + f + '\n})', {Number, isFinite, parseFloat, isNaN});
const runF = (fn, st) => {
  const g = Object.assign({}, st), sends = [], sets = [];
  const gl = {get: k => g[k], set: (k, v) => { g[k] = v; sets.push([k, v]); }};
  const nd = {send: m => sends.push(JSON.stringify(m)), status: () => {}};
  const ret = fn({}, gl, nd);
  return {sends, sets, ret: String(JSON.stringify(ret))};
};
const base = {TOP6_Main_Outlet_Temp: 31, TOP5_Main_Inlet_Temp: 27, TOP1_Pump_Flow: 12, TOP20_ThreeWay_Valve_State: 0};
const fOld = compile(orig), fNew = compile(node0.func);
let fails = 0; const ck = (n, ok, d) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (d ? '  -> ' + d : '')); if (!ok) fails++; };
let same = 0, total = 0, diffs = [];
[0, 1].forEach(valve => [16, 30].forEach(hz => [15, 260, 600].forEach(en => [0, 1, 5, 40, undefined].forEach(rt => {
  const st = Object.assign({}, base, {TOP20_ThreeWay_Valve_State: valve, compressor_frequency: hz, TOP16_Heat_Energy_Consumption: en, TOP41_DHW_Energy_Consumption: en, compressor_runtime: rt});
  const a = runF(fOld, st), b = runF(fNew, st); total++;
  if (JSON.stringify(a) === JSON.stringify(b)) { same++; } else { diffs.push(JSON.stringify({valve, hz, en, rt})); }
}))));
ck('Betrieb (Verdichter laeuft, 60 Zustaende: Ventil Heizen/Warmwasser, 16/30 Hz, 15/260/600 W, Laufzeit 0/1/5/40/unbekannt): Ausgaben und Variablen identisch zum Original', same === total, same + ' von ' + total + (diffs.length ? ' | abweichend: ' + diffs.slice(0, 3).join(' ') : ''));
// Stillstand mit Bereitschaftsleistung (live: 15 W, 0 Hz, Laufzeit 0, Restwaerme dT 2 K, Durchfluss 13 l/min)
const idleSt = Object.assign({}, base, {compressor_frequency: 0, TOP16_Heat_Energy_Consumption: 15, compressor_runtime: 0, COP_HEAT: 6.71, TOP6_Main_Outlet_Temp: 23.25, TOP5_Main_Inlet_Temp: 21.2, TOP1_Pump_Flow: 13.4});
const oi = runF(fOld, idleSt), ni = runF(fNew, idleSt);
ck('Original im Stillstand (15 W, 0 Hz): meldet KEIN COP_HEAT=0 und laesst COP_HEAT=6,71 stehen (der beobachtete Fehler)', !oi.sends.some(s => s.includes('COP_HEAT')) && !oi.sets.some(s => s[0] === 'COP_HEAT'), JSON.stringify(oi.sends));
ck('Korrigiert im Stillstand: COP_HEAT = 0 auf dem Linien-Ausgang (Anzeige, Diagramm, panasonic/cop) und Variable COP_HEAT = 0', ni.sends.some(s => s.includes('"topic":"COP_HEAT"') && s.includes('"payload":0')) && ni.sets.some(s => s[0] === 'COP_HEAT' && s[1] === 0), JSON.stringify(ni.sends));
ck('Korrigiert im Stillstand: nie ein COP aus Restwaerme (kein Wert auf den COP-Ausgaengen 1/2, keine Waermemenge), nur die Nullmeldung', ni.ret === 'null' || ni.ret === 'undefined', ni.ret);
// auch wenn die Laufzeit noch >= 2 ist (Moment des Abschaltens), darf kein COP aus Restwaerme entstehen
const stopSt = Object.assign({}, idleSt, {compressor_runtime: 41});
const ns = runF(fNew, stopSt), os = runF(fOld, stopSt);
ck('Abschaltmoment (Laufzeit noch 41 min, 0 Hz, 15 W): Original rechnete einen falschen COP aus Restwaerme, korrigiert nicht', os.ret.includes('COP_HEAT') && !ns.ret.includes('"topic":"COP_HEAT"') && ns.sends.some(s => s.includes('"payload":0')), 'Original: ' + os.ret.slice(0, 60) + ' | neu: ' + ns.ret);
// 0 W wie im Original-Verhalten bleibt gleich
const zeroSt = Object.assign({}, idleSt, {TOP16_Heat_Energy_Consumption: 0});
ck('Verbrauch exakt 0 W (Original-Fall): Verhalten wie bisher, zusaetzlich Variable 0', runF(fOld, zeroSt).sends.join() === runF(fNew, zeroSt).sends.join(), '');
// ohne Frequenzwert (Variable fehlt): wie vorher
const noHz = Object.assign({}, base, {TOP16_Heat_Energy_Consumption: 260, compressor_runtime: 40}); delete noHz.compressor_frequency;
ck('Frequenzwert fehlt: kein Stillstand angenommen, Verhalten wie im Original', JSON.stringify(runF(fOld, noHz)) === JSON.stringify(runF(fNew, noHz)), '');
ck('Patch ist in der Flowdatei markiert und idempotent', node0.func.includes('// COP-idle:') && node0.func.split('// COP-idle:').length === 2, '');
// Textanzeige
const disp = flows.find(n => n.id === 'a1c0b0000c0f0010'), fd = vm.runInNewContext('(function(msg){' + disp.func + '\n})', {Number});
ck('Textanzeige: Stillstand (0) zeigt "0", Betrieb zeigt den COP mit einer Nachkommastelle (6,71 -> 6.7), ungueltig zeigt 0', fd({payload: 0}).payload === '0' && fd({payload: 6.71}).payload === '6.7' && fd({payload: 'x'}).payload === '0', '');
process.exit(fails ? 1 : 0);

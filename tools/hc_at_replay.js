// Replay der Automatik "Heizregelung nach Aussentemperatur" (Knoten hc_at) mit echten Minutenwerten und Fake-Uhr (14.11.2026, V1).
// Liest den Code von hc_at aus einer Flow-Datei und spielt das Minutenprotokoll (quiet-JJJJ-MM.csv: zeit, quiet_aktuell, aussen, defrost) Minute fuer Minute durch.
// Rueckmeldung wie auf der Anlage: angeforderte Heizregelung und gesendete Quiet-Stufe gelten ab der naechsten Minute als gemeldet; Quiet-Wechsel von aussen
// (Hand, Klick) uebernimmt das Replay aus dem Protokoll (Spalte quiet_aktuell), solange die Automatik nichts gesendet hat.
// Ausgabe: jede Aktion der Automatik und je Tag die Minuten Comfort mit Quiet 3 (das, was V1 abstellen soll).
// Usage: node tools/hc_at_replay.js <flows.json> <quiet-JJJJ-MM.csv> [von "JJJJ-MM-TT HH:MM"] [bis] [hc0 0|1] [q0]
'use strict';
const fs = require('fs'), vm = require('vm');
const [flowsPfad, csvPfad, von = '0000', bis = '9999', hc0 = '1', q0 = '0'] = process.argv.slice(2);
if (!flowsPfad || !csvPfad) { console.error('Usage: node tools/hc_at_replay.js <flows.json> <quiet-JJJJ-MM.csv> [von] [bis] [hc0] [q0]'); process.exit(2); }
const flows = JSON.parse(fs.readFileSync(flowsPfad, 'utf8')), fl = Array.isArray(flows) ? flows : flows.flows;
const node = fl.find(n => n.id === 'hc_at'); if (!node) { console.error('Knoten hc_at fehlt'); process.exit(2); }
let NOW = 0;
class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
const fn = vm.runInNewContext('(function(msg,global,flow,context,node,Date){' + node.func + '\n})', {Number, isFinite, String, JSON, Math});
const G = {}, C = {};
const st = o => ({get: (k) => o[k], set: (k, v) => { o[k] = v; }});
const zeilen = fs.readFileSync(csvPfad, 'utf8').trim().split('\n'), kopf = zeilen[0].split(',');
const iz = kopf.indexOf('zeit'), iq = kopf.indexOf('quiet_aktuell'), ia = kopf.indexOf('aussen'), idf = kopf.indexOf('defrost');
G.HEATING_CONTROL = Number(hc0); G.TOP18_Quiet_Mode_Level = Number(q0); G.HC_AT = {on: true}; G.MQTT = {block_active: 0, messages_today: 0, message_limit: 500};
let qExtern = Number(q0), selbstQ = null, tag = null; const tage = {}, aktionen = [];
for (const z of zeilen.slice(1)) {
  const f = z.split(','), t = f[iz].slice(0, 16); if (t < von || t > bis) { continue; }
  NOW = new Date(t.replace(' ', 'T') + ':00').getTime();
  const q = Number(f[iq]);
  if (isFinite(q) && q !== qExtern) { qExtern = q; if (selbstQ === null) { G.TOP18_Quiet_Mode_Level = q; } }   // Wechsel von aussen (Hand, Klick) uebernehmen
  G.TOP14_Outside_Temp = f[ia] === '' ? undefined : Number(f[ia]); G.TOP26_Defrosting_State = Number(f[idf]) === 1 ? 1 : 0;
  const r = fn({topic: 'tick', payload: NOW}, st(G), st({}), st(C), {}, FakeDate) || [];
  if (r[0]) { G.HEATING_CONTROL = Number(r[0].payload); }
  if (r[1]) { G.TOP18_Quiet_Mode_Level = Number(r[1].payload); selbstQ = G.TOP18_Quiet_Mode_Level; }
  if (selbstQ !== null && qExtern !== selbstQ && q === selbstQ) { selbstQ = null; }                     // Protokoll zeigt den gesendeten Stand: wieder von aussen fuehren
  if (r[2]) { aktionen.push(t + '  ' + r[2].payload + (r[1] ? '  [SetQuietMode ' + r[1].payload + ']' : '')); }
  const d = t.slice(0, 10); tage[d] = tage[d] || {min: 0, cq3: 0, cq0: 0};
  tage[d].min++; if (G.HEATING_CONTROL === 0 && G.TOP18_Quiet_Mode_Level === 3) { tage[d].cq3++; } if (G.HEATING_CONTROL === 0 && G.TOP18_Quiet_Mode_Level === 0) { tage[d].cq0++; }
}
console.log('Aktionen der Automatik:'); aktionen.forEach(a => console.log('  ' + a));
console.log('Minuten je Tag (Comfort + Quiet 3 / Comfort + Quiet 0 / Minuten):');
Object.keys(tage).sort().forEach(d => console.log('  ' + d + '  ' + tage[d].cq3 + ' / ' + tage[d].cq0 + ' / ' + tage[d].min));

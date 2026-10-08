// Pruefung des Schalters "Heizregelung" (tools/heating_control_switch.py): alle Faelle der Funktionen "Heizregelung Befehl" und "Heizregelung Zustand".
// Usage: python3 tools/heating_control_switch.py <kopie.json> && node tools/heating_control_test.js <kopie.json>
const fs = require('fs'), vm = require('vm');
const file = process.argv[2] || 'flows (26.5.1 stable).json';
const flows = JSON.parse(fs.readFileSync(file, 'utf8')), by = Object.fromEntries(flows.map(n => [n.id, n]));
const REAL = Date;
let NOW = Date.UTC(2026, 9, 8, 8, 0, 0);
class FakeDate extends REAL { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
const mk = id => vm.runInNewContext('(function(msg,global,flow,node,Date){' + by[id].func + '\n})', {Number, isFinite, String});
const fCmd = mk('hc_cmd'), fState = mk('hc_state');
let g, fl;
const reset = (over) => { g = Object.assign({MQTT: {block_active: 0, block_mode: 3, messages_today: 3, message_limit: 500}, TOP14_Outside_Temp: 10, compressor_frequency: 0, TOP26_Defrosting_State: 0}, over || {}); fl = {}; NOW = Date.UTC(2026, 9, 8, 8, 0, 0); };
const ctx = o => ({get: k => o[k], set: (k, v) => { o[k] = v; }});
const cmd = payload => fCmd({payload}, ctx(g), ctx(fl), {}, FakeDate);
const state = (payload, topic) => fState({payload, topic: topic || 'panasonic_heat_pump/main/Heating_Control'}, ctx(g), ctx(fl), {}, FakeDate);
let fails = 0; const ck = (n, ok, d) => { console.log((ok ? 'OK  ' : 'FAIL') + ' ' + n + (d ? '  -> ' + d : '')); if (!ok) fails++; };
const sent = r => r && r[0], toastOf = r => r && r[1], backOf = r => r && r[2];

// ---------- Ablehnungen: nichts wird gesendet
reset(); let r = cmd('1');
ck('Stand der Waermepumpe unbekannt (keine Meldung von HeishaMon): nichts gesendet, Meldung rot', sent(r) === null && toastOf(r).highlight === 'red' && /unbekannt/.test(toastOf(r).payload), toastOf(r) && toastOf(r).payload);
reset({HEATING_CONTROL: 0}); r = cmd('0');
ck('Auswahl entspricht schon dem Stand: nichts gesendet, keine Meldung', sent(r) === null && toastOf(r) === null, '');
reset({HEATING_CONTROL: 0, MQTT: {block_active: 1, block_mode: 1, messages_today: 0, message_limit: 500}}); r = cmd('1');
ck('MQTT-Befehle gesperrt: nichts gesendet, Auswahl springt auf den echten Stand zurueck', sent(r) === null && /gesperrt/.test(toastOf(r).payload) && backOf(r).payload === '0', toastOf(r).payload);
reset({HEATING_CONTROL: 0, MQTT: {block_active: 0, block_mode: 3, messages_today: 500, message_limit: 500}}); r = cmd('1');
ck('Tagesbudget aufgebraucht (500 von 500): nichts gesendet', sent(r) === null && /Tagesbudget/.test(toastOf(r).payload) && backOf(r).payload === '0', toastOf(r).payload);
reset({HEATING_CONTROL: 0}); r = cmd('1'); const r2 = cmd('0');
ck('Zweiter Klick waehrend der erste Befehl noch laeuft: nichts gesendet', sent(r) !== null && sent(r2) === null && /läuft noch/.test(toastOf(r2).payload), toastOf(r2).payload);
reset({HEATING_CONTROL: 0}); cmd('1'); state(1); NOW += 2 * 60000; r = cmd('0');
ck('Wechsel nach nur 2 min (Schonfrist 5 min): nichts gesendet, Hinweis nennt die Restzeit', sent(r) === null && /frühestens in 3 min/.test(toastOf(r).payload) && backOf(r).payload === '1', toastOf(r).payload);
NOW += 4 * 60000; r = cmd('0');
ck('Nach 6 min ist der Wechsel wieder moeglich', sent(r) !== null && sent(r).payload === '0', '');

// ---------- Senden: genau ein Befehl auf dem gemeinsamen Weg
reset({HEATING_CONTROL: 0, TOP14_Outside_Temp: 12}); r = cmd('1');
ck('Comfort -> Efficiency bei 12 °C: genau ein Befehl SetHeatingControl = "1" mit Quelle, ohne Warnhinweis', sent(r) && sent(r).topic === 'panasonic_heat_pump/commands/SetHeatingControl' && sent(r).payload === '1' && sent(r).source === 'Heizregelung-Schalter' && !/Hinweis/.test(toastOf(r).payload) && toastOf(r).highlight === '', JSON.stringify(sent(r)));
reset({HEATING_CONTROL: 1}); r = cmd('0');
ck('Efficiency -> Comfort: Befehl "0" ohne Warnhinweise (Comfort ist immer sicher)', sent(r).payload === '0' && !/Hinweis/.test(toastOf(r).payload), toastOf(r).payload);
reset({HEATING_CONTROL: 0, TOP14_Outside_Temp: 2, TOP26_Defrosting_State: 1, compressor_frequency: 30, TOP42_Z1_Water_Target_Temp: 33, TOP6_Main_Outlet_Temp: 30, OPT_state: {ts: NOW, deficit: true, deficitRoom: 'Kinderzimmer unten'}}); r = cmd('1');
ck('Efficiency bei 2 °C, Abtauen, Raum unter Minimum, Vorlauf 3 K unter Soll: Befehl wird trotzdem gesendet (Entscheidung beim Betreiber), alle vier Hinweise stehen in der Meldung', sent(r) !== null && toastOf(r).highlight === 'orange' && /2,0 °C/.test(toastOf(r).payload) && /Abtauen läuft/.test(toastOf(r).payload) && /Raum unter Minimum: Kinderzimmer unten/.test(toastOf(r).payload) && /3,0 K unter Soll/.test(toastOf(r).payload), toastOf(r).payload);
ck('Kein Befehl ohne Auswahl: ungueltige oder leere Werte werden ignoriert', (() => { reset({HEATING_CONTROL: 0}); return cmd('') [0] === null && cmd('abc')[0] === null && cmd(undefined)[0] === null; })(), '');
ck('Der Befehl nimmt den gemeinsamen Weg: link out auf "> MQTT OUT" (WP Managers), das Link-In kennt den neuen Absender; kein eigener mqtt out', by.hc_out.links.join() === '8b3d729fe630c248' && by['8b3d729fe630c248'].links.includes('hc_out') && !flows.some(n => ['hc_sel', 'hc_cmd', 'hc_state', 'hc_in', 'hc_tick', 'hc_txt', 'hc_toast'].includes(n.id) && n.type === 'mqtt out'), '');

// ---------- Zustand und Bestaetigung
reset(); r = state('0');
ck('Erste Meldung (Comfort): Auswahl und Textzeile zeigen den Stand, Variable gesetzt, keine Meldung', r[0].payload === '0' && /^Comfort · gemeldet \d\d:\d\d$/.test(r[1].payload) && r[2] === null && g.HEATING_CONTROL === 0, JSON.stringify(r[1]));
reset({HEATING_CONTROL: 0}); cmd('1'); r = state('0');
ck('Waehrend ein Befehl laeuft und noch der alte Stand gemeldet wird: Auswahl springt nicht zurueck, keine Meldung', r[0] === null && r[2] === null, '');
NOW += 20000; r = state('1');
ck('Wärmepumpe meldet Efficiency: Befehl bestaetigt (gruene Meldung), Ausstehendes geloescht, Auswahl und Text zeigen Efficiency', r[2] && r[2].highlight === 'green' && /Efficiency \(von der Wärmepumpe bestätigt\)/.test(r[2].payload) && r[0].payload === '1' && fl.hcPending === null && /^Efficiency/.test(r[1].payload), r[2] && r[2].payload);
reset({HEATING_CONTROL: 0}); cmd('1'); NOW += 95000; r = fState({payload: '', topic: 'tick'}, ctx(g), ctx(fl), {}, FakeDate);
ck('Keine Bestaetigung nach 90 s: rote Meldung, Auswahl zurueck auf den echten Stand (Comfort), nichts weiter gesendet', r[2].highlight === 'red' && /Keine Bestätigung/.test(r[2].payload) && r[0].payload === '0' && fl.hcPending === null, r[2].payload);
reset({HEATING_CONTROL: 0}); cmd('1'); NOW += 30000; r = fState({payload: '', topic: 'tick'}, ctx(g), ctx(fl), {}, FakeDate);
ck('Nach 30 s noch kein Alarm (Schwelle 90 s)', r[2] === null && fl.hcPending !== null, '');
reset({HEATING_CONTROL: 0}); r = state('1');
ck('Aenderung von aussen (HeishaMon-Seite, Regler) ohne eigenen Befehl: orange Meldung, Auswahl folgt', r[2].highlight === 'orange' && /von außen auf Efficiency/.test(r[2].payload) && r[0].payload === '1', r[2].payload);
reset({HEATING_CONTROL: 1}); r = state('1');
ck('Wiederholte Meldung desselben Stands (HeishaMon sendet regelmaessig): keine Meldung, kein Befehl', r[2] === null && r[0].payload === '1', '');
reset(); r = state('99');
ck('Ungueltiger Statuswert wird ignoriert', r[0] === null && r[1] === null && r[2] === null && g.HEATING_CONTROL === undefined, '');
ck('Zustandsfunktion sendet nie einen Befehl (kein Ausgang zu link out/mqtt out)', by.hc_state.wires.flat().every(i => ['hc_sel', 'hc_txt', 'hc_toast'].includes(i)) && by.hc_cmd.wires.flat().every(i => ['hc_out', 'hc_toast', 'hc_sel'].includes(i)), '');
ck('Oberflaeche: Auswahl Comfort/Efficiency (Werte 0/1, kein Durchreichen), Gruppe HEIZREGELUNG auf der Seite Uebersicht zwischen WAERMEPUMPE und HEIZEN', by.hc_sel.options.map(o => o.value).join() === '0,1' && by.hc_sel.passthru === false && by.hc_grp.tab === 'a5be8588.b8fbc8' && by.hc_grp.order === 2, '');
process.exit(fails ? 1 : 0);

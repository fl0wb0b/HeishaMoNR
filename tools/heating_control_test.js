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
// ---------- Empfehlung des Optimizers (nur Anzeige)
const tick = () => fState({payload: '', topic: 'tick'}, ctx(g), ctx(fl), {}, FakeDate);
reset({HEATING_CONTROL: 1}); r = tick();
ck('Ohne frische Empfehlung des Optimizers zeigt die Zeile "Empfehlung" einen Strich', r[3] && r[3].payload === '–' && r[2] === null, JSON.stringify(r[3]));
g.OPT_hc_reco = {ts: NOW, mode: 1, warn: false, text: 'Efficiency · keine Warnung'}; r = tick();
ck('Frische Empfehlung ohne Warnung: Text wird angezeigt, keine Meldung', r[3].payload === 'Efficiency · keine Warnung' && r[2] === null, '');
r = tick();
ck('Unveraenderter Text wird nicht erneut an die Oberflaeche gesendet', r[3] === null, '');
NOW += 15000; g.OPT_hc_reco = {ts: NOW, mode: 1, warn: true, text: 'Efficiency · Comfort empfohlen: Außentemperatur 3,2 °C'}; r = tick();
ck('Neue Warnung: Text aktualisiert und einmal eine orange Meldung ("Es wird nichts automatisch umgeschaltet")', r[3].payload.includes('Comfort empfohlen') && r[2] && r[2].highlight === 'orange' && /nichts automatisch umgeschaltet/.test(r[2].payload), r[2] && r[2].payload);
NOW += 15000; g.OPT_hc_reco = {ts: NOW, mode: 1, warn: true, text: 'Efficiency · Comfort empfohlen: Außentemperatur 3,1 °C'}; r = tick();
ck('Dieselbe Warnung (Text aendert sich nur leicht): keine zweite Meldung', r[2] === null, '');
NOW += 15000; g.OPT_hc_reco = {ts: NOW, mode: 1, warn: false, text: 'Efficiency · keine Warnung'}; tick(); NOW += 15000; g.OPT_hc_reco = {ts: NOW, mode: 1, warn: true, text: 'Efficiency · Comfort empfohlen: Abtauen vor 1,0 h'}; r = tick();
ck('Neue Warnung innerhalb von 60 min nach der letzten Meldung: Text aktualisiert, aber keine zweite Meldung (kein Dauerfeuer)', r[3] !== null && r[2] === null, '');
NOW += 61 * 60000; g.OPT_hc_reco = {ts: NOW, mode: 1, warn: false, text: 'Efficiency · keine Warnung'}; tick(); NOW += 15000; g.OPT_hc_reco = {ts: NOW, mode: 1, warn: true, text: 'Efficiency · Comfort empfohlen: Raum unter Minimum: X'}; r = tick();
ck('Nach mehr als 60 min darf eine neue Warnung wieder melden', r[2] && r[2].highlight === 'orange', '');
NOW += 6 * 60000; r = tick();
ck('Veraltete Empfehlung (Optimizer liefert nichts mehr): Anzeige faellt auf Strich zurueck', r[3] && r[3].payload === '–', JSON.stringify(r[3]));
ck('Empfehlung ist nur Anzeige: Zustandsfunktion hat keinen Ausgang zu link out/mqtt out, nur Auswahl/Text/Meldung/Empfehlungstext', by.hc_state.wires.flat().every(i => ['hc_sel', 'hc_txt', 'hc_toast', 'hc_reco_txt'].includes(i)) && by.hc_reco_txt.group === 'hc_grp' && by.hc_cmd.wires.flat().every(i => ['hc_out', 'hc_toast', 'hc_sel', 'hc_log'].includes(i)), '');
ck('Oberflaeche: Auswahl Comfort/Efficiency (Werte 0/1, kein Durchreichen), Gruppe HEIZREGELUNG auf der Seite Uebersicht zwischen WAERMEPUMPE und HEIZEN', by.hc_sel.options.map(o => o.value).join() === '0,1' && by.hc_sel.passthru === false && by.hc_grp.tab === 'a5be8588.b8fbc8' && by.hc_grp.order === 2, '');
// ---------- Zeitplan (07.11.2026): Aktion "Heizregelung - Comfort/Efficiency" geht ueber denselben Befehl wie der Handschalter
const SCHED = 'e168945122de5aa2', LOG_IN = '031e62b0bf3df7d7', SCHED_TAB = '35d210f042827344', WP_DASH = '8c9d42231fd19d3c';
const fSched = mk(SCHED);
const sched = (action, over, when) => {
    const gg = Object.assign({Schedule_3_state: 1, Schedule_3_day: ['Saturday'], Schedule_3_hour: '6', Schedule_3_minutes: '30', Schedule_3_action: action, TOP0_Heatpump_State: 1}, over || {}), sends = [];
    const res = fSched({topic: 'Schedule_3', payload: when || ['Saturday', '6', '30']}, ctx(gg), ctx({}), {send: m => sends.push(m)}, FakeDate);
    return {res: res || [], sends, gg};
};
const planCmd = (payload, topic) => fCmd({payload, source: 'Zeitplan', topic: topic || 'Scheduler (#3)'}, ctx(g), ctx(fl), {}, FakeDate);
let s = sched('HC_0');
ck('Zeitplan-Zeile mit "Heizregelung - Comfort" zur eingestellten Zeit: genau eine Nachricht an den Schalter (Ausgang 10, Wert "0", Quelle Zeitplan), Protokollzeile, letzter Lauf gemerkt, sonst nichts',
   s.res.length === 10 && s.res.slice(0, 8).every(m => m === null) && s.res[9].payload === '0' && s.res[9].source === 'Zeitplan' && s.res[9].topic === 'Scheduler (#3)' && /Heizregelung Comfort angefordert/.test(s.res[8].payload) && s.res[8].topic === 'Scheduler (#3)' && s.gg.Schedule_3_last_run === NOW && s.sends.length === 0, JSON.stringify(s.res));
s = sched('HC_1');
ck('"Heizregelung - Efficiency": Wert "1"', s.res[9] && s.res[9].payload === '1' && /Efficiency angefordert/.test(s.res[8].payload), JSON.stringify(s.res[9]));
s = sched('HC_0', {Schedule_3_state: 0});
ck('Zeile ausgeschaltet: nichts', s.res.length === 0 && s.sends.length === 0, '');
s = sched('HC_0', {}, ['Saturday', '6', '31']);
ck('Andere Minute: nichts', s.res.length === 0, '');
reset({HEATING_CONTROL: 1, TOP14_Outside_Temp: 12}); s = sched('HC_0'); r = fCmd(s.res[9], ctx(g), ctx(fl), {}, FakeDate);
ck('Kette Zeitplan -> Schalter: SetHeatingControl "0" auf dem gemeinsamen Weg, Quelle "Zeitplan", Meldung nennt die Zeile, Protokoll "gesendet"',
   sent(r) && sent(r).topic === 'panasonic_heat_pump/commands/SetHeatingControl' && sent(r).payload === '0' && sent(r).source === 'Zeitplan' && /^Scheduler \(#3\): Heizregelung → Comfort gesendet/.test(toastOf(r).payload) && r[3] && r[3].topic === 'Scheduler (#3)' && /Heizregelung Comfort gesendet/.test(r[3].payload), JSON.stringify(r));
reset({HEATING_CONTROL: 0}); r = planCmd('0');
ck('Zeitplan, Stand ist schon Comfort: nichts gesendet, keine Meldung, Protokoll sagt warum', sent(r) === null && toastOf(r) === null && /steht schon auf Comfort, nichts gesendet/.test(r[3].payload), r[3] && r[3].payload);
reset({HEATING_CONTROL: 0, MQTT: {block_active: 1, block_mode: 2, allow_scheduler: 1, messages_today: 0, message_limit: 500}}); r = planCmd('1');
ck('Zeitplan bei MQTT-Sperre: nichts gesendet (wie von Hand, der gemeinsame Weg sperrt ohnehin alles), Protokoll nennt die Sperre', sent(r) === null && /gesperrt/.test(r[3].payload) && /Nichts gesendet/.test(r[3].payload), r[3] && r[3].payload);
reset(); r = planCmd('1');
ck('Zeitplan bei unbekanntem Stand: nichts gesendet, Protokoll nennt den Grund', sent(r) === null && /unbekannt/.test(r[3].payload), r[3] && r[3].payload);
reset({HEATING_CONTROL: 0}); cmd('1'); state(1); NOW += 2 * 60000; r = planCmd('0');
ck('Zeitplan 2 min nach einem Wechsel von Hand: Schonfrist gilt auch hier, Protokoll nennt die Restzeit', sent(r) === null && /frühestens in 3 min/.test(r[3].payload), r[3] && r[3].payload);
reset({HEATING_CONTROL: 0, TOP14_Outside_Temp: 2}); r = planCmd('1');
ck('Zeitplan Efficiency bei 2 °C: wird gesendet, Hinweis steht auch im Protokoll', sent(r) && /gesendet/.test(r[3].payload) && /2,0 °C/.test(r[3].payload), r[3] && r[3].payload);
reset({HEATING_CONTROL: 0}); r = cmd('1');
ck('Von Hand (ohne Quelle Zeitplan): kein Protokolleintrag, Quelle bleibt "Heizregelung-Schalter", Meldung ohne Zeilen-Vorsatz', r[3] === null && sent(r).source === 'Heizregelung-Schalter' && /^Heizregelung → Efficiency/.test(toastOf(r).payload), JSON.stringify(r[3]));
const fs9 = by[SCHED];
ck('Verdrahtung: "Function schedule" hat 10 Ausgaenge, der neue geht per Link nach WP Dash in "Heizregelung Befehl"; das Ergebnis geht per Link ins Protokoll ("Input LOGS"); kein eigener mqtt out',
   fs9.outputs === 10 && fs9.wires.length === 10 && fs9.wires[9].join() === 'hc_sched_out' && /Heizregelung/.test(fs9.outputLabels[9]) && by.hc_sched_out.type === 'link out' && by.hc_sched_out.z === SCHED_TAB && by.hc_sched_out.links.join() === 'hc_sched_in'
   && by.hc_sched_in.type === 'link in' && by.hc_sched_in.z === WP_DASH && by.hc_sched_in.links.includes('hc_sched_out') && by.hc_sched_in.wires.join() === 'hc_cmd'
   && by.hc_cmd.outputs === 4 && by.hc_cmd.wires[3].join() === 'hc_log' && by.hc_log.links.join() === LOG_IN && by[LOG_IN].links.includes('hc_log')
   && !flows.some(n => ['hc_sched_in', 'hc_sched_out', 'hc_log'].includes(n.id) && n.type === 'mqtt out'), '');
const acts = flows.filter(n => n.type === 'ui_dropdown' && /^Action\d+$/.test(n.name || ''));
const DROP = ['DHW', 'Sterilization', 'OperationMode1', 'OperationMode2', 'OperationMode3', 'OperationMode4', 'OperationMode5', 'OperationMode6', 'DHW setpoint'];
const sep = o => /^-+$/.test(o.label);
const optOk = n => { const v = n.options.map(o => o.value), i = v.indexOf('QM_3');
    return v[i + 1] === 'hc_sep' && sep(n.options[i + 1]) && v[i + 2] === 'HC_0' && n.options[i + 2].label === 'Heizregelung - Comfort' && v[i + 3] === 'HC_1' && n.options[i + 3].label === 'Heizregelung - Efficiency'
        && !v.some(x => DROP.includes(x)) && new Set(v).size === v.length && !n.options.some((o, k) => k > 0 && sep(o) && sep(n.options[k - 1])) && !sep(n.options[n.options.length - 1])
        && ['HP_turn_on', 'QM_0', 'OperationMode0', 'NightReductionWaterTempOn', 'Room setpoint RTC', 'toggle item'].every(x => v.includes(x)); };
ck('Alle 10 Aktion-Auswahlen: "Heizregelung - Comfort/Efficiency" nach Leisemodus 3 (eigener Trenner), ohne Warmwasser, Desinfektion, Kuehlen, Auto und Warmwasser-Sollwert (Anlage ohne beides), keine doppelten Trenner',
   acts.length === 10 && acts.every(optOk), acts.filter(n => !optOk(n)).map(n => n.name).join());

// ---------- Heizregelung nach Aussentemperatur (07.11.2026, Kevin): <= 2 °C Comfort, >= 4 °C Efficiency + Quiet 3, nur beim Wechsel, 30 min stabil
const fAt = vm.runInNewContext('(function(msg,global,flow,context,node,Date){' + by.hc_at.func + '\n})', {Number, isFinite, String});
let cx;
const atReset = (over) => { reset(Object.assign({TOP14_Outside_Temp: 5, TOP18_Quiet_Mode_Level: 0, HEATING_CONTROL: 0}, over || {})); cx = {}; };
const at = (topic, payload) => fAt({topic: topic || 'tick', payload}, ctx(g), ctx(fl), ctx(cx), {}, FakeDate);
const run = (min, t, best) => { const o = []; for (let i = 0; i < min; i++) { g.TOP14_Outside_Temp = t; NOW += 60000; const r0 = at() || []; o.push(r0);
    if (best !== false) { if (r0[0]) { g.HEATING_CONTROL = Number(r0[0].payload); } if (r0[1]) { g.TOP18_Quiet_Mode_Level = 3; } } } return o; };   // best: HeishaMon meldet den neuen Stand
const out = (o, k) => o.map(r => r[k]).filter(Boolean);
const QTOPIC = 'panasonic_heat_pump/commands/SetQuietMode';
atReset(); let o = run(120, 1);
ck('Automatik aus (Standard): 2 h bei 1 °C, nichts angefordert, kein Quiet', out(o, 0).length === 0 && out(o, 1).length === 0, '');
let rs = at('schalter', true);
ck('Einschalten: gemerkt (global HC_AT, Speicher file), Protokoll "eingeschaltet"', g.HC_AT && g.HC_AT.on === true && /eingeschaltet/.test(rs[2].payload), JSON.stringify(rs));
o = run(30, 1);
ck('1 °C in 30 Takten (29 min seit der ersten Messung): noch nichts', out(o, 0).length === 0, '');
o = run(1, 1);
ck('1 °C seit 30 min: genau eine Anforderung Comfort an "Heizregelung Befehl" (Wert "0", Quelle Aussentemperatur), kein Quiet, Protokollzeile',
   out(o, 0).length === 1 && out(o, 0)[0].payload === '0' && out(o, 0)[0].source === 'Außentemperatur' && out(o, 1).length === 0 && /1 °C seit 30 min: Comfort/.test(out(o, 2)[0].payload), JSON.stringify(o));
o = run(180, 1);
ck('Bleibt es kalt: keine weitere Anforderung (nur beim Wechsel)', out(o, 0).length === 0 && out(o, 1).length === 0, '');
o = run(300, 3);
ck('3 °C (Hysterese) fuer 5 h: nichts', out(o, 0).length === 0 && out(o, 1).length === 0, '');
o = run(30, 4);
ck('4 °C in 30 Takten: noch nichts', out(o, 0).length === 0, '');
o = run(1, 4);
ck('4 °C seit 30 min: Efficiency ("1") an den Schalter und Quiet 3 auf dem gemeinsamen Weg (SetQuietMode "3"), Protokoll nennt beides',
   out(o, 0).length === 1 && out(o, 0)[0].payload === '1' && out(o, 1).length === 1 && out(o, 1)[0].topic === QTOPIC && out(o, 1)[0].payload === '3' && /Efficiency/.test(out(o, 2)[0].payload) && /Quiet 3 gesendet/.test(out(o, 2)[0].payload), JSON.stringify(o));
o = run(20, 2).concat(run(5, 4), run(30, 2));
ck('Kein Schalten bei Wechsel hin und her: 20 min 2 °C, 5 min 4 °C, 30 Takte 2 °C -> nichts (die 30 min beginnen bei jedem Lagewechsel neu)', out(o, 0).length === 0 && out(o, 1).length === 0, '');
o = run(1, 2);
ck('... nach 30 min am Stueck bei 2 °C: Comfort', out(o, 0).length === 1 && out(o, 0)[0].payload === '0', '');
atReset({TOP18_Quiet_Mode_Level: 3}); at('schalter', true); o = run(31, 6);
ck('Quiet steht schon auf 3: Efficiency angefordert, kein Quiet-Befehl, Protokoll sagt warum', out(o, 0).length === 1 && out(o, 1).length === 0 && /Quiet steht schon auf 3/.test(out(o, 2)[0].payload), JSON.stringify(out(o, 2)));
atReset({MQTT: {block_active: 1, block_mode: 1, messages_today: 0, message_limit: 500}}); at('schalter', true); o = run(31, 6);
ck('MQTT gesperrt: kein Quiet-Befehl, Protokoll nennt die Sperre (die Heizregelung lehnt "Heizregelung Befehl" selbst ab und protokolliert)', out(o, 1).length === 0 && out(o, 0).length === 1 && /gesperrt/.test(out(o, 2)[0].payload), JSON.stringify(out(o, 2)));
atReset({MQTT: {block_active: 0, block_mode: 3, messages_today: 500, message_limit: 500}}); at('schalter', true); o = run(31, 6);
ck('Tagesbudget aufgebraucht: kein Quiet-Befehl, Protokoll nennt das Budget', out(o, 1).length === 0 && /Tagesbudget/.test(out(o, 2)[0].payload), JSON.stringify(out(o, 2)));
atReset(); at('schalter', true); o = []; for (let i = 0; i < 60; i++) { g.TOP14_Outside_Temp = undefined; NOW += 60000; o.push(at() || []); }
ck('Ohne Aussentemperatur: nichts', out(o, 0).length === 0 && out(o, 1).length === 0, '');
atReset(); at('schalter', true); run(20, 1); rs = at('schalter', false); o = run(60, 1);
ck('Ausschalten: Protokoll "ausgeschaltet", danach nichts mehr', /ausgeschaltet/.test(rs[2].payload) && g.HC_AT.on === false && out(o, 0).length === 0, '');
atReset(); g.HC_AT = {on: true}; cx.neu = true; rs = at();
ck('Nach Neustart oder Einspielen: erster Takt stellt den Schalter auf den gemerkten Stand (an)', rs[3] && rs[3].payload === true && cx.neu === false, JSON.stringify(rs[3]));
ck('Kette Automatik -> Schalter: Comfort wird von Efficiency aus gesendet (SetHeatingControl "0", Quelle Aussentemperatur), Protokoll vom Schalter mit derselben Zeile',
   (() => { atReset({HEATING_CONTROL: 1}); at('schalter', true); const oo = run(31, 1, false), rr = fCmd(out(oo, 0)[0], ctx(g), ctx(fl), {}, FakeDate); return sent(rr) && sent(rr).payload === '0' && sent(rr).source === 'Außentemperatur' && rr[3] && rr[3].topic === 'Heizregelung nach Außentemperatur' && /Comfort gesendet/.test(rr[3].payload); })(), '');
atReset(); at('schalter', true); o = run(10, 1); const tx = (out(o, 4).pop() || {}).payload || '';
ck('Textzeile zeigt Lage und wann geschaltet wird (nur bei Aenderung gesendet)', /^an · kalt \(≤ 2 °C\) seit \d\d:\d\d · schaltet ab \d\d:\d\d/.test(tx) && out(o, 4).length < 10, tx);
atReset({HEATING_CONTROL: 1}); at('schalter', true); o = run(31, 1, false);
ck('Schalter lehnt ab / Stand kommt nicht: erste Anforderung', out(o, 0).length === 1, '');
o = run(9, 1, false);
ck('... in den naechsten 9 min keine weitere', out(o, 0).length === 0, '');
o = run(1, 1, false);
ck('... nach 10 min Versuch 2 (Protokoll "Versuch 2")', out(o, 0).length === 1 && /Versuch 2/.test(out(o, 2)[0].payload), JSON.stringify(out(o, 2)));
o = run(10, 1, false).concat(run(10, 1, false), run(60, 1, false));
ck('... Versuch 3, danach Schluss mit Protokoll "nach 3 Versuchen", keine 4. Anforderung', out(o, 0).length === 1 && out(o, 2).some(m => /nach 3 Versuchen/.test(m.payload)), JSON.stringify(out(o, 2)));
atReset({HEATING_CONTROL: 1}); at('schalter', true); o = run(31, 1, false); g.HEATING_CONTROL = 0; o = run(1, 1, false); const tx2 = (out(o, 4).pop() || {}).payload || '';
ck('Meldet HeishaMon den Modus (z. B. nach Handschaltung), ist die Lage erledigt: keine weitere Anforderung, Text "geschaltet"', out(o, 0).length === 0 && /geschaltet/.test(tx2) && run(30, 1, false).every(r => !r[0]), tx2);
atReset(); at('schalter', true); o = run(60, null);
ck('Fuehlerwert null (nicht 0 °C): nichts', out(o, 0).length === 0, '');
atReset(); at('schalter', true); o = run(20, 1); g.TOP26_Defrosting_State = 1; o = o.concat(run(15, 5)); g.TOP26_Defrosting_State = 0;
ck('Abtauen: Fuehlersprung auf 5 °C waehrend des Abtauens zaehlt nicht, die kalte Lage laeuft weiter (Comfort nach 30 min), kein Efficiency', out(o, 0).length === 1 && out(o, 0)[0].payload === '0', JSON.stringify(out(o, 0)));
ck('Verdrahtung Automatik: Takt jede Minute, Ausgaenge Schalter-Befehl / gemeinsamer Weg (Quiet) / Protokoll / Schalter / Textzeile; Schalter und Text in der Gruppe HEIZREGELUNG; kein eigener mqtt out',
   by.hc_at_tick.type === 'inject' && String(by.hc_at_tick.repeat) === '60' && by.hc_at_tick.wires.join() === 'hc_at' && by.hc_at.outputs === 5
   && JSON.stringify(by.hc_at.wires) === JSON.stringify([['hc_cmd'], ['hc_out'], ['hc_log'], ['hc_at_sw'], ['hc_at_txt']]) && /neu/.test(by.hc_at.initialize)
   && by.hc_at_sw.type === 'ui_switch' && by.hc_at_sw.group === 'hc_grp' && by.hc_at_sw.passthru === false && by.hc_at_sw.topic === 'schalter' && by.hc_at_sw.wires.join() === 'hc_at'
   && by.hc_at_txt.group === 'hc_grp' && !flows.some(n => ['hc_at', 'hc_at_sw', 'hc_at_txt', 'hc_at_tick'].includes(n.id) && n.type === 'mqtt out'), '');
process.exit(fails ? 1 : 0);

// Offline-Pruefung der Entscheidungsmaschine (tools/engine_core.js) mit Fake-Uhr: Regeln, Sperren, Datensaetze, Punktesystem, Klick-Uebernahme,
// Mehrtages-Szenarien mit einem einfachen Anlagenmodell, Replay der echten Daten (wenn vorhanden) und - mit Flow-Datei - die Node-RED-Huellen.
// Usage: node tools/engine_sim.js [flows.json] [Datenordner]
//   ohne flows.json: nur Kern + Replay; Datenordner Standard: ../engine_brief/data (fehlt er, werden die Replay-Pruefungen uebersprungen)
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const E = require('./engine_core.js');
const flowsFile = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null;
const dataDir = process.argv[3] || path.join(__dirname, '..', '..', 'engine_brief', 'data');
let fails = 0, oks = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined && info !== '' ? '  -> ' + info : '')); if (cond) { oks++; } else { fails++; } }
const MIN = 60000;
const T0 = new Date(2026, 9, 12, 6, 0, 0).getTime();
const cfg = E.defaults();

// ------------------------------------------------------------------ Hilfen: Eingabe bauen
function rooms(o) {
    o = o || {};
    return [
        {id: 'ki_oben', name: 'Kinderzimmer oben', t: o.ki_oben !== undefined ? o.ki_oben : 22.6, age: o.age !== undefined ? o.age : 10, min: 22, max: 23.5, valid: o.valid !== false, active: true},
        {id: 'ki_unten', name: 'Kinderzimmer unten', t: 21, age: 10, min: 20, max: 22, valid: true, active: true},
        {id: 'schlaf', name: 'Schlafzimmer', t: 21, age: 10, min: 20, max: 22, valid: true, active: true}
    ];
}
function inp(t, o) {
    const b = {t: t, hpAge: 0.5, hz: 17, vl: 30, rl: 28, soll: 30, dT: 3, pel: 300, pth: 2100, flow: 13.5, pump: 1750, q: 3, qPrio: 1, hc: 1, at: 9, defrost: 0, dhw: 0, ss: 0,
               rt: 60, shift: 0, heatMode: 0, z1Sensor: 0, heaterI: 0, heaterE: 0, htrOnAT: 0, htrStartDelta: -3, heatOffAT: 12, sollKurve: 29.75, block: 0, otherQ: null, otherShift: null, kzRad: 1,
               rooms: rooms(), korr: {v: 0, code: 'alle im Band', distrib: false, lead: ''}};
    return Object.assign(b, o || {});
}
function runSeq(n, f, S0, c) {                                                  // n Minuten, f(i) liefert die Eingabe
    let S = S0 || null; const outs = [];
    for (let i = 0; i < n; i++) { const o = E.step(S, f(i), c || cfg); S = o.S; outs.push(o); }
    return {S: S, outs: outs};
}
const r0 = (o, id) => o.res.find(r => r.id === id);

// ================================================================== (a) Regeln, Sperren, Datensaetze
console.log('--- (a) Regelwerk als Daten');
check('Regelwerk: 4 Regeln mit ID, Version, Zweck, Eingaengen, Schwellen (Standard, Einheit, Herkunft), Sperren, Befehl, Erwartung, Rueckweg, Prognose',
      E.RULES.length === 4 && E.RULES.every(R => R.id && R.ver >= 1 && R.zweck && R.eingaenge.length && R.schwellen.length && R.schwellen.every(s => s.key && typeof s.std === 'number' && s.einheit && s.herkunft) && R.sperren.length && R.befehl.topic && R.erwartung && R.rueckweg && R.prognose.p > 0 && R.prognose.h.length),
      E.RULES.map(R => R.id + ' v' + R.ver).join(', '));
check('Regelwerk: keine Regel stellt die Heizregelung (Comfort/Efficiency); kein Befehl SetHeatingControl im Kern', !E.RULES.some(R => /HeatingControl/.test(R.befehl.name)) && !/SetHeatingControl/.test(fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8')), '');
check('Regelwerk: jede Sperre der Regeln ist definiert und hat eine Herkunft', E.RULES.every(R => R.sperren.every(id => E.LOCKS.some(l => l.id === id && l.herkunft))), '');
check('Standardwerte entstehen aus dem Regelwerk (eine Quelle)', E.defaults().rules.quiet_freigabe.capHz === 20 && E.defaults().rules.raum_offset.minVlC === 29 && E.defaults().locks.stopK === 3.25, '');
check('Konfiguration: nur bekannte Schwellen, Zahlen werden uebernommen, Unsinn verworfen', (() => { const c = E.mergeCfg({rules: {quiet_freigabe: {capHz: '18', foo: 1, haltMin: 'x'}}, locks: {gapMin: 30}}); return c.rules.quiet_freigabe.capHz === 18 && c.rules.quiet_freigabe.foo === undefined && c.rules.quiet_freigabe.haltMin === 10 && c.locks.gapMin === 30; })(), '');
check('Kern ist rein: kein Date.now, kein Math.random, kein require/fs/global/flow/node im Code', (() => { const src = fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8').replace(/\/\/.*$/gm, ''); return !/Date\.now|Math\.random|require\(|\bfs\.|global\.(get|set)|flow\.(get|set)|node\.(send|warn)/.test(src); })(), '');

console.log('--- (a) Quiet-Freigabe: Ablauf bereit -> wartet -> Vorschlag, mit Gruenden und naechster Schwelle');
{
    // 70 min Lauf; ab Minute 30 Soll 38 (Boost von Hand), Quiet 3 haelt 16 Hz
    const f = i => inp(T0 + i * MIN, {rt: 20 + i, soll: i >= 30 ? 38 : 30, vl: i >= 30 ? 30 : 29.5, rl: i >= 30 ? 28.25 : 28, sollKurve: 29.75, rooms: rooms({ki_oben: 21.2}), q: 3, hz: 16});
    const R = runSeq(70, f);
    const st = R.outs.map(o => r0(o, 'quiet_freigabe').st);
    const firstProp = st.indexOf('vorschlag');
    check('vor dem Boost: "bereit", Grund nennt den knappsten Grund in Worten, naechste Schwelle mit Abstand', st[20] === 'bereit' && /kein Vorschlag: Vorlauf 0,50 K darunter/.test(r0(R.outs[20], 'quiet_freigabe').grund) && r0(R.outs[20], 'quiet_freigabe').naechste.abstand === 1 && /würde schalten, sobald Vorlauf mindestens 1,5 K unter Soll/.test(r0(R.outs[20], 'quiet_freigabe').naechste.text), r0(R.outs[20], 'quiet_freigabe').grund + ' | ' + r0(R.outs[20], 'quiet_freigabe').naechste.text);
    check('nach dem Sollsprung: 10 min "wartet" (Haltezeit), dann Vorschlag in Minute 40', st.slice(30, 40).every(s => s === 'wartet') && firstProp === 40, 'erster Vorschlag in Minute ' + firstProp);
    const p = R.outs[40].prop;
    check('Vorschlag: Befehl SetQuietMode = 0 (nicht schrittweise), von 3, Begruendung mit Zahlen, Erwartung, Gueltig bis, Rueckweg, Pruefsumme', p && p.cmd.name === 'SetQuietMode' && p.cmd.value === 0 && p.von === 3 && /16 Hz am Quiet-Deckel, Vorlauf 8,0 K und Rücklauf 6,8 K unter Soll/.test(p.warum) && /Kinderzimmer oben 0,8 K unter Minimum/.test(p.warum) && /≥ 25 Hz binnen 5 min/.test(p.erwartung) && p.bis === p.ts + 30 * MIN && /Kein automatischer Rückweg/.test(p.rueckweg) && p.sum === E.checksum(p), p && (p.was + ' | ' + p.warum));
    check('Vorschlag bleibt stabil (gleiche ID) solange die Lage gilt', R.outs.slice(40, 69).every(o => o.prop && o.prop.id === p.id), '');
    check('Ereignis "optimierer_vorschlag" genau einmal', R.outs.reduce((a, o) => a + o.ev.filter(e => e[0] === 'optimierer_vorschlag').length, 0) === 1, '');
    // Datensatz
    const rec = R.outs[40].rec;
    check('Datensatz je Minute: Zeit, Versionen, Eingabe-Schnappschuss, Ableitungen, je Regel Status+Grund, Vorschlag-ID', rec.t === E.iso(T0 + 40 * MIN) && rec.mv === E.VER && rec.sv === E.SCORE_VER && rec.in.soll === 38 && rec.in.rooms.length === 3 && rec.abl.z === 'lauf' && rec.r.length === 4 && rec.r.every(x => x.id && x.v && x.st && x.grund) && rec.vorschlag === p.id, JSON.stringify(rec.r.map(x => x.st)));
    check('Datensatz: "bereit" traegt die naechste Schwelle als Felder (b, ist, s, abstand), ohne Fliesstext', (() => { const x = R.outs[20].rec.r[0]; return x.naechste && x.naechste.b === 'vlRueck' && x.naechste.ist === 0.5 && x.naechste.s === 1.5 && x.naechste.abstand === 1 && x.naechste.text === undefined; })(), JSON.stringify(R.outs[20].rec.r[0].naechste));
    check('Nachspielen aus dem Datensatz: unsnap(snapshot) liefert dieselbe Entscheidung', (() => { const R2 = runSeq(70, i => E.unsnap(T0 + i * MIN, JSON.parse(JSON.stringify(R.outs[i].rec.in)))); return R2.outs.every((o, i) => JSON.stringify(o.rec.r) === JSON.stringify(R.outs[i].rec.r)); })(), '');
}
console.log('--- (a) Sperren (jede Regel erbt sie)');
{
    const boost = (i, extra) => inp(T0 + i * MIN, Object.assign({rt: 30 + i, soll: 38, vl: 30, rl: 28.25, rooms: rooms({ki_oben: 21.2}), q: 3, hz: 16}, extra || {}));
    // Sperre ab Minute 15 (vorher kann schon ein Vorschlag stehen): ab dann nie ein Vorschlag, Grund nennt die Sperre
    const lockCase = (name, extra, rx, n) => { const R = runSeq(n || 25, i => boost(i, typeof extra === 'function' ? extra(i) : (i >= 15 ? extra : {}))); const r = r0(R.outs[R.outs.length - 1], 'quiet_freigabe'); check('Sperre ' + name, r.st === 'gesperrt' && rx.test(r.grund) && !R.outs.slice(15).some(o => o.prop && o.prop.rule === 'quiet_freigabe'), r.st + ': ' + r.grund); };
    lockCase('Daten: HeishaMon 8 min alt -> gesperrt, ein laufender Vorschlag wird zurueckgezogen', {hpAge: 8}, /HeishaMon-Daten fehlen oder sind veraltet \(letzte Meldung vor 8 min\)/);
    lockCase('Daten: Verdichterwert fehlt', {hz: null}, /HeishaMon-Daten/);
    lockCase('MQTT.block_active', {block: 1}, /MQTT-Befehle sind gesperrt/);
    lockCase('Abtauen laeuft', i => ({defrost: i >= 15 ? 1 : 0}), /Abtauen oder kurz danach \(läuft\)/);
    lockCase('nach dem Abtauen (10 min)', i => ({defrost: i >= 12 && i < 20 ? 1 : 0}), /Abtauen oder kurz danach \(noch \d+ min\)/);
    lockCase('Warmwasser', {dhw: 1}, /Warmwasser/);
    lockCase('Sanftanlauf', {ss: 1}, /Sanftanlauf/);
    lockCase('anderer Regler stellt Quiet (HeishaMoNR-Quiet-Logik)', {otherQ: 'HeishaMoNR-Quiet-Logik AN'}, /anderer Regler.*Quiet-Logik/);
    { const c0 = E.mergeCfg({rules: {quiet_freigabe: {haltMin: 0}}}); const R = runSeq(5, i => boost(i), null, c0); const r = r0(R.outs[4], 'quiet_freigabe'); check('Sperre Neustart der Maschine (erste 10 min, Haltezeit hier 0)', r.st === 'gesperrt' && /beobachtet erst seit kurzem \(Neustart\) \(noch 6 min\)/.test(r.grund) && !R.outs.some(o => o.prop), r.grund); }
    { const R = runSeq(25, i => boost(i, {q: i < 5 ? 2 : 3})); const r = r0(R.outs[24], 'quiet_freigabe'); check('Sperre Mindestabstand: Quiet wurde vor 20 min geaendert (60 min Abstand)', r.st === 'gesperrt' && /Mindestabstand.*letzte Änderung/.test(r.grund) && r.naechste.bis === T0 + 5 * MIN + 60 * MIN, r.grund); }
    { const R = runSeq(25, i => boost(i, {vl: 30, soll: 28.5, rl: 28.25})); const r = r0(R.outs[24], 'quiet_freigabe'); check('Takt-Gefahr: Vorlauf ueber Soll -> keine Freigabe (Bedingung Rueckstand fehlt sowieso)', r.st === 'bereit', r.grund); }
    // Lauf seit 5 min: laufbeginn ist zugleich Bedingung
    { const R = runSeq(25, i => boost(i, {rt: 2 + i * 0})); const r = r0(R.outs[24], 'quiet_freigabe'); check('Startphase: Lauf erst 2 min -> "bereit: Startphase", keine Haltezeit', r.st === 'bereit' && /Startphase: Lauf erst 2 von 15 min/.test(r.grund), r.grund); }
    // Heizgrenze-Aus fuer Raumregel
    { const R = runSeq(75, i => inp(T0 + i * MIN, {hz: 0, pump: 0, rt: 0, korr: {v: 1, code: 'Raum unter Minimum', distrib: false, lead: 'Kinderzimmer oben'}, rooms: rooms({ki_oben: 21.2})})); const r = r0(R.outs[74], 'raum_offset'); check('Raumregel: Heizgrenze-Aus (Pumpe 0) sperrt die Verschiebung', r.st === 'gesperrt' && /Heizgrenze-Aus/.test(r.grund), r.grund); }
    // Takt-Gefahr richtungsabhaengig: -1 K bei Vorlauf +0,5 K gesperrt (nach -1 K +1,5 K), +1 K nicht
    { const R = runSeq(75, i => inp(T0 + i * MIN, {soll: 31, sollKurve: 30.5, vl: 31.5, korr: {v: -1, code: 'Überschreitung', distrib: false, lead: 'Schlafzimmer'}})); const r = r0(R.outs[74], 'raum_offset'); check('Takt-Gefahr richtungsabhaengig: -1 K bei Vorlauf +0,5 K ueber Soll -> gesperrt (nach -1 K +1,5 K)', r.st === 'gesperrt' && /Takt-Gefahr.*nach −1 K \+1,50 K/.test(r.grund), r.grund); }
    { const R = runSeq(75, i => inp(T0 + i * MIN, {soll: 31, sollKurve: 30.5, vl: 33, korr: {v: 1, code: 'Raum unter Minimum', distrib: false, lead: 'Kinderzimmer oben'}, rooms: rooms({ki_oben: 21.5})})); const r = r0(R.outs[74], 'raum_offset'); check('Takt-Gefahr gilt nicht fuer +1 K (hebt den Abstand zur Abschaltgrenze): Vorschlag trotz Vorlauf +2 K', r.st === 'vorschlag', r.grund); }
    { const R = runSeq(75, i => inp(T0 + i * MIN, {at: 0, soll: 33, sollKurve: 33.1, vl: 31, korr: {v: 1, code: 'Raum unter Minimum', distrib: false, lead: 'Kinderzimmer oben'}, rooms: rooms({ki_oben: 21.5})})); const r = r0(R.outs[74], 'raum_offset'); check('Heizstab-Naehe: +1 K bei 0 °C und Vorlauf 2 K unter Soll -> gesperrt (nach +1 K 3 K unter Soll)', r.st === 'gesperrt' && /Heizstab-Nähe/.test(r.grund), r.grund); }
    { const R = runSeq(75, i => inp(T0 + i * MIN, {soll: 38, sollKurve: 29.75, korr: {v: 1, code: 'Raum unter Minimum', distrib: false, lead: 'Kinderzimmer oben'}, rooms: rooms({ki_oben: 21.5})})); const r = r0(R.outs[74], 'raum_offset'); check('Handeingriff am Soll (38 statt Kurve 29,75 °C): Raumregel gesperrt', r.st === 'gesperrt' && /Handeingriff/.test(r.grund), r.grund); }
    { const R = runSeq(75, i => inp(T0 + i * MIN, {heatMode: 1, korr: {v: 1, code: 'x', distrib: false, lead: 'Kinderzimmer oben'}})); check('kein Heizkurvenmodus (TOP76 != 0): Raumregel gesperrt', /kein Heizkurvenmodus/.test(r0(R.outs[74], 'raum_offset').grund), r0(R.outs[74], 'raum_offset').grund); }
    { const R = runSeq(75, i => inp(T0 + i * MIN, {z1Sensor: 1, korr: {v: 1, code: 'x', distrib: false, lead: 'Kinderzimmer oben'}})); check('Zonenfuehler nicht Wasser (TOP111 != 0): Raumregel gesperrt (sonst ginge ein Befehl ueber SetCurves)', /nicht über Wassertemperatur/.test(r0(R.outs[74], 'raum_offset').grund), r0(R.outs[74], 'raum_offset').grund); }
    { const R = runSeq(75, i => inp(T0 + i * MIN, {soll: 29, sollKurve: 28.5, korr: {v: -1, code: 'Überschreitung', distrib: false, lead: 'Schlafzimmer'}})); const r = r0(R.outs[74], 'raum_offset'); check('Vorlauf-Untergrenze 29 °C: -1 K bei Soll 29 nie (kein Vorschlag)', r.st === 'bereit' && /Soll-Vorlauf würde 28 °C \(Untergrenze 29 °C\)/.test(r.grund), r.grund); }
    { const R = runSeq(75, i => inp(T0 + i * MIN, {korr: {v: 1, code: 'Raum unter Minimum', distrib: true, lead: 'Kinderzimmer oben'}})); check('Waermeverteilungsproblem: keine Verschiebung', /Wärmeverteilungsproblem/.test(r0(R.outs[74], 'raum_offset').grund), r0(R.outs[74], 'raum_offset').grund); }
    { const R = runSeq(95, i => inp(T0 + i * MIN, {korr: {v: i < 30 ? 0 : 1, code: 'Raum unter Minimum', distrib: false, lead: 'Kinderzimmer oben'}, rooms: rooms({ki_oben: 21.5})})); const st = R.outs.map(o => r0(o, 'raum_offset').st); check('Raumregel: lange Haltezeit 60 min, erst dann Vorschlag "+1 K" (SetZ1HeatRequestTemperature = 1)', st[60] === 'bereit' && /erst seit 30 von 60 min stabil/.test(r0(R.outs[60], 'raum_offset').grund) && st[90] === 'vorschlag' && R.outs[90].prop.cmd.name === 'SetZ1HeatRequestTemperature' && R.outs[90].prop.cmd.value === 1, st[60] + '/' + st[90]); }
}
console.log('--- (a) Randfaelle: fehlende/unsinnige Werte, Neustart, Tageslimit, Zeitumstellung');
{
    let err = null, o = null;
    try { o = E.step(null, {t: T0}, cfg); o = E.step(o.S, {t: T0 + MIN, hz: 'abc', vl: NaN, soll: null, rooms: null, korr: {v: 'x'}, q: '3'}, cfg); } catch (e) { err = e; }
    check('leere/unsinnige Eingaben: kein Absturz, alles "gesperrt" (Daten) oder "bereit", kein Vorschlag', err === null && o && !o.prop && o.res.every(r => ['gesperrt', 'bereit', 'inaktiv'].indexOf(r.st) >= 0), err ? err.message : JSON.stringify(o.res.map(r => r.st)));
    let err2 = null; try { E.step({mv: 99, foo: 1}, inp(T0), cfg); E.step('kaputt', inp(T0), cfg); } catch (e) { err2 = e; }
    check('fremder/kaputter Zustand aus der Datei: wird ersetzt, kein Absturz', err2 === null, err2 ? err2.message : '');
    // Neustart mitten im Vorschlag: Zustand per JSON (Datei) -> Vorschlag bleibt, Zaehler bleiben, 10 min Anlauf-Sperre zieht ihn zurueck
    const f = i => inp(T0 + i * MIN, {rt: 30 + i, soll: 38, vl: 30, rl: 28.25, rooms: rooms({ki_oben: 21.2}), q: 3, hz: 16});
    const A = runSeq(25, f), S1 = JSON.parse(JSON.stringify(A.S)); S1.born = T0 + 25 * MIN;
    const B = runSeq(15, i => f(25 + i), S1);
    check('Neustart (Zustand aus Datei): Anlauf-Sperre 10 min zieht den Vorschlag zurueck, danach neuer Vorschlag; Tageszaehler bleibt', A.outs[24].prop && r0(B.outs[0], 'quiet_freigabe').st === 'gesperrt' && /Neustart/.test(r0(B.outs[0], 'quiet_freigabe').grund) && B.outs[14].prop === null && B.S.rules.quiet_freigabe.n === 1, r0(B.outs[14], 'quiet_freigabe').st + ' n=' + B.S.rules.quiet_freigabe.n);
    // Tageslimit 3, Wechsel um Mitternacht setzt zurueck
    let S = null, props = 0; const d0 = new Date(2026, 9, 12, 20, 0, 0).getTime();
    for (let i = 0; i < 6 * 60; i++) {
        const cyc = i % 100, t = d0 + i * MIN;              // alle 100 min: 40 min Lage, dann 60 min ohne Lage
        const o2 = E.step(S, inp(t, {rt: 20 + cyc, soll: cyc < 40 ? 38 : 30, vl: cyc < 40 ? 30 : 31, rl: 28.25, rooms: rooms({ki_oben: 21.2}), q: 3, hz: 16}), cfg); S = o2.S;
        props += o2.res.filter(r => r.neu && r.id === 'quiet_freigabe').length;
    }
    check('Tageslimit (3 Vorschlaege) und Ruecksetzen um Mitternacht: 20:00-02:00 hoechstens 3 am 12.10. + neue am 13.10.', props >= 3 && props <= 6 && S.rules.quiet_freigabe.day === '2026-10-13', 'Vorschlaege ' + props + ', Tag ' + S.rules.quiet_freigabe.day);
    // Zeitumstellung 25.10.2026 (03:00 -> 02:00): Minutenschritte in ms, Datensatzzeit lokal, kein Fehler
    let Sd = null, errD = null; const dst = new Date(2026, 9, 25, 0, 0, 0).getTime(), ts = [];
    try { for (let i = 0; i < 300; i++) { const o3 = E.step(Sd, inp(dst + i * MIN, {rt: i}), cfg); Sd = o3.S; ts.push(o3.rec.t); } } catch (e) { errD = e; }
    check('Zeitumstellung 25.10.: 300 Minuten ohne Fehler, Uhrzeit 02:xx kommt zweimal vor (lokale Zeit im Datensatz), Laufzeit monoton', errD === null && ts.filter(t => t.slice(11, 13) === '02').length === 120, errD ? errD.message : ts.filter(t => t.slice(11, 13) === '02').length + ' Minuten mit 02 Uhr');
}

// ------------------------------------------------------------------ Mehrtages-Simulation mit einfachem Anlagenmodell (Takt, Kaltstart, Boost, Abtauen, Sensorausfall, Neustarts)
// Spielzeug-Physik, nur fuer Ablauf und Sicherheit (nicht fuer Aussagen ueber die Anlage): Wasserkreis 0,4 kWh/K, Heizkoerper 0,25 kW/K, Haus UA 0,18 kW/K, 8 kWh/K,
// innere Gewinne 0,9 kW (Opus 09.10.: 0,5-0,9 kW); Mindestleistung 2,1 kW deckt den Bedarf bis ~6 °C (wie gemessen: bei 4-6 °C Dauerlauf am Minimum).
function plantSim(days, opts) {
    opts = opts || {};
    const P = {on: false, tw: 31, room: 22.3, over: 0, under: 0, q: opts.q !== undefined ? opts.q : 3, shift: 0, rt: 0, sollHand: null, defrost: 0};
    let S = null; const log = {props: [], recs: 0, ev: [], scores: [], lockedProp: 0, maxSendable: 0, errors: 0, minutes: 0, statuses: {}};
    const start = new Date(2026, 9, 14, 0, 0, 0).getTime();
    for (let i = 0; i < days * 1440; i++) {
        const t = start + i * MIN, h = (i % 1440) / 60, day = Math.floor(i / 1440);
        const at = (opts.at !== undefined ? opts.at : 8) + 4 * Math.sin(2 * Math.PI * (h - 9) / 24) - day * (opts.cool || 0);
        const atI = Math.round(at), kurve = Math.max(29, 29 + 0.375 * (11 - atI));
        const soll = Math.ceil(P.sollHand !== null ? P.sollHand : kurve) + P.shift;
        if (opts.boostAt && i % 1440 === opts.boostAt) { P.sollHand = 38; }
        if (opts.boostAt && i % 1440 === opts.boostAt + 60) { P.sollHand = null; }
        if (opts.defrostEvery && P.on && i % opts.defrostEvery === 0) { P.defrost = 6; }
        const spread = P.on ? 2.5 : 0, vl = Math.round((P.tw + spread / 2) * 4) / 4, rl = Math.round((P.tw - spread / 2) * 4) / 4;
        const rlRueck = soll - 3 - rl;
        const hz = !P.on ? 0 : (P.defrost > 0 ? 17 : (P.q >= 1 ? 16 + (i % 2) : (rlRueck >= 2.5 ? 33 : 17)));
        const pth = !P.on ? 0 : (P.defrost > 0 ? -1000 : (hz >= 30 ? 5000 : 2100)), qrad = 0.25 * (P.tw - P.room);
        P.tw += ((pth / 1000) - qrad) / 0.4 / 60; P.room += (qrad - 0.18 * (P.room - at) + 0.9) / 8 / 60;
        if (P.defrost > 0) { P.defrost--; }
        if (P.on) { P.rt++; if (vl >= soll + 3.25) { P.over++; } else { P.over = 0; } if (P.over >= 3) { P.on = false; P.rt = 0; P.over = 0; } }
        else { if (vl <= soll - 3) { P.under++; } else { P.under = 0; } if (P.under >= 6 && at < 15) { P.on = true; P.under = 0; } }
        const stale = opts.staleFrom !== undefined && i >= opts.staleFrom && i < opts.staleFrom + 30;
        const korrV = P.room < 21.7 ? 1 : (P.room > 23.6 ? -1 : 0);
        const x = {t: t, hpAge: stale ? 12 : 0.4, hz: hz, vl: vl, rl: rl, soll: soll, dT: 3, pel: hz >= 30 ? 830 : (P.on ? 300 : 15), pth: pth, flow: 13.5, pump: P.on || at < 15 ? 1750 : 0,
                   q: P.q, qPrio: 1, hc: 1, at: atI, defrost: P.defrost > 0 ? 1 : 0, dhw: 0, ss: 0, rt: P.rt, shift: P.shift, heatMode: 0, z1Sensor: 0, heaterI: 0, heaterE: 0, htrOnAT: 0, htrStartDelta: -3,
                   heatOffAT: 12, sollKurve: kurve, block: opts.block && i % 700 < 30 ? 1 : 0, otherQ: null, otherShift: null, kzRad: 1,
                   rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: Math.round(P.room * 10) / 10, age: 20, min: 22, max: 23.5, valid: !stale, active: true}],
                   korr: {v: korrV, code: korrV ? 'Raum ausserhalb' : 'alle im Band', distrib: false, lead: 'Kinderzimmer oben'}};
        if (opts.restartEvery && i > 0 && i % opts.restartEvery === 0 && S) { S = JSON.parse(JSON.stringify(S)); S.born = t; }
        try {
            const o = E.step(S, x, cfg); S = o.S; log.recs++; log.minutes++;
            o.res.forEach(r => { log.statuses[r.st] = (log.statuses[r.st] || 0) + 1; if (r.neu) { log.props.push(S.rules[r.id].prop); if (r.locks.length) { log.lockedProp++; } } });
            if (o.prop && o.prop.art === 'befehl' && (x.block === 1 || stale || x.defrost === 1)) { log.maxSendable++; }
            o.scores.forEach(s => log.scores.push(s)); o.ev.forEach(e => log.ev.push(e));
            if (opts.applyQuiet && o.prop && o.prop.rule === 'quiet_freigabe') { P.q = 0; }           // "Nutzer klickt": Quiet 0
        } catch (e) { log.errors++; if (log.errors < 3) { console.log(e.stack); } }
    }
    log.S = S;
    return log;
}
console.log('--- (a) Mehrtages-Simulation (Anlagenmodell, Fake-Uhr)');
{
    const A = plantSim(4, {at: 9, defrostEvery: 333, staleFrom: 3000, restartEvery: 1700, block: true});
    check('4 Tage mild (Takt) mit Abtauen, 30 min Datenausfall, Neustarts, MQTT-Sperre: kein Fehler, 5760 Datensaetze', A.errors === 0 && A.recs === 4 * 1440, 'Fehler ' + A.errors + ', Datensaetze ' + A.recs + ', Status ' + JSON.stringify(A.statuses));
    check('... nie ein Vorschlag waehrend Sperre/Abtauen/veralteter Daten', A.lockedProp === 0 && A.maxSendable === 0, 'gesperrte Vorschlaege ' + A.lockedProp + ', Vorschlag in Sperrminute ' + A.maxSendable);
    const aq = A.props.filter(p => p.rule === 'quiet_freigabe');
    check('... Quiet-Freigabe im milden Takt selten: hoechstens einmal je Tag und nur, wenn ein Sollsprung nach oben den Lauf zurueckwirft (Kaltstarts allein reichen nicht)', aq.length <= 4 && aq.every(p => /Sollvorlauf in diesem Lauf noch nicht erreicht/.test(p.warum)), aq.map(p => E.iso(p.ts) + ' ' + p.warum).join(' | '));
    const B = plantSim(3, {at: 9, boostAt: 9 * 60});
    const bq = B.props.filter(p => p.rule === 'quiet_freigabe');
    const inBoost = p => { const m = new Date(p.ts).getHours() * 60 + new Date(p.ts).getMinutes(); return m >= 9 * 60 + 10 && m <= 10 * 60; };
    check('3 Tage mit taeglichem Boost von Hand (Soll 38 fuer 60 min, Quiet 3): an jedem Boost-Tag eine Quiet-Freigabe 10-60 min nach Boost-Beginn', ['2026-10-14', '2026-10-15', '2026-10-16'].every(day => bq.some(p => E.iso(p.ts).slice(0, 10) === day && inBoost(p))), bq.map(p => E.iso(p.ts)).join(', '));
    check('... Raumregel waehrend des Boosts gesperrt (Handeingriff), nie ein Raum-Vorschlag mit Soll 38', !B.props.some(p => p.rule === 'raum_offset' && /38/.test(p.was)), B.props.filter(p => p.rule === 'raum_offset').map(p => p.was).join(' | '));
    const C = plantSim(3, {at: 9, boostAt: 9 * 60, applyQuiet: true});
    check('Boost mit "Klick" (Quiet 0 nach dem Vorschlag): Wirkungsfall wird bewertet (kein Kalibrierfall), Ausloeser-Fall neutral (Eingriff)', C.scores.some(s => s.typ === 'wirkung' && s.regel === 'quiet_freigabe' && s.kalibrierfall === 0) && C.scores.filter(s => s.typ === 'ausloeser' && s.regel === 'quiet_freigabe').every(s => s.ergebnis === 'neutral'), C.scores.filter(s => s.regel === 'quiet_freigabe').map(s => s.typ + ':' + s.punkte).join(', '));
    const D = plantSim(5, {at: 4, cool: 1.5});
    const perDay = {}; D.props.filter(p => p.rule === 'quiet_freigabe').forEach(p => { const k = E.iso(p.ts).slice(0, 10); perDay[k] = (perDay[k] || 0) + 1; });
    check('5 Tage kaelter werdend (4 -> -3,5 °C, Bedarf ueber der Mindestleistung): Quiet-Freigabe schlaegt an (Deckel-Lage), hoechstens 3 je Tag, kein Fehler', D.errors === 0 && Object.keys(perDay).length >= 3 && Object.keys(perDay).every(k => perDay[k] <= 3), JSON.stringify(perDay));
}

// ================================================================== (b) Punktesystem (automatisch, ohne Nutzereingabe)
console.log('--- (b) Punktesystem');
{
    // Grundlage: Brier-Prinzip. Eine Prognose p gewinnt gegen die Basisrate b nur, wenn sie trennt; Dauer-Alarm oder Raten bringt im Mittel <= 0 Punkte.
    const ev = (p, f) => f * E.brier(p, f, 1) + (1 - f) * E.brier(p, f, 0);           // Erwartungswert, wenn die Basisrate stimmt (b = f)
    check('Brier: Treffer gegen Basisrate 0,5 mit p 0,8 = +21, Fehlalarm = -39 (Punkte je Fall bei einem Horizont)', Math.abs(E.brier(0.8, 0.5, 1) - 21) < 1e-9 && Math.abs(E.brier(0.8, 0.5, 0) + 39) < 1e-9, E.brier(0.8, 0.5, 1) + ' / ' + E.brier(0.8, 0.5, 0));
    check('Kein Gaming: wer ohne Trennschaerfe vorschlaegt (Ergebnis = Basisrate f), bekommt im Mittel <= 0 Punkte, egal welches p (f 0,1..0,9, p 0,1..0,9)', [0.1, 0.3, 0.5, 0.7, 0.9].every(f => [0.1, 0.5, 0.8, 0.9].every(p => ev(p, f) <= 1e-9)), [0.1, 0.5, 0.9].map(f => 'f' + f + ':' + ev(0.8, f).toFixed(1)).join(' '));
    check('Treffer bei hoher Basisrate (0,86) bringt mit p 0,6 MINUS (der Vorschlag kam nur, wo das Problem ohnehin meist bleibt)', E.brier(0.6, 0.86, 1) < 0, E.brier(0.6, 0.86, 1).toFixed(2));

    const boost = (i, o) => inp(T0 + i * MIN, Object.assign({rt: 30 + i, soll: 38, sollKurve: 29.75, vl: 30, rl: 28.25, q: 3, hz: 16, rooms: rooms({ki_oben: 21.2})}, o || {}));
    // S1: Problem bleibt 150 min -> Treffer an allen drei Horizonten, Basisrate noch unbekannt (0,5) -> 3 x 7 = +21
    let R = runSeq(160, i => boost(i));
    let sc = [].concat.apply([], R.outs.map(o => o.scores)), a = sc.find(s => s.typ === 'ausloeser');
    check('Fall bleibt bestehen (150 min am Deckel mit Rueckstand): Treffer an 30/60/120 min, Basisrate 0,5 (noch < 5 Vergleiche), +21 Punkte', a && a.ergebnis === 'treffer' && a.horizonte.every(h => h.o === 1 && h.b === 0.5) && Math.abs(a.punkte - 21) < 0.01 && a.fall === 'quiet_freigabe@2026-10-12T06:10', a && (a.ergebnis + ' ' + a.punkte + ' ' + a.text));
    check('Punktebuch: Datensatz mit Regel, Version, Bewertungsversion, Prognose p, je Horizont Ergebnis/Basisrate/Punkte, laufende Summe', a && a.regel === 'quiet_freigabe' && a.v === 1 && a.sv === E.SCORE_VER && a.p === 0.8 && a.horizonte.length === 3 && a.summe === 21, a && JSON.stringify(a.horizonte[0]));
    // S2: Problem loest sich nach 5 min von selbst -> Fehlalarm an allen Horizonten -> -39
    R = runSeq(160, i => boost(i, i >= 15 ? {vl: 38, rl: 35.5} : {}));
    sc = [].concat.apply([], R.outs.map(o => o.scores)); a = sc.find(s => s.typ === 'ausloeser');
    check('Problem verschwindet von selbst (Ruecklauf am Soll nach 5 min): Fehlalarm, -39 Punkte', a && a.ergebnis === 'fehlalarm' && Math.abs(a.punkte + 39) < 0.01, a && (a.ergebnis + ' ' + a.punkte + ' ' + a.text));
    // S3: Eingriff (Quiet 0 von Hand 5 min nach dem Vorschlag) -> Ausloeser neutral, Wirkungsfall bewertet (kein Kalibrierfall): 33 Hz, +500 W, Vorlauf +3 K
    R = runSeq(160, i => boost(i, i >= 15 ? {q: 0, hz: 33, pel: 800, vl: Math.min(36, 30 + (i - 15) * 0.15)} : {pel: 300}));
    sc = [].concat.apply([], R.outs.map(o => o.scores)); a = sc.find(s => s.typ === 'ausloeser'); const w = sc.find(s => s.typ === 'wirkung');
    check('Eingriff von aussen (Quiet von Hand): Ausloeser-Prognose neutral (0), keine Gegenfaktik mehr', a && a.ergebnis === 'neutral' && a.punkte === 0 && /Eingriff nach 5 min/.test(a.text), a && a.text);
    check('Wirkungsprognose bei gleichwertiger Aenderung: 3 von 3 getroffen (>= 25 Hz, +500 W, Vorlauf +3 K) = +30, kein Kalibrierfall', w && w.punkte === 30 && w.kalibrierfall === 0 && w.teile.every(t => t.ergebnis === 'getroffen'), w && w.text);
    R = runSeq(160, i => boost(i, i >= 15 ? {q: 0, hz: 17, pel: 310} : {pel: 300}));
    sc = [].concat.apply([], R.outs.map(o => o.scores)); const w2 = sc.find(s => s.typ === 'wirkung');
    check('Wirkungsprognose daneben (Verdichter bleibt bei 17 Hz): -30', w2 && w2.punkte === -30, w2 && w2.text);
    // S4: Schaden: Verdichter stoppt 4 min nach dem Vorschlag (Lage war knapp vor der Abschaltung) -> -30 und Fehlalarm
    R = runSeq(160, i => boost(i, i >= 14 && i < 40 ? {hz: 0, rt: 0, pump: 1750, vl: 41.5, rl: 41} : (i >= 40 ? {soll: 30, vl: 31, rl: 28} : {})));
    sc = [].concat.apply([], R.outs.map(o => o.scores)); const dmg = sc.find(s => s.typ === 'schaden');
    check('Schaden: Stopp binnen 10 min nach dem Vorschlag = -30 (eigener Datensatz mit Art)', dmg && dmg.arten.indexOf('stopp10') >= 0 && dmg.punkte <= -30, dmg && dmg.text);
    // S5: Verpasst: Lage 25 min (Ruecklauf >= 2 K am Deckel), aber Tageslimit 0 -> keine Vorschlaege -> -20; bei MQTT-Sperre entschuldigt
    const c0 = E.mergeCfg({rules: {quiet_freigabe: {proTag: 0}}});
    R = runSeq(40, i => boost(i), null, c0); sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Verpasst: 20 min Lage am Deckel mit >= 2 K Rueckstand, eigenes Tageslimit verhinderte den Vorschlag -> -20', sc.some(s => s.typ === 'verpasst' && s.regel === 'quiet_freigabe' && s.punkte === -20), sc.map(s => s.typ).join(','));
    R = runSeq(40, i => boost(i, {block: 1})); sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Verpasst entschuldigt: MQTT-Sperre (Sicherheitssperre) -> keine Minuspunkte', !sc.some(s => s.typ === 'verpasst'), sc.map(s => s.typ).join(','));
    // S6: Basisrate lernt aus Vergleichslagen: 8 kurze Episoden (Rueckstand 30 min, dann geloest) -> b fuer 60/120 min nahe 0 -> Treffer zaehlt viel
    let S = null; const ep = [];
    for (let k = 0; k < 8; k++) { for (let i = 0; i < 150; i++) { const t = k * 150 + i; const o = E.step(S, inp(T0 + t * MIN, {rt: 20 + i, soll: 31, sollKurve: 30.5, vl: i < 30 ? 29 : 31.5, rl: i < 30 ? 26.5 : 29.5, q: 3, hz: 16, block: 1}), cfg); S = o.S; } }
    const B = S.sc.base.quiet_freigabe || {};
    check('Basisrate "bleibt, wie es ist": aus Vergleichslagen gelernt (8 Episoden mit 30 min Rueckstand: nach 30 min bestand das Problem 8/8, nach 120 min 0/8; 60 min unklar = nicht gezaehlt)', B['30'] && B['30'][0] === 8 && B['30'][1] === 8 && B['120'] && B['120'][0] === 8 && B['120'][1] === 0 && !B['60'], JSON.stringify(B));
    // S7: Neustart mitten in einem offenen Fall (Zustand per Datei) -> gleiches Ergebnis wie ohne Neustart
    const A1 = runSeq(160, i => boost(i));
    let Sx = null, sx = [];
    for (let i = 0; i < 160; i++) { if (i === 60) { Sx = JSON.parse(JSON.stringify(Sx)); Sx.born = T0 + i * MIN; } const o = E.step(Sx, boost(i), cfg); Sx = o.S; sx = sx.concat(o.scores); }
    const a1 = [].concat.apply([], A1.outs.map(o => o.scores)).find(s => s.typ === 'ausloeser'), ax = sx.find(s => s.typ === 'ausloeser');
    check('Neustart mitten im Fall: offener Fall ueberlebt die Datei, gleiches Ergebnis (+21)', a1 && ax && a1.punkte === ax.punkte && ax.ergebnis === 'treffer', (ax && ax.punkte) + ' vs ' + (a1 && a1.punkte));
    // S8: Raumoffset: Raum bleibt kalt -> Treffer; Verpasst, wenn der Raumvorschlag fehlt
    R = runSeq(400, i => inp(T0 + i * MIN, {korr: {v: 1, code: 'Raum unter Minimum', distrib: false, lead: 'Kinderzimmer oben'}, rooms: rooms({ki_oben: 21.2})}));
    sc = [].concat.apply([], R.outs.map(o => o.scores)); a = sc.find(s => s.typ === 'ausloeser' && s.regel === 'raum_offset');
    check('Raumoffset +1 K: Raum bleibt 240 min unter Minimum -> Treffer an 60/120/240 min', a && a.ergebnis === 'treffer' && a.horizonte.length === 3, a && a.text);
    R = runSeq(200, i => inp(T0 + i * MIN, {korr: {v: 0, code: 'Daten unvollständig', distrib: false, lead: ''}, rooms: rooms({ki_oben: 21.2, valid: false, age: 120})}));
    sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Raumoffset verpasst: Raum 0,8 K unter Minimum 180 min lang (Wert 2 h alt, Shelly meldet nur bei Aenderung), aber kein Raumvorschlag -> -20', sc.some(s => s.typ === 'verpasst' && s.regel === 'raum_offset'), sc.map(s => s.typ).join(','));
    // S9: Hinweis Heizgrenze: Raeume behalten die Reserve -> Treffer; Raum faellt unter Minimum -> Fehlalarm und Schaden "zu kalt"
    const mild = (i, t) => inp(T0 + i * MIN, {at: 13, rt: 20 + i, soll: 29, sollKurve: 29, vl: 30, rl: 28, rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: t, age: 10, min: 22, max: 23.5, valid: true, active: true}]});
    R = runSeq(220, i => mild(i, 22.8)); sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Heizgrenze-Hinweis: Raum behaelt die Reserve 180 min -> Treffer (nur Hinweis, kein Befehl)', sc.some(s => s.typ === 'ausloeser' && s.regel === 'heizgrenze_hinweis' && s.ergebnis === 'treffer') && R.outs.some(o => o.prop && o.prop.art === 'hinweis'), sc.map(s => s.typ + ':' + s.ergebnis).join(','));
    R = runSeq(220, i => mild(i, Math.round((i < 40 ? 22.8 : 22.8 - (i - 40) * 0.01) * 10) / 10)); sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Heizgrenze-Hinweis: Raum faellt langsam (0,6 K/h) unter Minimum - 0,3 K -> Fehlalarm und Schaden "zu kalt"', sc.some(s => s.typ === 'ausloeser' && s.ergebnis === 'fehlalarm') && sc.some(s => s.typ === 'schaden' && s.arten.indexOf('zu_kalt') >= 0), sc.map(s => s.typ + ':' + (s.ergebnis || s.arten)).join(','));
    R = runSeq(220, i => mild(i, i < 60 ? 22.8 : 21.6)); sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Lueftungsverdacht: Raum faellt 1,2 K in einer Minute (Fenster) -> Eingriff von aussen, Bewertung neutral, kein Schaden', sc.some(s => s.typ === 'ausloeser' && s.ergebnis === 'neutral' && /Lüftungsverdacht \(Kinderzimmer oben −1,2 K/.test(s.text)) && !sc.some(s => s.typ === 'schaden'), sc.map(s => s.typ + ':' + s.ergebnis + ' ' + (s.text || '').slice(-80)).join(','));
    // S10: Bericht, Wochenuebersicht, Freigabereife
    const rep = E.report(A1.S), rq = rep.find(r => r.regel === 'quiet_freigabe');
    check('Bericht je Regel: Punkte, Faelle, Treffer-/Fehlalarmquote, Brier-Skill, Schaden, Verpasst, Wirkung, Freigabereife mit Kriterien', rq && rq.punkte === 21 && rq.trefferquote === 1 && rq.fehlalarmquote === 0 && rq.skill !== null && rq.reif === false && rq.kriterien.length === 6 && rq.kriterien.find(k => k.k === 'faelle').ok === false, JSON.stringify(rq.kriterien.map(k => k.k + (k.ok ? '+' : '-'))));
    check('Wochenuebersicht (ISO-Woche) mit Punkten, Faellen, Treffern', A1.S.sc.week['2026-W42'] && A1.S.sc.week['2026-W42'].quiet_freigabe.punkte === 21 && A1.S.sc.week['2026-W42'].quiet_freigabe.treffer === 1, JSON.stringify(A1.S.sc.week));
    check('Punkteverlauf fuer das Diagramm (Zeit, Regel, Summe)', A1.S.sc.hist.length >= 1 && A1.S.sc.hist[A1.S.sc.hist.length - 1][2] === 21, JSON.stringify(A1.S.sc.hist.slice(-1)));
    // S11: Messaufgabe Comfort gegen Efficiency: beide Seiten mit Quiet 0 und Rueckstand -> ein Befund mit Zahlen
    let Sm = null, ms = [];
    for (let i = 0; i < 80; i++) { const hc = i < 40 ? 1 : 0, o = E.step(Sm, inp(T0 + i * MIN, {q: 0, hc: hc, rt: 30 + i, soll: 38, vl: 33, rl: 30, hz: hc ? 34 : 45, pel: hc ? 840 : 1150, pth: hc ? 5000 : 6500, at: 11}), cfg); Sm = o.S; ms = ms.concat(o.scores); }
    const mb = ms.find(s => s.typ === 'messaufgabe');
    check('Messaufgabe: Befund "Comfort bis 45 Hz, Efficiency bis 34 Hz" genau einmal, ohne Punkte', mb && mb.punkte === 0 && mb.comfort.hzMax === 45 && mb.efficiency.hzMax === 34 && ms.filter(s => s.typ === 'messaufgabe').length === 1 && /Comfort bis 45 Hz/.test(mb.text) && !E.messStatus(Sm).offen, mb && mb.text);
    const src = fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8'), bewertung = src.slice(src.indexOf('// ------------------------------------------------------------------ Punktesystem'), src.indexOf('// ------------------------------------------------------------------ Ein-Klick'));
    check('Verwerfen ist keine Bewertung: der Bewertungsteil des Kerns kennt weder Klicks noch den Uebernahme-Zustand (keine Nutzereingabe in den Punkten)', bewertung.length > 1000 && !/verworfen|lastClick|applyRequest|uebernehmen/.test(bewertung), bewertung.length + ' Zeichen geprueft');
}

// ================================================================== Replay der echten Daten (07.-10.10.)
let RP = null;
if (fs.existsSync(path.join(dataDir, 'quiet-2026-10.csv'))) {
    console.log('--- Replay der echten Minutenprotokolle (' + dataDir + ')');
    const replay = require('./engine_replay.js').replay;
    RP = replay(dataDir, {});
    const RP2 = replay(dataDir, {});
    check('Replay: 4110 Minuten 07.10. 16:54 bis 10.10. 13:24, ein Datensatz je Minute', RP.recs.length === RP.inputs.length && RP.inputs.length >= 4100, RP.recs.length);
    check('Replay ist reproduzierbar (zweiter Lauf bit-identisch: Datensaetze und Punkte)', RP.recs.join('\n') === RP2.recs.join('\n') && JSON.stringify(RP.scores) === JSON.stringify(RP2.scores), '');
    const q = RP.props.filter(p => p.rule === 'quiet_freigabe');
    check('Boost 10.10.: Quiet-Freigabe genau einmal, 08:36 (Soll 38 seit 08:25, 10 min Haltezeit), vor dem Klick des Nutzers 08:40:41', q.length === 1 && E.iso(q[0].ts) === '2026-10-10 08:36:00' && q[0].cmd.value === 0 && q[0].von === 3, q.map(p => E.iso(p.ts)).join(','));
    check('Boost: Vorschlag endet, sobald der Nutzer Quiet 0 setzt (08:42 im Minutenraster)', RP.events.some(e => e[0] === '2026-10-10 08:42:00' && e[1] === 'optimierer_ende' && /quiet_freigabe: Quiet steht auf 0/.test(e[2])), '');
    check('Kaltstarts 07.10. 20:18, 08.10. 09:33 und 17:18 (Rueckstand nur 15-24 min): keine Quiet-Freigabe; 08.10. 09:59 waere sie gesperrt gewesen (Quiet 2->3 von Hand um 09:38)', q.length === 1 && RP.recs.some(l => l.indexOf('"t":"2026-10-08 09:59:00"') >= 0 && /"id":"quiet_freigabe","v":1,"st":"gesperrt","grund":"würde schalten, aber gesperrt: Mindestabstand/.test(l)), '');
    check('Raumregel waehrend des Boosts gesperrt (Handeingriff Soll 38) und erst 60 min nach dem Boost wieder frei', RP.recs.some(l => l.indexOf('"t":"2026-10-10 09:13:00"') >= 0 && /Handeingriff/.test(l)) && !RP.props.some(p => p.rule === 'raum_offset' && p.ts >= new Date(2026, 9, 10, 8, 25).getTime() && p.ts < new Date(2026, 9, 10, 10, 25).getTime()), RP.props.filter(p => p.rule === 'raum_offset').map(p => E.iso(p.ts)).join(','));
    check('Laufzeit strecken: nie (Quiet 3 fast immer; bei Quiet 0 nur im Boost mit Raumbedarf ueber 22 Hz)', !RP.props.some(p => p.rule === 'quiet_strecken'), '');
    check('Kein Vorschlag mit aktiver Sperre und keiner ohne frische Daten', RP.recs.every(l => { const d = JSON.parse(l); return d.r.every(r => !(r.st === 'vorschlag' && r.sperren)); }), '');
    check('Messaufgabe Comfort/Efficiency: offen, Efficiency 41 min bei Quiet 0 (Boost, max 34 Hz), Comfort 0 min', (() => { const m = E.messStatus(RP.S); return m.offen && m.comfortMin === 0 && m.efficiencyMin >= 35 && m.efficiency.hzMax === 34; })(), E.messStatus(RP.S).text);
    check('Datensatzgroesse: unter 2,2 MB je Tag (ca. 60 MB/Monat)', RP.bytes / (RP.inputs.length / 1440) < 2.2e6, Math.round(RP.bytes / (RP.inputs.length / 1440)) + ' Bytes/Tag');
}

// ================================================================== (c) Node-RED-Huellen (opt_engine, opt_apply) und gesperrte Uebernahme, mit der erzeugten Flow-Datei
function applyPathProblems(nodes) {                                              // Strukturregeln des Sendewegs (wie in optimizer_sim.js), hier auch fuer verfaelschte Kopien
    const P = [], tab = nodes.filter(n => n.z === 'opt_tab'), outs = tab.filter(n => n.type === 'mqtt out');
    if (outs.length !== 1 || outs[0].id !== 'opt_apply_mqtt') { P.push('mqtt out im Tab: ' + outs.map(n => n.id).join(',')); }
    if (outs.some(n => n.d !== true)) { P.push('Uebernahme-Knoten nicht deaktiviert'); }
    if (tab.some(n => ['link out', 'link in', 'link call', 'http in', 'http response'].includes(n.type))) { P.push('Link/HTTP-Knoten im Tab'); }
    const feeders = nodes.filter(n => (n.wires || []).some(w => w.indexOf('opt_apply_mqtt') >= 0)).map(n => n.id);
    if (JSON.stringify(feeders) !== '["opt_apply"]') { P.push('mqtt out gespeist von ' + feeders.join(',')); }
    const toApply = nodes.filter(n => (n.wires || []).some(w => w.indexOf('opt_apply') >= 0)).map(n => n.id).sort();
    if (JSON.stringify(toApply) !== '["opt_i_apply","opt_t_eng_prop"]') { P.push('opt_apply gespeist von ' + toApply.join(',')); }
    const en = nodes.find(n => n.id === 'opt_engine');
    if (!en || /node\.send\s*\(/.test(en.func) || en.wires.some(w => w.some(id => /^opt_apply/.test(id)))) { P.push('opt_engine fuehrt zum Sendeweg'); }
    const ap = nodes.find(n => n.id === 'opt_apply');
    if (!ap || /node\.send\s*\(/.test(ap.func)) { P.push('opt_apply nutzt node.send'); }
    return P;
}
if (flowsFile) {
    console.log('--- (c) Huellen und gesperrte Uebernahme mit der Flow-Datei ' + flowsFile);
    const vm = require('vm');
    const NODES = JSON.parse(fs.readFileSync(flowsFile, 'utf8')), FN = {}; NODES.forEach(n => { if (n.type === 'function') { FN[n.id] = n.func; } });
    check('Flow-Datei: Huellen opt_engine/opt_apply enthalten den Kern unveraendert (Text identisch mit tools/engine_core.js)', ['opt_engine', 'opt_apply'].every(id => FN[id] && FN[id].indexOf(fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8')) === 0), '');
    check('Struktur des Sendewegs: genau ein deaktivierter mqtt out, nur von opt_apply, Eingaenge nur Karte + Takt', applyPathProblems(NODES).length === 0, applyPathProblems(NODES).join(' | '));
    const mut = (f) => { const c = JSON.parse(JSON.stringify(NODES)); f(c); return applyPathProblems(c); };
    check('Strukturpruefung schlaegt an: Knoten aktiviert / zweiter mqtt out / opt_engine direkt verdrahtet / Link im Tab', mut(c => { delete c.find(n => n.id === 'opt_apply_mqtt').d; }).length > 0 && mut(c => { c.push({id: 'opt_x', type: 'mqtt out', z: 'opt_tab', wires: []}); }).length > 0 && mut(c => { c.find(n => n.id === 'opt_engine').wires[4].push('opt_apply_mqtt'); }).length > 0 && mut(c => { c.push({id: 'opt_l', type: 'link out', z: 'opt_tab', wires: []}); }).length > 0, '');
    const tplP = NODES.find(n => n.id === 'opt_t_eng_prop'), grp = NODES.filter(n => n.type === 'ui_group' && n.tab === 'opt_eng_ui_tab');
    check('Seite "Optimierer": vier gleich breite Gruppen (18, Masonry-Falle vermieden), Karte mit Uebernehmen/Verwerfen/Zuruecksetzen/Sperren, Klick schickt nur ID + Pruefsumme', grp.length === 4 && grp.every(g => g.width === 18) && /send\(\{topic: 'uebernehmen', payload: \{id: msg\.payload\.prop\.id, sum: msg\.payload\.prop\.sum\}\}\)/.test(tplP.format) && /'verwerfen'/.test(tplP.format) && /'zuruecksetzen'/.test(tplP.format) && /'sperren'/.test(tplP.format) && /ng-disabled="!msg\.payload\.knopf\.ok"/.test(tplP.format), grp.map(g => g.name + ':' + g.width).join(', '));
    check('Seite "Optimierer": keine erklaerenden Hinweiszeilen (nur Daten, Status, Knoepfe)', !/class="note"|optq-note/.test(['opt_t_eng_prop', 'opt_t_eng_rules', 'opt_t_eng_score', 'opt_t_eng_log'].map(id => NODES.find(n => n.id === id).format).join('')), '');
    // ---- vm-Harness (wie optimizer_sim.js): Fake-Uhr, Speicher, Dateien
    let NOW = new Date(2026, 9, 12, 8, 0, 0).getTime();
    class FD extends Date { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
    let gstore = {}, fstores = {}, files = {}, warns = [];
    const fsm = {readFileSync: p => { if (!(p in files)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } return files[p]; }, writeFileSync: (p, d) => { files[p] = String(d); }, mkdirSync: () => {}, chmodSync: () => {}};
    const comp = {};
    const ctx = st => ({get: (k, s) => (s === 'file' ? undefined : st[k]), set: (k, v) => { st[k] = v; }});
    function runN(id, msg) {
        if (!comp[id]) { comp[id] = vm.runInNewContext('(function(msg,global,flow,context,env,node,fs,Date,Buffer){' + FN[id] + '\n})', {}); }
        fstores[id] = fstores[id] || {};
        const nd = {send: () => { throw new Error('node.send benutzt'); }, warn: m => warns.push(String(m)), error: () => {}, status: () => {}};
        const res = comp[id](msg, ctx(gstore), ctx(fstores[id]), ctx({}), {get: () => undefined}, nd, fsm, FD, Buffer);
        const fo = res && (id === 'opt_engine' ? res[4] : (id === 'opt_apply' ? res[2] : null));   // Datei-Knoten nachbilden (anhaengen)
        if (fo) { [].concat(fo).forEach(m => { if (m && m.filename) { files[m.filename] = (files[m.filename] || '') + m.payload; } }); }
        return res;
    }
    const restart = () => { fstores = {}; };                                         // Node-RED-Neustart: Flow-Kontext weg, Dateien bleiben (Speicher "file" ist hier nur memory)
    const cfgRooms = [{id: 'ki_oben', name: 'Kinderzimmer oben', active: true, min: 22, max: 23.5, maxAgeMin: 90}];
    function world(o) {                                                               // Anlagenwerte wie HeishaMoNR sie global ablegt (+ OPT_hp vom eigenen Abo)
        o = o || {};
        const hp = n => ({v: n, ts: NOW - 20000});
        gstore = Object.assign(gstore, {OPT_cfg: {rooms: cfgRooms, sensor: {maxAgeMin: 90}}, compressor_frequency: 16, TOP6_Main_Outlet_Temp: 30, TOP5_Main_Inlet_Temp: 28.25, TOP42_Z1_Water_Target_Temp: 38,
            TOP23_Heat_Delta: 3, TOP16_Heat_Energy_Consumption: 300, TOP1_Pump_Flow: 13.5, TOP18_Quiet_Mode_Level: 3, TOP14_Outside_Temp: 11, TOP26_Defrosting_State: 0, TOP20_ThreeWay_Valve_State: 0,
            F_SS: {state: 0}, compressor_runtime: 40, TOP27_Z1_Heat_Request_Temp: 0, TOP76_Heating_Mode: 0, TOP111_Z1_Sensor_Settings: 0, MQTT: {block_active: 0},
            Z1_Heat_Curve_Outside_Low_Temp: -13, Z1_Heat_Curve_Outside_High_Temp: 11, Z1_Heat_Curve_Target_Low_Temp: 29, Z1_Heat_Curve_Target_High_Temp: 38,
            OPT_rooms: {ki_oben: {ema: 21.2, ts: NOW - 10 * 60000}}, OPT_state: {ts: NOW, korr: 0, korrCode: 'x', korrLead: '', distrib: false},
            OPT_hp: {Quiet_Mode_Level: hp(o.q !== undefined ? o.q : 3), Pump_Speed: hp(1750), Heating_Control: hp(1), Z1_Heat_Request_Temp: hp(0), Heating_Off_Outdoor_Temp: hp(12), Main_Outlet_Temp: hp(30)}}, o.g || {});
        gstore.TOP18_Quiet_Mode_Level = o.q !== undefined ? o.q : 3;
    }
    function minute(n, hook) {                                                         // n Minuten: Engine jede Minute, Uebernahme-Takt alle 15 s
        const out = {eng: [], app: []};
        for (let i = 0; i < n; i++) {
            NOW += 60000; if (hook) { hook(i); }
            gstore.OPT_hp && Object.keys(gstore.OPT_hp).forEach(k => { gstore.OPT_hp[k].ts = NOW - 20000; });
            if (gstore.OPT_rooms && gstore.OPT_rooms.ki_oben) { gstore.OPT_rooms.ki_oben.ts = NOW - 10 * 60000; }
            if (gstore.OPT_state) { gstore.OPT_state.ts = NOW; }
            out.eng.push(runN('opt_engine', {topic: '', payload: NOW}));
            for (let k = 0; k < 4; k++) { NOW += k ? 15000 : 0; out.app.push(runN('opt_apply', {topic: 'tick', payload: NOW})); }
            NOW -= 45000;
        }
        return out;
    }
    const sends = outs => outs.app.filter(o => o && o[0]).map(o => o[0]);
    const click = (topic, payload) => runN('opt_apply', {topic: topic, payload: payload});
    // 1) Engine allein: Vorschlag entsteht, Dateien, globale Werte, ohne Klick nie ein Befehl
    world(); let R = minute(25);
    const eng = gstore.OPT_engine;
    check('Huelle: Vorschlag Quiet 3 -> 0 im Boost (Soll 38, 16 Hz), OPT_engine mit Vorschlag, Sperren, Rueckweg-Gruenden', eng && eng.prop && eng.prop.rule === 'quiet_freigabe' && eng.prop.cmd.value === 0 && eng.locks && eng.ende !== undefined, eng && eng.prop && eng.prop.id);
    const decFile = Object.keys(files).find(f => /decisions-2026-10\.jsonl$/.test(f));
    check('Huelle: decisions-YYYY-MM.jsonl bekommt jede Minute genau einen Datensatz', decFile && files[decFile].trim().split('\n').length === 25 && JSON.parse(files[decFile].trim().split('\n')[24]).vorschlag === eng.prop.id, decFile);
    check('Huelle: ohne Klick sendet nichts (25 min, 100 Takte der Uebernahme)', sends(R).length === 0 && R.eng.every(o => !o || !o[4] || o[4].every(m => /^\/data\/optimizer\//.test(m.filename))), '');
    check('Huelle: Karte zeigt den Vorschlag mit Pruefsumme, Knopf "Übernahme gesperrt" (Hauptschalter aus)', (() => { const c = R.eng[24][0].payload; return c.prop && c.prop.id === eng.prop.id && c.prop.sum === eng.prop.sum && c.knopf.ok === false && c.knopf.text === 'Übernahme gesperrt' && /gesperrt \(Hauptschalter aus\)/.test(c.uebernahme.text); })(), JSON.stringify(R.eng[24][0].payload.knopf));
    check('Huelle: Regeltabelle (4 Regeln mit Status, Grund, "würde schalten, sobald …"), Punkte-Karte, letzte Entscheidungen', R.eng[24][1].payload.rows.length === 4 && R.eng[24][1].payload.rows.some(r => /würde schalten, sobald/.test(r[3])) && R.eng[24][2].payload.rows.length === 4 && R.eng[24][3].payload.rows.length >= 4, '');
    check('Huelle schreibt nur OPT_*-Werte (keine Anlagen-/HeishaMoNR-Variable)', (() => { const before = JSON.stringify(Object.keys(gstore).filter(k => !/^OPT_/.test(k)).sort().map(k => [k, gstore[k]])); world(); minute(2); return JSON.stringify(Object.keys(gstore).filter(k => !/^OPT_/.test(k)).sort().map(k => [k, gstore[k]])) === before; })(), '');
    // 2) Klick bei Hauptschalter AUS
    let r = click('uebernehmen', {id: gstore.OPT_engine.prop.id, sum: gstore.OPT_engine.prop.sum});
    check('Klick, Hauptschalter AUS (keine apply.json): nichts gesendet, rote Meldung, Protokoll "abgelehnt"', !r[0] && r[1] && r[1].highlight === 'red' && /Hauptschalter/.test(r[1].payload) && /"ergebnis":"abgelehnt"/.test(r[2][0].payload), r[1] && r[1].payload);
    files['/data/optimizer/apply.json'] = '{"enabled": true, "rules": []}';
    r = click('uebernehmen', {id: gstore.OPT_engine.prop.id, sum: gstore.OPT_engine.prop.sum});
    check('Klick, Hauptschalter AN, Regel nicht freigegeben: nichts gesendet', !r[0] && /nicht freigegeben/.test(r[1].payload), r[1].payload);
    files['/data/optimizer/apply.json'] = '{"enabled": "ja", "rules": ["quiet_freigabe"]}';
    r = click('uebernehmen', {id: gstore.OPT_engine.prop.id, sum: gstore.OPT_engine.prop.sum});
    check('Hauptschalter nur bei enabled === true (Text "ja" zaehlt nicht)', !r[0] && /Hauptschalter/.test(r[1].payload), r[1].payload);
    files['/data/optimizer/apply.json'] = '{"enabled": true, "rules": ["quiet_freigabe"]}';
    r = click('uebernehmen', {id: gstore.OPT_engine.prop.id, sum: 'deadbeef'});
    check('falsche Pruefsumme: nichts gesendet', !r[0] && /Prüfsumme/.test(r[1].payload), r[1].payload);
    r = click('uebernehmen', {id: 'quiet_freigabe@2026-01-01T00:00', sum: gstore.OPT_engine.prop.sum});
    check('veralteter/fremder Vorschlag (andere ID): nichts gesendet', !r[0] && /nicht mehr aktuell/.test(r[1].payload), r[1].payload);
    r = click('uebernehmen', {id: gstore.OPT_engine.prop.id, sum: gstore.OPT_engine.prop.sum, topic: 'panasonic_heat_pump/commands/SetHeatingControl', value: 1});
    const sent1 = r[0];
    check('Klick + Hauptschalter AN + Regel frei: GENAU der Vorschlag wird gesendet (SetQuietMode = "0"), Zusatzfelder aus dem Browser werden ignoriert', sent1 && sent1.length === 1 && sent1[0].topic === 'panasonic_heat_pump/commands/SetQuietMode' && sent1[0].payload === '0' && sent1[0].retain === false, JSON.stringify(sent1));
    check('Quelle fuer Waechter/HeishaMoNR gesetzt: MQTT_Source = "Optimierer (Klick)"; Protokoll applied-YYYY-MM.jsonl mit ID, Pruefsumme, Wert, Hauptschalter', gstore.MQTT_Source === 'Optimierer (Klick)' && /"aktion":"uebernehmen","ergebnis":"gesendet".*"hauptschalter":true/.test(files['/data/optimizer/applied-2026-10.jsonl'] || ''), gstore.MQTT_Source);
    r = click('uebernehmen', {id: gstore.OPT_engine.prop.id, sum: gstore.OPT_engine.prop.sum});
    check('Doppelklick: zweiter Klick wird ignoriert, nichts gesendet', !r[0] && /Doppelklick/.test(r[1].payload), r[1].payload);
    // 3) Neustart mitten in der Uebernahme (vor der Bestaetigung) -> Zustand aus apply-state.json, Ruecklesen geht weiter, bestaetigt
    restart();
    gstore.OPT_hp.Quiet_Mode_Level.v = 0; gstore.TOP18_Quiet_Mode_Level = 0;
    R = minute(2);
    check('Neustart mitten in der Uebernahme: Zustand aus der Datei, Anlage meldet 0 -> bestaetigt, kein zweiter Befehl', sends(R).length === 0 && gstore.OPT_apply.aktiv && gstore.OPT_apply.aktiv.bestaetigt === true && gstore.OPT_apply.pending === null, JSON.stringify(gstore.OPT_apply.aktiv));
    // 4) Quiet-Freigabe hat keinen automatischen Rueckweg; Zuruecksetzen schickt die vorherige Stufe; danach bestaetigt
    R = minute(120);
    check('Quiet-Freigabe: kein automatischer Rueckweg (Quiet 0 ist Standard), auch nach 2 h', sends(R).length === 0 && gstore.OPT_apply.aktiv, '');
    r = click('zuruecksetzen', {});
    check('Zuruecksetzen: sendet Quiet 3 (vorherige Stufe), Quelle "Optimierer (Rückweg)"', r[0] && r[0].length === 1 && r[0][0].payload === '3' && gstore.MQTT_Source === 'Optimierer (Rückweg)', JSON.stringify(r[0]));
    gstore.OPT_hp.Quiet_Mode_Level.v = 3; gstore.TOP18_Quiet_Mode_Level = 3; R = minute(1);
    check('Rueckweg bestaetigt: Uebernahme beendet', !gstore.OPT_apply.aktiv && !gstore.OPT_apply.pending, '');
    // 5) Ruecklese-Timeout: Anlage reagiert nicht -> 2 Wiederholungen (90 s Abstand), dann Warnung; insgesamt 3 Befehle
    NOW += 2 * 3600000; world(); minute(15);                                         // > 60 min nach der letzten Quiet-Aenderung (Mindestabstand)
    const p2 = gstore.OPT_engine.prop;
    r = click('uebernehmen', {id: p2.id, sum: p2.sum});
    R = minute(8);
    check('Ruecklese-Timeout: Anlage bleibt bei 3 -> 2 Wiederholungen, dann rote Warnung, insgesamt 3 Befehle, danach Ruhe', r[0] && sends(R).length === 2 && gstore.OPT_apply.alarm && /Keine Bestätigung/.test(gstore.OPT_apply.alarm.text) && !gstore.OPT_apply.pending, sends(R).length + ' Wiederholungen, ' + (gstore.OPT_apply.alarm && gstore.OPT_apply.alarm.text));
    // 6) Notbremse und Sperren
    files['/data/optimizer/apply-state.json'] = JSON.stringify(E.newApply()); restart(); NOW += 2 * 3600000; world(); minute(15);
    gstore.MQTT.block_active = 1;
    r = click('uebernehmen', {id: gstore.OPT_engine.prop ? gstore.OPT_engine.prop.id : 'x', sum: gstore.OPT_engine.prop ? gstore.OPT_engine.prop.sum : 'x'});
    check('Notbremse MQTT.block_active: Klick sendet nichts (Vorschlag ist zudem gesperrt)', !r[0], r[1] && r[1].payload);
    gstore.MQTT.block_active = 0; minute(12);
    r = click('sperren', {});
    check('"Übernahme sperren" (Not-Aus im Dashboard): apply.json enabled=false, Regeln bleiben, OPT_apply_enabled false', JSON.parse(files['/data/optimizer/apply.json']).enabled === false && JSON.parse(files['/data/optimizer/apply.json']).rules[0] === 'quiet_freigabe' && gstore.OPT_apply_enabled === false, files['/data/optimizer/apply.json']);
    r = click('uebernehmen', {id: p2.id, sum: p2.sum});
    check('nach dem Sperren: Klick sendet nichts', !r[0] && /Hauptschalter/.test(r[1].payload), r[1].payload);
    // 7) Verwerfen: blendet aus, sendet nichts, Punkte bleiben unberuehrt
    NOW += 3 * 3600000; world(); minute(15);
    const scoreBefore = JSON.stringify(E.report(fstores.opt_engine.eng.S));
    r = click('verwerfen', {id: gstore.OPT_engine.prop.id});
    R = minute(1);
    check('Verwerfen: nichts gesendet, Karte zeigt "Kein Vorschlag" mit Vermerk, Punktebuch unveraendert', !r[0] && R.eng[0][0].payload.prop === null && R.eng[0][0].payload.naechste[0][0] === 'Verworfen' && JSON.stringify(E.report(fstores.opt_engine.eng.S)) === scoreBefore, JSON.stringify(R.eng[0][0].payload.naechste[0]));
    // 8) Raumoffset mit automatischem Rueckweg nach Ablauf (6 h); Whitelist-Grenzen
    files['/data/optimizer/apply.json'] = '{"enabled": true, "rules": ["raum_offset"]}';
    files['/data/optimizer/apply-state.json'] = JSON.stringify(E.newApply()); restart(); NOW += 3 * 3600000;
    world({g: {TOP42_Z1_Water_Target_Temp: 30, TOP6_Main_Outlet_Temp: 30.5, OPT_state: {ts: NOW, korr: 1, korrCode: 'Raum unter Minimum', korrLead: 'Kinderzimmer oben', distrib: false}}});
    minute(75);
    const p3 = gstore.OPT_engine.prop;
    r = click('uebernehmen', {id: p3 && p3.id, sum: p3 && p3.sum});
    check('Raumoffset: Klick sendet SetZ1HeatRequestTemperature = 1', p3 && p3.rule === 'raum_offset' && r[0] && r[0][0].topic === 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature' && r[0][0].payload === '1', p3 ? p3.id : 'kein Vorschlag');
    gstore.OPT_hp.Z1_Heat_Request_Temp.v = 1; gstore.TOP27_Z1_Heat_Request_Temp = 1; gstore.TOP42_Z1_Water_Target_Temp = 31;
    R = minute(6 * 60 + 2, () => { gstore.OPT_state.korr = 1; const pa = gstore.OPT_apply && gstore.OPT_apply.pending; if (pa && pa.art === 'rueckweg') { gstore.OPT_hp.Z1_Heat_Request_Temp.v = 0; gstore.TOP27_Z1_Heat_Request_Temp = 0; } });   // Anlage bestaetigt den Rueckweg
    const back = sends(R);
    check('Raumoffset: automatischer Rueckweg nach 6 h (gehoert zum geklickten Vorschlag): genau ein Befehl SetZ1HeatRequestTemperature = 0, bestaetigt, Uebernahme beendet', back.length === 1 && back[0][0].payload === '0' && !gstore.OPT_apply.aktiv, JSON.stringify(back));
    // 9) Whitelist/Wertebereich direkt am Kern (verfaelschte Vorschlaege in OPT_engine)
    const forge = (cmd, value, art) => { const pp = JSON.parse(JSON.stringify(gstore.OPT_engine.prop || p3)); pp.cmd = {name: cmd, topic: 'panasonic_heat_pump/commands/' + cmd, value: value}; pp.art = art || 'befehl'; pp.von = gstore.TOP27_Z1_Heat_Request_Temp; pp.bis = NOW + 600000; pp.sum = E.checksum(pp); return E.applyRequest(null, {topic: 'uebernehmen', payload: {id: pp.id, sum: pp.sum}}, {now: NOW, enabled: true, rules: [pp.rule], eng: {ts: NOW, prop: pp, locks: {}}, plant: {q: 3, shift: pp.von, hpAge: 0.3, block: 0, heatMode: 0, z1Sensor: 0}}); };
    check('Whitelist: SetHeatingControl wird abgelehnt (nie Comfort/Efficiency)', forge('SetHeatingControl', 1).send.length === 0 && /nicht auf der Whitelist/.test(forge('SetHeatingControl', 1).toast.text), forge('SetHeatingControl', 1).toast.text);
    check('Whitelist: SetMaxPumpDuty steht nicht darauf (Pumpenlimit sitzt auf dem Mainboard; kein Vorschlag/Befehl)', !E.WHITELIST.SetMaxPumpDuty && forge('SetMaxPumpDuty', 94).send.length === 0 && !E.RULES.some(R0 => /Pump/.test(R0.befehl.name)), '');
    check('Wertebereich: Verschiebung +2 K abgelehnt (nur -1..+1)', forge('SetZ1HeatRequestTemperature', 2).send.length === 0 && /nicht erlaubt/.test(forge('SetZ1HeatRequestTemperature', 2).toast.text), forge('SetZ1HeatRequestTemperature', 2).toast.text);
    check('Hinweis-Regel (Heizgrenze) nie per Klick', forge('SetHeatingOffOutdoorTemp', 10, 'hinweis').send.length === 0, forge('SetHeatingOffOutdoorTemp', 10, 'hinweis').toast.text);
    const old = (() => { const pp = JSON.parse(JSON.stringify(p3)); pp.bis = NOW + 600000; pp.sum = E.checksum(pp); return E.applyRequest(null, {topic: 'uebernehmen', payload: {id: pp.id, sum: pp.sum}}, {now: NOW, enabled: true, rules: ['raum_offset'], eng: {ts: NOW - 5 * 60000, prop: pp, locks: {}}, plant: {shift: 0, hpAge: 0.3, block: 0, heatMode: 0, z1Sensor: 0}}); })();
    check('Alter: Entscheidungsmaschine rechnet seit 5 min nicht -> abgelehnt', old.send.length === 0 && /nicht gerechnet/.test(old.toast.text), old.toast.text);
    const exp = (() => { const pp = JSON.parse(JSON.stringify(p3)); pp.bis = NOW - 1; pp.sum = E.checksum(pp); return E.applyRequest(null, {topic: 'uebernehmen', payload: {id: pp.id, sum: pp.sum}}, {now: NOW, enabled: true, rules: ['raum_offset'], eng: {ts: NOW, prop: pp, locks: {}}, plant: {shift: 0, hpAge: 0.3, block: 0, heatMode: 0, z1Sensor: 0}}); })();
    check('Gueltigkeit: abgelaufener Vorschlag -> abgelehnt', exp.send.length === 0 && /abgelaufen/.test(exp.toast.text), exp.toast.text);
    const stale = (() => { const pp = JSON.parse(JSON.stringify(p3)); pp.bis = NOW + 600000; pp.sum = E.checksum(pp); return E.applyRequest(null, {topic: 'uebernehmen', payload: {id: pp.id, sum: pp.sum}}, {now: NOW, enabled: true, rules: ['raum_offset'], eng: {ts: NOW, prop: pp, locks: {}}, plant: {shift: 0, hpAge: 7, block: 0, heatMode: 0, z1Sensor: 0}}); })();
    check('frische Daten: HeishaMon 7 min alt -> abgelehnt', stale.send.length === 0 && /veraltet/.test(stale.toast.text), stale.toast.text);
    const moved = (() => { const pp = JSON.parse(JSON.stringify(p3)); pp.bis = NOW + 600000; pp.sum = E.checksum(pp); return E.applyRequest(null, {topic: 'uebernehmen', payload: {id: pp.id, sum: pp.sum}}, {now: NOW, enabled: true, rules: ['raum_offset'], eng: {ts: NOW, prop: pp, locks: {}}, plant: {shift: -1, hpAge: 0.3, block: 0, heatMode: 0, z1Sensor: 0}}); })();
    check('Abgleich mit dem Ist-Zustand: Anlage steht nicht mehr auf dem Ausgangswert -> abgelehnt', moved.send.length === 0 && /steht nicht mehr auf 0/.test(moved.toast.text), moved.toast.text);
    // Rate und Tageslimit
    let A = null, ns = 0; const pp0 = JSON.parse(JSON.stringify(p3));
    for (let k = 0; k < 10; k++) { const pp = Object.assign({}, pp0, {id: 'raum_offset@x' + k, ts: NOW, bis: NOW + 3600000, von: 0}); pp.sum = E.checksum(pp); const rr = E.applyRequest(A, {topic: 'uebernehmen', payload: {id: pp.id, sum: pp.sum}}, {now: NOW, enabled: true, rules: ['raum_offset'], eng: {ts: NOW, prop: pp, locks: {}}, plant: {shift: 0, hpAge: 0.3, block: 0, heatMode: 0, z1Sensor: 0}}); A = rr.A; ns += rr.send.length; A.pending = null; A.aktiv = null; NOW += (k === 0 ? 5 : 11) * 60000; }
    check('Rate (10 min Abstand) und Tageslimit (6 Befehle/Tag)', ns === 6 && A.n === 6, 'gesendet ' + ns);
    // fremde Aenderung nach Bestaetigung: Warnung, kein automatischer Rueckweg
    let A2 = E.newApply(); A2.aktiv = {id: 'x', rule: 'raum_offset', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: 1, von: 0, ts: NOW, bis: NOW + 3600000, bestaetigt: true};
    const fr = E.applyTick(A2, {now: NOW, plant: {shift: -1, hpAge: 0.3, block: 0}});
    check('fremde Aenderung nach der Bestaetigung: Warnung, Uebernahme beendet, KEIN Befehl', fr.send.length === 0 && /von außen/.test(fr.toast.text) && fr.A.aktiv === null, fr.toast.text);
    // Notbremse waehrend Wiederholung/Rueckweg: wartet, zaehlt nicht
    let A3 = E.newApply(); A3.pending = {name: 'SetQuietMode', value: 0, ts: NOW - 200000, versuche: 1, art: 'uebernahme', id: 'y'}; A3.aktiv = {id: 'y', rule: 'quiet_freigabe', groesse: 'quiet', name: 'SetQuietMode', value: 0, von: 3, ts: NOW, bis: null};
    const bl = E.applyTick(A3, {now: NOW, plant: {q: 3, hpAge: 0.3, block: 1}});
    check('Notbremse waehrend der Wiederholung: kein Befehl, Versuch nicht verbraucht', bl.send.length === 0 && bl.A.pending.versuche === 1, JSON.stringify(bl.A.pending));
    let A4 = E.newApply(); A4.aktiv = {id: 'z', rule: 'quiet_strecken', groesse: 'quiet', name: 'SetQuietMode', value: 3, von: 0, ts: NOW - 5 * 3600000, bis: NOW - 1, bestaetigt: true};
    check('Rueckweg wartet bei Notbremse, kommt danach', E.applyTick(JSON.parse(JSON.stringify(A4)), {now: NOW, plant: {q: 3, hpAge: 0.3, block: 1}}).send.length === 0 && E.applyTick(A4, {now: NOW, plant: {q: 3, hpAge: 0.3, block: 0}}).send[0].payload === '0', '');
    // Rueckweg, weil der Grund endet (Raumvorschlag wieder 0): nur nach Bestaetigung, genau ein Befehl
    let A5 = E.newApply(); A5.aktiv = {id: 'r', rule: 'raum_offset', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: 1, von: 0, ts: NOW - 3600000, bis: NOW + 3600000, bestaetigt: true};
    const en5 = E.applyTick(A5, {now: NOW, plant: {shift: 1, hpAge: 0.3, block: 0}, endReason: {raum_offset: 'Raumvorschlag ist wieder 0 K'}});
    check('Rueckweg, wenn der Grund endet (Raumvorschlag 0): ein Befehl zurueck auf 0 mit Grund im Protokoll', en5.send.length === 1 && en5.send[0].payload === '0' && /Raumvorschlag ist wieder 0 K/.test(en5.log[0].grund), JSON.stringify(en5.log[0]));
    // Lange Fahrt mit Hauptschalter AN und ALLEN Regeln freigegeben, aber ohne Klick: nie ein Befehl
    files['/data/optimizer/apply.json'] = '{"enabled": true, "rules": ["quiet_freigabe", "quiet_strecken", "raum_offset"]}';
    files['/data/optimizer/apply-state.json'] = JSON.stringify(E.newApply()); restart(); NOW += 3600000; world();
    let nProp = 0, nSend = 0;
    for (let h = 0; h < 36; h++) {
        const Rh = minute(60, i => { const boost = (h % 6) === 2; gstore.TOP42_Z1_Water_Target_Temp = boost ? 38 : 30; gstore.TOP6_Main_Outlet_Temp = boost ? 30 : 30.5; gstore.TOP5_Main_Inlet_Temp = boost ? 28.25 : 28; gstore.OPT_state.korr = (h % 8) < 4 ? 1 : 0; gstore.OPT_state.korrLead = 'Kinderzimmer oben'; });
        nSend += sends(Rh).length; nProp += Rh.eng.filter(o => o && o[0] && o[0].payload.prop).length;
    }
    check('36 h mit Hauptschalter AN und allen Regeln freigegeben, Vorschlaege in ' + nProp + ' Minuten, aber ohne Klick: kein einziger Befehl (es gibt keinen automatischen Sendeweg)', nProp > 0 && nSend === 0, 'Befehle ' + nSend);
    check('kein node.send in den Huellen und Warnungen nur erwartbare', !warns.some(w => /node\.send|TypeError|ReferenceError/.test(w)), warns.slice(0, 3).join(' | '));
}

module.exports = {check: check, inp: inp, rooms: rooms, runSeq: runSeq, plantSim: plantSim, T0: T0, applyPathProblems: applyPathProblems};
if (require.main === module) {
    console.log('\nERGEBNIS engine_sim: ' + oks + ' OK, ' + fails + ' FAIL');
    process.exit(fails ? 1 : 0);
}

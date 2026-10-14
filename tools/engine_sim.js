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
check('Regelwerk (Review-Paket 13.10.2026): 4 Regeln mit ID, Version, Zweck, Eingaengen, Schwellen (Standard, Einheit, Herkunft), Sperren, Befehl, Erwartung, Rueckweg, Prognose; der Heizgrenze-Hinweis ist stillgelegt (nicht im Regelwerk, mit Grund in STILLGELEGT)',
      E.RULES.length === 4 && !E.RULE.heizgrenze_hinweis && E.STILLGELEGT.length === 1 && E.STILLGELEGT[0].id === 'heizgrenze_hinweis' && /COP/.test(E.STILLGELEGT[0].grund) && E.RULES.every(R => R.id && R.ver >= 1 && R.zweck && R.eingaenge.length && R.schwellen.length && R.schwellen.every(s => s.key && typeof s.std === 'number' && s.einheit && s.herkunft) && R.sperren.length && R.befehl.topic && R.erwartung && R.rueckweg && R.prognose.p > 0 && R.prognose.h.length),
      E.RULES.map(R => R.id + ' v' + R.ver).join(', '));
check('Regelwerk: keine Regel stellt die Heizregelung (Comfort/Efficiency); kein Befehl SetHeatingControl im Kern', !E.RULES.some(R => /HeatingControl/.test(R.befehl.name)) && !/SetHeatingControl/.test(fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8')), '');
check('Regelwerk: jede Sperre der Regeln ist definiert und hat eine Herkunft', E.RULES.every(R => R.sperren.every(id => E.LOCKS.some(l => l.id === id && l.herkunft))), '');
check('Standardwerte entstehen aus dem Regelwerk (eine Quelle)', E.defaults().rules.quiet_freigabe.rlRueckK === 1.5 && E.defaults().rules.quiet_strecken.hzHoch === 22 && E.defaults().rules.raum_offset.minVlC === 29 && E.defaults().locks.stopK === 3.25 && E.defaults().locks.quietGegenMin === 240, '');
check('Konfiguration: nur bekannte Schwellen, Zahlen werden uebernommen, Unsinn verworfen', (() => { const c = E.mergeCfg({rules: {quiet_freigabe: {rlRueckK: '1.8', foo: 1, haltMin: 'x', capHz: 18}}, locks: {gapMin: 30}}); return c.rules.quiet_freigabe.rlRueckK === 1.8 && c.rules.quiet_freigabe.foo === undefined && c.rules.quiet_freigabe.capHz === undefined && c.rules.quiet_freigabe.haltMin === 10 && c.locks.gapMin === 30; })(), '');
check('Doku aktuell: docs/OPTIMIERER.md enthaelt die aus dem Regelwerk erzeugten Tabellen unveraendert (node tools/engine_doc.js)', (() => { const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'OPTIMIERER.md'), 'utf8'), m = /<!-- ENGINE-TABELLEN -->\n([\s\S]*?)\n<!-- \/ENGINE-TABELLEN -->/.exec(doc); return !!m && m[1] === require('./engine_doc.js').tabellen(); })(), '');
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
    check('Vorschlag (v2): Befehl SetQuietMode = 0 (Notfall: Raum 0,8 K unter Minimum ohne Messdaten fuer Quiet 1/2 -> direkt Quiet 0, Nutzer vorlaeufig), von 3, Begruendung mit Zahlen, Bedarf und Ziel, Erwartung, Gueltig bis, automatischer Rueckweg auf die Ausgangsstufe (Frist 4 h), Pruefsumme', p && p.cmd.name === 'SetQuietMode' && p.cmd.value === 0 && p.von === 3 && /16 Hz am Deckel von Quiet 3, Vorlauf 8,0 K und Rücklauf 6,8 K unter Soll/.test(p.warum) && /Bedarf: Kinderzimmer oben 0,8 K unter Minimum/.test(p.warum) && /Ziel: Quiet 0, Notfall \(Kinderzimmer oben 0,8 K unter Minimum\); Quiet 2: 0 von 60 min Daten; Quiet 1: 0 von 60 min Daten/.test(p.warum) && /≥ 25 Hz binnen 5 min/.test(p.erwartung) && p.bis === p.ts + 30 * MIN && /^Automatisch zurück auf die Ausgangsstufe, sobald der Bedarf 15 min am Stück gedeckt ist/.test(p.rueckweg) && p.maxDauerMin === 240 && p.sum === E.checksum(p), p && (p.was + ' | ' + p.warum));
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
    { const R = runSeq(25, i => boost(i, {q: i < 5 ? 2 : 3, rooms: rooms({ki_oben: 21.8})})); const r = r0(R.outs[24], 'quiet_freigabe'); check('Sperre Mindestabstand: Quiet wurde vor 20 min geaendert (60 min Abstand; Raum 0,2 K unter Minimum = Bedarf ohne Notfall)', r.st === 'gesperrt' && /Mindestabstand.*letzte Änderung/.test(r.grund) && r.naechste.bis === T0 + 5 * MIN + 60 * MIN, r.grund); }
    { const R = runSeq(25, i => boost(i, {q: i < 5 ? 2 : 3})), f = R.outs.findIndex(o => r0(o, 'quiet_freigabe').neu), r12 = r0(R.outs[12], 'quiet_freigabe');
      check('Notfall (Raum 0,8 K unter Minimum) ueberbrueckt den Mindestabstand nach 10 min (Regel-Review B4): Quiet von Hand in Minute 5 -> gesperrt bis Minute 15, Vorschlag in Minute 15', f === 15 && r12.st === 'gesperrt' && /Mindestabstand.*\(Notfall\)/.test(r12.grund) && r12.naechste.bis === T0 + 15 * MIN, f + ' · ' + r12.grund); }
    { const R = runSeq(25, i => boost(i, {vl: 30, soll: 28.5, rl: 28.25})); const r = r0(R.outs[24], 'quiet_freigabe'); check('Takt-Gefahr: Vorlauf ueber Soll -> keine Freigabe (Bedingung Rueckstand fehlt sowieso)', r.st === 'bereit', r.grund); }
    // Lauf seit 5 min: laufbeginn ist zugleich Bedingung
    { const R = runSeq(25, i => boost(i, i < 22 ? {hz: 0, rt: 0, pump: 1750} : {rt: i - 22})); const r = r0(R.outs[24], 'quiet_freigabe'); check('Startphase: Lauf erst 2 min -> "bereit: Startphase", keine Haltezeit', r.st === 'bereit' && /Startphase: Lauf erst 2 von 15 min/.test(r.grund), r.grund); }
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
    check('Neustart (Zustand aus Datei): Anlauf-Sperre 10 min zieht den Vorschlag zurueck; der Notfall (Raum 0,8 K unter Minimum) schlaegt nach der Sperre wieder vor (Wartezeit fuer Notfall 10 min, Regel-Review B4); Tageszaehler (nur uebernommene, R5) bleibt 0', A.outs[24].prop && r0(B.outs[0], 'quiet_freigabe').st === 'gesperrt' && /Neustart/.test(r0(B.outs[0], 'quiet_freigabe').grund) && B.outs[14].prop && B.outs[14].prop.rule === 'quiet_freigabe' && B.S.rules.quiet_freigabe.n === 0, r0(B.outs[14], 'quiet_freigabe').st + ' n=' + B.S.rules.quiet_freigabe.n);
    // Tageslimit 3, Wechsel um Mitternacht setzt zurueck
    let S = null, props = 0, propsU = 0, qx = 3, nA = [], gT = ''; const d0 = new Date(2026, 9, 12, 14, 0, 0).getTime(), cT = E.mergeCfg({rules: {quiet_freigabe: {proTag: 2}}});
    for (let i = 0; i < 12 * 60; i++) {                   // alle 100 min: 40 min Lage (Boost, Raum 0,2 K unter Minimum = kein Notfall), dann 60 min ohne Lage, Quiet zurueck auf 3
        const cyc = i % 100, t = d0 + i * MIN; if (cyc === 0) { qx = 3; }
        const o2 = E.step(S, inp(t, {rt: 20 + cyc, soll: cyc < 40 ? 38 : 30, vl: cyc < 40 ? 30 : 31, rl: 28.25, rooms: rooms({ki_oben: 21.8}), q: qx, hz: qx === 3 ? 16 : 22}), cT); S = o2.S;
        if (r0(o2, 'quiet_freigabe').locks.indexOf('tageslimit') >= 0 && E.ymd(t) === '2026-10-12') { gT = 'tageslimit ' + E.iso(t).slice(11, 16); }
        o2.res.filter(r => r.neu && r.id === 'quiet_freigabe').forEach(() => { props++; if (E.ymd(t) === '2026-10-12' && i < 300) { propsU++; } });
        if (o2.prop && o2.prop.rule === 'quiet_freigabe' && i >= 300) { qx = o2.prop.cmd.value; }      // ab 19:00 uebernimmt der Nutzer jeden Vorschlag
        nA.push(S.rules.quiet_freigabe.n);
    }
    check('Tageslimit (hier 2 Uebernahmen je Tag; Regel-Review R5): Vorschlaege ohne Uebernahme zaehlen nicht (14:00-19:00 ' + propsU + ' Vorschlaege, Zaehler 0); ab 19:00 zaehlt jede Uebernahme, nach 2 Uebernahmen "Tageslimit … übernommen" am 12.10.; um Mitternacht zurueck auf 0',
          propsU >= 3 && nA[299] === 0 && Math.max.apply(null, nA.slice(0, 600)) === 2 && /^tageslimit/.test(gT) && S.rules.quiet_freigabe.day === '2026-10-13' && nA[nA.length - 1] <= 2, 'Vorschlaege ' + props + ' (vor 19:00 ' + propsU + '), Zaehler ' + nA[299] + '/' + Math.max.apply(null, nA.slice(0, 600)) + ', ' + gT + ', Tag ' + S.rules.quiet_freigabe.day);
    // Zeitumstellung 25.10.2026 (03:00 -> 02:00): Minutenschritte in ms, Datensatzzeit lokal, kein Fehler
    let Sd = null, errD = null; const dst = new Date(2026, 9, 25, 0, 0, 0).getTime(), ts = [];
    try { for (let i = 0; i < 300; i++) { const o3 = E.step(Sd, inp(dst + i * MIN, {rt: i}), cfg); Sd = o3.S; ts.push(o3.rec.t); } } catch (e) { errD = e; }
    check('Zeitumstellung 25.10.: 300 Minuten ohne Fehler, Uhrzeit 02:xx kommt zweimal vor (lokale Zeit im Datensatz), Laufzeit monoton', errD === null && ts.filter(t => t.slice(11, 13) === '02').length === 120, errD ? errD.message : ts.filter(t => t.slice(11, 13) === '02').length + ' Minuten mit 02 Uhr');
}

// ------------------------------------------------------------------ Mehrtages-Simulation mit einfachem Anlagenmodell (Takt, Kaltstart, Boost, Abtauen, Sensorausfall, Neustarts)
// Spielzeug-Physik, nur fuer Ablauf und Sicherheit (nicht fuer Aussagen ueber die Anlage): Wasserkreis 0,4 kWh/K, Heizkoerper 0,25 kW/K, Haus UA 0,18 kW/K, 8 kWh/K,
// innere Gewinne 0,9 kW (Opus 09.10.: 0,5-0,9 kW); Mindestleistung 2,1 kW deckt den Bedarf bis ~6 °C (wie gemessen: bei 4-6 °C Dauerlauf am Minimum).
// Nur zur Auswertung (SIM_BASIS=1): Basisrate "bleibt, wie es ist" je Regel und Horizont gegen die Prognose p (Falle p < b: ein Treffer punktet negativ)
function basisBericht(name, L) {
    if (!process.env.SIM_BASIS || !L || !L.S) { return; }
    console.log('    [Basisraten ' + name + '] ' + E.RULES.map(R => { const B = L.S.sc.base[R.basis || R.id] || {}; return R.id + ' p ' + R.prognose.p + ': ' + R.prognose.h.map(h => h + ' min ' + (B[h] ? B[h][1] + '/' + B[h][0] + ' b ' + E.de(B[h][0] >= E.SCORE.baseMinN ? (B[h][1] + 1) / (B[h][0] + 2) : 0.5, 2) + ((B[h][0] >= E.SCORE.baseMinN ? (B[h][1] + 1) / (B[h][0] + 2) : 0.5) > R.prognose.p ? ' > p' : '') : '–')).join(', '); }).join(' | '));
    console.log('    [Bericht ' + name + '] ' + E.report(L.S).map(r => r.regel + ' ' + (r.punkte === null ? '–' : r.punkte) + ' P, ' + r.faelle + ' F (' + r.treffer + ' T/' + r.fehlalarm + ' FA), Skill ' + (r.skill === null ? '–' : r.skill)).join(' | '));
    const tr = L.scores.filter(x => x.typ === 'ausloeser' && x.ergebnis === 'treffer' && x.punkte < 0);
    console.log('    [Faelle ' + name + '] ' + (L.scores.filter(x => x.typ === 'ausloeser' && !E.RULE[x.regel].art.indexOf('befehl')).map(x => x.fall + ' ' + x.ergebnis + ' ' + x.punkte + ' (' + x.horizonte.map(h => (h.o === null ? '–' : h.o) + '/b ' + h.b + (h.bp ? ' ' + h.bp : '')).join(', ') + ')').join(' | ') || 'keine'));
    console.log('    [Treffer mit Minuspunkten ' + name + '] ' + (tr.map(x => x.fall + ' ' + x.punkte + ' (b ' + x.horizonte.map(h => h.b).join('/') + ')').join(', ') || 'keine'));
}
function plantSim(days, opts) {
    opts = opts || {};
    const P = {on: false, tw: 31, room: 22.3, over: 0, under: 0, q: opts.q !== undefined ? opts.q : 3, shift: 0, rt: 0, sollHand: null, defrost: 0};
    let S = opts.S0 || null; const log = {props: [], recs: 0, ev: [], scores: [], lockedProp: 0, maxSendable: 0, errors: 0, minutes: 0, statuses: {}, starts: 0, grund: {}};
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
        const hzS = opts.hzStart && P.on && P.q === 0 && P.rt < opts.hzStart;                  // opts.hzStart: nach jedem Start so viele Minuten 26 Hz ohne Bedarf (Uebersteuern, wie 10.10.)
        const hz = !P.on ? 0 : (P.defrost > 0 ? 17 : (hzS ? 26 : (P.q >= 1 ? 16 + (i % 2) : (rlRueck >= 2.5 ? 33 : 17))));
        const pth = !P.on ? 0 : (P.defrost > 0 ? -1000 : (hz >= 30 ? 5000 : (hzS ? (opts.pthStart || 3000) : 2100))), qrad = 0.25 * (P.tw - P.room);
        P.tw += ((pth / 1000) - qrad) / 0.4 / 60; P.room += (qrad - 0.18 * (P.room - at) + 0.9) / 8 / 60;
        if (P.defrost > 0) { P.defrost--; }
        if (P.on) { P.rt++; if (vl >= soll + 3.25) { P.over++; } else { P.over = 0; } if (P.over >= 3) { P.on = false; P.rt = 0; P.over = 0; } }
        else { if (vl <= soll - 3) { P.under++; } else { P.under = 0; } if (P.under >= 6 && at < 15) { P.on = true; P.under = 0; log.starts++; } }
        const stale = opts.staleFrom !== undefined && i >= opts.staleFrom && i < opts.staleFrom + 30;
        const korrV = P.room < 21.7 ? 1 : (P.room > 23.6 ? -1 : 0);
        const x = {t: t, hpAge: stale ? 12 : 0.4, hz: hz, vl: vl, rl: rl, soll: soll, dT: 3, pel: hz >= 30 ? 830 : (hzS ? (opts.pelStart || 520) : (P.on ? 300 : 15)), pth: pth, flow: 13.5, pump: P.on || at < 15 ? 1750 : 0,
                   q: P.q, qPrio: 1, hc: 1, at: atI, defrost: P.defrost > 0 ? 1 : 0, dhw: 0, ss: 0, rt: P.rt, shift: P.shift, heatMode: 0, z1Sensor: 0, heaterI: 0, heaterE: 0, htrOnAT: 0, htrStartDelta: -3,
                   heatOffAT: 12, sollKurve: kurve, block: opts.block && i % 700 < 30 ? 1 : 0, otherQ: null, otherShift: null, kzRad: 1,
                   rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: Math.round(P.room * 10) / 10, age: 20, min: 22, max: 23.5, valid: !stale, active: true}],
                   korr: {v: korrV, code: korrV ? 'Raum ausserhalb' : 'alle im Band', distrib: false, lead: 'Kinderzimmer oben'}};
        if (opts.restartEvery && i > 0 && i % opts.restartEvery === 0 && S) { S = JSON.parse(JSON.stringify(S)); S.born = t; }
        try {
            const o = E.step(S, x, opts.cfg || cfg); S = o.S; log.recs++; log.minutes++;
            o.res.forEach(r => { log.statuses[r.st] = (log.statuses[r.st] || 0) + 1; if (r.neu) { log.props.push(S.rules[r.id].prop); if (r.locks.length) { log.lockedProp++; } } if (opts.grund === r.id) { log.grund[r.grund] = (log.grund[r.grund] || 0) + 1; } });
            if (opts.applyStrecken && o.prop && o.prop.rule === 'quiet_strecken' && o.prop.cmd.value !== P.q) { P.q = o.prop.cmd.value; P.qBis = i + 240; P.qVon = o.prop.von; }   // "Nutzer klickt", Rueckweg nach 4 h
            if (P.qBis && i >= P.qBis) { P.q = P.qVon; P.qBis = 0; }
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
    check('... Quiet-Freigabe v2 im milden Takt nie: kein Bedarf (Raeume im Band, kein Heizstab-Risiko, kein Boost); v1 schlug hier bei Sollspruengen und langsamen Anlaeufen vor ("Sollvorlauf noch nicht erreicht")', aq.length === 0, aq.map(p => E.iso(p.ts) + ' ' + p.warum).join(' | '));
    const B = plantSim(3, {at: 9, boostAt: 9 * 60});
    const bq = B.props.filter(p => p.rule === 'quiet_freigabe');
    const inBoost = p => { const m = new Date(p.ts).getHours() * 60 + new Date(p.ts).getMinutes(); return m >= 9 * 60 + 10 && m <= 10 * 60; };
    check('3 Tage mit taeglichem Boost von Hand (Soll 38 fuer 60 min, Quiet 3): an jedem Boost-Tag eine Quiet-Freigabe 10-60 min nach Boost-Beginn', ['2026-10-14', '2026-10-15', '2026-10-16'].every(day => bq.some(p => E.iso(p.ts).slice(0, 10) === day && inBoost(p))), bq.map(p => E.iso(p.ts)).join(', '));
    check('... Raumregel waehrend des Boosts gesperrt (Handeingriff), nie ein Raum-Vorschlag mit Soll 38', !B.props.some(p => p.rule === 'raum_offset' && /38/.test(p.was)), B.props.filter(p => p.rule === 'raum_offset').map(p => p.was).join(' | '));
    const C = plantSim(3, {at: 9, boostAt: 9 * 60, applyQuiet: true});
    check('Boost mit "Klick" (Quiet 0 nach dem Vorschlag): Wirkungsfall wird bewertet (kein Kalibrierfall), Ausloeser-Fall neutral (Eingriff)', C.scores.some(s => s.typ === 'wirkung' && s.regel === 'quiet_freigabe' && s.kalibrierfall === 0) && C.scores.filter(s => s.typ === 'ausloeser' && s.regel === 'quiet_freigabe').every(s => s.ergebnis === 'neutral'), C.scores.filter(s => s.regel === 'quiet_freigabe').map(s => s.typ + ':' + s.punkte).join(', '));
    { // Deckel/Laufzeit v4 ueber 8 Tage (Fake-Uhr): mild 11 °C ±4 K, nach jedem Start bis 40 min 26 Hz mit 5 kW ohne Bedarf (Uebersteuern nach dem Start wie 10.-13.10.)
      const seedAll = () => { const S0 = E.newState(new Date(2026, 9, 13, 23, 59).getTime()); S0.takt.nl = {laeuft: false}; const dk = '2026-10-13';
                              S0.takt.copT[dk] = {}; ['3…7', '7…11', '11…15', '≥ 15'].forEach(b => { S0.takt.copT[dk]['Efficiency|0|' + b] = [1000, 6000, 120, 120 * 26, 34, 34]; S0.takt.copT[dk]['Efficiency|3|' + b] = [1000, 6300, 120, 120 * 17, 17, 17]; }); return S0; };
      const PO = {at: 11, q: 0, hzStart: 40, pthStart: 5000, pelStart: 900, grund: 'quiet_strecken'};      // COP bei 26 Hz 5,6 (hohe Frequenz = schlechter, gemessen 07.-13.10.: 22-27 Hz 3-8 %, ab 28 Hz 10-14 % unter 16-17 Hz)
      const V4 = plantSim(8, Object.assign({S0: seedAll()}, PO)), V0 = plantSim(8, PO);
      const vp = V4.props.filter(p => p.rule === 'quiet_strecken'), v0 = V0.props.filter(p => p.rule === 'quiet_strecken');
      const g0 = Object.keys(V0.grund).filter(k => /keine Zielstufe aus den Daten/.test(k)).reduce((a, k) => a + V0.grund[k], 0);
      check('Deckel/Laufzeit v4 (Effizienz-Deckel), 8 Tage Fake-Uhr (mild, Uebersteuern nach dem Start, ' + V4.starts + ' Starts): mit Messdaten (Quiet 3 deckelt bei 17 Hz) Vorschlaege Quiet 0 -> 3 ohne Takt-Beleg (' + vp.length + '), hoechstens einer je Lauf (das Tageslimit zaehlt nur Uebernahmen, R5), Hebel Quiet, kein Fehler, keiner in einer Sperrminute',
            V4.errors === 0 && V4.recs === 8 * 1440 && vp.length >= 3 && vp.every(p => p.ver === 4 && p.hebel === 'quiet' && p.groesse === 'quiet' && p.cmd.name === 'SetQuietMode' && p.cmd.value === 3 && p.von === 0 && p.maxDauerMin === 480 && /Quiet 3 deckelt bei 17 Hz/.test(p.warum) && /^Verdichter 2\d Hz ohne Bedarf/.test(p.warum)) && V4.lockedProp === 0 && vp.length <= V4.starts,
            vp.length + ' Vorschlaege: ' + vp.slice(0, 3).map(p => E.iso(p.ts).slice(5, 16) + ' ' + p.was).join(' | '));
      check('... ohne Messdaten fuer hoehere Stufen (nur Live-Minuten Quiet 0): kein einziger Vorschlag, Grund "keine Zielstufe aus den Daten"', V0.errors === 0 && v0.length === 0 && g0 > 0, JSON.stringify(Object.keys(V0.grund).filter(k => /Daten/.test(k)).slice(0, 2)));
      const VA = plantSim(8, Object.assign({S0: seedAll(), applyStrecken: true}, PO)), pa = VA.props.filter(p => p.rule === 'quiet_strecken'), wa = VA.scores.filter(x => x.regel === 'quiet_strecken' && x.typ === 'wirkung');
      check('... mit "Klick" (Quiet 3 fuer 4 h, dann zurueck auf die vorherige Stufe 0): Wirkungsfaelle unter v4 (Verdichter <= 21 Hz binnen 10 min, -100 W), weniger Starts als ohne Klick (Anlagenmodell der Sim); hoechstens 3 Uebernahmen je Tag (Tageslimit R5)', VA.errors === 0 && wa.length >= 1 && wa.every(x => x.v === 4 && x.punkte === 20) && VA.starts < V4.starts && ['14', '15', '16', '17', '18', '19', '20', '21'].every(dd => wa.filter(x => x.t.slice(8, 10) === dd).length <= 3), 'Starts ' + VA.starts + ' gegen ' + V4.starts + ', Wirkung ' + wa.map(x => x.punkte).join('/') + ', Vorschlaege ' + pa.length); }
    const D = plantSim(5, {at: 4, cool: 1.5});
    basisBericht('5 Tage kaelter', D); basisBericht('4 Tage mild', A); basisBericht('3 Tage Boost', B);
    { const D4 = plantSim(5, {at: 4, cool: 1.5, cfg: E.mergeCfg({sv: 4})}), r5 = E.report(D.S), r4 = E.report(D4.S, 4), g = (r, id) => r.find(x => x.regel === id);
      const hz = D.scores.filter(s => s.typ === 'ausloeser' && s.regel === 'quiet_freigabe').reduce((a, s) => a.concat(s.horizonte), []);
      check('v5 im 5-Tage-Kaelte-Szenario (Befund 12.10.: v4 Raumeinfluss 14 Treffer -122, Quiet-Freigabe 15 Treffer -71): Raumeinfluss alle Treffer neutral, 0 Punkte; Quiet-Freigabe ohne Treffer-Abzug (Treffer-Horizonte bei b >= p 0 Punkte, vor dem Lernen der Basisrate Plus; Minus nur aus einzelnen Fehl-Horizonten mit vollem Abzug -13); v4 nachrechenbar',
            g(r5, 'raum_offset').treffer >= 10 && g(r5, 'raum_offset').trefferNeutral === g(r5, 'raum_offset').treffer && g(r5, 'raum_offset').punkte === 0 && g(r4, 'raum_offset').punkte < -100 &&
            hz.filter(h => h.o === 1).every(h => h.bp === 'neutral' ? h.punkte === 0 : (h.b < 0.8 && h.punkte > 0)) && hz.filter(h => h.o === 1 && h.bp === 'neutral').length >= 30 && hz.filter(h => h.o === 0).every(h => h.bp === 'abzug' ? Math.abs(h.punkte + 13) < 0.01 : h.b < 0.8) && g(r5, 'quiet_freigabe').punkte > g(r4, 'quiet_freigabe').punkte && g(r4, 'quiet_freigabe').punkte < -60,
            'v5: Raumeinfluss ' + g(r5, 'raum_offset').punkte + ' (' + g(r5, 'raum_offset').treffer + ' T, ' + g(r5, 'raum_offset').trefferNeutral + ' neutral), Quiet-Freigabe ' + g(r5, 'quiet_freigabe').punkte + ' (' + g(r5, 'quiet_freigabe').treffer + ' T, ' + g(r5, 'quiet_freigabe').trefferNeutral + ' neutral) · v4: ' + g(r4, 'raum_offset').punkte + ' / ' + g(r4, 'quiet_freigabe').punkte);
      check('v5 Skill-Konsistenz: Treffer ohne Brier-Beitrag zaehlen nicht fuer den Skill -> Raumeinfluss nach 14 neutralen Treffern Skill "–" (0 Faelle mit Beitrag), Kriterium "Skill" der Freigabereife damit in Dauer-Lagen unerreichbar (offene Entscheidung)',
            g(r5, 'raum_offset').skill === null && g(r5, 'raum_offset').skillFaelle === 0 && !g(r5, 'raum_offset').kriterien.find(k => k.k === 'skill').ok, 'Skill ' + g(r5, 'raum_offset').skill + ', Faelle mit Beitrag ' + g(r5, 'raum_offset').skillFaelle); }
    const perDay = {}; D.props.filter(p => p.rule === 'quiet_freigabe').forEach(p => { const k = E.iso(p.ts).slice(0, 10); perDay[k] = (perDay[k] || 0) + 1; });
    check('5 Tage kaelter werdend (4 -> -3,5 °C, Bedarf ueber der Mindestleistung): Quiet-Freigabe schlaegt an - Kaelte-Vorsorge unter 2 °C auf Quiet 2 (Messtabelle 21 Hz), Heizstab-Naehe bzw. Raum unter Minimum direkt auf Quiet 0 (Notfall); ohne Klick hoechstens 16 je Tag (Gueltigkeit 30 + Wartezeit 60 min; das Tageslimit zaehlt nur Uebernahmen), kein Fehler',
          D.errors === 0 && Object.keys(perDay).length >= 3 && Object.keys(perDay).every(k => perDay[k] <= 16) && D.props.filter(p => p.rule === 'quiet_freigabe').every(p => (p.cmd.value === 0 && /Bedarf: .*(Heizstab-Nähe|unter Minimum)/.test(p.warum)) || (p.cmd.value === 2 && /Kälte-Vorsorge/.test(p.was))) && D.props.some(p => /Kälte-Vorsorge/.test(p.was)), JSON.stringify(perDay));
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
    check('Punktebuch: Datensatz mit Regel, Version, Bewertungsversion, Prognose p, je Horizont Ergebnis/Basisrate/Punkte, laufende Summe', a && a.regel === 'quiet_freigabe' && a.v === E.RULE.quiet_freigabe.ver && a.sv === E.SCORE_VER && a.p === 0.8 && a.horizonte.length === 3 && a.summe === 21, a && JSON.stringify(a.horizonte[0]));
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
    R = runSeq(40, i => boost(i, {rooms: rooms({ki_oben: 21.8})}), null, c0); sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Verpasst: 20 min Lage am Deckel mit >= 2 K Rueckstand (Bedarf ohne Notfall), eigenes Tageslimit verhinderte den Vorschlag -> -20', sc.some(s => s.typ === 'verpasst' && s.regel === 'quiet_freigabe' && s.punkte === -20), sc.map(s => s.typ).join(','));
    R = runSeq(40, i => boost(i, {block: 1})); sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Verpasst entschuldigt: MQTT-Sperre (Sicherheitssperre) -> keine Minuspunkte', !sc.some(s => s.typ === 'verpasst'), sc.map(s => s.typ).join(','));
    // S5b (Bewertungsregeln v2): eigene Sperren/Wartezeiten entschuldigen "verpasst" (neutral, getrennt gezaehlt), Schaden und verlaengerte Werte nicht
    const hand = (i, o) => boost(i, Object.assign(i === 0 ? {q: 2} : {}, {rooms: rooms({ki_oben: 21.8})}, o || {}));   // Quiet 2 -> 3 von Hand in Minute 1: 60 min Mindestabstand (Bedarf ohne Notfall: Raum 0,2 K unter Minimum)
    const allSc = R0 => [].concat.apply([], R0.outs.map(o => o.scores));
    R = runSeq(80, i => hand(i)); sc = allSc(R);
    const vs = sc.filter(s => s.typ === 'verpasst_sperre'), pr1 = R.outs.findIndex(o => o.res.find(r => r.id === 'quiet_freigabe').neu);
    check('v2: Sperre entschuldigt verpasst - Lage ab Minute 0, Regel nur durch Haltezeit (10 min) und Mindestabstand nach Quiet von Hand (60 min) zurueckgehalten -> nach 20 min "verpasst_sperre" mit 0 Punkten, kein "verpasst"; Vorschlag sobald der Abstand endet (Minute 61)',
          vs.length === 1 && vs[0].punkte === 0 && vs[0].sv === E.SCORE_VER && vs[0].t === E.iso(T0 + 20 * MIN) && JSON.stringify(vs[0].sperre) === '["haltezeit","abstand"]' && !sc.some(s => s.typ === 'verpasst') && pr1 === 61, vs.map(s => s.t + ' ' + s.text).join(' | ') + ' · Vorschlag in Minute ' + pr1);
    const rp1 = E.report(R.S).find(r => r.regel === 'quiet_freigabe');
    check('v2: "waehrend Sperre" getrennt im Punktebuch (verpasstSperre 1, verpasst 0, 0 Punkte daraus) und nicht in der Freigabereife', rp1.verpasstSperre === 1 && rp1.verpasst === 0 && rp1.sv === E.SCORE_VER && rp1.kriterien.find(k => k.k === 'verpasst').ok, JSON.stringify({vs: rp1.verpasstSperre, v: rp1.verpasst, p: rp1.punkte}));
    R = runSeq(80, i => hand(i), null, E.mergeCfg({sv: 1})); sc = allSc(R);
    check('v1 bleibt nachrechenbar (cfg.sv = 1): dieselbe Lage ergibt wie bisher "verpasst" -20 nach 20 min, Datensatz sv 1', sc.filter(s => s.typ === 'verpasst').length === 1 && sc.find(s => s.typ === 'verpasst').punkte === -20 && sc.find(s => s.typ === 'verpasst').sv === 1 && !sc.some(s => s.typ === 'verpasst_sperre') && R.outs[5].rec.sv === 1, sc.map(s => s.typ + ':' + s.punkte).join(','));
    R = runSeq(80, i => hand(i, {rooms: rooms({ki_oben: 20.8})}), null, E.mergeCfg({locks: {notfallMin: 60}})); sc = allSc(R);     // Notfall ueberbrueckt sonst nach 10 min
    const vd = sc.filter(s => s.typ === 'verpasst');
    check('v2: Schaden waehrend Sperre zaehlt - Raum 1,2 K unter Minimum im Fenster (Notfall-Ueberbrueckung hier auf 60 min gestellt) -> trotz eigener Sperre "verpasst" -20 mit Schadensart, kein neutraler Eintrag', vd.length === 1 && vd[0].punkte === -20 && JSON.stringify(vd[0].schaden) === '["komfort"]' && /aber Schaden: Raum mehr als 1 K unter Minimum/.test(vd[0].text) && !sc.some(s => s.typ === 'verpasst_sperre'), vd.map(s => s.t + ' ' + s.text).join(' | '));
    const late = (i, o) => hand(i, Object.assign(i < 70 ? {rl: 35} : {}, o || {}));        // Lage erst ab Minute 70 (Standard-Abstand endet in Minute 61)
    R = runSeq(110, i => late(i)); sc = allSc(R);
    check('v2: mit Standard-Abstand (60 min) schlaegt die Regel ab Minute 80 vor (Lage ab 70 + 10 min Haltezeit) - nichts verpasst', !sc.some(s => /^verpasst/.test(s.typ)) && R.outs.findIndex(o => o.res.find(r => r.id === 'quiet_freigabe').neu) === 80, sc.map(s => s.typ).join(','));
    R = runSeq(110, i => late(i), null, E.mergeCfg({locks: {gapMin: 180}})); sc = allSc(R);
    const vx = sc.filter(s => s.typ === 'verpasst');
    check('v2: verlaengerte Sperre entschuldigt nicht - Mindestabstand auf 180 min verlaengert: die Minuten nach dem Standard (60 min) zaehlen frei -> "verpasst" -20 in Minute 99 (Haltezeit bis Minute 79 entschuldigt, ab Minute 80 frei, 20 freie Minuten)', vx.length === 1 && vx[0].punkte === -20 && vx[0].t === E.iso(T0 + 99 * MIN) && /verlängert: Mindestabstand/.test(vx[0].text) && !R.outs.some(o => o.res.find(r => r.id === 'quiet_freigabe').neu), vx.map(s => s.t + ' ' + s.text).join(' | '));
    const stretch = i => inp(T0 + i * MIN, i < 25 ? {q: i === 0 ? 3 : 0, hz: 30, rt: 60 + i, soll: 30, sollKurve: 29.75, vl: Math.round((30.5 + 0.1 * i) * 100) / 100, rl: 26.5} : {q: 0, hz: 0, rt: 0, soll: 30, vl: 33, rl: 30});
    // v3: Zielstufe aus den COP-Daten (Efficiency, 7…11 °C wie inp: at 9, hc 1): Quiet 0 COP 6,0, Quiet 2 6,1, Quiet 3 6,2 (je >= 60 min, Quiet 2/3 hoechstens 17 Hz) -> Ziel Quiet 3
    const copSeed = (S0, over) => { S0 = S0 || E.newState(T0 - MIN); S0.takt.nl = {laeuft: false}; S0.takt.copT[E.ymd(T0)] = Object.assign({'Efficiency|0|7…11': [1000, 6000, 120, 120 * 30, 34], 'Efficiency|2|7…11': [1000, 6100, 90, 90 * 17, 17], 'Efficiency|3|7…11': [1000, 6200, 120, 120 * 17, 17]}, over || {}); return S0; };
    const seedTakt = () => { const S0 = copSeed(); S0.runs = [[T0 - 120 * MIN, 40, 1]]; S0.lastStop = T0 - 80 * MIN; return S0; };   // Regel v2: Takt belegt (letzter Lauf 40 min, Abschaltung ueber den Vorlauf)
    R = runSeq(40, stretch, seedTakt()); sc = allSc(R);
    const ts = sc.filter(s => s.regel === 'quiet_strecken');
    check('v2: Takten waehrend Sperre zaehlt - Laufzeit strecken (Takt belegt: letzter Lauf 40 min mit Abschaltung ueber den Vorlauf) nur durch Haltezeit/Mindestabstand (Quiet 3 -> 0 von Hand) zurueckgehalten: erst "verpasst_sperre" (0), der Verdichter-Stopp danach hebt die Entschuldigung auf -> "verpasst" -20 mit Schadensart Takt', ts.length === 2 && ts[0].typ === 'verpasst_sperre' && ts[1].typ === 'verpasst' && ts[1].punkte === -20 && JSON.stringify(ts[1].schaden) === '["takt"]', ts.map(s => s.t.slice(11, 16) + ' ' + s.typ + ' ' + (s.schaden || '')).join(' | '));
    // Deckel/Laufzeit v4 (13.10.2026, Nutzer: "Laufzeit kann man mit Quiet-Mode und +1 K erreichen"; Effizienz: schalten, wie es am effizientesten ist)
    { const lauf2 = (i, ende, hz1) => inp(T0 + i * MIN, i < 40 ? {q: 0, hz: hz1 || 24, rt: i, soll: 30, sollKurve: 29.75, vl: Math.round((ende === 'thermo' ? 29 + 0.11 * i : 28.5 + 0.05 * i) * 4) / 4, rl: 27, rooms: rooms()}
                                               : (i < 70 ? {q: 0, hz: 0, rt: 0, soll: 30, sollKurve: 29.75, vl: 28, rl: 27.5, pump: 1750, rooms: rooms()}
                                                         : {q: 0, hz: 24, rt: i - 70, soll: 30, sollKurve: 29.75, vl: Math.round((28.5 + 0.08 * (i - 70)) * 4) / 4, rl: Math.round((26.25 + 0.08 * (i - 70)) * 4) / 4, rooms: rooms()}));
      const firstProp = R0 => { const k = R0.outs.findIndex(o => r0(o, 'quiet_strecken').neu); return {i: k, p: k >= 0 ? R0.outs[k].prop : null}; };
      const Rt = runSeq(110, i => lauf2(i, 'thermo'), copSeed()), f1 = firstProp(Rt), p1 = f1.p;
      check('Deckel/Laufzeit v4, Effizienz-Deckel ohne Takt: 24 Hz ohne Bedarf schon im ersten Lauf -> Vorschlag in Minute 25 (15 min Startphase, 10 min Haltezeit), Ziel die niedrigste deckelnde Stufe mit Daten (Quiet 2, Deckel 17 Hz laut Messung), Hebel Quiet, Rueckweg-Frist 8 h, Begruendung ohne Takt',
            f1.i === 25 && p1 && p1.ver === 4 && p1.cmd.name === 'SetQuietMode' && p1.cmd.value === 2 && p1.von === 0 && p1.hebel === 'quiet' && p1.maxDauerMin === 480 && /^Quiet-Stufe 0 → 2 \(Effizienz-Deckel\)$/.test(p1.was) && /Quiet 2 deckelt bei 17 Hz \(Efficiency, 7…11 °C, 1,5 h Daten\)/.test(p1.warum) && !/Takt/.test(p1.warum), f1.i + ' · ' + (p1 && p1.warum));
      const Rk = runSeq(110, i => lauf2(i, 'thermo', 17), copSeed()), f2 = firstProp(Rk);
      check('... erster Lauf am Minimum (17 Hz, Abschaltung ueber den Vorlauf nach 40 min), zweiter Lauf mit 24 Hz: Vorschlag in Minute 95, Begruendung nennt den belegten Takt', f2.i === 95 && /Takt: letzter Lauf nur 40 min \(Abschaltung über den Vorlauf\)/.test(f2.p.warum) && Rk.S.runs[0][1] === 40 && Rk.S.runs[0][2] === 1, f2.i + ' · ' + (f2.p && f2.p.warum));
      const Rh = runSeq(110, i => lauf2(i, 'heizgrenze', 17), copSeed()), f3 = firstProp(Rh);
      check('... Lauf endet an der Heizgrenze (Vorlauf unter Soll, wie 10.10. 11:49): kein Takt-Beleg, der Effizienz-Deckel im naechsten Lauf trotzdem (ohne Takt im Text)', Rh.S.runs[0][2] === 0 && f3.i === 95 && !/Takt/.test(f3.p.warum), f3.i + ' · ' + (f3.p && f3.p.warum));
      { const R2 = runSeq(110, i => { const x = lauf2(i, 'thermo'); x.q = 2; return x; }, copSeed()), f = firstProp(R2);
        check('Deckel/Laufzeit v4: aus Quiet 2 (24 Hz, Daten fuer Quiet 3) -> Vorschlag Quiet 2 -> 3, von = 2 (Rueckweg auf die vorherige Stufe)', !!f.p && f.p.ver === 4 && f.p.cmd.value === 3 && f.p.von === 2 && /^Quiet-Stufe 2 → 3/.test(f.p.was), f.p ? f.p.was + ' · ' + f.p.warum : r0(R2.outs[100], 'quiet_strecken').grund); }
      { const R3 = runSeq(110, i => lauf2(i, 'thermo'), copSeed(null, {'Efficiency|3|7…11': [1000, 6600, 120, 120 * 17, 17]})), f = firstProp(R3);
        check('Deckel/Laufzeit v4: Zielstufe ist die niedrigste deckelnde (Quiet 2), nicht die mit dem besten COP (Quiet 3 6,6 gegen 6,1; bei 16–17 Hz ist ein COP-Unterschied zwischen Stufen nicht messbar)', !!f.p && f.p.cmd.value === 2, f.p ? f.p.warum : r0(R3.outs[100], 'quiet_strecken').grund); }
      { const R4 = runSeq(110, i => lauf2(i, 'thermo'), copSeed(null, {'Efficiency|2|7…11': [1000, 6100, 90, 90 * 24, 26, 26], 'Efficiency|3|7…11': [1000, 5000, 120, 120 * 17, 17]}));
        const g4 = r0(R4.outs[30], 'quiet_strecken').grund;
        check('Deckel/Laufzeit v4: Quiet 2 deckelt laut Daten nicht (26 Hz gehalten), Quiet 3 COP mehr als 10 % unter der jetzigen (roh 5,0 gegen 6,0, mit COP-Korrektur 4,31 gegen 5,2x, Veto; Messunsicherheit ±10 %) -> keine Zielstufe, kein Vorschlag, Grund nennt beides', !R4.outs.some(o => r0(o, 'quiet_strecken').neu) && /Quiet 2 deckelt nicht \(bis 26 Hz\)/.test(g4) && /Quiet 3 COP 4,31 statt 5,\d\d \(mehr als 10 % schlechter\)/.test(g4), g4); }
      { const S5 = copSeed(); delete S5.takt.copT[E.ymd(T0)]['Efficiency|2|7…11']; delete S5.takt.copT[E.ymd(T0)]['Efficiency|3|7…11'];
        const R5 = runSeq(110, i => lauf2(i, 'thermo'), S5), g5 = r0(R5.outs[30], 'quiet_strecken').grund, sc5 = allSc(R5);
        check('Deckel/Laufzeit v4: keine Messdaten fuer Quiet 1–3 (Nutzerentscheidung 60 min je Heizregelung x Quiet x Band) -> kein Vorschlag, Grund "keine Zielstufe aus den Daten"; kein "verpasst"', !R5.outs.some(o => r0(o, 'quiet_strecken').neu) && /keine Zielstufe aus den Daten \(Efficiency, 7…11 °C\): Quiet 1: 0 von 60 min Daten; Quiet 2: 0 von 60 min Daten; Quiet 3: 0 von 60 min Daten/.test(g5) && !sc5.some(x => x.regel === 'quiet_strecken' && /^verpasst/.test(x.typ)), g5); }
      { const zl = E.zielDeckel({q: 0, at: 9, hc: 1, tc: E.taktCfg({copMinMin: 200}), copSum: E.copSumme(copSeed().takt, null, T0)}, cfg.rules.quiet_strecken);
        check('Deckel/Laufzeit v4: Mindestdaten aus cfg.takt.copMinMin (200 min statt 60) -> keine Zielstufe', zl.ziel === null && /90 von 200 min/.test(zl.warum), zl.warum); }
      { const g = (o, x) => r0(runSeq(40, i => Object.assign(lauf2(i, 'thermo'), o), copSeed()).outs[30], 'quiet_strecken').grund;
        const gK = g({rooms: rooms({ki_oben: 22.2})}), gA = g({at: 3}), gB = (() => { const R0 = runSeq(40, i => Object.assign(lauf2(i, 'thermo'), i < 5 ? {rooms: rooms({ki_oben: 21.8})} : {}), copSeed()); return r0(R0.outs[30], 'quiet_strecken').grund; })();
        check('Deckel/Laufzeit v4 nur bei sicherem Komfort: Raum nur 0,2 K ueber Minimum -> kein Deckel; Aussentemperatur 3 °C -> keiner (Nutzererfahrung 1–3 °C); Raum vor 25 min unter Minimum -> Ruhe 2 h', /Kinderzimmer oben nur 0,2 K über Minimum \(Reserve 0,3 K\)/.test(gK) && /Außentemperatur 3 °C \(Quiet höher erst über 3 °C\)/.test(gA) && /Bedarf zuletzt 06:04 \(Ruhe bis 08:04\)/.test(gB), [gK, gA, gB].join(' | ')); }
      { const Sx = copSeed(); let S = Sx; const outs = [];
        for (let i = 0; i < 40; i++) { const o = E.step(S, inp(T0 + i * MIN, {q: i < 20 ? 0 : 2, hz: i < 23 ? 24 : 17, pel: i < 23 ? 520 : 330, rt: 30 + i, soll: 30, sollKurve: 29.75, vl: 30, rl: 27.5, rooms: rooms()}), cfg); S = o.S; outs.push(o); }
        const ef = [].concat(...outs.map(o => o.scores)).filter(x => x.regel === 'quiet_strecken' && x.typ === 'wirkung');
        check('Deckel/Laufzeit v4: Wirkungsmessung "Deckel" bei Quiet 0 -> 2 mit 24 Hz: <= 21 Hz binnen 10 min und -100 W (Minute 5–10) getroffen, gebucht unter v4', ef.length === 1 && /Quiet 0 → 2 bei 24 Hz/.test(ef[0].text) && ef[0].v === 4 && ef[0].punkte === 20 && ef[0].teile.every(t => t.ergebnis === 'getroffen'), JSON.stringify(ef.map(x => [x.text, x.v, x.punkte]))); }
      // Hebel Heizkurve +1 K: Takt belegt und Verdichter am Minimum (Quiet deckelt nichts mehr); Nutzen (vermiedene Starts) gegen Kosten (Vorlauf +1 K)
      const zyklus = (lauf, pause, o) => i => { const k = i % (lauf + pause), on = k < lauf; return inp(T0 + i * MIN, Object.assign(on ? {q: 3, hz: 17, rt: k, soll: 30, sollKurve: 29.75, vl: Math.round((30.5 + 3 * k / lauf) * 4) / 4, rl: 29, rooms: rooms()} : {q: 3, hz: 0, rt: 0, soll: 30, sollKurve: 29.75, vl: 28, rl: 27.5, pump: 1750, rooms: rooms()}, typeof o === 'function' ? o(i) : (o || {}))); };
      const Rz = runSeq(120, zyklus(20, 10)), fz = firstProp(Rz), pz = fz.p, Rz46 = runSeq(76, zyklus(20, 10));
      check('Deckel/Laufzeit v4, Hebel +1 K: Takt (Laeufe 20 min mit Abschaltung ueber den Vorlauf, Pausen 10 min; belegt ab dem dritten Start: kurzer Lauf UND 2 Starts in 3 h), Verdichter am Minimum, Vorlauf schon ueber Soll (nur die Stoppschwelle steigt), kein Raum ueber der Bandmitte, Nutzen > Kosten -> Vorschlag SetZ1HeatRequestTemperature = 1 (Groesse Verschiebung, Rueckweg-Frist 6 h) in Minute 75 (Haltezeit 10 min, dann Startphase-Sperre bis Laufminute 15); die Verschiebung gehoert dann "Deckel/Laufzeit" (Arbitrierung)',
            fz.i === 75 && pz && pz.cmd.name === 'SetZ1HeatRequestTemperature' && pz.cmd.value === 1 && pz.von === 0 && pz.groesse === 'shift' && pz.hebel === 'shift' && pz.maxDauerMin === 360 && /^Heizkurve 0 → \+1 K \(Soll-Vorlauf 30 → 31 °C, Laufzeit\)$/.test(pz.was) && /Takt: letzter Lauf nur 20 min/.test(pz.warum) && /Nutzen ~\d+ Wh\/Tag \([\d,]+ Starts weniger\) gegen Kosten ~\d+ Wh\/Tag/.test(pz.warum) && Rz46.S.arb.owner === 'quiet_strecken',
            fz.i + ' · ' + (pz ? pz.was + ' · ' + pz.warum : r0(Rz.outs[60], 'quiet_strecken').grund));
      const nk = E.nutzenKurve({lastRunMin: 20, lastPauseMin: 10}, cfg.rules.quiet_strecken), nl = E.nutzenKurve({lastRunMin: 40, lastPauseMin: 30}, cfg.rules.quiet_strecken);
      check('Nutzen/Kosten +1 K (Annahmen: Lauf +40 min, Pause −18 min, Start 15 Wh, 8,5 W/K im Lauf): Zyklus 20 + 10 min Nutzen ~305 gegen Kosten ~136 Wh/Tag (lohnt); Zyklus 40 + 30 min ~74 gegen ~117 Wh/Tag (lohnt nicht); Gleichstand bei ~50 min Zyklus',
            nk.ok && nk.nutzen === 305 && nk.kosten === 136 && !nl.ok && nl.nutzen === 74 && nl.kosten === 117, JSON.stringify([nk, nl].map(x => [x.nutzen, x.kosten, x.ok])));
      const Rl = runSeq(150, zyklus(40, 30));
      check('... Zyklus 40 + 30 min: Takt belegt, aber Nutzen kleiner als Kosten -> kein +1 K, Grund nennt die Zahlen', !Rl.outs.some(o => r0(o, 'quiet_strecken').neu) && /Nutzen kleiner als Kosten: Zyklus 40 \+ 30 min: Nutzen ~74 Wh\/Tag/.test(r0(Rl.outs[148], 'quiet_strecken').grund), r0(Rl.outs[148], 'quiet_strecken').grund);
      const Rw = runSeq(120, zyklus(20, 10, {rooms: rooms({ki_oben: 23.3})}));
      check('... Raum ueber der Bandmitte (Kinderzimmer oben 23,3 °C, Mitte 22,75 °C): kein +1 K (sonst Gegenspieler zu Raumeinfluss −1 K, Regel-Review LS-5)', !Rw.outs.some(o => r0(o, 'quiet_strecken').neu) && /Kinderzimmer oben 0,\d K über der Bandmitte/.test(r0(Rw.outs[70], 'quiet_strecken').grund), r0(Rw.outs[70], 'quiet_strecken').grund);
      const Rv = runSeq(120, zyklus(20, 10, i => (i % 30 < 18 ? {vl: 30} : (i % 30 >= 20 ? {vl: 27.5} : {}))));
      check('... Vorlauf im Lauf nur am Soll (+1 K loeste bei Quiet 0 einen Hochlauf aus, 11.10. 03:10) und in der Pause bei Soll −2,5 K (+1 K startete sofort): kein +1 K', !Rv.outs.some(o => r0(o, 'quiet_strecken').neu) && /Vorlauf 0,00 K zum Soll: \+1 K löste einen Hochlauf aus/.test(r0(Rv.outs[76], 'quiet_strecken').grund) && /Vorlauf -2,50 K zum Soll: \+1 K startete den Verdichter sofort/.test(r0(Rv.outs[85], 'quiet_strecken').grund), r0(Rv.outs[76], 'quiet_strecken').grund + ' | ' + r0(Rv.outs[85], 'quiet_strecken').grund);
      { const ca = E.mergeCfg({rules: {raum_offset: {stabilMin: 20}}}); let Sa = null; const sn = [];
        for (let i = 0; i < 150; i++) { const o = E.step(Sa, zyklus(20, 10, {korr: {v: 1, code: 'Raum unter Minimum', distrib: false, lead: 'Kinderzimmer oben'}})(i), ca); Sa = o.S; const qp = Sa.rules.quiet_strecken.prop; sn.push({ro: !!Sa.rules.raum_offset.prop, qs: !!(qp && qp.groesse === 'shift'), g: r0(o, 'quiet_strecken').grund, gr: r0(o, 'raum_offset').grund}); }
        check('Arbitrierung Verschiebung: Raumeinfluss +1 K (Minute 20; die Startsperre zieht ihn in Minute 30 zurueck), "Deckel/Laufzeit" uebernimmt dieselbe Richtung in Minute 75 (keine Gegenrichtung), der Raumeinfluss ist dann "dieselbe Verschiebung +1 K schlägt schon „Deckel/Laufzeit“ vor"; nie zwei Verschiebungs-Vorschlaege gleichzeitig',
              sn[20].ro && !sn[30].ro && sn[75].qs && !sn.some(x => x.ro && x.qs) && /dieselbe Verschiebung \+1 K schlägt schon „Deckel\/Laufzeit“ vor/.test(sn[76].gr), sn[76].gr); }
      { const Az = E.newApply(); Az.aktiv = {id: 's', rule: 'quiet_strecken', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: 1, von: 0, ts: T0, bis: T0 + 360 * MIN, bestaetigt: true};
        const tq = E.applyTick(JSON.parse(JSON.stringify(Az)), {now: T0 + 60 * MIN, eng: {ts: T0 + 60 * MIN}, plant: {shift: 1, hpAge: 0.3, block: 0}, endReason: {quiet_strecken: 'Bedarf: Kinderzimmer oben 0,4 K unter Minimum'}});
        const ts2 = E.applyTick(JSON.parse(JSON.stringify(Az)), {now: T0 + 60 * MIN, eng: {ts: T0 + 60 * MIN}, plant: {shift: 1, hpAge: 0.3, block: 0}, endReason: {'quiet_strecken|shift': 'Kinderzimmer oben über Maximum'}});
        const Aq = E.newApply(); Aq.aktiv = {id: 'q', rule: 'quiet_strecken', groesse: 'quiet', name: 'SetQuietMode', value: 3, von: 0, ts: T0, bis: T0 + 480 * MIN, bestaetigt: true};
        const tq3 = E.applyTick(Aq, {now: T0 + 60 * MIN, eng: {ts: T0 + 60 * MIN}, plant: {q: 3, hpAge: 0.3, block: 0}, endReason: {quiet_strecken: 'Bedarf: Kinderzimmer oben 0,4 K unter Minimum'}});
        check('Rueckweg je Hebel: die +1-K-Uebernahme kehrt nicht wegen des Quiet-Grundes zurueck ("Bedarf"), aber sofort bei "Raum ueber Maximum" (Schluessel "quiet_strecken|shift"); die Quiet-Uebernahme bei Bedarf (Schluessel "quiet_strecken")',
              tq.send.length === 0 && ts2.send.length === 1 && ts2.send[0].payload === '0' && /über Maximum/.test(ts2.log[0].grund) && tq3.send.length === 1 && tq3.send[0].payload === '0' && /Bedarf/.test(tq3.log[0].grund), ''); }
      const So = E.newState(T0 - MIN); So.runs = [[T0 - 120 * MIN, 20]]; So.lastStop = T0 - 100 * MIN; So.lastPause = 10;                // Zustand aus einer aelteren Datei: Lauf ohne Stopp-Art
      const Ro = runSeq(40, zyklus(20, 10), So);
      check('Deckel/Laufzeit v4: aelterer Zustand ohne Stopp-Art (Lauf [Beginn, Dauer]) gilt nicht als Takt-Beleg (vorsichtig, kein +1 K)', !Ro.outs.slice(0, 19).some(o => r0(o, 'quiet_strecken').neu) && /kein Takt belegt|Quiet steht schon auf 3/.test(r0(Ro.outs[10], 'quiet_strecken').grund), r0(Ro.outs[10], 'quiet_strecken').grund);
      // Laufzeit-Zaehler von HeishaMoNR springt mitten im beobachteten Lauf auf 0 (Neustart 09.10. 03:01): kein neuer Lauf, kein falscher Takt-Beleg
      const Rr = runSeq(200, i => inp(T0 + i * MIN, i < 180 ? {q: 3, hz: 17, rt: i < 120 ? 60 + i : i - 120, soll: 30, sollKurve: 29.75, vl: i < 175 ? 30 : 33.5, rl: 28.5} : {q: 3, hz: 0, rt: 0, soll: 30, vl: 33, rl: 30, pump: 1750}));
      check('Laufzeit-Zaehler springt im beobachteten Lauf auf 0 (HeishaMoNR-Neustart, 09.10. 03:01: 583 -> 0): der Lauf bleibt einer (240 min, nicht 60 min), kein Takt-Beleg', Rr.S.runs.length === 1 && Rr.S.runs[0][1] === 240 && Rr.S.runs[0][2] === 1 && !/Takt: letzter Lauf/.test(r0(Rr.outs[199], 'quiet_strecken').grund), JSON.stringify(Rr.S.runs) + ' · ' + r0(Rr.outs[199], 'quiet_strecken').grund); }
    { // Versionswechsel der Regel (Quiet-Freigabe v1 -> v2): die v1-Summen bleiben unter ihrem Schluessel, v2 beginnt bei 0
      const Sv = E.newState(T0 - MIN); Sv.sc.tot['quiet_freigabe|v1|s5'] = {rule: 'quiet_freigabe', ver: 1, sv: 5, since: T0 - 3 * 86400000, punkte: -20, faelle: 2, bewertet: 1, treffer: 1, fehlalarm: 0, neutral: 1, bs: 0, bsRef: 0, schaden: 0, verpasst: 1, verpasstSperre: 0, wirkN: 0, wirkP: 0, kalib: 0, trefferNeutral: 0, skillN: 0};
      Sv.sc.base.quiet_freigabe = {30: [20, 19], 60: [20, 19], 120: [20, 19]};
      R = runSeq(160, i => boost(i), Sv); const rpv = E.report(R.S).find(r => r.regel === 'quiet_freigabe'), av = allSc(R).find(x => x.typ === 'ausloeser');
      check('Regelversion v1 -> v2 im laufenden Zustand: v1-Summen bleiben unveraendert unter "quiet_freigabe|v1|s5" (-20, 1 verpasst), v2 zaehlt getrennt unter "quiet_freigabe|v2|s5", Bericht zeigt v2; die alte Basisrate (v1-Vergleichslagen) wird nicht verwendet (neuer Schluessel "quiet_freigabe|v2")',
            R.S.sc.tot['quiet_freigabe|v1|s5'].punkte === -20 && R.S.sc.tot['quiet_freigabe|v2|s5'].faelle === 1 && rpv.v === 2 && rpv.verpasst === 0 && av && av.v === 2 && av.horizonte.every(h => h.b === 0.5) && !!R.S.sc.base['quiet_freigabe|v2'], JSON.stringify(Object.keys(R.S.sc.tot)) + ' ' + JSON.stringify(av && av.horizonte.map(h => h.b))); }
    // S6: Basisrate lernt aus Vergleichslagen: 8 kurze Episoden (Rueckstand 30 min, dann geloest) -> b fuer 60/120 min nahe 0 -> Treffer zaehlt viel
    let S = null; const ep = [];
    for (let k = 0; k < 8; k++) { for (let i = 0; i < 150; i++) { const t = k * 150 + i; const o = E.step(S, inp(T0 + t * MIN, {rt: 20 + i, soll: 31, sollKurve: 30.5, vl: i < 30 ? 29 : 31.5, rl: i < 30 ? 26.5 : 29.5, q: 3, hz: 16, block: 1, rooms: rooms({ki_oben: 21.2})}), cfg); S = o.S; } }   // v2: Vergleichslage mit Bedarf (Raum unter Minimum)
    const B = S.sc.base['quiet_freigabe|v2'] || {};
    check('Basisrate "bleibt, wie es ist" (v2: eigener Schluessel "quiet_freigabe|v2", Vergleichslage am Deckel mit Rueckstand UND Bedarf): aus Vergleichslagen gelernt (8 Episoden mit 30 min Rueckstand: nach 30 min bestand das Problem 8/8, nach 120 min 0/8; 60 min unklar = nicht gezaehlt)', B['30'] && B['30'][0] === 8 && B['30'][1] === 8 && B['120'] && B['120'][0] === 8 && B['120'][1] === 0 && !B['60'], JSON.stringify(B));
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
    // S9 (Review-Paket 13.10.2026): Heizgrenze-Hinweis stillgelegt. Mildes Wetter (13 °C) mit Reserve in allen Raeumen: kein Hinweis, keine Faelle;
    // stattdessen die Kennzahl "Ueberheizt ab 11 °C" (Laufenergie, waehrend ALLE Raeume ueber ihrer Bandmitte liegen)
    const mild = (i, t) => inp(T0 + i * MIN, {at: 13, rt: 20 + i, soll: 29, sollKurve: 29, vl: 30, rl: 28, pel: 300, pth: 2100, rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: t, age: 10, min: 22, max: 23.5, valid: true, active: true}]});
    R = runSeq(220, i => mild(i, 22.8)); sc = [].concat.apply([], R.outs.map(o => o.scores));
    { const ub = E.uebSumme(R.S, T0 + 219 * MIN), R2 = runSeq(60, i => mild(i, 22.6)), ub2 = E.uebSumme(R2.S, T0 + 59 * MIN), R3 = runSeq(60, i => Object.assign(mild(i, 23.0), {at: 10})), ub3 = E.uebSumme(R3.S, T0 + 59 * MIN);
      check('Heizgrenze-Hinweis stillgelegt: 220 min Lauf bei 13 °C mit Reserve -> kein Hinweis, kein Fall, kein Punktebuch-Eintrag; Kennzahl "Ueberheizt ab 11 °C": Raum 22,8 °C ueber der Bandmitte 22,75 -> 220 min, 300 W -> 1,10 kWh Strom roh = 1,39 kWh mit COP-Korrektur (+80 W je Laufminute) und 7,7 kWh Waerme; Raum 22,6 °C (unter der Mitte) -> 0 kWh bei 60 Laufminuten ab 11 °C; Aussen 10 °C -> zaehlt gar nicht',
            !R.outs.some(o => o.prop) && sc.length === 0 && ub.min === 220 && Math.abs(ub.elRoh - 1.1) < 1e-9 && Math.abs(ub.el - (1.1 + 220 * 80 / 60000)) < 0.001 && Math.abs(E.uebSumme(R.S, T0 + 219 * MIN, 0).el - 1.1) < 1e-9 && Math.abs(ub.th - 7.7) < 1e-9 && ub.minAlle === 220 && ub2.el === 0 && ub2.min === 0 && ub2.minAlle === 60 && ub3.minAlle === 0,
            JSON.stringify([ub, ub2, ub3])); }
    { const old = R.S, Rf = runSeq(30, i => Object.assign(mild(i, 22.8), {rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: 22.8, age: i < 15 ? 300 : 400, min: 22, max: 23.5, valid: false, active: true}]}), null), uf = E.uebSumme(Rf.S, T0 + 29 * MIN);
      check('Kennzahl "Ueberheizt": Raumwert bis 6 h alt zaehlt (wie die Bewertung), aelter = "ohne Raumdaten" (15 von 30 min)', uf.min === 15 && uf.minOhne === 15 && uf.minAlle === 30 && !!old.ueb, JSON.stringify(uf)); }
    // Lueftungsverdacht (vorher am Heizgrenze-Hinweis geprueft, jetzt am Raumeinfluss): Raum faellt 1,2 K in einer Minute (Fenster) -> Eingriff von aussen, Bewertung neutral, kein Schaden
    R = runSeq(400, i => inp(T0 + i * MIN, {korr: {v: 1, code: 'Raum unter Minimum', distrib: false, lead: 'Kinderzimmer oben'}, rooms: rooms({ki_oben: i < 100 ? 21.4 : 20.2})})); sc = [].concat.apply([], R.outs.map(o => o.scores));
    check('Lueftungsverdacht: Raum faellt 1,2 K in einer Minute (Fenster) -> Eingriff von aussen, Bewertung neutral, kein Schaden', sc.some(s => s.typ === 'ausloeser' && s.regel === 'raum_offset' && s.ergebnis === 'neutral' && /Lüftungsverdacht \(Kinderzimmer oben −1,2 K/.test(s.text)) && !sc.some(s => s.typ === 'schaden'), sc.map(s => s.typ + ':' + s.ergebnis + ' ' + (s.text || '').slice(-80)).join(','));
    // S10: Bericht, Wochenuebersicht, Freigabereife
    const rep = E.report(A1.S), rq = rep.find(r => r.regel === 'quiet_freigabe');
    check('Bericht je Regel: Punkte, Faelle, Treffer-/Fehlalarmquote, Brier-Skill (v4: bei 1 Fall "–", v3 rechnete ihn schon), Schaden, Verpasst, Wirkung, Freigabereife mit Kriterien', rq && rq.punkte === 21 && rq.trefferquote === 1 && rq.fehlalarmquote === 0 && rq.skill === null && E.report(runSeq(160, i => boost(i), null, E.mergeCfg({sv: 3})).S, 3).find(r => r.regel === 'quiet_freigabe').skill !== null && rq.reif === false && rq.kriterien.length === 6 && rq.kriterien.find(k => k.k === 'faelle').ok === false, JSON.stringify(rq.kriterien.map(k => k.k + (k.ok ? '+' : '-'))));
    check('Wochenuebersicht (ISO-Woche) mit Punkten, Faellen, Treffern', A1.S.sc.week['2026-W42'] && A1.S.sc.week['2026-W42'].quiet_freigabe.punkte === 21 && A1.S.sc.week['2026-W42'].quiet_freigabe.treffer === 1, JSON.stringify(A1.S.sc.week));
    check('Punkteverlauf fuer das Diagramm (Zeit, Regel, Summe)', A1.S.sc.hist.length >= 1 && A1.S.sc.hist[A1.S.sc.hist.length - 1][2] === 21, JSON.stringify(A1.S.sc.hist.slice(-1)));
    // S11 (Review-Paket 13.10.2026): Messaufgabe Comfort/Efficiency gestrichen - dieselbe Lage (Quiet 0, Rueckstand, beide Heizregelungen) ergibt keinen Befund mehr;
    // ein alter Zustand mit gesammelten Minuten (sc.mess) wird beim Laden bereinigt. Der Befund steht in der Doku und als Kennzahl "Hochlauf nach Start".
    let Sm = null, ms = [];
    for (let i = 0; i < 80; i++) { const hc = i < 40 ? 1 : 0, o = E.step(Sm, inp(T0 + i * MIN, {q: 0, hc: hc, rt: 30 + i, soll: 38, vl: 33, rl: 30, hz: hc ? 34 : 45, pel: hc ? 840 : 1150, pth: hc ? 5000 : 6500, at: 11}), cfg); Sm = o.S; ms = ms.concat(o.scores); }
    { const So = E.newState(T0); So.sc.mess = {c: [[T0, 11, 45, 1150, 6500, 2, 1]], e: [], done: false}; const Ro = runSeq(2, i => inp(T0 + i * MIN), So);
      check('Messaufgabe Comfort/Efficiency gestrichen: 80 min Quiet 0 mit Rueckstand in Comfort und Efficiency -> kein Befund (kein Eintrag "messaufgabe"), kein Sammelzustand; alter Zustand mit sc.mess wird bereinigt; keine Funktion messStatus mehr',
            !ms.some(s => s.typ === 'messaufgabe') && !Sm.sc.mess && !Ro.S.sc.mess && E.messStatus === undefined && E.MESS === undefined, ms.map(s => s.typ).join(',')); }
    // S13 (Review-Paket 13.10.2026): Heizregelungs-Hinweis der Maschine (ersetzt die Warnung des Quiet-Waechters: die flackerte am 07.–13.10. 74-mal an der 4,0-°C-Grenze)
    { const hcw = (n, f) => runSeq(n, i => inp(T0 + i * MIN, Object.assign({hc: 1, htrOnAT: 0, htrStartDelta: -3, htrDelay: 15}, f(i)))), on = R => R.outs.filter(o => o.hc && o.hc.warn).length;
      const Rf = hcw(120, i => ({at: i % 2 ? 4.9 : 5.1, rt: 20 + i, soll: 32, vl: 29}));
      check('Heizregelungs-Hinweis: Efficiency an der 5-°C-Grenze (4,9 <-> 5,1 °C, Vorlauf 3 K unter Soll) -> nie ein Hinweis (Grenze ist Heizstab-Einschalttemperatur 0 °C + 2 K), Text "Efficiency · keine Warnung"',
            on(Rf) === 0 && Rf.outs[119].hc.text === 'Efficiency · keine Warnung' && Rf.outs[119].hc.mode === 1, on(Rf) + ' Minuten');
      const Rk = hcw(60, i => ({at: 1, rt: i, soll: 32, vl: Math.round(Math.min(32, 26 + 0.5 * i) * 4) / 4}));
      check('... normaler Kaltstart bei 1 °C (Vorlauf 6 K unter Soll, holt 0,5 K/min auf): kein Hinweis (in den ersten 10 Laufminuten nie, danach < 2,5 K Rückstand)', on(Rk) === 0, on(Rk) + ' Minuten');
      const Rh = hcw(70, i => ({at: 1, rt: i, soll: 32, vl: i < 40 ? 29 : 31.5}));
      const first = Rh.outs.findIndex(o => o.hc.warn), last = Rh.outs.map(o => o.hc.warn).lastIndexOf(true);
      check('... Vorlauf haengt 3 K unter Soll (Heizstab-Naehe, Start-Delta 3 K - 0,5 K): Hinweis nach 10 Laufminuten + 3 min am Stueck (Minute 13), bleibt bis 10 min nach dem Aufholen (Minute 40 -> bis 49); Text nennt Aussen, Rueckstand, Heizstab-Schwelle',
            first === 13 && last === 49 && /^Efficiency · Comfort empfohlen: Heizstab-Nähe \(Außen 1 °C, Vorlauf 3,0 K unter Soll, Lauf 13 min; Heizstab ab 3 K unter Soll nach 15 min\)/.test(Rh.outs[13].hc.text), first + '/' + last + ' ' + (Rh.outs[13] && Rh.outs[13].hc.text));
      const Rc = hcw(40, i => ({at: 1, rt: i, soll: 32, vl: 29, hc: i < 25 ? 1 : 0}));
      check('... Wechsel auf Comfort: Hinweis sofort weg, Text "Comfort"', Rc.outs[24].hc.warn && !Rc.outs[25].hc.warn && Rc.outs[25].hc.text === 'Comfort', Rc.outs[25].hc.text);
      const Ra = hcw(60, i => ({at: i < 30 ? 1 : (i % 2 ? 2.4 : 2.6), rt: i, soll: 32, vl: 29}));
      check('... Aussentemperatur pendelt danach um 2,5 °C (ueber der Grenze 2 °C, innerhalb der Hysterese 1 K): Hinweis bleibt stabil an (kein Flackern)', Ra.outs.slice(13).every(o => o.hc.warn), Ra.outs.slice(13).filter(o => !o.hc.warn).length + ' Aus-Minuten');
      const Rd = hcw(60, i => ({at: 1, rt: 20 + i, soll: 32, vl: 29.75}));
      check('... Dauerlauf (Lauf > Heizstab-Verzoegerung): Schwelle 2,0 K (Start-Delta 3 K - 1,0 K), 2,25 K Rueckstand reicht', on(Rd) > 0 && on(hcw(60, i => ({at: 1, rt: 20 + i, soll: 32, vl: 30.25}))) === 0, on(Rd) + ' Minuten'); }
    // S12 (Review-Paket 13.10.2026): Stilllegung im laufenden Zustand. Ein Zustand aus der Datei mit offenem Hinweis-Fall, Vergleichslagen, Basisrate und Summen
    // des Heizgrenze-Hinweises (v3/v5): Fall und Vergleichslagen enden ohne Buchung, die Summen bleiben unter ihrem Schluessel stehen, der Bericht kennt die Regel nicht mehr
    { const So = E.newState(T0 - MIN), H0 = {rule: 'heizgrenze_hinweis', ver: 1, since: T0 - 4 * 86400000, punkte: 0, faelle: 4, bewertet: 2, treffer: 2, fehlalarm: 0, neutral: 2, bs: 0, bsRef: 0, schaden: 0, verpasst: 0, verpasstSperre: 0, wirkN: 0, wirkP: 0, kalib: 0, trefferNeutral: 2, skillN: 0};
      So.sc.tot['heizgrenze_hinweis|v1|s5'] = Object.assign({sv: 5}, H0); So.sc.tot['heizgrenze_hinweis|v1|s3'] = Object.assign({}, H0, {sv: 3, punkte: 9});
      So.sc.base.heizgrenze_hinweis = {180: [7, 6]}; So.sc.hist.push([T0 - 86400000, 'heizgrenze_hinweis', 9, 3]);
      So.sc.cases.push({id: 'heizgrenze_hinweis@x', rule: 'heizgrenze_hinweis', v: 1, sv: 5, t0: T0 - 30 * MIN, p: 0.6, h: [180], done: [], hr: [], pts: 0, tr: {rule: 'heizgrenze_hinweis', t0: T0 - 30 * MIN, ctx: {bands: {}}, cut: 0, ser: [], H: 180 * MIN}, dmg: []});
      So.sc.cands.push({rule: 'heizgrenze_hinweis', bk: 'heizgrenze_hinweis', t0: T0 - 20 * MIN, h: [180], done: [], tr: {rule: 'heizgrenze_hinweis', t0: T0 - 20 * MIN, ctx: {bands: {}}, cut: 0, ser: [], H: 180 * MIN}});
      So.rules.heizgrenze_hinweis = {since: 0, failSince: 0, prop: {id: 'heizgrenze_hinweis@x', rule: 'heizgrenze_hinweis', art: 'hinweis'}, cool: 0, n: 1, day: E.ymd(T0)}; So.sc.gt.heizgrenze_hinweis = {since: T0 - 10 * MIN};
      let err = null, Ro = null; try { Ro = runSeq(240, i => mild(i, 22.8), JSON.parse(JSON.stringify(So))); } catch (e) { err = e; }
      const scs = Ro ? allSc(Ro) : [], rp = Ro ? E.report(Ro.S) : [];
      check('Stilllegung im laufenden Zustand: alter offener Hinweis-Fall und Vergleichslage enden beim Laden ohne Buchung (kein Fehler, kein Punktebuch-Eintrag, kein Vorschlag), Summen "heizgrenze_hinweis|v1|s5"/"|s3", Basisrate und Punkteverlauf bleiben unveraendert stehen, Bericht ohne die Regel',
            err === null && !scs.some(s => s.regel === 'heizgrenze_hinweis') && !Ro.S.sc.cases.some(C => C.rule === 'heizgrenze_hinweis') && !Ro.S.sc.cands.some(C => C.rule === 'heizgrenze_hinweis') && !Ro.S.rules.heizgrenze_hinweis && !Ro.S.sc.gt.heizgrenze_hinweis &&
            JSON.stringify(Ro.S.sc.tot['heizgrenze_hinweis|v1|s5']) === JSON.stringify(So.sc.tot['heizgrenze_hinweis|v1|s5']) && Ro.S.sc.tot['heizgrenze_hinweis|v1|s3'].punkte === 9 && Ro.S.sc.base.heizgrenze_hinweis[180][0] === 7 && Ro.S.sc.hist.some(h => h[1] === 'heizgrenze_hinweis') &&
            rp.length === 4 && !rp.some(r => r.regel === 'heizgrenze_hinweis') && !Ro.outs.some(o => o.prop), err ? err.stack : JSON.stringify(rp.map(r => r.regel))); }
    check('Befund 12.10. nachgerechnet (v3): Hinweis-Treffer mit p 0,6 gegen Basisrate 0,857 = -14,0, Skill 1 - 0,16/0,0204 = -6,84 (v4: 0 Punkte, Skill "–")', Math.abs(E.brier(0.6, 6 / 7, 1) + 14.0) < 0.1 && Math.abs((1 - 0.16 / Math.pow(1 - 6 / 7, 2)) + 6.84) < 0.01, E.brier(0.6, 6 / 7, 1).toFixed(2));
    // offener Fall: erster Horizont (30 min) abgeschlossen, Fall noch offen (120 min) -> v4 keine Brier-Summen, kein Skill; v3 schon (Befund "Skill -25 bei 0 Faellen")
    const open4 = runSeq(45, i => boost(i)), open3 = runSeq(45, i => boost(i), null, E.mergeCfg({sv: 3}));
    const T4 = open4.S.sc.tot['quiet_freigabe|v2|s' + E.SCORE_VER], T3 = open3.S.sc.tot['quiet_freigabe|v2|s3'], r4 = E.report(open4.S).find(r => r.regel === 'quiet_freigabe'), r3 = E.report(open3.S, 3).find(r => r.regel === 'quiet_freigabe');
    check('v4: offener Fall veraendert den Skill nicht (Horizont 30 min abgeschlossen, Fall offen bis 120 min): bs/bsRef 0, Faelle 0, Skill "–"; v3 hatte hier schon bs > 0 und einen Skill bei 0 Faellen',
          open4.S.sc.cases.length === 1 && open4.S.sc.cases[0].done.length === 1 && T4.bs === 0 && T4.bsRef === 0 && T4.faelle === 0 && r4.skill === null && T3.bs > 0 && T3.faelle === 0 && r3.skill !== null,
          JSON.stringify({v4: [T4.bs, T4.bsRef, r4.skill], v3: [T3.bs, T3.bsRef, r3.skill]}));
    // Skill erst ab 3 abgeschlossenen, bewerteten Faellen: drei Boost-Episoden (je 150 min Deckel, dann 3 h Pause ohne Lage)
    { let S3 = null; const sk = [];
      for (let k = 0; k < 3; k++) {
          for (let i = 0; i < 330; i++) { const t = k * 330 + i; const o = E.step(S3, i < 150 ? boost(t, {rt: 30 + i}) : inp(T0 + t * MIN, {rt: 0, hz: 0, q: 3, soll: 30, sollKurve: 29.75, vl: 30, rl: 29, pump: 0}), E.mergeCfg({sv: 4, rules: {quiet_freigabe: {pauseMin: 200}}})); S3 = o.S;
                                    if (o.scores.some(s => s.typ === 'ausloeser' && s.regel === 'quiet_freigabe')) { const r = E.report(S3, 4).find(x => x.regel === 'quiet_freigabe'); sk.push([r.bewertet, r.skill]); } }
      }
      check('v4 (cfg.sv = 4): Skill erst ab 3 abgeschlossenen, bewerteten Faellen (nach Fall 1 und 2 "–", nach Fall 3 eine Zahl; v5 siehe S13: hier lernt die Basisrate b >= p, die Treffer sind neutral)', sk.length === 3 && sk[0][1] === null && sk[1][1] === null && sk[2][0] === 3 && sk[2][1] !== null, JSON.stringify(sk)); }
    // S13 (Bewertungsregeln v5, Weg b, Entscheidung des Nutzers 12.10.): Treffer bei b >= p neutral, Fehlalarm voll im Abzug, b < p unveraendert
    { const H = E.hPunkte;
      check('v5 je Horizont: Treffer bei b >= p = 0 Punkte ohne Skill-Beitrag (b 0,92/p 0,7 und b = p); Fehlalarm bei b >= p = Abzug gegen b 0,5 (p 0,7 -> -24, p 0,8 -> -39) statt Brier-Plus (v4: b 0,92/p 0,7 Fehlalarm +35,6); b < p unveraendert',
            H(0.7, 0.92, 1, 5).pts === 0 && H(0.7, 0.92, 1, 5).bRef === null && H(0.7, 0.7, 1, 5).pts === 0 && Math.abs(H(0.7, 0.92, 0, 5).pts + 24) < 1e-9 && Math.abs(H(0.8, 0.99, 0, 5).pts + 39) < 1e-9 &&
            Math.abs(H(0.7, 0.92, 0, 4).pts - 35.64) < 1e-9 && Math.abs(H(0.7, 0.92, 1, 4).pts + 8.36) < 1e-9 && [0, 0.18, 0.5, 0.69].every(b => [0, 1].every(o => H(0.7, b, o, 5).pts === H(0.7, b, o, 4).pts && H(0.7, b, o, 5).bp === '')),
            [H(0.7, 0.92, 1, 5).pts, H(0.7, 0.92, 0, 5).pts, H(0.7, 0.92, 0, 4).pts.toFixed(2), H(0.7, 0.92, 1, 4).pts.toFixed(2)].join(' / '));
      const ev5 = (p, b, f) => f * H(p, b, 1, 5).pts + (1 - f) * H(p, b, 0, 5).pts;
      check('v5 kein Gaming: ohne Trennschaerfe (Ergebnis-Haeufigkeit f = Basisrate b) im Mittel <= 0 Punkte, auch bei b >= p (dort nur Abzuege moeglich); b 0,1..0,99, p 0,6..0,8',
            [0.1, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99].every(b => [0.6, 0.7, 0.8].every(p => ev5(p, b, b) <= 1e-9)), [0.5, 0.9].map(b => 'b' + b + ':' + ev5(0.7, b, b).toFixed(1)).join(' '));
      const seed = (k, n) => { const S0 = E.newState(T0 - MIN); S0.sc.base['quiet_freigabe|v2'] = {30: [n, k], 60: [n, k], 120: [n, k]}; return S0; };    // gelernte Basisrate vorgeben (k von n "bleibt")
      const fall = R0 => allSc(R0).find(s => s.typ === 'ausloeser' && s.regel === 'quiet_freigabe');
      const hi5 = runSeq(160, i => boost(i), seed(19, 20)), hi4 = runSeq(160, i => boost(i), seed(19, 20), E.mergeCfg({sv: 4}));
      const a5 = fall(hi5), a4 = fall(hi4), rp5 = E.report(hi5.S).find(r => r.regel === 'quiet_freigabe');
      check('v5 Ablauf: Quiet-Freigabe bleibt 150 min am Deckel bei gelernter Basisrate 0,91 >= p 0,8 -> Treffer, 0 Punkte, alle Horizonte "neutral", Kennzahl trefferNeutral 1, kein Skill-Beitrag; cfg.sv = 4 rechnet denselben Fall nach (Treffer mit Minus, Datensatz sv 4)',
            a5 && a5.ergebnis === 'treffer' && a5.punkte === 0 && a5.sv === 5 && a5.horizonte.every(h => h.bp === 'neutral' && h.punkte === 0) && a5.treffer_neutral === 1 && /Basisrate 0,9\d ≥ Prognose 0,80: neutral/.test(a5.text) &&
            rp5.trefferNeutral === 1 && rp5.skillFaelle === 0 && rp5.skill === null && hi5.S.sc.tot['quiet_freigabe|v2|s5'].bs === 0 && a4 && a4.sv === 4 && a4.punkte < 0 && !a4.horizonte.some(h => h.bp) && hi4.outs[5].rec.sv === 4,
            (a5 && a5.punkte) + ' / v4 ' + (a4 && a4.punkte));
      const lo5 = runSeq(160, i => boost(i, i >= 15 ? {vl: 38, rl: 35.5} : {}), seed(19, 20)), lo4 = runSeq(160, i => boost(i, i >= 15 ? {vl: 38, rl: 35.5} : {}), seed(19, 20), E.mergeCfg({sv: 4}));
      const f5 = fall(lo5), f4 = fall(lo4);
      check('v5 Ablauf: Fehlalarm (Problem loest sich nach 5 min) bei Basisrate 0,91 >= p 0,8 -> voller Abzug -39 (wie gegen b 0,5), Horizonte "abzug", geht in den Skill ein; v4 gab dafuer +' + E.de(f4 && f4.punkte, 1),
            f5 && f5.ergebnis === 'fehlalarm' && Math.abs(f5.punkte + 39) < 0.01 && f5.horizonte.every(h => h.bp === 'abzug') && E.report(lo5.S).find(r => r.regel === 'quiet_freigabe').skillFaelle === 1 && f4 && f4.punkte > 0, (f5 && f5.punkte) + ' / v4 ' + (f4 && f4.punkte));
      const b5 = fall(runSeq(160, i => boost(i), seed(1, 20))), b4 = fall(runSeq(160, i => boost(i), seed(1, 20), E.mergeCfg({sv: 4})));
      check('v5 Ablauf: b < p (gelernte Basisrate 0,09) -> Brier wie bisher, Treffer = v4 (+' + E.de(b5 && b5.punkte, 2) + '), kein Horizont neutral', b5 && b4 && b5.punkte === b4.punkte && b5.punkte > 50 && !b5.horizonte.some(h => h.bp) && !b5.treffer_neutral, (b5 && b5.punkte) + ' / ' + (b4 && b4.punkte));
      // Versionswechsel v4 -> v5 mitten in einem offenen Fall: der Fall endet mit v4 (Brier gegen b, "|s4"), die v5-Summen beginnen bei 0
      const W4 = runSeq(60, i => boost(i), seed(19, 20), E.mergeCfg({sv: 4})), W5 = runSeq(100, i => boost(60 + i), W4.S), aw = fall(W5);
      check('Versionswechsel v4 -> v5: offener Fall endet mit v4 (sv 4, Brier gegen b, unter "quiet_freigabe|v2|s4"), v5-Summen der Regel bleiben leer, Datensaetze ab dem Wechsel sv 5',
            aw && aw.sv === 4 && aw.punkte < 0 && !aw.horizonte.some(h => h.bp) && W5.S.sc.tot['quiet_freigabe|v2|s4'].faelle === 1 && W5.S.sc.tot['quiet_freigabe|v2|s5'].faelle === 0 && W5.outs[0].rec.sv === 5 && E.report(W5.S).find(r => r.regel === 'quiet_freigabe').sv === 5,
            aw && (aw.sv + ' ' + aw.punkte)); }
    const src = fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8'), bewertung = src.slice(src.indexOf('// ------------------------------------------------------------------ Punktesystem'), src.indexOf('// ------------------------------------------------------------------ Ein-Klick'));
    check('Verwerfen ist keine Bewertung: der Bewertungsteil des Kerns kennt weder Klicks noch den Uebernahme-Zustand (keine Nutzereingabe in den Punkten)', bewertung.length > 1000 && !/verworfen|lastClick|applyRequest|uebernehmen/.test(bewertung), bewertung.length + ' Zeichen geprueft');
}

// ================================================================== Nachpruefung 10.10. abends (gefundene Luecken, je mit Test)
console.log('--- Nachpruefung: Ruecklese-Timeout, Flackern des Raumvorschlags');
{
    // L1: Ruecklese-Timeout, Anlage blieb nachweislich auf dem Ausgangswert -> Uebernahme endet (blockierte sonst die Groesse fuer jeden weiteren Klick)
    const NOWx = T0 + 600 * MIN;
    const A = E.newApply(); A.pending = {name: 'SetQuietMode', value: 0, ts: NOWx - 100000, versuche: 3, art: 'uebernahme', id: 'q'}; A.aktiv = {id: 'q', rule: 'quiet_freigabe', groesse: 'quiet', name: 'SetQuietMode', value: 0, von: 3, ts: NOWx - 300000, bis: null, bestaetigt: false};
    const t1 = E.applyTick(JSON.parse(JSON.stringify(A)), {now: NOWx, plant: {q: 3, hpAge: 0.3, block: 0}});
    check('Ruecklese-Timeout, Anlage steht weiter auf dem Ausgangswert: Warnung, Uebernahme beendet (kein Dauerblock der Groesse Quiet), kein Befehl', t1.send.length === 0 && t1.A.aktiv === null && /Keine Bestätigung/.test(t1.A.alarm.text), JSON.stringify(t1.A.aktiv));
    const t2 = E.applyTick(JSON.parse(JSON.stringify(A)), {now: NOWx, plant: {q: 2, hpAge: 0.3, block: 0}});
    check('Ruecklese-Timeout, Anlage meldet einen dritten Wert: Uebernahme bleibt (unbestaetigt), "Zurücksetzen" moeglich', t2.send.length === 0 && t2.A.aktiv && t2.A.aktiv.unbestaetigt === true, JSON.stringify(t2.A.aktiv));
    const pq = {id: 'quiet_freigabe@x', rule: 'quiet_freigabe', ver: 1, art: 'befehl', ts: NOWx, bis: NOWx + 60 * MIN, cmd: {name: 'SetQuietMode', topic: 'panasonic_heat_pump/commands/SetQuietMode', value: 0}, von: 3, was: 'x'}; pq.sum = E.checksum(pq);
    const c3 = E.applyRequest(t1.A, {topic: 'uebernehmen', payload: {id: pq.id, sum: pq.sum}}, {now: NOWx + 11 * MIN, enabled: true, rules: ['quiet_freigabe'], eng: {ts: NOWx + 11 * MIN, prop: pq, locks: {}}, plant: {q: 3, hpAge: 0.3, block: 0}});
    check('... danach ist ein neuer Klick fuer Quiet wieder moeglich (nicht "schon eine Übernahme aktiv")', c3.send.length === 1, c3.toast && c3.toast.text);
    // L2: Raumvorschlag flackert eine Minute auf 0 -> kein Rueckweg-Grund; erst nach 15 min am Stueck
    const kz = v => ({v: v, code: 'x', distrib: false, lead: 'Kinderzimmer oben'});
    const R = runSeq(40, i => inp(T0 + i * MIN, {shift: 1, soll: 31, korr: kz(i === 5 ? 0 : (i >= 20 ? 0 : 1))}));
    check('Raumvorschlag flackert 1 min auf 0: kein Rueckweg-Grund fuer die Raumregel; 15 min am Stueck 0: Grund gesetzt', !R.outs[5].ende.raum_offset && !R.outs[6].ende.raum_offset && !R.outs[33].ende.raum_offset && /seit 15 min wieder 0 K/.test(R.outs[35].ende.raum_offset || ''), R.outs[35].ende.raum_offset);
}

// ================================================================== (c2) Klickweg vollstaendig (13.10.): jede Stufe der Pruefkette einzeln, Grenzwerte, Ruecklesen, Wiederholung, Rueckweg
console.log('--- (c2) Klickweg: jede Stufe der Pruefkette einzeln, Ruecklesen, Wiederholung, Rueckweg');
{
    const NC = T0 + 900 * MIN, TOPS = 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature', TOPQ = 'panasonic_heat_pump/commands/SetQuietMode';
    const mkP = o => { const p = Object.assign({id: 'raum_offset@k', rule: 'raum_offset', ver: 2, art: 'befehl', ts: NC - MIN, bis: NC + 60 * MIN, cmd: {name: 'SetZ1HeatRequestTemperature', topic: TOPS, value: 1}, von: 0, was: 'Heizkurve 0 → +1 K'}, o || {}); p.sum = E.checksum(p); return p; };
    // Grundfall: alle Stufen erfuellt. mut(b) veraendert genau eine Stufe; gibt sie eine Anfrage zurueck, wird diese geschickt (sonst ID + Pruefsumme des gespeicherten Vorschlags).
    const click = (mut, A0) => {
        const b = {A: A0 || E.newApply(), p: mkP(), ctx: {now: NC, enabled: true, knoten: true, rules: ['raum_offset'], eng: {ts: NC - 30000, prop: null, locks: {}}, plant: {q: 0, shift: 0, hpAge: 0.3, block: 0, heatMode: 0, z1Sensor: 0}, cfg: cfg}};
        b.ctx.eng.prop = b.p;
        let req = null; if (mut) { req = mut(b) || null; }
        if (!req) { req = {topic: 'uebernehmen', payload: {id: b.ctx.eng.prop ? b.ctx.eng.prop.id : b.p.id, sum: b.ctx.eng.prop ? b.ctx.eng.prop.sum : b.p.sum}}; }
        return E.applyRequest(b.A, req, b.ctx);
    };
    const neu = (b, o) => { b.p = mkP(o); b.ctx.eng.prop = b.p; };                     // anderer, korrekt gepruefsummter Vorschlag
    const g = click();
    check('Klickweg Grundfall: alle Stufen erfuellt -> genau ein Befehl (Whitelist-Topic, Wert als Text, Quelle "Optimierer (Klick)"), Protokoll "gesendet" mit ID/Pruefsumme, Rueckweg nach maxDauerMin (6 h), wartet auf Bestaetigung',
          g.send.length === 1 && g.send[0].topic === TOPS && g.send[0].payload === '1' && g.send[0].source === 'Optimierer (Klick)' && g.log.length === 1 && g.log[0].ergebnis === 'gesendet' && g.log[0].sum === mkP().sum && g.A.aktiv.bis === NC + 360 * MIN && g.A.pending.art === 'uebernahme' && g.A.n === 1, JSON.stringify(g.send));
    const STUFEN = [
        ['Doppelklick (gleiche ID vor 1 min)', b => { b.A.lastClick = {id: b.p.id, ts: NC - MIN}; }, /Doppelklick/],
        ['Hauptschalter aus', b => { b.ctx.enabled = false; }, /Hauptschalter/],
        ['Hauptschalter nur Boolesch true ("true" als Text)', b => { b.ctx.enabled = 'true'; }, /Hauptschalter/],
        ['Sendeknoten deaktiviert erzeugt (KNOTEN = false)', b => { b.ctx.knoten = false; }, /Sendeknoten/],
        ['Maschine rechnet nicht (Stand 3 min alt)', b => { b.ctx.eng.ts = NC - 3 * MIN; }, /nicht gerechnet/],
        ['Maschine ohne Zeitstempel', b => { delete b.ctx.eng.ts; }, /nicht gerechnet/],
        ['andere Vorschlags-ID', b => ({topic: 'uebernehmen', payload: {id: 'raum_offset@alt', sum: b.p.sum}}), /nicht mehr aktuell/],
        ['kein Vorschlag mehr', b => { b.ctx.eng.prop = null; }, /nicht mehr aktuell/],
        ['falsche Pruefsumme vom Browser', b => ({topic: 'uebernehmen', payload: {id: b.p.id, sum: 'deadbeef'}}), /Prüfsumme/],
        ['gespeicherter Vorschlag nachtraeglich veraendert (Wert 1 -> -1, alte Pruefsumme)', b => { b.p.cmd.value = -1; }, /Prüfsumme/],
        ['nur Hinweis (art)', b => { b.p.art = 'hinweis'; }, /nur ein Hinweis/],
        ['Regel nicht freigegeben', b => { b.ctx.rules = ['quiet_freigabe']; }, /nicht freigegeben/],
        ['Freigabeliste fehlt', b => { delete b.ctx.rules; }, /nicht freigegeben/],
        ['Vorschlag abgelaufen (jetzt = gueltig bis)', b => { neu(b, {bis: NC}); }, /abgelaufen/],
        ['Befehl nicht auf der Whitelist (SetHeatingControl)', b => { neu(b, {cmd: {name: 'SetHeatingControl', topic: 'panasonic_heat_pump/commands/SetHeatingControl', value: 1}}); }, /nicht auf der Whitelist/],
        ['Wert ausserhalb (Verschiebung +2)', b => { neu(b, {cmd: {name: 'SetZ1HeatRequestTemperature', topic: TOPS, value: 2}}); }, /nicht erlaubt/],
        ['Wert ausserhalb (Quiet 4)', b => { neu(b, {rule: 'quiet_strecken', cmd: {name: 'SetQuietMode', topic: TOPQ, value: 4}}); b.ctx.rules = ['quiet_strecken']; }, /nicht erlaubt/],
        ['Ausgangswert ausserhalb (Verschiebung von +2: kein Rueckweg moeglich)', b => { neu(b, {von: 2}); b.ctx.plant.shift = 2; }, /Rückweg unmöglich/],
        ['Topic passt nicht zum Befehl', b => { neu(b, {cmd: {name: 'SetZ1HeatRequestTemperature', topic: TOPQ, value: 1}}); }, /Topic passt nicht/],
        ['MQTT-Notbremse (block_active)', b => { b.ctx.plant.block = 1; }, /MQTT\.block_active/],
        ['HeishaMon-Daten 6 min alt', b => { b.ctx.plant.hpAge = 6; }, /veraltet/],
        ['HeishaMon-Alter unbekannt', b => { b.ctx.plant.hpAge = null; }, /veraltet/],
        ['Sperre der Regel', b => { b.ctx.eng.locks = {raum_offset: ['Takt-Gefahr']}; }, /Gesperrt: Takt-Gefahr/],
        ['Anlage steht nicht mehr auf dem Ausgangswert', b => { b.ctx.plant.shift = -1; }, /steht nicht mehr auf 0 \(jetzt -1\)/],
        ['Ist-Wert unbekannt', b => { b.ctx.plant.shift = null; }, /jetzt unbekannt/],
        ['nicht im Heizkurvenmodus (TOP76 = 1)', b => { b.ctx.plant.heatMode = 1; }, /Heizkurvenmodus/],
        ['nicht mit Wasserfuehler (TOP111 = 1)', b => { b.ctx.plant.z1Sensor = 1; }, /Heizkurvenmodus/],
        ['Befehl wartet noch auf Bestaetigung', b => { b.A.pending = {name: 'SetQuietMode', value: 0, ts: NC - 30000, versuche: 1, art: 'uebernahme', id: 'q'}; }, /wartet noch/],
        ['Uebernahme derselben Groesse aktiv (andere Regel)', b => { b.A.aktiv = {id: 'v', rule: 'vorausschau', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: -1, von: 0, ts: NC - 60 * MIN, bis: NC + 60 * MIN, bestaetigt: true}; }, /Für die Verschiebung läuft schon eine Übernahme \(Vorausschau −1 K, 0 → -1\)/],
        ['Uebernahme derselben Regel in Gegenrichtung (keine Fortsetzung)', b => { b.A.aktiv = {id: 'r0', rule: 'raum_offset', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: -1, von: 0, ts: NC - 60 * MIN, bis: NC + 60 * MIN, bestaetigt: true}; }, /Für die Verschiebung läuft schon eine Übernahme \(Raumeinfluss ±1 K, 0 → -1\)/],
        ['Rate: letzter Befehl vor 9 min', b => { b.A.lastSend = NC - 9 * MIN; }, /Zu schnell/],
        ['Tageslimit: 6 Befehle heute', b => { b.A.day = E.ymd(NC); b.A.n = 6; }, /Tageslimit/]
    ];
    const rs = STUFEN.map(s => { const r = click(s[1]); return [s[0], r.send.length === 0 && !!r.toast && s[2].test(r.toast.text) && r.log.length === 1 && r.log[0].ergebnis === 'abgelehnt' && r.A.n === (s[0].indexOf('Tageslimit') === 0 ? 6 : 0) && !r.A.pending === (s[0].indexOf('wartet') < 0), r.toast && r.toast.text]; });
    check('Klickweg: jede der ' + STUFEN.length + ' Stufen lehnt EINZELN ab (alle anderen erfuellt): nichts gesendet, Meldung mit Grund, Protokoll "abgelehnt", Zaehler unveraendert', rs.every(x => x[1]), rs.filter(x => !x[1]).map(x => x[0] + ': ' + x[2]).join(' | ') || rs.length + ' Stufen');
    const GRENZ = [
        ['Maschine genau 2,5 min alt', b => { b.ctx.eng.ts = NC - 2.5 * MIN; }],
        ['HeishaMon genau 5 min alt', b => { b.ctx.plant.hpAge = 5; }],
        ['Rate: letzter Befehl genau vor 10 min', b => { b.A.lastSend = NC - 10 * MIN; }],
        ['Tageslimit von gestern (6) zaehlt heute nicht', b => { b.A.day = E.ymd(NC - 24 * 60 * MIN); b.A.n = 6; }],
        ['Doppelklick-Sperre nach 2 min vorbei', b => { b.A.lastClick = {id: b.p.id, ts: NC - 2 * MIN}; }],
        ['Sendeknoten-Angabe fehlt (aeltere Huelle: kein Schalter)', b => { delete b.ctx.knoten; }]
    ];
    const rg = GRENZ.map(s => { const r = click(s[1]); return [s[0], r.send.length === 1, r.toast && r.toast.text]; });
    check('Klickweg Grenzwerte: genau an der Grenze bzw. ausserhalb der Sperre wird gesendet (' + GRENZ.length + ' Faelle)', rg.every(x => x[1]), rg.filter(x => !x[1]).map(x => x[0] + ': ' + x[2]).join(' | ') || '');
    const un = E.applyRequest(null, {topic: 'irgendwas', payload: {}}, {now: NC, enabled: true, knoten: true}), z0 = E.applyRequest(null, {topic: 'zuruecksetzen', payload: {}}, {now: NC, plant: {shift: 1, hpAge: 0.3, block: 0}});
    const Az = E.newApply(); Az.aktiv = {id: 'r', rule: 'raum_offset', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: 1, von: 0, ts: NC - 60 * MIN, bis: NC + 60 * MIN, bestaetigt: true};
    const zB = E.applyRequest(JSON.parse(JSON.stringify(Az)), {topic: 'zuruecksetzen', payload: {}}, {now: NC, plant: {shift: 1, hpAge: 0.3, block: 1}});
    const z1 = E.applyRequest(JSON.parse(JSON.stringify(Az)), {topic: 'zuruecksetzen', payload: {}}, {now: NC, plant: {shift: 1, hpAge: 0.3, block: 0}}), z2 = E.applyRequest(z1.A, {topic: 'zuruecksetzen', payload: {}}, {now: NC + 20000, plant: {shift: 1, hpAge: 0.3, block: 0}});
    check('Weitere Aktionen: unbekannte Aktion abgelehnt; Zuruecksetzen ohne Uebernahme abgelehnt, bei Notbremse abgelehnt, sonst genau ein Befehl auf den Ausgangswert (Quelle "Rückweg"), ein zweiter Klick waehrend des Rueckwegs sendet nicht noch einmal',
          un.send.length === 0 && /Unbekannte Aktion/.test(un.toast.text) && z0.send.length === 0 && /keine aktive Übernahme/.test(z0.toast.text) && zB.send.length === 0 && /block_active/.test(zB.toast.text) &&
          z1.send.length === 1 && z1.send[0].payload === '0' && z1.send[0].source === 'Optimierer (Rückweg)' && z2.send.length === 0 && /läuft bereits/.test(z2.toast.text), [un.toast.text, z0.toast.text, zB.toast.text, z2.toast.text].join(' | '));
    // Ruecklesen: Bestaetigung nur mit frischen Daten; Wiederholung erst nach 90 s, hoechstens 2; dann Warnung
    const Ap = g.A, tick = (A, t, plant, o) => E.applyTick(A, Object.assign({now: t, eng: {ts: t}, plant: Object.assign({q: 0, shift: 0, hpAge: 0.3, block: 0, heatMode: 0, z1Sensor: 0}, plant)}, o || {}));
    const r1 = tick(JSON.parse(JSON.stringify(Ap)), NC + 20000, {shift: 1, hpAge: 7}), r2 = tick(JSON.parse(JSON.stringify(Ap)), NC + 20000, {shift: 1});
    check('Ruecklesen: Anlage meldet den Zielwert, aber mit veralteten Daten (7 min) -> keine Bestaetigung; mit frischen Daten -> bestaetigt (gruene Meldung, Protokoll "bestaetigt")',
          r1.A.pending && !r1.A.aktiv.bestaetigt && r1.send.length === 0 && !r2.A.pending && r2.A.aktiv.bestaetigt === true && r2.toast.color === 'green' && r2.log[0].aktion === 'bestaetigt', '');
    let Aw = JSON.parse(JSON.stringify(Ap)), sW = [];
    [89, 90, 179, 180, 269, 270, 400].forEach(sec => { const r = tick(Aw, NC + sec * 1000, {shift: 0}); Aw = r.A; sW.push(sec + ':' + r.send.length); });
    check('Wiederholung: erst nach 90 s ohne Bestaetigung, hoechstens 2 (insgesamt 3 Befehle), danach rote Warnung; Anlage steht nachweislich auf dem Ausgangswert -> Uebernahme beendet',
          sW.join(',') === '89:0,90:1,179:0,180:1,269:0,270:0,400:0' && /Keine Bestätigung/.test(Aw.alarm.text) && !Aw.pending && Aw.aktiv === null, sW.join(','));
    // Rueckweg: nach Ablauf (gehoert zum geklickten Vorschlag), nur mit frischen Daten; ohne Bestaetigung hoechstens 3 Versuche, kein endloser Neustart
    const Ar = E.newApply(); Ar.aktiv = {id: 's', rule: 'quiet_strecken', groesse: 'quiet', name: 'SetQuietMode', value: 3, von: 0, ts: NC - 5 * 3600000, bis: NC - 1, bestaetigt: true};
    const rv = tick(JSON.parse(JSON.stringify(Ar)), NC, {q: 3, hpAge: 7}), rw = tick(JSON.parse(JSON.stringify(Ar)), NC, {q: 3});
    check('Rueckweg nach Ablauf: mit veralteten Daten kein Befehl; mit frischen genau einer auf den Ausgangswert (Quelle "Rückweg", Grund im Protokoll)', rv.send.length === 0 && rw.send.length === 1 && rw.send[0].payload === '0' && rw.send[0].source === 'Optimierer (Rückweg)' && /nach Ablauf/.test(rw.log[0].grund), '');
    let Ax = rw.A, nS = 1, alarmT = null, logs = 0;
    for (let s = 15; s <= 2 * 3600; s += 15) { const r = tick(Ax, NC + s * 1000, {q: 3}); Ax = r.A; nS += r.send.length; logs += r.log.length; if (!alarmT && Ax.alarm && /Keine Bestätigung/.test(Ax.alarm.text)) { alarmT = s; } }
    check('Rueckweg ohne Bestaetigung (Anlage bleibt auf 3): hoechstens 3 Befehle, dann rote Warnung und KEIN automatischer Neustart (2 h lang kein weiterer Befehl, kein Protokoll-Rauschen); vorher alle 4,5 min wieder 3 Befehle',
          nS === 3 && alarmT !== null && alarmT <= 300 && Ax.aktiv && Ax.aktiv.rueckFehl && !Ax.pending && logs === 3, 'Befehle ' + nS + ', Warnung nach ' + alarmT + ' s, Protokoll ' + logs);
    const zM = E.applyRequest(JSON.parse(JSON.stringify(Ax)), {topic: 'zuruecksetzen', payload: {}}, {now: NC + 2 * 3600000 + 5000, plant: {q: 3, hpAge: 0.3, block: 0}});
    const nb = tick(JSON.parse(JSON.stringify(Ax)), NC + 2 * 3600000 + 5000, {q: 0}), fr = tick(JSON.parse(JSON.stringify(Ax)), NC + 2 * 3600000 + 5000, {q: 2});
    check('... danach: "Zurücksetzen" von Hand sendet wieder (ein Befehl); meldet die Anlage spaeter den Ausgangswert, endet die Uebernahme ("nachträglich bestätigt"); ein dritter Wert beendet sie als fremde Aenderung, nie ein Befehl',
          zM.send.length === 1 && zM.send[0].payload === '0' && nb.A.aktiv === null && nb.send.length === 0 && /nachträglich bestätigt/.test(nb.toast.text) && fr.A.aktiv === null && fr.send.length === 0 && /von außen auf 2/.test(fr.toast.text), '');
    const Au = E.newApply(); Au.aktiv = {id: 'u', rule: 'raum_offset', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: 1, von: 2, ts: NC - 7 * 3600000, bis: NC - 1, bestaetigt: true};
    let nU = 0, lU = 0, Au2 = Au; for (let s = 0; s < 600; s += 15) { const r = tick(Au2, NC + s * 1000, {shift: 1}); Au2 = r.A; nU += r.send.length; lU += r.log.length; }
    check('Rueckweg unmoeglich (Ausgangswert ausserhalb der Whitelist, alter Zustand): einmal rote Warnung und Protokoll, danach Ruhe (kein Befehl, keine Meldung je Takt)', nU === 0 && lU === 1 && /Rückweg unmöglich/.test(Au2.alarm.text) && Au2.aktiv.rueckFehl, 'Protokolle ' + lU);
}

// ================================================================== (d) Vorausschau ±1 K und Verschiebungs-Arbitrierung (keine Regel beisst eine andere)
console.log('--- (d) Vorausschau und Verschiebungs-Arbitrierung');
const VSK = {up: [10, 10, 9, 8, 7, 7, 7], down: [8, 8, 9, 10.5, 11, 11, 11], flat: [10, 10, 10, 10, 10, 10, 10]};   // gegen den Tagesgang 10 °C: Bedarf +2,25 K / -2,38 K / 0 K
const vsx = (at, o) => Object.assign({age: 10, at: at, n: 12, minDays: 10, gate: 1, ua: 0.22, tbal: 15, aktiv: 0}, o || {});
const kx = (v, lead) => ({v: v, code: v ? (v > 0 ? 'Raum unter Minimum' : 'Überschreitung') : 'alle im Band', distrib: false, lead: lead || 'Kinderzimmer oben'});
function seedS(val, t) {                                                         // Zustand mit 8 Tagen gemessenem Tagesgang (konstant val °C, bzw. val(Stunde)), Maschine "neu gestartet" zu t
    t = t || T0; const S = E.newState(t), H = 3600000;
    for (let k = 8 * 24; k >= 1; k--) { const hs = Math.floor((t - k * H) / H) * H, v = typeof val === 'function' ? val(hs) : val; S.atH.push([hs, v * 60, 60, 0, 0]); }
    return S;
}
function runD(n, f, S0, c) {                                                      // wie runSeq (mit Tagesgang 10 °C), haelt aber je Minute eine Kopie der Verschiebungs-Vorschlaege fest
    const R = {S: S0 === undefined ? seedS(10) : S0, outs: []};
    for (let i = 0; i < n; i++) { const o = E.step(R.S, f(i), c || cfg); R.S = o.S; o.snap = {raum_offset: o.S.rules.raum_offset.prop ? JSON.parse(JSON.stringify(o.S.rules.raum_offset.prop)) : null, vorausschau: o.S.rules.vorausschau.prop ? JSON.parse(JSON.stringify(o.S.rules.vorausschau.prop)) : null}; R.outs.push(o); }
    return R;
}
const shiftProps = R => { const L = []; R.outs.forEach((o, i) => o.res.forEach(r => { if (r.neu && (r.id === 'raum_offset' || r.id === 'vorausschau')) { L.push({i: i, rule: r.id, p: o.snap[r.id]}); } })); return L; };
const twoShift = R => R.outs.some(o => o.snap.raum_offset && o.snap.vorausschau);
const stAt = (R, i, id) => r0(R.outs[i], id);
const allScores = R => [].concat.apply([], R.outs.map(o => o.scores));
{
    // Regelwerk (Review-Paket 13.10.2026: Vorausschau v2 nur noch -1 K; Begruendung im Zweck-Text)
    const RV = E.RULE.vorausschau;
    check('Regelwerk: Vorausschau v2 ist Befehlsregel der Groesse "shift" (nur -1 K, Richtung soll_runter, eigene Basisrate "vorausschau|v2") mit Sperren Modell-Gate, Vorrang, Gegenrichtung; der Zweck nennt, warum +1 K gestrichen ist (Kurve wird alle 5 min nachgefuehrt, Raeume bei Kaelte ueber der Bandmitte, Hochlauf +48 %); Raumeinfluss v2 nimmt an der Arbitrierung teil',
          RV && RV.ver === 2 && RV.groesse === 'shift' && RV.art === 'befehl' && RV.richtung === 'soll_runter' && RV.basis === 'vorausschau|v2' && RV.kurz === 'Vorausschau −1 K' && /ohne den Zweig \+1 K/.test(RV.zweck) && /alle 5 min/.test(RV.zweck) && /Bandmitte/.test(RV.zweck) && /\+48 %/.test(RV.zweck) &&
          ['modell', 'vorrang', 'gegenrichtung'].every(x => RV.sperren.includes(x)) && E.RULE.raum_offset.ver === 2 && ['vorrang', 'gegenrichtung'].every(x => E.RULE.raum_offset.sperren.includes(x)) && RV.befehl.name === 'SetZ1HeatRequestTemperature', RV.sperren.join(','));
    const iVs = E.RULES.findIndex(x => x.id === 'vorausschau');
    // Gate geschlossen: nie ein Vorschlag, nur Anzeige; Vergleichslagen fuer die Basisrate laufen trotzdem mit
    let R = runD(300, i => inp(T0 + i * MIN, {vs: vsx(VSK.down, {gate: 0, n: 1})}));
    const rg = stAt(R, 100, 'vorausschau');
    check('Gate geschlossen (1 von 10 Tagen): 300 min mit Vorhersage Milderung −2,4 K und Raeumen im Band -> kein Vorschlag, Status "gesperrt" (modell), Grund nennt die Tage, keine Faelle/Punkte',
          !R.outs.some(o => o.res.some(r => r.id === 'vorausschau' && r.neu)) && rg.st === 'gesperrt' && JSON.stringify(rg.locks) === '["modell"]' && /^würde schalten, aber gesperrt: Gebäudemodell noch nicht freigegeben \(1 von 10 Tagen\)$/.test(rg.grund) && !allScores(R).some(s => s.regel === 'vorausschau') && !R.S.sc.cases.some(c => c.rule === 'vorausschau'), rg.grund);
    check('Gate geschlossen: Vergleichslagen (Basisrate, Schluessel "vorausschau|v2") werden trotzdem gesammelt (ohne Wertung), Datensatz traegt die Vorhersage', R.S.sc.cands.some(c => c.rule === 'vorausschau' && c.bk === 'vorausschau|v2') && R.outs[100].rec.in.vs && R.outs[100].rec.in.vs.gate === 0 && R.outs[100].rec.r[iVs].id === 'vorausschau' && R.outs[100].rec.r[iVs].sperren[0] === 'modell', JSON.stringify(R.outs[100].rec.in.vs));
    R = runD(60, i => inp(T0 + i * MIN, {vs: vsx(VSK.down, {gate: 0, n: 1}), rooms: rooms({ki_oben: 22.2})}));
    check('Gate geschlossen und Bedingung fehlt: Grund nennt beides ("außerdem …")', /^gesperrt: Gebäudemodell .*; außerdem Kinderzimmer oben nur 0,2 K über Minimum$/.test(stAt(R, 59, 'vorausschau').grund), stAt(R, 59, 'vorausschau').grund);
    // Gate offen
    R = runD(60, i => inp(T0 + i * MIN, {vs: vsx(VSK.down)}));
    const pd = R.outs[30].snap.vorausschau;
    check('Gate offen, Vorhersage Milderung −2,4 K, alle Raeume im Band mit Luft: 30 min Haltezeit, dann Vorschlag −1 K (SetZ1HeatRequestTemperature = -1, von 0, Soll 30 -> 29 °C, Untergrenze 29 eingehalten)', stAt(R, 20, 'vorausschau').st === 'wartet' && shiftProps(R).length === 1 && shiftProps(R)[0].i === 30 && pd.cmd.value === -1 && pd.von === 0 && pd.dir === 'soll_runter' && /Bedarf -2,4 K/.test(pd.warum) && /Soll-Vorlauf 30 → 29/.test(pd.was), pd && (pd.was + ' | ' + pd.warum));
    R = runD(60, i => inp(T0 + i * MIN, {vs: vsx(VSK.up)}));
    check('v2: +1 K gestrichen - Vorhersage Mehrbedarf +2,3 K bei Raeumen im Band mit Luft -> kein Vorschlag, Grund "vor Mehrbedarf seit v2 keine Verschiebung"', shiftProps(R).length === 0 && stAt(R, 59, 'vorausschau').st === 'bereit' && /Bedarf \+2,3 K \(Schwelle −2,0 K; vor Mehrbedarf seit v2 keine Verschiebung\)/.test(stAt(R, 59, 'vorausschau').grund), stAt(R, 59, 'vorausschau').grund);
    R = runD(60, i => inp(T0 + i * MIN, {vs: vsx(VSK.down), soll: 29.5, sollKurve: 29.5}));
    check('-1 K nie unter 29 °C Soll-Vorlauf', shiftProps(R).length === 0 && /Soll-Vorlauf würde 28,5|Soll-Vorlauf würde 29 °C|würde 28/.test(stAt(R, 59, 'vorausschau').grund), stAt(R, 59, 'vorausschau').grund);
    R = runD(60, i => inp(T0 + i * MIN, {vs: vsx(VSK.down), rooms: rooms({ki_oben: 22.2})}));
    check('-1 K nur mit Luft nach unten: kaeltester Raum 0,2 K ueber Minimum -> kein Vorschlag', shiftProps(R).length === 0 && /Kinderzimmer oben nur 0,2 K über Minimum/.test(stAt(R, 59, 'vorausschau').grund), stAt(R, 59, 'vorausschau').grund);
    R = runD(120, i => inp(T0 + i * MIN, {vs: vsx(VSK.down), rooms: rooms({ki_oben: i >= 50 ? 21.9 : 22.6})}));
    check('Nie gegen den Raumzustand: laufender −1-K-Vorschlag endet in DERSELBEN Minute, in der ein Raum unter das Minimum faellt (harte Bedingung, keine 3 min Nachlauf)', R.outs[49].snap.vorausschau && R.outs[50].prop === null && R.outs[50].ev.some(e => e[0] === 'optimierer_ende' && /vorausschau: Bedingung entfallen: Kinderzimmer oben außerhalb des Bandes/.test(e[1])) && shiftProps(R).length === 1, R.outs[50].ev.map(e => e[1]).join(' | '));
    // Prioritaet: Komfort-Notfall des Raums schlaegt die Vorausschau
    R = runD(150, i => inp(T0 + i * MIN, {vs: vsx(VSK.down), korr: kx(1), rooms: rooms({ki_oben: 21.5})}));
    check('Prioritaet: Raum unter Minimum (Komfort-Notfall) -> Vorausschau schlaegt nie -1 K vor, der Raumeinfluss +1 K schon (nach 60 min)', shiftProps(R).length === 1 && shiftProps(R)[0].rule === 'raum_offset' && shiftProps(R)[0].i === 60 && shiftProps(R)[0].p.cmd.value === 1 && stAt(R, 100, 'vorausschau').st === 'bereit', JSON.stringify(shiftProps(R).map(x => [x.i, x.rule, x.p.cmd.value])) + ' / ' + stAt(R, 100, 'vorausschau').grund);
    // Konflikt 1: Vorausschau -1, danach will der Raumeinfluss +1 (ohne Notfall) -> erst nach 240 min Wartezeit
    const k1 = (i, room) => inp(T0 + i * MIN, {vs: vsx(i < 120 ? VSK.down : VSK.flat), korr: kx(1, 'Kinderzimmer oben'), rooms: room ? room(i) : rooms()});
    R = runD(420, i => k1(i));
    let sp = shiftProps(R);
    check('Konflikt −1 (Vorausschau) gegen +1 (Raumeinfluss): waehrend die Vorausschau die Verschiebung hat, ist der Raumeinfluss "gesperrt: andere Regel" - nie zwei Verschiebungs-Vorschlaege gleichzeitig',
          sp[0].rule === 'vorausschau' && sp[0].i === 30 && stAt(R, 90, 'raum_offset').st === 'gesperrt' && stAt(R, 90, 'raum_offset').locks[0] === 'vorrang' && /vorgeschlagen von „Vorausschau −1 K“/.test(stAt(R, 90, 'raum_offset').grund) && !twoShift(R), stAt(R, 90, 'raum_offset').grund);
    check('... Vorausschau endet (Vorhersage flach, 3 min) in Minute 123; Raumeinfluss +1 K: bis 183 Mindesthaltezeit, danach ohne Komfort-Notfall "Gegenrichtung" bis 363, Vorschlag erst in Minute 363',
          sp.length === 2 && sp[1].rule === 'raum_offset' && sp[1].i === 363 && sp[1].p.cmd.value === 1 && /Mindesthaltezeit 60 min/.test(stAt(R, 150, 'raum_offset').grund) && /ohne Komfort-Notfall erst nach 240 min/.test(stAt(R, 200, 'raum_offset').grund) && stAt(R, 200, 'raum_offset').naechste.bis === T0 + 363 * MIN, JSON.stringify(sp.map(x => [x.i, x.rule, x.p.cmd.value])) + ' | ' + stAt(R, 200, 'raum_offset').grund);
    // ... mit Komfort-Notfall (Schlafzimmer 0,4 K unter Minimum): die Vorausschau zieht sofort zurueck, der Raumeinfluss darf nach der Mindesthaltezeit
    R = runD(300, i => k1(i, j => j >= 100 ? [rooms()[0], rooms()[1], {id: 'schlaf', name: 'Schlafzimmer', t: 19.6, age: 10, min: 20, max: 22, valid: true, active: true}] : rooms()));
    sp = shiftProps(R);
    check('Konflikt mit Komfort-Notfall (Raum 0,4 K unter Minimum): Vorausschau endet sofort (Minute 100), Raumeinfluss +1 K nach der gemeinsamen Mindesthaltezeit (Minute 160), nicht frueher',
          sp.length === 2 && sp[0].rule === 'vorausschau' && R.outs[100].snap.vorausschau === null && sp[1].rule === 'raum_offset' && sp[1].i === 160 && stAt(R, 159, 'raum_offset').locks.includes('gegenrichtung') && !twoShift(R), JSON.stringify(sp.map(x => [x.i, x.rule, x.p.cmd.value])));
    // Konflikt 2 (umgekehrt): Raumeinfluss +1, danach will die Vorausschau -1 -> nie mit Notfall, also immer 240 min
    R = runD(450, i => inp(T0 + i * MIN, {vs: vsx(i >= 70 ? VSK.down : VSK.flat), korr: kx(i < 150 ? 1 : 0)}));
    sp = shiftProps(R);
    check('Konflikt +1 (Raumeinfluss) gegen -1 (Vorausschau): erst "andere Regel" (Minute 100), nach dem Ende des Raumeinflusses (Minute 150) "Gegenrichtung", Vorschlag -1 K erst in Minute 390 (240 min, die Vorausschau hat nie einen Notfall)',
          sp.length === 2 && sp[0].rule === 'raum_offset' && sp[0].i === 60 && stAt(R, 100, 'vorausschau').locks[0] === 'vorrang' && stAt(R, 200, 'vorausschau').locks[0] === 'gegenrichtung' && sp[1].rule === 'vorausschau' && sp[1].i === 390 && sp[1].p.cmd.value === -1 && !twoShift(R), JSON.stringify(sp.map(x => [x.i, x.rule, x.p.cmd.value])) + ' | ' + stAt(R, 200, 'vorausschau').grund);
    // gleiche Richtung: Uebergabe statt Hin und Her
    R = runD(200, i => inp(T0 + i * MIN, {vs: vsx(i < 120 ? VSK.down : VSK.flat), korr: kx(-1, 'Schlafzimmer')}));
    sp = shiftProps(R);
    check('Gleiche Richtung: Raumeinfluss will −1, die Vorausschau hat −1 schon vorgeschlagen -> "dieselbe Verschiebung"; endet die Vorausschau (Minute 123), uebernimmt der Raumeinfluss −1 sofort (keine Gegenrichtung, keine Luecke)',
          sp.length === 2 && sp[0].rule === 'vorausschau' && /dieselbe Verschiebung -1 K schlägt schon „Vorausschau −1 K“ vor/.test(stAt(R, 90, 'raum_offset').grund) && sp[1].rule === 'raum_offset' && sp[1].i === 123 && sp[1].p.cmd.value === -1 && !twoShift(R), JSON.stringify(sp.map(x => [x.i, x.rule])) + ' | ' + stAt(R, 90, 'raum_offset').grund);
    // Uebernommene Verschiebung: gehoert der Vorausschau, Raumeinfluss bewertet sie nicht als eigenen Eingriff, Wirkung zaehlt fuer die Vorausschau
    const ap = (i, o) => inp(T0 + i * MIN, Object.assign({vs: vsx(VSK.down), korr: kx(0), shift: i >= 35 ? -1 : 0, soll: i >= 35 ? 29 : 30}, o || {}));
    R = runD(200, i => ap(i, {korr: kx(i >= 40 ? 1 : 0, 'Kinderzimmer oben')}));
    let sc = allScores(R);
    check('Vorschlag −1 K uebernommen (Minute 35): Verschiebung gehoert der Vorausschau (applied), Wirkungsfall "Soll folgt" fuer die Vorausschau, keiner fuer den Raumeinfluss',
          R.S.arb.applied && R.S.arb.applied.rule === 'vorausschau' && sc.some(s => s.typ === 'wirkung' && s.regel === 'vorausschau' && s.punkte === 10) && !sc.some(s => s.typ === 'wirkung' && s.regel === 'raum_offset') && /\(Vorausschau\) steht/.test(stAt(R, 50, 'vorausschau').grund), sc.map(s => s.regel + ':' + s.typ + ':' + s.punkte).join(', '));
    check('... Raumvorschlag +1 K gegen die uebernommene −1 K: "gesperrt: andere Regel", nie ein Vorschlag -1 -> +1/0 (kein Zurueckstellen der fremden Verschiebung)', !shiftProps(R).some(x => x.rule === 'raum_offset') && stAt(R, 150, 'raum_offset').locks[0] === 'vorrang' && /gehört „Vorausschau −1 K“/.test(stAt(R, 150, 'raum_offset').grund), stAt(R, 150, 'raum_offset').grund);
    R = runD(120, i => ap(i));
    check('... Raumvorschlag 0 bei uebernommener −1 K: Raumeinfluss "ruht" (gehoert der Vorausschau), kein Rueckstellen auf 0', stAt(R, 100, 'raum_offset').st === 'inaktiv' && /gehört der Regel „Vorausschau −1 K“/.test(stAt(R, 100, 'raum_offset').grund) && !shiftProps(R).some(x => x.rule === 'raum_offset'), stAt(R, 100, 'raum_offset').grund);
    const cut = allScores(runD(400, i => ap(i))).find(s => s.typ === 'ausloeser');
    check('... der Ausloeser-Fall der Vorausschau selbst wird ab der Uebernahme neutral (Eingriff mit Urheber im Text), die Wirkung wird bewertet', cut && cut.regel === 'vorausschau' && cut.ergebnis === 'neutral' && /Vorschlag „Vorausschau −1 K“ übernommen/.test(cut.text), cut && cut.text);
    // Rueckweg und Uebergabe in der Uebernahme
    R = runD(80, i => ap(i, {vs: vsx(i < 50 ? VSK.down : VSK.flat)}));
    check('Rueckweg-Grund der Vorausschau: Vorhersage zeigt die Milderung 15 min nicht mehr (ab Minute 65), Raum unter Minimum sofort', !R.outs[60].ende.vorausschau && /seit 15 min nicht mehr/.test(R.outs[65].ende.vorausschau || '') && /unter Minimum/.test(E.step(JSON.parse(JSON.stringify(R.S)), ap(80, {rooms: rooms({ki_oben: 21.9})}), cfg).ende.vorausschau || ''), R.outs[65].ende.vorausschau);
    R = runD(80, i => ap(i, {vs: vsx(i < 50 ? VSK.down : VSK.flat), korr: kx(-1, 'Schlafzimmer')}));
    check('Uebergabe: Raumvorschlag verlangt dieselbe −1 K -> kein Rueckweg-Grund, "halten" fuer die Vorausschau', !R.outs[79].ende.vorausschau && /Raumeinfluss verlangt dieselbe Verschiebung \(-1 K\)/.test(R.outs[79].halten.vorausschau || ''), JSON.stringify(R.outs[79].halten));
    const Av = E.newApply(); Av.aktiv = {id: 'v', rule: 'vorausschau', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: -1, von: 0, ts: T0, bis: T0 + 360 * MIN, bestaetigt: true};
    const tk = h => E.applyTick(JSON.parse(JSON.stringify(Av)), {now: T0 + 361 * MIN, eng: {ts: T0 + 361 * MIN}, plant: {shift: -1, hpAge: 0.3, block: 0}, halten: h});
    check('Uebernahme: Ablauf nach 6 h schickt den Rueckweg 0 - ausser die andere Regel verlangt denselben Wert ("halten")', tk({}).send.length === 1 && tk({}).send[0].payload === '0' && tk({vorausschau: 'Raumeinfluss verlangt dieselbe Verschiebung (-1 K)'}).send.length === 0, '');
}
console.log('--- (d) Sonne/Wind nur mit coefActivate, Bewertung und Neutralitaet');
{
    const H = 3600000, now = T0;
    const W = {f_ts: now - 10 * MIN, fpts: [[now - 10 * MIN, 10, 80, 20, 6], [now + 3 * H, 8, 85, 90, 9], [now + 6 * H, 6, 90, 100, 11]]};
    const PI = {pv: [0, 1, 2, 3, 4, 5, 6, 7].map(h => [now + (h - 1) * H, 4000, H])};
    const PLoff = {model: {n: 12, minDays: 10, gate: true, aktiv: false, bs: 0.4, bw: 0.02, ua: 0.22, tbal: 15}}, PLon = {model: Object.assign({}, PLoff.model, {aktiv: true})};
    const vOff = E.vorschau(W, PLoff, PI, 11, now), vOn = E.vorschau(W, PLon, PI, 11, now), c = cfg.rules.vorausschau;
    check('Vorhersage-Eingabe: Fuehler 11 °C, OWM jetzt 10 °C -> an den Fuehler angeglichen (Versatz klingt ab), 7 Stuetzstellen', vOff.at[0] === 11 && Math.abs(vOff.at[1] - (10 - 2 / 3 + Math.exp(-1 / 4))) < 0.06 && vOff.at.length === 7 && vOff.age === 10, JSON.stringify(vOff.at));
    check('coefActivate aus: Sonne und Wind stehen gar nicht in der Eingabe (kein pv/wind/bs/bw), auch wenn PV-Prognose und Wind vorliegen', !('pv' in vOff) && !('wind' in vOff) && !('bs' in vOff) && !('bw' in vOff) && vOff.aktiv === 0, Object.keys(vOff).join(','));
    const vInj = Object.assign({}, vOff, {pv: [9000, 9000, 9000, 9000, 9000, 9000, 9000], wind: [15, 15, 15, 15, 15, 15, 15], bs: 0.9, bw: 0.1}), B10 = {at: [0, 0, 0, 0, 0, 0, 0], pv: [0, 0, 0, 0, 0, 0, 0]};
    check('coefActivate aus: selbst eingeschleuste Sonne/Wind-Werte aendern die Bedarfsaenderung nicht (nur Temperatur)', E.bedarfK(vInj, c, B10) === E.bedarfK(vOff, c, B10) && E.bedarfK(vOff, c, B10) !== null, E.bedarfK(vOff, c, B10) + ' / ' + E.bedarfK(vInj, c, B10));
    check('coefActivate an (Gate offen): Wind und PV-Prognose gehen ein und veraendern die Bedarfsaenderung', vOn.aktiv === 1 && vOn.pv.length === 7 && vOn.pv[3] === 4000 && vOn.wind[3] === 9 && E.bedarfK(vOn, c, B10) !== E.bedarfK(vOff, c, B10), E.bedarfK(vOff, c, B10) + ' -> ' + E.bedarfK(vOn, c, B10));
    // Nutzerentscheidung 13.10.2026: Wind erst ueber 4 m/s (Totzone), bw hoechstens 0,0125 (wie im Waermefahrplan)
    const vW = (w, bwv) => Object.assign({}, vOn, {wind: [w, w, w, w, w, w, w], bw: bwv, bs: 0, pv: [0, 0, 0, 0, 0, 0, 0]});
    const vClamp = E.vorschau(W, {model: Object.assign({}, PLon.model, {bw: 0.1, bs: 0.9})}, PI, 11, now), vTot = E.vorschau(W, {model: Object.assign({}, PLon.model, {windTot: 5})}, PI, 11, now);
    check('Wind-Totzone: Wind 4 m/s wirkt wie kein Wind, 7 m/s veraendert die Bedarfsaenderung; vorschau klemmt bw 0,1 -> 0,0125 und bs 0,9 -> 0,5, Totzone 4 m/s (aus OPT_plan.model.windTot, sonst Standard)',
          E.bedarfK(vW(4, 0.0125), c, B10) === E.bedarfK(vW(0, 0.0125), c, B10) && E.bedarfK(vW(7, 0.0125), c, B10) !== E.bedarfK(vW(0, 0.0125), c, B10) && vClamp.bw === 0.0125 && vClamp.bs === 0.5 && vClamp.windTot === 4 && vTot.windTot === 5 && E.VS_LIM.bw === 0.0125,
          [E.bedarfK(vW(0, 0.0125), c, B10), E.bedarfK(vW(4, 0.0125), c, B10), E.bedarfK(vW(7, 0.0125), c, B10), vClamp.bw, vClamp.windTot].join(' / '));
    // Tagesgang herausgerechnet: ein gewoehnlicher Tag (Vorhersage = gestern zur selben Uhrzeit) ergibt 0, Wetter ergibt die Aenderung
    const day = hs => 6 + 4 * Math.sin(2 * Math.PI * ((new Date(hs).getHours() + 0.5) - 9) / 24), t15 = new Date(2026, 9, 12, 15, 30).getTime();
    const Sd = seedS(day, t15), base = E.tagesgang(Sd, t15), fc = off => vsx([0, 1, 2, 3, 4, 5, 6].map(h => Math.round((day(t15 + h * H) + (h >= 2 ? off : 0)) * 10) / 10));
    check('Tagesgang herausgerechnet: Vorhersage 15:30 wie gestern (abends ~4 K kaelter, Tagesgang ±4 K) -> Bedarfsaenderung ~0, kein Vorschlag; derselbe Abend 3 K kaelter als gestern -> ~+3 K',
          Math.abs(E.bedarfK(fc(0), c, base)) < 0.3 && Math.abs(E.bedarfK(fc(-3), c, base) - 3) < 0.3 && E.bedarfK(fc(0), c, {at: [null, null, null, null, null, null, null]}) === null && (fc(0).at[0] - fc(0).at[5]) >= 3.5,
          'gleich wie gestern ' + E.bedarfK(fc(0), c, base) + ' K, 3 K kaelter ' + E.bedarfK(fc(-3), c, base) + ' K; ohne Tagesgang-Abzug waeren es ' + E.bedarfK(fc(0), c, B10) + ' K');
    { let Rn = runD(90, i => inp(t15 + i * MIN, {vs: fc(0)}), seedS(day, t15)); const Rk = runD(90, i => inp(t15 + i * MIN, {vs: fc(3)}), seedS(day, t15)), Rc = runD(90, i => inp(t15 + i * MIN, {vs: fc(-3)}), seedS(day, t15));
      check('... in der Maschine: gewoehnlicher Nachmittag -> kein Vorschlag, waermerer Abend als gestern -> −1 K; kaelterer Abend als gestern -> seit v2 kein +1 K mehr', shiftProps(Rn).length === 0 && shiftProps(Rk).length === 1 && shiftProps(Rk)[0].p.cmd.value === -1 && /aus dem Wetter/.test(shiftProps(Rk)[0].p.warum) && shiftProps(Rc).length === 0, shiftProps(Rk).map(x => x.p.warum).join(' | ') + ' / ohne: ' + r0(Rn.outs[89], 'vorausschau').grund);
      Rn = runD(30, i => inp(T0 + i * MIN, {vs: vsx(VSK.up)}), null);
      check('Ohne 24 h gemessenen Tagesgang (frischer Zustand): Vorausschau ruht ("Tagesgang noch nicht bekannt"), bei geschlossenem Gate "gesperrt" mit diesem Zusatz', /^Tagesgang noch nicht bekannt \(\d+ h gemessen, mindestens 36 h\)$/.test(r0(Rn.outs[29], 'vorausschau').grund) && /Gebäudemodell.*; außerdem Tagesgang noch nicht bekannt/.test(r0(E.step(null, inp(T0, {vs: vsx(VSK.up, {gate: 0})}), cfg), 'vorausschau').grund), r0(Rn.outs[29], 'vorausschau').grund); }
    check('Vorhersage alt (> 120 min) oder zu kurz: Vorausschau ruht', /min alt/.test(r0(E.step(null, inp(T0, {vs: vsx(VSK.up, {age: 150})}), cfg), 'vorausschau').grund) && /reicht nicht/.test(r0(E.step(seedS(10), inp(T0, {vs: vsx([10, 10, 9, null, null, null, null])}), cfg), 'vorausschau').grund) && E.vorschau({f_ts: now, fpts: []}, PLoff, null, 10, now) === null, '');
    // Bewertung: Fall der Vorausschau (Treffer / Fehlalarm), nur unter ihrer Regel
    const drift = (i, end) => Math.round((i < 40 ? 22.6 : Math.min(end, 22.6 + (i - 40) * 0.004)) * 10) / 10;
    let R = runD(400, i => inp(T0 + i * MIN, {vs: vsx(i < 120 ? VSK.down : VSK.flat), rooms: rooms({ki_oben: drift(i, 23.3)})}));
    let sc = allScores(R), a = sc.find(s => s.typ === 'ausloeser');
    check('Bewertung: Vorausschau −1 K, waermster Raum (Kinderzimmer oben) steigt ohne Verschiebung an den oberen Bandrand (23,3 >= Maximum − 0,3) -> Treffer, gebucht unter "vorausschau" (v2), nichts fuer den Raumeinfluss',
          a && a.regel === 'vorausschau' && a.v === 2 && a.ergebnis === 'treffer' && a.horizonte.length === 3 && !sc.some(s => s.regel === 'raum_offset'), a && a.text);
    R = runD(400, i => inp(T0 + i * MIN, {vs: vsx(i < 120 ? VSK.down : VSK.flat)}));
    sc = allScores(R); a = sc.find(s => s.typ === 'ausloeser');
    check('Bewertung: Raum bleibt mit Luft im Band -> Fehlalarm der Vorausschau (Minuspunkte nur fuer sie)', a && a.regel === 'vorausschau' && a.ergebnis === 'fehlalarm' && a.punkte < 0 && E.report(R.S).find(r => r.regel === 'vorausschau').fehlalarm === 1 && E.report(R.S).find(r => r.regel === 'raum_offset').faelle === 0, a && (a.punkte + ' ' + a.text));
    // Neutralitaet: Raumeinfluss durch die Gegenregel gesperrt (uebernommene -1 K der Vorausschau), Raum kalt -> v3 "waehrend Sperre" (0), v2 "verpasst" (-20)
    const neu = i => inp(T0 + i * MIN, {vs: vsx(VSK.down), shift: i >= 32 ? -1 : 0, soll: i >= 32 ? 29 : 30, korr: kx(i >= 40 ? 1 : 0), rooms: rooms({ki_oben: i >= 40 ? 21.4 : 22.6})});
    R = runD(300, neu); sc = allScores(R).filter(s => s.regel === 'raum_offset' && /^verpasst/.test(s.typ));
    check('Neutralitaet (v3): Raumeinfluss 180 min lang nur durch die Gegenregel (uebernommene -1 K der Vorausschau) und eigene Wartezeiten gesperrt -> "verpasst_sperre" 0 Punkte mit Sperre "vorrang", kein "verpasst"',
          sc.length === 1 && sc[0].typ === 'verpasst_sperre' && sc[0].punkte === 0 && sc[0].sperre.includes('vorrang') && !/\bverpasst"/.test(JSON.stringify(sc)) && stAt(R, 150, 'raum_offset').locks[0] === 'vorrang', sc.map(s => s.t + ' ' + s.typ + ' ' + JSON.stringify(s.sperre)).join(' | '));
    R = runD(300, neu, undefined, E.mergeCfg({sv: 2})); sc = allScores(R).filter(s => s.regel === 'raum_offset' && /^verpasst/.test(s.typ));
    check('... mit den Bewertungsregeln v2 (cfg.sv = 2) waere dieselbe Lage "verpasst" -20 (Gegenregel-Sperren entschuldigten dort nicht): v3 aendert genau das', sc.some(s0 => s0.typ === 'verpasst' && s0.punkte === -20 && s0.sv === 2), sc.map(s => s.t + ' ' + s.typ + ' ' + s.punkte).join(' | '));
    R = runD(300, i => { const x = neu(i); if (i >= 200) { x.rooms = rooms({ki_oben: 20.8}); } return x; }); sc = allScores(R).filter(s => s.regel === 'raum_offset' && /^verpasst/.test(s.typ));
    check('... Schaden hebt auch die Gegenregel-Entschuldigung auf: Raum 1,2 K unter Minimum -> "verpasst" -20 mit Schaden "komfort"', sc.some(s => s.typ === 'verpasst' && s.punkte === -20 && JSON.stringify(s.schaden) === '["komfort"]'), sc.map(s => s.t + ' ' + s.typ + ' ' + s.punkte).join(' | '));
    // Verpasst der Vorausschau (Bewertung v3, Regel v2 nur -1 K): Lage 60 min ohne Vorschlag, bewertet erst, wenn sie wirklich eintritt
    const vsMiss = (o) => i => inp(T0 + i * MIN, Object.assign({vs: vsx(i >= (o.ab || 0) ? VSK.down : VSK.flat), at: 10, korr: kx(o.korr ? (i < (o.korrBis || 999) ? o.korr : 0) : 0, 'Kinderzimmer oben')}, o.f ? o.f(i) : {}));
    const vmiss = R => allScores(R).filter(s0 => s0.regel === 'vorausschau' && /^verpasst/.test(s0.typ));
    let Rm = runD(400, vsMiss({f: i => (i >= 150 ? {rooms: rooms({ki_oben: 23.7})} : {})}), undefined, E.mergeCfg({rules: {vorausschau: {proTag: 0}}}));
    let vm = vmiss(Rm);
    check('Verpasst Vorausschau: Lage (Milderung) ab Minute 0, Tageslimit ueber den Standard hinaus auf 0 gesetzt (zaehlt frei), Raum steigt in Minute 150 ueber sein Maximum (vorhergesagter Waermegewinn trat ein) -> "verpasst" -20',
          vm.length === 1 && vm[0].typ === 'verpasst' && vm[0].punkte === -20 && vm[0].t === E.iso(T0 + 150 * MIN) && /eingetreten: Kinderzimmer oben über Maximum/.test(vm[0].text) && /verlängert: Tageslimit/.test(vm[0].text), vm.map(x => x.t + ' ' + x.typ + ' ' + x.text).join(' | '));
    Rm = runD(400, vsMiss({}), undefined, E.mergeCfg({rules: {vorausschau: {proTag: 0}}}));
    check('... trat nichts ein (Raum bleibt im Band, gemessene Aussentemperatur bleibt beim Tagesgang): kein Eintrag', vmiss(Rm).length === 0, vmiss(Rm).map(x => x.typ).join(','));
    Rm = runD(400, vsMiss({f: i => (i >= 120 ? {at: 13.5} : {})}), undefined, E.mergeCfg({rules: {vorausschau: {proTag: 0}}}));
    vm = vmiss(Rm);
    check('... eingetreten ueber die Messung: Aussentemperatur im Fenster 3,5 K ueber dem Tagesgang (>= halbe Schwelle) -> "verpasst" -20 am Fensterende (Minute 60 + 5 h)', vm.length === 1 && vm[0].typ === 'verpasst' && vm[0].t === E.iso(T0 + 360 * MIN) && /gemessen -3,5 K/.test(vm[0].text), vm.map(x => x.t + ' ' + x.text).join(' | '));
    Rm = runD(500, vsMiss({ab: 70, korr: 1, korrBis: 400, f: i => (i >= 200 ? {rooms: rooms({ki_oben: 23.7})} : {})}));
    vm = vmiss(Rm);
    check('... Neutralitaet: Vorausschau nur durch Haltezeit und die Gegenregel (Raumeinfluss hat +1 K) zurueckgehalten, Waermegewinn trat ein -> "verpasst_sperre" 0 Punkte',
          vm.length === 1 && vm[0].typ === 'verpasst_sperre' && vm[0].punkte === 0 && vm[0].sperre.includes('vorrang') && vm[0].sperre.includes('haltezeit'), vm.map(x => x.t + ' ' + x.typ + ' ' + JSON.stringify(x.sperre)).join(' | '));
    check('... v2: der Schaden "Raum > 1 K unter Minimum" galt nur dem gestrichenen Zweig +1 K und steht nicht mehr in den Schadensarten der Vorausschau', !('vorausschau' in E.SCORE.verpasstSperre.schaden), JSON.stringify(E.SCORE.verpasstSperre.schaden));
    Rm = runD(400, vsMiss({f: i => (i >= 150 ? {rooms: rooms({ki_oben: 23.7})} : {})}));
    check('... mit Vorschlag (Standardwerte): kein "verpasst"; mit Gate zu: nie ein Eintrag; Bewertungsregeln v2: kein "verpasst" der Vorausschau', vmiss(Rm).length === 0 && shiftProps(Rm).length === 1 &&
          vmiss(runD(400, i => { const x = vsMiss({f: j => (j >= 150 ? {rooms: rooms({ki_oben: 23.7})} : {})})(i); x.vs.gate = 0; return x; }, undefined, E.mergeCfg({rules: {vorausschau: {proTag: 0}}}))).length === 0 &&
          vmiss(runD(400, vsMiss({f: i => (i >= 150 ? {rooms: rooms({ki_oben: 23.7})} : {})}), undefined, E.mergeCfg({sv: 2, rules: {vorausschau: {proTag: 0}}}))).length === 0, '');
    { const Ru = runD(400, i => inp(T0 + i * MIN, {vs: vsx(VSK.up), at: 10, korr: kx(0)}), undefined, E.mergeCfg({rules: {vorausschau: {proTag: 0}}}));
      check('... v2: eine vorhergesagte Abkuehlung (frueher Lage fuer +1 K) ist keine Lage mehr: kein Vorschlag, kein "verpasst"', shiftProps(Ru).length === 0 && vmiss(Ru).length === 0, ''); }
    // Nachspielen mit Vorhersage aus dem Datensatz
    R = runD(80, i => inp(T0 + i * MIN, {vs: vsx(i < 50 ? VSK.down : VSK.up)}));
    const R2 = runD(80, i => E.unsnap(T0 + i * MIN, JSON.parse(JSON.stringify(R.outs[i].rec.in))));
    check('Nachspielen aus dem Datensatz (Vorhersage im Schnappschuss): dieselben Entscheidungen der Vorausschau', R2.outs.every((o, i) => JSON.stringify(o.rec.r) === JSON.stringify(R.outs[i].rec.r)) && shiftProps(R).length === 1, '');
}

// ------------------------------------------------------------------ Mehrtages-Simulation mit Vorhersage und beiden Verschiebungs-Regeln (Fake-Uhr): nie Hin und Her
function shiftSim(days, opts) {
    opts = opts || {};
    const P = {on: false, tw: 31, room: 22.6, room2: 21, over: 0, under: 0, shift: 0, rt: 0}, H = 3600000;
    let S = null, A = null; const log = {props: [], plantChg: [], errors: 0, conc: 0, ev: [], scores: [], claims: []};
    const start = new Date(2026, 10, 2, 0, 0, 0).getTime();
    const atOf = t => { const i = (t - start) / MIN, h = (i % 1440) / 60, day = i / 1440; return 6 + 4 * Math.sin(2 * Math.PI * (h - 9) / 24) - (day > 4 && day < 5.5 ? 5 : 0) + (day > 6.5 ? 4 : 0) + (day > 7.375 ? 3 : 0); };   // 4 gewoehnliche Tage (Tagesgang lernen), Kaelteeinbruch Tag 5, Milderung ab Tag 6,5 und 7,375 (Vorausschau v2 nur −1 K: nach dem Kaelteeinbruch fehlt die Reserve, im Lauf sperrt Takt-Gefahr; die zweite Milderung trifft eine Pause)
    for (let i = 0; i < days * 1440; i++) {
        const t = start + i * MIN, at = atOf(t), atI = Math.round(at), kurve = Math.max(29, 29 + 0.375 * (11 - atI)), soll = Math.ceil(kurve) + P.shift;
        const spread = P.on ? 2.5 : 0, vl = Math.round((P.tw + spread / 2) * 4) / 4, rl = Math.round((P.tw - spread / 2) * 4) / 4;
        const hz = P.on ? 17 : 0, pth = P.on ? 2100 + (soll - 30) * 150 : 0, qrad = 0.25 * (P.tw - P.room);
        P.tw += ((pth / 1000) - qrad) / 0.4 / 60; P.room += (qrad - 0.18 * (P.room - at) + 0.9) / 8 / 60; P.room2 = P.room - 1.4;
        if (P.on) { P.rt++; if (vl >= soll + 3.25) { P.over++; } else { P.over = 0; } if (P.over >= 3) { P.on = false; P.rt = 0; P.over = 0; } }
        else { if (vl <= soll - 3) { P.under++; } else { P.under = 0; } if (P.under >= 6) { P.on = true; P.under = 0; } }
        const rr = Math.round(P.room * 10) / 10, korrV = rr < 22 ? 1 : (rr > 23.5 ? -1 : 0);
        const W = {f_ts: t - 15 * MIN, fpts: [0, 1, 2, 3, 4, 5, 6, 7].map(h => [t - 15 * MIN + h * H, Math.round(atOf(t - 15 * MIN + h * H) * 10) / 10])};
        const x = {t: t, hpAge: 0.4, hz: hz, vl: vl, rl: rl, soll: soll, dT: 3, pel: P.on ? 300 : 15, pth: pth, flow: 13.5, pump: 1750, q: 3, qPrio: 1, hc: 1, at: atI, defrost: 0, dhw: 0, ss: 0, rt: P.rt, shift: P.shift,
                   heatMode: 0, z1Sensor: 0, heaterI: 0, heaterE: 0, htrOnAT: 0, htrStartDelta: -3, heatOffAT: 12, sollKurve: kurve, block: 0, otherQ: null, otherShift: null, kzRad: 1,
                   rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: rr, age: 20, min: 22, max: 23.5, valid: true, active: true}, {id: 'schlaf', name: 'Schlafzimmer', t: Math.round(P.room2 * 10) / 10, age: 20, min: 20, max: 22.5, valid: true, active: true}],
                   korr: {v: korrV, code: korrV ? 'Raum ausserhalb' : 'alle im Band', distrib: false, lead: 'Kinderzimmer oben'},
                   vs: E.vorschau(W, {model: {n: 12, minDays: 10, gate: opts.gate !== false, aktiv: false, ua: 0.22, tbal: 15}}, null, atI, t)};
        try {
            const o = E.step(S, x, cfg); S = o.S;
            if (S.rules.raum_offset.prop && S.rules.vorausschau.prop) { log.conc++; }
            o.res.forEach(r => { if (r.neu && E.RULE[r.id].groesse === 'shift') { log.props.push({t: t, rule: r.id, v: S.rules[r.id].prop.cmd.value, von: S.rules[r.id].prop.von, hart: r.hart}); } });
            o.scores.forEach(s => log.scores.push(s)); o.ev.forEach(e => log.ev.push([t, e[0], e[1]]));
            if (opts.apply) {                                                              // "Nutzer klickt jeden Verschiebungs-Vorschlag", Rueckweg wie die Uebernahme (Grund, Ablauf, halten)
                const p = o.prop && E.RULE[o.prop.rule].groesse === 'shift' ? o.prop : null;
                if (p && !A && p.von === P.shift) { A = {rule: p.rule, von: P.shift, bis: t + cfg.rules[p.rule].maxDauerMin * MIN}; P.shift = p.cmd.value; log.plantChg.push({t: t, rule: p.rule, v: P.shift}); }
                else if (A && ((o.ende[A.rule]) || (t >= A.bis && !o.halten[A.rule]))) { P.shift = A.von; log.plantChg.push({t: t, rule: A.rule + ' (Rückweg)', v: P.shift}); A = null; }
            }
        } catch (e) { log.errors++; if (log.errors < 3) { console.log(e.stack); } }
    }
    log.S = S;
    return log;
}
{
    // Pruefung "kein Hin und Her" fuer eine Folge von Verschiebungs-Vorschlaegen (Shadow): Gegenrichtung erst 60 min nach dem Ende der vorigen, ohne Notfall 240 min
    const flips = L => { const bad = []; for (let k = 1; k < L.props.length; k++) { const a = L.props[k - 1], b = L.props[k], da = Math.sign(a.v - a.von), db = Math.sign(b.v - b.von); if (da && db && da === -db) { const end = (L.ev.find(e => e[0] >= a.t && e[1] === 'optimierer_ende' && e[2].indexOf(a.rule + ':') === 0) || [b.t])[0]; const gap = (b.t - end) / MIN; if (gap < 60 || (gap < 240 && !b.hart)) { bad.push(E.iso(b.t) + ' ' + b.rule + ' ' + gap + ' min'); } } } return bad; };
    const L1 = shiftSim(8, {});
    basisBericht('8 Tage Verschiebung', L1);
    const byRule = r => L1.props.filter(p => p.rule === r).length;
    check('8 Tage (4 gewoehnliche Tage mit Tagesgang ±4 K, dann Kaelteeinbruch und zwei Milderungen), Gate offen, Shadow: kein Fehler, beide Verschiebungs-Regeln kommen vor, nie zwei Verschiebungs-Vorschlaege gleichzeitig', L1.errors === 0 && byRule('vorausschau') >= 1 && L1.conc === 0 && L1.props.filter(p => p.rule === 'vorausschau').every(p => (p.t - new Date(2026, 10, 2).getTime()) / 86400000 > 3.5), 'Vorausschau ' + byRule('vorausschau') + ', Raumeinfluss ' + byRule('raum_offset') + ': ' + L1.props.map(p => E.iso(p.t).slice(5, 16) + ' ' + p.rule + ' ' + p.v).join(', '));
    check('... kein Hin und Her: jede Gegenrichtung fruehestens 60 min nach dem Ende der vorigen Verschiebung, ohne Komfort-Notfall erst nach 240 min', flips(L1).length === 0, flips(L1).join(' | ') || (L1.props.length + ' Vorschlaege geprueft'));
    const L0 = shiftSim(8, {gate: false});
    check('... dieselben 8 Tage mit geschlossenem Gate: keine Vorausschau, der Raumeinfluss allein', L0.errors === 0 && !L0.props.some(p => p.rule === 'vorausschau'), L0.props.map(p => E.iso(p.t).slice(5, 16) + ' ' + p.rule + ' ' + p.v).join(', '));
    const L2 = shiftSim(8, {apply: true});
    basisBericht('8 Tage uebernommen', L2);
    const chg = L2.plantChg, rev = []; for (let k = 1; k < chg.length; k++) { if (chg[k].t - chg[k - 1].t < 60 * MIN) { rev.push(E.iso(chg[k].t) + ' ' + chg[k].rule); } }
    const ap2 = L2.scores.filter(s => s.typ === 'wirkung');
    check('8 Tage, jeder Verschiebungs-Vorschlag sofort uebernommen (Rueckweg ueber Grund/Ablauf/halten): Anlage wechselt nie binnen 60 min, Wirkung je Regel ihrem Vorschlag zugeordnet', L2.errors === 0 && chg.length >= 2 && rev.length === 0 && ap2.length >= 1 && ap2.every(s => chg.some(c0 => c0.rule === s.regel)) && L2.conc === 0, chg.map(c0 => E.iso(c0.t).slice(5, 16) + ' ' + c0.rule + '=' + c0.v).join(', ') + (rev.length ? ' | zu schnell: ' + rev.join(', ') : ''));
}

// ================================================================== (e) Quiet-Freigabe v2 und Quiet-Arbitrierung (13.10.2026)
console.log('--- (e) Quiet-Freigabe v2: Bedarf, Deckel je Stufe, Zielstufe, Rueckweg, Arbitrierung mit Deckel/Laufzeit');
{
    const qf = (o, id) => r0(o, id || 'quiet_freigabe');
    const firstNeu = (R0, id) => R0.outs.findIndex(o => r0(o, id || 'quiet_freigabe').neu);
    // Kaltstart ohne Bedarf (Raeume im Band): v1 haette nach 25 min vorgeschlagen ("Sollvorlauf noch nicht erreicht"), v2 nicht
    const kalt = i => inp(T0 + i * MIN, {q: 3, hz: 16, rt: i, soll: 32, sollKurve: 31.5, vl: Math.round((27 + 0.08 * i) * 4) / 4, rl: Math.round((25 + 0.08 * i) * 4) / 4});
    let R = runSeq(60, kalt);
    check('Kaltstart ohne Bedarf (Raeume im Band, Vorlauf 5 K und Ruecklauf 4 K unter Soll, Quiet 3 am Deckel): keine Quiet-Freigabe, Grund "kein Bedarf"', firstNeu(R) < 0 && /^kein Vorschlag: kein Bedarf: alle gültigen Räume ab Minimum/.test(qf(R.outs[40]).grund), qf(R.outs[40]).grund);
    // Raum faellt im Lauf auf das Minimum zu (Prognose binnen 2 h): Bedarf ohne Raum unter Minimum
    const fall = i => inp(T0 + i * MIN, {q: 3, hz: 16, rt: 30 + i, soll: 32, sollKurve: 31.5, vl: 30, rl: 27.5, rooms: rooms({ki_oben: Math.round((22.9 - 0.006 * i) * 100) / 100})});
    R = runSeq(150, fall); const ft = firstNeu(R), pf = ft >= 0 ? R.outs[ft].prop : null;
    check('Raum faellt im Lauf 0,36 K/h auf das Minimum zu (Regression ueber 60 min Verlauf ab Laufminute 15, Prognose: Minimum binnen 2 h): Bedarf "fällt … (Minimum in ~… min)" -> Freigabe in Minute 55 (Verlauf ab Minute 45, Haltezeit 10), ohne Notfall und ohne Messdaten schrittweise nach der Messtabelle: Quiet 3 -> 1 (Quiet 1 deckelt bei 21 Hz, Quiet 2 bei 9 °C wie Quiet 3)', !!pf && pf.cmd.value === 1 && /Kinderzimmer oben fällt 0,4 K\/h \(Minimum in ~\d+ min\)/.test(pf.warum) && /Ziel: Quiet 1 deckelt bei 21 Hz \(Messtabelle, 0 von 60 min Daten\)/.test(pf.warum) && ft === 55, ft + ' · ' + (pf ? pf.warum : qf(R.outs[149]).grund));
    const pauseFall = i => inp(T0 + i * MIN, {q: 3, hz: 0, rt: 0, pump: 1750, soll: 32, sollKurve: 31.5, vl: 29, rl: 28.5, rooms: rooms({ki_oben: Math.round((22.9 - 0.006 * i) * 100) / 100})});
    R = runSeq(150, pauseFall);
    check('... derselbe Abfall in der Pause ist kein Bedarf (der naechste Start heizt nach; der Verlauf zaehlt erst ab Laufminute 15)', !R.S.bedT && !qf(R.outs[149]).bed.some(b => b[0] === 'Bedarf' && b[1]), qf(R.outs[149]).grund);
    // Heizstab-Naehe: kurze Startphase (5 min) und Haltezeit (3 min), Ziel Quiet 0, Notfall
    const kaltAT = i => inp(T0 + i * MIN, {at: 0, q: 3, hz: i < 2 ? 30 : 16, rt: i, soll: 35, sollKurve: 34.8, vl: 32.5, rl: 30, rooms: rooms()});
    R = runSeq(20, kaltAT, E.newState(T0 - 20 * MIN)); const fh = firstNeu(R), ph = fh >= 0 ? R.outs[fh].prop : null;
    check('Heizstab-Naehe (0 °C, Vorlauf 2,5 K unter Soll, Heizstab ab 3 K nach Heater_Delay_Time 15 min): Freigabe in Laufminute 10 (Startphase 15 − 5 − 3 = 7 min, dann 3 min Haltezeit: 5 min vor der Heizstab-Freigabe, Regel-Review B4), Ziel Quiet 0, Begruendung "Heizstab-Nähe"', fh === 10 && ph && ph.cmd.value === 0 && /Bedarf: Heizstab-Nähe \(Außen 0 °C, Vorlauf 2,5 K unter Soll, Heizstab ab 3 K\)/.test(ph.warum) && /Ziel: Heizstab-Nähe: volle Leistung/.test(ph.warum) && R.outs[fh].res.find(r => r.id === 'quiet_freigabe').hart, fh + ' · ' + (ph ? ph.warum : qf(R.outs[19]).grund));
    // Zielstufe aus den Daten (je Heizregelung x Quiet x Band, 60 min): kalt mit Quiet-2-Daten -> 3 -> 2; mild mit Quiet-1-Daten -> 3 -> 1
    const seedQ = o => { const S0 = E.newState(T0 - MIN); S0.takt.nl = {laeuft: false}; S0.takt.copT[E.ymd(T0)] = o; return S0; };
    const need = (at, o) => i => inp(T0 + i * MIN, Object.assign({at: at, q: 3, hz: 16, rt: 30 + i, soll: 33, sollKurve: 32.8, vl: 30.5, rl: 28, rooms: rooms({ki_oben: 21.6})}, o || {}));
    R = runSeq(15, need(2), seedQ({'Efficiency|2|-1…3': [1000, 5000, 149, 149 * 20, 21, 21]}));
    check('Zielstufe kalt (2 °C): Quiet 2 hat 149 min Daten und deckelt bei 21 Hz (>= 17 + 4) -> Freigabe Quiet 3 -> 2 (die kleinste wirksame Freigabe; wie der Nutzer am 12.10. 06:38); COP mit Korrektur 5000 / (1000 + 149 x 80/60) = 4,17', R.outs[10].prop && R.outs[10].prop.cmd.value === 2 && /Ziel: Quiet 2 deckelt bei 21 Hz \(149 min Daten, COP 4,17\)/.test(R.outs[10].prop.warum), R.outs[10].prop && R.outs[10].prop.warum);
    R = runSeq(15, need(9), seedQ({'Efficiency|2|7…11': [1000, 6000, 90, 90 * 17, 17, 17], 'Efficiency|1|7…11': [1000, 6100, 70, 70 * 21, 21, 21]}));
    check('Zielstufe mild (9 °C): Quiet 2 deckelt dort bei 17 Hz (bringt nichts), Quiet 1 mit 70 min Daten bei 21 Hz -> Freigabe Quiet 3 -> 1', R.outs[10].prop && R.outs[10].prop.cmd.value === 1 && /Ziel: Quiet 1 deckelt bei 21 Hz/.test(R.outs[10].prop.warum), R.outs[10].prop && R.outs[10].prop.warum);
    R = runSeq(15, need(9), seedQ({'Efficiency|2|7…11': [1000, 6000, 90, 90 * 17, 17, 17], 'Efficiency|1|7…11': [1000, 6100, 40, 40 * 21, 21, 21]}));
    check('... Quiet 1 nur 40 von 60 min Daten (Nutzerentscheidung) und Raum 0,4 K unter Minimum (Notfall) -> direkt Quiet 0 mit Grund (Nutzer vorlaeufig)', R.outs[10].prop && R.outs[10].prop.cmd.value === 0 && /Quiet 0, Notfall \(Kinderzimmer oben 0,4 K unter Minimum\); Quiet 2 deckelt bei 17 Hz \(nötig ≥ 20 Hz\); Quiet 1: 40 von 60 min Daten/.test(R.outs[10].prop.warum), R.outs[10].prop && R.outs[10].prop.warum);
    { const zf = E.zielFrei({q: 3, at: 2, hc: 1, tc: E.taktCfg(null), copSum: {'Efficiency|2|-1…3': [1000, 5000, 149, 0, 21, 21], 'Efficiency|1|-1…3': [1000, 5600, 90, 0, 25, 25]}}, cfg.rules.quiet_freigabe, {heizstab: false});
      const zh = E.zielFrei({q: 3, at: 2, hc: 1, tc: E.taktCfg(null), copSum: {'Efficiency|2|-1…3': [1000, 5000, 149, 0, 21, 21]}}, cfg.rules.quiet_freigabe, {heizstab: true});
      const z8 = E.zielFrei({q: 3, at: 2, hc: 1, tc: E.taktCfg(null), copSum: {'Efficiency|2|-1…3': [1000, 5000, 149, 0, 21, 21], 'Efficiency|1|-1…3': [1000, 5400, 90, 0, 25, 25]}}, cfg.rules.quiet_freigabe, {heizstab: false});
      check('Zielstufe: eine tiefere Stufe statt der naechsten nur mit mehr als 10 % besserem COP (Quiet 1 5,60 gegen Quiet 2 5,00 = +12 % -> Quiet 1; 5,40 = +8 % liegt in der Messunsicherheit -> Quiet 2); Heizstab-Naehe immer Quiet 0', zf.ziel === 1 && z8.ziel === 2 && zh.ziel === 0, zf.warum + ' | ' + z8.warum + ' | ' + zh.warum); }
    // Deckel je Stufe: Quiet 1 haelt 21 Hz (Messung 13.10.); bei 17 Hz ist Quiet 1 nicht am Deckel, eine Freigabe braechte nichts
    R = runSeq(15, need(12, {q: 1, hz: 17}));
    check('Deckel je Stufe: Quiet 1 bei 17 Hz ist nicht am Deckel (Deckel Quiet 1: 21 Hz laut Messung 13.10. 16:36) -> keine Freigabe; v1 nahm fuer alle Stufen 20 Hz an', !R.outs.some(o => qf(o).neu) && /Verdichter nicht am Deckel \(17 Hz, Deckel Quiet 1: 21 Hz\)/.test(qf(R.outs[14]).grund), qf(R.outs[14]).grund);
    R = runSeq(15, need(12, {q: 1, hz: 21}));
    check('... Quiet 1 bei 21 Hz mit Rueckstand und Raum unter Minimum: am Deckel -> Freigabe Quiet 1 -> 0 (v1 haette 21 Hz nie als "am Deckel" erkannt)', R.outs[10].prop && R.outs[10].prop.cmd.value === 0 && R.outs[10].prop.von === 1, R.outs[10].prop ? R.outs[10].prop.warum : qf(R.outs[14]).grund);
    { // gelernter Deckel: hoechste 3 min gehaltene Frequenz, erst 15 min nach einem Quiet-Wechsel (die 20 Hz direkt nach dem Wechsel zaehlen nicht)
      let T = E.taktNew(); const seq = [];
      for (let i = 0; i < 20; i++) { seq.push({q: 2, hz: 20}); } for (let i = 0; i < 12; i++) { seq.push({q: 3, hz: 20}); } for (let i = 0; i < 60; i++) { seq.push({q: 3, hz: i < 8 ? 18 : 17}); }
      seq.forEach((x, i) => { T = E.taktStep(T, Object.assign({t: T0 + i * MIN, hpAge: 0, at: 5, pel: 450, pth: 2500, hc: 1}, x)); });
      const cs = E.copSumme(T, null, T0 + 100 * MIN);
      check('Gelernter Deckel (Takt-Messung): nach Quiet 2 -> 3 zaehlen die 20 Hz der ersten 15 min nicht; gehalten (5 min am Stueck) 18 Hz -> Quiet 3 bei 3…7 °C: 18 Hz, Quiet 2: 20 Hz', cs['Efficiency|3|3…7'][5] === 18 && cs['Efficiency|2|3…7'][5] === 20 && cs['Efficiency|3|3…7'][4] === 20, JSON.stringify([cs['Efficiency|3|3…7'], cs['Efficiency|2|3…7']])); }
    { // COP-Korrektur (14.10.2026, Forum 189605 F10-a): copT speichert TOP16 roh, die Korrektur kommt beim Lesen dazu (je stabile Laufminute kw/60 Wh), nur im Lauf, Konstante cfg.cop.pelKorrW
      let T = E.taktNew(); const seq = [];
      for (let i = 0; i < 10; i++) { seq.push({hz: 0, pel: 15, pth: 0}); } for (let i = 0; i < 80; i++) { seq.push({hz: 17, pel: 350, pth: 2000}); } for (let i = 0; i < 10; i++) { seq.push({hz: 0, pel: 20, pth: 0}); }
      seq.forEach((x, i) => { T = E.taktStep(T, Object.assign({t: T0 + i * MIN, hpAge: 0, at: 12, q: 3, hc: 1}, x)); });
      const k = 'Efficiency|3|11…15', tE = T0 + 100 * MIN, raw = E.copSumme(T, null, tE, 0)[k], kor = E.copSumme(T, null, tE)[k], kor2 = E.copSumme(T, null, tE)[k], k40 = E.copSumme(T, null, tE, 40)[k], m = raw[2];
      const stored = Object.keys(T.copT).reduce((a, d) => a + (T.copT[d][k] ? T.copT[d][k][0] : 0), 0);
      check('COP-Korrektur: nur stabile Laufminuten zaehlen (' + m + ' min, Stillstand mit 15/20 W nicht), Strom roh 350 W -> korrigiert 430 W je Minute, COP 5,71 -> 4,65 (x 0,81 bei 350 W)', m > 50 && m < 80 && Math.abs(raw[0] - m * 350 / 60) < 1e-6 && Math.abs(kor[0] - m * 430 / 60) < 1e-6 && Math.abs(raw[1] / raw[0] - 2000 / 350) < 1e-9 && Math.abs(kor[1] / kor[0] - 2000 / 430) < 1e-9 && Math.abs((kor[1] / kor[0]) / (raw[1] / raw[0]) - 0.814) < 0.001, JSON.stringify([raw, kor]));
      check('COP-Korrektur ohne Doppelanwendung: copT haelt den Rohwert (Summe = Minuten x 350/60), zweimal lesen ergibt dasselbe, Rohsumme steht in Feld 6; 40 W -> 390 W; copTabelle mit 0 W = roh', Math.abs(stored - m * 350 / 60) < 1e-6 && JSON.stringify(kor) === JSON.stringify(kor2) && Math.abs(kor[6] - raw[0]) < 1e-9 && Math.abs(k40[0] - m * 390 / 60) < 1e-6 && E.copTabelle(T, E.taktCfg({copMinMin: 10}), tE, 0)[0][3] === 5.71 && E.copTabelle(T, E.taktCfg({copMinMin: 10}), tE)[0][3] === 4.65, JSON.stringify(k40));
      check('COP-Korrektur pelKorr: im Lauf +80 W (350 -> 430), im Stillstand roh (15 -> 15), fehlender Wert bleibt fehlend; Text "intern +80 W korrigiert"', E.pelKorr(350, true) === 430 && E.pelKorr(15, false) === 15 && E.pelKorr(null, true) === null && E.pelKorr(350, true, 40) === 390 && E.korrTxt() === 'intern +80 W korrigiert' && E.COP_KORR.pelKorrW === 80, '');
      check('COP-Korrektur Konstante: Standard cfg.cop.pelKorrW = 80; mergeCfg uebernimmt 40 und 0, ungueltig (500, Text, negativ) -> 80', E.defaults().cop.pelKorrW === 80 && E.mergeCfg({}).cop.pelKorrW === 80 && E.mergeCfg({cop: {pelKorrW: 40}}).cop.pelKorrW === 40 && E.mergeCfg({cop: {pelKorrW: 0}}).cop.pelKorrW === 0 && [500, 'x', -5].every(v => E.mergeCfg({cop: {pelKorrW: v}}).cop.pelKorrW === 80), '');
      const S40 = E.newState(tE); S40.takt = JSON.parse(JSON.stringify(T)); S40.takt.nl = {laeuft: false};
      const o40 = E.step(S40, inp(tE + MIN, {at: 12, q: 3, hc: 1, hz: 17, pel: 350, pth: 2000}), E.mergeCfg({cop: {pelKorrW: 40}})), V40 = require('./engine_view.js').messBuild(o40.S, tE + MIN, E.mergeCfg({cop: {pelKorrW: 40}}), null);
      check('COP-Korrektur im Hauptschritt: d.copKw = 40 aus cfg.cop, d.copSum korrigiert mit 40 W (Zielstufen/Veto rechnen damit); Karte "Messwerte & Lernen" nennt "+40 W" im Tooltip der COP-Matrix', o40.d.copKw === 40 && Math.abs(o40.d.copSum[k][0] - (o40.d.copSum[k][6] + o40.d.copSum[k][2] * 40 / 60)) < 1e-6 && /intern \+40 W korrigiert/.test(V40.cop.title), o40.d.copKw + ' ' + (V40.cop && V40.cop.title)); }
    // Rueckweg: Bedarf 15 min am Stueck gedeckt -> Grund fuer die Uebernahme; solange Bedarf besteht "halten" (kein Ablauf)
    R = runSeq(60, i => need(9, i >= 20 ? {rooms: rooms({ki_oben: 22.4}), rl: 29.5, vl: 30.5} : {})(i));
    check('Rueckweg-Grund der Freigabe: Bedarf seit 15 min gedeckt (Raeume >= Minimum + 0,3 K, Ruecklauf <= 0,5 K unter Soll) ab Minute 35; davor "halten" (Bedarf besteht weiter)', /Bedarf besteht weiter: Kinderzimmer oben 0,4 K unter Minimum/.test(R.outs[10].halten.quiet_freigabe || '') && !R.outs[30].ende.quiet_freigabe && /^Bedarf seit 15 min gedeckt/.test(R.outs[35].ende.quiet_freigabe || '') && !R.outs[35].halten.quiet_freigabe, (R.outs[35].ende.quiet_freigabe || '–') + ' | ' + (R.outs[10].halten.quiet_freigabe || '–'));
    { const Af = E.newApply(); Af.aktiv = {id: 'f', rule: 'quiet_freigabe', groesse: 'quiet', name: 'SetQuietMode', value: 0, von: 3, ts: T0, bis: T0 + 240 * MIN, bestaetigt: true};
      const h1 = E.applyTick(JSON.parse(JSON.stringify(Af)), {now: T0 + 241 * MIN, eng: {ts: T0 + 241 * MIN}, plant: {q: 0, hpAge: 0.3, block: 0}, halten: {quiet_freigabe: 'Bedarf besteht weiter: x'}});
      const h2 = E.applyTick(JSON.parse(JSON.stringify(Af)), {now: T0 + 241 * MIN, eng: {ts: T0 + 241 * MIN}, plant: {q: 0, hpAge: 0.3, block: 0}});
      const h3 = E.applyTick(JSON.parse(JSON.stringify(Af)), {now: T0 + 60 * MIN, eng: {ts: T0 + 60 * MIN}, plant: {q: 0, hpAge: 0.3, block: 0}, endReason: {quiet_freigabe: 'Bedarf seit 15 min gedeckt'}});
      check('Uebernahme der Freigabe: Frist 4 h ruht, solange Bedarf besteht (kein Befehl); ohne Bedarf nach 4 h zurueck auf Quiet 3; bei gedecktem Bedarf sofort (Grund im Protokoll); hoechstens 3 Versuche (Klickweg)', h1.send.length === 0 && h2.send.length === 1 && h2.send[0].payload === '3' && h3.send.length === 1 && /Bedarf seit 15 min gedeckt/.test(h3.log[0].grund), ''); }
    // Quiet-Arbitrierung: von Hand uebernommener Deckel (Quiet 3 gehoert "Deckel/Laufzeit"); Bedarf beendet die Zuordnung; Freigabe mit Notfall frühestens 60 min nach der Übernahme, ohne Notfall erst 240 min nach dem Ende
    const seedD = () => seedQ({'Efficiency|0|7…11': [1000, 6000, 120, 120 * 26, 34, 34], 'Efficiency|3|7…11': [1000, 6200, 120, 120 * 17, 17, 17]});
    const arbQ = (o2) => i => { const x = inp(T0 + i * MIN, {q: i < 30 ? 0 : 3, hz: i < 30 ? 24 : 16, rt: 30 + i, soll: 30, sollKurve: 29.75, vl: 30, rl: 27, rooms: rooms()}); return Object.assign(x, o2 ? o2(i) : {}); };
    R = runSeq(30, arbQ(), seedD()); const S1 = R.S, S1c = JSON.parse(JSON.stringify(S1));
    check('Quiet-Arbitrierung: Deckel/Laufzeit schlaegt Quiet 0 -> 3 vor (Minute 10, Effizienz-Deckel), Eigentuemer der Groesse Quiet', S1.arbQ.owner === 'quiet_strecken' && S1.rules.quiet_strecken.prop && S1.rules.quiet_strecken.prop.cmd.value === 3, JSON.stringify(S1.arbQ));
    const R2 = runSeq(200, i => arbQ(j => (j >= 40 ? {rooms: rooms({ki_oben: 21.6}), vl: 30, rl: 27.5, soll: 33, sollKurve: 32.8} : {}))(i + 30), S1);
    const fr = R2.outs.map(o => qf(o)), firstF = fr.findIndex(r => r.neu);
    check('... Nutzer stellt Quiet 3 von Hand (Minute 30): die Stufe gehoert dem Deckel; ab Minute 40 Raum 0,4 K unter Minimum (Notfall): die Zuordnung endet, die Freigabe ueberbrueckt die Mindesthaltezeit nach 10 min (Regel-Review B4; vorher 60) und schlaegt nach 10 min Haltezeit (Minute 50) Quiet 3 -> 0 vor; nie zwei Quiet-Vorschlaege gleichzeitig',
          firstF + 30 === 50 && /^wartet/.test(fr[15].st) && R2.outs.every(o => !(qf(o).st === 'vorschlag' && qf(o, 'quiet_strecken').st === 'vorschlag')), (firstF + 30) + ' · ' + fr[50].grund + ' · ' + JSON.stringify(R2.S.arbQ.last));
    const R3 = runSeq(200, i => arbQ(j => (j >= 40 ? {rooms: rooms({ki_oben: 22.1}), soll: 33, sollKurve: 30.8, vl: 30, rl: 27.5} : {}))(i + 30), S1c);
    const f3 = R3.outs.map(o => qf(o)), first3 = f3.findIndex(r => r.neu);
    check('... ohne Notfall (Boost von Hand, Raum im Band): Gegenrichtung erst 240 min nach dem Ende der Zuordnung (Minute 40 -> 280), im Fenster keine Freigabe', first3 < 0 && /ohne Notfall erst nach 240 min/.test(f3[120].grund), f3[120].grund);
}
// ------------------------------------------------------------------ Mehrtages-Simulation beider Quiet-Regeln (Fake-Uhr): mild mit Uebersteuern nach dem Start, dann Kaelte mit Heizstab-Naehe
function quietSim(days, opts) {
    opts = opts || {};
    const P = {on: false, tw: 31, room: 22.6, over: 0, under: 0, q: opts.q !== undefined ? opts.q : 0, rt: 0, pauseStart: 0, lastPause: 999, htr: 0, heater: 0};
    let S = opts.S0 || null, akt = null; const log = {props: [], chg: [], errors: 0, conc: 0, hzHigh: 0, hzHighMin: 0, hzHighMild: 0, starts: 0, heaterMin: 0, maxSendable: 0, needAtProp: [], scores: []};
    const start = new Date(2026, 10, 2, 0, 0, 0).getTime();
    const atOf = i => { const h = (i % 1440) / 60, day = i / 1440, base = day >= 3.5 && day < 5.5 ? -1 : 9; return base + 4 * Math.sin(2 * Math.PI * (h - 9) / 24); };   // 3,5 Tage mild (5-13 °C), 2 Tage Kaelte (-5…3 °C), dann mild
    for (let i = 0; i < days * 1440; i++) {
        const t = start + i * MIN, at = atOf(i), atI = Math.round(at), kurve = Math.max(29, 29 + 0.375 * (11 - atI)), soll = Math.ceil(kurve);
        const spread = P.on ? 2.5 : 0, vl = Math.round((P.tw + spread / 2) * 4) / 4, rl = Math.round((P.tw - spread / 2) * 4) / 4, rlR = soll - 3 - rl;
        const cap = P.q === 0 ? 34 : (P.q === 1 ? 21 : (P.q === 2 ? (atI < 7 ? 21 : 17) : 17));
        let want = 17; if (P.on) { if (P.lastPause >= 60 && P.rt < 40 && atI >= 3) { want = 27; } if (rlR >= 2.5) { want = 33; } else if (rlR >= 1.5) { want = 21; } }   // Uebersteuern nach langer Pause (mild), Bedarf bei Rueckstand
        const hz = !P.on ? 0 : Math.min(cap, want), pth = !P.on ? 0 : 2100 + (hz - 17) * 170, qrad = 0.25 * (P.tw - P.room);
        P.heater = P.on && at < 0 && vl < soll - 3 ? P.heater + 1 : 0; const heaterOn = P.heater > 15;
        P.tw += ((pth + (heaterOn ? 3000 : 0)) / 1000 - qrad) / 0.4 / 60; P.room += (qrad - 0.2 * (P.room - at) + 0.6) / 8 / 60;
        if (heaterOn) { log.heaterMin++; }
        if (P.on) { P.rt++; if (vl >= soll + 3.25) { P.over++; } else { P.over = 0; } if (P.over >= 3) { P.on = false; P.rt = 0; P.over = 0; P.pauseStart = i; } }
        else { if (vl <= soll - 3) { P.under++; } else { P.under = 0; } if (P.under >= 6 && at < 15) { P.on = true; P.under = 0; P.lastPause = i - P.pauseStart; log.starts++; } }
        if (P.on && hz >= 22) { log.hzHigh += pth / 60; log.hzHighMin++; if (at > 3) { log.hzHighMild++; } }
        if (opts.userQ3At && i === opts.userQ3At) { P.q = 3; akt = null; }                  // der Nutzer stellt Quiet 3 von Hand (fremde Aenderung beendet eine Uebernahme)
        const x = {t: t, hpAge: 0.4, hz: hz, vl: vl, rl: rl, soll: soll, dT: 3, pel: P.on ? Math.round(pth / (hz >= 22 ? 5.6 : 6.2)) : 15, pth: pth, flow: 13.5, pump: P.on || at < 15 ? 1750 : 0,
                   q: P.q, qPrio: 1, hc: 1, at: atI, defrost: 0, dhw: 0, ss: 0, rt: P.rt, shift: 0, heatMode: 0, z1Sensor: 0, heaterI: heaterOn ? 1 : 0, heaterE: 0, htrOnAT: 0, htrStartDelta: -3, heatOffAT: 12, sollKurve: kurve, block: 0, otherQ: null, otherShift: null, kzRad: 1,
                   rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: Math.round(P.room * 10) / 10, age: 20, min: 22, max: 23.5, valid: true, active: true}], korr: {v: 0, code: 'alle im Band', distrib: false, lead: ''}};
        try {
            const o = E.step(S, x, opts.cfg || cfg); S = o.S;
            const pf = S.rules.quiet_freigabe.prop, ps = S.rules.quiet_strecken.prop;
            if (pf && ps && (ps.groesse || 'quiet') === 'quiet') { log.conc++; }
            o.res.forEach(r => { if (r.neu && (r.id === 'quiet_freigabe' || r.id === 'quiet_strecken')) { const p = S.rules[r.id].prop; log.props.push({t: t, i: i, rule: r.id, v: p.cmd.value, von: p.von, groesse: p.groesse || 'quiet', at: atI, bedarf: o.d.bedQ.ja, warum: p.warum}); if (r.locks.length) { log.maxSendable++; } } });
            o.scores.forEach(s0 => log.scores.push(s0));
            if (opts.apply) {                                                                // "Nutzer klickt jeden Quiet-Vorschlag"; Rueckweg wie die Uebernahme (Grund, Frist, halten), eine Uebernahme zur Zeit
                const p = o.prop && (o.prop.rule === 'quiet_freigabe' || (o.prop.rule === 'quiet_strecken' && (o.prop.groesse || 'quiet') === 'quiet')) ? o.prop : null;
                if (p && !akt && p.von === P.q) { akt = {rule: p.rule, von: P.q, bis: i + (p.maxDauerMin || 240)}; P.q = p.cmd.value; log.chg.push({i: i, rule: p.rule, q: P.q, dir: Math.sign(P.q - akt.von)}); }
                else if (akt && (o.ende[akt.rule] || (i >= akt.bis && !o.halten[akt.rule]))) { log.chg.push({i: i, rule: akt.rule + ' (Rückweg)', q: akt.von, dir: Math.sign(akt.von - P.q), grund: o.ende[akt.rule] || 'Frist'}); P.q = akt.von; akt = null; }
            }
        } catch (e) { log.errors++; if (log.errors < 3) { console.log(e.stack); } }
    }
    log.S = S;
    return log;
}
{
    const seedAll = () => { const S0 = E.newState(new Date(2026, 10, 1, 23, 59).getTime()); S0.takt.nl = {laeuft: false}; const dk = '2026-11-01'; S0.takt.copT[dk] = {};
                            ['-1…3', '3…7', '7…11', '11…15'].forEach(b => { S0.takt.copT[dk]['Efficiency|0|' + b] = [1000, 5800, 300, 300 * 20, 34, 34]; S0.takt.copT[dk]['Efficiency|3|' + b] = [1000, 6100, 300, 300 * 17, 17, 17]; }); return S0; };
    const L = quietSim(8, {S0: seedAll(), userQ3At: Math.round(3.6 * 1440)}), LA = quietSim(8, {S0: seedAll(), apply: true, userQ3At: Math.round(3.6 * 1440)});
    const fr = L.props.filter(p => p.rule === 'quiet_freigabe'), dk = L.props.filter(p => p.rule === 'quiet_strecken');
    const day = p => Math.floor(p.i / 1440);
    check('8 Tage Fake-Uhr (3,5 Tage mild mit Uebersteuern nach langen Pausen, 2 Tage Kaelte -5…3 °C mit Heizstab-Naehe, Nutzer stellt dort Quiet 3, dann mild), Shadow: kein Fehler, nie zwei Quiet-Vorschlaege gleichzeitig, keiner in einer Sperrminute; Deckel nur mild ohne Bedarf (> 3 °C), Freigabe nur mit Bedarf (Kaelte)',
          L.errors === 0 && L.conc === 0 && L.maxSendable === 0 && dk.length >= 1 && dk.every(p => p.at > 3 && !p.bedarf && p.v > p.von) && fr.length >= 1 && fr.every(p => p.bedarf && p.v < p.von),
          'Deckel ' + dk.length + ' (' + dk.map(p => E.iso(p.t).slice(5, 16)).join(', ') + ') · Freigabe ' + fr.length + ' (' + fr.map(p => E.iso(p.t).slice(5, 16) + ' ' + p.von + '→' + p.v).join(', ') + ')');
    const ch = LA.chg, flip = []; for (let k = 1; k < ch.length; k++) { if (ch[k].i - ch[k - 1].i < 60 && ch[k].dir === -ch[k - 1].dir && !/Rückweg/.test(ch[k].rule)) { flip.push(ch[k].i + ' ' + ch[k].rule); } }
    const perDay = {}; ch.forEach(c => { perDay[Math.floor(c.i / 1440)] = (perDay[Math.floor(c.i / 1440)] || 0) + 1; });
    const fA = LA.props.filter(p => p.rule === 'quiet_freigabe'), dA = LA.props.filter(p => p.rule === 'quiet_strecken');
    check('... jeder Quiet-Vorschlag sofort uebernommen (Rueckweg ueber Grund/Frist/halten, eine Uebernahme zur Zeit): kein Ping-Pong (keine Gegenrichtung binnen 60 min ausser dem eigenen Rueckweg), hoechstens 6 Quiet-Wechsel je Tag, nie zwei Quiet-Vorschlaege gleichzeitig; der Deckel kehrt bei Kaelte (≤ 3 °C oder Bedarf) zurueck',
          LA.errors === 0 && LA.conc === 0 && flip.length === 0 && Object.keys(perDay).every(k => perDay[k] <= 6) && ch.some(c => /quiet_strecken \(Rückweg\)/.test(c.rule)) && dA.length >= 1,
          ch.map(c => E.iso(new Date(2026, 10, 2).getTime() + c.i * MIN).slice(5, 16) + ' ' + c.rule + ' q' + c.q + (c.grund ? ' (' + String(c.grund).slice(0, 40) + ')' : '')).join(', ') + (flip.length ? ' | Ping-Pong: ' + flip.join(', ') : ''));
    check('... Wirkung: mit Uebernahme bei Mildwetter (> 3 °C) weniger Minuten ueber 21 Hz (Deckel) als im Shadow; Heizstab im Kaeltefenster mit Freigabe kuerzer als ohne (Quiet 3 von Hand)', LA.hzHighMild < L.hzHighMild && LA.heaterMin < L.heaterMin, 'Minuten >= 22 Hz mild ' + LA.hzHighMild + ' gegen ' + L.hzHighMild + ' (gesamt ' + LA.hzHighMin + ' gegen ' + L.hzHighMin + '), Heizstab ' + LA.heaterMin + ' gegen ' + L.heaterMin + ' min, Freigaben (Klick) ' + fA.length + ', Deckel (Klick) ' + dA.length);
    basisBericht('8 Tage Quiet', L);
}

// ================================================================== Seite "Optimierer": Karten-Daten (engine_view.js) und Darstellung (eng_ui.js)
console.log('--- Seite "Optimierer": Karten-Daten und Darstellung');
{
    const VW = require('./engine_view.js'), UI = require('./eng_ui.js');
    const txt = h => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, 'x').replace(/\s+/g, ' ').trim();
    const vsrc = fs.readFileSync(path.join(__dirname, 'engine_view.js'), 'utf8').replace(/\/\/.*$/gm, ''), usrc = fs.readFileSync(path.join(__dirname, 'eng_ui.js'), 'utf8');
    check('Anzeige-Funktionen sind rein: keine Uhr, kein Zufall, kein Speicher/Dateizugriff (die Zeit kommt aus der Eingabe)', !/Date\.now|Math\.random|\bfs\.|global\.(get|set)|flow\.(get|set)/.test(vsrc) && !/Date\.now|Math\.random/.test(usrc), '');
    // Ablauf wie (a): 70 min, ab Minute 30 Boost -> wartet -> Vorschlag; dazwischen Datenluecke, Startphase-Flackern (Dauerzustaende)
    const V = {ep: [], open: {}}; let S = null, o = null, snap = null;
    for (let i = 0; i < 70; i++) {
        o = E.step(S, inp(T0 + i * MIN, {rt: 20 + i, soll: i >= 30 ? 38 : 30, vl: i >= 30 ? 30 : 29.5, rl: i >= 30 ? 28.25 : 28, sollKurve: 29.75, rooms: rooms({ki_oben: 21.2}), q: 3, hz: 16, hpAge: i === 12 ? 9 : 0.5}), cfg); S = o.S;
        VW.track(V, o.res, S.rules, T0 + i * MIN);
        if (i === 20) { snap = VW.build({now: T0 + i * MIN, last: {t: T0 + i * MIN, res: o.res, prop: o.prop, anl: {z: o.d.zustand, lauf: o.d.runMin, hz: o.d.hz, q: o.d.q, vlR: o.d.vlRueck}}, S: S, V: V, AP: {}, enabled: false}); }
    }
    const last = {t: T0 + 69 * MIN, res: o.res, prop: o.prop, anl: {z: o.d.zustand, lauf: o.d.runMin, hz: o.d.hz, q: o.d.q, vlR: o.d.vlRueck}};
    const B = VW.build({now: T0 + 69 * MIN, last: last, S: S, V: V, AP: {}, enabled: false});
    const all = JSON.stringify(B) + JSON.stringify(snap);
    check('Karten-Daten ohne "würde schalten, sobald …"-Saetze; Regelkachel = Chip + Bedingungen + eine Zeile (Engpass mit Ist / Schwelle)', !/würde schalten/.test(all) && snap.rules.rules[0].chip === 'prüft' && snap.rules.rules[0].line.l === 'Vorlauf-Rückstand' && snap.rules.rules[0].line.v === '0,5 / 1,5 K' && Math.abs(snap.rules.rules[0].line.f - 1 / 3) < 0.01 && snap.rules.rules[0].bed.length === 7 && snap.rules.rules[0].bed.filter(b => b[1]).length === 5, JSON.stringify(snap.rules.rules[0]));
    check('Regelkacheln: Vorschlag zeigt seit/gueltig bis mit Ablauf-Balken, Raumregel "ruht" mit kurzem Grund ohne Klammerzusatz, Zeilen hoechstens 45 Zeichen', B.rules.rules[0].chip === 'Vorschlag' && /^seit \d\d:\d\d$/.test(B.rules.rules[0].line.l) && /^gültig bis/.test(B.rules.rules[0].line.v) && B.rules.rules.every(r => (r.line.l + r.line.v).length <= 45), B.rules.rules.map(r => r.chip + ': ' + r.line.l + ' ' + r.line.v).join(' | '));
    check('keine doppelten Inhalte: die Begruendung des Vorschlags steht nur in der Vorschlagskarte, nicht in Regelkacheln oder Entscheidungen', B.card.prop && !UI.html('rules', B.rules).includes(B.card.prop.warum.slice(0, 30)) && !UI.html('log', B.log).includes(B.card.prop.warum.slice(0, 30)), '');
    check('Statuszeile: Maschine laeuft, Anlagenzustand, Übernahme gesperrt (Schloss); kein Vorschlag -> keine Knoepfe ausser Zuruecksetzen/Sperren bei Bedarf', B.card.status.length === 3 && B.card.status[0].c === 'ok' && /^Lauf 89 min · 16 Hz · Quiet 3 · Vorlauf -8,0 K$/.test(B.card.status[1].t) && B.card.status[2].c === 'lock' && !/<button/.test(UI.html('card', snap.card)), B.card.status.map(s => s.t).join(' | '));
    check('Anlaufsperre und Datenausfall erscheinen in der Statuszeile', (() => { const r0x = VW.build({now: T0 + 3 * MIN, last: {t: T0 + 3 * MIN, res: [], anl: {}}, S: {born: T0, rules: {}, sc: E.newState(T0).sc}, V: {}, AP: {}}); const r1 = VW.build({now: T0 + 30 * MIN, last: {t: T0 + 30 * MIN, res: [{id: 'quiet_freigabe', st: 'gesperrt', grund: 'gesperrt: x', naechste: {b: 'daten'}, locks: ['daten']}], anl: {}}, S: {born: T0, rules: {}, sc: E.newState(T0).sc}, V: {}, AP: {}}); return /^Anlaufsperre bis 06:10$/.test(r0x.card.status[0].t) && r1.card.status[0].t === 'keine HeishaMon-Daten' && r1.rules.rules[0].chip === 'keine Daten'; })(), '');
    check('Entscheidungen = Episoden: nur tatsaechliche Lagen (Datenluecke, "prüft"-Flackern erzeugen keine Zeile), Quiet-Freigabe wartet > Vorschlag, laeuft', B.log.rows.length === 1 && B.log.rows[0].offen && B.log.rows[0].steps.map(s => s[0]).join(' > ') === 'wartet > Vorschlag 06:40' && B.log.rows[0].was === 'Quiet-Stufe 3 → 0', JSON.stringify(B.log.rows));
    { const V2 = {ep: [], open: {}}; const mk = st => [{id: 'heizgrenze_hinweis', st: st, grund: 'kein Vorschlag: x', naechste: {b: 'reserve'}}];
      for (let i = 0; i < 40; i++) { VW.track(V2, mk(i % 10 < 3 ? 'wartet' : 'bereit'), {}, T0 + i * MIN); }
      check('kurze "wartet"-Episoden (< 5 min ohne Sperre/Vorschlag) werden ausgefiltert, die Liste bleibt leer', V2.ep.length === 4 && VW.logRows(V2, T0 + 40 * MIN).length === 0, V2.ep.length + ' Episoden'); }
    const evil = JSON.parse(JSON.stringify(B)); evil.card.prop.warum = '<script>alert(1)</script>'; evil.rules.rules[1].line.l = '<img src=x onerror=1>';
    check('Darstellung: Texte werden maskiert (kein HTML aus Gruenden/Namen)', !/<script>alert|<img src=x/.test(UI.html('card', evil.card) + UI.html('rules', evil.rules)), '');
    const hc = UI.html('card', B.card), pB = B.card.prop;
    check('Vorschlagskarte (13.10.): hervorgehoben, Befehl, Zielwert, Begruendung, erwartete Wirkung und Rueckweg offen sichtbar (nicht eingeklappt), Knopf Übernehmen grau mit Grund "gesperrt: Hauptschalter aus", Verwerfen',
          /class="oe-prop"/.test(hc) && /<button data-a="uebernehmen" disabled>Übernehmen<\/button>/.test(hc) && /🔒 gesperrt: Hauptschalter aus/.test(hc) && /data-a="verwerfen"/.test(hc) && !/data-a="zuruecksetzen"|data-a="sperren"/.test(hc) && !/<details/.test(hc) &&
          ['Befehl', 'Zielwert', 'Begründung', 'Erwartete Wirkung', 'Rückweg'].every(k => hc.includes('<dt>' + k + '</dt>')) && pB.befehl === 'SetQuietMode = 0' && pB.ziel === 'Quiet 0 (jetzt Quiet 3)' &&
          pB.erwartung === 'Verdichter ≥ 25 Hz binnen 5 min, elektrische Leistung +350 bis +650 W, Vorlauf +2 K in 30 min' && hc.includes('title="' + pB.erwartungLang.slice(0, 40)) && /^automatisch zurück auf Quiet 3, spätestens nach 4 h$/.test(pB.rueck) && B.card.knopf.grund === 'gesperrt: Hauptschalter aus',
          JSON.stringify({befehl: pB.befehl, ziel: pB.ziel, rueck: pB.rueck, knopf: B.card.knopf}));
    const hC = UI.html('card', VW.build({now: last.t, last: last, S: S, V: V, AP: {aktiv: {name: 'SetZ1HeatRequestTemperature', value: 1, von: 0, ts: last.t - 5 * MIN, bestaetigt: true, groesse: 'shift', rule: 'raum_offset'}, rules: ['quiet_freigabe']}, enabled: true}).card);
    const hQ = UI.html('card', VW.build({now: last.t, last: last, S: S, V: V, AP: {aktiv: {name: 'SetQuietMode', value: 3, von: 0, ts: last.t - 5 * MIN, bestaetigt: true, groesse: 'quiet', rule: 'quiet_strecken'}, rules: ['quiet_freigabe']}, enabled: true}).card);
    check('Hauptschalter AN, Regel frei: Übernahme der anderen Größe (Verschiebung, Raumeinfluss) läuft -> Übernehmen frei (Regel-Review R6: Quiet und Verschiebung nebeneinander, die Arbitrierung entscheidet); Übernahme derselben Größe (Quiet, Deckel/Laufzeit) -> grau "gesperrt: Übernahme Deckel/Laufzeit läuft"; Zurücksetzen und Übernahme sperren sichtbar',
          /<button data-a="uebernehmen">Übernehmen<\/button>/.test(hC) && !/gesperrt: Übernahme/.test(hC) && /Übernommen \d\d:\d\d: Verschiebung \+1 K · zurück auf 0/.test(hC) && /<button data-a="uebernehmen" disabled>Übernehmen<\/button>/.test(hQ) && /gesperrt: Übernahme Deckel\/Laufzeit läuft/.test(hQ) && /data-a="zuruecksetzen"/.test(hC) && /data-a="sperren"/.test(hC), '');
    check('Textmenge: Statuskarte ohne Vorschlag < 300 Zeichen (Letzter Vorschlag, letzte 24 h, Übernahme), Regelkarte < 400, Entscheidungen je Zeile < 160', txt(UI.html('card', snap.card)).length < 300 && txt(UI.html('rules', B.rules)).length < 400 && B.log.rows.every(r => txt(UI.html('log', {rows: [r]})).length < 160 + 30), txt(UI.html('card', snap.card)).length + ' / ' + txt(UI.html('rules', B.rules)).length);
    check('Kacheln: 4 Spalten gleicher Breite (eine je Regel seit der Stilllegung des Heizgrenze-Hinweises; bei 17 Einheiten = 912 px je Kachel ~214 px), Kachelnamen mit "…" statt Ueberlauf', /\.oe-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/.test(UI.css) && /\.oe-nm\{[^}]*text-overflow:ellipsis/.test(UI.css) && Math.floor((17 * 48 + 16 * 6 - 24 - 3 * 8) / 4) >= 170 && E.RULES.length === 4, '');
    check('Kacheln ohne Abschneiden (Nutzer 11.10.): kurze Kachelnamen (hoechstens 17 Zeichen, ~140 px), Status-Chip unter dem Namen, Zeilentexte umbrechen statt "…" (geprueft in der statischen Vorschau bei 1024/1920/2560 px: 0 abgeschnitten)',
          E.RULES.every(R0 => R0.kachel && R0.kachel.length <= 17) && B.rules.rules.map(r => r.name).join(',') === 'Quiet-Freigabe,Deckel/Laufzeit,Raumeinfluss,Vorausschau' && /<div class="oe-st"><span class="oe-chip/.test(UI.html('rules', B.rules)) && /\.oe-ln span\{white-space:normal/.test(UI.css) && !/\.oe-sub\{[^}]*ellipsis/.test(UI.css), B.rules.rules.map(r => r.name).join(','));
    const sc = B.score, msA = B.mess.takt.find(t => /^Überheizt/.test(t.k));
    check('Punkte-Karte: 4 Kacheln mit Punkten (alle Befehlsregeln, Freigabereife n/m, Kriterien nur eingeklappt), keine Mess-/Lernzeilen mehr (eigene Karte "Messwerte & Lernen", dort statt der Messaufgabe die Kennzahl "Überheizt ab 11 °C"); ohne Punkteverlauf kein leeres Diagramm',
          sc.tiles.length === 4 && sc.tiles.every(t => t.reife && t.reife.m === 6) && sc.tiles[3].id === 'vorausschau' && !B.mess.takt.some(t => /^Messaufgabe/.test(t.k)) && !UI.html('score', sc).includes('oe_chart') && /<details data-k="reife_quiet_freigabe"><summary>Kriterien<\/summary>/.test(UI.html('score', sc)) &&
          !('mess' in sc) && !('takt' in sc) && !/Takt|Mindestleistung|COP|Wirkzeit|Heizkurven-Bias|Heizgrenze beobachtet|Messaufgabe|Überheizt/.test(txt(UI.html('score', sc))) && msA.v === '0,00 kWh' && msA.s === 'kein Lauf ab 11 °C' && /ALLE Räume über ihrer Bandmitte/.test(msA.title), JSON.stringify(msA));
    const A1 = runSeq(160, i => inp(T0 + i * MIN, {rt: 30 + i, soll: 38, sollKurve: 29.75, vl: 30, rl: 28.25, q: 3, hz: 16, rooms: rooms({ki_oben: 21.2})}));
    const s1 = VW.build({now: T0 + 159 * MIN, last: {t: T0 + 159 * MIN, res: A1.outs[159].res, anl: {}}, S: A1.S, V: {}, AP: {}}).score;
    check('Punkte-Diagramm: Summe je Regel als Stufenlinie ab 0 bis jetzt (SVG-Baukasten), Kachel +21', s1.series.length === 1 && s1.series[0].d[0][1] === 0 && s1.series[0].d[s1.series[0].d.length - 1][0] === T0 + 159 * MIN && s1.tiles[0].punkte === '+21,0' && /<svg/.test(require('./ui_chart.js').svg(UI.chartSpec(s1), 940).svg) && UI.html('score', s1).includes('id="oe_chart"'), JSON.stringify(s1.series[0].d));
    const A2 = runSeq(80, i => inp(T0 + i * MIN, {rt: 30 + i, soll: 38, sollKurve: 29.75, vl: 30, rl: 28.25, q: i === 0 ? 2 : 3, hz: 16, rooms: rooms({ki_oben: 21.8})}));
    const s2 = VW.build({now: T0 + 79 * MIN, last: {t: T0 + 79 * MIN, res: A2.outs[79].res, anl: {}}, S: A2.S, V: {}, AP: {}}).score, h2 = UI.html('score', s2);
    check('Punkte-Karte (v2): "verpasst waehrend Sperre" als Kennzahl je Befehlsregel (Quiet-Freigabe 1, sonst 0), kein Warntext, Punkte 0', s2.sv === E.SCORE_VER && s2.tiles[0].sperre === 1 && s2.tiles.slice(1).every(t => t.sperre === 0) && s2.tiles[0].warn === '' && s2.tiles[0].punkte === '0' && h2.includes('<div class="oe-ln" data-k="sperre"><span>🔒 verpasst während Sperre</span><b>1</b></div>') && (h2.match(/data-k="sperre"/g) || []).length === 4, s2.tiles.map(t => t.sperre).join(','));
    { const mildH = (i, t) => inp(T0 + i * MIN, {at: 13, rt: 20 + i, soll: 29, sollKurve: 29, vl: 30, rl: 28, rooms: [{id: 'ki_oben', name: 'Kinderzimmer oben', t: t, age: 10, min: 22, max: 23.5, valid: true, active: true}]});
      const AH = runSeq(220, i => mildH(i, 22.8)), SH = JSON.parse(JSON.stringify(AH.S));
      SH.sc.tot['heizgrenze_hinweis|v1|s5'] = {rule: 'heizgrenze_hinweis', ver: 1, sv: 5, since: T0, punkte: 0, faelle: 1, bewertet: 1, treffer: 1, fehlalarm: 0, neutral: 0};
      const sh = VW.build({now: T0 + 219 * MIN, last: {t: T0 + 219 * MIN, res: AH.outs[219].res, anl: {}}, S: SH, V: {}, AP: {}}).score, hh = UI.html('score', sh);
      check('Punkte-Karte nach der Stilllegung (Review-Paket): 220 min mild (13 °C, Raum ueber der Bandmitte) -> keine Heizgrenze-Kachel, auch mit alter Summe im Zustand; 4 Kacheln, kein "nur Hinweis", keine Linie fuer die stillgelegte Regel',
            sh.tiles.length === 4 && !sh.tiles.some(t => t.id === 'heizgrenze_hinweis') && !sh.series.some(x => x.id === 'heizgrenze_hinweis') && !hh.includes('nur Hinweis'), JSON.stringify(sh.tiles.map(t => t.id))); }
    { const S0 = E.newState(T0 - MIN); S0.sc.base['quiet_freigabe|v2'] = {30: [20, 19], 60: [20, 19], 120: [20, 19]};
      const AQ = runSeq(160, i => inp(T0 + i * MIN, {rt: 30 + i, soll: 38, sollKurve: 29.75, vl: 30, rl: 28.25, q: 3, hz: 16, rooms: rooms({ki_oben: 21.2})}), S0);
      const sq = VW.build({now: T0 + 159 * MIN, last: {t: T0 + 159 * MIN, res: AQ.outs[159].res, anl: {}}, S: AQ.S, V: {}, AP: {}}).score, tq = sq.tiles[0];
      check('Punkte-Karte (v5): Treffer bei hoher Basisrate als Kennzahl "davon 1 Treffer neutral (Basisrate ≥ Prognose)" in der Kachel, Summe 0, kein Skill',
            tq.sub === '1 Fall · 1 Treffer · 0 Fehlalarm' && tq.more === 'davon 1 Treffer neutral (Basisrate ≥ Prognose)' && tq.punkte === '0' && UI.html('score', sq).includes('davon 1 Treffer neutral (Basisrate ≥ Prognose)'), JSON.stringify({sub: tq.sub, more: tq.more, p: tq.punkte})); }
    // ---- Karte "Messwerte & Lernen" (13.10.): COP-Matrix, Mindestleistung je Band, Kennzahlen mit Status-Chip statt Fliesstext
    { const dk = E.ymd(T0), TK = E.taktNew(); TK.copT[dk] = {'Comfort|0|7…11': [1000, 6200, 120, 2040, 20], 'Efficiency|0|7…11': [1000, 5900, 90, 1620, 24], 'Efficiency|3|7…11': [400, 2600, 30, 510, 17],
                                                           '?|0|7…11': [2000, 9000, 200, 4000, 30], 'Efficiency|?|3…7': [500, 2500, 70, 1200, 20], 'Efficiency|2|3…7': [700, 3800, 61, 1100, 19]};
      TK.bins = {'6': Array(40).fill(1800), '8': Array(35).fill(1750), '10': Array(10).fill(1500)};
      const SM = E.newState(T0 - MIN); SM.takt = TK; SM.lag = {o: [1, 2, 3], r: [], z: [], next: 0, res: null}; SM.kb = {bias: 0, tage: 1, resets: 0, lastStep: 0, lastReset: 0, day: dk, luft: 0.4, tageGesamt: 2};
      const PL = {model: {n: 4, minDays: 10, gate: false, why: ['weniger als 10 Tage', 'PV-Tage zu gleichfoermig'], aktiv: false},
                  lern: {heute: 9, heuteTxt: 'Warmwasser, Eingriff', verw: 2, verwTxt: 'Datenlücke 1, unplausibel 1', drift: {n: 3, up: 3.8, dn: 0, upAn: false, dnAn: false, h: 4}, rueckfall: null, rb: null}};
      const M = VW.messBuild(SM, T0, cfg, PL), C = M.cop, hM = UI.html('mess', M), r7 = C.zeilen.find(z => z.band === '7…11 °C'), r3 = C.zeilen.find(z => z.band === '3…7 °C');
      check('COP-Matrix: Zeilen = Aussenband (kalt -> warm), Spalten nur vorhandene Kombinationen (Comfort Q0, Efficiency Q0/Q2/Q3), Eintraege mit "?" weggelassen; Zelle = COP und Stunden',
            C.spalten.join('|') === 'Comfort Q0|Efficiency Q0|Efficiency Q2|Efficiency Q3' && C.zeilen.map(z => z.band).join('|') === '3…7 °C|7…11 °C' && r7.zellen[0].v === '5,34' && r7.zellen[0].h === '2,0 h' && r7.zellen[1].v === '5,27' && r3.zellen[0] === null && r3.zellen[2].v === '4,86',          // COP mit Korrektur: 6200 / (1000 + 120 x 80/60) usw.
            JSON.stringify(C.spalten) + ' ' + JSON.stringify(C.zeilen.map(z => [z.band, z.zellen.map(c => c && c.v)])));
      check('COP-Matrix: Zellen unter copMinMin (60 min) grau, bester gueltiger Wert je Zeile hervorgehoben (nur wenn es mindestens zwei gueltige gibt), Tooltip mit Minuten, Hz und kWh; HTML ohne Fliesstext',
            r7.zellen[2] === null && r7.zellen[3].grau && !r7.zellen[3].best && r7.zellen[3].v === '5,91' && r7.zellen[0].best && !r7.zellen[1].best && !r3.zellen[2].grau && !r3.zellen[2].best && /120 stabilen Minuten \(mindestens 60\) · Ø 17 Hz · max 20 Hz · 1,2 kWh el \/ 6,2 kWh th · Strom intern \+80 W korrigiert \(roh COP 6,20\)/.test(r7.zellen[0].title) && /intern \+80 W korrigiert/.test(C.title) && /class="oe-sec" title="COP = Wärme ÷ Strom, Strom intern \+80 W korrigiert/.test(hM) &&
            /<table class="oe-cop">/.test(hM) && (hM.match(/class="oe-best"/g) || []).length === 1 && (hM.match(/class="oe-grau"/g) || []).length >= 2 && !/<details/.test(hM), r7.zellen[0].title);
      check('Mindestleistung als Zellen (Band ueber Wert) nur fuer Baender mit genug stabilen Minuten (binMinN 30): 6…8 °C 1,8 kW, 8…10 °C 1,8 kW (laufendes Minimum von warm nach kalt), Einzelheiten im Tooltip',
            M.ml.length === 2 && M.ml[0].band === '6…8 °C' && M.ml[0].v === '1,8 kW' && M.ml[1].band === '8…10 °C' && M.ml[1].v === '1,8 kW' && /10-%-Quantil 1,80 kW, laufendes Minimum von warm nach kalt 1,75 kW, 40 stabile Minuten/.test(M.ml[0].title) && /class="oe-mlc"/.test(hM), JSON.stringify(M.ml));
      const L = k => M.lern.find(t => t.k === k);
      check('Lernen als Kennzahl + kurzer Status-Chip (Einzelheiten nur im Tooltip): Wirkzeit "–"/sammelt 0/3 Ereignisse (Puffer im Tooltip), Heizkurven-Bias 0,0 K/sammelt 1/3 Tage, Gebaeudemodell 4/10 Tage/Gate zu, Lern-Gate heute gesperrt (2 Tage verworfen), Drift ruhig (CUSUM 3,8 von 4)',
            L('Wirkzeit Raum ↑').v === '–' && L('Wirkzeit Raum ↑').chip === 'sammelt' && L('Wirkzeit Raum ↑').s === '0/3 Ereignisse' && /Puffer 3 von 26 Proben/.test(L('Wirkzeit Raum ↑').title) &&
            L('Heizkurven-Bias').v === '0,0 K' && L('Heizkurven-Bias').chip === 'sammelt' && L('Heizkurven-Bias').s === '1/3 Tage' && /Rücksetzungen 0 · ausgewertet 2 Tage · knappste Luft heute \+0,4 K/.test(L('Heizkurven-Bias').title) &&
            L('Gebäudemodell').v === '4/10 Tage' && L('Gebäudemodell').chip === 'Gate zu' && /PV-Tage zu gleichfoermig/.test(L('Gebäudemodell').title) && L('Lern-Gate heute').v === 'gesperrt' && L('Lern-Gate heute').s === '2 Tage verworfen' && /Warmwasser, Eingriff · verworfen: Datenlücke 1, unplausibel 1/.test(L('Lern-Gate heute').title) &&
            L('Bedarfsmodell Drift').v === 'ruhig' && L('Bedarfsmodell Drift').s === 'CUSUM 3,8 von 4 · 3 Tage', JSON.stringify(M.lern.map(t => [t.k, t.v, t.chip || '', t.s || ''])));
      const SM2 = JSON.parse(JSON.stringify(SM)); SM2.lag.res = {auf: {min: 135, n: 4}, ab: {min: null, n: 2}}; SM2.kb.bias = -0.2;
      const PL2 = JSON.parse(JSON.stringify(PL)); PL2.lern.drift.upAn = true; PL2.lern.heute = 0;
      const M2 = VW.messBuild(SM2, T0, cfg, PL2), L2 = k => M2.lern.find(t => t.k === k), M0 = VW.messBuild(SM, T0, cfg, null);
      check('... gemessen: Wirkzeit 135 min (gemessen, 4 Ereignisse), Abfall noch sammelt 2/3; Bias -0,2 K "Absenkung"; Drift "Mehrbedarf" (Warnfarbe); ohne OPT_plan "keine Daten" statt Fehler; alle Kennzahl-Texte kurz (Wert <= 14, Zeile <= 40 Zeichen)',
            L2('Wirkzeit Raum ↑').v === '135 min' && L2('Wirkzeit Raum ↑').chip === 'gemessen' && L2('Wirkzeit Raum ↓').s === '2/3 Ereignisse' && L2('Heizkurven-Bias').chip === 'Absenkung' && L2('Bedarfsmodell Drift').v === 'Mehrbedarf' && L2('Bedarfsmodell Drift').vc === 'warn' && L2('Lern-Gate heute').v === 'frei' &&
            M0.lern.filter(t => t.chip === 'keine Daten').length === 3 && [M, M2, M0].every(m => m.takt.concat(m.lern).every(t => String(t.v).length <= 14 && String(t.s || '').length <= 40)), JSON.stringify(M2.lern.map(t => [t.k, t.v, t.chip || ''])));
      const MN = VW.messBuild(E.newState(T0 - MIN), T0, cfg, PL);
      check('... ohne Messdaten: COP und Mindestleistung als Chip "sammelt", keine leere Tabelle, kein Absturz', MN.cop === null && MN.ml.length === 0 && /oe-chip oe-mute">sammelt</.test(UI.html('mess', MN)) && !/<table/.test(UI.html('mess', MN)), ''); }
    // ---- Karte "Aktueller Vorschlag": Zustand des Knopfs (Spiegel der Pruefkette des Servers), Zustand ohne Vorschlag
    { const p = {id: 'raum_offset@x', rule: 'raum_offset', art: 'befehl'}, ok = (AP, en, kn, rel) => VW.knopfOf(p, AP, en === undefined ? true : en, kn === undefined ? true : kn, rel || ['raum_offset'], T0);
      const ks = [ok({}, false), ok({}, true, false), ok({}, true, true, ['quiet_freigabe']), ok({pending: {ts: T0 - 30000}}), ok({aktiv: {groesse: 'shift', rule: 'vorausschau', name: 'SetZ1HeatRequestTemperature'}}),
                  ok({lastSend: T0 - 4 * MIN}), ok({day: E.ymd(T0), n: 6}), VW.knopfOf({rule: 'heizgrenze_hinweis', art: 'hinweis'}, {}, true, true, ['heizgrenze_hinweis'], T0), ok({aktiv: {groesse: 'quiet', rule: 'quiet_freigabe'}}), ok({day: E.ymd(T0 - 86400000), n: 6, lastSend: T0 - 10 * MIN})];
      check('Knopf "Übernehmen": grau mit Grund in der Reihenfolge der Pruefkette (Hauptschalter, Sendeknoten, Freigabe, Bestaetigung, laufende Uebernahme derselben Groesse, Abstand 10 min, Tageslimit, Hinweis); eine Uebernahme der anderen Groesse sperrt nicht (R6); sonst frei mit Tageszaehler',
            ks.map(k => (k.ok ? 'OK ' : '') + k.grund).join('|') === 'gesperrt: Hauptschalter aus|gesperrt: Sendeknoten deaktiviert|gesperrt: Regel nicht freigegeben|wartet auf Bestätigung der Anlage|gesperrt: Übernahme Vorausschau läuft|gesperrt bis 06:06 (Abstand 10 min)|gesperrt: Tageslimit 6/6 Befehle|nur Hinweis, von Hand einstellen|OK frei · heute 0/6 Befehle|OK frei · heute 0/6 Befehle',
            ks.map(k => k.grund).join(' | '));
      const V3 = {ep: [{id: 'quiet_freigabe', t0: T0 - 300 * MIN, t1: T0 - 250 * MIN, st: [['wartet', T0 - 300 * MIN, '', ''], ['vorschlag', T0 - 290 * MIN, '', 'Quiet-Stufe 3 → 0']], end: 'Quiet steht auf 0'},
                       {id: 'heizgrenze_hinweis', t0: T0 - 30 * 60 * MIN, t1: T0 - 29 * 60 * MIN, st: [['hinweis', T0 - 30 * 60 * MIN, '', 'Heizgrenze 12 → 10 °C (nur Hinweis)']], end: 'x'}], open: {}};
      const cE = VW.build({now: T0, last: {t: T0, res: [], anl: {}}, S: {born: T0 - 60 * MIN, rules: {}, sc: E.newState(T0).sc}, V: V3, AP: {day: E.ymd(T0), n: 2}, enabled: true}).card, hE = UI.html('card', cE);
      check('ohne Vorschlag: "Kein Vorschlag" mit letztem Vorschlag (Regel, Was, Zeitraum, Ende), Zaehler der letzten 24 h (Hinweis von vor 30 h zaehlt nicht) und Uebernahme-Stand; Mindesthoehe, damit die Karte hoeher bleibt als "Regeln"',
            cE.leer.letzter.name === 'Quiet-Freigabe' && cE.leer.letzter.was === 'Quiet-Stufe 3 → 0' && cE.leer.letzter.t === '12.10. 01:10–01:50' && cE.leer.letzter.ende === 'Quiet steht auf 0' && cE.leer.h24 === '1 Vorschlag · 0 Hinweise' &&
            cE.leer.uebernahme === 'frei, aber keine Regel freigegeben · heute 2/6 Befehle' && ['Kein Vorschlag', '<dt>Letzter Vorschlag</dt>', '<dt>Zeitraum</dt>', '<dt>Letzte 24 h</dt>', '<dt>Übernahme</dt>'].every(s => hE.includes(s)) && /\.oe-leer\{[^}]*min-height:118px/.test(UI.css), JSON.stringify(cE.leer)); }
    { const V4 = {ep: [], open: {}}, gate = (st, dauer, grund) => [{id: 'vorausschau', st: st, dauer: dauer, grund: grund, naechste: {b: 'modell'}}];
      VW.track(V4, gate('gesperrt', false, 'würde schalten, aber gesperrt: Gebäudemodell noch nicht freigegeben (4 von 10 Tagen)'), {}, T0);
      VW.track(V4, gate('gesperrt', true, 'gesperrt: Gebäudemodell noch nicht freigegeben (4 von 10 Tagen); außerdem Vorhersage: Bedarf -1,6 K'), {}, T0 + MIN);
      check('Episoden-Ende bei Dauersperre (Modell-Gate): die fehlende Bedingung ("Vorhersage: Bedarf -1,6 K") statt des immer gleichen Gate-Textes', V4.ep.length === 1 && V4.ep[0].end === 'Vorhersage: Bedarf -1,6 K', V4.ep[0] && V4.ep[0].end); }
    if (fs.existsSync(path.join(dataDir, 'quiet-2026-10.csv'))) {
        const PV = require('./engine_ui_preview.js'), SN = PV.snapshots(dataDir), html = PV.page({A: SN.A, B: SN.B});
        check('Vorschau mit echten Daten: 10.10. 08:38 Vorschlag Quiet 3 -> 0 (Übernahme gesperrt), Ende ohne Vorschlag; Entscheidungen hoechstens 12 Episoden, keine Wiederholungen', SN.A.card.prop && SN.A.card.prop.was === 'Quiet-Stufe 3 → 0' && !SN.B.card.prop && SN.B.log.rows.length <= 12 && new Set(SN.B.log.rows.map(r => r.t + r.n)).size === SN.B.log.rows.length && html.length < 200000, SN.B.log.rows.length + ' Episoden, ' + html.length + ' Bytes');
    }
}

// ================================================================== (f) Regel-Review, zweiter Durchgang (REVIEW.md Abschnitt 8): Blocker B1-B7, Empfehlungen, vorlaeufige Nutzer-Vorgaben
console.log('--- (f) Regel-Review 2. Durchgang: Blocker B1–B7, Empfehlungen R1–R6, vorläufige Vorgaben (Szenarien wie skripte/v2)');
{
    const R4 = o => { o = o || {}; return [
        {id: 'ki_oben', name: 'Kinderzimmer oben', t: 22.8, age: 10, valid: true, min: 22, max: 23.5, active: true},
        {id: 'ki_unten', name: 'Kinderzimmer unten', t: 21.0, age: 10, valid: true, min: 20, max: 22, active: true},
        {id: 'schlaf', name: 'Schlafzimmer', t: 21.0, age: 10, valid: true, min: 20, max: 22, active: true},
        {id: 'wohn', name: 'Wohnzimmer', t: 21.8, age: 10, valid: true, min: 20, max: 23.5, active: true}].map(r => Object.assign({}, r, o[r.id] !== undefined ? {t: o[r.id]} : {})); };
    const plantOf = (q, sh) => ({q: q, shift: sh || 0, hpAge: 0.5, block: 0, heatMode: 0, z1Sensor: 0});
    // Fake-Uhr mit Klick-Uebernahme (wie skripte/v2/szC2.js): je Minute rechnen, 4 Takte der Uebernahme (15 s); gesendete Werte stehen sofort an der Anlage
    function klickSim(o) {
        let S = o.S0 || null, A = E.newApply(), q = o.q0, sh = 0, t = o.t0, last = null, ctx = null; const sends = [];
        const setPl = m => { if (/Quiet/.test(m.topic)) { q = Number(m.payload); } else { sh = Number(m.payload); } };
        return {
            sends: sends, get S() { return S; }, get A() { return A; }, get q() { return q; }, get sh() { return sh; }, get t() { return t; }, get out() { return last; },
            tick(x) {
                last = E.step(S, inp(t, Object.assign({q: q, shift: sh}, x)), o.cfg || cfg); S = last.S; if (o.feed) { o.feed(S, t); }
                ctx = {now: t, enabled: true, knoten: true, rules: ['quiet_freigabe', 'quiet_strecken', 'raum_offset'], eng: {ts: t, prop: last.prop, locks: last.locks}, cfg: o.cfg || cfg, endReason: last.ende, halten: last.halten};
                for (let s2 = 0; s2 < 4; s2++) { const r = E.applyTick(A, Object.assign({}, ctx, {now: t + s2 * 15000, plant: plantOf(q, sh)})); A = r.A; r.send.forEach(m => { sends.push([E.iso(t).slice(11, 16), m.payload, m.source, (r.log.find(l => l.aktion === 'rueckweg') || {}).grund || '']); setPl(m); }); }
                t += MIN; return last;
            },
            klick(p) { const r = E.applyRequest(A, {topic: 'uebernehmen', payload: {id: p.id, sum: p.sum}}, Object.assign({}, ctx, {now: t - MIN + 50000, plant: plantOf(q, sh)})); A = r.A; r.send.forEach(m => { sends.push([E.iso(t - MIN).slice(11, 16), m.payload, m.source, 'Klick']); setPl(m); }); return r; }
        };
    }
    const qfr = o => o.res.find(r => r.id === 'quiet_freigabe');
    // ---- B1 (Szenario C2): schrittweise Freigabe 3 -> 2 per Klick, Bedarf bleibt -> 2 -> 0 als Fortsetzung; Rueckweg auf die Ausgangsstufe 3
    { const feedC = (S, t) => { const dk = E.ymd(t); S.takt.copT[dk] = S.takt.copT[dk] || {}; S.takt.copT[dk]['Efficiency|2|3…7'] = [800, 4000, 150, 3150, 21, 21]; S.takt.copT[dk]['Efficiency|3|3…7'] = [800, 4200, 300, 5100, 17, 17]; };
      const S0 = E.newState(T0 - 201 * MIN); S0.takt.nl = {laeuft: false};
      const K = klickSim({S0: S0, q0: 3, t0: T0 - 200 * MIN, feed: feedC}), kl = [];
      const x = (m, o) => Object.assign({at: 4, soll: 33, sollKurve: 33, rooms: R4({schlaf: 19.6}), hz: K.q === 3 ? 17 : (K.q === 2 ? 21 : 34), rt: 100 + m, vl: 31, rl: 28}, o || {});
      for (let m = 0; m < 200; m++) { K.tick(x(m, {rooms: R4()})); }
      for (let m = 0; m < 240; m++) {
          const cover = m >= 150, o = K.tick(x(200 + m, cover ? {rooms: R4({schlaf: 20.6}), vl: 32.5, rl: 29.75} : {})), p = o.prop;
          if (p && p.rule === 'quiet_freigabe' && !kl.some(k => k.id === p.id)) { const r = K.klick(p); kl.push({id: p.id, was: p.was, ok: r.send.length === 1, txt: r.toast && r.toast.text, t: E.iso(K.t - MIN).slice(11, 16), log: r.log[0]}); }
      }
      const s = K.sends.map(z => z[0] + ' ' + z[1] + ' ' + (z[2] === 'Optimierer (Rückweg)' ? 'Rückweg' : 'Klick')).join(', ');
      check('B1 (Szenario C2 bei 4 °C, Schlafzimmer 0,4 K unter Minimum, Daten: Quiet 2 deckelt bei 21 Hz): Klick 3 -> 2; der Bedarf bleibt, die Regel schlägt 2 -> 0 vor (Notfall überbrückt den Mindestabstand nach 10 min) und der Klick wird als Fortsetzung DERSELBEN Übernahme angenommen (Rückweg weiter auf 3, Protokoll "fortsetzung"); nach gedecktem Bedarf genau ein Rückweg auf 3',
            kl.length === 2 && kl[0].ok && /3 → 2/.test(kl[0].was) && kl[1].ok && /2 → 0/.test(kl[1].was) && /Fortsetzung; Rückweg weiter auf 3/.test(kl[1].txt) && kl[1].log.fortsetzung === 2 && K.sends.length === 3 && K.sends[2][1] === '3' && K.sends[2][2] === 'Optimierer (Rückweg)' && /Bedarf seit 15 min gedeckt/.test(K.sends[2][3]) && !K.A.ak.quiet,
            kl.map(k => k.t + ' ' + k.was + ' -> ' + (k.ok ? 'gesendet' : k.txt)).join(' | ') + ' · ' + s); }
    // ---- B1 Gegenproben: andere Regel derselben Groesse, Gegenrichtung, unbestaetigt -> abgelehnt; R6: andere Groesse nebeneinander
    { const NC = T0 + 600 * MIN, aQ = {id: 'qf', rule: 'quiet_freigabe', groesse: 'quiet', name: 'SetQuietMode', value: 2, von: 3, ts: NC - 60 * MIN, bis: NC + 180 * MIN, bestaetigt: true};
      const P = (rule, name, value, von) => { const p = {id: rule + '@x', rule: rule, ver: E.RULE[rule].ver, art: 'befehl', ts: NC - MIN, bis: NC + 29 * MIN, cmd: {name: name, topic: E.WHITELIST[name].topic, value: value}, von: von, was: 'x'}; p.sum = E.checksum(p); return p; };
      const req = (A, p, pl) => E.applyRequest(JSON.parse(JSON.stringify(A)), {topic: 'uebernehmen', payload: {id: p.id, sum: p.sum}}, {now: NC, enabled: true, knoten: true, rules: ['quiet_freigabe', 'quiet_strecken', 'raum_offset'], eng: {ts: NC - 30000, prop: p, locks: {}}, plant: pl, cfg: cfg});
      const A0 = E.newApply(); A0.ak = {quiet: aQ};
      const f1 = req(A0, P('quiet_freigabe', 'SetQuietMode', 0, 2), plantOf(2)), f2 = req(A0, P('quiet_strecken', 'SetQuietMode', 3, 2), plantOf(2));
      const A1 = E.newApply(); A1.ak = {quiet: Object.assign({}, aQ, {bestaetigt: false})}; const f3 = req(A1, P('quiet_freigabe', 'SetQuietMode', 0, 2), plantOf(2));
      const f4 = req(A0, P('raum_offset', 'SetZ1HeatRequestTemperature', 1, 0), plantOf(2, 0));
      check('B1/R6 Gegenproben: Fortsetzung nur für dieselbe Regel in derselben Richtung mit bestätigtem Wert (2 -> 0: gesendet, Ausgangswert bleibt 3); Deckel/Laufzeit 2 -> 3 auf dieselbe Größe und eine unbestätigte Übernahme lehnen ab; Raumeinfluss +1 K (andere Größe) läuft daneben (Regel-Review R6)',
            f1.send.length === 1 && f1.A.ak.quiet.von === 3 && f1.A.ak.quiet.value === 0 && f2.send.length === 0 && /Für die Quiet-Stufe läuft schon eine Übernahme \(Quiet-Freigabe, 3 → 2\)/.test(f2.toast.text) && f3.send.length === 0 && f4.send.length === 1 && f4.A.ak.quiet && f4.A.ak.shift && f4.A.ak.shift.value === 1,
            [f2.toast.text, f3.toast.text, f4.toast.text].join(' | ')); }
    // ---- R6: zwei Uebernahmen, jede mit eigenem Rueckweg; Zuruecksetzen stellt beide nacheinander zurueck (je ein Befehl offen)
    { const NC = T0 + 700 * MIN; let A = E.newApply(); A.ak = {quiet: {id: 'qf', rule: 'quiet_freigabe', groesse: 'quiet', name: 'SetQuietMode', value: 0, von: 3, ts: NC - 90 * MIN, bis: NC + 150 * MIN, bestaetigt: true},
                                                shift: {id: 'ro', rule: 'raum_offset', groesse: 'shift', name: 'SetZ1HeatRequestTemperature', value: 1, von: 0, ts: NC - 30 * MIN, bis: NC + 330 * MIN, bestaetigt: true}};
      let q = 0, sh = 1; const tk = (t, er) => { const r = E.applyTick(A, {now: t, eng: {ts: t}, plant: plantOf(q, sh), endReason: er || {}}); A = r.A; r.send.forEach(m => { if (/Quiet/.test(m.topic)) { q = +m.payload; } else { sh = +m.payload; } }); return r; };
      const snap = r => ({send: r.send.map(m => [m.topic.split('/').pop(), m.payload]), ak: Object.keys(r.A.ak).sort().join(','), aktiv: !!r.A.aktiv});
      const e1 = snap(tk(NC, {raum_offset: 'Raumvorschlag seit 15 min wieder 0 K'})), e2 = snap(tk(NC + 15000)), e3 = snap(tk(NC + 30000));
      const z0r = E.applyRequest(A, {topic: 'zuruecksetzen', payload: {}}, {now: NC + 60000, plant: plantOf(q, sh)}); A = z0r.A; if (z0r.send.length) { q = +z0r.send[0].payload; } const z0 = snap(z0r);
      const z1 = snap(tk(NC + 75000)), z2 = snap(tk(NC + 90000));
      check('R6: Quiet- und Verschiebungs-Übernahme nebeneinander, jede mit eigenem Rückweg: der Grund des Raumeinflusses stellt nur die Verschiebung zurück (1 Befehl), die Freigabe bleibt; "Zurücksetzen" stellt danach die Freigabe zurück (Quiet 3), bestätigt -> keine Übernahme mehr',
            JSON.stringify(e1.send) === '[["SetZ1HeatRequestTemperature","0"]]' && e2.send.length === 0 && e2.ak === 'quiet' && e3.ak === 'quiet' && JSON.stringify(z0.send) === '[["SetQuietMode","3"]]' && z1.send.length === 0 && z1.ak === '' && !z1.aktiv && z2.send.length === 0,
            JSON.stringify([e1, e2, z0, z1])); }
    // ---- B2 (Szenario D): Wohnzimmer liegt dauernd ueber Maximum -> kein Rueckweg deswegen; Bedarfsraum (Schlafzimmer) ueber Maximum 15 min -> Rueckweg; kein Pendeln
    { const S0 = E.newState(T0 - 121 * MIN); S0.takt.nl = {laeuft: false};
      const K = klickSim({S0: S0, q0: 3, t0: T0 - 120 * MIN}), kl = [], ende = [];
      const x = (m, schlaf) => ({at: 4, soll: 33, sollKurve: 33, rooms: R4({wohn: 23.8, schlaf: schlaf}), hz: K.q === 3 ? 17 : 34, rt: 100 + m, vl: K.q === 3 ? 31 : 32.5, rl: K.q === 3 ? 28 : 29.8});
      for (let m = 0; m < 120; m++) { K.tick(x(m, 21.0)); }
      for (let m = 0; m < 200; m++) {
          const schlaf = m < 60 ? 19.6 : (m < 120 ? 20.0 : (m < 150 ? 19.9 : 22.2)), o = K.tick(x(120 + m, schlaf));
          if (o.ende.quiet_freigabe && !ende.length) { ende.push(E.iso(K.t - MIN).slice(11, 16) + ' ' + o.ende.quiet_freigabe); }
          if (o.prop && o.prop.rule === 'quiet_freigabe' && !kl.some(k => k === o.prop.id) && !K.A.ak.quiet) { kl.push(o.prop.id); K.klick(o.prop); }
      }
      check('B2 (Szenario D bei 4 °C): Freigabe per Klick (Schlafzimmer 0,4 K unter Minimum); das Wohnzimmer liegt dauernd über Maximum (Wärmeverteilung) und beendet sie NICHT; Schlafzimmer am Minimum (20,0) und wieder knapp darunter hält sie; erst als der Bedarfsraum 15 min über seinem Maximum liegt, genau ein Rückweg auf 3 – 2 Befehle statt bis zu 6',
            kl.length === 1 && K.sends.length === 2 && K.sends[0][1] === '0' && K.sends[1][1] === '3' && /Schlafzimmer seit 15 min über Maximum/.test(K.sends[1][3]) && !/Wohnzimmer/.test(ende.join('')),
            K.sends.map(z => z.join(' ')).join(' | ') + ' · erstes Ende ' + ende.join('')); }
    // ---- Kaelte-Vorsorge haelt eine Freigabe aus einer harten Stufe (unter 3 °C kein Rueckweg auf Quiet 3), darueber Rueckweg ueber den gedeckten Bedarf
    { const S0 = E.newState(T0 - 61 * MIN); S0.takt.nl = {laeuft: false};
      const K = klickSim({S0: S0, q0: 3, t0: T0 - 60 * MIN}), hl = [];
      const x = (m, o) => Object.assign({at: 2, soll: 33, sollKurve: 33, rooms: R4(), hz: K.q === 3 ? 17 : 34, rt: 100 + m, vl: K.q === 3 ? 31 : 32.5, rl: K.q === 3 ? 28 : 29.8}, o || {});
      for (let m = 0; m < 60; m++) { K.tick(x(m)); }
      for (let m = 0; m < 240; m++) {
          const o = K.tick(x(60 + m, m < 40 ? {rooms: R4({schlaf: 19.6})} : (m < 150 ? {rooms: R4({schlaf: 20.6}), rl: 29.75} : {at: 4, rooms: R4({schlaf: 20.6}), rl: 29.75})));
          if (o.prop && o.prop.rule === 'quiet_freigabe' && !K.A.ak.quiet && !K.sends.length) { K.klick(o.prop); }
          if (m === 100) { hl.push(o.halten.quiet_freigabe || '-'); }
      }
      check('Kälte-Vorsorge hält eine Freigabe aus Quiet 3 (harter Deckel) bei 2 °C auch ohne Bedarf ("halten", kein Rückweg, keine Frist); ab 4 °C Rückweg über den gedeckten Bedarf (15 min) auf 3 – kein Hin und Her mit der Kälte-Vorsorge',
            K.sends.length === 2 && K.sends[0][1] === '0' && /Kälte-Vorsorge: Außen 2 °C \(unter 3 °C\), Quiet 3 deckelt hart/.test(hl[0]) && K.sends[1][1] === '3' && /Bedarf seit 15 min gedeckt/.test(K.sends[1][3]) && +K.sends[1][0].slice(0, 2) * 60 + +K.sends[1][0].slice(3) >= 6 * 60 + 150 + 15,
            K.sends.map(z => z.join(' ')).join(' | ') + ' · ' + hl[0]); }
    // ---- B3: Raumtrend per Regression, Lueften gefiltert, Vorzeichen geprueft
    { const tr = (vals, run) => { const S0 = E.newState(T0 - 200 * MIN); S0.rtr = {x: vals.map(v => [T0 + v[0] * MIN, v[1]])}; const lt = vals[vals.length - 1]; return E.raumTrend(S0, {id: 'x', t: lt[1]}, T0 + lt[0] * MIN, T0 + (run === undefined ? -120 : run) * MIN, 1.0); };
      const ramp = (n, a, k) => { const o = []; for (let i = 0; i <= n; i += 5) { o.push([i, Math.round((a + k * i / 60) * 100) / 100]); } return o; };
      const kFall = tr(ramp(120, 21.5, -0.4)), kLuft = tr([[0, 21.8], [30, 21.8], [31, 20.6], [60, 20.6], [90, 20.7], [120, 20.75]]), kSteig = tr([[0, 21.0], [5, 19.6], [60, 19.8], [90, 19.95], [120, 20.0]]);
      const kZuletzt = tr(ramp(90, 21.5, -0.5).concat([[100, 20.85], [110, 20.95], [120, 21.0]])), kAlt = tr([[0, 21.8], [40, 21.8], [70, 20.8], [71, 20.8]]);
      check('B3 Raumtrend: gleichmäßiger Abfall 0,4 K/h -> Regression −0,40 K/h; Lüften (Sturz 1,2 K in 1 min) -> der Verlauf zählt erst danach (zu kurz: kein Trend statt −6,9 K/h); Raum steigt nach dem Sturz -> kein Abfall; Raum fällt, steigt aber in den letzten 30 min -> 0 (fällt nicht); Sturz 1,0 K binnen 60 min -> Lüften',
            Math.abs(kFall + 0.4) < 0.01 && kLuft !== null && kLuft >= 0 && kSteig !== null && kSteig > 0 && kZuletzt === 0 && kAlt === null, JSON.stringify([kFall, kLuft, kSteig, kZuletzt, kAlt].map(v => v === null ? null : Math.round(v * 100) / 100))); }
    // ---- B4 (Szenario A1/A2): Heizstab-Naehe vor der Heizstab-Freigabe; Notfall ueberbrueckt den Mindestabstand; Kaelte-Vorsorge; Dauerlauf; Heater_Delay_Time
    { const runA = (qChangeBefore, o2) => { let S = null; const t0 = new Date(2026, 11, 10, 2, 0).getTime(), out = {pause: [], lauf: []};
          for (let m = -60; m < 0; m++) { const q = qChangeBefore !== null && m >= -qChangeBefore ? 3 : (qChangeBefore === null ? 3 : 0);
              const o = E.step(S, inp(t0 + m * MIN, Object.assign({hz: 0, rt: 0, pump: 1750, q: q, at: -1, soll: 34, sollKurve: 34, vl: 31.5 - (m + 60) * 0.01, rl: 31.5 - (m + 60) * 0.01, pel: 30, pth: 0, rooms: R4()}, o2 || {})), cfg); S = o.S; if (o.prop) { out.pause.push(o.prop.was); } }
          for (let m = 0; m <= 30; m++) { const vl = 30.75 + Math.min(0.5, m * 0.02);
              const o = E.step(S, inp(t0 + m * MIN, Object.assign({hz: m < 2 ? 30 : 17, rt: m, q: 3, at: -1, soll: 34, sollKurve: 34, vl: vl, rl: vl - 2.0, rooms: R4()}, o2 || {})), cfg); S = o.S;
              const r = qfr(o); if (r.neu && o.prop.rule === 'quiet_freigabe') { out.lauf.push([m, o.prop.was, o.prop.warum]); } }
          return out; };
      const A1 = runA(null), A2 = runA(30), A3 = runA(null, {htrDelay: 20});
      check('B4 (Szenario A1, −1 °C, Quiet 3 seit Stunden): Kälte-Vorsorge schon in der Pause (Quiet 3 -> 2, kein harter Deckel unter 2 °C); im Lauf Heizstab-Nähe in Laufminute 10 (Startphase 15 − 5 − 3 min, 5 min vor der Heizstab-Freigabe) mit Ziel Quiet 0',
            A1.pause.length >= 1 && /Quiet-Stufe 3 → 2 \(Kälte-Vorsorge\)/.test(A1.pause[0]) && A1.lauf.length >= 1 && A1.lauf[0][0] === 10 && /Heizstab-Nähe/.test(A1.lauf[0][2]) && /→ 0$/.test(A1.lauf[0][1]), JSON.stringify([A1.pause.slice(0, 1), A1.lauf.slice(0, 1).map(x => [x[0], x[1]])]));
      check('B4 (Szenario A2): Quiet 0 -> 3 von Hand 30 min vor dem Start; der Notfall überbrückt den Mindestabstand (60 min) nach 10 min -> Vorschlag trotzdem in Laufminute 10 (vorher erst ab Laufminute 30)', A2.lauf.length >= 1 && A2.lauf[0][0] === 10, JSON.stringify(A2.lauf.map(x => [x[0], x[1]])));
      check('B4: Heater_Delay_Time 20 min -> Startphase 20 − 5 − 3 = 12 min, Vorschlag in Laufminute 15', A3.lauf.length >= 1 && A3.lauf[0][0] === 15, JSON.stringify(A3.lauf.map(x => x[0])));
      // Dauerlauf (Lauf laenger als Heater_Delay_Time): Heizstab ohne Verzoegerung -> Abstand 1,0 K (Vorlauf ab 2,0 K unter Soll); Quiet 2 bei 1 °C ist kein harter Deckel
      let S = null, nf = null; const t1 = new Date(2026, 11, 11, 3, 0).getTime();
      for (let m = 0; m < 120; m++) { const vl = m < 60 ? 32.25 : 32.0; const o = E.step(S, inp(t1 + m * MIN, {hz: 21, rt: 60 + m, q: 2, at: 1, soll: 34, sollKurve: 34, vl: vl, rl: 29.25, rooms: R4()}), cfg); S = o.S; const r = qfr(o); if (r.neu && nf === null) { nf = [m, o.prop.was, o.prop.warum]; } }
      check('B4 Dauerlauf (1 °C, Quiet 2 am Deckel 21 Hz, Lauf > 15 min): Vorlauf 1,75 K unter Soll ist noch keine Heizstab-Nähe, ab 2,0 K schon (Abstand 1,0 K statt 0,5 K, natürlicher Sollsprung +1 K) -> Freigabe Quiet 2 -> 0 nach 3 min Haltezeit (Minute 63)',
            nf && nf[0] === 63 && /Heizstab-Nähe \(Außen 1 °C, Vorlauf 2,0 K unter Soll/.test(nf[2]) && /2 → 0/.test(nf[1]), JSON.stringify(nf));
      // Kaelte-Vorsorge aus der Vorhersage (am Abend, nicht erst nachts) und Halten der Freigabe aus einer harten Stufe
      const vsAt = (a0, fc) => ({age: 20, at: [a0, a0, fc, fc, fc, fc, fc, fc], n: 1, minDays: 10, gate: 0, aktiv: 0});
      const kv = (a0, fc, q) => { const d = {at: a0, q: q, hc: 1, vs: vsAt(a0, fc), tc: E.taktCfg(null), copSum: {}, now: T0}; return E.kaltQ(d, cfg.rules.quiet_freigabe); };
      const k1 = kv(5, 1, 3), k2 = kv(5, 3, 3), k3 = kv(5, 1, 2), k4 = kv(2.5, 4, 3);
      check('Kälte-Vorsorge (Nutzer-Erfahrung 1–3 °C, Regel-Review B4): Außen 5 °C, Vorhersage 1 °C in den nächsten 6 h, Quiet 3 -> Vorschlag schon jetzt; Vorhersage 3 °C -> keiner; Quiet 2 deckelt bei 1 °C mit 21 Hz (Messtabelle) -> kein harter Deckel; Außen 2,5 °C hält eine Freigabe (Hysterese bis 3 °C)',
            k1.ja && /Vorhersage 1,0 °C in den nächsten 6 h/.test(k1.txt) && !k2.ja && !k2.kalt && k3.kalt && !k3.ja && k4.halten && !k4.kalt, JSON.stringify([k1, k2, k3, k4].map(k => [k.ja, k.kalt, k.halten, k.cap]))); }
    // ---- B5: Rueckweg des Hebels +1 K bei Heizstab-Naehe, Raum ueber der Bandmitte, Takt-Ende
    { const S0 = E.newState(T0 - MIN); S0.arb.applied = {rule: 'quiet_strecken', w: 1, von: 0, ts: T0 - 300 * MIN}; S0.shift = 1;
      const st = (o, S1) => E.step(JSON.parse(JSON.stringify(S1 || S0)), inp(T0, Object.assign({shift: 1, soll: 31, sollKurve: 30, q: 3, hz: 17, rt: 30, vl: 31.5, rl: 29.5, rooms: R4()}, o)), cfg);
      const b1 = st({at: 1}), b2 = st({rooms: R4({schlaf: 21.4})}), b3 = st({});
      const S2 = JSON.parse(JSON.stringify(S0)); S2.runs = [[T0 - 280 * MIN, 120, 1], [T0 - 140 * MIN, 110, 1]]; S2.lastStop = T0 - 25 * MIN; const b4 = st({hz: 0, rt: 0, pump: 1750}, S2);
      check('B5 Rückweg +1 K: Heizstab-Nähe (Außen 1 °C) -> Rückweg-Grund; Raum mehr als 0,3 K über der Bandmitte (Schlafzimmer 21,4, Mitte 21,0) -> Rückweg-Grund; zwei Läufe ≥ 60 min nach der Übernahme ohne Takt -> Rückweg-Grund; sonst keiner',
            /Heizstab-Nähe/.test(b1.ende['quiet_strecken|shift'] || '') && /Schlafzimmer 0,4 K über der Bandmitte/.test(b2.ende['quiet_strecken|shift'] || '') && !b3.ende['quiet_strecken|shift'] && /2 Läufe ohne Takt seit der Übernahme/.test(b4.ende['quiet_strecken|shift'] || ''),
            [b1, b2, b3, b4].map(b => b.ende['quiet_strecken|shift'] || '-').join(' | ')); }
    // ---- B7: Uebernahme bei stehender Maschine: Gruende/halten nur von einer frischen Maschine, sonst Frist; nach 30 min sicherer Abbruch
    { const NC = T0 + 900 * MIN, aF = {id: 'f', rule: 'quiet_freigabe', groesse: 'quiet', name: 'SetQuietMode', value: 0, von: 3, ts: NC - 245 * MIN, bis: NC - 5 * MIN, bestaetigt: true};
      const tk = (a, engTs, ctx2) => { const A = E.newApply(); A.ak = {quiet: Object.assign({}, a)}; return E.applyTick(A, Object.assign({now: NC, eng: {ts: engTs}, plant: plantOf(0)}, ctx2 || {})); };
      const h = {halten: {quiet_freigabe: 'Bedarf besteht weiter: x'}}, eR = {endReason: {quiet_freigabe: 'Bedarf seit 15 min gedeckt'}}, aOff = Object.assign({}, aF, {bis: NC + 60 * MIN});
      const t1 = tk(aF, NC - 0.5 * MIN, h), t2 = tk(aF, NC - 10 * MIN, h), t3 = tk(aOff, NC - 10 * MIN, eR), t4 = tk(aOff, NC - 40 * MIN), t5 = tk(aOff, NC - 0.5 * MIN, eR);
      check('B7 stehende Maschine: Frist abgelaufen + "halten" einer frischen Maschine -> kein Rückweg; dasselbe "halten" einer 10 min alten Maschine zählt nicht -> Rückweg nach Ablauf; Grund einer alten Maschine zählt nicht; 40 min ohne Rechnung -> sicherer Abbruch (Rückweg auf 3); frischer Grund -> Rückweg',
            t1.send.length === 0 && t2.send.length === 1 && /nach Ablauf.*Maschine ohne frische Gründe/.test(t2.log[0].grund) && t3.send.length === 0 && t4.send.length === 1 && t4.send[0].payload === '3' && /sicherer Abbruch/.test(t4.log[0].grund) && t5.send.length === 1 && /gedeckt/.test(t5.log[0].grund),
            [t1, t2, t3, t4, t5].map(t => t.send.length + (t.log[0] ? ' ' + t.log[0].grund : '')).join(' | ')); }
    // ---- R1/QF-3: 3 Hz Mehrleistung reichen (gelernter Quiet-3-Deckel 18 Hz bei 3…7 °C, Quiet 2 21 Hz)
    { const d = {q: 3, at: 5, hc: 1, now: T0, tc: E.taktCfg(null), copSum: {'Efficiency|3|3…7': [5800, 32700, 946, 15754, 21, 18], 'Efficiency|2|3…7': [800, 4000, 152, 2956, 21, 21]}};
      const z = E.zielFrei(d, cfg.rules.quiet_freigabe, {notfall: false}), z4 = E.zielFrei(d, Object.assign({}, cfg.rules.quiet_freigabe, {mehrHz: 4}), {notfall: false});
      check('R1/QF-3: gelernter Quiet-3-Deckel 18 Hz bei 3…7 °C, Quiet 2 hält 21 Hz -> mit 3 Hz Mehrleistung Ziel Quiet 2 (mit 4 Hz fiel es aus und das Ziel wurde Quiet 1 nach der Messtabelle bzw. 0)', z.ziel === 2 && z4.ziel !== 2, z.warum + ' | ' + z4.warum); }
    // ---- vorlaeufige Nutzer-Vorgaben als Parameter: Boost als Bedarf, ohne Daten schrittweise, Laermgrenze nachts (aus)
    { const boostOnly = c => runSeq(25, i => inp(T0 + i * MIN, {rt: 30 + i, soll: 38, sollKurve: 29.75, vl: 30, rl: 28.25, q: 3, hz: 16, rooms: rooms()}), null, c);
      const b1 = boostOnly(cfg), b0 = boostOnly(E.mergeCfg({rules: {quiet_freigabe: {boostBedarf: 0}}}));
      const fallR = c => runSeq(70, i => inp(T0 + i * MIN, {q: 3, hz: 16, rt: 30 + i, soll: 32, sollKurve: 31.5, vl: 30, rl: 27.5, rooms: rooms({ki_oben: Math.round((22.9 - 0.006 * i) * 100) / 100})}), null, c);
      const f0 = fallR(E.mergeCfg({rules: {quiet_freigabe: {ohneDatenSchrittweise: 0}}})).outs.find(o => o.prop && o.prop.rule === 'quiet_freigabe');
      const night = E.mergeCfg({rules: {quiet_freigabe: {nachtQuietMin: 2}}}), dN = {q: 3, at: 9, hc: 1, now: new Date(2026, 9, 12, 23, 0).getTime(), tc: E.taktCfg(null), copSum: {}};
      const zN = E.zielFrei(dN, night.rules.quiet_freigabe, {notfall: true, heizstab: false}), zH = E.zielFrei(dN, night.rules.quiet_freigabe, {notfall: true, heizstab: true}), zT = E.zielFrei(Object.assign({}, dN, {now: T0 + 6 * 60 * MIN}), night.rules.quiet_freigabe, {notfall: true, heizstab: false});
      check('Vorläufige Vorgaben (Parameter mit Herkunft "Nutzer vorläufig"): Boost von Hand zählt als Bedarf (boostBedarf 1; mit 0 kein Bedarf); ohne Daten schrittweise (ohneDatenSchrittweise 0: wieder Quiet 0); Lärmgrenze nachts aus (nachtQuietMin −1), mit 2 nachts kein Ziel unter Quiet 2 außer Heizstab-Nähe, tagsüber gilt sie nicht',
            b1.outs.some(o => o.prop && o.prop.rule === 'quiet_freigabe') && !b0.outs.some(o => o.prop && o.prop.rule === 'quiet_freigabe') && /kein Bedarf/.test(qfr(b0.outs[24]).grund) && f0 && f0.prop.cmd.value === 0 && cfg.rules.quiet_freigabe.nachtQuietMin === -1 &&
            zN.ziel === null && /nachts nicht unter Quiet 2/.test(zN.warum) && zH.ziel === 0 && zT.ziel === 0,
            [qfr(b0.outs[24]).grund, f0 && f0.prop.was, zN.warum, zH.warum, zT.warum].join(' | ')); }
    // ---- R2: +1 K im Lauf erst ab Vorlauf >= Soll + 1,0 K (Auswertung der Regel mit vorgegebener Lage: Takt belegt, 17 Hz, Zyklus 20 + 10 min)
    { const dR = vl => ({q: 3, hz: 17, running: true, runMin: 20, takt: {takt: true}, lastRunMin: 20, lastPauseMin: 10, lastRunThermo: true, starts3h: 3, shift: 0, soll: 30, vl: vl, at: 9, now: T0, notK: 0.3, bedQ: {ja: false}, rooms: R4({ki_oben: 22.7, wohn: 21.7}).map(r => Object.assign({valid: true}, r))});
      const ev = vl => E.RULE.quiet_strecken.eval(dR(vl), cfg.rules.quiet_strecken, {prop: null, hebel: null, since: 0}), c75 = ev(30.75).cond, c100 = ev(31.0).cond, v75 = c75.find(x => x.k === 'vorlauf');
      check('R2: +1 K im Lauf erst ab Vorlauf ≥ Soll + 1,0 K (vorher 0,5): bei +0,75 K fehlt die Bedingung "Vorlauf" (+1 K löste einen Hochlauf aus), bei +1,0 K sind alle Bedingungen erfüllt', !v75.ok && /Vorlauf \+0,75 K zum Soll: \+1 K löste einen Hochlauf aus/.test(v75.tn) && c100.every(x => x.ok), v75.tn + ' | ' + c100.filter(x => !x.ok).map(x => x.k).join(',')); }
    // ---- R3: Wirkung "Soll folgt" im 5-min-Raster (binnen 6 min)
    { const sv = (lag) => { const R = runSeq(20, i => inp(T0 + i * MIN, {shift: i >= 2 ? 1 : 0, soll: i >= 2 + lag ? 31 : 30, sollKurve: 30, rooms: rooms()})); return [].concat(...R.outs.map(o => o.scores)).find(s => s.typ === 'wirkung'); };
      const w5 = sv(5), w7 = sv(7);
      check('R3: Wirkungsprüfung "Soll-Vorlauf folgt" binnen 6 min (der Soll ändert sich im 5-min-Raster): Soll folgt nach 5 min -> getroffen; nach 7 min -> nicht', w5 && w5.teile[0].ergebnis === 'getroffen' && /binnen 6 min/.test(w5.text) && w7 && w7.teile[0].ergebnis !== 'getroffen', [w5 && w5.text, w7 && w7.text].join(' | ')); }
    // ---- Kennzahl Hochlauf nach dem Start (Comfort-Hochlauf wird nicht gedeckelt, nur gemessen)
    { const R = runSeq(60, i => inp(T0 + i * MIN, i < 25 ? {hc: 0, q: 0, hz: 32, rt: i, rooms: rooms()} : (i < 35 ? {hc: 0, q: 0, hz: 0, rt: 0, pump: 1750, rooms: rooms()} : {hc: 1, q: 0, hz: i < 55 ? 32 : 17, rt: i - 35, rooms: rooms()}))), H = E.hochlaufSumme(R.S);
      check('Kennzahl "Hochlauf nach Start" (Nutzer vorläufig: der Comfort/Quiet-0-Hochlauf wird nicht gedeckelt, nur gemessen): Minuten ≥ 22 Hz in den ersten 25 Laufminuten je Heizregelung (Comfort 25 min/1 Start, Efficiency 20 min/1 Start); kein Deckel-Vorschlag in der Startphase', H.Comfort[0] === 25 && H.Comfort[1] === 1 && H.Efficiency[0] === 20 && H.Efficiency[1] === 1 && !R.outs.some(o => r0(o, 'quiet_strecken').neu), JSON.stringify(H)); }
}

// ================================================================== Replay der echten Daten (07.-10.10., 07.-12.10. oder 07.-13.10.; datensatzabhaengige Pruefungen je Zeitraum)
let RP = null;
if (fs.existsSync(path.join(dataDir, 'quiet-2026-10.csv'))) {
    console.log('--- Replay der echten Minutenprotokolle (' + dataDir + ')');
    const replay = require('./engine_replay.js').replay;
    let lr0904 = null;
    RP = replay(dataDir, {onStep: (o, inp) => { if (E.iso(inp.t) === '2026-10-09 04:41:00') { lr0904 = [o.d.lastRunMin, o.d.lastRunThermo]; } }});
    const RP2 = replay(dataDir, {});
    const tEnde = RP.inputs[RP.inputs.length - 1].t, alt = tEnde < new Date(2026, 9, 11).getTime(), neu1310 = tEnde >= new Date(2026, 9, 13, 17, 0).getTime();
    check('Replay: mindestens 4110 Minuten ab 07.10. 16:54 (bis ' + E.iso(tEnde).slice(0, 16) + '), ein Datensatz je Minute', RP.recs.length === RP.inputs.length && RP.inputs.length >= 4100, RP.recs.length);
    check('Replay ist reproduzierbar (zweiter Lauf bit-identisch: Datensaetze und Punkte)', RP.recs.join('\n') === RP2.recs.join('\n') && JSON.stringify(RP.scores) === JSON.stringify(RP2.scores), '');
    const q = RP.props.filter(p => p.rule === 'quiet_freigabe');
    check('Boost 10.10.: Quiet-Freigabe v2 genau einmal, 08:36 (Soll 38 seit 08:25, Kinderzimmer oben 1,6 K unter Minimum, 10 min Haltezeit), vor dem Klick des Nutzers 08:40:41; Ziel Quiet 0 (fuer Quiet 1/2 keine 60 min Daten)', q.length === 1 && E.iso(q[0].ts) === '2026-10-10 08:36:00' && q[0].cmd.value === 0 && q[0].von === 3 && /Bedarf: Kinderzimmer oben 1,6 K unter Minimum/.test(q[0].warum), q.map(p => E.iso(p.ts)).join(','));
    check('Boost: Vorschlag endet, sobald der Nutzer Quiet 0 setzt (08:42 im Minutenraster, "übernommen")', RP.events.some(e => e[0] === '2026-10-10 08:42:00' && e[1] === 'optimierer_ende' && /quiet_freigabe: übernommen: Quiet 0 steht/.test(e[2])), '');
    check('Kaltstarts 07.10. 20:18, 08.10. 09:33 und 17:18 (Rueckstand, Raeume im Band): keine Quiet-Freigabe; 08.10. 09:59 "kein Bedarf" (v1 haette hier ohne die Sperre nach dem Handwechsel vorgeschlagen)', q.length === 1 && RP.recs.some(l => l.indexOf('"t":"2026-10-08 09:59:00"') >= 0 && /"id":"quiet_freigabe","v":2,"st":"bereit","grund":"kein Vorschlag: kein Bedarf/.test(l)), '');
    check('Laufzeit-Zaehler-Reset von HeishaMoNR (09.10. 03:01): der Lauf 08.10. 17:18 bleibt ein Lauf von 601 min mit Abschaltung ueber den Vorlauf (vorher 17 min = falscher Takt-Beleg)', lr0904 && lr0904[0] === 601 && lr0904[1] === true, JSON.stringify(lr0904));
    check('Raumregel waehrend des Boosts gesperrt (Handeingriff Soll 38) und erst 60 min nach dem Boost wieder frei', RP.recs.some(l => l.indexOf('"t":"2026-10-10 09:13:00"') >= 0 && /Handeingriff/.test(l)) && !RP.props.some(p => p.rule === 'raum_offset' && p.ts >= new Date(2026, 9, 10, 8, 25).getTime() && p.ts < new Date(2026, 9, 10, 10, 25).getTime()), RP.props.filter(p => p.rule === 'raum_offset').map(p => E.iso(p.ts)).join(','));
    const ds = RP.props.filter(p => p.rule === 'quiet_strecken');
    check('Deckel/Laufzeit v4 im Replay: Effizienz-Deckel Quiet 0 -> 3 in den Laeufen mit Uebersteuern nach langer Pause (10.10. 15:39, 11.10. 03:26, 11.10. 12:22; 22–25 Hz ohne Bedarf, 8–13 °C); nie +1 K (kein Takt: alle Laeufe >= 97 min)', ds.length === 3 && ds.map(p => E.iso(p.ts).slice(5, 16)).join(',') === '10-10 15:39,10-11 03:26,10-11 12:22' && ds.every(p => p.cmd.name === 'SetQuietMode' && p.cmd.value === 3 && p.von === 0 && p.hebel === 'quiet'), ds.map(p => E.iso(p.ts) + ' ' + p.was).join(' | '));
    check('Kein Vorschlag mit aktiver Sperre und keiner ohne frische Daten', RP.recs.every(l => { const d = JSON.parse(l); return d.r.every(r => !(r.st === 'vorschlag' && r.sperren)); }), '');
    const RV = replay(dataDir, {cfg: {rules: {quiet_freigabe: {rlRueckK: -99}}}}), extra = RV.props.filter(p => p.rule === 'quiet_freigabe').length - 1;
    check('Ruecklauf-Bedingung der Freigabe: v2 schlaegt auch ohne sie nicht oefter vor (der Bedarf trennt schon; v1: 4 zusaetzliche Freigaben 07.–10.10., alle Fehlalarm, rund -213 Punkte)', extra === 0, extra + ' zusaetzlich');
    // Vorausschau mit den echten Daten (OWM-Vorhersage aus optimizer-v2): Gate zu wie live -> nie ein Vorschlag
    const nVs = RP.inputs.filter(x => x.vs).length, vsSt = {}, iVsR = E.RULES.findIndex(R0 => R0.id === 'vorausschau'); RP.perMin.forEach(m => { vsSt[m.st[iVsR]] = (vsSt[m.st[iVsR]] || 0) + 1; });
    check('Replay Vorausschau, Gate zu (1 Tag, wie live): Vorhersage in fast jeder Minute vorhanden, nie ein Vorschlag, Status "gesperrt" (Modell-Gate)', nVs >= RP.inputs.length - 30 && !RP.props.some(p => p.rule === 'vorausschau') && vsSt.gesperrt >= nVs - 30, nVs + ' Minuten mit Vorhersage, Status ' + JSON.stringify(vsSt));
    check('Datensatzgroesse: unter 2,7 MB je Tag (ca. 80 MB/Monat; seit der Vorausschau mit Vorhersage im Schnappschuss und fuenfter Regel)', RP.bytes / (RP.inputs.length / 1440) < 2.7e6, Math.round(RP.bytes / (RP.inputs.length / 1440)) + ' Bytes/Tag');
    if (alt) {                                                                       // nur der Datensatz 07.–10.10. (Kopie vom 10.10. 13:24, liegt nicht mehr vor)
        const RP1 = replay(dataDir, {cfg: {sv: 1}}), rv1 = RP1.report.find(r => r.regel === 'raum_offset'), rv2 = RP.report.find(r => r.regel === 'raum_offset');
        const m1 = RP1.scores.filter(s0 => /^verpasst/.test(s0.typ)), m2 = RP.scores.filter(s0 => /^verpasst/.test(s0.typ));
        check('Replay v1 reproduzierbar (cfg.sv = 1): Raumeinfluss -23,73 mit "verpasst" 09.10. 21:47 wie im Bericht v1; Datensaetze ausser sv identisch mit v2', rv1.punkte === -23.73 && rv1.verpasst === 1 && m1.length === 1 && m1[0].typ === 'verpasst' && m1[0].t === '2026-10-09 21:47:00' && RP1.recs.every((l, i) => l.replace('"sv":1', '"sv":' + E.SCORE_VER) === RP.recs[i]), rv1.punkte + ' / ' + m1.map(x => x.t + ' ' + x.typ).join(','));
        check('Replay v2: dieselbe Lage (Kinderzimmer oben ab 18:47) ist "waehrend Sperre" -> 0 Punkte, Raumeinfluss -3,73', rv2.punkte === -3.73 && rv2.verpasst === 0 && rv2.verpasstSperre === 1 && m2.length === 1 && m2[0].typ === 'verpasst_sperre', rv2.punkte + ' / ' + m2.map(x => x.t + ' ' + x.typ).join(','));
        const RPo = replay(dataDir, {model: Object.assign({}, require('./engine_replay.js').ASSUME.model, {gate: true, n: 12})});
        check('Replay Vorausschau, Gate testweise offen: die Daten reichen fuer keinen sicheren Tagesgang (3 Vortage) -> keine Bedarfsaenderung, kein Vorschlag', !RPo.props.some(p => p.rule === 'vorausschau'), '');
        check('Messaufgabe Comfort/Efficiency gestrichen (Review-Paket): kein Befund im Punktebuch, kein Sammelzustand', !RP.scores.some(x => x.typ === 'messaufgabe') && !RP.S.sc.mess, '');
    }
    if (neu1310) {                                                                   // Datensatz 07.–13.10. (replay_data_1310): neue Lagen 12.10. (Kaelte 1–4 °C, Quiet 2/3 von Hand) und 13.10. (Comfort, Quiet 2 -> 1)
        { const ub = E.uebSumme(RP.S, tEnde);
          check('Review-Paket im Replay 07.–13.10.: kein Heizgrenze-Hinweis mehr (vorher 4: 07.10. 21:03, 08.10. 11:06, 10.10. 16:43, 12.10. 12:48); Kennzahl "Überheizt ab 11 °C": 0,21 kWh Strom roh (0,27 mit COP-Korrektur) / 1,6 kWh Wärme in 45 von 1601 Laufminuten ab 11 °C (9,0 kWh Strom roh, 11,1 korrigiert, insgesamt ab 11 °C)',
                !RP.props.some(p => p.rule === 'heizgrenze_hinweis') && !RP.scores.some(x => x.regel === 'heizgrenze_hinweis') && Math.abs(ub.elRoh - 0.21) < 0.01 && Math.abs(ub.el - (ub.elRoh + 45 * 80 / 60000)) < 0.002 && Math.abs(ub.th - 1.59) < 0.02 && ub.min === 45 && ub.minAlle === 1601 && Math.abs(ub.elAlleRoh - 9.0) < 0.01 && Math.abs(ub.elAlle - (ub.elAlleRoh + 1601 * 80 / 60000)) < 0.002, JSON.stringify(ub)); }
        const at = t => RP.recs.find(l => l.indexOf('"t":"' + t) >= 0), rf = t => JSON.parse(at(t)).r[0];
        check('12.10. 08:30 (Schlafzimmer am Minimum, Quiet 2 bei 20–21 Hz, Vorlauf am Soll): keine Freigabe – ohne Rueckstand braechte sie keine Leistung (Hebel waere die Heizkurve)', /^kein Vorschlag: Vorlauf genau am Soll/.test(rf('2026-10-12 08:30').grund), rf('2026-10-12 08:30').grund);
        check('13.10. 16:29 Start mit Quiet 2 (Comfort, Ruecklauf 1,75 K, Raeume im Band): keine Freigabe (Startphase, danach kein Bedarf); der Nutzer stellte um 16:36 Quiet 1 (Wirkung als Kalibrierfall: 17 -> 21 Hz, +98 W)', /Startphase/.test(rf('2026-10-13 16:33').grund) && /kein Bedarf/.test(rf('2026-10-13 16:50').grund) && RP.scores.some(x => x.typ === 'wirkung' && x.regel === 'quiet_freigabe' && x.kalibrierfall === 1 && /Quiet 2 → 1/.test(x.text) && x.teile.every(t => t.ergebnis === 'getroffen')), rf('2026-10-13 16:50').grund);
        const cs = E.copSumme(RP.S.takt, null, RP.S.last);
        check('Gelernte Deckel aus den Echtdaten (5 min gehalten, ab 15 min nach einem Quiet-Wechsel): Efficiency Quiet 3 bei 3…7 °C 18 Hz, bei 11…15 °C 17 Hz; Quiet 2 bei -1…3 °C 21 Hz (152 min)', cs['Efficiency|3|3…7'][5] === 18 && cs['Efficiency|3|11…15'][5] === 17 && cs['Efficiency|2|-1…3'][5] === 21 && cs['Efficiency|2|-1…3'][2] >= 150, JSON.stringify([cs['Efficiency|3|3…7'], cs['Efficiency|2|-1…3']]));
        { let tN = 0, tLauf = 0, kaltM = 0, kaltJa = 0, w1833 = null; const RT = replay(dataDir, {keepRecs: false, onStep: (o, inp) => { if (o.d.running) { tLauf++; } if (o.d.bedQ.trend) { tN++; } if (o.d.kaltQ.kalt) { kaltM++; } if (o.d.kaltQ.ja) { kaltJa++; } if (E.iso(inp.t) === '2026-10-08 18:33:00') { w1833 = o.d.bedQ.trend; } }});
          check('Regel-Review B3 im Replay: Raumtrend als Bedarf in ' + tN + ' von ' + tLauf + ' Laufminuten (Stand 4ebb7af: 415); 08.10. 18:33 kein "Wohnzimmer −6,9 K/h" mehr (Lüften); Kälte-Vorsorge: ' + kaltM + ' Minuten unter 2 °C (gemessen oder Vorhersage), aber nie mit hartem Deckel (Quiet 2/0) -> kein Vorschlag',
                tN < 250 && w1833 === null && kaltM > 0 && kaltJa === 0 && !RP.props.some(p => /Kälte-Vorsorge/.test(p.was)), JSON.stringify({tN, tLauf, kaltM, kaltJa})); }
        const rq = RP.report.find(r => r.regel === 'quiet_strecken');
        check('Deckel/Laufzeit v4 im Replay bewertet: 3 Faelle, keiner Fehlalarm (Prognose "weiter >= 22 Hz" bei Basisrate >= p neutral bzw. Treffer)', rq.faelle === 3 && rq.fehlalarm === 0 && rq.v === 4, JSON.stringify({f: rq.faelle, t: rq.treffer, fa: rq.fehlalarm, n: rq.neutral, p: rq.punkte}));
    }
}

// ================================================================== (c) Node-RED-Huellen (opt_engine, opt_apply) und gesperrte Uebernahme, mit der erzeugten Flow-Datei
// Einspielen MIT aktivem Uebernahme-Knoten nur ausdruecklich angesagt (UEBERNAHME_KNOTEN_AKTIV=1, setzt deploy_opt.sh mit GEN_ARGS --uebernahme-knoten-aktiv):
// dann muss er aktiv sein und opt_apply den Generator-Schalter KNOTEN = true tragen; sonst deaktiviert und KNOTEN = false. Alle anderen Regeln unveraendert.
const APPLY_AKTIV = process.env.UEBERNAHME_KNOTEN_AKTIV === '1';
function applyPathProblems(nodes, aktiv) {                                       // Strukturregeln des Sendewegs (wie in optimizer_sim.js), hier auch fuer verfaelschte Kopien
    aktiv = aktiv === undefined ? APPLY_AKTIV : aktiv;
    const P = [], tab = nodes.filter(n => n.z === 'opt_tab'), outs = tab.filter(n => n.type === 'mqtt out');
    if (outs.length !== 1 || outs[0].id !== 'opt_apply_mqtt') { P.push('mqtt out im Tab: ' + outs.map(n => n.id).join(',')); }
    if (!aktiv && outs.some(n => n.d !== true)) { P.push('Uebernahme-Knoten nicht deaktiviert'); }
    if (aktiv && outs.some(n => n.d === true)) { P.push('Uebernahme-Knoten deaktiviert, angesagt war aktiv'); }
    const apf = nodes.find(n => n.id === 'opt_apply');
    if (apf && !(apf.func || '').includes('var KNOTEN = ' + (aktiv ? 'true' : 'false') + ';')) { P.push('opt_apply: Schalter KNOTEN passt nicht zum Sendeknoten'); }
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
    check('Struktur des Sendewegs: genau ein ' + (APPLY_AKTIV ? 'AKTIVER (angesagt)' : 'deaktivierter') + ' mqtt out, Schalter KNOTEN in opt_apply passend, nur von opt_apply, Eingaenge nur Karte + Takt', applyPathProblems(NODES).length === 0, applyPathProblems(NODES).join(' | '));
    const mut = (f) => { const c = JSON.parse(JSON.stringify(NODES)); f(c); return applyPathProblems(c); };
    check('Strukturpruefung schlaegt an: Knoten ' + (APPLY_AKTIV ? 'deaktiviert' : 'aktiviert') + ' / Schalter KNOTEN falsch / zweiter mqtt out / opt_engine direkt verdrahtet / Link im Tab',
          mut(c => { const n = c.find(x => x.id === 'opt_apply_mqtt'); if (APPLY_AKTIV) { n.d = true; } else { delete n.d; } }).length > 0 &&
          mut(c => { const a = c.find(x => x.id === 'opt_apply'); a.func = a.func.replace(/var KNOTEN = (true|false);/, (m, v) => 'var KNOTEN = ' + (v === 'true' ? 'false' : 'true') + ';'); }).length > 0 && mut(c => { c.push({id: 'opt_x', type: 'mqtt out', z: 'opt_tab', wires: []}); }).length > 0 && mut(c => { c.find(n => n.id === 'opt_engine').wires[4].push('opt_apply_mqtt'); }).length > 0 && mut(c => { c.push({id: 'opt_l', type: 'link out', z: 'opt_tab', wires: []}); }).length > 0, '');
    const tplP = NODES.find(n => n.id === 'opt_t_eng_prop'), grpAll = NODES.filter(n => n.type === 'ui_group' && n.tab === 'opt_eng_ui_tab').sort((a, b) => a.order - b.order), grp = grpAll.slice(0, 5);
    const TPL = ['opt_t_eng_prop', 'opt_t_eng_rules', 'opt_t_eng_score', 'opt_t_eng_mess', 'opt_t_eng_log'], tpl = TPL.map(id => NODES.find(n => n.id === id));
    check('Seite "Optimierer" (13.10., mit Quiet-Messwerten zusammengelegt): zuerst fuenf gleich breite Gruppen der Maschine (17 Einheiten, Masonry-Falle vermieden) in der Reihenfolge Aktueller Vorschlag, Regeln, Punkte, Messwerte & Lernen, Entscheidungen, danach die beiden Quiet-Statistik-Karten (ebenfalls 17); je Gruppe genau eine Karte; Karte mit Uebernehmen/Verwerfen/Zuruecksetzen/Sperren, Klick schickt nur Aktion + ID + Pruefsumme (genau vier send-Aufrufe)',
          grpAll.length === 7 && grpAll.slice(5).map(g => g.id).join() === 'opt_g_qstats,opt_g_qstats2' && grpAll.every(g => g.width === 17) && grp.map(g => g.name).join('|') === 'Aktueller Vorschlag|Regeln|Punkte|Messwerte & Lernen|Entscheidungen' && tpl.every((t, i) => t && t.group === grp[i].id && t.width === 0 && NODES.filter(n => n.group === grp[i].id).length === 1) &&
          tplP.format.includes("scope.send({topic: 'uebernehmen', payload: {id: P.prop.id, sum: P.prop.sum}})") && tplP.format.includes("scope.send({topic: 'verwerfen', payload: {id: P.prop.id}})") && tplP.format.includes("scope.send({topic: 'zuruecksetzen', payload: {}})") && tplP.format.includes("scope.send({topic: 'sperren', payload: {}})") && (tplP.format.match(/scope\.send\(/g) || []).length === 4 && tplP.format.includes("(P.knopf && P.knopf.ok ? '' : ' disabled')") && TPL.slice(1).every(id => JSON.stringify(NODES.find(n => n.id === id).wires) === '[[]]'), grpAll.map(g => g.name + ':' + g.width).join(', '));
    check('Seite "Optimierer": keine erklaerenden Hinweiszeilen (nur Daten, Status, Knoepfe)', !/class="note"|optq-note/.test(tpl.map(t => t.format).join('')), '');
    check('Seite "Optimierer": jede Karte passt sich nach dem Zeichnen sofort ein (FIT_JS der eigenen Karte, nicht nur im 1,5-s-Takt, der bei verdecktem Fenster ruht); Starthoehen 4/3/9/10/12 Einheiten',
          tpl.every(t => t.format.includes("F.fns['" + t.id + "']") && t.format.includes("var id = '" + t.id + "'") && /class="optfit"/.test(t.format)) && tpl.map(t => t.height).join('/') === '4/3/9/10/12', tpl.map(t => t.height).join('/'));
    check('opt_engine: sechs Ausgaenge (Vorschlag, Regeln, Punkte, Entscheidungen, Dateien, Messwerte & Lernen), Dateien bleiben Ausgang 5',
          (() => { const en = NODES.find(n => n.id === 'opt_engine'); return en.outputs === 6 && JSON.stringify(en.wires) === '[["opt_t_eng_prop"],["opt_t_eng_rules"],["opt_t_eng_score"],["opt_t_eng_log"],["opt_f_eng"],["opt_t_eng_mess"]]'; })(), '');
    // ---- vm-Harness (wie optimizer_sim.js): Fake-Uhr, Speicher, Dateien
    let NOW = new Date(2026, 9, 12, 8, 0, 0).getTime();
    class FD extends Date { constructor(...a) { if (a.length === 0) { super(NOW); } else { super(...a); } } static now() { return NOW; } }
    let gstore = {}, fstores = {}, files = {}, warns = [];
    const fds = {}; let fdN = 10;
    const fsm = {readFileSync: p => { if (!(p in files)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } return files[p]; }, writeFileSync: (p, d) => { files[p] = String(d); }, mkdirSync: () => {}, chmodSync: () => {},
                 openSync: p => { if (!(p in files)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } fds[++fdN] = p; return fdN; },
                 readSync: (fd, buf, off, len, pos) => { const b = Buffer.from(files[fds[fd]], 'utf8'); if (pos >= b.length) { return 0; } return b.copy(buf, off, pos, Math.min(b.length, pos + len)); },
                 closeSync: fd => { delete fds[fd]; }};
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
            OPT_hp: {Quiet_Mode_Level: hp(o.q !== undefined ? o.q : 3), Pump_Speed: hp(1750), Heating_Control: hp(1), Z1_Heat_Request_Temp: hp(0), Heating_Off_Outdoor_Temp: hp(12), Main_Outlet_Temp: hp(30)},
            OPT_weather: {f_ts: NOW - 20 * 60000, fpts: [0, 3, 6, 9].map(h => [NOW - 20 * 60000 + h * 3600000, 11 - h * 0.8, 80, 50, 4])},
            OPT_plan_in: {ts: NOW, pv: [0, 1, 2, 3, 4, 5, 6, 7].map(h => [NOW + (h - 1) * 3600000, 3000, 3600000])},
            OPT_plan: {ts: NOW, model: {n: 1, minDays: 10, gate: false, why: ['weniger als 10 Tage'], aktiv: false, bs: 0, bw: 0, ua: 0.21, tbal: 15}}}, o.g || {});
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
    check('Huelle: Karte zeigt den Vorschlag mit Pruefsumme, Knopf "Übernehmen" gesperrt mit Grund "gesperrt: Hauptschalter aus", Statuszeile "Übernahme gesperrt" (Hauptschalter aus)', (() => { const c = R.eng[24][0].payload; return c.prop && c.prop.id === eng.prop.id && c.prop.sum === eng.prop.sum && c.knopf.ok === false && c.knopf.text === 'Übernehmen' && c.knopf.grund === 'gesperrt: Hauptschalter aus' && c.status.some(s => s.t === 'Übernahme gesperrt' && s.c === 'lock') && c.status[0].c === 'ok' && /^Maschine läuft/.test(c.status[0].t); })(), JSON.stringify(R.eng[24][0].payload.status));
    check('Huelle: Karte "Messwerte & Lernen" kommt ueber Ausgang 6 (Takt-Kacheln mit "Hochlauf nach Start", Mindestleistung, COP-Matrix oder "sammelt", Lernen mit Gebaeudemodell aus OPT_plan 1/10 Tage, Gate zu)',
          (() => { const m = R.eng[24][5] && R.eng[24][5].payload; return m && m.takt.length === 6 && m.takt[5].k === 'Hochlauf nach Start' && Array.isArray(m.ml) && m.lern.length === 6 && m.lern[0].k === 'Gebäudemodell' && m.lern[0].v === '1/10 Tage' && m.lern[0].chip === 'Gate zu' && m.lern[1].chip === 'keine Daten'; })(), JSON.stringify(R.eng[24][5] && R.eng[24][5].payload.lern.slice(0, 2)));
    check('Huelle: Regelkacheln (4 Regeln mit Status-Chip, Bedingungen, einer Zeile), Punkte-Kacheln (4), Entscheidungen als Episoden (Quiet-Freigabe: wartet > Vorschlag, laeuft)', R.eng[24][1].payload.rules.length === 4 && R.eng[24][1].payload.rules.every(r => r.chip && r.line && typeof r.line.l === 'string') && R.eng[24][2].payload.tiles.length === 4 && (() => { const rw = R.eng[24][3].payload.rows; return rw.length === 1 && rw[0].offen && rw[0].steps.map(s => s[0].split(' ')[0]).join('>') === 'wartet>Vorschlag'; })(), JSON.stringify(R.eng[24][3].payload.rows));
    { const hs = gstore.OPT_hp.Heating_Off_Outdoor_Temp; gstore.OPT_hp.Heater_On_Outdoor_Temp = {v: 0, ts: NOW - 3 * 3600000}; const keep = Object.assign({}, hs); hs.ts = NOW - 3 * 3600000;
      NOW += 60000; runN('opt_engine', {topic: '', payload: NOW}); const last = JSON.parse(files[decFile].trim().split('\n').pop()); Object.assign(hs, keep); delete gstore.OPT_hp.Heater_On_Outdoor_Temp;
      check('Huelle: Einstellungen (Heizgrenze, Heizstab-Einschaltgrenze) gelten bis 24 h nach der letzten Meldung (HeishaMon meldet sie selten), Heizstab-Sperre faellt nicht still aus', last.in.heatOffAT === 12 && last.in.htrOnAT === 0, JSON.stringify({heatOffAT: last.in.heatOffAT, htrOnAT: last.in.htrOnAT})); }
    { const lr = JSON.parse(files[decFile].trim().split('\n').pop()), tv = R.eng[24][1].payload.rules.find(r => r.id === 'vorausschau');
      check('Huelle Vorausschau: Eingabe aus OPT_weather/OPT_plan (an den Fuehler angeglichen, Gate zu, ohne Sonne/Wind), Regel "gesperrt" (Modell-Gate 1 / 10 Tage), OPT_engine traegt "halten"',
            lr.in.vs && lr.in.vs.gate === 0 && lr.in.vs.at[0] === 11 && lr.in.vs.at.length === 7 && !('pv' in lr.in.vs) && !('wind' in lr.in.vs) && lr.r[3].id === 'vorausschau' && lr.r[3].sperren[0] === 'modell' && tv.chip === 'gesperrt' && tv.line.l === 'Modell-Gate' && tv.line.v === '1 / 10 Tage' && gstore.OPT_engine.halten !== undefined, JSON.stringify(lr.in.vs) + ' | ' + JSON.stringify(tv.line)); }
    { const keepP = gstore.OPT_plan; gstore.OPT_plan = {ts: NOW, model: {n: 12, minDays: 10, gate: true, why: [], aktiv: true, bs: 0.3, bw: 0.02, ua: 0.21, tbal: 15}}; NOW += 60000; runN('opt_engine', {topic: '', payload: NOW});
      const lv = JSON.parse(files[decFile].trim().split('\n').pop()).in.vs; gstore.OPT_plan = keepP;
      check('Huelle Vorausschau: erst mit aktivem Modell (coefActivate) stehen PV-Prognose und Wind in der Eingabe', lv.gate === 1 && lv.aktiv === 1 && lv.pv.length === 7 && lv.pv[2] === 3000 && lv.wind.length === 7 && lv.bs === 0.3, JSON.stringify(lv)); }
    const nDec = files[decFile].length, an = runN('opt_engine', {topic: 'anzeige'});
    check('Huelle: "anzeige" (von der Uebernahme) baut nur die Karten neu, rechnet und schreibt nichts', an && an[0] && an[0].payload.prop && an[4] === null && files[decFile].length === nDec, '');
    check('Huelle schreibt nur OPT_*-Werte (keine Anlagen-/HeishaMoNR-Variable)', (() => { const before = JSON.stringify(Object.keys(gstore).filter(k => !/^OPT_/.test(k)).sort().map(k => [k, gstore[k]])); world(); minute(2); return JSON.stringify(Object.keys(gstore).filter(k => !/^OPT_/.test(k)).sort().map(k => [k, gstore[k]])) === before; })(), '');
    // 2) Klick bei Hauptschalter AUS
    let r = click('uebernehmen', {id: gstore.OPT_engine.prop.id, sum: gstore.OPT_engine.prop.sum});
    check('Klick, Hauptschalter AUS (keine apply.json): nichts gesendet, rote Meldung, Protokoll "abgelehnt"', !r[0] && r[1] && r[1].highlight === 'red' && /Hauptschalter/.test(r[1].payload) && /"ergebnis":"abgelehnt"/.test(r[2][0].payload), r[1] && r[1].payload);
    if (!APPLY_AKTIV) {                                                               // wie ausgeliefert: Sendeknoten deaktiviert, opt_apply weiss das (KNOTEN = false)
        files['/data/optimizer/apply.json'] = '{"enabled": true, "rules": ["quiet_freigabe"]}';
        r = click('uebernehmen', {id: gstore.OPT_engine.prop.id, sum: gstore.OPT_engine.prop.sum});
        const cK = minute(1).eng[0][0].payload;
        check('Wie ausgeliefert (Sendeknoten deaktiviert, KNOTEN = false): auch mit Hauptschalter AN und freigegebener Regel sendet ein Klick nichts, die Meldung nennt den Sendeknoten; Karte "Übernahme gesperrt: Sendeknoten deaktiviert", Knopf grau mit diesem Grund',
              !r[0] && /Sendeknoten opt_apply_mqtt ist deaktiviert/.test(r[1].payload) && gstore.OPT_apply.knoten === false && cK.status.some(s => s.t === 'Übernahme gesperrt: Sendeknoten deaktiviert' && s.c === 'lock') && cK.knopf.ok === false && cK.knopf.grund === 'gesperrt: Sendeknoten deaktiviert', r[1].payload);
        FN.opt_apply = FN.opt_apply.replace('var KNOTEN = false;', 'var KNOTEN = true;'); delete comp.opt_apply;   // ab hier: opt_apply wie mit --uebernahme-knoten-aktiv erzeugt
    }
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
    // 7) Verwerfen: blendet aus, sendet nichts, Punkte bleiben unberuehrt (nach dem Zeitsprung laeuft ein alter Notfall-Vorschlag ab: 60 min Wartezeit, dann neu)
    NOW += 3 * 3600000; world(); minute(75);
    const scoreBefore = JSON.stringify(E.report(fstores.opt_engine.eng.S));
    r = click('verwerfen', {id: gstore.OPT_engine.prop.id});
    R = minute(1);
    check('Verwerfen: nichts gesendet, Karte ohne Vorschlag mit Vermerk in der Statuszeile, Punktebuch unveraendert', !r[0] && R.eng[0][0].payload.prop === null && R.eng[0][0].payload.verworfen === gstore.OPT_engine.prop.id && R.eng[0][0].payload.status.some(s => /^verworfen: /.test(s.t)) && JSON.stringify(E.report(fstores.opt_engine.eng.S)) === scoreBefore, JSON.stringify(R.eng[0][0].payload.status));
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
    for (let k = 0; k < 10; k++) { const pp = Object.assign({}, pp0, {id: 'raum_offset@x' + k, ts: NOW, bis: NOW + 3600000, von: 0}); pp.sum = E.checksum(pp); const rr = E.applyRequest(A, {topic: 'uebernehmen', payload: {id: pp.id, sum: pp.sum}}, {now: NOW, enabled: true, rules: ['raum_offset'], eng: {ts: NOW, prop: pp, locks: {}}, plant: {shift: 0, hpAge: 0.3, block: 0, heatMode: 0, z1Sensor: 0}}); A = rr.A; ns += rr.send.length; A.pending = null; A.aktiv = null; A.ak = {}; NOW += (k === 0 ? 5 : 11) * 60000; }
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
    const en5 = E.applyTick(A5, {now: NOW, eng: {ts: NOW}, plant: {shift: 1, hpAge: 0.3, block: 0}, endReason: {raum_offset: 'Raumvorschlag ist wieder 0 K'}});
    check('Rueckweg, wenn der Grund endet (Raumvorschlag 0): ein Befehl zurueck auf 0 mit Grund im Protokoll', en5.send.length === 1 && en5.send[0].payload === '0' && /Raumvorschlag ist wieder 0 K/.test(en5.log[0].grund), JSON.stringify(en5.log[0]));
    // Takt-Messung: einmaliges Nachladen aus quiet-YYYY-MM.csv in der Huelle (stueckweise ueber mehrere Minuten), waehrenddessen "laedt", danach normal weiter
    { const p2 = v => (v < 10 ? '0' : '') + v, st = tt => { const x = new Date(tt); return x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate()) + ' ' + p2(x.getHours()) + ':' + p2(x.getMinutes()) + ':' + p2(x.getSeconds()); };
      const head = 'zeit,quiet_aktuell,verdichter_hz,leistung_el_w,leistung_th_heisha_w,aussen,defrost,warmwasser,heizregelung';
      let txt = head + '\n'; const t0c = NOW - 8 * 3600000;
      for (let m = 0; m < 8 * 60 - 1; m++) { const tt = t0c + m * 60000 + 5000, runA = (m >= 30 && m < 150) || (m >= 230 && m < 400); txt += st(tt) + ',0,' + (runA ? 25 : 0) + ',' + (runA ? 450 : 30) + ',' + (runA ? 2600 : 0) + ',6,0,0,1\n'; }
      const month = st(NOW).slice(0, 7); files['/data/optimizer/quiet-' + month + '.csv'] = txt;
      const ST0 = fstores.opt_engine.eng; delete ST0.S.takt; world(); gstore.compressor_frequency = 0;
      gstore.OPT_cfg.engine = Object.assign({}, gstore.OPT_cfg.engine || {}, {nachladen: {chunkBytes: 4096, maxBytes: 8192}});
      const Rl = minute(1), sc1 = Rl.eng[0][5].payload.takt[0];
      const laeuft1 = fstores.opt_engine.eng.S.takt.nl.laeuft;
      let k = 0; while (fstores.opt_engine.eng.S.takt.nl.laeuft && k < 40) { minute(1); k++; }
      const T = fstores.opt_engine.eng.S.takt, Rz = minute(1), sc2 = Rz.eng[0][5].payload.takt[0], cop2 = Rz.eng[0][5].payload.cop;
      check('Huelle Nachladen: ohne Nachlade-Stand wird S.takt aus quiet-YYYY-MM.csv gefuellt, stueckweise (8 kB je Minute -> ' + (k + 1) + ' Minuten), Kachel Takt "lädt", danach 2 Laeufe (120 und 170 min), 1 Start mit Pause 80 min, COP-Matrix Spalte Efficiency Q0, Zeile 3…7 °C; Vormonat fehlt ohne Fehler',
            laeuft1 === true && sc1.chip === 'lädt' && k >= 1 && T.nl.laeuft === false && T.nl.zeilen === 8 * 60 - 1 && T.runs.length === 2 && T.runs[0][1] === 120 && T.runs[1][1] === 170 && T.starts.length === 2 && T.pausen.length === 1 && T.pausen[0][1] === 80 && sc2.chip !== 'lädt' && cop2 && cop2.spalten.join() === 'Efficiency Q0' && cop2.zeilen[0].band === '3…7 °C' && !warns.some(w => /Takt nachladen/.test(w)),
            JSON.stringify({k, nl: T.nl, runs: T.runs, starts: T.starts.length, pausen: T.pausen, chip: sc2.chip, cop: cop2}));
      delete gstore.OPT_cfg.engine; }
    // Huelle opt_apply: Hauptschalter bei jedem Takt aus apply.json, Regel-Liste nur Texte, letzte Sicherung vor dem Ausgang (13.10.)
    { files['/data/optimizer/apply-state.json'] = JSON.stringify(E.newApply()); restart(); world();
      files['/data/optimizer/apply.json'] = '{"enabled": true, "rules": [1, null, "quiet_freigabe", {"x": 1}], "_kommentar": "wird nicht gelesen"}';
      runN('opt_apply', {topic: 'tick', payload: NOW}); const okR = gstore.OPT_apply_enabled === true && JSON.stringify(gstore.OPT_apply.rules) === '["quiet_freigabe"]';
      files['/data/optimizer/apply.json'] = '{"enabled": true, "rules": ["quiet_freigabe"]';
      runN('opt_apply', {topic: 'tick', payload: NOW}); const okK = gstore.OPT_apply_enabled === false;
      delete files['/data/optimizer/apply.json']; runN('opt_apply', {topic: 'tick', payload: NOW}); const okF = gstore.OPT_apply_enabled === false;
      check('Huelle opt_apply: Hauptschalter wird bei jedem Takt aus apply.json gelesen, kaputte oder fehlende Datei = aus, Regel-Liste nur aus Texten, unbekannte Felder stoeren nicht', okR && okK && okF, JSON.stringify(gstore.OPT_apply.rules));
      const keepF = FN.opt_apply, w0 = warns.length;
      const stub = "\nENGINE.applyRequest = function () { return {A: ENGINE.newApply(), send: [{topic: 'panasonic_heat_pump/commands/SetHeatingControl', payload: '1', source: 'x'}, {topic: 'panasonic_heat_pump/commands/SetQuietMode', payload: '7', source: 'x'}, " +
                   "{topic: 'panasonic_heat_pump/commands/SetZ1HeatRequestTemperature', payload: 'abc', source: 'x'}, {topic: 'panasonic_heat_pump/commands/SetQuietMode', payload: '2', source: 'Optimierer (Klick)'}], toast: null, log: []}; };\n";
      FN.opt_apply = keepF.replace('// == ENGINE-CORE-ENDE ==', '// == ENGINE-CORE-ENDE ==' + stub); delete comp.opt_apply;
      const o1 = runN('opt_apply', {topic: 'uebernehmen', payload: {id: 'x', sum: 'y'}}); gstore.MQTT.block_active = 1;
      const o2 = runN('opt_apply', {topic: 'uebernehmen', payload: {id: 'x', sum: 'y'}}); gstore.MQTT.block_active = 0;
      FN.opt_apply = keepF; delete comp.opt_apply; files['/data/optimizer/apply-state.json'] = JSON.stringify(E.newApply()); restart();
      check('Huelle opt_apply, letzte Sicherung vor dem Ausgang (Kern absichtlich verfaelscht): Befehl ausserhalb der Whitelist, unerlaubter Wert und Nicht-Zahl werden verworfen (je Warnung), nur SetQuietMode = 2 geht hinaus (retain aus); bei Notbremse geht gar nichts hinaus',
            o1[0] && o1[0].length === 1 && o1[0][0].topic === 'panasonic_heat_pump/commands/SetQuietMode' && o1[0][0].payload === '2' && o1[0][0].retain === false && !o2[0] && warns.slice(w0).filter(w => /Befehl verworfen/.test(w)).length === 7, warns.slice(w0).join(' | ')); }
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

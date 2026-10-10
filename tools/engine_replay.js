// Rueckwirkende Pruefung (Replay): spielt die echten Minutenprotokolle offline mit Fake-Uhr durch die Entscheidungsmaschine (tools/engine_core.js).
// Nur lesen: quiet-YYYY-MM.csv (1 min; aeltere Stillstandszeilen 5 min), optimizer-v2-YYYY-MM.csv (5 min, Raeume + Raumvorschlag Phase 2).
// Usage: node tools/engine_replay.js <Datenordner> [Ausgabeordner]   (schreibt decisions-*.jsonl, scores-*.jsonl, events.csv, report.json in den Ausgabeordner)
// Annahmen fuer Werte, die das Protokoll nicht enthaelt, stehen in ASSUME (und im Bericht).
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const ENGINE = require('./engine_core.js');

const ASSUME = {
    heatOffAT: 12,              // Heating_Off_Outdoor_Temp: live 12 °C (nicht im Protokoll)
    htrOnAT: 0,                 // Heater_On_Outdoor_Temp 0 °C (HeishaMon, 09.10.)
    htrStartDelta: -3,          // Heater_Start_Delta -3 K (nur bis 09.10. ~08:00 nicht im Protokoll)
    heatMode: 0,                // TOP76 Heizkurvenmodus
    z1Sensor: 0,                // TOP111 Wasserfuehler
    block: 0,                   // MQTT.block_active (nicht protokolliert)
    shift: 0,                   // TOP27 vor 09.10. 20:48 (danach Spalte shift_anlage; alle Sollspruenge melden 0 K)
    maxAgeMin: 90,              // Raum-Datenalter-Limit (config.json: 90 fuer alle Raeume)
    korrMaxAgeMin: 10,          // Raumvorschlag aus optimizer-v2 (5 min) gilt hoechstens 10 min
    curve: [-13, 11, 29, 38]    // Heizkurve Z1 (live): Aussen -13 °C -> 38 °C, 11 °C -> 29 °C (wie Z1_Heat_Curve_*)
};
const ROOMS = [['ki_oben', 'Kinderzimmer oben'], ['ki_unten', 'Kinderzimmer unten'], ['schlaf', 'Schlafzimmer'], ['wohn', 'Wohnzimmer']];

function readMulti(file) {                                                     // CSV mit wechselnden Kopfzeilen (aeltere Zeilen haben weniger Spalten)
    const rows = []; let head = null;
    if (!fs.existsSync(file)) { return rows; }
    fs.readFileSync(file, 'utf8').split('\n').forEach(l => {
        if (!l) { return; }
        const p = l.split(',');
        if (p[0] === 'zeit') { head = p; return; }
        if (!head || p.length !== head.length) { return; }
        const o = {}; head.forEach((h, i) => { o[h] = p[i]; });
        const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(p[0]);
        if (!m) { return; }
        o._t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        rows.push(o);
    });
    return rows.sort((a, b) => a._t - b._t);
}
function curve(at) { if (at === null) { return null; } if (at <= ASSUME.curve[0]) { return ASSUME.curve[3]; } if (at >= ASSUME.curve[1]) { return ASSUME.curve[2]; } return ASSUME.curve[3] + (ASSUME.curve[2] - ASSUME.curve[3]) * (at - ASSUME.curve[0]) / (ASSUME.curve[1] - ASSUME.curve[0]); }
function n(x) { if (x === undefined || x === null || x === '') { return null; } const v = Number(x); return isFinite(v) ? v : null; }

function buildInputs(dataDir, month) {
    const Q = readMulti(path.join(dataDir, 'quiet-' + month + '.csv'));
    const V = readMulti(path.join(dataDir, 'optimizer-v2-' + month + '.csv'));
    if (!Q.length) { throw new Error('keine Daten in ' + dataDir); }
    const MIN = 60000, t0 = Math.ceil(Q[0]._t / MIN) * MIN, t1 = Q[Q.length - 1]._t;
    const out = []; let qi = 0, vi = -1;
    for (let t = t0; t <= t1; t += MIN) {
        while (qi + 1 < Q.length && Q[qi + 1]._t <= t) { qi++; }
        while (vi + 1 < V.length && V[vi + 1]._t <= t) { vi++; }
        const r = Q[qi]; if (r._t > t) { continue; }
        const v = vi >= 0 ? V[vi] : null, vAge = v ? (t - v._t) / MIN : null;
        const inp = {t: t, hpAge: (t - r._t) / MIN,
            hz: n(r.verdichter_hz), vl: n(r.ist_vl), rl: n(r.ist_rl), soll: n(r.soll_vl), dT: n(r.spreizung_ziel), pel: n(r.leistung_el_w), pth: n(r.leistung_th_heisha_w),
            flow: n(r.flow_l_min), pump: n(r.pumpe_speed), q: n(r.quiet_aktuell), qPrio: n(r.quiet_prioritaet), hc: n(r.heizregelung), at: n(r.aussen),
            defrost: n(r.defrost), dhw: n(r.warmwasser), ss: n(r.softstart), rt: n(r.verdichter_laufzeit_min),
            shift: n(r.shift_anlage) !== null ? n(r.shift_anlage) : ASSUME.shift, heatMode: ASSUME.heatMode, z1Sensor: ASSUME.z1Sensor,
            heaterI: n(r.heizstab_intern), heaterE: n(r.heizstab_extern), htrOnAT: ASSUME.htrOnAT,
            htrStartDelta: n(r.heizstab_start_delta) !== null ? n(r.heizstab_start_delta) : ASSUME.htrStartDelta,
            heatOffAT: ASSUME.heatOffAT, sollKurve: curve(n(r.aussen)), block: ASSUME.block, otherQ: null, otherShift: null, kzRad: n(r.kz_radiator_an), rooms: []};
        if (v) {
            ROOMS.forEach(([id, name]) => {
                const mn = n(v[id + '_min']), mx = n(v[id + '_max']), ema = n(v[id + '_ema']), age = n(v[id + '_alter_min']);
                if (mn === null || mx === null) { return; }
                const ageNow = age === null ? null : age + vAge;
                inp.rooms.push({id: id, name: name, t: ema, age: ageNow, min: mn, max: mx, active: true, valid: v[id + '_gueltig'] === '1' && ageNow !== null && ageNow <= ASSUME.maxAgeMin && ema !== null});
            });
            if (vAge <= ASSUME.korrMaxAgeMin && n(v.korrektur_vorschlag) !== null) {
                inp.korr = {v: n(v.korrektur_vorschlag), code: (v.regelung_grund || '').replace(/;/g, ','), distrib: v.waermeverteilung === '1', lead: v.fuehrungsraum || ''};
            }
        }
        out.push(inp);
    }
    return out;
}

function replay(dataDir, opts) {
    opts = opts || {};
    const month = opts.month || '2026-10';
    const inputs = buildInputs(dataDir, month);
    const cfg = ENGINE.mergeCfg(opts.cfg || {});
    let S = null;
    const recs = [], scores = [], events = [], props = [], perMin = [];
    let bytes = 0;
    inputs.forEach((inp, i) => {
        if (opts.restartAt && opts.restartAt.indexOf(i) >= 0) { S = JSON.parse(JSON.stringify(S)); S.born = inp.t; }      // Neustart: Zustand aus Datei, Zeitgeber neu
        const o = ENGINE.step(S, inp, cfg);
        S = o.S;
        const line = JSON.stringify(o.rec);
        bytes += line.length + 1;
        if (opts.keepRecs !== false) { recs.push(line); }
        o.scores.forEach(s => scores.push(s));
        o.ev.forEach(e => events.push([ENGINE.iso(inp.t), e[0], e[1]]));
        if (o.res.some(r => r.neu)) { o.res.filter(r => r.neu).forEach(r => props.push(JSON.parse(JSON.stringify(S.rules[r.id].prop)))); }
        perMin.push({t: inp.t, st: o.res.map(r => r.st), prop: o.prop ? o.prop.id : null});
    });
    const report = ENGINE.report(S);
    if (opts.outDir) {
        fs.mkdirSync(opts.outDir, {recursive: true});
        fs.writeFileSync(path.join(opts.outDir, 'decisions-' + month + '.jsonl'), recs.join('\n') + '\n');
        fs.writeFileSync(path.join(opts.outDir, 'scores-' + month + '.jsonl'), scores.map(s => JSON.stringify(s)).join('\n') + (scores.length ? '\n' : ''));
        fs.writeFileSync(path.join(opts.outDir, 'events.csv'), 'zeit,ereignis,text\n' + events.map(e => e.map(x => String(x).replace(/,/g, ';')).join(',')).join('\n') + '\n');
        fs.writeFileSync(path.join(opts.outDir, 'report.json'), JSON.stringify({report: report, props: props, week: S.sc.week, base: S.sc.base, assume: ASSUME, bytesPerDay: Math.round(bytes / (inputs.length / 1440))}, null, 1));
    }
    return {inputs: inputs, S: S, recs: recs, scores: scores, events: events, props: props, perMin: perMin, report: report, bytes: bytes, cfg: cfg};
}

module.exports = {replay: replay, buildInputs: buildInputs, readMulti: readMulti, ASSUME: ASSUME};

if (require.main === module) {
    const dir = process.argv[2], out = process.argv[3];
    if (!dir) { console.error('Usage: node tools/engine_replay.js <Datenordner> [Ausgabeordner]'); process.exit(2); }
    const R = replay(dir, {outDir: out});
    console.log('Minuten:', R.inputs.length, '· Datensaetze', R.recs.length, '· Bytes/Tag', Math.round(R.bytes / (R.inputs.length / 1440)));
    console.log('Vorschlaege/Hinweise:'); R.props.forEach(p => console.log('  ' + p.id + ' · ' + p.was + ' · ' + p.warum));
    console.log('Ereignisse:'); R.events.forEach(e => console.log('  ' + e.join(' · ')));
    console.log('Punkte:'); R.scores.forEach(s => console.log('  ' + s.t + ' ' + s.typ + ' ' + s.regel + ' ' + s.punkte + ' · ' + s.text));
    console.log('Bericht:'); R.report.forEach(r => console.log('  ' + r.regel + ' v' + r.v + ': ' + r.punkte + ' Punkte, Faelle ' + r.faelle + ' (bewertet ' + r.bewertet + ', Treffer ' + r.treffer + ', Fehlalarm ' + r.fehlalarm + '), Schaden ' + r.schaden + ', verpasst ' + r.verpasst + ', Wirkung ' + JSON.stringify(r.wirkung)));
}

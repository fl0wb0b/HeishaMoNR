// Replay der Entscheidungsmaschine (tools/engine_core.js) für EINEN Kalendertag, mit Einschwingen über die Vortage.
// Nutzt buildInputs()/markdown() aus tools/engine_replay.js unverändert; nur lesen (quiet-, optimizer-v2-, decisions-JJJJ-MM.*).
// Abgleich mit dem Live-Lauf: Status je Regel und Minute gegen decisions-JJJJ-MM.jsonl (gleiche Regel-ID, gleiche Minute).
// Usage: node tools/replay_tag.js <Datenordner> <Ergebnisordner> [--tag JJJJ-MM-TT (Standard: gestern)] [--vorlauf 7]
//   schreibt <Ergebnisordner>/replay/<tag>.md (Bericht) und <tag>.json (Zusammenfassung für status.json/Beobachter)
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const ENGINE = require('./engine_core.js');
const REPLAY = require('./engine_replay.js');

const MIN = 60000, TAG = 86400000, VERSION = 1;
const pad = x => String(x).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const monat = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);

function args(argv) {
    const a = {daten: argv[2], ergebnis: argv[3], tag: null, vorlauf: 7};
    for (let i = 4; i < argv.length; i++) {
        if (argv[i] === '--tag') { a.tag = argv[++i]; } else if (argv[i] === '--vorlauf') { a.vorlauf = Number(argv[++i]); } else { throw new Error('unbekannte Option ' + argv[i]); }
    }
    if (!a.daten || !a.ergebnis || (a.daten || '').indexOf('--') === 0) { throw new Error('Usage: node tools/replay_tag.js <Datenordner> <Ergebnisordner> [--tag JJJJ-MM-TT] [--vorlauf 7]'); }
    if (a.tag !== null && !/^\d{4}-\d\d-\d\d$/.test(a.tag)) { throw new Error('--tag JJJJ-MM-TT erwartet'); }
    if (!(a.vorlauf >= 0 && a.vorlauf <= 31)) { throw new Error('--vorlauf 0…31 Tage'); }
    return a;
}

function liveStatus(datei, tagS) {                                               // Minute -> {regel: status} aus decisions-*.jsonl (nur Zeilen des Tages)
    const out = new Map(), props = new Set();
    if (!fs.existsSync(datei)) { return null; }
    const text = fs.readFileSync(datei, 'utf8'), praefix = '{"t":"' + tagS;
    let i = 0;
    while (i < text.length) {
        let j = text.indexOf('\n', i); if (j < 0) { j = text.length; }
        if (text.startsWith(praefix, i)) {
            try {
                const d = JSON.parse(text.slice(i, j)), st = {};
                (d.r || []).forEach(r => { st[r.id] = r.st; if ((r.st === 'vorschlag' || r.st === 'hinweis') && r.p) { props.add(r.p); } });
                out.set(String(d.t).slice(0, 16), st);
            } catch (e) { /* kaputte Zeile überspringen */ }
        }
        i = j + 1;
    }
    return {min: out, props: props};
}

function main() {
    const a = args(process.argv);
    const heute = new Date(); heute.setHours(0, 0, 0, 0);
    const t0 = a.tag ? new Date(+a.tag.slice(0, 4), +a.tag.slice(5, 7) - 1, +a.tag.slice(8, 10)).getTime() : new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() - 1).getTime();
    const d0 = new Date(t0), tagS = ymd(d0), t1 = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1).getTime();
    const tStart = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - a.vorlauf).getTime();
    const monate = [];
    for (let d = new Date(tStart); d.getTime() < t1; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) { if (monate.indexOf(monat(d)) < 0) { monate.push(monat(d)); } }
    if (!fs.existsSync(path.join(a.daten, 'quiet-' + monat(d0) + '.csv'))) { throw new Error('quiet-' + monat(d0) + '.csv fehlt im Datenordner'); }
    let inputs = [];
    monate.forEach(m => {
        if (!fs.existsSync(path.join(a.daten, 'quiet-' + m + '.csv'))) { return; }      // Vormonat fehlt: kürzeres Einschwingen
        try { inputs = inputs.concat(REPLAY.buildInputs(a.daten, m)); } catch (e) { if (m === monat(d0)) { throw e; } }
    });
    inputs = inputs.filter(x => x.t >= tStart && x.t < t1);
    const tagInputs = inputs.filter(x => x.t >= t0);
    if (!tagInputs.length) { throw new Error('keine Minutenzeilen am ' + tagS); }
    const cfg = ENGINE.mergeCfg({});
    let S = null, bytes = 0;
    const recs = [], scores = [], events = [], props = [], perMin = [], replaySt = new Map();
    inputs.forEach(inp => {
        const o = ENGINE.step(S, inp, cfg);
        S = o.S;
        if (inp.t < t0) { return; }
        const line = JSON.stringify(o.rec);
        bytes += line.length + 1;
        recs.push(line);
        o.scores.forEach(s => scores.push(s));
        o.ev.forEach(e => events.push([ENGINE.iso(inp.t), e[0], e[1]]));
        o.res.filter(r => r.neu).forEach(r => props.push(JSON.parse(JSON.stringify(S.rules[r.id].prop))));
        perMin.push({t: inp.t, st: o.res.map(r => r.st), prop: o.prop ? o.prop.id : null});
        const st = {}; o.res.forEach((r, i) => { st[ENGINE.RULES[i].id] = r.st; });
        replaySt.set(ENGINE.iso(inp.t).slice(0, 16), st);
    });
    const report = ENGINE.report(S);
    const R = {inputs: tagInputs, S: S, recs: recs, scores: scores, events: events, props: props, perMin: perMin, report: report, bytes: bytes, cfg: cfg};
    // Abgleich mit dem Live-Lauf
    const live = liveStatus(path.join(a.daten, 'decisions-' + monat(d0) + '.jsonl'), tagS);
    const abgleich = {liveMinuten: live ? live.min.size : 0, gemeinsam: 0, regeln: {}, liveVorschlaege: live ? live.props.size : 0};
    if (live) {
        replaySt.forEach((st, m) => {
            const l = live.min.get(m); if (!l) { return; }
            abgleich.gemeinsam++;
            Object.keys(st).forEach(id => {
                if (l[id] === undefined) { return; }
                const g = abgleich.regeln[id] || (abgleich.regeln[id] = {minuten: 0, gleich: 0, vorschlagLive: 0, vorschlagReplay: 0});
                g.minuten++; if (l[id] === st[id]) { g.gleich++; }
                if (l[id] === 'vorschlag' || l[id] === 'hinweis') { g.vorschlagLive++; }
                if (st[id] === 'vorschlag' || st[id] === 'hinweis') { g.vorschlagReplay++; }
            });
        });
        Object.values(abgleich.regeln).forEach(g => { g.gleichProzent = g.minuten ? Math.round(1000 * g.gleich / g.minuten) / 10 : null; });
    }
    let gm = 0, gg = 0; Object.values(abgleich.regeln).forEach(g => { gm += g.minuten; gg += g.gleich; });
    abgleich.gleichProzent = gm ? Math.round(1000 * gg / gm) / 10 : null;
    const names = {}; ENGINE.RULES.forEach(x => { names[x.id] = x.name; });
    const L = ['# Replay der Entscheidungsmaschine – ' + tagS, '',
        'Offline mit Fake-Uhr aus den Protokollen (quiet-, optimizer-v2-*.csv), Einschwingen ab ' + ymd(new Date(inputs[0].t)) + ' (' + a.vorlauf + ' Tage Vorlauf, soweit Daten da sind); ' +
        'Maschine `engine_core.js` v' + ENGINE.VER + ', Bewertungsregeln v' + ENGINE.SCORE_VER + '. Der Bericht unten zeigt nur den Tag ' + tagS + ' (' + tagInputs.length + ' Minuten); „Stand am Ende“ ist der Stand nach dem Tag.', '',
        '## Abgleich mit dem Live-Lauf (decisions-' + monat(d0) + '.jsonl)', ''];
    if (!live) {
        L.push('decisions-' + monat(d0) + '.jsonl fehlt: kein Abgleich.');
    } else {
        L.push('Live-Datensätze am Tag: ' + abgleich.liveMinuten + ', gemeinsame Minuten: ' + abgleich.gemeinsam + ', Status gleich: ' + (abgleich.gleichProzent === null ? '–' : ENGINE.de(abgleich.gleichProzent, 1) + ' %') + '.', '',
            'Abweichungen entstehen durch den Zustand der Live-Maschine (Neustarts, Freigaben, Sperren von Hand) und durch Werte, die das Protokoll nicht enthält (Annahmen unten). Sie sind ein Hinweis, kein Fehler.', '',
            '| Regel | Minuten | Status gleich | Vorschlag/Hinweis live | Vorschlag/Hinweis Replay |', '|---|---|---|---|---|');
        Object.keys(abgleich.regeln).forEach(id => { const g = abgleich.regeln[id]; L.push('| ' + (names[id] || id) + ' | ' + g.minuten + ' | ' + ENGINE.de(g.gleichProzent, 1) + ' % | ' + g.vorschlagLive + ' | ' + g.vorschlagReplay + ' |'); });
    }
    L.push('', '## Bericht des Tages', '', REPLAY.markdown(R));
    const ordner = path.join(a.ergebnis, 'replay');
    fs.mkdirSync(ordner, {recursive: true});
    const schreibe = (f, txt) => { const tmp = path.join(ordner, '.tmp_' + f); fs.writeFileSync(tmp, txt, {mode: 0o644}); fs.renameSync(tmp, path.join(ordner, f)); };
    const statusMin = {}; ENGINE.RULES.forEach((x, i) => { const c = {}; perMin.forEach(m => { c[m.st[i]] = (c[m.st[i]] || 0) + 1; }); statusMin[x.id] = c; });
    const zus = {tag: tagS, version: VERSION, maschine: ENGINE.VER, bewertung: ENGINE.SCORE_VER, vorlaufTage: a.vorlauf, einschwingenAb: ymd(new Date(inputs[0].t)),
        minuten: tagInputs.length, statusMinuten: statusMin,
        vorschlaege: props.map(p => ({zeit: ENGINE.iso(p.ts).slice(0, 16), regel: p.rule, was: p.was, warum: p.warum})),
        ereignisse: events.length, punkte: scores.map(s => ({zeit: s.t, typ: s.typ, regel: s.regel, punkte: s.punkte})),
        stand: report.map(r => ({regel: r.regel, punkte: r.punkte, faelle: r.faelle, treffer: r.treffer, fehlalarm: r.fehlalarm, reif: r.art === 'befehl' ? !!r.reif : null})),
        abgleichLive: abgleich};
    schreibe(tagS + '.md', L.join('\n') + '\n');
    schreibe(tagS + '.json', JSON.stringify(zus, null, 1) + '\n');
    console.log('Replay ' + tagS + ': ' + tagInputs.length + ' Minuten (Einschwingen ab ' + zus.einschwingenAb + '), ' + props.length + ' Vorschläge/Hinweise, ' + events.length + ' Ereignisse, ' +
        scores.length + ' Punkte-Einträge; Status gleich live ' + (abgleich.gleichProzent === null ? '–' : abgleich.gleichProzent + ' %') + ' (' + abgleich.gemeinsam + ' gemeinsame Minuten)');
}

try { main(); } catch (e) { console.error('Fehler: ' + e.message); process.exit(1); }

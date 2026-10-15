// Replay der Entscheidungsmaschine (tools/engine_core.js) für EINEN Kalendertag, mit Einschwingen über die Vortage.
// Nutzt buildInputs()/markdown() aus tools/engine_replay.js unverändert; nur lesen (quiet-, optimizer-v2-, decisions-JJJJ-MM.*).
// Eingänge (--eingang): „live“ (Standard) = je Minute die Eingabe, die die Live-Maschine selbst protokolliert hat (decisions-*.jsonl → in,
//   über ENGINE.unsnap), ergänzt aus den Protokollen, wo der Datensatz fehlt oder ein Feld nicht enthält; „protokoll“ = nur quiet-/optimizer-v2-*.csv
//   (Räume und Raumvorschlag dann nur alle 5 min, siehe engine_replay.ASSUME).
// Abgleich mit dem Live-Lauf: Status je Regel und Minute gegen decisions-*.jsonl, NUR in Minuten, in denen live dieselbe Regelversion lief
//   wie im Replay (sonst vergleicht man zwei verschiedene Regeln). Eine Regel ist „bewertbar“, wenn mindestens 90 % ihrer Live-Minuten
//   vergleichbar sind und mindestens 60 Minuten; die Güte (gleichProzent) gibt es nur über bewertbare Regeln, sonst null mit Grund.
// Usage: node tools/replay_tag.js <Datenordner> <Ergebnisordner> [--tag JJJJ-MM-TT (Standard: gestern)] [--vorlauf 7] [--eingang live|protokoll]
//   schreibt <Ergebnisordner>/replay/<tag>.md (Bericht) und <tag>.json (Zusammenfassung für status.json/Beobachter)
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const ENGINE = require('./engine_core.js');
const REPLAY = require('./engine_replay.js');

const MIN = 60000, TAG = 86400000, VERSION = 2;
const BEWERTBAR_ANTEIL = 0.9, BEWERTBAR_MIN = 60;                               // Regel bewertbar: ≥ 90 % der Live-Minuten mit gleicher Regelversion, ≥ 60 min
const pad = x => String(x).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const monat = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);

function args(argv) {
    const a = {daten: argv[2], ergebnis: argv[3], tag: null, vorlauf: 7, eingang: 'live'};
    for (let i = 4; i < argv.length; i++) {
        if (argv[i] === '--tag') { a.tag = argv[++i]; } else if (argv[i] === '--vorlauf') { a.vorlauf = Number(argv[++i]); } else if (argv[i] === '--eingang') { a.eingang = argv[++i]; } else { throw new Error('unbekannte Option ' + argv[i]); }
    }
    if (!a.daten || !a.ergebnis || (a.daten || '').indexOf('--') === 0) { throw new Error('Usage: node tools/replay_tag.js <Datenordner> <Ergebnisordner> [--tag JJJJ-MM-TT] [--vorlauf 7] [--eingang live|protokoll]'); }
    if (a.tag !== null && !/^\d{4}-\d\d-\d\d$/.test(a.tag)) { throw new Error('--tag JJJJ-MM-TT erwartet'); }
    if (!(a.vorlauf >= 0 && a.vorlauf <= 31)) { throw new Error('--vorlauf 0…31 Tage'); }
    if (a.eingang !== 'live' && a.eingang !== 'protokoll') { throw new Error('--eingang live|protokoll'); }
    return a;
}

function liveLesen(daten, monate, vonS, bisS) {                                 // Minute (JJJJ-MM-TT HH:MM) -> {in, r: {id: {st, v}}} aus decisions-*.jsonl, nur Zeilen im Fenster
    const out = new Map(), dateien = [];
    monate.forEach(m => {
        const datei = path.join(daten, 'decisions-' + m + '.jsonl');
        if (!fs.existsSync(datei)) { return; }
        dateien.push(path.basename(datei));
        const text = fs.readFileSync(datei, 'utf8');
        let i = 0;
        while (i < text.length) {
            let j = text.indexOf('\n', i); if (j < 0) { j = text.length; }
            const ts = text.slice(i + 6, i + 22);                               // {"t":"JJJJ-MM-TT HH:MM
            if (text.startsWith('{"t":"', i) && ts >= vonS && ts < bisS) {
                try {
                    const d = JSON.parse(text.slice(i, j)), r = {};
                    (d.r || []).forEach(x => { r[x.id] = {st: x.st, v: x.v}; });
                    out.set(String(d.t).slice(0, 16), {in: d.in || null, r: r});
                } catch (e) { /* kaputte Zeile überspringen */ }
            }
            i = j + 1;
        }
    });
    return {min: out, dateien: dateien};
}

function mitLiveEingang(inp, L) {                                               // Protokoll-Eingabe der Minute, überschrieben mit der Live-Eingabe (soweit protokolliert)
    if (!L || !L.in) { return false; }
    const u = ENGINE.unsnap(inp.t, L.in);
    Object.keys(u).forEach(k => { inp[k] = u[k]; });
    if (!L.in.rooms) { inp.rooms = []; }
    if (!L.in.korr) { delete inp.korr; }                                         // live ohne Raumvorschlag/Vorhersage: dann auch hier ohne
    if (!L.in.vs) { delete inp.vs; }
    return true;
}

function lauf(inputs, t0, cfg, voll) {                                          // Maschine über alle Minuten; ab t0 Status je Regel (und bei voll alles für den Bericht)
    let S = null, bytes = 0;
    const recs = [], scores = [], events = [], props = [], perMin = [], st = new Map();
    inputs.forEach(inp => {
        const o = ENGINE.step(S, inp, cfg);
        S = o.S;
        if (inp.t < t0) { return; }
        const m = {}; o.res.forEach((r, i) => { m[ENGINE.RULES[i].id] = r.st; });
        st.set(ENGINE.iso(inp.t).slice(0, 16), m);
        if (!voll) { return; }
        const line = JSON.stringify(o.rec);
        bytes += line.length + 1;
        recs.push(line);
        o.scores.forEach(s => scores.push(s));
        o.ev.forEach(e => events.push([ENGINE.iso(inp.t), e[0], e[1]]));
        o.res.filter(r => r.neu).forEach(r => props.push(JSON.parse(JSON.stringify(S.rules[r.id].prop))));
        perMin.push({t: inp.t, st: o.res.map(r => r.st), prop: o.prop ? o.prop.id : null});
    });
    return {S: S, bytes: bytes, recs: recs, scores: scores, events: events, props: props, perMin: perMin, st: st};
}

function abgleichen(replaySt, live) {                                           // nur Minuten mit gleicher Regelversion live/Replay
    const ver = {}; ENGINE.RULES.forEach(x => { ver[x.id] = x.ver; });
    const A = {gemeinsam: 0, regeln: {}};
    replaySt.forEach((st, m) => {
        const l = live.min.get(m); if (!l) { return; }
        A.gemeinsam++;
        Object.keys(st).forEach(id => {
            const lr = l.r[id]; if (!lr) { return; }
            const g = A.regeln[id] || (A.regeln[id] = {replayVersion: ver[id], liveVersionen: {}, minuten: 0, vergleichbar: 0, gleich: 0, vorschlagLive: 0, vorschlagReplay: 0});
            g.minuten++; g.liveVersionen['v' + lr.v] = (g.liveVersionen['v' + lr.v] || 0) + 1;
            if (lr.v !== ver[id]) { return; }
            g.vergleichbar++; if (lr.st === st[id]) { g.gleich++; }
            if (lr.st === 'vorschlag' || lr.st === 'hinweis') { g.vorschlagLive++; }
            if (st[id] === 'vorschlag' || st[id] === 'hinweis') { g.vorschlagReplay++; }
        });
    });
    let vm = 0, vg = 0, am = 0, ag = 0;
    const nicht = [];
    Object.keys(A.regeln).forEach(id => {
        const g = A.regeln[id];
        g.gleichProzent = g.vergleichbar ? Math.round(1000 * g.gleich / g.vergleichbar) / 10 : null;
        am += g.vergleichbar; ag += g.gleich;
        g.bewertbar = g.vergleichbar >= BEWERTBAR_MIN && g.vergleichbar >= BEWERTBAR_ANTEIL * g.minuten;
        if (!g.bewertbar) {
            const andere = Object.keys(g.liveVersionen).filter(v => v !== 'v' + g.replayVersion);
            g.grund = andere.length ? 'live lief ' + andere.map(v => v + ' (' + g.liveVersionen[v] + ' min)').join(', ') + ', Replay rechnet v' + g.replayVersion + ': nur ' + g.vergleichbar + ' von ' + g.minuten + ' Minuten vergleichbar'
                : 'zu wenige Minuten (' + g.vergleichbar + ')';
            nicht.push(id);
            return;
        }
        vm += g.vergleichbar; vg += g.gleich;
    });
    A.gleichProzent = vm ? Math.round(1000 * vg / vm) / 10 : null;
    A.bewertbar = vm > 0;
    A.gleichProzentVergleichbar = am ? Math.round(1000 * ag / am) / 10 : null;      // über alle Minuten gleicher Version, auch nicht bewertbarer Regeln (nur Anzeige)
    A.nichtBewertbar = nicht;
    A.grund = !A.gemeinsam ? 'keine Live-Datensätze am Tag' : (!vm ? 'keine Regel bewertbar (' + nicht.map(id => id + ': ' + A.regeln[id].grund).join('; ') + ')' : null);
    return A;
}

function raumLuecken(tagInputs) {                                               // je Raum: Minuten ohne gültigen Wert (Fühler zu alt/ungültig) und längste Lücke am Stück
    const R = {};
    tagInputs.forEach(inp => (inp.rooms || []).forEach(r => {
        const x = R[r.id] || (R[r.id] = {name: r.name || r.id, minuten: 0, ungueltig: 0, laengsteMin: 0, _lauf: 0});
        x.minuten++;
        if (r.valid) { x._lauf = 0; return; }
        x.ungueltig++; x._lauf++; if (x._lauf > x.laengsteMin) { x.laengsteMin = x._lauf; }
    }));
    Object.values(R).forEach(x => { delete x._lauf; });
    return R;
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
    const live = liveLesen(a.daten, monate, ymd(new Date(tStart)), ymd(new Date(t1)));
    const live_ok = live.dateien.indexOf('decisions-' + monat(d0) + '.jsonl') >= 0;
    const protokollInputs = a.eingang === 'live' && live_ok ? structuredClone(inputs) : null;     // Kopie für den Vergleichslauf nur aus Protokollen
    let ausLive = 0, ausLiveTag = 0;
    if (a.eingang === 'live') { inputs.forEach(inp => { if (mitLiveEingang(inp, live.min.get(ENGINE.iso(inp.t).slice(0, 16)))) { ausLive++; if (inp.t >= t0) { ausLiveTag++; } } }); }
    const X = lauf(inputs, t0, cfg, true), S = X.S;
    const report = ENGINE.report(S);
    const R = {inputs: tagInputs, S: S, recs: X.recs, scores: X.scores, events: X.events, props: X.props, perMin: X.perMin, report: report, bytes: X.bytes, cfg: cfg};
    const props = X.props, events = X.events, scores = X.scores, perMin = X.perMin;
    // Abgleich mit dem Live-Lauf (nur gleiche Regelversion)
    const abgleich = live_ok ? abgleichen(X.st, live) : {gemeinsam: 0, regeln: {}, gleichProzent: null, bewertbar: false, nichtBewertbar: [], grund: 'decisions-' + monat(d0) + '.jsonl fehlt'};
    abgleich.liveMinuten = 0; X.st.forEach((v, m) => { if (live.min.has(m)) { abgleich.liveMinuten++; } });
    abgleich.eingang = a.eingang;
    abgleich.eingangAusLive = {tag: ausLiveTag, tagMinuten: tagInputs.length, gesamt: ausLive, gesamtMinuten: inputs.length};
    if (a.eingang === 'live' && live_ok && ausLiveTag < BEWERTBAR_ANTEIL * tagInputs.length) {             // ohne Live-Eingänge misst der Abgleich die 5-min-Protokolle mit, nicht die Maschine
        abgleich.bewertbar = false; abgleich.gleichProzent = null;
        abgleich.grund = 'nur ' + ausLiveTag + ' von ' + tagInputs.length + ' Minuten mit Live-Eingabe (decisions-*.jsonl)';
    } else if (a.eingang !== 'live' && abgleich.bewertbar) {
        abgleich.bewertbar = false; abgleich.gleichProzent = null; abgleich.grund = 'Eingänge nur aus den Protokollen (--eingang protokoll): Räume/Raumvorschlag 5-min-Werte, kein sauberes Maß';
    }
    if (protokollInputs) {                                                      // zum Vergleich: dieselbe Rechnung nur aus quiet-/optimizer-v2-*.csv (Anzeige, nicht in status.json)
        const P = abgleichen(lauf(protokollInputs, t0, cfg, false).st, live);
        abgleich.nurProtokoll = {gleichProzent: P.gleichProzent, gleichProzentVergleichbar: P.gleichProzentVergleichbar, regeln: {}};
        Object.keys(P.regeln).forEach(id => { abgleich.nurProtokoll.regeln[id] = P.regeln[id].gleichProzent; });
    }
    const names = {}; ENGINE.RULES.forEach(x => { names[x.id] = x.name; });
    const pz = v => v === null || v === undefined ? '–' : ENGINE.de(v, 1) + ' %';
    const L = ['# Replay der Entscheidungsmaschine – ' + tagS, '',
        'Offline mit Fake-Uhr, Einschwingen ab ' + ymd(new Date(inputs[0].t)) + ' (' + a.vorlauf + ' Tage Vorlauf, soweit Daten da sind); ' +
        'Maschine `engine_core.js` v' + ENGINE.VER + ', Bewertungsregeln v' + ENGINE.SCORE_VER + '. ' +
        (a.eingang === 'live' ? 'Eingänge: je Minute die Eingabe der Live-Maschine aus decisions-*.jsonl (' + ausLive + ' von ' + inputs.length + ' Minuten, am Tag ' + ausLiveTag + ' von ' + tagInputs.length + '), sonst aus quiet-/optimizer-v2-*.csv. '
            : 'Eingänge nur aus quiet-/optimizer-v2-*.csv (Räume und Raumvorschlag 5-min-Werte). ') +
        'Der Bericht unten zeigt nur den Tag ' + tagS + ' (' + tagInputs.length + ' Minuten); „Stand am Ende“ ist der Stand nach dem Tag.', '',
        '## Abgleich mit dem Live-Lauf (decisions-' + monat(d0) + '.jsonl)', ''];
    if (!live_ok) {
        L.push('decisions-' + monat(d0) + '.jsonl fehlt: kein Abgleich.');
    } else {
        L.push('Live-Datensätze am Tag: ' + abgleich.liveMinuten + ', gemeinsame Minuten: ' + abgleich.gemeinsam + '. ' +
            'Verglichen werden nur Minuten, in denen live dieselbe Regelversion lief wie im Replay; eine Regel ist bewertbar ab ' + Math.round(100 * BEWERTBAR_ANTEIL) + ' % vergleichbarer Minuten (mindestens ' + BEWERTBAR_MIN + ').', '',
            '**Status gleich (bewertbare Regeln): ' + (abgleich.bewertbar ? pz(abgleich.gleichProzent) : 'nicht bewertbar – ' + abgleich.grund) + '**' +
            ' · über alle Minuten gleicher Version: ' + pz(abgleich.gleichProzentVergleichbar) +
            (abgleich.nurProtokoll ? ' · nur aus Protokollen gerechnet: ' + pz(abgleich.nurProtokoll.gleichProzentVergleichbar) : ''), '',
            'Mit Live-Eingängen bleiben als Ursache für Abweichungen der Zustand der Live-Maschine (Neustarts, Freigaben, Sperren von Hand) und Code-Änderungen ohne neue Regelversion. ' +
            'Die Spalte „nur Protokolle“ zeigt, was die 5-min-Werte der Räume (optimizer-v2-*.csv) allein ausmachen.', '',
            '| Regel | Version Replay | Versionen live (min) | vergleichbar | Status gleich | nur Protokolle | Vorschlag/Hinweis live | Vorschlag/Hinweis Replay | bewertbar |', '|---|---|---|---|---|---|---|---|---|');
        Object.keys(abgleich.regeln).forEach(id => {
            const g = abgleich.regeln[id], np = abgleich.nurProtokoll ? abgleich.nurProtokoll.regeln[id] : null;
            L.push('| ' + (names[id] || id) + ' | v' + g.replayVersion + ' | ' + Object.keys(g.liveVersionen).map(v => v + ' (' + g.liveVersionen[v] + ')').join(', ') + ' | ' + g.vergleichbar + ' von ' + g.minuten + ' | ' +
                pz(g.gleichProzent) + ' | ' + pz(np) + ' | ' + g.vorschlagLive + ' | ' + g.vorschlagReplay + ' | ' + (g.bewertbar ? 'ja' : 'nein: ' + g.grund) + ' |');
        });
    }
    const raeume = raumLuecken(tagInputs);
    L.push('', '### Raumfühler am Tag (Minuten ohne gültigen Wert)', '', '| Raum | Minuten | ungültig/zu alt | längste Lücke |', '|---|---|---|---|');
    Object.keys(raeume).forEach(id => { const x = raeume[id]; L.push('| ' + x.name + ' | ' + x.minuten + ' | ' + x.ungueltig + ' | ' + x.laengsteMin + ' min |'); });
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
        abgleichLive: abgleich, raeume: raeume};
    schreibe(tagS + '.md', L.join('\n') + '\n');
    schreibe(tagS + '.json', JSON.stringify(zus, null, 1) + '\n');
    console.log('Replay ' + tagS + ': ' + tagInputs.length + ' Minuten (Einschwingen ab ' + zus.einschwingenAb + '), ' + props.length + ' Vorschläge/Hinweise, ' + events.length + ' Ereignisse, ' +
        scores.length + ' Punkte-Einträge; Status gleich live ' + (abgleich.bewertbar ? abgleich.gleichProzent + ' %' : 'nicht bewertbar (' + abgleich.grund + ')') +
        (abgleich.nichtBewertbar.length ? ', nicht bewertbar: ' + abgleich.nichtBewertbar.join(', ') : '') + (abgleich.nurProtokoll && abgleich.nurProtokoll.gleichProzentVergleichbar !== null ? '; nur Protokolle ' + abgleich.nurProtokoll.gleichProzentVergleichbar + ' % (alle Minuten gleicher Version)' : '') + ' (' + abgleich.gemeinsam + ' gemeinsame Minuten)');
}

try { main(); } catch (e) { console.error('Fehler: ' + e.message); process.exit(1); }

// Pruefungen der Takt-/Mindestleistungs-Messung (engine_core: taktStep, taktKennzahlen, mindestLeistung, copTabelle) und Replay mit echten Minutenlogs.
// Usage: node tools/takt_sim.js [Datenordner mit quiet-2026-10.csv / optimizer-v2-2026-10.csv]
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const E = require('./engine_core.js');
const MIN = 60000, T0 = Date.UTC(2026, 9, 1, 0, 0);
let oks = 0, fails = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined && info !== '' ? '  -> ' + info : '')); if (cond) { oks++; } else { fails++; } }
function feed(seq) { let T = E.taktNew(); seq.forEach((x, i) => { T = E.taktStep(T, Object.assign({t: T0 + i * MIN, hpAge: 0}, x)); }); return T; }
const on = (n, o) => Array.from({length: n}, () => Object.assign({hz: 30, at: 5, pel: 600, pth: 3000, q: 0, hc: 0}, o || {}));
const off = n => Array.from({length: n}, () => ({hz: 0, at: 5}));
const nul = n => Array.from({length: n}, () => ({hz: null}));

// Entprellung
{ const T = feed([].concat(off(5), on(1), off(5), on(60), off(10)));
  check('Entprellung: eine einzelne Laufprobe ist kein Start und kein Lauf; danach ein echter Lauf (60 min) = 1 Start', T.starts.length === 1 && T.runs.length === 1 && T.runs[0][1] === 60, JSON.stringify(T.runs)); }
{ const T = feed([].concat(off(5), on(30), nul(20), on(30), off(5)));
  check('None != aus: 20 Minuten ohne Daten mitten im Lauf beenden den Lauf nicht (1 Lauf, 1 Start, 80 min)', T.starts.length === 1 && T.runs.length === 1 && T.runs[0][1] === 80, JSON.stringify(T.runs)); }
{ const T = feed([].concat(off(5), on(30), off(2), on(30), off(5)));
  check('Mindest-Aus-Zeit: Luecke 2 min (< 3 min) = derselbe Lauf, kein zweiter Start', T.starts.length === 1 && T.runs.length === 1 && T.runs[0][1] === 62, JSON.stringify(T.runs)); }
{ const T = feed([].concat(off(5), on(30), off(10), on(30), off(90), on(30), off(5)));
  const K = E.taktKennzahlen(T, T0 + 220 * MIN);
  check('Pausen-Typen: 10 min = Minutenpause, 90 min = Bedarfspause; 3 Starts, 3 Laeufe, 3 kurze (< 60 min)', T.pausen.map(p => p[2]).join() === 'minuten,bedarf' && K.starts24h === 3 && K.laeufe === 3 && K.kurz === 3 && K.kurzAnteil === 1 && K.minutenPausen === 1 && K.bedarfPausen === 1, JSON.stringify(K)); }
{ const T = feed([].concat(on(30), off(5)));
  check('Erster Lauf nach Neustart (Zustand vorher unbekannt) zaehlt nicht als Start, wird aber als Lauf gefuehrt', T.starts.length === 0 && T.runs.length === 1, JSON.stringify(T)); }
{ const T = feed([].concat(off(3), on(20, {hpAge: 9}), off(3)).map(x => x));
  check('Alte Daten (hpAge > 5) zaehlen weder als an noch als aus', T.starts.length === 0 && T.runs.length === 0, ''); }
// Mindestleistung und COP
{ const seq = [].concat(off(2)); [[-3, 2500], [1, 2000], [5, 2600], [9, 2400]].forEach(([at, p]) => { seq.push(...off(5), ...on(80, {at: at, pth: p}).map((x, i) => Object.assign({}, x, {pth: p + (i % 10) * 50}))); }); seq.push(...off(5));
  const ML = E.mindestLeistung(feed(seq));
  check('Mindestleistung: 10-%-Quantil je 2-K-Bin nur ab Laufminute 15 (65 Proben je Bin), monoton von kalt nach warm nicht fallend', ML.length === 4 && ML[0][2] === 65 && ML.map(b => b[0]).join() === '-4,0,4,8' && ML[1][1] < ML[0][1] && ML[1][3] === ML[0][3] && ML[3][3] === ML[2][3] && ML.every((b, i) => i === 0 || b[3] >= ML[i - 1][3]), JSON.stringify(ML)); }
{ const T = feed([].concat(off(2), on(90, {hc: 0, q: 0, at: 5, pel: 500, pth: 2800}), off(5), on(90, {hc: 1, q: 0, at: 5, pel: 600, pth: 3000}), off(5), on(90, {hc: 0, q: 2, at: 12, defrost: 1}), off(3)));
  const C = E.copTabelle(T);
  check('COP je Modus x Quiet x Band: Comfort Q0 3…7 = 5,6, Efficiency Q0 3…7 = 5,0 (je 75 stabile min); Abtau-Minuten zaehlen nicht', C.length === 2 && C[0].join() === 'Comfort,0,3…7,5.6,75' && C[1].join() === 'Efficiency,0,3…7,5,75', JSON.stringify(C)); }
// Engine-Integration: Datensatz und Karte
{ let S = null, last; const seq = [].concat(off(5), on(30), off(10), on(30), off(5));
  seq.forEach((x, i) => { last = E.step(S, Object.assign({t: T0 + i * MIN, hpAge: 0, vl: 30, rl: 27, soll: 30, dT: 3, pump: 1500}, x)); S = last.S; });
  const tk = last.rec.abl.takt;
  check('Engine: Datensatz abl.takt traegt Starts 24 h, Starts/h, Anteil kurzer Laeufe, Pausen-Typen', tk && tk.starts_24h === 2 && tk.kurz_anteil === 1 && tk.minutenpausen === 1 && tk.bedarfspausen === 0, JSON.stringify(tk));
  const V = require('./engine_view.js'), b = V.build({now: S.last, last: {t: S.last, res: last.res, prop: null, anl: {}}, S: S, V: {}, AP: {}, enabled: false});
  check('Anzeige: Zeile Takt (Starts, Laeufe, Pausen), Mindestleistung und COP je Modus/Quiet ohne Fehler', /^Starts 24 h 2 \(0,08\/h\) · Läufe 2, davon < 60 min 2/.test(b.score.takt.t) && b.score.takt.chip === 'ruhig' && b.score.takt.min === '4…6 °C 3,0 kW', b.score.takt.t + ' | ' + b.score.takt.chip + ' | ' + b.score.takt.min);
  const S2 = E.fixState(JSON.parse(JSON.stringify(Object.assign({}, S, {takt: undefined}))), S.last);
  check('Aelterer Zustand ohne takt: wird ergaenzt, kein Absturz', S2.takt && Array.isArray(S2.takt.runs), ''); }

// Replay mit echten Daten
const dir = process.argv[2];
if (dir) {
    const RP = require('./engine_replay.js'), inputs = RP.buildInputs(dir, '2026-10');
    let T = E.taktNew(); inputs.forEach(x => { T = E.taktStep(T, x); });
    const all = T.runs, K = E.taktKennzahlen(T, inputs[inputs.length - 1].t);
    console.log('\n--- Replay ' + dir + ': ' + inputs.length + ' Minuten');
    console.log('Laeufe (48 h Fenster) ' + all.length + ': ' + all.map(r => new Date(r[0]).toISOString().slice(5, 16) + ' ' + r[1] + ' min').join(' | '));
    console.log('Pausen: ' + T.pausen.map(p => p[1] + ' min ' + p[2]).join(' | '));
    console.log('Kennzahlen 24 h: ' + JSON.stringify(K));
    console.log('Mindestleistung (Bin, Q10 W th, n, monoton): ' + JSON.stringify(E.mindestLeistung(T)));
    console.log('COP je Modus x Quiet x Band (>= 60 min): ' + JSON.stringify(E.copTabelle(T)));
    check('Replay laeuft ohne Fehler und findet Laeufe', all.length > 0, '');
}
console.log('\nERGEBNIS takt_sim: ' + oks + ' OK, ' + fails + ' FAIL');
process.exit(fails ? 1 : 0);

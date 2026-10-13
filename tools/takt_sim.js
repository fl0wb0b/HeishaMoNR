// Pruefungen der Takt-/Mindestleistungs-Messung (engine_core: taktStep, taktKennzahlen, mindestLeistung, copTabelle) und Replay mit echten Minutenlogs.
// Usage: node tools/takt_sim.js [Datenordner mit quiet-2026-10.csv / optimizer-v2-2026-10.csv]
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs'), path = require('path');
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
  check('Mindestleistung: 10-%-Quantil je 2-K-Band nur ab Laufminute 15 (65 Proben je Band); monoton als laufendes Minimum von warm nach kalt (stooklijn): roh 2550/2050/2650/2450 -> 2050/2050/2450/2450', ML.length === 4 && ML[0][2] === 65 && ML.map(b => b[0]).join() === '-4,0,4,8' && ML.map(b => b[1]).join() === '2550,2050,2650,2450' && ML.map(b => b[3]).join() === '2050,2050,2450,2450', JSON.stringify(ML)); }
{ const T = feed([].concat(off(2), on(90, {hc: 0, q: 0, at: 5, pel: 500, pth: 2800}), off(5), on(90, {hc: 1, q: 0, at: 5, pel: 600, pth: 3000}), off(5), on(90, {hc: 0, q: 2, at: 12, defrost: 1}), off(3)));
  const C = E.copTabelle(T), C2 = E.copTabelle(T, E.mergeCfg({takt: {copMinMin: 80}}).takt);
  check('COP je Modus x Quiet x Band: Comfort Q0 3…7 = 5,6, Efficiency Q0 3…7 = 5,0 (je 75 stabile min); Abtau-Minuten zaehlen nicht; Mindestdaten 60 min (Nutzerentscheidung 13.10.) einstellbar (80 min -> leer)', C.length === 2 && C[0].join() === 'Comfort,0,3…7,5.6,75' && C[1].join() === 'Efficiency,0,3…7,5,75' && C2.length === 0 && E.taktCfg(null).copMinMin === 60 && /Nutzerentscheidung 13\.10\.2026, vorläufig/.test(E.TAKT_SCHWELLEN.find(x => x.key === 'copMinMin').herkunft), JSON.stringify(C)); }
{ const D = 24 * 60 * MIN, seq = []; let T = E.taktNew();
  for (let day = 0; day < 40; day++) { for (let i = 0; i < 100; i++) { T = E.taktStep(T, {t: T0 + day * D + i * MIN, hpAge: 0, hz: i < 95 ? 30 : 0, at: 5, pel: 500, pth: day < 10 ? 1000 : 3000, q: 0, hc: 1}); } }
  const C = E.copTabelle(T, null, T0 + 39 * D), dk = Object.keys(T.copT);
  check('COP-Fenster: nur die letzten 30 Tage (aeltere Tage fallen aus dem Speicher und der Summe; die ersten 10 Tage mit COP 2 sind weg -> COP 6)', dk.length === 30 && C.length === 1 && C[0][3] === 6 && C[0][4] === 30 * 80, JSON.stringify(C) + ' Tage ' + dk.length); }
// Engine-Integration: Datensatz und Karte
{ let S = null, last; const seq = [].concat(off(5), on(30), off(10), on(30), off(5)), tks = [];
  seq.forEach((x, i) => { last = E.step(S, Object.assign({t: T0 + i * MIN, hpAge: 0, vl: 30, rl: 27, soll: 30, dT: 3, pump: 1500}, x)); S = last.S; if (last.rec.abl.tk) { tks.push([i, last.rec.abl.tk]); } });
  const tk = tks[tks.length - 1][1];
  check('Engine: Datensatz abl.tk kompakt [Starts 24 h, Anteil kurzer Laeufe, Minutenpausen, Bedarfspausen], nur bei Aenderung und zur vollen Stunde (hier ' + tks.length + ' von ' + seq.length + ' Minuten)', JSON.stringify(tk) === '[2,1,1,0]' && tks.length <= 8 && tks.length >= 3 && !('takt' in last.rec.abl), JSON.stringify(tks));
  const V = require('./engine_view.js'), b = V.build({now: S.last, last: {t: S.last, res: last.res, prop: null, anl: {}}, S: S, V: {}, AP: {}, enabled: false});
  check('Anzeige: Zeile Takt (Starts, Laeufe, Pausen), Mindestleistung und COP je Modus/Quiet ohne Fehler', /^Starts 24 h 2 \(0,08\/h\) · Läufe 2, davon < 60 min 2/.test(b.score.takt.t) && b.score.takt.chip === 'ruhig' && b.score.takt.min === '4…6 °C 3,0 kW', b.score.takt.t + ' | ' + b.score.takt.chip + ' | ' + b.score.takt.min);
  const S2 = E.fixState(JSON.parse(JSON.stringify(Object.assign({}, S, {takt: undefined}))), S.last);
  check('Aelterer Zustand ohne takt: wird ergaenzt, kein Absturz', S2.takt && Array.isArray(S2.takt.runs), ''); }

// Eingangs-Hygiene (B): unplausible Werte gelten als fehlend
{ const T = feed([].concat(off(3), on(30, {hz: 255}), off(3)));
  check('Plausibilitaet: Frequenz 255 Hz (Sentinel) gilt als fehlend -> kein Start, kein Lauf', T.starts.length === 0 && T.runs.length === 0, JSON.stringify(T.runs)); }
{ const T = feed([].concat(off(3), on(60, {at: -127}), off(3)));
  check('Plausibilitaet: Aussentemperatur −127 °C -> Lauf zaehlt, aber keine Mindestleistungs-/COP-Minute', T.runs.length === 1 && Object.keys(T.bins).length === 0 && Object.keys(T.copT).length === 0, JSON.stringify(T.bins)); }
{ const o = E.step(null, {t: T0, hpAge: 0, hz: 30, vl: 30, rl: 27, soll: 30, dT: 3, at: -127, pel: 9000, pth: 2000, pump: 1500, q: 0, hc: 1}, null);
  check('Plausibilitaet in der Maschine: at −127 und pel 9000 gelten als fehlend (d.at/d.pel null), Datensatz nennt sie (abl.unpl), Rohwerte bleiben im Schnappschuss', o.d.at === null && o.d.pel === null && JSON.stringify(o.rec.abl.unpl) === '["at","pel"]' && o.rec.in.at === -127, JSON.stringify(o.rec.abl.unpl)); }
// E) Wirkzeit (Idee/Teilportierung ClimateOptimizer lag.py, MIT) und Heizkurven-Bias (Teilportierung tvofi curve_learning.py, MIT)
{ const L = {o: [], r: [], z: []}; let room = 21, soll = 30, ziel = 21;
  const ev = [[10, 2], [40, -2], [70, 2], [100, -2], [130, 2], [160, -2]];                     // Sollspruenge alle 30 Proben (7,5 h)
  let base = 21, t0 = -999, dir = 0;
  for (let i = 0; i < 200; i++) { const e = ev.find(x => x[0] === i); if (e) { soll += e[1]; base = room; t0 = i; dir = Math.sign(e[1]); }
    if (t0 >= 0) { const t = (i - t0) * 15; room = base + dir * 0.5 * (1 - Math.exp(-t / 90)); }
    L.o.push(soll); L.r.push(Math.round(room * 1000) / 1000); L.z.push(ziel); }
  const up = E.lagMessen(L, true), dn = E.lagMessen(L, false);
  check('Wirkzeit (synthetisch, Raum folgt dem Sollsprung mit tau 90 min): Haelfte der Reaktion nach 75 min (erste 15-min-Probe nach 61 min), je 3 Ereignisse fuer Anstieg und Abfall', up.min === 75 && up.n === 3 && dn.min === 75 && dn.n === 3, JSON.stringify([up, dn]));
  const L2 = JSON.parse(JSON.stringify(L)); for (let i = 40; i < 70; i++) { L2.r[i] = L2.r[39] + 0.3 * ((i - 40) / 30); }     // Raum steigt trotz Sollsprung nach unten
  const dn2 = E.lagMessen(L2, false);
  check('Wirkzeit: Raum in falscher Richtung -> Ereignis verworfen (Abfall nur noch 2 von 3)', dn2.min === null && dn2.n === 2, JSON.stringify(dn2));
  const L3 = JSON.parse(JSON.stringify(L)); for (let i = 135; i < 200; i++) { L3.z[i] = 21 + Math.min(0.5, 0.1 * (i - 134)); }     // Band waechst in Schritten < 0,3 K (kein eigenes Ereignis), zusammen 0,5 K
  check('Wirkzeit: Komfortband im Fenster geaendert -> Ereignis nicht lesbar (Anstieg 2 von 3)', E.lagMessen(L3, true).n === 2, JSON.stringify(E.lagMessen(L3, true))); }
{ const D = 24 * 60 * MIN; let K = {bias: 0, tage: 0, resets: 0, lastStep: 0};
  const seq = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.2, 0.5, 0.5, 0.5, -0.1], out = [];
  seq.forEach((l, i) => { K = E.kbTag(K, l, T0 + i * D); out.push(K.bias); });
  check('Heizkurven-Bias (tvofi): 3 Tage mit >= 0,3 K Luft -> −0,2 K; nach weiteren 3 Tagen −0,4 K; 0,2 K Luft setzt den Zaehler zurueck; Komfortmiss (−0,1 K) -> sofort 0 und 1 Ruecksetzung', out.join(' ') === '0 0 -0.2 -0.2 -0.2 -0.4 -0.4 -0.4 -0.4 -0.6 0' && K.resets === 1, out.join(' '));
  let K2 = {bias: 0, tage: 0, resets: 0, lastStep: 0}, K3 = {bias: 0, tage: 0, resets: 0, lastStep: 0};
  for (let i = 0; i < 30; i++) { K2 = E.kbTag(K2, 1.0, T0 + i * D); } for (let i = 0; i < 100; i++) { K3 = E.kbTag(K3, 1.0, T0 + i * D); }
  check('Heizkurven-Bias: hoechstens 0,5 K je Woche (30 Tage Luft -> 10 Schritte = −2,0 K, Grenze 2,14 K) und nie unter −4 K (100 Tage -> −4 K)', K2.bias === -2 && K3.bias === -4, K2.bias + ' / ' + K3.bias); }
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
    { let S = null; const cfgE = E.defaults(); inputs.forEach(x => { S = E.step(S, x, cfgE).S; });
      console.log('Wirkzeit (Replay): ' + JSON.stringify(S.lag && S.lag.res) + ' Puffer ' + (S.lag ? S.lag.o.length : 0) + ' · Heizkurven-Bias: ' + JSON.stringify(S.kb));
      check('Replay: Wirkzeit und Heizkurven-Bias laufen ohne Fehler ueber die echten Daten', !!S.kb && Array.isArray(S.lag.o), ''); }
    // Nachladen wie in der Huelle (stueckweise, nur ganze Zeilen; Vormonat fehlt) muss dasselbe ergeben wie das Replay ueber buildInputs
    const nachladenSim = (files, chunk) => {
        const T2 = E.taktNew(); T2.nl = E.nlNeu(files, 0); const buf = Buffer.alloc(chunk); let reads = 0;
        while (T2.nl.laeuft) {
            const nl = T2.nl; if (nl.i >= nl.dateien.length) { E.nlEnde(T2, null, 1); break; }
            let n = 0, fd = null; try { fd = fs.openSync(nl.dateien[nl.i], 'r'); n = fs.readSync(fd, buf, 0, chunk, nl.pos); } catch (e) { n = 0; } if (fd !== null) { fs.closeSync(fd); } reads++;
            const cut = n > 0 ? buf.lastIndexOf(10, n - 1) : -1;
            if (cut < 0) { if (n >= chunk) { nl.pos += n; } else { nl.i++; nl.pos = 0; } continue; }
            E.nlZeilen(T2, buf.toString('utf8', 0, cut + 1), null); nl.pos += cut + 1;
        }
        T2.reads = reads; return T2;
    };
    const same = (A, B) => ['starts', 'runs', 'pausen', 'bins', 'copT', 'on', 't0', 'tStop'].every(k => JSON.stringify(A[k]) === JSON.stringify(B[k]));
    const files2 = [path.join(dir, 'quiet-2026-09.csv'), path.join(dir, 'quiet-2026-10.csv')];
    const Ta = nachladenSim(files2, 65536), Tb = nachladenSim(files2, 1 << 20), Tc = nachladenSim(files2, 4096);
    check('Nachladen (Stuecke 4 kB, 64 kB, 1 MB; Vormonat fehlt) = Replay ueber buildInputs: Starts, Laeufe, Pausen, Baender und COP identisch; Zeilen ' + Ta.nl.zeilen + ', Minuten ' + Ta.nl.minuten, same(Ta, T) && same(Tb, T) && same(Tc, T) && Ta.nl.minuten === inputs.length && Ta.reads > Tb.reads,
          ['starts', 'runs', 'pausen', 'bins', 'copT'].filter(k => JSON.stringify(Ta[k]) !== JSON.stringify(T[k])).join(',') + ' Minuten ' + Ta.nl.minuten + '/' + inputs.length);
    const ML = E.mindestLeistung(Ta);
    console.log('Mindestleistung nach Nachladen (Band, Q10, n, monoton): ' + JSON.stringify(ML));
    check('Befund Echtdaten: Laeufe im 48-h-Fenster 113–970 min, Pausen 57–142 min (Bedarfspausen), Mindestleistung (monoton) 1,7–1,8 kW in allen Baendern', Ta.runs.length && Math.min(...Ta.runs.map(r => r[1])) === 113 && Math.max(...Ta.runs.map(r => r[1])) === 970 && Math.min(...Ta.pausen.map(p => p[1])) === 57 && Math.max(...Ta.pausen.map(p => p[1])) === 142 && Ta.pausen.every(p => p[2] === 'bedarf') && ML.every(b => b[3] >= 1650 && b[3] <= 1850), JSON.stringify(ML.map(b => b[3])));
}
// Nachladen: Kopfzeilen-Versionen, Luecken, rueckwaerts laufende Zeit, unvollstaendige Zeilen
{ const z = (m, hz, extra) => { const d = new Date(2026, 9, 1, 0, 0, 0).getTime() + m * MIN + 12000, x = new Date(d), p2 = v => (v < 10 ? '0' : '') + v; return x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate()) + ' ' + p2(x.getHours()) + ':' + p2(x.getMinutes()) + ':' + p2(x.getSeconds()) + ',' + hz + ',5,600,3000,0' + (extra === undefined ? '' : ',' + extra); };
  let txt = 'zeit,verdichter_hz,aussen,leistung_el_w,leistung_th_heisha_w,quiet_aktuell\n';
  for (let m = 0; m < 10; m++) { txt += z(m, 0) + '\n'; }
  for (let m = 10; m < 50; m++) { txt += z(m, 30) + '\n'; }
  txt += 'zeit,verdichter_hz,aussen,leistung_el_w,leistung_th_heisha_w,quiet_aktuell,heizregelung\n';
  for (let m = 50; m < 80; m++) { txt += z(m, 30, 1) + '\n'; }
  txt += z(60, 30, 1) + '\n' + 'kaputt,1\n';                                                 // Zeit rueckwaerts und kaputte Zeile: entfallen
  for (let m = 200; m < 260; m++) { txt += z(m, m < 230 ? 0 : 30, 1) + '\n'; }               // Luecke 80 -> 200 min (keine Daten): Lauf endet nicht als Stopp
  const T = E.taktNew(); T.nl = E.nlNeu(['x'], 0); E.nlZeilen(T, txt, null); E.nlEnde(T, null, 5);
  check('Nachladen: zwei Kopfzeilen-Versionen (heizregelung erst ab der zweiten), kaputte und rueckwaerts laufende Zeilen entfallen, Datenluecke ist kein Stopp; danach nicht mehr "laeuft"', T.nl.laeuft === false && T.nl.zeilen === 140 && T.starts.length === 2 && T.runs.length === 1 && T.on === true && Object.keys(T.copT).length >= 1 && JSON.stringify(Object.keys(T.copT[Object.keys(T.copT)[0]])).indexOf('Efficiency|0|3…7') >= 0 && JSON.stringify(Object.keys(T.copT[Object.keys(T.copT)[0]])).indexOf('?|0|3…7') >= 0, JSON.stringify({n: T.nl, starts: T.starts.length, runs: T.runs, cop: T.copT})); }
console.log('\nERGEBNIS takt_sim: ' + oks + ' OK, ' + fails + ' FAIL');
process.exit(fails ? 1 : 0);

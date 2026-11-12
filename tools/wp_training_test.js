// Tests für training-v2 des Anlagen-Zwillings (tools/wp_training.js): Gate Champion gegen Herausforderer, Glättung, Bindung an die Vorwerte,
// Güte je Außentemperatur-Band und Abdeckung. Synthetische Sätze und Daten; mit Datenordner zusätzlich auf echten Protokollen.
// Usage: node tools/wp_training_test.js [Datenordner, z. B. replay_data_1710]
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const T = require('./wp_training.js');
const Z = require('./wp_zwilling.js');
let oks = 0, fails = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined && info !== '' ? '  -> ' + info : '')); if (cond) { oks++; } else { fails++; } }
const nah = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);
const datenDir = process.argv[2] || null;

console.log('--- Glättung (Anteil der neuen Werte je Nacht)');
{
    check('Zahl: 240 → roh 480 mit Anteil 1/3 ergibt 320 (hausAtTauMin)', T.glaette(240, 480, 1 / 3, 'hausAtTauMin') === 320);
    check('Zahl: Anteil 1 ersetzt, Anteil 0 behält', T.glaette(0.23, 0.16, 1, 'gain') === 0.16 && T.glaette(0.23, 0.16, 0, 'gain') === 0.23);
    check('Liste elementweise: flowEff [30, 21,5, 35, 90] → roh [33, 21,5, 35, 96] = [31, 21,5, 35, 92]', JSON.stringify(T.glaette([30, 21.5, 35, 90], [33, 21.5, 35, 96], 1 / 3, 'flowEff')) === JSON.stringify([31, 21.5, 35, 92]));
    const r = T.glaette({ki_oben: [3, 0.3, 0, 0, 30], neu: [1, 2]}, {ki_oben: [0, 0, 0.3, 0, 120], neu: [1, 2], dazu: [5]}, 1 / 3, 'raeume');
    check('Objekt (raeume) je Raum und Element; Raum ohne Vorwert wird roh übernommen', JSON.stringify(r.ki_oben) === JSON.stringify([2, 0.2, 0.1, 0, 60]) && JSON.stringify(r.dazu) === JSON.stringify([5]), JSON.stringify(r));
    check('Schalter-Wert 99 („aus“) gleitet über 5 K: 99 → 0,5 ergibt 3,5; 0,5 → 99 ergibt 2,0; 99 → 99 bleibt 99', T.glaette(99, 0.5, 1 / 3, 'startHystK') === 3.5 && T.glaette(0.5, 99, 1 / 3, 'comfortWiederK') === 2 && T.glaette(99, 99, 1 / 3, 'startHystK') === 99);
    const alt = Z.standard(), neu = Z.standard();
    neu.ch = 6; neu.abtauHz = 61; alt.ua = 0.9; neu.ua = 0.9;
    const S = T.glaetteSatz(alt, neu, 1 / 3);
    check('Satz: nur gefittete Parameter werden geglättet (ch), feste (Forum/Handbuch/Annahme, z. B. abtauHz; abtauDauerMin wird seit 08.11. gelernt) kommen aus PARAM bzw. roh', S.ch === rd6(alt.ch + (6 - alt.ch) / 3) && S.abtauHz === 61, 'ch ' + S.ch);
    check('Satz: physikalische Grenzen wie in den Fits (ua ≤ 0,4 kW/K)', S.ua === 0.4, 'ua ' + S.ua);
    let v = 0; for (let n = 0; n < 3; n++) { v = T.glaette(v, 1, 1 / 3, 'x'); }
    check('drei Nächte mit gleichem roh gelerntem Wert: 1 − (2/3)³ = 70,4 % des Sprungs übernommen', nah(v, 1 - Math.pow(2 / 3, 3), 1e-5), String(v));
}
function rd6(x) { return Math.round(x * 1e6) / 1e6; }

console.log('--- Bindung an die Vorwerte (Regularisierung, Dünn-Daten-Phase)');
{
    const B = {vor: Object.assign(Z.standard(), {ua: 0.2}), lambda: 1};
    check('Strafe: 25 % Änderung des Vorwerts kostet 1 (Skala 25 %)', nah(T.strafe(B, {ua: 0.25}), 1), String(T.strafe(B, {ua: 0.25})));
    // y = 3 + 2·x1 + 0·x2, x2 mit winziger Streuung (schwach bestimmt), x1 gut bestimmt
    const X = [], y = [];
    for (let i = 0; i < 400; i++) { const x1 = (i % 40) / 4, x2 = 0.001 * Math.sin(i), e = 0.3 * Math.sin(i * 7.3); X.push([1, x1, x2]); y.push(3 + 2 * x1 + e); }
    const f0 = T.lsq(X, y), f1 = T.lsqBind(X, y, [3, 2, 0], [1, 1, 1], 0), x0 = [4, 1.5, 5];
    check('λ = 0: identisch mit den ungebundenen kleinsten Quadraten', f0.x.every((v, j) => nah(v, f1.x[j], 1e-9)));
    const fb = T.lsqBind(X, y, x0, x0.map(v => 0.25 * Math.abs(v)), 1);
    check('λ = 1: die gut bestimmten Koeffizienten folgen den Daten (Steigung 2 ± 3 %, Achsenabschnitt von Vorwert 4 mehr als halb auf 3), der schwach bestimmte bleibt am Vorwert (x2 = 5 ± 20 %, ungebunden 18)', nah(fb.x[0], 3, 0.5) && nah(fb.x[1], 2, 0.06) && nah(fb.x[2], 5, 1), fb.x.map(v => v.toFixed(3)).join(', ') + ' (ungebunden ' + f0.x.map(v => v.toFixed(2)).join(', ') + ')');
    const fg = T.lsqBind(X, y, x0, x0.map(v => 0.25 * Math.abs(v)), 1e6);
    check('sehr großes λ: alle Koeffizienten auf den Vorwerten', fg.x.every((v, j) => nah(v, x0[j], 0.01)), fg.x.map(v => v.toFixed(3)).join(', '));
    // Suchverfahren: flache Kostenfunktion → bleibt auf dem Vorwert; deutliche Verbesserung → bewegt sich
    const Bt = {vor: Object.assign(Z.standard(), {hausAtTauMin: 240, ch: 3}), lambda: 1};
    const flach = T.gebunden(Bt, ['hausAtTauMin'], p => 0.60 - 0.0001 * p.hausAtTauMin / 480);
    const kf = T.koordinatensuche(flach.start, {hausAtTauMin: () => [1, 60, 120, 240, 480, 720]}, flach.kosten, 4);
    const steil = T.gebunden(Bt, ['ch'], p => 0.2 + Math.abs(p.ch - 4));
    const ks = T.koordinatensuche(steil.start, {ch: v => [v * 0.85, v * 1.18, v * 1.4]}, steil.kosten, 6);
    check('Koordinatensuche gebunden: fast flache Kosten (0,60 → 0,5999 K) halten hausAtTauMin auf 240 (ungebunden: 720)', kf.p.hausAtTauMin === 240);
    check('Koordinatensuche gebunden: deutliche Verbesserung (Fehler 1,2 → 0,2) verschiebt ch Richtung 4', ks.p.ch > 3.5, 'ch ' + ks.p.ch.toFixed(2));
    check('ohne Bindung (B = null) bleibt die Kostenfunktion unverändert', T.gebunden(null, ['ch'], p => 7).kosten({ch: 1}) === 7 && T.gebunden(null, ['ch'], p => 7).start === null);
}

console.log('--- Gate: Champion gegen Herausforderer (synthetische Sätze)');
{
    const g = (strom, wk, pause) => ({teil: {pelRmseW: strom, wasserkreisRmseK: wk}, zyklenHausSimuliert: {pause: {medianAbsMin: pause}}});
    const e = (k, c, o) => T.entscheide(k, c, o);
    check('erster Lauf (kein bisheriger Satz): übernommen', e(g(20, 1, 7), null).ergebnis === 'übernommen');
    check('gleich gut: übernommen', e(g(18.6, 1.06, 7.5), g(18.6, 1.06, 7.5)).ergebnis === 'übernommen');
    check('besser: übernommen (Pause 18 → 6 min)', e(g(18, 1.0, 6), g(18.7, 1.06, 18)).ergebnis === 'übernommen');
    const s1 = e(g(20.6, 1.06, 7.5), g(18.6, 1.06, 7.5));
    check('Strom 18,6 → 20,6 W (+10,8 %): abgelehnt, Grund nennt Strom', s1.ergebnis === 'abgelehnt' && /Strom/.test(s1.grund) && s1.kennzahlen.filter(k => k.verletzt).length === 1, s1.grund);
    check('Strom 18,6 → 20,4 W (+9,7 %): übernommen', e(g(20.4, 1.06, 7.5), g(18.6, 1.06, 7.5)).ergebnis === 'übernommen');
    const s2 = e(g(18.6, 1.52, 7.5), g(18.6, 1.45, 7.5));
    check('Wasserkreis 1,45 → 1,52 K (+4,8 %, aber über der Ampelgrenze 1,5 K, bisher darunter): abgelehnt', s2.ergebnis === 'abgelehnt' && /Ampelgrenze/.test(s2.grund), s2.grund);
    check('Wasserkreis 1,60 → 1,62 K (beide über der Grenze, +1,3 %): übernommen (nicht schlechter als bisher)', e(g(18.6, 1.62, 7.5), g(18.6, 1.6, 7.5)).ergebnis === 'übernommen');
    check('Pause 6 → 7 min: innerhalb der Mindesttoleranz 1 min, übernommen; 6 → 7,5 min: abgelehnt', e(g(18, 1, 7), g(18, 1, 6)).ergebnis === 'übernommen' && e(g(18, 1, 7.5), g(18, 1, 6)).ergebnis === 'abgelehnt');
    const s3 = e(g(30, 1.4, 12), g(18, 1, 6));
    check('mehrere Kennzahlen schlechter: alle im Grund genannt', s3.ergebnis === 'abgelehnt' && s3.kennzahlen.filter(k => k.verletzt).length === 3, s3.grund);
    check('fehlende Kennzahl (keine Pausen im Test): nicht bewertbar, entscheidet nicht', e(g(18, 1, null), g(18, 1, 6)).ergebnis === 'übernommen' && /nicht bewertbar/.test(e(g(18, 1, null), g(18, 1, 6)).kennzahlen[2].warum));
    check('Schwelle konfigurierbar (rel 0,5: +40 % Strom übernommen)', e(g(26, 1, 6), g(18.6, 1, 6), {rel: 0.5}).ergebnis === 'übernommen');
    check('Grenzen des Gates = Ampel-Grenzen in ot.py (40 W, 1,5 K, 30 min)', T.GATE.kennzahlen.filter(k => k.ampel !== false).map(k => k.grenze).join(',') === '40,1.5,30');
}

console.log('--- Zwilling V5 (Frost-Nachmessung): Startwerte, Abtaulinie, ungeglättet ab 20 Abtauungen, Heizstab wie Anlage');
{
    const P = Z.standard();
    check('Startwerte: Abtaulinie obere Grenze −6, abtauDauerMin 9, nachAbtauEffMin 39; Heizstab Ein −4 K / 30 min / Aus −1 K / 2,9 kW',
          P.abtauLinie[3] === -6 && P.abtauDauerMin === 9 && P.nachAbtauEffMin === 39 && P.hsStartK === -4 && P.hsDelayMin === 30 && P.hsStopK === -1 && P.hsKW === 2.9, JSON.stringify([P.abtauLinie, P.abtauDauerMin, P.nachAbtauEffMin, P.hsStartK, P.hsDelayMin, P.hsStopK, P.hsKW]));
    const PL = Object.assign({}, P, {abtauLinie: [0.9, -8.1, -22.5, -6]}), ok = (x, y) => Math.abs(x - y) < 1e-9;
    check('Abtaulinie mit b −8,1 (Messung): WP-AT 3 °C → −6 (begrenzt, vorher −5), 0 °C → −8,1, −1 °C → −9,0 (gemessen −8 / −9)', ok(Z.abtauLinieAt(PL, 3), -6) && ok(Z.abtauLinieAt(PL, 0), -8.1) && ok(Z.abtauLinieAt(PL, -1), -9), [3, 0, -1].map(a => Z.abtauLinieAt(PL, a)).join(' / '));
    const w = {abtauLinie: [0.9, -6.67, -22.5, -5]}; T.linieFest(w);
    check('aktiver Satz mit oberer Grenze −5: nur b bleibt gelernt, Steigung/Grenzen aus den Vorgaben', JSON.stringify(w.abtauLinie) === '[0.9,-6.67,-22.5,-6]', JSON.stringify(w.abtauLinie));
    const vor = {abtauLinie: [0.9, -6.67, -22.5, -6], nachAbtauEffMin: 26, abtauDauerMin: 8.33, abtauPelW: 951}, roh = {abtauLinie: [0.9, -8.1, -22.5, -6], nachAbtauEffMin: 38, abtauDauerMin: 9, abtauPelW: 864};
    const geliefert = {abtauLinie: true, nachAbtauEffMin: true, abtauDauerMin: true};
    const gl = T.glaetteSatz(vor, roh, 1 / 3), w20 = T.glaetteSatz(vor, roh, 1 / 3), w19 = T.glaetteSatz(vor, roh, 1 / 3);
    const d20 = T.abtauDirekt(w20, roh, {fit: {abtau: {n: 29}}, geliefert: geliefert}), d19 = T.abtauDirekt(w19, roh, {fit: {abtau: {n: 19}}, geliefert: geliefert});
    check('29 eigene Abtauungen: Abtauwerte ungeglättet (b −8,1, Halt 38 min, Dauer 9), nicht gelieferte (abtauPelW) bleiben geglättet; 19: 1/3-Glättung (b −7,15)',
          d20 && w20.abtauLinie[1] === -8.1 && w20.nachAbtauEffMin === 38 && w20.abtauDauerMin === 9 && w20.abtauPelW === gl.abtauPelW && !d19 && Math.abs(w19.abtauLinie[1] - (-7.146667)) < 1e-3 && w19.nachAbtauEffMin === 30,
          JSON.stringify({w20: w20, w19: w19}));
}

console.log('--- Gate: Freilauf-Abtauungen je Tag in Stück, erst ab 8 gemessenen (V6, Frost-Nachmessung 5a)');
{
    // fl: [[Zwilling, Messung], ...] je Testtag; Freilauf-Strom gleich (0 %), damit nur das Abtau-Kriterium zählt
    const g = (fl, el) => ({teil: {pelRmseW: 20, wasserkreisRmseK: 1}, zyklenHausSimuliert: {pause: {medianAbsMin: 5, n: 5}},
        freilauf: fl.map(([z, m], i) => ({tag: '2026-11-0' + (i + 1), abtauZwilling: z, abtauMessung: m})),
        freilaufSumme: {kwhElZwilling: el === undefined ? 10 : el, kwhElMessung: 10, abtauZwilling: fl.reduce((s, x) => s + x[0], 0), abtauMessung: fl.reduce((s, x) => s + x[1], 0)}});
    const ab = e => e.kennzahlen.find(k => k.id === 'freilaufAbtau');
    const k12 = T.entscheide(g([[2, 0], [2, 2], [2, 1]]), g([[1, 0], [1, 2], [2, 1]]));
    check('Kandidat 12.11. (je Tag 2/1/0 · 2/1/2 · 2/2/1, 3 gemessen): nicht bewertbar, übernommen (vorher: abgelehnt, „0,33 → 1,00“)',
          k12.ergebnis === 'übernommen' && /nicht bewertbar \(n = 3 \/ 3, weniger als 8\)/.test(ab(k12).warum), ab(k12).warum);
    const k09 = T.entscheide(g([[6, 7], [3, 3], [0, 0]]), g([[15, 7], [6, 3], [0, 0]]));
    check('Fall 09.11. (10 gemessen, Kandidat 1 Stück daneben, bisher 11): übernommen wie bisher', k09.ergebnis === 'übernommen' && ab(k09).kandidat === 1 && ab(k09).bisher === 11, JSON.stringify(ab(k09)));
    const um = T.entscheide(g([[15, 7], [6, 3], [0, 0]]), g([[6, 7], [3, 3], [0, 0]]));
    check('umgekehrt (Kandidat 11 Stück daneben, bisher 1, 10 gemessen): abgelehnt, Grund in Stück mit Toleranz 2,5', um.ergebnis === 'abgelehnt' && /schlechter um 10 Stück \(1 → 11 Stück, Toleranz 2,5\)/.test(um.grund), um.grund);
    const tol = T.entscheide(g([[5, 4], [5, 4], [3, 4]]), g([[4, 4], [4, 4], [4, 4]]));
    check('12 gemessen: Kandidat 3 Stück je Tag daneben, bisher 0 → Toleranz max(2; 25 % = 3): übernommen; 4 Stück: abgelehnt',
          tol.ergebnis === 'übernommen' && ab(tol).tol === 3 && T.entscheide(g([[6, 4], [5, 4], [3, 4]]), g([[4, 4], [4, 4], [4, 4]])).ergebnis === 'abgelehnt', JSON.stringify(ab(tol)));
    const aus = T.entscheide(g([[6, 4], [2, 4], [4, 4]]), g([[4, 4], [4, 4], [4, 4]]));
    check('kein Ausgleich zwischen Tagen: +2 und −2 ergeben 4 Stück Fehler (Summe wäre 0), 12 gemessen: abgelehnt', aus.ergebnis === 'abgelehnt' && ab(aus).kandidat === 4, JSON.stringify(ab(aus)));
    const null0 = T.entscheide(g([[4, 4], [4, 4], [4, 4]], 12), g([[4, 4], [4, 4], [4, 4]], 10));
    const fs = null0.kennzahlen.find(k => k.id === 'freilaufStrom');
    check('Prozentanzeige bei bisher = 0: „bisher 0 → 0,20“ statt Division durch 1e-9', fs.verletzt && fs.warum === 'schlechter (bisher 0 → 0,20)' && !/33333/.test(null0.grund), fs.warum);
    check('Gate-Kriterium im Ergebnis: Mindestzahl 8 Abtauungen, Toleranz/Grenze als Zahl aus der Messung', k09.kriterium.abtauMin === 8 && k09.kriterium.tol.freilaufAbtau === 2.5 && k09.kriterium.grenzen.freilaufAbtau === 3, JSON.stringify(k09.kriterium));
}

console.log('--- Außentemperatur-Bänder und Abdeckung (synthetische Daten)');
{
    check('Bandgrenzen: −0,1 → < 0; 0 → 0…4; 3,9 → 0…4; 4 → 4…8; 12 → ≥ 12; ohne AT → keins', T.bandOf(-0.1) === 0 && T.bandOf(0) === 1 && T.bandOf(3.9) === 1 && T.bandOf(4) === 2 && T.bandOf(12) === 4 && T.bandOf(null) === -1);
    const baue = (tage, atVon) => {                                                 // je Tag 1440 Minuten, AT nach Tag, 600 Laufminuten
        const M = [];
        for (let d = 0; d < tage; d++) { const tag = '2026-11-' + String(d + 1).padStart(2, '0'); for (let i = 0; i < 1440; i++) { M.push({tag: tag, at: atVon(d, i), lauf: i < 600}); } }
        return {M: M};
    };
    const A1 = T.abdeckung(baue(10, d => 2 + d));                                  // 2…11 °C, 10 Tage
    check('10 Tage, AT 2…11 °C: Dünn-Daten-Phase (unter 21 Tagen)', A1.duenn && /10 Tage/.test(A1.grund), A1.grund);
    check('leeres Band < 0 °C: „keine Daten, Zwilling extrapoliert“', A1.baender[0].status === T.KEINE_DATEN && A1.baender[0].minuten === 0);
    check('Hinweis „Zwilling hat unter 0 °C keine Daten“', A1.extrapoliertUnterC === 0 && /^Zwilling hat unter 0 °C keine Daten/.test(A1.hinweis), A1.hinweis);
    const A2 = T.abdeckung(baue(21, d => 9 + (d % 2) * 4));                         // 21 Tage, nur 8…12 und ≥ 12
    check('21 Tage, aber nur 2 Bänder mit ≥ 300 Laufminuten: Dünn-Daten-Phase', A2.duenn && A2.baenderAusreichend === 2 && /Bänder/.test(A2.grund), A2.grund);
    check('… Hinweis nennt die Grenze 8 °C', A2.extrapoliertUnterC === 8 && /unter 8 °C keine Daten/.test(A2.hinweis), A2.hinweis);
    const A3 = T.abdeckung(baue(21, d => [1, 5, 9][d % 3]));
    check('21 Tage, 3 Bänder belegt: keine Dünn-Daten-Phase', !A3.duenn && A3.baenderAusreichend === 3, A3.grund);
    const A4 = T.abdeckung(baue(21, (d, i) => d === 0 && i < 100 ? 2 : [5, 9, 13][d % 3]));
    check('Band 0…4 nur dünn (100 Laufminuten): „unter 4 °C keine ausreichenden Daten … nur 100 Laufminuten“', A4.baender[1].status === 'dünn' && /unter 4 °C keine ausreichenden Daten/.test(A4.hinweis) && /100 Laufminuten/.test(A4.hinweis), A4.hinweis);
    // Güte je Band aus gesammelten Fehlern
    const D = baue(1, (d, i) => i < 720 ? -2 : 6), r = ['2026-11-01', '2026-11-01'];
    const teil = {_samm: {strom: [{at: -2, e: 3}, {at: -1, e: 4}, {at: 6, e: 1}], waerme: [], regler: [{at: 6, e: 2}], wasserkreis: [{at: 6, e: 0.5}, {at: 6, e: -0.5}], haus: []}};
    const B = T.bandStatus(T.jeBand(D, r, teil, [{art: 'pause', at: -2, fehlerMin: -10}, {art: 'pause', at: -3, fehlerMin: 20}, {art: 'lauf', at: 6, fehlerMin: 5}]), A1);
    check('Güte je Band: RMSE und n je Band (Strom < 0 °C: √((9+16)/2) = 3,54 W aus 2 Minuten)', B[0].strom.n === 2 && B[0].strom.rmseW === 3.5 && B[2].strom.rmseW === 1 && B[2].wasserkreis.n === 1 && B[2].wasserkreis.rmseK === 0.5, JSON.stringify(B[0].strom));
    check('Güte je Band: Minuten und Laufminuten, Zyklen nach AT am Beginn (Pause-Median < 0 °C 15 min aus 2)', B[0].minuten === 720 && B[0].laufMinuten === 600 && B[0].pause.n === 2 && B[0].pause.medianAbsMin === 15 && B[2].lauf.medianAbsMin === 5);
    check('Testband ohne Minuten und ohne Daten im Fenster (≥ 12 °C): „keine Daten, Zwilling extrapoliert“; mit Daten im Fenster (8…12 °C): „keine Testdaten“; mit Minuten: „Daten“', B[4].status === T.KEINE_DATEN && B[3].status === 'keine Testdaten' && B[0].status === 'Daten', B.map(b => b.status).join(' | '));
}

if (datenDir) {
    console.log('--- Auf echten Daten (' + datenDir + ')');
    const t0 = process.hrtime.bigint();
    const R0 = T.trainiere(datenDir, {tage: 21});
    const sek0 = Number(process.hrtime.bigint() - t0) / 1e9;
    check('ohne Vorwert: wie bisher roh gelernt, Entscheidung „erster Lauf“, kein roh-Abschnitt', R0.roh === null && R0.entscheidung.ergebnis === 'übernommen' && /erster Lauf/.test(R0.entscheidung.grund) && R0.glaettung.anteil === 1, sek0.toFixed(1) + ' s');
    check('Güte je Band im Test: 5 Bänder mit Minuten und Status, Summe der Minuten = Testminuten mit AT', R0.guete.test.jeBand.length === 5 && R0.guete.test.jeBand.every(b => typeof b.minuten === 'number' && b.status));
    check('Abdeckung: Hinweis auf fehlende Frostdaten (Oktober: keine AT < 0 °C)', R0.abdeckung.baender[0].status === T.KEINE_DATEN && /unter 0 °C/.test(R0.abdeckung.hinweis || ''), R0.abdeckung.hinweis);
    // Champion: Satz mit verschobenen Werten (ua +10 %, hausAtTauMin 240, gain 0,23)
    const V = JSON.parse(JSON.stringify(R0)); ['werte', 'werteTraining'].forEach(w => { V[w].ua = Math.round(V[w].ua * 1.1 * 1e4) / 1e4; V[w].hausAtTauMin = 240; V[w].gain = 0.23; });
    const t1 = process.hrtime.bigint();
    const R1 = T.trainiere(datenDir, {tage: 21, vorher: V, vorherTag: '2026-10-16'});
    const sek1 = Number(process.hrtime.bigint() - t1) / 1e9;
    const k3 = ['ua', 'gain', 'hausAtTauMin', 'pelHz', 'cw'];
    check('mit Vorwert: übernommen = Vorwert + 1/3 · (roh − Vorwert) je Parameter', k3.every(k => nah(R1.werte[k], V.werte[k] + (R1.roh.werte[k] - V.werte[k]) / 3, 2e-6) && nah(R1.werteTraining[k], V.werteTraining[k] + (R1.roh.werteTraining[k] - V.werteTraining[k]) / 3, 2e-6)),
          k3.map(k => k + ' ' + V.werte[k] + ' → roh ' + R1.roh.werte[k] + ' → ' + R1.werte[k]).join('; '));
    check('Dünn-Daten-Phase erkannt (unter 21 Tagen): Bindung aktiv, hausAtTauMin bleibt gebunden auf 240 (ungebunden ' + R0.werte.hausAtTauMin + ')', R1.glaettung.bindung.aktiv && R1.roh.werte.hausAtTauMin === 240, R1.glaettung.bindung.grund);
    check('Gut bestimmte Parameter folgen trotz Bindung den Daten (Strom pelHz roh ±2 % gegen ungebunden)', Math.abs(R1.roh.werte.pelHz / R0.werte.pelHz - 1) < 0.02, R1.roh.werte.pelHz + ' / ' + R0.werte.pelHz);
    check('Entscheidung mit beiden Zahlensätzen (Kandidat, bisher neu bewertet) auf denselben Testtagen', R1.entscheidung && R1.entscheidung.kennzahlen.length === 3 && R1.vorherNeu.guete.test.tage.join() === R1.guete.test.tage.join() && R1.roh.guete.test.tage.join() === R1.guete.test.tage.join(),
          R1.entscheidung.ergebnis + ': ' + R1.entscheidung.kennzahlen.map(k => k.id + ' ' + k.kandidat + '/' + k.bisher).join(', '));
    const R2 = T.trainiere(datenDir, {tage: 21, vorher: V, vorherTag: '2026-10-16'});
    check('mit Vorwert bit-identisch wiederholbar und schnell (< 60 s auf dem PC)', JSON.stringify(R1) === JSON.stringify(R2) && sek1 < 60, sek1.toFixed(1) + ' s');
    // Gate mit synthetisch verdorbenem Satz auf echten Daten
    const D = T.lade(datenDir, null, 21), S = T.trennung(D, {});
    const gut = Z.mitWerten(R0.werteTraining), schlecht = Z.mitWerten(Object.assign({}, R0.werteTraining, {pelHz: R0.werteTraining.pelHz * 1.3}));
    const gG = T.guete(D, S.test, gut), gS = T.guete(D, S.test, schlecht);
    const a = T.entscheide(gS, gG), b = T.entscheide(gG, gS);
    check('echte Daten: verdorbener Herausforderer (pelHz × 1,3) gegen guten Champion → abgelehnt (Strom)', a.ergebnis === 'abgelehnt' && a.kennzahlen[0].verletzt, a.grund);
    check('echte Daten: guter Herausforderer gegen verdorbenen Champion → übernommen', b.ergebnis === 'übernommen', b.kennzahlen.map(k => k.id + ' ' + k.kandidat + '/' + k.bisher).join(', '));
}
// ------------------------------------------------------------------ Abtauen und Quiet-3-Deckel aus eigenen Daten (08.11.2026)
{
    const Zz = require('./wp_zwilling.js'), P0 = Zz.standard(), M = [], t0 = new Date(2026, 10, 1, 0, 0).getTime();
    for (let i = 0; i < 2 * 1440; i++) {                                              // 2 Tage, 0 °C, 91 %, Lauf mit 20 Hz; alle 130 min eine Abtauung von 9 min, Rohr davor −8 °C
        const k = i % 139, def = k >= 130, vorher = k === 129, tag = i < 1440 ? '2026-11-01' : '2026-11-02';
        M.push({t: t0 + i * 60000, tag: tag, ok: true, at: 0, rh: 91, hc: 1, q: 3, lauf: !def || (k - 130) % 9 < 5, def: def, hz: def ? ((k - 130) % 9 < 5 ? 58 : 0) : (k < 30 ? 16 : 21), pel: def ? 900 : 480,
                pipe: vorher ? -8 : -3, hI: false, flow: 15, vl: def ? 25 : 32, rl: def ? 27 : 29, rm: 100});
    }
    const D = {M: M}, f = T.fitAbtau(D, ['2026-11-01', '2026-11-02'], P0);
    check('Abtauen aus eigenen Daten: 9-min-Abtauungen alle 139 Laufminuten bei 0 °C/91 % → Dauer 9, Auslöser-Linie b = −8 (Rohr in der Minute davor), Anker 0 °C/91 %/139 min, Strom 900 W, Frequenz danach (Efficiency) gelernt',
          f._fit.n >= 8 && f.abtauDauerMin === 9 && f.abtauLinie[1] === -8 && f.eisAnker[0] === 0 && f.eisAnker[1] === 91 && f.eisAnker[2] === 139 && f.abtauPelW === 900 && f.nachAbtauEffMin === 30, JSON.stringify(Object.assign({}, f, {_fit: undefined})));
    const wenig = T.fitAbtau({M: M.slice(0, 300)}, ['2026-11-01', '2026-11-02'], P0);
    check('Abtauen: unter 8 Abtauungen bleiben die Vorgaben (keine Werte, nur Hinweis)', wenig.abtauDauerMin === undefined && /zu wenige/.test(wenig._fit.quelle), wenig._fit.quelle);
    const Mq = []; for (let i = 0; i < 400; i++) { [[0, 25], [5, 18], [9, 17]].forEach(([at, hz], j) => Mq.push({t: t0 + (i * 3 + j) * 60000, tag: '2026-11-01', ok: true, lauf: true, def: false, q: 3, rm: 60, at: at, hz: hz})); }
    const d = T.fitDeckelQ3({M: Mq}, ['2026-11-01', '2026-11-01'], P0);
    check('Quiet-3-Deckel aus eigenen Daten: 0 °C 25 Hz, 5 °C 18 Hz, 9 °C 17 Hz → Stufen [[0,25],[5,18],[99,17]]', JSON.stringify(d.capQ3Tab) === '[[0,25],[5,18],[99,17]]', JSON.stringify(d.capQ3Tab));
    const g = (pause, n) => ({teil: {pelRmseW: 20, wasserkreisRmseK: 1}, zyklenHausSimuliert: {pause: {medianAbsMin: pause, n: n}}, freilaufSumme: {kwhElZwilling: 10, kwhElMessung: 10, abtauZwilling: 2, abtauMessung: 2}});
    const e1 = T.entscheide(g(11, 1), g(8, 1)), e2 = T.entscheide(g(11, 5), g(8, 5));
    check('Gate: Pause-Median aus 1 Pause entscheidet nichts (übernommen), aus je 5 Pausen schon (11 statt 8 min: abgelehnt)', e1.ergebnis === 'übernommen' && e2.ergebnis === 'abgelehnt', e1.grund + ' | ' + e2.grund);
}
console.log('\n' + oks + ' OK, ' + fails + ' FAIL');
process.exitCode = fails ? 1 : 0;

// Offline-Planer „Algorithmus für die Wärmepumpe“ (Schritt 2, 15.10.2026; Konzept: docs/ALGORITHMUS.md).
// Spielt die echten Protokolle Tag für Tag mit einer Fake-Uhr nach (15-min-Raster, Neuplanung jede volle Stunde):
//   (a) Ist-Verbrauch und Ist-Gradstunden je Tag,
//   (b) Plan des Algorithmus mit den Daten und Prognosen, die zur Planzeit vorlagen (kein Blick in die Zukunft),
//   (c) Wirkung im Gebäudemodell (ungeprüft: Sensitivität Speichermasse C 1,5/3/6 kWh/K und UA ±30 %),
//   (d) kWh gespart je Tag und %, Eingriffe, Komfortverletzungen, Hebel getrennt (Raum, Vorlauf, Zeit, Quiet/Heizregelung).
// Reine Funktionen; liest nur. Schaltet nichts, sendet nichts. engine_core.js wird nur gelesen (Whitelist, Sperr-Parameter, Mindestfrequenz-Tabelle).
// Usage: node tools/plan_algo.js <Datenordner> [--md [Datei]] [--json Datei] [--schnell]
//   --md ohne Datei: Bericht auf stdout; mit Datei: ersetzt dort den Block <!-- PLAN-ALGO --> … <!-- /PLAN-ALGO --> (oder schreibt die Datei neu)
//   --schnell: ohne Sensitivitätsgitter (nur Basis)
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const ENGINE = require('./engine_core.js');

const MIN = 60000, SLOT_MIN = 15, SLOT = SLOT_MIN * MIN, HOUR = 60 * MIN, DAY = 24 * HOUR, DTH = SLOT_MIN / 60;
const ROOMS = [['ki_oben', 'Kinderzimmer oben'], ['ki_unten', 'Kinderzimmer unten'], ['schlaf', 'Schlafzimmer'], ['wohn', 'Wohnzimmer']];

// ------------------------------------------------------------------ Parameter mit Herkunft (M = Messung an dieser Anlage, F = Forum 189605, A = Annahme, N = Nutzer, R = Regelwerk engine_core)
const PARAM = {
    minVlC: [29, 'N: Soll-Vorlauf nie unter 29 °C (Heizkörper, 08.10./13.10.)'],
    shiftMin: [ENGINE.WHITELIST.SetZ1HeatRequestTemperature.werte[0], 'R: Whitelist SetZ1HeatRequestTemperature −1…+1'],
    shiftMax: [ENGINE.WHITELIST.SetZ1HeatRequestTemperature.werte[2], 'R: Whitelist SetZ1HeatRequestTemperature −1…+1'],
    haltMin: [ENGINE.LOCK_CFG.shiftHaltMin, 'R: shiftHaltMin – Gegenrichtung frühestens 60 min nach der letzten Änderung'],
    gegenMin: [ENGINE.LOCK_CFG.gegenMin, 'R: gegenMin – Gegenrichtung ohne Komfort-Notfall erst nach 240 min'],
    notK: [ENGINE.LOCK_CFG.notK, 'R: notK – Komfort-Notfall ab 0,3 K außerhalb des Bandes'],
    proTag: [6, 'R: Übernahme höchstens 6 Befehle je Tag (gemeinsam für alle Größen)'],
    laufMinusK: [0, 'R: raum_offset laufMinusK – −1 K im Lauf nur bei Vorlauf ≤ Soll + 0 K (ungünstigster Fall mit natürlichem Sollsprung +2 K; gemessen kein Stopp bis +2,25 K, 18/18)'],
    kurveRuhigMin: [10, 'R: raum_offset kurveRuhigMin – nicht im 5-min-Takt eines natürlichen Sollsprungs schreiben'],
    kurveRandK: [1, 'A: −1 K nur, wenn der Soll auch bei 1 K wärmerer Prognose ≥ 30 °C bliebe (Soll flattert an der Rundungsgrenze, RE-2; Prognosefehler)'],
    lueftungK: [1, 'R: Lüften = Sturz ≥ 1 K binnen 60 min (lueftungK); danach 60 min kein Bedarf aus diesem Raum (lueftSperreMin)'],
    lueftKh: [1, 'R: Gefälle ≥ 1 K/h ist Lüften oder offene Tür, kein Heizmangel (lueftKh)'],
    trendH: [2, 'A: Raumtrend (Regression über 2 h) wird höchstens 2 h fortgeschrieben, danach gehalten (Persistenz)'],
    trendMaxKh: [0.5, 'A: fortgeschriebener Trend höchstens ±0,5 K/h (Auskühlen in der Pause 0,2–0,5 K/h)'],
    nurMinus: [false, 'Variante: Plan nur −1 K/0 (keine Komfort-Reparatur, kein Vorheizen)'],
    ohneKomfort: [false, 'Variante „Obergrenze“: Räume werden ignoriert (−1 K, wann immer der Soll es erlaubt) – nur zur Einordnung, kein Betriebsmodus'],
    reserveK: [0.3, 'A: Zielreserve des knappsten Raums über seinem Minimum (wie notK/Vorausschau reserveK)'],
    kaltK: [0.2, 'R: raum_offset kaltK/warmK – Raum gilt als unter Minimum bzw. über Maximum ab 0,2 K'],
    verteilNotK: [0.5, 'R: raum_offset verteilNotK – trotz Wärmeverteilungskonflikt +1 K ab 0,5 K unter Minimum'],
    raumAlterMaxMin: [720, 'R: raum_offset raumAlterMaxMin – Raumwert gilt 12 h (Shelly melden nur bei Änderung)'],
    fVlProK: [0.035, 'M/Schätzung: Soll-Vorlauf −1 K ≈ 3–4 % Strom (P el = −33 W + 11,8 W/K × Rücklauf, heating_control_concept 6a; Review 5.2)'],
    kRaum: [0.5, 'A: Raum ändert sich im Gleichgewicht um 0,5 K je 1 K Vorlauf (Review 5.2 „Raum −0,5 K ≈ VL −1 K“; nicht gemessen)'],
    cPlan: [3, 'A: Speichermasse des Hauses 3 kWh/K (Wärmefahrplan, Annahme; Spanne 1,5–10)'],
    ua0: [0.15, 'A: Vorwert UA 0,15 kW/K aus der Auslegung (5 kW bei −13 °C und 21 °C innen); wird aus den Vortagen gelernt'],
    g0: [0.3, 'A: Vorwert Gewinne (Personen, Geräte, Sonne im Tagesmittel) 0,3 kW; wird gelernt'],
    priorTage: [2, 'A: Gewicht des Vorwerts in Tagen'],
    lernMinTage: [2, 'A: gelerntes Modell erst ab 2 vollständigen Vortagen, sonst Vorwert'],
    pminKW: [2.1, 'M: Mindestleistung 16–17 Hz ≈ 2,0–2,2 kW thermisch (07.–15.10.)'],
    startWh: [10, 'M: Startspitze 28–35 Hz / 640–910 W für wenige Minuten ≈ 10 Wh je Start'],
    bandKWh: [2, 'M/Schätzung: Wärme im Schaltband Soll −3,25…+3 K ≈ 1,7–3 kWh (heizgrenze-analyse 4.1) → Starts je kWh Mehrwärme'],
    abtauStartKWh: [0.02, 'A: Abtau-Risiko je zusätzlichem Start bei Abtauwetter (ohne eigene Abtau-Daten; Forum: Abtau-Energie nicht beziffert)'],
    abtauAtMin: [ENGINE.LOCK_CFG.abtauAtMin, 'R/F: Abtauwetter −5…+4 °C (Fühlerwert der WP; Forum F6-a)'],
    abtauAtMax: [ENGINE.LOCK_CFG.abtauAtMax, 'R/F: Abtauwetter −5…+4 °C'],
    abtauRh: [80, 'F/A: Abtauwetter ab 80 % Feuchte (Forum J: Abtauserien bei 82–90 %; für die L nicht beziffert)'],
    heizstabAtC: [2, 'R: Heizstab-Nähe unter Heater_On_Outdoor_Temp (0 °C) + heaterMarginK (2 K)'],
    heizstabRueckK: [2, 'R: RE-6 – +1 K im Lauf nur, wenn der Rückstand danach < |Start-Delta| − 1 K = 2 K bleibt'],
    rlMinC: [28, 'R: RE-6 – −1 K unter 3 °C nur bei Rücklauf ≥ 28 °C'],
    rlMinAtC: [3, 'R: RE-6 – Grenze 3 °C'],
    hgAusAb: [15, 'M: Heizgrenze 12: aus ab 15 °C (5/5)'],
    hgAnBis: [12, 'M: Heizgrenze 12: an bei ≤ 12 °C (5/5)'],
    biasTage: [3, 'A: Abweichung Fühler − OWM je Uhrzeit aus den letzten 3 Tagen (Tagesgang-Bereinigung wie in der Vorausschau: tagesgangTage 3); 0 = aus'],
    anchorTauH: [4, 'R: Wärmefahrplan anchorTauH – OWM-Prognose an den Fühler verankert, Abweichung klingt mit 4 h ab'],
    grundlastKW: [0.6, 'M/A: Haushalts-Grundlast nachts 500–650 Wh/h (VRM-Analyse); tagsüber angenommen gleich, Wallbox nicht prognostiziert'],
    akkuKWh: [43, 'M: Akku 43 kWh (VRM DESS)'],
    socVoll: [95, 'Auftrag: PV-Überschuss zählt nur bei Akku-SoC ≥ 95 % als Kostenfaktor 0'],
    lamUnter: [0.25, 'A: Komfortstrafe 0,25 kWh je K·h unter Minimum + Reserve (so, dass −1 K erst ab ~0,6 K Reserve gewählt wird)'],
    lamMin: [3, 'A: Komfortstrafe 3 kWh je K·h unter Minimum (Komfort vor Energie)'],
    lamWarm: [0.25, 'A: Strafe 0,25 kWh je K·h, um die der Plan einen Raum über sein Maximum hebt'],
    wechselKWh: [0.02, 'A: Wechselkosten je Befehl (gegen Flattern; Schreibbudget)'],
    gridStepK: [0.02, 'Rechengitter des DP-Zustands (K)'],
    quietHz: [28, 'M/R: Verdichter ≥ 28 Hz ohne Bedarf = vermeidbarer Hochlauf (quiet_strecken v5 hzHoch)'],
    quietGewinn: [0.03, 'M: COP ab 28 Hz korrigiert −3 % gegen 16–17 Hz (OPTIMIERER 19/20.2; roh −5…−15 %)'],
    quietAbLaufMin: [5, 'M: Startspitze in Laufminute 0–5 ist bei jeder Stufe unvermeidbar'],
    quietAtMin: [3, 'R: quiet_strecken atMinC – unter 3 °C kein Deckel'],
    pelKorrW: [ENGINE.COP_KORR.pelKorrW, 'F/M: TOP16 untertreibt 70–90 W → +80 W im Lauf (Forum 4545989, 4597230)']
};
function defaults() { const o = {}; Object.keys(PARAM).forEach(k => { o[k] = PARAM[k][0]; }); return o; }

// Heizkurve Z1 (Fühler-AT → Soll): bis 13.10. Kaltpunkt 38, danach 37 °C (Nutzer, von Hand); Warmpunkt 11 °C → 29 °C (wie engine_replay ASSUME)
const KURVE_WECHSEL = new Date(2026, 9, 13, 13, 0).getTime();
function kurve(at, t) { const hi = t < KURVE_WECHSEL ? 38 : 37; if (at === null) { return null; } if (at <= -13) { return hi; } if (at >= 11) { return 29; } return hi + (29 - hi) * (at + 13) / 24; }

// Rückfall-COP, falls für ein Außenband noch keine Messung vorliegt: korrigierte Bänder 07.–13.10. (M), darunter Forum (F) – nicht auf Frost extrapolieren (F10-b)
const COP_RUECKFALL = [[-10, 2.8, 'A: unter −7 °C fallend (Abtauen, Mindestfrequenz 35 Hz)'], [-7, 3.0, 'F: Datenblatt WH-WDG05LE5 Volllast −7 °C 3,01 (3661016)'],
    [-3, 3.7, 'F: L5 bei −3 °C AZ ~3,7 (4013336)'], [1, 4.3, 'F/M: L5 1 °C 4,34 (4040222); Band < 4 °C 4,30'], [6, 4.62, 'M: Band 4–8 °C'], [9.5, 4.92, 'M: Band 8–11 °C'], [13, 5.51, 'M: Band ≥ 11 °C']];

function n(x) { if (x === undefined || x === null || x === '') { return null; } const v = Number(x); return isFinite(v) ? v : null; }
function r2(x) { return x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100; }
function r3(x) { return x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 1000) / 1000; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function lerp(x, x0, y0, x1, y1) { return x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
function pad(x) { return String(x).padStart(2, '0'); }
function ymd(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hm(t) { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function dm(t) { const d = new Date(t); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.'; }
function tagStart(t) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function de(x, k) { return x === null || x === undefined || !isFinite(x) ? '–' : Number(x).toFixed(k === undefined ? 2 : k).replace('.', ',').replace(/^-/, '−'); }
function pz(x, k) { return x === null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + de(x, k); }

// ------------------------------------------------------------------ Daten lesen (nur lesen; CSV mit wechselnden Kopfzeilen: jede Zeile „zeit,…“ setzt den Kopf neu)
function readMulti(file) {
    const rows = []; let head = null;
    if (!fs.existsSync(file)) { return rows; }
    fs.readFileSync(file, 'utf8').split('\n').forEach(l => {
        if (!l) { return; }
        const p = l.split(',');
        if (p[0] === 'zeit') { head = p; return; }
        if (!head || p.length !== head.length) { return; }
        const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(p[0]);
        if (!m) { return; }
        const o = {}; head.forEach((h, i) => { o[h] = p[i]; });
        o._t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        rows.push(o);
    });
    return rows.sort((a, b) => a._t - b._t);
}
function readJsonl(file) {
    if (!fs.existsSync(file)) { return []; }
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
function ladeDaten(dir, monat) {
    monat = monat || '2026-10';
    return {dir: dir, monat: monat, Q: readMulti(path.join(dir, 'quiet-' + monat + '.csv')), V: readMulti(path.join(dir, 'optimizer-v2-' + monat + '.csv')),
        E: readMulti(path.join(dir, 'energy-' + monat + '.csv')), F: readJsonl(path.join(dir, 'forecast-' + monat + '.jsonl'))};
}

// ------------------------------------------------------------------ 15-min-Slots aus den Protokollen (rein)
// slot: {t, dt (erfasste Minuten), el, elRun (kWh el, +80 W im Lauf), th (kWh th), ta (Fühler), soll, vl, rl, z ('lauf'|'pause'|'aus'), hzMax, q, hc, defrost,
//        kzRad, rooms [[id, wert, min, max]] (nur gültige), owm, rh, pv (W), soc, haus (W), el28 (kWh in Minuten ≥ quietHz ab Laufminute 5), lauf (Laufminuten im Slot)}
function zustandOf(r) {
    if (r.zustand === 'lauf' || r.zustand === 'pause' || r.zustand === 'heizgrenze') { return r.zustand === 'heizgrenze' ? 'aus' : r.zustand; }
    const hz = n(r.verdichter_hz), pump = n(r.pumpe_speed);
    if (hz !== null && hz > 0) { return 'lauf'; }
    if (pump !== null && pump < 1000) { return 'aus'; }
    return 'pause';
}
function slotsBauen(D, p) {
    p = p || defaults();
    const Q = D.Q, V = D.V, E = D.E;
    if (!Q.length) { throw new Error('keine Minutendaten (quiet-*.csv) in ' + D.dir); }
    const M = [];                                                                    // Minutenraster: jede Zeile gilt bis zur nächsten (höchstens 5 min; ältere Stillstandszeilen im 5-min-Takt)
    for (let i = 0; i < Q.length; i++) {
        const r = Q[i], nx = i + 1 < Q.length ? Q[i + 1]._t : r._t + MIN, k = Math.max(1, Math.min(5, Math.round((nx - r._t) / MIN)));
        for (let j = 0; j < k; j++) { M.push({t: r._t + j * MIN, r: r}); }
    }
    const t0 = Math.floor(M[0].t / SLOT) * SLOT, t1 = M[M.length - 1].t;
    const slots = []; let mi = 0, vi = -1, ei = -1;
    for (let t = t0; t <= t1; t += SLOT) {
        const s = {t: t, dt: 0, el: 0, elRun: 0, th: 0, taS: 0, taN: 0, ta: null, soll: null, vl: null, rl: null, z: null, zc: {lauf: 0, pause: 0, aus: 0}, hzMax: 0, q: null, hc: null, defrost: 0,
            kzRad: null, rooms: [], owm: null, rh: null, pv: null, soc: null, haus: null, el28: 0, lauf: 0, laufMin: null};
        while (mi < M.length && M[mi].t < t + SLOT) {
            const r = M[mi].r;
            if (M[mi].t >= t) {
                const hz = n(r.verdichter_hz) || 0, pel = n(r.leistung_el_w) || 0, pth = n(r.leistung_th_berechnet_w), z = zustandOf(r), lm = n(r.lauf_min) !== null ? n(r.lauf_min) : n(r.verdichter_laufzeit_min);
                const el = (pel + (hz > 0 ? p.pelKorrW : 0)) / 60000;
                s.dt += 1; s.el += el;
                if (hz > 0) { s.elRun += el; s.th += Math.max(0, pth || 0) / 60000; s.lauf += 1; s.hzMax = Math.max(s.hzMax, hz); }
                if (hz >= p.quietHz && lm !== null && lm > p.quietAbLaufMin) { s.el28 += el; }
                const at = n(r.aussen); if (at !== null) { s.taS += at; s.taN += 1; }
                s.zc[z] += 1;
                if (n(r.soll_vl) !== null) { s.soll = n(r.soll_vl); } if (n(r.ist_vl) !== null) { s.vl = n(r.ist_vl); } if (n(r.ist_rl) !== null) { s.rl = n(r.ist_rl); }
                if (n(r.quiet_aktuell) !== null) { s.q = n(r.quiet_aktuell); } if (n(r.heizregelung) !== null) { s.hc = n(r.heizregelung); }
                if (n(r.defrost) === 1) { s.defrost = 1; } if (n(r.kz_radiator_an) !== null) { s.kzRad = n(r.kz_radiator_an); }
                s.laufMin = hz > 0 ? lm : 0;
            }
            mi++;
        }
        if (s.dt === 0) { continue; }
        s.ta = s.taN ? s.taS / s.taN : null;
        s.z = s.zc.lauf > 0 ? 'lauf' : (s.zc.aus >= s.zc.pause ? 'aus' : 'pause');
        const tEnd = t + SLOT;
        while (vi + 1 < V.length && V[vi + 1]._t <= tEnd) { vi++; }
        if (vi >= 0 && tEnd - V[vi]._t <= 60 * MIN) {
            const v = V[vi], age = (tEnd - v._t) / MIN;
            ROOMS.forEach(([id]) => {
                const val = n(v[id + '_ema']) !== null ? n(v[id + '_ema']) : n(v[id + '_wert']), a = n(v[id + '_alter_min']), mn = n(v[id + '_min']), mx = n(v[id + '_max']);
                if (val !== null && a !== null && mn !== null && mx !== null && a + age <= p.raumAlterMaxMin) { s.rooms.push([id, val, mn, mx]); }
            });
            s.owm = n(v.aussen_wetter); s.rh = n(v.wetter_feuchte);
        }
        while (ei + 1 < E.length && E[ei + 1]._t <= tEnd) { ei++; }
        if (ei >= 0 && tEnd - E[ei]._t <= 30 * MIN) { s.pv = n(E[ei].pv_w); s.soc = n(E[ei].batterie_soc); s.haus = n(E[ei].haus_w); }
        delete s.taS; delete s.taN; delete s.zc;
        ['el', 'elRun', 'th', 'el28'].forEach(k => { s[k] = Math.round(s[k] * 1e6) / 1e6; });
        slots.push(s);
    }
    raumVerlauf(slots, p);
    return slots;
}
// je Raum: Lüften (Sturz ≥ lueftungK binnen 60 min, 60 min Sperre, oder Gefälle ≥ lueftKh) und Trend (Regression über 2 h, K/h); rooms-Eintrag wird [id, wert, min, max, lüften 0/1, trend]
function raumVerlauf(slots, p) {
    const H = {}; ROOMS.forEach(([id]) => { H[id] = []; });
    slots.forEach((s, i) => {
        s.rooms.forEach(r => { H[r[0]].push([i, s.t, r[1]]); });
        s.rooms.forEach(r => {
            const L = H[r[0]].filter(x => x[1] > s.t - 2 * HOUR - 1);
            let sturz = false;
            for (const x of L) {                                                     // Sturz in den letzten 60 min (Lüften) – geprüft je Punkt der letzten Stunde gegen die Stunde davor
                if (x[1] < s.t - HOUR) { continue; }
                if (L.some(y => y[1] < x[1] && y[1] >= x[1] - HOUR && y[2] - x[2] >= p.lueftungK)) { sturz = true; break; }
            }
            let tr = null;
            if (L.length >= 5) { const mx = L.reduce((a, x) => a + x[1], 0) / L.length, my = L.reduce((a, x) => a + x[2], 0) / L.length; let sxy = 0, sxx = 0; L.forEach(x => { sxy += (x[1] - mx) * (x[2] - my); sxx += (x[1] - mx) * (x[1] - mx); }); tr = sxx > 0 ? sxy / sxx * HOUR : null; }
            r.push(sturz || (tr !== null && tr <= -p.lueftKh) ? 1 : 0, tr === null ? 0 : Math.round(tr * 1000) / 1000);
        });
    });
}

// Prognosen: forecast-*.jsonl (stündliche Schnappschüsse: OWM-Punkte [ms, °C, rF, Wolken, Wind], PV [s, W, Dauer s], Fühler at); sonst aus dem 5-min-Protokoll
// (aussen_wetter, prog_1h/3h/6h, Abrufzeit = Zeile − wetter_alter_min; jenseits +6 h bleibt der letzte Wert – geringes Vertrauen)
function prognosenBauen(D) {
    if (D.F && D.F.length) {
        return {quelle: 'forecast-*.jsonl (stündliche Schnappschüsse)', liste: D.F.map(x => ({t: x.t * 1000, at: n(x.at), pts: (x.owm || []).map(o => [o[0], n(o[1]), n(o[2])]).filter(o => o[1] !== null),
            pv: (x.pv || []).map(v => [v[0] * 1000, n(v[1]) || 0, (v[2] || 3600) * 1000])})).filter(x => x.pts.length >= 2).sort((a, b) => a.t - b.t)};
    }
    const L = [];
    D.V.forEach(v => {
        if (v._t % HOUR > 5 * MIN) { return; }
        const aw = n(v.aussen_wetter), p1 = n(v.prog_1h), p3 = n(v.prog_3h), p6 = n(v.prog_6h), wa = n(v.wetter_alter_min) || 0, rh = n(v.wetter_feuchte);
        if (aw === null || p1 === null || p3 === null || p6 === null) { return; }
        const ft = v._t - wa * MIN;
        L.push({t: v._t, at: n(v.aussen_panasonic), pts: [[ft, aw, rh], [ft + HOUR, p1, rh], [ft + 3 * HOUR, p3, rh], [ft + 6 * HOUR, p6, rh]], pv: []});
    });
    return {quelle: 'Rückfall: 5-min-Protokoll (jetzt, +1, +3, +6 h; danach gehalten)', liste: L};
}
function prognoseBei(P, t) { let b = null; for (const x of P.liste) { if (x.t <= t) { b = x; } else { break; } } return b; }
function wetterFn(fc, atNow, t, p, bias) {                                            // Funktion Zeit → {ta (am Fühler verankert), rh, pvW}; bias: Abweichung Fühler − OWM je Uhrzeit (24 Werte) oder null
    const pts = fc.pts;
    function at(u) { if (u <= pts[0][0]) { return pts[0][1]; } for (let i = 1; i < pts.length; i++) { if (pts[i][0] >= u) { return lerp(u, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); } } return pts[pts.length - 1][1]; }
    function rh(u) { let b = pts[0][2]; for (const x of pts) { if (x[0] <= u && x[2] !== null) { b = x[2]; } } return b; }
    const bAt = u => bias ? bias[new Date(u).getHours()] : 0;
    const anchor = atNow !== null ? clamp(atNow - at(t) - bAt(t), -5, 5) : 0;
    return u => {
        const L = Math.max(0, (u - t) / HOUR);
        let pv = 0; for (const x of fc.pv) { if (u >= x[0] && u < x[0] + x[2]) { pv = x[1]; break; } }
        return {ta: at(u) + bAt(u) + anchor * Math.exp(-L / p.anchorTauH), rh: rh(u), pvW: pv};
    };
}
// Tagesgang der Abweichung Fühler − OWM (Fühler im Schatten: nachts bei klarem Himmel 2–4 K kälter): Mittel je Uhrzeit über die letzten biasTage Tage vor bisT
function biasProfil(slots, bisT, p) {
    if (!p.biasTage) { return null; }
    const S = Array.from({length: 24}, () => [0, 0]);
    slots.forEach(s => { if (s.t + SLOT > bisT || s.t < bisT - p.biasTage * DAY || s.ta === null || s.owm === null) { return; } const h = new Date(s.t).getHours(); S[h][0] += s.ta - s.owm; S[h][1]++; });
    if (S.some(x => x[1] < 2 * p.biasTage)) { return null; }
    return S.map(x => Math.round(x[0] / x[1] * 100) / 100);
}

// ------------------------------------------------------------------ Schicht 1: Tageswerte und Gebäudemodell
function tageBauen(slots) {
    const T = {};
    slots.forEach(s => {
        const k = ymd(s.t), d = T[k] = T[k] || {tag: k, t0: tagStart(s.t), dt: 0, el: 0, th: 0, taS: 0, taN: 0, tiS: 0, tiN: 0, kh: 0, pv: 0};
        d.dt += s.dt; d.el += s.el; d.th += s.th;
        if (s.ta !== null) { d.taS += s.ta * s.dt; d.taN += s.dt; }
        const ti = tiMittel(s.rooms); if (ti !== null) { d.tiS += ti * s.dt; d.tiN += s.dt; if (s.ta !== null) { d.kh += Math.max(0, ti - s.ta) * s.dt / 60; } }
        if (s.pv !== null) { d.pv += s.pv * s.dt / 60000; }
    });
    return Object.keys(T).sort().map(k => { const d = T[k]; d.ta = d.taN ? d.taS / d.taN : null; d.ti = d.tiN ? d.tiS / d.tiN : null; d.voll = d.dt >= 0.9 * 1440 && d.tiN >= 0.8 * d.dt; delete d.taS; delete d.taN; delete d.tiS; delete d.tiN; return d; });
}
function tiMittel(rooms) { if (!rooms || !rooms.length) { return null; } return rooms.reduce((a, r) => a + r[1], 0) / rooms.length; }
// P = UA·(Ti − Ta) − g, Ridge mit Vorwert (ua0, g0), Gewicht priorTage; nur vollständige Tage vor bisT
function lerneModell(tage, bisT, p) {
    const L = tage.filter(d => d.voll && d.t0 + DAY <= bisT && d.ti !== null && d.ta !== null);
    const X = [], Y = [], Wt = [];                                                  // Vorwert als zwei Pseudo-Tage bei Ti − Ta = 10 und 16 K mit Gewicht priorTage (verankert Steigung und Achsabschnitt)
    [10, 16].forEach(x => { X.push(x); Y.push(p.ua0 * x - p.g0); Wt.push(p.priorTage); });
    L.forEach(d => { X.push(d.ti - d.ta); Y.push(d.th / 24); Wt.push(1); });
    const sw = Wt.reduce((a, b) => a + b, 0), mx = X.reduce((a, x, i) => a + Wt[i] * x, 0) / sw, my = Y.reduce((a, y, i) => a + Wt[i] * y, 0) / sw;
    let sxy = 0, sxx = 0; for (let i = 0; i < X.length; i++) { sxy += Wt[i] * (X[i] - mx) * (Y[i] - my); sxx += Wt[i] * (X[i] - mx) * (X[i] - mx); }
    let ua = sxx > 0 ? sxy / sxx : p.ua0, g = ua * mx - my;
    if (L.length < p.lernMinTage || !(ua > 0.05 && ua < 0.5)) { ua = p.ua0; g = p.g0; }
    return {ua: ua, g: g, n: L.length, quelle: L.length >= p.lernMinTage ? 'gelernt aus ' + L.length + ' Vortagen' : 'Vorwert (Auslegung)'};
}
// altes Modell des Wärmefahrplans (opt_plan): UA = (0,22·300 + ΣQ)/(300 + ΣKh(15)), Bedarf = UA·max(0, 15 − Ta)
function altesModell(tage, slots, bisT) {
    let sQ = 0, sH = 0;
    tage.filter(d => d.voll && d.t0 + DAY <= bisT).forEach(d => {
        let kh = 0; slots.forEach(s => { if (s.t >= d.t0 && s.t < d.t0 + DAY && s.ta !== null) { kh += Math.max(0, 15 - s.ta) * s.dt / 60; } });
        if (kh >= 30) { sQ += d.th; sH += kh; }
    });
    return {ua: (0.22 * 300 + sQ) / (300 + sH), tbal: 15};
}
// COP je Außentemperatur aus den Laufminuten vor bisT (+80 W, ohne Abtauen), 3-K-Bänder ab 60 Laufminuten; sonst Rückfall-Tabelle
function copModell(slots, bisT) {
    const B = {};
    slots.forEach(s => { if (s.t + SLOT > bisT || s.lauf < 14 || s.defrost || s.ta === null || s.th <= 0) { return; } const k = Math.floor(s.ta / 3); const b = B[k] = B[k] || {th: 0, el: 0, m: 0, at: 0}; b.th += s.th; b.el += s.elRun; b.m += s.lauf; b.at += s.ta * s.lauf; });
    const pts = Object.keys(B).map(k => B[k]).filter(b => b.m >= 60 && b.el > 0).map(b => [b.at / b.m, b.th / b.el, b.m]).sort((a, b) => a[0] - b[0]);
    const tab = COP_RUECKFALL.map(x => [x[0], x[1]]);
    const all = pts.length ? tab.filter(x => x[0] < pts[0][0] - 2).concat(pts.map(x => [x[0], x[1]])) : tab;
    function cop(ta) { if (ta <= all[0][0]) { return all[0][1]; } for (let i = 1; i < all.length; i++) { if (ta <= all[i][0]) { return lerp(ta, all[i - 1][0], all[i - 1][1], all[i][0], all[i][1]); } } return all[all.length - 1][1]; }
    return {cop: cop, pts: pts, quelle: pts.length ? 'gemessen (' + pts.length + ' Bänder)' : 'Rückfall-Tabelle'};
}
function pminKW(ta, p) { const mh = ENGINE.minHzTab(ta).hz; return mh >= 35 ? 2.8 : (mh >= 25 ? 2.0 : p.pminKW); }   // 25 Hz ≈ 2 kW (F 4596796); 35 Hz ≈ 2,8 kW (A)

// ------------------------------------------------------------------ Räume: knappster Raum, wärmster Raum, Wärmeverteilung
function raumLage(rooms, dT, kzRad, p) {
    if (!rooms || !rooms.length) { return {n: 0}; }
    let knapp = null, warm = null, unter = null, ueber = null;
    rooms.forEach(([id, v, mn, mx, lueft]) => {
        const w = v + dT;
        const zaehlt = !(id === ENGINE.RELAIS_RAUM && kzRad === 0) && !lueft;        // Kinderzimmer oben: eigene Relaisregelung, knapp zählt nur bei offenem Relais (RE-8); gelüftete Räume zählen nicht
        if (zaehlt && (knapp === null || w - mn < knapp.m)) { knapp = {id: id, m: w - mn}; }
        if (warm === null || w - mx > warm.m) { warm = {id: id, m: w - mx}; }
        if (zaehlt && w < mn - p.kaltK && (unter === null || w - mn < unter.m)) { unter = {id: id, m: w - mn}; }
        if (w > mx + p.kaltK) { ueber = {id: id, m: w - mx}; }
    });
    return {n: rooms.length, knapp: knapp, warm: warm, konflikt: !!(unter && ueber), unter: unter, ueber: ueber};
}

// ------------------------------------------------------------------ Schicht 2–4: 24-h-Plan, 15-min-Raster, Entscheidung je volle Stunde (dynamische Programmierung)
// Modell (linear um den Ist-Verlauf): ΔT = Abweichung der Raumtemperatur durch den Plan. Ein Slot mit Pumpe:  C·dΔT/dt = Krad·(s − ΔT) − UA·ΔT,
// Mehrwärme ΔQ = Krad·(s − ΔT)·dt, Gleichgewicht ΔT = k·s mit k = Krad/(Krad + UA). Heizgrenze-Aus: ΔQ = 0, ΔT klingt mit C/UA ab.
// Strom je Slot: ΔE = [(Qbase + ΔQ)·(1 + f·s) − Qbase] / COP(Ta) + Startkosten; mit Gewicht w (0 bei PV-Überschuss und vollem Akku).
function physik(m) { const sum = m.krad + m.ua; return {k: m.krad / sum, aOn: Math.exp(-DTH / (m.c / sum)), tauOn: m.c / sum, aOff: Math.exp(-DTH / (m.c / m.ua)), tauOff: m.c / m.ua}; }
function slotSchritt(dT0, s, on, ph, m) {                                             // → {dT1, dTavg, dQ}
    if (!on) { const dT1 = dT0 * ph.aOff; return {dT1: dT1, dTavg: dT0 * (1 - ph.aOff) * ph.tauOff / DTH, dQ: 0}; }
    const eq = ph.k * s, dT1 = eq + (dT0 - eq) * ph.aOn, dTavg = eq + (dT0 - eq) * (1 - ph.aOn) * ph.tauOn / DTH;
    return {dT1: dT1, dTavg: dTavg, dQ: m.krad * (s - dTavg) * DTH};
}
function slotKosten(x, s, st, ph, m, p) {                                             // Kosten eines Slots im Plan (kWh, gewichtet) und Strafen
    const r = slotSchritt(x, s, !st.aus, ph, m);
    let e = 0;
    if (!st.aus) {
        e = ((st.qBase + r.dQ) * (1 + p.fVlProK * s) - st.qBase) / st.cop;
        if (st.takt) { e += r.dQ / p.bandKWh * (p.startWh / 1000 + (st.abtau ? p.abtauStartKWh : 0)); }
    }
    let pen = 0;
    if (st.mKnapp !== null) {                                                        // Totband: zwischen Minimum − kaltK und Minimum + Reserve kostet nur, was der Plan verschlechtert
        const mg = st.mKnapp + r.dTavg;
        pen += p.lamUnter * Math.max(0, Math.max(0, p.reserveK - mg) - Math.max(0, p.reserveK - st.mKnapp)) * DTH + p.lamMin * Math.max(0, -p.kaltK - mg) * DTH;
    }
    if (st.mWarm !== null && r.dTavg > 0) { pen += p.lamWarm * (Math.max(0, st.mWarm + r.dTavg) - Math.max(0, st.mWarm)) * DTH; }
    return {c: st.w * e + pen, r: r};
}
function erlaubt(sPrev, s, h, ctx, p) {                                                // Grenzen je Entscheidung (ganze Grad, ±1 K je Schritt, Whitelist, VL ≥ 29 °C, Sperren)
    if (s < p.shiftMin || s > p.shiftMax || Math.abs(s - sPrev) > 1) { return false; }
    if (p.nurMinus && s > 0) { return false; }
    if (ctx.keineRaeume && s !== 0 && Math.abs(s) >= Math.abs(sPrev)) { return false; }   // ohne gültige Räume nur zurück auf 0
    if (ctx.konflikt && s !== 0 && !(s > 0 && ctx.notPlus) && Math.abs(s) >= Math.abs(sPrev)) { return false; }   // Wärmeverteilung: Hinweis statt Verschiebung
    for (let j = h * 4; j < h * 4 + 4 && j < ctx.slots.length; j++) {
        const st = ctx.slots[j];
        if (s < 0 && st.sollFc !== null && st.sollFc + s < p.minVlC) { return false; }
        if (s > sPrev && s > 0 && (st.abtau || st.heizstab) && !ctx.notPlus) { return false; }   // kein +1 K bei Abtauwetter (Frequenzsprung) und in Heizstab-Nähe; der Rückweg −1 → 0 bleibt erlaubt
    }
    return true;
}
function planDP(ctx, p) {
    const m = ctx.modell, ph = physik(m), H = Math.floor(ctx.slots.length / 4), S = [-1, 0, 1];
    const g0 = -1.5, g1 = 1.0, gs = p.gridStepK, NG = Math.round((g1 - g0) / gs) + 1;
    const copMean = ctx.slots.reduce((a, s) => a + s.cop, 0) / ctx.slots.length;
    const term = x => -x * m.c * ph.k / copMean;                                       // Rückkehr zum Ist-Verlauf: −ΔT·C·k Wärme (Speicher wird wieder aufgefüllt bzw. entladen)
    let Vn = []; for (let i = 0; i < NG; i++) { Vn.push([0, 0, 0].map(() => term(g0 + i * gs))); }
    const ip = (V, x, si) => { const f = clamp((x - g0) / gs, 0, NG - 1), i = Math.min(NG - 2, Math.floor(f)), a = f - i; return V[i][si] * (1 - a) + V[i + 1][si] * a; };
    const Vs = new Array(H + 1); Vs[H] = Vn;
    function stunde(h, x, s, V) {                                                    // Kosten der Stunde h mit Verschiebung s ab Zustand x, plus Restwert
        let c = 0, xx = x;
        for (let j = h * 4; j < h * 4 + 4; j++) { const k = slotKosten(xx, s, ctx.slots[j], ph, m, p); c += k.c; xx = k.r.dT1; }
        return {c: c + ip(V, xx, s + 1), x: xx};
    }
    for (let h = H - 1; h >= 0; h--) {
        const V = [], Vn1 = Vs[h + 1];
        for (let i = 0; i < NG; i++) {
            const x = g0 + i * gs, row = [];
            for (const sp of S) {
                let best = Infinity;
                for (const s of S) { if (!erlaubt(sp, s, h, ctx, p)) { continue; } const v = stunde(h, x, s, Vn1).c + (s !== sp ? p.wechselKWh : 0); if (v < best) { best = v; } }
                row.push(best === Infinity ? 1e6 : best);
            }
            V.push(row);
        }
        Vs[h] = V;
    }
    const plan = []; let x = ctx.dT0, sp = ctx.s0;
    for (let h = 0; h < H; h++) {
        let best = Infinity, bs = sp, bx = x;
        for (const s of S) { if (!erlaubt(sp, s, h, ctx, p)) { continue; } const r = stunde(h, x, s, Vs[h + 1]); const v = r.c + (s !== sp ? p.wechselKWh : 0); if (v < best - 1e-12) { best = v; bs = s; bx = r.x; } }
        if (best === Infinity) { bs = 0; bx = stunde(h, x, 0, Vs[h + 1]).x; }      // nichts erlaubt (z. B. Soll fällt unter 29 °C): zurück auf 0
        plan.push({h: h, s: bs, dT: r3(bx)}); x = bx; sp = bs;
    }
    return {s: plan.map(x => x.s), dT: plan.map(x => x.dT), copMean: copMean, k: ph.k};
}

// Planungskontext zur Zeit t: nur Daten bis t (Slots davor, letzter Prognose-Schnappschuss ≤ t, Modell aus den Vortagen)
function kontext(t, i, B, st, p) {
    const prev = B.slots[i - 1] || null, modell = st.modell, cm = st.copM;
    const fc = prognoseBei(B.prog, t), atNow = prev ? prev.ta : null;
    const W = fc ? wetterFn(fc, atNow, t, p, st.bias) : null;
    const lage = prev ? raumLage(prev.rooms, st.dTsim, prev.kzRad, p) : {n: 0};
    function basisBei(L) {                                                           // Raumlage ohne eigenen Plan-Einfluss (Ist + ΔT_sim − ΔT_Modell), Trend 2 h fortgeschrieben, dann gehalten
        if (!lage.n || p.ohneKomfort) { return {knapp: null, warm: null}; }
        const fw = Math.min(L, p.trendH);
        const R = prev.rooms.map(r => [r[0], r[1] + st.dTsim - st.dTmod + clamp(r[5] || 0, -p.trendMaxKh, p.trendMaxKh) * fw, r[2], r[3], r[4], 0]);
        const lg = raumLage(R, 0, prev.kzRad, p);
        return {knapp: lg.knapp ? lg.knapp.m : null, warm: lg.warm ? lg.warm.m : null};
    }
    const sollNow = prev && prev.soll !== null ? prev.soll : null;                      // Soll laut Kurve (das Ist lief mit Verschiebung 0)
    let aus = prev ? prev.z === 'aus' : false;
    let socSim = prev && prev.soc !== null ? prev.soc : 0, ueber = 0;
    const slots = [];
    for (let j = 0; j < 96; j++) {
        const u = t + j * SLOT + SLOT / 2, w = W ? W(u) : {ta: atNow !== null ? atNow : 10, rh: null, pvW: 0};
        aus = aus ? w.ta > p.hgAnBis : w.ta >= p.hgAusAb;
        const ti = prev && tiMittel(prev.rooms) !== null ? tiMittel(prev.rooms) + st.dTsim : 22;
        const qRate = Math.max(0, modell.ua * (ti - w.ta) - modell.g), qBase = aus ? 0 : qRate * DTH, cop = clamp(cm.cop(w.ta), 1.5, 8);
        const sollFc = sollNow !== null && atNow !== null ? Math.max(p.minVlC, Math.ceil(sollNow + kurve(w.ta + p.kurveRandK, u) - kurve(atNow, t) - 1e-9)) : null;   // mit 1 K Sicherheitsabstand an der Rundungsgrenze
        const ueberKW = w.pvW / 1000 - p.grundlastKW - qBase / DTH / cop;                // PV-Überschuss (Grundlast angenommen, Wallbox nicht prognostiziert)
        if (ueberKW > 0) { ueber += ueberKW * DTH; } else { ueber = Math.max(0, ueber + ueberKW * DTH); }
        const socFc = Math.min(100, socSim + ueber / p.akkuKWh * 100);
        const base = basisBei((u - t) / HOUR);
        slots.push({t: u, ta: w.ta, aus: aus, qBase: qBase, cop: cop, sollFc: sollFc, takt: qRate < pminKW(w.ta, p), mKnapp: base.knapp, mWarm: base.warm,
            w: ueberKW > 0 && socFc >= p.socVoll ? 0 : 1, abtau: w.ta >= p.abtauAtMin && w.ta <= p.abtauAtMax && w.rh !== null && w.rh >= p.abtauRh, heizstab: w.ta < p.heizstabAtC});
    }
    const notPlus = !!(lage.n && lage.unter && lage.unter.m <= -p.verteilNotK);
    return {t: t, slots: slots, dT0: st.dTmod, s0: st.s, modell: {ua: modell.ua, krad: modell.ua * p.kRaum / (1 - p.kRaum), c: p.cPlan},
        keineRaeume: !p.ohneKomfort && (!lage.n || !lage.knapp), konflikt: !p.ohneKomfort && !!lage.konflikt, notPlus: notPlus, lage: lage, fcQuelle: fc ? 'Prognose ' + hm(fc.t) : 'keine Prognose (Fühler gehalten)'};
}

// ------------------------------------------------------------------ Fake-Uhr: Plan je Stunde, Ausführung je Slot (Sperren wie Regelwerk), Wirkung im Wahrheitsmodell
// wahr: {c, uaF (Faktor auf UA), kRaum, fVlProK, quietGewinn} – das „wahre“ Haus der Simulation (ungeprüft, daher Sensitivität)
function lauf(B, p, wahr) {
    p = Object.assign(defaults(), p || {});
    wahr = Object.assign({c: 3, uaF: 1, kRaum: p.kRaum, fVlProK: p.fVlProK, quietGewinn: p.quietGewinn}, wahr || {});
    const slots = B.slots, uaW = B.uaWahr * wahr.uaF, mW = {ua: uaW, krad: B.uaWahr * wahr.kRaum / (1 - wahr.kRaum), c: wahr.c}, phW = physik(mW);
    const copW = copModell(slots, Infinity);
    const st = {s: 0, dTsim: 0, dTmod: 0, bias: null, letzte: -1e15, letzteRicht: 0, cmd: {}, modell: null, copM: null, ziel: 0, plan: null};
    const cmds = [], proSlot = [], plaene = {}, sperren = {};
    let tagAkt = null;
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i], t = s.t, prev = slots[i - 1] || null, tag = ymd(t);
        if (tag !== tagAkt) { tagAkt = tag; st.modell = lerneModell(B.tage, tagStart(t), p); st.copM = copModell(slots, t); st.bias = biasProfil(slots, tagStart(t), p); }
        // Planung zur vollen Stunde (und beim ersten Slot)
        if (t % HOUR === 0 || i === 0) {
            const ctx = kontext(t, i, B, st, p), pl = planDP(ctx, p);
            st.ziel = pl.s[0]; st.plan = pl; st.ctx = ctx;
            if (new Date(t).getHours() === 0 || !plaene[tag]) { plaene[tag] = plaene[tag] || {t: t, s: pl.s.slice(0, 24), quelle: ctx.fcQuelle, ua: r3(st.modell.ua), g: r3(st.modell.g), modellQuelle: st.modell.quelle}; }
        }
        // Ausführung: nur mit Werten vom Ende des vorigen Slots (≤ t)
        const lage = prev ? raumLage(prev.rooms, st.dTsim, prev.kzRad, p) : {n: 0};
        const soll0 = prev && prev.soll !== null ? prev.soll : null;                 // Soll laut Kurve (das Ist lief mit Verschiebung 0); simuliert gilt soll0 + s
        const nTag = st.cmd[tag] || 0;
        let neu = st.s, grund = null;
        if (st.s < 0 && soll0 !== null && soll0 + st.s < p.minVlC) { neu = 0; grund = 'Soll erreicht 29 °C (Untergrenze)'; }
        else if (!p.ohneKomfort && st.s < 0 && lage.n && lage.knapp && lage.knapp.m < 0) { neu = 0; grund = 'Notfall: ' + lage.knapp.id + ' unter Minimum'; }
        else if (st.ziel !== st.s && prev) {
            const richt = Math.sign(st.ziel - st.s), seit = (t - st.letzte) / MIN;
            const not = lage.n && ((richt > 0 && lage.knapp && lage.knapp.m <= -p.notK) || (richt < 0 && lage.warm && lage.warm.m >= p.notK && lage.knapp && lage.knapp.m > 0));
            const sollSprung = slots[i - 2] && prev.soll !== null && slots[i - 2].soll !== null && prev.soll !== slots[i - 2].soll;
            let sperre = null;
            if (nTag >= p.proTag) { sperre = 'Tageslimit'; }
            else if (seit < p.haltMin) { sperre = 'Mindestabstand'; }
            else if (richt === -st.letzteRicht && seit < p.gegenMin && !not) { sperre = 'Gegenrichtung'; }
            else if (prev.defrost) { sperre = 'Abtauen'; }
            else if (prev.z === 'aus') { sperre = 'Heizgrenze-Aus'; }
            else if (sollSprung) { sperre = 'Kurve ruhig'; }
            else if (richt < 0 && prev.z === 'lauf' && prev.vl !== null && soll0 !== null && prev.vl > soll0 + st.s + p.laufMinusK) { sperre = 'Laufende (−1 K nur bei Vorlauf ≤ Soll)'; }
            else if (richt < 0 && prev.ta !== null && prev.ta < p.rlMinAtC && prev.rl !== null && prev.rl < p.rlMinC) { sperre = 'Rücklauf < 28 °C bei Kälte'; }
            else if (richt > 0 && prev.z === 'lauf' && prev.ta !== null && prev.ta < p.heizstabAtC && soll0 !== null && prev.vl !== null && soll0 + st.s + 1 - prev.vl >= p.heizstabRueckK) { sperre = 'Heizstab-Nähe'; }
            else if (richt > 0 && !not && prev.z === 'lauf' && prev.q === 0 && prev.vl !== null && soll0 !== null && prev.vl < soll0 + st.s + 1 - 1.0) { sperre = 'Hochlauf (Quiet 0, Vorlauf unter neuem Soll − 1 K)'; }
            if (!sperre) { neu = st.s + richt; grund = 'Plan'; } else { sperren[sperre] = (sperren[sperre] || 0) + 1; }
        }
        if (neu !== st.s) {
            cmds.push({t: t, von: st.s, nach: neu, grund: grund, knapp: lage.knapp ? lage.knapp.id + ' ' + de(lage.knapp.m, 1) + ' K' : '–'});
            st.letzteRicht = Math.sign(neu - st.s); st.letzte = t; st.s = neu; st.cmd[tag] = nTag + 1;
        }
        // Wirkung im Slot: Wahrheitsmodell (Haus der Simulation) und Planer-Modell (eigene Schätzung)
        const on = s.z !== 'aus', sEff = st.s;
        const rW = slotSchritt(st.dTsim, sEff, on, phW, mW);
        const mP = {ua: st.modell.ua, krad: st.modell.ua * p.kRaum / (1 - p.kRaum), c: p.cPlan}, rP = slotSchritt(st.dTmod, sEff, on, physik(mP), mP);
        const ta = s.ta !== null ? s.ta : (prev && prev.ta !== null ? prev.ta : 10), cop = clamp(copW.cop(ta), 1.5, 8);
        const takt = (s.th / DTH) < pminKW(ta, p) && s.z !== 'aus';
        const abtau = ta >= p.abtauAtMin && ta <= p.abtauAtMax && s.rh !== null && s.rh >= p.abtauRh;
        const dEheat = on ? rW.dQ / cop : 0, dEvl = on ? (s.elRun + rW.dQ / cop) * wahr.fVlProK * sEff : 0;
        const dEstart = on && takt ? rW.dQ / p.bandKWh * (p.startWh / 1000 + (abtau ? p.abtauStartKWh : 0)) : 0;
        const raum = uaW * rW.dTavg * DTH;                                            // Wärme, die der kühlere bzw. wärmere Raum weniger bzw. mehr verliert
        const frei = s.pv !== null && s.haus !== null && s.soc !== null && s.pv > s.haus && s.soc >= p.socVoll;
        proSlot.push({t: t, tag: tag, s: sEff, dT: rW.dT1, dTavg: rW.dTavg, dQ: rW.dQ, dE: dEheat + dEvl + dEstart, dEheat: dEheat, dEvl: dEvl, dEstart: dEstart, raumQ: raum, cop: cop, frei: frei});
        st.dTsim = rW.dT1; st.dTmod = rP.dT1;
    }
    return {proSlot: proSlot, cmds: cmds, plaene: plaene, sperren: sperren, wahr: wahr, uaW: uaW, kW: phW.k, copW: copW};
}

// ------------------------------------------------------------------ Auswertung je Tag
function auswerten(B, R, p) {
    p = Object.assign(defaults(), p || {});
    const slots = B.slots, T = {};
    slots.forEach((s, i) => {
        const x = R.proSlot[i], k = x.tag, d = T[k] = T[k] || {tag: k, dt: 0, el: 0, th: 0, kh: 0, khPlan: 0, dE: 0, dEvl: 0, dEstart: 0, dEheat: 0, raumQ: 0, copS: 0, copN: 0, dQ: 0,
            unterIst: 0, unterPlan: 0, neuUnter: 0, neuKh: 0, khUnterIst: 0, khUnterPlan: 0, el28: 0, laeufe28: 0, quietCmds: 0, minS: 0, plusS: 0, dEfrei: 0, ta: 0, taN: 0, dT0: i > 0 ? R.proSlot[i - 1].dT : 0, dT1: 0};
        d.dT1 = x.dT; d.dt += s.dt; d.el += s.el; d.th += s.th; d.dE += x.dE; d.dEvl += x.dEvl; d.dEstart += x.dEstart; d.dEheat += x.dEheat; d.raumQ += x.raumQ; d.dQ += x.dQ;
        if (x.frei) { d.dEfrei += x.dE; }
        if (s.ta !== null) { d.ta += s.ta * s.dt; d.taN += s.dt; }
        if (s.lauf > 0) { d.copS += x.cop * s.th; d.copN += s.th; }
        if (x.s < 0) { d.minS += s.dt; } if (x.s > 0) { d.plusS += s.dt; }
        const ti = tiMittel(s.rooms);
        if (ti !== null && s.ta !== null) { d.kh += Math.max(0, ti - s.ta) * s.dt / 60; d.khPlan += Math.max(0, ti + x.dT - s.ta) * s.dt / 60; }
        let uI = false, uP = false;
        s.rooms.forEach(([id, v, mn, mx, lueft]) => { if (lueft) { return; } if (v < mn) { uI = true; d.khUnterIst += (mn - v) * s.dt / 60; } if (v + x.dT < mn) { uP = true; d.khUnterPlan += (mn - v - x.dT) * s.dt / 60; if (v >= mn) { d.neuKh += (mn - v - x.dT) * s.dt / 60; } } });
        if (uI) { d.unterIst += s.dt; } if (uP) { d.unterPlan += s.dt; } if (uP && !uI) { d.neuUnter += s.dt; }
        // Hebel Quiet/Heizregelung: Minuten ≥ 28 Hz ab Laufminute 5 ohne Bedarf (kein Raum unter Minimum), über 3 °C
        const lage = raumLage(s.rooms, x.dT, s.kzRad, p);
        if (s.el28 > 0 && s.ta !== null && s.ta >= p.quietAtMin && !(lage.n && lage.knapp && lage.knapp.m < 0)) {
            d.el28 += s.el28;
            const prev = slots[i - 1]; if (!prev || !(prev.el28 > 0)) { d.laeufe28++; d.quietCmds += s.hc === 0 ? 1 : 2; }
        }
    });
    const cmdsTag = {}; R.cmds.forEach(c => { const k = ymd(c.t); cmdsTag[k] = (cmdsTag[k] || 0) + 1; });
    return Object.keys(T).sort().map(k => {
        const d = T[k], copMean = d.copN ? d.copS / d.copN : 4.8;
        const raum = d.raumQ / copMean, speicher = R.wahr.c * (d.dT1 - d.dT0) / copMean, zeit = d.dEheat - raum - speicher;   // Speicher: Wärme, die das Haus am Tagesende mehr (+) oder weniger (−) enthält
        const shiftCmds = cmdsTag[k] || 0, frei = Math.max(0, p.proTag - shiftCmds), qCmds = Math.min(d.quietCmds, frei);
        const qAnteil = d.quietCmds > 0 ? Math.min(1, qCmds / d.quietCmds) : 0, dQuiet = -d.el28 * R.wahr.quietGewinn * qAnteil;
        const dGes = d.dE + dQuiet;
        return {tag: k, voll: d.dt >= 0.9 * 1440, min: Math.round(d.dt), ta: d.taN ? d.ta / d.taN : null, el: d.el, th: d.th, cop: d.el > 0 ? d.th / d.el : null, kh: d.kh, khPlan: d.khPlan,
            kwhKh: d.kh > 0 ? d.el / d.kh : null, kwhKhPlan: d.khPlan > 0 ? (d.el + dGes) / d.khPlan : null,
            dE: dGes, proz: d.el > 0 ? 100 * dGes / d.el : null, raum: raum, vl: d.dEvl, zeit: zeit, speicher: speicher, start: d.dEstart, quiet: dQuiet, frei: d.dEfrei,
            shiftCmds: shiftCmds, quietCmds: qCmds, minusH: d.minS / 60, plusH: d.plusS / 60,
            unterIst: d.unterIst, unterPlan: d.unterPlan, neuUnter: d.neuUnter, neuKh: d.neuKh, khUnterIst: d.khUnterIst, khUnterPlan: d.khUnterPlan, laeufe28: d.laeufe28};
    });
}
function summe(tage, nurVoll) {
    const L = tage.filter(d => !nurVoll || d.voll), o = {tage: L.length};
    ['el', 'th', 'kh', 'khPlan', 'dE', 'raum', 'vl', 'zeit', 'speicher', 'start', 'quiet', 'frei', 'shiftCmds', 'quietCmds', 'unterIst', 'unterPlan', 'neuUnter', 'neuKh', 'khUnterIst', 'khUnterPlan', 'minusH', 'plusH'].forEach(k => { o[k] = L.reduce((a, d) => a + (d[k] || 0), 0); });
    o.proz = o.el > 0 ? 100 * o.dE / o.el : null; o.kwhKh = o.kh > 0 ? o.el / o.kh : null; o.kwhKhPlan = o.khPlan > 0 ? (o.el + o.dE) / o.khPlan : null;
    const pr = L.map(d => d.proz).filter(x => x !== null); o.prozMin = pr.length ? Math.min(...pr) : null; o.prozMax = pr.length ? Math.max(...pr) : null;
    const de_ = L.map(d => d.dE); o.dEmin = de_.length ? Math.min(...de_) : null; o.dEmax = de_.length ? Math.max(...de_) : null;
    return o;
}

// Schicht 1 im Rückblick: Tageswärme aus der Prognose von 00:00 (nur Vortage gelernt) – altes Modell (tbal 15) gegen neues (UA·(Ti − Ta) − g)
function schicht1(B, p) {
    const out = [];
    B.tage.filter(d => d.voll).forEach(d => {
        const t = d.t0, fc = prognoseBei(B.prog, t + 5 * MIN) || prognoseBei(B.prog, t + HOUR);
        const i0 = B.slots.findIndex(s => s.t >= t), prev = B.slots[i0 - 1];
        if (!fc || !prev) { return; }
        const bias = biasProfil(B.slots, t, p), W = wetterFn(fc, prev.ta, t, p, bias), W0 = wetterFn(fc, prev.ta, t, p, null), mN = lerneModell(B.tage, t, p), mA = altesModell(B.tage, B.slots, t), ti = tiMittel(prev.rooms) || 22;
        let qN = 0, qA = 0, aus = prev.z === 'aus', taS = 0, ta0S = 0;
        for (let j = 0; j < 96; j++) { const u = t + j * SLOT + SLOT / 2, w = W(u); taS += w.ta; ta0S += W0(u).ta; aus = aus ? w.ta > p.hgAnBis : w.ta >= p.hgAusAb; qN += Math.max(0, mN.ua * (ti - w.ta) - mN.g) * DTH; qA += mA.ua * Math.max(0, mA.tbal - W0(u).ta) * DTH; }
        // Mildstunden (Prognose 13–16 °C): Leistung je Modell bei 15 °C
        out.push({tag: d.tag, ist: d.th, neu: qN, alt: qA, taFc: taS / 96, taFc0: ta0S / 96, bias: !!bias, ta: d.ta, ua: mN.ua, g: mN.g, uaAlt: mA.ua, quelle: mN.quelle,
            neu15: Math.max(0, mN.ua * (ti - 15) - mN.g), alt15: 0});
    });
    return out;
}
// Läufe und Takt (Schicht 3: gibt es überhaupt eine Lage für „Läufe lang halten“?)
function laeufe(B) {
    const R = []; let a = null;
    B.slots.forEach(s => { if (s.lauf > 0) { if (!a) { a = {t: s.t, min: 0}; } a.min += s.lauf; } else if (a) { a.ende = s.t; R.push(a); a = null; } });
    return {n: R.length, kurz: R.filter(r => r.min < 60).length, median: R.length ? R.map(r => r.min).sort((x, y) => x - y)[Math.floor(R.length / 2)] : null};
}

// ------------------------------------------------------------------ Gesamtlauf mit Sensitivität
function vorbereiten(D, p) {
    p = Object.assign(defaults(), p || {});
    const slots = slotsBauen(D, p), tage = tageBauen(slots), prog = prognosenBauen(D);
    const alle = lerneModell(tage, Infinity, Object.assign({}, p, {priorTage: 0.01}));   // „wahres“ UA der Simulation: Steigung über alle vollständigen Tage (kein Planwissen)
    return {slots: slots, tage: tage, prog: prog, uaWahr: alle.ua, gWahr: alle.g, nTage: alle.n};
}
function analyse(B, opts) {
    opts = opts || {};
    const p = Object.assign(defaults(), opts.p || {});
    const MODI = [{key: 'spar', name: 'gleicher Komfort (nur −1 K/0)', p: {nurMinus: true}}, {key: 'voll', name: 'mit Komfort-Reparatur (−1/0/+1 K)', p: {nurMinus: false}}];
    const res = {modi: {}, sens: [], s1: schicht1(B, p), laeufe: laeufe(B), uaWahr: B.uaWahr, gWahr: B.gWahr, nTage: B.nTage, prog: B.prog.quelle};
    MODI.forEach(m => {
        const pm = Object.assign({}, p, m.p), r = lauf(B, pm, {}), t = auswerten(B, r, pm);
        res.modi[m.key] = {name: m.name, tage: t, sum: summe(t, true), sumAlle: summe(t, false), cmds: r.cmds, plaene: r.plaene, sperren: r.sperren, kW: r.kW, uaW: r.uaW, cop: r.copW.pts};
    });
    { const pg = Object.assign({}, p, {nurMinus: true, ohneKomfort: true}), r = lauf(B, pg, {}), t = auswerten(B, r, pg); res.grenze = summe(t, true); res.grenzeTage = t; }
    if (!opts.schnell) {
        const varianten = [];
        [1.5, 3, 6].forEach(c => { [0.7, 1, 1.3].forEach(f => { varianten.push({name: 'C ' + de(c, 1) + ' kWh/K, UA ' + (f === 1 ? '±0' : (f > 1 ? '+30' : '−30')) + ' %', w: {c: c, uaF: f}}); }); });
        varianten.push({name: 'k Raum 0,3 K/K (C 3)', w: {kRaum: 0.3}}, {name: 'k Raum 0,7 K/K (C 3)', w: {kRaum: 0.7}},
            {name: 'Vorlauf 3 %/K (C 3)', w: {fVlProK: 0.03}}, {name: 'Vorlauf 4 %/K (C 3)', w: {fVlProK: 0.04}},
            {name: 'Quiet 0 % (C 3)', w: {quietGewinn: 0}}, {name: 'Quiet 10 % (C 3, roh)', w: {quietGewinn: 0.10}},
            {name: 'Planer: −1 K im Lauf bis Vorlauf ≤ Soll + 1 K (RE-1)', w: {}, p: {laufMinusK: 1}}, {name: 'Planer: ohne Tagesgang Fühler − OWM', w: {}, p: {biasTage: 0}},
            {name: 'Planer: Reserve 0,5 K statt 0,3 K', w: {}, p: {reserveK: 0.5}});
        varianten.forEach(v => {
            const e = {name: v.name, w: v.w};
            MODI.forEach(m => { const pm = Object.assign({}, p, m.p, v.p || {}), r = lauf(B, pm, v.w), t = auswerten(B, r, pm); e[m.key] = summe(t, true); });
            res.sens.push(e);
        });
    }
    return res;
}

// ------------------------------------------------------------------ Bericht (Markdown)
function markdown(A, B) {
    const L = [], SP = A.modi.spar, VO = A.modi.voll, S = SP.sum, SV = VO.sum;
    const tg = k => dm(new Date(k + 'T12:00:00').getTime());
    L.push('<!-- PLAN-ALGO -->');
    L.push('*Erzeugt mit `node tools/plan_algo.js <Datenordner> --md` (Fake-Uhr, 15-min-Raster, Neuplanung jede volle Stunde, Ausführung mit den Sperren des Regelwerks). Daten: ' + dm(B.slots[0].t) + ' ' + hm(B.slots[0].t) + ' – ' + dm(B.slots[B.slots.length - 1].t) + ' ' + hm(B.slots[B.slots.length - 1].t) + ', ' + B.slots.length + ' Slots. Prognosen: ' + A.prog + '. Haus der Simulation (Basis): C 3 kWh/K, UA ' + de(A.uaWahr * 1000, 0) + ' W/K (Steigung aus ' + A.nTage + ' vollen Tagen), k ' + de(SP.kW, 2) + ' K Raum je K Vorlauf. Ein zweiter Lauf ist bit-identisch (Test).*');
    L.push('');
    L.push('### (a) Ist je Tag und (b–d) Plan');
    L.push('');
    L.push('Spalten „gleicher Komfort“: Plan darf nur −1 K oder 0 (keine Komfort-Reparatur, kein Vorheizen). Spalten „voll“: −1/0/+1 K, +1 K bei Raumbedarf (Komfort vor Energie) und wo es sich rechnet.');
    L.push('');
    L.push('| Tag | AT Ø | Ist kWh el | Ist kWh th | COP | Kh | Ist Wh/Kh | gleicher Komfort ΔkWh (%) | −1 K h | Befehle | Min. unter Min. Ist → Plan (neu, K·h neu) | voll ΔkWh (%) | +1 K h | Befehle | Min. unter Min. voll |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    SP.tage.forEach((d, i) => {
        const v = VO.tage[i];
        L.push('| ' + tg(d.tag) + (d.voll ? '' : ' (Teil, ' + d.min + ' min)') + ' | ' + de(d.ta, 1) + ' | ' + de(d.el, 2) + ' | ' + de(d.th, 1) + ' | ' + de(d.cop, 2) + ' | ' + de(d.kh, 0) + ' | ' + de(d.kwhKh * 1000, 1) + ' | ' + pz(d.dE, 2) + ' (' + pz(d.proz, 1) + ') | ' + de(d.minusH, 1) + ' | ' + (d.shiftCmds + d.quietCmds) + ' | ' + Math.round(d.unterIst) + ' → ' + Math.round(d.unterPlan) + ' (' + Math.round(d.neuUnter) + ', ' + de(d.neuKh, 2) + ') | ' + pz(v.dE, 2) + ' (' + pz(v.proz, 1) + ') | ' + de(v.plusH, 1) + ' | ' + (v.shiftCmds + v.quietCmds) + ' | ' + Math.round(v.unterPlan) + ' |');
    });
    L.push('| **volle Tage (' + S.tage + ')** | | **' + de(S.el, 2) + '** | **' + de(S.th, 1) + '** | | **' + de(S.kh, 0) + '** | **' + de(S.kwhKh * 1000, 1) + '** | **' + pz(S.dE, 2) + ' (' + pz(S.proz, 1) + ')** | ' + de(S.minusH, 1) + ' | ' + (S.shiftCmds + S.quietCmds) + ' | ' + Math.round(S.unterIst) + ' → ' + Math.round(S.unterPlan) + ' (' + Math.round(S.neuUnter) + ', ' + de(S.neuKh, 2) + ') | **' + pz(SV.dE, 2) + ' (' + pz(SV.proz, 1) + ')** | ' + de(SV.plusH, 1) + ' | ' + (SV.shiftCmds + SV.quietCmds) + ' | ' + Math.round(SV.unterPlan) + ' |');
    L.push('');
    if (A.grenze) { L.push('Einordnung „Obergrenze“ (Räume ignoriert, −1 K, wann immer der Soll ≥ 30 °C es erlaubt): ' + pz(A.grenze.dE, 2) + ' kWh (' + pz(A.grenze.proz, 1) + ' %), ' + de(A.grenze.minusH, 0) + ' h mit −1 K, Minuten unter Minimum ' + Math.round(A.grenze.unterPlan) + ' (neu ' + Math.round(A.grenze.neuUnter) + ', ' + de(A.grenze.neuKh, 1) + ' K·h).'); L.push(''); }
    L.push('Je voller Tag, gleicher Komfort: ' + pz(S.dEmin, 2) + ' … ' + pz(S.dEmax, 2) + ' kWh (' + pz(S.prozMin, 1) + ' … ' + pz(S.prozMax, 1) + ' %); voll: ' + pz(SV.dEmin, 2) + ' … ' + pz(SV.dEmax, 2) + ' kWh (' + pz(SV.prozMin, 1) + ' … ' + pz(SV.prozMax, 1) + ' %). Negativ = weniger Strom. Kelvinstunden unter Minimum (alle Räume, ohne Lüften): Ist ' + de(S.khUnterIst, 1) + ', gleicher Komfort ' + de(S.khUnterPlan, 1) + ', voll ' + de(SV.khUnterPlan, 1) + ' K·h. Kennzahl kWh je Gradstunde: Ist ' + de(S.kwhKh * 1000, 1) + ' Wh/Kh, gleicher Komfort ' + de(S.kwhKhPlan * 1000, 1) + ', voll ' + de(SV.kwhKhPlan * 1000, 1) + ' Wh/Kh.');
    L.push('');
    L.push('### Hebel getrennt (volle Tage, kWh el; negativ = gespart)');
    L.push('');
    L.push('| Tag | Raum (kühlere Räume) | Vorlauf (COP) | Zeit (COP der Stunde) | Speicher (Haus am Tagesende) | Starts | Quiet/HC | Summe | davon im PV-Überschuss (Akku ≥ 95 %) | voll: Raum / Vorlauf / Zeit / Speicher / Summe |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    SP.tage.forEach((d, i) => { if (!d.voll) { return; } const v = VO.tage[i]; L.push('| ' + tg(d.tag) + ' | ' + pz(d.raum, 3) + ' | ' + pz(d.vl, 3) + ' | ' + pz(d.zeit, 3) + ' | ' + pz(d.speicher, 3) + ' | ' + pz(d.start, 3) + ' | ' + pz(d.quiet, 3) + ' | ' + pz(d.dE, 3) + ' | ' + pz(d.frei, 3) + ' | ' + pz(v.raum, 2) + ' / ' + pz(v.vl, 2) + ' / ' + pz(v.zeit, 2) + ' / ' + pz(v.speicher, 2) + ' / ' + pz(v.dE, 2) + ' |'); });
    L.push('| **Summe** | **' + pz(S.raum, 2) + '** | **' + pz(S.vl, 2) + '** | **' + pz(S.zeit, 2) + '** | **' + pz(S.speicher, 2) + '** | **' + pz(S.start, 3) + '** | **' + pz(S.quiet, 3) + '** | **' + pz(S.dE, 2) + '** | ' + pz(S.frei, 3) + ' | ' + pz(SV.raum, 2) + ' / ' + pz(SV.vl, 2) + ' / ' + pz(SV.zeit, 2) + ' / ' + pz(SV.speicher, 2) + ' / ' + pz(SV.dE, 2) + ' |');
    L.push('');
    if (A.sens.length) {
        L.push('### Sensitivität (Planer: C 3 kWh/K, UA aus den Vortagen, k 0,5; variiert wird das Haus der Simulation, in den Zeilen „Planer:“ eine Einstellung des Planers)');
        L.push('');
        L.push('| Variante | gleicher Komfort: ΔkWh (%) | je Tag | Min. unter Min. (neu) | voll: ΔkWh (%) | je Tag | Min. unter Min. |');
        L.push('|---|---|---|---|---|---|---|');
        A.sens.forEach(v => { const a = v.spar, b = v.voll; L.push('| ' + v.name + ' | ' + pz(a.dE, 2) + ' (' + pz(a.proz, 1) + ') | ' + pz(a.prozMin, 1) + ' … ' + pz(a.prozMax, 1) + ' % | ' + Math.round(a.unterPlan) + ' (' + Math.round(a.neuUnter) + ') | ' + pz(b.dE, 2) + ' (' + pz(b.proz, 1) + ') | ' + pz(b.prozMin, 1) + ' … ' + pz(b.prozMax, 1) + ' % | ' + Math.round(b.unterPlan) + ' |'); });
        L.push('');
    }
    L.push('### Schicht 1: Tageswärme aus der Prognose von 00:00 (gelernt nur aus Vortagen)');
    L.push('');
    L.push('| Tag | AT Prognose verankert / mit Tagesgang Fühler−OWM / Ist | Ist kWh th | altes Modell (tbal 15) | neues Modell UA·(Ti − Ta) − g | UA / g neu | Leistung bei 15 °C alt / neu |');
    L.push('|---|---|---|---|---|---|---|');
    A.s1.forEach(x => { L.push('| ' + tg(x.tag) + ' | ' + de(x.taFc0, 1) + ' / ' + (x.bias ? de(x.taFc, 1) : '–') + ' / ' + de(x.ta, 1) + ' | ' + de(x.ist, 1) + ' | ' + de(x.alt, 1) + ' (' + pz(100 * (x.alt / x.ist - 1), 0) + ' %) | ' + de(x.neu, 1) + ' (' + pz(100 * (x.neu / x.ist - 1), 0) + ' %) | ' + de(x.ua * 1000, 0) + ' W/K / ' + de(x.g, 2) + ' kW (' + x.quelle + ') | 0 / ' + de(x.neu15, 2) + ' kW |'); });
    const mae = k => A.s1.length ? A.s1.reduce((a, x) => a + Math.abs(x[k] - x.ist), 0) / A.s1.length : null;
    L.push('');
    L.push('Mittlerer Tagesfehler: altes Modell ' + de(mae('alt'), 1) + ' kWh th, neues Modell ' + de(mae('neu'), 1) + ' kWh th.');
    L.push('');
    L.push('### Läufe (Schicht 3)');
    L.push('');
    L.push(A.laeufe.n + ' Läufe im 15-min-Raster, davon ' + A.laeufe.kurz + ' unter 60 min, Median ' + Math.round(A.laeufe.median) + ' min. COP-Bänder der Simulation (gemessen, +80 W): ' + SP.cop.map(x => de(x[0], 1) + ' °C ' + de(x[1], 2)).join(' · ') + '.');
    L.push('');
    [['spar', SP], ['voll', VO]].forEach(([k, M]) => {
        L.push('### Befehle des Plans: ' + M.name);
        L.push('');
        L.push(M.cmds.length ? M.cmds.map(c => dm(c.t) + ' ' + hm(c.t) + ' ' + pz(c.von, 0) + '→' + pz(c.nach, 0) + ' (' + c.grund + '; knappster Raum ' + c.knapp + ')').join(' · ') : 'keine');
        L.push('');
        L.push('Vom Plan gewollt, von der Ausführung zurückgehalten (Slots à 15 min): ' + (Object.keys(M.sperren).length ? Object.keys(M.sperren).sort().map(k => k + ' ' + M.sperren[k]).join(' · ') : 'nie') + '.');
        L.push('');
        L.push('Plan von 00:00 je Tag (Verschiebung je Stunde 0–23 Uhr; − = −1 K, 0, + = +1 K):');
        L.push('');
        Object.keys(M.plaene).sort().forEach(t => { const x = M.plaene[t]; L.push('- ' + dm(x.t) + ' ' + hm(x.t) + ': `' + x.s.map(v => v < 0 ? '−' : (v > 0 ? '+' : '0')).join('') + '` (' + x.quelle + '; UA ' + de(x.ua * 1000, 0) + ' W/K, g ' + de(x.g, 2) + ' kW, ' + x.modellQuelle + ')'); });
        L.push('');
    });
    L.push('<!-- /PLAN-ALGO -->');
    return L.join('\n');
}

function main() {
    const args = process.argv.slice(2), dir = args.find(a => !a.startsWith('--'));
    if (!dir) { console.error('Usage: node tools/plan_algo.js <Datenordner> [--md [Datei]] [--json Datei] [--schnell]'); process.exit(2); }
    const D = ladeDaten(dir), B = vorbereiten(D), A = analyse(B, {schnell: args.includes('--schnell')});
    const iMd = args.indexOf('--md'), iJs = args.indexOf('--json');
    if (iJs >= 0 && args[iJs + 1]) { fs.writeFileSync(args[iJs + 1], JSON.stringify(A, null, 1)); }
    if (iMd >= 0) {
        const md = markdown(A, B), ziel = args[iMd + 1] && !args[iMd + 1].startsWith('--') ? args[iMd + 1] : null;
        if (!ziel) { process.stdout.write(md + '\n'); return; }
        const alt = fs.existsSync(ziel) ? fs.readFileSync(ziel, 'utf8') : '';
        const neu = alt.includes('<!-- PLAN-ALGO -->') && alt.includes('<!-- /PLAN-ALGO -->') ? alt.replace(/<!-- PLAN-ALGO -->[\s\S]*<!-- \/PLAN-ALGO -->/, () => md) : md + '\n';
        fs.writeFileSync(ziel, neu); console.log('geschrieben: ' + ziel); return;
    }
    ['spar', 'voll'].forEach(k => {
        const M = A.modi[k], S = M.sum;
        console.log(M.name + ' – volle Tage ' + S.tage + ': Ist ' + de(S.el, 2) + ' kWh el, Plan ' + pz(S.dE, 2) + ' kWh (' + pz(S.proz, 1) + ' %), je Tag ' + pz(S.prozMin, 1) + ' … ' + pz(S.prozMax, 1) + ' %');
        console.log('  Hebel: Raum ' + pz(S.raum, 2) + ' · Vorlauf ' + pz(S.vl, 2) + ' · Zeit ' + pz(S.zeit, 2) + ' · Speicher ' + pz(S.speicher, 2) + ' · Starts ' + pz(S.start, 3) + ' · Quiet ' + pz(S.quiet, 3) + ' | Befehle ' + (S.shiftCmds + S.quietCmds) + ' | Minuten unter Minimum Ist ' + Math.round(S.unterIst) + ' → ' + Math.round(S.unterPlan) + ' (neu ' + Math.round(S.neuUnter) + ', ' + de(S.neuKh, 2) + ' K·h)');
    });
    A.sens.forEach(v => console.log('  ' + v.name.padEnd(32) + 'gleich ' + pz(v.spar.dE, 2) + ' kWh (' + pz(v.spar.proz, 1) + ' %) · voll ' + pz(v.voll.dE, 2) + ' kWh (' + pz(v.voll.proz, 1) + ' %)'));
}

module.exports = {PARAM: PARAM, defaults: defaults, readMulti: readMulti, ladeDaten: ladeDaten, slotsBauen: slotsBauen, prognosenBauen: prognosenBauen, prognoseBei: prognoseBei,
    wetterFn: wetterFn, biasProfil: biasProfil, tageBauen: tageBauen, lerneModell: lerneModell, altesModell: altesModell, copModell: copModell, raumLage: raumLage, physik: physik, slotSchritt: slotSchritt,
    planDP: planDP, erlaubt: erlaubt, kontext: kontext, lauf: lauf, auswerten: auswerten, summe: summe, schicht1: schicht1, vorbereiten: vorbereiten, analyse: analyse, markdown: markdown,
    kurve: kurve, pminKW: pminKW, tiMittel: tiMittel, raumVerlauf: raumVerlauf, laeufe: laeufe};
if (require.main === module) { main(); }

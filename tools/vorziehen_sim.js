// Offline-Simulation „Vorziehen +1 K am Nachmittag bei PV-Überschuss“ (Auftrag vorziehen-sim, 20.10.2026).
// Geschlossener Lauf Anlagen-Zwilling (tools/wp_zwilling.js) + einfaches Akku-/Strombilanz-Modell über die echten Tage (Wetter, PV, Hauslast aus den Protokollen),
// Fake-Uhr, Start im gemessenen Zustand. Die Entscheidung „Vorziehen“ sieht nur die Prognose-Schnappschüsse, die zum Entscheidungszeitpunkt schon vorlagen.
// Varianten:  A „heute“ (Verschiebung 0, Quiet 3, Efficiency) · B „Vorziehen“ (+1 K im Nachmittagsfenster, danach Nacht −1 K) · C „nur −1 K“ (Raumeinfluss) · D = C + B.
//             A0 = Zwilling mit den gemessenen Einstellungen (Soll, Quiet, Heizregelung) – nur zur Validierung gegen die Messung.
// Akku: (1) „Eigenverbrauch“ (gierig: Überschuss lädt, Defizit entlädt bis zur Untergrenze, Rest Netz) im geschlossenen Lauf;
//       (2) „DESS-nah“ (gemessener Akku-/Netzpfad + Differenz der WP-Leistung, Abschnitt dessPfad) als zweite Lesart.
// Reine Rechenfunktionen + Datei-Lader. Schaltet nichts, sendet nichts, schreibt nur die per CLI genannten Ausgabedateien.
// Usage: node tools/vorziehen_sim.js <Datenordner> <wp_params.json> [--von 2026-10-08] [--bis 2026-10-19] [--md Datei] [--json Datei] [--svg Datei] [--schnell]
'use strict';
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const fs = require('fs');
const path = require('path');
const Z = require('./wp_zwilling.js');
const T = require('./wp_training.js');

const MIN = 60000, HOUR = 60 * MIN, DTH = 1 / 60;
const num = x => { if (x === undefined || x === null || x === '') { return null; } const v = Number(x); return isFinite(v) ? v : null; };
const pad = x => String(x).padStart(2, '0');
const ymd = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const rd = (x, k) => x === null || x === undefined || !isFinite(x) ? null : Math.round(x * Math.pow(10, k)) / Math.pow(10, k);
const mean = a => { const b = a.filter(x => x !== null && x !== undefined && isFinite(x)); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; };
const median = a => { const b = a.filter(x => x !== null && isFinite(x)).sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : null; };

// ------------------------------------------------------------------ Parameter (Herkunft: N = Nutzer/Einstellung, V = VRM dynamic-ess-settings, M = Messung, A = Annahme)
const AKKU = {
    kapKWh: 43,          // V: Akku 43 kWh
    pMaxKW: 12,          // V: 12 kW Lade-/Entladeleistung
    etaLaden: 0.95,      // A: Wirkungsgrad je Richtung (Start 0,95; Validierung unten)
    etaEntladen: 0.95,
    socMinPct: 10,       // M: SOC hört nachts bei 10 % auf zu fallen (19.10. 02:00–07:00 10 %, 9,9 % um 07:00; Minimum-SOC von ESS/Dynamic ESS)
    socMaxPct: 100
};
const PREIS = {kaufNiedrig: 0.21, niedrigVonH: 0, niedrigBisH: 5, kauf: 0.31, verkauf: 0.06, verkaufVonH: 6, verkaufBisH: 22, verschleiss: 0.01};   // V: dynamic-ess-settings (vrm-analyse/BERICHT.md)
// Raumbänder live (config.json auf der NAS, 17.10.2026)
const RAEUME = [{id: 'ki_oben', name: 'Kinderzimmer oben', min: 22.5, max: 24}, {id: 'ki_unten', name: 'Kinderzimmer unten', min: 20, max: 22},
                {id: 'schlaf', name: 'Schlafzimmer', min: 20, max: 22}, {id: 'wohn', name: 'Wohnzimmer', min: 22, max: 24.5}];
const POLITIK = {
    fensterVonH: 12, fensterBisH: 17,   // Auftrag: Nachmittagsfenster (Sensitivität 13–16)
    ohneA: false, ohneB: false, ohneC: false, ohneNacht: false, nachtImmer: false,   // nachtImmer: nach dem Vorziehen Nacht −1 K ohne Raumbedingung (Potenzial)
    startPauseMin: 20,   // +1 K in der Pause ist ein Startbefehl: erst nach 20 min Pause (raum_offset startPauseMin); im Heizgrenze-Aus nie
    startBeiAnhebung: true,   // Zwilling: jede Anhebung der Verschiebung in der Pause startet sofort (F 3969412, 4131809; M 10.10./11.10.); false = Zwilling wie trainiert   // Bedingungen (a)/(b)/(c) abschalten (nur Sensitivität/Potenzial: „erzwungen“)
    atDiffK: 4,          // (b) Prognose-AT im Fenster mindestens so viel über der Prognose für die folgende Nacht 00–06 Uhr
    pExtraKW: 0.5,       // (a) PV-Überschuss (Prognose PV − Prognose Verbrauch) je Fensterstunde mindestens die zusätzliche WP-Leistung (Mindestlast ~0,45 kW el)
    aModus: 'voll',      // (a) 'voll': zusätzlich muss der Akku laut Modell ohnehin voll werden (SOC jetzt + Prognose-Überschuss bis sonnenEndeH ≥ vollAnteil); 'deckt': nur Überschuss
    vollAnteil: 0.95, sonnenEndeH: 19,
    grundlastKW: 1.0,    // A: Verbrauchsprognose, falls der Schnappschuss keine VRM-Verbrauchsprognose trägt
    nachtBisH: 6,        // B: Nacht −1 K bis 06 Uhr
    stabilMin: 60,       // Raumeinfluss: Überschuss (alle Räume über der Bandmitte) 60 min am Stück (raum_offset stabilMin)
    rueckK: 0.3,         // Rückweg −1 K: ein Raum unter Minimum + 0,3 K (Auftrag)
    sperreMin: 120,      // nach dem Rückweg 120 min kein neues −1 K (raum_offset pauseMin)
    minVlC: 29           // N: Soll-Vorlauf nie unter 29 °C
};
const WINTER_BASIS_K = 5;   // A: Grundverschiebung im Winter-Szenario, damit das Zwilling-Haus bei Quiet 0/Comfort ~21 °C hält (ohne: 18 °C, Heizkurve im Zwilling bei Frost zu niedrig – extrapoliert)
const VARIANTEN = {N: 'N „nur Nachtabsenkung“: −1 K 17–06 Uhr ohne Raumbedingung (Referenz für das Potenzial)', A: 'A „heute“: Verschiebung 0, Quiet 3, Efficiency', B: 'B „Vorziehen“: +1 K im Fenster bei Prognose-Überschuss, danach Nacht −1 K', C: 'C „nur −1 K“: Raumeinfluss −1 K / zurück', D: 'D = C + B'};

// ------------------------------------------------------------------ Preise
function preisKauf(t) { const h = new Date(t).getHours(); return h >= PREIS.niedrigVonH && h < PREIS.niedrigBisH ? PREIS.kaufNiedrig : PREIS.kauf; }
function preisVerkauf(t) { const h = new Date(t).getHours(); return h >= PREIS.verkaufVonH && h < PREIS.verkaufBisH ? PREIS.verkauf : 0; }
function istNacht(t) { const h = new Date(t).getHours(); return h < PREIS.verkaufVonH || h >= PREIS.verkaufBisH; }

// ------------------------------------------------------------------ Akku „Eigenverbrauch“ (gierig), AC-seitige Leistungen in kW, SOC in kWh (Zelle)
// Überschuss lädt (bis pMax und Obergrenze, Ladeverlust 1 − etaLaden), Rest wird eingespeist; Defizit entlädt (bis pMax und Untergrenze), Rest Netzbezug.
// Bilanz je Schritt: pv + bezug + entladen = last + laden + einspeisung; SOC: +laden·etaLaden·dt − entladen/etaEntladen·dt.
function akkuSchritt(soc, pvKW, lastKW, dtH, A) {
    const lo = A.kapKWh * A.socMinPct / 100, hi = A.kapKWh * A.socMaxPct / 100, net = lastKW - pvKW;
    let laden = 0, entladen = 0, bezug = 0, einsp = 0;
    if (net < 0) { const s = -net; laden = Math.max(0, Math.min(s, A.pMaxKW, (hi - soc) / (A.etaLaden * dtH))); einsp = s - laden; soc += laden * A.etaLaden * dtH; }
    else { entladen = Math.max(0, Math.min(net, A.pMaxKW, (soc - lo) * A.etaEntladen / dtH)); bezug = net - entladen; soc -= entladen / A.etaEntladen * dtH; }
    return {soc: soc, laden: laden, entladen: entladen, entl: entladen, bezug: bezug, einsp: einsp, verlust: (laden * (1 - A.etaLaden) + entladen * (1 / A.etaEntladen - 1)) * dtH};
}

// ------------------------------------------------------------------ Akku „DESS-nah“: gemessener Pfad + Differenz der WP-Leistung (dP = P_Variante − P_gemessen, kW)
// Dynamic ESS führt den Akku nach Fahrplan (Einspeisen trotz nicht vollem Akku, Halten, Entladen ins Netz). Lesart: Wo der Netzpunkt gemessen ≈ 0 ist (Eigenverbrauch),
// gleicht der Akku die Differenz aus; wo das Netz gemessen aktiv tauscht (|Netz| > netzSchwelleKW) oder der Akku an der Untergrenze steht, gleicht das Netz aus
// (weniger Einspeisung bzw. mehr Bezug). Die Akku-Differenz dSoc trägt sich fort und wird an den Grenzen des gemessenen SOC in Netz umgebucht.
function dessSchritt(st, mess, dP, dtH, A) {
    const lo = A.kapKWh * A.socMinPct / 100, hi = A.kapKWh * A.socMaxPct / 100, socM = mess.soc / 100 * A.kapKWh;
    let bezug = Math.max(0, mess.netz), einsp = Math.max(0, -mess.netz), entl = Math.max(0, -mess.batt), dSoc = st.dSoc;
    const amBoden = mess.soc <= A.socMinPct + 0.6, netzAktiv = mess.frisch && Math.abs(mess.netz) > (A.netzSchwelleKW || 0.3);
    if (netzAktiv || amBoden) { if (dP > 0) { const w = Math.min(dP, einsp); einsp -= w; bezug += dP - w; } else { const w = Math.min(-dP, bezug); bezug -= w; einsp += -dP - w; } }
    else if (dP > 0) { const moegl = Math.max(0, (socM + dSoc - lo) * A.etaEntladen / dtH), a = Math.min(dP, moegl); dSoc -= a / A.etaEntladen * dtH; entl += a; bezug += dP - a; }
    else { const s = -dP, moegl = Math.max(0, (hi - socM - dSoc) / (A.etaLaden * dtH)), c = Math.min(s, moegl); dSoc += c * A.etaLaden * dtH; entl -= Math.min(entl, c); einsp += s - c; }
    // Fortgetragene Differenz an den Grenzen des gemessenen Pfads: voller Akku nimmt weniger auf (→ Einspeisung), leerer gibt weniger ab (→ Bezug)
    if (socM + dSoc > hi) { const e = socM + dSoc - hi; dSoc -= e; einsp += e / A.etaLaden / dtH; }
    if (socM + dSoc < lo && dSoc < 0) { const e = Math.min(-dSoc, lo - socM - dSoc); dSoc += e; bezug += e * A.etaEntladen / dtH; entl = Math.max(0, entl - e * A.etaEntladen / dtH); }
    // Carry-over: negativer Rest lädt aus gemessener Einspeisung bei vollem Akku nach; positiver Rest deckt gemessenen Bezug am Boden
    if (dSoc < 0 && einsp > 0 && mess.soc >= A.socMaxPct - 1) { const c = Math.min(einsp, A.pMaxKW, -dSoc / A.etaLaden / dtH); dSoc += c * A.etaLaden * dtH; einsp -= c; }
    if (dSoc > 0 && bezug > 0 && amBoden) { const d = Math.min(bezug, A.pMaxKW, dSoc * A.etaEntladen / dtH); dSoc -= d / A.etaEntladen * dtH; bezug -= d; entl += d; }
    return {st: {dSoc: dSoc}, soc: socM + dSoc, bezug: bezug, einsp: einsp, entl: entl};
}

// ------------------------------------------------------------------ Prognose-Schnappschüsse (nur Vergangenheit)
// F: Liste {t (s), owm [[t_ms, temp, rh, clouds, wind]], pv [[t_s, W, dauer_s]], cons [[t_s, Wh je h]]}, nach t sortiert.
function snapshotVor(F, t) {                                                     // letzter Schnappschuss mit Zeitstempel ≤ t (kein Blick in die Zukunft)
    let lo = 0, hi = F.length - 1, r = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (F[m].t * 1000 <= t) { r = F[m]; lo = m + 1; } else { hi = m - 1; } }
    return r;
}
function atFc(snap, tms) {
    const o = snap && snap.owm; if (!o || !o.length) { return null; }
    if (tms < o[0][0] || tms > o[o.length - 1][0]) { return null; }
    for (let i = 1; i < o.length; i++) { if (tms <= o[i][0]) { const a = o[i - 1], b = o[i]; return a[1] + (b[1] - a[1]) * (tms - a[0]) / Math.max(1, b[0] - a[0]); } }
    return o[o.length - 1][1];
}
function pvFc(snap, tms) {                                                       // kW (Mittel über das Intervall, das tms enthält)
    const p = snap && snap.pv; if (!p) { return null; }
    const s = tms / 1000; for (let i = 0; i < p.length; i++) { const d = p[i][2] || 3600; if (s >= p[i][0] && s < p[i][0] + d) { return p[i][1] / 1000; } }
    return null;
}
function consFc(snap, tms, pol) {
    const c = snap && snap.cons; if (c) { const s = tms / 1000; for (let i = 0; i < c.length; i++) { if (s >= c[i][0] && s < c[i][0] + 3600) { return c[i][1] / 1000; } } }
    return pol.grundlastKW;
}
function stundeBei(t, h) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0).getTime(); }
// Entscheidung (a)/(b) zum Zeitpunkt c.t; c = {t, F, socKWh, akku}
function entscheidung(c, pol) {
    const snap = snapshotVor(c.F, c.t);
    if (!snap) { return {ok: false, grund: 'keine Prognose', snapT: null}; }
    const ende = stundeBei(c.t, pol.fensterBisH), stunden = [];
    for (let x = Math.floor(c.t / HOUR) * HOUR; x < ende; x += HOUR) { stunden.push(x); }
    const ueb = x => { const p = pvFc(snap, x + HOUR / 2); return p === null ? null : p - consFc(snap, x + HOUR / 2, pol); };
    const ue = stunden.map(ueb), deckt = ue.length > 0 && ue.every(u => u !== null && u >= pol.pExtraKW);
    let voll = true, socProg = null;
    if (pol.aModus === 'voll') {
        let e = c.socKWh; const se = stundeBei(c.t, pol.sonnenEndeH);
        for (let x = Math.floor(c.t / HOUR) * HOUR; x < se; x += HOUR) { const u = ueb(x); e += Math.max(0, u || 0) * c.akku.etaLaden; }
        socProg = e / c.akku.kapKWh; voll = socProg >= pol.vollAnteil;
    }
    const atF = mean(stunden.map(x => atFc(snap, x + HOUR / 2))), n0 = stundeBei(c.t + 24 * HOUR, 0), atN = mean([0, 1, 2, 3, 4, 5].map(k => atFc(snap, n0 + k * HOUR + HOUR / 2)));
    const b = atF !== null && atN !== null && atF - atN >= pol.atDiffK;
    return {ok: (deckt && voll || !!pol.ohneA) && (b || !!pol.ohneB), deckt: deckt, voll: voll, b: b, uebMinKW: ue.length ? Math.min.apply(null, ue.map(u => u === null ? -99 : u)) : null, socProg: socProg, atFenster: atF, atNacht: atN, snapT: snap.t};
}

// ------------------------------------------------------------------ Regeln der Varianten (rein: neuer Zustand, kein Seiteneffekt); alle 5 min aufgerufen
// c = {t, raeume {id: T}, socKWh, F, akku}
function politikNeu() { return {shift: 0, tag: null, vzHeute: false, vzAbbruch: false, nachtNachVz: false, ueberSeit: 0, sperreBis: 0, n: {vz: 0, vzAbbruch: 0, minus: 0, rueck: 0}, log: []}; }
function politik(PS0, c, pol, v) {
    const PS = Object.assign({}, PS0, {n: Object.assign({}, PS0.n), log: PS0.log});
    const d = new Date(c.t), h = d.getHours(), mi = d.getMinutes(), band = pol.raeume || RAEUME, R = c.raeume;
    const mitte = r => (r.min + r.max) / 2;
    const alleUeberMitte = band.every(r => R[r.id] > mitte(r)), alleHoechstMitte = band.every(r => R[r.id] <= mitte(r));
    const einerKnapp = band.some(r => R[r.id] < r.min + pol.rueckK), einerUeberMax = band.some(r => R[r.id] > r.max);
    const imFenster = h >= pol.fensterVonH && h < pol.fensterBisH, tag = ymd(c.t);
    if (PS.tag !== tag) { PS.tag = tag; PS.vzHeute = false; PS.vzAbbruch = false; }
    PS.ueberSeit = alleUeberMitte ? (PS.ueberSeit || c.t) : 0;
    const raumMinus = () => {                                                    // Raumeinfluss −1 K / Rückweg (wie raum_offset v6, vereinfacht)
        if (PS.shift === -1) { if (einerKnapp) { PS.shift = 0; PS.sperreBis = c.t + pol.sperreMin * MIN; PS.n.rueck++; } }
        else if (PS.shift === 0) { if (PS.ueberSeit && c.t - PS.ueberSeit >= pol.stabilMin * MIN && c.t >= PS.sperreBis) { PS.shift = -1; PS.n.minus++; } }
        else { PS.shift = 0; }
    };
    const vorziehen = () => {                                                    // true, solange das Fenster die Verschiebung bestimmt
        if (PS.shift === 1) {
            if (!imFenster) { PS.shift = 0; return false; }
            if (einerUeberMax) { PS.shift = 0; PS.vzAbbruch = true; PS.n.vzAbbruch++; PS.n.abbruchRaum = (PS.n.abbruchRaum || 0) + 1; return false; }
            if (mi === 0) { const e = entscheidung(c, pol); if (!e.ok) { PS.shift = 0; PS.vzAbbruch = true; PS.n.vzAbbruch++; PS.n.abbruchPrognose = (PS.n.abbruchPrognose || 0) + 1; return false; } }
            return true;
        }
        if (!imFenster || PS.vzHeute || PS.vzAbbruch || PS.shift !== 0) { PS.vzFrei = false; return false; }
        if (mi === 0) {                                                          // Entscheidung zur vollen Stunde (Prognose ≤ jetzt), gilt bis zur nächsten vollen Stunde
            const e = entscheidung(c, pol), cOk = alleHoechstMitte || !!pol.ohneC;
            PS.vzFrei = e.ok && cOk;
            if (PS.log) { PS.log.push({t: c.t, ok: PS.vzFrei, ueberMitte: band.filter(r => R[r.id] > mitte(r)).map(r => r.id + ' ' + rd(R[r.id] - mitte(r), 1)), deckt: e.deckt, voll: e.voll, b: e.b, raeumeMitte: alleHoechstMitte, uebMinKW: rd(e.uebMinKW, 2), socProg: rd(e.socProg, 2), atFenster: rd(e.atFenster, 1), atNacht: rd(e.atNacht, 1), snapT: e.snapT, modus: c.modus}); }
        }
        if (PS.vzFrei && c.modus !== 'heizgrenze' && (c.modus === 'lauf' || (c.pauseMin || 0) >= pol.startPauseMin)) { PS.shift = 1; PS.vzHeute = true; PS.vzFrei = false; PS.n.vz++; }   // in der Pause = Startbefehl, erst nach startPauseMin
        return PS.shift === 1;
    };
    if (v === 'A') { PS.shift = 0; }
    else if (v === 'C') { raumMinus(); }
    else if (v === 'B') {
        if (h === pol.nachtBisH && mi === 0) { PS.nachtNachVz = false; if (PS.shift === -1) { PS.shift = 0; } }
        const warVz = PS.shift === 1;
        if (!vorziehen()) {
            if (warVz || (PS.vzHeute && h >= pol.fensterBisH)) { PS.nachtNachVz = true; }
            if (PS.nachtNachVz && !pol.ohneNacht && (h >= pol.fensterBisH || h < pol.nachtBisH)) { if (PS.shift === 1) { PS.shift = 0; } if (pol.nachtImmer) { PS.shift = -1; } else { raumMinus(); } } else { PS.shift = 0; }
        }
    } else if (v === 'N') {                                                      // Referenz: Nachtabsenkung −1 K von Fensterende bis 06 Uhr, ohne Raumbedingung
        PS.shift = h >= pol.fensterBisH || h < pol.nachtBisH ? -1 : 0;
    } else if (v === 'D') {
        if (!vorziehen()) { raumMinus(); }
    }
    return PS;
}

// ------------------------------------------------------------------ Daten
function dateien(dir, re) { return fs.readdirSync(dir).filter(f => re.test(f)).sort().map(f => path.join(dir, f)); }
function ladeForecast(dir) {
    const F = [];
    dateien(dir, /^forecast-\d{4}-\d\d\.jsonl$/).forEach(f => fs.readFileSync(f, 'utf8').split('\n').forEach(l => { if (!l.trim()) { return; } try { const o = JSON.parse(l); if (o && o.t) { F.push({t: o.t, owm: o.owm || [], pv: o.pv || [], cons: o.cons || null}); } } catch (e) { /* defekte Zeile */ } }));
    return F.sort((a, b) => a.t - b.t);
}
// Gemessene WP-Leistung je Minute (kW): ab Zähler (zaehler_wp_w + zaehler_heizstab_w), sonst TOP16 + 80 W im Lauf (+ Heizstab 3 kW, falls an)
function wpMessung(r) {
    const z = num(r.zaehler_wp_w);
    if (z !== null) { return (z + (num(r.zaehler_heizstab_w) || 0)) / 1000; }
    const p = num(r.leistung_el_w), hz = num(r.verdichter_hz);
    if (p === null) { return null; }
    return (p + (hz > 0 ? 80 : 0) + (num(r.heizstab_intern) ? 3000 : 0)) / 1000;
}
function ladeDaten(dir, von, bis, opts) {
    opts = opts || {};
    const A = Object.assign({}, AKKU, opts.akku || {});
    const D = T.lade(dir);
    const v = von.split('-').map(Number), b = bis.split('-').map(Number);
    const t0 = new Date(v[0], v[1] - 1, v[2], 0, 0).getTime(), t1 = new Date(b[0], b[1] - 1, b[2] + 1, 0, 0).getTime();
    const i0 = Math.round((t0 - D.M[0].t) / MIN), N = Math.round((t1 - t0) / MIN);
    if (i0 < 0 || i0 + N > D.M.length) { throw new Error('Datenfenster ' + von + '…' + bis + ' liegt nicht in den Protokollen (' + ymd(D.M[0].t) + '…' + ymd(D.M[D.M.length - 1].t) + ')'); }
    const M = D.M.slice(i0, i0 + N);
    const Q = [].concat.apply([], dateien(dir, /^quiet-\d{4}-\d\d\.csv$/).map(T.readMulti)).sort((x, y) => x._t - y._t);
    const EN = [].concat.apply([], dateien(dir, /^energy-\d{4}-\d\d\.csv$/).map(T.readMulti)).sort((x, y) => x._t - y._t);
    const wp = new Float64Array(N), en = {pv: new Float64Array(N), haus: new Float64Array(N), netz: new Float64Array(N), batt: new Float64Array(N), soc: new Float64Array(N), frisch: new Uint8Array(N), rest: new Float64Array(N), rekon: new Uint8Array(N)};
    let qi = -1, ei = -1, wpLetzt = 0.034, socLetzt = null;
    for (let i = 0; i < N; i++) {
        const t = t0 + i * MIN;
        while (qi + 1 < Q.length && Q[qi + 1]._t <= t) { qi++; }
        while (ei + 1 < EN.length && EN[ei + 1]._t <= t) { ei++; }
        const q = qi >= 0 && t - Q[qi]._t <= 6 * MIN ? Q[qi] : null, w = q ? wpMessung(q) : null;
        wp[i] = w !== null ? w : wpLetzt; wpLetzt = wp[i];
        const e = ei >= 0 && t - EN[ei]._t <= 10 * MIN ? EN[ei] : null;
        const soc = e ? num(e.batterie_soc) : null; if (soc !== null) { socLetzt = soc; }
        en.soc[i] = socLetzt !== null ? socLetzt : 50;
        const alter = e ? num(e.venus_alter_min) : null, ok = e && (alter === null || alter <= 10) && num(e.pv_w) !== null && num(e.haus_w) !== null;
        en.frisch[i] = ok ? 1 : 0;
        if (ok) { en.pv[i] = Math.max(0, num(e.pv_w)) / 1000; en.haus[i] = Math.max(0, num(e.haus_w)) / 1000; en.netz[i] = (num(e.netz_w) || 0) / 1000; en.batt[i] = (num(e.batterie_w) || 0) / 1000; }
    }
    // Stille Blöcke (Venus-Werte eingefroren, nachts; SOC kommt dann ganzzahlig von evcc): Akku-Abgabe aus dem SOC-Verlauf (stückweise linear zwischen den Zeitpunkten
    // der SOC-Stufen), Hauslast = Abgabe · etaEntladen, PV 0, Netz 0; am Boden (SOC ≤ Min + 0,6) Hauslast = Median-Resthauslast + WP aus dem Netz.
    // Annahme: nachts tauscht das Netz nicht (Verkaufspreis 0 € bis 06 Uhr); Entladung ins Netz nach 06 Uhr (Dynamic ESS, 12.10. 06:02 −8,5 kW) zählt hier als Hauslast.
    const bloecke = []; let s0 = null;
    for (let i = 0; i <= N; i++) { if (i < N && !en.frisch[i]) { if (s0 === null) { s0 = i; } } else if (s0 !== null) { bloecke.push([s0, i]); s0 = null; } }
    const info = {stillMin: 0, stillTagMin: 0, bloecke: bloecke.length, restMedianKW: null, restKlipp: 0};
    const fr = []; for (let i = 0; i < N; i++) { if (en.frisch[i] && new Date(t0 + i * MIN).getHours() < 6) { fr.push(en.haus[i] - wp[i]); } }
    info.restMedianKW = median(fr) || 0.6;                                        // Resthauslast nachts aus frischen Werten
    bloecke.forEach(([a, z]) => {
        info.stillMin += z - a;
        const iA = Math.max(0, a - 1), iZ = Math.min(N - 1, z), anker = [[iA, en.soc[iA]]];
        for (let i = iA + 1; i <= iZ; i++) { if (en.soc[i] !== en.soc[i - 1]) { anker.push([i, en.soc[i]]); } }
        if (anker[anker.length - 1][0] !== iZ) { anker.push([iZ, en.soc[iZ]]); }
        let k = 0;
        for (let i = a; i < z; i++) {
            const h = new Date(t0 + i * MIN).getHours();
            if (h >= 9 && h < 17) { info.stillTagMin++; const f = a > 0 ? a - 1 : null; if (f !== null) { en.pv[i] = en.pv[f]; en.haus[i] = en.haus[f]; en.netz[i] = en.netz[f]; en.batt[i] = en.batt[f]; } continue; }   // tagsüber still: Wert halten (selten)
            while (k + 1 < anker.length - 1 && anker[k + 1][0] <= i) { k++; }
            const p = anker[k], q = anker[Math.min(anker.length - 1, k + 1)], dSoc = q[0] > p[0] ? (p[1] - q[1]) / (q[0] - p[0]) : 0;   // %/min, > 0 = Entladung
            en.pv[i] = 0;
            if (en.soc[i] <= A.socMinPct + 0.6) { en.haus[i] = info.restMedianKW + wp[i]; en.netz[i] = en.haus[i]; en.batt[i] = 0; }
            else { const ab = Math.max(0, dSoc) / 100 * A.kapKWh * 60; en.batt[i] = -ab; en.haus[i] = ab * A.etaEntladen; en.netz[i] = 0; }
            en.rekon[i] = 1;
        }
    });
    for (let i = 0; i < N; i++) { const r = en.haus[i] - wp[i]; if (r < 0.05) { info.restKlipp++; } en.rest[i] = Math.max(0.05, r); }
    // Zwilling-Eingang PV (Sonnenmaß) aus der bereinigten Reihe
    M.forEach((m, i) => { m.pv = en.pv[i]; });
    return {D: D, i0: i0, N: N, t0: t0, M: M, wp: wp, en: en, F: ladeForecast(dir), info: info, von: von, bis: bis};
}

// ------------------------------------------------------------------ Tageskennzahlen
function tagNeu(tag) {
    const o = {tag: tag, n: 0, kwhEl: 0, kwhHs: 0, kwhTh: 0, starts: 0, minPlus: 0, minMinus: 0, soc06: null, socMin: 999, socMax: -1, bezugTag: 0, bezugNacht: 0, einsp: 0, entl: 0, laden: 0,
               kostenBezug: 0, erloes: 0, verschleiss: 0, kosten: 0, hausSum: 0, unterMin: {}, ueberMax: {}, vz: false};
    RAEUME.forEach(r => { o.unterMin[r.id] = 0; o.ueberMax[r.id] = 0; });
    return o;
}
function bucheStrom(o, t, b, soc) {                                              // b = {bezug, einsp, entl (kW)} je Minute
    const dt = DTH;
    if (istNacht(t)) { o.bezugNacht += b.bezug * dt; } else { o.bezugTag += b.bezug * dt; }
    o.einsp += b.einsp * dt; o.entl += b.entl * dt; if (b.laden) { o.laden += b.laden * dt; }
    o.kostenBezug += b.bezug * dt * preisKauf(t); o.erloes += b.einsp * dt * preisVerkauf(t); o.verschleiss += b.entl * dt * PREIS.verschleiss;
    const h = new Date(t), pct = soc;
    if (h.getHours() === 6 && h.getMinutes() === 0) { o.soc06 = pct; }
    o.socMin = Math.min(o.socMin, pct); o.socMax = Math.max(o.socMax, pct);
}
function schliesse(o) {
    o.kosten = o.kostenBezug - o.erloes + o.verschleiss; const nh = o.nTh !== undefined ? o.nTh : o.n; o.hausMittel = nh ? o.hausSum / nh : null; delete o.hausSum; delete o.nTh;
    o.cop = o.kwhEl > 0 ? o.kwhTh / o.kwhEl : null;
    ['kwhEl', 'kwhHs', 'kwhTh', 'bezugTag', 'bezugNacht', 'einsp', 'entl', 'laden', 'kostenBezug', 'erloes', 'verschleiss', 'kosten'].forEach(k => { o[k] = rd(o[k], 3); });
    o.cop = rd(o.cop, 2); o.hausMittel = rd(o.hausMittel, 2); o.soc06 = rd(o.soc06, 1); o.socMin = rd(o.socMin, 1); o.socMax = rd(o.socMax, 1);
    return o;
}
function summe(tage) {
    const s = tagNeu('Summe'); delete s.soc06;
    tage.forEach(o => { ['kwhEl', 'kwhHs', 'kwhTh', 'starts', 'minPlus', 'minMinus', 'bezugTag', 'bezugNacht', 'einsp', 'entl', 'laden', 'kostenBezug', 'erloes', 'verschleiss', 'kosten'].forEach(k => { s[k] += o[k] || 0; });
        RAEUME.forEach(r => { s.unterMin[r.id] += o.unterMin[r.id]; s.ueberMax[r.id] += o.ueberMax[r.id]; }); s.socMin = Math.min(s.socMin, o.socMin); s.socMax = Math.max(s.socMax, o.socMax); s.n += o.n; s.hausSum += (o.hausMittel || 0) * o.n; if (o.vz) { s.vzTage = (s.vzTage || 0) + 1; } });
    s.soc06Mittel = rd(mean(tage.map(o => o.soc06)), 1);
    return schliesse(s);
}

// ------------------------------------------------------------------ Ein geschlossener Lauf (Zwilling + Akku „Eigenverbrauch“; danach DESS-nah aus der WP-Spur)
// ctx = ladeDaten(...) oder synthetisch {N, t0, M [{t, at, rh, pv, soll, q, hc}], wp (gemessen, kW), en {pv, rest, soc[0], ...}, F, init (Zwilling-Startzustand)}
function lauf(ctx, variante, opt) {
    opt = opt || {};
    const P = opt.P, pol = Object.assign({}, POLITIK, opt.politik || {}), A = Object.assign({}, AKKU, opt.akku || {}), N = ctx.N;
    let S = ctx.S0 ? JSON.parse(JSON.stringify(ctx.S0)) : Z.neu(P, ctx.init || T.initAus(ctx.D, ctx.i0, P));
    let soc = (opt.socStart !== undefined ? opt.socStart : ctx.en.soc[0]) / 100 * A.kapKWh;
    let PS = politikNeu(); if (!opt.log) { PS.log = null; }
    let raeume = Object.assign({}, S.raeume), lastAt = 10, lastRh = 80, psVor = 0;
    const spur = {wp: new Float64Array(N), shift: new Int8Array(N), soc: new Float32Array(N), th: new Float32Array(N), raumMittel: new Float32Array(N), kosten: new Float64Array(N)};
    const tage = []; let o = null;
    const fen = opt.fenster ? tagNeu('Fenster') : null;                              // optionales Auswertefenster [a, z) in Minuten (Winter: Tag 1 06:00 … Tag 2 06:00)
    for (let i = 0; i < N; i++) {
        const t = ctx.t0 + i * MIN, m = ctx.M[i];
        const at = m.at !== null && m.at !== undefined ? m.at : lastAt; lastAt = at;
        const rh = m.rh !== null && m.rh !== undefined ? m.rh : lastRh; lastRh = rh;
        const tg = ymd(t); if (!o || o.tag !== tg) { if (o) { tage.push(schliesse(o)); } o = tagNeu(tg); }
        let inp;
        if (variante === 'A0') { inp = {t: t, at: at, rh: rh, pv: m.pv, q: m.q === null || m.q === undefined ? 3 : m.q, hc: m.hc === null || m.hc === undefined ? 1 : m.hc, shift: 0, sollHand: m.soll !== null && m.soll !== undefined ? m.soll : undefined}; }
        else {
            if (t % (5 * MIN) === 0) { PS = politik(PS, {t: t, raeume: raeume, socKWh: soc, F: ctx.F, akku: A, modus: S.modus === 'aus' ? 'heizgrenze' : S.modus, pauseMin: S.pauseMin}, pol, variante); }
            const eff = ps => { const x = ps + (opt.shiftBasis || 0); if (x >= 0) { return x; } const sk = Math.ceil(Z.kurveSoll(P, Math.round(Z.atWP(P, at))) - 1e-9); return sk + x < pol.minVlC ? Math.min(0, pol.minVlC - sk) : x; };   // Soll nie unter minVlC
            const sh = eff(PS.shift), anhebung = PS.shift > psVor && sh > eff(psVor);                      // echte Soll-Anhebung durch die Regel (nicht durch die Kurve)
            inp = {t: t, at: at, rh: rh, pv: m.pv, q: opt.q !== undefined ? opt.q : 3, hc: opt.hc !== undefined ? opt.hc : 1, shift: sh, startBefehl: !!(pol.startBeiAnhebung && anhebung)};
            if (anhebung && S.modus === 'pause') { o.startBefehle = (o.startBefehle || 0) + 1; }
            psVor = PS.shift;
            spur.shift[i] = sh - (opt.shiftBasis || 0);
        }
        const r = Z.schritt(S, inp, P); S = r.S; const Aus = r.A; raeume = Aus.raeume;
        const wpKW = (Aus.pelKorr + Aus.pelHs) / 1000;
        spur.wp[i] = wpKW; spur.th[i] = Aus.th; spur.raumMittel[i] = mean(RAEUME.map(rc => Aus.raeume[rc.id]));
        if (opt.socSetzen && opt.socSetzen[0] === i) { soc = opt.socSetzen[1] / 100 * A.kapKWh; }       // Winter: Akku morgens leer
        const b = akkuSchritt(soc, ctx.en.pv[i], ctx.en.rest[i] + wpKW, DTH, A); soc = b.soc; spur.soc[i] = soc / A.kapKWh * 100;
        spur.kosten[i] = (b.bezug * preisKauf(t) - b.einsp * preisVerkauf(t) + b.entl * PREIS.verschleiss) * DTH;
        const ziele = fen && i >= opt.fenster[0] && i < opt.fenster[1] ? [o, fen] : [o];
        ziele.forEach(x => {
            x.n++; x.kwhEl += wpKW / 60; x.kwhHs += Aus.pelHs / 60000; x.kwhTh += Math.max(0, Aus.pth) / 60000; if (Aus.start) { x.starts++; }
            if (spur.shift[i] > 0) { x.minPlus++; x.vz = true; } if (spur.shift[i] < 0) { x.minMinus++; }
            x.hausSum += Aus.th;
            RAEUME.forEach(rc => { const T_ = Aus.raeume[rc.id]; if (T_ < rc.min) { x.unterMin[rc.id]++; } if (T_ > rc.max) { x.ueberMax[rc.id]++; } });
            bucheStrom(x, t, b, soc / A.kapKWh * 100);
        });
    }
    if (o) { tage.push(schliesse(o)); }
    const ende = {socKWh: soc, th: S.th};
    const res = {variante: variante, tage: tage, summe: summe(tage), spur: spur, ende: ende, politik: {n: PS.n, log: PS.log || []}};
    if (fen) { fen.soc06 = spur.soc[opt.fenster[1] - 1]; res.fenster = schliesse(fen); }
    return res;
}
// DESS-nah: Strom je Tag aus der WP-Spur einer Variante gegen die gemessene WP-Leistung
function dessPfad(ctx, wpSpur, opt) {
    const A = Object.assign({}, AKKU, (opt && opt.akku) || {}), tage = []; let o = null, st = {dSoc: 0}, socEnde = null;
    for (let i = 0; i < ctx.N; i++) {
        const t = ctx.t0 + i * MIN, tg = ymd(t); if (!o || o.tag !== tg) { if (o) { tage.push(schliesse(o)); } o = tagNeu(tg); }
        const mess = {soc: ctx.en.soc[i], netz: ctx.en.netz[i], batt: ctx.en.batt[i], frisch: !!ctx.en.frisch[i]};
        const r = dessSchritt(st, mess, wpSpur ? wpSpur[i] - ctx.wp[i] : 0, DTH, A); st = r.st; socEnde = r.soc;
        o.n++; bucheStrom(o, t, {bezug: r.bezug, einsp: r.einsp, entl: r.entl}, r.soc / A.kapKWh * 100);
    }
    if (o) { tage.push(schliesse(o)); }
    tage.forEach(x => { delete x.unterMin; delete x.ueberMax; });
    return {tage: tage, summe: summe(tage.map(x => Object.assign(x, {unterMin: Object.fromEntries(RAEUME.map(r => [r.id, 0])), ueberMax: Object.fromEntries(RAEUME.map(r => [r.id, 0]))}))), socEndeKWh: socEnde};
}

// ------------------------------------------------------------------ Messung je Tag (Referenz und Validierung)
function messung(ctx, opt) {
    const A = Object.assign({}, AKKU, (opt && opt.akku) || {}), tage = []; let o = null, prevLauf = null;
    for (let i = 0; i < ctx.N; i++) {
        const t = ctx.t0 + i * MIN, m = ctx.M[i], tg = ymd(t); if (!o || o.tag !== tg) { if (o) { tage.push(schliesse(o)); } o = tagNeu(tg); o.nTh = 0; }
        o.n++; o.kwhEl += ctx.wp[i] / 60;
        if (m.lauf && m.flow > 1 && m.vl !== null && m.rl !== null) { o.kwhTh += Math.max(0, m.flow * Z.CP * (m.vl - m.rl)) / 60; }
        if (m.lauf && prevLauf === false) { o.starts++; } prevLauf = !!m.lauf;
        if (m.th !== null) { o.hausSum += m.th; o.nTh++; }
        RAEUME.forEach(rc => { const x = m.rooms[rc.id]; if (x !== null && x !== undefined) { if (x < rc.min) { o.unterMin[rc.id]++; } if (x > rc.max) { o.ueberMax[rc.id]++; } } });
        const e = ctx.en; bucheStrom(o, t, {bezug: Math.max(0, e.netz[i]), einsp: Math.max(0, -e.netz[i]), entl: Math.max(0, -e.batt[i]), laden: Math.max(0, e.batt[i])}, e.soc[i]);
    }
    if (o) { tage.push(schliesse(o)); }
    tage.forEach(x => { /* Hausmittel nur über Minuten mit Messwert */ });
    return {tage: tage, summe: summe(tage)};
}
// Validierung des Akku-Modells „Eigenverbrauch“ mit der gemessenen WP-Leistung: (1) durchgehend ab dem ersten SOC, (2) jeden Tag um 00:00 auf den gemessenen SOC gesetzt
function validiereAkku(ctx, opt) {
    const A = Object.assign({}, AKKU, (opt && opt.akku) || {}), res = {durchgehend: [], taeglich: []};
    ['durchgehend', 'taeglich'].forEach(art => {
        let soc = ctx.en.soc[0] / 100 * A.kapKWh, o = null; const fehler = [];
        for (let i = 0; i < ctx.N; i++) {
            const t = ctx.t0 + i * MIN, tg = ymd(t);
            if (!o || o.tag !== tg) { if (o) { o.socMae = rd(mean(fehler.splice(0)), 1); res[art].push(schliesse(o)); } o = tagNeu(tg); if (art === 'taeglich') { soc = ctx.en.soc[i] / 100 * A.kapKWh; } }
            const b = akkuSchritt(soc, ctx.en.pv[i], ctx.en.rest[i] + ctx.wp[i], DTH, A); soc = b.soc;
            o.n++; bucheStrom(o, t, b, soc / A.kapKWh * 100); fehler.push(Math.abs(soc / A.kapKWh * 100 - ctx.en.soc[i]));
        }
        if (o) { o.socMae = rd(mean(fehler), 1); res[art].push(schliesse(o)); }
    });
    return res;
}
// Dynamic-ESS-Verhalten in der Messung (je Tag kWh): Einspeisung bei SOC < 95 %, Akku → Netz, Netz → Akku
function dessBefund(ctx) {
    const tage = {}; const e = ctx.en;
    for (let i = 0; i < ctx.N; i++) {
        if (!e.frisch[i]) { continue; }
        const tg = ymd(ctx.t0 + i * MIN), o = tage[tg] = tage[tg] || {tag: tg, einspNichtVoll: 0, akkuInsNetz: 0, netzInAkku: 0, einspGesamt: 0, minHalten: 0};
        const ex = Math.max(0, -e.netz[i]), im = Math.max(0, e.netz[i]);
        o.einspGesamt += ex / 60; if (e.soc[i] < 95) { o.einspNichtVoll += ex / 60; if (ex > 1 && Math.abs(e.batt[i]) < 0.5) { o.minHalten++; } }
        if (e.batt[i] < -0.5 && ex > 0.5) { o.akkuInsNetz += Math.min(-e.batt[i], ex) / 60; }
        if (e.batt[i] > 0.5 && im > 0.5) { o.netzInAkku += Math.min(e.batt[i], im) / 60; }
    }
    return Object.keys(tage).sort().map(k => { const o = tage[k]; ['einspNichtVoll', 'akkuInsNetz', 'netzInAkku', 'einspGesamt'].forEach(x => { o[x] = rd(o[x], 1); }); return o; });
}

// ------------------------------------------------------------------ Winter-Abschätzung (synthetisch, klar Modell): sonniger Wintertag vor kalter Nacht, Akku morgens leer
function winterKontext(P, opts) {
    opts = opts || {};
    const tage = 3, N = tage * 1440, t0 = new Date(2026, 11, 14, 0, 0).getTime();
    const pvSpitze = opts.pvSpitzeKW || 4.4, restProfil = opts.restProfil || new Array(24).fill(0.7);
    const atAt = h => -1 + 4 * Math.sin(2 * Math.PI * (h - 9) / 24);                     // Tag max +3 °C um 15 Uhr, Nacht min −5 °C um 03 Uhr
    const pvAt = h => (h > 8.5 && h < 15.5 ? pvSpitze * Math.sin(Math.PI * (h - 8.5) / 7) : 0);
    const M = [], en = {pv: new Float64Array(N), rest: new Float64Array(N), soc: new Float64Array(N), netz: new Float64Array(N), batt: new Float64Array(N), frisch: new Uint8Array(N)};
    for (let i = 0; i < N; i++) { const h = (i % 1440) / 60; M.push({t: t0 + i * MIN, at: Math.round(atAt(h) * 10) / 10, rh: 85, pv: pvAt(h), soll: null, q: 3, hc: 1}); en.pv[i] = pvAt(h); en.rest[i] = restProfil[Math.floor(h)]; en.soc[i] = AKKU.socMinPct; }
    const F = [];                                                                         // „perfekte“ Prognose: stündliche Schnappschüsse mit dem synthetischen Wetter
    for (let k = 0; k < tage * 24; k++) {
        const ts = t0 + k * HOUR, owm = [], pv = [], cons = [];
        for (let j = 0; j <= 13; j++) { const x = ts + j * 3 * HOUR; owm.push([x, atAt(((x - t0) / HOUR) % 24), 85, 10]); }
        for (let j = 0; j < 37; j++) { const x = ts + j * HOUR; pv.push([x / 1000, pvAt((((x - t0) / HOUR) % 24) + 0.5) * 1000, 3600]); cons.push([x / 1000, (restProfil[((x - t0) / HOUR) % 24] + 0.6) * 1000]); }
        F.push({t: ts / 1000, owm: owm, pv: pv, cons: cons});
    }
    // Startzustand: 1 Tag Zwilling allein im selben Wetter (A)
    let S = Z.neu(P, {modus: 'pause', th: 21, tw: 34, at: -1});
    for (let i = 0; i < 2 * 1440; i++) { S = Z.schritt(S, {t: t0 - (2 * 1440 - i) * MIN, at: M[i % 1440].at, rh: 85, pv: M[i % 1440].pv, q: opts.q !== undefined ? opts.q : 3, hc: opts.hc !== undefined ? opts.hc : 1, shift: opts.shiftBasis || 0}, P).S; }
    return {N: N, t0: t0, M: M, en: en, F: F, S0: S, wp: new Float64Array(N)};
}
function laufWinter(P, variante, opts) {
    const ctx = winterKontext(P, opts);
    return lauf(ctx, variante, {P: P, politik: opts.politik, q: opts.q, hc: opts.hc, shiftBasis: opts.shiftBasis || 0, socStart: AKKU.socMinPct, socSetzen: [1440 + 360, AKKU.socMinPct], fenster: [1440 + 360, 2 * 1440 + 360]});
}

// Je Vorziehen-Tag: B − A in Fenstern (Strom 12–17 Uhr, 17–06 Uhr, Kosten 12–06 Uhr, SOC um 06 Uhr, Hausmittel um 17 Uhr)
function ereignisse(ctx, rA, rB) {
    const out = [], sp = (r, k, a, z) => { let x = 0; for (let i = Math.max(0, a); i < Math.min(ctx.N, z); i++) { x += r.spur[k][i]; } return x; };
    rB.tage.forEach((d, k) => {
        if (!d.vz) { return; }
        const i12 = k * 1440 + 12 * 60, i17 = k * 1440 + 17 * 60, i06 = (k + 1) * 1440 + 6 * 60;
        if (i06 > ctx.N) { return; }
        out.push({tag: d.tag, minPlus: d.minPlus, dKWhFenster: rd((sp(rB, 'wp', i12, i17) - sp(rA, 'wp', i12, i17)) / 60, 3), dKWhNacht: rd((sp(rB, 'wp', i17, i06) - sp(rA, 'wp', i17, i06)) / 60, 3),
                  dEuro: rd(sp(rB, 'kosten', i12, i06) - sp(rA, 'kosten', i12, i06), 3), dSoc06: rd(rB.spur.soc[i06 - 1] - rA.spur.soc[i06 - 1], 1), dTh17: rd(rB.spur.th[i17] - rA.spur.th[i17], 2), dTh06: rd(rB.spur.th[i06 - 1] - rA.spur.th[i06 - 1], 2)});
    });
    return out;
}

// ------------------------------------------------------------------ Gesamtlauf
function alles(ctx, P, opts) {
    opts = opts || {};
    const t0 = process.hrtime.bigint();
    const sec = () => Number(process.hrtime.bigint() - t0) / 1e9;
    const R = {meta: {von: ctx.von, bis: ctx.bis, tage: Math.round(ctx.N / 1440), info: ctx.info, politik: POLITIK, akku: AKKU, preis: PREIS, raeume: RAEUME}, laufzeit: {}};
    R.messung = messung(ctx);
    R.validierung = validiereAkku(ctx); R.dessMessung = dessPfad(ctx, null); R.dessBefund = dessBefund(ctx);
    R.a0 = lauf(ctx, 'A0', {P: P}); R.a0.dess = dessPfad(ctx, R.a0.spur.wp);
    R.laufzeit.validierung = rd(sec(), 1);
    const satz = (name, PP, pol) => {
        const o = {name: name};
        ['A', 'B', 'C', 'D'].forEach(v => { const r = lauf(ctx, v, {P: PP, politik: pol, log: name === 'Basis'}); r.dess = dessPfad(ctx, r.spur.wp); o[v] = r; });
        return o;
    };
    R.basis = satz('Basis', P, {});
    R.laufzeit.basis = rd(sec(), 1);
    R.sens = [];
    if (!opts.schnell) {
        const mit = (k, f) => { const Q = JSON.parse(JSON.stringify(P)); Q[k] = Q[k] * f; return Q; };
        R.sens.push(satz('ch −30 %', mit('ch', 0.7), {}), satz('ch +30 %', mit('ch', 1.3), {}), satz('Sonne −50 %', mit('sonne', 0.5), {}), satz('Sonne +50 %', mit('sonne', 1.5), {}),
                    satz('Fenster 13–16 Uhr', P, {fensterVonH: 13, fensterBisH: 16}), satz('(a) nur „Überschuss deckt“ (Akku muss nicht voll werden)', P, {aModus: 'deckt'}),
                    satz('(b) ΔAT ≥ 2 K', P, {atDiffK: 2}), satz('(c) aus: Vorziehen auch bei Räumen über der Bandmitte (Potenzial)', P, {ohneC: true}),
                    satz('(c) aus, ohne Nacht −1 K: nur +1 K (reiner Vorzieh-Effekt)', P, {ohneC: true, ohneNacht: true}),
                    satz('Zwilling ohne Startbefehl bei Soll-Anhebung (wie trainiert)', P, {startBeiAnhebung: false}));
        // Takt-Rauschen: A gegen A mit UA × 1,001 (physikalisch gleich; Unterschiede = Phasenlage der Takte im geschlossenen Lauf)
        const Q = JSON.parse(JSON.stringify(P)); Q.ua = Q.ua * 1.001;
        const a2 = lauf(ctx, 'A', {P: Q}), a1 = R.basis.A;
        const dk = a1.tage.map((x, k) => Math.abs(a2.tage[k].kwhEl - x.kwhEl)), de_ = a1.tage.map((x, k) => Math.abs(a2.tage[k].kosten - x.kosten));
        R.rauschen = {tagKWhMittel: rd(mean(dk), 3), tagKWhMax: rd(Math.max.apply(null, dk), 3), tagEuroMittel: rd(mean(de_), 3), tagEuroMax: rd(Math.max.apply(null, de_), 3),
                      summeKWh: rd(a2.summe.kwhEl - a1.summe.kwhEl, 3), summeEuro: rd(bereinigt(a2, a1, P) - bereinigt(a1, a1, P), 3),
                      unterMin: RAEUME.reduce((x, r) => x + a2.summe.unterMin[r.id] - a1.summe.unterMin[r.id], 0)};
        const pot = R.sens.find(x => /nur \+1 K/.test(x.name)); R.ereignisse = pot ? ereignisse(ctx, pot.A, pot.B) : [];
        // Potenzial der Verschiebung Tag → Nacht: N (nur Nacht −1 K) gegen B** (Vorziehen ohne (c), danach Nacht −1 K immer); B** − N = Wirkung des Vorziehens bei ohnehin abgesenkter Nacht
        const rN = lauf(ctx, 'N', {P: P}), rB2 = lauf(ctx, 'B', {P: P, politik: {ohneC: true, nachtImmer: true}});
        R.potenzial = {A: R.basis.A, N: rN, B2: rB2, ereignisse: ereignisse(ctx, rN, rB2)};
    }
    R.laufzeit.sensitivitaet = rd(sec(), 1);
    // Winter: Ruheprofil der Hauslast (Median je Stunde, Oktober), PV-Spitze ¼ des 95-%-Werts der Oktober-PV
    const prof = []; for (let h = 0; h < 24; h++) { const a = []; for (let i = 0; i < ctx.N; i++) { if (new Date(ctx.t0 + i * MIN).getHours() === h) { a.push(ctx.en.rest[i]); } } prof.push(rd(median(a), 3)); }
    const pvs = Array.from(ctx.en.pv).sort((x, y) => x - y), pvSpitze = pvs[Math.floor(0.95 * (pvs.length - 1))] / 4;
    R.winter = {restProfil: prof, pvSpitzeKW: rd(pvSpitze, 2), q0: {}, q3: {}};
    const WV = {A: ['A', {}], B: ['B', {}], 'B*': ['B', {ohneA: true, ohneC: true, fensterVonH: 12, fensterBisH: 15}], C: ['C', {}], D: ['D', {}], 'D*': ['D', {ohneA: true, ohneC: true, fensterVonH: 12, fensterBisH: 15}]};
    WV['B* ohne Nacht'] = ['B', {ohneA: true, ohneC: true, ohneNacht: true, fensterVonH: 12, fensterBisH: 15}];
    WV.N = ['N', {fensterBisH: 15}]; WV['B**'] = ['B', {ohneA: true, ohneC: true, nachtImmer: true, fensterVonH: 12, fensterBisH: 15}];
    Object.keys(WV).forEach(v => { [['q0', 0, 0, WINTER_BASIS_K], ['q3', 3, 1, 0]].forEach(([k, q, hc, sb]) => { R.winter[k][v] = laufWinter(P, WV[v][0], {restProfil: prof, pvSpitzeKW: pvSpitze, q: q, hc: hc, shiftBasis: sb, politik: WV[v][1]}); }); });
    R.laufzeit.gesamt = rd(sec(), 1);
    return R;
}

// ------------------------------------------------------------------ Bericht
const de = (x, k) => x === null || x === undefined || !isFinite(x) ? '–' : Number(x).toFixed(k === undefined ? 1 : k).replace('.', ',').replace(/^-/, '−');
const sg = (x, k) => x === null || x === undefined || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + de(x, k);
const kurzTag = s => s.slice(8, 10) + '.' + s.slice(5, 7) + '.';
function komfortMin(o, art) { return RAEUME.map(r => o[art][r.id]).join('/'); }
// Bereinigung des Periodenendes: Akku-Endstand (kWh) zum Einspeisewert, Hauswärme-Endstand (ch · Δth) über COP zum Einspeisewert, je gegen A
function bereinigt(r, rA, P) {
    const dAkku = (r.ende.socKWh - rA.ende.socKWh) * AKKU.etaEntladen, dHaus = (r.ende.th - rA.ende.th) * P.ch / Math.max(2, rA.summe.cop || 4.5);
    return r.summe.kosten - (dAkku + dHaus) * PREIS.verkauf;
}
function markdown(R, P) {
    const ctxRef = {ctx: R._ctx};
    const L = [], V = ['A', 'B', 'C', 'D'], B = R.basis, MS = R.messung.summe;
    L.push('## Validierung Akku-Modell „Eigenverbrauch“ (gemessene WP-Leistung, ' + kurzTag(R.meta.von) + '–' + kurzTag(R.meta.bis) + ')', '');
    L.push('| Tag | SOC 06 Uhr Messung / Modell durchgehend / Modell täglich neu | SOC min…max Messung | SOC min…max Modell (täglich neu) | SOC-Abw. MAE durchgehend / täglich (%-Pkt.) | Bezug kWh Messung / Modell | Einspeisung kWh Messung / Modell | Akku entladen kWh Messung / Modell | DESS: Einspeisung bei SOC < 95 % / Akku→Netz / Netz→Akku kWh |', '|---|---|---|---|---|---|---|---|---|');
    R.messung.tage.forEach((m, k) => {
        const d = R.validierung.durchgehend[k], t = R.validierung.taeglich[k], b = R.dessBefund.find(x => x.tag === m.tag) || {};
        L.push('| ' + kurzTag(m.tag) + ' | ' + de(m.soc06, 0) + ' / ' + de(d.soc06, 0) + ' / ' + de(t.soc06, 0) + ' | ' + de(m.socMin, 0) + '…' + de(m.socMax, 0) + ' | ' + de(t.socMin, 0) + '…' + de(t.socMax, 0) + ' | ' + de(d.socMae, 1) + ' / ' + de(t.socMae, 1) + ' | ' +
            de(m.bezugTag + m.bezugNacht, 1) + ' / ' + de(t.bezugTag + t.bezugNacht, 1) + ' | ' + de(m.einsp, 1) + ' / ' + de(t.einsp, 1) + ' | ' + de(m.entl, 1) + ' / ' + de(t.entl, 1) + ' | ' + de(b.einspNichtVoll, 1) + ' / ' + de(b.akkuInsNetz, 1) + ' / ' + de(b.netzInAkku, 1) + ' |');
    });
    const vs = R.validierung.taeglich, vsum = summe(vs.map(x => Object.assign({}, x)));
    L.push('| **Summe** | | | | ' + de(mean(R.validierung.durchgehend.map(x => x.socMae)), 1) + ' / ' + de(mean(vs.map(x => x.socMae)), 1) + ' | ' + de(MS.bezugTag + MS.bezugNacht, 1) + ' / ' + de(vsum.bezugTag + vsum.bezugNacht, 1) + ' | ' + de(MS.einsp, 1) + ' / ' + de(vsum.einsp, 1) + ' | ' + de(MS.entl, 1) + ' / ' + de(vsum.entl, 1) + ' | ' +
        de(R.dessBefund.reduce((s, x) => s + x.einspNichtVoll, 0), 1) + ' / ' + de(R.dessBefund.reduce((s, x) => s + x.akkuInsNetz, 0), 1) + ' / ' + de(R.dessBefund.reduce((s, x) => s + x.netzInAkku, 0), 1) + ' |', '');
    L.push('Kosten der Messung (Bezug − Einspeiseerlös + Verschleiß): ' + de(MS.kosten, 2) + ' € · Modell täglich neu: ' + de(vsum.kosten, 2) + ' €. Stille Venus-Blöcke (nachts) rekonstruiert: ' + R.meta.info.stillMin + ' min (' + R.meta.info.bloecke + ' Blöcke, Rest-Hauslast Median ' + de(R.meta.info.restMedianKW, 2) + ' kW).', '');
    L.push('## Zwilling mit gemessenen Einstellungen (A0) gegen Messung', '', '| Tag | kWh el Zwilling / Messung | kWh th Zwilling / Messung | Starts Zwilling / Messung | Hausmittel Zwilling / Messung |', '|---|---|---|---|---|');
    R.a0.tage.forEach((z, k) => { const m = R.messung.tage[k]; L.push('| ' + kurzTag(z.tag) + ' | ' + de(z.kwhEl, 2) + ' / ' + de(m.kwhEl, 2) + ' | ' + de(z.kwhTh, 1) + ' / ' + de(m.kwhTh, 1) + ' | ' + z.starts + ' / ' + m.starts + ' | ' + de(z.hausMittel, 2) + ' / ' + de(m.n ? m.hausMittel : null, 2) + ' |'); });
    L.push('| **Summe** | ' + de(R.a0.summe.kwhEl, 1) + ' / ' + de(MS.kwhEl, 1) + ' | ' + de(R.a0.summe.kwhTh, 0) + ' / ' + de(MS.kwhTh, 0) + ' | ' + R.a0.summe.starts + ' / ' + MS.starts + ' | ' + de(R.a0.summe.hausMittel, 2) + ' / – |', '');
    L.push('## Summen ' + kurzTag(R.meta.von) + '–' + kurzTag(R.meta.bis) + ' (Basis)', '');
    L.push('| Variante | kWh el (Heizstab) | kWh th | COP | Starts | min +1 K / −1 K | Tage mit Vorziehen | SOC 06 Uhr Ø | Bezug Tag / Nacht kWh | Einspeisung kWh | Kosten € (Eigenverbrauch) | Kosten € bereinigt¹ | Kosten € DESS-nah | min unter Minimum ki_oben/ki_unten/schlaf/wohn | min über Maximum | Hausmittel Ø |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    V.forEach(v => { const r = B[v], s = r.summe; L.push('| ' + VARIANTEN[v] + ' | ' + de(s.kwhEl, 2) + ' (' + de(s.kwhHs, 1) + ') | ' + de(s.kwhTh, 1) + ' | ' + de(s.cop, 2) + ' | ' + s.starts + ' | ' + s.minPlus + ' / ' + s.minMinus + ' | ' + (s.vzTage || 0) + ' | ' + de(s.soc06Mittel, 1) + ' | ' + de(s.bezugTag, 2) + ' / ' + de(s.bezugNacht, 2) + ' | ' + de(s.einsp, 1) + ' | ' + de(s.kosten, 2) + ' | ' + de(bereinigt(r, B.A, P), 2) + ' | ' + de(r.dess.summe.kosten, 2) + ' | ' + komfortMin(s, 'unterMin') + ' | ' + komfortMin(s, 'ueberMax') + ' | ' + de(s.hausMittel, 2) + ' |'); });
    L.push('| Messung (Referenz) | ' + de(MS.kwhEl, 2) + ' | ' + de(MS.kwhTh, 1) + ' | ' + de(MS.cop, 2) + ' | ' + MS.starts + ' | – | – | ' + de(MS.soc06Mittel, 1) + ' | ' + de(MS.bezugTag, 2) + ' / ' + de(MS.bezugNacht, 2) + ' | ' + de(MS.einsp, 1) + ' | ' + de(MS.kosten, 2) + ' | – | – | ' + komfortMin(MS, 'unterMin') + ' | ' + komfortMin(MS, 'ueberMax') + ' | – |', '');
    L.push('¹ bereinigt um den Endstand nach ' + R.meta.tage + ' Tagen gegen A: Akku-Inhalt und Hauswärme (ch · ΔT / COP) zum Einspeisewert 0,06 €/kWh.', '');
    L.push('## Je Tag (Basis): Unterschied zu A', '', '| Tag | AT Ø | PV kWh | A: kWh el / Kosten € / SOC 06 | B − A: kWh el / € / min +1 K | C − A: kWh el / € | D − A: kWh el / € / min +1 K | Prognose-Entscheidung B um 12 Uhr: (a) Überschuss deckt (min. kW) / (a) Akku würde voll (Prognose-SOC) / (b) ΔAT Fenster − Nacht / (c) Räume ≤ Mitte · erste Freigabe |', '|---|---|---|---|---|---|---|---|');
    B.A.tage.forEach((a, k) => {
        const b = B.B.tage[k], c = B.C.tage[k], d = B.D.tage[k];
        const lgs = B.B.politik.log.filter(x => ymd(x.t) === a.tag), lg = lgs.filter(x => new Date(x.t).getHours() === POLITIK.fensterVonH)[0], frei = lgs.filter(x => x.ok)[0];
        L.push('| ' + kurzTag(a.tag) + ' | ' + de(R.tagAt[a.tag], 1) + ' | ' + de(R.tagPv[a.tag], 0) + ' | ' + de(a.kwhEl, 2) + ' / ' + de(a.kosten, 2) + ' / ' + de(a.soc06, 0) + ' | ' + sg(b.kwhEl - a.kwhEl, 2) + ' / ' + sg(b.kosten - a.kosten, 3) + ' / ' + b.minPlus + ' | ' + sg(c.kwhEl - a.kwhEl, 2) + ' / ' + sg(c.kosten - a.kosten, 3) + ' | ' + sg(d.kwhEl - a.kwhEl, 2) + ' / ' + sg(d.kosten - a.kosten, 3) + ' / ' + d.minPlus + ' | ' +
            (lg ? (lg.deckt ? 'ja' : 'nein') + ' (' + de(lg.uebMinKW, 1) + ' kW) / ' + (lg.voll ? 'ja' : 'nein') + ' (' + de(lg.socProg === null ? null : lg.socProg * 100, 0) + ' %) / ' + de(lg.atFenster - lg.atNacht, 1) + ' K / ' + (lg.raeumeMitte ? 'ja' : 'nein') + (frei ? ' · ' + pad(new Date(frei.t).getHours()) + ' Uhr' : ' · –') : '–') + ' |');
    });
    L.push('', '## Sensitivität (Summen ' + R.meta.tage + ' Tage; Unterschiede zu A desselben Satzes)', '', '| Satz | A kWh el / Kosten € | B − A kWh el / € (bereinigt) | C − A kWh el / € (bereinigt) | D − A kWh el / € (bereinigt) | D − A DESS-nah € | min unter Minimum A / B / C / D | Tage Vorziehen B / D |', '|---|---|---|---|---|---|---|---|');
    [B].concat(R.sens).forEach(s => {
        const u = v => RAEUME.reduce((x, r) => x + s[v].summe.unterMin[r.id], 0), dd = v => sg(s[v].summe.kwhEl - s.A.summe.kwhEl, 2) + ' / ' + sg(bereinigt(s[v], s.A, P) - bereinigt(s.A, s.A, P), 2);
        L.push('| ' + s.name + ' | ' + de(s.A.summe.kwhEl, 1) + ' / ' + de(s.A.summe.kosten, 2) + ' | ' + dd('B') + ' | ' + dd('C') + ' | ' + dd('D') + ' | ' + sg(s.D.dess.summe.kosten - s.A.dess.summe.kosten, 2) + ' | ' + u('A') + ' / ' + u('B') + ' / ' + u('C') + ' / ' + u('D') + ' | ' + (s.B.summe.vzTage || 0) + ' / ' + (s.D.summe.vzTage || 0) + ' |');
    });
    if (R.rauschen) { const z = R.rauschen; L.push('', 'Takt-Rauschen (A gegen A mit UA × 1,001): je Tag |Δ| Ø ' + de(z.tagKWhMittel, 2) + ' kWh (max ' + de(z.tagKWhMax, 2) + '), Ø ' + de(z.tagEuroMittel, 3) + ' € (max ' + de(z.tagEuroMax, 3) + '); über ' + R.meta.tage + ' Tage ' + sg(z.summeKWh, 2) + ' kWh, ' + sg(z.summeEuro, 3) + ' € bereinigt, ' + sg(z.unterMin, 0) + ' min unter Minimum.'); }
    if (R.ereignisse && R.ereignisse.length) {
        L.push('', '## Je Vorziehen-Tag (Potenzial: (c) aus, ohne Nacht −1 K) – B − A', '', '| Tag | min +1 K | Δ kWh el 12–17 Uhr | Δ kWh el 17–06 Uhr | Δ € 12–06 Uhr | Δ SOC 06 Uhr (%-Pkt.) | Δ Hausmittel 17 Uhr / 06 Uhr K |', '|---|---|---|---|---|---|---|');
        R.ereignisse.forEach(x => L.push('| ' + kurzTag(x.tag) + ' | ' + x.minPlus + ' | ' + sg(x.dKWhFenster, 2) + ' | ' + sg(x.dKWhNacht, 2) + ' | ' + sg(x.dEuro, 3) + ' | ' + sg(x.dSoc06, 1) + ' | ' + sg(x.dTh17, 2) + ' / ' + sg(x.dTh06, 2) + ' |'));
        const S_ = k => R.ereignisse.reduce((a, x) => a + x[k], 0);
        L.push('| **Summe** | ' + S_('minPlus') + ' | ' + sg(S_('dKWhFenster'), 2) + ' | ' + sg(S_('dKWhNacht'), 2) + ' | ' + sg(S_('dEuro'), 3) + ' | | |');
    }
    if (R.potenzial) {
        const Pz = R.potenzial, z = r => r.summe, u = r => RAEUME.reduce((x, rr) => x + r.summe.unterMin[rr.id], 0), ue = r => RAEUME.reduce((x, rr) => x + r.summe.ueberMax[rr.id], 0);
        L.push('', '## Potenzial Tag → Nacht (Oktober): A, N „nur Nacht −1 K“, B** „Vorziehen ohne (c) + Nacht −1 K immer“', '', '| Variante | kWh el | kWh th | Starts | min +1 K / −1 K | Bezug kWh | Einspeisung kWh | Kosten € bereinigt | DESS-nah € | min unter Minimum / über Maximum | Hausmittel |', '|---|---|---|---|---|---|---|---|---|---|---|');
        [['A', Pz.A], ['N', Pz.N], ['B**', Pz.B2]].forEach(([n, r]) => { const d = dessPfad(ctxRef.ctx, r.spur.wp); L.push('| ' + n + ' | ' + de(z(r).kwhEl, 2) + ' | ' + de(z(r).kwhTh, 1) + ' | ' + z(r).starts + ' | ' + z(r).minPlus + ' / ' + z(r).minMinus + ' | ' + de(z(r).bezugTag + z(r).bezugNacht, 2) + ' | ' + de(z(r).einsp, 1) + ' | ' + de(bereinigt(r, Pz.A, P), 2) + ' | ' + de(d.summe.kosten, 2) + ' | ' + u(r) + ' / ' + ue(r) + ' | ' + de(z(r).hausMittel, 2) + ' |'); });
        const e = Pz.ereignisse, S_ = k => e.reduce((a, x) => a + x[k], 0);
        L.push('', 'B** − N je Vorziehen-Tag: ' + e.map(x => kurzTag(x.tag) + ' ' + sg(x.dKWhFenster, 2) + '/' + sg(x.dKWhNacht, 2) + ' kWh, ' + sg(x.dEuro, 3) + ' €').join('; ') + ' · Summe Fenster ' + sg(S_('dKWhFenster'), 2) + ' kWh, Nacht ' + sg(S_('dKWhNacht'), 2) + ' kWh, ' + sg(S_('dEuro'), 3) + ' €.');
    }
    const W = R.winter;
    L.push('', '## Winter-Abschätzung (synthetisch, MODELL – keine Daten unter 1 °C)', '', 'Sonniger Wintertag (AT max +3 °C um 15 Uhr, min −5 °C um 03 Uhr, Feuchte 85 %), PV-Spitze ' + de(W.pvSpitzeKW, 1) + ' kW (¼ des 95-%-Werts der Oktober-PV) 08:30–15:30, Hauslast ohne WP = Median-Stundenprofil Oktober, perfekte Prognose, Akku um 06:00 am Minimum. Tag 1 06:00 bis Tag 2 06:00. B*/D* = Vorziehen erzwungen 12–15 Uhr (ohne (a) und (c)); N = nur Nacht −1 K 15–06 Uhr; B** = B* mit Nacht −1 K ohne Raumbedingung (B** − N = Wirkung des Vorziehens).', '');
    L.push('| Einstellung | Variante | kWh el (Heizstab) | kWh th | COP | Starts | min +1 K / −1 K | SOC Tag 2 06 Uhr | Bezug Tag / Nacht kWh | Einspeisung kWh | Kosten € | min unter Minimum | Hausmittel Ø |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    ['q0', 'q3'].forEach(qq => Object.keys(W[qq]).forEach(v => { const w = W[qq][v].fenster; L.push('| ' + (qq === 'q3' ? 'Quiet 3, Efficiency, ohne Grundverschiebung' : 'Quiet 0, Comfort, Grundverschiebung +' + WINTER_BASIS_K + ' K') + ' | ' + v + ' | ' + de(w.kwhEl, 2) + ' (' + de(w.kwhHs, 2) + ') | ' + de(w.kwhTh, 1) + ' | ' + de(w.cop, 2) + ' | ' + w.starts + ' | ' + w.minPlus + ' / ' + w.minMinus + ' | ' + de(w.soc06, 1) + ' | ' + de(w.bezugTag, 2) + ' / ' + de(w.bezugNacht, 2) + ' | ' + de(w.einsp, 2) + ' | ' + de(w.kosten, 2) + ' | ' + RAEUME.reduce((x, rr) => x + w.unterMin[rr.id], 0) + ' | ' + de(w.hausMittel, 2) + ' |'); }));
    L.push('', '## Anhang: je Variante und Tag (Basis; Akku „Eigenverbrauch“, in Klammern Kosten DESS-nah)', '');
    V.forEach(v => {
        const r = B[v];
        L.push('### ' + VARIANTEN[v], '', '| Tag | kWh el | kWh th | COP | Starts | min +1 K / −1 K | SOC 06 Uhr | Bezug Tag / Nacht kWh | Einspeisung kWh | Kosten € (DESS-nah) | min unter Minimum ki_oben/ki_unten/schlaf/wohn | min über Maximum | Hausmittel |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
        r.tage.concat([r.summe]).forEach((o, k) => { const d = k < r.tage.length ? r.dess.tage[k] : r.dess.summe; L.push('| ' + (k < r.tage.length ? kurzTag(o.tag) : '**Summe**') + ' | ' + de(o.kwhEl, 2) + ' | ' + de(o.kwhTh, 1) + ' | ' + de(o.cop, 2) + ' | ' + o.starts + ' | ' + o.minPlus + ' / ' + o.minMinus + ' | ' + de(k < r.tage.length ? o.soc06 : o.soc06Mittel, 0) + ' | ' + de(o.bezugTag, 2) + ' / ' + de(o.bezugNacht, 2) + ' | ' + de(o.einsp, 1) + ' | ' + de(o.kosten, 2) + ' (' + de(d.kosten, 2) + ') | ' + komfortMin(o, 'unterMin') + ' | ' + komfortMin(o, 'ueberMax') + ' | ' + de(o.hausMittel, 2) + ' |'); });
        L.push('');
    });
    L.push('', 'Laufzeit: Validierung ' + de(R.laufzeit.validierung, 1) + ' s, Basis ' + de(R.laufzeit.basis, 1) + ' s, mit Sensitivität ' + de(R.laufzeit.sensitivitaet, 1) + ' s, gesamt ' + de(R.laufzeit.gesamt, 1) + ' s.');
    return L.join('\n') + '\n';
}

// ------------------------------------------------------------------ Diagramm (SVG, Beispieltag): SOC, Raum-Mittel, Verschiebung A gegen D
function svgTag(ctx, R, tag) {
    const i0 = Math.round((new Date(tag + 'T00:00:00').getTime() - ctx.t0) / MIN), n = 1440 + 360;
    if (i0 < 0) { return null; }
    const Wd = 900, Hp = 150, mx = 60, top = 30, gap = 30, panels = [
        {titel: 'Akku-SOC % (Modell Eigenverbrauch; grau: gemessen)', lo: 0, hi: 100, ticks: [0, 50, 100], reihen: [[ctx.en.soc, '#999', 1], [R.basis.A.spur.soc, '#1f77b4', 2], [R.basis.D.spur.soc, '#d62728', 2]]},
        {titel: 'Hausmittel Zwilling °C (grau: gemessen)', lo: 19.5, hi: 22.5, ticks: [19.5, 20.5, 21.5, 22.5], reihen: [[ctx.M.map(m => m.th), '#999', 1], [R.basis.A.spur.th, '#1f77b4', 2], [R.basis.D.spur.th, '#d62728', 2]]},
        {titel: 'Verschiebung K (A blau, D rot) und PV in 10 kW (gelb)', lo: -1.5, hi: 1.5, ticks: [-1, 0, 1], reihen: [[Array.from(ctx.en.pv).map(x => x / 10), '#e0b000', 1], [R.basis.A.spur.shift, '#1f77b4', 2], [R.basis.D.spur.shift, '#d62728', 2]]}];
    const H = top + panels.length * (Hp + gap) + 20, o = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + Wd + '" height="' + H + '" font-family="sans-serif" font-size="12"><rect width="100%" height="100%" fill="#fff"/>',
        '<text x="' + mx + '" y="18" font-size="14">Beispieltag ' + kurzTag(tag) + ' 00:00 bis Folgetag 06:00 – A „heute“ (blau) gegen D „−1 K + Vorziehen“ (rot), Modell</text>'];
    panels.forEach((p, k) => {
        const y0 = top + k * (Hp + gap) + 15, X = j => mx + (Wd - mx - 20) * j / n, Y = v => y0 + Hp - Hp * (v - p.lo) / (p.hi - p.lo);
        o.push('<rect x="' + mx + '" y="' + y0 + '" width="' + (Wd - mx - 20) + '" height="' + Hp + '" fill="none" stroke="#ccc"/>', '<text x="' + mx + '" y="' + (y0 - 4) + '">' + p.titel + '</text>');
        for (let hh = 0; hh <= 30; hh += 3) { const x = X(hh * 60); o.push('<line x1="' + x + '" x2="' + x + '" y1="' + y0 + '" y2="' + (y0 + Hp) + '" stroke="#eee"/><text x="' + (x - 8) + '" y="' + (y0 + Hp + 13) + '" fill="#666">' + pad(hh % 24) + '</text>'); }
        (p.ticks || [p.lo, (p.lo + p.hi) / 2, p.hi]).forEach(v => o.push('<text x="5" y="' + (Y(v) + 4) + '" fill="#666">' + de(v, 1) + '</text>'));
        p.reihen.forEach(([arr, col, w]) => { const pts = []; for (let j = 0; j < n && i0 + j < arr.length; j++) { const v = arr[i0 + j]; if (v !== null && v !== undefined && isFinite(v)) { pts.push(X(j).toFixed(1) + ',' + Y(Math.max(p.lo, Math.min(p.hi, v))).toFixed(1)); } } o.push('<polyline fill="none" stroke="' + col + '" stroke-width="' + w + '" points="' + pts.join(' ') + '"/>'); });
    });
    o.push('</svg>');
    return o.join('\n');
}

function cli(argv) {
    const dir = argv[0], pf = argv[1];
    if (!dir || !pf || !fs.existsSync(dir) || !fs.existsSync(pf)) { console.error('Usage: node tools/vorziehen_sim.js <Datenordner> <wp_params.json> [--von JJJJ-MM-TT] [--bis JJJJ-MM-TT] [--md Datei] [--json Datei] [--svg Datei] [--svg-tag JJJJ-MM-TT] [--schnell]'); process.exitCode = 2; return null; }
    const arg = k => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[i + 1] : null; };
    const PR = JSON.parse(fs.readFileSync(pf, 'utf8')), P = Z.mitWerten(PR.werte || PR);
    const t0 = process.hrtime.bigint();
    const ctx = ladeDaten(dir, arg('--von') || '2026-10-08', arg('--bis') || '2026-10-19');
    const tLade = Number(process.hrtime.bigint() - t0) / 1e9;
    const R = alles(ctx, P, {schnell: argv.indexOf('--schnell') >= 0});
    R.laufzeit.laden = rd(tLade, 1); R._ctx = ctx;
    R.tagAt = {}; R.tagPv = {};
    for (let i = 0; i < ctx.N; i++) { const tg = ymd(ctx.t0 + i * MIN); (R.tagAt[tg] = R.tagAt[tg] || []).push(ctx.M[i].at); R.tagPv[tg] = (R.tagPv[tg] || 0) + ctx.en.pv[i] / 60; }
    Object.keys(R.tagAt).forEach(k => { R.tagAt[k] = mean(R.tagAt[k]); });
    const md = '_Zwilling ' + (PR.daten ? PR.daten.ordner + ' (' + PR.daten.von + ' bis ' + PR.daten.bis + ')' : pf) + ', ch ' + P.ch + ' kWh/K, Sonne ' + P.sonne + ' kW/kW PV, UA ' + P.ua + ' kW/K; Laden der Protokolle ' + de(tLade, 1) + ' s_\n\n' + markdown(R, P);
    if (arg('--md')) { fs.writeFileSync(arg('--md'), md); }
    if (arg('--svg')) { (arg('--svg-tag') || '2026-10-12').split(',').forEach((tg, k) => { const s = svgTag(ctx, R, tg); if (s) { fs.writeFileSync(k ? arg('--svg').replace(/\.svg$/, '_' + tg + '.svg') : arg('--svg'), s); } }); }
    if (arg('--json')) {
        const kurz = s => ({name: s.name, A: s.A.summe, B: s.B.summe, C: s.C.summe, D: s.D.summe, dess: {A: s.A.dess.summe, B: s.B.dess.summe, C: s.C.dess.summe, D: s.D.dess.summe}});
        fs.writeFileSync(arg('--json'), JSON.stringify({meta: R.meta, laufzeit: R.laufzeit, messung: R.messung, validierung: R.validierung, dessBefund: R.dessBefund, a0: R.a0.tage,
            basis: {A: R.basis.A.tage, B: R.basis.B.tage, C: R.basis.C.tage, D: R.basis.D.tage, dess: {A: R.basis.A.dess.tage, B: R.basis.B.dess.tage, C: R.basis.C.dess.tage, D: R.basis.D.dess.tage}, logB: R.basis.B.politik.log, nB: R.basis.B.politik.n, nC: R.basis.C.politik.n, nD: R.basis.D.politik.n},
            sens: [R.basis].concat(R.sens).map(kurz), winter: {pvSpitzeKW: R.winter.pvSpitzeKW, restProfil: R.winter.restProfil, q3: Object.fromEntries(Object.keys(R.winter.q3).map(v => [v, R.winter.q3[v].fenster])), q0: Object.fromEntries(Object.keys(R.winter.q0).map(v => [v, R.winter.q0[v].fenster]))}}, null, 1) + '\n');
    }
    console.log(md);
    return R;
}
module.exports = {ereignisse, AKKU, PREIS, RAEUME, POLITIK, VARIANTEN, akkuSchritt, dessSchritt, snapshotVor, atFc, pvFc, consFc, entscheidung, politikNeu, politik, preisKauf, preisVerkauf,
                  ladeDaten, ladeForecast, wpMessung, lauf, dessPfad, messung, validiereAkku, dessBefund, winterKontext, laufWinter, alles, markdown, svgTag, cli, summe, tagNeu};
if (require.main === module) { cli(process.argv.slice(2)); }

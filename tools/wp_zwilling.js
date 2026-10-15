// Anlagen-Zwilling der Panasonic Leisha WH-WDG05LE5 (5 kW, R290, Heizkörper, Zone 1) samt Haus – Minutentakt, Fake-Uhr, deterministisch.
// Reine Funktionen: kein Date.now, kein Math.random, kein Dateizugriff. Schaltet nichts, sendet nichts.
//
// Aufbau (Teile in der Reihenfolge eines Minutenschritts, je Teil die Parameter in PARAM mit Herkunft):
//   Soll      ceil(Heizkurve(AT)) + Verschiebung, 5-min-Raster (oder Soll von Hand)
//   Zustand   Heizgrenze-Aus (Pumpe aus) / Pause (Pumpe läuft) / Lauf / Abtauen (im Lauf); Start nach Verzug unter Soll − startK, Stopp bei Soll + stopK
//   Verdichter Startspitze, Regler Comfort/Efficiency, Mindestfrequenz (Frost-Tabelle), Höchstfrequenz je AT, Quiet-Deckel
//   Thermik   Pth(Hz, AT), Pel(Hz, AT, RL) + 80 W, Wasserkreis (Heizkörper-Mittel tw, Abgabe krad·(tw − th)^n), Haus th, Räume
//   Winter    Rohrtemperatur außen, Vereisung, Abtau-Auslöser (Handbuch J + Forum), Heizstab (Handbuch J + Einstellungen der Anlage)
// Herkunft: M = Messung/gefittet an dieser Anlage, F = Forum photovoltaikforum 189605 (Beitrags-ID), H = Servicehandbuch Serie J (nur bedingt übertragbar),
//           A = Annahme, N = Vorgabe/Einstellung des Nutzers, S = Datenblatt (Forum-Zitat).
// Training: tools/wp_training.js schätzt die M-Parameter aus den Minutenprotokollen und schreibt wp_params.json ({werte, herkunft, guete}).
'use strict';

const MIN = 60000, DT = 1 / 60;                       // Minutenschritt in Stunden
const CP = 4.186 / 60;                                // kW je (l/min · K)

// ------------------------------------------------------------------ Parameter mit Herkunft: [Wert, Einheit, Herkunft, Quelle]
const PARAM = {
    // Soll und Heizgrenze
    kurve: [[-13, 11, 29, 37], '°C', 'N', 'Heizkurve Z1: Außen −13 °C → 37 °C (bis 13.10. 13:00 38 °C), 11 °C → 29 °C (Z1_Heat_Curve_*)'],
    sollRasterMin: [5, 'min', 'M', 'Soll ändert sich nur im 5-min-Raster (OPTIMIERER 2; „Soll folgt binnen 6 min“)'],
    hgAus: [15, '°C', 'M', 'Heizgrenze 12: aus ab Fühler 15 °C (5/5 Übergänge 07.–15.10.)'],
    hgAn: [12, '°C', 'M', 'Heizgrenze 12: an bei Fühler ≤ 12 °C (5/5)'],
    hgStartMin: [3, 'min', 'M', 'nach dem Ende des Heizgrenze-Aus startet der Verdichter nach 3–4 min (3/3: 10.10., 13.10., 14.10.)'],
    // Start/Stopp
    startK: [3.25, 'K', 'M', 'Startschwelle: Vorlauf ≤ Soll − startK (Startschwellen-Analyse 14 Pausen: 3,25 K)'],
    startVerzugMin: [9, 'min', 'M', 'Start, sobald die Schwelle seit so vielen Minuten erreicht ist (Median 9 min, 6–13)'],
    startHystK: [0.5, 'K', 'M', 'die Wartezeit beginnt neu, wenn der Vorlauf wieder mehr als so viel über die Schwelle steigt (Fühler im 0,25-K-Raster flattert)'],
    stopK: [3.0, 'K', 'M', 'Stopp bei Vorlauf ≥ Soll + 3,0…3,25 K (20/20)'],
    stopHaltMin: [3, 'min', 'F', '„Vorlauf 3 min lang > Soll + 3 K“ (L7 4004893, M)'],
    minPauseMin: [3, 'min', 'H', 'Verdichter startet frühestens 3 min nach dem Stopp (Handbuch J 16.1.1)'],
    // Verdichter
    hzMin: [16.5, 'Hz', 'M', 'Minimum 16–17 Hz (wechselnd) bei 1–15 °C'],
    hzMinFrost: [[[-10, 35], [-4, 25]], 'Hz', 'F', 'Mindestfrequenz L5: ab ≤ −4 °C 25 Hz, ab ≤ −10 °C 35 Hz, unabhängig vom Flüstermodus (4596796, 4593782, 4593801)'],
    hzMaxTab: [[[-4, 59], [-3, 52], [5, 35], [11, 34], [13, 31], [15, 30]], 'Hz', 'M/F', 'Höchstfrequenz je AT: M Comfort/Quiet 0 35 Hz bei 6 °C, 31 Hz bei 13 °C, Boost 33–34 Hz bei 11 °C; F L5 +5 °C 35 Hz, +10 °C 30 Hz (4132106, 4134403), 52 Hz über −4 °C, 59 Hz ab −4 °C (4132106 M, 4132035 V/E)'],
    spike: [[33, 24], 'Hz', 'M', 'Startspitze Laufminute 0/1 (Median 32 Starts), unabhängig von Quiet (F L7 4187405: „Startspike trotzdem 34 Hz“)'],
    capQ3: [17, 'Hz', 'M', 'Quiet 3 hält 16–17 Hz (1–14 °C)'],
    capQ2kalt: [21, 'Hz', 'M', 'Quiet 2 bis 20–21 Hz bei 1–4 °C (12.10., 168 min)'],
    capQ2warm: [17, 'Hz', 'M', 'Quiet 2 hält 16–17 Hz bei 12–13 °C'],
    capQ2grenze: [7, '°C', 'M', 'Grenze zwischen beiden Quiet-2-Deckeln (DECKEL-Tabelle, engine_core)'],
    capQ1: [21, 'Hz', 'M', 'Quiet 1 bis 20–21 Hz bei 12 °C (13.10., 28 min); bei Frost unbekannt'],
    // Regler (Training: Rastersuche gegen die gemessene Frequenz bei gemessenem Vorlauf)
    regSenkK: [1.25, 'K', 'M', 'Vorlauf ≥ Soll + x K: Frequenz fährt auf das Minimum zurück (F L7 4002439: Abmodulation ab Soll + 1,5 K)'],
    regAbHzMin: [1.0, 'Hz/min', 'M', 'Rampe nach unten'],
    comfortWiederK: [1.5, 'K', 'M', 'Comfort: nach dem Abregeln erst wieder auf den Deckel, wenn der Vorlauf so weit unter Soll fällt (12.10.: 25 Hz gehalten)'],
    effT1: [19, 'min', 'M', 'Efficiency: erste Anhebung frühestens ab Laufminute x'],
    effK1: [2.25, 'K', 'M', 'Efficiency: erste Anhebung bei Vorlauf ≤ Soll − x K'],
    effL1: [21, 'Hz', 'M', 'Efficiency: Obergrenze der ersten Anhebung'],
    effT2: [39, 'min', 'M', 'Efficiency: zweite Anhebung ab Laufminute x (gemessen 39–46)'],
    effK2: [1.25, 'K', 'M', 'Efficiency: zweite Anhebung bei Vorlauf ≤ Soll − x K'],
    effKp: [3.0, 'Hz/K', 'M', 'Efficiency: Anhebung = kp · Rückstand des Vorlaufs'],
    effKi: [0.05, 'Hz/min', 'M/A', 'Efficiency: langsames Nachschieben bei bleibendem Rückstand ab der zweiten Stufe (Boost 10.10.: 29 → 34 Hz)'],
    // Thermik (Training: kleinste Quadrate)
    pthHz: [121, 'W/Hz', 'M', 'Wärme je Hz bei 5 °C (stabile Laufminuten)'],
    pthHzAT: [0.5, 'W/(Hz·K)', 'M', 'Zunahme der Wärme je Hz und K Außentemperatur'],
    pthEnde: [0.05, '1/K', 'M', 'gemessen steigt die Wärme (Durchfluss × Spreizung) am Laufende: +x je K Vorlauf über Soll + 1 K (16–17 Hz: 2050 W bei Soll ±1 K, 2200–2350 W bei +2…+3 K; Ursache unklar, empirisch)'],
    pthFrostAb: [1, '°C', 'F/A', 'unter dieser AT fällt die Wärme je Hz stärker (keine eigenen Daten)'],
    pthFrostJeK: [0.045, '1/K', 'F', 'Abfall je K unter pthFrostAb; Anker: L5 −2 °C 16 Hz ≈ 1,6 kW (4596796), −3 °C 16 Hz ≈ 1,5 kW (4606872), −4 °C 25 Hz ≈ 2 kW (4596796)'],
    pthFrostMin: [0.70, '–', 'S/A', 'Untergrenze des Faktors; Anker Datenblatt ~5 kW bei −7 °C (3661016) und 59 Hz'],
    pelFrostAnteil: [0.6, '–', 'F/S', 'Anteil des Frost-Faktors, um den auch die Verdichterleistung sinkt (Massenstrom); kalibriert auf COP −3 °C ≈ 3,7 (L5 4013336) und −7 °C ≈ 3,0 (Datenblatt 3661016)'],
    pel0: [-119, 'W', 'M', 'TOP16 = pel0 + Hz · (pelHz + pelRL · Rücklauf + pelAT · AT); bei 16,5 Hz ≈ 10 W je K Rücklauf (bekannt: 12 W/K)'],
    pelHz: [11.4, 'W/Hz', 'M', 'Strom je Hz (Formel bei pel0)'],
    pelRL: [0.634, 'W/(Hz·K)', 'M', 'Strom je Hz und K Rücklauf (Formel bei pel0)'],
    pelAT: [-0.284, 'W/(Hz·K)', 'M', 'Strom je Hz und K Außentemperatur (Formel bei pel0)'],
    pelKorrW: [80, 'W', 'F/M', 'TOP16 untertreibt im Lauf um 70–90 W (L5 4545989, 4597230); nur bei laufendem Verdichter'],
    pelPauseW: [34, 'W', 'M', 'TOP16 in der Pause mit Pumpe'],
    pelAusW: [15, 'W', 'M', 'TOP16 im Heizgrenze-Aus (Pumpe aus)'],
    // Pumpe
    flowPause: [13.4, 'l/min', 'M', 'Durchfluss in der Pause (Pumpe 1750 U/min)'],
    flowComfort: [13.4, 'l/min', 'M', 'Comfort: ΔT-geregelt, Pumpe 1750 U/min'],
    flowEff: [[25, 22.5, 50, 95], 'min, l/min, min, min', 'M', 'Efficiency: bis Laufminute a 13,4 l/min, dann b l/min bis Minute c, linear zurück bis Minute d'],
    flowHgNeustart: [35, 'l/min', 'M', 'Spülen beim Ende des Heizgrenze-Aus (33,8–37,7 l/min, 3 min)'],
    flowAbtau: [21, 'l/min', 'F', 'L5 Abtauen: Volumenstrom 10 → 17 → 21 l/min (4288323)'],
    pumpe0: [1750, 'U/min', 'M', 'Pumpendrehzahl bei 13,4 l/min'],
    pumpeJeL: [117, 'U/min je l/min', 'M', 'Comfort → Efficiency: 1750 → 2870 U/min bei 13,4 → 23 l/min'],
    // Lüfter (nur Ausgabe)
    fanQ: [[330, 270, 270, 220], 'U/min', 'M', 'Lüfter am Minimum je Quiet 0/1/2/3 (Median; Forum L5 4504115 ähnlich)'],
    fanJeHz: [8, 'U/min je Hz', 'M', 'Lüfter-Zunahme je Hz über dem Minimum'],
    // Wasserkreis (Training: Simulation gegen Vor-/Rücklauf)
    cw: [0.55, 'kWh/K', 'M', 'Wärmespeicher Wasser + Heizkörper'],
    krad: [0.12, 'kW/K^n', 'M', 'Heizkörperabgabe krad · (tw − th)^n'],
    nrad: [1.3, '–', 'A', 'Heizkörper-Exponent (EN 442, typisch 1,3)'],
    cr: [0.3, 'kWh/K', 'M', 'Raumluft/Oberflächen an den Heizkörpern (schneller Knoten zwischen Heizkörper und Hausmasse)'],
    hr: [0.6, 'kW/K', 'M', 'Übergang schneller Knoten → Hausmittel'],
    kv: [0, '1/K', 'M', 'Thermostatventile: Abgabe × max(0,2; 1 − kv · (tr − tvRef)) – je wärmer die Luft an den Heizkörpern, desto weniger Abgabe (Ventile am 15.10. nachgestellt)'],
    tvRef: [22, '°C', 'A', 'Bezug der Ventil-Drosselung'],
    tauLokMin: [240, 'min', 'A', 'Fühler im Innengerät bei stehender Pumpe: Auskühlen zur Raumtemperatur'],
    // Haus (Training: kleinste Quadrate auf Stundenwerten)
    ua: [0.141, 'kW/K', 'M', 'Wärmeverlust des Hauses (plan_algo: 141 W/K)'],
    gain: [0.38, 'kW', 'M', 'innere Gewinne (plan_algo: 0,38 kW)'],
    ch: [3.0, 'kWh/K', 'M/A', 'Speichermasse des Hausmittels'],
    sonne: [0.05, 'kW je kW PV', 'M', 'Sonnengewinn je kW PV-Leistung (PV als Strahlungsmaß)'],
    hausAtTauMin: [240, 'min', 'M', 'die Hülle sieht die Außentemperatur geglättet (Speichermasse der Wände; besser als ungeglättet: RMSE 0,65 statt 0,84 K)'],
    // Räume (Training: kleinste Quadrate je Raum) – Abweichung vom Hausmittel: T = th + a + b·(twF − th) + c·(th − ATF) + d·PVF
    // twF = Heizkörper-Mittel gefiltert (Zeitkonstante tau je Raum), ATF = AT gefiltert (6 h), PVF = PV gefiltert (2 h); je Raum [a (K), b, c, d (K/kW), tau (min), Bereich twF−th lo, hi, Bereich th−ATF lo, hi]
    // Außerhalb des gemessenen Bereichs wird nicht extrapoliert (Merkmal auf den Bereich begrenzt).
    raeume: [{ki_oben: [1.8, 0, 0, 0, 120, 0, 20, 0, 40], ki_unten: [0.3, 0, 0, 0, 120, 0, 20, 0, 40], schlaf: [-0.3, 0, 0, 0, 120, 0, 20, 0, 40], wohn: [1.5, 0, 0, 0, 120, 0, 20, 0, 40]}, 'K, –, –, K/kW, min, K…', 'M', 'je Raum Abweichung vom Hausmittel (Kinderzimmer oben ohne eigenes Relais/Heizlüfter-Modell: mittleres Verhalten); keine Extrapolation über den gemessenen Bereich'],
    raumAtTauMin: [360, 'min', 'A', 'Zeitkonstante des AT-Filters für die Räume'],
    raumPvTauMin: [120, 'min', 'A', 'Zeitkonstante des PV-Filters für die Räume'],
    // Rohrtemperatur außen (Verdampfer) – Training: kleinste Quadrate (Spalte rohr_aussen ab 14.10.)
    pipe0: [1.36, 'K', 'M', 'AT − Rohr = pipe0 + pipeQ · Verdampferleistung (kW) · 300 / Lüfter (U/min); mit Lüfter besser als ohne (RMSE 0,92 statt 1,07 K); Frost: Lüfter L5 630 U/min bei −13 °C (F 4600750)'],
    pipeQ: [1.05, 'K/kW', 'M', 'siehe pipe0'],
    pipeTauMin: [3, 'min', 'A', 'Zeitkonstante des Rohrfühlers'],
    pipeSprungK: [0.7, 'K/Hz', 'F/A', 'Pseudo-Abtauung: Frequenzsprung über +30 % des langsamen Mittels senkt das Rohr (L5 4540566: 1 → −16 °C; L7 4230252; Schwelle 4868882 V)'],
    pipeSprungAnteil: [0.3, '–', 'F', 'gefährlicher Sprung ab etwa +30 % (4868882, V)'],
    pipeSlowMin: [30, 'min', 'A', 'Zeitkonstante des langsamen Frequenzmittels (träges Expansionsventil, F 4368657 E)'],
    // Abtauen (keine eigenen Daten: Herkunft F/H/A)
    abtauAtMax: [5, '°C', 'H', 'Abtau-Logik nur bei niedriger Außentemperatur (Handbuch J 15.2.2; Force-Defrost-Grenze 5 °C)'],
    abtauLinie: [[-13.5, 0.6], '°C', 'F/A', 'Auslöser Rohr < a + b·(AT + 9): Anker „OutsidePipe 2 min unter −13/−14 °C bei −9 °C“ (4600685 E), Linie der L ~5 K höher als im Handbuch (4890839, 4371449)'],
    abtauHaltMin: [3, 'min', 'H', 'Rohr 3 min am Stück unter der Linie (Handbuch J 15.2.2)'],
    abtauMinHeizMin: [35, 'min', 'H/F', 'Heizzeit seit der letzten Abtauung > 35 min (Handbuch J; L7 4613622)'],
    abtauDauerMin: [8, 'min', 'F', 'L5: 8 min (4288323); J ~9 min (4598540), Handbuch max. 9,5 min'],
    abtauWaermeKWh: [0.5, 'kWh', 'A', 'Wärmeentzug aus dem Heizwasser je Abtauung (im Forum nicht beziffert)'],
    abtauHz: [58, 'Hz', 'F', 'Abtauen bei ~58 Hz (L5 4092731, L7 4548650)'],
    abtauPelW: [1000, 'W', 'A', 'Stromaufnahme beim Abtauen (TOP16)'],
    nachAbtauEffMin: [20, 'min', 'F', 'Efficiency hält nach dem Abtauen ~20 min niedrige Frequenz (L5 4582615, L7 4095732)'],
    nachAbtauComfortHz: [50, 'Hz', 'F', 'nach dem Abtauen startet die L5 normalerweise mit ~50 Hz (4542523); hier 3 min, gedeckelt durch die Höchstfrequenz'],
    eisRate: [0.02, '1/(min·K)', 'A', 'Vereisung je min und K (Taupunkt − Rohr), wirkt als Rohrabsenkung 1 K je Einheit; kalibriert auf den Forum-Anker'],
    eisAnker: [[0, 90, 90], '°C, %, min', 'F/A', 'Kalibrieranker: bei 0 °C, 90 % Feuchte und Mindestlast Abtauung alle ~90 min (L5 gedämmt „worst case ~90 min“ 4879325 E; L9 0,8 °C 94 %: 35 min und 1:40 h 4132154)'],
    eisSchmelzJeK: [0.02, '1/(min·K)', 'A', 'Abbau der Vereisung im Stillstand je K über 0 °C'],
    forceDefrostAuto: [0, '0/1', 'H', 'Force Defrost „Auto“ (alle 3 h unter 5 °C) – Werkseinstellung Manual (Handbuch J Z. 6965); bei der L nicht belegt'],
    // Heizstab (Einstellungen gemessen, Logik Handbuch J)
    hsFrei: [1, '0/1', 'M', 'heizstab_raum_frei = 1 im Protokoll; ob der Heizstab an der Anlage wirklich freigegeben ist, ist offen (L ab Werk aus, F 3957497)'],
    hsOnAT: [0, '°C', 'M', 'Heater_On_Outdoor_Temp 0 °C'],
    hsStartK: [-3, 'K', 'M', 'Heater_Start_Delta −3 K'],
    hsStopK: [-1, 'K', 'A', 'Aus bei Vorlauf ≥ Soll − 1 K (Hysterese 2 K wie im Forum-Beispiel 4581693; Heater_Stop_Delta nicht im Protokoll)'],
    hsDelayMin: [15, 'min', 'M', 'Heater_Delay_Time 15 min nach Thermo-Ein'],
    hsPumpeMin: [9, 'min', 'H', 'nach 9 min Pumpenlauf (Handbuch J 14.6.1)'],
    hsSperreMin: [20, 'min', 'H', '20 min seit dem letzten Aus (Handbuch J 14.6.1)'],
    hsKW: [3, 'kW', 'A', 'Heizstab-Leistung (L-Innengerät 3 kW, nicht gemessen)'],
    hsBeimAbtauen: [0, '0/1', 'F', 'die L schaltet den Heizstab beim Abtauen nicht zu (L5 4879325, 4288323); Handbuch J: bei Wassereintritt < 27 °C schon'],
    heizgrenzeEinstellung: [12, '°C', 'M', 'Heating_Off_Outdoor_Temp (Einstellung, für die Maschine)']
};
function standard() { const o = {}; Object.keys(PARAM).forEach(k => { o[k] = JSON.parse(JSON.stringify(PARAM[k][0])); }); return o; }
function herkunft() { const o = {}; Object.keys(PARAM).forEach(k => { o[k] = {einheit: PARAM[k][1], herkunft: PARAM[k][2], quelle: PARAM[k][3]}; }); return o; }
function mitWerten(werte) { const P = standard(); Object.keys(werte || {}).forEach(k => { if (k in P) { P[k] = JSON.parse(JSON.stringify(werte[k])); } }); return P; }

// ------------------------------------------------------------------ Kennlinien
function lerp(x, x0, y0, x1, y1) { return x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
function tab(T, x) { if (x <= T[0][0]) { return T[0][1]; } for (let i = 1; i < T.length; i++) { if (x <= T[i][0]) { return lerp(x, T[i - 1][0], T[i - 1][1], T[i][0], T[i][1]); } } return T[T.length - 1][1]; }
function kurveSoll(P, at) { const k = P.kurve; if (at <= k[0]) { return k[3]; } if (at >= k[1]) { return k[2]; } return k[3] + (k[2] - k[3]) * (at - k[0]) / (k[1] - k[0]); }
function hzMinAt(P, at) { for (let i = 0; i < P.hzMinFrost.length; i++) { if (at <= P.hzMinFrost[i][0]) { return P.hzMinFrost[i][1]; } } return P.hzMin; }
function hzMaxAt(P, at) { return tab(P.hzMaxTab, at); }
function capOf(P, q, at) {
    const mn = hzMinAt(P, at), mx = hzMaxAt(P, at);
    let c = q === 0 ? mx : (q === 1 ? P.capQ1 : (q === 2 ? (at < P.capQ2grenze ? P.capQ2kalt : P.capQ2warm) : P.capQ3));
    return Math.max(mn, Math.min(c, mx));                                        // F: keine Stufe deckelt unter die Mindestfrequenz
}
function frostFaktor(P, at) { return at >= P.pthFrostAb ? 1 : Math.max(P.pthFrostMin, 1 - P.pthFrostJeK * (P.pthFrostAb - at)); }
function pthOf(P, hz, at, vlRel) { if (!(hz > 0)) { return 0; } return hz * (P.pthHz + P.pthHzAT * (at - 5)) * frostFaktor(P, at) * (1 + P.pthEnde * Math.max(0, (vlRel || 0) - 1)); }   // W; vlRel = Vorlauf − Soll
function pelOf(P, hz, at, rl) {                                                   // W, TOP16 roh (ohne Korrektur)
    if (!(hz > 0)) { return 0; }
    const g = 1 - P.pelFrostAnteil * (1 - frostFaktor(P, at));
    return Math.max(80, P.pel0 + hz * (P.pelHz + P.pelRL * rl + P.pelAT * at) * g);
}
function fanOf(P, q, hz) { return hz > 0 ? P.fanQ[Math.max(0, Math.min(3, q))] + P.fanJeHz * Math.max(0, hz - P.hzMin) : 0; }
function taupunkt(at, rh) { if (rh === null || rh === undefined || !(rh > 0)) { return -99; } const a = 17.62, b = 243.12, g = Math.log(Math.min(100, rh) / 100) + a * at / (b + at); return b * g / (a - g); }
function flowEffOf(P, rt) { const f = P.flowEff; if (rt < f[0]) { return P.flowComfort; } if (rt < f[2]) { return f[1]; } if (rt < f[3]) { return lerp(rt, f[2], f[1], f[3], P.flowComfort); } return P.flowComfort; }
function qrad(P, tw, tr) { const d = tw - tr; return d > 0 ? P.krad * Math.pow(d, P.nrad) * Math.max(0.2, 1 - (P.kv || 0) * (tr - P.tvRef)) : 0; }   // kW, tr = schneller Raumknoten an den Heizkörpern
function trAus(P, tw, th) { let lo = Math.min(th, tw), hi = Math.max(th, tw); for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (qrad(P, tw, m) > P.hr * (m - th)) { lo = m; } else { hi = m; } } return (lo + hi) / 2; }   // Gleichgewicht des schnellen Knotens
function heizkreis(P, tw, tr, th, pthKW) {                                         // ein Minutenschritt Wasserkreis + schneller Knoten; gibt {tw, tr, qr, qh}
    const qr = qrad(P, tw, tr), qh = P.hr * (tr - th);
    return {tw: tw + (pthKW - qr) * DT / P.cw, tr: tr + (qr - qh) * DT / P.cr, qr: qr, qh: qh};
}
function raumWert(pr, th, twF, atF, pvF) {
    const c = (x, lo, hi) => lo === undefined ? x : Math.max(lo, Math.min(hi, x));
    return th + pr[0] + pr[1] * c(twF - th, pr[5], pr[6]) + pr[2] * c(th - atF, pr[7], pr[8]) + pr[3] * pvF;
}
function hausSchritt(P, th, q, atH, pv) { return th + DT * (q - P.ua * (th - atH) + P.gain + P.sonne * (pv || 0)) / P.ch; }   // atH = geglättete AT (hausAtTauMin)
function r4(x) { return Math.round(x * 4) / 4; }

// ------------------------------------------------------------------ Zustand
// init: {modus 'lauf'|'pause'|'aus', tw, th, raeume {id: T}, rt, vl, soll, lvl, eis}
function neu(P, init) {
    init = init || {};
    const th = init.th !== undefined ? init.th : 21.5, tw = init.tw !== undefined ? init.tw : th + 6, tr = init.tr !== undefined ? init.tr : trAus(P, tw, th);
    const raeume = {}, rf = {}; Object.keys(P.raeume).forEach(id => { rf[id] = tw; raeume[id] = raumWert(P.raeume[id], th, tw, init.at !== undefined ? init.at : th - 10, 0); });
    return {t: null, modus: init.modus || 'pause', hgAus: init.modus === 'aus', hgNeu: 99, rt: init.rt || 0, pauseMin: init.pauseMin !== undefined ? init.pauseMin : 30, startZ: 0, stopZ: 0,
            hz: 0, lvl: init.lvl || 0, ab: false, hzSlow: P.hzMin, soll: init.soll !== undefined ? init.soll : null, sollT: -1e15,
            abtau: 0, heizMin: init.heizMin || 0, nachAbtau: 999, abZ: 0, eis: init.eis || 0, pipe: init.pipe !== undefined ? init.pipe : null,
            hs: 0, hsAus: 999, tw: tw, tr: tr, rf: rf, atF: init.at !== undefined ? init.at : null, atH: init.at !== undefined ? init.at : null, pvF: 0, tlok: init.vl !== undefined ? init.vl : tw, th: th, raeume: raeume,
            vl: init.vl !== undefined ? init.vl : tw, rl: init.rl !== undefined ? init.rl : tw, n: {starts: 0, abtau: 0, hsMin: 0, stopps: 0}};
}

// ------------------------------------------------------------------ Verdichter-Regler (auch einzeln, für das Training mit gemessenem Vorlauf)
// c = {at, soll, vl, q, hc, rt, nachAbtau, comfortAb}; gibt {hz, lvl, ab} zurück (lvl = gehaltene Anhebung über dem Minimum, ab = Comfort hat schon abgeregelt)
function regler(P, lvl, c) {
    const mn = hzMinAt(P, c.at), cap = capOf(P, c.q, c.at), e = c.vl - c.soll;
    if (c.rt < P.spike.length) {                                                  // Startspitze (unabhängig von Quiet)
        const sp = P.spike[c.rt];
        const lv = c.hc === 0 && e < P.regSenkK ? Math.max(0, cap - mn) : 0;
        return {hz: Math.max(sp, mn + lv), lvl: lv, ab: false};
    }
    if (c.nachAbtau < 3 && c.hc === 0) { return {hz: Math.max(mn, Math.min(P.nachAbtauComfortHz, hzMaxAt(P, c.at))), lvl: Math.max(0, cap - mn), ab: false}; }
    let ab = !!c.comfortAb;
    if (e >= P.regSenkK) { lvl = Math.max(0, lvl - P.regAbHzMin); ab = true; }
    else if (-e >= P.comfortWiederK) { ab = false; }
    else if (c.hc === 0) { if (!c.comfortAb || -e >= P.comfortWiederK) { lvl = Math.max(lvl, cap - mn); } }   // Comfort: sofort auf den Deckel, nach dem Abregeln halten
    else if (c.nachAbtau < P.nachAbtauEffMin) { lvl = 0; }                       // Efficiency nach dem Abtauen träge (F)
    else {
        const r = -e;
        if (c.rt >= P.effT1 && r >= P.effK1) { lvl = Math.max(lvl, Math.min(P.effL1 - mn, P.effKp * r)); }
        if (c.rt >= P.effT2 && r >= P.effK2) { lvl = Math.max(lvl, P.effKp * r) + P.effKi; }
    }
    lvl = Math.min(lvl, Math.max(0, cap - mn));
    return {hz: Math.min(cap, mn + lvl), lvl: lvl, ab: ab};
}

// ------------------------------------------------------------------ Ein Minutenschritt
// E = {t, at, rh, pv (kW PV als Sonnenmaß), shift, q, hc, sollHand (optional), th (optional: gemessenes Hausmittel statt Modell)}
function schritt(S0, E, P) {
    const S = Object.assign({}, S0, {raeume: Object.assign({}, S0.raeume), rf: Object.assign({}, S0.rf), n: Object.assign({}, S0.n)});
    const at = E.at, atI = Math.round(at), q = E.q === undefined || E.q === null ? 3 : E.q, hc = E.hc === undefined || E.hc === null ? 1 : E.hc, shift = E.shift || 0;
    // 1. Soll (5-min-Raster)
    if (S.soll === null || E.sollHand !== undefined && E.sollHand !== null || E.t - S.sollT >= P.sollRasterMin * MIN) {
        S.soll = E.sollHand !== undefined && E.sollHand !== null ? E.sollHand : Math.ceil(kurveSoll(P, atI) - 1e-9) + shift;
        if (E.sollHand === undefined || E.sollHand === null) { S.sollT = E.t; }
    }
    const soll = S.soll;
    // 2. Heizgrenze (Fühlerwert, ganze Grad)
    if (!S.hgAus && atI >= P.hgAus) { S.hgAus = true; }
    else if (S.hgAus && atI <= P.hgAn) { S.hgAus = false; S.hgNeu = 0; }
    let start = false, stopp = false;
    // 3. Zustandswechsel (auf Basis des Fühlerwerts der Vorminute)
    if (S.modus === 'lauf') {
        if (S.hgAus) { stopp = true; }
        else if (S.abtau === 0) {
            S.stopZ = r4(S.vl) >= soll + P.stopK - 1e-9 ? S.stopZ + 1 : 0;
            if (S.stopZ >= P.stopHaltMin) { stopp = true; }
        }
        if (stopp) { S.modus = S.hgAus ? 'aus' : 'pause'; S.rt = 0; S.pauseMin = 0; S.stopZ = 0; S.startZ = 0; S.lvl = 0; S.abtau = 0; S.n.stopps++; }
    } else {
        if (S.hgAus) { S.modus = 'aus'; S.startZ = 0; }
        else {
            if (S.modus === 'aus') { S.modus = 'pause'; S.pauseMin = Math.max(S.pauseMin, P.minPauseMin); }
            const v4 = r4(S.vl);
            if (v4 <= soll - P.startK + 1e-9) { S.startZ++; } else if (v4 > soll - P.startK + P.startHystK + 1e-9) { S.startZ = 0; } else if (S.startZ > 0) { S.startZ++; }
            const verzug = S.hgNeu < P.hgStartMin + P.startVerzugMin ? P.hgStartMin : P.startVerzugMin;
            if (S.pauseMin >= P.minPauseMin && ((S.startZ >= verzug && S.hgNeu >= P.hgStartMin) || (S.hgNeu === P.hgStartMin && S.startZ > 0))) { start = true; }
        }
        if (start) { S.modus = 'lauf'; S.rt = 0; S.lvl = 0; S.ab = false; S.hzSlow = hzMinAt(P, atI); S.startZ = 0; S.n.starts++; }
    }
    const lauf = S.modus === 'lauf', pumpe = S.modus !== 'aus';
    // 4. Abtauen und Verdichter
    let hz = 0;
    if (lauf) {
        if (S.abtau > 0) { hz = P.abtauHz; }
        else { const r = regler(P, S.lvl, {at: atI, soll: soll, vl: S.vl, q: q, hc: hc, rt: S.rt, nachAbtau: S.nachAbtau, comfortAb: S.ab}); hz = r.hz; S.lvl = r.lvl; S.ab = r.ab; }
    }
    // 5. Rohr außen, Vereisung, Abtau-Auslöser
    const td = taupunkt(at, E.rh);
    let pthW = 0, pelW = 0, abtauJetzt = S.abtau > 0;
    const rlAlt = S.rl;
    if (lauf && !abtauJetzt) { pthW = pthOf(P, hz, at, S.vl - soll); pelW = pelOf(P, hz, at, rlAlt); }
    const sprung = lauf && !abtauJetzt && S.rt >= P.spike.length ? Math.max(0, hz - (1 + P.pipeSprungAnteil) * S.hzSlow) : 0;
    let pipeZiel;
    if (abtauJetzt) { pipeZiel = Math.max(at, 0) + 8; }                         // A: Rohr wird beim Abtauen erwärmt
    else if (lauf) { pipeZiel = at - (P.pipe0 + P.pipeQ * Math.max(0, pthW - pelW) / 1000 * 300 / Math.max(150, fanOf(P, q, hz))) - P.pipeSprungK * sprung - S.eis; }
    else { pipeZiel = at; }
    S.pipe = S.pipe === null ? pipeZiel : S.pipe + (pipeZiel - S.pipe) * Math.min(1, 1 / P.pipeTauMin);
    if (lauf && !abtauJetzt) {
        if (S.pipe < 0 && S.pipe < td) { S.eis += P.eisRate * (td - S.pipe); }
        S.heizMin++;
        const linie = P.abtauLinie[0] + P.abtauLinie[1] * (at + 9);
        S.abZ = (at <= P.abtauAtMax && S.pipe < linie) ? S.abZ + 1 : 0;
        if (S.heizMin > P.abtauMinHeizMin && (S.abZ >= P.abtauHaltMin || (P.forceDefrostAuto && at < 5 && S.heizMin >= 180))) {
            S.abtau = P.abtauDauerMin; S.abZ = 0; S.n.abtau++; hz = P.abtauHz; abtauJetzt = true; S.pipe = at;
        }
        if (!abtauJetzt && S.rt >= P.spike.length) { S.hzSlow += (hz - S.hzSlow) / P.pipeSlowMin; }
    } else if (!lauf) {
        if (at > 0) { S.eis = Math.max(0, S.eis - P.eisSchmelzJeK * at); }
        S.abZ = 0;
    }
    if (abtauJetzt) { pthW = -P.abtauWaermeKWh * 1000 * 60 / P.abtauDauerMin; pelW = P.abtauPelW; }
    // 6. Heizstab (Handbuch J 14.6.1 mit den Einstellungen der Anlage)
    if (S.hs) {
        if (!lauf || at > P.hsOnAT + 2 || S.vl >= soll + P.hsStopK || (abtauJetzt && !P.hsBeimAbtauen)) { S.hs = 0; S.hsAus = 0; }
    } else {
        S.hsAus++;
        if (P.hsFrei && lauf && at < P.hsOnAT && S.rt >= P.hsDelayMin && S.rt >= P.hsPumpeMin && S.vl < soll + P.hsStartK && S.hsAus >= P.hsSperreMin && (!abtauJetzt || P.hsBeimAbtauen)) { S.hs = 1; }
    }
    if (S.hs) { S.n.hsMin++; }
    // 7. Pumpe
    let flow = 0;
    if (pumpe) {
        if (S.hgNeu < P.hgStartMin) { flow = P.flowHgNeustart; }
        else if (abtauJetzt) { flow = P.flowAbtau; }
        else if (lauf) { flow = hc === 0 ? P.flowComfort : flowEffOf(P, S.rt); }
        else { flow = P.flowPause; }
    }
    // 8. Wasserkreis, Haus, Räume
    const pthKW = pthW / 1000 + S.hs * P.hsKW;
    const th = E.th !== undefined && E.th !== null ? E.th : S.th;
    const hk = heizkreis(P, S.tw, S.tr, th, pthKW), qr = hk.qr;
    S.tw = hk.tw; S.tr = hk.tr;
    S.atH = S.atH === null ? at : S.atH + (at - S.atH) / Math.max(1, P.hausAtTauMin);
    if (E.th !== undefined && E.th !== null) { S.th = E.th; } else { S.th = hausSchritt(P, S.th, hk.qh, S.atH, E.pv); }
    S.atF = S.atF === null ? at : S.atF + (at - S.atF) / P.raumAtTauMin; S.pvF += ((E.pv || 0) - S.pvF) / P.raumPvTauMin;
    Object.keys(P.raeume).forEach(id => { const pr = P.raeume[id]; S.rf[id] += (S.tw - S.rf[id]) / pr[4]; S.raeume[id] = raumWert(pr, S.th, S.rf[id], S.atF, S.pvF); });
    let vl, rl;
    if (pumpe && flow > 0.5) {
        const md = flow * CP, qr2 = qrad(P, S.tw, S.tr);
        rl = S.tw - qr2 / (2 * md); vl = rl + pthKW / md; S.tlok = vl;
    } else {
        S.tlok += (S.th + 2 - S.tlok) / P.tauLokMin; vl = S.tlok; rl = S.tlok - 0.5;     // A: stehendes Wasser im Innengerät
    }
    S.vl = vl; S.rl = rl;
    // 9. Zähler
    if (lauf) { S.rt++; } else { S.pauseMin++; }
    if (S.abtau > 0) { S.abtau--; if (S.abtau === 0) { S.nachAbtau = 0; S.heizMin = 0; S.eis = 0; } } else if (S.nachAbtau < 999) { S.nachAbtau++; }
    if (S.hgNeu < 99) { S.hgNeu++; }
    S.hz = hz; S.t = E.t;
    const pelTop16 = lauf ? pelW : (pumpe ? P.pelPauseW : P.pelAusW);
    const odd = Math.floor(E.t / MIN) % 2;
    const hzOut = hz > 0 ? (Math.abs(hz - Math.floor(hz) - 0.5) < 1e-9 ? (odd ? Math.ceil(hz) : Math.floor(hz)) : Math.round(hz)) : 0;
    const fan = lauf && !abtauJetzt ? Math.round(fanOf(P, q, hz)) : 0;
    const A = {
        t: E.t, modus: abtauJetzt ? 'abtauen' : (S.modus === 'aus' ? 'heizgrenze' : S.modus), start: start, stopp: stopp,
        hz: hz, vl: vl, rl: rl, tw: S.tw, th: S.th, soll: soll, sollKurve: kurveSoll(P, atI), pth: pthKW * 1000, pelRoh: pelTop16, pelKorr: pelTop16 + (lauf ? P.pelKorrW : 0), pelHs: S.hs * P.hsKW * 1000,
        qrad: qr, qh: hk.qh, tr: S.tr, flow: flow, pipe: S.pipe, eis: S.eis, td: td, hs: S.hs, rt: S.rt, raeume: Object.assign({}, S.raeume),
        hp: {                                                                       // Feldnamen wie HeishaMon (OPT_hp, ohne TOP-Präfix)
            Main_Outlet_Temp: r4(vl), Main_Inlet_Temp: r4(rl), Z1_Water_Target_Temp: soll, Main_Target_Temp: soll, Compressor_Freq: hzOut, Heat_Energy_Consumption: Math.round(pelTop16),
            Heat_Energy_Production: Math.max(0, Math.round(pthKW * 1000)), Heat_Power_Production_Extra: Math.round(pthKW * 1000), Pump_Flow: Math.round(flow * 10) / 10,
            Pump_Speed: pumpe && flow > 0.5 ? Math.round(P.pumpe0 + P.pumpeJeL * (flow - P.flowPause)) : 0, Fan1_Motor_Speed: fan, Outside_Temp: atI, Outside_Pipe_Temp: Math.round(S.pipe),
            Defrosting_State: abtauJetzt ? 1 : 0, Quiet_Mode_Level: q, Heating_Control: hc, Z1_Heat_Request_Temp: shift, Internal_Heater_State: S.hs, External_Heater_State: 0,
            Heater_On_Outdoor_Temp: P.hsOnAT, Heater_Start_Delta: P.hsStartK, Heater_Delay_Time: P.hsDelayMin, Heating_Off_Outdoor_Temp: P.heizgrenzeEinstellung, Heat_Delta: 3,
            ThreeWay_Valve_State: 0, Heating_Mode: 0, Z1_Sensor_Settings: 0, Error: 'No error', Quiet_Mode_Priority: 1, Compressor_Operating_Time: S.rt}
    };
    return {S: S, A: A};
}

// ------------------------------------------------------------------ Mehrere Minuten
function simuliere(P, eingaben, init, opts) {
    opts = opts || {};
    let S = opts.S || neu(P, init);
    const out = [];
    for (let i = 0; i < eingaben.length; i++) { const r = schritt(S, eingaben[i], P); S = r.S; if (!opts.ohneAusgabe) { out.push(r.A); } else if (opts.jeMinute) { opts.jeMinute(r.A, i); } }
    return {S: S, A: out};
}

// ------------------------------------------------------------------ Eingabe der Entscheidungsmaschine (wie die Hülle opt_engine sie aus globalen Werten baut)
// raumCfg: [{id, name, min, max}]; extra: {shift, kzRad, block, ...}
function zuEngine(A, raumCfg, P, extra) {
    const h = A.hp; extra = extra || {};
    const rooms = (raumCfg || []).map(rc => ({id: rc.id, name: rc.name, t: A.raeume[rc.id] !== undefined ? Math.round(A.raeume[rc.id] * 10) / 10 : null, age: 10, min: rc.min, max: rc.max, active: true, valid: A.raeume[rc.id] !== undefined}));
    return Object.assign({t: A.t, hpAge: 0.4, hz: h.Compressor_Freq, vl: h.Main_Outlet_Temp, rl: h.Main_Inlet_Temp, soll: h.Z1_Water_Target_Temp, dT: h.Heat_Delta, pel: h.Heat_Energy_Consumption,
        pth: h.Heat_Power_Production_Extra, flow: h.Pump_Flow, pump: h.Pump_Speed, q: h.Quiet_Mode_Level, qPrio: h.Quiet_Mode_Priority, hc: h.Heating_Control, at: h.Outside_Temp,
        defrost: h.Defrosting_State, dhw: 0, ss: 0, rt: h.Compressor_Operating_Time, shift: h.Z1_Heat_Request_Temp, heatMode: 0, z1Sensor: 0, heaterI: h.Internal_Heater_State, heaterE: 0,
        htrOnAT: h.Heater_On_Outdoor_Temp, htrStartDelta: h.Heater_Start_Delta, htrDelay: h.Heater_Delay_Time, heatOffAT: h.Heating_Off_Outdoor_Temp,
        sollKurve: A.sollKurve, block: 0, otherQ: null, otherShift: null, kzRad: 1, rooms: rooms, korr: null, err: h.Error, pipeIn: null, kurve: P.kurve.slice()}, extra);
}

module.exports = {PARAM, standard, herkunft, mitWerten, neu, schritt, simuliere, regler, zuEngine, kurveSoll, hzMinAt, hzMaxAt, capOf, pthOf, pelOf, fanOf, frostFaktor, taupunkt, flowEffOf, qrad, trAus, heizkreis, raumWert, hausSchritt, MIN, CP, DT};

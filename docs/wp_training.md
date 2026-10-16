# Anlagen-Zwilling Leisha WH-WDG05LE5: Training

Daten `replay_data_1610` 2026-10-07 16:55 bis 2026-10-16 22:57 (13323 Minuten, 35 Läufe). Training 2026-10-07 … 2026-10-12, Test 2026-10-13 … 2026-10-16. Modell wp_zwilling v1.

## Güte (Parameter aus den Trainingstagen)

| Größe | Training | Test |
|---|---|---|
| Wärme Pth (stabile Laufminuten), RMSE / Bias | 261 / 12 W | 247 / −20 W |
| Strom TOP16, RMSE / Bias | 20,0 / 0,0 W | 20,6 / −7,7 W |
| Verdichter-Regler (gemessener Vorlauf), RMSE | 1,09 Hz | 1,27 Hz |
| Wasserkreis Vor-/Rücklauf (Neustart je 360 min), RMSE | 0,88 K | 1,26 K |
| Rohr außen, RMSE | – | 0,84 K |
| Hausmittel (24-h-Segmente, gemessener Heizkreis), RMSE | 0,58 K | 0,52 K |
| Raum ki_oben (Abweichung vom gemessenen Hausmittel), RMSE | 0,89 K | 0,92 K |
| Raum ki_unten (Abweichung vom gemessenen Hausmittel), RMSE | 0,40 K | 0,47 K |
| Raum schlaf (Abweichung vom gemessenen Hausmittel), RMSE | 0,40 K | 0,47 K |
| Raum wohn (Abweichung vom gemessenen Hausmittel), RMSE | 1,81 K | 1,27 K |
| Stopp-Regel (gemessener Vorlauf), MAE | 1,6 min (20) | 12,8 min (10) |
| Start-Regel (gemessener Vorlauf), MAE | 12,4 min (19) | 10,0 min (8) |
| Pausendauer = Startzeitpunkt, Zwilling geschlossen, Haus gemessen | MAE 14, Median 8, Bias 1 min (22) | MAE 10, Median 7, Bias 8 min (12) |
| Laufdauer, Zwilling geschlossen, Haus gemessen | MAE 37, Median 15, Bias −4 min (22) | MAE 120, Median 29, Bias 19 min (11) |
| Pausendauer, alles geschlossen (Haus simuliert) | MAE 22, Median 8, Bias 10 min (22) | MAE 10, Median 7, Bias 8 min (12) |
| Laufdauer, alles geschlossen (Haus simuliert) | MAE 49, Median 21, Bias 10 min (22) | MAE 117, Median 41, Bias 37 min (11) |
| Freilauf je Tag summiert (Zwilling / Messung) | 34,8 / 35,3 kWh el, 165 / 167 kWh th, Starts 22 / 22, Laufminuten 4685 / 4650 | 26,4 / 28,3 kWh el, 124 / 134 kWh th, Starts 14 / 12, Laufminuten 3554 / 3763 |

### Freilauf je Tag (24 h geschlossen ab 00:00, Eingänge AT, Feuchte, PV, Quiet, Heizregelung, gemessener Soll)

| Tag | kWh el Zwilling / Messung | kWh th | Starts | Laufminuten | RMSE VL | RMSE Pel | Haus RMSE (Bias) | Räume RMSE ki_oben / ki_unten / schlaf / wohn |
|---|---|---|---|---|---|---|---|---|
| 2026-10-08 | 4,31 / 4,16 | 21,2 / 20,3 | 3 / 3 | 612 / 583 | 0,85 K | 58 W | 0,33 (−0,12) K | 0,76 / 0,41 / 0,53 / 4,18 K |
| 2026-10-09 | 7,86 / 8,13 | 37,7 / 37,8 | 5 / 4 | 1076 / 1121 | 2,11 K | 199 W | 0,73 (−0,21) K | 1,00 / 0,67 / 0,86 / 1,46 K |
| 2026-10-10 | 6,08 / 6,14 | 30,4 / 29,9 | 6 / 7 | 826 / 799 | 2,16 K | 224 W | 0,57 (−0,27) K | 1,18 / 0,42 / 0,84 / 1,22 K |
| 2026-10-11 | 6,63 / 7,52 | 32,1 / 36,2 | 6 / 5 | 909 / 992 | 2,10 K | 215 W | 0,91 (0,50) K | 0,42 / 0,96 / 0,98 / 0,51 K |
| 2026-10-12 | 9,95 / 9,35 | 43,3 / 42,6 | 2 / 3 | 1262 / 1155 | 2,74 K | 243 W | 0,44 (−0,20) K | 1,05 / 0,88 / 0,65 / 1,87 K |
| 2026-10-13 (Test) | 7,78 / 8,23 | 35,5 / 38,6 | 4 / 3 | 1018 / 1046 | 1,42 K | 141 W | 0,55 (−0,20) K | 1,25 / 0,69 / 0,62 / 1,19 K |
| 2026-10-14 (Test) | 5,10 / 5,37 | 25,2 / 27,6 | 5 / 4 | 693 / 749 | 2,26 K | 188 W | 0,57 (0,29) K | 0,49 / 1,03 / 0,48 / 1,71 K |
| 2026-10-15 (Test) | 7,86 / 8,59 | 36,9 / 39,3 | 3 / 3 | 1081 / 1148 | 1,26 K | 115 W | 0,54 (−0,25) K | 1,45 / 0,77 / 0,78 / 2,03 K |
| 2026-10-16 (Test) | 5,64 / 6,07 | 26,5 / 28,9 | 2 / 2 | 762 / 820 | 1,31 K | 109 W | 0,45 (−0,28) K | 1,18 / 0,47 / 0,63 / 1,60 K |

### Zyklen im Test (alles geschlossen)

| Beginn | Art | Messung | Zwilling |
|---|---|---|---|
| 2026-10-13 10:36 | pause | 82 min | 93 min |
| 2026-10-13 13:51 | pause (Pumpe aus) | 158 min | 156 min |
| 2026-10-13 19:34 | pause | 86 min | 83 min |
| 2026-10-13 22:52 | pause | 80 min | 92 min |
| 2026-10-14 02:50 | pause | 101 min | 106 min |
| 2026-10-14 06:47 | pause | 68 min | 102 min |
| 2026-10-14 10:25 | pause (Pumpe aus) | 479 min | 473 min |
| 2026-10-14 23:29 | pause | 53 min | 60 min |
| 2026-10-15 11:01 | pause | 81 min | 92 min |
| 2026-10-15 15:06 | pause (Pumpe aus) | 183 min | 185 min |
| 2026-10-15 23:54 | pause | 47 min | 73 min |
| 2026-10-16 10:46 | pause (Pumpe aus) | 474 min | 474 min |
| 2026-10-13 11:58 | lauf (heizgrenze) | 113 min | 106 min |
| 2026-10-13 16:29 | lauf (thermo) | 185 min | 135 min |
| 2026-10-13 21:00 | lauf (thermo) | 112 min | 142 min |
| 2026-10-14 00:12 | lauf (thermo) | 158 min | 117 min |
| 2026-10-14 04:31 | lauf (thermo) | 136 min | 107 min |
| 2026-10-14 07:55 | lauf (thermo) | 150 min | 118 min |
| 2026-10-14 18:24 | lauf (thermo) | 305 min | 960 min |
| 2026-10-15 12:22 | lauf (thermo) | 164 min | 123 min |
| 2026-10-15 18:09 | lauf (thermo) | 345 min | 485 min |
| 2026-10-16 00:41 | lauf (thermo) | 605 min | 367 min |
| 2026-10-16 18:40 | lauf (thermo) | 215 min | 236 min |

## Parameter (für den Zwilling: Fit über alle Tage; in Klammern nur Trainingstage)

| Parameter | Wert | (Training) | Einheit | Herkunft | Quelle |
|---|---|---|---|---|---|
| `kurve` | [-13,11,29,37] |  | °C | N | Heizkurve Z1: Außen −13 °C → 37 °C (bis 13.10. 13:00 38 °C), 11 °C → 29 °C (Z1_Heat_Curve_*) |
| `sollRasterMin` | 5,000 |  | min | M | Soll ändert sich nur im 5-min-Raster (OPTIMIERER 2; „Soll folgt binnen 6 min“) |
| `hgAus` | 15,0 |  | °C | M | Heizgrenze 12: aus ab Fühler 15 °C (5/5 Übergänge 07.–15.10.) |
| `hgAn` | 12,0 |  | °C | M | Heizgrenze 12: an bei Fühler ≤ 12 °C (5/5) |
| `hgStartMin` | 3,000 |  | min | M | nach dem Ende des Heizgrenze-Aus startet der Verdichter nach 3–4 min (3/3: 10.10., 13.10., 14.10.) |
| `startK` | 2,750 | 3,000 | K | M, gefittet | Startschwelle: Vorlauf ≤ Soll − startK (Startschwellen-Analyse 14 Pausen: 3,25 K) |
| `startVerzugMin` | 18,0 | 9,000 | min | M, gefittet | Start, sobald die Schwelle seit so vielen Minuten erreicht ist (Median 9 min, 6–13) |
| `startHystK` | 99,0 |  | K | M, gefittet | die Wartezeit beginnt neu, wenn der Vorlauf wieder mehr als so viel über die Schwelle steigt (Fühler im 0,25-K-Raster flattert) |
| `stopK` | 3,000 |  | K | M, gefittet | Stopp bei Vorlauf ≥ Soll + 3,0…3,25 K (20/20) |
| `stopHaltMin` | 3,000 | 4,000 | min | F, gefittet | „Vorlauf 3 min lang > Soll + 3 K“ (L7 4004893, M) |
| `minPauseMin` | 3,000 |  | min | H | Verdichter startet frühestens 3 min nach dem Stopp (Handbuch J 16.1.1) |
| `hzMin` | 16,5 |  | Hz | M | Minimum 16–17 Hz (wechselnd) bei 1–15 °C |
| `hzMinFrost` | [[-10,35],[-4,25]] |  | Hz | F | Mindestfrequenz L5: ab ≤ −4 °C 25 Hz, ab ≤ −10 °C 35 Hz, unabhängig vom Flüstermodus (4596796, 4593782, 4593801) |
| `hzMaxTab` | [[-4,52],[4,48],[9,35],[99,30]] |  | Hz | F/M | Höchstfrequenz je WP-AT in Stufen (Winterpaket 16.10.2026, LEISHA_WISSEN (a)): ≤ −4 °C 52 Hz, −3…+4 °C 48 Hz (vorläufig; L5 48 Hz nach nächtlicher Abschaltung bei 2 °C 4517558, „5er 48 Hz bei +4 °C“ 4103634 niedrig), 5…9 °C 35 Hz (M: 35 Hz bei 6 °C; F 4132106), ab 10 °C 30 Hz (F L5 4134403; M 31–34 Hz bei 11–13 °C liegt knapp darüber); Sprungstelle 4/5 °C (L7 4515271); bis 15.10. linear interpoliert |
| `spike` | [33,24] |  | Hz | M | Startspitze Laufminute 0/1 (Median 32 Starts), unabhängig von Quiet (F L7 4187405: „Startspike trotzdem 34 Hz“) |
| `capQ3` | 17,0 |  | Hz | M | Quiet 3 hält 16–17 Hz (1–14 °C) |
| `capQ2kalt` | 21,0 |  | Hz | M | Quiet 2 bis 20–21 Hz bei 1–4 °C (12.10., 168 min) |
| `capQ2warm` | 17,0 |  | Hz | M | Quiet 2 hält 16–17 Hz bei 12–13 °C |
| `capQ2grenze` | 7,000 |  | °C | M | Grenze zwischen beiden Quiet-2-Deckeln (DECKEL-Tabelle, engine_core) |
| `capQ1` | 21,0 |  | Hz | M | Quiet 1 bis 20–21 Hz bei 12 °C (13.10., 28 min); bei Frost unbekannt |
| `regSenkK` | 1,000 | 1,250 | K | M, gefittet | Vorlauf ≥ Soll + x K: Frequenz fährt auf das Minimum zurück (F L7 4002439: Abmodulation ab Soll + 1,5 K) |
| `regAbHzMin` | 0,500 | 1,000 | Hz/min | M, gefittet | Rampe nach unten |
| `comfortWiederK` | 99,0 |  | K | M, gefittet | Comfort: nach dem Abregeln erst wieder auf den Deckel, wenn der Vorlauf so weit unter Soll fällt (12.10.: 25 Hz gehalten) |
| `effT1` | 30,0 | 19,0 | min | M, gefittet | Efficiency: erste Anhebung frühestens ab Laufminute x |
| `effK1` | 4,000 | 1,750 | K | M, gefittet | Efficiency: erste Anhebung bei Vorlauf ≤ Soll − x K |
| `effL1` | 21,0 | 19,0 | Hz | M, gefittet | Efficiency: Obergrenze der ersten Anhebung |
| `effT2` | 36,0 | 33,0 | min | M, gefittet | Efficiency: zweite Anhebung ab Laufminute x (gemessen 39–46) |
| `effK2` | 1,250 |  | K | M, gefittet | Efficiency: zweite Anhebung bei Vorlauf ≤ Soll − x K |
| `effKp` | 3,000 | 2,500 | Hz/K | M, gefittet | Efficiency: Anhebung = kp · Rückstand des Vorlaufs |
| `effKi` | 0,100 |  | Hz/min | M/A, gefittet | Efficiency: langsames Nachschieben bei bleibendem Rückstand ab der zweiten Stufe (Boost 10.10.: 29 → 34 Hz) |
| `pthHz` | 120,6 | 120,8 | W/Hz | M, gefittet | Wärme je Hz bei 5 °C (stabile Laufminuten) |
| `pthHzAT` | 0,743 | 0,508 | W/(Hz·K) | M, gefittet | Zunahme der Wärme je Hz und K Außentemperatur |
| `pthEnde` | 0,0583 | 0,0561 | 1/K | M, gefittet | gemessen steigt die Wärme (Durchfluss × Spreizung) am Laufende: +x je K Vorlauf über Soll + 1 K (16–17 Hz: 2050 W bei Soll ±1 K, 2200–2350 W bei +2…+3 K; Ursache unklar, empirisch) |
| `pthFrostAb` | 1,000 |  | °C | F/A | unter dieser AT fällt die Wärme je Hz stärker (keine eigenen Daten) |
| `pthFrostJeK` | 0,0450 |  | 1/K | F | Abfall je K unter pthFrostAb; Anker: L5 −2 °C 16 Hz ≈ 1,6 kW (4596796), −3 °C 16 Hz ≈ 1,5 kW (4606872), −4 °C 25 Hz ≈ 2 kW (4596796) |
| `pthFrostMin` | 0,700 |  | – | S/A | Untergrenze des Faktors; Anker Datenblatt ~5 kW bei −7 °C (3661016) und 59 Hz |
| `pelFrostAnteil` | 0,600 |  | – | F/S | Anteil des Frost-Faktors, um den auch die Verdichterleistung sinkt (Massenstrom); kalibriert auf COP −3 °C ≈ 3,7 (L5 4013336) und −7 °C ≈ 3,0 (Datenblatt 3661016) |
| `pel0` | −113,7 | −125,0 | W | M, gefittet | TOP16 = pel0 + Hz · (pelHz + pelRL · Rücklauf + pelAT · AT); bei 16,5 Hz ≈ 10 W je K Rücklauf (bekannt: 12 W/K) |
| `pelHz` | 11,1 | 12,0 | W/Hz | M, gefittet | Strom je Hz (Formel bei pel0) |
| `pelRL` | 0,636 | 0,623 | W/(Hz·K) | M, gefittet | Strom je Hz und K Rücklauf (Formel bei pel0) |
| `pelAT` | −0,283 | −0,284 | W/(Hz·K) | M, gefittet | Strom je Hz und K Außentemperatur (Formel bei pel0) |
| `pelKorrW` | 80,0 |  | W | F/M | TOP16 untertreibt im Lauf um 70–90 W (L5 4545989, 4597230); nur bei laufendem Verdichter |
| `pelPauseW` | 34,0 |  | W | M, gefittet | TOP16 in der Pause mit Pumpe |
| `pelAusW` | 15,0 |  | W | M, gefittet | TOP16 im Heizgrenze-Aus (Pumpe aus) |
| `flowPause` | 13,4 |  | l/min | M, gefittet | Durchfluss in der Pause (Pumpe 1750 U/min) |
| `flowComfort` | 13,7 | 13,4 | l/min | M, gefittet | Comfort: ΔT-geregelt, Pumpe 1750 U/min |
| `flowEff` | [30,21,35,90] | [30,21.5,35,95] | min, l/min, min, min | M, gefittet | Efficiency: bis Laufminute a 13,4 l/min, dann b l/min bis Minute c, linear zurück bis Minute d |
| `flowHgNeustart` | 35,0 |  | l/min | M | Spülen beim Ende des Heizgrenze-Aus (33,8–37,7 l/min, 3 min) |
| `flowAbtau` | 21,0 |  | l/min | F | L5 Abtauen: Volumenstrom 10 → 17 → 21 l/min (4288323) |
| `pumpe0` | 1741,0 | 1734,0 | U/min | M, gefittet | Pumpendrehzahl bei 13,4 l/min |
| `pumpeJeL` | 118,0 | 118,4 | U/min je l/min | M, gefittet | Comfort → Efficiency: 1750 → 2870 U/min bei 13,4 → 23 l/min |
| `fanQ` | [316,240,306,222] | [311,270,305,220] | U/min | M, gefittet | Lüfter am Minimum je Quiet 0/1/2/3 (Median; Forum L5 4504115 ähnlich) |
| `fanKalt` | [110,105,105,100] |  | U/min | M | Lüfterstufe bei WP-AT ≤ fanKaltAtC: +110 (Q0) … +100 (Q3) U/min am Minimum (eigene Auswertung quiet-2026-10.csv 07.–15.10.: Q0 330 → 420–450, Q3 220 → 330–340 U/min bei 2–4 °C; L7 „Turbofan“ 490–540 U/min unter +4 °C 4903887, 4877511) |
| `fanKaltAtC` | 4,000 |  | °C | M/F | Lüfterstufe ab WP-AT ≤ 4 °C (eigene Messung; L7 Sprungstelle 4/5 °C 4515271) |
| `fanJeHz` | 4,620 | 5,330 | U/min je Hz | M, gefittet | Lüfter-Zunahme je Hz über dem Minimum |
| `cw` | 0,383 | 0,393 | kWh/K | M, gefittet | Wärmespeicher Wasser + Heizkörper |
| `krad` | 0,167 | 0,156 | kW/K^n | M, gefittet | Heizkörperabgabe krad · (tw − th)^n |
| `nrad` | 1,300 |  | – | A | Heizkörper-Exponent (EN 442, typisch 1,3) |
| `cr` | 0,119 | 0,160 | kWh/K | M, gefittet | Raumluft/Oberflächen an den Heizkörpern (schneller Knoten zwischen Heizkörper und Hausmasse) |
| `hr` | 0,600 | 0,555 | kW/K | M, gefittet | Übergang schneller Knoten → Hausmittel |
| `kv` | 0,0000 |  | 1/K | M, gefittet | Thermostatventile: Abgabe × max(0,2; 1 − kv · (tr − tvRef)) – je wärmer die Luft an den Heizkörpern, desto weniger Abgabe (Ventile am 15.10. nachgestellt) |
| `tvRef` | 22,0 |  | °C | A | Bezug der Ventil-Drosselung |
| `tauLokMin` | 240,0 |  | min | A | Fühler im Innengerät bei stehender Pumpe: Auskühlen zur Raumtemperatur |
| `ua` | 0,151 | 0,147 | kW/K | M, gefittet | Wärmeverlust des Hauses (plan_algo: 141 W/K) |
| `gain` | 0,230 | 0,325 | kW | M, gefittet | innere Gewinne (plan_algo: 0,38 kW) |
| `ch` | 4,200 |  | kWh/K | M/A, gefittet | Speichermasse des Hausmittels |
| `sonne` | 0,0542 | 0,0361 | kW je kW PV | M, gefittet | Sonnengewinn je kW PV-Leistung (PV als Strahlungsmaß) |
| `hausAtTauMin` | 240,0 |  | min | M, gefittet | die Hülle sieht die Außentemperatur geglättet (Speichermasse der Wände; besser als ungeglättet: RMSE 0,65 statt 0,84 K) |
| `raeume` | {"ki_oben":[2.21141,0.13509,-0.15215,0.08507,30,0.57,11.71,6.12,18.45],"ki_unten":[0.13297,0,0.00802,0,30,0.57,11.71,6.12,18.45],"schlaf":[-0.22866,0.01042,-0.0093,0.01307,30,0.57,11.71,6.12,18.45],"wohn":[4.67407,0.04159,-0.224,0.00665,60,0.83,11.01,6.12,18.45]} | {"ki_oben":[2.13463,0.1262,-0.16994,0.09523,30,0.67,11.6,6.82,17.58],"ki_unten":[0.62515,0.00122,-0.02592,0,30,0.67,11.6,6.82,17.58],"schlaf":[-0.63613,0.00189,0.02454,0.00181,120,1.2,10.88,6.82,17.58],"wohn":[5.88728,0,-0.3,0,30,1.63,11.21,6.82,17.58]} | K, –, –, K/kW, min, K… | M, gefittet | je Raum Abweichung vom Hausmittel (Kinderzimmer oben ohne eigenes Relais/Heizlüfter-Modell: mittleres Verhalten); keine Extrapolation über den gemessenen Bereich |
| `raumAtTauMin` | 360,0 |  | min | A | Zeitkonstante des AT-Filters für die Räume |
| `raumPvTauMin` | 120,0 |  | min | A | Zeitkonstante des PV-Filters für die Räume |
| `pipe0` | 1,726 |  | K | M, gefittet | AT − Rohr = pipe0 + pipeQ · Verdampferleistung (kW) · 300 / Lüfter (U/min); mit Lüfter besser als ohne (RMSE 0,92 statt 1,07 K); Frost: Lüfter L5 630 U/min bei −13 °C (F 4600750) |
| `pipeQ` | 0,812 |  | K/kW | M, gefittet | siehe pipe0 |
| `pipeTauMin` | 3,000 |  | min | A | Zeitkonstante des Rohrfühlers |
| `pipeSprungK` | 0,700 |  | K/Hz | F/A | Pseudo-Abtauung: Frequenzsprung über +30 % des langsamen Mittels senkt das Rohr (L5 4540566: 1 → −16 °C; L7 4230252; Schwelle 4868882 V) |
| `pipeSprungAnteil` | 0,300 |  | – | F | gefährlicher Sprung ab etwa +30 % (4868882, V) |
| `pipeSprungHz` | 8,000 |  | Hz | F | oder ab +8 Hz absolut über dem langsamen Mittel, je nachdem was zuerst greift: „+6 Hz meist ohne Einbruch, +10 Hz eher nicht“ (L7 4553013, 4868882); Winterpaket 16.10.2026 |
| `pipeSlowMin` | 120,0 |  | min | F/A | Zeitkonstante des langsamen Frequenzmittels = träges Expansionsventil: es öffnet höchstens 30 Halbschritte je 90 s und schließt nach einem Start mit kleiner Frequenz über ~2 h (Kältekreis eingeschwungen nach ~2 h 25 min: L7 4886674, 4549934, 4538558); Spanne 90–120 min, bis 15.10. 30 min (A) |
| `abtauAtMax` | 10,0 |  | °C | F | Abtau-Auslöser bis WP-AT unter 10 °C: Pseudoabtauungen bis 9 °C (L9 nach FM-Selbstabschaltung 4011622; 7 °C 4230815; 6 °C 3456847), über 10 °C nie (4466101); bis 15.10. 5 °C (Handbuch J Force-Defrost-Grenze) |
| `abtauLinie` | [0.9,-6,-22.5,-5] |  | °C | H/F | Auslöser Rohr < min(d; max(c; a·WP-AT + b)) = Handbuchlinie y = 0,9·AT − 11 (begrenzt −27,5…−6 °C, Handbuch J 15.2.2, 3585656, 3585691) + 5 K, weil die L bis zu 5–6 K über der Linie auslöst (4371449, 4472442, 4890839); obere Grenze real −5 °C (Abtauung schon bei Rohr −6 °C, 4137878). Anker: −9 °C → −14,1 °C (4600685 ✓), 0 °C → −6 °C (3971807 ✓); bis 15.10. −13,5 + 0,6·(AT + 9) |
| `abtauHaltMin` | 3,000 |  | min | H | Rohr 3 min am Stück unter der Linie (Handbuch J 15.2.2) |
| `abtauMinHeizMin` | 35,0 |  | min | H/F | Heizzeit seit der letzten Abtauung > 35 min (Handbuch J; L7 4613622) |
| `abtauDauerMin` | 8,000 |  | min | F | L5: 8 min (4288323); J ~9 min (4598540), Handbuch max. 9,5 min |
| `abtauWaermeKWh` | 0,500 |  | kWh | F/A | Wärmeentzug aus dem Heizwasser je Abtauung, Spanne 0,3–1,6 kWh: 1,6 kWh im Januar-Extrem, „sonst deutlich weniger“ (L7 3810731); 300 l × 2 K ≈ 0,7 kWh (4076731); WMZ ≤ 1 kWh für 3 Abtauungen (4084491); [J] Richtwert 0,4 kWh (4075412). 0,5 kWh = unteres Drittel (Heizkörper ohne Puffer). Der interne Wärmezähler bucht die Abtauwärme positiv (L5 4074654, 4752841): im Zwilling zählt Heat_Energy_Production beim Abtauen positiv, die Wärme des Wasserkreises (Heat_Power_Production_Extra) negativ |
| `abtauHz` | 58,0 |  | Hz | F | Abtauen bei ~58 Hz (L5 4092731, L7 4548650) |
| `abtauPelW` | 1000,0 |  | W | A | Stromaufnahme beim Abtauen (TOP16) |
| `nachAbtauEffMin` | 20,0 |  | min | F | Efficiency hält nach dem Abtauen ~20 min niedrige Frequenz (L5 4582615, L7 4095732) |
| `nachAbtauComfortHz` | 50,0 |  | Hz | F | nach dem Abtauen startet die L5 normalerweise mit ~50 Hz (4542523); hier 3 min, gedeckelt durch die Höchstfrequenz |
| `startHochAtC` | 4,000 |  | °C | F | Comfort-Kaltstart: bei WP-AT ≤ +4 °C fährt die L im Comfort unabhängig vom Soll mit hoher Frequenz an (L7 4005690, 4005591, 3474343, 3456847) |
| `startHochHz` | 67,0 |  | Hz | F | Frequenz des Comfort-Kaltstarts: L7 67–68 Hz (gemessen bis 76 Hz, 620 U/min Lüfter, Heißgas ~80 °C, Rohr −20 °C, danach Abtauung; 4005690, 3474343); L5 unbekannt (48 Hz nach nächtlicher Abschaltung bei 2 °C, 4517558) – Auftrag Winterpaket: 67 Hz; nicht über den Quiet-Deckel (Quiet 1–3) |
| `startHochBisK` | 1,000 |  | K | F/A | Comfort-Kaltstart bleibt oben, bis der Vorlauf Soll − 1 K erreicht (20–45 min bis zum Ziel, 4005690) |
| `startHochMaxMin` | 45,0 |  | min | F/A | Comfort-Kaltstart höchstens 45 min (4005690: 20–45 min) |
| `atExtVersatz` | 0,0000 |  | K | F/A | externer Panasonic-Fühler: bei AT < 2 °C bewertet die Steuerung ihn zu warm (2–3 K über dem internen, L7/L9 4557101, 4716238, 4890713, 4890839). WP-AT = Physik-AT + v, v = 0 ab atExtAbC, linear bis atExtVersatz bei 0 °C und darunter; vorläufig 0 (messen: LEISHA (c) 3) |
| `atExtAbC` | 2,000 |  | °C | F | ab dieser AT liest der externe Fühler richtig (4716238) |
| `eisRate` | 0,0167 | 0,0165 | 1/(min·K) | A, kalibriert (Annahme-Anker) | Vereisung je min und K (Taupunkt − Rohr), wirkt als Rohrabsenkung 1 K je Einheit; kalibriert auf den Forum-Anker |
| `eisAnker` | [0,90,90] |  | °C, %, min | F/A | Kalibrieranker: bei 0 °C, 90 % Feuchte und Mindestlast Abtauung alle ~90 min (L5 gedämmt „worst case ~90 min“ 4879325 E; L9 0,8 °C 94 %: 35 min und 1:40 h 4132154) |
| `eisSchmelzJeK` | 0,0200 |  | 1/(min·K) | A | Abbau der Vereisung im Stillstand je K über 0 °C |
| `forceDefrostAuto` | 0,0000 |  | 0/1 | H | Force Defrost „Auto“ (alle 3 h unter 5 °C) – Werkseinstellung Manual (Handbuch J Z. 6965); bei der L nicht belegt |
| `hsFrei` | 1,000 |  | 0/1 | M | heizstab_raum_frei = 1 im Protokoll; ob der Heizstab an der Anlage wirklich freigegeben ist, ist offen (L ab Werk aus, F 3957497) |
| `hsOnAT` | 0,0000 |  | °C | M | Heater_On_Outdoor_Temp 0 °C |
| `hsStartK` | −3,000 |  | K | M | Heater_Start_Delta −3 K |
| `hsStopK` | −2,000 |  | K | H/F | Aus bei Vorlauf ≥ Soll − 2 K: Werkseinstellung Heizstab Aus −2 K (Handbuch J Z. 7049–7075), L7-Besitzer −5 °C / 30 min / Ein −4 K / Aus −2 K (4580843); Heater_Stop_Delta (TOP98) seit 15.10. im Protokoll; bis 15.10. −1 K (A) |
| `hsDelayMin` | 15,0 |  | min | M | Heater_Delay_Time 15 min nach Thermo-Ein |
| `hsPumpeMin` | 9,000 |  | min | H | nach 9 min Pumpenlauf (Handbuch J 14.6.1) |
| `hsSperreMin` | 20,0 |  | min | H | 20 min seit dem letzten Aus (Handbuch J 14.6.1) |
| `hsKW` | 3,000 |  | kW | A | Heizstab-Leistung (L-Innengerät 3 kW, nicht gemessen) |
| `hsBeimAbtauen` | 0,0000 |  | 0/1 | F | die L schaltet den Heizstab beim Abtauen nicht zu (L5 4879325, 4288323); Handbuch J: bei Wassereintritt < 27 °C schon |
| `heizgrenzeEinstellung` | 12,0 |  | °C | M | Heating_Off_Outdoor_Temp (Einstellung, für die Maschine) |

## Fit-Kennzahlen (alle Tage)

```json
{
 "waerme": {
  "n": 8369,
  "rmseW": 254.3,
  "modell": "Pth = Hz · (a + b · (AT − 5)) · (1 + c · max(0, VL − Soll − 1))"
 },
 "strom": {
  "n": 8369,
  "rmseW": 20,
  "modell": "TOP16 = c0 + Hz · (c1 + c2 · RL + c3 · AT)",
  "dPel_dRL_16_5Hz": 10.5,
  "dPel_dAT_16_5Hz": -4.67
 },
 "standby": {
  "nPause": 2385,
  "nAus": 2393
 },
 "pumpe": {
  "nEff": 4728,
  "rmseEff": 2.75,
  "nComfort": 708,
  "comfortQuelle": "gemessen",
  "rmsePumpe": 24
 },
 "luefter": {
  "n": 8369,
  "rmse": 22,
  "minutenJeQuiet": [
   2181,
   784,
   238,
   5166
  ]
 },
 "rohr": {
  "n": 2388,
  "rmseK": 0.84,
  "quelle": "Trainingstage",
  "atBereich": [
   3,
   15
  ]
 },
 "startStopp": {
  "stopp": {
   "n": 30,
   "maeMin": 4.43,
   "biasMin": -0.43
  },
  "start": {
   "n": 27,
   "maeMin": 10.41,
   "medianMin": 5,
   "biasMin": -5
  }
 },
 "regler": {
  "n": 8544,
  "rmseHz": 1.092,
  "auswertungen": 157
 },
 "wasserkreis": {
  "n": 10800,
  "rmseK": 0.878,
  "segmentMin": 360,
  "nrad": 1.3
 },
 "zyklen": {
  "vorher": {
   "verlust": 2.012,
   "wasserkreisRmseK": 0.878,
   "logFehler": 0.274
  },
  "nachher": {
   "verlust": 1.767,
   "wasserkreisRmseK": 0.894,
   "logFehler": 0.195
  },
  "auswertungen": 52
 },
 "haus": {
  "n": 4749,
  "rmseKKalt": 0.489,
  "biasKKalt": -0.012,
  "rmseKAlle24h": 0.615,
  "hausmittel": "ki_unten + schlaf",
  "bilanzpunktC": 19.8,
  "verfahren": "UA, Gewinne, Speicher, AT-Glättung: Simulation 48 h, Fehler bei AT ≤ 8 °C; Sonne und Startwerte aus 24-h-Energiebilanzen",
  "energiebilanz": {
   "fenster24h": 88,
   "ua": 0.1513,
   "gain": 0.2296,
   "sonne": 0.0542,
   "bilanzpunktC": 19.8,
   "vorwert": "UA 0,154 kW/K, Gewinne 0,3 kW als 2 Pseudo-Tage (−5/+10 °C)"
  }
 },
 "raeume": {
  "ki_oben": {
   "n": 13034,
   "rmseK": 0.839
  },
  "ki_unten": {
   "n": 13034,
   "rmseK": 0.408
  },
  "schlaf": {
   "n": 13034,
   "rmseK": 0.406
  },
  "wohn": {
   "n": 11584,
   "rmseK": 1.554
  }
 },
 "vereisung": {
  "anker": {
   "at": 0,
   "rh": 90,
   "zielMin": 90,
   "ergebnisMin": 90
  },
  "pruefung": [
   {
    "at": 4,
    "rh": 95,
    "abtauungen48h": 0,
    "intervallMin": null,
    "soll": "Forum L5 4540566: bei 3–5 °C und Regen tagelang keine Abtauung"
   },
   {
    "at": -7,
    "rh": 85,
    "abtauungen48h": 29,
    "intervallMin": 99.7,
    "soll": "Forum J5 2911944/2913337 (nicht L): alle 1–2 h bei −5…−10 °C"
   },
   {
    "at": -9,
    "rh": 85,
    "abtauungen48h": 29,
    "intervallMin": 100.6,
    "soll": "Forum 4600685 (E): Kriterium Rohr < −13/−14 °C bei −9 °C"
   }
  ]
 }
}
```

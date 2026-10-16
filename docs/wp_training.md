# Anlagen-Zwilling Leisha WH-WDG05LE5: Training

Daten `replay_data_1510` 2026-10-07 16:55 bis 2026-10-15 17:39 (11565 Minuten, 32 Läufe). Training 2026-10-07 … 2026-10-11, Test 2026-10-12 … 2026-10-15. Modell wp_zwilling v1.

## Güte (Parameter aus den Trainingstagen)

| Größe | Training | Test |
|---|---|---|
| Wärme Pth (stabile Laufminuten), RMSE / Bias | 272 / 16 W | 247 / −69 W |
| Strom TOP16, RMSE / Bias | 19,8 / 0,0 W | 21,6 / −8,0 W |
| Verdichter-Regler (gemessener Vorlauf), RMSE | 0,94 Hz | 1,36 Hz |
| Wasserkreis Vor-/Rücklauf (Neustart je 360 min), RMSE | 0,83 K | 0,97 K |
| Rohr außen, RMSE | – | 0,92 K |
| Hausmittel (24-h-Segmente, gemessener Heizkreis), RMSE | 0,51 K | 0,42 K |
| Raum ki_oben (Abweichung vom gemessenen Hausmittel), RMSE | 0,84 K | 1,22 K |
| Raum ki_unten (Abweichung vom gemessenen Hausmittel), RMSE | 0,28 K | 0,62 K |
| Raum schlaf (Abweichung vom gemessenen Hausmittel), RMSE | 0,29 K | 0,57 K |
| Raum wohn (Abweichung vom gemessenen Hausmittel), RMSE | 1,85 K | 1,54 K |
| Stopp-Regel (gemessener Vorlauf), MAE | 1,6 min (17) | 13,2 min (10) |
| Start-Regel (gemessener Vorlauf), MAE | 8,4 min (16) | 17,7 min (10) |
| Pausendauer = Startzeitpunkt, Zwilling geschlossen, Haus gemessen | MAE 7, Median 4, Bias −0 min (19) | MAE 18, Median 8, Bias −1 min (12) |
| Laufdauer, Zwilling geschlossen, Haus gemessen | MAE 50, Median 27, Bias 20 min (19) | MAE 167, Median 27, Bias 132 min (11) |
| Pausendauer, alles geschlossen (Haus simuliert) | MAE 17, Median 5, Bias 10 min (19) | MAE 18, Median 7, Bias −0 min (12) |
| Laufdauer, alles geschlossen (Haus simuliert) | MAE 75, Median 37, Bias 51 min (19) | MAE 93, Median 30, Bias 54 min (11) |
| Freilauf je Tag summiert (Zwilling / Messung) | 27,3 / 25,9 kWh el, 134 / 124 kWh th, Starts 16 / 19, Laufminuten 3779 / 3495 | 30,5 / 29,1 kWh el, 137 / 136 kWh th, Starts 12 / 12, Laufminuten 3914 / 3753 |

### Freilauf je Tag (24 h geschlossen ab 00:00, Eingänge AT, Feuchte, PV, Quiet, Heizregelung, gemessener Soll)

| Tag | kWh el Zwilling / Messung | kWh th | Starts | Laufminuten | RMSE VL | RMSE Pel | Haus RMSE (Bias) | Räume RMSE ki_oben / ki_unten / schlaf / wohn |
|---|---|---|---|---|---|---|---|---|
| 2026-10-08 | 4,30 / 4,16 | 21,4 / 20,3 | 3 / 3 | 612 / 583 | 1,05 K | 58 W | 0,63 (−0,55) K | 0,76 / 0,62 / 0,83 / 4,15 K |
| 2026-10-09 | 8,97 / 8,13 | 43,0 / 37,8 | 3 / 4 | 1255 / 1121 | 1,84 K | 169 W | 0,80 (−0,54) K | 1,25 / 0,80 / 0,84 / 1,36 K |
| 2026-10-10 | 6,82 / 6,14 | 34,0 / 29,9 | 5 / 7 | 906 / 799 | 2,11 K | 184 W | 0,61 (−0,37) K | 1,10 / 0,46 / 0,85 / 1,46 K |
| 2026-10-11 | 7,25 / 7,52 | 35,4 / 36,2 | 5 / 5 | 1006 / 992 | 2,46 K | 222 W | 0,77 (0,27) K | 0,52 / 0,94 / 0,81 / 0,71 K |
| 2026-10-12 (Test) | 10,17 / 9,35 | 43,8 / 42,6 | 2 / 3 | 1299 / 1155 | 2,92 K | 243 W | 0,87 (−0,81) K | 2,07 / 1,11 / 1,08 / 1,99 K |
| 2026-10-13 (Test) | 9,02 / 8,23 | 40,6 / 38,6 | 3 / 3 | 1092 / 1046 | 2,23 K | 226 W | 0,83 (−0,74) K | 1,92 / 0,84 / 0,98 / 0,92 K |
| 2026-10-14 (Test) | 5,21 / 5,37 | 25,8 / 27,6 | 5 / 4 | 713 / 749 | 2,22 K | 185 W | 0,39 (0,06) K | 0,52 / 0,91 / 0,64 / 1,72 K |
| 2026-10-15 (Test) | 6,09 / 6,10 | 26,4 / 27,6 | 2 / 2 | 810 / 803 | 2,44 K | 169 W | 0,94 (−0,88) K | 2,60 / 0,99 / 1,12 / 2,46 K |

### Zyklen im Test (alles geschlossen)

| Beginn | Art | Messung | Zwilling |
|---|---|---|---|
| 2026-10-12 11:21 | pause | 57 min | 109 min |
| 2026-10-12 14:17 | pause | 97 min | 88 min |
| 2026-10-12 19:21 | pause | 131 min | 48 min |
| 2026-10-13 10:36 | pause | 82 min | 89 min |
| 2026-10-13 13:51 | pause (Pumpe aus) | 158 min | 156 min |
| 2026-10-13 19:34 | pause | 86 min | 79 min |
| 2026-10-13 22:52 | pause | 80 min | 88 min |
| 2026-10-14 02:50 | pause | 101 min | 100 min |
| 2026-10-14 06:47 | pause | 68 min | 97 min |
| 2026-10-14 10:25 | pause (Pumpe aus) | 479 min | 473 min |
| 2026-10-14 23:29 | pause | 53 min | 57 min |
| 2026-10-15 11:01 | pause | 81 min | 87 min |
| 2026-10-12 12:18 | lauf (thermo) | 119 min | 105 min |
| 2026-10-12 15:54 | lauf (thermo) | 207 min | 226 min |
| 2026-10-12 21:32 | lauf (thermo) | 784 min | 814 min |
| 2026-10-13 11:58 | lauf (heizgrenze) | 113 min | 99 min |
| 2026-10-13 16:29 | lauf (thermo) | 185 min | 137 min |
| 2026-10-13 21:00 | lauf (thermo) | 112 min | 149 min |
| 2026-10-14 00:12 | lauf (thermo) | 158 min | 120 min |
| 2026-10-14 04:31 | lauf (thermo) | 136 min | 111 min |
| 2026-10-14 07:55 | lauf (thermo) | 150 min | 120 min |
| 2026-10-14 18:24 | lauf (thermo) | 305 min | 1022 min |
| 2026-10-15 12:22 | lauf (thermo) | 164 min | 119 min |

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
| `hzMaxTab` | [[-4,59],[-3,52],[5,35],[11,34],[13,31],[15,30]] |  | Hz | M/F | Höchstfrequenz je AT: M Comfort/Quiet 0 35 Hz bei 6 °C, 31 Hz bei 13 °C, Boost 33–34 Hz bei 11 °C; F L5 +5 °C 35 Hz, +10 °C 30 Hz (4132106, 4134403), 52 Hz über −4 °C, 59 Hz ab −4 °C (4132106 M, 4132035 V/E) |
| `spike` | [33,24] |  | Hz | M | Startspitze Laufminute 0/1 (Median 32 Starts), unabhängig von Quiet (F L7 4187405: „Startspike trotzdem 34 Hz“) |
| `capQ3` | 17,0 |  | Hz | M | Quiet 3 hält 16–17 Hz (1–14 °C) |
| `capQ2kalt` | 21,0 |  | Hz | M | Quiet 2 bis 20–21 Hz bei 1–4 °C (12.10., 168 min) |
| `capQ2warm` | 17,0 |  | Hz | M | Quiet 2 hält 16–17 Hz bei 12–13 °C |
| `capQ2grenze` | 7,000 |  | °C | M | Grenze zwischen beiden Quiet-2-Deckeln (DECKEL-Tabelle, engine_core) |
| `capQ1` | 21,0 |  | Hz | M | Quiet 1 bis 20–21 Hz bei 12 °C (13.10., 28 min); bei Frost unbekannt |
| `regSenkK` | 1,000 | 1,500 | K | M, gefittet | Vorlauf ≥ Soll + x K: Frequenz fährt auf das Minimum zurück (F L7 4002439: Abmodulation ab Soll + 1,5 K) |
| `regAbHzMin` | 0,500 | 1,500 | Hz/min | M, gefittet | Rampe nach unten |
| `comfortWiederK` | 99,0 |  | K | M, gefittet | Comfort: nach dem Abregeln erst wieder auf den Deckel, wenn der Vorlauf so weit unter Soll fällt (12.10.: 25 Hz gehalten) |
| `effT1` | 30,0 | 19,0 | min | M, gefittet | Efficiency: erste Anhebung frühestens ab Laufminute x |
| `effK1` | 4,000 | 1,750 | K | M, gefittet | Efficiency: erste Anhebung bei Vorlauf ≤ Soll − x K |
| `effL1` | 21,0 | 19,0 | Hz | M, gefittet | Efficiency: Obergrenze der ersten Anhebung |
| `effT2` | 36,0 |  | min | M, gefittet | Efficiency: zweite Anhebung ab Laufminute x (gemessen 39–46) |
| `effK2` | 1,250 |  | K | M, gefittet | Efficiency: zweite Anhebung bei Vorlauf ≤ Soll − x K |
| `effKp` | 3,000 |  | Hz/K | M, gefittet | Efficiency: Anhebung = kp · Rückstand des Vorlaufs |
| `effKi` | 0,100 | 0,0500 | Hz/min | M/A, gefittet | Efficiency: langsames Nachschieben bei bleibendem Rückstand ab der zweiten Stufe (Boost 10.10.: 29 → 34 Hz) |
| `pthHz` | 120,8 | 116,9 | W/Hz | M, gefittet | Wärme je Hz bei 5 °C (stabile Laufminuten) |
| `pthHzAT` | 0,670 | 1,246 | W/(Hz·K) | M, gefittet | Zunahme der Wärme je Hz und K Außentemperatur |
| `pthEnde` | 0,0593 | 0,0606 | 1/K | M, gefittet | gemessen steigt die Wärme (Durchfluss × Spreizung) am Laufende: +x je K Vorlauf über Soll + 1 K (16–17 Hz: 2050 W bei Soll ±1 K, 2200–2350 W bei +2…+3 K; Ursache unklar, empirisch) |
| `pthFrostAb` | 1,000 |  | °C | F/A | unter dieser AT fällt die Wärme je Hz stärker (keine eigenen Daten) |
| `pthFrostJeK` | 0,0450 |  | 1/K | F | Abfall je K unter pthFrostAb; Anker: L5 −2 °C 16 Hz ≈ 1,6 kW (4596796), −3 °C 16 Hz ≈ 1,5 kW (4606872), −4 °C 25 Hz ≈ 2 kW (4596796) |
| `pthFrostMin` | 0,700 |  | – | S/A | Untergrenze des Faktors; Anker Datenblatt ~5 kW bei −7 °C (3661016) und 59 Hz |
| `pelFrostAnteil` | 0,600 |  | – | F/S | Anteil des Frost-Faktors, um den auch die Verdichterleistung sinkt (Massenstrom); kalibriert auf COP −3 °C ≈ 3,7 (L5 4013336) und −7 °C ≈ 3,0 (Datenblatt 3661016) |
| `pel0` | −118,8 | −114,6 | W | M, gefittet | TOP16 = pel0 + Hz · (pelHz + pelRL · Rücklauf + pelAT · AT); bei 16,5 Hz ≈ 10 W je K Rücklauf (bekannt: 12 W/K) |
| `pelHz` | 11,4 | 8,623 | W/Hz | M, gefittet | Strom je Hz (Formel bei pel0) |
| `pelRL` | 0,634 | 0,700 | W/(Hz·K) | M, gefittet | Strom je Hz und K Rücklauf (Formel bei pel0) |
| `pelAT` | −0,284 | −0,233 | W/(Hz·K) | M, gefittet | Strom je Hz und K Außentemperatur (Formel bei pel0) |
| `pelKorrW` | 80,0 |  | W | F/M | TOP16 untertreibt im Lauf um 70–90 W (L5 4545989, 4597230); nur bei laufendem Verdichter |
| `pelPauseW` | 34,0 |  | W | M, gefittet | TOP16 in der Pause mit Pumpe |
| `pelAusW` | 15,0 |  | W | M, gefittet | TOP16 im Heizgrenze-Aus (Pumpe aus) |
| `flowPause` | 13,4 |  | l/min | M, gefittet | Durchfluss in der Pause (Pumpe 1750 U/min) |
| `flowComfort` | 13,7 | 13,4 | l/min | M, gefittet | Comfort: ΔT-geregelt, Pumpe 1750 U/min |
| `flowEff` | [30,21.5,35,90] | [30,21.5,35,95] | min, l/min, min, min | M, gefittet | Efficiency: bis Laufminute a 13,4 l/min, dann b l/min bis Minute c, linear zurück bis Minute d |
| `flowHgNeustart` | 35,0 |  | l/min | M | Spülen beim Ende des Heizgrenze-Aus (33,8–37,7 l/min, 3 min) |
| `flowAbtau` | 21,0 |  | l/min | F | L5 Abtauen: Volumenstrom 10 → 17 → 21 l/min (4288323) |
| `pumpe0` | 1737,0 | 1734,0 | U/min | M, gefittet | Pumpendrehzahl bei 13,4 l/min |
| `pumpeJeL` | 118,2 | 118,5 | U/min je l/min | M, gefittet | Comfort → Efficiency: 1750 → 2870 U/min bei 13,4 → 23 l/min |
| `fanQ` | [347,242,385,248] | [314,270,270,228] | U/min | M, gefittet | Lüfter am Minimum je Quiet 0/1/2/3 (Median; Forum L5 4504115 ähnlich) |
| `fanJeHz` | 3,300 | 3,490 | U/min je Hz | M, gefittet | Lüfter-Zunahme je Hz über dem Minimum |
| `cw` | 0,350 | 0,386 | kWh/K | M, gefittet | Wärmespeicher Wasser + Heizkörper |
| `krad` | 0,180 | 0,152 | kW/K^n | M, gefittet | Heizkörperabgabe krad · (tw − th)^n |
| `nrad` | 1,300 |  | – | A | Heizkörper-Exponent (EN 442, typisch 1,3) |
| `cr` | 0,136 | 0,209 | kWh/K | M, gefittet | Raumluft/Oberflächen an den Heizkörpern (schneller Knoten zwischen Heizkörper und Hausmasse) |
| `hr` | 0,558 | 0,658 | kW/K | M, gefittet | Übergang schneller Knoten → Hausmittel |
| `kv` | 0,0000 |  | 1/K | M, gefittet | Thermostatventile: Abgabe × max(0,2; 1 − kv · (tr − tvRef)) – je wärmer die Luft an den Heizkörpern, desto weniger Abgabe (Ventile am 15.10. nachgestellt) |
| `tvRef` | 22,0 |  | °C | A | Bezug der Ventil-Drosselung |
| `tauLokMin` | 240,0 |  | min | A | Fühler im Innengerät bei stehender Pumpe: Auskühlen zur Raumtemperatur |
| `ua` | 0,151 | 0,157 | kW/K | M, gefittet | Wärmeverlust des Hauses (plan_algo: 141 W/K) |
| `gain` | 0,225 | 0,265 | kW | M, gefittet | innere Gewinne (plan_algo: 0,38 kW) |
| `ch` | 3,540 | 3,570 | kWh/K | M/A, gefittet | Speichermasse des Hausmittels |
| `sonne` | 0,0544 | 0,0440 | kW je kW PV | M, gefittet | Sonnengewinn je kW PV-Leistung (PV als Strahlungsmaß) |
| `hausAtTauMin` | 240,0 | 480,0 | min | M, gefittet | die Hülle sieht die Außentemperatur geglättet (Speichermasse der Wände; besser als ungeglättet: RMSE 0,65 statt 0,84 K) |
| `raeume` | {"ki_oben":[2.16621,0.12913,-0.15176,0.09073,30,0.46,11.73,6.12,18.45],"ki_unten":[0.18713,0,0.00441,0,30,0.46,11.73,6.12,18.45],"schlaf":[-0.26172,0.00596,-0.00423,0.01106,30,0.46,11.73,6.12,18.45],"wohn":[4.55467,0.06434,-0.2438,0.00848,60,0.68,11.03,6.12,18.45]} | {"ki_oben":[3.45341,0.13742,-0.3,0.04353,30,0.63,11.28,6.82,16.08],"ki_unten":[0.79303,0.02596,-0.05794,0.02471,480,2.14,9.32,6.82,16.08],"schlaf":[-0.9995,0,0.05638,0,30,0.63,11.28,6.82,16.08],"wohn":[5.71149,0,-0.3,0.09678,30,1.54,11.28,6.82,15.96]} | K, –, –, K/kW, min, K… | M, gefittet | je Raum Abweichung vom Hausmittel (Kinderzimmer oben ohne eigenes Relais/Heizlüfter-Modell: mittleres Verhalten); keine Extrapolation über den gemessenen Bereich |
| `raumAtTauMin` | 360,0 |  | min | A | Zeitkonstante des AT-Filters für die Räume |
| `raumPvTauMin` | 120,0 |  | min | A | Zeitkonstante des PV-Filters für die Räume |
| `pipe0` | 1,358 |  | K | M, gefittet | AT − Rohr = pipe0 + pipeQ · Verdampferleistung (kW) · 300 / Lüfter (U/min); mit Lüfter besser als ohne (RMSE 0,92 statt 1,07 K); Frost: Lüfter L5 630 U/min bei −13 °C (F 4600750) |
| `pipeQ` | 1,046 |  | K/kW | M, gefittet | siehe pipe0 |
| `pipeTauMin` | 3,000 |  | min | A | Zeitkonstante des Rohrfühlers |
| `pipeSprungK` | 0,700 |  | K/Hz | F/A | Pseudo-Abtauung: Frequenzsprung über +30 % des langsamen Mittels senkt das Rohr (L5 4540566: 1 → −16 °C; L7 4230252; Schwelle 4868882 V) |
| `pipeSprungAnteil` | 0,300 |  | – | F | gefährlicher Sprung ab etwa +30 % (4868882, V) |
| `pipeSlowMin` | 30,0 |  | min | A | Zeitkonstante des langsamen Frequenzmittels (träges Expansionsventil, F 4368657 E) |
| `abtauAtMax` | 5,000 |  | °C | H | Abtau-Logik nur bei niedriger Außentemperatur (Handbuch J 15.2.2; Force-Defrost-Grenze 5 °C) |
| `abtauLinie` | [-13.5,0.6] |  | °C | F/A | Auslöser Rohr < a + b·(AT + 9): Anker „OutsidePipe 2 min unter −13/−14 °C bei −9 °C“ (4600685 E), Linie der L ~5 K höher als im Handbuch (4890839, 4371449) |
| `abtauHaltMin` | 3,000 |  | min | H | Rohr 3 min am Stück unter der Linie (Handbuch J 15.2.2) |
| `abtauMinHeizMin` | 35,0 |  | min | H/F | Heizzeit seit der letzten Abtauung > 35 min (Handbuch J; L7 4613622) |
| `abtauDauerMin` | 8,000 |  | min | F | L5: 8 min (4288323); J ~9 min (4598540), Handbuch max. 9,5 min |
| `abtauWaermeKWh` | 0,500 |  | kWh | A | Wärmeentzug aus dem Heizwasser je Abtauung (im Forum nicht beziffert) |
| `abtauHz` | 58,0 |  | Hz | F | Abtauen bei ~58 Hz (L5 4092731, L7 4548650) |
| `abtauPelW` | 1000,0 |  | W | A | Stromaufnahme beim Abtauen (TOP16) |
| `nachAbtauEffMin` | 20,0 |  | min | F | Efficiency hält nach dem Abtauen ~20 min niedrige Frequenz (L5 4582615, L7 4095732) |
| `nachAbtauComfortHz` | 50,0 |  | Hz | F | nach dem Abtauen startet die L5 normalerweise mit ~50 Hz (4542523); hier 3 min, gedeckelt durch die Höchstfrequenz |
| `eisRate` | 0,0182 | 0,0178 | 1/(min·K) | A, kalibriert (Annahme-Anker) | Vereisung je min und K (Taupunkt − Rohr), wirkt als Rohrabsenkung 1 K je Einheit; kalibriert auf den Forum-Anker |
| `eisAnker` | [0,90,90] |  | °C, %, min | F/A | Kalibrieranker: bei 0 °C, 90 % Feuchte und Mindestlast Abtauung alle ~90 min (L5 gedämmt „worst case ~90 min“ 4879325 E; L9 0,8 °C 94 %: 35 min und 1:40 h 4132154) |
| `eisSchmelzJeK` | 0,0200 |  | 1/(min·K) | A | Abbau der Vereisung im Stillstand je K über 0 °C |
| `forceDefrostAuto` | 0,0000 |  | 0/1 | H | Force Defrost „Auto“ (alle 3 h unter 5 °C) – Werkseinstellung Manual (Handbuch J Z. 6965); bei der L nicht belegt |
| `hsFrei` | 1,000 |  | 0/1 | M | heizstab_raum_frei = 1 im Protokoll; ob der Heizstab an der Anlage wirklich freigegeben ist, ist offen (L ab Werk aus, F 3957497) |
| `hsOnAT` | 0,0000 |  | °C | M | Heater_On_Outdoor_Temp 0 °C |
| `hsStartK` | −3,000 |  | K | M | Heater_Start_Delta −3 K |
| `hsStopK` | −1,000 |  | K | A | Aus bei Vorlauf ≥ Soll − 1 K (Hysterese 2 K wie im Forum-Beispiel 4581693; Heater_Stop_Delta nicht im Protokoll) |
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
  "n": 7219,
  "rmseW": 254.2,
  "modell": "Pth = Hz · (a + b · (AT − 5)) · (1 + c · max(0, VL − Soll − 1))"
 },
 "strom": {
  "n": 7219,
  "rmseW": 20.1,
  "modell": "TOP16 = c0 + Hz · (c1 + c2 · RL + c3 · AT)",
  "dPel_dRL_16_5Hz": 10.47,
  "dPel_dAT_16_5Hz": -4.69
 },
 "standby": {
  "nPause": 2217,
  "nAus": 1968
 },
 "pumpe": {
  "nEff": 4185,
  "rmseEff": 2.65,
  "nComfort": 708,
  "comfortQuelle": "gemessen",
  "rmsePumpe": 22
 },
 "luefter": {
  "n": 7219,
  "rmse": 53,
  "minutenJeQuiet": [
   2181,
   784,
   238,
   4016
  ]
 },
 "rohr": {
  "n": 1238,
  "rmseK": 0.92,
  "quelle": "Trainingstage",
  "atBereich": [
   3,
   15
  ]
 },
 "startStopp": {
  "stopp": {
   "n": 27,
   "maeMin": 4.74,
   "biasMin": -0.3
  },
  "start": {
   "n": 26,
   "maeMin": 10.58,
   "medianMin": 4.5,
   "biasMin": -5.42
  }
 },
 "regler": {
  "n": 7379,
  "rmseHz": 1.111,
  "auswertungen": 157
 },
 "wasserkreis": {
  "n": 9476,
  "rmseK": 0.825,
  "segmentMin": 360,
  "nrad": 1.3
 },
 "zyklen": {
  "vorher": {
   "verlust": 1.829,
   "wasserkreisRmseK": 0.825,
   "logFehler": 0.239
  },
  "nachher": {
   "verlust": 1.72,
   "wasserkreisRmseK": 0.847,
   "logFehler": 0.198
  },
  "auswertungen": 54
 },
 "haus": {
  "n": 3883,
  "rmseKKalt": 0.479,
  "biasKKalt": 0.003,
  "rmseKAlle24h": 0.635,
  "hausmittel": "ki_unten + schlaf",
  "bilanzpunktC": 19.8,
  "verfahren": "UA, Gewinne, Speicher, AT-Glättung: Simulation 48 h, Fehler bei AT ≤ 8 °C; Sonne und Startwerte aus 24-h-Energiebilanzen",
  "energiebilanz": {
   "fenster24h": 73,
   "ua": 0.1511,
   "gain": 0.2251,
   "sonne": 0.0544,
   "bilanzpunktC": 19.8,
   "vorwert": "UA 0,154 kW/K, Gewinne 0,3 kW als 2 Pseudo-Tage (−5/+10 °C)"
  }
 },
 "raeume": {
  "ki_oben": {
   "n": 11276,
   "rmseK": 0.853
  },
  "ki_unten": {
   "n": 11276,
   "rmseK": 0.408
  },
  "schlaf": {
   "n": 11276,
   "rmseK": 0.406
  },
  "wohn": {
   "n": 9826,
   "rmseK": 1.616
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
    "intervallMin": 99.3,
    "soll": "Forum J5 2911944/2913337 (nicht L): alle 1–2 h bei −5…−10 °C"
   },
   {
    "at": -9,
    "rh": 85,
    "abtauungen48h": 34,
    "intervallMin": 85.4,
    "soll": "Forum 4600685 (E): Kriterium Rohr < −13/−14 °C bei −9 °C"
   }
  ]
 }
}
```

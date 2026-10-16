# Algorithmus für die Wärmepumpe (Konzept, Schritt 1)

Stand 15.10.2026, Branch `algorithmus` (Basis: live `regel-heizregelung` 7ebd67a). Nur Konzept und Offline-Planer. Nichts ist eingespielt, nichts schaltet.

**Kennzeichnung der Zahlen:**
- **M** Messung an dieser Anlage (07.–15.10.2026, AT 1…17 °C).
- **F** Forum photovoltaikforum 189605 (Beitrags-ID, Modell, Art: M Messung, E Erfahrung, S Einstellung/Handbuch, V Vermutung).
- **A** Annahme.
- **N** Vorgabe des Nutzers.
- **R** Regelwerk `tools/engine_core.js`.
- **S** Ergebnis des Offline-Planers `tools/plan_algo.js` auf den echten Protokollen 07.–15.10.

## 0. Kurzfassung

- **Ziel:** wenig Strom je Gradstunde Wärmebedarf, bei gehaltenen Raumbändern. Geld ist nicht der Maßstab.
- **Vier Schichten:** (1) Wärmebedarf je Stunde, (2) niedrigster Soll-Vorlauf für den knappsten Raum, (3) Leistung nach Bedarf, (4) 24-h-Plan im 15-min-Raster mit dynamischer Programmierung.
- **Der Plan schaltet nie selbst.** Er erzeugt Vorschläge für die bestehende Übernahme-Kette (Whitelist, 6 Befehle/Tag, Rücklesen, Rückweg).
- **Replay 07.–15.10. (S):** Bei gleichem Komfort spart der Plan **1,7 %** Strom (0,85 kWh in 7 vollen Tagen, je Tag 0,0–3,9 %). Mit Komfort-Reparatur (+1 K für zu kalte Räume) ist er **neutral** (−0,2 %).
- **Woher der Nutzen kommt (S):** zu gleichen Teilen kühlere Räume (−0,40 kWh) und niedrigerer Vorlauf (−0,35 kWh). Verschieben in COP-günstige Stunden bringt fast nichts (−0,06 kWh). Quiet/Heizregelung bringen fast nichts (−0,02 kWh).
- **−1 K geht nur nachts.** Tagsüber steht der Soll schon auf 29 °C (Untergrenze, N). Alle −1-K-Stunden des Plans lagen zwischen 20 und 10 Uhr (S). Das ist im Kern eine Korrektur der Heizkurve auf der kalten Seite.
- **Gebäudemodell repariert (S):** Das alte Modell (Heizgrenze tbal 15 °C fest) lag um 6,8 kWh Wärme je Tag daneben, das neue (UA·(T_innen − T_außen) − Gewinne, gelernt) um 4,3 kWh. Bei 15 °C sagt das alte 0 kW voraus, das neue 0,5–0,85 kW; gemessen sind 0,65–1,25 kW (M, heizgrenze-analyse).

## 1. Ziel und Maßstab

**Zielgröße:** kWh Strom je Kelvinstunde Wärmebedarf bei gehaltenem Komfort (Beobachter-Kennzahl „Gradstunden“, N 13.10.).
- Gradstunden eines Tages: Σ je Stunde max(0, Raummittel − Außentemperatur).
- Strom: TOP16 im Lauf **+80 W** (F 4545989 L5 M: 70–90 W unter Shelly; R `COP_KORR`).
- Komfort: Minuten und Kelvinstunden unter dem Minimum je Raum (Lüften ausgenommen, wie in der Bewertung, R).

**Wichtig:** Kühlere Räume senken Strom **und** Gradstunden fast im gleichen Verhältnis.
- Der Raum-Hebel verbessert also kWh/Kh kaum (S: 23,2 → 22,9 Wh/Kh), spart aber absolut Strom.
- Deshalb weist der Planer immer beides aus: kWh absolut und kWh/Kh.

**Energiepreise sind kein Maßstab** (Netzbezug ~1 % des Verbrauchs, M VRM). Zwei Ausnahmen gehen als Gewicht in die Kosten ein:
- PV-Überschuss bei Akku-SoC ≥ 95 % zählt mit Faktor 0. Überschuss = PV-Prognose − Grundlast − Wärmepumpe. Die Grundlast stammt aus VRM (nachts 500–650 Wh/h, M) und ist tagsüber angenommen (A). Die Wallbox ist nicht prognostiziert.
- Nachts (22–06 Uhr) ist der Verkaufspreis 0 € (M VRM-DESS). Nächtlicher Überschuss hat also keinen Wert. Strom aus dem Akku kostet nur den Verschleiß (0,01 €/kWh). Der Maßstab bleibt trotzdem kWh.

## 2. Was die Anlage vorgibt (Wirkkette, gemessen)

| Glied | Wert | Quelle | Folge für den Algorithmus |
|---|---|---|---|
| Stopp | Vorlauf = angezeigter Soll +3,0…+3,25 K, 20 von 20 | M | Laufende = Vorlauf > Soll +1 K: dort keine Eingriffe an Quiet/Heizregelung und kein −1 K |
| Start | Vorlauf ≈ Soll −3,25 K, ~9 min Verzug; Forum-Regel „Rücklauf beim Stopp −3 K“ (F 4004893, L7) trifft 24,6 min zu früh | M | Start-Modell aus dem Soll (R `START`) |
| Soll | nur ganze Grad, 5-min-Raster, flattert an der Rundungsgrenze (54 Wechsel in 5,3 Tagen) | M | Verschiebung in ganzen Grad, ±1 K je Schritt, 10 min Abstand zu einem natürlichen Sollsprung (R) |
| Heizgrenze 12 | aus ab 15 °C, an bei ≤ 12 °C | M | Zustandsautomat im Plan; im Aus wirkt keine Verschiebung |
| Mindestleistung | 16–17 Hz ≈ 2,0–2,2 kW th, 360–400 W roh + 80 W | M | Unter ~2 kW Bedarf: Taktbetrieb |
| Bedarf im Replay | Tagesmittel 0,85 kW (08.10., 12 °C) … 1,78 kW (12.10., 6 °C) | M/S | Fast immer unter der Mindestleistung: Läufe 110–200 min, Pausen 60–150 min; bei 2–5 °C Dauerlauf 10–16 h |
| Startspitze | 28–35 Hz, 640–910 W für wenige Minuten, ~10 Wh je Start | M | Startkosten im Plan |
| Quiet-Deckel | Q3 16–17 Hz; Q2 17 Hz bei 12 °C, 20–21 Hz bei 1–2 °C; Q1 21 Hz; Q0 30–35 Hz | M | Am Minimum senkt Quiet nur den Lüfter (330/270/220 U/min), kein messbarer COP-Unterschied |
| Comfort/Efficiency | Comfort startet sofort mit 30–35 Hz; Efficiency bleibt bei 16–17 Hz und hebt erst ab Laufminute 39–46 an | M | Comfort bei mildem Wetter = mehr Leistung in kürzerer Zeit, nicht weniger Strom |
| Wechsel im Lauf | Heizregelung: Pumpe springt 1750 → 2850–2900 U/min; Quiet-Wechsel am Laufende löste zweimal binnen 8 min einen Stopp aus (13.10.) | M | Wechsel nur in der Pause bzw. nicht am Laufende |
| COP (+80 W) | < 4 °C 4,30 · 4–8 °C 4,62 · 8–11 °C 4,92 · ≥ 11 °C 5,51 | M | COP-Kennfeld je Außentemperatur; Unterschiede zwischen Stunden eines Tages höchstens ~15 % |
| Messfehler Wärme | Durchfluss × Spreizung, 0,25-K-Raster → ±10 % je Wert | M | COP-Unterschiede < 10 % sind Rauschen; COP nur als Veto (R `copTol`) |
| Vorlauf | Soll −1 K ≈ 3–4 % weniger Strom (12 W/K) | M (Schätzung aus P el = −33 W + 11,8 W/K × Rücklauf) | Hebel „Vorlauf“ im Plan: 3,5 %/K |
| Untergrenze | Soll-Vorlauf nie unter 29 °C; die Kurve erreicht 29 °C ab ~11 °C | N | −1 K nur bei Soll ≥ 30 °C, also meist nur nachts |
| Außenfühler | extern, im Schatten; weicht von OWM −2…−4 K ab (klare Nächte), einmal +2,6 K bei Sonne; kein Offset | M | Prognose an den Fühler verankern und die Abweichung je Uhrzeit lernen |

## 3. Forenerkenntnisse und wie sie eingehen

Jede Zahl unten ist im Originalbeitrag nachgelesen (BERICHT_LEISHA.md) oder ausdrücklich als nicht übertragbar markiert.

| Befund | Beleg | Übertragbar? | Umsetzung |
|---|---|---|---|
| Mindestfrequenz L5: 16 Hz bis −3 °C, 25 Hz ab ≤ −4 °C (~2 kW), 35 Hz ab ≤ −10 °C, unabhängig von Quiet | F 4593782, 4596796 (L5 M), 4593801 (L5 M: „trotz FM3“) | ja (gleiches Modell) | Tabelle R `MINHZ`; Mindestleistung im Plan 2,1 / 2,0 / 2,8 kW (2,8 kW = A); bei Frost sind Quiet-Deckel irrelevant; Takten verschwindet erst spät |
| TOP16 untertreibt 70–90 W | F 4545989 (L5 M), 4597230 (L5 M) | ja | +80 W im Lauf (R) |
| Efficiency hält nach dem Abtauen ~20 min niedrige Frequenz | F 4582615 (L5 M), 4095732 (L7 M) | ja | Abtau-Rückstand = Comfort-Bedarf (R Regel Heizregelung, 30 min) |
| Pseudo-Abtauungen bei Frequenzsprung nach langem Niedriglauf | F 4540566 (L5 M), 4230252, 4581423 (L7); Sprung > 30 % gefährlich (4868882, V) | ja | Kein +1 K bei Abtauwetter (−5…+4 °C, Feuchte ≥ 80 %, A), außer ein Raum liegt ≥ 0,5 K unter Minimum; Sperre R `abtausprung` bleibt |
| Externer Fühler → mehr Abtauungen | F 4890713, 4890839 (L7, E) | Lage hier umgekehrt (Fühler im Schatten, Gerät in der Sonne, N 14.10.) | kein Offset; Abtauungen im Winter je AT/Feuchte/Sonne zählen |
| Force-Defrost AUTO: nach 3 h ohne Abtauung unter 5 °C | F 2914921 zitiert Service Manual **Serie J**; Handbuch J: Werkseinstellung „Manual“ (Z. 6965) | nur bedingt (Serie J) | nicht im Modell; im Winter prüfen, ob die L zyklisch abtaut |
| Abtauzyklen alle 1–2 h bei −5…−10 °C und 82–90 % Feuchte | F 2911944, 2913337 (**J5**, E) | nicht belegt für die L; L5 im gedämmten Haus „worst case ~90 min“ (F 4879325, E) | Abtau-Risiko je Start als Annahme 0,02 kWh (A) |
| Heizstab: Freigabe unter Heater_On_Outdoor_Temp 0 °C, Start-Delta −3 K, Verzögerung 15 min | Einstellungen der Anlage (M, Protokoll); Logik Handbuch J Z. 9316–9322 | ja (Einstellungen gemessen) | Heizstab-Nähe unter 2 °C: kein +1 K im Lauf, wenn der Rückstand danach ≥ 2 K wäre (R RE-6); Comfort vor Heizstab (N 14.10.: „Heizstab wichtig bei −10 °C“) |
| −1 K bei Kälte nur mit Rücklauf ≥ 28 °C | R RE-6 (Heizstab beim Abtauen ab Wassereintritt < 27 °C, Handbuch J Z. 9364–9369) | vorsorglich | Ausführungssperre im Plan |
| H23 (Kältemittelfühler Innengerät) | F 3483282, 4130989, 4571850, 4694333 (L5 Bj. 07/2023) | ja | Wächter R `stoerung`: kein Vorschlag, keine Übernahme |
| COP bei −5 °C / 5,7 kW ≈ 3,05 | im Forum-Text nicht wiedergefunden (V) | nein | stattdessen Rückfall-Tabelle: Datenblatt −7 °C 3,01 (F 3661016, S), L5 −3 °C ~3,7 (F 4013336, M), 1 °C 4,34 (F 4040222, M) |

## 4. Schicht 1: Wärmebedarf je Stunde

**Modell:** P = UA · (T_innen − T_außen) − g, je Stunde, nicht unter 0.
- T_innen ist das Mittel der gültigen Räume (Wert bis 12 h alt, R).
- g sind die Gewinne (Personen, Geräte, Sonne im Tagesmittel).
- Sonne und Wind kommen später über den bestehenden Weg (`bs` ≤ 0,5, `bw` ≤ 0,0125, Totzone 4 m/s, `coefActivate`, Gate 10 Tage; R/Fahrplan).

**Lernen:** Regression der Tageswärme über (T_innen − T_außen), nur vollständige Vortage.
- Vorwert aus der Auslegung: 5 kW bei −13 °C und 21 °C innen → UA ≈ 0,15 kW/K (A). Dazu g 0,3 kW (A). Gewicht 2 Pseudo-Tage.
- Ab 2 Lerntagen gilt das gelernte Modell.
- Ergebnis über 7 volle Tage (S): UA 141 W/K, g 0,38 kW. Der Bilanzpunkt liegt bei ~19,5 °C (22,2 °C innen − 2,7 K Gewinne). Das passt zum Review (q ≈ 0,146 · (19 − AT), M).

**Warum das alte Modell um den Faktor 3–5 zu tief lag:**
- Der Wärmefahrplan rechnet mit einer festen Heizgrenze tbal = 15 °C. Das ist die Aus-Schwelle der Anlage, nicht der Bilanzpunkt des Hauses.
- Das Haus braucht bis ~19–20 °C Wärme. Zwischen 15 und 20 °C sagt das alte Modell 0 kW. Gemessen sind 0,65–1,25 kW bei 14–16 °C (M, heizgrenze-analyse 2.2).
- Das gelernte UA = ΣQ/ΣKh(15) wird dadurch zu steil (0,22–0,24 kW/K statt 0,14). An kalten Tagen gleicht sich das teilweise aus, an milden nicht.
- **Behebung:** Bilanzpunkt aus den Raumtemperaturen und gelernten Gewinnen statt fest 15 °C. Im Replay sinkt der Tagesfehler von 6,8 auf 4,3 kWh Wärme (S). Bei 15 °C liefert das neue Modell 0,5–0,85 kW (S).

**Prognose:**
- OWM-Prognose (3-h-Punkte), an den Fühler verankert. Die Anfangsabweichung klingt mit 4 h ab (R Fahrplan `anchorTauH`).
- Neu: **Tagesgang der Abweichung Fühler − OWM**, Mittel je Uhrzeit über 3 Vortage (wie die Tagesgang-Bereinigung der Vorausschau, R `tagesgangTage` 3). Der schattige Fühler ist nachts systematisch kälter. Ein Tag wie der 12.10. (Tagesmittel Prognose 9,2 °C, Fühler 6,4 °C) bleibt trotzdem ein Fehler.
- Heizgrenze als Zustandsautomat auf der Prognose (aus ab 15 °C, an bei ≤ 12 °C, M).

**Lern-Hygiene:** nur vollständige Tage (≥ 90 % erfasst). Das Wohnzimmer (Shelly Gen1 am USB, Eigenerwärmung, bis 14.10. 13-h-Lücken) geht mit, solange sein Wert ≤ 12 h alt ist.

## 5. Schicht 2: niedrigster Soll-Vorlauf für den knappsten Raum

**Geregelte Größe:** die Verschiebung s ∈ {−1, 0, +1} (Whitelist, R). Sie ist eine Stellgröße mit Trend und Vorausschau, kein Ereignis.

**Führungsraum:** der knappste gültige Raum (kleinster Abstand zu seinem Minimum).
- Kinderzimmer oben zählt nur bei offenem Radiator-Relais (eigene Regelung, R RE-8).
- Ein gelüfteter Raum zählt 60 min nicht (Sturz ≥ 1 K binnen 60 min oder ≥ 1 K/h, R).

**Ziel:** Minimum + 0,3 K Reserve (A, wie `notK`).
- Totband von Minimum − 0,2 K bis Minimum + 0,3 K. Dort bleibt die Verschiebung, wie sie ist.
- +1 K nur bei Bedarf: knappster Raum ≥ 0,2 K unter Minimum und nicht in Erholung (R `kaltK`).

**Raumprognose ohne Plan:** jetziger Wert plus Trend (Regression über 2 h), höchstens ±0,5 K/h, 2 h fortgeschrieben, danach gehalten (A).
- Die eigene Wirkung führt der Planer als eigenen Zustand ΔT_Modell mit. Er rechnet sie aus seinen Befehlen, nicht aus den Räumen.

**Raumwirkung des Vorlaufs (A, nicht gemessen):**
- Linear um den Ist-Verlauf: C · dΔT/dt = K_rad · (s − ΔT) − UA · ΔT.
- Gleichgewicht ΔT = k · s mit k = 0,5 K Raum je K Vorlauf (Review 5.2, A). Zeitkonstante C/(K_rad + UA) ≈ 10 h bei C = 3 kWh/K.
- Über lange Zeit ist die eingesparte Wärme UA · k · ∫s dt, unabhängig von C. C bestimmt nur, wie schnell die Räume reagieren. Davon hängt das Komfortrisiko ab.

**Grenzen:**
- ganze Grad, ±1 K je Schritt;
- Gegenrichtung frühestens 60 min, ohne Komfort-Notfall 240 min (R);
- ≤ 6 Befehle je Tag (R Übernahme);
- Soll + s ≥ 29 °C (N), mit 1 K Rand an der Rundungsgrenze (A, gegen das Flattern; RE-2);
- −1 K im Lauf nur bei Vorlauf ≤ Soll, sonst in der Pause (R);
- −1 K unter 3 °C nur mit Rücklauf ≥ 28 °C (R RE-6);
- kein Befehl im Abtauen, im Heizgrenze-Aus und 10 min nach einem natürlichen Sollsprung.

**Wärmeverteilungskonflikt:** Liegt ein Raum über Maximum und einer unter Minimum, verschiebt der Plan nicht. Es gibt den Hinweis „hydraulischer Abgleich/Thermostatventile“ (R). Ausnahme: der kalte Raum liegt ≥ 0,5 K unter Minimum (Komfort vor Energie, R `verteilNotK`).

**Rückweg:** sofort auf 0, wenn der knappste Raum unter sein Minimum fällt (Notfall) oder der Soll auf 29 °C fällt.

**Befund (S):** −1 K ist nur möglich, wenn der Soll ≥ 30 °C ist (51 % der Zeit, M), also bei AT ≤ ~10 °C. Im Replay lagen alle 28 Stunden mit −1 K zwischen 20 und 10 Uhr. Das wiederholt sich jede kalte Nacht. Es ist der Hebel „Heizkurve kaltseitig senken“ (Review 5.2), nur täglich nachgestellt.

## 6. Schicht 3: Leistung nach Bedarf

**Regime:** Bedarf unter der Mindestleistung → Taktbetrieb; darüber → Modulation.
- Mindestleistung je AT: 2,1 kW (16 Hz, M), 2,0 kW ab −4 °C (25 Hz, F 4596796), 2,8 kW ab −10 °C (35 Hz, A).

**Taktbetrieb (der Normalfall im Herbst):**
- Läufe lang halten. +1 K im Lauf erst bei Vorlauf ≥ Soll + 1 K (sonst Hochlauf unter Quiet 0: +48 % Strom, M 11.10.). Nur mit belegtem Takt (R Deckel/Laufzeit v5). Im Replay gab es keinen: 32 Läufe, 2 unter 60 min (beide an der Heizgrenze), Median 150 min (S).
- Starts in COP-günstige Stunden: das macht der Plan über die COP-Kosten je Slot. Der Nutzen ist klein (S: −0,06 kWh in 7 Tagen).
- Keine Eingriffe am Laufende (Vorlauf > Soll + 1 K) an Quiet und Heizregelung (M 13.10.: zwei Stopps binnen 8 min).

**Modulation (Bedarf über der Mindestleistung):**
- Quiet-Deckel so hoch wie nötig (R Quiet-Freigabe v3, Deckel-Tabelle).
- Comfort nur bei Rückstand, Heizstab-Nähe oder nach dem Abtauen (R Heizregelung v1).
- Das COP-Kennfeld (Modus × Quiet × Band, ≥ 60 min, R `copMinMin`) dient nur als Veto (10 %). Ab 28 Hz ist der COP 3 % schlechter (M, korrigiert; roh −5…−15 %). Darunter ist kein Unterschied messbar.

**Frost:**
- Die Mindestfrequenz-Tabelle macht den Quiet-Deckel irrelevant (F).
- Abtauwetter: keine Frequenzsprünge (kein +1 K, keine Freigabe nach langem Niedriglauf, R `abtausprung`).
- Nach dem Abtauen ~20 min Efficiency-Trägheit → Comfort-Bedarf (F 4582615).
- Heizstab-Nähe: Comfort vor Heizstab (N).
- H23 sperrt alles (R).

**Im Plan:** Die Leistungswahl ist eine Regel je Slot, keine DP-Dimension.
- Grund: Die gemessenen COP-Unterschiede zwischen den Stufen liegen im Messfehler (±10 %). Eine DP würde Rauschen optimieren.
- Sobald der Stromzähler da ist und die Kennfeld-Zellen sich um mehr als 10 % unterscheiden, kommt sie als dritte Entscheidung in die DP (gleiche Kostenfunktion).
- Im Replay bewertet der Planer den Hebel getrennt: Minuten ≥ 28 Hz ab Laufminute 5, ohne Raumbedarf, über 3 °C × 3 % (S: −0,02 kWh, 2 Befehle in 7 Tagen).

## 7. Schicht 4: 24-h-Plan (dynamische Programmierung)

**Raster:** 15-min-Slots, Horizont 24 h (96 Slots), Entscheidung je volle Stunde.
- Rollierend: Jede Stunde wird neu geplant, ausgeführt wird nur die erste Stunde (Fake-Uhr im Replay, live später jede Stunde).

**Zustand:** ΔT (Raumabweichung durch den Plan, Gitter 0,02 K) und die jetzige Verschiebung s.
- Die Wärmereserve ist C · ΔT. Je Raum ist sie im Modell gleich (A); der knappste Raum bestimmt die Grenze.

**Entscheidung:** s_neu ∈ {s − 1, s, s + 1} ∩ {−1, 0, +1}, mit den Grenzen aus Schicht 2.

**Kosten je Slot** (kWh Strom, gewichtet):
- Strom: ΔE = [(Q_basis + ΔQ) · (1 + 0,035 · s) − Q_basis] / COP(T_außen) + ΔQ/2 kWh · (10 Wh + Abtau-Risiko 0,02 kWh bei Abtauwetter). Der zweite Teil sind die Startkosten im Taktbetrieb (Schaltband ~2 kWh Wärme je Start, M heizgrenze-analyse 4.1).
- Gewicht w = 0 bei PV-Überschuss und Akku ≥ 95 % (einfaches Akkumodell, 43 kWh), sonst 1.
- Komfort, nur was der Plan verschlechtert: 0,25 kWh je K·h unter Minimum + Reserve. Dazu 3 kWh je K·h unter Minimum − 0,2 K. Damit lohnt sich +1 K erst bei echtem Bedarf (A).
- Wärmer: 0,25 kWh je K·h, um die der Plan einen Raum über sein Maximum hebt (A).
- Wechsel: 0,02 kWh je Befehl gegen Flattern (A).
- Restwert am Horizont: −ΔT · C · k / COP. Ein Haus, das kühler endet, muss später nachgeheizt werden.

**COP je Slot:** gemessen je 3-K-Band aus den Laufminuten vor der Planzeit (+80 W, ohne Abtauen, ≥ 60 min). Kälter als die Messung: Rückfall-Tabelle (Abschnitt 3; F10-b: nicht auf Frost extrapolieren).

**Rechenaufwand:** 24 Stunden × 126 Gitterpunkte × 3 × 3 × 4 Slots ≈ 0,1 Mio. Schritte je Plan. Ein Replay über 8 Tage (192 Pläne) braucht ~0,7 s.

**Weg zur Anlage:** Der Plan wird eine sechste Regel `fahrplan` im Kern.
- Sie besitzt die Größe `shift` in der Verschiebungs-Arbitrierung (R `S.arb`, mit Raumeinfluss, Vorausschau und +1 K von Deckel/Laufzeit).
- Ihr Vorschlag ist die erste Stunde des Plans.
- Übernahme nur per Klick: Whitelist, 6 Befehle/Tag, Rücklesen, Rückweg „Frist 6 h“ und „Raum unter Minimum“.
- **Der Plan schaltet nie selbst.**

**Bewertung (Punkte wie bisher, R v5):**
- Prognose −1 K (A): „Ohne −1 K bleibt der knappste Raum ≥ Minimum + 0,8 K“, p 0,7, 120/240/360 min.
- Prognose +1 K: wie Raumeinfluss.
- Dazu die Zielkennzahl je Tag: kWh/Kh und Komfortminuten gegen Vergleichstage gleicher AT.

**Lernen:**
- UA und g täglich (Schicht 1).
- C aus der Auskühlung in Heizgrenze-Pausen und aus der Wirkzeit-Messung (R `S.lag`, Sollsprung → halbe Raumreaktion).
- k aus übernommenen ±1-K-Fenstern.
- COP-Kennfeld (R Takt-Messung).
- Start/Stopp (R `START`).
- Abweichung Fühler − OWM je Uhrzeit.

## 8. Abgrenzung zu den fünf Regeln

| Regel | was der Plan übernimmt | was bleibt |
|---|---|---|
| Raumeinfluss v3 (±1 K) | Die Entscheidung über die Verschiebung kommt aus dem Plan (mit Vorausschau und Trend statt 60 min Haltezeit) | Als **Wächter**: Notfall-Rückweg bei Raum unter Minimum, Wärmeverteilungs-Hinweis, Kurvenform-Kennzahl |
| Vorausschau v2 (−1 K) | ganz (der Plan rechnet mit der Prognose) | stillgelegt, sobald der Plan im Shadow läuft |
| Deckel/Laufzeit v5 | Hebel +1 K (Laufzeit) nur bei belegtem Takt, im Plan als Startkosten | Effizienz-Deckel ≥ 28 Hz als Regel der Schicht 3 |
| Quiet-Freigabe v3 | nichts | bleibt Regel der Schicht 3 (Komfort, Heizstab, Abtauen) |
| Heizregelung v1 | nichts | bleibt Regel der Schicht 3 |
| Sperren, Arbitrierung, Übernahme, Wächter (H23, Dornröschenschlaf, Verteilung) | – | bleiben unverändert und gelten auch für den Plan |

## 9. Ergebnis des Replays (Kurzfassung; Zahlen im Bericht `algorithmus/BERICHT.md`)

- 7 volle Tage (08.–14.10.), Ist 48,9 kWh Strom, 233 kWh Wärme, COP 4,77, 23,2 Wh/Kh (M).
- **Gleicher Komfort** (nur −1 K/0): −0,85 kWh (−1,7 %), je Tag 0,0…3,9 %; 13 Befehle; 210 Minuten neu unter Minimum, zusammen 0,33 K·h (S).
- **Mit Komfort-Reparatur** (−1/0/+1 K): −0,10 kWh (−0,2 %); 25 Befehle; Minuten unter Minimum 1425 → 1290 (S).
- **Obergrenze** (Räume ignoriert, −1 K wann immer möglich): −2,1 kWh (−4,3 %) bei 480 neuen Minuten unter Minimum (S).
- **Sensitivität:** C 1,5…6 kWh/K und UA ±30 % ändern die Ersparnis kaum (−1,6…−1,9 %). k 0,3/0,7 K/K verschiebt sie auf −1,3/−2,2 % (S).
- **Was bindet:** nicht die Komfortreserve (0,3 oder 0,5 K: gleiches Ergebnis), sondern Soll ≥ 30 °C, die Regel „−1 K im Lauf nur bei Vorlauf ≤ Soll“ (hielt den Plan 18 h zurück) und die Wartezeit der Gegenrichtung. Mit „Vorlauf ≤ Soll + 1 K“ (RE-1) wären es −2,6 % (S; Stopps danach nicht simuliert).

## 10. Was fehlt

1. **Winterdaten:** Frost, Abtauen, Heizstab, Mindestfrequenz 25/35 Hz – alles nur aus Forum und Handbuch J.
2. **Wirkung von ±1 K auf die Räume (k) und die Speichermasse C:** nicht gemessen (Verschiebung im Datensatz praktisch immer 0; Wirkzeit-Messung 2 von 3 Ereignissen).
3. **Unabhängiger Stromzähler:** COP-Unterschiede < 10 % sind nicht entscheidbar.
4. **Raumdaten:** Kinderzimmer-Gen3 melden erst ab 0,5 K Änderung; Wohnzimmer-Gen1 mit Eigenerwärmung.
5. **Grundlast- und Wallbox-Prognose** für den PV-Überschuss (VRM-Grundlast nutzbar, R vrm-analyse).

## 11. Risiken

- **Modellfehler bei k und C:** Eine schnellere Raumreaktion als angenommen führt zu mehr Minuten unter Minimum (S: C 1,5 → 120 statt 210 neue Minuten, k 0,7 → 300). Gegenmittel: Notfall-Rückweg, Reserve 0,3 K, erst Shadow.
- **Rundungsgrenze der Kurve:** −1 K kurz vor dem Sprung auf 29 °C erzwingt einen zweiten Befehl. Ohne Rand geschah das im Replay am 14.10. (05:00 −1 K, 05:15 zurück); mit 1 K Rand nicht mehr (S).
- **Wärmeverteilung:** Alle Räume lagen oft über Maximum, aber selten alle zugleich (M). Der knappste Raum begrenzt jede Absenkung. Unter Minimum lag vor allem Kinderzimmer oben (09./10.10., Relais-Failsafe). Die Ventile wurden am 15.10. nachgestellt (N).
- **Schreibbudget:** im Replay ≤ 6 Befehle/Tag, im Mittel 2 (gleicher Komfort) bzw. 3,6 (voll).
- **Pseudo-Abtauungen** durch +1 K: im Plan gesperrt bei Abtauwetter; ungeprüft ohne Winterdaten.

## 12. Stufenplan bis zur Regel „Fahrplan“

1. **Jetzt (offline, erledigt):** Konzept, Offline-Planer, Replay 07.–15.10. (dieser Branch).
2. **Gebäudemodell im Wärmefahrplan umstellen** (`opt_plan`, nur Anzeige): Bilanzpunkt aus Räumen und gelernten Gewinnen statt tbal 15; Tagesgang Fühler − OWM. Nur mit Go.
3. **k und C messen:** einzelne −1-K-Vorschläge des Raumeinflusses nachts per Klick übernehmen (schon freigegeben), 3–5 Nächte; Wirkzeit-Messung auf ≥ 3 Ereignisse.
4. **Stromzähler** an der WP (Shelly) – entscheidet über Quiet/Heizregelung und schärft den Vorlauf-Hebel.
5. **Regel `fahrplan` im Shadow** (Kern, Arbitrierung `shift`, Punkte v5, Zielkennzahl) über mindestens eine kalte Woche; Vergleich mit Raumeinfluss v3.
6. **Übernahme per Klick** für `fahrplan` erst nach Go des Nutzers; Vorausschau dann stilllegen.
7. **Leistungsmodus in die DP** erst mit Stromzähler und Winterdaten.

## 13. Werkzeuge

- `node tools/plan_algo.js <Datenordner> [--md [Datei]] [--json Datei] [--schnell]` – Replay mit Fake-Uhr, Bericht.
- `node tools/plan_algo_test.js [Datenordner]` – Tests: Determinismus, keine Räume, Frost, Abtauen, Heizgrenze-Aus, VL ≥ 29 °C, Wärmeverteilung, Ausführungsgrenzen, kein Blick in die Zukunft, Modellphysik, Lernen; optional Echtdaten.
- Alle Parameter mit Herkunft stehen in `PARAM` in `tools/plan_algo.js`.

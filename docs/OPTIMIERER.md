# Optimierer: Entscheidungsmaschine, Punktesystem, Ein-Klick-Übernahme, Bonsai-Beobachter

Stand 13.10.2026, Branch `quiet-freigabe-v2` (Änderungen gegenüber 12.10.: Abschnitt 13; Seite „Optimierer“ und Klickweg: Abschnitt 14; Seiten: Abschnitte 15–16; Quiet-Freigabe v2 und Deckel/Laufzeit v4: Abschnitt 17, zweiter Review-Durchgang: 17.9). **Alles ist Shadow.** Die Maschine rechnet jede Minute aus, was sie schalten *würde*, und schreibt das auf. Sie sendet nichts. Der einzige Sendeweg ist ein Klick des Betreibers auf „Übernehmen“. Dieser Weg wird gesperrt ausgeliefert.

## 1. Kurzfassung

- **Entscheidungsmaschine** `opt_engine` (Tab „WP Optimizer“, jede Minute): Sie wertet fünf Regeln aus (seit 11.10. mit der **Vorausschau ±1 K**, die bis zur Freigabe des Gebäudemodells gesperrt mitläuft, und der **Verschiebungs-Arbitrierung**, siehe 4a). Je Regel hält sie fest: Status, Grund in Zahlen, nächste Schwelle mit Abstand („würde schalten, sobald …“) und gegebenenfalls einen Vorschlag mit Befehl, Erwartung, Gültigkeit und Rückweg.
  - Jede Auswertung wird ein unveränderlicher Datensatz in `decisions-YYYY-MM.jsonl`, auch „nichts tun“.
- **Punktesystem**: Es arbeitet automatisch und ohne Eingabe des Nutzers.
  - Jeder Vorschlag ist ein Fall. Seine Auslöser-Prognose wird nach dem Brier-Prinzip gegen die Basisrate „bleibt, wie es ist“ bewertet.
  - Eine Wirkungsprognose wird nur bewertet, wenn eine gleichwertige Änderung wirklich passiert.
  - Dazu kommen Abzüge für Schaden und für verpasste Lagen. Unsicheres zählt 0.
  - Das Punktebuch steht in `scores-YYYY-MM.jsonl`. Die Freigabereife ist nur eine Anzeige.
  - Seit den Bewertungsregeln v4 (12.10.) sammeln reine Hinweise keine Punkte mehr, und der Brier-Skill steht erst ab 3 abgeschlossenen Fällen.
  - Seit v5 (12.10., Entscheidung des Nutzers, Weg b) zählt ein Treffer neutral, wenn die Basisrate mindestens bei der Prognose liegt (b ≥ p); Fehlalarme bleiben voll im Abzug.
- **Quiet-Regeln seit 13.10.** (Abschnitt 17, Nutzerregel „wir schalten so, wie es am effizientesten ist“):
  - **Quiet-Freigabe v2** schlägt nur bei echtem Bedarf vor (Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Boost von Hand). Sie erkennt den Deckel je Stufe und Außentemperatur, gibt nur so weit frei wie nötig und hat einen automatischen Rückweg.
  - **Deckel/Laufzeit v4** (vorher „Laufzeit strecken“) hat zwei Hebel: Quiet höher als Effizienz-Deckel, wenn der Verdichter ohne Bedarf mit ≥ 22 Hz läuft; Heizkurve +1 K nur bei belegtem Takt und wenn der geschätzte Nutzen die Kosten übersteigt.
  - Beide Quiet-Regeln teilen sich eine Arbitrierung (4b). Der Mindestabstand gilt über Quiet und Verschiebung gemeinsam (ein Notfall überbrückt ihn nach 10 min); je Größe läuft eine Übernahme, die dieselbe Regel in derselben Richtung fortsetzen darf (17.9).
- **Ein-Klick-Übernahme** `opt_apply`: Es gibt die Knöpfe „Übernehmen“, „Verwerfen“, „Zurücksetzen“ und „Übernahme sperren“. Ausgeliefert wird sie doppelt gesperrt:
  1. Der `mqtt out` ist deaktiviert.
  2. Der Hauptschalter in `apply.json` fehlt, das heißt „aus“.

  Dazu kommen Whitelist, Prüfsumme, Alters- und Ist-Abgleich, Notbremse, Rate und Tageslimit, Rücklesen mit Wiederholung, Rückweg und das Protokoll `applied-YYYY-MM.jsonl`.
- **Bonsai-Beobachter** `tools/bonsai_beobachter.py`:
  - Er rechnet den Tagesbericht selbst und deterministisch.
  - Das lokale LLM beantwortet nur kurze, belegte Fragen. Aussagen ohne gültigen Beleg werden verworfen.
  - Der Beobachter ist nie im Regelkreis.
- **Replay** der echten Protokolle vom 07. bis 10.10.: siehe `docs/replay_2026-10-07_bis_10.md` (mit Nachtrag 07.–12.10., v5).
  - Die Quiet-Freigabe hätte genau einmal angeschlagen, am 10.10. um 08:36 im Boost, 4,7 min vor dem Klick des Nutzers.
  - Kaltstarts lösen sie nicht aus.
  - Mit den Regeln vom 13.10. (07.–13.10., Abschnitt 17.4): Freigabe wieder genau einmal (10.10. 08:36), Rückweg-Grund 11:01; Effizienz-Deckel 3-mal, alle in den 35 h, in denen Quiet 0 nach dem Boost stehen blieb; +1 K nie (kein Takt).

## 2. Architektur

```
HeishaMon (NAS-Broker) ──► opt_hp_in ─► OPT_hp ─┐
HeishaMoNR-Globals (TOP*, compressor_*, F_*, MQTT) ┤
Räume (Venus-Broker) ─► opt_room_in ─► OPT_rooms ─┤          tools/engine_core.js (rein, getestet)
opt_eval (Phase 2) ─► OPT_state.korr (Raumvorschlag) ┤        ┌──────────────────────────────┐
OPT_kz (Radiator) ──────────────────────────────────┴─► opt_engine (jede Minute) │ step(): Regeln, Sperren,     │
                                                            │       │      │ Vorschläge, Punkte          │
                                                            │       └──────┴──────────────────────────────┘
                                                            ├─► decisions-/scores-YYYY-MM.jsonl, quiet-events (Datei)
                                                            ├─► OPT_engine (global: Vorschlag, Sperren, Rückweg-Gründe)
                                                            └─► Seite „Optimierer“ (5 Karten): tools/engine_view.js baut die Daten, tools/eng_ui.js zeichnet sie
Karte „Aktueller Vorschlag“ (Klick: ID + Prüfsumme) ─┐
Takt alle 15 s (opt_i_apply) ────────────────────────┴─► opt_apply ─► opt_apply_mqtt (mqtt out, DEAKTIVIERT) ─► panasonic_heat_pump/commands/…
                                                                  ├─► Meldung (Toast), applied-YYYY-MM.jsonl, quiet-events
                                                                  └─► opt_engine („anzeige“: Karten neu, ohne zu rechnen)
```

**Neue Knoten**, alle `opt_*` im Tab „WP Optimizer“:

| Knoten | Typ | Rolle |
|---|---|---|
| `opt_engine` | function | Kern + Hülle |
| `opt_i_engine` | inject | jede Minute, Start nach 50 s |
| `opt_f_eng` | file | Protokolle |
| `opt_apply` | function | Kern + Übernahme-Hülle |
| `opt_i_apply` | inject | alle 15 s |
| `opt_apply_mqtt` | mqtt out | **deaktiviert** (`"d": true`) |
| `opt_broker_cmd` | mqtt-broker | 10.10.10.128, eigener Client `nodered-optimizer-cmd` |
| `opt_eng_ui_tab` | ui_tab | Seite „Optimierer“, Reihenfolge 12,55 |
| `opt_g_eng_prop`, `opt_g_eng_rules`, `opt_g_eng_score`, `opt_g_eng_mess`, `opt_g_eng_log` | ui_group | je 17 breit (seit 13.10., vorher 18) |
| `opt_t_eng_*` | ui_template | die fünf Karten (seit 13.10. mit `opt_t_eng_mess` „Messwerte & Lernen“, Ausgang 6 von `opt_engine`) |
| `opt_c_eng` | comment | |

**Geänderter Knoten:** `opt_eval`. `OPT_state` bekommt zusätzlich die Felder `korr`, `korrCode` und `korrLead`. Das ist der Raumvorschlag der Phase 2, nur lesend. Das Verhalten ändert sich nicht, `optimizer_sim.js` bleibt grün.

**Generator:** `python3 tools/optimizer_phase1.py <flows.json>` liefert den Übernahme-Knoten deaktiviert aus. Erst mit `--uebernahme-knoten-aktiv` wird er aktiv erzeugt, und das nur nach dem Go des Nutzers.

**Dateien in `/data/optimizer/`:**

| Datei | Inhalt |
|---|---|
| `decisions-YYYY-MM.jsonl` | jede Minute ein Datensatz, gemessen ≈ 2,1 MB/Tag ≈ 63 MB/Monat |
| `scores-YYYY-MM.jsonl` | Punktebuch |
| `engine-state.json` | Zustand: Fälle, Basisraten, Zähler, Verlauf, Episoden der Seite; alle 10 min und bei Ereignissen gesichert |
| `applied-YYYY-MM.jsonl` | jede Klick-, Rücklese- und Rückweg-Aktion |
| `apply-state.json` | Zustand der Übernahme |
| `apply.json` | Hauptschalter und freigegebene Regeln; fehlt = gesperrt |
| `quiet-events-YYYY-MM.csv` | zusätzliche Ereignisse `optimierer_vorschlag`, `optimierer_hinweis`, `optimierer_ende`, `optimierer_punkte`, `optimierer_uebernehmen` … |

**Neustart:**
- Der Zustand kommt aus der Datei. Offene Fälle, Punkte und Tageszähler bleiben erhalten.
- Alle Regeln sind 10 min gesperrt (`anlauf`).
- Die Laufzeit des Verdichters beginnt nach einem Node-RED-Neustart bei 0, weil HeishaMoNR `compressor_runtime` nur im Speicher hält. Das ist vorsichtig: zusätzlich gilt die Startphasen-Sperre von 15 min.

## 3. Eingaben (Schnappschuss je Minute)

Die Hülle baut aus den globalen Werten ein Objekt `inp`. Es wird gerundet als `in` in jeden Datensatz geschrieben. `ENGINE.unsnap()` macht daraus wieder eine Eingabe, so lässt sich jede Minute exakt nachspielen.

| Gruppe | Felder |
|---|---|
| Anlage | Verdichter `hz`, Vorlauf/Rücklauf `vl`/`rl`, Soll `soll`, Ziel-Spreizung `dT` (TOP23), `pel`, `pth`, Durchfluss, Pumpe |
| Stellgrößen | Quiet `q`, Quiet-Priorität, Heizregelung `hc`, Verschiebung `shift` (TOP27) |
| Umgebung und Zustand | Außentemperatur `at`, Abtauen, Warmwasser, Sanftanlauf-Rampe, Laufzeit `rt`, Heizkurvenmodus (TOP76), Zonenfühler (TOP111) |
| Heizstab und Heizgrenze | Zustand und Parameter des Heizstabs, Heizgrenze (`Heating_Off_Outdoor_Temp`) |
| Abgeleitet | Soll laut Heizkurve `sollKurve` (aus `Z1_Heat_Curve_*`), Notbremse `block` |
| Konkurrierende Regler | `otherQ`: HeishaMoNR-Quiet-Logik, Scheduler, Solar, WP-Zeitplan. `otherShift`: RTC, Nachtabsenkung, Sanftanlauf, `SHIFT_Final` ≠ 0 |
| Räume | Wert, Alter, gültig, Band, aktiv |
| Raumvorschlag der Phase 2 | `korr` |
| Sonstiges | Radiator Kinderzimmer oben `kzRad`, HeishaMon-Alter `hpAge` (jüngste Meldung in `OPT_hp`) |

Abgeleitet je Minute (`abl` im Datensatz):
- Zustand: Lauf, Pause oder Heizgrenze-Aus (Pumpe < 1000 U/min)
- Laufminuten
- Vorlauf- und Rücklauf-Rückstand
- „Sollvorlauf in diesem Lauf erreicht“: 3 min ≥ Soll −1 K ab Minute 15; ein Sollsprung nach oben setzt das zurück
- Vorlauf-Anstieg in K/h
- Minuten bis zur Abschaltgrenze Soll +3,25 K
- Starts in 3 h

## 4. Wann würde er was schalten?

| Regel | schaltet (würde), wenn ALLES gilt | dann Befehl | Rückweg |
|---|---|---|---|
| **Quiet-Freigabe** (v2) | Quiet ≥ 1 · Lauf ≥ 15 min (bei Heizstab-Nähe ab Heater_Delay_Time − 5 min − Haltezeit, hier Minute 7) · **Bedarf**: Raum unter Minimum, *oder* Raum fällt im Lauf ≥ 0,2 K/h (Regression, Lüften ausgenommen) und erreicht das Minimum binnen 2 h, *oder* Heizstab-Nähe im Lauf (Außen < Heizstab-Freigabe + 2 K, Vorlauf ≥ 2,5 K unter Soll, im Dauerlauf ≥ 2,0 K), *oder* Boost von Hand (Soll über der Heizkurve, vorläufig) · Verdichter am Deckel der Stufe (≥ Deckel − 1 Hz; Deckel aus Messung oder gelernt) · Vorlauf ≥ 1,5 K unter Soll · Rücklauf ≥ 1,5 K unter Soll-Rücklauf · Zielstufe vorhanden · **10 min am Stück** (Heizstab-Nähe 3 min) · keine Sperre (ein Notfall überbrückt Mindestabstand, Wartezeit, Tageslimit, Vorrang und Gegenrichtung nach 10 min). **Kälte-Vorsorge** (auch in der Pause): unter 2 °C, gemessen oder in der Vorhersage der nächsten 6 h, und die Stufe deckelt hart (≤ 17 Hz) | `SetQuietMode` = nächste niedrigere Stufe, deren Deckel ≥ 3 Hz höher liegt: mit ≥ 60 min Daten, ohne Daten nach der Messtabelle (vorläufig); Notfall ohne Daten und Heizstab-Nähe: 0; eine tiefere nur mit > 10 % besserem COP. Kälte-Vorsorge: nächste Stufe ohne harten Deckel (bei Kälte Quiet 2) | automatisch zurück auf die Ausgangsstufe, sobald der Bedarf 15 min gedeckt ist (alle Räume ≥ Minimum + 0,3 K, Rücklauf ≤ 0,5 K unter Soll) oder ein **Bedarfsraum** 15 min über seinem Maximum liegt; Frist 4 h, sie ruht, solange Bedarf besteht oder die Kälte-Vorsorge eine harte Ausgangsstufe hält (unter 3 °C) |
| **Deckel/Laufzeit** (v4), Hebel Quiet | Quiet < 3 · Lauf ≥ 15 min · ≥ 22 Hz · kein Bedarf (wie bei der Freigabe) und Rücklauf ≤ 1 K unter Soll · alle Räume ≥ Minimum + 0,3 K · seit 2 h kein Bedarf · Außen > 3 °C · Zielstufe aus den Daten (niedrigste höhere Stufe mit ≥ 60 min, Deckel < 22 Hz, COP höchstens 10 % schlechter) · 10 min am Stück · keine Sperre | `SetQuietMode` = Zielstufe | automatisch zurück auf die vorige Stufe bei Bedarf, bei Rücklauf ≥ 2,5 K unter Soll seit 15 min, bei Außen ≤ 3 °C, spätestens nach 8 h |
| **Deckel/Laufzeit** (v4), Hebel +1 K | Takt belegt (Takt-Messung: > 12 Starts in 24 h oder > 25 % kurze Läufe; oder letzter Lauf < 60 min mit Abschaltung über den Vorlauf **und** ≥ 2 Starts in 3 h) · Verdichter unter 22 Hz oder Pause · Verschiebung 0 · kein Raum über der Bandmitte · im Lauf Vorlauf ≥ Soll +1,0 K (sonst Hochlauf), in der Pause Vorlauf > Soll −2 K (sonst Sofortstart) · Nutzen ≥ Kosten aus dem letzten Zyklus · 10 min am Stück · keine Sperre (auch Verschiebungs-Arbitrierung) | `SetZ1HeatRequestTemperature = +1` | automatisch auf 0 bei Heizstab-Nähe, wenn ein Raum mehr als 0,3 K über die Bandmitte steigt, wenn zwei Läufe ohne Takt endeten, spätestens nach 6 h |
| **Raumeinfluss ±1 K** | Raumvorschlag der Phase 2 (−1/0/+1) ≠ Verschiebung der Anlage · seit ≥ 60 min unverändert · bei −1: Soll bleibt ≥ 29 °C · kein Wärmeverteilungsproblem · keine Sperre (u. a. Heizkurvenmodus, Wasserfühler, kein Handeingriff am Soll) | `SetZ1HeatRequestTemperature = −1/0/+1` | automatisch auf 0, sobald der Raumvorschlag 15 min am Stück 0 ist, spätestens nach 6 h |
| **Vorausschau ±1 K** | Gate des Gebäudemodells offen · Bedarfsänderung **aus dem Wetter** ≥ 2 K (Außentemperatur-Äquivalent: Vorhersage im Mittel +2…+5 h gegen jetzt, beide um den gewöhnlichen Tagesgang bereinigt; Tagesgang aus ≥ 3 Vortagen; Sonne/Wind nur mit `coefActivate`) · alle Räume gültig und im Band · Luft im Band ≥ 0,3 K (bei +1 K wärmster Raum unter Maximum, bei −1 K kältester über Minimum) · bei −1 K Soll ≥ 29 °C · Verschiebung steht auf 0 · **30 min am Stück** · keine Sperre, auch nicht „andere Regel“/„Gegenrichtung“ | `SetZ1HeatRequestTemperature = ±1` | automatisch auf 0, wenn die Vorhersage 15 min unter der halben Schwelle liegt, sofort, wenn ein Raum das Band in Gegenrichtung verlässt, spätestens nach 6 h; nicht, solange der Raumeinfluss denselben Wert verlangt |
| **Heizgrenze-Hinweis** | Heizgrenze > 10 °C · Lauf ≥ 15 min bei Außentemperatur > 10 °C · alle aktiven Räume gültig und ≥ Minimum + 0,5 K · 15 min am Stück | nur Hinweis `SetHeatingOffOutdoorTemp = 10`, **nie per Klick** | Saisoneinstellung von Hand |

**Comfort/Efficiency:** Es gibt keine Regel dafür, und die Whitelist kennt `SetHeatingControl` nicht.
- Seit 13.10. gilt die Nutzerregel „wir schalten so, wie es am effizientesten ist“: Quiet muss nicht auf 0 stehen, Wechsel der Heizregelung sind erlaubt.
- Für eine Regel zur Heizregelung fehlen aber die Daten (Comfort nur ~7 h; Review 5.2 und QF-8).
- Die Quiet-Regeln rechnen ihre Ziele und Deckel je Heizregelung (Daten je Heizregelung × Quiet × Außenband).

**Pumpe:** Es gibt keine Regel und keinen Befehl. Die Begrenzung ist auf dem Mainboard programmiert. Gemessen wurden ≈ 23,1–23,8 l/min bei 2900–2950 U/min in jeder Startspitze. `Max_Pump_Duty` 254 sagt darüber nichts. `SetMaxPumpDuty` steht nicht auf der Whitelist, ein Test prüft das.

### 4a. Verschiebungs-Arbitrierung (keine Regel beißt eine andere)

Raumeinfluss und Vorausschau stellen dieselbe Größe (Heizkurven-Verschiebung). Damit sie nicht gegeneinander arbeiten, führt der Kern **einen gemeinsamen Zustand** `S.arb` für alle Regeln der Größe `shift`:

| Feld | Bedeutung |
|---|---|
| `owner`, `soll`, `von`, `start` | Regel mit dem laufenden Verschiebungs-Vorschlag (höchstens eine) und ihr Zielwert |
| `applied` | von der Anlage übernommene Verschiebung einer Regel (der Sollwert steht auf ihrem Vorschlag); endet mit der nächsten Änderung der Verschiebung |
| `last` | letzte beendete Verschiebung: Regel, Richtung, Wert, Ende (solange sie an der Anlage noch steht, gilt „jetzt“ als Ende) |

Regeln:
1. **Eigentum (`vorrang`):** Solange eine Regel einen Verschiebungs-Vorschlag hat oder ihre Verschiebung an der Anlage steht, schlägt keine andere Regel vor, weder daneben noch dagegen. Gleiche Richtung: „dieselbe Verschiebung schlägt schon … vor“.
2. **Gemeinsame Mindesthaltezeit (`shiftHaltMin` 60 min):** Die Gegenrichtung zur letzten Verschiebung ist frühestens 60 min nach deren Ende erlaubt, für jede Regel, auch mit Notfall.
3. **Wartezeit Gegenrichtung (`gegenMin` 240 min):** Zwischen 60 und 240 min nur mit **harter Begründung**: Komfort-Notfall (ein gültiger Raum ≥ `notK` 0,3 K außerhalb des Bandes auf der Seite, die die Gegenrichtung behebt, keiner auf der anderen Seite). Die Vorausschau hat nie einen Notfall und wartet immer 240 min.
4. **Priorität Komfort vor Vorausschau:** Die Vorausschau läuft nie gegen den aktuellen Raumzustand: kein +1 K bei einem Raum über dem Band, kein −1 K bei einem Raum unter dem Band, und sie verlangt alle Räume im Band. Verlässt ein Raum das Band, endet ihr Vorschlag **in derselben Minute** (harte Bedingung, ohne die sonst üblichen 3 min Nachlauf); den Komfortfall übernimmt der Raumeinfluss.
5. **Keine Fehlbewertung fremder Verschiebungen:** Steht an der Anlage die Verschiebung einer anderen Regel, ist das für den Raumeinfluss keine Abweichung. Raumvorschlag 0 → „ruht“ (gehört der Vorausschau), Gegenrichtung → Arbitrierung (Regeln 1–3).
6. **Übergabe statt Hin und Her:** Endet der Vorschlag der Eigentümer-Regel und will die andere Regel dieselbe Richtung, schlägt sie in derselben Minute vor (Neuprüfung nach der Freigabe). In der Übernahme ruhen Rückweg-Grund und Ablauf (`halten`), solange die andere Regel denselben Wert verlangt.

Die Sim prüft das über 8 Fake-Uhr-Tage (4 gewöhnliche Tage mit Tagesgang ±4 K, dann Kälteeinbruch und Milderung) (Shadow und „jeder Vorschlag sofort übernommen“): nie zwei Verschiebungs-Vorschläge gleichzeitig, keine Gegenrichtung vor 60 min, ohne Notfall nicht vor 240 min, die Anlage wechselt nie binnen 60 min.

**Tagesgang herausgerechnet (Entscheidung 11.10.):** Die Vorausschau soll aus dem Wetter folgen, nicht aus der Uhrzeit. Der Kern führt dazu stündliche Mittel der gemessenen Außentemperatur (Fühler; mit aktivem Modell auch PV) über 8 Tage im Zustand (`S.atH`). Der gewöhnliche Tagesgang einer Uhrzeit ist die mittlere Abweichung dieser Stunde vom zentrierten 24-h-Mittel an bis zu 7 Vortagen. Von der Vorhersage (Fenster) und von jetzt wird er abgezogen, verglichen werden die bereinigten Werte. Ein gewöhnlicher Abend, der kälter ist als der Nachmittag, ergibt ~0; derselbe Abend 3 K kälter als üblich ergibt +3 K (Test). Erst ab 3 Vortagen (`tagesgangTage`, Annahme): mit nur einem Vortag erschien im Replay die Kaltfront vom 08.10. abends am 09.10. als −5 K. Vorher „Tagesgang noch nicht bekannt/sicher“ (ruht bzw. bei geschlossenem Gate als fehlende Bedingung). Die bereinigte Bedarfsänderung steht als `abl.vs_dk` im Datensatz.

**Vorausschau bei geschlossenem Gate:** Der Wärmefahrplan legt Lernstand, Gate und `coefActivate` in `OPT_plan.model` ab. Ist das Gate zu (Stand 11.10.: 1 von 10 Tagen), ist die Regel „gesperrt: Gebäudemodell noch nicht freigegeben (n von 10 Tagen)“: keine Vorschläge, keine Fälle, keine Punkte. Die Bedingungen laufen zur Anzeige mit („würde schalten, aber gesperrt“ bzw. „…; außerdem …“), die Vergleichslagen für die Basisrate werden schon gesammelt. Ohne `coefActivate` stehen PV-Prognose und Wind gar nicht in der Eingabe (`in.vs`), die Regel rechnet dann nur mit der Temperatur.

### 4b. Quiet-Arbitrierung (seit 13.10.: Quiet-Freigabe und Deckel/Laufzeit)

Freigabe (Quiet nach unten) und Effizienz-Deckel (Quiet nach oben) stellen dieselbe Größe gegenläufig. Der Kern führt dafür einen gemeinsamen Zustand `S.arbQ` mit denselben Feldern wie `S.arb` (`owner`, `applied`, `last`):
1. **Eigentum (`vorrang`):** Solange eine Regel einen Quiet-Vorschlag hat oder ihre Stufe an der Anlage steht, schlägt die andere nicht vor. Das gilt auch, wenn jemand von Hand genau die vorgeschlagene Stufe stellt. Eine übernommene Stufe weicht nur einem **Notfall** (Raum ≥ 0,3 K unter Minimum oder Heizstab-Nähe), und das frühestens `notfallMin` 10 min nach der Übernahme (bis zum zweiten Review-Durchgang 60 min).
2. **Ende der Zuordnung:** Sie endet, sobald der Rückweg-Grund der Eigentümer-Regel gilt oder ihre Frist abläuft und kein Bedarf sie hält. Das gilt auch, wenn niemand zurückstellt. Sonst hätte im Replay die von Hand übernommene Freigabe vom 10.10. den Deckel 35 h lang blockiert.
3. **Gegenrichtung (`gegenrichtung`):** frühestens 60 min nach dem Ende der letzten Änderung (bei beendeter Zuordnung ab der Übernahme), ein Notfall schon nach 10 min. Zwischen 60 und 240 min (`quietGegenMin`) nur mit Notfall.
4. **Ruhe nach Bedarf:** Der Deckel schlägt binnen 2 h nach einem Bedarf der Freigabe nicht vor (`ruheMin`). Die Freigabe wartet nie auf den Deckel (Komfort vor Effizienz).
5. **Mindestabstand über beide Größen** (Review 3.4): binnen 60 min nach einer Verschiebung keine Quiet-Änderung und umgekehrt. Sonst lässt sich keine Wirkung zuordnen, und Freigabe und +1 K würden doppelt heizen. Ein Quiet-Notfall überbrückt ihn nach 10 min (Review B4: sonst sperrte eine Quiet-Änderung von Hand die Heizstab-Nähe bis Laufminute 30).
6. **Übernahme:** je Größe eine (`OPT_apply.ak.quiet`, `.shift`); Quiet und Verschiebung dürfen nebeneinander übernommen sein, wenn die Arbitrierung es zulässt (Review R6). Dieselbe Regel darf ihre Übernahme in derselben Richtung **fortsetzen** (Review B1: 3 → 2, dann 2 → 0; der Ausgangswert 3 bleibt für den Rückweg). Jede Übernahme hat ihren eigenen Rückweg: `endReason["regel|groesse"]` vor `endReason["regel"]`, und `halten` hält die Freigabe, solange Bedarf besteht. Gründe und `halten` gelten nur von einer Maschine, die höchstens 5 min alt ist; sonst gilt die Frist, nach 30 min ohne Rechnung geht jede Übernahme auf ihren Ausgangswert zurück (Review B7).
7. **Hebel +1 K** von Deckel/Laufzeit gehört in die Verschiebungs-Arbitrierung (`S.arb`, mit Raumeinfluss und Vorausschau). Beide Hebel gleichzeitig gibt es nicht, weil jede Regel nur einen Vorschlag hat:
   - Quiet ändert unter 22 Hz die Frequenz nicht.
   - +1 K bei Vorlauf unter Soll löst unter Quiet 0 einen Hochlauf aus.

Die Sim prüft das über 8 Fake-Uhr-Tage (mild, Kälte −5…3 °C mit Heizstab-Nähe, wieder mild), im Shadow und mit sofortiger Übernahme. Ergebnis: nie zwei Quiet-Vorschläge gleichzeitig, kein Ping-Pong (keine Gegenrichtung binnen 60 min außer dem eigenen Rückweg), höchstens 6 Quiet-Wechsel je Tag. Dazu kommen Einzeltests für Notfall, Haltezeit, Wartezeit und Übergabe.

Statuswerte je Regel und Minute:

| Status | Bedeutung |
|---|---|
| `inaktiv` | nicht zuständig, z. B. Quiet steht schon auf 0 |
| `bereit` | kein Vorschlag; Grund ist die erste nicht erfüllte Bedingung in Worten. `naechste` nennt Schwelle, Istwert und Abstand sowie die weiteren fehlenden Bedingungen |
| `wartet` | alle Bedingungen erfüllt, die Haltezeit läuft |
| `gesperrt` | würde schalten, aber eine Sperre gilt; `naechste.bis` nennt ihr Ende, wenn bekannt |
| `vorschlag` | Vorschlag aktiv |
| `hinweis` | Hinweis aktiv |
| `abgelaufen` | Gültigkeit vorbei, danach Wartezeit |

Ein laufender Vorschlag wird erst zurückgezogen, wenn eine Bedingung 3 min am Stück fehlt. Eine Sperre zieht ihn sofort zurück. Ohne frische HeishaMon-Daten wird gar keine Bedingung bewertet, der Status ist dann `gesperrt: HeishaMon-Daten …`.

**Takt- und Heizstab-Sperre** wirken richtungsabhängig. Das ist eine begründete Auslegung des Auftrags:
- **Takt-Sperre:** Sie gilt für Maßnahmen, die den Vorlauf an die Abschaltgrenze Soll +3,25 K schieben, also mehr Leistung oder −1 K. Bei −1 K wird der Vorlauf gegen den neuen Soll gerechnet. Ein +1-K-Schritt entfernt den Vorlauf von dieser Grenze. Eine Sperre dort würde +1 K gerade dann verhindern, wenn er wirkt, nämlich kurz vor dem Stopp.
- **Heizstab-Sperre:** Sie gilt für +1 K bei Außentemperatur < Heater_On + 2 K, wenn der Rückstand danach die Heizstab-Schwelle (|Start_Delta| − 1 K) erreichen würde. Die Quiet-Freigabe verkleinert den Rückstand, für sie gilt die Sperre deshalb nicht.

Tabellen aus dem Regelwerk, erzeugt mit `node tools/engine_doc.js`. Die Sim prüft, dass sie hier aktuell sind:

<!-- ENGINE-TABELLEN -->
### Regeln (Version, Art, Befehl, Prognose)

| Regel | Version | Art | Stellgröße / Befehl | Richtung | Prognose (p, Horizonte) | Sperren |
|---|---|---|---|---|---|---|
| Quiet-Freigabe (Leistung freigeben) (`quiet_freigabe`) | 2 | befehl | `SetQuietMode` | mehr_leistung | Ohne Freigabe bleibt der Verdichter am Deckel und der Rücklauf-Rückstand ≥ 1 K – p = 0,8, 30/60/120 min | anlauf, daten, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt |
| Effizienz-Deckel und Laufzeit (Quiet höher oder Heizkurve +1 K) (`quiet_strecken`) | 4 | befehl | `SetQuietMode` oder `SetZ1HeatRequestTemperature` | weniger_leistung / soll_hoch | Ohne Deckel läuft der Verdichter weiter mit 22 Hz oder mehr – p = 0,7, 30 min; Hebel +1 K: Ohne +1 K endet der Lauf binnen 60 min (kurzer Lauf) – p = 0,7, 60 min | anlauf, daten, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt, heizstab |
| Raumeinfluss (Heizkurve ±1 K) (`raum_offset`) | 2 | befehl | `SetZ1HeatRequestTemperature` | verschiebung | Ohne Verschiebung bleibt der Führungsraum außerhalb seines Bandes – p = 0,7, 60/120/240 min | anlauf, daten, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt, heizstab |
| Vorausschau (Heizkurve −1 K) (`vorausschau`) | 2 | befehl | `SetZ1HeatRequestTemperature` | soll_runter | Ohne −1 K gerät der wärmste Raum an den oberen Bandrand (höchstens Reserve unter Maximum) – p = 0,6, 120/240/360 min | anlauf, daten, modell, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt, heizstab |

*Stillgelegt (nicht mehr im Regelwerk; Summen, Basisraten und Punkteverlauf bleiben unter ihrem Schlüssel stehen, offene Fälle enden beim Laden ohne Buchung):*

| Regel | Version | seit | Grund |
|---|---|---|---|
| Heizgrenze 12 → 10 °C (nur Hinweis) (`heizgrenze_hinweis`) | 1 | 2026-10-13 | Regel-Review 4.1: Der Hinweis verlagerte gebrauchte Wärme aus den Stunden mit dem besten COP (6,5–6,8 bei 11–14 °C) in kältere Stunden (5,0–5,6 bei 1–6 °C); bei allen Läufen mit Außentemperatur ≥ 11 °C lag mindestens ein Raum unter seiner Bandmitte; am 12.10. fiel Kinderzimmer unten nach dem Hinweis trotz der Läufe unter sein Minimum, die Bewertung zählte trotzdem einen Treffer (der Lauf, den er vermeiden wollte, fand statt). |

#### Quiet-Freigabe (Leistung freigeben) (`quiet_freigabe` v2)

*Zweck:* Hält der Quiet-Deckel den Verdichter fest, obwohl ein echter Bedarf besteht (Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Boost von Hand), wird die Leistung freigegeben: auf die nächste Stufe, deren Deckel genug Mehrleistung zulässt (Daten je Heizregelung × Quiet × Außenband), bei Heizstab-Nähe und ohne Daten auf Quiet 0. Ein Vorlauf unter Soll allein ist kein Bedarf (v1 löste auch bei „Sollvorlauf in diesem Lauf noch nicht erreicht“ aus, also bei jedem langsamen Anlauf). Zurück auf die vorherige Stufe, sobald der Bedarf gedeckt ist.

*Eingänge:* Quiet-Stufe, Verdichterfrequenz und Deckel je Stufe (Messung, Takt-Messung), Soll-/Ist-Vorlauf, Rücklauf und Ziel-Spreizung (Heat_Delta), Laufzeit, Räume (gültig, eigenes Band, Verlauf), Heizstab (Heater_On_Outdoor_Temp, Heater_Start_Delta), Soll von Hand gegen Heizkurve, Daten je Heizregelung × Quiet × Außenband (Takt-Messung)

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `laufMin` | 15 | min | Startroutine: Pumpenspitze 11–16 min nach jedem Start; Kaltstarts haben 15–25 min lang naturgemäß Rückstand (gilt für Raum-Bedarf und Boost) |
| `heizstabVorlaufMin` | 5 | min | Heizstab-Nähe: der Heizstab startet nach Heater_Delay_Time (hier 15 min, Servicehandbuch J Z. 9316–9322) Thermo-EIN unter Soll −3 K. Die Startphase endet Heater_Delay_Time − 5 min − Haltezeit, der Vorschlag kommt also 5 min vor der Heizstab-Freigabe (Regel-Review B4: Laufminute 13 war zu spät); ohne gemeldete Heater_Delay_Time 15 min; ANNAHME |
| `heizstabAbstandK` | 0,5 | K | Heizstab-Nähe in der Startphase: Vorlauf mindestens \|Heater_Start_Delta\| − 0,5 K (hier 2,5 K) unter Soll bei Außentemperatur unter Heater_On_Outdoor_Temp + 2 K (Regel-Review QF-6); ANNAHME |
| `heizstabDauerK` | 1 | K | Heizstab-Nähe im Dauerlauf (Lauf länger als Heater_Delay_Time): der Heizstab hat dann keine Verzögerung mehr, und ein natürlicher Sollsprung +1 K hebt den Rückstand in einem 5-min-Schritt um 1 K (Regel-Review B4) → Abstand 1,0 K (Vorlauf ab 2,0 K unter Soll); ANNAHME |
| `vlRueckK` | 1,5 | K | Auftrag/Wächter (escCapDevK 1,5); 13.10. 16:36 half die Freigabe bei 2,5–3 K |
| `rlRueckK` | 1,5 | K | Messung: die Freigabe wirkt nur mit Rücklauf-Rückstand: 10.10. 11:17 ≤ 0,25 K keine Reaktion; 13.10. 16:36 Quiet 2 → 1 bei 1,75 K: 17 → 20–21 Hz in 2 min; Boost 2,5–6,75 K: 33–34 Hz. Quiet 0 lief 07.–13.10. bei 1,5–2,5 K nur in 20–39 % der Minuten über 20 Hz, ab 2,5 K immer; 1,5 K bleibt ANNAHME |
| `mehrHz` | 3 | Hz | Zielstufe: ihr Deckel muss mindestens 3 Hz über dem jetzigen liegen, sonst bringt sie keine Leistung (Messung 13.10. 16:36: 17 → 20–21 Hz = +80–100 W el, ≈ +0,4 kW th); Quiet 2 deckelt bei Mildwetter wie Quiet 3 (16–17 Hz). Vorher 4 Hz: dann fiel Quiet 2 (21 Hz) gegen den gelernten Quiet-3-Deckel 18 Hz bei 3…7 °C aus (Regel-Review QF-3/R1) |
| `trendKh` | 0,2 | K/h | Raum fällt: Regression über den Verlauf der letzten 2 h im Lauf (5-min-Raster, letzte Meldung gilt weiter) mindestens 0,2 K/h abwärts, und der Raum steigt in den letzten 30 min nicht (Shelly Gen3 melden erst ab 0,5 K: 0,5 K in 2,5 h; Regel-Review B3: vorher Endpunkt gegen Endpunkt); ANNAHME |
| `lueftungK` | 1 | K | Raumtrend: fällt ein Raum um 1 K oder mehr binnen 60 min, ist das Lüften (wie der Lüftungsverdacht der Bewertung); der Verlauf zählt erst ab dem Ende des Sturzes (Regel-Review B3: 08.10. 18:33 Wohnzimmer „−6,9 K/h, Minimum in 5 min“) |
| `prognoseMin` | 120 | min | Prognose: Raum erreicht beim jetzigen Gefälle binnen 2 h das Minimum (Wirkzeit Raum noch nicht gemessen); ANNAHME |
| `haltMin` | 10 | min | Auftrag/Wächter (escCapMin 10): Bedingungen 10 min am Stück nach der Startphase |
| `haltHeizstabMin` | 3 | min | Heizstab-Nähe: kurze Haltezeit (Heater_Delay_Time 15 min); ANNAHME |
| `rueckRlK` | 0,5 | K | Rückweg: Bedarf gedeckt, wenn alle Räume mindestens notK 0,3 K über Minimum liegen, kein Bedarf mehr besteht und der Rücklauf höchstens 0,5 K unter Soll ist, 15 min am Stück (Quiet 0 lief 07.–13.10. bei ≤ 0,5 K Rückstand meist am Minimum); ANNAHME |
| `rueckRaumMin` | 15 | min | Rückweg, wenn ein Bedarfsraum dieser Freigabe 15 min am Stück über seinem Maximum liegt. Andere Räume über Maximum zählen nicht: das Wohnzimmer lag 29–74 % der Zeit über Maximum (Wärmeverteilung), der Rückweg pendelte (Regel-Review B2, Szenario D) |
| `kaltC` | 2 | °C | Kälte-Vorsorge (vorläufig): unter 2 °C, gemessen oder in der Vorhersage der nächsten vorsorgeH Stunden, keine Stufe mit hartem Deckel. Nutzererfahrung 07.10. „bei 1–3 °C muss Quiet aus sein“; Regel-Review B4: vorbeugen statt nachträglich freigeben (der Heizstab ist im Dauerlauf ohne Verzögerung frei) |
| `hartHz` | 17 | Hz | harter Deckel: die Stufe hält höchstens 17 Hz (Quiet 3 immer, Quiet 2 ab 7 °C; Messung 07.–13.10.) |
| `vorsorgeH` | 6 | h | Kälte-Vorsorge: OWM-Vorhersage der nächsten 6 h (am Messwert verankert), damit der Vorschlag am Abend kommt und nicht erst in der Nacht, in der niemand klickt (Regel-Review B4); ANNAHME |
| `boostBedarf` | 1 | ja/nein | Boost von Hand (Soll über der Heizkurve) zählt als Bedarf: 1 = ja (Nutzer vorläufig, 13.10.) |
| `ohneDatenSchrittweise` | 1 | ja/nein | ohne 60 min Daten einer tieferen Stufe: 1 = schrittweise nach der Messtabelle DECKEL, ein Notfall (Heizstab-Nähe, Raum ≥ 0,3 K unter Minimum) direkt Quiet 0; 0 = immer Quiet 0 (Nutzer vorläufig, 13.10.) |
| `nachtQuietMin` | -1 | Stufe | Lärmgrenze nachts: die Freigabe geht nachts nicht unter diese Stufe (außer bei Heizstab-Nähe); −1 = aus (Nutzer vorläufig, 13.10.: keine Lärmgrenze) |
| `nachtVonH` | 22 | Uhr | Beginn der Nacht für nachtQuietMin; ANNAHME |
| `nachtBisH` | 6 | Uhr | Ende der Nacht für nachtQuietMin; ANNAHME |
| `copTol` | 0,1 | Anteil | eine tiefere Stufe statt der nächsten nur mit mehr als 10 % besserem COP: Pth ist Durchfluss × ΔT mit 0,25-K-Schritten (±10 %), bei gleicher Frequenz unterscheiden sich Quiet 0 und 3 um −9…+5 % (Tag, Feuchte, Vorlauf), Regel-Review LS-4/QF-8; Mindestdaten je Kombination copMinMin (Nutzerentscheidung 13.10.2026) |
| `proTag` | 3 | Vorschläge | Schreibbudget; ANNAHME |
| `gueltigMin` | 30 | min | Quiet wirkt in 1–2 min; nach 30 min ist die Lage eine andere (ANNAHME) |
| `pauseMin` | 60 | min | wie Mindestabstand (ANNAHME) |
| `maxDauerMin` | 240 | min | Rückweg spätestens nach 4 h, aber nicht, solange der Bedarf besteht (dann hält die Freigabe); ANNAHME |

*Erwartung:* Ziel Quiet 0: Verdichter ≥ 25 Hz binnen 5 min, elektrische Leistung +350 bis +650 W, Vorlauf +2 K in 30 min (gemessen 10.10.2026 08:41, Efficiency, 11–12 °C). Ziel Quiet 1 oder 2: Verdichter mindestens 3 Hz über dem alten Deckel binnen 10 min, +60 W oder mehr (gemessen 13.10. 16:36 Quiet 2 → 1: 17 → 20–21 Hz, +80–100 W bei 12 °C). Nicht gemessen: Kälte, Abtauen

*Rückweg:* Automatisch zurück auf die Ausgangsstufe, sobald der Bedarf 15 min am Stück gedeckt ist (alle Räume ≥ Minimum + 0,3 K, Rücklauf höchstens 0,5 K unter Soll) oder ein Bedarfsraum 15 min über seinem Maximum liegt; spätestens nach 4 h, solange weder Bedarf noch Kälte-Vorsorge besteht; höchstens 3 Sendeversuche.

*Kalibriermessungen (Wirkungsfälle dort zählen 0 Punkte):* 2026-10-10 08:40, 2026-10-08 22:54, 2026-10-10 11:17, 2026-10-13 16:36

#### Effizienz-Deckel und Laufzeit (Quiet höher oder Heizkurve +1 K) (`quiet_strecken` v4)

*Zweck:* Zwei Hebel, gewählt nach Lage. Quiet höher (Effizienz-Deckel): läuft der Verdichter ohne Bedarf mit 22 Hz oder mehr (vor allem in den ersten 3 h eines Laufs bei Mildwetter), deckelt die niedrigste Stufe, die laut Messdaten unter 22 Hz hält; das spart Strom (Quiet 0, gleiches Außenband, ab Laufminute 15: COP bei 22–27 Hz 3–8 %, ab 28 Hz 10–14 % unter 16–17 Hz) und verlängert den Lauf, mit oder ohne Takt. Quiet senkt am Minimum außerdem den Lüfter (−60…−110 U/min, −10…−16 W; ein COP-Unterschied ist dort nicht messbar). Heizkurve +1 K (Laufzeit): läuft der Verdichter schon unter 22 Hz und ist Takt belegt, hilft Quiet nicht; +1 K hebt Abschalt- und Startschwelle (längere Läufe, kürzere Pausen) und kostet Strom, deshalb nur, wenn der geschätzte Nutzen (vermiedene Starts) die Kosten übersteigt. Beide Hebel nie gleichzeitig aus einem Vorschlag.

*Eingänge:* Quiet-Stufe, Heizregelung, Verdichterfrequenz, Rücklauf-Rückstand, Räume (Bedarf, Verlauf, Luft im Band), Außentemperatur, letzte Läufe (Dauer, Stopp-Art), Pausen, Starts, Daten je Heizregelung × Quiet × Außenband (Takt-Messung: Minuten, COP, gehaltener Deckel), Verschiebung der Anlage (TOP27) und Eigentümer (Arbitrierung)

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `hzHoch` | 22 | Hz | Messung 07.–13.10. (Quiet 0, gleiches Außenband, ab Laufminute 15): COP bei 22–27 Hz 3–8 %, ab 28 Hz 10–14 % unter 16–17 Hz, bei 18–21 Hz 1–5 % (im Rauschen); Quiet 0 lag in 14–25 % der Laufminuten über 20 Hz (unter 3 °C nie). Eine Zielstufe deckelt, wenn ihr Deckel (Messung oder gelernt) darunter liegt |
| `laufMin` | 15 | min | Startroutine (siehe Quiet-Freigabe) |
| `rlRueckMaxK` | 1 | K | kein Bedarf: Rücklauf höchstens 1 K unter Soll (ANNAHME, vgl. Quiet-Freigabe 1,5 K) |
| `komfortK` | 0,3 | K | Komfort sicher: jeder Raum mit Wert (bis 6 h alt) mindestens 0,3 K über Minimum (wie notK); ANNAHME |
| `ruheMin` | 120 | min | kein Deckel binnen 2 h nach einem Bedarf der Quiet-Freigabe (Raumwerte kommen alle 1–2 h; verhindert Hin und Her mit der Freigabe); ANNAHME |
| `atMinC` | 3 | °C | Quiet höher nur über 3 °C: Nutzererfahrung 07.10. „bei 1–3 °C muss Quiet aus sein“; Messung: unter 3 °C lief Quiet 0 nie über 20 Hz (0 von 274 Laufminuten), dort gäbe es nichts zu deckeln |
| `kurzerLaufMin` | 60 | min | Takt belegt: letzter Lauf mit Abschaltung über den Vorlauf kürzer als 60 min (Opus: Mindestlauf 60 min). 07.–13.10.: 24 abgeschlossene Läufe, 20 Abschaltungen über den Vorlauf mit 97–970 min, keine unter 60 min |
| `thermoStoppK` | 2,75 | K | Stopp-Art: der Lauf endete mit Vorlauf ≥ Soll +2,75 K = Abschaltung über den Vorlauf (gemessen +3,0…+3,25 K bei 20 von 20; Handbuch: Vorlauf − interner Soll > 2 K für 3 min). Läufe, die an der Heizgrenze oder nach einem Sollsprung nach unten enden, sind kein Takt |
| `starts3h` | 2 | Starts | Takt belegt: mindestens 2 Starts in 3 h (07.–13.10.: höchstens 1) |
| `copTol` | 0,1 | Anteil | Veto: Zielstufe höchstens 10 % COP unter der jetzigen (nur wenn beide copMinMin Minuten haben, Nutzerentscheidung 13.10.2026). Die Matrix zeigt bei gleicher Frequenz (16–17 Hz) zwischen Quiet 0 und 3 −9…+5 % (Tag, Feuchte, Vorlauf), bei Quiet-Wechseln im Lauf am Minimum −2…+6 %, Messunsicherheit Pth ±10 % (Regel-Review LS-4): deshalb nur Veto; gewählt wird die niedrigste deckelnde Stufe |
| `laufPlusMin` | 40 | min | +1 K verlängert den Lauf um 1 K ÷ Vorlauf-Anstieg am Laufende (Median 1,5 K/h, 07.–12.10.) ≈ 40 min (20–60); nicht gemessen, Verzögerungstest steht aus; ANNAHME |
| `pauseMinusMin` | 18 | min | +1 K hebt auch die Startschwelle: Pause kürzer um die Zeit von Soll −2,25 bis −3,25 K, Median 18 min (11–67 min, 07.–12.10.); ANNAHME |
| `startWh` | 15 | Wh | ein Start kostet 7–12 Wh (Review 09.10.) plus Pumpenspitze 4–10 Wh (2900 U/min für 11–16 min); ANNAHME |
| `kurveWK` | 8,5 | W/K | Strom +8,5 W je K Vorlauf während des Laufs (Strommodell 08.10.); Mehrwärme in die Räume nicht eingerechnet; ANNAHME |
| `laufVlK` | 1 | K | +1 K im Lauf nur, wenn der Vorlauf schon mindestens 1,0 K über dem Soll liegt: dann steigt nur die Stoppschwelle; darunter löste +1 K bei Quiet 0 einen Hochlauf aus (11.10. 03:10: 16,5 → 22–23 Hz, +48 % Strom; Regel-Review Abschnitt 2). Vorher 0,5 K: bei +0,25 K nach einem natürlichen +1-K-Sprung lief Quiet 0 schon kurz auf 20 Hz (13.10. 02:20), +1 K wirkt erst im nächsten 5-min-Takt (Regel-Review R2) |
| `pauseVlK` | -2 | K | +1 K in der Pause nur, wenn der Vorlauf über Soll −2 K liegt: läge er nach +1 K bei ≤ neuer Soll −3,25…−3,5 K, startete die Anlage sofort (10.10. 18:20, 11.10. 19:10; Regel-Review Abschnitt 2) und die Pause würde nur kürzer |
| `haltMin` | 10 | min | wie Quiet-Freigabe |
| `proTag` | 3 | Vorschläge | ANNAHME (v3: 2; ein Effizienz-Deckel je Lauf bei 3–5 Läufen am Tag) |
| `gueltigMin` | 30 | min | ANNAHME |
| `pauseMin` | 120 | min | ANNAHME |
| `maxDauerMin` | 480 | min | Quiet höher: Rückweg spätestens nach 8 h (≈ zwei Zyklen: Median Lauf 184 min, Pausen 57–158 min); früher bei Bedarf, Rücklauf-Rückstand oder ≤ 3 °C; ANNAHME |
| `maxDauerKurveMin` | 360 | min | +1 K: Rückweg spätestens nach 6 h (wie Raumeinfluss und Vorausschau); früher bei Heizstab-Nähe, wenn ein Raum mehr als 0,3 K über die Bandmitte steigt oder der Takt ausbleibt; ANNAHME |
| `kurveTaktZyklen` | 2 | Läufe | +1 K: Rückweg, wenn nach der Übernahme zwei Läufe ohne Takt-Beleg endeten (beide mindestens kurzerLaufMin lang; Regel-Review B5); ANNAHME |
| `bedarfRlK` | 2,5 | K | Rückweg Quiet: Rücklauf-Rückstand ≥ 2,5 K seit 15 min = Leistung wird gebraucht (Quiet 0 lief 07.–13.10. ab 2,5 K immer über 20 Hz) |

*Erwartung:* Quiet höher: Verdichter ≤ 21 Hz binnen 10 min, elektrische Leistung −100 W oder mehr (nach Quiet-Wechseln nach oben fiel die Frequenz binnen 5–15 min, 08.10. 09:38, 12.10. 09:30); in diesen Minuten COP +3…+14 % (Schätzung aus den Frequenz-Klassen). Heizkurve +1 K: Soll-Vorlauf +1 K binnen 3 min; Lauf länger, Pause kürzer (Messaufgabe, nicht gemessen)

*Rückweg:* Quiet höher: automatisch zurück auf die vorherige Stufe bei Bedarf (Raum unter Minimum oder fallend, Heizstab-Nähe, Boost), bei Rücklauf-Rückstand ≥ 2,5 K seit 15 min, bei Außentemperatur ≤ 3 °C, spätestens nach 8 h. Heizkurve +1 K: zurück auf 0 K bei Heizstab-Nähe (Außen unter Heater_On_Outdoor_Temp + 2 K), wenn ein Raum mehr als 0,3 K über die Bandmitte steigt, wenn zwei Läufe ohne Takt endeten, spätestens nach 6 h.

*Kalibriermessungen (Wirkungsfälle dort zählen 0 Punkte):* 2026-10-08 09:38, 2026-10-12 09:30

#### Raumeinfluss (Heizkurve ±1 K) (`raum_offset` v2)

*Zweck:* Räume wirken nur als langsamer, kleiner Offset auf die Heizkurve (Lambda-Prinzip). Übernimmt den Raumvorschlag der Phase-2-Logik (korrektur_vorschlag −1/0/+1) erst, wenn er lange stabil ist. Stellt nur die Verschiebung, nicht die Heizregelung (Comfort/Efficiency richtet sich nach der gemessenen Effizienz, Takt-Messung). Seit v2 Teil der Verschiebungs-Arbitrierung: eine Verschiebung, die einer anderen Regel gehört (Vorausschau), gilt nicht als Abweichung; Gegenrichtung nur nach Wartezeit und mit Komfort-Notfall.

*Eingänge:* Raumvorschlag Phase 2 (korrektur_vorschlag, Führungsraum, Wärmeverteilung), Verschiebung an der Anlage (TOP27), Soll-Vorlauf und Heizkurve, Heizkurvenmodus/Zonenfühler, Eigentümer der Verschiebung (Arbitrierung)

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `stabilMin` | 60 | min | lange Haltezeit (Auftrag); Phase 2 wartet selbst 45–60 min. Räume reagieren träge, Shelly melden erst ab 0,5 K |
| `minVlC` | 29 | °C | Nutzervorgabe 08.10.: Soll-Vorlauf nie unter 29 °C (Heizkörper) |
| `proTag` | 4 | Vorschläge | Opus: höchstens 6 Schreibbefehle/Tag |
| `gueltigMin` | 120 | min | ANNAHME |
| `pauseMin` | 120 | min | ANNAHME |
| `maxDauerMin` | 360 | min | Rückweg spätestens nach 6 h (ANNAHME) |

*Erwartung:* +1 K: Soll-Vorlauf +1 K binnen 6 min (5-min-Raster), im Taktbetrieb +40–60 min Laufzeit je Lauf (Sollsprünge 07.–10.10.), Strom +2,5–3 % (8,5 W/K); Raumwirkung NICHT gemessen. −1 K: umgekehrt.

*Rückweg:* Automatisch zurück auf 0 K, sobald der Raumvorschlag 15 min am Stück 0 ist oder spätestens nach 6 h; „Zurücksetzen“ jederzeit.

#### Vorausschau (Heizkurve −1 K) (`vorausschau` v2)

*Zweck:* Senkt die Heizkurve um 1 K, bevor der Wärmebedarf WETTERBEDINGT sinkt (Milderung; Sonne und Wind nur mit freigegebenem Modell, coefActivate; der gewöhnliche Tagesgang ist herausgerechnet, die Uhrzeit allein löst nichts aus), solange alle Räume im Band liegen und der kälteste Raum Luft über seinem Minimum hat. Läuft erst mit offenem Gate des Gebäudemodells, nie gegen den aktuellen Raumzustand und nie gegen eine Verschiebung einer anderen Regel (Arbitrierung). Seit v2 (Review-Paket 13.10.2026) ohne den Zweig +1 K vor erwartetem Mehrbedarf: Die Anlage führt die Heizkurve selbst alle 5 min mit der Fühler-Außentemperatur nach (0,375 K Vorlauf je K, Verzug ≤ 5 min), die Heizkörper haben wenig Speichermasse, und bei Kälte lagen die Räume ohnehin 0,4–1,6 K über ihrer Bandmitte (unter 4 °C Kinderzimmer unten 90 % der Zeit über Maximum); +1 K hätte überheizte Räume weiter geheizt. Unter Quiet 0 löst +1 K bei Vorlauf unter Soll außerdem einen Hochlauf aus (11.10. 03:10: +48 % Strom), die Kosten waren unterschätzt. Nur −1 K zeigt in die Energie-Richtung.

*Eingänge:* Wettervorhersage OWM (+1 … +6 h, an den Außenfühler angeglichen), gewöhnlicher Tagesgang (gemessene Außentemperatur bis 7 Vortage), Gebäudemodell des Wärmefahrplans (UA, Heizgrenze tbal, Gate, coefActivate), Sonne (PV-Prognose) und Wind nur mit coefActivate, Räume (alle gültig, eigenes Band), Verschiebung der Anlage (TOP27) und Eigentümer der Verschiebung, Soll-Vorlauf

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `deltaK` | 2 | K | Bedarfsänderung aus dem Wetter als Außentemperatur-Äquivalent (Mittel des Fensters gegen jetzt, beide um den gewöhnlichen Tagesgang bereinigt); OWM weicht vom Fühler 1,5–1,9 K ab (08.–10.10.), darunter ist die Vorhersage kein Signal; ANNAHME |
| `tagesgangTage` | 3 | Vortage | Der gewöhnliche Tagesgang wird aus den Vortagen gelernt (Abweichung jeder Uhrzeit vom 24-h-Mittel); mit nur einem Vortag steckt dessen Wetter darin (Replay: Kaltfront 08.10. abends erschien am 09.10. als −5 K); ANNAHME |
| `vonH` | 2 | h | Fensterbeginn: −1 K wirkt über Lauf und Pause erst nach 1–3 h im Raum (Speichermasse 7–10 kWh/K, Opus); ANNAHME |
| `bisH` | 5 | h | Fensterende: OWM liefert 3-h-Punkte, das Vertrauen fällt mit dem Vorlauf (Fahrplan: 1 − h/48); ANNAHME |
| `reserveK` | 0,3 | K | Luft im Band: der kälteste Raum liegt mindestens 0,3 K über seinem Minimum (wie guardK des früheren Fahrplans); ANNAHME |
| `prognoseMaxMin` | 120 | min | Fahrplan: Vorhersage gilt bis 2 h nach dem Abruf |
| `haltMin` | 30 | min | Vorhersage muss mindestens einen weiteren Abruf überstehen; ANNAHME |
| `minVlC` | 29 | °C | Nutzervorgabe 08.10.: Soll-Vorlauf nie unter 29 °C (Heizkörper) |
| `proTag` | 2 | Vorschläge | Schreibbudget gemeinsam mit dem Raumeinfluss (Opus: höchstens 6 Schreibbefehle/Tag); ANNAHME |
| `gueltigMin` | 180 | min | Fensterende 5 h minus Fensterbeginn 2 h; ANNAHME |
| `pauseMin` | 180 | min | ANNAHME |
| `maxDauerMin` | 360 | min | Rückweg spätestens nach 6 h (wie Raumeinfluss, ANNAHME) |

*Erwartung:* Soll-Vorlauf −1 K binnen 6 min (5-min-Raster), weniger Wärme vor dem erwarteten Wärmegewinn (Strom −2,5–3 %, 8,5 W/K); die Räume bleiben im Band, obwohl der Bedarf sinkt. Raumwirkung NICHT gemessen.

*Rückweg:* Automatisch zurück auf 0 K, sobald die Vorhersage die Milderung 15 min am Stück nicht mehr zeigt (halbe Schwelle), sofort, wenn ein Raum unter sein Minimum fällt, spätestens nach 6 h; nicht, solange der Raumeinfluss dieselbe Verschiebung verlangt.

### Takt-Messung (Schwellen, `cfg.takt`)

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `probenEin` | 2 | Proben | Start erst nach 2 Laufproben in Folge (Idee tvofi wear.py: START_HYSTERESIS_SAMPLES = 2) |
| `probenAus` | 2 | Proben | Stopp erst nach 2 Proben ohne Lauf (wie probenEin; ANNAHME) |
| `minAusMin` | 3 | min | Pause kürzer als 3 min = derselbe Lauf (ANNAHME; Idee stooklijn cycling.py: Stopp < 60 s ist eine Messlücke, bei uns 1-min-Raster) |
| `kurzMin` | 60 | min | kurzer Lauf: kürzer als 60 min (Regel „Laufzeit strecken“ v2: Mindestlauf 60 min) |
| `minutenPauseMin` | 30 | min | Pause kürzer als 30 min = Minutenpause bei Minimalmodulation, sonst Bedarfspause (ANNAHME; OEM-Threads: Takt-Typen trennen) |
| `stabilAbMin` | 15 | min | Mindestleistung und COP erst ab Laufminute 15 (Messung: Pumpenspitze der Startroutine 11–16 min nach jedem Start) |
| `binMinN` | 30 | min | Mindestleistung je 2-K-Band erst ab 30 stabilen Minuten (Idee stooklijn min_power.py: mindestens 6 Proben à 5 min) |
| `copMinMin` | 60 | min | Nutzerentscheidung 13.10.2026, vorläufig: Mindestdaten je Kombination Modus × Quiet × Außenband für die Anzeige und als Schwelle, ab der eine Regel eine Umschaltung vorschlagen darf |
| `copTage` | 30 | Tage | COP-Vergleich über die letzten 30 Tage (ANNAHME; stooklijn: 30-Tage-Fenster, Jahreszeiten nicht mischen) |
| `deckelNachQMin` | 15 | min | gelernter Quiet-Deckel: Minuten bis 15 min nach einem Quiet-Wechsel zählen nicht (Messung 12.10. 09:30: nach Quiet 2 → 3 fiel der Verdichter erst nach 15 min von 20 auf 17–18 Hz) |
| `deckelHaltMin` | 5 | min | gelernter Quiet-Deckel: eine Frequenz zählt erst, wenn die Stufe sie 5 min am Stück gehalten hat (Messung 09.10. 01:22–01:24: Quiet 3 lief bei 4 °C ohne Rückstand 3 min mit 20 Hz, vermutlich Ölrückführung; solche Spitzen zählen nicht; ANNAHME) |
| `startsTagWarn` | 12 | Starts | Anzeige „Takt“ ab mehr als 12 Starts in 24 h (Richtwert HeatPump Hero, docs/optimization.md) |
| `kurzAnteilWarn` | 0,25 | Anteil | Anzeige „Takt“ ab mehr als 25 % kurzen Läufen bei mindestens 4 Läufen (Richtwert HeatPump Hero; dort „kurz“ = unter 10 min, bei uns unter 60 min) |

### Sperren, die jede Regel erbt

| Sperre | Text | Herkunft |
|---|---|---|
| `anlauf` | Maschine beobachtet erst seit kurzem (Neustart) | Zeitgeber und Zähler müssen nach einem Neustart erst wieder Daten sammeln (10 min) |
| `daten` | HeishaMon-Daten fehlen oder sind veraltet | HeishaMon meldet laufend; älter als 5 min = veraltet (Wächter: 10 min) |
| `mqtt_sperre` | Alle MQTT-Befehle sind gesperrt (MQTT.block_active) | HeishaMoNR-Notbremse; sie friert den Zustand ein (Opus-Review 09.10.) |
| `abtauen` | Abtauen oder kurz danach | Wächter/Quiet-Logik: keine Änderung beim und 10 min nach dem Abtauen (Opus: 10–20 min) |
| `warmwasser` | Warmwasser oder kurz danach | wie Abtauen (diese Anlage macht kein Warmwasser, die Sperre bleibt als Schutz) |
| `sanftanlauf` | Sanftanlauf (HeishaMoNR SoftStart) aktiv | SoftStart verschiebt die Heizkurve selbst |
| `laufbeginn` | Verdichter läuft erst kurz | Start-Pumpenspitze 2900 U/min für 11–16 min bei jedem Start; Quiet wirkt erst nach 1–2 min |
| `heizgrenze_aus` | Heizgrenze-Aus (Pumpe steht) | Heizgrenze 12 °C mit Hysterese: aus ab 15 °C, ein ab 12 °C, Pumpe 0, Vorlauf ohne Aussage |
| `regler` | Ein anderer Regler stellt dieselbe Größe | HeishaMoNR-Quiet-Logik/Scheduler/Solar/WP-Zeitplan bzw. Raumregelung/Nachtabsenkung/Sanftanlauf; Verschiebung nur im Heizkurvenmodus mit Wasserfühler und ohne Handeingriff am Soll |
| `abstand` | Mindestabstand zur letzten Änderung | Wächter: 60 min Abstand; Opus: höchstens 1 Wechsel pro Stunde; seit 13.10. über Quiet und Verschiebung gemeinsam (Regel-Review 3.4: sonst ist keine Wirkung zuzuordnen und Freigabe und +1 K heizen doppelt). Ein Quiet-Notfall (Heizstab-Nähe, Raum ≥ notK unter Minimum) überbrückt ihn nach notfallMin (10 min; Regel-Review B4) |
| `tageslimit` | Tageslimit der Regel erreicht | Schreibbudget (Opus: höchstens 6 Wechsel/Tag), EEPROM-Verschleiß unbekannt. Seit 13.10. zählen bei Befehlsregeln nur übernommene Vorschläge (Regel-Review R5: Vorschläge in der Nacht ohne Klick verbrauchten sonst das Kontingent für den Tag; die Übernahme begrenzt ohnehin auf 6 Befehle am Tag); ein Quiet-Notfall ist ausgenommen |
| `abkuehlzeit` | Wartezeit nach dem letzten Vorschlag | kein Flattern: ein abgelaufener oder zurückgezogener Vorschlag kommt erst nach einer Pause wieder; ein Quiet-Notfall nach notfallMin (10 min), außer der vorige Notfall-Vorschlag ist nur abgelaufen (nachts klickt niemand, sonst käme derselbe Vorschlag alle 40 min) |
| `takt` | Takt-Gefahr: Vorlauf über Soll | Anlage schaltet bei Vorlauf ≥ Soll +3,25 K nach ~3 min ab (6 Stopps 07.–10.10.); Sperre ab Soll +1 K für Maßnahmen, die den Vorlauf näher an diese Grenze bringen (mehr Leistung, −1 K) |
| `heizstab` | Heizstab-Nähe | Heizstab ab Außentemperatur < Heater_On_Outdoor_Temp (0 °C) bei Vorlauf < Soll −3 K nach 15 min; ein +1-K-Schritt vergrößert den Rückstand sofort um 1 K |
| `modell` | Gebäudemodell noch nicht freigegeben | Wärmefahrplan: Gate des Gebäudemodells (≥ 10 Tage, Fehler ≥ 10 % kleiner als der bisherige Schätzer, plausible Koeffizienten); vorher ist eine Bedarfsvorhersage nicht belegt |
| `vorrang` | Die Stellgröße gehört einer anderen Regel | Arbitrierung je Stellgröße (Heizkurven-Verschiebung: Raumeinfluss, Vorausschau, +1 K von „Deckel/Laufzeit“; Quiet: Quiet-Freigabe, Deckel/Laufzeit): je Zeit hat genau eine Regel die Größe (laufender Vorschlag oder übernommener Wert); keine zweite Regel schlägt daneben oder dagegen vor. Quiet: eine übernommene Stufe weicht nur einem Notfall (Raum ≥ notK unter Minimum oder Heizstab-Nähe), frühestens notfallMin (10 min) nach der Übernahme (Regel-Review B4; vorher 60 min) |
| `gegenrichtung` | Gegenrichtung zur letzten Änderung | Kein Hin und Her: Gegenrichtung frühestens shiftHaltMin bzw. quietHaltMin (60 min) nach dem Ende der letzten Änderung derselben Größe und nur mit Notfall (Verschiebung: Raum ≥ notK 0,3 K außerhalb des Bandes; Quiet: Raum ≥ notK unter Minimum oder Heizstab-Nähe, dort schon nach notfallMin 10 min), ohne Notfall erst nach gegenMin bzw. quietGegenMin (240 min); ANNAHME |

*Sperr-Parameter (Standard):* `hpMaxAgeMin` 5 · `afterDefrostMin` 10 · `afterDhwMin` 10 · `startLockMin` 15 · `gapMin` 60 · `taktK` 1 · `stopK` 3,25 · `heaterMarginK` 2 · `warmupMin` 10 · `pumpOnRpm` 1000 · `kurveTolK` 1,5 · `shiftHaltMin` 60 · `gegenMin` 240 · `notK` 0,3 · `quietHaltMin` 60 · `quietGegenMin` 240 · `notfallMin` 10

### Whitelist der Übernahme

| Befehl | Topic | erlaubte Werte | Rücklesen |
|---|---|---|---|
| `SetQuietMode` | `panasonic_heat_pump/commands/SetQuietMode` | 0, 1, 2, 3 | Quiet-Stufe |
| `SetZ1HeatRequestTemperature` | `panasonic_heat_pump/commands/SetZ1HeatRequestTemperature` | -1, 0, 1 | Heizkurven-Verschiebung (nur Heizkurvenmodus TOP76 = 0, Wasserfühler TOP111 = 0) |

*Übernahme-Grenzen:* `maxAlterMin` 2,5 · `hpMaxAgeMin` 5 · `abstandMin` 10 · `proTag` 6 · `doppelMs` 120000 · `rueckleseS` 90 · `wiederholungen` 2 · `rueckwegVersuche` 3 · `engMaxAlterMin` 5 · `engAbbruchMin` 30

### Bewertungsregeln (Version 5)

| Größe | Wert |
|---|---|
| Punkte je Horizont | 100 × [(b − o)² − (p − o)²] / Anzahl Horizonte |
| Basisrate b | aus Vergleichslagen „bleibt, wie es ist“, (k + 1)/(n + 2), erst ab 5 Vergleichen, vorher 0,5 |
| Mindestbeobachtung je Horizont | 0,5 des Horizonts, sonst neutral |
| Problem besteht / gelöst | ≥ 80 % / ≤ 20 % der gültigen Minuten, dazwischen neutral |
| Wirkungsprognose | je Größe ±10, nicht messbar 0, Kalibriermessung 0 |
| Schaden | sperre_verletzt -50, heizstab -50, stopp10 -30, ueberschwingen -30, zu_warm -20, zu_kalt -20 |
| Verpasst | -20 (gezählt werden nur Minuten, in denen die Regel nicht durch eine eigene Sperre zurückgehalten wurde) |
| Verpasst während eigener Sperre (seit v2) | 0 Punkte, getrennt gezählt (`verpasst_sperre`); eigene Sperren: Mindestabstand (`gapMin`), Tageslimit (`proTag`), Wartezeit (`pauseMin`), Haltezeit (`haltMin`), Stabilitätszeit (`stabilMin`); nur soweit sie auch mit dem Standardwert bestanden hätten |
| Schaden hebt die Entschuldigung auf (seit v2) | quiet_freigabe: Raum > 1 K unter Minimum; quiet_strecken: Verdichter stoppt, Vorlauf ≥ Soll +3,25 K; raum_offset: Raum > 1 K unter Minimum → verpasst -20 |
| Gegenregel-Sperren (seit v3) | 0 Punkte wie eigene Sperren: `vorrang`, `gegenrichtung` (Arbitrierung der Verschiebung, seit 13.10. auch der Quiet-Stufe; nur mit den Standardwerten `shiftHaltMin`/`gegenMin` bzw. `quietHaltMin`/`quietGegenMin`); schlägt eine andere Verschiebungs-Regel für die Lage dieselbe Richtung vor, gilt sie als versorgt |
| Basisrate je Auslösung (seit 13.10.) | Regeln mit neuer Auslösung lernen ihre Basisrate unter eigenem Schlüssel neu: `quiet_freigabe|v2`, `quiet_strecken|v4` und `quiet_strecken|v4|kurve` (Hebel +1 K), `vorausschau|v2`; die Vergleichslagen folgen der neuen Auslösung (Freigabe: am Deckel der Stufe mit Rückstand und Bedarf; Deckel: ≥ 22 Hz ab Laufminute 15 über 3 °C; +1 K: Takt belegt unter 22 Hz). Die alten Basisraten bleiben unter dem Regelnamen stehen |
| Zuordnung (seit v3) | Fälle gehören der Regel, die vorgeschlagen hat; die Wirkung einer übernommenen Verschiebung zählt für die Regel, deren Vorschlag übernommen wurde; für alle anderen offenen Fälle ist die Übernahme ein Eingriff (neutral, seit 13.10. auch bei Quiet mit Urheber im Text) |
| Hinweis-Regeln (seit v4) | keine Punkte: Treffer, Fehlalarm, neutral und Schaden werden gezählt und angezeigt, Punkte, Brier-Skill und Freigabereife entfallen („–“), nicht im Diagramm (seit dem Review-Paket 13.10. keine aktive Hinweis-Regel) |
| Brier-Skill (seit v4) | 1 − ΣBS/ΣBS_ref nur aus vollständig abgeschlossenen Fällen (ein offener Fall verändert ihn nicht), erst ab 3 bewerteten Fällen, vorher „–“; seit v5 nur Fälle mit Brier-Beitrag (mindestens ein Horizont nicht neutral) |
| Basisrate ≥ Prognose (seit v5) | je Horizont mit b ≥ p: Treffer neutral (0 Punkte, kein Beitrag zum Skill, Kennzahl „davon … Treffer neutral“); Fehlalarm Abzug gegen b = 0,5: 100 × [0,5² − p²] (p 0,7 → −24, p 0,8 → −39, geteilt durch die Anzahl Horizonte); b < p: Brier wie oben |
| Raumwerte in der Bewertung | bis 360 min alt (Shelly melden nur bei Änderung) |
| Eingriffe (Bewertung wird ab dort neutral) | Quiet, Verschiebung oder Soll (≥ 2 K) geändert; Komfortband geändert; Lüftungsverdacht (Raum fällt ≥ 1 K in ≤ 60 min) |
| Freigabereife (nur Anzeige) | ≥ 10 bewertete Fälle, ≥ 14 Tage, Brier-Skill ≥ 0,2, 0 × Schaden, ≤ 1 × verpasst, ≥ 2 Wirkungsfälle mit Punkten > 0 (ohne Kalibrierung) |
<!-- /ENGINE-TABELLEN -->

## 5. Entscheidungsdatensatz (`decisions-YYYY-MM.jsonl`)

Je Minute eine Zeile. Beispiel aus dem Replay, Boost am 10.10., gekürzt:

```json
{"t":"2026-10-10 08:36:00","mv":1,"sv":1,
 "in":{"hpAge":0.82,"hz":16,"vl":30.5,"rl":28.25,"soll":38,"dT":3,"pel":293,"q":3,"hc":1,"at":11,"rt":68,"shift":0,"sollKurve":29,"block":0,
       "rooms":[["ki_oben",20.4,86.82,1,22,23.5,1,"Kinderzimmer oben"], …],"korr":{"v":1,"code":"Raum unter Minimum: Kinderzimmer oben","distrib":0,"lead":"Kinderzimmer oben"}},
 "abl":{"z":"lauf","lauf_min":68,"vl_rueck":7.5,"rl_rueck":6.75,"erreicht":0,"vl_k_h":5,"stopp_in_min":129,"starts_3h":1},
 "r":[{"id":"quiet_freigabe","v":1,"st":"vorschlag","grund":"Verdichter 16 Hz am Quiet-Deckel, Vorlauf 7,5 K und Rücklauf 6,8 K unter Soll, Lauf 68 min; Kinderzimmer oben 1,6 K unter Minimum","p":"quiet_freigabe@2026-10-10T08:36"},
      {"id":"quiet_strecken","v":1,"st":"inaktiv","grund":"Quiet steht schon auf 3"},
      {"id":"raum_offset","v":1,"st":"bereit","grund":"kein Vorschlag: Raumvorschlag +1 K erst seit 23 von 60 min stabil","naechste":{"b":"stabil","ist":23,"s":60,"abstand":37,"u":"min"}},
      {"id":"heizgrenze_hinweis","v":1,"st":"bereit","grund":"kein Vorschlag: knappster Raum Kinderzimmer oben -1,6 K über Minimum (Reserve 0,5 K)","naechste":{"b":"reserve","ist":-1.6,"s":0.5,"abstand":2.1,"u":"K","halt":15}}],
 "vorschlag":"quiet_freigabe@2026-10-10T08:36"}
```

- `mv` ist die Version des Datensatzformats, `sv` die Version der Bewertungsregeln, `r[].v` die Version der Regel.
- `naechste` steht als Felder im Datensatz: `b` ist die Bedingung, `ist`, `s` (Schwelle), `abstand`, `weitere` (weitere fehlende Bedingungen), `halt` (Haltezeit danach) und `bis` (Ende einer Sperre). Der Satz „würde schalten, sobald …“ entsteht daraus in der Anzeige.
- Der Vorschlag selbst steht im Zustand und in `OPT_engine.prop` mit den Feldern `id`, `rule`, `ver`, `cmd {name, topic, value}`, `von`, `was`, `warum`, `wann`, `erwartung`, `bis`, `rueckweg` und `sum` (FNV-1a-Prüfsumme über ID, Regel, Version, Topic, Wert, Ausgangswert, Zeit, Gültigkeit).

## 6. Punktesystem (automatisch, ohne Nutzereingabe)

Der Nutzer vergibt keine Punkte. Auch „Verwerfen“ ist keine Bewertung: der Bewertungsteil des Kerns kennt weder Klicks noch den Übernahme-Zustand, ein Test prüft das. Alle Regeln stehen vorab fest (`SCORE_VER` 5 seit 12.10. abends; v4 ab 12.10., v3 ab 11.10., v2 ab 10.10. abends, v1 bis dahin). Jede Änderung erhöht die Version, Punkte verschiedener Versionen bleiben getrennt:
- Die Summen stehen je Regel, Regelversion und Bewertungsversion im Zustand (`regel|v1` = v1 unverändert, `regel|v1|s2` = v2, `…|s3` = v3, `…|s4` = v4, `…|s5` = v5). Alte Punkte werden nicht neu gerechnet; die Kachel und das Diagramm zeigen nur die aktuelle Version (Freigabereife und Tage zählen ab dem Wechsel neu).
- Fälle und Wirkungsmessungen, die vor dem Wechsel begannen, werden mit ihrer Version zu Ende bewertet.
- Nachrechnen mit den alten Regeln: `cfg.sv = 1` … `4` bzw. `node tools/engine_replay.js <Daten> --sv1` (`--sv2`, `--sv3`, `--sv4`). Die Entscheidungen sind in beiden Versionen gleich, nur `sv` im Datensatz und die Bewertung unterscheiden sich (Test).

**Änderung v4 → v5 (12.10. abends, Entscheidung des Nutzers: Weg b):** Bei Befehlsregeln lag die feste Prognose p oft unter der gelernten Basisrate b „bleibt, wie es ist“; dann kostet jeder Treffer Punkte (Replay 07.–12.10.: Raumeinfluss 6 von 7 Treffern, aber −9,74 bei b 0,77–0,92 gegen p 0,7; 5-Tage-Kälte-Sim: Quiet-Freigabe 15 Treffer, 0 Fehlalarme, −71; Raumeinfluss 14 Treffer, −122).
- **Treffer bei b ≥ p** (je Horizont): **neutral**, 0 Punkte, kein Beitrag zu ΣBS/ΣBS_ref (keine Trennschärfe messbar). Horizont-Feld `bp: "neutral"`, im Punktebuch-Text „Basisrate 0,92 ≥ Prognose 0,70: neutral“. Sind alle Treffer-Horizonte eines Treffer-Falls neutral, zählt er in der Kennzahl `trefferNeutral` (Kachel: „davon n Treffer neutral (Basisrate ≥ Prognose)“, Replay-Tabelle: „Treffer (davon neutral)“).
- **Fehlalarm bei b ≥ p**: **voller Abzug**. Die Brier-Formel gäbe hier ein *Plus* (b liegt weiter vom Ergebnis 0 entfernt als p; Replay: Raumeinfluss 10.10. 10:26 „Raum wieder im Band“ +12,63 unter v4). Deshalb wird er gegen b = 0,5 gerechnet (`SCORE.fehlRefB`, wie vor dem Lernen der Basisrate): 100 × (0,25 − p²), p 0,7 → −24, p 0,8 → −39 (geteilt durch die Anzahl Horizonte), und geht so in den Skill ein (`bp: "abzug"`). Das ist meine Auslegung von „Fehlalarme bleiben voll im Abzug“; Alternativen siehe Abschnitt 12.
- **b < p**: Brier wie bisher (Test: identisch mit v4).
- **Kein Gaming** bleibt erhalten: ohne Trennschärfe (Ergebnis-Häufigkeit = b) ist der Erwartungswert ≤ 0, bei b ≥ p sind nur Abzüge möglich (Test für b 0,1…0,99, p 0,6…0,8).
- **Skill** erst ab 3 Fällen **mit Brier-Beitrag** (mindestens ein nicht neutraler Horizont; `skillFaelle`). Folge für die Freigabereife siehe Abschnitt 12.
- Fälle, die unter v4 begannen, enden mit v4 (Test). v5-Summen beginnen bei 0. Nachrechnen: `cfg.sv = 4` / `--sv4`.

**Änderung v3 → v4 (12.10., Befund auf der Seite):** Die Kachel „Heizgrenze“ zeigte „1 Fall · 1 Treffer · 0 Fehlalarm“, aber −14,0 Punkte und Skill −6,84. Nachgerechnet: Ergebnis o = 1, Prognose p = 0,6, Basisrate b ≈ 0,857 → 100 × [(0,857 − 1)² − (0,6 − 1)²] = 100 × (0,0204 − 0,16) = −14,0; Skill = 1 − 0,16/0,0204 = −6,84. Die Mathematik stimmt. Aber p ist eine Annahme unter der echten Basisrate, also kann ein Treffer nie positiv punkten; die Regel ist nur ein Hinweis, und ein Skill aus einem Fall ist wertlos. Dieselbe Ursache hatte „Skill −25,01 bei 0 Fällen“ beim Raumeinfluss: bis v3 wuchsen ΣBS und ΣBS_ref schon beim Abschluss einzelner Horizonte, der Fall zählte erst nach allen.
- **Hinweis-Regeln** (`art` „hinweis“, heute nur der Heizgrenze-Hinweis) sammeln keine Punkte. Treffer, Fehlalarm, neutral und Schaden werden weiter gezählt und im Punktebuch mit Ergebnis und Basisrate geschrieben (0 Punkte, „nur Hinweis, keine Punkte“). Punkte, Skill und Freigabereife entfallen („–“), die Regel steht nicht im Diagramm.
- **Brier-Summen nur aus abgeschlossenen Fällen.** Jeder Fall sammelt seine Beiträge selbst; sie gehen erst in ΣBS/ΣBS_ref ein, wenn der Fall nach dem letzten Horizont abgeschlossen ist. Ein offener Fall verändert Skill und Kennzahlen nicht.
- **Skill erst ab 3 bewerteten Fällen** (`SCORE.skillMinFaelle`), vorher „–“, in der Kachel und im Kriterium der Freigabereife.
- Fälle, die unter v3 begannen, werden mit v3 zu Ende bewertet (Test). Nachrechnen: `cfg.sv = 3` (Test: derselbe Hinweis-Treffer zählt dort +9 bei b = 0,5, Skill schon aus 1 Fall).
- **Nicht geändert, offene Entscheidung:** dieselbe Falle (p unter der Basisrate → Treffer mit Minuspunkten) betrifft auch Befehlsregeln, siehe Abschnitt 12.

**Änderung v2 → v3 (11.10., Verschiebungs-Arbitrierung):**
- Minuten, in denen eine Verschiebungs-Regel nur durch die Gegenregel (`vorrang`, `gegenrichtung`) zurückgehalten wird, zählen wie eigene Sperren (neutral, `verpasst_sperre`), nur mit den Standardwerten; harter Schaden hebt das wie in v2 auf.
- Schlägt eine andere Verschiebungs-Regel für die Lage dieselbe Richtung vor, gilt die Lage als versorgt.
- Treffer/Fehlalarm bucht immer die Regel, die vorgeschlagen hat. Die Wirkung einer übernommenen Verschiebung („Soll folgt“) zählt für die Regel, deren Vorschlag übernommen wurde; für alle anderen offenen Fälle ist die Übernahme ein Eingriff (neutral, Urheber im Text).
- Nachrechnen: `cfg.sv = 2` (Test: dieselbe Lage ist in v2 „verpasst“ −20, in v3 neutral). Raumeinfluss ist jetzt Regel v2, seine Summen beginnen neu.
- Vorausschau: Problem „der knappste Raum gerät an den Bandrand“ (+1 K: ≤ Minimum + 0,3 K, −1 K: ≥ Maximum − 0,3 K), letzter gültiger Raumwert vor dem Horizont, Horizonte 120/240/360 min, p = 0,6. „Verpasst“ siehe (4).

**Änderung v1 → v2 (Entscheidung des Nutzers 10.10.):** „verpasst“ wird entschuldigt, wenn die Maschine nur wegen ihrer **eigenen**, im Regelwerk dokumentierten Sperren und Wartezeiten keinen Vorschlag machen durfte. Harte Schäden zählen trotzdem, damit Sperren keine Ausrede werden. Einzelheiten unter (4).

**(1) Auslöser-Prognose je Fall.** Ein Fall ist eine Vorschlags- oder Hinweis-Episode einer Regel.
- Jede Regel nennt vorab ihre Prognose mit Wahrscheinlichkeit *p*, z. B. Quiet-Freigabe: „Ohne Freigabe bleibt der Verdichter am Deckel und der Rücklauf-Rückstand ≥ 1 K“, p = 0,8, Horizonte 30/60/120 min. „Am Deckel“ heißt seit v2 höchstens Deckel der Stufe + 1 Hz, in v1 fest ≤ 20 Hz.
- Am Horizont wird das Ergebnis *o* gemessen: 1, wenn das Problem in ≥ 80 % der gültigen Minuten bestand, 0, wenn in ≤ 20 % (es löste sich von selbst), sonst neutral. Bei Räumen zählt der letzte gültige Wert in den 30 min vor dem Horizont.
- Punkte je Horizont: **100 × [(b − o)² − (p − o)²] / Anzahl Horizonte.**
- *b* ist die **Basisrate „bleibt, wie es ist“**. Sie stammt aus Vergleichslagen, die schwächer definiert sind als der Auslöser, z. B. „am Deckel mit ≥ 1 K Rücklauf-Rückstand“. Höchstens eine Vergleichslage je 15 min (Raum/Heizgrenze: je 60 min), b = (k + 1)/(n + 2), erst ab 5 Vergleichen, vorher 0,5.
- **Eingriffe** machen ab dort neutral, weil es dann keine Gegenfaktik mehr gibt: Quiet, Verschiebung oder Soll (≥ 2 K) geändert, auch von Hand; Komfortband geändert; **Lüftungsverdacht**, d. h. ein Raum fällt ≥ 1 K in ≤ 60 min. Den Lüftungsverdacht habe ich nach dem Replay ergänzt (09.10. Wohnzimmer −3,9 K, Fenster), noch vor dem Festziehen von v1.
- Zu kurz beobachtet (< ½ Horizont) heißt neutral.

Beispiele (gerechnet, auch Teil der Tests):

| Lage | Punkte |
|---|---|
| Treffer, b = 0,5, p = 0,8 | 100 × (0,25 − 0,04) = **+21** je Fall (über die Horizonte verteilt) |
| Fehlalarm, b = 0,5, p = 0,8 | 100 × (0,25 − 0,64) = **−39** |
| Treffer bei hoher Basisrate, b = 0,86, p = 0,6 | bis v4 **−14** (der Vorschlag kam nur dort, wo das Problem sowieso meist bleibt); seit v4 bei Hinweisen 0, seit v5 auch bei Befehlsregeln **0** (neutral) |
| Fehlalarm bei hoher Basisrate, b = 0,91, p = 0,8 | bis v4 **+18,8** (Brier-Plus), seit v5 **−39** (Abzug gegen b 0,5) |

**Kein Gaming:** Wer ohne Trennschärfe vorschlägt, also nur dort, wo das Ergebnis der Basisrate entspricht, bekommt im Mittel ≤ 0 Punkte, egal welches *p*. Der Brier-Score ist „proper“, die Sim prüft das für f = 0,1…0,9 und p = 0,1…0,9.

**(2) Wirkungsprognose.** Sie wird nur bewertet, wenn eine **gleichwertige Änderung tatsächlich passiert**, z. B. der Nutzer setzt Quiet von Hand oder ein Klick wird übernommen.

| Lage | Prognose | Punkte |
|---|---|---|
| Quiet ≥ 1 → 0 bei Rücklauf-Rückstand ≥ 1,5 K | ≥ 25 Hz binnen 5 min; Leistung +350…+650 W (Minute 2–5 gegen die Minute davor); Vorlauf +2 K in 30 min | je ±10 |
| Quiet → 1 oder 2 bei Rücklauf-Rückstand ≥ 1,5 K (seit Freigabe v2) | Verdichter mindestens alter Deckel + 3 Hz binnen 10 min; Leistung +60 W oder mehr (Minute 2–10) | je ±10 |
| Quiet niedriger ohne Rückstand (< 0,5 K) | ≤ 20 Hz in 10 min | ±10 |
| Quiet höher bei ≥ 22 Hz (seit Deckel/Laufzeit v4) | ≤ 21 Hz binnen 10 min; −100 W (Minute 5–10); bis v3: ≤ 20 Hz binnen 3 min, −300 W | je ±10 |
| Verschiebung ±1 | Soll folgt binnen 6 min (der Soll ändert sich im 5-min-Raster; bis 13.10. abends binnen 3 min) | ±10 |

Nicht messbar zählt 0. **Kalibrierfälle** zählen 0 Punkte: Das sind die Messungen, aus denen das Modell stammt (±3 min). Sie werden ausgewertet und angezeigt.
- Quiet-Freigabe: 10.10. 08:40, 08.10. 22:54, 10.10. 11:17 und seit v2 13.10. 16:36.
- Deckel/Laufzeit v4: 08.10. 09:38 und 12.10. 09:30.

**Messaufgabe „Heizkurve +1 K“** (seit Deckel/Laufzeit v4, 0 Punkte): Bei jeder Verschiebung 0 → +1 K, gleich von wem, vergleicht der Kern den Zyklus davor (letzter Lauf, Pause davor) mit dem ersten Lauf, der danach endet, und der Pause danach. Er schreibt einen Befund `messaufgabe`/`laufzeit_1k`. Damit lassen sich die Annahmen +40 min Lauf und −18 min Pause kalibrieren.

**(3) Schaden.** Er wird hoch gewichtet und gilt für den Fall bis zum längsten Horizont.

| Art | Bedingung | Punkte |
|---|---|---|
| Sperre verletzt | Vorschlag trotz Sperre (Selbstprüfung) | −50 |
| Heizstab | Heizstab lief | −50 |
| Stopp binnen 10 min | nur bei mehr Leistung oder −1 K | −30 |
| Überschwingen | Vorlauf ≥ Soll +3,25 K binnen 30 min; bei −1 K gegen den neuen Soll gerechnet | −30 |
| zu warm | Raum über Max + 0,5 K bei wärmenden Maßnahmen | −20 |
| zu kalt | Raum unter Min − 0,3 K bei kühlenden Maßnahmen | −20 |

**(4) Verpasst** (−20). Eine unabhängige, strengere Lage lag vor, die Regel machte aber keinen Vorschlag.

| Regel | strengere Lage |
|---|---|
| Quiet-Freigabe | 20 min am Deckel mit ≥ 2 K Rücklauf-Rückstand; seit v2 am Deckel der Stufe (≥ Deckel − 1 Hz) **und** mit Bedarf (wie der Auslöser) |
| Raumeinfluss | Raum ≥ 0,5 K unter Minimum 180 min lang, kein Raum zu warm |
| Deckel/Laufzeit (vorher Laufzeit strecken) | bis v3: 10 min ≥ 22 Hz ohne Bedarf mit Abschaltung in ≤ 20 min, ab v2 zusätzlich Takt belegt. v4 (Hebel Quiet): 20 min in der vollen Lage des Auslösers (≥ 22 Hz, kein Bedarf, Rücklauf ≤ 1 K unter Soll, Komfort sicher, 2 h Ruhe, über 3 °C, Zielstufe aus den Daten). Für den Hebel +1 K gibt es kein „verpasst“, weil seine Wirkung nicht gemessen ist |
| Vorausschau (seit v3, Entscheidung 11.10.) | Gate offen und alle Bedingungen der Regel erfüllt (Bedarfsänderung aus dem Wetter ≥ 2 K, Räume im Band mit Luft) 60 min am Stück ohne Vorschlag, auch keiner einer anderen Verschiebungs-Regel in dieselbe Richtung, ohne Sicherheits-/Datensperre. **Gebucht wird nur, wenn die Lage wirklich eintritt** (bis zum Fensterende +5 h): ein Raum verlässt das Band in der vorhergesagten Richtung (sofort) oder die gemessene, um den Tagesgang bereinigte Außentemperatur zeigt im Fenster mindestens die halbe Schwelle (am Fensterende). Sonst kein Eintrag. Neutralität wie unten (eigene und Gegenregel-Sperren → `verpasst_sperre` 0; Raum > 1 K unter Minimum hebt das auf) |

Sicherheits- und Datensperren entschuldigen ganz (wie in v1).

**Eigene Sperren (seit v2).** Eigene Sperren sind Mindestabstand (`gapMin` 60 min, z. B. nach Quiet von Hand), Tageslimit (`proTag`), Wartezeit nach einem Vorschlag (`pauseMin`), Haltezeit (`haltMin`) und Stabilitätszeit des Raumvorschlags (`stabilMin`).
- Jede Minute der Lage ist entweder **frei** oder **gesperrt**. Gesperrt heißt: Alle Bedingungen der Regel sind erfüllt und nur eigene Sperren halten sie zurück. Beim Raumeinfluss reicht es auch, wenn nur die Stabilitätszeit fehlt.
- **Verpasst** (−20) ist es erst, wenn die freien Minuten die Dauer der Lage erreichen (20/10/180 min). Ohne eigene Sperre ist das genau v1.
- Lief die Dauer nur wegen eigener Sperren ab, entsteht ein Eintrag `verpasst_sperre`: **0 Punkte**, getrennt gezählt (`verpasstSperre`). Er zählt nicht für die Freigabereife und steht auf der Seite als Kennzahl „verpasst während Sperre“ in der Kachel.
- **Nur Standardwerte entschuldigen.** Eine Minute zählt nur dann als gesperrt, wenn die Sperre auch mit dem dokumentierten Standardwert bestanden hätte. Ist ein Wert verlängert (z. B. `gapMin` 180), zählen die Minuten über den Standard hinaus als frei. Der Text nennt dann „über den Standardwert verlängert“.
- **Harter Schaden hebt die Entschuldigung auf.** Tritt im Fenster ein Schaden ein, den ein rechtzeitiger Vorschlag verhindern sollte, ist es „verpasst“ (−20) mit `schaden: [...]`, auch wenn der neutrale Eintrag schon geschrieben war:

  | Regel | harter Schaden im Fenster |
  |---|---|
  | Quiet-Freigabe | Raum mehr als 1 K unter Minimum (Komfortverlust über das Maß) |
  | Deckel/Laufzeit | Verdichter stoppt (Takt), auch wenn der Stopp das Fenster beendet; Vorlauf ≥ Soll +3,25 K (Überschwingen) |
  | Raumeinfluss | Raum mehr als 1 K unter Minimum |

  1 K ist eine Annahme (die Lage selbst beginnt beim Raumeinfluss schon bei 0,5 K unter Minimum).
- Ein Fenster kann erst neutral zählen und später zusätzlich „verpasst“ werden: wenn die Regel auch nach dem Ende der Sperre nicht vorschlägt oder ein Schaden eintritt.
- Im Replay betrifft das genau einen Fall, Kinderzimmer oben am 09.10. ab 18:47. Er war nach v1 „verpasst“ (−20), nach v2 ist er „während Sperre“ (Stabilitätszeit, 0 Punkte). Siehe `docs/replay_2026-10-07_bis_10.md`.

**Raumdaten in der Bewertung:** Werte bis 6 h Alter zählen, weil die Shelly H&T Gen3 nur bei ≥ 0,5 K Änderung melden. Die *Entscheidung* nutzt weiter das Datenalter-Limit des Raums (90 min).

**Punktebuch** `scores-YYYY-MM.jsonl`, je Datensatz:

| Feld | Inhalt |
|---|---|
| `t`, `typ` | Zeit; Typ `ausloeser`, `wirkung`, `schaden`, `verpasst`, `verpasst_sperre` (seit v2, 0 Punkte) oder `messaufgabe` |
| `sperre`, `schaden` | bei `verpasst`/`verpasst_sperre` (v2): eigene Sperren im Fenster, Schadensarten, die die Entschuldigung aufhoben |
| `regel`, `v`, `sv` | Regel, Regelversion, Bewertungsversion |
| `fall` | betroffener Fall |
| `p`, `horizonte` | je Horizont: o, b, n, Punkte, Begründung |
| `ergebnis` | Ergebnis des Falls |
| `punkte`, `summe` | Punkte und laufende Summe |
| `text` | Klartext |

Die Karte „Punkte“ zeigt den Verlauf der Summen je Befehlsregel als Diagramm (`ui_chart.js`) und je Regel eine Kachel: Summe (Hinweis: „–“), Fälle mit Treffern und Fehlalarmen, seit v5 „davon n Treffer neutral (Basisrate ≥ Prognose)“, wenn n > 0, Brier-Skill = 1 − ΣBS/ΣBS_ref (nur abgeschlossene Fälle, ab 3 bewerteten), Wirkung (Kalibrierfälle getrennt), Schaden und Verpasst nur wenn > 0, bei Befehlsregeln die Kennzahl „verpasst während Sperre“, Freigabereife. Die Wochenübersicht (ISO-Woche) steht weiter im Zustand und im Punktebuch, aber nicht mehr auf der Seite.

**Freigabereife** ist nur eine Anzeige, die Freigabe entscheidet der Nutzer. Bedingungen:
- ≥ 10 bewertete Fälle
- ≥ 14 Tage
- Brier-Skill ≥ 0,2 (erst ab 3 bewerteten Fällen berechnet)
- 0 × Schaden
- ≤ 1 × verpasst
- ≥ 2 Wirkungsfälle mit Punkten > 0, ohne Kalibrierung

## 7. Messaufgabe Comfort/Efficiency (Korrektur 10.10.)

Die Wirkung von Comfort/Efficiency auf die Verdichterfrequenz ist **ungeklärt**, weil Quiet 3 sie bisher verdeckt hat.

**Messung bisher:**
- Der Boost am 10.10. lief durchgehend in Efficiency.
- Ob das Plateau bei 33–34 Hz (≈ 5 kW bei 11–13 °C) eine temperaturabhängige Frequenzgrenze ist oder eine Begrenzung durch Efficiency, ist offen.
- Der Wechsel Comfort → Efficiency am 08.10. um 10:02 lag unter Quiet 3. Er konnte keinen Frequenzeffekt zeigen.

**Nutzerregel:** Bis 12.10. galt „keine Comfort/Efficiency-Wechsel wegen Räumen“. Seit 13.10. gilt „wir schalten so, wie es am effizientesten ist“. Eine Regel zur Heizregelung gibt es trotzdem nicht, weil die Daten fehlen.

**Ablauf der Messaufgabe:**
- Gesammelt werden Minuten mit Quiet 0, laufendem Verdichter ab Minute 15, mindestens 3 min nach einer Quiet-Änderung und Vorlauf ≥ 2 K unter Soll, getrennt nach Heizregelung.
- Sobald beide Seiten ≥ 10 min bei ähnlicher Außentemperatur haben (Mittel höchstens 3 K auseinander), wird **ein Befund** festgehalten: maximale und mittlere Frequenz, elektrische und thermische Leistung, Außentemperatur. Er hat 0 Punkte, Typ `messaufgabe`.
- Der Beobachter rechnet dasselbe aus dem Minutenprotokoll mit derselben Abgrenzung.

**Stand im Replay:** 07.–10.10.: Efficiency 41 min (max 34 Hz, Ø 839 W, 12 °C), Comfort 0 min, also offen. Ein kurzer Boost in Comfort mit Quiet 0 würde reichen.
- 07.–13.10.: Efficiency 66 min, Comfort weiter 0 min, obwohl seit 12.10. abends rund 7 h in Comfort liefen. Comfort holt den Rückstand in Minuten auf, die Messaufgabe schließt genau diese Startphase aus.
- Das Regel-Review (4.5) empfiehlt, sie zu streichen. Das ist nicht Teil des Quiet-Auftrags und bleibt offen.

## 8. Ein-Klick-Übernahme (ausgeliefert, gesperrt)

### Weg (a) oder (b)? Entscheidung: (a), deaktiviert ausgeliefert

| | (a) eigener `mqtt out` im Optimierer-Tab | (b) bestehende HeishaMoNR-Befehlskette (`> MQTT OUT`, WP Managers) |
|---|---|---|
| Kern-Tabs ändern | nein | Ziel-Link-in bekommt eine Verbindung (Kern-Tab, braucht Go) |
| Befehl kommt genau so an | ja, nach Whitelist, Prüfsumme und Ist-Abgleich | Rate 1/7 s; `Block?` verwirft im Sperrfall (mit Meldung) und ohne gesetztes `MQTT.block_active` still; kein späteres Nachsenden |
| Rücklesen und Wiederholung | eigen: Rücklesen über `Quiet_Mode_Level` bzw. `Z1_Heat_Request_Temp`, 2 Wiederholungen, dann Alarm | Command Check laut Opus-Review 09.10.: höchstens 3 Wiederholungen im 30-s-Takt, gibt dann auf |
| Nachgleichen | eigener Rückweg-Timer; bei fremder Änderung Warnung | die Kette sendet nur bei Änderung, gleicht nie nach (Opus-Review 09.10., B1/B2) |
| Wechselwirkung mit HeishaMoNR | Verschiebung nur ohne konkurrierenden Regler (RTC, Nachtabsenkung, Sanftanlauf aus, `SHIFT_Final` = 0, Heizkurvenmodus, Wasserfühler); HeishaMoNR würde eine eigene Änderung erst beim nächsten eigenen Sollwechsel überschreiben, das erkennt die Übernahme als „fremde Änderung“ | Summenfunktion überschreibt bei ihrer nächsten Änderung |
| Abschaltbarkeit | Knoten deaktiviert, plus Hauptschalter | Link entfernen |

Begründung für (a):
- Der Optimierer-Tab bleibt der einzige Ort, an dem dieser Sendeweg existiert. Die Kern-Tabs bleiben unberührt.
- Rücklesen und Rückweg sind pegelgesteuert (Ist gegen Soll) statt änderungsgesteuert. Genau das fehlte der Kette.

Option (b) ist dokumentiert, aber nicht gebaut. Sie hätte die Ratenbegrenzung der Kette und deren `Block?`. Dafür müsste aber `8b3d729fe630c248` eine weitere Verbindung bekommen, und das braucht das Go des Nutzers.

### Sicherheitsnetze

1. **Doppelt gesperrt ausgeliefert:**
   - `opt_apply_mqtt` hat `"d": true`. Node-RED legt den Knoten gar nicht an, nichts kann hinaus.
   - `/data/optimizer/apply.json` fehlt, damit gilt der Hauptschalter `OPT_apply_enabled` = aus. Nur `"enabled": true` (Boolesch) schaltet ein.
   - Die Karte zeigt „Übernahme gesperrt“.
   - Seit 13.10. weiß `opt_apply`, dass der Sendeknoten deaktiviert erzeugt wurde (Generator-Schalter `KNOTEN = false`): ein Klick wird auch mit Hauptschalter AN abgelehnt, die Karte zeigt „Übernahme gesperrt: Sendeknoten deaktiviert“. Vorher hätte ein Klick „gesendet“ gemeldet und wäre am deaktivierten Knoten verpufft (Rücklese-Timeout).
2. **Nur der Klick sendet.** Es gibt keinen automatischen Sendeweg. Die Sim prüft 36 h mit Hauptschalter AN und allen Regeln freigegeben: 0 Befehle ohne Klick.
   - Einzige Ausnahme ist der **Rückweg einer geklickten Übernahme**. Er ist Teil des angezeigten Vorschlags („Gültig bis … automatisch zurück auf …“) und wird nur in Richtung des vorherigen Werts gesendet.
3. **Prüfkette je Klick.** Vom Browser kommen nur ID und Prüfsumme. Der Server prüft:
   - Doppelklick
   - Hauptschalter
   - Sendeknoten aktiv erzeugt (seit 13.10.: `opt_apply` trägt den Generator-Schalter `KNOTEN`; ohne `--uebernahme-knoten-aktiv` lehnt er jeden Klick ab, auch mit Hauptschalter AN)
   - Maschine rechnet (≤ 2,5 min alt)
   - ID = aktueller Vorschlag
   - Prüfsumme
   - Art = Befehl, nicht Hinweis
   - Regel freigegeben (`apply.json` → `rules`)
   - Gültigkeit
   - Whitelist und Wertebereich: `SetQuietMode` 0–3, `SetZ1HeatRequestTemperature` −1…+1, nichts sonst
   - Ausgangswert in der Whitelist (seit 13.10.; sonst wäre kein Rückweg möglich)
   - Topic
   - Notbremse `MQTT.block_active`
   - HeishaMon-Daten ≤ 5 min alt
   - Sperren der Regel
   - **Abgleich mit dem Ist-Zustand**: die Anlage steht noch auf dem Ausgangswert
   - Verschiebung nur im Heizkurvenmodus mit Wasserfühler
   - kein Befehl offen
   - keine aktive Übernahme derselben Größe (außer der Fortsetzung derselben Regel in derselben Richtung; Quiet und Verschiebung nebeneinander, jede mit eigenem Rückweg)
   - Rate ≥ 10 min
   - Tageslimit 6
4. **Unmittelbar vor dem Ausgang** prüft die Hülle noch einmal: Topic aus der Whitelist, erlaubter Wert, keine Notbremse.
5. **Quelle:** `global.MQTT_Source` = „Optimierer (Klick)“ bzw. „Optimierer (Rückweg)“. So erkennen Wächter und HeishaMoNR-Protokoll den Befehl.
6. **Rücklesen** über HeishaMon-Status (`Quiet_Mode_Level` bzw. `Z1_Heat_Request_Temp`):
   - Bestätigung binnen 90 s, sonst bis zu 2 Wiederholungen im Abstand von 90 s.
   - Danach rote Warnung, das ergibt höchstens 3 Befehle.
   - Bei Notbremse wird gewartet, der Versuch wird nicht verbraucht.
7. **Fremde Änderung** nach der Bestätigung: Warnung, die Übernahme endet. Es gibt keinen automatischen Rückweg, weil jemand anderes übernommen hat.
8. **Rückweg:**

   | Regel | Rückweg |
   |---|---|
   | Deckel/Laufzeit, Quiet (v4) | nach 8 h oder wenn der Grund endet (Bedarf, Rücklauf-Rückstand ≥ 2,5 K seit 15 min, Außen ≤ 3 °C); bis v3 nach 4 h |
   | Deckel/Laufzeit, +1 K (v4) | nach 6 h, bei Heizstab-Nähe, wenn ein Raum mehr als 0,3 K über die Bandmitte steigt oder zwei Läufe ohne Takt endeten; ruht, solange der Raumeinfluss dieselbe Verschiebung verlangt |
   | Raumeinfluss | nach 6 h oder Raumvorschlag 15 min am Stück 0 (er flackert, wenn Kinderzimmer-Werte ungültig werden) |
   | Quiet-Freigabe (v2) | auf die Ausgangsstufe, sobald der Bedarf 15 min gedeckt ist oder ein Bedarfsraum 15 min über seinem Maximum liegt (andere Räume über Maximum zählen nicht); Frist 4 h, sie ruht, solange Bedarf besteht oder die Kälte-Vorsorge hält (v1: kein automatischer Rückweg) |

   Rechnet die Maschine nicht mehr (älter als 5 min), gelten ihre Gründe und `halten` nicht, nur die Frist; nach 30 min ohne Rechnung geht jede bestätigte Übernahme auf ihren Ausgangswert zurück („sicherer Abbruch“, Review B7). „Zurücksetzen“ ist jederzeit möglich, außer bei Notbremse; es stellt alle Übernahmen nacheinander zurück. Der Rückweg macht bis zu 3 Versuche. Bleibt er unbestätigt, endet das automatische Senden mit roter Warnung (seit 13.10.; vorher startete er alle 4,5 min neu, 76 Befehle in 2 h); „Zurücksetzen“ von Hand geht weiter, meldet die Anlage später den Ausgangswert, endet die Übernahme.
9. **Neustart** mitten in der Übernahme: Der Zustand liegt in `apply-state.json`. Rücklesen und Rückweg-Timer laufen weiter. Es wird nichts doppelt gesendet, solange die Anlage den Wert meldet.
10. **Not-Aus im Dashboard:** „Übernahme sperren“ setzt `apply.json` → `enabled: false`. **Entsperren geht nie über das Dashboard**, nur über die Datei.
11. **Protokoll:** Jede Aktion steht in `applied-YYYY-MM.jsonl`, auch Ablehnungen mit Grund, und zusätzlich als `optimierer_*` in `quiet-events`.

### Freigabe (nur mit Go des Nutzers)

1. Der Nutzer entscheidet je Regel, z. B. nach der Freigabereife-Anzeige.
2. Flows mit `--uebernahme-knoten-aktiv` erzeugen und deployen (nur `opt_*`). `deploy_opt.sh` kennt dafür seit dem Patch `deploy_opt_genargs.patch` die Umgebungsvariable `GEN_ARGS`: `GEN_ARGS=--uebernahme-knoten-aktiv ./deploy_opt.sh uebernahme_an`. Das Skript reicht den Schalter an den Generator, setzt für die Sims `UEBERNAHME_KNOTEN_AKTIV=1` (sie verlangen dann den aktiven Sendeknoten und `KNOTEN = true` in `opt_apply`, ohne Ansage schlagen sie bei aktivem Knoten an) und zeigt „opt_apply_mqtt live: … -> neu: …“. Geändert werden genau `opt_apply_mqtt` (aktiv) und `opt_apply` (`KNOTEN = true`).
3. `/data/optimizer/apply.json` schreiben, Vorschlag: `apply.json.vorschlag` (`{"enabled": true, "rules": ["quiet_freigabe", "quiet_strecken", "raum_offset"]}`; Heizgrenze bleibt Hinweis, Vorausschau erst mit offenem Gate; die Grenzen stehen dort nur zur Erläuterung, sie sind fest im Kern). Der Hauptschalter wird bei jedem Takt (15 s) neu gelesen.
4. Zurück geht es mit „Übernahme sperren“ im Dashboard, durch Löschen der Datei oder durch einen Deploy ohne den Schalter (dann zeigt das Skript „live: AKTIV -> neu: deaktiviert“).

## 9. Seite „Optimierer“

Fünf Gruppen, alle 17 breit (seit 13.10., vorher vier zu 18); seit dem Zusammenlegen der Seiten (Abschnitt 16) folgen darunter die beiden Quiet-Statistik-Karten, ebenfalls 17 breit. Gemischte Breiten auf einer Seite legen die Karten übereinander (Masonry-Falle), deshalb sind sie gleich breit; je Gruppe genau eine Karte. Die Karten passen ihre Höhe selbst an (`FIT_JS`), seit 13.10. zusätzlich sofort nach jedem Zeichnen (der 1,5-s-Takt von `FIT_JS` ruht, solange das Fenster verdeckt ist; dann blieben die Starthöhen stehen und der Inhalt scrollte in der Karte). Starthöhen 4/3/9/10/12 Einheiten passen ohne Einpassen für den üblichen Inhalt. Keine erklärenden Hinweiszeilen, kein Satz „würde schalten, sobald …“ auf der Seite (er bleibt nur als Feld `naechste` im Datensatz); Einzelheiten stehen im Tooltip.

**Gruppenbreite (Entscheidung 13.10.):** 17 Einheiten = 912 px. Ab ~1840 px Fensterbreite stehen zwei Spalten nebeneinander (1920 und 2560 px), bei 1024 px eine Spalte ohne waagrechtes Scrollen (Inhalt ~1007 px). Breiter als 18 Einheiten (966 px) scrollt bei 1024 px waagrecht, eine größere einheitliche Breite scheidet deshalb aus; 16 und schmaler kürzt die fünf Kacheln je Zeile (Namen bis 17 Zeichen). Bei 2560 px bleiben rechts ~700 px frei (drei Spalten bräuchten ≤ 15 Einheiten, zu schmal für die Kacheln). Die Karte „Aktueller Vorschlag“ ist immer höher als „Regeln“ (ohne Vorschlag Mindesthöhe, 4 Einheiten), damit die Masonry mit und ohne Vorschlag gleich anordnet: links „Aktueller Vorschlag“ und „Messwerte & Lernen“, rechts „Regeln“, „Punkte“, „Entscheidungen“; bei 1024 px untereinander in dieser Reihenfolge: Vorschlag, Regeln, Punkte, Messwerte, Entscheidungen. Geprüft nur in der statischen Vorschau (Masonry nachgebildet); im Dashboard nach dem Deploy bei 1024/1920/2560 px ansehen. Fällt die Anordnung live anders aus, genügt `ENG_W = 18` im Generator.

Aufbau:
- **Daten** baut `tools/engine_view.js` (`ENGVIEW.build`, rein, in `opt_engine` hinter dem Kern eingebettet). **Darstellung**: `tools/eng_ui.js` (`optEngUi.html`/`mount`, rein, HTML mit Maskierung aller Texte), in jede der fünf Vorlagen eingebettet. Die Vorlagen zeichnen per `innerHTML` wie die Diagrammkarten, ohne Angular-Ausdrücke.
- **Knöpfe** schicken weiter nur Aktion, ID und Prüfsumme (`scope.send` genau viermal im Code, Test).

| Karte | Inhalt |
|---|---|
| Aktueller Vorschlag | **Statuszeile** aus Chips: „Maschine läuft · hh:mm“ bzw. „Anlaufsperre bis …“, „keine HeishaMon-Daten“, „Maschine rechnet nicht“; Anlage kurz (Lauf · Hz · Quiet · Vorlauf-Abstand); Übernahme („🔒 Übernahme gesperrt“, „… Sendeknoten deaktiviert“, „Übernahme frei: … · heute n/6“, „Übernommen …“, „wartet auf Bestätigung“); Warnung; „verworfen: …“. **Mit Vorschlag**: hervorgehobener Kasten mit Regel, seit/gültig bis, Was (groß) und offen sichtbar **Befehl** (`SetQuietMode = 0`), **Zielwert** („Quiet 0 (jetzt Quiet 3)“, „Verschiebung +1 K (jetzt 0 K)“), **Begründung**, **Erwartete Wirkung** (Kernaussage ohne Klammern, voller Text mit Messbelegen im Tooltip), **Rückweg** („automatisch zurück auf Quiet 0, spätestens nach 4 h“, „kein automatischer · „Zurücksetzen“ stellt Quiet 3 wieder her“; Bedingungen im Tooltip). **Knopf** „Übernehmen“: grau mit Grund daneben in der Reihenfolge der Prüfkette des Servers („🔒 gesperrt: Hauptschalter aus“, „… Sendeknoten deaktiviert“, „… Regel nicht freigegeben“, „wartet auf Bestätigung der Anlage“, „… Übernahme Raumeinfluss läuft“, „gesperrt bis 10:52 (Abstand 10 min)“, „… Tageslimit 6/6 Befehle“, „nur Hinweis, von Hand einstellen“), sonst blau mit „frei · heute n/6 Befehle“; Verwerfen. **Ohne Vorschlag**: „Kein Vorschlag“ mit letztem Vorschlag (Regel, Was, Zeitraum, Ende), Zahl der Vorschläge/Hinweise der letzten 24 h und Übernahme-Stand. Zurücksetzen nur bei aktiver Übernahme, Übernahme sperren nur wenn freigegeben |
| Regeln | 5 Kacheln (eine Zeile, je ~170 px): kurzer Kachelname (`kachel`: Quiet-Freigabe, Deckel/Laufzeit (bis v3 Laufzeit strecken), Raumeinfluss, Heizgrenze, Vorausschau), darunter Status-Chip (Vorschlag/Hinweis, wartet, gesperrt, prüft, ruht, keine Daten) und je Bedingung ein Segment (grün = erfüllt, Titel = Bedingung), eine Zeile mit dem Engpass und Balken: „Vorlauf-Rückstand 0,5 / 1,5 K“, „Haltezeit 4 / 10 min“, „🔒 Mindestabstand bis 09:38“, „🔒 Modell-Gate 1 / 10 Tage“, „seit 08:36 · gültig bis 09:06“. Texte brechen um statt abgeschnitten zu werden |
| Punkte | Diagramm der Summen je Befehlsregel (nur wenn es Punkte gibt), 5 Kacheln (Summe, bei der Heizgrenze „–“ und „nur Hinweis“; Fälle/Treffer/Fehlalarm, seit v5 „davon n Treffer neutral (Basisrate ≥ Prognose)“ wenn n > 0, Skill ab 3 Fällen, Wirkung, Schaden/Verpasst rot, Kennzahl „verpasst während Sperre“ (Befehlsregeln), Freigabereife n/m mit Balken, Kriterien eingeklappt). Keine Mess-/Lernzeilen mehr |
| Messwerte & Lernen (neu 13.10.) | **Takt und Leistung**: Kacheln Takt (ruhig/Takt, Starts in 24 h), Läufe 24 h (Ø, kurze), Pausen 24 h (davon Minutenpausen), Heizgrenze beobachtet (Ø, max, Läufe), Messaufgabe Comfort/Efficiency (offen/erledigt). **Mindestleistung je Außenband**: Zellen „Band über Wert“ (laufendes Minimum von warm nach kalt; Quantil und Minuten im Tooltip), nur Bänder mit ≥ 30 stabilen Minuten. **COP je Modus und Quiet · 30 Tage**: Matrix Zeilen = Außenband (kalt → warm), Spalten = vorhandene Kombinationen Comfort/Efficiency × Q0–Q3 (Einträge mit unbekannter Heizregelung oder Quiet „?“ zählen nicht), Zelle = COP und Stunden, unter `cfg.takt.copMinMin` (60 min) grau, bester gültiger Wert je Zeile grün (nur wenn es mindestens zwei gültige gibt), Minuten/Hz/kWh im Tooltip. **Lernen**: Kacheln Gebäudemodell (n/10 Tage, Gate zu/offen/aktiv), Lern-Gate heute (frei/gesperrt, verworfene Tage), Bedarfsmodell Drift (ruhig/Mehrbedarf/Minderbedarf, CUSUM von 4), Wirkzeit Raum ↑/↓ (Minuten oder „sammelt“ n/3 Ereignisse, Puffer im Tooltip), Heizkurven-Bias (K, „sammelt“ n/3 Tage oder „Absenkung“). Ohne Daten Chip „sammelt“ bzw. „keine Daten“ |
| Entscheidungen | **Episoden** statt Minutenzeilen: je Regel von „alle Bedingungen erfüllt“ (wartet, gesperrt, Vorschlag/Hinweis) bis zum Ende, mit Verlauf als Chips und Ende-Grund (bei Dauersperre Modell-Gate seit 13.10. die fehlende Bedingung, z. B. „Vorhersage: Bedarf -1,6 K“, statt des Gate-Textes); Dauerzustände („prüft“, „ruht“) und Datenlücken erzeugen keine Zeile, kurze „wartet“-Episoden unter 5 min ohne Sperre oder Vorschlag werden ausgeblendet; höchstens 12, neueste oben |

**Lern-Gate und Bedarfsmodell Drift:** Die Zeilen gibt es in der Karte „Wärmefahrplan (Shadow)“ (seit dem Zusammenlegen auf der Seite „Optimierung“) unter „Details und Modell ▸“ (eingeklappt) und nur, solange ein Plan steht (`P.status` ok). Deshalb waren sie nicht zu finden. Seit 13.10. legt `opt_plan` den Lernstand zusätzlich als `OPT_plan.lern` ab (immer, auch ohne Plan: Bitmaske und Gründe von heute, verworfene Tage, CUSUM auf/ab mit Alarm, Rückfall-Sperre), die Karte „Messwerte & Lernen“ zeigt ihn als Kacheln. Die Zeilen im Wärmefahrplan bleiben unverändert (Test: gleiche Werte).

**Vorschau ohne Dashboard:** `node tools/engine_ui_preview.js [Datenordner] [Ausgabe.html]` spielt die echten Protokolle durch den Kern und zeichnet fünf Schnappschüsse (A 10.10. 08:38 mit Vorschlag, Übernahme gesperrt; B Replay-Ende ohne Vorschlag; C Hauptschalter an mit aktiver Übernahme; D 5 Tage Kälte-Szenario mit Punkten; E wie A mit Übernahme frei) in HTML-Dateien, die das Dashboard nachbilden: Raster aus `ui_base` (48/6 px), Gruppen 17 Einheiten, Masonry (höchste freie Stelle, links zuerst), Karten mit fester Höhe und innerem Scrollen wie `ui_template`, Einpassen wie `FIT_JS`; Lernstand des Wärmefahrplans mit Beispielwerten. Ein Prüfskript in der Seite meldet inneres Scrollen, abgeschnittene oder aus Kacheln ragende Elemente, waagrechtes Scrollen der Seite und überlappende Gruppen. `node tools/ui_vorschau_pruefen.js <ordner> <seite.html> … [--breiten=1024,1920,2560]` öffnet die Seiten offline in Firefox headless (WebDriver BiDi, eigenes Profil, klassische Bildlaufleisten, Netz über toten Proxy), schreibt je Breite ein PNG und gibt die Prüfung aus (Exit 1 bei einem Fehler).

## 10. Bonsai-Beobachter

`tools/bonsai_beobachter.py` nutzt nur die Standardbibliothek.

| Schritt | Was passiert |
|---|---|
| Quelle (nur lesen) | `--quelle ORDNER` mit Kopien oder `--ssh`, d. h. `ssh fl0wb0b@10.10.10.128 docker exec node_red-node-red-1 cat /data/optimizer/<datei>`; ohne Shell, Dateiname gegen ein festes Muster geprüft |
| Fakten (deterministisch) | Abdeckung und Lücken; Minuten Lauf/Pause/Heizgrenze; Läufe (Anzahl, Starts, mittel, kürzester, längster); Pausen; Strom, Wärme, COP; maximale Frequenz ab Laufminute 2; Minuten > 20 Hz bei Quiet ≥ 1; Quiet-Minuten je Stufe; Heizregelung; Soll min/max/Wechsel; Außentemperatur; Radiator-Anteil; Ereignisse (Quiet-Befehle, davon GUI, Sollsprünge, Radiator, Vorschläge, Klicks); je Raum min/max, Minuten unter Min und über Max, ungültig in %; Maschine (Datensätze, Status-Minuten je Regel, Vorschläge); Punkte je Regel und Typ; Übernahmen; Messaufgabe |
| Regel-Befunde (geprüft) | Lücken > 10 min; Maschine lief nicht durchgehend; Raum oft ungültig; Raum lange unter Minimum; > 20 Hz trotz Quiet ≥ 1; Schaden; Verpasst; Messaufgabe offen oder erledigt; Klicks; fehlende Dateien |
| Bonsai (ungeprüft) | drei kurze Fragen: Auffälligkeiten, Vergleich mit dem Vortag (`vortag.*`), Datenqualität. Antwort nur als JSON-Array |
| Bericht | `<ausgabe>/YYYY-MM-DD.md` und `<ausgabe>/befunde.json` (je Tag, 60 Tage). Standard-Ausgabe `~/Dokumente/heishamonr-optimizer/bonsai-berichte` |

Eine Bonsai-Aussage wird **verworfen**, wenn eine dieser Bedingungen zutrifft:
- sie hat keinen Beleg
- ein Beleg ist kein Fakten-Schlüssel
- eine Zahl im Text steht in keinem der genannten Belege (Toleranz 1 %)
- der Schweregrad ist unbekannt

Übrig bleiben Hypothesen mit Status „ungeprüft“. Ist Bonsai nicht erreichbar, entsteht der Bericht trotzdem, ohne Hypothesen.

Der Beobachter schreibt nie an Anlage, NAS oder MQTT. Einen MQTT-Befundkanal zur Dashboard-Karte habe ich bewusst **nicht** gebaut. Er wäre ein Schreibzugriff auf den NAS-Broker vom PC aus. Für einen reinen Anzeige-Nutzen ist mir das zu viel, die Entscheidung liegt beim Nutzer.

`tools/systemd/bonsai-beobachter.service` und `.timer` (täglich 06:20, Bericht für den Vortag) werden mitgeliefert, **nicht installiert**. Die Installation steht im Kopf der Unit. Der Dienst startet das Modell nicht.

## 11. Tests

| Befehl | Ergebnis (12.10.2026) |
|---|---|
| `cp "flows (26.5.1 stable).json" /tmp/x.json && python3 tools/optimizer_phase1.py /tmp/x.json && node tools/optimizer_sim.js /tmp/x.json` | **607 OK** (12.10. abends unverändert; vorher 605; neu am 12.10.: `OPT_plan.model` ohne und mit `coefActivate`) |
| `node tools/engine_sim.js /tmp/x.json [Datenordner]` | **12.10. abends (v5, Laufzeit strecken v2): 219 OK mit Flow-Datei ohne Daten** (vorher 206). Neu v5: Treffer bei b ≥ p = 0 ohne Skill-Beitrag, Fehlalarm bei b ≥ p = −24/−39, b < p = v4, kein Gaming, Ablauf Treffer/Fehlalarm/b < p mit gelernter Basisrate, Versionswechsel v4 → v5 mit offenem Fall, 5-Tage-Kälte (Raumeinfluss 0 statt −122), Skill-Konsistenz, Kachel „davon … neutral“; neu Regel v2: Takt belegt → Vorschlag, Heizgrenze-Stopp → keiner, 2 Starts in 3 h → Vorschlag, alter Zustand → keiner; angepasst: „Takten während Sperre“ mit vorgegebenem Takt-Beleg, „Skill ab 3 Fällen“ mit `cfg.sv = 4`, v4-Prüfungen auf die aktuelle Version. Mit `SIM_BASIS=1` zusätzlich je Sim die Fälle mit Horizonten (b, neutral/Abzug). **12.10. (v4): 206 OK mit Flow-Datei ohne Daten** (vorher 198; ohne Flow-Datei und Daten 157). Neu: Hinweis-Treffer = 0 Punkte, Hinweis-Fehlalarm mit Schaden 0 Punkte, v3 nachrechenbar (`cfg.sv = 3`, +9), Befund −14,0/−6,84 nachgerechnet, offener Fall ändert den Skill nicht, Skill erst ab 3 Fällen, Versionswechsel v3 → v4 mit offenem Hinweis-Fall, Punkte-Kachel „–“ ohne Diagramm; angepasst: Bericht (Skill bei 1 Fall „–“). Die Replay-Prüfungen brauchen die Datenkopie vom 10.10. 13:24; sie liegt nicht mehr vor (siehe Replay-Bericht, Nachtrag), mit ihr wären es 223. Mit `SIM_BASIS=1` zusätzlich die Basisraten je Regel und Horizont gegen p. Stand 11.10.: Kern, Sperren, Mehrtages-Modell, Punktesystem, Nachprüfung, Seite (Karten-Daten, Darstellung, Vorschau), Hüllen im vm, gesperrte Übernahme, Replay: **215 OK** mit Flow-Datei und Daten (ohne Flow-Datei 166; neu am 11.10.: 53 Prüfungen Vorausschau/Arbitrierung inkl. Tagesgang, „verpasst“ der Vorausschau, 8-Tage-Fake-Uhr, Kacheln ohne Abschneiden, Replay mit Gate zu und testweise offen, Hülle mit Vorhersage; angepasst: Regelzahl 5, `SCORE_VER`, Datensatzgröße 2,7 MB/Tag, 5 Kachelspalten; neu in v2: Sperre entschuldigt, Schaden Komfort/Takt zählt, verlängerte Sperre entschuldigt nicht, v1 nachrechenbar, Versionswechsel, Replay v1/v2, Kachel) |
| `BEOBACHTER_TMP=<ordner> python3 tools/bonsai_beobachter_test.py [Datenordner]` | **9 OK**, LLM nur als Mock |
| `node tools/engine_replay.js <Datenordner> [Ausgabe]` und `--md` (`--sv4` …) | Replay der echten Protokolle |
| 13.10. (Branch `todo-umsetzung`) | `optimizer_sim` **632 OK**, `engine_sim` **230 OK** (mit `replay_data` 07.–12.10.: 244 OK, 3 datensatzabhängige FAIL wie auf `0beb6b0`), `node tools/takt_sim.js <Datenordner>` **26 OK**, `node tools/kern_chain_sim.js <flows>` **15 OK** (Kern-Paket, nicht im Deploy) |
| 13.10. (Branch `ui-ueberarbeitung`) | `optimizer_sim` **637 OK** (neu: `OPT_plan.lern` auch ohne Plan und gleich den Zeilen „Lern-Gate“/„Bedarfsmodell Drift“, Rückfall), `engine_sim` **255 OK** (mit `replay_data`: 269 OK, dieselben 3 datensatzabhängigen FAIL; neu u. a. Klickweg (c2) mit 31 einzeln ablehnenden Stufen, 7 Grenzwerten, Rücklesen, Wiederholung, Rückweg ohne Endlosschleife, letzter Sicherung mit verfälschtem Kern, Karte „Messwerte & Lernen“, Knopfzustände, Seite mit fünf Gruppen zu 17), `takt_sim` **26 OK**, `kern_chain_sim` **15 OK**. Einspielen mit aktivem Knoten: Flows mit `--uebernahme-knoten-aktiv` und `UEBERNAHME_KNOTEN_AKTIV=1`: `optimizer_sim` alle bestanden, `engine_sim` 254 OK (ohne die Prüfung „wie ausgeliefert“); ohne Ansage schlagen beide an. Vorschau: `ui_vorschau_pruefen.js` mit A–E bei 1024/1920/2560 px: 0 Fehler |
| 13.10. (Branch `ui-kompakt`) | `optimizer_sim` **639 OK** (neu: Seiten 17 breit/zwei Karten je Wärmefahrplan und Quiet-Messwerte, Quiet-Statistik aufgeteilt, Statuskarten zweispaltig ohne Hinweiszeilen), `engine_sim` **255 OK**, `python3 tools/ui_kompakt_test.py <Live-Export>` **26 OK**; Vorschau `opt_seiten_vorschau.js` + `ui_vorschau_pruefen.js` bei 1024/1920/2560: 0 Fehler |
| 13.10. (Branch `tabs-zusammen`) | `optimizer_sim` **639 OK** (Seitenprüfung neu: Optimierung mit Wärmefahrplan, Optimierer mit Quiet-Karten, leere Tabs ausgeblendet, Menüplätze unverändert), `engine_sim` **255 OK** (Seite „Optimierer“: fünf Karten der Maschine, danach zwei Quiet-Karten), `python3 tools/tabs_zusammen_test.py <Live-Export>` **51 OK**; Vorschau `opt_seiten_vorschau.js` + `ui_vorschau_pruefen.js` bei 1024/1920/2560: 0 Fehler; Generator gegen Live: 6 `opt_*` geändert, 0 neu, 0 entfernt |
| 13.10. spät (Branch `quiet-freigabe-v2`, zweiter Review-Durchgang, Abschnitt 17.9) | `optimizer_sim` **639 OK**; `engine_sim` **246 OK** ohne Flow-Datei, **302 OK** mit Flow-Datei, **320 OK** mit Flow-Datei und `replay_data_1310`, **315 OK** mit `replay_data` (neu: Abschnitt (f) mit den Szenarien des Reviews für B1–B7, R1–R6 und die vorläufigen Vorgaben); `kern_chain_sim` **19 OK** (neu R5b: gehärtete Ausnahme); `takt_sim` **26 OK**; Vorschau 30 Seiten/Breiten: 0 Fehler; Generator gegen Live (2b3943e): `opt_engine`, `opt_apply` (nur `func`), 0 neu, 0 entfernt |
| 13.10. abends (Branch `quiet-freigabe-v2`, nach dem Merge von `tabs-zusammen`) | `optimizer_sim` **639 OK**; `engine_sim` **227 OK** ohne Flow-Datei, **283 OK** mit Flow-Datei, **300 OK** mit Flow-Datei und `replay_data_1310` (07.–13.10.), **296 OK** mit `replay_data` (07.–12.10.); die Replay-Prüfungen hängen jetzt am Datensatz (07.–10.10. / ab 07.–12.10. / 07.–13.10.). Neu u. a.: Abschnitt (e) Quiet-Freigabe v2 (19 Prüfungen), 8-Tage-Fake-Uhr Quiet (Shadow und Übernahme), Effizienz-Deckel 8 Tage mild, Hebel +1 K, Replay 07.–13.10. `takt_sim` **26 OK** mit `replay_data`; mit `replay_data_1310` 1 datenabhängiger FAIL („48-h-Fenster“), gleich auf 2b3943e. `kern_chain_sim` **15 OK**. Vorschau `opt_seiten_vorschau.js` + `ui_vorschau_pruefen.js` (4 Seiten) und `engine_ui_preview.js` (A–E) bei 1024/1920/2560: 0 Fehler. Generator gegen Live (2b3943e, dieselbe Flow-Datei): 2 `opt_*` geändert (`opt_engine`, `opt_apply`, nur `func`), 0 neu, 0 entfernt |
| `node tools/takt_analyse.js <Datenordner>` | Läufe mit Stopp-Art, Frequenz, Rücklauf-Rückstand, Vorlauf-Anstieg; Treffsicherheit der Vorhersage „Abschaltgrenze in ≤ 45 min“ |

Angepasste Sicherheitsprüfungen in `optimizer_sim.js` sind gezielt: Es ist **genau** `opt_apply_mqtt` erlaubt. Eine neue Prüfung verlangt:
- er ist deaktiviert (nur mit ausdrücklicher Ansage `UEBERNAHME_KNOTEN_AKTIV=1` aktiv, dann muss `opt_apply` auch `KNOTEN = true` tragen)
- er wird nur von `opt_apply` gespeist
- `opt_apply` hat nur die Eingänge Karte und Takt
- er hat einen eigenen Broker-Client
- `opt_engine` hat keinen Weg dorthin

Jeder andere `mqtt out` sowie jeder Link- und HTTP-in-Knoten im Tab bleibt verboten. `engine_sim.js` prüft an verfälschten Kopien, dass diese Strukturprüfung anschlägt. Die Funktionsliste „kennt commands/“ ist um genau `opt_engine` (nur Vorschlagstexte) und `opt_apply` erweitert.

## 12. Bekannte Grenzen und Annahmen

**Rücklauf-Schwelle der Quiet-Freigabe.** 1,5 K ist eine **Annahme**. Gemessen sind vier Punkte:
- ≤ 0,25 K: keine Reaktion.
- 1,75 K (13.10. 16:36, Quiet 2 → 1): 17 → 20–21 Hz.
- Quiet 0 bei 1,5–2,5 K: nur in 20–39 % der Minuten über 20 Hz.
- ≥ 2,5 K: volle Reaktion.

Die Wirkungsprognose wird das zeigen. Kalibrierfälle zählen nicht.

**Quiet 2/1** (Stand 13.10.):
- Quiet 2 hält bei 12–13 °C 16–17 Hz (08.10. 4 min, 13.10. 6 min) und bei 1–4 °C 20–21 Hz (12.10., 168 min).
- Quiet 1 hält bei 12 °C 20–21 Hz (13.10., 28 min); höher wurde es nicht beobachtet.
- Unter 0 °C gibt es keine Daten. Forum J: Quiet 2 bis 47 Hz bei −8 °C.
- Die Tabelle `DECKEL` ist deshalb die gemessene Untergrenze. Der gelernte Deckel (Takt-Messung) überschreibt sie nach oben.

**Kalte Außentemperatur, Abtauen, Heizstab.** Dafür gibt es keine Daten. Die Sperren sind vorsichtig gesetzt, aber ungeprüft.

**Raumregel.** Sie hängt am Raumvorschlag der Phase 2. Der flackert, weil Kinderzimmer-Werte nach 90 min als ungültig gelten (die Shelly melden nur bei Änderung).
- Im Replay entstand daraus ein „verpasst“ (v1) bzw. „verpasst während Sperre“ (v2, Stabilitätszeit): Kinderzimmer oben lag ab 09.10. 18:47 über 3 h ≥ 0,5 K unter Minimum.
- **Entscheidung des Nutzers:** Datenalter-Limit für die Gen3-Sensoren auf ~360 min setzen?

**Laufzeit strecken (Regel v2, 12.10.; seit 13.10. Regel v4 „Deckel/Laufzeit“, Abschnitt 17).** Befund mit `node tools/takt_analyse.js <Daten>` (07.10. 16:55 bis 12.10. 17:44, 21 abgeschlossene Läufe):

| Größe | Wert |
|---|---|
| Abschaltung über den Vorlauf (Vorlauf ≥ Soll +2,75 K in der letzten Laufminute) | 18 Läufe, 97–970 min, Median 148 min; gemessen immer +3,0 oder +3,25 K |
| Takte (Abschaltung über den Vorlauf nach < 60 min) | **0** |
| Läufe < 60 min | 2, beide an der Heizgrenze (Außentemperatur 14–15 °C, Pumpe danach aus): 08.10. 00:10, 40–45 min, Ende Soll +0,5 K; 10.10. 11:18, 32–33 min, Ende Soll −0,75 K |
| Starts in 3 h | höchstens 1 |
| Dauer nach Außentemperatur (Abschaltung über den Vorlauf) | ≤ 7 °C: 322–970 min; 8–10,5 °C: 97–261 min (Median 148); 11–13 °C: 116–184 min (Median 134) |
| Quiet 0 gegen Quiet 3 | Median 143 min (7 Läufe, Ø 10,1 °C) gegen 148 min (11 Läufe, Ø 9,3 °C): kein Unterschied |
| ≥ 22 Hz bei Quiet 0 ohne Boost | 4 Läufe (10.10. 14:50, 23:14; 11.10. 02:28, 11:32), je 21–44 min ≥ 22 Hz nach Pausen von 65–179 min; die Läufe dauerten trotzdem 113–204 min. Die Frequenz fällt von selbst auf 16–17 Hz, sobald der Rücklauf sein Ziel erreicht |
| Rücklauf-Rückstand Minute 15–30 | trennt nicht: die kürzesten Läufe (97–119 min) hatten −1,28…+0,33 K, die langen −0,55…+1,83 K |
| Vorhersage „Abschaltgrenze in ≤ 45 min“ (v1) | 990 Laufminuten, Stopp binnen Vorhersage + 15 min in 375; bei ≥ 22 Hz nur 5 von 96 Minuten; ohne Bedarf vorhergesagt 18–45 min, tatsächlich 36–156 min |

Was kurze von langen Läufen unterscheidet, ist vor allem die Außentemperatur (Bedarf) und der Vorlauf-Anstieg am Ende des Laufs (0–3,5 K/h), nicht Quiet, Frequenz oder Rücklauf-Rückstand. Der einzige v1-Vorschlag (10.10. 15:39, Fehlalarm −24) stützte sich auf die unzuverlässige Vorhersage und auf „letzter Lauf nur 33 min“, der an der Heizgrenze endete.

**Regel v2:** Takt belegt = letzter Lauf mit Abschaltung über den Vorlauf (`thermoStoppK` 2,75 K) kürzer als 60 min oder ≥ 2 Starts in 3 h. Die Vorhersage steht nur noch im Text. `S.runs` führt die Stopp-Art (`[Beginn, Dauer, 1/0]`); ältere Einträge ohne Stopp-Art gelten nicht als Beleg (vorsichtig). Replay: 0 Vorschläge statt 1 Fehlalarm; 137 Minuten „kein Takt belegt“, in denen alle anderen Bedingungen erfüllt waren. Ein echter Takt kam in den Daten nicht vor, der Auslöser ist deshalb nur in der Sim geprüft (Tests: Takt belegt → Vorschlag, Heizgrenze-Stopp → keiner, 2 Starts in 3 h → Vorschlag, alter Zustand → keiner).

**Die Regel ruht bei Quiet 3 von Hand** (4266 von 7250 Replay-Minuten). Das ist gewollt: ihr einziger Hebel ist Quiet, und der steht dann schon. Ein zweiter Hebel wäre die Heizkurven-Verschiebung, siehe Entwurf unten.

**Entwurf vom 12.10.: „Laufzeit strecken über Heizkurve +1 K“** (seit 13.10. als Hebel von v4 gebaut, Abschnitt 17.3; die Risiken unten gelten weiter). Idee: bei Quiet 0 (oder Quiet 3 von Hand, dann ist es der einzige Hebel) die Verschiebung auf +1 K, solange Takt belegt ist. Die Verschiebung hebt Stopp- **und** Startschwelle um 1 K (Handbuch: Stopp bei Vorlauf − interner Soll > 2 K für 3 min, Leisha gemessen Soll +3,0…+3,25 K; Start 6–13 min nach Vorlauf < Soll −3,25 K, Handbuch: Vorlauf < gespeicherter Rücklauf −3 K).

| Größe | aus den Daten 07.–12.10. (18 Läufe mit Abschaltung über den Vorlauf) | Folge von +1 K (Schätzung) |
|---|---|---|
| Vorlauf-Anstieg in den letzten 30 min vor dem Stopp | 0–3,5 K/h, Median 1,5 K/h (≤ 7 °C: 0–1 K/h) | Lauf **+20…60 min** (1 K / Anstieg), bei ≤ 1 K/h Dauerlauf bis sich der Bedarf ändert; passt zu „+40–60 min je Lauf“ aus den Sollsprüngen 07.–10.10. |
| Zeit von Soll −2,25 K bis Soll −3,25 K in der Pause | 11–67 min, Median 18 min | Pause **−11…67 min** (Median −18 min), weil der Start 1 K früher kommt |
| Zyklus bei 8–10 °C | Lauf 135–190 min + Pause 66–74 min | z. B. 135 + 74 → ~175 + 56 min: Starts je Tag ~6,9 → ~6,2 (−10 %) |
| Strom | Vorlauf +1 K | +2,5–3 % (8,5 W/K), COP etwas schlechter |
| Räume | mehr Wärme je Zyklus | wärmer; 10.–11.10. lagen Wohnzimmer/Kinderzimmer unten mehrfach über Maximum (Raumeinfluss −1 K) |

Entwurf der Bedingungen: Quiet 0 oder 3 · Takt belegt (wie Regel v2) · Lauf ≥ 15 min · kein Raum über Maximum − 0,3 K · Verschiebung 0 und frei (Arbitrierung: Größe `shift`, Priorität nach Raumeinfluss, Komfort-Notfall in Gegenrichtung beendet sie) · nicht bei Handeingriff/Sanftanlauf/Nachtabsenkung · 10 min am Stück. Rückweg: nach zwei Zyklen ohne Takt, sobald ein Raum über Maximum steigt, spätestens nach 6 h. Prognose: „mit +1 K dauert der nächste Lauf ≥ 60 min“.

Risiken: (1) **nichts zu beheben**: in den Daten gab es keinen Takt, die Regel hätte nie ausgelöst; (2) **Gegenspieler Raumeinfluss**: +1 K heizt, genau in milden Lagen, in denen die Räume eher zu warm sind, das erzeugt Hin und Her mit −1 K (Arbitrierung verhindert es, aber dann wirkt die Regel nicht); (3) die Pause wird kürzer, der Gewinn an Zyklen ist kleiner als die Laufverlängerung vermuten lässt (geschätzt −10 % Starts); (4) Mehrverbrauch +2,5–3 %; (5) **Wirkung nicht gemessen**: ob die Stoppschwelle am angezeigten oder an einem internen Soll (+1 K?) hängt und wie sich der Startverzug verschiebt, zeigt erst der Verzögerungstest; vorher wäre jede Prognose eine Annahme. Empfehlung: erst bauen, wenn Takte (< 60 min mit Abschaltung über den Vorlauf) tatsächlich auftreten und der Verzögerungstest die Schwellen bestätigt.

**Heizgrenze-Hinweis.** Die Bewertung ist ein Stellvertreter: „Räume bleiben ≥ Minimum + 0,5 K“.
- Die Reserve von 0,5 K ist eine **Annahme**.
- Die Hysterese bei Einstellung 10 ist eine **Annahme**, analog zu 12/15.

**Raumwirkung von ±1 K** ist nicht gemessen. Es gab keine Sollverschiebung im Datensatz, deshalb wird nur „Soll folgt“ als Wirkung bewertet.

**Datensatzmenge.** ≈ 2,1 MB pro Tag. Die Monatsdateien wachsen auf ≈ 63 MB. Älteres bei Bedarf von Hand packen.

**Seite „Optimierer“.** Die Neufassung ist nur als statische Vorschau (Firefox headless, 1000 px) angesehen, nicht im Node-RED-Dashboard. Nach dem Deploy die Breiten 1024–2560 px prüfen, wie bei den anderen Seiten; die Episodenliste beginnt nach dem Deploy leer (alte Einzelzeilen werden nicht übernommen).

**Nachprüfung 10.10. abends (behoben, je mit Test):**
- Rücklese-Timeout einer Übernahme, bei dem die Anlage nachweislich auf dem Ausgangswert blieb, ließ die Übernahme „aktiv“ stehen. Danach lehnte jeder weitere Klick für dieselbe Größe ab („schon eine Übernahme aktiv“), bei der Quiet-Freigabe ohne Ablaufzeit dauerhaft. Jetzt endet sie dort mit Warnung; bei einem dritten Ist-Wert bleibt sie aktiv (Zurücksetzen möglich).
- Der Rückweg der Raumregel kam bei der ersten Minute mit Raumvorschlag 0. Der Raumvorschlag flackert (Kinderzimmer-Werte nach 90 min ungültig), eine Minute 0 hätte eine 60 min lang abgewartete Verschiebung zurückgenommen. Jetzt erst nach 15 min am Stück.
- Heizstab- und Heizgrenze-Einstellungen galten nur 30 min nach der letzten HeishaMon-Meldung. Melden sie sich nur bei Änderung, wäre die Heizstab-Sperre still ausgefallen und der Heizgrenze-Hinweis „nicht zuständig“ geworden. Jetzt gilt der letzte Wert 24 h.

**Bewertungsregeln v2 (10.10. abends).** Geänderte Knoten für den Deploy: `opt_engine`, `opt_apply` (Kern) und `opt_t_eng_prop`, `opt_t_eng_rules`, `opt_t_eng_score`, `opt_t_eng_log` (eingebettete Darstellung). Der Zustand bleibt erhalten; die v1-Summen bleiben unter ihrem Schlüssel stehen, Kachel und Diagramm beginnen für v2 bei 0. Die Grenze 1 K für „Komfortverlust über das Maß“ ist eine Annahme.

**Vorausschau (11.10.).** Geänderte Knoten für den Deploy: `opt_plan` (legt `OPT_plan.model` ab, sonst unverändert), `opt_engine`, `opt_apply`, `opt_t_eng_prop`, `opt_t_eng_rules`, `opt_t_eng_score`, `opt_t_eng_log`. Der Zustand bleibt erhalten (`S.arb` wird ergänzt, ein laufender Raum-Vorschlag wird als Eigentümer eingetragen).
- Schwellen sind **Annahmen**: 2 K Bedarfsänderung, Fenster +2…+5 h, Luft im Band 0,3 K, Haltezeit 30 min, Gültigkeit/Pause 180 min, Mindesthaltezeit 60 min, Wartezeit Gegenrichtung 240 min, Notfall 0,3 K.
- Tagesgang: in der ersten Fassung (Fenster gegen jetzt) schlug die Regel in der Fake-Uhr fast jeden Nachmittag +1 K vor (abends kälter). Seit der Bereinigung um den Tagesgang (siehe 4a) schlägt sie in der 8-Tage-Sim nur noch beim Kälteeinbruch vor (11-05 20:46, +1 K, Rückweg 00:31). Die Milderung bringt kein −1 K, weil der Raum danach am unteren Bandrand liegt (Luft-Bedingung); der Raumeinfluss übernimmt dort. Im Replay 07.–10.10. gibt es mit der Standardeinstellung keinen sicheren Tagesgang (höchstens 2 Vortage), also keine Bedarfsänderung und keinen Vorschlag; testweise mit einem Vortag kommen ebenfalls keine Vorschläge, weil dann immer ein Raum außerhalb des Bandes oder ungültig war.
- Replay: Abrufzeit der Vorhersage = Zeile − `wetter_alter_min`, Stützpunkte jetzt/+1/+3/+6 h (Annahme, siehe `ASSUME` in `engine_replay.js`).
- Datensatz: die Vorhersage steht im Schnappschuss (`in.vs`), damit Minuten nachspielbar bleiben; zusammen mit der fünften Regel ≈ 2,6 MB/Tag (≈ 78 MB/Monat statt 63).
- Seite: fünf Kacheln mit kurzen Namen; statische Vorschau bei 1024, 1920 und 2560 px mit Prüfskript: 0 abgeschnittene Elemente (die Gruppe ist im Dashboard fest 966 px breit). Im echten Dashboard noch nicht angesehen.

**Bewertungsregeln v4 (12.10.).** Geänderte Knoten für den Deploy: `opt_engine` und `opt_apply` (eingebetteter Kern bzw. Kern + Anzeige). Die vier Vorlagen `opt_t_eng_*` sind unverändert (`eng_ui.js` unverändert). Der Zustand bleibt erhalten: die v3-Summen bleiben unter `…|s3` stehen, Kachel und Diagramm beginnen für v4 bei 0, die Heizgrenze-Kachel zeigt „–“. Offene v3-Fälle enden mit v3.

**Bewertungsregeln v5 und Laufzeit strecken v2 (12.10. abends).** Geänderte Knoten für den Deploy: `opt_engine` und `opt_apply` (eingebetteter Kern bzw. Kern + Anzeige). Die vier Vorlagen `opt_t_eng_*` sind unverändert (`eng_ui.js` unverändert; die Kennzahl „davon … neutral“ kommt aus `engine_view.js` in `opt_engine`). Der Zustand bleibt erhalten: v4-Summen unter `…|s4`, v5 beginnt bei 0; offene v4-Fälle enden mit v4. „Laufzeit strecken“ v2 zählt unter `quiet_strecken|v2|s5` neu; Läufe aus dem alten Zustand haben keine Stopp-Art und gelten nicht als Takt-Beleg, bis der erste neue Lauf endet.

**Entschieden 12.10.: Weg (b), umgesetzt als Bewertungsregeln v5** (Abschnitt 6). Die frühere Darstellung der offenen Entscheidung bleibt zur Nachvollziehbarkeit stehen:

**(Früher offen) Prognose p unter der Basisrate (Befehlsregeln).** Ein Treffer bringt nur Punkte, wenn p > b; liegt die feste Prognose p unter der Basisrate „bleibt, wie es ist“, kostet jeder Treffer Punkte, je sicherer die Lage, desto mehr. Das ist bei Befehlsregeln nicht eindeutig falsch (das Brier-Prinzip will genau das: eine Prognose, die schlechter ist als „bleibt so“, hat keinen Skill), aber es bestraft eine Regel, die nur in eindeutigen Lagen vorschlägt. Gemessen (`SIM_BASIS=1`, Teil-Replay):

| Regel (p) | Basisrate b je Horizont | Folge |
|---|---|---|
| Raumeinfluss (0,7) | Teil-Replay 07.–09.10.: 0,84 / 0,78 / 0,50; 8-Tage-Sim 0,93 / 0,89 / 0,78; 5 Tage kälter 0,99 | Treffer 09.10. 10:02 −3,59; 5 Tage kälter: 14 Treffer, 0 Fehlalarme, **−122 Punkte**, Skill −32,9 |
| Quiet-Freigabe (0,8) | Teil-Replay 0,13–0,20 (milde Tage, Kaltstarts lösen sich selbst); 3 Tage Boost 0,85 / 0,81 / 0,50; 5 Tage kälter 0,98–0,99 | 5 Tage kälter: 15 Treffer, 0 Fehlalarme, **−71 Punkte**; mild: +14 bzw. +17,6 |
| Vorausschau (0,6) | 8-Tage-Sim 0,17–0,21 | keine Falle in der Sim (Gate live zu) |
| Laufzeit strecken (0,7) | keine Vergleichslage in Replay und Sims | unbekannt |

Mögliche Wege (je eine neue Bewertungsversion; gewählt wurde (b)): (a) p je Regel/Horizont höher ansetzen (Annahme, wieder fest; bei b → 0,99 bleibt die Falle); (b) Treffer bei b ≥ p neutral zählen („keine Trennschärfe messbar“), Fehlalarme weiter voll; (c) p aus der eigenen Trefferquote der Regel lernen ((k + 1)/(n + 2), wie b) und nur die Trennschärfe gegen b punkten; (d) Raumeinfluss nur über die Wirkung bewerten (braucht Übernahmen). Der Replay-Bericht (Punkt 6) hatte schon festgehalten, p erst nach 14 Tagen Live-Daten neu festzulegen.

**Ergebnis v5 (Replay 07.10. 16:55 bis 12.10. 17:44, Regel „Laufzeit strecken“ v2, Entscheidungen in v4 und v5 identisch):**

| Regel | v4 | v5 | Anmerkung |
|---|---|---|---|
| Quiet-Freigabe | 0,00 (1 Fall neutral) | 0,00 | Eingriff durch den Nutzer |
| Laufzeit strecken | 0,00 (Regel v1: −24,00) | 0,00 | Regel v2: kein Vorschlag |
| Raumeinfluss | −9,74, Skill −0,09 | **−23,49**, Skill −0,49 (4 Fälle mit Beitrag) | 6 Treffer, davon 4 ganz neutral; der Fehlalarm 10.10. 10:26 kostet jetzt −19,52 statt +12,63, der 240-min-Horizont 11.10. 09:10 −8,00 statt +0,95 |
| Heizgrenze-Hinweis | – | – | nur Hinweis |
| Vorausschau | 0,00 | 0,00 | Gate zu |

5-Tage-Kälte-Sim: Raumeinfluss 14 Treffer **0** (v4 −122,3), Quiet-Freigabe 15 Treffer **−19** (v4 −71,2; der erste Fall +21 vor dem Lernen der Basisrate, 14 neutral, Minus nur aus einzelnen Fehl-Horizonten −13). 8-Tage-Sim (Verschiebung, Shadow): Raumeinfluss 0 (+16, 0, 0, −16), Vorausschau −23,67 (1 Fehlalarm vor dem Lernen der Basisrate, unverändert).

**Neue offene Entscheidungen aus v5:**
1. **Höhe des Fehlalarm-Abzugs bei b ≥ p.** Gewählt: gegen b = 0,5 (p 0,7 → −24). Das ist bei b = p unstetig (knapp darunter kostet ein Fehlalarm fast 0, darauf −24). Raumeinfluss im Replay: gewählt −23,5; wörtlich „Brier wie bisher“ (Fehlalarm bei b > p als Plus) +17,5; stetige Variante −|Brier| (Abzug wächst mit b − p) −16,7. Die Plus-Variante belohnt Fehlalarme und widerspricht „voll im Abzug“.
2. **Freigabereife und Skill.** Neutrale Treffer tragen nicht zum Skill bei. In Dauer-Lagen (b > p an allen Horizonten, z. B. Raumeinfluss 14 Treffer in der Kälte-Sim) bleibt der Skill „–“, das Kriterium „Skill ≥ 0,2“ ist dort nie erfüllbar; positiv werden kann er nur aus Horizonten mit b < p, ein Fehlalarm bei b ≥ p drückt ihn stark (Replay Raumeinfluss −0,49). Der Skill ist damit konsistent mit den Punkten, aber die Freigabereife einer Regel, die meist in eindeutigen Lagen vorschlägt, hängt an wenigen Horizonten. Vorschlag (nicht gebaut): Kriterium „Skill ≥ 0,2 **oder** (≥ 10 Treffer-Fälle neutral, 0 Fehlalarme bei b ≥ p und ≥ 2 Wirkungsfälle > 0)“ – die Wirkung kommt erst mit Übernahmen.
3. **p neu festlegen** nach 14 Tagen Live-Daten bleibt sinnvoll; mit v5 verliert eine zu niedrige p aber ihren Schaden.

**Zeitzone.** Wie im übrigen Optimierer ist sie die Ortszeit des Containers. Die Sim läuft mit Europe/Berlin, auch über die Zeitumstellung am 25.10.

## 13. Umsetzung TODO A–H (13.10.2026, Branch `todo-umsetzung`)

**Nutzerentscheidungen 13.10.2026:** Quiet und Comfort/Efficiency richten sich nach der gemessenen Effizienz (keine feste Quiet-0-Regel mehr). Mindestdaten je Kombination Modus × Quiet × Außenband: 60 min (vorläufig). Sonne `bs` ≤ 0,5, Wind `bw` ≤ 0,0125 kWh/(K·m/s·h), Wind erst über 4 m/s. „Laufzeit strecken“ auch aus Quiet 1/2.

| Punkt | Was | Wo |
|---|---|---|
| A Sonne/Wind | `coefSafe()` begrenzt `bs`/`bw` vor jeder Nutzung (Plan, Kandidat, `OPT_plan.model`, Vorausschau); Gate kennt „negativ“, „nicht endlich“, „unplausibel“; Hysterese endet bei hartem Fehler; Sonnenterm bei gleichförmigen PV-Tagen eingefroren. Wind-Merkmal `max(0, v − 4)` in Tagessummen (Tageseintrag 13/14), Fit, Plan und Vorausschau (`VS_LIM`); Modellversion 2: alte Koeffizienten werden neu gerechnet, ihr „aktiv“ nicht übernommen | `opt_plan`, `engine_core` |
| C Takt-Messung | entprellter Start-Zähler, Pausen-Typen, Mindestleistung je 2-K-Band (laufendes Minimum von warm nach kalt), COP je Heizregelung × Quiet × Außenband über 30 Tage; Schwellen mit Herkunft in `TAKT_SCHWELLEN` (`cfg.takt`, Tabelle oben); einmaliges Nachladen aus `quiet-YYYY-MM.csv` (Vormonat und Monat, stückweise ≤ 4 MB bzw. 300 ms je Minute); Datensatz `abl.tk` nur bei Änderung/zur vollen Stunde | `engine_core`, Hülle `opt_engine` |
| Laufzeit strecken v3 | Auslöser wie v2 (belegter Takt); Zielstufe = höhere Stufe mit dem besten COP (≥ 60 min Daten für jetzige und Zielstufe, deckelt nachweislich < 22 Hz, COP höchstens 3 % unter der jetzigen); ohne Daten kein Vorschlag und kein „verpasst“; Rückweg auf die vorherige Stufe | `engine_core` |
| B Lern-Hygiene | Plausibilitätsbereiche je Eingang (Plan und Maschine, außerhalb = fehlend); Tages-Gate: Warmwasser > 120 min, Abtauen > 90 min, Datenlücke > 60 min, Eingriff > 60 min, unplausibel > 60 min → Tag lernt nicht mit (Tageseintrag 15–20); Drift des Plan-Modells als CUSUM auf den A/B-Tagen | `opt_plan` („Lern-Gate“, „Bedarfsmodell Drift“ unter „Details und Modell“; seit 13.10. auch `OPT_plan.lern` → Karte „Messwerte & Lernen“) |
| D Validierung | Überanpassungs-Quote Test/Training > 1,5 als Gate-Grund; Schnappschuss-Ring der aktiven Lernwerte; Rückfall: CUSUM auf (\|q−k\| − \|q−b\|)/Streuung, bei Alarm Kandidat aus und 7 Tage gesperrt | `opt_plan` |
| E Auswertung | Wirkzeit Raum (Idee ClimateOptimizer `lag.py`, ereignisbasiert); Heizkurven-Bias (tvofi `curve_learning.py`: −0,2 K nach 3 Tagen mit ≥ 0,3 K Luft, Komfortmiss → 0); beide nur Anzeige | `engine_core` (seit 13.10. Karte „Messwerte & Lernen“, vorher Zeilen in „Punkte“) |
| H | beobachtete Heizgrenze (Außentemperatur am Ende von Läufen ≥ 30 min, 7 Tage) | `engine_core` |
| G Kern-Robustheit | **vorbereitet, nicht im Deploy:** `tools/kern_patch.py` (Ist/Soll-Abgleich nur nach unten, Filter-Platzhalter, Summenfunktion jede Minute), `tools/kern_chain_sim.js`; Bericht `repo-analyse/kern-robustheit.md` | Kern-Tabs nur mit Go |

Befunde aus den Echtdaten 07.–12.10.:
- Takt: keine Minutenpausen, Pausen 57–142 min, Läufe 113–970 min.
- Mindestleistung 1,70–1,76 kW.
- COP Efficiency: 7–11 °C Quiet 0 5,91 gegen Quiet 3 6,15; 11–15 °C 6,89 gegen 6,76.
- Laufzeit strecken v3: 0 Vorschläge, weil kein Takt belegt war.
- Drift: CUSUM 3,8 von 4 (Ist 30,0/36,0 kWh gegen Plan-Modell 19,7/31,1 kWh am 11./12.10.).
- Wirkzeit: je 2 von 3 nötigen Ereignissen.
- Heizkurven-Bias 0: an keinem Tag ≥ 0,3 K Luft in allen Räumen.
- Heizgrenze beobachtet: Ø 10,6 °C, höchstens 15 °C (21 Läufe).

## 14. Seite „Optimierer“ überarbeitet, Klickweg geprüft (13.10.2026, Branch `ui-ueberarbeitung`)

Befunde auf der Live-Seite (1920 px) und was daraus wurde:

| Befund | Änderung |
|---|---|
| Mess-/Lernzeilen in „Punkte“, „Punkte“ und „Entscheidungen“ scrollen innen | eigene Karte „Messwerte & Lernen“ (gleich breit, unter „Punkte“); Karten passen sich nach jedem Zeichnen sofort ein (Ursache sehr wahrscheinlich: der 1,5-s-Takt von `FIT_JS` ruht bei verdecktem Fenster, dann blieben die Starthöhen 3/6/4 stehen; die Karte „Entscheidungsmaschine“ war genau 3 Einheiten = 156 px hoch); Starthöhen 4/3/9/10/12 passen auch ohne Einpassen |
| „COP je Modus/Quiet“ als Fließtext | Matrix Außenband × (Modus, Quiet), grau unter 60 min, bester Wert je Zeile grün, „?“ weggelassen |
| „Mindestleistung“ als Fließtext | Zellen „Band über Wert“ (optChart ist eine Zeitachse, für Bänder ungeeignet) |
| Wirkzeit, Heizkurven-Bias kryptisch | Kennzahl + Status-Chip („sammelt“ 0/3 Ereignisse bzw. 1/3 Tage, „gemessen“, „Absenkung“), Einzelheiten im Tooltip |
| Leerraum in der Statuskarte | Karte „Aktueller Vorschlag“: mit Vorschlag Befehl, Zielwert, Begründung, Wirkung, Rückweg, Knopf mit Grund; ohne Vorschlag letzter Vorschlag, letzte 24 h, Übernahme-Stand |
| Karten nur 966 px breit | 17 Einheiten, zwei Spalten ab ~1840 px (Abschnitt 9) |
| „Lern-Gate“, „Bedarfsmodell Drift“ nicht gefunden | stehen im Wärmefahrplan eingeklappt unter „Details und Modell ▸“ und nur mit Plan; jetzt auch als Kacheln in „Messwerte & Lernen“ über `OPT_plan.lern` |

**Klickweg (Prüfung auf Vollständigkeit):** Jede Stufe der Prüfkette ist einzeln getestet (alle anderen erfüllt), dazu Grenzwerte, Rücklesen, Wiederholung, Rückweg, die letzte Sicherung der Hülle und das Lesen von `apply.json`. Dabei gefunden und behoben (Kern, `opt_apply`, `opt_engine`):
1. Ein unbestätigter Rückweg startete nach 3 Versuchen alle 4,5 min neu (alter Kern: 76 Befehle in 2 h, ~900 am Tag). Jetzt Schluss nach 3 Versuchen mit roter Warnung, „Zurücksetzen“ von Hand bleibt, nachträgliche Bestätigung oder fremde Änderung beendet die Übernahme.
2. Ein unmöglicher Rückweg (Ausgangswert außerhalb der Whitelist) meldete sich in jedem 15-s-Takt (Protokoll-Rauschen). Jetzt einmal; ein Klick mit solchem Ausgangswert wird schon abgelehnt.
3. Mit `apply.json` an, aber deaktiviertem Sendeknoten meldete ein Klick „gesendet“ und lief in den Rücklese-Timeout. Jetzt kennt `opt_apply` den Generator-Schalter (`KNOTEN`) und lehnt ab; die Karte zeigt es.

**Geänderte Knoten für den Deploy (Diff gegen Live 86f3604, nur `opt_*`):** `opt_engine` (Kern, Anzeige, Ausgang 6), `opt_apply` (Kern, `KNOTEN`, `OPT_apply` mit `day`/`lastSend`/`knoten`), `opt_plan` (`OPT_plan.lern`), `opt_t_eng_prop`, `opt_t_eng_rules`, `opt_t_eng_score`, `opt_t_eng_log`, neu `opt_t_eng_mess`, die Gruppen `opt_g_eng_prop`/`_rules`/`_score`/`_log` (17 breit, „Aktueller Vorschlag“) und neu `opt_g_eng_mess`. Zustand bleibt erhalten; die Episodenliste behält alte Ende-Texte. Ein Seitentitel- oder Gruppenwechsel braucht im Dashboard eventuell einmal Neuladen; der neue Stil ersetzt den alten ohne Neuladen (`data-v`).

**Einspielen mit aktivem Übernahme-Knoten** (nur nach dem Go des Nutzers): `deploy_opt_genargs.patch` (Umgebungsvariable `GEN_ARGS`, siehe Abschnitt 8 „Freigabe“) und `apply.json.vorschlag` liegen in `~/Dokumente/heishamonr-optimizer/`; `deploy_opt.sh` selbst ist unverändert.

## 15. Kompaktere Seiten (13.10.2026, Branch `ui-kompakt`)

**Optimierungs-Seiten (Generator, nur `opt_*`):** alle Karten 17 Einheiten breit (`OPT_W`, wie `ENG_W`): zwei Spalten ab ~1840 px, eine Spalte bei 1024 ohne waagrechtes Scrollen, keine gemischten Breiten (Masonry-Falle).
- Optimierung: Diagramme je 6 Einheiten (Paneele 150/72, 236, 150/70 px), Raumkarte mit **einer** Tabelle für Lage und Einstellungen; die Raum-Diagrammkarte ist mindestens so hoch wie die Wärmepumpen-Karte, damit links Wärmepumpe + Außentemperatur und rechts Räume + Raumkarte stehen.
- Wärmefahrplan: Plan-Karte (Kacheln, Diagramm, Details) und eigene Karte „Stundenübersicht“ (`opt_g_plan_tab`/`opt_t_plan_tab`, gleiche Nachricht über `opt_plan` Ausgang 1).
- Quiet-Messwerte: die 17 Spalten auf zwei Karten (`opt_t_qstats` Leistung, `opt_t_qstats2` Temperaturen und Takt, beide an `opt_quiet` Ausgang 2; Stufe/Außen in beiden).
- Daten & Güte: Statuskarten zeigen die Paare in zwei Spalten (`column-count:2`), die Ereignisliste der Quiet-Karte ist einzeilig.
- Erklärende Hinweiszeilen gibt es auf diesen Seiten nicht mehr; die Texte stehen als Tooltip (`title`) an Tabelle bzw. Überschrift.
- Vorschau: `OPT_UI_DUMP=dump.json node tools/optimizer_sim.js flows.json` sammelt je Vorlage die größte Nachricht; `node tools/opt_seiten_vorschau.js flows.json dump.json <ordner> [Datenordner]` baut die Seiten aus den echten Vorlagen (seit Abschnitt 16: Optimierung, Optimierer ohne/mit Vorschlag, Daten & Güte) (kleiner Angular-Ersatz, Verläufe aus `optimizer-v2-*.csv`), `node tools/ui_vorschau_pruefen.js <png-ordner> <ordner>/*.html --breiten=1024,1920,2560` prüft sie.

**HeishaMoNR-Kernseiten (`tools/ui_kompakt_patch.py`, nicht im Generator):** ändert nur Darstellungs-Eigenschaften (Widgets `width/height/order/group`, Gruppen `width/order/tab`, Hilfetexte `format`), jede Änderung mit erwartetem Altwert, Whitelist-Prüfung auf dem Ergebnis, `--dry-run`/`--apply`/`--revert` (Sicherung, byte-gleich), optional `--raster`. Ausblenden = Gruppe auf den versteckten Tab GUI bzw. Widget in die Gruppe „Ausgeblendet (Warmwasser)“ dort; Zone 2 (unbenutzt) ausgeblendet, Kopfzeilen-Gruppen aufgelöst (Knöpfe in die Inhaltsgruppe), reine Stil-Vorlagen auf 0×0, Trennbalken zwischen Diagrammen ausgeblendet, Diagramme 5–6 statt 7–8 Einheiten, Effizienz in zwei Spalten, Hilfetexte in `<details>` (passen sich beim Aufklappen an). Das eingebaute Layout-Modell (Packung je Gruppe + Masonry wie node-red-dashboard 3.x) trifft die Live-Vermessung vom 13.10. auf allen 11 Kernseiten. Prüfung: `python3 tools/ui_kompakt_test.py <Live-Export vor dem Patch>`.

## 16. Tabs zusammengelegt (13.10.2026, Branch `tabs-zusammen`)

16 sichtbare Seiten → 11. Maßstab (Hauptagent): bei 1920 px möglichst keine Seite deutlich über ~1400 px, Gruppen nebeneinander, nichts abgeschnitten, 1024 px ohne waagrechtes Scrollen. Der Träger-Tab einer neuen Seite behält ID und Menüplatz, die eingegliederten Tabs bleiben **leer und ausgeblendet** (nicht gelöscht: Lesezeichen `#!/n` zeigen weiter auf dieselbe Stelle, `deploy_opt.sh` verlangt „nichts entfernt“, ein späterer Rückbau bleibt einfach).

| Neue Seite | Inhalt | Höhe 1920 px (vorher) |
|---|---|---|
| Heizung | Heizkurve \| Raumregelung (je 17), Automatisierungen und Hilfen 17 | 930 (930 + 930) |
| Betrieb | Pumpendrehzahl \| Sanftanlauf (je 17), Erweitert/Leisemodus 6 (ohne Überlappung geprüft) | 876 (552 + 876), höchstens 1308 mit „Erweitert“ |
| Auswertung | Temperaturen \| Gradtage (je 17) | 1200 (1200 + 768) |
| Optimierung | Verläufe, Raumkarte, darunter Wärmefahrplan + Stundenübersicht | Modell 1416–1524 (822 + 660) |
| Optimierer | fünf Karten der Maschine, darunter die zwei Quiet-Statistik-Karten | Modell 1470–1524 (1038 + 552) |

Unverändert: Übersicht, Einstellungen, Zeitplan (28 breit, scrollt bei 1024 waagrecht), Effizienz, Daten & Güte, SYSTEM. Verworfen (Modell): Einstellungen + Pumpendrehzahl + Sanftanlauf (gemischte Breiten 8/16 überlappen; ohne Überlappung nur, wenn die Kern-Einstellungen unter die Funktionen rutschen, ~1416 px), Temperaturen + Effizienz + Gradtage (≥ 2118 px), Optimierer + Wärmefahrplan (1632–2118 px), Optimierung + Daten & Güte + Quiet (2334–2496 px), Daten & Güte + Quiet (1524–1740 px).

**Verweise:** Das Dashboard schaltet Gruppen über `"<Tab>_<Gruppe>"` (Leerzeichen → `_`). Umgeschrieben (jeweils mit erwartetem Altwert): 21 Knopf-/Inject-Nutzlasten (Heizkurve_*, Raumregelung_*, Sanftanlauf_*, Temperaturen_Help, Gradtage_Help), das Menü-Formular SYSTEM > MENÜ-KONFIGURATION (`e35b7df78bc6f722`: Haken = Tabnamen) und `fixTabs()` in „Store settings“ (`5a44b5cc5e9f4844`: gespeicherte Menü-Konfiguration → neue Tabnamen, zusammengelegt = sichtbar, wenn eine alte Seite sichtbar war; ohne diese Änderung würde das Wiederabspielen beim Verbinden den leeren Tab „Raumregelung“ wieder einblenden). Gruppen auf derselben Seite eindeutig benannt (Heizkurve, Raumregelung, Hilfe Heizkurve, Hilfe Raumregelung, Pumpendrehzahl, Sanftanlauf, Hilfe Sanftanlauf, Hilfe Temperaturen, Hilfe Gradtage). Keine Tab-Indizes, keine Link-Knoten mit Tabnamen; Tabwechsel per Name nur zu SYSTEM/GUI/GUIAutoStartDHW/Power (unverändert). Die Optimierer-Vorlagen nutzen keine Tabnamen (nur Kommentare und Meldungs-Topics). Schon vorher ohne Ziel und unverändert: `Heizkurve_Zone2`, `Raumregelung_Zone2` (Zone 2 seit ui_kompakt auf GUI), `CCC_Graph`, `WAR_Help`, `COOL_Help`, `Solar_*`.

**Werkzeuge:** Optimierer-Seiten im Generator (`opt_g_plan`/`opt_g_plan_tab` auf `opt_ui_tab` Reihenfolge 5/6, `opt_g_qstats`/`opt_g_qstats2` auf `opt_eng_ui_tab` 6/7 mit `ENG_W`, `opt_ui_tab_plan`/`opt_ui_tab_quiet` ausgeblendet). Kernseiten mit `tools/tabs_zusammen_patch.py <flows> --dry-run | --apply --out neu.json --sicherung s.json | --revert --sicherung s.json` (Whitelist: Tab name/hidden, Gruppe tab/name/width/order, Widget width/height/order, die benannten Verweise; Dateiformat wird exakt erkannt, Rückbau byte-gleich). Prüfung: `python3 tools/tabs_zusammen_test.py <Live-Export vor dem Zusammenlegen>`. Teil A und B sind vertauschbar. Rückbau nur in umgekehrter Reihenfolge (erst dieses Skript, dann ggf. `ui_kompakt_patch.py --revert`; das bricht auf dem zusammengelegten Stand von selbst ab).

## 17. Quiet-Freigabe v2 und Deckel/Laufzeit v4 (13.10.2026, Branch `quiet-freigabe-v2`)

**Auftrag (Nutzer 13.10.):**
- Quiet muss nicht auf 0 stehen, Comfort/Efficiency-Wechsel sind erlaubt: „wir schalten so, wie es am effizientesten ist“.
- „Laufzeit kann man mit Quiet-Mode und +1 K, also Temperaturerhöhung, erreichen.“
- Alles bleibt Shadow; die Übernahme per Klick bleibt gesperrt bis zum Go des Nutzers.

Die Regeln sind neu gebaut: Quiet-Freigabe v1 → v2 und Laufzeit strecken v3 → v4 „Deckel/Laufzeit“. Die Bewertungsregeln (v5) sind unverändert, die alten Summen bleiben unter ihren Schlüsseln stehen.

### 17.1 Datengrundlage (07.10. 16:55 – 13.10. 17:04, 8650 Minuten)

| Befund | Wert | Folge für die Regeln |
|---|---|---|
| Deckel je Stufe (ab Laufminute 15) | Q3 16–17 Hz (98 % der Minuten; hielt 10.10. 08:25–08:40 auch bei 6–7 K Rückstand); Q2 16–17 Hz bei 12–13 °C, 20–21 Hz bei 1–4 °C (12.10., 168 min); Q1 20–21 Hz bei 12 °C (13.10., 28 min); Q0 bis 33–35 Hz | Tabelle `DECKEL` als gemessene Untergrenze, dazu der gelernte Deckel; wirksam ist der größere Wert |
| Gelernter Deckel im Replay (5 min am Stück gehalten, ab 15 min nach einem Quiet-Wechsel) | Efficiency Q3: 18 Hz bei 3…7 °C, 17 Hz bei 7…15 °C, 16 Hz bei −1…3 °C; Q2: 21 Hz bei −1…3 °C (152 min) | passt zur Tabelle; Spitzen wie 09.10. 01:22 (Q3 3 min 20 Hz) zählen nicht |
| Q0 über 20 Hz nach Laufminute | 0–14: 26 %, 15–59: 36 %, 60–179: 18 %, ab 180: 0 % | der Effizienz-Deckel wirkt in den ersten 3 h eines Laufs |
| Q0 über 20 Hz nach Außentemperatur | < 3 °C: 0 von 274 Laufminuten; 3–7 °C 14 %, 7–11 °C 14 %, ≥ 11 °C 25 % | Deckel nur über 3 °C (`atMinC`) |
| COP nach Frequenz (Q0, gleiches Außenband, ab Laufminute 15) | gegen 16–17 Hz: 18–21 Hz −1…−5 % (im Rauschen), 22–27 Hz −3…−8 %, ab 28 Hz −10…−14 % | Schwelle `hzHoch` 22 Hz |
| COP nach Quiet bei gleicher Frequenz (16–17 Hz) | Q0 gegen Q3 −9…+5 % (Tageszeit, Feuchte, Vorlauf verschieden); Quiet-Wechsel im Lauf am Minimum −2…+6 % | die COP-Matrix entscheidet nicht über die Stufe, sie ist nur ein Veto (10 %) |
| Quiet am Minimum (Lüfter) | Lüfter (Median) Q0 330 / Q2 270 / Q3 220 U/min; Pel (Median, alle Bänder) Q0 355 / Q2 317 / Q3 341 W; je Außenband Q3 gegen Q0 −10…−19 W unter 8 °C, sonst ≈ 0 (Review 2) | Quiet senkt am Minimum den Lüfter (−60…−110 U/min). Ein COP-Vorteil ist dort nicht messbar, deshalb gibt es keinen eigenen Auslöser „Quiet höher am Minimum“ (Lärm: offene Entscheidung) |
| Rücklauf-Rückstand und Q0-Frequenz | bei 1,5–2,5 K nur 20–39 % der Minuten über 20 Hz, ab 2,5 K immer | Freigabe-Schwelle 1,5 K bleibt Annahme; Rückweg des Deckels ab 2,5 K |
| Läufe und Takt | 24 Läufe, 20 mit Abschaltung über den Vorlauf (97–970 min, Median 184); kein solcher Lauf unter 60 min; höchstens 1 Start in 3 h; Pausen 57–142 min (Review) | kein Takt (Review LS-1), der Hebel +1 K schweigt in den Daten |
| Wirkung Q2 → Q1 (13.10. 16:36, Comfort, 12 °C, Rücklauf 1,75 K unter Soll) | 17 → 20–21 Hz in 2 min, +80–100 W el | Erwartung bei Ziel 1/2: alter Deckel + 3 Hz binnen 10 min, +60 W |
| Wirkung Q3 → Q0 (Boost 10.10.) | 29 Hz nach 1 min, 34 Hz nach 2 min, +490–590 W, Vorlauf +4 K in 20 min | Erwartung bei Ziel 0 (unverändert) |
| Quiet nach oben | die Frequenz fiel binnen 5–15 min (08.10. 09:38; 12.10. 09:30: von 20 auf 17–18 Hz erst nach 15 min) | Erwartung Deckel: ≤ 21 Hz binnen 10 min, −100 W; der gelernte Deckel zählt erst 15 min nach einem Wechsel |

### 17.2 Antworten auf die Fragen des Auftrags

1. **Wann ist eine Freigabe nötig?** Nur bei echtem Bedarf:
   - ein Raum unter Minimum;
   - ein Raum fällt im Lauf ≥ 0,2 K/h und erreicht beim jetzigen Gefälle das Minimum binnen 2 h. Der Verlauf zählt ab Laufminute 15 und braucht mindestens 60 min. In der Pause ist das kein Bedarf, weil der nächste Start nachheizt;
   - **Heizstab-Nähe:** Außen < Heizstab-Freigabe + 2 K und Vorlauf ≥ |Start-Delta| − 0,5 K = 2,5 K unter Soll, ab Laufminute 10 mit 3 min Haltezeit, also vor dem Heizstab nach 15 min;
   - Boost von Hand (Soll mehr als 1,5 K über der Heizkurve).

   „Sollvorlauf nicht erreicht“ ist zu schwach und kein Bedarf mehr. Es traf jeden Kaltstart (07.10. 20:18, 08.10. 09:33, 08.10. 17:18). Ohne Rücklauf-Bedingung hätte v1 07.–10.10. 4 Fehlalarme gemacht, v2 macht auch dann keinen.

   Ein Abtau-Rückstand ist kein eigener Auslöser: Es gab 0 Abtauungen. Nach dem Abtauen sperrt die Regel 10 min, danach greifen Heizstab-Nähe und Raumbedarf.
2. **Zielstufe:** die nächste niedrigere Stufe, die beides erfüllt:
   - ≥ 60 min Daten je Heizregelung × Quiet × Außenband (`copMinMin`, Nutzerentscheidung);
   - ihr Deckel liegt mindestens 4 Hz über dem jetzigen; +4 Hz sind gemessen etwa +80–100 W el.

   Eine tiefere Stufe nur mit mehr als 10 % besserem COP. Bei Heizstab-Nähe gilt Quiet 0. Ohne Daten ist das Ziel Quiet 0 mit Begründung, etwa „Quiet 0, weil Quiet 2: 0 von 60 min Daten; Quiet 1: 0 von 60 min Daten“.

   Beispiele aus den Tests: bei 2 °C Q3 → Q2 (Deckel 21 Hz, wie der Nutzer am 12.10. 06:38); bei 9 °C Q3 → Q1, weil Q2 dort wie Q3 bei 17 Hz deckelt.
3. **Deckel lernen:** Gelernt wird die höchste Frequenz, die eine Stufe 5 min am Stück gehalten hat, je Heizregelung × Quiet × Außenband. Die ersten 15 min nach einem Quiet-Wechsel zählen nicht. „Am Deckel“ heißt ≥ Deckel − 1 Hz. Damit erkennt die Regel 21 Hz bei Q1/Q2 (Review QF-2); v1 nahm für alle Stufen ≤ 20 Hz an.
4. **Rückweg:** zurück auf die vorherige Stufe, sobald der Bedarf 15 min am Stück gedeckt ist (alle Räume ≥ Minimum + 0,3 K, Rücklauf ≤ 0,5 K unter Soll) oder ein Raum über Maximum steigt.
   - Die Frist von 4 h ruht, solange Bedarf besteht.
   - Höchstens 3 Sendeversuche; danach rote Warnung (Klickweg).
   - Eine fremde Änderung beendet die Übernahme ohne Rücksetzen.
5. **Gemeinsame Arbitrierung:** siehe 4b (Eigentum, Notfall nach 10 min (bis zum zweiten Durchgang 60), Gegenrichtung nach 60/240 min, Ruhe 2 h, Mindestabstand über beide Größen, je Größe eine Übernahme).
6. **Bewertung:** Die Bewertungsregeln v5 sind unverändert.
   - Die neuen Regelversionen zählen unter `quiet_freigabe|v2|s5` und `quiet_strecken|v4|s5`; die Summen von v1 und v3 bleiben stehen.
   - Die Basisrate wird je neuer Auslösung neu gelernt: `quiet_freigabe|v2`, `quiet_strecken|v4` und `quiet_strecken|v4|kurve`. Die Vergleichslagen folgen der neuen Auslösung.
   - Prognose der Freigabe: „bleibt am Deckel der Stufe mit Rückstand ≥ 1 K“, p 0,8, 30/60/120 min.
   - Prognose des Effizienz-Deckels: „weiter ≥ 22 Hz“, p 0,7, 30 min.
   - Prognose von +1 K: „der Lauf endet binnen 60 min“, p 0,7, 60 min.
   - „Verpasst“ und Wirkung stehen in Abschnitt 6.
7. **Weitere Punkte:**
   - Die Sperre „Mindestabstand“ gilt über Quiet und Verschiebung gemeinsam.
   - Startphase 15 min, bei Heizstab-Nähe 10 min.
   - Je Größe eine Übernahme mit eigenem Rückweg (zuerst eine zur Zeit, seit dem zweiten Durchgang je Größe, 17.9). Vorher hätte eine zweite Übernahme den Rückweg der ersten überschrieben.
   - Behoben: Der Laufzeit-Reset von HeishaMoNR (09.10. 03:01: 583 → 0 min) machte aus einem 601-min-Lauf „17 min mit Abschaltung über den Vorlauf“. Das war ein falscher Takt-Beleg.
   - Die Messaufgabe Comfort/Efficiency ist weiter offen (Efficiency 66 min, Comfort 0 min).

### 17.3 Deckel/Laufzeit v4: Name, Hebel, Nutzen

**Name:** Die Regel hat zwei Wirkungen, beide über den Deckel der Leistung:
- Quiet höher spart Strom: **Effizienz-Deckel**.
- +1 K verlängert den Lauf: **Laufzeit**.

„Laufzeit strecken“ allein beschrieb den häufigeren Fall nicht. In den Daten gibt es keinen Takt, aber Phasen mit ≥ 22 Hz ohne Bedarf.

**Wahl des Hebels:**
- Bei ≥ 22 Hz oder ohne Takt: Quiet.
- Unter 22 Hz oder in der Pause mit belegtem Takt: +1 K.
- Ein Hebel je Vorschlag; ein Hebelwechsel startet die Haltezeit neu.
- Beide gleichzeitig gibt es nicht. Quiet ändert unter 22 Hz die Frequenz nicht, und +1 K bei Vorlauf unter Soll löst unter Q0 einen Hochlauf aus (11.10. 03:10: +48 % Strom).

**Kritik der COP-Matrix (Auftrag):** Die Matrix Heizregelung × Quiet × Band ist durch Tageszeit, Laufphase und Sonne verzerrt.
- Bei gleicher Frequenz unterscheiden sich Q0 und Q3 um −9…+5 %, die Matrix selbst um −5…+9 % (Review LS-4). Die Wahl nach dem besten COP (v3) hätte Rauschen ausgewählt.
- v4 wählt deshalb die niedrigste Stufe, deren Deckel nachweislich unter 22 Hz liegt. Der COP dient nur als Veto: Die Zielstufe darf höchstens 10 % schlechter sein.
- Der belegte Nutzen liegt in der Frequenz: Bei gleicher Stufe, gleichem Band und ab Laufminute 15 liegt der COP bei 22–27 Hz 3–8 % und ab 28 Hz 10–14 % unter dem bei 16–17 Hz.

**Lüfter am Minimum (Korrektur):** Quiet senkt auch bei 16–17 Hz den Lüfter (Q0 330, Q2 270, Q3 220 U/min). Strom und COP zeigen dort keinen belastbaren Unterschied. Das ist eine Lärm- und Komfortfrage (Review QF-10), also eine Entscheidung des Nutzers, und kein Effizienz-Auslöser.

**+1 K:** Nutzen gegen Kosten, gerechnet aus dem letzten Zyklus:
- Nutzen = vermiedene Starts × 15 Wh (Annahme: Lauf +40 min, Pause −18 min).
- Kosten = 8,5 W/K × Laufanteil × 24 h.
- Die Rechnung geht ab einem Zyklus von etwa 50 min auf. Die echten Zyklen (Lauf ≥ 97 min plus Pause ≥ 57 min) liegen weit darüber, deshalb schweigt der Hebel in den Daten.
- Die Wirkung ist nicht gemessen. Die Messaufgabe „Heizkurve +1 K“ (Abschnitt 6) kalibriert die Annahmen.

### 17.4 Replay 07.–13.10. (`replay_data_1310`): alt gegen neu

Vergleich: `tools/engine_replay.js` mit dem alten Kern (`git show 2b3943e:tools/engine_core.js`, Stand live) und mit dem neuen Kern auf denselben Daten:

| | v1/v3 (live, 2b3943e) | v2/v4 (neu) |
|---|---|---|
| Quiet-Freigabe | 1 Vorschlag 10.10. 08:36, 3 → 0 (Vorlauf/Rücklauf unter Soll; Kinderzimmer oben 1,6 K unter Minimum). Ende 08:42 „Quiet steht auf 0“. Kein Rückweg: Quiet 0 blieb bis 11.10. 19:22 stehen, 35 h | 1 Vorschlag 10.10. 08:36, 3 → 0 (Bedarf: Kinderzimmer oben 1,6 K unter Minimum, Soll von Hand 38 °C; Ziel 0, weil für Q1/Q2 keine 60 min Daten). Ende 08:42 „übernommen“. Rückweg-Grund 11:01 „Kinderzimmer unten über Maximum“, 2 h 19 min nach dem Klick des Nutzers |
| Kaltstarts; 12.10. 08:30 (Q2, Vorlauf am Soll); 13.10. 16:29 (Comfort, Q2) | keine Freigabe | keine Freigabe: „kein Bedarf“, „Vorlauf genau am Soll“, Startphase |
| Deckel/Laufzeit | v3: 0 Vorschläge (kein Takt) | 3 Effizienz-Deckel Q0 → 3: 10.10. 15:39 (24 Hz, 13 °C), 11.10. 03:26 (22 Hz, 8 °C), 11.10. 12:22 (25 Hz, 11 °C). Ende 16:05 „18 Hz“, 03:56 abgelaufen, 12:50 Bedarf. Bewertung: 2 Treffer (neutral, b ≥ p), 1 neutral, 0 Fehlalarme, 0 Punkte. Alle drei fallen in die 35 h, in denen Quiet 0 nach dem Boost stehen blieb; mit dem Rückweg der Freigabe (11:01) hätte Quiet dort wieder auf 3 gestanden |
| +1 K | – | nie (kein Takt) |
| Punkte | Freigabe +10 (Wirkung), Laufzeit 0 | Freigabe +30 (Wirkung, dazu zwei Fälle Quiet 3 → 2 von Hand), Deckel 0 |
| Gelernter Deckel, Messaufgabe | – | siehe 17.1; Messaufgabe offen |

### 17.5 Simulationen (Fake-Uhr, offline)

- **8 Tage Quiet:** 3,5 Tage mild mit Übersteuern nach langen Pausen, 2 Tage −5…3 °C mit Heizstab-Nähe und Quiet 3 von Hand, danach wieder mild.
  - Shadow: 3 Deckel (je um 20:02) und 12 Freigaben (nur in der Kälte, höchstens 3 am Tag). Nie zwei Quiet-Vorschläge gleichzeitig, keiner in einer Sperrminute.
  - Mit sofortiger Übernahme: Deckel 3-mal mit Rückweg nach der Frist, Freigabe 1-mal, kein Ping-Pong.
  - Minuten mit ≥ 22 Hz bei Mildwetter 67 statt 107, Heizstab 0 statt 443 min. Das ist das Anlagenmodell der Sim, keine Messung.
- **8 Tage mild** mit Übersteuern nach jedem Start: mit Messdaten 24 Deckel-Vorschläge (höchstens 3 je Tag), ohne Messdaten für höhere Stufen keiner.
- **5 Tage kälter werdend** (4 → −3,5 °C): je Tag 3 Freigaben (Tageslimit), Ziel Quiet 0.
- **Einzeltests (Abschnitt (e) der Sim, 19 Prüfungen):** Kaltstart ohne Bedarf, fallender Raum im Lauf und in der Pause, Heizstab-Nähe in Minute 13, Zielstufen kalt/mild/ohne Daten/COP-Veto, Deckel je Stufe, gelernter Deckel, Rückweg, Frist, Arbitrierung mit Notfall und Wartezeit.

### 17.6 Regel-Review: Prüflisten

| Punkt | Stand |
|---|---|
| QF-1 Komfortbedarf | erfüllt: Bedarf statt Sollvorlauf; im Replay keine Freigabe bei Kaltstarts |
| QF-2 Deckel je Stufe und AT | erfüllt: Tabelle und gelernter Deckel; „am Deckel“ ≥ Deckel − 1 Hz schließt 21 Hz bei Q1/Q2 ein |
| QF-3 schrittweise | erfüllt: mit Daten (3 Hz Mehrleistung, Review R1) und ohne Daten nach der Messtabelle (vorläufig); nur ein Notfall ohne Daten geht direkt auf Quiet 0. Per Klick fortsetzbar (B1) |
| QF-4 Startphase | erfüllt: 15 min, bei Heizstab-Nähe Heater_Delay_Time − 5 − 3 min (Vorschlag 5 min vor der Heizstab-Freigabe). Der träge Efficiency-Anlauf ist kein Bedarf |
| QF-5 Ende der Übernahme | erfüllt: Rückweg über den gedeckten Bedarf oder den Bedarfsraum über Maximum (kein Pendeln, B2), Frist, je Größe eine Übernahme mit eigenem Rückweg, fremde Änderung beendet ohne Rücksetzen, stehende Maschine (B7) |
| QF-6 Kälte und Heizstab | erfüllt: Kälte-Vorsorge unter 2 °C (auch aus der Vorhersage, also am Abend), Heizstab-Nähe 5 min vor der Freigabe des Heizstabs und im Dauerlauf mit 1,0 K Abstand, der Notfall überbrückt die Sperren nach 10 min (B4) |
| QF-7 Erwartung je Stufe | teilweise: Ziel 0 aus dem Boost, Ziel 1/2 aus der Messung vom 13.10.; je Heizregelung und AT fehlen Daten |
| QF-8 Effizienz normalisiert | teilweise: COP nur als Veto mit 10 %; `hzHoch` aus gleicher Stufe, gleichem Band und gleicher Laufphase. Ein eigener Zähler fehlt |
| QF-9 kWh und Komfortminuten | nicht umgesetzt: Der Auftrag verlangt v5; dafür braucht es einen Zähler (offene Entscheidung 7) |
| QF-10 Lärm nachts | Entscheidung des Nutzers (offene Entscheidung 6) |
| LS-1 reale Auslöselage | Deckel: 3 echte Lagen im Replay. +1 K: keine; der Hebel bleibt still, die Messaufgabe sammelt |
| LS-2 wo Deckeln wirkt | Efficiency/Q0-Phasen mit ≥ 22 Hz ab Laufminute 15: ja. Comfort/Q0-Hochlauf direkt nach dem Start: nein, wegen der Startphase (offene Entscheidung 5). +1 K bei Vorlauf unter Soll: ausgeschlossen (`laufVlK`) |
| LS-3 Kälte | Deckel nur über 3 °C. Rückweg bei ≤ 3 °C, bei Bedarf oder Heizstab-Nähe; Frist 8 h |
| LS-4 COP-Wahl | erfüllt: COP nur als Veto |
| LS-5 +1 K in der Arbitrierung | erfüllt: `S.arb`, kein Raum über der Bandmitte, Nutzen ≥ Kosten, Rückweg bei Heizstab-Nähe, Raum über der Bandmitte + 0,3 K und Takt-Ende (B5); Vorlauf ≥ Soll + 1,0 K (R2) |
| LS-6 Quiet-Arbitrierung | erfüllt: `S.arbQ`, 60/240 min, Ruhe 2 h, Mindestabstand bei Übergaben |
| LS-7 Takt entprellt | erfüllt: Takt-Messung, oder kurzer Lauf **und** 2 Starts in 3 h. Die Typen (Bedarfstakt, Minutenpause) sind nicht getrennt |
| 3.4 Sperre über beide Größen | erfüllt; ein Quiet-Notfall überbrückt sie nach 10 min |
| 3.4 Wirkung je (Quiet, Modus) | teilweise: +1 K nie in der Hochlauf-Lage, Ziele je Heizregelung; die Bewertung läuft nicht je Kombination |
| 3.4 Schreibbudget | Übernahme 6 je Tag gesamt; die Tageslimits der Regeln zählen nur übernommene Vorschläge (R5) |
| Wirkkette (Abschnitt 2) | Stopp-Art ab +2,75 K (gemessen +3,0…+3,25 K). +1 K in der Pause nur bei Vorlauf > Soll −2 K, im Lauf nur bei Vorlauf ≥ Soll +1,0 K; Wirkung „Soll folgt“ binnen 6 min (5-min-Raster). Heizstab-Logik wie im Handbuch J. `stopK` 3,25 → 3,0 nicht geändert, weil es auf alle Regeln wirkt (offene Entscheidung 8) |
| 5.5 Kern-Guard | gehärtet vorbereitet (`kern_patch.py`, nicht im Deploy): Ausnahme nur bei frischem `OPT_apply` (≤ 2 min), bestätigtem Wert, ohne abgebrochenen Rückweg und vor `aktiv.bis`; liest `OPT_apply.ak.shift` (B6) |

### 17.7 Geänderte Knoten

**Geänderte Knoten für den Deploy:** nur `opt_engine` und `opt_apply`, jeweils nur `func` (eingebetteter Kern bzw. Kern + Anzeige). 0 neu, 0 entfernt. Geprüft mit dem Generator aus 2b3943e gegen den neuen Generator auf derselben Flow-Datei.

**Zustand:** Er bleibt erhalten. `S.arbQ`, `S.rtr`, `S.bedT`, `S.qfDeckSince`, `S.lastPause` und `S.lz` werden ergänzt, ein laufender Quiet-Vorschlag wird als Eigentümer eingetragen. Läufe aus dem alten Zustand haben keine Pause, deshalb rechnet +1 K erst nach dem nächsten Zyklus.

### 17.8 Offene Entscheidungen

1. Boost von Hand als Bedarf: **vorläufig ja** (`boostBedarf` 1).
2. Das Fenster 1–3 °C: seit dem zweiten Durchgang als **Kälte-Vorsorge** unter 2 °C umgesetzt (`kaltC`, vorläufig); die Grenze bestätigen.
3. Ziel ohne 60 min Daten: **vorläufig** Notfall direkt Quiet 0, sonst schrittweise nach der Messtabelle (`ohneDatenSchrittweise` 1).
4. Daten von Comfort und Efficiency zusammenlegen? Die Deckel hängen kaum vom Modus ab, Comfort hat nur ~7 h.
5. Comfort/Q0-Hochlauf nach dem Start: **vorläufig nicht deckeln**, nur messen (Kennzahl „Hochlauf nach Start“).
6. Lärm nachts (QF-10): **vorläufig keine Grenze**; Parameter `nachtQuietMin` (−1 = aus), `nachtVonH`/`nachtBisH`.
7. Bewertung über kWh el und Komfortminuten (QF-9); dafür braucht es einen Zähler.
8. `stopK` 3,25 → 3,0 (Review 5.5).
9. Wächter `opt_quiet`: Die Deckel-Annahme 35/45 Hz ist veraltet (Review 4.4).
10. Ein unabhängiger Stromzähler für die WP (Review 5.1).
11. Kern-Guard: gehärtet vorbereitet (B6); das Kern-Paket einspielen nur mit Go.
12. Übernahmen je Größe nebeneinander (R6) und Fortsetzung (B1): umgesetzt, bestätigen.
13. Tageslimit nur für übernommene Vorschläge (R5): Ohne Klick kommt bei Dauerbedarf alle 90 min ein Vorschlag (Gültigkeit 30 + Wartezeit 60 min); ein abgelaufener Notfall-Vorschlag wartet die volle Wartezeit.

### 17.9 Zweiter Review-Durchgang (REVIEW.md Abschnitt 8, 13.10. spät)

Die Blocker vor dem Einspielen sind behoben, jeder mit einem Test bzw. dem Szenario aus `regel-review/skripte/v2/` (engine_sim Abschnitt (f)):

| Punkt | Änderung | Test |
|---|---|---|
| B1 Freigabe nicht fortsetzbar | Fortsetzung derselben Übernahme: dieselbe Regel, derselbe Befehl, dieselbe Richtung, bestätigter Wert; der Ausgangswert bleibt für den Rückweg (`fortsetzung()`); die Maschine merkt die Ausgangsstufe (`von0`) | Szenario C2: Klick 3 → 2, Klick 2 → 0 (Fortsetzung), Rückweg auf 3; Gegenproben (andere Regel, unbestätigt) lehnen ab |
| B2 Rückweg pendelt | Rückweg nur über den gedeckten Bedarf oder einen **Bedarfsraum** dieser Freigabe 15 min über seinem Maximum (`rueckRaumMin`); andere Räume über Maximum zählen nicht | Szenario D: Wohnzimmer dauernd über Maximum, 2 Befehle statt bis zu 6 |
| B3 Raumtrend | Regression im 5-min-Raster über 2 h; Lüften (Sturz ≥ 1 K binnen 60 min, `lueftungK`) beendet den Verlauf; steigt der Raum in den letzten 30 min, fällt er nicht | Einheitstests; Replay: Trend-Bedarf 194 statt 415 Laufminuten, kein „Wohnzimmer −6,9 K/h“ am 08.10. |
| B4 Heizstab-Nähe zu spät | Kälte-Vorsorge unter 2 °C (gemessen oder Vorhersage 6 h; Ziel: Stufe ohne harten Deckel, sie hält unter 3 °C); Heizstab-Nähe nur im Lauf, Startphase aus `Heater_Delay_Time` (neue Eingabe `htrDelay`), im Dauerlauf 1,0 K Abstand; Notfall überbrückt Mindestabstand, Wartezeit, Tageslimit, Vorrang und Gegenrichtung nach `notfallMin` 10 min | Szenarien A1/A2: Vorsorge in der Pause, Vorschlag in Laufminute 10 auch nach Quiet von Hand; Dauerlauf; Delay 20 min |
| B5 +1 K ohne Rückweg | Rückweg bei Heizstab-Nähe, Raum mehr als 0,3 K über der Bandmitte, zwei Läufe ohne Takt (`kurveTaktZyklen`) | Rückweg-Gründe je Fall |
| B6 Kern-Guard | Ausnahme nur bei frischem `OPT_apply`, bestätigtem Wert, ohne `rueckFehl`, vor `aktiv.bis`; liest `ak.shift` (nur vorbereitet) | kern_chain_sim R5b (4 Fälle) |
| B7 stehende Maschine | `halten`/Gründe nur von einer Maschine ≤ 5 min alt; sonst Frist; nach 30 min ohne Rechnung sicherer Abbruch | 5 Fälle |
| R1/QF-3 | `mehrHz` 3 statt 4 | gelernter Q3-Deckel 18 Hz → Ziel Q2 |
| R2 | `laufVlK` 1,0 statt 0,5 K | Regel-Auswertung |
| R3 | Wirkung „Soll folgt“ binnen 6 min | Soll nach 5 min getroffen, nach 7 min nicht |
| R5 | Tageslimit zählt nur übernommene Vorschläge (Befehlsregeln) | Tageslimit-Test |
| R6 | Übernahmen je Größe nebeneinander, „Zurücksetzen“ stellt alle nacheinander zurück | R6-Test, Knopf-Tests |
| Vorgaben (vorläufig) | `boostBedarf` 1, `ohneDatenSchrittweise` 1, Comfort-Hochlauf nur Kennzahl, `nachtQuietMin` −1 | Parameter-Test, Kennzahl-Test |

**Replay 07.–13.10. nach dem zweiten Durchgang:** unverändert eine Freigabe (10.10. 08:36, 3 → 0, jetzt „Notfall … ohne Daten“) und drei Effizienz-Deckel; das dritte Deckel-Ende kommt jetzt über den Raumtrend („Kinderzimmer unten fällt 0,9 K/h“) statt über „Ruhe nach Bedarf“. Kälte-Vorsorge: 102 Minuten unter 2 °C, aber nie mit hartem Deckel (Quiet 2/0), daher kein Vorschlag.

**Geänderte Knoten:** weiterhin nur `opt_engine` (Kern, Ansicht, Eingabe `htrDelay` aus `Heater_Delay_Time`) und `opt_apply` (Kern, `OPT_apply.ak`).


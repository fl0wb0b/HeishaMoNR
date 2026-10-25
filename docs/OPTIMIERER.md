# Optimierer: Entscheidungsmaschine, Punktesystem, Ein-Klick-Übernahme, Bonsai-Beobachter

Stand 17.10.2026, Branch `cop-ziel` (**COP: Ziel und Ist, Stromzähler**: Abschnitt 25; **Winterpaket**: Abtauwetter bis unter 10 °C, kein Comfort nach dem Abtauen/beim Kaltstart, Quiet stufenweise, +1 K in der Pause als Startbefehl, „Anlage hat Quiet beendet“, COP mit Abtau-Abzug, Zwilling-Parameter: Abschnitt 24; Änderungen gegenüber 12.10.: Abschnitt 13; Seite „Optimierer“ und Klickweg: Abschnitt 14; Seiten: Abschnitte 15–16; Quiet-Freigabe v2 und Deckel/Laufzeit v4: Abschnitt 17, zweiter Review-Durchgang: 17.9; **Review-Paket** (Wärmefahrplan als Vorschau, Heizgrenze-Hinweis stillgelegt, Vorausschau nur −1 K, Messaufgabe gestrichen, Quiet-Wächter nur Messung): Abschnitt 18; COP-Korrektur: Abschnitt 19; **Raumeinfluss v3, Forum 189605** (Mindestfrequenz, Startschwelle, Abtauen, H23, Dornröschenschlaf, Effizienz-Deckel ab 28 Hz): Abschnitt 20; **Regel „Heizregelung“** (Comfort/Efficiency mit Übernahme per Klick, Whitelist `SetHeatingControl` 0/1): Abschnitt 21; **Gebäudemodell v3 und eigene Nachheizung** (Entscheidungen 2 und 5, 15.10.): Abschnitt 22). **Alles ist Shadow.** Die Maschine rechnet jede Minute aus, was sie schalten *würde*, und schreibt das auf. Sie sendet nichts. Der einzige Sendeweg ist ein Klick des Betreibers auf „Übernehmen“. Dieser Weg wird gesperrt ausgeliefert.

## 1. Kurzfassung

- **Entscheidungsmaschine** `opt_engine` (Tab „WP Optimizer“, jede Minute): Sie wertet vier Regeln aus (seit 11.10. mit der **Vorausschau**, seit dem Review-Paket nur noch −1 K, die bis zur Freigabe des Gebäudemodells gesperrt mitläuft, und der **Verschiebungs-Arbitrierung**, siehe 4a; der Heizgrenze-Hinweis ist seit 13.10. stillgelegt, Abschnitt 18). Je Regel hält sie fest: Status, Grund in Zahlen, nächste Schwelle mit Abstand („würde schalten, sobald …“) und gegebenenfalls einen Vorschlag mit Befehl, Erwartung, Gültigkeit und Rückweg.
  - Jede Auswertung wird ein unveränderlicher Datensatz in `decisions-YYYY-MM.jsonl`, auch „nichts tun“.
- **Punktesystem**: Es arbeitet automatisch und ohne Eingabe des Nutzers.
  - Jeder Vorschlag ist ein Fall. Seine Auslöser-Prognose wird nach dem Brier-Prinzip gegen die Basisrate „bleibt, wie es ist“ bewertet.
  - Eine Wirkungsprognose wird nur bewertet, wenn eine gleichwertige Änderung wirklich passiert.
  - Dazu kommen Abzüge für Schaden und für verpasste Lagen. Unsicheres zählt 0.
  - Das Punktebuch steht in `scores-YYYY-MM.jsonl`. Die Freigabereife ist nur eine Anzeige.
  - Seit den Bewertungsregeln v4 (12.10.) sammeln reine Hinweise keine Punkte mehr, und der Brier-Skill steht erst ab 3 abgeschlossenen Fällen.
  - Seit v5 (12.10., Entscheidung des Nutzers, Weg b) zählt ein Treffer neutral, wenn die Basisrate mindestens bei der Prognose liegt (b ≥ p); Fehlalarme bleiben voll im Abzug.
  - Seit v6 (22.10., wertung-lueften) ist „gelöst“ bei den Raum-Prognosen nur ein Fehlalarm, wenn keine Fremdursache vorlag (Lüften auf dem geglätteten Raumwert, Sonne bei +1 K, Heizgrenze-Aus bei −1 K); Änderungen von Hand sind Naturexperimente: gemessen, getrennt gezählt, keine Punkte für die Regel.
- **Quiet-Regeln seit 13.10.** (Abschnitt 17, Nutzerregel „wir schalten so, wie es am effizientesten ist“):
  - **Quiet-Freigabe v2** schlägt nur bei echtem Bedarf vor (Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Boost von Hand). Sie erkennt den Deckel je Stufe und Außentemperatur, gibt nur so weit frei wie nötig und hat einen automatischen Rückweg.
  - **Deckel/Laufzeit v4** (vorher „Laufzeit strecken“) hat zwei Hebel: Quiet höher als Effizienz-Deckel, wenn der Verdichter ohne Bedarf mit ≥ 22 Hz läuft; Heizkurve +1 K nur bei belegtem Takt und wenn der geschätzte Nutzen die Kosten übersteigt.
  - Beide Quiet-Regeln teilen sich eine Arbitrierung (4b). Der Mindestabstand gilt über Quiet und Verschiebung gemeinsam (ein Notfall überbrückt ihn nach 10 min); je Größe läuft eine Übernahme, die dieselbe Regel in derselben Richtung fortsetzen darf (17.9).
- **Heizregelung seit 14.10.** (Abschnitt 21): Ziel ist Efficiency. Comfort schlägt die Regel nur bei echtem Bedarf vor (wie Quiet-Freigabe v3), solange Efficiency träge ist (Anlaufphase bis Laufminute 45, nach dem Abtauen, Heizstab-Nähe) und der Quiet-Deckel den Hochlauf zulässt – sonst zuerst die Quiet-Freigabe. Zurück nach Efficiency, wenn der Bedarf 15 min gedeckt ist, und zwar in der Pause (im Lauf springt die Pumpe); Comfort von Hand wird frühestens nach 2 h ohne Bedarf in einer Pause zur Efficiency vorgeschlagen (nur wenn Comfort hochfahren kann, mit COP-Veto). Replay 07.–14.10.: 0 × Comfort, 2 × Efficiency (13.10. 13:51 und 15:21, Comfort von Hand; der Nutzer stellte 15:29 selbst Efficiency).
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
| seit 14.10.2026 | Fehlercode `err` (HeishaMon `main/Error`, TOP44), Leitungstemperatur Innengerät `pipeIn` (`Inside_Pipe_Temp`), Heizkurve `kurve` = [Außen tief, Außen hoch, Soll hoch-AT, Soll tief-AT] aus `Z1_Heat_Curve_*` (Abschnitt 20) |

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
| **Quiet-Freigabe** (v5; seit 14.10. zusätzlich Abtau-Rückstand als Bedarf, Sperre „Frequenzsprung bei Abtauwetter“, Deckel nie unter der Mindestfrequenz, Abschnitt 20; seit 16.10. bei Abtauwetter stufenweise, Abschnitt 24) | Quiet ≥ 1 · Lauf ≥ 15 min (bei Heizstab-Nähe ab Heater_Delay_Time − 5 min − Haltezeit, hier Minute 7) · **Bedarf**: Raum unter Minimum, *oder* Raum fällt im Lauf ≥ 0,2 K/h (Regression, Lüften ausgenommen) und erreicht das Minimum binnen 2 h, *oder* Heizstab-Nähe im Lauf (Außen < Heizstab-Freigabe + 2 K, Vorlauf ≥ 2,5 K unter Soll, im Dauerlauf ≥ 2,0 K), *oder* Boost von Hand (Soll über der Heizkurve, vorläufig) · Verdichter am Deckel der Stufe (≥ Deckel − 1 Hz; Deckel aus Messung oder gelernt) · Vorlauf ≥ 1,5 K unter Soll · Rücklauf ≥ 1,5 K unter Soll-Rücklauf · Zielstufe vorhanden · **10 min am Stück** (Heizstab-Nähe 3 min) · keine Sperre (ein Notfall überbrückt Mindestabstand, Wartezeit, Tageslimit, Vorrang und Gegenrichtung nach 10 min). **Kälte-Vorsorge** (auch in der Pause): unter 2 °C, gemessen oder in der Vorhersage der nächsten 6 h, und die Stufe deckelt hart (≤ 17 Hz) | `SetQuietMode` = nächste niedrigere Stufe, deren Deckel ≥ 3 Hz höher liegt: mit ≥ 60 min Daten, ohne Daten nach der Messtabelle (vorläufig); Notfall ohne Daten und Heizstab-Nähe: 0; eine tiefere nur mit > 10 % besserem COP. **Abtauwetter (−5 bis unter 10 °C, Feuchte ≥ 80 % oder Rohr außen ≤ 0 °C) im Lauf: nur die nächste wirksame Stufe (Heizstab-Nähe zwei), 30 min Abstand zwischen zwei Stufen; 30 min nach „Anlage hat Quiet beendet“ keine Freigabe.** Kälte-Vorsorge: nächste Stufe ohne harten Deckel (bei Kälte Quiet 2) | automatisch zurück auf die Ausgangsstufe, sobald der Bedarf 15 min gedeckt ist (alle Räume ≥ Minimum + 0,3 K, Rücklauf ≤ 0,5 K unter Soll) oder ein **Bedarfsraum** 15 min über seinem Maximum liegt; Frist 4 h, sie ruht, solange Bedarf besteht oder die Kälte-Vorsorge eine harte Ausgangsstufe hält (unter 3 °C) |
| **Deckel/Laufzeit** (v7), Hebel Quiet | Quiet < 3 · Lauf ≥ 15 min · ≥ 28 Hz (mit belegtem Takt ≥ 22 Hz; bei Frost ≥ Mindestfrequenz + 3 Hz) · kein Bedarf (wie bei der Freigabe) und Rücklauf ≤ 1 K unter Soll · alle Räume ≥ Minimum + 0,3 K · seit 2 h kein Bedarf · Außen > 3 °C · Zielstufe aus den Daten (niedrigste höhere Stufe mit ≥ 60 min, Deckel < 22 Hz, COP höchstens 10 % schlechter; bei Abtauwetter nur die nächste Stufe) · 10 min am Stück · keine Sperre | `SetQuietMode` = Zielstufe | automatisch zurück auf die vorige Stufe bei Bedarf, bei Rücklauf ≥ 2,5 K unter Soll seit 15 min, bei Außen ≤ 3 °C, spätestens nach 8 h |
| **Deckel/Laufzeit** (v7), Hebel +1 K | Takt belegt (Takt-Messung: > 12 Starts in 24 h oder > 25 % kurze Läufe; oder letzter Lauf < 60 min mit Abschaltung über den Vorlauf **und** ≥ 2 Starts in 3 h) · Verdichter unter 22 Hz oder Pause · Verschiebung 0 · kein Raum über der Bandmitte · im Lauf Vorlauf ≥ Soll +1,0 K (sonst Hochlauf), in der Pause nur als gewollter Start (Bedarfsraum unter Minimum, Pause ≥ 20 min, kein Kaltstart bei Abtauwetter ≤ 4 °C; „startet die Wärmepumpe“) · Nutzen ≥ Kosten aus dem letzten Zyklus · 10 min am Stück · keine Sperre (auch Verschiebungs-Arbitrierung) | `SetZ1HeatRequestTemperature = +1` | automatisch auf 0 bei Heizstab-Nähe, wenn ein Raum mehr als 0,3 K über die Bandmitte steigt, wenn zwei Läufe ohne Takt endeten, spätestens nach 6 h |
| **Raumeinfluss ±1 K** (v6) | Lage direkt aus den Räumen (Abschnitt 20.1): **Bedarf** (ein Raum ≥ 0,2 K unter Minimum, erholt sich nicht, nicht gelüftet; Kinderzimmer oben nur mit offenem Relais) → +1 K; **Überschuss** (alle Räume ≥ 0,5 K über Minimum, auch in 2 h, keiner gelüftet; einer über Maximum oder alle über der Bandmitte) → −1 K · 60 min am Stück · höchstens 1 K je Befehl · +1 K in der Pause nur als gewollter Start (Bedarfsraum unter Minimum, Pause ≥ 20 min, kein Kaltstart bei Abtauwetter ≤ 4 °C; „startet die Wärmepumpe“) · −1 K: Soll bleibt ≥ 29 °C, im Lauf nur bei Vorlauf ≤ Soll (sonst in der Pause), unter 3 °C Rücklauf ≥ 28 °C · kein natürlicher Sollsprung in den letzten 10 min · Wärmeverteilung (einer über Maximum, einer unter Minimum) → keine Verschiebung, eigener Hinweis · keine Sperre (u. a. Heizkurvenmodus, Wasserfühler, kein Handeingriff am Soll, Störung, Frequenzsprung bei Abtauwetter) | `SetZ1HeatRequestTemperature` = Verschiebung ± 1 | automatisch auf 0: +1 K, sobald die Bedarfsräume 30 min ≥ Minimum + 0,3 K liegen (frühestens nach der Wirkzeit), −1 K bei einem Raum unter Minimum oder verbrauchter Reserve; spätestens nach 6 h |
| **Vorausschau −1 K** (v2) | Gate des Gebäudemodells offen · Bedarfsänderung **aus dem Wetter** ≤ −2 K (vorhergesagte Milderung; Außentemperatur-Äquivalent: Vorhersage im Mittel +2…+5 h gegen jetzt, beide um den gewöhnlichen Tagesgang bereinigt; Tagesgang aus ≥ 3 Vortagen; Sonne/Wind nur mit `coefActivate`) · alle Räume gültig und im Band · kältester Raum ≥ 0,3 K über Minimum · Soll ≥ 29 °C · Verschiebung steht auf 0 · **30 min am Stück** · keine Sperre, auch nicht „andere Regel“/„Gegenrichtung“. Den Zweig +1 K gibt es seit v2 nicht mehr (Abschnitt 18.3) | `SetZ1HeatRequestTemperature = −1` | automatisch auf 0, wenn die Vorhersage 15 min unter der halben Schwelle liegt, sofort, wenn ein Raum unter das Band fällt, spätestens nach 6 h; nicht, solange der Raumeinfluss denselben Wert verlangt |
| ~~Heizgrenze-Hinweis~~ | **stillgelegt seit 13.10.2026** (Review-Paket, Abschnitt 18.2): nicht mehr im Regelwerk; Summen und Punkteverlauf bleiben stehen. Stattdessen die Kennzahl „Überheizt ab 11 °C“ in „Messwerte & Lernen“ | – | – |
| **Heizregelung** (v3, seit 14.10., Abschnitt 21; Winterpaket Abschnitt 24), Comfort | Efficiency · Verdichter läuft, Laufminute ≥ 15 (bei Heizstab-Nähe ≥ Heater_Delay_Time − 8 min) · **Bedarf** wie Quiet-Freigabe (Raum unter Minimum oder fällt darauf zu, Heizstab-Nähe, Boost; seit v3 nicht der Abtau-Rückstand) · Efficiency träge: höchstens 21 Hz (Frost: Mindestfrequenz + 1 Hz) bis Laufminute 45 oder bei Heizstab-Nähe · **v3: nicht binnen 30 min nach dem Abtauende, nicht in den ersten 45 Laufminuten bei WP-Außentemperatur ≤ 4 °C, bei Abtauwetter nur bei Heizstab-Nähe** (Sperre „Frequenzsprung bei Abtauwetter oder Kaltstart“) · Quiet 0 oder Deckel ≥ jetzige Frequenz + 3 Hz (sonst zuerst Quiet-Freigabe) · Vorlauf und Rücklauf je ≥ 1,5 K unter Soll · 10 min am Stück (Heizstab-Nähe 3 min) · keine Sperre (u. a. Laufbeginn, Abtauen, Frequenzsprung bei Abtauwetter, laufender Quiet-Vorschlag) | `SetHeatingControl = 0` | automatisch zurück auf Efficiency, sobald der Bedarf 15 min gedeckt ist (Räume ≥ Minimum + 0,3 K, auch in 2 h, Rücklauf ≤ 0,5 K unter Soll, kein Heizstab-Risiko, nicht binnen 30 min nach dem Abtauen); Frist 4 h, sie ruht, solange Bedarf, Heizstab-Nähe oder Abtau-Nachlauf besteht; zurück erst in der Pause |
| **Heizregelung** (v3), Efficiency | Comfort, nicht von der Regel gestellt · Verdichter steht (Pause oder Heizgrenze-Aus) · Bedarf seit 15 min gedeckt (wie oben) · Quiet lässt den Comfort-Hochlauf zu (Quiet 0 oder Deckel ≥ 28 Hz) · COP Efficiency nicht mehr als 10 % unter Comfort (Daten je Modus × Quiet × Band, sonst Veto) · Comfort von Hand vor mindestens 2 h · keine Sperre | `SetHeatingControl = 1` | keiner: Efficiency ist der Normalzustand, die Übernahme endet mit der Bestätigung |

**Comfort/Efficiency:** Seit 14.10. stellt die Regel „Heizregelung“ (Abschnitt 21) Comfort/Efficiency; die Whitelist kennt `SetHeatingControl` mit den Werten 0 und 1. Der **Heizregelungs-Hinweis** (Anzeige in der Heizregelungs-Karte im Tab „WP Dash“) bleibt unverändert: Efficiency, Lauf ≥ 10 min, Außen unter Heizstab-Einschaltgrenze + 2 K (Ende erst 1 K höher), Vorlauf an der Heizstab-Schwelle; er deckt sich mit dem Heizstab-Bedarf der Regel. Befund Comfort/Efficiency: Abschnitt 7 und 21.1.
- Seit 13.10. gilt die Nutzerregel „wir schalten so, wie es am effizientesten ist“: Quiet muss nicht auf 0 stehen, Wechsel der Heizregelung sind erlaubt.
- Die Quiet-Regeln rechnen ihre Ziele und Deckel je Heizregelung (Daten je Heizregelung × Quiet × Außenband); die Heizregelung nutzt dieselben Daten als COP-Veto.

### 4c. Leistungs-Arbitrierung (seit 14.10.: Quiet und Heizregelung)

Quiet-Stufe und Heizregelung wirken beide auf die Leistung, aber verschieden: Quiet ist ein harter Deckel, auch für Comfort (13.10. 21:00 Comfort/Quiet 3: 17 Hz; 16:29 Comfort/Quiet 2: 21 Hz); Efficiency ist nur in den trägen Phasen langsamer (Start bis Laufminute 39–46, ~20 min nach dem Abtauen) und regelt danach bei Rückstand selbst hoch (Boost 10.10. in Laufminute 68: 29 → 34 Hz binnen 2 min). Deshalb:
1. **Zuerst die Quiet-Stufe:** Comfort nur, wenn der Deckel den Hochlauf zulässt (Quiet 0 oder Deckel ≥ Frequenz + 3 Hz); läuft ein Quiet-Vorschlag, wartet Comfort (`vorrang`). Die Quiet-Freigabe wartet nie auf die Heizregelung.
2. **Eine Leistungsänderung zur Zeit:** Der Mindestabstand (60 min) gilt über Quiet, Verschiebung und Heizregelung; ein Notfall (Heizstab-Nähe, Raum ≥ 0,3 K unter Minimum) überbrückt ihn nach 10 min. So folgt Comfort einer Quiet-Freigabe frühestens nach 10 min (Test h6: Quiet 3 → 0 in Laufminute 25, Comfort in Laufminute 36).
3. **Kein Gegeneinander:** Läuft ein Heizregelungs-Vorschlag oder steht Comfort der Regel (Bedarf), schlägt der Effizienz-Deckel (Quiet höher) nicht vor.
4. **Eigene Größe `hc`** mit `S.arbH` (Felder wie `S.arbQ`): Gegenrichtung frühestens 60 min (`hcHaltMin`), ohne Notfall 240 min (`hcGegenMin`) nach der letzten Änderung; je Größe eine Übernahme (`OPT_apply.ak.hc`), Quiet, Verschiebung und Heizregelung können nebeneinander übernommen sein.

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
4. **Priorität Komfort vor Vorausschau:** Die Vorausschau läuft nie gegen den aktuellen Raumzustand: kein −1 K bei einem Raum unter dem Band (+1 K gibt es seit v2 nicht mehr), und sie verlangt alle Räume im Band. Verlässt ein Raum das Band, endet ihr Vorschlag **in derselben Minute** (harte Bedingung, ohne die sonst üblichen 3 min Nachlauf); den Komfortfall übernimmt der Raumeinfluss.
5. **Keine Fehlbewertung fremder Verschiebungen:** Steht an der Anlage die Verschiebung einer anderen Regel, ist das für den Raumeinfluss keine Abweichung. Raumvorschlag 0 → „ruht“ (gehört der Vorausschau), Gegenrichtung → Arbitrierung (Regeln 1–3).
6. **Übergabe statt Hin und Her:** Endet der Vorschlag der Eigentümer-Regel und will die andere Regel dieselbe Richtung, schlägt sie in derselben Minute vor (Neuprüfung nach der Freigabe). In der Übernahme ruhen Rückweg-Grund und Ablauf (`halten`), solange die andere Regel denselben Wert verlangt.

Die Sim prüft das über 8 Fake-Uhr-Tage (4 gewöhnliche Tage mit Tagesgang ±4 K, dann Kälteeinbruch und zwei Milderungen; seit v2 schlägt die Vorausschau nur bei der zweiten Milderung −1 K vor, nach dem Kälteeinbruch fehlt die Reserve, im Lauf sperrt die Takt-Gefahr) (Shadow und „jeder Vorschlag sofort übernommen“): nie zwei Verschiebungs-Vorschläge gleichzeitig, keine Gegenrichtung vor 60 min, ohne Notfall nicht vor 240 min, die Anlage wechselt nie binnen 60 min.

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
| Quiet-Freigabe (Leistung freigeben) (`quiet_freigabe`) | 6 | befehl | `SetQuietMode` | mehr_leistung | Ohne Freigabe bleibt der Verdichter am Deckel und der Rücklauf-Rückstand ≥ 1 K – p = 0,8, 30/60/120 min | anlauf, daten, stoerung, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt, abtausprung |
| Effizienz-Deckel und Laufzeit (Quiet höher oder Heizkurve +1 K) (`quiet_strecken`) | 7 | befehl | `SetQuietMode` oder `SetZ1HeatRequestTemperature` | weniger_leistung / soll_hoch | Ohne Deckel läuft der Verdichter weiter mit 28 Hz oder mehr (mit Takt: 22 Hz) – p = 0,7, 30 min; Hebel +1 K: Ohne +1 K endet der Lauf binnen 60 min (kurzer Lauf) – p = 0,7, 60 min | anlauf, daten, stoerung, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt, heizstab, abtausprung |
| Raumeinfluss (Heizkurve ±1 K) (`raum_offset`) | 6 | befehl | `SetZ1HeatRequestTemperature` | verschiebung | Ohne +1 K bleibt ein Bedarfsraum unter seinem Minimum – p = 0,7, 60/120/240 min; −1 K: Ohne −1 K bleibt das Haus überheizt (Reserve über Minimum, ein Raum über Maximum oder alle über der Bandmitte; seit v5 kein Raum mit Sonnenfenster in der Sonne als Auslöser) – p = 0,7, 120/240/360 min | anlauf, daten, stoerung, mqtt_sperre, abtauen, warmwasser, sanftanlauf, heizgrenze_aus, regler, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt, heizstab, abtausprung |
| Vorausschau (Heizkurve −1 K) (`vorausschau`) | 3 | befehl | `SetZ1HeatRequestTemperature` | soll_runter | Ohne −1 K gerät der wärmste Raum an den oberen Bandrand (höchstens Reserve unter Maximum) – p = 0,6, 120/240/360 min | anlauf, daten, stoerung, modell, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt, heizstab |
| Heizregelung (Comfort/Efficiency) (`heizregelung`) | 3 | befehl | `SetHeatingControl` | mehr_leistung | Ohne Comfort bleibt Efficiency träge: Verdichter höchstens 21 Hz und Vorlauf mindestens 1 K unter Soll – p = 0,7, 15/30 min; −1 K: Ohne Efficiency fährt der Verdichter in Comfort ohne Bedarf hoch (mindestens 28 Hz ab Laufminute 2) – p = 0,6, 120/240 min | anlauf, daten, stoerung, mqtt_sperre, abtauen, warmwasser, laufbeginn, vorrang, gegenrichtung, abstand, tageslimit, abkuehlzeit, takt, abtausprung |

*Stillgelegt (nicht mehr im Regelwerk; Summen, Basisraten und Punkteverlauf bleiben unter ihrem Schlüssel stehen, offene Fälle enden beim Laden ohne Buchung):*

| Regel | Version | seit | Grund |
|---|---|---|---|
| Heizgrenze 12 → 10 °C (nur Hinweis) (`heizgrenze_hinweis`) | 1 | 2026-10-13 | Regel-Review 4.1: Der Hinweis verlagerte gebrauchte Wärme aus den Stunden mit dem besten COP (6,5–6,8 bei 11–14 °C) in kältere Stunden (5,0–5,6 bei 1–6 °C); bei allen Läufen mit Außentemperatur ≥ 11 °C lag mindestens ein Raum unter seiner Bandmitte; am 12.10. fiel Kinderzimmer unten nach dem Hinweis trotz der Läufe unter sein Minimum, die Bewertung zählte trotzdem einen Treffer (der Lauf, den er vermeiden wollte, fand statt). |

#### Quiet-Freigabe (Leistung freigeben) (`quiet_freigabe` v6)

*Zweck:* Hält der Quiet-Deckel den Verdichter fest, obwohl ein echter Bedarf besteht (Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Boost von Hand, seit v3 auch Abtau-Rückstand in Efficiency), wird die Leistung freigegeben: auf die nächste Stufe, deren Deckel genug Mehrleistung zulässt (Daten je Heizregelung × Quiet × Außenband), bei Heizstab-Nähe und ohne Daten auf Quiet 0. Ein Vorlauf unter Soll allein ist kein Bedarf (v1 löste auch bei „Sollvorlauf in diesem Lauf noch nicht erreicht“ aus, also bei jedem langsamen Anlauf). Zurück auf die vorherige Stufe, sobald der Bedarf gedeckt ist. v3 (14.10.2026, Forum 189605): Deckel nie unter der Mindestfrequenz der Außentemperatur (Frost 25/35 Hz); bei Abtauwetter keine Freigabe, die den Verdichter nach langem Niedriglauf um 8 Hz oder mehr anhebt (Pseudo-Abtauung), außer bei Heizstab-Nähe. v4 (15.10.2026, Entscheidung 5): ein Raum mit eigener Nachheizung (Einstellung „eigene Nachheizung“ der Karte Räume, Standard nur Kinderzimmer oben mit Radiator-Relais und Heizlüfter) ist kein Bedarf (Replay 07.–15.10.: der Bedarf „Raum unter Minimum“ kam fast nur aus Kinderzimmer oben); für den Rückweg zählt er weiter (gedeckt erst, wenn auch er Minimum + 0,3 K erreicht). v5 (16.10.2026, Winterpaket, Forum LEISHA_WISSEN (b) 3/4/6): bei Abtauwetter (WP-Außentemperatur −5 bis unter 10 °C und Feuchte ≥ 80 % oder Rohr außen ≤ 0 °C) öffnet die Freigabe im Lauf nur stufenweise (3 → 2 → 1 → 0, je Vorschlag die nächste wirksame Stufe, bei Heizstab-Nähe zwei) mit mindestens 30 min Abstand zwischen zwei Stufen (Expansionsventil: höchstens 30 Halbschritte je 90 s, ~2,5 h bis eingeschwungen, +6 Hz ok, +10 Hz nicht: 4549934, 4886674, 4553013); nach dem Abtauen bleibt Efficiency (Heizregelung v3), den Abtau-Rückstand holt die Freigabe stufenweise auf. Beendet die Anlage Quiet selbst (Flüster-Priorität „Leistung“: Wasser 30 min 5 K unter Soll, 3469566), meldet die Maschine „Anlage hat Quiet beendet“ und gibt 30 min nichts weiter frei. v6 (22.10.2026, wertung-lueften): binnen abtauSperreMin (60 min) nach dem Abtauende keine Freigabe und keine Vergleichslage, außer bei Heizstab-Nähe oder Kälte-Vorsorge (Sperre „Abtauen“ für diese Regel verlängert). Messung 20.10.: nach dem Abtauende 08:48 hielt Efficiency 38 min 16–17 Hz unter dem Quiet-3-Deckel (19 Hz), fuhr 09:26 von selbst auf 20–21 Hz und ab 09:44 wieder auf 17 Hz; der Vorschlag 09:36 war ein Fehlalarm (−13). Der Abtau-Rückstand (abtauNachMin) zählt damit nur noch zusammen mit Heizstab-Nähe.

*Eingänge:* Quiet-Stufe, Verdichterfrequenz und Deckel je Stufe (Messung, Takt-Messung, Mindestfrequenz je Außentemperatur), Soll-/Ist-Vorlauf, Rücklauf und Ziel-Spreizung (Heat_Delta), Laufzeit, Räume (gültig, eigenes Band, Verlauf), Heizstab (Heater_On_Outdoor_Temp, Heater_Start_Delta), Soll von Hand gegen Heizkurve, Abtauen (Ende, Rückstand danach), Daten je Heizregelung × Quiet × Außenband (Takt-Messung), Abtauwetter: OWM-Feuchte, Rohr außen (Outside_Pipe_Temp), Quiet-Senkungen ohne Befehl (Anlage beendet Quiet selbst)

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
| `abtauNachMin` | 30 | min | Abtau-Rückstand (v3): bis 30 min nach dem Ende einer Abtauung zählt ein Vorlauf-Rückstand in Efficiency als Bedarf. Forum 189605: Efficiency hält nach dem Abtauen ~20 min niedrige Frequenz (L5 25 Hz, 4582615; L7 4095732), das Haus kühlte in Abtauserien aus (4096011). Seit v5 (Winterpaket) nur noch für die Quiet-Freigabe (stufenweise), nicht mehr für Comfort (Abtauspirale 4554672). Die ersten 10 min sperrt „Abtauen“ (Forum F6-c: 10–15 min keine Eingriffe); ANNAHME |
| `abtauSperreMin` | 60 | min | v6 (wertung-lueften 22.10.2026): nach dem Abtauende 60 min keine Freigabe (außer Heizstab-Nähe, Kälte-Vorsorge). Messung 20.10. 08:48–09:44 (erste Abtauung, 2–4 °C, Quiet 3, Efficiency): 38 min 16–17 Hz unter dem Deckel (19 Hz), Hochlauf von selbst 09:26 auf 20–21 Hz, 09:44 zurück auf 17 Hz; der Vorschlag 09:36 (48 min nach dem Abtauende) löste sich von selbst (Fehlalarm −13). Forum 189605: Efficiency hält nach dem Abtauen ~20 min niedrig (4582615), Abtauspirale bei Hochlauf nach dem Abtauen (4554672, 4537905). Eine Abtauung: ANNAHME, nachmessen |
| `abtauRueckK` | 3 | K | Abtau-Rückstand: Vorlauf mindestens 3 K unter Soll (Abtauen senkt den Vorlauf um 8–15 K: Forum L5 37 → 22 °C, 4288323; die Anlage startet bei Soll −3,25 K neu, Messung 07.–13.10.); ANNAHME, ohne eigene Abtau-Daten |
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

#### Effizienz-Deckel und Laufzeit (Quiet höher oder Heizkurve +1 K) (`quiet_strecken` v7)

*Zweck:* Zwei Hebel, gewählt nach Lage. Quiet höher (Effizienz-Deckel): läuft der Verdichter ohne Bedarf mit 28 Hz oder mehr – bei belegtem Takt schon ab 22 Hz – (vor allem in den ersten 3 h eines Laufs bei Mildwetter), deckelt die niedrigste Stufe, die laut Messdaten unter 22 Hz hält. v5 (14.10.2026): Nach der COP-Korrektur (+80 W im Lauf, Forum 189605) ist der COP-Vorteil bei 22–27 Hz nicht mehr belegt (−0,3…+4,8 % gegen 16–17 Hz, roh −3…−7 %: das Vorzeichen hängt an der Korrektur), ab 28 Hz bleibt er bei jeder Korrektur zwischen 0 und 80 W negativ (−3 % korrigiert, −5…−15 % roh); 22–27 Hz deckelt die Regel deshalb nur noch, wenn Takt belegt ist (dann zählt die längere Laufzeit). Bei Frost deckelt keine Stufe unter die Mindestfrequenz (≤ −4 °C 25 Hz, ≤ −10 °C 35 Hz, Forum 4593782/4596796): die Schwelle steigt dort auf Mindestfrequenz + 3 Hz. Quiet senkt am Minimum außerdem den Lüfter (−60…−110 U/min, −10…−16 W; ein COP-Unterschied ist dort nicht messbar). Heizkurve +1 K (Laufzeit): läuft der Verdichter schon unter 22 Hz und ist Takt belegt, hilft Quiet nicht; +1 K hebt Abschalt- und Startschwelle (längere Läufe, kürzere Pausen) und kostet Strom, deshalb nur, wenn der geschätzte Nutzen (vermiedene Starts) die Kosten übersteigt. Beide Hebel nie gleichzeitig aus einem Vorschlag. v6 (15.10.2026, Paket 2): ein Raum mit Sonnenfenster in der Sonne (wie Raumeinfluss v5) zählt für +1 K nicht als „über der Bandmitte“ und beendet ein übernommenes +1 K nicht. v7 (16.10.2026, Winterpaket): bei Abtauwetter (−5 bis unter 10 °C, Feuchte ≥ 80 % oder Rohr außen ≤ 0 °C) deckelt Quiet höher nur stufenweise (eine Stufe je Vorschlag); +1 K in der Pause ist ein Startbefehl (Soll-Anhebung umgeht die Einschaltschwelle, Forum 3969412/4131809, 11.10. 19:10) und kommt nur, wenn ein Start gewollt ist (Bedarfsraum unter Minimum, Pause ≥ 20 min, keine Kaltstart-Sperre bei Abtauwetter ≤ 4 °C), sonst nur im Lauf.

*Eingänge:* Quiet-Stufe, Heizregelung, Verdichterfrequenz, Rücklauf-Rückstand, Räume (Bedarf, Verlauf, Luft im Band), Außentemperatur, letzte Läufe (Dauer, Stopp-Art), Pausen, Starts, Daten je Heizregelung × Quiet × Außenband (Takt-Messung: Minuten, COP, gehaltener Deckel), Verschiebung der Anlage (TOP27) und Eigentümer (Arbitrierung)

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `hzHoch` | 28 | Hz | v5 (14.10.2026): Effizienz-Deckel ohne Takt erst ab 28 Hz. Messung 07.–13.10. (Quiet 0, gleiches Außenband, ab Laufminute 15): COP ab 28 Hz gegen 16–17 Hz roh −5…−15 %, mit COP-Korrektur +80 W −3,1 % (≥ 11 °C, 57 min) bzw. +4,8 % (4–8 °C, nur 12 min) – negativ bei jeder Korrektur zwischen 0 und 80 W in dem Band mit genug Daten; 22–27 Hz roh −3…−7 %, korrigiert −0,3…+4,8 % (Vorzeichen hängt an der Korrektur, Messunsicherheit Pth ±10 %). Vorher 22 Hz (Messung roh 13.10.) |
| `hzTakt` | 22 | Hz | mit belegtem Takt deckelt die Regel schon ab 22 Hz (der Nutzen ist dann die längere Laufzeit, nicht der COP); eine Zielstufe deckelt, wenn ihr Deckel (Messung, gelernt oder Mindestfrequenz) unter 22 Hz liegt; Hebel +1 K nur unter dieser Schwelle; Kennzahl „Hochlauf nach Start“ zählt Minuten ab 22 Hz |
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
| `startPauseMin` | 20 | min | v7 (Winterpaket 16.10.2026): +1 K in der Pause ist ein Startbefehl – eine Soll-Anhebung umgeht die Einschaltschwelle (Forum 3969412, 4131809, 3935020; eigene Messung 11.10. 19:10, 10.10. 18:20). Deshalb in der Pause nur, wenn ein Start gewollt ist: Bedarfsraum unter Minimum und Pause seit mindestens 20 min (keine Verkürzung einer frischen Pause; Takt) und keine Kaltstart-Sperre bei Abtauwetter (≤ 4 °C, Sperre „abtausprung“); dann heißt der Vorschlag „startet die Wärmepumpe“. Bis v6: in der Pause nur bei Vorlauf über Soll −2 K (kein sofortiger Start); ANNAHME |
| `haltMin` | 10 | min | wie Quiet-Freigabe |
| `proTag` | 3 | Vorschläge | ANNAHME (v3: 2; ein Effizienz-Deckel je Lauf bei 3–5 Läufen am Tag) |
| `gueltigMin` | 30 | min | ANNAHME |
| `pauseMin` | 120 | min | ANNAHME |
| `maxDauerMin` | 480 | min | Quiet höher: Rückweg spätestens nach 8 h (≈ zwei Zyklen: Median Lauf 184 min, Pausen 57–158 min); früher bei Bedarf, Rücklauf-Rückstand oder ≤ 3 °C; ANNAHME |
| `maxDauerKurveMin` | 360 | min | +1 K: Rückweg spätestens nach 6 h (wie Raumeinfluss und Vorausschau); früher bei Heizstab-Nähe, wenn ein Raum mehr als 0,3 K über die Bandmitte steigt oder der Takt ausbleibt; ANNAHME |
| `kurveTaktZyklen` | 2 | Läufe | +1 K: Rückweg, wenn nach der Übernahme zwei Läufe ohne Takt-Beleg endeten (beide mindestens kurzerLaufMin lang; Regel-Review B5); ANNAHME |
| `bedarfRlK` | 2,5 | K | Rückweg Quiet: Rücklauf-Rückstand ≥ 2,5 K seit 15 min = Leistung wird gebraucht (Quiet 0 lief 07.–13.10. ab 2,5 K immer über 20 Hz) |

*Erwartung:* Quiet höher: Verdichter ≤ 21 Hz binnen 10 min, elektrische Leistung −100 W oder mehr (nach Quiet-Wechseln nach oben fiel die Frequenz binnen 5–15 min, 08.10. 09:38, 12.10. 09:30); COP-Vorteil nur ab 28 Hz belegt (korrigiert +3 %, roh +5…+15 %), darunter zählt die Laufzeit. Heizkurve +1 K: Soll-Vorlauf +1 K binnen 3 min; Lauf länger, Pause kürzer (Messaufgabe, nicht gemessen)

*Rückweg:* Quiet höher: automatisch zurück auf die vorherige Stufe bei Bedarf (Raum unter Minimum oder fallend, Heizstab-Nähe, Boost), bei Rücklauf-Rückstand ≥ 2,5 K seit 15 min, bei Außentemperatur ≤ 3 °C, spätestens nach 8 h. Heizkurve +1 K: zurück auf 0 K bei Heizstab-Nähe (Außen unter Heater_On_Outdoor_Temp + 2 K), wenn ein Raum mehr als 0,3 K über die Bandmitte steigt, wenn zwei Läufe ohne Takt endeten, spätestens nach 6 h.

*Kalibriermessungen (Wirkungsfälle dort zählen 0 Punkte):* 2026-10-08 09:38, 2026-10-12 09:30

#### Raumeinfluss (Heizkurve ±1 K) (`raum_offset` v6)

*Zweck:* Räume wirken nur als langsamer, kleiner Offset auf die Heizkurve (Lambda-Prinzip). Seit v3 (14.10.2026) entscheidet die Regel selbst aus den Räumen (eigenes Komfortband, geglätteter Wert, Verlauf per Regression, Lüften ausgefiltert, Werte bis 6 h alt, weil die Shelly nur bei Änderung melden); der Raumvorschlag der Phase 2 ist nur noch Vergleichskennzahl. +1 K nur bei Bedarf (ein Raum unter Minimum, der sich nicht erholt; seit v4 (15.10.2026, Entscheidung 5) nie aus einem Raum mit eigener Nachheizung (Einstellung „eigene Nachheizung“ der Karte Räume, Standard nur Kinderzimmer oben mit Radiator-Relais und Heizlüfter), bis v3 Kinderzimmer oben nur bei offenem Radiator-Relais; ein solcher Raum zählt weiter für −1 K, den Rückweg von −1 K und den Hinweis Wärmeverteilung), −1 K bei Überschuss (alle Räume mit Reserve über Minimum, einer über Maximum oder alle über der Bandmitte), bevorzugt in der Pause oder bei Vorlauf ≤ Soll, damit auch im Dauerlauf (kalte Nächte 600–970 min ohne Pause). Höchstens 1 K je Befehl. Ein Raum über Maximum und einer unter Minimum ist ein Wärmeverteilungsproblem: dann keine Verschiebung, sondern ein eigener Hinweis (hydraulischer Abgleich/Thermostatventile). Seit v5 (15.10.2026, Paket 2) zählt ein Raum mit Sonnenfenster (Einstellung „Sonnenfenster“ der Karte Räume, Standard Wohnzimmer mit Südwestfenster) nicht als Überschuss für −1 K, solange Sonne anliegt (11–18 Uhr, PV ≥ 20 % der Spitze der letzten 7 Tage oder Bewölkung unter 50 %) und er in den letzten 60 min bei stehender Wärmepumpe oder fallendem Vorlauf gestiegen ist; für Bedarf, Reserve und den Hinweis Wärmeverteilung zählt er immer. Zurück auf 0 K mit Hysterese, wenn der Bedarf gedeckt bzw. die Reserve verbraucht ist, spätestens nach 6 h; seit v5 ruht die Frist von +1 K, solange der Bedarf besteht (höchstens 24 h, dann Hinweis „Heizkurve/Kaltpunkt prüfen“). Stellt nur die Verschiebung, nicht die Heizregelung; Teil der Verschiebungs-Arbitrierung mit Vorausschau und +1 K von „Deckel/Laufzeit“. v6 (16.10.2026, Winterpaket, Forum LEISHA_WISSEN (b) 1): +1 K in der Pause ist ein Startbefehl (die Soll-Anhebung umgeht die Einschaltschwelle: 3969412, 4131809, 3935020; eigene Messung 11.10. 19:10) – in der Pause nur, wenn ein Start gewollt ist (Bedarfsraum unter Minimum UND Pause ≥ 20 min UND keine Kaltstart-Sperre bei Abtauwetter ≤ 4 °C); der Vorschlag heißt dann „startet die Wärmepumpe“. Sonst +1 K nur im Lauf.

*Eingänge:* Räume (Wert, Alter, eigenes Band, Verlauf, Lüften), Raum-Einstellung „eigene Nachheizung“ (Kinderzimmer oben: Radiator-Relais und Heizlüfter, Tab Dashboard), Raum-Einstellung „Sonnenfenster“ (Wohnzimmer) mit PV-Leistung (Venus), OWM-Bewölkung, Uhrzeit, Verdichter und Vorlauf der letzten 60 min, Verschiebung an der Anlage (TOP27) und Eigentümer (Arbitrierung), Soll-Vorlauf, Heizkurve, natürliche Sollsprünge, Vorlauf, Rücklauf, Verdichter (Lauf/Pause), Wirkzeit Raum (gemessen, sonst Annahme), Raumvorschlag Phase 2 (nur Vergleich)

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `stabilMin` | 60 | min | Bedarf bzw. Überschuss muss 60 min am Stück bestehen (Auftrag: lange Haltezeit; Räume reagieren träge, Wirkzeit 1–3 h, Shelly melden erst ab 0,5 K); ANNAHME |
| `raumAlterMaxMin` | 720 | min | Ein Raumwert gilt bis 12 h: die Shelly melden nur bei Änderung, Stille heißt stabil (Regel-Review RE-9; die Phase 2 stand mit 90 min in 41 % der Zeilen auf „Daten unvollständig“). Messung 07.–13.10.: das Wohnzimmer war in 14 % der Minuten älter als 6 h (12 % 6–12 h, 2 % darüber), die Kinderzimmer höchstens 6 h; ANNAHME |
| `kaltK` | 0,2 | K | Bedarf: Raum mindestens 0,2 K unter seinem Minimum (EMA; Phase 2: startK 0,3); ANNAHME |
| `warmK` | 0,2 | K | Überschuss/Verteilung: Raum mindestens 0,2 K über seinem Maximum; ANNAHME |
| `erholKh` | 0,2 | K/h | ein Raum, der schon mit mindestens 0,2 K/h zurück ins Band läuft (Regression), zählt nicht als Bedarf bzw. Überschuss (Phase 2: „in 1 h nicht von selbst im Band“); ANNAHME |
| `reserveK` | 0,5 | K | −1 K nur, wenn der knappste Raum mindestens 0,5 K über seinem Minimum liegt (Review 5.2: Raum −0,5 K ≈ VL −1 K; Phase 2: probeMarginK 0,4); ANNAHME |
| `prognoseH` | 2 | h | −1 K nur, wenn der knappste Raum auch beim jetzigen Gefälle in 2 h noch reserveK − 0,2 K über Minimum liegt (Replay 12.10. 07:40: Schlafzimmer 0,6 K Reserve, fiel bis 09:23 unter Minimum); Wirkzeit 1–3 h; ANNAHME |
| `verteilNotK` | 0,5 | K | Wärmeverteilungsproblem: +1 K trotzdem, wenn der kalte Raum 0,5 K oder mehr unter Minimum liegt (Komfort vor Energie); ANNAHME |
| `verteilMin` | 30 | min | Hinweis „hydraulischer Abgleich/Thermostatventile“, wenn ein Raum über Maximum und einer unter Minimum 30 min am Stück bestehen (Regel-Review RE-8: 12.10. Kinderzimmer unten 600 min über Maximum, Schlafzimmer 160 min unter Minimum); ANNAHME |
| `rueckPlusK` | 0,3 | K | Rückweg +1 K: die Bedarfsräume liegen 30 min am Stück mindestens 0,3 K über Minimum (Hysterese 0,5 K zur Auslösung; wie der Rückweg der Quiet-Freigabe, Regel-Review B2: nur die Bedarfsräume zählen, nicht das Wohnzimmer, das 29–74 % der Zeit über Maximum lag); ANNAHME |
| `rueckMin` | 30 | min | Rückweg +1 K: Bedarf 30 min am Stück gedeckt und frühestens nach der Wirkzeit (gemessen, sonst wirkStdMin); ANNAHME |
| `rueckReserveK` | 0,2 | K | Rückweg −1 K: der knappste Raum liegt 15 min am Stück weniger als 0,2 K über Minimum (Hysterese 0,3 K zur Auslösung), sofort bei Bedarf; ANNAHME |
| `trendMin` | 120 | min | Verlauf je Raum: Regression über 2 h im 5-min-Raster (wie Quiet-Freigabe v2), unabhängig von Lauf und Pause |
| `lueftungK` | 1 | K | Lüften: Sturz um 1 K oder mehr binnen 60 min (wie Quiet-Freigabe und Bewertung); der Raum zählt danach lueftSperreMin nicht als Bedarf, der Verlauf beginnt nach dem Sturz |
| `lueftSperreMin` | 60 | min | nach einem Lüftungssturz 60 min kein Bedarf aus diesem Raum; ANNAHME |
| `lueftKh` | 1 | K/h | fällt ein Raum (Regression über 2 h) mit 1 K/h oder schneller, ist das kein Heizmangel (Auskühlen in der Pause 0,2–0,5 K/h), sondern Lüften oder offene Tür: kein Bedarf (Replay 09.10. 14:27: Wohnzimmer −2,3 K/h im geglätteten Wert); ANNAHME |
| `kurveRuhigMin` | 10 | min | nicht im selben 5-min-Takt schreiben wie die Kurve: 10 min nach einem natürlichen Sollsprung warten (Regel-Review RE-2; 54 Sollwechsel in 5,3 Tagen, alle auf Minute ≡ 0 mod 5, 19 Abstände < 30 min) |
| `startPauseMin` | 20 | min | v6 (Winterpaket 16.10.2026): +1 K in der Pause ist ein Startbefehl (Soll-Anhebung umgeht die Einschaltschwelle, Forum 3969412, 4131809, 3935020; eigene Messung 11.10. 19:10 und 10.10. 18:20: Start sofort). In der Pause deshalb nur als bewusster Start: Bedarfsraum unter Minimum UND Pause seit mindestens 20 min UND keine Kaltstart-Sperre bei Abtauwetter (≤ 4 °C, Sperre „abtausprung“); sonst nur im Lauf; ANNAHME |
| `laufMinusK` | 0 | K | −1 K im Lauf nur bei Vorlauf ≤ Soll + 0 K: danach höchstens +1 K über dem neuen Soll, im ungünstigsten Fall (natürlicher Sollsprung −1 K an der Rundungsgrenze) +2 K; gemessen 07.–13.10.: nach −1 K kein Stopp bis +2,25 K (18 von 18), Stopp ab +2,5 K nach 11–14 min. In Dauerläufen (≥ 300 min, ab Minute 30) lag der Vorlauf in 54 % der Minuten höchstens 1 K über Soll (Regel-Review RE-1). Sonst in der Pause |
| `abtauAtC` | 3 | °C | Regel-Review RE-6: unter 3 °C −1 K nur, wenn der Rücklauf mindestens rlMinC bleibt (Servicehandbuch J: Heizstab beim Abtauen ab Wassereintritt < 27 °C; Forum: die Leisha schaltet den Heizstab dafür nicht mehr zu, 4185332/4879325 – vorsorglich) |
| `rlMinC` | 28 | °C | Rücklauf mindestens 28 °C für −1 K unter abtauAtC (RE-6); ANNAHME |
| `wirkStdMin` | 120 | min | Wirkzeit Raum, solange die Messung (Wirkzeit-Messung, Sollsprung → halbe Raumreaktion, ≥ 3 Ereignisse) fehlt: frühester Rückweg „Bedarf gedeckt“ nach +1 K (Regel-Review RE-10); ANNAHME |
| `kfMinMin` | 180 | min | Kennzahl Kurvenform: Hinweis je Außenband erst ab 3 h Daten mit allen Räumen (7 Tage); ANNAHME |
| `kfAnteil` | 0,5 | Anteil | Kennzahl Kurvenform: Hinweis „Heizkurve kaltseitig senken“, wenn das Haus in einem Band unter 8 °C in mindestens der Hälfte der Zeit Überschuss hat oder −1 K steht (Regel-Review RE-7: dauerhaft gehaltenes −1 K ist eine Kurvenkorrektur; 5.2: bei < 4 °C Kinderzimmer unten 90 % über Maximum); ANNAHME |
| `minVlC` | 29 | °C | Nutzervorgabe 08.10. (bestätigt 13.10.): Soll-Vorlauf nie unter 29 °C (Heizkörper); bei Außen ≥ ~11 °C liegt die Kurve schon dort, −1 K ist dann nicht möglich (Grenze, kein „verpasst“, RE-4) |
| `proTag` | 4 | Vorschläge | Opus: höchstens 6 Schreibbefehle/Tag (gezählt werden übernommene Vorschläge) |
| `gueltigMin` | 120 | min | ANNAHME |
| `pauseMin` | 120 | min | ANNAHME |
| `maxDauerMin` | 360 | min | Rückweg spätestens nach 6 h (Auftrag); seit v5 ruht die Frist von +1 K, solange der Bedarf besteht (Bedarfsraum unter Minimum + rueckPlusK oder noch nicht rueckMin am Stück gedeckt). Anlagen-Zwilling, Frost: sonst +1 K 6 h, 1 h später wieder +1 K (+1/0-Wechsel bei Dauerfrost) |
| `dauerMaxMin` | 1440 | min | Obergrenze der ruhenden Frist: nach 24 h Dauerbedarf mit +1 K gilt die Frist wieder (Rückweg), dazu der Hinweis „Heizkurve/Kaltpunkt prüfen“ (dauerhaft +1 K ist eine Kurvenkorrektur, RE-7); ANNAHME |
| `sonneVonH` | 11 | h | Sonnenfenster: Sonne zählt ab 11 Uhr Ortszeit (Sonnenaufgang Mitte Oktober ~07:45 + 2 h, Südwestfenster; Auftrag: einfach 11–18 Uhr); ANNAHME |
| `sonneBisH` | 18 | h | Sonnenfenster: Sonne zählt bis 18 Uhr Ortszeit (Sonnenuntergang Mitte Oktober ~18:30); danach zählt der Raum normal (nachts bei 24,5–25 °C soll −1 K weiter kommen); ANNAHME |
| `sonnePvAnteil` | 0,2 | Anteil | Sonne liegt an: PV-Leistung (Venus, OPT_en) mindestens 20 % der höchsten PV-Leistung der letzten 7 Tage (07.–15.10.: Spitze ~21 kW, Schwelle ~4,2 kW); ANNAHME |
| `sonneWolkenMax` | 50 | % | Sonne liegt an (ohne PV-Wert oder als zweites Zeichen): OWM-Bewölkung unter 50 %; ANNAHME |
| `sonneAnstiegK` | 0,1 | K | Sonnenfenster: der Raum stieg in den letzten 60 min um mindestens 0,1 K (geglätteter Wert), obwohl der Verdichter mindestens 30 von 60 min stand oder der Vorlauf um mindestens 0,5 K fiel (15.10.: Wohnzimmer 16–20 Uhr 23,6 → 24,75 °C bei stehender Wärmepumpe); gilt 60 min nach dem letzten solchen Anstieg; ANNAHME |

*Erwartung:* +1 K: Soll-Vorlauf +1 K binnen 6 min (5-min-Raster); in der Pause ist +1 K ein Startbefehl (Soll-Anhebung umgeht die Einschaltschwelle, Forum 3969412/4131809; 10.10. 18:20, 11.10. 19:10) und kommt nur als gewollter Start, im Lauf steigt die Stoppschwelle (bei Quiet 0 und Vorlauf unter Soll Hochlauf, 11.10. 03:10: +48 % Strom); Strom +2,5–3 % (8,5 W/K). −1 K: Startschwelle 1 K tiefer (Start bei Soll −3,25 K mit ~9 min Verzug, gemessen), Pause länger, Lauf endet 1 K früher. Raumwirkung: Wirkzeit-Messung, solange sie fehlt nicht gemessen.

*Rückweg:* Automatisch zurück auf 0 K: +1 K, sobald die Bedarfsräume 30 min am Stück ≥ Minimum + 0,3 K liegen (frühestens nach der Wirkzeit); −1 K sofort bei einem Raum unter Minimum oder wenn der knappste Raum 15 min unter Minimum + 0,2 K liegt; spätestens nach 6 h (+1 K: die Frist ruht, solange der Bedarf besteht, höchstens 24 h, dann Hinweis „Heizkurve/Kaltpunkt prüfen“); „Zurücksetzen“ jederzeit.

#### Vorausschau (Heizkurve −1 K) (`vorausschau` v3)

*Zweck:* Senkt die Heizkurve um 1 K, bevor der Wärmebedarf WETTERBEDINGT sinkt (Milderung; Sonne und Wind nur mit freigegebenem Modell, coefActivate; der gewöhnliche Tagesgang ist herausgerechnet, die Uhrzeit allein löst nichts aus), solange alle Räume im Band liegen und der kälteste Raum Luft über seinem Minimum hat. Läuft erst mit offenem Gate des Gebäudemodells, nie gegen den aktuellen Raumzustand und nie gegen eine Verschiebung einer anderen Regel (Arbitrierung). Seit v2 (Review-Paket 13.10.2026) ohne den Zweig +1 K vor erwartetem Mehrbedarf: Die Anlage führt die Heizkurve selbst alle 5 min mit der Fühler-Außentemperatur nach (0,375 K Vorlauf je K, Verzug ≤ 5 min), die Heizkörper haben wenig Speichermasse, und bei Kälte lagen die Räume ohnehin 0,4–1,6 K über ihrer Bandmitte (unter 4 °C Kinderzimmer unten 90 % der Zeit über Maximum); +1 K hätte überheizte Räume weiter geheizt. Unter Quiet 0 löst +1 K bei Vorlauf unter Soll außerdem einen Hochlauf aus (11.10. 03:10: +48 % Strom), die Kosten waren unterschätzt. Nur −1 K zeigt in die Energie-Richtung. v3 (15.10.2026, Entscheidung 2): Bedarfsänderung aus dem Gebäudemodell v3 des Wärmefahrplans, UA · (T_innen − T_außen) − Gewinne (gelernt; bis v2 UA · max(0, 15 °C − T_außen)): zwischen 15 °C und dem Bilanzpunkt (~19–20 °C) zählt eine Milderung jetzt mit; Regel und Schwellen unverändert, eigene Basisrate „vorausschau\|v3“.

*Eingänge:* Wettervorhersage OWM (+1 … +6 h, an den Außenfühler angeglichen), gewöhnlicher Tagesgang (gemessene Außentemperatur bis 7 Vortage), Gebäudemodell v3 des Wärmefahrplans (UA, Bilanzpunkt T_innen − Gewinne/UA, Gate, coefActivate), Sonne (PV-Prognose) und Wind nur mit coefActivate, Räume (alle gültig, eigenes Band), Verschiebung der Anlage (TOP27) und Eigentümer der Verschiebung, Soll-Vorlauf

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

#### Heizregelung (Comfort/Efficiency) (`heizregelung` v3)

*Zweck:* Stellt die Heizregelung (SetHeatingControl 0 = Comfort, 1 = Efficiency). Ziel ist Efficiency, solange alle Räume mit Reserve im Band liegen, kein Heizstab-Risiko besteht und kein Abtau-Rückstand aufzuholen ist. Der Unterschied liegt nur in den trägen Phasen (Messung 07.–14.10.): Comfort fährt nach dem Start sofort 30–35 Hz, Efficiency bleibt bei 16–17 Hz und geht erst ab Laufminute 39–46 zeitweise auf 21–26 Hz; nach dem Abtauen hält Efficiency ~20 min niedrig (Forum 189605: L5 4582615, L7 4095732), Comfort fährt hoch. Bei 16–17 Hz mitten im Lauf ändert ein Wechsel die Frequenz nicht (12.10. 18:28, 13.10. 07:07), nur die Pumpe (Comfort→Efficiency 1750 → 2850–2900 U/min, kein Stopp). Comfort kostet beim Hochlauf COP (ab 28 Hz korrigiert −3 %, roh −5…−15 % gegen 16–17 Hz). Deshalb Comfort nur bei echtem Komfortbedarf (wie Quiet-Freigabe v3: Raum unter Minimum oder auf dem Weg dorthin, Heizstab-Nähe, Abtau-Rückstand, Boost von Hand), solange Efficiency träge ist (Anlaufphase bis Laufminute 45, nach dem Abtauen, Heizstab-Nähe), Vorlauf und Rücklauf Rückstand haben und der Quiet-Deckel den Hochlauf zulässt – bindet der Deckel, zuerst die Quiet-Freigabe (eine Leistungsänderung zur Zeit). Zurück nach Efficiency, wenn der Bedarf 15 min gedeckt ist (Hysterese), spätestens nach 4 h, in beiden Fällen erst in der Pause (im Lauf springt die Pumpe auf 2850–2900 U/min; die Kosten von Comfort entstehen erst beim nächsten Start). Steht Comfort ohne Regel (von Hand), schlägt sie Efficiency vor, sobald der Bedarf 15 min gedeckt ist, der Wechsel von Hand mindestens 2 h zurückliegt, der Quiet-Deckel den Comfort-Hochlauf überhaupt zulässt und der gemessene COP von Efficiency nicht mehr als 10 % unter Comfort liegt. Kein Wechsel in der Startphase; Sperre „Frequenzsprung bei Abtauwetter“ (Pseudo-Abtauung nach langem Niedriglauf). v2 (15.10.2026, Entscheidung 5): Bedarf wie Quiet-Freigabe v4, ein Raum mit eigener Nachheizung ist kein Comfort-Bedarf; für „Bedarf gedeckt“ zählt er weiter. v3 (16.10.2026, Winterpaket, Forum LEISHA_WISSEN (b) 2/3): kein Comfort-Vorschlag binnen 30 min nach dem Abtauende (Comfort fährt nach dem Abtauen sofort hoch, der Verdampfer ist nach 5 min wieder bereift: Abtauspirale 4554672, 4537905), keiner in den ersten 45 Laufminuten bei WP-Außentemperatur ≤ 4 °C (Comfort-Kaltstart: die L fährt dann unabhängig vom Soll mit 67–68 Hz an, Rohr −20 °C, Abtauung nach 35 min: 4005690, 3474343, 4006429) und bei Abtauwetter (−5 bis unter 10 °C, Feuchte ≥ 80 % oder Rohr außen ≤ 0 °C) nur bei Heizstab-Nähe – alles über die Sperre „Frequenzsprung bei Abtauwetter oder Kaltstart“. Der Auslöser „Efficiency träge nach dem Abtauen“ (Abtau-Rückstand als Comfort-Bedarf) entfällt: nach dem Abtauen bleibt Efficiency, die Quiet-Freigabe darf stufenweise öffnen. Rückweg nach Efficiency unverändert (in der Pause).

*Eingänge:* Heizregelung (Heating_Control) und Wechsel von Hand, Verdichterfrequenz, Laufzeit, Lauf/Pause, Soll-/Ist-Vorlauf, Rücklauf und Ziel-Spreizung, Bedarf wie Quiet-Freigabe v4 (Räume ohne eigene Nachheizung, Verlauf, Heizstab-Nähe, Abtau-Rückstand, Boost), Quiet-Stufe und Deckel je Stufe, Heizstab (Heater_On_Outdoor_Temp, Heater_Start_Delta, Heater_Delay_Time), Abtauen (Ende), Räume (Reserve über Minimum), Abtauwetter: OWM-Feuchte, Rohr außen (Outside_Pipe_Temp), WP-Außentemperatur

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `laufMin` | 15 | min | kein Wechsel in der Startphase (Auftrag 14.10.): Pumpenspitze der Startroutine 11–16 min nach jedem Start (Messung 07.–13.10.); Comfort davor brächte nichts, was nicht schon ein Start in Comfort brächte |
| `heizstabVorlaufMin` | 5 | min | wie Quiet-Freigabe: bei Heizstab-Nähe endet die Startphase Heater_Delay_Time − 5 min − Haltezeit (hier Laufminute 7), der Vorschlag kommt 5 min vor der Heizstab-Freigabe; ANNAHME |
| `haltHeizstabMin` | 3 | min | Heizstab-Nähe: kurze Haltezeit (wie Quiet-Freigabe); ANNAHME |
| `traegeMin` | 45 | min | Efficiency träge: Comfort nur bis Laufminute 45 – Efficiency hielt nach dem Start 16–17 Hz und ging erst ab Laufminute 39–46 zeitweise auf 21–26 Hz (5 von 7 längeren Läufen, 07.–13.10.); danach regelt sie bei Rückstand selbst hoch (Boost 10.10. Laufminute 68, Efficiency: Quiet 3 → 0, 29 Hz nach 1 min, 34 Hz nach 2 min). Ausnahme: Heizstab-Nähe (bis v2 auch der Abtau-Rückstand, seit v3 nicht mehr: Abtauspirale); ANNAHME |
| `traegeHz` | 21 | Hz | Efficiency träge = Verdichter höchstens 21 Hz (bei Frost höchstens Mindestfrequenz + 1 Hz, 25/35 Hz ab −4/−10 °C, Forum 189605 F1-a): alle 21 Efficiency-Starts 08.–14.10. mit 16–17 Hz bis Laufminute 15 (davon 9 mit Quiet 0, dort bis Laufminute 30 höchstens 20 Hz), zeitweise 21–26 Hz; Comfort-Starts sofort 30–35 Hz (12.10. 21:32: 35 Hz bei 6 °C, 13.10. 11:58: 31 Hz bei 13 °C) |
| `mehrHz` | 3 | Hz | Quiet-Deckel lässt den Hochlauf zu: Quiet 0 oder Deckel der Stufe mindestens 3 Hz über der jetzigen Frequenz (wie Quiet-Freigabe); sonst bindet der Deckel auch Comfort (13.10. 21:00 Comfort/Quiet 3: 17 Hz; 16:29 Comfort/Quiet 2: 21 Hz) → zuerst die Quiet-Freigabe |
| `vlRueckK` | 1,5 | K | Vorlauf mindestens 1,5 K unter Soll (wie Quiet-Freigabe): ohne Rückstand ändert Comfort die Frequenz nicht (12.10. 18:28 und 13.10. 07:07 Efficiency → Comfort bei 16 Hz am Soll: 16,6 → 16,6 Hz); ANNAHME |
| `rlRueckK` | 1,5 | K | Rücklauf mindestens 1,5 K unter Soll-Rücklauf (wie Quiet-Freigabe: ohne Rücklauf-Rückstand regelt der Verdichter nicht hoch); ANNAHME |
| `hochHz` | 28 | Hz | Bewertung des Wegs nach Efficiency: „Comfort fährt ohne Bedarf hoch“ = Verdichter mindestens 28 Hz ab Laufminute 2 (ab 28 Hz COP gegen 16–17 Hz korrigiert −3 %, roh −5…−15 %; Deckel/Laufzeit v5) |
| `rueckMin` | 15 | min | Bedarf gedeckt (Rückweg bzw. Vorschlag Efficiency): 15 min am Stück kein Bedarf, alle Räume ≥ Minimum + komfortK, Rücklauf höchstens rueckRlK unter Soll, kein Heizstab-Risiko, nicht nach dem Abtauen (Hysterese wie der Rückweg der Quiet-Freigabe; Auftrag); ANNAHME |
| `rueckRlK` | 0,5 | K | Bedarf gedeckt: Rücklauf höchstens 0,5 K unter Soll (wie Quiet-Freigabe); ANNAHME |
| `komfortK` | 0,3 | K | Efficiency nur mit Reserve: alle Räume (Wert bis 6 h alt) mindestens 0,3 K über Minimum (wie notK); ANNAHME |
| `heizstabHystK` | 1 | K | kein Heizstab-Risiko: Außen mindestens Heater_On_Outdoor_Temp + heaterMarginK (2 K) + 1 K, solange Comfort steht (Hysterese wie der Heizregelungs-Hinweis; die alte Warnung flackerte bei 4,0 °C, 74 Ereignisse in 6 Tagen); ANNAHME, keine Frostdaten |
| `abtauNachMin` | 30 | min | nach dem Abtauen 30 min kein Comfort-Vorschlag (v3, Winterpaket: Comfort springt nach dem Abtauen auf 50–68 Hz, der Verdampfer ist nach 5 min wieder bereift, Abtauspirale 4554672, 4537905, 4230879) und – wie bisher – kein Wechsel nach Efficiency (Rückweg unverändert); ANNAHME, ohne eigene Abtau-Daten |
| `kaltstartAtC` | 4 | °C | Kaltstart (v3): bei WP-Außentemperatur ≤ 4 °C kein Comfort in den ersten kaltstartMin Laufminuten. Die L fährt im Comfort bei ≤ +4 °C unabhängig vom Soll mit der Band-Höchstfrequenz an (L7 67–68 Hz, gemessen 76 Hz, Rohr −20 °C, Abtauung nach 35 min: 4005690, 4005591, 3474343); Sprungstelle 4/5 °C (4515271); ein sanfter Start halbiert den Strom (4006429). Eigene Messung: kein Start unter 4 °C bis 16.10. |
| `kaltstartMin` | 45 | min | Kaltstart (v3): Comfort bleibt bis zum Ziel 20–45 min oben (4005690); danach gilt ohnehin traegeMin (Laufminute 45). ANNAHME |
| `heizstabVorrang` | 0 | ja/nein | v3 (Winterpaket): 0 = Heizstab-Nähe übergeht nur die Abtauwetter-Sperre (Comfort bei Abtauwetter nur bei Heizstab-Nähe), nicht „30 min nach dem Abtauen“ und nicht den Kaltstart (Auftrag 16.10. wörtlich); 1 = Heizstab-Nähe übergeht auch diese beiden (Abwägung Heizstab gegen Abtauspirale; Zwilling-Vergleich im Bericht winterpaket/BERICHT.md); Nutzerentscheidung offen |
| `copTol` | 0,1 | Anteil | Veto gegen Efficiency: kein Vorschlag nach Efficiency, wenn ihr COP bei derselben Quiet-Stufe und im selben Außenband mehr als 10 % unter dem von Comfort liegt (nur wenn beide copMinMin Minuten haben, Nutzerentscheidung 13.10.2026; wie das COP-Veto von Deckel/Laufzeit). Stand 14.10.: Comfort Quiet 0 bei 3…11 °C 7–12 % über Efficiency (je 2,3 h, stabile Minuten ab Laufminute 15, korrigiert; nicht belastbar: Tageszeit, Durchfluss 13,6 gegen 15,1 l/min, Pth ±10 %) |
| `nurPause` | 1 | ja/nein | Wechsel nach Efficiency (Vorschlag und Rückweg) nur in der Pause: im Lauf springt die Pumpe in ≤ 1 min von 1750 auf 2850–2900 U/min, Durchfluss 13,4 → 23,0 l/min (08.10. 10:03, 12.10. 22:01), über dem Wunsch des Nutzers (~19 l/min wegen Geräuschen an den Heizkörpern); die Kosten von Comfort entstehen erst beim nächsten Start (Hochlauf 30–35 Hz), mitten im Lauf bei 16–17 Hz ändert der Modus die Frequenz nicht. 0 = auch im Lauf; ANNAHME |
| `handRuheMin` | 120 | min | nach einem Wechsel von Hand (Heizregelung-Schalter) 2 h kein Vorschlag zurück, außer Notfall (Heizstab-Nähe, Raum ≥ 0,3 K unter Minimum): der Nutzer schaltete 08.–13.10. siebenmal selbst (08.10. 10:02, 12.10. 18:26 und 22:00, 13.10. 07:06, 15:29, 15:40, 22:43); kein Pendeln gegen den Nutzer; ANNAHME |
| `haltMin` | 10 | min | wie Quiet-Freigabe: Bedingungen 10 min am Stück (Comfort-Richtung; die Efficiency-Richtung hat ihre 15 min in „Bedarf gedeckt“) |
| `proTag` | 3 | Vorschläge | höchstens 3 übernommene Wechsel je Tag (ein Comfort-Fenster mit Rückweg sind 2 Befehle; die Übernahme begrenzt ohnehin auf 6 Befehle am Tag); ANNAHME |
| `gueltigMin` | 30 | min | wie Quiet-Freigabe; ANNAHME |
| `pauseMin` | 60 | min | wie Mindestabstand; ANNAHME |
| `maxDauerMin` | 240 | min | Comfort-Rückweg spätestens nach 4 h (wie Quiet-Freigabe), aber nicht, solange Bedarf, Heizstab-Nähe oder Abtau-Nachlauf besteht (dann hält Comfort); ANNAHME |

*Erwartung:* Comfort: Verdichter mindestens +6 Hz binnen 5 min, elektrische Leistung +100 W oder mehr (Comfort-Starts 30–35 Hz bei 764–815 W gegen Efficiency 16–17 Hz bei ~400 W, 4–8 °C, 07.–14.10.; ein Wechsel im Lauf mit Rückstand ist nicht gemessen), Pumpe bleibt ΔT-geregelt (~1750 U/min, 13,6 l/min); COP ab 28 Hz korrigiert −3 % (roh −5…−15 %) gegen 16–17 Hz. Efficiency: der nächste Start bleibt bis Laufminute 15 bei höchstens 21 Hz (alle 21 Efficiency-Starts 08.–14.10. mit 16–17 Hz, davon 9 mit Quiet 0); im Lauf springt die Pumpe in ≤ 1 min auf 2850–2900 U/min (08.10. 10:03, 12.10. 22:01; nicht 13.10. 22:45), kein Stopp durch den Wechsel

*Rückweg:* Comfort: automatisch zurück auf Efficiency, sobald der Bedarf 15 min am Stück gedeckt ist (alle Räume ≥ Minimum + 0,3 K, Rücklauf höchstens 0,5 K unter Soll, kein Heizstab-Risiko, nicht binnen 30 min nach dem Abtauen), erst in der Pause; spätestens nach 4 h (ebenfalls in der Pause), solange weder Bedarf noch Heizstab-Nähe noch Abtau-Nachlauf besteht; höchstens 3 Sendeversuche. Efficiency: kein Rückweg (Normalzustand; die Übernahme endet mit der Bestätigung).

*Kalibriermessungen (Wirkungsfälle dort zählen 0 Punkte):* 2026-10-08 10:03, 2026-10-12 22:01, 2026-10-13 15:31, 2026-10-13 22:45

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

### COP: Ziel und Ist (Parameter, `cfg.copZiel` aus cop_eta.json)

| Parameter | Standard | Einheit | Herkunft |
|---|---|---|---|
| `eta` | 0,52 / 0,50 / 0,48 / 0,45 | – | Gütegrad je Außenband < 4 / 4–8 / 8–11 / ≥ 11 °C aus 6 500 stationären Minuten 07.–17.10. (16–20 Hz, Lauf ≥ 25 min, Strom +80 W, dT_verd 4,5 K; cop_physik.md); nachts neu aus cop_eta.json (Container, 16–17 Hz, Lauf ≥ 25 min, ohne Sonne) |
| `kondK` | 2,5 | K | T_kond = Vorlauf + 2,5 K (cop_physik.md) |
| `dTverd` | 4,5 | K | T_verd = Außen − dT_verd; je Band der Median Außen − Rohr außen in den Kalibrierminuten (cop_eta.json, ab 60 Minuten mit Fühler), sonst 4,5 K (gemessen 3,7–4,5 K am Minimum, cop_physik.md) |
| `sprRef` | 2,1 | K | Band-Mittel der Spreizung Vorlauf − Rücklauf am Minimum (Messung 07.–17.10.: 2,05–2,17 K), nachts je Band aus cop_eta.json |
| `sprJeK` | 0,01 | 1/K | Spreizung +1 K bei gleichem Vorlauf ≈ +1 % COP (cop_physik.md) |
| `freq` | 18–20 Hz 0,993 · 21–25 Hz 1 | – | Frequenzfaktor aus den eigenen Minuten (Lauf ≥ 25 min, ohne Sonne) gegen 16–17 Hz, ab 120 Minuten je Bereich, höchstens 1 (Hochlauf wärmt Speichermasse); ohne Daten 1 − 1 %/Hz über 25 Hz (ANNAHME aus Abschnitt 19: „ab 28 Hz −3 %“) |
| `abtau.aMax` | 0,1 | – | Abtaufaktor 1 − aMax · g(AT) · h(Feuchte): g = 1 bis 2 °C, linear auf 0 bei 4 °C, darüber 1 (Forum L5: bei 3 °C mit 25 Hz ohne Abtauung, bei 2 °C alle ~1,5 h, 4066690; eigene Daten 07.–17.10.: keine Abtauung bei 1–9 °C); h = 1 ab 85 %, 0,3 bis 60 % (ANNAHME), ohne Feuchte 1. aMax 10 % = cop_physik (< 2 °C Abtauen −10 %, Forum 5–15 % bei 10–30 Abtauungen/Tag); kalibriert aus den Abtauminuten (cop_eta.json), sobald 5 Abtauungen im Fenster liegen |
| `sonne` | 10–16 Uhr, PV ≥ 30 % der 7-Tage-Spitze: +1…+2 K | K | ANNAHME: Außengerät in Südsonne, Fühler im Schatten (Fühler − OWM +2,6 K bei Sonne, ALGORITHMUS 2); +1 K ab 30 %, +2 K ab 60 % der Spitze. Prüfung: Rest in Sonnenminuten gegen ohne Sonne (Replay, später Zwilling/Messung) |
| `startMin` | 10 | min | Startspitzen: die ersten 10 Laufminuten nach einem Start (Pause ≥ 3 min) zählen ganz als Posten |
| `wdMaxMin` | 30 | min | Wiederaufheizen nach dem Abtauen bis Vorlauf wieder 0,5 K unter dem Wert davor, höchstens 30 min (wie ABZ der Takt-Messung) |

| Posten | Herkunft |
|---|---|
| Abtauen (`abtau`) | Minuten mit Defrosting_State und Wiederaufheizen danach (ganz), abzüglich der im Ziel erwarteten Abtauung (Abtaufaktor) |
| Startspitzen (`start`) | die ersten 10 Laufminuten je Start: Strom über Wärme ÷ Ziel-COP |
| Frequenz über Minimum (`freq`) | Frequenzfaktor der Ist-Frequenz gegen den der Mindestfrequenz bei dieser Außentemperatur |
| Vorlauf über Soll (`vl`) | Carnot mit Ist-Vorlauf gegen Soll-Vorlauf (über Soll = Verlust, unter Soll = Gewinn) |
| Rücklauf/Spreizung (`spr`) | Spreizung Vorlauf − Rücklauf gegen das Band-Mittel (1 %/K) |
| Stillstandsstrom (`stand`) | Strom im Stillstand (Pumpe, Standby), nur im Tageswert |
| Rest (unerklärt) (`rest`) | Abweichung des gemessenen COP vom Modell (Gütegrad, Messfehler, Sonne-Annahme, Übergänge) |

### Sperren, die jede Regel erbt

| Sperre | Text | Herkunft |
|---|---|---|
| `anlauf` | Maschine beobachtet erst seit kurzem (Neustart) | Zeitgeber und Zähler müssen nach einem Neustart erst wieder Daten sammeln (10 min) |
| `daten` | HeishaMon-Daten fehlen oder sind veraltet | HeishaMon meldet laufend; älter als 5 min = veraltet (Wächter: 10 min) |
| `stoerung` | Störung der Anlage (Fehlercode) | HeishaMon Error (TOP44) meldet einen Fehlercode. H23 ist ein L-spezifischer Fehler (Kältemittelfühler Innengerät; Abhilfe Platinentausch über Panasonic, Forum 189605: 3483282, 4130989, 4571850; L5 Bj. 07/2023: 4694333). Solange ein Fehlercode ansteht: keine Vorschläge, keine Übernahme, kein automatischer Rückweg; kein automatischer Reset (Forum F9-a) |
| `mqtt_sperre` | Alle MQTT-Befehle sind gesperrt (MQTT.block_active) | HeishaMoNR-Notbremse; sie friert den Zustand ein (Opus-Review 09.10.) |
| `abtauen` | Abtauen oder kurz danach | Wächter/Quiet-Logik: keine Änderung beim und 10 min nach dem Abtauen (Opus: 10–20 min) |
| `warmwasser` | Warmwasser oder kurz danach | wie Abtauen (diese Anlage macht kein Warmwasser, die Sperre bleibt als Schutz) |
| `sanftanlauf` | Sanftanlauf (HeishaMoNR SoftStart) aktiv | SoftStart verschiebt die Heizkurve selbst |
| `laufbeginn` | Verdichter läuft erst kurz | Start-Pumpenspitze 2900 U/min für 11–16 min bei jedem Start; Quiet wirkt erst nach 1–2 min |
| `heizgrenze_aus` | Heizgrenze-Aus (Pumpe steht) | Heizgrenze 12 °C mit Hysterese: aus ab 15 °C, ein ab 12 °C, Pumpe 0, Vorlauf ohne Aussage |
| `regler` | Ein anderer Regler stellt dieselbe Größe | HeishaMoNR-Quiet-Logik/Scheduler/Solar/WP-Zeitplan bzw. Raumregelung/Nachtabsenkung/Sanftanlauf; Verschiebung nur im Heizkurvenmodus mit Wasserfühler und ohne Handeingriff am Soll |
| `abstand` | Mindestabstand zur letzten Änderung | Wächter: 60 min Abstand; Opus: höchstens 1 Wechsel pro Stunde; seit 13.10. über Quiet und Verschiebung gemeinsam (Regel-Review 3.4: sonst ist keine Wirkung zuzuordnen und Freigabe und +1 K heizen doppelt), seit 14.10. auch über die Heizregelung (Comfort/Efficiency ändert die Leistung beim Start und nach dem Abtauen). Ein Notfall der Quiet-Stufe oder der Heizregelung (Heizstab-Nähe, Raum ≥ notK unter Minimum) überbrückt ihn nach notfallMin (10 min; Regel-Review B4) |
| `tageslimit` | Tageslimit der Regel erreicht | Schreibbudget (Opus: höchstens 6 Wechsel/Tag), EEPROM-Verschleiß unbekannt. Seit 13.10. zählen bei Befehlsregeln nur übernommene Vorschläge (Regel-Review R5: Vorschläge in der Nacht ohne Klick verbrauchten sonst das Kontingent für den Tag; die Übernahme begrenzt ohnehin auf 6 Befehle am Tag); ein Quiet-Notfall ist ausgenommen |
| `abkuehlzeit` | Wartezeit nach dem letzten Vorschlag | kein Flattern: ein abgelaufener oder zurückgezogener Vorschlag kommt erst nach einer Pause wieder; ein Quiet-Notfall nach notfallMin (10 min), außer der vorige Notfall-Vorschlag ist nur abgelaufen (nachts klickt niemand, sonst käme derselbe Vorschlag alle 40 min) |
| `takt` | Takt-Gefahr: Vorlauf über Soll | Anlage schaltet bei Vorlauf ≥ Soll +3,25 K nach ~3 min ab (6 Stopps 07.–10.10.); Sperre ab Soll +1 K für Maßnahmen, die den Vorlauf näher an diese Grenze bringen (mehr Leistung, −1 K). −1 K im Lauf also nur bei Vorlauf ≤ Soll: danach höchstens +1 K über dem neuen Soll, im ungünstigsten Fall (natürlicher Sollsprung −1 K an der Rundungsgrenze der Kurve, Regel-Review RE-2) +2 K; gemessen 07.–13.10.: nach einem Sollsprung −1 K kein Stopp bis +2,25 K (18 von 18), Stopp ab +2,5 K nach 11–14 min, ab +3,25 K nach 3 min |
| `abtausprung` | Frequenzsprung bei Abtauwetter oder Kaltstart | Pseudo-Abtauungen: läuft der Verdichter lange niedrig und dreht dann hoch, reißt das Abtaukriterium ohne Vereisung (Forum 189605: L5 4540566, L7 4230252 und 4581423; Sprung > +30 % als Gefahr 4868882, Vermutung); bis 9 °C beobachtet, über 10 °C nie (4011622, 3456847, 4466101). Abtauwetter (Winterpaket 16.10.2026) = Fühlerwert der WP −5 °C bis unter 10 °C UND (OWM-Feuchte ≥ 80 % ODER Rohr außen ≤ 0 °C); ohne Feuchte und Rohrwert wie bisher −5…+4 °C. Dann: (1) nach mindestens 60 min mit höchstens 20 Hz keine Maßnahme, die den Verdichter um 8 Hz oder mehr anhebt (+6 Hz meist ohne Einbruch, +10 Hz eher nicht: 4553013; das Expansionsventil öffnet höchstens 30 Halbschritte je 90 s und braucht ~2,5 h zum Einschwingen: 4549934, 4886674); (2) Quiet-Freigabe nur stufenweise (3 → 2 → 1 → 0, Heizstab-Nähe zwei Stufen) mit stufeMin 30 min Abstand; (3) Comfort (Heizregelung) nur bei Heizstab-Nähe, nie binnen 30 min nach dem Abtauen und nie in den ersten 45 Laufminuten bei WP-Außentemperatur ≤ 4 °C (Comfort-Kaltstart 67–68 Hz, Rohr −20 °C, Abtauung: 4005690, 3474343, 4006429); (4) +1 K in der Pause (Startbefehl) nicht bei ≤ 4 °C; (5) 30 min nach „Anlage hat Quiet beendet“ (Flüster-Priorität „Leistung“, 3469566) keine weitere Freigabe. Heizstab-Nähe ist bei (1), (3) und (5) ausgenommen |
| `heizstab` | Heizstab-Nähe | Heizstab ab Außentemperatur < Heater_On_Outdoor_Temp (0 °C) bei Vorlauf < Soll −3 K nach 15 min; ein +1-K-Schritt vergrößert den Rückstand sofort um 1 K |
| `modell` | Gebäudemodell noch nicht freigegeben | Wärmefahrplan: Gate des Gebäudemodells (≥ 10 Tage, Fehler mit Sonne/Wind ≥ 10 % kleiner als beim Grundmodell UA · (T_innen − T_außen) − Gewinne, Leave-one-day-out; plausible Koeffizienten); vorher ist eine Bedarfsvorhersage nicht belegt |
| `vorrang` | Die Stellgröße gehört einer anderen Regel | Arbitrierung je Stellgröße (Heizkurven-Verschiebung: Raumeinfluss, Vorausschau, +1 K von „Deckel/Laufzeit“; Quiet: Quiet-Freigabe, Deckel/Laufzeit): je Zeit hat genau eine Regel die Größe (laufender Vorschlag oder übernommener Wert); keine zweite Regel schlägt daneben oder dagegen vor. Quiet: eine übernommene Stufe weicht nur einem Notfall (Raum ≥ notK unter Minimum oder Heizstab-Nähe), frühestens notfallMin (10 min) nach der Übernahme (Regel-Review B4; vorher 60 min). Leistung (seit 14.10., Heizregelung): eine Leistungsänderung zur Zeit – läuft ein Quiet-Vorschlag, wartet Comfort (zuerst Quiet: der Quiet-Deckel bindet auch Comfort, 13.10. 21:00 Comfort/Quiet 3: 17 Hz); läuft ein Heizregelungs-Vorschlag oder steht Comfort der Regel, schlägt der Effizienz-Deckel nicht vor |
| `gegenrichtung` | Gegenrichtung zur letzten Änderung | Kein Hin und Her: Gegenrichtung frühestens shiftHaltMin bzw. quietHaltMin (60 min) nach dem Ende der letzten Änderung derselben Größe und nur mit Notfall (Verschiebung: Raum ≥ notK 0,3 K außerhalb des Bandes; Quiet: Raum ≥ notK unter Minimum oder Heizstab-Nähe, dort schon nach notfallMin 10 min), ohne Notfall erst nach gegenMin bzw. quietGegenMin (240 min); Heizregelung wie Quiet (hcHaltMin 60, hcGegenMin 240 min, Notfall nach 10 min); ANNAHME |

*Sperr-Parameter (Standard):* `hpMaxAgeMin` 5 · `afterDefrostMin` 10 · `afterDhwMin` 10 · `startLockMin` 15 · `gapMin` 60 · `taktK` 1 · `stopK` 3,25 · `heaterMarginK` 2 · `warmupMin` 10 · `pumpOnRpm` 1000 · `kurveTolK` 1,5 · `shiftHaltMin` 60 · `gegenMin` 240 · `notK` 0,3 · `quietHaltMin` 60 · `quietGegenMin` 240 · `hcHaltMin` 60 · `hcGegenMin` 240 · `notfallMin` 10 · `abtauAtMin` -5 · `abtauAtMax` 10 · `abtauNiedrigMin` 60 · `abtauNiedrigHz` 20 · `sprungHz` 8 · `abtauRhMin` 80 · `abtauRohrC` 0 · `abtauAtOhne` 4 · `stufeMin` 30 · `anlQK` 5 · `anlQMin` 25 · `anlQSperreMin` 30

### Whitelist der Übernahme

| Befehl | Topic | erlaubte Werte | Rücklesen |
|---|---|---|---|
| `SetQuietMode` | `panasonic_heat_pump/commands/SetQuietMode` | 0, 1, 2, 3 | Quiet-Stufe |
| `SetZ1HeatRequestTemperature` | `panasonic_heat_pump/commands/SetZ1HeatRequestTemperature` | -1, 0, 1 | Heizkurven-Verschiebung (nur Heizkurvenmodus TOP76 = 0, Wasserfühler TOP111 = 0) |
| `SetHeatingControl` | `panasonic_heat_pump/commands/SetHeatingControl` | 0, 1 | Heizregelung (0 Comfort, 1 Efficiency) |

*Übernahme-Grenzen:* `maxAlterMin` 2,5 · `hpMaxAgeMin` 5 · `abstandMin` 10 · `proTag` 6 · `doppelMs` 120000 · `rueckleseS` 90 · `wiederholungen` 2 · `rueckwegVersuche` 3 · `engMaxAlterMin` 5 · `engAbbruchMin` 30

### Bewertungsregeln (Version 6)

| Größe | Wert |
|---|---|
| Punkte je Horizont | 100 × [(b − o)² − (p − o)²] / Anzahl Horizonte |
| Basisrate b | aus Vergleichslagen „bleibt, wie es ist“, (k + 1)/(n + 2), erst ab 5 Vergleichen, vorher 0,5 |
| Mindestbeobachtung je Horizont | 0,5 des Horizonts, sonst neutral |
| Problem besteht / gelöst | ≥ 80 % / ≤ 20 % der gültigen Minuten, dazwischen neutral |
| Wirkungsprognose | je Größe ±10, nicht messbar 0, Kalibriermessung 0; seit v6 Naturexperiment (Änderung ohne übernommenen Vorschlag der Regel, z. B. von Hand) 0 Punkte, getrennt gezählt |
| Schaden | sperre_verletzt -50, heizstab -50, stopp10 -30, ueberschwingen -30, zu_warm -20, zu_kalt -20 |
| Verpasst | -20 (gezählt werden nur Minuten, in denen die Regel nicht durch eine eigene Sperre zurückgehalten wurde) |
| Verpasst während eigener Sperre (seit v2) | 0 Punkte, getrennt gezählt (`verpasst_sperre`); eigene Sperren: Mindestabstand (`gapMin`), Tageslimit (`proTag`), Wartezeit (`pauseMin`), Haltezeit (`haltMin`), Stabilitätszeit (`stabilMin`); nur soweit sie auch mit dem Standardwert bestanden hätten |
| Schaden hebt die Entschuldigung auf (seit v2) | quiet_freigabe: Raum > 1 K unter Minimum; quiet_strecken: Verdichter stoppt, Vorlauf ≥ Soll +3,25 K; raum_offset: Raum > 1 K unter Minimum; heizregelung: Raum > 1 K unter Minimum,  → verpasst -20 |
| Gegenregel-Sperren (seit v3) | 0 Punkte wie eigene Sperren: `vorrang`, `gegenrichtung` (Arbitrierung der Verschiebung, seit 13.10. auch der Quiet-Stufe; nur mit den Standardwerten `shiftHaltMin`/`gegenMin` bzw. `quietHaltMin`/`quietGegenMin`); schlägt eine andere Verschiebungs-Regel für die Lage dieselbe Richtung vor, gilt sie als versorgt |
| Basisrate je Auslösung (seit 13.10.) | Regeln mit neuer Auslösung lernen ihre Basisrate unter eigenem Schlüssel neu: `quiet_freigabe|v2`, `quiet_strecken|v5` und `quiet_strecken|v4|kurve` (Hebel +1 K), `raum_offset|v3` und `raum_offset|v5|minus` (−1 K), `vorausschau|v3`, `heizregelung|v3` und `heizregelung|v1|eff` (−1 K); die Vergleichslagen folgen der neuen Auslösung (Freigabe: am Deckel der Stufe mit Rückstand und Bedarf; Deckel: ab der Schwelle der Regel – v5: 28 Hz, mit Takt 22 Hz – ab Laufminute 15 über 3 °C; +1 K: Takt belegt unter 22 Hz; Raumeinfluss v3: Raumlage ohne Haltezeit, je Richtung). Die alten Basisraten bleiben unter ihrem Schlüssel stehen |
| Zuordnung (seit v3) | Fälle gehören der Regel, die vorgeschlagen hat; die Wirkung einer übernommenen Verschiebung zählt für die Regel, deren Vorschlag übernommen wurde; für alle anderen offenen Fälle ist die Übernahme ein Eingriff (neutral, seit 13.10. auch bei Quiet mit Urheber im Text) |
| Hinweis-Regeln (seit v4) | keine Punkte: Treffer, Fehlalarm, neutral und Schaden werden gezählt und angezeigt, Punkte, Brier-Skill und Freigabereife entfallen („–“), nicht im Diagramm (seit dem Review-Paket 13.10. keine aktive Hinweis-Regel) |
| Brier-Skill (seit v4) | 1 − ΣBS/ΣBS_ref nur aus vollständig abgeschlossenen Fällen (ein offener Fall verändert ihn nicht), erst ab 3 bewerteten Fällen, vorher „–“; seit v5 nur Fälle mit Brier-Beitrag (mindestens ein Horizont nicht neutral) |
| Basisrate ≥ Prognose (seit v5) | je Horizont mit b ≥ p: Treffer neutral (0 Punkte, kein Beitrag zum Skill, Kennzahl „davon … Treffer neutral“); Fehlalarm Abzug gegen b = 0,5: 100 × [0,5² − p²] (p 0,7 → −24, p 0,8 → −39, geteilt durch die Anzahl Horizonte); b < p: Brier wie oben |
| Raumwerte in der Bewertung | bis 360 min alt (Shelly melden nur bei Änderung) |
| Eingriffe (Bewertung wird ab dort neutral) | Quiet, Verschiebung oder Soll (≥ 2 K) geändert; Komfortband geändert; Lüftungsverdacht (Raum fällt ≥ 1 K in ≤ 60 min) |
| Fremdursachen der Raum-Gegenprobe (seit v6) | Lüftungsverdacht auf dem geglätteten Raumwert ab 0,6 K in ≤ 60 min (≈ ≥ 1 K Rohwert; Räume mit eigener Nachheizung ab 1 K), im ganzen Horizont und mit 60 min Vorgeschichte; „gelöst“ (o = 0) ist neutral, wenn vor der Lösung bei +1 K mindestens 30 min Sonne (Sonnenzeichen der Regel) bzw. bei −1 K mindestens 30 min Heizgrenze-Aus lag; gilt auch für die Vergleichslagen der Basisrate |
| Freigabereife: Wirkung (seit v6) | Wirkungsfälle aus Übernahmen und Naturexperimente desselben Befehls (ohne die Gegenprobe „ohne Bedarf“) zählen zusammen, getrennt ausgewiesen; Naturexperimente bringen keine Punkte |
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
- Seit 14.10. (Heizregelung): `abl.hc` = Lage +1 (Comfort-Bedarf in Efficiency: Bedarf, träge, Rückstand, Quiet lässt zu, nach der Startphase) bzw. −1 (Comfort ohne Bedarf seit 15 min, Quiet lässt den Hochlauf zu, kein COP-Veto), nur wenn nicht 0; `abl.hc_deck` = Minuten „Bedarf gedeckt“ in Comfort. In Efficiency ohne Bedarf steht die Regel kurz auf „ruht: Efficiency ohne Bedarf“ (Datensatzgröße).
- `naechste` steht als Felder im Datensatz: `b` ist die Bedingung, `ist`, `s` (Schwelle), `abstand`, `weitere` (weitere fehlende Bedingungen), `halt` (Haltezeit danach) und `bis` (Ende einer Sperre). Der Satz „würde schalten, sobald …“ entsteht daraus in der Anzeige.
- Der Vorschlag selbst steht im Zustand und in `OPT_engine.prop` mit den Feldern `id`, `rule`, `ver`, `cmd {name, topic, value}`, `von`, `was`, `warum`, `wann`, `erwartung`, `bis`, `rueckweg` und `sum` (FNV-1a-Prüfsumme über ID, Regel, Version, Topic, Wert, Ausgangswert, Zeit, Gültigkeit).

## 6. Punktesystem (automatisch, ohne Nutzereingabe)

Der Nutzer vergibt keine Punkte. Auch „Verwerfen“ ist keine Bewertung: der Bewertungsteil des Kerns kennt weder Klicks noch den Übernahme-Zustand, ein Test prüft das. Alle Regeln stehen vorab fest (`SCORE_VER` 5 seit 12.10. abends; v4 ab 12.10., v3 ab 11.10., v2 ab 10.10. abends, v1 bis dahin). Jede Änderung erhöht die Version, Punkte verschiedener Versionen bleiben getrennt:
- Die Summen stehen je Regel, Regelversion und Bewertungsversion im Zustand (`regel|v1` = v1 unverändert, `regel|v1|s2` = v2, `…|s3` = v3, `…|s4` = v4, `…|s5` = v5). Alte Punkte werden nicht neu gerechnet; die Kachel und das Diagramm zeigen nur die aktuelle Version (Freigabereife und Tage zählen ab dem Wechsel neu).
- Fälle und Wirkungsmessungen, die vor dem Wechsel begannen, werden mit ihrer Version zu Ende bewertet.
- Nachrechnen mit den alten Regeln: `cfg.sv = 1` … `4` bzw. `node tools/engine_replay.js <Daten> --sv1` (`--sv2`, `--sv3`, `--sv4`). Die Entscheidungen sind in beiden Versionen gleich, nur `sv` im Datensatz und die Bewertung unterscheiden sich (Test).

**Änderung v5 → v6 (22.10.2026, wertung-lueften, Go des Nutzers 22.10.):** Befund live: Raumeinfluss v6 stand bei −85,3 Punkten (12 Fälle, 3 Fehlalarme), Quiet-Freigabe bei −3 (ein Fehlalarm −13, dazu +10 „Wirkung“ aus einem Quiet-Wechsel von Hand). Bericht und Vorher/Nachher-Tabelle: `heishamonr-optimizer/wertung-lueften/BERICHT.md`.

- **Lüften auf dem geglätteten Wert.** Die Maschine sieht je Raum den EMA-Wert (τ 30 min). Ein Rohwert-Sturz von 1 K in ≤ 60 min erscheint dort als 0,6–0,86 K. Messung 14.–22.10. (optimizer-v2, Rohwert gegen EMA): 28 Rohwert-Stürze ≥ 1 K, 26 davon im EMA 0,60–2,15 K, 14 davon unter 1,0 K – die sah v5 nicht (z. B. Schlafzimmer 21.10. 02:34–03:19 roh 22,12 → 21,00, EMA 0,81). Seit v6 gilt `SCORE.lueftungEmaK` 0,6 K, für Räume mit eigener Nachheizung weiter 1 K (ihr Relais bewegt sie im EMA um 0,6–0,7 K, 4 von 7 Fehltreffern der 0,6-K-Schwelle). Der Raumverlauf der letzten 60 min vor dem Fall zählt mit (`lueftVorMin`): ein Sturz, der vor dem Fall beginnt und danach weitergeht, ist Lüften. Der Lüftungsverdacht galt schon bisher im ganzen Horizont; er verpasste die Fälle wegen der Glättung und der fehlenden Vorgeschichte, nicht wegen des Zeitpunkts.
- **Sonne bei +1 K, Heizgrenze-Aus bei −1 K.** Ein Horizont mit o = 0 ist neutral, wenn vor der Rückkehr ins Band mindestens 30 min das Sonnenzeichen der Regel anlag (11–18 Uhr, PV ≥ 20 % der 7-Tage-Spitze oder Bewölkung < 50 %; 20.10. 10:17: Schlafzimmer 19,6 °C, PV 5–14 kW) bzw. bei −1 K mindestens 30 min Heizgrenze-Aus. Eine normale Taktpause ist keine Fremdursache (die Verschiebung hätte sie verlängert).
- **Gleiche Gegenprobe für die Vergleichslagen** der Basisrate (sonst wäre b systematisch zu niedrig). Die Schlüssel der Basisrate bleiben; alte Vergleichslagen (v5) laufen aus.
- **Kein Weichspülen:** ein Haus, das ohne Fremdursache aus dem Überschuss kommt, bleibt Fehlalarm (live 21.10. 11:27: Wohnzimmer sank am Nachmittag bei Bewölkung 100 % unter die Bandmitte, −16 bleibt). Treffer werden durch die neuen Fremdursachen nicht neutral, nur Lüften (wie bisher) neutralisiert beide Richtungen.
- **Naturexperimente:** Eine Änderung ohne übernommenen Vorschlag dieser Regel (Quiet, Verschiebung, Heizregelung von Hand) wird weiter gemessen, aber getrennt gezählt (`naturN`, `naturP`, Punktebuch `naturexperiment: 1`) und bringt 0 Punkte. Für die Freigabereife („≥ 2 Wirkungsfälle“) zählen Naturexperimente desselben Befehls getrennt ausgewiesen mit („Wirkung 0 + 2 nat./2“), die Gegenprobe „Quiet ohne Rückstand“ nicht. Grund: Abschnitt 6 (2) wollte Wechsel von Hand ausdrücklich als Messung; als Regel-Wirkung verfälschten sie Summe und Reife (Replay 07.–22.10.: Quiet-Freigabe +50 aus 5 Wechseln von Hand bei 0 Treffern).
- **Quiet-Freigabe v6:** 60 min nach dem Abtauende keine Freigabe und keine Vergleichslage (`abtauSperreMin`), außer bei Heizstab-Nähe oder Kälte-Vorsorge. Messung 20.10.: Abtauende 08:48, Efficiency hielt 38 min 16–17 Hz unter dem Quiet-3-Deckel (19 Hz), fuhr 09:26 von selbst auf 20–21 Hz, 09:44 wieder 17 Hz; der Vorschlag 09:36 war ein Fehlalarm. Der Abtau-Rückstand (`abtauNachMin` 30) zählt damit nur noch zusammen mit Heizstab-Nähe.
- `cfg.sv = 5` rechnet v5 nach (Replay, Tests).

**Änderung v4 → v5 (12.10. abends, Entscheidung des Nutzers: Weg b):** Bei Befehlsregeln lag die feste Prognose p oft unter der gelernten Basisrate b „bleibt, wie es ist“; dann kostet jeder Treffer Punkte (Replay 07.–12.10.: Raumeinfluss 6 von 7 Treffern, aber −9,74 bei b 0,77–0,92 gegen p 0,7; 5-Tage-Kälte-Sim: Quiet-Freigabe 15 Treffer, 0 Fehlalarme, −71; Raumeinfluss 14 Treffer, −122).
- **Treffer bei b ≥ p** (je Horizont): **neutral**, 0 Punkte, kein Beitrag zu ΣBS/ΣBS_ref (keine Trennschärfe messbar). Horizont-Feld `bp: "neutral"`, im Punktebuch-Text „Basisrate 0,92 ≥ Prognose 0,70: neutral“. Sind alle Treffer-Horizonte eines Treffer-Falls neutral, zählt er in der Kennzahl `trefferNeutral` (Kachel: „davon n Treffer neutral (Basisrate ≥ Prognose)“, Replay-Tabelle: „Treffer (davon neutral)“).
- **Fehlalarm bei b ≥ p**: **voller Abzug**. Die Brier-Formel gäbe hier ein *Plus* (b liegt weiter vom Ergebnis 0 entfernt als p; Replay: Raumeinfluss 10.10. 10:26 „Raum wieder im Band“ +12,63 unter v4). Deshalb wird er gegen b = 0,5 gerechnet (`SCORE.fehlRefB`, wie vor dem Lernen der Basisrate): 100 × (0,25 − p²), p 0,7 → −24, p 0,8 → −39 (geteilt durch die Anzahl Horizonte), und geht so in den Skill ein (`bp: "abzug"`). Das ist meine Auslegung von „Fehlalarme bleiben voll im Abzug“; Alternativen siehe Abschnitt 12.
- **b < p**: Brier wie bisher (Test: identisch mit v4).
- **Kein Gaming** bleibt erhalten: ohne Trennschärfe (Ergebnis-Häufigkeit = b) ist der Erwartungswert ≤ 0, bei b ≥ p sind nur Abzüge möglich (Test für b 0,1…0,99, p 0,6…0,8).
- **Skill** erst ab 3 Fällen **mit Brier-Beitrag** (mindestens ein nicht neutraler Horizont; `skillFaelle`). Folge für die Freigabereife siehe Abschnitt 12.
- Fälle, die unter v4 begannen, enden mit v4 (Test). v5-Summen beginnen bei 0. Nachrechnen: `cfg.sv = 4` / `--sv4`.

**Änderung v3 → v4 (12.10., Befund auf der Seite):** Die Kachel „Heizgrenze“ zeigte „1 Fall · 1 Treffer · 0 Fehlalarm“, aber −14,0 Punkte und Skill −6,84. Nachgerechnet: Ergebnis o = 1, Prognose p = 0,6, Basisrate b ≈ 0,857 → 100 × [(0,857 − 1)² − (0,6 − 1)²] = 100 × (0,0204 − 0,16) = −14,0; Skill = 1 − 0,16/0,0204 = −6,84. Die Mathematik stimmt. Aber p ist eine Annahme unter der echten Basisrate, also kann ein Treffer nie positiv punkten; die Regel ist nur ein Hinweis, und ein Skill aus einem Fall ist wertlos. Dieselbe Ursache hatte „Skill −25,01 bei 0 Fällen“ beim Raumeinfluss: bis v3 wuchsen ΣBS und ΣBS_ref schon beim Abschluss einzelner Horizonte, der Fall zählte erst nach allen.
- **Hinweis-Regeln** (`art` „hinweis“; der einzige, der Heizgrenze-Hinweis, ist seit dem Review-Paket stillgelegt) sammeln keine Punkte. Treffer, Fehlalarm, neutral und Schaden werden weiter gezählt und im Punktebuch mit Ergebnis und Basisrate geschrieben (0 Punkte, „nur Hinweis, keine Punkte“). Punkte, Skill und Freigabereife entfallen („–“), die Regel steht nicht im Diagramm.
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

## 7. Comfort/Efficiency: Befund (Messaufgabe gestrichen 13.10.)

Die Messaufgabe Comfort/Efficiency (Minuten mit Quiet 0, ab Laufminute 15, Vorlauf ≥ 2 K unter Soll, je Heizregelung, Befund mit 0 Punkten) ist im Review-Paket gestrichen (REVIEW.md 4.5): Sie schloss genau die Startphase aus, in der sich die beiden Heizregelungen unterscheiden, und blieb deshalb offen (07.–13.10.: Efficiency 66 min, Comfort 0 min, obwohl seit 12.10. abends rund 7 h in Comfort liefen). Der Kern sammelt nichts mehr dafür (`sc.mess` wird beim Laden entfernt), der Beobachter auch nicht.

**Befund aus den Echtdaten (07.–13.10.):**
- **Comfort** fährt nach dem Start sofort hoch: **30–35 Hz**.
- **Efficiency** bleibt nach dem Start bei **16–17 Hz** und geht erst ab Laufminute **39–46** vorübergehend auf **21–26 Hz**.
- Ein Wechsel der Heizregelung **im Lauf** lässt die Pumpe von **1750 auf 2850–2900 U/min** springen (Hydraulik, nicht Heizleistung).
- Das Plateau bei 33–34 Hz im Boost am 10.10. (Efficiency, Quiet 0) bleibt ein Einzelfall.

**Kennzahl:** „Hochlauf nach Start“ in der Karte „Messwerte & Lernen“ (Abschnitt 9) misst genau diesen Unterschied: Minuten mit ≥ `hzHoch` (22 Hz) in den ersten Laufminuten, getrennt nach Comfort und Efficiency, 7 Tage (Replay 07.–13.10.: Comfort 50 min bei 3 Starts, Efficiency 26 min bei 19 Starts). Der Tooltip der Kachel nennt den Befund.

**Nutzerregel:** Bis 12.10. galt „keine Comfort/Efficiency-Wechsel wegen Räumen“. Seit 13.10. gilt „wir schalten so, wie es am effizientesten ist“. Seit 14.10. gibt es die Regel „Heizregelung“ (Abschnitt 21); der Heizregelungs-Hinweis (Abschnitt 4, 18.5) bleibt als Anzeige.

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
   - Whitelist und Wertebereich: `SetQuietMode` 0–3, `SetZ1HeatRequestTemperature` −1…+1, seit 14.10. `SetHeatingControl` 0/1 (Rücklesen über `Heating_Control`), nichts sonst
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
   | Heizregelung, Comfort (v1) | zurück auf Efficiency, sobald der Bedarf 15 min gedeckt ist (Räume ≥ Minimum + 0,3 K auch in 2 h, Rücklauf ≤ 0,5 K unter Soll, kein Heizstab-Risiko, nicht binnen 30 min nach dem Abtauen), erst in der Pause; Frist 4 h, sie ruht, solange Bedarf, Heizstab-Nähe, Abtau-Nachlauf oder ein Lauf besteht |
   | Heizregelung, Efficiency (v1) | keiner: Normalzustand, die Übernahme endet mit der Bestätigung der Anlage („Übernommen …: Efficiency · Normalzustand“ bis dahin) |
   | Quiet-Freigabe (v2) | auf die Ausgangsstufe, sobald der Bedarf 15 min gedeckt ist oder ein Bedarfsraum 15 min über seinem Maximum liegt (andere Räume über Maximum zählen nicht); Frist 4 h, sie ruht, solange Bedarf besteht oder die Kälte-Vorsorge hält (v1: kein automatischer Rückweg) |

   Rechnet die Maschine nicht mehr (älter als 5 min), gelten ihre Gründe und `halten` nicht, nur die Frist; nach 30 min ohne Rechnung geht jede bestätigte Übernahme auf ihren Ausgangswert zurück („sicherer Abbruch“, Review B7). „Zurücksetzen“ ist jederzeit möglich, außer bei Notbremse; es stellt alle Übernahmen nacheinander zurück. Der Rückweg macht bis zu 3 Versuche. Bleibt er unbestätigt, endet das automatische Senden mit roter Warnung (seit 13.10.; vorher startete er alle 4,5 min neu, 76 Befehle in 2 h); „Zurücksetzen“ von Hand geht weiter, meldet die Anlage später den Ausgangswert, endet die Übernahme.
9. **Neustart** mitten in der Übernahme: Der Zustand liegt in `apply-state.json`. Rücklesen und Rückweg-Timer laufen weiter. Es wird nichts doppelt gesendet, solange die Anlage den Wert meldet.
10. **Not-Aus im Dashboard:** „Übernahme sperren“ setzt `apply.json` → `enabled: false`. **Entsperren geht nie über das Dashboard**, nur über die Datei.
11. **Protokoll:** Jede Aktion steht in `applied-YYYY-MM.jsonl`, auch Ablehnungen mit Grund, und zusätzlich als `optimierer_*` in `quiet-events`.

### Freigabe (nur mit Go des Nutzers)

1. Der Nutzer entscheidet je Regel, z. B. nach der Freigabereife-Anzeige.
2. Flows mit `--uebernahme-knoten-aktiv` erzeugen und deployen (nur `opt_*`). `deploy_opt.sh` kennt dafür seit dem Patch `deploy_opt_genargs.patch` die Umgebungsvariable `GEN_ARGS`: `GEN_ARGS=--uebernahme-knoten-aktiv ./deploy_opt.sh uebernahme_an`. Das Skript reicht den Schalter an den Generator, setzt für die Sims `UEBERNAHME_KNOTEN_AKTIV=1` (sie verlangen dann den aktiven Sendeknoten und `KNOTEN = true` in `opt_apply`, ohne Ansage schlagen sie bei aktivem Knoten an) und zeigt „opt_apply_mqtt live: … -> neu: …“. Geändert werden genau `opt_apply_mqtt` (aktiv) und `opt_apply` (`KNOTEN = true`).
3. `/data/optimizer/apply.json` schreiben, Vorschlag: `apply.json.vorschlag` (`{"enabled": true, "rules": ["quiet_freigabe", "quiet_strecken", "raum_offset"]}`; die Heizregelung kommt erst mit `"heizregelung"` in `rules` dazu, Entscheidung des Nutzers, Abschnitt 21.7; Heizgrenze bleibt Hinweis, Vorausschau erst mit offenem Gate; die Grenzen stehen dort nur zur Erläuterung, sie sind fest im Kern). Der Hauptschalter wird bei jedem Takt (15 s) neu gelesen.
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
| Regeln | 5 Kacheln (eine Zeile, je ~168 px; seit 14.10. mit der Heizregelung, bis zum Review-Paket 5 mit der Heizgrenze, dazwischen 4): kurzer Kachelname (`kachel`: Quiet-Freigabe, Deckel/Laufzeit (bis v3 Laufzeit strecken), Raumeinfluss, Vorausschau, Heizregelung), darunter Status-Chip (Vorschlag/Hinweis, wartet, gesperrt, prüft, ruht, keine Daten) und je Bedingung ein Segment (grün = erfüllt, Titel = Bedingung), eine Zeile mit dem Engpass und Balken: „Vorlauf-Rückstand 0,5 / 1,5 K“, „Haltezeit 4 / 10 min“, „🔒 Mindestabstand bis 09:38“, „🔒 Modell-Gate 1 / 10 Tage“, „seit 08:36 · gültig bis 09:06“. Texte brechen um statt abgeschnitten zu werden |
| Punkte | Diagramm der Summen je Befehlsregel (nur wenn es Punkte gibt), 5 Kacheln (Summe; Hinweis-Regeln zeigten „–“ und „nur Hinweis“, seit dem Review-Paket gibt es keine; Fälle/Treffer/Fehlalarm, seit v5 „davon n Treffer neutral (Basisrate ≥ Prognose)“ wenn n > 0, Skill ab 3 Fällen, Wirkung, Schaden/Verpasst rot, Kennzahl „verpasst während Sperre“ (Befehlsregeln), Freigabereife n/m mit Balken, Kriterien eingeklappt). Keine Mess-/Lernzeilen mehr |
| Messwerte & Lernen (neu 13.10.) | **Takt und Leistung**: Kacheln Takt (ruhig/Takt, Starts in 24 h), Läufe 24 h (Ø, kurze), Pausen 24 h (davon Minutenpausen), Heizgrenze beobachtet (Ø, max, Läufe), **Überheizt ab 11 °C** (seit dem Review-Paket statt der Messaufgabe: Laufenergie in kWh Strom bei Außen ≥ 11 °C, während ALLE Räume über ihrer Bandmitte lagen, 7 Tage; Untertext „n von m min“; Wärme und Gesamtenergie ab 11 °C im Tooltip), Hochlauf nach Start (Comfort/Efficiency, Befund Abschnitt 7). **Mindestleistung je Außenband**: Zellen „Band über Wert“ (laufendes Minimum von warm nach kalt; Quantil und Minuten im Tooltip), nur Bänder mit ≥ 30 stabilen Minuten. **COP je Modus und Quiet · 30 Tage**: Matrix Zeilen = Außenband (kalt → warm), Spalten = vorhandene Kombinationen Comfort/Efficiency × Q0–Q3 (Einträge mit unbekannter Heizregelung oder Quiet „?“ zählen nicht), Zelle = COP und Stunden, unter `cfg.takt.copMinMin` (60 min) grau, bester gültiger Wert je Zeile grün (nur wenn es mindestens zwei gültige gibt), Minuten/Hz/kWh im Tooltip. **Lernen**: Kacheln Gebäudemodell (n/10 Tage, Gate zu/offen/aktiv), Lern-Gate heute (frei/gesperrt, verworfene Tage), Bedarfsmodell Drift (ruhig/Mehrbedarf/Minderbedarf, CUSUM von 4), Wirkzeit Raum ↑/↓ (Minuten oder „sammelt“ n/3 Ereignisse, Puffer im Tooltip), Heizkurven-Bias (K, „sammelt“ n/3 Tage oder „Absenkung“). Ohne Daten Chip „sammelt“ bzw. „keine Daten“ |
| Entscheidungen | **Episoden** statt Minutenzeilen: je Regel von „alle Bedingungen erfüllt“ (wartet, gesperrt, Vorschlag/Hinweis) bis zum Ende, mit Verlauf als Chips und Ende-Grund (bei Dauersperre Modell-Gate seit 13.10. die fehlende Bedingung, z. B. „Vorhersage: Bedarf -1,6 K“, statt des Gate-Textes); Dauerzustände („prüft“, „ruht“) und Datenlücken erzeugen keine Zeile, kurze „wartet“-Episoden unter 5 min ohne Sperre oder Vorschlag werden ausgeblendet; höchstens 12, neueste oben |

**Lern-Gate und Bedarfsmodell Drift:** Die Zeilen gibt es in der Karte „Wärmefahrplan (Vorschau)“ (bis zum Review-Paket „(Shadow)“) (seit dem Zusammenlegen auf der Seite „Optimierung“) unter „Details und Modell ▸“ (eingeklappt) und nur, solange ein Plan steht (`P.status` ok). Deshalb waren sie nicht zu finden. Seit 13.10. legt `opt_plan` den Lernstand zusätzlich als `OPT_plan.lern` ab (immer, auch ohne Plan: Bitmaske und Gründe von heute, verworfene Tage, CUSUM auf/ab mit Alarm, Rückfall-Sperre), die Karte „Messwerte & Lernen“ zeigt ihn als Kacheln. Die Zeilen im Wärmefahrplan bleiben unverändert (Test: gleiche Werte).

**Vorschau ohne Dashboard:** `node tools/engine_ui_preview.js [Datenordner] [Ausgabe.html]` spielt die echten Protokolle durch den Kern und zeichnet fünf Schnappschüsse (A 10.10. 08:38 mit Vorschlag, Übernahme gesperrt; B Replay-Ende ohne Vorschlag; C Hauptschalter an mit aktiver Übernahme; D 5 Tage Kälte-Szenario mit Punkten; E wie A mit Übernahme frei) in HTML-Dateien, die das Dashboard nachbilden: Raster aus `ui_base` (48/6 px), Gruppen 17 Einheiten, Masonry (höchste freie Stelle, links zuerst), Karten mit fester Höhe und innerem Scrollen wie `ui_template`, Einpassen wie `FIT_JS`; Lernstand des Wärmefahrplans mit Beispielwerten. Ein Prüfskript in der Seite meldet inneres Scrollen, abgeschnittene oder aus Kacheln ragende Elemente, waagrechtes Scrollen der Seite und überlappende Gruppen. `node tools/ui_vorschau_pruefen.js <ordner> <seite.html> … [--breiten=1024,1920,2560]` öffnet die Seiten offline in Firefox headless (WebDriver BiDi, eigenes Profil, klassische Bildlaufleisten, Netz über toten Proxy), schreibt je Breite ein PNG und gibt die Prüfung aus (Exit 1 bei einem Fehler).

## 10. Bonsai-Beobachter

`tools/bonsai_beobachter.py` nutzt nur die Standardbibliothek.

| Schritt | Was passiert |
|---|---|
| Quelle (nur lesen) | `--quelle ORDNER` mit Kopien oder `--ssh`, d. h. `ssh fl0wb0b@10.10.10.128 docker exec node_red-node-red-1 cat /data/optimizer/<datei>`; ohne Shell, Dateiname gegen ein festes Muster geprüft |
| Fakten (deterministisch) | Abdeckung und Lücken; Minuten Lauf/Pause/Heizgrenze; Läufe (Anzahl, Starts, mittel, kürzester, längster); Pausen; Strom, Wärme, COP; maximale Frequenz ab Laufminute 2; Minuten > 20 Hz bei Quiet ≥ 1; Quiet-Minuten je Stufe; Heizregelung; Soll min/max/Wechsel; Außentemperatur; Radiator-Anteil; Ereignisse (Quiet-Befehle, davon GUI, Sollsprünge, Radiator, Vorschläge, Klicks); je Raum min/max, Minuten unter Min und über Max, ungültig in %; Maschine (Datensätze, Status-Minuten je Regel, Vorschläge); Punkte je Regel und Typ; Übernahmen (die Messaufgabe ist seit dem Review-Paket gestrichen) |
| Regel-Befunde (geprüft) | Lücken > 10 min; Maschine lief nicht durchgehend; Raum oft ungültig; Raum lange unter Minimum; > 20 Hz trotz Quiet ≥ 1; Schaden; Verpasst; Klicks; fehlende Dateien |
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
| 13.10. Nacht (Branch `review-paket`, Abschnitt 18; Flow-Datei mit `--uebernahme-knoten-aktiv`, Sims mit `UEBERNAHME_KNOTEN_AKTIV=1`) | `optimizer_sim` **544 OK** (Tests der gestrichenen Empfehlung, des Kontrolltests, der Eskalationsaktionen und der Plan-Verteilung entfernt, neue für Vorschau, gemessenen COP, Heizregelungs-Hinweis aus der Maschine); `engine_sim` **249 OK** ohne Flow-Datei, **323 OK** mit Flow-Datei und `replay_data_1310`, **317 OK** mit `replay_data`; `takt_sim` 25 OK + 1 bekannter datensatzabhängiger FAIL („48-h-Fenster“, wie vorher) mit `replay_data_1310`, 26 OK mit `replay_data`; `kern_chain_sim` 19 OK; Beobachter-Test OK; statische Vorschau Optimierung/Optimierer/Daten & Güte/Maschine bei 1024/1920/2560 px: 15 × OK |
| 14.10. (Branch `cop-korrektur`, Abschnitt 19; Flow-Datei mit `--uebernahme-knoten-aktiv`, Sims mit `UEBERNAHME_KNOTEN_AKTIV=1`) | `optimizer_sim` **554 OK** (vorher 544; angepasst: angehängte Spalten, korrigierte Kennfeld-/Plan-Werte, PLAN_VER 12; neu: Korrektur nur im Lauf, Konstante über config.json änderbar und begrenzt, Tooltips, Slot einer älteren Version ohne Korrektur-Spalten, Kennfeld-Rohsummen unverändert); `engine_sim` **254 OK** ohne Flow-Datei, **328 OK** mit Flow-Datei und `replay_data_1310`, **322 OK** mit `replay_data` (neu: 5 Kernprüfungen); `takt_sim` 25 OK + 1 bekannter datensatzabhängiger FAIL („48-h-Fenster“) mit `replay_data_1310`, 26 OK mit `replay_data`; `kern_chain_sim` **19 OK**; Vorschau `opt_seiten_vorschau.js` + `ui_vorschau_pruefen.js` (4 Seiten × 1024/1920/2560): 12 × OK |
| 14.10. (Branch `raumeinfluss-v3`, Abschnitt 20; Flow-Datei mit `--uebernahme-knoten-aktiv`, Sims mit `UEBERNAHME_KNOTEN_AKTIV=1`) | `optimizer_sim` **555 OK**; `engine_sim` **281 OK** ohne Flow-Datei, **338 OK** mit Flow-Datei, **361 OK** mit Flow-Datei und `replay_data_1310`, **351 OK** mit `replay_data` (neu: Abschnitt (g) mit Dauerlauf, Pendeln, Versionswechsel, Frost/Mindestfrequenz, Abtau-Rückstand, Frequenzsprung, H23, Dornröschenschlaf, Startschwelle, Kurvenform; 8-Tage-Fake-Uhr mit Frost; Replay-Prüfungen v3; angepasst: Raumeinfluss-Tests auf Räume statt Phase-2-Vorschlag, Effizienz-Deckel-Mechanik mit `hzHoch` 22 per cfg); `takt_sim` 26 OK + 1 bekannter datensatzabhängiger FAIL („48-h-Fenster“) mit `replay_data_1310`, 27 OK mit `replay_data`; `kern_chain_sim` **19 OK**; Vorschau `engine_ui_preview.js` (A–E) + `opt_seiten_vorschau.js` (4 Seiten) bei 1024/1920/2560 px: 27 × OK |
| 14.10. (Branch `regel-heizregelung`, Abschnitt 21; Flow-Datei mit `--uebernahme-knoten-aktiv`, Sims mit `UEBERNAHME_KNOTEN_AKTIV=1`) | `optimizer_sim` **566 OK** (unverändert); `engine_sim` **300 OK** ohne Flow-Datei (vorher 282), **358 OK** mit Flow-Datei (339), **381 OK** mit Flow-Datei und `replay_data_1310` (362), **371 OK** mit `replay_data`; mit der Kopie vom 14.10. (`replay_data_1410`) 3 datensatzabhängige FAIL, gleich auf e8eed78. Neu: Abschnitt (h) mit 18 Szenarien und eine Hüllen-Prüfung (`plant.hc`); angepasst: Regelzahl 5, Kacheln 5, Whitelist (`SetHeatingControl` 0/1, unbekannter Befehl jetzt `SetOperationMode`). `takt_sim` 26 OK + 1 bekannter FAIL („48-h-Fenster“) mit `replay_data_1310`, 27 OK mit `replay_data`; `kern_chain_sim` **19 OK**; Vorschau `engine_ui_preview.js` (A–F, neu F = 13.10. 13:44 mit Efficiency-Vorschlag) bei 1024/1920/2560 px: 18 × OK |
| `node tools/heizregelung_analyse.js <Datenordner>` | Comfort gegen Efficiency: COP je Modus × Band × Laufphase, COP bei gleicher Frequenz, Starts je Modus (Frequenz bis Minute 15/30, Minuten bis Soll −1 K), Wechsel im Lauf (Pumpe, Frequenz, Strom) |
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

**Raumregel (bis v2; seit v3 entscheidet sie aus den Räumen mit 12 h Datenalter, Abschnitt 20).** Sie hing am Raumvorschlag der Phase 2. Der flackert, weil Kinderzimmer-Werte nach 90 min als ungültig gelten (die Shelly melden nur bei Änderung).
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

**Heizgrenze-Hinweis (stillgelegt 13.10., Abschnitt 18.2).** Die Bewertung war ein Stellvertreter: „Räume bleiben ≥ Minimum + 0,5 K“.
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

## 18. Review-Paket (13.10.2026, Branch `review-paket`)

Umsetzung der Punkte 1–5 des Regel-Reviews (REVIEW.md, TODO „Regel-Review 13.10.2026“). Grundlage: Echtdaten `replay_data_1310` (07.10. 16:54 – 13.10. 17:04). **Unverändert** bleiben die drei Regeln mit Übernahme per Klick: Quiet-Freigabe v2, Deckel/Laufzeit v4, Raumeinfluss v2. Replay alt gegen neu (Kern von 38a7048 gegen neu, 8650 Minuten, Gate zu und testweise offen): **0 abweichende Minuten** für diese drei Regeln (Status, Grund, nächste Schwelle, Sperren, Vorschläge mit Prüfsumme, Ende/halten), 12 = 12 Vorschläge, Punktebuch identisch. Der Sendeknoten `opt_apply_mqtt` bleibt aktiv (Generator mit `--uebernahme-knoten-aktiv`).

### 18.1 Wärmefahrplan → Bedarfs-/COP-Vorschau (`opt_plan`, PLAN_VER 11)

**Entscheidung: reine Vorschau, keine Verschiebung.** Eine COP-/Wetter-Verschiebung ist bei dieser Anlage nicht robust (Messung 08.–12.10., Minutenprotokoll ohne Abtauen/Warmwasser):
- **Kein Tarif:** Netzbezug 0,05–0,25 kWh/Tag (10.10. im Boost 1,83), Einspeisung 1,6–66 kWh/Tag. Die Grenzkosten sind flach (Einspeisevergütung ~6–7 ct); die angenommenen 21/31 ct trafen nicht zu.
- **COP gemessen** (energiegewichtet, Strom TOP16 roh): < 4 °C **5,13** · 4–8 °C **5,57** · 8–11 °C **6,01** · ≥ 11 °C **6,72**. Seit 14.10. rechnet der Optimierer mit der COP-Korrektur (+80 W im Lauf, Abschnitt 19): 4,30 · 4,62 · 4,92 · 5,51. Das alte Modell (45 % Carnot) lag 5–17 % zu tief (4,25 / 4,61 / 5,46 / 6,36).
- **Gewinn einer Verschiebung:** bestes gegen schlechtestes 3-h-Fenster je Tag COP 6,64 gegen 5,49 → **0,032 kWh Strom je verschobener kWh Wärme**. Der Mehrverlust des wärmeren Hauses kostet **0,011–0,055** (UA 0,15–0,22 kW/K, Speicher 3–10 kWh/K, 10 h) → netto −0,024…+0,020 je kWh. Mit dem Hebel ±1 K (0,6–2,2 kWh/Tag) sind das **−1,2…+0,4 % des Tagesstroms** (5,59 kWh) bzw. −0,42…+0,15 ct/Tag.
- **Komfort:** Im warmen Fenster hatten die Räume −0,84…+0,08 K Luft bis zum Maximum, Vorziehen hätte das Band verlassen.

**Was wegfällt:** Verteilung (exakte DP), Empfehlungen VORZIEHEN/VERSCHIEBEN, Offset-Hinweise ±2 K in 0,5-K-Schritten, Quiet-Hinweis je Slot, Ersparnis nach Ursache, Reserve-Zeile, Leistungsgrenze, „günstigste Fenster“, Batterie-Zeile; Preise sind kein Eingang mehr (kein Status „keine Preise“). Die alten Pläne (Schnappschüsse 27 h vor dem 13.10.) enthielten 218 × VORZIEHEN, 104 × VERSCHIEBEN, Offset +2 K in 216 und −2 K in 25 Slots, Quiet-Hinweis Stufe 3 in 711 und Stufe 0 in 1314 Slots, Ø „Ersparnis“ 1,45 ct (davon Preis 0,60, COP 0,71) – das alles erscheint nicht mehr.

**Was bleibt bzw. neu ist:**
- Wärmebedarf je 15-min-Slot aus dem Gebäudemodell wie bisher (Referenzlauf: bit-identisch zum Stand vor Fahrplan v2), Gate, `coefSafe`, Lern-Hygiene, Drift/Rückfall, Fühlerkorrektur, A/B und `OPT_plan.model`/`OPT_plan.lern` unverändert.
- **COP je Slot aus der Messung:** Kennfeld des Quiet-Wächters (`flow.qs.kf`/`kfE`), je Außenband energiegewichtet über alle Stufen und beide Heizregelungen, nur Bänder mit ≥ `copMinMin` 60 min; dazwischen linear, außerhalb mit dem Carnot-Verhältnis zum nächsten Band, Grenze `copMax` 8. Ohne gemessenes Band Rückfall η × Carnot (η gelernt, Standard 0,45).
- **Strom je Slot** = Wärmebedarf ÷ COP; Summe 24 h neben der VRM-Prognose.
- Zeile **„Verschieben nach COP (nur Rechnung)“**: bestes/schlechtestes 3-h-Fenster, Gewinn je kWh gegen den gemessenen Mehrverlust 0,01–0,06 → „keine Empfehlung“.
- Karte „Wärmefahrplan (Vorschau)“: Kacheln Stand, Wärmebedarf, Strom, COP (Ø, Spanne, Quelle), höchster Bedarf, Außen 24 h, PV-Prognose 24 h; Diagramm Wärme/Strom, Außen/COP, PV; Stundenübersicht Ab · Außen · Wärme · COP · Strom · Feuchte/Taupunkt · PV · Abtaurisiko · Vertrauen.
- Dateien: Schnappschuss-Spalten neu (`t, at, rh, cop, pv, bedarf, strom, defrost, conf_at, conf_pv, taupunkt, wind, wolken, at_korr, sonne_kwh, solar_kand_kwh, wind_kand_kwh, bedarf_basis, bedarf_kand`); `plan-eval` behält seinen Kopf (Leser nach Spaltenname), Preis/Plan/Kosten/Empfehlung/Offset/Quiet bleiben leer, hinten neu `prog_strom_kwh`; alte Schnappschüsse (Version 10) werden weiter ausgewertet. `OPT_plan.slots` = `[Zeit, Wärme kWh, COP, Strom kWh, Vertrauen]` (liest niemand außer der Anzeige), `OPT_plan.reserve` entfällt.

### 18.2 Heizgrenze-Hinweis stillgelegt, Kennzahl „Überheizt ab 11 °C“

Der Hinweis „Heizgrenze 12 → 10 °C“ ist aus dem Regelwerk genommen (`ENGINE.STILLGELEGT` mit Grund). Begründung: Ab 11 °C ist der COP am höchsten (6,7); Wärme dort ist billig, das echte Einsparpotenzial ist nur der Teil, in dem alle Räume ohnehin über der Bandmitte lagen. Replay 07.–13.10.: vorher 4 Hinweise (07.10. 21:03, 08.10. 11:06, 10.10. 16:43, 12.10. 12:48), jetzt 0.
- Neue Kennzahl **„Überheizt ab 11 °C“** (Karte „Messwerte & Lernen“): Laufenergie bei Außen ≥ 11 °C, während **alle** Räume mit gültigem Wert über ihrer Bandmitte lagen, 7 Tage. Replay: **0,21 kWh Strom / 1,6 kWh Wärme in 45 von 1601 Laufminuten** ab 11 °C (ab 11 °C insgesamt 9,0 kWh Strom; 168 min ohne Raumwerte zählen nicht) – rund 2 % der Energie ab 11 °C.
- Die **beobachtete Heizgrenze** (Ø, max, Läufe) bleibt.
- Zustand: Summen `heizgrenze_hinweis|v1|s*`, Basisraten und Punkteverlauf bleiben stehen; offene Fälle und Vergleichslagen enden beim Laden ohne Buchung; der Bericht und die Punkte-Karte kennen die Regel nicht mehr (Test S12). Regel- und Punkte-Kacheln: 4 Spalten.

### 18.3 Vorausschau v2: nur −1 K

Der Zweig +1 K (vorhergesagte Abkühlung) ist gestrichen, −1 K (vorhergesagte Milderung) bleibt mit Gate wie bisher. Begründung (Zweck-Text der Regel): Die Anlage führt die Heizkurve selbst alle 5 min mit der Fühler-Außentemperatur nach (0,375 K Vorlauf je K, Verzug ≤ 5 min), die Heizkörper haben wenig Speichermasse, und bei Kälte lagen die Räume ohnehin 0,4–1,6 K über ihrer Bandmitte (unter 4 °C Kinderzimmer unten 90 % der Zeit über Maximum) – +1 K hätte überheizte Räume weiter geheizt. Unter Quiet 0 löst +1 K bei Vorlauf unter Soll außerdem einen Hochlauf aus (11.10. 03:10: +48 % Strom). Nur −1 K zeigt in die Energie-Richtung. Bewertung: Lage, Treffer und „verpasst“ gespiegelt (wärmster Raum erreicht das Maximum bzw. die Außentemperatur liegt ≥ die halbe Schwelle über dem Tagesgang); der Schaden „Raum > 1 K unter Minimum“ galt nur +1 K und ist entfernt. Neue Basisrate unter `vorausschau|v2`. Replay: 0 Vorschläge vorher und nachher (Gate zu und testweise offen).

### 18.4 Messaufgabe Comfort/Efficiency gestrichen

Befund und Kennzahl „Hochlauf nach Start“: Abschnitt 7. Kern (`messStep`/`MESS`/`messStatus` entfernt, alter Zustand `sc.mess` wird bereinigt), Bericht (`engine_replay.js`: Tabelle „Kennzahlen (nur Anzeige)“), Beobachter (keine Fakten/Befunde `messaufgabe.*`).

### 18.5 Quiet-Wächter: nur Messung und Anzeige; Heizregelungs-Hinweis aus der Maschine

`opt_quiet` heißt jetzt „Quiet-Wächter: Messung und Anzeige (Shadow)“. **Entfernt:** eigene Quiet-Empfehlung (Rücklauf-Stufen; sie lautete fast immer Stufe 3), Erfahrungsregel „1–3 °C Quiet aus“, Kontrolltest Quiet 3 → 2, Eskalationsaktionen (Quiet q → q−1, „ausgeschöpft“, Pausenfenster, Tag/Nacht), die Sperre nach Takt durch Wechsel und die alte Deckel-Annahme 35/45 Hz. **Bleibt:** Kennfeld je Stufe/Band (Comfort und Efficiency getrennt), Abtauprotokoll, Taktung, Laufmessung (`sollvorlauf_erreicht`, `lauf_ende`, `stopp_nach_wechsel` mit gemessenem Überschwingen, ohne Sperre), Schaltpunkte und Sollsprünge, Minutenprotokoll. **Neu:** Zeilen „Quiet-Regeln (Entscheidungsmaschine)“ (Status der beiden Quiet-Regeln und ein laufender Vorschlag) und in „Quiet aktuell“ der gemessene Deckel der Stufe aus `OPT_engine.deckel` – keine doppelte Logik, die Maschine ist die Wahrheit. `quiet-*.csv` behält den Kopf; die Spalten der gestrichenen Teile bleiben leer.

**Heizregelung:** Die alte Warnung (Außen < 5 °C, Prognose < 3 °C, Abtauen in 6 h, Vorlauf 20 min > 2 K unter Soll, Raum unter Minimum) flackerte an der Grenze und schlug bei normalen Kaltstarts an. Live 07.–13.10.: **74** Ereignisse `heizregelung_empfehlung` (Flackern bei 4,0 °C), dazu **20** `eskalation_schatten` und **31** `testfenster_quiet_3_2` – alle drei gibt es nicht mehr. Neu: Hinweis der Maschine (`OPT_engine.hc`, Bedingung Abschnitt 4), `opt_quiet` reicht ihn als `OPT_hc_reco` an die Heizregelungs-Karte im Tab „WP Dash“ weiter (dort unverändert: Text, einmalige Meldung bei neuer Warnung). Replay: **0** Hinweise (145 min lag Außen unter der Grenze, in Efficiency war der Vorlauf ab Laufminute 10 nie ≥ 2,5 K unter Soll). Ohne frische Maschinendaten: „keine Warnung (Maschine ohne aktuelle Daten)“.

### 18.6 Geänderte Knoten (Diff gegen live: Generator von 38a7048 mit `--uebernahme-knoten-aktiv`)

Nur `opt_*`, nichts entfernt, nichts neu: `opt_engine`, `opt_apply` (bettet den Kern ein: Regelwerk ohne Heizgrenze, Vorausschau v2; die drei Übernahme-Regeln unverändert), `opt_quiet` (+ Name), `opt_c5` (Kommentar), `opt_plan`, `opt_defaults` (Konstanten `quiet`/`plan`), Vorlagen `opt_t_plan`, `opt_t_plan_tab`, `opt_t_eng_prop`, `opt_t_eng_rules`, `opt_t_eng_score`, `opt_t_eng_mess`, `opt_t_eng_log` (eingebettete Anzeige-Bausteine), Gruppe `opt_g_plan` (Name „Wärmefahrplan (Vorschau)“). `opt_apply_mqtt` bleibt aktiv. Deploy später: `GEN_ARGS=--uebernahme-knoten-aktiv ./deploy_opt.sh …`.

### 18.7 Offene Entscheidungen

- COP-Tabelle: Abtauen ist im gemessenen COP nicht enthalten (Kennfeld ohne Abtau-Minuten); ein Abschlag aus dem Abtauprotokoll wäre möglich, sobald Frostdaten vorliegen.
- Bonsai-Befund „> 20 Hz trotz Quiet ≥ 1“ beruht auf der alten Annahme „Quiet-Deckel = Minimum“; gemessen deckeln Q2 bei 17/21 Hz und Q1 bei 21 Hz – der Befund sollte an die Deckel-Tabelle der Maschine angepasst werden.
- Vorausschau −1 K: im Lauf sperrt meist die Takt-Gefahr (Vorlauf über Soll); ob sie je vorschlägt, zeigt erst ein Winter mit offenem Gate.
- Heizregelungs-Hinweis: Schwellen (Heizstab-Grenze + 2 K, 10/3/10 min) sind Annahmen; mit Frostdaten prüfen.

## 19. COP-Korrektur (14.10.2026, Branch `cop-korrektur`)

Auftrag des Nutzers: „den COP so anpassen, dass er passt, aus den Erkenntnissen des Forums“ (Forum 189605, `forum189605/BERICHT_LEISHA.md`, Frage 10, TODO F10-a).

**Befund.** Der interne Stromwert der Leisha (`TOP16 Heat_Energy_Consumption`) untertreibt im Lauf, die Wärmeseite stimmt weitgehend:
- L5: 70–90 W unter einem Shelly, je nach Last (Beitrag 4545989).
- L5 bei 16/17 Hz: 2 kW Wärme bei 390 W laut Shelly (4597230). Unsere Anlage zeigt dort 341–363 W.
- L7: Jahresstrom −14,6 % gegen Shelly, Wärme nur −2,7 % gegen WMZ (4145844). Der Fehler liegt also auf der Stromseite (Pumpe, Lüfter, Elektronik fehlen).

**Konstante.** `cfg.cop.pelKorrW` = **80 W** (ANNAHME im belegten Bereich 40–90 W). Sie wird **nur bei laufendem Verdichter** addiert, im Stillstand bleibt TOP16 roh (15–34 W). Eine Quelle: `OPT_cfg.cop` (Standard im Generator `COP`, überschreibbar in `config.json` mit `{"cop": {"pelKorrW": 40}}`, gültig 0–200 W, sonst Standard). Die Maschine bekommt denselben Wert über `ENGINE.mergeCfg` (`cfg.cop`); `0` heißt roh.

**Prinzip: gespeichert wird roh, korrigiert wird beim Lesen.** Alle Zähler, die nur Laufminuten enthalten (Takt-Messung `S.takt.copT`, Kennzahl `S.ueb`, Kennfeld des Quiet-Wächters `qs.kf`/`kfE`), behalten TOP16. Beim Lesen kommt je gezählte Laufminute `pelKorrW/60` Wh dazu. Damit sind alle gespeicherten Werte mit jeder Konstante neu rechenbar, es gibt keine Mischung aus roh und korrigiert, und nichts wird doppelt korrigiert. Ein Neuladen der Takt-Messung ist nicht nötig.

| Stelle | Was sich ändert |
|---|---|
| Kern `copSumme`/`copTabelle` | Strom korrigiert (Feld 0), Rohsumme in Feld 6; `d.copSum` des Hauptschritts mit `cfg.cop` → Zielstufe der Quiet-Freigabe (COP-Vergleich, `copTol`), Veto von Deckel/Laufzeit, Texte „COP x,xx“ |
| Kern `uebSumme` (Kennzahl „Überheizt ab 11 °C“) | `el`/`elAlle` korrigiert, `elRoh`/`elAlleRoh` roh |
| Wirkungsprüfung (+60 W, +350…+650 W, −100 W) | **unverändert**: es sind Differenzen zwischen zwei Lauf-Minuten, die Korrektur fällt heraus |
| Karte „Messwerte & Lernen“ | COP-Matrix korrigiert; Tooltip je Zelle mit rohem COP, Tooltip der Überschrift „intern +80 W korrigiert“; „Überheizt“ mit Roh-kWh im Tooltip |
| `opt_quiet` | Zeilen „Leistung elektrisch“ und „COP“ korrigiert (Tooltip mit TOP16 und rohem COP); Kennfeld-Tabelle: Ø P el. + 80 W, Ø COP = Ø Wärme ÷ (Ø Strom + 80) aus den Rohsummen; `quiet-*.csv` hinten `leistung_el_korr_w, cop_momentan_korr, cop_korr_w` (Rohspalten bleiben, Nachladen liest weiter `leistung_el_w`) |
| `opt_plan` (PLAN_VER 12) | Kennfeld-COP je Band und η (Carnot-Anteil) korrigiert → COP und Strom je Slot; `plan-actuals` hinten `ist_strom_korr_kwh, ist_strom_heizen_korr_kwh, ist_cop_korr, ist_cop_korr_w` (Slot von einer älteren Version: leer); `plan-eval` hinten `prog_cop_korr_w` (Konstante des Schnappschusses, leer = vor Version 12, roh) und dieselben vier Ist-Spalten; Schnappschuss-`meta.cop_korr_w`; Tooltips an Kacheln, Details und Stundenkopf |
| `opt_eval` (Karte „Wärmepumpe“, Seite Daten & Güte) | „Leistung · COP“ korrigiert, Tooltip mit TOP16 und dem Kern-COP; `optimizer-v2-*.csv` hinten `leistung_korr_w, cop_korr, cop_korr_w` |
| `opt_hist` (Verlauf Wärmepumpe) | Stromkurve aus `leistung_w` + 80 W, wenn der Verdichter lief (für jede Zeile gleich gerechnet), Tooltip an der Legende (`ui_chart.js`: optionales `t` je Reihe) |
| `energy-*.csv` | enthält keinen TOP16-Wert (nur PV/Netz/Batterie/Preise) – nichts zu ändern; die Strom-Tagessummen der Wärmepumpe stehen in `plan-actuals` |
| `defrost-*.csv` (`strom_kwh`) | bleibt roh: beim Abtauen steht der Lüfter, die fehlende Leistung ist dort unbekannt |

**Nicht geändert (Kern, Nutzerentscheidung):** Der COP-Pfad zu Venus/VRM rechnet im HeishaMoNR-Kern: `COP_calculated` (Tab „WP Control“, `f4e55b938e645737`: Wärme aus Durchfluss × ΔT ÷ `TOP16_Heat_Energy_Consumption` roh) → `COP_HEAT` → Link → „nur COP_HEAT“ (Tab „WP Dash“) → `mqtt out panasonic/cop` → Venus → VRM. Er nutzt denselben Rohwert und zeigt deshalb weiter ~20 % zu viel. Auch die Kern-Anzeigen (Gauge, Balken, `COP_HEAT_24m`) bleiben roh.

**Neue COP-Bänder** (Replay `replay_data_1310`, 07.–13.10., Laufminuten ohne Abtauen/Warmwasser, energiegewichtet):

| Außen | Ø TOP16 | COP roh | COP korrigiert | Faktor |
|---|---|---|---|---|
| < 4 °C | 409 W | 5,13 | **4,30** | 0,84 |
| 4–8 °C | 390 W | 5,57 | **4,62** | 0,83 |
| 8–11 °C | 343 W | 6,07 | **4,92** | 0,81 |
| ≥ 11 °C | 336 W | 6,82 | **5,51** | 0,81 |

Vergleich Forum (L5): COP ≈ 6,0 bei 11 °C, 4,34 bei 1 °C, JAZ 4,43, Monatswerte um 0 °C 4,3–4,7. Unten passt es jetzt (4,30 ohne Abtauverluste), bei ≥ 11 °C liegen wir mit 5,51 rund 8 % unter dem Forumswert (dort andere Anlage, VL und Messung; ggf. ist 80 W bei Mildwetter etwas hoch). Eine Shelly-Messung würde die Konstante festlegen.

**Regeln im Replay (07.–13.10., 8650 Minuten, alter Kern 6ddbbcc gegen neuen Kern mit 80 W und mit 0 W, Takt-Messung leer und testweise mit der ganzen Woche vorbefüllt):** 0 abweichende Minuten bei Status, Grund, Vorschlag (Regel, Befehl, Prüfsumme) und Ende/halten, 12 = 12 Vorschläge, Punktebuch identisch. Mit 0 W rechnet der neue Kern wie der alte.
- COP-Matrix (vorbefüllt) korrigiert: Efficiency Q0/Q3 bei 11…15 °C 5,70/5,34 (roh 6,89/6,76), 7…11 °C 4,89/4,96, 3…7 °C 4,27/4,63, −1…3 °C 4,13/4,50 (Q2 4,29).
- **Veto-Abstand schrumpft:** Bei 11…15 °C liegt Quiet 3 jetzt 6,3 % unter Quiet 0 (roh 1,9 %); das Veto greift ab 10 %. Die Korrektur trifft niedrige Leistung stärker (80 W sind bei 300 W mehr als bei 500 W).
- **Grundlage des Effizienz-Deckels:** Die Messung „COP bei 22–27 Hz 3–8 % unter 16–17 Hz“ (Schwelle `hzHoch`, Quiet 0, ab Laufminute 15) gilt nur mit TOP16 roh. Korrigiert: 22–27 Hz −1…+5 %, ab 28 Hz −3 %, 18–21 Hz −4…+2 %, also im Rauschen (Pth ±10 %). Logik und Schwellen sind unverändert (Auftrag); Zweck- und Herkunftstext nennen jetzt beide Zahlen. Ob der Effizienz-Deckel (Quiet höher bei ≥ 22 Hz) noch Strom spart, ist damit eine offene Nutzerentscheidung; sein zweiter Nutzen (längere Läufe) bleibt.

**Zusatz (Beobachter, Nutzer 14.10.):** `quiet-*.csv` hat hinten zusätzlich `rohr_aussen` = `Outside_Pipe_Temp` aus `OPT_hp` (Pseudo-Abtauungen erkennen). Keine Logik dazu.

**Geänderte Knoten** (Generator gegen den von 6ddbbcc, beide mit `--uebernahme-knoten-aktiv`, dieselbe Flow-Datei): nur `opt_*`, 25 geändert (nur `func`/`format`), 0 neu, 0 entfernt: `opt_defaults`, `opt_quiet`, `opt_plan`, `opt_eval`, `opt_hist`, `opt_engine`, `opt_apply` (Kern), Statuskarten `opt_t_opt/wx/calc/quiet/en/fq/wp` (Tooltip-Feld), `opt_t_qstats`, `opt_t_plan`, `opt_t_plan_tab`, Diagrammkarten `opt_t_ch_wp/rooms/at` und Maschinenkarten `opt_t_eng_prop/rules/score/mess/log` (eingebettetes `ui_chart.js`/`eng_ui.js`). `opt_apply_mqtt` bleibt aktiv. Deploy später: `GEN_ARGS=--uebernahme-knoten-aktiv ./deploy_opt.sh …`.

**Offene Entscheidungen:** (1) Kern-COP für Venus/VRM ebenfalls korrigieren? (2) Effizienz-Deckel ohne belegten COP-Vorteil behalten? (3) Konstante mit einer Shelly-Messung festlegen (dann `config.json`).

## 20. Raumeinfluss v3 und Forum-Erkenntnisse (14.10.2026, Branch `raumeinfluss-v3`)

Auftrag des Nutzers (14.10., „Ja bitte“): Raumeinfluss v3 bauen und die belegten Befunde der Forum-Auswertung 189605 (`forum189605/BERICHT_LEISHA.md`) in die Maschine einarbeiten. Offline, nichts eingespielt. Ausgangspunkt ist der Live-Stand 8a83991 (Sendeknoten aktiv). Regelversionen: **Quiet-Freigabe v3**, **Deckel/Laufzeit v5**, **Raumeinfluss v3**; Vorausschau v2 unverändert. Bewertungsregeln v5 unverändert.

### 20.1 Raumeinfluss v3 (`raum_offset` v3)

**Entscheidung direkt aus den Räumen** (Funktion `raumLage`). Der Raumvorschlag der Phase 2 ist nur noch Vergleichskennzahl („Phase 2 (Vergleich)“, Replay: 71 % der Minuten dieselbe Richtung).

| Baustein | Umsetzung |
|---|---|
| Raumwert | geglätteter Wert (EMA aus `OPT_rooms`), eigenes Band je Raum; ein Wert gilt bis **12 h** (`raumAlterMaxMin` 720): die Shelly melden nur bei Änderung, das Wohnzimmer war 07.–13.10. in 14 % der Minuten älter als 6 h (RE-9) |
| Verlauf | Regression im 5-min-Raster über 2 h, in Lauf und Pause |
| Lüften | Sturz ≥ 1 K binnen 60 min oder Gefälle ≥ 1 K/h (`lueftKh`): 60 min kein Bedarf und **keine Absenkung** (Replay 12.10. 07:40: Schlafzimmer fiel nach dem Lüften unter Minimum) |
| Kinderzimmer oben | eigene Relaisregelung: „kalt“ zählt nur bei offenem Radiator-Relais (`kzRad` 1 oder unbekannt; RE-8) |
| **Bedarf (+1 K)** | ein Raum ≥ 0,2 K unter Minimum, der sich nicht erholt (Verlauf < +0,2 K/h), 60 min am Stück |
| **Überschuss (−1 K)** | alle Räume mit Wert, kein Raum gelüftet, knappster Raum ≥ 0,5 K über Minimum (auch beim jetzigen Gefälle in 2 h noch ≥ 0,3 K), dazu ein Raum ≥ 0,2 K über Maximum oder alle über der Bandmitte; 60 min am Stück |
| **Wärmeverteilung** | ein Raum über Maximum und einer unter Minimum: keine Verschiebung (außer der kalte Raum liegt ≥ 0,5 K unter Minimum: Komfort vor Energie), sondern nach 30 min ein **eigener Hinweis** „hydraulischer Abgleich/Thermostatventile prüfen“ (Wächter `verteilung`, Ereignis in quiet-events, Kachel) statt einer stillen Sperre (RE-8) |
| −1 K im Lauf | nur bei Vorlauf ≤ Soll (Bedingung, die Sperre „Takt-Gefahr“ bleibt): danach höchstens +1 K über dem neuen Soll, im ungünstigsten Fall mit natürlichem Sollsprung an der Rundungsgrenze +2 K; gemessen kein Stopp bis +2,25 K (18/18), Stopp ab +2,5 K nach 11–14 min. Sonst **in der Pause** (Pausen-Variante) – damit wirkt die Regel auch in den Dauerläufen (RE-1): Replay-Dauerläufe ≥ 300 min hatten in 28 % der Minuten Vorlauf ≤ Soll, die Lage −1 K bestand in 66 % dieser Minuten |
| +1 K | nur bei Bedarf; in der Pause startet der Verdichter sofort, wenn der Vorlauf dann ≤ neuer Soll −3,25 K liegt (gemessen 2/2) – das steht in der Erwartung |
| 1 K je Befehl | Ziel = Verschiebung ± 1 (Whitelist −1/0/+1); zusätzlich lehnt die Übernahme jeden Befehl mit mehr als 1 K Abstand zum Ausgangswert ab (RE-5) |
| Untergrenze | Soll-Vorlauf ≥ 29 °C (Nutzer); bei Außen ≥ ~11 °C ist −1 K nicht möglich: Grenze, kein „verpasst“ (RE-4) |
| Kurve ruhig | kein neuer Vorschlag binnen 10 min nach einem natürlichen Sollsprung (RE-2) |
| Rückweg | +1 K: die **Bedarfsräume** liegen 30 min ≥ Minimum + 0,3 K (Hysterese 0,5 K), frühestens nach der Wirkzeit (gemessen, sonst 120 min); andere Räume über Maximum zählen nicht (Lehre aus B2: das Wohnzimmer liegt oft darüber). −1 K: sofort bei einem Raum unter Minimum, sonst wenn der knappste Raum 15 min < Minimum + 0,2 K liegt. Spätestens nach 6 h (Frist der Übernahme). Eine eigene stehende Verschiebung stellt die Regel nicht per Gegenvorschlag zurück, sondern nur über den Rückweg |
| Arbitrierung | unverändert (`S.arb`): Vorrang, Mindesthaltezeit 60 min, Gegenrichtung 240 min ohne Komfort-Notfall, Übergabe in gleicher Richtung; „halten“ der Vorausschau/+1 K, solange die Raumlage dieselbe Richtung verlangt. Die Sperre „Laufbeginn“ gilt für den Raumeinfluss nicht mehr (die Verschiebung ist beim Start unkritisch; sonst endete jeder Pausen-Vorschlag beim nächsten Start) |
| Bewertung (v5) | Prognose +1 K „Bedarfsraum bleibt unter Minimum“ (p 0,7; 60/120/240 min), **eigene Prognose −1 K** „Haus bleibt überheizt“ (p 0,7; 120/240/360 min); Basisraten `raum_offset|v3` und `raum_offset|v3|minus`, Vergleichslage = Raumlage ohne Haltezeit; „verpasst“ nur für Komfort (Raum ≥ 0,5 K unter Minimum, 180 min), eine stehende +1 K gilt als versorgt |
| Kurvenform (RE-7, Review 5.2) | je Außenband (< 4, 4…8, 8…11, ≥ 11 °C), 7 Tage, nur mit allen Räumen: Reserve, Abstand zur Bandmitte, Anteil Überschuss, Anteil „Überschuss oder −1 K steht“, Anteil Bedarf. Hinweis „Heizkurve kaltseitig senken (Kaltpunkt −1 K von Hand)“, wenn ein Band unter 8 °C ≥ 3 h Daten und ≥ 50 % Abweichung hat; an der Untergrenze nur Info. Getrennt je Heizkurve (`inp.kurve` aus Z1_Heat_Curve_*): nach der Änderung vom 13.10. (Kaltpunkt 38 → 37 °C) beginnt sie im Live-System neu. Replay 07.–13.10.: < 4 °C 82 %, 4…8 °C 58 % → Hinweis am 08.10. 23:41 |
| Wirkzeit (RE-10) | `S.lag` (Sollsprung → halbe Raumreaktion, ≥ 3 Ereignisse) bestimmt die früheste Rückkehr nach +1 K und steht in der Erwartung; ohne Messung 120 min (Annahme). Live: noch 2 von 3 Ereignissen |

**Prüfliste RE-1…RE-12 (Regel-Review 3.3):** RE-1 erfüllt (Lauf bei Vorlauf ≤ Soll, sonst Pause; Dauerlauf-Test). RE-2 erfüllt (ungünstigster Fall im Text; 10 min Abstand zum natürlichen Sollsprung). RE-3 erfüllt (−1 K in der Pause, +1 K nur bei Bedarf, Sofortstart in der Erwartung). RE-4 erfüllt. RE-5 erfüllt (Regel und Übernahme). RE-6 erfüllt (+1 K Heizstab-Sperre wie bisher; −1 K unter 3 °C nur mit Rücklauf ≥ 28 °C – vorsorglich, die Leisha schaltet den Heizstab beim Abtauen laut Forum nicht zu). RE-7 als Kennzahl/Hinweis. RE-8 erfüllt (Hinweis statt Sperre, Relais). RE-9 erfüllt (12 h). RE-10 teilweise (Messung vorhanden, noch zu wenig Ereignisse). RE-11 unverändert offen (zweiter Schreiber, Kern-Paket nur vorbereitet; HeishaMoNR-Raumregelung und Nachtabsenkung sind aus). RE-12 offen (kWh/Komfortminuten statt Punkten, Zähler fehlt).

### 20.2 Forum 189605: Umsetzung je Punkt

| Punkt | Umsetzung | Beleg/Messung |
|---|---|---|
| **B1 Mindestfrequenz** | Tabelle `MINHZ` (Fühlerwert der WP): bis −3 °C 16 Hz, ab ≤ −4 °C 25 Hz, ab ≤ −10 °C 35 Hz. **Gelernt** je 2-K-Band (Sprungstellen −4/−10 °C getrennt) aus stabilen Laufminuten mit **Quiet 0 ohne Rücklauf-Rückstand** (10-%-Quantil mit Häufung am Minimum); gelernte Werte haben Vorrang. Wirkung: kein Quiet-Deckel unter der Mindestfrequenz (`deckelOf`), „harter Deckel“ heißt auch „hält nur das Minimum“ (Kälte-Vorsorge und ihr Halten im Frost), Effizienz-Deckel erst ab Mindestfrequenz + 3 Hz und keine Zielstufe, wenn keine Stufe unter 22 Hz deckeln kann; Mindestleistung als laufendes Minimum je Segment (der Sprung bei −4 °C bleibt sichtbar) | Forum 4593782, 4596796, 4593801 (L5), 4594536/4594690 (L7/L9). Echtdaten 1–15 °C: gelernt 16 Hz in allen Bändern (= Tabelle). Die erste Fassung lernte auch unter Quiet 2 und hätte bei 1 °C 21 Hz als „Minimum“ genommen – deshalb nur Quiet 0 ohne Rückstand |
| **B2 Startschwelle** | Gemessen und modelliert (`START`, `startModell`, je Pause `S.sl`): Start, wenn Vorlauf ≤ Soll −3,25 K (0,25-K-Raster), dann ~9 min Verzug. Die Forum-Regel „Vorlauf < RL beim Abschalten −3 K, ohne Wartezeit“ (L7, 4004893) **passt bei dieser L5 nicht**: an 14 sauberen Pausen 08.–13.10. trifft sie den Start im Mittel 24,6 min zu früh (7–80 min), das Soll-Modell mit 9 min Verzug auf 1,8 min. Die Maschine misst beide Modelle weiter und nimmt ab 5 Pausen das bessere (Replay: 15 Pausen, Soll 4,1 min gegen RL 10,9 min). Genutzt für den Dornröschenschlaf-Wächter und die Erwartung von −1 K in der Pause | `node tools/startschwelle_analyse.js <Datenordner>` |
| **B3 Abtauen** | (a) **Abtau-Rückstand als Bedarf** der Quiet-Freigabe (v3): in Efficiency bis 30 min nach dem Abtau-Ende, Vorlauf ≥ 3 K unter Soll; die ersten 10 min sperrt „Abtauen“; Comfort fährt selbst hoch (kein Bedarf). (b) **Sperre „Frequenzsprung bei Abtauwetter“** (`abtausprung`): Außen −5…+4 °C (Fühler), Verdichter seit ≥ 60 min ≤ 20 Hz, Maßnahme hebt ihn um ≥ 8 Hz (Freigabe auf Quiet 0: 33 Hz; Raumeinfluss +1 K mit Hochlauf in Comfort) → gesperrt; Heizstab-Nähe ausgenommen; in dieser Lage geht auch ein Raum-Notfall schrittweise (Quiet 3 → 2, +4 Hz) | Forum 4582615, 4095732, 4096011 (Efficiency nach Abtauen), 4540566, 4230252, 4581423, 4868882 (Pseudo-Abtauungen). Echtdaten ohne Abtauung: Replay unverändert (0 abweichende Minuten der Freigabe) |
| **B4 H23-Wächter** | Fehlercode aus `OPT_hp.Error` (HeishaMon `main/Error` = TOP44, Wert „No error“ oder Code): neue Sperre `stoerung` für alle Regeln, Ereignis `optimierer_alarm` (H23: „Kältemittelfühler Innengerät, L-spezifisch, Platinentausch über Panasonic“), `OPT_engine.stoerung`; die Übernahme lehnt jeden Klick ab und sendet keinen Rückweg, solange der Fehler ansteht; kein automatischer Reset. Vorstufe: `Inside_Pipe_Temp` < −30 °C → Hinweis (nur falls HeishaMon den Wert für die L liefert) | Forum 3483282, 4130989, 4571850, 4694333, 4693147 |
| **B5 Dornröschenschlaf** | Wächter `dornroeschen`: Pause (Pumpe läuft, kein Heizgrenze-Aus) ≥ 120 min und Startschwelle seit ≥ 45 min erreicht → Hinweis „Sollsprung +2/+3 K startet sofort – nur von Hand, kein Befehl ohne Freigabe“; endet beim Start | Forum 4131809, 3935020, 4578250. Replay: genau einmal, 12.10. 21:21 (der ungeklärte Spätstart 21:31 aus dem Review, 86 min nach Erreichen der Schwelle) |
| **B6 Effizienz-Deckel** | `hzHoch` 22 → **28 Hz** ohne Takt; mit belegtem Takt weiter ab 22 Hz (`hzTakt`; dann zählt die Laufzeit). Begründung siehe Tabelle unten | Messung 07.–13.10., Quiet 0, gleiches Band, ab Laufminute 15 |

**COP je Frequenzklasse gegen 16–17 Hz** (Quiet 0, ab Laufminute 15, `node tools/cop_frequenz_analyse.js <Datenordner>`):

| Band | Frequenz | roh | mit +80 W |
|---|---|---|---|
| 4–8 °C | 22–27 Hz (74 min) | −6,6 % | −0,3 % |
| 4–8 °C | ≥ 28 Hz (12 min) | −5,0 % | +4,8 % |
| 8–11 °C | 22–27 Hz (38 min) | −5,1 % | +0,5 % |
| ≥ 11 °C | 22–27 Hz (81 min) | −3,0 % | +4,8 % |
| ≥ 11 °C | ≥ 28 Hz (57 min) | −15,3 % | −3,1 % |

Bei 22–27 Hz hängt das Vorzeichen an der Korrektur, der Effekt liegt in der Messunsicherheit (Pth ±10 %). Ab 28 Hz bleibt er im Band mit genug Daten bei jeder Korrektur zwischen 0 und 80 W negativ. Replay: 0 statt 3 Effizienz-Deckel (alle drei lagen bei 22–25 Hz ohne Takt); mit `hzHoch` 22 per `config.json` (`engine.rules.quiet_strecken.hzHoch`) wäre v4 wieder hergestellt.

### 20.3 Replay 07.–13.10. (`replay_data_1310`, 8650 Minuten): alt (8a83991, live) gegen neu

| Regel | alt | neu |
|---|---|---|
| Quiet-Freigabe | 1 Vorschlag (10.10. 08:36), +30 | v3: identisch (0 Minuten mit anderem Status oder Grund) |
| Deckel/Laufzeit | v4: 3 Effizienz-Deckel (22–25 Hz), 2 Treffer, 0 Punkte | v5: 0 Vorschläge |
| Raumeinfluss | v2: 8 Vorschläge (3 × +1, 5 × −1), −23,49 Punkte, 1 Fehlalarm, 5 Vorschläge endeten an der Startsperre | v3: 6 Vorschläge (09.10. 19:47 +1 K Kinderzimmer oben; −1 K 10.10. 22:09, 11.10. 01:48 und 05:52 in Pausen, 12.10. 05:37 und 13.10. 03:48 im Dauerlauf bei Vorlauf ≤ Soll), 5 Treffer, 0 Fehlalarme, 0 Schaden, 0 verpasst, +12,72 Punkte, Skill 0,41 |
| Vorausschau | 0 (Gate zu) | 0 |
| Wächter | – | Kurvenform 08.10. 23:41, Wärmeverteilung 12.10. 09:23–10:58, Dornröschenschlaf 12.10. 21:21; kein H23 |
| Datensatz | 2,37 MB/Tag | 2,49 MB/Tag (Budget 2,7) |

### 20.4 Simulationen (Fake-Uhr, offline) und Tests

- **Dauerlauf** 700 min: −1 K nur in Minuten mit Vorlauf ≤ Soll, Erwartung „kein Stopp (gemessen bis +2,25 K)“.
- **Pendeln:** 4 Tage Dauer-Überschuss, jeder Vorschlag per Klick, Raum mit 90 min Zeitkonstante: −1 K, Rückweg nach 6 h, frühestens nach der Haltezeit wieder; ≤ 3 Übernahmen je Tag, nie 2 K, nie zwei Befehle binnen 60 min; die Dauerlage meldet „Kurvenform: kaltseitig senken“.
- **Versionswechsel** mit laufendem v2-Vorschlag (endet beim Laden, `S.verWechsel`, Haltezeiten neu) und mit laufender v2-Übernahme +1 K (Rückweg-Grund von v3 nach der Wirkzeit, applyTick schickt 0); v2-Summen bleiben unter `raum_offset|v2|s5`.
- **Frost** −5/−12 °C: Deckel 25/35 Hz, Schwelle des Effizienz-Deckels 28/38 Hz, keine Zielstufe, Kälte-Vorsorge Quiet 3 → 0; gelernte Mindestfrequenz; Mindestleistung je Segment.
- **8 Tage Fake-Uhr mit Frost** (−12…−4 °C an Tag 3–5, Abtauen, Klick auf jeden Vorschlag): kein Fehler, nie > 1 K, ≤ 6 Übernahmen je Tag, keine zwei Verschiebungsbefehle binnen 60 min, Überschuss durch die Mindestfrequenz → −1 K, Kälte-Vorsorge hält im Frost. Gefunden und behoben: Die Kälte-Vorsorge kehrte im Frost alle 2 h auf Quiet 3 zurück (Quiet 3 deckelt dort bei 25 Hz und galt nicht mehr als „hart“).
- Einzeltests: Abtau-Rückstand (Efficiency ja, Comfort nein), Frequenzsprung-Sperre (Quiet 2 → 0 gesperrt, Quiet 3 → 2 erlaubt, Heizstab-Nähe ausgenommen, Raumeinfluss +1 K in Comfort gesperrt), H23 (Kern und Hülle), Dornröschenschlaf (nicht nach Heizgrenze-Aus), Startschwelle, Kurvenform, 1 K je Befehl, Lüften, Radiator-Relais, Phase-2-Vergleich, Karte „Räume und Wächter“.

### 20.5 Versionswechsel im laufenden Betrieb

- Laufende, nicht übernommene Vorschläge einer Regel mit neuer Version (Quiet-Freigabe v2, Deckel/Laufzeit v4, Raumeinfluss v2) enden beim ersten Rechnen (nicht mehr klickbar, Eintrag `S.verWechsel`); Haltezeiten beginnen neu.
- Übernommene Werte bleiben: `OPT_apply.ak` und `S.arb/arbQ.applied` gehören weiter der Regel; ihr Rückweg kommt aus der neuen Version (Raumeinfluss: v3-Rückweg, ohne gespeicherte Bedarfsräume zählen alle Räume; Frist wie geklickt).
- Summen: neue Schlüssel `quiet_freigabe|v3|s5`, `quiet_strecken|v5|s5`, `raum_offset|v3|s5`; alte bleiben stehen. Basisraten: Freigabe weiter `quiet_freigabe|v2` (gleiche Auslösung, der Abtau-Rückstand kam nie vor), Deckel neu `quiet_strecken|v5`, Raumeinfluss neu `raum_offset|v3` und `raum_offset|v3|minus`.
- Die Takt-Messung lernt die Mindestfrequenz live ab dem Einspielen (das einmalige Nachladen ist schon gelaufen); das Startschwellen-Protokoll ebenso.

### 20.6 Geänderte Knoten (Generator gegen 8a83991, beide mit `--uebernahme-knoten-aktiv`, dieselbe Flow-Datei)

Nur `opt_*`, 7 geändert (nur `func`/`format`), 0 neu, 0 entfernt: `opt_engine` (Kern, Hülle: Eingaben `err`, `pipeIn`, `kurve`; `OPT_engine.hinweise/stoerung`), `opt_apply` (Kern, `plant.err`), `opt_t_eng_prop`, `opt_t_eng_rules`, `opt_t_eng_score`, `opt_t_eng_log`, `opt_t_eng_mess` (eingebettetes `eng_ui.js` v5 mit „Räume und Wächter“). `opt_apply_mqtt` bleibt aktiv. Einspielen später: `GEN_ARGS=--uebernahme-knoten-aktiv ./deploy_opt.sh …`. `apply.json` gibt `raum_offset` frei: nach dem Einspielen schlägt die Regel aus den Räumen vor (deutlich häufiger −1 K in kalten Nächten als v2).

### 20.7 Offene Entscheidungen

1. Raumeinfluss v3 für die Übernahme freigegeben lassen (er bleibt in `apply.json`)? Er schlägt im Replay 5 × −1 K und 1 × +1 K in 6 Tagen vor.
2. Kurvenform: Der Hinweis „Kaltpunkt −1 K“ beruht auf Daten vor der Änderung 38 → 37 °C; ein weiterer Schritt erst nach einer kalten Woche mit der neuen Kurve (Kinderzimmer oben ist bei Kälte der knappste Raum).
3. Effizienz-Deckel: 28 Hz ohne Takt (gewählt) oder ganz nur bei belegtem Takt? Endgültig erst mit Stromzähler.
4. Abtau-Werte (30 min, 3 K, −5…+4 °C, 60 min ≤ 20 Hz, 8 Hz) sind Annahmen aus dem Forum; im Winter mit eigenen Abtauungen prüfen.
5. H23-Vorstufe: Liefert HeishaMon `Inside_Pipe_Temp` für die L? Sonst entfällt sie.
6. Kern-Guard (RE-11) und Stromzähler (RE-12) wie bisher offen.

## 21. Regel „Heizregelung“ (Comfort/Efficiency) (14.10.2026, Branch `regel-heizregelung`)

Auftrag des Nutzers (14.10.): neue Regel „Heizregelung“ mit Comfort/Efficiency als Stellgröße (`SetHeatingControl` 0 = Comfort, 1 = Efficiency), Shadow mit Übernahme per Klick wie die anderen Regeln; die Whitelist kennt dafür 0 und 1, die Freigabe in `apply.json` entscheidet der Nutzer. Offline gebaut, nichts eingespielt. Ausgangspunkt ist der Live-Stand e8eed78 (ui-optik + raumeinfluss-v3, Sendeknoten aktiv). Regelversion `heizregelung` v1; die vier anderen Regeln und die Bewertungsregeln v5 sind unverändert.

### 21.1 Datengrundlage (07.10. 16:54 – 14.10. 14:07, 9913 Minuten; `node tools/heizregelung_analyse.js <Datenordner>`)

| Befund | Wert | Folge für die Regel |
|---|---|---|
| Comfort-Start | Quiet 0: 12.10. 21:32 (6 °C) 35 Hz, Soll −1 K nach 6 min; 13.10. 11:58 (13 °C) 31 Hz, nach 2 min. Quiet 2: 21 Hz (13.10. 16:29), Quiet 3: 17 Hz (21:00). Startphase 4–8 °C: 34,5 Hz, 815 W gegen Efficiency 17,7 Hz, 400 W | Comfort wirkt nur, wenn Quiet es zulässt → **zuerst die Quiet-Freigabe** (4c). Erwartung +6 Hz / +100 W binnen 5 min |
| Efficiency-Start | alle 21 Efficiency-Starts 08.–14.10. bis Laufminute 15 mit 16–17 Hz, davon 9 mit Quiet 0 (dort bis Minute 30 höchstens 20 Hz); Soll −1 K nach 2–61 min (Median 15); zeitweise 21–26 Hz ab Laufminute 39–46 | träge Phase bis Laufminute 45 (`traegeMin`), träge = höchstens 21 Hz (Frost: Mindestfrequenz + 1 Hz) |
| Mitten im Lauf | Efficiency/Quiet 0 regelt bei Rückstand selbst hoch (Boost 10.10. Laufminute 68: 29 → 34 Hz in 2 min) | nach Laufminute 45 kein Comfort nötig |
| Wechsel im Lauf | Efficiency → Comfort bei 16–17 Hz am Soll (12.10. 18:28, 13.10. 07:07): Frequenz und Pumpe unverändert (16,6 Hz, 1750 U/min). Comfort → Efficiency: 08.10. 10:03 Pumpe 1750 → 2870 U/min, Durchfluss 13,4 → 23,0 l/min, TOP16 +25–31 W; 12.10. 22:01 bei 28 Hz: Pumpe 1750 → 2870, 28 → 25 Hz, 672 → 614 W; 13.10. 22:45 Pumpe blieb bei 1800 U/min, Thermo-Stopp 6 min später (Vorlauf an der Abschaltgrenze, nicht durch den Wechsel) | Wechsel nach Efficiency **nur in der Pause** (`nurPause`): 23 l/min liegt über dem Wunsch des Nutzers (~19 l/min, Heizkörpergeräusche); die Kosten von Comfort entstehen erst beim nächsten Start |
| COP mitten im Lauf | stabile Minuten ab Laufminute 15, korrigiert +80 W, Quiet 0, 16–17 Hz, Comfort/Efficiency: < 4 °C 4,10/4,17 (18/315 min), 4–8 °C 4,93/4,38 (119/192), 8–11 °C 5,28/4,85 (125/433), ≥ 11 °C 5,55/5,63 (60/306). COP-Matrix (Takt-Messung, Quiet 0): 3…7 °C 4,80/4,27 (2,3/5,1 h), 7…11 °C 5,25/4,89 (2,3/10,6 h), 11…15 °C 5,32/5,70 (1,6/8,1 h) | Comfort bei 3–11 °C 7–13 % besser, ab 11 °C gleich oder schlechter; nur ~6 h Comfort, andere Tageszeiten, Durchfluss Comfort 13,6 l/min gegen Efficiency 13,6–15,6 l/min, Pth ±10 %: **nicht belastbar** → nur als **COP-Veto** gegen Efficiency (`copTol` 10 %, wie Deckel/Laufzeit), kein Comfort-Auslöser aus dem COP |
| Hochlauf | ab 28 Hz COP gegen 16–17 Hz korrigiert −3 %, roh −5…−15 % (20.2) | Kosten von Comfort = Hochlauf ohne Bedarf; Bewertung „Comfort fährt ohne Bedarf hoch (≥ 28 Hz)“ |
| Abtauen | keine eigenen Daten (Außen ≥ 1 °C). Forum 189605: Efficiency hält nach dem Abtauen ~20 min niedrig (L5 25 Hz 4582615, L7 4095732), das Haus kühlte in Abtauserien aus (4096011); Pseudo-Abtauung bei Frequenzsprung nach langem Niedriglauf; L5 stellte von Comfort auf Efficiency, weil mit Comfort und Flüstermodus 1 der Heizstab in Abtauphasen zuschlug (4589236) | Abtau-Rückstand als Comfort-Bedarf (ANNAHME), Sperre „Frequenzsprung bei Abtauwetter“ |
| Heizstab | keine Daten (Außen ≥ 1 °C, 0 min Heizstab) | Heizstab-Nähe als Notfall (ANNAHME); Comfort hält durch das Frostfenster |
| Wechsel von Hand | sieben: 08.10. 10:02 E; 12.10. 18:26 C, 22:00 E; 13.10. 07:06 C, 15:29 E, 15:40 C, 22:43 E | nach einem Wechsel von Hand 2 h kein Vorschlag zurück (`handRuheMin`, außer Notfall) |

### 21.2 Regel v1 (Bedingungen: Abschnitt 4, Schwellen mit Herkunft: Tabellen oben)

- **Comfort (Efficiency → Comfort):** Bedarf wie Quiet-Freigabe v3 (Raum unter Minimum oder fällt darauf zu, Heizstab-Nähe, Abtau-Rückstand, Boost) **und** Efficiency träge (bis Laufminute 45, nach dem Abtauen oder bei Heizstab-Nähe; höchstens 21 Hz) **und** Vorlauf/Rücklauf je ≥ 1,5 K unter Soll **und** der Quiet-Deckel lässt den Hochlauf zu. Kein Wechsel in der Startphase (15 min, bei Heizstab-Nähe bis Minute 7), Haltezeit 10 min (Heizstab-Nähe 3 min). Ohne Bedarf steht die Regel in Efficiency kurz auf „ruht: Efficiency ohne Bedarf“.
- **Rückweg:** Bedarf 15 min am Stück gedeckt (Räume ≥ Minimum + 0,3 K, auch beim jetzigen Gefälle in 2 h über Minimum; Rücklauf ≤ 0,5 K unter Soll; Außen ≥ Heater_On_Outdoor_Temp + 3 K; nicht binnen 30 min nach dem Abtauen) und Pause; Frist 4 h, sie ruht bei Bedarf, Heizstab-Nähe, Abtau-Nachlauf und im Lauf. Ein Rückweg gilt nicht als Wechsel von Hand.
- **Efficiency (Comfort von Hand → Efficiency):** wie der Rückweg, dazu: Pause, Quiet lässt den Comfort-Hochlauf überhaupt zu (Quiet 0 oder Deckel ≥ 28 Hz, sonst kostet Comfort nichts), kein COP-Veto, Wechsel von Hand ≥ 2 h her. Efficiency ist der Normalzustand: kein Rückweg, die Übernahme endet mit der Bestätigung (`p.einmal`).
- **Arbitrierung:** eigene Größe `hc` (`S.arbH`), Mindestabstand über Quiet, Verschiebung und Heizregelung, zuerst Quiet, kein Effizienz-Deckel gegen Comfort der Regel (4c). Tageslimit 3 übernommene Wechsel; ausgenommen ist nur die Heizstab-Nähe (ein Raum-Notfall nicht, sonst Comfort bei jedem Start).
- **Sperre „Frequenzsprung bei Abtauwetter“:** gilt (Comfort hebt auf ~33 Hz bzw. bis zum Deckel), ist mit `traegeMin` 45 aber praktisch unerreichbar: in der Anlaufphase gibt es keinen 60-min-Niedriglauf, eine echte Abtauung setzt ihn zurück, Heizstab-Nähe ist ausgenommen (Test h2b mit `traegeMin` 120).
- **Heizregelungs-Hinweis** (Tab „WP Dash“) bleibt unverändert; seine Bedingung ist der Heizstab-Bedarf der Regel.
- **Übernahme:** Whitelist `SetHeatingControl` {0, 1}, Rücklesen über `Heating_Control` (`plant.hc` in `opt_apply`), je Größe eine Übernahme (`OPT_apply.ak.hc`), Statuszeile „Übernommen …: Comfort · zurück auf Efficiency um …“ bzw. „… Efficiency · Normalzustand“; die Quelle „Optimierer (Klick)“ erscheint im Ereignis `heizregelung_befehl`.

### 21.3 Bewertung (Regeln v5 unverändert)

- Prognose Comfort: „Ohne Comfort bleibt Efficiency träge: höchstens 21 Hz und Vorlauf ≥ 1 K unter Soll“, p 0,7, 15/30 min, Basisrate `heizregelung|v1` (Vergleichslage: Comfort-Lage ohne Haltezeit).
- Prognose Efficiency: „Ohne Efficiency fährt der Verdichter in Comfort ohne Bedarf hoch (≥ 28 Hz ab Laufminute 2)“, p 0,6, 120/240 min (Ereignis), Basisrate `heizregelung|v1|eff`.
- Wirkung (jeder Wechsel, von wem auch immer): Efficiency → Comfort im Lauf mit Rückstand: +6 Hz binnen 5 min und +100 W (je ±10); Comfort → Efficiency: der nächste Start bleibt bis Laufminute 15 bei höchstens 21 Hz (nur mit Quiet 0 messbar). Kalibrierfälle (0 Punkte): die Wechsel von Hand 08.10. 10:03, 12.10. 22:01, 13.10. 15:31 und 22:45.
- Schaden: Comfort wie „mehr Leistung“ (Stopp binnen 10 min, Überschwingen, zu warm, Heizstab), Efficiency wie „weniger Leistung“ (zu kalt, Heizstab); Lüften und Bandwechsel sind für diese Regel Eingriffe (wie bei den Raumregeln).
- Verpasst: Notfall in Efficiency (Heizstab-Nähe oder Raum ≥ 0,3 K unter Minimum) bei träger Efficiency mit Rückstand und zulassendem Quiet, 20 min ohne Vorschlag → −20 (Schaden „komfort“/„heizstab“ hebt eine Sperr-Entschuldigung auf). Efficiency ist nie „verpasst“.
- **Eingriff (neu für alle Regeln):** ein Wechsel der Heizregelung beendet die Bewertung offener Fälle wie ein Wechsel von Quiet oder Verschiebung. Replay: Punkte der anderen Regeln unverändert; Vergleichslagen `quiet_strecken|v5` (30 min) 3 → 4, `vorausschau|v2` 11/9/6 → 10/5/2.
- Datensatz: `abl.hc` (Lage +1/−1), `abl.hc_deck` (Minuten „Bedarf gedeckt“ in Comfort); Größe 2,65 MB/Tag (07.–13.10.) bzw. 2,67 MB/Tag (07.–14.10.), Budget 2,7.

### 21.4 Replay (alter Kern e8eed78 gegen neuen Kern, dieselben Daten)

| | 07.–13.10. (`replay_data_1310`, 8650 min) | 07.–14.10. (Kopie 14.10. 14:07, 9913 min) |
|---|---|---|
| Quiet-Freigabe, Deckel/Laufzeit, Raumeinfluss, Vorausschau | 0 abweichende Minuten (Status, Grund, nächste Schwelle, Sperren, Vorschlag), 7 = 7 Vorschläge mit Prüfsumme, Punkte je Eintrag gleich | ebenso |
| Heizregelung, Comfort | 0 Vorschläge, 0 Minuten Comfort-Lage | ebenso |
| Heizregelung, Efficiency | 13.10. 13:51 (Pause, 15 °C, Quiet 0, Comfort von Hand seit 07:06, abgelaufen 14:21) und 15:21 (Pause, 14 °C); der Nutzer stellte 15:29 selbst Efficiency (zählt als übernommen), ab 15:40 wieder Comfort von Hand mit Quiet 1/3 → kein Vorschlag (Comfort fährt nicht hoch) | ebenso; 131 Minuten Efficiency-Lage |
| Punkte Heizregelung | 0 (3 Wirkungsfälle, alle Kalibrierung) | 0: 2 Fälle neutral (Eingriff: Wechsel 15:29), 4 Wirkungsfälle, alle Kalibrierung |

Warum nie Comfort: 15 Bedarfs-Episoden in Efficiency (~1000 Laufminuten), davon 857 Minuten unter einem bindenden Quiet-Deckel (Quiet 2/3 vom 08. bis 10.10.; 10.10. 08:36 bleibt die Quiet-Freigabe zuerst, danach regelte Efficiency/Quiet 0 selbst auf 34 Hz), der Rest ohne Vorlauf-/Rücklauf-Rückstand oder nach Laufminute 45. Mit vorbefüllter Takt-Messung (COP-Matrix der ganzen Woche) identisch; bei 11…15 °C kein Veto (Efficiency 5,70 gegen Comfort 5,32).

### 21.5 Simulationen und Tests (`engine_sim` Abschnitt (h), Fake-Uhr)

- **h1 Komfortbedarf:** Efficiency, Quiet 0, 6 °C, Schlafzimmer 0,4 K unter Minimum, Vorlauf 2,5 K unter Soll → Comfort in Laufminute 25 (Notfall, `abl.hc` = 1); ab Laufminute 45 nicht (h1b); unter Quiet 3 zuerst die Quiet-Freigabe (h1c); ohne Bedarf „ruht“ (h1d).
- **h2 Abtau-Rückstand:** Comfort 10 min nach der Abtau-Sperre; in Comfort kein Wechsel nach Efficiency nach dem Abtauen. **h2b** Sperre „Frequenzsprung bei Abtauwetter“ greift (2 °C, 60 min ≤ 20 Hz, +16 Hz).
- **h3 Heizstab-Nähe:** Comfort in Laufminute 10, 5 min vor der Heizstab-Freigabe; Comfort hält, solange die Nähe besteht.
- **h4 Klick:** SetHeatingControl = 0, Bedarf gedeckt, Rückweg = 1 erst in der Pause (kein Wechsel von Hand), Übernahme beendet.
- **h5 Comfort von Hand:** Efficiency-Vorschlag erst nach 2 h, in der Pause; Übernahme endet mit der Bestätigung; unter Quiet 3 keiner. **h5c** COP-Veto (Efficiency > 10 % schlechter) verhindert den Vorschlag.
- **h6 Quiet zuerst:** Quiet-Freigabe 3 → 0 in Laufminute 25, Comfort in Laufminute 36 (Notfall nach 10 min), kein Effizienz-Deckel gegen Comfort.
- **h7 Pendeln** (2 Tage, Bedarf bei jedem Start, jeder Vorschlag per Klick): höchstens 3 Comfort-Klicks je Tag, Comfort-Befehle ≥ 180 min auseinander, Rückweg 95 min nach Comfort in der Pause.
- **h8 Bewertung:** Comfort-Fall Treffer (Efficiency blieb träge), Efficiency-Fall Treffer (Comfort fuhr auf 32 Hz), Wirkung +20 (17 → 31 Hz, +320 W).
- **h9 Einspielen** auf einen Zustand ohne Heizregelung: Zustand ergänzt, kein Fehler, alter Comfort gilt nicht als „von Hand“.
- **h10 8 Tage Fake-Uhr mit Frost** (Tage 3–5 −8 ± 4 °C, Abtauen alle 150 Laufminuten, Heizstab ab 0 °C, Anlagenmodell mit Efficiency-Trägheit und Comfort-Hochlauf): Shadow 9 Comfort-Vorschläge (8 im Frost aus Heizstab-Nähe, 1 mild mit Raumbedarf), keiner in der Startphase; mit Klick ein Comfort-Befehl 10.12. 00:03, gehalten durch den Frost, Rückweg 14.12. 16:41 in der ersten Pause danach; höchstens 6 Übernahmen je Tag; Heizstab-Minuten 8 gegen 8 (Spielzeugmodell, keine Messung); Kosten: 6667 Comfort-Laufminuten, davon 2122 mit ≥ 28 Hz.
- Hülle: `opt_apply` gibt `Heating_Control` als `plant.hc` weiter, `SetHeatingControl` = 0 passiert die letzte Sicherung.
- Ergebnisse: Abschnitt 11 (Zeile 14.10., `regel-heizregelung`). Vorschau A–F bei 1024/1920/2560 px: 18 × OK (F = 13.10. 13:52 mit dem Efficiency-Vorschlag; fünf Regel- und Punkte-Kacheln je ~168 px).

### 21.6 Geänderte Knoten (Generator gegen e8eed78, beide mit `--uebernahme-knoten-aktiv`, dieselbe Flow-Datei)

Nur `opt_*`, 7 geändert (nur `func`/`format`), 0 neu, 0 entfernt: `opt_engine` (Kern), `opt_apply` (Kern, `plant.hc`), `opt_t_eng_prop`, `opt_t_eng_rules`, `opt_t_eng_score`, `opt_t_eng_log`, `opt_t_eng_mess` (eingebettetes `eng_ui.js` v7, fünf Kacheln). `opt_apply_mqtt` bleibt aktiv. Einspielen später: `GEN_ARGS=--uebernahme-knoten-aktiv ./deploy_opt.sh …`. Der Zustand wird beim ersten Rechnen ergänzt (`S.arbH`, Regel `heizregelung`); die anderen Regeln wechseln nicht die Version. Die Übernahme der Heizregelung ist erst mit `"heizregelung"` in `apply.json` → `rules` frei.

### 21.7 Offene Entscheidungen

1. **Freigabe in `apply.json`:** `"heizregelung"` in `rules` aufnehmen? Im Replay nur zwei Efficiency-Vorschläge in 7 Tagen, kein Comfort; Vorschlag: erst im Shadow beobachten.
2. **Schwellen (alle ANNAHME):** `traegeMin` 45, `traegeHz` 21, `rueckMin` 15, `komfortK` 0,3, `heizstabHystK` 1, `abtauNachMin` 30, `handRuheMin` 120, `maxDauerMin` 240, `proTag` 3, `copTol` 10 %, `nurPause` 1.
3. **Heizstab freigegeben?** Bei der L ist er ab Werk aus (Forum 3957497, TODO F7-a). Ist er aus, ist die Heizstab-Nähe als Comfort-Auslöser (und das Halten von Comfort durch den Frost) überflüssig.
4. **Comfort im Frost halten** kostet bei jedem Start einen Hochlauf; der Nutzen (Heizstab, Abtau-Rückstand) ist ohne Frostdaten nicht belegt.
5. **COP-Matrix:** Comfort war mitten im Lauf bei 3–11 °C 7–13 % besser (je 2,3 h). Sollte sich das mit mehr Daten bestätigen, wäre „Ziel Efficiency“ dort falsch; bisher nur Veto.
6. **Abtauserien:** Forum widersprüchlich (Comfort bei Vereisungswetter empfohlen gegen „Efficiency-Anhebungen beschleunigen die Vereisung“ und Heizstab mit Comfort in Abtauphasen); Winterdaten abwarten.

## 22. Gebäudemodell v3 und eigene Nachheizung (15.10.2026, Branch `modell-v2`; Entscheidungen 2 und 5 des Nutzers)

Grundlage: `docs/ALGORITHMUS.md` (Branch `algorithmus`), Schicht 1 und offene Entscheidungen 2 und 5. Alles bleibt Shadow; nur `opt_*`-Knoten und `engine_core.js` ändern sich.

### 22.1 Entscheidung 2: Gebäudemodell im Wärmefahrplan (PLAN_VER 13, MODELL_VER 3)

- **Bedarf je Slot:** max(0, UA · (T_innen − T_außen) − Gewinne) statt UA · max(0, 15 °C − T_außen). Die Heizgrenze der Anlage (15 °C) ist kein Bilanzpunkt des Hauses; der liegt bei T_innen − Gewinne/UA (Replay: ~19 °C).
- **Lernen** (reine Funktionen `fitModel`, `ridgeCore` im Block REIN von `opt_plan`): Tagesbilanz Q = UA · Σ(T_innen − T_außen)·Δt − Gewinne · 24 h, gewichtete kleinste Quadrate. Vorwert wie `tools/plan_algo.js`: UA 0,15 kW/K, Gewinne 0,3 kW als 2 Pseudo-Tage bei 10 und 16 K; gelernt erst ab 2 Lerntagen (`lernMinTage`). Grenzen UA 0,07–0,35 kW/K, Gewinne 0–1,2 kW (exakt über die aktiven Grenzen), T_innen 18–25 °C. Lern-Hygiene unverändert (Lern-Gate, Tage unter 30 Kh(15) lernen nicht mit; `hddRefC` 15 ist nur noch dieser Filter).
- **T_innen:** Mittel der Räume mit Wert je Minute; für den Plan das Mittel der letzten 3 vollen Tage, sonst die Räume jetzt, sonst 22 °C.
- **Langsame Anpassung** (`modellSchritt`): je neuem Tag höchstens UA ±15 %, Gewinne ±0,15 kW, T_innen ±0,5 K auf das gelernte Ziel zu; beim ersten Lauf (Deploy) gilt das Ziel sofort. Die Zeile „Gebäudemodell“ zeigt Stand und, solange gebremst, das Ziel.
- **Prognose:** OWM + Tagesgang der Abweichung Fühler − OWM (Mittel je Uhrzeit über 3 Vortage, `tgProfil`; Daten aus plan-actuals) + abklingender Rest des heutigen Versatzes (4 h). Ohne 3 volle Vortage wie bisher.
- **Tagesaggregat:** Einträge 21–25 (K·h gegen T_innen, T_innen, Wind × (T_innen − T_außen), dasselbe mit OWM); plan-days hinten `kh_innen_fuehler,t_innen`. Die Rückrechnung aus plan-actuals rechnet dieselben Größen.
- **Gate** (Logik unverändert: 10 Tage, PV-Spreizung, Fehler 10 % kleiner, plausible Koeffizienten): Fehlermaßstab ist jetzt der Leave-one-day-out-Fehler des Grundmodells (UA, Gewinne) gegen das Modell mit Sonne/Wind; der alte Verhältnis-Schätzer entfällt. Wind-Merkmal (T_innen − T_außen) × Wind über 4 m/s.
- **Modellwechsel:** A/B-Tage, Drift, Rückfall-Sperre und Stände des alten Modells werden verworfen; das A/B zählt nur Schnappschüsse mit `modell_ver` 3.
- **Vorausschau v3:** `OPT_plan.model` liefert `ua`, `g`, `ti` und `tbal` = Bilanzpunkt, damit ua · max(0, tbal − T) = max(0, UA · (T_innen − T) − Gewinne) (dasselbe Modell wie der Plan; Wind mit (T_innen − T)). Regel und Schwellen unverändert, eigene Basisrate `vorausschau|v3`. Replay 07.–15.10.: Gate zu wie live → identisch; Gate testweise offen → Bedarfsänderung ≤ −2 K in 1432 statt 1440 Minuten, in beiden Fällen kein Vorschlag.
- **Prognosefehler** (`node tools/modell_v2_replay.js <Daten> --md`, Prognose von 00:00, nur Vortage gelernt, 08.–14.10.): altes Modell 6,9 kWh, neues 3,3 kWh Wärme je Tag (Vorarbeit `plan_algo.js`: 6,8 → 4,3).

### 22.2 Entscheidung 5: Raum mit eigener Nachheizung

- **Konfiguration:** `OPT_cfg.rooms[].eigeneHeizung` (Standard: nur Kinderzimmer oben `true`), Schalter „eigene Heizung“ in der Karte „Räume“ (`room:<id>:eigeneHeizung`, gespeichert in config.json). Fehlt das Feld im Speicher (Deploy ohne erneutes `opt_i_init`), gilt der Standard des Generators (`eigenOf`).
- **Kein Bedarf für das ganze Haus:** Raumeinfluss v4 (+1 K, Bedarfsräume, Rückweg „Bedarf gedeckt“), Quiet-Freigabe v4 und Heizregelung v2 (Bedarf, Raumtrend, Komfort-Notfall), Komfort-Notfall der Verschiebung (+1), Phase-2-Vergleichsvorschlag, „verpasst“ des Raumeinflusses.
- **Zählt weiter:** keine Absenkung (−1 K) und Rückweg von −1 K, solange er unter Minimum liegt; Reserve; Effizienz-Deckel (Komfort sicher) und dessen Rückweg; „gedeckt“ der Quiet-Freigabe/Heizregelung; Hinweis Wärmeverteilung. Der fest verdrahtete Raum `RELAIS_RAUM` (Relais aus = kein Bedarf, RE-8) entfällt; `kzRad` bleibt im Datensatz.
- **Bewertung:** Bewertungsversion 5 unverändert (Schaden „Raum > 1 K unter Minimum“ zählt weiter jeden Raum).
- **Replay 07.–15.10. (alt 7ebd67a gegen neu):** Raumlage +1 788 → 110 min, Quiet-/Comfort-Bedarf 1813 → 820 min, Komfort-Notfall 1057 → 370 min, keine davon aus Kinderzimmer oben (vorher 678 / 1103 / 687). Entfällt: +1 K 09.10. 19:47 (Kinderzimmer oben); Boost 10.10. 08:36 bleibt, aber aus dem Soll von Hand, schrittweise Quiet 3 → 1 statt 0. Neu: Hinweis Wärmeverteilung 10.10. 06:58–08:58 (Kinderzimmer oben −1,4 K, Kinderzimmer unten über Maximum). −1-K-Vorschläge und Heizregelung unverändert.
- **Tests:** engine_sim g14a–f, Hülle (Standard ohne Feld), Replay; optimizer_sim Konfiguration und Karte. Die kalibrierten Replay-Prüfungen 07.–13.10. laufen ohne eigene Nachheizung und bis 13.10. 17:04 (`engine_replay.js --ohne-eigene --bis=…`), die Wirkung von Entscheidung 5 prüft ein eigener Abschnitt.

## 23. Paket 2: Sonnenfenster, ruhende Frist, Status des NAS-Containers, Winter-Protokoll (15.10.2026, Branch `modell-v2`)

Alles bleibt Shadow; geändert werden nur `opt_*`-Knoten (Generator) und `engine_core.js` (Regeln als Daten, Tabellen oben aus dem Regelwerk).

### 23.1 Raum-Eigenschaft „Sonnenfenster“ (Raumeinfluss v5, Deckel/Laufzeit v6)

- **Konfiguration:** `OPT_cfg.rooms[].sonnenfenster` (Standard: nur Wohnzimmer `true`, Südwestfenster), Schalter „Sonne“ in der Karte „Räume“ (`room:<id>:sonnenfenster`, Tooltip). Fehlt das Feld im Speicher, gilt der Standard des Generators (`sonneOf`). Die Raumtabelle hat engere Zellen (4 px statt 6 px seitlich), damit sie bei 1024 px in die Karte passt.
- **Sonne liegt an** (`sonneStep`, Schwellen `sonne*` in `raum_offset`): 11–18 Uhr Ortszeit UND (PV-Leistung ≥ 20 % der höchsten PV-Leistung der letzten 7 Tage ODER OWM-Bewölkung < 50 %). PV kommt aus `OPT_plan_in.pvNow` (opt_energy aus `OPT_en`, höchstens 5 min alt), die Bewölkung aus `OPT_weather` (höchstens `weather.maxAgeMin`). Beide stehen im Datensatz (`pv`, `wolken`).
- **Der Raum wird von der Sonne gewärmt:** er stieg in den letzten 60 min um mindestens 0,1 K (geglätteter Wert), obwohl der Verdichter mindestens 30 von 60 min stand oder der Vorlauf um mindestens 0,5 K fiel; das gilt 60 min nach dem letzten solchen Anstieg.
- **Wirkung, solange beides zutrifft:** kein Überschuss-Auslöser für −1 K (Raum über Maximum; „alle Räume über der Bandmitte“ gilt nicht, solange die Sonne einen davon wärmt), kein Komfort-Notfall −1, Deckel/Laufzeit: weder „über der Bandmitte“ gegen +1 K noch Rückweg von +1 K. Kurvenform zählt die Raumlage, also ebenfalls ohne diese Minuten.
- **Zählt immer:** Bedarf (+1 K), Reserve-Sperren, Hinweis Wärmeverteilung (mit „(Sonne)“). Außerhalb der Bedingung zählt der Raum normal (nachts bei 24,5–25 °C kommt −1 K weiter).
- **Bewertung v5 unverändert:** Der Prognose-Ausgang „Haus weiter überheizt“ zählt den Raum weiter (offene Frage).
- **Replay** (Daten bis 15.10. 23:25, alt ea8392d gegen neu): keine Vorschläge entfallen (die Nachmittagslagen am 11., 14. und 15.10. wurden schon von der Untergrenze 29 °C oder der Haltezeit 60 min gestoppt). Überschuss-Minuten 11–18 Uhr: 14.10. 20 → 10, 15.10. 220 → 118; Status Raumeinfluss „bereit“ 4137 → 4024 min. 11.10.: Wohnzimmer-Fühler meldete 10:32–15:47 nichts (Gen1), ohne Anstieg greift das Sonnenfenster nicht. 15.10. 14:40–15:10 lief die WP (17 Hz, Vorlauf gleich): die Lage −1 bleibt, wie vorgegeben.

### 23.2 Ruhende Frist bei Dauerbedarf (Raumeinfluss v5)

- **Befund** (Anlagen-Zwilling, Frost, `tools/engine_vs_zwilling.js`, Branch `wp-zwilling`): +1 K nach 6 h zurück, 1 h später wieder +1 K (16 Vorschläge, 32 Verschiebungs-Befehle in 5 Tagen).
- **Neu** (`raumDauer`): Solange ein gültiger Bedarfsraum des +1 K unter Minimum + 0,3 K liegt oder noch nicht 30 min am Stück gedeckt ist, meldet die Maschine „halten“ („Bedarf besteht weiter (…): Frist ruht seit …“); die Übernahme lässt dann die Frist ruhen. Gedeckt endet sie wie bisher über „Bedarf gedeckt“ (der Rückweg nennt jetzt den Grund auch nach der Frist). Ohne gültige Bedarfsräume gilt die Frist wie bisher.
- **Obergrenze** `dauerMaxMin` 24 h: danach gilt die Frist wieder (Rückweg), Hinweis `dauerbedarf` „Heizkurve/Kaltpunkt prüfen“ (Kachel „Raumlage“, Ereignis), bis der Bedarf gedeckt ist.
- **Quiet-Freigabe und Heizregelung:** unverändert. Sie halten bei Bedarf schon (Zwilling: je 1 Befehl in Frost, Abtauwetter und Woche, kein Wechsel).
- **Zwilling, Modus „sofort“** (alt → neu): Frost 16 → 5 Vorschläge Raumeinfluss, 34 → 11 Befehle; Abtauwetter 17 → 5, 35 → 11; Woche 21 → 7, 43 → 15; mild unverändert (7 × −1 K).

### 23.3 Karte „Auswertung NAS (optimizer-tools)“ (Daten & Güte)

`opt_i_nas` (alle 5 min) → `opt_nas` (liest `/data/optimizer-tools/status.json`, Format 2, nur lesen) → `opt_t_nas`. Zeilen mit Chip ok/warn/Fehler, Details im Tooltip: letzter Lauf (Zeit, Dauer; „veraltet“ nach 26 h), Training (Ampel, Drift), Replay-Güte (Prozent oder „nicht bewertbar: Grund“), Minutenprotokoll (Lücken > 10 min, Frische), Raumfühler (Lücken > 120 min), Sicherung (Datum, MB, geprüft), Fehler des Laufs. Datei fehlt: „kein Lauf“. Vorschau mit `tools/fixtures/optimizer_tools_status.json` (Kopie vom 15.10. 22:27).

### 23.4 Winter-Protokoll

- **`defrost-*.csv`** (hinten angehängt): `ende`, `vl_einbruch_k` (Vorlauf vor dem Abtauen − Minimum), `rohr_aussen_vor`, `rohr_aussen_nach` (Outside_Pipe_Temp), `strom_nach_kwh` (Wiederaufheizen). Heizregelung ohne 10-min-Grenze; Beginn der letzten Abtauung übersteht einen Neustart (`watcher-state.json`). Test: Winter-Zyklus (Forum L5, Vorlauf 36 → 22 °C) füllt jede Spalte.
- **`quiet-*.csv`** (hinten angehängt): `heizstab_stop_delta` (TOP98), `verdampfer_aus` (Eva_Outlet_Temp), `heissgas` (Discharge_Temp), `hochdruck` (High_Pressure), `expansionsventil` (Expansion_Valve), `rohr_innen` (Inside_Pipe_Temp). `fan1`, `verdichter_strom`, `rohr_aussen` gab es schon.
- **Leser:** `engine_replay`, Takt-Nachladen, Beobachter und `kennzahlen_tag.py` (Container) lesen nach Spaltennamen mit wechselnden Kopfzeilen; die neuen Spalten stören nicht und werden (noch) nicht ausgewertet.

## 24. Winterpaket: Regeln gegen die Forenbefunde zur Aquarea L abgesichert, Zwilling nachgezogen (16.10.2026, Branch `winterpaket`)

Grundlage: `forum_wissen/LEISHA_WISSEN.md` (Abschnitte 1–13, Tabelle (a), Lehren (b)), TODO „16.10. Forum-Wissen konsolidiert“, Sanftanlauf-Basis 11.–16.10. (Efficiency-Start 0,17–0,23 kWh in 30 min, Comfort-Start 0,43 kWh; Rohr außen bei 5 °C schon −1 °C). Alles Shadow; geändert sind nur `opt_*`-Knoten (`opt_engine`, `opt_apply` = Kern, `opt_plan`, `opt_quiet`) und die Werkzeuge. Bewertung v5 unverändert (siehe 24.6).

### 24.1 Abtauwetter (gemeinsame Definition, Sperre `abtausprung`)

- **Abtauwetter** = Fühlerwert der WP −5 °C bis **unter 10 °C** (bisher −5…+4 °C) UND (OWM-Feuchte ≥ 80 % ODER Rohr außen ≤ 0 °C). Ohne Feuchte und Rohrwert gilt wie bisher der Bereich bis 4 °C. Pseudoabtauungen bis 9 °C, über 10 °C nie (4011622, 3456847, 4466101).
- Neue Eingänge der Maschine: `rh` (OPT_weather.rh, höchstens weather.maxAgeMin alt) und `pipeOut` (Outside_Pipe_Temp, letzter Wert bis 24 h, −128 = kein Fühler); im Datensatz `in.rh`, `in.pipeOut`, `abl.aw` = 1 bei Abtauwetter. Replay: Feuchte in 13 318 von 13 323 Minuten, Rohr seit 14.10. (3823 Minuten).
- Die Sperre „Frequenzsprung bei Abtauwetter **oder Kaltstart**“ bündelt: (1) Sprung ≥ 8 Hz nach ≥ 60 min ≤ 20 Hz (wie bisher, jetzt mit der neuen Abtauwetter-Definition); (2) Stufenabstand der Quiet-Freigabe; (3) Comfort-Sperren; (4) +1 K als Kaltstart; (5) 30 min nach „Anlage hat Quiet beendet“. Sie entschuldigt „verpasst“ wie bisher (Liste `EXCUSE`, Bewertung unverändert).

### 24.2 Heizregelung v3

- Kein Comfort-Vorschlag (a) binnen 30 min nach dem Abtauende (`abtauNachMin`, Abtauspirale 4554672), (b) in den ersten 45 Laufminuten bei WP-AT ≤ 4 °C (`kaltstartAtC`, `kaltstartMin`; Comfort-Kaltstart mit 67–68 Hz, Rohr −20 °C, Abtauung: 4005690, 3474343, 4006429), (c) bei Abtauwetter nur bei Heizstab-Nähe.
- Der Auslöser „Efficiency träge nach dem Abtauen“ entfällt: der Abtau-Rückstand ist kein Comfort-Bedarf mehr (`bedQ.jaHc`), er bleibt Bedarf der Quiet-Freigabe (stufenweise). Rückweg nach Efficiency unverändert (in der Pause, nicht binnen 30 min nach dem Abtauen). Neue Basisrate `heizregelung|v3`.
- Schalter `heizstabVorrang` (Standard 0 = Auftrag wörtlich): mit 1 übergeht Heizstab-Nähe auch (a) und (b) (Zwilling: 24.5, Zeile D).

### 24.3 Quiet-Freigabe v5, Deckel/Laufzeit v7, Raumeinfluss v6

- **Quiet-Freigabe:** bei Abtauwetter im Lauf je Vorschlag nur die nächste *wirksame* Stufe (Deckel ≥ jetziger + 3 Hz; Stufen mit gleichem Deckel werden übersprungen), bei Heizstab-Nähe zwei; keine tiefere Stufe wegen COP. Zwischen zwei Senkungen mindestens `stufeMin` 30 min (EEV: 30 Halbschritte je 90 s, ~2,5 h zum Einschwingen; +6 Hz ok, +10 Hz nicht: 4549934, 4886674, 4553013), auch im Notfall.
- **Anlage hat Quiet beendet** (Flüster-Priorität „Leistung“: Wasser 30 min 5 K unter Soll, 3469566): sinkt Quiet ohne Vorschlag einer Regel, während Vor- oder Rücklauf seit ≥ 25 min ≥ 4,5 K unter Soll liegen (`anlQK`, `anlQMin`), meldet die Maschine das Ereignis `optimierer_anlage` „Anlage hat Quiet beendet“ (Hinweis 30 min, `abl.anl_q`), ein Wiederaufnehmen ebenfalls; 30 min keine weitere Freigabe, kein Comfort, kein +1 K mit Hochlauf (`anlQSperreMin`, Heizstab-Nähe ausgenommen). Kein „verpasst“, weil die Sperre entschuldigt. Replay 07.–16.10.: 7 Quiet-Senkungen ohne Regel, keine erfüllt die Bedingung (Boost 10.10. 08:42: 7,5 K, aber erst 16 min) → kein Ereignis.
- **Deckel/Laufzeit:** Quiet höher bei Abtauwetter nur eine Stufe; +1 K in der Pause nur als gewollter Start (siehe unten), die alte Bedingung „Vorlauf über Soll −2 K“ (`pauseVlK`) entfällt.
- **+1 K in der Pause = Startbefehl** (Soll-Anhebung umgeht die Einschaltschwelle, 3969412, 4131809; eigene Messung 11.10. 19:10): Raumeinfluss und Deckel/Laufzeit nur, wenn ein Bedarfsraum unter Minimum liegt UND die Pause ≥ `startPauseMin` 20 min dauert UND keine Kaltstart-Sperre bei Abtauwetter (≤ 4 °C) greift; der Vorschlag heißt dann „… ; startet die Wärmepumpe“. Ein im Lauf gemachter, noch nicht übernommener +1-K-Vorschlag endet in der Pause nach 3 min (er wäre dort ein Startbefehl).

### 24.4 COP mit Abtau-Abzug, Protokoll

- **Takt-Messung:** je Tag und Außenband alle Laufminuten (ohne Warmwasser) getrennt nach normal / Abtauen / Wiederaufheizen (bis Vorlauf wieder 0,5 K unter dem Wert vor dem Abtauen, höchstens 30 min). Kachel „COP mit Abtau-Abzug“ (Messwerte & Lernen): Wärme der normalen Laufminuten ÷ Strom aller Laufminuten (+80 W), Tooltip je Band. Bis zur ersten Abtauung „noch keine Abtauung“. Der interne Zähler bucht Abtauwärme positiv (4074654, 4752841).
- **Wärmefahrplan (PLAN_VER 14):** je Slot `copAb` = COP · (1 − 10 % · Abtaurisiko), `elAb`; Zeile „Abtau-Abzug“ und Tooltip „COP (Modell)“. COP, Strom und Schnappschuss unverändert (Referenzlauf bit-identisch). `abtauAbzug` 10 % = Mitte von 5–15 % bei 10–30 Abtauungen/Tag (LEISHA 10).
- **Minutenprotokoll:** Spalte `druck_bar` (Water_Pressure) ganz hinten (Leser nach Spaltennamen; „neben pumpe_speed“ zu lesen: statisch nur bei Pumpe 0 gültig, bei 4250 U/min ~0,5 bar Förderdruck). Keine Regel.

### 24.5 Anlagen-Zwilling (`tools/wp_zwilling.js`, Training auf `replay_data_1610`)

Neue bzw. geänderte Parameter (Herkunft F/M/H je Parameter in PARAM): `abtauLinie` min(−5; max(−22,5; 0,9·WP-AT − 6)), `abtauAtMax` 10 °C, `pipeSlowMin` 120 min, `pipeSprungHz` 8 (+30 % oder +8 Hz), `hzMaxTab` stufig (≤ −4 °C 52, −3…+4 °C 48, 5…9 °C 35, ab 10 °C 30 Hz), Comfort-Kaltstart ≤ 4 °C mit 67 Hz (`startHoch*`), Lüfterstufe ≤ 4 °C (`fanKalt` +110/105/105/100 U/min, eigene Messung; im Training herausgerechnet), `hsStopK` −2 K, `atExtVersatz` (vorläufig 0), `abtauWaermeKWh` 0,5 kWh mit Spanne 0,3–1,6 und Belegen; Heat_Energy_Production zählt beim Abtauen positiv. Training 30 s, zweiter Lauf bit-identisch; Test (12.–15.10.): TOP16 21,5 W, Regler 1,3 Hz, Wasserkreis 1,0 K, Freilauf 32,6/31,5 kWh el. Neue Fixture `tools/fixtures/wp_params.json` (07.–16.10.). `engine_vs_zwilling.js --regel regel.schwelle=wert` rechnet Varianten der Maschine.

Winter-Szenarien (Modell, keine Messung; `node tools/engine_vs_zwilling.js tools/fixtures/wp_params.json --szenario …`; „schatten“ = nur protokolliert, „sofort“ = jeder Vorschlag übernommen):

| Szenario | Lauf | Stand | kWh el WP (+ Heizstab) = gesamt | Starts (< 60 min) | Abtauungen | Heizstab-min | Comfort-Laufmin | Hausmittel Ø | K·h unter Minimum | Befehle |
|---|---|---|---|---|---|---|---|---|---|---|
| Frost −10…−2 °C, 80–90 % | schatten | alt (Kern 8321543, Zwilling 15.10.) | 76,0 (+169,0) = 245,0 | 0 (0) | 67 | 3380 | 0 | 15,5 °C | 2269 | 0 |
| Frost −10…−2 °C, 80–90 % | schatten | alter Kern, neuer Zwilling | 73,7 (+138,2) = 211,8 | 0 (0) | 41 | 2763 | 0 | 14,9 °C | 2488 | 0 |
| Frost −10…−2 °C, 80–90 % | schatten | **neu** (Kern + Zwilling Winterpaket) | 73,7 (+138,2) = 211,8 | 0 (0) | 41 | 2763 | 0 | 14,9 °C | 2488 | 0 |
| Frost −10…−2 °C, 80–90 % | schatten | neu, heizstabVorrang = 1 | 73,7 (+138,2) = 211,8 | 0 (0) | 41 | 2763 | 0 | 14,9 °C | 2488 | 0 |
| Frost −10…−2 °C, 80–90 % | sofort | alt (Kern 8321543, Zwilling 15.10.) | 153,5 (+5,5) = 159,1 | 0 (0) | 79 | 111 | 7163 | 17,4 °C | 1327 | 11 |
| Frost −10…−2 °C, 80–90 % | sofort | alter Kern, neuer Zwilling | 143,9 (+3,8) = 147,7 | 1 (0) | 49 | 75 | 7142 | 17,1 °C | 1422 | 11 |
| Frost −10…−2 °C, 80–90 % | sofort | **neu** (Kern + Zwilling Winterpaket) | 134,5 (+13,7) = 148,2 | 1 (0) | 48 | 274 | 5105 | 16,7 °C | 1627 | 11 |
| Frost −10…−2 °C, 80–90 % | sofort | neu, heizstabVorrang = 1 | 143,9 (+3,8) = 147,7 | 1 (0) | 49 | 75 | 7142 | 17,1 °C | 1422 | 11 |
| Abtauwetter −3…+2 °C, 90–95 % | schatten | alt (Kern 8321543, Zwilling 15.10.) | 55,6 (+100,6) = 156,2 | 0 (0) | 79 | 2012 | 0 | 15,7 °C | 2090 | 0 |
| Abtauwetter −3…+2 °C, 90–95 % | schatten | alter Kern, neuer Zwilling | 54,9 (+91,6) = 146,5 | 0 (0) | 75 | 1832 | 0 | 15,3 °C | 2208 | 0 |
| Abtauwetter −3…+2 °C, 90–95 % | schatten | **neu** (Kern + Zwilling Winterpaket) | 54,9 (+91,6) = 146,5 | 0 (0) | 75 | 1832 | 0 | 15,3 °C | 2208 | 0 |
| Abtauwetter −3…+2 °C, 90–95 % | schatten | neu, heizstabVorrang = 1 | 54,9 (+91,6) = 146,5 | 0 (0) | 75 | 1832 | 0 | 15,3 °C | 2208 | 0 |
| Abtauwetter −3…+2 °C, 90–95 % | sofort | alt (Kern 8321543, Zwilling 15.10.) | 116,2 (+3,8) = 119,9 | 12 (0) | 99 | 75 | 6896 | 19,3 °C | 473 | 11 |
| Abtauwetter −3…+2 °C, 90–95 % | sofort | alter Kern, neuer Zwilling | 112,6 (+4,8) = 117,3 | 17 (0) | 105 | 95 | 6833 | 18,5 °C | 769 | 11 |
| Abtauwetter −3…+2 °C, 90–95 % | sofort | **neu** (Kern + Zwilling Winterpaket) | 97,1 (+26,9) = 124,1 | 4 (0) | 99 | 539 | 1577 | 17,4 °C | 1278 | 11 |
| Abtauwetter −3…+2 °C, 90–95 % | sofort | neu, heizstabVorrang = 1 | 112,6 (+4,8) = 117,3 | 17 (0) | 105 | 95 | 6833 | 18,5 °C | 769 | 11 |
| Woche mild → −10 °C → Tauwetter | schatten | alt (Kern 8321543, Zwilling 15.10.) | 85,9 (+83,3) = 169,3 | 3 (0) | 60 | 1667 | 0 | 17,4 °C | 2008 | 0 |
| Woche mild → −10 °C → Tauwetter | schatten | alter Kern, neuer Zwilling | 84,4 (+64,8) = 149,2 | 3 (0) | 45 | 1297 | 0 | 17,2 °C | 2084 | 0 |
| Woche mild → −10 °C → Tauwetter | schatten | **neu** (Kern + Zwilling Winterpaket) | 84,4 (+64,8) = 149,2 | 3 (0) | 45 | 1297 | 0 | 17,2 °C | 2084 | 0 |
| Woche mild → −10 °C → Tauwetter | schatten | neu, heizstabVorrang = 1 | 84,4 (+64,8) = 149,2 | 3 (0) | 45 | 1297 | 0 | 17,2 °C | 2084 | 0 |
| Woche mild → −10 °C → Tauwetter | sofort | alt (Kern 8321543, Zwilling 15.10.) | 143,4 (+3,5) = 146,9 | 7 (0) | 76 | 69 | 7057 | 19,6 °C | 661 | 15 |
| Woche mild → −10 °C → Tauwetter | sofort | alter Kern, neuer Zwilling | 128,4 (+4,6) = 133,1 | 9 (0) | 54 | 92 | 7070 | 18,9 °C | 971 | 17 |
| Woche mild → −10 °C → Tauwetter | sofort | **neu** (Kern + Zwilling Winterpaket) | 127,9 (+7,3) = 135,2 | 10 (0) | 58 | 146 | 2650 | 18,9 °C | 970 | 18 |
| Woche mild → −10 °C → Tauwetter | sofort | neu, heizstabVorrang = 1 | 128,0 (+4,7) = 132,7 | 9 (0) | 53 | 94 | 7040 | 18,9 °C | 991 | 18 |
| mild 8…14 °C | schatten | alt (Kern 8321543, Zwilling 15.10.) | 31,9 (+0,0) = 31,9 | 35 (0) | 0 | 0 | 0 | 21,8 °C | 0 | 0 |
| mild 8…14 °C | schatten | alter Kern, neuer Zwilling | 31,6 (+0,0) = 31,6 | 33 (0) | 0 | 0 | 0 | 21,8 °C | 0 | 0 |
| mild 8…14 °C | schatten | **neu** (Kern + Zwilling Winterpaket) | 31,6 (+0,0) = 31,6 | 33 (0) | 0 | 0 | 0 | 21,8 °C | 0 | 0 |
| mild 8…14 °C | sofort | alt (Kern 8321543, Zwilling 15.10.) | 31,0 (+0,0) = 31,0 | 34 (0) | 0 | 0 | 0 | 21,7 °C | 0 | 13 |
| mild 8…14 °C | sofort | alter Kern, neuer Zwilling | 30,9 (+0,0) = 30,9 | 31 (0) | 0 | 0 | 0 | 21,6 °C | 0 | 17 |
| mild 8…14 °C | sofort | **neu** (Kern + Zwilling Winterpaket) | 30,9 (+0,0) = 30,9 | 31 (0) | 0 | 0 | 0 | 21,6 °C | 0 | 17 |

Lesart: Die Zeilen „alter Kern, neuer Zwilling“ gegen „neu“ zeigen die Wirkung der Regeln, „alt“ gegen „alter Kern, neuer Zwilling“ die der neuen Zwilling-Parameter (höhere Abtau-Linie, aber neue Kalibrierung: im Frost weniger, im Abtauwetter mehr Abtauungen). Im Schatten-Lauf ändern die Regeln nichts an der Anlage. Übernommen („sofort“) kommt Comfort im Abtauwetter erst am vierten Tag (vorher gesperrt: Kaltstart, 30 min nach dem Abtauen, Abtauwetter ohne Heizstab-Nähe): 99 statt 105 Abtauungen, 4 statt 17 Starts, aber 539 statt 95 Heizstab-Minuten, Hausmittel 17,4 statt 18,5 °C, Strom gesamt +6 %; im Frost +0,4 %, Heizstab 274 statt 75 min. Mit `heizstabVorrang` = 1 (Zeile D) entspricht das Ergebnis dem alten Kern. Grund im Modell: Efficiency hält nach jeder Abtauung 20 min das Minimum, der Vorlauf bleibt ≥ 3 K unter Soll und der Heizstab springt an; die Comfort-Sperre „30 min nach dem Abtauen“ verhindert gerade dann Comfort. Der Zwilling kennt die Abtauspirale nur über den Frequenzsprung (Rohrabsenkung), nicht als schnellere Wiedervereisung nach Comfort – Wintermessung abwarten.

### 24.6 Bewertung, Replay, Tests

- **Bewertung v5 unverändert:** alle neuen Sperren laufen über die bestehende Sperre `abtausprung` (entschuldigt „verpasst“); die Wirkungsmessung einer Quiet-Senkung durch die Anlage bleibt wie bei einer Senkung von Hand (Kalibrierung nicht nötig).
- **Replay 07.–16.10. (alt 8321543 gegen neu, 13 323 Minuten):** 0 Minuten mit anderem Status oder Grund in allen fünf Regeln, dieselben 13 Vorschläge (nur die Versionsnummer im Text), Punkte gleich, Datensatz 2,72 → 2,75 MB/Tag. Abtauwetter lag in 5535 Minuten an (4794 im Lauf), keine Regel wollte dort springen. Mit der Effizienz-Deckel-Schwelle von v4 (22 Hz, Test) entfällt der Deckel 11.10. 03:26 (8 °C, 86 %: nur Quiet 1, ohne Daten).
- **Tests:** engine_sim 417 OK (Flow + replay_data_1610), 329 OK ohne Flow; neu Abschnitt (w) w1–w8 und Hülle (Feuchte/Rohr); angepasst h2/h3, Arbitrierung, Kälte-Szenario, Versionen. optimizer_sim 595 OK (Spalte druck_bar, PLAN_VER 14, Abtau-Abzug). wp_zwilling_test 43 OK mit Training auf replay_data_1610. Die kalibrierte Prüfung „Entscheidung 5“ rechnet bis 15.10. 19:00 (Datensatz `replay_data_1510`).
- **Vorschau** Optimierer, Optimierer mit Vorschlag, Daten & Güte, Optimierung, Übersicht bei 1024/1920/2560: 15 × OK.
- **Geänderte Knoten** (Generator gegen live 8321543, beide mit `--uebernahme-knoten-aktiv`): `opt_apply`, `opt_engine`, `opt_plan`, `opt_quiet` (nur `func`), nichts neu, nichts entfernt; `opt_apply_mqtt` bleibt aktiv.

## 25. COP: Ziel und Ist mit Ursachenzerlegung, Stromzähler Shelly 3EM-63 Gen3 (17.10.2026, Branch `cop-ziel`)

Nur Kennzahl und Anzeige: keine Regel liest die neuen Werte, der Kern (`COP_calculated`, Weitergabe an Venus/VRM) bleibt unverändert. Replay 07.–17.10. alt (main 03306e8) gegen neu: 0 Minuten mit anderem Status, Grund oder Vorschlag, Punkte und Ereignisse identisch.

### 25.1 Ziel-COP und Zerlegung (`engine_core.js`: `copZiel`, `copZielStep`, `copZielSumme`, `czAgg`)

- **Ziel je Laufminute** = η(Band) · Carnot(**Soll-Vorlauf**, Außen + Sonne, dT_verd) · Abtaufaktor(Außen, Feuchte) · Frequenzfaktor(Mindestfrequenz bei dieser Außentemperatur); Carnot = T_kond/(T_kond − T_verd), T_kond = VL + 2,5 K, T_verd = AT − dT_verd. Grundlage ist der Soll-Vorlauf (TOP42, was die Heizkurve samt Verschiebung verlangt): ein Ist-Vorlauf über Soll (Überschwingen vor dem Stopp) ist damit ein eigener Posten, statt im Ziel zu verschwinden.
- **dT_verd** je Band = Median Außen − Rohr außen in den Kalibrierminuten (cop_eta.json), sonst 4,5 K. Nicht je Minute: sonst wanderten Frequenz- und Vereisungsverluste (Rohr fällt) ins Ziel.
- **Ist** = Nutzwärme (HeishaMon, ohne Abtau- und Wiederaufheizminuten) ÷ Strom (TOP16 + 80 W im Lauf, roh im Stillstand; mit `zaehler.quelle = zaehler` und frischem Zähler der Zählerstrom). Warmwasser und Heizstab-Minuten zählen nicht (nur Info-kWh).
- **Zerlegung** Strom Ist − Strom Ziel (Ziel = Nutzwärme ÷ Ziel-COP) je Minute, exakt additiv: Laufminuten über die Logarithmen der Faktoren (Vorlauf gegen Soll, Frequenz über Minimum, Spreizung gegen Band-Mittel 1 %/K, erwartetes Abtauen, Rest); Startminuten (erste 10 nach einer Pause ≥ 3 min) ganz „Startspitzen“; Abtau- und Wiederaufheizminuten ganz „Abtauen“ abzüglich der im Ziel erwarteten Abtauung; Stillstand „Stillstandsstrom“ (nur im Tageswert). COP-Punkte je Posten = Nutzwärme ÷ (Strom Ist · Strom Ziel) · Posten (summieren sich zu Ziel − Ist).
- Zustand `S.cz` (48 Stunden, 35 Tage), Buchung in `step()` nach der Takt-Messung, ohne Wirkung auf die Regeln.
- **Startwerte** η 0,52/0,50/0,48/0,45 (cop_physik, dT 4,5 K); **nachts** `cop_eta.json` des Containers (Schritt `cop_eta`, `tools/cop_eta.js`, 21 Tage, Minuten mit Lauf ≥ 25 min, 16–17 Hz, ohne Sonne), gelesen von `opt_nas` → `OPT_cop_eta` → `cfg.copZiel` der Maschine (ungültige Werte verworfen, fehlt die Datei: Startwerte).
- **Frequenzfaktor aus den Daten** (Lauf ≥ 25 min, ohne Sonne, gegen 16–17 Hz): 18–20 Hz 0,987 (563 min), 21–25 Hz 0,999 (308 min); 26–30 Hz nur 30 min (0,94), 31–35 Hz 44 min (1,14, Hochlauf), darüber keine Daten → Annahme 1 − 1 %/Hz über 25 Hz. Mit TOP16 + 80 W ist bis 25 Hz kein Wirkungsgradverlust messbar.
- **Abtaufaktor** 1 − 10 % · g(AT) · h(Feuchte), g = 1 bis 2 °C, 0 ab 4 °C; h = 1 ab 85 %, 0,3 bis 60 %. Kalibriert, sobald 5 Abtauungen im Fenster liegen (Strom der Abtau-/Wiederaufheizminuten gegen das Erwartete). 07.–17.10.: 0 Abtauungen, erwartet 0,72 kWh.
- **Sonne (ANNAHME)** 10–16 Uhr, PV ≥ 30 % der 7-Tage-Spitze: AT-Äquivalent +1 K, ab 60 % +2 K. Prüfung im Replay: Rest in 699 Sonnenminuten +5,0 % gegen +0,4 % ohne Sonne – die Annahme ist durch die Daten bisher **nicht gestützt** (der Rest entspricht etwa den angenommenen +1,5 K).

**Replay 07.–17.10.** (`node tools/cop_ziel_replay.js <daten> --eta auto`, η vorher auf denselben Daten kalibriert wie der Container: 0,507/0,488/0,462/0,442, dT 3/3/3/4 K):

| Tag | Ø AT | Lauf min | Starts | Strom kWh | Wärme kWh | COP Ist | COP Ziel | unter Ziel | Abtauen kWh | Startspitzen kWh | Frequenz über Minimum kWh | Vorlauf über Soll kWh | Rücklauf/Spreizung kWh | Stillstandsstrom kWh | Rest (unerklärt) kWh | Rest % | Rest Sonne % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 07.10. | 12,8 | 127 | 1 | 0,81 | 4,53 | 5,57 | 5,74 | 2,9 % | 0,00 | 0,00 | 0,00 | 0,01 | 0,00 | 0,02 | 0,00 | −0,5 | – |
| 08.10. | 11,6 | 579 | 3 | 4,02 | 20,18 | 5,01 | 5,35 | 6,3 % | 0,00 | 0,02 | 0,00 | 0,03 | 0,00 | 0,13 | 0,08 | 2,0 | 7,5 (68 min) |
| 09.10. | 7,9 | 1120 | 4 | 8,12 | 37,68 | 4,64 | 5,09 | 8,8 % | 0,00 | 0,12 | 0,00 | 0,28 | 0,00 | 0,19 | 0,12 | 1,5 | 14,6 (89 min) |
| 10.10. | 11,0 | 800 | 7 | 6,15 | 30,01 | 4,88 | 5,33 | 8,5 % | 0,00 | 0,14 | 0,07 | 0,00 | 0,00 | 0,32 | 0,00 | −0,0 | 9,0 (71 min) |
| 11.10. | 9,6 | 992 | 5 | 7,52 | 35,98 | 4,79 | 5,31 | 9,9 % | 0,00 | 0,12 | 0,01 | 0,20 | 0,00 | 0,26 | 0,16 | 2,1 | 0,4 (104 min) |
| 12.10. | 6,4 | 1155 | 3 | 9,35 | 43,00 | 4,60 | 4,58 | −0,3 % | −0,37 | 0,07 | 0,04 | 0,22 | −0,02 | 0,17 | −0,14 | −1,5 | −1,5 (166 min) |
| 13.10. | 8,5 | 1045 | 3 | 8,22 | 38,47 | 4,68 | 4,80 | 2,6 % | −0,29 | 0,05 | 0,02 | 0,19 | −0,01 | 0,18 | 0,07 | 0,8 | 3,9 (17 min) |
| 14.10. | 12,1 | 749 | 4 | 5,37 | 27,34 | 5,09 | 5,46 | 6,8 % | 0,00 | 0,04 | 0,00 | 0,14 | −0,01 | 0,25 | −0,06 | −1,2 | – |
| 15.10. | 8,0 | 1148 | 3 | 8,59 | 39,37 | 4,58 | 4,96 | 7,6 % | −0,06 | 0,07 | 0,02 | 0,23 | 0,00 | 0,12 | 0,28 | 3,3 | 7,9 (174 min) |
| 16.10. | 9,9 | 820 | 2 | 6,10 | 28,58 | 4,68 | 4,97 | 5,8 % | 0,00 | 0,04 | 0,00 | 0,11 | −0,01 | 0,25 | −0,04 | −0,7 | −14,1 (10 min) |
| 17.10. | 10,0 | 411 | 2 | 2,85 | 14,40 | 5,05 | 5,44 | 7,2 % | 0,00 | 0,03 | 0,00 | 0,08 | 0,00 | 0,10 | 0,00 | 0,0 | – |
| **gesamt** | | 8946 | 37 | 67,12 | 319,54 | 4,76 | 5,06 | 6,0 % | −0,72 | 0,71 | 0,16 | 1,47 | −0,04 | 1,98 | 0,47 | 0,7 | 5,0 (699 min) |

Karte **„COP: Ziel und Ist“** (Seite Optimierer, Gruppe `opt_g_eng_cop`, 17 breit, Reihenfolge 8, Ausgang 7 von `opt_engine`): Ist/Ziel für die letzte volle Stunde, heute und gestern mit Chip (≤ 5 % ok, ≤ 15 % Warnung, darüber Fehler), Posten mit kWh und Anteil (nur Posten > 0, Rest immer, hervorgehoben über 5 %), Gütegrad-Stand (Startwerte / nachts kalibriert / veraltet) und Stromquelle. `opt_nas` zeigt die Zeile „COP-Gütegrad η“.

### 25.2 Stromzähler Shelly 3EM-63 Gen3 (`tools/zaehler_core.js`, `opt_zaehler`)

- **Nur lesen:** zwei `mqtt in` mit dynamischem Abo (`opt_mqtt_zl_v` Venus-Broker, `opt_mqtt_zl_n` NAS-Broker; nur der gewählte abonniert), kein Sendeknoten. Abos beim Start, nach dem Speichern und alle 10 min, solange 5 min nichts kam.
- **Profile:** Drehstrom `em:0` (`a_/b_/c_act_power`, `voltage`, `current`, `aprt_power`) + `emdata:0` (`*_total_act_energy`, `*_ret_`); drei Kanäle `em1:0–2` (`act_power` …) + `em1data:0–2` (`total_act_energy`). Quellen `<präfix>/status/<komponente>` (volle Komponente) und `<präfix>/events/rpc` (NotifyStatus mit Teilfeldern, NotifyFullStatus). Profil „erkennen“ nimmt, was kommt.
- **Konfiguration** `OPT_cfg.zaehler` (config.json, keine Geheimnisse): `topic`, `broker` (venus|nas), `profil`, `klemme_wp` (0–2), `klemme_heizstab`, `klemme_sonstiges` (0–2 oder null), `invertieren` je Klemme, `quelle` (heishamon|zaehler, Standard heishamon). Eingabe in der Karte „Stromzähler (Shelly 3EM-63)“ auf Daten & Güte (Form, Speichern schreibt nur den Schlüssel `zaehler`; Ereignis `optimierer_zaehler`).
- **`OPT_zaehler`** {wp_w (ohne Heizstab), heizstab_w, sonst_w, kwh_wp, kwh_heizstab, ts, alter, ok, …}; ok = Meldung höchstens 5 min alt. Negativer WP-Wert ohne Invertieren: Hinweis „Vorzeichen prüfen“, Wert 0.
- **Heizstab** mit eigener Klemme exakt; ohne: Sprungerkennung an Internal_Heater_State (3 Minuten vor/nach, Verdichter gleich, 0,5–9,5 kW), Median der letzten 9 Sprünge, bis dahin **Annahme 3 kW** (Herkunft in der Karte).
- **Protokolle:** `quiet-*.csv` und `optimizer-v2-*.csv` hinten `zaehler_wp_w`, `zaehler_heizstab_w`; `plan-actuals-*.csv` hinten `ist_strom_zaehler_kwh`, `ist_zaehler_min`; Zustand `zaehler-state.json` (Heizstab-Sprünge, 24-h-Vergleich, ohne Messwerte).
- **Vergleich** je Minute Zähler gegen TOP16 + Korrektur, gleitend 24 h, getrennt Lauf/Stillstand; ab 120 Laufminuten „Korrektur gemessen +x W statt Annahme 80 W“.
- **Umschaltung** `quelle = zaehler` (Schalter der Form, nur nach Go): Ist-COP und Zerlegung, COP-Matrix (Takt-Messung speichert Zähler-Wh zusätzlich, `copSumme(…, zq)`), Anzeigen in `opt_quiet`/`opt_eval` (`pelQ`), Kennzahlen des Containers (`kennzahlen_tag.py` liest `zaehler_wp_w`, Fakt `energie.quelle`) nutzen den Zählerstrom; TOP16 bleibt als Vergleichsspalte. Ausfall (älter als 5 min): Rückfall auf TOP16 + 80 W mit Ereignis und Chip. Unverändert: Kern-COP, Wärmefahrplan-Modell, Kennzahl „Überheizt“, Quiet-Kennfeld.

### 25.3 Tests

`tools/cop_ziel_sim.js [flows] [daten]`: Minutenmodell, exakte Zerlegung, Start/Abtauen/Wiederaufheizen, Zählerquelle und Ausfall, Kalibrierung (synthetisch, η wiedergefunden), beide Shelly-Profile, NotifyStatus, Vorzeichen, Heizstab-Sprung, 24-h-Vergleich, Form, Hülle `opt_zaehler` (Abos, Speichern, Umschalten, Ausfall-/Wieder-Ereignis), Karten, Replay, Kennzahlen mit Zählerspalte.

## 26. Training v2 des Anlagen-Zwillings (18.10.2026, Branch `training-v2`)

Nächtliches Training im Container `optimizer-tools` (`tools/wp_training_nacht.py` → `tools/wp_training.js`), Bericht `~/Dokumente/heishamonr-optimizer/training-v2/BERICHT.md`.

- **Champion gegen Herausforderer:** Der neue Satz wird nur übernommen, wenn er auf den heutigen Testtagen (gleicher Datenstand, der bisherige Satz wird neu bewertet) bei Strom-RMSE, Wasserkreis-RMSE und Pause-Median nicht mehr als 10 % (mindestens 0,5 W / 0,02 K / 1 min) schlechter ist und keine Ampelgrenze reißt, die der bisherige einhält. Abgelehnt → `training/kandidat_<tag>.json`; aktiv bleibt die jüngste `wp_params_<tag>.json` (Kopie `wp_params_aktiv.json`). `status.json` → `training.entscheidung`.
- **Glättung:** übernommen = bisher + 1/3 · (roh gelernt − bisher) (`TRAINING_GLAETTUNG`). Schalter-Werte 99 („aus“, `startHystK`, `comfortWiederK`) gleiten über 5 K.
- **Bindung** in der Dünn-Daten-Phase (unter 21 Tagen oder unter 3 Außentemperatur-Bändern mit je ≥ 300 Laufminuten): jeder Fit minimiert (Fehler/Bezugsfehler)² + λ · Σ((Wert − Vorwert)/(25 % des Vorwerts))², λ = 0,1 (`TRAINING_BINDUNG`); Grenzen der Fits wie bisher.
- **Güte je Außentemperatur-Band** (< 0, 0…4, 4…8, 8…12, ≥ 12 °C) mit Minutenzahl, **Abdeckung** des 21-Tage-Fensters; leere Bänder „keine Daten, Zwilling extrapoliert“, Hinweis „Zwilling hat unter X °C keine Daten“ in `status.json` → `hinweise`. Ampel unverändert.
- Tests: `node tools/wp_training_test.js [daten]`, `python3 tools/wp_training_nacht_test.py [daten]`, `docker/optimizer-tools/test.sh` (Abschnitt 7 prüft die neuen Felder).

## 27. Seite „Lernen“ (23.10.2026, Branch `lern-seite`)

Was der Container `optimizer-tools` nachts lernt, auf einer eigenen Dashboard-Seite (Menüpunkt nach „Daten & Güte“, `opt_lern_ui_tab`, Reihenfolge 12,8). Der Container bleibt ohne Netz und ohne eigenes Web-Dashboard; `opt_lern` liest alle 5 min nur seine Ergebnisdateien in `/data/optimizer-tools`. Daten und Darstellung stehen in `tools/lern_ui.js` (reine Funktionen, Prüfungen in `tools/optimizer_sim.js` mit `tools/fixtures/lern/`). Vier gleich breite Karten (17):

- **Heute gelernt:** letzter Lauf und Schritte, Entscheidung des Gates, Güte Kandidat gegen bisher (8 Kennzahlen, Gate-Chips für Strom/Wasserkreis/Pause), Abdeckung je Außenband, Drift-Liste (aus `status.json`).
- **Was sich verändert:** gelernte Parameter (`herkunft.*.fit`, Listen je Stelle, z. B. `raeume.wohn[3]`) aus den `wp_params_<tag>.json` der letzten 14 Tage: heute, Vortag, vor 7 Tagen, Verlauf, roh gelernt, Änderung; die 15 größten offen, der Rest, unveränderte und feste Werte zugeklappt.
- **Güte je Außenband und Lernkurve:** Strom-RMSE, Wasserkreis-RMSE und Pause-Median-Fehler je Trainingstag aus `guete.test` der Parameterdateien (abgelehnte `kandidat_<tag>.json` hohl), Ampelgrenzen gestrichelt; Tabelle `guete_je_band`. Die Testtage wandern mit (letzte 4 Tage je Lauf).
- **Replay und Kennzahlen:** Replay-Güte je Regel und Vorschläge (`replay/<tag>.json`), 7 Tage aus `kennzahlen/tage.csv`, Hinweise/Fehler, die letzten 15 Zeilen von `letzter-lauf.log`.

Geparste Parameterdateien hält der Knoten im Kontext (`lern_cache`, nach Dateizeit und -größe). Für die Lernkurve ist keine neue Container-Datei nötig.

## 28. evcc-Abgleich (25.10.2026, Branch `evcc-abgleich`)

Nutzer-Go 25.10.2026: „1 bauen“ und „das würde ich täglich prüfen lassen“. **Nur lesen, nur Anzeige und Protokoll.** Es wird nichts an evcc gesendet, und keine Entscheidung ändert sich.

**Einheiten (geprüft an echten Zahlen, evcc 0.318.1):** Jeder Schritt hat Energie in Wh. Der erste Schritt ist angebrochen (z. B. 136 s), alle weiteren haben 900 s.
- `gt` ist die Summe der `demandDetails` (Haus + BWWP + Leisha).
- `res.batteries[0].charging_power/discharging_power` sind trotz des Namens ebenfalls Wh je Schritt: Entladen = `gt` ohne PV, × 4 = `battery.suggestion.discharge` in W.
- `state_of_charge` ist in Wh und gilt am Ende des Schritts. Das Minimum stimmt mit `battery.forecast.lowest` überein.
- `p_N`/`p_E` sind in EUR/Wh, im Netzpreis mit HT/NT (31,78/21,8 ct).
- Die Leisha-Prognose liegt bei 60 Wh je Viertelstunde, also 240 W. Real laufen 360–400 W.

| Knoten | Typ | Rolle |
|---|---|---|
| `opt_i_evcc` → `opt_evcc_req` → `opt_http_evcc` (+ `opt_catch_evcc`) → `opt_evcc` → `opt_f_evcc` | inject 900 s, function, http request (GET), function, file | Liest `GET <evccUrl>/api/state?jq={evopt, soc: .battery.soc, tariffGrid, version}` (≈ 12 KB statt 84 KB). Schreibt den kompakten Plan nach `OPT_evcc_plan` = {plan, abruf {ts, ok, fehler}} und eine Zeile je Abruf nach `evcc-plan-YYYY-MM.jsonl` (≈ 3,6 KB, Zeiten in s, Werte in Wh, Preise in EUR/kWh, gleiche Werte als eine Zahl; bei Fehlern `{t, fehler, letzter}`). |
| `opt_i_evcc_q` → `opt_evcc_q` | inject 600 s, function | Tägliche Prüfung ab 00:10, einmal am Tag. Prüft den Vortag und fehlende Tage der letzten 7 je Viertelstunde, Ergebnis in `evcc-quality.json` (60 Tage, Viertelstunden der letzten 14) und `OPT_evcc_q`. |
| `opt_energy` | function | Zeile „Daten evcc-Plan“ auf „Energie & Preise“. Ist der letzte gültige Plan älter als 60 min, steht er auf „veraltet“. Schreibt `OPT_plan_in.evcc` und die Zeilen der Prognosegüte. |
| `opt_plan` | function | Kennzahlenzeile `evcc-Plan: Akku-Minimum 07:15 bei 6,2 kWh · Netzbezug geplant – · Einspeisung –` unter den Kacheln. Ohne Plan steht dort „evcc: kein Plan“. Der Fahrplan rechnet ohne sie. |
| `opt_engine` (Hülle, nicht der Kern) | function | Hinweis „evcc unterschätzt die Wärmepumpe um x % (7 Tage …)“ in `OPT_engine.hinweise` (id `evcc`), mit Ereignis in quiet-events. Dazu die Kachel „evcc-Akkuplan“ unter „Räume und Wächter“. Keine Regel, keine Punkte. |

Die reinen Funktionen stehen in `tools/evcc_core.js`, die Tests in `tools/evcc_core_test.js` (echte Antwort in `tools/fixtures/evcc_state_2510.json`) sowie in `optimizer_sim.js` und `engine_sim.js`. Die Vorschau mit echten Daten baut `tools/evcc_vorschau.js`.

**Prüfung je Viertelstunde des Tages** (23/24/25 h). Die Messung kommt aus `zaehler_wp_w` in `quiet-YYYY-MM.csv`: Mittel der Minutenwerte × 0,25 h, ab 10 Minuten je Viertelstunde. Die doppelte 02-Stunde bei der Zeitumstellung wird über die Reihenfolge der Zeilen erkannt. Verglichen werden:
- **evcc 6 h:** der Schnappschuss, dessen `updated` am nächsten an Schritt − 6 h liegt (± 45 min).
- **evcc Tag:** der jüngste Plan vor Mitternacht, höchstens 6 h alt. evcc rechnet nur 23 h voraus, also werden ≈ 92 von 96 Viertelstunden abgedeckt.
- **Modell Tag:** der Plan-Schnappschuss (`plan-snapshots`, Spalte `strom` = Bedarf ÷ COP, kWh je Slot) mit der jüngsten Zeit vor Mitternacht.
- **Modell 6 h:** wird nur in die Datei geschrieben.

Abweichung = Summe Prognose ÷ Summe Messung − 1, nur über Viertelstunden mit beiden Werten. Ein Tag zählt ab 75 % der Viertelstunden. Das 7-Tage-Mittel ist energiegewichtet.

Bewertung: ok unter 15 %, Hinweis bis 30 % (Bernstein), Warnung darüber (Rot). Der Hinweis der Maschine erscheint ab 20 % im 7-Tage-Mittel aus mindestens 3 Tagen. Er nutzt die 6-h-Werte, ersatzweise die Tagesprognose. Alle Schwellen sind ANNAHMEN des Auftrags und lassen sich in `config.json` unter `evcc` überschreiben. Die evcc-Adresse steht in `energy.evccUrl`.

**Grenzen:**
- Das Modell rechnet nur Heizstrom: Bedarf ÷ COP mit +80 W im Lauf, ohne Standby von 15–34 W und ohne Abtau-Abzug. Der Zähler misst alles.
- Die evcc-Zeilen füllen sich erst ab dem ersten vollen Tag nach dem Einspielen.

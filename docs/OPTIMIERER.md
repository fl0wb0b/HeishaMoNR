# Optimierer: Entscheidungsmaschine, Punktesystem, Ein-Klick-Übernahme, Bonsai-Beobachter

Stand 10.10.2026, Branch `optimizer-engine`. **Alles ist Shadow.** Die Maschine rechnet jede Minute aus, was sie schalten *würde*, und schreibt das auf. Sie sendet nichts. Der einzige Sendeweg ist ein Klick des Betreibers auf „Übernehmen“. Dieser Weg wird gesperrt ausgeliefert.

## 1. Kurzfassung

- **Entscheidungsmaschine** `opt_engine` (Tab „WP Optimizer“, jede Minute): Sie wertet vier Regeln aus. Je Regel hält sie fest: Status, Grund in Zahlen, nächste Schwelle mit Abstand („würde schalten, sobald …“) und gegebenenfalls einen Vorschlag mit Befehl, Erwartung, Gültigkeit und Rückweg.
  - Jede Auswertung wird ein unveränderlicher Datensatz in `decisions-YYYY-MM.jsonl`, auch „nichts tun“.
- **Punktesystem**: Es arbeitet automatisch und ohne Eingabe des Nutzers.
  - Jeder Vorschlag ist ein Fall. Seine Auslöser-Prognose wird nach dem Brier-Prinzip gegen die Basisrate „bleibt, wie es ist“ bewertet.
  - Eine Wirkungsprognose wird nur bewertet, wenn eine gleichwertige Änderung wirklich passiert.
  - Dazu kommen Abzüge für Schaden und für verpasste Lagen. Unsicheres zählt 0.
  - Das Punktebuch steht in `scores-YYYY-MM.jsonl`. Die Freigabereife ist nur eine Anzeige.
- **Ein-Klick-Übernahme** `opt_apply`: Es gibt die Knöpfe „Übernehmen“, „Verwerfen“, „Zurücksetzen“ und „Übernahme sperren“. Ausgeliefert wird sie doppelt gesperrt:
  1. Der `mqtt out` ist deaktiviert.
  2. Der Hauptschalter in `apply.json` fehlt, das heißt „aus“.

  Dazu kommen Whitelist, Prüfsumme, Alters- und Ist-Abgleich, Notbremse, Rate und Tageslimit, Rücklesen mit Wiederholung, Rückweg und das Protokoll `applied-YYYY-MM.jsonl`.
- **Bonsai-Beobachter** `tools/bonsai_beobachter.py`:
  - Er rechnet den Tagesbericht selbst und deterministisch.
  - Das lokale LLM beantwortet nur kurze, belegte Fragen. Aussagen ohne gültigen Beleg werden verworfen.
  - Der Beobachter ist nie im Regelkreis.
- **Replay** der echten Protokolle vom 07. bis 10.10.: siehe `docs/replay_2026-10-07_bis_10.md`.
  - Die Quiet-Freigabe hätte genau einmal angeschlagen, am 10.10. um 08:36 im Boost, 4,7 min vor dem Klick des Nutzers.
  - Kaltstarts lösen sie nicht aus.

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
                                                            └─► Seite „Optimierer“ (4 Karten): tools/engine_view.js baut die Daten, tools/eng_ui.js zeichnet sie
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
| `opt_g_eng_prop`, `opt_g_eng_rules`, `opt_g_eng_score`, `opt_g_eng_log` | ui_group | je 18 breit |
| `opt_t_eng_*` | ui_template | die vier Karten |
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
| **Quiet-Freigabe** | Quiet ≥ 1 · Verdichter läuft seit ≥ 15 min · ≤ 20 Hz (am Deckel) · Vorlauf ≥ 1,5 K unter Soll · Rücklauf ≥ 1,5 K unter Soll-Rücklauf · Raum unter Minimum *oder* Sollvorlauf in diesem Lauf noch nicht erreicht · alles **10 min am Stück** · keine Sperre | `SetQuietMode = 0` (direkt, nicht schrittweise) | keiner automatisch (0 ist Standard); „Zurücksetzen“ = vorige Stufe |
| **Laufzeit strecken** | Quiet < 3 · Lauf ≥ 15 min · ≥ 22 Hz · kein Raum unter Minimum und Rücklauf ≤ 1 K unter Soll · Takt-Indiz (Abschaltgrenze in ≤ 45 min, letzter Lauf < 60 min oder ≥ 2 Starts in 3 h) · 10 min am Stück · keine Sperre | `SetQuietMode = 3` | automatisch zurück auf 0 bei Raum unter Minimum, bei Rücklauf ≥ 2,5 K unter Soll seit 15 min, spätestens nach 4 h |
| **Raumeinfluss ±1 K** | Raumvorschlag der Phase 2 (−1/0/+1) ≠ Verschiebung der Anlage · seit ≥ 60 min unverändert · bei −1: Soll bleibt ≥ 29 °C · kein Wärmeverteilungsproblem · keine Sperre (u. a. Heizkurvenmodus, Wasserfühler, kein Handeingriff am Soll) | `SetZ1HeatRequestTemperature = −1/0/+1` | automatisch auf 0, sobald der Raumvorschlag 15 min am Stück 0 ist, spätestens nach 6 h |
| **Heizgrenze-Hinweis** | Heizgrenze > 10 °C · Lauf ≥ 15 min bei Außentemperatur > 10 °C · alle aktiven Räume gültig und ≥ Minimum + 0,5 K · 15 min am Stück | nur Hinweis `SetHeatingOffOutdoorTemp = 10`, **nie per Klick** | Saisoneinstellung von Hand |

**Comfort/Efficiency:** Es gibt keine Regel dafür. Die Whitelist kennt `SetHeatingControl` nicht. Das folgt der Nutzerregel: keine Heizregelung wegen Räumen.

**Pumpe:** Es gibt keine Regel und keinen Befehl. Die Begrenzung ist auf dem Mainboard programmiert. Gemessen wurden ≈ 23,1–23,8 l/min bei 2900–2950 U/min in jeder Startspitze. `Max_Pump_Duty` 254 sagt darüber nichts. `SetMaxPumpDuty` steht nicht auf der Whitelist, ein Test prüft das.

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
| Quiet-Freigabe (`quiet_freigabe`) | 1 | befehl | `SetQuietMode` | mehr_leistung | Ohne Freigabe bleibt der Verdichter am Deckel (≤ 20 Hz) und der Rücklauf-Rückstand ≥ 1 K – p = 0,8, 30/60/120 min | anlauf, daten, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, abstand, tageslimit, abkuehlzeit, takt |
| Laufzeit strecken (Quiet 3) (`quiet_strecken`) | 1 | befehl | `SetQuietMode` | weniger_leistung | Ohne Deckel endet der Lauf binnen 60 min (kurzer Lauf) – p = 0,7, 60 min | anlauf, daten, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, abstand, tageslimit, abkuehlzeit, takt, heizstab |
| Raumeinfluss (Heizkurve ±1 K) (`raum_offset`) | 1 | befehl | `SetZ1HeatRequestTemperature` | verschiebung | Ohne Verschiebung bleibt der Führungsraum außerhalb seines Bandes – p = 0,7, 60/120/240 min | anlauf, daten, mqtt_sperre, abtauen, warmwasser, sanftanlauf, laufbeginn, heizgrenze_aus, regler, abstand, tageslimit, abkuehlzeit, takt, heizstab |
| Heizgrenze 12 → 10 °C (nur Hinweis) (`heizgrenze_hinweis`) | 1 | hinweis | `SetHeatingOffOutdoorTemp` | weniger_waerme | Alle Räume bleiben mindestens Minimum + Reserve (der Lauf war nicht nötig) – p = 0,6, 180 min | anlauf, daten |

#### Quiet-Freigabe (`quiet_freigabe` v1)

*Zweck:* Hängt der Verdichter trotz deutlichen Rückstands am Quiet-Deckel, Quiet auf 0 freigeben (Nutzerregel: Standard ist 0, nicht schrittweise).

*Eingänge:* Quiet-Stufe, Verdichterfrequenz, Soll-/Ist-Vorlauf, Rücklauf und Ziel-Spreizung (Heat_Delta), Laufzeit, Räume (gültig, eigenes Band)

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `capHz` | 20 | Hz | Messung: Quiet 3 hielt 16–17 Hz (10.10. 08:25–08:40, 16 min bei 6–7 K Rücklauf-Rückstand, Efficiency); Quiet 2 ebenso (08.10. 09:33–09:37, 3,25 K, Comfort, nur 4 min nach dem Start); Startspitzen 22–35 Hz nur in Minute 0–1 |
| `laufMin` | 15 | min | Startroutine: Pumpenspitze 11–16 min nach jedem Start; Kaltstarts haben 15–25 min lang naturgemäß Rückstand |
| `vlRueckK` | 1,5 | K | Auftrag/Wächter (escCapDevK 1,5) |
| `rlRueckK` | 1,5 | K | Messung: der Verdichter folgt dem Rücklauf-Rückstand (Soll-RL = Soll-VL − Heat_Delta). 10.10. 11:17 Quiet 0, RL-Rückstand ≤ 0,25 K: blieb trotz Vorlauf −2,25 K bei 16–17 Hz; Boost mit 2,5–6,75 K: 33–34 Hz. 1,5 K ist ANNAHME zwischen 0,25 und 2,5 |
| `haltMin` | 10 | min | Auftrag/Wächter (escCapMin 10): Bedingungen 10 min am Stück nach der Startphase |
| `proTag` | 3 | Vorschläge | Schreibbudget; ANNAHME |
| `gueltigMin` | 30 | min | Quiet wirkt in 1–2 min; nach 30 min ist die Lage eine andere (ANNAHME) |
| `pauseMin` | 60 | min | wie Mindestabstand (ANNAHME) |

*Erwartung:* Verdichter ≥ 25 Hz binnen 5 min, elektrische Leistung +350 bis +650 W, Vorlauf +2 K in 30 min (gemessen 10.10.2026 08:41 mit Heizregelung Efficiency: 29 Hz nach 1 min, 34 Hz nach 2 min, +490–590 W, Vorlauf +4 K in 20 min bei 11–12 °C; nicht gemessen: kältere Außentemperatur und Comfort – ob das Plateau 33–34 Hz eine Temperaturgrenze oder eine Begrenzung durch Efficiency ist, ist offen, siehe Messaufgabe)

*Rückweg:* Kein automatischer Rückweg: Quiet 0 ist der Standard des Betreibers. „Zurücksetzen“ stellt die vorherige Stufe wieder her; zurück auf 3 nur über die Regel „Laufzeit strecken“ oder von Hand.

*Kalibriermessungen (Wirkungsfälle dort zählen 0 Punkte):* 2026-10-10 08:40, 2026-10-08 22:54, 2026-10-10 11:17

#### Laufzeit strecken (Quiet 3) (`quiet_strecken` v1)

*Zweck:* Läuft der Verdichter ohne Bedarf deutlich über Minimum und droht ein kurzer Lauf, die Leistung mit Quiet 3 deckeln, damit er länger bei niedriger Leistung läuft. Rückkehr auf 0, sobald der Grund endet.

*Eingänge:* Quiet-Stufe, Verdichterfrequenz, Vorlauf und Anstieg, Rücklauf-Rückstand, Räume, letzte Läufe/Starts

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `hzHoch` | 22 | Hz | Minimum gemessen 16–17 Hz; 22 Hz = deutlich darüber (ANNAHME) |
| `laufMin` | 15 | min | Startroutine (siehe Quiet-Freigabe) |
| `rlRueckMaxK` | 1 | K | kein Bedarf: Rücklauf höchstens 1 K unter Soll (ANNAHME, vgl. Quiet-Freigabe 1,5 K) |
| `stoppBaldMin` | 45 | min | Takt-Indiz: Vorlauf erreicht beim aktuellen Anstieg binnen 45 min Soll +3,25 K (ANNAHME) |
| `kurzerLaufMin` | 60 | min | Takt-Indiz: letzter Lauf kürzer als 60 min (Opus: Mindestlauf 60 min) |
| `starts3h` | 2 | Starts | Takt-Indiz: mindestens 2 Starts in 3 h (07.–10.10.: höchstens 1) |
| `haltMin` | 10 | min | wie Quiet-Freigabe |
| `proTag` | 2 | Vorschläge | ANNAHME |
| `gueltigMin` | 30 | min | ANNAHME |
| `pauseMin` | 120 | min | ANNAHME |
| `maxDauerMin` | 240 | min | Rückweg spätestens nach 4 h (Nutzerregel: Standard 0) |
| `bedarfRlK` | 2,5 | K | Rückweg: Rücklauf-Rückstand ≥ 2,5 K seit 15 min = Leistung wird gebraucht (Boost-Messung) |

*Erwartung:* Verdichter fällt binnen 3 min auf ≤ 20 Hz, elektrische Leistung −300 W oder mehr, der Lauf wird länger (Quiet 3 hielt 16–17 Hz bei jedem gemessenen Rückstand; COP im Mindestbetrieb 6,9 statt 6,0 bei 33 Hz, 10.10.)

*Rückweg:* Automatisch zurück auf 0, sobald ein Raum unter Minimum fällt, der Rücklauf-Rückstand 15 min ≥ 2,5 K beträgt oder spätestens nach 4 h.

#### Raumeinfluss (Heizkurve ±1 K) (`raum_offset` v1)

*Zweck:* Räume wirken nur als langsamer, kleiner Offset auf die Heizkurve (Lambda-Prinzip). Übernimmt den Raumvorschlag der Phase-2-Logik (korrektur_vorschlag −1/0/+1) erst, wenn er lange stabil ist. Nie Comfort/Efficiency.

*Eingänge:* Raumvorschlag Phase 2 (korrektur_vorschlag, Führungsraum, Wärmeverteilung), Verschiebung an der Anlage (TOP27), Soll-Vorlauf und Heizkurve, Heizkurvenmodus/Zonenfühler

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `stabilMin` | 60 | min | lange Haltezeit (Auftrag); Phase 2 wartet selbst 45–60 min. Räume reagieren träge, Shelly melden erst ab 0,5 K |
| `minVlC` | 29 | °C | Nutzervorgabe 08.10.: Soll-Vorlauf nie unter 29 °C (Heizkörper) |
| `proTag` | 4 | Vorschläge | Opus: höchstens 6 Schreibbefehle/Tag |
| `gueltigMin` | 120 | min | ANNAHME |
| `pauseMin` | 120 | min | ANNAHME |
| `maxDauerMin` | 360 | min | Rückweg spätestens nach 6 h (ANNAHME) |

*Erwartung:* +1 K: Soll-Vorlauf +1 K binnen 3 min, im Taktbetrieb +40–60 min Laufzeit je Lauf (Sollsprünge 07.–10.10.), Strom +2,5–3 % (8,5 W/K); Raumwirkung NICHT gemessen. −1 K: umgekehrt.

*Rückweg:* Automatisch zurück auf 0 K, sobald der Raumvorschlag 15 min am Stück 0 ist oder spätestens nach 6 h; „Zurücksetzen“ jederzeit.

#### Heizgrenze 12 → 10 °C (nur Hinweis) (`heizgrenze_hinweis` v1)

*Zweck:* An milden Tagen läuft die Anlage bei 11–14 °C, obwohl alle Räume Reserve haben. Eine niedrigere Heizgrenze würde solche Läufe vermeiden. Nur Hinweis: Parameteränderung, nie per Klick.

*Eingänge:* Außentemperatur (Fühler), Heizgrenze (Heating_Off_Outdoor_Temp), Räume (alle aktiv und gültig), Laufzeit

| Schwelle | Standard | Einheit | Herkunft |
|---|---|---|---|
| `zielC` | 10 | °C | Opus-Bericht: 12 → 10 hätte 07./08.10. ~1,5–1,8 kWh el gespart; 07.–10.10.: 7 von 12 Läufen starteten bei ≥ 11 °C (~3,7 von 12,6 kWh el) |
| `reserveK` | 0,5 | K | Wärme eines Laufs (~4 kWh) hebt die Räume um ~0,4–0,6 K (Speichermasse 7–10 kWh/K, Opus); ANNAHME |
| `laufMin` | 15 | min | Startroutine |
| `haltMin` | 15 | min | ANNAHME |
| `proTag` | 2 | Hinweise | ANNAHME |
| `gueltigMin` | 120 | min | ANNAHME |
| `pauseMin` | 180 | min | ANNAHME |

*Erwartung:* Mit Heizgrenze 10 °C startet die Anlage erst bei ≤ 10 °C (Hysterese wie bei 12: aus ab +3 K, ANNAHME); Läufe bei 11–14 °C entfallen.

*Rückweg:* Saisonale Einstellung: der Betreiber setzt sie von Hand (SetHeatingOffOutdoorTemp) und zurück.

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
| `abstand` | Mindestabstand zur letzten Änderung | Wächter: 60 min Abstand; Opus: höchstens 1 Wechsel pro Stunde |
| `tageslimit` | Tageslimit der Regel erreicht | Schreibbudget (Opus: höchstens 6 Wechsel/Tag), EEPROM-Verschleiß unbekannt |
| `abkuehlzeit` | Wartezeit nach dem letzten Vorschlag | kein Flattern: ein abgelaufener oder zurückgezogener Vorschlag kommt erst nach einer Pause wieder |
| `takt` | Takt-Gefahr: Vorlauf über Soll | Anlage schaltet bei Vorlauf ≥ Soll +3,25 K nach ~3 min ab (6 Stopps 07.–10.10.); Sperre ab Soll +1 K für Maßnahmen, die den Vorlauf näher an diese Grenze bringen (mehr Leistung, −1 K) |
| `heizstab` | Heizstab-Nähe | Heizstab ab Außentemperatur < Heater_On_Outdoor_Temp (0 °C) bei Vorlauf < Soll −3 K nach 15 min; ein +1-K-Schritt vergrößert den Rückstand sofort um 1 K |

*Sperr-Parameter (Standard):* `hpMaxAgeMin` 5 · `afterDefrostMin` 10 · `afterDhwMin` 10 · `startLockMin` 15 · `gapMin` 60 · `taktK` 1 · `stopK` 3,25 · `heaterMarginK` 2 · `warmupMin` 10 · `pumpOnRpm` 1000 · `kurveTolK` 1,5

### Whitelist der Übernahme

| Befehl | Topic | erlaubte Werte | Rücklesen |
|---|---|---|---|
| `SetQuietMode` | `panasonic_heat_pump/commands/SetQuietMode` | 0, 1, 2, 3 | Quiet-Stufe |
| `SetZ1HeatRequestTemperature` | `panasonic_heat_pump/commands/SetZ1HeatRequestTemperature` | -1, 0, 1 | Heizkurven-Verschiebung (nur Heizkurvenmodus TOP76 = 0, Wasserfühler TOP111 = 0) |

*Übernahme-Grenzen:* `maxAlterMin` 2,5 · `hpMaxAgeMin` 5 · `abstandMin` 10 · `proTag` 6 · `doppelMs` 120000 · `rueckleseS` 90 · `wiederholungen` 2 · `rueckwegVersuche` 3

### Bewertungsregeln (Version 1)

| Größe | Wert |
|---|---|
| Punkte je Horizont | 100 × [(b − o)² − (p − o)²] / Anzahl Horizonte |
| Basisrate b | aus Vergleichslagen „bleibt, wie es ist“, (k + 1)/(n + 2), erst ab 5 Vergleichen, vorher 0,5 |
| Mindestbeobachtung je Horizont | 0,5 des Horizonts, sonst neutral |
| Problem besteht / gelöst | ≥ 80 % / ≤ 20 % der gültigen Minuten, dazwischen neutral |
| Wirkungsprognose | je Größe ±10, nicht messbar 0, Kalibriermessung 0 |
| Schaden | sperre_verletzt -50, heizstab -50, stopp10 -30, ueberschwingen -30, zu_warm -20, zu_kalt -20 |
| Verpasst | -20 |
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

Der Nutzer vergibt keine Punkte. Auch „Verwerfen“ ist keine Bewertung: der Bewertungsteil des Kerns kennt weder Klicks noch den Übernahme-Zustand, ein Test prüft das. Alle Regeln stehen vorab fest (`SCORE_VER` 1). Jede Änderung erhöht die Version, Punkte verschiedener Versionen bleiben getrennt.

**(1) Auslöser-Prognose je Fall.** Ein Fall ist eine Vorschlags- oder Hinweis-Episode einer Regel.
- Jede Regel nennt vorab ihre Prognose mit Wahrscheinlichkeit *p*, z. B. Quiet-Freigabe: „Ohne Freigabe bleibt der Verdichter am Deckel (≤ 20 Hz) und der Rücklauf-Rückstand ≥ 1 K“, p = 0,8, Horizonte 30/60/120 min.
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
| Treffer bei hoher Basisrate, b = 0,86, p = 0,6 | **−14** (der Vorschlag kam nur dort, wo das Problem sowieso meist bleibt) |

**Kein Gaming:** Wer ohne Trennschärfe vorschlägt, also nur dort, wo das Ergebnis der Basisrate entspricht, bekommt im Mittel ≤ 0 Punkte, egal welches *p*. Der Brier-Score ist „proper“, die Sim prüft das für f = 0,1…0,9 und p = 0,1…0,9.

**(2) Wirkungsprognose.** Sie wird nur bewertet, wenn eine **gleichwertige Änderung tatsächlich passiert**, z. B. der Nutzer setzt Quiet von Hand oder ein Klick wird übernommen.

| Lage | Prognose | Punkte |
|---|---|---|
| Quiet ≥ 1 → 0 bei Rücklauf-Rückstand ≥ 1,5 K | ≥ 25 Hz binnen 5 min; Leistung +350…+650 W (Minute 2–5 gegen die Minute davor); Vorlauf +2 K in 30 min | je ±10 |
| Quiet → 0 ohne Rückstand (< 0,5 K) | ≤ 20 Hz in 10 min | ±10 |
| Quiet → 3 bei ≥ 22 Hz | ≤ 20 Hz binnen 3 min; −300 W | je ±10 |
| Verschiebung ±1 | Soll folgt binnen 3 min | ±10 |

Nicht messbar zählt 0. **Kalibrierfälle** zählen 0 Punkte: Das sind die Messungen, aus denen das Modell stammt, hier 10.10. 08:40, 08.10. 22:54 und 10.10. 11:17 (±3 min). Sie werden ausgewertet und angezeigt.

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
| Quiet-Freigabe | 20 min am Deckel mit ≥ 2 K Rücklauf-Rückstand |
| Raumeinfluss | Raum ≥ 0,5 K unter Minimum 180 min lang, kein Raum zu warm |
| Laufzeit strecken | 10 min ≥ 22 Hz ohne Bedarf mit Abschaltung in ≤ 20 min |

Sicherheits- und Datensperren entschuldigen. Die eigenen Grenzen der Regel (Tageslimit, Abstand, Wartezeit, Stabilität) entschuldigen nicht.

**Raumdaten in der Bewertung:** Werte bis 6 h Alter zählen, weil die Shelly H&T Gen3 nur bei ≥ 0,5 K Änderung melden. Die *Entscheidung* nutzt weiter das Datenalter-Limit des Raums (90 min).

**Punktebuch** `scores-YYYY-MM.jsonl`, je Datensatz:

| Feld | Inhalt |
|---|---|
| `t`, `typ` | Zeit; Typ `ausloeser`, `wirkung`, `schaden`, `verpasst` oder `messaufgabe` |
| `regel`, `v`, `sv` | Regel, Regelversion, Bewertungsversion |
| `fall` | betroffener Fall |
| `p`, `horizonte` | je Horizont: o, b, n, Punkte, Begründung |
| `ergebnis` | Ergebnis des Falls |
| `punkte`, `summe` | Punkte und laufende Summe |
| `text` | Klartext |

Die Karte „Punkte“ zeigt den Verlauf der Summen je Regel als Diagramm (`ui_chart.js`) und je Regel eine Kachel: Summe, Fälle mit Treffern und Fehlalarmen, Brier-Skill = 1 − ΣBS/ΣBS_ref, Wirkung (Kalibrierfälle getrennt), Schaden und Verpasst nur wenn > 0, Freigabereife. Die Wochenübersicht (ISO-Woche) steht weiter im Zustand und im Punktebuch, aber nicht mehr auf der Seite.

**Freigabereife** ist nur eine Anzeige, die Freigabe entscheidet der Nutzer. Bedingungen:
- ≥ 10 bewertete Fälle
- ≥ 14 Tage
- Brier-Skill ≥ 0,2
- 0 × Schaden
- ≤ 1 × verpasst
- ≥ 2 Wirkungsfälle mit Punkten > 0, ohne Kalibrierung

## 7. Messaufgabe Comfort/Efficiency (Korrektur 10.10.)

Die Wirkung von Comfort/Efficiency auf die Verdichterfrequenz ist **ungeklärt**, weil Quiet 3 sie bisher verdeckt hat.

**Messung bisher:**
- Der Boost am 10.10. lief durchgehend in Efficiency.
- Ob das Plateau bei 33–34 Hz (≈ 5 kW bei 11–13 °C) eine temperaturabhängige Frequenzgrenze ist oder eine Begrenzung durch Efficiency, ist offen.
- Der Wechsel Comfort → Efficiency am 08.10. um 10:02 lag unter Quiet 3. Er konnte keinen Frequenzeffekt zeigen.

**Die Nutzerregel bleibt:** keine Comfort/Efficiency-Wechsel wegen Räumen.

**Ablauf der Messaufgabe:**
- Gesammelt werden Minuten mit Quiet 0, laufendem Verdichter ab Minute 15, mindestens 3 min nach einer Quiet-Änderung und Vorlauf ≥ 2 K unter Soll, getrennt nach Heizregelung.
- Sobald beide Seiten ≥ 10 min bei ähnlicher Außentemperatur haben (Mittel höchstens 3 K auseinander), wird **ein Befund** festgehalten: maximale und mittlere Frequenz, elektrische und thermische Leistung, Außentemperatur. Er hat 0 Punkte, Typ `messaufgabe`.
- Der Beobachter rechnet dasselbe aus dem Minutenprotokoll mit derselben Abgrenzung.

**Stand im Replay:** Efficiency 41 min (max 34 Hz, Ø 839 W, 12 °C), Comfort 0 min, also offen. Ein kurzer Boost in Comfort mit Quiet 0 würde reichen.

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
2. **Nur der Klick sendet.** Es gibt keinen automatischen Sendeweg. Die Sim prüft 36 h mit Hauptschalter AN und allen Regeln freigegeben: 0 Befehle ohne Klick.
   - Einzige Ausnahme ist der **Rückweg einer geklickten Übernahme**. Er ist Teil des angezeigten Vorschlags („Gültig bis … automatisch zurück auf …“) und wird nur in Richtung des vorherigen Werts gesendet.
3. **Prüfkette je Klick.** Vom Browser kommen nur ID und Prüfsumme. Der Server prüft:
   - Doppelklick
   - Hauptschalter
   - Maschine rechnet (≤ 2,5 min alt)
   - ID = aktueller Vorschlag
   - Prüfsumme
   - Art = Befehl, nicht Hinweis
   - Regel freigegeben (`apply.json` → `rules`)
   - Gültigkeit
   - Whitelist und Wertebereich: `SetQuietMode` 0–3, `SetZ1HeatRequestTemperature` −1…+1, nichts sonst
   - Topic
   - Notbremse `MQTT.block_active`
   - HeishaMon-Daten ≤ 5 min alt
   - Sperren der Regel
   - **Abgleich mit dem Ist-Zustand**: die Anlage steht noch auf dem Ausgangswert
   - Verschiebung nur im Heizkurvenmodus mit Wasserfühler
   - kein Befehl offen
   - keine aktive Übernahme derselben Größe
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
   | Laufzeit strecken | nach 4 h oder wenn der Grund endet (Raum unter Minimum, Rücklauf-Rückstand ≥ 2,5 K seit 15 min) |
   | Raumeinfluss | nach 6 h oder Raumvorschlag 15 min am Stück 0 (er flackert, wenn Kinderzimmer-Werte ungültig werden) |
   | Quiet-Freigabe | kein automatischer, weil Quiet 0 der Standard ist |

   „Zurücksetzen“ ist jederzeit möglich, außer bei Notbremse. Der Rückweg macht bis zu 3 Versuche.
9. **Neustart** mitten in der Übernahme: Der Zustand liegt in `apply-state.json`. Rücklesen und Rückweg-Timer laufen weiter. Es wird nichts doppelt gesendet, solange die Anlage den Wert meldet.
10. **Not-Aus im Dashboard:** „Übernahme sperren“ setzt `apply.json` → `enabled: false`. **Entsperren geht nie über das Dashboard**, nur über die Datei.
11. **Protokoll:** Jede Aktion steht in `applied-YYYY-MM.jsonl`, auch Ablehnungen mit Grund, und zusätzlich als `optimierer_*` in `quiet-events`.

### Freigabe (nur mit Go des Nutzers)

1. Der Nutzer entscheidet je Regel, z. B. nach der Freigabereife-Anzeige.
2. Flows mit `--uebernahme-knoten-aktiv` erzeugen und deployen (nur `opt_*`).
3. `/data/optimizer/apply.json` schreiben: `{"enabled": true, "rules": ["quiet_freigabe"]}`. Der Hauptschalter wird bei jedem Takt (15 s) neu gelesen.
4. Zurück geht es mit „Übernahme sperren“ im Dashboard, durch Löschen der Datei oder durch einen Deploy ohne den Schalter.

## 9. Seite „Optimierer“

Vier Gruppen, alle 18 breit. Gemischte Breiten auf einer Seite legen die Karten übereinander (Masonry-Falle), deshalb sind sie gleich breit. Die Karten passen ihre Höhe selbst an (`FIT_JS`). Keine erklärenden Hinweiszeilen, kein Satz „würde schalten, sobald …“ mehr auf der Seite (er bleibt nur als Feld `naechste` im Datensatz).

Aufbau (Neufassung 10.10. abends):
- **Daten** baut `tools/engine_view.js` (`ENGVIEW.build`, rein, in `opt_engine` hinter dem Kern eingebettet). **Darstellung**: `tools/eng_ui.js` (`optEngUi.html`/`mount`, rein, HTML mit Maskierung aller Texte), in jede der vier Vorlagen eingebettet. Die Vorlagen zeichnen per `innerHTML` wie die Diagrammkarten, ohne Angular-Ausdrücke.
- **Knöpfe** schicken weiter nur Aktion, ID und Prüfsumme (`scope.send` genau viermal im Code, Test).

| Karte | Inhalt |
|---|---|
| Entscheidungsmaschine | **Statuszeile** aus Chips: „Maschine läuft · hh:mm“ bzw. „Anlaufsperre bis …“, „keine HeishaMon-Daten“, „Maschine rechnet nicht“; Anlage kurz (Lauf · Hz · Quiet · Vorlauf-Abstand); Übernahme („🔒 Übernahme gesperrt“, „Übernahme frei: …“, „Übernommen …“, „wartet auf Bestätigung“); Warnung; „verworfen: …“. **Vorschlag** nur wenn einer da ist: hervorgehobener Kasten mit Regel, Was, Warum (eine Zeile mit Zahlen), Befehl, seit, gültig bis, Rückweg kurz; Erwartung und Rückweg-Text eingeklappt. **Knöpfe**: Übernehmen (deaktiviert mit Grund als Beschriftung), Verwerfen; Zurücksetzen nur bei aktiver Übernahme; Übernahme sperren nur wenn freigegeben |
| Regeln | 4 Kacheln: Name, Status-Chip (Vorschlag/Hinweis, wartet, gesperrt, prüft, ruht, keine Daten), je Bedingung ein Segment (grün = erfüllt, Titel = Bedingung), eine Zeile mit dem Engpass und Balken: „Vorlauf-Rückstand 0,5 / 1,5 K“, „Haltezeit 4 / 10 min“, „🔒 Mindestabstand bis 09:38“, „seit 08:36 · gültig bis 09:06“ |
| Punkte | Diagramm der Summen je Regel (nur wenn es Punkte gibt), 4 Kacheln (Summe, Fälle/Treffer/Fehlalarm, Skill, Wirkung, Schaden/Verpasst rot, Freigabereife n/m mit Balken, Kriterien eingeklappt), Messaufgabe Comfort/Efficiency als eine Zeile |
| Entscheidungen | **Episoden** statt Minutenzeilen: je Regel von „alle Bedingungen erfüllt“ (wartet, gesperrt, Vorschlag/Hinweis) bis zum Ende, mit Verlauf als Chips und Ende-Grund; Dauerzustände („prüft“, „ruht“) und Datenlücken erzeugen keine Zeile, kurze „wartet“-Episoden unter 5 min ohne Sperre oder Vorschlag werden ausgeblendet; höchstens 12, neueste oben |

**Vorschau ohne Dashboard:** `node tools/engine_ui_preview.js [Datenordner] [Ausgabe.html]` spielt die echten Protokolle durch den Kern und zeichnet vier Schnappschüsse (10.10. 08:38 mit Vorschlag; Replay-Ende; Hauptschalter an mit aktiver Übernahme; 5 Tage Kälte-Szenario mit Punkten) in eine HTML-Datei, die das Dashboard nachbildet (Gruppenbreite 966 px).

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

| Befehl | Ergebnis (10.10.2026) |
|---|---|
| `cp "flows (26.5.1 stable).json" /tmp/x.json && python3 tools/optimizer_phase1.py /tmp/x.json && node tools/optimizer_sim.js /tmp/x.json` | **605 OK** (vorher 604; neu: Strukturprüfung des Sendewegs) |
| `node tools/engine_sim.js /tmp/x.json [Datenordner]` | Kern, Sperren, Mehrtages-Modell, Punktesystem, Nachprüfung, Seite (Karten-Daten, Darstellung, Vorschau), Hüllen im vm, gesperrte Übernahme, Replay: **151 OK** mit Flow-Datei und Daten (ohne Flow-Datei 104) |
| `BEOBACHTER_TMP=<ordner> python3 tools/bonsai_beobachter_test.py [Datenordner]` | **9 OK**, LLM nur als Mock |
| `node tools/engine_replay.js <Datenordner> [Ausgabe]` und `--md` | Replay der echten Protokolle |

Angepasste Sicherheitsprüfungen in `optimizer_sim.js` sind gezielt: Es ist **genau** `opt_apply_mqtt` erlaubt. Eine neue Prüfung verlangt:
- er ist deaktiviert
- er wird nur von `opt_apply` gespeist
- `opt_apply` hat nur die Eingänge Karte und Takt
- er hat einen eigenen Broker-Client
- `opt_engine` hat keinen Weg dorthin

Jeder andere `mqtt out` sowie jeder Link- und HTTP-in-Knoten im Tab bleibt verboten. `engine_sim.js` prüft an verfälschten Kopien, dass diese Strukturprüfung anschlägt. Die Funktionsliste „kennt commands/“ ist um genau `opt_engine` (nur Vorschlagstexte) und `opt_apply` erweitert.

## 12. Bekannte Grenzen und Annahmen

**Rücklauf-Schwelle der Quiet-Freigabe.** 1,5 K ist eine **Annahme**. Gemessen sind nur zwei Punkte: ≤ 0,25 K keine Reaktion, ≥ 2,5 K volle Reaktion. Die Wirkungsprognose wird das zeigen. Kalibrierfälle zählen nicht.

**Quiet 2/1.** Dass Quiet 2 ebenfalls auf 16–17 Hz hält, stützt sich auf nur 4 min nach einem Start (08.10.). Quiet 1 ist nicht gemessen.

**Kalte Außentemperatur, Abtauen, Heizstab.** Dafür gibt es keine Daten. Die Sperren sind vorsichtig gesetzt, aber ungeprüft.

**Raumregel.** Sie hängt am Raumvorschlag der Phase 2. Der flackert, weil Kinderzimmer-Werte nach 90 min als ungültig gelten (die Shelly melden nur bei Änderung).
- Im Replay entstand daraus ein „verpasst“: Kinderzimmer oben lag ab 09.10. 18:47 über 3 h ≥ 0,5 K unter Minimum.
- **Entscheidung des Nutzers:** Datenalter-Limit für die Gen3-Sensoren auf ~360 min setzen?

**Laufzeit strecken.** Die Regel kam nie zum Zug. Bei mildem Wetter steht der Verdichter auch mit Quiet 0 und kleinem Rückstand am Minimum (10.10. 11:17). Kriterien und Erwartung stammen aus der Physik und einer Messung, nicht aus Fällen.

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

**Zeitzone.** Wie im übrigen Optimierer ist sie die Ortszeit des Containers. Die Sim läuft mit Europe/Berlin, auch über die Zeitumstellung am 25.10.

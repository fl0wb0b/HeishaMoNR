# Verzögerungstest (Schalt-Prüfstand): Stand, Testplan und Rückbau

Branch `delaytest-v2` (auf Basis `optimizer-engine` = Live-Stand). Nichts davon ist eingespielt. Der Eingriff in die Kerntabs braucht das ausdrückliche Go des Nutzers.

## 1 Was der Test klären soll

Folgen die Schaltschwellen der Leisha dem angezeigten Soll **inklusive** Heizkurvenverschiebung?

Gemessen (07.–10.10., 1-min-Daten, `tools/switch_events.py`):
- Stopp bei Vorlauf = angezeigter Soll +3,0…+3,25 K (9 von 9).
- Start 6–13 min, nachdem der Vorlauf angezeigten Soll −3,25 K erreicht hat. Vorlauf minus Rücklauf beim Stopp lag beim Start bei −3,75…−4,0 K, nach dem Boost am 10.10. bei −6,75 K (Start trotzdem bei Soll −3,25 K).

Handbuch (Serie J, 14.1.2.1): AUS bei Vorlauf − interner Soll > 2 K für 3 min, EIN bei Vorlauf − gespeichertem Rücklauf < −3 K. Die Ausschaltregel passt, wenn der interne Soll = angezeigter Soll + 1 K ist. Die Einschaltregel passt nicht: Sie hätte jeden Start 15–25 min früher ausgelöst.

**Ein-Test** (zuerst): +1 K in der Pause, kurz bevor die Schwelle kommt.
- Folgt die Schwelle dem Soll, startet der Verdichter 6–13 min nach Vorlauf = Basis-Soll −2,25 K. Das ist ≈ 15–25 min früher als ohne Test.
- Wirkt die Verschiebung nicht, kommt der Start erst nach Basis-Soll −3,25 K.

**Aus-Test** (später): +1 K im Lauf bei steigendem Vorlauf.
- Folgt die Grenze dem Soll, kommt der Stopp erst bei Basis +4,0…+4,25 K.
- Wirkt die Verschiebung nicht, kommt er bei +3,0…+3,25 K.

## 2 Bausteine und geänderte Knoten

| Tab | Knoten | Art | Wirkung |
|---|---|---|---|
| WP Control | `add6fa4d403dd143` Summenfunktion | geändert (Block + Summenzeile) | addiert `OPT_test_shift`, nur wenn ≤ 150 s alt **und** Raumregelung/Softstart/Nachtabsenkung aus; hart −1…+1 K |
| WP Control | `dtpatch_sumtick`, `dtpatch_sumgate` | neu | jede Minute → vorhandener Trigger `987d38642eaa3c4c` → Summenfunktion; **nur im Testfenster** |
| WP Managers | `dtpatch_guard_tick`, `dtpatch_guard` | neu | Rückstellwächter (siehe unten), Ausgänge: Ratenbegrenzung `bfa541a4cf7363ca`, Log `7ddd3f5d8f76897e`, Filter `78cd6de319a6d061` |
| WP Optimizer | `opt_dt`, `opt_i_dt`, `opt_f_dt`, `opt_ui_dt_arm`, `opt_ui_dt_status`, `opt_g_dt` | vom Generator | Prüfstand, Schalter und Status auf „Daten & Güte“, Protokoll, Hinweis (Toast) |

Sonst ändert sich nichts. `python3 tools/delaytest_patch.py --diff vorher.json nachher.json` prüft das.

**Rückstellwächter** (`dtpatch_guard`), jede Minute, nur im Testfenster (scharf/Test/Rückstellung und 24 h nach dem letzten Testende; auch nach einem Neustart über `/data/optimizer/delaytest-window.json`):
- Er vergleicht TOP27 mit dem Wert, den HeishaMoNR **ohne** Test will (gleiche Summe wie die Summenfunktion).
- Er sendet **nur nach unten** und nur genau diesen Wert, nie einen Testwert.
- Er sendet nicht bei aktivem Test, MQTT-Sperre oder veralteten HeishaMon-Werten. Bei einer Abweichung von mehr als 2 K sendet er auch nicht.
- Zeitplan: frühestens 2 min nach dem Erkennen, dann alle 3 min (5 Befehle), danach alle 30 min, höchstens 12 Befehle.
- Alarm nach 15 min.
- Einmal je Node-RED-Start schickt er dem „Filter“ einen Platzhalter. Der Filter verschluckt nach jedem Start die erste Nachricht, sonst ginge der erste Teststart verloren.

**Prüfstand** (`opt_dt`, Kern `tools/delaytest_core.js`):
- Er schreibt nur `OPT_test_shift/OPT_test_ts`, `OPT_dt_window`, `OPT_dt_status` und Dateien unter `/data/optimizer/`.
- Er misst ab der Bestätigung (TOP27 = 1). Ohne Bestätigung nach 4 min bricht er ab.
- In der Phase „nach“ gibt er nie auf: Status „ACHTUNG …“ und Alarm (Toast und Ereignis) nach 10 min, bis die Anlage wieder den HeishaMoNR-Wert meldet.

## 3 Einspielen (mit dem Nutzer, nicht automatisch)

1. Live-Flows holen und als `flows_backup_pre_delaytest.json` sichern.
2. Arbeitskopie erzeugen:
   ```
   python3 tools/optimizer_phase1.py work.json
   python3 tools/delaytest_patch.py work.json
   python3 tools/delaytest_patch.py --diff cur.json work.json
   ```
   Der Diff darf nur `opt_*` und die 5 Kern-IDs zeigen.
3. Auf `work.json` müssen alle grün sein:
   ```
   node tools/optimizer_sim.js work.json
   node tools/engine_sim.js work.json
   node tools/delaytest_sim.js work.json
   node tools/delaytest_chain_sim.js work.json
   ```
4. Deploy (Typ „nodes“). `deploy_opt.sh` lehnt Nicht-`opt_*`-Änderungen ab. Für diesen einen Deploy gilt die Ausnahmeliste `python3 tools/delaytest_patch.py --ids`, sonst bleibt der Ablauf gleich (rev-Prüfung, Fehlerlog).
5. Kontrolle ohne Test:
   - Status „aus (nicht scharf)“.
   - `delaytest-window.json` = `null`.
   - Keine neuen `SetZ1HeatRequestTemperature`.
   - TOP27 = 0.

## 4 Testplan

**Parameter** (Standardwerte im Generator, `DELAYTEST`):

| Punkt | Wert |
|---|---|
| Verschiebung | genau +1 K, nur über die Summenfunktion |
| Scharf schalten | nur 9–18 Uhr; gilt bis 18 Uhr desselben Tages, danach verfällt die Wahl |
| Start | 9–18 Uhr, höchstens 1 Test je Tag, 120 min Abstand |
| Außentemperatur | 8,5–12,5 °C, ≥ 60 min unverändert (Sollsprünge an 10/11 °C vermeiden) |
| Ein-Test, Startlage | Pause ≥ 20 min, Pumpe 1000–2600 U/min (keine Spülung/Heizgrenze), Vorlauf −1,75…−1,0 K zum Soll, Abfall 1,5–4,2 K/h über 15 min |
| Aus-Test, Startlage | Lauf ≥ 45 min, Vorlauf +1,75…+2,5 K, Anstieg ≥ 1,2 K/h über 20 min, Radiator Kinderzimmer oben aus |
| Räume | Kinderzimmer unten, Schlafzimmer und Wohnzimmer im Band und ≤ 90 min alt. Kinderzimmer oben nur 21–25 °C, weil es eine eigene Regelung hat. Radiator-Zustand bekannt und ≥ 15 min nicht geschaltet |
| Anlage | Heizkurvenmodus, nur Zone 1, Wasserfühler, TOP27 = 0 und berechnete Verschiebung 0; Raumregelung, Nachtabsenkung und Softstart aus; Quiet und Heizregelung bleiben, wie sie sind (Quiet 0); keine MQTT-Sperre; Übernahme der Entscheidungsmaschine aus; Zustandsdatei schreibbar |
| Dauer | Ein-Test höchstens 75 min, Aus-Test höchstens 100 min ab Bestätigung |

**Abbruch** (sofort Verschiebung 0):
- Raum außerhalb des Bands: mehr als Max + 1,5 K oder weniger als Min − 0,3 K; Kinderzimmer oben außerhalb 21–25 °C.
- Abtauen, Warmwasser, Heizstab.
- Dashboard „Aus“.
- Totmann: Ruft der Prüfstand nicht mehr auf, verwirft der Patch den Wert nach 150 s. Der Takt rechnet jede Minute.
- Anlagenwerte älter als 10 min.
- MQTT-Sperre.
- Sollsprung (2 min bestätigt).
- Außentemperatur mehr als 1 K außerhalb des Fensters.
- Vorlauf > 36 °C, im Aus-Test > Basis + 4,75 K.
- Quiet oder Heizregelung geändert.
- Raumregelung, Softstart oder Nachtabsenkung an.
- Übernahme der Entscheidungsmaschine an.
- Keine Bestätigung nach 4 min, oder die Anlage meldet ≠ 1.
- Neustart von Node-RED, Fehler im Prüfstand.

**Auswertung** (Ereignis `verzoegerungstest_ergebnis`, `delaytest-YYYY-MM.csv`):
- **Ein-Test:** Minuten ab Bestätigung bis zum Start, Minuten ab „verschobene Schwelle erreicht“ (−2,25 K zum Basis-Soll) bis zum Start, Vorlauf beim Start, Vorlauf − Rücklauf beim Stopp. Klassen:
  - `folgt_soll`: Start ≤ 16 min nach der verschobenen Schwelle, vor der natürlichen.
  - `ohne_wirkung`: kein Start in diesem Fenster, Start erst nach der natürlichen Schwelle.
  - `frueher_als_erwartet`, `unklar`, `vor_bestaetigung`, `anderer_grund`.
  - Gewinn in Minuten = Startzeit mit Test gegen den erwarteten natürlichen Start (Abfallrate aus dem Start-Ereignis).
- **Aus-Test:** Vorlauf beim Stopp gegen Basis-Soll und Minuten über +3,5 K ohne Stopp. Klassen:
  - `folgt_soll`: Stopp ≥ +3,75 K oder ≥ 5 min über +3,5 K.
  - `ohne_wirkung`: Stopp ≤ +3,25 K.
  - `grenze_nicht_erreicht`, `anderer_grund`, `unklar`.
- Eine Klasse gilt erst als Befund nach **3 gleichen Ein-Tests an verschiedenen Tagen**.
- Grenze: Die Handbuch-Regel (gespeicherter Rücklauf −3 K) liegt mit den gemessenen Rücklaufwerten fast auf der verschobenen Schwelle und ergäbe ebenfalls `folgt_soll`. Sie ist aber schon ohne Test widerlegt (sie sagt Starts bei Soll −2,0…−2,25 K voraus, gemessen −3,25 K).

**Ablauf am Testtag** (beaufsichtigt):
1. Morgens prüfen: Karte „Schaltlogik-Test (Einmal-Test, +1 K)“ auf „Daten & Güte“, HeishaMoNR-Funktionen Raumregelung, Nachtabsenkung und Softstart aus, MQTT frei, TOP27 = 0.
2. Zwischen 9 und etwa 12 Uhr „Einschalten auslösen“ wählen. Der Test startet von selbst in der nächsten passenden Pause; der Status nennt den Wartegrund.
3. Beobachten:
   - Status „bestätigt“ binnen ≤ 4 min nach dem Start.
   - Nach dem Ende TOP27 = 0 binnen ≤ 5 min.
   - Der Schalter springt auf „Aus“ (Einmal-Test).
4. Im Zweifel „Aus“ wählen.
5. Bei „ACHTUNG“ oder Alarm: TOP27 prüfen. Der Rückstellwächter stellt selbst zurück. Notfalls stellt der Nutzer über die HeishaMon-Weboberfläche `SetZ1HeatRequestTemperature = 0` ein.
6. Über Nacht läuft nie ein Test. Wächter und Takt bleiben 24 h nach dem letzten Testende aktiv.

## 5 Rückbau

| Stufe | Schritte | Wirkung |
|---|---|---|
| sofort, ohne Deploy | Dashboard „Aus“ | Abbruch, +1 verfällt (Takt + Wächter) |
| Kern zurück | `python3 tools/delaytest_patch.py flows.json --revert`, Deploy | Summenfunktion Byte für Byte wie vorher, die 4 neuen Kern-Knoten weg. Der Prüfstand ist dann wirkungslos (kein Pfad zur Anlage) |
| vollständig | `--revert --pruefstand-entfernen`, Deploy; `/data/optimizer/delaytest-state.json` und `delaytest-window.json` löschen; Protokolle `delaytest-*.csv` und Ereignisse behalten oder archivieren; künftige Optimizer-Deploys vom Branch `optimizer-engine` erzeugen (sonst legt der Generator den Prüfstand wieder an) | kein Rest im Flow |
| Notweg | `flows_backup_pre_delaytest.json` komplett zurückspielen (Deploy-Typ „full“) | Stand vor dem Einspielen |

`config.json` braucht keinen Rückbau: Der Block `delaytest` kommt nur aus den Standardwerten.

## 6 Simulationen

| Simulation | Inhalt | Prüfungen |
|---|---|---|
| `tools/delaytest_chain_sim.js` (39 Prüfungen) | echte HeishaMoNR-Kette und Optimizer-Knoten in einer Node-RED-Nachbildung: nur Speicher „memory“, Punkt-Schlüssel, Ereignis-Aufrufe statt jede Minute, Command Check mit Timern, Broker, HeishaMon (5-min-Komplettabgleich), Neustarts | Fälle A–G mit Gegenproben am alten Stand, weitere Störungen, Monte-Carlo der Auswertung (4 Hypothesen), Aus-Test, 5 Tage |
| `tools/delaytest_sim.js` | Logik von Kern, Hülle und Patch, vereinfachte Anlage | 66 |
| `tools/optimizer_sim.js` | Optimizer | unverändert grün |
| `tools/engine_sim.js` | Entscheidungsmaschine | unverändert grün |

# Konzept: Comfort/Efficiency-Umschaltung (Heizregelung) und kontrollierte Tests

Stand 2026-10-08. Reines Konzept, **keine Steuerungsänderung**. Oberstes Ziel: nicht die niedrigste momentane Leistung, sondern der geringste
**gesamte elektrische Energiebedarf für die tatsächlich benötigte Wärmemenge** bei eingehaltenem Heizkomfort.

Aussagen aus Foren und Zusammenfassungen sind hier **Hypothesen**, solange sie nicht an unserer Anlage gemessen sind.

## 1. Prüfergebnis

| Frage | Ergebnis | Beleg |
|---|---|---|
| Firmware kennt `SetHeatingControl`? | **Ja.** Befehl `SetHeatingControl` (SET39: 0 = Comfort, 1 = Efficiency) und Status `main/Heating_Control` (TOP139, Byte 30, Bit 5–6) | HeishaMon PR #768 (gemergt 14.01.2026): `commands.h/.cpp`, `decode.h`, `MQTT-Topics.md` |
| Welche Firmware läuft? | HeishaMon **v4.2.2** (13.09.2026, also nach dem PR); v4.2.3 (07.10.2026) ist verfügbar | Seitenkopf der Geräteseite, GitHub-Releases |
| Aktueller Zustand | `Heating_Control = 0` (Comfort), `Heating_Mode` = Kurve, `Pump_Flowrate_Mode = 0` (DeltaT), `Heat_Delta` 3 K, `Max_Pump_Duty` 254, Quiet-Priorität `1` = **Capacity (Leistung)** | MQTT und `http://192.168.2.170/json`, nur gelesen |
| Kennt unser Node-RED das schon? | **Nein.** Weder Status noch Befehl noch Dashboard-Schalter (HeishaMoNR 26.5.1 enthält es nicht) | Suche in allen Flows |
| Wo kann man es manuell setzen? | HTTP: `http://192.168.2.170/command?SetHeatingControl=0` (oder `=1`); MQTT: `panasonic_heat_pump/commands/SetHeatingControl`; die HeishaMon-Webseite hat dafür **keine** Bedienseite (Menü: Firmware, Reboot, Rules, Settings) | `MQTT-Topics.md`, Geräteseite |
| Befehl getestet? | **Nein**, absichtlich nicht gesendet | |

Quiet-Priorität laut Firmware: `0 = Sound (Lautstärke)`, `1 = Capacity (Leistung)`. Unsere Anzeige hatte das bis 08.10. vertauscht („Ton“ für 1).
Bei Priorität Leistung kann der Quiet-Deckel nach Herstellerlogik bei Bedarf weichen (nicht geprüft). Der Plan rechnet deshalb dann mit der Nennleistung.

## 2. Eignung der vorhandenen Messdaten für die COP-Bewertung

Vorhanden (alle als CSV im NAS-Volume, siehe `README`/Memory):

* elektrische und thermische Leistung (HeishaMon `extra/*_Extra`, jede Minute), COP je Minute und **je 15-min-Slot integriert** (`plan-actuals`),
* Verdichterfrequenz, Lüfter, Pumpe (Drehzahl, Duty, Durchfluss), Spreizung, Soll-/Ist-Vorlauf und -Rücklauf, Außentemperatur, Wetterfeuchte/Taupunkt (OWM),
* Quiet-Stufe und -Ereignisse, Raumtemperaturen, Preis, PV, Prognosen und der Vergleich Prognose/Ist.

**Seit 08.10. zusätzlich** (rein beobachtend): `Heating_Control` und Pumpenmodus als Spalten und Ereignisse (auch Änderungen von außen), mitgelesene Befehle mit Quelle,
**Abtauprotokoll** je Zyklus (Dauer, Aussen, Feuchte, Strom, Wärmeentzug, Vorlaufeinbruch, Wiederaufheizzeit, Abstand zur letzten Abtauung),
und im Slot-Ist: Wärme gesamt inkl. Abtauen, Strom Heizen/Abtauen, Spreizung, Vorlaufabweichung, Pumpendrehzahl, Heizregelung.

Grenzen der Daten:

* **Thermische Leistung ist nicht unabhängig**: HeishaMon und unsere Rechnung nutzen beide Durchfluss × Spreizung (Verhältnis 1,00, Streuung 0,71–1,43).
  Bei 2–3 K Spreizung und 0,25 K Sensorauflösung sind das etwa ±10 % je Messwert. Systematische Fühler-Abweichungen (±0,5 K) wären ±20 %.
  Über lange Zeiträume mitteln das Zufallsfehler aus, Offsets nicht.
* **Strom**: Unklar, ob `Heat_Power_Consumption_Extra` Umwälzpumpe und Lüfter enthält. Ein externer Zähler an der Zuleitung wäre die Referenz.
  Standby 15 W deutet auf Elektronik, nicht auf Pumpe.
* **Nur Mildwetter-Daten** (12–19 °C). Für Comfort gegen Efficiency braucht es Frost, Feuchte und Abtauen.
* Pumpe (DeltaT-Modus): Im Teillast-Betrieb steht sie am Minimum (~1750 U/min, ~13 l/min), sie steigt erst mit größerer Spreizung (3,5–5 K: ~2250 U/min, ~18 l/min) und kurz beim Anlauf.
  Der Pumpenstrom ist nicht gemessen, bei höherer Last wird er relevant.

## 3. Bewertungsgröße

Primär: `E_el_gesamt / Q_th_gesamt` über **volle Zeiträume** (je 6 h und 24 h) inklusive Abtauen und, wenn messbar, Pumpen- und Hilfsenergie.
Für den Vergleich über Temperaturen: normierter Wirkungsgrad `COP / COP_Carnot(AT, VL)` (haben wir bereits als η).

Immer nur vergleichen: gleiche Außentemperaturklasse, ähnliche Feuchte/Taupunktklasse, ähnliche Last (Wärmebedarf in kW, aus dem Plan-Modell), gleiches Vorlaufniveau und gleiche Quiet-Stufe.

Sekundär: Regelgüte (Zeitanteil mit Soll−Ist-Vorlauf > 2 K), Starts und Laufzeiten, Abtauanzahl/-dauer/Wiederaufheizzeit, Komfort (Zeit unter Raum-Minimum).

## 4. Umschaltkriterien (Hypothesen, nichts davon ist implementiert)

Efficiency nur, wenn **alle** gelten: Außentemperatur oberhalb einer Grenze (Start: 5 °C, nie im 1–3-°C-Fenster), Plan-Bedarf klein gegenüber der Leistungsgrenze,
kein Abtauen in den letzten Stunden und niedriges Defrost-Risiko in den nächsten, alle Räume im Band, Vorlaufabweichung im Mittel < 1 K.

Comfort sofort bei: Vorlauf-Soll-Abweichung > 2 K über mehrere Minuten, wiederholt schlechter Erholung nach Abtauen, Raum unter Minimum, hohem Plan-Bedarf, hohem Defrost-Risiko, Datenausfall, Fehler.

Schwellen, Hysterese und Mindestverweilzeit (Vorschlag: ≥ 12 h, höchstens 2–3 Wechsel pro Tag) werden **aus den Messdaten** bestimmt. Wie oft die Einstellung geschrieben werden darf, ist nicht dokumentiert (Schreibzyklen unbekannt): selten schalten.

## 5. Teststufen

| Stufe | Inhalt | Wirkung auf die Anlage |
|---|---|---|
| T0 | Comfort als Basis, mehrere Tage inkl. kalter Tage, neue Protokollierung läuft | keine |
| T1 | Manuelle A/B-Tests durch den Betreiber, Wechsel ABBA im Tagesrhythmus bei gleichen Bedingungen, nur ein Faktor je Testfenster (nie zugleich Quiet) | nur auf Anweisung des Betreibers |
| T2 | Shadow-Empfehlung Comfort/Efficiency im Optimizer mit Begründung, Vergleich mit dem Ergebnis | keine |
| T3 | Automatische Umschaltung mit Leitplanken (Bedingungen oben, Rückfall auf Comfort bei Fehler, Befehlsbudget, Quelle markieren, Fremdänderung erkennen) | erst nach Freigabe |

Abbruch eines A/B-Tests (zurück auf Comfort, Tag als ungültig): Raum unter Minimum − 0,5 K für > 60 min, Vorlauf-Soll-Abweichung > 3 K für > 30 min, auffällige Wiederaufheizzeit nach Abtauen.
Flüstermodus (FM0/2/3) und Pumpenmodus (DeltaT gegen Max-Duty, Spreizung 3 gegen 5 K) folgen dem gleichen Schema, Pumpe erst, wenn der Pumpenstrom messbar ist.
Normale Abtauvorgänge werden nie unterdrückt.

## 6. Kollisionen mit Wärmeplanung und bestehender Regelung

Ein Schreiber je Stellglied, jeder Befehl mit Quelle (`MQTT_Source`), gemeinsame Sperren (Abtauen +10 min, Verdichterstart 15 min, Sanftanlauf, Warmwasser) und das gemeinsame Tagesbudget (500 Befehle).

| Stellglied | Befehl | Besitzer heute | Besitzer später |
|---|---|---|---|
| Heizkurve verschieben | `SetZ1HeatRequestTemperature`, `SetCurves` (Summe `SHIFT_Final`) | HeishaMoNR (Kurve, Raumregelung aus, Sanftanlauf) | Raumlogik (Shadow), Wärmefahrplan nur als Hinweis |
| Quiet-Stufe | `SetQuietMode` | Betreiber (GUI) | Quiet-Logik (Shadow), nicht in Testfenstern |
| Heizregelung | `SetHeatingControl` | niemand (Comfort) | Mode-Logik (zuerst Shadow) |
| Pumpe | `SetPumpFlowrateMode`, `SetMaxPumpDuty` | Betreiber | Betreiber |

Der Wärmefahrplan liefert Bedarf, Reserve, Fenster und Hinweise, er schaltet nichts. Regeln gegen Kollisionen:

* Efficiency ist gesperrt, wenn der Plan in den nächsten 3 h hohen Bedarf (> 70 % der Leistungsgrenze) oder ein starkes Vorziehen vorsieht.
* Umschaltungen nur an Slot-Grenzen, nie während eines Verschiebe- oder Vorziehfensters.
* Priorität: Komfort vor Sicherheit (Abtauen/Frost) vor Effizienz vor Preis.
* Fremdänderungen (HeishaMon-Seite, Regler) werden über die Status-Ereignisse erkannt und beenden einen laufenden Test.

## 7. Offene Punkte

* Wirkung und Persistenz von `SetHeatingControl` an dieser Anlage (nur durch einen kontrollierten Test auf Anweisung des Betreibers zu klären).
* Referenzmessung des Stroms (Shelly o. ä. an der Zuleitung) und Pumpenstrom.
* Quiet-Priorität „Leistung“: Verhalten des Deckels bei Last messen (kalte Nacht).
* HeishaMon-Update v4.2.3 nicht ungeprüft einspielen (Änderungen lesen).

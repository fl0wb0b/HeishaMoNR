# HeishaMoNR-Ableger: Dashboard und Optimierer für eine Panasonic Aquarea L

Dieses Repository ist ein **eigenständiger Ableger** von [Egyras/HeishaMoNR](https://github.com/Egyras/HeishaMoNR). Der Node-RED-Flow des Originals ist die Basis, aber Dashboard, Steuerlogik und Werkzeuge wurden für eine konkrete Anlage weit umgebaut. Eine Rückführung in das Hauptprojekt ist nicht geplant. Die ursprüngliche Anleitung liegt unverändert in [readme_heishamonr_original.md](readme_heishamonr_original.md).

**Anlage:** Panasonic Aquarea L, WH-WDG05LE5 (5 kW Monoblock, R290), nur Heizen über Heizkörper, eine Zone, kein Warmwasser über die Wärmepumpe. Anbindung über [HeishaMon](https://github.com/Egyras/HeishaMon) und MQTT, Node-RED auf einer NAS, Energiedaten von Victron Venus/VRM und evcc, Wetter von OpenWeatherMap, Raumfühler Shelly H&T.

## Was anders ist als im Original

- **Deutsches Dashboard** mit elf Seiten: Übersicht (Anlagenschema mit Kältekreis, Modulkacheln), Einstellungen, Heizung, Betrieb, Zeitplan, Auswertung, Effizienz, Optimierung, Optimierer, Daten & Güte, System. Nur für Desktop ausgelegt (1024 bis 2560 px).
- **COP-Korrektur:** HeishaMon meldet die elektrische Leistung ohne Steuerung und Pumpe. Der Kern rechnet im Verdichterlauf +80 W dazu (Forum-Befund), in COP, kWh-Zählern und der Weitergabe an VRM.
- **Optimierer** (Tab „WP Optimizer“, alle Knoten mit Präfix `opt_*`, erzeugt aus `tools/optimizer_phase1.py`):
  - Entscheidungsmaschine `tools/engine_core.js` mit Regeln als Daten: Quiet-Freigabe, Deckel/Laufzeit, Raumeinfluss, Vorausschau (Wetter), Heizregelung (Comfort/Efficiency). Jede Regel hat Sperren, Arbitrierung, Prognose und Bewertung (Brier-Punkte).
  - **Ein-Klick-Übernahme:** Die Maschine schlägt vor, der Mensch klickt. Begrenzt auf wenige Befehle am Tag, mit Rücklesen und Rückweg. Ohne Freigabe reiner Schattenbetrieb.
  - Pro-Raum-Komfortbänder, berechnete Außentemperatur, Wärmefahrplan (Vorschau), COP-Kennfeld je Modus × Quiet × Außenband, Takt- und Mindestleistungsmessung, Kälte-Vorsorge, Heizstab-Wächter.
  - Protokolle als CSV im Container (`/data/optimizer/`), Minutentakt für die Wärmepumpe, 5-Minuten-Takt für Räume und Wetter.
- **Bonsai-Beobachter** (`tools/bonsai_beobachter.py`): tägliche Auswertung der Protokolle mit einem lokalen Sprachmodell, nur Hinweise, keine Steuerung.
- **Messungen statt Annahmen:** Stopp bei Vorlauf = Soll +3 K, Start bei Soll −3,25 K, Quiet-Deckel je Stufe, Verhalten von Comfort und Efficiency, Mindestfrequenz bei Frost. Die Befunde stehen in `docs/`.

## Arbeitsweise

1. **Erst simulieren, dann einspielen.** `tools/optimizer_sim.js` und `tools/engine_sim.js` spielen den Flow offline mit Fake-Uhr und echten Protokollen durch. `tools/opt_seiten_vorschau.js` und `tools/ui_vorschau_pruefen.js` rendern die Dashboard-Seiten bei 1024/1920/2560 px und prüfen auf Querscrollen und abgeschnittene Elemente.
2. **Nur `opt_*`-Knoten über den Generator.** Änderungen am Kern (Originalflow) laufen über eigene, idempotente Patch-Skripte mit Test und byte-gleichem Rückbau (`tools/*_patch.py`), Deploy nur als Typ `nodes`.
3. **Kein Eingriff ohne Freigabe.** Die Anlage bekommt Befehle nur nach Klick, jeder Befehl wird protokolliert und bewertet.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `flows (26.5.1 stable).json` | Node-RED-Flow (Kern aus dem Original plus eigene Änderungen) |
| `tools/optimizer_phase1.py` | Generator für alle `opt_*`-Knoten, Vorlagen und Funktionen |
| `tools/engine_core.js`, `engine_view.js`, `eng_ui.js` | Entscheidungsmaschine, Karten, Oberfläche |
| `tools/schema_ui.js`, `ui_chart.js`, `ui_optik.css` | Anlagenschema, Diagramme, gemeinsamer Stil |
| `tools/*_sim.js`, `*_test.py`, `*_analyse.js` | Simulationen, Tests, Auswertungen der Protokolle |
| `tools/bonsai_beobachter.py` | Beobachter mit lokalem Sprachmodell |
| `docs/OPTIMIERER.md` | Doku der Maschine: Regeln, Punktesystem, Übernahme, Beobachter |
| `docs/heating_control_concept.md` | Comfort/Efficiency: Konzept und Messungen |
| `docs/replay_2026-10-07_bis_10.md` | Replay der Maschine auf echten Daten |
| `documentation/`, `images/` | Anleitung und Bilder des Originals |

## Branches

`main` zeigt den eingespielten Stand. Arbeitszweige heißen nach ihrem Thema (`ui-lambda`, `regel-heizregelung`, `cop-korrektur`, `raumeinfluss-v3`, …) und werden nach dem Einspielen in `main` übernommen.

## Hinweise

- Die Anlage, das Haus und die Messwerte sind spezifisch. Schwellen und Regeln sind für andere Anlagen nicht ohne Prüfung übertragbar.
- Die Regeln haben noch keinen Winter gesehen; alle Schwellen für Frost, Abtauen und Heizstab sind Annahmen und im Code so gekennzeichnet.
- Zugangsdaten (OpenWeatherMap, VRM) liegen nur in Dateien im Container, nie im Flow oder Repository.

Lizenz und Urheberrecht des Originals bleiben unberührt, siehe [readme_heishamonr_original.md](readme_heishamonr_original.md).

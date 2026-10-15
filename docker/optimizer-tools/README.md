# optimizer-tools – Rechenjobs neben den Daten (NAS)

Ein kleiner Container für die NAS. Er rechnet jede Nacht drei Dinge aus den Protokollen des Node-RED-Optimierers:

1. **Training des Anlagen-Zwillings** (`tools/wp_training_nacht.py` → `tools/wp_training.js`): Parameterschätzung über die letzten 21 Tage, Güte auf den letzten 4 Tagen, Drift gegen den letzten Lauf.
2. **Replay der Entscheidungsmaschine** für den Vortag (`tools/replay_tag.js` → `tools/engine_core.js`, wie live): Status je Regel, Vorschläge, Punkte, dazu ein Abgleich Minute für Minute mit dem Live-Lauf (`decisions-*.jsonl`).
3. **Tageskennzahlen** des Vortags (`tools/kennzahlen_tag.py`): dieselben Fakten wie der Bonsai-Beobachter (Läufe, Pausen, kWh el mit +80 W und th, COP, kWh/Kh mit Komfort-Toleranz 0,3 K/30 min, Räume gegen Bänder, Abtauungen, Heizstab, Quiet-/Heizregelungs-Anteile, Entscheidungen/Punkte, Datenlücken) und die festen Regel-Befunde.

Alles ist deterministisch. Im Container läuft **kein Sprachmodell** und es gibt **kein Netz**. Bonsai auf dem PC kann die Ergebnisse lesen und kommentieren.

## Zeitplan

| Zeit (Europe/Berlin) | Schritt | Tag | Dauer N100 (geschätzt, PC × 3) |
|---|---|---|---|
| 06:40 | Training | heute (Daten bis 06:40, Test = letzte 4 Kalendertage) | 1,5 min (8 Tage Daten) … 4,5 min (21 Tage) |
| danach | Replay | gestern, Einschwingen 7 Tage | 15–20 s |
| danach | Kennzahlen | gestern | 2–4 s |
| danach | `status.json` | – | – |

Der Zeitplan steckt im Container (eigene Schleife in `ot.py`, kein cron nötig). `ZEITPLAN` nimmt auch mehrere Zeiten (`06:40,18:40`).
Nach einem Neustart holt der Dienst einen verpassten Lauf des Tages nach (`NACHHOLEN=1`).
Es läuft immer nur ein Lauf gleichzeitig (Sperrdatei `/ergebnis/.lauf.lock`, gilt auch für `docker compose run`).
Jeder Schritt hat ein Zeitlimit (Training 20 min, Replay 10 min, Kennzahlen 10 min). Danach wird er abgebrochen und als Fehler gemeldet.

## Ergebnisse (Volume `optimizer-tools_ergebnis`, im Container `/ergebnis`)

```
/ergebnis/status.json                   letzter Lauf, Güte des Trainings (Ampel), Drift, Replay-Abgleich, Kennzahlen, Datenfrische, Fehler
/ergebnis/letzter-lauf.log              Protokoll des letzten Laufs (wie stdout)
/ergebnis/training/wp_params_<tag>.json Parameter des Zwillings (120 Tage behalten)
/ergebnis/training/wp_training.md       Bericht mit Güte und Drift-Tabelle (je Lauf überschrieben)
/ergebnis/training/letzter.json         Kurzfassung des letzten Trainings (für status.json)
/ergebnis/replay/<tag>.md               Replay-Bericht des Tages (120 Tage behalten)
/ergebnis/replay/<tag>.json             Zusammenfassung: Status-Minuten, Vorschläge, Punkte, Abgleich mit live
/ergebnis/kennzahlen/<tag>.json         Fakten (Schlüssel wie im Beobachter), Läufe, Lücken, Abtauungen, Befunde
/ergebnis/kennzahlen/tage.csv           eine Zeile je Tag (aus allen <tag>.json neu gebaut)
```

Die wichtigsten Felder in `status.json`:

- `ok`: Gesamtzustand. `false`, wenn ein Schritt scheiterte oder die Daten älter als 30 min sind.
- `fehler`: Liste der Fehler. Einträge mit „Hinweis:“ (z. B. auffällige Drift) setzen `ok` nicht auf `false`.
- `letzter_lauf`: Beginn, Dauer, Speicher-Spitze und je Schritt `ok`, `rc`, `fehler`.
- `training.ampel`:
  - `gruen`: TOP16 ≤ 40 W, Wasserkreis ≤ 1,5 K und Pause-Median ≤ 30 min (Annahme, mit Abstand zu den Testwerten vom 15.10.);
  - `gelb`: eine dieser Grenzen ist überschritten;
  - `rot`: das Training ist gescheitert.
- `training.drift`: Zahl der auffälligen Parameter (> 10 % und > 0,05) gegen den vorigen Lauf.
- `replay.gleich_live_prozent`: Anteil der Minuten, in denen Replay und Live denselben Status je Regel haben.
- `dienst.naechster_lauf`.

## Bauen

Alle Werkzeuge nutzen nur Node-Builtins und die Python-Standardbibliothek. Das Image hat keine npm- oder pip-Pakete; es enthält nur `node:22-alpine`, `python3` und `tzdata`.

```sh
# im Repo (PC oder NAS), Baukontext = Wurzel des Repos (.dockerignore lässt nur die 7 Werkzeuge und ot.py durch)
docker build --build-arg OT_VERSION=$(git rev-parse --short HEAD) -f docker/optimizer-tools/Dockerfile -t optimizer-tools:1 .
```

## Start auf der NAS

Das Image wird auf dem PC gebaut und per ssh übertragen; auf die NAS kommt nur `compose.yml`:

```sh
docker save optimizer-tools:1 | gzip | ssh 10.10.10.128 'gunzip | docker load'
ssh 10.10.10.128 'mkdir -p /volume1/docker/optimizer-tools' && scp docker/optimizer-tools/compose.yml 10.10.10.128:/volume1/docker/optimizer-tools/
ssh 10.10.10.128 'cd /volume1/docker/optimizer-tools && docker compose run --rm optimizer-tools alles'   # erste Füllung (ca. 3–5 min)
ssh 10.10.10.128 'cd /volume1/docker/optimizer-tools && docker compose up -d && docker compose ps'
```

Bauen direkt auf der NAS geht auch (Docker 29.6 mit buildx 0.33): den Repo-Stand dorthin kopieren und dort `docker build …` wie oben ausführen.

### Befehle

Alle im Verzeichnis von `compose.yml`:

| Befehl | Wirkung |
|---|---|
| `docker compose up -d` | Dienst mit Zeitplan starten |
| `docker compose run --rm optimizer-tools nacht` | Lauf sofort: Training heute, Replay und Kennzahlen gestern |
| `docker compose run --rm optimizer-tools alles` | wie `nacht`, dazu Kennzahlen aller Tage und fehlende Replays (höchstens 31 Tage) |
| `docker compose run --rm optimizer-tools training` | nur Training |
| `docker compose run --rm optimizer-tools replay` | nur Replay |
| `docker compose run --rm optimizer-tools kennzahlen` | nur Kennzahlen |
| `… <befehl> --tag 2026-10-14` | für einen bestimmten Tag (bei `nacht`/`alles`: Training an diesem Tag, Replay und Kennzahlen am Vortag) |
| `docker compose run --rm optimizer-tools kennzahlen --alle` | alle Tage nachrechnen |
| `docker exec optimizer-tools python3 /app/ot.py status` | `status.json` anzeigen |
| `docker compose logs -f` | Protokoll (jede Zeile mit Zeitstempel) |

Ein `run` blockiert sich nicht mit dem laufenden Dienst; beide nutzen dieselbe Sperrdatei.
Der zweite Lauf bricht mit „ein anderer Lauf ist aktiv“ ab (rc 3).

## Volumes

| Im Container | Quelle | Modus |
|---|---|---|
| `/daten` | `/volume2/@docker/volumes/node_red_node-red-data/_data/optimizer` (Protokolle von Node-RED) | **nur lesend** |
| `/ergebnis` | benanntes Volume `optimizer-tools_ergebnis` | lesen/schreiben |
| `/tmp` | tmpfs 128 MB (Arbeitskopien des Trainings) | flüchtig |

Für Tests lässt sich der Datenordner mit `OT_DATEN=/pfad docker compose …` umbiegen.
Für die Entwicklung kann `tools/` als Volume über das eingebaute liegen: `-v "$PWD/tools:/app/tools:ro"` bei `docker run`.

## Sicherheit

- **Nur lesend:** `/daten` ist `:ro` eingehängt. Das Wurzeldateisystem ist schreibgeschützt (`read_only`). Schreibbar sind nur `/ergebnis` und `/tmp`.
- **Keine Geheimnisse:** Im Datenordner liegen `owm.json` und `vrm.json` mit Zugangsdaten (Modus 600, Besitzer uid 1000 = node-red). Drei Schutzschichten:
  1. Der Container läuft als **uid 10001**, nicht als root und nicht als uid 1000 (`node` im Basis-Image). Damit kann der Kernel diese Dateien gar nicht für ihn öffnen. Getestet mit Attrappen: `cat /daten/owm.json` scheitert.
  2. Alle Werkzeuge öffnen nur Dateinamen nach einer Allowlist: `quiet|quiet-events|optimizer-v2|energy|decisions|scores|applied|defrost-JJJJ-MM.csv/jsonl`. Andere Namen werden weder gelesen noch geloggt.
  3. `cap_drop: ALL` und `no-new-privileges`, damit kein Rechteausbau möglich ist.
- **Kein Netz:** `network_mode: none`. Es gibt keine Abrufe und kein Sprachmodell; der Lauf braucht kein Netz.
- **Grenzen:** `mem_limit 1g` (gemessen höchstens 0,48 GB), `cpus 2`, `pids_limit 64`, Log-Rotation 3 × 5 MB.
- **Nie an die Anlage:** Der Container schreibt nichts an Node-RED, MQTT oder die Wärmepumpe.

## Zugriff von außen

**Bonsai-Beobachter (PC)** liest wie bisher per ssh, nur aus diesem Container:

```sh
ssh -o BatchMode=yes 10.10.10.128 docker exec optimizer-tools cat /ergebnis/kennzahlen/2026-10-14.json
ssh -o BatchMode=yes 10.10.10.128 docker exec optimizer-tools cat /ergebnis/status.json
ssh -o BatchMode=yes 10.10.10.128 'docker exec optimizer-tools tar -C /ergebnis -cf - status.json kennzahlen training/wp_training.md replay' | tar -x -C ~/Dokumente/heishamonr-optimizer/nas-ergebnis
```

Die Schlüssel in `kennzahlen/<tag>.json` → `fakten` sind dieselben wie in `zusammenfassung()` des Beobachters. Getestet: 127 von 127 gleich.
Der Beobachter könnte diese Fakten übernehmen und Bonsai nur noch kommentieren lassen. Das ist nicht eingebaut; der Beobachter ist unverändert.

**Node-RED** kommt an `status.json`, wenn das Volume ein zweites Mal **nur lesend** in den Node-RED-Container gehängt wird. Das macht der Projektleiter nach Go:

```yaml
# compose-Datei von node_red (Ausschnitt)
services:
  node-red:
    volumes:
      - node-red-data:/data
      - optimizer-tools_ergebnis:/data/optimizer-tools:ro
volumes:
  optimizer-tools_ergebnis:
    external: true
```

Danach den Node-RED-Container neu erstellen (`docker compose up -d`).
Node-RED (uid 1000) kann die Dateien lesen (644), aber nicht ändern.
Ein `file in`-Knoten liest `/data/optimizer-tools/status.json` alle 5 min.

## Fehlersuche

| Zeichen | Ursache / Abhilfe |
|---|---|
| `status.json` → `Daten veraltet` | Node-RED schreibt `quiet-*.csv` nicht mehr, oder das Mount zeigt auf den falschen Ordner. Prüfen: `docker exec optimizer-tools ls -l /daten` |
| `Datenordner /daten fehlt` (rc 2) | Volume nicht eingehängt: Pfad in `compose.yml` prüfen |
| `quiet-JJJJ-MM.csv fehlt` | Monat ohne Protokoll (vor Beginn oder Node-RED-Ausfall) |
| `keine Minutenzeilen am …` | an diesem Tag keine Daten |
| `ein anderer Lauf ist aktiv` (rc 3) | warten, bis der laufende Lauf fertig ist (`docker compose logs`) |
| `Zeitlimit … überschritten` | NAS überlastet. Dauer in `letzter_lauf.schritte` ansehen und `TIMEOUT` in `ot.py` erhöhen |
| Container `unhealthy` | Herzschlag älter als 3 min oder `/daten` nicht lesbar: `docker inspect --format '{{json .State.Health}}' optimizer-tools` |
| Training rot | `training/wp_training.md` zeigt den Fehler im Kopf |
| `No such image: optimizer-tools:1` | Image fehlt auf der NAS: bauen oder `docker load` (siehe oben) |

## Rückbau

```sh
cd /volume1/docker/optimizer-tools
docker compose down                    # Container weg, Ergebnisse bleiben
docker volume rm optimizer-tools_ergebnis   # Ergebnisse löschen (vorher ggf. sichern)
docker image rm optimizer-tools:1
rm -r /volume1/docker/optimizer-tools
```

Falls Node-RED das Volume eingehängt hat, zuerst dort die Zeile entfernen und Node-RED neu erstellen.
An den Daten von Node-RED ändert der Rückbau nichts, denn der Container hat sie nie beschrieben.

## Test (PC)

```sh
docker/optimizer-tools/test.sh <Kopie von /data/optimizer> [<bonsai_beobachter.py>]   # LAST=0 überspringt den Lasttest
```

Das Skript prüft:

- Bau, Lauf `nacht` mit Zeit- und Speichermessung;
- Parameter bit-identisch zum PC-Lauf und Kennzahlen gleich dem Beobachter;
- Sicherheit: Attrappen von `owm.json`/`vrm.json` sind unlesbar, das Dateisystem ist nur lesend, kein Netz, uid 10001;
- Wiederholbarkeit und Drift;
- Fehlerfälle;
- den Dienst mit Zeitplan, Healthcheck und Stopp;
- `alles`;
- einen Lasttest mit 5 × 8 synthetischen Tagen (`lastdaten.py`; voller Oktober plus Monatswechsel).

Das Skript startet nur lokale Container mit denselben Einstellungen wie `compose.yml`.

# optimizer-tools – Rechenjobs neben den Daten (NAS)

Ein kleiner Container für die NAS. Er rechnet jede Nacht drei Dinge aus den Protokollen des Node-RED-Optimierers und sichert sie:

1. **Training des Anlagen-Zwillings** (`tools/wp_training_nacht.py` → `tools/wp_training.js`): Parameterschätzung über die letzten 21 Tage, Güte auf den letzten 4 Tagen, Drift gegen den letzten Lauf.
2. **Replay der Entscheidungsmaschine** für den Vortag (`tools/replay_tag.js` → `tools/engine_core.js`, wie live): Status je Regel, Vorschläge, Punkte, dazu ein Abgleich Minute für Minute mit dem Live-Lauf (`decisions-*.jsonl`).
   Eingänge sind die Eingaben, die die Live-Maschine selbst protokolliert hat (`decisions-*.jsonl` → `in`); verglichen wird nur, wo live dieselbe Regelversion lief (Abschnitt „Replay-Güte“).
3. **Tageskennzahlen** des Vortags (`tools/kennzahlen_tag.py`): dieselben Fakten wie der Bonsai-Beobachter (Läufe, Pausen, kWh el mit +80 W und th, COP, kWh/Kh mit Komfort-Toleranz 0,3 K/30 min, Räume gegen Bänder, Abtauungen, Heizstab, Quiet-/Heizregelungs-Anteile, Entscheidungen/Punkte, Datenlücken) und die festen Regel-Befunde.

4. **Sicherung der Protokolle**: tägliches `tar.gz` der Monatsdateien und Zustands-JSON (Allowlist, ohne Geheimnisse) mit Prüfsumme.

Alles ist deterministisch. Im Container läuft **kein Sprachmodell** und es gibt **kein Netz**. Bonsai auf dem PC kann die Ergebnisse lesen und kommentieren.

## Zeitplan

| Zeit (Europe/Berlin) | Schritt | Tag | Dauer N100 (geschätzt, PC × 3) |
|---|---|---|---|
| 06:40 | Training | heute (Daten bis 06:40, Test = letzte 4 Kalendertage) | 1,5 min (8 Tage Daten) … 4,5 min (21 Tage) |
| danach | Replay | gestern, Einschwingen 7 Tage (zweimal: Live-Eingänge und nur Protokolle) | 30–40 s |
| danach | Kennzahlen | gestern | 2–4 s |
| danach | Sicherung | Monatsdateien des laufenden Monats (bis zum 7. auch des Vormonats) | 1–3 s |
| danach | `status.json` | – | – |

Der Zeitplan steckt im Container (eigene Schleife in `ot.py`, kein cron nötig). `ZEITPLAN` nimmt auch mehrere Zeiten (`06:40,18:40`).
Nach einem Neustart holt der Dienst einen verpassten Lauf des Tages nach (`NACHHOLEN=1`).
Es läuft immer nur ein Lauf gleichzeitig (Sperrdatei `/ergebnis/.lauf.lock`, gilt auch für `docker compose run`).
Jeder Schritt hat ein Zeitlimit (Training 20 min, Replay, Kennzahlen und Sicherung je 10 min). Danach wird er abgebrochen und als Fehler gemeldet.

## Ergebnisse (Ordner `optimizer-tools/` im Node-RED-Datenvolume, im Container `/ergebnis`)

Auf der NAS: `/volume2/@docker/volumes/node_red_node-red-data/_data/optimizer-tools`. Node-RED sieht denselben Ordner als **`/data/optimizer-tools`**, ohne dass Node-RED neu erstellt werden muss.

```
status.json                     Zustand für Node-RED (Format unten)
letzter-lauf.log                Protokoll des letzten Laufs (wie stdout)
training/wp_params_<tag>.json   Parameter des Zwillings (120 Tage behalten)
training/wp_training.md         Bericht mit Güte und Drift-Tabelle (je Lauf überschrieben)
training/letzter.json           Kurzfassung des letzten Trainings
replay/<tag>.md                 Replay-Bericht des Tages (120 Tage behalten)
replay/<tag>.json               Zusammenfassung: Status-Minuten, Vorschläge, Punkte, Abgleich mit live, Raumfühler-Lücken
kennzahlen/<tag>.json           Fakten (Schlüssel wie im Beobachter), Läufe, Lücken, Abtauungen, Befunde
kennzahlen/tage.csv             eine Zeile je Tag (aus allen <tag>.json neu gebaut)
sicherung/daten-<tag>.tar.gz    Sicherung der Protokolle (+ .sha256), 120 Tage; Archive vom 1. eines Monats unbegrenzt
sicherung/letzte.json           Inhalt, Größe und Prüfsumme der letzten Sicherung
```

Alle Dateien haben Modus 644, die Unterordner 2755: Node-RED (uid 1000) kann alles lesen, aber nur im obersten Ordner schreiben.

## status.json (Format 2)

Wird nach jedem Lauf und beim Start des Dienstes neu geschrieben (atomar: erst `.tmp`, dann umbenennen). Ein `file in`-Knoten mit JSON-Ausgabe kann es direkt lesen.

| Feld | Inhalt |
|---|---|
| `format` | `2`; ändert sich nur, wenn Felder wegfallen oder ihre Bedeutung ändern |
| `version` | Stand des Images (Git-Kurz-Hash aus `OT_VERSION`), `werkzeug` dasselbe als Text |
| `aktualisiert` | Zeitpunkt des Schreibens (Ortszeit, `JJJJ-MM-TT HH:MM:SS`) |
| `ok` | `true`, wenn `fehler` leer ist |
| `fehler` | Liste: gescheiterte Schritte (`training: …`), Daten älter als 30 min, Datenordner nicht lesbar |
| `hinweise` | Liste, setzt `ok` nicht auf `false`: auffällige Drift, Ampel gelb, Lücken im Minutenprotokoll, Raumfühler > 120 min ungültig |
| `letzter_lauf` | `art` (nacht/alles/…), `beginn`, `ende`, **`dauer_s`**, `ok`, `speicher_spitze_mb`, `schritte.{training,replay,kennzahlen,sicherung}` je `{ok, rc, dauer_s, fehler, tag}` |
| `dienst` | `gestartet`, `zeitplan`, `naechster_lauf` |
| `training` | `tag`, `ok`, **`ampel`** (`gruen`/`gelb`/`rot`), `ampel_grenzen`, **`guete_test`** (TOP16 W, Wasserkreis K, Pause min), `guete_test_vorher`, **`drift`** `{gegen, auffaellig, liste, werte}`, `datei` |
| `replay` | `tag`, `datei`, `minuten`, `vorschlaege`, `punkte_eintraege`, **`guete`** (unten) |
| `replay.guete` | `bewertbar` (bool), `prozent` (Status gleich live über die bewertbaren Regeln; **`null`, wenn nicht bewertbar**), `grund` (warum nicht), `nicht_bewertbar` (Regel-IDs), `regeln.<id>` `{bewertbar, prozent, minuten, grund}`, `eingang_live_minuten` |
| `kennzahlen` | `tag`, Strom/Wärme kWh, COP, kWh/Kh, Abweichung 7 Tage, Komfort, Läufe, Starts, Abtauungen, Heizstab, Außen-Mittel, Befunde |
| `datenluecken` | **`frische`** (jüngste Zeile in `quiet-*.csv`, `alter_min`), **`minutenprotokoll`** (`luecken_ueber_10min`, `groesste_luecke_min`, `liste`), **`raumfuehler`** (`raeume.<id>` `{ungueltig_min, laengste_min}` am Replay-Tag) |
| `sicherung` | `tag`, `datei`, `bytes`, **`sha256`**, `dateien`, `bytes_roh`, `geprueft`, `archive`, `aeltestes`, `belegt_mb` |

Fehlt ein Teil (z. B. noch kein Training), steht dort `null`.

### Replay-Güte

`replay.guete.prozent` ist der Anteil der Minuten, in denen das Replay je Regel denselben Status hat wie live. Die Zahl ist nur dann ein sauberes Maß, wenn beide dieselben Eingaben und dieselbe Regel rechnen:

- **Eingaben:** Das Replay nimmt je Minute die Eingabe, die die Live-Maschine in `decisions-*.jsonl` protokolliert hat (`ENGINE.unsnap`). Fehlt der Datensatz oder ein Feld, kommt der Wert aus `quiet-`/`optimizer-v2-*.csv`.
  Ohne diese Live-Eingaben weichen vor allem die Räume ab, weil `optimizer-v2-*.csv` sie nur alle 5 min enthält (14.10.: Raumeinfluss 95,9 % statt 98,9 %). Diese Zahl steht zum Vergleich im Bericht („nur Protokolle“).
- **Regelversion:** Verglichen werden nur Minuten, in denen live dieselbe Regelversion lief wie im Replay. Eine Regel ist **bewertbar**, wenn mindestens 90 % ihrer Live-Minuten (und mindestens 60) vergleichbar sind; sonst steht `prozent: null` mit Grund, z. B. „live lief v2 (555 min), Replay rechnet v3“.
- **Übrige Abweichungen** mit Live-Eingaben: Zustand der Live-Maschine nach einem Neustart oder Einspielen, Freigaben/Sperren von Hand, Rundung der protokollierten Eingaben auf 0,01, Code-Änderungen ohne neue Regelversion.

Sind am Tag weniger als 90 % der Minuten mit Live-Eingabe vorhanden, ist das Replay insgesamt nicht bewertbar.
Mit `replay --eingang protokoll` rechnet das Replay nur aus den CSV-Dateien; die Güte ist dann immer „nicht bewertbar“.

## Bauen

Alle Werkzeuge nutzen nur Node-Builtins und die Python-Standardbibliothek. Das Image hat keine npm- oder pip-Pakete; es enthält nur `node:22-alpine`, `python3` und `tzdata`.

```sh
# im Repo (PC oder NAS), Baukontext = Wurzel des Repos (.dockerignore lässt nur die 7 Werkzeuge und ot.py durch)
docker build --build-arg OT_VERSION=$(git rev-parse --short HEAD) -f docker/optimizer-tools/Dockerfile -t optimizer-tools:1 .
```

## Start auf der NAS

Alles als `fl0wb0b` (uid 1000, Gruppe `docker`), **ohne sudo**. Die compose-Datei liegt in `~/optimizer-tools` (`/home/fl0wb0b/optimizer-tools` auf volume1).
Das Image wird auf dem PC gebaut und per ssh übertragen.

**Einmalig vorab:** den Ergebnisordner im Node-RED-Volume anlegen, und zwar *als node-red* über `docker exec` (kein root nötig):

```sh
ssh 10.10.10.128 "docker exec node_red-node-red-1 sh -c 'mkdir -p /data/optimizer-tools && chmod 2775 /data/optimizer-tools && ls -ld /data/optimizer-tools'"
# erwartet: drwxrwsr-x … node-red node-red … /data/optimizer-tools
```

Damit gehört der Ordner `1000:1000` mit Modus `2775`. Der Container (uid 10001, Zusatzgruppe 1000) darf dort schreiben; Node-RED liest ihn als `/data/optimizer-tools`.
Fehlt der Ordner, bricht `docker compose up` mit „bind source path does not exist“ ab (`create_host_path: false`), statt einen root-Ordner anzulegen.

**Start** (vom PC, im Repo auf Branch `nas-container`):

```sh
docker build --build-arg OT_VERSION=$(git rev-parse --short HEAD) -f docker/optimizer-tools/Dockerfile -t optimizer-tools:1 .
docker save optimizer-tools:1 | gzip | ssh 10.10.10.128 'gunzip | docker load'
ssh 10.10.10.128 'mkdir -p ~/optimizer-tools' && scp docker/optimizer-tools/compose.yml 10.10.10.128:optimizer-tools/
ssh 10.10.10.128 'cd ~/optimizer-tools && docker compose run --rm optimizer-tools alles'      # erste Füllung (ca. 4–6 min)
ssh 10.10.10.128 'cd ~/optimizer-tools && docker compose up -d && docker compose ps'
ssh 10.10.10.128 'docker exec node_red-node-red-1 cat /data/optimizer-tools/status.json | head -20'   # Sicht von Node-RED
```

Update: dieselben Schritte (Bauen, `docker load`, ggf. `scp`), dann `docker compose up -d` (erstellt den Container mit dem neuen Image neu).

**Watchtower** läuft auf der NAS für alle Container (03:00, mit Aufräumen). `compose.yml` setzt das Label `com.centurylinklabs.watchtower.enable: "false"`, damit Watchtower den Container nicht anfasst: Ein Abgleich mit Docker Hub ergäbe für das lokale Image `optimizer-tools:1` nur Fehler oder ein fremdes Image.
Kontrolle: `docker inspect -f '{{index .Config.Labels "com.centurylinklabs.watchtower.enable"}}' optimizer-tools` → `false`.

Bauen direkt auf der NAS geht auch (Docker 29.6 mit buildx 0.33): den Repo-Stand dorthin kopieren und dort `docker build …` wie oben ausführen.

### Befehle

Alle in `~/optimizer-tools`:

| Befehl | Wirkung |
|---|---|
| `docker compose up -d` | Dienst mit Zeitplan starten |
| `docker compose run --rm optimizer-tools nacht` | Lauf sofort: Training heute, Replay und Kennzahlen gestern, Sicherung |
| `docker compose run --rm optimizer-tools alles` | wie `nacht`, dazu Kennzahlen aller Tage und fehlende Replays (höchstens 31 Tage) |
| `docker compose run --rm optimizer-tools training` | nur Training |
| `docker compose run --rm optimizer-tools replay` | nur Replay |
| `docker compose run --rm optimizer-tools kennzahlen` | nur Kennzahlen |
| `docker compose run --rm optimizer-tools sicherung` | nur Sicherung der Protokolle |
| `… <befehl> --tag 2026-10-14` | für einen bestimmten Tag (bei `nacht`/`alles`: Training und Sicherung an diesem Tag, Replay und Kennzahlen am Vortag) |
| `docker compose run --rm optimizer-tools kennzahlen --alle` | alle Tage nachrechnen |
| `docker exec optimizer-tools python3 /app/ot.py status` | `status.json` anzeigen |
| `docker compose logs -f` | Protokoll (jede Zeile mit Zeitstempel) |

Ein `run` blockiert sich nicht mit dem laufenden Dienst; beide nutzen dieselbe Sperrdatei.
Der zweite Lauf bricht mit „ein anderer Lauf ist aktiv“ ab (rc 3).

## Volumes

| Im Container | Quelle (Bind-Mount) | Modus |
|---|---|---|
| `/daten` | `/volume2/@docker/volumes/node_red_node-red-data/_data/optimizer` (Protokolle von Node-RED, `/data/optimizer`) | **nur lesend** |
| `/ergebnis` | `/volume2/@docker/volumes/node_red_node-red-data/_data/optimizer-tools` (Node-RED: `/data/optimizer-tools`) | lesen/schreiben |
| `/tmp` | tmpfs 128 MB (Arbeitskopien des Trainings) | flüchtig |

Für Tests lassen sich beide Ordner mit `OT_DATEN=/pfad OT_ERGEBNIS=/pfad docker compose …` umbiegen.
Für die Entwicklung kann `tools/` als Volume über das eingebaute liegen: `-v "$PWD/tools:/app/tools:ro"` bei `docker run`.

## Sicherheit

- **Nur lesend:** `/daten` ist `:ro` eingehängt. Das Wurzeldateisystem ist schreibgeschützt (`read_only`). Schreibbar sind nur `/ergebnis` und `/tmp`.
- **Keine Geheimnisse:** Im Datenordner liegen `owm.json` und `vrm.json` mit Zugangsdaten (Modus 600, Besitzer `1000:1000` = node-red). Vier Schutzschichten:
  1. Der Container läuft als **uid 10001**, nicht als root und nicht als uid 1000. Als uid 1000 könnte er die Dateien lesen; als 10001 öffnet der Kernel sie nicht. Getestet mit Attrappen: `cat /daten/owm.json` scheitert.
  2. Die **Zusatzgruppe 1000** (für das Schreiben in `/data/optimizer-tools`) ändert daran nichts: Modus 600 gibt der Gruppe keine Rechte. Ebenfalls getestet.
  3. Die Rechenwerkzeuge öffnen nur Dateinamen nach einer Allowlist: `quiet|quiet-events|optimizer-v2|energy|decisions|scores|applied|defrost-JJJJ-MM.csv/jsonl`. Die Sicherung listet `/daten` und nimmt nur Monatsdateien (`name-JJJJ-MM.csv/jsonl`) und `name.json`; Namen mit `owm`, `vrm`, `cred`, `secret`, `token`, `passw`, `key`, `auth` sind ausgeschlossen, auch wenn sie lesbar wären. Ausgeschlossene Namen werden nur gezählt, nicht geloggt.
  4. `cap_drop: ALL` und `no-new-privileges`, damit kein Rechteausbau möglich ist.
- **Kein Netz:** `network_mode: none`. Es gibt keine Abrufe und kein Sprachmodell; der Lauf braucht kein Netz.
- **Grenzen:** `mem_limit 1g` (gemessen höchstens 0,48 GB), `cpus 2`, `pids_limit 64`, Log-Rotation 3 × 5 MB.
- **Nie an die Anlage:** Der Container schreibt nichts an Node-RED, MQTT oder die Wärmepumpe. Im Node-RED-Volume schreibt er nur unter `optimizer-tools/`.

## Sicherung und Wiederherstellung

Nach jedem Nachtlauf schreibt der Schritt `sicherung` das Archiv `/ergebnis/sicherung/daten-<tag>.tar.gz`:

- **Inhalt:** alle Monatsdateien (`*-JJJJ-MM.csv`, `*-JJJJ-MM.jsonl`) des laufenden Monats, bis zum 7. auch die des Vormonats, dazu die Zustands-JSON (`config.json`, `engine-state.json`, `plan-state.json`, …). Ohne Geheimnisse (Allowlist, siehe Sicherheit).
- **Größe:** am 15.10. 6 bis 13 Dateien, 17–21 MB roh, 0,7–1,4 MB gepackt. Am Monatsende etwa 3–4 MB je Archiv; 120 Archive also höchstens etwa 0,5 GB (volume2 hat 175 GB frei).
- **Prüfung:** Jedes Archiv wird nach dem Schreiben ganz gelesen (gzip-CRC, Namen, Längen). Die Prüfsumme steht in `daten-<tag>.tar.gz.sha256`, in `sicherung/letzte.json` und in `status.json` → `sicherung.sha256`.
- **Aufbewahrung:** 120 Tage (`SICHERUNG_TAGE`). Das Archiv vom 1. jedes Monats bleibt unbegrenzt (`SICHERUNG_MONATSERSTE=1`), denn es enthält den Vormonat vollständig.
- **Stand:** Node-RED hängt laufend an. Gesichert wird jede Datei mit der Länge beim Öffnen; die letzte Zeile kann also halb sein.
- **Ort:** Das Archiv liegt im selben Node-RED-Volume wie die Daten. Es schützt vor versehentlichem Löschen oder Überschreiben, nicht vor dem Verlust des Volumes; dafür müsste Duplicati den Ordner mitnehmen (offene Frage im Bericht).

**Wiederherstellen** (auf der NAS als `fl0wb0b`, ohne sudo):

```sh
cd ~/optimizer-tools
docker exec optimizer-tools ls -l /ergebnis/sicherung                                   # Archive ansehen
docker exec -w /ergebnis/sicherung optimizer-tools sha256sum -c daten-2026-10-15.tar.gz.sha256   # → OK
docker exec optimizer-tools tar -tzvf /ergebnis/sicherung/daten-2026-10-15.tar.gz        # Inhalt
# 1. Node-RED-Flows anhalten, die in die Datei schreiben (sonst schreibt Node-RED dazwischen), oder auf eine ruhige Minute achten.
# 2. Die kaputte Datei zur Seite legen (nichts löschen):
docker exec node_red-node-red-1 mv /data/optimizer/quiet-2026-10.csv /data/optimizer/quiet-2026-10.csv.kaputt
# 3. Datei aus dem Archiv zurückspielen, als node-red (Besitzer bleibt 1000):
docker exec node_red-node-red-1 tar -xzf /data/optimizer-tools/sicherung/daten-2026-10-15.tar.gz -C /data/optimizer quiet-2026-10.csv
docker exec node_red-node-red-1 ls -l /data/optimizer/quiet-2026-10.csv
```

Ohne Dateinamen am Ende spielt `tar` alle Dateien des Archivs zurück und überschreibt die aktuellen. Zeilen nach dem Sicherungszeitpunkt fehlen danach; sie stehen ggf. noch in der `.kaputt`-Datei.
Ein Archiv auf den PC holen: `ssh 10.10.10.128 'docker exec optimizer-tools cat /ergebnis/sicherung/daten-2026-10-15.tar.gz' > daten-2026-10-15.tar.gz`.

## Zugriff von außen

**Bonsai-Beobachter (PC)** liest wie bisher per ssh, nur aus diesem Container:

```sh
ssh -o BatchMode=yes 10.10.10.128 docker exec optimizer-tools cat /ergebnis/kennzahlen/2026-10-14.json
ssh -o BatchMode=yes 10.10.10.128 docker exec optimizer-tools cat /ergebnis/status.json
ssh -o BatchMode=yes 10.10.10.128 'docker exec optimizer-tools tar -C /ergebnis -cf - status.json kennzahlen training/wp_training.md replay' | tar -x -C ~/Dokumente/heishamonr-optimizer/nas-ergebnis
```

Die Schlüssel in `kennzahlen/<tag>.json` → `fakten` sind dieselben wie in `zusammenfassung()` des Beobachters. Getestet: 127 von 127 gleich.
Der Beobachter könnte diese Fakten übernehmen und Bonsai nur noch kommentieren lassen. Das ist nicht eingebaut; der Beobachter ist unverändert.

**Node-RED** liest `/data/optimizer-tools/status.json` direkt (gleiches Volume). Es muss nichts eingehängt und Node-RED nicht neu erstellt werden.
Ein `file in`-Knoten (Ausgabe: ein String, danach `json`) liest die Datei z. B. alle 5 min. Die Anzeige in Node-RED ist noch nicht gebaut.

## Fehlersuche

| Zeichen | Ursache / Abhilfe |
|---|---|
| `status.json` → `Daten veraltet` | Node-RED schreibt `quiet-*.csv` nicht mehr, oder das Mount zeigt auf den falschen Ordner. Prüfen: `docker exec optimizer-tools ls -l /daten` |
| `Datenordner /daten fehlt` (rc 2) | Volume nicht eingehängt: Pfad in `compose.yml` prüfen |
| `quiet-JJJJ-MM.csv fehlt` | Monat ohne Protokoll (vor Beginn oder Node-RED-Ausfall) |
| `keine Minutenzeilen am …` | an diesem Tag keine Daten |
| `ein anderer Lauf ist aktiv` (rc 3) | warten, bis der laufende Lauf fertig ist (`docker compose logs`) |
| `Ergebnisordner /ergebnis nicht schreibbar` (rc 4) | Ordner fehlt oder gehört root: einmalig `docker exec node_red-node-red-1 sh -c 'mkdir -p /data/optimizer-tools && chmod 2775 /data/optimizer-tools'`; gehört er root (von Docker angelegt), braucht es einmal root: `chown 1000:1000` und `chmod 2775` |
| `bind source path does not exist` beim `up` | Ergebnisordner noch nicht angelegt (siehe Start) |
| `Sicherung: …` in `fehler` | Archiv nicht geschrieben oder Prüfung gescheitert; `letzter-lauf.log` ansehen, Platz auf volume2 prüfen |
| `Zeitlimit … überschritten` | NAS überlastet. Dauer in `letzter_lauf.schritte` ansehen und `TIMEOUT` in `ot.py` erhöhen |
| Container `unhealthy` | Herzschlag älter als 3 min, `/daten` nicht lesbar oder `/ergebnis` nicht schreibbar: `docker inspect --format '{{json .State.Health}}' optimizer-tools` |
| Training rot | `training/wp_training.md` zeigt den Fehler im Kopf |
| `No such image: optimizer-tools:1` | Image fehlt auf der NAS: bauen oder `docker load` (siehe oben) |

## Rückbau

```sh
cd ~/optimizer-tools
docker compose down                                         # Container weg, Ergebnisse bleiben in /data/optimizer-tools
# Ergebnisse und Sicherungen löschen (vorher ggf. sichern): die Dateien gehören uid 10001, also mit dem Image selbst
docker compose run --rm --entrypoint sh optimizer-tools -c 'rm -rf /ergebnis/* /ergebnis/.[!.]*'
docker exec node_red-node-red-1 rmdir /data/optimizer-tools
docker image rm optimizer-tools:1
rm -r ~/optimizer-tools
```

An den Daten von Node-RED ändert der Rückbau nichts: Der Container hat nur unter `optimizer-tools/` geschrieben.

## Test (PC)

```sh
docker/optimizer-tools/test.sh <Kopie von /data/optimizer> [<bonsai_beobachter.py>]   # LAST=0 überspringt den Lasttest
```

Das Skript prüft:

- Bau, Lauf `nacht` mit Zeit- und Speichermessung;
- Parameter bit-identisch zum PC-Lauf und Kennzahlen gleich dem Beobachter;
- Ergebnisordner wie auf der NAS (2775, `1000:1000`, Container mit Zusatzgruppe 1000); die Ergebnisse werden als uid 1000 gelesen (Sicht von Node-RED);
- Sicherheit: Attrappen von `owm.json`/`vrm.json` sind trotz Gruppe 1000 unlesbar, das Dateisystem ist nur lesend, kein Netz, uid 10001;
- Sicherung: Prüfsumme (`sha256sum -c` und in `status.json`), keine Geheimnisse im Archiv (auch nicht eine lesbare `owm-alt.json`), Wiederherstellung bit-identisch, Aufbewahrung (130 Tage alt gelöscht, Monatserster behalten);
- `status.json` Format 2: Pflichtfelder, Replay-Güte nur mit Grund „nicht bewertbar“;
- Wiederholbarkeit und Drift;
- Fehlerfälle, auch ein nicht schreibbarer Ergebnisordner (rc 4 mit Anleitung);
- den Dienst mit Zeitplan, Healthcheck und Stopp;
- `alles`;
- einen Lasttest mit 5 × 8 synthetischen Tagen (`lastdaten.py`; voller Oktober plus Monatswechsel).

Das Skript startet nur lokale Container mit denselben Einstellungen wie `compose.yml`.

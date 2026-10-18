#!/usr/bin/env bash
# Lokaler Test von optimizer-tools (PC, nicht auf der NAS): Image bauen, mit einer Datenkopie als /daten laufen lassen, prüfen.
#   docker/optimizer-tools/test.sh <Datenordner> [<beobachter.py>]
# Datenordner: Kopie von /data/optimizer (z. B. replay_data_1510). Enthält er owm.json/vrm.json, wird nur eine gefilterte Kopie
# (Allowlist) verwendet. Für die Geheimnis-Prüfung legt das Skript in der Testkopie eigene Attrappen owm.json/vrm.json (Modus 600) an.
# Startet Container nur lokal (docker run mit denselben Einstellungen wie compose.yml), räumt Kopie und Ergebnisordner am Ende auf.
# /ergebnis ist wie auf der NAS ein Ordner mit 2775, Besitzer 1000:1000 (= /data/optimizer-tools im Node-RED-Volume); der Test liest die
# Ergebnisse als uid 1000 direkt vom Host (Sicht von Node-RED). Voraussetzung: der Testbenutzer hat uid/gid 1000 (wie node-red).
set -uo pipefail
export LC_ALL=C.UTF-8 LC_NUMERIC=C
sek() { awk -v a="$1" -v b="$(date +%s%N)" 'BEGIN{printf "%.1f", (b-a)/1e9}'; }   # Sekunden seit $1 (date +%s%N)

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HIER/../.." && pwd)"
QUELLE="${1:?Datenordner angeben}"
BEOBACHTER="${2:-$HOME/Dokumente/bonsai/beobachter/bonsai_beobachter.py}"
BILD="${BILD:-optimizer-tools:test}"
TAG_TRAINING="${TAG_TRAINING:-2026-10-15}"          # Training wie der PC-Lauf; Replay/Kennzahlen = Vortag
TAG_VOR="$(date -d "$TAG_TRAINING -1 day" +%F)"
ARBEIT="$(mktemp -d "${TMPDIR:-/tmp}/ot-test.XXXXXX")"
ERG="$ARBEIT/nodered-data/optimizer-tools"          # wie /volume2/@docker/volumes/node_red_node-red-data/_data/optimizer-tools
FEHLER=0
ok()   { echo "  OK    $*"; }
nein() { echo "  FEHLER $*"; FEHLER=$((FEHLER + 1)); }
leere_ergebnis() {   # Dateien des Containers (uid 10001) im Ergebnisordner löschen und den Ordner wie auf der NAS neu anlegen
  [ -d "$ERG" ] && docker run --rm --user 10001:10001 --group-add 1000 -v "$ERG:/e" --entrypoint sh "$BILD" -c 'rm -rf /e/* /e/.[!.]*' >/dev/null 2>&1
  rm -rf "$ERG"; mkdir -p "$ERG"; chmod 2775 "$ERG"
}
aufraeumen() { docker rm -f ot-test-dienst >/dev/null 2>&1; leere_ergebnis; rm -rf "$ARBEIT"; }
trap aufraeumen EXIT

setze_lauf() {   # Einstellungen wie compose.yml (ohne Neustart-Regel); $1 = Datenordner für /daten
  LAUF=(docker run --rm --init --network none --read-only --tmpfs /tmp:size=128m,mode=1777 --user 10001:10001 --group-add 1000 --cap-drop ALL
        --security-opt no-new-privileges:true --memory 1g --memory-swap 1g --cpus 2 --pids-limit 64 -e TZ=Europe/Berlin
        -v "$1:/daten:ro" -v "$ERG:/ergebnis")
}
setze_lauf "$ARBEIT/daten"

echo "== 1. Image bauen"
t0=$(date +%s%N)
docker build -q --build-arg OT_VERSION=test -f "$REPO/docker/optimizer-tools/Dockerfile" -t "$BILD" "$REPO" >/dev/null || { echo "Bau fehlgeschlagen"; exit 1; }
echo "  Bauzeit $(sek $t0) s, Größe $(docker image inspect -f '{{.Size}}' "$BILD" | awk '{printf "%.0f MB", $1/1e6}')"

echo "== 2. Testdaten (Allowlist-Kopie, Attrappen für Geheimnisse)"
mkdir -p "$ARBEIT/daten"
for f in "$QUELLE"/*; do
  b="$(basename "$f")"
  if [[ "$b" =~ ^(quiet|quiet-events|optimizer-v2|energy|decisions|scores|applied|defrost)-[0-9]{4}-[0-9]{2}\.(csv|jsonl)$ ]]; then cp "$f" "$ARBEIT/daten/"; fi
done
[ -e "$QUELLE/owm.json" ] || [ -e "$QUELLE/vrm.json" ] && echo "  Quelle enthält owm.json/vrm.json: NICHT übernommen" || echo "  Quelle ohne owm.json/vrm.json"
[ -f "$QUELLE/config.json" ] && cp "$QUELLE/config.json" "$ARBEIT/daten/"     # Zustands-JSON ohne Geheimnisse (für die Sicherung)
echo '{"key":"ATTRAPPE-GEHEIM-OWM"}' > "$ARBEIT/daten/owm.json"; chmod 600 "$ARBEIT/daten/owm.json"
echo '{"key":"ATTRAPPE-GEHEIM-KOPIE"}' > "$ARBEIT/daten/owm-alt.json"; chmod 644 "$ARBEIT/daten/owm-alt.json"   # lesbar, aber Name auf der Sperrliste der Sicherung
echo '{"token":"ATTRAPPE-GEHEIM-VRM"}' > "$ARBEIT/daten/vrm.json"; chmod 600 "$ARBEIT/daten/vrm.json"
chmod 755 "$ARBEIT" "$ARBEIT/daten"; chmod 644 "$ARBEIT"/daten/*-*.csv "$ARBEIT"/daten/*-*.jsonl "$ARBEIT"/daten/config.json 2>/dev/null
echo "  $(ls "$ARBEIT/daten" | wc -l) Dateien, Besitzer uid $(stat -c %u "$ARBEIT/daten/owm.json") (wie node-red auf der NAS: 1000)"

# messlauf <logdatei> <befehl …>: Lauf im Testcontainer mit Zeit- und Speichermessung (docker stats alle 0,5 s und cgroup memory.peak)
messlauf() {
  local log="$1"; shift
  local st="$log.stats"; : > "$st"
  local t0; t0=$(date +%s%N)
  "${LAUF[@]}" --name ot-test-mess "$BILD" "$@" > "$log" 2>&1 &
  local pid=$!
  while kill -0 $pid 2>/dev/null; do docker stats --no-stream --format '{{.MemUsage}}' ot-test-mess >> "$st" 2>/dev/null; sleep 0.5; done
  wait $pid; RC=$?
  DAUER=$(sek $t0)
  SPITZE=$(awk '{v=$1; u=v; gsub(/[0-9.]/,"",u); gsub(/[^0-9.]/,"",v); f=(u=="GiB")?1024:(u=="KiB"?1/1024:1); m=v*f; if(m>x)x=m} END{printf "%.0f", x}' "$st")
  CGSPITZE=$(grep -o 'Speicher-Spitze des Containers [0-9]* MB' "$log" | tail -1 | grep -o '[0-9]*' | tail -1)
  echo "  Laufzeit $DAUER s (N100 geschätzt ×3: $(awk -v d="$DAUER" 'BEGIN{printf "%.0f", d*3}') s), Speicher-Spitze cgroup ${CGSPITZE:-?} MB, docker stats ${SPITZE} MiB ($(wc -l < "$st") Proben)"
  awk -v d="$DAUER" 'BEGIN{exit !(d*3 < 600)}' && ok "Laufzeit ×3 < 10 min" || nein "Laufzeit ×3 ≥ 10 min"
  local TR; TR=$(grep -o '\[training\] Ende: ok nach [0-9.]* s' "$log" | grep -o '[0-9.]* s$' | tr -d ' s')
  [ -n "$TR" ] && { awk -v d="$TR" 'BEGIN{exit !(d*3 < 180)}' && ok "Training $TR s, ×3 < 3 min (training-v2)" || nein "Training $TR s, ×3 ≥ 3 min"; }
  [ "${CGSPITZE:-${SPITZE:-0}}" -lt 1024 ] && ok "Speicher < 1 GB" || nein "Speicher ≥ 1 GB"
}

echo "== 3. Lauf „nacht“ (Training $TAG_TRAINING, Replay/Kennzahlen $TAG_VOR) mit Speichermessung"
[ "$(id -u):$(id -g)" = "1000:1000" ] || echo "  WARNUNG: Testbenutzer ist nicht 1000:1000; die Node-RED-Sicht wird nur angenähert"
leere_ergebnis
echo "  Ergebnisordner wie auf der NAS: $(stat -c '%A %u:%g' "$ERG")"
messlauf "$ARBEIT/nacht.log" nacht --tag "$TAG_TRAINING"
sed 's/^/    /' "$ARBEIT/nacht.log" | tail -25
[ $RC -eq 0 ] && ok "nacht rc 0" || nein "nacht rc $RC"

echo "  Ergebnisse (gelesen als uid $(id -u), wie Node-RED):"; (cd "$ERG" && find . -type f | sort | sed 's/^/    /')

echo "== 4. Parameter bit-identisch zum PC-Lauf"
PC="$ARBEIT/pc"; mkdir -p "$PC"
if command -v node >/dev/null && python3 "$REPO/tools/wp_training_nacht.py" --quelle "$ARBEIT/daten" --tag "$TAG_TRAINING" --ausgabe "$PC" >/dev/null 2>&1; then
  a=$(sha256sum < "$PC/wp_params_$TAG_TRAINING.json" | cut -c1-16); b=$(sha256sum < "$ERG/training/wp_params_$TAG_TRAINING.json" | cut -c1-16)
  [ "$a" = "$b" ] && ok "wp_params_$TAG_TRAINING.json identisch (sha256 $a…, PC node $(node --version), Container $(docker run --rm --entrypoint node "$BILD" --version))" || nein "wp_params verschieden: PC $a, Container $b"
else
  echo "  (übersprungen: node/python3 auf dem PC fehlt)"
fi

echo "== 5. Kennzahlen gegen den Bonsai-Beobachter (gleiche Fakten?)"
if [ -f "$BEOBACHTER" ]; then
  if PYTHONDONTWRITEBYTECODE=1 python3 "$HIER/vergleich_beobachter.py" "$BEOBACHTER" "$ARBEIT/daten" "$ERG" "$TAG_VOR" | sed 's/^/    /'; then ok "Fakten $TAG_VOR identisch"; else nein "Fakten weichen ab"; fi
else
  echo "  (übersprungen: $BEOBACHTER fehlt)"
fi

echo "== 6. Sicherheit"
"${LAUF[@]}" --entrypoint sh "$BILD" -c 'cat /daten/owm.json' >/dev/null 2>&1 && nein "owm.json im Container lesbar" || ok "owm.json (600, uid 1000) im Container nicht lesbar"
"${LAUF[@]}" --entrypoint sh "$BILD" -c 'cat /daten/vrm.json' >/dev/null 2>&1 && nein "vrm.json im Container lesbar" || ok "vrm.json nicht lesbar"
"${LAUF[@]}" --entrypoint sh "$BILD" -c 'touch /daten/x' >/dev/null 2>&1 && nein "/daten schreibbar" || ok "/daten nur lesend"
"${LAUF[@]}" --entrypoint sh "$BILD" -c 'touch /app/x' >/dev/null 2>&1 && nein "Wurzeldateisystem schreibbar" || ok "Wurzeldateisystem nur lesend"
[ "$("${LAUF[@]}" --entrypoint id "$BILD" -u)" = "10001" ] && ok "läuft als uid 10001" || nein "uid nicht 10001"
[ "$("${LAUF[@]}" --entrypoint sh "$BILD" -c 'ls /sys/class/net | tr "\n" " "')" = "lo " ] && ok "kein Netz (nur lo)" || nein "Netz vorhanden"
grep -rl -E "ATTRAPPE|owm\.json|vrm\.json" "$ERG" "$ARBEIT/nacht.log" >/dev/null && nein "Geheimnis-Attrappe oder Dateiname in Ergebnissen/Log" || ok "keine Spur von owm.json/vrm.json in Ergebnissen und Log"

"${LAUF[@]}" --entrypoint id "$BILD" -G | grep -qw 1000 && ok "Gruppe 1000 (node-red) gesetzt, trotzdem owm.json/vrm.json (600) unlesbar" || nein "Gruppe 1000 fehlt"

echo "== 6b. Sicherung der Protokolle"
SICH="$ERG/sicherung/daten-$TAG_TRAINING.tar.gz"
if [ -f "$SICH" ]; then
  (cd "$ERG/sicherung" && sha256sum -c --quiet "daten-$TAG_TRAINING.tar.gz.sha256") && ok "Prüfsumme stimmt (sha256sum -c)" || nein "Prüfsumme falsch"
  python3 -c "import json,sys; s=json.load(open('$ERG/status.json')); h=open('$SICH.sha256').read().split()[0]; sys.exit(0 if s['sicherung']['sha256']==h else 1)" && ok "Prüfsumme in status.json = .sha256" || nein "Prüfsumme in status.json fehlt/falsch"
  tar -tzf "$SICH" > "$ARBEIT/sich.lst"
  echo "  $(wc -l < "$ARBEIT/sich.lst") Dateien, $(du -k "$SICH" | cut -f1) kB gepackt: $(tr '\n' ' ' < "$ARBEIT/sich.lst")"
  grep -qE "owm|vrm" "$ARBEIT/sich.lst" && nein "Geheimnis-Datei im Archiv" || ok "owm.json, vrm.json, owm-alt.json nicht im Archiv"
  zcat "$SICH" | grep -q ATTRAPPE && nein "Attrappen-Inhalt im Archiv" || ok "kein Attrappen-Inhalt im Archiv"
  grep -qx "config.json" "$ARBEIT/sich.lst" && grep -qx "quiet-${TAG_TRAINING:0:7}.csv" "$ARBEIT/sich.lst" && ok "config.json und Monatsdateien im Archiv" || nein "Archiv unvollständig"
  W="$ARBEIT/wieder"; mkdir -p "$W"; tar -xzf "$SICH" -C "$W" quiet-${TAG_TRAINING:0:7}.csv && cmp -s "$W/quiet-${TAG_TRAINING:0:7}.csv" "$ARBEIT/daten/quiet-${TAG_TRAINING:0:7}.csv" && ok "Wiederherstellung einer Datei bit-identisch" || nein "Wiederherstellung weicht ab"
  # Aufbewahrung: Attrappen-Archive 130 Tage alt (gewöhnlicher Tag und Monatserster), dann Sicherung erneut
  ALT="$(date -d "$TAG_TRAINING -130 days" +%F)"; ERSTER="$(date -d "$TAG_TRAINING -130 days" +%Y-%m)-01"
  "${LAUF[@]}" --entrypoint sh "$BILD" -c "cd /ergebnis/sicherung && echo x > daten-$ALT.tar.gz && echo x > daten-$ALT.tar.gz.sha256 && echo x > daten-$ERSTER.tar.gz"
  "${LAUF[@]}" "$BILD" sicherung --tag "$TAG_TRAINING" > "$ARBEIT/sich2.log" 2>&1
  [ ! -e "$ERG/sicherung/daten-$ALT.tar.gz" ] && [ ! -e "$ERG/sicherung/daten-$ALT.tar.gz.sha256" ] && [ -e "$ERG/sicherung/daten-$ERSTER.tar.gz" ] \
    && ok "Aufbewahrung: $ALT gelöscht, Monatserster $ERSTER behalten" || nein "Aufbewahrung falsch ($(ls "$ERG/sicherung" | tr '\n' ' '))"
  "${LAUF[@]}" --entrypoint rm "$BILD" -f "/ergebnis/sicherung/daten-$ERSTER.tar.gz"
else
  nein "kein Archiv $SICH"
fi

echo "== 6c. Sicht von Node-RED (uid 1000) und status.json (Format 2)"
cat "$ERG/status.json" > /dev/null && ok "status.json als uid $(id -u) lesbar ($(stat -c '%A %u' "$ERG/status.json"))" || nein "status.json nicht lesbar"
python3 - "$ERG/status.json" <<'PY' && ok "status.json: Pflichtfelder vorhanden, Replay-Güte nur bewertbar mit Grund" || nein "status.json unvollständig"
import json, sys
s = json.load(open(sys.argv[1]))
fehlt = [k for k in ("format", "version", "aktualisiert", "ok", "fehler", "hinweise", "letzter_lauf", "training", "replay", "kennzahlen", "datenluecken", "sicherung") if k not in s]
fehlt += [k for k in ("dauer_s", "beginn", "schritte") if k not in (s.get("letzter_lauf") or {})]
fehlt += [k for k in ("ampel", "guete_test", "drift") if k not in (s.get("training") or {})]
fehlt += [k for k in ("frische", "minutenprotokoll", "raumfuehler") if k not in (s.get("datenluecken") or {})]
g = (s.get("replay") or {}).get("guete") or {}
print("    format %s, version %s, Lauf %s s, Ampel %s, Drift auffällig %s, Lücken %s, Replay-Güte %s %s, nicht bewertbar: %s" % (
    s.get("format"), s.get("version"), (s.get("letzter_lauf") or {}).get("dauer_s"), (s.get("training") or {}).get("ampel"),
    ((s.get("training") or {}).get("drift") or {}).get("auffaellig"), ((s.get("datenluecken") or {}).get("minutenprotokoll") or {}).get("luecken_ueber_10min"),
    g.get("prozent"), "(bewertbar)" if g.get("bewertbar") else "(nicht bewertbar: %s)" % g.get("grund"), g.get("nicht_bewertbar")))
for rid, r in (g.get("regeln") or {}).items():
    if not r["bewertbar"] and (r["prozent"] is not None or not r["grund"]):
        fehlt.append("regel " + rid)
if g.get("bewertbar") is None or (not g.get("bewertbar") and (g.get("prozent") is not None or not g.get("grund"))):
    fehlt.append("guete")
if fehlt:
    print("    fehlt: %s" % fehlt)
sys.exit(1 if fehlt else 0)
PY

echo "== 7. Wiederholbarkeit und Drift"
cp "$ERG/kennzahlen/$TAG_VOR.json" "$ARBEIT/k1.json"
"${LAUF[@]}" "$BILD" nacht --tag "$(date -d "$TAG_TRAINING +1 day" +%F)" > "$ARBEIT/nacht2.log" 2>&1; RC2=$?
"${LAUF[@]}" "$BILD" kennzahlen --tag "$TAG_VOR" > /dev/null 2>&1
cmp -s "$ARBEIT/k1.json" "$ERG/kennzahlen/$TAG_VOR.json" && ok "Kennzahlen $TAG_VOR beim zweiten Lauf bit-identisch" || nein "Kennzahlen nicht wiederholbar"
grep -q "Parameterdrift gegen $TAG_TRAINING" "$ERG/training/wp_training.md" && ok "Drift-Tabelle gegen $TAG_TRAINING (rc $RC2, auffällig: $(python3 -c "import json;print(json.load(open('$ERG/training/letzter.json'))['drift']['auffaellig'])"))" || nein "keine Drift-Tabelle"
# training-v2: Champion gegen Herausforderer, Güte je Band, Abdeckung in status.json (additive Felder)
python3 - "$ERG" "$TAG_TRAINING" <<'PY' && ok "training-v2: Entscheidung mit beiden Sätzen, aktiver Satz, Güte je Band (5), Abdeckung in status.json" || nein "training-v2: Felder fehlen"
import json, os, sys
erg, tag = sys.argv[1], sys.argv[2]
s = json.load(open(os.path.join(erg, "status.json"))); t = s["training"]; e = t["entscheidung"]
akt = os.path.join(erg, "training", "wp_params_aktiv.json")
assert e["ergebnis"] in ("übernommen", "abgelehnt") and e["bisher_tag"] == tag and e["kandidat"] and e["bisher"], e
assert os.path.exists(os.path.join(erg, "training", e["kandidat_datei"])) and os.path.exists(akt), e
assert t["datei"] == "training/" + e["aktiv"] and len(t["guete_je_band"]) == 5 and t["abdeckung"]["baender"], t["datei"]
print("    Entscheidung %s (%s), aktiv %s, Bindung %s" % (e["ergebnis"], e["grund"], e["aktiv"], (t.get("glaettung") or {}).get("bindung", {}).get("aktiv")))
PY

echo "== 8. Fehlerfälle"
"${LAUF[@]}" "$BILD" kennzahlen --tag 2026-09-30 > "$ARBEIT/f1.log" 2>&1; R=$?
[ $R -ne 0 ] && grep -q "quiet-2026-09.csv fehlt" "$ARBEIT/f1.log" && ok "fehlender Monat: rc $R, Meldung „quiet-2026-09.csv fehlt“" || nein "fehlender Monat nicht sauber abgebrochen (rc $R)"
python3 -c "import json,sys; s=json.load(sys.stdin); print('    status.json ok=%s fehler=%s' % (s['ok'], s['fehler']))" < "$ERG/status.json"
docker run --rm --network none --read-only --user 10001:10001 --group-add 1000 -v "$ERG:/ergebnis" "$BILD" nacht > "$ARBEIT/f2.log" 2>&1; R=$?
[ $R -eq 2 ] && grep -q "Datenordner /daten fehlt" "$ARBEIT/f2.log" && ok "ohne /daten: rc 2, sauberer Abbruch" || nein "ohne /daten: rc $R"
docker run --rm --network none --user 10001:10001 --group-add 1000 -v "$ERG:/ergebnis" -v "$ARBEIT/daten:/daten:ro" "$BILD" replay --tag 2026-10-01 > "$ARBEIT/f3.log" 2>&1; R=$?
[ $R -ne 0 ] && grep -q "keine Minutenzeilen" "$ARBEIT/f3.log" && ok "Tag ohne Daten: rc $R, „keine Minutenzeilen“" || nein "Tag ohne Daten: rc $R"

NW="$ARBEIT/nicht-schreibbar"; mkdir -p "$NW"; chmod 755 "$NW"      # wie ein von Docker als root angelegter Ordner: Container darf nicht schreiben
docker run --rm --network none --user 10001:10001 --group-add 1000 -v "$NW:/ergebnis" -v "$ARBEIT/daten:/daten:ro" "$BILD" nacht > "$ARBEIT/f4.log" 2>&1; R=$?
[ $R -eq 4 ] && grep -q "mkdir -p /data/optimizer-tools" "$ARBEIT/f4.log" && ok "Ergebnisordner nicht schreibbar: rc 4 mit Anleitung" || nein "nicht schreibbarer Ergebnisordner: rc $R"

echo "== 9. Dienst: Zeitplan, Healthcheck, Stopp"
ZP="$(date -d '+1 min' +%H:%M)"
docker run -d --name ot-test-dienst --init --network none --read-only --tmpfs /tmp:size=128m,mode=1777 --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 1g --cpus 2 --health-interval 5s --health-start-period 2s \
  -e ZEITPLAN="$ZP" -e NACHHOLEN=0 --group-add 1000 -v "$ARBEIT/daten:/daten:ro" -v "$ERG:/ergebnis" "$BILD" >/dev/null
for i in $(seq 1 60); do docker logs ot-test-dienst 2>&1 | grep -q "Lauf „nacht“ fertig" && break; sleep 3; done
docker logs ot-test-dienst 2>&1 | grep -E "\[dienst\]|fertig" | sed 's/^/    /'
docker logs ot-test-dienst 2>&1 | grep -q "Lauf „nacht“ fertig" && ok "Lauf um $ZP aus dem Zeitplan" || nein "kein Lauf aus dem Zeitplan"
[ "$(docker inspect -f '{{.State.Health.Status}}' ot-test-dienst)" = "healthy" ] && ok "Healthcheck healthy" || nein "Healthcheck $(docker inspect -f '{{.State.Health.Status}}' ot-test-dienst)"
t0=$(date +%s%N); docker stop -t 10 ot-test-dienst >/dev/null; S=$(sek $t0); docker logs ot-test-dienst 2>&1 | tail -1 | sed "s/^/    /"; docker rm -f ot-test-dienst >/dev/null
awk -v s="$S" 'BEGIN{exit !(s < 5)}' && ok "docker stop in $S s (Signal wird behandelt)" || nein "docker stop dauerte $S s"

echo "== 10. „alles“ (Erstinstallation: alle Kennzahlen, fehlende Replays)"
t0=$(date +%s%N)
"${LAUF[@]}" "$BILD" alles --tag "$TAG_TRAINING" > "$ARBEIT/alles.log" 2>&1; R=$?
D=$(sek $t0)
echo "  rc $R, $D s, Kennzahlen-Tage $(($(wc -l < "$ERG/kennzahlen/tage.csv") - 1)), Replay-Tage $(ls "$ERG/replay" | grep -c '\.md$')"
[ $R -eq 0 ] && ok "alles rc 0" || nein "alles rc $R"

if [ "${LAST:-1}" = "1" ]; then
  echo "== 11. Lasttest: 5 × 8 Tage synthetisch (07.10.–16.11.: voller Oktober + halber November, Monatswechsel)"
  mkdir -p "$ARBEIT/last"
  python3 "$HIER/lastdaten.py" "$ARBEIT/daten" "$ARBEIT/last" | sed 's/^/    /'
  chmod 755 "$ARBEIT/last"; chmod 644 "$ARBEIT"/last/*
  leere_ergebnis
  setze_lauf "$ARBEIT/last"
  echo "  a) nacht am 01.11. (Replay/Kennzahlen 31.10., voller Oktober)"
  messlauf "$ARBEIT/last1.log" nacht --tag 2026-11-01
  grep -E "\[(training|replay|kennzahlen|sicherung)\] Ende|Sicherung daten|fertig in" "$ARBEIT/last1.log" | sed 's/^/    /'
  [ $RC -eq 0 ] && ok "nacht 01.11. rc 0" || nein "nacht 01.11. rc $RC"
  echo "  b) nacht am 16.11. (Training über den Monatswechsel, Replay 15.11. mit Einschwingen aus dem Oktober)"
  messlauf "$ARBEIT/last2.log" nacht --tag 2026-11-16
  grep -E "\[(training|replay|kennzahlen|sicherung)\] Ende|Sicherung daten|fertig in" "$ARBEIT/last2.log" | sed 's/^/    /'
  [ $RC -eq 0 ] && ok "nacht 16.11. rc 0" || nein "nacht 16.11. rc $RC"
fi

echo
[ $FEHLER -eq 0 ] && echo "ALLE PRÜFUNGEN BESTANDEN" || echo "$FEHLER PRÜFUNG(EN) FEHLGESCHLAGEN"
exit $FEHLER

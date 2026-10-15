#!/usr/bin/env bash
# Lokaler Test von optimizer-tools (PC, nicht auf der NAS): Image bauen, mit einer Datenkopie als /daten laufen lassen, prüfen.
#   docker/optimizer-tools/test.sh <Datenordner> [<beobachter.py>]
# Datenordner: Kopie von /data/optimizer (z. B. replay_data_1510). Enthält er owm.json/vrm.json, wird nur eine gefilterte Kopie
# (Allowlist) verwendet. Für die Geheimnis-Prüfung legt das Skript in der Testkopie eigene Attrappen owm.json/vrm.json (Modus 600) an.
# Startet Container nur lokal (docker run mit denselben Einstellungen wie compose.yml), räumt Volume und Kopie am Ende auf.
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
VOL="ot-test-ergebnis-$$"
FEHLER=0
ok()   { echo "  OK    $*"; }
nein() { echo "  FEHLER $*"; FEHLER=$((FEHLER + 1)); }
aufraeumen() { docker rm -f ot-test-dienst >/dev/null 2>&1; docker volume rm -f "$VOL" >/dev/null 2>&1; rm -rf "$ARBEIT"; }
trap aufraeumen EXIT

setze_lauf() {   # Einstellungen wie compose.yml (ohne Neustart-Regel); $1 = Datenordner für /daten
  LAUF=(docker run --rm --init --network none --read-only --tmpfs /tmp:size=128m,mode=1777 --user 10001:10001 --cap-drop ALL
        --security-opt no-new-privileges:true --memory 1g --memory-swap 1g --cpus 2 --pids-limit 64 -e TZ=Europe/Berlin
        -v "$1:/daten:ro" -v "$VOL:/ergebnis")
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
echo '{"key":"ATTRAPPE-GEHEIM-OWM"}' > "$ARBEIT/daten/owm.json"; chmod 600 "$ARBEIT/daten/owm.json"
echo '{"token":"ATTRAPPE-GEHEIM-VRM"}' > "$ARBEIT/daten/vrm.json"; chmod 600 "$ARBEIT/daten/vrm.json"
chmod 755 "$ARBEIT" "$ARBEIT/daten"; chmod 644 "$ARBEIT"/daten/*-*.csv "$ARBEIT"/daten/*-*.jsonl 2>/dev/null
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
  [ "${CGSPITZE:-${SPITZE:-0}}" -lt 1024 ] && ok "Speicher < 1 GB" || nein "Speicher ≥ 1 GB"
}

echo "== 3. Lauf „nacht“ (Training $TAG_TRAINING, Replay/Kennzahlen $TAG_VOR) mit Speichermessung"
docker volume create "$VOL" >/dev/null
messlauf "$ARBEIT/nacht.log" nacht --tag "$TAG_TRAINING"
sed 's/^/    /' "$ARBEIT/nacht.log" | tail -25
[ $RC -eq 0 ] && ok "nacht rc 0" || nein "nacht rc $RC"

ERG="$ARBEIT/ergebnis"; mkdir -p "$ERG"
docker run --rm -v "$VOL:/e:ro" --entrypoint tar "$BILD" -C /e -cf - . | tar -x -C "$ERG"
echo "  Ergebnisse:"; (cd "$ERG" && find . -type f | sort | sed 's/^/    /')

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

echo "== 7. Wiederholbarkeit und Drift"
cp "$ERG/kennzahlen/$TAG_VOR.json" "$ARBEIT/k1.json"
"${LAUF[@]}" "$BILD" nacht --tag "$(date -d "$TAG_TRAINING +1 day" +%F)" > "$ARBEIT/nacht2.log" 2>&1; RC2=$?
"${LAUF[@]}" "$BILD" kennzahlen --tag "$TAG_VOR" > /dev/null 2>&1
rm -rf "$ERG"; mkdir -p "$ERG"; docker run --rm -v "$VOL:/e:ro" --entrypoint tar "$BILD" -C /e -cf - . | tar -x -C "$ERG"
cmp -s "$ARBEIT/k1.json" "$ERG/kennzahlen/$TAG_VOR.json" && ok "Kennzahlen $TAG_VOR beim zweiten Lauf bit-identisch" || nein "Kennzahlen nicht wiederholbar"
grep -q "Parameterdrift gegen $TAG_TRAINING" "$ERG/training/wp_training.md" && ok "Drift-Tabelle gegen $TAG_TRAINING (rc $RC2, auffällig: $(python3 -c "import json;print(json.load(open('$ERG/training/letzter.json'))['drift']['auffaellig'])"))" || nein "keine Drift-Tabelle"

echo "== 8. Fehlerfälle"
"${LAUF[@]}" "$BILD" kennzahlen --tag 2026-09-30 > "$ARBEIT/f1.log" 2>&1; R=$?
[ $R -ne 0 ] && grep -q "quiet-2026-09.csv fehlt" "$ARBEIT/f1.log" && ok "fehlender Monat: rc $R, Meldung „quiet-2026-09.csv fehlt“" || nein "fehlender Monat nicht sauber abgebrochen (rc $R)"
docker run --rm -v "$VOL:/e:ro" --entrypoint cat "$BILD" /e/status.json | python3 -c "import json,sys; s=json.load(sys.stdin); print('    status.json ok=%s fehler=%s' % (s['ok'], s['fehler']))"
docker run --rm --network none --read-only --user 10001:10001 -v "$VOL:/ergebnis" "$BILD" nacht > "$ARBEIT/f2.log" 2>&1; R=$?
[ $R -eq 2 ] && grep -q "Datenordner /daten fehlt" "$ARBEIT/f2.log" && ok "ohne /daten: rc 2, sauberer Abbruch" || nein "ohne /daten: rc $R"
docker run --rm --network none --user 10001:10001 -v "$VOL:/ergebnis" -v "$ARBEIT/daten:/daten:ro" "$BILD" replay --tag 2026-10-01 > "$ARBEIT/f3.log" 2>&1; R=$?
[ $R -ne 0 ] && grep -q "keine Minutenzeilen" "$ARBEIT/f3.log" && ok "Tag ohne Daten: rc $R, „keine Minutenzeilen“" || nein "Tag ohne Daten: rc $R"

echo "== 9. Dienst: Zeitplan, Healthcheck, Stopp"
ZP="$(date -d '+1 min' +%H:%M)"
docker run -d --name ot-test-dienst --init --network none --read-only --tmpfs /tmp:size=128m,mode=1777 --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 1g --cpus 2 --health-interval 5s --health-start-period 2s \
  -e ZEITPLAN="$ZP" -e NACHHOLEN=0 -v "$ARBEIT/daten:/daten:ro" -v "$VOL:/ergebnis" "$BILD" >/dev/null
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
rm -rf "$ERG"; mkdir -p "$ERG"; docker run --rm -v "$VOL:/e:ro" --entrypoint tar "$BILD" -C /e -cf - . | tar -x -C "$ERG"
echo "  rc $R, $D s, Kennzahlen-Tage $(($(wc -l < "$ERG/kennzahlen/tage.csv") - 1)), Replay-Tage $(ls "$ERG/replay" | grep -c '\.md$')"
[ $R -eq 0 ] && ok "alles rc 0" || nein "alles rc $R"

if [ "${LAST:-1}" = "1" ]; then
  echo "== 11. Lasttest: 5 × 8 Tage synthetisch (07.10.–16.11.: voller Oktober + halber November, Monatswechsel)"
  mkdir -p "$ARBEIT/last"
  python3 "$HIER/lastdaten.py" "$ARBEIT/daten" "$ARBEIT/last" | sed 's/^/    /'
  chmod 755 "$ARBEIT/last"; chmod 644 "$ARBEIT"/last/*
  docker volume rm -f "$VOL" >/dev/null; docker volume create "$VOL" >/dev/null
  setze_lauf "$ARBEIT/last"
  echo "  a) nacht am 01.11. (Replay/Kennzahlen 31.10., voller Oktober)"
  messlauf "$ARBEIT/last1.log" nacht --tag 2026-11-01
  grep -E "\[(training|replay|kennzahlen)\] Ende|fertig in" "$ARBEIT/last1.log" | sed 's/^/    /'
  [ $RC -eq 0 ] && ok "nacht 01.11. rc 0" || nein "nacht 01.11. rc $RC"
  echo "  b) nacht am 16.11. (Training über den Monatswechsel, Replay 15.11. mit Einschwingen aus dem Oktober)"
  messlauf "$ARBEIT/last2.log" nacht --tag 2026-11-16
  grep -E "\[(training|replay|kennzahlen)\] Ende|fertig in" "$ARBEIT/last2.log" | sed 's/^/    /'
  [ $RC -eq 0 ] && ok "nacht 16.11. rc 0" || nein "nacht 16.11. rc $RC"
fi

echo
[ $FEHLER -eq 0 ] && echo "ALLE PRÜFUNGEN BESTANDEN" || echo "$FEHLER PRÜFUNG(EN) FEHLGESCHLAGEN"
exit $FEHLER

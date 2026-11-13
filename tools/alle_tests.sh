#!/bin/sh
# Alle Tests und Simulationen in tools/ (dazu docker/optimizer-tools/ot_test.py) nacheinander, mit einer Zeile je Test und einer Summe.
#
#   sh tools/alle_tests.sh [flows.json] [Datenordner]
#
#   flows.json    Flow-Liste (Knoten als JSON-Liste): Live-Export oder Ausgabe des Generators. Ohne sie werden die Tests übersprungen,
#                 die eine Flow-Datei brauchen (Liste unten, Gruppe B). Für den Stand wie beim Deploy:
#                 python3 tools/optimizer_phase1.py <Kopie.json> --uebernahme-knoten-aktiv  und  UEBERNAHME_KNOTEN_AKTIV=1 sh tools/alle_tests.sh <Kopie.json>
#   Datenordner   Kopie von /data/optimizer (optional): Zwilling, Training und Fahrplan rechnen dann zusätzlich auf echten Daten.
#
# Gruppe A   ohne Eingabe:       Zwilling, Training, Nacht-Hülle, Kennzahlen, Gesundheit, cop_eta, evcc, Fahrplan, Wetter, lokale Konfiguration,
#                                NAS-Deploy, Privat-Prüfung, ui_system_patch, Maschine (engine_sim), cop_ziel_sim, optimizer-tools (ot_test)
# Gruppe B1  braucht flows.json: kern_chain_sim, cop_idle_test, heating_control_test (lesen die Kern-Knoten direkt aus dem Export)
# Gruppe B2  braucht flows.json: optimizer_sim, engine_sim, wx_core_test, cop_ziel_sim. Sie prüfen die Optimierer-Knoten des Generators; das Skript
#                                lässt dafür tools/optimizer_phase1.py auf einer Kopie der Datei laufen (GEN_ARGS, Standard --uebernahme-knoten-aktiv
#                                wie beim Deploy; braucht lokal.json). Ein roher Live-Export reicht für optimizer_sim nicht (ohne Zugangsdaten-Platzhalter).
# Gruppe C   Einmal-Tests:       ui_kompakt_test, tabs_zusammen_test, ui_optik_test, ui_kern_b_test, uebersicht_doppelwerte_test, radiator_pause_sim,
#                                radiator_dauer_an_sim, ui_system_patch_test (Teil Live-Export). Erledigt: Sie brauchen einen Flow-Export VOR dem
#                                jeweiligen Patch und enden auf dem Live-Stand mit Rückgabewert 3 (tools/einmal_test.py).
# Keine Tests (nicht aufgerufen): takt_sim.js, vorausschau_backtest.js, *_analyse.js, engine_replay.js (Auswertungen auf Protokollen).
#
# Rückgabe: 0 = kein Test fehlgeschlagen, 1 = mindestens einer. Übersprungene (fehlende Eingabe, Einmal-Test) zählen nicht als Fehler.
# Schreibt nur in ein temporäres Verzeichnis. EINZELN=<Namensteil> lässt nur passende Tests laufen.
HIER="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HIER/.." && pwd)"
FLOWS="${1:-}"
DATEN="${2:-}"
[ -n "$FLOWS" ] && FLOWS="$(cd "$(dirname "$FLOWS")" && pwd)/$(basename "$FLOWS")"
[ -n "$DATEN" ] && DATEN="$(cd "$DATEN" && pwd)"
LOG="$(mktemp -d "${TMPDIR:-/tmp}/alle-tests.XXXXXX")"
trap 'rm -rf "$LOG"' EXIT
OK=0; FAIL=0; SKIP=0; FEHLER=""
cd "$HIER" || exit 2

# lauf <Name> <Befehl …>: Rückgabewert 0 und keine Zeile „<n> FAIL“ mit n > 0 = bestanden; 3 = erledigter Einmal-Test
lauf() {
  name="$1"; shift
  case "$name" in *"${EINZELN:-}"*) ;; *) return ;; esac
  t0=$(date +%s)
  "$@" > "$LOG/aus.txt" 2>&1; rc=$?
  dauer=$(( $(date +%s) - t0 ))
  letzte="$(grep -v '^[[:space:]]*$' "$LOG/aus.txt" | tail -1 | cut -c1-110)"
  if [ $rc -eq 3 ]; then
    SKIP=$((SKIP + 1)); printf '  ERLEDIGT %-34s %s\n' "$name" "Einmal-Test, braucht einen Export vor dem Patch"
  elif [ $rc -ne 0 ] || grep -Eq '(^|[^0-9])[1-9][0-9]* (FAIL|FEHLER)([^a-zA-Z]|$)|FEHLGESCHLAGEN' "$LOG/aus.txt"; then
    FAIL=$((FAIL + 1)); FEHLER="$FEHLER $name"; printf '  FEHLER   %-34s rc %s, %s s | %s\n' "$name" "$rc" "$dauer" "$letzte"
    cp "$LOG/aus.txt" "$LOG/fehler_$(echo "$name" | tr ' /' '__').txt"
  else
    OK=$((OK + 1)); printf '  OK       %-34s %3s s | %s\n' "$name" "$dauer" "$letzte"
  fi
}
ohne() { case "$1" in *"${EINZELN:-}"*) SKIP=$((SKIP + 1)); printf '  OHNE     %-34s %s\n' "$1" "$2" ;; esac; }

echo "== A  ohne Eingabe${DATEN:+ (mit Daten aus $DATEN)}"
lauf wp_zwilling_test          node wp_zwilling_test.js $DATEN
lauf wp_training_test          node wp_training_test.js $DATEN
lauf wp_training_nacht_test    python3 wp_training_nacht_test.py
lauf kennzahlen_tag_test       python3 kennzahlen_tag_test.py
lauf gesundheit_tag_test       python3 gesundheit_tag_test.py
lauf cop_eta_test              node cop_eta_test.js
lauf evcc_core_test            node evcc_core_test.js
lauf plan_algo_test            node plan_algo_test.js $DATEN
lauf wx_core_test              node wx_core_test.js
lauf lokal_test                python3 lokal_test.py
lauf nas_deploy_test           python3 nas_deploy_test.py
lauf privat_test               python3 privat_test.py
lauf ui_system_patch_test      python3 ui_system_patch_test.py
lauf engine_sim                node engine_sim.js
lauf cop_ziel_sim              node cop_ziel_sim.js
lauf ot_test                   python3 "$REPO/docker/optimizer-tools/ot_test.py"

# Flow-Datei vorbereiten: Liste der Knoten (auch aus dem v2-Format {"flows": [...]}) und eine Kopie mit frischer Generator-Ausgabe wie beim Deploy
LIVE=""; GEN=""; GEN_GRUND="keine Flow-Datei angegeben"
if [ -n "$FLOWS" ] && [ -f "$FLOWS" ]; then
  if python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); d=d.get("flows") if isinstance(d,dict) else d; assert isinstance(d,list); json.dump(d,open(sys.argv[2],"w",encoding="utf-8"),ensure_ascii=False)' "$FLOWS" "$LOG/live.json" 2>/dev/null; then
    LIVE="$LOG/live.json"
    cp "$LIVE" "$LOG/gen.json"
    GEN_ARGS="${GEN_ARGS---uebernahme-knoten-aktiv}"          # wie deploy_opt.sh auf der Anlage; GEN_ARGS= (leer) für den Stand ohne aktiven Sendeknoten
    case "$GEN_ARGS" in *uebernahme-knoten-aktiv*) UEBERNAHME_KNOTEN_AKTIV=1; export UEBERNAHME_KNOTEN_AKTIV ;; esac
    if python3 optimizer_phase1.py "$LOG/gen.json" $GEN_ARGS > "$LOG/gen.txt" 2>&1; then GEN="$LOG/gen.json"; else GEN_GRUND="Generator fehlgeschlagen ($(tail -1 "$LOG/gen.txt" | cut -c1-90))"; fi
  else
    GEN_GRUND="$FLOWS ist keine Flow-Liste"
  fi
fi

echo "== B1 braucht eine Flow-Datei: Kern-Knoten aus dem Export${LIVE:+ ($FLOWS)}"
if [ -n "$LIVE" ]; then
  lauf "kern_chain_sim (Flows)"       node kern_chain_sim.js "$LIVE"
  lauf "cop_idle_test (Flows)"        node cop_idle_test.js "$LIVE"
  lauf "heating_control_test (Flows)" node heating_control_test.js "$LIVE"
else
  for t in kern_chain_sim cop_idle_test heating_control_test; do ohne "$t (Flows)" "übersprungen: $GEN_GRUND"; done
fi

echo "== B2 braucht eine Flow-Datei: Optimierer-Knoten aus frischer Generator-Ausgabe auf der Kopie${GEN:+ (optimizer_phase1.py $GEN_ARGS)}"
if [ -n "$GEN" ]; then
  lauf "optimizer_sim (Generator)"    node optimizer_sim.js "$GEN"
  lauf "engine_sim (Generator)"       node engine_sim.js "$GEN"
  lauf "wx_core_test (Generator)"     node wx_core_test.js "$GEN"
  lauf "cop_ziel_sim (Generator)"     node cop_ziel_sim.js "$GEN"
else
  for t in optimizer_sim engine_sim wx_core_test cop_ziel_sim; do ohne "$t (Generator)" "übersprungen: $GEN_GRUND"; done
fi

echo "== C  erledigte Einmal-Tests (brauchen einen Flow-Export vor dem jeweiligen Patch)"
if [ -n "$LIVE" ]; then
  for t in ui_kompakt_test tabs_zusammen_test ui_optik_test ui_kern_b_test uebersicht_doppelwerte_test; do lauf "$t" python3 "$t.py" "$LIVE"; done
  lauf radiator_pause_sim            node radiator_pause_sim.js "$LIVE"
  lauf radiator_dauer_an_sim         node radiator_dauer_an_sim.js "$LIVE"
  lauf "ui_system_patch_test (Live)" python3 ui_system_patch_test.py "$FLOWS"
else
  for t in ui_kompakt_test tabs_zusammen_test ui_optik_test ui_kern_b_test uebersicht_doppelwerte_test radiator_pause_sim radiator_dauer_an_sim "ui_system_patch_test (Live)"; do
    ohne "$t" "Einmal-Test, übersprungen: $GEN_GRUND"
  done
fi

echo
echo "ERGEBNIS alle_tests: $OK bestanden, $FAIL fehlgeschlagen, $SKIP übersprungen (ohne Eingabe oder erledigter Einmal-Test)"
if [ $FAIL -gt 0 ]; then
  echo "Fehlgeschlagen:$FEHLER"
  for f in "$LOG"/fehler_*.txt; do echo "--- $(basename "$f" .txt | sed 's/^fehler_//')"; grep -E 'FAIL|FEHLER|Error|rror:' "$f" | head -8 | cut -c1-300; done
  exit 1
fi
exit 0

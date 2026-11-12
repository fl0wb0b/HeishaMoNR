#!/bin/sh
# Spielt eine gepatchte Flow-Datei (v2-Format mit rev) in das Node-RED auf der NAS (Host "nas" aus lokal.json, Port 1880) ein,
# nur geaenderte Knoten (Deployment-Type nodes), mit rev-Pruefung gegen den aktuellen Stand. Nutzung: nas_deploy.sh <gepatchte.json>
set -e
curl() { command curl --fail-with-body "$@"; }   # lehnt Node-RED ab (HTTP 4xx/5xx, z. B. rev-Konflikt), endet das Skript mit Fehler statt mit 0
NAS=$(python3 "$(dirname "$0")/lokal.py" nas) || exit 1   # Abbruch mit Meldung, wenn lokal.json fehlt
URL="http://$NAS:1880/flows"
F="$1"; [ -f "$F" ] || { echo "Datei fehlt: $F"; exit 1; }
REV_FILE=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['rev'])" "$F")
REV_LIVE=$(curl -s -m 15 -H 'Node-RED-API-Version: v2' "$URL" | python3 -I -c "import json,sys; print(json.load(sys.stdin)['rev'])")
if [ "$REV_FILE" != "$REV_LIVE" ]; then echo "rev weicht ab (Datei $REV_FILE, live $REV_LIVE) - Export neu holen"; exit 2; fi
curl -s -m 30 -X POST "$URL" -H 'Content-Type: application/json' -H 'Node-RED-API-Version: v2' -H 'Node-RED-Deployment-Type: nodes' --data-binary @"$F"
echo

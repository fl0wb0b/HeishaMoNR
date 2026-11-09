#!/usr/bin/env python3
"""Installationswerte (Broker-Hosts, Raumfuehler-Topics) aus lokal.json im Wurzelordner des Repos. lokal.json ist nicht versioniert
(.gitignore); Vorlage: lokal.example.json. Anderer Pfad: Umgebungsvariable HEISHAMONR_LOKAL. Ohne gueltige Datei bricht jedes Werkzeug,
das die Werte braucht, mit einer Meldung ab; es gibt keine eingebauten Ersatzwerte.
Aufruf als Skript (fuer Shell-Skripte): python3 tools/lokal.py <schluessel>   -> gibt den Wert aus"""
import json
import os
import re
import sys

PFAD = os.environ.get("HEISHAMONR_LOKAL") or os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "lokal.json")
HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*$")   # Hostname oder IPv4; landet in ssh-Argumenten und URLs, daher nie mit "-" beginnend


def lade():
    try:
        with open(PFAD, encoding="utf-8") as f:
            L = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit("Lokale Konfiguration %s: %s. lokal.example.json nach lokal.json kopieren und ausfuellen oder HEISHAMONR_LOKAL auf die "
                 "Datei setzen." % (os.path.normpath(PFAD), e.strerror if isinstance(e, OSError) else "kein gueltiges JSON (%s)" % e))
    if not isinstance(L, dict):
        sys.exit("%s: muss ein JSON-Objekt sein (siehe lokal.example.json)" % os.path.normpath(PFAD))
    for k in ("venus", "nas"):
        if not isinstance(L.get(k), str) or not HOST.match(L[k]):
            sys.exit("%s: \"%s\" fehlt oder ist kein Hostname bzw. keine IP" % (os.path.normpath(PFAD), k))
    rt = L.get("raum_topics", {})
    if not isinstance(rt, dict) or not all(isinstance(v, str) and v.strip() for v in rt.values()):
        sys.exit("%s: \"raum_topics\" muss ein Objekt {Raum-ID: Topic} mit nicht leeren Texten sein" % os.path.normpath(PFAD))
    return L


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 tools/lokal.py <schluessel>")
    print(lade()[sys.argv[1]])

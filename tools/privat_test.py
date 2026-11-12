#!/usr/bin/env python3
"""Keine Installationswerte im Repo-Baum (versionierte Dateien, nicht die Historie):
- immer: keine private IPv4-Adresse (10/8, 172.16/12, 192.168/16) in einer versionierten Textdatei
- zusaetzlich: kein Wort aus der lokalen Pruefliste ("nicht_im_repo" in lokal.json bzw. HEISHAMONR_LOKAL, oder kommagetrennt in
  HEISHAMONR_NICHT_IM_REPO), z. B. Geraetenamen aus MQTT-Topics. Die Liste selbst steht nie im Repo; ohne sie wird dieser Teil uebersprungen.
Usage: python3 tools/privat_test.py"""
import json
import os
import re
import subprocess
import sys

WURZEL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIVAT_IP = re.compile(rb"(?<![\d.])(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?![\d.])")


def pruefliste():
    """Woerter aus HEISHAMONR_NICHT_IM_REPO und lokal.json. Fehlt die Standarddatei lokal.json, bleibt es bei der Variablen;
    eine ausdruecklich (HEISHAMONR_LOKAL) genannte Datei muss lesbar sein, und nicht_im_repo muss eine Liste von Texten sein."""
    w = [x for x in os.environ.get("HEISHAMONR_NICHT_IM_REPO", "").split(",") if x.strip()]
    genannt = os.environ.get("HEISHAMONR_LOKAL")
    pfad = genannt or os.path.join(WURZEL, "lokal.json")
    try:
        with open(pfad, encoding="utf-8") as f:
            L = json.load(f)
    except FileNotFoundError:
        if genannt:
            sys.exit("HEISHAMONR_LOKAL: %s fehlt" % pfad)
        L = {}
    except (OSError, ValueError) as e:
        sys.exit("%s nicht lesbar: %s" % (pfad, e))
    liste = L.get("nicht_im_repo", []) if isinstance(L, dict) else None
    if not isinstance(liste, list) or not all(isinstance(x, str) for x in liste):
        sys.exit("%s: \"nicht_im_repo\" muss eine Liste von Texten sein" % pfad)
    return sorted({x.strip().casefold() for x in w + liste if x.strip()})


def wort_muster(woerter):
    """Ganzes Wort (Nachbarn keine Buchstaben/Ziffern), fuer casefold-Text; Umlaute wie ASCII."""
    return re.compile(r"(?<![^\W_])(?:" + "|".join(re.escape(w.casefold()) for w in woerter) + r")(?![^\W_])")


def main():
    dateien = [d for d in subprocess.run(["git", "ls-files", "-z"], cwd=WURZEL, capture_output=True, check=True).stdout.decode().split("\0") if d]
    woerter = pruefliste()
    wort_re = wort_muster(woerter) if woerter else None
    ip_treffer, wort_treffer = [], []
    for d in dateien:
        with open(os.path.join(WURZEL, d), "rb") as f:
            daten = f.read()
        if b"\0" in daten[:8192]:                                    # Binaerdatei (Bild)
            continue
        if PRIVAT_IP.search(daten):
            ip_treffer.append(d)
        if wort_re and wort_re.search(daten.decode("utf-8", "replace").casefold()):
            wort_treffer.append(d)
    fehler = 0
    for name, treffer, aktiv in (("private IPv4-Adresse", ip_treffer, True), ("Wort aus der lokalen Pruefliste", wort_treffer, bool(woerter))):
        if not aktiv:
            print("SKIP %s: keine lokale Pruefliste (lokal.json \"nicht_im_repo\" oder HEISHAMONR_NICHT_IM_REPO)" % name)
            continue
        print("%s %s in %d versionierten Dateien%s" % ("OK  " if not treffer else "FAIL", name, len(treffer), (": " + ", ".join(treffer)) if treffer else ""))
        fehler += bool(treffer)
    print("\nERGEBNIS privat_test: %d von %d Dateien geprueft, %d FAIL" % (len(dateien), len(dateien), fehler))
    return 1 if fehler else 0


if __name__ == "__main__":
    sys.exit(main())

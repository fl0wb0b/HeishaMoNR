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
    w = [x for x in os.environ.get("HEISHAMONR_NICHT_IM_REPO", "").split(",") if x.strip()]
    pfad = os.environ.get("HEISHAMONR_LOKAL") or os.path.join(WURZEL, "lokal.json")
    try:
        with open(pfad, encoding="utf-8") as f:
            w += json.load(f).get("nicht_im_repo") or []
    except (OSError, ValueError):
        pass
    return sorted({x.strip().lower() for x in w if x.strip()})


def main():
    dateien = [d for d in subprocess.run(["git", "ls-files", "-z"], cwd=WURZEL, capture_output=True, check=True).stdout.decode().split("\0") if d]
    woerter = pruefliste()
    wort_re = re.compile(rb"(?<![a-z0-9])(?:" + b"|".join(re.escape(w.encode()) for w in woerter) + rb")(?![a-z0-9])") if woerter else None
    ip_treffer, wort_treffer = [], []
    for d in dateien:
        with open(os.path.join(WURZEL, d), "rb") as f:
            daten = f.read()
        if b"\0" in daten[:8192]:                                    # Binaerdatei (Bild)
            continue
        if PRIVAT_IP.search(daten):
            ip_treffer.append(d)
        if wort_re and wort_re.search(daten.lower()):
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

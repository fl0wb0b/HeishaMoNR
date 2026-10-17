#!/usr/bin/env python3
"""Testhilfe: synthetische Lastdaten für den Speicher-/Laufzeittest (Monatsende, Monatswechsel).

Nimmt aus einem Protokollordner die Zeilen eines festen Fensters von N Tagen und hängt sie K-mal hintereinander
(Zeitstempel um k·N Tage verschoben, Ortszeit), aufgeteilt in Monatsdateien. Nur Protokolldateien nach Allowlist.
  python3 lastdaten.py <quelle> <ziel> [--von 2026-10-07T17:00] [--tage 8] [--kopien 5]
Ergebnis z. B. 07.10.–16.11.: ein voller Oktober und halber November (größter Fall für Replay und Kennzahlen).
"""
import argparse
import datetime as dt
import os
import re

MUSTER = re.compile(r"^(quiet|quiet-events|optimizer-v2|energy|decisions|scores|applied|defrost)-\d{4}-\d{2}\.(csv|jsonl)$")
ZEIT = re.compile(r'^(\{"t":")?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("quelle")
    ap.add_argument("ziel")
    ap.add_argument("--von", default="2026-10-07T17:00")
    ap.add_argument("--tage", type=int, default=8)
    ap.add_argument("--kopien", type=int, default=5)
    a = ap.parse_args()
    von = dt.datetime.fromisoformat(a.von)
    bis = von + dt.timedelta(days=a.tage)
    os.makedirs(a.ziel, exist_ok=True)
    for f in sorted(os.listdir(a.quelle)):
        if not MUSTER.match(f):
            continue
        praefix, endung = f.rsplit("-", 2)[0], f.rsplit(".", 1)[1]
        with open(os.path.join(a.quelle, f), encoding="utf-8", errors="replace") as fh:
            zeilen = fh.read().split("\n")
        aus = {}                                        # Monat -> [Zeilen], letzte geschriebene Kopfzeile je Monat
        kopf_je = {}
        for k in range(a.kopien):
            kopf = None
            for l in zeilen:
                if not l:
                    continue
                if l.startswith("zeit,"):
                    kopf = l
                    continue
                m = ZEIT.match(l)
                if not m:
                    continue
                t = dt.datetime.strptime(m.group(2), "%Y-%m-%d %H:%M:%S")
                if not von <= t < bis:
                    continue
                t2 = t + dt.timedelta(days=k * a.tage)
                neu = l.replace(m.group(2), t2.strftime("%Y-%m-%d %H:%M:%S"), 1)
                mo = t2.strftime("%Y-%m")
                if endung == "csv" and kopf and kopf_je.get(mo) != kopf:
                    aus.setdefault(mo, []).append(kopf)
                    kopf_je[mo] = kopf
                aus.setdefault(mo, []).append(neu)
        for mo, z in aus.items():
            with open(os.path.join(a.ziel, "%s-%s.%s" % (praefix, mo, endung)), "w", encoding="utf-8") as fh:
                fh.write("\n".join(z) + "\n")
    for f in sorted(os.listdir(a.ziel)):
        print("%-34s %8.1f MB" % (f, os.path.getsize(os.path.join(a.ziel, f)) / 1e6))


if __name__ == "__main__":
    main()

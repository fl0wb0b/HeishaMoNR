#!/usr/bin/env python3
"""Testhilfe (nur PC): vergleicht <ergebnis>/kennzahlen/<tag>.json mit den Fakten, die der Bonsai-Beobachter selbst rechnet.

Der Beobachter wird nur importiert und ohne Sprachmodell aufgerufen (lauf(..., frag=None)); seine Berichtsdateien landen in
einem temporären Ordner, die Datei des Beobachters wird nicht verändert (PYTHONDONTWRITEBYTECODE).

  python3 docker/optimizer-tools/vergleich_beobachter.py <beobachter.py> <datenordner> <ergebnisordner> <tag> [<tag> ...]
Ausgang 0, wenn alle Schlüssel gleich sind (Ausnahme: Messaufgabe, siehe unten), sonst 1.
"""
import datetime as dt
import importlib.util
import json
import os
import shutil
import sys
import tempfile

sys.dont_write_bytecode = True


def main():
    if len(sys.argv) < 5:
        print(__doc__)
        return 2
    pfad, daten, ergebnis, tage = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
    spec = importlib.util.spec_from_file_location("beobachter_kopie", pfad)
    B = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(B)
    tmp = tempfile.mkdtemp(prefix="beob_")
    schlecht = 0
    try:
        # Vorgeschichte für den 7-Tage-Vergleich wie im Container: alle Tage aufsteigend rechnen
        for t in tage:
            tag = dt.date.fromisoformat(t)
            r = B.lauf(B.OrdnerQuelle(daten), tag, tmp, frag=None, quelle_txt="Vergleich")
            Fb = r["fakten"]
            with open(os.path.join(ergebnis, "kennzahlen", t + ".json"), encoding="utf-8") as f:
                Fk = json.load(f)["fakten"]
            # JSON kennt keine Tupel/Datumswerte: beide Seiten über JSON normalisieren
            Fb = json.loads(json.dumps(Fb, default=str))
            diff = []
            for k in sorted(set(Fb) | set(Fk)):
                if Fb.get(k) != Fk.get(k):
                    diff.append((k, Fb.get(k), Fk.get(k)))
            gleich = len(set(Fb) | set(Fk)) - len(diff)
            print("%s: %d Schlüssel gleich, %d verschieden" % (t, gleich, len(diff)))
            for k, a, b in diff:
                print("   %s: Beobachter %r, Container %r" % (k, a, b))
            schlecht += len(diff)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 1 if schlecht else 0


if __name__ == "__main__":
    sys.exit(main())

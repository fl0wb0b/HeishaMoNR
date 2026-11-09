#!/usr/bin/env python3
"""Pruefungen fuer ot.py ohne Container und ohne echte Werkzeuge (Schritte sind Attrappen, Ordner temporaer).
Usage: python3 docker/optimizer-tools/ot_test.py"""
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import unittest

T = tempfile.mkdtemp()
os.environ.update(OT_DATEN=os.path.join(T, "daten"), OT_ERGEBNIS=os.path.join(T, "ergebnis"), OT_HERZSCHLAG=os.path.join(T, "herz"))
os.makedirs(os.environ["OT_DATEN"])
os.makedirs(os.environ["OT_ERGEBNIS"])
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ot  # noqa: E402


class Lauf(unittest.TestCase):
    def test_alles_meldet_fehler_nachgeholter_replays(self):
        # „alles“ holt fehlende Replays nach; scheitert einer davon, darf der Lauf nicht als ok gelten
        open(os.path.join(ot.DATEN, "quiet-2026-10.csv"), "w").close()

        def schritt(name, cmd):
            tag = cmd[cmd.index("--tag") + 1]
            return (False, 1, 0.0, "Fehler: kaputt") if (name, tag) == ("replay", "2026-10-17") else (True, 0, 0.0, None)
        alt, ot.schritt = ot.schritt, schritt
        try:
            rc = ot.lauf("alles", ["--tag", "2026-10-20"])
        finally:
            ot.schritt = alt
        S = json.load(open(os.path.join(ot.ERGEBNIS, "status.json"), encoding="utf-8"))
        self.assertEqual(rc, 1)
        self.assertFalse(S["letzter_lauf"]["ok"])


class Nachholen(unittest.TestCase):
    def test_nur_nachtlauf_zaehlt(self):
        # ein manueller Teilschritt von heute (z. B. replay) ersetzt den verpassten Nachtlauf nicht
        heute = dt.date(2026, 10, 20)
        self.assertTrue(ot.heute_gelaufen({"art": "nacht", "beginn": "2026-10-20 06:40:00"}, heute))
        self.assertTrue(ot.heute_gelaufen({"art": "alles", "beginn": "2026-10-20 09:00:00"}, heute))
        self.assertFalse(ot.heute_gelaufen({"art": "replay", "beginn": "2026-10-20 08:00:00"}, heute))
        self.assertFalse(ot.heute_gelaufen({"art": "nacht", "beginn": "2026-10-19 06:40:00"}, heute))
        self.assertFalse(ot.heute_gelaufen({}, heute))


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(T, ignore_errors=True)

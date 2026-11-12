#!/usr/bin/env python3
"""Pruefungen fuer ot.py ohne Container und ohne echte Werkzeuge (Schritte sind Attrappen, Ordner temporaer).
Usage: python3 docker/optimizer-tools/ot_test.py"""
import datetime as dt
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
        S = ot.lies_json(os.path.join(ot.ERGEBNIS, "status.json"))
        self.assertEqual(rc, 1)
        self.assertFalse(S["letzter_lauf"]["ok"])


class Nachholen(unittest.TestCase):
    def test_nur_nachtlauf_zaehlt(self):
        # ein manueller Teilschritt von heute (z. B. replay) ersetzt den verpassten Nachtlauf nicht (status.json ohne letzter_nachtlauf: Altbestand)
        heute = dt.date(2026, 10, 20)
        self.assertTrue(ot.heute_gelaufen({"letzter_lauf": {"art": "nacht", "beginn": "2026-10-20 06:40:00"}}, heute))
        self.assertTrue(ot.heute_gelaufen({"letzter_lauf": {"art": "alles", "beginn": "2026-10-20 09:00:00"}}, heute))
        self.assertFalse(ot.heute_gelaufen({"letzter_lauf": {"art": "replay", "beginn": "2026-10-20 08:00:00"}}, heute))
        self.assertFalse(ot.heute_gelaufen({"letzter_lauf": {"art": "nacht", "beginn": "2026-10-19 06:40:00"}}, heute))
        self.assertFalse(ot.heute_gelaufen({}, heute))

    def test_nachtlauf_bleibt_nach_teilschritt_sichtbar(self):
        # nacht um 06:40, danach ein manuelles replay: nach einem Neustart darf nacht nicht ein zweites Mal laufen
        ot.baue_status(lauf={"art": "nacht", "beginn": "2026-10-20 06:40:00", "ok": True})
        ot.baue_status(lauf={"art": "replay", "beginn": "2026-10-20 08:00:00", "ok": True})
        S = ot.lies_json(os.path.join(ot.ERGEBNIS, "status.json"))
        self.assertEqual(S["letzter_lauf"]["art"], "replay")
        self.assertTrue(ot.heute_gelaufen(S, dt.date(2026, 10, 20)))

    def test_altbestand_uebernimmt_nachtlauf(self):
        # status.json von vor letzter_nachtlauf (heutiger nacht-Lauf nur in letzter_lauf), dann ein replay: nacht bleibt erkannt
        ot.schreibe_atomar(os.path.join(ot.ERGEBNIS, "status.json"), '{"letzter_lauf": {"art": "nacht", "beginn": "2026-10-21 06:40:00", "ok": true}}')
        ot.baue_status(lauf={"art": "replay", "beginn": "2026-10-21 08:00:00", "ok": True})
        S = ot.lies_json(os.path.join(ot.ERGEBNIS, "status.json"))
        self.assertTrue(ot.heute_gelaufen(S, dt.date(2026, 10, 21)))


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(T, ignore_errors=True)

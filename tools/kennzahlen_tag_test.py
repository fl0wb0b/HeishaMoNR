#!/usr/bin/env python3
"""Tests fuer tools/kennzahlen_tag.py: Randfaelle, die frueher den ganzen Lauf abbrachen.
Usage: python3 tools/kennzahlen_tag_test.py"""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kennzahlen_tag as K  # noqa: E402


class Randfaelle(unittest.TestCase):
    def test_vergleich_mittel_null(self):
        # Vortage mit 0 kWh je Gradstunde (Waermepumpe aus) zaehlen mit; ein Mittel von 0 darf keinen ZeroDivisionError ausloesen
        tag = dt.date(2026, 10, 20)
        null = {"effizienz.vollstaendig": 1, "komfort.gehalten": 1, "effizienz.kwh_je_gradstunde": 0.0, "aussen.mittel": 8.0}
        tage = {(tag - dt.timedelta(days=i)).isoformat(): dict(null) for i in (1, 2)}
        tage[tag.isoformat()] = dict(null, **{"effizienz.kwh_je_gradstunde": 0.05})
        V = K.vergleich_7t(tage, tag)
        self.assertEqual(V["effizienz.vergleich_mittel"], 0)
        self.assertIsNone(V.get("effizienz.abweichung_prozent"))

    def test_band_ausserhalb_99_grad(self):
        # Fuehler-Ausreisser (z. B. -127 °C) duerfen die Bandbestimmung nicht mit StopIteration abbrechen
        self.assertEqual(K.band(-127.0), "unter 3 °C")
        self.assertEqual(K.band(127.0), "ab 12 °C")


if __name__ == "__main__":
    unittest.main(verbosity=2)

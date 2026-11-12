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


def minute(t, **w):
    """Minutenzeile wie quiet-*.csv (Text wie aus der CSV)."""
    r = {"_t": t, "verdichter_hz": "20", "zustand": "lauf"}
    r.update({k: str(v) for k, v in w.items()})
    return r


class EnergieRechenweg2(unittest.TestCase):
    """V4 (Frost-Nachmessung 12.11.2026, N1): Waerme aus leistung_th_berechnet_w mit negativer Abtauwaerme, Strom mit Heizstab-Kanal."""

    def tag(self, zeilen, tag=dt.date(2026, 11, 6)):
        K.QUELLE = "zaehler"
        try:
            F, _ = K.zusammenfassung({"quiet": zeilen, "events": [], "v2": [], "energy": [], "decisions": [], "scores": [], "applied": [],
                                      "defrost": [], "fehlt": []}, tag)
        finally:
            K.QUELLE = "heishamon"
        return F

    def test_abtauung_negativ_und_heizstab(self):
        t0 = dt.datetime(2026, 11, 6, 3, 0)
        Z = [minute(t0 + dt.timedelta(minutes=i), leistung_th_heisha_w=3000, leistung_th_berechnet_w=3000, zaehler_wp_w=600, zaehler_heizstab_w=0)
             for i in range(60)]
        Z += [minute(t0 + dt.timedelta(minutes=60 + i), defrost=1, leistung_th_heisha_w=1500, leistung_th_berechnet_w=-3000, zaehler_wp_w=800,
                     zaehler_heizstab_w=2900 if i < 5 else 20) for i in range(10)]
        F = self.tag(Z)
        self.assertEqual(F["energie.rechenweg"], 2)
        self.assertAlmostEqual(F["energie.waerme_kwh_alt"], 3.25, places=2)           # alt: 60 x 3 kW + 10 x 1,5 kW (TOP positiv)
        self.assertAlmostEqual(F["energie.waerme_kwh"], 2.5, places=2)                # neu: 60 x 3 kW - 10 x 3 kW
        self.assertAlmostEqual(F["energie.heizstab_kwh"], 0.24, places=2)             # 5 x 2,9 kW; 20 W Ruhestrom zaehlt nicht
        self.assertAlmostEqual(F["energie.strom_kwh_alt"], 0.73, places=2)
        self.assertAlmostEqual(F["energie.strom_kwh"], 0.98, places=2)
        self.assertAlmostEqual(F["energie.cop_alt"], round(3.25 / 0.7333, 2), places=2)
        self.assertAlmostEqual(F["energie.cop"], round(2.5 / (0.7333 + 0.2417), 2), places=2)
        self.assertLess(F["energie.cop"], F["energie.cop_alt"])

    def test_ohne_berechnete_waerme_wie_bisher(self):
        # Aeltere Protokolle (vor leistung_th_berechnet_w bzw. Zaehler): Waerme und Strom wie Rechenweg 1, kein Fehler
        t0 = dt.datetime(2026, 10, 8, 3, 0)
        F = self.tag([minute(t0 + dt.timedelta(minutes=i), leistung_th_heisha_w=2400, leistung_el_w=500) for i in range(30)], t0.date())
        self.assertEqual(F["energie.waerme_kwh"], F["energie.waerme_kwh_alt"])
        self.assertEqual(F["energie.strom_kwh"], F["energie.strom_kwh_alt"])
        self.assertEqual(F["energie.heizstab_kwh"], 0)
        self.assertEqual(F["energie.cop"], F["energie.cop_alt"])

    def test_csv_spalten_alt_hinten(self):
        # Leser von tage.csv (Seite Lernen, esel/fakten_tag.py, aufgabe_stand.py, Beobachter) lesen nach Spaltennamen; die alten Spalten bleiben
        # an ihrer Stelle, die neuen *_alt kommen nur hinten dazu
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            F = {"energie.strom_kwh": 15.56, "energie.cop": 3.46, "energie.cop_alt": 4.03, "energie.strom_kwh_alt": 14.46, "energie.rechenweg": 2}
            with open(os.path.join(d, "2026-11-06.json"), "w", encoding="utf-8") as f:
                json.dump({"fakten": F, "befunde_anzahl": {}}, f)
            K.schreibe_csv(d)
            kopf, zeile = open(os.path.join(d, "tage.csv"), encoding="utf-8").read().splitlines()
            kopf = kopf.split(",")
            self.assertEqual(kopf[1:4], ["energie.strom_kwh", "energie.strom_kwh_roh", "energie.korr_w"])
            self.assertEqual(kopf[-len(K.SPALTEN_ALT):], K.SPALTEN_ALT)
            w = dict(zip(kopf, zeile.split(",")))
            self.assertEqual((w["energie.cop"], w["energie.cop_alt"], w["energie.rechenweg"]), ("3.46", "4.03", "2"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

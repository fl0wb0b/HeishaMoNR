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
        self.assertEqual(F["energie.rechenweg"], 3)
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


class StromUnbekannt(unittest.TestCase):
    """Rechenweg 3 (13.11.2026): Minuten ohne Stromwert sind unbekannt und gehen nicht als 0 kWh in Summen und COP ein."""

    def tag(self, zeilen, quelle="zaehler", tag=dt.date(2026, 11, 12)):
        K.QUELLE = quelle
        try:
            return K.zusammenfassung({"quiet": zeilen, "events": [], "v2": [], "energy": [], "decisions": [], "scores": [], "applied": [], "defrost": [], "fehlt": []}, tag)
        finally:
            K.QUELLE = "heishamon"

    def test_minute_ohne_strom_nicht_im_cop(self):
        t0 = dt.datetime(2026, 11, 12, 12, 0)
        Z = [minute(t0 + dt.timedelta(minutes=i), leistung_th_berechnet_w=3000, zaehler_wp_w=600, zaehler_heizstab_w=0, leistung_el_w=520) for i in range(60)]
        Z += [minute(t0 + dt.timedelta(minutes=60 + i), leistung_th_berechnet_w=3000) for i in range(10)]          # weder Zaehler noch TOP16
        F, X = self.tag(Z)
        self.assertEqual(F["energie.strom_unbekannt_min"], 10)
        self.assertEqual(F["energie.strom_unbekannt_lauf_min"], 10)
        self.assertAlmostEqual(F["energie.strom_kwh"], 0.6, places=2)                 # Summe der bekannten Minuten
        self.assertAlmostEqual(F["energie.waerme_kwh"], 3.5, places=2)                # alle Minuten mit Waerme
        self.assertEqual(F["energie.cop"], 5.0)                                       # gepaart: 3,0 kWh / 0,6 kWh; als 0 gezaehlt waeren es 5,83
        self.assertEqual(F["energie.cop_roh"], round(3000 / 520, 2))
        self.assertEqual(X["strom_unbekannt"], [("13:00", "13:09", 10)])
        B = K.regel_befunde(F, X)
        b = [x for x in B if x["titel"] == "Strom unbekannt"]
        self.assertEqual(len(b), 1)
        self.assertIn("13:00–13:09 (10 min)", b[0]["text"])
        self.assertIn("nicht als 0 kWh", b[0]["text"])
        self.assertEqual(b[0]["schwere"], "hinweis")

    def test_zaehler_fehlt_ersatz_top16(self):
        # Pruefall 12.11.2026 13:08–13:21: 14 Minuten ohne Zaehlerwert, TOP16 da -> Ersatz TOP16 + 80 W, ausgewiesen, nichts unbekannt
        t0 = dt.datetime(2026, 11, 12, 13, 0)
        Z = []
        for i in range(30):
            z = {} if 8 <= i <= 21 else {"zaehler_wp_w": 406, "zaehler_heizstab_w": 0}
            Z.append(minute(t0 + dt.timedelta(minutes=i), verdichter_hz=17, leistung_el_w=355, leistung_th_berechnet_w=2491.78, **z))
        F, X = self.tag(Z)
        self.assertEqual(F["energie.strom_unbekannt_min"], 0)
        self.assertEqual(F["energie.strom_ersatz_min"], 14)
        self.assertAlmostEqual(F["energie.strom_ersatz_kwh"], round(14 * 435 / 60000, 2), places=2)
        self.assertEqual(F["energie.zaehler_min"], 16)
        self.assertAlmostEqual(F["energie.strom_kwh"], round((16 * 406 + 14 * 435) / 60000, 2), places=2)
        self.assertAlmostEqual(F["energie.strom_kwh_zaehler"], round(16 * 406 / 60000, 2), places=2)   # nur Zaehlerminuten (mit zaehler_min lesen)
        self.assertEqual(X["strom_ersatz"], [("13:08", "13:21", 14)])
        b = [x for x in K.regel_befunde(F, X) if x["titel"] == "Stromzähler ohne Wert"]
        self.assertEqual(len(b), 1)
        self.assertIn("13:08–13:21 (14 min)", b[0]["text"])

    def test_heizstab_nicht_doppelt(self):
        # TOP16 enthaelt den internen Heizstab: Quelle heishamon und der Rohwert bekommen den Zaehlerkanal Heizstab nicht noch einmal dazu
        t0 = dt.datetime(2026, 11, 13, 3, 34)
        Z = [minute(t0 + dt.timedelta(minutes=i), verdichter_hz=24, leistung_el_w=3618, leistung_th_berechnet_w=5000, zaehler_wp_w=637, zaehler_heizstab_w=2818, heizstab_intern=1) for i in range(5)]
        Fz, _ = self.tag(Z, "zaehler", t0.date())
        Fh, _ = self.tag(Z, "heishamon", t0.date())
        self.assertAlmostEqual(Fz["energie.strom_kwh"], round(5 * (637 + 2818) / 60000, 2), places=2)
        self.assertAlmostEqual(Fz["energie.strom_kwh_roh"], round(5 * 3618 / 60000, 2), places=2)      # bis 13.11.: 3618 + 2818
        self.assertAlmostEqual(Fh["energie.strom_kwh"], round(5 * (3618 + 80) / 60000, 2), places=2)   # bis 13.11.: + 2818 obendrauf
        self.assertAlmostEqual(Fz["energie.heizstab_kwh"], round(5 * 2818 / 60000, 2), places=2)

    def test_heizstab_kanal_fehlt(self):
        t0 = dt.datetime(2026, 11, 13, 3, 0)
        Z = [minute(t0 + dt.timedelta(minutes=i), leistung_th_berechnet_w=2400, zaehler_wp_w=600, zaehler_heizstab_w=0) for i in range(30)]
        Z += [minute(t0 + dt.timedelta(minutes=30 + i), leistung_th_berechnet_w=5000, zaehler_wp_w=600, heizstab_intern=1) for i in range(5)]
        F, X = self.tag(Z, "zaehler", t0.date())
        self.assertEqual(F["energie.heizstab_unbekannt_min"], 5)
        self.assertEqual(F["energie.cop"], 4.0)                                       # nur die 30 Minuten mit vollstaendigem Strom
        self.assertTrue(any(x["titel"] == "Heizstab-Strom unbekannt" for x in K.regel_befunde(F, X)))

    def test_abtauminute_ohne_waermespalte_aus_durchfluss(self):
        # Abtauung mit stehendem Verdichter und Abtau-Heizstab: keine Waermespalte, aber Durchfluss und Spreizung -> Waerme nachgerechnet
        t0 = dt.datetime(2026, 11, 6, 1, 0)
        Z = [minute(t0 + dt.timedelta(minutes=i), leistung_th_berechnet_w=2400, zaehler_wp_w=600, zaehler_heizstab_w=0) for i in range(60)]
        Z += [minute(t0 + dt.timedelta(minutes=60 + i), verdichter_hz=0, zustand="pause", defrost=1, flow_l_min=37.4, ist_vl=28.75, ist_rl=27.5, zaehler_wp_w=147, zaehler_heizstab_w=2909,
                     heizstab_intern=1) for i in range(2)]
        F, _ = self.tag(Z, "zaehler", t0.date())
        q = 37.4 * 4186 / 60 * 1.25                                                   # 3262 W
        self.assertEqual(F["energie.waerme_nachgerechnet_min"], 2)
        self.assertEqual(F["energie.waerme_unbekannt_min"], 0)
        self.assertAlmostEqual(F["energie.waerme_kwh"], round(2.4 + 2 * q / 60000, 2), places=2)
        self.assertEqual(F["energie.cop"], round((2.4 + 2 * q / 60000) / (0.6 + 2 * (147 + 2909) / 60000), 2))

    def test_waerme_fehlt_im_lauf(self):
        t0 = dt.datetime(2026, 11, 12, 9, 0)
        Z = [minute(t0 + dt.timedelta(minutes=i), leistung_th_berechnet_w=2400, leistung_el_w=520) for i in range(30)]
        Z += [minute(t0 + dt.timedelta(minutes=30 + i), leistung_el_w=520) for i in range(6)]                     # Lauf ohne Waermewert
        F, _ = self.tag(Z, "heishamon")
        self.assertEqual(F["energie.waerme_unbekannt_min"], 6)
        self.assertEqual(F["energie.cop"], 4.0)                                       # 2400 / 600; mit den 6 Minuten Strom ohne Waerme waeren es 3,33
        self.assertAlmostEqual(F["energie.strom_kwh"], 0.36, places=2)                # der Strom zaehlt in der Summe weiter


if __name__ == "__main__":
    unittest.main(verbosity=2)

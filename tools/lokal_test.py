#!/usr/bin/env python3
"""Tests fuer tools/lokal.py, tools/privat_test.py und den Pfad-Zwang des Generators (lokale Konfiguration).
Usage: python3 tools/lokal_test.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HIER = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HIER)
import lokal  # noqa: E402
import privat_test  # noqa: E402


def datei(inhalt):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    f.write(inhalt)
    f.close()
    return f.name


class Lade(unittest.TestCase):
    def lade(self, inhalt):
        alt, lokal.PFAD = lokal.PFAD, datei(inhalt)
        try:
            return lokal.lade()
        finally:
            os.unlink(lokal.PFAD)
            lokal.PFAD = alt

    def test_wurzel_muss_objekt_sein(self):
        for inhalt in ("null", "[]"):
            with self.assertRaises(SystemExit):
                self.lade(inhalt)

    def test_raum_topic_muss_text_sein(self):
        with self.assertRaises(SystemExit):
            self.lade(json.dumps({"venus": "v", "nas": "n", "raum_topics": {"ki_oben": 1}}))

    def test_gueltig(self):
        self.assertEqual(self.lade(json.dumps({"venus": "v", "nas": "n", "raum_topics": {"ki_oben": "a/b"}}))["nas"], "n")


class Pruefliste(unittest.TestCase):
    def liste(self, **env):
        alt = {k: os.environ.get(k) for k in ("HEISHAMONR_LOKAL", "HEISHAMONR_NICHT_IM_REPO")}
        os.environ.pop("HEISHAMONR_NICHT_IM_REPO", None)
        os.environ.update(env)
        try:
            return privat_test.pruefliste()
        finally:
            for k, v in alt.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_ausdruecklich_genannte_datei_fehlt(self):
        with self.assertRaises(SystemExit):
            self.liste(HEISHAMONR_LOKAL=os.path.join(tempfile.gettempdir(), "gibt-es-nicht-lokal.json"))

    def test_liste_muss_liste_sein(self):
        p = datei(json.dumps({"nicht_im_repo": "abc"}))
        try:
            with self.assertRaises(SystemExit):
                self.liste(HEISHAMONR_LOKAL=p)
        finally:
            os.unlink(p)

    def test_unicode_gross_klein(self):
        self.assertTrue(privat_test.wort_muster(["Küche"]).search("Die KÜCHE oben".casefold()))
        self.assertFalse(privat_test.wort_muster(["küche"]).search("kuechenzeile"))


class Generator(unittest.TestCase):
    def test_ohne_pfad_abbruch_mit_usage(self):
        # ohne Pfad schrieb der Generator in die versionierte Flow-Datei (Installationswerte im Repo)
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run([sys.executable, os.path.join(HIER, "optimizer_phase1.py")], cwd=d, capture_output=True, text=True,
                               env=dict(os.environ, HEISHAMONR_LOKAL=os.path.join(HIER, os.pardir, "lokal.example.json")))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Usage", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

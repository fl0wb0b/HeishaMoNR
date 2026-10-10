#!/usr/bin/env python3
"""Tests fuer tools/bonsai_beobachter.py. Bonsai (LLM) ist IMMER ein Mock: eine eingesetzte Funktion bzw. ein Mini-HTTP-Server auf 127.0.0.1.
Der echte llama-server und die NAS werden nie angesprochen.
Usage: BEOBACHTER_TMP=<ordner> python3 tools/bonsai_beobachter_test.py [Datenordner mit echten Kopien, optional]"""
import datetime as dt
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bonsai_beobachter as B  # noqa: E402

DATEN = sys.argv.pop(1) if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]) else None
TMP = os.environ.get("BEOBACHTER_TMP") or None

QKOPF = "zeit,quiet_aktuell,soll_vl,ist_vl,ist_rl,verdichter_hz,leistung_el_w,leistung_th_heisha_w,leistung_th_berechnet_w,pumpe_speed,aussen,verdichter_laufzeit_min,heizregelung,zustand,kz_radiator_an"


def schreib(p, text):
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def fixture(ordner):
    """Ein Tag (12.10.2026): 00:00-02:00 Lauf (16 Hz, 300 W, 2100 W th), 02:00-03:00 Pause, 03:00-03:40 Lauf, danach Pause bis 06:00,
    Luecke 06:00-06:20, Quiet 3 -> 0 um 05:00 (GUI). Raum ki_oben 21,5 bei Band 22-23,5 von 00:00 bis 03:00 (36 Zeilen = 180 min)."""
    t0 = dt.datetime(2026, 10, 12, 0, 0, 11)
    z = [QKOPF]
    rt = 0
    for m in range(0, 7 * 60):
        t = t0 + dt.timedelta(minutes=m)
        if 360 <= m < 380:
            continue
        lauf = m < 120 or 180 <= m < 220
        rt = rt + 1 if lauf else 0
        q = 3 if m < 300 else 0
        z.append(",".join(str(x) for x in [t.strftime("%Y-%m-%d %H:%M:%S"), q, 30, 31 if lauf else 28, 29 if lauf else 28, 16 if lauf else 0, 300 if lauf else 30,
                                            2100 if lauf else "", "", 1750, 9, rt, 1, "lauf" if lauf else "pause", 1]))
    schreib(os.path.join(ordner, "quiet-2026-10.csv"), "\n".join(z) + "\n")
    ev = ["zeit,ereignis,wechsel", "2026-10-12 05:00:30,quiet_befehl,Stufe 0 (Quelle: GUI)", "2026-10-12 05:00:33,quiet_stufe,3->0 (per Befehl; Quelle: GUI)",
          "2026-10-12 03:00:11,verdichter_start,Pause 60 min", "2026-10-12 01:30:00,kz_radiator,an->aus (Quelle: MQTT)"]
    schreib(os.path.join(ordner, "quiet-events-2026-10.csv"), "\n".join(ev) + "\n")
    v = ["zeit,ki_oben_ema,ki_oben_min,ki_oben_max,ki_oben_gueltig"]
    for k in range(0, 7 * 12):
        t = t0 + dt.timedelta(minutes=5 * k)
        v.append("%s,%s,22,23.5,%s" % (t.strftime("%Y-%m-%d %H:%M:%S"), 21.5 if k < 36 else 22.4, 1 if k % 2 == 0 else 0))
    schreib(os.path.join(ordner, "optimizer-v2-2026-10.csv"), "\n".join(v) + "\n")
    dec = [json.dumps({"t": (t0 + dt.timedelta(minutes=m)).strftime("%Y-%m-%d %H:%M:00"), "r": [{"id": "quiet_freigabe", "st": "bereit"}]}) for m in range(400)]
    schreib(os.path.join(ordner, "decisions-2026-10.jsonl"), "\n".join(dec) + "\n")
    sc = [{"t": "2026-10-12 04:00:00", "typ": "ausloeser", "regel": "quiet_freigabe", "punkte": 21, "text": "x"}, {"t": "2026-10-12 04:00:00", "typ": "schaden", "regel": "raum_offset", "punkte": -20, "text": "Hätte nach den Daten geschadet: Raum unter Minimum − 0,3 K"}]
    schreib(os.path.join(ordner, "scores-2026-10.jsonl"), "\n".join(json.dumps(x) for x in sc) + "\n")


class Grundlagen(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(dir=TMP)
        self.src = os.path.join(self.dir, "src")
        os.makedirs(self.src)
        fixture(self.src)
        self.tag = dt.date(2026, 10, 12)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_zusammenfassung_deterministisch(self):
        d = B.lade(B.OrdnerQuelle(self.src), self.tag)
        F, ex = B.zusammenfassung(d, self.tag)
        self.assertEqual(F["laeufe.anzahl"], 2)
        self.assertEqual(F["laeufe.starts"], 1)                       # der erste Lauf begann vor Beobachtungsbeginn
        self.assertEqual((F["laeufe.laengster_min"], F["laeufe.kuerzester_min"]), (120, 40))
        self.assertEqual(F["daten.luecken_ueber_10min"], 1)
        self.assertEqual(F["daten.groesste_luecke_min"], 21)
        self.assertAlmostEqual(F["energie.waerme_kwh"], 2.1 * 160 / 60, places=1)
        self.assertEqual(F["quiet.stufe0_min"], 100)
        self.assertEqual(F["ereignisse.quiet_befehle_gui"], 1)
        self.assertEqual(F["raum.ki_oben.unter_min_min"], 180)
        self.assertEqual(F["raum.ki_oben.ungueltig_prozent"], 50)
        self.assertEqual(F["maschine.datensaetze"], 400)
        self.assertEqual(F["punkte.raum_offset.schaden"], 1)
        # gleiche Eingabe -> gleiche Fakten
        F2, _ = B.zusammenfassung(B.lade(B.OrdnerQuelle(self.src), self.tag), self.tag)
        self.assertEqual(F, F2)

    def test_regelbefunde(self):
        d = B.lade(B.OrdnerQuelle(self.src), self.tag)
        F, ex = B.zusammenfassung(d, self.tag)
        titel = [b["titel"] for b in B.regel_befunde(F, ex)]
        self.assertIn("Lücken im Minutenprotokoll", titel)
        self.assertIn("Kinderzimmer oben oft ungültig", titel)
        self.assertIn("Kinderzimmer oben lange unter Minimum", titel)
        self.assertIn("Schaden-Bewertung raum_offset", titel)
        self.assertIn("Messaufgabe Comfort/Efficiency offen", titel)

    def test_pruefe_aussage(self):
        f = {"energie.strom_kwh": 6.63, "raum.ki_oben.band": "22.0-23.5", "laeufe.anzahl": 5}
        ok = {"titel": "a", "schwere": "hinweis", "beleg": ["energie.strom_kwh", "laeufe.anzahl"], "text": "5 Läufe mit 6,63 kWh."}
        self.assertEqual(B.pruefe_aussage(ok, f), (True, ""))
        self.assertTrue(B.pruefe_aussage({"schwere": "info", "beleg": ["raum.ki_oben.band"], "text": "Band 22 bis 23,5"}, f)[0])
        self.assertFalse(B.pruefe_aussage(dict(ok, text="7,1 kWh Strom"), f)[0])                       # erfundene Zahl
        self.assertFalse(B.pruefe_aussage(dict(ok, beleg=[]), f)[0])                                   # ohne Beleg
        self.assertFalse(B.pruefe_aussage(dict(ok, beleg=["gibt.es.nicht"]), f)[0])                    # unbekannter Schluessel
        self.assertFalse(B.pruefe_aussage(dict(ok, schwere="kritisch"), f)[0])
        self.assertFalse(B.pruefe_aussage("Text", f)[0])

    def test_bonsai_mock_filtert(self):
        antworten = iter([
            'Hier: [{"titel":"Strom","schwere":"hinweis","beleg":["energie.strom_kwh"],"text":"Strom 0,8 kWh."},'
            ' {"titel":"Erfunden","schwere":"warnung","beleg":["energie.strom_kwh"],"text":"COP 9,9 viel zu hoch."},'
            ' {"titel":"ohne","schwere":"info","beleg":[],"text":"Alles gut."}]',
            'kein JSON hier',
            '[{"titel":"Vortag","schwere":"info","beleg":["laeufe.anzahl","vortag.laeufe.anzahl"],"text":"2 Läufe."}]'])
        gesehen = []
        def frag(msgs):
            gesehen.append(msgs)
            return next(antworten)
        d = B.lade(B.OrdnerQuelle(self.src), self.tag)
        F, _ = B.zusammenfassung(d, self.tag)
        F["energie.strom_kwh"] = 0.8
        gut, verworfen, fehler = B.bonsai_befunde(frag, F, {"laeufe.anzahl": 0})
        self.assertIsNone(fehler)
        self.assertEqual([g["titel"] for g in gut], ["Strom", "Vortag"])
        self.assertTrue(all(g["status"] == "ungeprüft" and g["quelle"] == "Bonsai" for g in gut))
        self.assertEqual(len(verworfen), 2)
        self.assertEqual(len(gesehen), 3)
        self.assertIn('"energie.strom_kwh": 0.8', gesehen[0][1]["content"])                               # die Zahlen werden mitgeliefert

    def test_bonsai_ausfall_bericht_trotzdem(self):
        def frag(msgs):
            raise ConnectionError("Bonsai nicht erreichbar: aus")
        out = os.path.join(self.dir, "out")
        r = B.lauf(B.OrdnerQuelle(self.src), self.tag, out, frag, "Test")
        self.assertIn("nicht erreichbar", r["fehler"])
        self.assertTrue(os.path.exists(os.path.join(out, "2026-10-12.md")))
        j = json.load(open(os.path.join(out, "befunde.json")))
        self.assertIn("2026-10-12", j)
        self.assertTrue(all(b["status"].startswith("geprueft") for b in j["2026-10-12"]["befunde"]))

    def test_befunde_json_mehrere_tage(self):
        out = os.path.join(self.dir, "out")
        B.lauf(B.OrdnerQuelle(self.src), self.tag, out, None, "Test")
        B.lauf(B.OrdnerQuelle(self.src), self.tag - dt.timedelta(days=1), out, None, "Test")
        j = json.load(open(os.path.join(out, "befunde.json")))
        self.assertEqual(sorted(j), ["2026-10-11", "2026-10-12"])

    def test_quellen_nur_erlaubte_dateien(self):
        q = B.OrdnerQuelle(self.src)
        with self.assertRaises(ValueError):
            q.lies("../../etc/passwd")
        with self.assertRaises(ValueError):
            B.BefehlQuelle(["printf", "%s", "{datei}"]).lies("quiet-2026-10.csv; rm -rf /")
        self.assertEqual(B.BefehlQuelle(["printf", "%s", "{datei}"]).lies("quiet-2026-10.csv"), "quiet-2026-10.csv")   # ohne Shell, nur Ersetzen

    def test_http_mock_server(self):
        anfragen = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                anfragen.append((self.path, json.loads(self.rfile.read(n).decode("utf-8"))))
                body = json.dumps({"choices": [{"message": {"content": '[{"titel":"T","schwere":"info","beleg":["laeufe.anzahl"],"text":"2 Läufe."}]'}}]}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            tot = "http://127.0.0.1:9"                     # Port 9 (discard): nicht erreichbar -> naechster Host
            frag = B.http_frager([tot, "http://127.0.0.1:%d" % srv.server_port], modell="mock", timeout=5)
            gut, verworfen, fehler = B.bonsai_befunde(frag, {"laeufe.anzahl": 2}, {})
        finally:
            srv.shutdown()
        self.assertIsNone(fehler)
        self.assertEqual(len(gut), 3)                      # drei Fragen, je eine gueltige Aussage
        self.assertEqual(anfragen[0][0], "/v1/chat/completions")
        self.assertEqual(anfragen[0][1]["model"], "mock")
        self.assertEqual(anfragen[0][1]["messages"][0]["role"], "system")


@unittest.skipUnless(DATEN, "kein Datenordner angegeben")
class EchteDaten(unittest.TestCase):
    def test_tag_2026_10_09(self):
        out = tempfile.mkdtemp(dir=TMP)
        try:
            def frag(msgs):
                return '[{"titel":"Strom","schwere":"info","beleg":["energie.strom_kwh"],"text":"Strom 6,63 kWh."}, {"titel":"falsch","schwere":"info","beleg":["energie.cop"],"text":"COP 4,2."}]'
            r = B.lauf(B.OrdnerQuelle(DATEN), dt.date(2026, 10, 9), out, frag, "Test")
            F = r["fakten"]
            print("\n  09.10.: Strom %s kWh, Waerme %s kWh, COP %s, Laeufe %s, Starts %s, Kinderzimmer oben unter Minimum %s min" % (
                F["energie.strom_kwh"], F["energie.waerme_kwh"], F["energie.cop"], F["laeufe.anzahl"], F["laeufe.starts"], F.get("raum.ki_oben.unter_min_min")))
            self.assertEqual(F["daten.minutenzeilen"], 1439)
            self.assertAlmostEqual(F["energie.strom_kwh"], 6.63, places=1)
            self.assertEqual([b["titel"] for b in r["befunde"] if b["quelle"] == "Bonsai"], ["Strom", "Strom", "Strom"])
            self.assertEqual(len(r["verworfen"]), 3)
        finally:
            shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)

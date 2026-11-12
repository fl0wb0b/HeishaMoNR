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
ALT_PAARE = ["energie.strom_kwh", "energie.strom_kwh_roh", "energie.waerme_kwh", "energie.cop", "energie.cop_roh", "effizienz.kwh_je_gradstunde"]
NUR_CONTAINER = ["energie.rechenweg", "energie.heizstab_kwh", "energie.waerme_berechnet_min"]
VERGLEICH_7T = ["effizienz.vergleich_tage", "effizienz.vergleich_mittel", "effizienz.abweichung_prozent"]
# Zaehlerquelle (cop-ziel 17.10.2026, config.json "zaehler": {"quelle": "zaehler"}): der Container nimmt den Strom vom Shelly, der Beobachter rechnet
# weiter TOP16 + 80 W und kennt die Zaehler-Schluessel nicht. Diese Unterschiede bestanden schon vor Rechenweg 2 (einwire-protokoll, 12.11. geprueft).
ZAEHLER_ABH = ["energie.strom_kwh", "energie.cop", "effizienz.kwh_je_gradstunde", "abtau.strom_wh"]
NUR_CONTAINER_ZAEHLER = ["energie.quelle", "energie.strom_kwh_zaehler", "energie.zaehler_min"]
META = ["fakten.quelle"]                                   # Herkunftsvermerk des Beobachters, keine Kennzahl


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
            # Energie-Rechenweg 2 (kennzahlen_tag.py, 13.11.2026): der Container rechnet Wärme mit negativer Abtauwärme und Strom mit Heizstab;
            # der Beobachter rechnet weiter wie bisher. Verglichen wird sein Wert mit dem *_alt-Wert des Containers; nur im Container: Rechenweg-Schlüssel.
            # Der 7-Tage-Vergleich nutzt die neue kWh/Kh und darf abweichen, wenn sich Strom durch den Heizstab unterscheidet.
            if Fk.get("energie.rechenweg") == 2:
                for k in ALT_PAARE:
                    if k + "_alt" in Fk:
                        Fk[k] = Fk.pop(k + "_alt")
                for k in NUR_CONTAINER:
                    Fk.pop(k, None)
            zaehler = Fk.get("energie.quelle") == "zaehler"
            for k in META:
                Fb.pop(k, None)
            for k in NUR_CONTAINER_ZAEHLER:                # nur im Container (Zaehler-Spalten), dem Beobachter unbekannt
                if k not in Fb:
                    Fk.pop(k, None)
            erl = VERGLEICH_7T + (ZAEHLER_ABH if zaehler else [])
            diff, erlaubt = [], []
            for k in sorted(set(Fb) | set(Fk)):
                if Fb.get(k) != Fk.get(k):
                    (erlaubt if k in erl else diff).append((k, Fb.get(k), Fk.get(k)))
            gleich = len(set(Fb) | set(Fk)) - len(diff) - len(erlaubt)
            print("%s: %d Schlüssel gleich, %d verschieden%s" % (t, gleich, len(diff), (", %d erlaubt (7-Tage-Vergleich nach Rechenweg 2%s)" % (len(erlaubt), "; Strom aus dem Zähler, Beobachter TOP16 + 80 W" if zaehler else "")) if erlaubt else ""))
            for k, a, b in erlaubt:
                print("   (erlaubt) %s: Beobachter %r, Container %r" % (k, a, b))
            for k, a, b in diff:
                print("   %s: Beobachter %r, Container %r" % (k, a, b))
            schlecht += len(diff)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 1 if schlecht else 0


if __name__ == "__main__":
    sys.exit(main())

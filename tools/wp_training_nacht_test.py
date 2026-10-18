#!/usr/bin/env python3
"""Tests für training-v2 in tools/wp_training_nacht.py (Ablage nach dem Gate) und docker/optimizer-tools/ot.py (status.json).

Ohne Datenordner: wp_training.js wird durch einen Stellvertreter ersetzt (--node), der festgelegte Ergebnisse schreibt
(übernommen/abgelehnt mit synthetischen Zahlen). Geprüft wird, welche Dateien entstehen, welcher Satz aktiv ist,
was letzter.json und status.json enthalten. Mit Datenordner zusätzlich zwei echte Nächte (node wp_training.js).

  python3 tools/wp_training_nacht_test.py [Datenordner, z. B. replay_data_1710]
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HIER = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HIER)
sys.dont_write_bytecode = True
OKS, FAILS = 0, 0


def check(name, cond, info=""):
    global OKS, FAILS
    print(("OK   " if cond else "FAIL ") + name + (("  -> " + str(info)) if info not in ("", None) else ""))
    if cond:
        OKS += 1
    else:
        FAILS += 1


def lade_modul(name, pfad):
    spec = importlib.util.spec_from_file_location(name, pfad)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


STUB = r'''#!/usr/bin/env python3
# Stellvertreter für "node wp_training.js": schreibt ein festgelegtes Ergebnis (STUB_ERGEBNIS, STUB_STROM_*), protokolliert die Argumente
import json, os, sys
a = sys.argv[2:]
arg = lambda k: a[a.index(k) + 1] if k in a else None
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(json.dumps(a) + "\n")
def g(strom, wk, pause, baender=True):
    return {"tage": ["2026-11-02"], "teil": {"pelRmseW": strom, "pthRmseW": 250.0, "reglerRmseHz": 1.1, "wasserkreisRmseK": wk, "hausRmseK": 0.6},
            "zyklenHausSimuliert": {"pause": {"medianAbsMin": pause}, "lauf": {"medianAbsMin": 40}}, "freilaufSumme": {"kwhElZwilling": 25.0, "kwhElMessung": 26.0},
            "jeBand": [{"band": b, "name": b, "minuten": m, "laufMinuten": m // 2, "status": s, "strom": {"n": m, "rmseW": strom if m else None},
                        "waerme": {"n": 0, "rmseW": None}, "regler": {"n": 0, "rmseHz": None}, "wasserkreis": {"n": 0, "rmseK": None}, "haus": {"n": 0, "rmseK": None},
                        "pause": {"n": 0, "medianAbsMin": None}, "lauf": {"n": 0, "medianAbsMin": None}}
                       for b, m, s in (("unter0", 0, "keine Daten, Zwilling extrapoliert"), ("0bis4", 100, "Daten"), ("4bis8", 900, "Daten"), ("8bis12", 900, "Daten"), ("ab12", 0, "keine Testdaten"))]}
erg = os.environ.get("STUB_ERGEBNIS", "übernommen")
ks = float(os.environ.get("STUB_STROM_KANDIDAT", "19")); kb = float(os.environ.get("STUB_STROM_BISHER", "20"))
wert = float(os.environ.get("STUB_WERT", "1.0"))
vor = arg("--vorher")
R = {"version": 1, "verfahren": 2, "modell": "stub", "daten": {"ordner": "x", "von": "a", "bis": "b", "minuten": 10, "laeufe": 1, "pausen": 1},
     "trennung": {"training": ["2026-11-01", "2026-11-01"], "test": ["2026-11-02", "2026-11-02"]},
     "werte": {"ua": wert, "fest": 7}, "werteTraining": {"ua": wert, "fest": 7}, "herkunft": {"ua": {"fit": "gefittet", "gruppe": "haus"}, "fest": {}},
     "fit": {}, "guete": {"training": g(ks, 1.0, 6), "test": g(ks, 1.0, 6)},
     "glaettung": {"anteil": 0.333333, "vorher": arg("--vorher-tag"), "bindung": {"aktiv": True, "gewicht": 0.1, "grund": "Dünn-Daten-Phase: 2 Tage Daten (< 21)"}},
     "roh": {"werte": {"ua": wert * 2, "fest": 7}, "werteTraining": {"ua": wert * 2, "fest": 7}, "guete": {"test": g(ks - 1, 1.0, 5)}} if vor else None,
     "vorherNeu": {"tag": arg("--vorher-tag"), "guete": {"test": g(kb, 1.1, 8)}} if vor else None,
     "entscheidung": {"ergebnis": erg if vor else "übernommen", "grund": ("Strom TOP16 RMSE (W): schlechter um 50 %" if erg == "abgelehnt" else "nicht schlechter") if vor else "erster Lauf: kein bisheriger Satz",
                      "kriterium": {"rel": float(arg("--gate-rel") or 0.1)}, "kennzahlen": [{"id": "strom", "name": "Strom TOP16 RMSE (W)", "kandidat": ks, "bisher": kb, "verletzt": erg == "abgelehnt", "warum": "schlechter" if erg == "abgelehnt" else None}] if vor else []},
     "abdeckung": {"tage": 2, "duenn": True, "grund": "2 Tage Daten (< 21)", "baenderAusreichend": 3, "atMin": 1, "atMax": 14, "extrapoliertUnterC": 0,
                   "hinweis": "Zwilling hat unter 0 °C keine Daten (tiefste gemessene AT 1 °C): dort extrapoliert", "kriterien": {"laufMinBand": 300, "tage": 21, "baender": 3},
                   "baender": [{"band": "unter0", "name": "< 0 °C", "minuten": 0, "laufMinuten": 0, "tage": 0, "status": "keine Daten, Zwilling extrapoliert"}]}}
with open(arg("--json"), "w") as f:
    json.dump(R, f)
with open(arg("--md"), "w") as f:
    f.write("# Anlagen-Zwilling Leisha WH-WDG05LE5: Training\n\nStellvertreter\n")
'''


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    N = lade_modul("wp_training_nacht", os.path.join(HIER, "wp_training_nacht.py"))
    tmp = tempfile.mkdtemp(prefix="wp_nacht_test_")
    try:
        daten = os.path.join(tmp, "daten")
        os.makedirs(daten)
        with open(os.path.join(daten, "quiet-2026-11.csv"), "w") as f:
            f.write("zeit,aussen\n2026-11-02 06:00:00,3\n")
        stub = os.path.join(tmp, "node_stub.py")
        with open(stub, "w") as f:
            f.write(STUB)
        os.chmod(stub, 0o755)
        erg = os.path.join(tmp, "ergebnis")
        tr = os.path.join(erg, "training")
        os.environ["STUB_LOG"] = os.path.join(tmp, "stub.log")

        def nacht(tag, ergebnis, **env):
            for k in ("STUB_ERGEBNIS", "STUB_STROM_KANDIDAT", "STUB_STROM_BISHER", "STUB_WERT"):
                os.environ.pop(k, None)
            os.environ.update(env)
            open(os.environ["STUB_LOG"], "w").close()
            rc = N.main(["--daten", daten, "--ergebnis", erg, "--tag", tag, "--node", stub])
            with open(os.environ["STUB_LOG"]) as f:
                args = json.loads(f.readline())
            with open(os.path.join(tr, "letzter.json"), encoding="utf-8") as f:
                return rc, args, json.load(f)

        print("--- Ablage nach dem Gate (Stellvertreter für wp_training.js)")
        rc, args, L = nacht("2026-11-01", erg, STUB_WERT="0.15")
        check("erster Lauf: übernommen, wp_params_<tag>.json und wp_params_aktiv.json, ohne --vorher", rc == 0 and L["entscheidung"]["ergebnis"] == "übernommen"
              and os.path.exists(os.path.join(tr, "wp_params_2026-11-01.json")) and os.path.exists(os.path.join(tr, "wp_params_aktiv.json")) and "--vorher" not in args,
              L["entscheidung"]["grund"])
        check("Glättung/Gate-Schwellen werden an wp_training.js übergeben (Standard 1/3, 0,1, 0,1)", args[args.index("--glaettung") + 1].startswith("0.333") and args[args.index("--bindung") + 1] == "0.1" and args[args.index("--gate-rel") + 1] == "0.1")
        aktiv1 = sha(os.path.join(tr, "wp_params_aktiv.json"))
        rc, args, L = nacht("2026-11-02", erg, STUB_ERGEBNIS="abgelehnt", STUB_STROM_KANDIDAT="30", STUB_STROM_BISHER="20", STUB_WERT="0.5")
        check("zweiter Lauf mit --vorher wp_params_2026-11-01.json (Champion)", "--vorher" in args and args[args.index("--vorher") + 1].endswith("wp_params_2026-11-01.json") and args[args.index("--vorher-tag") + 1] == "2026-11-01")
        check("abgelehnt: kandidat_<tag>.json liegt da, keine wp_params_<tag>.json, aktiv bleibt der bisherige Satz (Datei unverändert)",
              os.path.exists(os.path.join(tr, "kandidat_2026-11-02.json")) and not os.path.exists(os.path.join(tr, "wp_params_2026-11-02.json"))
              and sha(os.path.join(tr, "wp_params_aktiv.json")) == aktiv1 and L["datei"] == "wp_params_2026-11-01.json")
        e = L["entscheidung"]
        check("letzter.json: entscheidung mit Zahlen beider Sätze und Grund; guete_test = bisheriger Satz neu bewertet",
              e["ergebnis"] == "abgelehnt" and e["kandidat"]["Strom TOP16 RMSE (W)"] == 30 and e["bisher"]["Strom TOP16 RMSE (W)"] == 20 and e["verletzt"] == ["Strom TOP16 RMSE (W)"]
              and "Strom" in e["grund"] and L["guete_test"]["Strom TOP16 RMSE (W)"] == 20 and e["aktiv"] == "wp_params_2026-11-01.json", json.dumps(e, ensure_ascii=False)[:200])
        check("letzter.json: Güte je Band (5 Bänder, leeres Band mit Status) und Abdeckung mit Hinweis",
              len(L["guete_je_band"]) == 5 and L["guete_je_band"][0]["status"] == "keine Daten, Zwilling extrapoliert" and L["guete_je_band"][1]["minuten"] == 100
              and L["abdeckung"]["extrapoliert_unter_c"] == 0 and "unter 0 °C" in L["abdeckung"]["hinweis"])
        d = L["drift"]
        check("Drift gegen den Champion zeigt roh gelernt (ua 0,15 → roh 1,0: auffällig) und übernommen (abgelehnt: keins)",
              d["gegen"] == "2026-11-01" and d["auffaellig"] == 1 and d["liste"][0]["roh"] == 1.0 and d["liste"][0]["uebernommen"] is None and d["auffaellig_uebernommen"] == 0, json.dumps(d))
        with open(os.path.join(tr, "wp_training.md"), encoding="utf-8") as f:
            md = f.read()
        check("wp_training.md: Entscheidung, Tabelle roh/Kandidat/bisher, Drift mit Spalten „roh gelernt“ und „übernommen“",
              "## Entscheidung: abgelehnt" in md and "| Größe | roh gelernt | Kandidat | bisher (neu bewertet) | Gate |" in md and "| Parameter | Gruppe | vorher | roh gelernt | Δ % roh | übernommen | Δ % übernommen | |" in md)
        rc, args, L = nacht("2026-11-03", erg, STUB_ERGEBNIS="übernommen", STUB_WERT="0.2")
        check("nach einer Ablehnung: Champion bleibt der letzte übernommene Satz (--vorher 2026-11-01), dann übernommen",
              args[args.index("--vorher") + 1].endswith("wp_params_2026-11-01.json") and L["entscheidung"]["ergebnis"] == "übernommen" and L["datei"] == "wp_params_2026-11-03.json"
              and L["drift"]["gegen"] == "2026-11-01" and sha(os.path.join(tr, "wp_params_aktiv.json")) == sha(os.path.join(tr, "wp_params_2026-11-03.json")))
        rc, args, L = nacht("2026-11-03", erg, STUB_ERGEBNIS="abgelehnt", STUB_WERT="0.9")
        check("Wiederholung desselben Tages abgelehnt: dessen wp_params_<tag>.json entfällt, aktiv wieder der Satz vom 01.11.",
              not os.path.exists(os.path.join(tr, "wp_params_2026-11-03.json")) and os.path.exists(os.path.join(tr, "kandidat_2026-11-03.json"))
              and sha(os.path.join(tr, "wp_params_aktiv.json")) == aktiv1 and L["datei"] == "wp_params_2026-11-01.json")

        print("--- status.json (ot.py) aus letzter.json")
        os.environ["OT_ERGEBNIS"] = erg
        os.environ["OT_DATEN"] = daten
        ot = lade_modul("ot", os.path.join(REPO, "docker", "optimizer-tools", "ot.py"))
        S = ot.baue_status()
        T = S["training"]
        check("status.json training: bisherige Felder unverändert (ampel, guete_test, drift, datei)", T["ampel"] in ("gruen", "gelb", "rot") and T["guete_test"]["Strom TOP16 RMSE (W)"] == 20
              and T["datei"] == "training/wp_params_2026-11-01.json" and set(("gegen", "werte", "auffaellig", "liste")) <= set(T["drift"]))
        check("status.json training: neue Felder entscheidung, guete_je_band, abdeckung, glaettung", T["entscheidung"]["ergebnis"] == "abgelehnt" and len(T["guete_je_band"]) == 5
              and T["abdeckung"]["hinweis"].startswith("Zwilling hat unter 0 °C") and T["glaettung"]["anteil"] == 0.333333)
        check("hinweise: Ablehnung und „Zwilling hat unter 0 °C keine Daten“; Ampel nicht strenger (grün bei 20 W / 1,1 K / 8 min)",
              any("abgelehnt" in h for h in S["hinweise"]) and any(h.startswith("Zwilling hat unter 0 °C keine Daten") for h in S["hinweise"]) and T["ampel"] == "gruen", S["hinweise"])
        check("Ampel-Grenzen gleich in ot.py, wp_training_nacht.py und wp_training.js (Gate)", ot.GUETE_GRENZEN == N.AMPEL_GRENZEN and _gate_js() == [40, 1.5, 30], _gate_js())
        os.environ["TRAINING_GLAETTUNG"] = "0.5"
        os.environ["TRAINING_BINDUNG"] = "abc"
        ot2 = lade_modul("ot2", os.path.join(REPO, "docker", "optimizer-tools", "ot.py"))
        c = ot2.cmd_training(__import__("datetime").date(2026, 11, 3))
        check("ot.py: TRAINING_GLAETTUNG wird übergeben, ungültige Werte (TRAINING_BINDUNG=abc) nicht", "--glaettung" in c and c[c.index("--glaettung") + 1] == "0.5" and "--bindung" not in c, c[-4:])

        if len(sys.argv) > 1:
            quelle = sys.argv[1]
            print("--- zwei echte Nächte mit node wp_training.js (%s)" % quelle)
            erg2 = os.path.join(tmp, "echt")
            r1 = N.main(["--daten", quelle, "--ergebnis", erg2, "--tag", "2026-10-16"])
            r2 = N.main(["--daten", quelle, "--ergebnis", erg2, "--tag", "2026-10-17"])
            with open(os.path.join(erg2, "training", "letzter.json"), encoding="utf-8") as f:
                L = json.load(f)
            check("echte Daten: beide Nächte rc 0, zweite mit Entscheidung gegen 2026-10-16, Güte je Band, Abdeckung",
                  r1 == 0 and r2 == 0 and L["entscheidung"]["bisher_tag"] == "2026-10-16" and len(L["guete_je_band"]) == 5 and L["abdeckung"]["tage"] >= 10,
                  "%s, %s s" % (L["entscheidung"]["ergebnis"], L["dauer_s"]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n%d OK, %d FAIL" % (OKS, FAILS))
    return 1 if FAILS else 0


def _gate_js():
    try:
        r = subprocess.run(["node", "-e", "console.log(JSON.stringify(require(process.argv[1]).GATE.kennzahlen.map(k => k.grenze)))", os.path.join(HIER, "wp_training.js")],
                           capture_output=True, timeout=60, check=False)
        return json.loads(r.stdout.decode())
    except (OSError, ValueError):
        return None


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Nächtliches Training des Anlagen-Zwillings (nur Standardbibliothek).

Ablauf (nur lesend gegenüber der Anlage, der NAS und MQTT):
1. Protokolle holen: aus einem lokalen Ordner (--quelle) oder per ssh wie der Bonsai-Beobachter
   (ssh -o BatchMode=yes 10.10.10.128 docker exec node_red-node-red-1 cat /data/optimizer/<datei>) in einen Arbeitsordner.
   Geholt werden quiet-, optimizer-v2- und energy-JJJJ-MM.csv des laufenden und (in den ersten 21 Tagen) des Vormonats.
2. Training: node wp_training.js <ordner> --tage 21 (letzte 21 Kalendertage, Test = letzte 4 Tage) → wp_params_<tag>.json.
3. Parameterdrift gegen den letzten älteren Lauf (wp_params_<datum>.json im Ausgabeordner): Tabelle je Parameter, Δ und Δ %,
   Markierung ab 10 % (bei Werten nahe 0: ab 0,05 absolut), dazu die Güte heute gegen damals.
4. Ausgabe: <ausgabe>/wp_params_<tag>.json und <ausgabe>/wp_training.md (wird je Lauf überschrieben; der Tag steht im Kopf).

Das lokale Sprachmodell „Bonsai“ fittet nichts: Die Parameter schätzt dieses Skript (über wp_training.js) deterministisch.
Bonsai kann höchstens den fertigen Bericht wp_training.md lesen und kommentieren.

Container „optimizer-tools“ auf der NAS (docker/optimizer-tools): --daten <ordner> --ergebnis <ordner>
   liest nur die Monatsdateien des Trainingsfensters aus dem (nur lesend eingehängten) Datenordner, nur Namen nach DATEI_MUSTER
   (andere Dateien wie owm.json/vrm.json werden nie geöffnet), und schreibt nach <ergebnis>/training/:
   wp_params_<tag>.json, wp_training.md und letzter.json (Kurzfassung für status.json: Güte, Drift, Fehler).

Beispiele:
  python3 tools/wp_training_nacht.py --quelle ~/Kopien/replay_data_1510 --tag 2026-10-15
  python3 tools/wp_training_nacht.py --ssh
  python3 tools/wp_training_nacht.py --daten /daten --ergebnis /ergebnis
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HIER = os.path.dirname(os.path.abspath(__file__))
AUSGABE_STANDARD = os.path.expanduser("~/Dokumente/heishamonr-optimizer/bonsai-berichte")
SSH_VORLAGE = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "10.10.10.128", "docker", "exec", "node_red-node-red-1", "cat", "/data/optimizer/{datei}"]
DATEI_MUSTER = re.compile(r"^(quiet|optimizer-v2|energy)-\d{4}-\d{2}\.csv$")
PRAEFIXE = ("quiet", "optimizer-v2", "energy")
DRIFT_REL = 0.10
DRIFT_ABS = 0.05
AUFBEWAHREN = 120                                  # wp_params_<datum>.json im Ergebnisordner: so viele behalten (je ~50 kB)


def monate(tag, tage_zurueck=21):
    """Laufender Monat und, falls das Trainingsfenster hineinreicht, der Vormonat (JJJJ-MM)."""
    erster = (tag - dt.timedelta(days=tage_zurueck - 1)).strftime("%Y-%m")
    jetzt = tag.strftime("%Y-%m")
    return [erster, jetzt] if erster != jetzt else [jetzt]


def hole_ssh(ordner, monatsliste, timeout=180):
    geholt = []
    for mo in monatsliste:
        for pre in PRAEFIXE:
            datei = "%s-%s.csv" % (pre, mo)
            if not DATEI_MUSTER.match(datei):
                raise ValueError("unerlaubter Dateiname: " + datei)
            cmd = [x.replace("{datei}", datei) for x in SSH_VORLAGE]
            try:
                r = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
            except (OSError, subprocess.TimeoutExpired) as e:
                raise RuntimeError("ssh fehlgeschlagen für %s: %s" % (datei, e))
            if r.returncode != 0:
                if pre == "quiet" and mo == monatsliste[-1]:
                    raise RuntimeError("ssh: %s nicht lesbar (%s)" % (datei, r.stderr.decode("utf-8", "replace").strip()[:200]))
                continue
            with open(os.path.join(ordner, datei), "wb") as f:
                f.write(r.stdout)
            geholt.append(datei)
    return geholt


def kopiere(quelle, ordner):
    geholt = []
    for f in sorted(os.listdir(quelle)):
        if DATEI_MUSTER.match(f):
            shutil.copyfile(os.path.join(quelle, f), os.path.join(ordner, f))
            geholt.append(f)
    if not any(f.startswith("quiet-") for f in geholt):
        raise RuntimeError("keine quiet-*.csv in " + quelle)
    return geholt


def kopiere_monate(quelle, ordner, monatsliste):
    """Nur die Monatsdateien des Trainingsfensters, Namen fest gebildet und gegen DATEI_MUSTER geprüft (kein Auflisten des Ordners)."""
    if not os.path.isdir(quelle):
        raise RuntimeError("Datenordner fehlt: " + quelle)
    geholt = []
    for mo in monatsliste:
        for pre in PRAEFIXE:
            datei = "%s-%s.csv" % (pre, mo)
            if not DATEI_MUSTER.match(datei):
                raise ValueError("unerlaubter Dateiname: " + datei)
            p = os.path.join(quelle, datei)
            if not os.path.isfile(p):
                if pre == "quiet" and mo == monatsliste[-1]:
                    raise RuntimeError("%s fehlt im Datenordner" % datei)
                continue
            shutil.copyfile(p, os.path.join(ordner, datei))
            geholt.append(datei)
    return geholt


def schreibe_atomar(pfad, text):
    tmp = pfad + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, pfad)


def aufraeumen(ausgabe, behalten=AUFBEWAHREN):
    alte = sorted(f for f in os.listdir(ausgabe) if re.match(r"^wp_params_\d{4}-\d{2}-\d{2}\.json$", f))
    for f in alte[:-behalten] if behalten > 0 else []:
        os.unlink(os.path.join(ausgabe, f))


def kurz_json(gk):
    return {k: (list(v) if isinstance(v, tuple) else v) for k, v in gk.items()}


def flach(x, praefix=""):
    """Parameterwerte in (Name, Zahl) zerlegen: Listen und Objekte mit Index/Schlüssel."""
    if isinstance(x, bool):
        return [(praefix, float(x))]
    if isinstance(x, (int, float)):
        return [(praefix, float(x))]
    if isinstance(x, list):
        out = []
        for i, v in enumerate(x):
            out += flach(v, "%s[%d]" % (praefix, i))
        return out
    if isinstance(x, dict):
        out = []
        for k in sorted(x):
            out += flach(x[k], "%s.%s" % (praefix, k) if praefix else k)
        return out
    return []


def zahl(v, n=3):
    if v is None:
        return "–"
    s = ("%." + str(n) + "f") % v
    return s.replace(".", ",").replace("-", "−")


def drift(alt, neu, herkunft):
    a = dict(flach(alt))
    zeilen = []
    for name, wn in flach(neu):
        basis = name.split(".")[0].split("[")[0]
        h = herkunft.get(basis, {})
        if not h.get("fit"):
            continue                                   # nur gefittete/kalibrierte Parameter (Forum/Handbuch/Annahme bleiben fest)
        if re.match(r"^raeume\.\w+\[[5-8]\]$", name):
            continue                                   # Datenbereich der Raum-Merkmale, kein Parameter
        wa = a.get(name)
        d = None if wa is None else wn - wa
        rel = None if (wa is None or abs(wa) < 1e-9) else d / abs(wa)
        auff = d is not None and abs(d) > DRIFT_ABS and (rel is None or abs(rel) > DRIFT_REL)
        zeilen.append((name, wa, wn, d, rel, auff, h.get("gruppe", "")))
    return zeilen


def guete_kurz(g):
    t = g["teil"]
    z = g["zyklenHausSimuliert"]
    f = g.get("freilaufSumme") or {}
    return {
        "Strom TOP16 RMSE (W)": t.get("pelRmseW"),
        "Wärme RMSE (W)": t.get("pthRmseW"),
        "Regler RMSE (Hz)": t.get("reglerRmseHz"),
        "Wasserkreis RMSE (K)": t.get("wasserkreisRmseK"),
        "Hausmittel RMSE (K)": t.get("hausRmseK"),
        "Pause Median-Fehler (min)": z["pause"].get("medianAbsMin"),
        "Lauf Median-Fehler (min)": z["lauf"].get("medianAbsMin"),
        "Freilauf kWh el Zwilling/Messung": (f.get("kwhElZwilling"), f.get("kwhElMessung")),
    }


def letzter_alter(ausgabe, tag):
    beste = None
    for f in os.listdir(ausgabe):
        m = re.match(r"^wp_params_(\d{4}-\d{2}-\d{2})\.json$", f)
        if m and m.group(1) < tag and (beste is None or m.group(1) > beste[0]):
            beste = (m.group(1), os.path.join(ausgabe, f))
    return beste


def bericht(tag, R, alt, zeilen, training_md, quelle_txt):
    L = ["# Nächtliches Training des Anlagen-Zwillings – %s" % tag, ""]
    L.append("Daten: %s, %s bis %s (%d Minuten, %d Läufe); Training %s, Test %s. Quelle: %s." % (
        R["daten"]["ordner"], R["daten"]["von"], R["daten"]["bis"], R["daten"]["minuten"], R["daten"]["laeufe"],
        " … ".join(R["trennung"]["training"]), " … ".join(R["trennung"]["test"]), quelle_txt))
    L.append("")
    L.append("Die Parameter schätzt `wp_training.js` deterministisch (kleinste Quadrate, Rastersuche, Koordinatensuche). "
             "Das Sprachmodell Bonsai fittet nichts; es kann diesen Bericht höchstens lesen und kommentieren.")
    L.append("")
    L.append("## Güte (Test, Parameter aus den Trainingstagen)")
    L.append("")
    gk = guete_kurz(R["guete"]["test"])
    ga = guete_kurz(alt[1]["guete"]["test"]) if alt else None
    L.append("| Größe | heute | %s |" % (("Lauf " + alt[0]) if alt else "vorher"))
    L.append("|---|---|---|")
    for k, v in gk.items():
        va = ga.get(k) if ga else None
        fmt = lambda x: "–" if x is None else (" / ".join(zahl(y, 2) for y in x) if isinstance(x, tuple) else zahl(x, 2))
        L.append("| %s | %s | %s |" % (k, fmt(v), fmt(va)))
    L.append("")
    if alt:
        auff = [z for z in zeilen if z[5]]
        L.append("## Parameterdrift gegen %s (gefittete Parameter; auffällig: > %d %% und > %s absolut)" % (alt[0], int(DRIFT_REL * 100), zahl(DRIFT_ABS, 2)))
        L.append("")
        L.append("%d von %d Werten auffällig." % (len(auff), len(zeilen)))
        L.append("")
        L.append("| Parameter | Gruppe | vorher | heute | Δ | Δ % | |")
        L.append("|---|---|---|---|---|---|---|")
        for name, wa, wn, d, rel, a, gr in sorted(zeilen, key=lambda z: (not z[5], z[0])):
            L.append("| `%s` | %s | %s | %s | %s | %s | %s |" % (name, gr, zahl(wa, 4), zahl(wn, 4), zahl(d, 4), "–" if rel is None else zahl(100 * rel, 1), "**auffällig**" if a else ""))
        L.append("")
    else:
        L.append("## Parameterdrift")
        L.append("")
        L.append("Kein älterer Lauf im Ausgabeordner: erster Lauf, keine Drift-Tabelle.")
        L.append("")
    L.append("---")
    L.append("")
    L.append(training_md)
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Nächtliches Training des Anlagen-Zwillings (nur lesen)")
    ap.add_argument("--quelle", help="Ordner mit Kopien der Protokolle (sonst --ssh)")
    ap.add_argument("--ssh", action="store_true", help="per ssh + docker exec cat lesen (nur lesen)")
    ap.add_argument("--tag", help="JJJJ-MM-TT (Standard: heute)")
    ap.add_argument("--tage", type=int, default=21, help="Trainingsfenster in Kalendertagen (Standard 21)")
    ap.add_argument("--ausgabe", default=AUSGABE_STANDARD)
    ap.add_argument("--daten", help="Container: Datenordner (nur lesend), nur Monatsdateien des Trainingsfensters")
    ap.add_argument("--ergebnis", help="Container: Ergebnisordner; Ausgabe nach <ergebnis>/training/ (ersetzt --ausgabe), dazu letzter.json")
    ap.add_argument("--node", default=shutil.which("node") or "/usr/bin/node")
    a = ap.parse_args(argv)
    if sum(1 for x in (a.quelle, a.ssh, a.daten) if x) != 1:
        ap.error("genau eins von --quelle, --ssh oder --daten angeben")
    if a.ergebnis:
        a.ausgabe = os.path.join(a.ergebnis, "training")
    tag = dt.date.fromisoformat(a.tag) if a.tag else dt.date.today()
    tag_s = tag.isoformat()
    os.makedirs(a.ausgabe, exist_ok=True)
    beginn = time.time()
    kurz = {"tag": tag_s, "ok": False, "fehler": None, "datei": "wp_params_%s.json" % tag_s}
    basis = tempfile.mkdtemp(prefix="wp_training_")
    arbeit = os.path.join(basis, "protokolle_" + tag_s)            # fester Ordnername: gleiche Daten → bit-identische Ausgabe
    os.makedirs(arbeit)
    try:
        if a.daten:
            geholt = kopiere_monate(a.daten, arbeit, monate(tag, a.tage))
            quelle_txt = "Datenordner %s, nur lesend (%s)" % (a.daten, ", ".join(geholt))
        elif a.quelle:
            geholt = kopiere(a.quelle, arbeit)
            quelle_txt = "Kopien aus %s (%s)" % (a.quelle, ", ".join(geholt))
        else:
            geholt = hole_ssh(arbeit, monate(tag, a.tage))
            quelle_txt = "ssh 10.10.10.128 (nur lesen: %s)" % ", ".join(geholt)
        js = os.path.join(a.ausgabe, "wp_params_%s.json" % tag_s)
        md_tmp = os.path.join(arbeit, "training.md")
        cmd = [a.node, os.path.join(HIER, "wp_training.js"), arbeit, "--tage", str(a.tage), "--json", js, "--md", md_tmp, "--still"]
        r = subprocess.run(cmd, capture_output=True, timeout=600, check=False)
        if r.returncode != 0:
            raise RuntimeError("wp_training.js fehlgeschlagen: " + r.stderr.decode("utf-8", "replace")[-800:])
        with open(js, encoding="utf-8") as f:
            R = json.load(f)
        with open(md_tmp, encoding="utf-8") as f:
            training_md = f.read().replace("# Anlagen-Zwilling Leisha WH-WDG05LE5: Training", "## Trainingsbericht")
        alt = letzter_alter(a.ausgabe, tag_s)
        alt_r = None
        if alt:
            with open(alt[1], encoding="utf-8") as f:
                alt_r = (alt[0], json.load(f))
        zeilen = drift(alt_r[1]["werte"], R["werte"], R["herkunft"]) if alt_r else []
        with open(os.path.join(a.ausgabe, "wp_training.md"), "w", encoding="utf-8") as f:
            f.write(bericht(tag_s, R, alt_r, zeilen, training_md, quelle_txt))
        print("wp_params_%s.json und wp_training.md geschrieben (%s); auffällige Drift: %d" % (tag_s, a.ausgabe, sum(1 for z in zeilen if z[5])))
        if a.ergebnis:
            kurz.update({"ok": True, "daten": R["daten"], "trennung": R["trennung"], "guete_test": kurz_json(guete_kurz(R["guete"]["test"])),
                         "guete_training": kurz_json(guete_kurz(R["guete"]["training"])) if "training" in R["guete"] else None,
                         "vorher": alt_r[0] if alt_r else None, "guete_test_vorher": kurz_json(guete_kurz(alt_r[1]["guete"]["test"])) if alt_r else None,
                         "drift": {"gegen": alt_r[0] if alt_r else None, "werte": len(zeilen), "auffaellig": sum(1 for z in zeilen if z[5]),
                                   "liste": [{"name": z[0], "vorher": z[1], "heute": z[2], "rel": None if z[4] is None else round(z[4], 4)} for z in zeilen if z[5]]}})
            aufraeumen(a.ausgabe)
        return 0
    except Exception as e:                                     # Bericht trotzdem schreiben, damit der Beobachter den Fehler sieht
        with open(os.path.join(a.ausgabe, "wp_training.md"), "w", encoding="utf-8") as f:
            f.write("# Nächtliches Training des Anlagen-Zwillings – %s\n\n**Fehler:** %s\n" % (tag_s, e))
        print("Fehler: %s" % e, file=sys.stderr)
        kurz["fehler"] = str(e)[:500]
        return 1
    finally:
        shutil.rmtree(basis, ignore_errors=True)
        if a.ergebnis:
            kurz["dauer_s"] = round(time.time() - beginn, 1)
            schreibe_atomar(os.path.join(a.ausgabe, "letzter.json"), json.dumps(kurz, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Nächtliches Training des Anlagen-Zwillings (nur Standardbibliothek).

Ablauf (nur lesend gegenüber der Anlage, der NAS und MQTT):
1. Protokolle holen: aus einem lokalen Ordner (--quelle) oder per ssh wie der Bonsai-Beobachter
   (ssh -o BatchMode=yes 10.10.10.128 docker exec node_red-node-red-1 cat /data/optimizer/<datei>) in einen Arbeitsordner.
   Geholt werden quiet-, optimizer-v2- und energy-JJJJ-MM.csv des laufenden und (in den ersten 21 Tagen) des Vormonats.
2. Training: node wp_training.js <ordner> --tage 21 (letzte 21 Kalendertage, Test = letzte 4 Tage) --vorher <bisher aktiver Satz>.
   training-v2 (18.10.2026):
   a) Glättung: übernommen = bisher + Anteil · (roh gelernt − bisher), Standard 1/3 je Nacht (--glaettung).
   b) Bindung: in der Dünn-Daten-Phase (unter 21 Tagen oder unter 3 Außentemperatur-Bändern mit je ≥ 300 Laufminuten) zieht jeder Fit
      zu den bisherigen Werten (Regularisierung, Gewicht --bindung, Standard 0,1; 0 = aus).
   c) Gate: Der geglättete Kandidat und der bisherige Satz werden auf denselben Testtagen mit demselben Datenstand bewertet.
      Übernommen nur, wenn Strom-RMSE, Wasserkreis-RMSE und Pause-Median nicht um mehr als 10 % (--gate-rel; mindestens 0,5 W / 0,02 K / 1 min)
      schlechter werden und keine Kennzahl über die Ampelgrenze steigt, die der bisherige Satz einhält.
      Übernommen → wp_params_<tag>.json und wp_params_aktiv.json; abgelehnt → kandidat_<tag>.json, aktiv bleibt der bisherige Satz.
3. Parameterdrift gegen den bisher aktiven Satz (jüngste ältere wp_params_<datum>.json): je Parameter vorher, roh gelernt, übernommen,
   Markierung ab 10 % (bei Werten nahe 0: ab 0,05 absolut) für den roh gelernten Wert, dazu die Güte heute gegen damals.
4. Ausgabe: <ausgabe>/wp_params_<tag>.json bzw. kandidat_<tag>.json und <ausgabe>/wp_training.md (je Lauf überschrieben; der Tag steht im Kopf).

Das lokale Sprachmodell „Bonsai“ fittet nichts: Die Parameter schätzt dieses Skript (über wp_training.js) deterministisch.
Bonsai kann höchstens den fertigen Bericht wp_training.md lesen und kommentieren.

Container „optimizer-tools“ auf der NAS (docker/optimizer-tools): --daten <ordner> --ergebnis <ordner>
   liest nur die Monatsdateien des Trainingsfensters aus dem (nur lesend eingehängten) Datenordner, nur Namen nach DATEI_MUSTER
   (andere Dateien wie owm.json/vrm.json werden nie geöffnet), und schreibt nach <ergebnis>/training/:
   wp_params_<tag>.json (bzw. kandidat_<tag>.json), wp_params_aktiv.json, wp_training.md und letzter.json
   (Kurzfassung für status.json: Güte des aktiven Satzes, Entscheidung, Güte je Außentemperatur-Band, Abdeckung, Drift, Fehler).

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
AUFBEWAHREN = 120                                  # wp_params_<datum>.json im Ergebnisordner: so viele behalten (je ~50 kB); kandidat_<datum>.json ebenso
GLAETTUNG = 1.0 / 3                                # Anteil der neu gelernten Werte je Nacht
BINDUNG = 0.1                                      # Gewicht der Bindung an die Vorwerte in der Dünn-Daten-Phase (0 = aus)
GATE_REL = 0.10                                    # Gate: höchstens so viel relative Verschlechterung je Ampel-Kennzahl
AMPEL_GRENZEN = {"Strom TOP16 RMSE (W)": 40.0, "Wasserkreis RMSE (K)": 1.5, "Pause Median-Fehler (min)": 30.0}   # = GUETE_GRENZEN in ot.py und GATE in wp_training.js


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
    for muster in (r"^wp_params_\d{4}-\d{2}-\d{2}\.json$", r"^kandidat_\d{4}-\d{2}-\d{2}\.json$"):
        alte = sorted(f for f in os.listdir(ausgabe) if re.match(muster, f))
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


def drift(alt, neu, herkunft, roh=None):
    """Zeilen (Name, vorher, übernommen, Δ, Δ rel, auffällig, Gruppe, roh gelernt, Δ rel roh). Auffällig wird die roh gelernte Änderung
    (das Signal der Daten); ohne roh (alter Lauf) die Änderung von neu."""
    a = dict(flach(alt))
    r = dict(flach(roh)) if roh is not None else None
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
        wr = r.get(name, wn) if r is not None else wn
        dr = None if wa is None else wr - wa
        relr = None if (wa is None or abs(wa) < 1e-9) else dr / abs(wa)
        auff = dr is not None and abs(dr) > DRIFT_ABS and (relr is None or abs(relr) > DRIFT_REL)
        zeilen.append((name, wa, wn, d, rel, auff, h.get("gruppe", ""), wr, relr))
    return zeilen


def auffaellig_uebernommen(zeilen):
    return sum(1 for z in zeilen if z[3] is not None and abs(z[3]) > DRIFT_ABS and (z[4] is None or abs(z[4]) > DRIFT_REL))


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


def band_kurz(baender):
    """Güte je Außentemperatur-Band (Test) für status.json: Minuten, Status und die Kennzahlen je Band."""
    out = []
    for b in baender or []:
        out.append({"band": b.get("band"), "name": b.get("name"), "minuten": b.get("minuten"), "laufminuten": b.get("laufMinuten"), "status": b.get("status"),
                    "Strom TOP16 RMSE (W)": (b.get("strom") or {}).get("rmseW"), "Wärme RMSE (W)": (b.get("waerme") or {}).get("rmseW"),
                    "Regler RMSE (Hz)": (b.get("regler") or {}).get("rmseHz"), "Wasserkreis RMSE (K)": (b.get("wasserkreis") or {}).get("rmseK"),
                    "Hausmittel RMSE (K)": (b.get("haus") or {}).get("rmseK"), "Pause Median-Fehler (min)": (b.get("pause") or {}).get("medianAbsMin"),
                    "Lauf Median-Fehler (min)": (b.get("lauf") or {}).get("medianAbsMin"), "n_pausen": (b.get("pause") or {}).get("n"), "n_laeufe": (b.get("lauf") or {}).get("n")})
    return out


def abdeckung_kurz(a):
    if not a:
        return None
    return {"tage": a.get("tage"), "duenn": a.get("duenn"), "grund": a.get("grund"), "baender_ausreichend": a.get("baenderAusreichend"),
            "at_min": a.get("atMin"), "at_max": a.get("atMax"), "extrapoliert_unter_c": a.get("extrapoliertUnterC"), "hinweis": a.get("hinweis"),
            "kriterien": a.get("kriterien"),
            "baender": [{"band": b.get("band"), "name": b.get("name"), "minuten": b.get("minuten"), "laufminuten": b.get("laufMinuten"), "tage": b.get("tage"), "status": b.get("status")} for b in a.get("baender") or []]}


def letzter_alter(ausgabe, tag):
    beste = None
    for f in os.listdir(ausgabe):
        m = re.match(r"^wp_params_(\d{4}-\d{2}-\d{2})\.json$", f)
        if m and m.group(1) < tag and (beste is None or m.group(1) > beste[0]):
            beste = (m.group(1), os.path.join(ausgabe, f))
    return beste


def bericht(tag, R, alt, zeilen, training_md, quelle_txt, ent=None):
    L = ["# Nächtliches Training des Anlagen-Zwillings – %s" % tag, ""]
    L.append("Daten: %s, %s bis %s (%d Minuten, %d Läufe); Training %s, Test %s. Quelle: %s." % (
        R["daten"]["ordner"], R["daten"]["von"], R["daten"]["bis"], R["daten"]["minuten"], R["daten"]["laeufe"],
        " … ".join(R["trennung"]["training"]), " … ".join(R["trennung"]["test"]), quelle_txt))
    L.append("")
    L.append("Die Parameter schätzt `wp_training.js` deterministisch (kleinste Quadrate, Rastersuche, Koordinatensuche). "
             "Das Sprachmodell Bonsai fittet nichts; es kann diesen Bericht höchstens lesen und kommentieren.")
    L.append("")
    fmt = lambda x: "–" if x is None else (" / ".join(zahl(y, 2) for y in x) if isinstance(x, tuple) else zahl(x, 2))
    if ent:
        L.append("## Entscheidung: %s" % ent["ergebnis"])
        L.append("")
        L.append(ent["grund"] + ".")
        L.append("")
        if ent.get("bisher"):
            L.append("Kandidat (geglättet, Anteil %s) gegen den bisherigen Satz vom %s, beide neu bewertet auf den Testtagen %s." % (
                zahl(ent.get("glaettung"), 3), ent.get("bisher_tag"), " … ".join(R["trennung"]["test"])))
            L.append("")
            L.append("| Größe | roh gelernt | Kandidat | bisher (neu bewertet) | Gate |")
            L.append("|---|---|---|---|---|")
            gate = {k["name"]: k for k in ent.get("kennzahlen") or []}
            for k in ent["kandidat"]:
                g = gate.get(k)
                L.append("| %s | %s | %s | %s | %s |" % (k, fmt(ent["roh"].get(k)), fmt(ent["kandidat"].get(k)), fmt(ent["bisher"].get(k)),
                                                    "–" if not g else ("**verletzt:** " + g["warum"] if g.get("verletzt") else ("ok" if not g.get("warum") else g["warum"]))))
            L.append("")
        L.append("Aktiver Satz: `%s`." % ent["aktiv"])
        L.append("")
    L.append("## Güte des aktiven Satzes (Test, Parameter aus den Trainingstagen)")
    L.append("")
    gk = ent["aktiv_guete"] if ent else guete_kurz(R["guete"]["test"])
    ga = guete_kurz(alt[1]["guete"]["test"]) if alt else None
    L.append("| Größe | heute | %s |" % (("Lauf " + alt[0]) if alt else "vorher"))
    L.append("|---|---|---|")
    for k, v in gk.items():
        va = ga.get(k) if ga else None
        L.append("| %s | %s | %s |" % (k, fmt(v), fmt(va)))
    L.append("")
    if alt:
        auff = [z for z in zeilen if z[5]]
        L.append("## Parameterdrift gegen %s (gefittete Parameter; auffällig: roh gelernt > %d %% und > %s absolut)" % (alt[0], int(DRIFT_REL * 100), zahl(DRIFT_ABS, 2)))
        L.append("")
        L.append("%d von %d Werten roh auffällig, %d nach der Glättung. „übernommen“ gilt nur, wenn die Entscheidung „übernommen“ lautet." % (len(auff), len(zeilen), auffaellig_uebernommen(zeilen)))
        L.append("")
        L.append("| Parameter | Gruppe | vorher | roh gelernt | Δ % roh | übernommen | Δ % übernommen | |")
        L.append("|---|---|---|---|---|---|---|---|")
        for name, wa, wn, d, rel, a, gr, wr, relr in sorted(zeilen, key=lambda z: (not z[5], z[0])):
            L.append("| `%s` | %s | %s | %s | %s | %s | %s | %s |" % (name, gr, zahl(wa, 4), zahl(wr, 4), "–" if relr is None else zahl(100 * relr, 1),
                                                           zahl(wn, 4), "–" if rel is None else zahl(100 * rel, 1), "**auffällig**" if a else ""))
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
    ap.add_argument("--glaettung", type=float, default=GLAETTUNG, help="Anteil der neu gelernten Werte je Nacht (Standard 1/3; 1 = ersetzen)")
    ap.add_argument("--bindung", type=float, default=BINDUNG, help="Gewicht der Bindung an die Vorwerte in der Dünn-Daten-Phase (Standard 0,1; 0 = aus)")
    ap.add_argument("--gate-rel", type=float, default=GATE_REL, help="Gate: erlaubte relative Verschlechterung je Ampel-Kennzahl (Standard 0,10)")
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
        js_kand = os.path.join(a.ausgabe, "kandidat_%s.json" % tag_s)
        js_tmp = os.path.join(arbeit, "ergebnis.json")
        md_tmp = os.path.join(arbeit, "training.md")
        alt = letzter_alter(a.ausgabe, tag_s)                  # Champion: jüngster älterer übernommener Satz (abgelehnte liegen als kandidat_<tag>.json daneben)
        alt_r = None
        if alt:
            with open(alt[1], encoding="utf-8") as f:
                alt_r = (alt[0], json.load(f))
        cmd = [a.node, os.path.join(HIER, "wp_training.js"), arbeit, "--tage", str(a.tage), "--json", js_tmp, "--md", md_tmp, "--still",
               "--glaettung", repr(a.glaettung), "--bindung", repr(a.bindung), "--gate-rel", repr(a.gate_rel)]
        if alt_r:
            cmd += ["--vorher", alt[1], "--vorher-tag", alt[0]]
        r = subprocess.run(cmd, capture_output=True, timeout=600, check=False)
        if r.returncode != 0:
            raise RuntimeError("wp_training.js fehlgeschlagen: " + r.stderr.decode("utf-8", "replace")[-800:])
        with open(js_tmp, encoding="utf-8") as f:
            R = json.load(f)
        with open(md_tmp, encoding="utf-8") as f:
            training_md = f.read().replace("# Anlagen-Zwilling Leisha WH-WDG05LE5: Training", "## Trainingsbericht")
        E = R.get("entscheidung") or {"ergebnis": "übernommen", "grund": "ohne Gate (altes wp_training.js)", "kennzahlen": []}
        uebernommen = E.get("ergebnis") != "abgelehnt" or alt_r is None or not R.get("vorherNeu")   # ohne bisherigen Satz gibt es nichts zu behalten
        g_kand = guete_kurz(R["guete"]["test"])
        g_bisher = guete_kurz(R["vorherNeu"]["guete"]["test"]) if R.get("vorherNeu") else None
        g_roh = guete_kurz(R["roh"]["guete"]["test"]) if R.get("roh") else g_kand
        if uebernommen:
            shutil.copyfile(js_tmp, js + ".tmp")
            os.replace(js + ".tmp", js)
            shutil.copyfile(js_tmp, os.path.join(a.ausgabe, "wp_params_aktiv.json.tmp"))
            os.replace(os.path.join(a.ausgabe, "wp_params_aktiv.json.tmp"), os.path.join(a.ausgabe, "wp_params_aktiv.json"))
            if os.path.exists(js_kand):                        # Wiederholung desselben Tages: alter Kandidat ist überholt
                os.unlink(js_kand)
            aktiv_datei, aktiv_tag = os.path.basename(js), tag_s
            aktiv_guete = g_kand
            aktiv_baender = R["guete"]["test"].get("jeBand")
            aktiv_training = guete_kurz(R["guete"]["training"]) if "training" in R["guete"] else None
        else:
            shutil.copyfile(js_tmp, js_kand + ".tmp")
            os.replace(js_kand + ".tmp", js_kand)
            if os.path.exists(js):                             # Wiederholung desselben Tages: vorher übernommener Satz gilt nicht mehr
                os.unlink(js)
            aktiv_datei, aktiv_tag = os.path.basename(alt[1]), alt[0]
            shutil.copyfile(alt[1], os.path.join(a.ausgabe, "wp_params_aktiv.json.tmp"))      # aktiv bleibt der bisherige Satz
            os.replace(os.path.join(a.ausgabe, "wp_params_aktiv.json.tmp"), os.path.join(a.ausgabe, "wp_params_aktiv.json"))
            aktiv_guete = g_bisher
            aktiv_baender = R["vorherNeu"]["guete"]["test"].get("jeBand")
            aktiv_training = guete_kurz(alt_r[1]["guete"]["training"]) if "training" in alt_r[1].get("guete", {}) else None
        ent = {"ergebnis": E.get("ergebnis"), "grund": E.get("grund"), "aktiv": aktiv_datei, "aktiv_tag": aktiv_tag, "aktiv_guete": aktiv_guete,
               "kandidat_datei": os.path.basename(js if uebernommen else js_kand), "bisher_tag": alt_r[0] if alt_r else None,
               "kriterium": E.get("kriterium"), "kennzahlen": E.get("kennzahlen"), "glaettung": (R.get("glaettung") or {}).get("anteil"),
               "bindung": (R.get("glaettung") or {}).get("bindung"), "kandidat": g_kand, "bisher": g_bisher, "roh": g_roh}
        zeilen = drift(alt_r[1]["werte"], R["werte"], R["herkunft"], (R.get("roh") or {}).get("werte")) if alt_r else []
        with open(os.path.join(a.ausgabe, "wp_training.md"), "w", encoding="utf-8") as f:
            f.write(bericht(tag_s, R, alt_r, zeilen, training_md, quelle_txt, ent))
        print("%s und wp_training.md geschrieben (%s); Entscheidung: %s; auffällige Drift: %d" % (ent["kandidat_datei"], a.ausgabe, ent["ergebnis"], sum(1 for z in zeilen if z[5])))
        if a.ergebnis:
            kurz.update({"ok": True, "datei": aktiv_datei, "daten": R["daten"], "trennung": R["trennung"], "guete_test": kurz_json(aktiv_guete),
                         "guete_training": kurz_json(aktiv_training) if aktiv_training else None,
                         "vorher": alt_r[0] if alt_r else None, "guete_test_vorher": kurz_json(guete_kurz(alt_r[1]["guete"]["test"])) if alt_r else None,
                         "drift": {"gegen": alt_r[0] if alt_r else None, "werte": len(zeilen), "auffaellig": sum(1 for z in zeilen if z[5]),
                                   "auffaellig_uebernommen": auffaellig_uebernommen(zeilen) if uebernommen else 0,
                                   "liste": [{"name": z[0], "vorher": z[1], "heute": z[2] if uebernommen else z[1], "roh": z[7], "uebernommen": z[2] if uebernommen else None,
                                              "rel": None if z[8] is None else round(z[8], 4), "rel_uebernommen": None if (z[4] is None or not uebernommen) else round(z[4], 4)} for z in zeilen if z[5]]},
                         "entscheidung": {"ergebnis": ent["ergebnis"], "grund": ent["grund"], "aktiv": aktiv_datei, "aktiv_tag": aktiv_tag, "kandidat_datei": ent["kandidat_datei"],
                                          "bisher_tag": ent["bisher_tag"], "kandidat": kurz_json(g_kand), "bisher": kurz_json(g_bisher) if g_bisher else None, "roh": kurz_json(g_roh),
                                          "kriterium": ent["kriterium"], "verletzt": [k["name"] for k in ent["kennzahlen"] or [] if k.get("verletzt")]},
                         "glaettung": {"anteil": ent["glaettung"], "bindung": ent["bindung"]},
                         "guete_je_band": band_kurz(aktiv_baender), "abdeckung": abdeckung_kurz(R.get("abdeckung"))})
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

#!/usr/bin/env python3
"""Tests für tools/gesundheit_tag.py (Anlagen-Gesundheit).

1. Synthetische Anlage (30 Tage, Minutenwerte mit Rauschen und 0,25-K-Rundung): ohne Störung kein Hinweis/keine Warnung;
   mit je einer eingebauten Störung ab Tag 22 meldet genau die passende Prüfung, und nicht vor Tag 24 (5-Tage-Median, mindestens 3 Tage).
2. Mit Datenordner (Kopie von /data/optimizer): echte Tage ohne Befund (Fehlalarm-Probe), und dieselben Störungen in die echten Daten
   eingebaut werden erkannt.

  python3 tools/gesundheit_tag_test.py [Datenordner]
"""
import csv
import datetime as dt
import io
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile

HIER = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HIER)
import gesundheit_tag as G  # noqa: E402

OKS, FAILS = 0, 0
SPALTEN = ["zeit", "quiet_aktuell", "soll_vl", "ist_vl", "ist_rl", "verdichter_hz", "leistung_el_w", "leistung_th_heisha_w", "flow_l_min", "pumpe_duty",
           "pumpe_speed", "fan1", "aussen", "defrost", "warmwasser", "heizregelung", "heizstab_intern", "zustand", "rohr_aussen", "rohr_innen",
           "verdampfer_aus", "heissgas", "expansionsventil", "druck_bar", "zaehler_wp_w"]
START = dt.date(2026, 9, 1)
TAGE = 30
STOER_AB = 22
# Störung -> (Prüfung, Veränderung der Zeile)
STOERUNGEN = {
    "fuehler": ("fuehler_versatz", lambda r: r.update(ist_rl=q(float(r["ist_rl"]) + 0.5))),
    "leck": ("wasserdruck", lambda r: r.update(druck_bar="%.2f" % (float(r["druck_bar"]) - 0.35))),
    "filter": ("hydraulik", lambda r: r.update(flow_l_min="%.1f" % (float(r["flow_l_min"]) * 0.75))),
    "laub": ("verdampfer", lambda r: r.update(rohr_aussen="%d" % round(float(r["rohr_aussen"]) - 3)) if float(r["aussen"]) >= 5 else None),
    "kaeltemittel": ("expansionsventil", lambda r: r.update(expansionsventil="%d" % (int(r["expansionsventil"]) + 30),
                                                             heissgas="%d" % (int(r["heissgas"]) + 8))),
    "zaehler": ("stromzaehler", lambda r: r.update(zaehler_wp_w="%d" % (int(r["zaehler_wp_w"]) + 70)) if r["zaehler_wp_w"] else None),
}


def check(name, cond, info: object = ""):
    global OKS, FAILS
    print(("OK   " if cond else "FAIL ") + name + (("  -> " + str(info)) if info not in ("", None) else ""))
    if cond:
        OKS += 1
    else:
        FAILS += 1


def q(x, s=0.25):
    return "%.2f" % (round(x / s) * s)


def synthetisch(ordner, stoerung=None):
    rnd = random.Random(7)
    rows = []
    t = dt.datetime.combine(START, dt.time(0, 0))
    ende = t + dt.timedelta(days=TAGE)
    i = 0
    while t < ende:
        tag = (t.date() - START).days
        at = 7 + 5 * math.sin(2 * math.pi * (t.hour * 60 + t.minute) / 1440 - 2) + rnd.gauss(0, 0.3)
        lauf = (i % 240) < 180                                  # 3 h Lauf, 1 h Pause
        vl = 31 - 0.5 * at + rnd.gauss(0, 0.1)
        hz = 18 if lauf else 0
        duty = 140 if lauf else 120
        flow = (24 if lauf else 21) + rnd.gauss(0, 0.3)
        pth = 2600 + rnd.gauss(0, 150) if lauf else 0
        pel = 560 + 8 * (vl - 28) + rnd.gauss(0, 10) if lauf else 15
        fan = 420 if lauf else 0
        entzug = (pth - pel) / 1000 * 300 / 420 if lauf else 0
        rohr = at - (2 + 2.0 * entzug) + rnd.gauss(0, 0.4)
        r = {"zeit": t.strftime("%Y-%m-%d %H:%M:%S"), "quiet_aktuell": "3", "soll_vl": "%.0f" % vl, "ist_vl": q(vl),
             "ist_rl": q(vl - (2.2 if lauf else 0) + rnd.gauss(0, 0.05)), "verdichter_hz": str(hz), "leistung_el_w": "%d" % max(0, pel - 80),
             "leistung_th_heisha_w": "%d" % pth, "flow_l_min": "%.1f" % flow, "pumpe_duty": str(duty), "pumpe_speed": "3000" if lauf else "2400",
             "fan1": str(fan), "aussen": "%d" % round(at), "defrost": "0", "warmwasser": "0", "heizregelung": "1", "heizstab_intern": "0",
             "zustand": "lauf" if lauf else "pause", "rohr_aussen": "%d" % round(rohr), "rohr_innen": "%d" % round(vl - 1 + rnd.gauss(0, 0.5)),
             "verdampfer_aus": "%d" % round(rohr - 1 + rnd.gauss(0, 0.5)), "heissgas": "%d" % round(vl + 1.5 + rnd.gauss(0, 1.0)),
             "expansionsventil": "%d" % round(52 + rnd.gauss(0, 6)), "druck_bar": "%.2f" % (1.60 + 0.008 * (vl - 28) + rnd.gauss(0, 0.01)),
             "zaehler_wp_w": "%d" % pel}
        if stoerung and tag >= STOER_AB:
            STOERUNGEN[stoerung][1](r)
        rows.append(r)
        t += dt.timedelta(minutes=1)
        i += 1
    os.makedirs(ordner, exist_ok=True)
    for m in sorted({r["zeit"][:7] for r in rows}):
        with open(os.path.join(ordner, "quiet-%s.csv" % m), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=SPALTEN)
            w.writeheader()
            w.writerows([r for r in rows if r["zeit"][:7] == m])
    with open(os.path.join(ordner, "owm.json"), "w") as f:     # Attrappe: darf nie gelesen werden
        f.write("GEHEIM")
    os.chmod(os.path.join(ordner, "owm.json"), 0o000)


def lauf(daten, erg, tag=None, alle=True):
    a = [sys.executable, os.path.join(HIER, "gesundheit_tag.py"), "--daten", daten, "--ergebnis", erg] + (["--tag", tag] if tag else []) + (["--alle"] if alle else [])
    p = subprocess.run(a, capture_output=True, text=True, env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"})
    return p


def befunde(erg):
    out = {}
    o = os.path.join(erg, "gesundheit")
    for f in sorted(os.listdir(o)):
        if f.endswith(".json"):
            with open(os.path.join(o, f)) as fh:
                j = json.load(fh)
            out[f[:10]] = [b for b in j["befunde"] if b["schwere"] in ("hinweis", "warnung")]
    return out


def teil1(tmp):
    print("== 1. synthetische Anlage")
    letzter = (START + dt.timedelta(days=TAGE - 1)).isoformat()
    d, e = os.path.join(tmp, "s0"), os.path.join(tmp, "e0")
    synthetisch(d)
    p = lauf(d, e, letzter)
    check("ohne Störung: Lauf ok", p.returncode == 0, p.stderr[-300:])
    B = befunde(e)
    falsch = {k: [b["titel"] for b in v] for k, v in B.items() if v}
    check("ohne Störung: kein Hinweis und keine Warnung an %d Tagen" % len(B), not falsch, falsch)
    with open(os.path.join(e, "gesundheit", START.isoformat() + ".json")) as fh:
        j = json.load(fh)
    check("erster Tag: „lernt noch“", any(b["titel"] == "Gesundheit lernt noch" for b in j["befunde"]))
    check("tage.csv hat %d Zeilen" % TAGE, sum(1 for _ in open(os.path.join(e, "gesundheit", "tage.csv"))) == TAGE + 1)
    for name, (pruefung, _) in STOERUNGEN.items():
        d, e = os.path.join(tmp, "s_" + name), os.path.join(tmp, "e_" + name)
        synthetisch(d, name)
        p = lauf(d, e, letzter)
        B = befunde(e)
        erste = min((k for k, v in B.items() if any(b["pruefung"] == pruefung for b in v)), default=None)
        fremd = sorted({b["pruefung"] for v in B.values() for b in v} - {pruefung, "guetegrad", "heissgas"})
        frueh = (START + dt.timedelta(days=STOER_AB + 2)).isoformat()
        check("Störung %-12s -> %s erkannt (erster Tag %s)" % (name, pruefung, erste), erste is not None and erste >= frueh and erste <= letzter,
              "nicht vor %s" % frueh)
        check("Störung %-12s -> keine fremden Prüfungen" % name, not fremd, fremd)
        stufe = [b["schwere"] for b in B[letzter] if b["pruefung"] == pruefung]
        check("Störung %-12s -> am letzten Tag Warnung" % name, stufe == ["warnung"], stufe)


def teil2(tmp, quelle):
    print("== 2. echte Daten aus %s" % quelle)
    d = os.path.join(tmp, "echt")
    os.makedirs(d)
    for f in os.listdir(quelle):
        if f.startswith(("quiet-2", "defrost-")) and f.endswith(".csv"):
            shutil.copy(os.path.join(quelle, f), d)
    tage = sorted({l[:10] for f in os.listdir(d) if f.startswith("quiet-") for l in open(os.path.join(d, f), errors="replace") if l[:2] == "20"})
    letzter = tage[-2]                                         # letzter vollständiger Tag
    e = os.path.join(tmp, "e_echt")
    p = lauf(d, e, letzter)
    check("echte Daten: Lauf ok", p.returncode == 0, p.stderr[-300:])
    B = befunde(e)
    falsch = {k: [b["titel"] for b in v] for k, v in B.items() if v}
    check("echte Daten: kein Hinweis/keine Warnung %s–%s (Fehlalarm-Probe)" % (tage[0], letzter), not falsch, falsch)
    ab = (dt.date.fromisoformat(letzter) - dt.timedelta(days=6)).isoformat()
    for name, (pruefung, fn) in STOERUNGEN.items():
        if name == "laub":
            continue                                           # im Abtauwetter gibt es keine eisfreie Lage (AT >= 5 °C)
        ds = os.path.join(tmp, "echt_" + name)
        os.makedirs(ds)
        for f in os.listdir(d):
            if not f.startswith("quiet-"):
                shutil.copy(os.path.join(d, f), ds)
                continue
            out = io.StringIO()
            kopf = None
            for z in csv.reader(open(os.path.join(d, f), errors="replace")):
                if z and z[0] == "zeit":
                    kopf = z
                elif kopf and len(z) == len(kopf) and z[0][:10] >= ab:
                    r = dict(zip(kopf, z))
                    try:
                        fn(r)
                    except (ValueError, KeyError):
                        pass
                    z = [r[k] for k in kopf]
                csv.writer(out, lineterminator="\n").writerow(z)
            open(os.path.join(ds, f), "w").write(out.getvalue())
        es = os.path.join(tmp, "es_" + name)
        lauf(ds, es, letzter, alle=False)
        with open(os.path.join(es, "gesundheit", letzter + ".json")) as fh:
            j = json.load(fh)
        st = [b["schwere"] for b in j["befunde"] if b["pruefung"] == pruefung]
        check("echte Daten + Störung %-12s ab %s -> %s gemeldet" % (name, ab, pruefung), bool(st), "%s; Trend %s" % (st, j["trend"][pruefung]))


def main():
    tmp = tempfile.mkdtemp(prefix="ges-test-")
    try:
        teil1(tmp)
        if len(sys.argv) > 1:
            teil2(tmp, sys.argv[1])
    finally:
        for root, dirs, files in os.walk(tmp):
            for f in files:
                try:
                    os.chmod(os.path.join(root, f), 0o600)
                except OSError:
                    pass
        shutil.rmtree(tmp, ignore_errors=True)
    print("%d OK, %d FAIL" % (OKS, FAILS))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())

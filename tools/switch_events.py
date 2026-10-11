#!/usr/bin/env python3
"""Schaltlogik der Leisha aus den Minuten-Protokollen auswerten (nur lesen, nichts am System aendern).

Aufruf:  python3 switch_events.py quiet-2026-10.csv [quiet-2026-11.csv ...]
Zeigt (aus dem Verlauf, auch fuer aeltere Dateien ohne die neuen Spalten):
  1. Stopps:  Vorlauf-Abstand zum Soll in den letzten Minuten (Handbuch: Stopp bei > +3 K fuer 3 min; gemessen: +3,25 K) und was den Stopp ausloeste
              (Vorlauf stieg / Sollsprung nach unten / Heizgrenze)
  2. Starts:  Vorlauf-Abstand zum Soll vor dem Start, Pause in min, Minuten seit der Schwelle Soll -3 K (Hypothese: Start bei Soll -3 K nach 6-9 min)
              und die Pumpendrehzahl davor (Spuelung 4300 U/min = Freigabe nach Heizgrenze)
  3. Sollspruenge: im Lauf / in der Pause / bei Heizgrenze, mit Abstand zum neuen Soll und dem naechsten Stopp/Start danach.
              Sollspruenge IN DER PAUSE sind die kostenlosen Tests der Startschwelle (bisher noch keiner beobachtet).
  4. Heizgrenze: Zeitraeume mit stehender Pumpe (0 U/min) mit Aussentemperatur am Anfang und Ende (Hysterese: aus ab 15 C, ein ab 12 C bei Einstellung 12).
  5. Kinderzimmer (nur Zeilen mit den neuen Spalten): Minuten mit Radiator an / Heizluefter an, getrennt nach Lauf und Pause.
"""
import csv
import datetime as dt
import sys


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def load(paths):
    rows = []
    for path in paths:
        head = None
        for v in csv.reader(open(path, encoding="utf-8")):
            if v and v[0] == "zeit":
                head = v
                continue
            if head and len(v) == len(head):
                r = dict(zip(head, v))
                r["t"] = dt.datetime.strptime(r["zeit"], "%Y-%m-%d %H:%M:%S")
                r["hz"] = num(r["verdichter_hz"]) or 0
                r["vl"], r["soll"], r["at"] = num(r["ist_vl"]), num(r["soll_vl"]), num(r["aussen"])
                r["pump"] = num(r["pumpe_speed"])
                rows.append(r)
    rows.sort(key=lambda r: r["t"])
    return rows


def rel(r):
    return None if r["vl"] is None or r["soll"] is None else r["vl"] - r["soll"]


def fmt(v, d=2, sign=True):
    if v is None:
        return "  –  "
    return ("%+.*f" if sign else "%.*f") % (d, v)


def state(r):
    z = r.get("zustand")
    if z:
        return z
    if r["hz"] > 0:
        return "lauf"
    if r["pump"] is None:
        return "?"
    return "pause" if r["pump"] >= 1000 else "heizgrenze"


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    rows = load(sys.argv[1:])
    if not rows:
        raise SystemExit("keine Zeilen")
    print("%d Zeilen von %s bis %s\n" % (len(rows), rows[0]["t"], rows[-1]["t"]))
    starts = [i for i in range(1, len(rows)) if rows[i - 1]["hz"] == 0 and rows[i]["hz"] > 0]
    stops = [i for i in range(1, len(rows)) if rows[i - 1]["hz"] > 0 and rows[i]["hz"] == 0]

    print("1. STOPPS (Vorlauf-Abstand zum Soll in den 4 Minuten davor, Ausloeser)")
    for i in stops:
        last = [rel(rows[j]) for j in range(max(0, i - 4), i)]
        soll_chg = any(rows[j]["soll"] != rows[j - 1]["soll"] and rows[j]["soll"] is not None for j in range(max(1, i - 5), i))
        why = "Sollsprung" if soll_chg else ("Vorlauf stieg" if last and last[-1] is not None and last[-1] >= 2.9 else "anderer Grund (Heizgrenze?)")
        print("  %s  Lauf davor %4s min | Abstand %s | AT %s | %s" % (rows[i]["t"].strftime("%d.%m. %H:%M"), rows[i - 1].get("verdichter_laufzeit_min", "?"), " ".join(fmt(x) for x in last), rows[i - 1]["aussen"], why))

    print("\n2. STARTS (Abstand zum Soll vor dem Start, Pause, Minuten seit Schwelle Soll -3 K, Pumpe davor)")
    for i in starts:
        s = [j for j in stops if j < i]
        if not s:
            continue
        s = s[-1]
        j = i - 1
        while j > s and rel(rows[j]) is not None and rel(rows[j]) <= -3.0 + 1e-9:
            j -= 1
        since = (rows[i]["t"] - rows[j + 1]["t"]).total_seconds() / 60 if j + 1 < i else 0
        pumps = [rows[k]["pump"] for k in range(max(s, i - 12), i) if rows[k]["pump"]]
        flush = " (Spuelung %s U/min)" % max(pumps) if pumps and max(pumps) > 2000 else ""
        step = (rows[i]["t"] - rows[i - 1]["t"]).total_seconds() / 60
        print("  %s  Pause %4.0f min | Abstand %s | seit Schwelle %4.0f min | AT %s%s%s" % (rows[i]["t"].strftime("%d.%m. %H:%M"), (rows[i]["t"] - rows[s]["t"]).total_seconds() / 60, fmt(rel(rows[i - 1])), since, rows[i - 1]["aussen"], flush, "  [Raster %.0f min]" % step if step > 1.5 else ""))

    print("\n3. SOLLSPRUENGE (Zustand, alt -> neu, Abstand zum neuen Soll, danach)")
    n_pause = 0
    for i in range(1, len(rows)):
        a, b = rows[i - 1], rows[i]
        if a["soll"] is None or b["soll"] is None or a["soll"] == b["soll"]:
            continue
        z = state(b)
        nxt = ""
        if b["hz"] > 0:
            nt = [x for x in stops if x >= i]
            nxt = "Stopp nach %.0f min" % ((rows[nt[0]]["t"] - b["t"]).total_seconds() / 60) if nt else "kein Stopp mehr im Zeitraum"
        else:
            ns = [x for x in starts if x >= i]
            nxt = "Start nach %.0f min" % ((rows[ns[0]]["t"] - b["t"]).total_seconds() / 60) if ns else "kein Start mehr im Zeitraum"
            n_pause += 1
        print("  %s  %-10s %.0f -> %.0f | Abstand neu %s | AT %s | %s" % (b["t"].strftime("%d.%m. %H:%M"), z, a["soll"], b["soll"], fmt(rel(b)), b["aussen"], nxt))
    print("  -> Sollspruenge in der Pause / bei Heizgrenze: %d (jeder ist ein kostenloser Test der Startschwelle)" % n_pause)

    print("\n4. HEIZGRENZE (Pumpe 0 U/min)")
    cur = None
    spans = []
    for r in rows:
        if r["hz"] == 0 and r["pump"] == 0:
            if cur is None:
                cur = [r, r]
            else:
                cur[1] = r
        elif cur:
            spans.append(cur)
            cur = None
    if cur:
        spans.append(cur)
    for a, b in spans:
        d = (b["t"] - a["t"]).total_seconds() / 60
        if d >= 10:
            print("  %s -> %s (%4.0f min) | AT am Anfang %s, am Ende %s" % (a["t"].strftime("%d.%m. %H:%M"), b["t"].strftime("%d.%m. %H:%M"), d, a["aussen"], b["aussen"]))

    if "kz_radiator_an" in rows[-1] or any("kz_radiator_an" in r for r in rows):
        print("\n5. KINDERZIMMER OBEN (Minuten je Zustand, nur Zeilen mit den neuen Spalten)")
        agg = {}
        for r in rows:
            if "kz_radiator_an" not in r:
                continue
            k = state(r)
            a = agg.setdefault(k, [0, 0, 0, 0.0])
            a[0] += 1
            a[1] += 1 if r["kz_radiator_an"] == "1" else 0
            a[2] += 1 if r["kz_heizluefter_an"] == "1" else 0
            a[3] += (num(r["kz_heizluefter_w"]) or 0) / 60000.0
        for k, a in sorted(agg.items()):
            print("  %-10s %5d min | Radiator an %5d min (%3.0f %%) | Heizluefter an %5d min | Heizluefter %.2f kWh" % (k, a[0], a[1], 100.0 * a[1] / max(1, a[0]), a[2], a[3]))


if __name__ == "__main__":
    main()

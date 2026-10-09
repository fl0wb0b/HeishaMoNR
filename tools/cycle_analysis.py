#!/usr/bin/env python3
"""Verdichter-Laeufe aus quiet-YYYY-MM.csv auswerten (nur lesen, nichts am System aendern).

Prueft die Angaben aus dem Leisha-Servicehandbuch gegen unsere Daten:
  Aus:   Vorlauf > Soll + 3 K fuer 3 Minuten
  Start: Vorlauf mehr als 3 K unter dem beim Abschalten gespeicherten Ruecklauf

Aufruf:  python3 cycle_analysis.py quiet-2026-10.csv
Ausgabe: pro Lauf Dauer, Stillstandsdauer davor, Vorlauf-Soll der letzten 3 Zeilen beim Ende,
         und pro Stillstand, wann der Vorlauf unter RL_aus - 3 K fiel und wann der Verdichter wirklich anlief.
Hinweis: Laufzeilen sind im Minutentakt; Stillstandszeilen bis 08.10.2026 10:55 im 5-Minuten-Takt (kurze
         Pumpenspuelungen dort nicht sichtbar), danach ebenfalls im Minutentakt.
"""
import csv
import datetime as dt
import sys


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def load(path):
    head, rows = None, []
    for v in csv.reader(open(path, encoding="utf-8")):
        if v and v[0] == "zeit":  # Kopfzeile, kann nach Schemaaenderungen mehrfach vorkommen
            head = v
            continue
        if head and len(v) == len(head):
            r = dict(zip(head, v))
            r["t"] = dt.datetime.strptime(r["zeit"], "%Y-%m-%d %H:%M:%S")
            r["hz"] = num(r["verdichter_hz"]) or 0
            rows.append(r)
    return rows


def find_runs(rows):
    runs, cur = [], None
    for i, r in enumerate(rows):
        if r["hz"] > 0 and cur is None:
            cur = {"s": i}
        if r["hz"] == 0 and cur is not None:
            cur["e"] = i - 1
            runs.append(cur)
            cur = None
    if cur:
        cur["e"] = len(rows) - 1
        cur["open"] = True
        runs.append(cur)
    return runs


def main(path):
    rows = load(path)
    if not rows:
        print("keine auswertbaren Zeilen in", path)
        return
    runs = find_runs(rows)
    print(f"{len(rows)} Zeilen {rows[0]['zeit']} bis {rows[-1]['zeit']}, {len(runs)} Laeufe")
    prev = None
    for ru in runs:
        a, b = ru["s"], ru["e"]
        last = rows[max(a, b - 2):b + 1]
        d = [(num(x["ist_vl"]) if num(x["ist_vl"]) is not None else 0) - (num(x["soll_vl"]) if num(x["soll_vl"]) is not None else 0) for x in last]
        dur = (rows[b]["t"] - rows[a]["t"]).total_seconds() / 60
        off = (rows[a]["t"] - rows[prev["e"]]["t"]).total_seconds() / 60 if prev else None
        print(f"{rows[a]['t']:%d.%m %H:%M}-{rows[b]['t']:%H:%M} {dur:4.0f} min, Stillstand davor "
              f"{'%4.0f' % off if off is not None else '   -'} min | Ende VL-Soll {['%+.2f' % x for x in d]} "
              f"RL {rows[b]['ist_rl']} AT {rows[b]['aussen']} Quiet {rows[b]['quiet_aktuell']} "
              f"{'(laeuft noch)' if ru.get('open') else ''}")
        prev = ru
    print("\nStillstaende: Vorlauf unter RL_aus - 3 K vs. tatsaechlicher Start")
    for k in range(1, len(runs)):
        p, c = runs[k - 1], runs[k]
        rl_off = num(rows[p["e"]]["ist_rl"])
        if rl_off is None:
            continue
        thr = rl_off - 3
        off_rows = rows[p["e"] + 1:c["s"]]
        cross = next((x for x in off_rows if num(x["ist_vl"]) is not None and num(x["ist_vl"]) < thr), None)
        delay = (rows[c["s"]]["t"] - cross["t"]).total_seconds() / 60 if cross else None
        print(f"Aus {rows[p['e']]['t']:%d.%m %H:%M} RL_aus {rl_off} Schwelle {thr:.2f} | Start {rows[c['s']]['t']:%H:%M} "
              f"| Schwelle unterschritten {cross['t']:%H:%M} -> Verzug {delay:.0f} min" if cross else
              f"Aus {rows[p['e']]['t']:%d.%m %H:%M} RL_aus {rl_off} Schwelle {thr:.2f} | Start {rows[c['s']]['t']:%H:%M} "
              f"| Schwelle in den Daten nie unterschritten")


if __name__ == "__main__":
    main(sys.argv[1])

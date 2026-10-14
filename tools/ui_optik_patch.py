#!/usr/bin/env python3
"""UI-Optik der HeishaMoNR-Kernseiten (14.10.2026): nur Darstellung, auf einer Flow-Datei (Live-Export), Material-Look bleibt.

Aenderungen (Whitelist, jede mit erwartetem Altwert; alles andere bricht ab):
  1. neu: ui_template "UI-Optik (Kopfbereich)" (ID ui_optik_kopf, templateScope "global" = <head> jeder Seite, keine Gruppe, keine Verdrahtung):
     Gruppentitel im Blau der Kopfzeile, dunkel genug fuer Text (#007bb0, 4,7:1 auf Weiss statt #1bbfff mit 2,1:1); sonst nichts.
  2. Effizienz > Historische Daten (ui_table 59bc0c78b8b9ea90): Monat linksbuendig, Zahlen rechtsbuendig (vorher alles zentriert).
  3. Uebersicht: englischer Tooltip der Vorlauf-Standardtemperatur (ui_numeric 8329aedf9204b75d) auf Deutsch.
  Optional (--monate-filtern, NICHT Standard, aendert eine Funktion): "Generate table (dashboard)" (e79ba8ec58a2bbc4) laesst Monate ohne Daten
     (COP und Waerme 0 oder leer) weg. Ueber die ui_table-Optionen geht das nicht (der Knoten hat nur Spalten, keine Filter).
Keine opt_*-Knoten, keine Verdrahtung, kein MQTT, nichts geloescht.

Aufrufe (nur Standardbibliothek):
  python3 tools/ui_optik_patch.py <flows.json> --dry-run [--monate-filtern]
  python3 tools/ui_optik_patch.py <flows.json> --apply [--monate-filtern] [--out neu.json] [--sicherung datei.json]
  python3 tools/ui_optik_patch.py <flows.json> --revert --sicherung datei.json [--out zurueck.json]     (byte-gleich mit dem Original)
Ist ein Wert schon neu, wird er uebersprungen (idempotent). Weicht ein Ausgangswert ab (Live-Flow inzwischen anders), bricht das Skript ab.
"""
import argparse
import copy
import datetime
import json
import os
import sys


class Abbruch(Exception):
    pass


KOPF_ID = "ui_optik_kopf"
KOPF_CSS = ("<style>\n/* UI-Optik 14.10.2026 (tools/ui_optik_patch.py): Gruppentitel im Blau der Kopfzeile, Kontrast 4,7:1 (vorher #1bbfff, 2,1:1) */\n"
            "body.nr-dashboard-theme ui-card-panel p.nr-dashboard-cardtitle{color:#007bb0}\n</style>")
KOPF = {"id": KOPF_ID, "type": "ui_template", "z": "8c9d42231fd19d3c", "group": "", "name": "UI-Optik (Kopfbereich)", "order": 0, "width": 0, "height": 0,
        "format": KOPF_CSS, "storeOutMessages": False, "fwdInMessages": False, "resendOnRefresh": False, "templateScope": "global", "className": "",
        "x": 1080, "y": 4000, "wires": [[]]}

_SP = {"target": "_blank"}
_ALT_SPALTEN = [{"field": "date", "title": "Monat", "width": "", "align": "center", "formatter": "plaintext", "formatterParams": _SP},
                {"field": "heat_cop", "title": "COP (Heizen)", "width": "", "align": "center", "formatter": "plaintext", "formatterParams": _SP},
                {"field": "heat_energy_produced", "title": "Erzeugte Wärme (kWh)", "width": "", "align": "center", "formatter": "plaintext", "formatterParams": _SP}]
_NEU_SPALTEN = copy.deepcopy(_ALT_SPALTEN)
for _c, _a in zip(_NEU_SPALTEN, ("left", "right", "right")):
    _c["align"] = _a
_ALT_TIP = ("This is the default outlet water temperature when all functions are turned off. Heating mode Direct: range: 20-65°C. "
            "Heating mode Compensation Curve: Range: -5 / +5")
_NEU_TIP = ("Standard-Vorlauftemperatur, wenn alle Funktionen aus sind. Heizmodus Direkt: 20–65 °C. "
            "Heizmodus Heizkurve: Verschiebung −5 bis +5 K")

# (Seite, ID, Typ, Feld, Art "ganz"|"text", alt, neu, Grund)
AENDERUNGEN = [
    ("Effizienz", "59bc0c78b8b9ea90", "ui_table", "columns", "ganz", _ALT_SPALTEN, _NEU_SPALTEN, "Monat links, Zahlen rechts"),
    ("Übersicht", "8329aedf9204b75d", "ui_numeric", "tooltip", "ganz", _ALT_TIP, _NEU_TIP, "Tooltip auf Deutsch"),
]
_FILTER_ALT = "rows.sort((a, b) => yyyymmNum(b.date) - yyyymmNum(a.date));\n"
_FILTER_NEU = (_FILTER_ALT + "\n// UI-Optik 14.10.2026 (tools/ui_optik_patch.py --monate-filtern): Monate ohne Daten (COP und Waerme 0 oder leer) nicht anzeigen\n"
               "rows = rows.filter(r => Number(r.heat_cop) > 0 || Number(r.heat_energy_produced) > 0);\n")
OPTIONAL = [("Effizienz", "e79ba8ec58a2bbc4", "function", "func", "text", _FILTER_ALT, _FILTER_NEU, "Monate ohne Daten ausblenden (Funktion, optional)")]
FORMATE = ({"separators": (",", ":")}, {}, {"indent": 4})       # kompakt, json-Standard, eingerueckt


def laden(path):
    raw = open(path, encoding="utf-8").read()
    data = json.loads(raw)
    flows = data["flows"] if isinstance(data, dict) and "flows" in data else data
    for kw in FORMATE:
        s = json.dumps(flows, ensure_ascii=False, **kw)
        if raw in (s, s + "\n"):
            return flows, (kw, raw.endswith("\n"))
    return flows, ({"separators": (",", ":")} if raw.lstrip().startswith("[{") else {"indent": 4}, False)


def schreiben(path, flows, fmt):
    kw, nl = fmt
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(flows, ensure_ascii=False, **kw) + ("\n" if nl else ""))


def plan(flows, monate=False):
    """[(seite, id, feld, alt, neu, grund)] und ob der Kopf-Knoten neu ist; Abbruch bei unerwartetem Altwert"""
    N = {n["id"]: n for n in flows}
    out, fehler, schon = [], [], 0
    for (seite, i, typ, feld, art, alt, neu, grund) in AENDERUNGEN + (OPTIONAL if monate else []):
        n = N.get(i)
        if n is None or n["type"] != typ:
            fehler.append("%s: Knoten %s (%s) fehlt oder hat einen anderen Typ" % (seite, i, typ))
            continue
        cur = n.get(feld, "\0fehlt")
        if art == "ganz":
            if cur == neu:
                schon += 1
                continue
            if cur != alt:
                fehler.append("%s: %s.%s weicht vom erwarteten Altwert ab (Live-Flow geaendert?)" % (seite, i, feld))
                continue
            out.append((seite, i, feld, copy.deepcopy(cur), copy.deepcopy(neu), grund))
        else:
            if not isinstance(cur, str):
                fehler.append("%s: %s.%s fehlt" % (seite, i, feld))
            elif neu in cur:
                schon += 1
            elif cur.count(alt) != 1:
                fehler.append("%s: %s.%s enthaelt die erwartete Textstelle %dx statt 1x" % (seite, i, feld, cur.count(alt)))
            else:
                out.append((seite, i, feld, cur, cur.replace(alt, neu), grund))
    kopf_neu = KOPF_ID not in N
    if not kopf_neu and N[KOPF_ID] != KOPF:
        fehler.append("Knoten %s existiert schon mit anderem Inhalt" % KOPF_ID)
    if KOPF["z"] not in N or N[KOPF["z"]]["type"] != "tab":
        fehler.append("Flow-Tab %s fuer den Kopf-Knoten fehlt" % KOPF["z"])
    if fehler:
        raise Abbruch("Erwartete Ausgangswerte stimmen nicht:\n  " + "\n  ".join(fehler))
    return out, kopf_neu, schon


def anwenden(flows, changes, kopf_neu):
    neu = copy.deepcopy(flows)
    N = {n["id"]: n for n in neu}
    for (_s, i, feld, _alt, wert, _g) in changes:
        N[i][feld] = copy.deepcopy(wert)
    if kopf_neu:
        neu.append(copy.deepcopy(KOPF))
    return neu


def whitelist(alt, neu, erlaubt):
    """Unabhaengige Pruefung: nur die erlaubten (id, feld) geaendert, hoechstens der Kopf-Knoten neu, nichts geloescht, keine opt_*"""
    A, B, fehler = {n["id"]: n for n in alt}, {n["id"]: n for n in neu}, []
    if [i for i in A if i not in B]:
        fehler.append("Knoten geloescht: %s" % [i for i in A if i not in B])
    for i in B:
        if i not in A:
            if i != KOPF_ID or B[i] != KOPF:
                fehler.append("unerwarteter neuer Knoten %s" % i)
            continue
        for k in set(A[i]) | set(B[i]):
            if A[i].get(k, "\0") != B[i].get(k, "\0") and (i, k) not in erlaubt:
                fehler.append("%s.%s geaendert (nicht erlaubt)" % (i, k))
        if i.startswith("opt_") and A[i] != B[i]:
            fehler.append("opt_*-Knoten %s geaendert" % i)
    if fehler:
        raise Abbruch("Whitelist verletzt:\n  " + "\n  ".join(fehler))
    return sorted([i for i in B if i not in A or A[i] != B[i]])


def main():
    ap = argparse.ArgumentParser(description="UI-Optik der Kernseiten (nur Darstellung)")
    ap.add_argument("flows")
    m = ap.add_mutually_exclusive_group(required=True)
    m.add_argument("--dry-run", action="store_true")
    m.add_argument("--apply", action="store_true")
    m.add_argument("--revert", action="store_true")
    ap.add_argument("--monate-filtern", action="store_true", help="optional: Monate ohne Daten in der Effizienz-Tabelle weglassen (aendert eine Funktion)")
    ap.add_argument("--out")
    ap.add_argument("--sicherung")
    a = ap.parse_args()
    flows, fmt = laden(a.flows)
    try:
        if a.revert:
            if not a.sicherung:
                raise Abbruch("--revert braucht --sicherung <datei>")
            S = json.load(open(a.sicherung, encoding="utf-8"))
            N, rueck, fehler = {n["id"]: n for n in flows}, [], []
            for c in S["aenderungen"]:
                cur = N[c["id"]].get(c["feld"], "\0fehlt") if c["id"] in N else "\0fehlt"
                if cur == c["alt"]:
                    continue
                if cur != c["neu"]:
                    fehler.append("%s.%s ist nicht der gepatchte Wert" % (c["id"], c["feld"]))
                    continue
                rueck.append((c["seite"], c["id"], c["feld"], c["neu"], c["alt"], "Rueckbau"))
            if S.get("kopf_neu") and KOPF_ID in N and N[KOPF_ID] != KOPF:
                fehler.append("Knoten %s wurde inzwischen geaendert" % KOPF_ID)
            if fehler:
                raise Abbruch("Rueckbau nicht moeglich:\n  " + "\n  ".join(fehler))
            neu = anwenden(flows, rueck, False)
            if S.get("kopf_neu"):
                neu = [n for n in neu if n["id"] != KOPF_ID]
            erlaubt = {(c["id"], c["feld"]) for c in S["aenderungen"]}
            A = {n["id"]: n for n in neu}
            for i in A:                                                       # Pruefung des Rueckbaus: nur Werte aus der Sicherung, nur der Kopf-Knoten entfernt
                o = N[i]
                if any(o.get(k, "\0") != A[i].get(k, "\0") and (i, k) not in erlaubt for k in set(o) | set(A[i])):
                    raise Abbruch("Rueckbau aendert %s ausserhalb der Sicherung" % i)
            if [i for i in N if i not in A] not in ([], [KOPF_ID]):
                raise Abbruch("Rueckbau entfernt mehr als den Kopf-Knoten")
            out = a.out or a.flows.replace(".json", "") + ".zurueck.json"
            schreiben(out, neu, fmt)
            print("Rueckbau: %d Werte zurueckgesetzt%s -> %s" % (len(rueck), ", Kopf-Knoten entfernt" if S.get("kopf_neu") else "", out))
            return 0
        changes, kopf_neu, schon = plan(flows, a.monate_filtern)
        neu = anwenden(flows, changes, kopf_neu)
        ids = whitelist(flows, neu, {(c[1], c[2]) for c in changes})
        print("ui_optik_patch: %s (%d Knoten), Modus %s%s" % (a.flows, len(flows), "Probelauf" if a.dry_run else "Anwenden", ", mit Monatsfilter" if a.monate_filtern else ""))
        for (seite, i, feld, alt, wert, grund) in changes:
            print("  %-10s %s.%s: %s" % (seite, i, feld, grund))
        print("  %-10s %s: %s" % ("alle Seiten", KOPF_ID, "neu (ui_template, Kopfbereich): Gruppentitel #007bb0" if kopf_neu else "schon vorhanden"))
        print("  schon neu: %d · geaenderte/neue Knoten: %d" % (schon, len(ids)))
        if a.apply:
            out = a.out or a.flows.replace(".json", "") + ".optik.json"
            sich = a.sicherung or out.replace(".json", "") + ".sicherung.json"
            schreiben(out, neu, fmt)
            json.dump({"erzeugt": datetime.datetime.now().isoformat(timespec="seconds"), "quelle": os.path.abspath(a.flows), "ziel": os.path.abspath(out), "kopf_neu": kopf_neu,
                       "aenderungen": [{"seite": c[0], "id": c[1], "feld": c[2], "alt": c[3], "neu": c[4], "grund": c[5]} for c in changes]},
                      open(sich, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            print("geschrieben: %s\nSicherung:   %s" % (out, sich))
        print("IDS " + ",".join(ids))
        return 0
    except Abbruch as e:
        print("ABBRUCH: %s\nNichts geschrieben." % e)
        return 2


if __name__ == "__main__":
    sys.exit(main())

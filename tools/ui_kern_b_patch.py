#!/usr/bin/env python3
"""ui-review-b (20.10.2026): Kern-Knoten-Patches der Review-Punkte 4, 9, 5 und 10, nur Darstellung, auf einem Live-Export (v2 mit rev oder Liste).

Jede Aenderung steht in PUNKTE mit erwartetem Altwert (Whitelist). Weicht ein Altwert ab (Live-Flow inzwischen anders), bricht das Skript ab.
Ist ein Wert schon neu, wird er uebersprungen (idempotent). Neue Knoten nur aus NEUE_KNOTEN (genauer Inhalt), nichts wird geloescht, keine opt_*-Knoten.
Der Rueckbau setzt aus der Sicherung jeden Wert zurueck und entfernt die neuen Knoten: die Datei ist danach byte-gleich mit dem Ausgangsexport.

Aufrufe (nur Standardbibliothek):
  python3 tools/ui_kern_b_patch.py <flows.json> --dry-run [--punkte 4,9,5,10]
  python3 tools/ui_kern_b_patch.py <flows.json> --apply [--punkte ...] [--out neu.json] [--sicherung datei.json]
  python3 tools/ui_kern_b_patch.py <flows.json> --revert --sicherung datei.json [--out zurueck.json]
"""
import argparse
import copy
import datetime
import json
import os
import sys


class Abbruch(Exception):
    pass


MARKE = "// ui-review-b 20.10.2026 (tools/ui_kern_b_patch.py, Punkt %s): "

# ---------------------------------------------------------------- Punkt 4: Effizienz, Monate ohne Daten weg (Tabelle und beide Monatsdiagramme)
# Tabelle: derselbe Text wie ui_optik_patch.py --monate-filtern (ist der schon drin, gilt die Stelle als "schon neu")
_TAB_ALT = "rows.sort((a, b) => yyyymmNum(b.date) - yyyymmNum(a.date));\n"
_TAB_NEU = (_TAB_ALT + "\n// UI-Optik 14.10.2026 (tools/ui_optik_patch.py --monate-filtern): Monate ohne Daten (COP und Waerme 0 oder leer) nicht anzeigen\n"
            "rows = rows.filter(r => Number(r.heat_cop) > 0 || Number(r.heat_energy_produced) > 0);\n")


def _monatsfilter(kw, anderes):
    """Filter fuer die Monatsdiagramme: Monat bleibt, wenn der eigene Wert oder der Wert der anderen Groesse (gleicher Monat) > 0 ist (Regel der Tabelle)"""
    return ((MARKE % 4) + "Monate ohne Daten weglassen, gleiche Regel wie die Tabelle (COP und Waerme 0 oder leer)\n"
            "var _anderes = global.get(\"%s\", \"file\"), _ma = {};\n"
            "if (_anderes && _anderes.payload && _anderes.payload[0] && _anderes.payload[0].data) { _anderes.payload[0].labels.forEach(function (l, i) { _ma[l] = _anderes.payload[0].data[0][i]; }); }\n"
            "var _i = (varlabels || []).map(function (l, i) { return i; }).filter(function (i) { return Number(varData2[i]) > 0 || Number(_ma[varlabels[i]]) > 0; });\n"
            "varlabels = _i.map(function (i) { return varlabels[i]; });\n"
            "varData2 = _i.map(function (i) { return varData2[i]; });\n\n" % anderes) + kw + " m = {\n    labels: varlabels,\n    series: [\"Heizen\"],\n    data: [varData2]\n};\n"


_COPM_ALT = "let m = {\n    labels: varlabels,\n    series: [\"Heizen\"],\n    data: [varData2]\n};\n"
_WAERM_ALT = "var m = {\n    labels: varlabels,\n    series: [\"Heizen\"],\n    data: [varData2]\n};\n"

# ---------------------------------------------------------------- Punkt 9: Auswertung (COP ohne Startspitzen, 31 Tage ab dem ersten Datentag)
COP_GRENZE, COP_START_GRENZE, COP_START_MIN = 10, 8, 5
# Roher COP ueber 10 ist immer ein Messartefakt, ueber 8 in den ersten 5 min nach Stillstand (COP 0) auch: Startspitze, Strom noch fast 0 (TOP16-Raster).
# Im Betrieb liegt der rohe COP bei 3-7,5 (Live-Diagramm 18.-20.10.).
KAPPE_ID = "uib_cop_kappe"
_REGEL = ("function ausreisser(v, t, nullZeit) { return v > %d || (v > %d && t - nullZeit < %d * 60000); }\n" % (COP_GRENZE, COP_START_GRENZE, COP_START_MIN))
_KAPPE_FUNC = ((MARKE % 9) + "COP-Diagramm ohne Ausreisser: ueber %d immer, ueber %d in den ersten %d min nach Stillstand\n"
               "// (Startspitze, Strom noch fast 0). Nur fuer das Diagramm; MQTT und Kachel bekommen den Wert unveraendert.\n" % (COP_GRENZE, COP_START_GRENZE, COP_START_MIN)
               + _REGEL +
               "var v = Number(msg.payload), t = Date.now();\n"
               "if (!isFinite(v)) { return msg; }\n"
               "if (v <= 0) { context.set('nullZeit', t); return msg; }\n"
               "return ausreisser(v, t, context.get('nullZeit') || 0) ? null : msg;")
KAPPE = {"id": KAPPE_ID, "type": "function", "z": "8c9d42231fd19d3c", "name": "COP fuer Diagramm (ohne Ausreisser)", "func": _KAPPE_FUNC, "outputs": 1,
         "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [], "x": 560, "y": 2060, "wires": [["a1c0b0000c0f0012"]]}
_SW_ALT = [["d180ce6b9c6ad85a", "a1c0b0000c0f0010", "a1c0b0000c0f0012"]]
_SW_NEU = [["d180ce6b9c6ad85a", "a1c0b0000c0f0010", KAPPE_ID]]
_LADEN_ALT = "var m = global.get(\"chart-cop\", \"file\");\n"
_LADEN_NEU = (_LADEN_ALT + (MARKE % 9) + "gespeicherte Ausreisser nicht wieder laden, gleiche Regel wie \"COP fuer Diagramm\"\n" + _REGEL +
              "if (m && m.payload && m.payload[0] && Array.isArray(m.payload[0].data)) {\n"
              "    m = RED.util.cloneMessage(m);\n"
              "    m.payload[0].data = m.payload[0].data.map(function (s) {\n"
              "        if (!Array.isArray(s)) { return s; }\n"
              "        var nz = 0;\n"
              "        return s.filter(function (p) { var v = p ? Number(p.y) : NaN; if (!(v > 0)) { nz = p ? Number(p.x) || nz : nz; return true; } return !ausreisser(v, Number(p.x), nz); });\n"
              "    });\n"
              "}\n")
_TAGE_ALT = "        var m={};\n            m.labels    = varlabels;\n            m.series    = ['Gradtage (°C)', 'Energieverbrauch Heizen (kWh)'];\n            m.data      = [vargraaddagen_data, varkwh_heat_data];\n"
_TAGE_NEU = ("        " + (MARKE % 9) + "erst ab dem ersten Tag mit Daten (Gradtage oder Energie > 0)\n"
             "        var _ab = varlabels.findIndex(function (l, i) { return Number(vargraaddagen_data[i]) > 0 || Number(varkwh_heat_data[i]) > 0; });\n"
             "        if (_ab > 0) { varlabels = varlabels.slice(_ab); vargraaddagen_data = vargraaddagen_data.slice(_ab); varkwh_heat_data = varkwh_heat_data.slice(_ab); }\n"
             + _TAGE_ALT)

# (Seite, ID, Typ, Feld, Art "ganz"|"text", alt, neu, Grund)
PUNKTE = {
    "4": [
        ("Effizienz", "e79ba8ec58a2bbc4", "function", "func", "text", _TAB_ALT, _TAB_NEU, "Tabelle: Monate ohne Daten weg"),
        ("Effizienz", "d4198e0e57720e55", "function", "func", "text", _COPM_ALT, _monatsfilter("let", "HEAT_Prod_24m"), "COP pro Monat: Monate ohne Daten weg"),
        ("Effizienz", "35c15a4c210a4b20", "function", "func", "text", _WAERM_ALT, _monatsfilter("var", "COP_HEAT_24m"), "Wärme pro Monat: Monate ohne Daten weg"),
    ],
    "9": [
        ("Auswertung", "a1c0b0000c0f0001", "switch", "wires", "ganz", _SW_ALT, _SW_NEU, "COP-Diagramm über den neuen Filter (MQTT und Kachel direkt wie bisher)"),
        ("Auswertung", "a1c0b0000c0f0061", "function", "func", "text", _LADEN_ALT, _LADEN_NEU, "COP-Diagramm: gespeicherte Ausreißer nicht laden"),
        ("Auswertung", "2391637fadbbf190", "function", "func", "text", _TAGE_ALT, _TAGE_NEU, "Letzte 31 Tage: erst ab dem ersten Datentag"),
    ],
}
NEUE_KNOTEN = {"9": [KAPPE]}          # Punkt -> [Knoten]
REIHENFOLGE = ["4", "9"]
FORMATE = ({"separators": (",", ":")}, {}, {"indent": 4})


def laden(path):
    raw = open(path, encoding="utf-8").read()
    data = json.loads(raw)
    for kw in FORMATE:
        s = json.dumps(data, ensure_ascii=False, **kw)
        if raw in (s, s + "\n"):
            return data, (kw, raw.endswith("\n"))
    return data, ({"separators": (",", ":")} if raw.lstrip()[:2] in ("[{", '{"') else {"indent": 4}, False)


def knoten(data):
    return data["flows"] if isinstance(data, dict) and "flows" in data else data


def schreiben(path, data, fmt):
    kw, nl = fmt
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, **kw) + ("\n" if nl else ""))


def punkte_liste(s):
    p = [x.strip() for x in (s or ",".join(REIHENFOLGE)).split(",") if x.strip()]
    falsch = [x for x in p if x not in PUNKTE]
    if falsch:
        raise Abbruch("unbekannte Punkte %s (bekannt: %s)" % (falsch, ",".join(REIHENFOLGE)))
    return p


def plan(flows, punkte):
    """[(punkt, seite, id, feld, alt, neu, grund)], neue Knoten, Anzahl schon neu; Abbruch bei unerwartetem Altwert"""
    N = {n["id"]: n for n in flows}
    out, neu_k, fehler, schon = [], [], [], 0
    for p in punkte:
        for (seite, i, typ, feld, art, alt, neu, grund) in PUNKTE[p]:
            n = N.get(i)
            if n is None or n["type"] != typ:
                fehler.append("%s: Knoten %s (%s) fehlt oder hat einen anderen Typ" % (seite, i, typ))
                continue
            cur = n.get(feld, "\0fehlt")
            if art == "ganz":
                if cur == neu:
                    schon += 1
                elif cur != alt:
                    fehler.append("%s: %s.%s weicht vom erwarteten Altwert ab (Live-Flow geaendert?)" % (seite, i, feld))
                else:
                    out.append((p, seite, i, feld, copy.deepcopy(cur), copy.deepcopy(neu), grund))
            else:
                if not isinstance(cur, str):
                    fehler.append("%s: %s.%s fehlt" % (seite, i, feld))
                elif neu in cur:
                    schon += 1
                elif cur.count(alt) != 1:
                    fehler.append("%s: %s.%s enthaelt die erwartete Textstelle %dx statt 1x" % (seite, i, feld, cur.count(alt)))
                else:
                    out.append((p, seite, i, feld, cur, cur.replace(alt, neu), grund))
        for k in NEUE_KNOTEN.get(p, []):
            if k["id"] in N:
                if N[k["id"]] != k:
                    fehler.append("Knoten %s existiert schon mit anderem Inhalt" % k["id"])
                else:
                    schon += 1
            else:
                for ref in ("z", "group"):
                    if k.get(ref) and k[ref] not in N:
                        fehler.append("neuer Knoten %s: %s %s fehlt im Flow" % (k["id"], ref, k[ref]))
                neu_k.append(copy.deepcopy(k))
    if fehler:
        raise Abbruch("Erwartete Ausgangswerte stimmen nicht:\n  " + "\n  ".join(fehler))
    return out, neu_k, schon


def anwenden(data, changes, neue):
    neu = copy.deepcopy(data)
    fl = knoten(neu)
    N = {n["id"]: n for n in fl}
    for (_p, _s, i, feld, _alt, wert, _g) in changes:
        N[i][feld] = copy.deepcopy(wert)
    fl.extend(copy.deepcopy(neue))
    return neu


def whitelist(alt, neu, erlaubt, neue_ids):
    """Unabhaengige Pruefung: nur erlaubte (id, feld) geaendert, nur die erklaerten Knoten neu, nichts geloescht, keine opt_*-Knoten"""
    A, B, fehler = {n["id"]: n for n in knoten(alt)}, {n["id"]: n for n in knoten(neu)}, []
    if [i for i in A if i not in B]:
        fehler.append("Knoten geloescht: %s" % [i for i in A if i not in B])
    for i in B:
        if i not in A:
            if i not in neue_ids or i.startswith("opt_"):
                fehler.append("unerwarteter neuer Knoten %s" % i)
            continue
        for k in set(A[i]) | set(B[i]):
            if A[i].get(k, "\0") != B[i].get(k, "\0") and (i, k) not in erlaubt:
                fehler.append("%s.%s geaendert (nicht erlaubt)" % (i, k))
        if i.startswith("opt_") and A[i] != B[i]:
            fehler.append("opt_*-Knoten %s geaendert" % i)
    if isinstance(alt, dict) and {k: v for k, v in alt.items() if k != "flows"} != {k: v for k, v in neu.items() if k != "flows"}:
        fehler.append("Kopf der Datei (rev) geaendert")
    if fehler:
        raise Abbruch("Whitelist verletzt:\n  " + "\n  ".join(fehler))
    return sorted([i for i in B if i not in A or A[i] != B[i]])


def rueckbau(data, S):
    N, rueck, fehler = {n["id"]: n for n in knoten(data)}, [], []
    for c in S["aenderungen"]:
        cur = N[c["id"]].get(c["feld"], "\0fehlt") if c["id"] in N else "\0fehlt"
        if cur == c["alt"]:
            continue
        if cur != c["neu"]:
            fehler.append("%s.%s ist nicht der gepatchte Wert" % (c["id"], c["feld"]))
            continue
        rueck.append((c["punkt"], c["seite"], c["id"], c["feld"], c["neu"], c["alt"], "Rueckbau"))
    for k in S.get("neue_knoten", []):
        if k["id"] in N and N[k["id"]] != k:
            fehler.append("Knoten %s wurde inzwischen geaendert" % k["id"])
    if fehler:
        raise Abbruch("Rueckbau nicht moeglich:\n  " + "\n  ".join(fehler))
    neu = anwenden(data, rueck, [])
    weg = {k["id"] for k in S.get("neue_knoten", [])}
    if isinstance(neu, dict):
        neu["flows"] = [n for n in neu["flows"] if n["id"] not in weg]
    else:
        neu = [n for n in neu if n["id"] not in weg]
    erlaubt = {(c["id"], c["feld"]) for c in S["aenderungen"]}
    A = {n["id"]: n for n in knoten(neu)}
    for i in A:
        o = N[i]
        if any(o.get(k, "\0") != A[i].get(k, "\0") and (i, k) not in erlaubt for k in set(o) | set(A[i])):
            raise Abbruch("Rueckbau aendert %s ausserhalb der Sicherung" % i)
    if set(N) - set(A) - weg:
        raise Abbruch("Rueckbau entfernt mehr als die neuen Knoten")
    return neu, len(rueck), len(weg & set(N))


def main():
    ap = argparse.ArgumentParser(description="ui-review-b: Kern-Knoten-Patches (nur Darstellung)")
    ap.add_argument("flows")
    m = ap.add_mutually_exclusive_group(required=True)
    m.add_argument("--dry-run", action="store_true")
    m.add_argument("--apply", action="store_true")
    m.add_argument("--revert", action="store_true")
    ap.add_argument("--punkte", help="Komma-Liste, Standard alle: " + ",".join(REIHENFOLGE))
    ap.add_argument("--out")
    ap.add_argument("--sicherung")
    a = ap.parse_args()
    data, fmt = laden(a.flows)
    try:
        if a.revert:
            if not a.sicherung:
                raise Abbruch("--revert braucht --sicherung <datei>")
            neu, n, k = rueckbau(data, json.load(open(a.sicherung, encoding="utf-8")))
            out = a.out or a.flows.replace(".json", "") + ".zurueck.json"
            schreiben(out, neu, fmt)
            print("Rueckbau: %d Werte zurueckgesetzt, %d neue Knoten entfernt -> %s" % (n, k, out))
            return 0
        punkte = punkte_liste(a.punkte)
        changes, neue, schon = plan(knoten(data), punkte)
        neu = anwenden(data, changes, neue)
        ids = whitelist(data, neu, {(c[2], c[3]) for c in changes}, {k["id"] for k in neue})
        print("ui_kern_b_patch: %s (%d Knoten), Punkte %s, Modus %s" % (a.flows, len(knoten(data)), ",".join(punkte), "Probelauf" if a.dry_run else "Anwenden"))
        for (p, seite, i, feld, _alt, _neu, grund) in changes:
            print("  P%-3s %-11s %s.%s: %s" % (p, seite, i, feld, grund))
        for k in neue:
            print("  neu  %s (%s) %s" % (k["id"], k["type"], k.get("name", "")))
        print("  schon neu: %d · geaenderte/neue Knoten: %d" % (schon, len(ids)))
        if a.apply:
            out = a.out or a.flows.replace(".json", "") + ".uib.json"
            sich = a.sicherung or out.replace(".json", "") + ".sicherung.json"
            schreiben(out, neu, fmt)
            json.dump({"erzeugt": datetime.datetime.now().isoformat(timespec="seconds"), "quelle": os.path.abspath(a.flows), "ziel": os.path.abspath(out), "punkte": punkte,
                       "aenderungen": [{"punkt": c[0], "seite": c[1], "id": c[2], "feld": c[3], "alt": c[4], "neu": c[5], "grund": c[6]} for c in changes],
                       "neue_knoten": neue}, open(sich, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            print("geschrieben: %s\nSicherung:   %s" % (out, sich))
        print("IDS " + ",".join(ids))
        return 0
    except Abbruch as e:
        print("ABBRUCH: %s\nNichts geschrieben." % e)
        return 2


if __name__ == "__main__":
    sys.exit(main())

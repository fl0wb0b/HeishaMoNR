#!/usr/bin/env python3
"""Kern-Patch: Strom-Korrektur (+pelKorrW bei laufendem Verdichter) in HeishaMoNR-Kernknoten.

Hintergrund (Forum 189605, 14.10.2026; Belege 4545989 / 4597230 / 4145844): die internen Stromwerte TOP16
(Heat_Power_Consumption) bzw. TOP41 (DHW_Power_Consumption) liegen bei laufendem Verdichter rund 80 W unter dem
tatsaechlich aufgenommenen Strom. Ueberall gilt dieselbe Konstante wie im Optimierer: OPT_cfg.cop.pelKorrW
(Standard 80 W, nur 0...200 W zulaessig, sonst 80).

Korrekturen (Gruppen):
  cop       COP_calculated (f4e55b938e645737, Tab "WP Control"): nach
                var idle = (Energy_Consumption === 0) || (isFinite(compFreq) && compFreq === 0);
            wird bei laufendem Verdichter pelKorrW auf Energy_Consumption addiert -> COP_HEAT/COP_DHW
            (-> "panasonic/cop" -> Venus/VRM). Prod_HEAT/Prod_DHW (Waermeleistung) bleiben unveraendert.
  kwh       Energy_Consumption_HEAT_kWh (5792c915eb0eb380) und Energy_Consumption_DHW_kWh (cd16de04c8fa639a),
            Tab "WP Degreedays": integrieren den rohen TOP16/TOP41-Wert (PreviousMessage [W] * Sekunden / 3600000
            = kWh je Intervall). Vor der Rechenzeile wird PreviousMessage + pelKorrW gerechnet, wenn
            PreviousMessage > 0 und global compressor_frequency > 0. Speist kwh_HEAT/DHW_24h/31d und
            "kWh pro Gradtag". Bisherige Historie bleibt roh.
  leistung  "function 14" (c94a4674e4c896e0, Tab "WP Dash"): Serie "Aufnahme" im Diagramm "Leistung [W]"
            (TOP16/TOP41 roh) wird bei compressor_frequency > 0 um pelKorrW erhoeht.
Nicht geaendert: "Log all WP info" und die globals TOP16_/TOP41_..._Energy_Consumption (bleiben roh).

Aufruf:
    python3 kern_cop_patch.py --apply  "<flows.json>" [--nur cop,kwh,leistung] [--out <ziel.json>]
    python3 kern_cop_patch.py --revert "<flows.json>" [--nur ...]              [--out <ziel.json>]
    python3 kern_cop_patch.py --check  "<flows.json>"   (zeigt nur den Zustand je Knoten)

--apply aendert nur Knoten im erwarteten Altzustand ("original") und laesst bereits gepatchte stehen; --revert
nimmt nur exakt gepatchte zurueck. Ein Knoten im Zustand "unbekannt" (Altwert weicht ab) fuehrt zum Abbruch ohne
Aenderung (Exit-Code 2). Die Datei wird textuell geaendert (nur die JSON-Strings der func-Felder), damit Formatierung
und Reihenfolge erhalten bleiben; danach wird geprueft, dass sich genau die geaenderten Knoten und dort nur func
unterscheiden. Eingabe darf ein Export als Liste oder als {"rev":..., "flows":[...]} sein.
"""
import argparse
import json
import sys

KORR_W = (
    "    var {v}Cfg = global.get('OPT_cfg');\n"
    "    var {v}W = Number((({v}Cfg && {v}Cfg.cop) || {{}}).pelKorrW);\n"
    "    if (!(isFinite({v}W) && {v}W >= 0 && {v}W <= 200)) {{ {v}W = 80; }}\n"
)

# --- cop: COP_calculated (unveraendert gegenueber der ersten Fassung, damit der Live-Stand als "gepatcht" erkannt wird)
COP_ANCHOR = "var idle = (Energy_Consumption === 0) || (isFinite(compFreq) && compFreq === 0);"
COP_MARK = "// COP-Korrektur (Kern):"
COP_BLOCK = (
    "\n" + COP_MARK + " TOP16/TOP41 liegen bei laufendem Verdichter rund 80 W unter dem echten Strom\n"
    "// (Forum 189605, 14.10.2026; Belege 4545989/4597230/4145844). Gleiche Konstante wie im Optimierer: OPT_cfg.cop.pelKorrW\n"
    "// (Standard 80 W, nur 0...200 W). Gilt fuer COP_HEAT und COP_DHW; Prod_HEAT/Prod_DHW bleiben unveraendert.\n"
    "if (!idle && isFinite(compFreq) && compFreq > 0) {\n"
    "    var copKorrCfg = global.get('OPT_cfg');\n"
    "    var copKorrW = Number(((copKorrCfg && copKorrCfg.cop) || {}).pelKorrW);\n"
    "    if (!(isFinite(copKorrW) && copKorrW >= 0 && copKorrW <= 200)) { copKorrW = 80; }\n"
    "    Energy_Consumption = Number(Energy_Consumption) + copKorrW;\n"
    "}"
)

# --- kwh: Energy_Consumption_HEAT_kWh / _DHW_kWh
KWH_ANCHOR = "            msg5.payload = (PreviousMessage * ( temp / 3600000 ));   //  Calculation to Wh portion"
KWH_MARK = "// kWh-Korrektur (Kern):"
KWH_BLOCK = (
    "            " + KWH_MARK + " TOP16/TOP41 liegen bei laufendem Verdichter rund 80 W unter dem echten Strom\n"
    "            // (Forum 189605, 14.10.2026). Gleiche Konstante wie Optimierer und COP_calculated: OPT_cfg.cop.pelKorrW\n"
    "            // (Standard 80 W, nur 0...200 W). Nur der rohe Wert des abgelaufenen Intervalls wird erhoeht.\n"
    "            if (Number(PreviousMessage) > 0 && Number(global.get('compressor_frequency')) > 0) {\n"
    + "".join("            " + l + "\n" for l in KORR_W.format(v="kwhKorr").splitlines()) +
    "                PreviousMessage = Number(PreviousMessage) + kwhKorrW;\n"
    "            }\n"
)

# --- leistung: function 14 (Serie "Aufnahme" in "Leistung [W]")
PWR_OLD = 'msg.topic = "Aufnahme"; return msg;'
PWR_MARK = "// Leistungs-Korrektur (Kern):"
PWR_NEW = (
    'msg.topic = "Aufnahme";\n'
    "    " + PWR_MARK + " TOP16/TOP41 + OPT_cfg.cop.pelKorrW bei laufendem Verdichter (Forum 189605, 14.10.2026;\n"
    "    // gleiche Konstante wie Optimierer und COP_calculated, Standard 80 W, nur 0...200 W).\n"
    "    if (Number(global.get('compressor_frequency')) > 0) {\n"
    + "".join("    " + l + "\n" for l in KORR_W.format(v="pwrKorr").splitlines()) +
    "        msg.payload = Number(msg.payload) + pwrKorrW;\n"
    "    }\n"
    "    return msg;"
)

PATCHES = [
    # gruppe, id, name, alt, neu, markierung, (zusatzpruefung: text, erwartete Anzahl im Altwert)
    ("cop", "f4e55b938e645737", "COP_calculated", COP_ANCHOR, COP_ANCHOR + COP_BLOCK, COP_MARK,
     ("= Watt_heat_c / Energy_Consumption;", 2)),
    ("kwh", "5792c915eb0eb380", "Energy_Consumption_HEAT_kWh", KWH_ANCHOR, KWH_BLOCK + KWH_ANCHOR, KWH_MARK,
     ("msg5.topic = 'Energy_Consumption_HEAT_kWh';", 1)),
    ("kwh", "cd16de04c8fa639a", "Energy_Consumption_DHW_kWh", KWH_ANCHOR, KWH_BLOCK + KWH_ANCHOR, KWH_MARK,
     ("msg5.topic = 'Energy_Consumption_DHW_kWh';", 1)),
    ("leistung", "c94a4674e4c896e0", "function 14 (Aufnahme)", PWR_OLD, PWR_NEW, PWR_MARK,
     ('if (msg.payload > 0) { msg.topic = "Aufnahme";', 1)),
]


def fail(text):
    print("ABBRUCH: " + text, file=sys.stderr)
    sys.exit(2)


def nodes_of(data):
    return data if isinstance(data, list) else data.get("flows", [])


def state(func, p):
    _, _, _, old, new, mark, (extra, n_extra) = p
    if mark in func:
        if func.count(new) == 1 and func.count(mark) == 1:
            return "gepatcht"
        return "unbekannt (Markierung ohne exakten Block)"
    if func.count(old) != 1:
        return "unbekannt (Altzeile %dx)" % func.count(old)
    if func.count(extra) != n_extra:
        return "unbekannt (Pruefzeile %dx statt %d)" % (func.count(extra), n_extra)
    return "original"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--apply", action="store_true")
    g.add_argument("--revert", action="store_true")
    g.add_argument("--check", action="store_true")
    ap.add_argument("flows")
    ap.add_argument("--nur", help="Gruppen, kommagetrennt: cop,kwh,leistung (Standard: alle)")
    ap.add_argument("--out", help="Zieldatei (Standard: Eingabedatei ueberschreiben)")
    a = ap.parse_args()

    gruppen = {p[0] for p in PATCHES}
    wahl = set(a.nur.split(",")) if a.nur else gruppen
    if not wahl <= gruppen:
        fail("unbekannte Gruppe(n): %s" % sorted(wahl - gruppen))

    raw = open(a.flows, encoding="utf-8").read()
    data = json.loads(raw)
    by_id = {n.get("id"): n for n in nodes_of(data)}

    out, changed, report = raw, {}, []
    for p in PATCHES:
        grp, nid, name, old, new, _, _ = p
        node = by_id.get(nid)
        if node is None:
            fail("Knoten %s (%s) nicht gefunden" % (name, nid))
        func = node["func"]
        st = state(func, p)
        if a.check or grp not in wahl:
            report.append("%-9s %-28s %s" % (grp, name, st))
            continue
        if st.startswith("unbekannt"):
            fail("%s ist nicht im erwarteten Zustand: %s" % (name, st))
        if a.apply and st == "gepatcht" or a.revert and st == "original":
            report.append("%-9s %-28s %s (unveraendert)" % (grp, name, st))
            continue
        neu = func.replace(old, new, 1) if a.apply else func.replace(new, old, 1)
        if state(neu, p) != ("gepatcht" if a.apply else "original"):
            fail("%s: Ergebnis nicht im Zielzustand" % name)
        # textuell ersetzen (Formatierung bleibt), sonst abbrechen
        for enc in (lambda s: json.dumps(s, ensure_ascii=False), json.dumps):
            if out.count(enc(func)) == 1:
                out = out.replace(enc(func), enc(neu), 1)
                break
        else:
            fail("%s: func-String nicht eindeutig im Dateitext gefunden (Kodierung?)" % name)
        changed[nid] = neu
        report.append("%-9s %-28s %s -> %s" % (grp, name, st, state(neu, p)))

    print("\n".join(report))
    if a.check or not changed:
        if not a.check:
            print("nichts zu tun")
        return

    # Gegenpruefung: genau die geaenderten Knoten, dort nur das Feld func
    after_data = json.loads(out)
    after = {n.get("id"): n for n in nodes_of(after_data)}
    if set(by_id) != set(after) or len(nodes_of(data)) != len(nodes_of(after_data)):
        fail("Knotenmenge hat sich veraendert")
    if isinstance(data, dict) and {k: v for k, v in data.items() if k != "flows"} != \
            {k: v for k, v in after_data.items() if k != "flows"}:
        fail("Kopfdaten (rev) haben sich veraendert")
    diff = sorted(i for i in by_id if by_id[i] != after[i])
    if diff != sorted(changed):
        fail("unerwartete Unterschiede: %s" % diff)
    for nid, neu in changed.items():
        b, c = dict(by_id[nid]), dict(after[nid])
        if b.pop("func") == c.pop("func") or b != c or after[nid]["func"] != neu:
            fail("Knoten %s: unterscheidet sich mehr als func oder func nicht wie erwartet" % nid)

    with open(a.out or a.flows, "w", encoding="utf-8") as f:
        f.write(out)
    print("ok: %d Knoten geaendert (%s)" % (len(changed), a.out or a.flows))


if __name__ == "__main__":
    main()

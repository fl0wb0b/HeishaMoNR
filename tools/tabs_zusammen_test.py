#!/usr/bin/env python3
"""Pruefungen fuer tools/tabs_zusammen_patch.py auf einem Live-Export (nur lesen, schreibt nur in ein temporaeres Verzeichnis).

Usage: python3 tools/tabs_zusammen_test.py <flows_live.json>      (Export NACH ui_kompakt Teil A+B, VOR dem Zusammenlegen)
  1. Layout-Modell trifft die Live-Vermessung 13.10. 15:22 (11 Kernseiten, 1920 px)
  2. Probelauf: Whitelist, nur erlaubte Schluessel, keine opt_*-Knoten, Verdrahtung gleich, keine Knoten neu/geloescht
  3. Anwenden -> erneut anwenden aendert nichts -> Rueckbau byte-gleich; Teil A (Generator) und dieser Patch sind vertauschbar
  4. Abweichende Ausgangswerte und verbotene Aenderungen werden abgelehnt
  5. Verweise: jeder Gruppen-Schluessel, der vorher eine Gruppe traf, trifft nachher dieselbe; Gruppennamen je Tab eindeutig;
     Menue-Formular und fixTabs nennen nur sichtbare Tabs; fixTabs (im vm ausgefuehrt) blendet keinen alten Tab mehr ein
  6. Layout: keine Ueberlappung in allen Umschalt-Zustaenden (1000-2600 px in 10-px-Schritten), kein waagrechtes Scrollen bei 1024
     (ausser Zeitplan/SYSTEM), Hoehen bei 1920 wie geplant und hoechstens 1400 px in jedem Zustand, alte Tabs leer und ausgeblendet
"""
import copy
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("tzp", os.path.join(HERE, "tabs_zusammen_patch.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
U = P.UKP
ok = fail = 0


def check(name, cond, info=""):
    global ok, fail
    print(("OK   " if cond else "FAIL ") + name + (("  -> " + str(info)) if info != "" else ""))
    if cond:
        ok += 1
    else:
        fail += 1


src = sys.argv[1]
live, fmt = P.laden(src)
if P.plan(live)[1]:
    print("Hinweis: %s ist schon (teilweise) zusammengelegt - die Pruefungen brauchen einen Export VOR dem Patch." % src)
    sys.exit(2)
A = {n["id"]: n for n in live}

# 1 Modell gegen Live-Vermessung
h0 = {name: r[1920][0] for name, _i, r in P.seiten_hoehen(live, P.VERSTECKT_ALT)}
kern = [k for k in P.LIVE_1920 if not k.startswith(("Optimier", "Wärme", "Quiet", "Daten"))]
check("Modell = Live-Vermessung 13.10. 15:22 bei 1920 px (11 Kernseiten)", all(h0.get(k) == P.LIVE_1920[k] for k in kern), {k: (h0.get(k), P.LIVE_1920[k]) for k in kern if h0.get(k) != P.LIVE_1920[k]})

# 2 Probelauf
changes, schon = P.plan(live)
neu = P.anwenden(live, changes)
ids, typen = P.whitelist(live, neu)
B = {n["id"]: n for n in neu}
check("Probelauf: Aenderungen vorhanden, nichts bereits umgesetzt", len(changes) > 80 and schon == 0, "%d Werte, %d Knoten" % (len(changes), len(ids)))
check("keine Knoten neu, geloescht oder umsortiert", [n["id"] for n in live] == [n["id"] for n in neu])
check("keine opt_*-Knoten geaendert", not [i for i in ids if i.startswith("opt_")])
ref_ids = {v[1] for v in P.VERWEISE}
nicht_ui = sorted(i for i in ids if not A[i]["type"].startswith("ui_"))
check("Nicht-UI-Knoten nur die benannten Verweis-Knoten (2 Injects, Store settings)", set(nicht_ui) <= ref_ids and len(nicht_ui) == 3, nicht_ui)
check("Verdrahtung aller Knoten unveraendert (wires, links)", all(A[i].get("wires") == B[i].get("wires") and A[i].get("links") == B[i].get("links") for i in A))
keys = set()
for i in ids:
    t = A[i]["type"]
    kind = t if t in ("ui_tab", "ui_group") else ("verweis" if i in ref_ids else "widget")
    keys |= {(kind, k) for k in set(A[i]) | set(B[i]) if A[i].get(k) != B[i].get(k)}
check("nur erlaubte Schluessel (Tab name/hidden; Gruppe tab/name/width/order; Widget width/height/order; Verweise payload/options/formValue/func)",
      keys <= {("ui_tab", "name"), ("ui_tab", "hidden"), ("ui_group", "tab"), ("ui_group", "name"), ("ui_group", "width"), ("ui_group", "order"),
               ("widget", "width"), ("widget", "height"), ("widget", "order"), ("verweis", "payload"), ("verweis", "options"), ("verweis", "formValue"), ("verweis", "func")}, sorted(keys))
check("Widgets wechseln keine Gruppe", all(A[i].get("group") == B[i].get("group") for i in A))
check("Gruppen wechseln nur innerhalb derselben neuen Seite", all(P._seite_von(A[i]["tab"]) == P._seite_von(B[i]["tab"]) for i in ids if A[i]["type"] == "ui_group" and A[i]["tab"] != B[i]["tab"]))
fa, fb = A["5a44b5cc5e9f4844"]["func"], B["5a44b5cc5e9f4844"]["func"]
check("Store settings: nur der map/Zuordnungs-Block von fixTabs ersetzt (genau eine Stelle, Rest des Codes zeichengleich)",
      fa.count(P.FIX_ALT) == 1 and fa.replace(P.FIX_ALT, P.FIX_NEU) == fb and fa[:fa.index(P.FIX_ALT)] == fb[:fb.index(P.FIX_NEU)], len(fb) - len(fa))

# 3 Anwenden, idempotent, Rueckbau, vertauschbar mit dem Generator
tool = os.path.join(HERE, "tabs_zusammen_patch.py")
with tempfile.TemporaryDirectory() as d:
    out, sich, back = os.path.join(d, "neu.json"), os.path.join(d, "s.json"), os.path.join(d, "zurueck.json")
    r1 = subprocess.run([sys.executable, tool, src, "--apply", "--out", out, "--sicherung", sich], capture_output=True, text=True)
    c1 = r1.returncode == 0 and os.path.exists(out) and os.path.exists(sich) and "\nIDS " in r1.stdout
    check("--apply schreibt Datei und Sicherung, gibt die IDs aus", c1, "" if c1 else r1.stdout[-300:] + r1.stderr[-300:])
    r2 = subprocess.run([sys.executable, tool, out, "--dry-run"], capture_output=True, text=True)
    check("erneut anwenden: nichts zu tun (idempotent)", r2.returncode == 0 and "Geaenderte Knoten: 0 " in r2.stdout, [l for l in r2.stdout.splitlines() if "Whitelist" in l or "ABBRUCH" in l])
    r3 = subprocess.run([sys.executable, tool, out, "--revert", "--sicherung", sich, "--out", back], capture_output=True, text=True)
    c3 = r3.returncode == 0 and open(back, "rb").read() == open(src, "rb").read()
    check("--revert aus der Sicherung ist byte-gleich mit dem Original", c3, "" if c3 else r3.stdout[:300])
    neu_f = json.load(open(out, encoding="utf-8"))
    check("geschriebene Datei = berechnetes Ergebnis, gleiches Schreibformat wie der Export", neu_f == neu and P.laden(out)[1] == fmt, fmt)
    rk = subprocess.run([sys.executable, os.path.join(HERE, "ui_kompakt_patch.py"), out, "--dry-run"], capture_output=True, text=True)
    check("ui_kompakt_patch laeuft auf dem Ergebnis nicht mehr (bricht ab statt Zone 2 auf einen umbenannten Tab zu legen)", rk.returncode == 2 and "ABBRUCH" in rk.stdout)
    sb = sorted(f for f in os.listdir(os.path.dirname(os.path.abspath(src))) if f.startswith("sicherung_B_") and f.endswith(".json"))
    if sb:
        rr = subprocess.run([sys.executable, os.path.join(HERE, "ui_kompakt_patch.py"), out, "--revert", "--sicherung", os.path.join(os.path.dirname(os.path.abspath(src)), sb[-1]),
                             "--out", os.path.join(d, "ukp_zurueck.json")], capture_output=True, text=True)
        check("Reihenfolge erzwungen: ui_kompakt --revert (%s) bricht auf dem zusammengelegten Stand ab, schreibt nichts" % sb[-1],
              rr.returncode == 2 and "Rueckbau nicht moeglich" in rr.stdout and not os.path.exists(os.path.join(d, "ukp_zurueck.json")))
    gen = os.path.join(HERE, "optimizer_phase1.py")
    ab, ba = os.path.join(d, "ab.json"), os.path.join(d, "ba.json")
    shutil.copy(src, ab)
    ra = subprocess.run([sys.executable, gen, ab], capture_output=True, text=True)
    rb = subprocess.run([sys.executable, tool, ab, "--apply", "--out", ab, "--sicherung", os.path.join(d, "s2.json")], capture_output=True, text=True)
    shutil.copy(out, ba)
    rc = subprocess.run([sys.executable, gen, ba], capture_output=True, text=True)
    a_b, b_a = json.load(open(ab, encoding="utf-8")), json.load(open(ba, encoding="utf-8"))
    cv = (ra.returncode == 0 and rb.returncode == 0 and rc.returncode == 0 and {n["id"]: n for n in a_b} == {n["id"]: n for n in b_a} and
          all(n == B.get(n["id"]) for n in b_a if not n["id"].startswith("opt_") and n["id"] in B))
    check("Teil A (Generator) und Kernseiten-Patch vertauschbar (A dann B = B dann A), Generator aendert nur opt_*", cv, "" if cv else (ra.stderr + rb.stdout[-200:] + rc.stderr)[-400:])

# 4 Ablehnungen
bad = copy.deepcopy(live)
next(n for n in bad if n["id"] == "9b8ec8b1b9f66309")["width"] = 16
try:
    P.plan(bad)
    check("abweichender Ausgangswert (Gruppenbreite) wird abgelehnt", False)
except P.Abbruch as e:
    check("abweichender Ausgangswert (Gruppenbreite) wird abgelehnt", "9b8ec8b1b9f66309" in str(e))
bad = copy.deepcopy(live)
next(n for n in bad if n["id"] == "be48f3104249b8a0")["payload"] = '{"group":{"show":["Heizkurve_Hilfe"]}}'
try:
    P.plan(bad)
    check("abweichender Verweis (Knopf-Nutzlast) wird abgelehnt", False)
except P.Abbruch as e:
    check("abweichender Verweis (Knopf-Nutzlast) wird abgelehnt", "be48f3104249b8a0" in str(e))
bad = copy.deepcopy(live)
s = next(n for n in bad if n["id"] == "5a44b5cc5e9f4844")
s["func"] = s["func"].replace("Degree_days: 'Gradtage'", "Degree_days: 'Gradtage', X: 'Y'")
try:
    P.plan(bad)
    check("abweichender fixTabs-Code wird abgelehnt", False)
except P.Abbruch as e:
    check("abweichender fixTabs-Code wird abgelehnt", "5a44b5cc5e9f4844" in str(e))
for desc, mut in (("Funktionscode", lambda N: N["9fb2ab0ff0488d63"].__setitem__("func", "return msg;")),
                  ("Verdrahtung", lambda N: N["59bc0c78b8b9ea90"].__setitem__("wires", [["x"]])),
                  ("Knopf-Nutzlast ohne Plan", lambda N: N["0d930849ad31e35a"].__setitem__("payload", "{}")),
                  ("Verweis anders umgeschrieben", lambda N: N["be48f3104249b8a0"].__setitem__("payload", '{"group":{"show":["Heizung_Zone1"],"hide":["CCC_Graph"]}}')),
                  ("Widget in andere Gruppe", lambda N: N["93759ef7c600fe14"].__setitem__("group", "4e7aaa8d2a717171")),
                  ("Gruppe auf fremde Seite", lambda N: N["e374621a9f5ac0d6"].__setitem__("tab", P.T_HEIZKURVE)),
                  ("fremden Tab umbenannt", lambda N: N["ac594a9d775ca4fb"].__setitem__("name", "Plan")),
                  ("fremden Tab ausgeblendet", lambda N: N["1a08b96c5aeb8d6e"].__setitem__("hidden", True)),
                  ("Tab-Icon", lambda N: N[P.T_HEIZKURVE].__setitem__("icon", "fa-fire")),
                  ("opt_*-Knoten", lambda N: N["opt_t_plan"].__setitem__("height", 3)),
                  ("Gruppe mit Titel", lambda N: N["e374621a9f5ac0d6"].__setitem__("disp", True)),
                  ("Knoten entfernt", None)):
    b2 = copy.deepcopy(neu)
    if mut is None:
        b2 = b2[:-1]
    else:
        mut({n["id"]: n for n in b2})
    try:
        P.whitelist(live, b2)
        check("Whitelist lehnt ab: " + desc, False)
    except P.Abbruch:
        check("Whitelist lehnt ab: " + desc, True)

# 5 Verweise
k0, k1 = P.gruppen_schluessel(live), P.gruppen_schluessel(neu)
st0, st1 = P.verweis_stellen(live), P.verweis_stellen(neu)
treffer, verloren, verwaist = 0, [], set()
for (i, f, k), (_i2, _f2, kn) in zip(st0, st1):
    if k in k0:
        treffer += 1
        if k1.get(kn) != k0[k]:
            verloren.append((i, k, kn))
    else:
        verwaist.add(k)
        if kn != k:
            verloren.append((i, k, kn, "verwaist umgeschrieben"))
check("gleiche Zahl Verweis-Stellen vorher/nachher, alle in derselben Reihenfolge", len(st0) == len(st1) and [x[:2] for x in st0] == [x[:2] for x in st1], (len(st0), len(st1)))
check("jeder Gruppen-Schluessel, der vorher eine Gruppe traf, trifft nachher genau dieselbe Gruppe (%d Stellen)" % treffer, treffer > 100 and not verloren, verloren[:4])
check("ohne Ziel schon vorher: nur die bekannten Altlasten (Zone 2 auf GUI, CCC_Graph, WAR/COOL/Solar), unveraendert", verwaist <= P.VERWAIST, sorted(verwaist - P.VERWAIST))
tabs1 = {n["id"]: n for n in neu if n["type"] == "ui_tab"}
dup = [(tabs1[t]["name"], g) for t in tabs1 for g in {x["name"] for x in neu if x["type"] == "ui_group" and x.get("tab") == t}
       if sum(1 for x in neu if x["type"] == "ui_group" and x.get("tab") == t and x["name"] == g) > 1 and not tabs1[t].get("hidden")]
check("Gruppennamen je sichtbarem Tab eindeutig (Schluessel eindeutig)", not dup, dup)
check("alle neuen Schluessel der verschobenen Gruppen eindeutig", all(len(k1.get(v, [])) == 1 for k, v in P.SCHLUESSEL.items()), [v for v in P.SCHLUESSEL.values() if len(k1.get(v, [])) != 1])
sichtbar = {t["name"] for t in tabs1.values() if not t.get("hidden")}
versteckt = {t["name"] for t in tabs1.values() if t.get("hidden")}
tv = P.tab_verweise(neu)
check("Menue-Formular und fixTabs nennen nur sichtbare Tabs; alle bisherigen Haken abgebildet",
      all(v in sichtbar for (i, w, v) in tv if i in (P.MENU_FORM, P.STORE)) and
      {v for (i, w, v) in tv if i == P.MENU_FORM} == {"Einstellungen", "Heizung", "Betrieb", "Zeitplan", "Auswertung", "Effizienz", "Optimierung"},
      [(i, w, v) for (i, w, v) in tv if i in (P.MENU_FORM, P.STORE) and v not in sichtbar])
alte_namen = {"Raumregelung", "Pumpendrehzahl", "Gradtage", "Heizkurve", "Sanftanlauf", "Temperaturen"}
check("kein \"tabs show\"/\"tab\"-Verweis auf einen alten Tabnamen (nur Power/Cool/Solar2DHW wie bisher)",
      not [x for x in tv if x[2] in alte_namen] and {x[2] for x in tv if x[0] not in (P.MENU_FORM, P.STORE)} <= {"Power", "Cool", "Solar²DHW"},
      [x for x in tv if x[2] in alte_namen or (x[0] not in (P.MENU_FORM, P.STORE) and x[2] not in ("Power", "Cool", "Solar²DHW"))])
FIX_HARNESS = r"""
const vm = require('vm'); const code = require('fs').readFileSync(0, 'utf8');
const fx = vm.runInNewContext(code.slice(0, code.indexOf('var GUI = global.get')) + '; fixTabs;', {});
const en = {SETTINGS: true, CCC: true, RTC: true, COOL: true, SOFTSTART: true, Pumpspeed: true, 'Solar²DHW': true, SCHEDULER: true, TEMPERATURES: true, EFFICIENCY: true, Degree_days: true};
const de = {Einstellungen: true, Heizkurve: false, Raumregelung: true, Sanftanlauf: false, Pumpendrehzahl: false, Zeitplan: true, Temperaturen: false, Gradtage: true, Effizienz: true, Optimierung: true};
console.log(JSON.stringify([fx({topic: 'tabs', payload: en}).payload, fx({topic: 'tabs', payload: de}).payload, fx({topic: 'group', payload: {a: 1}}).payload]));
"""
try:
    r = subprocess.run(["node", "-e", FIX_HARNESS], input=B["5a44b5cc5e9f4844"]["func"], capture_output=True, text=True, timeout=30)
    en, de, grp = json.loads(r.stdout.strip().splitlines()[-1])
    check("fixTabs (vm): Standard-Konfiguration -> nur neue Tabnamen, alle sichtbar; Cool/Solar weg",
          en == {"Einstellungen": True, "Heizung": True, "Betrieb": True, "Zeitplan": True, "Auswertung": True, "Effizienz": True}, en)
    check("fixTabs (vm): gespeicherte deutsche Schluessel -> zusammengelegt sichtbar, wenn eine alte Seite sichtbar war (ODER), sonst aus; Gruppen unveraendert",
          de == {"Einstellungen": True, "Heizung": True, "Betrieb": False, "Zeitplan": True, "Auswertung": True, "Effizienz": True, "Optimierung": True} and grp == {"a": 1}, de)
    check("fixTabs (vm): kein ausgegebener Schluessel ist ein ausgeblendeter Tab", not (set(en) | set(de)) & versteckt, sorted((set(en) | set(de)) & versteckt))
except (OSError, ValueError, IndexError, subprocess.SubprocessError) as e:
    check("fixTabs im vm (braucht node)", False, e)

# 6 Layout und Sichtbarkeit
M1 = U.Modell(neu)
ueber, quer, hoch, zust = [], [], [], {}
for t in [x for x in M1.tabs if not x.get("hidden")]:
    gs = [g["name"] for g in M1.seiten_gruppen(t["id"])]
    combos = [tuple(set(gs) - set(vis)) for vis in P.ZUSTAENDE[t["name"]]] if t["name"] in P.ZUSTAENDE else [P.VERSTECKT_NEU.get(t["name"], ())]
    for c in combos:
        for W in range(1000, 2601, 10):
            r = M1.seite(t, c, W)
            if r[2]:
                ueber.append((t["name"], W, sorted(set(gs) - set(c)), r[2]))
                break
        zust.setdefault(t["name"], []).append(M1.seite(t, c, 1920)[0])
    r = M1.seite(t, P.VERSTECKT_NEU.get(t["name"], ()), 1024)
    if r[1] and t["name"] not in ("Zeitplan", "SYSTEM"):
        quer.append(t["name"])
h1 = {name: r[1920][0] for name, _i, r in P.seiten_hoehen(neu, P.VERSTECKT_NEU)}
check("keine Ueberlappung von Gruppen in allen Umschalt-Zustaenden, 1000-2600 px (10-px-Schritte)", not ueber, ueber[:3])
check("kein waagrechtes Scrollen bei 1024 (ausser Zeitplan 28 und SYSTEM 24 breit, unveraendert)", not quer, quer)
check("Hoehen bei 1920 beim Oeffnen: Heizung 930, Betrieb 876, Auswertung 1200 (je wie die hoechste alte Teilseite)",
      (h1.get("Heizung"), h1.get("Betrieb"), h1.get("Auswertung")) == (930, 876, 1200), (h1.get("Heizung"), h1.get("Betrieb"), h1.get("Auswertung")))
check("neue Seiten in jedem Umschalt-Zustand hoechstens 1400 px bei 1920", all(max(zust[s]) <= 1400 for s in P.SEITEN), {s: zust[s] for s in P.SEITEN})
check("unveraenderte Seiten gleich hoch wie vorher", all(h1[s] == h0[s] for s in h1 if s in h0), {s: (h0.get(s), h1[s]) for s in h1 if s in h0 and h1[s] != h0[s]})
check("sichtbare Seiten 16 -> 13 (Kernseiten 11 -> 8; Optimierer-Seiten macht Teil A)", len(h0) == 16 and len(h1) == 13, (len(h0), len(h1)))
check("alte Tabs Raumregelung/Pumpendrehzahl/Gradtage: ausgeblendet und ohne sichtbare Gruppe",
      all(B[t]["hidden"] is True and not M1.seiten_gruppen(t) for t in P.EINGEGLIEDERT), [(t, B[t]["hidden"], [g["name"] for g in M1.seiten_gruppen(t)]) for t in P.EINGEGLIEDERT])
breit = [(g["name"], g["width"]) for t in P.SEITEN.values() for g in M1.seiten_gruppen(t[0]) if int(g["width"]) != 17 and g["name"] not in ("Erweitert", "Leisemodus-Zusatz Einstellungen")]
check("neue Seiten: Gruppen einheitlich 17 breit (nur Erweitert/Leisemodus 6, geprueft ohne Ueberlappung)", not breit, breit)
zu_breit = [(w["id"], w.get("name"), w["width"]) for t in P.SEITEN.values() for g in M1.seiten_gruppen(t[0]) for w in M1.gruppen_widgets(g["id"])
            if U._int(w.get("width")) > U._int(g["width"]) and U._int(w.get("width")) != U._int(A[w["id"]].get("width"))]
check("kein Widget wurde breiter als seine Gruppe gemacht (vorhandene 24er-Hilfetexte bleiben wie bisher)", not zu_breit, zu_breit)
print("\n%d OK, %d FAIL" % (ok, fail))
sys.exit(1 if fail else 0)

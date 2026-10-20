#!/usr/bin/env python3
"""Pruefungen fuer tools/ui_kern_b_patch.py auf einem Live-Export (nur lesen, schreibt nur in ein temporaeres Verzeichnis).

Usage: python3 tools/ui_kern_b_test.py <flows_live.json>
  1. je Punkt und alle zusammen: Probelauf, Whitelist (nur erklaerte Felder/Knoten, keine opt_*, Verdrahtung nur wo erklaert),
     anwenden -> erneut anwenden aendert nichts -> Rueckbau byte-gleich mit dem Export
  2. abweichender Altwert und verbotene Aenderungen werden abgelehnt
  3. die geaenderten Funktionen laufen in node mit Attrappen (Verhalten je Punkt)
  4. Generator (opt_*) und dieser Patch sind vertauschbar
"""
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ukb", os.path.join(HERE, "ui_kern_b_patch.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
ok = fail = 0


def check(name, cond, info=""):
    global ok, fail
    if cond:
        ok += 1
        print("OK   " + name)
    else:
        fail += 1
        print("FAIL " + name + ("  -> " + str(info) if info else ""))


def run(*args):
    r = subprocess.run([sys.executable, os.path.join(HERE, "ui_kern_b_patch.py")] + list(args), capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def fn_lauf(func, globals_, msg=None, flow=None, want_globals=False):
    """fuehrt den Text einer Funktion in node aus (global/flow als Attrappe), gibt das Ergebnis (JSON) zurueck"""
    js = ("const G=%s, FL=%s; const g={get:k=>G[k],set:()=>{}}, fl={get:k=>FL[k],set:()=>{}};"
          "const RED={util:{cloneMessage:m=>JSON.parse(JSON.stringify(m))}};"
          "const f=new Function('msg','global','flow','node','context','RED',%s);"
          "const r=f(%s,g,fl,{warn:()=>{},error:()=>{},send:()=>{},status:()=>{}},{get:()=>undefined,set:()=>{}},RED);console.log(JSON.stringify([r===undefined?null:r,G]));"
          % (json.dumps(globals_), json.dumps(flow or {}), json.dumps(func), json.dumps(msg or {})))
    r = subprocess.run(["node", "-e", js], capture_output=True, text=True)
    try:
        o = json.loads(r.stdout.strip().split("\n")[-1])
        return o if want_globals else o[0]
    except Exception:
        return "FEHLER " + r.stderr[-300:]


live = sys.argv[1]
T = tempfile.mkdtemp(prefix="uikernb-")
data, fmt = P.laden(live)
flows = P.knoten(data)
src = os.path.join(T, "live.json")
P.schreiben(src, data, fmt)
raw0 = open(src, encoding="utf-8").read()
A = {n["id"]: n for n in flows}

# 1 je Punkt und alle zusammen
for punkte in [[p] for p in P.REIHENFOLGE + P.OPTIONAL_PUNKTE] + [P.REIHENFOLGE, P.REIHENFOLGE + P.OPTIONAL_PUNKTE]:
    tag = " [P%s]" % ",".join(punkte)
    ch, neue, schon = P.plan(flows, punkte)
    erwartet = sum(len(P.PUNKTE[p]) for p in punkte)
    neu = P.anwenden(data, ch, neue)
    ids = P.whitelist(data, neu, {(c[2], c[3]) for c in ch}, {k["id"] for k in neue})
    check("Probelauf: alle %d erklaerten Werte aenderbar, %d neue Knoten%s" % (erwartet, sum(len(P.NEUE_KNOTEN.get(p, [])) for p in punkte), tag),
          len(ch) == erwartet and schon == 0 and len(neue) == sum(len(P.NEUE_KNOTEN.get(p, [])) for p in punkte), (len(ch), schon))
    B = {n["id"]: n for n in P.knoten(neu)}
    draht = {(c[2]) for c in ch if c[3] == "wires"}
    check("keine opt_*-Knoten, nichts geloescht, Verdrahtung nur wo erklaert" + tag,
          not [i for i in ids if i.startswith("opt_")] and set(A) <= set(B) and all(A[i].get("wires") == B[i].get("wires") for i in A if i not in draht), ids)
    o1, s1, o2, s2, z = (os.path.join(T, x) for x in ("n1.json", "s1.json", "n2.json", "s2.json", "z.json"))
    rc, out = run(src, "--apply", "--punkte", ",".join(punkte), "--out", o1, "--sicherung", s1)
    check("Anwenden" + tag, rc == 0, out[-300:])
    rc, out = run(o1, "--apply", "--punkte", ",".join(punkte), "--out", o2, "--sicherung", s2)
    check("erneut anwenden aendert nichts" + tag, rc == 0 and open(o1, encoding="utf-8").read() == open(o2, encoding="utf-8").read() and json.load(open(s2))["aenderungen"] == [] and json.load(open(s2))["neue_knoten"] == [], out[-300:])
    rc, out = run(o1, "--revert", "--sicherung", s1, "--out", z)
    check("Rueckbau byte-gleich mit dem Export" + tag, rc == 0 and open(z, encoding="utf-8").read() == raw0, out[-300:])

ALLE, NEUE, _s = P.plan(flows, P.REIHENFOLGE)
NEU = P.anwenden(data, ALLE, NEUE)
NB = {n["id"]: n for n in P.knoten(NEU)}

# 2 Ablehnung
bad = copy.deepcopy(data)
fid = P.PUNKTE[P.REIHENFOLGE[0]][0][1]
k = next(n for n in P.knoten(bad) if n["id"] == fid)
k["func"] = k["func"].replace(P.PUNKTE[P.REIHENFOLGE[0]][0][5], "// anders\n")
try:
    P.plan(P.knoten(bad), P.REIHENFOLGE)
    check("abweichender Altwert -> Abbruch", False)
except P.Abbruch:
    check("abweichender Altwert -> Abbruch", True)
neu2 = copy.deepcopy(NEU)
next(n for n in P.knoten(neu2) if n["id"] == "59bc0c78b8b9ea90")["width"] = 12
try:
    P.whitelist(data, neu2, {(c[2], c[3]) for c in ALLE}, {k["id"] for k in NEUE})
    check("verbotene Aenderung (Breite) -> Whitelist bricht ab", False)
except P.Abbruch:
    check("verbotene Aenderung (Breite) -> Whitelist bricht ab", True)

# 3 Verhalten (node)
# Punkt 4: Effizienz
spec2 = importlib.util.spec_from_file_location("uop", os.path.join(HERE, "ui_optik_patch.py"))
UO = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(UO)
check("P4 Tabelle: gleicher Filtertext wie ui_optik_patch.py --monate-filtern (beide Wege kompatibel)", P._TAB_NEU == UO._FILTER_NEU and P._TAB_ALT == UO._FILTER_ALT, "")
nach_optik = copy.deepcopy(flows)                    # Stand nach ui_optik_patch --monate-filtern (das Skript selbst laeuft auf v1.5 nicht mehr: Kopf-Knoten geaendert)
_k = next(n for n in nach_optik if n["id"] == UO.OPTIONAL[0][1])
_k["func"] = _k["func"].replace(UO._FILTER_ALT, UO._FILTER_NEU)
c4, n4, s4 = P.plan(nach_optik, ["4"])
check("P4 nach ui_optik_patch --monate-filtern: Tabelle gilt als schon neu, die zwei Diagrammfunktionen bleiben offen", s4 == 1 and len(c4) == 2, (s4, len(c4)))
rows = [{"id": 1, "date": "2025-11", "heat_cop": 0, "heat_energy_produced": 0}, {"id": 2, "date": "2026-10", "heat_cop": 5.51, "heat_energy_produced": 338.6},
        {"id": 3, "date": "2026-09", "heat_cop": "", "heat_energy_produced": ""}, {"id": 4, "date": "2026-08", "heat_cop": 0, "heat_energy_produced": 12}]
r = fn_lauf(NB["e79ba8ec58a2bbc4"]["func"], {}, flow={"table_efficiency": rows})
check("P4 Tabelle (node): leere Monate fallen weg, neueste zuerst", isinstance(r, dict) and [x["date"] for x in r["payload"]] == ["2026-10", "2026-08"], r)
lab = ["2025-11", "2025-12", "2026-01", "2026-09", "2026-10"]
cop = {"payload": [{"labels": lab, "series": ["HEAT"], "data": [[0, 0, 4.2, 0, 5.51]]}]}
wae = {"payload": [{"labels": lab, "series": ["HEAT"], "data": [[0, 0, 80, 3.5, 338.6]]}]}
r1 = fn_lauf(NB["d4198e0e57720e55"]["func"], {"COP_HEAT_24m": cop, "HEAT_Prod_24m": wae})
r2 = fn_lauf(NB["35c15a4c210a4b20"]["func"], {"COP_HEAT_24m": cop, "HEAT_Prod_24m": wae})
check("P4 COP pro Monat (node): nur Monate mit COP oder Waerme, Reihenfolge bleibt (2026-09: Waerme ohne COP bleibt mit 0)",
      isinstance(r1, dict) and r1["payload"][0]["labels"] == ["2026-01", "2026-09", "2026-10"] and r1["payload"][0]["data"] == [[4.2, 0, 5.51]] and r1["payload"][0]["series"] == ["Heizen"], r1)
check("P4 Waerme pro Monat (node): gleiche Monate wie COP", isinstance(r2, dict) and r2["payload"][0]["labels"] == ["2026-01", "2026-09", "2026-10"] and r2["payload"][0]["data"] == [[80, 3.5, 338.6]], r2)
r3 = fn_lauf(NB["d4198e0e57720e55"]["func"], {})
r4 = fn_lauf(NB["35c15a4c210a4b20"]["func"], {"HEAT_Prod_24m": wae})
check("P4 ohne Daten: leeres Diagramm statt Fehler; Waerme ohne COP-Speicher filtert nach eigenen Werten", r3 == {"payload": [{"labels": [], "series": ["Heizen"], "data": [[]]}]} and isinstance(r4, dict) and r4["payload"][0]["labels"] == ["2026-01", "2026-09", "2026-10"], (r3, r4))

# Punkt 9: Auswertung
check("P9 Schalter: nur das Ziel Diagramm wird auf den neuen Filter umgelegt (MQTT und Kachel unveraendert), Filter fuehrt auf das Diagramm",
      NB["a1c0b0000c0f0001"]["wires"] == [["d180ce6b9c6ad85a", "a1c0b0000c0f0010", P.KAPPE_ID]] and NB[P.KAPPE_ID]["wires"] == [["a1c0b0000c0f0012"]] and NB[P.KAPPE_ID]["z"] == A["a1c0b0000c0f0001"]["z"], "")
seq_js = ("const ctx={}; const context={get:k=>ctx[k],set:(k,v)=>{ctx[k]=v;}}; let T=0; const _now=Date.now; Date.now=()=>T;"
          "const f=new Function('msg','context',%s); const out=[];"
          "[[0,0],[60,9.5],[90,7.2],[200,7.6],[400,8.6],[500,22],[600,5.1],[700,0],[900,8.2],[1300,8.3],[1400,'']].forEach(([s,v])=>{T=1e9+s*1000; const r=f({payload:v,topic:'COP_HEAT'},context); out.push(r?r.payload:null);});"
          "console.log(JSON.stringify(out));" % json.dumps(NB[P.KAPPE_ID]["func"]))
r = subprocess.run(["node", "-e", seq_js], capture_output=True, text=True)
check("P9 Filter (node): Startspitze 9,5 nach Stillstand weg, 8,6 nach 6,7 min Laufzeit bleibt, 22 immer weg, 0 und leer gehen durch, nach neuem Stillstand 8,2 (3,3 min) weg und 8,3 (10 min) bleibt",
      r.stdout.strip() == json.dumps([0, None, 7.2, 7.6, 8.6, None, 5.1, 0, None, 8.3, ""], separators=(",", ":")), r.stdout + r.stderr[-300:])
pts = [{"x": 0, "y": 0}, {"x": 60000, "y": 9.5}, {"x": 90000, "y": 7.2}, {"x": 400000, "y": 8.6}, {"x": 500000, "y": 22}, {"x": 700000, "y": 0}, {"x": 760000, "y": 8.2}]
gesp = {"payload": [{"series": ["COP_HEAT"], "data": [pts], "labels": [""]}], "topic": "COP_HEAT"}
r = fn_lauf(NB["a1c0b0000c0f0061"]["func"], {"chart-cop": gesp}, want_globals=True)
check("P9 Laden (node): gespeicherte Ausreisser nach derselben Regel weg, gespeicherter Wert selbst unveraendert",
      isinstance(r, list) and [p["y"] for p in r[0]["payload"][0]["data"][0]] == [0, 7.2, 8.6, 0] and r[1]["chart-cop"] == gesp, r)
check("P9 Laden ohne Speicher: null wie bisher", fn_lauf(NB["a1c0b0000c0f0061"]["func"], {}) is None, "")
lab = ["09-20", "09-21", "09-22", "10-08", "10-09", "10-10"]
mk = lambda d: {"payload": [{"labels": lab, "data": [d]}]}
r = fn_lauf(NB["2391637fadbbf190"]["func"], {"kwh_HEAT_31d": mk([0, 0, 0, 0, 5.4, 4.9]), "degreedays_31d": mk([0, 0, 0, 9.6, 7.1, 0]), "kwh_DHW_31d": mk([0] * 6)})
check("P9 31 Tage (node): beginnt am ersten Tag mit Gradtagen oder Energie, Luecken danach bleiben",
      isinstance(r, dict) and r["payload"][0]["labels"] == ["10-08", "10-09", "10-10"] and r["payload"][0]["data"] == [[9.6, 7.1, 0], [0, 5.4, 4.9]], r)
r = fn_lauf(NB["2391637fadbbf190"]["func"], {"kwh_HEAT_31d": mk([0] * 6), "degreedays_31d": mk([0] * 6), "kwh_DHW_31d": mk([0] * 6)})
r2 = fn_lauf(NB["2391637fadbbf190"]["func"], {"kwh_HEAT_31d": mk([1, 0, 0, 0, 0, 0]), "degreedays_31d": mk([0] * 6), "kwh_DHW_31d": mk([0] * 6)})
check("P9 31 Tage ohne Daten oder mit Daten ab Tag 1: alle 31 Tage wie bisher", isinstance(r, dict) and len(r["payload"][0]["labels"]) == 6 and len(r2["payload"][0]["labels"]) == 6, (r, r2))

# Punkt 10: Kleinkram
tabs = {n["id"]: n for n in flows if n["type"] == "ui_tab"}
ag = A[P.AUSGEBLENDET]
check("P10 Zielgruppe 'Ausgeblendet' liegt auf einem versteckten Tab (GUI), nicht angezeigt", ag["type"] == "ui_group" and tabs[ag["tab"]].get("hidden") is True, ag.get("tab"))
check("P10 7 Widgets aus dem Raster genommen (Gruppe -> Ausgeblendet), Reihenfolge/Breite/Inhalt unveraendert, ihre alten Gruppen behalten sichtbare Widgets",
      len(P.WEG) == 7 and all(NB[i]["group"] == P.AUSGEBLENDET and {k: v for k, v in NB[i].items() if k != "group"} == {k: v for k, v in A[i].items() if k != "group"} for (_s, i, _g, _r) in P.WEG) and
      all(any(n.get("group") == g for n in P.knoten(NEU)) for (_s, _i, g, _r) in P.WEG), "")
v15 = A["ui_optik_kopf"]["format"]
check("P10 weg: die per CSS versteckten Knoten von Betrieb/Effizienz/Übersicht; die drei Platzhalter-Hinweise der Seite Heizung bleiben in ihren Gruppen (Raster)",
      all(('node-id="%s"' % i) in v15 and NB[i]["group"] == P.AUSGEBLENDET for i in ["b22da9fe52b286cf", "4d7236c464d1c14e", "719e11414721599e"]) and
      all(('node-id="%s"' % i) in v15 and NB[i]["group"] == A[i]["group"] for i in ["36a9b7dad9d2611e", "3adf2738c40e2c50", "032ca56c8c21283e"]), "")
check("P10 Einstellungen: WÄRMEPUMPE, BETRIEB, HEIZEN beginnen nicht mehr mit einer leeren Linie (<left></left>)",
      all(sorted([n for n in P.knoten(NEU) if n.get("group") == g], key=lambda n: n.get("order", 0))[0].get("format", "").find("<left></left>") < 0 for g in ["fea7672db2f050c9", "548e51986bce11b0", "26d9e6cf24507b4f"]), "")
check("P10 Texte: Knopf 'Automatik', 'Vorlauf Ist'/'Rücklauf Ist' ohne Bindestriche, keine Kern-Beschriftung beginnt mehr mit '--'",
      NB["0fa2e5caff3f31a9"]["label"] == "Automatik" and NB["30a8e90354d6eb5d"]["label"] == "Vorlauf Ist" and NB["3f9cda20118a9a8a"]["label"] == "Rücklauf Ist" and
      not [n["id"] for n in P.knoten(NEU) if n["type"] == "ui_text" and str(n.get("label", "")).startswith("--")], "")

# Punkt 3c (optional): Uebersicht WAERMEPUMPE
c3, n3, _s = P.plan(flows, ["3c"])
N3 = {n["id"]: n for n in P.knoten(P.anwenden(data, c3, n3))}
rest = sorted([n for n in N3.values() if n.get("group") == P.UE_WP], key=lambda n: n["order"])
check("P3c (optional): 14 Dopplungen zum Schema aus WÄRMEPUMPE, Breite 12 -> 6 (Text wie bisher), es bleiben Schalter, Betriebsart, Aktuell, Ventilstellung, Zusatzfunktionen, Lüfter 2, Heizstab extern; jede Zeile passt in 6 Spalten",
      len(P.WEG_3C) == 14 and N3[P.UE_WP]["width"] == "6" and all(N3[i]["group"] == P.AUSGEBLENDET for (i, _t, _g) in P.WEG_3C) and
      [n["id"] for n in rest] == ["7b3d20aa8c9abb1e", "43403f14c1a863a4", "ef9758a537d81735", "354635fe353183fd", "f37c739180bdbc6e", "f0b7868c48887de4", "2b04b7dd5ea852f2", "3f05f1c6e437d5d3", "c66f65978915e688", "1eb00088db267256", "1b40f688e5fbc5dd", "b629087d36acf89e", "9faace07ea16ba4d", "cce68d6f8e62d22a", "5ca62cc2d15410db"] and
      all(int(n.get("width") or 0) <= 6 for n in rest), [n["id"] for n in rest])
check("P3c ist nicht im Standardumfang (nur mit --punkte ...,3c)", "3c" not in P.REIHENFOLGE and P.punkte_liste(None) == P.REIHENFOLGE, "")

# 4 vertauschbar mit dem Generator (opt_*)
gen = os.path.join(HERE, "optimizer_phase1.py")
a1, a2 = os.path.join(T, "a1.json"), os.path.join(T, "a2.json")
json.dump(flows, open(a1, "w", encoding="utf-8"), ensure_ascii=False)
subprocess.run([sys.executable, gen, a1, "--uebernahme-knoten-aktiv"], capture_output=True)
f1 = json.load(open(a1, encoding="utf-8"))
c1, n1, _s = P.plan(f1, P.REIHENFOLGE)
AB = P.anwenden(f1, c1, n1)
json.dump(P.knoten(NEU), open(a2, "w", encoding="utf-8"), ensure_ascii=False)
subprocess.run([sys.executable, gen, a2, "--uebernahme-knoten-aktiv"], capture_output=True)
BA = json.load(open(a2, encoding="utf-8"))
key = lambda L: sorted(json.dumps(n, sort_keys=True, ensure_ascii=False) for n in L)
check("Generator (opt_*) und Patch vertauschbar (A->B = B->A)", key(AB) == key(BA), "")
print("\nERGEBNIS ui_kern_b_test: %d OK, %d FAIL" % (ok, fail))
sys.exit(1 if fail else 0)

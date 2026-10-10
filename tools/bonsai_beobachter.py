#!/usr/bin/env python3
"""Bonsai-Beobachter: begleitet den Optimierer als Dauerhelfer (nur beratend, nie im Regelkreis).

1. Holt die Protokolle des Optimierers NUR LESEND: aus einem lokalen Ordner (Kopien) oder per Befehl, z. B.
   ssh fl0wb0b@10.10.10.128 docker exec node_red-node-red-1 cat /data/optimizer/<datei>
2. Rechnet die Tageszusammenfassung SELBST und deterministisch: Starts, Laeufe, Pausen, Heizgrenze, Soll-/Quiet-/Radiator-Ereignisse,
   Energie und COP, Raumverlaeufe gegen die Baender, Entscheidungen und Punkte der Entscheidungsmaschine, Messaufgabe Comfort/Efficiency,
   Datenqualitaet. Daraus feste Regel-Befunde (geprueft).
3. Fragt Bonsai (OpenAI-kompatibler llama-server, z. B. localhost:8080) nur kurze, belegte Plausibilitaetsfragen. Jede Aussage muss Fakten-
   Schluessel als Beleg nennen und darf nur Zahlen enthalten, die in diesen Fakten stehen; sonst wird sie verworfen. Die uebrigen sind
   Hypothesen ("ungeprueft"), der Hauptagent prueft sie gegen die Rohdaten. Ist Bonsai nicht erreichbar, entsteht der Bericht trotzdem.
4. Schreibt <ausgabe>/YYYY-MM-DD.md (deutsch) und <ausgabe>/befunde.json (je Tag: Schweregrad, Beleg, Status).

Nur Standardbibliothek. Schreibt nie an die Anlage, die NAS oder MQTT.

Beispiele:
  python3 tools/bonsai_beobachter.py --quelle /pfad/zu/kopien --tag 2026-10-09
  python3 tools/bonsai_beobachter.py --ssh --hosts-datei ~/Dokumente/bonsai/llm-hosts.txt
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

VERSION = 1
DATEI_MUSTER = re.compile(r"^(quiet|quiet-events|optimizer-v2|energy|decisions|scores|applied)-\d{4}-\d{2}\.(csv|jsonl)$")
SSH_STANDARD = ["ssh", "fl0wb0b@10.10.10.128", "docker", "exec", "node_red-node-red-1", "cat", "/data/optimizer/{datei}"]
AUSGABE_STANDARD = os.path.expanduser("~/Dokumente/heishamonr-optimizer/bonsai-berichte")
HOSTS_STANDARD = os.path.expanduser("~/Dokumente/bonsai/llm-hosts.txt")
RAEUME = [("ki_oben", "Kinderzimmer oben"), ("ki_unten", "Kinderzimmer unten"), ("schlaf", "Schlafzimmer"), ("wohn", "Wohnzimmer")]
SCHWERE = ("info", "hinweis", "warnung")


# ------------------------------------------------------------------ Quellen (nur lesen)
class OrdnerQuelle:
    """Lokale Kopien der Dateien aus /data/optimizer."""
    def __init__(self, ordner):
        self.ordner = ordner

    def lies(self, datei):
        if not DATEI_MUSTER.match(datei):
            raise ValueError("unerlaubter Dateiname: " + datei)
        p = os.path.join(self.ordner, datei)
        if not os.path.exists(p):
            return None
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()


class BefehlQuelle:
    """Liest per Befehl (Standard: ssh + docker exec cat). Nur 'cat' einer Datei aus /data/optimizer, ohne Shell, Dateiname geprueft."""
    def __init__(self, vorlage=None, timeout=120):
        self.vorlage = vorlage or SSH_STANDARD
        self.timeout = timeout

    def lies(self, datei):
        if not DATEI_MUSTER.match(datei):
            raise ValueError("unerlaubter Dateiname: " + datei)
        cmd = [x.replace("{datei}", datei) for x in self.vorlage]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=self.timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return None
        if r.returncode != 0:
            return None
        return r.stdout.decode("utf-8", errors="replace")


# ------------------------------------------------------------------ Einlesen
def zahl(x):
    if x is None or x == "":
        return None
    try:
        v = float(x)
    except ValueError:
        return None
    return v if v == v and abs(v) != float("inf") else None


def lies_csv(text):
    """CSV mit wechselnden Kopfzeilen (jede Zeile wird mit der zuletzt gesehenen Kopfzeile gelesen)."""
    zeilen, kopf = [], None
    for l in (text or "").split("\n"):
        if not l:
            continue
        p = l.split(",")
        if p[0] == "zeit":
            kopf = p
            continue
        if not kopf or len(p) != len(kopf):
            continue
        try:
            t = dt.datetime.strptime(p[0][:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        o = dict(zip(kopf, p))
        o["_t"] = t
        zeilen.append(o)
    zeilen.sort(key=lambda o: o["_t"])
    return zeilen


def lies_jsonl(text):
    out = []
    for l in (text or "").split("\n"):
        l = l.strip()
        if not l:
            continue
        try:
            out.append(json.loads(l))
        except ValueError:
            continue
    return out


def monate(tag):
    m = {tag.strftime("%Y-%m")}
    m.add((tag - dt.timedelta(days=1)).strftime("%Y-%m"))
    return sorted(m)


def lade(quelle, tag):
    """Alle benoetigten Dateien fuer den Tag und den Vortag (Monatswechsel beachtet)."""
    d = {"quiet": [], "events": [], "v2": [], "energy": [], "decisions": [], "scores": [], "applied": [], "fehlt": []}
    for m in monate(tag):
        for key, name, art in (("quiet", "quiet-%s.csv", "csv"), ("events", "quiet-events-%s.csv", "csv"), ("v2", "optimizer-v2-%s.csv", "csv"),
                               ("energy", "energy-%s.csv", "csv"), ("decisions", "decisions-%s.jsonl", "jsonl"), ("scores", "scores-%s.jsonl", "jsonl"),
                               ("applied", "applied-%s.jsonl", "jsonl")):
            txt = quelle.lies(name % m)
            if txt is None:
                d["fehlt"].append(name % m)
                continue
            d[key] += lies_csv(txt) if art == "csv" else lies_jsonl(txt)
    for k in ("quiet", "events", "v2", "energy"):
        d[k].sort(key=lambda o: o["_t"])
    return d


# ------------------------------------------------------------------ Tageszusammenfassung (deterministisch)
def zustand(r):
    hz = zahl(r.get("verdichter_hz"))
    if hz and hz > 0:
        return "lauf"
    z = r.get("zustand")
    if z in ("pause", "heizgrenze"):
        return z
    ps = zahl(r.get("pumpe_speed"))
    if ps is None:
        return "?"
    return "pause" if ps >= 1000 else "heizgrenze"


def r2(v):
    return None if v is None else round(v, 2)


def zusammenfassung(d, tag):
    """Fakten des Tages als flaches Woerterbuch (Schluessel -> Zahl/Text). Alle Zahlen stammen aus den Protokollen."""
    t0 = dt.datetime.combine(tag, dt.time(0, 0))
    t1 = t0 + dt.timedelta(days=1)
    F = {"tag": tag.isoformat()}
    Q = [r for r in d["quiet"] if t0 <= r["_t"] < t1]
    F["daten.minutenzeilen"] = len(Q)
    # Abdeckung und Luecken (aeltere Stillstandszeilen kamen im 5-min-Takt)
    luecken = []
    for a, b in zip(Q, Q[1:]):
        g = (b["_t"] - a["_t"]).total_seconds() / 60
        if g > 10:
            luecken.append((a["_t"].strftime("%H:%M"), round(g)))
    F["daten.luecken_ueber_10min"] = len(luecken)
    F["daten.groesste_luecke_min"] = max([g for _, g in luecken], default=0)
    if not Q:
        return F, {"luecken": luecken, "laeufe": []}
    # Zustaende, Laeufe, Pausen (Gewicht = Minuten bis zur naechsten Zeile, hoechstens 10)
    minuten = {"lauf": 0.0, "pause": 0.0, "heizgrenze": 0.0, "?": 0.0}
    el = th = 0.0
    segs = []
    for i, r in enumerate(Q):
        w = min(10.0, ((Q[i + 1]["_t"] - r["_t"]).total_seconds() / 60) if i + 1 < len(Q) else 1.0)
        z = zustand(r)
        minuten[z] += w
        p = zahl(r.get("leistung_el_w"))
        if p is not None:
            el += p * w / 60000
        if z == "lauf":
            pt = zahl(r.get("leistung_th_heisha_w"))
            if pt is None:
                pt = zahl(r.get("leistung_th_berechnet_w"))
            if pt is not None and pt > 0:
                th += pt * w / 60000
        if segs and segs[-1][0] == z:
            segs[-1][2] = r["_t"]
            segs[-1][3].append(r)
        else:
            segs.append([z, r["_t"], r["_t"], [r]])
    for k in ("lauf", "pause", "heizgrenze"):
        F["zustand.%s_min" % k] = round(minuten[k])
    laeufe = [s for s in segs if s[0] == "lauf"]
    dauer = [round((s[2] - s[1]).total_seconds() / 60) + 1 for s in laeufe]
    F["laeufe.starts"] = sum(1 for i, s in enumerate(segs) if s[0] == "lauf" and i > 0)
    F["laeufe.anzahl"] = len(laeufe)
    F["laeufe.mittel_min"] = round(sum(dauer) / len(dauer)) if dauer else 0
    F["laeufe.kuerzester_min"] = min(dauer) if dauer else 0
    F["laeufe.laengster_min"] = max(dauer) if dauer else 0
    pausen = [round((s[2] - s[1]).total_seconds() / 60) + 1 for i, s in enumerate(segs) if s[0] == "pause" and 0 < i < len(segs) - 1]
    F["pausen.anzahl"] = len(pausen)
    F["pausen.mittel_min"] = round(sum(pausen) / len(pausen)) if pausen else 0
    F["energie.strom_kwh"] = round(el, 2)
    F["energie.waerme_kwh"] = round(th, 2)
    F["energie.cop"] = round(th / el, 2) if el > 0.05 else None
    # Verdichter, Quiet, Soll, Aussentemperatur
    hz_lauf = [(zahl(r.get("verdichter_hz")), zahl(r.get("verdichter_laufzeit_min")), zahl(r.get("quiet_aktuell"))) for r in Q if zustand(r) == "lauf"]
    nach_start = [h for h, rt, q in hz_lauf if h is not None and (rt is None or rt >= 2)]
    F["verdichter.max_hz_ab_minute_2"] = max(nach_start, default=None)
    F["verdichter.minuten_ueber_20hz"] = sum(1 for h in nach_start if h > 20)
    F["verdichter.minuten_ueber_20hz_bei_quiet_ab_1"] = sum(1 for h, rt, q in hz_lauf if h and h > 20 and (rt is None or rt >= 2) and q is not None and q >= 1)
    for lv in (0, 1, 2, 3):
        F["quiet.stufe%d_min" % lv] = sum(1 for r in Q if zahl(r.get("quiet_aktuell")) == lv)
    hc = [zahl(r.get("heizregelung")) for r in Q]
    F["heizregelung.efficiency_min"] = sum(1 for x in hc if x == 1)
    F["heizregelung.comfort_min"] = sum(1 for x in hc if x == 0)
    soll = [zahl(r.get("soll_vl")) for r in Q if zahl(r.get("soll_vl")) is not None]
    F["soll.min"] = min(soll, default=None)
    F["soll.max"] = max(soll, default=None)
    F["soll.wechsel"] = sum(1 for a, b in zip(soll, soll[1:]) if a != b)
    at = [zahl(r.get("aussen")) for r in Q if zahl(r.get("aussen")) is not None]
    F["aussen.min"] = min(at, default=None)
    F["aussen.max"] = max(at, default=None)
    F["aussen.mittel"] = round(sum(at) / len(at), 1) if at else None
    rad = [zahl(r.get("kz_radiator_an")) for r in Q if zahl(r.get("kz_radiator_an")) is not None]
    F["radiator.an_anteil_prozent"] = round(100 * sum(rad) / len(rad)) if rad else None
    # Ereignisse (quiet-events)
    E = [e for e in d["events"] if t0 <= e["_t"] < t1]
    def ev(name):
        return [e for e in E if e.get("ereignis") == name]
    F["ereignisse.quiet_befehle"] = len(ev("quiet_befehl"))
    F["ereignisse.quiet_befehle_gui"] = sum(1 for e in ev("quiet_befehl") if "GUI" in e.get("wechsel", ""))
    F["ereignisse.quiet_stufenwechsel"] = len(ev("quiet_stufe"))
    F["ereignisse.sollspruenge"] = len(ev("sollsprung"))
    F["ereignisse.radiator_schaltungen"] = len(ev("kz_radiator"))
    F["ereignisse.heizregelung_befehle"] = len(ev("heizregelung_befehl"))
    F["ereignisse.optimierer_vorschlaege"] = len(ev("optimierer_vorschlag"))
    F["ereignisse.optimierer_hinweise"] = len(ev("optimierer_hinweis"))
    F["ereignisse.optimierer_klicks"] = sum(1 for e in E if e.get("ereignis", "").startswith("optimierer_uebernehmen") or e.get("ereignis", "") == "optimierer_rueckweg")
    # Raeume (optimizer-v2, 5 min)
    V = [r for r in d["v2"] if t0 <= r["_t"] < t1]
    for rid, _name in RAEUME:
        werte = [(zahl(r.get(rid + "_ema")), zahl(r.get(rid + "_min")), zahl(r.get(rid + "_max")), r.get(rid + "_gueltig")) for r in V if r.get(rid + "_min") not in (None, "")]
        if not werte:
            continue
        ts = [w[0] for w in werte if w[0] is not None]
        F["raum.%s.min" % rid] = round(min(ts), 2) if ts else None
        F["raum.%s.max" % rid] = round(max(ts), 2) if ts else None
        F["raum.%s.band" % rid] = "%s-%s" % (werte[-1][1], werte[-1][2])
        F["raum.%s.unter_min_min" % rid] = 5 * sum(1 for w in werte if w[0] is not None and w[1] is not None and w[0] < w[1])
        F["raum.%s.ueber_max_min" % rid] = 5 * sum(1 for w in werte if w[0] is not None and w[2] is not None and w[0] > w[2])
        F["raum.%s.ungueltig_prozent" % rid] = round(100 * sum(1 for w in werte if w[3] != "1") / len(werte))
    # Entscheidungsmaschine
    D = [x for x in d["decisions"] if str(x.get("t", "")).startswith(tag.isoformat())]
    F["maschine.datensaetze"] = len(D)
    st = {}
    props = set()
    for x in D:
        for r in x.get("r", []):
            st[(r.get("id"), r.get("st"))] = st.get((r.get("id"), r.get("st")), 0) + 1
            if r.get("st") in ("vorschlag", "hinweis") and r.get("p"):
                props.add(r.get("p"))
    for (rid, s), n in sorted(st.items()):
        F["maschine.%s.%s_min" % (rid, s)] = n
    F["maschine.vorschlaege"] = len(props)
    S = [x for x in d["scores"] if str(x.get("t", "")).startswith(tag.isoformat())]
    F["punkte.datensaetze"] = len(S)
    for x in S:
        k = "punkte.%s" % x.get("regel")
        F[k] = round(F.get(k, 0) + float(x.get("punkte") or 0), 2)
        F["punkte.%s.%s" % (x.get("regel"), x.get("typ"))] = F.get("punkte.%s.%s" % (x.get("regel"), x.get("typ")), 0) + 1
    A = [x for x in d["applied"] if str(x.get("t", "")).startswith(tag.isoformat())]
    F["uebernahme.aktionen"] = len(A)
    F["uebernahme.gesendet"] = sum(1 for x in A if x.get("ergebnis") == "gesendet")
    # Messaufgabe Comfort gegen Efficiency (Quiet 0, Vorlauf >= 2 K unter Soll, ab Minute 15) ueber alle geladenen Daten
    # gleiche Abgrenzung wie im Kern (engine_core.js, MESS): Quiet 0, Lauf ab Minute 15, 3 min nach einer Quiet-Aenderung, Vorlauf >= 2 K unter Soll
    mess = {0: [], 1: []}
    q_prev, q_chg = None, None
    for r in d["quiet"]:
        q = zahl(r.get("quiet_aktuell"))
        if q is not None and q_prev is not None and q != q_prev:
            q_chg = r["_t"]
        if q is not None:
            q_prev = q
        if zustand(r) != "lauf" or q != 0 or (q_chg is not None and (r["_t"] - q_chg).total_seconds() < 180):
            continue
        h, s0, v0, rt = zahl(r.get("heizregelung")), zahl(r.get("soll_vl")), zahl(r.get("ist_vl")), zahl(r.get("verdichter_laufzeit_min"))
        if h in (0, 1) and s0 is not None and v0 is not None and s0 - v0 >= 2 and (rt is None or rt >= 15):
            mess[int(h)].append((zahl(r.get("verdichter_hz")), zahl(r.get("leistung_el_w")), zahl(r.get("aussen"))))
    for h, name in ((0, "comfort"), (1, "efficiency")):
        F["messaufgabe.%s_min" % name] = len(mess[h])
        if mess[h]:
            F["messaufgabe.%s_max_hz" % name] = max(x[0] for x in mess[h] if x[0] is not None)
            pe = [x[1] for x in mess[h] if x[1] is not None]
            F["messaufgabe.%s_mittel_w" % name] = round(sum(pe) / len(pe)) if pe else None
    F["messaufgabe.offen"] = 1 if (len(mess[0]) < 10 or len(mess[1]) < 10) else 0
    return F, {"luecken": luecken, "laeufe": [(s[1].strftime("%H:%M"), round((s[2] - s[1]).total_seconds() / 60) + 1) for s in laeufe], "props": sorted(props), "scores": S}


# ------------------------------------------------------------------ feste Regel-Befunde (geprueft, ohne LLM)
def regel_befunde(F, extra):
    B = []
    def b(schwere, titel, beleg, text):
        B.append({"schwere": schwere, "titel": titel, "beleg": beleg, "text": text, "status": "geprueft (Regel)", "quelle": "Beobachter"})
    if F.get("daten.minutenzeilen", 0) == 0:
        b("warnung", "Kein Minutenprotokoll", ["daten.minutenzeilen"], "Für den Tag gibt es keine Zeilen in quiet-*.csv.")
        return B
    if F.get("daten.luecken_ueber_10min", 0) > 0:
        b("warnung", "Lücken im Minutenprotokoll", ["daten.luecken_ueber_10min", "daten.groesste_luecke_min"],
          "%d Lücken über 10 min, die größte %d min (%s)." % (F["daten.luecken_ueber_10min"], F["daten.groesste_luecke_min"], ", ".join("%s: %d min" % x for x in extra["luecken"][:5])))
    if F.get("maschine.datensaetze", 0) and F["maschine.datensaetze"] < 0.9 * min(1440, F.get("daten.minutenzeilen", 1440)):
        b("warnung", "Entscheidungsmaschine lief nicht durchgehend", ["maschine.datensaetze", "daten.minutenzeilen"],
          "%d Entscheidungsdatensätze bei %d Minutenzeilen." % (F["maschine.datensaetze"], F["daten.minutenzeilen"]))
    for rid, name in RAEUME:
        u = F.get("raum.%s.ungueltig_prozent" % rid)
        if u is not None and u >= 30:
            b("hinweis", "%s oft ungültig" % name, ["raum.%s.ungueltig_prozent" % rid], "%s war %d %% der Zeit ungültig (Datenalter über dem Limit; die Shelly melden nur bei Änderung)." % (name, u))
        m = F.get("raum.%s.unter_min_min" % rid)
        if m is not None and m >= 120:
            b("hinweis", "%s lange unter Minimum" % name, ["raum.%s.unter_min_min" % rid, "raum.%s.min" % rid, "raum.%s.band" % rid],
              "%s lag %d min unter dem Minimum (tiefster Wert %s °C, Band %s)." % (name, m, F.get("raum.%s.min" % rid), F.get("raum.%s.band" % rid)))
    if F.get("verdichter.minuten_ueber_20hz_bei_quiet_ab_1", 0) > 0:
        b("hinweis", "Verdichter über 20 Hz trotz Quiet ≥ 1", ["verdichter.minuten_ueber_20hz_bei_quiet_ab_1"],
          "%d Minuten über 20 Hz mit Quiet ≥ 1 (ab Laufminute 2): Annahme „Quiet-Deckel = Minimum“ prüfen." % F["verdichter.minuten_ueber_20hz_bei_quiet_ab_1"])
    for x in extra.get("scores", []):
        if x.get("typ") == "schaden":
            b("warnung", "Schaden-Bewertung %s" % x.get("regel"), ["punkte.%s.schaden" % x.get("regel")], str(x.get("text")))
        if x.get("typ") == "verpasst":
            b("hinweis", "Verpasst %s" % x.get("regel"), ["punkte.%s.verpasst" % x.get("regel")], str(x.get("text")))
        if x.get("typ") == "messaufgabe":
            b("hinweis", "Messaufgabe Comfort/Efficiency erledigt", ["punkte.%s.messaufgabe" % x.get("regel")], str(x.get("text")))
    if F.get("messaufgabe.offen") == 1:
        b("info", "Messaufgabe Comfort/Efficiency offen", ["messaufgabe.comfort_min", "messaufgabe.efficiency_min"],
          "Bisher %d min Comfort und %d min Efficiency mit Quiet 0 und Vorlauf ≥ 2 K unter Soll (je 10 nötig)." % (F.get("messaufgabe.comfort_min", 0), F.get("messaufgabe.efficiency_min", 0)))
    if F.get("uebernahme.gesendet", 0) > 0:
        b("info", "Übernahmen per Klick", ["uebernahme.gesendet"], "%d Befehle per Klick gesendet (applied-*.jsonl)." % F["uebernahme.gesendet"])
    return B


# ------------------------------------------------------------------ Bonsai (nur beratend) und Pruefung seiner Aussagen
FRAGEN = [
    ("auffaelligkeiten", "Welche ein bis drei Werte des Tages sind auffällig oder widersprechen sich?"),
    ("vergleich", "Was hat sich gegenüber dem Vortag deutlich geändert (Schlüssel mit Präfix vortag.)?"),
    ("datenqualitaet", "Gibt es Hinweise auf Datenfehler oder fehlende Daten?"),
]
SYSTEM_PROMPT = ("Du prüfst Tageskennzahlen einer Luft/Wasser-Wärmepumpe (Panasonic, 5 kW, Heizkörper). Antworte NUR mit einem JSON-Array, "
                 "höchstens 3 Einträge, jeder Eintrag: {\"titel\": kurz, \"schwere\": \"info\"|\"hinweis\"|\"warnung\", \"beleg\": [Schlüssel aus den Fakten], "
                 "\"text\": ein Satz auf Deutsch}. Verwende NUR Zahlen, die in den genannten Belegen stehen. Keine Vermutung ohne Beleg. Leeres Array, wenn nichts auffällt.")


def zahlen_im_text(text):
    # Minus nur als Vorzeichen (nicht in "22.0-23.5"); Komma oder Punkt als Dezimaltrenner
    return [float(x.replace(",", ".")) for x in re.findall(r"(?<![\d.,])-?\d+(?:[.,]\d+)?", text or "")]


def pruefe_aussage(a, fakten):
    """Gibt (ok, grund) zurueck. Pflicht: Belege existieren; jede Zahl im Text steht (gerundet) in einem der Belege."""
    if not isinstance(a, dict):
        return False, "kein Objekt"
    beleg, text, schwere = a.get("beleg"), a.get("text"), a.get("schwere")
    if not isinstance(beleg, list) or not beleg or not all(isinstance(k, str) for k in beleg):
        return False, "ohne Beleg"
    fehl = [k for k in beleg if k not in fakten]
    if fehl:
        return False, "unbekannte Belege: " + ", ".join(fehl[:3])
    if not isinstance(text, str) or not text.strip() or len(text) > 400:
        return False, "Text fehlt oder zu lang"
    if schwere not in SCHWERE:
        return False, "Schweregrad unbekannt"
    werte = []
    for k in beleg:
        v = fakten[k]
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            werte.append(float(v))
        elif isinstance(v, str):
            werte += zahlen_im_text(v)
    for z in zahlen_im_text(text):
        if not any(abs(z - w) <= max(0.051, 0.011 * abs(w)) for w in werte):
            return False, "Zahl %s steht in keinem Beleg" % z
    return True, ""


def frage_bonsai(frag, fakten, frage, modell=None, timeout=90):
    """Eine kurze Frage an Bonsai; frag(messages) -> Antworttext (oder Ausnahme)."""
    msgs = [{"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "Fakten (JSON):\n" + json.dumps(fakten, ensure_ascii=False, sort_keys=True) + "\n\nFrage: " + frage}]
    txt = frag(msgs)
    m = re.search(r"\[.*\]", txt or "", re.S)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except ValueError:
        return []
    return arr if isinstance(arr, list) else []


def http_frager(hosts, modell=None, timeout=90):
    """OpenAI-kompatibler llama-server (Bonsai). Probiert die Hosts der Reihe nach."""
    def frag(msgs):
        fehler = None
        for h in hosts:
            url = h.rstrip("/") + "/v1/chat/completions"
            body = json.dumps({"model": modell or "bonsai", "messages": msgs, "temperature": 0.1, "max_tokens": 500}).encode("utf-8")
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    j = json.loads(r.read().decode("utf-8"))
                return j["choices"][0]["message"]["content"]
            except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError) as e:
                fehler = e
        raise ConnectionError("Bonsai nicht erreichbar: %s" % fehler)
    return frag


def bonsai_befunde(frag, F, F_vortag):
    fakten = dict(F)
    for k, v in (F_vortag or {}).items():
        fakten["vortag." + k] = v
    gut, verworfen, fehler = [], [], None
    for key, frage in FRAGEN:
        try:
            arr = frage_bonsai(frag, fakten, frage)
        except Exception as e:                       # Bonsai ist nur Helfer: Ausfall = keine Hypothesen, Bericht entsteht trotzdem
            fehler = str(e)
            break
        for a in arr:
            ok, grund = pruefe_aussage(a, fakten)
            if ok:
                gut.append({"schwere": a["schwere"], "titel": str(a.get("titel") or key)[:80], "beleg": a["beleg"], "text": a["text"].strip(), "status": "ungeprüft", "quelle": "Bonsai", "frage": key})
            else:
                verworfen.append({"frage": key, "grund": grund, "aussage": a if isinstance(a, dict) else str(a)})
    return gut, verworfen, fehler


# ------------------------------------------------------------------ Bericht
def bericht_md(F, extra, befunde, verworfen, fehler, quelle_txt):
    L = ["# Bonsai-Beobachter · Tagesbericht %s" % F["tag"], "",
         "Quelle: %s · Beobachter v%d · erstellt %s" % (quelle_txt, VERSION, dt.datetime.now().strftime("%Y-%m-%d %H:%M")), ""]
    L += ["## Befunde", ""]
    if not befunde:
        L.append("Keine.")
    for b in befunde:
        L.append("- **%s** [%s, %s]: %s (Beleg: %s)" % (b["titel"], b["schwere"], b["status"], b["text"], ", ".join(b["beleg"])))
    L += ["", "Bonsai-Aussagen sind Hypothesen (ungeprüft); verworfen wurden %d Aussagen ohne gültigen Beleg." % len(verworfen) + (" Bonsai: %s." % fehler if fehler else ""), ""]
    L += ["## Kennzahlen (vom Beobachter gerechnet)", "", "| Schlüssel | Wert |", "|---|---|"]
    for k in sorted(F):
        L.append("| %s | %s |" % (k, F[k]))
    if extra.get("laeufe"):
        L += ["", "## Läufe", "", ", ".join("%s (%d min)" % x for x in extra["laeufe"])]
    if extra.get("props"):
        L += ["", "## Vorschläge der Entscheidungsmaschine", ""] + ["- " + p for p in extra["props"]]
    return "\n".join(L) + "\n"


def schreibe(ausgabe, tag, md, befunde, verworfen):
    os.makedirs(ausgabe, exist_ok=True)
    with open(os.path.join(ausgabe, tag.isoformat() + ".md"), "w", encoding="utf-8") as f:
        f.write(md)
    p = os.path.join(ausgabe, "befunde.json")
    alle = {}
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                alle = json.load(f)
        except ValueError:
            alle = {}
    alle[tag.isoformat()] = {"befunde": befunde, "verworfen": len(verworfen)}
    for k in sorted(alle)[:-60]:                     # 60 Tage behalten
        del alle[k]
    with open(p, "w", encoding="utf-8") as f:
        json.dump(alle, f, ensure_ascii=False, indent=1, sort_keys=True)


def lauf(quelle, tag, ausgabe, frag=None, quelle_txt=""):
    d = lade(quelle, tag)
    F, extra = zusammenfassung(d, tag)
    Fv, _ = zusammenfassung(d, tag - dt.timedelta(days=1))
    befunde = regel_befunde(F, extra)
    verworfen, fehler = [], None
    if frag is not None:
        gut, verworfen, fehler = bonsai_befunde(frag, F, Fv)
        befunde += gut
    else:
        fehler = "nicht gefragt (ohne LLM)"
    if d["fehlt"]:
        befunde.append({"schwere": "info", "titel": "Dateien fehlen", "beleg": [], "text": ", ".join(d["fehlt"]), "status": "geprueft (Regel)", "quelle": "Beobachter"})
    md = bericht_md(F, extra, befunde, verworfen, fehler, quelle_txt)
    schreibe(ausgabe, tag, md, befunde, verworfen)
    return {"fakten": F, "befunde": befunde, "verworfen": verworfen, "fehler": fehler, "md": md}


def hosts_aus(datei, extra):
    h = list(extra or [])
    if datei and os.path.exists(datei):
        with open(datei, encoding="utf-8") as f:
            h += [l.strip() for l in f if l.strip() and not l.startswith("#")]
    return h


def main(argv=None):
    ap = argparse.ArgumentParser(description="Bonsai-Beobachter (nur lesen, nur beratend)")
    ap.add_argument("--tag", help="YYYY-MM-DD (Standard: gestern)")
    ap.add_argument("--quelle", help="Ordner mit Kopien der Protokolle (sonst --ssh)")
    ap.add_argument("--ssh", action="store_true", help="per ssh + docker exec cat lesen (nur lesen)")
    ap.add_argument("--ausgabe", default=AUSGABE_STANDARD)
    ap.add_argument("--hosts-datei", default=HOSTS_STANDARD)
    ap.add_argument("--llm-host", action="append", default=[])
    ap.add_argument("--modell")
    ap.add_argument("--ohne-llm", action="store_true")
    ap.add_argument("--timeout", type=int, default=90)
    a = ap.parse_args(argv)
    tag = dt.date.fromisoformat(a.tag) if a.tag else dt.date.today() - dt.timedelta(days=1)
    if a.quelle:
        q, qt = OrdnerQuelle(a.quelle), "Ordner " + a.quelle
    elif a.ssh:
        q, qt = BefehlQuelle(), "ssh/docker exec cat (nur lesen)"
    else:
        ap.error("--quelle ORDNER oder --ssh angeben")
    frag = None
    if not a.ohne_llm:
        hosts = hosts_aus(a.hosts_datei, a.llm_host)
        frag = http_frager(hosts, a.modell, a.timeout) if hosts else None
    r = lauf(q, tag, a.ausgabe, frag, qt)
    print("Bericht %s: %d Befunde (%d verworfen)%s" % (tag, len(r["befunde"]), len(r["verworfen"]), (" · " + r["fehler"]) if r["fehler"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

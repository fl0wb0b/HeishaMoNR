#!/usr/bin/env python3
"""Deterministische Tageskennzahlen der Wärmepumpe (nur Standardbibliothek, ohne Sprachmodell).

Rechnet für einen Kalendertag dieselben Fakten wie der Bonsai-Beobachter (~/Dokumente/bonsai/beobachter/bonsai_beobachter.py,
Funktionen zusammenfassung, kennzahl_gradstunden, abtau_tag, vergleich_7t, regel_befunde): Läufe, Pausen, Zustandsminuten,
Strom (TOP16, im Lauf +80 W) und Wärme, COP, Gradstunden und kWh/Kh mit Komfort-Toleranz 0,3 K/30 min, Räume gegen die Bänder,
Abtauungen (Sonne/mild/Pseudo-Verdacht), Heizstab-/Heizlüfter-Minuten, Quiet- und Heizregelungs-Anteile, Ereignisse,
Entscheidungen und Punkte der Entscheidungsmaschine (decisions-/scores-*.jsonl), Datenlücken; dazu die festen Regel-Befunde.
Die Rechenfunktionen sind aus dem Beobachter kopiert (Stand 15.10.2026) und dürfen nur gemeinsam mit ihm geändert werden;
die Schlüssel in "fakten" sind identisch, damit der Beobachter sie übernehmen und Bonsai nur noch kommentieren lassen kann.

Nur lesen: Es werden ausschließlich Protokolldateien nach DATEI_MUSTER geöffnet (Allowlist); andere Dateien im Datenordner
(z. B. owm.json, vrm.json mit Zugangsdaten) werden weder gelesen noch aufgelistet noch geloggt.

Ausgabe:
  <ergebnis>/kennzahlen/<tag>.json   {"tag", "version", "erstellt", "fakten", "laeufe", "luecken", "abtauungen", "vorschlaege", "punkte", "befunde", ...}
  <ergebnis>/kennzahlen/tage.csv     eine Zeile je Tag (Spalten ZEILE_SCHLUESSEL + Zusatz), bei erneutem Lauf ersetzt

Beispiele:
  python3 tools/kennzahlen_tag.py --daten /daten --ergebnis /ergebnis              # gestern
  python3 tools/kennzahlen_tag.py --daten ~/Kopien/replay_data_1510 --ergebnis /tmp/e --tag 2026-10-14
  python3 tools/kennzahlen_tag.py --daten /daten --ergebnis /ergebnis --alle       # alle Tage mit Daten nachrechnen
"""
import argparse
import bisect
import datetime as dt
import json
import os
import re
import sys
import tempfile

VERSION = 1
DATEI_MUSTER = re.compile(r"^(quiet|quiet-events|optimizer-v2|energy|decisions|scores|applied|defrost)-\d{4}-\d{2}\.(csv|jsonl)$")
RAEUME = [("ki_oben", "Kinderzimmer oben"), ("ki_unten", "Kinderzimmer unten"), ("schlaf", "Schlafzimmer"), ("wohn", "Wohnzimmer")]
# Stromkorrektur (Nutzer 14.10.2026): TOP16 (leistung_el_w) untertreibt, es fehlen Pumpe, Luefter und Elektronik. Forum 189605: L5 70-90 W unter Shelly
# je nach Last (Beitrag 4545989), L5 bei 16/17 Hz 390 W Shelly (4597230, wir sehen 341-363 W), L7 Energie -14,6 % bei Waerme nur -2,7 % (4145844).
PEL_KORR_W = 80                                 # ANNAHME zwischen 40 und 90 W; nur bei laufendem Verdichter (verdichter_hz > 0) addiert
KORR_TXT = "Strom intern +%d W korrigiert" % PEL_KORR_W
# Stromzaehler (cop-ziel 17.10.2026): mit config.json "zaehler": {"quelle": "zaehler"} kommt der Strom jeder Minute aus der Spalte zaehler_wp_w (Shelly, ohne Heizstab),
# Minuten ohne Zaehlerwert (leer = Zaehler fehlt oder aelter als 5 min) weiter TOP16 + PEL_KORR_W. Standard "heishamon": alles wie bisher.
QUELLE = "heishamon"
CSV_SPALTEN_ZUSATZ = ["energie.waerme_kwh", "energie.cop", "laeufe.anzahl", "pausen.anzahl", "pausen.mittel_min", "abtau.anzahl", "abtau.minuten",
                      "abtau.pseudo_verdacht", "abtau.mild_sonne_anzahl", "daten.minutenzeilen", "daten.luecken_ueber_10min", "daten.groesste_luecke_min",
                      "maschine.datensaetze", "maschine.vorschlaege", "punkte.datensaetze", "befunde.warnung", "befunde.hinweis"]


# ------------------------------------------------------------------ aus dem Bonsai-Beobachter kopiert (deterministischer Teil)
def zahl(x):
    if x is None or x == "":
        return None
    try:
        v = float(x)
    except ValueError:
        return None
    return v if v == v and abs(v) != float("inf") else None


def pel(r, korr=True):
    """Elektrische Leistung der Minute in W: TOP16, bei laufendem Verdichter + PEL_KORR_W (korr=False: Rohwert)."""
    if korr and QUELLE == "zaehler" and zahl(r.get("zaehler_wp_w")) is not None:
        return zahl(r.get("zaehler_wp_w"))
    p = zahl(r.get("leistung_el_w"))
    if p is None:
        return None
    hz = zahl(r.get("verdichter_hz"))
    return p + PEL_KORR_W if korr and hz is not None and hz > 0 else p


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
    el = el_roh = th = 0.0
    el_z = z_min = 0.0
    segs = []
    for i, r in enumerate(Q):
        w = min(10.0, ((Q[i + 1]["_t"] - r["_t"]).total_seconds() / 60) if i + 1 < len(Q) else 1.0)
        z = zustand(r)
        minuten[z] += w
        p = pel(r)
        if p is not None:
            el += p * w / 60000
            pr = pel(r, False)
            el_roh += (pr if pr is not None else 0) * w / 60000
        zw = zahl(r.get("zaehler_wp_w"))
        if zw is not None:
            el_z += zw * w / 60000
            z_min += w
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
    F["laeufe.kurz_unter_60_min"] = sum(1 for x in dauer if x < 60)
    F["laeufe.kurz_anteil_prozent"] = round(100 * sum(1 for x in dauer if x < 60) / len(dauer)) if dauer else 0
    pausen = [round((s[2] - s[1]).total_seconds() / 60) + 1 for i, s in enumerate(segs) if s[0] == "pause" and 0 < i < len(segs) - 1]
    F["pausen.anzahl"] = len(pausen)
    F["pausen.mittel_min"] = round(sum(pausen) / len(pausen)) if pausen else 0
    F["energie.strom_kwh"] = round(el, 2)
    F["energie.waerme_kwh"] = round(th, 2)
    F["energie.cop"] = round(th / el, 2) if el > 0.05 else None
    F["energie.strom_kwh_roh"] = round(el_roh, 2)
    F["energie.cop_roh"] = round(th / el_roh, 2) if el_roh > 0.05 else None
    F["energie.korr_w"] = PEL_KORR_W
    if z_min > 0:                                    # nur mit Zaehler (sonst unveraendert wie der Beobachter)
        F["energie.strom_kwh_zaehler"] = round(el_z, 2)
        F["energie.zaehler_min"] = round(z_min)
    if QUELLE == "zaehler":
        F["energie.quelle"] = "zaehler"
    # Verdichter, Quiet, Soll, Aussentemperatur
    hz_lauf = [(zahl(r.get("verdichter_hz")), zahl(r.get("verdichter_laufzeit_min")), zahl(r.get("quiet_aktuell"))) for r in Q if zustand(r) == "lauf"]
    nach_start = [h for h, rt, q in hz_lauf if h is not None and (rt is None or rt >= 2)]
    F["verdichter.max_hz_ab_minute_2"] = max(nach_start, default=None)
    F["verdichter.minuten_ueber_20hz"] = sum(1 for h in nach_start if h > 20)
    F["verdichter.minuten_ueber_20hz_bei_quiet_ab_1"] = sum(1 for h, rt, q in hz_lauf if h and h > 20 and (rt is None or rt >= 2) and q is not None and q >= 1)
    # Gemessene Quiet-Deckel der Leisha (07.–13.10., Forum bestaetigt): Q3 16–17 Hz (selten 21), Q2 17/21 Hz je AT, Q1 21 Hz; ab Laufminute 15
    F["verdichter.minuten_ueber_quiet_deckel"] = sum(1 for h, rt, q in hz_lauf if h and q is not None and q >= 1 and (rt is None or rt >= 15) and h > QUIET_DECKEL_HZ.get(int(q), 99) + 1)
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
    F.update(kennzahl_gradstunden(Q, V, F))
    Fa, A_tag, _lauf = abtau_tag(d, tag)
    F.update(Fa)
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
    return F, {"luecken": luecken, "laeufe": [(s[1].strftime("%H:%M"), round((s[2] - s[1]).total_seconds() / 60) + 1) for s in laeufe], "props": sorted(props), "scores": S,
               "abtauungen": A_tag}


# ------------------------------------------------------------------ Kennzahl kWh Strom je Gradstunde bei gehaltenem Komfort
# Strom = TOP16 (leistung_el_w) ueber die Minutenzeilen integriert (einzige WP-Stromquelle; energy-*.csv hat nur Haus/Netz/PV und
# vrm_wp_24h_kwh = VRM-Prognose, keine Messung). Gradstunden = Summe je Stunde max(0, Raummittel der aktiven Raeume - Aussen).
KENNZAHL_AB = dt.date(2026, 10, 7)              # erster Tag mit Minutenprotokoll
KOMFORT_TOL_K = 0.3      # Nutzerentscheidung 13.10.2026: Unterschreitung bis 0,3 K ...
KOMFORT_TOL_MIN = 30     # ... und hoechstens 30 min/Tag gelten noch als "Komfort gehalten"
QUIET_DECKEL_HZ = {1: 21, 2: 21, 3: 18}   # Messung 07.–13.10. (Q2 bei Kaelte 21, sonst 17; Q3 17, selten 21); Forum L5: Mindestfrequenz steigt ab -4 °C auf 25 Hz, ab -10 °C 35 Hz -> im Winter anpassen
MIN_STUNDEN = 23                                # ANNAHME: Tag vollstaendig ab 23 Stunden mit Raum- und Aussenwerten
MAX_LUECKE_MIN = 60                             # ANNAHME: und keine Luecke ueber 60 min im Minutenprotokoll (Strom fehlt sonst)
EFFIZIENZ_SCHWELLE_PROZENT = 15                 # ANNAHME (Nutzer 13.10.2026): Befund ab 15 % ueber dem Mittel der letzten 7 Tage
AEHNLICH_AUSSEN_K = 2.0                         # ANNAHME: aehnliche Aussentemperatur = Tagesmittel hoechstens 2 K entfernt
VERGLEICH_MIN_TAGE = 2                          # ANNAHME: Vergleich und Kombinationsmittel erst ab 2 Tagen
RAUMNAME = dict(RAEUME)


def kennzahl_gradstunden(Q, V, F):
    """Tageswerte der Kennzahl aus Minutenzeilen Q (quiet) und Raumzeilen V (optimizer-v2, 5 min). Rein deterministisch."""
    K = {}
    aus_h, raum_h = {}, {}
    for r in Q:
        a = zahl(r.get("aussen"))
        if a is not None:
            aus_h.setdefault(r["_t"].hour, []).append(a)
    for r in V:
        for rid, _ in RAEUME:
            t = zahl(r.get(rid + "_ema"))
            if r.get(rid + "_min") not in (None, "") and t is not None:     # aktiv = Band gesetzt
                raum_h.setdefault(r["_t"].hour, {}).setdefault(rid, []).append(t)
    gh, stunden, rm = 0.0, 0, []
    for h in range(24):
        if h not in aus_h or h not in raum_h:
            continue
        raum = sum(sum(v) / len(v) for v in raum_h[h].values()) / len(raum_h[h])
        gh += max(0.0, raum - sum(aus_h[h]) / len(aus_h[h]))
        stunden += 1
        rm.append(raum)
    strom = F.get("energie.strom_kwh")
    K["effizienz.gradstunden"] = round(gh, 1)
    K["effizienz.stunden"] = stunden
    K["effizienz.raum_mittel"] = round(sum(rm) / len(rm), 2) if rm else None
    K["effizienz.kwh_je_gradstunde"] = round(strom / gh, 4) if strom is not None and gh >= 1 else None
    K["effizienz.vollstaendig"] = 1 if stunden >= MIN_STUNDEN and F.get("daten.groesste_luecke_min", 0) <= MAX_LUECKE_MIN else 0
    # Komfort: alle aktiven, gueltigen Raeume >= Minimum (je 5-min-Zeile)
    verl, je_raum, tief = 0, {}, 0.0
    for r in V:
        v = False
        for rid, _ in RAEUME:
            t, mn = zahl(r.get(rid + "_ema")), zahl(r.get(rid + "_min"))
            if r.get(rid + "_gueltig") != "1" or t is None or mn is None or t >= mn:
                continue
            v = True
            je_raum[rid] = je_raum.get(rid, 0) + 5
            tief = max(tief, mn - t)
        verl += 5 if v else 0
    # Toleranz (Nutzerentscheidung 13.10.2026): bis 0,3 K und bis 30 min gelten noch als gehalten (Shelly melden nur in 0,5-K-Schritten)
    K["komfort.gehalten"] = 1 if V and (verl == 0 or (tief <= KOMFORT_TOL_K and verl <= KOMFORT_TOL_MIN)) else 0
    K["komfort.verletzung_min"] = verl
    w = max(je_raum, key=lambda k: (je_raum[k], k)) if je_raum else None
    K["komfort.schlimmster_raum"] = RAUMNAME[w] if w else "-"
    K["komfort.schlimmster_raum_min"] = je_raum.get(w, 0)
    K["komfort.tiefste_unterschreitung_k"] = round(tief, 2)
    # Anteile des Tages (Minutenzeilen mit bekanntem Wert)
    hc = [zahl(r.get("heizregelung")) for r in Q]
    hc = [x for x in hc if x in (0, 1)]
    K["anteil.comfort_prozent"] = round(100 * hc.count(0) / len(hc)) if hc else None
    K["anteil.efficiency_prozent"] = round(100 * hc.count(1) / len(hc)) if hc else None
    K["anteil.modus"] = ("Comfort" if hc.count(0) > hc.count(1) else "Efficiency") if len(hc) >= len(Q) / 2 and hc else "?"
    qs = [zahl(r.get("quiet_aktuell")) for r in Q]
    qs = [int(x) for x in qs if x in (0, 1, 2, 3)]
    for lv in (0, 1, 2, 3):
        K["anteil.quiet%d_prozent" % lv] = round(100 * qs.count(lv) / len(qs)) if qs else None
    K["anteil.quiet_mehrheit"] = "Q%d" % max((0, 1, 2, 3), key=lambda lv: (qs.count(lv), -lv)) if qs else "?"
    am = F.get("aussen.mittel")
    K["aussen.band"] = next(b[2] for b in BAENDER if b[0] <= am < b[1]) if am is not None else "?"
    K["heizstab.minuten"] = sum(1 for r in Q if zahl(r.get("heizstab_intern")) == 1 or zahl(r.get("heizstab_extern")) == 1)
    K["heizluefter.minuten"] = sum(1 for r in Q if zahl(r.get("kz_heizluefter_an")) == 1)
    return K


ZEILE_SCHLUESSEL = ["energie.strom_kwh", "energie.strom_kwh_roh", "energie.korr_w", "effizienz.gradstunden", "effizienz.kwh_je_gradstunde", "effizienz.stunden", "effizienz.vollstaendig", "effizienz.raum_mittel",
                    "aussen.mittel", "aussen.min", "aussen.max", "aussen.band", "komfort.gehalten", "komfort.verletzung_min", "komfort.schlimmster_raum",
                    "komfort.schlimmster_raum_min", "komfort.tiefste_unterschreitung_k", "anteil.modus", "anteil.comfort_prozent", "anteil.efficiency_prozent",
                    "anteil.quiet_mehrheit", "anteil.quiet0_prozent", "anteil.quiet1_prozent", "anteil.quiet2_prozent", "anteil.quiet3_prozent",
                    "heizstab.minuten", "heizluefter.minuten", "zustand.lauf_min", "laeufe.starts"]


def tageszeile(F):
    return {k: F.get(k) for k in ZEILE_SCHLUESSEL}


def zaehlt(z):
    """Tag geht in Mittelwerte und Vergleiche ein: vollstaendig, Komfort gehalten, Kennzahl vorhanden."""
    return z.get("effizienz.vollstaendig") == 1 and z.get("komfort.gehalten") == 1 and z.get("effizienz.kwh_je_gradstunde") is not None


def vergleich_7t(tage, tag):
    """Kennzahl des Tages gegen das Mittel der letzten 7 Tage mit aehnlicher Aussentemperatur (nur zaehlende Tage)."""
    z = tage.get(tag.isoformat()) or {}
    ref = []
    for i in range(1, 8):
        y = tage.get((tag - dt.timedelta(days=i)).isoformat())
        if y and zaehlt(y) and z.get("aussen.mittel") is not None and y.get("aussen.mittel") is not None and abs(y["aussen.mittel"] - z["aussen.mittel"]) <= AEHNLICH_AUSSEN_K:
            ref.append(y["effizienz.kwh_je_gradstunde"])
    V = {"effizienz.vergleich_tage": len(ref)}
    if len(ref) >= VERGLEICH_MIN_TAGE and z.get("effizienz.kwh_je_gradstunde") is not None and z.get("effizienz.vollstaendig") == 1:
        m = sum(ref) / len(ref)
        V["effizienz.vergleich_mittel"] = round(m, 4)
        V["effizienz.abweichung_prozent"] = round(100 * (z["effizienz.kwh_je_gradstunde"] / m - 1))
    return V




# ------------------------------------------------------------------ Kennzahl Abtauungen (Pseudo-Abtauungen erkennen, nur beobachten)
# Hintergrund (Nutzer 14.10.2026): Aussengeraet in Suedsonne und Wind, externer Aussenfuehler im Schatten. Forum 189605 (L-Serie): Pseudo-Abtauungen
# bei Frequenzsprung nach langem Niedriglauf, mehr Abtauungen durch Fuehler-Abweichung. Entscheidung ueber einen Fuehler-Offset erst nach Messung.
# Quelle: quiet-*.csv Spalte defrost (TOP26, je Minute); Sonne = pv_w aus energy-*.csv; optional defrost-*.csv (rF, Taupunkt, Wiederaufheizen).
SONNE_W = 1000                                  # ANNAHME: PV ueber 1000 W = Sonne auf dem Aussengeraet (Suedseite)
NACHT_W = 50                                    # ANNAHME: PV bis 50 W = Nacht
PV_MAX_ALTER_MIN = 15                           # ANNAHME: PV-Wert hoechstens 15 min vor Beginn (energy-*.csv kommt im 5-min-Takt)
MILD_K = 3.0                                    # ANNAHME: mild = Aussen ueber 3 °C
PSEUDO_NIEDRIG_HZ = 20                          # Forum 189605: Niedriglauf <= 20 Hz ...
PSEUDO_NIEDRIG_MIN = 60                         # ... mindestens 60 min ...
PSEUDO_SPRUNG_HZ = 8                            # ... dann Sprung um mindestens 8 Hz ...
PSEUDO_FENSTER_MIN = 10                         # ... in den 10 min vor Beginn
VL_NACHLAUF_MIN = 10                            # ANNAHME: Vorlauf-Einbruch bis 10 min nach Abtau-Ende gemessen
ABTAU_VERDACHT_N = 2                            # Befund ab 2 Abtauungen mild + Sonne an einem Tag oder 2 Pseudo-Verdachtsfaellen
LICHT = ("Sonne", "trüb", "Nacht", "?")


def licht(pv):
    return "?" if pv is None else "Sonne" if pv > SONNE_W else "Nacht" if pv <= NACHT_W else "trüb"


def band(at):
    return next(b[2] for b in BAENDER if b[0] <= at < b[1]) if at is not None else "?"


def pv_bei(E, et, t):
    k = bisect.bisect_right(et, t) - 1
    if k < 0 or (t - et[k]).total_seconds() > PV_MAX_ALTER_MIN * 60:
        return None
    return zahl(E[k].get("pv_w"))


def frequenzsprung(Q, i):
    """(Niedriglauf-Minuten, Sprung Hz) vor Q[i]: hoechste Frequenz in den PSEUDO_FENSTER_MIN min davor gegen die letzte Zeile <= 20 Hz davor."""
    s = Q[i]["_t"]
    W = []
    k = i - 1
    while k >= 0 and (s - Q[k]["_t"]).total_seconds() <= PSEUDO_FENSTER_MIN * 60:
        W.append(k)
        k -= 1
    hz = lambda x: zahl(Q[x].get("verdichter_hz"))
    W = [x for x in reversed(W) if hz(x) is not None]
    if not W:
        return None, None
    p = max(W, key=lambda x: (hz(x), -x))
    e = p - 1
    while e >= 0 and hz(e) is not None and hz(e) > PSEUDO_NIEDRIG_HZ and (s - Q[e]["_t"]).total_seconds() <= PSEUDO_FENSTER_MIN * 60:
        e -= 1
    if e < 0 or hz(e) is None or not 0 < hz(e) <= PSEUDO_NIEDRIG_HZ:
        return None, None
    a = e
    while a - 1 >= 0 and hz(a - 1) is not None and 0 < hz(a - 1) <= PSEUDO_NIEDRIG_HZ and (Q[a]["_t"] - Q[a - 1]["_t"]).total_seconds() <= 180:
        a -= 1
    return round((Q[e]["_t"] - Q[a]["_t"]).total_seconds() / 60) + 1, r2(hz(p) - hz(e))


def abtauungen(d):
    """Alle Abtauungen in den geladenen Minutenzeilen (defrost = 1, Luecken bis 3 min ueberbrueckt). Rein deterministisch."""
    if d.get("_abtau") is not None:
        return d["_abtau"]
    Q, E, D = d["quiet"], d.get("energy", []), d.get("defrost", [])
    et = [e["_t"] for e in E]
    out, i, n, vor_s = [], 0, len(Q), None
    while i < n:
        if zahl(Q[i].get("defrost")) != 1:
            i += 1
            continue
        j = i
        while j + 1 < n and zahl(Q[j + 1].get("defrost")) == 1 and (Q[j + 1]["_t"] - Q[j]["_t"]).total_seconds() <= 180:
            j += 1
        s, e = Q[i]["_t"], Q[j]["_t"]
        vor = Q[i - 1] if i > 0 and (s - Q[i - 1]["_t"]).total_seconds() <= 180 else None
        ref = vor or Q[i]
        at = zahl(ref.get("aussen"))
        pv = pv_bei(E, et, s)
        nied, sprung = frequenzsprung(Q, i)
        ro = zahl(ref.get("rohr_aussen"))
        ws = [pel(r) for r in Q[i:j + 1]]
        ws = [w for w in ws if w is not None]
        vl0 = zahl(ref.get("ist_vl"))
        vls = [zahl(r.get("ist_vl")) for r in Q[i:] if r["_t"] <= e + dt.timedelta(minutes=VL_NACHLAUF_MIN)]
        vls = [v for v in vls if v is not None]
        x = {"beginn": s.strftime("%Y-%m-%d %H:%M"), "dauer_min": round((e - s).total_seconds() / 60) + 1, "aussen": at, "band": band(at), "pv_w": None if pv is None else round(pv),
             "licht": licht(pv), "hz_vor": zahl(ref.get("verdichter_hz")) if vor else None, "laufmin_vor": zahl(vor.get("verdichter_laufzeit_min")) if vor else None,
             "niedriglauf_min": nied, "sprung_hz": sprung,
             "pseudo": 1 if nied is not None and nied >= PSEUDO_NIEDRIG_MIN and sprung is not None and sprung >= PSEUDO_SPRUNG_HZ else 0,
             "rohr_luft_k": r2(at - ro) if at is not None and ro is not None else None,
             "mittel_w": round(sum(ws) / len(ws)) if ws else None, "strom_wh": round(sum(ws) / 60) if ws else None,
             "vl_einbruch_k": r2(vl0 - min(vls)) if vl0 is not None and vls else None,
             "abstand_min": round((s - vor_s).total_seconds() / 60) if vor_s else None,             # Beginn zu Beginn (wie min_seit_letzter_abtauung)
             "feuchte": None, "taupunkt": None, "wiederaufheiz_min": None}
        x["mild"] = 1 if at is not None and at > MILD_K else 0
        x["sonne"] = 1 if x["licht"] == "Sonne" else 0
        for r in D:                                  # Anreicherung aus defrost-*.csv (gleicher Beginn +-3 min)
            if abs((r["_t"] - s).total_seconds()) <= 180:
                x["feuchte"], x["taupunkt"], x["wiederaufheiz_min"] = zahl(r.get("feuchte")), zahl(r.get("taupunkt")), r.get("wiederaufheiz_min") or None
                break
        out.append(x)
        vor_s = s
        i = j + 1
    d["_abtau"] = out
    return out


def abtau_tag(d, tag):
    """Tageskennzahlen der Abtauungen (flach, fuer Fakten/Befunde) und Laufminuten je Band|Licht (fuer die Rate je 10 h Lauf)."""
    A = [x for x in abtauungen(d) if x["beginn"].startswith(tag.isoformat())]
    F = {"abtau.anzahl": len(A), "abtau.minuten": sum(x["dauer_min"] for x in A)}
    ab = [x["abstand_min"] for x in A if x["abstand_min"] is not None]
    F["abtau.abstand_min_mittel"] = round(sum(ab) / len(ab)) if ab else None
    F["abtau.abstand_min_kuerzester"] = min(ab) if ab else None
    for k in ("sonne", "mild", "pseudo"):
        F["abtau.%s_anzahl" % k] = sum(x[k] for x in A)
    F["abtau.sonne_anteil_prozent"] = round(100 * F["abtau.sonne_anzahl"] / len(A)) if A else None
    F["abtau.mild_anteil_prozent"] = round(100 * F["abtau.mild_anzahl"] / len(A)) if A else None
    F["abtau.mild_sonne_anzahl"] = sum(1 for x in A if x["mild"] and x["sonne"])
    F["abtau.pseudo_verdacht"] = F.pop("abtau.pseudo_anzahl")
    F["abtau.strom_wh"] = sum(x["strom_wh"] or 0 for x in A)
    t0 = dt.datetime.combine(tag, dt.time(0, 0))
    t1 = t0 + dt.timedelta(days=1)
    F["abtau.ereignisse"] = sum(1 for e in d["events"] if t0 <= e["_t"] < t1 and re.match(r"(abtau|defrost)", str(e.get("ereignis", "")).lower()))
    E = d.get("energy", [])
    et = [e["_t"] for e in E]
    lauf = {}
    for r in d["quiet"]:
        if t0 <= r["_t"] < t1 and zustand(r) == "lauf":
            k = "%s|%s" % (band(zahl(r.get("aussen"))), licht(pv_bei(E, et, r["_t"])))
            lauf[k] = lauf.get(k, 0) + 1
    F["abtau.lauf_min"] = sum(lauf.values())
    return F, A, lauf





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
    if F.get("verdichter.minuten_ueber_quiet_deckel", 0) >= 10:
        b("hinweis", "Verdichter über dem gemessenen Quiet-Deckel", ["verdichter.minuten_ueber_quiet_deckel"],
          "%d Minuten über dem gemessenen Deckel der Quiet-Stufe (Q1/Q2 21 Hz, Q3 18 Hz; ab Laufminute 15): Deckel-Tabelle prüfen (bei Frost steigt die Mindestfrequenz)." % F["verdichter.minuten_ueber_quiet_deckel"])
    for x in extra.get("scores", []):
        if x.get("typ") == "schaden":
            b("warnung", "Schaden-Bewertung %s" % x.get("regel"), ["punkte.%s.schaden" % x.get("regel")], str(x.get("text")))
        if x.get("typ") == "verpasst":
            b("hinweis", "Verpasst %s" % x.get("regel"), ["punkte.%s.verpasst" % x.get("regel")], str(x.get("text")))
        if x.get("typ") == "messaufgabe":
            b("hinweis", "Messaufgabe Comfort/Efficiency erledigt", ["punkte.%s.messaufgabe" % x.get("regel")], str(x.get("text")))
    # Messaufgabe Comfort/Efficiency: im Review-Paket (13.10.2026) gestrichen, Befund steht in docs/OPTIMIERER.md Abschnitt 7 – kein Befund mehr
    if F.get("effizienz.abweichung_prozent") is not None and F["effizienz.abweichung_prozent"] >= EFFIZIENZ_SCHWELLE_PROZENT:
        b("hinweis", "Stromeffizienz", ["effizienz.kwh_je_gradstunde", "effizienz.vergleich_mittel", "effizienz.abweichung_prozent", "effizienz.vergleich_tage", "aussen.mittel", "komfort.gehalten"],
          "%s kWh/Kh, +%d %% gegen Ø %s aus %d Tagen mit Außen ±%s K (%s °C); Komfort %s." % (
              fz(F["effizienz.kwh_je_gradstunde"], 4), F["effizienz.abweichung_prozent"], fz(F["effizienz.vergleich_mittel"], 4), F["effizienz.vergleich_tage"],
              fz(AEHNLICH_AUSSEN_K, 0), fz(F.get("aussen.mittel")), "gehalten" if F.get("komfort.gehalten") == 1 else "verletzt"))
    if F.get("abtau.mild_sonne_anzahl", 0) >= ABTAU_VERDACHT_N or F.get("abtau.pseudo_verdacht", 0) >= ABTAU_VERDACHT_N:
        A = extra.get("abtauungen") or []
        b("hinweis", "Abtau-Verdacht", ["abtau.anzahl", "abtau.mild_sonne_anzahl", "abtau.pseudo_verdacht", "abtau.abstand_min_kuerzester"],
          "%d Abtauungen, davon %d mild (> %s °C) bei Sonne, %d Pseudo-Verdacht: %s." % (F["abtau.anzahl"], F["abtau.mild_sonne_anzahl"], fz(MILD_K, 0), F["abtau.pseudo_verdacht"],
          ", ".join("%s %s °C %s%s" % (x["beginn"][11:], fz(x["aussen"]), x["licht"], " Pseudo" if x["pseudo"] else "") for x in A[:8])))
    if F.get("uebernahme.gesendet", 0) > 0:
        b("info", "Übernahmen per Klick", ["uebernahme.gesendet"], "%d Befehle per Klick gesendet (applied-*.jsonl)." % F["uebernahme.gesendet"])
    return B



BAENDER = [(-99, 3, "unter 3 °C"), (3, 7, "3 bis 7 °C"), (7, 12, "7 bis 12 °C"), (12, 99, "ab 12 °C")]



# ------------------------------------------------------------------ Einlesen nur nach Allowlist (eigener Teil)
class Daten:
    """Liest Protokolldateien aus einem Ordner, nur Namen nach DATEI_MUSTER, jede Datei höchstens einmal (Cache für --alle).
    decisions-*.jsonl werden nur zeilenweise nach Tag gruppiert und erst für den angefragten Tag geparst (Speicher < 1 GB auch am Monatsende)."""

    def __init__(self, ordner):
        self.ordner = ordner
        self._csv = {}
        self._jsonl = {}
        self._dec = {}

    def _pfad(self, datei):
        if not DATEI_MUSTER.match(datei):
            raise ValueError("unerlaubter Dateiname: " + datei)
        p = os.path.join(self.ordner, datei)
        return p if os.path.isfile(p) else None

    def csv(self, datei):
        if datei not in self._csv:
            p = self._pfad(datei)
            if p is None:
                self._csv[datei] = None
            else:
                with open(p, encoding="utf-8", errors="replace") as f:
                    self._csv[datei] = lies_csv(f.read())
        return self._csv[datei]

    def jsonl(self, datei):
        if datei not in self._jsonl:
            p = self._pfad(datei)
            if p is None:
                self._jsonl[datei] = None
            else:
                with open(p, encoding="utf-8", errors="replace") as f:
                    self._jsonl[datei] = lies_jsonl(f.read())
        return self._jsonl[datei]

    def decisions(self, datei, tag_s):
        """Nur die Datensätze des Tages tag_s (JJJJ-MM-TT); None, wenn die Datei fehlt."""
        if datei not in self._dec:
            p = self._pfad(datei)
            if p is None:
                self._dec[datei] = None
            else:
                je_tag = {}
                with open(p, encoding="utf-8", errors="replace") as f:
                    for l in f:
                        l = l.strip()
                        if not l:
                            continue
                        if l.startswith('{"t":"') and len(l) > 16:
                            k = l[6:16]
                        else:
                            try:
                                k = str(json.loads(l).get("t", ""))[:10]
                            except (ValueError, AttributeError):
                                continue
                        je_tag.setdefault(k, []).append(l)
                self._dec[datei] = je_tag
        je_tag = self._dec[datei]
        if je_tag is None:
            return None
        return lies_jsonl("\n".join(je_tag.get(tag_s, [])))

    def tage_mit_daten(self, monate_liste):
        tage = set()
        for m in monate_liste:
            Q = self.csv("quiet-%s.csv" % m)
            for r in Q or []:
                tage.add(r["_t"].date())
        return sorted(tage)

    def monate_vorhanden(self):
        """Monate, für die quiet-JJJJ-MM.csv existiert (nur Namen nach Muster werden betrachtet)."""
        out = []
        for f in sorted(os.listdir(self.ordner)):
            m = re.match(r"^quiet-(\d{4}-\d{2})\.csv$", f)
            if m:
                out.append(m.group(1))
        return out


def monate(tag):
    m = {tag.strftime("%Y-%m")}
    m.add((tag - dt.timedelta(days=1)).strftime("%Y-%m"))
    return sorted(m)


def lade(daten, tag):
    """Wie lade() im Beobachter: alle Dateien für den Monat des Tages und des Vortags; decisions nur für den Tag selbst
    (der Beobachter nutzt sie nur für diesen Tag)."""
    d = {"quiet": [], "events": [], "v2": [], "energy": [], "decisions": [], "scores": [], "applied": [], "defrost": [], "fehlt": []}
    for m in monate(tag):
        for key, name, art in (("quiet", "quiet-%s.csv", "csv"), ("events", "quiet-events-%s.csv", "csv"), ("v2", "optimizer-v2-%s.csv", "csv"),
                               ("energy", "energy-%s.csv", "csv"), ("decisions", "decisions-%s.jsonl", "dec"), ("scores", "scores-%s.jsonl", "jsonl"),
                               ("applied", "applied-%s.jsonl", "jsonl"), ("defrost", "defrost-%s.csv", "csv")):
            datei = name % m
            if art == "csv":
                x = daten.csv(datei)
            elif art == "dec":
                x = daten.decisions(datei, tag.isoformat())
            else:
                x = daten.jsonl(datei)
            if x is None:
                if key != "defrost":                 # defrost-*.csv entsteht erst mit der ersten Abtauung des Monats
                    d["fehlt"].append(datei)
                continue
            d[key] += x
    for k in ("quiet", "events", "v2", "energy", "defrost"):
        d[k].sort(key=lambda o: o["_t"])
    return d


# ------------------------------------------------------------------ Ausgabe
def schreibe_atomar(pfad, text):
    os.makedirs(os.path.dirname(pfad), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(pfad), prefix=".tmp_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, pfad)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def gespeicherte_zeilen(ordner):
    """tageszeile je Tag aus früheren Läufen (<ordner>/<tag>.json), für den 7-Tage-Vergleich über Monatsgrenzen."""
    tage = {}
    if not os.path.isdir(ordner):
        return tage
    for f in os.listdir(ordner):
        m = re.match(r"^(\d{4}-\d{2}-\d{2})\.json$", f)
        if not m:
            continue
        try:
            with open(os.path.join(ordner, f), encoding="utf-8") as fh:
                z = json.load(fh).get("zeile")
            if isinstance(z, dict):
                tage[m.group(1)] = z
        except (OSError, ValueError):
            continue
    return tage


def rechne_tag(daten, tag, ordner):
    d = lade(daten, tag)
    if "quiet-%s.csv" % tag.strftime("%Y-%m") in d["fehlt"]:
        raise FileNotFoundError("quiet-%s.csv fehlt im Datenordner" % tag.strftime("%Y-%m"))
    F, extra = zusammenfassung(d, tag)
    # 7-Tage-Vergleich wie kennzahl_tage() im Beobachter: Tage aus den geladenen Daten neu, ältere aus früheren Läufen
    tage = gespeicherte_zeilen(ordner)
    vorhanden = {r["_t"].date() for r in d["quiet"]}
    for i in range(1, 8):
        x = tag - dt.timedelta(days=i)
        if x in vorhanden and x >= KENNZAHL_AB:
            tage[x.isoformat()] = tageszeile(zusammenfassung(d, x)[0])
    if tag >= KENNZAHL_AB and F.get("daten.minutenzeilen", 0) > 0:
        tage[tag.isoformat()] = tageszeile(F)
    F.update(vergleich_7t(tage, tag))
    befunde = regel_befunde(F, extra)
    if d["fehlt"]:
        befunde.append({"schwere": "info", "titel": "Dateien fehlen", "beleg": [], "text": ", ".join(d["fehlt"]), "status": "geprueft (Regel)", "quelle": "Beobachter"})
    letzte = max((r["_t"] for r in d["quiet"] if r["_t"].date() == tag), default=None)
    return {
        "tag": tag.isoformat(),
        "version": VERSION,
        "quelle": "tools/kennzahlen_tag.py v%d (Rechenweg des Bonsai-Beobachters, Stand 15.10.2026; ohne Sprachmodell)" % VERSION,
        "korrektur": KORR_TXT,
        "tag_vollstaendig": bool(letzte and letzte.time() >= dt.time(23, 50)),
        "letzte_zeile": letzte.strftime("%Y-%m-%d %H:%M:%S") if letzte else None,
        "fakten": F,
        "zeile": tageszeile(F),
        "laeufe": [{"beginn": a, "dauer_min": b} for a, b in extra.get("laeufe", [])],
        "luecken": [{"ab": a, "min": b} for a, b in extra.get("luecken", [])],
        "abtauungen": extra.get("abtauungen", []),
        "vorschlaege": extra.get("props", []),
        "punkte": extra.get("scores", []),
        "befunde": befunde,
        "befunde_anzahl": {k: sum(1 for b in befunde if b["schwere"] == k) for k in ("warnung", "hinweis", "info")},
        "dateien_fehlen": d["fehlt"],
    }


def schreibe_tag(ordner, erg):
    schreibe_atomar(os.path.join(ordner, erg["tag"] + ".json"), json.dumps(erg, ensure_ascii=False, indent=1, sort_keys=True, default=str) + "\n")


def csv_wert(v):
    if v is None:
        return ""
    s = str(v)
    return '"%s"' % s.replace('"', '""') if ("," in s or '"' in s) else s


def schreibe_csv(ordner):
    """tage.csv aus allen <tag>.json neu aufbauen (idempotent, Spalten fest)."""
    spalten = ["tag"] + ZEILE_SCHLUESSEL + [k for k in CSV_SPALTEN_ZUSATZ if k not in ZEILE_SCHLUESSEL] + \
        ["effizienz.vergleich_tage", "effizienz.vergleich_mittel", "effizienz.abweichung_prozent"]
    zeilen = [",".join(spalten)]
    for f in sorted(os.listdir(ordner)):
        if not re.match(r"^\d{4}-\d{2}-\d{2}\.json$", f):
            continue
        try:
            with open(os.path.join(ordner, f), encoding="utf-8") as fh:
                j = json.load(fh)
            F = dict(j.get("fakten") or {})
            F.update({"befunde." + k: v for k, v in (j.get("befunde_anzahl") or {}).items()})
        except (OSError, ValueError):
            continue
        zeilen.append(",".join([f[:10]] + [csv_wert(F.get(k)) for k in spalten[1:]]))
    schreibe_atomar(os.path.join(ordner, "tage.csv"), "\n".join(zeilen) + "\n")
    return len(zeilen) - 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="Deterministische Tageskennzahlen (nur lesen, ohne Sprachmodell)")
    ap.add_argument("--daten", required=True, help="Ordner mit den Protokollen (nur lesend; nur Dateien nach Allowlist)")
    ap.add_argument("--ergebnis", required=True, help="Ergebnisordner; geschrieben wird nach <ergebnis>/kennzahlen/")
    ap.add_argument("--tag", help="JJJJ-MM-TT (Standard: gestern)")
    ap.add_argument("--alle", action="store_true", help="alle Tage mit Minutenprotokoll ab %s bis --tag nachrechnen" % KENNZAHL_AB)
    a = ap.parse_args(argv)
    tag = dt.date.fromisoformat(a.tag) if a.tag else dt.date.today() - dt.timedelta(days=1)
    if not os.path.isdir(a.daten):
        print("Fehler: Datenordner fehlt: %s" % a.daten, file=sys.stderr)
        return 2
    ordner = os.path.join(a.ergebnis, "kennzahlen")
    os.makedirs(ordner, exist_ok=True)
    global QUELLE
    try:                                             # nur zaehler.quelle aus config.json (Einstellung des Nutzers, keine Geheimnisse)
        with open(os.path.join(a.daten, "config.json"), encoding="utf-8") as f:
            QUELLE = "zaehler" if ((json.load(f) or {}).get("zaehler") or {}).get("quelle") == "zaehler" else "heishamon"
    except (OSError, ValueError, AttributeError):
        QUELLE = "heishamon"
    daten = Daten(a.daten)
    if a.alle:
        tage = [x for x in daten.tage_mit_daten(daten.monate_vorhanden()) if KENNZAHL_AB <= x <= tag]
    else:
        tage = [tag]
    if not tage:
        print("Fehler: keine Tage mit Minutenprotokoll bis %s" % tag, file=sys.stderr)
        return 2
    fehler = 0
    for x in tage:                                   # aufsteigend: der 7-Tage-Vergleich findet die Vortage schon gespeichert
        try:
            erg = rechne_tag(daten, x, ordner)
        except (OSError, ValueError) as e:
            print("Fehler %s: %s" % (x, e), file=sys.stderr)
            fehler += 1
            continue
        schreibe_tag(ordner, erg)
        F = erg["fakten"]
        print("Kennzahlen %s: %d Minutenzeilen, Läufe %s, Strom %s kWh, Wärme %s kWh, COP %s, kWh/Kh %s, Komfort %s, Abtauungen %s, Befunde %d%s" % (
            x, F.get("daten.minutenzeilen", 0), F.get("laeufe.anzahl"), F.get("energie.strom_kwh"), F.get("energie.waerme_kwh"), F.get("energie.cop"),
            F.get("effizienz.kwh_je_gradstunde"), "gehalten" if F.get("komfort.gehalten") == 1 else "verletzt", F.get("abtau.anzahl"), len(erg["befunde"]),
            "" if erg["tag_vollstaendig"] else " (Tag unvollständig, letzte Zeile %s)" % erg["letzte_zeile"]))
    n = schreibe_csv(ordner)
    print("tage.csv: %d Tage" % n)
    return 1 if fehler else 0


if __name__ == "__main__":
    sys.exit(main())

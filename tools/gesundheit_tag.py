#!/usr/bin/env python3
"""Anlagen-Gesundheit: schleichende Veränderungen der Wärmepumpe aus den Minutenprotokollen erkennen (nur lesen, ohne Sprachmodell).

Idee (Hermes 02.11.2026): Der Zwilling und die Kennzahlen sagen, was die Anlage heute getan hat. Niemand prüft, ob sie es noch so gut kann
wie vor Wochen. Ein Kältemittelverlust, ein verstopfter Schmutzfänger, Laub am Verdampfer, ein sinkender Wasserdruck oder ein wegdriftender
Fühler kosten je 3–15 % Effizienz und fallen erst auf, wenn es zu spät ist. Dieses Werkzeug vergleicht jeden Tag mit der eigenen Anlage
derselben Lage (Außentemperatur, Frequenz, Pumpenstufe) aus einem Bezugszeitraum und meldet nur, was über mehrere Tage wegläuft.

Prüfungen (je Tag ein Wert; „Abweichung“ = Tageswert minus Bezug derselben Lage):
  fuehler_versatz      Vorlauf − Rücklauf in Pausen mit laufender Pumpe (beide Fühler messen dann dasselbe Wasser), K
  wasserdruck          Wasserdruck in Pausen, auf die Wassertemperatur des Bezugs korrigiert, bar (Leck, Ausdehnungsgefäß)
  hydraulik            Durchfluss gegen den Bezug bei gleicher Pumpenstufe, % (Schmutzfänger, Luft, Ventile)
  verdampfer           Rohr außen gegen Außentemperatur je entzogener Wärme und Lüfterdrehzahl, ohne Eis, % (Laub, Schmutz, Lüfter)
  heissgas             Heißgas minus Vorlauf gegen den Bezug derselben Frequenz und Außentemperatur, K (Kältemittelmenge, Verdichter)
  expansionsventil     Öffnung des Expansionsventils gegen den Bezug, Schritte (Kältemittelmenge)
  guetegrad            COP / Carnot-COP (Vorlauf gegen Rohr außen) über Stunden, gegen den Bezug derselben Frequenz, % (alles zusammen)
  stromzaehler         Stromzähler (Shelly) minus TOP16 im ruhigen Lauf, W (Zähler, Korrektur PEL_KORR_W)
  fuehler_stehend      längste Zeit, in der ein Fühler bei laufendem Verdichter keinen anderen Wert zeigt, min
  abtauen              Abtauungen, Abstand, Heizstab während des Abtauens (nur Fakten, kein Bezug)

Bezug: die Tage BEZUG_VON..BEZUG_BIS vor dem Tag (Standard 42..8), also nicht die letzte Woche, damit eine schleichende Veränderung den
Bezug nicht mitzieht. Ein Befund entsteht erst, wenn der Median der letzten 5 Tage mit Daten über der Schwelle liegt (ein einzelner
seltsamer Tag erzeugt nur eine Notiz). Schwellen sind ANNAHMEN aus der Streuung 08.10.–02.11.2026 (siehe docs) und stehen in SCHWELLE.

Ausgabe:
  <ergebnis>/gesundheit/<tag>.json   {"tag", "version", "werte": {pruefung: {wert, abweichung, n, ...}}, "trend5", "befunde", "abtauen"}
  <ergebnis>/gesundheit/tage.csv     eine Zeile je Tag (Abweichungen), bei erneutem Lauf ersetzt

Beispiele:
  python3 tools/gesundheit_tag.py --daten /daten --ergebnis /ergebnis              # gestern
  python3 tools/gesundheit_tag.py --daten ~/kopie --ergebnis /tmp/e --alle         # alle Tage nachrechnen
"""
import argparse
import datetime as dt
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kennzahlen_tag import Daten, zahl, schreibe_atomar, csv_wert   # noqa: E402  (gleiche Allowlist, gleiches CSV-Lesen)

VERSION = 1
BEZUG_VON, BEZUG_BIS = 42, 8          # Bezugstage: tag-42 .. tag-8
BEZUG_MIN_TAGE = 5                    # weniger Bezugstage mit Daten -> „lernt noch“
TREND_TAGE = 5                        # Befund, wenn der Median der letzten 5 Tage mit Wert über der Schwelle liegt
MIN_N = {"fuehler_versatz": 30, "wasserdruck": 30, "hydraulik": 30, "verdampfer": 20, "heissgas": 30, "expansionsventil": 30,
         "guetegrad": 2, "stromzaehler": 30}
# Fühler mit 0,25-K- bzw. 1-K-Stufen: Mittelwert statt Median, sonst verschluckt die Rundung kleine Verschiebungen (Median VL−RL = 0,00)
MITTEL = {"fuehler_versatz", "wasserdruck", "heissgas", "expansionsventil", "verdampfer", "stromzaehler", "hydraulik"}
BIN_MIN = 15                          # Bezugsminuten je Lage, sonst wird die Lage nicht verglichen
# ANNAHME: Schwellen (Hinweis, Warnung) für den Betrag des 5-Tage-Medians der Abweichung; aus der Streuung der Tage 08.10.–02.11.2026
# mit Abstand gewählt (dort keine bekannte Störung). Einheit wie die Prüfung.
SCHWELLE = {
    "fuehler_versatz": (0.15, 0.30),     # K
    "wasserdruck": (0.10, 0.20),         # bar
    "hydraulik": (8.0, 15.0),            # %
    "verdampfer": (1.0, 2.0),            # K
    "heissgas": (3.0, 6.0),              # K
    "expansionsventil": (15.0, 25.0),    # Schritte (Tageswerte streuen ±14)
    "guetegrad": (6.0, 10.0),            # %
    "stromzaehler": (25.0, 50.0),        # W
}
# ANNAHME: Fühler zeigt bei laufendem Verdichter so lange denselben Wert -> Hinweis (rund das Doppelte des längsten Werts 07.10.–02.11.2026;
# ganzzahlige Fühler wie Außen/Rohr stehen bei ruhigem Wetter stundenlang)
STEHEND_MIN = {"ist_vl": 360, "ist_rl": 360, "aussen": 600, "rohr_aussen": 600, "rohr_innen": 600, "heissgas": 360, "verdampfer_aus": 600,
               "flow_l_min": 120, "druck_bar": 90, "zaehler_wp_w": 30, "leistung_el_w": 120}
STEHEND_SPALTEN = list(STEHEND_MIN)
EINHEIT = {"fuehler_versatz": "K", "wasserdruck": "bar", "hydraulik": "%", "verdampfer": "K", "heissgas": "K", "expansionsventil": "Schritte",
           "guetegrad": "%", "stromzaehler": "W"}
NAME = {"fuehler_versatz": "Fühlerversatz Vorlauf/Rücklauf", "wasserdruck": "Wasserdruck", "hydraulik": "Durchfluss bei gleicher Pumpenstufe",
        "verdampfer": "Verdampfer (Außenluft − Rohr, nur ≥ 5 °C)", "heissgas": "Heißgas über Vorlauf", "expansionsventil": "Expansionsventil",
        "guetegrad": "Gütegrad (COP gegen Carnot)", "stromzaehler": "Stromzähler gegen TOP16"}
URSACHE = {"fuehler_versatz": "Fühler wandert oder sitzt lose; verfälscht Wärme und COP aller Auswertungen",
           "wasserdruck": "Wasserverlust (Leck, Sicherheitsventil) oder Ausdehnungsgefäß ohne Vordruck; nachfüllen/prüfen lassen",
           "hydraulik": "Schmutzfänger/Filter zusetzen, Luft im System oder Ventile geschlossen",
           "verdampfer": "Laub/Schmutz am Verdampfer, Lüfter schwächer oder Eis, das nicht abtaut",
           "heissgas": "Kältemittelmenge (Verlust) oder Verdichter; Fachbetrieb fragen, wenn zusammen mit Expansionsventil",
           "expansionsventil": "Kältemittelmenge (Verlust): Ventil öffnet weiter bei gleicher Lage",
           "guetegrad": "Effizienz insgesamt gesunken; Ursache in den anderen Prüfungen suchen",
           "stromzaehler": "Stromzähler oder TOP16 messen anders als früher (Zähler, Wandler, Firmware)"}


def lauf_flags(Q):
    """Je Zeile: Minuten seit Laufbeginn bzw. seit Pausenbeginn, Minuten seit Abtau-Ende (None = keine Abtauung in den letzten 6 h)."""
    seit_lauf, seit_pause, seit_abtau = [], [], []
    lb = pb = ae = None
    for i, r in enumerate(Q):
        t = r["_t"]
        hz = zahl(r.get("verdichter_hz")) or 0
        if i and (t - Q[i - 1]["_t"]).total_seconds() > 600:
            lb = pb = None                               # Lücke > 10 min: Zustand unbekannt
        if r.get("defrost") == "1":
            ae = t
            lb = None
        if hz > 0:
            lb = lb or t
            pb = None
        else:
            pb = pb or t
            lb = None
        seit_lauf.append((t - lb).total_seconds() / 60 if lb else None)
        seit_pause.append((t - pb).total_seconds() / 60 if pb else None)
        seit_abtau.append((t - ae).total_seconds() / 60 if ae and (t - ae).total_seconds() < 6 * 3600 else None)
    return seit_lauf, seit_pause, seit_abtau


def ruhig(r, sl, sa):
    """Ruhiger Heizlauf: Verdichter läuft >= 20 min, kein Abtauen in den letzten 30 min, kein Warmwasser, kein Heizstab."""
    return (sl is not None and sl >= 20 and (sa is None or sa >= 30) and r.get("defrost") != "1" and r.get("warmwasser") in ("0", "", None)
            and (zahl(r.get("heizstab_intern")) or 0) == 0)


def at_band(at):
    return None if at is None else int(math.floor(at / 3.0))          # 3-K-Bänder


def hz_band(hz, breite=6):
    return None if hz is None else int(hz // breite)                     # 6-Hz-Bänder (Kältekreis: 3 Hz)


def median(v):
    v = sorted(x for x in v if x is not None)
    if not v:
        return None
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def proben(Q):
    """Je Prüfung Liste (Datum, Lage, Wert) aus den Minutenzeilen. Lage = Schlüssel für den Vergleich mit dem Bezug (None = ohne Lage)."""
    sl, sp, sa = lauf_flags(Q)
    P = {k: [] for k in MIN_N}
    stunden = {}
    for i, r in enumerate(Q):
        d = r["_t"].date()
        hz = zahl(r.get("verdichter_hz")) or 0
        vl, rl, at = zahl(r.get("ist_vl")), zahl(r.get("ist_rl")), zahl(r.get("aussen"))
        fl, duty = zahl(r.get("flow_l_min")), zahl(r.get("pumpe_duty"))
        # Pause mit laufender Pumpe: >= 10 min Pause, Durchfluss da, kein Abtauen/Warmwasser
        if hz == 0 and sp[i] is not None and sp[i] >= 10 and fl and fl > 8 and r.get("defrost") != "1" and r.get("warmwasser") in ("0", "", None):
            if vl is not None and rl is not None:
                P["fuehler_versatz"].append((d, None, vl - rl))
            dr = zahl(r.get("druck_bar"))
            if dr is not None and vl is not None and dr > 0.3:
                P["wasserdruck"].append((d, int(vl // 2), dr))            # Lage: Wassertemperatur in 2-K-Stufen
        if fl and duty and fl > 3 and r.get("defrost") != "1":
            P["hydraulik"].append((d, (int(duty // 5), hz > 0), fl))   # Lage: Pumpenstufe (5er), Lauf/Pause
        if not ruhig(r, sl[i], sa[i]):
            continue
        hb, ab = hz_band(hz), at_band(at)
        # Kältekreis-Lage: Frequenz in 3-Hz-Stufen, Außenband, Quiet-Stufe (Expansionsventil 47 Schritte bei Quiet 0, 52–63 bei Quiet 3)
        kk = (hz_band(hz, 3), ab, r.get("quiet_aktuell"))
        pth, pel_t, pel_z, fan, rohr = (zahl(r.get(k)) for k in ("leistung_th_heisha_w", "leistung_el_w", "zaehler_wp_w", "fan1", "rohr_aussen"))
        hg, eev = zahl(r.get("heissgas")), zahl(r.get("expansionsventil"))
        if hg is not None and vl is not None:
            P["heissgas"].append((d, kk, hg - vl))
        if eev is not None:
            P["expansionsventil"].append((d, kk, eev))
        if pel_z is not None and pel_t is not None and pel_z > 0:
            P["stromzaehler"].append((d, hb, pel_z - pel_t))
        # Verdampfer: nur sicher ohne Eis (AT >= 5 °C; direkt nach dem Abtauen ist das Rohr bei 0 °C schon wieder anders), genug Entzug.
        # Wert = Abstand Außenluft − Rohr in K; Lage = Entzug je Lüfterdrehzahl (0,25er Stufen) und Außenband. Im Winter oft ohne Wert.
        if None not in (pth, pel_z, fan, rohr, at) and at >= 5 and fan >= 150 and pth - pel_z > 800:
            entzug = (pth - pel_z) / 1000 * 300 / fan                     # kW je 300 U/min
            P["verdampfer"].append((d, (int(entzug // 0.25), ab), at - rohr))
        # Gütegrad über Stunden (HeishaMon-Wärme ist minütlich zu grob): Summen je Stunde; nur mit Stromzähler (TOP16 ohne Korrektur
        # gab bis 17.10.2026 rund 10 % zu hohe COP und würde als Sprung erscheinen)
        pel = pel_z
        if None not in (pth, pel, vl, rohr) and pel > 50:
            h = r["_t"].replace(minute=0, second=0, microsecond=0)
            s = stunden.setdefault(h, [0, 0.0, 0.0, 0.0, 0.0, []])
            s[0] += 1; s[1] += pth; s[2] += pel; s[3] += vl; s[4] += rohr; s[5].append(hz)
    for h, (n, th, el, vls, ros) in ((h, s[:5]) for h, s in stunden.items()):
        if n < 40:
            continue
        tvl, tro = vls / n, ros / n
        if tvl - tro < 5:
            continue
        carnot = (tvl + 273.15) / (tvl - tro)
        hz_m = median(stunden[h][5])
        P["guetegrad"].append((h.date(), hz_band(hz_m), (th / el) / carnot))
    return P


def bezug_tabelle(P, tage):
    """Median je Lage über die Bezugstage."""
    T = {}
    for k, L in P.items():
        g = {}
        for d, lage, v in L:
            if d in tage:
                g.setdefault(lage, []).append(v)
        mn = 2 if k == "guetegrad" else BIN_MIN
        mitte = mittel if k in MITTEL else median
        T[k] = {lage: (mitte(v), len(v)) for lage, v in g.items() if len(v) >= mn}
    return T


def tageswert(P, T, tag):
    """Je Prüfung: Wert (Median des Tages) und Abweichung (Median der Abweichungen je Minute gegen den Bezug derselben Lage)."""
    W = {}
    for k, L in P.items():
        v = [x for d, lage, x in L if d == tag]
        a = []
        for d, lage, x in L:
            if d != tag or lage not in T.get(k, {}):
                continue
            b = T[k][lage][0]
            if k in ("hydraulik", "guetegrad"):
                if b:
                    a.append(100.0 * (x - b) / b)
            else:
                a.append(x - b)
        mitte = mittel if k in MITTEL else median
        W[k] = {"wert": r3(mitte(v)), "n": len(v), "abweichung": r3(mitte(a)) if len(a) >= MIN_N[k] else None, "n_vergleich": len(a),
                "einheit": EINHEIT[k]}
    return W


def komma(v, n=None):
    """Zahl mit Vorzeichen und Dezimalkomma für Befundtexte (n Stellen; Standard: 2 unter 10, sonst 0)."""
    if n is None:
        n = 2 if abs(v) < 10 else 0
    return (("%+." + str(n) + "f") % v).replace(".", ",") if n else "%+d" % round(v)


def mittel(v):
    v = [x for x in v if x is not None]
    return sum(v) / len(v) if v else None


def r3(v):
    return None if v is None else round(v, 3)


def stehende_fuehler(Q, tag):
    """Längste Strecke je Spalte, in der der Wert bei laufendem Verdichter gleich bleibt (Minuten)."""
    out = {}
    Qt = [r for r in Q if r["_t"].date() == tag]
    for s in STEHEND_SPALTEN:
        best = cur = 0.0
        last = None
        for a, b in zip(Qt, Qt[1:]):
            if (zahl(a.get("verdichter_hz")) or 0) <= 0 or a.get(s) in ("", None):
                cur, last = 0.0, None
                continue
            g = (b["_t"] - a["_t"]).total_seconds() / 60
            if a.get(s) == last and g <= 10:
                cur += g
            else:
                cur = 0.0
            last = a.get(s)
            best = max(best, cur)
        out[s] = round(best)
    return out


def abtau_fakten(d, tag):
    D = [r for r in d.get("defrost", []) if r["_t"].date() == tag]
    abst = [zahl(r.get("min_seit_letzter_abtauung")) for r in D]
    return {"anzahl": len(D), "abstand_median_min": r3(median([x for x in abst if x and x < 600])),
            "heizstab_min": sum(zahl(r.get("heizstab_min")) or 0 for r in D),
            "liste": [{"zeit": r["_t"].strftime("%H:%M"), "aussen": zahl(r.get("aussen")), "feuchte": zahl(r.get("feuchte")),
                       "dauer_min": zahl(r.get("dauer_min")), "abstand_min": zahl(r.get("min_seit_letzter_abtauung")),
                       "heizregelung": r.get("heizregelung"), "quiet": r.get("quiet")} for r in D]}


def lade_bereich(daten, von, bis):
    d = {"quiet": [], "defrost": []}
    m = sorted({(von + dt.timedelta(days=i)).strftime("%Y-%m") for i in range((bis - von).days + 1)})
    for mm in m:
        for key, name in (("quiet", "quiet-%s.csv"), ("defrost", "defrost-%s.csv")):
            x = daten.csv(name % mm)
            if x:
                d[key] += [r for r in x if von <= r["_t"].date() <= bis]
    for k in d:
        d[k].sort(key=lambda r: r["_t"])
    return d


def befunde_aus(trend, W, stehend, bezug_tage):
    B = []
    if bezug_tage < BEZUG_MIN_TAGE:
        B.append({"schwere": "info", "pruefung": None, "titel": "Gesundheit lernt noch",
                  "text": "Bezug hat %d Tage mit Daten (nötig %d); Abweichungen sind noch nicht belastbar" % (bezug_tage, BEZUG_MIN_TAGE)})
        return B
    for k, (h, w) in SCHWELLE.items():
        t = trend.get(k) or {}
        m = t.get("median")
        if m is None:
            continue
        if abs(m) >= w:
            schwere = "warnung"
        elif abs(m) >= h:
            schwere = "hinweis"
        else:
            continue
        B.append({"schwere": schwere, "pruefung": k, "titel": "%s %s %s" % (NAME[k], komma(m), EINHEIT[k]),
                  "text": "Median der letzten %d Tage mit Wert %s %s gegen den Bezug derselben Lage (Schwelle %s/%s). Mögliche Ursache: %s" % (
                      t.get("tage"), komma(m), EINHEIT[k], komma(h, 0 if h >= 10 else 2), komma(w, 0 if w >= 10 else 2), URSACHE[k]), "tage": t.get("werte")})
    for s, mnt in stehend.items():
        if mnt >= STEHEND_MIN[s]:
            B.append({"schwere": "hinweis", "pruefung": "fuehler_stehend", "titel": "Fühler %s steht %d min" % (s, mnt),
                      "text": "Bei laufendem Verdichter %d min ohne Änderung: Fühler, Kabel oder HeishaMon-Wert hängt" % mnt})
    return B


def rechne(daten, tag, ordner):
    von = tag - dt.timedelta(days=BEZUG_VON)
    d = lade_bereich(daten, von, tag)
    if not any(r["_t"].date() == tag for r in d["quiet"]):
        raise ValueError("keine Minutenzeilen am %s" % tag)
    P = proben(d["quiet"])
    bezug = {tag - dt.timedelta(days=i) for i in range(BEZUG_BIS, BEZUG_VON + 1)}
    vorhanden = {r["_t"].date() for r in d["quiet"]}
    bezug_tage = len(bezug & vorhanden)
    T = bezug_tabelle(P, bezug)
    W = tageswert(P, T, tag)
    # Trend: dieselbe Rechnung (gleicher Bezug) für die letzten Tage bis TREND_TAGE Tage mit Wert
    trend = {}
    hist = {}
    for i in range(0, 10):
        x = tag - dt.timedelta(days=i)
        if x not in vorhanden:
            continue
        hist[x] = W if i == 0 else tageswert(P, T, x)
    for k in SCHWELLE:
        werte = [(x.isoformat(), hist[x][k]["abweichung"]) for x in sorted(hist, reverse=True) if hist[x][k]["abweichung"] is not None][:TREND_TAGE]
        trend[k] = {"tage": len(werte), "median": r3(median([v for _, v in werte])) if len(werte) >= 3 else None, "werte": werte}
    stehend = stehende_fuehler(d["quiet"], tag)
    befunde = befunde_aus(trend, W, stehend, bezug_tage)
    return {"tag": tag.isoformat(), "version": VERSION, "erstellt": dt.datetime.now().isoformat(sep=" ", timespec="seconds"),
            "quelle": "tools/gesundheit_tag.py v%d (nur lesen, ohne Sprachmodell)" % VERSION,
            "bezug": {"von": (tag - dt.timedelta(days=BEZUG_VON)).isoformat(), "bis": (tag - dt.timedelta(days=BEZUG_BIS)).isoformat(), "tage_mit_daten": bezug_tage},
            "werte": W, "trend": trend, "fuehler_stehend_min": stehend, "abtauen": abtau_fakten(d, tag), "befunde": befunde,
            "befunde_anzahl": {k: sum(1 for b in befunde if b["schwere"] == k) for k in ("warnung", "hinweis", "info")}}


def schreibe_csv(ordner):
    spalten = ["tag", "bezug_tage"] + ["%s.%s" % (k, f) for k in SCHWELLE for f in ("abweichung", "trend")] + ["abtau.anzahl", "befunde.warnung", "befunde.hinweis"]
    zeilen = [",".join(spalten)]
    for f in sorted(os.listdir(ordner)):
        if not re.match(r"^\d{4}-\d{2}-\d{2}\.json$", f):
            continue
        try:
            with open(os.path.join(ordner, f), encoding="utf-8") as fh:
                j = json.load(fh)
        except (OSError, ValueError):
            continue
        z = [f[:10], (j.get("bezug") or {}).get("tage_mit_daten")]
        for k in SCHWELLE:
            z += [((j.get("werte") or {}).get(k) or {}).get("abweichung"), ((j.get("trend") or {}).get(k) or {}).get("median")]
        z += [(j.get("abtauen") or {}).get("anzahl"), (j.get("befunde_anzahl") or {}).get("warnung"), (j.get("befunde_anzahl") or {}).get("hinweis")]
        zeilen.append(",".join(csv_wert(v) for v in z))
    schreibe_atomar(os.path.join(ordner, "tage.csv"), "\n".join(zeilen) + "\n")
    return len(zeilen) - 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="Anlagen-Gesundheit (nur lesen, ohne Sprachmodell)")
    ap.add_argument("--daten", required=True)
    ap.add_argument("--ergebnis", required=True, help="geschrieben wird nach <ergebnis>/gesundheit/")
    ap.add_argument("--tag", help="JJJJ-MM-TT (Standard: gestern)")
    ap.add_argument("--alle", action="store_true", help="alle Tage mit Minutenprotokoll bis --tag nachrechnen")
    a = ap.parse_args(argv)
    tag = dt.date.fromisoformat(a.tag) if a.tag else dt.date.today() - dt.timedelta(days=1)
    if not os.path.isdir(a.daten):
        print("Fehler: Datenordner fehlt: %s" % a.daten, file=sys.stderr)
        return 2
    ordner = os.path.join(a.ergebnis, "gesundheit")
    os.makedirs(ordner, exist_ok=True)
    daten = Daten(a.daten)
    tage = [x for x in daten.tage_mit_daten(daten.monate_vorhanden()) if x <= tag] if a.alle else [tag]
    fehler = 0
    for x in tage:
        try:
            erg = rechne(daten, x, ordner)
        except (OSError, ValueError) as e:
            print("Fehler %s: %s" % (x, e), file=sys.stderr)
            fehler += 1
            continue
        schreibe_atomar(os.path.join(ordner, x.isoformat() + ".json"), json.dumps(erg, ensure_ascii=False, indent=1, sort_keys=True, default=str) + "\n")
        print("Gesundheit %s: Bezug %d Tage, %s" % (x, erg["bezug"]["tage_mit_daten"], "; ".join(
            "%s %s" % (k, "–" if erg["werte"][k]["abweichung"] is None else "%+.2f" % erg["werte"][k]["abweichung"]) for k in SCHWELLE)
            + (" | Befunde: " + "; ".join("%s %s" % (b["schwere"], b["titel"]) for b in erg["befunde"]) if erg["befunde"] else "")))
    n = schreibe_csv(ordner)
    print("tage.csv: %d Tage" % n)
    return 1 if fehler and fehler == len(tage) else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Kern: Zaehler "Starts_Today" am Kalendertag statt am Node-RED-Start (VORBEREITET, nicht im Deploy-Paket; braucht das ausdrueckliche Go des Nutzers).

Befund (Live-Flows und Minutenprotokoll 07.10.-13.11.2026, Spalte starts_heute):
 - Der Inject "24 hours reset" (Tab WP Debug) sendet "reset_today" alle 86400 s ab dem Start des Knotens, nicht um Mitternacht. Zurueckgesetzt wurde deshalb
   um 20:15 (10.-21.10.), 22:30 (22.-23.10.), 17:01 (25.10.-01.11.), 22:50 (02.11.), 06:46 (05.-08.11.) und 22:10 (10.-12.11.), nie um 00:00. Nach jedem
   Neustart von Node-RED beginnen die 24 h neu: der Zaehler lief dann 42 bis 63 h durch (z. B. 08.11. 06:46 bis 10.11. 22:10).
 - Gezaehlt wird richtig (jeder Wechsel 0 -> > 0 Hz, also auch die zwei Starts je Abtauung): in 27 von 32 Abschnitten gleich den Verdichterstarts im
   Protokoll. In den 5 Abschnitten mit einem Neustart von Node-RED 1 bis 2 mehr: die rbe-Knoten vor dem Zaehler vergessen ihren Stand, die erste Meldung
   "laeuft" eines laengst laufenden Verdichters zaehlt als Start.

Zwei Teile, beide mit Markierung "OPT-Kern Starts_Today" und vollstaendig rueckbaubar. Geaendert werden nur zwei vorhandene Knoten, keine Verdrahtung,
kein neuer Knoten, kein Sendeweg:
 R  Ruecksetzen am Datum (Standard):
    - Inject 2a1004c42a0b7dc1: statt "alle 86400 s" taeglich 00:00 (crontab "00 00 * * *") und einmal 30 s nach dem Start; Nutzlast bleibt "reset_today".
    - Funktion "Starts counter" df9dc017de54372f: merkt sich den Kalendertag (global Starts_Today_Date, Speicher "file") und setzt den Zaehler zurueck, sobald
      eine Nachricht an einem anderen Tag ankommt, auch eine Verdichter-Meldung. "reset_today" loest nur noch diesen Vergleich aus. Damit setzt weder ein
      Neustart am Tag den Zaehler zurueck, noch geht ein Tageswechsel verloren, wenn Node-RED um 00:00 nicht lief. Beim ersten Lauf nach dem Patch bleibt der
      Zaehlerstand stehen (nur das Datum wird gemerkt). Ein Zaehlerstand, der keine Zahl ist, wird 0 (vorher: undefined + 1 = NaN).
 N  Kein Phantom-Start nach einem Neustart (nur mit --mit-neustart):
    - Dieselbe Funktion merkt sich, ob der Verdichter zuletzt lief (global Starts_Today_Run), und zaehlt nur den Wechsel von "steht" auf "laeuft".

Aufruf:   python3 starts_today_patch.py flows.json [--mit-neustart]   (anwenden; idempotent; Liste der Knoten oder v2-Format {"flows": [...]})
          python3 starts_today_patch.py flows.json --revert           (zurueck auf den heutigen Stand, Byte fuer Byte)
          python3 starts_today_patch.py flows.json --check            (Exit 0 = drin, 1 = nicht drin, 2 = Anker fehlen, 3 = nur teilweise drin)
          python3 starts_today_patch.py --ids                         (die zwei Knoten-IDs fuer die Ausnahmeliste eines Deploys)
          python3 starts_today_patch.py --diff vorher.json nachher.json   (prueft, dass sich nur diese zwei Knoten und nur die erklaerten Felder unterscheiden)
Simulation: node tools/starts_today_sim.js <flows.json> [Datenordner mit quiet-JJJJ-MM.csv]
"""
import json
import sys

INJECT_ID = "2a1004c42a0b7dc1"        # inject "24 hours reset" (Tab WP Debug)
COUNTER_ID = "df9dc017de54372f"       # function "Starts counter" (Tab WP Debug), kein Ausgang
IDS = [INJECT_ID, COUNTER_ID]
MARK = "OPT-Kern Starts_Today"
MARK_N = "OPT-Kern Starts_Today N"

INJECT_ALT = {"name": "24 hours reset", "repeat": "86400", "crontab": "", "once": False, "onceDelay": "0"}
INJECT_NEU = {"name": "Tageswechsel 00:00 (und 30 s nach dem Start)", "repeat": "", "crontab": "00 00 * * *", "once": True, "onceDelay": "30"}
INJECT_FEST = {"type": "inject", "payload": "reset_today", "payloadType": "str", "wires": [[COUNTER_ID]]}      # muss so sein und bleibt so

FUNC_ALT = ('//get Starts_Today:\nvar Starts_Today = global.get(\'Starts_Today\', "file");\nif (Starts_Today === undefined) { global.set(\'Starts_Today\', 0, "file"); }\n\n'
            'if (msg.payload == "reset_today") {\n    global.set(\'Starts_Today\', 0, "file");\n    return null;\n}\n\n'
            'if (msg.payload == "läuft" || msg.payload == "läuft [Abtauen]" || msg.payload == "läuft (übersprungen)") {                                      //started or already running\n'
            '    Starts_Today += 1;\n    global.set(\'Starts_Today\', Starts_Today, "file");\n}\n\n\n')

KOPF = r"""// OPT-Kern Starts_Today: Tageswechsel am Kalendertag (tools/starts_today_patch.py, Fork fl0wb0b/HeishaMoNR).
// Vorher setzte nur der Inject zurueck, alle 86400 s ab dem Start von Node-RED und damit nie um Mitternacht.
// Jetzt: Datum merken (Starts_Today_Date); kommt eine Nachricht an einem anderen Tag an, beginnt der Zaehler bei 0.
// "reset_today" (Inject 00:00 und 30 s nach dem Start) loest nur noch diesen Vergleich aus.
var Starts_Today = global.get('Starts_Today', "file");
if (typeof Starts_Today !== 'number' || !isFinite(Starts_Today)) { Starts_Today = 0; global.set('Starts_Today', 0, "file"); }
var d = new Date(), heute = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
var tag = global.get('Starts_Today_Date', "file");
if (tag === undefined || tag === null) { global.set('Starts_Today_Date', heute, "file"); }                 // erster Lauf nach dem Patch: Zaehlerstand bleibt
else if (tag !== heute) { Starts_Today = 0; global.set('Starts_Today', 0, "file"); global.set('Starts_Today_Date', heute, "file"); }

if (msg.payload == "reset_today") { return null; }

"""
ZAEHLEN_R = r"""if (msg.payload == "läuft" || msg.payload == "läuft [Abtauen]" || msg.payload == "läuft (übersprungen)") {                                      //started or already running
    Starts_Today += 1;
    global.set('Starts_Today', Starts_Today, "file");
}
"""
ZAEHLEN_N = r"""// OPT-Kern Starts_Today N: nur der Wechsel von "steht" auf "laeuft" ist ein Start. Nach einem Neustart von Node-RED melden die rbe-Knoten davor
// einen laengst laufenden Verdichter noch einmal als "laeuft"; das zaehlte bisher als Start.
var laeuft = msg.payload == "läuft" || msg.payload == "läuft [Abtauen]" || msg.payload == "läuft (übersprungen)";
var lief = global.get('Starts_Today_Run', "file");
if (laeuft) {
    if (lief !== true) { Starts_Today += 1; global.set('Starts_Today', Starts_Today, "file"); }
    global.set('Starts_Today_Run', true, "file");
} else if (typeof msg.payload === 'string' && msg.payload.indexOf('gestoppt') === 0) {
    global.set('Starts_Today_Run', false, "file");
}
"""
FUNC_R = KOPF + ZAEHLEN_R
FUNC_N = KOPF + ZAEHLEN_N
ERLAUBT = {INJECT_ID: set(INJECT_NEU), COUNTER_ID: {"func"}}                     # nur diese Felder duerfen sich unterscheiden


class Abbruch(Exception):
    pass


def laden(pfad):
    with open(pfad, encoding="utf-8") as f:
        d = json.load(f)
    if isinstance(d, dict) and isinstance(d.get("flows"), list):
        return d, d["flows"]
    if isinstance(d, list):
        return d, d
    raise Abbruch("%s ist keine Flow-Liste" % pfad)


def find(flows, nid):
    for n in flows:
        if n.get("id") == nid:
            return n
    return None


def state(flows):
    """(Zustand, Text): 'alt' | 'R' | 'N' | 'teil' | 'fehlt'."""
    i, c = find(flows, INJECT_ID), find(flows, COUNTER_ID)
    if i is None or c is None:
        return "fehlt", "Knoten fehlt: " + ", ".join(x for x, n in ((INJECT_ID, i), (COUNTER_ID, c)) if n is None)
    fest = [k for k, v in INJECT_FEST.items() if i.get(k) != v]
    if fest or c.get("type") != "function" or c.get("wires") != []:
        return "fehlt", "Anker passen nicht (Inject %s, Zaehler Typ/Verdrahtung)" % (fest or "ok")
    i_alt = all(i.get(k) == v for k, v in INJECT_ALT.items())
    i_neu = all(i.get(k) == v for k, v in INJECT_NEU.items())
    f = c.get("func")
    if i_alt and f == FUNC_ALT:
        return "alt", "heutiger Stand (Ruecksetzen alle 86400 s ab Start)"
    if i_neu and f == FUNC_R:
        return "R", "Patch drin: Ruecksetzen am Datum"
    if i_neu and f == FUNC_N:
        return "N", "Patch drin: Ruecksetzen am Datum, kein Phantom-Start nach Neustart"
    if (i_neu or MARK in (f or "")) and (i_alt or i_neu) and (f in (FUNC_ALT, FUNC_R, FUNC_N)):
        return "teil", "nur teilweise drin (Inject %s, Funktion %s)" % ("neu" if i_neu else "alt", "neu" if f != FUNC_ALT else "alt")
    return "fehlt", "Anker passen nicht: der Inject oder die Funktion hat einen anderen Stand als erwartet (Live-Flow geaendert?)"


def apply(flows, mit_neustart=False):
    z, text = state(flows)
    if z == "fehlt":
        raise Abbruch(text)
    ziel = FUNC_N if mit_neustart else FUNC_R
    i, c = find(flows, INJECT_ID), find(flows, COUNTER_ID)
    vorher = (dict(i), c.get("func"))
    i.update(INJECT_NEU)
    c["func"] = ziel
    return (dict(i), c.get("func")) != vorher


def revert(flows):
    z, text = state(flows)
    if z == "fehlt":
        raise Abbruch(text)
    i, c = find(flows, INJECT_ID), find(flows, COUNTER_ID)
    vorher = (dict(i), c.get("func"))
    i.update(INJECT_ALT)
    c["func"] = FUNC_ALT
    return (dict(i), c.get("func")) != vorher


def diff(a_pfad, b_pfad):
    """Fehlerliste: Unterschiede ausserhalb der zwei Knoten bzw. der erklaerten Felder (opt_* bleiben aussen vor, die aendert der Generator)."""
    A = {n["id"]: n for n in laden(a_pfad)[1]}
    B = {n["id"]: n for n in laden(b_pfad)[1]}
    fehler = []
    for nid in sorted(set(A) | set(B)):
        if str(nid).startswith("opt_"):
            continue
        a, b = A.get(nid), B.get(nid)
        if a == b:
            continue
        if a is None or b is None:
            fehler.append("%s: Knoten %s" % (nid, "neu" if a is None else "geloescht"))
            continue
        felder = {k for k in set(a) | set(b) if a.get(k) != b.get(k)}
        if nid not in ERLAUBT:
            fehler.append("%s (%s): geaendert, gehoert nicht zum Patch (%s)" % (nid, a.get("name") or a.get("type"), ", ".join(sorted(felder))))
        elif not felder <= ERLAUBT[nid]:
            fehler.append("%s: nicht erklaerte Felder geaendert: %s" % (nid, ", ".join(sorted(felder - ERLAUBT[nid]))))
    return fehler


def main():
    args = sys.argv[1:]
    if "--ids" in args:
        print(" ".join(IDS))
        return 0
    if "--diff" in args:
        k = args.index("--diff")
        try:
            fehler = diff(args[k + 1], args[k + 2])
        except (IndexError, OSError, ValueError, Abbruch) as e:
            print("Fehler: %s" % e)
            return 2
        for f in fehler:
            print("NICHT ERLAUBT: " + f)
        print("Diff: %s" % ("nur die zwei Knoten des Patches, nur erklaerte Felder" if not fehler else "%d Abweichung(en)" % len(fehler)))
        return 1 if fehler else 0
    dateien = [a for a in args if not a.startswith("--")]
    flags = {a for a in args if a.startswith("--")}
    if len(dateien) != 1 or flags - {"--revert", "--check", "--mit-neustart"}:
        print(__doc__)
        return 2
    try:
        daten, flows = laden(dateien[0])
        if "--check" in flags:
            z, text = state(flows)
            print("Starts_Today: " + text)
            return {"R": 0, "N": 0, "alt": 1, "fehlt": 2, "teil": 3}[z]
        geaendert = revert(flows) if "--revert" in flags else apply(flows, "--mit-neustart" in flags)
    except (OSError, ValueError, Abbruch) as e:
        print("Fehler, nichts geaendert: %s" % e)
        return 2
    if geaendert:
        with open(dateien[0], "w", encoding="utf-8") as f:
            json.dump(daten, f, ensure_ascii=False)
        print("geaendert: %s (%s)" % ("Revert" if "--revert" in flags else ("Patch R + N" if "--mit-neustart" in flags else "Patch R"), " ".join(IDS)))
    else:
        print("nichts zu tun: " + state(flows)[1])
    return 0


if __name__ == "__main__":
    sys.exit(main())

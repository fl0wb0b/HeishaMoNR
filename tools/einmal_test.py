#!/usr/bin/env python3
"""Gemeinsamer Abschluss fuer erledigte Einmal-Tests (Kern-Patches an den HeishaMoNR-Seiten).

Die Tests ui_kompakt_test, tabs_zusammen_test, ui_optik_test, ui_kern_b_test und uebersicht_doppelwerte_test pruefen je einen Patch, der
laengst auf der Anlage eingespielt ist. Sie brauchen einen Flow-Export VOR dem jeweiligen Patch (liegt bei den Sicherungen des Projekts,
nicht im Repo). Auf dem heutigen Live-Stand sind sie nicht anwendbar: dann eine klare Meldung und der Rueckgabewert RC_ERLEDIGT (3) statt
eines Abbruchs mitten im Test. 0 = bestanden, 1 = Pruefung fehlgeschlagen, 2 = Aufruf falsch, 3 = erledigter Einmal-Test (kein Fehler).
tools/alle_tests.sh wertet 3 als „uebersprungen“."""
import sys

RC_AUFRUF = 2
RC_ERLEDIGT = 3


def flows_argument(name, zusatz=""):
    """Pfad der Flow-Datei aus der Kommandozeile; fehlt er: Aufruf-Hinweis und RC_AUFRUF."""
    if len(sys.argv) < 2:
        print("Aufruf: python3 tools/%s.py <flows.json>%s" % (name, (" – " + zusatz) if zusatz else ""))
        print("ERLEDIGTER EINMAL-TEST: braucht einen Flow-Export VOR dem Patch; siehe tools/einmal_test.py.")
        sys.exit(RC_AUFRUF)
    return sys.argv[1]


def erledigt(name, patch, eingespielt, grund):
    """Der Export ist schon gepatcht (oder weicht vom Stand vor dem Patch ab): nicht anwendbar, kein Fehler."""
    g = " ".join(str(grund).split())
    print("EINMAL-TEST erledigt: %s prueft %s (eingespielt %s) und braucht einen Flow-Export VOR diesem Patch." % (name, patch, eingespielt))
    print("Auf dieser Datei nicht anwendbar: %s" % (g[:300] + (" …" if len(g) > 300 else "")))
    print("\nERGEBNIS %s: nicht anwendbar (erledigter Einmal-Test), Rueckgabewert %d" % (name, RC_ERLEDIGT))
    sys.exit(RC_ERLEDIGT)

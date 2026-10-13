#!/usr/bin/env python3
"""Dashboard-Tabs zusammenlegen (HeishaMoNR-Kernseiten): aendert auf einer Flow-Datei nur Darstellung und die davon abhaengigen Verweise.

Neue Seiten (der Traeger-Tab behaelt seine ID und seine Position im Menue, die eingegliederten Tabs bleiben leer und werden ausgeblendet):
  Heizung    = Heizkurve (Traeger) + Raumregelung       Gruppen 17 breit, bei 1920 px nebeneinander
  Betrieb    = Sanftanlauf (Traeger) + Pumpendrehzahl   Gruppen 17 breit (Erweitert/Leisemodus bleiben 6)
  Auswertung = Temperaturen (Traeger) + Gradtage        Gruppen 17 breit
Unveraendert: Uebersicht, Einstellungen, Zeitplan, Effizienz, SYSTEM (Begruendung im Bericht TABS_BERICHT.md).

Erlaubt (Whitelist, alles andere bricht ab):
  * ui_tab:    name (nur die drei Traeger), hidden (nur die drei eingegliederten Tabs, False -> True)
  * ui_group:  tab (nur innerhalb derselben neuen Seite), name, width, order
  * ui_*-Widgets: width, height, order (keine Gruppenwechsel)
  * Verweise in genau benannten Knoten (VERWEISE unten, jeweils mit erwartetem Altwert):
      - Gruppen-Schluessel "<Tab>_<Gruppe>" (Leerzeichen -> _) in Knopf-/Inject-Nutzlasten (ui_control group show/hide)
      - Menue-Konfiguration SYSTEM > MENU (ui_form "group - Main tabs": Optionen und Startwerte = Tabnamen)
      - fixTabs() in "Store settings" (gespeicherte Menue-Konfiguration -> neue Tabnamen; zusammengelegt = sichtbar, wenn eine alte Seite sichtbar war)
Keine Knoten neu oder geloescht, keine Verdrahtung, kein MQTT, keine opt_*-Knoten.

Aufrufe (nur Standardbibliothek, Layout-Modell aus tools/ui_kompakt_patch.py):
  python3 tools/tabs_zusammen_patch.py <flows.json> --dry-run
      Bericht: Seitenhoehen vorher/nachher (1024/1920/2560 px), waagrechtes Scrollen, Ueberlappung, alle umgeschriebenen Verweise, geaenderte IDs
  python3 tools/tabs_zusammen_patch.py <flows.json> --apply [--out neu.json] [--sicherung datei.json]
  python3 tools/tabs_zusammen_patch.py <flows.json> --revert --sicherung datei.json [--out zurueck.json]   (byte-gleich mit dem Original)
Ist ein Wert schon neu, wird er uebersprungen (idempotent). Weicht ein Ausgangswert ab (Live-Flow inzwischen anders), bricht das Skript ab.
Rueckbau nur in umgekehrter Reihenfolge der Patches: erst dieses Skript --revert, dann ggf. ui_kompakt_patch.py --revert
(das bricht von selbst ab, solange die hier geaenderten Breiten noch gelten).
"""
import argparse
import copy
import datetime
import importlib.util
import itertools
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("ui_kompakt_patch", os.path.join(HERE, "ui_kompakt_patch.py"))
UKP = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(UKP)
Abbruch = UKP.Abbruch

# ---------------------------------------------------------------- Seiten
T_HEIZKURVE, T_RAUM = "1d038e38da23c646", "d6d4a43045260ac9"
T_SANFT, T_PUMPE = "992c3064baf54797", "1cc13371e25eaa24"
T_TEMP, T_GRAD = "5b5fabb85470bd21", "a681244e6db9a6a7"
# neue Seite: (Traeger-Tab, alter Name, eingegliederte Tabs)
SEITEN = {"Heizung": (T_HEIZKURVE, "Heizkurve", (T_RAUM,)),
          "Betrieb": (T_SANFT, "Sanftanlauf", (T_PUMPE,)),
          "Auswertung": (T_TEMP, "Temperaturen", (T_GRAD,))}
EINGEGLIEDERT = {T_RAUM: "Raumregelung", T_PUMPE: "Pumpendrehzahl", T_GRAD: "Gradtage"}

# Gruppen-Schluessel des Dashboards "<Tabname>_<Gruppenname>" (Leerzeichen -> _): alt -> neu (ui_control {"group":{"show"/"hide"}})
SCHLUESSEL = {
    "Heizkurve_Zone1": "Heizung_Heizkurve", "Heizkurve_Hilfe": "Heizung_Hilfe_Heizkurve", "Heizkurve_TopBar": "Heizung_TopBar",
    "Raumregelung_Zone1": "Heizung_Raumregelung", "Raumregelung_Automatisierungen": "Heizung_Automatisierungen",
    "Raumregelung_Hilfe": "Heizung_Hilfe_Raumregelung",
    "Sanftanlauf_Einstellungen": "Betrieb_Sanftanlauf", "Sanftanlauf_Erweitert": "Betrieb_Erweitert",
    "Sanftanlauf_Leisemodus-Zusatz_Einstellungen": "Betrieb_Leisemodus-Zusatz_Einstellungen", "Sanftanlauf_Hilfe": "Betrieb_Hilfe_Sanftanlauf",
    "Sanftanlauf_TopBar": "Betrieb_TopBar", "Pumpendrehzahl_Einstellungen": "Betrieb_Pumpendrehzahl",
    "Temperaturen_Help": "Auswertung_Hilfe_Temperaturen", "Temperaturen_Wassertemperatur": "Auswertung_Wassertemperatur",
    "Gradtage_Help": "Auswertung_Hilfe_Gradtage", "Gradtage_Degree_days_information": "Auswertung_Degree_days_information",
}
# Schluessel ohne Ziel schon VOR dem Patch (Zone 2 liegt seit ui_kompakt auf dem versteckten Tab GUI, Rest Altlasten des Originals): bleiben wie sie sind
VERWAIST = {"Heizkurve_Zone2", "Raumregelung_Zone2", "CCC_Graph", "WAR_Help", "COOL_Help", "Solar_P1_setup", "Solar_Help", "Solar_Charts", "Solar_Setup"}
_GRENZE_L, _GRENZE_R = r"(?<![A-Za-z0-9_\-ÄÖÜäöüß²])", r"(?![A-Za-z0-9_\-ÄÖÜäöüß²])"
SCHLUESSEL_RE = re.compile(_GRENZE_L + "(" + "|".join(re.escape(k) for k in sorted(SCHLUESSEL, key=len, reverse=True)) + ")" + _GRENZE_R)


def us(s):
    return str(s).replace(" ", "_")


def kurz(v):
    if isinstance(v, list):
        return "[%d Eintraege]" % len(v)
    return UKP.kurz(v)


# (Seite, Knoten-ID, Typ, Name, Schluessel, alt, neu, Grund)
AENDERUNGEN = [
    # ---- Tabs: Traeger umbenennen, eingegliederte Tabs ausblenden (leer; IDs und Menue-Positionen bleiben, Lesezeichen #!/n zeigen weiter auf dieselbe Stelle)
    ('Heizung', T_HEIZKURVE, 'ui_tab', 'Heizkurve', 'name', 'Heizkurve', 'Heizung', 'Heizkurve + Raumregelung auf einer Seite'),
    ('Heizung', T_RAUM, 'ui_tab', 'Raumregelung', 'hidden', False, True, 'leer (Gruppen auf Heizung), ausgeblendet'),
    ('Betrieb', T_SANFT, 'ui_tab', 'Sanftanlauf', 'name', 'Sanftanlauf', 'Betrieb', 'Pumpendrehzahl + Sanftanlauf auf einer Seite'),
    ('Betrieb', T_PUMPE, 'ui_tab', 'Pumpendrehzahl', 'hidden', False, True, 'leer (Gruppe auf Betrieb), ausgeblendet'),
    ('Auswertung', T_TEMP, 'ui_tab', 'Temperaturen', 'name', 'Temperaturen', 'Auswertung', 'Temperaturen + Gradtage auf einer Seite'),
    ('Auswertung', T_GRAD, 'ui_tab', 'Gradtage', 'hidden', False, True, 'leer (Gruppen auf Auswertung), ausgeblendet'),
    # ---- Heizung: Heizkurve | Raumregelung nebeneinander (je 17 = 912 px, ab ~1860 px zwei Spalten), Hilfen und Automatisierungen gleich breit
    ('Heizung', '9b8ec8b1b9f66309', 'ui_group', 'Zone1', 'name', 'Zone1', 'Heizkurve', 'eindeutiger Gruppenname auf Heizung'),
    ('Heizung', '9b8ec8b1b9f66309', 'ui_group', 'Zone1', 'width', 18, 17, '17 statt 18 (zwei Gruppen nebeneinander bei 1920)'),
    ('Heizung', 'ef3dbc543ae92bec', 'ui_group', 'Automatisierungen', 'tab', T_RAUM, T_HEIZKURVE, 'auf Heizung'),
    ('Heizung', 'ef3dbc543ae92bec', 'ui_group', 'Automatisierungen', 'width', 18, 17, '17 statt 18'),
    ('Heizung', 'ef3dbc543ae92bec', 'ui_group', 'Automatisierungen', 'order', 2, 3, 'nach der Heizkurve'),
    ('Heizung', 'e27cfec311892d88', 'ui_group', 'Zone1', 'tab', T_RAUM, T_HEIZKURVE, 'auf Heizung'),
    ('Heizung', 'e27cfec311892d88', 'ui_group', 'Zone1', 'name', 'Zone1', 'Raumregelung', 'eindeutiger Gruppenname auf Heizung'),
    ('Heizung', 'e27cfec311892d88', 'ui_group', 'Zone1', 'width', 18, 17, '17 statt 18 (neben der Heizkurve)'),
    ('Heizung', 'e27cfec311892d88', 'ui_group', 'Zone1', 'order', 3, 4, 'nach der Heizkurve'),
    ('Heizung', 'ae6c2168304beda0', 'ui_group', 'Hilfe', 'tab', T_RAUM, T_HEIZKURVE, 'auf Heizung'),
    ('Heizung', 'ae6c2168304beda0', 'ui_group', 'Hilfe', 'name', 'Hilfe', 'Hilfe Raumregelung', 'eindeutiger Gruppenname auf Heizung'),
    ('Heizung', 'ae6c2168304beda0', 'ui_group', 'Hilfe', 'width', 18, 17, '17 statt 18'),
    ('Heizung', '79eed3b289871944', 'ui_group', 'Hilfe', 'name', 'Hilfe', 'Hilfe Heizkurve', 'eindeutiger Gruppenname auf Heizung'),
    ('Heizung', '79eed3b289871944', 'ui_group', 'Hilfe', 'width', '12', '17', '17 wie alle Gruppen der Seite (Masonry-Falle)'),
    ('Heizung', '79eed3b289871944', 'ui_group', 'Hilfe', 'order', 4, 6, 'Hilfen ans Ende'),
    ('Heizung', '4d5e9a9dacd2b429', 'ui_chart', '', 'width', 10, 9, 'Heizkurve rechte Spalte 9 (Gruppe 17)'),
    ('Heizung', '36a9b7dad9d2611e', 'ui_text', 'Graph description', 'width', 10, 9, 'Heizkurve rechte Spalte 9 (Gruppe 17)'),
    ('Heizung', 'db206585adea91d8', 'ui_template', 'Line - Setup ', 'width', 10, 9, 'Heizkurve rechte Spalte 9 (Gruppe 17)'),
    ('Heizung', '0d58a1e854263ec4', 'ui_chart', '', 'width', 10, 9, 'Heizkurve rechte Spalte 9 (Gruppe 17)'),
    ('Heizung', 'b32f014cb3ec752e', 'ui_chart', '', 'width', 11, 10, 'Raumregelung Diagramm 10 (Gruppe 17)'),
    ('Heizung', '032ca56c8c21283e', 'ui_text', 'footnote', 'width', 11, 10, 'Raumregelung Fussnote 10 (Gruppe 17)'),
    ('Heizung', '80b26053020f1f65', 'ui_template', '', 'width', 11, 10, 'Erklaerkasten 10 breit (Text 504 px, Kasten 12 Zeilen = 642 px, gemessen in Firefox)'),
    ('Heizung', 'd00691f660be457b', 'ui_text', 'spacer 1', 'width', 17, 16, 'Kopfzeile der Hilfe: Leerfeld + Schliessen-Knopf = 17'),
    ('Heizung', '184850f4f96ed36c', 'ui_text', 'spacer 1', 'width', 11, 16, 'Kopfzeile der Hilfe: Leerfeld + Schliessen-Knopf = 17'),
    ('Heizung', '43be81558a98b102', 'ui_template', 'Line - Instructions text', 'width', 12, 17, 'Hilfetext ueber die ganze Gruppe'),
    # ---- Betrieb: Pumpendrehzahl | Sanftanlauf nebeneinander; Erweitert/Leisemodus (6) erscheinen unter der kuerzeren Spalte, Hilfe statt Sanftanlauf
    ('Betrieb', '4fb2801b6ab7ae20', 'ui_group', 'Einstellungen', 'tab', T_PUMPE, T_SANFT, 'auf Betrieb'),
    ('Betrieb', '4fb2801b6ab7ae20', 'ui_group', 'Einstellungen', 'name', 'Einstellungen', 'Pumpendrehzahl', 'eindeutiger Gruppenname auf Betrieb'),
    ('Betrieb', '4fb2801b6ab7ae20', 'ui_group', 'Einstellungen', 'width', 18, 17, '17 statt 18 (zwei Gruppen nebeneinander bei 1920)'),
    ('Betrieb', '4fb2801b6ab7ae20', 'ui_group', 'Einstellungen', 'order', 2, 1, 'vor dem Sanftanlauf (links)'),
    ('Betrieb', 'c2a0123d2e2c91f0', 'ui_group', 'Einstellungen', 'name', 'Einstellungen', 'Sanftanlauf', 'eindeutiger Gruppenname auf Betrieb'),
    ('Betrieb', 'c2a0123d2e2c91f0', 'ui_group', 'Einstellungen', 'width', 18, 17, '17 statt 18 (neben der Pumpendrehzahl)'),
    ('Betrieb', '3226b17db86f4510', 'ui_group', 'Hilfe', 'name', 'Hilfe', 'Hilfe Sanftanlauf', 'eindeutig und sprechend'),
    ('Betrieb', '3226b17db86f4510', 'ui_group', 'Hilfe', 'width', 18, 17, '17 statt 18'),
    ('Betrieb', '3d8e357b01de57ff', 'ui_chart', '', 'width', 11, 10, 'Pumpendrehzahl Diagramm 10 (Gruppe 17)'),
    ('Betrieb', 'b22da9fe52b286cf', 'ui_text', 'chat legend', 'width', 11, 10, 'Legende 10 (Gruppe 17)'),
    ('Betrieb', '37ae6fb47a326b5e', 'ui_chart', 'SS chart', 'width', 12, 11, 'Sanftanlauf Diagramm 11 (Gruppe 17)'),
    ('Betrieb', 'c48cd6bad07ce428', 'ui_chart', 'SS chart', 'width', 12, 11, 'Sanftanlauf Diagramm 11 (Gruppe 17)'),
    ('Betrieb', '088968fcdf03a215', 'ui_text', 'spacer 1', 'width', 17, 16, 'Kopfzeile der Hilfe: Leerfeld + Schliessen-Knopf = 17'),
    ('Betrieb', '8b7c9a76f8ddca81', 'ui_template', '', 'width', 18, 17, 'Bild der Hilfe (700 px) in Gruppe 17'),
    # ---- Auswertung: Temperaturen | Gradtage nebeneinander
    ('Auswertung', 'fdd93dca20acdfce', 'ui_group', 'Help', 'name', 'Help', 'Hilfe Temperaturen', 'eindeutiger Gruppenname auf Auswertung'),
    ('Auswertung', 'fdd93dca20acdfce', 'ui_group', 'Help', 'width', '13', '17', '17 wie alle Gruppen der Seite (Masonry-Falle)'),
    ('Auswertung', 'fdd93dca20acdfce', 'ui_group', 'Help', 'order', 1, 4, 'Hilfen ans Ende'),
    ('Auswertung', 'e374621a9f5ac0d6', 'ui_group', 'Wassertemperatur', 'width', '18', '17', '17 statt 18 (zwei Gruppen nebeneinander bei 1920)'),
    ('Auswertung', '87be08e6a82ef6a0', 'ui_group', 'Degree days information', 'tab', T_GRAD, T_TEMP, 'auf Auswertung'),
    ('Auswertung', '87be08e6a82ef6a0', 'ui_group', 'Degree days information', 'width', 18, 17, '17 statt 18'),
    ('Auswertung', '87be08e6a82ef6a0', 'ui_group', 'Degree days information', 'order', 2, 3, 'neben den Temperaturen'),
    ('Auswertung', '21f562f418c1ac52', 'ui_group', 'Help', 'tab', T_GRAD, T_TEMP, 'auf Auswertung'),
    ('Auswertung', '21f562f418c1ac52', 'ui_group', 'Help', 'name', 'Help', 'Hilfe Gradtage', 'eindeutiger Gruppenname auf Auswertung'),
    ('Auswertung', '21f562f418c1ac52', 'ui_group', 'Help', 'width', '13', '17', '17 wie alle Gruppen der Seite (Masonry-Falle)'),
    ('Auswertung', '21f562f418c1ac52', 'ui_group', 'Help', 'order', 1, 5, 'Hilfen ans Ende'),
    ('Auswertung', '848fa7aade4f22a3', 'ui_template', 'style [Temp]', 'width', 15, 14, 'Kopfzeile: Balken 14 + Hilfe 2 + Leerfeld 1 = 17'),
    ('Auswertung', 'a1c0b0000c0f0012', 'ui_chart', 'COP Heizen', 'width', 18, 17, 'Diagramm 17 (Gruppe 17)'),
    ('Auswertung', '9802bf01ebf45d28', 'ui_chart', 'Water HEAT', 'width', 18, 17, 'Diagramm 17 (Gruppe 17)'),
    ('Auswertung', '8cb1aceef81045bd', 'ui_chart', 'Room Temperature', 'width', 18, 17, 'Diagramm 17 (Gruppe 17)'),
    ('Auswertung', 'a1c0b0000c0f0043', 'ui_chart', 'Außentemperatur', 'width', 18, 17, 'Diagramm 17 (Gruppe 17)'),
    ('Auswertung', 'a1c0b0000c0f0031', 'ui_text', 'kWh pro Gradtag', 'width', 15, 14, 'Kopfzeile: Kennzahl 14 + Hilfe 2 + Leerfeld 1 = 17'),
    ('Auswertung', '4eaa2cfa2749c551', 'ui_chart', 'kWh + Degree Days (31d)', 'width', 18, 17, 'Diagramm 17 (Gruppe 17)'),
    ('Auswertung', '2ee679408e4ccc6f', 'ui_chart', 'kWh + Degree Days (24h)', 'width', 18, 17, 'Diagramm 17 (Gruppe 17)'),
    ('Auswertung', 'b8b756f628b474fb', 'ui_text', 'spacer 1', 'width', 12, 16, 'Kopfzeile der Hilfe: Leerfeld + Schliessen-Knopf = 17'),
    ('Auswertung', '56de4e61c43e26ae', 'ui_template', 'Line - Instructions text', 'width', 13, 17, 'Hilfetext ueber die ganze Gruppe'),
    ('Auswertung', 'f0770b3465c919d7', 'ui_text', 'spacer 1', 'width', 12, 16, 'Kopfzeile der Hilfe: Leerfeld + Schliessen-Knopf = 17'),
    ('Auswertung', 'a19ced7de80acf30', 'ui_template', 'Line - Instructions text', 'width', 13, 17, 'Hilfetext ueber die ganze Gruppe'),
]


def _gs(show=None, hide=None, first="show"):
    """Nutzlast {"group":{...}} genau so serialisiert wie im Export (Reihenfolge show/hide wie im Original)"""
    d = {}
    for k in ((("show", show), ("hide", hide)) if first == "show" else (("hide", hide), ("show", show))):
        if k[1] is not None:
            d[k[0]] = k[1]
    return json.dumps({"group": d}, ensure_ascii=False, separators=(",", ":"))


# Verweise: (Seite, Knoten-ID, Typ, Feld, Art, alt, neu, Grund); Art "ganz" = ganzer Wert, "teil" = Textstelle (genau einmal vorhanden)
_K = "Knopf/Inject -> ui_control (Gruppe ein/aus)"
VERWEISE = [
    # Heizung
    ('Heizung', 'be48f3104249b8a0', 'ui_button', 'payload', 'ganz', _gs(["Heizkurve_Hilfe"], ["CCC_Graph"]), _gs(["Heizung_Hilfe_Heizkurve"], ["CCC_Graph"]), 'Knopf Hilfe (Heizkurve)'),
    ('Heizung', 'b33b45b8a4e1398b', 'ui_button', 'payload', 'ganz', _gs(["CCC_Graph"], ["Heizkurve_Hilfe"], "hide"), _gs(["CCC_Graph"], ["Heizung_Hilfe_Heizkurve"], "hide"), 'Hilfe schliessen (Heizkurve; auch bei Verbinden/Seitenwechsel)'),
    ('Heizung', '6701660e3767bf11', 'ui_button', 'payload', 'ganz', _gs(["Heizkurve_Zone1"], ["Heizkurve_Zone2", "Heizkurve_Hilfe"], "hide"), _gs(["Heizung_Heizkurve"], ["Heizkurve_Zone2", "Heizung_Hilfe_Heizkurve"], "hide"), 'Knopf Zone 1 (Heizkurve, ausgeblendet)'),
    ('Heizung', 'd3c561cca61a4e6e', 'ui_button', 'payload', 'ganz', _gs(["Heizkurve_Zone2"], ["Heizkurve_Zone1", "Heizkurve_Hilfe"], "hide"), _gs(["Heizkurve_Zone2"], ["Heizung_Heizkurve", "Heizung_Hilfe_Heizkurve"], "hide"), 'Knopf Zone 2 (Heizkurve, ausgeblendet)'),
    ('Heizung', 'ad4e277358b19235', 'ui_button', 'payload', 'ganz', _gs(["Raumregelung_Hilfe"], ["Raumregelung_Zone1", "Raumregelung_Zone2", "Raumregelung_Automatisierungen"]), _gs(["Heizung_Hilfe_Raumregelung"], ["Heizung_Raumregelung", "Raumregelung_Zone2", "Heizung_Automatisierungen"]), 'Knopf Hilfe (Raumregelung)'),
    ('Heizung', '56f59b7df09abbf3', 'ui_button', 'payload', 'ganz', _gs(["Raumregelung_Zone1"], ["Raumregelung_Hilfe", "Raumregelung_Automatisierungen"], "hide"), _gs(["Heizung_Raumregelung"], ["Heizung_Hilfe_Raumregelung", "Heizung_Automatisierungen"], "hide"), 'Hilfe schliessen (Raumregelung; auch bei Verbinden/Seitenwechsel)'),
    ('Heizung', '3c3c8472da1fb85a', 'inject', 'payload', 'ganz', _gs(None, ["Raumregelung_Hilfe"]), _gs(None, ["Heizung_Hilfe_Raumregelung"]), 'Inject (deaktiviert)'),
    ('Heizung', '0fa2e5caff3f31a9', 'ui_button', 'payload', 'ganz', _gs(["Raumregelung_Automatisierungen"], ["Raumregelung_Zone1", "Raumregelung_Zone2", "Raumregelung_Hilfe"], "hide"), _gs(["Heizung_Automatisierungen"], ["Heizung_Raumregelung", "Raumregelung_Zone2", "Heizung_Hilfe_Raumregelung"], "hide"), 'Knopf Automatisierung'),
    ('Heizung', '3d5514180bd61860', 'ui_button', 'payload', 'ganz', _gs(["Raumregelung_Zone1"], ["Raumregelung_Zone2", "Raumregelung_Hilfe", "Raumregelung_Automatisierungen"], "hide"), _gs(["Heizung_Raumregelung"], ["Raumregelung_Zone2", "Heizung_Hilfe_Raumregelung", "Heizung_Automatisierungen"], "hide"), 'Knopf Zone 1 (Rueckweg aus den Automatisierungen)'),
    ('Heizung', '84e3a6d29296dc42', 'ui_button', 'payload', 'ganz', _gs(["Raumregelung_Zone2"], ["Raumregelung_Zone1", "Raumregelung_Hilfe", "Raumregelung_Automatisierungen"], "hide"), _gs(["Raumregelung_Zone2"], ["Heizung_Raumregelung", "Heizung_Hilfe_Raumregelung", "Heizung_Automatisierungen"], "hide"), 'Knopf Zone 2 (Raumregelung, ausgeblendet)'),
    # Betrieb
    ('Betrieb', '75571074f2ac434c', 'ui_button', 'payload', 'ganz', _gs(["Sanftanlauf_Hilfe"], ["Sanftanlauf_Einstellungen", "Sanftanlauf_Erweitert", "Sanftanlauf_Leisemodus-Zusatz_Einstellungen"]), _gs(["Betrieb_Hilfe_Sanftanlauf"], ["Betrieb_Sanftanlauf", "Betrieb_Erweitert", "Betrieb_Leisemodus-Zusatz_Einstellungen"]), 'Knopf Hilfe (Sanftanlauf)'),
    ('Betrieb', 'c652e74baa241047', 'ui_button', 'payload', 'ganz', _gs(["Sanftanlauf_Einstellungen"], ["Sanftanlauf_Hilfe", "Sanftanlauf_Erweitert", "Sanftanlauf_Leisemodus-Zusatz_Einstellungen"], "hide"), _gs(["Betrieb_Sanftanlauf"], ["Betrieb_Hilfe_Sanftanlauf", "Betrieb_Erweitert", "Betrieb_Leisemodus-Zusatz_Einstellungen"], "hide"), 'Hilfe schliessen (Sanftanlauf; auch bei Verbinden/Seitenwechsel)'),
    ('Betrieb', 'e16790ec4eb50d6c', 'inject', 'payload', 'ganz', _gs(None, ["Sanftanlauf_Hilfe"]), _gs(None, ["Betrieb_Hilfe_Sanftanlauf"]), 'Inject (deaktiviert)'),
    ('Betrieb', 'b643e9d5e036f4ee', 'ui_button', 'payload', 'ganz', _gs(["Sanftanlauf_Erweitert"], ["Sanftanlauf_Leisemodus-Zusatz_Einstellungen"]), _gs(["Betrieb_Erweitert"], ["Betrieb_Leisemodus-Zusatz_Einstellungen"]), 'Knopf Erweitert zeigen'),
    ('Betrieb', 'c3c9902496136a46', 'ui_button', 'payload', 'ganz', _gs(["Sanftanlauf_Einstellungen"], ["Sanftanlauf_Erweitert"]), _gs(["Betrieb_Sanftanlauf"], ["Betrieb_Erweitert"]), 'Knopf Erweitert schliessen'),
    ('Betrieb', '3b06cb6fe4aba512', 'ui_button', 'payload', 'ganz', _gs(["Sanftanlauf_Leisemodus-Zusatz_Einstellungen"], ["Sanftanlauf_Erweitert", "Sanftanlauf_Hilfe"]), _gs(["Betrieb_Leisemodus-Zusatz_Einstellungen"], ["Betrieb_Erweitert", "Betrieb_Hilfe_Sanftanlauf"]), 'Knopf Leisemodus-Zusatz zeigen'),
    ('Betrieb', 'd7cc3d6e4843a8ad', 'ui_button', 'payload', 'ganz', _gs(["Sanftanlauf_Einstellungen"], ["Sanftanlauf_Leisemodus-Zusatz_Einstellungen", "Sanftanlauf_Erweitert", "Sanftanlauf_Hilfe"], "hide"), _gs(["Betrieb_Sanftanlauf"], ["Betrieb_Leisemodus-Zusatz_Einstellungen", "Betrieb_Erweitert", "Betrieb_Hilfe_Sanftanlauf"], "hide"), 'Knopf Leisemodus-Zusatz schliessen'),
    # Auswertung
    ('Auswertung', '93759ef7c600fe14', 'ui_button', 'payload', 'ganz', _gs(["Temperaturen_Help"]), _gs(["Auswertung_Hilfe_Temperaturen"]), 'Knopf Hilfe (Temperaturen)'),
    ('Auswertung', '7d8b052fee984598', 'ui_button', 'payload', 'ganz', _gs(None, ["Temperaturen_Help"]), _gs(None, ["Auswertung_Hilfe_Temperaturen"]), 'Hilfe schliessen (Temperaturen; auch bei Verbinden/Seitenwechsel)'),
    ('Auswertung', '64e1f8f65ebe4711', 'ui_button', 'payload', 'ganz', _gs(["Gradtage_Help"]), _gs(["Auswertung_Hilfe_Gradtage"]), 'Knopf Hilfe (Gradtage)'),
    ('Auswertung', 'a39a1002bb65b329', 'ui_button', 'payload', 'ganz', _gs(None, ["Gradtage_Help"]), _gs(None, ["Auswertung_Hilfe_Gradtage"]), 'Hilfe schliessen (Gradtage; auch bei Verbinden/Seitenwechsel)'),
]
_CB = {"type": "checkbox", "required": False, "rows": None}
MENU_FORM = "e35b7df78bc6f722"            # SYSTEM > MENU-KONFIGURATION, ui_form "group - Main tabs": Werte = Tabnamen (ui_control {"tabs":{"show"/"hide"}})
MENU_ALT = [("EINSTELLUNGEN", "Einstellungen"), ("Heizkurve", "Heizkurve"), ("Raumregelung", "Raumregelung"), ("SANFTANLAUF", "Sanftanlauf"),
            ("PUMPENDREHZAHL", "Pumpendrehzahl"), ("ZEITPLAN", "Zeitplan"), ("TEMPERATUREN", "Temperaturen"), ("EFFIZIENZ", "Effizienz"),
            ("GRADTAGE", "Gradtage"), ("OPTIMIERUNG", "Optimierung")]
MENU_NEU = [("EINSTELLUNGEN", "Einstellungen"), ("HEIZUNG", "Heizung"), ("BETRIEB", "Betrieb"), ("ZEITPLAN", "Zeitplan"),
            ("AUSWERTUNG", "Auswertung"), ("EFFIZIENZ", "Effizienz"), ("OPTIMIERUNG", "Optimierung")]
VERWEISE += [
    ('SYSTEM (Menü)', MENU_FORM, 'ui_form', 'options', 'ganz', [dict({"label": l, "value": v}, **_CB) for l, v in MENU_ALT],
     [dict({"label": l, "value": v}, **_CB) for l, v in MENU_NEU], 'Menue-Konfiguration: Haken je sichtbarem Tab'),
    ('SYSTEM (Menü)', MENU_FORM, 'ui_form', 'formValue', 'ganz', {v: False for _l, v in MENU_ALT}, {v: False for _l, v in MENU_NEU}, 'Startwerte der Haken'),
]
STORE = "5a44b5cc5e9f4844"                # WP System, "Store settings": spielt die gespeicherte Menue-Konfiguration (global GUI) bei Verbinden wieder ab
FIX_ALT = ("    var map = {SETTINGS: 'Einstellungen', CCC: 'Heizkurve', RTC: 'Raumregelung', SOFTSTART: 'Sanftanlauf',\n"
           "               Pumpspeed: 'Pumpendrehzahl', SCHEDULER: 'Zeitplan', TEMPERATURES: 'Temperaturen',\n"
           "               EFFICIENCY: 'Effizienz', Degree_days: 'Gradtage'};\n"
           "    var p = {};\n"
           "    Object.keys(m.payload).forEach(function (k) {\n"
           "        if (k === 'COOL' || k === 'Solar²DHW') { return; }\n"
           "        p[map[k] || k] = m.payload[k];\n"
           "    });\n")
FIX_NEU = ("    // zusammengelegte Seiten (13.10.2026): alte Schluessel -> neue Tabnamen; die alten Tabs sind leer und ausgeblendet und duerfen nie wieder eingeblendet werden\n"
           "    var map = {SETTINGS: 'Einstellungen', CCC: 'Heizung', RTC: 'Heizung', SOFTSTART: 'Betrieb',\n"
           "               Pumpspeed: 'Betrieb', SCHEDULER: 'Zeitplan', TEMPERATURES: 'Auswertung',\n"
           "               EFFICIENCY: 'Effizienz', Degree_days: 'Auswertung',\n"
           "               Heizkurve: 'Heizung', Raumregelung: 'Heizung', Sanftanlauf: 'Betrieb', Pumpendrehzahl: 'Betrieb',\n"
           "               Temperaturen: 'Auswertung', Gradtage: 'Auswertung'};\n"
           "    var p = {};\n"
           "    Object.keys(m.payload).forEach(function (k) {\n"
           "        if (k === 'COOL' || k === 'Solar²DHW') { return; }\n"
           "        var t = map[k] || k;\n"
           "        p[t] = p[t] === true || m.payload[k];         // zusammengelegt: sichtbar, wenn eine der alten Seiten sichtbar war\n"
           "    });\n")
VERWEISE += [('SYSTEM (Menü)', STORE, 'function', 'func', 'teil', FIX_ALT, FIX_NEU,
              'gespeicherte Menue-Konfiguration auf die neuen Tabnamen abbilden (sonst blendet das Wiederabspielen die leeren alten Tabs wieder ein)')]

# ---------------------------------------------------------------- Layout: sichtbare Gruppen beim Oeffnen und alle Umschalt-Zustaende (Knoepfe)
_SYS = ("MQTT-Sensoren", "1-Wire-Sensoren", "P1-Einrichtung", "HARDWARE-INFORMATIONEN", "MQTT", "MENU", "SYSTEMZUSTAND", "ABOUT", "EINSTELLUNGEN", "Help_Sensors")
VERSTECKT_ALT = {"Heizkurve": ("Hilfe",), "Raumregelung": ("Automatisierungen", "Hilfe"), "Sanftanlauf": ("Erweitert", "Leisemodus-Zusatz Einstellungen", "Hilfe"),
                 "Zeitplan": ("Bedingungen", "Hilfe", "Benachrichtigung", "function_actions"), "Temperaturen": ("Help",), "Effizienz": ("Help",), "Gradtage": ("Help",),
                 "SYSTEM": _SYS}
VERSTECKT_NEU = {"Heizung": ("Automatisierungen", "Hilfe Raumregelung", "Hilfe Heizkurve"), "Betrieb": ("Erweitert", "Leisemodus-Zusatz Einstellungen", "Hilfe Sanftanlauf"),
                 "Auswertung": ("Hilfe Temperaturen", "Hilfe Gradtage"), "Zeitplan": VERSTECKT_ALT["Zeitplan"], "Effizienz": ("Help",), "SYSTEM": _SYS}
# sichtbare Gruppen je Umschalt-Zustand der neuen Seiten (aus den Knopf-Nutzlasten oben)
ZUSTAENDE = {
    "Heizung": [("Heizkurve", r) for r in ("Raumregelung", "Automatisierungen", "Hilfe Raumregelung")] +
               [("Heizkurve", r, "Hilfe Heizkurve") for r in ("Raumregelung", "Automatisierungen", "Hilfe Raumregelung")],
    "Betrieb": [("Pumpendrehzahl", "Sanftanlauf"), ("Pumpendrehzahl", "Sanftanlauf", "Erweitert"),
                ("Pumpendrehzahl", "Sanftanlauf", "Leisemodus-Zusatz Einstellungen"), ("Pumpendrehzahl", "Hilfe Sanftanlauf")],
    "Auswertung": [("Wassertemperatur", "Degree days information") + h for r in range(3) for h in itertools.combinations(("Hilfe Temperaturen", "Hilfe Gradtage"), r)],
}
# Live-Vermessung 13.10.2026 nach Teil A+B (15:22), 1920 px
LIVE_1920 = {"Übersicht": 714, "Einstellungen": 714, "Pumpendrehzahl": 552, "Heizkurve": 930, "Raumregelung": 930, "Sanftanlauf": 876, "Zeitplan": 768,
             "Temperaturen": 1200, "Effizienz": 1254, "Gradtage": 768, "Optimierung": 822, "Optimierer": 1038, "Wärmefahrplan": 660, "Quiet-Messwerte": 552,
             "Daten & Güte": 1254, "SYSTEM": 930}


# ---------------------------------------------------------------- Datei: Format genau erkennen (Rueckbau byte-gleich)
FORMATE = ({"separators": (",", ":")}, {}, {"indent": 4})       # kompakt, json-Standard (", " / ": "), eingerueckt


def laden(path):
    """Flows und Schreibformat der Datei: das json.dumps-Format, das die Datei exakt wieder erzeugt (sonst kompakt bzw. eingerueckt)"""
    raw = open(path, encoding="utf-8").read()
    data = json.loads(raw)
    flows = data["flows"] if isinstance(data, dict) and "flows" in data else data      # Admin-API v2 {"rev","flows"}: geschrieben wird die Liste
    for kw in FORMATE:
        s = json.dumps(flows, ensure_ascii=False, **kw)
        if raw in (s, s + "\n"):
            return flows, (kw, raw.endswith("\n"))
    return flows, ({"separators": (",", ":")} if raw.lstrip().startswith("[{") else {"indent": 4}, False)


def schreiben(path, flows, fmt):
    kw, nl = fmt
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(flows, ensure_ascii=False, **kw) + ("\n" if nl else ""))


# ---------------------------------------------------------------- Pfade in Knoten
def _get(n, feld):
    return n.get(feld, "\0fehlt")


def plan(flows):
    """Konkrete Aenderungen [(seite, id, feld, alt, neu, grund)] (ganze Werte); Abbruch bei unerwartetem Altwert"""
    N = {n["id"]: n for n in flows}
    out, fehler, schon = [], [], 0
    for (seite, i, typ, name, key, alt, neu, grund) in AENDERUNGEN:
        n = N.get(i)
        if n is None:
            fehler.append("%s: Knoten %s (%s) fehlt" % (seite, i, name))
            continue
        if n["type"] != typ:
            fehler.append("%s: Knoten %s hat Typ %s statt %s" % (seite, i, n["type"], typ))
            continue
        cur = n.get(key)
        if cur == neu and type(cur) is type(neu):
            schon += 1
            continue
        if cur != alt or type(cur) is not type(alt):
            fehler.append("%s: %s %s.%s ist %r, erwartet %r (Live-Flow geaendert?)" % (seite, i, name, key, cur, alt))
            continue
        out.append((seite, i, key, alt, neu, grund))
    for (seite, i, typ, feld, art, alt, neu, grund) in VERWEISE:
        n = N.get(i)
        if n is None or n["type"] != typ:
            fehler.append("%s: Verweis-Knoten %s (%s) fehlt oder hat einen anderen Typ" % (seite, i, typ))
            continue
        cur = _get(n, feld)
        if art == "ganz":
            if cur == neu:
                schon += 1
                continue
            if cur != alt:
                fehler.append("%s: %s.%s ist %s, erwartet %s (Live-Flow geaendert?)" % (seite, i, feld, kurz(cur), kurz(alt)))
                continue
            out.append((seite, i, feld, copy.deepcopy(cur), copy.deepcopy(neu), grund))     # Altwert so wie er in der Datei steht (Rueckbau byte-gleich)
        else:
            if not isinstance(cur, str):
                fehler.append("%s: %s.%s fehlt" % (seite, i, feld))
                continue
            if cur.count(alt) == 0 and cur.count(neu) == 1:
                schon += 1
                continue
            if cur.count(alt) != 1:
                fehler.append("%s: %s.%s enthaelt die erwartete Textstelle %dx statt 1x (Live-Flow geaendert?)" % (seite, i, feld, cur.count(alt)))
                continue
            out.append((seite, i, feld, cur, cur.replace(alt, neu), grund))
    if fehler:
        raise Abbruch("Erwartete Ausgangswerte stimmen nicht:\n  " + "\n  ".join(fehler))
    return out, schon


def anwenden(flows, changes):
    neu = copy.deepcopy(flows)
    N = {n["id"]: n for n in neu}
    for (_s, i, key, _alt, wert, _g) in changes:
        N[i][key] = copy.deepcopy(wert)
    return neu


def _seite_von(tab_id):
    for name, (car, _alt, rest) in SEITEN.items():
        if tab_id == car or tab_id in rest:
            return name
    return None


def whitelist(alt, neu, rueckbau=None):
    """Unabhaengige Pruefung des Ergebnisses gegen das Original; Rueckgabe: geaenderte IDs, Zaehler je Typ.
    rueckbau: {(id, feld): Zielwert} aus der Sicherung - dann sind nur genau diese Werte erlaubt."""
    fehler = []
    if [n["id"] for n in alt] != [n["id"] for n in neu]:
        raise Abbruch("Whitelist: Knoten hinzugefuegt, entfernt oder umsortiert")
    Bn = {n["id"]: n for n in neu}
    ref = {}
    for (_s, i, _t, feld, art, a, b, _g) in VERWEISE:
        ref.setdefault(i, {})[feld] = (art, a, b)
    tab_namen = {car: (altname, neuname) for neuname, (car, altname, _r) in SEITEN.items()}
    geaendert, typen = [], {}
    for n0 in alt:
        n1 = Bn[n0["id"]]
        if n0 == n1:
            continue
        i, t = n0["id"], n0["type"]
        keys = {k for k in set(n0) | set(n1) if n0.get(k, "\0fehlt") != n1.get(k, "\0fehlt")}
        if i.startswith("opt_"):
            fehler.append("%s: opt_*-Knoten veraendert (gehoert zum Generator)" % i)
        if n1["type"] != t:
            fehler.append("%s: Typ geaendert" % i)
        if t == "ui_tab":
            erlaubt = {"name", "hidden"}
            if "name" in keys and (i not in tab_namen or {n0.get("name"), n1.get("name")} != set(tab_namen[i])):
                fehler.append("%s: Tabname nur bei den Traegern und nur alt <-> neu" % i)
            if "hidden" in keys and (i not in EINGEGLIEDERT or {n0.get("hidden"), n1.get("hidden")} != {False, True}):
                fehler.append("%s: ausblenden nur bei den eingegliederten Tabs" % i)
            if rueckbau is None and n1.get("hidden") and UKP.Modell(neu).seiten_gruppen(i):
                fehler.append("%s: ausgeblendeter Tab hat noch sichtbare Gruppen" % i)
        elif t == "ui_group":
            erlaubt = {"tab", "name", "width", "order"}
            if "tab" in keys and (_seite_von(n0.get("tab")) is None or _seite_von(n0.get("tab")) != _seite_von(n1.get("tab"))):
                fehler.append("%s: Gruppe nur innerhalb derselben neuen Seite verschieben" % i)
        elif t.startswith("ui_") and n0.get("group") and i not in ref:
            erlaubt = {"width", "height", "order"}
        elif i in ref:
            erlaubt = set(ref[i]) | ({"width", "height", "order"} if t.startswith("ui_") and n0.get("group") else set())
            for feld in keys & erlaubt:
                art, a, b = ref[i][feld]
                v0, v1 = n0.get(feld), n1.get(feld)
                if art == "ganz":
                    ok = {json.dumps(v0, sort_keys=True), json.dumps(v1, sort_keys=True)} == {json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True)}
                    if ok and feld == "payload" and isinstance(v0, str):          # unabhaengig nachgerechnet: nur Schluessel ersetzt
                        hin = SCHLUESSEL_RE.sub(lambda m: SCHLUESSEL[m.group(1)], v0)
                        inv = {v: k for k, v in SCHLUESSEL.items()}
                        her = re.sub(_GRENZE_L + "(" + "|".join(re.escape(k) for k in sorted(inv, key=len, reverse=True)) + ")" + _GRENZE_R, lambda m: inv[m.group(1)], v0)
                        ok = v1 in (hin, her)
                else:
                    ok = isinstance(v0, str) and isinstance(v1, str) and (v1 == v0.replace(a, b) or v1 == v0.replace(b, a)) and (v0.count(a) + v0.count(b)) == 1
                if not ok:
                    fehler.append("%s.%s: Verweis anders als geplant umgeschrieben" % (i, feld))
        else:
            erlaubt = set()
        bad = keys - erlaubt
        if bad:
            fehler.append("%s (%s): nicht erlaubte Schluessel %s" % (i, t, sorted(bad)))
        if rueckbau is not None:
            for k in keys:
                if (i, k) not in rueckbau or n1.get(k) != rueckbau[(i, k)]:
                    fehler.append("%s.%s: Rueckbau nur auf den gesicherten Wert" % (i, k))
        geaendert.append(i)
        typen[t] = typen.get(t, 0) + 1
    if fehler:
        raise Abbruch("Whitelist verletzt:\n  " + "\n  ".join(fehler))
    return geaendert, typen


# ---------------------------------------------------------------- Pruefungen der Verweise (auch fuer den Test)
GRUPPEN_RE = re.compile(r'"(?:show|hide|open|close)"\s*:\s*\[([^\]]*)\]')


def gruppen_schluessel(flows):
    """{"<Tab>_<Gruppe>": Gruppen-ID} wie das Dashboard sie bildet (Leerzeichen -> _)"""
    tabs = {n["id"]: n["name"] for n in flows if n["type"] == "ui_tab"}
    out = {}
    for g in flows:
        if g["type"] == "ui_group" and g.get("tab") in tabs:
            out.setdefault(us(tabs[g["tab"]]) + "_" + us(g["name"]), []).append(g["id"])
    return out


def verweis_stellen(flows):
    """alle Gruppen-Schluessel in ui_control-Nutzlasten {"group":{"show"/"hide":[...]}}: [(id, feld, schluessel)]"""
    out = []
    for n in flows:
        if n["type"] in ("ui_tab", "ui_group", "tab", "comment"):
            continue
        for feld, v in n.items():
            if feld in ("name", "info", "label", "tooltip") or not isinstance(v, (str, list)):
                continue
            texte = [v] if isinstance(v, str) else [r.get("to") for r in v if isinstance(r, dict) and isinstance(r.get("to"), str)]
            for s in texte:
                if '"group"' not in s:
                    continue
                for m in GRUPPEN_RE.finditer(s):
                    for k in re.findall(r'"([^"]*)"', m.group(1)):
                        out.append((n["id"], feld, k))
    return out


def tab_verweise(flows):
    """Tabnamen als Werte: Menue-Formular (Optionen/Startwerte), Ziele von fixTabs, {"tabs":{"show"/"hide"}}, {"tab": name}: [(id, wo, name)]"""
    out = []
    N = {n["id"]: n for n in flows}
    f = N.get(MENU_FORM)
    if f:
        out += [(MENU_FORM, "options", o["value"]) for o in f.get("options", [])] + [(MENU_FORM, "formValue", k) for k in f.get("formValue", {})]
    s = N.get(STORE)
    if s:
        m = re.search(r"var map = \{([^}]*)\}", s.get("func", ""))
        out += [(STORE, "fixTabs", v) for v in re.findall(r":\s*'([^']*)'", m.group(1))] if m else []
    for n in flows:
        for feld in ("payload", "op1", "op2"):
            v = n.get(feld)
            if isinstance(v, str) and '"tabs"' in v:
                for m in re.finditer(r'"(?:show|hide|enable|disable)"\s*:\s*\[([^\]]*)\]', v):
                    out += [(n["id"], feld, k) for k in re.findall(r'"([^"]*)"', m.group(1))]
            if isinstance(v, str) and re.match(r'\s*\{\s*"tab"\s*:', v):
                out.append((n["id"], feld, json.loads(v)["tab"]))
    return out


# ---------------------------------------------------------------- Bericht
def seiten_hoehen(flows, versteckt):
    M = UKP.Modell(flows)
    out = []
    for t in M.tabs:
        if t.get("hidden") or not M.seiten_gruppen(t["id"]):
            continue
        r = {W: M.seite(t, versteckt.get(t["name"], ()), W) for W in (1024, 1920, 2560)}
        out.append((t["name"], t["id"], r))
    return out


def bericht(alt, neu, changes, schon, ids, typen):
    h0 = {name: r for name, _i, r in seiten_hoehen(alt, VERSTECKT_ALT)}
    h1 = seiten_hoehen(neu, VERSTECKT_NEU)
    print("Sichtbare Seiten: %d -> %d   (Hoehe = unterste Kartenkante, Layout-Modell aus ui_kompakt_patch.py; Optimierer-Seiten mit festen Starthoehen, Teil A aendert sie)" % (len(h0), len(h1)))
    print("Seite            1920 px vorher -> nachher                          1024 px   2560 px   waagrecht 1024   Ueberlappung")
    for name, tid, r in h1:
        if name in SEITEN and SEITEN[name][1] in h0:
            car, altname, rest = SEITEN[name]
            teile = [altname] + [EINGEGLIEDERT[x] for x in rest]
            vor = " + ".join("%s %d" % (p, h0[p][1920][0]) for p in teile if p in h0)
        else:
            vor = "%d" % h0[name][1920][0] if name in h0 else "(schon zusammengelegt)"
        print("%-16s %-40s -> %5d   %5d     %5d     %-14s  %s" % (name, vor, r[1920][0], r[1024][0], r[2560][0], "ja" if r[1024][1] else "nein",
                                                                   r[1920][2] or "keine"))
    print("\nAenderungen je Seite (Grund: Anzahl):")
    for seite in list(SEITEN) + ["SYSTEM (Menü)"]:
        cs = [c for c in changes if c[0] == seite]
        if not cs:
            continue
        grp = {}
        for c in cs:
            grp.setdefault(c[5], []).append(c)
        print("  %s: %d Werte" % (seite, len(cs)))
        for grund, lst in grp.items():
            print("    - %s: %d (%s)" % (grund, len(lst), ", ".join("%s %s %s->%s" % (c[1][:8], c[2], kurz(c[3]), kurz(c[4])) for c in lst[:4]) + (" ..." if len(lst) > 4 else "")))
    print("\nUmgeschriebene Verweise (%d Knoten):" % len({v[1] for v in VERWEISE}))
    for (seite, i, typ, feld, art, a, b, grund) in VERWEISE:
        if feld == "payload":
            ka = [k for k in re.findall(r'"([^"]+)"', a) if k not in ("group", "show", "hide")]
            kb = [k for k in re.findall(r'"([^"]+)"', b) if k not in ("group", "show", "hide")]
            wechsel = ", ".join("%s -> %s" % (x, y) for x, y in zip(ka, kb) if x != y)
            print("  %-16s %-10s %-9s %s  [%s]" % (i, typ, feld, wechsel, grund))
        elif feld in ("options", "formValue"):
            print("  %-16s %-10s %-9s Tabs %s -> %s  [%s]" % (i, typ, feld, "/".join(v for _l, v in MENU_ALT), "/".join(v for _l, v in MENU_NEU), grund))
        else:
            print("  %-16s %-10s %-9s fixTabs: CCC/RTC/Heizkurve/Raumregelung -> Heizung, SOFTSTART/Pumpspeed/Sanftanlauf/Pumpendrehzahl -> Betrieb, "
                  "TEMPERATURES/Degree_days/Temperaturen/Gradtage -> Auswertung, ODER-Verknuepfung  [%s]" % (i, typ, feld, grund))
    print("  unveraendert (Ziel fehlt schon vor dem Patch): %s; Knotennamen 'Show/Hide Sanftanlauf_Erweitert tab' (nur Beschriftung im Editor)" % ", ".join(sorted(VERWAIST)))
    print("\nWhitelist-Pruefung: OK. Geaenderte Knoten: %d (%s). Bereits umgesetzt (uebersprungen): %d." % (
        len(ids), ", ".join("%s %d" % kv for kv in sorted(typen.items())), schon))


# ---------------------------------------------------------------- Aufruf
def main():
    ap = argparse.ArgumentParser(description="Dashboard-Tabs zusammenlegen (Darstellung + abhaengige Verweise)")
    ap.add_argument("flows")
    m = ap.add_mutually_exclusive_group(required=True)
    m.add_argument("--dry-run", action="store_true")
    m.add_argument("--apply", action="store_true")
    m.add_argument("--revert", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--sicherung")
    a = ap.parse_args()
    flows, fmt = laden(a.flows)
    try:
        if a.revert:
            if not a.sicherung:
                raise Abbruch("--revert braucht --sicherung <datei>")
            S = json.load(open(a.sicherung, encoding="utf-8"))
            N = {n["id"]: n for n in flows}
            rueck, fehler = [], []
            for c in S["aenderungen"]:
                n = N.get(c["id"])
                cur = n.get(c["key"], "\0fehlt") if n else "\0fehlt"
                if cur == c["alt"] and type(cur) is type(c["alt"]):
                    continue
                if cur != c["neu"] or type(cur) is not type(c["neu"]):
                    fehler.append("%s.%s ist %s, erwartet der gepatchte Wert" % (c["id"], c["key"], kurz(cur)))
                    continue
                rueck.append((c["seite"], c["id"], c["key"], c["neu"], c["alt"], "Rueckbau"))
            if fehler:
                raise Abbruch("Rueckbau nicht moeglich:\n  " + "\n  ".join(fehler))
            neu = anwenden(flows, rueck)
            ids, typen = whitelist(flows, neu, rueckbau={(c["id"], c["key"]): c["alt"] for c in S["aenderungen"]})
            out = a.out or a.flows.replace(".json", "") + ".zurueck.json"
            schreiben(out, neu, fmt)
            print("Rueckbau: %d Werte zurueckgesetzt, %d Knoten -> %s" % (len(rueck), len(ids), out))
            print("IDS " + ",".join(ids))
            return 0
        changes, schon = plan(flows)
        neu = anwenden(flows, changes)
        ids, typen = whitelist(flows, neu)
        print("tabs_zusammen_patch: %s (%d Knoten), Modus %s" % (a.flows, len(flows), "Probelauf" if a.dry_run else "Anwenden"))
        bericht(flows, neu, changes, schon, ids, typen)
        if a.apply:
            out = a.out or a.flows.replace(".json", "") + ".tabs.json"
            sich = a.sicherung or out.replace(".json", "") + ".sicherung.json"
            schreiben(out, neu, fmt)
            json.dump({"erzeugt": datetime.datetime.now().isoformat(timespec="seconds"), "quelle": os.path.abspath(a.flows), "ziel": os.path.abspath(out),
                       "aenderungen": [{"seite": c[0], "id": c[1], "key": c[2], "alt": c[3], "neu": c[4], "grund": c[5]} for c in changes]},
                      open(sich, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            print("\ngeschrieben: %s\nSicherung:   %s" % (out, sich))
        print("\nIDS " + ",".join(ids))
        return 0
    except Abbruch as e:
        print("ABBRUCH: %s\nNichts geschrieben." % e)
        return 2


if __name__ == "__main__":
    sys.exit(main())

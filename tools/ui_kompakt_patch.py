#!/usr/bin/env python3
"""Kompakteres Dashboard fuer die HeishaMoNR-Kernseiten: aendert auf einer Flow-Datei NUR Darstellungs-Eigenschaften.

Erlaubt (Whitelist, alles andere bricht ab):
  * ui_*-Widgets:  width, height, order, group (nur innerhalb derselben Seite oder in eine Gruppe auf einem VERSTECKTEN Tab = Ausblenden)
  * ui_group:      width, order, disp, collapse, tab (nur auf einen VERSTECKTEN Tab = Ausblenden)
  * Hilfetexte "Line - Instructions text*" (ui_template im Flow WP Help): format (Inhalt unveraendert in <details>), Hoehe
  * ui_base:       site.sizes, nur mit --raster (optionale Stufe 2)
Keine Funktionsknoten, keine Verdrahtung, kein MQTT, keine Topics, keine anderen Formate, keine Knoten neu oder geloescht, keine opt_*-Knoten.

Jede Aenderung steht unten in AENDERUNGEN mit erwartetem Altwert. Weicht die Datei ab (Live-Flow inzwischen anders), bricht das Skript ab.
Ist ein Wert schon neu, wird er uebersprungen (idempotent).

Aufrufe:
  python3 tools/ui_kompakt_patch.py <flows.json> --dry-run   [--hilfe=einklappen|lassen] [--raster]
      Bericht je Seite (was aendert sich, geschaetzte Seitenhoehe vorher/nachher aus Einheiten, 1024/1920/2560 px), Whitelist-Pruefung, geaenderte IDs
  python3 tools/ui_kompakt_patch.py <flows.json> --apply [--out neu.json] [--sicherung datei.json] [--hilfe=...] [--raster]
      schreibt die neue Flow-Datei (Standard <flows>.kompakt.json) und die Sicherung (Standard <out>.sicherung.json), gibt die geaenderten IDs aus
  python3 tools/ui_kompakt_patch.py <flows.json> --revert --sicherung datei.json [--out zurueck.json]
      setzt jede gesicherte Aenderung zurueck (nur wenn der Wert noch dem gepatchten entspricht, sonst Abbruch)
Nur Standardbibliothek.
"""
import argparse
import copy
import datetime
import hashlib
import itertools
import json
import os
import re
import sys

HELP_FLOW = "72f2748729e53ad1"            # Flow "WP Help"
GUI_TAB = "534382cf81d94968"              # versteckter Tab "GUI"
HIDDEN_GRP = "a1c0b0000c0f0020"           # Gruppe "Ausgeblendet (Warmwasser)" auf dem Tab GUI (gibt es seit Phase 1 der UI-Uebersetzung)
UI_BASE = "7d50bb325a65d51d"
RASTER_ALT = {"sx": 48, "sy": 48, "gx": 6, "gy": 6, "cx": 6, "cy": 6, "px": 0, "py": 0}
RASTER_NEU = {"sx": 48, "sy": 40, "gx": 6, "gy": 4, "cx": 6, "cy": 4, "px": 0, "py": 0}
WIDGET_KEYS = {"width", "height", "order", "group"}
GROUP_KEYS = {"width", "order", "disp", "collapse", "tab"}

# Sichtbarkeit der Gruppen beim Oeffnen der Seite (Live-Vermessung 13.10.2026 13:55, 1920x1080); die uebrigen Gruppen erscheinen erst auf Knopfdruck
VERSTECKT = {"Heizkurve": ("Hilfe",), "Raumregelung": ("Automatisierungen", "Hilfe"),
             "Sanftanlauf": ("Erweitert", "Leisemodus-Zusatz Einstellungen", "Hilfe"), "Zeitplan": ("Bedingungen", "Hilfe"),
             "Temperaturen": ("Help",), "Effizienz": ("Help",), "Gradtage": ("Help",),
             "SYSTEM": ("MQTT-Sensoren", "1-Wire-Sensoren", "P1-Einrichtung", "HARDWARE-INFORMATIONEN", "MQTT", "MENU", "SYSTEMZUSTAND",
                        "ABOUT", "EINSTELLUNGEN", "Help_Sensors")}
LIVE_1920 = {"Übersicht": 1254, "Einstellungen": 714, "Pumpendrehzahl": 606, "Heizkurve": 1956, "Raumregelung": 1956, "Sanftanlauf": 984,
             "Zeitplan": 1470, "Temperaturen": 1794, "Effizienz": 3198, "Gradtage": 1146, "SYSTEM": 1146}

# (Seite, Knoten-ID, Typ, Name, Schluessel, alt, neu, Grund)
AENDERUNGEN = [
    # ---- Übersicht
    ('Übersicht', 'bf4af523ba16d457', 'ui_group', 'WÄRMEPUMPE', 'width', '6', '12', 'WÄRMEPUMPE zweispaltig (12 statt 6)'),
    ('Übersicht', '43403f14c1a863a4', 'ui_template', 'Line - Water', 'order', 4, 3, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', 'a1c0b0000c0f0041', 'ui_text', 'Außentemperatur', 'order', 3, 4, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '46b7fe12f60ad08b', 'ui_template', 'Line - Water', 'order', 7, 6, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '354635fe353183fd', 'ui_text', 'Valve position', 'order', 6, 7, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', 'f37c739180bdbc6e', 'ui_template', 'Line - HeatPump', 'order', 23, 9, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '1d51b425fba024d2', 'ui_text', 'Outlet actual', 'order', 9, 10, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', 'f0b7868c48887de4', 'ui_switch', 'Nightreduction', 'order', 24, 11, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '2b04b7dd5ea852f2', 'ui_text', 'text nightreduction', 'order', 25, 12, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '3f05f1c6e437d5d3', 'ui_text', 'nightreduction read', 'order', 26, 13, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '3478273eb4693d84', 'ui_text', 'Inlet actual', 'order', 11, 14, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', 'c66f65978915e688', 'ui_switch', 'Softstart on/off (Home)', 'order', 27, 15, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '1eb00088db267256', 'ui_text', 'SoftStart txt', 'order', 28, 16, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '1b40f688e5fbc5dd', 'ui_text', 'Home - Current correction (SS)', 'order', 29, 17, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '0e09d25e4fd17042', 'ui_gauge', 'Water', 'order', 12, 18, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '91fcc102b422de3b', 'ui_gauge', 'Frequency', 'order', 13, 19, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '592f552754e017f5', 'ui_template', 'Line - Water', 'order', 15, 20, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '79dc18dd1cca1e73', 'ui_text', 'Compressor runtime', 'order', 16, 21, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '1ed98a1d47eb56f0', 'ui_text', 'Fan1', 'order', 17, 22, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '3ac59d9a6138e620', 'ui_text', 'Pump speed', 'order', 14, 23, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '2ae1f0e14435e803', 'ui_text', 'Heizstab intern', 'order', 19, 24, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', 'cb32ff75cb09ea95', 'ui_text', 'Internal heater', 'order', 20, 25, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', 'b629087d36acf89e', 'ui_template', 'style [Home]', 'order', 10, 26, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '9faace07ea16ba4d', 'ui_text', 'Fan2', 'order', 18, 27, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', 'cce68d6f8e62d22a', 'ui_text', 'Heizstab extern', 'order', 21, 28, 'Reihenfolge für zwei Spalten'),
    ('Übersicht', '5ca62cc2d15410db', 'ui_text', 'External heater', 'order', 22, 29, 'Reihenfolge für zwei Spalten'),
    # ---- Einstellungen
    ('Einstellungen', 'fea7672db2f050c9', 'ui_group', 'WÄRMEPUMPE', 'width', '6', '8', 'Gruppe 8 statt 6 (Überschriften ohne Umbruch, kein innerer Scrollbalken)'),
    ('Einstellungen', '548e51986bce11b0', 'ui_group', 'BETRIEB', 'width', '6', '8', 'Gruppe 8 statt 6 (Überschriften ohne Umbruch, kein innerer Scrollbalken)'),
    ('Einstellungen', '26d9e6cf24507b4f', 'ui_group', 'HEIZEN', 'width', '6', '8', 'Gruppe 8 statt 6 (Überschriften ohne Umbruch, kein innerer Scrollbalken)'),
    ('Einstellungen', '4e9e24cca215ad4d', 'ui_group', 'WARMWASSER', 'width', '6', '8', 'Gruppe 8 statt 6 (Überschriften ohne Umbruch, kein innerer Scrollbalken)'),
    ('Einstellungen', '9164f892e385d90c', 'ui_text', 'Reset current error', 'width', 4, 6, 'an Gruppenbreite 8'),
    ('Einstellungen', 'ea184fe6e1240203', 'ui_slider', '', 'width', 4, 6, 'an Gruppenbreite 8'),
    ('Einstellungen', '2c13c33324bb6c6e', 'ui_text', 'Aktueller Maximaldurchfluss', 'width', 6, 8, 'an Gruppenbreite 8'),
    ('Einstellungen', '4a2670b477ab7f75', 'ui_text', 'Force defrost', 'width', 4, 6, 'an Gruppenbreite 8'),
    ('Einstellungen', '9975ddd7c9465aea', 'ui_template', 'Line - DHW', 'width', 6, 8, 'an Gruppenbreite 8'),
    # ---- Pumpendrehzahl
    ('Pumpendrehzahl', '90b263e0e93c4635', 'ui_text', '', 'group', '4e7aaa8d2a717171', 'a1c0b0000c0f0020', 'Kopfzeile (Titel/Leerfeld) ausgeblendet'),
    ('Pumpendrehzahl', '4455e223f160f9a7', 'ui_text', 'Flexible pumpspeed', 'group', '4e7aaa8d2a717171', 'a1c0b0000c0f0020', 'Kopfzeile (Titel/Leerfeld) ausgeblendet'),
    ('Pumpendrehzahl', '25bd44a699dd047a', 'ui_text', '', 'group', '4e7aaa8d2a717171', 'a1c0b0000c0f0020', 'Kopfzeile (Titel/Leerfeld) ausgeblendet'),
    ('Pumpendrehzahl', '7353b5eff632b8d1', 'ui_template', 'style [PumpSpeed]', 'group', '4e7aaa8d2a717171', '4fb2801b6ab7ae20', 'Stil-Vorlage in die Inhaltsgruppe'),
    ('Pumpendrehzahl', '7353b5eff632b8d1', 'ui_template', 'style [PumpSpeed]', 'width', 3, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Pumpendrehzahl', '7353b5eff632b8d1', 'ui_template', 'style [PumpSpeed]', 'height', 1, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Pumpendrehzahl', '7353b5eff632b8d1', 'ui_template', 'style [PumpSpeed]', 'order', 4, 21, 'ans Ende'),
    ('Pumpendrehzahl', '4fb2801b6ab7ae20', 'ui_group', 'Einstellungen', 'width', 24, 18, '18 statt 24 (kein waagrechtes Scrollen bei 1024)'),
    ('Pumpendrehzahl', '3d8e357b01de57ff', 'ui_chart', 'Durchfluss', 'width', 17, 11, 'Diagramm an Breite 18'),
    ('Pumpendrehzahl', 'b22da9fe52b286cf', 'ui_text', 'chat legend', 'width', 17, 11, 'Legende an Breite 18'),
    # ---- Heizkurve
    ('Heizkurve', '76ac95177cc46b00', 'ui_group', 'Zone2', 'tab', '1d038e38da23c646', '534382cf81d94968', 'Zone 2 ausgeblendet (unbenutzt)'),
    ('Heizkurve', 'e5a709273b24888d', 'ui_text', 'spacer 1x1', 'group', 'b021ff109e8a2288', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-1/2-Knöpfe, Leerfelder)'),
    ('Heizkurve', 'e2dfbc7a5da3dc73', 'ui_text', 'TOPBAR', 'group', 'b021ff109e8a2288', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-1/2-Knöpfe, Leerfelder)'),
    ('Heizkurve', '6701660e3767bf11', 'ui_button', 'Zone 1', 'group', 'b021ff109e8a2288', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-1/2-Knöpfe, Leerfelder)'),
    ('Heizkurve', '946d48cda7b1f717', 'ui_text', 'topbar filler', 'group', 'b021ff109e8a2288', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-1/2-Knöpfe, Leerfelder)'),
    ('Heizkurve', 'd3c561cca61a4e6e', 'ui_button', 'Zone 2', 'group', 'b021ff109e8a2288', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-1/2-Knöpfe, Leerfelder)'),
    ('Heizkurve', '5429970cdd04e922', 'ui_text', 'spacer 6x1', 'group', 'b021ff109e8a2288', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-1/2-Knöpfe, Leerfelder)'),
    ('Heizkurve', 'd2881ea90b259ad7', 'ui_text', 'spacer 6x1', 'group', 'b021ff109e8a2288', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-1/2-Knöpfe, Leerfelder)'),
    ('Heizkurve', 'be48f3104249b8a0', 'ui_button', 'Hilfe', 'group', 'b021ff109e8a2288', '9b8ec8b1b9f66309', 'Hilfe-Knopf in die Zone-1-Gruppe'),
    ('Heizkurve', '9b8ec8b1b9f66309', 'ui_group', 'Zone1', 'width', 24, 18, '18 statt 24'),
    ('Heizkurve', '0c8eb8257035ca5f', 'ui_switch', 'z1_CCC on/off', 'width', 8, 6, 'Platz für Hilfe-Knopf'),
    ('Heizkurve', '4d5e9a9dacd2b429', 'ui_chart', 'Temperaturprofil Zone 1', 'width', 16, 10, 'Diagramm an Breite 18'),
    ('Heizkurve', '36a9b7dad9d2611e', 'ui_text', 'Graph description', 'width', 16, 10, 'an Breite 18'),
    ('Heizkurve', 'db206585adea91d8', 'ui_template', 'Line - Setup ', 'width', 16, 10, 'an Breite 18'),
    ('Heizkurve', '0d58a1e854263ec4', 'ui_chart', 'Zeitverlauf', 'width', 16, 10, 'Diagramm an Breite 18'),
    ('Heizkurve', '229a4ee1d7377c5e', 'ui_template', 'style [CCC] z1', 'width', 24, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Heizkurve', '229a4ee1d7377c5e', 'ui_template', 'style [CCC] z1', 'height', 1, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Heizkurve', 'be48f3104249b8a0', 'ui_button', 'Hilfe', 'order', 8, 2, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '4d5e9a9dacd2b429', 'ui_chart', 'Temperaturprofil Zone 1', 'order', 2, 3, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'fa5d110ee0083845', 'ui_template', 'Line - Temperature profile', 'order', 3, 4, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '5b9847446fee98a9', 'ui_text', 'Weather spacer 2x1', 'order', 4, 5, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'd1e851a03542c949', 'ui_text', 'Outside temp.', 'order', 5, 6, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '54284f6b97afb3c7', 'ui_text', 'Water temp.', 'order', 6, 7, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '07c9121f1be83415', 'ui_text', 'warm spacer 2x1', 'order', 7, 8, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '9a0e227ed7718d64', 'ui_numeric', 'ccc_ot1', 'order', 8, 9, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '388bec4d296db98d', 'ui_numeric', 'ccc_wt1', 'order', 9, 10, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'a00885bfd0ed77a7', 'ui_text', 'Inter spacer 1x1', 'order', 10, 11, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'f1d9c2e3346b1e43', 'ui_numeric', 'ccc_ot2', 'order', 11, 12, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'e07cc2b915729d33', 'ui_numeric', 'ccc_wt2', 'order', 12, 13, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'f76c271c4a48a3e7', 'ui_text', 'Cold 2x1', 'order', 13, 14, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '4950af3d6534aa47', 'ui_numeric', 'ccc_ot3', 'order', 14, 15, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'f2daac0935cc9d81', 'ui_numeric', 'ccc_wt3', 'order', 15, 16, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '02bef4c27cae892f', 'ui_template', 'Line - Setup ', 'order', 16, 17, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'd0cbd630befb3d01', 'ui_text', 'spacer 1x1', 'order', 17, 18, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'cc1c74d4b3b87c5e', 'ui_text', 'spacer 1x1', 'order', 18, 19, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'b7b3c4dcda507ecb', 'ui_text', 'Outside temp.', 'order', 19, 20, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'f3f5cc4e789d19f3', 'ui_text', 'Calculated water temp.', 'order', 20, 21, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '7a2a9be0735512b6', 'ui_text', 'spacer 1x1', 'order', 21, 22, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '7febe67492bf7cbe', 'ui_text', 'T outside', 'order', 22, 23, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'd9675d9d144e412b', 'ui_text', 'SP (WAR) - Function (WAR) settings', 'order', 23, 24, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '36a9b7dad9d2611e', 'ui_text', 'Graph description', 'order', 24, 25, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '26028dafb645f0a9', 'ui_template', 'Line - Advanced setup', 'order', 25, 26, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'db206585adea91d8', 'ui_template', 'Line - Setup ', 'order', 26, 27, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '78b397adf806a09f', 'ui_text', 'spacer 1x1', 'order', 27, 28, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'f70eae138246bae0', 'ui_button', 'Import', 'order', 28, 29, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '0366fd634f110ba4', 'ui_text', 'spacer 1', 'order', 29, 30, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '3a027c0cd9f8a957', 'ui_button', 'Export', 'order', 30, 31, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '2994451c952d77ae', 'ui_text', '----- spacer 1x1', 'order', 31, 32, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '0d58a1e854263ec4', 'ui_chart', 'Zeitverlauf', 'order', 32, 33, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'fde418209aab6a87', 'ui_template', 'Line - Setup ', 'order', 33, 34, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '320506c25427ee87', 'ui_text', 'spacer 1x1', 'order', 34, 35, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '8944d416f44e4183', 'ui_text', 'Outside temp.', 'order', 35, 36, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'ab60719365f6bde0', 'ui_text', 'Water temp.', 'order', 36, 37, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'c0a54684ef46f711', 'ui_text', 'ccc_ot1', 'order', 37, 38, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', 'dfd98e02f46447fb', 'ui_text', 'ccc_wt1', 'order', 38, 39, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '07bfc2f9f00870d7', 'ui_text', 'ccc_ot2', 'order', 39, 40, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '9005e7a87f86a06e', 'ui_text', 'ccc_wt2', 'order', 40, 41, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '3adf2738c40e2c50', 'ui_text', 'text: In DIRECT mode, the water te', 'order', 41, 42, 'Hilfe-Knopf nach dem Schalter'),
    ('Heizkurve', '229a4ee1d7377c5e', 'ui_template', 'style [CCC] z1', 'order', 42, 43, 'Hilfe-Knopf nach dem Schalter'),
    # ---- Raumregelung
    ('Raumregelung', '7267dafd7dc99038', 'ui_group', 'Zone2', 'tab', 'd6d4a43045260ac9', '534382cf81d94968', 'Zone 2 ausgeblendet (unbenutzt)'),
    ('Raumregelung', 'be5c89aff3235cfd', 'ui_text', 'spacer 1x1', 'group', '1db6d698669f3827', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-2-Knopf, Leerfelder)'),
    ('Raumregelung', '4b2cff40b8a3ecc9', 'ui_text', 'TOPBAR', 'group', '1db6d698669f3827', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-2-Knopf, Leerfelder)'),
    ('Raumregelung', '4cb4c0976c75ec37', 'ui_text', 'spacer 1x1', 'group', '1db6d698669f3827', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-2-Knopf, Leerfelder)'),
    ('Raumregelung', 'f9b2744cbe33d17a', 'ui_text', 'spacer 1x1', 'group', '1db6d698669f3827', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-2-Knopf, Leerfelder)'),
    ('Raumregelung', '3fd909993fad0be8', 'ui_text', 'spacer 1x1', 'group', '1db6d698669f3827', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-2-Knopf, Leerfelder)'),
    ('Raumregelung', '84e3a6d29296dc42', 'ui_button', 'Zone 2', 'group', '1db6d698669f3827', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-2-Knopf, Leerfelder)'),
    ('Raumregelung', 'ad91dd83853df6cf', 'ui_text', 'spacer 1x1', 'group', '1db6d698669f3827', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Zone-2-Knopf, Leerfelder)'),
    ('Raumregelung', '0fa2e5caff3f31a9', 'ui_button', 'Automatisierung', 'group', '1db6d698669f3827', 'e27cfec311892d88', 'Knopf Automatisierung in die Zone-1-Gruppe'),
    ('Raumregelung', 'ad4e277358b19235', 'ui_button', 'Hilfe', 'group', '1db6d698669f3827', 'e27cfec311892d88', 'Hilfe-Knopf in die Zone-1-Gruppe'),
    ('Raumregelung', '3d5514180bd61860', 'ui_button', 'Zone 1', 'group', '1db6d698669f3827', 'ef3dbc543ae92bec', 'Knopf Zone 1 als Rückweg in die Gruppe Automatisierungen'),
    ('Raumregelung', 'e27cfec311892d88', 'ui_group', 'Zone1', 'width', 24, 18, '18 statt 24'),
    ('Raumregelung', '25b8320badf7ef88', 'ui_switch', 'RTC on/off RTC_Settings', 'width', 7, 3, 'Platz für zwei Knöpfe'),
    ('Raumregelung', '696c696fa1c9f28e', 'ui_template', '', 'group', 'e27cfec311892d88', 'a1c0b0000c0f0020', 'senkrechte Trennlinie (Platz für ein breiteres Diagramm)'),
    ('Raumregelung', 'b32f014cb3ec752e', 'ui_chart', 'Raumtemperatur Zone 1', 'width', 16, 11, 'Diagramm an Breite 18, Höhe wie linke Spalte'),
    ('Raumregelung', 'b32f014cb3ec752e', 'ui_chart', 'Raumtemperatur Zone 1', 'height', 16, 14, 'Diagramm an Breite 18, Höhe wie linke Spalte'),
    ('Raumregelung', '631c09dd9632c92a', 'ui_template', 'style [RTC] z1', 'width', 7, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Raumregelung', '631c09dd9632c92a', 'ui_template', 'style [RTC] z1', 'height', 1, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Raumregelung', '032ca56c8c21283e', 'ui_text', 'footnote', 'width', 16, 11, 'an Breite 18'),
    ('Raumregelung', '2d7930a2b848335e', 'ui_template', 'Line 7x1 ', 'width', 8, 7, 'linke Spalte 7 breit'),
    ('Raumregelung', '57d858f4dd89a4c8', 'ui_switch', 'F_RTC.z1.incremental_setpoints_sta', 'width', 8, 7, 'linke Spalte 7 breit'),
    ('Raumregelung', '0fa2e5caff3f31a9', 'ui_button', 'Automatisierung', 'order', 3, 2, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'ad4e277358b19235', 'ui_button', 'Hilfe', 'order', 10, 3, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'b32f014cb3ec752e', 'ui_chart', 'Raumtemperatur Zone 1', 'order', 3, 4, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '3cf1a2dd31dacbca', 'ui_template', 'Line - Setup ', 'order', 4, 5, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '60e33931edeab23f', 'ui_text', 'Warm limits', 'order', 5, 6, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'cc930ab5b67c257e', 'ui_text', 'Room', 'order', 6, 7, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'a2afbd9244cceed5', 'ui_text', 'Water', 'order', 7, 8, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'd3b8865dfdb6d46c', 'ui_numeric', 'z1.t1_limit', 'order', 8, 9, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '368bd104ea1ba4e6', 'ui_numeric', 'z1.t1_correction', 'order', 9, 10, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'e4c7ba5f1306c384', 'ui_numeric', 'z1.t2_limit', 'order', 10, 11, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '922a3b1879d1a5ec', 'ui_numeric', 'z1.t2_correction', 'order', 11, 12, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'a0998b9af634354f', 'ui_numeric', 'z1.t3_limit', 'order', 12, 13, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'ae00df3cd05e6b06', 'ui_numeric', 'z1.t3_correction', 'order', 13, 14, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '1b8f5447c498c1d6', 'ui_numeric', 'Room setpoint', 'order', 14, 15, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'bb54f8581c258040', 'ui_text', 'filler b', 'order', 15, 16, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'dade0dbb40c3945a', 'ui_text', 'Room actual', 'order', 16, 17, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '3e3f19d365adf7ae', 'ui_text', 'Cold limits', 'order', 17, 18, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'aa1f73bbe3eef9e1', 'ui_numeric', 'z1.t4_limit', 'order', 18, 19, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '470ba61639a6ba2d', 'ui_numeric', 'z1.t4_correction', 'order', 19, 20, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '9b1f3ccedd4e853b', 'ui_numeric', 'z1.t5_limit', 'order', 20, 21, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '1b0dd0c926383896', 'ui_numeric', 'z1.t5_correction', 'order', 21, 22, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '017e7b4d1642ed42', 'ui_numeric', 'z1.t6_limit', 'order', 22, 23, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'ce9db55d9de18296', 'ui_numeric', 'z1.t6_correction', 'order', 23, 24, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '2ca9ec858ebd4887', 'ui_numeric', 'z1.t7_limit', 'order', 24, 25, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '290133f7fd948e25', 'ui_numeric', '+custom', 'order', 25, 26, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'ca0d9f423e83d3e2', 'ui_template', 'Line - RTC results', 'order', 26, 27, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '501242b43a1016ea', 'ui_text', 'Function RTC - Current correction', 'order', 27, 28, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '631c09dd9632c92a', 'ui_template', 'style [RTC] z1', 'order', 28, 29, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '2d7930a2b848335e', 'ui_template', 'Line 7x1 ', 'order', 29, 30, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', '57d858f4dd89a4c8', 'ui_switch', 'F_RTC.z1.incremental_setpoints_sta', 'order', 30, 32, 'Knöpfe nach dem Schalter, Fußnote unter das Diagramm'),
    ('Raumregelung', 'ef3dbc543ae92bec', 'ui_group', 'Automatisierungen', 'width', 24, 18, '18 statt 24'),
    ('Raumregelung', '80b26053020f1f65', 'ui_template', '', 'width', 17, 11, 'Erklärkasten an Breite 18 (etwas höher, kein innerer Scrollbalken)'),
    ('Raumregelung', '80b26053020f1f65', 'ui_template', '', 'height', 9, 12, 'Erklärkasten an Breite 18 (etwas höher, kein innerer Scrollbalken)'),
    ('Raumregelung', '3d5514180bd61860', 'ui_button', 'Zone 1', 'order', 6, 14, 'Rückweg-Knopf ans Ende'),
    ('Raumregelung', 'ae6c2168304beda0', 'ui_group', 'Hilfe', 'width', 24, 18, 'Hilfe 18 statt 24'),
    ('Raumregelung', 'd00691f660be457b', 'ui_text', 'spacer 1', 'width', 23, 17, 'an Breite 18'),
    # ---- Sanftanlauf
    ('Sanftanlauf', '6da2eb2fe8a51414', 'ui_text', '', 'group', 'c4606d0174cdbef4', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Leerfelder)'),
    ('Sanftanlauf', 'b9bd5ab11e9743ef', 'ui_text', 'SoftStart Header', 'group', 'c4606d0174cdbef4', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Leerfelder)'),
    ('Sanftanlauf', '8305b7f8df3333fb', 'ui_text', '', 'group', 'c4606d0174cdbef4', 'a1c0b0000c0f0020', 'Kopfzeile aufgelöst (Titel, Leerfelder)'),
    ('Sanftanlauf', '75571074f2ac434c', 'ui_button', 'Hilfe', 'group', 'c4606d0174cdbef4', 'c2a0123d2e2c91f0', 'Hilfe-Knopf in die Inhaltsgruppe'),
    ('Sanftanlauf', 'c2a0123d2e2c91f0', 'ui_group', 'Einstellungen', 'width', 24, 18, '18 statt 24'),
    ('Sanftanlauf', '7790b731fd9a1374', 'ui_switch', 'Softstart on/off (SS)', 'width', 5, 3, 'Platz für Hilfe-Knopf'),
    ('Sanftanlauf', '37ae6fb47a326b5e', 'ui_chart', 'SS chart', 'width', 18, 12, 'Diagramm an Breite 18, niedriger'),
    ('Sanftanlauf', '37ae6fb47a326b5e', 'ui_chart', 'SS chart', 'height', 8, 7, 'Diagramm an Breite 18, niedriger'),
    ('Sanftanlauf', 'c48cd6bad07ce428', 'ui_chart', 'SS chart', 'width', 18, 12, 'Diagramm an Breite 18'),
    ('Sanftanlauf', 'a4b7150004829f97', 'ui_template', 'style [Softstart]', 'width', 18, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Sanftanlauf', 'a4b7150004829f97', 'ui_template', 'style [Softstart]', 'height', 1, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Sanftanlauf', '75571074f2ac434c', 'ui_button', 'Hilfe', 'order', 4, 3, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', '37ae6fb47a326b5e', 'ui_chart', 'SS chart', 'order', 3, 4, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', '6fc2967e18fedff3', 'ui_template', 'Line setup', 'order', 4, 5, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', '2fdb58826d7b6432', 'ui_text', 'Runtime', 'order', 5, 6, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', '6d347eebf409d174', 'ui_dropdown', 'runtime', 'order', 6, 7, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', '2f436c5ec33c9291', 'ui_switch', 'Restart after defrost', 'order', 7, 8, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', '3b06cb6fe4aba512', 'ui_button', 'Show QuietMode add-on setup', 'order', 8, 9, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', 'a423271481d5d54d', 'ui_switch', 'QM_state', 'order', 9, 10, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', 'a8db39ee44e93a18', 'ui_template', 'Line compressor', 'order', 10, 11, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', 'e4f68946c7b21da7', 'ui_text', 'Compressor', 'order', 11, 12, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', 'd1aaf53ae9beb422', 'ui_text', 'Current runtime', 'order', 12, 13, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', 'c48cd6bad07ce428', 'ui_chart', 'SS chart', 'order', 16, 14, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', '23b6190afc840bdc', 'ui_template', 'Line Result', 'order', 13, 15, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', 'f4c3147c72aeb7b5', 'ui_text', 'SP (CCC) - Home HEAT Functions tab', 'order', 15, 16, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', 'a4b7150004829f97', 'ui_template', 'style [Softstart]', 'order', 14, 23, 'Hilfe-Knopf nach dem Schalter, rechte Spalte nur Diagramme'),
    ('Sanftanlauf', '3226b17db86f4510', 'ui_group', 'Hilfe', 'width', 24, 18, 'Hilfe 18 statt 24'),
    ('Sanftanlauf', '088968fcdf03a215', 'ui_text', 'spacer 1', 'width', 23, 17, 'an Breite 18'),
    ('Sanftanlauf', '8b7c9a76f8ddca81', 'ui_template', '', 'width', 24, 18, 'Bild an Breite 18'),
    # ---- Zeitplan
    ('Zeitplan', '8bb1e12a22d4dc11', 'ui_template', 'style [Scheduler]', 'width', 28, 0, 'reine Stil-Vorlage ohne Platz'),
    ('Zeitplan', '8bb1e12a22d4dc11', 'ui_template', 'style [Scheduler]', 'height', 1, 0, 'reine Stil-Vorlage ohne Platz'),
    # ---- Temperaturen
    ('Temperaturen', 'e374621a9f5ac0d6', 'ui_group', 'Wassertemperatur', 'width', '26', '18', '18 statt 26'),
    ('Temperaturen', '180294703c42c046', 'ui_text', 'spacer 1', 'group', 'e374621a9f5ac0d6', 'a1c0b0000c0f0020', 'Leerfeld der Kopfzeile'),
    ('Temperaturen', '848fa7aade4f22a3', 'ui_template', 'style [Temp]', 'width', 26, 15, 'Balken + Hilfe in einer Zeile'),
    ('Temperaturen', 'a1c0b0000c0f0012', 'ui_chart', 'COP Heizen', 'width', 26, 18, 'Diagramm 18x5 statt 26x7'),
    ('Temperaturen', 'a1c0b0000c0f0012', 'ui_chart', 'COP Heizen', 'height', 7, 5, 'Diagramm 18x5 statt 26x7'),
    ('Temperaturen', '9802bf01ebf45d28', 'ui_chart', 'Water HEAT', 'width', 26, 18, 'Diagramm 18x5 statt 26x7'),
    ('Temperaturen', '9802bf01ebf45d28', 'ui_chart', 'Water HEAT', 'height', 7, 5, 'Diagramm 18x5 statt 26x7'),
    ('Temperaturen', '8cb1aceef81045bd', 'ui_chart', 'Room Temperature', 'width', 26, 18, 'Diagramm 18x5 statt 26x7'),
    ('Temperaturen', '8cb1aceef81045bd', 'ui_chart', 'Room Temperature', 'height', 7, 5, 'Diagramm 18x5 statt 26x7'),
    ('Temperaturen', 'a1c0b0000c0f0043', 'ui_chart', 'Außentemperatur', 'width', 26, 18, 'Diagramm 18x5 statt 26x7'),
    ('Temperaturen', 'a1c0b0000c0f0043', 'ui_chart', 'Außentemperatur', 'height', 7, 5, 'Diagramm 18x5 statt 26x7'),
    ('Temperaturen', '3c2858cfac17c240', 'ui_template', 'Line2', 'group', 'e374621a9f5ac0d6', 'a1c0b0000c0f0020', 'Trennbalken zwischen Diagrammen'),
    ('Temperaturen', '2093edece5e11445', 'ui_template', 'Line3', 'group', 'e374621a9f5ac0d6', 'a1c0b0000c0f0020', 'Trennbalken zwischen Diagrammen'),
    ('Temperaturen', '848fa7aade4f22a3', 'ui_template', 'style [Temp]', 'order', 4, 1, 'Kopfzeile: Balken, Hilfe'),
    ('Temperaturen', 'a1c0b0000c0f0012', 'ui_chart', 'COP Heizen', 'order', 5, 4, 'Kopfzeile: Balken, Hilfe'),
    ('Temperaturen', '9802bf01ebf45d28', 'ui_chart', 'Water HEAT', 'order', 7, 5, 'Kopfzeile: Balken, Hilfe'),
    ('Temperaturen', '8cb1aceef81045bd', 'ui_chart', 'Room Temperature', 'order', 9, 6, 'Kopfzeile: Balken, Hilfe'),
    ('Temperaturen', 'a1c0b0000c0f0043', 'ui_chart', 'Außentemperatur', 'order', 10, 7, 'Kopfzeile: Balken, Hilfe'),
    # ---- Effizienz
    ('Effizienz', '6c4ef2b911f0843b', 'ui_group', 'Current Value', 'width', '26', '17', '17 statt 26 (zwei Spalten bei 1920)'),
    ('Effizienz', '56501a1437bb83a2', 'ui_group', 'HistoryTable', 'width', 26, 17, '17 statt 26 (zwei Spalten bei 1920)'),
    ('Effizienz', 'fb77ab43998a2f18', 'ui_group', 'HistoryChart', 'width', '26', '17', '17 statt 26 (zwei Spalten bei 1920)'),
    ('Effizienz', 'fb77ab43998a2f18', 'ui_group', 'HistoryChart', 'order', 4, 3, 'Diagramme vor Tabelle (Masonry)'),
    ('Effizienz', '56501a1437bb83a2', 'ui_group', 'HistoryTable', 'order', 3, 4, 'Tabelle nach den Diagrammen'),
    ('Effizienz', 'b40c0f3e82728c9d', 'ui_template', '-----Current values', 'width', 0, 9, 'Überschrift + Knöpfe in einer Zeile'),
    ('Effizienz', 'b40c0f3e82728c9d', 'ui_template', '-----Current values', 'height', 0, 1, 'Überschrift + Knöpfe in einer Zeile'),
    ('Effizienz', '919756cfdbd4deac', 'ui_text', 'filler1', 'group', '6c4ef2b911f0843b', 'a1c0b0000c0f0020', 'Leerfeld'),
    ('Effizienz', '53293e985f4deb96', 'ui_text', 'filler1', 'group', '6c4ef2b911f0843b', 'a1c0b0000c0f0020', 'Leerfeld'),
    ('Effizienz', '4fad26b9a339a125', 'ui_text', 'filler1', 'group', '6c4ef2b911f0843b', 'a1c0b0000c0f0020', 'Leerfeld'),
    ('Effizienz', 'd539d5859bbc5388', 'ui_text', 'filler1', 'group', '6c4ef2b911f0843b', 'a1c0b0000c0f0020', 'Leerfeld'),
    ('Effizienz', 'bd75ee928fde85b5', 'ui_chart', 'Wasser', 'width', 7, 6, 'an Breite 17'),
    ('Effizienz', 'b6310c926333bd56', 'ui_gauge', '', 'width', 8, 6, 'an Breite 17'),
    ('Effizienz', '03a0cd845d8efbe7', 'ui_button', 'Chart', 'order', 7, 2, 'Knöpfe neben die Überschrift'),
    ('Effizienz', 'e7626bf3192d47cb', 'ui_button', 'Table', 'order', 9, 3, 'Knöpfe neben die Überschrift'),
    ('Effizienz', 'd30f518b158d8bba', 'ui_chart', 'Leistung [W]', 'order', 2, 4, 'Knöpfe neben die Überschrift'),
    ('Effizienz', 'bd75ee928fde85b5', 'ui_chart', 'Wasser', 'order', 3, 5, 'Knöpfe neben die Überschrift'),
    ('Effizienz', 'b6310c926333bd56', 'ui_gauge', '', 'order', 4, 6, 'Knöpfe neben die Überschrift'),
    ('Effizienz', '4d7236c464d1c14e', 'ui_text', 'by default...', 'width', 21, 12, 'an Breite 17'),
    ('Effizienz', '59bc0c78b8b9ea90', 'ui_table', 'asdf', 'width', 26, 17, 'Tabelle 17x9 statt 26x18'),
    ('Effizienz', '59bc0c78b8b9ea90', 'ui_table', 'asdf', 'height', 18, 9, 'Tabelle 17x9 statt 26x18'),
    ('Effizienz', '85adc292e5cdace2', 'ui_text', 'spacer 1', 'group', 'fb77ab43998a2f18', 'a1c0b0000c0f0020', 'Leerfeld der Kopfzeile'),
    ('Effizienz', '6cce5b6bd4157c5b', 'ui_template', 'Trends', 'width', 0, 14, 'Überschrift + Hilfe in einer Zeile'),
    ('Effizienz', '6cce5b6bd4157c5b', 'ui_template', 'Trends', 'height', 0, 1, 'Überschrift + Hilfe in einer Zeile'),
    ('Effizienz', 'fa2eba3089ca0ef4', 'ui_chart', 'Leistung (W)', 'width', 26, 17, 'Diagramm 17x5 statt 26x7'),
    ('Effizienz', 'fa2eba3089ca0ef4', 'ui_chart', 'Leistung (W)', 'height', 7, 5, 'Diagramm 17x5 statt 26x7'),
    ('Effizienz', '1cbdb190d6f52cb6', 'ui_chart', 'Effizienz', 'width', 26, 17, 'Diagramm 17x5 statt 26x7'),
    ('Effizienz', '1cbdb190d6f52cb6', 'ui_chart', 'Effizienz', 'height', 7, 5, 'Diagramm 17x5 statt 26x7'),
    ('Effizienz', '8084f5f9211ba26e', 'ui_chart', 'Production DHW + HEAT (12m)', 'width', 26, 17, 'Diagramm 17x5 statt 26x7'),
    ('Effizienz', '8084f5f9211ba26e', 'ui_chart', 'Production DHW + HEAT (12m)', 'height', 7, 5, 'Diagramm 17x5 statt 26x7'),
    ('Effizienz', 'eee624aa045ae22a', 'ui_chart', 'COP DHW + COP HEAT (12m)', 'width', 26, 17, 'Diagramm 17x5 statt 26x7'),
    ('Effizienz', 'eee624aa045ae22a', 'ui_chart', 'COP DHW + COP HEAT (12m)', 'height', 7, 5, 'Diagramm 17x5 statt 26x7'),
    ('Effizienz', 'dc1b09eb3278501e', 'ui_template', 'Line', 'group', 'fb77ab43998a2f18', 'a1c0b0000c0f0020', 'Trennbalken zwischen Diagrammen'),
    ('Effizienz', '6cce5b6bd4157c5b', 'ui_template', 'Trends', 'order', 4, 1, 'Kopfzeile: Überschrift, Hilfe'),
    ('Effizienz', 'fa2eba3089ca0ef4', 'ui_chart', 'Leistung (W)', 'order', 5, 4, 'Kopfzeile: Überschrift, Hilfe'),
    ('Effizienz', '1cbdb190d6f52cb6', 'ui_chart', 'Effizienz', 'order', 7, 5, 'Kopfzeile: Überschrift, Hilfe'),
    ('Effizienz', '23aa1aeed6d15e49', 'ui_template', 'Line', 'order', 8, 6, 'Kopfzeile: Überschrift, Hilfe'),
    ('Effizienz', '8084f5f9211ba26e', 'ui_chart', 'Production DHW + HEAT (12m)', 'order', 9, 7, 'Kopfzeile: Überschrift, Hilfe'),
    ('Effizienz', 'eee624aa045ae22a', 'ui_chart', 'COP DHW + COP HEAT (12m)', 'order', 10, 8, 'Kopfzeile: Überschrift, Hilfe'),
    ('Effizienz', '11685bca2f768125', 'ui_template', 'style [Energy]', 'order', 11, 9, 'Kopfzeile: Überschrift, Hilfe'),
    ('Effizienz', '064c9c202bf3ec8d', 'ui_group', 'Help', 'width', 13, 17, 'Hilfe 17 wie die übrigen Gruppen (Masonry-Falle)'),
    ('Effizienz', '806ef01e375dce96', 'ui_text', 'spacer 1', 'width', 12, 16, 'an Breite 17'),
    ('Effizienz', '9a18b2fdbbfcef0e', 'ui_template', 'Line - Instructions text', 'width', 13, 17, 'an Breite 17'),
    # ---- Gradtage
    ('Gradtage', '87be08e6a82ef6a0', 'ui_group', 'Degree days information', 'width', 26, 18, '18 statt 26'),
    ('Gradtage', '5fbc0d70a6f5758e', 'ui_text', 'spacer 1', 'group', '87be08e6a82ef6a0', 'a1c0b0000c0f0020', 'Leerfeld der Kopfzeile'),
    ('Gradtage', 'a1c0b0000c0f0031', 'ui_text', 'kWh pro Gradtag', 'width', 26, 15, 'Kennzahl + Hilfe in einer Zeile'),
    ('Gradtage', '40b5ddfde5f28d99', 'ui_template', 'Line', 'group', '87be08e6a82ef6a0', 'a1c0b0000c0f0020', 'Trennbalken'),
    ('Gradtage', '67a8d20ae604a58e', 'ui_template', 'Line', 'group', '87be08e6a82ef6a0', 'a1c0b0000c0f0020', 'Trennbalken'),
    ('Gradtage', '4eaa2cfa2749c551', 'ui_chart', 'kWh + Degree Days (31d)', 'width', 26, 18, 'Diagramm 18x6 statt 26x8'),
    ('Gradtage', '4eaa2cfa2749c551', 'ui_chart', 'kWh + Degree Days (31d)', 'height', 8, 6, 'Diagramm 18x6 statt 26x8'),
    ('Gradtage', '2ee679408e4ccc6f', 'ui_chart', 'kWh + Degree Days (24h)', 'width', 26, 18, 'Diagramm 18x6 statt 26x8'),
    ('Gradtage', '2ee679408e4ccc6f', 'ui_chart', 'kWh + Degree Days (24h)', 'height', 8, 6, 'Diagramm 18x6 statt 26x8'),
    ('Gradtage', 'a1c0b0000c0f0031', 'ui_text', 'kWh pro Gradtag', 'order', 4, 1, 'Kopfzeile: Kennzahl, Hilfe'),
    ('Gradtage', '4eaa2cfa2749c551', 'ui_chart', 'kWh + Degree Days (31d)', 'order', 6, 4, 'Kopfzeile: Kennzahl, Hilfe'),
    ('Gradtage', '2ee679408e4ccc6f', 'ui_chart', 'kWh + Degree Days (24h)', 'order', 8, 5, 'Kopfzeile: Kennzahl, Hilfe'),
    ('Gradtage', '05b8832e0e7fda7e', 'ui_template', 'style [Degreedays]', 'order', 9, 6, 'Kopfzeile: Kennzahl, Hilfe'),
    # ---- SYSTEM
    ('SYSTEM', 'fa276db3a5fd6186', 'ui_template', 'Line - Setup ', 'group', '70a5fe6af8ed1d29', 'a1c0b0000c0f0020', 'Trennlinie unter der Navigation'),
    ('SYSTEM', '48b67765f5bf4521', 'ui_text', 'spacer 1x1', 'group', '16ec453c8cb345ac', 'a1c0b0000c0f0020', 'leere Zeile über dem Protokoll'),
    ('SYSTEM', 'ccf20ebdd2bc2ad5', 'ui_template', 'Log to dashboard', 'height', 16, 14, 'Protokoll 14 statt 16 Zeilen'),
]

# Hilfetexte: (Seite, Knoten-ID, Ueberschrift, SHA-1 des Original-Formats (16 Zeichen), Original-Hoehe); eingeklappt: Hoehe 1, aufgeklappt passt sich die Karte selbst ein
HILFE = [
    ('Heizkurve', '43be81558a98b102', 'Hilfe', '518651e404ec70ca', 18),
    ('Raumregelung', '8982c1e161d9d215', 'Hilfe', 'b4756b461d2ccb11', 26),
    ('Sanftanlauf', 'c54eb9703d5f9272', 'Hilfe (Teil 1)', '705a6d42a25b3254', 6),
    ('Sanftanlauf', 'c96821120dd58acc', 'Hilfe (Teil 2)', '474c5dd8648b0e7c', 20),
    ('Zeitplan', 'c38f069ac9641f6a', 'Hilfe', 'c6851954994ecb12', 32),
    ('Temperaturen', '56de4e61c43e26ae', 'Hilfe', '08b8cfad0bd6f086', 13),
    ('Effizienz', '9a18b2fdbbfcef0e', 'Hilfe', '67bce5bdab0ff51a', 13),
    ('Gradtage', 'a19ced7de80acf30', 'Hilfe', '65bcecec18ebfa12', 13),
    ('SYSTEM', '6673302e58397381', 'Hilfe', '852d9029eee37fa2', 17),
]
HILFE_MARKE = '<details class="nrhilfe"'
HILFE_TEXT_START = '<div class="nrhilfe-text">\n'
HILFE_TEXT_ENDE = '\n</div></details>\n'
HILFE_STIL = ('<style>details.nrhilfe>summary{cursor:pointer;font-weight:500;line-height:24px;padding:8px 6px;outline:none}'
              'details.nrhilfe[open]>summary{border-bottom:1px solid rgba(128,128,128,.35);margin-bottom:6px}'
              'details.nrhilfe .nrhilfe-text{padding:0 6px 10px}</style>\n')
# Einpassen wie FIT_JS der Optimierer-Seiten: nach dem Auf-/Zuklappen die noetigen Rastereinheiten setzen und Gruppe + Seite neu anordnen
HILFE_JS = """<script>
(function () {
    var id = '__ID__';
    function fit() {
        try {
            var card = document.querySelector('[node-id="' + id + '"]'), d = card && card.querySelector('details.nrhilfe');
            if (!card || !d || !card.offsetParent) { return; }
            var px = d.getBoundingClientRect().bottom - card.getBoundingClientRect().top + 6;
            var z = angular.element(document.body).injector().get('uiSizes'), units = Math.max(1, Math.ceil((px + z.cy) / (z.sy + z.cy)));
            var attr = card.getAttribute('ui-card-size') || '', w = attr.split('x')[0] || '__W__';
            if (attr === w + 'x' + units) { return; }
            card.setAttribute('ui-card-size', w + 'x' + units);
            var panel = card.closest('ui-card-panel'), ctrl = angular.element(panel).controller('uiCardPanel'), mas = angular.element(panel.parentElement).controller('uiMasonry');
            ctrl.refreshLayout(function () { if (mas) { mas.refreshLayout(); } setTimeout(fit, 150); });
        } catch (e) { /* die Karte behaelt ihre Hoehe */ }
    }
    function hook() {
        var card = document.querySelector('[node-id="' + id + '"]'), d = card && card.querySelector('details.nrhilfe');
        if (!d) { return; }
        if (!d.__nrh) { d.__nrh = true; d.addEventListener('toggle', function () { setTimeout(fit, 30); }); }
        fit();
    }
    setTimeout(hook, 200);
})();
</script>"""


def hilfe_wrap(fmt, node_id, summary, width):
    return ('<details class="nrhilfe"><summary>' + summary + '</summary>' + HILFE_TEXT_START + fmt + HILFE_TEXT_ENDE
            + HILFE_STIL + HILFE_JS.replace("__ID__", node_id).replace("__W__", str(width)))


def hilfe_unwrap(fmt):
    """Original aus einem eingeklappten Hilfetext (unveraendert zwischen den Marken), sonst None"""
    if not fmt.startswith(HILFE_MARKE):
        return None
    a = fmt.find(HILFE_TEXT_START)
    b = fmt.rfind(HILFE_TEXT_ENDE)
    if a < 0 or b < a:
        return None
    return fmt[a + len(HILFE_TEXT_START):b]


def sha(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- Layout-Modell (node-red-dashboard 3.x, kalibriert an der Live-Vermessung)
TITLE = 54          # Gruppentitel p.nr-dashboard-cardtitle: 32 px + 10 px + 12 px Rand
PAGE_OFF = 66       # Seitenanfang bis Masonry (aus der Vermessung)
SCROLLBAR = 17


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


class Modell:
    """Packung je Gruppe (ui-card-panel: first fit zeilenweise) und Masonry der Gruppen (ui-masonry refreshSizes, inkl. seiner Ueberlappungspruefung)"""

    def __init__(self, flows, sizes=None):
        self.s = dict(RASTER_ALT, **(sizes or {}))
        self.flows = flows
        self.N = {n["id"]: n for n in flows}
        self.pos = {n["id"]: i for i, n in enumerate(flows)}
        self.off = {n["id"] for n in flows if n["type"] == "tab" and n.get("disabled")}
        self.tabs = sorted([n for n in flows if n["type"] == "ui_tab"], key=lambda t: float(t.get("order") or 0))
        self.groups = [n for n in flows if n["type"] == "ui_group"]
        self.widgets = [n for n in flows if n.get("group") and n["type"].startswith("ui_") and n["type"] not in ("ui_group", "ui_tab", "ui_base")]

    def px(self, n, s, c):
        return n * s + (n - 1) * c if n > 0 else 0

    def sichtbar(self, w):
        if w.get("d") or w.get("z") in self.off:
            return False
        return not (w["type"] == "ui_template" and w.get("templateScope", "local") != "local")

    def groesse(self, w, gw):
        width = _int(w.get("width"))
        width = max(1, min(gw, gw if width <= 0 else width))
        h = _int(w.get("height"))
        t = w["type"]
        if t == "ui_form":               # waechst mit den Feldern (Vermessung Zeitplan)
            n = len(w.get("options") or [])
            return width, max(h, (n + 1) // 2 + 1 if w.get("splitLayout") else n + 1)
        if h > 0:
            return width, h
        if t == "ui_template":           # Auto-Hoehe: reine Stil-Vorlagen 0, kurze Linien/Ueberschriften 1, sonst grob nach Textmenge
            f = re.sub(r"<script[\s\S]*?</script>", "", re.sub(r"<style[\s\S]*?</style>", "", (w.get("format") or "").lower())).strip()
            if not f:
                return width, 0
            txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", f)).strip()
            brs = len(re.findall(r"<br|<h\d|<p[ >]|<li|<tr|<div", f))
            if len(txt) < 120 and brs <= 2:
                return width, 1
            lines = brs + len(txt) / max(20.0, self.px(width, self.s["sx"], self.s["cx"]) / 7.5)
            return width, max(1, int((lines * 20 + self.s["sy"] + 2 * self.s["cy"] - 1) // (self.s["sy"] + self.s["cy"])))
        return width, {"ui_gauge": 3, "ui_chart": 6}.get(t, 1)

    def gruppen_widgets(self, gid):
        ws = [w for w in self.widgets if w["group"] == gid and self.sichtbar(w)]
        return sorted(ws, key=lambda w: (float(w.get("order") or 0), self.pos[w["id"]]))

    def packen(self, g):
        gw = _int(g.get("width")) or 6
        occ, places, rows = set(), [], 0
        for w in self.gruppen_widgets(g["id"]):
            cw, ch = self.groesse(w, gw)
            if ch <= 0:
                continue
            y, done = 0, False
            while not done and y < 1000:
                for x in range(0, gw - cw + 1):
                    if all((x + i, y + j) not in occ for i in range(cw) for j in range(ch)):
                        occ.update((x + i, y + j) for i in range(cw) for j in range(ch))
                        places.append((w, x, y, cw, ch))
                        rows, done = max(rows, y + ch), True
                        break
                y += 1
        return rows, places

    def gruppe_px(self, g):
        rows, _ = self.packen(g)
        s = self.s
        h = (self.px(rows, s["sy"], s["cy"]) + 2 * s["py"] if rows > 0 else 0) + (TITLE if g.get("disp", True) else 0)
        return self.px(_int(g.get("width")) or 6, s["sx"], s["cx"]) + 2 * s["px"], h, rows

    def seiten_gruppen(self, tab_id, versteckt=()):
        gs = [g for g in self.groups if g.get("tab") == tab_id and g.get("name") not in versteckt and self.gruppen_widgets(g["id"])]
        return sorted(gs, key=lambda g: (float(g.get("order") or 0), self.pos[g["id"]]))

    def masonry(self, sizes, win):
        gx, gy = self.s["gx"], self.s["gy"]
        avail, INF = win - SCROLLBAR - 2 * gx, float("inf")
        blocks = [{"x": 0, "y": gy, "w": avail, "h": INF, "used": False}]
        cache, assigned, pos = {"0:%s" % gy: blocks[0]}, [], []

        def inter(r1, r2):
            return not (r2["x"] > r1["x"] or r2["x"] + r2["w"] < r1["x"] or r2["y"] > r1["y"] + r1["h"] or r2["y"] + r2["h"] < r1["y"])
        for (cw, ch) in sizes:
            added, i = False, 0
            while i < len(blocks):
                b = blocks[i]
                i += 1
                if b["used"] or cw > b["w"] or ch > b["h"]:
                    continue
                hit = next((b2 for b2 in assigned if inter(b, b2)), None)
                if hit is not None:
                    key = "%s:%s" % (b["x"], hit["y"] + hit["h"] + gy)
                    if key not in cache:
                        cache[key] = {"x": b["x"], "y": hit["y"] + hit["h"] + gy, "w": b["w"], "h": b["h"], "used": False}
                        blocks.append(cache[key])
                        blocks.sort(key=lambda q: (q["y"], q["x"]))
                    continue
                b["used"] = True
                assigned.append(b)
                pos.append((b["x"], b["y"]))
                added = True
                rb = {"x": b["x"] + cw + gx, "y": b["y"], "w": b["w"] - gx - cw, "h": b["h"], "used": False}
                key = "%s:%s" % (rb["x"], rb["y"])
                if key not in cache and not any(b3 is not b and b3["x"] <= rb["x"] <= b3["x"] + b3["w"] and b3["y"] <= rb["y"] <= b3["y"] + b3["h"] for b3 in assigned):
                    cache[key] = rb
                    blocks.append(rb)
                key = "%s:%s" % (b["x"], b["y"] + ch + gy)
                if key not in cache:
                    cache[key] = {"x": b["x"], "y": b["y"] + ch + gy, "w": b["w"], "h": b["h"], "used": False}
                    blocks.append(cache[key])
                b["w"], b["h"] = cw, ch
                break
            if not added:
                maxy = max([q["y"] + q["h"] for q in assigned] + [0])
                bb = cache.setdefault("0:%s" % (maxy + gy), {"x": 0, "y": maxy + gy})
                bb.update(used=True, w=cw, h=ch)
                blocks.append(bb)
                assigned.append(bb)
                pos.append((bb["x"], bb["y"]))
                key = "0:%s" % (bb["y"] + ch + gy)
                if key not in cache:
                    cache[key] = {"x": 0, "y": bb["y"] + ch + gy, "w": avail, "h": INF, "used": False}
                    blocks.append(cache[key])
            blocks.sort(key=lambda q: (q["y"], q["x"]))
        maxx = max([q["x"] + q["w"] for q in assigned] + [0])
        maxy = max([q["y"] + q["h"] for q in assigned] + [0])
        return pos, maxx, maxy, avail

    def seite(self, tab, versteckt=(), win=1920):
        """Seitenhoehe in px (wie vermessen: unterste Kartenkante), waagrechtes Scrollen, Ueberlappung (echte Rechtecke)"""
        gs = self.seiten_gruppen(tab["id"], versteckt)
        sizes = [self.gruppe_px(g)[:2] for g in gs]
        pos, maxx, maxy, avail = self.masonry(sizes, win)
        left = max(0, self.s["gx"] + (avail - maxx) / 2.0)
        ueber = [(gs[i]["name"], gs[j]["name"]) for i, j in itertools.combinations(range(len(gs)), 2)
                 if pos[i][0] < pos[j][0] + sizes[j][0] and pos[j][0] < pos[i][0] + sizes[i][0] and pos[i][1] < pos[j][1] + sizes[j][1] and pos[j][1] < pos[i][1] + sizes[i][1]]
        return PAGE_OFF + maxy, maxx + left > win - SCROLLBAR + 0.5, ueber, gs


# ---------------------------------------------------------------- Plan, Pruefung, Anwenden
class Abbruch(Exception):
    pass


def plan(flows, hilfe_modus="einklappen", raster=False):
    """Liste konkreter Aenderungen [(seite, id, key, alt, neu, grund)]; Abbruch bei unerwartetem Altwert"""
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
        if cur == neu:
            schon += 1
            continue
        if cur != alt:
            fehler.append("%s: %s %s.%s ist %r, erwartet %r (Live-Flow geaendert?)" % (seite, i, name, key, cur, alt))
            continue
        out.append((seite, i, key, alt, neu, grund))
    if hilfe_modus == "einklappen":
        for (seite, i, summary, h, hoehe) in HILFE:
            n = N.get(i)
            if n is None or n["type"] != "ui_template":
                fehler.append("%s: Hilfetext %s fehlt" % (seite, i))
                continue
            fmt = n.get("format") or ""
            orig = hilfe_unwrap(fmt)
            if orig is not None and sha(orig) == h:
                schon += 1
                continue
            if sha(fmt) != h:
                fehler.append("%s: Hilfetext %s hat einen anderen Inhalt als erwartet" % (seite, i))
                continue
            width = next((neu for (_s, j, _t, _n, k, _a, neu, _g) in AENDERUNGEN if j == i and k == "width"), n.get("width"))
            out.append((seite, i, "format", fmt, hilfe_wrap(fmt, i, summary, width), "Hilfetext eingeklappt (<details>, passt sich beim Aufklappen an)"))
            if n.get("height") != 1:
                if n.get("height") != hoehe:
                    fehler.append("%s: Hilfetext %s Hoehe %r, erwartet %r" % (seite, i, n.get("height"), hoehe))
                else:
                    out.append((seite, i, "height", hoehe, 1, "Hilfetext eingeklappt: 1 Zeile"))
    if raster:
        b = N.get(UI_BASE)
        cur = ((b or {}).get("site") or {}).get("sizes")
        if b is None or b["type"] != "ui_base":
            fehler.append("ui_base %s fehlt" % UI_BASE)
        elif cur == RASTER_NEU:
            schon += 1
        elif cur != RASTER_ALT:
            fehler.append("ui_base sizes %r, erwartet %r" % (cur, RASTER_ALT))
        else:
            site = copy.deepcopy(b["site"])
            site["sizes"] = dict(RASTER_NEU)
            out.append(("alle Seiten", UI_BASE, "site", b["site"], site, "Stufe 2: Raster sy 40, cy/gy 4"))
    if fehler:
        raise Abbruch("Erwartete Ausgangswerte stimmen nicht:\n  " + "\n  ".join(fehler))
    return out, schon


def anwenden(flows, changes):
    neu = copy.deepcopy(flows)
    N = {n["id"]: n for n in neu}
    for (_s, i, key, _alt, wert, _g) in changes:
        N[i][key] = copy.deepcopy(wert)
    return neu


def whitelist(alt, neu, raster=False, rueckbau=None):
    """Unabhaengige Pruefung des Ergebnisses gegen das Original. Rueckgabe: geaenderte IDs, Zaehler je Typ; Abbruch bei jeder anderen Aenderung.
    rueckbau: {(id, key): alter Wert} aus der Sicherung - dann sind nur genau diese Werte erlaubt (Richtung zurueck auf den gesicherten Stand)."""
    fehler = []
    if [n["id"] for n in alt] != [n["id"] for n in neu]:
        raise Abbruch("Whitelist: Knoten hinzugefuegt, entfernt oder umsortiert")
    A = {n["id"]: n for n in alt}
    Bn = {n["id"]: n for n in neu}
    tabs_hidden = {n["id"] for n in neu if n["type"] == "ui_tab" and n.get("hidden")}
    hilfe_ids = {h[1] for h in HILFE}
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
        if t == "ui_group":
            erlaubt = GROUP_KEYS
            if "tab" in keys and n1.get("tab") not in tabs_hidden:
                fehler.append("%s: Gruppe auf sichtbaren Tab verschoben" % i)
        elif t == "ui_base":
            erlaubt = {"site"} if raster else set()
            if "site" in keys:
                s0 = dict(n0.get("site") or {})
                s1 = dict(n1.get("site") or {})
                s0.pop("sizes", None)
                s1.pop("sizes", None)
                if s0 != s1:
                    fehler.append("%s: ui_base ausser sizes geaendert" % i)
        elif t.startswith("ui_") and n0.get("group"):
            erlaubt = set(WIDGET_KEYS)
            if i in hilfe_ids and t == "ui_template" and n0.get("z") == HELP_FLOW and str(n0.get("name") or "").startswith("Line - Instructions text"):
                erlaubt.add("format")
                eingebettet = (hilfe_unwrap(n1.get("format") or "") == n0.get("format")) if rueckbau is None else (hilfe_unwrap(n0.get("format") or "") == n1.get("format"))
                if "format" in keys and not eingebettet:
                    fehler.append("%s: Hilfetext-Inhalt nicht unveraendert eingebettet" % i)
            if "group" in keys:
                g0, g1 = A.get(n0["group"]), Bn.get(n1.get("group"))
                if not g1 or g1["type"] != "ui_group":
                    fehler.append("%s: Zielgruppe fehlt" % i)
                elif not (g0 and g0.get("tab") == g1.get("tab")) and g1.get("tab") not in tabs_hidden:
                    fehler.append("%s: Widget auf eine andere sichtbare Seite verschoben" % i)
        else:
            erlaubt = set()
        bad = keys - erlaubt
        if bad:
            fehler.append("%s (%s): nicht erlaubte Schluessel %s" % (i, t, sorted(bad)))
        if rueckbau is not None:
            fehler = [f for f in fehler if not f.startswith(i + ": ") or "verschoben" not in f]      # Rueckweg: Ziel ist der gesicherte Ausgangsstand
            for k in keys:
                if (i, k) not in rueckbau or n1.get(k) != rueckbau[(i, k)]:
                    fehler.append("%s.%s: Rueckbau nur auf den gesicherten Wert" % (i, k))
        geaendert.append(i)
        typen[t] = typen.get(t, 0) + 1
    if fehler:
        raise Abbruch("Whitelist verletzt:\n  " + "\n  ".join(fehler))
    return geaendert, typen


def laden(path):
    raw = open(path, encoding="utf-8").read()
    flows = json.loads(raw)
    if isinstance(flows, dict) and "flows" in flows:          # Admin-API v2 {"rev","flows"}
        flows = flows["flows"]
    return flows, raw.lstrip().startswith("[{")


def schreiben(path, flows, kompakt):
    with open(path, "w", encoding="utf-8") as f:
        if kompakt:
            json.dump(flows, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(flows, f, ensure_ascii=False, indent=4)


# ---------------------------------------------------------------- Bericht
def bericht(alt, neu, changes, schon, ids, typen, raster):
    seiten = [t["name"] for t in Modell(alt).tabs if not t.get("hidden") and not t["id"].startswith("opt_")]
    M0, M1 = Modell(alt), Modell(neu)
    print("Seite            Aend.  1920 px vorher -> nachher        1024 px          2560 px          waagrecht 1024 (vorher/nachher)")
    for name in seiten:
        t0 = next(t for t in M0.tabs if t["name"] == name)
        t1 = next(t for t in M1.tabs if t["name"] == name)
        v = M0.seite(t0, VERSTECKT.get(name, ()), 1920)[0]
        r = {W: M1.seite(t1, VERSTECKT.get(name, ()), W) for W in (1024, 1920, 2560)}
        r0 = {W: M0.seite(t0, VERSTECKT.get(name, ()), W) for W in (1024, 2560)}
        n = sum(1 for c in changes if c[0] == name)
        live = LIVE_1920.get(name)
        print("%-16s %4d   %5d -> %5d px (%+4d %%)%s   %5d -> %5d   %5d -> %5d   %s / %s%s" % (
            name, n, v, r[1920][0], round(100.0 * (r[1920][0] - v) / v), "" if live in (None, v) else " (live gemessen %d)" % live,
            r0[1024][0], r[1024][0], r0[2560][0], r[2560][0], "ja" if r0[1024][1] else "nein", "ja" if r[1024][1] else "nein",
            "  UEBERLAPPUNG " + str(r[1920][2]) if r[1920][2] else ""))
    if raster:
        M2 = Modell(neu, RASTER_NEU)
        print("\nStufe 2 (Raster sy 40, cy/gy 4) zusaetzlich, 1920 px:")
        for name in seiten:
            t1 = next(t for t in M1.tabs if t["name"] == name)
            a, b = M1.seite(t1, VERSTECKT.get(name, ()), 1920)[0], M2.seite(t1, VERSTECKT.get(name, ()), 1920)[0]
            print("  %-16s %5d -> %5d px (%+d %%)" % (name, a, b, round(100.0 * (b - a) / a)))
    print("\nEinzelheiten (Grund: Anzahl; Knoten):")
    for name in seiten + ["alle Seiten"]:
        cs = [c for c in changes if c[0] == name]
        if not cs:
            continue
        print("  %s" % name)
        grp = {}
        for c in cs:
            grp.setdefault(c[5], []).append(c)
        for grund, lst in grp.items():
            det = ", ".join("%s %s %s->%s" % (c[1][:8], c[2], kurz(c[3]), kurz(c[4])) for c in lst[:6]) + (" ..." if len(lst) > 6 else "")
            print("    - %s: %d (%s)" % (grund, len(lst), det))
    print("\nWhitelist-Pruefung: OK. Geaenderte Knoten: %d (%s). Bereits umgesetzt (uebersprungen): %d." % (
        len(ids), ", ".join("%s %d" % kv for kv in sorted(typen.items())), schon))
    nicht_ui = [i for i in ids if not next(n for n in neu if n["id"] == i)["type"].startswith("ui_")]
    print("Nicht-UI-Knoten geaendert: %d. Schluessel: %s. Verdrahtung/Funktionen/MQTT unveraendert." % (
        len(nicht_ui), ", ".join(sorted({c[2] for c in changes}))))


def kurz(v):
    if v == HIDDEN_GRP:
        return "versteckt"
    if v == GUI_TAB:
        return "Tab GUI"
    if isinstance(v, str) and len(v) > 18:
        return "<%d Zeichen>" % len(v)
    if isinstance(v, dict):
        return "{...}"
    return repr(v)


# ---------------------------------------------------------------- Aufruf
def main():
    ap = argparse.ArgumentParser(description="Kompakteres Dashboard (nur Darstellungs-Eigenschaften)")
    ap.add_argument("flows")
    m = ap.add_mutually_exclusive_group(required=True)
    m.add_argument("--dry-run", action="store_true")
    m.add_argument("--apply", action="store_true")
    m.add_argument("--revert", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--sicherung")
    ap.add_argument("--hilfe", choices=("einklappen", "lassen"), default="einklappen")
    ap.add_argument("--raster", action="store_true", help="Stufe 2: ui_base sizes sy 40, cy/gy 4 (alle Seiten, nicht Standard)")
    a = ap.parse_args()
    flows, kompakt = laden(a.flows)
    try:
        if a.revert:
            if not a.sicherung:
                raise Abbruch("--revert braucht --sicherung <datei>")
            S = json.load(open(a.sicherung, encoding="utf-8"))
            N = {n["id"]: n for n in flows}
            rueck, fehler = [], []
            for c in S["aenderungen"]:
                n = N.get(c["id"])
                cur = n.get(c["key"]) if n else None
                if cur == c["alt"]:
                    continue
                if cur != c["neu"]:
                    fehler.append("%s.%s ist %s, erwartet der gepatchte Wert" % (c["id"], c["key"], kurz(cur)))
                    continue
                rueck.append((c["seite"], c["id"], c["key"], c["neu"], c["alt"], "Rueckbau"))
            if fehler:
                raise Abbruch("Rueckbau nicht moeglich:\n  " + "\n  ".join(fehler))
            neu = anwenden(flows, rueck)
            ids, typen = whitelist(flows, neu, raster=any(c[1] == UI_BASE for c in rueck), rueckbau={(c["id"], c["key"]): c["alt"] for c in S["aenderungen"]})
            out = a.out or a.flows.replace(".json", "") + ".zurueck.json"
            schreiben(out, neu, kompakt)
            print("Rueckbau: %d Werte zurueckgesetzt, %d Knoten -> %s" % (len(rueck), len(ids), out))
            print("IDS " + ",".join(ids))
            return 0
        changes, schon = plan(flows, a.hilfe, a.raster)
        neu = anwenden(flows, changes)
        ids, typen = whitelist(flows, neu, a.raster)
        print("ui_kompakt_patch: %s (%d Knoten), Modus %s, Hilfe %s%s" % (a.flows, len(flows), "Probelauf" if a.dry_run else "Anwenden", a.hilfe,
                                                                         ", Raster Stufe 2" if a.raster else ""))
        bericht(flows, neu, changes, schon, ids, typen, a.raster)
        if a.apply:
            out = a.out or a.flows.replace(".json", "") + ".kompakt.json"
            sich = a.sicherung or out.replace(".json", "") + ".sicherung.json"
            schreiben(out, neu, kompakt)
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

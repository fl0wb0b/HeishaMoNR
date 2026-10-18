#!/usr/bin/env python3
"""Design-System v1 – Farben der Kern-Diagramme und Tachos (18.10.2026): eine Palette fuer alle Seiten (wie tools/ui_chart.js der Optimierer-Karten).
Aendert nur die Eigenschaft "colors" der aufgezaehlten ui_chart/ui_gauge-Knoten (Whitelist mit erwartetem Altwert; weicht ein Altwert ab, bricht das
Skript ab). Nutzung: ui_farben_patch.py <flows_v2_export.json> --out <neu.json> [--revert]
Palette: Blau #0094ce (Soll/Haupt), Dunkelblau #1565c0 (Vorlauf), Orange #e65100 (Ruecklauf/Energie), Grau #78909c (Aussen/Hilfslinien),
Gruen #2e7d32 (Waerme/COP), Teal #00897b (Verdichter), Violett #6a1b9a (Strom), Rot #c62828 (Warn), Hellblau #90caf9 (Nebenlinie), Gelb #f9a825."""
import json, sys
B, DB, OR, GR, GN, TE, VI, RT, HB, GE, DK = "#0094ce", "#1565c0", "#e65100", "#78909c", "#2e7d32", "#00897b", "#6a1b9a", "#c62828", "#90caf9", "#f9a825", "#546e7a"
# id: (alt, neu)
CH = {
    "8cb1aceef81045bd": (['#1f77b4', '#aec7e8', '#ff7f0e', '#2ca02c', '#98df8a', '#d62728'], [GR, B, OR, GN, HB, RT]),            # Raumtemperatur: Soll grau, Ist blau
    "9802bf01ebf45d28": (['#1f77b4', '#aec7e8', '#ff7f0e', '#2ca02c', '#98df8a', '#d62728'], [B, OR, DB, GN, HB, RT]),            # Heizen: Soll, Ruecklauf, Vorlauf
    "a1c0b0000c0f0012": (['#2ca02c', '#aec7e8', '#ff7f0e', '#1f77b4', '#98df8a', '#d62728'], [GN, HB, OR, B, HB, RT]),            # COP Heizen
    "a1c0b0000c0f0043": (['#1f77b4', '#aec7e8', '#ff7f0e', '#2ca02c', '#98df8a', '#d62728'], [GR, HB, OR, GN, HB, RT]),           # Aussentemperatur grau wie Optimierer
    "4d5e9a9dacd2b429": (['#1f77b4', '#ff7f0e', '#333333', '#000000', '#000000', '#d62728'], [B, OR, DK, DK, DK, RT]),            # Heizkurve Profil
    "0d58a1e854263ec4": (['#de425b', '#00876c', '#f59b56', '#000000', '#000000', '#d62728'], [GR, B, OR, DK, DK, RT]),            # Zeitverlauf: Aussen grau, Sollwert blau
    "b32f014cb3ec752e": (['#7bd152', '#0011ff', '#b22222', '#dc7f27', '#ffd700', '#ffd700'], [GR, B, RT, OR, GE, GE]),            # Raumregelung: Soll grau, Ist blau, Stufen
    "37ae6fb47a326b5e": (['#1f77b4', '#aec7e8', '#ff7f0e', '#2ca02c', '#98df8a', '#d62728'], [OR, DB, TE, VI, B, RT]),            # Sanftanlauf 24 h: RL, VL, Frequenz, Leisemodus, Soll, Korrektur
    "c48cd6bad07ce428": (['#1f77b4', '#aec7e8', '#ff7f0e', '#2ca02c', '#98df8a', '#d62728'], [OR, DB, TE, VI, B, RT]),            # Sanftanlauf letzte Stunde
    "3d8e357b01de57ff": (['#de425b', '#00876c', '#f59b56', '#2ca02c', '#98df8a', '#d62728'], [B, GR, OR, GN, HB, RT]),            # Pumpendrehzahl: Durchfluss, Max, Modus
    "fa2eba3089ca0ef4": (['#056647', '#d1102b', '#0082cd', '#ff7f0e', '#98df8a', '#d62728'], [GN, VI, RT, OR, HB, RT]),           # Leistung: Waerme gruen, Strom violett, Heizstab rot
    "1cbdb190d6f52cb6": (['#1f77b4', '#aec7e8', '#ff7f0e', '#2ca02c', '#98df8a', '#d62728'], [B, HB, OR, TE, HB, RT]),            # Effizienz: COP, Verdampfer, Abtauen, Strom A
    "eee624aa045ae22a": (['#007585', '#de425b', '#f59b56', '#fff18f', '#89bf77', '#d62728'], [B, OR, GR, GE, GN, RT]),            # COP pro Monat
    "8084f5f9211ba26e": (['#007585', '#de425b', '#f59b56', '#fff18f', '#89bf77', '#d62728'], [GN, OR, GR, GE, B, RT]),            # Waerme pro Monat
    "4eaa2cfa2749c551": (['#00876c', '#de425b', '#f59b56', '#fff18f', '#89bf77', '#d62728'], [GR, OR, B, GE, GN, RT]),            # Gradtage 31 d: Gradtage grau, Energie orange
    "2ee679408e4ccc6f": (['#00876c', '#de425b', '#f59b56', '#fff18f', '#89bf77', '#ffa056'], [GR, OR, B, GE, GN, OR]),            # Gradtage 24 h
    "d30f518b158d8bba": (['#1f77b4', '#ff7f0e', '#ff7f0e', '#2ca02c', '#98df8a', '#d62728'], [VI, GN, OR, GN, HB, RT]),           # Aktuell: Aufnahme violett, Erzeugung gruen
    "bd75ee928fde85b5": (['#00876c', '#f59b56', '#de425b', '#2ca02c', '#98df8a', '#d62728'], [B, OR, DB, GN, HB, RT]),            # Wasser: Durchfluss, T Ruecklauf, T Vorlauf
}
GA = {
    "0e09d25e4fd17042": (['#00b500', '#e6e600', '#ca3838'], [HB, B, DB]),      # Durchfluss
    "91fcc102b422de3b": (['#00b500', '#e6e600', '#ca3838'], [HB, B, DB]),      # Frequenz
    "b6310c926333bd56": (['#de425b', '#f59b56', '#00876c'], [RT, GE, GN]),     # COP
}
def main():
    a = sys.argv[1:]; revert = "--revert" in a; out = a[a.index("--out") + 1]
    d = json.load(open(a[0], encoding="utf-8")); b = {n["id"]: n for n in d["flows"]}; n = 0
    for i, (alt, neu) in list(CH.items()) + list(GA.items()):
        k = b[i]; assert k["type"] in ("ui_chart", "ui_gauge"), i
        von, nach = (neu, alt) if revert else (alt, neu)
        assert k["colors"][:len(von)] == von, (i, k.get("name"), k["colors"])   # die Knoten fuehren 9 Farben, geaendert werden die ersten 6 (3 beim Tacho)
        k["colors"] = nach + k["colors"][len(von):]; n += 1
    json.dump(d, open(out, "w", encoding="utf-8"), ensure_ascii=False); print("rev", d["rev"], n, "Knoten ->", out)
if __name__ == "__main__":
    main()

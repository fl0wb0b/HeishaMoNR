#!/usr/bin/env python3
"""optimizer-tools: Steuerung im Container (nur Standardbibliothek).

Befehle (docker compose run --rm optimizer-tools <befehl> [--tag JJJJ-MM-TT]):
  dienst      Standard: Zeitplan (ZEITPLAN, Standard 06:40) und danach jeweils „nacht“; holt einen verpassten Lauf nach (NACHHOLEN=1)
  nacht       Training (Tag = heute), Gütegrad des Ziel-COP (cop_eta, heute), Replay (gestern), Kennzahlen (gestern), Sicherung der Protokolle, dann status.json
  alles       wie nacht, dazu Kennzahlen aller Tage und Replays der fehlenden Tage (höchstens 31) nachrechnen (Erstinstallation)
  training    nur Training des Anlagen-Zwillings (mit cop_eta)
  cop_eta     nur Gütegrad, dT_verd und Frequenzfaktor des Ziel-COP -> /ergebnis/training/cop_eta.json (cop-ziel 17.10.2026)
  replay      nur Replay der Entscheidungsmaschine für einen Tag (Standard: gestern)
  kennzahlen  nur Tageskennzahlen (Standard: gestern; --alle für alle Tage)
  sicherung   nur die Sicherung der Protokolle nach /ergebnis/sicherung (tar.gz, Allowlist, SICHERUNG_TAGE Tage)
  status      status.json ausgeben
  gesund      Healthcheck (Dienst lebt, Datenordner lesbar)
  hilfe       diese Hilfe

Liest nur aus OT_DATEN (/daten, nur lesend eingehängt), schreibt nur nach OT_ERGEBNIS (/ergebnis). Kein Netz, kein Sprachmodell.
Jede Zeile auf stdout trägt einen Zeitstempel; das Protokoll des letzten Laufs liegt zusätzlich in /ergebnis/letzter-lauf.log.
"""
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tarfile
import threading
import time

APP = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(APP, "tools")
DATEN = os.environ.get("OT_DATEN", "/daten")
ERGEBNIS = os.environ.get("OT_ERGEBNIS", "/ergebnis")
ZEITPLAN = os.environ.get("ZEITPLAN", "06:40")
NACHHOLEN = os.environ.get("NACHHOLEN", "1") == "1"
HERZ = os.environ.get("OT_HERZSCHLAG", "/tmp/optimizer-tools.herz")
VERSION = os.environ.get("OT_VERSION", "dev")
AUFBEWAHREN_TAGE = int(os.environ.get("AUFBEWAHREN_TAGE", "120"))
SICHERUNG_TAGE = int(os.environ.get("SICHERUNG_TAGE", "120"))                 # tägliche Archive so lange behalten ...
SICHERUNG_MONATSERSTE = os.environ.get("SICHERUNG_MONATSERSTE", "1") == "1"   # ... das Archiv vom 1. jedes Monats (enthält den Vormonat komplett) unbegrenzt
SICHERUNG_VORMONAT_TAGE = 7                                                   # Monatsdateien des Vormonats bis zum 7. mitsichern
TIMEOUT = {"training": 1200, "cop_eta": 300, "replay": 600, "kennzahlen": 600, "sicherung": 600}   # Sekunden je Schritt (N100: Training ~1–5 min, Replay ~30 s, Kennzahlen ~5 s, Sicherung ~10 s)
STATUS_FORMAT = 2                                                             # Aufbau von status.json, siehe README „status.json“
# Ergebnisordner auf der NAS: Unterordner im Node-RED-Datenvolume; einmalig anzulegen (ohne root, als node-red):
ANLEGEN_HILFE = "docker exec node_red-node-red-1 sh -c 'mkdir -p /data/optimizer-tools && chmod 2775 /data/optimizer-tools'"
# Allowlist der Sicherung: Monatsdateien (CSV/JSONL) und Zustands-JSON; Geheimnisse ausdrücklich ausgeschlossen (zusätzlich zur Unlesbarkeit, Modus 600)
SICH_MONAT = re.compile(r"^[a-z][a-z0-9-]*-(\d{4})-(\d{2})\.(csv|jsonl)$")
SICH_JSON = re.compile(r"^[a-z][a-z0-9-]*\.json$")
SICH_NIE = re.compile(r"(?i)owm|vrm|cred|secret|token|passw|key|auth")
DATEN_MAX_ALTER_MIN = 30                                           # jüngste Zeile in quiet-*.csv älter → Fehler in status.json (Node-RED schreibt jede Minute)
# Ampel für die Güte des Trainings (ANNAHME, aus den Testwerten 15.10.2026 mit Abstand: TOP16 21,6 W, Vorlauf 0,97 K, Pause Median 7 min)
GUETE_GRENZEN = {"Strom TOP16 RMSE (W)": 40.0, "Wasserkreis RMSE (K)": 1.5, "Pause Median-Fehler (min)": 30.0}
# training-v2 (18.10.2026): Glättung, Bindung in der Dünn-Daten-Phase, Gate Champion gegen Herausforderer (Grenzen wie GUETE_GRENZEN)
TRAINING_GLAETTUNG = os.environ.get("TRAINING_GLAETTUNG", "")      # Anteil der neu gelernten Werte je Nacht; leer = Standard 1/3, "1" = ersetzen
TRAINING_BINDUNG = os.environ.get("TRAINING_BINDUNG", "")          # Gewicht der Bindung an die Vorwerte; leer = Standard 0.1, "0" = aus
TRAINING_GATE_REL = os.environ.get("TRAINING_GATE_REL", "")        # erlaubte relative Verschlechterung je Ampel-Kennzahl; leer = Standard 0.10

_log_datei = None
_kind = None
_stopp = False
_im_lauf = False


class Stopp(Exception):
    """SIGTERM/SIGINT außerhalb eines Laufs: Dienst sofort beenden."""


def jetzt():
    return dt.datetime.now().replace(microsecond=0)


def log(text, art="ot"):
    for zeile in str(text).rstrip("\n").split("\n"):
        z = "%s [%s] %s" % (jetzt().strftime("%Y-%m-%d %H:%M:%S"), art, zeile)
        print(z, flush=True)
        if _log_datei:
            try:
                _log_datei.write(z + "\n")
                _log_datei.flush()
            except OSError:
                pass


def schreibe_atomar(pfad, text):
    os.makedirs(os.path.dirname(pfad), exist_ok=True)
    tmp = "%s.tmp%d" % (pfad, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, pfad)


def lies_json(pfad):
    try:
        with open(pfad, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ------------------------------------------------------------------ Schritte
def schritt(name, cmd):
    """Kindprozess mit Zeitlimit; Ausgabe zeilenweise mit Zeitstempel weiterreichen. Rückgabe (ok, rc, dauer_s, letzte Fehlerzeile)."""
    global _kind
    t = time.time()
    log("Start: " + " ".join(os.path.basename(c) if c.startswith(APP) else c for c in cmd), name)
    letzte_fehler = None
    try:
        _kind = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=APP, start_new_session=True)
    except OSError as e:
        log("Fehler beim Start: %s" % e, name)
        return False, None, 0.0, str(e)
    abgelaufen = threading.Event()
    kind = _kind

    def waechter():                                          # Zeitlimit auch dann, wenn das Kind nichts mehr ausgibt
        abgelaufen.set()
        try:
            os.killpg(kind.pid, signal.SIGKILL)
        except OSError:
            pass
    uhr = threading.Timer(TIMEOUT[name], waechter)
    uhr.daemon = True
    uhr.start()
    try:
        for roh in iter(kind.stdout.readline, b""):
            zeile = roh.decode("utf-8", "replace").rstrip()
            if zeile:
                log(zeile, name)
                if re.search(r"(?i)fehler|error|traceback", zeile):
                    letzte_fehler = zeile[:300]
        rc = kind.wait()
    finally:
        uhr.cancel()
        _kind = None
    if abgelaufen.is_set():
        rc = None
        letzte_fehler = "Zeitlimit %d s überschritten, abgebrochen" % TIMEOUT[name]
        log(letzte_fehler, name)
    dauer = round(time.time() - t, 1)
    ok = rc == 0
    log("Ende: %s nach %.1f s (rc %s)" % ("ok" if ok else "FEHLER", dauer, rc), name)
    return ok, rc, dauer, (None if ok else (letzte_fehler or "rc %s" % rc))


def speicher_spitze_mb():
    """Höchster Speicherverbrauch des Containers seit Start (cgroup v2 memory.peak), None wenn nicht verfügbar."""
    try:
        with open("/sys/fs/cgroup/memory.peak") as f:
            return round(int(f.read().strip()) / 1048576)
    except (OSError, ValueError):
        return None


def heute():
    return dt.date.today()


def tag_arg(argv, standard):
    if "--tag" in argv:
        i = argv.index("--tag")
        if i + 1 >= len(argv) or not re.match(r"^\d{4}-\d{2}-\d{2}$", argv[i + 1]):
            raise SystemExit("--tag JJJJ-MM-TT erwartet")
        return dt.date.fromisoformat(argv[i + 1])
    return standard


def cmd_training(tag):
    c = [sys.executable, os.path.join(TOOLS, "wp_training_nacht.py"), "--daten", DATEN, "--ergebnis", ERGEBNIS, "--tag", tag.isoformat(), "--node", "node"]
    for opt, wert in (("--glaettung", TRAINING_GLAETTUNG), ("--bindung", TRAINING_BINDUNG), ("--gate-rel", TRAINING_GATE_REL)):
        if re.match(r"^\d+(\.\d+)?$", wert.strip()):
            c += [opt, wert.strip()]
    return c


def cmd_cop_eta(tag):
    """cop-ziel 17.10.2026: Guetegrad/dT_verd/Frequenzfaktor des Ziel-COP aus dem 21-Tage-Fenster -> /ergebnis/training/cop_eta.json (opt_nas liest es)."""
    return ["node", os.path.join(TOOLS, "cop_eta.js"), "--daten", DATEN, "--ergebnis", ERGEBNIS, "--tag", tag.isoformat(), "--tage", "21"]


def cmd_replay(tag):
    return ["node", os.path.join(TOOLS, "replay_tag.js"), DATEN, ERGEBNIS, "--tag", tag.isoformat()]


def cmd_sicherung(tag):
    return [sys.executable, os.path.abspath(__file__), "_sicherung", "--tag", tag.isoformat()]


def cmd_kennzahlen(tag, alle=False):
    return [sys.executable, os.path.join(TOOLS, "kennzahlen_tag.py"), "--daten", DATEN, "--ergebnis", ERGEBNIS, "--tag", tag.isoformat()] + (["--alle"] if alle else [])


# ------------------------------------------------------------------ Sicherung der Protokolle
def sicherung_dateien(tag):
    """Dateinamen aus /daten für das Archiv: Monatsdateien des Monats von <tag> (bis zum 7. auch des Vormonats) und Zustands-JSON, nur Allowlist, nur lesbare."""
    monate = {tag.strftime("%Y-%m")}
    if tag.day <= SICHERUNG_VORMONAT_TAGE:
        monate.add((tag.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m"))
    namen, uebersprungen = [], 0
    for f in sorted(os.listdir(DATEN)):
        p = os.path.join(DATEN, f)
        m = SICH_MONAT.match(f)
        erlaubt = (m and "%s-%s" % (m.group(1), m.group(2)) in monate) or (SICH_JSON.match(f) and not m)
        if not erlaubt or SICH_NIE.search(f) or not os.path.isfile(p) or os.path.islink(p):
            uebersprungen += 1
            continue
        if not os.access(p, os.R_OK):
            uebersprungen += 1
            continue
        namen.append(f)
    return namen, uebersprungen


def sha256_datei(pfad):
    h = hashlib.sha256()
    with open(pfad, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def sicherung_ausfuehren(tag):
    """Archiv /ergebnis/sicherung/daten-<tag>.tar.gz (+ .sha256), prüfen (ganz entpacken im Speicher-Strom), alte löschen, letzte.json schreiben."""
    t = time.time()
    ordner = os.path.join(ERGEBNIS, "sicherung")
    os.makedirs(ordner, exist_ok=True)
    namen, uebersprungen = sicherung_dateien(tag)
    if not namen:
        raise RuntimeError("keine Dateien für die Sicherung in %s" % DATEN)
    name = "daten-%s.tar.gz" % tag.isoformat()
    ziel = os.path.join(ordner, name)
    tmp = os.path.join(ordner, ".tmp_" + name)
    inhalt = []
    with tarfile.open(tmp, "w:gz", compresslevel=6, format=tarfile.PAX_FORMAT) as tar:
        for f in namen:
            p = os.path.join(DATEN, f)
            with open(p, "rb") as quelle:                    # Node-RED hängt laufend an: genau die Länge beim Öffnen sichern (vollständige Zeilen bis dahin)
                st = os.fstat(quelle.fileno())
                ti = tarfile.TarInfo(f)
                ti.size, ti.mtime, ti.mode, ti.uid, ti.gid = st.st_size, int(st.st_mtime), 0o644, st.st_uid, st.st_gid
                tar.addfile(ti, quelle)
            inhalt.append({"name": f, "bytes": st.st_size})
    n = 0
    with tarfile.open(tmp, "r:gz") as tar:                   # Prüfung: alles lesen (gzip-CRC), Namen und Längen vergleichen
        for ti in tar:
            daten = tar.extractfile(ti).read()
            if ti.name != inhalt[n]["name"] or len(daten) != inhalt[n]["bytes"]:
                raise RuntimeError("Prüfung des Archivs fehlgeschlagen bei %s" % ti.name)
            n += 1
    if n != len(inhalt):
        raise RuntimeError("Prüfung des Archivs: %d statt %d Dateien" % (n, len(inhalt)))
    os.chmod(tmp, 0o644)
    os.replace(tmp, ziel)
    summe = sha256_datei(ziel)
    schreibe_atomar(ziel + ".sha256", "%s  %s\n" % (summe, name))
    # Aufbewahrung: älter als SICHERUNG_TAGE löschen, Archive vom Monatsersten behalten (SICHERUNG_MONATSERSTE=1)
    grenze = (tag - dt.timedelta(days=SICHERUNG_TAGE)).isoformat()
    geloescht = 0
    for f in sorted(os.listdir(ordner)):
        m = re.match(r"^daten-(\d{4}-\d{2}-(\d{2}))\.tar\.gz(\.sha256)?$", f)
        if m and m.group(1) < grenze and not (SICHERUNG_MONATSERSTE and m.group(2) == "01"):
            os.unlink(os.path.join(ordner, f))
            geloescht += 0 if m.group(3) else 1
    archive = sorted(f for f in os.listdir(ordner) if re.match(r"^daten-\d{4}-\d{2}-\d{2}\.tar\.gz$", f))
    belegt = sum(os.path.getsize(os.path.join(ordner, f)) for f in archive)
    info = {"tag": tag.isoformat(), "datei": "sicherung/" + name, "bytes": os.path.getsize(ziel), "sha256": summe, "dateien": len(inhalt),
            "bytes_roh": sum(x["bytes"] for x in inhalt), "uebersprungen": uebersprungen, "inhalt": inhalt, "geprueft": True,
            "dauer_s": round(time.time() - t, 1), "archive": len(archive), "aeltestes": archive[0][6:16] if archive else None,
            "belegt_mb": round(belegt / 1048576, 1), "geloescht": geloescht}
    schreibe_atomar(os.path.join(ordner, "letzte.json"), json.dumps(info, ensure_ascii=False, indent=1) + "\n")
    print("Sicherung %s: %d Dateien, %.1f MB roh → %.1f MB gepackt, geprüft, sha256 %s…; %d Archive (%.1f MB), %d alte gelöscht, %d Namen übersprungen (anderer Monat oder nicht in der Allowlist)" % (
        name, len(inhalt), info["bytes_roh"] / 1048576, info["bytes"] / 1048576, summe[:16], len(archive), info["belegt_mb"], geloescht, uebersprungen), flush=True)
    return info


# ------------------------------------------------------------------ Status
def datenfrische():
    """Jüngste Zeile in quiet-<monat>.csv (nur das Dateiende lesen); kein Auflisten des Datenordners."""
    p = os.path.join(DATEN, "quiet-%s.csv" % jetzt().strftime("%Y-%m"))
    try:
        with open(p, "rb") as f:
            f.seek(0, 2)
            n = f.tell()
            f.seek(max(0, n - 8192))
            zeilen = f.read().decode("utf-8", "replace").strip().split("\n")
    except OSError:
        return {"datei": os.path.basename(p), "lesbar": False, "juengste_zeile": None, "alter_min": None}
    for z in reversed(zeilen):
        m = re.match(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", z)
        if m:
            t = dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
            return {"datei": os.path.basename(p), "lesbar": True, "juengste_zeile": m.group(1), "alter_min": round((jetzt() - t).total_seconds() / 60, 1)}
    return {"datei": os.path.basename(p), "lesbar": True, "juengste_zeile": None, "alter_min": None}


def guete_ampel(tr):
    if not tr or not tr.get("ok"):
        return "rot"
    g = tr.get("guete_test") or {}
    for k, grenze in GUETE_GRENZEN.items():
        v = g.get(k)
        if v is None or v > grenze:
            return "gelb"
    return "gruen"


def replay_guete(ab):
    """Güte des Replays (Status gleich live) nur, wenn das Maß sauber ist (replay_tag.js v2: Live-Eingänge, gleiche Regelversion); sonst null mit Grund."""
    if not ab:
        return {"bewertbar": False, "prozent": None, "grund": "kein Replay"}
    if "bewertbar" not in ab:                                     # Replay-Datei vor v2: Maß verglich auch verschiedene Regelversionen und 5-min-Raumwerte
        return {"bewertbar": False, "prozent": None, "grund": "Replay-Datei im alten Format (Abgleich ohne Versionsprüfung)"}
    regeln = {rid: {"prozent": g.get("gleichProzent") if g.get("bewertbar") else None, "bewertbar": bool(g.get("bewertbar")),
                    "minuten": g.get("vergleichbar"), "grund": g.get("grund")} for rid, g in (ab.get("regeln") or {}).items()}
    return {"bewertbar": bool(ab.get("bewertbar")), "prozent": ab.get("gleichProzent") if ab.get("bewertbar") else None,
            "grund": ab.get("grund"), "nicht_bewertbar": ab.get("nichtBewertbar") or [], "regeln": regeln,
            "eingang": ab.get("eingang"), "eingang_live_minuten": (ab.get("eingangAusLive") or {}).get("tag")}


def baue_status(lauf=None, dienst=None):
    """status.json (Format 2, Felder im README unter „status.json“). Wird nach jedem Lauf und beim Dienststart neu geschrieben."""
    alt = lies_json(os.path.join(ERGEBNIS, "status.json")) or {}
    S = {"format": STATUS_FORMAT, "version": VERSION, "werkzeug": "optimizer-tools %s" % VERSION, "aktualisiert": jetzt().isoformat(sep=" ")}
    S["dienst"] = dienst or alt.get("dienst")
    S["letzter_lauf"] = lauf or alt.get("letzter_lauf")
    fehler, hinweise = [], []
    tr = lies_json(os.path.join(ERGEBNIS, "training", "letzter.json"))
    S["training"] = None
    if tr:
        S["training"] = {"tag": tr.get("tag"), "ok": tr.get("ok"), "fehler": tr.get("fehler"), "dauer_s": tr.get("dauer_s"), "datei": "training/" + str(tr.get("datei")),
                         "ampel": guete_ampel(tr), "ampel_grenzen": GUETE_GRENZEN, "guete_test": tr.get("guete_test"), "guete_test_vorher": tr.get("guete_test_vorher"),
                         "daten": tr.get("daten"), "drift": {k: (tr.get("drift") or {}).get(k) for k in ("gegen", "werte", "auffaellig", "liste")}}
        # training-v2: Entscheidung Champion/Herausforderer, Glättung/Bindung, Güte je Außentemperatur-Band, Abdeckung (additive Felder; null bei älterem letzter.json)
        S["training"]["entscheidung"] = tr.get("entscheidung")
        S["training"]["glaettung"] = tr.get("glaettung")
        S["training"]["guete_je_band"] = tr.get("guete_je_band")
        S["training"]["abdeckung"] = tr.get("abdeckung")
        if (S["training"]["drift"] or {}).get("auffaellig"):
            hinweise.append("Training: %d Parameter mit auffälliger Drift" % S["training"]["drift"]["auffaellig"])
        if S["training"]["ampel"] == "gelb":
            hinweise.append("Training: Güte gelb (Grenze überschritten)")
        en = tr.get("entscheidung") or {}
        if en.get("ergebnis") == "abgelehnt":
            hinweise.append("Training: neuer Parametersatz abgelehnt, aktiv bleibt %s (%s)" % (en.get("aktiv"), en.get("grund")))
        ab = tr.get("abdeckung") or {}
        if ab.get("hinweis"):
            hinweise.append(ab["hinweis"])
    ce = lies_json(os.path.join(ERGEBNIS, "training", "cop_eta.json"))   # cop-ziel 17.10.2026: Guetegrad des Ziel-COP (Datei liest opt_nas direkt)
    S["cop_eta"] = {"datei": "training/cop_eta.json", "erstellt": ce.get("erstellt"), "tag": ce.get("tag"), "kalibrierminuten": ce.get("kalibrierminuten"),
                    "eta": {b: (x or {}).get("v") for b, x in (ce.get("eta") or {}).items()}, "abtauungen": (ce.get("abtau") or {}).get("n")} if ce else None
    S["replay"], S["kennzahlen"] = None, None
    luecken = {"frische": datenfrische(), "minutenprotokoll": None, "raumfuehler": None}
    for art in ("replay", "kennzahlen"):                          # jüngster Replay- und Kennzahlen-Tag
        o = os.path.join(ERGEBNIS, art)
        tage = sorted(f[:10] for f in (os.listdir(o) if os.path.isdir(o) else []) if re.match(r"^\d{4}-\d{2}-\d{2}\.json$", f))
        if not tage:
            continue
        j = lies_json(os.path.join(o, tage[-1] + ".json")) or {}
        if art == "replay":
            S["replay"] = {"tag": j.get("tag"), "datei": "replay/%s.md" % tage[-1], "minuten": j.get("minuten"), "vorschlaege": len(j.get("vorschlaege") or []),
                           "punkte_eintraege": len(j.get("punkte") or []), "guete": replay_guete(j.get("abgleichLive"))}
            R = j.get("raeume")
            if R is not None:
                luecken["raumfuehler"] = {"tag": j.get("tag"), "raeume": {rid: {"name": x.get("name"), "ungueltig_min": x.get("ungueltig"), "laengste_min": x.get("laengsteMin")} for rid, x in R.items()}}
                for x in R.values():
                    if (x.get("ungueltig") or 0) > 120:
                        hinweise.append("Raumfühler %s: %d min ohne gültigen Wert am %s (längste Lücke %d min)" % (x.get("name"), x["ungueltig"], j.get("tag"), x.get("laengsteMin") or 0))
        else:
            F = j.get("fakten") or {}
            S["kennzahlen"] = {"tag": j.get("tag"), "datei": "kennzahlen/%s.json" % tage[-1], "tag_vollstaendig": j.get("tag_vollstaendig"),
                               "strom_kwh": F.get("energie.strom_kwh"), "waerme_kwh": F.get("energie.waerme_kwh"), "cop": F.get("energie.cop"),
                               "kwh_je_gradstunde": F.get("effizienz.kwh_je_gradstunde"), "abweichung_7t_prozent": F.get("effizienz.abweichung_prozent"),
                               "komfort_gehalten": F.get("komfort.gehalten"), "laeufe": F.get("laeufe.anzahl"), "starts": F.get("laeufe.starts"),
                               "abtauungen": F.get("abtau.anzahl"), "heizstab_min": F.get("heizstab.minuten"), "aussen_mittel": F.get("aussen.mittel"),
                               "befunde": j.get("befunde_anzahl")}
            luecken["minutenprotokoll"] = {"tag": j.get("tag"), "minutenzeilen": F.get("daten.minutenzeilen"), "luecken_ueber_10min": F.get("daten.luecken_ueber_10min"),
                                           "groesste_luecke_min": F.get("daten.groesste_luecke_min"), "liste": j.get("luecken")}
            if F.get("daten.luecken_ueber_10min"):
                hinweise.append("Minutenprotokoll %s: %d Lücken über 10 min (größte %s min)" % (j.get("tag"), F["daten.luecken_ueber_10min"], F.get("daten.groesste_luecke_min")))
    S["datenluecken"] = luecken
    sich = lies_json(os.path.join(ERGEBNIS, "sicherung", "letzte.json"))
    S["sicherung"] = {k: sich.get(k) for k in ("tag", "datei", "bytes", "sha256", "dateien", "bytes_roh", "geprueft", "archive", "aeltestes", "belegt_mb")} if sich else None
    fr = luecken["frische"]
    if fr["lesbar"] is False:
        fehler.append("Datenordner: %s nicht lesbar" % fr["datei"])
    elif fr["alter_min"] is not None and fr["alter_min"] > DATEN_MAX_ALTER_MIN:
        fehler.append("Daten veraltet: jüngste Zeile vor %s min" % fr["alter_min"])
    ll = S.get("letzter_lauf") or {}
    for n, st in (ll.get("schritte") or {}).items():
        if not st.get("ok"):
            fehler.append("%s: %s" % (n, st.get("fehler")))
    S["ok"] = not fehler
    S["fehler"] = fehler
    S["hinweise"] = hinweise
    schreibe_atomar(os.path.join(ERGEBNIS, "status.json"), json.dumps(S, ensure_ascii=False, indent=1) + "\n")
    return S


def aufraeumen():
    """Replay-/Kennzahlen-Tagesdateien älter als AUFBEWAHREN_TAGE löschen (tage.csv bleibt vollständig)."""
    grenze = (heute() - dt.timedelta(days=AUFBEWAHREN_TAGE)).isoformat()
    n = 0
    for art in ("replay", "kennzahlen"):
        o = os.path.join(ERGEBNIS, art)
        for f in os.listdir(o) if os.path.isdir(o) else []:
            if re.match(r"^\d{4}-\d{2}-\d{2}\.(md|json)$", f) and f[:10] < grenze and not (art == "kennzahlen" and f.endswith(".json")):
                os.unlink(os.path.join(o, f))
                n += 1
    return n


# ------------------------------------------------------------------ Läufe
class Sperre:
    """Nur ein Lauf gleichzeitig (auch zwischen Dienst und „docker compose run“: gemeinsame Datei im Ergebnis-Volume)."""
    def __enter__(self):
        os.makedirs(ERGEBNIS, exist_ok=True)
        self.f = open(os.path.join(ERGEBNIS, ".lauf.lock"), "w")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.f.close()
            raise RuntimeError("ein anderer Lauf ist aktiv (.lauf.lock)")
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def ergebnis_schreibbar():
    return os.path.isdir(ERGEBNIS) and os.access(ERGEBNIS, os.W_OK | os.X_OK)


def lauf(art, argv):
    global _log_datei, _im_lauf
    gestern = heute() - dt.timedelta(days=1)
    tag = tag_arg(argv, None)
    plan = []
    if art in ("nacht", "alles", "training"):
        plan.append(("training", cmd_training(tag or heute())))
    if art in ("nacht", "alles", "training", "cop_eta"):
        plan.append(("cop_eta", cmd_cop_eta(tag or heute())))
    if art in ("nacht", "alles", "replay"):
        plan.append(("replay", cmd_replay(tag - dt.timedelta(days=1) if (tag and art != "replay") else (tag or gestern))))
    if art in ("nacht", "alles", "kennzahlen"):
        kt = tag - dt.timedelta(days=1) if (tag and art != "kennzahlen") else (tag or gestern)
        plan.append(("kennzahlen", cmd_kennzahlen(kt, alle=(art == "alles" or "--alle" in argv))))
    if art in ("nacht", "alles", "sicherung"):
        plan.append(("sicherung", cmd_sicherung(tag or heute())))
    if not os.path.isdir(DATEN):
        log("Fehler: Datenordner %s fehlt (Volume nicht eingehängt?)" % DATEN, art)
        return 2
    if not ergebnis_schreibbar():
        log("Fehler: Ergebnisordner %s nicht schreibbar (uid %d, Gruppen %s). Auf der NAS einmalig anlegen: %s" % (ERGEBNIS, os.getuid(), os.getgroups(), ANLEGEN_HILFE), art)
        return 4
    try:
        sperre = Sperre().__enter__()
    except RuntimeError as e:
        log("Abbruch: %s" % e, art)
        return 3
    beginn = jetzt()
    t = time.time()
    _im_lauf = True
    try:
        _log_datei = open(os.path.join(ERGEBNIS, "letzter-lauf.log.tmp"), "w", encoding="utf-8")
        log("Lauf „%s“ beginnt (optimizer-tools %s, Daten %s, Ergebnis %s)" % (art, VERSION, DATEN, ERGEBNIS), art)
        schritte = {}
        for name, cmd in plan:
            if _stopp:
                log("Stopp-Signal: restliche Schritte übersprungen", art)
                break
            ok, rc, dauer, fehler = schritt(name, cmd)
            schritte[name] = {"ok": ok, "rc": rc, "dauer_s": dauer, "fehler": fehler, "tag": cmd[cmd.index("--tag") + 1]}
        if art == "alles" and not _stopp:                    # fehlende Replays nachholen (höchstens 31 Tage zurück)
            o = os.path.join(ERGEBNIS, "replay")
            fertig = set(f[:10] for f in os.listdir(o)) if os.path.isdir(o) else set()
            ende = (tag - dt.timedelta(days=1)) if tag else gestern
            for i in range(1, 32):
                x = ende - dt.timedelta(days=i)
                if x.isoformat() in fertig or not os.path.isfile(os.path.join(DATEN, "quiet-%s.csv" % x.strftime("%Y-%m"))) or _stopp:
                    continue
                ok, rc, dauer, fehler = schritt("replay", cmd_replay(x))
                if not ok and "keine Minutenzeilen" in str(fehler):
                    break                                    # vor Beginn der Protokolle
        n = aufraeumen()
        if n:
            log("%d alte Tagesdateien gelöscht (älter als %d Tage)" % (n, AUFBEWAHREN_TAGE), art)
        ll = {"art": art, "beginn": beginn.isoformat(sep=" "), "ende": jetzt().isoformat(sep=" "), "dauer_s": round(time.time() - t, 1),
              "ok": all(s["ok"] for s in schritte.values()), "speicher_spitze_mb": speicher_spitze_mb(), "schritte": schritte}
        S = baue_status(lauf=ll)
        log("Lauf „%s“ fertig in %.1f s (Speicher-Spitze des Containers %s MB): %s%s" % (art, ll["dauer_s"], ll["speicher_spitze_mb"], "ok" if ll["ok"] else "mit Fehlern",
                                                  ("; status.json: " + "; ".join(S["fehler"])) if S["fehler"] else ""), art)
        return 0 if ll["ok"] else 1
    finally:
        _im_lauf = False
        if _log_datei:
            _log_datei.close()
            os.replace(os.path.join(ERGEBNIS, "letzter-lauf.log.tmp"), os.path.join(ERGEBNIS, "letzter-lauf.log"))
            _log_datei = None
        sperre.__exit__()


# ------------------------------------------------------------------ Dienst (Zeitplan)
def zeiten():
    out = []
    for z in ZEITPLAN.split(","):
        m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*$", z)
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
            raise SystemExit("ZEITPLAN ungültig: %r (HH:MM[,HH:MM])" % ZEITPLAN)
        out.append(dt.time(int(m.group(1)), int(m.group(2))))
    return sorted(out)


def naechster(nach):
    for tage in range(0, 3):
        d = nach.date() + dt.timedelta(days=tage)
        for z in zeiten():
            k = dt.datetime.combine(d, z)
            if k > nach:
                return k
    raise RuntimeError("kein nächster Termin")


def herz():
    try:
        with open(HERZ, "w") as f:
            f.write(jetzt().isoformat())
    except OSError:
        pass


def herz_faden():
    """Herzschlag alle 30 s, auch während eines Laufs (jeder Schritt hat ein Zeitlimit)."""
    while not _stopp:
        herz()
        time.sleep(30)


def beende(sig, _frame):
    """Im Lauf: laufenden Schritt beenden, restliche überspringen, status.json noch schreiben. Sonst: sofort aufhören."""
    global _stopp
    _stopp = True
    if _kind is not None:
        try:
            os.killpg(_kind.pid, signal.SIGTERM)
        except OSError:
            pass
    if not _im_lauf:
        raise Stopp()


def dienst():
    signal.signal(signal.SIGTERM, beende)
    signal.signal(signal.SIGINT, beende)
    gestartet = jetzt()
    log("Dienst startet: Zeitplan %s (Europe/Berlin, jetzt %s), Daten %s (nur lesen), Ergebnis %s, Nachholen %s" % (
        ZEITPLAN, gestartet.strftime("%H:%M"), DATEN, ERGEBNIS, "an" if NACHHOLEN else "aus"), "dienst")
    if not os.path.isdir(DATEN):
        log("Warnung: Datenordner %s fehlt; Läufe brechen ab, bis er eingehängt ist" % DATEN, "dienst")
    if not ergebnis_schreibbar():
        log("Warnung: Ergebnisordner %s nicht schreibbar; Läufe brechen ab (rc 4). Einmalig anlegen: %s" % (ERGEBNIS, ANLEGEN_HILFE), "dienst")
    plan = naechster(gestartet)
    alt = (lies_json(os.path.join(ERGEBNIS, "status.json")) or {}).get("letzter_lauf") or {}
    erster_heute = dt.datetime.combine(gestartet.date(), zeiten()[0])
    if NACHHOLEN and gestartet > erster_heute and str(alt.get("beginn", ""))[:10] != gestartet.date().isoformat():
        log("Lauf von heute %s fehlt: wird jetzt nachgeholt" % erster_heute.strftime("%H:%M"), "dienst")
        plan = gestartet
    dienst_info = {"gestartet": gestartet.isoformat(sep=" "), "zeitplan": ZEITPLAN, "naechster_lauf": plan.isoformat(sep=" ")}
    try:
        baue_status(dienst=dienst_info)
    except OSError as e:
        log("Warnung: status.json nicht schreibbar: %s" % e, "dienst")
    log("Nächster Lauf: %s" % plan.strftime("%Y-%m-%d %H:%M"), "dienst")
    threading.Thread(target=herz_faden, daemon=True).start()
    try:
        while not _stopp:
            if jetzt() >= plan:
                try:
                    lauf("nacht", [])
                except Exception as e:                           # Dienst läuft weiter, Fehler steht im Log und in status.json
                    log("Fehler im Lauf: %s" % e, "dienst")
                if _stopp:
                    break
                plan = naechster(jetzt())
                dienst_info["naechster_lauf"] = plan.isoformat(sep=" ")
                try:
                    baue_status(dienst=dienst_info)
                except OSError:
                    pass
                log("Nächster Lauf: %s" % plan.strftime("%Y-%m-%d %H:%M"), "dienst")
                continue
            time.sleep(max(1.0, min(30.0, (plan - jetzt()).total_seconds())))
    except Stopp:
        pass
    log("Dienst beendet (Signal)", "dienst")
    return 0


def gesund():
    """0 = gesund: Herzschlag jünger als 3 min (oder ein Lauf hält die Sperre) und Datenordner lesbar."""
    try:
        alter = time.time() - os.path.getmtime(HERZ)
    except OSError:
        print("kein Herzschlag (Dienst läuft nicht?)")
        return 1
    if alter > 180:
        print("Herzschlag %d s alt" % alter)
        return 1
    if not os.access(DATEN, os.R_OK | os.X_OK):
        print("Datenordner %s nicht lesbar" % DATEN)
        return 1
    if not ergebnis_schreibbar():
        print("Ergebnisordner %s nicht schreibbar" % ERGEBNIS)
        return 1
    print("gesund")
    return 0


def main(argv):
    befehl = argv[1] if len(argv) > 1 else "dienst"
    if befehl == "dienst":
        return dienst()
    if befehl == "_sicherung":                                   # interner Schritt (Kindprozess von lauf(), Sperre hält der Elternprozess)
        try:
            sicherung_ausfuehren(tag_arg(argv[2:], heute()))
        except (OSError, RuntimeError, tarfile.TarError) as e:
            print("Fehler: Sicherung: %s" % e, flush=True)
            return 1
        return 0
    if befehl in ("nacht", "alles", "training", "cop_eta", "replay", "kennzahlen", "sicherung"):
        signal.signal(signal.SIGTERM, beende)
        return lauf(befehl, argv[2:])
    if befehl == "status":
        S = lies_json(os.path.join(ERGEBNIS, "status.json"))
        print(json.dumps(S, ensure_ascii=False, indent=1) if S else "noch kein status.json")
        return 0 if S else 1
    if befehl == "gesund":
        return gesund()
    print(__doc__)
    return 0 if befehl in ("hilfe", "-h", "--help") else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

// Erzeugt die Tabellen der Doku (Regelwerk, Schwellen mit Herkunft, Sperren, Whitelist, Bewertung) direkt aus tools/engine_core.js.
// docs/OPTIMIERER.md enthaelt diese Ausgabe zwischen den Markierungen <!-- ENGINE-TABELLEN --> ... <!-- /ENGINE-TABELLEN -->;
// tools/engine_sim.js prueft, dass sie aktuell ist.   Usage: node tools/engine_doc.js
const E = require('./engine_core.js');
function esc(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function tabellen() {
    const L = [];
    L.push('### Regeln (Version, Art, Befehl, Prognose)', '');
    L.push('| Regel | Version | Art | Stellgröße / Befehl | Richtung | Prognose (p, Horizonte) | Sperren |', '|---|---|---|---|---|---|---|');
    const prog = P => esc(P.text) + ' – p = ' + String(P.p).replace('.', ',') + ', ' + P.h.join('/') + ' min';
    E.RULES.forEach(R => L.push('| ' + [R.name + ' (`' + R.id + '`)', R.ver, R.art, R.hebel ? Object.keys(R.hebel).map(k => '`' + R.hebel[k].name + '`').join(' oder ') : '`' + R.befehl.name + '`',
                                        R.richtung + (R.hebel ? ' / soll_hoch' : ''), prog(R.prognose) + (R.prognoseKurve ? '; Hebel +1 K: ' + prog(R.prognoseKurve) : '') + (R.prognoseMinus ? '; −1 K: ' + prog(R.prognoseMinus) : ''), R.sperren.join(', ')].join(' | ') + ' |'));
    if (E.STILLGELEGT && E.STILLGELEGT.length) {
        L.push('', '*Stillgelegt (nicht mehr im Regelwerk; Summen, Basisraten und Punkteverlauf bleiben unter ihrem Schlüssel stehen, offene Fälle enden beim Laden ohne Buchung):*', '', '| Regel | Version | seit | Grund |', '|---|---|---|---|');
        E.STILLGELEGT.forEach(x => L.push('| ' + esc(x.name) + ' (`' + x.id + '`) | ' + x.ver + ' | ' + x.seit + ' | ' + esc(x.grund) + ' |'));
    }
    E.RULES.forEach(R => {
        L.push('', '#### ' + R.name + ' (`' + R.id + '` v' + R.ver + ')', '', '*Zweck:* ' + esc(R.zweck), '', '*Eingänge:* ' + R.eingaenge.join(', '), '');
        L.push('| Schwelle | Standard | Einheit | Herkunft |', '|---|---|---|---|');
        R.schwellen.forEach(s => L.push('| `' + s.key + '` | ' + String(s.std).replace('.', ',') + ' | ' + s.einheit + ' | ' + esc(s.herkunft) + ' |'));
        L.push('', '*Erwartung:* ' + esc(R.erwartung), '', '*Rückweg:* ' + esc(R.rueckweg));
        if (R.kalibriert.length) { L.push('', '*Kalibriermessungen (Wirkungsfälle dort zählen 0 Punkte):* ' + R.kalibriert.join(', ')); }
    });
    L.push('', '### Takt-Messung (Schwellen, `cfg.takt`)', '', '| Schwelle | Standard | Einheit | Herkunft |', '|---|---|---|---|');
    E.TAKT_SCHWELLEN.forEach(s => L.push('| `' + s.key + '` | ' + String(s.std).replace('.', ',') + ' | ' + s.einheit + ' | ' + esc(s.herkunft) + ' |'));
    L.push('', '### COP: Ziel und Ist (Parameter, `cfg.copZiel` aus cop_eta.json)', '', '| Parameter | Standard | Einheit | Herkunft |', '|---|---|---|---|');
    E.CZ_PARAM.forEach(s => L.push('| `' + s.key + '` | ' + String(s.std).replace('.', ',') + ' | ' + s.einheit + ' | ' + esc(s.herkunft) + ' |'));
    L.push('', '| Posten | Herkunft |', '|---|---|');
    E.CZ_POSTEN.forEach(x => L.push('| ' + x[1] + ' (`' + x[0] + '`) | ' + esc(E.CZ_HERKUNFT[x[0]]) + ' |'));
    L.push('', '### Sperren, die jede Regel erbt', '', '| Sperre | Text | Herkunft |', '|---|---|---|');
    E.LOCKS.forEach(l => L.push('| `' + l.id + '` | ' + esc(l.text) + ' | ' + esc(l.herkunft) + ' |'));
    L.push('', '*Sperr-Parameter (Standard):* ' + Object.keys(E.LOCK_CFG).map(k => '`' + k + '` ' + String(E.LOCK_CFG[k]).replace('.', ',')).join(' · '));
    L.push('', '### Whitelist der Übernahme', '', '| Befehl | Topic | erlaubte Werte | Rücklesen |', '|---|---|---|---|');
    Object.keys(E.WHITELIST).forEach(k => { const W = E.WHITELIST[k]; L.push('| `' + k + '` | `' + W.topic + '` | ' + W.werte.join(', ') + ' | ' + W.text + (W.heizkurve ? ' (nur Heizkurvenmodus TOP76 = 0, Wasserfühler TOP111 = 0)' : '') + ' |'); });
    L.push('', '*Übernahme-Grenzen:* ' + Object.keys(E.APPLY).map(k => '`' + k + '` ' + String(E.APPLY[k]).replace('.', ',')).join(' · '));
    L.push('', '### Bewertungsregeln (Version ' + E.SCORE_VER + ')', '');
    const S = E.SCORE;
    L.push('| Größe | Wert |', '|---|---|');
    L.push('| Punkte je Horizont | ' + S.brierFaktor + ' × [(b − o)² − (p − o)²] / Anzahl Horizonte |');
    L.push('| Basisrate b | aus Vergleichslagen „bleibt, wie es ist“, (k + 1)/(n + 2), erst ab ' + S.baseMinN + ' Vergleichen, vorher 0,5 |');
    L.push('| Mindestbeobachtung je Horizont | ' + String(S.teilMin).replace('.', ',') + ' des Horizonts, sonst neutral |');
    L.push('| Problem besteht / gelöst | ≥ ' + Math.round(S.trefferAnteil * 100) + ' % / ≤ ' + Math.round((1 - S.trefferAnteil) * 100) + ' % der gültigen Minuten, dazwischen neutral |');
    L.push('| Wirkungsprognose | je Größe ±' + S.wirkung + ', nicht messbar 0, Kalibriermessung 0; seit v6 Naturexperiment (Änderung ohne übernommenen Vorschlag der Regel, z. B. von Hand) 0 Punkte, getrennt gezählt |');
    L.push('| Schaden | ' + Object.keys(S.schaden).map(k => k + ' ' + S.schaden[k]).join(', ') + ' |');
    L.push('| Verpasst | ' + S.verpasst + ' (gezählt werden nur Minuten, in denen die Regel nicht durch eine eigene Sperre zurückgehalten wurde) |');
    const VS = S.verpasstSperre, own = {abstand: 'Mindestabstand (`gapMin`)', tageslimit: 'Tageslimit (`proTag`)', abkuehlzeit: 'Wartezeit (`pauseMin`)', haltezeit: 'Haltezeit (`haltMin`)', stabil: 'Stabilitätszeit (`stabilMin`)'};
    const dmg = {komfort: 'Raum > ' + String(VS.komfortK).replace('.', ',') + ' K unter Minimum', takt: 'Verdichter stoppt', ueberschwingen: 'Vorlauf ≥ Soll +' + String(E.LOCK_CFG.stopK).replace('.', ',') + ' K'};
    L.push('| Verpasst während eigener Sperre (seit v2) | 0 Punkte, getrennt gezählt (`verpasst_sperre`); eigene Sperren: ' + VS.eigene.map(k => own[k]).join(', ') + '; nur soweit sie auch mit dem Standardwert bestanden hätten |');
    L.push('| Schaden hebt die Entschuldigung auf (seit v2) | ' + Object.keys(VS.schaden).map(k => k + ': ' + VS.schaden[k].map(x => dmg[x]).join(', ')).join('; ') + ' → verpasst ' + S.verpasst + ' |');
    L.push('| Gegenregel-Sperren (seit v3) | 0 Punkte wie eigene Sperren: ' + VS.gegenregel.map(k => '`' + k + '`').join(', ') + ' (Arbitrierung der Verschiebung, seit 13.10. auch der Quiet-Stufe; nur mit den Standardwerten `shiftHaltMin`/`gegenMin` bzw. `quietHaltMin`/`quietGegenMin`); schlägt eine andere Verschiebungs-Regel für die Lage dieselbe Richtung vor, gilt sie als versorgt |');
    L.push('| Basisrate je Auslösung (seit 13.10.) | Regeln mit neuer Auslösung lernen ihre Basisrate unter eigenem Schlüssel neu: ' + E.RULES.filter(R => R.basis).map(R => '`' + R.basis + '`' + (R.basisKurve ? ' und `' + R.basisKurve + '` (Hebel +1 K)' : '') + (R.basisMinus ? ' und `' + R.basisMinus + '` (−1 K)' : '')).join(', ') + '; die Vergleichslagen folgen der neuen Auslösung (Freigabe: am Deckel der Stufe mit Rückstand und Bedarf; Deckel: ab der Schwelle der Regel – v5: 28 Hz, mit Takt 22 Hz – ab Laufminute 15 über 3 °C; +1 K: Takt belegt unter 22 Hz; Raumeinfluss v3: Raumlage ohne Haltezeit, je Richtung). Die alten Basisraten bleiben unter ihrem Schlüssel stehen |');
    L.push('| Zuordnung (seit v3) | Fälle gehören der Regel, die vorgeschlagen hat; die Wirkung einer übernommenen Verschiebung zählt für die Regel, deren Vorschlag übernommen wurde; für alle anderen offenen Fälle ist die Übernahme ein Eingriff (neutral, seit 13.10. auch bei Quiet mit Urheber im Text) |');
    L.push('| Hinweis-Regeln (seit v4) | keine Punkte: Treffer, Fehlalarm, neutral und Schaden werden gezählt und angezeigt, Punkte, Brier-Skill und Freigabereife entfallen („–“), nicht im Diagramm' + (E.RULES.some(R => R.art === 'hinweis') ? '' : ' (seit dem Review-Paket 13.10. keine aktive Hinweis-Regel)') + ' |');
    L.push('| Brier-Skill (seit v4) | 1 − ΣBS/ΣBS_ref nur aus vollständig abgeschlossenen Fällen (ein offener Fall verändert ihn nicht), erst ab ' + S.skillMinFaelle + ' bewerteten Fällen, vorher „–“; seit v5 nur Fälle mit Brier-Beitrag (mindestens ein Horizont nicht neutral) |');
    L.push('| Basisrate ≥ Prognose (seit v5) | je Horizont mit b ≥ p: Treffer neutral (0 Punkte, kein Beitrag zum Skill, Kennzahl „davon … Treffer neutral“); Fehlalarm Abzug gegen b = ' + String(S.fehlRefB).replace('.', ',') + ': 100 × [' + String(S.fehlRefB).replace('.', ',') + '² − p²] (p 0,7 → −24, p 0,8 → −39, geteilt durch die Anzahl Horizonte); b < p: Brier wie oben |');
    L.push('| Raumwerte in der Bewertung | bis ' + S.raumAlterMax + ' min alt (Shelly melden nur bei Änderung) |');
    L.push('| Eingriffe (Bewertung wird ab dort neutral) | Quiet, Verschiebung oder Soll (≥ 2 K) geändert; Komfortband geändert; Lüftungsverdacht (Raum fällt ≥ ' + String(S.lueftungK).replace('.', ',') + ' K in ≤ 60 min) |');
    L.push('| Fremdursachen der Raum-Gegenprobe (seit v6) | Lüftungsverdacht auf dem geglätteten Raumwert ab ' + String(S.lueftungEmaK).replace('.', ',') + ' K in ≤ 60 min (≈ ≥ 1 K Rohwert; Räume mit eigener Nachheizung ab ' + String(S.lueftungK).replace('.', ',') + ' K), im ganzen Horizont und mit ' + S.lueftVorMin + ' min Vorgeschichte; „gelöst“ (o = 0) ist neutral, wenn vor der Lösung bei +1 K mindestens ' + S.sonneMin + ' min Sonne (Sonnenzeichen der Regel) bzw. bei −1 K mindestens ' + S.heizgrenzeMin + ' min Heizgrenze-Aus lag; gilt auch für die Vergleichslagen der Basisrate |');
    L.push('| Freigabereife: Wirkung (seit v6) | Wirkungsfälle aus Übernahmen und Naturexperimente desselben Befehls (ohne die Gegenprobe „ohne Bedarf“) zählen zusammen, getrennt ausgewiesen; Naturexperimente bringen keine Punkte |');
    L.push('| Freigabereife (nur Anzeige) | ≥ ' + S.reife.faelle + ' bewertete Fälle, ≥ ' + S.reife.tage + ' Tage, Brier-Skill ≥ ' + String(S.reife.skill).replace('.', ',') + ', 0 × Schaden, ≤ ' + S.reife.verpasst + ' × verpasst, ≥ ' + S.reife.wirkFaelle + ' Wirkungsfälle mit Punkten > 0 (ohne Kalibrierung) |');
    return L.join('\n');
}
module.exports = {tabellen: tabellen};
if (require.main === module) { console.log(tabellen()); }

// Erzeugt die Tabellen der Doku (Regelwerk, Schwellen mit Herkunft, Sperren, Whitelist, Bewertung) direkt aus tools/engine_core.js.
// docs/OPTIMIERER.md enthaelt diese Ausgabe zwischen den Markierungen <!-- ENGINE-TABELLEN --> ... <!-- /ENGINE-TABELLEN -->;
// tools/engine_sim.js prueft, dass sie aktuell ist.   Usage: node tools/engine_doc.js
const E = require('./engine_core.js');
function esc(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function tabellen() {
    const L = [];
    L.push('### Regeln (Version, Art, Befehl, Prognose)', '');
    L.push('| Regel | Version | Art | Stellgröße / Befehl | Richtung | Prognose (p, Horizonte) | Sperren |', '|---|---|---|---|---|---|---|');
    E.RULES.forEach(R => L.push('| ' + [R.name + ' (`' + R.id + '`)', R.ver, R.art, '`' + R.befehl.name + '`', R.richtung, esc(R.prognose.text) + ' – p = ' + String(R.prognose.p).replace('.', ',') + ', ' + R.prognose.h.join('/') + ' min', R.sperren.join(', ')].join(' | ') + ' |'));
    E.RULES.forEach(R => {
        L.push('', '#### ' + R.name + ' (`' + R.id + '` v' + R.ver + ')', '', '*Zweck:* ' + esc(R.zweck), '', '*Eingänge:* ' + R.eingaenge.join(', '), '');
        L.push('| Schwelle | Standard | Einheit | Herkunft |', '|---|---|---|---|');
        R.schwellen.forEach(s => L.push('| `' + s.key + '` | ' + String(s.std).replace('.', ',') + ' | ' + s.einheit + ' | ' + esc(s.herkunft) + ' |'));
        L.push('', '*Erwartung:* ' + esc(R.erwartung), '', '*Rückweg:* ' + esc(R.rueckweg));
        if (R.kalibriert.length) { L.push('', '*Kalibriermessungen (Wirkungsfälle dort zählen 0 Punkte):* ' + R.kalibriert.join(', ')); }
    });
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
    L.push('| Wirkungsprognose | je Größe ±' + S.wirkung + ', nicht messbar 0, Kalibriermessung 0 |');
    L.push('| Schaden | ' + Object.keys(S.schaden).map(k => k + ' ' + S.schaden[k]).join(', ') + ' |');
    L.push('| Verpasst | ' + S.verpasst + ' |');
    L.push('| Raumwerte in der Bewertung | bis ' + S.raumAlterMax + ' min alt (Shelly melden nur bei Änderung) |');
    L.push('| Eingriffe (Bewertung wird ab dort neutral) | Quiet, Verschiebung oder Soll (≥ 2 K) geändert; Komfortband geändert; Lüftungsverdacht (Raum fällt ≥ ' + String(S.lueftungK).replace('.', ',') + ' K in ≤ 60 min) |');
    L.push('| Freigabereife (nur Anzeige) | ≥ ' + S.reife.faelle + ' bewertete Fälle, ≥ ' + S.reife.tage + ' Tage, Brier-Skill ≥ ' + String(S.reife.skill).replace('.', ',') + ', 0 × Schaden, ≤ ' + S.reife.verpasst + ' × verpasst, ≥ ' + S.reife.wirkFaelle + ' Wirkungsfälle mit Punkten > 0 (ohne Kalibrierung) |');
    return L.join('\n');
}
module.exports = {tabellen: tabellen};
if (require.main === module) { console.log(tabellen()); }

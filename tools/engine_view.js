// == ENGINE-VIEW ==
// Anzeige der Entscheidungsmaschine (Seite "Optimierer"): reine Funktionen, die aus Zustand und letzter Auswertung die Karten-Daten bauen.
// Wird vom Generator hinter den Kern in opt_engine eingebettet und in tools/engine_sim.js sowie tools/engine_ui_preview.js direkt getestet.
//   ENGVIEW.track(V, res, rules, now)   Episoden fuer die Karte "Entscheidungen": je Regel ein Eintrag von "alle Bedingungen erfuellt" (wartet,
//                                       gesperrt, Vorschlag) bis zum Ende; Dauerzustaende ("prueft", "ruht") erzeugen keine Zeilen
//   ENGVIEW.build(o)                    -> {card, rules, score, mess, log}
var ENGVIEW = (function (E) {
    var MIN = 60000;
    var STAGE = {wartet: 1, gesperrt: 2, abgelaufen: 3, vorschlag: 3, hinweis: 3};
    var COL = {quiet_freigabe: '#1976d2', quiet_strecken: '#00897b', raum_offset: '#ef6c00', heizgrenze_hinweis: '#8e24aa', vorausschau: '#6d4c41'};   // heizgrenze_hinweis: stillgelegt (alte Episoden behalten ihre Farbe)
    var CHIP = {vorschlag: 'Vorschlag', hinweis: 'Hinweis', wartet: 'wartet', gesperrt: 'gesperrt', bereit: 'prüft', inaktiv: 'ruht', abgelaufen: 'abgelaufen'};
    var CLS = {vorschlag: 'act', hinweis: 'act', wartet: 'warn', gesperrt: 'warn', bereit: 'mute', inaktiv: 'mute', abgelaufen: 'mute'};
    var LK = {}; E.LOCKS.forEach(function (l) { LK[l.id] = l.kurz; });
    function have(v) { return typeof v === 'number' && isFinite(v); }
    function hm(ts) { return ts ? E.hhmm(ts) : '–'; }
    function p2(x) { return (x < 10 ? '0' : '') + x; }
    function dm(ts) { var d = new Date(ts); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.'; }
    function dg(u) { return (u === 'min' || u === 'Hz' || u === 'W') ? 0 : 1; }
    function dur(m) { return !have(m) ? '–' : (m < 120 ? E.de(m, 0) + ' min' : Math.floor(m / 60) + ' h ' + p2(Math.round(m % 60)) + ' min'); }
    function num2(v, s, u) { return E.de(v, Number.isInteger(v) && Number.isInteger(s) ? 0 : dg(u)); }
    function clamp(x) { return Math.max(0, Math.min(1, x)); }
    function isDaten(r) { return r.st === 'gesperrt' && r.naechste && r.naechste.b === 'daten'; }
    function short(t) { return String(t || '').replace(/^kein Vorschlag: /, '').replace(/^Bedingung entfallen: /, '').replace(/^würde schalten, aber gesperrt: /, '').replace(/^gesperrt: /, '').replace(/\s*\([^()]*\)\s*$/, ''); }
    function endeText(r) {                                                          // Ende einer Episode: bei Dauersperre (Modell-Gate) zaehlt die fehlende Bedingung nach "außerdem"
        var g = String(r.ende || (isDaten(r) ? 'keine HeishaMon-Daten' : r.grund) || ''), i = g.indexOf('; außerdem ');
        return short(r.dauer && i >= 0 ? g.slice(i + 11) : g);
    }
    function ohneKlammern(t) { return String(t || '').replace(/\s*\([^()]*\)/g, '').replace(/\s+([,;.])/g, '$1').trim(); }   // Kernaussage; der volle Text steht im Tooltip

    // ---------------------------------------------------------------- Episoden
    function track(V, res, rules, now) {
        V.ep = Array.isArray(V.ep) ? V.ep : []; V.open = V.open || {};
        res.forEach(function (r) {
            var rel = STAGE[r.st] && !isDaten(r) && !r.dauer, op = V.open[r.id];          // Modell-Gate mit fehlender Bedingung: Dauerzustand, keine Zeile
            if (rel) {
                var lock = r.st === 'gesperrt' && r.naechste ? r.naechste.b : '', pr = rules && rules[r.id] && rules[r.id].prop;
                if (!op) { op = V.open[r.id] = {id: r.id, t0: now, t1: now, st: []}; }
                var last = op.st[op.st.length - 1];
                if (!last || last[0] !== r.st || last[2] !== lock) { op.st.push([r.st, now, lock, (r.st === 'vorschlag' || r.st === 'hinweis') && pr ? pr.was : '']); if (op.st.length > 8) { op.st.splice(1, op.st.length - 8); } }
                op.t1 = now;
            } else if (op) {
                op.t1 = now; op.end = endeText(r);
                V.ep.push(op); delete V.open[r.id];
            }
        });
        Object.keys(V.open).forEach(function (id) {                                   // Regel nicht mehr im Regelwerk (stillgelegt, Review-Paket 13.10.2026): offene Episode beenden
            if (!res.some(function (r) { return r.id === id; })) { var op = V.open[id]; op.t1 = now; op.end = 'Regel stillgelegt'; V.ep.push(op); delete V.open[id]; }
        });
        if (V.ep.length > 100) { V.ep = V.ep.slice(-100); }
        return V;
    }
    function maxStage(ep) { return ep.st.reduce(function (a, s) { return Math.max(a, STAGE[s[0]] || 0); }, 0); }
    function logRows(V, now, n) {
        var all = (V.ep || []).concat(Object.keys(V.open || {}).map(function (k) { return V.open[k]; }));
        all = all.filter(function (ep) { return maxStage(ep) >= 2 || ep.t1 - ep.t0 >= 5 * MIN; }).sort(function (a, b) { return b.t0 - a.t0; }).slice(0, n || 12);
        return all.map(function (ep) {
            var R = E.RULE[ep.id] || {}, open = !ep.end && V.open && V.open[ep.id] === ep;
            var steps = ep.st.map(function (s) {
                var t = CHIP[s[0]] || s[0];
                if (s[0] === 'gesperrt' && s[2]) { t += ': ' + (LK[s[2]] || s[2]); }
                if (s[0] === 'vorschlag' || s[0] === 'hinweis') { t += ' ' + hm(s[1]); }
                return [t, CLS[s[0]] || 'mute'];
            });
            var prop = ep.st.filter(function (s) { return s[3]; })[0];
            return {t: dm(ep.t0) + ' ' + hm(ep.t0) + (ep.t1 > ep.t0 ? '–' + hm(ep.t1) : ''), dauer: Math.round((ep.t1 - ep.t0) / MIN), n: R.kurz || ep.id, c: COL[ep.id] || '#607d8b',
                    steps: steps, was: prop ? prop[3] : '', ende: open ? 'läuft' : (ep.end || ''), offen: open};
        });
    }
    function letzterVorschlag(V) {                                                   // juengste Episode mit Vorschlag oder Hinweis (Karte "Aktueller Vorschlag" ohne Vorschlag)
        var all = ((V && V.ep) || []).concat(Object.keys((V && V.open) || {}).map(function (k) { return V.open[k]; }));
        var best = null, bs = null;
        all.forEach(function (ep) { ep.st.forEach(function (s) { if ((s[0] === 'vorschlag' || s[0] === 'hinweis') && (!bs || s[1] > bs[1])) { best = ep; bs = s; } }); });
        if (!best) { return null; }
        var R = E.RULE[best.id] || {}, open = !best.end && V.open && V.open[best.id] === best;
        return {name: R.kurz || best.id, c: COL[best.id] || '#607d8b', was: bs[3] || '', t: dm(bs[1]) + ' ' + hm(bs[1]) + (best.t1 > bs[1] ? '–' + hm(best.t1) : ''), ende: open ? 'läuft' : (best.end || '')};
    }
    function zaehle24h(V, now) {                                                    // Vorschlaege und Hinweise, die in den letzten 24 h begannen
        var all = ((V && V.ep) || []).concat(Object.keys((V && V.open) || {}).map(function (k) { return V.open[k]; })), n = {vorschlag: 0, hinweis: 0};
        all.forEach(function (ep) { ep.st.forEach(function (s) { if ((s[0] === 'vorschlag' || s[0] === 'hinweis') && s[1] >= now - 24 * 60 * MIN) { n[s[0]]++; } }); });
        return n;
    }

    // ---------------------------------------------------------------- Regelkacheln
    function lineOf(r, prop, now) {
        var n = r.naechste || {};
        if (r.st === 'inaktiv') { return {l: short(r.grund), v: '', f: null}; }
        if (isDaten(r)) { return {l: 'keine HeishaMon-Daten', v: '', f: null}; }
        if (r.st === 'gesperrt') { return {l: LK[n.b] || short(r.grund), v: n.bis ? 'bis ' + hm(n.bis) : (have(n.ist) && have(n.s) ? E.de(n.ist, 0) + ' / ' + E.de(n.s, 0) + (n.u ? ' ' + n.u : '') : ''), f: n.bis || !(have(n.ist) && have(n.s)) ? null : clamp(n.ist / n.s), lock: true}; }
        if ((r.st === 'vorschlag' || r.st === 'hinweis') && prop) { return {l: 'seit ' + hm(prop.ts), v: 'gültig bis ' + hm(prop.bis), f: clamp((now - prop.ts) / Math.max(1, prop.bis - prop.ts))}; }
        if (r.st === 'abgelaufen') { return {l: 'abgelaufen', v: '', f: null}; }
        if (have(n.ist) && have(n.s)) {
            var f = n.op === '<=' ? (n.ist <= n.s ? 1 : (n.ist > 0 ? n.s / n.ist : 0)) : (n.s > 0 ? n.ist / n.s : (n.ist >= n.s ? 1 : 0));
            return {l: n.kz || n.b, v: num2(n.ist, n.s, n.u) + ' / ' + (n.op === '<=' ? '≤ ' : '') + num2(n.s, n.ist, n.u) + (n.u ? ' ' + n.u : ''), f: clamp(f)};
        }
        var miss = (r.bed || []).filter(function (b) { return !b[1]; })[0];
        return {l: miss ? miss[0] : short(r.grund), v: '', f: null};
    }

    // ---------------------------------------------------------------- Karte "Aktueller Vorschlag": Zielwert, Rueckweg, Zustand des Knopfs
    function zielTxt(name, v) {
        if (!have(v)) { return '–'; }
        if (name === 'SetQuietMode') { return 'Quiet ' + v; }
        if (name === 'SetZ1HeatRequestTemperature') { return 'Verschiebung ' + E.sg(v, 0) + ' K'; }
        if (name === 'SetHeatingOffOutdoorTemp') { return 'Heizgrenze ' + E.de(v, 0) + ' °C'; }
        return name + ' ' + v;
    }
    // Der Knopf zeigt, was die Pruefkette des Servers (ENGINE.applyRequest) ablehnen wuerde; entscheidend bleibt der Server.
    function knopfOf(p, AP, en, knoten, rel, now) {
        var R = E.RULE[p.rule] || {}, X = E.APPLY, heute = AP.day === E.ymd(now) ? (AP.n || 0) : 0;
        function zu(g) { return {ok: false, text: 'Übernehmen', grund: g}; }
        if (p.art === 'hinweis') { return zu('nur Hinweis, von Hand einstellen'); }
        if (!en) { return zu('gesperrt: Hauptschalter aus'); }
        if (!knoten) { return zu('gesperrt: Sendeknoten deaktiviert'); }
        if (rel.indexOf(p.rule) < 0) { return zu('gesperrt: Regel nicht freigegeben'); }
        if (AP.pending) { return zu('wartet auf Bestätigung der Anlage'); }
        var gP = p.cmd && p.cmd.name ? E.gOfCmd(p.cmd.name) : (p.groesse || R.groesse), a0 = akOf(AP)[gP] || null, fort = E.fortsetzung(a0, p);   // je Groesse eine Uebernahme; dieselbe Regel darf in derselben Richtung fortsetzen
        if (a0 && !fort) { return zu('gesperrt: Übernahme ' + ((E.RULE[a0.rule] || {}).kachel || a0.name) + ' läuft'); }
        if (AP.lastSend && now - AP.lastSend < X.abstandMin * MIN) { return zu('gesperrt bis ' + hm(AP.lastSend + X.abstandMin * MIN) + ' (Abstand ' + X.abstandMin + ' min)'); }
        if (heute >= X.proTag) { return zu('gesperrt: Tageslimit ' + heute + '/' + X.proTag + ' Befehle'); }
        return {ok: true, text: fort ? 'Fortsetzen' : 'Übernehmen', grund: (fort ? 'Fortsetzung, Rückweg auf ' + a0.von + ' · ' : 'frei · ') + 'heute ' + heute + '/' + X.proTag + ' Befehle'};
    }
    function akOf(AP) {                                                                 // Uebernahmen je Groesse (OPT_apply.ak; aeltere Zustaende: nur aktiv)
        var o = {}; if (AP.ak && typeof AP.ak === 'object') { ['quiet', 'shift'].forEach(function (g) { if (AP.ak[g]) { o[g] = AP.ak[g]; } }); }
        else if (AP.aktiv) { o[AP.aktiv.name ? E.gOfCmd(AP.aktiv.name) : (AP.aktiv.groesse || 'quiet')] = AP.aktiv; }
        return o;
    }

    // ---------------------------------------------------------------- Karte "Messwerte & Lernen"
    function copMatrix(TK, tc, now) {                                                 // Zeilen = Aussenband, Spalten = vorhandene Kombinationen Modus x Quiet ("?" zaehlt nicht)
        var S = E.copSumme(TK, tc, now), bands = [], cols = {}, rows = {}, x0;
        for (x0 = -40; x0 <= 45; x0++) { if (bands.indexOf(E.bandOf(x0)) < 0) { bands.push(E.bandOf(x0)); } }       // Reihenfolge der Baender aus dem Kern (kalt -> warm)
        Object.keys(S).forEach(function (k) {
            var p = k.split('|'); if (p.length !== 3 || (p[0] !== 'Comfort' && p[0] !== 'Efficiency') || !/^[0-3]$/.test(p[1])) { return; }
            var a = S[k]; if (!(a[2] > 0)) { return; }
            cols[p[0] + '|' + p[1]] = 1; (rows[p[2]] = rows[p[2]] || {})[p[0] + '|' + p[1]] = a;
        });
        var sp = Object.keys(cols).sort(function (a, b) { var x = a.split('|'), y = b.split('|'); return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : +x[1] - +y[1]); });   // Comfort vor Efficiency, Quiet aufsteigend
        if (!sp.length) { return null; }
        Object.keys(rows).forEach(function (b) { if (bands.indexOf(b) < 0) { bands.push(b); } });
        var zeilen = bands.filter(function (b) { return rows[b]; }).map(function (b) {
            var zellen = sp.map(function (k) {
                var a = rows[b][k]; if (!a) { return null; }
                var cop = a[0] > 0 ? Math.round(a[1] / a[0] * 100) / 100 : null, x = k.split('|');
                return {cop: cop, v: have(cop) ? E.de(cop, 2) : '–', h: E.de(a[2] / 60, 1) + ' h', grau: a[2] < tc.copMinMin || !have(cop), best: false,
                        title: x[0] + ' Quiet ' + x[1] + ' · ' + b + ' °C: COP ' + (have(cop) ? E.de(cop, 2) : '–') + ' aus ' + Math.round(a[2]) + ' stabilen Minuten (mindestens ' + tc.copMinMin + ')' +
                               (a[3] ? ' · Ø ' + E.de(a[3] / a[2], 0) + ' Hz' : '') + (have(a[4]) ? ' · max ' + E.de(a[4], 0) + ' Hz' : '') + (have(a[5]) ? ' · gehalten ' + E.de(a[5], 0) + ' Hz' : '') + ' · ' + E.de(a[0] / 1000, 1) + ' kWh el / ' + E.de(a[1] / 1000, 1) + ' kWh th'};
            });
            var ok = zellen.filter(function (z) { return z && !z.grau; });
            if (ok.length >= 2) { var mx = Math.max.apply(null, ok.map(function (z) { return z.cop; })); ok.forEach(function (z) { z.best = z.cop === mx; }); }   // bester Wert nur, wenn es etwas zu vergleichen gibt
            return {band: b + ' °C', zellen: zellen};
        });
        return {spalten: sp.map(function (k) { var x = k.split('|'); return x[0] + ' Q' + x[1]; }), zeilen: zeilen, minMin: tc.copMinMin};
    }
    function messBuild(S, now, cfg, plan) {
        var tc = cfg.takt || E.taktCfg(null), TK = S.takt || {}, nl = TK.nl || null, laedt = !!(nl && nl.laeuft);
        var tk = E.taktKennzahlen(TK, now, tc), hgB = E.heizgrenzeBeob(TK, now), ub = E.uebSumme(S || {}, now), takt;
        if (laedt) {
            var nlT = 'liest quiet-*.csv: ' + (nl.zeilen || 0) + ' Zeilen' + (nl.von ? ' ab ' + dm(nl.von) : '');
            takt = [{k: 'Takt', v: '–', chip: 'lädt', c: 'mute', title: nlT}, {k: 'Läufe 24 h', v: '–', title: nlT}, {k: 'Pausen 24 h', v: '–', title: nlT}];
        } else {
            takt = [{k: 'Takt', v: tk.takt ? 'Takt' : 'ruhig', vc: tk.takt ? 'warn' : 'ok', s: tk.starts24h + ' Starts in 24 h',
                     title: 'Starts 24 h ' + tk.starts24h + ' (' + E.de(tk.startsH, 2) + '/h) · „Takt“ ab mehr als ' + tc.startsTagWarn + ' Starts in 24 h oder mehr als ' + E.de(tc.kurzAnteilWarn * 100, 0) + ' % kurzen Läufen (ab 4 Läufen)'},
                    {k: 'Läufe 24 h', v: String(tk.laeufe), s: (have(tk.mittelLaufMin) ? 'Ø ' + tk.mittelLaufMin + ' min · ' : '') + 'kurz ' + tk.kurz, title: 'kurz = unter ' + tc.kurzMin + ' min'},
                    {k: 'Pausen 24 h', v: String(tk.minutenPausen + tk.bedarfPausen), s: 'unter ' + tc.minutenPauseMin + ' min: ' + tk.minutenPausen, title: 'Minutenpause = unter ' + tc.minutenPauseMin + ' min, sonst Bedarfspause'}];
        }
        takt.push({k: 'Heizgrenze beobachtet', v: hgB ? E.de(hgB.at, 1) + ' °C' : '–', s: hgB ? 'max ' + E.de(hgB.max, 1) + ' °C · ' + hgB.n + ' Läufe' : 'noch kein Lauf ≥ ' + E.HG.laufMin + ' min',
                   title: 'Außentemperatur am Ende von Läufen ≥ ' + E.HG.laufMin + ' min, Mittel der letzten ' + E.HG.tage + ' Tage'});
        // Ueberheizpotenzial bei milder Witterung (ersetzt den stillgelegten Heizgrenze-Hinweis, Review-Paket 13.10.2026)
        takt.push({k: 'Überheizt ab ' + E.UEB.atC + ' °C', v: E.de(ub.el, 2) + ' kWh', vc: ub.el > 0.05 ? 'warn' : '', s: ub.minAlle ? E.de(ub.min, 0) + ' von ' + E.de(ub.minAlle, 0) + ' min' : 'kein Lauf ab ' + E.UEB.atC + ' °C',
                   title: 'Laufenergie (Strom) bei Außentemperatur ≥ ' + E.UEB.atC + ' °C, während ALLE Räume über ihrer Bandmitte lagen, letzte ' + E.UEB.tage + ' Tage: ' + E.de(ub.el, 2) + ' kWh Strom, ' + E.de(ub.th, 1) + ' kWh Wärme, ' + ub.min + ' min; ' +
                          'Laufenergie ab ' + E.UEB.atC + ' °C insgesamt ' + E.de(ub.elAlle, 2) + ' kWh in ' + ub.minAlle + ' min' + (ub.minOhne ? ' (davon ' + ub.minOhne + ' min ohne Raumwerte)' : '') + '. Nur diese Energie wäre mit einer niedrigeren Heizgrenze eingespart, ohne dass ein Raum unter seine Bandmitte fällt (echtes Überheizpotenzial; der Heizgrenze-Hinweis ist stillgelegt)'});
        var hl = E.hochlaufSumme(S || {}), hz0 = ((cfg.rules || E.defaults().rules).quiet_strecken || {}).hzHoch;        // Hochlauf nach dem Start: nur Kennzahl (Nutzer vorlaeufig 13.10.)
        takt.push({k: 'Hochlauf nach Start', v: (hl.Comfort[0] + hl.Efficiency[0]) + ' min', s: 'C ' + hl.Comfort[0] + ' min · E ' + hl.Efficiency[0] + ' min · ' + (hl.Comfort[1] + hl.Efficiency[1]) + ' Starts',
                   title: 'Minuten mit mindestens ' + hz0 + ' Hz in den ersten ' + E.HL.min + ' Laufminuten, ' + E.HL.tage + ' Tage: Comfort ' + hl.Comfort[0] + ' min bei ' + hl.Comfort[1] + ' Starts, Efficiency ' + hl.Efficiency[0] + ' min bei ' + hl.Efficiency[1] + ' Starts. Der Hochlauf nach dem Start wird nicht gedeckelt, nur gemessen (Nutzer vorläufig, 13.10.). ' +
                          'Befund 07.–13.10. (ersetzt die gestrichene Messaufgabe Comfort/Efficiency): Comfort fährt nach dem Start sofort auf 30–35 Hz, Efficiency bleibt bei 16–17 Hz und geht erst ab Laufminute 39–46 zeitweise auf 21–26 Hz; ein Wechsel im Lauf hebt die Pumpe in ≤ 1 min von 1750 auf 2850–2900 U/min'});
        var ml = laedt ? [] : E.mindestLeistung(TK, tc).map(function (b) {
            return {band: E.de(b[0], 0) + '…' + E.de(b[0] + E.TAKT.binK, 0) + ' °C', v: E.de(b[3] / 1000, 1) + ' kW',
                    title: E.de(b[0], 0) + '…' + E.de(b[0] + E.TAKT.binK, 0) + ' °C: 10-%-Quantil ' + E.de(b[1] / 1000, 2) + ' kW, laufendes Minimum von warm nach kalt ' + E.de(b[3] / 1000, 2) + ' kW, ' + b[2] + ' stabile Minuten'};
        });
        // Lernen: Wirkzeit, Heizkurven-Bias (Kern) und Gebaeudemodell, Lern-Gate, Drift (Waermefahrplan, OPT_plan)
        var LG = S.lag && S.lag.res, puf = (S.lag && S.lag.o) ? S.lag.o.length : 0, pufN = Math.round(E.LAG.fensterMin / E.LAG.stepMin) + 2;
        var wz = function (x, k) {                                                     // Kennzahl + kurzer Status-Chip, Einzelheiten im Tooltip
            var n = x ? x.n : 0, t = 'Sollsprung ≥ ' + E.LAG.sollK + ' K bis zur halben Raumreaktion im ' + E.de(E.LAG.fensterMin / 60, 0) + '-h-Fenster, Median aus mindestens ' + E.LAG.minEreignisse + ' Ereignissen · Puffer ' + puf + ' von ' + pufN + ' Proben (15 min; fehlt ein Raumwert, beginnt er neu)';
            return x && have(x.min) ? {k: k, v: E.de(x.min, 0) + ' min', chip: 'gemessen', c: 'ok', s: n + ' Ereignisse', title: t} : {k: k, v: '–', chip: 'sammelt', c: 'mute', s: n + '/' + E.LAG.minEreignisse + ' Ereignisse', title: t};
        };
        var K = S.kb || null, kb = K && have(K.bias)
            ? {k: 'Heizkurven-Bias', v: E.sg(K.bias, 1) + ' K', chip: K.bias < 0 ? 'Absenkung' : 'sammelt', c: K.bias < 0 ? 'ok' : 'mute', s: K.bias < 0 ? K.resets + ' Rücksetzungen' : Math.min(K.tage, E.KB.tage) + '/' + E.KB.tage + ' Tage',
               title: 'Tage in Folge mit ≥ ' + E.de(E.KB.luftK, 1) + ' K Luft in allen Räumen: ' + K.tage + ' von ' + E.KB.tage + ' · Rücksetzungen ' + K.resets + ' · ausgewertet ' + (K.tageGesamt || 0) + ' Tage' + (have(K.luft) ? ' · knappste Luft heute ' + E.sg(K.luft, 1) + ' K' : '') + ' · nur Anzeige'}
            : {k: 'Heizkurven-Bias', v: '–', chip: 'keine Daten', c: 'mute'};
        var M = (plan && plan.model) || null, LN = (plan && plan.lern) || null, lern = [];
        lern.push(M ? {k: 'Gebäudemodell', v: (M.n || 0) + '/' + (M.minDays || 10) + ' Tage', chip: M.gate ? (M.aktiv ? 'aktiv' : 'Gate offen') : 'Gate zu', c: M.gate ? 'ok' : 'mute', title: (M.why || []).join(' · ')}
                    : {k: 'Gebäudemodell', v: '–', chip: 'keine Daten', c: 'mute'});
        if (LN) {
            var dr = LN.drift || {}, an = dr.upAn ? 'Mehrbedarf' : (dr.dnAn ? 'Minderbedarf' : (dr.n ? 'ruhig' : '–'));
            lern.push({k: 'Lern-Gate heute', v: LN.heute ? 'gesperrt' : 'frei', vc: LN.heute ? 'warn' : 'ok', s: (LN.verw || 0) + ' Tage verworfen',
                       title: (LN.heute ? 'heute gesperrt: ' + LN.heuteTxt : 'heute frei') + (LN.verw ? ' · verworfen: ' + LN.verwTxt : '')});
            lern.push({k: 'Bedarfsmodell Drift', v: an, vc: (dr.upAn || dr.dnAn) ? 'warn' : (dr.n ? 'ok' : ''), s: dr.n ? 'CUSUM ' + E.de(Math.max(dr.up || 0, dr.dn || 0), 1) + ' von ' + E.de(dr.h, 0) + ' · ' + dr.n + ' Tage' : 'noch kein A/B-Tag',
                       title: 'Mehrbedarf ' + E.de(dr.up || 0, 1) + ' · Minderbedarf ' + E.de(dr.dn || 0, 1) + ' (Alarm ab ' + E.de(dr.h, 0) + ')' + (LN.rueckfall ? ' · Kandidat zurückgenommen, gesperrt bis ' + dm(LN.rueckfall.bis) : '') + (LN.rb ? ' · Rückfall-CUSUM ' + E.de(LN.rb.s, 1) + ' von ' + E.de(LN.rb.h, 0) : '')});
        } else {
            lern.push({k: 'Lern-Gate heute', v: '–', chip: 'keine Daten', c: 'mute'}, {k: 'Bedarfsmodell Drift', v: '–', chip: 'keine Daten', c: 'mute'});
        }
        lern.push(wz(LG && LG.auf, 'Wirkzeit Raum ↑'), wz(LG && LG.ab, 'Wirkzeit Raum ↓'), kb);
        return {takt: takt, ml: ml, mlLeer: laedt ? 'lädt' : 'sammelt', cop: laedt ? null : copMatrix(TK, tc, now), lern: lern};
    }

    // ---------------------------------------------------------------- alle Karten
    // o = {now, last: {t, res, prop, anl}, S, V, AP (OPT_apply), enabled, cfg, plan (OPT_plan)}
    function build(o) {
        var now = o.now, L = o.last, S = o.S, AP = o.AP || {}, en = o.enabled === true, knoten = AP.knoten !== false, rel = Array.isArray(AP.rules) ? AP.rules : [], cfg = o.cfg || E.defaults();
        var p = L.prop, verw = !!(p && Array.isArray(AP.verworfen) && AP.verworfen.indexOf(p.id) >= 0), heute = AP.day === E.ymd(now) ? (AP.n || 0) : 0;
        // Statuszeile
        var st = [], born = S.born || 0, anl = born + cfg.locks.warmupMin * MIN, A = L.anl || {};
        if (now - L.t > 3 * MIN) { st.push({t: 'Maschine rechnet nicht · Stand ' + hm(L.t), c: 'bad'}); }
        else if (L.res.some(isDaten)) { st.push({t: 'keine HeishaMon-Daten', c: 'bad'}); }
        else if (L.t < anl) { st.push({t: 'Anlaufsperre bis ' + hm(anl), c: 'warn'}); }
        else { st.push({t: 'Maschine läuft · ' + hm(L.t), c: 'ok'}); }
        if (A.z === 'lauf') { st.push({t: 'Lauf ' + dur(A.lauf) + ' · ' + E.de(A.hz, 0) + ' Hz · Quiet ' + (have(A.q) ? A.q : '–') + ' · Vorlauf ' + E.sg(have(A.vlR) ? -A.vlR : null, 1) + ' K', c: 'mute'}); }
        else if (A.z === 'pause' || A.z === 'heizgrenze') { st.push({t: (A.z === 'pause' ? 'Pause' : 'Heizgrenze-Aus') + ' · Quiet ' + (have(A.q) ? A.q : '–'), c: 'mute'}); }
        if (AP.pending) { st.push({t: 'Befehl ' + hm(AP.pending.ts) + ' gesendet · wartet auf Bestätigung', c: 'warn'}); }
        var akL = akOf(AP);
        ['quiet', 'shift'].forEach(function (g) { var a = akL[g]; if (a && !(AP.pending && (AP.pending.g || E.gOfCmd(AP.pending.name)) === g)) { st.push({t: 'Übernommen ' + hm(a.ts) + ': ' + zielTxt(a.name, a.value) + (a.bis ? ' · zurück auf ' + a.von + ' um ' + hm(a.bis) : ' · zurück auf ' + a.von), c: a.rueckFehl ? 'bad' : (a.bestaetigt ? 'ok' : 'warn')}); } });
        if (!en) { st.push({t: 'Übernahme gesperrt', c: 'lock'}); }
        else if (!knoten) { st.push({t: 'Übernahme gesperrt: Sendeknoten deaktiviert', c: 'lock'}); }
        else { st.push({t: rel.length ? 'Übernahme frei: ' + rel.map(function (x) { return (E.RULE[x] && E.RULE[x].kachel) || x; }).join(', ') + ' · heute ' + heute + '/' + E.APPLY.proTag : 'Übernahme frei: keine Regel', c: rel.length ? 'ok' : 'mute'}); }
        if (AP.alarm) { st.push({t: AP.alarm.text, c: 'bad'}); }
        if (verw) { st.push({t: 'verworfen: ' + p.was, c: 'mute'}); }
        var card = {status: st, prop: null, knopf: {ok: false, text: 'Übernehmen', grund: 'kein Vorschlag'}, reset: Object.keys(akL).length > 0, enabled: en, verworfen: verw ? p.id : null, leer: null};
        if (p && !verw) {
            var R = E.RULE[p.rule] || {}, cr = cfg.rules[p.rule] || {}, hinweis = p.art === 'hinweis', von = zielTxt(p.cmd.name, p.von), maxD = have(p.maxDauerMin) ? p.maxDauerMin : cr.maxDauerMin;
            card.prop = {id: p.id, sum: p.sum, rule: p.rule, name: R.kurz || p.rule, c: COL[p.rule] || '#1976d2', hinweis: hinweis, was: p.was, warum: p.warum,
                         befehl: p.cmd.name + ' = ' + p.cmd.value, ziel: zielTxt(p.cmd.name, p.cmd.value) + (have(p.von) ? ' (jetzt ' + von + ')' : ''),
                         seit: hm(p.ts), bis: hm(p.bis), erwartung: ohneKlammern(p.erwartung), erwartungLang: p.erwartung,
                         rueck: hinweis ? 'von Hand (Saisoneinstellung)' : (have(maxD) ? 'automatisch zurück auf ' + von + ', spätestens nach ' + E.de(maxD / 60, 0) + ' h' : 'kein automatischer · „Zurücksetzen“ stellt ' + von + ' wieder her'),
                         rueckweg: p.rueckweg};
            card.knopf = knopfOf(p, AP, en, knoten, rel, now);
        } else {
            var z24 = zaehle24h(o.V || {}, now);
            card.leer = {letzter: letzterVorschlag(o.V || {}), h24: z24.vorschlag + (z24.vorschlag === 1 ? ' Vorschlag' : ' Vorschläge') + ' · ' + z24.hinweis + (z24.hinweis === 1 ? ' Hinweis' : ' Hinweise'),
                         uebernahme: !en ? 'gesperrt · Hauptschalter aus (apply.json)' : (!knoten ? 'gesperrt · Sendeknoten deaktiviert' :
                                     (rel.length ? 'frei für ' + rel.map(function (x) { return (E.RULE[x] && E.RULE[x].kachel) || x; }).join(', ') : 'frei, aber keine Regel freigegeben') + ' · heute ' + heute + '/' + E.APPLY.proTag + ' Befehle'), lock: !en || !knoten};
        }
        // Regelkacheln
        var rules = L.res.map(function (r) {
            var R = E.RULE[r.id] || {}, pr = S.rules && S.rules[r.id] ? S.rules[r.id].prop : null, dat = isDaten(r);
            return {id: r.id, name: R.kachel || R.kurz || r.id, c: COL[r.id] || '#607d8b', st: r.st, chip: dat ? 'keine Daten' : (CHIP[r.st] || r.st), cls: dat ? 'bad' : (CLS[r.st] || 'mute'),
                    bed: r.st === 'inaktiv' || dat ? [] : (r.bed || []), line: lineOf(r, pr, now), grund: r.st === 'vorschlag' || r.st === 'hinweis' ? '' : r.grund};   // Begruendung des Vorschlags nur in Karte 1
        });
        // Punkte
        var sv = (S.sc && S.sc.sv) || E.SCORE_VER, rep = E.report(S, sv);
        var hist = ((S.sc && S.sc.hist) || []).filter(function (h) { return h[0] >= now - 30 * 24 * 60 * MIN && (h[3] || 1) === sv; });   // nur die aktuelle Bewertungsversion
        var t0 = hist.length ? Math.min(hist[0][0] - 60 * MIN, now - 24 * 60 * MIN) : now - 7 * 24 * 60 * MIN;
        var series = E.RULES.filter(function (R) { return sv < 4 || R.art !== 'hinweis'; }).map(function (R) {   // ab v4: Hinweise ohne Punkte, nicht im Diagramm
            var pts = hist.filter(function (h) { return h[1] === R.id; }).map(function (h) { return [h[0], h[2]]; });
            if (pts.length) { pts.unshift([t0, 0]); pts.push([now, pts[pts.length - 1][1]]); }
            return {id: R.id, n: R.kurz, c: COL[R.id], d: pts};
        }).filter(function (x) { return x.d.length; });
        var tiles = rep.map(function (r) {
            var sub = r.faelle ? r.faelle + ' ' + (r.faelle === 1 ? 'Fall' : 'Fälle') + ' · ' + r.treffer + ' Treffer · ' + r.fehlalarm + ' Fehlalarm' : 'noch kein Fall', more = [];
            if (r.trefferNeutral) { more.push('davon ' + r.trefferNeutral + ' Treffer neutral (Basisrate ≥ Prognose)'); }     // v5: Treffer bei hoher Basisrate 0 Punkte
            if (r.skill !== null) { more.push('Skill ' + E.de(r.skill, 2)); }
            var wn = r.wirkung.n - r.wirkung.kalib;
            if (r.art === 'befehl' && wn) { more.push('Wirkung ' + E.sg(r.wirkung.punkte, 0) + ' aus ' + wn + (wn === 1 ? ' Fall' : ' Fällen')); }
            if (r.art === 'befehl' && r.wirkung.kalib) { more.push(r.wirkung.kalib + ' Kalibrierfall' + (r.wirkung.kalib === 1 ? '' : 'e')); }
            var warn = []; if (r.schaden) { warn.push(r.schaden + ' × Schaden'); } if (r.verpasst) { warn.push(r.verpasst + ' × verpasst'); }
            var ok = r.kriterien.filter(function (k) { return k.ok; }).length;
            return {id: r.regel, name: (E.RULE[r.regel] || {}).kachel || (E.RULE[r.regel] || {}).kurz || r.regel, c: COL[r.regel], punkte: r.ohnePunkte ? '–' : E.sg(r.punkte, 1).replace(/^0,0$/, '0'), neg: !r.ohnePunkte && r.punkte < 0, sub: sub, more: more.join(' · '), warn: warn.join(' · '),
                    sperre: r.art === 'befehl' ? (r.verpasstSperre || 0) : null,                                     // "verpasst" waehrend eigener Sperre (v2, neutral)
                    reife: r.art === 'befehl' ? {n: ok, m: r.kriterien.length, reif: r.reif} : null, krit: r.kriterien.map(function (k) { return [k.kurz, k.ok ? 1 : 0, k.text]; })};
        });
        var score = {now: now, t0: t0, series: series, tiles: tiles, sv: sv};
        return {card: card, rules: {rules: rules}, score: score, mess: messBuild(S, now, cfg, o.plan || null), log: {rows: logRows(o.V || {}, now, 12)}};
    }
    return {track: track, build: build, logRows: logRows, copMatrix: copMatrix, messBuild: messBuild, zielTxt: zielTxt, knopfOf: knopfOf, COL: COL, CHIP: CHIP};
})(typeof ENGINE !== 'undefined' ? ENGINE : require('./engine_core.js'));
if (typeof module !== 'undefined' && module.exports) { module.exports = ENGVIEW; }
// == ENGINE-VIEW-ENDE ==

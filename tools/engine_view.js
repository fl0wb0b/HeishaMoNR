// == ENGINE-VIEW ==
// Anzeige der Entscheidungsmaschine (Seite "Optimierer"): reine Funktionen, die aus Zustand und letzter Auswertung die vier Karten-Daten bauen.
// Wird vom Generator hinter den Kern in opt_engine eingebettet und in tools/engine_sim.js sowie tools/engine_ui_preview.js direkt getestet.
//   ENGVIEW.track(V, res, rules, now)   Episoden fuer die Karte "Entscheidungen": je Regel ein Eintrag von "alle Bedingungen erfuellt" (wartet,
//                                       gesperrt, Vorschlag) bis zum Ende; Dauerzustaende ("prueft", "ruht") erzeugen keine Zeilen
//   ENGVIEW.build(o)                    -> {card, rules, score, log}
var ENGVIEW = (function (E) {
    var MIN = 60000;
    var STAGE = {wartet: 1, gesperrt: 2, abgelaufen: 3, vorschlag: 3, hinweis: 3};
    var COL = {quiet_freigabe: '#1976d2', quiet_strecken: '#00897b', raum_offset: '#ef6c00', heizgrenze_hinweis: '#8e24aa'};
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

    // ---------------------------------------------------------------- Episoden
    function track(V, res, rules, now) {
        V.ep = Array.isArray(V.ep) ? V.ep : []; V.open = V.open || {};
        res.forEach(function (r) {
            var rel = STAGE[r.st] && !isDaten(r), op = V.open[r.id];
            if (rel) {
                var lock = r.st === 'gesperrt' && r.naechste ? r.naechste.b : '', pr = rules && rules[r.id] && rules[r.id].prop;
                if (!op) { op = V.open[r.id] = {id: r.id, t0: now, t1: now, st: []}; }
                var last = op.st[op.st.length - 1];
                if (!last || last[0] !== r.st || last[2] !== lock) { op.st.push([r.st, now, lock, (r.st === 'vorschlag' || r.st === 'hinweis') && pr ? pr.was : '']); if (op.st.length > 8) { op.st.splice(1, op.st.length - 8); } }
                op.t1 = now;
            } else if (op) {
                op.t1 = now; op.end = short(r.ende || (isDaten(r) ? 'keine HeishaMon-Daten' : r.grund));
                V.ep.push(op); delete V.open[r.id];
            }
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

    // ---------------------------------------------------------------- Regelkacheln
    function lineOf(r, prop, now) {
        var n = r.naechste || {};
        if (r.st === 'inaktiv') { return {l: short(r.grund), v: '', f: null}; }
        if (isDaten(r)) { return {l: 'keine HeishaMon-Daten', v: '', f: null}; }
        if (r.st === 'gesperrt') { return {l: LK[n.b] || short(r.grund), v: n.bis ? 'bis ' + hm(n.bis) : '', f: null, lock: true}; }
        if ((r.st === 'vorschlag' || r.st === 'hinweis') && prop) { return {l: 'seit ' + hm(prop.ts), v: 'gültig bis ' + hm(prop.bis), f: clamp((now - prop.ts) / Math.max(1, prop.bis - prop.ts))}; }
        if (r.st === 'abgelaufen') { return {l: 'abgelaufen', v: '', f: null}; }
        if (have(n.ist) && have(n.s)) {
            var f = n.op === '<=' ? (n.ist <= n.s ? 1 : (n.ist > 0 ? n.s / n.ist : 0)) : (n.s > 0 ? n.ist / n.s : (n.ist >= n.s ? 1 : 0));
            return {l: n.kz || n.b, v: num2(n.ist, n.s, n.u) + ' / ' + (n.op === '<=' ? '≤ ' : '') + num2(n.s, n.ist, n.u) + (n.u ? ' ' + n.u : ''), f: clamp(f)};
        }
        var miss = (r.bed || []).filter(function (b) { return !b[1]; })[0];
        return {l: miss ? miss[0] : short(r.grund), v: '', f: null};
    }

    // ---------------------------------------------------------------- alle Karten
    // o = {now, last: {t, res, prop, anl}, S, V, AP (OPT_apply), enabled, cfg}
    function build(o) {
        var now = o.now, L = o.last, S = o.S, AP = o.AP || {}, en = o.enabled === true, rel = Array.isArray(AP.rules) ? AP.rules : [], cfg = o.cfg || E.defaults();
        var p = L.prop, verw = !!(p && Array.isArray(AP.verworfen) && AP.verworfen.indexOf(p.id) >= 0);
        // Statuszeile
        var st = [], born = S.born || 0, anl = born + cfg.locks.warmupMin * MIN, A = L.anl || {};
        if (now - L.t > 3 * MIN) { st.push({t: 'Maschine rechnet nicht · Stand ' + hm(L.t), c: 'bad'}); }
        else if (L.res.some(isDaten)) { st.push({t: 'keine HeishaMon-Daten', c: 'bad'}); }
        else if (L.t < anl) { st.push({t: 'Anlaufsperre bis ' + hm(anl), c: 'warn'}); }
        else { st.push({t: 'Maschine läuft · ' + hm(L.t), c: 'ok'}); }
        if (A.z === 'lauf') { st.push({t: 'Lauf ' + dur(A.lauf) + ' · ' + E.de(A.hz, 0) + ' Hz · Quiet ' + (have(A.q) ? A.q : '–') + ' · Vorlauf ' + E.sg(have(A.vlR) ? -A.vlR : null, 1) + ' K', c: 'mute'}); }
        else if (A.z === 'pause' || A.z === 'heizgrenze') { st.push({t: (A.z === 'pause' ? 'Pause' : 'Heizgrenze-Aus') + ' · Quiet ' + (have(A.q) ? A.q : '–'), c: 'mute'}); }
        if (AP.pending) { st.push({t: 'Befehl ' + hm(AP.pending.ts) + ' gesendet · wartet auf Bestätigung', c: 'warn'}); }
        else if (AP.aktiv) { st.push({t: 'Übernommen ' + hm(AP.aktiv.ts) + ': ' + AP.aktiv.name + ' = ' + AP.aktiv.value + (AP.aktiv.bis ? ' · zurück auf ' + AP.aktiv.von + ' um ' + hm(AP.aktiv.bis) : ''), c: AP.aktiv.bestaetigt ? 'ok' : 'warn'}); }
        if (!en) { st.push({t: 'Übernahme gesperrt', c: 'lock'}); }
        else { st.push({t: rel.length ? 'Übernahme frei: ' + rel.map(function (x) { return (E.RULE[x] && E.RULE[x].kurz) || x; }).join(', ') : 'Übernahme frei: keine Regel', c: rel.length ? 'ok' : 'mute'}); }
        if (AP.alarm) { st.push({t: AP.alarm.text, c: 'bad'}); }
        if (verw) { st.push({t: 'verworfen: ' + p.was, c: 'mute'}); }
        var card = {status: st, prop: null, knopf: {ok: false, text: 'Übernahme gesperrt'}, reset: !!AP.aktiv, enabled: en, verworfen: verw ? p.id : null};
        if (p && !verw) {
            var R = E.RULE[p.rule] || {}, cr = cfg.rules[p.rule] || {}, hinweis = p.art === 'hinweis';
            card.prop = {id: p.id, sum: p.sum, rule: p.rule, name: R.kurz || p.rule, c: COL[p.rule] || '#1976d2', hinweis: hinweis, was: p.was, warum: p.warum,
                         befehl: hinweis ? p.cmd.name + ' = ' + p.cmd.value : p.cmd.name + ' = ' + p.cmd.value + ' (jetzt ' + p.von + ')',
                         seit: hm(p.ts), bis: hm(p.bis), rueck: hinweis ? 'von Hand' : (have(cr.maxDauerMin) ? 'automatisch, spätestens nach ' + E.de(cr.maxDauerMin / 60, 0) + ' h' : 'keiner (Standard)'),
                         erwartung: p.erwartung, rueckweg: p.rueckweg};
            if (hinweis) { card.knopf = {ok: false, text: 'nur Hinweis'}; }
            else if (!en) { card.knopf = {ok: false, text: 'Übernahme gesperrt'}; }
            else if (rel.indexOf(p.rule) < 0) { card.knopf = {ok: false, text: 'Regel nicht freigegeben'}; }
            else if (AP.pending) { card.knopf = {ok: false, text: 'wartet auf Bestätigung'}; }
            else { card.knopf = {ok: true, text: 'Übernehmen'}; }
        }
        // Regelkacheln
        var rules = L.res.map(function (r) {
            var R = E.RULE[r.id] || {}, pr = S.rules && S.rules[r.id] ? S.rules[r.id].prop : null, dat = isDaten(r);
            return {id: r.id, name: R.kurz || r.id, c: COL[r.id] || '#607d8b', st: r.st, chip: dat ? 'keine Daten' : (CHIP[r.st] || r.st), cls: dat ? 'bad' : (CLS[r.st] || 'mute'),
                    bed: r.st === 'inaktiv' || dat ? [] : (r.bed || []), line: lineOf(r, pr, now), grund: r.st === 'vorschlag' || r.st === 'hinweis' ? '' : r.grund};   // Begruendung des Vorschlags nur in Karte 1
        });
        // Punkte
        var sv = (S.sc && S.sc.sv) || E.SCORE_VER, rep = E.report(S, sv);
        var hist = ((S.sc && S.sc.hist) || []).filter(function (h) { return h[0] >= now - 30 * 24 * 60 * MIN && (h[3] || 1) === sv; });   // nur die aktuelle Bewertungsversion
        var t0 = hist.length ? Math.min(hist[0][0] - 60 * MIN, now - 24 * 60 * MIN) : now - 7 * 24 * 60 * MIN;
        var series = E.RULES.map(function (R) {
            var pts = hist.filter(function (h) { return h[1] === R.id; }).map(function (h) { return [h[0], h[2]]; });
            if (pts.length) { pts.unshift([t0, 0]); pts.push([now, pts[pts.length - 1][1]]); }
            return {id: R.id, n: R.kurz, c: COL[R.id], d: pts};
        }).filter(function (x) { return x.d.length; });
        var tiles = rep.map(function (r) {
            var sub = r.faelle ? r.faelle + ' ' + (r.faelle === 1 ? 'Fall' : 'Fälle') + ' · ' + r.treffer + ' Treffer · ' + r.fehlalarm + ' Fehlalarm' : 'noch kein Fall', more = [];
            if (r.skill !== null) { more.push('Skill ' + E.de(r.skill, 2)); }
            var wn = r.wirkung.n - r.wirkung.kalib;
            if (r.art === 'befehl' && wn) { more.push('Wirkung ' + E.sg(r.wirkung.punkte, 0) + ' aus ' + wn + (wn === 1 ? ' Fall' : ' Fällen')); }
            if (r.art === 'befehl' && r.wirkung.kalib) { more.push(r.wirkung.kalib + ' Kalibrierfall' + (r.wirkung.kalib === 1 ? '' : 'e')); }
            var warn = []; if (r.schaden) { warn.push(r.schaden + ' × Schaden'); } if (r.verpasst) { warn.push(r.verpasst + ' × verpasst'); }
            var ok = r.kriterien.filter(function (k) { return k.ok; }).length;
            return {id: r.regel, name: (E.RULE[r.regel] || {}).kurz || r.regel, c: COL[r.regel], punkte: E.sg(r.punkte, 1).replace(/^0,0$/, '0'), neg: r.punkte < 0, sub: sub, more: more.join(' · '), warn: warn.join(' · '),
                    sperre: r.art === 'befehl' ? (r.verpasstSperre || 0) : null,                                     // "verpasst" waehrend eigener Sperre (v2, neutral)
                    reife: r.art === 'befehl' ? {n: ok, m: r.kriterien.length, reif: r.reif} : null, krit: r.kriterien.map(function (k) { return [k.kurz, k.ok ? 1 : 0, k.text]; })};
        });
        var ms = E.messStatus(S), mess;
        if (ms.offen) { mess = {t: 'Comfort ' + Math.min(ms.comfortMin, E.MESS.minMin) + '/' + E.MESS.minMin + ' min · Efficiency ' + Math.min(ms.efficiencyMin, E.MESS.minMin) + '/' + E.MESS.minMin + ' min', c: 'warn', chip: 'offen'}; }
        else { var b = ms.befund || {}; mess = {t: 'Comfort bis ' + E.de(b.comfort && b.comfort.hzMax, 0) + ' Hz · Efficiency bis ' + E.de(b.efficiency && b.efficiency.hzMax, 0) + ' Hz', c: 'ok', chip: 'erledigt'}; }
        var score = {now: now, t0: t0, series: series, tiles: tiles, mess: mess, sv: sv};
        return {card: card, rules: {rules: rules}, score: score, log: {rows: logRows(o.V || {}, now, 12)}};
    }
    return {track: track, build: build, logRows: logRows, COL: COL, CHIP: CHIP};
})(typeof ENGINE !== 'undefined' ? ENGINE : require('./engine_core.js'));
if (typeof module !== 'undefined' && module.exports) { module.exports = ENGVIEW; }
// == ENGINE-VIEW-ENDE ==

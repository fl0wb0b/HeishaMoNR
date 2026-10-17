// == ZAEHLER-CORE ==
// Stromzähler Shelly 3EM-63 Gen3 (cop-ziel 17.10.2026): NUR LESEN. Reine Funktionen (kein Speicher, keine Dateien, kein MQTT, keine Uhr); vom Generator in opt_zaehler
// eingebettet und in tools/cop_ziel_sim.js getestet.
//   Profil "triphase": em:0 (a_/b_/c_act_power, voltage, current, aprt_power) + emdata:0 (a_/b_/c_total_act_energy, _ret_), Klemme 0/1/2 = Phase a/b/c
//   Profil "monophase": em1:0..2 (act_power, voltage, current, aprt_power) + em1data:0..2 (total_act_energy, total_act_ret_energy), Klemme = Kanal
//   Quellen: <prefix>/status/<komponente> (volle Komponente, Einstellung "Generic status update over MQTT") und <prefix>/events/rpc (NotifyStatus: nur geänderte Felder,
//   NotifyFullStatus: alle Komponenten). Energie in Wh, Leistung in W (Shelly-API Gen2+: EM, EM1, EMData, EM1Data).
//   ZAEHLER.cfgOf(c)                      -> bereinigte Konfiguration (OPT_cfg.zaehler)
//   ZAEHLER.abos(c)                       -> Topics zum Abonnieren
//   ZAEHLER.lies(Z, topic, payload, now, c) -> true, wenn die Nachricht den Zähler betraf (Z.k[0..2] aktualisiert)
//   ZAEHLER.stand(Z, now, c, hs)          -> OPT_zaehler {wp_w, heizstab_w, sonst_w, kwh_wp, kwh_heizstab, ts, alter, ok, ...}
//   ZAEHLER.minute(Z, x, c)               -> je Minute: 24-h-Vergleich mit TOP16 + Korrektur, Heizstab-Sprungerkennung (x = {t, wp_w roh, top16, lauf, heizstab, korrW})
//   ZAEHLER.vergleich(Z, now)             -> {lauf: {n, diffW, zaehlerW, top16W}, stand: {...}, korrGemessenW}
//   ZAEHLER.pruefe(eingabe, alt)          -> {cfg, fehler}  (Eingabe der Form auf Daten & Güte)
var ZAEHLER = (function () {
    var MIN = 60000;
    var ZL = {maxAlterMin: 5, heizStdW: 3000, heizMinW: 500, heizMaxW: 9500, sprungMin: 3, heizN: 9, stunden: 24, korrMinN: 120, vorzeichenW: -30};
    var STD = {quelle: 'heishamon', broker: 'venus', topic: '', profil: 'auto', klemme_wp: 0, klemme_heizstab: null, klemme_sonstiges: null, invertieren: [false, false, false]};
    var PH = ['a', 'b', 'c'];
    function have(v) { return typeof v === 'number' && isFinite(v); }
    function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } var n = Number(v); return isFinite(n) ? n : null; }
    function kl(v, erlaubtNull) { var n = num(v); return (n === 0 || n === 1 || n === 2) ? n : (erlaubtNull ? null : 0); }
    function praefix(t) { t = String(t || '').trim(); var i = t.indexOf('/status/'); if (i < 0) { i = t.indexOf('/events/'); } if (i < 0 && /\/status$/.test(t)) { i = t.length - 7; } return (i >= 0 ? t.slice(0, i) : t).replace(/\/+$/, ''); }
    function cfgOf(c) {
        c = c && typeof c === 'object' ? c : {};
        var inv = Array.isArray(c.invertieren) ? c.invertieren : [], o = {
            quelle: c.quelle === 'zaehler' ? 'zaehler' : 'heishamon', broker: c.broker === 'nas' ? 'nas' : 'venus', topic: String(c.topic || '').trim(),
            profil: c.profil === 'triphase' || c.profil === 'monophase' ? c.profil : 'auto',
            klemme_wp: kl(c.klemme_wp, false), klemme_heizstab: kl(c.klemme_heizstab, true), klemme_sonstiges: kl(c.klemme_sonstiges, true),
            invertieren: [0, 1, 2].map(function (i) { return inv[i] === true || inv[i] === 1 || inv[i] === 'true'; })};
        o.prefix = praefix(o.topic);
        return o;
    }
    function abos(c) {
        c = cfgOf(c); if (!c.prefix || /[#+]/.test(c.prefix)) { return []; }
        var p = c.prefix, o = [p + '/events/rpc'];
        if (c.profil !== 'monophase') { o.push(p + '/status/em:0', p + '/status/emdata:0'); }
        if (c.profil !== 'triphase') { [0, 1, 2].forEach(function (i) { o.push(p + '/status/em1:' + i, p + '/status/em1data:' + i); }); }
        return o;
    }
    function neu() { return {k: [{}, {}, {}], profil: null, n: 0, letzte: 0, fehler: [], h: {}, hs: {mess: [], buf: [], warte: null}, vz: [0, 0, 0]}; }
    function fix(Z) { if (!Z || typeof Z !== 'object' || !Array.isArray(Z.k) || Z.k.length !== 3) { return neu(); } var N = neu(); Object.keys(N).forEach(function (k) { if (Z[k] === undefined) { Z[k] = N[k]; } }); return Z; }
    function setz(K, f, v, now) { var n = num(v); if (n !== null) { K[f] = n; K.ts = now; } }
    // eine Komponente einarbeiten (voll oder als Teil einer NotifyStatus-Meldung)
    function komp(Z, name, o, now) {
        if (!o || typeof o !== 'object') { return false; }
        var m = /^(em|emdata|em1|em1data):(\d)$/.exec(name); if (!m) { return false; }
        var art = m[1], id = +m[2];
        if (art === 'em' || art === 'emdata') {
            if (id !== 0) { return false; }
            Z.profil = 'triphase';
            PH.forEach(function (ph, i) {
                var K = Z.k[i];
                if (art === 'em') { setz(K, 'w', o[ph + '_act_power'], now); setz(K, 'v', o[ph + '_voltage'], now); setz(K, 'a', o[ph + '_current'], now); setz(K, 'va', o[ph + '_aprt_power'], now); }
                else { setz(K, 'wh', o[ph + '_total_act_energy'], now); setz(K, 'whRet', o[ph + '_total_act_ret_energy'], now); }
            });
            if (Array.isArray(o.errors) && o.errors.length) { Z.fehler = o.errors.slice(0, 5); } else if (art === 'em') { Z.fehler = []; }
            return true;
        }
        if (id > 2) { return false; }
        Z.profil = 'monophase';
        var K1 = Z.k[id];
        if (art === 'em1') { setz(K1, 'w', o.act_power, now); setz(K1, 'v', o.voltage, now); setz(K1, 'a', o.current, now); setz(K1, 'va', o.aprt_power, now); if (Array.isArray(o.errors) && o.errors.length) { Z.fehler = o.errors.slice(0, 5); } }
        else { setz(K1, 'wh', o.total_act_energy, now); setz(K1, 'whRet', o.total_act_ret_energy, now); }
        return true;
    }
    function lies(Z, topic, payload, now, c) {
        c = cfgOf(c); if (!c.prefix) { return false; }
        var t = String(topic || ''); if (t.indexOf(c.prefix + '/') !== 0) { return false; }
        var rest = t.slice(c.prefix.length + 1), P = payload;
        if (P && typeof P === 'object' && typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(P)) { P = P.toString(); }
        if (typeof P === 'string') { try { P = JSON.parse(P); } catch (e) { return false; } }
        if (!P || typeof P !== 'object') { return false; }
        var ok = false;
        if (rest.indexOf('status/') === 0) {
            var nm = rest.slice(7); if (c.profil === 'triphase' && /^em1/.test(nm)) { return false; } if (c.profil === 'monophase' && /^em(data)?:/.test(nm)) { return false; }
            ok = komp(Z, nm, P, now);
        } else if (rest === 'events/rpc' && (P.method === 'NotifyStatus' || P.method === 'NotifyFullStatus') && P.params && typeof P.params === 'object') {
            Object.keys(P.params).forEach(function (k) { if ((c.profil === 'triphase' && /^em1/.test(k)) || (c.profil === 'monophase' && /^em(data)?:/.test(k))) { return; } if (komp(Z, k, P.params[k], now)) { ok = true; } });
        }
        if (ok) { Z.n++; Z.letzte = now; }
        return ok;
    }
    function wOf(Z, i, c) { var K = Z.k[i]; if (!K || !have(K.w)) { return null; } return c.invertieren[i] ? -K.w : K.w; }
    function whOf(Z, i, c) { var K = Z.k[i]; if (!K) { return null; } var v = c.invertieren[i] ? K.whRet : K.wh; return have(v) ? v : null; }
    function tsOf(Z, i) { var K = Z.k[i]; return K && have(K.ts) ? K.ts : null; }
    function heizParam(Z) {                                                        // Heizstab ohne eigene Klemme: gemessene Spruenge (Median) oder Annahme 3 kW
        var L = (Z.hs && Z.hs.mess) || [];
        if (!L.length) { return {w: ZL.heizStdW, quelle: 'Annahme 3 kW (noch kein Sprung gemessen)', n: 0}; }
        var v = L.map(function (x) { return x[1]; }).sort(function (a, b) { return a - b; }), m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
        return {w: Math.round(m), quelle: 'gemessen aus ' + L.length + (L.length === 1 ? ' Sprung' : ' Sprüngen') + ' (Internal_Heater_State, Zähler vor/nach)', n: L.length};
    }
    // OPT_zaehler; hs = Internal_Heater_State (1 = Heizstab an) fuer die Schaetzung ohne eigene Klemme
    function stand(Z, now, c, hs) {
        c = cfgOf(c); Z = fix(Z);
        var tWp = tsOf(Z, c.klemme_wp), alter = have(tWp) ? (now - tWp) / MIN : null, ok = !!c.prefix && have(alter) && alter <= ZL.maxAlterMin;
        var roh = wOf(Z, c.klemme_wp, c), hsW = null, hsQ = null, wp = roh;
        if (c.klemme_heizstab !== null) { hsW = wOf(Z, c.klemme_heizstab, c); hsQ = 'eigene Klemme ' + (c.klemme_heizstab + 1); }
        else { var HP = heizParam(Z); hsW = hs === 1 ? HP.w : 0; hsQ = HP.quelle; if (have(roh) && hs === 1) { wp = roh - HP.w; } }
        var vz = have(roh) && roh < ZL.vorzeichenW;                                 // Klemme verkehrt herum (oder Rueckspeisung): Hinweis, Wert auf 0 begrenzt
        var whW = whOf(Z, c.klemme_wp, c), whH = c.klemme_heizstab !== null ? whOf(Z, c.klemme_heizstab, c) : null;
        return {ts: tWp, alter: have(alter) ? Math.round(alter * 10) / 10 : null, ok: ok, profil: Z.profil, eingerichtet: !!c.prefix, quelle: c.quelle,
                wp_w: have(wp) ? Math.max(0, Math.round(wp)) : null, wp_roh_w: have(roh) ? Math.round(roh) : null, heizstab_w: have(hsW) ? Math.max(0, Math.round(hsW)) : null, heizstab_quelle: hsQ,
                sonst_w: c.klemme_sonstiges !== null && have(wOf(Z, c.klemme_sonstiges, c)) ? Math.round(wOf(Z, c.klemme_sonstiges, c)) : null,
                kwh_wp: have(whW) ? Math.round(whW) / 1000 : null, kwh_heizstab: have(whH) ? Math.round(whH) / 1000 : null,
                kanaele: [0, 1, 2].map(function (i) { var K = Z.k[i] || {}; return {w: wOf(Z, i, c), v: have(K.v) ? K.v : null, a: have(K.a) ? K.a : null, alter: have(K.ts) ? Math.round((now - K.ts) / MIN * 10) / 10 : null}; }),
                vorzeichen: vz, fehler: (Z.fehler || []).slice(), nachrichten: Z.n};
    }
    function hKey(t) { var d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours(); }
    // je Minute: x = {t, ok (Zaehler frisch), wpW (Zaehler ohne Heizstab), rohW (Klemme WP), top16, lauf, heizstab (0/1), korrW}
    function minute(Z, x, c) {
        c = cfgOf(c); Z = fix(Z);
        var t = x.t;
        // Heizstab-Sprungerkennung (nur ohne eigene Klemme): Klemme WP vor/nach jedem Wechsel von Internal_Heater_State, je sprungMin Minuten, Verdichter darf nicht wechseln
        if (c.klemme_heizstab === null) {
            var H = Z.hs, B = H.buf; B.push([t, x.ok && have(x.rohW) ? x.rohW : null, x.heizstab === 1 ? 1 : (x.heizstab === 0 ? 0 : null), x.lauf ? 1 : 0]);
            while (B.length && B[0][0] < t - (2 * ZL.sprungMin + 2) * MIN) { B.shift(); }
            var n = B.length, k = ZL.sprungMin;
            if (n >= 2 * k + 1) {                                                     // Wechsel in der Mitte des Puffers: k Minuten davor und danach gleich, Werte vorhanden
                var mI = n - k - 1, vor = B.slice(mI - k, mI), nach = B.slice(mI, mI + k), hv = vor[vor.length - 1][2], hn = nach[0][2];
                var gleich = function (L, h) { return L.every(function (y) { return y[2] === h && have(y[1]) && y[3] === L[0][3]; }); };
                if (hv !== null && hn !== null && hv !== hn && gleich(vor, hv) && gleich(nach, hn) && vor[0][3] === nach[0][3] && !(H.zuletzt && H.zuletzt === B[mI][0])) {
                    var mw = function (L) { return L.reduce(function (a, y) { return a + y[1]; }, 0) / L.length; }, sp = (hn === 1 ? 1 : -1) * (mw(nach) - mw(vor));
                    H.zuletzt = B[mI][0];
                    if (sp >= ZL.heizMinW && sp <= ZL.heizMaxW) { H.mess.push([B[mI][0], Math.round(sp)]); H.mess = H.mess.slice(-ZL.heizN); }
                    else { H.verworfen = (H.verworfen || 0) + 1; }
                }
            }
        }
        // 24-h-Vergleich Zaehler (ohne Heizstab) gegen TOP16 + Korrektur, je Stunde [nLauf, Zaehler, TOP16, nStand, Zaehler, TOP16]
        if (x.ok && have(x.wpW) && have(x.top16) && x.heizstab !== 1) {
            var hk = hKey(t), a = Z.h[hk] = Z.h[hk] || [0, 0, 0, 0, 0, 0, t];
            if (x.lauf) { a[0]++; a[1] += x.wpW; a[2] += x.top16; } else { a[3]++; a[4] += x.wpW; a[5] += x.top16; }
            Object.keys(Z.h).forEach(function (k2) { if (Z.h[k2][6] < t - (ZL.stunden + 1) * 60 * MIN) { delete Z.h[k2]; } });
        }
        return Z;
    }
    function vergleich(Z, now, korrW) {
        Z = fix(Z); var s = [0, 0, 0, 0, 0, 0];
        Object.keys(Z.h).forEach(function (k) { var a = Z.h[k]; if (a[6] >= now - ZL.stunden * 60 * MIN) { for (var i = 0; i < 6; i++) { s[i] += a[i]; } } });
        var kw = have(korrW) ? korrW : 80, L = s[0] ? {n: s[0], zaehlerW: s[1] / s[0], top16W: s[2] / s[0], diffW: (s[1] - s[2]) / s[0] - kw} : {n: 0};
        var St = s[3] ? {n: s[3], zaehlerW: s[4] / s[3], top16W: s[5] / s[3], diffW: (s[4] - s[5]) / s[3]} : {n: 0};
        return {lauf: L, stand: St, korrW: kw, korrGemessenW: s[0] >= ZL.korrMinN ? Math.round((s[1] - s[2]) / s[0]) : null, n: s[0] + s[3]};
    }
    // Eingabe der Form pruefen: Topic ohne Wildcards, Klemmen 0–2 verschieden, Quelle heishamon|zaehler
    function pruefe(e, alt) {
        e = e && typeof e === 'object' ? e : {};
        var f = [], o = cfgOf(Object.assign({}, cfgOf(alt), e));
        var nullOf = function (v) { return v === null || v === '' || v === 'null' || v === '-' || v === undefined; };
        ['klemme_heizstab', 'klemme_sonstiges'].forEach(function (k) { if (e[k] !== undefined) { o[k] = nullOf(e[k]) ? null : kl(e[k], true); } });
        if (e.klemme_wp !== undefined && kl(e.klemme_wp, true) === null) { f.push('Klemme Wärmepumpe muss 1, 2 oder 3 sein'); }
        if (/[#+\s]/.test(o.topic)) { f.push('MQTT-Name ohne Leerzeichen und ohne # oder +'); }
        if (o.topic.length > 200) { f.push('MQTT-Name zu lang'); }
        var K = [o.klemme_wp, o.klemme_heizstab, o.klemme_sonstiges].filter(function (v) { return v !== null; });
        if (K.length !== K.filter(function (v, i) { return K.indexOf(v) === i; }).length) { f.push('Jede Klemme nur einmal belegen'); }
        if (e.quelle !== undefined && e.quelle !== 'heishamon' && e.quelle !== 'zaehler') { f.push('Quelle heishamon oder zaehler'); }
        if (o.quelle === 'zaehler' && !o.prefix) { f.push('Zähler als Quelle braucht einen MQTT-Namen'); }
        delete o.prefix;
        return {cfg: o, fehler: f};
    }
    function de(v, d) { return have(v) ? (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',').replace('-', '−') : '–'; }
    function sg(v, d) { return have(v) ? (v > 0 ? '+' : '') + de(v, d) : '–'; }
    // Karte "Stromzaehler" (Daten & Guete): Status-Chips, Kennzahlen (eng_ui kind 'zaehler'), Formularwerte. st = stand(), V = vergleich(), x = {top16, lauf, korrW}
    function karte(st, V, c, now, x) {
        c = cfgOf(c); x = x || {};
        var kw = have(x.korrW) ? x.korrW : 80, top = have(x.top16) ? x.top16 + (x.lauf ? kw : 0) : null, status = [], kpi = [];
        if (!c.prefix) { status.push({t: 'nicht eingerichtet', c: 'mute', title: 'MQTT-Name des Shelly eintragen (Gerätename bzw. Topic-Präfix)'}); }
        else if (!have(st.alter)) { status.push({t: 'keine Nachricht', c: 'warn', title: 'abonniert: ' + abos(c).join(', ') + ' (Broker ' + (c.broker === 'nas' ? 'NAS 10.10.10.128' : 'Venus 192.168.5.11') + ')'}); }
        else { status.push({t: st.ok ? 'online · ' + de(st.alter, 0) + ' min' : 'veraltet · ' + de(st.alter, 0) + ' min', c: st.ok ? 'ok' : 'bad', title: st.nachrichten + ' Nachrichten · ' + c.prefix}); }
        if (st.profil) { status.push({t: st.profil === 'triphase' ? 'Drehstrom em:0' : 'drei Kanäle em1', c: 'mute'}); }
        status.push({t: c.broker === 'nas' ? 'Broker NAS' : 'Broker Venus', c: 'mute'});
        if (st.vorzeichen) { status.push({t: 'Vorzeichen prüfen', c: 'warn', title: 'Klemme Wärmepumpe meldet ' + de(st.wp_roh_w, 0) + ' W: Wandler verkehrt herum? Häkchen „Invertieren“ setzen'}); }
        (st.fehler || []).forEach(function (f) { status.push({t: f, c: 'bad'}); });
        status.push(c.quelle === 'zaehler' ? (st.ok ? {t: 'COP mit Zählerstrom', c: 'ok'} : {t: 'Rückfall auf HeishaMon', c: 'bad', title: 'Zähler gewählt, aber älter als ' + ZL.maxAlterMin + ' min'}) : {t: 'COP mit HeishaMon', c: 'mute', title: 'Standard: TOP16 + ' + kw + ' W; Umschalten unten (nach zwei Tagen Vergleich)'});
        var d = st.ok && have(st.wp_w) && have(top) ? st.wp_w - top : null;
        kpi.push({k: 'Wärmepumpe', v: st.ok && have(st.wp_w) ? de(st.wp_w, 0) + ' W' : '–', s: 'TOP16 + Korr. ' + de(top, 0) + ' W' + (have(d) ? ' · ' + sg(d, 0) + ' W' : ''), vc: have(d) && Math.abs(d) > 100 ? 'warn' : '',
                  title: 'Klemme ' + (c.klemme_wp + 1) + (c.invertieren[c.klemme_wp] ? ' (invertiert)' : '') + ', ohne Heizstab · TOP16 ' + de(x.top16, 0) + ' W' + (x.lauf ? ' + ' + kw + ' W (Lauf)' : ' (Stillstand, roh)')});
        kpi.push({k: 'Heizstab', v: st.ok && have(st.heizstab_w) ? de(st.heizstab_w, 0) + ' W' : '–', s: c.klemme_heizstab !== null ? 'Klemme ' + (c.klemme_heizstab + 1) : (heizParamTxt(st)), title: st.heizstab_quelle || ''});
        if (c.klemme_sonstiges !== null) { kpi.push({k: 'Sonstiges', v: st.ok && have(st.sonst_w) ? de(st.sonst_w, 0) + ' W' : '–', s: 'Klemme ' + (c.klemme_sonstiges + 1)}); }
        var L = V.lauf || {}, St = V.stand || {};
        kpi.push({k: 'Lauf · 24 h', v: L.n ? sg(L.diffW, 0) + ' W' : '–', s: L.n ? L.n + ' min · gegen TOP16 + ' + kw + ' W' : 'sammelt', title: L.n ? 'Ø Zähler ' + de(L.zaehlerW, 0) + ' W, Ø TOP16 ' + de(L.top16W, 0) + ' W in ' + L.n + ' Laufminuten (ohne Heizstab)' : ''});
        kpi.push({k: 'Korrektur gemessen', v: have(V.korrGemessenW) ? sg(V.korrGemessenW, 0) + ' W' : '–', s: have(V.korrGemessenW) ? 'statt Annahme ' + kw + ' W' : 'ab ' + ZL.korrMinN + ' Laufminuten', chip: have(V.korrGemessenW) ? null : 'sammelt', c: 'mute',
                  title: 'Zähler − TOP16 im Lauf, gleitend 24 h; mit „Strom für COP = Zähler“ rechnen Ist-COP, COP-Matrix und Zerlegung direkt mit dem Zähler'});
        kpi.push({k: 'Stillstand · 24 h', v: St.n ? sg(St.diffW, 0) + ' W' : '–', s: St.n ? St.n + ' min · Zähler Ø ' + de(St.zaehlerW, 0) + ' W' : 'sammelt'});
        kpi.push({k: 'Zählerstand', v: have(st.kwh_wp) ? de(st.kwh_wp, 1) + ' kWh' : '–', s: have(st.kwh_heizstab) ? 'Heizstab ' + de(st.kwh_heizstab, 1) + ' kWh' : 'Wärmepumpe'});
        return {status: status, kpi: kpi, form: {topic: c.topic, broker: c.broker, profil: c.profil, klemme_wp: c.klemme_wp, klemme_heizstab: c.klemme_heizstab, klemme_sonstiges: c.klemme_sonstiges, invertieren: c.invertieren.slice(), quelle: c.quelle}};
    }
    function heizParamTxt(st) { var q = String(st.heizstab_quelle || ''); return /^gemessen/.test(q) ? 'Sprungerkennung' : 'Annahme 3 kW'; }
    return {karte: karte, ZL: ZL, STD: STD, cfgOf: cfgOf, praefix: praefix, abos: abos, neu: neu, fix: fix, lies: lies, stand: stand, minute: minute, vergleich: vergleich, pruefe: pruefe, heizParam: heizParam};
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = ZAEHLER; }
// == ZAEHLER-CORE-ENDE ==

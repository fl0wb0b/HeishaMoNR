// == WX-CORE ==
// Wetterkarte der Seite "Optimierung" (wetter-grafik 17.10.2026): reine Funktionen, NUR Anzeige, keine Regelwirkung. Vom Generator eingebettet in
//   opt_engine (WXC.copVerlauf -> global OPT_cz_verlauf: COP-Ziel 24 h zurueck aus den Stundenwerten des Kerns, 36 h voraus mit ENGINE.copZiel) und
//   opt_hist   (WXC.daten -> Nachricht an die Karte "Wetter · 24 h zurück, 36 h voraus"). Getestet in tools/wx_core_test.js und tools/optimizer_sim.js.
//   WXC.raster(fpts, a, b, step)      Prognosepunkte [[t, temp, rh, wolken, wind]] linear auf ein Zeitraster (nur innerhalb der Punkte, Luecken > 6 h bleiben null)
//   WXC.abtauBaender(proben, L)       Zeitabschnitte [[a, b]] mit Abtauwetter wie ENGINE.abtauWetter (AT -5 bis unter 10 °C UND Feuchte >= 80 %; ohne Feuchte bis 4 °C)
//   WXC.naechte(a, b, sun)            Naechte [[a, b]] aus Sonnenauf-/-untergang (OPT_weather.sun, OWM) oder fest 18-07 Uhr
//   WXC.gestern(snaps, now, a, b)     OWM-Prognose aus dem Schnappschuss ~24 h zuvor (forecast-recent.json), stuendlich
//   WXC.copVerlauf(E, cfg, S, W, PI, inp, now)   COP-Ziel-Verlauf (Kern E = ENGINE), siehe unten
//   WXC.istAusZeilen(rows)            Ist-COP je Stunde aus den Protokollspalten (cop_korr, leistung_korr_w, verdichter_hz)
//   WXC.symbol(id, tag)               OWM-Wetter-Code + Tag/Nacht -> Symbolname (sonne, mond, sonne_wolke, mond_wolke, wolke, regen, niesel, schnee, nebel, gewitter) oder null
//   WXC.symbole(W, snaps, now, a, b, naechte)   Symbolzeile [[t, Symbol, Beschreibung]]: ab jetzt je Prognosepunkt, davor nur aus Schnappschuessen mit Code
//   WXC.daten(o)                      Nutzlast der Karte
var WXC = (function () {
    var VER = 2, MIN = 60000, H = 3600000;
    var STD = {zurueckH: 24, vorH: 36, progMaxAlterH: 6, piMaxAlterMin: 15, czMaxAlterMin: 15, gesternTolMin: 90, nachtVon: 18, nachtBis: 7,
               abtauAtMin: -5, abtauAtMax: 10, abtauRhMin: 80, abtauAtOhne: 4, abtauRasterMin: 15, istMinZeilen: 3};
    function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') { return null; } v = Number(v); return isFinite(v) ? v : null; }
    function have(v) { return v !== null && v !== undefined && isFinite(v); }
    function r(v, f) { return have(v) ? Math.round(v * f) / f : null; }
    function dew(t, rh) { if (!have(t) || !have(rh)) { return null; } var a = 17.62, b = 243.12, g = Math.log(Math.max(rh, 1) / 100) + a * t / (b + t); return b * g / (a - g); }   // Magnus (wie opt_owm_parse)
    // Schwellen des Abtauwetters: Standard wie die Sperren der Maschine (LOCK_CFG abtauAtMin/-Max/-RhMin/-AtOhne), ueberschrieben von OPT_cfg.engine.locks (nur Zahlen)
    function abtauL(cfg) {
        var L = {}, o = (cfg && cfg.engine && cfg.engine.locks) || {};
        ['abtauAtMin', 'abtauAtMax', 'abtauRhMin', 'abtauAtOhne'].forEach(function (k) { L[k] = have(num(o[k])) ? num(o[k]) : STD[k]; });
        return L;
    }
    function interp(pts, i, t) {                                                     // Spalte i der (sortierten) Punkte [[t, ...]] zur Zeit t, linear; ausserhalb oder bei Luecke null
        if (!Array.isArray(pts) || !pts.length) { return null; }
        for (var k = 0; k < pts.length; k++) {
            var p = pts[k];
            if (p[0] === t) { return num(p[i]); }
            if (p[0] > t) {
                var q = k > 0 ? pts[k - 1] : null;
                if (!q || !have(num(q[i])) || !have(num(p[i])) || p[0] - q[0] > 6 * H) { return null; }
                return q[i] + (p[i] - q[i]) * (t - q[0]) / (p[0] - q[0]);
            }
        }
        return null;
    }
    function raster(fpts, a, b, step) {
        var out = [];
        if (!Array.isArray(fpts) || !(b > a) || !(step > 0)) { return out; }
        var ok = fpts.filter(function (p) { return Array.isArray(p) && have(num(p[0])); }).sort(function (x, y) { return x[0] - y[0]; });
        if (!ok.length) { return out; }
        var lo = Math.max(a, ok[0][0]), hi = Math.min(b, ok[ok.length - 1][0]), first = Math.ceil(lo / step) * step;
        if (lo < first && lo <= hi) { out.push([lo, interp(ok, 1, lo), interp(ok, 2, lo), interp(ok, 3, lo), interp(ok, 4, lo)]); }   // erster Punkt = jetzt (schliesst an die Messung an)
        for (var t = first; t <= hi; t += step) { out.push([t, interp(ok, 1, t), interp(ok, 2, t), interp(ok, 3, t), interp(ok, 4, t)]); }
        return out;
    }
    function abtauJa(at, rh, L) {
        if (!have(at) || at < L.abtauAtMin || at >= L.abtauAtMax) { return false; }
        return have(rh) ? rh >= L.abtauRhMin : at <= L.abtauAtOhne;
    }
    // proben [[t, at, rh, dauer_ms]]: jede Probe deckt [t - dauer/2, t + dauer/2]; Abschnitte mit hoechstens 1 min Abstand werden verbunden
    function abtauBaender(proben, L) {
        var out = [];
        (proben || []).slice().sort(function (x, y) { return x[0] - y[0]; }).forEach(function (p) {
            if (!abtauJa(num(p[1]), num(p[2]), L)) { return; }
            var a = p[0] - p[3] / 2, b = p[0] + p[3] / 2, last = out[out.length - 1];
            if (last && a <= last[1] + MIN) { last[1] = Math.max(last[1], b); } else { out.push([a, b]); }
        });
        return out;
    }
    // Naechte: sun = [Aufgang ms, Untergang ms] (OWM current: sys.sunrise/sunset); die Uhrzeiten (Ortszeit) gelten fuer jeden Tag (sommerzeitfest, wenige Minuten
    // Abweichung je Tag); ohne gueltige Sonnenzeiten fest nachtVon-nachtBis Uhr
    function naechte(a, b, sun) {
        var out = [], d0 = new Date(a), k;
        var ok = Array.isArray(sun) && have(num(sun[0])) && have(num(sun[1])) && sun[1] > sun[0] && sun[1] - sun[0] < 20 * H && Math.abs(sun[0] - a) < 10 * 24 * H;
        var su = ok ? new Date(sun[0]) : null, sd = ok ? new Date(sun[1]) : null;
        for (k = -2; k <= 4; k++) {
            var u = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + k, ok ? sd.getHours() : STD.nachtVon, ok ? sd.getMinutes() : 0, 0).getTime();
            var v = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + k + 1, ok ? su.getHours() : STD.nachtBis, ok ? su.getMinutes() : 0, 0).getTime();
            var x = Math.max(a, u), y = Math.min(b, v);
            if (y > x) { out.push([x, y]); }
        }
        return out;
    }
    // Prognose von gestern: der Schnappschuss (forecast-recent.json: [{t: s, owm: fpts, pv}], stuendlich von opt_energy) am naechsten an now - 24 h (hoechstens gesternTolMin daneben);
    // seine OWM-Temperatur stuendlich in [a, b] (deckt -24 h bis etwa +12 h ab)
    function gestern(snaps, now, a, b) {
        var want = now - 24 * H, best = null;
        (Array.isArray(snaps) ? snaps : []).forEach(function (s) {
            if (!s || !have(num(s.t)) || !Array.isArray(s.owm) || s.owm.length < 2) { return; }
            var d = Math.abs(s.t * 1000 - want);
            if (d <= STD.gesternTolMin * MIN && (!best || d < Math.abs(best.t * 1000 - want))) { best = s; }
        });
        if (!best) { return null; }
        var d = raster(best.owm, a, b, H).filter(function (p) { return have(p[1]); }).map(function (p) { return [p[0], r(p[1], 10)]; });
        return d.length ? {ts: best.t * 1000, d: d} : null;
    }
    // PV-Prognose (OPT_plan_in.pv = [[Beginn ms, W, Dauer ms]]) als Punkte in der Mitte jedes Abschnitts in kW; pvW(t) = Prognose in W zur Zeit t
    function pvPunkte(pv, a, b) {
        return (Array.isArray(pv) ? pv : []).filter(function (x) { return Array.isArray(x) && have(num(x[0])) && have(num(x[1])) && x[0] + (num(x[2]) || H) > a && x[0] < b; })
            .map(function (x) { return [x[0] + (num(x[2]) || H) / 2, r(Math.max(0, x[1]) / 1000, 100)]; }).filter(function (p) { return p[0] >= a && p[0] <= b; }).sort(function (p, q) { return p[0] - q[0]; });
    }
    function pvW(pv, t) {
        var v = null;
        (Array.isArray(pv) ? pv : []).forEach(function (x) { if (Array.isArray(x) && have(num(x[0])) && have(num(x[1])) && t >= x[0] && t < x[0] + (num(x[2]) || H)) { v = Math.max(0, x[1]); } });
        return v;
    }
    function kurveSoll(k, at) {                                                      // Heizkurve Z1 [AT kalt, AT warm, Soll warm, Soll kalt] (wie sollKurve in opt_engine)
        if (!Array.isArray(k) || k.length < 4 || !have(at) || !k.every(function (x) { return have(num(x)); }) || !(k[1] > k[0])) { return null; }
        return at <= k[0] ? k[3] : (at >= k[1] ? k[2] : k[3] + (k[2] - k[3]) * (at - k[0]) / (k[1] - k[0]));
    }
    // Wetter-Symbole (wetter-grafik 17.10.2026): Klassen nach OWM-Code (wie die OWM-Icons: 801/802 Sonne mit Wolke, 803/804 Wolke), Tag/Nacht aus dem Icon, sonst aus den Naechten
    var SYM_TXT = {sonne: 'klar', mond: 'klar', sonne_wolke: 'teils bewölkt', mond_wolke: 'teils bewölkt', wolke: 'bewölkt', regen: 'Regen', niesel: 'Nieselregen', schnee: 'Schnee', nebel: 'Nebel/Dunst', gewitter: 'Gewitter'};
    function symbol(id, tag) {
        id = num(id); if (!have(id) || id < 200 || id > 804 || Math.floor(id) !== id) { return null; }
        var g = Math.floor(id / 100), nacht = tag === 0;
        if (g === 2) { return 'gewitter'; } if (g === 3) { return 'niesel'; } if (g === 5) { return id === 511 ? 'schnee' : 'regen'; } if (g === 6) { return 'schnee'; } if (g === 7) { return 'nebel'; }
        if (id === 800) { return nacht ? 'mond' : 'sonne'; }
        if (id === 801 || id === 802) { return nacht ? 'mond_wolke' : 'sonne_wolke'; }
        if (id === 803 || id === 804) { return 'wolke'; }
        return null;
    }
    function inNacht(t, N) { return (N || []).some(function (b) { return t >= b[0] && t < b[1]; }); }
    function symbole(W, snaps, now, a, b, N) {
        var out = [], D = (W && W.fdesc && typeof W.fdesc === 'object') ? W.fdesc : {};
        var fp = (W && Array.isArray(W.fpts) ? W.fpts : []).filter(function (p) { return Array.isArray(p) && have(num(p[0])) && p[0] >= now - 90 * MIN && p[0] <= b; }).sort(function (x, y) { return x[0] - y[0]; });
        var bis = fp.some(function (p) { return symbol(p[5], 1); }) ? now - 90 * MIN : now;            // mit Symbol "jetzt": Vergangenheit endet 90 min davor (kein Gedraenge am Strich)
        function add(t, id, tag) { var g = (tag === 0 || tag === 1) ? tag : (inNacht(t, N) ? 0 : 1), k = symbol(id, g); if (k) { out.push([t, k, String(D[id] || SYM_TXT[k])]); } }
        // Vergangenheit: je Prognosezeit die zuletzt davor prognostizierte (Schnappschuss mit Zeit <= Punktzeit), nur Punkte mit Code (aeltere Schnappschuesse haben keinen)
        var best = {};
        (Array.isArray(snaps) ? snaps : []).forEach(function (s) {
            if (!s || !have(num(s.t)) || !Array.isArray(s.owm)) { return; }
            var st = s.t * 1000;
            s.owm.forEach(function (p) { if (!Array.isArray(p) || !have(num(p[0])) || p[0] < a || p[0] >= bis || p[0] < st || !have(num(p[5]))) { return; } var c = best[p[0]]; if (!c || st > c.st) { best[p[0]] = {st: st, id: p[5], tag: num(p[6])}; } });
        });
        Object.keys(best).map(Number).sort(function (x, y) { return x - y; }).forEach(function (t) { add(t, best[t].id, best[t].tag); });
        // ab jetzt: Prognosepunkte (der erste, juengstens 90 min alte Punkt = "jetzt" steht am Strich)
        fp.forEach(function (p, i) { add(i === 0 ? Math.max(now, p[0]) : p[0], p[5], num(p[6])); });
        return out;
    }
    function stdKey(k) { var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)$/.exec(k); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], 30, 0).getTime() : null; }
    // COP-Ziel-Verlauf (in opt_engine, alle 5 min). Zurueck: Ziel je Stunde aus dem Kern (S.cz.h, wie die Karte "COP: Ziel und Ist").
    // Voraus: ENGINE.copZiel je Stunde mit der OWM-Prognose (AT, Feuchte), Soll-Vorlauf = Heizkurve Z1 bei der Prognose-AT + jetzige Verschiebung (ohne Kurve: jetziger Soll),
    // PV-Prognose fuer den Sonnenanteil (PV-Spitzen der letzten Tage aus S.cz.pv). Gerechnet wird eine gedachte stationaere Laufminute (ohne Start, Abtauen, Wiederaufheizen):
    // Ziel = eta(Band) x Carnot(Soll + 2,5 K, AT + Sonne - dT_verd) x Abtaufaktor(AT, Feuchte) x Frequenzfaktor(Mindestfrequenz bei dieser AT) - dieselbe Funktion wie im Kern.
    function copVerlauf(E, cfg, S, W, PI, inp, now) {
        var o = {ts: now, v: VER, zh: [], zp: [], soll: null, quelle: null};
        var Z = S && S.cz && S.cz.h ? S.cz : null;
        if (Z) {
            Object.keys(Z.h).sort().forEach(function (k) {
                var t = stdKey(k); if (t === null || t < now - (STD.zurueckH + 1) * H || t > now) { return; }
                var A = E.czAgg([Z.h[k]], false);
                if (have(A.cz)) { o.zh.push([t, A.cz]); }
            });
        }
        if (!W || !Array.isArray(W.fpts) || !have(num(W.f_ts)) || now - W.f_ts > STD.progMaxAlterH * H) { return o; }
        var shift = have(num(inp && inp.shift)) ? num(inp.shift) : 0, k = inp && inp.kurve, sollJetzt = num(inp && inp.soll);
        o.quelle = kurveSoll(k, 0) !== null ? 'kurve' : (have(sollJetzt) ? 'soll' : null);
        if (!o.quelle) { return o; }
        var pv = PI && have(num(PI.ts)) && now - PI.ts <= STD.piMaxAlterMin * MIN ? PI.pv : null;
        var Zp = E.czNew(); Zp.pv = (Z && Z.pv) || {};
        raster(W.fpts, now, now + STD.vorH * H, H).forEach(function (p) {
            if (!have(p[1])) { return; }
            var soll = o.quelle === 'kurve' ? kurveSoll(k, p[1]) + shift : sollJetzt;
            var m = E.copZiel({t: p[0], hz: 17, vl: soll, rl: soll - 2, soll: soll, at: p[1], pel: 400, pth: 2000, hpAge: 0, rh: p[2], pv: pvW(pv, p[0]), defrost: 0, dhw: 0, heater: 0}, cfg, Zp);
            if (have(m.cz)) { o.zp.push([p[0], r(m.cz, 100)]); }
        });
        var sJ = o.quelle === 'kurve' ? kurveSoll(k, num(W.temp)) : null;                 // Anzeige: Soll-Vorlauf jetzt (Kurve bei der OWM-Temperatur jetzt + Verschiebung)
        o.soll = o.quelle === 'kurve' ? (have(sJ) ? r(sJ + shift, 10) : null) : sollJetzt;
        return o;
    }
    // Ist-COP je Stunde aus dem 5-Minuten-Protokoll (Spalten von opt_hist): Waerme = cop_korr x leistung_korr_w (COP und Strom mit Korrektur), nur Zeilen mit laufendem Verdichter,
    // Stunde erst ab istMinZeilen Zeilen (15 min Lauf), Punkt in der Stundenmitte
    function istAusZeilen(rows) {
        var h = {}, out = [];
        (rows || []).forEach(function (x) {
            var hz = num(x.verdichter_hz), c = num(x.cop_korr), p = num(x.leistung_korr_w);
            if (!have(hz) || hz <= 0 || !have(c) || !have(p) || p <= 0 || c <= 0 || c > 15) { return; }
            var k = Math.floor(x.t / H) * H, e = h[k] = h[k] || [0, 0, 0]; e[0] += c * p; e[1] += p; e[2]++;
        });
        Object.keys(h).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) { if (h[k][2] >= STD.istMinZeilen) { out.push([k + H / 2, r(h[k][0] / h[k][1], 100)]); } });
        return out;
    }
    // Nutzlast der Karte. o = {now, rows (Protokollzeilen {t, spalte: text}), W (OPT_weather), PI (OPT_plan_in), CZ (OPT_cz_verlauf), snaps (forecast-recent.json), cfg (OPT_cfg), SO (OPT_sonne)}
    function daten(o) {
        var now = o.now, t0 = now - STD.zurueckH * H, t1 = now + STD.vorH * H, L = abtauL(o.cfg), W = o.W || {};
        var rows = (o.rows || []).filter(function (x) { return x && have(x.t) && x.t >= t0 && x.t <= now + MIN; });
        function col(name, f) { return rows.map(function (x) { return r(num(x[name]), f); }); }
        var hist = {t: rows.map(function (x) { return x.t; }), at: col('aussen_panasonic', 10), owm: col('aussen_wetter', 10), calc: col('aussen_berechnet', 10), dew: col('wetter_taupunkt', 10),
                    rh: col('wetter_feuchte', 1), clouds: col('wetter_bewoelkung', 1), wind: col('wetter_wind_ms', 10),
                    pv: rows.map(function (x) { var v = num(x.pv_w); return have(v) ? r(Math.max(0, v) / 1000, 100) : null; })};
        var fOk = W.status === 'OK' && Array.isArray(W.fpts) && have(num(W.f_ts)) && now - W.f_ts <= STD.progMaxAlterH * H;
        var pr = fOk ? raster(W.fpts, now, t1, H) : [];
        var prog = {t: pr.map(function (p) { return p[0]; }), at: pr.map(function (p) { return r(p[1], 10); }), rh: pr.map(function (p) { return r(p[2], 1); }), clouds: pr.map(function (p) { return r(p[3], 1); }),
                    wind: pr.map(function (p) { return r(p[4], 10); }), dew: pr.map(function (p) { return r(dew(p[1], p[2]), 10); })};
        // Abtauband: bis jetzt aus der Messung (WP-Aussentemperatur, OWM-Feuchte, 5-min-Zeilen), danach aus der Prognose (15-min-Raster)
        var proben = rows.map(function (x) { return [x.t, num(x.aussen_panasonic), num(x.wetter_feuchte), 5 * MIN]; });
        if (fOk) { raster(W.fpts, now, t1, STD.abtauRasterMin * MIN).forEach(function (p) { proben.push([p[0], p[1], p[2], STD.abtauRasterMin * MIN]); }); }
        var abtau = abtauBaender(proben, L).map(function (b) { return [Math.max(t0, b[0]), Math.min(t1, b[1])]; }).filter(function (b) { return b[1] > b[0]; });
        var piOk = !!(o.PI && have(num(o.PI.ts)) && now - o.PI.ts <= STD.piMaxAlterMin * MIN);
        var pvp = piOk ? pvPunkte(o.PI.pv, now, t1) : [];
        if (pvp.length) { var p0 = pvW(o.PI.pv, now); if (have(p0) && pvp[0][0] > now) { pvp.unshift([now, r(p0 / 1000, 100)]); } }
        var CZ = o.CZ && have(num(o.CZ.ts)) && now - o.CZ.ts <= STD.czMaxAlterMin * MIN ? o.CZ : {};
        var ge = gestern(o.snaps, now, t0, t1);
        var SO = o.SO, soOk = !!(SO && have(num(SO.ts)) && now - SO.ts <= 30 * MIN && have(num(SO.aufgang)) && have(num(SO.untergang)));   // Naechte: Sonnenstand (opt_sonne, zeitleiste 18.10.2026), Rueckfall OWM
        var N = naechte(t0, t1, soOk ? [SO.aufgang, SO.untergang] : W.sun);
        return {now: now, t0: t0, t1: t1, n: Math.max(rows.length, pr.length), hist: hist, prog: prog, abtau: abtau, nacht: N, gestern: ge, pv: pvp, sym: symbole(fOk ? W : {}, o.snaps, now, t0, t1, N),
                cop: {zh: (Array.isArray(CZ.zh) ? CZ.zh : []).filter(function (p) { return p[0] >= t0; }), zp: Array.isArray(CZ.zp) ? CZ.zp : [], ih: istAusZeilen(rows), soll: have(num(CZ.soll)) ? CZ.soll : null},
                stand: {wetter: fOk ? W.f_ts : null, pv: piOk ? String(o.PI.pvSrc || '') : null}};
    }
    return {VER: VER, STD: STD, raster: raster, interp: interp, abtauL: abtauL, abtauJa: abtauJa, abtauBaender: abtauBaender, naechte: naechte, gestern: gestern, pvPunkte: pvPunkte, pvW: pvW,
            kurveSoll: kurveSoll, symbol: symbol, symbole: symbole, SYM_TXT: SYM_TXT, copVerlauf: copVerlauf, istAusZeilen: istAusZeilen, daten: daten, dew: dew};
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = WXC; }
// == WX-CORE-ENDE ==

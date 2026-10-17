// Usage: node tools/wx_vorschau_daten.js <ordner>  (danach: OPT_VORSCHAU_SONNE=08:05-18:20 node tools/opt_seiten_vorschau.js <flows> <ui_dump> <ausgabe> <ordner>)
// Nachgebauter Datenordner fuer die Vorschau der Wetterkarte (die echten Replay-Daten im Scratchpad waren geloescht, NAS-Lesen nicht freigegeben).
// Zukunft: echte OWM-Punkte aus dem Schnappschuss vom 17.10.2026 09:02 (forecast-2026-10.jsonl, letzter Eintrag); PV-Prognose: die ersten 5 echten Stundenwerte, danach nachgebaut.
// Vergangenheit (24 h): nachgebaut, Endwerte = letzte echte Protokollzeile 17.10. 09:38:43 (AT 10, OWM 10,19, Feuchte 88, Taupunkt 8,3, Wolken 100, Wind 4,48, PV 1935 W).
process.env.TZ = 'Europe/Berlin';
const fs = require('fs'), path = require('path');
const out = process.argv[2]; fs.mkdirSync(out, {recursive: true});
const MIN = 60000, H = 3600000, NOW = new Date(2026, 9, 17, 9, 38, 43).getTime();
const OWM = [[1792220266754, 10.23, 93, 100, 4.39], [1792227600000, 10.39, 91, 100, 4.51], [1792238400000, 12.7, 73, 75, 5.61], [1792249200000, 12.95, 63, 22, 4.51], [1792260000000, 8.75, 87, 13, 3.42],
             [1792270800000, 5.47, 94, 9, 2.46], [1792281600000, 3.9, 97, 4, 1.78], [1792292400000, 3.9, 99, 100, 2.25], [1792303200000, 5.56, 98, 100, 3.36], [1792314000000, 7.62, 92, 100, 3.85],
             [1792324800000, 11.45, 83, 100, 4.74], [1792335600000, 11.18, 80, 100, 5.19], [1792346400000, 9.2, 89, 89, 5.7]];
const PV0 = [[1792220400, 1803], [1792224000, 3660], [1792227600, 5550], [1792231200, 7288], [1792234800, 8448]];
function dew(t, rh) { const a = 17.62, b = 243.12, g = Math.log(rh / 100) + a * t / (b + t); return b * g / (a - g); }
function hod(t) { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; }
// Wahrheit der Vergangenheit: Tagesgang 16.10. (mild, nachmittags sonnig), Nacht bis 5,5 °C, morgens 10 °C
function atTrue(t) { const h = (t - NOW) / H; const base = 8.6 + 3.4 * Math.cos((hod(t) - 15) / 24 * 2 * Math.PI); return base + (h > -6 ? (h + 6) / 6 * (10 - (8.6 + 3.4 * Math.cos((hod(NOW) - 15) / 24 * 2 * Math.PI))) : 0); }
function rhTrue(t) { return Math.max(55, Math.min(97, 98 - (atTrue(t) - 5) * 4.2)); }
function cloud(t) { const h = hod(t); return (t < NOW - 14 * H) ? 35 : (h > 20 || h < 6 ? 85 : 100); }
function pvTrue(t) { const h = hod(t); if (h < 8 || h > 18.3) { return 0; } const f = Math.sin((h - 8) / 10.3 * Math.PI); return (t < NOW - 12 * H ? 6200 : 2300) * Math.max(0, f); }
const head = ['zeit', 'aussen_panasonic', 'aussen_wetter', 'wetter_feuchte', 'wetter_taupunkt', 'wetter_bewoelkung', 'ki_oben_wert', 'ki_unten_wert', 'schlaf_wert', 'wohn_wert', 'soll_vorlauf', 'vorlauf', 'ruecklauf',
              'verdichter_hz', 'leistung_w', 'cop', 'aussen_berechnet', 'wetter_wind_ms', 'pv_w', 'leistung_korr_w', 'cop_korr'];
const K = [-13, 11, 29, 37], soll = at => Math.round(at <= K[0] ? K[3] : (at >= K[1] ? K[2] : K[3] + (K[2] - K[3]) * (at - K[0]) / (K[1] - K[0])));
const p2 = x => String(x).padStart(2, '0'), f = (v, d) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toString();
const iso = t => { const d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };
let lines = [head.join(',')], seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) - 0.5; };
for (let k = 300; k >= 0; k--) {
    const t = NOW - k * 5 * MIN, at = atTrue(t), sun = pvTrue(t) > 2500 ? 1.6 : 0, atP = Math.round(at + sun), rh = rhTrue(t), hzOn = ((t - NOW) / H % 4 + 4) % 4 < 3.1 || hod(t) < 7;
    const sv = soll(atP), vl = hzOn ? sv + 0.3 * rnd() : sv - 3, pw = hzOn ? 330 + (12 - at) * 8 + 20 * rnd() : 18, cop = hzOn ? 6.9 - (sv - at) * 0.075 + 0.2 * rnd() : null;
    const row = [iso(t), atP, f(at + 0.2 + 0.2 * rnd(), 2), Math.round(rh), f(dew(at, rh), 1), cloud(t), f(23.1 + 0.3 * Math.sin(k / 30), 2), f(21.4 + 0.4 * Math.sin(k / 40), 2), f(20.8 + 0.3 * Math.cos(k / 50), 2), f(23.6 + 0.6 * Math.sin(k / 45), 2),
                 sv, f(vl, 2), f(vl - (hzOn ? 2.1 : 0.4), 2), hzOn ? 16 + (k % 3 === 0 ? 1 : 0) : 0, Math.round(pw), cop === null ? '' : f(cop, 2), f(at + 0.3 * Math.sin(k / 20), 2), f(3 + 1.5 * Math.sin(k / 37) + 0.3 * rnd(), 2), f(pvTrue(t), 0),
                 Math.round(pw + (hzOn ? 80 : 0)), cop === null ? '' : f(cop * pw / (pw + 80), 2)];
    if (k === 0) { row[1] = 10; row[2] = '10.19'; row[3] = 88; row[4] = '8.3'; row[5] = 100; row[17] = '4.48'; row[18] = '1934.66'; }
    lines.push(row.join(','));
}
fs.writeFileSync(path.join(out, 'optimizer-v2-2026-10.csv'), lines.join('\n') + '\n');
// stuendliche Schnappschuesse der letzten 30 h: OWM-Prognose = Wahrheit + wachsender Fehler (gestern ~1 K zu warm); der letzte = echter Schnappschuss 09:02
const sn = [];
for (let k = 30; k >= 1; k--) {
    const ts = Math.floor((NOW - k * H) / H) * H + 3 * MIN, owm = [];
    for (let j = 0; j <= 12; j++) { const tt = ts + j * 3 * H, tr = tt <= NOW ? atTrue(tt) : (function () { for (let i = 1; i < OWM.length; i++) { if (OWM[i][0] >= tt) { const a = OWM[i - 1], b = OWM[i]; return a[1] + (b[1] - a[1]) * (tt - a[0]) / (b[0] - a[0]); } } return OWM[OWM.length - 1][1]; })();
        owm.push([tt, Math.round((tr + 0.9 + j * 0.08) * 100) / 100, 85, 70, 3]); }
    const pv = []; for (let j = 0; j < 37; j++) { const tt = Math.floor(ts / H) * H + j * H; pv.push([tt / 1000, Math.round(pvTrue(tt)), 3600]); }
    sn.push({t: Math.round(ts / 1000), at: Math.round(atTrue(ts)), owm: owm, pv: pv, pvSrc: 'VRM'});
}
const pvF = []; const h0 = 1792220400;
for (let j = 0; j < 37; j++) { const ts = h0 + j * 3600; const known = PV0.find(x => x[0] === ts); const hh = hod(ts * 1000); const day2 = ts * 1000 > NOW + 18 * H;
    pvF.push([ts, known ? known[1] : Math.round(hh < 8 || hh > 18.3 ? 0 : (day2 ? 2600 : 9200) * Math.max(0, Math.sin((hh - 8) / 10.3 * Math.PI))), 3600]); }
sn.push({t: 1792220579, at: 10, owm: OWM, pv: pvF, pvSrc: 'VRM'});
fs.writeFileSync(path.join(out, 'forecast-2026-10.jsonl'), sn.map(x => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(out, 'engine-state.json'), JSON.stringify({S: {kf: {sig: K.join('/')}}}));
console.log('Datenordner ' + out + ': ' + (lines.length - 1) + ' Protokollzeilen, ' + sn.length + ' Schnappschuesse');

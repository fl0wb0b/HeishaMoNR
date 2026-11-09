#!/usr/bin/env node
// Pruefungen fuer tools/cop_eta.js: Zeitfenster der Kalibrierung an lokalen Tagesgrenzen, auch ueber die Zeitumstellung (Tage mit 23 bzw. 25 h).
// Usage: node tools/cop_eta_test.js
'use strict';
process.env.TZ = 'Europe/Berlin';
const K = require('./cop_eta.js');
let ok = 0, fail = 0;
function check(name, ist, soll) { const g = ist === soll; if (g) { ok++; } else { fail++; } console.log((g ? 'OK   ' : 'FAIL ') + name + '  -> ' + new Date(ist).toString().slice(4, 24) + (g ? '' : ' (erwartet ' + new Date(soll).toString().slice(4, 24) + ')')); }

const w = K.fenster('2026-10-25', 1);                                  // Winterzeit: der 25.10.2026 hat 25 Stunden
check('Ende 25.10. = Mitternacht 26.10.', w.bis, new Date(2026, 9, 26).getTime());
check('Beginn 25.10. = Mitternacht 25.10.', w.von, new Date(2026, 9, 25).getTime());
const w21 = K.fenster('2026-11-05', 21);                               // 21 Tage ueber die Umstellung hinweg
check('21-Tage-Fenster beginnt Mitternacht 16.10.', w21.von, new Date(2026, 9, 16).getTime());
check('21-Tage-Fenster endet Mitternacht 06.11.', w21.bis, new Date(2026, 10, 6).getTime());
const s = K.fenster('2027-03-28', 1);                                  // Sommerzeit: der 28.03.2027 hat 23 Stunden
check('Ende 28.03.2027 = Mitternacht 29.03.', s.bis, new Date(2027, 2, 29).getTime());

console.log('');
console.log('ERGEBNIS cop_eta_test: ' + ok + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);

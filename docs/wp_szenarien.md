# Winter-Szenarien: Maschine gegen Anlagen-Zwilling (Stand Winterpaket 16.10.2026)

Erzeugt mit `node tools/engine_vs_zwilling.js tools/fixtures/wp_params.json --szenario …` (Kern winterpaket, Zwilling trainiert auf replay_data_1610) und zum Vergleich mit dem Kern 8321543 bzw. dem Zwilling vom 15.10.; Modell, keine Messung. Erläuterung: docs/OPTIMIERER.md Abschnitt 24.5.

| Szenario | Lauf | Stand | kWh el WP (+ Heizstab) = gesamt | Starts (< 60 min) | Abtauungen | Heizstab-min | Comfort-Laufmin | Hausmittel Ø | K·h unter Minimum | Befehle |
|---|---|---|---|---|---|---|---|---|---|---|
| Frost −10…−2 °C, 80–90 % | schatten | alt (Kern 8321543, Zwilling 15.10.) | 76,0 (+169,0) = 245,0 | 0 (0) | 67 | 3380 | 0 | 15,5 °C | 2269 | 0 |
| Frost −10…−2 °C, 80–90 % | schatten | alter Kern, neuer Zwilling | 73,7 (+138,2) = 211,8 | 0 (0) | 41 | 2763 | 0 | 14,9 °C | 2488 | 0 |
| Frost −10…−2 °C, 80–90 % | schatten | **neu** (Kern + Zwilling Winterpaket) | 73,7 (+138,2) = 211,8 | 0 (0) | 41 | 2763 | 0 | 14,9 °C | 2488 | 0 |
| Frost −10…−2 °C, 80–90 % | schatten | neu, heizstabVorrang = 1 | 73,7 (+138,2) = 211,8 | 0 (0) | 41 | 2763 | 0 | 14,9 °C | 2488 | 0 |
| Frost −10…−2 °C, 80–90 % | sofort | alt (Kern 8321543, Zwilling 15.10.) | 153,5 (+5,5) = 159,1 | 0 (0) | 79 | 111 | 7163 | 17,4 °C | 1327 | 11 |
| Frost −10…−2 °C, 80–90 % | sofort | alter Kern, neuer Zwilling | 143,9 (+3,8) = 147,7 | 1 (0) | 49 | 75 | 7142 | 17,1 °C | 1422 | 11 |
| Frost −10…−2 °C, 80–90 % | sofort | **neu** (Kern + Zwilling Winterpaket) | 134,5 (+13,7) = 148,2 | 1 (0) | 48 | 274 | 5105 | 16,7 °C | 1627 | 11 |
| Frost −10…−2 °C, 80–90 % | sofort | neu, heizstabVorrang = 1 | 143,9 (+3,8) = 147,7 | 1 (0) | 49 | 75 | 7142 | 17,1 °C | 1422 | 11 |
| Abtauwetter −3…+2 °C, 90–95 % | schatten | alt (Kern 8321543, Zwilling 15.10.) | 55,6 (+100,6) = 156,2 | 0 (0) | 79 | 2012 | 0 | 15,7 °C | 2090 | 0 |
| Abtauwetter −3…+2 °C, 90–95 % | schatten | alter Kern, neuer Zwilling | 54,9 (+91,6) = 146,5 | 0 (0) | 75 | 1832 | 0 | 15,3 °C | 2208 | 0 |
| Abtauwetter −3…+2 °C, 90–95 % | schatten | **neu** (Kern + Zwilling Winterpaket) | 54,9 (+91,6) = 146,5 | 0 (0) | 75 | 1832 | 0 | 15,3 °C | 2208 | 0 |
| Abtauwetter −3…+2 °C, 90–95 % | schatten | neu, heizstabVorrang = 1 | 54,9 (+91,6) = 146,5 | 0 (0) | 75 | 1832 | 0 | 15,3 °C | 2208 | 0 |
| Abtauwetter −3…+2 °C, 90–95 % | sofort | alt (Kern 8321543, Zwilling 15.10.) | 116,2 (+3,8) = 119,9 | 12 (0) | 99 | 75 | 6896 | 19,3 °C | 473 | 11 |
| Abtauwetter −3…+2 °C, 90–95 % | sofort | alter Kern, neuer Zwilling | 112,6 (+4,8) = 117,3 | 17 (0) | 105 | 95 | 6833 | 18,5 °C | 769 | 11 |
| Abtauwetter −3…+2 °C, 90–95 % | sofort | **neu** (Kern + Zwilling Winterpaket) | 97,1 (+26,9) = 124,1 | 4 (0) | 99 | 539 | 1577 | 17,4 °C | 1278 | 11 |
| Abtauwetter −3…+2 °C, 90–95 % | sofort | neu, heizstabVorrang = 1 | 112,6 (+4,8) = 117,3 | 17 (0) | 105 | 95 | 6833 | 18,5 °C | 769 | 11 |
| Woche mild → −10 °C → Tauwetter | schatten | alt (Kern 8321543, Zwilling 15.10.) | 85,9 (+83,3) = 169,3 | 3 (0) | 60 | 1667 | 0 | 17,4 °C | 2008 | 0 |
| Woche mild → −10 °C → Tauwetter | schatten | alter Kern, neuer Zwilling | 84,4 (+64,8) = 149,2 | 3 (0) | 45 | 1297 | 0 | 17,2 °C | 2084 | 0 |
| Woche mild → −10 °C → Tauwetter | schatten | **neu** (Kern + Zwilling Winterpaket) | 84,4 (+64,8) = 149,2 | 3 (0) | 45 | 1297 | 0 | 17,2 °C | 2084 | 0 |
| Woche mild → −10 °C → Tauwetter | schatten | neu, heizstabVorrang = 1 | 84,4 (+64,8) = 149,2 | 3 (0) | 45 | 1297 | 0 | 17,2 °C | 2084 | 0 |
| Woche mild → −10 °C → Tauwetter | sofort | alt (Kern 8321543, Zwilling 15.10.) | 143,4 (+3,5) = 146,9 | 7 (0) | 76 | 69 | 7057 | 19,6 °C | 661 | 15 |
| Woche mild → −10 °C → Tauwetter | sofort | alter Kern, neuer Zwilling | 128,4 (+4,6) = 133,1 | 9 (0) | 54 | 92 | 7070 | 18,9 °C | 971 | 17 |
| Woche mild → −10 °C → Tauwetter | sofort | **neu** (Kern + Zwilling Winterpaket) | 127,9 (+7,3) = 135,2 | 10 (0) | 58 | 146 | 2650 | 18,9 °C | 970 | 18 |
| Woche mild → −10 °C → Tauwetter | sofort | neu, heizstabVorrang = 1 | 128,0 (+4,7) = 132,7 | 9 (0) | 53 | 94 | 7040 | 18,9 °C | 991 | 18 |
| mild 8…14 °C | schatten | alt (Kern 8321543, Zwilling 15.10.) | 31,9 (+0,0) = 31,9 | 35 (0) | 0 | 0 | 0 | 21,8 °C | 0 | 0 |
| mild 8…14 °C | schatten | alter Kern, neuer Zwilling | 31,6 (+0,0) = 31,6 | 33 (0) | 0 | 0 | 0 | 21,8 °C | 0 | 0 |
| mild 8…14 °C | schatten | **neu** (Kern + Zwilling Winterpaket) | 31,6 (+0,0) = 31,6 | 33 (0) | 0 | 0 | 0 | 21,8 °C | 0 | 0 |
| mild 8…14 °C | sofort | alt (Kern 8321543, Zwilling 15.10.) | 31,0 (+0,0) = 31,0 | 34 (0) | 0 | 0 | 0 | 21,7 °C | 0 | 13 |
| mild 8…14 °C | sofort | alter Kern, neuer Zwilling | 30,9 (+0,0) = 30,9 | 31 (0) | 0 | 0 | 0 | 21,6 °C | 0 | 17 |
| mild 8…14 °C | sofort | **neu** (Kern + Zwilling Winterpaket) | 30,9 (+0,0) = 30,9 | 31 (0) | 0 | 0 | 0 | 21,6 °C | 0 | 17 |

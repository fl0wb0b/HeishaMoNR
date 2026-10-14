// COP je Frequenzklasse gegen 16-17 Hz, roh (TOP16) und mit der COP-Korrektur +80 W (Grundlage der Schwelle hzHoch 28 Hz von Deckel/Laufzeit v5, 14.10.2026).
// Stabile Laufminuten (ab Laufminute 15, ohne Abtauen/Warmwasser), je Aussenband und Quiet-Stufe. Nur lesen. Usage: node tools/cop_frequenz_analyse.js <Datenordner> [Monat]
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const R = require('./engine_replay.js');
const I = R.buildInputs(process.argv[2], process.argv[3] || '2026-10');
let runStart=null, prev=null; const B={};
const cls=hz=>hz<=17?'16-17':hz<=21?'18-21':hz<=27?'22-27':'>=28';
const band=at=>at<4?'<4':at<8?'4-8':at<11?'8-11':'>=11';
for(const x of I){ if(x.hpAge>2||x.hz===null){continue;} if(x.hz>0){ if(!prev||prev.hz===0||prev.hpAge>6) runStart=x.t; } prev=x;
 if(!(x.hz>0)||!runStart||x.t-runStart<15*60000||x.defrost||x.dhw||x.pel===null||x.pth===null||x.pel<50||x.pth<=0) continue;
 const k=band(x.at)+'|q'+x.q+'|'+cls(x.hz); const o=B[k]=B[k]||{n:0,pel:0,pth:0}; o.n++; o.pel+=x.pel; o.pth+=x.pth; }
for (const kw of [0,80]) { console.log('== Korrektur',kw,'W');
 for(const b of ['<4','4-8','8-11','>=11']) for(const q of [0,1,2,3]){ const base=B[b+'|q'+q+'|16-17']; if(!base) continue; const c0=base.pth/(base.pel+kw*base.n);
  const row=['16-17','18-21','22-27','>=28'].map(c=>{const o=B[b+'|q'+q+'|'+c]; if(!o) return c+': –'; const cop=o.pth/(o.pel+kw*o.n); return c+': '+cop.toFixed(2)+' ('+o.n+' min, '+((cop/c0-1)*100).toFixed(1)+' %)';});
  console.log(b,'Q'+q,row.join(' | ')); } }

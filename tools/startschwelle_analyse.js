// Startschwelle der Leisha (Forum 189605 F3-a gegen Messung, 14.10.2026): wann startet der Verdichter nach einer Pause? Vergleicht Modelle an sauberen Pausen
// (Minutenraster ab 08.10. 11:00, Pumpe laeuft, kein Sollsprung): Soll -3 K (mit Verzug) gegen "Vorlauf < Ruecklauf beim Abschalten - 3 K" (Forum L7, 4004893).
// Nur lesen. Usage: node tools/startschwelle_analyse.js <Datenordner> [Monat 2026-10]
process.env.TZ = process.env.TZ_SIM || 'Europe/Berlin';
const R = require('./engine_replay.js');
const I = R.buildInputs(process.argv[2], process.argv[3] || '2026-10');
// Pausen sammeln (nur Minuten mit frischen Daten, ab 08.10. 10:55 Minutenraster)
let on=null, P=null, pauses=[], lastRun=null;
for (const x of I){ if(x.hpAge>6||x.hz===null) continue; const run=x.hz>0;
 if(!run && on===true){ P={stop:x.t, rlRun:lastRun.rl, vlRun:lastRun.vl, sollRun:lastRun.soll, rows:[]}; }
 if(!run && P) P.rows.push({t:x.t, vl:x.vl, rl:x.rl, soll:x.soll, pump:x.pump, age:x.hpAge});
 if(run && on===false && P){ P.start=x.t; pauses.push(P); P=null; }
 if(run) lastRun=x; on=run; }
const ok=pauses.filter(p=>p.stop>=new Date(2026,9,8,11,0).getTime() && p.rows.every(r=>r.pump>=1000) && !p.rows.some((r,k)=>k&&r.soll!==p.rows[k-1].soll));
console.log('Pausen gesamt',pauses.length,'saubere (Minutenraster, Pumpe an, kein Sollsprung)',ok.length);
function evalModel(name, thrF, waitMin){ const errs=[]; ok.forEach(p=>{ let first=null; for(const r of p.rows){ const th=thrF(p,r); if(th!==null && r.vl<th){first=r.t;break;} } const pred= first===null? null : first+waitMin*60000; errs.push(pred===null? null : Math.round((p.start-pred)/60000)); });
  const v=errs.filter(e=>e!==null), mae=v.reduce((s,e)=>s+Math.abs(e),0)/v.length; console.log(name.padEnd(42),'Fehler min (Ist−Prognose):',errs.join(' '),'| MAE',mae.toFixed(1),'| ohne Ausloesung',errs.filter(e=>e===null).length); }
evalModel('Soll −3,0 K (VL < Soll−3)', (p,r)=>r.soll-3, 0);
evalModel('Soll −3,0 K + 3 min', (p,r)=>r.soll-3, 3);
evalModel('Soll −3,0 K + 9 min', (p,r)=>r.soll-3, 9);
for (const k of [0,1,2,3,5,8,10,15]) { evalModel('RL '+k+' min nach Stopp −3 K (+0)', (p,r)=>{const x=p.rows[Math.min(k,p.rows.length-1)]; return x.rl-3;}, 0); }
evalModel('RL letzte Laufminute −3 K', (p,r)=>p.rlRun-3, 0);
evalModel('RL letzte Laufminute −3 K +3 min', (p,r)=>p.rlRun-3, 3);
evalModel('max(RL−3, Soll−3)', (p,r)=>Math.max(p.rlRun-3, r.soll-3), 0);
evalModel('min(RL−3, Soll−3)', (p,r)=>Math.min(p.rlRun-3, r.soll-3), 0);
// Zeit von "VL <= Soll-3,25" bis Start
console.log('Minuten von erstem VL <= Soll−3,25 bis Start:', ok.map(p=>{const f=p.rows.find(r=>r.vl<=r.soll-3.25); return f?Math.round((p.start-f.t)/60000):'–';}).join(' '));
console.log('VL in der letzten Pausenminute − Soll:', ok.map(p=>{const r=p.rows[p.rows.length-1]; return (r.vl-r.soll).toFixed(2);}).join(' '));
console.log('RL letzte Laufminute − Soll:', ok.map(p=>(p.rlRun-p.sollRun).toFixed(2)).join(' '));

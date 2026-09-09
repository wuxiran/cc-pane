import { readFile } from 'node:fs/promises';

const result=JSON.parse(await readFile(process.argv[2],'utf8'));
const samples=(result.samples??[]).filter(s=>s.appPid===result.appPid&&s.kind==='sample').sort((a,b)=>a.timestampMs-b.timestampMs);
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null;};
const round=n=>n==null?null:Math.round(n*100)/100;
const processes=new Map();
for(const sample of samples){
  for(const process of sample.data.processes??[]){
    const key=`${sample.bootId}:${process.pid}`;
    if(!processes.has(key))processes.set(key,{pid:process.pid,role:process.role,values:[]});
    processes.get(key).values.push({at:sample.timestampMs,memory:process.privateBytes/1048576,cpu:process.cpuPercent??0});
  }
}
const report={appPid:result.appPid,daemonPid:result.daemonPid,error:result.error??null,checks:result.checks,
  sampleCount:samples.length,spanMinutes:round(samples.length?(samples.at(-1).timestampMs-samples[0].timestampMs)/60000:0),
  processMemory:[],frontend:{}};
for(const row of processes.values()){
  const start=row.values[0].at,end=row.values.at(-1).at;
  report.processMemory.push({pid:row.pid,role:row.role,first5MedianMB:round(median(row.values.filter(v=>v.at<start+300000).map(v=>v.memory))),
    last5MedianMB:round(median(row.values.filter(v=>v.at>end-300000).map(v=>v.memory))),peakMB:round(Math.max(...row.values.map(v=>v.memory))),
    meanCpuOneCorePercent:round(row.values.reduce((sum,v)=>sum+v.cpu,0)/row.values.length)});
}
const frontends=samples.map(s=>s.data.frontend).filter(Boolean);
report.frontend={heapFirst5MedianMB:round(median(frontends.slice(0,20).map(f=>f.heapUsedBytes/1048576))),
  heapLast5MedianMB:round(median(frontends.slice(-20).map(f=>f.heapUsedBytes/1048576))),
  maxQueuedChars:Math.max(0,...frontends.map(f=>f.terminals.reduce((sum,t)=>sum+t.queuedChars+t.inFlightChars,0))),
  maxPollingSessions:Math.max(0,...samples.map(s=>s.data.bridge?.pollingSessions??0)),
  maxContextLosses:Math.max(0,...frontends.flatMap(f=>f.terminals.map(t=>t.contextLosses))),
  failedWrites:Math.max(0,...frontends.flatMap(f=>f.terminals.map(t=>t.failedWrites))),
  focusedSamples:frontends.filter(f=>f.focused).length};
// The driver timings and detailed click list remain in the source artifact.
if(report.checks?.layoutSwitch){const {painted,webglCounts,...timing}=report.checks.layoutSwitch;
  report.checks={...report.checks,layoutSwitch:{...timing,allFourWebgl: webglCounts?.every(n=>n===4)}};}
console.log(JSON.stringify(report,null,2));

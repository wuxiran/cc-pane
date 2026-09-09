// Windows-only, isolated real WebView2 + Tauri IPC + daemon acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, copyFile, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const sourceExecutable = resolve(process.argv[3]);
const wallpaper = resolve(process.argv[4]);
const minutes = Number(process.argv[5] ?? 30);
assert.ok(Number.isFinite(minutes)&&minutes>0&&minutes<=480,'duration must be between zero and 480 minutes');
const recoveryMinutes=Number(process.env.CCPANES_SOAK_RECOVERY_MINUTES??0);
assert.ok(Number.isFinite(recoveryMinutes)&&recoveryMinutes>=0&&recoveryMinutes<=60);
const includeResumes=process.env.CCPANES_INCLUDE_RESUMES !== '0';
const codexResumeIds=(process.env.CCPANES_CODEX_RESUME_IDS??'').split(',');
const grokResumeIds=(process.env.CCPANES_GROK_RESUME_IDS??'').split(',');
assert.ok(codexResumeIds.length===2&&grokResumeIds.length===2&&[...codexResumeIds,...grokResumeIds].every(id=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)),
  'provide two UUIDs each in CCPANES_CODEX_RESUME_IDS and CCPANES_GROK_RESUME_IDS');
const artifactRoot = await mkdtemp(join(tmpdir(), 'cc-v13-pressure-'));
const program=join(artifactRoot,'program');await mkdir(join(program,'binaries'),{recursive:true});
const executable=join(program,'cc-panes.exe');await copyFile(sourceExecutable,executable);
for(const name of ['cc-panes-daemon.exe','cc-panes-cli-hook.exe','cc-panes-ctl.exe','cc-panes-web.exe']){
  await copyFile(name==='cc-panes-daemon.exe'&&process.argv[6]?resolve(process.argv[6]):join('src-tauri','binaries',name),join(program,'binaries',name));
}
await cp('src-tauri/resources',join(program,'resources'),{recursive:true});
const profile = join(artifactRoot, 'profile'), project = join(artifactRoot, 'project');
await mkdir(join(profile, 'skills'), {recursive:true}); await mkdir(join(profile, 'wallpapers'), {recursive:true}); await mkdir(project);
await writeFile(join(profile,'skills','legacy-global-skill-cleanup-v1.json'),JSON.stringify({removed:[],preserved:[],failed:[],scope:'isolated-test'}));
const asset=`${randomUUID()}.mp4`;await copyFile(wallpaper,join(profile,'wallpapers',asset));
const settingsTemplate=await readFile('scripts/fixtures/v13-acceptance.toml','utf8');
await writeFile(join(profile,'config.toml'),settingsTemplate.replace('__WALLPAPER_FILE__',asset));
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
const debugPort=await freePort(), orchestratorPort=await freePort();
const env={...process.env,CCPANES_CONFIG_DIR:profile,CCPANES_DAEMON_DATA_DIR:profile,CCPANES_TERMINAL_DAEMON:'1',
  CCPANES_TERMINAL_DAEMON_BIN:join(program,'binaries','cc-panes-daemon.exe'),
  WEBVIEW2_USER_DATA_FOLDER:join(profile,'webview'),
  CC_PANES_ORCHESTRATOR_PORT:String(orchestratorPort),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}`};
for(const key of ['CC_PANES_API_TOKEN','CC_PANES_API_BASE_URL','CC_PANES_API_PORT','CC_PANES_PTY_SESSION_ID','CC_PANES_LAUNCH_ID'])delete env[key];
const app=spawn(executable,[],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
const appLog=createWriteStream(join(artifactRoot,'app.log'));app.stdout.pipe(appLog);app.stderr.pipe(appLog);
let browser,page,daemon,recorderDirectory;const sessions=[],errors=[];const started=Date.now();
const result={artifactRoot,appPid:app.pid,executableSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),
  daemonSha256:createHash('sha256').update(await readFile(join(program,'binaries','cc-panes-daemon.exe'))).digest('hex'),checks:{},samples:[]};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label,timeout=60000,interval=250)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await wait(interval);}throw new Error(`Timeout: ${label}`);};
const call=async(command,args={})=>{
  let timer;try{return await Promise.race([
    page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`IPC timeout: ${command}`)), command==='create_terminal_session'?60000:command==='write_terminal'?120000:15000);}),
  ]);}finally{clearTimeout(timer);}
};

const native=async(mode,extra={})=>await new Promise((resolve,reject)=>{
 const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',resolvePath('scripts/native-v13-host.ps1'),'-Mode',mode,'-AppPid',String(app.pid),'-ExpectedPath',executable];
 for(const [k,v] of Object.entries(extra))args.push('-'+k,String(v));
 const p=spawn('powershell.exe',args,{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
 p.on('error',reject);p.on('exit',code=>{if(code)reject(new Error(err));else {try{resolve(JSON.parse(out));}catch(e){reject(e);}}});
});
const resolvePath=resolve;
async function sample(){
  if(!recorderDirectory)return null;
  const text=await readFile(join(recorderDirectory,'performance.jsonl'),'utf8').catch(()=>"");
  for(const line of text.trim().split("\n").reverse()){
    try{const record=JSON.parse(line);if(record.kind==='sample'&&record.appPid===app.pid)return record;}catch{}
  }
  return null;
}
async function addTerminal(index,layoutName,wsl=false){
 const tabId=`tab-${randomUUID()}`,terminalPaneId=`terminal-${randomUUID()}`,launchId=`launch-${randomUUID()}`;
 const sessionId=await call('create_terminal_session',{request:{projectPath:project,cols:160,rows:45,cliTool:'none',skipMcp:true,launchId,originTabId:tabId,originTerminalPaneId:terminalPaneId,
  ...(wsl?{wsl:{remotePath:'/tmp/ccpanes-v13-resume-stress',distro:'Ubuntu'}}:{})}});sessions.push(sessionId);
 const parent=result.groups[layoutName]?.[0];(result.groups[layoutName]??=[]).push(sessionId);
 await call('plugin:event|emit',{event:'orchestrator-launch-task',payload:{taskId:launchId,projectId:`stress-${index}`,projectPath:project,sessionId,tabId,terminalPaneId,cliTool:'none',layoutName,title:`STRESS ${index+1}`,placement:'beside',...(parent?{parentSessionId:parent}: {})}});return sessionId;
}
async function choose(name){await page.locator(`[role="tab"][title="${name}"]`).evaluate(el=>el.click());await wait(200);}
async function save(){await writeFile(join(artifactRoot,'results.json'),JSON.stringify(result,null,2));}
async function readRecord(){
 const lines=(await readFile(join(recorderDirectory,'performance.jsonl'),'utf8')).trim().split('\n');
 for(let i=lines.length-1;i>=0;i--){try{const r=JSON.parse(lines[i]);if(r.kind==='sample'&&r.appPid===app.pid)return r;}catch{}}
}

try {
 console.log(JSON.stringify({phase:'launch',artifactRoot,appPid:app.pid}));
 await until(async()=>{try{return(await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;}catch{return false;}},'WebView',90000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
 await until(async()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri')||p.url().includes('localhost'));return Boolean(page);},'main page');
 await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);await wait(1500);
 daemon=JSON.parse(await readFile(join(profile,'runtime','daemon-manifest.json'),'utf8'));result.daemonPid=daemon.pid;
 recorderDirectory=(await call('get_performance_recorder_status')).directory;result.recorderDirectory=recorderDirectory;result.groups={};
 await page.evaluate(()=>localStorage.setItem('cc-panes-layout-ui',JSON.stringify({state:{switcherMode:'topbar',layoutBarDensity:'compact'},version:0})));
 await page.reload();await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);await wait(1000);
 for(let i=0;i<16;i++)await addTerminal(i,`BURST-${Math.floor(i/4)+1}`);
 await choose('BURST-1');await wait(500);
 const flood="$e=[char]27; $s=\"X\"*480; for($i=0;$i -lt 30000;$i++){[Console]::Write(\"`r$e[2K$i $s\"); if($i % 200 -eq 0){Start-Sleep -Milliseconds 10}}; [Console]::Write(\"`r`nV13_BURST_DONE`r`n\")\r";
 const startedFlood=Date.now();
 const sent=await Promise.allSettled(sessions.slice(0,16).map(sessionId=>call('write_terminal',{sessionId,data:flood})));
 result.flood={sessions:16,framesPerSession:30000,charactersPerFrameAtLeast:480,totalCharactersAtLeast:230400000,startedFlood,writeResults:sent.map(x=>x.status)};
 // Let each shell reach its prompt before detaching CDP; otherwise the
 // benchmark measures shell startup rather than the flood itself.
 await wait(10000);await sample();await browser.close();browser=null;page=null;
 const deadline=Date.now()+90000;
  while(Date.now()<deadline){const r=await sample();if(r&&!result.samples.some(x=>x.timestampMs===r.timestampMs))result.samples.push(r);await wait(5000);}
  result.checks={detached:true,floodWindowSeconds:90};
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri')||p.url().includes('localhost'));
  const interaction=[];
  for(let i=0;i<20;i++){
    const began=performance.now();
    await Promise.race([
      page.evaluate(title=>document.querySelector(`[role="tab"][title="${title}"]`)?.click(),`BURST-${i%4+1}`),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('layout interaction timeout')),5000)),
    ]);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    interaction.push(performance.now()-began);
  }
  result.interactionAfterFlood={count:interaction.length,p95Ms:[...interaction].sort((a,b)=>a-b)[Math.ceil(interaction.length*.95)-1]};
 await writeFile(join(artifactRoot,'results.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({phase:'detached-observation',artifactRoot,samples:result.samples.length}));
}catch(error){result.error=String(error);await writeFile(join(artifactRoot,'results.json'),JSON.stringify(result,null,2));console.error(JSON.stringify({phase:'failed',artifactRoot,error:String(error)}));process.exitCode=1;}
finally{
 if(page){for(const id of sessions){try{await call('kill_terminal',{sessionId:id});}catch{break;}}}
 await browser?.close().catch(()=>{});app.kill();
 if(!daemon){try{daemon=JSON.parse(await readFile(join(profile,'runtime','daemon-manifest.json'),'utf8'));}catch{}}
 if(daemon?.pid){const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(daemon.pid)}';if($p.Name -eq 'cc-panes-daemon.exe' -and $p.CommandLine.Contains('${profile.replaceAll("'","''")}')){taskkill.exe /PID ${Number(daemon.pid)} /T /F | Out-Null}`;
  await new Promise(r=>spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'ignore'}).on('exit',r));}
 appLog.end();
}

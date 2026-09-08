// Windows-only, isolated real WebView2 + Tauri IPC + daemon acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const sourceExecutable = resolve(process.argv[3]);
const wallpaper = resolve(process.argv[4]);
const minutes = Number(process.argv[5] ?? 30);
assert.ok(Number.isFinite(minutes)&&minutes>0&&minutes<=120,'duration must be between zero and 120 minutes');
const artifactRoot = await mkdtemp(join(tmpdir(), 'cc-v13-desktop-'));
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
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`IPC timeout: ${command}`)),command==='create_terminal_session'?60000:15000);}),
  ]);}finally{clearTimeout(timer);}
};
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
async function installInteractionProbe(){
  await page.evaluate(()=>{
    window.__v13LayoutPaint=[];window.__v13KeyPaint=[];
    document.addEventListener('click',event=>{
      const tab=event.target.closest?.('[role="tab"][title^="PERF-"]');if(!tab)return;
      const start=performance.now(),name=tab.title;
      const ready=()=>{
        const contexts=[...document.querySelectorAll('.xterm[data-cc-transparent-webgl]')].filter(e=>e.getClientRects().length).length;
        if(tab.getAttribute('aria-selected')==='true'&&contexts===4){requestAnimationFrame(()=>window.__v13LayoutPaint.push({name,ms:performance.now()-start}));}
        else if(performance.now()-start<5000)requestAnimationFrame(ready);
      };requestAnimationFrame(ready);
    },true);
    document.addEventListener('keydown',event=>{
      if(!event.target.classList.contains('xterm-helper-textarea'))return;
      if(event.key.length!==1&&event.key!=='Backspace'&&event.key!=='Enter')return;
      const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__v13KeyPaint.push(performance.now()-start)));
    },true);
  });
}
async function sample(){
  if(!recorderDirectory)recorderDirectory=(await call('get_performance_recorder_status')).directory;
  const text=await readFile(join(recorderDirectory,'performance.jsonl'),'utf8');
  const records=text.trim().split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
  return records.filter(r=>r.kind==='sample'&&r.appPid===app.pid).at(-1);
}
async function chooseGroup(name){
  await page.locator(`[role="tab"][title="${name}"]`).click();
  await page.waitForFunction(name=>document.querySelector(`[role="tab"][title="${name}"]`)?.getAttribute('aria-selected')==='true',name);
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
}
async function dragHandle(handle,delta){
  const box=await handle.boundingBox();assert.ok(box);
  await page.mouse.move(box.x+box.width/2,box.y+Math.min(80,box.height/2));await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+delta,box.y+Math.min(80,box.height/2),{steps:8});await page.mouse.up();await wait(200);
}
async function checkGeometryAndDraft(){
  await page.evaluate(()=>{window.__v13TerminalNodes=[...document.querySelectorAll('.cc-terminal-host>.xterm')];});
  await page.getByRole('button',{name:'自动适配布局',exact:true}).click();await wait(300);
  const left=page.getByRole('separator',{name:'调整侧栏宽度',exact:true});
  const before=Number(await left.getAttribute('aria-valuenow'));await dragHandle(left,60);
  assert.equal(Number(await left.getAttribute('aria-valuenow')),before+60);
  await page.getByTestId('titlebar-toggle-right-dock').click();
  const right=page.getByTestId('right-dock-panel').getByRole('separator');
  const rightBefore=Number(await right.getAttribute('aria-valuenow'));await dragHandle(right,-40);
  assert.equal(Number(await right.getAttribute('aria-valuenow')),rightBefore+40);
  await dragHandle(right,rightBefore+40-280+60);
  await page.getByTestId('right-dock-panel').waitFor({state:'hidden'});
  await page.getByTestId('titlebar-toggle-right-dock').click();
  assert.equal(Number(await page.getByTestId('right-dock-panel').getByRole('separator').getAttribute('aria-valuenow')),rightBefore+40);
  await page.getByTestId('titlebar-toggle-right-dock').click();
  assert.ok(await page.evaluate(()=>window.__v13TerminalNodes.length===16&&window.__v13TerminalNodes.every(n=>n.isConnected)),'geometry must preserve terminal instances');
  await page.locator('.xterm:visible .xterm-helper-textarea').last().focus();await page.keyboard.press('Enter');
  await until(async()=>{
    for(const sessionId of sessions){const r=await call('get_terminal_recovery_snapshot',{sessionId});
      if(((r?.checkpoint?.snapshotAnsi??'')+(r?.delta??'')).includes('V13_INPUT_PROOF'))return true;}
    return false;
  },'draft survives layout and sidebar changes',15000,1000);
  result.checks.geometryAndDraft=true;
}
async function checkSettingsDpr(){
  await page.getByRole('button',{name:'设置',exact:true}).first().click();
  const dialog=page.getByTestId('settings-dialog');await dialog.waitFor({state:'visible'});
  const client=await page.context().newCDPSession(page);const values=[];
  for(const scale of [1,1.25,1.5,2]){
    await client.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:scale,mobile:false});await wait(350);
    const view=await dialog.evaluate(el=>{const matrix=new DOMMatrix(getComputedStyle(el).transform);return {dpr:devicePixelRatio,scaleX:matrix.a,scaleY:matrix.d,width:el.getBoundingClientRect().width};});
    assert.ok(Math.abs(view.dpr-scale)<1e-5);assert.ok(Math.abs(view.scaleX-1)<1e-6);assert.ok(Math.abs(view.scaleY-1)<1e-6);values.push(view);
    await page.screenshot({path:join(artifactRoot,`settings-dpr-${scale}.png`)});
  }
  await client.send('Emulation.clearDeviceMetricsOverride');await client.detach();
  await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();await dialog.waitFor({state:'hidden'});
  result.checks.settingsDpr={kind:'real Windows WebView2 with emulated DPR; system display settings unchanged',values};
}
async function checkLayoutList(){
  await page.getByTestId('layout-view-trigger').click();await page.getByTestId('layout-view-mode').click();
  await page.getByRole('button',{name:'布局',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'布局',exact:true});await panel.waitFor({state:'visible'});
  const pin=panel.getByRole('button',{name:'钉住布局面板',exact:true});if(await pin.count())await pin.click();
  const handle=panel.getByRole('separator',{name:'调整布局列表宽度'});
  const before=Number(await handle.getAttribute('aria-valuenow'));await dragHandle(handle,60);
  assert.equal(Number(await handle.getAttribute('aria-valuenow')),before+60);
  const selected=panel.locator('[data-layout-selected="true"]');assert.ok((await selected.getAttribute('title')).startsWith('PERF-'));
  await panel.getByRole('button',{name:'切到顶部布局条',exact:true}).click();
  result.checks.layoutListWidthAndName=true;
}
async function checkCustomSound(layoutId,sessionId){
  const samples=2000,rate=8000,wav=Buffer.alloc(44+samples*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i/rate*880*Math.PI*2)*3000),44+i*2);
  const source=join(project,'verification.wav');await writeFile(source,wav);
  const sound=await call('import_notification_sound',{path:source});assert.equal(sound.mode,'custom');
  await call('set_layout_notification_sound',{layoutId,sound});
  await call('trigger_notification',{request:{kind:'waiting_input',title:'DEV sound preview',sessionId,requiresInput:true,onlyWhenUnfocused:false}});
  await page.getByRole('button',{name:/布局「PERF-A-renamed」提示音/}).click();
  await page.evaluate(()=>{
    window.__v13Audio=[];window.__v13OriginalPlay=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(...args){
      const result=window.__v13OriginalPlay.apply(this,args);
      if(this.tagName==='AUDIO')result.then(()=>window.__v13Audio.push({src:this.src,started:true}),error=>window.__v13Audio.push({error:String(error)}));
      return result;
    };
  });
  await page.getByRole('button',{name:'试听',exact:true}).click();
  await until(()=>page.evaluate(()=>window.__v13Audio.some(x=>x.started)),'custom sound playback',10000);
  await page.evaluate(()=>{HTMLMediaElement.prototype.play=window.__v13OriginalPlay;});
  await page.keyboard.press('Escape');
  const history=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('cc-panes-orchestration-notifications')??'[]'));
  const id=history.find(n=>n.title==='DEV sound preview').id;
  await page.getByTestId(`notification-card-${id}`).getByRole('button',{name:'关闭',exact:true}).click();
  await call('set_layout_notification_sound',{layoutId,sound:{mode:'default'}});
  result.checks.customSoundImportPreview=true;
}
async function closeTestTabs(){
  const ids=await page.locator('[data-tab-id]').evaluateAll(nodes=>nodes.filter(n=>n.textContent.includes('PERF terminal')).map(n=>n.dataset.tabId));
  for(const id of ids){
    const tab=page.locator(`[data-tab-id="${id}"]`);
    await tab.locator('svg.lucide-x').first().evaluate(e=>e.parentElement.click());
    const confirm=page.getByRole('button',{name:'仍然关闭',exact:true});if(await confirm.count())await confirm.click();
    await tab.waitFor({state:'detached'});
  }
  await until(async()=>await page.locator('.cc-terminal-host>.xterm').count()===0,'terminal instance disposal',15000);
  await page.evaluate(()=>{delete window.__v13TerminalNodes;});
  result.checks.closedTerminalInstances={closed:ids.length,remaining:0};
}
try {
  console.log(JSON.stringify({phase:'launch',artifactRoot,appPid:app.pid}));
  await until(async()=>{try{return(await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;}catch{return false;}},'WebView2 debugging endpoint',120000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  await until(async()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri')||p.url().includes('localhost'));return Boolean(page);},'main page');
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);
  const settings=await call('get_settings');
  assert.equal(settings.general.onboardingCompleted,true);assert.equal(settings.wallpaper.enabled,true);
  assert.equal(settings.terminal.rendererMode,'webgl');
  await page.evaluate(()=>localStorage.setItem('cc-panes-layout-ui',JSON.stringify({state:{switcherMode:'topbar',layoutBarDensity:'compact'},version:0})));
  await page.reload();await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);await wait(3000);
  daemon=JSON.parse(await readFile(join(profile,'runtime','daemon-manifest.json'),'utf8'));
  result.daemonPid=daemon.pid;result.daemonStartedAt=daemon.startedAt;
  assert.ok(daemon.startedAt>=started,'must use a newly started test daemon');
  for(let i=0;i<16;i++){
    const tabId=`tab-${randomUUID()}`,terminalPaneId=`terminal-${randomUUID()}`,launchId=`launch-${randomUUID()}`;
    const sessionId=await call('create_terminal_session',{request:{projectPath:project,cols:120,rows:30,cliTool:'none',skipMcp:true,
      launchId,originTabId:tabId,originTerminalPaneId:terminalPaneId}});
    sessions.push(sessionId);
    await call('plugin:event|emit',{event:'orchestrator-launch-task',payload:{taskId:launchId,projectId:`perf-${i}`,projectPath:project,
      sessionId,tabId,terminalPaneId,cliTool:'none',layoutName:`PERF-${String.fromCharCode(65+Math.floor(i/4))}`,title:`PERF terminal ${i+1}`,placement:'beside',
      ...(i%4?{parentSessionId:sessions[Math.floor(i/4)*4]}:{})}});
    await wait(350);
  }
  await until(async()=>await page.locator('[role="tab"][title="PERF-D"]').count()>0,'four layouts');
  await chooseGroup('PERF-A');await wait(2500);
  await page.bringToFront();
  const liveRenderers=await page.locator('.xterm[data-cc-transparent-webgl]:visible').count();
  assert.equal(liveRenderers,4,'the acceptance fixture requires four visible transparent WebGL panes');
  assert.equal(await page.locator('.xterm[data-cc-transparent-webgl]:visible .xterm-scrollable-element').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>!v.paused&&v.videoWidth===3840));
  result.checks.transparentVideo=true;
  const sessionId=sessions[1];
  await chooseGroup('PERF-B');await wait(1500);
  await page.evaluate(()=>{
    window.__v13RecoveryTasks=[];
    window.__v13RecoveryObserver=new PerformanceObserver(list=>window.__v13RecoveryTasks.push(...list.getEntries().map(e=>e.duration)));
    window.__v13RecoveryObserver.observe({type:'longtask'});
  });
  await call('write_terminal',{sessionId,data:"$e=[char]27; [Console]::Write((\"`r$e[2Kworking ... 1234567890\" * 300000)+\"`r$e[2KFINAL V13 RESULT`r`n\")\r"});
  await wait(12000);
  await chooseGroup('PERF-A');
  let recovery;
  await until(async()=>{
    recovery=await call('get_terminal_recovery_snapshot',{sessionId});
    result.checks.checkpointProgress={photoChars:recovery?.checkpoint?.snapshotAnsi.length??0,deltaChars:recovery?.delta.length??0};
    return recovery?.checkpoint!=null&&recovery.checkpoint.snapshotAnsi.length+recovery.delta.length<8100019/10;
  },'real compact checkpoint accepted after hidden overflow',90000,1000);
  assert.equal(typeof recovery.checkpointEpoch,'string');
  assert.equal(recovery.checkpoint.checkpointEpoch,recovery.checkpointEpoch);
  assert.ok(BigInt(recovery.checkpointEpoch)>BigInt(Number.MAX_SAFE_INTEGER));
  assert.ok(recovery.checkpoint.snapshotAnsi.length+recovery.delta.length<8100019/10,'recovery must read a compact screen plus delta');
  const response=await fetch(`http://${daemon.addr}/api/sessions/${sessionId}/recovery-snapshot`,{headers:{Authorization:`Bearer ${daemon.token}`}});
  const raw=await response.text();assert.equal(response.status,200);
  const wireEpoch=raw.match(/"checkpointEpoch"\s*:\s*(\d+)/)?.[1];assert.equal(wireEpoch,recovery.checkpointEpoch);
  result.checks.checkpoint={epoch:recovery.checkpointEpoch,photoChars:recovery.checkpoint.snapshotAnsi.length,deltaChars:recovery.delta.length};
  const recoveryTasks=await page.evaluate(()=>{window.__v13RecoveryObserver.disconnect();return window.__v13RecoveryTasks;});
  result.checks.recoveryLongTasks={count:recoveryTasks.length,maxMs:Math.max(0,...recoveryTasks)};
  console.log(JSON.stringify({phase:'checkpoint',...result.checks.checkpoint}));
  for(let i=0;i<8;i++){await chooseGroup(`PERF-${String.fromCharCode(65+i%4)}`);await wait(300);}
  await installInteractionProbe();
  const swaps=[],webglCounts=[];
  for(let i=0;i<50;i++){const at=performance.now();await chooseGroup(`PERF-${String.fromCharCode(65+i%4)}`);swaps.push(performance.now()-at);
    webglCounts.push(await page.locator('.xterm[data-cc-transparent-webgl]:visible').count());await wait(150);}
  await wait(100);
  const painted=await page.evaluate(()=>window.__v13LayoutPaint);
  result.checks.layoutSwitch={count:swaps.length,p95DriverMs:percentile(swaps,0.95),p95Ms:percentile(painted.map(v=>v.ms),0.95),painted,webglCounts};
  assert.equal(painted.length,50,'all layout clicks must reach a rendered frame');
  await page.locator('.xterm:visible .xterm-helper-textarea').last().focus();
  await page.keyboard.type("Write-Output ('V13'+'_'+'INPUT'+'_'+'PROOF')",{delay:60});await wait(150);
  const keyPaint=await page.evaluate(()=>window.__v13KeyPaint);
  result.checks.inputResponse={count:keyPaint.length,p95Ms:percentile(keyPaint,0.95),definition:'keydown to next complete animation frame'};
  await checkGeometryAndDraft();
  const untilTime=Date.now()+3600000;
  await call('set_notification_snooze',{sessionId,until:untilTime});
  const prefs=await call('get_notification_preferences');assert.equal(prefs.sessionSnoozes[sessionId],untilTime);
  await call('trigger_notification',{request:{kind:'waiting_input',title:'DEV snooze verification',sessionId,onlyWhenUnfocused:false}});
  await wait(1000);
  assert.equal(await page.getByText('DEV snooze verification',{exact:true}).count(),0);
  const history=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('cc-panes-orchestration-notifications')??'[]'));
  assert.ok(history.some(n=>n.title==='DEV snooze verification'&&n.localSuppressed===true&&n.read===false),'suppressed alerts must remain unread in history');
  await call('set_notification_snooze',{sessionId,until:null});
  assert.equal((await call('get_notification_preferences')).sessionSnoozes[sessionId],undefined);
  result.checks.snooze=true;
  const layoutId=await page.locator('[role="tab"][title="PERF-A"]').getAttribute('data-layout-id');
  await call('set_layout_notification_sound',{layoutId,sound:{mode:'silent'}});
  assert.deepEqual((await call('get_notification_preferences')).layoutSounds[layoutId],{mode:'silent'});
  await page.locator('[role="tab"][title="PERF-A"]').dblclick();
  await page.locator('input[value="PERF-A"]').fill('PERF-A-renamed');await page.keyboard.press('Enter');
  assert.equal(await page.locator('[role="tab"][title="PERF-A-renamed"]').getAttribute('data-layout-id'),layoutId);
  assert.deepEqual((await call('get_notification_preferences')).layoutSounds[layoutId],{mode:'silent'});
  result.checks.layoutSoundRename=true;
  if(process.argv[6])await checkCustomSound(layoutId,sessionId);
  await page.getByTestId('system-resource-segment').click();
  await page.getByRole('combobox',{name:'资源排序'}).selectOption('memory');
  await page.getByText('占用排行',{exact:true}).waitFor({state:'visible'});
  const resourceHandle=page.getByRole('separator',{name:'调整资源面板宽度'});
  const resourceWidth=Number(await resourceHandle.getAttribute('aria-valuenow'));await dragHandle(resourceHandle,-60);
  assert.equal(Number(await resourceHandle.getAttribute('aria-valuenow')),resourceWidth+60);
  await page.screenshot({path:join(artifactRoot,'resource-panel.png')});await page.keyboard.press('Escape');
  result.checks.resourceSort=true;
  if(process.argv[6])await checkLayoutList();
  await page.screenshot({path:join(artifactRoot,'desktop.png')});
  await checkSettingsDpr();
  assert.deepEqual(errors,[]);
  assert.ok(result.checks.recoveryLongTasks.maxMs<250,'recovery must not block the main thread for 250 ms');
  assert.ok(webglCounts.every(n=>n===4),'rapid switches must not strand visible panes on DOM');
  assert.ok(result.checks.layoutSwitch.p95Ms<=300,`layout switch P95 ${result.checks.layoutSwitch.p95Ms} ms`);
  assert.ok(result.checks.inputResponse.count>=20&&result.checks.inputResponse.p95Ms<=100,'input frame latency must meet 100 ms P95');
  for(const sessionId of sessions){await call('write_terminal',{sessionId,data:`$e=[char]27; for($i=0;$i -lt ${Math.ceil(minutes*600)};$i++){[Console]::Write("\u0060r$e[2KPERF SOAK $i"); Start-Sleep -Milliseconds 100}\r`});}
  if(process.env.CCPANES_SOAK_DETACH==='1'){
    await sample();await browser.close();browser=null;page=null;await wait(1000);
    assert.equal(app.exitCode,null,'disconnecting CDP must leave the test application running');
    result.checks.detachedSoak=true;
  }
  const deadline=Date.now()+minutes*60000;
  console.log(JSON.stringify({phase:'soak',minutes,artifactRoot}));
  while(Date.now()<deadline){
    const record=await sample();if(record&&!result.samples.some(r=>r.timestampMs===record.timestampMs))result.samples.push(record);
    await wait(Math.min(15000,Math.max(1,deadline-Date.now())));
  }
  result.checks.soakMinutes=minutes;
  if(!page){
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri')||p.url().includes('localhost'));
    assert.ok(page);page.on('pageerror',error=>errors.push(error.message));
  }
  await closeTestTabs();
  result.pageErrors=errors;
  await writeFile(join(artifactRoot,'results.json'),JSON.stringify(result,null,2));
  assert.deepEqual(errors,[]);
  assert.ok(webglCounts.every(n=>n===4),'rapid switches must not strand visible panes on DOM');
  assert.ok(result.checks.layoutSwitch.p95Ms<=300,`layout switch P95 ${result.checks.layoutSwitch.p95Ms} ms`);
  assert.ok(result.checks.inputResponse.count>=20&&result.checks.inputResponse.p95Ms<=100,'input frame latency must meet 100 ms P95');
  console.log(JSON.stringify({phase:'passed',artifactRoot,checks:result.checks}));
} catch(error){
  result.error=String(error);result.pageErrors=errors;
  await writeFile(join(artifactRoot,'results.json'),JSON.stringify(result,null,2));
  if(page)await page.screenshot({path:join(artifactRoot,'failure.png')}).catch(()=>{});
  console.error(JSON.stringify({phase:'failed',artifactRoot,error:String(error)}));process.exitCode=1;
} finally {
  if(page){for(const sessionId of sessions){try{await call('kill_terminal',{sessionId});}catch{break;}}}
  await browser?.close().catch(()=>{});app.kill();
  if(!daemon){try{daemon=JSON.parse(await readFile(join(profile,'runtime','daemon-manifest.json'),'utf8'));}catch{}}
  if(daemon?.pid){
    // Revalidate command identity before terminating this test's daemon: a PID
    // read at startup alone is not sufficient after a long soak.
    const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(daemon.pid)}'; if($p.Name -eq 'cc-panes-daemon.exe' -and $p.CommandLine.Contains('${profile.replaceAll("'","''")}')) { taskkill.exe /PID ${Number(daemon.pid)} /T /F | Out-Null }`;
    await new Promise(r=>spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'ignore'}).on('exit',r));
  }
  appLog.end();
}

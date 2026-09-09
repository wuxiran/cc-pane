import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const wallpaper = await readFile(process.argv[3]);
const html = await readFile('scripts/fixtures/terminal-transparent-webgl.html','utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const bundle = await build({stdin:{contents:script.replaceAll("'/web/","'@/"),loader:'ts',resolveDir:process.cwd()},bundle:true,
  write:false,outdir:'fixture',format:'esm',platform:'browser',alias:{'@':resolve('web')},define:{'import.meta.env.DEV':'false'}});
const pageHtml=html.replace(/<script type="module">[\s\S]*?<\/script>/,'<link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script>');
const assets=new Map(bundle.outputFiles.map(f=>[f.path.endsWith('.css')?'/fixture.css':'/fixture.js',f.text]));
const server=createServer((req,res)=>{
  if(req.url==='/wallpaper.mp4') {
    const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range??'');
    const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),wallpaper.length-1):wallpaper.length-1;
    res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,
      ...(range?{'Content-Range':`bytes ${start}-${end}/${wallpaper.length}`}:{})});res.end(wallpaper.subarray(start,end+1));return;
  }
  res.writeHead(200,{'Content-Type':req.url?.endsWith('.css')?'text/css':req.url?.endsWith('.js')?'text/javascript':'text/html'});
  res.end(assets.get(req.url)??pageHtml);
});
const artifacts=await mkdtemp(join(tmpdir(),'cc-v13-transparent-'));let browser;
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1100,height:700}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.fixtureReady);
  await page.evaluate(()=>window.prepareTransparent());
  await page.waitForFunction(()=>window.sample);
  const sample=await page.evaluate(()=>window.sample);
  assert.equal(sample.renderer.activeRenderer,'webgl');
  assert.ok(sample.background[3]>=45&&sample.background[3]<=60,`alpha=${sample.background[3]}`);
  assert.ok(sample.maxGlyphAlpha>240,'text must remain opaque');
  await page.waitForFunction(()=>document.querySelector('video').currentTime>0.2);
  const before=await page.locator('video').evaluate(v=>({time:v.currentTime,width:v.videoWidth,height:v.videoHeight}));
  await page.waitForTimeout(400);
  const after=await page.locator('video').evaluate(v=>v.currentTime);
  assert.ok(after>before.time,'video must continue playing');
  // Validate the composited page too: the xterm scroll viewport used to cover
  // a correctly transparent canvas with an opaque CSS background.
  await page.locator('video').evaluate(v=>v.pause());
  await page.waitForTimeout(100);
  const composited=(await page.screenshot()).toString('base64');
  await page.locator('#host').evaluate(v=>v.style.visibility='hidden');
  const backdrop=(await page.screenshot()).toString('base64');
  const pixels=await page.evaluate(async images=>{
    return Promise.all(images.map(async data=>{
      const image=new Image();image.src=`data:image/png;base64,${data}`;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(300,150,1,1).data];
    }));
  },[composited,backdrop]);
  for(let i=0;i<3;i++) assert.ok(Math.abs(pixels[0][i]-pixels[1][i]*0.8)<=4,`composite channel ${i}: ${pixels}`);
  await page.locator('#host').evaluate(v=>v.style.visibility='visible');
  await page.locator('video').evaluate(v=>v.play());
  await page.screenshot({path:join(artifacts,'transparent-webgl.png')});
  const budget=await page.evaluate(()=>window.testBudget());
  assert.equal(budget.peak,8);assert.deepEqual(budget.resumed,['webgl','webgl','webgl','webgl']);assert.equal(budget.remaining,0);
  assert.deepEqual(errors,[]);
  const result={sample,video:before,compositePixels:pixels,budget,artifacts};await writeFile(join(artifacts,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await new Promise(r=>server.close(r)); }

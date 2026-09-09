import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Use the project's Playwright or an already installed external copy; no dependency writes.
const playwrightModule = process.argv[2] || process.env.CCPANES_PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "cc-panes-static-replay-"));
const html = await readFile(resolve("scripts/fixtures/terminal-static-replay.html"), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const bundle = await build({
  stdin: { contents: script.replaceAll("'/web/", "'@/"), loader: "ts", resolveDir: process.cwd() },
  bundle: true, write: false, outdir: "fixture", platform: "browser", format: "esm",
  alias: { "@": resolve("web") }, define: { "import.meta.env.DEV": "false" },
  plugins: [{ name: "checkpoint-test-transport", setup(builder) {
    builder.onResolve({ filter: /^@\/services\/terminalCheckpoint$/ }, () => ({ path: "checkpoint", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents:
      `export async function uploadCheckpoint(id, cp) { window.uploads.push(cp); return {kind:'accepted', anchorSeq:cp.anchorSeq}; }`,
    }));
  } }],
});
const assets = new Map([
  ["/fixture.js", ["text/javascript", bundle.outputFiles.find(file => file.path.endsWith(".js")).text]],
  ["/fixture.css", ["text/css", bundle.outputFiles.find(file => file.path.endsWith(".css")).text]],
]);
const pageHtml = html.replace(/<script type="module">[\s\S]*?<\/script>/,
  '<link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script>');
const server = createServer((request, response) => {
  const [type, body] = assets.get(request.url) ?? ["text/html", pageHtml];
  response.writeHead(200, { "Content-Type": type }); response.end(body);
});
let browser;
const results = [];
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  browser = await chromium.launch({ headless: true, channel: process.argv[3] || process.env.CCPANES_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 850, height: 500 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.fixtureReady);
  for (const renderer of ["dom", "webgl"]) {
    for (const followBottom of [false, true]) {
      const name = `${renderer}-${followBottom ? "bottom" : "history"}`;
      console.log(`[static-replay] ${name}`);
      await page.evaluate(([mode, follow]) => window.prepare(mode, follow), [renderer, followBottom]);
      await page.locator("#host > .xterm").screenshot({ path: join(artifacts, `${name}-before.png`) });
      const before = await page.locator("#host > .xterm .xterm-screen").screenshot();
      await page.evaluate(() => window.startRecovery());
      await page.waitForFunction(() => window.replayPaused);
      assert.equal(await page.locator("#host > .xterm:not(.cc-terminal-static-frame)").evaluate(el => getComputedStyle(el).opacity), "0");
      await page.locator(".cc-terminal-static-frame").screenshot({ path: join(artifacts, `${name}-during.png`) });
      const during = await page.locator(".cc-terminal-static-frame .xterm-screen").screenshot();
      assert.ok(before.equals(during), `${name}: terminal content must match pixel for pixel (excluding scrollbar fade)`);
      await page.evaluate(() => window.resumeReplay());
      await page.waitForFunction(() => window.recoveryDone, null, { timeout: 60_000 });
      const result = await page.evaluate(() => window.recovery);
      assert.equal(await page.locator(".cc-terminal-static-frame").count(), 0);
      if (followBottom) assert.equal(result.after, result.baseY);
      else assert.equal(result.current, result.anchor);
      assert.ok(result.snapshotChars > 0 && result.snapshotChars < result.rawChars / 10, `${name}: parsed snapshot must replace the redraw history`);
      await page.locator("#host > .xterm").screenshot({ path: join(artifacts, `${name}-after.png`) });
      if (!followBottom) {
        const after = await page.locator("#host > .xterm .xterm-screen").screenshot();
        assert.ok(before.equals(after), `${name}: retained history must also render correctly after the swap`);
      }
      results.push({ name, ...result });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, artifacts, results }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

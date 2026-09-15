// Windows-host-required. Verify the built app with a real, deliberately occupied
// MCP port in an isolated profile; no user daemon or sessions are touched.
// node scripts/smoke-release-ui-desktop.mjs PLAYWRIGHT_MODULE PROGRAM_DIR EVIDENCE_DIR
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32');
const [modulePath, programArg, evidenceArg] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const program = resolve(programArg);
const root = await mkdtemp(join(resolve(evidenceArg), 'release-ui-native-'));
const profile = join(root, 'profile');
await mkdir(join(profile, 'skills'), { recursive: true });
await writeFile(join(profile, 'skills', 'legacy-global-skill-cleanup-v1.json'), JSON.stringify({ removed: [], preserved: [], failed: [], scope: 'isolated-test' }));
const settings = (await readFile('scripts/fixtures/v13-acceptance.toml', 'utf8'))
  .replace('[wallpaper]\nenabled = true', '[wallpaper]\nenabled = false');
await writeFile(join(profile, 'config.toml'), settings);
async function reservePort() {
  const server = createServer(socket => socket.end());
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, port: server.address().port };
}
const blocked = await reservePort(), debugging = await reservePort();
await new Promise(done => debugging.server.close(done));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('CC_PANES_')) delete env[key];
Object.assign(env, { CC_PANES_WORKSPACE_NAME: 'ccpane-workspace', CCPANES_CONFIG_DIR: profile,
  CCPANES_DAEMON_DATA_DIR: profile, CCPANES_TERMINAL_DAEMON: '1',
  CCPANES_TERMINAL_DAEMON_BIN: join(program, 'binaries', 'cc-panes-daemon.exe'),
  CC_PANES_ORCHESTRATOR_PORT: String(blocked.port), WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugging.port}` });
const app = spawn(join(program, 'cc-panes.exe'), [], { cwd: program, env, stdio: ['ignore', 'pipe', 'pipe'] });
const log = createWriteStream(join(root, 'app.log')); app.stdout.pipe(log); app.stderr.pipe(log);
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    assert.equal(app.exitCode, null, 'isolated app exited');
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error(`timeout: ${label}`);
}
let browser, page;
const result = { appPid: app.pid, root, checks: {}, pageErrors: [] };
const id = 'orchestrator-mcp-alert';
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${debugging.port}/json/version`)).ok; } catch { return false; } }, 'WebView2', 90000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugging.port}`);
  await until(() => { page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost')); return Boolean(page); }, 'page');
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__));
  const call = (command, args = {}) => page.evaluate(([name, args]) => window.__TAURI_INTERNALS__.invoke(name, args), [command, args]);
  const card = page.getByTestId(`notification-card-${id}`);
  await card.waitFor({ state: 'visible', timeout: 45000 });
  const placement = await page.getByTestId('notification-center').evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { position: style.position, right: style.right, bottom: style.bottom,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.equal(placement.position, 'fixed');
  assert.ok(placement.x > placement.viewportWidth / 2 && placement.y > placement.viewportHeight / 2);
  assert.ok(Math.abs(placement.x + placement.width - placement.viewportWidth + 12) <= 2);
  result.checks.cornerPlacement = placement;
  await page.screenshot({ path: join(root, 'retry-corner.png') });
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  await until(async () => (await call('get_orchestrator_status')).lifecycle === 'failed', 'real bind retries exhausted', 45000);
  await wait(2500);
  assert.equal(await card.count(), 0);
  result.checks.dismissSurvivesRemainingRetries = true;

  // Exercise the UI recovery boundary through its normal event subscription.
  // This does not claim that the intentionally blocked test server recovered.
  const failed = await call('get_orchestrator_status');
  await call('plugin:event|emit', { event: 'orchestrator-status-changed', payload: { ...failed, lifecycle: 'ready', attempt: null, lastError: null, nextRetryAt: null } });
  await wait(200);
  await call('plugin:event|emit', { event: 'orchestrator-status-changed', payload: failed });
  await card.waitFor({ state: 'visible' });
  assert.equal(await card.getByText('MCP 服务未启动', { exact: true }).count(), 1);
  const occurrences = await page.getByText('MCP 服务未启动', { exact: true }).all();
  assert.equal(occurrences.length, 1, 'no duplicate top banner');
  const rect = await occurrences[0].boundingBox();
  assert.ok(rect.y > placement.viewportHeight / 2, 'alert title must remain in the lower half');
  result.checks.noTopBanner = true;
  result.checks.uiRecoveryStartsNewAlert = true;
  await page.screenshot({ path: join(root, 'failed-corner.png') });
  await card.getByRole('button', { name: '展开全文', exact: true }).click();
  await page.screenshot({ path: join(root, 'expanded-details.png') });
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(root, 'dismissed.png') });

  // Verify the user-visible entries in the same production WebView2 bundle.
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await call('create_workspace', { name: 'ccpane-workspace', path: project });
  await call('add_project', { path: project });
  for (const density of ['comfortable', 'compact']) {
    await page.evaluate(density => localStorage.setItem('cc-panes-layout-ui', JSON.stringify({
      state: { switcherMode: 'topbar', layoutBarDensity: density }, version: 0,
    })), density);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__));
    const cluster = page.getByTestId('layout-preset-cluster');
    await cluster.waitFor({ state: 'visible' });
    const automation = cluster.getByTestId('layout-special-automations');
    await automation.waitFor({ state: 'visible' });
    assert.equal(await automation.getAttribute('aria-label'), '自动化');
    const starred = cluster.getByTestId('layout-special-starred');
    assert.equal((await starred.innerText()).trim(), '');
    const preset = cluster.getByRole('button', { name: '布局预设', exact: true });
    assert.equal((await preset.innerText()).trim(), '');
    const agent = cluster.getByTestId('layout-special-agent-chat');
    const a = await agent.boundingBox(), b = await automation.boundingBox();
    if (density === 'comfortable') assert.ok(b.y >= a.y + a.height, 'automation belongs below Agent Chat');
    else assert.ok(Math.abs(a.y - b.y) < 4, 'compact entries share one row');
    await cluster.screenshot({ path: join(root, `layout-cluster-${density}.png`) });
    await automation.click();
    await page.getByTestId('automations-section').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(root, `automations-${density}.png`) });
    result.checks[`automation-${density}`] = { visible: true, navigatesToAutomations: true, iconOnlyLowerRow: true };
    await page.keyboard.press('Escape');
    await page.getByTestId('automations-section').waitFor({ state: 'hidden' });
  }

  // Opening through Automations guarantees the settings dialog is mounted first.
  await page.getByTestId('layout-special-automations').click();
  await page.getByTestId('automations-section').waitFor({ state: 'visible' });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cc-panes:settings-navigate', { detail: { paneId: 'provider-credentials' } })));
  const toolTabs = page.getByRole('tablist', { name: '选择 CLI', exact: true });
  await toolTabs.waitFor({ state: 'visible' });
  const expectedTools = ['claude', 'codex', 'gemini', 'kimi', 'opencode', 'cursor', 'grok', 'pi', 'omp', 'jcode'];
  for (const tool of expectedTools) {
    const tab = toolTabs.locator(`[data-cli-tool="${tool}"]`);
    await tab.waitFor({ state: 'visible' });
    assert.equal(await tab.locator(`[data-cli-brand="${tool}"]`).count(), 1);
  }
  await toolTabs.locator('[data-cli-tool="codex"]').click();
  assert.equal(await toolTabs.locator('[data-cli-tool="codex"]').getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '从 cc-switch 导入', exact: true }).waitFor({ state: 'visible' });
  result.checks.providerBrands = { tools: expectedTools.length, selectionWorks: true, importEntryVisible: true };
  await page.screenshot({ path: join(root, 'provider-brand-icons.png') });
  await page.keyboard.press('Escape');

  assert.deepEqual(result.pageErrors, []);
  result.pass = true;
} catch (error) {
  result.pass = false; result.error = error.message; process.exitCode = 1;
} finally {
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
  try {
    const daemon = JSON.parse(await readFile(join(profile, 'runtime', 'daemon-manifest.json'), 'utf8'));
    await fetch(`http://${daemon.addr}/api/daemon/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${daemon.token}` }, signal: AbortSignal.timeout(5000) });
  } catch {}
  await Promise.race([browser?.close().catch(() => {}), wait(3000)]);
  app.kill(); log.end(); blocked.server.close();
  console.log(JSON.stringify({ root, pass: result.pass, checks: result.checks, error: result.error }));
}

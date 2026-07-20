// Smoke: Web 远程只读模式（remote_read_only）
// 1. 起 cc-panes-web（临时 data dir，config.toml 打开 remoteReadOnly）
// 2. 本机来源（无代理头）：读写均放行
// 3. 伪造 X-Forwarded-For（模拟 Tailscale Serve 转发的远程流量）：
//    GET 放行、查询型 POST 白名单放行、写 POST/DELETE 403 READ_ONLY
// 4. /api/auth/status 对远程来源返回 readOnly=true
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cargoTargetDir } from "./cargo-target-dir.cjs";
import { createConnection } from "node:net";

function log(message) {
  console.log(`[smoke-web-readonly] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(command, args) {
  log(`$ ${command} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, shell: false });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

function cargoBinary(name) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  // 不要写死 "target"：`.cargo/config.toml` 把 target-dir 指到了仓库外。
  return path.resolve(cargoTargetDir(), "debug", `${name}${suffix}`);
}

async function getAvailablePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (connected) return;
    await sleep(300);
  }
  fail(`web server did not open port ${port} within ${timeoutMs}ms`);
}

async function request(baseUrl, pathname, { method = "GET", body, remote = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (remote) {
    // Tailscale Serve 会把远程流量以回环源 IP + X-Forwarded-For 转入
    headers["x-forwarded-for"] = "100.64.0.5";
  }
  return fetch(`${baseUrl}${pathname}`, { method, headers, body });
}

async function main() {
  const tempDirs = [];
  let web;
  try {
    await run("cargo", ["build", "-p", "cc-panes-web"]);

    const dataDir = await mkdtemp(path.join(tmpdir(), "cc-panes-web-readonly-smoke-"));
    tempDirs.push(dataDir);
    await writeFile(
      path.join(dataDir, "config.toml"),
      "[webAccess]\nremoteReadOnly = true\n",
    );

    const port = await getAvailablePort();
    web = spawn(
      cargoBinary("cc-panes-web"),
      ["--port", String(port), "--cwd", tmpdir(), "--data-dir", dataDir],
      { stdio: "inherit", windowsHide: true },
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForPort(port);

    // 1. 本机来源：读 + 写均放行
    const localStatus = await request(baseUrl, "/api/auth/status");
    if (!localStatus.ok) fail(`local auth status failed: ${localStatus.status}`);
    const localAuth = await localStatus.json();
    if (localAuth.readOnly !== false) fail(`local origin must not be read-only: ${JSON.stringify(localAuth)}`);

    const localCreate = await request(baseUrl, "/api/todos", {
      method: "POST",
      body: JSON.stringify({ title: "readonly-smoke", projectPath: null }),
    });
    if (!localCreate.ok) fail(`local todo create should pass: ${localCreate.status} ${await localCreate.text()}`);
    const createdTodo = await localCreate.json();
    log("local write allowed ✓");

    // 2. 远程来源：auth status 报告 readOnly=true
    const remoteStatus = await request(baseUrl, "/api/auth/status", { remote: true });
    const remoteAuth = await remoteStatus.json();
    if (remoteAuth.readOnly !== true) fail(`remote origin must be read-only: ${JSON.stringify(remoteAuth)}`);
    log("remote auth status reports readOnly ✓");

    // 3. 远程来源：GET 放行
    const remoteGet = await request(baseUrl, "/api/workspaces", { remote: true });
    if (!remoteGet.ok) fail(`remote GET should pass: ${remoteGet.status}`);
    log("remote GET allowed ✓");

    // 4. 远程来源：查询型 POST 白名单放行
    const remoteQuery = await request(baseUrl, "/api/todos/query", {
      method: "POST",
      body: JSON.stringify({}),
    remote: true,
    });
    if (!remoteQuery.ok) fail(`remote query POST should pass: ${remoteQuery.status} ${await remoteQuery.text()}`);
    log("remote query POST allowed ✓");

    // 5. 远程来源：写 POST / DELETE 被 403 READ_ONLY 拒绝
    for (const [pathname, options] of [
      ["/api/todos", { method: "POST", body: JSON.stringify({ title: "denied" }) }],
      [`/api/todos/${encodeURIComponent(createdTodo.id)}`, { method: "DELETE" }],
      ["/api/git/pull", { method: "POST", body: JSON.stringify({ path: tmpdir() }) }],
    ]) {
      const response = await request(baseUrl, pathname, { ...options, remote: true });
      if (response.status !== 403) {
        fail(`remote write ${options.method} ${pathname} should be 403, got ${response.status}`);
      }
      const payload = await response.json();
      if (payload.code !== "READ_ONLY") fail(`expected READ_ONLY code, got ${JSON.stringify(payload)}`);
    }
    log("remote writes rejected with READ_ONLY ✓");

    // 6. 收尾：本机来源删除 todo 仍放行
    const localDelete = await request(baseUrl, `/api/todos/${encodeURIComponent(createdTodo.id)}`, {
      method: "DELETE",
    });
    if (!localDelete.ok) fail(`local delete should pass: ${localDelete.status}`);
    log("all checks passed");
  } finally {
    if (web && !web.killed) web.kill();
    await sleep(200);
    await Promise.allSettled(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

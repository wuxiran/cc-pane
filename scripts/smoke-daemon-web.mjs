import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const TOKEN = "ccpanes-smoke-token";
const DAEMON_RUNTIME_PREFIX = "cc-panes-daemon-smoke-runtime-";
const DAEMON_DATA_PREFIX = "cc-panes-daemon-smoke-data-";
const WEB_DATA_PREFIX = "cc-panes-web-smoke-data-";
const READY_TIMEOUT_MS = 15_000;
const WS_TIMEOUT_MS = 8_000;

function log(message) {
  process.stdout.write(`[smoke:daemon-web] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function cargoBinary(name) {
  const extension = process.platform === "win32" ? ".exe" : "";
  return path.join("target", "debug", `${name}${extension}`);
}

function spawnProcess(command, args, name) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const logs = [];
  const collect = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.join("").length > 20_000) {
      logs.splice(0, logs.length - 20);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  child.once("exit", (code, signal) => {
    if (code !== 0 && signal == null) {
      log(`${name} exited with code ${code}`);
    }
  });

  return {
    child,
    name,
    logs,
    async stop() {
      if (child.exitCode != null || child.signalCode != null) return;
      child.kill(process.platform === "win32" ? undefined : "SIGTERM");
      await sleep(500);
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to allocate local port"));
        }
      });
    });
  });
}

async function run(command, args) {
  log(`${command} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    fail(`${options.method ?? "GET"} ${pathname} -> HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function requestNoContent(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    fail(`${options.method ?? "GET"} ${pathname} -> HTTP ${response.status}: ${await response.text()}`);
  }
}

function authHeaders(token = TOKEN) {
  return { authorization: `Bearer ${token}` };
}

async function waitFor(fn, description, timeoutMs = READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  fail(`Timed out waiting for ${description}.${suffix}`);
}

async function waitForManifest(runtimeDir) {
  const manifestPath = path.join(runtimeDir, "daemon-manifest.json");
  return waitFor(async () => {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    if (!manifest.addr || !manifest.token) return null;
    return { manifest, manifestPath };
  }, "daemon manifest");
}

async function openTerminalWebSocket(url, sessionId, input) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received = [];
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for terminal output on ${sessionId}`));
    }, WS_TIMEOUT_MS);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close races during failure cleanup
      }
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "input", data: input }));
    });

    ws.addEventListener("message", (event) => {
      const text = String(event.data);
      received.push(text);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return;
      }
      if (payload.type === "exit") {
        const output = received.join("\n");
        finish(null, { output, exitCode: payload.exitCode });
      }
    });

    ws.addEventListener("error", () => {
      finish(new Error(`WebSocket error for ${sessionId}`));
    });
  });
}

function assertContains(value, expected, context) {
  if (!value.includes(expected)) {
    fail(`${context} did not contain ${JSON.stringify(expected)}.\nObserved:\n${value}`);
  }
}

function assertExitCode(value, context) {
  if (value !== 0 && value !== 1) {
    fail(`${context} expected exit code 0 or PTY-normalized 1, got ${value}`);
  }
}

async function createSession(baseUrl, cwd, headers = {}) {
  const body = JSON.stringify({
    cwd,
    cols: 100,
    rows: 30,
    launchClaude: false,
    cliTool: "none",
  });
  const response = await requestJson(baseUrl, "/api/sessions", {
    method: "POST",
    headers,
    body,
  });
  if (!response?.sessionId) {
    fail(`create session returned invalid payload: ${JSON.stringify(response)}`);
  }
  return response.sessionId;
}

async function waitForOutput(baseUrl, sessionId, marker, headers = {}) {
  return waitFor(async () => {
    const output = await requestJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/output?lines=50`, {
      headers,
    });
    const text = Array.isArray(output?.lines) ? output.lines.join("\n") : "";
    return text.includes(marker) ? text : null;
  }, `output marker ${marker}`);
}

async function verifyTerminalPath({ name, baseUrl, wsUrl, cwd, headers = {}, marker }) {
  log(`verifying ${name}`);
  const sessionId = await createSession(baseUrl, cwd, headers);
  const input = `echo ${marker}\rexit 7\r`;
  const wsResult = await openTerminalWebSocket(wsUrl(sessionId), sessionId, input);
  assertContains(wsResult.output, marker, `${name} WebSocket output`);
  assertExitCode(wsResult.exitCode, `${name} WebSocket exit event`);

  const output = await waitForOutput(baseUrl, sessionId, marker, headers);
  assertContains(output, marker, `${name} HTTP output`);

  const status = await requestJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/status`, {
    headers,
  });
  if (status.status !== "exited") {
    fail(`${name} status expected exited, got ${JSON.stringify(status)}`);
  }
  assertExitCode(status.exitCode, `${name} status exitCode`);
}

async function main() {
  const tempDirs = [];
  const processes = [];
  try {
    await run("cargo", ["build", "-p", "cc-panes-daemon", "-p", "cc-panes-web"]);

    const daemonRuntimeDir = await mkdtemp(path.join(tmpdir(), DAEMON_RUNTIME_PREFIX));
    const daemonDataDir = await mkdtemp(path.join(tmpdir(), DAEMON_DATA_PREFIX));
    const webDataDir = await mkdtemp(path.join(tmpdir(), WEB_DATA_PREFIX));
    tempDirs.push(daemonRuntimeDir, daemonDataDir, webDataDir);

    const daemon = spawnProcess(
      cargoBinary("cc-panes-daemon"),
      [
        "--port",
        "0",
        "--token",
        TOKEN,
        "--runtime-dir",
        daemonRuntimeDir,
        "--cwd",
        tmpdir(),
        "--data-dir",
        daemonDataDir,
      ],
      "daemon",
    );
    processes.push(daemon);

    const { manifest, manifestPath } = await waitForManifest(daemonRuntimeDir);
    if (manifest.token !== TOKEN) {
      fail("daemon manifest token mismatch");
    }
    const daemonBaseUrl = `http://${manifest.addr}`;
    await waitFor(
      async () => {
        const health = await requestJson(daemonBaseUrl, "/api/health");
        return health.status === "ok";
      },
      "daemon health",
    );
    await requestJson(daemonBaseUrl, "/api/daemon/status", {
      headers: authHeaders(),
    });

    await verifyTerminalPath({
      name: "daemon direct path",
      baseUrl: daemonBaseUrl,
      wsUrl: (sessionId) => `ws://${manifest.addr}/ws/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(TOKEN)}`,
      cwd: tmpdir(),
      headers: authHeaders(),
      marker: "CCPANES_DAEMON_DIRECT_SMOKE",
    });

    const webPort = await getAvailablePort();
    const web = spawnProcess(
      cargoBinary("cc-panes-web"),
      [
        "--port",
        String(webPort),
        "--cwd",
        tmpdir(),
        "--data-dir",
        webDataDir,
        "--daemon-manifest",
        manifestPath,
      ],
      "web",
    );
    processes.push(web);

    const webBaseUrl = `http://127.0.0.1:${webPort}`;
    await waitFor(
      async () => {
        const response = await fetch(webBaseUrl);
        return response.ok;
      },
      "web static index",
    );

    await verifyTerminalPath({
      name: "web daemon proxy path",
      baseUrl: webBaseUrl,
      wsUrl: (sessionId) => `ws://127.0.0.1:${webPort}/ws/${encodeURIComponent(sessionId)}`,
      cwd: tmpdir(),
      marker: "CCPANES_WEB_DAEMON_PROXY_SMOKE",
    });

    await requestNoContent(daemonBaseUrl, "/api/daemon/shutdown", {
      method: "POST",
      headers: authHeaders(),
    });
    log("passed");
  } catch (error) {
    for (const processInfo of processes) {
      const text = processInfo.logs.join("").trim();
      if (text) {
        process.stderr.write(`\n--- ${processInfo.name} logs ---\n${text}\n`);
      }
    }
    throw error;
  } finally {
    await Promise.allSettled(processes.map((processInfo) => processInfo.stop()));
    await Promise.allSettled(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

main().catch((error) => {
  console.error(`[smoke:daemon-web] failed: ${error.message}`);
  process.exit(1);
});

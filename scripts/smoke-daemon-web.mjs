import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { cargoTargetDir } from "./cargo-target-dir.cjs";
import { verifyWebGitApis } from "./smoke-daemon-web-git.mjs";
import { verifyWebHistoryApis } from "./smoke-daemon-web-history.mjs";
import { verifyWebLaunchProfileApis } from "./smoke-daemon-web-launch-profiles.mjs";
import { verifyWebLocalHistoryApis } from "./smoke-daemon-web-local-history.mjs";
import { verifyWebMemoryApis } from "./smoke-daemon-web-memory.mjs";
import { verifyWebMcpApis } from "./smoke-daemon-web-mcp.mjs";
import { verifyWebPlanApis } from "./smoke-daemon-web-plans.mjs";
import { verifyWebRunnerApis } from "./smoke-daemon-web-runner.mjs";
import { verifyWebSkillsApis } from "./smoke-daemon-web-skills.mjs";
import { verifyWebSshMachineApis } from "./smoke-daemon-web-ssh-machines.mjs";
import { verifyWebUsageStatsApis } from "./smoke-daemon-web-usage-stats.mjs";
import { verifyWebWorkspaceMigrationApis } from "./smoke-daemon-web-workspace-migration.mjs";

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
  // 不要写死 "target"：`.cargo/config.toml` 把 target-dir 指到了仓库外。
  return path.join(cargoTargetDir(), "debug", `${name}${extension}`);
}

function spawnProcess(command, args, name, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
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

function assertEquals(actual, expected, context) {
  if (actual !== expected) {
    fail(`${context} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertExitCode(value, context) {
  if (value !== 0 && value !== 1) {
    fail(`${context} expected exit code 0 or PTY-normalized 1, got ${value}`);
  }
}

async function createSession(baseUrl, cwd, headers = {}, options = {}) {
  const body = JSON.stringify({
    cwd,
    cols: 100,
    rows: 30,
    launchClaude: false,
    cliTool: "none",
    ...(options.launchProfileId ? { launchProfileId: options.launchProfileId } : {}),
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

async function verifyTerminalPath({
  name,
  baseUrl,
  wsUrl,
  cwd,
  headers = {},
  marker,
  launchProfileId,
}) {
  log(`verifying ${name}`);
  const sessionId = await createSession(baseUrl, cwd, headers, { launchProfileId });
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

async function verifyWebResourceApis(webBaseUrl, rootDir) {
  log("verifying web resource APIs");
  const projectDir = path.join(rootDir, "project-a");
  const filesDir = path.join(rootDir, "files");
  const nestedDir = path.join(filesDir, "nested");
  const notePath = path.join(nestedDir, "note.txt");
  await mkdir(projectDir, { recursive: true });
  await mkdir(filesDir, { recursive: true });

  const workspace = await requestJson(webBaseUrl, "/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "smoke-workspace",
      path: rootDir,
    }),
  });
  if (workspace.name !== "smoke-workspace") {
    fail(`workspace create returned invalid payload: ${JSON.stringify(workspace)}`);
  }
  const workspaceProject = await requestJson(webBaseUrl, "/api/workspaces/smoke-workspace/projects", {
    method: "POST",
    body: JSON.stringify({ path: projectDir }),
  });
  if (!workspaceProject.id || workspaceProject.path !== projectDir) {
    fail(`workspace project create returned invalid payload: ${JSON.stringify(workspaceProject)}`);
  }
  await requestNoContent(webBaseUrl, "/api/workspaces/smoke-workspace/alias", {
    method: "PATCH",
    body: JSON.stringify({ alias: "Smoke Workspace" }),
  });
  const savedWorkspace = await requestJson(webBaseUrl, "/api/workspaces/smoke-workspace");
  if (savedWorkspace.alias !== "Smoke Workspace" || savedWorkspace.projects.length !== 1) {
    fail(`workspace round trip returned invalid payload: ${JSON.stringify(savedWorkspace)}`);
  }

  await requestNoContent(webBaseUrl, "/api/fs/create-directory", {
    method: "POST",
    body: JSON.stringify({ path: nestedDir }),
  });
  await requestNoContent(webBaseUrl, "/api/fs/create-file", {
    method: "POST",
    body: JSON.stringify({ path: notePath }),
  });
  await requestNoContent(webBaseUrl, "/api/fs/write", {
    method: "POST",
    body: JSON.stringify({ path: notePath, content: "CCPANES_WEB_RESOURCE_SMOKE" }),
  });
  const file = await requestJson(webBaseUrl, `/api/fs/read?path=${encodeURIComponent(notePath)}`);
  if (file.content !== "CCPANES_WEB_RESOURCE_SMOKE") {
    fail(`file read returned invalid payload: ${JSON.stringify(file)}`);
  }
  const listing = await requestJson(
    webBaseUrl,
    `/api/fs/list?path=${encodeURIComponent(nestedDir)}&showHidden=false`,
  );
  if (!Array.isArray(listing.entries) || listing.entries.length !== 1) {
    fail(`directory list returned invalid payload: ${JSON.stringify(listing)}`);
  }
  const info = await requestJson(webBaseUrl, `/api/fs/info?path=${encodeURIComponent(notePath)}`);
  if (!info.isFile) {
    fail(`file info returned invalid payload: ${JSON.stringify(info)}`);
  }

  await requestNoContent(webBaseUrl, "/api/providers", {
    method: "POST",
    body: JSON.stringify({
      id: "smoke-provider",
      name: "Smoke Provider",
      providerType: "anthropic",
      apiKey: "smoke-key",
      isDefault: true,
    }),
  });
  const defaultProvider = await requestJson(webBaseUrl, "/api/providers/default");
  if (defaultProvider?.id !== "smoke-provider") {
    fail(`default provider returned invalid payload: ${JSON.stringify(defaultProvider)}`);
  }
  await requestNoContent(webBaseUrl, "/api/providers/smoke-provider", {
    method: "DELETE",
  });

  const settings = await requestJson(webBaseUrl, "/api/settings");
  if (!settings || typeof settings !== "object" || !settings.terminal) {
    fail(`settings returned invalid payload: ${JSON.stringify(settings)}`);
  }
}

async function verifyWebWorkflowApis(webBaseUrl, rootDir) {
  log("verifying web workflow APIs");
  const projectDir = path.join(rootDir, "workflow-project");
  await mkdir(projectDir, { recursive: true });

  const todo = await requestJson(webBaseUrl, "/api/todos", {
    method: "POST",
    body: JSON.stringify({
      title: "Smoke workflow todo",
      priority: "high",
      scope: "project",
      scopeRef: projectDir,
      tags: ["smoke", "workflow"],
    }),
  });
  if (!todo.id) {
    fail(`todo create returned invalid payload: ${JSON.stringify(todo)}`);
  }
  assertEquals(todo.status, "todo", "todo create status");

  const subtask = await requestJson(webBaseUrl, `/api/todos/${encodeURIComponent(todo.id)}/subtasks`, {
    method: "POST",
    body: JSON.stringify({ title: "Smoke subtask" }),
  });
  if (!subtask.id || subtask.todoId !== todo.id) {
    fail(`subtask create returned invalid payload: ${JSON.stringify(subtask)}`);
  }

  const updatedTodo = await requestJson(webBaseUrl, `/api/todos/${encodeURIComponent(todo.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "in_progress", myDay: true }),
  });
  assertEquals(updatedTodo.status, "in_progress", "todo update status");
  assertEquals(updatedTodo.myDay, true, "todo update myDay");

  const toggledSubtask = await requestJson(
    webBaseUrl,
    `/api/todo-subtasks/${encodeURIComponent(subtask.id)}/toggle`,
    { method: "POST" },
  );
  assertEquals(toggledSubtask, true, "subtask toggle result");

  const todoQuery = await requestJson(webBaseUrl, "/api/todos/query", {
    method: "POST",
    body: JSON.stringify({ scope: "project", scopeRef: projectDir, search: "workflow" }),
  });
  assertEquals(todoQuery.total, 1, "todo query total");

  const batchUpdated = await requestJson(webBaseUrl, "/api/todos/batch-status", {
    method: "POST",
    body: JSON.stringify({ ids: [todo.id], status: "done" }),
  });
  assertEquals(batchUpdated, 1, "todo batch status count");

  const todoStats = await requestJson(
    webBaseUrl,
    `/api/todos/stats?scope=project&scopeRef=${encodeURIComponent(projectDir)}`,
  );
  assertEquals(todoStats.total, 1, "todo stats total");

  const spec = await requestJson(webBaseUrl, "/api/specs", {
    method: "POST",
    body: JSON.stringify({
      projectPath: projectDir,
      title: "Smoke Web Spec",
      tasks: ["Spec task A", "Spec task B"],
    }),
  });
  if (!spec.id || !spec.todoId) {
    fail(`spec create returned invalid payload: ${JSON.stringify(spec)}`);
  }

  const specs = await requestJson(webBaseUrl, `/api/specs?projectPath=${encodeURIComponent(projectDir)}`);
  if (!Array.isArray(specs) || specs.length !== 1) {
    fail(`spec list returned invalid payload: ${JSON.stringify(specs)}`);
  }

  const specContentPath = `/api/specs/${encodeURIComponent(spec.id)}/content?projectPath=${encodeURIComponent(projectDir)}`;
  const specContent = await requestJson(webBaseUrl, specContentPath);
  assertContains(specContent, "Smoke Web Spec", "spec content");

  await requestNoContent(webBaseUrl, `/api/specs/${encodeURIComponent(spec.id)}/content`, {
    method: "PUT",
    body: JSON.stringify({
      projectPath: projectDir,
      content: specContent.replace("## Tasks", "## Tasks\n\n- [x] Spec task A\n"),
    }),
  });

  const activeSpec = await requestJson(webBaseUrl, `/api/specs/${encodeURIComponent(spec.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "active" }),
  });
  assertEquals(activeSpec.status, "active", "spec update status");

  await requestNoContent(webBaseUrl, `/api/specs/${encodeURIComponent(spec.id)}/sync-tasks`, {
    method: "POST",
    body: JSON.stringify({ projectPath: projectDir }),
  });

  const binding = await requestJson(webBaseUrl, "/api/task-bindings", {
    method: "POST",
    body: JSON.stringify({
      title: "Smoke task binding",
      projectPath: projectDir,
      sessionId: "smoke-task-session",
      cliTool: "codex",
    }),
  });
  if (!binding.id) {
    fail(`task binding create returned invalid payload: ${JSON.stringify(binding)}`);
  }
  assertEquals(binding.status, "pending", "task binding create status");

  const foundBinding = await requestJson(
    webBaseUrl,
    "/api/task-bindings/by-session?sessionId=smoke-task-session",
  );
  assertEquals(foundBinding?.id, binding.id, "task binding by session id");

  const runningBinding = await requestJson(webBaseUrl, `/api/task-bindings/${encodeURIComponent(binding.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "running", progress: 42 }),
  });
  assertEquals(runningBinding.progress, 42, "task binding update progress");

  const patchedBinding = await requestJson(
    webBaseUrl,
    `/api/task-bindings/${encodeURIComponent(binding.id)}/merge-patch`,
    {
      method: "PATCH",
      body: JSON.stringify({ metadata: { smoke: { verified: true } } }),
    },
  );
  assertEquals(patchedBinding.metadata?.smoke?.verified, true, "task binding merge patch metadata");

  const bindingQuery = await requestJson(webBaseUrl, "/api/task-bindings/query", {
    method: "POST",
    body: JSON.stringify({ projectPath: projectDir, status: "running" }),
  });
  assertEquals(bindingQuery.total, 1, "task binding query total");

  const deletedBinding = await requestJson(webBaseUrl, `/api/task-bindings/${encodeURIComponent(binding.id)}`, {
    method: "DELETE",
  });
  assertEquals(deletedBinding, true, "task binding delete result");

  const planPath = path.join(projectDir, "plan.md");
  const leader = await requestJson(webBaseUrl, "/api/plan-collaboration/leader", {
    method: "POST",
    body: JSON.stringify({
      planPath,
      projectPath: projectDir,
      title: "Smoke Plan",
      sessionId: "smoke-leader-session",
      cliTool: "claude",
    }),
  });
  assertEquals(leader.role, "leader", "plan leader role");
  assertEquals(leader.status, "running", "plan leader status");

  const worker = await requestJson(webBaseUrl, "/api/plan-collaboration/worker", {
    method: "POST",
    body: JSON.stringify({
      leaderId: leader.id,
      sessionId: "smoke-worker-session",
      projectPath: projectDir,
      title: "Smoke Worker",
      cliTool: "codex",
    }),
  });
  assertEquals(worker.role, "worker", "plan worker role");

  const child = await requestJson(webBaseUrl, "/api/plan-collaboration/child", {
    method: "POST",
    body: JSON.stringify({
      leaderId: leader.id,
      sessionId: "smoke-child-session",
      projectPath: projectDir,
      title: "Smoke Child",
      cliTool: "claude",
    }),
  });
  assertEquals(child.role, "worker", "plan child compatibility role");

  const collaboration = await requestJson(
    webBaseUrl,
    `/api/plan-collaboration?leaderId=${encodeURIComponent(leader.id)}&verbose=true`,
  );
  assertEquals(collaboration.leader.id, leader.id, "plan collaboration leader id");
  assertEquals(collaboration.total, 2, "plan collaboration worker total");
  assertEquals(collaboration.workers.length, 2, "plan collaboration workers length");

  const reconciled = await requestJson(
    webBaseUrl,
    `/api/plan-collaboration/reconcile?leaderId=${encodeURIComponent(leader.id)}&verbose=false`,
    { method: "POST" },
  );
  assertEquals(reconciled.total, 2, "plan collaboration reconciled total");

  const cascadeDeleted = await requestJson(
    webBaseUrl,
    `/api/task-bindings/${encodeURIComponent(leader.id)}/cascade`,
    { method: "DELETE" },
  );
  assertEquals(cascadeDeleted, true, "plan collaboration cascade delete");

  await requestNoContent(
    webBaseUrl,
    `/api/specs/${encodeURIComponent(spec.id)}?projectPath=${encodeURIComponent(projectDir)}`,
    { method: "DELETE" },
  );
  await requestNoContent(webBaseUrl, `/api/todos/${encodeURIComponent(todo.id)}`, {
    method: "DELETE",
  });
}

async function main() {
  const tempDirs = [];
  const processes = [];
  try {
    await run("cargo", ["build", "-p", "cc-panes-daemon", "-p", "cc-panes-web"]);

    const daemonRuntimeDir = await mkdtemp(path.join(tmpdir(), DAEMON_RUNTIME_PREFIX));
    const daemonDataDir = await mkdtemp(path.join(tmpdir(), DAEMON_DATA_PREFIX));
    const webDataDir = daemonDataDir;
    const webHomeDir = await mkdtemp(path.join(tmpdir(), "cc-panes-web-smoke-home-"));
    const webWorkspaceDir = await mkdtemp(path.join(tmpdir(), "cc-panes-web-smoke-workspace-"));
    tempDirs.push(daemonRuntimeDir, daemonDataDir, webHomeDir, webWorkspaceDir);

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
      {
        env: {
          HOME: webHomeDir,
          USERPROFILE: webHomeDir,
        },
      },
    );
    processes.push(web);

    const webBaseUrl = `http://127.0.0.1:${webPort}`;
    process.env.CCPANES_WEB_SMOKE_DATA_DIR = webDataDir;
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
    const launchProfileId = await verifyWebLaunchProfileApis({
      webBaseUrl,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyTerminalPath({
      name: "web daemon proxy launch profile path",
      baseUrl: webBaseUrl,
      wsUrl: (sessionId) => `ws://127.0.0.1:${webPort}/ws/${encodeURIComponent(sessionId)}`,
      cwd: tmpdir(),
      marker: "CCPANES_WEB_LAUNCH_PROFILE_SMOKE",
      launchProfileId,
    });
    await verifyWebResourceApis(webBaseUrl, webWorkspaceDir);
    await verifyWebWorkspaceMigrationApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebWorkflowApis(webBaseUrl, webWorkspaceDir);
    await verifyWebMcpApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebHistoryApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebLocalHistoryApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebSkillsApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebMemoryApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      assertEquals,
      fail,
      log,
    });
    await verifyWebPlanApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebSshMachineApis({
      webBaseUrl,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebUsageStatsApis({
      webBaseUrl,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebRunnerApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
    });
    await verifyWebGitApis({
      webBaseUrl,
      rootDir: webWorkspaceDir,
      requestJson,
      requestNoContent,
      assertEquals,
      fail,
      log,
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

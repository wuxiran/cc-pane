import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function verifyWebHistoryApis({
  webBaseUrl,
  rootDir,
  requestJson,
  requestNoContent,
  assertEquals,
  fail,
  log,
}) {
  log("verifying web history and restore APIs");
  const projectDir = path.join(rootDir, "history-project");
  await mkdir(path.join(projectDir, ".ccpanes"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".ccpanes", "session-state.json"),
    JSON.stringify({
      claudeSessionId: "legacy-resume-smoke",
      cliTool: "claude",
      runtimeKind: "local",
      lastPrompt: "continue",
    }),
  );

  const launchId = await requestJson(webBaseUrl, "/api/launch-history", {
    method: "POST",
    body: JSON.stringify({
      projectId: "smoke-launch",
      projectName: "History Project",
      projectPath: projectDir,
      cliTool: "codex",
      runtimeKind: "local",
      workspaceName: "smoke-history-workspace",
      workspacePath: rootDir,
      launchCwd: projectDir,
      providerSelection: "explicit",
      launchProfileId: "profile-smoke",
      workspaceSnapshotId: "snapshot-smoke",
    }),
  });
  if (!Number.isInteger(launchId)) {
    fail(`launch history create returned invalid payload: ${JSON.stringify(launchId)}`);
  }

  await requestNoContent(webBaseUrl, `/api/launch-history/${launchId}/session-id`, {
    method: "PATCH",
    body: JSON.stringify({ resumeSessionId: "resume-smoke" }),
  });
  await requestNoContent(webBaseUrl, `/api/launch-history/${launchId}/resume-source`, {
    method: "PATCH",
    body: JSON.stringify({ source: "manual" }),
  });
  await requestNoContent(webBaseUrl, `/api/launch-history/${launchId}/last-prompt`, {
    method: "PATCH",
    body: JSON.stringify({ lastPrompt: "smoke prompt" }),
  });

  const history = await requestJson(
    webBaseUrl,
    `/api/launch-history?projectPath=${encodeURIComponent(projectDir)}&limit=5`,
  );
  assertEquals(history.length, 1, "launch history project list length");
  assertEquals(history[0].resumeSessionId, "resume-smoke", "launch history resume id");
  assertEquals(history[0].resumeSource, "manual", "launch history resume source");

  const touched = await requestJson(webBaseUrl, "/api/launch-history/touch-by-session", {
    method: "POST",
    body: JSON.stringify({ resumeSessionId: "resume-smoke" }),
  });
  assertEquals(touched, launchId, "launch history touch id");

  const updatedStarted = await requestJson(webBaseUrl, "/api/launch-history/session-started", {
    method: "PATCH",
    body: JSON.stringify({
      launchId: "smoke-launch",
      ptySessionId: "pty-smoke",
      resumeSessionId: "resume-smoke-2",
      cliTool: "codex",
      runtimeKind: "local",
      launchCwd: projectDir,
    }),
  });
  assertEquals(updatedStarted, launchId, "launch history session-started id");

  const byPty = await requestJson(webBaseUrl, "/api/launch-history/by-pty?ptySessionId=pty-smoke");
  assertEquals(byPty?.resumeSessionId, "resume-smoke-2", "launch history by pty resume id");

  const upserted = await requestJson(webBaseUrl, "/api/launch-history/session-started/upsert", {
    method: "PUT",
    body: JSON.stringify({
      launchId: "smoke-launch-upsert",
      ptySessionId: "pty-smoke-upsert",
      resumeSessionId: "resume-smoke-upsert",
      cliTool: "claude",
      runtimeKind: "local",
      launchCwd: projectDir,
      projectPath: projectDir,
      projectName: "History Project",
      workspacePath: rootDir,
    }),
  });
  if (!Number.isInteger(upserted)) {
    fail(`launch history upsert returned invalid payload: ${JSON.stringify(upserted)}`);
  }

  const sessionState = await requestJson(
    webBaseUrl,
    `/api/session-state?projectPath=${encodeURIComponent(projectDir)}`,
  );
  assertEquals(
    sessionState?.resumeSessionId,
    "legacy-resume-smoke",
    "legacy session state resume id",
  );

  const session = {
    workspaceSnapshotId: "snapshot-smoke",
    sessionId: "pty-smoke",
    tabId: "tab-smoke",
    paneId: "pane-smoke",
    projectPath: projectDir,
    workspaceName: "smoke-history-workspace",
    workspacePath: rootDir,
    providerId: "provider-smoke",
    providerSelection: "explicit",
    launchProfileId: "profile-smoke",
    cliTool: "codex",
    runtimeKind: "local",
    resumeId: "resume-smoke-2",
    customTitle: "Smoke Restore",
    createdAt: "2026-06-20T00:00:00Z",
    savedAt: "2026-06-20T00:01:00Z",
    hasOutput: false,
  };
  await requestNoContent(
    webBaseUrl,
    `/api/terminal-sessions/${encodeURIComponent(session.sessionId)}/output`,
    {
      method: "POST",
      body: JSON.stringify({ lines: ["history line 1", "history line 2"] }),
    },
  );
  await requestNoContent(webBaseUrl, "/api/terminal-sessions", {
    method: "PUT",
    body: JSON.stringify([session]),
  });
  const sessions = await requestJson(webBaseUrl, "/api/terminal-sessions");
  assertEquals(sessions.length, 1, "terminal sessions length");
  assertEquals(sessions[0].hasOutput, true, "terminal session has output");

  const output = await requestJson(
    webBaseUrl,
    `/api/terminal-sessions/${encodeURIComponent(session.sessionId)}/output`,
  );
  assertEquals(output.length, 2, "terminal session output length");

  const snapshots = await requestJson(webBaseUrl, "/api/workspace-snapshots/smoke-history-workspace");
  assertEquals(snapshots.length, 1, "workspace snapshots length");
  const snapshot = await requestJson(
    webBaseUrl,
    "/api/workspace-snapshots/smoke-history-workspace/snapshot-smoke",
  );
  assertEquals(snapshot?.entries?.length, 1, "workspace snapshot entries length");

  const deletedSnapshot = await requestJson(
    webBaseUrl,
    "/api/workspace-snapshots/smoke-history-workspace/snapshot-smoke",
    { method: "DELETE" },
  );
  assertEquals(deletedSnapshot, true, "workspace snapshot delete result");

  await requestNoContent(
    webBaseUrl,
    `/api/terminal-sessions/${encodeURIComponent(session.sessionId)}/output`,
    { method: "DELETE" },
  );
  await requestNoContent(webBaseUrl, "/api/terminal-sessions", { method: "DELETE" });
  await requestNoContent(webBaseUrl, "/api/launch-history", { method: "DELETE" });
}

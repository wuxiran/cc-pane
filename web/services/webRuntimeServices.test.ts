import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { launchProfileService } from "./launchProfileService";
import { planService } from "./planService";
import {
  addWorkspaceProject,
  createWorkspace,
  previewWorkspaceMigration,
  reorderWorkspaces,
  scanDirectory,
  updateWorkspaceAlias,
  updateWorkspacePinned,
} from "./workspaceService";
import {
  addSshMachine,
  checkSshConnectivity,
  discoverWslDistros,
  listSshMachines,
  removeSshMachine,
} from "./sshMachineService";
import { createTestWorkspace } from "@/test/utils/testData";
import type { LaunchProfileDraft, SshMachine, SshMachineUpsertRequest } from "@/types";

const originalTauriInternals = window.__TAURI_INTERNALS__;

function setWebRuntime(): void {
  delete window.__TAURI_INTERNALS__;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

function mockFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  responses.forEach((response) => {
    fetchMock.mockResolvedValueOnce(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function createDraft(): LaunchProfileDraft {
  return {
    name: "Default",
    alias: "Default",
    description: "",
    providerId: null,
    targetTools: [],
    targetRuntime: null,
    yoloMode: false,
    isDefault: false,
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
  };
}

function createMachine(): SshMachine {
  return {
    id: "ssh-1",
    name: "prod",
    host: "example.com",
    port: 22,
    authMethod: "key",
    tags: [],
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
  };
}

describe("web runtime service adapters", () => {
  beforeEach(() => {
    setWebRuntime();
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
    vi.unstubAllGlobals();
  });

  it("routes archived plan operations to HTTP", async () => {
    const plan = {
      fileName: "plan.md",
      originalName: "plan",
      sessionId: "session-1",
      archivedAt: "2026-06-20T10:11:12",
      size: 12,
    };
    const fetchMock = mockFetchSequence([
      jsonResponse([plan]),
      jsonResponse("# Plan"),
      noContentResponse(),
    ]);

    await expect(planService.listPlans("/tmp/project")).resolves.toEqual([plan]);
    await expect(planService.getPlanContent("/tmp/project", "plan.md")).resolves.toBe("# Plan");
    await expect(planService.deletePlan("/tmp/project", "plan.md")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/plans?projectPath=%2Ftmp%2Fproject",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/plans/plan.md?projectPath=%2Ftmp%2Fproject",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/plans/plan.md?projectPath=%2Ftmp%2Fproject", {
      method: "DELETE",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("routes launch profile operations to HTTP", async () => {
    const draft = createDraft();
    const profile = {
      ...draft,
      id: "profile-1",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-20T00:00:00Z",
    };
    const resolution = {
      profileId: "profile-1",
      profileName: "Default",
      mcpServers: [],
      skills: [],
      warnings: [],
      degraded: false,
    };
    const fetchMock = mockFetchSequence([
      jsonResponse([profile]),
      jsonResponse(profile, 201),
      jsonResponse(profile),
      noContentResponse(),
      jsonResponse(resolution),
    ]);

    await expect(launchProfileService.list()).resolves.toEqual([profile]);
    await expect(launchProfileService.create(draft)).resolves.toEqual(profile);
    await expect(launchProfileService.update("profile-1", draft)).resolves.toEqual(profile);
    await expect(launchProfileService.setDefault("profile-1")).resolves.toBeUndefined();
    await expect(launchProfileService.preview({ profileId: "profile-1" })).resolves.toEqual(resolution);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/launch-profiles", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/launch-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/launch-profiles/profile-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/launch-profiles/profile-1/default", {
      method: "POST",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/launch-profiles/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "profile-1" }),
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("routes SSH machine operations to HTTP and keeps WSL discovery desktop-only", async () => {
    const machine = createMachine();
    const request: SshMachineUpsertRequest = {
      machine,
      rememberPassword: false,
      clearStoredPassword: false,
    };
    const connectivity = {
      reachable: false,
      message: "connection refused",
      latencyMs: null,
    };
    const fetchMock = mockFetchSequence([
      jsonResponse([machine]),
      jsonResponse(machine, 201),
      jsonResponse(connectivity),
      noContentResponse(),
    ]);

    await expect(listSshMachines()).resolves.toEqual([machine]);
    await expect(addSshMachine(request)).resolves.toEqual(machine);
    await expect(checkSshConnectivity("ssh-1")).resolves.toEqual(connectivity);
    await expect(removeSshMachine("ssh-1")).resolves.toBeUndefined();
    await expect(discoverWslDistros()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/ssh-machines", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/ssh-machines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/ssh-machines/ssh-1/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/ssh-machines/ssh-1", {
      method: "DELETE",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("routes workspace resource operations to HTTP", async () => {
    const workspace = createTestWorkspace({ name: "ws-1" });
    const project = { id: "project-1", path: "/tmp/project" };
    const updatedWorkspace = { ...workspace, pinned: true };
    const fetchMock = mockFetchSequence([
      jsonResponse(workspace, 201),
      jsonResponse(project, 201),
      noContentResponse(),
      noContentResponse(),
      jsonResponse(workspace),
      noContentResponse(),
      noContentResponse(),
    ]);

    await expect(createWorkspace("ws-1", "/tmp/ws")).resolves.toEqual(workspace);
    await expect(addWorkspaceProject("ws-1", "/tmp/project")).resolves.toEqual(project);
    await expect(updateWorkspaceAlias("ws-1", "alias")).resolves.toBeUndefined();
    await expect(updateWorkspacePinned("ws-1", true)).resolves.toBeUndefined();
    await expect(reorderWorkspaces(["ws-1"])).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ws-1", path: "/tmp/ws" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/workspaces/ws-1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/project" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/local-history/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: "/tmp/project" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/workspaces/ws-1/alias", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "alias" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/workspaces/ws-1", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/workspaces/ws-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: updatedWorkspace }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/workspaces/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedNames: ["ws-1"] }),
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("routes workspace migration and scan operations to HTTP", async () => {
    const plan = {
      workspaceName: "ws-1",
      sourceRoot: "/tmp/ws",
      rootDestination: "/tmp/target",
      targetKind: "local" as const,
      targetRoot: "/tmp/target",
      items: [],
      warnings: [],
    };
    const scanned = [{ mainPath: "/tmp/repo", mainBranch: "main", worktrees: [] }];
    const fetchMock = mockFetchSequence([jsonResponse(plan), jsonResponse(scanned)]);

    await expect(
      previewWorkspaceMigration({
        workspaceName: "ws-1",
        targetKind: "local",
        targetRoot: "/tmp/target",
      }),
    ).resolves.toEqual(plan);
    await expect(scanDirectory("/tmp")).resolves.toEqual(scanned);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/workspace-migrations/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceName: "ws-1",
        targetKind: "local",
        targetRoot: "/tmp/target",
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/workspace-scan?rootPath=%2Ftmp", undefined);
    expect(invoke).not.toHaveBeenCalled();
  });
});

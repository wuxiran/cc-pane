import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { AcpChatSnapshot, AgentChatAttachment } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { worktreeService } from "@/services/worktreeService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { compatibleLaunchProfiles } from "./ChatLaunchProfileMenu";
import { loadLaunchProfileId, saveLaunchProfileId, savePreferredConfigOption, savePreferredModel } from "./enginePrefs";
import { startConfiguredChat } from "./startConfiguredChat";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  start: vi.fn(), get: vi.fn(), setMode: vi.fn(), setModel: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(),
} }));
vi.mock("@/services/worktreeService", () => ({ worktreeService: { add: vi.fn() } }));

const chatId = "start-configured-chat";
const start = vi.mocked(agentChatService.start);
const prompt = vi.mocked(agentChatService.prompt);
const chat = () => useAgentChatStore.getState().chats[chatId];
const textBlocks = (text: string) => [{ type: "text", text }];

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); useAgentChatStore.getState().dropChat(chatId);
  start.mockResolvedValue({ chatId, engineId: "claude", phase: "ready" });
  prompt.mockResolvedValue(undefined);
});

// 启动页附件随首条消息发出：与会话内输入区同一套 buildPromptBlocks；引擎不收内嵌图片时
// 有路径的图片退回 resource_link；发送被拒时附件留在 rejectedPrompt 里供重试。
describe("first attachments", () => {
  const withImageCap = (image: boolean): AcpChatSnapshot => ({
    chatId, engineId: "claude", phase: "ready", acpSessionId: "s1",
    agentCapabilities: { promptCapabilities: { image } },
  });
  const file: AgentChatAttachment = { name: "a.md", mimeType: "", data: "", kind: "file", path: "/repo/a.md" };
  const image: AgentChatAttachment = { name: "b.png", mimeType: "image/png", data: "QUJD", kind: "image", path: "/repo/b.png" };

  it("sends attachments with the first prompt in one request", async () => {
    start.mockResolvedValue(withImageCap(true));
    await startConfiguredChat({ chatId, engineId: "claude", cwd: "/repo", firstPrompt: "Review", firstAttachments: [file, image] });
    expect(prompt).toHaveBeenCalledExactlyOnceWith(chatId, [
      { type: "resource_link", uri: "file:///repo/a.md", name: "a.md" },
      { type: "image", mimeType: "image/png", data: "QUJD" },
      { type: "text", text: "Review" },
    ]);
    expect(chat()?.items.find((item) => item.type === "user")).toMatchObject({ text: "Review", attachmentLabels: ["a.md", "b.png"] });
  });

  it("sends an attachment-only first message and downgrades images the engine cannot embed", async () => {
    start.mockResolvedValue(withImageCap(false));
    await startConfiguredChat({ chatId, engineId: "claude", cwd: "/repo", firstAttachments: [image] });
    expect(prompt).toHaveBeenCalledExactlyOnceWith(chatId, [
      { type: "resource_link", uri: "file:///repo/b.png", name: "b.png" },
    ]);
  });

  it("keeps the attachments for retry when the first prompt is rejected", async () => {
    start.mockResolvedValue(withImageCap(true));
    prompt.mockRejectedValue(new Error("busy"));
    await expect(startConfiguredChat({ chatId, engineId: "claude", cwd: "/repo", firstPrompt: "Review", firstAttachments: [file] }))
      .rejects.toThrow("busy");
    expect(chat()?.rejectedPrompt).toMatchObject({ text: "Review", attachments: [file] });
    expect(chat()?.setup?.firstAttachments).toEqual([file]);
  });
});

describe("launch profiles", () => {
  const ready: AcpChatSnapshot = { chatId, engineId: "codex-app-server", phase: "ready", acpSessionId: "thread-1" };

  it("passes the chosen profile to the backend and keeps old call shape without one", async () => {
    start.mockResolvedValue(ready);
    await startConfiguredChat({ chatId, engineId: "codex-app-server", cwd: "/repo", launchProfileId: "relay" });
    expect(start).toHaveBeenCalledWith(chatId, "codex-app-server", "/repo", undefined, [], undefined, { launchProfileId: "relay" });

    useAgentChatStore.getState().dropChat(chatId);
    start.mockClear();
    await startConfiguredChat({ chatId, engineId: "codex-app-server", cwd: "/repo" });
    expect(start).toHaveBeenCalledWith(chatId, "codex-app-server", "/repo", undefined, []);
  });

  it("shows one notice when Codex fell back to ACP compatibility mode", async () => {
    start.mockResolvedValue({ ...ready, engineId: "codex", transportFallback: "startFailed" });
    await startConfiguredChat({ chatId, engineId: "codex-app-server", cwd: "/repo" });
    const notices = (chat()?.items ?? []).filter((item) => item.type === "notice");
    expect(notices.map((item) => (item as { text: string }).text))
      .toEqual([i18n.t("agentChatCodexAcpFallback", { ns: "panes" })]);
  });

  it("lists only profiles targeting the engine's CLI and remembers the choice per engine", () => {
    const profiles = [
      { id: "any", name: "Any", targetTools: [] },
      { id: "codex", name: "Codex relay", targetTools: ["codex"] },
      { id: "claude", name: "Claude relay", targetTools: ["claude"] },
    ] as never;
    expect(compatibleLaunchProfiles(profiles, "codex").map((profile) => profile.id)).toEqual(["any", "codex"]);
    expect(compatibleLaunchProfiles(profiles, undefined)).toEqual([]);

    expect(loadLaunchProfileId("codex-app-server")).toBeNull();
    saveLaunchProfileId("codex-app-server", "codex");
    expect(loadLaunchProfileId("codex-app-server")).toBe("codex");
    expect(loadLaunchProfileId("claude")).toBeNull();
    saveLaunchProfileId("codex-app-server", null);
    expect(loadLaunchProfileId("codex-app-server")).toBeNull();
  });
});

describe("native model-dependent preference refresh", () => {
  const engineId = "codex-app-server";
  const setConfigOption = vi.mocked(agentChatService.setConfigOption);
  const snapshot = (model: string, effort: string, efforts: string[]): AcpChatSnapshot => ({
    chatId, engineId, phase: "ready", acpSessionId: "native-thread", codexThreadId: "native-thread", configOptions: [
      { configId: "model", category: "model", currentValue: model, options: [{ value: "model-a" }, { value: "model-b" }] },
      { configId: "reasoning_effort", currentValue: effort, options: efforts.map((value) => ({ value })) },
    ],
  });

  beforeEach(() => {
    start.mockResolvedValue(snapshot("model-a", "low", ["low", "medium"]));
    vi.mocked(agentChatService.get).mockResolvedValue(snapshot("model-b", "medium", ["medium", "high"]));
    savePreferredModel(engineId, "model-b");
  });

  it("applies an effort advertised only by the newly selected model before sending", async () => {
    savePreferredConfigOption(engineId, "reasoning_effort", "high");
    await startConfiguredChat({ chatId, engineId, cwd: "/repo", firstPrompt: "Work" });
    expect(setConfigOption).toHaveBeenNthCalledWith(1, chatId, "model", "model-b");
    expect(agentChatService.get).toHaveBeenCalledWith(chatId);
    expect(setConfigOption).toHaveBeenNthCalledWith(2, chatId, "reasoning_effort", "high");
    expect(setConfigOption.mock.invocationCallOrder[1]).toBeLessThan(prompt.mock.invocationCallOrder[0]);
    expect(prompt).toHaveBeenCalledWith(chatId, textBlocks("Work"));
  });

  it("does not send a stale effort valid only for the previous model", async () => {
    savePreferredConfigOption(engineId, "reasoning_effort", "low");
    await startConfiguredChat({ chatId, engineId, cwd: "/repo", firstPrompt: "Work" });
    expect(setConfigOption).toHaveBeenCalledExactlyOnceWith(chatId, "model", "model-b");
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not send the first prompt if configuration refresh belongs to another thread", async () => {
    vi.mocked(agentChatService.get).mockResolvedValue({ ...snapshot("model-b", "high", ["high"]), acpSessionId: "other-thread" });
    await expect(startConfiguredChat({ chatId, engineId, cwd: "/repo", firstPrompt: "Work" })).rejects.toThrow("configuration changed");
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("remote launch", () => {
  const remote = { machineId: "m1", os: "linux" };

  it("starts on the machine with the remote cwd and never adopts it as a local cwd", async () => {
    const onCwdAdopted = vi.fn();
    await startConfiguredChat({ chatId, engineId: "claude", cwd: "~/work", remote, onCwdAdopted });
    expect(start).toHaveBeenCalledExactlyOnceWith(chatId, "claude", "~/work", undefined, [], remote);
    expect(onCwdAdopted).not.toHaveBeenCalled();
    expect(chat()?.cwdOverride ?? null).toBeNull();
  });

  it("refuses a worktree for a remote launch without touching git", async () => {
    await expect(startConfiguredChat({
      chatId, engineId: "claude", cwd: "~/work", remote, worktree: { enabled: true, branch: "cc/task" },
    })).rejects.toThrow();
    expect(worktreeService.add).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("worktree launch", () => {
  const worktreeCwd = "/repo-worktrees/cc-task";
  const options = { chatId, engineId: "claude", cwd: "/repo", worktree: {
    enabled: true, branch: "cc/task", baseRef: "refs/heads/main",
  } };
  beforeEach(() => { vi.mocked(worktreeService.add).mockResolvedValue(worktreeCwd); });

  it("sends the first prompt only after the engine starts in the prepared worktree", async () => {
    await startConfiguredChat({ ...options, firstPrompt: "Implement the change" });
    expect(start).toHaveBeenCalledWith(chatId, "claude", worktreeCwd, undefined, []);
    expect(prompt).toHaveBeenCalledExactlyOnceWith(chatId, textBlocks("Implement the change"));
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(prompt.mock.invocationCallOrder[0]);
  });

  it("holds the setup lock across worktree creation and starts exactly once", async () => {
    let finish!: (cwd: string) => void;
    vi.mocked(worktreeService.add).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = startConfiguredChat(options);
    await expect(startConfiguredChat(options)).resolves.toBeNull();
    expect(worktreeService.add).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    finish(worktreeCwd);
    await first;
    expect(start).toHaveBeenCalledExactlyOnceWith(chatId, "claude", worktreeCwd, undefined, []);
  });

  it("retains a created worktree for retry when engine spawn fails", async () => {
    start.mockRejectedValueOnce(new Error("engine unavailable"));
    await expect(startConfiguredChat(options)).rejects.toThrow("engine unavailable");
    const cwd = chat()?.cwdOverride;
    expect(cwd).toBe(worktreeCwd);
    await startConfiguredChat({ chatId, engineId: "claude", cwd: cwd! });
    expect(worktreeService.add).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith(chatId, "claude", cwd, undefined, []);
  });

  it("keeps configuration available after preparation fails and never launches in the source", async () => {
    vi.mocked(worktreeService.add).mockRejectedValueOnce(new Error("invalid base"));
    await expect(startConfiguredChat(options)).rejects.toThrow("invalid base");
    expect(start).not.toHaveBeenCalled();
    expect(chat()?.snapshot).toBeNull();
    await startConfiguredChat(options);
    expect(start).toHaveBeenCalledWith(chatId, "claude", worktreeCwd, undefined, []);
  });

  it("rejects moving a resumed session into a new worktree", async () => {
    await expect(startConfiguredChat({ ...options, resumeAcpSessionId: "session" })).rejects.toThrow();
    expect(worktreeService.add).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

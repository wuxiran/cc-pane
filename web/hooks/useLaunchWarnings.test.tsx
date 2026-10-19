import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toastWarn } from "@/lib/feedback";
import { listenWebviewIfTauri } from "@/services/runtime";
import { useLaunchWarnings, type LaunchWarningPayload } from "./useLaunchWarnings";

vi.mock("@/lib/feedback", () => ({ toastWarn: vi.fn(), toastErr: vi.fn() }));
const markTerminalLaunchFailed = vi.hoisted(() => vi.fn());
vi.mock("@/stores/usePanesStore", () => ({
  usePanesStore: { getState: () => ({ markTerminalLaunchFailed }) },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => `${key}:${JSON.stringify(opts ?? {})}`,
  }),
}));
vi.mock("@/services/runtime", () => ({ listenWebviewIfTauri: vi.fn() }));

const listen = vi.mocked(listenWebviewIfTauri);

type Handler = (event: { payload: LaunchWarningPayload }) => void;

async function mount() {
  let handler: Handler | undefined;
  const unlisten = vi.fn();
  listen.mockImplementation(async (_evt, h) => {
    handler = h as Handler;
    return unlisten;
  });
  const view = renderHook(() => useLaunchWarnings());
  await waitFor(() => expect(handler).toBeDefined());
  return { handler: handler as Handler, unlisten, view };
}

describe("useLaunchWarnings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("订阅 terminal-launch-warning 事件", async () => {
    await mount();
    expect(listen).toHaveBeenCalledWith("terminal-launch-warning", expect.any(Function));
  });

  it("profileMismatch 事件触发 toastWarn 并带 profile/cli/used 参数", async () => {
    const { handler } = await mount();
    handler({
      payload: {
        kind: "profileMismatch",
        requestedProfileName: "Codex YOLO",
        cliTool: "claude",
        usedProfileName: "Claude Default",
      },
    });
    expect(toastWarn).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(toastWarn).mock.calls[0][0] as string;
    expect(msg).toContain("launchProfileMismatch");
    expect(msg).toContain("Codex YOLO");
    expect(msg).toContain("claude");
    expect(msg).toContain("Claude Default");
  });

  it("usedProfileName 为空时回退到默认文案", async () => {
    const { handler } = await mount();
    handler({
      payload: { kind: "profileMismatch", requestedProfileName: "P", cliTool: "codex", usedProfileName: null },
    });
    expect(toastWarn).toHaveBeenCalledTimes(1);
  });

  it("Codex 恢复目标缺失降级时给出明确警告", async () => {
    const { handler } = await mount();
    handler({
      payload: {
        kind: "codexResumeTargetMissing",
        cliTool: "codex",
        runtimeKind: "wsl",
      },
    });

    expect(toastWarn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toastWarn).mock.calls[0][0]).toContain("codexResumeTargetMissing");
  });

  // 与后端 L2-1 契约对应：nativeCliMissing 要同时①写 leaf.launchFailure ②toastErr 带修复命令。
  it("nativeCliMissing 写入 leaf 启动失败并给出修复命令", async () => {
    const { toastErr } = await import("@/lib/feedback");
    const { handler } = await mount();
    handler({
      payload: {
        kind: "nativeCliMissing",
        sessionId: "pty-7",
        launchId: "proj-7",
        cliTool: "claude",
        missingCli: "claude",
        runtimeKind: "wsl",
        wslDistro: "Ubuntu",
        exitCode: 1,
        reason: "native-cli-missing",
        issuedResumeId: "6a76e4f5-7d54-436a-b29e-29285aa19b8b",
        fixHint: "npm i -g @anthropic-ai/claude-code",
      },
    });
    expect(markTerminalLaunchFailed).toHaveBeenCalledTimes(1);
    const [sessionId, failure] = markTerminalLaunchFailed.mock.calls[0];
    expect(sessionId).toBe("pty-7");
    expect(failure).toMatchObject({
      reason: "native-cli-missing",
      missingCli: "claude",
      fixHint: "npm i -g @anthropic-ai/claude-code",
      wslDistro: "Ubuntu",
    });
    expect(toastErr).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(toastErr).mock.calls[0][0] as string;
    expect(msg).toContain("nativeCliMissing");
    expect(msg).toContain("npm i -g @anthropic-ai/claude-code");
    expect(toastWarn).not.toHaveBeenCalled();
  });

  it("其他 kind 不触发 toast", async () => {
    const { handler } = await mount();
    handler({ payload: { kind: "somethingElse" } });
    expect(toastWarn).not.toHaveBeenCalled();
  });

  it("卸载时调用 unlisten", async () => {
    const { unlisten, view } = await mount();
    view.unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});

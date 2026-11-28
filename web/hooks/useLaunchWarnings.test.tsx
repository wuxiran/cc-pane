import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toastWarn } from "@/lib/feedback";
import { listenWebviewIfTauri } from "@/services/runtime";
import { isResumeTargetMissing, useLaunchWarnings, type LaunchWarningPayload } from "./useLaunchWarnings";

vi.mock("@/lib/feedback", () => ({ toastWarn: vi.fn(), toastErr: vi.fn() }));
const markTerminalLaunchFailed = vi.hoisted(() => vi.fn());
vi.mock("@/stores/usePanesStore", () => ({
  usePanesStore: { getState: () => ({ markTerminalLaunchFailed }) },
}));
const recoverFromDeadResume = vi.hoisted(() => vi.fn());
vi.mock("./deadResumeRecovery", () => ({ recoverFromDeadResume }));
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

  // 实测（dev 日志）：Claude 发号后用户没说话就关了，会话档案从未落盘；之后每次重启都
  // `--resume` 同一个死 id，报 "No conversation found" 后退出，失败输出再被冷重放——永久循环。
  describe("resumeLaunchFailed：resume 目标已不存在", () => {
    const deadId = "4b27b0d6-9fbf-40df-b000-9daa1cb9842e";
    const fire = async (matchedPattern: string) => {
      const { handler } = await mount();
      handler({
        payload: {
          kind: "resumeLaunchFailed",
          sessionId: "pty-dead",
          resumeId: deadId,
          cliTool: "claude",
          exitCode: 1,
          matchedPattern,
        },
      });
    };

    it("目标缺失时交给自愈流程，自动新建后给一条提示", async () => {
      recoverFromDeadResume.mockReturnValue("relaunched");
      await fire("no conversation found");
      expect(recoverFromDeadResume).toHaveBeenCalledWith("pty-dead", deadId);
      expect(vi.mocked(toastWarn).mock.calls[0][0]).toContain("resumeTargetMissingRelaunched");
    });

    it("自愈已停下（错误面板接管）时不再弹提示", async () => {
      const { toastErr } = await import("@/lib/feedback");
      recoverFromDeadResume.mockReturnValue("stopped");
      await fire("no conversation found");
      expect(toastWarn).not.toHaveBeenCalled();
      expect(toastErr).not.toHaveBeenCalled();
    });

    it("宽特征（error 等）不撤 resume id，只提示", async () => {
      const { toastErr } = await import("@/lib/feedback");
      await fire("error");
      expect(recoverFromDeadResume).not.toHaveBeenCalled();
      expect(vi.mocked(toastErr).mock.calls[0][0]).toContain("resumeLaunchFailed");
    });

    it("isResumeTargetMissing 只认明确的目标缺失特征", () => {
      expect(isResumeTargetMissing("no conversation found")).toBe(true);
      expect(isResumeTargetMissing("session not found")).toBe(true);
      expect(isResumeTargetMissing("not found in")).toBe(false);
      expect(isResumeTargetMissing("error")).toBe(false);
      expect(isResumeTargetMissing(undefined)).toBe(false);
    });
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

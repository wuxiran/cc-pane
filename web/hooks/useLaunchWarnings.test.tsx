import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { listenWebviewIfTauri } from "@/services/runtime";
import { useLaunchWarnings, type LaunchWarningPayload } from "./useLaunchWarnings";

vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));
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

  it("profileMismatch 事件触发 toast.warning 并带 profile/cli/used 参数", async () => {
    const { handler } = await mount();
    handler({
      payload: {
        kind: "profileMismatch",
        requestedProfileName: "Codex YOLO",
        cliTool: "claude",
        usedProfileName: "Claude Default",
      },
    });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(toast.warning).mock.calls[0][0] as string;
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
    expect(toast.warning).toHaveBeenCalledTimes(1);
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

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toContain("codexResumeTargetMissing");
  });

  it("其他 kind 不触发 toast", async () => {
    const { handler } = await mount();
    handler({ payload: { kind: "somethingElse" } });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("卸载时调用 unlisten", async () => {
    const { unlisten, view } = await mount();
    view.unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});

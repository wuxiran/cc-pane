import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveMock, toastInfoMock, toastErrorMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(),
  toastInfoMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("../terminalClipboard", () => ({
  resolveTerminalPastePayload: resolveMock,
}));

vi.mock("@/components/ui/toast", () => ({
  toast: { info: toastInfoMock, error: toastErrorMock },
}));

import { createTerminalPasteHandlers } from "./terminalPaste";
import type { TerminalRuntimeKind } from "../terminalDropPaths";

function makeTerm() {
  return {
    focus: vi.fn(),
    paste: vi.fn(),
  } as unknown as import("@xterm/xterm").Terminal & {
    focus: ReturnType<typeof vi.fn>;
    paste: ReturnType<typeof vi.fn>;
  };
}

function makeHandlers(runtimeKind?: TerminalRuntimeKind) {
  const term = makeTerm();
  const onUnsupportedPaths = vi.fn();
  const handlers = createTerminalPasteHandlers({
    term,
    debugLog: vi.fn(),
    lastShortcutPasteAtRef: { current: 0 },
    getRuntimeKind: runtimeKind ? () => runtimeKind : undefined,
    onUnsupportedPaths,
  });
  return { term, handlers, onUnsupportedPaths };
}

/** 等 resolveTerminalPastePayload().then(...) 的微任务链跑完。 */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createTerminalPasteHandlers file-path runtime handling", () => {
  beforeEach(() => {
    resolveMock.mockReset();
    toastInfoMock.mockReset();
    toastErrorMock.mockReset();
  });

  it.each<[string, TerminalRuntimeKind | undefined, string, string]>([
    // 裸 join 的 payload.text 应被忽略，按 filePaths 重新格式化
    ["escapes local file paths before pasting", "local", "/home/me/my dir/a.txt", "'/home/me/my dir/a.txt'"],
    ["converts Windows paths to /mnt for WSL sessions", "wsl", "D:\\repos\\app", "'/mnt/d/repos/app'"],
    ["defaults to local runtime when getRuntimeKind is absent", undefined, "/home/me/a b.txt", "'/home/me/a b.txt'"],
  ])("%s", async (_label, runtimeKind, filePath, expected) => {
    resolveMock.mockResolvedValue({ kind: "file", text: filePath, filePaths: [filePath] });
    const { term, handlers } = makeHandlers(runtimeKind);

    handlers.pasteTerminalPayload(null);
    await flush();

    expect(term.paste).toHaveBeenCalledWith(expected);
  });

  it("does not paste host paths into SSH sessions and reports honestly", async () => {
    resolveMock.mockResolvedValue({
      kind: "file",
      text: "/home/me/a.txt",
      filePaths: ["/home/me/a.txt", "/home/me/b.txt"],
    });
    const { term, handlers, onUnsupportedPaths } = makeHandlers("ssh");

    handlers.pasteTerminalPayload(null);
    await flush();

    expect(term.paste).not.toHaveBeenCalled();
    expect(onUnsupportedPaths).toHaveBeenCalledWith(2);
  });

  it("passes image and text payloads through unchanged", async () => {
    resolveMock.mockResolvedValue({ kind: "text", text: "hello" });
    const { term, handlers } = makeHandlers("ssh");

    handlers.pasteTerminalPayload(null);
    await flush();

    // 文本粘贴不受 SSH 文件路径降级影响。
    expect(term.paste).toHaveBeenCalledWith("hello");
  });
});

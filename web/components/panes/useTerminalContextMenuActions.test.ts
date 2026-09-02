// 「重置终端缓冲区」的语义回归：优先快照重建（保回滚历史），失败才裸 reset。
//
// 背景（docs/73 + 2026-08-31 实测）：inline CLI（grok）收到重绘信号只补画底部
// 活动区，历史归终端保管——裸 reset 对 inline 会话等于清空全部历史且不可恢复。
// 用户后台切回花屏 → 被迫重置 → 历史全灭，就是这条链。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";

const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    warning: (...args: unknown[]) => toastWarning(...args),
    success: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));

import { useTerminalContextMenuActions } from "./useTerminalContextMenuActions";

function createTerm() {
  return {
    cols: 80,
    rows: 24,
    reset: vi.fn(),
    focus: vi.fn(),
    getSelection: vi.fn(() => ""),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
  };
}

type FakeTerm = ReturnType<typeof createTerm>;

function setup(requestBufferResync?: () => Promise<boolean>) {
  const term = createTerm();
  const { result } = renderHook(() =>
    useTerminalContextMenuActions({
      terminalRef: { current: term as unknown as Terminal },
      rendererControllerRef: { current: null },
      pasteRequestRef: { current: null },
      currentSessionIdRef: { current: "sess-1" },
      sessionId: "sess-1",
      projectPath: "D:/proj",
      debugLog: vi.fn(),
      refitAndRepaintTerminal: vi.fn(),
      repaintTerminal: vi.fn(),
      requestBufferResync,
    }),
  );
  return { term, result };
}

/** 触发菜单动作并按下确认 toast 的 action，等异步收尾。 */
async function confirmReset(handleMenuResetBuffer: () => void): Promise<void> {
  handleMenuResetBuffer();
  expect(toastWarning).toHaveBeenCalledTimes(1);
  const options = toastWarning.mock.calls[0][1] as { action: { onClick: () => void } };
  options.action.onClick();
  // onClick 内部是 fire-and-forget 的异步链，刷几轮微任务等它结算。
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function resetCalls(term: FakeTerm): number {
  return term.reset.mock.calls.length;
}

beforeEach(() => {
  toastWarning.mockClear();
});

describe("handleMenuResetBuffer", () => {
  it("快照重建成功：不做裸 reset（历史已随快照恢复），聚焦终端", async () => {
    const requestBufferResync = vi.fn(async () => true);
    const { term, result } = setup(requestBufferResync);

    await confirmReset(result.current.handleMenuResetBuffer);

    expect(requestBufferResync).toHaveBeenCalledTimes(1);
    expect(resetCalls(term)).toBe(0);
    expect(term.focus).toHaveBeenCalled();
  });

  it("快照重建失败：回退为裸 reset（用户的明确意图是清空）", async () => {
    const requestBufferResync = vi.fn(async () => false);
    const { term, result } = setup(requestBufferResync);

    await confirmReset(result.current.handleMenuResetBuffer);

    expect(requestBufferResync).toHaveBeenCalledTimes(1);
    expect(resetCalls(term)).toBe(1);
  });

  it("快照重建抛异常：吞掉并回退为裸 reset，不让菜单动作静默失败", async () => {
    const requestBufferResync = vi.fn(async () => {
      throw new Error("snapshot channel down");
    });
    const { term, result } = setup(requestBufferResync);

    await confirmReset(result.current.handleMenuResetBuffer);

    expect(resetCalls(term)).toBe(1);
  });

  it("未接入快照重建（旧调用方/会话未绑定）：维持原有裸 reset 行为", async () => {
    const { term, result } = setup(undefined);

    await confirmReset(result.current.handleMenuResetBuffer);

    expect(resetCalls(term)).toBe(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { registerTerminalParserHandlers } from "./terminalParserHandlers";

function makeTerm() {
  const handlers: { prefix?: string; final: string; fn: (params?: unknown) => boolean }[] = [];
  const term = {
    parser: {
      registerCsiHandler: vi.fn((id: { prefix?: string; final: string }, fn: () => boolean) => {
        handlers.push({ ...id, fn });
        return { dispose: () => {} };
      }),
      registerOscHandler: vi.fn(() => ({ dispose: () => {} })),
    },
    buffer: { active: { cursorX: 0, cursorY: 0 } },
  };
  return { term, handlers };
}

const deps = {
  currentSessionIdRef: { current: "s1" },
  transparentCliSurfaceRef: { current: true },
  effectiveCliToolRef: { current: "codex" },
  debugLog: () => {},
};

describe("registerTerminalParserHandlers", () => {
  it("swallows kitty keyboard push/pop so IME composition keeps working", () => {
    const { term, handlers } = makeTerm();
    registerTerminalParserHandlers({ term: term as never, ...deps });

    const push = handlers.find((h) => h.prefix === ">" && h.final === "u");
    const pop = handlers.find((h) => h.prefix === "<" && h.final === "u");
    expect(push).toBeDefined();
    expect(pop).toBeDefined();
    // 消费（返回 true）= xterm 不切 kitty 编码，保持 legacy 输入路径
    expect(push!.fn()).toBe(true);
    expect(pop!.fn()).toBe(true);
  });

  it("still answers the kitty capability query", () => {
    const { term, handlers } = makeTerm();
    registerTerminalParserHandlers({ term: term as never, ...deps });
    expect(handlers.some((h) => h.prefix === "?" && h.final === "u")).toBe(true);
  });
});

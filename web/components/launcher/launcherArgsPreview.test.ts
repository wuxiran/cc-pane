// 与后端语义对拍：claude 的 MAX_THINKING_TOKENS 数值对齐 cc-cli-adapters/src/lib.rs
// claude_max_thinking_tokens；codex 的 max→xhigh 映射对齐 codex_reasoning_effort。
import { describe, expect, it } from "vitest";
import { buildArgsPreview } from "./launcherArgsPreview";

describe("buildArgsPreview (claude)", () => {
  it("effort 显示为 MAX_THINKING_TOKENS env 行，数值与后端映射一致", () => {
    const cases = [
      ["low", 4096],
      ["medium", 10000],
      ["high", 16000],
      ["xhigh", 31999],
      ["max", 63999],
    ] as const;
    for (const [effort, tokens] of cases) {
      const lines = buildArgsPreview({ cliTool: "claude", adapterOptions: { effort } });
      expect(lines[0]).toBe(`MAX_THINKING_TOKENS=${tokens}`);
    }
  });

  it("flag 顺序对齐 claude.rs build_command：mcp → append → yolo → verbose → max-turns → extraArgs → -- prompt", () => {
    const lines = buildArgsPreview({
      cliTool: "claude",
      appendSystemPrompt: "focus",
      yolo: true,
      initialPrompt: "run tests",
      adapterOptions: { verbose: true, maxTurns: 5, extraArgs: ["--model", "opus"] },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'claude --mcp-config <auto> --append-system-prompt "focus" --dangerously-skip-permissions --verbose --max-turns 5 --model opus -- "run tests"',
    );
  });

  it("skipMcp 时不出现 --mcp-config；无 effort 无 env 行", () => {
    const lines = buildArgsPreview({ cliTool: "claude", skipMcp: true });
    expect(lines).toEqual(["claude"]);
  });
});

describe("buildArgsPreview (codex)", () => {
  it("-c model_reasoning_effort 在 positional 之前，max 映射为 xhigh", () => {
    const lines = buildArgsPreview({
      cliTool: "codex",
      initialPrompt: "hello",
      adapterOptions: { effort: "max" },
    });
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("-c model_reasoning_effort=xhigh");
    expect(line.indexOf("model_reasoning_effort")).toBeLessThan(line.indexOf('"hello"'));
  });

  it("skipMcp 显示 enabled=false override；yolo 用 codex 专属 flag", () => {
    const lines = buildArgsPreview({ cliTool: "codex", skipMcp: true, yolo: true });
    expect(lines[0]).toContain("mcp_servers.ccpanes.enabled=false");
    expect(lines[0]).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("codex 不消费 verbose/maxTurns", () => {
    const lines = buildArgsPreview({
      cliTool: "codex",
      adapterOptions: { verbose: true, maxTurns: 3 },
    });
    expect(lines[0]).not.toContain("--verbose");
    expect(lines[0]).not.toContain("--max-turns");
  });
});

describe("buildArgsPreview (none/unknown)", () => {
  it("仅终端 / 未知 CLI 返回空（预览区隐藏）", () => {
    expect(buildArgsPreview({ cliTool: "none" })).toEqual([]);
    expect(buildArgsPreview({ cliTool: "gemini" })).toEqual([]);
  });
});

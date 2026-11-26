import "@/i18n";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import StatusIndicator from "./StatusIndicator";
import type { OscProgressBadge, TerminalStatusType } from "@/types";

// StatusIndicator 是纯展示组件：把传入的 status prop 映射为颜色点 + tooltip。
// 这里断言的是「给定 prop 的渲染结果」，不涉及从终端输出推断会话状态，
// 因此不违反项目 Gotcha（禁止对会话状态做文本模式匹配）。
// 组件没有 aria 状态，颜色 / pulse 类就是状态的唯一载体，故保留对它们的断言。

function getDot(container: HTMLElement): HTMLElement | null {
  return container.querySelector("span");
}

const badge = (state: OscProgressBadge["state"], progress: number): OscProgressBadge => ({ state, progress });

describe("StatusIndicator", () => {
  it("status 为 null 时不渲染任何内容", () => {
    const { container } = render(<StatusIndicator status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each<[TerminalStatusType, string]>([
    ["thinking", "var(--app-accent-2)"],
    ["waitingInput", "var(--app-status-warning)"],
  ])("%s 状态渲染对应颜色圆点、不带 pulse，且有 tooltip", (status, color) => {
    const dot = getDot(render(<StatusIndicator status={status} />).container);
    expect(dot?.style.backgroundColor).toBe(color);
    expect(dot?.className).not.toContain("cc-status-pulse");
    expect(dot?.getAttribute("title")).toBeTruthy();
  });

  it("toolRunning 带工具名时 tooltip 拼上工具名并显示 pulse 动效", () => {
    const dot = getDot(render(<StatusIndicator status="toolRunning" toolName="Bash" />).container);
    expect(dot?.className).toContain("cc-status-pulse");
    // label 形如 `${baseLabel}: Bash`
    expect(dot?.getAttribute("title")).toMatch(/:\s*Bash$/);
  });

  // 既有 7 处调用点零风险回归保护：无徽章（undefined / null）时保持单 span 结构
  it.each([undefined, null])("oscProgress=%s 时保持单 span 结构", (oscProgress) => {
    const { container } = render(<StatusIndicator status="toolRunning" oscProgress={oscProgress} />);
    expect(container.querySelectorAll("span").length).toBe(1);
  });
});

describe("StatusIndicator OSC 9;4 进度环（F5）", () => {
  const ringOf = (container: HTMLElement) => getDot(container)?.querySelector("span");

  it("running + 进度时渲染按百分比填充的 conic-gradient 进度环", () => {
    const ring = ringOf(render(<StatusIndicator status="toolRunning" oscProgress={badge("running", 50)} />).container);
    expect(ring?.style.background).toContain("conic-gradient");
    expect(ring?.style.background).toContain("50%");
  });

  it("进度环不改状态点本体颜色（F5.2：hook 权威优先）", () => {
    const { container } = render(<StatusIndicator status="waitingInput" oscProgress={badge("running", 80)} />);
    // 内层状态点仍是 waitingInput 的警告色，未被 OSC running 的 accent 覆盖
    const inner = container.querySelectorAll("span");
    expect(inner[inner.length - 1].style.backgroundColor).toBe("var(--app-status-warning)");
  });

  it("indeterminate 态进度环带旋转动画类", () => {
    const ring = ringOf(render(<StatusIndicator status="thinking" oscProgress={badge("indeterminate", 0)} />).container);
    expect(ring?.className).toContain("cc-osc-spin");
  });

  it.each<[OscProgressBadge["state"], string]>([
    ["paused", "var(--app-status-warning)"],
    ["error", "var(--app-status-danger)"],
  ])("%s 态环色映射为 %s", (state, color) => {
    const ring = ringOf(render(<StatusIndicator status="idle" oscProgress={badge(state, 30)} />).container);
    expect(ring?.style.background).toContain(color);
  });

  it("tooltip 含 OSC 状态词与百分比", () => {
    const title = getDot(render(
      <StatusIndicator status="toolRunning" oscProgress={badge("running", 42)} />,
    ).container)?.getAttribute("title") ?? "";
    expect(title).toContain("42%");
  });
});

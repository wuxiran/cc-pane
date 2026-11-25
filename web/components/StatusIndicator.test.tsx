import "@/i18n";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import StatusIndicator from "./StatusIndicator";
import type { OscProgressBadge } from "@/types";

// StatusIndicator 是纯展示组件：把传入的 status prop 映射为颜色点 + tooltip。
// 这里断言的是「给定 prop 的渲染结果」，不涉及从终端输出推断会话状态，
// 因此不违反项目 Gotcha（禁止对会话状态做文本模式匹配）。

function getDot(container: HTMLElement): HTMLElement | null {
  return container.querySelector("span");
}

describe("StatusIndicator", () => {
  it("status 为 null 时不渲染任何内容", () => {
    const { container } = render(<StatusIndicator status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("thinking 状态渲染品牌辅色圆点且不带 pulse 动效", () => {
    const { container } = render(<StatusIndicator status="thinking" />);
    const dot = getDot(container);
    expect(dot).not.toBeNull();
    expect(dot?.style.backgroundColor).toBe("var(--app-accent-2)");
    expect(dot?.className).not.toContain("cc-status-pulse");
    expect(dot?.getAttribute("title")).toBeTruthy();
  });

  it("toolRunning 带工具名时 tooltip 拼上工具名并显示 pulse 动效", () => {
    const { container } = render(<StatusIndicator status="toolRunning" toolName="Bash" />);
    const dot = getDot(container);
    expect(dot?.className).toContain("cc-status-pulse");
    // label 形如 `${baseLabel}: Bash`
    expect(dot?.getAttribute("title")).toMatch(/:\s*Bash$/);
  });

  it("waitingInput 状态渲染警告色圆点", () => {
    const { container } = render(<StatusIndicator status="waitingInput" />);
    expect(getDot(container)?.style.backgroundColor).toBe("var(--app-status-warning)");
  });

  it("size prop 决定圆点宽高", () => {
    const { container } = render(<StatusIndicator status="idle" size={20} />);
    expect(getDot(container)).toHaveStyle({ width: "20px", height: "20px" });
  });

  it("无 oscProgress 时保持单 span 结构（既有 7 处调用点零风险回归保护）", () => {
    const { container } = render(<StatusIndicator status="toolRunning" />);
    // 顶层就是那个状态点 span 本身，不是 relative 容器
    expect(getDot(container)?.className).not.toContain("relative");
    expect(container.querySelectorAll("span").length).toBe(1);
  });
});

describe("StatusIndicator OSC 9;4 进度环（F5）", () => {
  const badge = (state: OscProgressBadge["state"], progress: number): OscProgressBadge => ({
    state,
    progress,
  });

  it("running + 进度时渲染 conic-gradient 进度环，环宽 = size+4", () => {
    const { container } = render(
      <StatusIndicator status="toolRunning" oscProgress={badge("running", 50)} size={8} />,
    );
    const wrapper = getDot(container);
    expect(wrapper?.className).toContain("relative");
    expect(wrapper).toHaveStyle({ width: "12px", height: "12px" });
    const ring = wrapper?.querySelector("span");
    expect(ring?.style.background).toContain("conic-gradient");
    expect(ring?.style.background).toContain("50%");
  });

  it("进度环不改状态点本体颜色（F5.2：hook 权威优先）", () => {
    const { container } = render(
      <StatusIndicator status="waitingInput" oscProgress={badge("running", 80)} />,
    );
    // 内层状态点仍是 waitingInput 的警告色，未被 OSC running 的 accent 覆盖
    const inner = container.querySelectorAll("span");
    const dotEl = inner[inner.length - 1];
    expect(dotEl.style.backgroundColor).toBe("var(--app-status-warning)");
  });

  it("indeterminate 态进度环带旋转动画类", () => {
    const { container } = render(
      <StatusIndicator status="thinking" oscProgress={badge("indeterminate", 0)} />,
    );
    const ring = getDot(container)?.querySelector("span");
    expect(ring?.className).toContain("cc-osc-spin");
  });

  it("paused / error 态环色分别映射 warning / danger", () => {
    const { container: pausedC } = render(
      <StatusIndicator status="idle" oscProgress={badge("paused", 30)} />,
    );
    expect(getDot(pausedC)?.querySelector("span")?.style.background).toContain(
      "var(--app-status-warning)",
    );
    const { container: errorC } = render(
      <StatusIndicator status="idle" oscProgress={badge("error", 10)} />,
    );
    expect(getDot(errorC)?.querySelector("span")?.style.background).toContain(
      "var(--app-status-danger)",
    );
  });

  it("tooltip 含 OSC 状态词与百分比", () => {
    const { container } = render(
      <StatusIndicator status="toolRunning" oscProgress={badge("running", 42)} />,
    );
    const title = getDot(container)?.getAttribute("title") ?? "";
    expect(title).toContain("42%");
  });

  it("oscProgress 为 null 时等价于无徽章（单 span）", () => {
    const { container } = render(<StatusIndicator status="thinking" oscProgress={null} />);
    expect(container.querySelectorAll("span").length).toBe(1);
  });
});

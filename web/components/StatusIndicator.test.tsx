import "@/i18n";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import StatusIndicator from "./StatusIndicator";

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

  it("thinking 状态渲染强调色圆点且不带 pulse 动效", () => {
    const { container } = render(<StatusIndicator status="thinking" />);
    const dot = getDot(container);
    expect(dot).not.toBeNull();
    expect(dot?.style.backgroundColor).toBe("var(--app-accent)");
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
});

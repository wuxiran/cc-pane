import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import LayoutStatusGrid from "./LayoutStatusGrid";
import type { LayoutStatusSummary } from "./layoutStatusSummary";

function summary(partial: Partial<LayoutStatusSummary>): LayoutStatusSummary {
  const base = { running: 0, waitingInput: 0, blocked: 0, idle: 0, ...partial };
  return { ...base, total: base.running + base.waitingInput + base.blocked + base.idle };
}

describe("LayoutStatusGrid", () => {
  it("无会话时整块不渲染（由调用方改显文字）", () => {
    const { container } = render(<LayoutStatusGrid summary={summary({})} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("零值桶不渲染，不再占位", () => {
    render(<LayoutStatusGrid summary={summary({ running: 2 })} />);
    const row = screen.getByTestId("layout-status-row");
    expect(row.querySelectorAll("[data-status-cell]")).toHaveLength(1);
    expect(row.querySelector("[data-status-cell='running']")?.textContent).toBe("2");
  });

  // docs/46-frontend-styleguide.md:54 —— 等待授权必须有形状或文字冗余，不能只靠颜色。
  // 四个桶各用不同 svg 形状（三角/菱形/实心圆/空心圆），灰度下仍可区分。
  it("四个状态桶各有独立形状，不只靠颜色区分", () => {
    render(
      <LayoutStatusGrid summary={summary({ blocked: 1, waitingInput: 2, running: 3, idle: 4 })} />,
    );
    const row = screen.getByTestId("layout-status-row");
    const shapes = Array.from(row.querySelectorAll("[data-status-cell]")).map((cell) => {
      const svg = cell.querySelector("svg");
      return `${svg?.getAttribute("class")}|${svg?.getAttribute("fill")}`;
    });
    // 四个形状签名互不相同
    expect(new Set(shapes).size).toBe(4);
  });

  it("计数进 aria-label，title 只给状态名（数字已在视觉上相邻）", () => {
    render(<LayoutStatusGrid summary={summary({ waitingInput: 2 })} />);
    const cell = screen.getByTestId("layout-status-row").querySelector("[data-status-cell]");
    expect(cell?.getAttribute("aria-label")).toMatch(/^2 /);
    expect(cell?.getAttribute("title")).not.toMatch(/^2 /);
    expect(cell?.textContent).toBe("2");
  });

  it("按固定顺序排列：危险 → 等授权 → 运行 → 空闲", () => {
    render(<LayoutStatusGrid summary={summary({ idle: 1, running: 1, waitingInput: 1, blocked: 1 })} />);
    const order = Array.from(
      screen.getByTestId("layout-status-row").querySelectorAll("[data-status-cell]"),
    ).map((cell) => cell.getAttribute("data-status-cell"));
    expect(order).toEqual(["blocked", "waitingInput", "running", "idle"]);
  });
});

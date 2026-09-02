import "@/i18n"; // 不 import 的话 t() 原样返回 key，按文案查元素会全部落空
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LayoutTypeCounts from "./LayoutTypeCounts";
import type { LayoutTypeSummary } from "./layoutTypeSummary";

function summaryOf(partial: Partial<LayoutTypeSummary["groups"]>): LayoutTypeSummary {
  const groups = {
    terminal: [],
    browser: [],
    files: [],
    tools: [],
    ...partial,
  } as LayoutTypeSummary["groups"];
  const total = Object.values(groups).reduce((sum, tabs) => sum + tabs.length, 0);
  return { groups, total };
}

const ref = (id: string, paneId = `pane-${id}`) => ({ tabId: id, paneId, title: id });

describe("LayoutTypeCounts", () => {
  it("零值桁不渲染，只出现有内容的类型", () => {
    render(
      <LayoutTypeCounts
        summary={summaryOf({ terminal: [ref("t1"), ref("t2")] })}
        selected={false}
        onJump={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /2 (终端|terminal)/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /(浏览器|browser)/i })).not.toBeInTheDocument();
  });

  it("完全没有 tab 时整块不渲染", () => {
    const { container } = render(
      <LayoutTypeCounts summary={summaryOf({})} selected={false} onJump={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("单击跳到该类第一个 tab，再单击轮换到下一个", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(
      <LayoutTypeCounts
        summary={summaryOf({ terminal: [ref("t1", "pane-a"), ref("t2", "pane-b")] })}
        selected={false}
        onJump={onJump}
      />,
    );

    const button = screen.getByRole("button", { name: /2 (终端|terminal)/i });
    await user.click(button);
    expect(onJump).toHaveBeenLastCalledWith("pane-a", "t1");

    await user.click(button);
    expect(onJump).toHaveBeenLastCalledWith("pane-b", "t2");

    // 轮到头回卷，不是停在最后一个
    await user.click(button);
    expect(onJump).toHaveBeenLastCalledWith("pane-a", "t1");
    expect(onJump).toHaveBeenCalledTimes(3);
  });

  it("只有一个 tab 时反复点击都指向它（原地不动）", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(
      <LayoutTypeCounts
        summary={summaryOf({ browser: [ref("b1", "pane-x")] })}
        selected={false}
        onJump={onJump}
      />,
    );

    const button = screen.getByRole("button", { name: /1 (浏览器|browser)/i });
    await user.click(button);
    await user.click(button);
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenNthCalledWith(1, "pane-x", "b1");
    expect(onJump).toHaveBeenNthCalledWith(2, "pane-x", "b1");
  });

  // 卡片本身是 role="tab"，计数桁若不拦事件会连带触发切布局
  it("点击不冒泡到外层卡片", async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    render(
      <div role="tab" tabIndex={0} onClick={onCardClick}>
        <LayoutTypeCounts
          summary={summaryOf({ files: [ref("e1")] })}
          selected={false}
          onJump={vi.fn()}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /1 (文件|files)/i }));
    expect(onCardClick).not.toHaveBeenCalled();
  });
});

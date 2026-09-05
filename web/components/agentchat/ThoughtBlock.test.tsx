import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ThoughtBlock, { thoughtSeconds } from "./ThoughtBlock";

const base = { type: "thought" as const, id: "t1", at: 10_000, text: "先看看目录结构" };

describe("ThoughtBlock", () => {
  it("流式中自动展开并显示“正在思考”", () => {
    render(<ThoughtBlock item={base} streaming />);
    expect(screen.getByText("正在思考…")).toBeVisible();
    expect(screen.getByText("先看看目录结构")).toBeVisible();
  });

  it("收口后默认折叠，显示耗时，点开可看全文", () => {
    render(<ThoughtBlock item={{ ...base, doneAt: 14_400 }} streaming={false} />);
    expect(screen.getByText("思考了 4 秒")).toBeVisible();
    expect(screen.queryByText("先看看目录结构")).toBeNull();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("先看看目录结构")).toBeVisible();
  });

  it("没有 doneAt 时显示通用标题", () => {
    render(<ThoughtBlock item={base} streaming={false} />);
    expect(screen.getByText("思考过程")).toBeVisible();
  });
});

describe("thoughtSeconds", () => {
  it("不足一秒按 1 秒计，未收口为 null", () => {
    expect(thoughtSeconds({ ...base, doneAt: 10_200 })).toBe(1);
    expect(thoughtSeconds(base)).toBeNull();
  });
});

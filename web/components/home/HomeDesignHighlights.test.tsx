import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomeDesignHighlights from "./HomeDesignHighlights";

describe("HomeDesignHighlights", () => {
  it("默认卡片模式渲染标题与四条价值卡（多 agent 并排第一位）", () => {
    render(<HomeDesignHighlights />);

    expect(screen.getByText("它能为你做什么")).toBeVisible();
    expect(screen.getByText("多 agent 并排干活")).toBeVisible();
    expect(screen.getByText("工作空间收束")).toBeVisible();
    expect(screen.getByText("多 CLI 互通")).toBeVisible();
    expect(screen.getByText("数据留在本地")).toBeVisible();
  });

  it("compact 模式隐藏区块标题但保留四条价值卡", () => {
    render(<HomeDesignHighlights compact />);

    expect(screen.queryByText("它能为你做什么")).toBeNull();
    expect(screen.getByText("多 agent 并排干活")).toBeVisible();
    expect(screen.getByText("数据留在本地")).toBeVisible();
  });
});

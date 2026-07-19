import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomeDesignHighlights from "./HomeDesignHighlights";

describe("HomeDesignHighlights", () => {
  it("默认卡片模式渲染标题与四条理念", () => {
    render(<HomeDesignHighlights />);

    expect(screen.getByText("设计理念")).toBeVisible();
    expect(screen.getByText("三层模型")).toBeVisible();
    expect(screen.getByText("多 CLI 互通")).toBeVisible();
    expect(screen.getByText("多端支持")).toBeVisible();
    expect(screen.getByText("本地优先")).toBeVisible();
  });

  it("compact 模式隐藏区块标题但保留四条理念", () => {
    render(<HomeDesignHighlights compact />);

    expect(screen.queryByText("设计理念")).toBeNull();
    expect(screen.getByText("三层模型")).toBeVisible();
    expect(screen.getByText("本地优先")).toBeVisible();
  });
});

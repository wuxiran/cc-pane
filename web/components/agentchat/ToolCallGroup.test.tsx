import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AcpToolCallStatus } from "@/types/agentChat";
import ToolCallGroup from "./ToolCallGroup";

function tool(id: string, status?: AcpToolCallStatus) {
  return {
    type: "tool_call" as const,
    id,
    at: 1,
    call: { toolCallId: id, title: `工具 ${id}`, status },
  };
}

describe("ToolCallGroup", () => {
  it("单个调用直接渲染工具卡，不出分组头", () => {
    render(<ToolCallGroup items={[tool("a", "completed")]} onOpenLocation={vi.fn()} />);
    expect(screen.getByText("工具 a")).toBeVisible();
    expect(screen.queryByText(/调用了/)).toBeNull();
  });

  it("全部完成时折叠成一行，点开看明细", () => {
    render(
      <ToolCallGroup
        items={[tool("a", "completed"), tool("b", "completed"), tool("c", "failed")]}
        onOpenLocation={vi.fn()}
      />,
    );
    expect(screen.getByText("调用了 3 个工具")).toBeVisible();
    expect(screen.getByText("失败 1")).toBeVisible();
    expect(screen.queryByText("工具 a")).toBeNull();

    fireEvent.click(screen.getByText("调用了 3 个工具"));
    expect(screen.getByText("工具 a")).toBeVisible();
    expect(screen.getByText("工具 c")).toBeVisible();
  });

  it("有调用进行中时自动展开并显示进行中计数", () => {
    render(
      <ToolCallGroup
        items={[tool("a", "completed"), tool("b", "in_progress")]}
        onOpenLocation={vi.fn()}
      />,
    );
    expect(screen.getByText("进行中 1")).toBeVisible();
    expect(screen.getByText("工具 b")).toBeVisible();
  });
});

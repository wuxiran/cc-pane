import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatItem } from "@/types/agentChat";
import { computeTextDiff } from "@/services/agentChatService";
import ChatChangesBar from "./ChatChangesBar";

vi.mock("@/services/agentChatService", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeTextDiff: vi.fn(),
}));
vi.mock("@/utils/errorHandler", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  handleErrorSilent: vi.fn(),
}));

const edit = (id: string, path: string, before: string | null, after: string): AgentChatItem => ({
  type: "tool_call", id, at: 1,
  call: { toolCallId: id, status: "completed", content: [{ type: "diff", path, oldText: before, newText: after }] },
});

function diffResult(additions: number, deletions: number) {
  return { hunks: [], stats: { additions, deletions }, isBinary: false, truncated: false } as unknown as Awaited<ReturnType<typeof computeTextDiff>>;
}

beforeEach(() => {
  vi.mocked(computeTextDiff).mockReset();
});

describe("ChatChangesBar", () => {
  it("没有上报改动时整条不渲染", () => {
    const { container } = render(<ChatChangesBar items={[]} detailsOpen={false} onToggleDetails={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(computeTextDiff).not.toHaveBeenCalled();
  });

  it("按文件净改动计数，并汇总增删行", async () => {
    vi.mocked(computeTextDiff)
      .mockResolvedValueOnce(diffResult(3, 1))
      .mockResolvedValueOnce(diffResult(2, 0));
    render(
      <ChatChangesBar
        items={[edit("a1", "/repo/a.ts", "x", "y"), edit("a2", "/repo/a.ts", "y", "z"), edit("b", "/repo/b.ts", null, "new")]}
        detailsOpen={false}
        onToggleDetails={() => {}}
      />,
    );
    expect(screen.getByText(/2 个文件已修改|2 file\(s\) changed/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("chat-changes-bar-stats")).toHaveTextContent("+5−1"));
    // 同一文件多次编辑归并为「首个 old → 最后 new」再算一次。
    expect(computeTextDiff).toHaveBeenCalledWith("x", "z");
    expect(computeTextDiff).toHaveBeenCalledWith("", "new");
  });

  it("行数统计失败时只显示文件数，不编数字", async () => {
    vi.mocked(computeTextDiff).mockRejectedValue(new Error("offline"));
    render(<ChatChangesBar items={[edit("a", "/repo/a.ts", "x", "y")]} detailsOpen={false} onToggleDetails={() => {}} />);
    await waitFor(() => expect(computeTextDiff).toHaveBeenCalled());
    expect(screen.queryByTestId("chat-changes-bar-stats")).toBeNull();
    expect(screen.getByTestId("chat-changes-bar")).toBeInTheDocument();
  });

  it("点条展开逐文件 diff，审阅按钮打开会话审阅", () => {
    vi.mocked(computeTextDiff).mockResolvedValue(diffResult(1, 1));
    const onToggle = vi.fn();
    const onReview = vi.fn();
    render(<ChatChangesBar items={[edit("a", "/repo/a.ts", "x", "y")]} detailsOpen={false} onToggleDetails={onToggle} onReview={onReview} />);
    const toggle = screen.getByRole("button", { name: /展开改动|Show changes/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^(审阅|Review)$/ }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});

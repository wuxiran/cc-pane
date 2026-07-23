import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DiffView from "./DiffView";
import type { DiffResult, DiffLine } from "@/services";

function line(partial: Partial<DiffLine> & Pick<DiffLine, "changeType" | "content">): DiffLine {
  return {
    oldLineNo: null,
    newLineNo: null,
    inlineChanges: null,
    ...partial,
  };
}

function makeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    isBinary: false,
    truncated: false,
    truncationReason: null,
    oldSize: 24,
    newSize: 24,
    stats: { additions: 1, deletions: 1, changes: 0 },
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          line({ changeType: "equal", content: "context line", oldLineNo: 1, newLineNo: 1 }),
          line({ changeType: "delete", content: "removed line", oldLineNo: 2, newLineNo: null }),
          line({ changeType: "insert", content: "added line", oldLineNo: null, newLineNo: 2 }),
        ],
      },
    ],
    ...overrides,
  };
}

describe("DiffView", () => {
  it("loading 时显示计算中提示", () => {
    render(<DiffView diff={null} loading />);
    expect(screen.getByText(/计算差异中|Computing/i)).toBeInTheDocument();
  });

  it("diff 为 null 时提示选择版本", () => {
    render(<DiffView diff={null} />);
    expect(screen.getByText(/选择一个版本查看差异|Select a version/i)).toBeInTheDocument();
  });

  it("二进制文件显示对应提示", () => {
    render(<DiffView diff={makeDiff({ isBinary: true })} />);
    expect(screen.getByText(/二进制文件|Binary/i)).toBeInTheDocument();
  });

  it("行数截断显示 10000 行提示", () => {
    render(<DiffView diff={makeDiff({ truncated: true, truncationReason: "lineCount" })} />);
    expect(screen.getByText(/超过 10000 行|too large|skipped/i)).toBeInTheDocument();
  });

  it("文件大小截断显示两侧字节大小", () => {
    render(<DiffView diff={makeDiff({
      truncated: true,
      truncationReason: "fileSize",
      oldSize: 1024,
      newSize: 6 * 1024 * 1024,
    })} />);
    expect(screen.getByText(/1 KB.*6 MB|6 MB.*1 KB/i)).toBeInTheDocument();
  });

  it("无 hunks 时显示无变更提示", () => {
    render(<DiffView diff={makeDiff({ hunks: [] })} />);
    expect(screen.getByText(/没有变更|No changes/i)).toBeInTheDocument();
  });

  it("渲染统计信息与 hunk 头以及三类行", () => {
    render(<DiffView diff={makeDiff()} />);

    // 统计信息
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
    // 总行数（3 行）
    expect(screen.getByText(/^3 行$|^3 lines$/i)).toBeInTheDocument();

    // hunk 头
    expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();

    // 三类行内容都存在
    expect(screen.getByText("context line")).toBeInTheDocument();
    expect(screen.getByText("removed line")).toBeInTheDocument();
    expect(screen.getByText("added line")).toBeInTheDocument();
  });

  it("按 changeType 给行渲染不同背景色（添加=绿/删除=红/上下文=透明）", () => {
    render(<DiffView diff={makeDiff()} />);

    const insertRow = screen.getByText("added line").closest("div") as HTMLElement;
    const deleteRow = screen.getByText("removed line").closest("div") as HTMLElement;
    const contextRow = screen.getByText("context line").closest("div") as HTMLElement;

    expect(insertRow.style.background).toContain("34, 197, 94");
    expect(deleteRow.style.background).toContain("239, 68, 68");
    expect(contextRow.style.background).toBe("transparent");
  });

  it("行号列渲染 oldLineNo / newLineNo", () => {
    render(<DiffView diff={makeDiff()} />);
    // context 行同时有 old(1) 与 new(1)
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(2);
    // insert 行的 newLineNo=2
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
  });

  it("有 inlineChanges 时按段拆分渲染，高亮变化段", () => {
    const diff = makeDiff({
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            line({
              changeType: "insert",
              content: "hello world",
              newLineNo: 1,
              // 高亮 "world" (chars 6..11)
              inlineChanges: [{ start: 6, end: 11, changeType: "insert" }],
            }),
          ],
        },
      ],
    });
    render(<DiffView diff={diff} />);

    // 拆成三段: "hello ", "world"
    const changed = screen.getByText("world");
    expect(changed).toBeInTheDocument();
    // 变化段带高亮背景
    expect((changed as HTMLElement).style.background).toContain("34, 197, 94");
    expect(screen.getByText("hello", { exact: false })).toBeInTheDocument();
  });
});

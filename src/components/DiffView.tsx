import { useMemo, memo } from "react";
import type { DiffResult, DiffLine } from "@/services";

interface DiffViewProps {
  diff: DiffResult | null;
  loading?: boolean;
}

interface Segment {
  text: string;
  changed: boolean;
}

function getSegments(line: DiffLine): Segment[] {
  const content = line.content;
  const changes = line.inline_changes;
  if (!changes || changes.length === 0) {
    return [{ text: content, changed: false }];
  }

  const chars = Array.from(content);
  const segments: Segment[] = [];
  let pos = 0;

  for (const change of changes) {
    if (change.start > pos) {
      segments.push({ text: chars.slice(pos, change.start).join(""), changed: false });
    }
    segments.push({ text: chars.slice(change.start, change.end).join(""), changed: true });
    pos = change.end;
  }

  if (pos < chars.length) {
    segments.push({ text: chars.slice(pos).join(""), changed: false });
  }

  return segments;
}

export default memo(function DiffView({ diff, loading }: DiffViewProps) {
  const totalLines = useMemo(() => {
    if (!diff) return 0;
    return diff.hunks.reduce((sum, h) => sum + h.lines.length, 0);
  }, [diff]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-[13px]" style={{ color: "var(--app-text-tertiary)" }}>
        计算差异中...
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="h-full flex items-center justify-center text-[13px]" style={{ color: "var(--app-text-tertiary)" }}>
        选择一个版本查看差异
      </div>
    );
  }

  if (diff.is_binary) {
    return (
      <div className="h-full flex items-center justify-center text-[13px]" style={{ color: "var(--app-text-tertiary)" }}>
        二进制文件，无法显示差异
      </div>
    );
  }

  if (diff.truncated) {
    return (
      <div className="h-full flex items-center justify-center text-[13px]" style={{ color: "var(--app-text-tertiary)" }}>
        文件超过 10000 行，差异计算已跳过
      </div>
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[13px]" style={{ color: "var(--app-text-tertiary)" }}>
        文件内容没有变更
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto font-mono text-xs leading-relaxed">
      {/* 统计信息 */}
      <div
        className="flex gap-3 px-3 py-2 text-xs"
        style={{ borderBottom: "1px solid var(--app-border)", background: "var(--app-sidebar)" }}
      >
        <span className="font-semibold" style={{ color: "#22c55e" }}>+{diff.stats.additions}</span>
        <span className="font-semibold" style={{ color: "#ef4444" }}>-{diff.stats.deletions}</span>
        <span style={{ color: "var(--app-text-tertiary)" }}>{totalLines} 行</span>
      </div>

      {/* Hunks */}
      {diff.hunks.map((hunk, hi) => (
        <div key={hi} className="mb-0.5">
          <div
            className="px-3 py-1 text-[11px]"
            style={{
              background: "var(--app-active-bg)",
              color: "var(--app-text-secondary)",
              borderTop: "1px solid var(--app-border)",
              borderBottom: "1px solid var(--app-border)",
            }}
          >
            @@ -{hunk.old_start},{hunk.old_count} +{hunk.new_start},{hunk.new_count} @@
          </div>

          {hunk.lines.map((line, li) => {
            const bgColor =
              line.change_type === "insert"
                ? "rgba(34, 197, 94, 0.1)"
                : line.change_type === "delete"
                  ? "rgba(239, 68, 68, 0.1)"
                  : "transparent";
            const signColor =
              line.change_type === "insert"
                ? "#22c55e"
                : line.change_type === "delete"
                  ? "#ef4444"
                  : undefined;
            const sign =
              line.change_type === "insert"
                ? "+"
                : line.change_type === "delete"
                  ? "-"
                  : " ";

            return (
              <div key={li} className="flex whitespace-pre min-h-[20px]" style={{ background: bgColor }}>
                <span className="inline-block w-11 shrink-0 text-right pr-2 text-[11px] select-none" style={{ color: "var(--app-text-tertiary)" }}>
                  {line.old_line_no ?? ""}
                </span>
                <span className="inline-block w-11 shrink-0 text-right pr-2 text-[11px] select-none" style={{ color: "var(--app-text-tertiary)" }}>
                  {line.new_line_no ?? ""}
                </span>
                <span className="inline-block w-4 shrink-0 text-center select-none font-semibold" style={{ color: signColor }}>
                  {sign}
                </span>
                <span className="flex-1 pr-2 whitespace-pre-wrap break-all">
                  {line.inline_changes && line.inline_changes.length > 0 ? (
                    getSegments(line).map((seg, si) => (
                      <span
                        key={si}
                        style={
                          seg.changed
                            ? {
                                background:
                                  line.change_type === "insert"
                                    ? "rgba(34, 197, 94, 0.3)"
                                    : "rgba(239, 68, 68, 0.3)",
                                borderRadius: 2,
                              }
                            : undefined
                        }
                      >
                        {seg.text}
                      </span>
                    ))
                  ) : (
                    line.content
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});

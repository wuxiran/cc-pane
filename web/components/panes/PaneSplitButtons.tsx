// 悬停出现的分屏按钮：分屏不再只藏在右键菜单和快捷键里（从 TabBar 拆出，行数棘轮约束）。
// 窄档空间紧张时同样靠 hover 显现，pane 头部右键菜单是兜底入口。
import { PanelBottom, PanelRight } from "lucide-react";
import { runCommand } from "@/lib/commands/registry";

interface PaneSplitButtonsProps {
  paneId: string;
  addBtnClass: string;
  addIconClass: string;
  splitRightLabel: string;
  splitDownLabel: string;
}

export default function PaneSplitButtons({
  paneId,
  addBtnClass,
  addIconClass,
  splitRightLabel,
  splitDownLabel,
}: PaneSplitButtonsProps) {
  return (
    <div className="flex items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100">
      <button
        type="button"
        aria-label={splitRightLabel}
        title={splitRightLabel}
        className={`${addBtnClass} flex items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)]`}
        style={{ color: "var(--app-icon-inactive)" }}
        onClick={() => runCommand("split-right", { paneId })}
      >
        <PanelRight className={addIconClass} />
      </button>
      <button
        type="button"
        aria-label={splitDownLabel}
        title={splitDownLabel}
        className={`${addBtnClass} flex items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)]`}
        style={{ color: "var(--app-icon-inactive)" }}
        onClick={() => runCommand("split-down", { paneId })}
      >
        <PanelBottom className={addIconClass} />
      </button>
    </div>
  );
}

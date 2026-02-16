import { useState } from "react";
import { toast } from "sonner";
import { parseKeyEvent, formatKeyCombo, findConflict } from "@/stores";
import type { ShortcutSettings } from "@/types";

interface ShortcutsSectionProps {
  value: ShortcutSettings;
  onChange: (value: ShortcutSettings) => void;
}

const actionLabels: Record<string, string> = {
  "toggle-sidebar": "折叠/展开侧边栏",
  "toggle-fullscreen": "切换全屏",
  "new-tab": "新建标签",
  "close-tab": "关闭标签",
  settings: "打开设置",
  "split-right": "向右分屏",
  "split-down": "向下分屏",
  "next-tab": "下一个标签",
  "prev-tab": "上一个标签",
  "toggle-mini-mode": "切换迷你模式",
  "switch-tab-1": "切换到标签 1",
  "switch-tab-2": "切换到标签 2",
  "switch-tab-3": "切换到标签 3",
  "switch-tab-4": "切换到标签 4",
  "switch-tab-5": "切换到标签 5",
  "switch-tab-6": "切换到标签 6",
  "switch-tab-7": "切换到标签 7",
  "switch-tab-8": "切换到标签 8",
  "switch-tab-9": "切换到标签 9",
};

export default function ShortcutsSection({ value, onChange }: ShortcutsSectionProps) {
  const [editingAction, setEditingAction] = useState<string | null>(null);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!editingAction) return;
    e.preventDefault();
    e.stopPropagation();

    const combo = parseKeyEvent(e.nativeEvent);
    if (!combo) return;

    if (combo === "Escape") {
      setEditingAction(null);
      return;
    }

    const conflict = findConflict(value.bindings, editingAction, combo);
    if (conflict) {
      toast.warning(`快捷键 ${combo} 已被「${actionLabels[conflict] || conflict}」使用`);
      return;
    }

    const newBindings = { ...value.bindings, [editingAction]: combo };
    setEditingAction(null);
    onChange({ bindings: newBindings });
  }

  return (
    <div className="flex flex-col gap-3 outline-none" tabIndex={-1} onKeyDown={handleKeyDown}>
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        快捷键设置
      </h3>
      <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
        点击快捷键后按下新组合键进行修改，按 Esc 取消
      </p>

      <div className="flex flex-col gap-0.5">
        {Object.entries(value.bindings).map(([action, combo]) => (
          <div
            key={action}
            className="flex justify-between items-center py-1.5"
            style={{ borderBottom: "1px solid var(--app-border)" }}
          >
            <span className="text-[13px]" style={{ color: "var(--app-text-secondary)" }}>
              {actionLabels[action] || action}
            </span>
            <button
              className="text-xs px-2.5 py-[3px] rounded font-mono min-w-[80px] text-center cursor-pointer transition-all"
              style={{
                background: editingAction === action ? "var(--app-active-bg)" : "var(--app-hover)",
                border: `1px solid ${editingAction === action ? "var(--app-accent)" : "var(--app-border)"}`,
                color: editingAction === action ? "var(--app-accent)" : "var(--app-text-primary)",
              }}
              onClick={() => setEditingAction(action)}
            >
              {editingAction === action ? "按下新快捷键..." : formatKeyCombo(combo)}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

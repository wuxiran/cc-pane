import { Bot, LogOut, Settings, Shuffle, EyeOff } from "lucide-react";

export interface CCChanContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuProps {
  position: CCChanContextMenuPosition;
  onHide: () => void;
  onSwitchPet: () => void;
  onOpenSettings: () => void;
  onExit: () => void;
  onClose: () => void;
}

export function ContextMenu({
  position,
  onHide,
  onSwitchPet,
  onOpenSettings,
  onExit,
  onClose,
}: ContextMenuProps) {
  const items = [
    { label: "隐藏", icon: EyeOff, action: onHide },
    { label: "切换角色", icon: Shuffle, action: onSwitchPet },
    { label: "设置", icon: Settings, action: onOpenSettings },
    { label: "退出", icon: LogOut, action: onExit },
  ];

  return (
    <div
      className="fixed inset-0 z-50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="min-w-[150px] overflow-hidden rounded-md border py-1 shadow-xl"
        style={{
          position: "fixed",
          left: position.x,
          top: position.y,
          background: "var(--app-content)",
          borderColor: "var(--app-border)",
          color: "var(--app-text-primary)",
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] font-medium" style={{ color: "var(--app-text-secondary)" }}>
          <Bot size={14} />
          <span>cc酱</span>
        </div>
        <div className="h-px" style={{ background: "var(--app-border)" }} />
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--app-hover)]"
              onClick={() => {
                item.action();
                onClose();
              }}
            >
              <Icon size={14} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

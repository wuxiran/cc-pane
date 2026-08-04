import { Bot, EyeOff, LogOut, MessageCircle, Settings, Shuffle } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface CCChanContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuProps {
  position: CCChanContextMenuPosition;
  onHide: () => void;
  onOpenChat: () => void;
  onSwitchPet: () => void;
  onOpenSettings: () => void;
  onExit: () => void;
  onClose: () => void;
}

export function ContextMenu({
  position,
  onHide,
  onOpenChat,
  onSwitchPet,
  onOpenSettings,
  onExit,
  onClose,
}: ContextMenuProps) {
  const { t } = useTranslation("ccchan");
  const items = [
    { label: t("contextMenu.openChat"), icon: MessageCircle, action: onOpenChat, closeAfter: false },
    { label: t("contextMenu.hide"), icon: EyeOff, action: onHide },
    { label: t("contextMenu.switchPet"), icon: Shuffle, action: onSwitchPet },
    { label: t("contextMenu.settings"), icon: Settings, action: onOpenSettings },
    { label: t("contextMenu.exit"), icon: LogOut, action: onExit },
  ];

  return (
    <div
      className="absolute inset-0 z-50"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-[164px] overflow-hidden rounded-lg border py-1 shadow-2xl"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        style={{
          position: "absolute",
          left: position.x,
          top: position.y,
          background: "#ffffff",
          borderColor: "rgba(15, 23, 42, 0.16)",
          color: "#0f172a",
          boxShadow: "0 18px 42px rgba(15, 23, 42, 0.32), 0 0 0 1px rgba(255, 255, 255, 0.82)",
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] font-semibold" style={{ color: "#0f172a" }}>
          <Bot size={14} />
          <span>{t("contextMenu.title")}</span>
        </div>
        <div className="h-px" style={{ background: "#bae6fd" }} />
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium transition-colors hover:bg-sky-50"
              onClick={() => {
                item.action();
                if (item.closeAfter !== false) onClose();
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

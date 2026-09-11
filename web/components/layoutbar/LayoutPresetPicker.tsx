// 布局快捷簇：舒适档两行（Agent Chat / 星标+预设），紧凑档同一组并排。
// 点 Agent / 星标切到对应布局；点预设名弹出分屏网格。浮层不再重复专用布局。
// 复用 corner 模式选择器的 useFloatingPanelPosition 定位/夹紧逻辑，弹层方向改为按钮下方。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, MessagesSquare, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useActivityBarStore, usePanesStore } from "@/stores";
import { isAgentChatLayout } from "@/stores/panes/agentChatLayout";
import { isStarredLayout } from "@/stores/paneLayoutHelpers";
import type { LayoutPresetId } from "@/types/pane";
import { useFloatingPanelPosition } from "./useFloatingPanelPosition";

// 预设示意图标：16×16 小色块拼出目标分屏结构
const PRESET_ICONS: Record<LayoutPresetId, React.ReactNode> = {
  "single": <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />,
  "two-col": (
    <>
      <rect x="1.5" y="2.5" width="6" height="11" rx="1" />
      <rect x="8.5" y="2.5" width="6" height="11" rx="1" />
    </>
  ),
  "three-col": (
    <>
      <rect x="1.5" y="2.5" width="3.6" height="11" rx="1" />
      <rect x="6.2" y="2.5" width="3.6" height="11" rx="1" />
      <rect x="10.9" y="2.5" width="3.6" height="11" rx="1" />
    </>
  ),
  "two-row": (
    <>
      <rect x="1.5" y="2.5" width="13" height="5" rx="1" />
      <rect x="1.5" y="8.5" width="13" height="5" rx="1" />
    </>
  ),
  "grid-2x2": (
    <>
      <rect x="1.5" y="2.5" width="6" height="5" rx="1" />
      <rect x="8.5" y="2.5" width="6" height="5" rx="1" />
      <rect x="1.5" y="8.5" width="6" height="5" rx="1" />
      <rect x="8.5" y="8.5" width="6" height="5" rx="1" />
    </>
  ),
  "main-side": (
    <>
      <rect x="1.5" y="2.5" width="7.5" height="11" rx="1" />
      <rect x="10" y="2.5" width="4.5" height="5" rx="1" />
      <rect x="10" y="8.5" width="4.5" height="5" rx="1" />
    </>
  ),
};

const PRESET_ORDER = [
  { id: "single", labelKey: "layoutPresetSingle" },
  { id: "two-col", labelKey: "layoutPresetTwoCol" },
  { id: "three-col", labelKey: "layoutPresetThreeCol" },
  { id: "two-row", labelKey: "layoutPresetTwoRow" },
  { id: "grid-2x2", labelKey: "layoutPresetGrid" },
  { id: "main-side", labelKey: "layoutPresetMainSide" },
] as const satisfies ReadonlyArray<{ id: LayoutPresetId; labelKey: string }>;

type PresetLabelKey = (typeof PRESET_ORDER)[number]["labelKey"];

const PRESET_LABEL_KEYS = PRESET_ORDER.reduce(
  (map, preset) => {
    map[preset.id] = preset.labelKey;
    return map;
  },
  {} as Record<LayoutPresetId, PresetLabelKey>,
);

// 触发按钮下缘到浮层的间距；浮层宽度 w-64（256px）与
// useFloatingPanelPosition 的 FLOATING_PANEL_WIDTH 夹紧常量对齐。
const TRIGGER_PANEL_GAP = 10;

function chipStyle(active: boolean): React.CSSProperties {
  return active
    ? {
        background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
        color: "var(--app-accent)",
      }
    : { color: "var(--app-text-primary)" };
}

export default function LayoutPresetPicker({
  matchedPreset,
  stacked = false,
}: {
  /** 当前布局命中的预设；自定义为 null（按钮回退到通用文案） */
  matchedPreset: LayoutPresetId | null;
  /** 舒适档两行：上 Agent Chat，下左星标、下右预设 */
  stacked?: boolean;
}) {
  const { t } = useTranslation("panes");
  const applyLayoutPreset = usePanesStore((s) => s.applyLayoutPreset);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const switchLayout = usePanesStore((s) => s.switchLayout);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const [open, setOpen] = useState(false);
  const starredLayout = layouts.find(isStarredLayout);
  const agentChatLayout = layouts.find(isAgentChatLayout);
  const onStarred = starredLayout?.id === currentLayoutId;
  const onAgentChat = agentChatLayout?.id === currentLayoutId;
  const presetActive = !onStarred && !onAgentChat && Boolean(matchedPreset);
  const {
    rootRef,
    floatingRef,
    floatingPosition,
    setFloatingPosition,
    clampFloatingPosition,
  } = useFloatingPanelPosition();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const chipHeight = stacked ? "h-[30px]" : "h-[26px]";
  const chipClass = `flex min-w-0 items-center gap-1 rounded-md px-1.5 text-xs transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] ${chipHeight}`;

  function positionBelowTrigger() {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    setFloatingPosition(
      clampFloatingPosition({ left: rect.left, top: rect.bottom + TRIGGER_PANEL_GAP }),
    );
  }

  function openPanel() {
    positionBelowTrigger();
    setOpen(true);
  }

  function closePanel(options: { refocus?: boolean } = {}) {
    setOpen(false);
    setFloatingPosition(null);
    if (options.refocus) triggerRef.current?.focus();
  }

  function applyPreset(id: LayoutPresetId) {
    setAppViewMode("panes");
    applyLayoutPreset(id);
    closePanel({ refocus: true });
  }

  function selectSpecialLayout(layoutId: string) {
    setAppViewMode("panes");
    switchLayout(layoutId);
    closePanel({ refocus: true });
  }

  // 开启期间：点外关闭、Escape 关闭、视口变化重新夹紧位置、焦点移入浮层。
  // 非模态（aria-modal 不设）：用户仍可直接操作顶栏其余部分。
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      const floating = floatingRef.current;
      const target = event.target;
      if (!root || !(target instanceof Node) || root.contains(target) || floating?.contains(target)) {
        return;
      }
      closePanel();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closePanel({ refocus: true });
    }

    floatingRef.current?.focus();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", positionBelowTrigger);
    window.addEventListener("scroll", positionBelowTrigger, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", positionBelowTrigger);
      window.removeEventListener("scroll", positionBelowTrigger, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const presetLabel = matchedPreset ? t(PRESET_LABEL_KEYS[matchedPreset]) : t("layoutPresets");

  const agentButton = agentChatLayout ? (
    <button
      type="button"
      data-testid="layout-special-agent-chat"
      aria-label={t("layoutAgentChat")}
      aria-pressed={onAgentChat}
      className={`${chipClass} ${stacked ? "w-full" : ""}`}
      style={chipStyle(onAgentChat)}
      onClick={() => selectSpecialLayout(agentChatLayout.id)}
    >
      <MessagesSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="hidden truncate sm:inline">{t("layoutAgentChat")}</span>
    </button>
  ) : null;

  const starredButton = starredLayout ? (
    <button
      type="button"
      data-testid="layout-special-starred"
      aria-label={t("starredPanelTitle")}
      aria-pressed={onStarred}
      className={`${chipClass} shrink-0`}
      style={chipStyle(onStarred)}
      onClick={() => selectSpecialLayout(starredLayout.id)}
    >
      <Star className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="hidden truncate sm:inline">{t("starredPanelTitle")}</span>
    </button>
  ) : null;

  const presetButton = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={t("layoutPresets")}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={`${chipClass} ${stacked ? "flex-1" : ""}`}
      style={presetActive ? chipStyle(true) : { color: "var(--app-text-tertiary)" }}
      onClick={() => (open ? closePanel() : openPanel())}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden>
        <rect x="1.5" y="2.5" width="6" height="5" rx="1" />
        <rect x="8.5" y="2.5" width="6" height="5" rx="1" />
        <rect x="1.5" y="8.5" width="6" height="5" rx="1" />
        <rect x="8.5" y="8.5" width="6" height="5" rx="1" />
      </svg>
      <span className="hidden truncate sm:inline">{presetLabel}</span>
      <ChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
    </button>
  );

  return (
    <>
      <div
        ref={rootRef}
        className={
          stacked
            ? "flex h-full min-w-[152px] flex-col justify-center gap-1"
            : "flex flex-shrink-0 items-center gap-0.5"
        }
      >
        {stacked ? (
          <>
            {agentButton}
            <div className="flex min-w-0 items-center gap-1">
              {starredButton}
              {presetButton}
            </div>
          </>
        ) : (
          <>
            {agentButton}
            {starredButton}
            {presetButton}
          </>
        )}
      </div>

      {open && floatingPosition
        ? createPortal(
            <div
              ref={floatingRef}
              role="dialog"
              aria-label={t("layoutPresets")}
              tabIndex={-1}
              className="fixed z-[100] w-64 rounded-md border p-1.5 shadow-md outline-none"
              style={{
                left: floatingPosition.left,
                top: floatingPosition.top,
                background: "var(--app-panel-bg)",
                borderColor: "var(--app-border)",
                color: "var(--app-text-primary)",
              }}
            >
              <div className="grid grid-cols-2 gap-1">
                {PRESET_ORDER.map(({ id, labelKey }) => {
                  const active = presetActive && matchedPreset === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      data-testid="layout-preset-option"
                      aria-label={t(labelKey)}
                      aria-pressed={active}
                      className={`flex h-9 min-w-0 items-center gap-2 rounded-md px-2 text-xs transition-colors duration-[var(--dur-fast)] ${
                        active ? "" : "hover:bg-[var(--app-hover)]"
                      }`}
                      style={active ? chipStyle(true) : undefined}
                      onClick={() => applyPreset(id)}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        className="h-3.5 w-3.5 shrink-0"
                        fill="currentColor"
                        aria-hidden
                      >
                        {PRESET_ICONS[id]}
                      </svg>
                      <span className="truncate">{t(labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

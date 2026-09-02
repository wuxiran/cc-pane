import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, LayoutPanelTop, Network, Rows2, Rows3, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useActivityBarStore, useCanvasDisplayStore, useLayoutUiStore } from "@/stores";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { useFloatingPanelPosition } from "./useFloatingPanelPosition";

/** 低频布局偏好统一入口；面板/终端本身不因打开菜单而重新布局。 */
export default function LayoutViewMenu() {
  const { t } = useTranslation("panes");
  const switcherMode = useLayoutUiStore((state) => state.switcherMode);
  const density = useLayoutUiStore((state) => state.layoutBarDensity);
  const setSwitcherMode = useLayoutUiStore((state) => state.setSwitcherMode);
  const setDensity = useLayoutUiStore((state) => state.setLayoutBarDensity);
  const canvasMode = useCanvasDisplayStore((state) => state.mode);
  const setCanvasMode = useCanvasDisplayStore((state) => state.setMode);
  const setAppViewMode = useActivityBarStore((state) => state.setAppViewMode);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const {
    rootRef,
    floatingRef,
    floatingPosition,
    setFloatingPosition,
    clampFloatingPosition,
  } = useFloatingPanelPosition();

  function positionPanel() {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    setFloatingPosition(clampFloatingPosition({ left: rect.right + 10, top: rect.top }));
  }

  function close(refocus = false) {
    setOpen(false);
    setFloatingPosition(null);
    if (refocus) triggerRef.current?.focus();
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    positionPanel();
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || floatingRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      const activeElement = document.activeElement;
      if (!floatingRef.current?.contains(activeElement)) return;
      const activeIndex = itemRefs.current.findIndex((item) => item === activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = (activeIndex + delta + itemRefs.current.length) % itemRefs.current.length;
        itemRefs.current[next]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        itemRefs.current[event.key === "Home" ? 0 : itemRefs.current.length - 1]?.focus();
      }
    };
    floatingRef.current?.focus();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
    // Positioning callbacks intentionally read the current refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canvasVisible = canvasMode === "canvas";
  const nextDensity = density === "comfortable" ? "compact" : "comfortable";
  const actions = [
    {
      label: t(switcherMode === "topbar" ? "layoutModeCorner" : "layoutModeTopbar"),
      icon: switcherMode === "topbar" ? <ArrowDownLeft aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />,
      onClick: () => { setSwitcherMode(switcherMode === "topbar" ? "corner" : "topbar"); close(true); },
      testId: "layout-view-mode",
    },
    {
      label: t(nextDensity === "compact" ? "layoutDensityCompact" : "layoutDensityComfortable"),
      icon: density === "comfortable" ? <Rows2 aria-hidden="true" /> : <Rows3 aria-hidden="true" />,
      onClick: () => { setDensity(nextDensity); close(true); },
      testId: "layout-view-density",
    },
    {
      label: t(canvasVisible ? "hideTerminalCanvas" : "showTerminalCanvas"),
      icon: canvasVisible ? <LayoutPanelTop aria-hidden="true" /> : <Network aria-hidden="true" />,
      onClick: () => { setAppViewMode("panes"); setCanvasMode(canvasVisible ? "panel" : "canvas"); close(true); },
      testId: "layout-view-canvas",
    },
  ];

  return (
    <>
      <div ref={rootRef} className="flex shrink-0 items-center">
        <IconTooltipButton
          ref={triggerRef}
          label={t("layoutView")}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="layout-view-trigger"
          onClick={toggle}
          className="size-7 text-[var(--app-text-tertiary)]"
        >
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />
        </IconTooltipButton>
      </div>
      {open && floatingPosition ? createPortal(
        <div
          ref={floatingRef}
          role="menu"
          aria-label={t("layoutViewMenu")}
          tabIndex={-1}
          data-testid="layout-view-menu"
          className="fixed z-[120] min-w-56 rounded-md border p-1.5 shadow-lg outline-none"
          style={{
            left: floatingPosition.left,
            top: floatingPosition.top,
            background: "var(--app-panel-bg)",
            borderColor: "var(--app-border)",
            color: "var(--app-text-primary)",
          }}
        >
          {actions.map((action, index) => (
            <button
              key={action.testId}
              ref={(element) => { itemRefs.current[index] = element; }}
              type="button"
              role="menuitem"
              data-testid={action.testId}
              className="flex min-h-9 w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-[var(--app-text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:bg-[var(--app-hover)] focus-visible:outline-none"
              onClick={action.onClick}
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-[var(--app-text-tertiary)]">
                {action.icon}
              </span>
              <span className="min-w-0 truncate">{action.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

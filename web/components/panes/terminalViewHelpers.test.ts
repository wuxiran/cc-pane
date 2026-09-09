import { describe, expect, it, vi } from "vitest";

import * as terminalViewHelpers from "./terminalViewHelpers";
import terminalViewSource from "./TerminalView.tsx?raw";

describe("terminal view repaint visibility guard", () => {
  it("does not repaint a hidden terminal", () => {
    const repaint = vi.fn();

    const repainted = terminalViewHelpers.repaintTerminalWhenVisible(
      () => false,
      repaint,
      "window.focus",
    );

    expect(repainted).toBe(false);
    expect(repaint).not.toHaveBeenCalled();
  });

  it("repaints a visible terminal with the original reason", () => {
    const repaint = vi.fn();

    const repainted = terminalViewHelpers.repaintTerminalWhenVisible(
      () => true,
      repaint,
      "window.resize",
    );

    expect(repainted).toBe(true);
    expect(repaint).toHaveBeenCalledWith("window.resize");
  });

  // Window listeners moved to terminalWindowRecovery. Its tests dispatch real
  // focus/resize/visibility events and verify hidden-view guards and cleanup.
});

describe("macOS native menu block decision", () => {
  const { resolveNativeMenuBlock } = terminalViewHelpers;

  // 回归护栏：这一条挂了就说明 mac 右键菜单又被掐死了。
  it("lets contextmenu keep propagating so the Radix menu can open", () => {
    expect(resolveNativeMenuBlock({ eventType: "contextmenu", button: 2, isMac: true })).toEqual({
      blocked: true,
      stopPropagation: false,
    });
  });

  it("still swallows the non-contextmenu triggers entirely", () => {
    for (const eventType of ["pointerdown", "mousedown", "mouseup"]) {
      expect(resolveNativeMenuBlock({ eventType, button: 2, isMac: true })).toEqual({
        blocked: true,
        stopPropagation: true,
      });
    }
    // auxclick 是菜单事件但不是 contextmenu——不参与 Radix 触发，照旧掐断。
    expect(resolveNativeMenuBlock({ eventType: "auxclick", isMac: true })).toEqual({
      blocked: true,
      stopPropagation: true,
    });
  });

  it("treats ctrl+left click as a right click on mac", () => {
    expect(
      resolveNativeMenuBlock({ eventType: "mousedown", button: 0, ctrlKey: true, isMac: true }),
    ).toEqual({ blocked: true, stopPropagation: true });
  });

  it("ignores plain left clicks", () => {
    expect(
      resolveNativeMenuBlock({ eventType: "mousedown", button: 0, isMac: true }),
    ).toEqual({ blocked: false, stopPropagation: false });
  });

  it("never intercepts on non-mac platforms", () => {
    for (const eventType of ["contextmenu", "auxclick", "mousedown"]) {
      expect(resolveNativeMenuBlock({ eventType, button: 2, isMac: false })).toEqual({
        blocked: false,
        stopPropagation: false,
      });
    }
  });

  it("keeps the terminal context menu mounted on every platform", () => {
    // 曾经是 enabled={!IS_MAC}，等于 mac 上根本不挂菜单。
    expect(terminalViewSource).not.toContain("enabled={!IS_MAC}");
    // 终端宿主 div 上再挂 onContextMenu 会在冒泡阶段挡住外层 Radix trigger。
    const host = terminalViewSource.match(/ref=\{terminalRef\}[\s\S]{0,240}?\/>/)?.[0];
    expect(host).toBeDefined();
    expect(host).not.toContain("onContextMenu");
  });
});

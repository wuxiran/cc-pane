import { beforeEach, describe, expect, it } from "vitest";
import { useBrowserWebviewOverlayStore } from "./useBrowserWebviewOverlayStore";

describe("useBrowserWebviewOverlayStore", () => {
  beforeEach(() => {
    useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
  });

  it("keeps browser webviews blocked until every overlay is released", () => {
    const { setBlocked } = useBrowserWebviewOverlayStore.getState();

    setBlocked("menu-a", true);
    setBlocked("menu-b", true);
    setBlocked("menu-a", false);

    expect(useBrowserWebviewOverlayStore.getState().blockers).toEqual(new Set(["menu-b"]));

    setBlocked("menu-b", false);
    expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(0);
  });

  it("treats repeated acquire and release calls as idempotent", () => {
    const { setBlocked } = useBrowserWebviewOverlayStore.getState();

    setBlocked("menu", true);
    setBlocked("menu", true);
    expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(1);

    setBlocked("menu", false);
    setBlocked("menu", false);
    expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(0);
  });
});

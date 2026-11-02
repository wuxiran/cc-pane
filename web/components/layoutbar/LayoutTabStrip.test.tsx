import "@/i18n";
import { createPortal } from "react-dom";
import { DndContext } from "@dnd-kit/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LayoutTabStrip from "./LayoutTabStrip";

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  targets = new Set<Element>();
  disconnect = vi.fn(() => this.targets.clear());
  constructor(private callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  observe = (target: Element) => this.targets.add(target);
  unobserve = (target: Element) => this.targets.delete(target);
  notify() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const leftButton = () => screen.getByRole("button", { name: /向左滚动布局|Scroll layouts left/ });
const rightButton = () => screen.getByRole("button", { name: /向右滚动布局|Scroll layouts right/ });
const ids = Array.from({ length: 6 }, (_, index) => `layout-${index}`);

function fixture(active = ids[0], revealKey = "initial", status = "idle") {
  return (
    <DndContext>
      <LayoutTabStrip activeLayoutId={active} revealKey={revealKey}>
        {ids.map((id) => <button key={id} data-layout-id={id}>{id}: {status}</button>)}
      </LayoutTabStrip>
    </DndContext>
  );
}

function rect(left: number, width: number): DOMRect {
  return { x: left, y: 10, left, right: left + width, top: 10, bottom: 74,
    width, height: 64, toJSON: () => ({}) };
}

/** Supply only browser geometry/default scrolling; all interaction uses the real component. */
function installGeometry(rootWidth = 400, contentWidth = 1200) {
  const root = screen.getByTestId("layout-strip");
  const viewport = screen.getByTestId("layout-strip-scroll");
  const track = screen.getByTestId("layout-strip-items");
  const size = { rootWidth, contentWidth };
  let left = 0;
  const width = () => size.rootWidth - (root.querySelector("button[aria-controls]") ? 56 : 0);
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => size.rootWidth });
  Object.defineProperty(track, "scrollWidth", { configurable: true, get: () => size.contentWidth });
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: width },
    scrollWidth: { configurable: true, get: () => size.contentWidth },
    scrollLeft: { configurable: true, get: () => left, set: (value: number) => {
      left = Math.max(0, Math.min(Math.max(0, size.contentWidth - width()), value));
    } },
  });
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => rect(100, width()));
  track.querySelectorAll<HTMLElement>("[data-layout-id]").forEach((node, index) => {
    vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => rect(100 + index * 200 - left, 200));
  });
  const scrollBy = vi.fn((options: ScrollToOptions) => {
    viewport.scrollLeft += options.left ?? 0;
    fireEvent.scroll(viewport);
  });
  Object.defineProperty(viewport, "scrollBy", { configurable: true, value: scrollBy });
  act(() => window.dispatchEvent(new Event("resize")));
  const notifyResize = () => act(() => {
    TestResizeObserver.instances.filter((observer) => observer.targets.has(viewport))
      .forEach((observer) => observer.notify());
  });
  return { root, viewport, track, size, scrollBy, notifyResize };
}

function wheel(viewport: HTMLElement, options: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...options });
  act(() => viewport.dispatchEvent(event));
  return event;
}

describe("LayoutTabStrip overflow navigation", () => {
  beforeEach(() => {
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lets the mouse navigate to both ends and disables only the reached edge", () => {
    render(fixture());
    const { viewport, scrollBy } = installGeometry();
    expect(leftButton()).toBeDisabled();
    expect(rightButton()).toBeEnabled();
    expect(rightButton()).toHaveAttribute("aria-controls", viewport.id);

    for (let count = 0; count < 5; count++) fireEvent.click(rightButton());
    expect(viewport.scrollLeft).toBe(viewport.scrollWidth - viewport.clientWidth);
    expect(rightButton()).toBeDisabled();
    expect(leftButton()).toBeEnabled();
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));

    for (let count = 0; count < 5; count++) fireEvent.click(leftButton());
    expect(viewport.scrollLeft).toBe(0);
    expect(leftButton()).toBeDisabled();
    expect(rightButton()).toBeEnabled();
  });

  it.each([
    { name: "pixels", deltaMode: 0, deltaY: 90, expected: 90 },
    { name: "lines", deltaMode: 1, deltaY: 3, expected: 48 },
    { name: "pages", deltaMode: 2, deltaY: 1, expected: 344 },
  ])("maps vertical wheel $name to horizontal distance and releases the wheel at the edge", ({ deltaMode, deltaY, expected }) => {
    render(fixture());
    const { viewport } = installGeometry();
    expect(wheel(viewport, { deltaMode, deltaY }).defaultPrevented).toBe(true);
    expect(viewport.scrollLeft).toBe(expected);
    expect(wheel(viewport, { deltaY: 10000 }).defaultPrevented).toBe(true);
    expect(rightButton()).toBeDisabled();
    expect(wheel(viewport, { deltaY: 90 }).defaultPrevented).toBe(false);
    wheel(viewport, { deltaY: -10000 });
    expect(viewport.scrollLeft).toBe(0);
    expect(wheel(viewport, { deltaY: -90 }).defaultPrevented).toBe(false);
  });

  it.each([
    { name: "Ctrl/pinch", ctrlKey: true, deltaY: 100 },
    { name: "Meta", metaKey: true, deltaY: 100 },
    { name: "horizontal trackpad", deltaX: 100, deltaY: 10 },
    { name: "equal horizontal/vertical deltas", deltaX: 100, deltaY: 100 },
  ])("preserves native $name handling", ({ name: _name, ...options }) => {
    render(fixture());
    const { viewport } = installGeometry();
    expect(wheel(viewport, options).defaultPrevented).toBe(false);
    expect(viewport.scrollLeft).toBe(0);
    // The browser's native horizontal scroll still updates the affordances.
    viewport.scrollLeft = 300;
    fireEvent.scroll(viewport);
    expect(leftButton()).toBeEnabled();
  });

  it("reveals the newly selected last card and after resize, without resetting ordinary rerenders", () => {
    const view = render(fixture());
    const { viewport, size, notifyResize } = installGeometry();
    wheel(viewport, { deltaY: 500 });
    view.rerender(fixture(ids[0], "initial", "running"));
    expect(viewport.scrollLeft).toBe(500);

    view.rerender(fixture(ids[5]));
    expect(viewport.scrollLeft).toBe(856);
    size.rootWidth = 300;
    notifyResize();
    expect(viewport.scrollLeft).toBe(956);
    view.rerender(fixture(ids[0]));
    expect(viewport.scrollLeft).toBe(0);
  });

  it("reveals offscreen keyboard focus and a selected card after a density/rename key change", () => {
    const view = render(fixture(ids[2]));
    const { viewport } = installGeometry();
    fireEvent.focus(screen.getByText(`${ids[5]}: idle`));
    expect(viewport.scrollLeft).toBe(856);
    view.rerender(fixture(ids[2], "compact-renaming"));
    expect(viewport.scrollLeft).toBe(400);
  });

  it("does not scroll the cards when focus enters a portaled context menu", () => {
    render(
      <DndContext>
        <LayoutTabStrip activeLayoutId={ids[0]} revealKey="initial">
          {ids.map((id) => <button key={id} data-layout-id={id}>{id}</button>)}
          {createPortal(<button>Context menu action</button>, document.body)}
        </LayoutTabStrip>
      </DndContext>,
    );
    const { viewport } = installGeometry();
    const menuAction = screen.getByRole("button", { name: "Context menu action" });
    vi.spyOn(menuAction, "getBoundingClientRect").mockReturnValue(rect(1600, 200));
    fireEvent.focus(menuAction);
    expect(viewport.scrollLeft).toBe(0);
  });

  it("hides navigation when all cards fit, including when the buttons previously consumed space", () => {
    render(fixture());
    const { viewport, size, notifyResize } = installGeometry(1300);
    expect(screen.queryByRole("button", { name: /向右滚动布局|Scroll layouts right/ })).toBeNull();
    expect(wheel(viewport, { deltaY: 100 }).defaultPrevented).toBe(false);
    size.rootWidth = 400;
    notifyResize();
    expect(rightButton()).toBeEnabled();
    // 1,220 is enough for the cards, but not enough for cards plus both arrows.
    size.rootWidth = 1220;
    notifyResize();
    expect(screen.queryByRole("button", { name: /向右滚动布局|Scroll layouts right/ })).toBeNull();
  });

  it("observes content growth even without a window resize", () => {
    render(fixture());
    const { size, notifyResize } = installGeometry(1300);
    size.contentWidth = 1800;
    notifyResize();
    expect(rightButton()).toBeEnabled();
  });

  it("uses immediate navigation for reduced-motion users", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    render(fixture());
    const { scrollBy } = installGeometry();
    fireEvent.click(rightButton());
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("disconnects observers and removes wheel, scroll, and window listeners on unmount", () => {
    const view = render(fixture());
    const { root, viewport, track } = installGeometry();
    const observer = TestResizeObserver.instances.find((item) => item.targets.has(viewport))!;
    expect(observer.targets).toEqual(new Set([root, viewport, track]));
    const remove = vi.spyOn(viewport, "removeEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("wheel", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(wheel(viewport, { deltaY: 100 }).defaultPrevented).toBe(false);
    expect(viewport.scrollLeft).toBe(0);
  });
});

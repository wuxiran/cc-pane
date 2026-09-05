import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Panel, SplitPane } from "@/types";
import { usePanesStore } from "@/stores";
import SplitContainer, { NARROW_PANE_MIN_WIDTH_PX } from "./SplitContainer";

interface MockSplitViewProps {
  vertical: boolean;
  sizes: number[];
  paneMinWidth?: number;
  onDragEnd: (sizes: number[]) => void;
  keys: string[];
  children: React.ReactNode[];
}

let lastSplitViewProps: MockSplitViewProps | null = null;

vi.mock("./SplitView", () => ({
  default: (props: MockSplitViewProps) => {
    lastSplitViewProps = props;
    return <div data-testid="split-view">{props.children}</div>;
  },
}));

vi.mock("./PaneContainer", () => ({
  default: ({ pane }: { pane: Panel }) => <div data-testid={`child-${pane.id}`} />,
}));

function makePanel(id: string): Panel {
  return { type: "panel", id, tabs: [], activeTabId: "" };
}

function makeSplit(overrides?: Partial<SplitPane>): SplitPane {
  return {
    type: "split",
    id: "split-1",
    direction: "horizontal",
    children: [makePanel("a"), makePanel("b")],
    sizes: [50, 50],
    ...overrides,
  };
}

describe("SplitContainer", () => {
  afterEach(() => {
    lastSplitViewProps = null;
    vi.restoreAllMocks();
  });

  it("renders each child through SplitView with stable keys", () => {
    render(<SplitContainer pane={makeSplit()} />);

    expect(screen.getByTestId("child-a")).toBeInTheDocument();
    expect(screen.getByTestId("child-b")).toBeInTheDocument();
    expect(lastSplitViewProps?.keys).toEqual(["a", "b"]);
    expect(lastSplitViewProps?.vertical).toBe(false);
    expect(lastSplitViewProps?.sizes).toEqual([50, 50]);
  });

  it("maps vertical direction to a vertical SplitView", () => {
    render(<SplitContainer pane={makeSplit({ direction: "vertical" })} />);

    expect(lastSplitViewProps?.vertical).toBe(true);
  });

  it("normalizes drag sizes to percentages summing to exactly 100", () => {
    const resizePanes = vi.fn();
    usePanesStore.setState({ resizePanes });

    render(<SplitContainer pane={makeSplit()} />);
    lastSplitViewProps?.onDragEnd([33.333, 66.667]);

    expect(resizePanes).toHaveBeenCalledTimes(1);
    const [paneId, sizes] = resizePanes.mock.calls[0];
    expect(paneId).toBe("split-1");
    expect(sizes.reduce((a: number, b: number) => a + b, 0)).toBe(100);
    expect(sizes[0]).toBeCloseTo(33.3, 5);
    expect(sizes[1]).toBeCloseTo(66.7, 5);
  });

  it("ignores drag results whose total is zero", () => {
    const resizePanes = vi.fn();
    usePanesStore.setState({ resizePanes });

    render(<SplitContainer pane={makeSplit()} />);
    lastSplitViewProps?.onDragEnd([0, 0]);

    expect(resizePanes).not.toHaveBeenCalled();
  });
});

// 窄档（< md）列宽下限 + 横向滚动（docs/splitview-narrow.md）
describe("SplitContainer narrow-mode protection", () => {
  const ORIGINAL_INNER_WIDTH = window.innerWidth;

  function setViewportWidth(width: number) {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    });
  }

  function resizeTo(width: number) {
    setViewportWidth(width);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  function wrapperOf(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>(".split-container")!;
  }

  afterEach(() => {
    setViewportWidth(ORIGINAL_INNER_WIDTH);
    lastSplitViewProps = null;
    vi.restoreAllMocks();
  });

  it("applies pane min-width floor and horizontal scroll at xs for horizontal splits", () => {
    setViewportWidth(500);
    const { container } = render(<SplitContainer pane={makeSplit()} />);

    expect(lastSplitViewProps?.paneMinWidth).toBe(NARROW_PANE_MIN_WIDTH_PX);
    expect(wrapperOf(container).style.overflowX).toBe("auto");
    expect(wrapperOf(container).style.overflowY).toBe("hidden");
  });

  it("applies the same protection at sm (just below md)", () => {
    setViewportWidth(767);
    const { container } = render(<SplitContainer pane={makeSplit()} />);

    expect(lastSplitViewProps?.paneMinWidth).toBe(NARROW_PANE_MIN_WIDTH_PX);
    expect(wrapperOf(container).style.overflowX).toBe("auto");
  });

  it("does not protect vertical splits at narrow widths (rows stay full width)", () => {
    setViewportWidth(500);
    const { container } = render(
      <SplitContainer pane={makeSplit({ direction: "vertical" })} />
    );

    expect(lastSplitViewProps?.paneMinWidth).toBeUndefined();
    expect(wrapperOf(container).style.overflowX).toBe("");
    expect(wrapperOf(container).style.overflowY).toBe("");
  });

  it.each<[string, number]>([
    ["md boundary", 768],
    ["lg", 1024],
    ["xl", 1400],
  ])("keeps lg-and-up behavior unchanged at %s (%dpx)", (_label, width) => {
    setViewportWidth(width);
    const { container } = render(<SplitContainer pane={makeSplit()} />);

    expect(lastSplitViewProps?.paneMinWidth).toBeUndefined();
    const wrapper = wrapperOf(container);
    expect(wrapper.style.overflowX).toBe("");
    expect(wrapper.style.overflowY).toBe("");
    // 既有 props 逐项不变
    expect(lastSplitViewProps?.vertical).toBe(false);
    expect(lastSplitViewProps?.sizes).toEqual([50, 50]);
    expect(lastSplitViewProps?.keys).toEqual(["a", "b"]);
  });

  it("toggles protection when crossing the md boundary via window resize", () => {
    setViewportWidth(1400);
    const { container } = render(<SplitContainer pane={makeSplit()} />);
    expect(lastSplitViewProps?.paneMinWidth).toBeUndefined();

    resizeTo(500);
    expect(lastSplitViewProps?.paneMinWidth).toBe(NARROW_PANE_MIN_WIDTH_PX);
    expect(wrapperOf(container).style.overflowX).toBe("auto");

    resizeTo(1400);
    expect(lastSplitViewProps?.paneMinWidth).toBeUndefined();
    expect(wrapperOf(container).style.overflowX).toBe("");
  });

  it("creates no ResizeObserver feedback path and style mutations converge", async () => {
    let roConstructed = 0;
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor() {
        roConstructed += 1;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    // MutationObserver 回调按微任务投递，等一拍再计数
    const flushObservers = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    try {
      setViewportWidth(1400);
      const { container } = render(<SplitContainer pane={makeSplit()} />);
      const wrapper = wrapperOf(container);

      let styleMutations = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === "style") styleMutations += 1;
        }
      });
      observer.observe(wrapper, { attributes: true, attributeFilter: ["style"] });

      // 跨档一次：样式收敛（有限次变更后停止）
      resizeTo(500);
      await flushObservers();
      const mutationsAfterCrossing = styleMutations;
      expect(mutationsAfterCrossing).toBeGreaterThan(0);

      // 同档重复 resize：幂等，不再写样式（无振荡 → 无 refit 循环源）
      resizeTo(500);
      await flushObservers();
      expect(styleMutations).toBe(mutationsAfterCrossing);

      observer.disconnect();
      // 分屏壳自身不观察尺寸；唯一 RO 在 TerminalView 的 xterm host（既有增量门/防抖守护）
      expect(roConstructed).toBe(0);
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });
});

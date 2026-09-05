import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SplitView from "./SplitView";
import { isDragging } from "@/stores/splitDragState";

function renderSplitView({
  sizes = [50, 50],
  vertical = false,
  onDragEnd = vi.fn(),
  childCount = 2,
  paneMinWidth,
}: {
  sizes?: number[];
  vertical?: boolean;
  onDragEnd?: (sizes: number[]) => void;
  childCount?: number;
  paneMinWidth?: number;
} = {}) {
  const children = Array.from({ length: childCount }, (_, i) => (
    <div data-testid={`content-${i}`} key={i} />
  ));
  const keys = Array.from({ length: childCount }, (_, i) => `k${i}`);
  const view = render(
    <SplitView vertical={vertical} sizes={sizes} onDragEnd={onDragEnd} keys={keys} paneMinWidth={paneMinWidth}>
      {children}
    </SplitView>
  );
  const container = view.container.querySelector<HTMLElement>(".splitview-container")!;
  return { view, container, onDragEnd };
}

describe("SplitView", () => {
  beforeEach(() => {
    // rAF 同步执行，让拖拽中的 DOM 更新立即生效
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lays out panes with flexBasis from sizes and a sash between panes", () => {
    const { container } = renderSplitView({ sizes: [30, 70] });

    const panes = container.querySelectorAll<HTMLElement>("[data-splitview-pane]");
    expect(panes).toHaveLength(2);
    expect(panes[0].style.flexBasis).toBe("30%");
    expect(panes[1].style.flexBasis).toBe("70%");
    expect(container.querySelectorAll(".splitview-sash")).toHaveLength(1);
    expect(container.style.flexDirection).toBe("row");
  });

  it("uses column direction and horizontal sash class when vertical", () => {
    const { container } = renderSplitView({ vertical: true });

    expect(container.style.flexDirection).toBe("column");
    expect(container.querySelector(".splitview-sash")!.className).toContain("horizontal");
  });

  it("falls back to equal sizes when sizes length mismatches children", () => {
    const { container } = renderSplitView({ sizes: [100], childCount: 4 });

    const panes = container.querySelectorAll<HTMLElement>("[data-splitview-pane]");
    expect(panes).toHaveLength(4);
    for (const pane of panes) {
      expect(pane.style.flexBasis).toBe("25%");
    }
    // 4 个 pane 之间 3 条 sash
    expect(container.querySelectorAll(".splitview-sash")).toHaveLength(3);
  });

  it("drags a sash to resize both panes and reports final sizes on pointer up", () => {
    const onDragEnd = vi.fn();
    const { container } = renderSplitView({ sizes: [50, 50], onDragEnd });

    Object.defineProperty(container, "clientWidth", { configurable: true, value: 1000 });
    const sash = container.querySelector<HTMLElement>(".splitview-sash")!;
    const panes = container.querySelectorAll<HTMLElement>("[data-splitview-pane]");

    fireEvent.pointerDown(sash, { clientX: 500, clientY: 0 });
    expect(isDragging()).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");

    // 向右拖 100px = 10%
    fireEvent.pointerMove(document, { clientX: 600, clientY: 0 });
    expect(panes[0].style.flexBasis).toBe("60%");
    expect(panes[1].style.flexBasis).toBe("40%");

    fireEvent.pointerUp(document);
    expect(onDragEnd).toHaveBeenCalledWith([60, 40]);
    expect(isDragging()).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });

  it("clamps drag so no pane goes below minSize", () => {
    const onDragEnd = vi.fn();
    const { container } = renderSplitView({ sizes: [50, 50], onDragEnd });

    Object.defineProperty(container, "clientWidth", { configurable: true, value: 1000 });
    const sash = container.querySelector<HTMLElement>(".splitview-sash")!;

    fireEvent.pointerDown(sash, { clientX: 500, clientY: 0 });
    // 向右拖出容器：右侧应被钳到 minSize (50px / 1000px = 5%)
    fireEvent.pointerMove(document, { clientX: 2000, clientY: 0 });
    fireEvent.pointerUp(document);

    const [sizes] = onDragEnd.mock.calls[0];
    expect(sizes[1]).toBe(5);
    expect(sizes[0]).toBe(95);
  });

  it("uses clientY when dragging a vertical split", () => {
    const onDragEnd = vi.fn();
    const { container } = renderSplitView({ sizes: [50, 50], vertical: true, onDragEnd });

    Object.defineProperty(container, "clientHeight", { configurable: true, value: 800 });
    const sash = container.querySelector<HTMLElement>(".splitview-sash")!;

    fireEvent.pointerDown(sash, { clientX: 0, clientY: 400 });
    expect(document.body.style.cursor).toBe("row-resize");
    fireEvent.pointerMove(document, { clientX: 0, clientY: 320 });
    fireEvent.pointerUp(document);

    expect(onDragEnd).toHaveBeenCalledWith([40, 60]);
  });

  it("does nothing when container size is zero", () => {
    const onDragEnd = vi.fn();
    const { container } = renderSplitView({ onDragEnd });

    // jsdom 默认 clientWidth = 0
    const sash = container.querySelector<HTMLElement>(".splitview-sash")!;
    fireEvent.pointerDown(sash, { clientX: 500, clientY: 0 });

    expect(isDragging()).toBe(false);
    fireEvent.pointerMove(document, { clientX: 600, clientY: 0 });
    fireEvent.pointerUp(document);
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it("cleans up an in-progress drag when the component unmounts", () => {
    const onDragEnd = vi.fn();
    const { view, container } = renderSplitView({ onDragEnd });

    Object.defineProperty(container, "clientWidth", { configurable: true, value: 1000 });
    const sash = container.querySelector<HTMLElement>(".splitview-sash")!;
    fireEvent.pointerDown(sash, { clientX: 500, clientY: 0 });
    expect(isDragging()).toBe(true);

    view.unmount();

    expect(isDragging()).toBe(false);
    expect(document.body.style.userSelect).toBe("");
    // 卸载清理后 pointerup 不再触发 onDragEnd
    fireEvent.pointerUp(document);
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  // 窄档列宽下限（docs/splitview-narrow.md）
  describe("paneMinWidth floor", () => {
    it("applies the min-width floor with a smooth min-width transition", () => {
      const { container } = renderSplitView({ paneMinWidth: 320 });

      const panes = container.querySelectorAll<HTMLElement>("[data-splitview-pane]");
      expect(panes).toHaveLength(2);
      for (const pane of panes) {
        expect(pane.style.minWidth).toBe("320px");
        expect(pane.style.transition).toContain("min-width var(--dur)");
      }
      // 百分比布局与 sash 结构不变
      expect(panes[0].style.flexBasis).toBe("50%");
      expect(container.querySelectorAll(".splitview-sash")).toHaveLength(1);
    });

    it("keeps minWidth 0 and no transition when paneMinWidth is omitted", () => {
      const { container } = renderSplitView();

      const panes = container.querySelectorAll<HTMLElement>("[data-splitview-pane]");
      expect(panes[0].style.minWidth).toBe("0px");
      expect(panes[0].style.transition).toBe("");
    });

    it("drags with the same percentage math when paneMinWidth is set", () => {
      const onDragEnd = vi.fn();
      const { container } = renderSplitView({ sizes: [50, 50], onDragEnd, paneMinWidth: 320 });

      Object.defineProperty(container, "clientWidth", { configurable: true, value: 1000 });
      const sash = container.querySelector<HTMLElement>(".splitview-sash")!;
      const panes = container.querySelectorAll<HTMLElement>("[data-splitview-pane]");

      fireEvent.pointerDown(sash, { clientX: 500, clientY: 0 });
      fireEvent.pointerMove(document, { clientX: 600, clientY: 0 });
      fireEvent.pointerUp(document);

      expect(panes[0].style.flexBasis).toBe("60%");
      expect(onDragEnd).toHaveBeenCalledWith([60, 40]);
      // 拖拽只动 flexBasis，不写 min-width（不会制造额外 RO 回写）
      expect(panes[0].style.minWidth).toBe("320px");
    });

    it("toggling paneMinWidth remounts nothing and creates no ResizeObserver", () => {
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

      try {
        const children = [
          <div data-testid="content-0" key={0} />,
          <div data-testid="content-1" key={1} />,
        ];
        const { container, rerender } = render(
          <SplitView vertical={false} sizes={[50, 50]} onDragEnd={vi.fn()} keys={["k0", "k1"]}>
            {children}
          </SplitView>
        );
        const before = Array.from(
          container.querySelectorAll<HTMLElement>("[data-splitview-pane]")
        );

        rerender(
          <SplitView
            vertical={false}
            sizes={[50, 50]}
            onDragEnd={vi.fn()}
            keys={["k0", "k1"]}
            paneMinWidth={320}
          >
            {children}
          </SplitView>
        );
        const after = Array.from(
          container.querySelectorAll<HTMLElement>("[data-splitview-pane]")
        );

        // keep-alive 安全性：断点穿越只改样式，pane 元素同一引用，子树不卸载
        expect(after[0]).toBe(before[0]);
        expect(after[1]).toBe(before[1]);
        expect(after[0].style.minWidth).toBe("320px");
        // refit 回路防线：分屏组件自身不构造任何 ResizeObserver
        expect(roConstructed).toBe(0);
      } finally {
        globalThis.ResizeObserver = OriginalRO;
      }
    });
  });
});

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSuppressChromeContextMenu } from "./useSuppressChromeContextMenu";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function rightClick(target: EventTarget): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("useSuppressChromeContextMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("chrome 区域（标题栏/状态栏空白）右键被拦截", () => {
    renderHook(() => useSuppressChromeContextMenu());
    const host = mount('<header class="titlebar"><span id="title">CC-Panes</span></header>');
    const event = rightClick(host.querySelector("#title")!);
    expect(event.defaultPrevented).toBe(true);
  });

  it("文本节点作为目标时按其父元素判断", () => {
    renderHook(() => useSuppressChromeContextMenu());
    const host = mount('<footer id="status">ready</footer>');
    const event = rightClick(host.querySelector("#status")!.firstChild!);
    expect(event.defaultPrevented).toBe(true);
  });

  it("终端宿主与 xterm 内放行", () => {
    renderHook(() => useSuppressChromeContextMenu());
    const host = mount(
      '<div class="cc-terminal-host"><div class="xterm"><div id="row">$ ls</div></div></div><div class="xterm"><i id="bare"></i></div>',
    );
    expect(rightClick(host.querySelector("#row")!).defaultPrevented).toBe(false);
    expect(rightClick(host.querySelector("#bare")!).defaultPrevented).toBe(false);
  });

  it("input / textarea / contenteditable 放行，contenteditable=false 仍拦", () => {
    renderHook(() => useSuppressChromeContextMenu());
    const host = mount(
      '<input id="i" /><textarea id="t"></textarea><div contenteditable="true"><b id="ce">x</b></div><div contenteditable="false" id="ro">y</div>',
    );
    expect(rightClick(host.querySelector("#i")!).defaultPrevented).toBe(false);
    expect(rightClick(host.querySelector("#t")!).defaultPrevented).toBe(false);
    expect(rightClick(host.querySelector("#ce")!).defaultPrevented).toBe(false);
    expect(rightClick(host.querySelector("#ro")!).defaultPrevented).toBe(true);
  });

  it("[data-native-context-menu] 祖先内放行", () => {
    renderHook(() => useSuppressChromeContextMenu());
    const host = mount('<article data-native-context-menu><p id="p">doc</p></article>');
    expect(rightClick(host.querySelector("#p")!).defaultPrevented).toBe(false);
  });

  it("右键落在选中的文字上放行；选区折叠或不相交仍拦", () => {
    renderHook(() => useSuppressChromeContextMenu());
    const host = mount('<p id="doc">hello world</p><p id="other">elsewhere</p>');
    const doc = host.querySelector("#doc")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(doc);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(rightClick(doc.firstChild!).defaultPrevented).toBe(false);
    expect(rightClick(host.querySelector("#other")!).defaultPrevented).toBe(true);
    selection.collapseToStart();
    expect(rightClick(doc).defaultPrevented).toBe(true);
    selection.removeAllRanges();
  });

  it("已被前端处理（defaultPrevented）的右键不再干预", () => {
    renderHook(() => useSuppressChromeContextMenu());
    const host = mount('<div id="trigger">tab</div>');
    const target = host.querySelector("#trigger")!;
    const lateSpy = vi.fn();
    target.addEventListener("contextmenu", (e) => {
      // 模拟 Radix ContextMenu trigger 自行 preventDefault；之后的 preventDefault 调用都记到 spy
      e.preventDefault();
      e.preventDefault = lateSpy;
    });
    const event = rightClick(target);
    expect(event.defaultPrevented).toBe(true);
    expect(lateSpy).not.toHaveBeenCalled();
  });

  it("监听挂在冒泡阶段：目标自身的处理器先看到未拦截的事件", () => {
    renderHook(() => useSuppressChromeContextMenu());
    const host = mount('<div id="chrome">bar</div>');
    const target = host.querySelector("#chrome")!;
    let preventedAtTarget: boolean | null = null;
    target.addEventListener("contextmenu", (e) => {
      preventedAtTarget = e.defaultPrevented;
    });
    const event = rightClick(target);
    expect(preventedAtTarget).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it("卸载后不再拦截", () => {
    const { unmount } = renderHook(() => useSuppressChromeContextMenu());
    unmount();
    const host = mount('<div id="x">x</div>');
    expect(rightClick(host.querySelector("#x")!).defaultPrevented).toBe(false);
  });
});

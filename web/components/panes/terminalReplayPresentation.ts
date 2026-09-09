import type { Terminal } from "@xterm/xterm";

/** Structural subset keeps replay usable before open() and in non-DOM consumers. */
export interface ReplayPresentationTerminal {
  element?: HTMLElement | null;
  rows?: number;
  buffer: {
    active: {
      type: "normal" | "alternate";
      viewportY?: number;
      baseY?: number;
      getLine?: (line: number) => { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  scrollToLine?: Terminal["scrollToLine"];
  scrollToBottom?: Terminal["scrollToBottom"];
  refresh?: Terminal["refresh"];
  onRender?: Terminal["onRender"];
  options?: Terminal["options"];
}

interface FrozenPresentation {
  depth: number;
  version: number;
  hide: () => void;
  layouts: Map<object, () => void>;
  finish: () => Promise<void>;
}

interface CapturedFrame {
  element: HTMLElement;
  parent: HTMLElement;
  copy: HTMLElement;
  opacity: string;
  position: string;
  ariaBusy: string | null;
  restoreViewport: () => void;
}

const presentations = new WeakMap<object, FrozenPresentation>();
const preparations = new WeakMap<object, Promise<FrozenPresentation | null>>();

/** A changing terminal grid must not race replay's cursor-positioning instructions. */
export function deferTerminalLayoutDuringReplay(term: object, owner: object, apply: () => void): boolean {
  const presentation = presentations.get(term);
  if (!presentation || presentation.depth === 0) return false;
  presentation.layouts.set(owner, apply);
  return true;
}

/** Copy the current frame, including WebGL canvases, without live listeners/input. */
function clonePaintedFrame(element: HTMLElement): HTMLElement {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.removeAttribute("id");
  copy.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  copy.querySelectorAll("textarea,input").forEach((node) => node.remove());
  const canvases = copy.querySelectorAll("canvas");
  element.querySelectorAll("canvas").forEach((canvas, index) => {
    canvases[index]?.getContext("2d")?.drawImage(canvas, 0, 0);
  });
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.classList.add("cc-terminal-static-frame");
  Object.assign(copy.style, {
    position: "absolute", inset: "0", width: "100%", height: "100%",
    margin: "0", pointerEvents: "none", overflow: "hidden", zIndex: "1", visibility: "visible",
  });
  return copy;
}

function tryClonePaintedFrame(element: HTMLElement): HTMLElement | null {
  try { return clonePaintedFrame(element); }
  catch (error) {
    console.warn("[terminal-replay] Could not capture the current frame", error);
    return null;
  }
}

/** WebGL's default drawing buffer is discarded after composition: copy within onRender. */
function captureWebglFrame(term: ReplayPresentationTerminal): Promise<FrozenPresentation | null> {
  return new Promise(resolve => {
    let finished = false;
    let listener: { dispose(): void } | undefined;
    const capture = (fallback = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      listener?.dispose();
      resolve(freezePresentation(term, fallback));
    };
    const timeout = setTimeout(() => capture(true), 100);
    try {
      listener = term.onRender?.(() => capture());
      term.refresh?.(0, Math.max(0, (term.rows ?? 1) - 1));
    } catch (error) {
      console.warn("[terminal-replay] Could not request a WebGL frame", error);
      capture(true);
    }
  });
}

function replaceCanvasWithText(copy: HTMLElement, term: ReplayPresentationTerminal): void {
  const screen = copy.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return;
  const buffer = term.buffer.active;
  const pre = document.createElement("pre");
  pre.style.margin = "0";
  pre.style.fontFamily = term.options?.fontFamily ?? "monospace";
  pre.style.fontSize = `${term.options?.fontSize ?? 14}px`;
  pre.style.lineHeight = `${parseFloat(screen.style.height) / (term.rows ?? 1) || 17}px`;
  pre.style.color = term.options?.theme?.foreground ?? "var(--app-text-primary)";
  pre.textContent = Array.from({ length: term.rows ?? 1 }, (_, row) =>
    buffer.getLine?.((buffer.viewportY ?? 0) + row)?.translateToString(false) ?? "").join("\n");
  screen.replaceChildren(pre);
}

function preserveViewport(term: ReplayPresentationTerminal): () => void {
  const before = term.buffer.active;
  const line = before.viewportY ?? 0;
  const bufferType = before.type;
  const atBottom = line >= (before.baseY ?? 0);
  const anchor = before.getLine?.(line)?.translateToString(true);
  return () => {
    const after = term.buffer.active;
    if (atBottom || bufferType !== after.type) {
      term.scrollToBottom?.();
      return;
    }
    let restored = Math.min(line, after.baseY ?? line);
    // Prefer retained content if reconstruction changed the history length.
    if (anchor && after.getLine?.(restored)?.translateToString(true) !== anchor) {
      for (let row = after.baseY ?? 0; row >= 0; row--) {
        if (after.getLine?.(row)?.translateToString(true) === anchor) {
          restored = row;
          break;
        }
      }
    }
    term.scrollToLine?.(restored);
  };
}

/** Let xterm paint its final viewport before removing the static frame. */
function afterPaint(callback: () => void): Promise<void> {
  return new Promise((resolve) => {
    let frame: number | null = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      clearTimeout(timeout);
      callback();
      resolve();
    };
    // Background windows may stop rAF. Never hold recovery/output behind it.
    const timeout = setTimeout(finish, 100);
    if (document.visibilityState === "hidden") { finish(); return; }
    frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(finish); });
  });
}

async function finishPresentation(
  term: ReplayPresentationTerminal, presentation: FrozenPresentation, frame: CapturedFrame,
): Promise<void> {
  const { element, parent, copy, opacity, position, ariaBusy, restoreViewport } = frame;
  const version = presentation.version;
  const canRelease = () => presentation.depth === 0 && presentation.version === version;
  try {
    if (!element.isConnected) return;
    const layouts = [...presentation.layouts.values()];
    presentation.layouts.clear();
    layouts.forEach(apply => apply());
    restoreViewport();
    term.refresh?.(0, Math.max(0, (term.rows ?? 1) - 1));
    await afterPaint(() => {
      if (!canRelease()) return;
      element.style.opacity = opacity;
      copy.remove();
    });
  } catch (error) {
    console.warn("[terminal-replay] Could not restore the viewport", error);
  } finally {
    if (canRelease()) {
      presentations.delete(term);
      element.style.opacity = opacity;
      copy.remove();
      parent.style.position = position;
      if (ariaBusy === null) parent.removeAttribute("aria-busy");
      else parent.setAttribute("aria-busy", ariaBusy);
    }
  }
}

function freezePresentation(term: ReplayPresentationTerminal, textFallback = false): FrozenPresentation | null {
  const element = term.element;
  if (!element?.isConnected) return null;
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const parent = element.parentElement;
  if (!parent) return null;
  const copy = tryClonePaintedFrame(element);
  if (!copy) return null;
  if (textFallback) replaceCanvasWithText(copy, term);
  const frame: CapturedFrame = { element, parent, copy, restoreViewport: preserveViewport(term),
    opacity: element.style.opacity, position: parent.style.position, ariaBusy: parent.getAttribute("aria-busy") };
  if (window.getComputedStyle(parent).position === "static") parent.style.position = "relative";
  parent.appendChild(copy);
  parent.setAttribute("aria-busy", "true");
  element.style.opacity = "0";
  const presentation: FrozenPresentation = { depth: 0, version: 0, layouts: new Map(),
    hide: () => { element.style.opacity = "0"; }, finish: () => finishPresentation(term, presentation, frame) };
  return presentation;
}

/** Nestable: desync stays frozen through snapshot, delta and queued live-output draining. */
export async function withTerminalReplayPresentation<T>(
  term: ReplayPresentationTerminal,
  replay: () => Promise<T>,
): Promise<T> {
  let presentation = presentations.get(term);
  if (!presentation) {
    let captured: FrozenPresentation | null;
    if (term.onRender && term.element?.querySelector("canvas")) {
      const pending = preparations.get(term) ?? captureWebglFrame(term);
      preparations.set(term, pending);
      captured = await pending;
      preparations.delete(term);
    } else captured = freezePresentation(term);
    presentation = presentations.get(term) ?? captured ?? undefined;
    if (presentation) presentations.set(term, presentation);
  }
  if (presentation) {
    presentation.depth += 1;
    presentation.version += 1;
    presentation.hide();
  }
  try {
    return await replay();
  } finally {
    if (presentation && --presentation.depth === 0) {
      await presentation.finish();
    }
  }
}

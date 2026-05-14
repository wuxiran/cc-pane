import type { Terminal } from "@xterm/xterm";
import { summarizeTerminalInputData, type TerminalInputTraceLogger } from "./terminalInputTrace";

const SELECTION_SPACE_SUPPRESS_MS = 250;
const SELECTION_SPACE_FOLLOWUP_SUPPRESS_MS = 100;
const SKIPPED_COMPOSITION_KEYDOWN_MS = 1000;

type TerminalInputTarget = Pick<Terminal, "input">;

interface TerminalImeGuardOptions {
  textarea: HTMLTextAreaElement;
  terminal: TerminalInputTarget;
  enabled?: boolean;
  logger?: TerminalInputTraceLogger;
  now?: () => number;
}

export interface TerminalImeGuardController {
  dispose: () => void;
  handleKeyEvent: (event: KeyboardEvent) => boolean;
}

export function isLinuxWebKitImeEnvironment(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return (
    /Linux/i.test(platform) &&
    /AppleWebKit/i.test(userAgent) &&
    !/(Chrome|Chromium|CriOS|Edg|Firefox)/i.test(userAgent)
  );
}

function isInsertFromComposition(event: InputEvent): boolean {
  return event.inputType === "insertFromComposition" && Boolean(event.data);
}

function isSpaceKey(event: KeyboardEvent): boolean {
  return event.key === " " || event.key === "Spacebar";
}

function isSpaceText(data: string | null): boolean {
  return data === " " || data === "\u00a0";
}

function hasTrailingSelectionSpace(data: string, textareaValue: string): boolean {
  if (!data || !textareaValue) return false;
  const trimmed = textareaValue.replace(/[ \u00a0]+$/u, "");
  return trimmed.length < textareaValue.length && trimmed.endsWith(data);
}

function isImeProcessKey(event: KeyboardEvent): boolean {
  return event.keyCode === 229 || event.key === "Unidentified";
}

function stopEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function clearTextarea(textarea: HTMLTextAreaElement): void {
  textarea.value = "";
  try {
    textarea.setSelectionRange(0, 0);
  } catch {
    // Hidden xterm helper textarea may reject selection changes on some WebViews.
  }
}

function eventPayload(event: InputEvent | CompositionEvent | KeyboardEvent, textarea: HTMLTextAreaElement): Record<string, unknown> {
  const inputEvent = event instanceof InputEvent ? event : null;
  const compositionEvent = event instanceof CompositionEvent ? event : null;
  const keyboardEvent = event instanceof KeyboardEvent ? event : null;
  return {
    type: event.type,
    inputType: inputEvent?.inputType,
    key: keyboardEvent?.key,
    keyCode: keyboardEvent?.keyCode,
    data: summarizeTerminalInputData(inputEvent?.data ?? compositionEvent?.data),
    isComposing: inputEvent?.isComposing ?? keyboardEvent?.isComposing,
    textarea: {
      value: summarizeTerminalInputData(textarea.value),
      valueLength: textarea.value.length,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    },
  };
}

function noopController(): TerminalImeGuardController {
  return {
    dispose: () => {},
    handleKeyEvent: () => true,
  };
}

export function attachTerminalImeGuard(options: TerminalImeGuardOptions): TerminalImeGuardController {
  if (!options.enabled) return noopController();

  const { textarea, terminal } = options;
  const now = options.now ?? (() => performance.now());
  const log = (event: string, payload: Record<string, unknown> = {}) => {
    options.logger?.(`ime-guard.${event}`, payload);
  };

  const cleanups: Array<() => void> = [];
  let sawCompositionStart = false;
  let handledMalformedComposition = false;
  let handledSkippedKeydownText = false;
  let skippedCompositionKeydownUntil = 0;
  let suppressSelectionSpaceUntil = 0;
  const handledEvents = new WeakSet<Event>();

  const addListener = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ) => {
    const wrapped = (event: Event) => {
      if (event.target !== textarea || handledEvents.has(event)) return;
      handledEvents.add(event);
      handler(event as HTMLElementEventMap[K]);
    };

    // The document capture listener runs before xterm's target capture listener.
    // Keep the target listener too, so detached textarea tests and unusual DOM paths
    // still exercise the same guard logic.
    const ownerDocument = textarea.ownerDocument;
    ownerDocument.addEventListener(type, wrapped, true);
    textarea.addEventListener(type, wrapped, true);
    cleanups.push(() => ownerDocument.removeEventListener(type, wrapped, true));
    cleanups.push(() => textarea.removeEventListener(type, wrapped, true));
  };

  const shouldSuppressSelectionSpace = () => suppressSelectionSpaceUntil > 0 && now() <= suppressSelectionSpaceUntil;
  const hasFreshSkippedCompositionKeydown = () => now() <= skippedCompositionKeydownUntil;

  const markMalformedCompositionHandled = (event: InputEvent, source: "beforeinput" | "input") => {
    const data = event.data ?? "";
    const shouldSuppressSelectionSpaceAfterForward = hasTrailingSelectionSpace(data, textarea.value);
    handledMalformedComposition = true;
    handledSkippedKeydownText = false;
    skippedCompositionKeydownUntil = 0;
    suppressSelectionSpaceUntil = shouldSuppressSelectionSpaceAfterForward
      ? now() + SELECTION_SPACE_SUPPRESS_MS
      : 0;
    stopEvent(event);
    terminal.input(data, true);
    clearTextarea(textarea);
    log("malformed-composition.forwarded", {
      source,
      forwarded: summarizeTerminalInputData(data),
      shouldSuppressSelectionSpaceAfterForward,
      suppressSelectionSpaceUntil,
      event: eventPayload(event, textarea),
    });
  };

  const markSkippedKeydownTextHandled = (event: InputEvent, source: "beforeinput" | "input") => {
    const data = event.data ?? "";
    handledSkippedKeydownText = true;
    skippedCompositionKeydownUntil = 0;
    stopEvent(event);
    terminal.input(data, true);
    clearTextarea(textarea);
    log("skipped-keydown-text.forwarded", {
      source,
      forwarded: summarizeTerminalInputData(data),
      event: eventPayload(event, textarea),
    });
  };

  const maybeSuppressSelectionSpaceInput = (event: InputEvent, source: "beforeinput" | "input"): boolean => {
    if (
      event.inputType !== "insertText" ||
      !isSpaceText(event.data) ||
      !shouldSuppressSelectionSpace()
    ) {
      return false;
    }

    stopEvent(event);
    clearTextarea(textarea);
    suppressSelectionSpaceUntil = 0;
    log("selection-space.suppressed", {
      source,
      event: eventPayload(event, textarea),
    });
    return true;
  };

  addListener("compositionstart", (event) => {
    sawCompositionStart = true;
    handledMalformedComposition = false;
    handledSkippedKeydownText = false;
    skippedCompositionKeydownUntil = 0;
    log("compositionstart", eventPayload(event as CompositionEvent, textarea));
  });

  addListener("beforeinput", (event) => {
    const inputEvent = event as InputEvent;
    if (maybeSuppressSelectionSpaceInput(inputEvent, "beforeinput")) return;

    if (
      hasFreshSkippedCompositionKeydown() &&
      inputEvent.inputType === "insertText" &&
      Boolean(inputEvent.data)
    ) {
      markSkippedKeydownTextHandled(inputEvent, "beforeinput");
      return;
    }

    if (!sawCompositionStart && isInsertFromComposition(inputEvent)) {
      markMalformedCompositionHandled(inputEvent, "beforeinput");
    }
  });

  addListener("input", (event) => {
    const inputEvent = event as InputEvent;
    if (maybeSuppressSelectionSpaceInput(inputEvent, "input")) return;

    if (handledSkippedKeydownText && inputEvent.inputType === "insertText") {
      stopEvent(inputEvent);
      clearTextarea(textarea);
      log("skipped-keydown-text.input-cleared", eventPayload(inputEvent, textarea));
      return;
    }

    if (handledMalformedComposition && inputEvent.inputType === "insertFromComposition") {
      stopEvent(inputEvent);
      clearTextarea(textarea);
      log("malformed-composition.input-cleared", eventPayload(inputEvent, textarea));
      return;
    }

    if (!sawCompositionStart && isInsertFromComposition(inputEvent)) {
      markMalformedCompositionHandled(inputEvent, "input");
    }
  });

  addListener("compositionend", (event) => {
    if (handledMalformedComposition) {
      stopEvent(event);
      clearTextarea(textarea);
      log("compositionend.suppressed", eventPayload(event as CompositionEvent, textarea));
    }
    sawCompositionStart = false;
    handledMalformedComposition = false;
    handledSkippedKeydownText = false;
    skippedCompositionKeydownUntil = 0;
  });

  log("enabled", {
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  });

  return {
    dispose: () => {
      while (cleanups.length > 0) {
        cleanups.pop()?.();
      }
      log("disposed", {});
    },
    handleKeyEvent: (event: KeyboardEvent) => {
      if (
        event.type === "keydown" &&
        !sawCompositionStart &&
        isImeProcessKey(event) &&
        textarea.value.length > 0
      ) {
        skippedCompositionKeydownUntil = now() + SKIPPED_COMPOSITION_KEYDOWN_MS;
        log("composition-keydown.skipped", {
          skippedCompositionKeydownUntil,
          event: eventPayload(event, textarea),
        });
        return false;
      }

      if (
        (event.type === "keydown" || event.type === "keypress") &&
        isSpaceKey(event) &&
        shouldSuppressSelectionSpace()
      ) {
        stopEvent(event);
        clearTextarea(textarea);
        suppressSelectionSpaceUntil = now() + SELECTION_SPACE_FOLLOWUP_SUPPRESS_MS;
        log("selection-space.key-suppressed", eventPayload(event, textarea));
        return false;
      }
      return true;
    },
  };
}

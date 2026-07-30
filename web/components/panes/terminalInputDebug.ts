import { summarizeTerminalInputData } from "./terminalInputTrace";

function keyboardDebugPayload(
  event: KeyboardEvent,
  textarea: HTMLTextAreaElement,
): Record<string, unknown> {
  return {
    type: event.type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    repeat: event.repeat,
    isComposing: event.isComposing,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    defaultPrevented: event.defaultPrevented,
    textareaValue: summarizeTerminalInputData(textarea.value),
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
  };
}

function inputDebugPayload(
  event: InputEvent,
  textarea: HTMLTextAreaElement,
): Record<string, unknown> {
  return {
    type: event.type,
    inputType: event.inputType,
    data: summarizeTerminalInputData(event.data),
    isComposing: event.isComposing,
    defaultPrevented: event.defaultPrevented,
    textareaValue: summarizeTerminalInputData(textarea.value),
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
  };
}

function compositionDebugPayload(
  event: CompositionEvent,
  textarea: HTMLTextAreaElement,
): Record<string, unknown> {
  return {
    type: event.type,
    data: summarizeTerminalInputData(event.data),
    defaultPrevented: event.defaultPrevented,
    textareaValue: summarizeTerminalInputData(textarea.value),
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
  };
}

export function attachTerminalInputDebugLog(
  textarea: HTMLTextAreaElement,
  logger: (event: string, payload?: Record<string, unknown>) => void,
  nextSeq: () => number,
): () => void {
  const cleanups: Array<() => void> = [];
  const add = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ) => {
    textarea.addEventListener(type, handler as EventListener, true);
    cleanups.push(() => textarea.removeEventListener(type, handler as EventListener, true));
  };

  add("keydown", (event) => {
    logger("input.dom.keydown", {
      traceSeq: nextSeq(),
      ...keyboardDebugPayload(event as KeyboardEvent, textarea),
    });
  });
  add("beforeinput", (event) => {
    logger("input.dom.beforeinput", {
      traceSeq: nextSeq(),
      ...inputDebugPayload(event as InputEvent, textarea),
    });
  });
  add("input", (event) => {
    logger("input.dom.input", {
      traceSeq: nextSeq(),
      ...inputDebugPayload(event as InputEvent, textarea),
    });
  });
  add("compositionstart", (event) => {
    logger("input.dom.compositionstart", {
      traceSeq: nextSeq(),
      ...compositionDebugPayload(event as CompositionEvent, textarea),
    });
  });
  add("compositionupdate", (event) => {
    logger("input.dom.compositionupdate", {
      traceSeq: nextSeq(),
      ...compositionDebugPayload(event as CompositionEvent, textarea),
    });
  });
  add("compositionend", (event) => {
    logger("input.dom.compositionend", {
      traceSeq: nextSeq(),
      ...compositionDebugPayload(event as CompositionEvent, textarea),
    });
  });

  return () => {
    while (cleanups.length > 0) cleanups.pop()?.();
  };
}

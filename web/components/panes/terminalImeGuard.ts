type ImeLogger = (event: string, payload?: Record<string, unknown>) => void;

interface PendingCommit {
  text: string;
  forwarded: boolean;
  expiresAt: number;
  serial: number;
  order: number;
  source: string;
}

interface RecentData {
  text: string;
  expiresAt: number;
  serial: number;
}

interface ImeInputLike {
  data: string | null;
  inputType: string;
  isComposing: boolean;
}

interface ImeCompositionLike {
  data: string;
}

export interface TerminalImeGuard {
  beforeInput: (event: ImeInputLike) => void;
  input: (event: ImeInputLike) => void;
  compositionStart: () => void;
  compositionEnd: (event: ImeCompositionLike) => void;
  filterData: (data: string) => string;
}

export interface TerminalImeGuardController {
  dispose: () => void;
  filterData: (data: string) => string;
}

interface TerminalImeGuardOptions {
  enabled: boolean;
  now?: () => number;
  logger?: ImeLogger;
}

interface AttachTerminalImeGuardOptions extends TerminalImeGuardOptions {
  textarea?: HTMLTextAreaElement | null;
}

const DUPLICATE_WINDOW_MS = 250;
const RECENT_DATA_WINDOW_MS = 250;
const FORWARDED_TEXT_HISTORY_LIMIT = 512;

function getNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function isTrackableInput(event: ImeInputLike): boolean {
  return (
    event.inputType === "insertText" ||
    event.inputType === "insertCompositionText"
  );
}

function hasNonAsciiText(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

function isPlainPrintableText(text: string): boolean {
  return text.length > 0 && !/[\x00-\x1F\x7F]/.test(text);
}

function limitTextHistory(text: string): string {
  return Array.from(text).slice(-FORWARDED_TEXT_HISTORY_LIMIT).join("");
}

export function createTerminalImeGuard({
  enabled,
  now = getNow,
  logger,
}: TerminalImeGuardOptions): TerminalImeGuard {
  let compositionSerial = 0;
  let isComposing = false;
  let recentCompositionUntil = 0;
  let nextOrder = 0;
  let pendingCommits: PendingCommit[] = [];
  let recentData: RecentData[] = [];
  let forwardedTextHistory = "";

  const purge = (timestamp: number) => {
    pendingCommits = pendingCommits.filter(
      (candidate) =>
        candidate.serial === compositionSerial &&
        candidate.expiresAt >= timestamp,
    );
    recentData = recentData.filter(
      (item) =>
        item.serial === compositionSerial &&
        item.expiresAt >= timestamp,
    );
  };

  const hasRecentForwardedText = (text: string, timestamp: number) => {
    purge(timestamp);
    const combined = recentData.map((item) => item.text).join("");
    return (
      recentData.some((item) => item.text === text || item.text.startsWith(text)) ||
      combined.endsWith(text)
    );
  };

  const markPendingFromRecentData = (timestamp: number) => {
    for (const candidate of pendingCommits) {
      if (!candidate.forwarded && hasRecentForwardedText(candidate.text, timestamp)) {
        candidate.forwarded = true;
      }
    }
  };

  const rememberData = (data: string, timestamp: number) => {
    if (!data) return;
    recentData.push({
      text: data,
      expiresAt: timestamp + RECENT_DATA_WINDOW_MS,
      serial: compositionSerial,
    });
    markPendingFromRecentData(timestamp);
  };

  const rememberForwardedText = (data: string) => {
    if (!isPlainPrintableText(data)) return;
    forwardedTextHistory = limitTextHistory(`${forwardedTextHistory}${data}`);
  };

  const findCumulativeSuffix = (data: string) => {
    if (!data || !forwardedTextHistory) return null;

    const maxPrefixLength = Math.min(data.length - 1, forwardedTextHistory.length);
    for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
      const prefix = data.slice(0, prefixLength);
      if (!forwardedTextHistory.endsWith(prefix)) continue;

      const suffix = data.slice(prefixLength);
      if (suffix && hasNonAsciiText(suffix)) {
        return {
          prefixLength,
          suffix,
        };
      }
    }

    return null;
  };

  const trimCumulativeData = (data: string) => {
    if (!isComposing && now() > recentCompositionUntil && pendingCommits.length === 0) {
      return null;
    }
    return findCumulativeSuffix(data);
  };

  const findCandidateSuffix = (data: string) => {
    if (!data) return null;
    return pendingCommits
      .filter((item) => item.text !== data && item.text.endsWith(data))
      .sort((a, b) => b.order - a.order)[0] ?? null;
  };

  const recordCommitCandidate = (text: string | null, source: string) => {
    if (!enabled || !text) return;

    const timestamp = now();
    purge(timestamp);
    const forwarded = hasRecentForwardedText(text, timestamp);
    const existing = pendingCommits.find(
      (candidate) =>
        candidate.serial === compositionSerial &&
        candidate.text === text,
    );

    if (existing) {
      existing.forwarded = existing.forwarded || forwarded;
      existing.expiresAt = timestamp + DUPLICATE_WINDOW_MS;
      existing.order = ++nextOrder;
      existing.source = source;
      return;
    }

    pendingCommits.unshift({
      text,
      forwarded,
      expiresAt: timestamp + DUPLICATE_WINDOW_MS,
      serial: compositionSerial,
      order: ++nextOrder,
      source,
    });
  };

  const trackInputCandidate = (event: ImeInputLike, source: string) => {
    if (!enabled || !event.data || !isTrackableInput(event)) return;

    const timestamp = now();
    if (
      isComposing ||
      event.isComposing ||
      (timestamp <= recentCompositionUntil && hasNonAsciiText(event.data)) ||
      event.inputType === "insertCompositionText"
    ) {
      recordCommitCandidate(event.data, source);
    }
  };

  return {
    beforeInput: (event) => trackInputCandidate(event, "beforeinput"),
    input: (event) => trackInputCandidate(event, "input"),
    compositionStart: () => {
      if (!enabled) return;
      compositionSerial += 1;
      isComposing = true;
      recentCompositionUntil = 0;
      pendingCommits = [];
      recentData = [];
    },
    compositionEnd: (event) => {
      if (!enabled) return;
      const timestamp = now();
      isComposing = false;
      recentCompositionUntil = timestamp + DUPLICATE_WINDOW_MS;
      recordCommitCandidate(event.data, "compositionend");
    },
    filterData: (data) => {
      if (!enabled || !data) return data;

      const timestamp = now();
      purge(timestamp);
      markPendingFromRecentData(timestamp);
      const cumulative = trimCumulativeData(data);

      const candidate = pendingCommits
        .filter((item) => data === item.text || data.startsWith(item.text))
        .sort((a, b) => b.order - a.order)[0];

      if (!candidate) {
        const suffixCandidate = findCandidateSuffix(data);
        if (suffixCandidate) {
          if (suffixCandidate.forwarded || hasRecentForwardedText(suffixCandidate.text, timestamp)) {
            pendingCommits = pendingCommits.filter((item) => item !== suffixCandidate);
            logger?.("ime.suffix.drop", {
              source: suffixCandidate.source,
              dataLength: data.length,
              candidateLength: suffixCandidate.text.length,
            });
            return "";
          }

          suffixCandidate.forwarded = true;
          suffixCandidate.expiresAt = timestamp + DUPLICATE_WINDOW_MS;
          logger?.("ime.suffix.restore", {
            source: suffixCandidate.source,
            dataLength: data.length,
            candidateLength: suffixCandidate.text.length,
          });
          rememberData(suffixCandidate.text, timestamp);
          rememberForwardedText(suffixCandidate.text);
          return suffixCandidate.text;
        }

        const filteredData = cumulative?.suffix ?? data;
        if (cumulative) {
          logger?.("ime.cumulative.trim", {
            originalLength: data.length,
            prefixLength: cumulative.prefixLength,
            suffixLength: filteredData.length,
          });
        }
        rememberData(filteredData, timestamp);
        rememberForwardedText(filteredData);
        return filteredData;
      }

      if (!candidate.forwarded) {
        candidate.forwarded = true;
        candidate.expiresAt = timestamp + DUPLICATE_WINDOW_MS;
        const filteredData = cumulative?.suffix ?? data;
        if (cumulative) {
          logger?.("ime.cumulative.trim", {
            source: candidate.source,
            originalLength: data.length,
            prefixLength: cumulative.prefixLength,
            suffixLength: filteredData.length,
          });
        }
        rememberData(filteredData, timestamp);
        rememberForwardedText(filteredData);
        return filteredData;
      }

      pendingCommits = pendingCommits.filter((item) => item !== candidate);
      if (cumulative) {
        if (hasRecentForwardedText(cumulative.suffix, timestamp)) {
          logger?.("ime.cumulative.drop", {
            source: candidate.source,
            originalLength: data.length,
            prefixLength: cumulative.prefixLength,
            suffixLength: cumulative.suffix.length,
          });
          return "";
        }

        logger?.("ime.cumulative.trim", {
          source: candidate.source,
          originalLength: data.length,
          prefixLength: cumulative.prefixLength,
          suffixLength: cumulative.suffix.length,
        });
        rememberData(cumulative.suffix, timestamp);
        rememberForwardedText(cumulative.suffix);
        return cumulative.suffix;
      }

      if (hasRecentForwardedText(data, timestamp)) {
        logger?.("ime.duplicate.drop", {
          source: candidate.source,
          length: data.length,
        });
        return "";
      }

      if (data === candidate.text) {
        logger?.("ime.duplicate.drop", {
          source: candidate.source,
          length: data.length,
        });
        return "";
      }

      const suffix = data.slice(candidate.text.length);
      logger?.("ime.duplicate.trim", {
        source: candidate.source,
        originalLength: data.length,
        duplicateLength: candidate.text.length,
        suffixLength: suffix.length,
      });
      rememberData(suffix, timestamp);
      rememberForwardedText(suffix);
      return suffix;
    },
  };
}

function noopController(): TerminalImeGuardController {
  return {
    dispose: () => {},
    filterData: (data) => data,
  };
}

export function attachTerminalImeGuard({
  textarea,
  enabled,
  now,
  logger,
}: AttachTerminalImeGuardOptions): TerminalImeGuardController {
  if (!enabled || !textarea) return noopController();

  const guard = createTerminalImeGuard({ enabled, now, logger });
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let compositionEpoch = 0;
  let resetTimers: Array<ReturnType<typeof setTimeout>> = [];

  const scheduleTimer = (callback: () => void) => {
    let timerId: ReturnType<typeof setTimeout>;
    timerId = setTimeout(() => {
      resetTimers = resetTimers.filter((item) => item !== timerId);
      callback();
    }, 0);
    resetTimers.push(timerId);
  };

  const scheduleTextareaResetAfterXterm = () => {
    const epoch = compositionEpoch;
    scheduleTimer(() => {
      scheduleTimer(() => {
        if (disposed || compositionEpoch !== epoch || !textarea.value) return;
        logger?.("ime.textarea.clear", { valueLength: textarea.value.length });
        textarea.value = "";
      });
    });
  };

  const addListener = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ) => {
    textarea.addEventListener(type, handler as EventListener, true);
    cleanups.push(() => textarea.removeEventListener(type, handler as EventListener, true));
  };

  addListener("compositionstart", () => {
    compositionEpoch += 1;
    guard.compositionStart();
  });
  addListener("compositionend", (event) => {
    guard.compositionEnd(event as CompositionEvent);
    scheduleTextareaResetAfterXterm();
  });
  addListener("beforeinput", (event) => {
    guard.beforeInput(event as InputEvent);
  });
  addListener("input", (event) => {
    guard.input(event as InputEvent);
  });

  logger?.("ime.guard.enabled", {});

  return {
    dispose: () => {
      disposed = true;
      while (resetTimers.length > 0) {
        clearTimeout(resetTimers.pop());
      }
      while (cleanups.length > 0) {
        cleanups.pop()?.();
      }
      logger?.("ime.guard.disposed", {});
    },
    filterData: guard.filterData,
  };
}

import { useCallback, useRef } from "react";

const RESET_MS = 700;

/**
 * 在 labels 里找下一个匹配项。单字符连按时从当前项之后循环（与原生列表一致），
 * 多字符时从当前项开始匹配，这样继续输入不会跳走。
 */
export function matchTypeAhead(labels: readonly string[], query: string, currentIndex: number): number {
  if (!query || labels.length === 0) return -1;
  const normalized = query.toLocaleLowerCase();
  const repeated = [...normalized].every((char) => char === normalized[0]);
  const needle = repeated ? normalized[0] : normalized;
  const start = repeated ? currentIndex + 1 : Math.max(currentIndex, 0);
  for (let offset = 0; offset < labels.length; offset += 1) {
    const index = (start + offset) % labels.length;
    if (labels[index].trim().toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/** 是否应作为 type-ahead 输入：单个可打印字符、无修饰键、不在输入控件内、不在输入法组合中。 */
export function isTypeAheadKey(event: React.KeyboardEvent): boolean {
  if (event.key.length !== 1 || event.key === " ") return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return false;
  const target = event.target as HTMLElement;
  return !target.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable=''], .xterm");
}

/** 列表 type-ahead：键入字母跳到匹配项。 */
export function useTypeAhead(options: {
  getLabels: () => readonly string[];
  getCurrentIndex: () => number;
  onMatch: (index: number) => void;
}) {
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(options);
  latest.current = options;

  return useCallback((event: React.KeyboardEvent) => {
    if (!isTypeAheadKey(event)) return;
    buffer.current += event.key;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { buffer.current = ""; }, RESET_MS);
    const { getLabels, getCurrentIndex, onMatch } = latest.current;
    const index = matchTypeAhead(getLabels(), buffer.current, getCurrentIndex());
    if (index >= 0) {
      event.preventDefault();
      event.stopPropagation();
      onMatch(index);
    }
  }, []);
}

const ROW_SELECTOR = "[data-typeahead-label]";

/** DOM 行版本：容器内带 data-typeahead-label 的可聚焦行。 */
export function useRowTypeAhead() {
  const rows = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter((row) => row.offsetParent !== null || row.getClientRects().length > 0);
  const containerRef = useRef<HTMLElement | null>(null);
  const handler = useTypeAhead({
    getLabels: () => (containerRef.current ? rows(containerRef.current).map((row) => row.dataset.typeaheadLabel ?? "") : []),
    getCurrentIndex: () => {
      const container = containerRef.current;
      if (!container) return -1;
      const active = document.activeElement?.closest?.(ROW_SELECTOR);
      return active ? rows(container).indexOf(active as HTMLElement) : -1;
    },
    onMatch: (index) => {
      const row = containerRef.current ? rows(containerRef.current)[index] : null;
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    },
  });
  return useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    containerRef.current = event.currentTarget;
    handler(event);
  }, [handler]);
}

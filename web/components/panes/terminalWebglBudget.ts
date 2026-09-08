export const MAX_TERMINAL_WEBGL_CONTEXTS = 8;

/** One pool per WebView. Waiting controllers never create an extra context. */
export function createTerminalWebglBudget(limit = MAX_TERMINAL_WEBGL_CONTEXTS) {
  type Entry = { grant: () => void; visible: () => boolean; revoke?: () => void };
  const active = new Map<object, Entry>();
  const waiting = new Map<object, Entry>();
  let scheduled = false;
  const drain = () => {
    scheduled = false;
    const queue = [...waiting].sort((a, b) => Number(b[1].visible()) - Number(a[1].visible()));
    for (const [owner, entry] of queue) {
      if (active.size >= limit) break;
      if (!waiting.delete(owner)) continue;
      entry.grant();
    }
  };
  return {
    acquire(owner: object, grant: () => void, visible: () => boolean, revoke?: () => void): boolean {
      if (active.has(owner)) return true;
      // A rapid layout cycle can revisit hidden panes before their debounce
      // expires. Visible panes must reclaim those leases instead of staying DOM.
      if (active.size >= limit && visible()) {
        const victim = [...active].find(([, entry]) => !entry.visible());
        if (victim) {
          active.delete(victim[0]);
          victim[1].revoke?.();
          waiting.set(victim[0], victim[1]);
        }
      }
      if (active.size >= limit) { waiting.set(owner, { grant, visible, revoke }); return false; }
      waiting.delete(owner);
      active.set(owner, { grant, visible, revoke });
      return true;
    },
    release(owner: object): void {
      waiting.delete(owner);
      active.delete(owner);
      if (!scheduled && waiting.size > 0) { scheduled = true; queueMicrotask(drain); }
    },
    count: () => active.size,
  };
}

export const terminalWebglBudget = createTerminalWebglBudget();

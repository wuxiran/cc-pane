(request) => {
  const key = "__ccpanesComputerUseV1";
  const visible = (element) => {
    if (!element.isConnected || element.closest("[hidden],[aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  };
  const clean = (value, limit = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const editableContent = (element) => {
    const attribute = element.closest("[contenteditable]")?.getAttribute("contenteditable");
    return element.isContentEditable === true || (attribute !== undefined && attribute !== null && attribute !== "false");
  };
  const disabled = (element) => Boolean(element.disabled || element.matches(":disabled") || element.getAttribute("aria-disabled") === "true");
  const canFill = (element) => {
    if (disabled(element) || element.readOnly) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === "input") return ["text", "search", "email", "url", "tel", "password"].includes(element.type);
    return tag === "textarea" || editableContent(element);
  };
  // Interactive ancestors and labels may wrap editors. Reading their innerText
  // would reintroduce values excluded from the field's own snapshot entry.
  const safeText = (root, limit = 180) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let length = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,noscript,input,textarea,select,[contenteditable]") || !visible(parent)) continue;
      const text = clean(node.textContent, limit - length);
      if (!text) continue;
      parts.push(text); length += text.length + 1;
      if (length >= limit) break;
    }
    return clean(parts.join(" "), limit);
  };
  let state = window[key];
  if (request.action === "snapshot") {
    if (!state || state.document !== document) {
      state = { document, documentId: request.pageToken, ids: new WeakMap(), nextId: 1 };
      Object.defineProperty(window, key, { value: state, configurable: true });
    }
    state.token = request.pageToken;
    state.url = location.href;
    state.elements = new Map();
    const elements = [];
    let truncated = false;
    const selector = "a[href],button,input:not([type='hidden']),textarea,select,[role='button'],[role='link'],[role='checkbox'],[role='textbox'],[contenteditable]:not([contenteditable='false']),[tabindex]";
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element)) continue;
      if (elements.length >= 120) { truncated = true; break; }
      if (!state.ids.has(element)) state.ids.set(element, state.nextId++);
      const id = state.ids.get(element);
      state.elements.set(id, element);
      const rect = element.getBoundingClientRect();
      const tag = element.tagName.toLowerCase();
      const text = ["input", "textarea", "select"].includes(tag) || editableContent(element) ? "" : safeText(element);
      const labels = element.labels ? [...element.labels].map(label => safeText(label, 120)).join(" ") : "";
      const name = clean(element.getAttribute("aria-label") || labels || element.getAttribute("title") || element.getAttribute("placeholder") || text, 120);
      elements.push({ id, tag, role: element.getAttribute("role") || tag, name, text,
        disabled: disabled(element),
        editable: canFill(element),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    const texts = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let length = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,noscript,input,textarea,select,[contenteditable]") || !visible(parent)) continue;
      const text = clean(node.textContent, 1000);
      if (!text) continue;
      texts.push(text); length += text.length;
      if (length >= 8000) { truncated = true; break; }
    }
    const result = { pageToken: state.token, documentId: state.documentId, url: location.href, title: clean(document.title, 300),
      text: texts.join("\n").slice(0, 8000), elements, truncated, viewport: { width: innerWidth, height: innerHeight } };
    while (new TextEncoder().encode(JSON.stringify(result)).length > 42000 && result.elements.length) {
      state.elements.delete(result.elements.pop().id); result.truncated = true;
    }
    return result;
  }
  const current = () => state && window[key] === state && state.document === document && request.pageToken && state.token === request.pageToken && state.url === location.href;
  const stale = () => ({ error: "Stale browser snapshot; take a new snapshot before acting" });
  if (!current()) return stale();
  if (request.action === "validate") return { success: true };
  if (request.action === "scroll") {
    window.scrollBy({ left: request.deltaX, top: request.deltaY, behavior: "instant" });
    if (!current()) return stale();
    return { success: true };
  }
  const element = state.elements.get(request.elementId);
  if (!element || !visible(element)) return { error: "Observed browser element is no longer available; take a new snapshot" };
  if (disabled(element)) return { error: "Browser element is disabled" };
  if (request.action === "focus-fill") {
    if (!canFill(element)) return { error: "Browser element is not an editable text field" };
    element.focus();
    if (document.activeElement !== element) return { error: "Browser field could not be focused" };
    if (editableContent(element)) {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    } else element.select();
    if (!current()) return stale();
    if (document.activeElement !== element || !visible(element) || !canFill(element)) return { error: "Browser field changed while preparing input; take a new snapshot" };
    return { success: true };
  }
  if (request.action === "click-point") {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (!current()) return stale();
    if (!visible(element)) return { error: "Observed browser element is no longer available; take a new snapshot" };
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) return { error: "Browser element is covered by another element" };
    if (!current()) return stale();
    return { x, y };
  }
  return { error: "Unsupported browser action" };
}

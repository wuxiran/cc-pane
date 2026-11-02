import { beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../src-tauri/src/services/browser_service/computer_use.js?raw";
import type { BrowserPageSnapshot } from "./browserService";

const run = new Function("request", `return (${source})(request);`) as (request: Record<string, unknown>) => BrowserPageSnapshot & { error?: string; success?: boolean; x?: number };
const snapshot = (pageToken = "page-one") => run({ action: "snapshot", pageToken });

beforeEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__ccpanesComputerUseV1");
  window.history.replaceState({}, "", "/");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50, toJSON() {} });
  Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollBy = vi.fn();
});

describe("production browser Computer Use page script", () => {
  it("excludes every form value, editable content, hidden controls and hidden text", () => {
    document.body.innerHTML = `<p>Visible page</p><input aria-label="Account" value="private-token"><input type="password" value="secret-password"><input type="hidden" value="hidden-secret"><textarea>secret-textarea</textarea><div contenteditable="true">secret-editor</div><p hidden>Hidden text</p><button>Continue</button>`;
    const result = snapshot();
    const serialized = JSON.stringify(result);
    for (const secret of ["private-token", "secret-password", "hidden-secret", "secret-textarea", "secret-editor", "Hidden text"]) expect(serialized).not.toContain(secret);
    expect(result.text).toContain("Visible page");
    expect(result.elements.some((element) => element.name === "Continue")).toBe(true);
    expect(result.elements.every((element) => !("value" in element))).toBe(true);
  });

  it("keeps element numbers stable but invalidates the previous snapshot token", () => {
    document.body.innerHTML = "<button>Continue</button>";
    const first = snapshot("first");
    const next = snapshot("next");
    expect(first.elements[0].id).toBe(next.elements[0].id);
    expect(first.documentId).toBe(next.documentId);
    expect(run({ action: "validate", pageToken: "first" }).error).toContain("Stale");
    expect(run({ action: "validate", pageToken: "next" }).success).toBe(true);
  });

  it("changes document identity after a same-URL document replacement", () => {
    const first = snapshot("before-reload");
    Reflect.deleteProperty(window, "__ccpanesComputerUseV1");
    const next = snapshot("after-reload");
    expect(next.url).toBe(first.url);
    expect(next.documentId).not.toBe(first.documentId);
  });

  it("redacts editor and field contents from interactive ancestors and wrapping labels", () => {
    document.body.innerHTML = `<div role="button">Editor tools<div contenteditable="true">private-editor-text</div></div>
      <div tabindex="0">Form controls<textarea>private-textarea-text</textarea><select><option>private-selection</option></select></div>
      <label for="account">Account<span contenteditable="true">private-label-editor</span><textarea>private-label-textarea</textarea></label><input id="account">`;
    const page = snapshot();
    for (const secret of ["private-editor-text", "private-textarea-text", "private-selection", "private-label-editor", "private-label-textarea"]) {
      expect(JSON.stringify(page)).not.toContain(secret);
    }
    expect(page.elements.find((element) => element.role === "button")?.name).toBe("Editor tools");
    expect(page.elements.find((element) => element.tag === "input")?.name).toBe("Account");
  });

  it("rejects navigation caused by focus or scroll before returning a native action target", () => {
    document.body.innerHTML = "<input><button>Continue</button>";
    const first = snapshot();
    document.querySelector("input")!.addEventListener("focus", () => window.history.pushState({}, "", "/focus-redirect"));
    expect(run({ action: "focus-fill", pageToken: first.pageToken, elementId: first.elements[0].id }).error).toContain("Stale");
    const next = snapshot("next");
    document.querySelector("button")!.scrollIntoView = () => window.history.pushState({}, "", "/scroll-redirect");
    expect(run({ action: "click-point", pageToken: next.pageToken, elementId: next.elements[1].id }).error).toContain("Stale");
  });

  it("rejects SPA navigation and removed elements before any action", () => {
    document.body.innerHTML = "<input aria-label='Name'>";
    const page = snapshot();
    const request = { action: "focus-fill", pageToken: page.pageToken, elementId: page.elements[0].id };
    window.history.pushState({}, "", "/another-page");
    expect(run(request).error).toContain("Stale");
    const next = snapshot("next");
    document.body.innerHTML = "<input aria-label='Replacement'>";
    expect(run({ ...request, pageToken: next.pageToken }).error).toContain("no longer available");
  });

  it("focuses and selects a text field for native replacement without changing its value", () => {
    document.body.innerHTML = "<label for='name'>Name</label><input id='name' value='existing'>";
    const page = snapshot();
    expect(run({ action: "focus-fill", pageToken: page.pageToken, elementId: page.elements[0].id }).success).toBe(true);
    const input = document.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("existing");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  });

  it("advertises editable only for supported, writable text controls", () => {
    document.body.innerHTML = `<input aria-label="Text"><textarea aria-label="Notes"></textarea><div contenteditable="true" aria-label="Editor"></div>
      <input type="checkbox" aria-label="Check"><input type="file" aria-label="File"><input type="range" aria-label="Range"><input type="number" aria-label="Number">
      <input readonly aria-label="Read only"><textarea disabled aria-label="Disabled"></textarea><fieldset disabled><input aria-label="Disabled by fieldset"></fieldset>`;
    const page = snapshot();
    expect(page.elements.filter((element) => element.editable).map((element) => element.name)).toEqual(["Text", "Notes", "Editor"]);
    for (const element of page.elements.filter((entry) => !entry.editable)) {
      expect(run({ action: "focus-fill", pageToken: page.pageToken, elementId: element.id }).error).toBeTruthy();
    }
    expect(page.elements.find((element) => element.name === "Disabled by fieldset")?.disabled).toBe(true);
  });

  it("rejects disabled fields and covered clicks", () => {
    document.body.innerHTML = "<input disabled><button>Continue</button><div id='overlay'>Overlay</div>";
    const page = snapshot();
    expect(run({ action: "focus-fill", pageToken: page.pageToken, elementId: page.elements[0].id }).error).toContain("disabled");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector("#overlay") });
    expect(run({ action: "click-point", pageToken: page.pageToken, elementId: page.elements[1].id }).error).toContain("covered");
  });

  it("bounds snapshots and rejects references omitted from the snapshot", () => {
    document.body.innerHTML = Array.from({ length: 140 }, (_, i) => `<button>Button ${i}</button>`).join("");
    const page = snapshot();
    expect(page.elements.length).toBe(120);
    expect(page.truncated).toBe(true);
    expect(run({ action: "click-point", pageToken: page.pageToken, elementId: 140 }).error).toContain("no longer available");
  });

  it("scrolls only while the page token remains current", () => {
    snapshot();
    expect(run({ action: "scroll", pageToken: "wrong", deltaX: 0, deltaY: 100 }).error).toContain("Stale");
    expect(window.scrollBy).not.toHaveBeenCalled();
    expect(run({ action: "scroll", pageToken: "page-one", deltaX: 0, deltaY: 100 }).success).toBe(true);
    expect(window.scrollBy).toHaveBeenCalledWith({ left: 0, top: 100, behavior: "instant" });
  });
});

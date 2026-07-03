import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import JsonEditor from "./JsonEditor";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { toast } = await import("sonner");

beforeAll(() => {
  // CodeMirror 6 需要 jsdom 缺失的测量 API
  const rect = {
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}),
  };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
});

const formatBtnLabel = () => i18n.t("settings:formatBtn");

describe("JsonEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the initial value in the editor", () => {
    const { container } = render(
      <JsonEditor value='{"a":1}' onChange={vi.fn()} />
    );
    expect(container.querySelector(".cm-content")?.textContent).toContain('{"a":1}');
  });

  it("shows the placeholder when empty", () => {
    const { container } = render(
      <JsonEditor value="" onChange={vi.fn()} placeholder="paste json here" />
    );
    expect(container.textContent).toContain("paste json here");
  });

  it("hides the format button in read-only mode", () => {
    const { unmount } = render(<JsonEditor value="{}" onChange={vi.fn()} readOnly />);
    expect(
      screen.queryByRole("button", { name: new RegExp(formatBtnLabel()) })
    ).not.toBeInTheDocument();
    unmount();

    render(<JsonEditor value="{}" onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: new RegExp(formatBtnLabel()) })
    ).toBeInTheDocument();
  });

  it("formats valid JSON through the format button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JsonEditor value='{"a":1,"b":[2,3]}' onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: new RegExp(formatBtnLabel()) }));
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    expect(toast.success).toHaveBeenCalledWith(i18n.t("settings:formatSuccess"));
  });

  it("reports an error toast for invalid JSON", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JsonEditor value="{not json" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: new RegExp(formatBtnLabel()) }));
    expect(toast.error).toHaveBeenCalledWith(i18n.t("settings:formatError"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does nothing when formatting an empty document", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JsonEditor value="   " onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: new RegExp(formatBtnLabel()) }));
    expect(onChange).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("syncs external value updates into the editor", async () => {
    const { container, rerender } = render(
      <JsonEditor value='{"v":1}' onChange={vi.fn()} />
    );
    rerender(<JsonEditor value='{"v":2}' onChange={vi.fn()} />);
    await waitFor(() => {
      expect(container.querySelector(".cm-content")?.textContent).toContain('{"v":2}');
    });
  });
});

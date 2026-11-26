import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import EditorToolbar from "./EditorToolbar";

const modifiedLabel = String(i18n.t("editor:modified"));

beforeAll(() => {
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

function renderToolbar(overrides: Partial<Parameters<typeof EditorToolbar>[0]> = {}) {
  const props = {
    language: "typescript",
    dirty: false,
    readOnly: false,
    isMarkdown: false,
    previewMode: "edit" as const,
    onSave: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onPreviewModeChange: vi.fn(),
    ...overrides,
  };
  render(<EditorToolbar {...props} />);
  return props;
}

describe("EditorToolbar", () => {
  it("shows the language label and hides markdown controls for non-markdown files", () => {
    renderToolbar();
    expect(screen.getByText("typescript")).toBeInTheDocument();
    // 仅 save/undo/redo 三个按钮
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByText(modifiedLabel)).not.toBeInTheDocument();
  });

  it.each([
    ["clean", { dirty: false }],
    ["dirty but read-only", { dirty: true, readOnly: true }],
  ])("disables save when %s", (_label, overrides) => {
    renderToolbar(overrides);
    expect(screen.getAllByRole("button")[0]).toBeDisabled();
  });

  it("shows the Modified marker and enables save when dirty", async () => {
    const user = userEvent.setup();
    const props = renderToolbar({ dirty: true });
    expect(screen.getByText(modifiedLabel)).toBeInTheDocument();

    const saveBtn = screen.getAllByRole("button")[0];
    expect(saveBtn).toBeEnabled();
    await user.click(saveBtn);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it("invokes undo and redo callbacks", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();
    const [, undoBtn, redoBtn] = screen.getAllByRole("button");
    await user.click(undoBtn);
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    await user.click(redoBtn);
    expect(props.onRedo).toHaveBeenCalledTimes(1);
  });

  it("renders edit/preview/split controls for markdown and switches modes", async () => {
    const user = userEvent.setup();
    const props = renderToolbar({ isMarkdown: true, previewMode: "edit" });
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(6);

    const [, , , editBtn, previewBtn] = buttons;
    await user.click(previewBtn);
    expect(props.onPreviewModeChange).toHaveBeenCalledWith("preview");
    await user.click(editBtn);
    expect(props.onPreviewModeChange).toHaveBeenCalledWith("edit");
  });

  it.each([
    ["edit", "preview"],
    ["preview", "split"],
    ["split", "edit"],
  ] as const)("cycles preview mode from the split button: %s → %s", async (current, expected) => {
    const user = userEvent.setup();
    const props = renderToolbar({ language: "markdown", isMarkdown: true, previewMode: current });
    await user.click(screen.getAllByRole("button")[5]);
    expect(props.onPreviewModeChange).toHaveBeenCalledWith(expected);
  });
});

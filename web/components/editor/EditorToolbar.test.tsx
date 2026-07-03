import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import EditorToolbar from "./EditorToolbar";

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
    expect(screen.queryByText("Modified")).not.toBeInTheDocument();
  });

  it("disables save unless dirty and writable", () => {
    const { unmount } = render(
      <EditorToolbar
        language="rust"
        dirty={false}
        isMarkdown={false}
        previewMode="edit"
        onSave={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onPreviewModeChange={vi.fn()}
      />
    );
    expect(screen.getAllByRole("button")[0]).toBeDisabled();
    unmount();

    renderToolbar({ dirty: true, readOnly: true });
    expect(screen.getAllByRole("button")[0]).toBeDisabled();
  });

  it("shows the Modified marker and enables save when dirty", async () => {
    const user = userEvent.setup();
    const props = renderToolbar({ dirty: true });
    expect(screen.getByText("Modified")).toBeInTheDocument();

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

  it("cycles preview mode from the split button: edit → preview → split → edit", async () => {
    const user = userEvent.setup();
    for (const [current, expected] of [
      ["edit", "preview"],
      ["preview", "split"],
      ["split", "edit"],
    ] as const) {
      const onPreviewModeChange = vi.fn();
      const { unmount } = render(
        <EditorToolbar
          language="markdown"
          dirty={false}
          isMarkdown
          previewMode={current}
          onSave={vi.fn()}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          onPreviewModeChange={onPreviewModeChange}
        />
      );
      const splitBtn = screen.getAllByRole("button")[5];
      await user.click(splitBtn);
      expect(onPreviewModeChange).toHaveBeenCalledWith(expected);
      unmount();
    }
  });
});

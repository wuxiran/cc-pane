import "@/i18n";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CompactStartPage from "./CompactStartPage";

function renderPage(overrides: Partial<Parameters<typeof CompactStartPage>[0]> = {}) {
  const props = {
    projectName: "cc-pane",
    cwd: "/repo",
    busy: false,
    projectMenu: (trigger: React.ReactElement) => trigger,
    draft: "",
    onDraft: vi.fn(),
    onSubmit: vi.fn(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    placeholder: "随心输入",
    permissionMenu: <span data-testid="permission" />,
    engineMenu: <span data-testid="engine" />,
    modelMenu: <span data-testid="model" />,
    voiceButton: <span data-testid="voice" />,
    sendButton: <span data-testid="send" />,
    notice: null,
    error: null,
    ...overrides,
  };
  render(<CompactStartPage {...props} />);
  return props;
}

describe("CompactStartPage", () => {
  it("中间一句问话带项目名，输入框上方挂项目条，控件都在", () => {
    renderPage();

    expect(screen.getByRole("heading")).toHaveTextContent("你想在 cc-pane 中构建什么？");
    expect(screen.getAllByRole("button", { name: "cc-pane" })).toHaveLength(2);
    for (const id of ["permission", "engine", "model", "voice", "send"]) expect(screen.getByTestId(id)).toBeInTheDocument();
  });

  it("Enter 提交，Shift+Enter 换行", () => {
    const props = renderPage({ draft: "hi" });
    const box = screen.getByPlaceholderText("随心输入");

    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("没有项目时引导选目录，不显示项目条", () => {
    renderPage({ cwd: "", projectName: null });

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /选择|Pick/ })).toBeInTheDocument();
  });
});

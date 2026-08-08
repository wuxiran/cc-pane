import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTodoStore, useWorkspacesStore } from "@/stores";
import TodoEditor, { type TodoEditForm } from "./TodoEditor";

vi.mock("./TodoSubtaskList", () => ({
  default: () => <div data-testid="subtask-list" />,
}));

function createForm(overrides: Partial<TodoEditForm> = {}): TodoEditForm {
  return {
    title: "写测试",
    description: "",
    status: "todo",
    priority: "medium",
    scope: "global",
    scopeRef: "",
    tags: "",
    dueDate: "",
    reminderAt: "",
    recurrence: "",
    todoType: "",
    ...overrides,
  };
}

function renderEditor(overrides: Partial<Parameters<typeof TodoEditor>[0]> = {}) {
  const props = {
    form: createForm(),
    isNew: false,
    subtasks: [],
    onChange: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    onToggleSubtask: vi.fn(),
    onDeleteSubtask: vi.fn(),
    onAddSubtask: vi.fn(),
    ...overrides,
  };
  render(<TodoEditor {...props} />);
  return props;
}

describe("TodoEditor", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [
        {
          name: "ws-a",
          alias: "空间A",
          projects: [{ path: "D:/proj/app", alias: "应用" }],
        },
        { name: "ws-b", projects: [{ path: "D:/proj/lib" }] },
      ],
    } as never);
    useTodoStore.setState({
      customTypes: [],
      addCustomType: vi.fn(),
      removeCustomType: vi.fn(),
    });
  });

  it("新建模式显示新建任务与创建按钮，不显示删除与子任务", () => {
    renderEditor({ isNew: true, onDelete: vi.fn() });

    expect(screen.getByText("新建任务")).toBeVisible();
    expect(screen.getByText("创建")).toBeVisible();
    expect(screen.queryByTitle("删除")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subtask-list")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("任务描述（支持 Markdown）...")).toBeVisible();
    expect(screen.queryByText("功能")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("高级字段"));
    expect(screen.getByText("功能")).toBeVisible();
  });

  it("编辑模式显示任务详情、保存、删除按钮与子任务清单", () => {
    const props = renderEditor({ onDelete: vi.fn() });

    expect(screen.getByText("任务详情")).toBeVisible();
    expect(screen.getByText("保存")).toBeVisible();
    expect(screen.getByTestId("subtask-list")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("删除"));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("标题为空时创建按钮仍可点击并交给上层校验", () => {
    const props = renderEditor({
      form: createForm({ title: "   " }),
      isNew: true,
    });

    fireEvent.click(screen.getByText("创建"));
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it("新建模式自动聚焦必填标题", () => {
    renderEditor({ form: createForm({ title: "" }), isNew: true });

    const titleInput = screen.getByPlaceholderText("任务标题（必填）...");
    expect(titleInput).toHaveFocus();
    expect(titleInput).toBeRequired();
  });

  it("点击保存与关闭分别回调 onSave/onCancel", () => {
    const props = renderEditor();

    fireEvent.click(screen.getByText("保存"));
    expect(props.onSave).toHaveBeenCalledTimes(1);

    const header = screen.getByText("任务详情").closest("header")!;
    const buttons = header.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 1]);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+S 快捷键触发 onSave", () => {
    const props = renderEditor();

    fireEvent.keyDown(document, { key: "s", ctrlKey: true });

    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it("编辑标题回调 onChange", () => {
    const props = renderEditor();

    fireEvent.change(screen.getByPlaceholderText("任务标题（必填）..."), {
      target: { value: "新标题" },
    });

    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ title: "新标题" }),
    );
  });

  it("切换状态与优先级通过分段控件回调", () => {
    const props = renderEditor();

    fireEvent.click(screen.getByText("进行中"));
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: "in_progress" }),
    );

    fireEvent.click(screen.getByText("高"));
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ priority: "high" }),
    );
  });

  it("切换作用域会同时清空 scopeRef", () => {
    const props = renderEditor({
      form: createForm({ scope: "global", scopeRef: "leftover" }),
    });

    fireEvent.change(screen.getByLabelText("作用域"), {
      target: { value: "workspace" },
    });

    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", scopeRef: "" }),
    );
  });

  it("workspace 作用域显示工作空间下拉（别名优先），选择回填 scopeRef", () => {
    const props = renderEditor({ form: createForm({ scope: "workspace" }) });

    const select = screen.getByDisplayValue("选择工作空间");
    const labels = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(labels).toEqual(["选择工作空间", "空间A", "ws-b"]);

    fireEvent.change(select, { target: { value: "ws-a" } });
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scopeRef: "ws-a" }),
    );
  });

  it("project 作用域下拉汇总所有工作空间的项目", () => {
    const props = renderEditor({ form: createForm({ scope: "project" }) });

    const select = screen.getByDisplayValue("选择项目");
    const labels = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(labels).toEqual([
      "选择项目",
      "应用 (空间A)",
      "lib (ws-b)",
    ]);

    fireEvent.change(select, { target: { value: "D:/proj/lib" } });
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scopeRef: "D:/proj/lib" }),
    );
  });

  it("global 作用域不渲染 scopeRef 下拉", () => {
    renderEditor({ form: createForm({ scope: "global" }) });

    expect(screen.queryByDisplayValue("选择工作空间")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("选择项目")).not.toBeInTheDocument();
  });

  it("点击内置类型选中，再次点击已选类型取消", () => {
    const props = renderEditor({ form: createForm({ todoType: "" }) });
    fireEvent.click(screen.getByText("功能"));
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ todoType: "feature" }),
    );

    const props2 = renderEditor({ form: createForm({ todoType: "bug" }) });
    fireEvent.click(screen.getAllByText("缺陷")[1] ?? screen.getByText("缺陷"));
    expect(props2.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ todoType: "" }),
    );
  });

  it("添加自定义类型：输入后回车调用 addCustomType 并选中", () => {
    const props = renderEditor();

    fireEvent.click(screen.getByTitle("添加类型"));
    const input = screen.getByPlaceholderText("添加类型");
    fireEvent.change(input, { target: { value: "Infra" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useTodoStore.getState().addCustomType).toHaveBeenCalledWith("infra");
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ todoType: "infra" }),
    );
  });

  it("删除自定义类型：点 × 调用 removeCustomType，若当前选中则清空", () => {
    useTodoStore.setState({ customTypes: ["infra"] });
    const props = renderEditor({ form: createForm({ todoType: "infra" }) });

    const chip = screen.getByText("infra");
    fireEvent.click(chip.querySelector("span")!);

    expect(useTodoStore.getState().removeCustomType).toHaveBeenCalledWith(
      "infra",
    );
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ todoType: "" }),
    );
  });

  it("到期日选择转为 ISO 字符串，清空转为空串", () => {
    const props = renderEditor({
      form: createForm({ dueDate: "2026-07-01T00:00:00.000Z" }),
    });

    const dateInput = document.querySelector(
      "input[type=date]",
    ) as HTMLInputElement;
    expect(dateInput.value).toBe("2026-07-01");

    fireEvent.change(dateInput, { target: { value: "2026-07-10" } });
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ dueDate: "2026-07-10T00:00:00.000Z" }),
    );

    fireEvent.change(dateInput, { target: { value: "" } });
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ dueDate: "" }),
    );
  });

  it("重复选项变更回调 recurrence", () => {
    const props = renderEditor();

    fireEvent.change(screen.getByDisplayValue("不重复"), {
      target: { value: "daily" },
    });

    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ recurrence: "daily" }),
    );
  });

  it("标签：渲染 chip、回车追加、去重、点 × 移除", () => {
    const props = renderEditor({ form: createForm({ tags: "bug, 前端" }) });

    expect(screen.getByText("bug")).toBeVisible();
    expect(screen.getByText("前端")).toBeVisible();

    const tagInput = screen.getByPlaceholderText("+");
    fireEvent.change(tagInput, { target: { value: "紧急" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tags: "bug, 前端, 紧急" }),
    );

    vi.mocked(props.onChange).mockClear();
    fireEvent.change(tagInput, { target: { value: "bug" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(props.onChange).not.toHaveBeenCalled();
    expect((tagInput as HTMLInputElement).value).toBe("");

    const bugChip = screen.getByText("bug");
    fireEvent.click(bugChip.querySelector("button")!);
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tags: "前端" }),
    );
  });

  it("描述编辑回调 onChange", () => {
    const props = renderEditor();

    fireEvent.change(
      screen.getByPlaceholderText("任务描述（支持 Markdown）..."),
      { target: { value: "详情" } },
    );

    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ description: "详情" }),
    );
  });
});

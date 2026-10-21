import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useTodoStore } from "@/stores/useTodoStore";
import type { CreateTodoRequest, TodoItem, UpdateTodoRequest } from "@/types";
import TodoManager from "./TodoManager";

const service = vi.hoisted(() => ({
  query: vi.fn(), get: vi.fn(), update: vi.fn(), create: vi.fn(),
  addSubtask: vi.fn(), toggleSubtask: vi.fn(), deleteSubtask: vi.fn(),
  listActivities: vi.fn(), stats: vi.fn(),
}));
vi.mock("@/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services")>(), todoService: service,
}));
vi.mock("@/lib/feedback", () => ({ toastOk: vi.fn(), toastErr: vi.fn() }));

function todo(id: string): TodoItem {
  return {
    id, title: `Task ${id}`, description: `Description ${id}`, status: "todo", priority: "medium",
    scope: "global", tags: [], todoType: "feature", myDay: false, sortOrder: 0,
    createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z",
    subtasks: [{ id: `sub-${id}`, todoId: id, title: "Existing subtask", completed: false,
      sortOrder: 0, createdAt: "2026-10-21T00:00:00Z" }],
  };
}

let saved: TodoItem[];
const titleInput = () => screen.getByPlaceholderText(i18n.t("dialogs:todoTitlePlaceholder"));
const descriptionInput = () => screen.getByPlaceholderText(i18n.t("dialogs:todoDescPlaceholder"));
const closeButton = () => screen.getByRole("button", { name: i18n.t("common:close") });
const saveButton = () => screen.getByRole("button", { name: i18n.t("common:save") });

function editDraft() {
  fireEvent.change(titleInput(), { target: { value: "Unsaved title" } });
  fireEvent.change(descriptionInput(), { target: { value: "Unsaved description" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("dialogs:todoPriorityHigh") }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  saved = [todo("A"), todo("B")];
  useTodoStore.getState().reset();
  useTodoStore.setState({ todos: structuredClone(saved), total: 2, selectedTodo: structuredClone(saved[0]) });
  service.query.mockImplementation(async () => ({ items: structuredClone(saved), total: saved.length, hasMore: false }));
  service.get.mockImplementation(async (id: string) => structuredClone(saved.find((item) => item.id === id) ?? null));
  service.update.mockImplementation(async (id: string, request: UpdateTodoRequest) => {
    saved = saved.map((item) => item.id === id ? { ...item, ...request } : item);
  });
  service.create.mockImplementation(async (request: CreateTodoRequest) => {
    const created = { ...todo("created"), ...request, tags: request.tags ?? [] };
    saved.push(created);
    return structuredClone(created);
  });
  service.listActivities.mockResolvedValue([]);
  service.stats.mockResolvedValue(null);
  service.addSubtask.mockImplementation(async (id: string, title: string) => {
    const item = saved.find((item) => item.id === id)!;
    item.subtasks.push({ ...item.subtasks[0], id: "added", title });
  });
  service.toggleSubtask.mockImplementation(async (id: string) => {
    const item = saved.flatMap((todo) => todo.subtasks).find((item) => item.id === id)!;
    item.completed = !item.completed;
  });
  service.deleteSubtask.mockImplementation(async (id: string) => {
    saved = saved.map((todo) => ({ ...todo, subtasks: todo.subtasks.filter((item) => item.id !== id) }));
  });
});

describe("Todo draft ownership during live refreshes", () => {
  it.each(["toggle", "add", "delete"] as const)("%s subtask keeps unsaved fields and the close guard", async (operation) => {
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    editDraft();
    const row = screen.getByText("Existing subtask").parentElement!;
    if (operation === "add") {
      const input = screen.getByPlaceholderText(i18n.t("dialogs:todoAddSubtaskPlaceholder"));
      fireEvent.change(input, { target: { value: "Added subtask" } });
      fireEvent.keyDown(input, { key: "Enter" });
    } else fireEvent.click(row.querySelectorAll("button")[operation === "toggle" ? 0 : 1]);
    await waitFor(() => {
      const subtasks = useTodoStore.getState().selectedTodo!.subtasks;
      if (operation === "toggle") expect(subtasks[0].completed).toBe(true);
      else expect(subtasks).toHaveLength(operation === "add" ? 2 : 0);
    });
    expect(titleInput()).toHaveValue("Unsaved title");
    expect(descriptionInput()).toHaveValue("Unsaved description");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledOnce();
    expect(titleInput()).toHaveValue("Unsaved title");
    fireEvent.click(saveButton());
    await waitFor(() => expect(service.update).toHaveBeenCalledWith("A", expect.objectContaining({
      title: "Unsaved title", description: "Unsaved description", priority: "high",
    })));
  });

  it("merges clean fields from same-task refreshes while retaining dirty fields", async () => {
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    editDraft();
    saved[0] = { ...saved[0], title: "Server title", description: "Server description", priority: "low", status: "in_progress" };
    await act(async () => useTodoStore.getState().refreshTodo("A"));
    expect(titleInput()).toHaveValue("Unsaved title");
    expect(descriptionInput()).toHaveValue("Unsaved description");
    fireEvent.click(saveButton());
    await waitFor(() => expect(service.update).toHaveBeenCalledWith("A", expect.objectContaining({
      title: "Unsaved title", description: "Unsaved description", priority: "high", status: "in_progress",
    })));
  });

  it("preserves switch/new/close confirmations and initializes a different task", async () => {
    render(<TodoManager scope="workspace" scopeRef="space" enabled={false} />);
    editDraft();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => { fireEvent.click(screen.getByText("Task B")); });
    expect(titleInput()).toHaveValue("Unsaved title");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("dialogs:todoNewTask") }));
    expect(titleInput()).toHaveValue("Unsaved title");
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockReturnValue(true);
    await act(async () => { fireEvent.click(screen.getByText("Task B")); });
    expect(titleInput()).toHaveValue("Task B");
    expect(descriptionInput()).toHaveValue("Description B");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("dialogs:todoNewTask") }));
    expect(titleInput()).toHaveValue("");
    fireEvent.change(titleInput(), { target: { value: "New draft" } });
    confirm.mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(titleInput()).toHaveValue("New draft");
    confirm.mockReturnValue(true);
    fireEvent.click(closeButton());
    expect(screen.queryByPlaceholderText(i18n.t("dialogs:todoTitlePlaceholder"))).not.toBeInTheDocument();
  });

  it("a late save preserves edits typed after submission and their close guard", async () => {
    let finish!: () => void;
    service.update.mockImplementation((id: string, request: UpdateTodoRequest) => new Promise<void>((resolve) => {
      finish = () => { saved = saved.map((item) => item.id === id ? { ...item, ...request } : item); resolve(); };
    }));
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    editDraft();
    fireEvent.click(saveButton());
    fireEvent.change(titleInput(), { target: { value: "Newer unsaved title" } });
    await act(async () => { finish(); });
    expect(titleInput()).toHaveValue("Newer unsaved title");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("a successful save clears the guard without reverting the saved draft", async () => {
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    fireEvent.change(titleInput(), { target: { value: "  Saved title  " } });
    await act(async () => { fireEvent.click(saveButton()); });
    expect(titleInput()).toHaveValue("Saved title");
    expect(useTodoStore.getState().selectedTodo?.title).toBe("Saved title");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(i18n.t("dialogs:todoTitlePlaceholder"))).not.toBeInTheDocument();
  });

  it("a late save cannot acknowledge edits in a different selected task", async () => {
    let finish!: () => void;
    service.update.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    editDraft();
    fireEvent.click(saveButton());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => { fireEvent.click(screen.getByText("Task B")); });
    fireEvent.change(titleInput(), { target: { value: "Unsaved B" } });
    await act(async () => { finish(); });
    expect(titleInput()).toHaveValue("Unsaved B");
    confirm.mockClear().mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("a late creation cannot close or clear a subsequent new-task form", async () => {
    let finish!: () => void;
    service.create.mockImplementation(() => new Promise<TodoItem>((resolve) => { finish = () => resolve(todo("created")); }));
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    const newButton = () => screen.getByRole("button", { name: i18n.t("dialogs:todoNewTask") });
    fireEvent.click(newButton());
    fireEvent.change(titleInput(), { target: { value: "First creation" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common:create") }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(newButton());
    fireEvent.change(titleInput(), { target: { value: "Second creation draft" } });
    await act(async () => { finish(); });
    expect(titleInput()).toHaveValue("Second creation draft");
    expect(screen.getByRole("button", { name: i18n.t("common:create") })).toBeVisible();
    confirm.mockClear().mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledOnce();
  });

  it.each([true, false])("creation with later edits stays bound to the new ID (listed=%s)", async (listed) => {
    let finish!: () => void;
    service.create.mockImplementation((request: CreateTodoRequest) => new Promise<TodoItem>((resolve) => {
      finish = () => {
        const created = { ...todo("created"), ...request, tags: request.tags ?? [] };
        saved.push(created);
        resolve(structuredClone(created));
      };
    }));
    if (!listed) service.query.mockImplementation(async () => ({ items: structuredClone(saved.filter((item) => item.id !== "created")), total: 2, hasMore: false }));
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("dialogs:todoNewTask") }));
    fireEvent.change(titleInput(), { target: { value: "Submitted creation" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common:create") }));
    fireEvent.change(titleInput(), { target: { value: "Later creation edit" } });
    fireEvent.change(descriptionInput(), { target: { value: "Later body" } });
    await act(async () => { finish(); });
    expect(titleInput()).toHaveValue("Later creation edit");
    expect(descriptionInput()).toHaveValue("Later body");
    expect(useTodoStore.getState().selectedTodo?.id).toBe("created");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(saveButton()); });
    expect(service.update).toHaveBeenCalledWith("created", expect.objectContaining({ title: "Later creation edit", description: "Later body" }));
    expect(service.create).toHaveBeenCalledOnce();
  });

  it("a refresh during save cannot overwrite an edit that returned to the old value", async () => {
    let finish!: () => void;
    service.update.mockImplementation((id: string, request: UpdateTodoRequest) => {
      saved = saved.map((item) => item.id === id ? { ...item, ...request } : item);
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    editDraft();
    fireEvent.click(saveButton());
    fireEvent.change(titleInput(), { target: { value: "Task A" } });
    await act(async () => useTodoStore.getState().refreshTodo("A"));
    expect(titleInput()).toHaveValue("Task A");
    await act(async () => { finish(); });
    expect(titleInput()).toHaveValue("Task A");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("a rejected save retains later edits and the dirty guard", async () => {
    let reject!: (error: Error) => void;
    service.update.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    editDraft();
    fireEvent.click(saveButton());
    fireEvent.change(titleInput(), { target: { value: "After failed submission" } });
    await act(async () => { reject(new Error("write failed")); });
    expect(titleInput()).toHaveValue("After failed submission");
    expect(descriptionInput()).toHaveValue("Unsaved description");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("an older save acknowledgement cannot replace a newer acknowledged draft", async () => {
    const finish: (() => void)[] = [];
    service.update.mockImplementation((id: string, request: UpdateTodoRequest) => {
      saved = saved.map((item) => item.id === id ? { ...item, ...request } : item);
      return new Promise<void>((resolve) => { finish.push(resolve); });
    });
    render(<TodoManager scope="" scopeRef="" enabled={false} />);
    fireEvent.change(titleInput(), { target: { value: "First save" } });
    fireEvent.click(saveButton());
    fireEvent.change(titleInput(), { target: { value: "Second save" } });
    fireEvent.click(saveButton());
    await act(async () => { finish[1](); });
    await act(async () => { finish[0](); });
    expect(titleInput()).toHaveValue("Second save");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(closeButton());
    expect(confirm).not.toHaveBeenCalled();
  });
});

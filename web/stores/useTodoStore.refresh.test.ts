import { beforeEach, expect, it, vi } from "vitest";
import type { TodoItem } from "@/types";
const service = vi.hoisted(() => ({
  get: vi.fn(), query: vi.fn(), stats: vi.fn(), listActivities: vi.fn(),
  addSubtask: vi.fn(), toggleSubtask: vi.fn(), deleteSubtask: vi.fn(),
}));
vi.mock("@/services", () => ({ todoService: service, taskBindingService: { query: vi.fn() } }));
import { useTodoStore } from "./useTodoStore";

function todo(id: string): TodoItem {
  return { id, title: id, status: "todo", priority: "medium", scope: "global", tags: [],
    todoType: "feature", myDay: false, sortOrder: 0, createdAt: "", updatedAt: "", subtasks: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTodoStore.getState().reset();
  useTodoStore.setState({ todos: [todo("A"), todo("B")], selectedTodo: todo("A") });
});

it.each(["toggleSubtask", "deleteSubtask"] as const)("%s refreshes its original task even if selection changes during the mutation", async (action) => {
  let finish!: () => void;
  service[action].mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  service.get.mockResolvedValue({ ...todo("A"), title: "refreshed A" });
  const pending = useTodoStore.getState()[action]("sub-A");
  useTodoStore.getState().select(todo("B"));
  finish();
  await pending;
  expect(service.get).toHaveBeenCalledExactlyOnceWith("A");
  expect(useTodoStore.getState().selectedTodo?.id).toBe("B");
  expect(useTodoStore.getState().todos[0].title).toBe("refreshed A");
});

it.each(["addSubtask", "toggleSubtask", "deleteSubtask"] as const)("%s late read never replaces a newer task selection", async (action) => {
  service[action].mockResolvedValue(undefined);
  let finish!: (value: TodoItem) => void;
  service.get.mockImplementation(() => new Promise<TodoItem>((resolve) => { finish = resolve; }));
  const state = useTodoStore.getState();
  const pending = action === "addSubtask" ? state.addSubtask("A", "child") : state[action]("sub-A");
  await vi.waitFor(() => expect(service.get).toHaveBeenCalled());
  state.select(todo("B"));
  finish({ ...todo("A"), title: "late A" });
  await pending;
  expect(useTodoStore.getState().selectedTodo).toEqual(todo("B"));
  expect(useTodoStore.getState().todos[0].title).toBe("late A");
});

it("a newer same-task refresh wins even if an older subtask read finishes last", async () => {
  let finish!: (value: TodoItem) => void;
  service.get.mockImplementationOnce(() => new Promise<TodoItem>((resolve) => { finish = resolve; }));
  const older = useTodoStore.getState().refreshTodo("A");
  service.get.mockResolvedValueOnce({ ...todo("A"), title: "latest saved title" });
  await useTodoStore.getState().refreshTodo("A");
  finish({ ...todo("A"), title: "before save" });
  await older;
  expect(useTodoStore.getState().selectedTodo?.title).toBe("latest saved title");
  expect(useTodoStore.getState().todos[0].title).toBe("latest saved title");
});

it("a reset prevents reads from an old manager lifetime from changing reopened tasks", async () => {
  let finish!: (value: TodoItem) => void;
  service.get.mockImplementationOnce(() => new Promise<TodoItem>((resolve) => { finish = resolve; }));
  const pending = useTodoStore.getState().refreshTodo("A");
  useTodoStore.getState().reset();
  useTodoStore.setState({ todos: [todo("A")], selectedTodo: todo("A") });
  finish({ ...todo("A"), title: "old lifetime" });
  await pending;
  expect(useTodoStore.getState().selectedTodo?.title).toBe("A");
});

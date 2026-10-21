import { useCallback, useEffect, useRef, useState } from "react";
import type { TodoItem } from "@/types";
import type { TodoEditForm } from "./TodoEditor";

export function todoEditForm(todo?: TodoItem | null): TodoEditForm {
  return {
    title: todo?.title ?? "",
    description: todo?.description ?? "",
    status: todo?.status ?? "todo",
    priority: todo?.priority ?? "medium",
    scope: todo?.scope ?? "global",
    scopeRef: todo?.scopeRef ?? "",
    tags: todo?.tags.join(", ") ?? "",
    dueDate: todo?.dueDate ?? "",
    reminderAt: todo?.reminderAt ?? "",
    recurrence: todo?.recurrence ?? "",
    todoType: todo?.todoType ?? "",
  };
}

type Field = keyof TodoEditForm;
const fields = Object.keys(todoEditForm()) as Field[];
type Edits = Partial<Record<Field, number>>;
interface TodoDraft {
  id: string | null;
  form: TodoEditForm;
  edits: Edits;
  revision: number;
  generation: number;
}
interface TodoSave extends TodoDraft {
  saveId: number;
}

function preserveEdited(incoming: TodoEditForm, current: TodoEditForm, edits: Edits): TodoEditForm {
  return {
    ...incoming,
    ...Object.fromEntries(fields.filter((key) => edits[key] !== undefined).map((key) => [key, current[key]])),
  };
}

function acknowledge(current: TodoDraft, submitted: TodoDraft, saved: TodoEditForm): TodoDraft {
  // Compare edit versions as well as values: typing the old baseline while a
  // different value is being saved is still an unsaved user edit.
  const edits = Object.fromEntries(fields.filter((key) => current.edits[key] !== undefined
    && current.edits[key] !== submitted.edits[key] && current.form[key] !== saved[key])
    .map((key) => [key, current.edits[key]])) as Edits;
  return { ...current, edits, form: preserveEdited(saved, current.form, edits) };
}

export function useTodoDraft(selected: TodoItem | null) {
  const [draft, setDraft] = useState<TodoDraft>(() => ({
    id: selected?.id ?? null, form: todoEditForm(selected), edits: {}, revision: 0, generation: 0,
  }));
  // Event handlers and async completions share the latest draft, even before React renders it.
  const current = useRef(draft);
  const saveSequence = useRef(0);
  const acknowledgedSave = useRef(0);
  const change = useCallback((update: (draft: TodoDraft) => TodoDraft) => {
    current.current = update(current.current);
    setDraft(current.current);
  }, []);

  useEffect(() => {
    change((previous) => {
      const id = selected?.id ?? null;
      if (!selected) {
        return previous.id === null ? previous : { ...previous, id, generation: previous.generation + 1 };
      }
      const incoming = todoEditForm(selected);
      if (previous.id !== id) {
        return { ...previous, id, form: incoming, edits: {}, generation: previous.generation + 1 };
      }
      return { ...previous, form: preserveEdited(incoming, previous.form, previous.edits) };
    });
  }, [selected, change]);

  const setEditForm = useCallback((form: TodoEditForm) => change((previous) => {
    const edits = { ...previous.edits };
    const revision = previous.revision + 1;
    for (const key of fields) if (form[key] !== previous.form[key]) edits[key] = revision;
    return { ...previous, form, edits, revision };
  }), [change]);
  const resetForm = useCallback((form: TodoEditForm, id: string | null = null) => change((previous) => ({
    ...previous, id, form, edits: {}, generation: previous.generation + 1,
  })), [change]);
  const captureSave = useCallback((): TodoSave => ({
    ...current.current, saveId: ++saveSequence.current,
  }), []);
  const markSaved = useCallback((submitted: TodoSave) => change((previous) => {
    if (previous.generation !== submitted.generation || submitted.saveId < acknowledgedSave.current) {
      return previous;
    }
    acknowledgedSave.current = submitted.saveId;
    return acknowledge(previous, submitted, {
      ...submitted.form,
      title: submitted.form.title.trim(),
      tags: submitted.form.tags.split(",").map((tag) => tag.trim()).filter(Boolean).join(", "),
    });
  }), [change]);
  const completeCreation = useCallback((submitted: TodoSave, created: TodoItem): boolean => {
    if (current.current.generation !== submitted.generation) return false;
    acknowledgedSave.current = submitted.saveId;
    const acknowledged = acknowledge(current.current, submitted, todoEditForm(created));
    const keepEditing = Object.keys(acknowledged.edits).length > 0;
    change(() => ({
      ...acknowledged, id: keepEditing ? created.id : null, generation: acknowledged.generation + 1,
    }));
    return keepEditing;
  }, [change]);

  return {
    editForm: draft.form, isDirty: Object.keys(draft.edits).length > 0,
    setEditForm, resetForm, captureSave, markSaved, completeCreation,
  };
}

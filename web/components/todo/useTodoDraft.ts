import { useCallback, useEffect, useState } from "react";
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

const fields = Object.keys(todoEditForm()) as (keyof TodoEditForm)[];

/** Server refreshes update clean fields while unsaved field values retain ownership. */
function mergeDraft(current: TodoEditForm, previous: TodoEditForm, incoming: TodoEditForm): TodoEditForm {
  return {
    ...incoming,
    ...Object.fromEntries(fields.filter((key) => current[key] !== previous[key]).map((key) => [key, current[key]])),
  };
}

export function useTodoDraft(selected: TodoItem | null) {
  const [draft, setDraft] = useState(() => {
    const form = todoEditForm(selected);
    return { id: selected?.id ?? null, form, baseline: form };
  });

  useEffect(() => {
    if (!selected) {
      setDraft((current) => current.id === null ? current : { ...current, id: null });
      return;
    }
    const incoming = todoEditForm(selected);
    setDraft((current) => ({
      id: selected.id,
      baseline: incoming,
      form: current.id === selected.id ? mergeDraft(current.form, current.baseline, incoming) : incoming,
    }));
  }, [selected]);

  const setForm = useCallback((form: TodoEditForm) => setDraft((current) => ({ ...current, form })), []);
  const resetForm = useCallback((form: TodoEditForm, id: string | null = null) => {
    setDraft({ id, form, baseline: form });
  }, []);
  const markSaved = useCallback((id: string | null, submitted: TodoEditForm) => {
    const saved = {
      ...submitted,
      title: submitted.title.trim(),
      tags: submitted.tags.split(",").map((tag) => tag.trim()).filter(Boolean).join(", "),
    };
    setDraft((current) => current.id !== id ? current : {
      id,
      baseline: saved,
      // A save acknowledges only the version submitted, not edits typed while awaiting it.
      form: mergeDraft(current.form, submitted, saved),
    });
  }, []);

  return {
    editForm: draft.form,
    isDirty: fields.some((key) => draft.form[key] !== draft.baseline[key]),
    setEditForm: setForm,
    resetForm,
    markSaved,
  };
}

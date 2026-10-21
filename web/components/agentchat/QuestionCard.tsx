import { useId, useMemo } from "react";
import { ArrowRight, Check, CircleHelp, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpElicitationDraft, AcpElicitationRequest, AcpElicitationResponse } from "@/types/agentChat";
import { normalizeQuestionForm, questionContent, questionValues, type QuestionField } from "./questionSchema";

export interface QuestionCardProps {
  request: AcpElicitationRequest;
  values: AcpElicitationDraft;
  onChange: (values: AcpElicitationDraft) => void;
  onRespond: (response: AcpElicitationResponse) => void;
  responding?: boolean;
  error?: string | null;
}
const inputClass = "w-full min-w-0 rounded-xl border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm text-[var(--app-text-primary)] outline-none focus:border-[var(--app-accent)] focus:ring-1 focus:ring-[var(--app-accent)] disabled:opacity-50";

type FieldProps = { field: QuestionField; value: AcpElicitationDraft[string] | undefined; disabled: boolean; onChange: (value: AcpElicitationDraft[string]) => void };
function ChoiceField({ field, value, disabled, onChange }: FieldProps) {
  const group = useId();
  return <div className="space-y-1.5">{field.choices.map((choice, index) => {
    const selected = Array.isArray(value) ? value.includes(choice.value) : value === choice.value;
    return <label key={choice.value} className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--app-accent)] ${selected ? "bg-[var(--app-active-bg)]" : "hover:bg-[var(--app-hover)]"} ${disabled ? "pointer-events-none opacity-60" : ""}`}>
      <input className="sr-only" type={field.type === "array" ? "checkbox" : "radio"} name={group} checked={selected} disabled={disabled}
        onChange={() => onChange(field.type === "array" ? selected ? (Array.isArray(value) ? value : []).filter((item) => item !== choice.value) : [...(Array.isArray(value) ? value : []), choice.value] : choice.value)} />
      <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] text-xs text-[var(--app-text-secondary)]">{selected && field.type === "array" ? <Check className="h-4 w-4" /> : index + 1}</span>
      <span className="min-w-0 flex-1"><span className="block text-sm break-words">{choice.title}</span>{choice.description && <span className="mt-0.5 block text-xs text-[var(--app-text-secondary)] break-words">{choice.description}</span>}</span>
      {selected && <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--app-text-secondary)]" />}
    </label>;
  })}</div>;
}
function FieldInput(props: FieldProps) {
  const { t } = useTranslation("panes");
  const { field, value, disabled, onChange } = props;
  if (field.choices.length) return <ChoiceField {...props} />;
  if (field.type === "boolean") return <select aria-label={field.title} className={inputClass} disabled={disabled} value={value === undefined ? "" : String(value)} onChange={(event) => onChange(event.target.value === "true")}>
    <option value="" disabled>{t("agentChatQuestionChoose")}</option><option value="true">{t("agentChatQuestionYes")}</option><option value="false">{t("agentChatQuestionNo")}</option>
  </select>;
  if (field.type === "number" || field.type === "integer" || field.secret) return <input aria-label={field.title} className={inputClass} disabled={disabled} type={field.secret ? "password" : "number"} autoComplete="off" min={field.minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
  return <div className="relative"><Pencil aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--app-text-secondary)]" /><textarea aria-label={field.title} className={`${inputClass} resize-y pl-9`} rows={2} disabled={disabled} placeholder={t("agentChatQuestionAnswerPlaceholder")} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} /></div>;
}

export default function QuestionCard({ request, values, onChange, onRespond, responding = false, error }: QuestionCardProps) {
  const { t } = useTranslation("panes");
  const titleId = useId();
  const form = useMemo(() => normalizeQuestionForm(request), [request]);
  const current = questionValues(form, values);
  const content = questionContent(form, values);
  const setField = (field: QuestionField, value: AcpElicitationDraft[string]) => {
    const next = { ...values, [field.id]: value };
    // Codex explicitly supplies a separate note property and a matching Other option.
    if (field.noteFor && typeof value === "string" && value.trim() && current[field.noteFor] === undefined) {
      const parent = form.fields.find((item) => item.id === field.noteFor);
      const other = parent?.choices.find((choice) => choice.value === "None of the above");
      if (other) next[field.noteFor] = other.value;
    }
    onChange(next);
  };
  return <section aria-labelledby={titleId} className="mx-auto max-h-[min(60vh,36rem)] max-w-3xl overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-overlay)] px-4 py-3 shadow-sm">
    <div className="flex items-center gap-2 text-xs text-[var(--app-text-secondary)]"><CircleHelp aria-hidden="true" className="h-4 w-4" /><h3 id={titleId} className="flex-1 font-medium">{t("agentChatQuestionTitle")}</h3><button type="button" disabled={responding} aria-label={t("agentChatQuestionDismiss")} className="rounded-md p-1 hover:bg-[var(--app-hover)] disabled:opacity-50" onClick={() => onRespond({ action: "cancel" })}><X className="h-4 w-4" /></button></div>
    <form onSubmit={(event) => { event.preventDefault(); if (content !== null && !responding) onRespond({ action: "accept", content }); }}>
      {request.params.message && <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--app-text-primary)] break-words">{request.params.message}</p>}
      <div className="mt-3 max-h-[min(55vh,32rem)] space-y-4 overflow-y-auto">{form.fields.filter((field) => !field.noteFor || !form.fields.some((item) => item.id === field.noteFor)).map((field) => <fieldset key={field.id} disabled={responding} className="min-w-0 space-y-2">
        <legend className="mb-2 text-sm font-medium text-[var(--app-text-primary)] break-words">{field.title}{field.required ? null : <span className="ml-2 text-xs font-normal text-[var(--app-text-secondary)]">{t("agentChatQuestionOptional")}</span>}</legend>
        {field.description && <p className="text-xs text-[var(--app-text-secondary)] break-words">{field.description}</p>}
        <FieldInput field={field} value={current[field.id]} disabled={responding} onChange={(value) => setField(field, value)} />
        {form.fields.filter((note) => note.noteFor === field.id).map((note) => <FieldInput key={note.id} field={note} value={current[note.id]} disabled={responding} onChange={(value) => setField(note, value)} />)}
      </fieldset>)}</div>
      {form.unsupported && <p role="alert" className="mt-3 text-xs text-[var(--app-status-warning)]">{t("agentChatQuestionUnsupported")}</p>}
      {error && <p role="alert" className="mt-3 text-xs text-[var(--app-status-danger)] break-words">{error}</p>}
      <div className="mt-3 flex justify-end gap-2"><button type="button" disabled={responding} className="rounded-full border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text-primary)] hover:bg-[var(--app-hover)] disabled:opacity-50" onClick={() => onRespond({ action: "decline" })}>{t("agentChatQuestionSkip")}</button><button type="submit" disabled={responding || content === null} className="rounded-full bg-[var(--app-accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">{responding ? t("agentChatQuestionSending") : t("agentChatSend")}</button></div>
    </form>
  </section>;
}

import type { AcpElicitationDraft, AcpElicitationRequest, AcpElicitationValue } from "@/types/agentChat";

export interface QuestionChoice { value: string; title: string; description?: string }
export interface QuestionField {
  id: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean;
  choices: QuestionChoice[];
  secret: boolean;
  noteFor?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  defaultValue?: AcpElicitationDraft[string];
}
export interface QuestionForm { fields: QuestionField[]; unsupported: boolean }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function onlyKeys(schema: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(schema).every((key) => keys.includes(key));
}
function supportedField(schema: Record<string, unknown>): boolean {
  const common = ["type", "title", "description", "default", "_meta"];
  const constraints: Record<string, string[]> = {
    string: ["oneOf", "enum", "minLength", "maxLength"], number: ["minimum", "maximum"],
    integer: ["minimum", "maximum"], boolean: [], array: ["items", "minItems", "maxItems"],
  };
  const extra = Object.prototype.hasOwnProperty.call(constraints, String(schema.type)) ? constraints[String(schema.type)] : undefined;
  if (!extra || !onlyKeys(schema, [...common, ...extra])) return false;
  if (schema.oneOf !== undefined && schema.enum !== undefined) return false;
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"]) {
    const value = schema[key];
    if (value !== undefined && (number(value) === undefined || (!key.endsWith("imum") && (!Number.isInteger(value) || Number(value) < 0)))) return false;
  }
  if (schema.type === "array") {
    const items = record(schema.items);
    if (!items || !onlyKeys(items, ["type", "enum", "anyOf", "_meta"]) || (items.type !== undefined && items.type !== "string")) return false;
    if (items.enum !== undefined && items.anyOf !== undefined) return false;
  }
  return true;
}
function choices(schema: Record<string, unknown>): QuestionChoice[] | null {
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants)) {
    if (variants.length === 0 || variants.length > 256) return null;
    const parsed = variants.map((item) => {
      const option = record(item);
      return option && onlyKeys(option, ["const", "title", "description", "_meta"]) && typeof option.const === "string"
        ? { value: option.const, title: text(option.title) ?? option.const, description: text(option.description) } : null;
    });
    return parsed.every((item) => item !== null) ? parsed : null;
  }
  if (variants !== undefined) return null;
  if (schema.enum === undefined) return [];
  return Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 256 && schema.enum.every((item) => typeof item === "string")
    ? schema.enum.map((value) => ({ value, title: value })) : null;
}

function parseField(id: string, raw: unknown, required: boolean): QuestionField | null {
  const schema = record(raw);
  const type = schema?.type;
  if (!schema || !supportedField(schema)) return null;
  const options = choices(type === "array" ? record(schema.items) ?? {} : schema);
  if (options === null || (type === "array" && options.length === 0)) return null;
  if (new Set(options.map((option) => option.value)).size !== options.length) return null;
  const meta = record(record(schema._meta)?.codex);
  const initial = schema.default;
  return {
    id, title: text(schema.title) ?? id, description: text(schema.description),
    type: type as QuestionField["type"], required, choices: options, secret: meta?.isSecret === true,
    noteFor: meta?.role === "user_note" ? text(meta.questionId) : undefined,
    minimum: number(schema.minimum), maximum: number(schema.maximum),
    minLength: number(schema.minLength), maxLength: number(schema.maxLength),
    minItems: number(schema.minItems), maxItems: number(schema.maxItems),
    defaultValue: typeof initial === "string" || typeof initial === "boolean" ? initial
      : typeof initial === "number" ? String(initial)
        : Array.isArray(initial) && initial.every((item) => typeof item === "string") ? initial : undefined,
  };
}

/** Only declared form properties become controls; assistant prose never becomes a question. */
export function normalizeQuestionForm(request: AcpElicitationRequest): QuestionForm {
  const schema = record(request.params.requestedSchema);
  const properties = record(schema?.properties);
  if (request.params.mode !== "form" || !schema || !properties || Object.keys(properties).length > 128 || (schema.type && schema.type !== "object")) {
    return { fields: [], unsupported: true };
  }
  if (!onlyKeys(schema, ["type", "properties", "required", "title", "description", "_meta"])
    || (schema.required !== undefined && !Array.isArray(schema.required))) return { fields: [], unsupported: true };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(properties).map(([id, value]) => parseField(id, value, required.has(id)));
  const unsupported = fields.some((field) => field === null)
    || [...required].some((id) => typeof id !== "string" || !Object.prototype.hasOwnProperty.call(properties, id));
  const parsed = fields.filter((field): field is QuestionField => field !== null);
  const normalized = parsed.map((field) => {
    if (!field.noteFor) return field;
    const parent = parsed.find((candidate) => candidate.id === field.noteFor);
    const canMerge = field.type === "string" && field.choices.length === 0 && parent
      && !parent.noteFor && parent.id !== field.id && parent.type === "string" && parent.choices.length > 0;
    return canMerge ? field : { ...field, noteFor: undefined };
  });
  return { fields: normalized, unsupported };
}

export function questionValues(form: QuestionForm, draft: AcpElicitationDraft): AcpElicitationDraft {
  return Object.assign(Object.create(null), Object.fromEntries(form.fields.flatMap((field) => {
    const value = Object.prototype.hasOwnProperty.call(draft, field.id) ? draft[field.id] : field.defaultValue;
    return value === undefined ? [] : [[field.id, value]];
  })));
}

function parseValue(field: QuestionField, raw: AcpElicitationDraft[string] | undefined): AcpElicitationValue | null | undefined {
  if (raw === undefined) return field.required ? null : undefined;
  if (field.type === "boolean") return typeof raw === "boolean" ? raw : null;
  if (field.type === "number" || field.type === "integer") {
    if (raw === "") return field.required ? null : undefined;
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) return null;
    return (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum) ? null : value;
  }
  if (field.type === "array") {
    if (!Array.isArray(raw) || new Set(raw).size !== raw.length || raw.some((value) => !field.choices.some((choice) => choice.value === value))) return null;
    return (field.minItems !== undefined && raw.length < field.minItems) || (field.maxItems !== undefined && raw.length > field.maxItems) ? null : raw;
  }
  if (typeof raw !== "string") return null;
  if (field.choices.length > 0 && !field.choices.some((choice) => choice.value === raw)) return null;
  const length = [...raw].length;
  return (field.minLength !== undefined && length < field.minLength) || (field.maxLength !== undefined && length > field.maxLength) ? null : raw;
}

export function questionContent(form: QuestionForm, draft: AcpElicitationDraft): Record<string, AcpElicitationValue> | null {
  if (form.unsupported) return null;
  const values = questionValues(form, draft);
  const content: Record<string, AcpElicitationValue> = {};
  for (const field of form.fields) {
    const value = parseValue(field, values[field.id]);
    if (value === null) return null;
    if (value !== undefined) Object.defineProperty(content, field.id, { value, enumerable: true });
  }
  return content;
}

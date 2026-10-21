import { describe, expect, it } from "vitest";
import type { AcpElicitationRequest } from "@/types/agentChat";
import { normalizeQuestionForm, questionContent } from "./questionSchema";
import claudeQuestionForm from "./fixtures/claude-question-form.json";
const form = (properties: unknown, required: string[] = []) => normalizeQuestionForm({ requestKey: "form", params: { mode: "form", message: "", requestedSchema: { type: "object", properties, required } } });
describe("questionSchema", () => {
  it("keeps enum values separate from labels and rejects invented choices", () => {
    const schema = form({ scope: { type: "string", oneOf: [{ const: "local", title: "This project" }] } }, ["scope"]);
    expect(schema.fields[0].choices).toEqual([{ value: "local", title: "This project", description: undefined }]);
    expect(questionContent(schema, { scope: "This project" })).toBeNull();
    expect(questionContent(schema, { scope: "local" })).toEqual({ scope: "local" });
  });
  it("validates required fields, numbers, unicode lengths, booleans and defaults", () => {
    const schema = form({ count: { type: "integer", minimum: 1, maximum: 4 }, enabled: { type: "boolean", default: false }, text: { type: "string", minLength: 2 } }, ["count", "enabled"]);
    expect(questionContent(schema, { count: "1.5" })).toBeNull();
    expect(questionContent(schema, { count: "5" })).toBeNull();
    expect(questionContent(schema, { count: "2", text: "😀" })).toBeNull();
    expect(questionContent(schema, { count: "2", text: "😀好" })).toEqual({ count: 2, enabled: false, text: "😀好" });
  });
  it("does not parse prose or silently drop unsupported schema fields", () => {
    expect(normalizeQuestionForm({ requestKey: "x", params: { mode: "url", message: "1. choose me" } } as AcpElicitationRequest).unsupported).toBe(true);
    for (const unsupported of [{ type: "object" }, { type: "string", pattern: ".*" }, { type: "number", multipleOf: 2 }, { type: "string", const: "fixed" }, { type: "string", oneOf: [{ const: "x" }], enum: ["y"] }, { type: "array", items: { type: "object" } }]) {
      expect(questionContent(form({ q: unsupported }), {})).toBeNull();
    }
    expect(form({ q: { type: "string" } }, ["missing"]).unsupported).toBe(true);
  });
  it("handles schema field names without prototype mutation", () => {
    const schema = form(JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"string"}}'), ["__proto__"]);
    expect(questionContent(schema, {})).toBeNull();
    const result = questionContent(schema, JSON.parse('{"__proto__":"answer","constructor":"value"}'))!;
    expect(Object.keys(result)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
  it("distinguishes missing values from declared empty enum values and empty selections", () => {
    const schema = form({ choice: { type: "string", enum: ["", "other"] }, items: { type: "array", minItems: 0, items: { type: "string", enum: ["a"] } } }, ["choice", "items"]);
    expect(questionContent(schema, {})).toBeNull();
    expect(questionContent(schema, { choice: "", items: [] })).toEqual({ choice: "", items: [] });
  });
  it("keeps malformed note relationships visible as ordinary questions", () => {
    const note = (questionId: string) => ({ type: "string", _meta: { codex: { role: "user_note", questionId } } });
    const schema = form({ self: note("self"), left: note("right"), right: note("left") });
    expect(schema.fields.every((field) => field.noteFor === undefined)).toBe(true);
  });

  it("accepts the pinned Claude adapter's optional single/multi/custom fields", () => {
    const schema = normalizeQuestionForm({ requestKey: "claude", params: claudeQuestionForm });
    expect(schema.unsupported).toBe(false);
    expect(questionContent(schema, { question_0_custom: "自己的回答" })).toEqual({ question_0_custom: "自己的回答" });
    expect(questionContent(schema, { question_0: "自动附加" })).toEqual({ question_0: "自动附加" });
    const multiple = form({ question_0: { type: "array", title: "选择屏幕", items: { anyOf: [{ const: "left", title: "左屏" }, { const: "right", title: "右屏" }] } } });
    expect(questionContent(multiple, { question_0: ["left", "right"] })).toEqual({ question_0: ["left", "right"] });
  });

});

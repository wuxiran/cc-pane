import "@/i18n";
import i18n from "@/i18n";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AcpElicitationDraft, AcpElicitationRequest, AcpElicitationResponse } from "@/types/agentChat";
import QuestionCard from "./QuestionCard";
import claudeQuestionForm from "./fixtures/claude-question-form.json";

const request: AcpElicitationRequest = { requestKey: "n1", params: {
  mode: "form", message: "截图应该如何发送？", requestedSchema: { type: "object", required: ["capture"], properties: {
    capture: { type: "string", title: "截图行为", oneOf: [
      { const: "automatic", title: "自动附加", description: "自动放入当前对话输入框" },
      { const: "paste", title: "手动粘贴" },
      { const: "None of the above", title: "其他" },
    ] },
    capture_note: { type: "string", title: "补充回答", _meta: { codex: { questionId: "capture", role: "user_note" } } },
  } },
} };
const sendName = () => i18n.t("agentChatSend", { ns: "panes" });
function Harness({ onRespond, form = request }: { onRespond: (response: AcpElicitationResponse) => void; form?: AcpElicitationRequest }) {
  const [values, onChange] = useState<AcpElicitationDraft>({});
  return <QuestionCard request={form} values={values} onChange={onChange} onRespond={onRespond} />;
}
describe("QuestionCard", () => {
  it("requires explicit selection and submits original option values with a note", () => {
    const respond = vi.fn(); render(<Harness onRespond={respond} />);
    expect(screen.getByRole("button", { name: sendName() })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /自动附加/ }));
    expect(respond).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "补充回答" }), { target: { value: "允许预览和删除" } });
    fireEvent.click(screen.getByRole("button", { name: sendName() }));
    expect(respond).toHaveBeenCalledWith({ action: "accept", content: { capture: "automatic", capture_note: "允许预览和删除" } });
  });
  it("routes a custom answer through Codex's declared note field and Other value", () => {
    const respond = vi.fn(); render(<Harness onRespond={respond} />);
    fireEvent.change(screen.getByRole("textbox", { name: "补充回答" }), { target: { value: "只在当前对话截图" } });
    expect(screen.getByRole("radio", { name: "其他" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: sendName() }));
    expect(respond).toHaveBeenCalledWith({ action: "accept", content: { capture: "None of the above", capture_note: "只在当前对话截图" } });
  });
  it("answers multiple questions together, including multi-selection and secret text", () => {
    const form: AcpElicitationRequest = { requestKey: "multi", params: { mode: "form", message: "Configure", requestedSchema: {
      type: "object", required: ["targets", "secret"], properties: {
        targets: { type: "array", title: "Screens", minItems: 2, items: { type: "string", enum: ["left", "right"] } },
        secret: { type: "string", title: "Private answer", _meta: { codex: { isSecret: true } } },
      },
    } } };
    const respond = vi.fn(); render(<Harness form={form} onRespond={respond} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "left" }));
    const secret = screen.getByLabelText("Private answer"); expect(secret).toHaveAttribute("type", "password");
    fireEvent.change(secret, { target: { value: "private value" } });
    expect(screen.getByRole("button", { name: sendName() })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "right" }));
    fireEvent.click(screen.getByRole("button", { name: sendName() }));
    expect(respond).toHaveBeenCalledWith({ action: "accept", content: { targets: ["left", "right"], secret: "private value" } });
  });
  it("keeps skip and cancel distinct and never invents an answer", () => {
    const respond = vi.fn(); render(<Harness onRespond={respond} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("agentChatQuestionSkip", { ns: "panes" }) }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("agentChatQuestionDismiss", { ns: "panes" }) }));
    expect(respond.mock.calls).toEqual([[{ action: "decline" }], [{ action: "cancel" }]]);
  });
  it("accepts Claude 0.70.0 custom answers without requiring a selected option", () => {
    // Shape from the pinned adapter's askUserQuestionsToCreateRequest: no required
    // array; the custom field is returned to Claude as the answer for this question.
    const respond = vi.fn();
    render(<Harness onRespond={respond} form={{ requestKey: "claude", params: claudeQuestionForm }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Other" }), { target: { value: "先预览，再决定是否附加" } });
    expect(screen.getAllByRole("radio").every((option) => !(option as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: sendName() }));
    expect(respond).toHaveBeenCalledWith({ action: "accept", content: { question_0_custom: "先预览，再决定是否附加" } });
  });

});

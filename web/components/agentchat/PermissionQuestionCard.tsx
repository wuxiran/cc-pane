import { useState } from "react";
import type { AcpElicitationDraft, AcpPermissionRequest } from "@/types/agentChat";
import QuestionCard from "./QuestionCard";

/** Legacy adapters offer option IDs only. Never pretend they accept free text. */
export default function PermissionQuestionCard({ request, onRespond, responding, error }: {
  request: AcpPermissionRequest;
  onRespond: (optionId: string | null) => void;
  responding?: boolean;
  error?: string | null;
}) {
  const [values, setValues] = useState<AcpElicitationDraft>({});
  return <div className="px-3 pb-3"><QuestionCard
    request={{ requestKey: request.requestKey, params: {
      mode: "form", message: "", requestedSchema: { type: "object", required: ["option"], properties: {
        option: { type: "string", title: request.params.toolCall?.title ?? "", oneOf: (request.params.options ?? []).map((option) => ({ const: option.optionId, title: option.name })) },
      } },
    } }}
    values={values} onChange={setValues} responding={responding} error={error}
    onRespond={(response) => {
      if (response.action !== "accept") onRespond(null);
      else if (typeof response.content.option === "string") onRespond(response.content.option);
    }}
  /></div>;
}

import type { AcpRunEvent } from "@/types/agentRuntime";

type RecordValue = Record<string, unknown>;
export type RunHistoryEntry = {
  id: number;
  kind: "user" | "assistant" | "thought";
  text: string;
  attachments: string[];
} | { id: number; kind: "event"; event: AcpRunEvent };

function object(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

function promptEntry(event: AcpRunEvent): RunHistoryEntry {
  const blocks = object(event.payload).prompt;
  const text: string[] = [];
  const attachments: string[] = [];
  if (Array.isArray(blocks)) for (const block of blocks) {
    const value = object(block);
    if (value.type === "text" && typeof value.text === "string") text.push(value.text);
    else attachments.push(typeof value.name === "string" ? value.name
      : typeof value.uri === "string" ? value.uri : String(value.type ?? "attachment"));
  }
  return { id: event.seq, kind: "user", text: text.join("\n"), attachments };
}

export function chatRunHistoryEntries(events: AcpRunEvent[]): RunHistoryEntry[] {
  const result: RunHistoryEntry[] = [];
  for (const event of events) {
    if (event.kind === "user_prompt") { result.push(promptEntry(event)); continue; }
    const update = object(object(event.payload).update);
    const type = update.sessionUpdate;
    const content = object(update.content);
    const role = type === "agent_message_chunk" ? "assistant" : type === "agent_thought_chunk" ? "thought" : null;
    if (event.kind === "update" && role && content.type === "text" && typeof content.text === "string") {
      const previous = result[result.length - 1];
      if (previous?.kind === role) previous.text += content.text;
      else result.push({ id: event.seq, kind: role, text: content.text, attachments: [] });
    } else result.push({ id: event.seq, kind: "event", event });
  }
  return result;
}

/** Omit embedded image bytes and cap collapsed diagnostic output when opened. */
export function historyEventDetails(payload: unknown): string {
  const text = JSON.stringify(payload, (key, value: unknown) =>
    key === "data" && typeof value === "string" && value.length > 256 ? `[${value.length} bytes omitted]` : value, 2) ?? "null";
  return text.length > 65536 ? `${text.slice(0, 65536)}\n…` : text;
}

export function historyEventTitle(event: AcpRunEvent): string {
  const payload = object(event.payload);
  const update = object(payload.update);
  if (typeof update.title === "string") return update.title;
  if (typeof update.sessionUpdate === "string") return update.sessionUpdate;
  if (typeof payload.terminalId === "string") return `${event.kind} · ${payload.terminalId}`;
  return event.kind;
}

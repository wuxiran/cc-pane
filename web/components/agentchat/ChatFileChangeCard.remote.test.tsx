import "@/i18n";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useAgentChatRemoteStore } from "@/stores/useAgentChatRemoteStore";
import type { AcpToolCall } from "@/types/agentChat";
import ToolCallCard from "./ToolCallCard";

vi.mock("@/services/agentEditService", () => ({ undoAgentFileEdit: vi.fn() }));
vi.mock("@/services/agentChatService", () => ({ computeTextDiff: vi.fn() }));

const chatId = "remote-edit-card-test";
const call: AcpToolCall = { toolCallId: "edit-one", title: "Apply change", status: "completed", content: [{ type: "diff", path: "/srv/app/file.ts", oldText: "before", newText: "after" }] };

afterEach(() => {
  useAgentChatStore.getState().dropChat(chatId);
  useAgentChatRemoteStore.getState().setTarget(chatId, null);
});

describe("remote file change card", () => {
  it("offers no local undo for edits made on a remote machine", () => {
    useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "claude", acpSessionId: "session", phase: "ready" });
    useAgentChatRemoteStore.getState().setTarget(chatId, {
      machineId: "m1", machineName: "box", host: "10.0.0.2", cwd: "/srv/app", os: "linux",
      probe: { status: "reachable", latencyMs: 1 }, probeSeq: 1,
    });
    render(<ToolCallCard call={call} chatId={chatId} />);
    expect(screen.getByTestId("chat-file-change")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^(撤销|Undo)$/ })).not.toBeInTheDocument();
  });
});

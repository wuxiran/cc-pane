import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AgentChatView from "./AgentChatView";

vi.mock("@/services/agentTranscriptService", () => ({
  agentTranscriptService: {
    read: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && "shown" in opts) return `${opts.shown}/${opts.total}`;
      if (opts && "error" in opts) return `fail:${opts.error}`;
      return key;
    },
  }),
}));

import { agentTranscriptService } from "@/services/agentTranscriptService";

const readMock = agentTranscriptService.read as ReturnType<typeof vi.fn>;

describe("AgentChatView", () => {
  beforeEach(() => {
    readMock.mockReset();
  });

  it("shows no-resume empty state without calling service", async () => {
    render(
      <AgentChatView cliTool="grok" resumeId={null} cwd="D:\\x" onBackToTerminal={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByText("chatNoResumeId")).toBeInTheDocument();
    });
    expect(readMock).not.toHaveBeenCalled();
  });

  it("shows unsupported for non-grok cli", async () => {
    render(
      <AgentChatView
        cliTool="claude"
        resumeId="sess-1"
        cwd="D:\\x"
        onBackToTerminal={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("chatUnsupported")).toBeInTheDocument();
    });
    expect(readMock).not.toHaveBeenCalled();
  });

  it("renders messages from service", async () => {
    readMock.mockResolvedValue({
      messages: [
        { id: "1", role: "user", text: "hello plan" },
        { id: "2", role: "assistant", text: "long answer" },
      ],
      truncated: false,
      totalEstimate: 2,
    });
    render(
      <AgentChatView
        cliTool="grok"
        resumeId="40675d34-0812-4b7f-8b42-08e017efaf46"
        cwd="I:\\vms-workspace"
        onBackToTerminal={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("hello plan")).toBeInTheDocument();
    });
    expect(screen.getByText("long answer")).toBeInTheDocument();
    expect(readMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cliTool: "grok",
        resumeSessionId: "40675d34-0812-4b7f-8b42-08e017efaf46",
      }),
    );
  });

  it("back button calls onBackToTerminal", async () => {
    readMock.mockResolvedValue({ messages: [], truncated: false, totalEstimate: 0 });
    const onBack = vi.fn();
    render(
      <AgentChatView cliTool="grok" resumeId="sess-1" cwd="D:\\x" onBackToTerminal={onBack} />,
    );
    await waitFor(() => expect(screen.getByTestId("agent-chat-back")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("agent-chat-back"));
    expect(onBack).toHaveBeenCalled();
  });
});

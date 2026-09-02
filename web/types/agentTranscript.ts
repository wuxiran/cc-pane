export type TranscriptRole = "user" | "assistant" | "reasoning" | "tool";

export type AgentTranscriptErrorCode =
  | "notFound"
  | "unsupportedCli"
  | "parseError"
  | "ioError"
  | "invalidSessionId";

export interface TranscriptMessage {
  id: string;
  role: TranscriptRole;
  text: string;
  toolName?: string;
  timestampMs?: number;
}

export interface ReadAgentTranscriptParams {
  cliTool: string;
  resumeSessionId: string;
  cwd?: string | null;
  limit?: number | null;
  offsetFromEnd?: number | null;
}

export interface ReadAgentTranscriptResult {
  messages: TranscriptMessage[];
  filePath?: string | null;
  totalEstimate?: number | null;
  truncated: boolean;
  errorCode?: AgentTranscriptErrorCode | null;
  errorMessage?: string | null;
}

/** CLIs that expose a readable on-disk transcript for the Chat view. */
export const TRANSCRIPT_SUPPORTED_CLI_TOOLS = new Set(["grok"]);

export function isTranscriptSupportedCliTool(cliTool: string | null | undefined): boolean {
  if (!cliTool) return false;
  return TRANSCRIPT_SUPPORTED_CLI_TOOLS.has(cliTool.trim().toLowerCase());
}

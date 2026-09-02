import type {
  ReadAgentTranscriptParams,
  ReadAgentTranscriptResult,
} from "@/types/agentTranscript";
import { invokeOrApi } from "./apiClient";

export const agentTranscriptService = {
  async read(params: ReadAgentTranscriptParams): Promise<ReadAgentTranscriptResult> {
    return invokeOrApi<ReadAgentTranscriptResult>(
      "read_agent_transcript_cmd",
      { params },
      async () => {
        // Web/API 对称路由尚未接线：桌面主路径走 Tauri。
        return {
          messages: [],
          truncated: false,
          errorCode: "unsupportedCli",
          errorMessage: "agent transcript is only available in the desktop app",
        };
      },
    );
  },
};

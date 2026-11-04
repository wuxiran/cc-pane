import type {
  ReadAgentTranscriptParams,
  ReadAgentTranscriptResult,
} from "@/types/agentTranscript";
import { invoke } from "@tauri-apps/api/core";
import { invokeOrApi } from "./apiClient";

export const agentTranscriptService = {
  /** 把原始记录文件复制到 destination。仅桌面端，由调用方先判断 runtime。 */
  async exportRaw(params: {
    cliTool: string;
    resumeSessionId: string;
    cwd?: string | null;
    destination: string;
  }): Promise<number> {
    return invoke<number>("export_agent_transcript_cmd", params);
  },
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

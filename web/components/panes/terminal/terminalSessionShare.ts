// 终端右键「复制 / 导出」用到的纯函数：把一个会话转成可分享的文本。
import type { ReadAgentTranscriptResult, TranscriptMessage } from "@/types/agentTranscript";

export interface TerminalSessionShareInfo {
  cliTool?: string;
  resumeId?: string;
  ptySessionId?: string | null;
  cwd?: string;
  projectPath?: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  launchProfileId?: string;
  runtime: "local" | "wsl" | "ssh";
}

const SAFE_RESUME_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isShareableResumeId(id: string | undefined | null): id is string {
  return Boolean(id && id !== "new" && SAFE_RESUME_ID.test(id));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 只支持明确知道恢复语法的 CLI；其他 CLI 返回 null，不猜命令。 */
export function buildResumeCommand(info: TerminalSessionShareInfo): string | null {
  if (!isShareableResumeId(info.resumeId)) return null;
  const resume =
    info.cliTool === "claude"
      ? `claude --resume ${info.resumeId}`
      : info.cliTool === "codex"
        ? `codex resume ${info.resumeId}`
        : null;
  if (!resume) return null;
  // WSL/SSH 的 cwd 不一定能在粘贴命令的那台机器上解析，不带 cd。
  return info.runtime === "local" && info.cwd
    ? `cd ${shellQuote(info.cwd)} && ${resume}`
    : resume;
}

/** 白名单字段：launchExtras 里可能有 prompt 与环境变量，绝不整体序列化。 */
export function buildSessionInfoJson(info: TerminalSessionShareInfo): string {
  return JSON.stringify(
    {
      cliTool: info.cliTool ?? null,
      resumeId: isShareableResumeId(info.resumeId) ? info.resumeId : null,
      ptySessionId: info.ptySessionId ?? null,
      cwd: info.cwd ?? null,
      projectPath: info.projectPath ?? null,
      workspaceName: info.workspaceName ?? null,
      providerId: info.providerId ?? null,
      modelId: info.modelId ?? null,
      launchProfileId: info.launchProfileId ?? null,
      runtime: info.runtime,
    },
    null,
    2,
  );
}

/** 链接里放 projectPath 而不是 cwd：接收方只放行已注册项目，worktree 路径不在其中。 */
export function buildSessionDeepLink(
  info: TerminalSessionShareInfo,
  scheme: string = import.meta.env.DEV ? "ccpanes-dev" : "ccpanes",
): string | null {
  if (!isShareableResumeId(info.resumeId) || !info.projectPath || info.runtime !== "local") {
    return null;
  }
  if (info.cliTool !== "claude" && info.cliTool !== "codex") return null;
  const query = new URLSearchParams({
    cli: info.cliTool,
    id: info.resumeId,
    project: info.projectPath,
  });
  return `${scheme}://v1/session?${query.toString()}`;
}

/** 只保留对话和工具调用名；推理与工具输出体积大、还可能带敏感内容。 */
export function transcriptToMarkdown(messages: TranscriptMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      blocks.push(`## User\n\n${message.text.trim()}`);
    } else if (message.role === "assistant") {
      blocks.push(`## Assistant\n\n${message.text.trim()}`);
    } else if (message.role === "tool" && message.toolName) {
      blocks.push(`> Tool: \`${message.toolName}\``);
    }
  }
  return blocks.join("\n\n");
}

const TRANSCRIPT_PAGE_SIZE = 2_000;
const MAX_TRANSCRIPT_PAGES = 50;

type ReadTranscript = (params: {
  cliTool: string;
  resumeSessionId: string;
  cwd?: string;
  limit: number;
  beforeMessageId?: string;
}) => Promise<ReadAgentTranscriptResult>;

/** 向前翻页取全量。历史翻页接口是倒序窗口，这里按对话顺序拼回去。 */
export async function readWholeTranscript(
  read: ReadTranscript,
  params: { cliTool: string; resumeSessionId: string; cwd?: string },
): Promise<TranscriptMessage[]> {
  const pages: TranscriptMessage[][] = [];
  let beforeMessageId: string | undefined;
  for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page += 1) {
    const result = await read({ ...params, limit: TRANSCRIPT_PAGE_SIZE, beforeMessageId });
    if (result.errorCode) {
      throw new Error(result.errorMessage ?? result.errorCode);
    }
    pages.unshift(result.messages);
    if (!result.hasEarlier || !result.nextBeforeMessageId) break;
    beforeMessageId = result.nextBeforeMessageId;
  }
  return pages.flat();
}

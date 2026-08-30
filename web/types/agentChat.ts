// ACP（Agent Client Protocol）chat 类型。
//
// 线格式是 ACP v1 的子集镜像：Rust 侧（acp_chat_service.rs）把 `session/update`
// 的 params 原样透传过来，这里只给渲染层需要的字段建型。**未知变体不丢弃**——
// ACP 正处 v1→v2 过渡期，未知 sessionUpdate 要以降级形态可见，不能静默消失。

/** 会话进程相位（Rust AcpChatPhase 的镜像）。 */
export type AcpChatPhase = "starting" | "ready" | "generating" | "exited" | "failed";

/** ACP SessionMode（id 必有，name/description 尽力）。 */
export interface AcpSessionMode {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpSessionModeState {
  currentModeId?: string;
  availableModes?: AcpSessionMode[];
}

export interface AcpSessionModel {
  modelId: string;
  name?: string;
  description?: string;
}

export interface AcpSessionModelState {
  currentModelId?: string;
  availableModels?: AcpSessionModel[];
}

/** Rust AcpChatSnapshot 的镜像。 */
export interface AcpChatSnapshot {
  chatId: string;
  engineId: string;
  phase: AcpChatPhase;
  acpSessionId?: string;
  agentCapabilities?: unknown;
  /** initialize 协商出的 ACP 协议版本（当前恒 1；v2 适配时的分叉依据）。 */
  protocolVersion?: number;
  /** 会话模式（审批行为/plan 等），引擎不广告时缺失。 */
  modes?: AcpSessionModeState;
  /** 模型选择，引擎不广告时缺失。 */
  models?: AcpSessionModelState;
  exitCode?: number;
  error?: string;
}

/** 引擎注册表条目（Rust AcpEngineInfo 的镜像）。 */
export interface AcpEngineInfo {
  id: string;
  label: string;
  available: boolean;
  requirement: string;
}

/** 后端事件信封（`acp-chat-event`）。payload 形状由 kind 决定。 */
export interface AcpChatEvent {
  chatId: string;
  kind: string;
  payload: unknown;
}

/** ACP ContentBlock 子集：MVP 只渲染 text，其余变体降级为占位文本。 */
export interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** ACP ToolCallContent：content（嵌 ContentBlock）与 diff 两种已建型。 */
export interface AcpToolCallContent {
  type: string;
  content?: AcpContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
  [key: string]: unknown;
}

/** tool_call / tool_call_update 的合并视图（按 toolCallId 就地更新）。 */
export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[];
  locations?: { path: string; line?: number }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpPlanEntry {
  content: string;
  priority?: string;
  status?: string;
}

/** `session/update` 通知的 params（sessionUpdate 为判别键）。
 *
 * `content` 按变体携带两种形态：`agent_*_chunk` 是单个 ContentBlock，
 * `tool_call` / `tool_call_update` 是 ToolCallContent 数组——所以这里是
 * union 而不是交叉（交叉会得到一个不可能满足的类型），消费点用
 * `Array.isArray` 收窄。 */
export interface AcpSessionUpdate {
  sessionId?: string;
  update?: {
    sessionUpdate: string;
    content?: AcpContentBlock | AcpToolCallContent[];
    entries?: AcpPlanEntry[];
    [key: string]: unknown;
  } & Partial<Omit<AcpToolCall, "content">>;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

/** `permission_request` 事件的 payload。 */
export interface AcpPermissionRequest {
  requestKey: string;
  params: {
    sessionId?: string;
    toolCall?: Partial<AcpToolCall>;
    options?: AcpPermissionOption[];
    [key: string]: unknown;
  };
}

/** agent 广告的斜杠命令（available_commands_update）。 */
export interface AcpAvailableCommand {
  name: string;
  description?: string;
  input?: unknown;
}

/** 会话历史元数据（Rust list_chat_history 的条目镜像）。 */
export interface AcpChatHistoryEntry {
  acpSessionId: string;
  engineId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** 发送附件。image：data 为 base64（不带 dataURL 前缀）；file：只带
 * path，发送时转 resource_link（不内嵌内容）。kind 缺省 = image。 */
export interface AgentChatAttachment {
  name: string;
  mimeType: string;
  data: string;
  kind?: "image" | "file";
  path?: string;
}

/** 渲染层消息条目。tool_call 按 toolCallId 就地合并；plan 整表替换。 */
export type AgentChatItem =
  | { type: "user"; id: string; text: string; attachmentLabels?: string[] }
  | { type: "assistant"; id: string; text: string }
  | { type: "thought"; id: string; text: string }
  | { type: "image"; id: string; mimeType: string; data: string }
  | { type: "tool_call"; id: string; call: AcpToolCall }
  | { type: "plan"; id: string; entries: AcpPlanEntry[] }
  | { type: "notice"; id: string; text: string };

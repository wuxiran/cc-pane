// IM 渠道设置类型（镜像 cc-notify ChannelConfig / cc-panes-core ImSettings）。
// 从 settings.ts 抽出以遵守行数棘轮；settings.ts 原样再导出。

/** IM 外推渠道类型（镜像 cc-notify ChannelType） */
export type ImChannelType =
  | "webhook"
  | "telegram"
  | "dingtalk"
  | "wecom"
  | "lark"
  | "slack";

/** IM 外推事件 kind（与后端 NotificationService kind 同口径） */
export type ImEventKind = "turn_end" | "waiting_input" | "error" | "session_exited";

/** IM 外推渠道配置（镜像 cc-notify ChannelConfig） */
export interface ImChannelConfig {
  id: string;
  channelType: ImChannelType;
  name: string;
  url: string;
  token: string | null;
  /** 钉钉加签 / 飞书签名校验 secret */
  secret: string | null;
  chatId: string | null;
  /** 订阅的事件 kind；空数组 = 全部 */
  events: string[];
  enabled: boolean;
  /** 入站：接收该渠道的消息交给 Bot（目前仅 Telegram）。 */
  inboundEnabled?: boolean;
  /** 入站消息默认交给的 Bot；空 = 第一个。 */
  defaultBotId?: string | null;
}

/** IM 外推通知设置（镜像 cc-panes-core ImSettings）。与桌面通知分离：默认聚焦时也推。 */
export interface ImSettings {
  enabled: boolean;
  pushWhenFocused: boolean;
  channels: ImChannelConfig[];
}

/** IM 渠道最近一次发送结果（get_im_bridge_status / im-channel-result 事件载荷） */
export interface ImChannelStatus {
  channelId: string;
  channelName: string;
  kind: string;
  ok: boolean;
  error: string | null;
  /** RFC3339 */
  at: string;
}

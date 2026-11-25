// 内置组件 · 微信：把随包的 cc-wechat-mcp（或经 SSH 转发的远程组件）登记成名为 wechat 的共享 MCP。
import type { SharedMcpServerInfo } from "@/types";
import { invokeOrApi } from "./apiClient";

export type WechatMode = "off" | "local" | "remote" | "custom";

export interface WechatRemote {
  /** user@host、host 或 ~/.ssh/config 里的别名 */
  target: string;
  sshPort?: number;
  identityFile?: string;
  /** 远端 Windows 上微信组件监听的端口 */
  remotePort: number;
}

export interface WechatComponentStatus {
  /** 本机能否直接读微信（仅 Windows） */
  localSupported: boolean;
  binaryFound: boolean;
  mode: WechatMode;
  remote: WechatRemote | null;
  server: SharedMcpServerInfo | null;
}

/** 组件 wechat_status 工具的原样返回；只列界面用到的字段 */
export interface WechatCheckResult {
  ok: boolean;
  running?: boolean;
  pid?: number;
  message_dbs?: string[];
  error?: string;
}

/** 与后端 wechat_component::DEFAULT_PORT 保持一致 */
export const WECHAT_DEFAULT_PORT = 3120;
export const WECHAT_SERVER_NAME = "wechat";

const desktopOnly = async (): Promise<never> => {
  throw new Error("The WeChat component is only available in the desktop app");
};

export const wechatComponentService = {
  status(): Promise<WechatComponentStatus> {
    return invokeOrApi<WechatComponentStatus>("wechat_component_status", undefined, desktopOnly);
  },
  enableLocal(): Promise<WechatComponentStatus> {
    return invokeOrApi<WechatComponentStatus>("wechat_component_enable_local", undefined, desktopOnly);
  },
  enableRemote(remote: WechatRemote): Promise<WechatComponentStatus> {
    return invokeOrApi<WechatComponentStatus>("wechat_component_enable_remote", { remote }, desktopOnly);
  },
  disable(): Promise<WechatComponentStatus> {
    return invokeOrApi<WechatComponentStatus>("wechat_component_disable", undefined, desktopOnly);
  },
  check(): Promise<WechatCheckResult> {
    return invokeOrApi<WechatCheckResult>("wechat_component_check", undefined, desktopOnly);
  },
};

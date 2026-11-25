// 内置组件 · 飞书 CLI（官方 @larksuite/cli）：安装、应用配置、登录授权、把官方 Skills 装进技能库。
import { invokeOrApi } from "./apiClient";

export type FeishuJobKind = "install" | "config" | "login" | "skills";
export type FeishuJobStage = "running" | "done" | "error" | "cancelled";
export type FeishuBrowserStep = "config" | "login";

export interface FeishuJob {
  kind: FeishuJobKind;
  stage: FeishuJobStage;
  /** 需要用户在浏览器里打开的授权链接 */
  url: string | null;
  done: number;
  total: number;
  error: string | null;
}

export interface FeishuStatus {
  npmFound: boolean;
  installed: boolean;
  version: string | null;
  /** 已创建/绑定飞书应用 */
  configured: boolean;
  appId: string | null;
  brand: string | null;
  /** user = 已登录；bot = 只有应用身份；none = 都没有 */
  identity: string | null;
  skillsInstalled: string[];
  skillsTotal: number;
  job: FeishuJob | null;
}

const desktopOnly = async (): Promise<never> => {
  throw new Error("The Feishu CLI component is only available in the desktop app");
};

export const feishuCliService = {
  status(): Promise<FeishuStatus> {
    return invokeOrApi<FeishuStatus>("feishu_cli_status", undefined, desktopOnly);
  },
  install(): Promise<void> {
    return invokeOrApi<void>("feishu_cli_install", undefined, desktopOnly);
  },
  start(step: FeishuBrowserStep): Promise<void> {
    return invokeOrApi<void>("feishu_cli_start", { step }, desktopOnly);
  },
  installSkills(): Promise<void> {
    return invokeOrApi<void>("feishu_cli_install_skills", undefined, desktopOnly);
  },
  cancel(): Promise<void> {
    return invokeOrApi<void>("feishu_cli_cancel", undefined, desktopOnly);
  },
  logout(): Promise<void> {
    return invokeOrApi<void>("feishu_cli_logout", undefined, desktopOnly);
  },
};

// 登录状态的一行摘要（运行配置页的凭证字段用）：「已认证 · Claude Team · wu***@example.com」
// / 「未登录 · 在终端运行 claude 登录」。邮箱一律打码。
import type { TFunction } from "i18next";
import type { LoginAccountCliTool, LoginAccountStatus } from "@/types/provider";
import { maskEmail } from "@/utils/maskEmail";

/** 提示用户在终端里跑的登录命令（只是提示文案，不执行）。 */
const LOGIN_COMMAND_HINT: Record<LoginAccountCliTool, string> = {
  claude: "claude",
  codex: "codex login",
  gemini: "gemini",
  antigravity: "agy",
  grok: "grok",
};

export function loginCommandHint(cliTool: LoginAccountCliTool): string {
  return LOGIN_COMMAND_HINT[cliTool];
}

export type LoginSummaryTone = "ok" | "warn" | "muted";

export function loginStatusSummary(
  status: LoginAccountStatus,
  cliTool: LoginAccountCliTool,
  t: TFunction<"providers">,
): { text: string; tone: LoginSummaryTone } {
  if (status.state === "logged_in") {
    const head = status.plan
      ? t("providerAccounts.login.state.authenticatedPlan", { plan: status.plan })
      : t("providerAccounts.login.state.authenticated");
    const text = status.identity ? `${head} · ${maskEmail(status.identity)}` : head;
    return { text, tone: "ok" };
  }
  if (status.state === "not_logged_in") {
    return {
      text: t("providerAccounts.login.state.notLoggedInRun", { command: loginCommandHint(cliTool) }),
      tone: "warn",
    };
  }
  return { text: t("providerAccounts.login.state.unknown"), tone: "muted" };
}

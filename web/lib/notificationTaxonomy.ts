import type { NotificationRecord } from "@/stores/useNotificationStore";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

/**
 * notice —— 普通通知：agent 忙时静默入历史，不弹卡片。
 * askInput —— 等用户输入：agent 等的就是人，闸门几乎全放行（见 interruptGate 矩阵）。
 */
export type NotificationInterruptClass = "notice" | "askInput";

export interface NotificationClassification {
  severity: NotificationSeverity;
  interruptClass: NotificationInterruptClass;
}

/**
 * 后端 5 类内置 kind 的精确映射。MCP/REST 的任意 kind 走子串回退。
 * 分类只看 kind（确定性字段），不再对 title/body 做字符串匹配
 * ——旧 OrchestrationFullView 的 isErrorNotification 靠 title 猜，i18n 一换就失灵。
 */
const KIND_SEVERITY: Record<string, NotificationSeverity> = {
  error: "error",
  session_exited: "warning",
  waiting_input: "warning",
  turn_end: "success",
  task_completed: "success",
  slow_tool: "info",
};

function severityOf(kind: string): NotificationSeverity {
  const exact = KIND_SEVERITY[kind];
  if (exact) return exact;
  const lower = kind.toLowerCase();
  if (lower.includes("error") || lower.includes("fail")) return "error";
  if (lower.includes("warn")) return "warning";
  if (lower.includes("success") || lower.includes("complete") || lower.includes("done")) {
    return "success";
  }
  return "info";
}

export function classifyNotification(
  record: Pick<NotificationRecord, "kind" | "requiresInput">,
): NotificationClassification {
  const interruptClass: NotificationInterruptClass =
    record.requiresInput === true || record.kind === "waiting_input" ? "askInput" : "notice";
  return { severity: severityOf(record.kind), interruptClass };
}

/** 自动消失时长（ms）；null = 不自动消失（error 与 askInput 要等人处理）。 */
export function autoDismissMs(classification: NotificationClassification): number | null {
  if (classification.interruptClass === "askInput") return null;
  if (classification.severity === "error") return null;
  return 8_000;
}

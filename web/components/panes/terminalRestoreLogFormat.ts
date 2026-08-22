/**
 * 恢复日志的人话化：把 `writeTerminalRestoreLog` 落下的结构化事件翻成一句中文/英文，
 * 并给出分级色调。技术细节不丢——原始 event + details 由渲染层的「详情」展开区负责。
 */
import type { TFunction } from "i18next";
import type { TerminalRestoreLogEntry } from "@/stores/useTerminalRestoreLogStore";

export type RestoreLogTone = "info" | "ok" | "warn" | "error";

export interface FormattedRestoreLogEntry {
  /** 本地时间 HH:mm:ss */
  time: string;
  /** 已翻译的人话文案 */
  text: string;
  tone: RestoreLogTone;
  /** 悬停/展开可查的原始记录：事件名 + details JSON */
  raw: string;
}

type PanesT = TFunction<"panes">;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

const MISSING = "__restore_log_missing__";

function tryTranslate(t: PanesT, key: string, params: Record<string, unknown>): string | null {
  const text = (t as unknown as LooseT)(key, { ...params, defaultValue: MISSING });
  if (typeof text !== "string") return null;
  if (text === MISSING || text === key || text.endsWith(`.${key}`)) return null;
  return text;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function formatRestoreLogTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function shortSessionId(value: unknown): string | null {
  const text = asString(value);
  return text ? text.slice(0, 8) : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * 事件名里的 `.` 会被 i18next 当成层级分隔符，这里拍平成 `_`，让文案表保持单层。
 */
function flatKey(event: string): string {
  return event.replace(/\./g, "_");
}

/**
 * 同一事件名下的分支后缀：阻断类取 `reason`，少数事件按结果分叉。
 * 与事件名一起组成 i18n 键 `restoreLog.events.<event>__<variant>`。
 */
function variantOf(event: string, details: Record<string, unknown>): string | null {
  const reason = asString(details.reason);
  if (reason) return reason;
  if (event === "init.saved-session-lookup.end") {
    return details.liveSavedSessionId ? "found" : "missing";
  }
  return null;
}

function toneOf(event: string, details: Record<string, unknown>): RestoreLogTone {
  if (event.endsWith(".failed")) return "error";
  if (event === "identity.blocked" || event === "daemon-snapshot.blocked") return "error";
  if (event.endsWith(".blocked")) return "warn";
  if (event.includes("cancelled")) return "warn";
  if (event === "reconcile.end") {
    return firstNumber(details.blocked) ? "warn" : "ok";
  }
  if (
    event === "attach.end"
    || event === "init.attach.end"
    || event === "identity.accepted"
    || event === "claim.end"
    || event === "init.create.end"
    || event === "activation.create.end"
    || event === "background.backend-create.end"
    || event === "background.restore.ready"
    || event === "cold-restore.kill.end"
    || event === "in-process-session.reattach-ready"
  ) {
    return "ok";
  }
  return "info";
}

function buildParams(
  t: PanesT,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const sourceKey = asString(details.source);
  const source = sourceKey
    ? tryTranslate(t, `restoreLog.source.${sourceKey}`, {}) ?? sourceKey
    : null;
  const sessionId =
    shortSessionId(details.sessionId)
    ?? shortSessionId(details.createdSessionId)
    ?? shortSessionId(details.savedSessionId)
    ?? shortSessionId(details.liveSavedSessionId)
    ?? shortSessionId(details.expectedSavedSessionId);
  // 身份核对的结构化结论：哪一关、哪个字段、三方各是什么值。没有这些，任何一条
  // 校验失败对外都只剩同一句话，只能去翻库——这正是恢复日志被扩充的原因。
  const gateKey = asString(details.gate);
  const gate = gateKey
    ? tryTranslate(t, `restoreLog.gate.${gateKey}`, {}) ?? gateKey
    : null;
  const values =
    details.values && typeof details.values === "object"
      ? Object.entries(details.values as Record<string, unknown>)
          .filter(([, value]) => asString(value) !== null)
          .map(([side, value]) => `${side}=${String(value)}`)
          .join(" / ")
      : "";
  return {
    ...details,
    gate: gate ?? "",
    field: asString(details.field) ?? "",
    // 覆盖 spread 进来的原始对象：直接插值会渲染成 [object Object]
    values,
    count: firstNumber(details.count, details.sessionCount, details.lineCount) ?? 0,
    pending: firstNumber(details.pending) ?? 0,
    active: firstNumber(details.active) ?? 0,
    attached: firstNumber(details.attached) ?? 0,
    skipped: firstNumber(details.skipped) ?? 0,
    blocked: firstNumber(details.blocked) ?? 0,
    // 缺 id 时用 `?`，避免文案里出现空括号。
    sessionId: sessionId ?? "?",
    error: asString(details.error) ?? "",
    source: source ?? "",
  };
}

export function formatRestoreLogEntry(
  entry: TerminalRestoreLogEntry,
  t: PanesT,
): FormattedRestoreLogEntry {
  const details = entry.details ?? {};
  const detailsJson = JSON.stringify(details);
  const params = buildParams(t, details);
  const variant = variantOf(entry.event, details);
  const base = `restoreLog.events.${flatKey(entry.event)}`;
  const keys = variant ? [`${base}__${flatKey(variant)}`, base] : [base];

  let text: string | null = null;
  for (const key of keys) {
    text = tryTranslate(t, key, params);
    if (text) break;
  }
  // 未知事件兜底：原样显示事件名 + details，宁可难读也不丢信息。
  if (!text) {
    text = (t as unknown as LooseT)("restoreLog.unknown", {
      event: entry.event,
      details: detailsJson,
    });
  }

  return {
    time: formatRestoreLogTime(entry.timestamp),
    text,
    tone: toneOf(entry.event, details),
    raw: `${entry.event} ${detailsJson}`,
  };
}

export function restoreLogToneColor(tone: RestoreLogTone): string {
  switch (tone) {
    case "ok":
      return "var(--app-status-success)";
    case "warn":
      return "var(--app-status-warning)";
    case "error":
      return "var(--app-status-danger)";
    default:
      return "var(--app-text-secondary)";
  }
}

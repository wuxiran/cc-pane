import type { SettingsDraft } from "./settingsDraft";

export interface SettingsEdit {
  path: string[];
  value: unknown;
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Track fields actually changed in the form; lists are edited as a whole. */
export function collectSettingsEdits(before: unknown, after: unknown, revision: number, path: string[] = []): SettingsEdit[] {
  // Credentials belong to the password endpoint, including its explicit null clear value.
  if (path[0] === "webAccess" && (path[1] === "passwordHash" || path[1] === "passwordSalt")) return [];
  if (Object.is(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      collectSettingsEdits(before[key], after[key], revision, [...path, key]));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path, value: structuredClone(after), revision }];
}

/** Overlay only pending form fields onto the latest settings, preserving unrelated updates. */
export function applySettingsEdits(base: SettingsDraft, edits: Iterable<SettingsEdit>): SettingsDraft {
  const result = structuredClone(base);
  for (const { path, value } of edits) {
    let target = result as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(target, key) || !isRecord(target[key])) {
        Object.defineProperty(target, key, { value: {}, enumerable: true, writable: true, configurable: true });
      }
      target = target[key] as Record<string, unknown>;
    }
    const key = path[path.length - 1];
    if (value === undefined) delete target[key];
    else Object.defineProperty(target, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

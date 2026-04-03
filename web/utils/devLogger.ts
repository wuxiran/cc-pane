import { info as logInfo } from "@tauri-apps/plugin-log";

function serializeDevPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, (_key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      return value;
    });
  } catch {
    return "\"[unserializable-payload]\"";
  }
}

export function devDebugLog(
  tag: string,
  event: string,
  payload: Record<string, unknown> = {}
): void {
  if (!import.meta.env.DEV) return;

  console.debug(`[${tag}] ${event}`, payload);

  logInfo(`[${tag}] ${event} ${serializeDevPayload(payload)}`).catch(() => {});
}

/** 将错误安全地序列化为字符串（用于写入日志文件） */
export function errorToString(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

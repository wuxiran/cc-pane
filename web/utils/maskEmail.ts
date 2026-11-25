/**
 * 界面上显示账号邮箱时打码：保留本地部分前 2 个字符和完整域名，如 `wu***@example.com`。
 * 不像邮箱的值（没有 `@`、`@` 在开头或结尾）原样返回——那是账号名而不是邮箱。
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${Array.from(local).slice(0, 2).join("")}***@${domain}`;
}

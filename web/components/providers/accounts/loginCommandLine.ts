// 把后端给的登录命令（`LoginCommand`：命令、参数、要加的变量、要去掉的变量）拼成当前平台
// 终端里能直接执行的一行。变量只作用于这一条命令，不污染用户的 shell。
//
// - POSIX：`env -u X NAME='v' 'cmd' 'arg'`，单引号包裹，内部单引号写成 `'\''`。
// - Windows：PowerShell 脚本 `Remove-Item Env:X …; $env:NAME='v'; & 'cmd' 'arg'`
//   （单引号内部 `'` 写成 `''`）。内置终端可能是 cmd / Git Bash / PowerShell，
//   所以真正提交给终端的是 `powershell -EncodedCommand <base64>`，在任何外层 shell 里都不会被二次展开。
import type { LoginCommand } from "@/types/provider";

export type LoginShell = "posix" | "windows";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validNames(names: Iterable<string>): string[] {
  return [...names].filter((name) => ENV_NAME_RE.test(name));
}

function envEntries(command: LoginCommand): [string, string][] {
  const names = new Set(validNames(Object.keys(command.env ?? {})));
  return Object.entries(command.env ?? {}).filter(([name]) => names.has(name));
}

/** 要去掉的变量里，同时又要设置的那些不用去（设置会覆盖）。 */
function removedNames(command: LoginCommand): string[] {
  const setting = new Set(Object.keys(command.env ?? {}));
  return validNames(command.envRemove ?? []).filter((name) => !setting.has(name));
}

export function posixLoginCommandLine(command: LoginCommand): string {
  const invocation = [command.command, ...command.args].map(posixQuote).join(" ");
  const unset = removedNames(command).map((name) => `-u ${name}`);
  const assignments = envEntries(command).map(([name, value]) => `${name}=${posixQuote(value)}`);
  if (unset.length === 0 && assignments.length === 0) return invocation;
  return ["env", ...unset, ...assignments, invocation].join(" ");
}

export function powershellLoginScript(command: LoginCommand): string {
  const parts = [
    ...removedNames(command).map((name) => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`),
    ...envEntries(command).map(([name, value]) => `$env:${name}=${powershellQuote(value)}`),
    `& ${[command.command, ...command.args].map(powershellQuote).join(" ")}`,
  ];
  return parts.join("; ");
}

/** PowerShell `-EncodedCommand` 要的是 UTF-16LE 的 base64。 */
export function encodePowershellCommand(script: string): string {
  let binary = "";
  for (let index = 0; index < script.length; index += 1) {
    const code = script.charCodeAt(index);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary);
}

/** 给人看 / 复制到剪贴板的那一行。 */
export function loginCommandLine(command: LoginCommand, shell: LoginShell): string {
  return shell === "windows" ? powershellLoginScript(command) : posixLoginCommandLine(command);
}

/** 提交给应用内终端执行的那一行。 */
export function loginTerminalCommand(command: LoginCommand, shell: LoginShell): string {
  if (shell !== "windows") return posixLoginCommandLine(command);
  const encoded = encodePowershellCommand(powershellLoginScript(command));
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

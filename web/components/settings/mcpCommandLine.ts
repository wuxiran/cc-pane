export function commandLine(config: { command: string; args: readonly string[] }): string {
  return [config.command, ...config.args].join(" ").trim();
}

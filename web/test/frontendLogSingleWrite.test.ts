// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error 测试运行在 Node；前端 tsconfig 刻意不引入 @types/node。
import { readFileSync } from "node:fs";

// 前端日志双写回归：tauri-plugin-log 开了 `tracing` feature 时，它的 `log` 命令对每条
// 前端日志既 emit 一个 tracing event（经 tracing→log 桥落成
// `[webview][INFO] msg location=".." kv={}`），又写一条 log record
// （`[webview:<location>][INFO] msg`）——cc-panes.log 里每条都是两遍。
// 只保留 log record：它已带 level / target（含 location）/ file / line / key_values。
describe("frontend log single write", () => {
  it("tauri-plugin-log does not enable the tracing feature", () => {
    const cargoToml: string = readFileSync("src-tauri/Cargo.toml", "utf8");
    const line = cargoToml
      .split("\n")
      .find((l: string) => l.trim().startsWith("tauri-plugin-log"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/tracing/);
  });
});

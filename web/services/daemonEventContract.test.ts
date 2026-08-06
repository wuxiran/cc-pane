// 跨界事件契约的双侧一致性守卫（批3 B3-03）。
//
// 这组测试真去**扫源码**，而不是只比对两份 TS 常量——后者只能证明"我抄对了
// 自己"，证明不了 handler 真的存在。docs/45 的事故形态正是「表写着要传、
// 代码里没人接」。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BOUNDARY_EVENTS,
  BOUNDARY_EVENT_NAMES,
  findBoundaryEvent,
  isFrontendListenedEvent,
} from "./daemonEventContract";

const repoRoot = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

describe("契约表自身", () => {
  it("事件名唯一", () => {
    expect(new Set(BOUNDARY_EVENT_NAMES).size).toBe(BOUNDARY_EVENT_NAMES.length);
  });

  it("每条都写了 handler 与理由（空文案等于没写）", () => {
    for (const event of BOUNDARY_EVENTS) {
      expect(event.appHandler.trim(), `${event.name} 缺 handler 说明`).not.toBe("");
      expect(event.rationale.trim(), `${event.name} 缺理由`).not.toBe("");
    }
  });
});

describe("与 Rust 侧契约表键集一致", () => {
  it("**两份表的事件名完全相同**（跨语言无法共享源码，只能靠这条守）", () => {
    const rust = read("cc-panes-core/src/services/boundary_events.rs");

    // 从 Rust 表里抽事件名：常量引用 + 字面量两种写法
    const constNames = [...rust.matchAll(/name:\s*crate::constants::events::(\w+)/g)].map(
      (m) => m[1],
    );
    const literalNames = [...rust.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);

    // 常量名 → 值（从 constants.rs 解析，避免手写映射漂移）
    const constants = read("cc-panes-core/src/constants.rs");
    const resolved = constNames.map((c) => {
      const m = constants.match(new RegExp(`${c}:\\s*&str\\s*=\\s*"([^"]+)"`));
      expect(m, `constants.rs 里找不到 ${c}`).toBeTruthy();
      return m![1];
    });

    expect([...resolved, ...literalNames].sort()).toEqual([...BOUNDARY_EVENT_NAMES].sort());
  });
});

describe("app 侧三处分发都覆盖了契约事件", () => {
  it("Rust per-session 流（DaemonStreamMessage）覆盖 session-ws 类事件", () => {
    const src = read("src-tauri/src/services/terminal_daemon_event_bridge.rs");
    // 未知消息必须有兜底，否则新增事件会让旧 app 反序列化失败
    expect(src).toMatch(/#\[serde\(other\)\]/);

    for (const event of BOUNDARY_EVENTS) {
      if (event.channel === "control") continue;
      // 消息 tag 是事件名去掉 terminal- 前缀后的驼峰（output/exit/killed/desync）
      const tag = event.name.replace(/^terminal-/, "").replace(/^session-/, "");
      expect(src.toLowerCase(), `${event.name} 在 per-session 分发里没有对应变体`).toContain(tag);
    }
  });

  it("Rust control 通道（DaemonControlMessage）覆盖 control 类事件", () => {
    const src = read("src-tauri/src/services/terminal_daemon_control_link.rs");
    expect(src).toMatch(/#\[serde\(other\)\]/);

    for (const event of BOUNDARY_EVENTS) {
      if (event.channel === "session-ws") continue;
      const key = event.name === "notifier" ? "Notifier" : null;
      if (key) {
        expect(src, `${event.name} 在 control 分发里缺变体`).toContain(key);
      }
    }
    // 具名检查两个曾出事故的事件
    expect(src).toContain("ResumeIdDetected");
    expect(src).toContain("LaunchWarning");
  });

  it("前端监听器覆盖所有非 control 事件", () => {
    const src = read("web/services/terminalService.ts");
    for (const event of BOUNDARY_EVENTS) {
      if (!isFrontendListenedEvent(event.name)) continue;
      expect(src, `${event.name} 前端没有监听器`).toContain(event.name);
    }
  });
});

describe("通道语义", () => {
  it("control 类事件不由前端直接监听（Rust 消费后转 WebView 事件）", () => {
    expect(isFrontendListenedEvent("terminal-resume-id-detected")).toBe(false);
    expect(isFrontendListenedEvent("notifier")).toBe(false);
    expect(isFrontendListenedEvent("terminal-output")).toBe(true);
  });

  it("desync 是 emitter 自生成而非 emit 输入（决定了 emit 里不该有它的分支）", () => {
    expect(findBoundaryEvent("terminal-desync")?.origin).toBe("emitter-generated");
  });
});

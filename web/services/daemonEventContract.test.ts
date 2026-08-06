// 跨界事件契约的双侧一致性守卫（批3 B3-03）。
//
// 这组测试真去**扫源码**，而不是只比对两份 TS 常量——后者只能证明"我抄对了
// 自己"，证明不了 handler 真的存在。docs/45 的事故形态正是「表写着要传、
// 代码里没人接」。
import { describe, it, expect } from "vitest";
// 用 Vite 的 raw import 读源码，避开 node:fs（web 的 tsconfig 不含 node 类型）
import rustContract from "../../cc-panes-core/src/services/boundary_events.rs?raw";
import rustConstants from "../../cc-panes-core/src/constants.rs?raw";
import perSessionBridge from "../../src-tauri/src/services/terminal_daemon_event_bridge.rs?raw";
import controlLink from "../../src-tauri/src/services/terminal_daemon_control_link.rs?raw";
import terminalServiceSrc from "./terminalService.ts?raw";
import {
  BOUNDARY_EVENTS,
  BOUNDARY_EVENT_NAMES,
  findBoundaryEvent,
  isFrontendListenedEvent,
} from "./daemonEventContract";



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
    const rust = rustContract;

    // 从 Rust 表里抽事件名：常量引用 + 字面量两种写法
    const constNames = [...rust.matchAll(/name:\s*crate::constants::events::(\w+)/g)].map(
      (m) => m[1],
    );
    const literalNames = [...rust.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);

    // 常量名 → 值（从 constants.rs 解析，避免手写映射漂移）
    const constants = rustConstants;
    const resolved = constNames.map((c) => {
      const m = constants.match(new RegExp(`${c}:\\s*&str\\s*=\\s*"([^"]+)"`));
      expect(m, `constants.rs 里找不到 ${c}`).toBeTruthy();
      return m![1];
    });

    expect([...resolved, ...literalNames].sort()).toEqual([...BOUNDARY_EVENT_NAMES].sort());
  });
});

// Codex 审查 P2：toContain 整文件匹配会被注释骗过（假阳性）。收紧为：
// Rust 侧先抽出 enum 块再逐变体断言；前端断言「事件名出现在 listen 调用里」。
function extractEnumBlock(src: string, enumName: string): string {
  // 朴素切片而非正则：CRLF/属性宏/嵌套花括号都会让「匹配到闭合括号」的正则
  // 变脆。变体断言只需要枚举附近的窗口，2000 字符足够覆盖任何合理的枚举体。
  const start = src.indexOf(`enum ${enumName}`);
  expect(start, `找不到 enum ${enumName}`).toBeGreaterThanOrEqual(0);
  return src.slice(start, start + 2000);
}

/** 事件名 → 各分发处期望的变体名。新增跨界事件必须同步这张表。 */
const EXPECTED_VARIANTS: Record<string, { stream?: string; control?: string }> = {
  "terminal-output": { stream: "Output" },
  "terminal-exit": { stream: "Exit" },
  "session-killed": { stream: "Killed", control: "SessionKilled" },
  "terminal-desync": { stream: "Desync" },
  "terminal-resume-id-detected": { control: "ResumeIdDetected" },
  "terminal-launch-warning": { control: "LaunchWarning" },
  notifier: { control: "Notifier" },
};

describe("app 侧三处分发都覆盖了契约事件", () => {
  it("期望变体表与契约表键集一致（防这张表自己漂移）", () => {
    expect(Object.keys(EXPECTED_VARIANTS).sort()).toEqual([...BOUNDARY_EVENT_NAMES].sort());
  });

  it("Rust per-session 流（DaemonStreamMessage）逐变体断言", () => {
    const enumBlock = extractEnumBlock(perSessionBridge, "DaemonStreamMessage");
    expect(enumBlock).toContain("#[serde(other)]");
    for (const [name, v] of Object.entries(EXPECTED_VARIANTS)) {
      if (!v.stream) continue;
      expect(enumBlock, `${name} 在 DaemonStreamMessage 里缺 ${v.stream} 变体`)
        .toContain(v.stream);
    }
  });

  it("Rust control 通道（DaemonControlMessage）逐变体断言", () => {
    const enumBlock = extractEnumBlock(controlLink, "DaemonControlMessage");
    expect(enumBlock).toContain("#[serde(other)]");
    for (const [name, v] of Object.entries(EXPECTED_VARIANTS)) {
      if (!v.control) continue;
      expect(enumBlock, `${name} 在 DaemonControlMessage 里缺 ${v.control} 变体`)
        .toContain(v.control);
    }
  });

  it("前端监听器：事件名必须出现在 listen 调用里（不是注释里）", () => {
    for (const event of BOUNDARY_EVENTS) {
      if (!isFrontendListenedEvent(event.name)) continue;
      // 切片判断替代正则（多层转义太脆）：带引号的事件名出现处，
      // 其前 150 字符内必须有 listen 调用——排除纯注释里的提及。
      const quoted = `"${event.name}"`;
      let found = false;
      let idx = terminalServiceSrc.indexOf(quoted);
      while (idx !== -1) {
        if (terminalServiceSrc.slice(Math.max(0, idx - 150), idx).includes("listen")) {
          found = true;
          break;
        }
        idx = terminalServiceSrc.indexOf(quoted, idx + 1);
      }
      expect(found, `${event.name} 没有 listen 注册`).toBe(true);
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

describe("销毁口径守卫（坏味道审计 D）", () => {
  it("调用销毁管线的文件禁用窄口径 FromTree（漏 savedSessionId = 孤儿）", async () => {
    // 与本文件其他守卫同款：扫源码而非信约定。当前唯一销毁调用方是
    // LayoutDeleteDialog，白名单为空——新增销毁调用方若用窄口径，这里挂。
    const dialogSrc = (await import("../components/layoutbar/LayoutDeleteDialog.tsx?raw")).default;
    const usesPipeline = dialogSrc.includes("destroySessionsDirectly")
      || dialogSrc.includes("commitResourceDestroy");
    expect(usesPipeline).toBe(true);
    expect(
      dialogSrc.includes("collectTerminalSessionIdsFromTree("),
      "销毁路径出现窄口径调用",
    ).toBe(false);
  });
});

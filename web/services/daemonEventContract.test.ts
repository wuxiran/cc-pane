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
import daemonServer from "../../cc-panes-daemon/src/server.rs?raw";
import terminalServiceSrc from "./terminalService.ts?raw";
import {
  BOUNDARY_EVENTS,
  BOUNDARY_EVENT_NAMES,
  INBOUND_CONTROL_MESSAGES,
  INBOUND_CONTROL_MESSAGE_NAMES,
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

// 表的抽取必须切到 const 块内：模块文档/别的表也会出现 `name: "..."`，
// 全文件扫描会把入站表条目算进出站键集（反之亦然）。
function extractRustConstBlock(src: string, constName: string): string {
  const start = src.indexOf(`pub const ${constName}`);
  expect(start, `找不到 pub const ${constName}`).toBeGreaterThanOrEqual(0);
  // 终止符不带换行前缀：单元素表 rustfmt 会折成 `}];` 单行
  const end = src.indexOf("];", start);
  expect(end, `${constName} 未找到闭合 ];`).toBeGreaterThan(start);
  return src.slice(start, end + 2);
}

describe("与 Rust 侧契约表键集一致", () => {
  it("**两份表的事件名完全相同**（跨语言无法共享源码，只能靠这条守）", () => {
    const rust = extractRustConstBlock(rustContract, "BOUNDARY_EVENTS");

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
  // 结构性终点：从枚举声明切到其后**首个行首 `}`**（Rust 顶层枚举的闭合括号
  // 必在列 0；变体的内层 `}` 都有缩进）。不用正则匹配嵌套括号——CRLF/属性宏
  // 都会让它变脆。
  const start = src.indexOf(`enum ${enumName}`);
  expect(start, `找不到 enum ${enumName}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  expect(end, `enum ${enumName} 未找到行首闭合括号`).toBeGreaterThan(start);
  return src.slice(start, end + 2);
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
  "terminal-checkpoint-request": { control: "CheckpointRequest" },
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
      // 带引号的事件名出现处，其前若干字符内必须有 listen 调用——排除纯
      // 注释里的提及。窗口取 listen<泛型>( 换行到参数行的最大合理跨度；
      // 失败模式：注册写法重构到超过窗口 → 本测试假红（loud，可调大）。
      const LISTEN_PROXIMITY_CHARS = 150;
      const quoted = `"${event.name}"`;
      let found = false;
      let idx = terminalServiceSrc.indexOf(quoted);
      while (idx !== -1) {
        if (terminalServiceSrc.slice(Math.max(0, idx - LISTEN_PROXIMITY_CHARS), idx).includes("listen")) {
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

  it("desync 是 emit 输入（reader 看门狗/合批溢出经 emit 发，emit 里必须有它的分支）", () => {
    // 0.12.7 教训：这条测试曾断言 origin 是 emitter-generated、「emit 里不该有
    // 它的分支」——把 bug 写成了规格。reader 线程经 emit 发 desync 的两处调用
    // 因此全落 `_ => {}`，daemon 模式下 Stage 4 看门狗与合批溢出补救全部静默失效。
    expect(findBoundaryEvent("terminal-desync")?.origin).toBe("emit");
  });
});

describe("入站方向（app → daemon）契约", () => {
  it("与 Rust 侧 INBOUND_CONTROL_MESSAGES 键集一致", () => {
    const block = extractRustConstBlock(rustContract, "INBOUND_CONTROL_MESSAGES");
    const names = [...block.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect([...names].sort()).toEqual([...INBOUND_CONTROL_MESSAGE_NAMES].sort());
  });

  it("daemon 侧每条都有接收点（control-ws：非 Unknown 变体；rest：路由 handler）", () => {
    const enumBlock = extractEnumBlock(daemonServer, "ControlInboundMessage");
    expect(enumBlock).toContain("#[serde(other)]");
    for (const message of INBOUND_CONTROL_MESSAGES) {
      if (message.channel === "control-ws") {
        const variant = message.name[0].toUpperCase() + message.name.slice(1);
        expect(
          enumBlock,
          `${message.name} 在 ControlInboundMessage 里缺 ${variant} 变体`,
        ).toContain(variant);
      } else {
        // rest 类没有 serde tag，配对物是路由：daemonHandler 里声明的
        // handler fn 必须真的出现在 server.rs 的 route 表附近。
        const fnMatch = message.daemonHandler.match(/^server\.rs (\w+)/);
        expect(fnMatch, `${message.name} 的 daemonHandler 必须以 "server.rs <fn>" 开头`).toBeTruthy();
        expect(
          daemonServer,
          `${message.name} 在 server.rs 里缺 handler fn ${fnMatch![1]}`,
        ).toContain(`async fn ${fnMatch![1]}`);
      }
    }
  });

  it("app 侧发送点真的存在（control-ws：tag 字面量在 control link；rest：命令在 terminal_commands）", async () => {
    for (const message of INBOUND_CONTROL_MESSAGES) {
      if (message.channel === "control-ws") {
        expect(controlLink, `${message.name} 在 control link 里没有发送点`).toContain(
          `"${message.name}"`,
        );
      } else {
        const commandsSrc = (
          await import("../../src-tauri/src/commands/terminal_commands.rs?raw")
        ).default;
        const cmdMatch = message.appSender.match(/terminal_commands::(\w+)/);
        expect(cmdMatch, `${message.name} 的 appSender 必须引用 terminal_commands::<fn>`).toBeTruthy();
        expect(
          commandsSrc,
          `${message.name} 在 terminal_commands.rs 里缺命令 ${cmdMatch![1]}`,
        ).toContain(`pub async fn ${cmdMatch![1]}`);
      }
    }
  });
});

describe("销毁口径守卫（坏味道审计 D）", () => {
  // 全量扫描版。此前这条守卫**硬编码只读 LayoutDeleteDialog.tsx**：新增的销毁
  // 调用方（backendCloseActions / paneRemovalActions 都是后来接上的）根本不在
  // 扫描面内，用窄口径也不会挂——守卫名存实亡。改成扫全部源码后，任何文件只要
  // 同时出现「销毁提交函数」与窄口径 FromTree 就挂，白名单必须写理由。
  const RAW_SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  /** 销毁提交出口：调到它们就意味着这个文件在真杀 PTY。 */
  const DESTROY_COMMIT_PATTERNS = ["destroySessionsDirectly", "commitResourceDestroy"] as const;
  /** 窄口径：不含 savedSessionId，用作杀集会漏杀成孤儿。 */
  const NARROW_COLLECTOR = "collectTerminalSessionIdsFromTree(";

  /** 允许「销毁提交 + 窄口径」共存的文件，必须写清为什么不是杀集。 */
  const ALLOWED_NARROW_IN_DESTROY_FILES: Record<string, string> = {};

  function relativePath(key: string): string {
    return key.replace(/^\.\.\//, "");
  }

  function isScannedFile(path: string): boolean {
    return !/\.test\./.test(path) && !path.startsWith("test/");
  }

  /**
   * 注释必须剥掉再匹配：paneSessions.ts 的文档注释里就写着这条守卫的规则本身
   * （「调用 destroySessionsDirectly/commitResourceDestroy 的文件不得使用本函数」），
   * 不剥的话它会把**规则的说明文字**判成违规，逼人去给一个纯定义文件开白名单。
   */
  function stripComments(content: string): string {
    return content
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ""))
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const entries = Object.entries(RAW_SOURCES)
    .map(([key, content]) => [relativePath(key), stripComments(content)] as const)
    .filter(([path]) => isScannedFile(path));

  const destroyCallers = entries.filter(([path, content]) =>
    // 管线自身的定义文件不算调用方
    path !== "lib/tabLifecycle/destroyPipeline.ts"
    && DESTROY_COMMIT_PATTERNS.some((pattern) => content.includes(pattern)));

  it("扫描面非空且真的覆盖到已知销毁调用方（防扫描器写坏后空转全绿）", () => {
    expect(entries.length).toBeGreaterThan(0);
    const callerPaths = destroyCallers.map(([path]) => path);
    expect(callerPaths).toContain("components/layoutbar/LayoutDeleteDialog.tsx");
    expect(callerPaths).toContain("stores/paneRemovalActions.ts");
    expect(callerPaths).toContain("stores/backendCloseActions.ts");
  });

  it("任何调用销毁管线的文件禁用窄口径 FromTree（漏 savedSessionId = 孤儿）", () => {
    const violations = destroyCallers
      .filter(([path, content]) =>
        content.includes(NARROW_COLLECTOR) && !(path in ALLOWED_NARROW_IN_DESTROY_FILES))
      .map(([path]) => path);

    expect(
      violations,
      `销毁路径出现窄口径调用（改用 collectTerminalSessionIdsWithSaved*，或加白名单并写明理由）:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("判据自检：合成一个违规文件必须被判违规（防 stripComments 剥过头后守卫空转）", () => {
    const synthetic = stripComments([
      "// collectTerminalSessionIdsFromTree( 出现在注释里不算",
      "import { collectTerminalSessionIdsFromTree } from '@/lib/paneSessions';",
      "const ids = collectTerminalSessionIdsFromTree(root);",
      "await destroySessionsDirectly(ids, [], 'user-close');",
    ].join("\n"));
    expect(DESTROY_COMMIT_PATTERNS.some((p) => synthetic.includes(p))).toBe(true);
    expect(synthetic.includes(NARROW_COLLECTOR)).toBe(true);
    // 注释行确实被剥掉了（否则「注释提规则」的文件会被误判）
    expect(synthetic).not.toContain("出现在注释里不算");
  });

  it("白名单不得陈旧（条目已不再命中就必须删掉）", () => {
    const destroyCallerMap = new Map(destroyCallers);
    const stale = Object.entries(ALLOWED_NARROW_IN_DESTROY_FILES)
      .filter(([path]) => !destroyCallerMap.get(path)?.includes(NARROW_COLLECTOR))
      .map(([path, reason]) => `${path}: ${reason}`);

    expect(stale, `移除陈旧的窄口径豁免:\n${stale.join("\n")}`).toEqual([]);
  });
});

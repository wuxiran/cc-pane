/**
 * 设计 Token 防回潮静态测试
 * ============================
 * 目标：阻止硬编码 Tailwind 调色板色类（bg-blue-500、text-red-600 等）回流到
 * web/components/ 源码。所有新增颜色都应使用 web/assets/index.css 中定义的
 * `--app-*` 语义 token（例如 text-[var(--app-status-danger)]、
 * bg-[var(--app-accent)]），而不是具体的 Tailwind 调色板名。
 *
 * 语义映射约定：
 *   - 状态色 success/warning/danger → --app-status-{success,warning,danger}(-bg/-border)
 *   - 信息 / 运行中 / 强调（原 blue）        → --app-accent
 *   - 中性 slate/gray/zinc/...              → --app-text-{primary,secondary,tertiary}
 *                                             / --app-border / --app-hover
 *   - 实心色底上的 text-white / text-black   → on-color 前景，属正常，不在扫描范围
 *
 * 确需保留原始调色板色（品牌图标色、类别区分色、评分金星等无语义 token 对应者），
 * 必须在下方 ALLOWLIST 精确登记（文件相对路径 → 允许的类名集合）并注明理由。
 * 未登记的命中会让本测试失败；已登记但源码中已消失的条目也会失败（防止 allowlist 腐化）。
 *
 * 豁免目录：mobile/（移动端原型页）、ui/（shadcn 基件）；以及 *.test.* 测试文件。
 *
 * 文件后半部分追加「typography tokens」块：守护 index.css 的语义字号阶梯
 * （--text-caption/small/body/title/display/hero）的取值、主题正交性与消费形式。
 */
import { beforeAll, describe, it, expect, vi } from "vitest";

// 调色板色类正则（与迁移任务使用的扫描口径一致）
const PALETTE_CLASS_RE =
  /(?:bg|text|border|ring|fill|stroke|from|via|to|divide|placeholder|hover:bg|hover:text|hover:border)-(?:slate|gray|zinc|neutral|stone|red|rose|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink)(?:-[0-9]+)?(?:\/[0-9]+)?/g;

// 豁免的子目录（相对 web/components/）
const EXEMPT_DIRS = new Set(["mobile", "ui"]);

/**
 * 精确 allowlist：文件相对路径（POSIX 分隔符）→ 允许保留的调色板类名集合。
 * 每一项都是「无对应语义 token、按拍板决定保留原色」的场景。
 */
const ALLOWLIST: Record<string, string[]> = {
  // 评分金星：金色星标是通用「重要度 / 收藏」隐喻，无对应语义 token。
  "memory/MemoryManager.tsx": ["fill-amber-400", "text-amber-400", "hover:text-amber-300"],
  "memory/MemoryPickerDialog.tsx": ["fill-amber-400", "text-amber-400"],
  // 进程类型标签色：区分 CLI / Node / MCP / Other 四类进程，属类别编码。
  "sidebar/ProcessMonitorSection.tsx": [
    "text-blue-400", // claude_cli
    "text-yellow-400", // claude_node
    "text-purple-400", // mcp_server
  ],
  // WSL 默认发行版金色星标：与评分金星同源的「默认 / 收藏」隐喻。
  "sidebar/WslDiscoverDialog.tsx": ["fill-yellow-400", "text-yellow-400"],
};

// 通过 Vite glob 以原始文本载入所有组件源文件（*.ts / *.tsx），
// 避免依赖 node fs 与 @types/node。键形如 "./filetree/FileTreeNode.tsx"。
const RAW_MODULES = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function isScannedFile(key: string): boolean {
  const rel = key.replace(/^\.\//, "");
  if (/\.test\./.test(rel)) return false;
  const top = rel.split("/")[0];
  if (rel.includes("/") && EXEMPT_DIRS.has(top)) return false;
  return true;
}

describe("design tokens (anti-regression)", () => {
  const entries = Object.entries(RAW_MODULES)
    .filter(([key]) => isScannedFile(key))
    .map(([key, content]) => [key.replace(/^\.\//, ""), content] as const);

  it("扫描到组件源文件", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("除 allowlist 外无硬编码调色板色类", () => {
    const violations: string[] = [];
    // 记录每个 allowlist 条目实际命中的类名，用于后续检测腐化
    const seen: Record<string, Set<string>> = {};
    for (const key of Object.keys(ALLOWLIST)) seen[key] = new Set();

    for (const [rel, content] of entries) {
      const allowed = new Set(ALLOWLIST[rel] ?? []);
      const matches = content.match(PALETTE_CLASS_RE) ?? [];
      for (const cls of matches) {
        if (allowed.has(cls)) {
          seen[rel]?.add(cls);
          continue;
        }
        violations.push(`${rel}: ${cls}`);
      }
    }

    // 检测 allowlist 腐化：登记了但源码中已不存在的条目。
    const stale: string[] = [];
    for (const [rel, classes] of Object.entries(ALLOWLIST)) {
      for (const cls of classes) {
        if (!seen[rel]?.has(cls)) stale.push(`${rel}: ${cls}`);
      }
    }

    expect(violations, `未登记的硬编码调色板色类：\n${violations.join("\n")}`).toEqual([]);
    expect(stale, `allowlist 中已失效的条目（请删除）：\n${stale.join("\n")}`).toEqual([]);
  });
});

/* ============================ 语义字号阶梯（typography 2.0） ============================
   守护 index.css :root 中的 --text-{caption,small,body,title,display,hero} 阶梯：
   1. 取值锁定为全库现状众数像素（统计口径见 docs/typography.md）；
   2. 与颜色/密度正交——.dark 与各 [data-theme] 块不得重复定义。命名刻意不走
      --app-* 前缀：colorGuard 的六块同步规则只匹配 --app-* 颜色 token，且
      --app-text-* 命名空间已被文字颜色 token（--app-text-primary 等）占用；
   3. 消费形式必须是 text-[length:var(--text-*)]——Tailwind 4 把裸
      text-[var(--text-*)] 编译为 color 而非 font-size（实测 4.1.18），全库禁止；
   4. 六个示范文件（ui/button、ui/badge、ui/input、ui/label、StatusBar、TitleBar）
      的消费点与「未阶梯化、必须原样保留」的现状值逐一点名，防止顺手改字号。
   与 densityTokens.test.ts 同口径经 node:fs 读 index.css（?raw 导入拿不到内容）。 */

let indexCss = "";

beforeAll(async () => {
  const fs = await vi.importActual<{
    readFileSync(path: string, encoding: "utf8"): string;
  }>("node:fs");
  indexCss = fs.readFileSync("web/assets/index.css", "utf8");
});

const TYPE_SCALE = [
  ["--text-caption", "11px"],
  ["--text-small", "12px"],
  ["--text-body", "14px"],
  ["--text-title", "15px"],
  ["--text-display", "20px"],
  ["--text-hero", "30px"],
] as const;

/**
 * 已接入阶梯的示范文件消费契约：
 *   uses    —— 必须出现的 token 消费片段（含行高配套，见 docs/typography.md）；
 *   removed —— 必须消散的、已被阶梯精确替换的裸类（防止回流）；
 *   kept    —— 未阶梯化的现状值，必须原样保留（防止顺手改字号）。
 */
const TYPE_CONSUMERS: Record<string, { uses: string[]; removed: RegExp[]; kept: string[] }> = {
  "ui/button.tsx": {
    uses: [
      "text-[length:var(--text-body)] leading-5",
      "text-[length:var(--text-small)] leading-4",
    ],
    removed: [/\btext-xs\b/, /\btext-sm\b/],
    kept: [],
  },
  "ui/badge.tsx": {
    uses: ["text-[length:var(--text-small)] leading-4"],
    removed: [/\btext-xs\b/],
    kept: [],
  },
  "ui/input.tsx": {
    uses: ["file:text-[length:var(--text-body)]", "md:text-[length:var(--text-body)]"],
    removed: [/\btext-sm\b/],
    // 16px（text-base）：移动端聚焦防 iOS 自动缩放，阶梯外刻意保留。
    kept: ["text-base"],
  },
  "ui/label.tsx": {
    uses: ["text-[length:var(--text-body)] leading-none"],
    removed: [/\btext-sm\b/],
    kept: [],
  },
  "StatusBar.tsx": {
    uses: ["text-[length:var(--text-caption)]"],
    removed: [/text-\[11px\]/],
    // 10px 未入阶梯（全库 254 处，是否增设 micro 档留待推广期决策），保持原值。
    kept: ["text-[10px]"],
  },
  "TitleBar.tsx": {
    uses: ["text-[length:var(--text-small)]"],
    removed: [/text-\[12px\]/],
    // 13px/12.5px 未入阶梯（body 取众数 14px，见 docs/typography.md），保持原值。
    kept: ["text-[13px]", "text-[12.5px]"],
  },
};

// 裸 text-[var(--text-*)]：缺少 length: 类型提示时 Tailwind 将其判为 color 工具类，
// font-size 静默丢失——属于编译期正确性问题，故对全部非测试组件源文件扫描。
const BARE_TEXT_VAR_RE = /text-\[(?!length:)var\(--text-/g;

/** 与 colorGuard.themeBlock 同口径：提取 selector 首个块的 {} 内容。 */
function themeBlock(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\n)\\s*${escapedSelector}\\s*\\{`).exec(source);
  if (!match) {
    throw new Error(`index.css 缺少 ${selector} 作用域`);
  }
  const open = source.indexOf("{", match.index);
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`index.css 中 ${selector} 作用域未闭合`);
}

function tokenValue(block: string, token: string): string | null {
  const match = new RegExp(`${token.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`).exec(block);
  return match ? match[1].trim() : null;
}

describe("typography tokens", () => {
  const nonTestEntries = Object.entries(RAW_MODULES)
    .map(([key, content]) => [key.replace(/^\.\//, ""), content] as const)
    .filter(([rel]) => !/\.test\./.test(rel));

  it(":root 定义六级字号阶梯且取值锁定现状像素", () => {
    const root = themeBlock(indexCss, ":root");
    for (const [token, expected] of TYPE_SCALE) {
      expect(tokenValue(root, token), `:root 缺少 ${token}`).toBe(expected);
    }
  });

  it("body 基准字号引用 --text-body（单点真源，原硬编码 14px 已收敛）", () => {
    expect(indexCss).toMatch(/body\s*\{[^}]*?font-size:\s*var\(--text-body\)/s);
  });

  it("字号 token 不渗入 .dark 与 [data-theme] 主题块（与颜色正交）", () => {
    const scopes = [
      ".dark",
      ...[...indexCss.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{/gi)].map(
        (match) => `:root[data-theme="${match[1]}"]`,
      ),
    ];
    expect(scopes.length).toBeGreaterThan(1);

    for (const scope of scopes) {
      const block = themeBlock(indexCss, scope);
      for (const [token] of TYPE_SCALE) {
        expect(
          tokenValue(block, token),
          `${scope} 不应定义 ${token}（字号由 :root 单点定义）`,
        ).toBeNull();
      }
    }
  });

  it("示范文件以 text-[length:var(--text-*)] 消费阶梯，未阶梯化值原样保留", () => {
    const byPath = new Map(nonTestEntries);
    for (const [rel, contract] of Object.entries(TYPE_CONSUMERS)) {
      const content = byPath.get(rel);
      expect(content, `未扫描到 ${rel}`).toBeDefined();
      for (const fragment of contract.uses) {
        expect(content, `${rel} 缺少消费片段 ${fragment}`).toContain(fragment);
      }
      for (const pattern of contract.removed) {
        expect(content, `${rel} 仍残留已阶梯化的裸类 ${pattern}`).not.toMatch(pattern);
      }
      for (const fragment of contract.kept) {
        expect(content, `${rel} 的未阶梯化现状值 ${fragment} 被顺手改动`).toContain(fragment);
      }
    }
  });

  it("全库无裸 text-[var(--text-*)]（缺 length: 会被编译成 color）", () => {
    const violations: string[] = [];
    for (const [rel, content] of nonTestEntries) {
      const matches = content.match(BARE_TEXT_VAR_RE) ?? [];
      for (const cls of matches) violations.push(`${rel}: ${cls}`);
    }
    expect(
      violations,
      `裸 var 字号引用（应改为 text-[length:var(...)]）：\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

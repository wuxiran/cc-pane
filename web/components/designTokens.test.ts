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
 */
import { describe, it, expect } from "vitest";

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
  // 文件类型图标的品牌 / 区分色：按扩展名区分文件种类，属信息编码而非主题状态。
  "filetree/FileTreeNode.tsx": [
    "text-slate-400", // 默认文件 / 文本 / 日志
    "text-yellow-500", // JSON
    "text-amber-400", // YAML / TOML / config
    "text-orange-500", // Java / XML / SVG
    "text-emerald-500", // Shell 脚本
    "text-violet-500", // 图片
    "text-amber-600", // 压缩包
    "text-blue-500", // C / C++
    "text-blue-400", // SQL / 其他语言
    "text-blue-600", // Markdown 图标
  ],
  // 评分金星：金色星标是通用「重要度 / 收藏」隐喻，无对应语义 token。
  "memory/MemoryManager.tsx": ["fill-amber-400", "text-amber-400", "hover:text-amber-300"],
  "memory/MemoryPickerDialog.tsx": ["fill-amber-400", "text-amber-400"],
  // 进程类型标签色：区分 CLI / Node / MCP / Other 四类进程，属类别编码。
  "sidebar/ProcessMonitorSection.tsx": [
    "text-blue-400", // claude_cli
    "text-yellow-400", // claude_node
    "text-purple-400", // mcp_server
    "text-slate-400", // other
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

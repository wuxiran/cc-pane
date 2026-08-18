// @vitest-environment node
/**
 * 接一个新 CLI 时，Rust 侧漏改会编译失败；前端这几张表漏改**不会报错**——
 * 只会静默掉色、启动菜单里少一项、或者菜单项显示成裸 i18n key。
 * grok 那次（docs/21:45）是靠人工清单挨个补的，这组测试把清单变成断言。
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error 测试运行在 Node；前端 tsconfig 刻意不引入 @types/node。
import { readFileSync } from "node:fs";

import { CLI_COLOR_VAR } from "@/components/CliToolSelect";
import { SIDEBAR_LAUNCH_CLI_TOOLS } from "@/components/sidebar/launchMenu";
import enSidebar from "@/i18n/locales/en/sidebar.json";
import zhSidebar from "@/i18n/locales/zh-CN/sidebar.json";
import { CLI_TOOL_TABS } from "@/types/provider";
import { KNOWN_CLI_TOOLS } from "@/types/terminal";

/** `none` 不是可启动的 CLI，各表都不该有它的条目。 */
const LAUNCHABLE_CLI_TOOLS = KNOWN_CLI_TOOLS.filter((tool) => tool !== "none");

const indexCss = readFileSync("web/assets/index.css", "utf8");

describe("known CLI tool coverage", () => {
  it("每个 CLI 都有 CliToolSelect 的颜色变量", () => {
    expect(LAUNCHABLE_CLI_TOOLS.filter((tool) => !CLI_COLOR_VAR[tool])).toEqual([]);
  });

  it("每个 CLI 都有 Provider 设置页的 tab", () => {
    const tabIds = CLI_TOOL_TABS.map((tab) => tab.id as string);
    expect(LAUNCHABLE_CLI_TOOLS.filter((tool) => !tabIds.includes(tool))).toEqual([]);
  });

  it("每个 CLI 都在侧边栏启动菜单里", () => {
    const menuIds = SIDEBAR_LAUNCH_CLI_TOOLS.map((item) => item.id);
    expect(LAUNCHABLE_CLI_TOOLS.filter((tool) => !menuIds.includes(tool))).toEqual([]);
  });

  it("启动菜单的 labelKey 在中英文 sidebar 文案里都存在", () => {
    const missing: string[] = [];
    for (const item of SIDEBAR_LAUNCH_CLI_TOOLS) {
      if (!(item.labelKey in enSidebar)) missing.push(`en:${item.labelKey}`);
      if (!(item.labelKey in zhSidebar)) missing.push(`zh-CN:${item.labelKey}`);
    }
    expect(missing).toEqual([]);
  });

  /**
   * per-launch 参数能力位必须**显式声明**，不能靠 `#[serde(default)]` 的 false 兜底。
   *
   * 这三个键（effort/verbose/maxTurns）由各 adapter 的 build_command 自行消费，
   * 不支持的会被静默丢弃——用户选了却毫无效果。实测接入这套机制前，8 个 adapter 里
   * 有 5 个三键一个都不消费，而 UI 一律可点。漏写 = 又一个哑控件，且不会报错。
   */
  it("每个 CLI 都显式声明了三个 per-launch 参数能力位", () => {
    const adapterDir = "cc-cli-adapters/src";
    const missing: string[] = [];
    for (const tool of LAUNCHABLE_CLI_TOOLS) {
      const source = readFileSync(`${adapterDir}/${tool}.rs`, "utf8");
      for (const field of [
        "supports_effort_option",
        "supports_verbose_option",
        "supports_max_turns_option",
      ]) {
        if (!source.includes(`${field}:`)) missing.push(`${tool}.rs: ${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * 亮暗两套都要有。只定义亮色不会报错，但暗色主题下那个 CLI 会继承亮色值，
   * 对比度是错的——正是"不报错的漏"。
   */
  it("每个 CLI 的 --app-cli-* 变量在亮暗两套里都定义了", () => {
    const missing: string[] = [];
    for (const tool of LAUNCHABLE_CLI_TOOLS) {
      const occurrences = indexCss.split(`--app-cli-${tool}:`).length - 1;
      if (occurrences < 2) missing.push(`${tool} (${occurrences} 处定义，需 ≥2)`);
    }
    expect(missing).toEqual([]);
  });
});

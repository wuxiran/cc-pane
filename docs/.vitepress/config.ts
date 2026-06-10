import { defineConfig } from "vitepress";

// CC-Panes 使用手册站点配置
// - 只构建 docs/guide/ 下的用户手册，排除 docs/ 根目录的设计文档
// - 用 rewrites 把 guide/README.md 提升为站点首页（/）
export default defineConfig({
  lang: "zh-CN",
  // 部署到 GitHub Pages 项目站点 wuxiran.github.io/cc-pane/，子路径需设 base
  base: "/cc-pane/",
  title: "CC-Panes 使用手册",
  description: "CC-Panes · 多实例分屏 AI 编排工作台 · 用户使用手册",
  cleanUrls: true,
  // 只构建 index.md 与 guide/**，排除 docs/ 根目录的设计文档与杂项
  srcExclude: [
    "[0-9]*.md",
    "archive-v1.md",
    "claude-code-bridge-remote-control.md",
    "issue-provider-passing-inconsistency.md",
    "linuxdo-post.md",
    "multica-reference-analysis.md",
    "provider-design-decision.md",
    "references.md",
    "remote-control-design.md",
    "marketing/**",
    "bugs/**",
    "prototypes/**",
    "examples/**",
  ],
  themeConfig: {
    nav: [
      { text: "手册目录", link: "/guide/README" },
      { text: "GitHub", link: "https://github.com/wuxiran/cc-pane" },
    ],
    sidebar: [
      {
        text: "入门",
        items: [
          { text: "手册目录", link: "/guide/README" },
          { text: "01 · CC-Panes 是什么", link: "/guide/01-what-is-cc-panes" },
          { text: "02 · 安装与第一次启动", link: "/guide/02-install-and-first-launch" },
          { text: "03 · 核心概念", link: "/guide/03-core-concepts" },
          { text: "04 · 上手五步", link: "/guide/04-getting-started-5-steps" },
          { text: "05 · 终端与分屏", link: "/guide/05-terminal-and-panes" },
        ],
      },
      {
        text: "日常使用",
        items: [
          { text: "06 · 文件浏览与编辑", link: "/guide/06-files-and-editor" },
          { text: "07 · Git 与 Worktree", link: "/guide/07-git-worktree" },
          { text: "08 · Local History", link: "/guide/08-local-history" },
          { text: "09 · Todo / 日志 / Memory", link: "/guide/09-todo-journal-memory" },
          { text: "10 · 设置详解", link: "/guide/10-settings" },
        ],
      },
      {
        text: "高级玩法",
        items: [
          { text: "MCP · 让 AI 自己操控", link: "/guide/mcp-orchestration" },
          { text: "11 · 多实例并行", link: "/guide/11-parallel-run" },
          { text: "12 · Leader / Worker 编排", link: "/guide/12-leader-worker" },
          { text: "13 · Plan → Codex & 评审", link: "/guide/13-plan-to-codex" },
          { text: "14 · Resume 恢复会话", link: "/guide/14-resume" },
          { text: "15 · WSL / SSH 远程", link: "/guide/15-wsl-ssh" },
        ],
      },
      {
        text: "参考",
        items: [
          { text: "附录 A · 数据与排障", link: "/guide/appendix-a-data-and-troubleshooting" },
          { text: "附录 B · 快捷键速查", link: "/guide/appendix-b-shortcuts" },
          { text: "附录 C · 常见问题", link: "/guide/appendix-c-faq" },
        ],
      },
    ],
    outline: { label: "本页目录", level: [2, 3] },
    docFooter: { prev: "上一篇", next: "下一篇" },
    socialLinks: [{ icon: "github", link: "https://github.com/wuxiran/cc-pane" }],
  },
});

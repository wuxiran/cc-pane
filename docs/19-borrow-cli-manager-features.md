# PRD：CC-Panes 借鉴 CLI-Manager 的能力增强

> 状态：**PRD（评审中）** · 本文只描述**做什么/为什么/验收**，不含实现细节；实施设计与排期批准后另补。

## 1. 背景与动机

同赛道竞品 **CLI-Manager**（`github.com/dark-hxx/CLI-Manager`）建仓于 2026-03-12，晚 CC-Panes（首个提交 2026-02-16）约一周，采用与 CC-Panes **相同的技术栈**（Tauri 2 + React 19 + Zustand + SQLite + xterm v6），走「观测 + 同步 + 命令效率」路线，**无 MCP / skill / daemon / mobile**。

对其源码做过指纹比对：**未发现抄用 CC-Panes 代码**（无 `ccpanes`/`usePanesStore` 等专属标识，架构与 UI/分屏库均不同）。但它有几样 CC-Panes 缺失的 QoL / 供应商能力，值得**借鉴思路自研**（非抄码）。

目标：补齐 CC-Panes 的供应商体验、终端 QoL、多设备同步与 WebGL 稳健性，同时保住 CC-Panes 的差异化壁垒（MCP 编排 / skill / daemon 会话共享 / 移动端镜像）。

## 2. 目标 / 非目标

- **目标**：Provider 更省心（导入 + 测活 + 元数据）；终端更好用（搜索 + 背景）；配置与工作空间多设备同步；WebGL 稳健性。
- **非目标（本期不做）**：完整用量成本分析看板、AI 会话回放、系统资源监控、per-project provider 切换（CC-Panes 已按 provider 指定/切换）、命令模板 / Prompt 库（留后续）、**修复 WebGL CJK 花屏**（已证无干净解，保留 DOM 默认）。

## 3. 功能需求（含验收）

### F1 Provider 增强
- **F1.1 cc-switch 导入**：读取 `~/.cc-switch/cc-switch.db`，一键导入/合并供应商（按 name + base_url 去重、密钥掩码显示）。
  - 验收：在装有 cc-switch 且已配置供应商的机器点「导入」→ 这些供应商出现在 CC-Panes 且可用。
- **F1.2 测活 / 延迟**：一键对某供应商发起真实模型请求，显示往返延迟与状态（正常 / 降级（>6s）/ 不可用）。
  - 验收：点「测试」秒级出结果；错误 key 或错误 base_url → 标「不可用」。
- **F1.3 richer 元数据**：供应商增加 category / 官网 / 备注 / api_format / 排序等字段并展示。
  - 验收：可填写可展示；旧数据（无这些字段）不报错（serde 向后兼容）。

### F2 终端 QoL
- **F2.1 终端内搜索**：Ctrl+F 唤起，命中高亮，上一个/下一个。
- **F2.2 自定义终端背景**：支持背景图片（本地/URL）+ 不透明度 + 模糊；启用背景时自动切换到非 WebGL 渲染器（WebGL 不透传背景）。
  - 验收：背景透出、文字清晰可读；Windows / macOS 均无退化。

### F3 WebGL 稳健性（**不修花屏**）
- **F3.1**：仅对**显式选择 webgl** 的用户，补上 context-loss 时回退默认渲染器、隐藏标签延时 dispose（省 GPU、避免撞浏览器 ~16 个 WebGL context 上限）。
- **F3.2 字体 A/B 实验（低期望）**：WebGL CJK 花屏在 0.10.9 即存在（早于 0.10.11 打包 Maple Mono NF CN），**非本项目字体引入**，属 WebView2 + xterm-WebGL 底层限制。仅做一次实验：Windows 开 WebGL 分别试 Maple Mono NF CN / Cascadia Code / Sarasa Mono SC，**消糊才提供该组合，否则保留 DOM 默认不变**。

### F4 多设备同步（WebDAV）
- **F4.1 同步内容**：providers（**不同步 token/密钥**——明文密钥不上云，新机器手动重填）、settings、**工作空间元数据**（名称 / 别名 / provider 绑定 / 项目列表 / 排序 / pin）。**不含**：会话/PTY、token 明文、命令模板/Prompt 库（本期不做）。
- **F4.2 WebDAV client**：配置 URL / 账号 / 密码，PUT/GET 单个 `cc-panes-sync.json`（兼容坚果云等标准 WebDAV）。
- **F4.3 冲突解决**：以 `updatedAt` + 内容哈希比对，冲突时提供「用本地 / 用远端 / 手动合并」；同步文件设大小上限兜底。
- **F4.4 工作空间跨机路径**：拉取后，本机不存在的 project 路径按机器**映射或标注缺失**，不假装可用（参照移动端「未归入布局」的诚实标注做法）。
  - 验收：配置坚果云后两端可推/拉；两端改同一项 → 冲突提示；缺失路径有明确提示。

## 4. 非功能需求
- **兼容**：Provider 新增字段 serde 向后兼容；同步排除敏感明文。
- **安全**：测活与日志不打印 key；**token 不进同步**；WebDAV 密码安全存储。
- **性能**：测活异步不阻塞 UI；同步增量 / 防抖。

## 5. 已定决策 / 遗留
1. ✅ 同步 token —— **完全不同步**（新机器手动重填）。
2. ✅ 命令模板 / Prompt 库 —— **本期不做**。
3. 测活探测请求（models 列表 vs 极小 messages，按 provider_type 区分）—— 实施期确定，不阻塞 PRD。

## 6. 优先级
P0：F2（终端 QoL）、F1（Provider）；P1：F4（同步）；P2：F3（WebGL 实验）。分批发版。

## 7. 参考（仅对照思路，不抄码）
CLI-Manager 对应实现：`src-tauri/src/commands/ccswitch.rs`、`src/components/XTermTerminal.tsx`、`src-tauri/src/sync/mod.rs`、`src-tauri/src/webdav/mod.rs`。

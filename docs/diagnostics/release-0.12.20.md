# 0.12.20 完整交付核对

来源：用户要求“全部提交发干净”。原工作树 118 个源码/文档文件与现有开发、发布分支统一合并；另提交本地产物忽略规则。原文件和本地历史已私有备份。

| 项目 | 最终实现位置 | 验收要求 |
|---|---|---|
| 自动化入口与下排图标 | LayoutPresetPicker / LayoutTopBar | Agent Chat 下方可见，点击进入自动化设置；两种密度都可操作 |
| CLI 品牌图标 | CliBrandIcon / ProviderToolTabs | 全部注册 CLI 可见，切换正确，窄面板不溢出 |
| 布局列表拉伸 | LayoutSelectorPanel | 可超过内容高度，取消恢复，受视口上限约束 |
| CC Switch 导入 | cc_switch_import / ProviderService / provider_commands / providerService / useProvidersStore / ProvidersPanel | 实际 SQLite fixture、原子失败、去重与默认项保留、统计准确、前端成功和失败状态 |
| MCP 右下角通知 | OrchestratorAlertBanner / NotificationCenter | 保留已发布修复，同一故障关闭后不重复出现 |
| 终端已发布与开发修复 | terminal renderer/replay/write watchdog / CLI adapters | 全量自动检查与隔离 Windows 回放、短时性能对比 |
| 最终安装包 | Windows NSIS / 发布附件 | 版本、签名、安装内容、实际自动化入口、后台会话保留 |

本地 .ccpanes/history、evidence、tauri.local-hotfix 配置及独立鹈鹕 HTML 保持原位，已备份并明确忽略；它们不属于可公开发布的产品代码。

CC Switch 映射依据：[官方配置说明](https://github.com/farion1231/cc-switch-website/blob/main/public/docs/en/2-providers/2.1-add.md)、[Codex 预设](https://github.com/farion1231/cc-switch/blob/main/src/config/codexProviderPresets.ts)、[OpenCode 预设](https://github.com/farion1231/cc-switch/blob/main/src/config/opencodeProviderPresets.ts)。本次不导入真实用户凭证进行测试，使用隔离 fixture。

## 已完成的本机验证

- Windows TypeScript、前端生产构建、主题对比度与 bundle 预算通过；入口 gzip 871.0 kB，预算 880 kB。
- 前端全量 5720 项通过，补充导入/列表状态验证 45 项通过。
- Windows Rust workspace check、Clippy 通过；全量复核 2595 项通过、6 项原有忽略项。
- 首次并发全量运行中 ConPTY 自然退出测试超时；单独复测以及限制为 4 个测试线程的全量复核通过。未改源码或放宽超时。
- CC Switch SQLite 定向测试 12 项通过；测试不读取或导入真实用户凭证。
- 静态回放 4 组像素对账通过，透明 WebGL、20 项发布元数据及性能工具测试通过。
- Windows WebView2 优化构建验收通过：自动化入口两种密度均可见并正确跳转，10 个 CLI 图标和切换正常，导入入口可见，MCP 右下角卡片关闭和故障周期行为正确。

发布前还通过工作流验证最终提交的跨平台 CI、安装包、签名及更新索引；短时跨版本性能记录、正式安装后的界面核验和会话对照归档到工作空间证据目录，并随发布结果报告。

范围说明：未进行新的中文输入法人工候选窗验收，不将自动回放测试等同于该项；不执行此前取消的长期压力测试。

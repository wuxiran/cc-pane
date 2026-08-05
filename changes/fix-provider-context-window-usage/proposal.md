# 修复 Provider 上下文窗口与用量显示
ID: fix-provider-context-window-usage
Status: APPROVED
Created: 2026-08-05

## Why

`83f58e1` 合入上下文用量指示器后，Claude 分支在 `UsageStatsService` 中把窗口固定为 `200_000`。当 Provider 通过代理接入不同模型、模型上下文并非 200k，或 Claude 日志没有返回窗口字段时，状态栏仍会按 200k 计算百分比，导致用量显示失真。当前 `ProviderModel` 只维护模型 id、标签和推理 effort，启动历史也没有保存本次解析出的 model id，后端无法把状态栏查询与一次实际启动绑定起来。

本变更遵循现有 Provider -> Launch Profile -> PTY -> launch history -> UsageStatsService 链路。Codex 已能从 `model_context_window` 读取运行时真实值；Claude 的会话 JSONL 通常只有模型和 token usage，不能假设所有模型共用 200k。因此需要把上下文窗口作为 Provider 模型元数据维护，并显式区分运行时观测、Provider 配置和未知状态。

## What changes

- 在 Provider 模型目录中增加可选的 `contextWindowTokens`，Provider 表单提供整数输入、单位提示、校验和空值清除。
- 在 launch history 中保存本次启动最终使用的 `modelId`，兼容旧数据库和旧客户端请求。
- UsageStatsService 按来源优先级解析窗口：Codex JSONL 运行时值、Claude JSONL 可观测值、启动时选中的 Provider 模型配置、Provider 默认模型配置。
- 当窗口未知时保留已用 token，但不计算百分比，状态栏显示 `-%` 和窗口未知提示；保留 `windowSource` 供诊断，不再把未知值伪装成 200k。
- 增加 Rust/TypeScript/组件测试，覆盖 Provider 字段往返、校验、启动历史传输、解析优先级、未知窗口和旧数据兼容。
- 在 `docs/provider-context-window/` 写入中文的根因、数据来源、维护方式、迁移和验收说明。

## Out of scope

- 不为 Gemini、Kimi、GLM、Grok、Cursor、OpenCode 猜测或新增上下文窗口解析器。
- 不通过外网模型目录接口自动发现窗口；不同供应商、代理和鉴权方式的接口不稳定，且会引入凭据和网络副作用。
- 不回算历史状态栏百分比；修复只影响新的查询，历史 usage 聚合表保持现状。
- 不修改 CLI 的启动参数、Provider 凭据注入、SSH 安全策略或 Codex 的 12k 有效窗口基线。
- 不在活动 PTY 中热修改已解析的窗口；Provider 修改只对后续启动生效，旧 launch history 没有 model id 时按兼容规则处理。

## Risks

- launch history 增加字段需要数据库迁移，并同步 Tauri、Web/API、MCP 启动路径；遗漏一个入口会使 Provider 配置无法命中。
- 部分第三方 Claude 代理返回的 model 名称可能与 Provider 目录 id 不同；规约要求优先使用已保存的 `modelId`，无法匹配时明确显示未知而不是猜测。
- 旧 Provider JSON 和旧 launch history 缺少新字段；必须使用 `serde(default)`、可选请求字段和兼容迁移，不能阻断已有会话。

## Success criteria

- Provider 模型可以保存、加载、编辑和删除 `contextWindowTokens`；缺失字段的旧 Provider 仍能加载。
- 选择模型 `model-a` 启动后，`launch_history.model_id` 返回 `model-a`；Tauri 与 Web/API payload 保持 camelCase 且旧调用仍可用。
- Codex fixture 同时包含 `model_context_window=353000` 与 Provider 配置值时，快照窗口为 353000，来源为 `codex-jsonl`。
- Claude fixture 没有窗口字段但 Provider 模型配置为 1000000 时，快照窗口为 1000000，来源明确为 `provider-model`。
- Claude/旧记录没有任何窗口来源时，快照保留 `usedTokens`，`windowTokens`、`usedPercentage` 为 null，状态栏显示 `-%`，不会出现 `200k` 窗口。
- `npx tsc --noEmit`、相关 Vitest、`cargo fmt --all -- --check`、`cargo check --workspace`、相关 Rust 测试和 `git diff --check` 通过；Windows 桌面行为单独列为 host-required 证据。

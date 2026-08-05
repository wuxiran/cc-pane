# Provider 上下文窗口与用量显示修复说明

> 文档状态：规约已形成，代码实施由 `changes/fix-provider-context-window-usage/` 驱动。本文记录根因、数据来源、维护方式、兼容策略和验收口径。

## 1. 问题结论

昨天合入的上下文用量指示器在 Claude 解析分支中把上下文窗口直接写成 `200_000`。代码路径是：

```text
Claude JSONL assistant usage
  -> UsageStatsService::read_context_snapshot
  -> window_tokens = 200_000
  -> ContextUsageSnapshot.usedPercentage
  -> StatusBar
```

Provider 的模型目录当时只有模型 id、展示标签和默认推理 effort，没有上下文窗口字段；启动历史又只记录 Provider id，没有记录本次实际选择的 model id。结果是：

- 不同 Provider、代理模型和自定义模型都被当成 200k；
- Claude JSONL 没有窗口字段时，代码无法区分“确实是 200k”和“完全未知”；
- 修改 Provider 模型选择不会反映到已有 PTY 的用量解析；
- 状态栏给出看似精确的百分比，实际分母可能错误。

根因不是 token 加法。Claude 当前上下文已用量仍应为：

```text
input_tokens
+ cache_read_input_tokens
+ cache_creation_input_tokens
```

`output_tokens` 是本轮生成量，不应加入下一轮上下文占用。错误在于窗口来源缺失却使用了无来源的固定分母。

## 2. 现在能从哪里拿到窗口

### 2.1 Codex：优先使用运行时 JSONL

Codex rollout 的 `token_count` 事件会返回：

```json
{
  "payload": {
    "info": {
      "last_token_usage": { "total_tokens": 139000 },
      "model_context_window": 353000
    }
  }
}
```

这是当前会话、当前模型的运行时值，优先级最高。状态栏仍按项目既有 12k baseline 计算有效百分比：

```text
effectiveUsed = max(totalTokens - 12000, 0)
effectiveWindow = modelContextWindow - 12000
```

### 2.2 Claude：日志通常没有窗口，Provider 维护是可靠兜底

Claude Code assistant JSONL 通常能读到 model 和 usage，但不保证返回 context window。对 Claude 不能因为模型名字包含 `sonnet`、`opus` 就猜一个值，也不能假设代理模型沿用官方能力。

规约支持两类运行时字段（如果未来 CLI 写入）：

- `message.usage.context_window`
- `message.usage.context_window_tokens` 或 `message.usage.max_context_tokens`

没有这些字段时，使用启动历史中保存的 `modelId` 查 Provider 模型目录。Provider 模型的窗口由维护者明确填写，来源会标记为 `provider-model`。

### 2.3 为什么不直接调用供应商模型列表接口

不把网络探测作为默认方案，原因有三点：

1. OpenAI、Anthropic、代理服务的模型列表接口和字段并不统一，很多只返回 id，不返回上下文窗口。
2. 请求需要 API key、区域或自定义 base URL，失败时会把凭据和网络问题引入状态栏查询。
3. CC-Panes 是离线优先的本地工具，Provider 配置应可审计、可导出、可复现。

未来如果某个 Provider 明确提供稳定的能力接口，可以单独设计可选的“同步模型能力”功能，不能隐式改变实时用量计算。

## 3. Provider 维护方式

### 3.1 字段定义

每个模型增加：

```json
{
  "id": "claude-sonnet-4-5",
  "label": "Sonnet 4.5",
  "contextWindowTokens": 1000000
}
```

`contextWindowTokens` 的单位是 token，不是字符，也不是“输入 + 输出预算”。允许留空，留空表示尚未确认。

保存约束：

| 规则 | 说明 |
| --- | --- |
| 类型 | 必须是整数 |
| 最小值 | 1,000 tokens |
| 最大值 | 10,000,000 tokens |
| 空值 | 空字符串会保存为 `null` |
| 旧数据 | 没有该字段的 Provider 自动按 `null` 读取 |
| 安全 | 不进入命令行、日志、API key 或 base URL |

### 3.2 UI 操作

进入 Settings -> Provider，打开一个 Provider 的模型编辑区：

1. 在模型行填写模型 id、标签和“上下文窗口（tokens）”。
2. 输入官方文档或代理服务明确给出的最大上下文 token 数，例如 `1000000`。
3. 点击默认星标只影响默认模型，不会覆盖窗口字段。
4. 不确定时留空，状态栏会显示 `-%`，而不是显示一个未经确认的百分比。
5. 保存后，新启动会话会携带该模型 id；已经运行的 PTY 不会被热修改。

建议维护表：

| Provider 类型 | 模型 | contextWindowTokens | 依据 | 备注 |
| --- | --- | ---: | --- | --- |
| Anthropic/Proxy | claude-sonnet-4-5 | 以供应商当前文档为准 | 供应商模型能力说明 | 代理若有独立限制，填代理值 |
| OpenAI/Codex | gpt-5.x | 可填写保守值 | 仅作无 JSONL 时兜底 | JSONL 实测值优先 |
| OpenCode/兼容代理 | qwen3-coder 等 | 按实际代理限制 | 代理文档或控制台 | 不按官方同名模型猜测 |

## 4. 修复后的数据链路

```text
ProviderFormPanel
  -> ProviderModel.contextWindowTokens
  -> ProviderService normalize + validate + atomic save

Launcher / Launch Profile
  -> CreateSessionRequest.modelId
  -> launch_history.model_id

PTY + resume id
  -> UsageStatsService
  -> JSONL runtime window（若存在）
  -> launch_history.model_id 对应 Provider 模型窗口
  -> ContextUsageSnapshot
  -> StatusBar
```

窗口来源优先级固定为：

1. Codex JSONL 的 `model_context_window`；
2. Claude/Codex JSONL 显式窗口字段；
3. 本次 launch history 的 `modelId` 对应 Provider 模型；
4. Provider 默认模型的窗口（仅当本次没有 model id）；
5. 未知窗口。

### 未知窗口的显示

未知不等于 0，也不等于 200k。快照会保留：

```json
{
  "status": "ready",
  "usedTokens": 81234,
  "windowTokens": null,
  "usedPercentage": null,
  "windowSource": "unknown",
  "diagnosticCode": "WINDOW_UNKNOWN"
}
```

状态栏显示 `-%`，悬浮说明“已读取使用量，但未配置上下文窗口”；这样用户能继续看到原始用量，也不会被错误分母误导。

## 5. 兼容和迁移

- Provider JSON 新字段使用 `serde(default)`，旧文件不需要手工迁移。
- SQLite 通过 nullable migration 增加 `launch_history.model_id`；旧行读取为 null。
- 旧客户端不发送 `modelId` 仍可启动；新客户端保存实际选择的模型。
- 旧会话没有模型和窗口时不回算 200k，状态栏显示 unknown。
- Codex 已有 `model_context_window` 的会话不受 Provider 手工值影响。
- Provider 修改不会重写历史 usage 聚合，也不会改变正在运行的 CLI 参数。

## 6. 验收清单

### 功能

- [ ] Provider 模型可以新增、编辑、清空上下文窗口。
- [ ] 非法范围被拒绝，原配置不被破坏。
- [ ] 新启动历史能看到 `modelId`。
- [ ] Claude 使用 Provider 窗口时来源显示 `provider-model`。
- [ ] Codex 使用 JSONL 窗口时来源显示 `codex-jsonl`。
- [ ] 未知窗口显示 `-%`，不出现无依据的 `200k` 百分比。

### 自动化

- [ ] Provider Rust 单元测试。
- [ ] Provider 表单与 i18n Vitest。
- [ ] launch history repository/service/API round-trip 测试。
- [ ] Claude/Codex parser 与 UsageStatsService 优先级测试。
- [ ] TypeScript、Vitest、Rust fmt/check/test、diff check。

### 平台边界

- 当前环境可验证：Rust/TypeScript 编译、单元测试、数据契约和 JSONL fixture。
- Windows-host-required：Tauri 桌面启动、WebView 状态栏实际布局、Provider 表单输入、Windows PTY/WSL 会话的真实 JSONL 路径。

## 7. 相关规约

- 提案：`changes/fix-provider-context-window-usage/proposal.md`
- 能力规格：`changes/fix-provider-context-window-usage/specs/provider-context-window.md`
- 设计：`changes/fix-provider-context-window-usage/design.md`
- 任务树：`changes/fix-provider-context-window-usage/tasks.md`
- 上一版上下文用量背景：`docs/76-context-usage-indicator.md`

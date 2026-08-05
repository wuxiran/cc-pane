# Spec - Provider 上下文窗口与实时用量

## Inputs

### Provider 模型

```ts
interface ProviderModel {
  id: string;
  label?: string | null;
  defaultEffort?: LaunchEffort | null;
  contextWindowTokens?: number | null;
}
```

- `contextWindowTokens` 表示该模型可用于上下文百分比计算的 token 窗口，不是价格、输出上限或字符数。
- 允许缺失或 `null`，表示维护者尚未确认窗口；持久化旧 Provider 时按缺失处理。
- 非空值必须是整数，范围为 `1_000` 到 `10_000_000`（含边界）。`ProviderService` 对可反序列化的整数执行范围校验，越界时返回 `PROVIDER_MODEL_INVALID`。
- 非整数、字符串和负数不能反序列化为 Rust `u64`，由 JSON/IPC 类型边界在进入 `ProviderService` 前拒绝；NaN 和无穷值不是合法 JSON。前端表单必须在序列化前拒绝这些值，不能让 `JSON.stringify` 把它们转换成 `null`。
- 模型 id、标签、默认模型和现有 Provider 校验规则保持不变；Provider 最多 100 个模型。

### 启动历史

```ts
interface LaunchRecord {
  providerId?: string | null;
  modelId?: string | null;
}
```

- `modelId` 是本次启动最终解析的模型 id，可为空；旧数据库行默认为 null。
- Tauri command、Web service、Axum REST、MCP `launch_task` 和 GUI 启动都使用同一个 camelCase 字段。
- `modelId` 只保存非敏感标识，不保存 API key、base URL 或响应内容。

### JSONL 观测

- Codex：继续读取 `payload.info.last_token_usage.total_tokens` 与 `payload.info.model_context_window`。
- Claude：读取 assistant message 的 input/cache token；若日志出现 `context_window`、`context_window_tokens` 或 `max_context_tokens`，将其视为可观测窗口。
- JSONL 数字必须为非负整数；字段类型错误、负数或窗口小于 1,000 时忽略该窗口并记录诊断，不把它转换为 0。

## Outputs

`ContextUsageSnapshot` 继续使用现有 camelCase 契约：

- 有窗口：`windowTokens`、`effectiveWindowTokens`、`usedPercentage`、`remainingPercentage` 为计算值。
- 无窗口但有 token：保留 `status=ready`、`usedTokens` 和 `effectiveUsedTokens`，窗口与百分比为 `null`，`windowSource="unknown"`，`diagnosticCode="WINDOW_UNKNOWN"`。
- 没有首条有效 usage：保持 `waiting`；文件或运行时不可读：保持 `error`。
- `windowSource` 的允许值至少包括 `codex-jsonl`、`claude-jsonl`、`provider-model`、`unknown`；不得把 fallback 来源写成无来源的 200k。

## Behavior

### 窗口解析优先级

对一个 PTY 的一次快照按以下顺序取窗口：

1. Codex JSONL 的 `model_context_window`（存在且通过校验时始终优先）。
2. Claude/Codex JSONL 中显式的上下文窗口字段（存在且通过校验时使用）。
3. `launch_history.model_id` 对应 Provider 的 `contextWindowTokens`。
4. 当 `modelId` 为空时，Provider `defaultModelId` 对应模型的 `contextWindowTokens`。
5. 没有可靠来源时返回未知窗口，不使用固定 200k 计算百分比。

Provider 查询通过 UsageStatsService 注入的 ProviderService 完成；Provider 配置读取失败只影响窗口解析，不影响 PTY 或历史 usage 聚合。

### 用量计算

- Claude 当前上下文使用量仍为 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，不计 `output_tokens`。
- Codex 继续从 raw used/window 中扣除既有 12,000 baseline 后计算有效百分比。
- 只有 `effectiveWindowTokens > 0` 时才计算百分比；窗口未知、窗口过小或算术溢出时百分比为 null。
- Provider 修改不会改变已经写入的 launch history model id；后续查询可能读取新的模型元数据，因此 UI 必须显示 `windowSource`，避免把配置变化误解为运行时观测。

### Provider 表单

- 每个模型行增加“上下文窗口（tokens）”数字输入，空值表示未知。
- 输入框显示范围/单位提示，保存前 trim 并将空字符串转换为 null；后端再次校验。
- 默认星标、删除、模型 id、标签和 effort 的现有交互不变；单模型仍自动成为默认模型。
- 选择 Launch Profile 模型时，在已有模型标签旁显示其上下文窗口（如 `1,000,000 tokens`），未知时显示“未配置”。

### 兼容与安全

- 缺少 `contextWindowTokens`、`modelId` 的旧 JSON/SQLite 行继续反序列化。
- Native 模式、SSH managed 拒绝、Provider 凭据注入和 Codex baseline 不变。
- 不把 API key、base URL、session prompt 或完整 JSONL 写入快照、历史、日志和错误消息。
- model id 和 context window 在 Rust 边界校验；不得通过 shell 字符串拼接传递。

## Non-functional

- Provider 窗口查找最多线性扫描 100 个模型；解析不新增磁盘全量扫描，复用现有 JSONL 增量缓存。
- 数据库迁移必须幂等；旧版本启动一次后，新字段可被所有查询路径读取。
- Rust 文件和函数遵守项目现有规模约束；前端 i18n 中英文 key 必须成对存在。
- 测试必须覆盖空值、边界值、类型错误、旧数据、来源优先级和未知窗口，避免只验证 200k happy path。

## Examples

### Happy paths

1. Provider 的 `claude-sonnet-4-5` 配置 `contextWindowTokens=1000000`，启动历史记录该 model id；Claude 日志只有 token usage，快照返回 `1,000,000`、来源 `provider-model`。
2. Codex JSONL 返回 `model_context_window=353000`，Provider 同一模型配置 `200000`；快照使用 `353000`、来源 `codex-jsonl`。
3. Claude 日志显式返回 `context_window_tokens=200000`，Provider 配置为 1000000；快照使用日志值、来源 `claude-jsonl`。
4. 旧 Provider 缺少上下文字段，旧 launch history 没有 model id；快照仍显示已用 token，但百分比为 `-%`，窗口来源为 `unknown`。

### Error paths

1. 保存 `contextWindowTokens=999` 或 `10000001`，ProviderService 返回 `PROVIDER_MODEL_INVALID`，原 Provider 文件不改变。
2. 表单输入 `10000000.5`、NaN 或无穷值时在 invoke 前拒绝；直接提交非整数、字符串或负数的畸形 JSON/IPC payload 时由类型边界拒绝，原 Provider 文件不改变。
3. launch history payload 的 `modelId` 包含控制字符或超过模型 id 限制时，保存路径拒绝该值，不影响已运行 PTY。
4. JSONL 的窗口字段是字符串或负数时，忽略该候选并继续 Provider 查找；两者都没有时返回未知窗口。
5. Provider 文件暂时不可读时，实时快照不会 panic 或显示 0%，而是保留 raw usage 并返回 `WINDOW_UNKNOWN`。

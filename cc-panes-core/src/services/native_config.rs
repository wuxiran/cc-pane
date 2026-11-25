//! 分层原生 CLI 配置（native config overrides）。
//!
//! 合并顺序（后者覆盖前者）：
//!
//! ```text
//! CLI 自己的配置（~/.codex/config.toml 等，CC-Panes 从不改写）
//!   ← 中转站片段（Provider.native_overrides[tool]）
//!   ← 运行配置片段（LaunchProfile.native_overrides[tool]）
//!   ← CC-Panes 显式字段（modelId / effort / yolo / 路由 / MCP）
//! ```
//!
//! - Codex 片段是 TOML，Claude 片段是 JSON；保存原文以保留用户格式。
//! - 合并是对表 / 对象的深合并：叶子覆盖叶子，数组整体替换。
//! - Codex 的 `-c` 只在叶子级替换、数组整体替换，所以深合并必须在这里做完，
//!   再拍平成一组点分叶子 `-c key=value`。
//! - 片段里不能放 CC-Panes 托管的键（路由 / MCP / hooks / projects）与任何像密钥的键：
//!   密钥只能在钥匙串或环境变量里。

use crate::models::provider::{Provider, ProviderType, SYSTEM_PROVIDER_ID};
use crate::models::{CliTool, LaunchProfile, LaunchProfileDraft};
use crate::utils::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::collections::{BTreeMap, HashMap};
use tracing::warn;

/// CLI id → 片段原文。
pub type NativeOverrides = BTreeMap<String, String>;

/// 支持原生配置覆盖的 CLI。
pub const NATIVE_OVERRIDE_TOOLS: [&str; 2] = ["codex", "claude"];

/// 单个片段的大小上限（原文字节数）。
const MAX_FRAGMENT_BYTES: usize = 64 * 1024;

/// Codex 片段里由 CC-Panes 托管、不允许覆盖的顶层键。
const CODEX_FORBIDDEN_TOP_KEYS: [&str; 5] = [
    "model_provider",
    "model_providers",
    "projects",
    "hooks",
    "mcp_servers",
];

/// Claude 片段 `env` 里额外禁止的认证键（路由键取自 `managed_provider_conflict_env_keys`）。
const CLAUDE_EXTRA_FORBIDDEN_ENV: [&str; 2] =
    ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"];

/// 片段格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FragmentFormat {
    Toml,
    Json,
}

pub fn fragment_format(tool: &str) -> Option<FragmentFormat> {
    match tool {
        "codex" => Some(FragmentFormat::Toml),
        "claude" => Some(FragmentFormat::Json),
        _ => None,
    }
}

/// 一个生效叶子来自哪一层。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeConfigSource {
    /// 中转站片段（含中转站模型的上下文窗口）。
    Provider,
    /// 运行配置片段。
    Profile,
    /// CC-Panes 显式字段（modelId / effort / yolo / 路由）。
    Managed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeConfigIssueCode {
    ParseError,
    NotAnObject,
    ForbiddenKey,
    SecretKey,
    UnsupportedTool,
    TooLarge,
}

/// 校验问题。`message` 只含键名与解析位置，从不回显片段内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigIssue {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<NativeConfigSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub code: NativeConfigIssueCode,
    pub message: String,
}

/// 预览里的一行：`key = value` + 来源层。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigEntry {
    pub key: String,
    /// 字面量：Codex 为 TOML、Claude 为 JSON。
    pub value: String,
    pub source: NativeConfigSource,
}

/// 某个运行位置能否应用片段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigRuntime {
    /// `local` / `wsl` / `ssh`
    pub runtime: String,
    pub applied: bool,
    /// 不生效 / 部分生效的原因代码（前端按代码出文案）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigPreview {
    pub cli_tool: String,
    pub supported: bool,
    pub entries: Vec<NativeConfigEntry>,
    pub runtimes: Vec<NativeConfigRuntime>,
    pub issues: Vec<NativeConfigIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

/// CC-Panes 显式字段（最高优先级）以及中转站模型的上下文窗口（最低优先级）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManagedNativeFields {
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub yolo: bool,
    /// 中转站模型的 `context_window_tokens`：Codex 注入 `model_context_window`，片段可覆盖。
    pub context_window_tokens: Option<u64>,
    /// Codex 路由到的 `model_provider` id（只用于预览显示；真正的路由参数由适配器生成）。
    pub codex_provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergedLeaf {
    pub path: Vec<String>,
    pub value: Value,
    pub source: NativeConfigSource,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MergedNativeConfig {
    pub tool: String,
    pub leaves: Vec<MergedLeaf>,
    pub issues: Vec<NativeConfigIssue>,
}

// ───────────────────────────── 解析与校验 ─────────────────────────────

fn issue(
    tool: &str,
    key: Option<String>,
    code: NativeConfigIssueCode,
    message: String,
) -> NativeConfigIssue {
    NativeConfigIssue {
        tool: tool.to_string(),
        layer: None,
        key,
        code,
        message,
    }
}

/// 解析片段并剔除不允许的键。返回（清洗后的对象, 问题列表）。
/// 解析失败时对象为 `None`（整层不生效）；键级问题只剔除那个键，其余照常生效。
pub fn parse_and_sanitize(
    tool: &str,
    text: &str,
) -> (Option<Map<String, Value>>, Vec<NativeConfigIssue>) {
    let Some(format) = fragment_format(tool) else {
        return (
            None,
            vec![issue(
                tool,
                None,
                NativeConfigIssueCode::UnsupportedTool,
                format!("Native config overrides are not supported for '{tool}'"),
            )],
        );
    };
    if text.trim().is_empty() {
        return (Some(Map::new()), Vec::new());
    }
    if text.len() > MAX_FRAGMENT_BYTES {
        return (
            None,
            vec![issue(
                tool,
                None,
                NativeConfigIssueCode::TooLarge,
                format!("{tool}: native config fragment exceeds {MAX_FRAGMENT_BYTES} bytes"),
            )],
        );
    }
    let parsed = match format {
        FragmentFormat::Toml => parse_toml(text),
        FragmentFormat::Json => parse_json(text),
    };
    let mut root = match parsed {
        Ok(root) => root,
        Err((code, message)) => {
            return (
                None,
                vec![issue(tool, None, code, format!("{tool}: {message}"))],
            )
        }
    };
    let mut issues = Vec::new();
    sanitize_object(tool, &mut root, &mut Vec::new(), &mut issues);
    (Some(root), issues)
}

/// 只校验：返回全部问题（空 = 可以保存）。
pub fn validate_fragment(tool: &str, text: &str) -> Vec<NativeConfigIssue> {
    parse_and_sanitize(tool, text).1
}

fn parse_toml(text: &str) -> Result<Map<String, Value>, (NativeConfigIssueCode, String)> {
    match text.parse::<toml::Table>() {
        Ok(table) => Ok(toml_table_to_json(&table)),
        Err(error) => {
            // 只报行号与原因，不回显片段内容（toml 的 Display 会带上原文那一行）。
            let line = error
                .span()
                .map(|span| text[..span.start.min(text.len())].matches('\n').count() + 1);
            let reason = error.message().trim().to_string();
            Err((
                NativeConfigIssueCode::ParseError,
                match line {
                    Some(line) => format!("invalid TOML at line {line}: {reason}"),
                    None => format!("invalid TOML: {reason}"),
                },
            ))
        }
    }
}

fn parse_json(text: &str) -> Result<Map<String, Value>, (NativeConfigIssueCode, String)> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err((
            NativeConfigIssueCode::NotAnObject,
            "fragment must be a JSON object".to_string(),
        )),
        Err(error) => Err((
            NativeConfigIssueCode::ParseError,
            format!(
                "invalid JSON at line {} column {}: {}",
                error.line(),
                error.column(),
                json_error_reason(&error)
            ),
        )),
    }
}

fn json_error_reason(error: &serde_json::Error) -> &'static str {
    use serde_json::error::Category;
    match error.classify() {
        Category::Syntax => "syntax error",
        Category::Eof => "unexpected end of input",
        Category::Data => "invalid data",
        Category::Io => "read error",
    }
}

fn sanitize_object(
    tool: &str,
    map: &mut Map<String, Value>,
    path: &mut Vec<String>,
    issues: &mut Vec<NativeConfigIssue>,
) {
    let keys: Vec<String> = map.keys().cloned().collect();
    for key in keys {
        path.push(key.clone());
        let dotted = display_key(path);
        if is_forbidden_path(tool, path) {
            issues.push(issue(
                tool,
                Some(dotted.clone()),
                NativeConfigIssueCode::ForbiddenKey,
                format!("{tool}: '{dotted}' is managed by CC-Panes (routing / auth / MCP / hooks / projects) and cannot be overridden"),
            ));
            map.remove(&key);
        } else if looks_like_secret(&key) {
            issues.push(issue(
                tool,
                Some(dotted.clone()),
                NativeConfigIssueCode::SecretKey,
                format!("{tool}: '{dotted}' looks like a secret; keep secrets in the keychain or environment variables"),
            ));
            map.remove(&key);
        } else if let Some(value) = map.get_mut(&key) {
            sanitize_value(tool, value, path, issues);
        }
        path.pop();
    }
}

fn sanitize_value(
    tool: &str,
    value: &mut Value,
    path: &mut Vec<String>,
    issues: &mut Vec<NativeConfigIssue>,
) {
    match value {
        Value::Object(child) => sanitize_object(tool, child, path, issues),
        Value::Array(items) => {
            for item in items.iter_mut() {
                if let Value::Object(child) = item {
                    // 数组里的表只查「像密钥」的键（托管键只在固定位置出现）。
                    sanitize_object(tool, child, path, issues);
                }
            }
        }
        _ => {}
    }
}

fn is_forbidden_path(tool: &str, path: &[String]) -> bool {
    match tool {
        "codex" => path.len() == 1 && CODEX_FORBIDDEN_TOP_KEYS.contains(&path[0].as_str()),
        "claude" => {
            path.len() == 2
                && path[0] == "env"
                && (super::provider_resolver::managed_provider_conflict_env_keys(CliTool::Claude)
                    .contains(&path[1].as_str())
                    || CLAUDE_EXTRA_FORBIDDEN_ENV.contains(&path[1].as_str()))
        }
        _ => false,
    }
}

/// 键名看起来像密钥：含 secret / password / credential，或以 key / token 结尾。
///
/// 按单词判断（`_` `-` `.` 与小写→大写处分词），所以 `model_auto_compact_token_limit`、
/// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`bearer_token_env_var` 不算，`api_key`、`apiKey`、
/// `ANTHROPIC_AUTH_TOKEN`、`client_secret` 算。
pub fn looks_like_secret(name: &str) -> bool {
    let words = split_words(name);
    const ANYWHERE: [&str; 7] = [
        "secret",
        "secrets",
        "password",
        "passwd",
        "credential",
        "credentials",
        "apikey",
    ];
    if words.iter().any(|word| ANYWHERE.contains(&word.as_str())) {
        return true;
    }
    matches!(words.last().map(String::as_str), Some("key" | "token"))
}

fn split_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;
    for ch in name.chars() {
        if !ch.is_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            prev_lower = false;
            continue;
        }
        if ch.is_uppercase() && prev_lower && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
        current.extend(ch.to_lowercase());
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

/// 保存前规整：去掉空白片段，校验其余片段。任何问题都拒绝保存（错误里点名键）。
pub fn normalize_overrides(overrides: Option<NativeOverrides>) -> anyhow::Result<NativeOverrides> {
    let mut out = NativeOverrides::new();
    let mut problems = Vec::new();
    for (tool, text) in overrides.unwrap_or_default() {
        let tool = tool.trim().to_ascii_lowercase();
        if text.trim().is_empty() {
            continue;
        }
        problems.extend(validate_fragment(&tool, &text));
        out.insert(tool, text);
    }
    if problems.is_empty() {
        return Ok(out);
    }
    let message = problems
        .iter()
        .map(|problem| problem.message.as_str())
        .collect::<Vec<_>>()
        .join("; ");
    let mut params = HashMap::new();
    if let Some(key) = problems.iter().find_map(|problem| problem.key.clone()) {
        params.insert("key".to_string(), key);
    }
    params.insert("detail".to_string(), message.clone());
    Err(anyhow::Error::new(AppError::coded_with_params(
        "NATIVE_OVERRIDE_INVALID",
        message,
        params,
    )))
}

// ───────────────────────────── 合并 ─────────────────────────────

type LeafMap = BTreeMap<Vec<String>, (Value, NativeConfigSource)>;

/// 深合并：插入一个叶子时，去掉与它路径冲突的旧叶子（它的祖先叶子或后代叶子）。
fn insert_leaf(acc: &mut LeafMap, path: Vec<String>, value: Value, source: NativeConfigSource) {
    acc.retain(|existing, _| !is_prefix(existing, &path) && !is_prefix(&path, existing));
    acc.insert(path, (value, source));
}

fn is_prefix(prefix: &[String], path: &[String]) -> bool {
    prefix.len() <= path.len() && path[..prefix.len()] == *prefix
}

/// 拍平：非空对象向下递归，其余（标量、数组、空对象）是叶子。
fn flatten(
    map: &Map<String, Value>,
    prefix: &mut Vec<String>,
    out: &mut Vec<(Vec<String>, Value)>,
) {
    for (key, value) in map {
        prefix.push(key.clone());
        match value {
            Value::Object(child) if !child.is_empty() => flatten(child, prefix, out),
            other => out.push((prefix.clone(), other.clone())),
        }
        prefix.pop();
    }
}

fn managed_leaves(tool: &str, managed: &ManagedNativeFields) -> Vec<(Vec<String>, Value)> {
    let path = |segments: &[&str]| segments.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let string = |value: &str| Value::String(value.to_string());
    let model = managed
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let effort = managed
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut out = Vec::new();
    match tool {
        "codex" => {
            if let Some(id) = managed.codex_provider_id.as_deref() {
                out.push((path(&["model_provider"]), string(id)));
            }
            if let Some(model) = model {
                out.push((path(&["model"]), string(model)));
            }
            if let Some(effort) = effort.and_then(cc_cli_adapters::codex_reasoning_effort) {
                out.push((path(&["model_reasoning_effort"]), string(effort)));
            }
            if managed.yolo {
                out.push((path(&["approval_policy"]), string("never")));
                out.push((path(&["sandbox_mode"]), string("danger-full-access")));
            }
        }
        "claude" => {
            if let Some(model) = model {
                out.push((path(&["model"]), string(model)));
            }
            if let Some(tokens) = effort.and_then(cc_cli_adapters::claude_max_thinking_tokens) {
                out.push((
                    path(&["env", "MAX_THINKING_TOKENS"]),
                    Value::String(tokens.to_string()),
                ));
            }
            if managed.yolo {
                out.push((
                    path(&["permissions", "defaultMode"]),
                    string("bypassPermissions"),
                ));
            }
        }
        _ => {}
    }
    out
}

/// 纯函数：按层合并，返回每个生效叶子及其来源层。
pub fn merge_native_config(
    tool: &str,
    provider_fragment: Option<&str>,
    profile_fragment: Option<&str>,
    managed: &ManagedNativeFields,
) -> MergedNativeConfig {
    let mut acc = LeafMap::new();
    let mut issues = Vec::new();
    if fragment_format(tool).is_none() {
        return MergedNativeConfig {
            tool: tool.to_string(),
            leaves: Vec::new(),
            issues,
        };
    }
    // 中转站模型的上下文窗口：最低优先级，片段可以覆盖。
    if tool == "codex" {
        if let Some(tokens) = managed.context_window_tokens.filter(|tokens| *tokens > 0) {
            insert_leaf(
                &mut acc,
                vec!["model_context_window".to_string()],
                Value::Number(Number::from(tokens)),
                NativeConfigSource::Provider,
            );
        }
    }
    for (layer, fragment) in [
        (NativeConfigSource::Provider, provider_fragment),
        (NativeConfigSource::Profile, profile_fragment),
    ] {
        let Some(text) = fragment.filter(|text| !text.trim().is_empty()) else {
            continue;
        };
        let (root, layer_issues) = parse_and_sanitize(tool, text);
        issues.extend(layer_issues.into_iter().map(|mut item| {
            item.layer = Some(layer);
            item
        }));
        let Some(root) = root else { continue };
        let mut leaves = Vec::new();
        flatten(&root, &mut Vec::new(), &mut leaves);
        for (path, value) in leaves {
            insert_leaf(&mut acc, path, value, layer);
        }
    }
    for (path, value) in managed_leaves(tool, managed) {
        insert_leaf(&mut acc, path, value, NativeConfigSource::Managed);
    }
    MergedNativeConfig {
        tool: tool.to_string(),
        leaves: acc
            .into_iter()
            .map(|(path, (value, source))| MergedLeaf {
                path,
                value,
                source,
            })
            .collect(),
        issues,
    }
}

impl MergedNativeConfig {
    /// 需要由 CC-Panes 注入的叶子（显式字段由各自的既有逻辑注入，这里不重复）。
    fn injected(&self) -> impl Iterator<Item = &MergedLeaf> {
        self.leaves
            .iter()
            .filter(|leaf| leaf.source != NativeConfigSource::Managed)
    }

    /// Codex：`key=value` 列表（不含 `-c`），值为 TOML 字面量。
    pub fn codex_config_args(&self) -> Vec<String> {
        self.injected()
            .filter_map(|leaf| {
                let value = json_to_toml(&leaf.value)?;
                Some(format!(
                    "{}={}",
                    codex_key(&leaf.path),
                    toml_literal(&value)
                ))
            })
            .collect()
    }

    /// Claude：要并进 `--settings` 的对象。
    pub fn claude_settings_overlay(&self) -> Map<String, Value> {
        let mut root = Map::new();
        for leaf in self.injected() {
            set_path(&mut root, &leaf.path, leaf.value.clone());
        }
        root
    }

    /// 预览行。
    pub fn entries(&self) -> Vec<NativeConfigEntry> {
        self.leaves
            .iter()
            .map(|leaf| NativeConfigEntry {
                key: display_key(&leaf.path),
                value: if self.tool == "codex" {
                    json_to_toml(&leaf.value)
                        .map(|value| toml_literal(&value))
                        .unwrap_or_else(|| leaf.value.to_string())
                } else {
                    leaf.value.to_string()
                },
                source: leaf.source,
            })
            .collect()
    }
}

fn set_path(root: &mut Map<String, Value>, path: &[String], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut cursor = root;
    for segment in parents {
        let entry = cursor
            .entry(segment.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        cursor = match entry {
            Value::Object(map) => map,
            _ => return,
        };
    }
    cursor.insert(last.clone(), value);
}

// ───────────────────────────── 字面量 ─────────────────────────────

fn is_bare_key(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn quote_key(segment: &str) -> String {
    if is_bare_key(segment) {
        segment.to_string()
    } else {
        serde_json::to_string(segment).unwrap_or_else(|_| format!("\"{segment}\""))
    }
}

/// Codex `-c` 的点分键（与适配器 MCP 覆盖用同一套引号规则）。
fn codex_key(path: &[String]) -> String {
    path.iter()
        .map(|segment| quote_key(segment))
        .collect::<Vec<_>>()
        .join(".")
}

fn display_key(path: &[String]) -> String {
    codex_key(path)
}

fn toml_literal(value: &toml::Value) -> String {
    value.to_string()
}

fn toml_table_to_json(table: &toml::Table) -> Map<String, Value> {
    table
        .iter()
        .map(|(key, value)| (key.clone(), toml_to_json(value)))
        .collect()
}

fn toml_to_json(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(text) => Value::String(text.clone()),
        toml::Value::Integer(number) => Value::Number(Number::from(*number)),
        toml::Value::Float(number) => Number::from_f64(*number)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(number.to_string())),
        toml::Value::Boolean(flag) => Value::Bool(*flag),
        // 日期时间没有 JSON 对应物：按字符串携带（Codex 配置里不用日期）。
        toml::Value::Datetime(datetime) => Value::String(datetime.to_string()),
        toml::Value::Array(items) => Value::Array(items.iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => Value::Object(toml_table_to_json(table)),
    }
}

fn json_to_toml(value: &Value) -> Option<toml::Value> {
    Some(match value {
        Value::Null => return None,
        Value::Bool(flag) => toml::Value::Boolean(*flag),
        Value::Number(number) => match number.as_i64() {
            Some(int) => toml::Value::Integer(int),
            None => toml::Value::Float(number.as_f64()?),
        },
        Value::String(text) => toml::Value::String(text.clone()),
        Value::Array(items) => toml::Value::Array(items.iter().filter_map(json_to_toml).collect()),
        Value::Object(map) => toml::Value::Table(
            map.iter()
                .filter_map(|(key, value)| Some((key.clone(), json_to_toml(value)?)))
                .collect(),
        ),
    })
}

// ───────────────────────────── 运行位置与启动注入 ─────────────────────────────

/// 各运行位置是否应用片段。
pub fn runtime_applicability(tool: &str) -> Vec<NativeConfigRuntime> {
    let row = |runtime: &str, applied: bool, note: Option<&str>| NativeConfigRuntime {
        runtime: runtime.to_string(),
        applied,
        note: note.map(str::to_string),
    };
    match tool {
        "codex" => vec![
            row("local", true, None),
            row("wsl", true, None),
            row("ssh", true, None),
        ],
        "claude" => vec![
            row("local", true, None),
            row("wsl", false, Some("claudeSettingsLocalOnly")),
            row("ssh", false, Some("claudeSettingsLocalOnly")),
        ],
        _ => Vec::new(),
    }
}

fn find_model<'a>(
    provider: Option<&'a Provider>,
    model_id: Option<&str>,
) -> Option<&'a crate::models::provider::ProviderModel> {
    let model_id = model_id?.trim();
    provider?.models.iter().find(|model| model.id == model_id)
}

/// 从中转站 / 模型 / 显式字段算出托管字段。
pub fn managed_fields(
    tool: &str,
    provider: Option<&Provider>,
    model_id: Option<&str>,
    effort: Option<&str>,
    yolo: bool,
) -> ManagedNativeFields {
    let model = find_model(provider, model_id);
    ManagedNativeFields {
        model_id: model_id.map(str::to_string),
        effort: effort.map(str::to_string),
        yolo,
        context_window_tokens: model.and_then(|model| model.context_window_tokens),
        codex_provider_id: provider
            .filter(|provider| tool == "codex" && provider.provider_type == ProviderType::OpenAI)
            .map(|provider| cc_cli_adapters::CodexAdapter::codex_provider_id(&provider.id)),
    }
}

/// Claude 的上下文后缀：模型显式填了 `contextSize` 用它；否则窗口 ≥ 1M 时用 `1m`。
pub fn claude_context_size(provider: Option<&Provider>, model_id: Option<&str>) -> Option<String> {
    let model = find_model(provider, model_id)?;
    if let Some(size) = model
        .context_size
        .as_deref()
        .map(str::trim)
        .filter(|size| !size.is_empty())
    {
        return Some(size.to_string());
    }
    model
        .context_window_tokens
        .filter(|tokens| *tokens >= 1_000_000)
        .map(|_| "1m".to_string())
}

/// 启动时调用：把合并结果写进 adapter options，由各适配器（本机 / WSL / SSH）注入。
pub fn apply_to_adapter_options(
    adapter_options: &mut HashMap<String, Value>,
    tool: &str,
    provider: Option<&Provider>,
    profile: Option<&LaunchProfile>,
    model_id: Option<&str>,
    yolo: bool,
) {
    adapter_options.remove(cc_cli_adapters::NATIVE_CODEX_CONFIG_OPTION);
    adapter_options.remove(cc_cli_adapters::NATIVE_CLAUDE_SETTINGS_OPTION);
    if tool == "claude" && model_id.is_some() {
        if let Some(size) = claude_context_size(provider, model_id) {
            adapter_options
                .entry("__ccpanesContextSize".to_string())
                .or_insert(Value::String(size));
        }
    }
    if fragment_format(tool).is_none() {
        return;
    }
    let effort = cc_cli_adapters::effort_from_options(adapter_options);
    let managed = managed_fields(tool, provider, model_id, effort.as_deref(), yolo);
    let merged = merge_native_config(
        tool,
        provider
            .and_then(|provider| provider.native_overrides.get(tool))
            .map(String::as_str),
        profile
            .and_then(|profile| profile.native_overrides.get(tool))
            .map(String::as_str),
        &managed,
    );
    for problem in &merged.issues {
        warn!(
            cli_tool = tool,
            layer = ?problem.layer,
            key = problem.key.as_deref().unwrap_or("<fragment>"),
            "native config: {}",
            problem.message
        );
    }
    match tool {
        "codex" => {
            let args = merged.codex_config_args();
            if !args.is_empty() {
                adapter_options.insert(
                    cc_cli_adapters::NATIVE_CODEX_CONFIG_OPTION.to_string(),
                    Value::Array(args.into_iter().map(Value::String).collect()),
                );
            }
        }
        "claude" => {
            let overlay = merged.claude_settings_overlay();
            if !overlay.is_empty() {
                adapter_options.insert(
                    cc_cli_adapters::NATIVE_CLAUDE_SETTINGS_OPTION.to_string(),
                    Value::Object(overlay),
                );
            }
        }
        _ => {}
    }
}

/// 预览：用运行配置草稿（未保存也行）+ CLI 算出生效配置。
pub fn preview_native_config(
    draft: &LaunchProfileDraft,
    tool: &str,
    providers: &[Provider],
    default_provider_id: Option<&str>,
) -> NativeConfigPreview {
    let tool = tool.trim().to_ascii_lowercase();
    let provider_id = draft
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .or(default_provider_id)
        .filter(|id| *id != SYSTEM_PROVIDER_ID);
    let provider = provider_id.and_then(|id| providers.iter().find(|provider| provider.id == id));
    let model_id = draft
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| provider.and_then(|provider| provider.default_model_id.clone()));
    let effort = cc_cli_adapters::effort_from_options(&draft.adapter_options).or_else(|| {
        find_model(provider, model_id.as_deref()).and_then(|model| model.default_effort.clone())
    });
    let Some(_) = fragment_format(&tool) else {
        return NativeConfigPreview {
            cli_tool: tool,
            supported: false,
            provider_name: provider.map(|provider| provider.name.clone()),
            model_id,
            ..NativeConfigPreview::default()
        };
    };
    let managed = managed_fields(
        &tool,
        provider,
        model_id.as_deref(),
        effort.as_deref(),
        draft.yolo_mode,
    );
    let profile_fragment = draft
        .native_overrides
        .as_ref()
        .and_then(|overrides| overrides.get(&tool))
        .map(String::as_str);
    let merged = merge_native_config(
        &tool,
        provider
            .and_then(|provider| provider.native_overrides.get(&tool))
            .map(String::as_str),
        profile_fragment,
        &managed,
    );
    NativeConfigPreview {
        entries: merged.entries(),
        runtimes: runtime_applicability(&tool),
        issues: merged.issues,
        supported: true,
        provider_name: provider.map(|provider| provider.name.clone()),
        model_id,
        cli_tool: tool,
    }
}

mod edit;
pub use edit::set_native_override_key;

#[cfg(test)]
mod tests;

//! 从 CLI 会话记录估算单个会话的美元费用。
//!
//! 只读取本地 transcript，不访问网络。价格是厂商公开的按量价，所以结果是
//! 「按 API 价折算」：订阅、中转站或云平台的实际账单可能不同，前端必须标成估算。
//!
//! 价格来源（改价时同步更新 `PRICING_AS_OF`）：
//! - Claude: <https://platform.claude.com/docs/en/about-claude/pricing>
//! - OpenAI: <https://developers.openai.com/api/docs/pricing>

use crate::models::{RateLimitSnapshot, SessionCostModelEntry};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub(crate) const PRICING_AS_OF: &str = "2026-11-02";

const USD_PER_WEB_SEARCH: f64 = 0.01;
const FAST_MODE_MULTIPLIER: f64 = 2.0;
const US_GEO_MULTIPLIER: f64 = 1.1;
/// 超长单行（通常是内嵌大文件）跳过解析，避免一次轮询解析几十 MB 的 JSON。
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const OPENAI_LONG_CONTEXT_ABOVE: u64 = 272_000;
const HAIKU_LONG_CONTEXT_ABOVE: u64 = 100_000;
const UNKNOWN_MODEL: &str = "unknown";

/// USD / 百万 token。OpenAI 没有 5 分钟 / 1 小时缓存，这两栏对应 30 分钟 / 12 小时写入。
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rates {
    input: f64,
    write_short: f64,
    write_long: f64,
    read: f64,
    output: f64,
}

const fn rates(input: f64, write_short: f64, write_long: f64, read: f64, output: f64) -> Rates {
    Rates {
        input,
        write_short,
        write_long,
        read,
        output,
    }
}

struct ModelPrice {
    key: &'static str,
    base: Rates,
    /// 单次请求的 prompt 超过阈值时，整个请求改用这组价格。
    long_context: Option<(u64, Rates)>,
    fast_mode: bool,
}

const fn flat(key: &'static str, base: Rates) -> ModelPrice {
    ModelPrice {
        key,
        base,
        long_context: None,
        fast_mode: false,
    }
}

const fn with_fast(key: &'static str, base: Rates) -> ModelPrice {
    ModelPrice {
        key,
        base,
        long_context: None,
        fast_mode: true,
    }
}

const fn openai(key: &'static str, base: Rates, long: Rates) -> ModelPrice {
    ModelPrice {
        key,
        base,
        long_context: Some((OPENAI_LONG_CONTEXT_ABOVE, long)),
        fast_mode: false,
    }
}

const OPUS_STANDARD: Rates = rates(5.0, 6.25, 10.0, 0.50, 25.0);
const OPUS_LEGACY: Rates = rates(15.0, 18.75, 30.0, 1.50, 75.0);
const SONNET_LEGACY: Rates = rates(3.0, 3.75, 6.0, 0.30, 15.0);
const FABLE_LEGACY: Rates = rates(10.0, 12.5, 20.0, 1.0, 50.0);
const FABLE_CURRENT: Rates = rates(10.0, 12.5, 20.0, 0.25, 50.0);

/// 匹配规则见 `find_price`：取最长的命中 key，所以 `claude-opus-5` 不会吃掉 `claude-opus-5-5`。
const PRICES: &[ModelPrice] = &[
    flat("claude-fable-5-1", FABLE_CURRENT),
    flat("claude-mythos-5-1", FABLE_CURRENT),
    flat("claude-fable-5", FABLE_LEGACY),
    flat("claude-mythos-5", FABLE_LEGACY),
    with_fast("claude-opus-5-5", rates(4.0, 5.0, 8.0, 0.20, 20.0)),
    with_fast("claude-opus-5", OPUS_STANDARD),
    with_fast("claude-opus-4-8", OPUS_STANDARD),
    flat("claude-opus-4-7", OPUS_STANDARD),
    flat("claude-opus-4-6", OPUS_STANDARD),
    flat("claude-opus-4-5", OPUS_STANDARD),
    flat("claude-opus-4-1", OPUS_LEGACY),
    flat("claude-opus-4", OPUS_LEGACY),
    flat("claude-sonnet-5-5", rates(2.0, 2.5, 4.0, 0.10, 10.0)),
    flat("claude-sonnet-5", rates(2.0, 2.5, 4.0, 0.20, 10.0)),
    flat("claude-sonnet-4-6", SONNET_LEGACY),
    flat("claude-sonnet-4-5", SONNET_LEGACY),
    flat("claude-sonnet-4", SONNET_LEGACY),
    ModelPrice {
        key: "claude-haiku-5-5",
        base: rates(0.10, 0.125, 0.20, 0.01, 0.50),
        long_context: Some((
            HAIKU_LONG_CONTEXT_ABOVE,
            rates(0.50, 0.625, 1.0, 0.05, 2.50),
        )),
        fast_mode: false,
    },
    flat("claude-haiku-4-5", rates(1.0, 1.25, 2.0, 0.10, 5.0)),
    flat("claude-haiku-3-5", rates(0.80, 1.0, 1.60, 0.08, 4.0)),
    openai(
        "gpt-6-astra",
        rates(10.0, 12.5, 25.0, 1.0, 50.0),
        rates(20.0, 25.0, 50.0, 2.0, 75.0),
    ),
    openai(
        "gpt-6.1-sol",
        rates(2.0, 2.5, 5.0, 0.10, 10.0),
        rates(4.0, 5.0, 10.0, 0.20, 15.0),
    ),
    openai(
        "gpt-6.1-terra",
        rates(1.0, 1.25, 2.5, 0.05, 5.0),
        rates(2.0, 2.5, 5.0, 0.10, 7.5),
    ),
    openai(
        "gpt-6-sol",
        rates(2.0, 2.5, 5.0, 0.20, 10.0),
        rates(4.0, 5.0, 10.0, 0.40, 15.0),
    ),
    openai(
        "gpt-6-luna",
        rates(0.10, 0.125, 0.25, 0.01, 0.50),
        rates(0.20, 0.25, 0.50, 0.02, 0.75),
    ),
    openai(
        "gpt-5.6-sol",
        rates(4.0, 5.0, 10.0, 0.40, 20.0),
        rates(8.0, 10.0, 20.0, 0.80, 30.0),
    ),
    openai(
        "gpt-5.6-terra",
        rates(2.0, 2.5, 5.0, 0.20, 12.0),
        rates(4.0, 5.0, 10.0, 0.40, 18.0),
    ),
    openai(
        "gpt-5.6-luna",
        rates(0.20, 0.25, 0.50, 0.02, 1.20),
        rates(0.40, 0.50, 1.0, 0.04, 1.80),
    ),
    // 官方表里这几个模型没有缓存写入价，写入按普通输入计。
    openai(
        "gpt-5.5-pro",
        rates(30.0, 30.0, 30.0, 30.0, 180.0),
        rates(60.0, 60.0, 60.0, 60.0, 270.0),
    ),
    openai(
        "gpt-5.5",
        rates(5.0, 5.0, 5.0, 0.50, 30.0),
        rates(10.0, 10.0, 10.0, 1.0, 45.0),
    ),
    openai(
        "gpt-5.4-pro",
        rates(30.0, 30.0, 30.0, 30.0, 180.0),
        rates(60.0, 60.0, 60.0, 60.0, 270.0),
    ),
    openai(
        "gpt-5.4",
        rates(2.5, 2.5, 2.5, 0.25, 15.0),
        rates(5.0, 5.0, 5.0, 0.50, 22.5),
    ),
];

/// 去掉平台前缀和上下文后缀：`us.anthropic.claude-opus-5-5-v1:0`、
/// `claude-opus-4-5@20251101`、`claude-opus-5-5[1m]`、`openai/gpt-6-sol`。
fn normalize_model(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let without_suffix = lower.split(['[', '@']).next().unwrap_or_default();
    match without_suffix.find("claude-") {
        Some(start) => without_suffix[start..].to_string(),
        None => without_suffix
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string(),
    }
}

fn find_price(model: &str) -> Option<&'static ModelPrice> {
    let normalized = normalize_model(model);
    PRICES
        .iter()
        .filter(|price| {
            normalized == price.key
                || normalized
                    .strip_prefix(price.key)
                    .is_some_and(|rest| rest.starts_with('-'))
        })
        .max_by_key(|price| price.key.len())
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct CallTokens {
    /// 未命中缓存的输入。
    input: u64,
    write_short: u64,
    write_long: u64,
    read: u64,
    output: u64,
    web_searches: u64,
    fast_mode: bool,
    us_geo: bool,
}

impl CallTokens {
    fn prompt_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.write_short)
            .saturating_add(self.write_long)
            .saturating_add(self.read)
    }
}

fn price_call(model: &str, call: &CallTokens) -> Option<f64> {
    let price = find_price(model)?;
    let selected = match price.long_context {
        Some((above, long)) if call.prompt_tokens() > above => long,
        _ => price.base,
    };
    let per_million = call.input as f64 * selected.input
        + call.write_short as f64 * selected.write_short
        + call.write_long as f64 * selected.write_long
        + call.read as f64 * selected.read
        + call.output as f64 * selected.output;
    let mut tokens_usd = per_million / 1_000_000.0;
    if call.fast_mode && price.fast_mode {
        tokens_usd *= FAST_MODE_MULTIPLIER;
    }
    if call.us_geo {
        tokens_usd *= US_GEO_MULTIPLIER;
    }
    Some(tokens_usd + call.web_searches as f64 * USD_PER_WEB_SEARCH)
}

#[derive(Debug, Clone)]
struct RecordedCall {
    model: String,
    tokens: CallTokens,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CodexTotals {
    input: u64,
    cached: u64,
    write: u64,
    output: u64,
}

impl CodexTotals {
    fn from_usage(usage: &Value) -> Self {
        Self {
            input: u64_field(usage, "input_tokens"),
            cached: u64_field(usage, "cached_input_tokens"),
            write: u64_field(usage, "cache_write_input_tokens"),
            output: u64_field(usage, "output_tokens"),
        }
    }

    fn minus(self, earlier: Self) -> Self {
        Self {
            input: self.input.saturating_sub(earlier.input),
            cached: self.cached.saturating_sub(earlier.cached),
            write: self.write.saturating_sub(earlier.write),
            output: self.output.saturating_sub(earlier.output),
        }
    }

    fn to_call(self) -> CallTokens {
        CallTokens {
            // Codex 的 input_tokens 已包含缓存读取与写入。
            input: self
                .input
                .saturating_sub(self.cached)
                .saturating_sub(self.write),
            write_short: self.write,
            read: self.cached,
            output: self.output,
            ..CallTokens::default()
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct CostTotals {
    pub cost_usd: Option<f64>,
    pub has_unpriced_usage: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub models: Vec<SessionCostModelEntry>,
    pub calls: usize,
}

/// 一个 agent 会话的累计用量。只读新增的字节，所以长会话每次轮询的代价和新增量成正比。
#[derive(Debug, Default)]
pub(crate) struct CostLedger {
    /// 文件 -> 已完整解析到的字节偏移。
    offsets: HashMap<PathBuf, u64>,
    /// Claude 的同一响应会写多行（流式），以后到的为准，所以按调用记录、读取时汇总。
    calls: HashMap<String, RecordedCall>,
    codex_model: Option<String>,
    codex_last_total: Option<CodexTotals>,
    codex_events: u64,
    /// 日志里最后一次出现的订阅额度（Codex 才有）。
    rate_limits: Option<RateLimitSnapshot>,
}

impl CostLedger {
    /// 读入主 transcript 和附属文件的新增内容。任一文件变短说明被替换或截断，
    /// 增量不再可信，整本账重算。附属文件读失败只跳过：宁可暂时少算子 agent，
    /// 也不让整个费用显示失败。
    pub(crate) fn refresh(
        &mut self,
        cli: &str,
        main: &Path,
        side_files: &[PathBuf],
    ) -> Result<(), String> {
        let shrunk = std::iter::once(main)
            .chain(side_files.iter().map(PathBuf::as_path))
            .any(|path| {
                let read_to = self.offsets.get(path).copied().unwrap_or(0);
                fs::metadata(path).is_ok_and(|metadata| metadata.len() < read_to)
            });
        if shrunk {
            *self = Self::default();
        }
        self.ingest(cli, main)?;
        for path in side_files {
            if let Err(error) = self.ingest(cli, path) {
                tracing::debug!(path = %path.display(), err = %error, "Skipping session cost side file");
            }
        }
        Ok(())
    }

    fn ingest(&mut self, cli: &str, path: &Path) -> Result<(), String> {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let start = self.offsets.get(path).copied().unwrap_or(0);
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(file);
        let mut offset = start;
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            let read = reader
                .read_until(b'\n', &mut buffer)
                .map_err(|error| error.to_string())?;
            // 没有换行的尾部是 CLI 正在写的半行，下次从这里接着读。
            if read == 0 || !buffer.ends_with(b"\n") {
                break;
            }
            let line_offset = offset;
            offset = offset.saturating_add(read as u64);
            if buffer.len() <= MAX_LINE_BYTES {
                self.ingest_line(cli, path, line_offset, &buffer);
            }
        }
        self.offsets.insert(path.to_path_buf(), offset);
        Ok(())
    }

    fn ingest_line(&mut self, cli: &str, path: &Path, offset: u64, bytes: &[u8]) {
        let line = String::from_utf8_lossy(bytes);
        let relevant = match cli {
            "claude" => line.contains("\"usage\""),
            "codex" => line.contains("\"token_count\"") || line.contains("\"model\""),
            _ => false,
        };
        if !relevant {
            return;
        }
        let Ok(json) = serde_json::from_str::<Value>(&line) else {
            return;
        };
        match cli {
            "claude" => self.ingest_claude(&json, path, offset),
            "codex" => self.ingest_codex(&json),
            _ => {}
        }
    }

    fn ingest_claude(&mut self, json: &Value, path: &Path, offset: u64) {
        if json.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let Some(message) = json.get("message") else {
            return;
        };
        let Some(usage) = message.get("usage") else {
            return;
        };
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(UNKNOWN_MODEL);
        // Claude Code 本地合成的错误消息，没有真实请求。
        if model == "<synthetic>" {
            return;
        }
        let key = match message.get("id").and_then(Value::as_str) {
            Some(id) => format!(
                "{id}:{}",
                json.get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ),
            None => format!("{}:{offset}", path.display()),
        };
        self.calls.insert(
            key,
            RecordedCall {
                model: model.to_string(),
                tokens: claude_call_tokens(usage),
            },
        );
    }

    fn ingest_codex(&mut self, json: &Value) {
        if let Some(model) = crate::services::codex_session_service::codex_model(json) {
            self.codex_model = Some(model);
        }
        let is_token_count = json.get("type").and_then(Value::as_str) == Some("event_msg")
            && json.pointer("/payload/type").and_then(Value::as_str) == Some("token_count");
        if !is_token_count {
            return;
        }
        // 只更新额度的 token_count（info 为 null 或累计值不变）也要先取额度再判重。
        if let Some(limits) =
            crate::services::rate_limit_snapshot::codex_rate_limits_from_event(json)
        {
            self.rate_limits = Some(limits);
        }
        let Some(total) = json
            .pointer("/payload/info/total_token_usage")
            .map(CodexTotals::from_usage)
        else {
            return;
        };
        // Codex 会重复发 token_count（比如只更新限额），累计值没变就不是新请求。
        if self.codex_last_total == Some(total) {
            return;
        }
        let call = json
            .pointer("/payload/info/last_token_usage")
            .map(CodexTotals::from_usage)
            .unwrap_or_else(|| total.minus(self.codex_last_total.unwrap_or_default()));
        self.codex_last_total = Some(total);
        self.codex_events += 1;
        self.calls.insert(
            format!("codex:{}", self.codex_events),
            RecordedCall {
                model: self
                    .codex_model
                    .clone()
                    .unwrap_or_else(|| UNKNOWN_MODEL.to_string()),
                tokens: call.to_call(),
            },
        );
    }

    pub(crate) fn rate_limits(&self) -> Option<&RateLimitSnapshot> {
        self.rate_limits.as_ref()
    }

    pub(crate) fn totals(&self) -> CostTotals {
        let mut totals = CostTotals {
            calls: self.calls.len(),
            ..CostTotals::default()
        };
        let mut by_model: BTreeMap<&str, Option<f64>> = BTreeMap::new();
        for call in self.calls.values() {
            let tokens = &call.tokens;
            totals.input_tokens = totals.input_tokens.saturating_add(tokens.input);
            totals.output_tokens = totals.output_tokens.saturating_add(tokens.output);
            totals.cache_read_tokens = totals.cache_read_tokens.saturating_add(tokens.read);
            totals.cache_write_tokens = totals
                .cache_write_tokens
                .saturating_add(tokens.write_short)
                .saturating_add(tokens.write_long);
            let cost = price_call(&call.model, tokens);
            let entry = by_model.entry(call.model.as_str()).or_insert(Some(0.0));
            *entry = entry.zip(cost).map(|(sum, value)| sum + value);
            match cost {
                Some(value) => totals.cost_usd = Some(totals.cost_usd.unwrap_or(0.0) + value),
                None => totals.has_unpriced_usage = true,
            }
        }
        totals.models = by_model
            .into_iter()
            .map(|(model, cost_usd)| SessionCostModelEntry {
                model: model.to_string(),
                cost_usd,
            })
            .collect();
        totals.models.sort_by(|left, right| {
            right
                .cost_usd
                .unwrap_or(-1.0)
                .total_cmp(&left.cost_usd.unwrap_or(-1.0))
        });
        totals
    }
}

fn claude_call_tokens(usage: &Value) -> CallTokens {
    let breakdown = usage.get("cache_creation");
    let write_long = breakdown.map_or(0, |value| u64_field(value, "ephemeral_1h_input_tokens"));
    let breakdown_short =
        breakdown.map_or(0, |value| u64_field(value, "ephemeral_5m_input_tokens"));
    // 旧版 transcript 没有 TTL 明细，未归类的写入按 5 分钟价算。
    let unclassified = u64_field(usage, "cache_creation_input_tokens")
        .saturating_sub(write_long)
        .saturating_sub(breakdown_short);
    CallTokens {
        input: u64_field(usage, "input_tokens"),
        write_short: breakdown_short.saturating_add(unclassified),
        write_long,
        read: u64_field(usage, "cache_read_input_tokens"),
        output: u64_field(usage, "output_tokens"),
        web_searches: usage
            .pointer("/server_tool_use/web_search_requests")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        fast_mode: usage.get("speed").and_then(Value::as_str) == Some("fast"),
        us_geo: usage.get("inference_geo").and_then(Value::as_str) == Some("us"),
    }
}

fn u64_field(value: &Value, name: &str) -> u64 {
    value.get(name).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const EPSILON: f64 = 1e-9;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < EPSILON,
            "expected {expected}, got {actual}"
        );
    }

    fn claude_line(id: &str, model: &str, usage: Value) -> String {
        format!(
            "{}\n",
            json!({
                "type": "assistant",
                "requestId": format!("req-{id}"),
                "message": { "id": id, "model": model, "usage": usage },
            })
        )
    }

    fn token_count(total: Value, last: Value) -> String {
        format!(
            "{}\n",
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": { "total_token_usage": total, "last_token_usage": last },
                },
            })
        )
    }

    fn append(path: &Path, content: &str) {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        file.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn longest_key_wins_and_platform_prefixes_are_removed() {
        assert_eq!(
            find_price("claude-opus-5-5").unwrap().key,
            "claude-opus-5-5"
        );
        assert_eq!(find_price("claude-opus-5").unwrap().key, "claude-opus-5");
        assert_eq!(
            find_price("us.anthropic.claude-opus-5-5-v1:0").unwrap().key,
            "claude-opus-5-5"
        );
        assert_eq!(
            find_price("claude-opus-4-5@20251101").unwrap().key,
            "claude-opus-4-5"
        );
        assert_eq!(
            find_price("claude-opus-4-20250514").unwrap().key,
            "claude-opus-4"
        );
        assert_eq!(
            find_price("claude-opus-5-5[1m]").unwrap().key,
            "claude-opus-5-5"
        );
        assert_eq!(find_price("openai/gpt-6-sol").unwrap().key, "gpt-6-sol");
        assert_eq!(find_price("gpt-5.5-pro").unwrap().key, "gpt-5.5-pro");
        assert_eq!(
            find_price("gpt-6.1-sol-2026-09-01").unwrap().key,
            "gpt-6.1-sol"
        );
    }

    #[test]
    fn unlisted_models_have_no_price() {
        for model in [
            "deepseek-v4-pro",
            "claude-opus-55",
            "gpt-6.2-sol",
            "",
            "<synthetic>",
        ] {
            assert!(find_price(model).is_none(), "{model} must not be priced");
        }
    }

    #[test]
    fn claude_call_uses_ttl_specific_write_prices() {
        let call = claude_call_tokens(&json!({
            "input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
            "cache_read_input_tokens": 1_000_000,
            "cache_creation_input_tokens": 3_000_000,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 1_000_000,
                "ephemeral_1h_input_tokens": 2_000_000,
            },
        }));
        // input 4 + output 20 + read 0.20 + 5m 5 + 1h 2*8
        assert_close(price_call("claude-opus-5-5", &call).unwrap(), 45.20);
    }

    #[test]
    fn writes_without_a_ttl_breakdown_use_the_short_price() {
        let call = claude_call_tokens(&json!({
            "input_tokens": 0,
            "cache_creation_input_tokens": 1_000_000,
        }));
        assert_eq!(call.write_short, 1_000_000);
        assert_close(price_call("claude-opus-5-5", &call).unwrap(), 5.0);
    }

    #[test]
    fn fast_geo_and_web_search_modifiers_apply() {
        let base = CallTokens {
            input: 1_000_000,
            ..CallTokens::default()
        };
        let fast = CallTokens {
            fast_mode: true,
            ..base
        };
        let us = CallTokens {
            us_geo: true,
            ..base
        };
        let searched = CallTokens {
            web_searches: 3,
            ..base
        };
        assert_close(price_call("claude-opus-5-5", &fast).unwrap(), 8.0);
        assert_close(price_call("claude-opus-5-5", &us).unwrap(), 4.4);
        assert_close(price_call("claude-opus-5-5", &searched).unwrap(), 4.03);
        // 不支持 fast mode 的模型不加价。
        assert_close(price_call("claude-sonnet-5-5", &fast).unwrap(), 2.0);
    }

    #[test]
    fn long_context_tier_applies_to_the_whole_request() {
        let at_threshold = CallTokens {
            read: HAIKU_LONG_CONTEXT_ABOVE,
            ..CallTokens::default()
        };
        let over_threshold = CallTokens {
            read: HAIKU_LONG_CONTEXT_ABOVE,
            input: 1,
            ..CallTokens::default()
        };
        assert_close(
            price_call("claude-haiku-5-5", &at_threshold).unwrap(),
            0.001,
        );
        assert_close(
            price_call("claude-haiku-5-5", &over_threshold).unwrap(),
            0.005 + 0.5 / 1_000_000.0,
        );
        let codex_long = CodexTotals {
            input: 300_000,
            cached: 200_000,
            write: 0,
            output: 1_000,
        }
        .to_call();
        // (100k * $20 + 200k * $2 + 1k * $75) / 1M
        assert_close(price_call("gpt-6-astra", &codex_long).unwrap(), 2.475);
    }

    #[test]
    fn streamed_duplicates_count_once_with_the_final_usage() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        append(
            &path,
            &claude_line(
                "m1",
                "claude-opus-5-5",
                json!({"input_tokens": 10, "output_tokens": 1}),
            ),
        );
        append(
            &path,
            &claude_line(
                "m1",
                "claude-opus-5-5",
                json!({"input_tokens": 10, "output_tokens": 500}),
            ),
        );
        let mut ledger = CostLedger::default();
        ledger.refresh("claude", &path, &[]).unwrap();
        let totals = ledger.totals();
        assert_eq!(totals.calls, 1);
        assert_eq!(totals.input_tokens, 10);
        assert_eq!(totals.output_tokens, 500);
    }

    #[test]
    fn duplicate_lines_across_polls_still_replace_instead_of_adding() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let mut ledger = CostLedger::default();
        append(
            &path,
            &claude_line(
                "m1",
                "claude-opus-5-5",
                json!({"input_tokens": 10, "output_tokens": 1}),
            ),
        );
        ledger.refresh("claude", &path, &[]).unwrap();
        append(
            &path,
            &claude_line(
                "m1",
                "claude-opus-5-5",
                json!({"input_tokens": 10, "output_tokens": 500}),
            ),
        );
        ledger.refresh("claude", &path, &[]).unwrap();
        assert_eq!(ledger.totals().output_tokens, 500);
    }

    #[test]
    fn a_half_written_line_is_read_once_it_is_complete() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let line = claude_line("m1", "claude-opus-5-5", json!({"input_tokens": 10}));
        let (head, tail) = line.split_at(line.len() / 2);
        append(&path, head);
        let mut ledger = CostLedger::default();
        ledger.refresh("claude", &path, &[]).unwrap();
        assert_eq!(ledger.totals().calls, 0);
        append(&path, tail);
        ledger.refresh("claude", &path, &[]).unwrap();
        assert_eq!(ledger.totals().calls, 1);
    }

    #[test]
    fn truncated_transcript_resets_the_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        append(
            &path,
            &claude_line("old-1", "claude-opus-5-5", json!({"input_tokens": 10})),
        );
        append(
            &path,
            &claude_line("old-2", "claude-opus-5-5", json!({"input_tokens": 10})),
        );
        let mut ledger = CostLedger::default();
        ledger.refresh("claude", &path, &[]).unwrap();
        fs::write(
            &path,
            claude_line("new", "claude-opus-5-5", json!({"input_tokens": 7})),
        )
        .unwrap();
        ledger.refresh("claude", &path, &[]).unwrap();
        let totals = ledger.totals();
        assert_eq!(totals.calls, 1);
        assert_eq!(totals.input_tokens, 7);
    }

    #[test]
    fn subagent_files_add_to_the_session_and_a_missing_one_is_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("session.jsonl");
        let side = temp.path().join("agent-1.jsonl");
        append(
            &main,
            &claude_line("m1", "claude-opus-5-5", json!({"input_tokens": 1_000_000})),
        );
        append(
            &side,
            &claude_line("s1", "claude-haiku-5-5", json!({"input_tokens": 1_000_000})),
        );
        let missing = temp.path().join("gone.jsonl");
        let mut ledger = CostLedger::default();
        ledger.refresh("claude", &main, &[side, missing]).unwrap();
        let totals = ledger.totals();
        assert_eq!(totals.calls, 2);
        // Haiku 超过 100k 走高价：$0.50/M
        assert_close(totals.cost_usd.unwrap(), 4.5);
        assert_eq!(totals.models[0].model, "claude-opus-5-5");
    }

    #[test]
    fn missing_main_transcript_is_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let mut ledger = CostLedger::default();
        assert!(ledger
            .refresh("claude", &temp.path().join("nope.jsonl"), &[])
            .is_err());
    }

    #[test]
    fn unknown_models_are_flagged_without_hiding_priced_usage() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        append(
            &path,
            &claude_line("m1", "claude-opus-5-5", json!({"input_tokens": 1_000_000})),
        );
        append(
            &path,
            &claude_line("m2", "deepseek-v4-pro", json!({"input_tokens": 1_000_000})),
        );
        let mut ledger = CostLedger::default();
        ledger.refresh("claude", &path, &[]).unwrap();
        let totals = ledger.totals();
        assert_close(totals.cost_usd.unwrap(), 4.0);
        assert!(totals.has_unpriced_usage);
        assert_eq!(totals.input_tokens, 2_000_000);
        assert_eq!(totals.models.last().unwrap().cost_usd, None);
    }

    #[test]
    fn only_unknown_models_means_no_cost() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        append(
            &path,
            &claude_line("m1", "deepseek-v4-pro", json!({"input_tokens": 5})),
        );
        let mut ledger = CostLedger::default();
        ledger.refresh("claude", &path, &[]).unwrap();
        assert_eq!(ledger.totals().cost_usd, None);
    }

    #[test]
    fn synthetic_and_non_assistant_lines_are_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        append(
            &path,
            &claude_line("m1", "<synthetic>", json!({"input_tokens": 5})),
        );
        append(
            &path,
            &format!(
                "{}\n",
                json!({"type": "user", "message": {"id": "u", "usage": {"input_tokens": 5}}})
            ),
        );
        append(&path, "not json but mentions \"usage\"\n");
        let mut ledger = CostLedger::default();
        ledger.refresh("claude", &path, &[]).unwrap();
        assert_eq!(ledger.totals().calls, 0);
    }

    #[test]
    fn codex_repeated_token_counts_are_not_new_requests() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        let usage = json!({
            "input_tokens": 22_451,
            "cached_input_tokens": 13_056,
            "cache_write_input_tokens": 0,
            "output_tokens": 155,
        });
        append(
            &path,
            &format!(
                "{}\n",
                json!({"type": "turn_context", "payload": {"model": "gpt-6.1-sol"}})
            ),
        );
        append(&path, &token_count(usage.clone(), usage.clone()));
        append(&path, &token_count(usage.clone(), usage));
        let mut ledger = CostLedger::default();
        ledger.refresh("codex", &path, &[]).unwrap();
        let totals = ledger.totals();
        assert_eq!(totals.calls, 1);
        assert_eq!(totals.input_tokens, 22_451 - 13_056);
        assert_eq!(totals.cache_read_tokens, 13_056);
        assert_eq!(totals.models[0].model, "gpt-6.1-sol");
        // (9395 * $2 + 13056 * $0.10 + 155 * $10) / 1M
        assert_close(totals.cost_usd.unwrap(), 0.0216456);
    }

    #[test]
    fn codex_without_last_usage_falls_back_to_the_total_delta() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        for total in [100, 300] {
            append(
                &path,
                &format!(
                    "{}\n",
                    json!({
                        "type": "event_msg",
                        "payload": {
                            "type": "token_count",
                            "info": { "total_token_usage": {"input_tokens": total} },
                        },
                    })
                ),
            );
        }
        let mut ledger = CostLedger::default();
        ledger.refresh("codex", &path, &[]).unwrap();
        let totals = ledger.totals();
        assert_eq!(totals.calls, 2);
        assert_eq!(totals.input_tokens, 300);
        assert!(totals.has_unpriced_usage, "no turn_context means no model");
    }

    #[test]
    fn codex_token_count_without_info_is_skipped() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        append(
            &path,
            &format!(
                "{}\n",
                json!({"type": "event_msg", "payload": {"type": "token_count", "info": null}})
            ),
        );
        let mut ledger = CostLedger::default();
        ledger.refresh("codex", &path, &[]).unwrap();
        assert_eq!(ledger.totals().calls, 0);
    }

    #[test]
    fn codex_rate_limits_follow_the_latest_token_count() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        let limits = |used: f64| {
            format!(
                "{}\n",
                json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": null,
                        "rate_limits": {"primary": {"used_percent": used, "window_minutes": 300, "resets_at": 1_900_000_000}},
                    },
                })
            )
        };
        let mut ledger = CostLedger::default();
        append(&path, &limits(10.0));
        ledger.refresh("codex", &path, &[]).unwrap();
        assert_eq!(ledger.rate_limits().unwrap().windows[0].used_percent, 10.0);
        append(&path, &limits(55.0));
        ledger.refresh("codex", &path, &[]).unwrap();
        let latest = ledger.rate_limits().unwrap();
        assert_eq!(latest.windows[0].used_percent, 55.0);
        assert_eq!(latest.windows[0].resets_at, Some(1_900_000_000_000));
        assert_eq!(
            ledger.totals().calls,
            0,
            "limit-only events are not requests"
        );
    }

    #[test]
    fn claude_transcripts_carry_no_rate_limits() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        append(
            &path,
            &claude_line(
                "msg_1",
                "claude-sonnet-4-5",
                json!({"input_tokens": 10, "output_tokens": 5}),
            ),
        );
        let mut ledger = CostLedger::default();
        ledger.refresh("claude", &path, &[]).unwrap();
        assert!(ledger.rate_limits().is_none());
    }
}

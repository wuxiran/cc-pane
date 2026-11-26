//! 探针请求：Anthropic Messages / OpenAI Responses / OpenAI Chat 三种接口，统一成
//! 「发一条消息 → 拿回文本、usage、原始 JSON」。密钥只在请求头里，不进日志、不进报告。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Anthropic,
    Responses,
    Chat,
}

impl Protocol {
    /// 钓鱼探针里自称的系列名。
    pub fn family(self) -> &'static str {
        match self {
            Protocol::Anthropic => "claude",
            Protocol::Responses | Protocol::Chat => "GPT",
        }
    }
}

/// 一次探针请求。
#[derive(Debug, Clone, Default)]
pub struct Probe {
    pub system: Option<String>,
    pub user: String,
    pub max_tokens: u32,
    /// 仅 Anthropic：带上新版参数（adaptive thinking + output_config.effort）。
    pub new_params: bool,
}

#[derive(Debug, Clone)]
pub struct ProbeReply {
    pub status: u16,
    pub body: Value,
    /// 非 2xx 时的错误原文（截断前）。
    pub error_text: Option<String>,
}

impl ProbeReply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// 回复的可见文本（思考块不算）。
    pub fn text(&self, protocol: Protocol) -> String {
        match protocol {
            Protocol::Anthropic => self
                .body
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| block.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default(),
            Protocol::Responses => {
                if let Some(text) = self.body.get("output_text").and_then(Value::as_str) {
                    return text.to_string();
                }
                self.body
                    .get("output")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter(|item| {
                                item.get("type").and_then(Value::as_str) == Some("message")
                            })
                            .filter_map(|item| item.get("content").and_then(Value::as_array))
                            .flatten()
                            .filter_map(|part| part.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default()
            }
            Protocol::Chat => self
                .body
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }
    }

    pub fn usage(&self) -> Option<&Value> {
        self.body.get("usage")
    }
}

/// 接口地址：以 `/vN` 结尾的直接接后缀，否则补 `/v1`（与前端 `endpointFor` 一致）。
pub fn endpoint_url(base: &str, suffix: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let has_version = base.rsplit('/').next().is_some_and(|last| {
        last.len() >= 2 && last.starts_with('v') && last[1..].chars().all(|c| c.is_ascii_digit())
    });
    if has_version {
        format!("{base}{suffix}")
    } else {
        format!("{base}/v1{suffix}")
    }
}

pub struct ProbeClient {
    http: reqwest::Client,
    protocol: Protocol,
    base: String,
    key: String,
}

impl ProbeClient {
    pub fn new(protocol: Protocol, base: &str, key: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(15))
            // 有些中转按 UA 黑名单拦默认客户端（skill 里同样伪装成 curl）。
            .user_agent("curl/8.4.0")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            protocol,
            base: base.to_string(),
            key: key.to_string(),
        }
    }

    pub fn protocol(&self) -> Protocol {
        self.protocol
    }

    fn payload(&self, model: &str, probe: &Probe) -> (String, Value) {
        match self.protocol {
            Protocol::Anthropic => {
                let mut body = json!({
                    "model": model,
                    "max_tokens": probe.max_tokens,
                    "messages": [{"role": "user", "content": probe.user}],
                });
                if let Some(system) = &probe.system {
                    body["system"] = json!(system);
                }
                if probe.new_params {
                    body["thinking"] = json!({"type": "adaptive", "display": "summarized"});
                    body["output_config"] = json!({"effort": "max"});
                }
                (endpoint_url(&self.base, "/messages"), body)
            }
            Protocol::Responses => {
                let mut body = json!({
                    "model": model,
                    "input": probe.user,
                    // 推理型号的思考也占输出额度，给足，免得只剩空回复。
                    "max_output_tokens": probe.max_tokens.max(256),
                    "store": false,
                });
                if let Some(system) = &probe.system {
                    body["instructions"] = json!(system);
                }
                (endpoint_url(&self.base, "/responses"), body)
            }
            Protocol::Chat => {
                let mut messages = Vec::new();
                if let Some(system) = &probe.system {
                    messages.push(json!({"role": "system", "content": system}));
                }
                messages.push(json!({"role": "user", "content": probe.user}));
                let body = json!({
                    "model": model,
                    "messages": messages,
                    "max_tokens": probe.max_tokens.max(16),
                });
                (endpoint_url(&self.base, "/chat/completions"), body)
            }
        }
    }

    /// 发一次探针。403 / 429 / 503 退避重试三次（2s / 4s / 6s）；网络错误返回 Err。
    pub async fn send(&self, model: &str, probe: &Probe) -> Result<ProbeReply, String> {
        let (url, body) = self.payload(model, probe);
        let mut bearer = true;
        let mut attempt = 0u64;
        loop {
            let mut request = self.http.post(&url).json(&body);
            request = match self.protocol {
                Protocol::Anthropic => {
                    let request = request
                        .header("x-api-key", &self.key)
                        .header("anthropic-version", "2023-06-01");
                    // 两种鉴权头都带，兼容只认 Bearer 的中转；有中转拒绝两个同时出现，那时去掉 Bearer 重发。
                    if bearer {
                        request.bearer_auth(&self.key)
                    } else {
                        request
                    }
                }
                Protocol::Responses | Protocol::Chat => request.bearer_auth(&self.key),
            };
            let response = request.send().await.map_err(|error| {
                // reqwest 的错误里可能带 URL，不带密钥；保险起见只留类别。
                if error.is_timeout() {
                    "timeout".to_string()
                } else if error.is_connect() {
                    "connect failed".to_string()
                } else {
                    "request failed".to_string()
                }
            })?;
            let status = response.status().as_u16();
            let raw = response.text().await.unwrap_or_default();
            let body_json: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            if matches!(status, 403 | 429 | 503) && attempt < 3 {
                attempt += 1;
                tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
                continue;
            }
            if self.protocol == Protocol::Anthropic
                && bearer
                && matches!(status, 400 | 401)
                && raw.to_lowercase().contains("authorization")
                && raw.to_lowercase().contains("x-api-key")
            {
                bearer = false;
                continue;
            }
            let ok = (200..300).contains(&status);
            return Ok(ProbeReply {
                status,
                body: body_json,
                error_text: (!ok).then(|| scrub(&raw, &self.key)),
            });
        }
    }

    /// 拉 `/models`。拿不到返回空。
    pub async fn list_models(&self) -> Vec<String> {
        let url = endpoint_url(&self.base, "/models");
        let mut request = self.http.get(url).bearer_auth(&self.key);
        if self.protocol == Protocol::Anthropic {
            request = request
                .header("x-api-key", &self.key)
                .header("anthropic-version", "2023-06-01");
        }
        let Ok(response) = request.send().await else {
            return Vec::new();
        };
        let Ok(body) = response.json::<Value>().await else {
            return Vec::new();
        };
        body.get("data")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// 错误原文里万一回显了密钥，抹掉。
fn scrub(text: &str, key: &str) -> String {
    if key.len() >= 8 && text.contains(key) {
        text.replace(key, "***")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_adds_v1_only_when_missing() {
        assert_eq!(
            endpoint_url("https://a.test", "/messages"),
            "https://a.test/v1/messages"
        );
        assert_eq!(
            endpoint_url("https://a.test/", "/messages"),
            "https://a.test/v1/messages"
        );
        assert_eq!(
            endpoint_url("https://a.test/v1", "/responses"),
            "https://a.test/v1/responses"
        );
        assert_eq!(
            endpoint_url("https://a.test/api/v3/", "/chat/completions"),
            "https://a.test/api/v3/chat/completions"
        );
        assert_eq!(
            endpoint_url("https://a.test/vendor", "/models"),
            "https://a.test/vendor/v1/models"
        );
    }

    #[test]
    fn reply_text_for_each_protocol() {
        let anthropic = ProbeReply {
            status: 200,
            body: json!({"content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": "hi"}]}),
            error_text: None,
        };
        assert_eq!(anthropic.text(Protocol::Anthropic), "hi");
        let responses = ProbeReply {
            status: 200,
            body: json!({"output": [{"type": "reasoning"}, {"type": "message", "content": [{"type": "output_text", "text": "yo"}]}]}),
            error_text: None,
        };
        assert_eq!(responses.text(Protocol::Responses), "yo");
        let chat = ProbeReply {
            status: 200,
            body: json!({"choices": [{"message": {"content": "hey"}}]}),
            error_text: None,
        };
        assert_eq!(chat.text(Protocol::Chat), "hey");
    }

    #[test]
    fn scrub_removes_echoed_key() {
        assert_eq!(scrub("bad key sk-abcdef123", "sk-abcdef123"), "bad key ***");
        assert_eq!(scrub("no key", "sk-abcdef123"), "no key");
    }
}

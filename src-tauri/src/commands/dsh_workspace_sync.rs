//! dsh 的 loopback HTTP RPC 客户端：工作区推送 + 会话消息注入
//!
//! dsh 的会话必须先选一个工作区才能开始（它的输入框在没选之前是禁用的，
//! 占位文案就是「选择一个工作区开始」）。用户在 CC-Panes 里已经维护了一份
//! 项目清单，没有理由让他在 dsh 里再手动添加一遍。
//!
//! 所有调用都走它的 `/api/<method>` RPC。认证层面**没有 token**——dsh 的
//! browser-trust fence 靠 loopback Host + Origin 同源判定，reqwest 从本机
//! 直连、不带 Origin 即放行（`Origin` 缺失 → trusted）。`workspace.create`
//! 对同一路径**幂等**（重复调用返回既有记录），每次实例启动推一遍是安全的。
//! `session.prompt` 与 dsh UI 输入框走同一条代码路径（`createUserMessage`），
//! 官方注释明说「the method stays callable regardless」——输入框禁用只是
//! UI 表象，这是受支持的注入口，不是私有 API 盗洞。
//!
//! 放在命令层而非 `DshService`：service 只管「怎么起一个进程」，
//! 「推什么内容进去」属于装配，且 HTTP 客户端（reqwest）只在这一层有。

use serde_json::json;
use tracing::{debug, info, warn};

/// dsh 的 RPC 信封。字段名与顺序由它的 schema 定死，缺任何一个都会被
/// 判为 `invalid client-request message`。
fn envelope(method: &str, payload: serde_json::Value) -> serde_json::Value {
    json!({
        "type": "client-request",
        "rpcId": format!("ccpanes-{method}"),
        "method": method,
        "payload": payload,
    })
}

/// 回环专用 HTTP 客户端。`.no_proxy()` 必须有——系统代理会把 127.0.0.1 也拦下来。
fn loopback_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .no_proxy()
        .build()
}

/// 调一次 dsh RPC，返回 `/result/value`。`ok != true` 与网络失败都归为 Err(描述)。
async fn call_dsh(
    client: &reqwest::Client,
    port: u16,
    method: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/api/{method}");
    let body = envelope(method, payload);
    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("failed to reach dsh {method}: {e}"))?;
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("unreadable dsh {method} reply: {e}"))?;
    if value.pointer("/result/ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!("dsh rejected {method}: {value}"));
    }
    Ok(value
        .pointer("/result/value")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// dsh 会话清单里我们关心的字段。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshSessionInfo {
    pub session_id: String,
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// 列出某个 dsh 实例的全部会话。
pub async fn list_sessions(port: u16) -> Result<Vec<DshSessionInfo>, String> {
    let client = loopback_client().map_err(|e| format!("http client build failed: {e}"))?;
    let value = call_dsh(&client, port, "session.list", json!({})).await?;
    let items = value
        .get("items")
        .cloned()
        .unwrap_or(serde_json::Value::Array(Vec::new()));
    serde_json::from_value(items).map_err(|e| format!("unexpected session.list shape: {e}"))
}

/// 从会话清单里挑出「此刻正在跑 agent 轮次」的那一个。
///
/// 这是 dsh leader 身份识别的核心：MCP 调用不携带 dsh 会话身份（mcp-client
/// 是实例级的），但 agent 只有在**跑轮次**时才可能调工具——调用发生的那一刻，
/// 调用者的会话必然 `running: true`。多个同时 running（罕见）时取 `updatedAt`
/// 最新的；一个都没有说明调用不是从 dsh 会话里发起的。
pub fn pick_running_session(sessions: &[DshSessionInfo]) -> Option<&DshSessionInfo> {
    let mut running: Vec<&DshSessionInfo> = sessions.iter().filter(|s| s.running).collect();
    match running.len() {
        0 => None,
        1 => Some(running[0]),
        n => {
            // updatedAt 是 RFC3339，字典序即时间序；缺失的排最前（最不可能是调用者）。
            running.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
            let chosen = running[n - 1];
            warn!(
                candidates = n,
                chosen = %chosen.session_id,
                "multiple dsh sessions are running; picking the most recently updated as leader"
            );
            Some(chosen)
        }
    }
}

/// 往某个 dsh 会话注入一条用户消息（`mode: "queue"`——它忙时在 dsh 侧排队，
/// 空闲时触发新一轮对话）。消息会出现在它的聊天界面里，与用户手打的一样。
pub async fn prompt_session(port: u16, session_id: &str, text: &str) -> Result<(), String> {
    let client = loopback_client().map_err(|e| format!("http client build failed: {e}"))?;
    let value = call_dsh(
        &client,
        port,
        "session.prompt",
        json!({
            "sessionId": session_id,
            "mode": "queue",
            "content": [{ "type": "text", "text": text }],
        }),
    )
    .await?;
    if value.get("accepted").and_then(|v| v.as_bool()) == Some(true) {
        Ok(())
    } else {
        Err(format!("dsh did not accept session.prompt: {value}"))
    }
}

/// 把若干项目路径注册进某个 dsh 实例的工作区列表。
///
/// **尽力而为**：任何一步失败都只记日志，不影响标签可用——推送失败的后果
/// 是用户自己点一下「选择工作区」，而把它做成硬失败会让整个标签打不开。
pub async fn push_workspaces(port: u16, project_paths: Vec<String>) {
    if project_paths.is_empty() {
        return;
    }
    let client = match loopback_client() {
        Ok(client) => client,
        Err(error) => {
            warn!(%error, "failed to build http client for dsh workspace sync");
            return;
        }
    };

    let mut created = 0usize;
    for path in &project_paths {
        // dsh 会对路径做 realpath 规范化并拒绝不存在的目录，所以这里
        // 先过一道存在性检查——否则每个失效项目都会换回一条无用的错误日志。
        if !std::path::Path::new(path).is_dir() {
            debug!(path = %path, "skipping dsh workspace push for a missing directory");
            continue;
        }
        let url = format!("http://127.0.0.1:{port}/api/workspace.create");
        let body = envelope("workspace.create", json!({ "path": path }));
        match client.post(&url).json(&body).send().await {
            Ok(response) => match response.json::<serde_json::Value>().await {
                Ok(value) => {
                    if value.pointer("/result/ok").and_then(|v| v.as_bool()) == Some(true) {
                        // `created: false` 表示这个路径已经注册过——幂等命中，
                        // 不是失败，不该记成警告。
                        if value
                            .pointer("/result/value/created")
                            .and_then(|v| v.as_bool())
                            == Some(true)
                        {
                            created += 1;
                        }
                    } else {
                        warn!(path = %path, response = %value, "dsh rejected workspace.create");
                    }
                }
                Err(error) => warn!(path = %path, %error, "unreadable dsh workspace.create reply"),
            },
            Err(error) => {
                warn!(path = %path, %error, "failed to reach dsh for workspace.create");
                // 一条都发不出去通常意味着实例已经没了，继续重试没有意义。
                return;
            }
        }
    }

    if created > 0 {
        info!(
            port,
            created, "registered CC-Panes projects into dsh workspaces"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, running: bool, updated_at: Option<&str>) -> DshSessionInfo {
        DshSessionInfo {
            session_id: id.to_string(),
            running,
            updated_at: updated_at.map(str::to_string),
        }
    }

    /// leader 识别的三分支：0 个 running → None（调用不是从 dsh 会话发起）；
    /// 恰好 1 个 → 锁定；多个 → 取 updatedAt 最新（agent 正在跑轮次的那个
    /// 大概率刚更新过）。
    #[test]
    fn pick_running_session_covers_zero_one_many() {
        assert!(pick_running_session(&[session("a", false, None)]).is_none());
        assert!(pick_running_session(&[]).is_none());

        let sessions = [session("a", false, None), session("b", true, None)];
        assert_eq!(pick_running_session(&sessions).unwrap().session_id, "b");

        let sessions = [
            session("old", true, Some("2026-08-14T10:00:00Z")),
            session("new", true, Some("2026-08-14T12:00:00Z")),
            session("idle", false, Some("2026-08-14T13:00:00Z")),
        ];
        assert_eq!(pick_running_session(&sessions).unwrap().session_id, "new");
    }

    /// updatedAt 缺失的 running 会话排最前（最不可能是调用者）——
    /// 有时间戳的候选必须赢过没有的。
    #[test]
    fn pick_running_session_prefers_timestamped_candidates() {
        let sessions = [
            session("no-ts", true, None),
            session("with-ts", true, Some("2026-08-14T12:00:00Z")),
        ];
        assert_eq!(
            pick_running_session(&sessions).unwrap().session_id,
            "with-ts"
        );
    }

    /// session.list 的真实响应形状必须能反序列化（字段是 camelCase，
    /// 且有一堆我们不关心的字段要被忽略）。
    #[test]
    fn dsh_session_info_deserializes_the_real_shape() {
        let raw = serde_json::json!([{
            "sessionId": "session-abc",
            "updatedAt": "2026-08-14T09:21:44.048Z",
            "running": true,
            "blank": false,
            "cwd": "/some/where",
            "agentPreset": "default"
        }]);
        let parsed: Vec<DshSessionInfo> = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed[0].session_id, "session-abc");
        assert!(parsed[0].running);
    }
}

//! MCP JSON-RPC 协议分发，stdio 与 HTTP 两种传输共用。
//! 工具名 / 参数名 / 默认值 / 描述（中文 docstring）与 Python 版保持一致。

use crate::session::WeChatSession;
use crate::tools::{self, ToolOutcome};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Mutex;

/// 支持的协议版本；initialize 回显客户端请求的版本，未知时用最后一个。
const SUPPORTED: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL: &str = "2025-06-18";

/// 处理一条 JSON-RPC 消息。请求返回 Some(响应)，通知返回 None。
pub fn handle_message(session: &Mutex<WeChatSession>, req: &Value) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    // 通知（无 id）：initialized / cancelled 等，不回响应。
    let id = id?;

    match method {
        "initialize" => Some(ok_result(id, initialize_result(&params))),
        "ping" => Some(ok_result(id, json!({}))),
        "tools/list" => Some(ok_result(id, json!({ "tools": tool_list() }))),
        "tools/call" => Some(handle_tool_call(session, id, &params)),
        _ => Some(error_result(id, -32601, &format!("方法不存在: {method}"))),
    }
}

fn initialize_result(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_PROTOCOL);
    let proto = if SUPPORTED.contains(&requested) {
        requested
    } else {
        DEFAULT_PROTOCOL
    };
    json!({
        "protocolVersion": proto,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "wechat", "version": crate::VERSION },
    })
}

fn ok_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_result(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn handle_tool_call(session: &Mutex<WeChatSession>, id: Value, params: &Value) -> Value {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    let mut s = session.lock().unwrap();
    let outcome = dispatch_tool(&mut s, name, &args);
    drop(s);

    match outcome {
        Some(ToolOutcome::Json(v)) => {
            // 文本 content，JSON 字符串中文不转义（serde_json 默认即不转义非 ASCII）。
            let text = serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string());
            ok_result(
                id,
                json!({ "content": [ { "type": "text", "text": text } ] }),
            )
        }
        Some(ToolOutcome::Image { data, mime }) => {
            let b64 = STANDARD.encode(&data);
            ok_result(
                id,
                json!({ "content": [ { "type": "image", "data": b64, "mimeType": mime } ] }),
            )
        }
        None => error_result(id, -32602, &format!("未知工具: {name}")),
    }
}

fn arg_str<'a>(args: &'a Value, key: &str, default: &'a str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or(default)
        .to_string()
}
fn arg_i64(args: &Value, key: &str, default: i64) -> i64 {
    args.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
}
fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// 工具分发。未知名字返回 None。
pub fn dispatch_tool(s: &mut WeChatSession, name: &str, args: &Value) -> Option<ToolOutcome> {
    let out = match name {
        "wechat_status" => tools::wechat_status(s),
        "list_contacts" => {
            tools::list_contacts(s, &arg_str(args, "query", ""), arg_i64(args, "limit", 50))
        }
        "list_conversations" => tools::list_conversations(s, arg_i64(args, "limit", 50)),
        "get_messages" => tools::get_messages(
            s,
            &arg_str(args, "conversation", ""),
            arg_i64(args, "limit", 30),
            arg_bool(args, "refresh", false),
        ),
        "search_messages" => tools::search_messages(
            s,
            &arg_str(args, "keyword", ""),
            arg_i64(args, "limit", 50),
            arg_i64(args, "days", 0),
            arg_i64(args, "per_conv_scan", 500),
            arg_bool(args, "refresh", false),
        ),
        "get_image" => tools::get_image(
            s,
            &arg_str(args, "conversation", ""),
            &arg_str(args, "image", ""),
            arg_i64(args, "max_side", 1600).max(1) as u32,
            &arg_str(args, "save_dir", ""),
        ),
        "reload" => tools::reload(s),
        _ => return None,
    };
    Some(out)
}

/// 7 个工具的 schema + 中文描述（沿用 Python docstring）。
pub fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "wechat_status",
            "description": "检查微信数据链路状态：进程是否在跑、数据库位置、密钥是否已缓存。\n\n这是排查问题的第一步；不会触发解密，很快返回。",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "list_contacts",
            "description": "列出/搜索联系人与群。\n\nArgs:\n    query: 按备注、昵称或 wxid 模糊匹配；留空则返回前 limit 条。\n    limit: 最多返回多少条（默认 50）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "default": "" },
                    "limit": { "type": "integer", "default": 50 }
                }
            }
        }),
        json!({
            "name": "list_conversations",
            "description": "列出有聊天记录的会话（即存在消息表的联系人/群），附最近一条消息时间。\n\nArgs:\n    limit: 最多返回多少个会话（默认 50）。",
            "inputSchema": {
                "type": "object",
                "properties": { "limit": { "type": "integer", "default": 50 } }
            }
        }),
        json!({
            "name": "get_messages",
            "description": "读取某个会话的最近消息（按时间升序）。\n\nArgs:\n    conversation: 会话标识，可传 wxid，或联系人备注/昵称（模糊匹配）。\n    limit: 返回最近多少条（默认 30）。\n    refresh: True 时强制重新解密，拿到最新消息（默认走 TTL 缓存）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "conversation": { "type": "string" },
                    "limit": { "type": "integer", "default": 30 },
                    "refresh": { "type": "boolean", "default": false }
                },
                "required": ["conversation"]
            }
        }),
        json!({
            "name": "search_messages",
            "description": "全局按关键词搜消息（跨所有会话）。\n\n消息内容多为 zstd 压缩，无法用 SQL LIKE，故按时间窗口取最近若干条后在内存里解压过滤。\n\nArgs:\n    keyword: 关键词（大小写不敏感）。\n    limit: 最多返回多少条命中（默认 50）。\n    days: 只搜最近 N 天（0=不限，默认）。范围越小越快。\n    per_conv_scan: 每个会话最多扫描多少条最近消息（默认 500，防止全表扫描过慢）。\n    refresh: True 时强制重新解密（默认走 TTL 缓存）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "keyword": { "type": "string" },
                    "limit": { "type": "integer", "default": 50 },
                    "days": { "type": "integer", "default": 0 },
                    "per_conv_scan": { "type": "integer", "default": 500 },
                    "refresh": { "type": "boolean", "default": false }
                },
                "required": ["keyword"]
            }
        }),
        json!({
            "name": "get_image",
            "description": "取一张聊天图片（解密微信本地 .dat），直接以图片形式返回。\n\nArgs:\n    conversation: 会话 wxid（get_messages 返回的 conversation）。\n    image: get_messages 里图片消息的 image 字段（32 位 hex 文件名）。\n    max_side: 长边超过该值时缩小并转 JPEG（默认 1600）。\n    save_dir: 非空时另存原图到该目录（运行 MCP 的 Windows 机器上），返回路径。\n\n只能取到微信本地已下载的图（高清 > 普通 > 缩略图）；wxgf(HEVC) 格式需本机有 ffmpeg 才能转码，否则退回缩略图。首次调用会推导图片密钥，约半分钟（之后缓存）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "conversation": { "type": "string" },
                    "image": { "type": "string" },
                    "max_side": { "type": "integer", "default": 1600 },
                    "save_dir": { "type": "string", "default": "" }
                },
                "required": ["conversation", "image"]
            }
        }),
        json!({
            "name": "reload",
            "description": "强制重置：重新定位微信进程、重新提取密钥、重新解密。\n\n微信重启 / 重新登录 / 换了账号导致 PID 或密钥变化后调用。",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ]
}

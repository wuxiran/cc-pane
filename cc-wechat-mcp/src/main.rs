//! cc-wechat-mcp 入口。
//!
//! 子命令/开关：
//!   cc-wechat-mcp            默认 stdio JSON-RPC
//!   cc-wechat-mcp status     打印一行 wechat_status 的 JSON 后退出（给设置页检测用，不解密）
//!   cc-wechat-mcp --version  打印版本
//! 环境：MODE=http 且有 PORT 时起 streamable HTTP（只监听 127.0.0.1:PORT）。

use cc_wechat_mcp::session::WeChatSession;
use cc_wechat_mcp::tools::ToolOutcome;
use cc_wechat_mcp::{logx, tools, transport};
use std::sync::{Arc, Mutex};

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("cc-wechat-mcp {}", cc_wechat_mcp::VERSION);
        return;
    }

    if args.get(1).map(|s| s.as_str()) == Some("status") {
        // 快速检测：只定位，不解密。日志走 stderr（这里不进 HTTP 模式）。
        logx::init(false);
        let mut s = WeChatSession::new();
        let out = tools::wechat_status(&mut s);
        if let ToolOutcome::Json(v) = out {
            println!("{}", serde_json::to_string(&v).unwrap_or_default());
        }
        return;
    }

    // HTTP 模式：MODE=http 且有 PORT。
    let http_mode = std::env::var("MODE")
        .map(|m| m.eq_ignore_ascii_case("http"))
        .unwrap_or(false);
    let port: Option<u16> = std::env::var("PORT").ok().and_then(|p| p.parse().ok());
    let use_http = http_mode && port.is_some();

    logx::init(use_http);

    let session: transport::Shared = Arc::new(Mutex::new(WeChatSession::new()));

    // Ctrl+C / 终止：尽力清理临时明文库后退出。
    {
        let s = session.clone();
        let _ = ctrlc::set_handler(move || {
            if let Ok(mut g) = s.lock() {
                g.cleanup();
            }
            std::process::exit(130);
        });
    }

    if use_http {
        if let Err(e) = transport::run_http(session.clone(), port.unwrap()) {
            log::error!("HTTP 服务异常退出: {e}");
            session.lock().unwrap().cleanup();
            std::process::exit(1);
        }
    } else {
        transport::run_stdio(session);
    }
}

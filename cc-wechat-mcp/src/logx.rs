//! 日志：stdout 归 JSON-RPC 协议专用，日志只走 stderr 或指定文件。
//!
//! 隐私红线（移植契约）：日志里绝不写密钥明文 / 消息正文 / 联系人名；
//! 密钥最多打印前后各 4 个 hex（见 `mask_key`）。因此这里自建极简 logger，
//! 而不是用 env_logger —— 要完全掌控输出目标，并在 HTTP 模式下可把 stderr 丢弃。

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;

use log::{Level, LevelFilter, Metadata, Record};

enum Sink {
    Stderr,
    File(Mutex<std::fs::File>),
    /// HTTP 模式且未配置 WECHAT_MCP_LOG：stderr 被丢弃，日志无处可去。
    Discard,
}

struct SimpleLogger {
    sink: Sink,
}

impl log::Log for SimpleLogger {
    fn enabled(&self, meta: &Metadata) -> bool {
        meta.level() <= Level::Info
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let ts = chrono::Local::now().format("%H:%M:%S");
        let line = format!("{} {} {}\n", ts, record.level(), record.args());
        match &self.sink {
            Sink::Stderr => {
                let _ = std::io::stderr().write_all(line.as_bytes());
            }
            Sink::File(f) => {
                if let Ok(mut g) = f.lock() {
                    let _ = g.write_all(line.as_bytes());
                    let _ = g.flush();
                }
            }
            Sink::Discard => {}
        }
    }

    fn flush(&self) {}
}

/// 初始化全局 logger。`http_mode` 决定缺省落点：HTTP 模式下 stderr 丢弃。
/// `WECHAT_MCP_LOG=<文件>` 存在时一律追加写到该文件。
pub fn init(http_mode: bool) {
    let sink = match std::env::var("WECHAT_MCP_LOG")
        .ok()
        .filter(|s| !s.is_empty())
    {
        Some(path) => match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(f) => Sink::File(Mutex::new(f)),
            Err(_) => {
                if http_mode {
                    Sink::Discard
                } else {
                    Sink::Stderr
                }
            }
        },
        None => {
            if http_mode {
                Sink::Discard
            } else {
                Sink::Stderr
            }
        }
    };
    let logger = Box::new(SimpleLogger { sink });
    // 失败（已初始化）忽略即可。
    if log::set_boxed_logger(logger).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}

/// 脱敏：密钥只留前后各 4 个 hex，中间用省略号。空串原样返回。
pub fn mask_key(hex: &str) -> String {
    let n = hex.len();
    if n <= 8 {
        // 太短不足以脱敏，直接用省略号代替，避免泄露。
        return "…".to_string();
    }
    format!("{}…{}", &hex[..4], &hex[n - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_keeps_only_four_each_side() {
        let k = "0123456789abcdef0123456789abcdef";
        assert_eq!(mask_key(k), "0123…cdef");
    }

    #[test]
    fn mask_short_is_elided() {
        assert_eq!(mask_key("abcd"), "…");
    }
}

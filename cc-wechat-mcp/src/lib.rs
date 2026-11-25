//! cc-wechat-mcp 库入口：把整条链路拆成若干聚焦模块，纯逻辑跨平台可测。
//!
//! 为什么拆库 + 二进制：纯算法模块（sqlcipher / db_reader / image / dll_scan 扫描）
//! 需要在 Mac 上跑单元测试，放进 lib 才能被 `cargo test` 直接覆盖；main.rs 只做很薄的入口。

pub mod db_reader;
pub mod dll_scan;
pub mod image;
pub mod key_extractor;
pub mod logx;
pub mod mcp;
pub mod mem;
pub mod paths;
pub mod session;
pub mod sqlcipher;
pub mod tools;
pub mod transport;

/// 非 Windows 平台上定位/取密钥统一返回这句话；工具层照常包成 {"ok":false,"error":...}。
pub const NOT_WINDOWS_MSG: &str = "微信组件只支持 Windows 版微信 4.x";

/// 本 crate 版本号（给 --version 和 initialize 回显用）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

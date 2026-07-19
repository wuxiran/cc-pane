use std::path::Path;

pub const ORCHESTRATOR_MANIFEST_FILE: &str = "mcp-orchestrator.json";

/// orchestrator HTTP/MCP 服务器的固定监听端口。
///
/// **为什么必须固定**：MCP 挂在 Tauri 主进程上，而 CLI 自己的 MCP client 只在**进程启动时**
/// 解析一次端点（`--mcp-config` / `-c mcp_servers.ccpanes.url` 里写死 host:port），端口一漂移
/// 就永久失联——hook 那条路每次调用重解析能自愈，CLI 这条不能。
///
/// **为什么是 4782x**：必须落在 Windows ephemeral 范围（49152-65535）**之外**。那个区间是系统
/// 分配给随机出站连接与其它开发工具的，历史实现回退 `:0` 时拿到的正是该区间的端口
/// （实测 58199 / 65241），重启被抢占概率不低。47821/47822 在 IANA 未分配区间，无主流服务占用。
///
/// **dev/release 隔离与 manifest 对应关系**（沿用 `APP_DIR_NAME` 的 `cfg!(debug_assertions)` 约定）：
///
/// | 构建    | 数据目录          | manifest                              | 端口  |
/// |---------|-------------------|---------------------------------------|-------|
/// | release | `~/.cc-panes/`     | `~/.cc-panes/mcp-orchestrator.json`     | 47821 |
/// | dev     | `~/.cc-panes-dev/` | `~/.cc-panes-dev/mcp-orchestrator.json` | 47822 |
///
/// 即「该读哪个 manifest」由构建类型唯一决定，且与端口一一对应：dev 实例只会读写 dev manifest
/// 并监听 47822，release 只会读写 release manifest 并监听 47821，两者可并行运行互不抢端口。
pub const ORCHESTRATOR_FIXED_PORT: u16 = if cfg!(debug_assertions) { 47822 } else { 47821 };

/// 逃生阀环境变量：固定端口真被别的程序占用时，允许用户显式指定另一个确定端口。
pub const ORCHESTRATOR_PORT_ENV: &str = "CC_PANES_ORCHESTRATOR_PORT";

/// 解析逃生阀端口。
///
/// - `None` / 空串 → 用固定端口
/// - 合法的 1..=65535 → 用该值
/// - `0` 或无法解析 → `Err(提示)`，调用方应报错并退回固定端口
///
/// **不接受 `0`**：`0` 是 OS 随机分配，正是本设计要消除的漂移源头；逃生阀必须是用户显式指定
/// 的确定值，否则 CLI 会话依旧会在重启后失联。
pub fn resolve_orchestrator_port(raw: Option<&str>) -> Result<u16, String> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(ORCHESTRATOR_FIXED_PORT),
        Some("0") => Err(format!(
            "{ORCHESTRATOR_PORT_ENV}=0 无效：0 表示 OS 随机分配端口，会让已运行的 CLI 会话在重启后永久失联；\
             请指定一个确定端口（建议 1024-49151，避开 Windows ephemeral 范围 49152-65535）"
        )),
        Some(value) => value.parse::<u16>().map_err(|_| {
            format!("{ORCHESTRATOR_PORT_ENV}={value} 无法解析为 1-65535 的端口号")
        }),
    }
}

pub fn read_endpoint(data_dir: &Path) -> Option<(u16, String)> {
    let content = std::fs::read_to_string(data_dir.join(ORCHESTRATOR_MANIFEST_FILE)).ok()?;
    parse_endpoint(&content)
}

pub fn parse_endpoint(content: &str) -> Option<(u16, String)> {
    let json: serde_json::Value = serde_json::from_str(content).ok()?;
    let url = json.pointer("/mcpServers/ccpanes/url")?.as_str()?;
    let port = parse_orchestrator_port_from_url(url)?;
    let token = json
        .pointer("/mcpServers/ccpanes/headers/Authorization")
        .and_then(|value| value.as_str())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)?;
    (!token.is_empty()).then_some((port, token))
}

pub fn parse_orchestrator_port_from_url(url: &str) -> Option<u16> {
    let parsed = url::Url::parse(url).ok()?;
    if !parsed.path().starts_with("/mcp") {
        return None;
    }
    parsed.port()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_orchestrator_port_from_url_extracts_port() {
        assert_eq!(
            parse_orchestrator_port_from_url("http://127.0.0.1:61012/mcp?token=abc"),
            Some(61012)
        );
        assert_eq!(
            parse_orchestrator_port_from_url("http://127.0.0.1:8/mcp"),
            Some(8)
        );
        assert_eq!(
            parse_orchestrator_port_from_url("http://127.0.0.1/mcp"),
            None
        );
        assert_eq!(
            parse_orchestrator_port_from_url("http://127.0.0.1:61012/other?token=abc"),
            None
        );
        assert_eq!(parse_orchestrator_port_from_url("not-a-url"), None);
    }

    #[test]
    fn parse_endpoint_reuses_port_and_token() {
        let content = r#"{"mcpServers":{"ccpanes":{"type":"http",
            "url":"http://127.0.0.1:61012/mcp?token=deadbeef",
            "headers":{"Authorization":"Bearer deadbeef"}}}}"#;
        assert_eq!(
            parse_endpoint(content),
            Some((61012, "deadbeef".to_string()))
        );
    }

    /// 原子写：写入中途崩溃只会留下 sibling temp 文件，manifest 本身要么是旧的完整内容，
    /// 要么是新的完整内容，绝不出现截断导致 read_endpoint 返回 None。
    #[test]
    fn atomic_write_never_leaves_truncated_manifest() {
        use crate::utils::atomic_file::write_atomic;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORCHESTRATOR_MANIFEST_FILE);
        let manifest = |port: u16, token: &str| {
            format!(
                r#"{{"mcpServers":{{"ccpanes":{{"type":"http",
                "url":"http://127.0.0.1:{port}/mcp?token={token}",
                "headers":{{"Authorization":"Bearer {token}"}}}}}}}}"#
            )
        };

        write_atomic(&path, manifest(ORCHESTRATOR_FIXED_PORT, "tok1")).unwrap();
        assert_eq!(
            read_endpoint(dir.path()),
            Some((ORCHESTRATOR_FIXED_PORT, "tok1".to_string()))
        );

        // 模拟上一次写入中途崩溃残留的 temp 文件：不影响 manifest 可读性
        std::fs::write(dir.path().join(".tmp-crashed"), "{trunca").unwrap();
        write_atomic(&path, manifest(47900, "tok2")).unwrap();
        assert_eq!(read_endpoint(dir.path()), Some((47900, "tok2".to_string())));
    }

    #[test]
    fn fixed_port_differs_between_dev_and_release() {
        // dev/release 必须错开，否则用户机器上两个实例并行时会互抢端口
        assert_eq!(
            ORCHESTRATOR_FIXED_PORT,
            if cfg!(debug_assertions) { 47822 } else { 47821 }
        );
        // 必须在 Windows ephemeral 范围之外
        assert!(ORCHESTRATOR_FIXED_PORT < 49152);
        assert!(ORCHESTRATOR_FIXED_PORT >= 1024);
    }

    #[test]
    fn resolve_orchestrator_port_defaults_to_fixed() {
        assert_eq!(resolve_orchestrator_port(None), Ok(ORCHESTRATOR_FIXED_PORT));
        assert_eq!(
            resolve_orchestrator_port(Some("  ")),
            Ok(ORCHESTRATOR_FIXED_PORT)
        );
    }

    #[test]
    fn resolve_orchestrator_port_accepts_explicit_value() {
        assert_eq!(resolve_orchestrator_port(Some("47900")), Ok(47900));
        assert_eq!(resolve_orchestrator_port(Some(" 8123 ")), Ok(8123));
    }

    #[test]
    fn resolve_orchestrator_port_rejects_zero_and_garbage() {
        assert!(resolve_orchestrator_port(Some("0")).is_err());
        assert!(resolve_orchestrator_port(Some("abc")).is_err());
        assert!(resolve_orchestrator_port(Some("70000")).is_err());
        assert!(resolve_orchestrator_port(Some("-1")).is_err());
    }

    #[test]
    fn parse_endpoint_rejects_malformed() {
        assert_eq!(parse_endpoint("{}"), None);
        assert_eq!(parse_endpoint("not json"), None);
        let no_auth = r#"{"mcpServers":{"ccpanes":{"url":"http://127.0.0.1:61012/mcp"}}}"#;
        assert_eq!(parse_endpoint(no_auth), None);
        let no_port = r#"{"mcpServers":{"ccpanes":{"url":"http://127.0.0.1/mcp","headers":{"Authorization":"Bearer token"}}}}"#;
        assert_eq!(parse_endpoint(no_port), None);
    }
}

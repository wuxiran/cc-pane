//! 内置组件 · 微信：把随包附带的 `cc-wechat-mcp` 登记成名为 `wechat` 的共享 MCP。
//!
//! 两种接法，落到 shared-mcp.json 里都只是一条 native-http 条目，启动档开关、注入、
//! 健康检查全部复用共享 MCP 的现成机制：
//! - 本机（仅 Windows）：直接跑 `cc-wechat-mcp`，进程自己监听 `127.0.0.1:<port>/mcp`。
//! - 远程：本机没有 Windows 微信时，用 `ssh -N -L` 把另一台 Windows 上已启用的微信组件
//!   端口转发到本机。ssh 不认 MODE/PORT 环境变量，native-http 模式下正好被忽略。
//!
//! 条目的模式从配置本身反推（命令是 cc-wechat-mcp / 是带 -L 的 ssh / 其他），不另存状态，
//! 用户手改 shared-mcp.json 也不会和这里记的东西打架。
use cc_panes_core::models::shared_mcp::{BridgeMode, SharedMcpServerConfig, SharedMcpServerInfo};
use cc_panes_core::services::SharedMcpService;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SERVER_NAME: &str = "wechat";
/// 本机组件优先用的端口。远程那头默认也填它，两边不用对暗号。
pub const DEFAULT_PORT: u16 = 3120;
const BINARY_ENV: &str = "CC_WECHAT_MCP_BIN";
const LOG_ENV: &str = "WECHAT_MCP_LOG";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WechatMode {
    Off,
    Local,
    Remote,
    /// 名为 wechat 的条目不是这里生成的（例如手配的 Python 版）
    Custom,
}

/// 远程接法的参数，也是从 ssh 命令行反解出来的结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WechatRemote {
    /// `user@host`、`host` 或 ~/.ssh/config 里的别名
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// 远端 Windows 上微信组件监听的端口
    pub remote_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatComponentStatus {
    /// 本机能不能直接读微信（只有 Windows 版微信 4.x 支持）
    pub local_supported: bool,
    pub binary_found: bool,
    pub mode: WechatMode,
    pub remote: Option<WechatRemote>,
    pub server: Option<SharedMcpServerInfo>,
}

pub fn status(svc: &SharedMcpService, resource_dir: Option<&Path>) -> WechatComponentStatus {
    let server = svc
        .get_all_status()
        .into_iter()
        .find(|info| info.name == SERVER_NAME);
    let (mode, remote) = match &server {
        None => (WechatMode::Off, None),
        Some(info) => classify(&info.config),
    };
    WechatComponentStatus {
        local_supported: cfg!(windows),
        binary_found: resolve_binary(resource_dir).is_some(),
        mode,
        remote,
        server,
    }
}

fn classify(config: &SharedMcpServerConfig) -> (WechatMode, Option<WechatRemote>) {
    if config.remote.is_some() {
        return (WechatMode::Custom, None);
    }
    // 不用 Path::file_stem：非 Windows 上它不认反斜杠路径
    let file = config
        .command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stem = file.strip_suffix(".exe").unwrap_or(&file);
    match stem {
        "cc-wechat-mcp" => (WechatMode::Local, None),
        "ssh" => match parse_ssh_args(&config.args) {
            Some(remote) => (WechatMode::Remote, Some(remote)),
            None => (WechatMode::Custom, None),
        },
        _ => (WechatMode::Custom, None),
    }
}

/// 本机启用：换掉已有的 wechat 条目（沿用它的端口和 WECHAT_* 环境变量，远端隧道不用跟着改）。
pub fn enable_local(
    svc: &SharedMcpService,
    resource_dir: Option<&Path>,
    log_path: &Path,
) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("WeChat on this computer is only supported on Windows".into());
    }
    let binary = resolve_binary(resource_dir)
        .ok_or("cc-wechat-mcp is missing from this installation; reinstall CC-Panes")?;
    let previous = svc.get_config().servers.get(SERVER_NAME).cloned();
    let mut env: HashMap<String, String> = previous
        .as_ref()
        .map(|old| {
            old.env
                .iter()
                .filter(|(key, _)| key.starts_with("WECHAT_") && key.as_str() != LOG_ENV)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    env.insert(LOG_ENV.into(), log_path.to_string_lossy().into_owned());
    let config = SharedMcpServerConfig {
        command: binary.to_string_lossy().into_owned(),
        args: Vec::new(),
        env,
        shared: true,
        port: choose_port(svc, previous.as_ref()),
        bridge_mode: BridgeMode::NativeHttp,
        remote: None,
    };
    replace_and_start(svc, config)
}

pub fn enable_remote(svc: &SharedMcpService, remote: WechatRemote) -> Result<(), String> {
    let remote = validate_remote(remote)?;
    let previous = svc.get_config().servers.get(SERVER_NAME).cloned();
    let port = choose_port(svc, previous.as_ref());
    let config = SharedMcpServerConfig {
        command: ssh_program(),
        args: build_ssh_args(&remote, port),
        env: HashMap::new(),
        shared: true,
        port,
        bridge_mode: BridgeMode::NativeHttp,
        remote: None,
    };
    replace_and_start(svc, config)
}

pub fn disable(svc: &SharedMcpService) -> Result<(), String> {
    if svc.get_config().servers.contains_key(SERVER_NAME) {
        svc.remove_server(SERVER_NAME)?;
    }
    Ok(())
}

fn replace_and_start(svc: &SharedMcpService, config: SharedMcpServerConfig) -> Result<(), String> {
    svc.stop_server(SERVER_NAME);
    svc.upsert_server(SERVER_NAME, config)?;
    svc.start_server(SERVER_NAME)
}

/// 沿用旧条目的端口；否则优先默认端口，被占了再在共享 MCP 端口范围里找空位。
fn choose_port(svc: &SharedMcpService, previous: Option<&SharedMcpServerConfig>) -> u16 {
    if let Some(old) = previous {
        return old.port;
    }
    let config = svc.get_config();
    let used: std::collections::HashSet<u16> = config
        .servers
        .iter()
        .filter(|(name, _)| name.as_str() != SERVER_NAME)
        .map(|(_, server)| server.port)
        .collect();
    std::iter::once(DEFAULT_PORT)
        .chain(config.port_range_start..=config.port_range_end)
        .find(|port| !used.contains(port) && port_is_free(*port))
        .unwrap_or(DEFAULT_PORT)
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn validate_remote(mut remote: WechatRemote) -> Result<WechatRemote, String> {
    remote.target = remote.target.trim().to_string();
    remote.identity_file = remote
        .identity_file
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    // 以 - 开头会被 ssh 当成选项（如 -oProxyCommand=…），空白会被拆成多个参数
    let unsafe_arg = |value: &str| value.starts_with('-') || value.chars().any(char::is_whitespace);
    if remote.target.is_empty() || unsafe_arg(&remote.target) {
        return Err(
            "Enter an SSH host such as user@192.168.1.10 or an alias from ~/.ssh/config".into(),
        );
    }
    if remote
        .identity_file
        .as_deref()
        .is_some_and(|path| path.starts_with('-'))
    {
        return Err("Invalid identity file path".into());
    }
    if remote.remote_port == 0 || remote.ssh_port == Some(0) {
        return Err("Port must be between 1 and 65535".into());
    }
    Ok(remote)
}

fn ssh_program() -> String {
    if cfg!(windows) {
        "ssh".into()
    } else if Path::new("/usr/bin/ssh").is_file() {
        "/usr/bin/ssh".into()
    } else {
        "ssh".into()
    }
}

/// BatchMode：隧道在后台跑，没有终端可输密码，只能用密钥；ExitOnForwardFailure 让端口被占时
/// 直接退出，交给共享 MCP 的健康检查报错，而不是挂着一个没转发的连接。
fn build_ssh_args(remote: &WechatRemote, local_port: u16) -> Vec<String> {
    let mut args: Vec<String> = [
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=10",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(port) = remote.ssh_port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(identity) = &remote.identity_file {
        args.extend(["-i".into(), identity.clone()]);
    }
    args.extend([
        "-L".into(),
        format!("127.0.0.1:{local_port}:127.0.0.1:{}", remote.remote_port),
        remote.target.clone(),
    ]);
    args
}

fn parse_ssh_args(args: &[String]) -> Option<WechatRemote> {
    let mut ssh_port = None;
    let mut identity_file = None;
    let mut remote_port = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-p" => ssh_port = iter.next()?.parse().ok(),
            "-i" => identity_file = iter.next().cloned(),
            "-L" => remote_port = iter.next()?.rsplit(':').next()?.parse().ok(),
            "-o" => {
                iter.next();
            }
            _ => {}
        }
    }
    let target = args.last().filter(|last| !last.starts_with('-'))?.clone();
    Some(WechatRemote {
        target,
        ssh_port,
        identity_file,
        remote_port: remote_port?,
    })
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "cc-wechat-mcp.exe"
    } else {
        "cc-wechat-mcp"
    }
}

/// 安装包里在 resources/binaries；开发时和主程序同在 cargo 的 target/<profile> 下。
pub fn resolve_binary(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os(BINARY_ENV).map(PathBuf::from) {
        if explicit.is_absolute() && explicit.is_file() {
            return Some(explicit);
        }
    }
    let name = binary_name();
    let mut candidates = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("binaries").join(name));
    }
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        candidates.push(exe_dir.join("binaries").join(name));
        candidates.push(exe_dir.join(name));
        #[cfg(target_os = "macos")]
        if let Some(contents) = exe_dir.parent() {
            candidates.push(contents.join("Resources").join("binaries").join(name));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| dunce::canonicalize(&path).unwrap_or(path))
}

/// 连通检测：真的走一遍 MCP（initialize → wechat_status），本机和远程用同一条路，
/// 能顺带发现隧道通了但远端组件没起、或远端还是旧 Python 版之类的问题。
pub async fn check(svc: &SharedMcpService) -> Result<serde_json::Value, String> {
    let port = svc
        .get_config()
        .servers
        .get(SERVER_NAME)
        .map(|server| server.port)
        .ok_or("WeChat component is not enabled")?;
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        // 首次调用 wechat_status 只定位进程和库，不解密；留足远端冷启动的余量
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let init = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "cc-panes", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    let (session, _) = post_rpc(&client, &url, None, &init).await?;
    let initialized =
        serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let _ = post_rpc(&client, &url, session.as_deref(), &initialized).await;
    let call = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "wechat_status", "arguments": {} }
    });
    let (_, body) = post_rpc(&client, &url, session.as_deref(), &call).await?;
    tool_result_json(&body)
}

async fn post_rpc(
    client: &reqwest::Client,
    url: &str,
    session: Option<&str>,
    payload: &serde_json::Value,
) -> Result<(Option<String>, String), String> {
    let mut request = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(payload);
    if let Some(session) = session {
        request = request.header("Mcp-Session-Id", session);
    }
    let response = request.send().await.map_err(|e| {
        if e.is_connect() {
            "Cannot reach the WeChat component (not running, or the SSH tunnel is down)".to_string()
        } else {
            e.to_string()
        }
    })?;
    let status = response.status();
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("WeChat component returned HTTP {status}"));
    }
    Ok((session, body))
}

/// 响应可能是纯 JSON，也可能是 SSE（mcp-proxy / FastMCP），取最后一个带 result 或 error 的消息。
fn tool_result_json(body: &str) -> Result<serde_json::Value, String> {
    let message = std::iter::once(body.trim())
        .chain(
            body.lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim)),
        )
        .filter_map(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .rfind(|value| value.get("result").is_some() || value.get("error").is_some())
        .ok_or("Unexpected response from the WeChat component")?;
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(text.to_string());
    }
    let text = message
        .pointer("/result/content/0/text")
        .and_then(|t| t.as_str())
        .ok_or("Unexpected response from the WeChat component")?;
    serde_json::from_str(text).map_err(|_| "Unexpected response from the WeChat component".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote() -> WechatRemote {
        WechatRemote {
            target: "me@10.0.0.5".into(),
            ssh_port: Some(2222),
            identity_file: Some("/keys/id_ed25519".into()),
            remote_port: 3120,
        }
    }

    #[test]
    fn ssh_args_round_trip() {
        let args = build_ssh_args(&remote(), 3121);
        assert!(args.contains(&"127.0.0.1:3121:127.0.0.1:3120".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("me@10.0.0.5"));
        assert_eq!(parse_ssh_args(&args), Some(remote()));
    }

    #[test]
    fn parses_hand_written_tunnel() {
        // 用户机器上现有的手配隧道：别名 + 默认 ssh 端口
        let args: Vec<String> = "-N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:3102:127.0.0.1:3100 win-box"
            .split(' ')
            .map(str::to_string)
            .collect();
        let parsed = parse_ssh_args(&args).unwrap();
        assert_eq!(parsed.target, "win-box");
        assert_eq!(parsed.remote_port, 3100);
        assert_eq!(parsed.ssh_port, None);
    }

    #[test]
    fn classify_modes() {
        let mut config = SharedMcpServerConfig {
            command: "C:\\Program Files\\CC-Panes\\binaries\\cc-wechat-mcp.exe".into(),
            args: vec![],
            env: HashMap::new(),
            shared: true,
            port: 3120,
            bridge_mode: BridgeMode::NativeHttp,
            remote: None,
        };
        assert_eq!(classify(&config).0, WechatMode::Local);
        config.command = "/usr/bin/ssh".into();
        config.args = build_ssh_args(&remote(), 3120);
        assert_eq!(classify(&config), (WechatMode::Remote, Some(remote())));
        config.command = "node".into();
        assert_eq!(classify(&config).0, WechatMode::Custom);
    }

    #[test]
    fn rejects_option_injection() {
        let mut bad = remote();
        bad.target = "-oProxyCommand=calc".into();
        assert!(validate_remote(bad).is_err());
        let mut spaced = remote();
        spaced.target = "a b".into();
        assert!(validate_remote(spaced).is_err());
        let mut key = remote();
        key.identity_file = Some("-oFoo".into());
        assert!(validate_remote(key).is_err());
        let mut trimmed = remote();
        trimmed.target = "  host  ".into();
        trimmed.identity_file = Some("  ".into());
        let ok = validate_remote(trimmed).unwrap();
        assert_eq!(ok.target, "host");
        assert_eq!(ok.identity_file, None);
    }

    #[test]
    fn reads_json_and_sse_tool_results() {
        let json = r#"{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"ok\":true,\"pid\":7}"}]}}"#;
        assert_eq!(tool_result_json(json).unwrap()["pid"], 7);
        let sse = format!("event: message\ndata: {json}\n\n");
        assert_eq!(tool_result_json(&sse).unwrap()["ok"], true);
        let err = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"no such tool"}}"#;
        assert_eq!(tool_result_json(err).unwrap_err(), "no such tool");
    }
}

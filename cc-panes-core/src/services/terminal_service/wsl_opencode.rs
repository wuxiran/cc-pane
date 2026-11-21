//! OpenCode 在 WSL 里的注入（docs/110 批 4）。
//!
//! 以前 WSL 分支只在有托管 Provider 时写一份「只有 Provider」的配置，MCP 与会话提示词全丢。
//! 现在按本机同一个 adapter 生成每会话 `OPENCODE_CONFIG`（ccpanes + 共享 + 工作空间层 HTTP MCP、
//! `instructions`、Provider），宿主写文件后把其中的宿主路径换成 `/mnt/...`、把回环 MCP 地址换成
//! guest 能连到的 Windows 主机地址。
//!
//! 仍做不到的（描述里标 Partial）：
//! - 工作空间层的 stdio 条目是宿主命令，进不了 guest（上游已过滤，只剩 HTTP）；远程 MCP 的
//!   请求头与 SSE 在 WSL 统一不带（`remote_mcp_supported` 的运行时规则）。
//! - 隔离：要禁用的名字来自 guest 里 OpenCode 自己的配置，宿主侧读不到，这里不做。
//! - 技能挂载：不传 `skills.paths`，内置可移植技能与工作空间技能走提示词回退（`instructions`），
//!   避免挂载与提示词同时出现同一个技能。
//!
//! 本模块是纯数据变换（不碰 wsl.exe），在所有平台编译并测试；调用点在 Windows-only 的
//! `build_wsl_supported_cli_command` 里。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde_json::Value;

/// 生成 WSL OpenCode 会话 context 需要的输入（都来自 WSL 启动链已经算好的值）。
pub(super) struct WslOpencodeInputs<'a> {
    pub session_id: &'a str,
    pub project_path: &'a str,
    pub workspace_path: Option<&'a str>,
    pub provider: Option<&'a cc_cli_adapters::CliProvider>,
    pub adapter_options: &'a HashMap<String, Value>,
    pub resume_id: Option<&'a str>,
    pub append_system_prompt: Option<&'a str>,
    pub initial_prompt: Option<&'a str>,
    pub yolo_mode: bool,
    /// 关掉 ccpanes 自身（WSL 启动链目前把它与「全关」合并成一个开关）。
    pub skip_ccpanes_mcp: bool,
    /// WSL 进程环境（取 orchestrator 端口 / token / launchId）。
    pub env_vars: &'a HashMap<String, String>,
    /// guest 能连到的 Windows 主机；None 时回环地址的条目都不注入（guest 连不上）。
    pub windows_host: Option<&'a str>,
    pub shared_mcp_urls: &'a HashMap<String, String>,
    /// 工作空间 / 项目层的 HTTP 型条目（name → url，已按启动档过滤）。
    pub workspace_http_servers: &'a [(String, String)],
    pub data_dir: PathBuf,
}

fn is_loopback_url(url: &str) -> bool {
    ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"]
        .iter()
        .any(|prefix| url.starts_with(prefix))
}

/// 回环 MCP 地址 → guest 能连到的 Windows 主机地址（与 wsl_codex 的 Claude / Codex 分支同口径）。
pub(super) fn rewrite_loopback_url(url: &str, windows_host: &str) -> String {
    for prefix in ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            return format!("http://{windows_host}:{rest}");
        }
    }
    url.to_string()
}

pub(super) fn wsl_opencode_context(
    inputs: WslOpencodeInputs<'_>,
) -> cc_cli_adapters::CliAdapterContext {
    let reachable = |url: &String| inputs.windows_host.is_some() || !is_loopback_url(url);
    let orchestrator = inputs.windows_host.and_then(|_| {
        let port = inputs
            .env_vars
            .get("CC_PANES_API_PORT")?
            .parse::<u16>()
            .ok()?;
        let token = inputs.env_vars.get("CC_PANES_API_TOKEN")?.clone();
        Some((port, token))
    });
    let workspace_mcp_servers: BTreeMap<String, Value> = inputs
        .workspace_http_servers
        .iter()
        .filter(|(_, url)| reachable(url))
        .map(|(name, url)| {
            (
                name.clone(),
                serde_json::json!({ "type": "http", "url": url }),
            )
        })
        .collect();
    cc_cli_adapters::CliAdapterContext {
        session_id: inputs.session_id.to_string(),
        project_path: inputs.project_path.to_string(),
        workspace_path: inputs.workspace_path.map(str::to_string),
        provider: inputs.provider.cloned(),
        executable_override: Some("__ccpanes_wsl_opencode__".to_string()),
        adapter_options: inputs.adapter_options.clone(),
        resume_id: inputs.resume_id.map(str::to_string),
        issued_session_id: None,
        skip_mcp: false,
        skip_ccpanes_mcp: inputs.skip_ccpanes_mcp,
        yolo_mode: inputs.yolo_mode,
        append_system_prompt: inputs.append_system_prompt.map(str::to_string),
        initial_prompt: inputs.initial_prompt.map(str::to_string),
        orchestrator_port: orchestrator.as_ref().map(|(port, _)| *port),
        orchestrator_token: orchestrator.map(|(_, token)| token),
        launch_id: inputs.env_vars.get("CC_PANES_LAUNCH_ID").cloned(),
        data_dir: inputs.data_dir,
        shared_mcp_urls: inputs
            .shared_mcp_urls
            .iter()
            .filter(|(_, url)| reachable(url))
            .map(|(name, url)| (name.clone(), url.clone()))
            .collect(),
        shared_mcp_stdio: Default::default(),
        shared_mcp_remote: Default::default(),
        allowed_mcp_server_ids: Vec::new(),
        // guest 里的 OpenCode 配置宿主侧读不到，无从知道该禁用哪些名字
        disable_unlisted_mcp_servers: false,
        // 技能走提示词回退（见模块头）
        skill_mount_paths: Vec::new(),
        workspace_mcp_servers,
    }
}

/// 宿主写出的配置改成 guest 可用：`instructions[]` 的宿主路径过 `to_wsl`，`mcp.*.url` 的回环地址
/// 换成 `windows_host`。任何路径转换失败都报错（guest 读不到文件时宁可不启动也不要静默丢提示词）。
pub(super) fn rewrite_opencode_config_for_wsl(
    config: &mut Value,
    to_wsl: &dyn Fn(&str) -> Option<String>,
    windows_host: Option<&str>,
) -> Result<()> {
    if let Some(Value::Array(paths)) = config.get_mut("instructions") {
        for path in paths.iter_mut() {
            let Some(host) = path.as_str() else {
                continue;
            };
            let translated = to_wsl(host).ok_or_else(|| {
                anyhow!("Failed to translate OpenCode instructions path to WSL: {host}")
            })?;
            *path = Value::String(translated);
        }
    }
    if let (Some(host), Some(Value::Object(servers))) = (windows_host, config.get_mut("mcp")) {
        for entry in servers.values_mut() {
            if let Some(Value::String(url)) = entry.get_mut("url") {
                *url = rewrite_loopback_url(url, host);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs<'a>(
        env: &'a HashMap<String, String>,
        shared: &'a HashMap<String, String>,
        workspace: &'a [(String, String)],
        windows_host: Option<&'a str>,
        options: &'a HashMap<String, Value>,
    ) -> WslOpencodeInputs<'a> {
        WslOpencodeInputs {
            session_id: "wsl-oc",
            project_path: "/home/u/proj",
            workspace_path: None,
            provider: None,
            adapter_options: options,
            resume_id: None,
            append_system_prompt: Some("prompt-marker"),
            initial_prompt: None,
            yolo_mode: false,
            skip_ccpanes_mcp: false,
            env_vars: env,
            windows_host,
            shared_mcp_urls: shared,
            workspace_http_servers: workspace,
            data_dir: std::env::temp_dir(),
        }
    }

    #[test]
    fn context_carries_mcp_prompt_and_drops_unreachable_loopback_entries() {
        let env = HashMap::from([
            ("CC_PANES_API_PORT".to_string(), "41900".to_string()),
            ("CC_PANES_API_TOKEN".to_string(), "tok".to_string()),
            ("CC_PANES_LAUNCH_ID".to_string(), "launch-1".to_string()),
        ]);
        let shared = HashMap::from([
            (
                "bridge".to_string(),
                "http://127.0.0.1:5000/mcp".to_string(),
            ),
            (
                "remote".to_string(),
                "https://remote.example/mcp".to_string(),
            ),
        ]);
        let workspace = vec![("ws".to_string(), "http://localhost:6000/mcp".to_string())];
        let options = HashMap::new();

        let ctx = wsl_opencode_context(inputs(
            &env,
            &shared,
            &workspace,
            Some("172.20.0.1"),
            &options,
        ));
        assert_eq!(ctx.orchestrator_port, Some(41900));
        assert_eq!(ctx.launch_id.as_deref(), Some("launch-1"));
        assert_eq!(ctx.shared_mcp_urls.len(), 2);
        assert!(ctx.workspace_mcp_servers.contains_key("ws"));
        assert_eq!(ctx.append_system_prompt.as_deref(), Some("prompt-marker"));
        assert!(ctx.skill_mount_paths.is_empty());
        assert!(!ctx.disable_unlisted_mcp_servers);

        // 没有可达的 Windows 主机：回环条目与 ccpanes 都不注入，远程照常
        let ctx = wsl_opencode_context(inputs(&env, &shared, &workspace, None, &options));
        assert_eq!(ctx.orchestrator_port, None);
        assert_eq!(
            ctx.shared_mcp_urls.keys().collect::<Vec<_>>(),
            vec!["remote"]
        );
        assert!(ctx.workspace_mcp_servers.is_empty());
    }

    #[test]
    fn adapter_output_is_rewritten_for_the_guest() {
        let data = tempfile::tempdir().unwrap();
        let env = HashMap::from([
            ("CC_PANES_API_PORT".to_string(), "41900".to_string()),
            ("CC_PANES_API_TOKEN".to_string(), "tok".to_string()),
        ]);
        let shared = HashMap::from([(
            "bridge".to_string(),
            "http://127.0.0.1:5000/mcp".to_string(),
        )]);
        let options = HashMap::new();
        let mut inputs = inputs(&env, &shared, &[], Some("172.20.0.1"), &options);
        inputs.data_dir = data.path().to_path_buf();
        let ctx = wsl_opencode_context(inputs);

        let path = cc_cli_adapters::OpenCodeAdapter::new()
            .write_wsl_session_config(&ctx)
            .unwrap()
            .expect("config written");
        let mut config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let host_root = data.path().to_string_lossy().into_owned();
        let to_wsl = |host: &str| {
            host.strip_prefix(&host_root)
                .map(|rest| format!("/mnt/c/data{rest}"))
        };
        rewrite_opencode_config_for_wsl(&mut config, &to_wsl, Some("172.20.0.1")).unwrap();

        assert!(config["instructions"][0]
            .as_str()
            .unwrap()
            .starts_with("/mnt/c/data/"));
        assert_eq!(config["mcp"]["bridge"]["url"], "http://172.20.0.1:5000/mcp");
        assert!(config["mcp"]["ccpanes"]["url"]
            .as_str()
            .unwrap()
            .starts_with("http://172.20.0.1:41900/mcp"));
        assert!(
            config.get("skills").is_none(),
            "skills go through the prompt in WSL"
        );

        let fail = |_: &str| None;
        assert!(rewrite_opencode_config_for_wsl(&mut config, &fail, None).is_err());
    }
}

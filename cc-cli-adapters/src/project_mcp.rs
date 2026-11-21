//! 通用的项目级 MCP 注入（docs/110 批 2）。
//!
//! 没有按次启动 MCP 参数的 CLI，唯一的注入面是它原生读取的项目级配置文件。本模块把
//! 「本次启动的有效 MCP 集合」按各 CLI 的方言渲染进那份文件，并沿用
//! [`crate::mcp_file_injection`] 的收据契约（只动自己写过的条目、语义不变零写入、损坏即停）。
//! 新增的三件事：
//!
//! - **方言**（[`McpDialect`]）：文件路径、JSON / TOML、顶层键、远程 URL 键名
//!   （`url` / `serverUrl` / `httpUrl`）、SSE 怎么表达、请求头、环境变量引用语法。
//! - **不落秘密**：CLI 能在配置里展开环境变量时，ccpanes 的端口 / token / launchId 与远程
//!   MCP 的请求头都写成占位符，真实值经本次进程的环境变量注入（每个会话展开成自己的值，
//!   同项目并发会话共用一份文件也不会串身份）。不能展开的 CLI 用 cc-panes-ctl stdio 代理：
//!   代理从继承的 `CC_PANES_DATA_DIR` / `CC_PANES_LAUNCH_ID` 找实例与身份，文件里没有秘密。
//! - **回收与排除**：写入后把文件加进 `.git/info/exclude`（仓库存在时），已被 git 跟踪的
//!   文件不写（不弄脏用户的仓库）；每个会话记一份租约，会话结束时最后一个租约负责按收据
//!   清掉我们的条目（[`release_session`]）。

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::mcp_file_injection::{is_valid_server_name, CCPANES_SERVER_NAME};
use crate::project_mcp_files::{self, ProjectTarget};
use crate::CliAdapterContext;

/// 远程 MCP 条目的字段形态。
#[derive(Debug, Clone, Copy)]
pub struct RemoteShape {
    /// URL 的键名：`url` / `serverUrl` / `httpUrl`。
    pub url_key: &'static str,
    /// 额外的类型字段（`("type","http")`、`("transport","sse")`），None = 只靠 URL 键判定。
    pub kind: Option<(&'static str, &'static str)>,
}

/// 一个 CLI 的项目级 MCP 方言。
#[derive(Clone, Copy)]
pub struct McpDialect {
    pub target: ProjectTarget,
    /// stdio 条目额外的类型字段（Cursor 要求 `"type":"stdio"`）。
    pub stdio_kind: Option<(&'static str, &'static str)>,
    /// Streamable HTTP；None = 不支持。
    pub http: Option<RemoteShape>,
    /// 旧 SSE；None = 不支持。
    pub sse: Option<RemoteShape>,
    /// 远程条目能否带请求头。
    pub headers: bool,
    /// 配置里环境变量引用的写法（`${env:X}`、`${X}`）；None = 不展开。
    pub env_ref: Option<fn(&str) -> String>,
    /// 每个条目追加的固定字段（Grok 的 `enabled = true`）。
    pub enabled_field: Option<&'static str>,
    /// 远程条目「从环境变量取 bearer token」的键（Kimi 的 `bearerTokenEnvVar`）：
    /// 不能展开环境变量时，ccpanes 的 token 靠它不落盘。
    pub bearer_env_key: Option<&'static str>,
    /// stdio 子进程的环境被 CLI 清洗时（Gemini 会删敏感变量），在 `env` 块里显式转发
    /// ctl 代理需要的变量，值为该 CLI 的引用写法（`$VAR`）。
    pub proxy_env_ref: Option<fn(&str) -> String>,
    /// 共享 MCP 优先用原始 stdio 定义（绕过 HTTP 桥，兼容只认 stdio 的旧版 jcode）。
    pub shared_stdio_source: bool,
}

pub fn env_ref_dollar_brace(name: &str) -> String {
    format!("${{{name}}}")
}

pub fn env_ref_cursor(name: &str) -> String {
    format!("${{env:{name}}}")
}

pub fn env_ref_dollar(name: &str) -> String {
    format!("${name}")
}

/// ctl 代理在 Auto 模式下读取的变量（cc-panes-ctl cli.rs / discovery.rs）。
const PROXY_ENV_KEYS: [&str; 2] = ["CC_PANES_DATA_DIR", "CC_PANES_LAUNCH_ID"];

/// 与方言无关的 server 描述（从 Claude 形状的层条目 / 共享表 / ccpanes 汇总而来）。
#[derive(Debug, Clone, PartialEq)]
pub enum ServerSpec {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Remote {
        sse: bool,
        url: String,
        headers: BTreeMap<String, String>,
    },
}

impl ServerSpec {
    /// Claude 形状 `{command,args,env}` / `{type,url,headers}` → 中立描述。
    pub fn from_claude_entry(value: &Value) -> Option<Self> {
        let strings = |key: &str| -> BTreeMap<String, String> {
            value
                .get(key)
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                        .collect()
                })
                .unwrap_or_default()
        };
        if let Some(command) = value.get("command").and_then(Value::as_str) {
            let args = value
                .get("args")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            return Some(Self::Stdio {
                command: command.to_string(),
                args,
                env: strings("env"),
            });
        }
        let url = value.get("url").and_then(Value::as_str)?;
        let sse = value.get("type").and_then(Value::as_str) == Some("sse");
        Some(Self::Remote {
            sse,
            url: url.to_string(),
            headers: strings("headers"),
        })
    }
}

/// ccpanes 内置 MCP 的注入方式（由 adapter 决定）。
#[derive(Debug, Clone, PartialEq)]
pub enum CcpanesEntry {
    /// 本次不注入。
    None,
    /// 经 ctl stdio 代理（文件里只有命令，身份与实例来自继承的环境变量）。
    Proxy { command: String },
    /// HTTP 直连（端口 / token / launchId 按方言写成占位符或字面值）。
    Http,
}

/// 不能展开环境变量的 CLI：优先 ctl stdio 代理（身份与实例来自继承的环境变量），
/// 代理不可用时退回 HTTP 直连。
pub fn ccpanes_proxy_or_http(ctx: &CliAdapterContext) -> CcpanesEntry {
    if !ctx.wants_ccpanes_mcp() {
        return CcpanesEntry::None;
    }
    if let Some(proxy) = crate::mcp_proxy_invocation(ctx) {
        return CcpanesEntry::Proxy {
            command: proxy.command,
        };
    }
    if ctx.orchestrator_port.is_some() && ctx.orchestrator_token.is_some() {
        CcpanesEntry::Http
    } else {
        CcpanesEntry::None
    }
}

/// 能展开环境变量的 CLI：HTTP 直连，端口 / token / launchId 都是占位符。
pub fn ccpanes_http(ctx: &CliAdapterContext) -> CcpanesEntry {
    let ready = ctx.orchestrator_port.is_some() && ctx.orchestrator_token.is_some();
    if ctx.wants_ccpanes_mcp() && ready {
        CcpanesEntry::Http
    } else {
        CcpanesEntry::None
    }
}

/// 渲染结果：写进文件的条目 + 本次进程要注入的环境变量。
#[derive(Debug, Default)]
pub struct RenderedMcp {
    pub servers: BTreeMap<String, Value>,
    pub env: HashMap<String, String>,
    /// 因传输方式不被该 CLI 支持而跳过的名字（warn 用）。
    pub skipped: Vec<String>,
}

/// 汇总本次启动的有效集合（层 < 共享 < ccpanes，与 claude.rs 的合并顺序一致）并按方言渲染。
pub fn render_for_launch(
    ctx: &CliAdapterContext,
    dialect: &McpDialect,
    ccpanes: &CcpanesEntry,
) -> RenderedMcp {
    let mut rendered = RenderedMcp::default();
    if ctx.skip_mcp {
        return rendered;
    }
    let mut specs: BTreeMap<String, ServerSpec> = BTreeMap::new();
    for (name, value) in ctx.allowed_workspace_mcp_servers() {
        if let Some(spec) = ServerSpec::from_claude_entry(value) {
            specs.insert(name.clone(), spec);
        }
    }
    for (name, url) in &ctx.shared_mcp_urls {
        let stdio_source = dialect
            .shared_stdio_source
            .then(|| ctx.shared_mcp_stdio.get(name))
            .flatten()
            .and_then(ServerSpec::from_claude_entry);
        if let Some(spec) = stdio_source {
            specs.insert(name.clone(), spec);
            continue;
        }
        let spec = match ctx.shared_mcp_remote.get(name) {
            Some(remote) => ServerSpec::Remote {
                sse: remote.transport == "sse",
                url: url.clone(),
                headers: remote.headers.clone(),
            },
            None => ServerSpec::Remote {
                sse: false,
                url: url.clone(),
                headers: BTreeMap::new(),
            },
        };
        specs.insert(name.clone(), spec);
    }
    specs.remove(CCPANES_SERVER_NAME);
    for (name, spec) in specs {
        if !is_valid_server_name(&name) {
            rendered.skipped.push(name);
            continue;
        }
        match render_entry(&name, &spec, dialect, &mut rendered.env) {
            Some(value) => {
                rendered.servers.insert(name, value);
            }
            None => rendered.skipped.push(name),
        }
    }
    if let Some(entry) = render_ccpanes(ctx, dialect, ccpanes, &mut rendered.env) {
        rendered
            .servers
            .insert(CCPANES_SERVER_NAME.to_string(), entry);
    }
    rendered
}

fn render_entry(
    name: &str,
    spec: &ServerSpec,
    dialect: &McpDialect,
    env: &mut HashMap<String, String>,
) -> Option<Value> {
    let mut entry = serde_json::Map::new();
    match spec {
        ServerSpec::Stdio {
            command,
            args,
            env: vars,
        } => {
            if let Some((key, kind)) = dialect.stdio_kind {
                entry.insert(key.to_string(), json!(kind));
            }
            entry.insert("command".to_string(), json!(command));
            entry.insert("args".to_string(), json!(args));
            if !vars.is_empty() {
                entry.insert("env".to_string(), json!(vars));
            }
        }
        ServerSpec::Remote { sse, url, headers } => {
            let shape = if *sse { dialect.sse? } else { dialect.http? };
            if !headers.is_empty() && !dialect.headers {
                return None;
            }
            if let Some((key, kind)) = shape.kind {
                entry.insert(key.to_string(), json!(kind));
            }
            entry.insert(shape.url_key.to_string(), json!(url));
            if !headers.is_empty() {
                let values: BTreeMap<String, String> = headers
                    .iter()
                    .map(|(header, value)| {
                        (
                            header.clone(),
                            secret_value(name, header, value, dialect, env),
                        )
                    })
                    .collect();
                entry.insert("headers".to_string(), json!(values));
            }
        }
    }
    if let Some(field) = dialect.enabled_field {
        entry.insert(field.to_string(), json!(true));
    }
    Some(Value::Object(entry))
}

/// 能展开环境变量的方言：请求头写成占位符，真实值经进程环境注入（名字由 server+header
/// 决定，文件内容对所有会话一致）。否则只能写字面值（文件已排除出 git）。
fn secret_value(
    server: &str,
    header: &str,
    value: &str,
    dialect: &McpDialect,
    env: &mut HashMap<String, String>,
) -> String {
    let Some(env_ref) = dialect.env_ref else {
        return value.to_string();
    };
    let key = format!(
        "CC_PANES_MCP_HEADER_{}_{}",
        env_token(server),
        env_token(header)
    );
    env.insert(key.clone(), value.to_string());
    env_ref(&key)
}

fn env_token(raw: &str) -> String {
    raw.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn render_ccpanes(
    ctx: &CliAdapterContext,
    dialect: &McpDialect,
    ccpanes: &CcpanesEntry,
    env: &mut HashMap<String, String>,
) -> Option<Value> {
    if !ctx.wants_ccpanes_mcp() {
        return None;
    }
    let launch_id = ctx
        .launch_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    match ccpanes {
        CcpanesEntry::None => None,
        CcpanesEntry::Proxy { command } => {
            // 代理在 Auto 模式下读 CC_PANES_DATA_DIR / CC_PANES_LAUNCH_ID（cc-panes-ctl
            // cli.rs / discovery.rs）。终端服务本来就注入这两个变量，这里再显式带上一份，
            // 让 adapter 的输出自洽（也是诚实守卫的证据）。
            env.insert(
                "CC_PANES_DATA_DIR".to_string(),
                ctx.data_dir.to_string_lossy().into_owned(),
            );
            if let Some(id) = launch_id {
                env.insert("CC_PANES_LAUNCH_ID".to_string(), id.to_string());
            }
            let forwarded = dialect
                .proxy_env_ref
                .map(|env_ref| {
                    PROXY_ENV_KEYS
                        .iter()
                        .map(|key| (key.to_string(), env_ref(key)))
                        .collect()
                })
                .unwrap_or_default();
            let spec = ServerSpec::Stdio {
                command: command.clone(),
                args: vec!["mcp-proxy".to_string()],
                env: forwarded,
            };
            render_entry(CCPANES_SERVER_NAME, &spec, dialect, env)
        }
        CcpanesEntry::Http => {
            let (port, token) = (ctx.orchestrator_port?, ctx.orchestrator_token.as_deref()?);
            let spec = match dialect.env_ref {
                Some(env_ref) => {
                    env.insert("CC_PANES_API_PORT".to_string(), port.to_string());
                    env.insert("CC_PANES_API_TOKEN".to_string(), token.to_string());
                    let mut url = format!("http://127.0.0.1:{}/mcp", env_ref("CC_PANES_API_PORT"));
                    if let Some(id) = launch_id {
                        env.insert("CC_PANES_LAUNCH_ID".to_string(), id.to_string());
                        url.push_str(&format!("?launchId={}", env_ref("CC_PANES_LAUNCH_ID")));
                    }
                    let auth = format!("Bearer {}", env_ref("CC_PANES_API_TOKEN"));
                    ServerSpec::Remote {
                        sse: false,
                        url,
                        headers: BTreeMap::from([("Authorization".to_string(), auth)]),
                    }
                }
                // 不能展开但能从环境变量取 bearer（Kimi）：token 不落盘，不带 launchId。
                None if dialect.bearer_env_key.is_some() => {
                    env.insert("CC_PANES_API_TOKEN".to_string(), token.to_string());
                    let shape = dialect.http?;
                    let mut entry = serde_json::Map::new();
                    if let Some((key, kind)) = shape.kind {
                        entry.insert(key.to_string(), json!(kind));
                    }
                    entry.insert(
                        shape.url_key.to_string(),
                        json!(format!("http://127.0.0.1:{port}/mcp")),
                    );
                    entry.insert(
                        dialect.bearer_env_key?.to_string(),
                        json!("CC_PANES_API_TOKEN"),
                    );
                    return Some(Value::Object(entry));
                }
                // 不能展开：字面 token（文件已排除出 git）、不带 launchId（共享文件里的 id
                // 会被并发会话覆盖）。
                None => ServerSpec::Remote {
                    sse: false,
                    url: format!("http://127.0.0.1:{port}/mcp?token={token}"),
                    headers: BTreeMap::from([(
                        "Authorization".to_string(),
                        format!("Bearer {token}"),
                    )]),
                },
            };
            // ccpanes 自己的请求头不再二次占位
            let plain = McpDialect {
                env_ref: None,
                ..*dialect
            };
            render_entry(CCPANES_SERVER_NAME, &spec, &plain, env)
        }
    }
}

/// [`sync_for_launch`] 的结果。
#[derive(Debug, Default)]
pub struct LaunchMcp {
    /// 本次进程要注入的环境变量（占位符的真实值、代理需要的实例 / 身份）。
    pub env: HashMap<String, String>,
    /// 项目文件里有本次启动的条目（CLI 需要信任工作区等前置时据此判断）。
    pub active: bool,
}

/// adapter 入口：渲染 → 同步进项目文件 → 记租约。任何失败只 warn 不阻断启动。
pub fn sync_for_launch(
    ctx: &CliAdapterContext,
    dialect: &McpDialect,
    ccpanes: &CcpanesEntry,
) -> LaunchMcp {
    let project = Path::new(ctx.project_path.trim());
    if project.as_os_str().is_empty() {
        return LaunchMcp::default();
    }
    let rendered = render_for_launch(ctx, dialect, ccpanes);
    let cli_id = dialect.target.cli_id;
    if !rendered.skipped.is_empty() {
        warn!(cli_id, servers = ?rendered.skipped, "project MCP: servers this CLI cannot consume were skipped");
    }
    if ctx.disable_unlisted_mcp_servers {
        warn!(cli_id, "MCP isolation requested but this CLI has no per-launch disable channel; user-configured servers stay loaded");
    }
    match project_mcp_files::sync(&dialect.target, project, &rendered.servers) {
        Ok(outcome) if outcome.skipped_tracked => LaunchMcp::default(),
        Ok(outcome) => {
            if outcome.written {
                info!(
                    cli_id,
                    injected = outcome.injected,
                    removed = outcome.removed,
                    "project MCP config synced"
                );
            }
            let active = !rendered.servers.is_empty();
            if active {
                project_mcp_files::write_lease(&ctx.data_dir, &ctx.session_id, cli_id, project);
            }
            LaunchMcp {
                env: rendered.env,
                active,
            }
        }
        Err(error) => {
            warn!(cli_id, %error, "project MCP: failed to sync (continuing without injection)");
            LaunchMcp::default()
        }
    }
}

/// 会话真正结束时调用（终端服务的会话清理）：删掉本会话租约；同一 (CLI, 项目) 没有别的
/// 有效租约时，按收据清掉我们写进项目文件的条目。
pub fn release_session(data_dir: &Path, session_id: &str) {
    let Some((cli_id, project)) = project_mcp_files::take_lease(data_dir, session_id) else {
        return;
    };
    if project_mcp_files::has_other_lease(data_dir, &cli_id, &project) {
        return;
    }
    let Some(dialect) = crate::project_mcp_dialects::dialect_for(&cli_id) else {
        return;
    };
    if let Err(error) = project_mcp_files::sync(&dialect.target, &project, &BTreeMap::new()) {
        warn!(cli_id, %error, "project MCP: failed to clean up after the last session");
    }
}

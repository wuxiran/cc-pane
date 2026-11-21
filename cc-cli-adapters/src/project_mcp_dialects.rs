//! 各 CLI 的项目级 MCP 方言（docs/110 批 2，来源见 docs/110 §7 与各 adapter 模块头）。

use crate::project_mcp::{
    env_ref_cursor, env_ref_dollar, env_ref_dollar_brace, McpDialect, RemoteShape,
};
use crate::project_mcp_files::{FileFormat, ProjectTarget};

const fn json_target(cli_id: &'static str, rel: &'static [&'static str]) -> ProjectTarget {
    ProjectTarget {
        cli_id,
        rel,
        format: FileFormat::Json,
        servers_key: "mcpServers",
        tool_dir_guard: false,
    }
}

const URL: RemoteShape = RemoteShape {
    url_key: "url",
    kind: None,
};

/// Kimi Code：`.kimi-code/mcp.json`；`url` 无 transport = HTTP，SSE 要写 `"transport":"sse"`；
/// 不展开环境变量（moonshotai.github.io/kimi-code/en/customization/mcp）。
pub const KIMI: McpDialect = McpDialect {
    target: json_target("kimi", &[".kimi-code", "mcp.json"]),
    stdio_kind: None,
    http: Some(URL),
    sse: Some(RemoteShape {
        url_key: "url",
        kind: Some(("transport", "sse")),
    }),
    headers: true,
    env_ref: None,
    enabled_field: None,
    bearer_env_key: Some("bearerTokenEnvVar"),
    proxy_env_ref: None,
    shared_stdio_source: false,
};

/// Antigravity：`.agents/mcp_config.json`；远程用 `serverUrl`（Streamable HTTP），不支持 SSE
/// 与 `httpUrl`（antigravity.google/docs/mcp）。文档未写展开环境变量。
pub const ANTIGRAVITY: McpDialect = McpDialect {
    target: json_target("antigravity", &[".agents", "mcp_config.json"]),
    stdio_kind: None,
    http: Some(RemoteShape {
        url_key: "serverUrl",
        kind: None,
    }),
    sse: None,
    headers: true,
    env_ref: None,
    enabled_field: None,
    bearer_env_key: None,
    proxy_env_ref: None,
    shared_stdio_source: false,
};

/// Gemini CLI：`.gemini/settings.json` 的 `mcpServers`；`httpUrl` = Streamable HTTP，`url` = SSE；
/// 只在 `env` 块里展开 `$VAR`（google-gemini/gemini-cli docs/tools/mcp-server.md）。
pub const GEMINI: McpDialect = McpDialect {
    target: json_target("gemini", &[".gemini", "settings.json"]),
    stdio_kind: None,
    http: Some(RemoteShape {
        url_key: "httpUrl",
        kind: None,
    }),
    sse: Some(URL),
    headers: true,
    env_ref: None,
    enabled_field: None,
    bearer_env_key: None,
    proxy_env_ref: Some(env_ref_dollar),
    shared_stdio_source: false,
};

/// Cursor：`.cursor/mcp.json`；stdio 要 `"type":"stdio"`，远程只靠 `url`（HTTP / SSE 自动判定）；
/// `command`/`args`/`env`/`url`/`headers` 里展开 `${env:NAME}`（cursor.com/docs/mcp）。
pub const CURSOR: McpDialect = McpDialect {
    target: json_target("cursor", &[".cursor", "mcp.json"]),
    stdio_kind: Some(("type", "stdio")),
    http: Some(URL),
    sse: Some(URL),
    headers: true,
    env_ref: Some(env_ref_cursor),
    enabled_field: None,
    bearer_env_key: None,
    proxy_env_ref: None,
    shared_stdio_source: false,
};

/// Grok：`.grok/config.toml` 的 `[mcp_servers.<name>]`（从 cwd 走到 git 根逐个读，项目同名
/// 条目整体替换用户级），`url`/`headers`/`env`/`args` 展开 `${VAR}`；compat 来源（`.mcp.json` 等）
/// 优先级低于 config.toml（docs.x.ai/build/features/mcp-servers）。
pub const GROK: McpDialect = McpDialect {
    target: ProjectTarget {
        cli_id: "grok",
        rel: &[".grok", "config.toml"],
        format: FileFormat::Toml,
        servers_key: "mcp_servers",
        tool_dir_guard: false,
    },
    stdio_kind: None,
    http: Some(URL),
    sse: None,
    headers: true,
    env_ref: Some(env_ref_dollar_brace),
    enabled_field: Some("enabled"),
    bearer_env_key: None,
    proxy_env_ref: None,
    shared_stdio_source: false,
};

/// omp：`.omp/mcp.json`（Claude 同形，`type` 标 http/sse），发现期展开 `${VAR}`
/// （can1357/oh-my-pi docs/mcp-config.md）。
pub const OMP: McpDialect = McpDialect {
    target: ProjectTarget {
        tool_dir_guard: true,
        ..json_target("omp", &[".omp", "mcp.json"])
    },
    stdio_kind: None,
    http: Some(RemoteShape {
        url_key: "url",
        kind: Some(("type", "http")),
    }),
    sse: None,
    headers: true,
    env_ref: Some(env_ref_dollar_brace),
    enabled_field: None,
    bearer_env_key: None,
    proxy_env_ref: None,
    shared_stdio_source: false,
};

/// jcode：`.jcode/mcp.json`；`type` = http / sse，URL 与请求头展开 `${VAR}`
/// （1jehuang/jcode docs/MCP_REMOTE.md）。旧版（< v0.96）只认 stdio，远程条目会被跳过。
pub const JCODE: McpDialect = McpDialect {
    target: ProjectTarget {
        tool_dir_guard: true,
        ..json_target("jcode", &[".jcode", "mcp.json"])
    },
    stdio_kind: None,
    http: Some(RemoteShape {
        url_key: "url",
        kind: Some(("type", "http")),
    }),
    sse: Some(RemoteShape {
        url_key: "url",
        kind: Some(("type", "sse")),
    }),
    headers: true,
    env_ref: Some(env_ref_dollar_brace),
    enabled_field: None,
    bearer_env_key: None,
    proxy_env_ref: None,
    shared_stdio_source: true,
};

pub fn dialect_for(cli_id: &str) -> Option<McpDialect> {
    match cli_id {
        "kimi" => Some(KIMI),
        "antigravity" => Some(ANTIGRAVITY),
        "gemini" => Some(GEMINI),
        "cursor" => Some(CURSOR),
        "grok" => Some(GROK),
        "omp" => Some(OMP),
        "jcode" => Some(JCODE),
        _ => None,
    }
}

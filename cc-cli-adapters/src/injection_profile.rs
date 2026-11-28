//! 结构化注入能力描述（docs/110 批 0）。
//!
//! 每个 adapter 用 [`crate::CliToolAdapter::injection_profile`] 给出**当前代码真实做到的**
//! MCP / Skills 注入面，后端门控（远程 MCP 过滤、ctl 代理白名单、技能可用性）与前端门控
//! 全部读这一份。诚实守卫测试（`tests/injection_profile_honesty.rs`）给每个 CLI 喂满配
//! context，断言这里声明支持的每一项都能在 argv / env / 写出的文件里找到证据。
//!
//! 取值规则：描述的是**现状**而不是目标形态（docs/110 §5）。补齐某项注入后再改这里，
//! 守卫测试会同时把新声明钉住。

use serde::{Deserialize, Serialize};

/// ccpanes 内置 MCP 经什么通道进入 CLI（按侵入性从低到高，docs/110 §4.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpChannel {
    /// 每次启动的命令行参数（Codex `-c mcp_servers.*`），零残留。
    SessionFlag,
    /// 每会话临时文件，经参数或环境变量指向（Claude `--mcp-config`、OpenCode
    /// `OPENCODE_CONFIG`、Pi 扩展桥的 `CCPANES_MCP_CONFIG`）。
    SessionFile,
    /// 项目级配置文件，靠收据增删（omp `.omp/mcp.json`）。同项目会话共享一份。
    ProjectFile,
    /// 用户级配置文件（Cursor `~/.cursor/mcp.json`、Grok `~/.grok/config.toml`），
    /// 持久且所有会话共享。新接入一律不用。
    UserFile,
    /// 只能经 cc-panes-ctl 的 stdio 代理（jcode 只认 stdio；条目写在项目级文件里）。
    StdioProxy,
    /// 不注入 ccpanes。
    None,
}

/// 共享 MCP 的哪些传输方式能到达这个 CLI。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    /// 本机 stdio 型共享 server（经 HTTP 桥 URL，或 stdio-only CLI 直接用源命令）。
    StdioBridge,
    /// 远程 Streamable HTTP。
    Http,
    /// 远程 SSE。
    Sse,
}

/// 启动档「只用选中的 MCP」能否真正挡掉用户自己配置的 server。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpIsolation {
    /// 能按会话显式禁用未选中的 server（Codex `-c mcp_servers.<x>.enabled=false`）。
    Full,
    /// 只收窄 CC-Panes 自己注入的集合，用户配置的 server 照样加载（只 warn）。
    DeclareOnly,
    /// 不处理隔离请求。
    None,
}

/// CC-Panes 的技能目录（`skill_mount_paths`）以什么方式交给 CLI。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillMount {
    /// `--plugin-dir <root>`（每个挂载根本身是一个插件）。
    PluginDir,
    /// `--skill <path>` 一类的单技能参数。
    SkillFlag,
    /// `--skills-dir <dir>` 一类的技能目录参数（kimi，会替换自动发现）。
    SkillsDir,
    /// `--add-dir <staging>`，CLI 读该目录下的约定技能目录。
    AddDir,
    /// 配置里的数组键（OpenCode 每会话配置的 `skills.paths`）。
    ConfigArray,
    /// 写项目级技能目录（Codex：链接进 `.agents/skills/<name>`，收据 + exclude + 会话租约）。
    ProjectFile,
    /// 不消费挂载路径。
    None,
}

/// CLI 原生会读的外部技能来源（启动档里「Claude / Codex / Plugin 技能」开关）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeSkillSource {
    Claude,
    Codex,
    Plugin,
}

/// 某个运行时下的可用程度，相对本机描述而言。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeSupport {
    /// 与本机描述一致。
    Full,
    /// 只到达一部分（例如 WSL 只进 HTTP 型条目，或只有 ccpanes）。
    Partial,
    /// 完全没有。
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInjection {
    /// ccpanes 内置 MCP 的注入通道。
    pub ccpanes: McpChannel,
    /// ccpanes 能否改走 cc-panes-ctl stdio 代理（`mcpProxyEnabled` adapter option）。
    pub ctl_proxy: bool,
    /// 共享 MCP（资源库里的 server）能否注入。
    pub shared: bool,
    /// 工作空间层 + 项目覆盖层 MCP（docs/98）能否注入。
    pub workspace: bool,
    /// 共享 MCP 里能到达的传输方式。
    pub transports: Vec<McpTransport>,
    /// 远程 MCP 的自定义请求头能否带上。
    pub remote_headers: bool,
    pub isolation: McpIsolation,
    /// ccpanes 调用能否带上**本会话**的 launchId（共享文件里的 id 会被并发会话覆盖，不算）。
    pub launch_identity: bool,
    /// 共享 MCP 能否改为只投递一条 `ccpanes-hub`（docs/113）。要求 adapter 会把用户自己
    /// 配置里与 hub 覆盖的服务器同名的条目去重；否则同一组工具会和 hub 并排出现两次。
    #[serde(default)]
    pub hub: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsInjection {
    /// 内置 / 工作空间技能挂载路径的消费方式。
    pub mount: SkillMount,
    /// 有没有会话提示词通道。挂载路径没被消费（`mount == None`，或该运行时不经 adapter）
    /// 时，内置可移植技能与工作空间技能改走这条通道（docs/110 批 1）。
    pub prompt_fallback: bool,
    /// CLI 自己会读的外部技能来源。
    pub native_sources: Vec<NativeSkillSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInjection {
    /// 这个运行时能否启动该 CLI。
    pub launch: bool,
    pub mcp: RuntimeSupport,
    pub skills: RuntimeSupport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionRuntimes {
    pub wsl: RuntimeInjection,
    pub ssh: RuntimeInjection,
}

/// 一个 CLI 的完整注入能力描述（本机语义 + 各运行时的可用程度）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionProfile {
    pub mcp: McpInjection,
    pub skills: SkillsInjection,
    pub runtimes: InjectionRuntimes,
}

impl McpInjection {
    /// 不注入任何 MCP。
    pub fn none() -> Self {
        Self {
            ccpanes: McpChannel::None,
            ctl_proxy: false,
            shared: false,
            workspace: false,
            transports: Vec::new(),
            remote_headers: false,
            isolation: McpIsolation::None,
            launch_identity: false,
            hub: false,
        }
    }

    /// 是否有任何一条 MCP 通道。
    pub fn any(&self) -> bool {
        self.ccpanes != McpChannel::None || self.shared || self.workspace
    }

    pub fn supports_transport(&self, transport: McpTransport) -> bool {
        self.transports.contains(&transport)
    }
}

/// 走项目级配置文件的 MCP 描述（docs/110 批 2 的通用写入器）：共享 + 工作空间层、HTTP、
/// 请求头、隔离只能声明；`ctl_proxy` = ccpanes 经 cc-panes-ctl stdio 代理（不能展开环境变量的
/// CLI），否则 HTTP 占位符。两种都带本会话 launchId（各会话从自己的环境变量展开）。
pub fn project_file_mcp(
    ctl_proxy: bool,
    launch_identity: bool,
    extra_transports: Vec<McpTransport>,
) -> McpInjection {
    let mut transports = vec![McpTransport::StdioBridge, McpTransport::Http];
    transports.extend(extra_transports);
    McpInjection {
        ccpanes: McpChannel::ProjectFile,
        ctl_proxy,
        shared: true,
        workspace: true,
        transports,
        remote_headers: true,
        isolation: McpIsolation::DeclareOnly,
        launch_identity,
        hub: false,
    }
}

impl SkillsInjection {
    pub fn none() -> Self {
        Self {
            mount: SkillMount::None,
            prompt_fallback: false,
            native_sources: Vec::new(),
        }
    }

    /// 内置 / 工作空间技能能否以任何方式送达。
    pub fn deliverable(&self) -> bool {
        self.mount != SkillMount::None || self.prompt_fallback
    }
}

impl InjectionProfile {
    /// 这个运行时下 adapter 会不会真正消费 `skill_mount_paths`。本机看 `skills.mount`；
    /// WSL / SSH 不经 adapter 拼命令，只有该运行时的技能支持为 Full 才算消费了挂载。
    pub fn skill_mounts_consumed(&self, runtime_kind: &str) -> bool {
        if self.skills.mount == SkillMount::None {
            return false;
        }
        self.runtime(runtime_kind)
            .is_none_or(|runtime| runtime.skills == RuntimeSupport::Full)
    }

    /// 内置可移植技能 / 工作空间技能要不要以会话提示词送达：有提示词通道、且挂载没被消费。
    /// 消费了挂载的还回退，会让同一个技能出现两遍。
    pub fn uses_skill_prompt_fallback(&self, runtime_kind: &str) -> bool {
        self.skills.prompt_fallback && !self.skill_mounts_consumed(runtime_kind)
    }
}

impl RuntimeInjection {
    /// 能启动，但 MCP 与技能都不注入。
    pub fn launch_only() -> Self {
        Self {
            launch: true,
            mcp: RuntimeSupport::None,
            skills: RuntimeSupport::None,
        }
    }

    /// 不能在这个运行时启动。
    pub fn unavailable() -> Self {
        Self {
            launch: false,
            mcp: RuntimeSupport::None,
            skills: RuntimeSupport::None,
        }
    }
}

impl InjectionProfile {
    /// 不接任何注入的 CLI（WSL / SSH 仍可裸启动）。
    pub fn unsupported() -> Self {
        Self {
            mcp: McpInjection::none(),
            skills: SkillsInjection::none(),
            runtimes: InjectionRuntimes {
                wsl: RuntimeInjection::launch_only(),
                ssh: RuntimeInjection::launch_only(),
            },
        }
    }

    /// trait 的保守默认值：只按有无提示词通道给出回退，其余一律当作不支持。
    /// 内置 adapter 都显式覆盖（`web/test/cliToolCoverage.test.ts` 守着）。
    pub fn derived(supports_prompt_fallback: bool) -> Self {
        let mut profile = Self::unsupported();
        profile.skills.prompt_fallback = supports_prompt_fallback;
        profile
    }

    /// 指定运行时的描述；`local`（或未知值）返回 None，表示按本机描述。
    pub fn runtime(&self, runtime_kind: &str) -> Option<&RuntimeInjection> {
        match runtime_kind {
            "wsl" => Some(&self.runtimes.wsl),
            "ssh" => Some(&self.runtimes.ssh),
            _ => None,
        }
    }

    /// 这条远程 MCP（`http`/`sse`，是否带请求头）能否到达该 CLI。
    ///
    /// WSL / SSH 走另一条注入路径，不带请求头也不走 SSE（docs/110 §6 批 4）。
    pub fn remote_mcp_supported(&self, transport: &str, has_headers: bool, runtime: &str) -> bool {
        let transport = if transport == "sse" {
            McpTransport::Sse
        } else {
            McpTransport::Http
        };
        if !self.mcp.shared || !self.mcp.supports_transport(transport) {
            return false;
        }
        if self.runtime(runtime).is_some() {
            return !has_headers && transport == McpTransport::Http;
        }
        !has_headers || self.mcp.remote_headers
    }

    /// 这次启动能否用 hub 投递共享 MCP（docs/113）：CLI 声明了 `mcp.hub`，且是本机运行时。
    /// WSL / SSH 走另一条注入路径（主机改写 / 无 orchestrator），一律回退直连。
    /// 前端 `hubDeliverySupported`（web/lib/cliInjectionRules.ts）同口径，两处同步改。
    pub fn hub_delivery_supported(&self, runtime: &str) -> bool {
        self.mcp.shared && self.mcp.hub && self.runtime(runtime).is_none()
    }
}

#[cfg(test)]
mod tests {
    use crate::CliToolRegistry;

    /// 前端静态兜底（web 模式 / 测试）直接 import 这份 JSON；它必须与注册表的输出逐字段一致。
    /// 改了某个 adapter 的描述，把本测试失败时打印的 JSON 写回该文件即可。
    const WEB_FALLBACK_JSON: &str = include_str!("../../web/lib/cliInjectionProfiles.json");

    #[test]
    fn web_fallback_matches_registry_profiles() {
        let registry = CliToolRegistry::with_builtin_adapters();
        let actual = serde_json::to_value(registry.injection_profiles()).unwrap();
        let expected: serde_json::Value = serde_json::from_str(WEB_FALLBACK_JSON).unwrap();
        assert_eq!(
            expected,
            actual,
            "web/lib/cliInjectionProfiles.json is stale; replace it with:\n{}",
            serde_json::to_string_pretty(&actual).unwrap()
        );
    }

    /// docs/113：只有本机的 Claude / Codex 能用 hub 投递（它们对用户自己配置的同名条目去重）。
    #[test]
    fn hub_delivery_rule_reads_profile() {
        let registry = CliToolRegistry::with_builtin_adapters();
        let profile = |id: &str| registry.get(id).unwrap().injection_profile();
        assert!(profile("claude").hub_delivery_supported("local"));
        assert!(profile("codex").hub_delivery_supported("local"));
        assert!(!profile("claude").hub_delivery_supported("wsl"));
        assert!(!profile("codex").hub_delivery_supported("ssh"));
        for other in ["gemini", "opencode", "pi", "jcode", "cursor"] {
            assert!(!profile(other).hub_delivery_supported("local"), "{other}");
        }
    }

    #[test]
    fn remote_rule_reads_profile() {
        let registry = CliToolRegistry::with_builtin_adapters();
        let profile = |id: &str| registry.get(id).unwrap().injection_profile();
        assert!(profile("claude").remote_mcp_supported("sse", true, "local"));
        assert!(profile("codex").remote_mcp_supported("http", true, "local"));
        assert!(!profile("codex").remote_mcp_supported("sse", false, "local"));
        // docs/110 批 2：jcode 放开 http/sse，opencode / pi / omp 放开请求头，antigravity 无 SSE
        assert!(profile("jcode").remote_mcp_supported("sse", true, "local"));
        assert!(profile("opencode").remote_mcp_supported("http", true, "local"));
        assert!(!profile("opencode").remote_mcp_supported("sse", false, "local"));
        assert!(profile("pi").remote_mcp_supported("http", true, "local"));
        assert!(profile("kimi").remote_mcp_supported("sse", true, "local"));
        assert!(!profile("antigravity").remote_mcp_supported("sse", false, "local"));
        assert!(!profile("claude").remote_mcp_supported("http", true, "wsl"));
        assert!(profile("claude").remote_mcp_supported("http", false, "wsl"));
        assert!(profile("gemini").remote_mcp_supported("http", false, "local"));
    }
}

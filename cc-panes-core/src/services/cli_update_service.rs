//! 已装 Agent CLI 的新版本检测（首页「N 个 Agent 有新版本」+「更新到 x」）。
//!
//! 按可执行文件的**真实路径**判断它是怎么装的——npm / bun 全局包、Homebrew formula / cask，
//! 其余算原生安装器——再按来源查最新版本，并给出对应的升级命令：
//! 同一个 CLI 用 brew 装的就得 `brew upgrade`，用 npm 装的再 `brew upgrade` 是白跑。
//!
//! 「有没有新版本」在前端比：当前版本取 CLI 检测结果（装完回到窗口会重新检测），
//! 这里只回答「最新是多少、该怎么升」。查不到的一律给 `None`，不猜。

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const NPM_REGISTRIES: &[&str] = &["https://registry.npmjs.org", "https://registry.npmmirror.com"];
const BREW_API: &str = "https://formulae.brew.sh/api";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallSource {
    Npm,
    Bun,
    Brew,
    BrewCask,
    /// 官方安装脚本等，靠 CLI 自带的升级命令。
    Native,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedSource {
    pub source: InstallSource,
    /// npm / bun 包名，或 brew formula / cask 名。
    pub package: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateInfo {
    pub id: String,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub source: InstallSource,
    pub package: Option<String>,
    /// 在终端里执行即可升级；`None` = 不知道怎么升（不显示更新按钮）。
    pub update_command: Option<String>,
}

/// 已知 Agent：对应的 npm 包（原生安装的也拿它当「最新版本」的参照）与自带升级命令。
/// 包名与首页 agentCatalog.ts 的安装命令保持一致。
struct KnownAgent {
    id: &'static str,
    npm_package: Option<&'static str>,
    self_update: Option<&'static str>,
}

const KNOWN_AGENTS: &[KnownAgent] = &[
    KnownAgent { id: "claude", npm_package: Some("@anthropic-ai/claude-code"), self_update: Some("claude update") },
    KnownAgent { id: "codex", npm_package: Some("@openai/codex"), self_update: None },
    KnownAgent { id: "gemini", npm_package: Some("@google/gemini-cli"), self_update: None },
    KnownAgent { id: "opencode", npm_package: Some("opencode-ai"), self_update: Some("opencode upgrade") },
    KnownAgent { id: "grok", npm_package: Some("@xai-official/grok"), self_update: None },
    KnownAgent { id: "pi", npm_package: Some("@earendil-works/pi-coding-agent"), self_update: None },
    KnownAgent { id: "omp", npm_package: Some("@oh-my-pi/pi-coding-agent"), self_update: None },
];

fn known(id: &str) -> Option<&'static KnownAgent> {
    KNOWN_AGENTS.iter().find(|agent| agent.id == id)
}

fn segment_after<'a>(path: &'a str, marker: &str) -> Option<&'a str> {
    let start = path.find(marker)? + marker.len();
    path[start..].split('/').next().filter(|segment| !segment.is_empty())
}

/// `.../node_modules/@scope/name/...` 或 `.../node_modules/name/...` → 包名（取最后一层 node_modules）。
fn package_after_node_modules(path: &str) -> Option<String> {
    let marker = "/node_modules/";
    let start = path.rfind(marker)? + marker.len();
    let mut parts = path[start..].split('/');
    let first = parts.next().filter(|segment| !segment.is_empty())?;
    if first.starts_with('@') {
        let second = parts.next().filter(|segment| !segment.is_empty())?;
        Some(format!("{first}/{second}"))
    } else {
        Some(first.to_string())
    }
}

/// 从可执行文件的真实路径（已解开符号链接）判断安装来源。纯字符串判断，便于测试。
pub fn detect_source_from_path(real_path: &str) -> DetectedSource {
    let path = real_path.replace('\\', "/");
    if let Some(cask) = segment_after(&path, "/Caskroom/") {
        return DetectedSource { source: InstallSource::BrewCask, package: Some(cask.to_string()) };
    }
    if let Some(formula) = segment_after(&path, "/Cellar/") {
        return DetectedSource { source: InstallSource::Brew, package: Some(formula.to_string()) };
    }
    if let Some(package) = package_after_node_modules(&path) {
        let source = if path.contains("/.bun/") { InstallSource::Bun } else { InstallSource::Npm };
        return DetectedSource { source, package: Some(package) };
    }
    DetectedSource { source: InstallSource::Native, package: None }
}

/// 真实路径里看不出 node_modules 时（Windows 的 `codex.cmd` 垫片、非链接的拷贝），
/// 到垫片旁边找全局包目录：Windows `<npm>/node_modules/<pkg>`，Unix `<prefix>/lib/node_modules/<pkg>`。
fn npm_package_beside_shim(executable: &Path, package: &str) -> bool {
    let Some(dir) = executable.parent() else { return false };
    let candidates = [
        dir.join("node_modules").join(package),
        dir.join("..").join("lib").join("node_modules").join(package),
    ];
    candidates.iter().any(|candidate| candidate.join("package.json").is_file())
}

pub fn detect_source(id: &str, executable_path: &str) -> DetectedSource {
    let executable = Path::new(executable_path);
    let real = std::fs::canonicalize(executable).unwrap_or_else(|_| executable.to_path_buf());
    let detected = detect_source_from_path(&real.to_string_lossy());
    if detected.source != InstallSource::Native {
        return detected;
    }
    if let Some(package) = known(id).and_then(|agent| agent.npm_package) {
        if npm_package_beside_shim(executable, package) {
            return DetectedSource { source: InstallSource::Npm, package: Some(package.to_string()) };
        }
    }
    detected
}

pub fn update_command(id: &str, detected: &DetectedSource) -> Option<String> {
    let package = detected.package.as_deref();
    match detected.source {
        InstallSource::Npm => package.map(|name| format!("npm install -g {name}@latest")),
        InstallSource::Bun => package.map(|name| format!("bun add -g {name}@latest")),
        InstallSource::Brew => package.map(|name| format!("brew upgrade {name}")),
        InstallSource::BrewCask => package.map(|name| format!("brew upgrade --cask {name}")),
        InstallSource::Native => known(id).and_then(|agent| agent.self_update).map(str::to_string),
    }
}

/// 作用域包的 `/` 要转义：`@openai/codex` → `@openai%2Fcodex`。
fn npm_latest_url(registry: &str, package: &str) -> String {
    format!("{registry}/{}/latest", package.replace('/', "%2F"))
}

/// cask 版本可能带构建号（`0.171.0,abc123`），只留前半段。
fn clean_brew_version(raw: &str) -> String {
    raw.split(',').next().unwrap_or(raw).trim().to_string()
}

async fn get_json(client: &reqwest::Client, url: &str) -> Option<serde_json::Value> {
    let response = client.get(url).timeout(REQUEST_TIMEOUT).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<serde_json::Value>().await.ok()
}

async fn npm_latest(client: &reqwest::Client, package: &str) -> Option<String> {
    for registry in NPM_REGISTRIES {
        let body = get_json(client, &npm_latest_url(registry, package)).await;
        if let Some(version) = body.as_ref().and_then(|json| json["version"].as_str()) {
            return Some(version.to_string());
        }
    }
    None
}

async fn brew_latest(client: &reqwest::Client, detected: &DetectedSource) -> Option<String> {
    let name = detected.package.as_deref()?;
    let (kind, pointer) = match detected.source {
        InstallSource::Brew => ("formula", "/versions/stable"),
        InstallSource::BrewCask => ("cask", "/version"),
        _ => return None,
    };
    let body = get_json(client, &format!("{BREW_API}/{kind}/{name}.json")).await?;
    body.pointer(pointer).and_then(|value| value.as_str()).map(clean_brew_version)
}

async fn latest_version(client: &reqwest::Client, id: &str, detected: &DetectedSource) -> Option<String> {
    match detected.source {
        InstallSource::Npm | InstallSource::Bun => npm_latest(client, detected.package.as_deref()?).await,
        // 第三方 tap 的 formula 不在官方 API 里：退回同一个上游的 npm 包版本。
        InstallSource::Brew | InstallSource::BrewCask => match brew_latest(client, detected).await {
            Some(version) => Some(version),
            None => npm_latest(client, known(id)?.npm_package?).await,
        },
        InstallSource::Native => npm_latest(client, known(id)?.npm_package?).await,
    }
}

/// 已装 CLI 的 (id, 可执行文件路径, 当前版本)。
pub struct InstalledCli {
    pub id: String,
    pub path: String,
    pub version: Option<String>,
}

/// 并发查所有已装 CLI；单个查询失败只影响它自己（latest 为 None）。
pub async fn check_updates(installed: Vec<InstalledCli>) -> Vec<CliUpdateInfo> {
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "[cli-update] build http client failed");
            return Vec::new();
        }
    };
    let mut tasks = tokio::task::JoinSet::new();
    for (index, cli) in installed.into_iter().enumerate() {
        let client = client.clone();
        tasks.spawn(async move {
            let detected = detect_source(&cli.id, &cli.path);
            let latest = latest_version(&client, &cli.id, &detected).await;
            let info = CliUpdateInfo {
                update_command: update_command(&cli.id, &detected),
                id: cli.id,
                current_version: cli.version,
                latest_version: latest,
                source: detected.source,
                package: detected.package,
            };
            (index, info)
        });
    }
    let mut results = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        if let Ok(result) = joined {
            results.push(result);
        }
    }
    results.sort_by_key(|(index, _)| *index);
    results.into_iter().map(|(_, info)| info).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(path: &str) -> DetectedSource {
        detect_source_from_path(path)
    }

    #[test]
    fn npm_global_package_is_detected_from_real_path() {
        let detected = source("/Users/u/.nvm/versions/node/v24.8.0/lib/node_modules/@openai/codex/bin/codex.js");
        assert_eq!(detected, DetectedSource { source: InstallSource::Npm, package: Some("@openai/codex".into()) });
        let unscoped = source("/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe");
        assert_eq!(unscoped.package.as_deref(), Some("opencode-ai"));
    }

    #[test]
    fn bun_global_package_is_detected() {
        let detected = source("/Users/u/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
        assert_eq!(detected.source, InstallSource::Bun);
        assert_eq!(detected.package.as_deref(), Some("@oh-my-pi/pi-coding-agent"));
    }

    #[test]
    fn homebrew_formula_and_cask_are_detected() {
        let formula = source("/opt/homebrew/Cellar/gemini-cli/0.1.9/libexec/lib/node_modules/@google/gemini-cli/dist/index.js");
        assert_eq!(formula, DetectedSource { source: InstallSource::Brew, package: Some("gemini-cli".into()) });
        let cask = source("/opt/homebrew/Caskroom/codex/0.169.0/codex-aarch64-apple-darwin");
        assert_eq!(cask, DetectedSource { source: InstallSource::BrewCask, package: Some("codex".into()) });
    }

    #[test]
    fn windows_paths_are_normalized() {
        let detected = source(r"C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js");
        assert_eq!(detected.package.as_deref(), Some("@anthropic-ai/claude-code"));
    }

    #[test]
    fn anything_else_is_native() {
        assert_eq!(source("/Users/u/.local/share/claude/versions/2.1.330").source, InstallSource::Native);
    }

    #[test]
    fn update_command_follows_install_source() {
        let npm = DetectedSource { source: InstallSource::Npm, package: Some("@openai/codex".into()) };
        assert_eq!(update_command("codex", &npm).as_deref(), Some("npm install -g @openai/codex@latest"));
        let cask = DetectedSource { source: InstallSource::BrewCask, package: Some("codex".into()) };
        assert_eq!(update_command("codex", &cask).as_deref(), Some("brew upgrade --cask codex"));
        let native = DetectedSource { source: InstallSource::Native, package: None };
        assert_eq!(update_command("claude", &native).as_deref(), Some("claude update"));
        assert_eq!(update_command("cursor", &native), None);
    }

    #[test]
    fn scoped_npm_package_url_is_escaped() {
        assert_eq!(
            npm_latest_url("https://registry.npmjs.org", "@openai/codex"),
            "https://registry.npmjs.org/@openai%2Fcodex/latest",
        );
    }

    /// 真联网查一次本机已装的 CLI：`cargo test cli_update_service -- --ignored --nocapture`。
    #[tokio::test]
    #[ignore]
    async fn live_check_against_local_install() {
        let installed = ["claude", "codex", "opencode"]
            .iter()
            .filter_map(|id| which::which(id).ok().map(|path| InstalledCli {
                id: (*id).to_string(),
                path: path.to_string_lossy().into_owned(),
                version: None,
            }))
            .collect();
        for info in check_updates(installed).await {
            println!("{info:?}");
        }
    }

    #[test]
    fn cask_build_suffix_is_dropped() {
        assert_eq!(clean_brew_version("0.171.0,abc123"), "0.171.0");
        assert_eq!(clean_brew_version("1.19.6"), "1.19.6");
    }
}

//! 内置组件 · 飞书 CLI（官方 `@larksuite/cli`，命令 `lark-cli`）。
//!
//! 它不是 MCP：Agent 通过 Skills 学会调用 `lark-cli`。所以组件做四件事：
//! 1. `npm install -g @larksuite/cli`（包的 postinstall 会下载对应平台的 Go 二进制）；
//! 2. `lark-cli config init --new`：创建/绑定飞书应用，需要用户在浏览器里确认；
//! 3. `lark-cli auth login --recommend`：用户身份授权，同样走浏览器（设备码流程）；
//! 4. 把官方仓库 `skills/lark-*` 装进 CC-Panes 技能库，各启动档按开关注入。
//!
//! 2、3 两步命令会阻塞到用户在浏览器里完成为止，并把授权链接打到 stderr——
//! 这里在后台跑它们，从输出里抠出链接交给界面打开，进程退出即完成。
//! 同一时间只跑一个任务，进度存在进程内，界面轮询 `status` 读取。
use crate::services::{SkillMarketEntry, SkillMarketService};
use cc_panes_core::models::settings::ProxySettings;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};

const PACKAGE: &str = "@larksuite/cli@latest";
const SKILLS_REPO: &str = "larksuite/cli";
/// 官方仓库 skills/ 下的技能（2026-11 快照）。装的时候按这个清单逐个下载。
pub const SKILL_NAMES: &[&str] = &[
    "lark-shared",
    "lark-approval",
    "lark-apps",
    "lark-attendance",
    "lark-base",
    "lark-calendar",
    "lark-contact",
    "lark-doc",
    "lark-drive",
    "lark-event",
    "lark-im",
    "lark-mail",
    "lark-markdown",
    "lark-meeting",
    "lark-note",
    "lark-okr",
    "lark-openapi-explorer",
    "lark-sheets",
    "lark-skill-maker",
    "lark-slides",
    "lark-task",
    "lark-whiteboard",
    "lark-wiki",
    "lark-workflow-meeting-summary",
    "lark-workflow-standup-report",
];
/// 浏览器授权最多等这么久，超时视为放弃
const BROWSER_STEP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const QUICK_TIMEOUT: Duration = Duration::from_secs(15);
const OUTPUT_TAIL_LINES: usize = 12;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeishuJob {
    /// install / config / login / skills
    pub kind: &'static str,
    /// running / done / error / cancelled
    pub stage: &'static str,
    /// 需要用户在浏览器里打开的授权链接
    pub url: Option<String>,
    pub done: u32,
    pub total: u32,
    pub error: Option<String>,
}

impl FeishuJob {
    fn running(&self) -> bool {
        self.stage == "running"
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuStatus {
    pub npm_found: bool,
    pub installed: bool,
    pub version: Option<String>,
    /// 已有应用凭证（config init 完成）
    pub configured: bool,
    pub app_id: Option<String>,
    /// feishu / lark
    pub brand: Option<String>,
    /// user（已登录）/ bot（只有应用身份）/ none
    pub identity: Option<String>,
    pub skills_installed: Vec<String>,
    pub skills_total: usize,
    pub job: Option<FeishuJob>,
}

struct JobSlot {
    job: FeishuJob,
    cancel: Arc<AtomicBool>,
}

static JOB: Mutex<Option<JobSlot>> = Mutex::new(None);

fn with_job<R>(f: impl FnOnce(&mut Option<JobSlot>) -> R) -> R {
    f(&mut JOB.lock().unwrap_or_else(|e| e.into_inner()))
}

fn update(f: impl FnOnce(&mut FeishuJob)) {
    with_job(|slot| {
        if let Some(slot) = slot.as_mut() {
            f(&mut slot.job);
        }
    });
}

fn current_job() -> Option<FeishuJob> {
    with_job(|slot| slot.as_ref().map(|slot| slot.job.clone()))
}

pub fn cancel() {
    with_job(|slot| {
        if let Some(slot) = slot.as_ref() {
            slot.cancel.store(true, Ordering::SeqCst);
        }
    });
}

/// 占住任务位；已有任务在跑时报错。
fn begin(kind: &'static str, total: u32) -> Result<Arc<AtomicBool>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    with_job(|slot| {
        if slot.as_ref().is_some_and(|slot| slot.job.running()) {
            return Err("Another Feishu CLI task is still running".to_string());
        }
        *slot = Some(JobSlot {
            job: FeishuJob {
                kind,
                stage: "running",
                url: None,
                done: 0,
                total,
                error: None,
            },
            cancel: cancel.clone(),
        });
        Ok(cancel)
    })
}

fn finish(result: Result<(), String>, cancel: &AtomicBool) {
    update(|job| match result {
        Ok(()) => job.stage = "done",
        Err(_) if cancel.load(Ordering::SeqCst) => job.stage = "cancelled",
        Err(error) => {
            tracing::warn!(kind = job.kind, %error, "feishu cli task failed");
            job.stage = "error";
            job.error = Some(error);
        }
    });
}

fn resolve(program: &str) -> Option<PathBuf> {
    cc_cli_adapters::resolve_executable(program).ok()
}

/// 刚装完时 npm 的全局 bin 目录可能还不在本进程 PATH 里：再看 npm 同目录
/// （nvm / 官方安装包都是这样），Windows 上再看 %APPDATA%\npm。
fn resolve_cli() -> Option<PathBuf> {
    resolve("lark-cli").or_else(|| {
        let mut dirs: Vec<PathBuf> = resolve("npm")
            .and_then(|npm| npm.parent().map(Path::to_path_buf))
            .into_iter()
            .collect();
        if cfg!(windows) {
            if let Some(appdata) = std::env::var_os("APPDATA") {
                dirs.push(PathBuf::from(appdata).join("npm"));
            }
        }
        let names: &[&str] = if cfg!(windows) {
            &["lark-cli.cmd", "lark-cli.exe"]
        } else {
            &["lark-cli"]
        };
        dirs.iter()
            .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
            .find(|path| path.is_file())
    })
}

/// GUI 进程的 PATH 往往不含 nvm 之类的目录，而 npm / lark-cli 都是 `#!/usr/bin/env node` 脚本：
/// 把程序所在目录放到 PATH 最前面，子进程才找得到同目录的 node。
fn command_for(program: &Path, proxy: Option<&ProxySettings>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    if let Some(dir) = program.parent() {
        let mut paths = vec![dir.to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }
    // npm 只认 http(s) 代理；socks 代理交给系统环境
    if let Some(proxy) =
        proxy.filter(|p| p.enabled && !p.host.is_empty() && p.proxy_type != "socks5")
    {
        let url = format!("http://{}:{}", proxy.host, proxy.port);
        command.env("HTTPS_PROXY", &url).env("HTTP_PROXY", &url);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::services::voice_local::hide_console_window(&mut command);
    command
}

pub async fn status(market: &SkillMarketService) -> FeishuStatus {
    let npm_found = resolve("npm").is_some();
    let cli = resolve_cli();
    let mut status = FeishuStatus {
        npm_found,
        installed: cli.is_some(),
        version: None,
        configured: false,
        app_id: None,
        brand: None,
        identity: None,
        skills_installed: installed_skills(market),
        skills_total: SKILL_NAMES.len(),
        job: current_job(),
    };
    let Some(cli) = cli else { return status };
    if let Ok(out) = run_quick(&cli, &["--version"]).await {
        status.version = parse_version(&out);
    }
    if let Ok(out) = run_quick(&cli, &["auth", "status"]).await {
        apply_auth_status(&mut status, &out);
    }
    status
}

fn installed_skills(market: &SkillMarketService) -> Vec<String> {
    market
        .list_user_skills()
        .map(|skills| {
            skills
                .into_iter()
                .map(|skill| skill.id)
                .filter(|id| SKILL_NAMES.contains(&id.as_str()))
                .collect()
        })
        .unwrap_or_default()
}

async fn run_quick(program: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = command_for(program, None);
    command.args(args);
    let output = tokio::time::timeout(QUICK_TIMEOUT, command.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_version(out: &str) -> Option<String> {
    out.split_whitespace()
        .find(|token| token.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

/// `auth status` 未配置时是 `{"ok":false,"error":{...}}`，配置后是 `{"appId":…,"identity":…}`。
fn apply_auth_status(status: &mut FeishuStatus, out: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(out.trim()) else {
        return;
    };
    let text = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    status.app_id = text("appId");
    status.configured = status.app_id.is_some();
    status.brand = text("brand");
    status.identity = text("identity");
}

/// 输出里第一个 http(s) 链接（授权页）。去掉行尾可能粘着的标点。
fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://").or_else(|| line.find("http://"))?;
    let url: String = line[start..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    let url = url.trim_end_matches(['.', ',', ')', '"', '\'', '。', '）']);
    (url.len() > "https://".len()).then(|| url.to_string())
}

/// 跑一个长命令：边读输出边找授权链接，可取消，超时即杀。失败时带上输出末尾几行。
async fn run_streaming(
    mut command: tokio::process::Command,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);

    let mut tail: VecDeque<String> = VecDeque::new();
    let deadline = tokio::time::Instant::now() + timeout;
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    let status = loop {
        tokio::select! {
            line = rx.recv() => {
                let Some(line) = line else { continue };
                if let Some(url) = extract_url(&line) {
                    update(|job| { job.url.get_or_insert(url); });
                }
                // 二维码字符画没有信息量，不进错误摘要
                if !line.trim().is_empty() && !line.contains('█') && !line.contains('▀') {
                    if tail.len() == OUTPUT_TAIL_LINES { tail.pop_front(); }
                    tail.push_back(line);
                }
            }
            status = child.wait() => break status.map_err(|e| e.to_string())?,
            _ = tick.tick() => {
                if cancel.load(Ordering::SeqCst) {
                    let _ = child.kill().await;
                    return Err("cancelled".into());
                }
                if tokio::time::Instant::now() >= deadline {
                    let _ = child.kill().await;
                    return Err("Timed out".into());
                }
            }
        }
    };
    if status.success() {
        Ok(())
    } else {
        let detail = tail.into_iter().collect::<Vec<_>>().join("\n");
        Err(if detail.is_empty() {
            format!("Exited with {status}")
        } else {
            detail
        })
    }
}

pub fn start_install(proxy: ProxySettings) -> Result<(), String> {
    let npm = resolve("npm").ok_or("npm was not found. Install Node.js first")?;
    let cancel = begin("install", 0)?;
    tauri::async_runtime::spawn(async move {
        let mut command = command_for(&npm, Some(&proxy));
        command.args(["install", "-g", PACKAGE, "--no-audit", "--no-fund"]);
        let result = run_streaming(command, INSTALL_TIMEOUT, &cancel).await;
        finish(result, &cancel);
    });
    Ok(())
}

/// config / login：都是「后台跑、等用户在浏览器里确认」的命令。
pub fn start_browser_step(kind: &'static str) -> Result<(), String> {
    let args: &[&str] = match kind {
        "config" => &["config", "init", "--new"],
        "login" => &["auth", "login", "--recommend"],
        _ => return Err(format!("unknown step {kind}")),
    };
    let cli = resolve_cli().ok_or("lark-cli is not installed")?;
    let cancel = begin(kind, 0)?;
    tauri::async_runtime::spawn(async move {
        let mut command = command_for(&cli, None);
        command.args(args);
        let result = run_streaming(command, BROWSER_STEP_TIMEOUT, &cancel).await;
        finish(result, &cancel);
    });
    Ok(())
}

pub fn start_skills(market: Arc<SkillMarketService>) -> Result<(), String> {
    let cancel = begin("skills", SKILL_NAMES.len() as u32)?;
    tauri::async_runtime::spawn(async move {
        let mut failed = Vec::new();
        for name in SKILL_NAMES {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            if let Err(error) = market.install_entry(skill_entry(name)).await {
                tracing::warn!(skill = name, %error, "install feishu skill failed");
                failed.push(format!("{name}: {error}"));
            }
            update(|job| job.done += 1);
        }
        let result = if cancel.load(Ordering::SeqCst) {
            Err("cancelled".into())
        } else if failed.is_empty() {
            Ok(())
        } else {
            Err(failed.join("\n"))
        };
        finish(result, &cancel);
    });
    Ok(())
}

fn skill_entry(name: &str) -> SkillMarketEntry {
    SkillMarketEntry {
        id: name.to_string(),
        name: name.to_string(),
        repo: Some(SKILLS_REPO.to_string()),
        path: Some(format!("skills/{name}")),
        homepage_url: Some(format!(
            "https://github.com/{SKILLS_REPO}/tree/main/skills/{name}"
        )),
        tags: vec!["feishu".into(), "lark".into()],
        ..SkillMarketEntry::default()
    }
}

pub async fn logout() -> Result<(), String> {
    let cli = resolve_cli().ok_or("lark-cli is not installed")?;
    let mut command = command_for(&cli, None);
    command.args(["auth", "logout"]);
    let output = tokio::time::timeout(QUICK_TIMEOUT, command.output())
        .await
        .map_err(|_| "Timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_status() -> FeishuStatus {
        FeishuStatus {
            npm_found: true,
            installed: true,
            version: None,
            configured: false,
            app_id: None,
            brand: None,
            identity: None,
            skills_installed: vec![],
            skills_total: SKILL_NAMES.len(),
            job: None,
        }
    }

    #[test]
    fn parses_version_line() {
        assert_eq!(
            parse_version("lark-cli version 1.0.100\n").as_deref(),
            Some("1.0.100")
        );
        assert_eq!(parse_version("garbage"), None);
    }

    #[test]
    fn auth_status_not_configured_and_logged_in() {
        let mut status = empty_status();
        apply_auth_status(
            &mut status,
            r#"{"ok":false,"error":{"type":"config","subtype":"not_configured"}}"#,
        );
        assert!(!status.configured);
        assert_eq!(status.identity, None);

        let mut status = empty_status();
        apply_auth_status(
            &mut status,
            r#"{"appId":"cli_a1","brand":"feishu","identity":"user","identities":{}}"#,
        );
        assert!(status.configured);
        assert_eq!(status.app_id.as_deref(), Some("cli_a1"));
        assert_eq!(status.identity.as_deref(), Some("user"));
    }

    #[test]
    fn extracts_authorization_url() {
        assert_eq!(
            extract_url("  https://open.feishu.cn/page/cli?user_code=AB&from=cli").as_deref(),
            Some("https://open.feishu.cn/page/cli?user_code=AB&from=cli")
        );
        assert_eq!(
            extract_url("打开链接：https://accounts.feishu.cn/x?code=1。").as_deref(),
            Some("https://accounts.feishu.cn/x?code=1")
        );
        assert_eq!(extract_url("等待配置应用..."), None);
    }

    #[test]
    fn skill_entries_point_at_official_repo() {
        let entry = skill_entry("lark-im");
        assert_eq!(entry.repo.as_deref(), Some("larksuite/cli"));
        assert_eq!(entry.path.as_deref(), Some("skills/lark-im"));
        assert_eq!(entry.repo_skill_leaf(), "lark-im");
        assert!(SKILL_NAMES.contains(&"lark-shared"));
    }

    #[test]
    fn only_one_job_at_a_time() {
        with_job(|slot| *slot = None);
        let cancel = begin("install", 0).unwrap();
        assert!(begin("login", 0).is_err());
        finish(Err("boom".into()), &cancel);
        assert_eq!(current_job().unwrap().stage, "error");
        let cancel = begin("login", 0).unwrap();
        cancel.store(true, Ordering::SeqCst);
        finish(Err("cancelled".into()), &cancel);
        assert_eq!(current_job().unwrap().stage, "cancelled");
        with_job(|slot| *slot = None);
    }
}

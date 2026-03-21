use crate::services::HistoryService;
use crate::utils::{
    output_with_timeout, validate_git_url, validate_path, AppResult, GIT_LOCAL_TIMEOUT,
    GIT_NETWORK_TIMEOUT,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, EventTarget, State};
use tracing::{debug, info};

/// 获取项目的 Git 分支名
#[tauri::command]
pub fn get_git_branch(path: String) -> AppResult<Option<String>> {
    validate_path(&path)?;
    let project_path = Path::new(&path);
    if !project_path.exists() {
        return Ok(None);
    }

    let output = output_with_timeout(
        Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(project_path),
        GIT_LOCAL_TIMEOUT,
    )?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if branch.is_empty() {
            Ok(None)
        } else {
            Ok(Some(branch))
        }
    } else {
        Ok(None)
    }
}

/// 获取项目的 Git 状态（是否有未提交的更改）
#[tauri::command]
pub fn get_git_status(path: String) -> AppResult<Option<bool>> {
    validate_path(&path)?;
    let project_path = Path::new(&path);
    if !project_path.exists() {
        return Ok(None);
    }

    let output = output_with_timeout(
        Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(project_path),
        GIT_LOCAL_TIMEOUT,
    )?;

    if output.status.success() {
        let status = String::from_utf8_lossy(&output.stdout);
        Ok(Some(!status.trim().is_empty()))
    } else {
        Ok(None)
    }
}

/// 执行 Git 命令并返回结果
fn run_git_command(path: &str, args: &[&str]) -> AppResult<String> {
    validate_path(path)?;
    let project_path = Path::new(path);
    if !project_path.exists() {
        return Err("Path does not exist".into());
    }

    let output = output_with_timeout(
        Command::new("git").args(args).current_dir(project_path),
        GIT_NETWORK_TIMEOUT,
    )?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(if stdout.is_empty() {
            "Operation successful".to_string()
        } else {
            stdout
        })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr }.into())
    }
}

/// Git 操作前自动打标签的辅助函数
fn auto_label_before_git(history_service: &HistoryService, path: &str, operation: &str) {
    let label_name = format!("Before Git {}", operation);
    let _ = history_service.create_auto_label(Path::new(path), &label_name, "git_commit");
}

#[tauri::command]
pub fn git_pull(
    path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    debug!(path = %path, "cmd::git_pull");
    auto_label_before_git(&history_service, &path, "Pull");
    run_git_command(&path, &["pull"])
}

#[tauri::command]
pub fn git_push(
    path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    info!(path = %path, "cmd::git_push");
    auto_label_before_git(&history_service, &path, "Push");
    run_git_command(&path, &["push"])
}

#[tauri::command]
pub fn git_stash(
    path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    debug!(path = %path, "cmd::git_stash");
    auto_label_before_git(&history_service, &path, "Stash");
    run_git_command(&path, &["stash"])
}

#[tauri::command]
pub fn git_stash_pop(
    path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    debug!(path = %path, "cmd::git_stash_pop");
    auto_label_before_git(&history_service, &path, "Stash Pop");
    run_git_command(&path, &["stash", "pop"])
}

#[tauri::command]
pub fn git_fetch(
    path: String,
    _history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    debug!(path = %path, "cmd::git_fetch");
    // fetch 只拉取远程引用，不修改工作区文件，无需打标签
    run_git_command(&path, &["fetch", "--all"])
}

// ============ Git Clone ============

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCloneProgress {
    phase: String,
    percent: Option<u8>,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneRequest {
    pub url: String,
    pub target_dir: String,
    pub folder_name: String,
    pub shallow: bool,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[tauri::command]
pub async fn git_clone(app_handle: AppHandle, request: GitCloneRequest) -> AppResult<String> {
    info!(url = %request.url, target_dir = %request.target_dir, "cmd::git_clone");
    validate_git_url(&request.url)?;
    validate_path(&request.target_dir)?;
    let clone_path = Path::new(&request.target_dir).join(&request.folder_name);

    if clone_path.exists() {
        return Err("Target directory already exists".into());
    }

    // 构建 git clone 参数
    let mut args: Vec<String> = vec!["clone".into(), "--progress".into()];
    if request.shallow {
        args.push("--depth".into());
        args.push("1".into());
    }

    // 处理认证 URL（HTTPS 场景）
    let effective_url = if let (Some(user), Some(pass)) = (&request.username, &request.password) {
        if !user.is_empty() && !pass.is_empty() {
            inject_credentials(&request.url, user, pass)
        } else {
            request.url.clone()
        }
    } else {
        request.url.clone()
    };

    args.push(effective_url);
    let clone_path_str = clone_path.to_string_lossy().to_string();
    args.push(clone_path_str.clone());

    // 使用 spawn + stderr pipe 执行 clone
    let mut child = Command::new("git")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // 后台线程读取 stderr 发送进度
    let stderr = child.stderr.take();
    let handle = app_handle.clone();
    let progress_thread = stderr.map(|mut stderr| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            // git progress 输出使用 \r 覆盖行，按字节读取
            loop {
                match stderr.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) => {
                        if byte[0] == b'\r' || byte[0] == b'\n' {
                            if !buf.is_empty() {
                                let line = String::from_utf8_lossy(&buf).to_string();
                                let progress = parse_git_progress(&line);
                                let _ = handle.emit_to(
                                    EventTarget::webview("main"),
                                    "git-clone-progress",
                                    progress,
                                );
                                buf.clear();
                            }
                        } else {
                            buf.push(byte[0]);
                        }
                    }
                    Err(_) => break,
                }
            }
            // 处理剩余数据
            if !buf.is_empty() {
                let line = String::from_utf8_lossy(&buf).to_string();
                let progress = parse_git_progress(&line);
                let _ =
                    handle.emit_to(EventTarget::webview("main"), "git-clone-progress", progress);
            }
        })
    });

    // 等待完成（5 分钟超时）
    let clone_timeout = std::time::Duration::from_secs(300);
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(s) => break s,
            None if start.elapsed() > clone_timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("git clone timed out (waited 5 minutes)".into());
            }
            None => std::thread::sleep(std::time::Duration::from_millis(200)),
        }
    };

    // 等待进度线程结束
    if let Some(thread) = progress_thread {
        let _ = thread.join();
    }

    if !status.success() {
        return Err("git clone failed, please check URL and credentials".into());
    }

    Ok(clone_path_str)
}

/// 将用户名密码嵌入 HTTPS URL
fn inject_credentials(url: &str, user: &str, pass: &str) -> String {
    if let Some(rest) = url.strip_prefix("https://") {
        let encoded_user = urlencoding::encode(user);
        let encoded_pass = urlencoding::encode(pass);
        format!("https://{}:{}@{}", encoded_user, encoded_pass, rest)
    } else {
        url.to_string()
    }
}

/// 解析 git clone --progress 输出中的进度信息
fn parse_git_progress(line: &str) -> GitCloneProgress {
    let line = line.trim();
    // git 输出格式: "Receiving objects:  45% (123/274)"
    let mut phase = String::new();
    let mut percent: Option<u8> = None;

    if let Some(colon_pos) = line.find(':') {
        phase = line[..colon_pos].trim().to_lowercase();
        let rest = &line[colon_pos + 1..];
        // 尝试提取百分比
        if let Some(pct_pos) = rest.find('%') {
            let num_str = rest[..pct_pos].trim();
            if let Ok(p) = num_str.parse::<u8>() {
                percent = Some(p);
            }
        }
    }

    if phase.is_empty() {
        phase = "cloning".to_string();
    }

    GitCloneProgress {
        phase,
        percent,
        message: line.to_string(),
    }
}

/// 获取项目中所有文件的 Git 状态（用于文件树着色）
#[tauri::command]
pub fn get_git_file_statuses(path: String) -> AppResult<HashMap<String, String>> {
    validate_path(&path)?;
    let project_path = Path::new(&path);
    if !project_path.exists() {
        return Ok(HashMap::new());
    }

    let output = output_with_timeout(
        Command::new("git")
            .args(["status", "--porcelain", "-unormal"])
            .current_dir(project_path),
        GIT_LOCAL_TIMEOUT,
    )?;

    if !output.status.success() {
        return Ok(HashMap::new());
    }

    let mut map = HashMap::new();
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let status_code = &line[..2];
        let file_path = line[3..].trim();
        // 处理重命名情况: "R  old -> new"
        let actual_path = if let Some(arrow_pos) = file_path.find(" -> ") {
            &file_path[arrow_pos + 4..]
        } else {
            file_path
        };
        let abs = project_path.join(actual_path);
        let abs_str = abs.to_string_lossy().to_string();
        let status = match status_code.trim() {
            "M" | "MM" => "modified",
            "A" | "AM" => "added",
            "D" => "deleted",
            "R" | "RM" => "renamed",
            "??" => "untracked",
            s if s.ends_with('M') => "modified",
            s if s.ends_with('D') => "deleted",
            _ => "modified",
        };
        map.insert(abs_str, status.to_string());
    }
    Ok(map)
}

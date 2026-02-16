use crate::services::HistoryService;
use crate::utils::AppResult;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// 获取项目的 Git 分支名
#[tauri::command]
pub fn get_git_branch(path: String) -> Option<String> {
    let project_path = Path::new(&path);
    if !project_path.exists() {
        return None;
    }

    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(project_path)
        .output()
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string();
        if branch.is_empty() {
            None
        } else {
            Some(branch)
        }
    } else {
        None
    }
}

/// 获取项目的 Git 状态（是否有未提交的更改）
#[tauri::command]
pub fn get_git_status(path: String) -> Option<bool> {
    let project_path = Path::new(&path);
    if !project_path.exists() {
        return None;
    }

    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(project_path)
        .output()
        .ok()?;

    if output.status.success() {
        let status = String::from_utf8_lossy(&output.stdout);
        Some(!status.trim().is_empty())
    } else {
        None
    }
}

/// 执行 Git 命令并返回结果
fn run_git_command(path: &str, args: &[&str]) -> AppResult<String> {
    let project_path = Path::new(path);
    if !project_path.exists() {
        return Err("路径不存在".into());
    }

    let output = Command::new("git")
        .args(args)
        .current_dir(project_path)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(if stdout.is_empty() { "操作成功".to_string() } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr }.into())
    }
}

/// Git 操作前自动打标签的辅助函数
fn auto_label_before_git(
    history_service: &HistoryService,
    path: &str,
    operation: &str,
) {
    let label_name = format!("Before Git {}", operation);
    let _ = history_service.create_auto_label(
        Path::new(path),
        &label_name,
        "git_commit",
    );
}

#[tauri::command]
pub fn git_pull(
    path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    auto_label_before_git(&history_service, &path, "Pull");
    run_git_command(&path, &["pull"])
}

#[tauri::command]
pub fn git_push(
    path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    auto_label_before_git(&history_service, &path, "Push");
    run_git_command(&path, &["push"])
}

#[tauri::command]
pub fn git_stash(
    path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    auto_label_before_git(&history_service, &path, "Stash");
    run_git_command(&path, &["stash"])
}

#[tauri::command]
pub fn git_stash_pop(
    path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    auto_label_before_git(&history_service, &path, "Stash Pop");
    run_git_command(&path, &["stash", "pop"])
}

#[tauri::command]
pub fn git_fetch(
    path: String,
    _history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
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
pub async fn git_clone(
    app_handle: AppHandle,
    request: GitCloneRequest,
) -> AppResult<String> {
    let clone_path = Path::new(&request.target_dir).join(&request.folder_name);

    if clone_path.exists() {
        return Err("目标目录已存在".into());
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
    let progress_thread = if let Some(mut stderr) = stderr {
        Some(std::thread::spawn(move || {
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
                                let _ = handle.emit("git-clone-progress", progress);
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
                let _ = handle.emit("git-clone-progress", progress);
            }
        }))
    } else {
        None
    };

    // 等待完成
    let status = child.wait()?;

    // 等待进度线程结束
    if let Some(thread) = progress_thread {
        let _ = thread.join();
    }

    if !status.success() {
        return Err("git clone 失败，请检查 URL 和认证信息".into());
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

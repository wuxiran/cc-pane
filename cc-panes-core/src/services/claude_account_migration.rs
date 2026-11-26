//! 切换 rec（reclaude）账号后，把 Claude 会话的 transcript 复制到当前账号目录，
//! 让重启后的 `claude --resume <uuid>` 在新账号下也能续接原对话。
//!
//! rec 的布局：`~/.rec/claude/current` 存当前账号 id，每个账号的 Claude 配置目录是
//! `~/.rec/claude/accounts/<id>/config`，transcript 在 `<config>/projects/<项目目录>/<uuid>.jsonl`，
//! 子 agent 记录在同级的 `<uuid>/` 目录。各账号的 `projects/` 互不相通。
//!
//! 只复制不移动：旧账号保留原件，复制失败也不会丢对话。

use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::usage_stats_service::claude_project_roots;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptMigrationStatus {
    /// 已从别的账号复制到当前账号。
    Copied,
    /// 当前账号下已有（且不比源文件旧），无需复制。
    AlreadyPresent,
    /// 所有账号目录里都找不到这个会话，重启后将是新对话。
    NotFound,
    /// id 不合法（防路径穿越）。
    InvalidId,
    /// 复制出错。
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMigrationResult {
    pub resume_id: String,
    pub status: TranscriptMigrationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareClaudeRelaunchResult {
    /// rec 当前账号 id；未安装 rec 时为 None（此时不做迁移，退化为普通重启）。
    pub account_id: Option<String>,
    pub results: Vec<TranscriptMigrationResult>,
}

/// rec 的根目录 `~/.rec/claude`。
fn rec_claude_root(home: &Path) -> PathBuf {
    home.join(".rec").join("claude")
}

/// 读取 rec 当前账号：返回 (账号 id, 该账号的 Claude 配置目录)。
pub fn current_rec_account(home: &Path) -> Option<(String, PathBuf)> {
    let root = rec_claude_root(home);
    let id = fs::read_to_string(root.join("current")).ok()?;
    let id = id.trim();
    if id.is_empty() || !is_safe_component(id) {
        return None;
    }
    let config_dir = root.join("accounts").join(id).join("config");
    config_dir.is_dir().then(|| (id.to_string(), config_dir))
}

/// 只允许 uuid / 账号 id 这类单段名字，防止 `..`、分隔符造成路径穿越。
fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 在若干 `projects/` 根下找 `<项目目录>/<uuid>.jsonl`（只扫一层项目目录）。
fn find_transcript(roots: &[PathBuf], resume_id: &str, skip_root: &Path) -> Option<PathBuf> {
    let file_name = format!("{resume_id}.jsonl");
    for root in roots {
        if root == skip_root {
            continue;
        }
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join(&file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            // 目标里已有且不旧的文件保留（可能是新账号下续写过的）。
            let keep_existing = match (modified(&target), modified(&entry.path())) {
                (Some(dst_time), Some(src_time)) => dst_time >= src_time,
                _ => false,
            };
            if !keep_existing {
                fs::copy(entry.path(), &target)?;
            }
        }
    }
    Ok(())
}

/// 把 `source`（`<projects>/<proj>/<uuid>.jsonl`）及同名子目录复制到 `target_projects/<proj>/`。
fn copy_transcript(source: &Path, target_projects: &Path) -> io::Result<bool> {
    let project_dir_name = source.parent().and_then(Path::file_name).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "transcript has no project dir")
    })?;
    let file_name = source.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "transcript has no file name")
    })?;
    let target_dir = target_projects.join(project_dir_name);
    let target = target_dir.join(file_name);

    let copied = match (modified(&target), modified(source)) {
        (Some(dst_time), Some(src_time)) if dst_time >= src_time => false,
        _ => {
            fs::create_dir_all(&target_dir)?;
            fs::copy(source, &target)?;
            true
        }
    };

    if let Some(stem) = source.file_stem() {
        let side_dir = source.with_file_name(stem);
        if side_dir.is_dir() {
            copy_dir_recursive(&side_dir, &target_dir.join(stem))?;
        }
    }
    Ok(copied)
}

/// 把一批 Claude 会话的 transcript 迁到 `target_config_dir`（某个账号的 Claude 配置目录）。
pub fn migrate_transcripts(
    home: &Path,
    resume_ids: &[String],
    target_config_dir: &Path,
) -> Vec<TranscriptMigrationResult> {
    let target_projects = target_config_dir.join("projects");
    let roots = claude_project_roots(home, None, None);
    resume_ids
        .iter()
        .map(|resume_id| {
            let resume_id = resume_id.trim().to_string();
            let result =
                |status, source: Option<&Path>, error: Option<String>| TranscriptMigrationResult {
                    resume_id: resume_id.clone(),
                    status,
                    source: source.map(|p| p.display().to_string()),
                    error,
                };
            if !is_safe_component(&resume_id) {
                return result(TranscriptMigrationStatus::InvalidId, None, None);
            }
            let in_target = find_transcript(
                std::slice::from_ref(&target_projects),
                &resume_id,
                Path::new(""),
            );
            let source = find_transcript(&roots, &resume_id, &target_projects);
            match (source, in_target) {
                (None, Some(_)) => result(TranscriptMigrationStatus::AlreadyPresent, None, None),
                (None, None) => result(TranscriptMigrationStatus::NotFound, None, None),
                (Some(source), _) => match copy_transcript(&source, &target_projects) {
                    Ok(true) => result(TranscriptMigrationStatus::Copied, Some(&source), None),
                    Ok(false) => result(
                        TranscriptMigrationStatus::AlreadyPresent,
                        Some(&source),
                        None,
                    ),
                    Err(error) => result(
                        TranscriptMigrationStatus::Failed,
                        Some(&source),
                        Some(error.to_string()),
                    ),
                },
            }
        })
        .collect()
}

/// 重启 Claude 会话前调用：读取 rec 当前账号，把这些会话的 transcript 复制过去。
pub fn prepare_claude_relaunch(resume_ids: &[String]) -> PrepareClaudeRelaunchResult {
    let Some(home) = dirs::home_dir() else {
        return PrepareClaudeRelaunchResult {
            account_id: None,
            results: Vec::new(),
        };
    };
    prepare_claude_relaunch_in(&home, resume_ids)
}

fn prepare_claude_relaunch_in(home: &Path, resume_ids: &[String]) -> PrepareClaudeRelaunchResult {
    match current_rec_account(home) {
        Some((account_id, config_dir)) => PrepareClaudeRelaunchResult {
            account_id: Some(account_id),
            results: migrate_transcripts(home, resume_ids, &config_dir),
        },
        None => PrepareClaudeRelaunchResult {
            account_id: None,
            results: Vec::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    const PROJ: &str = "-Users-me-proj";

    fn account_projects(home: &Path, id: &str) -> PathBuf {
        home.join(".rec/claude/accounts")
            .join(id)
            .join("config/projects")
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn setup() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(account_projects(home.path(), "old")).unwrap();
        fs::create_dir_all(account_projects(home.path(), "new")).unwrap();
        write(&home.path().join(".rec/claude/current"), "new\n");
        home
    }

    #[test]
    fn copies_transcript_and_subagents_to_current_account() {
        let home = setup();
        let old = account_projects(home.path(), "old").join(PROJ);
        write(&old.join("abc-1.jsonl"), "old-chat");
        write(&old.join("abc-1/subagents/a.jsonl"), "sub");

        let out = prepare_claude_relaunch_in(home.path(), &["abc-1".to_string()]);
        assert_eq!(out.account_id.as_deref(), Some("new"));
        assert_eq!(out.results[0].status, TranscriptMigrationStatus::Copied);

        let new = account_projects(home.path(), "new").join(PROJ);
        assert_eq!(
            fs::read_to_string(new.join("abc-1.jsonl")).unwrap(),
            "old-chat"
        );
        assert_eq!(
            fs::read_to_string(new.join("abc-1/subagents/a.jsonl")).unwrap(),
            "sub"
        );
        // 原件保留
        assert!(old.join("abc-1.jsonl").is_file());
    }

    #[test]
    fn already_present_only_in_target() {
        let home = setup();
        write(
            &account_projects(home.path(), "new")
                .join(PROJ)
                .join("abc-2.jsonl"),
            "x",
        );
        let out = prepare_claude_relaunch_in(home.path(), &["abc-2".to_string()]);
        assert_eq!(
            out.results[0].status,
            TranscriptMigrationStatus::AlreadyPresent
        );
    }

    #[test]
    fn does_not_overwrite_newer_target() {
        let home = setup();
        let src = account_projects(home.path(), "old")
            .join(PROJ)
            .join("abc-3.jsonl");
        let dst = account_projects(home.path(), "new")
            .join(PROJ)
            .join("abc-3.jsonl");
        write(&src, "old");
        write(&dst, "newer");
        let past = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&src)
            .unwrap()
            .set_modified(past)
            .unwrap();

        let out = prepare_claude_relaunch_in(home.path(), &["abc-3".to_string()]);
        assert_eq!(
            out.results[0].status,
            TranscriptMigrationStatus::AlreadyPresent
        );
        assert_eq!(fs::read_to_string(dst).unwrap(), "newer");
    }

    #[test]
    fn not_found_and_invalid_ids() {
        let home = setup();
        let out =
            prepare_claude_relaunch_in(home.path(), &["missing".to_string(), "../etc".to_string()]);
        assert_eq!(out.results[0].status, TranscriptMigrationStatus::NotFound);
        assert_eq!(out.results[1].status, TranscriptMigrationStatus::InvalidId);
    }

    #[test]
    fn no_rec_installed_skips_migration() {
        let home = tempfile::tempdir().unwrap();
        let out = prepare_claude_relaunch_in(home.path(), &["abc".to_string()]);
        assert!(out.account_id.is_none());
        assert!(out.results.is_empty());
    }
}

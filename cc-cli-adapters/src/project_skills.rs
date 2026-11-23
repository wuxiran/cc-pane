//! 项目级技能链接（docs/110 §7 #1）：把 CC-Panes 的技能逐个链接进
//! `<项目>/.agents/skills/<name>`，让只认原生技能目录的 CLI（Codex）真的看得到。
//!
//! 为什么不是 `-c skills.config=[...]`：codex 0.169.0 实测它不会把
//! `~/.codex/skills` 与项目 `.agents/skills` 之外的目录加进技能清单（四种路径形态都试过，
//! `codex debug prompt-input` 里看不到）；`.agents/skills` 里的符号链接它会跟随。
//! 写用户的 `~/.codex/skills` 违反 docs/97「零写入用户 CLI 主目录」，所以落在项目里，
//! 沿用批 2 项目文件的三件套：
//!
//! - **收据**：`<项目>/.ccpanes/.cache/skills-linked-<cli>.json` 记下我们建的每个链接（或
//!   复制）及其来源、我们建的目录、我们加的 exclude 行。只删收据里有、且**仍然是我们的**
//!   东西：链接仍指向收据里的来源；复制品内容指纹仍与建时一致。用户的同名目录 / 文件 /
//!   被改过的复制品一律不碰（跳过并 warn）。
//! - **排除**：逐个链接精确排除（`/.agents/skills/<name>`，不是整个 `.agents`——用户可能
//!   提交自己的 `.agents/skills`），已被 git 跟踪的名字不写。
//! - **租约**：每个会话一份（`<data>/cli-adapters/project-skill-leases/<session>.json`，
//!   记 CLI、项目、技能名），同项目并发会话共用链接；会话结束时只删没有其他有效租约
//!   要的链接，最后一个会话结束时全部清掉并收掉我们建的空目录。崩溃遗留的租约超过
//!   `project_mcp_files::LEASE_TTL` 就不再算数（与批 2 同一规则）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::project_mcp_files as files;
use crate::project_skill_leases::{
    lease_path, read_lease, skills_wanted_by_other_leases, write_lease,
};
use crate::skill_mounts::{self, LinkKind};

const AGENTS_DIR: &str = ".agents";
const SKILLS_DIR: &str = "skills";
const EXCLUDE_COMMENT: &str = "# CC-Panes: per-session skill links (docs/110), never commit";

/// 同进程内的同步 / 释放串行（同项目两个会话同时启动时不互相踩收据）。
static LOCK: Mutex<()> = Mutex::new(());

/// 收据里的一项：我们放进去的是什么。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkedEntry {
    Symlink {
        source: PathBuf,
    },
    /// 平台不让建链接（Windows 未开开发者模式）时的复制品；`fingerprint` 是建好时的内容指纹。
    Copy {
        source: PathBuf,
        fingerprint: String,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    /// 我们建的目录（相对项目根，深的在前）：最后只在为空时删除。
    #[serde(default)]
    created_dirs: Vec<String>,
    /// 我们追加进 `info/exclude` 的模式（用户原本就有的不在这里）。
    #[serde(default)]
    excludes: Vec<String>,
    #[serde(default)]
    entries: BTreeMap<String, LinkedEntry>,
}

/// [`sync_for_launch`] 的结果。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ProjectSkillsOutcome {
    /// 本次会话在项目里可见、且归我们管的技能名。
    pub linked: Vec<String>,
    /// 因同名用户内容 / 已被 git 跟踪 / 名字不安全而跳过的技能名。
    pub skipped: Vec<String>,
}

/// `<项目>/.ccpanes/.cache/skills-linked-<cli>.json`
pub fn receipt_path(project: &Path, cli_id: &str) -> PathBuf {
    project
        .join(".ccpanes")
        .join(".cache")
        .join(format!("skills-linked-{cli_id}.json"))
}

/// `<项目>/.agents/skills`
pub fn project_skills_dir(project: &Path) -> PathBuf {
    project.join(AGENTS_DIR).join(SKILLS_DIR)
}

/// adapter 入口：把挂载根里的技能链接进项目、记收据与租约。任何失败只 warn 不阻断启动。
/// 没有技能（挂载为空 = 启动档关掉了技能）时什么都不碰，也不记租约。
pub fn sync_for_launch(
    cli_id: &str,
    data_dir: &Path,
    session_id: &str,
    project: &Path,
    mounts: &[String],
) -> ProjectSkillsOutcome {
    let skills = skill_mounts::mount_skill_dirs(mounts);
    let Some(lease) = lease_path(data_dir, session_id) else {
        return ProjectSkillsOutcome::default();
    };
    if skills.is_empty() || !project.is_dir() {
        return ProjectSkillsOutcome::default();
    }
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut receipt = read_receipt(&receipt_path(project, cli_id));
    if let Err(error) = ensure_skills_dir(project, &mut receipt) {
        warn!(cli_id, project = %project.display(), %error, "project skills: cannot create .agents/skills");
        return ProjectSkillsOutcome::default();
    }
    let tracked = tracked_skill_names(project);
    let dir = project_skills_dir(project);
    let mut outcome = ProjectSkillsOutcome::default();
    for (name, source) in &skills {
        if link_one(&dir, name, source, &tracked, &mut receipt) {
            outcome.linked.push(name.clone());
        } else {
            outcome.skipped.push(name.clone());
        }
    }
    sync_excludes(project, &mut receipt);
    finish(project, cli_id, receipt);
    if !outcome.linked.is_empty() {
        write_lease(&lease, cli_id, project, &outcome.linked);
        info!(cli_id, linked = ?outcome.linked, skipped = ?outcome.skipped, "project skills linked");
    }
    outcome
}

/// 会话真正结束时调用：删掉本会话租约，再删掉没有其他有效租约需要的链接。
pub fn release_session(data_dir: &Path, session_id: &str) {
    let Some(path) = lease_path(data_dir, session_id) else {
        return;
    };
    let Some((cli_id, project, _)) = read_lease(&path) else {
        return;
    };
    let _ = fs::remove_file(&path);
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let keep = skills_wanted_by_other_leases(data_dir, &cli_id, &project);
    let mut receipt = read_receipt(&receipt_path(&project, &cli_id));
    let dir = project_skills_dir(&project);
    receipt.entries.retain(|name, entry| {
        if keep.contains(name) {
            return true;
        }
        let target = dir.join(name);
        if !is_ours(entry, &target) {
            warn!(skill = %name, path = %target.display(), "project skills: entry changed since we placed it, leaving it alone");
            return false;
        }
        match remove_entry(entry, &target) {
            Ok(()) => false,
            Err(error) => {
                warn!(skill = %name, %error, "project skills: failed to remove our link");
                true
            }
        }
    });
    sync_excludes(&project, &mut receipt);
    finish(&project, &cli_id, receipt);
}

fn ensure_skills_dir(project: &Path, receipt: &mut Receipt) -> io::Result<()> {
    for rel in [AGENTS_DIR.to_string(), format!("{AGENTS_DIR}/{SKILLS_DIR}")] {
        let path = project.join(&rel);
        if fs::symlink_metadata(&path).is_err() {
            fs::create_dir(&path)?;
            if !receipt.created_dirs.contains(&rel) {
                // 深的在前：删除时按顺序 remove_dir
                receipt.created_dirs.insert(0, rel);
            }
        }
    }
    if project_skills_dir(project).is_dir() {
        Ok(())
    } else {
        Err(io::Error::other(".agents/skills is not a directory"))
    }
}

/// 链接一个技能，返回它现在是否归我们管。
fn link_one(
    dir: &Path,
    name: &str,
    source: &Path,
    tracked: &BTreeSet<String>,
    receipt: &mut Receipt,
) -> bool {
    if !is_safe_name(name) {
        warn!(skill = %name, "project skills: unsafe skill name, skipped");
        return false;
    }
    if tracked.contains(name) {
        warn!(skill = %name, "project skills: path is tracked by git, skipped");
        return false;
    }
    let target = dir.join(name);
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            place(name, source, &target, receipt)
        }
        Err(error) => {
            warn!(skill = %name, %error, "project skills: cannot inspect target, skipped");
            false
        }
        Ok(_) => match receipt.entries.get(name).cloned() {
            Some(entry) if is_ours(&entry, &target) => {
                let stale_link =
                    matches!(&entry, LinkedEntry::Symlink { source: old } if old != source);
                if stale_link {
                    // 同名技能换了来源（换启动档 / 子集）：重指到本次的来源
                    if let Err(error) = remove_entry(&entry, &target) {
                        warn!(skill = %name, %error, "project skills: failed to re-point our link");
                        return true;
                    }
                    return place(name, source, &target, receipt);
                }
                true
            }
            Some(_) => {
                warn!(skill = %name, path = %target.display(), "project skills: our entry was replaced by the user, leaving it alone");
                receipt.entries.remove(name);
                false
            }
            None => {
                warn!(skill = %name, path = %target.display(), "project skills: name collides with user content, skipped");
                false
            }
        },
    }
}

fn place(name: &str, source: &Path, target: &Path, receipt: &mut Receipt) -> bool {
    match skill_mounts::link_or_copy_dir(source, target) {
        Ok(LinkKind::Symlink) => {
            let source = source.to_path_buf();
            receipt
                .entries
                .insert(name.to_string(), LinkedEntry::Symlink { source });
            true
        }
        Ok(LinkKind::Copy) => {
            let entry = LinkedEntry::Copy {
                source: source.to_path_buf(),
                fingerprint: fingerprint(target),
            };
            receipt.entries.insert(name.to_string(), entry);
            true
        }
        Err(error) => {
            // 目标原本不存在，复制到一半的残留是我们的，删掉
            let _ = fs::remove_dir_all(target);
            warn!(skill = %name, %error, "project skills: failed to link or copy");
            false
        }
    }
}

/// 收据里的这一项是否仍然原样是我们放的。
fn is_ours(entry: &LinkedEntry, target: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(target) else {
        return false;
    };
    match entry {
        LinkedEntry::Symlink { source } => {
            meta.file_type().is_symlink()
                && fs::read_link(target).is_ok_and(|actual| &actual == source)
        }
        LinkedEntry::Copy {
            fingerprint: fp, ..
        } => meta.is_dir() && &fingerprint(target) == fp,
    }
}

fn remove_entry(entry: &LinkedEntry, target: &Path) -> io::Result<()> {
    match entry {
        LinkedEntry::Copy { .. } => fs::remove_dir_all(target),
        // 只删链接本身，不跟随到来源
        #[cfg(windows)]
        LinkedEntry::Symlink { .. } => fs::remove_dir(target).or_else(|_| fs::remove_file(target)),
        #[cfg(not(windows))]
        LinkedEntry::Symlink { .. } => fs::remove_file(target),
    }
}

/// 名字只允许字母数字与 `-_.`、不以 `.` 开头：既是安全的路径段，也不含 gitignore 通配符。
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

/// 复制品的内容指纹：按相对路径排序的 (路径, 字节) 做 FNV-1a 64。不是安全哈希，
/// 只用来判断「复制品被人改过没有」。
fn fingerprint(root: &Path) -> String {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = format!("{rel}/{}", entry.file_name().to_string_lossy());
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => walk(&entry.path(), &name, out),
                Ok(_) => out.push((name, fs::read(entry.path()).unwrap_or_default())),
                Err(_) => {}
            }
        }
    }
    let mut files = Vec::new();
    walk(root, "", &mut files);
    files.sort();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (name, bytes) in &files {
        for byte in name
            .bytes()
            .chain([0])
            .chain(bytes.iter().copied())
            .chain([0])
        {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("fnv1a64:{hash:016x}:{}", files.len())
}

/// 仓库里已被跟踪的 `.agents/skills/<name>`（一次 `git ls-files`）。不是仓库时为空。
fn tracked_skill_names(project: &Path) -> BTreeSet<String> {
    let rel = format!("{AGENTS_DIR}/{SKILLS_DIR}");
    let Some(output) = files::git(project, &["ls-files", "-z", "--", &rel])
        .filter(|output| output.status.success())
    else {
        return BTreeSet::new();
    };
    let prefix = format!("{rel}/");
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|path| std::str::from_utf8(path).ok())
        .filter_map(|path| path.strip_prefix(&prefix))
        .filter_map(|rest| rest.split('/').next())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// exclude 与收据对齐：每个归我们管的链接一行；不再归我们管的、我们加过的行删掉。
fn sync_excludes(project: &Path, receipt: &mut Receipt) {
    let Some((prefix, exclude)) = files::git_exclude_location(project) else {
        return;
    };
    let pattern = |name: &str| format!("/{prefix}{AGENTS_DIR}/{SKILLS_DIR}/{name}");
    let wanted: Vec<String> = receipt.entries.keys().map(|name| pattern(name)).collect();
    let (stale, kept): (Vec<String>, Vec<String>) = std::mem::take(&mut receipt.excludes)
        .into_iter()
        .partition(|line| !wanted.contains(line));
    let comment = kept.is_empty().then_some(EXCLUDE_COMMENT);
    if !stale.is_empty() {
        files::remove_exclude_patterns(&exclude, &stale, comment);
    }
    receipt.excludes = kept;
    let added = files::add_exclude_patterns(&exclude, &wanted, EXCLUDE_COMMENT);
    receipt.excludes.extend(added);
}

/// 收据落盘；收据空了就收掉我们建的空目录并删掉收据。
fn finish(project: &Path, cli_id: &str, mut receipt: Receipt) {
    let path = receipt_path(project, cli_id);
    if receipt.entries.is_empty() {
        for rel in std::mem::take(&mut receipt.created_dirs) {
            // remove_dir 只删空目录：用户放了东西进去就留着（从此归用户）
            let _ = fs::remove_dir(project.join(rel));
        }
        if path.exists() {
            if let Err(error) = fs::remove_file(&path) {
                warn!(file = %path.display(), %error, "project skills: failed to remove receipt");
            }
        }
        return;
    }
    let written = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| {
            crate::mcp_file_injection::ensure_ccpanes_gitignore(project);
            let body = serde_json::to_string_pretty(&receipt).map_err(io::Error::other)?;
            crate::fs_atomic::write_atomic(&path, body).map_err(io::Error::other)
        });
    if let Err(error) = written {
        warn!(file = %path.display(), %error, "project skills: failed to write receipt");
    }
}

fn read_receipt(path: &Path) -> Receipt {
    let Ok(text) = fs::read_to_string(path) else {
        return Receipt::default();
    };
    serde_json::from_str(&text).unwrap_or_else(|error| {
        // 损坏 → 视为空：项目里的东西全按用户所有处理（宁可留残留，也不删可能是用户的数据）
        warn!(receipt = %path.display(), %error, "project skills: receipt is corrupt, treating everything as user-owned");
        Receipt::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_entries_are_ours_only_while_contents_match() {
        let temp = tempfile::tempdir().unwrap();
        let copy = temp.path().join("copy");
        fs::create_dir_all(&copy).unwrap();
        fs::write(copy.join("SKILL.md"), "body").unwrap();
        let entry = LinkedEntry::Copy {
            source: temp.path().join("src"),
            fingerprint: fingerprint(&copy),
        };
        assert!(is_ours(&entry, &copy));
        fs::write(copy.join("SKILL.md"), "edited by the user").unwrap();
        assert!(!is_ours(&entry, &copy));
        fs::write(copy.join("SKILL.md"), "body").unwrap();
        fs::write(copy.join("notes.md"), "added by the user").unwrap();
        assert!(!is_ours(&entry, &copy));
        fs::remove_file(copy.join("notes.md")).unwrap();
        remove_entry(&entry, &copy).unwrap();
        assert!(!copy.exists());
    }

    #[test]
    fn unsafe_names_are_rejected() {
        for bad in ["", ".hidden", "a/b", "a\\b", "x*", "has space", "!neg"] {
            assert!(!is_safe_name(bad), "{bad}");
        }
        assert!(is_safe_name("ccpanes-plan_v2.1"));
    }
}

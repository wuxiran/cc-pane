//! 把默认目录里的设置、技能、指令文件链接进账号目录。
//!
//! 策略：
//! - Unix：一律软链接（文件和目录）。
//! - Windows：目录先试软链接，不行（没开开发者模式 / 没提权）改用目录联接（junction）；
//!   文件先试软链接，不行就**复制**（复制是快照：之后默认目录里再改不会跟过来，
//!   账号里的那份从此归这个账号自己）。
//! - 默认目录里没有的条目不创建。账号目录里已有的真实文件 / 非空目录不动
//!   （那是这个账号自己的），只有空目录占位和指向别处已失效的链接会被替换。

use super::layout::LoginCliLayout;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;

/// 一个条目是怎么进到账号目录里的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkMode {
    Symlink,
    Junction,
    Copy,
}

/// 一次同步后某个条目的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedEntryState {
    /// 相对账号目录的路径。
    pub path: String,
    pub state: SharedEntryOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SharedEntryOutcome {
    /// 已链接到默认目录（软链接或目录联接）。
    Linked,
    /// Windows 上文件软链接不可用，复制了一份。
    Copied,
    /// 默认目录里没有，什么都没建。
    SourceMissing,
    /// 账号目录里已有自己的一份，保持不动。
    KeptLocal,
    /// 链接失败（原因进日志），不影响其他条目。
    Failed,
}

/// 把 `layout.shared` 里的条目从 `default_dir` 链接进 `account_dir`。逐条尽力而为。
pub fn sync_shared_entries(
    layout: &LoginCliLayout,
    default_dir: &Path,
    account_dir: &Path,
) -> Vec<SharedEntryState> {
    layout
        .shared
        .iter()
        .map(|rel| {
            let source = default_dir.join(rel);
            let target = account_dir.join(rel);
            let state = match sync_entry(&source, &target) {
                Ok(state) => state,
                Err(error) => {
                    tracing::warn!(
                        cli = layout.cli_tool,
                        entry = rel,
                        error = %error,
                        "login account: failed to link a shared entry"
                    );
                    SharedEntryOutcome::Failed
                }
            };
            SharedEntryState {
                path: (*rel).to_string(),
                state,
            }
        })
        .collect()
}

fn sync_entry(source: &Path, target: &Path) -> io::Result<SharedEntryOutcome> {
    // 账号目录和默认目录是同一个（不该发生）：绝不自己链接自己。
    if same_path(source, target) {
        return Ok(SharedEntryOutcome::KeptLocal);
    }
    let source_meta = fs::metadata(source).ok();
    let target_meta = fs::symlink_metadata(target).ok();

    let Some(source_meta) = source_meta else {
        // 默认目录里没有：不凭空创建；之前留下的失效链接顺手清掉。
        if target_meta.as_ref().is_some_and(is_link) && fs::metadata(target).is_err() {
            remove_link(target)?;
        }
        return Ok(SharedEntryOutcome::SourceMissing);
    };

    if let Some(target_meta) = target_meta {
        if is_link(&target_meta) {
            if link_points_to(target, source) {
                return Ok(SharedEntryOutcome::Linked);
            }
            if fs::metadata(target).is_ok() {
                // 指向别处且有效：用户自己安排的，不动。
                return Ok(SharedEntryOutcome::KeptLocal);
            }
            remove_link(target)?;
        } else if target_meta.is_dir() {
            // 空目录是 CLI 启动时自己建的占位；`remove_dir` 对非空目录会失败，
            // 所以账号里已有的内容永远不会被删。
            if fs::remove_dir(target).is_err() {
                return Ok(SharedEntryOutcome::KeptLocal);
            }
        } else {
            return Ok(SharedEntryOutcome::KeptLocal);
        }
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(match link(source, target, source_meta.is_dir())? {
        LinkMode::Copy => SharedEntryOutcome::Copied,
        LinkMode::Symlink | LinkMode::Junction => SharedEntryOutcome::Linked,
    })
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    let reparse_point = {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    };
    #[cfg(not(windows))]
    let reparse_point = false;
    meta.file_type().is_symlink() || reparse_point
}

fn link_points_to(link: &Path, source: &Path) -> bool {
    let Ok(raw) = fs::read_link(link) else {
        return false;
    };
    let resolved = if raw.is_absolute() {
        raw
    } else {
        link.parent().map(|dir| dir.join(&raw)).unwrap_or(raw)
    };
    same_path(&resolved, source)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (fs::canonicalize(a), fs::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

fn remove_link(link: &Path) -> io::Result<()> {
    // Windows 上指向目录的链接 / 联接要用 remove_dir。
    fs::remove_file(link).or_else(|_| fs::remove_dir(link))
}

#[cfg(unix)]
fn link(source: &Path, target: &Path, _is_dir: bool) -> io::Result<LinkMode> {
    std::os::unix::fs::symlink(source, target)?;
    Ok(LinkMode::Symlink)
}

// Windows 专用：这台机器（macOS）编不了，未编译验证。
#[cfg(windows)]
fn link(source: &Path, target: &Path, is_dir: bool) -> io::Result<LinkMode> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    if is_dir {
        if symlink_dir(source, target).is_ok() {
            return Ok(LinkMode::Symlink);
        }
        // 目录联接不需要提权，也不需要开发者模式。
        let status = cc_cli_adapters::no_window_command("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(target)
            .arg(source)
            .status()?;
        if status.success() {
            return Ok(LinkMode::Junction);
        }
        return Err(io::Error::other(
            "failed to create a directory junction for a shared entry",
        ));
    }
    if symlink_file(source, target).is_ok() {
        return Ok(LinkMode::Symlink);
    }
    fs::copy(source, target)?;
    Ok(LinkMode::Copy)
}

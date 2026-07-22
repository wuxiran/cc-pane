//! Local History 的轮询扫描器（Windows 专用路径的纯函数部分）。
//!
//! Windows 上 `RecommendedWatcher`（`ReadDirectoryChangesW`）会持有被监视目录的
//! 句柄，导致外部工具无法删除/重命名项目根目录（PR #35）。直接换 `PollWatcher`
//! 又无法跳过目录——node_modules/target 里几十万文件每轮全量 stat。
//!
//! 这里的做法：无句柄地 `read_dir` 递归遍历，用 Local History 已有的
//! `ignore_patterns` 在**遍历时剪枝**（命中目录整棵跳过），每轮只 stat 真实
//! 源码文件；快照 diff 出新增/修改/删除，投递进现有事件管道。下游
//! `process_file_changed/removed` 会再做一次 ignore/大小/二进制过滤，
//! 因此这里的剪枝纯粹是性能优化，漏剪不影响正确性。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 文件指纹：(mtime, len)。mtime 个别文件系统可能取不到，退化为只比长度。
pub type FileStamp = (Option<SystemTime>, u64);

/// 一轮扫描的快照：绝对路径 -> 指纹
pub type ScanSnapshot = HashMap<PathBuf, FileStamp>;

/// 两轮快照的差异
#[derive(Debug, Default)]
pub struct SnapshotDiff {
    /// 新增或内容变化的文件
    pub changed: Vec<PathBuf>,
    /// 上一轮存在、本轮消失的文件
    pub removed: Vec<PathBuf>,
}

/// 遍历项目目录生成快照。
///
/// - `should_ignore` 接收 `/` 分隔的相对路径；目录命中则整棵子树跳过（剪枝）。
/// - `.git` 无条件跳过（分支检测单独读 `.git/HEAD`，不依赖遍历）。
/// - 符号链接不跟随：防环，且下游本就有 canonicalize 越界保护。
pub fn scan_project(root: &Path, should_ignore: &dyn Fn(&str) -> bool) -> ScanSnapshot {
    let mut snapshot = ScanSnapshot::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue; // 目录消失或无权限：跳过，删除由快照 diff 体现
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative_str = relative.to_string_lossy().replace('\\', "/");
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if relative_str == ".git" || should_ignore(&relative_str) {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() {
                if should_ignore(&relative_str) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                snapshot.insert(path, (meta.modified().ok(), meta.len()));
            }
        }
    }

    snapshot
}

/// 对比两轮快照，得出变化与删除的文件。
pub fn diff_snapshots(prev: &ScanSnapshot, next: &ScanSnapshot) -> SnapshotDiff {
    let mut diff = SnapshotDiff::default();
    for (path, stamp) in next {
        match prev.get(path) {
            Some(prev_stamp) if prev_stamp == stamp => {}
            _ => diff.changed.push(path.clone()),
        }
    }
    for path in prev.keys() {
        if !next.contains_key(path) {
            diff.removed.push(path.clone());
        }
    }
    diff
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn ignore_node_modules(rel: &str) -> bool {
        rel == "node_modules" || rel.starts_with("node_modules/")
    }

    #[test]
    fn scan_prunes_ignored_directories_entirely() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "src/main.rs", "fn main() {}");
        write(root, "node_modules/pkg/index.js", "x");
        write(root, ".git/HEAD", "ref: refs/heads/main");

        let snapshot = scan_project(root, &ignore_node_modules);

        let rels: Vec<String> = snapshot
            .keys()
            .map(|p| {
                p.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(rels, vec!["src/main.rs".to_string()]);
    }

    #[test]
    fn diff_detects_added_modified_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "a.txt", "one");
        write(root, "b.txt", "two");
        let prev = scan_project(root, &|_| false);

        // 修改 a、删除 b、新增 c。长度变化保证即使 mtime 分辨率粗也能测出。
        write(root, "a.txt", "one-changed");
        fs::remove_file(root.join("b.txt")).unwrap();
        write(root, "c.txt", "three");
        let next = scan_project(root, &|_| false);

        let mut diff = diff_snapshots(&prev, &next);
        diff.changed.sort();
        assert_eq!(diff.changed, vec![root.join("a.txt"), root.join("c.txt")]);
        assert_eq!(diff.removed, vec![root.join("b.txt")]);
    }

    #[test]
    fn diff_is_empty_when_nothing_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "a.txt", "one");
        let prev = scan_project(root, &|_| false);
        let next = scan_project(root, &|_| false);
        let diff = diff_snapshots(&prev, &next);
        assert!(diff.changed.is_empty() && diff.removed.is_empty());
    }

    #[test]
    fn ignored_file_changes_produce_no_diff() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "src/lib.rs", "pub fn f() {}");
        write(root, "node_modules/pkg/index.js", "x");
        let prev = scan_project(root, &ignore_node_modules);

        write(root, "node_modules/pkg/index.js", "x-changed-longer");
        let next = scan_project(root, &ignore_node_modules);

        let diff = diff_snapshots(&prev, &next);
        assert!(diff.changed.is_empty() && diff.removed.is_empty());
    }
}

//! Local History 端到端集成测试
//!
//! 测试 HistoryService + HistoryFileRepository 与文件系统 (SQLite + blobs) 的完整流程

use cc_panes_lib::models::HistoryLabel;
use cc_panes_lib::repository::HistoryFileRepository;
use cc_panes_lib::services::HistoryService;
use std::path::PathBuf;

/// 创建临时项目目录，模拟 .git/HEAD 以提供分支名
fn setup_project() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let project_path = dir.path().to_path_buf();
    // 模拟 Git 仓库
    let git_dir = project_path.join(".git");
    std::fs::create_dir_all(&git_dir).unwrap();
    std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    (dir, project_path)
}

/// 创建 HistoryService 并初始化项目仓库（不启动 watcher）
fn setup() -> (tempfile::TempDir, PathBuf, HistoryService) {
    let (dir, project_path) = setup_project();
    let service = HistoryService::new();
    // 初始化仓库（创建 .ccpanes/history 目录和 SQLite DB）
    let repo = HistoryFileRepository::open(&project_path).unwrap();
    repo.init_history_dir().unwrap();
    drop(repo);
    // 让 HistoryService 缓存仓库实例
    service.list_versions(&project_path, "dummy").ok();
    (dir, project_path, service)
}

// ============ 1. 版本保存与查询 ============

#[test]
fn test_save_and_list_versions() {
    let (_dir, project_path, service) = setup();

    // 保存版本
    let repo = HistoryFileRepository::open(&project_path).unwrap();
    let v1 = repo
        .save_version("src/main.rs", b"fn main() {}", false, "main", 0)
        .unwrap()
        .unwrap();
    let v2 = repo
        .save_version(
            "src/main.rs",
            b"fn main() { println!(\"hello\"); }",
            false,
            "main",
            0,
        )
        .unwrap()
        .unwrap();
    drop(repo);

    // 通过 HistoryService 查询
    let versions = service.list_versions(&project_path, "src/main.rs").unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].id, v1.id);
    assert_eq!(versions[1].id, v2.id);
    assert_eq!(versions[0].file_path, "src/main.rs");
    assert_eq!(versions[1].branch, "main");

    // 获取版本内容
    let content = service
        .get_version_content(&project_path, "src/main.rs", &v1.id)
        .unwrap();
    assert_eq!(content, b"fn main() {}");

    let content2 = service
        .get_version_content(&project_path, "src/main.rs", &v2.id)
        .unwrap();
    assert_eq!(content2, b"fn main() { println!(\"hello\"); }");
}

#[test]
fn test_version_content_dedup() {
    let (_dir, project_path, _service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();

    // 同内容同分支 - 应去重返回 None
    let v1 = repo
        .save_version("f.txt", b"hello", false, "main", 0)
        .unwrap();
    assert!(v1.is_some());

    let v2 = repo
        .save_version("f.txt", b"hello", false, "main", 0)
        .unwrap();
    assert!(v2.is_none()); // 去重

    // 不同内容 - 应保存
    let v3 = repo
        .save_version("f.txt", b"world", false, "main", 0)
        .unwrap();
    assert!(v3.is_some());

    let versions = repo.list_versions("f.txt").unwrap();
    assert_eq!(versions.len(), 2);
}

// ============ 2. Diff 流程 ============

#[test]
fn test_diff_between_versions() {
    let (_dir, project_path, service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    let v1 = repo
        .save_version("a.txt", b"line1\nline2\nline3\n", false, "main", 0)
        .unwrap()
        .unwrap();
    let v2 = repo
        .save_version("a.txt", b"line1\nmodified\nline3\n", false, "main", 0)
        .unwrap()
        .unwrap();
    drop(repo);

    // 两版本之间的 diff
    let diff = service
        .get_versions_diff(&project_path, "a.txt", &v1.id, &v2.id)
        .unwrap();

    assert!(!diff.is_binary);
    assert!(!diff.truncated);
    assert!(!diff.hunks.is_empty());
    // line2 -> modified = 1 deletion + 1 addition
    assert_eq!(diff.stats.deletions, 1);
    assert_eq!(diff.stats.additions, 1);
    assert_eq!(diff.stats.changes, 1);
}

#[test]
fn test_diff_with_current_file() {
    let (dir, project_path, service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    let v = repo
        .save_version("test.txt", b"old content\n", false, "main", 0)
        .unwrap()
        .unwrap();
    drop(repo);

    // 写一个当前文件
    std::fs::write(dir.path().join("test.txt"), "new content\n").unwrap();

    let diff = service
        .get_version_diff(&project_path, "test.txt", &v.id)
        .unwrap();
    assert!(!diff.hunks.is_empty());
    assert_eq!(diff.stats.additions, 1);
    assert_eq!(diff.stats.deletions, 1);
}

// ============ 3. 标签流程 ============

#[test]
fn test_label_crud_flow() {
    let (_dir, project_path, service) = setup();

    // 先保存一些版本
    let repo = HistoryFileRepository::open(&project_path).unwrap();
    let v = repo
        .save_version("src/lib.rs", b"pub fn hello() {}", false, "main", 0)
        .unwrap()
        .unwrap();
    drop(repo);

    // 创建标签
    let label = HistoryLabel {
        id: "label-test-1".to_string(),
        name: "Release v1.0".to_string(),
        label_type: "manual".to_string(),
        source: "user".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        file_snapshots: vec![cc_panes_lib::models::LabelFileSnapshot {
            file_path: "src/lib.rs".to_string(),
            version_id: v.id.clone(),
        }],
        branch: "main".to_string(),
    };
    service.put_label(&project_path, &label).unwrap();

    // 列出标签
    let labels = service.list_labels(&project_path).unwrap();
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0].name, "Release v1.0");
    assert_eq!(labels[0].label_type, "manual");
    assert_eq!(labels[0].source, "user");
    assert_eq!(labels[0].branch, "main");
    assert_eq!(labels[0].file_snapshots.len(), 1);
    assert_eq!(labels[0].file_snapshots[0].file_path, "src/lib.rs");

    // 删除标签
    service.delete_label(&project_path, "label-test-1").unwrap();
    let labels = service.list_labels(&project_path).unwrap();
    assert!(labels.is_empty());
}

#[test]
fn test_create_auto_label() {
    let (_dir, project_path, service) = setup();

    // 保存版本以创建快照
    let repo = HistoryFileRepository::open(&project_path).unwrap();
    repo.save_version("file.rs", b"content-a", false, "main", 0)
        .unwrap();
    repo.save_version("util.rs", b"content-b", false, "main", 0)
        .unwrap();
    drop(repo);

    // 重新打开让 service 感知
    let label_id = service
        .create_auto_label(&project_path, "Pre-Deploy", "ci")
        .unwrap();
    assert!(!label_id.is_empty());

    let labels = service.list_labels(&project_path).unwrap();
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0].name, "Pre-Deploy");
    assert_eq!(labels[0].label_type, "auto");
    assert_eq!(labels[0].source, "ci");
    // 应包含 2 个文件快照
    assert_eq!(labels[0].file_snapshots.len(), 2);
}

// ============ 4. 清理流程 ============

#[test]
fn test_cleanup_old_versions() {
    let (_dir, project_path, service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    // 创建 5 个不同内容的版本
    for i in 0..5 {
        repo.save_version(
            "evolving.rs",
            format!("version {}", i).as_bytes(),
            false,
            "main",
            0,
        )
        .unwrap();
    }
    drop(repo);

    let versions = service.list_versions(&project_path, "evolving.rs").unwrap();
    assert_eq!(versions.len(), 5);

    // 更新配置，限制每文件最多 2 个版本
    let mut config = service.get_config(&project_path).unwrap();
    config.max_versions_per_file = 2;
    config.max_age_days = 365; // 不按时间清理
    service.update_config(&project_path, config).unwrap();

    // 执行清理
    service.cleanup(&project_path).unwrap();

    let versions = service.list_versions(&project_path, "evolving.rs").unwrap();
    assert_eq!(versions.len(), 2);

    // 验证保留的是最新的两个版本
    let content_0 = service
        .get_version_content(&project_path, "evolving.rs", &versions[0].id)
        .unwrap();
    let content_1 = service
        .get_version_content(&project_path, "evolving.rs", &versions[1].id)
        .unwrap();
    assert_eq!(content_0, b"version 3");
    assert_eq!(content_1, b"version 4");
}

// ============ 5. 分支感知 ============

#[test]
fn test_branch_aware_versions() {
    let (_dir, project_path, service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    repo.save_version("shared.rs", b"main-v1", false, "main", 0)
        .unwrap();
    repo.save_version("shared.rs", b"feat-v1", false, "feature-x", 0)
        .unwrap();
    repo.save_version("shared.rs", b"feat-v2", false, "feature-x", 0)
        .unwrap();
    repo.save_version("shared.rs", b"main-v2", false, "main", 0)
        .unwrap();
    drop(repo);

    // 按分支过滤
    let main_versions = service
        .list_versions_by_branch(&project_path, "shared.rs", "main")
        .unwrap();
    assert_eq!(main_versions.len(), 2);
    for v in &main_versions {
        assert_eq!(v.branch, "main");
    }

    let feat_versions = service
        .list_versions_by_branch(&project_path, "shared.rs", "feature-x")
        .unwrap();
    assert_eq!(feat_versions.len(), 2);
    for v in &feat_versions {
        assert_eq!(v.branch, "feature-x");
    }

    // 获取文件的所有分支
    let branches = service
        .get_file_branches(&project_path, "shared.rs")
        .unwrap();
    assert!(branches.contains(&"main".to_string()));
    assert!(branches.contains(&"feature-x".to_string()));
    assert_eq!(branches.len(), 2);

    // 全量查询不分分支
    let all_versions = service.list_versions(&project_path, "shared.rs").unwrap();
    assert_eq!(all_versions.len(), 4);
}

#[test]
fn test_get_current_branch() {
    let (_dir, project_path, service) = setup();

    let branch = service.get_current_branch(&project_path).unwrap();
    assert_eq!(branch, "main");
}

// ============ 6. 最近变更 ============

#[test]
fn test_recent_changes_across_files() {
    let (_dir, project_path, service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    repo.save_version("first.rs", b"first", false, "main", 0)
        .unwrap();
    repo.save_version("second.rs", b"second", false, "main", 0)
        .unwrap();
    repo.save_version("third.rs", b"third", false, "main", 0)
        .unwrap();
    repo.save_version("fourth.rs", b"fourth", false, "main", 0)
        .unwrap();
    drop(repo);

    // 限制返回 2 条
    let changes = service.get_recent_changes(&project_path, 2).unwrap();
    assert_eq!(changes.len(), 2);
    // 应按时间倒序（最新的在前）
    assert_eq!(changes[0].file_path, "fourth.rs");
    assert_eq!(changes[1].file_path, "third.rs");

    // 不限制
    let all_changes = service.get_recent_changes(&project_path, 100).unwrap();
    assert_eq!(all_changes.len(), 4);
}

#[test]
fn test_recent_changes_empty() {
    let (_dir, project_path, service) = setup();

    let changes = service.get_recent_changes(&project_path, 10).unwrap();
    assert!(changes.is_empty());
}

// ============ 7. 目录级查询 ============

#[test]
fn test_directory_changes() {
    let (_dir, project_path, service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    repo.save_version("src/a.rs", b"a", false, "main", 0)
        .unwrap();
    repo.save_version("src/b.rs", b"b", false, "main", 0)
        .unwrap();
    repo.save_version("src/deep/c.rs", b"c", false, "main", 0)
        .unwrap();
    repo.save_version("tests/t.rs", b"t", false, "main", 0)
        .unwrap();
    drop(repo);

    let src_changes = service
        .list_directory_changes(&project_path, "src", None)
        .unwrap();
    // src/a.rs, src/b.rs, src/deep/c.rs
    assert_eq!(src_changes.len(), 3);

    let test_changes = service
        .list_directory_changes(&project_path, "tests", None)
        .unwrap();
    assert_eq!(test_changes.len(), 1);
}

// ============ 8. 删除文件记录 ============

#[test]
fn test_deleted_files_tracking() {
    let (_dir, project_path, service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    // 保存正常版本
    repo.save_version("removed.rs", b"content", false, "main", 0)
        .unwrap();
    // 标记为已删除
    repo.save_version("removed.rs", b"content", true, "main", 0)
        .unwrap();
    // 另一个未删除的文件
    repo.save_version("alive.rs", b"alive", false, "main", 0)
        .unwrap();
    drop(repo);

    let deleted = service.list_deleted_files(&project_path).unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].file_path, "removed.rs");
    assert!(deleted[0].is_deleted);
}

// ============ 9. 恢复版本 ============

#[test]
fn test_restore_version_to_filesystem() {
    let (_dir, project_path, service) = setup();

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    let v = repo
        .save_version("restore-me.txt", b"original content", false, "main", 0)
        .unwrap()
        .unwrap();
    drop(repo);

    // 恢复到文件系统
    service
        .restore_version(&project_path, "restore-me.txt", &v.id)
        .unwrap();

    let restored = std::fs::read(project_path.join("restore-me.txt")).unwrap();
    assert_eq!(restored, b"original content");

    // 恢复应创建 "Before Restore" 自动标签
    let labels = service.list_labels(&project_path).unwrap();
    assert!(!labels.is_empty());
    assert!(labels.iter().any(|l| l.name.starts_with("Before Restore")));
}

// ============ 10. 压缩 ============

#[test]
fn test_compress_and_read_back() {
    let (_dir, project_path, service) = setup();

    // 创建大于 512 字节的内容才会被压缩
    let large_content = vec![b'X'; 2048];

    let repo = HistoryFileRepository::open(&project_path).unwrap();
    let v = repo
        .save_version("big.txt", &large_content, false, "main", 0)
        .unwrap()
        .unwrap();
    drop(repo);

    let compressed_count = service.compress_blobs(&project_path).unwrap();
    assert!(compressed_count >= 1);

    // 压缩后仍能正确读取内容
    let content = service
        .get_version_content(&project_path, "big.txt", &v.id)
        .unwrap();
    assert_eq!(content, large_content);

    // 再次压缩应幂等（已压缩的跳过）
    let second_count = service.compress_blobs(&project_path).unwrap();
    assert_eq!(second_count, 0);
}

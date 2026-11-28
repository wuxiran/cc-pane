//! 全部在临时目录里造假数据，根目录经 `RelocationRoots` 注入，不碰真实的 `~/.claude` / `~/.codex`。

use super::claude::claude_slug;
use super::*;
use crate::repository::Database;
use std::fs;
use std::time::Duration;

/// 测试路径在 Windows 上加盘符：`/work/x` 在原生 Windows 上不是绝对路径（会被
/// `clean_path` 正确拒绝）。正斜杠在 Windows 绝对路径里同样合法，JSON 里也不用转义。
macro_rules! abs {
    ($s:literal) => {
        if cfg!(windows) {
            concat!("C:", $s)
        } else {
            $s
        }
    };
}

const OLD: &str = abs!("/work/old-name");
const NEW: &str = abs!("/work/new_name");
const OLD_SIBLING: &str = abs!("/work/old-name-2");
const OLD_UNDERSCORE: &str = abs!("/work/old_name");
const ELSEWHERE: &str = abs!("/elsewhere");

struct Env {
    tmp: tempfile::TempDir,
    roots: RelocationRoots,
}

impl Env {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let roots = RelocationRoots {
            claude_projects_dirs: vec![tmp.path().join("claude").join("projects")],
            codex_sessions_dirs: vec![tmp.path().join("codex").join("sessions")],
            backup_root: tmp
                .path()
                .join("cc-panes")
                .join("backups")
                .join("session-relocation"),
            active_window: Duration::ZERO,
        };
        fs::create_dir_all(&roots.claude_projects_dirs[0]).unwrap();
        fs::create_dir_all(&roots.codex_sessions_dirs[0]).unwrap();
        Self { tmp, roots }
    }

    fn claude_dir(&self, path: &str) -> PathBuf {
        self.roots.claude_projects_dirs[0].join(claude_slug(path))
    }

    fn claude_session(&self, path: &str, id: &str, cwd: &str) -> PathBuf {
        let dir = self.claude_dir(path);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{id}.jsonl"));
        fs::write(
            &file,
            format!(
                "{{\"type\":\"user\",\"cwd\":\"{cwd}\",\"sessionId\":\"{id}\",\"message\":{{\"content\":\"edit {OLD}/src/main.rs\"}}}}\n\
                 {{\"type\":\"assistant\",\"cwd\":\"{cwd}/sub\",\"sessionId\":\"{id}\"}}\n"
            ),
        )
        .unwrap();
        file
    }

    fn codex_session(&self, id: &str, cwd: &str) -> PathBuf {
        let dir = self.roots.codex_sessions_dirs[0]
            .join("2026")
            .join("11")
            .join("20");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("rollout-2026-11-20T10-00-00-{id}.jsonl"));
        fs::write(
            &file,
            format!(
                "{{\"timestamp\":\"t\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"{cwd}\",\"originator\":\"codex_cli_rs\"}}}}\n\
                 {{\"timestamp\":\"t\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"content\":[{{\"text\":\"cd {cwd}\"}}]}}}}\n\
                 {{\"timestamp\":\"t\",\"type\":\"turn_context\",\"payload\":{{\"cwd\":\"{cwd}\",\"model\":\"m\"}}}}\n"
            ),
        )
        .unwrap();
        file
    }

    fn request(&self, dry_run: bool) -> SessionRelocationRequest {
        SessionRelocationRequest {
            old_path: OLD.into(),
            new_path: format!("{NEW}/"),
            dry_run,
        }
    }
}

fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    walk(dir, dir, &mut files);
    files.sort();
    files
}

#[test]
fn dry_run_counts_without_touching_anything() {
    let env = Env::new();
    env.claude_session(OLD, "c1", OLD);
    env.claude_session(OLD, "c2", OLD);
    env.codex_session("x1", OLD);
    env.codex_session("x2", OLD_SIBLING);
    let before = snapshot(env.tmp.path());

    let report = relocate_sessions(&env.roots, None, &env.request(true)).unwrap();

    assert!(report.dry_run);
    assert_eq!(report.claude_sessions, 2);
    assert_eq!(report.codex_sessions, 1, "only the exact prefix matches");
    assert_eq!(report.new_path, NEW, "trailing separator is dropped");
    assert!(report.backup_dir.is_none());
    assert_eq!(snapshot(env.tmp.path()), before);
}

#[test]
fn claude_sessions_move_with_cwd_rewritten_and_conflicts_skipped() {
    let env = Env::new();
    env.claude_session(OLD, "c1", OLD);
    env.claude_session(OLD, "dup", OLD);
    fs::create_dir_all(env.claude_dir(OLD).join("c1").join("subagents")).unwrap();
    fs::write(
        env.claude_dir(OLD)
            .join("c1")
            .join("subagents")
            .join("agent-a.jsonl"),
        format!("{{\"cwd\":\"{OLD}\"}}\n"),
    )
    .unwrap();
    // 新路径下已有同名会话
    let existing = env.claude_session(NEW, "dup", NEW);
    let existing_bytes = fs::read(&existing).unwrap();

    let report = relocate_sessions(&env.roots, None, &env.request(false)).unwrap();

    assert_eq!(report.claude_sessions, 1);
    assert_eq!(
        report.skipped,
        vec![SkippedSession {
            cli: "claude".into(),
            session_id: "dup".into(),
            reason: "exists".into()
        }]
    );
    let moved = fs::read_to_string(env.claude_dir(NEW).join("c1.jsonl")).unwrap();
    assert!(moved.contains(&format!("\"cwd\":\"{NEW}\"")));
    assert!(moved.contains(&format!("\"cwd\":\"{NEW}/sub\"")));
    // 消息内容里的旧路径不改
    assert!(moved.contains(&format!("edit {OLD}/src/main.rs")));
    let sub = fs::read_to_string(
        env.claude_dir(NEW)
            .join("c1")
            .join("subagents")
            .join("agent-a.jsonl"),
    )
    .unwrap();
    assert!(sub.contains(NEW));
    // 冲突的会话两边都不动
    assert_eq!(fs::read(&existing).unwrap(), existing_bytes);
    assert!(env.claude_dir(OLD).join("dup.jsonl").is_file());
    assert!(!env.claude_dir(OLD).join("c1.jsonl").exists());

    // 备份是迁移前的原件
    let backup = PathBuf::from(report.backup_dir.expect("backup dir"));
    assert!(backup.starts_with(&env.roots.backup_root));
    let original = fs::read_to_string(
        backup
            .join("claude")
            .join("0")
            .join(claude_slug(OLD))
            .join("c1.jsonl"),
    )
    .unwrap();
    assert!(original.contains(&format!("\"cwd\":\"{OLD}\"")));
    assert!(backup.join("manifest.json").is_file());
}

#[test]
fn codex_rewrites_only_metadata_cwd_and_keeps_mtime() {
    let env = Env::new();
    let file = env.codex_session("x1", &format!("{OLD}/pkg"));
    let other = env.codex_session("x2", ELSEWHERE);
    let other_bytes = fs::read(&other).unwrap();
    let old_mtime = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    set_mtime(&file, old_mtime);

    let report = relocate_sessions(&env.roots, None, &env.request(false)).unwrap();

    assert_eq!(report.codex_sessions, 1);
    let text = fs::read_to_string(&file).unwrap();
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[0]["payload"]["cwd"], format!("{NEW}/pkg"));
    assert_eq!(lines[2]["payload"]["cwd"], format!("{NEW}/pkg"));
    assert_eq!(
        lines[1]["payload"]["content"][0]["text"],
        format!("cd {OLD}/pkg")
    );
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), old_mtime);
    assert_eq!(fs::read(&other).unwrap(), other_bytes);
    let backup = PathBuf::from(report.backup_dir.unwrap());
    let backed_up = backup.join("codex").join("0").join(
        file.strip_prefix(&env.roots.codex_sessions_dirs[0])
            .unwrap(),
    );
    assert!(fs::read_to_string(backed_up)
        .unwrap()
        .contains(&format!("\"cwd\":\"{OLD}/pkg\"")));
}

#[test]
fn recently_written_sessions_are_skipped_as_active() {
    let mut env = Env::new();
    env.roots.active_window = Duration::from_secs(3600);
    env.claude_session(OLD, "c1", OLD);
    env.codex_session("x1", OLD);
    let report = relocate_sessions(&env.roots, None, &env.request(false)).unwrap();
    assert_eq!(report.claude_sessions + report.codex_sessions, 0);
    assert_eq!(report.skipped.len(), 2);
    assert!(report.skipped.iter().all(|item| item.reason == "active"));
    assert!(report.backup_dir.is_none());
}

#[test]
fn records_only_rewrite_matching_prefixes() {
    let env = Env::new();
    let db = Database::new_in_memory().unwrap();
    let conn = db.connection().unwrap();
    conn.execute_batch(&format!(
        "INSERT INTO launch_history (project_id, project_name, project_path, launched_at, launch_cwd)
           VALUES ('p', 'n', '{OLD}', 't', '{OLD}/sub'),
                  ('q', 'n', '{OLD_SIBLING}', 't', NULL),
                  ('r', 'n', '{ELSEWHERE}', 't', '{OLD}');
         INSERT INTO task_bindings (id, title, project_path, created_at, updated_at)
           VALUES ('b1', 't', '{OLD}', 't', 't'), ('b2', 't', '{OLD_UNDERSCORE}', 't', 't');"
    ))
    .unwrap();

    let preview = relocate_sessions(&env.roots, Some(&conn), &env.request(true)).unwrap();
    assert_eq!(
        (preview.launch_history_rows, preview.task_binding_rows),
        (2, 1)
    );
    let unchanged: String = conn
        .query_row(
            "SELECT project_path FROM launch_history WHERE project_id = 'p'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unchanged, OLD);

    let report = relocate_sessions(&env.roots, Some(&conn), &env.request(false)).unwrap();
    assert_eq!(
        (report.launch_history_rows, report.task_binding_rows),
        (2, 1)
    );
    let rows: Vec<(String, String, Option<String>)> = conn
        .prepare(
            "SELECT project_id, project_path, launch_cwd FROM launch_history ORDER BY project_id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        rows,
        vec![
            ("p".into(), NEW.into(), Some(format!("{NEW}/sub"))),
            ("q".into(), OLD_SIBLING.into(), None),
            ("r".into(), ELSEWHERE.into(), Some(NEW.into())),
        ]
    );
    let bindings: Vec<String> = conn
        .prepare("SELECT project_path FROM task_bindings ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(bindings, vec![NEW.to_string(), OLD_UNDERSCORE.to_string()]);
    let backup = PathBuf::from(report.backup_dir.unwrap());
    assert!(fs::read_to_string(backup.join("records.json"))
        .unwrap()
        .contains(OLD));
}

#[test]
fn rejects_same_nested_or_relative_paths() {
    let env = Env::new();
    let bad = |old: &str, new: &str| {
        relocate_sessions(
            &env.roots,
            None,
            &SessionRelocationRequest {
                old_path: old.into(),
                new_path: new.into(),
                dry_run: true,
            },
        )
        .is_err()
    };
    assert!(bad(OLD, OLD));
    assert!(bad(OLD, &format!("{OLD}/child")));
    assert!(bad("relative/path", NEW));
    assert!(bad("/", NEW));
}

#[test]
fn remap_path_requires_a_separator_boundary() {
    assert_eq!(remap_path("/a/b", "/a/b", "/c"), Some("/c".into()));
    assert_eq!(remap_path("/a/b/x", "/a/b", "/c"), Some("/c/x".into()));
    assert_eq!(
        remap_path(r"D:\a\b\x", r"D:\a\b", r"E:\c"),
        Some(r"E:\c\x".into())
    );
    assert_eq!(remap_path("/a/bc", "/a/b", "/c"), None);
}

#[test]
fn claude_slug_matches_claude_code_rule() {
    assert_eq!(
        claude_slug("/Users/me/.cc-panes/my_proj"),
        "-Users-me--cc-panes-my-proj"
    );
    assert_eq!(claude_slug(r"D:\04_ws\vms"), "D--04-ws-vms");
}

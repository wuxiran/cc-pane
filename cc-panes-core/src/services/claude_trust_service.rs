//! 替用户记下「这个目录我信任」，让 Claude Code 不再逐目录、逐账号弹信任确认。
//!
//! 信任记录存在每份配置自己的 `.claude.json` 的 `projects[路径].hasTrustDialogAccepted`，
//! 换一个 `CLAUDE_CONFIG_DIR`（如 reclaude 的账号目录）就要全部重新确认。CC-Panes 启动 CLI
//! 时拿不到最终生效的配置目录（它可能只存在于 CLI 进程内），所以写入所有已存在的配置。
//!
//! 约束：
//! - 只写已存在的文件：不替 CLI 创建首次运行才有的配置。
//! - 解析不了就不碰：宁可多弹一次窗口，也不能覆盖掉用户的配置。
//! - 与运行中的 CLI 共用 `.claude.json.lock` 目录锁（CLI 在锁内重读再写，不会用旧缓存盖回来）。

use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

const CONFIG_FILE_NAME: &str = ".claude.json";
const LOCK_RETRIES: u32 = 5;
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(100);

#[derive(Debug, PartialEq, Eq)]
pub enum TrustWriteOutcome {
    AlreadyTrusted,
    Written,
    /// 其他进程一直持锁：本次放弃，CLI 至多多弹一次窗口。
    LockBusy,
}

/// 启动目录对应的全部信任键：目录本身、所在 git 仓库根，以及 worktree 所属的主仓库根。
///
/// CLI 对 git 仓库内的目录按仓库根查找信任，worktree 还可能归到主仓库，多写的键无害。
pub fn trust_keys_for(path: &Path) -> Vec<String> {
    let Ok(canonical) = fs::canonicalize(path) else {
        return Vec::new();
    };
    let mut keys = vec![config_key(&canonical)];
    if let Some((root, main_root)) = git_roots(&canonical) {
        keys.push(config_key(&root));
        keys.push(config_key(&main_root));
    }
    keys.dedup();
    let mut unique = Vec::with_capacity(keys.len());
    for key in keys {
        if !unique.contains(&key) {
            unique.push(key);
        }
    }
    unique
}

/// `path` 是否落在任一已登记目录之内（含其 git 根与主仓库根，这样 worktree 也算）。
pub fn is_registered(path: &Path, registered: &[PathBuf]) -> bool {
    let registered: Vec<PathBuf> = registered
        .iter()
        .filter_map(|entry| fs::canonicalize(entry).ok())
        .collect();
    let Ok(canonical) = fs::canonicalize(path) else {
        return false;
    };
    let mut candidates = vec![canonical.clone()];
    if let Some((root, main_root)) = git_roots(&canonical) {
        candidates.push(root);
        candidates.push(main_root);
    }
    candidates
        .iter()
        .any(|candidate| registered.iter().any(|entry| candidate.starts_with(entry)))
}

/// 所有已存在的 Claude 配置文件：默认位置、显式配置目录、reclaude 各账号目录。
pub fn existing_config_files(home: &Path, extra_config_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = vec![home.join(CONFIG_FILE_NAME)];
    files.extend(
        extra_config_dirs
            .iter()
            .map(|dir| dir.join(CONFIG_FILE_NAME)),
    );
    if let Ok(accounts) = fs::read_dir(home.join(".rec/claude/accounts")) {
        let mut account_files: Vec<PathBuf> = accounts
            .flatten()
            .map(|account| account.path().join("config").join(CONFIG_FILE_NAME))
            .collect();
        account_files.sort();
        files.extend(account_files);
    }
    let mut unique: Vec<PathBuf> = Vec::with_capacity(files.len());
    for file in files {
        if file.is_file() && !unique.contains(&file) {
            unique.push(file);
        }
    }
    unique
}

/// 把 `keys` 标记为已信任。已全部信任时不加锁、不写盘：每次启动都会走到这里。
pub fn ensure_trusted(config_file: &Path, keys: &[String]) -> Result<TrustWriteOutcome, String> {
    // 符号链接要写到目标文件，否则 rename 会把链接本身换成普通文件。
    let target = fs::canonicalize(config_file).map_err(|error| error.to_string())?;
    if all_trusted(&read_config(&target)?, keys) {
        return Ok(TrustWriteOutcome::AlreadyTrusted);
    }
    let Some(_lock) = ConfigLock::acquire(&target)? else {
        return Ok(TrustWriteOutcome::LockBusy);
    };
    // 持锁后必须重读：判断之后 CLI 可能已经写过。
    let mut config = read_config(&target)?;
    if all_trusted(&config, keys) {
        return Ok(TrustWriteOutcome::AlreadyTrusted);
    }
    mark_trusted(&mut config, keys)?;
    write_atomically(&target, &config)?;
    Ok(TrustWriteOutcome::Written)
}

fn config_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        text.strip_prefix(r"\\?\")
            .unwrap_or(&text)
            .replace('\\', "/")
    }
    #[cfg(not(windows))]
    text.into_owned()
}

/// 向上找 `.git`，返回（仓库根，主仓库根）。普通仓库两者相同；不跑 git，启动路径上不能慢。
fn git_roots(start: &Path) -> Option<(PathBuf, PathBuf)> {
    for dir in start.ancestors() {
        let dot_git = dir.join(".git");
        if dot_git.is_dir() {
            return Some((dir.to_path_buf(), dir.to_path_buf()));
        }
        if dot_git.is_file() {
            let main_root = worktree_main_root(&dot_git).unwrap_or_else(|| dir.to_path_buf());
            return Some((dir.to_path_buf(), main_root));
        }
    }
    None
}

/// worktree 的 `.git` 文件形如 `gitdir: <主仓库>/.git/worktrees/<名字>`。
fn worktree_main_root(dot_git_file: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(dot_git_file).ok()?;
    let git_dir = PathBuf::from(content.strip_prefix("gitdir:")?.trim());
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        dot_git_file.parent()?.join(git_dir)
    };
    let common_dir = git_dir.parent()?.parent()?;
    if common_dir.file_name()? != ".git" {
        return None;
    }
    fs::canonicalize(common_dir.parent()?).ok()
}

fn read_config(path: &Path) -> Result<Value, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let config: Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    if !config.is_object() {
        return Err("config root is not an object".to_string());
    }
    Ok(config)
}

fn all_trusted(config: &Value, keys: &[String]) -> bool {
    keys.iter().all(|key| {
        config
            .get("projects")
            .and_then(|projects| projects.get(key))
            .and_then(|project| project.get("hasTrustDialogAccepted"))
            .and_then(Value::as_bool)
            == Some(true)
    })
}

fn mark_trusted(config: &mut Value, keys: &[String]) -> Result<(), String> {
    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    let projects = root
        .entry("projects")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("projects is not an object")?;
    for key in keys {
        // 新条目补全 CLI 自己的默认字段；已有条目只动这一个标记。
        let project = projects
            .entry(key.clone())
            .or_insert_with(default_project_entry)
            .as_object_mut()
            .ok_or_else(|| format!("project entry for {key} is not an object"))?;
        project.insert("hasTrustDialogAccepted".to_string(), Value::Bool(true));
    }
    Ok(())
}

fn default_project_entry() -> Value {
    json!({
        "allowedTools": [],
        "mcpContextUris": [],
        "mcpServers": {},
        "enabledMcpjsonServers": [],
        "disabledMcpjsonServers": [],
        "hasTrustDialogAccepted": false,
        "hasClaudeMdExternalIncludesApproved": false,
        "hasClaudeMdExternalIncludesWarningShown": false,
    })
}

/// 同目录临时文件 + rename，保留原权限（配置里有登录信息，通常是 0600）。
fn write_atomically(target: &Path, config: &Value) -> Result<(), String> {
    let permissions = fs::metadata(target)
        .map_err(|error| error.to_string())?
        .permissions();
    let body = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    let mut temp_path = target.as_os_str().to_owned();
    temp_path.push(format!(".ccpanes-{}.tmp", std::process::id()));
    let temp_path = PathBuf::from(temp_path);
    let result = (|| {
        // 先收紧权限再写内容：临时文件也不能让别的用户读到登录信息。
        let mut temp = fs::File::create(&temp_path)?;
        temp.set_permissions(permissions)?;
        temp.write_all(&body)?;
        temp.sync_all()?;
        fs::rename(&temp_path, target)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    Ok(())
}

/// 与 CLI 相同的锁：原子地创建 `<配置文件>.lock` 目录。陈旧锁交给 CLI 回收，这里只等不抢。
struct ConfigLock {
    path: PathBuf,
}

impl ConfigLock {
    fn acquire(config_file: &Path) -> Result<Option<Self>, String> {
        let mut path = config_file.as_os_str().to_owned();
        path.push(".lock");
        let path = PathBuf::from(path);
        for attempt in 0..=LOCK_RETRIES {
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Some(Self { path })),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if attempt < LOCK_RETRIES {
                        sleep(LOCK_RETRY_DELAY);
                    }
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(None)
    }
}

impl Drop for ConfigLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_dir() -> TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    fn canonical(path: &Path) -> PathBuf {
        fs::canonicalize(path).expect("canonicalize")
    }

    fn key(path: &Path) -> String {
        config_key(&canonical(path))
    }

    fn write_config(path: &Path, value: Value) {
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn git_repo(root: &Path) {
        fs::create_dir_all(root.join(".git/worktrees/feature")).unwrap();
    }

    fn git_worktree(main: &Path, worktree: &Path) {
        fs::create_dir_all(worktree).unwrap();
        let git_dir = canonical(main).join(".git/worktrees/feature");
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .unwrap();
    }

    #[test]
    fn keys_for_plain_directory_are_just_itself() {
        let dir = temp_dir();
        assert_eq!(trust_keys_for(dir.path()), vec![key(dir.path())]);
    }

    #[test]
    fn keys_for_repo_subdirectory_include_repo_root() {
        let dir = temp_dir();
        git_repo(dir.path());
        let sub = dir.path().join("src/deep");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(trust_keys_for(&sub), vec![key(&sub), key(dir.path())]);
    }

    #[test]
    fn keys_for_worktree_include_main_repo() {
        let dir = temp_dir();
        let main = dir.path().join("repo");
        let worktree = dir.path().join("repo-feature");
        git_repo(&main);
        git_worktree(&main, &worktree);
        assert_eq!(trust_keys_for(&worktree), vec![key(&worktree), key(&main)]);
    }

    #[test]
    fn keys_for_missing_path_are_empty() {
        assert!(trust_keys_for(Path::new("/definitely/not/here")).is_empty());
    }

    #[test]
    fn registration_covers_project_subdirectories_and_worktrees_only() {
        let dir = temp_dir();
        let main = dir.path().join("repo");
        let worktree = dir.path().join("repo-feature");
        let stranger = dir.path().join("repo-stranger");
        git_repo(&main);
        git_worktree(&main, &worktree);
        fs::create_dir_all(main.join("src")).unwrap();
        fs::create_dir_all(&stranger).unwrap();
        let registered = vec![main.clone()];

        assert!(is_registered(&main, &registered));
        assert!(is_registered(&main.join("src"), &registered));
        assert!(is_registered(&worktree, &registered));
        assert!(
            !is_registered(&stranger, &registered),
            "前缀相同的陌生目录不算"
        );
        assert!(!is_registered(dir.path(), &registered), "上级目录不算");
    }

    #[test]
    fn config_files_cover_home_extra_dirs_and_rec_accounts_but_only_existing() {
        let dir = temp_dir();
        let home = dir.path();
        let account = home.join(".rec/claude/accounts/1/config");
        let empty_account = home.join(".rec/claude/accounts/2/config");
        let profile = home.join("profile");
        fs::create_dir_all(&account).unwrap();
        fs::create_dir_all(&empty_account).unwrap();
        fs::create_dir_all(&profile).unwrap();
        for file in [
            home.join(CONFIG_FILE_NAME),
            account.join(CONFIG_FILE_NAME),
            profile.join(CONFIG_FILE_NAME),
        ] {
            write_config(&file, json!({}));
        }

        assert_eq!(
            existing_config_files(home, &[profile.clone(), home.join("missing")]),
            vec![
                home.join(CONFIG_FILE_NAME),
                profile.join(CONFIG_FILE_NAME),
                account.join(CONFIG_FILE_NAME),
            ]
        );
    }

    #[test]
    fn marks_new_project_with_cli_defaults_and_keeps_everything_else() {
        let dir = temp_dir();
        let file = dir.path().join(CONFIG_FILE_NAME);
        write_config(
            &file,
            json!({
                "oauthAccount": {"id": "keep"},
                "projects": {"/other": {"hasTrustDialogAccepted": false, "allowedTools": ["x"]}},
            }),
        );

        let outcome = ensure_trusted(&file, &["/new".to_string()]).unwrap();

        assert_eq!(outcome, TrustWriteOutcome::Written);
        let config = read_json(&file);
        assert_eq!(config["oauthAccount"]["id"], "keep");
        assert_eq!(
            config["projects"]["/other"]["hasTrustDialogAccepted"],
            false
        );
        assert_eq!(config["projects"]["/other"]["allowedTools"][0], "x");
        assert_eq!(config["projects"]["/new"]["hasTrustDialogAccepted"], true);
        assert_eq!(config["projects"]["/new"]["mcpServers"], json!({}));
    }

    #[test]
    fn existing_project_only_gets_the_flag_flipped() {
        let dir = temp_dir();
        let file = dir.path().join(CONFIG_FILE_NAME);
        write_config(
            &file,
            json!({"projects": {"/p": {"allowedTools": ["Bash"], "hasTrustDialogAccepted": false}}}),
        );

        ensure_trusted(&file, &["/p".to_string()]).unwrap();

        assert_eq!(
            read_json(&file)["projects"]["/p"],
            json!({"allowedTools": ["Bash"], "hasTrustDialogAccepted": true})
        );
    }

    #[test]
    fn already_trusted_does_not_rewrite_or_need_the_lock() {
        let dir = temp_dir();
        let file = dir.path().join(CONFIG_FILE_NAME);
        let original = r#"{ "projects":   {"/p": {"hasTrustDialogAccepted": true}} }"#;
        fs::write(&file, original).unwrap();
        fs::create_dir(dir.path().join(".claude.json.lock")).unwrap();

        let outcome = ensure_trusted(&file, &["/p".to_string()]).unwrap();

        assert_eq!(outcome, TrustWriteOutcome::AlreadyTrusted);
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
    }

    #[test]
    fn unparseable_config_is_left_untouched() {
        let dir = temp_dir();
        let file = dir.path().join(CONFIG_FILE_NAME);
        fs::write(&file, "{ not json").unwrap();

        assert!(ensure_trusted(&file, &["/p".to_string()]).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "{ not json");
    }

    #[test]
    fn non_object_shapes_are_left_untouched() {
        let dir = temp_dir();
        let file = dir.path().join(CONFIG_FILE_NAME);
        let original = r#"{"projects":[]}"#;
        fs::write(&file, original).unwrap();

        assert!(ensure_trusted(&file, &["/p".to_string()]).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
    }

    #[test]
    fn busy_lock_gives_up_without_writing() {
        let dir = temp_dir();
        let file = dir.path().join(CONFIG_FILE_NAME);
        fs::write(&file, "{}").unwrap();
        let lock = dir.path().join(".claude.json.lock");
        fs::create_dir(&lock).unwrap();

        let outcome = ensure_trusted(&file, &["/p".to_string()]).unwrap();

        assert_eq!(outcome, TrustWriteOutcome::LockBusy);
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
        assert!(lock.is_dir(), "别人的锁不能被我们删掉");
    }

    #[test]
    fn lock_is_released_after_writing() {
        let dir = temp_dir();
        let file = dir.path().join(CONFIG_FILE_NAME);
        fs::write(&file, "{}").unwrap();

        ensure_trusted(&file, &["/p".to_string()]).unwrap();

        assert!(!dir.path().join(".claude.json.lock").exists());
    }

    #[cfg(unix)]
    #[test]
    fn keeps_private_permissions_and_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = temp_dir();
        let real = dir.path().join("real.json");
        fs::write(&real, "{}").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join(CONFIG_FILE_NAME);
        symlink(&real, &link).unwrap();

        ensure_trusted(&link, &["/p".to_string()]).unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            read_json(&real)["projects"]["/p"]["hasTrustDialogAccepted"],
            true
        );
    }
}

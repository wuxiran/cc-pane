//! 并行度环境注入（docs/107 P2）：让窗格里的 `cargo build` / `make` / `rg` 默认
//! 不吃满整机，给 UI 和其他窗格留核。
//!
//! 规则：
//! - 只在 `[performance] buildParallelismEnabled` 开着时产出；关了就是空计划。
//! - **用户自己设过的键一律不碰**：无论是继承的进程环境（`std::env`）还是启动档 /
//!   provider 已经写进 `env` 的键，都视为用户意图，跳过。
//! - 有效并行度全部由 `PerformanceSettings::effective_*` 折算，这里不再算一遍。
//! - `RIPGREP_CONFIG_PATH` 是路径：本地 / WSL 才注入（WSL 走 WSLENV `/p` 翻译），
//!   SSH 远端没有这个文件，只导出五个非路径键（见 [`PERF_ENV_PORTABLE_KEYS`]）。
//! - rg 配置写在 `<data>/runtime/rgrc`，内容幂等（相同内容不重写）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::models::settings::PerformanceSettings;

/// 本模块可能注入的全部键（WSLENV 透传表 / 文档引用）。
pub const PERF_ENV_FORWARD_KEYS: &[&str] = &[
    "CARGO_BUILD_JOBS",
    "MAKEFLAGS",
    "CMAKE_BUILD_PARALLEL_LEVEL",
    "RAYON_NUM_THREADS",
    "UV_THREADPOOL_SIZE",
    RIPGREP_CONFIG_ENV,
];

/// 非路径键：SSH 远端与 WSL 脚本 `export` 只用这五个。
pub const PERF_ENV_PORTABLE_KEYS: &[&str] = &[
    "CARGO_BUILD_JOBS",
    "MAKEFLAGS",
    "CMAKE_BUILD_PARALLEL_LEVEL",
    "RAYON_NUM_THREADS",
    "UV_THREADPOOL_SIZE",
];

/// ripgrep 配置文件路径变量（值是宿主路径，跨 WSL 需 `/p` 翻译）。
pub const RIPGREP_CONFIG_ENV: &str = "RIPGREP_CONFIG_PATH";

/// `<data>/runtime/` 下的 rg 配置文件名。
pub const RG_CONFIG_FILE_NAME: &str = "rgrc";

/// 注入目标运行时：决定要不要带路径键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PerfEnvRuntime {
    Local,
    Wsl,
    Ssh,
}

/// 一次会话的注入计划。`vars` 顺序固定（便于测试与日志）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PerfEnvPlan {
    pub vars: Vec<(String, String)>,
    /// 已落盘的 rg 配置路径（SSH / 写失败 / 关闭时为 None）。
    pub rg_config_path: Option<PathBuf>,
}

impl PerfEnvPlan {
    pub fn is_empty(&self) -> bool {
        self.vars.is_empty()
    }
}

/// 计算注入计划；本地 / WSL 会顺带写 `<data>/runtime/rgrc`。
/// 写失败只记日志并省掉 `RIPGREP_CONFIG_PATH`——不能因为一个配置文件让会话建不起来。
pub fn build_perf_env(
    settings: &PerformanceSettings,
    cores: u32,
    data_dir: &Path,
    runtime: PerfEnvRuntime,
) -> PerfEnvPlan {
    if !settings.build_parallelism_enabled {
        return PerfEnvPlan::default();
    }
    let rg_config_path = match runtime {
        PerfEnvRuntime::Ssh => None,
        PerfEnvRuntime::Local | PerfEnvRuntime::Wsl => {
            match ensure_rg_config(data_dir, settings.effective_rg_threads(cores)) {
                Ok(path) => Some(path),
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        data_dir = %data_dir.display(),
                        "perf env: failed to write rg config; skipping RIPGREP_CONFIG_PATH"
                    );
                    None
                }
            }
        }
    };
    plan_perf_env(settings, cores, rg_config_path)
}

/// 纯函数版：不碰文件系统，`rg_config_path` 由调用方给（测试 / SSH 用 None）。
pub fn plan_perf_env(
    settings: &PerformanceSettings,
    cores: u32,
    rg_config_path: Option<PathBuf>,
) -> PerfEnvPlan {
    if !settings.build_parallelism_enabled {
        return PerfEnvPlan::default();
    }
    let jobs = settings.effective_build_jobs(cores);
    let mut vars = vec![
        ("CARGO_BUILD_JOBS".to_string(), jobs.to_string()),
        ("MAKEFLAGS".to_string(), format!("-j{jobs}")),
        ("CMAKE_BUILD_PARALLEL_LEVEL".to_string(), jobs.to_string()),
        ("RAYON_NUM_THREADS".to_string(), jobs.to_string()),
        ("UV_THREADPOOL_SIZE".to_string(), jobs.to_string()),
    ];
    if let Some(path) = rg_config_path.as_ref() {
        vars.push((
            RIPGREP_CONFIG_ENV.to_string(),
            path.to_string_lossy().into_owned(),
        ));
    }
    PerfEnvPlan {
        vars,
        rg_config_path,
    }
}

/// 写 `<data>/runtime/rgrc`（**只有** `--threads=N`），内容相同则不重写。
///
/// 不带 `--max-columns`：它会把超长行替换成 `[Omitted long line …]`，改变 agent 的 Grep
/// 工具语义（minified JS / 长 JSON 行直接搜不到内容）。线程数不改变输出，只改变快慢。
pub fn ensure_rg_config(data_dir: &Path, threads: u32) -> std::io::Result<PathBuf> {
    let runtime_dir = data_dir.join("runtime");
    std::fs::create_dir_all(&runtime_dir)?;
    let path = runtime_dir.join(RG_CONFIG_FILE_NAME);
    let content = rg_config_content(threads);
    if std::fs::read_to_string(&path).ok().as_deref() == Some(content.as_str()) {
        return Ok(path);
    }
    crate::utils::atomic_file::write_atomic(&path, content.as_bytes())
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(path)
}

fn rg_config_content(threads: u32) -> String {
    format!("--threads={threads}\n")
}

/// 把计划写进会话 env，返回**实际写入**的键（供 WSLENV 透传表使用）。
/// 已在 `env` 里或已在当前进程环境里的键跳过——那是用户的设置。
pub fn apply_perf_env(env: &mut HashMap<String, String>, plan: &PerfEnvPlan) -> Vec<String> {
    apply_perf_env_with(env, plan, |key| std::env::var_os(key).is_some())
}

/// [`apply_perf_env`] 的可注入版本：`inherited(key)` 回答"进程环境里是否已有该键"。
pub fn apply_perf_env_with(
    env: &mut HashMap<String, String>,
    plan: &PerfEnvPlan,
    inherited: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut applied = Vec::new();
    for (key, value) in &plan.vars {
        if env.contains_key(key) || inherited(key) {
            continue;
        }
        env.insert(key.clone(), value.clone());
        applied.push(key.clone());
    }
    applied
}

/// 由实际注入的键生成 WSLENV 条目：路径键带 `/p` 让 WSL 自动翻成 `/mnt/...`。
pub fn wslenv_entries(applied_keys: &[String]) -> Vec<String> {
    applied_keys
        .iter()
        .map(|key| {
            if key == RIPGREP_CONFIG_ENV {
                format!("{key}/p")
            } else {
                key.clone()
            }
        })
        .collect()
}

/// 远端 shell 的"仅在未设置时导出"语句：`export K=${K:-'v'}`。
/// 远端（SSH / WSL 登录 profile）已有的值优先——与本地"不覆盖用户键"同一规则。
/// 只产出 [`PERF_ENV_PORTABLE_KEYS`]，路径键在远端无意义。
pub fn remote_export_statements(
    env: &HashMap<String, String>,
    shell_escape: impl Fn(&str) -> String,
) -> Vec<String> {
    PERF_ENV_PORTABLE_KEYS
        .iter()
        .filter_map(|key| {
            env.get(*key)
                .map(|value| format!("export {key}=${{{key}:-{}}}", shell_escape(value)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(enabled: bool) -> PerformanceSettings {
        PerformanceSettings {
            build_parallelism_enabled: enabled,
            ..PerformanceSettings::default()
        }
    }

    #[test]
    fn disabled_plan_is_empty_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let plan = build_perf_env(&settings(false), 32, dir.path(), PerfEnvRuntime::Local);
        assert!(plan.is_empty());
        assert_eq!(plan.rg_config_path, None);
        assert!(!dir.path().join("runtime").exists());
    }

    #[test]
    fn plan_uses_effective_jobs_and_makeflags_format() {
        let plan = plan_perf_env(&settings(true), 32, None);
        let vars: HashMap<_, _> = plan.vars.iter().cloned().collect();
        assert_eq!(vars["CARGO_BUILD_JOBS"], "24");
        assert_eq!(vars["MAKEFLAGS"], "-j24");
        assert_eq!(vars["CMAKE_BUILD_PARALLEL_LEVEL"], "24");
        assert_eq!(vars["RAYON_NUM_THREADS"], "24");
        assert_eq!(vars["UV_THREADPOOL_SIZE"], "24");
        assert!(!vars.contains_key(RIPGREP_CONFIG_ENV));
    }

    #[test]
    fn local_plan_writes_rg_config_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let plan = build_perf_env(&settings(true), 32, dir.path(), PerfEnvRuntime::Local);
        let path = plan.rg_config_path.clone().expect("rgrc written");
        assert_eq!(path, dir.path().join("runtime").join("rgrc"));
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "--threads=12\n");
        assert!(
            !content.contains("--max-columns"),
            "rgrc must not change Grep output semantics"
        );
        let first_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        let vars: HashMap<_, _> = plan.vars.iter().cloned().collect();
        assert_eq!(vars[RIPGREP_CONFIG_ENV], path.to_string_lossy());

        std::thread::sleep(std::time::Duration::from_millis(20));
        let again = build_perf_env(&settings(true), 32, dir.path(), PerfEnvRuntime::Local);
        assert_eq!(again, plan);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            first_mtime,
            "unchanged content must not be rewritten"
        );

        let fewer = PerformanceSettings {
            rg_threads: Some(3),
            ..settings(true)
        };
        build_perf_env(&fewer, 32, dir.path(), PerfEnvRuntime::Local);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "--threads=3\n"
        );
    }

    #[test]
    fn ssh_plan_omits_rg_config_path() {
        let dir = tempfile::tempdir().unwrap();
        let plan = build_perf_env(&settings(true), 32, dir.path(), PerfEnvRuntime::Ssh);
        assert_eq!(plan.vars.len(), PERF_ENV_PORTABLE_KEYS.len());
        assert!(plan.rg_config_path.is_none());
        assert!(!dir.path().join("runtime").join("rgrc").exists());
    }

    #[test]
    fn apply_never_overrides_existing_or_inherited_keys() {
        let plan = plan_perf_env(
            &settings(true),
            32,
            Some(PathBuf::from("C:/d/runtime/rgrc")),
        );
        let mut env = HashMap::new();
        env.insert("MAKEFLAGS".to_string(), "-j2".to_string());
        let applied = apply_perf_env_with(&mut env, &plan, |key| key == "CARGO_BUILD_JOBS");

        assert_eq!(env["MAKEFLAGS"], "-j2", "profile/provider value wins");
        assert!(
            !env.contains_key("CARGO_BUILD_JOBS"),
            "inherited process env wins"
        );
        assert_eq!(env["RAYON_NUM_THREADS"], "24");
        assert_eq!(
            applied,
            vec![
                "CMAKE_BUILD_PARALLEL_LEVEL",
                "RAYON_NUM_THREADS",
                "UV_THREADPOOL_SIZE",
                RIPGREP_CONFIG_ENV
            ]
        );
    }

    #[test]
    fn wslenv_entries_mark_only_the_path_key() {
        let entries = wslenv_entries(&[
            "CARGO_BUILD_JOBS".to_string(),
            RIPGREP_CONFIG_ENV.to_string(),
        ]);
        assert_eq!(entries, vec!["CARGO_BUILD_JOBS", "RIPGREP_CONFIG_PATH/p"]);
    }

    #[test]
    fn remote_exports_only_portable_keys_and_keep_remote_values() {
        let plan = plan_perf_env(&settings(true), 16, Some(PathBuf::from("C:/x/rgrc")));
        let mut env = HashMap::new();
        apply_perf_env_with(&mut env, &plan, |_| false);
        let statements = remote_export_statements(&env, |v| format!("'{v}'"));
        assert_eq!(statements.len(), 5);
        assert!(statements.contains(&"export MAKEFLAGS=${MAKEFLAGS:-'-j8'}".to_string()));
        assert!(
            statements.contains(&"export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-'8'}".to_string())
        );
        assert!(!statements.iter().any(|s| s.contains(RIPGREP_CONFIG_ENV)));
    }
}

use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::debug;

/// Hook 名称常量
const HOOK_SESSION_INJECT: &str = "session-inject";
const HOOK_PLAN_ARCHIVE: &str = "plan-archive";

/// cc-panes-hook 二进制名称标识（用于匹配 settings.local.json 中的命令）
const HOOK_BINARY_NAME: &str = "cc-panes-hook";

/// 旧版 Python 脚本文件名（用于清理）
const LEGACY_PYTHON_FILES: &[&str] = &["ccpanes-inject.py", "ccpanes-plan-archive.py"];

/// Hook 状态信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub name: String,
    pub label: String,
    pub enabled: bool,
}

/// Hook 定义：名称 -> (子命令, 事件类型, 显示标签)
struct HookDef {
    name: &'static str,
    subcommand: &'static str,
    event: &'static str,
    matcher: &'static str,
    timeout: u32,
    label: &'static str,
}

const HOOK_DEFS: &[HookDef] = &[
    HookDef {
        name: HOOK_SESSION_INJECT,
        subcommand: "session-start",
        event: "SessionStart",
        matcher: "startup",
        timeout: 10,
        label: "Context Inject",
    },
    HookDef {
        name: HOOK_PLAN_ARCHIVE,
        subcommand: "plan-archive",
        event: "PostToolUse",
        matcher: "",
        timeout: 5,
        label: "Plan Archive",
    },
];

/// Hooks 服务 - 管理 Claude Code hooks（使用 cc-panes-hook 二进制）
pub struct HooksService;

impl HooksService {
    pub fn new() -> Self {
        Self
    }

    /// 获取项目的 .ccpanes 目录路径
    fn get_ccpanes_dir(project_path: &str) -> PathBuf {
        PathBuf::from(project_path).join(".ccpanes")
    }

    /// 获取项目的 .claude/hooks 目录路径（仅用于清理旧文件）
    fn get_hooks_dir(project_path: &str) -> PathBuf {
        PathBuf::from(project_path).join(".claude").join("hooks")
    }

    /// 根据 hook 名称查找定义
    fn find_hook_def(hook_name: &str) -> Result<&'static HookDef, String> {
        HOOK_DEFS
            .iter()
            .find(|d| d.name == hook_name)
            .ok_or_else(|| format!("Unknown hook: {}", hook_name))
    }

    /// 获取 cc-panes-hook 二进制路径
    ///
    /// 查找顺序：
    /// 1. 应用安装目录（与主程序同级）
    /// 2. target/release/（开发模式）
    /// 3. target/debug/（开发模式）
    fn get_hook_binary_path() -> Result<PathBuf, String> {
        let binary_name = if cfg!(windows) {
            format!("{}.exe", HOOK_BINARY_NAME)
        } else {
            HOOK_BINARY_NAME.to_string()
        };

        // 1. 应用安装目录（与主程序同级）
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let candidate = exe_dir.join(&binary_name);
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }

        // 2. target/release/（开发模式）
        let workspace_root = Self::find_workspace_root()?;
        let release_candidate = workspace_root
            .join("target")
            .join("release")
            .join(&binary_name);
        if release_candidate.exists() {
            return Ok(release_candidate);
        }

        // 3. target/debug/（开发模式）
        let debug_candidate = workspace_root
            .join("target")
            .join("debug")
            .join(&binary_name);
        if debug_candidate.exists() {
            return Ok(debug_candidate);
        }

        Err("cc-panes-hook binary not found. Please build it first: cargo build -p cc-panes-hook".to_string())
    }

    /// 查找 workspace 根目录（包含 Cargo.toml 的最上层目录）
    fn find_workspace_root() -> Result<PathBuf, String> {
        if let Ok(exe_path) = std::env::current_exe() {
            // 从 exe 路径往上找 Cargo.toml
            let mut dir = exe_path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default();
            // 对于 target/debug 或 target/release 下的 exe，往上两级
            for _ in 0..5 {
                if dir.join("Cargo.toml").exists() {
                    return Ok(dir);
                }
                if let Some(parent) = dir.parent() {
                    dir = parent.to_path_buf();
                } else {
                    break;
                }
            }
        }

        // 回退到当前工作目录
        std::env::current_dir()
            .map_err(|e| format!("Failed to get current directory: {}", e))
    }

    /// 检查 settings.local.json 中是否注册了指定 hook 的 cc-panes-hook 命令
    fn is_hook_enabled_in_settings(project_path: &str, def: &HookDef) -> bool {
        let settings_path = PathBuf::from(project_path)
            .join(".claude")
            .join("settings.local.json");

        let content = match fs::read_to_string(&settings_path) {
            Ok(c) => c,
            Err(_) => return false,
        };

        let settings: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return false,
        };

        let entries = match settings
            .get("hooks")
            .and_then(|h| h.get(def.event))
            .and_then(|e| e.as_array())
        {
            Some(arr) => arr,
            None => return false,
        };

        entries.iter().any(|entry| {
            entry
                .get("hooks")
                .and_then(|h| h.as_array())
                .map(|hook_list| {
                    hook_list.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|c| c.contains(HOOK_BINARY_NAME) && c.contains(def.subcommand))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        })
    }

    /// 查询各 hook 的启用状态
    pub fn get_hooks_status(&self, project_path: &str) -> Result<Vec<HookStatus>, String> {
        let statuses = HOOK_DEFS
            .iter()
            .map(|def| HookStatus {
                name: def.name.to_string(),
                label: def.label.to_string(),
                enabled: Self::is_hook_enabled_in_settings(project_path, def),
            })
            .collect();
        Ok(statuses)
    }

    /// 启用单个 hook
    pub fn enable_hook(&self, project_path: &str, hook_name: &str) -> Result<(), String> {
        debug!("svc::enable_hook");
        let def = Self::find_hook_def(hook_name)?;
        let binary_path = Self::get_hook_binary_path()?;

        // 注册到 settings.local.json
        Self::register_single_hook_in_settings(project_path, def, &binary_path)?;

        // 清理旧 Python 脚本
        Self::cleanup_legacy_python_scripts(project_path);

        Ok(())
    }

    /// 禁用单个 hook
    pub fn disable_hook(&self, project_path: &str, hook_name: &str) -> Result<(), String> {
        debug!("svc::disable_hook");
        let def = Self::find_hook_def(hook_name)?;

        // 从 settings.local.json 移除对应条目
        Self::unregister_single_hook_from_settings(project_path, def)?;

        Ok(())
    }

    /// 启用所有 hooks
    pub fn enable_all_hooks(&self, project_path: &str) -> Result<(), String> {
        debug!("svc::enable_all_hooks");
        self.enable_hooks(project_path)
    }

    /// 检查项目是否启用了 hooks
    pub fn is_hooks_enabled(&self, project_path: &str) -> Result<bool, String> {
        // 检查 session-inject hook 是否已注册
        let session_def = Self::find_hook_def(HOOK_SESSION_INJECT)?;
        Ok(Self::is_hook_enabled_in_settings(project_path, session_def))
    }

    /// 启用 hooks - 注册 cc-panes-hook 命令到 settings.local.json
    pub fn enable_hooks(&self, project_path: &str) -> Result<(), String> {
        let binary_path = Self::get_hook_binary_path()?;

        // 注册所有 hooks 到 settings.local.json
        Self::register_hooks_in_settings(project_path, &binary_path)?;

        // 清理旧 Python 脚本
        Self::cleanup_legacy_python_scripts(project_path);

        Ok(())
    }

    /// 禁用 hooks - 从 settings.local.json 移除 ccpanes 条目
    pub fn disable_hooks(&self, project_path: &str) -> Result<(), String> {
        debug!("svc::disable_hooks");
        // 从 settings.local.json 移除 ccpanes 钩子条目
        Self::unregister_hooks_from_settings(project_path)?;

        // 顺便清理旧 Python 脚本
        Self::cleanup_legacy_python_scripts(project_path);

        Ok(())
    }

    /// 清理旧版 Python 脚本文件
    fn cleanup_legacy_python_scripts(project_path: &str) {
        let hooks_dir = Self::get_hooks_dir(project_path);
        for file in LEGACY_PYTHON_FILES {
            let path = hooks_dir.join(file);
            if path.exists() {
                let _ = fs::remove_file(&path);
            }
        }
    }

    /// 构建单个 hook 的 command 字符串
    fn build_hook_command(binary_path: &Path, def: &HookDef) -> String {
        let path_str = binary_path.to_string_lossy().replace('\\', "\\\\");
        format!("\"{}\" {}", path_str, def.subcommand)
    }

    /// 注册单个 hook 到 .claude/settings.local.json
    fn register_single_hook_in_settings(
        project_path: &str,
        def: &HookDef,
        binary_path: &Path,
    ) -> Result<(), String> {
        let settings_path = PathBuf::from(project_path)
            .join(".claude")
            .join("settings.local.json");

        if let Some(parent) = settings_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .claude directory: {}", e))?;
        }

        let mut settings = Self::read_settings(&settings_path)?;

        let hooks = settings
            .as_object_mut()
            .ok_or("settings is not an object")?
            .entry("hooks")
            .or_insert(json!({}));

        let hooks_obj = hooks
            .as_object_mut()
            .ok_or("hooks is not an object")?;

        let command = Self::build_hook_command(binary_path, def);
        let entry = json!({
            "matcher": def.matcher,
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": def.timeout,
                "async": true
            }]
        });

        Self::merge_ccpanes_hook_entry(hooks_obj, def.event, entry);

        Self::write_settings(&settings_path, &settings)
    }

    /// 从 .claude/settings.local.json 中移除单个 hook 条目
    fn unregister_single_hook_from_settings(
        project_path: &str,
        def: &HookDef,
    ) -> Result<(), String> {
        let settings_path = PathBuf::from(project_path)
            .join(".claude")
            .join("settings.local.json");

        if !settings_path.exists() {
            return Ok(());
        }

        let mut settings = Self::read_settings(&settings_path)?;

        if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
            if let Some(entries) = hooks.get_mut(def.event).and_then(|e| e.as_array_mut()) {
                entries.retain(|entry| !Self::is_ccpanes_hook_entry(entry));
            }

            // 清理空数组
            hooks.retain(|_, v| {
                v.as_array().map(|a| !a.is_empty()).unwrap_or(true)
            });
        }

        Self::write_settings(&settings_path, &settings)
    }

    /// 注册所有 hooks 到 .claude/settings.local.json
    fn register_hooks_in_settings(
        project_path: &str,
        binary_path: &Path,
    ) -> Result<(), String> {
        let settings_path = PathBuf::from(project_path)
            .join(".claude")
            .join("settings.local.json");

        if let Some(parent) = settings_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .claude directory: {}", e))?;
        }

        let mut settings = Self::read_settings(&settings_path)?;

        let hooks = settings
            .as_object_mut()
            .ok_or("settings is not an object")?
            .entry("hooks")
            .or_insert(json!({}));

        let hooks_obj = hooks
            .as_object_mut()
            .ok_or("hooks is not an object")?;

        for def in HOOK_DEFS {
            let command = Self::build_hook_command(binary_path, def);
            let entry = json!({
                "matcher": def.matcher,
                "hooks": [{
                    "type": "command",
                    "command": command,
                    "timeout": def.timeout,
                    "async": true
                }]
            });
            Self::merge_ccpanes_hook_entry(hooks_obj, def.event, entry);
        }

        Self::write_settings(&settings_path, &settings)
    }

    /// 从 .claude/settings.local.json 中移除所有 ccpanes 钩子条目
    fn unregister_hooks_from_settings(project_path: &str) -> Result<(), String> {
        let settings_path = PathBuf::from(project_path)
            .join(".claude")
            .join("settings.local.json");

        if !settings_path.exists() {
            return Ok(());
        }

        let mut settings = Self::read_settings(&settings_path)?;

        if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
            for (_event, entries) in hooks.iter_mut() {
                if let Some(arr) = entries.as_array_mut() {
                    arr.retain(|entry| !Self::is_ccpanes_hook_entry(entry));
                }
            }

            // 清理空数组
            hooks.retain(|_, v| {
                v.as_array().map(|a| !a.is_empty()).unwrap_or(true)
            });
        }

        Self::write_settings(&settings_path, &settings)
    }

    /// 判断一个 hook entry 是否属于 ccpanes（包含 cc-panes-hook 或旧版 ccpanes 命令）
    fn is_ccpanes_hook_entry(entry: &serde_json::Value) -> bool {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hook_list| {
                hook_list.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| c.contains(HOOK_BINARY_NAME) || c.contains("ccpanes"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    /// 将 ccpanes hook 条目合并到指定事件类型的数组中（去重）
    fn merge_ccpanes_hook_entry(
        hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
        event: &str,
        entry: serde_json::Value,
    ) {
        let arr = hooks_obj
            .entry(event)
            .or_insert(json!([]))
            .as_array_mut();

        if let Some(arr) = arr {
            // 移除旧的 ccpanes 条目（包括旧版 Python 和新版二进制）
            arr.retain(|existing| !Self::is_ccpanes_hook_entry(existing));
            arr.push(entry);
        }
    }

    /// 读取 settings.local.json
    fn read_settings(settings_path: &PathBuf) -> Result<serde_json::Value, String> {
        if settings_path.exists() {
            let content = fs::read_to_string(settings_path)
                .map_err(|e| format!("Failed to read settings.local.json: {}", e))?;
            Ok(serde_json::from_str(&content).unwrap_or(json!({})))
        } else {
            Ok(json!({}))
        }
    }

    /// 写入 settings.local.json
    fn write_settings(
        settings_path: &PathBuf,
        settings: &serde_json::Value,
    ) -> Result<(), String> {
        let content = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        fs::write(settings_path, content)
            .map_err(|e| format!("Failed to write settings.local.json: {}", e))?;
        Ok(())
    }

    /// 获取 workflow.md 内容
    pub fn get_workflow(&self, project_path: &str) -> Result<String, String> {
        let workflow_path = Self::get_ccpanes_dir(project_path).join("workflow.md");

        if !workflow_path.exists() {
            return Err("workflow.md does not exist".to_string());
        }

        fs::read_to_string(&workflow_path)
            .map_err(|e| format!("Failed to read workflow.md: {}", e))
    }

    /// 保存 workflow.md 内容
    pub fn save_workflow(&self, project_path: &str, content: &str) -> Result<(), String> {
        debug!("svc::save_workflow");
        let ccpanes_dir = Self::get_ccpanes_dir(project_path);

        // 确保目录存在
        fs::create_dir_all(&ccpanes_dir)
            .map_err(|e| format!("Failed to create .ccpanes directory: {}", e))?;

        let workflow_path = ccpanes_dir.join("workflow.md");

        fs::write(&workflow_path, content)
            .map_err(|e| format!("Failed to save workflow.md: {}", e))
    }

    /// 初始化项目的 .ccpanes 目录
    pub fn init_ccpanes(&self, project_path: &str) -> Result<(), String> {
        debug!("svc::init_ccpanes");
        let ccpanes_dir = Self::get_ccpanes_dir(project_path);
        let journal_dir = ccpanes_dir.join("journal");

        // 创建目录
        fs::create_dir_all(&journal_dir)
            .map_err(|e| format!("Failed to create directory: {}", e))?;

        // 创建默认 workflow.md（如果不存在）
        let workflow_path = ccpanes_dir.join("workflow.md");
        if !workflow_path.exists() {
            let default_workflow = self.get_default_workflow();
            fs::write(&workflow_path, default_workflow)
                .map_err(|e| format!("Failed to create workflow.md: {}", e))?;
        }

        // 创建 journal index（如果不存在）
        let index_path = journal_dir.join("index.md");
        if !index_path.exists() {
            let default_index = self.get_default_journal_index();
            fs::write(&index_path, default_index)
                .map_err(|e| format!("Failed to create journal/index.md: {}", e))?;
        }

        // 创建初始 journal 文件（如果不存在）
        let journal_path = journal_dir.join("journal-0.md");
        if !journal_path.exists() {
            let default_journal = self.get_default_journal();
            fs::write(&journal_path, default_journal)
                .map_err(|e| format!("Failed to create journal-0.md: {}", e))?;
        }

        Ok(())
    }

    fn get_default_workflow(&self) -> String {
        r#"# Project Workflow Guide

> 此文件由 CC-Panes 管理，用于在 Claude Code 启动时自动注入项目上下文。

## 项目概述

项目名称：[项目名称]
技术栈：[主要技术栈]

## 开发规范

### Git 提交规范
- feat: 新功能
- fix: 修复 bug
- docs: 文档更新
- refactor: 代码重构

## 当前任务

- [ ] 待添加
"#.to_string()
    }

    fn get_default_journal_index(&self) -> String {
        r#"# Session Journal Index

## 当前状态

<!-- @@@auto:current-status -->
- **Active File**: `journal-0.md`
- **Total Sessions**: 0
- **Last Active**: -
<!-- @@@/auto:current-status -->

## 会话历史

<!-- @@@auto:session-history -->
| # | Date | Title | Commits |
|---|------|-------|---------|
<!-- @@@/auto:session-history -->
"#.to_string()
    }

    fn get_default_journal(&self) -> String {
        r#"# Session Journal (Part 0)

> Managed by CC-Panes

---
"#.to_string()
    }
}

impl Default for HooksService {
    fn default() -> Self {
        Self::new()
    }
}

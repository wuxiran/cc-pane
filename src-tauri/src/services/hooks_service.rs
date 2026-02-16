use std::fs;
use std::path::PathBuf;

/// Hooks 服务 - 管理 Claude Code hooks 脚本
pub struct HooksService;

impl HooksService {
    pub fn new() -> Self {
        Self
    }

    /// 获取项目的 .ccpanes 目录路径
    fn get_ccpanes_dir(project_path: &str) -> PathBuf {
        PathBuf::from(project_path).join(".ccpanes")
    }

    /// 获取项目的 .claude/hooks 目录路径
    fn get_hooks_dir(project_path: &str) -> PathBuf {
        PathBuf::from(project_path).join(".claude").join("hooks")
    }

    /// 检查项目是否启用了 hooks
    pub fn is_hooks_enabled(&self, project_path: &str) -> Result<bool, String> {
        let hook_file = Self::get_hooks_dir(project_path).join("ccpanes-inject.py");
        Ok(hook_file.exists())
    }

    /// 启用 hooks - 生成注入脚本
    pub fn enable_hooks(&self, project_path: &str) -> Result<(), String> {
        let hooks_dir = Self::get_hooks_dir(project_path);

        // 创建 .claude/hooks 目录
        fs::create_dir_all(&hooks_dir)
            .map_err(|e| format!("创建 hooks 目录失败: {}", e))?;

        // 生成 hook 脚本
        let script_content = self.generate_hook_script(project_path);
        let script_path = hooks_dir.join("ccpanes-inject.py");

        fs::write(&script_path, script_content)
            .map_err(|e| format!("写入 hook 脚本失败: {}", e))?;

        Ok(())
    }

    /// 禁用 hooks - 删除注入脚本
    pub fn disable_hooks(&self, project_path: &str) -> Result<(), String> {
        let script_path = Self::get_hooks_dir(project_path).join("ccpanes-inject.py");

        if script_path.exists() {
            fs::remove_file(&script_path)
                .map_err(|e| format!("删除 hook 脚本失败: {}", e))?;
        }

        Ok(())
    }

    /// 生成 hook 脚本内容
    fn generate_hook_script(&self, _project_path: &str) -> String {
        r#"#!/usr/bin/env python3
"""
CC-Panes Session Start Hook - 自动注入项目上下文

Matcher: "startup" - 仅在正常启动时运行（不包括 resume/clear/compact）

此脚本由 CC-Panes 自动生成，请勿手动修改。
"""

import os
import sys
from pathlib import Path
from datetime import datetime


def should_skip_injection() -> bool:
    """检查是否应跳过注入（非交互模式）"""
    return os.environ.get("CLAUDE_NON_INTERACTIVE") == "1"


def read_file(path: Path, fallback: str = "") -> str:
    """读取文件内容，失败时返回 fallback"""
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError):
        return fallback


def get_git_status(project_dir: Path) -> str:
    """获取 Git 状态"""
    import subprocess
    try:
        result = subprocess.run(
            ["git", "status", "--short"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=project_dir,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        return "工作区干净"
    except Exception:
        return "无法获取 Git 状态"


def get_git_branch(project_dir: Path) -> str:
    """获取当前 Git 分支"""
    import subprocess
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=project_dir,
        )
        if result.returncode == 0:
            return result.stdout.strip() or "HEAD detached"
        return "未知"
    except Exception:
        return "未知"


def main():
    # 非交互模式下跳过注入
    if should_skip_injection():
        sys.exit(0)

    project_dir = Path(os.environ.get("CLAUDE_PROJECT_DIR", ".")).resolve()
    ccpanes_dir = project_dir / ".ccpanes"

    # 1. 会话上下文头
    print("""<ccpanes-context>
CC-Panes 已为此会话注入项目上下文。
请仔细阅读以下信息。
</ccpanes-context>
""")

    # 2. 当前状态（动态）
    print("<current-state>")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"分支: {get_git_branch(project_dir)}")
    print(f"Git 状态:\n{get_git_status(project_dir)}")
    print("</current-state>")
    print()

    # 3. 工作流指南
    workflow_path = ccpanes_dir / "workflow.md"
    if workflow_path.exists():
        print("<workflow>")
        print(read_file(workflow_path, "未找到 workflow.md"))
        print("</workflow>")
        print()

    # 4. 最近会话摘要
    journal_index = ccpanes_dir / "journal" / "index.md"
    if journal_index.exists():
        print("<recent-sessions>")
        print(read_file(journal_index, "无会话历史"))
        print("</recent-sessions>")
        print()

    # 5. 就绪提示
    print("""<ready>
上下文已加载。等待用户输入，然后根据 <workflow> 中的指南处理请求。
</ready>""")


if __name__ == "__main__":
    main()
"#.to_string()
    }

    /// 获取 workflow.md 内容
    pub fn get_workflow(&self, project_path: &str) -> Result<String, String> {
        let workflow_path = Self::get_ccpanes_dir(project_path).join("workflow.md");

        if !workflow_path.exists() {
            return Err("workflow.md 不存在".to_string());
        }

        fs::read_to_string(&workflow_path)
            .map_err(|e| format!("读取 workflow.md 失败: {}", e))
    }

    /// 保存 workflow.md 内容
    pub fn save_workflow(&self, project_path: &str, content: &str) -> Result<(), String> {
        let ccpanes_dir = Self::get_ccpanes_dir(project_path);

        // 确保目录存在
        fs::create_dir_all(&ccpanes_dir)
            .map_err(|e| format!("创建 .ccpanes 目录失败: {}", e))?;

        let workflow_path = ccpanes_dir.join("workflow.md");

        fs::write(&workflow_path, content)
            .map_err(|e| format!("保存 workflow.md 失败: {}", e))
    }

    /// 初始化项目的 .ccpanes 目录
    pub fn init_ccpanes(&self, project_path: &str) -> Result<(), String> {
        let ccpanes_dir = Self::get_ccpanes_dir(project_path);
        let journal_dir = ccpanes_dir.join("journal");

        // 创建目录
        fs::create_dir_all(&journal_dir)
            .map_err(|e| format!("创建目录失败: {}", e))?;

        // 创建默认 workflow.md（如果不存在）
        let workflow_path = ccpanes_dir.join("workflow.md");
        if !workflow_path.exists() {
            let default_workflow = self.get_default_workflow();
            fs::write(&workflow_path, default_workflow)
                .map_err(|e| format!("创建 workflow.md 失败: {}", e))?;
        }

        // 创建 journal index（如果不存在）
        let index_path = journal_dir.join("index.md");
        if !index_path.exists() {
            let default_index = self.get_default_journal_index();
            fs::write(&index_path, default_index)
                .map_err(|e| format!("创建 journal/index.md 失败: {}", e))?;
        }

        // 创建初始 journal 文件（如果不存在）
        let journal_path = journal_dir.join("journal-0.md");
        if !journal_path.exists() {
            let default_journal = self.get_default_journal();
            fs::write(&journal_path, default_journal)
                .map_err(|e| format!("创建 journal-0.md 失败: {}", e))?;
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

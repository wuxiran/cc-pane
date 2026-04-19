use std::fs;
use std::path::PathBuf;
use tracing::debug;

/// 项目上下文服务 - 管理 `.ccpanes` 下的 workflow 与 journal
pub struct ProjectContextService;

impl ProjectContextService {
    pub fn new() -> Self {
        Self
    }

    fn get_ccpanes_dir(project_path: &str) -> PathBuf {
        PathBuf::from(project_path).join(".ccpanes")
    }

    pub fn get_workflow(&self, project_path: &str) -> Result<String, String> {
        let workflow_path = Self::get_ccpanes_dir(project_path).join("workflow.md");

        if !workflow_path.exists() {
            return Err("workflow.md does not exist".to_string());
        }

        fs::read_to_string(&workflow_path).map_err(|e| format!("Failed to read workflow.md: {}", e))
    }

    pub fn save_workflow(&self, project_path: &str, content: &str) -> Result<(), String> {
        debug!("svc::save_workflow");
        let ccpanes_dir = Self::get_ccpanes_dir(project_path);

        fs::create_dir_all(&ccpanes_dir)
            .map_err(|e| format!("Failed to create .ccpanes directory: {}", e))?;

        let workflow_path = ccpanes_dir.join("workflow.md");

        fs::write(&workflow_path, content).map_err(|e| format!("Failed to save workflow.md: {}", e))
    }

    pub fn init_ccpanes(&self, project_path: &str) -> Result<(), String> {
        debug!("svc::init_ccpanes");
        let ccpanes_dir = Self::get_ccpanes_dir(project_path);
        let journal_dir = ccpanes_dir.join("journal");

        fs::create_dir_all(&journal_dir)
            .map_err(|e| format!("Failed to create directory: {}", e))?;

        let workflow_path = ccpanes_dir.join("workflow.md");
        if !workflow_path.exists() {
            fs::write(&workflow_path, self.get_default_workflow())
                .map_err(|e| format!("Failed to create workflow.md: {}", e))?;
        }

        let index_path = journal_dir.join("index.md");
        if !index_path.exists() {
            fs::write(&index_path, self.get_default_journal_index())
                .map_err(|e| format!("Failed to create journal/index.md: {}", e))?;
        }

        let journal_path = journal_dir.join("journal-0.md");
        if !journal_path.exists() {
            fs::write(&journal_path, self.get_default_journal())
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
"#
        .to_string()
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
"#
        .to_string()
    }

    fn get_default_journal(&self) -> String {
        r#"# Session Journal (Part 0)

> Managed by CC-Panes

---
"#
        .to_string()
    }
}

impl Default for ProjectContextService {
    fn default() -> Self {
        Self::new()
    }
}

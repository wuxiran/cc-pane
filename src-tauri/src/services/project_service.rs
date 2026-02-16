use crate::models::Project;
use crate::repository::ProjectRepository;
use std::path::PathBuf;
use std::sync::Arc;

/// 项目业务逻辑层 - 处理验证和业务规则
pub struct ProjectService {
    repo: Arc<ProjectRepository>,
}

impl ProjectService {
    pub fn new(repo: Arc<ProjectRepository>) -> Self {
        Self { repo }
    }

    /// 获取所有项目列表
    pub fn list_projects(&self) -> Result<Vec<Project>, String> {
        self.repo.list()
    }

    /// 添加新项目
    pub fn add_project(&self, path: &str) -> Result<Project, String> {
        // 验证路径存在
        let path_buf = PathBuf::from(path);
        if !path_buf.exists() {
            return Err("路径不存在".to_string());
        }

        // 验证是目录
        if !path_buf.is_dir() {
            return Err("路径不是目录".to_string());
        }

        // 检查是否已存在（可选，insert 也会检查）
        if self.repo.exists_by_path(path)? {
            return Err("项目已存在".to_string());
        }

        // 创建项目
        let project = Project::new(path);

        // 保存到数据库
        self.repo.insert(&project)?;

        Ok(project)
    }

    /// 删除项目
    pub fn remove_project(&self, id: &str) -> Result<(), String> {
        let deleted = self.repo.delete(id)?;
        if !deleted {
            return Err("项目不存在".to_string());
        }
        Ok(())
    }

    /// 获取单个项目
    pub fn get_project(&self, id: &str) -> Result<Option<Project>, String> {
        self.repo.get(id)
    }

    /// 更新项目名称
    pub fn update_project_name(&self, id: &str, name: &str) -> Result<(), String> {
        // 验证名称不为空
        if name.trim().is_empty() {
            return Err("项目名称不能为空".to_string());
        }

        let updated = self.repo.update_name(id, name)?;
        if !updated {
            return Err("项目不存在".to_string());
        }
        Ok(())
    }

    /// 更新项目别名
    pub fn update_project_alias(&self, id: &str, alias: Option<&str>) -> Result<(), String> {
        // 如果别名为空字符串，则设为 None
        let alias = alias.and_then(|a| {
            let trimmed = a.trim();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        });

        let updated = self.repo.update_alias(id, alias)?;
        if !updated {
            return Err("项目不存在".to_string());
        }
        Ok(())
    }
}

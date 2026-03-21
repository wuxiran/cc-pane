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
            return Err("Path does not exist".to_string());
        }

        // 验证是目录
        if !path_buf.is_dir() {
            return Err("Path is not a directory".to_string());
        }

        // 检查是否已存在（可选，insert 也会检查）
        if self.repo.exists_by_path(path)? {
            return Err("Project already exists".to_string());
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
            return Err("Project does not exist".to_string());
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
            return Err("Project name cannot be empty".to_string());
        }

        let updated = self.repo.update_name(id, name)?;
        if !updated {
            return Err("Project does not exist".to_string());
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
            return Err("Project does not exist".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::{Database, ProjectRepository};
    use std::sync::Arc;

    fn setup() -> (ProjectService, std::path::PathBuf) {
        let db = Arc::new(Database::new_in_memory().expect("创建内存数据库失败"));
        let repo = Arc::new(ProjectRepository::new(db));
        let service = ProjectService::new(repo);

        // 创建临时目录用于测试
        let temp_dir = std::env::temp_dir().join(format!("cc-panes-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).expect("创建临时目录失败");

        (service, temp_dir)
    }

    fn cleanup(temp_dir: &std::path::Path) {
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_add_project_success() {
        let (service, temp_dir) = setup();
        let path = temp_dir.to_str().unwrap();

        let result = service.add_project(path);
        assert!(result.is_ok());

        let project = result.unwrap();
        assert_eq!(project.path, path);
        assert!(!project.id.is_empty());

        cleanup(&temp_dir);
    }

    #[test]
    fn test_add_project_path_not_exists() {
        let (service, temp_dir) = setup();
        let path = temp_dir.join("non-existent").to_str().unwrap().to_string();

        let result = service.add_project(&path);

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Path does not exist");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_add_project_not_directory() {
        let (service, temp_dir) = setup();
        let file_path = temp_dir.join("test.txt");
        std::fs::write(&file_path, "test").unwrap();

        let result = service.add_project(file_path.to_str().unwrap());

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Path is not a directory");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_add_project_duplicate() {
        let (service, temp_dir) = setup();
        let path = temp_dir.to_str().unwrap();

        service.add_project(path).unwrap();
        let result = service.add_project(path);

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Project already exists");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_list_projects() {
        let (service, temp_dir) = setup();
        let dir1 = temp_dir.join("p1");
        let dir2 = temp_dir.join("p2");
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();

        service.add_project(dir1.to_str().unwrap()).unwrap();
        service.add_project(dir2.to_str().unwrap()).unwrap();

        let projects = service.list_projects().unwrap();
        assert_eq!(projects.len(), 2);

        cleanup(&temp_dir);
    }

    #[test]
    fn test_remove_project() {
        let (service, temp_dir) = setup();
        let project = service.add_project(temp_dir.to_str().unwrap()).unwrap();

        let result = service.remove_project(&project.id);
        assert!(result.is_ok());

        let projects = service.list_projects().unwrap();
        assert!(projects.is_empty());

        cleanup(&temp_dir);
    }

    #[test]
    fn test_remove_non_existent() {
        let (service, temp_dir) = setup();

        let result = service.remove_project("non-existent");

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Project does not exist");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_update_project_name() {
        let (service, temp_dir) = setup();
        let project = service.add_project(temp_dir.to_str().unwrap()).unwrap();

        let result = service.update_project_name(&project.id, "新名称");
        assert!(result.is_ok());

        let found = service.get_project(&project.id).unwrap().unwrap();
        assert_eq!(found.name, "新名称");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_update_project_name_empty() {
        let (service, temp_dir) = setup();
        let project = service.add_project(temp_dir.to_str().unwrap()).unwrap();

        let result = service.update_project_name(&project.id, "  ");

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Project name cannot be empty");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_update_project_alias() {
        let (service, temp_dir) = setup();
        let project = service.add_project(temp_dir.to_str().unwrap()).unwrap();

        // 设置别名
        service.update_project_alias(&project.id, Some("别名")).unwrap();
        let found = service.get_project(&project.id).unwrap().unwrap();
        assert_eq!(found.alias, Some("别名".to_string()));

        // 空字符串别名应被视为 None
        service.update_project_alias(&project.id, Some("  ")).unwrap();
        let found = service.get_project(&project.id).unwrap().unwrap();
        assert!(found.alias.is_none());

        cleanup(&temp_dir);
    }
}

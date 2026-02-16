# Tauri Security Checklist (CC-Panes)

> IPC 安全和桌面应用安全

---

## IPC Security

### Command Exposure

- [ ] 只暴露必要的命令（最小权限）
- [ ] 敏感操作需要确认（如删除工作空间）
- [ ] 命令参数已验证（非空、长度、格式）

### Input Validation

```rust
#[tauri::command]
async fn create_project(name: String, path: String) -> Result<Project, String> {
    // Validate inputs at command boundary
    if name.trim().is_empty() {
        return Err("Project name cannot be empty".into());
    }
    if !Path::new(&path).exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    // ... proceed
}
```

---

## File System Security

- [ ] 不允许访问应用数据目录之外的敏感路径
- [ ] 路径遍历防护（检查 `..` 等）
- [ ] 文件操作使用绝对路径

---

## Process Execution

- [ ] 不直接执行用户输入作为命令
- [ ] Git 命令参数已转义
- [ ] PTY 进程有超时和资源限制
- [ ] 子进程在应用退出时正确清理

---

## Data Security

- [ ] SQLite 数据库不存储密码明文
- [ ] API keys/tokens 加密存储或使用系统密钥链
- [ ] 错误消息不泄露内部路径或数据库结构
- [ ] 日志不包含敏感信息

---

## Tauri Configuration

检查 `tauri.conf.json`：

- [ ] `allowlist` 只启用需要的 API
- [ ] CSP (Content Security Policy) 已配置
- [ ] 不允许加载远程内容（除非必要）

---

## Pre-Commit Checklist

- [ ] 没有硬编码的密钥/Token
- [ ] 所有用户输入在 Command 层验证
- [ ] SQL 使用参数化查询
- [ ] 错误消息用户友好（不泄露内部信息）

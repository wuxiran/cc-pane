检查刚写的代码是否遵循后端开发规范。

执行步骤：
1. 运行 `git status` 查看修改的文件
2. 阅读 `.trellis/spec/backend/index.md` 了解适用的规范
3. 根据修改内容，阅读相关规范文件：
   - 数据库变更 → `.trellis/spec/backend/database-guidelines.md`
   - 错误处理 → `.trellis/spec/backend/error-handling.md`
   - 服务层变更 → `.trellis/spec/backend/service-guidelines.md`
   - 命令层变更 → `.trellis/spec/backend/command-guidelines.md`
   - 任何变更 → `.trellis/spec/backend/quality-guidelines.md`
4. 运行验证：
   ```bash
   cargo check --workspace
   cargo clippy --workspace -- -D warnings
   cargo test --workspace
   ```
5. 对比规范审查代码
6. 报告违规并修复

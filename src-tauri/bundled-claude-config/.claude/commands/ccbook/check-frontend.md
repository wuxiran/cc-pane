检查刚写的代码是否遵循前端开发规范。

执行步骤：
1. 运行 `git status` 查看修改的文件
2. 阅读 `.trellis/spec/frontend/index.md` 了解适用的规范
3. 根据修改内容，阅读相关规范文件：
   - 组件变更 → `.trellis/spec/frontend/component-guidelines.md`
   - Hook 变更 → `.trellis/spec/frontend/hook-guidelines.md`
   - 状态变更 → `.trellis/spec/frontend/state-management.md`
   - 类型变更 → `.trellis/spec/frontend/type-safety.md`
   - 任何变更 → `.trellis/spec/frontend/quality-guidelines.md`
4. 运行验证：
   ```bash
   npx tsc --noEmit
   npm run test:run
   ```
5. 对比规范审查代码
6. 报告违规并修复

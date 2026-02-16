# Frontend Quality Guidelines (CC-Panes)

> 代码标准和禁止模式

---

## TypeScript Strict Mode

项目启用了 `strict: true`，所有代码必须：

- 显式声明返回类型（公开函数）
- 不使用 `any`（用 `unknown` 后 type guard）
- 不使用 `!` 非空断言（用可选链 `?.`）

---

## File Size Limits

| 类型 | 建议 | 最大 |
|------|------|------|
| 组件 | <200 行 | 400 行 |
| Store | <150 行 | 300 行 |
| Service | <100 行 | 200 行 |
| Hook | <80 行 | 150 行 |
| 工具函数 | <50 行 | 100 行 |

---

## Import Order

```typescript
// 1. React
import { useState, useEffect } from 'react';
// 2. Third-party libraries
import { invoke } from '@tauri-apps/api/core';
// 3. Internal components
import { Button } from '@/components/ui/button';
// 4. Internal modules
import { useProjectsStore } from '@/stores/useProjectsStore';
import { projectService } from '@/services/projectService';
// 5. Types
import type { Project } from '@/types';
```

---

## Forbidden Patterns

```typescript
// 1. Direct invoke in components
// BAD
function MyComponent() {
  const data = await invoke('get_project', { id });
}
// GOOD: use service layer
function MyComponent() {
  const data = await projectService.getById(id);
}

// 2. Mutation
// BAD
projects.push(newProject);
// GOOD
set((state) => { state.projects.push(newProject); }); // Immer

// 3. Any type
// BAD
const data: any = await service.fetch();
// GOOD
const data: Project = await service.fetch();
```

---

## Verification Commands

```bash
npx tsc --noEmit        # TypeScript 类型检查
npm run build            # 构建验证
npm run test:run         # 运行测试
```

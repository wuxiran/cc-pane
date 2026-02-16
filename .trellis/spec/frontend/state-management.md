# State Management (CC-Panes)

> Zustand 5 + Immer middleware

---

## Overview

CC-Panes 使用 Zustand + Immer 进行全局状态管理。状态通过 Service 层与 Tauri 后端同步。

---

## Store Template

```typescript
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { projectService } from '@/services/projectService';
import type { Project } from '@/types';

interface ProjectsState {
  projects: Project[];
  loading: boolean;
  error: string | null;

  loadProjects: (workspaceId: string) => Promise<void>;
  addProject: (project: Project) => void;
  removeProject: (id: string) => void;
}

export const useProjectsStore = create<ProjectsState>()(
  immer((set) => ({
    projects: [],
    loading: false,
    error: null,

    loadProjects: async (workspaceId) => {
      set((state) => { state.loading = true; state.error = null; });
      try {
        const projects = await projectService.getByWorkspace(workspaceId);
        set((state) => { state.projects = projects; state.loading = false; });
      } catch (error) {
        set((state) => {
          state.error = String(error);
          state.loading = false;
        });
      }
    },

    addProject: (project) => set((state) => {
      state.projects.push(project);
    }),

    removeProject: (id) => set((state) => {
      state.projects = state.projects.filter(p => p.id !== id);
    }),
  }))
);
```

---

## State Categories

| 类型 | 存放位置 | 示例 |
|------|---------|------|
| UI 状态 | `useState` / Zustand | 弹窗开关、选中项 |
| 领域状态 | Zustand Store | projects, workspaces |
| 后端同步 | Store + Service | CRUD 操作 |
| 表单状态 | `useState` | 输入框值 |

---

## Key Rules

1. **Immer 风格更新**: `set((state) => { state.x = y })` — 看起来可变，实际不可变
2. **Service 层分离**: Store 中的异步操作通过 `services/` 层调用 invoke
3. **Selector 优化**: 使用 selector 避免不必要的重渲染

```typescript
// Good: 只订阅需要的字段
const projectName = useProjectsStore(state =>
  state.projects.find(p => p.id === id)?.name
);

// Bad: 订阅整个 store
const { projects, loading, error } = useProjectsStore();
```

4. **单一职责**: 每个 Store 管理一个领域

---

## Forbidden

- 不要在 Store 中直接调用 `invoke()` — 通过 Service 层
- 不要在组件 render 中调用 Store action — 用 useEffect
- 不要把 UI 临时状态放到全局 Store

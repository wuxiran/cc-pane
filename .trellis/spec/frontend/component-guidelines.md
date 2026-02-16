# Component Guidelines (CC-Panes)

> React 19 函数组件规范

---

## Component Structure

```tsx
// 1. Imports
import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useProjectsStore } from '@/stores/useProjectsStore';

// 2. Types (if component-specific)
interface ProjectCardProps {
  projectId: string;
  onSelect: (id: string) => void;
}

// 3. Component
export function ProjectCard({ projectId, onSelect }: ProjectCardProps) {
  // Hooks first
  const project = useProjectsStore(state =>
    state.projects.find(p => p.id === projectId)
  );

  // Event handlers
  const handleClick = useCallback(() => {
    onSelect(projectId);
  }, [projectId, onSelect]);

  // Early returns
  if (!project) return null;

  // Render
  return (
    <div className="rounded-lg border p-4" onClick={handleClick}>
      <h3>{project.name}</h3>
    </div>
  );
}
```

---

## Props Conventions

- 使用 `interface` 定义 Props（不用 `type`）
- Props 名以 `on` 开头表示回调（`onSelect`, `onClose`）
- 避免传递超过 5 个 Props（考虑组合或 Context）
- 复杂 Props 使用 types/ 中的共享类型

---

## Styling

- 使用 **Tailwind CSS 4** 原子类
- 使用 **shadcn/ui** 组件作为基础
- 使用 `cn()` 合并类名（from `@/lib/utils`）
- 不使用 CSS Modules 或 styled-components

```tsx
import { cn } from '@/lib/utils';

<div className={cn(
  "flex items-center gap-2",
  isActive && "bg-accent",
  className
)} />
```

---

## Common Mistakes

1. **在组件中直接 invoke** — 必须通过 `services/` 层
2. **Store 订阅过宽** — 使用 selector 只订阅需要的字段
3. **忘记 useCallback/useMemo** — 传给子组件的回调需要 memo

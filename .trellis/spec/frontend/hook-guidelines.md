# Hook Guidelines (CC-Panes)

> Custom React Hooks 规范

---

## Naming

- 以 `use` 开头
- 描述功能而非实现: `useTerminalSize` 而非 `useResizeObserver`
- 放在 `src/hooks/` 目录

---

## Common Patterns

### 数据获取 Hook

```typescript
export function useProjects(workspaceId: string) {
  const { projects, loading, error, loadProjects } = useProjectsStore();

  useEffect(() => {
    loadProjects(workspaceId);
  }, [workspaceId, loadProjects]);

  return { projects, loading, error };
}
```

### 事件监听 Hook (Tauri Events)

```typescript
import { listen } from '@tauri-apps/api/event';

export function useTauriEvent<T>(event: string, handler: (payload: T) => void) {
  useEffect(() => {
    const unlisten = listen<T>(event, (e) => handler(e.payload));
    return () => { unlisten.then(fn => fn()); };
  }, [event, handler]);
}
```

### Cleanup Hook

```typescript
export function useTerminal(containerId: string) {
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const terminal = new Terminal(/* ... */);
    terminalRef.current = terminal;
    return () => { terminal.dispose(); };
  }, [containerId]);

  return terminalRef;
}
```

---

## Rules

1. **Cleanup**: 有副作用的 Hook 必须返回清理函数
2. **依赖数组**: 明确列出所有依赖，不使用 `// eslint-disable`
3. **单一职责**: 一个 Hook 做一件事
4. **不要在 Hook 中调用 invoke()**: 通过 Store action 或 Service

---

## Forbidden

- 不要在条件语句中调用 Hook
- 不要在 Hook 中直接操作 DOM（用 ref）
- 不要创建返回 JSX 的 Hook（那是组件）

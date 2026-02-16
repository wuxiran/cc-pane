# Frontend Directory Structure

> CC-Panes 前端代码组织规范

---

## Structure

```
src/
├── main.tsx                    # 应用入口
├── App.tsx                     # 根组件（布局 + Dialog 挂载）
├── components/                 # React 组件
│   ├── panes/                  # 分屏终端组件
│   │   ├── PaneContainer.tsx   # 分屏容器
│   │   ├── Panel.tsx           # 单面板
│   │   ├── SplitContainer.tsx  # 分割容器
│   │   ├── TabBar.tsx          # 标签栏
│   │   └── TerminalView.tsx    # 终端视图 (xterm.js)
│   ├── sidebar/                # 侧边栏组件
│   ├── settings/               # 设置子组件
│   └── ui/                     # shadcn/ui 基础组件
├── stores/                     # Zustand 状态管理
│   ├── usePanesStore.ts        # 分屏状态
│   ├── useProjectsStore.ts     # 项目状态
│   ├── useWorkspacesStore.ts   # 工作空间状态
│   └── useSettingsStore.ts     # 设置状态
├── services/                   # 前端服务层（invoke 封装）
│   ├── projectService.ts
│   ├── workspaceService.ts
│   └── terminalService.ts
├── hooks/                      # 自定义 Hooks
├── types/                      # TypeScript 类型定义
│   └── index.ts                # 汇总导出
├── lib/                        # 工具库
└── utils/                      # 工具函数
```

---

## Conventions

1. **按功能分组**: components/ 下按功能域划分子目录（panes/, sidebar/, settings/）
2. **Co-located 测试**: `ComponentName.test.tsx` 与 `ComponentName.tsx` 同目录
3. **单一导出**: 每个文件导出一个主要组件/函数
4. **Index 导出**: types/ 通过 `index.ts` 汇总导出

---

## Forbidden

- 不要在 `components/` 中放置业务逻辑（放 `services/` 或 `stores/`）
- 不要在组件中直接调用 `invoke()`（通过 `services/` 封装）
- 不要创建 `utils/` 下的超大文件（>200 行拆分）

# 空态插画体系（Empty Illustrations）

空态视觉分两层：`EmptyState`（`web/components/ui/EmptyState.tsx`）负责标题/描述/动作排版，
`empty-illustrations.tsx`（同目录）提供一组轻量线稿 SVG，按语义复用。

## 插画语义清单

| 语义名 | 组件 | 用途 |
| --- | --- | --- |
| `empty-folder` | `EmptyFolderIllustration` | 目录/文件为空（文件树、项目无文件） |
| `empty-terminal` | `EmptyTerminalIllustration` | 无终端/无面板（分屏空槽、终端未启动） |
| `empty-search` | `EmptySearchIllustration` | 搜索/筛选无结果 |
| `empty-history` | `EmptyHistoryIllustration` | 无历史记录（会话、版本、启动历史） |
| `empty-box` | `EmptyBoxIllustration` | 通用空（列表为空兜底） |
| `error-cloud` | `ErrorCloudIllustration` | 加载失败/离线（非阻断，可配重试动作） |

## 用法

```tsx
import { EmptyState } from "@/components/ui/EmptyState";

// 传语义名（推荐）
<EmptyState icon={PackageSearch} title={t("empty.title")} illustration="empty-search" />

// 或传插画组件
import { EmptyBoxIllustration } from "@/components/ui/empty-illustrations";
<EmptyState icon={ListTodo} title={t("noTasks")} illustration={EmptyBoxIllustration} />
```

- 不传 `illustration` 时渲染细描边图标 chip，行为与旧版完全一致（向后兼容）。
- 传了插画则替代图标 chip，排版为插画在上、标题/描述/动作在下。
- 可选 `accent` 类名透传到插画 svg（经 `twMerge` 合并，可覆盖默认的 `h-20 w-20` 尺寸或 `text-[var(--app-text-tertiary)]` 颜色），仅在使用插画时生效；不传时默认外观不变。示例：首页活跃会话空态用 `accent="h-24 w-24 xl:h-28 xl:w-28"` 放大 `empty-terminal` 插画。
- 文案（`title`/`description`/`action.label`）仍由调用方按既有 i18n（zh-CN / en）传入，插画本身无文案。

## 约束

- 插画为纯装饰，一律 `aria-hidden="true"`，语义由 EmptyState 文案表达。
- 线稿 `stroke="currentColor"`，颜色随父级 `text-[var(--app-text-tertiary)]`；填充只用 token 色（`var(--app-*)`）或 `none`，禁裸 hex。
- 统一 `viewBox="0 0 96 96"`、1.5px 线宽、圆角线帽/线脚；展示尺寸经 `className` 控制。
- 行内小提示（纯文本空态）不强套插画；新增语义请先在 `empty-illustrations.tsx` 注册再引用。

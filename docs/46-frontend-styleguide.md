# 46. CC-Panes 前端风格宪法

> 本文是 UI/视觉/交互的**决策规则文档**——回答“该用什么、何时用、不许用什么”。token 具体值以 `web/assets/index.css` 为唯一真源；分区/明度/巨石拆分史见 [docs/22](./22-frontend-design-refactor.md)；与竞品的对照论证见 [docs/45](./45-orca-frontend-comparison.md)。
> **约束力**：所有 UI 类改动（人写或 AI worker 写）提交前对照本文；派工 prompt 应回引本文。机器护栏拦截的是底线，本文覆盖测试拦不住的判断题。
> **标记约定**：带 `[目标态:P0-x/P1-x]` 的规则指向尚未落地的组件/测试——在对应改进项完成前，按“最接近的现有做法”执行，落地后强制切换。其余规则当前即生效。

## 0. 三条铁律

1. 能用现有语义 token（`--app-*` / shadcn 变量）就不写 hex；需要新 token 先加进 `index.css` 亮暗两套再用。
2. 能用 `web/components/ui/` 现有原语（含 IconTooltipButton/EmptyState/InlineRename/skeleton 四个规范件）就不手搓；缺原语先补原语再用。
3. 视觉哲学：**工具应退后**——中性色承载 chrome，颜色留给状态与身份。文件类型色、进程分类色、收藏/默认的金色星标等内容分类与品牌色不受“仅状态”限制，但新增内容分类色需先立 token 再用。终端/编辑器是主角，我们的 UI 是画框。

## 1. 决策表一：浮层/交互原语选择

| 你想要… | 用 | 不要用 |
|---|---|---|
| 图标按钮的悬停命名 | `IconTooltipButton`（规范件，禁原生 `title=`） | Tooltip 手拼、HoverCard |
| 点击展开的动作菜单 | `DropdownMenu` | Popover 里手搓列表 |
| 右键上下文动作 | `ContextMenu` | DropdownMenu（触发方式不同） |
| 点击展开的任意内容面（表单/选择器） | `Popover` | Dialog（会锁焦点+压暗） |
| 必须先做决定才能继续的模态 | `Dialog`；全局可唤起的经 useDialogStore 管理，局部确认框由组件自持 | Popover、内联遮罩 |
| 从边缘滑入的抽屉 | `Sheet` | 居中 Dialog |
| 已知列表单选 | shadcn/Radix select 封装 `[目标态:补入 ui/]`；落地前用现有 DropdownMenu 单选模式 | 自造 listbox |
| 带搜索的单选 | `Command`（cmdk）套 Popover | 无搜索 select |
| 瞬态确认（“已保存/已复制”） | `sonner` toast | Dialog、内联横幅 |
| 持久内联状态（“3 个错误”） | 内联文本 + `Badge` | toast（会消失） |
| 列表空态 | `EmptyState`（必须给直接获取/配置数据的动作按钮） | 裸文本“暂无数据” |
| 加载占位 | `skeleton` 拼贴 | 满屏 spinner |

发现自己在“把 Popover 改造得像 Dialog”（或反向）——停下，换原语。焦点语义不同，硬凹会误导下一个维护者。

## 2. 决策表二：in-flight 反馈按感知时长分级

| 时长 | 反馈 |
|---|---|
| 0–100ms | **无**。任何可见反馈都像 glitch |
| 100ms–1s | 仅禁用态（防双击双提交） |
| 1–3s | 禁用 + spinner 或标签替换 |
| 3s+ / 多步 | **阶段标签**（“克隆中…”→“安装中…”），不许无标签转圈 |

- **预留足迹**：控件若会换更长标签/长出图标，事先用 `width` 固定尺寸（不是 min-width）。
- **本地快远程慢的动作**（WSL/SSH）：禁用态立即绑定，可见 loading 延迟约 200ms 再显。
- 会话生命周期状态一律走状态色+徽章，不用长期旋转表达；未来引入长期旋转指示时必须共享单一动画源。

## 3. 决策表三：状态色四分类使用场景

| 类别 | token | 用于 | 不用于 |
|---|---|---|---|
| 成功/警告/危险 | `--app-status-success/warning/danger` | 结果态：完成/需注意但可等/失败与破坏性操作 | 装饰、hover、身份 |
| 信息/运行/激活 | `--app-accent` | 进行中、选中、链接性强调 | 成功语义 |
| 身份 | `--app-identity-wsl/ssh` | 运行时身份徽章 | 状态表达 |
| 中性 | `--app-text-primary/secondary/tertiary` | 三层文字明度 | 彩色降级 |

终端生命周期与任务结果不得混用一张状态表。`completed` 才使用 success；`idle` 是中性事实；等待输入使用琥珀且必须有形状或文字冗余表达。

## 4. 列表行三态约定

- **Idle**：透明背景。
- **Hover**：accent 背景（侧栏内用侧栏自己的 accent 变量）。
- **键盘选中**（cmdk）：`data-[selected=true]` 的 accent + 边框描边。
- **持久“当前”行**：accent + `data-current="true"` 属性区分于键盘高亮。
- **禁止**：硬编码 `bg-[#...]` 或发明新“选中色”。

## 5. 排版与图标

- UI 字体 Inter Variable / 终端 Maple Mono NF CN，不引第三字体；`font-feature-settings` 已调优勿覆盖。
- 尺寸用途：11px（大写元信息，配 600 字重 + 0.05em 字距）/ 12px（次级、路径）/ 13px（侧栏行、密集列表）/ 14px（正文与默认按钮）。
- 图标只用 lucide；默认 `size-4`，元信息 `size-3`~`3.5`，空态主视觉才许 `size-7+`；颜色继承外层文字色。
- 阴影三级封顶；需要第四级说明其实需要的是焦点 ring。
- 动效只用 token；UI 永不用 ease-in；动画服务连续性不服务装饰；尊重 `prefers-reduced-motion`。

## 6. 表单解剖与软卡片

- 一个设置 pane 只保留一套页面标题：大标题在上，已有说明作为 12px muted 文案紧随其下；Section 内不得重复标题。
- 设置块按逻辑分组进入 8px 圆角的软卡片带，使用 `--app-panel-bg` / `--app-border` / `shadow-sm`；已有独立卡片体系的 pane 不再套外层卡片，禁止卡片嵌套。
- 标准字段是“label 组 → 控件 → 尾部元数据”：label 与说明组成一组；当前值、默认值、路径、状态等 11px–12px 元数据必须放在控件下方，不得挤在 label 旁边。
- 整段表单使用 `space-y-3`，紧凑字段内部使用 `space-y-2`；同一 pane 不得混用无规律的 1px/2px/3px 间距。
- 按钮优先级必须反映动作语义：主动作 default，普通次级动作 secondary/outline，退出路径 ghost/outline；Cancel/Dismiss 绝不使用 destructive。
- 表单搜索锚点使用 `data-settings-section`；被搜索命中的控件组可高亮，但不得因高亮改变控件尺寸或导致布局跳动。

## 7. 文案规则

- 不许 overclaim：只有拿到真实结果数据才用结果动词；进行中用中性过程语。
- 双语同步是硬约束：新增用户可见文案必须同时进入 en 与 zh-CN 对应 namespace。
- 删除填充词：请、只需、简单地、你可以。
- 快捷键展示必须匹配平台真实绑定；宁可不显示也不显示错的。

## 8. UX 评审 rubric

评审输出：最高影响的修改、具名摩擦点、具体改法、键盘与速度检查、缺失的跟进链接/获取动作。

- 高频动作可见且突出，低频动作进入菜单/overflow/高级区。
- 主动作靠位置/尺寸/default 样式可辨；Cancel/Dismiss/关闭永远安静。
- 应用已有足够信息时，常见流程 1–2 步完成。
- 对话框聚焦最可能使用的字段；Enter 落在主动作，Esc 干净退出。
- 行列对网格；文本左对齐、数字/计数/快捷键右对齐。
- 缺数据给直接获取动作；瞬态错误 toast，需读需重试的错误内联持久。
- WSL/SSH 动作按 §2 的延迟策略，远程数据到达时保持焦点稳定。

## 9. 跨平台与无障碍判据

- 每个 UI 改动在 Windows/macOS/Linux × 亮/暗主题下成立；桌面壳与 Web 壳共享的代码不得依赖仅桌面可用 API。
- 不硬编码 metaKey/ctrlKey；快捷键标签匹配平台真实绑定。
- 状态不可只靠颜色，必须色 + 形冗余表达。
- 图标按钮必须有 accessible name；可交互元素必须有可见 focus ring。
- 文字层用 `--app-text-*` 三级，不自调透明度制造低对比灰字。

## 10. 红线

- TerminalView 渲染生命周期（init 闭包/onData/fit）一概不碰。
- Zustand selector 不返回新集合。
- Windows 终端渲染器 auto 档默认 DOM；用户显式选择 WebGL 属高级选项，受可用性与恢复策略约束。
- 新增色值必须通过色值护栏；hex/任意值必须有精确、可审计的例外理由。

## 11. 本文沉默时

1. 看同域最近的兄弟组件，跟它走。
2. 查 `web/components/ui/` 有无已编码该模式的原语。
3. token 问题以 `index.css` 为准。
4. 都解决不了：问用户，不发明。

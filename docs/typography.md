# 排版系统 2.0 — 语义字号阶梯

> 给现状字号命名。token 化不是改设计：**默认渲染结果必须与现状逐像素一致**。

## 阶梯定义

定义于 `web/assets/index.css` 的 `:root`（紧随 `--density-*` 块之后）：

| Token | 值 | 众数依据（全库 text-\* 类统计） | 语义与典型场景 |
|---|---|---|---|
| `--text-caption` | 11px | `text-[11px]` ×342，任意值第一众数 | 状态栏、辅助说明、徽标补充文 |
| `--text-small` | 12px | `text-xs` ×598 + `text-[12px]` ×114 = 712，全库第一大渲染字号 | 次要列表文、徽标、密集表格 |
| `--text-body` | 14px | `text-sm` ×220 + 全局 `body{font-size:14px}` | 正文、表单控件、按钮、标签 |
| `--text-title` | 15px | `text-[15px] font-semibold` ×15（全部配套 semibold） | 小节标题、卡片标题，**配套 `font-semibold`** |
| `--text-display` | 20px | `text-[20px]`（移动端视图标题同义） | 页面级标题 |
| `--text-hero` | 30px | 首页主标题响应区间 `28→30→32px` 的中位档 | 首页/空态主标题，配套 `font-bold` |

全局 `body { font-size: var(--text-body) }` 已收敛到 token（原硬编码 14px，同值），阶梯即单点真源。

### 为什么 body 取 14px 而不是 13px

任务书的 `≈13px` 是近似提示，实际取值以众数为准：

- 14px：`text-sm` ×220 + `text-[14px]` ×7 = **227 处**，且是全局 body 基准字号与
  shadcn 基件（button/label/input 等）的内置正文档；
- 13px：`text-[13px]` ×164 处，集中在侧栏等 chrome 区域。

取 14px 让阶梯能覆盖 `ui/button`、`ui/label`、`ui/input` 三个基件的正文档；
取 13px 则这三个文件无一处可精确替换。**13px 现状值一律保留不动**（见下「未入阶梯的现存值」），
是否与 14px 收敛是推广期的独立设计决策，不在本次 token 化范围内。

## 命名与同步策略（为什么叫 `--text-*` 而不是 `--app-*`）

1. **不触发六块同步规则**：`web/test/colorGuard.test.ts` 的块同步规则（`:root`↔`.dark` 全等、
   `[data-theme]` 子集一致）只匹配 `--app-*` 前缀的正则。字号与颜色正交——暗色与十个
   `[data-theme]` 主题共用同一套字号——若走 `--app-*` 前缀，按规则就得在 `.dark` 整块复制，
   纯属无意义重复并引入漂移面。`--text-*` 无前缀命名让字号阶梯对该规则天然不可见，
   与 `--density-*` 的先例一致（正交 token 只在 `:root` 单点定义）。
2. **命名空间不撞车**：`--app-text-primary/secondary/tertiary` 已是文字**颜色** token；
   字号塞进 `--app-text-*` 会与颜色语义混淆。
3. **符合 Tailwind 4 习惯**：`--text-*` 是 Tailwind 默认主题的字号命名空间
   （`--text-xs`、`--text-sm`…），读者无学习成本。自定义名
   （caption/small/body/title/display/hero）与默认键无冲突。

### 为什么定义在 `:root` 而不是 `@theme`

- 消费方式统一为显式任意值引用 `text-[length:var(--text-*)]`，只需要运行期 CSS 变量；
- 放进 `@theme` 会额外生成 `text-caption` 等 Tailwind 工具类，产生**第二条消费路径**，
  绕过护栏测试强制约束的引用形式；
- `--density-*` 先例同样落在 `:root`。

## 消费范式（推广时必须照抄）

### 正确形式：带 `length:` 类型提示

```html
<!-- 正确：编译为 font-size: var(--text-body) -->
<span class="text-[length:var(--text-body)]">

<!-- 错误：Tailwind 把裸 var() 判为 color，编译为 color: var(--text-body)，字号静默丢失 -->
<span class="text-[var(--text-body)]">
```

`text-*` 在 Tailwind 中同时映射 font-size 与 color；裸 `var()` 无法静态推断类型，
实测 tailwindcss 4.1.18 落到 color 分支（全库 `text-[var(--app-text-primary)]`
取色即依赖此行为）。`designTokens.test.ts` 的「全库无裸 `text-[var(--text-*)]`」
用例会把这条陷阱挡在 CI。

### 行高配套规则（逐像素一致的关键）

Tailwind 4 的具名 `text-xs/sm/base/...` **捆绑行高**，任意值 `text-[11px]` 不捆绑。
替换时必须按原类补齐，否则行高从捆绑值掉到继承值（body 的 1.5），渲染就变了：

| 原类 | 原渲染（字号/行高） | 替换为 |
|---|---|---|
| `text-xs` | 12px / 16px | `text-[length:var(--text-small)] leading-4` |
| `text-sm` | 14px / 20px | `text-[length:var(--text-body)] leading-5` |
| `text-base` | 16px / 24px | （未入阶梯，保留原类） |
| `text-[11px]` | 11px / 继承 | `text-[length:var(--text-caption)]` |
| `text-[12px]` | 12px / 继承 | `text-[length:var(--text-small)]` |
| `text-[15px]`（配 `font-semibold`） | 15px / 继承 | `text-[length:var(--text-title)]` |
| `text-[20px]` | 20px / 继承 | `text-[length:var(--text-display)]` |
| `text-[30px]` | 30px / 继承 | `text-[length:var(--text-hero)]` |

原类已带显式行高时（如 `text-sm leading-none`），只换字号、保留原行高类
（`leading-none` 优先级已覆盖捆绑值，替换后行为不变）。

### 推广三铁律

1. **精确匹配现状值的类才许换**——渲染值必须与阶梯档位完全相等；
2. **禁止顺手改字号**——`text-[13px]` → `--text-body`（14px）这类「顺手收敛」是改设计，
   一律禁止；
3. **未入阶梯的值原样保留**，并在下方清单登记处置状态。

### 未入阶梯的现存值（保留原样，勿顺手替换）

| 值 | 出现 | 处置 |
|---|---|---|
| `text-[10px]` | ×254 | 保留；是否增设 micro 档留待推广期决策 |
| `text-[13px]` | ×164 | 保留；与 body(14px) 的关系是独立设计决策 |
| `text-[9px]` / `text-[9.5px]` | ×39 | 保留（长尾极小字） |
| `text-[11.5px]` / `text-[12.5px]` | ×41 | 保留（半像素调谐档） |
| `text-base`（16px） | ×15 | 保留；`ui/input` 移动端聚焦防 iOS 缩放依赖 ≥16px |
| `text-lg`（18px）/ `text-[18px]` | ×12 | 保留 |
| `text-2xl`（24px）/ `text-[28px]` / `text-[32px]` | 少量 | 保留；hero 响应区间端点按断点取值 |
| 其余长尾（5/8/10.5/13.5/14/17px） | 少量 | 保留 |

## 行高 token（本次刻意不建）

现状行高三套并存：具名类捆绑值（16/20/24px…）、任意值继承 body 的 1.5、
散写的 `leading-*` 类。语义化 `--leading-*` 需要先把这三套归一，属于改设计，
超出「给现状命名」的范围。本次只在替换具名类时用 `leading-4/5` 等值保住现状像素。
后续若做行高阶梯，命名同样走无前缀 `--leading-*`（与 `--text-*` 同策略）。

## 已接入文件（首批示范）

| 文件 | 替换点 |
|---|---|
| `web/components/ui/button.tsx` | 基础档 `text-sm`→body+leading-5；`xs` 档 `text-xs`→small+leading-4 |
| `web/components/ui/badge.tsx` | `text-xs`→small+leading-4 |
| `web/components/ui/input.tsx` | `file:text-sm`/`md:text-sm`→body（`text-base` 防缩放保留） |
| `web/components/ui/label.tsx` | `text-sm`→body（原 `leading-none` 保留） |
| `web/components/StatusBar.tsx` | 根容器 `text-[11px]`→caption（`text-[10px]` 保留） |
| `web/components/TitleBar.tsx` | 两处 `text-[12px]`→small（`text-[13px]`/`text-[12.5px]` 保留） |

## 守护测试

`web/components/designTokens.test.ts` 的 `typography tokens` 块：

1. `:root` 六级 token 存在且取值锁定（11/12/14/15/20/30px）；
2. `body{font-size}` 引用 `--text-body`；
3. 字号 token 不渗入 `.dark` 与各 `[data-theme]` 块（与颜色正交）；
4. 六个示范文件的消费片段、已替换裸类消散、未阶梯化值原样保留；
5. 全库无裸 `text-[var(--text-*)]`（缺 `length:` 会被编译成 color）。

`web/test/colorGuard.test.ts` 的六块同步规则只匹配 `--app-*`，对 `--text-*`
天然不触发——这是命名决策的一部分，不是绕过测试。

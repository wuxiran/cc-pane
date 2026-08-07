# CC-Panes 配色与形态文案评审稿

> 状态：DRAFT - 等待产品文案确认  
> 文档类型：产品与界面文案，不是 PRD  
> 读者：产品负责人、设计与实现人员  
> 预计阅读时间：5 分钟  
> 评审结果：确认功能命名、六种形态、默认项、提示语和展示范围

## 1. 产品定义

### 中文

配色与形态是两项独立的外观设置。

- **配色**决定背景、文字、强调色和状态色。
- **形态**决定圆角、边界、阴影和表面材质。

用户可以保留熟悉的配色，只改变工作台的边角、分隔线和表面处理。例如，“午夜蓝”既可以搭配“柔和 Soft”，也可以搭配“直角 Sharp”或“玻璃 Glass”。

### English

Color theme and interface shape are independent appearance settings.

- **Color theme** controls backgrounds, text, accents, and status colors.
- **Interface shape** controls corners, dividers, shadows, and surface treatment.

Users can keep the colors they know while changing workspace corners, dividers, and surface treatment. For example, Midnight Blue can be paired with Soft, Sharp, or Glass.

### 评审检查

- [ ] “配色”和“形态”的职责没有重叠。
- [ ] 文案没有暗示形态会改变布局、字号或终端主题。

## 2. 设置页层级

设置导航仍使用现有名称：

| 中文 | English |
|---|---|
| 主题 | Theme |

页面标题从“主题风格”调整为：

| 中文 | English |
|---|---|
| 配色与形态 | Color & Shape |

页面说明：

| 中文 | English |
|---|---|
| 分别选择界面配色和结构形态。两项可以自由组合，修改后立即生效并自动保存。 | Choose the color theme and interface shape separately. Any combination can be used, and changes apply immediately and save automatically. |

### 评审检查

- [ ] 用户进入现有“主题”页面即可找到形态，不新增设置导航项。
- [ ] 页面首屏先展示配色，再展示形态。

## 3. 配色区域

区域标题：

| 中文 | English |
|---|---|
| 配色主题 | Color theme |

区域说明：

| 中文 | English |
|---|---|
| 控制应用的背景、文字、强调色和状态色。 | Controls application backgrounds, text, accents, and status colors. |

现有配色名称保持不变：午夜蓝、霓虹紫、熔金黑、雪原白、暖雾灰、晴空蓝和跟随系统。

### 评审检查

- [ ] 现有配色名称和选择结果保持不变。
- [ ] 切换形态不会改写用户已经选择的配色。

## 4. 形态区域

区域标题：

| 中文 | English |
|---|---|
| 界面形态 | Interface shape |

区域说明：

| 中文 | English |
|---|---|
| 调整界面的边角、分隔线和表面材质，不改变当前配色。 | Adjusts corners, dividers, and surface treatment without changing the current color theme. |

组合说明：

| 中文 | English |
|---|---|
| 配色与形态相互独立，可以自由组合。 | Color theme and interface shape are independent and can be combined freely. |

### 4.1 柔和 Soft

| 项目 | 中文 | English |
|---|---|---|
| 名称 | 柔和 Soft | Soft |
| 描述 | 保留 CC-Panes 当前的圆角与轻边界，升级后外观不变。 | Keeps the current CC-Panes corner treatment and light borders, so the upgrade does not change the existing appearance. |
| 标记 | 默认 | Default |

### 4.2 层板 Slab

| 项目 | 中文 | English |
|---|---|---|
| 名称 | 层板 Slab | Slab |
| 描述 | 缩小圆角，用轻微的上下沿明暗区分相邻面板。 | Uses tighter corners and subtle top-and-bottom edge contrast to distinguish adjacent panels. |
| 标记 | - | - |

### 4.3 直角 Sharp

| 项目 | 中文 | English |
|---|---|---|
| 名称 | 直角 Sharp | Sharp |
| 描述 | 取消容器圆角，让标签、侧栏和面板贴齐网格。 | Removes container rounding so tabs, sidebars, and panels align to the grid. |
| 标记 | - | - |

### 4.4 玻璃 Glass

| 项目 | 中文 | English |
|---|---|---|
| 名称 | 玻璃 Glass | Glass |
| 描述 | 标题栏、侧栏和浮层采用半透明磨砂；终端与输入框保持实底。 | Uses translucent, blurred chrome for the title bar, sidebar, and overlays while keeping terminals and inputs solid. |
| 标记 | 适合壁纸 | Pairs with wallpaper |

### 4.5 面板 Panel

| 项目 | 中文 | English |
|---|---|---|
| 名称 | 面板 Panel | Panel |
| 描述 | 使用直角和更清晰的分隔线，强化多窗格与工具区域的边界。 | Uses square corners and clearer dividers to define panes and tool regions. |
| 标记 | - | - |

### 4.6 碳纹 Carbon

| 项目 | 中文 | English |
|---|---|---|
| 名称 | 碳纹 Carbon | Carbon |
| 描述 | 在半透明表面叠加低对比几何纹理，同时保持终端内容清晰。 | Adds a low-contrast geometric texture to translucent surfaces while keeping terminal content clear. |
| 标记 | 适合壁纸 | Pairs with wallpaper |

### 评审检查

- [ ] 六张卡片的差异可以通过文字直接理解。
- [ ] Soft 是默认形态，升级后保持现有视觉。
- [ ] Glass 和 Carbon 明确提示与壁纸的关系。

## 5. 辅助文案

形态区域底部说明：

| 中文 | English |
|---|---|
| 形态不会改变配色主题、终端主题、字体、字号或窗格布局。 | Interface shape does not change the color theme, terminal theme, fonts, text size, or pane layout. |

Glass 与 Carbon 提示：

| 中文 | English |
|---|---|
| 开启壁纸后效果更明显；未开启时继续使用当前主题背景。 | The effect is more visible with a wallpaper. Without one, surfaces continue to use the current theme background. |

恢复动作：

| 场景 | 中文 | English |
|---|---|---|
| 按钮 | 恢复默认形态 | Restore default shape |
| 完成提示 | 已恢复为柔和 Soft | Restored to Soft |

模糊效果不可用时：

| 中文 | English |
|---|---|
| 当前环境不支持背景模糊，已保留半透明层次。 | Background blur is unavailable in this environment. Translucent surfaces remain enabled. |

### 评审检查

- [ ] 提示语说明实际结果，不使用“高级”“沉浸”等无法验收的形容词。
- [ ] 环境降级不会被描述为错误或失败。

## 6. 功能发现文案

### 功能提示

| 项目 | 中文 | English |
|---|---|---|
| 标题 | 试试界面形态 | Try interface shapes |
| 正文 | 保留当前配色，只改变界面的边角、分隔线和表面材质。 | Keep your current colors and change only the corners, dividers, and surface treatment. |
| 动作 | 打开主题设置 | Open theme settings |

### 版本更新说明

| 项目 | 中文 | English |
|---|---|---|
| 标题 | 配色与形态现在可以自由组合 | Color and shape can now be combined freely |
| 正文 | 在六种配色之外，新增柔和、层板、直角、玻璃、面板和碳纹六种界面形态。 | Alongside the six color themes, CC-Panes now includes Soft, Slab, Sharp, Glass, Panel, and Carbon interface shapes. |

### 评审检查

- [ ] 功能提示只解释一次核心差异，不重复设置页全部内容。
- [ ] 更新说明给出准确数量，不使用“全面升级”等笼统结论。

## 7. 文案约束

- “主题”只表示配色，不再同时指代圆角或材质。
- “形态”只表示结构和表面处理，不表示布局密度。
- 中文界面显示“中文名 + 英文名”；英文界面只显示英文名。
- 状态圆点、头像、色板、单选标记等具有明确语义的圆形元素不随形态改变。
- 所有形态共用当前配色 token，不为 Glass 或 Carbon 写死一套颜色。
- 终端和编辑器是内容区域，不使用装饰纹理，不因形态切换而降低文字对比度。

### 评审检查

- [ ] 替换产品名后，六张卡片描述仍然对应可观察的具体变化，而不是通用宣传语。
- [ ] 文案边界足以防止 PRD 把“形态”扩张成布局或功能重构。

## 8. 待确认项

- [ ] 页面标题采用“配色与形态 / Color & Shape”。
- [ ] 中文卡片采用“中文名 + 英文名”，英文卡片只显示英文名。
- [ ] 六种形态首批全部保留。
- [ ] Soft 作为默认值，保持当前 CC-Panes 外观。
- [ ] 形态作为全局设置保存，不按工作区分别保存。
- [ ] Glass 和 Carbon 都保留“适合壁纸”标记。
- [ ] 功能提示和版本更新说明随功能一起上线。

## 9. 依据

- 当前配色设置：`web/components/settings/ThemeSection.tsx`
- 当前配色目录：`web/theme/themePresets.ts`
- 当前主题数据结构：`web/types/settings.ts`
- 当前视觉规则：`docs/46-frontend-styleguide.md`
- 参考形态定义：`F:/C26/gitee.com/zhengjunkj/ccpanel/src/data/themeShapes.ts`
- 参考形态选择器：`F:/C26/gitee.com/zhengjunkj/ccpanel/src/components/PersonalizationControls.tsx`
- 参考形态说明：`F:/C26/gitee.com/zhengjunkj/ccpanel/docs/prd-appearance-shape-system.md`

本文只用于确认产品文案。实现范围、数据模型、兼容策略、测试矩阵和任务拆分在文案确认后的 PRD 中定义。

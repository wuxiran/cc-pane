# 合并主线新增问题审阅

本文件保留修复前的审阅证据；后续实施与完整验证记录见 [修复报告](2026-10-21-main-review-fixes.md)。

2026-10-21，审阅 `dev/v0.12.22` 的 `65ab7bb59df330f7dfeb6773a2956193b07c82d8`。远端同名分支与本地一致，包含 PR #82 的整合及 Windows 后续修复。本轮确认 8 项新问题：3 个 P1、5 个 P2。只进行审阅、隔离复现和生成报告，没有修改业务代码。

已排除 R01–R15、D01–D08、F01–F06、G01–G09，以及 Agent A01–A15、宠物和 macOS 性能修复清单。并行工作树中已知的 SelfChat/ctl 提示能力改动不重复列入。以下编号只对应本轮问题。

## P1

### H01 忽略规则变化会使分叉采纳误删现存文件

位置：`cc-panes-core/src/services/fork_review_service/comparison.rs:85`；关联 `repository_snapshot.rs:259`、`fork_review_service/adoption.rs:91`。

父项目有未跟踪、未忽略的 `important.txt`，创建分叉后该文件进入 baseline 并复制到子项目。子项目仅将它加入 `.gitignore`，没有删除文件，审阅却显示 `deleted`、`supported=true`、`conflict=false`。采纳 `.gitignore` 和这条记录后，父项目文件被真实删除，子项目文件仍在。

每次快照通过 `ls-files --others --exclude-standard` 重算范围，后续比较将“快照没有条目”直接解释为删除，未区分被忽略与物理缺失。建议对 baseline 已有路径单独验证实际状态，或显式区分 excluded/absent，禁止把过滤结果自动转为删除意图。不要因此把所有新 ignored 文件都纳入快照。

回归应覆盖 baseline 未跟踪文件随后被忽略、重新取消忽略，以及真正删除。此项属于新分叉采纳流程，不是已修的本地历史删除语义或目录移动问题。

### H02 MCP 多项目标签会将其他项目配置写入当前项目

位置：`web/components/settings/ProjectMcpSection.tsx:104`、`web/stores/useMcpStore.ts:49`；写入入口为 `ProjectMcpSection.tsx:210`。

打开 A、B 两个项目的 MCP 标签后，A 页仍绑定 A 的保存目标，但其列表已被全局 Store 更新为 B 的服务器。返回 A 编辑同名服务器并保存，实际请求向 A 写入 B 的 command 和 env。探针使用模拟凭据，确认 A 的原配置被覆盖；没有连接真实 MCP 服务。

所有同时挂载的页面订阅同一份 `servers`、`legacyServers`，隐藏标签不会卸载或重新加载。异步请求还缺少目标/代次校验：A 的迟到响应可以形成 `targetKey=B`、`servers=A`。

建议按 `mcpTargetKey` 隔离状态或由组件持有配置，加载结果与保存动作都绑定同一目标身份；补双标签和请求乱序回归。此项不是旧的 pinned 终端资源清理或 Agent cwd 切换问题。

### H03 Todo 子任务操作会丢弃未保存的父任务编辑

位置：`web/components/todo/TodoManager.tsx:166`；关联 `web/stores/useTodoStore.ts:492`。

修改父任务标题或正文后，不点击保存，直接勾选子任务。子任务操作会重新获取父任务并替换 `selectedTodo`；表单 effect 对同一任务对象的任何更新都重新填表并清除 dirty。实测标题从未保存的新值回到旧值，没有保存父任务，也没有确认提示。

建议区分任务身份切换与同任务刷新，保留脏字段或明确处理未保存编辑；补勾选、添加、删除子任务及背景刷新的回归。这是受控表单被同任务刷新覆盖，不是已修的文件编辑器卸载问题。

## P2

### H04 MCP 参数编辑不能无损往返 argv

位置：`web/components/settings/ProjectMcpSection.tsx:191`、`:205`。

打开已有服务器后直接保存，即使没有改参数，`['C:/Program Files/MCP/server.js', '--label', 'two words', '']` 也会被写成 `['C:/Program', 'Files/MCP/server.js', '--label', 'two', 'words']`。

`join(' ')` 与按空白拆分丢失参数边界和空参数，增加引号也没有对应解析器。建议使用逐项参数输入或可无损序列化的数组表示，并以真实 argv 往返验证。此项不同于旧 Windows batch 命令引用问题。

### H05 文件浏览器改变 Windows 根路径语义

位置：`web/stores/useFileBrowserStore.ts:45`、`web/components/sidebar/FileBrowserToolbar.tsx:65`。

导航到 `C:/` 或从 `C:/work` 返回上一级，Store 会将根路径存成 `C:`。UNC 地址 `//server/share/project` 的 share 面包屑又会生成 `/server/share`，丢失网络共享前缀。

本轮已用实际 Store/组件和 Node `path.win32` 验证错误字符串与路径分类；没有声称执行了 Windows 原生文件访问。建议让导航、上一级和面包屑共用保留盘符根、UNC 共享根及 POSIX 根语义的工具。这是实际导航地址被改变，不是旧的项目身份键或迁移后缀比较问题。

### H06 文件与目录互换时预览和采纳不一致

位置：`cc-panes-core/src/services/repository_snapshot/files.rs:40`、`fork_review_service/publish.rs:29`。

将 `module` 文件改成 `module/item.txt`，或反向替换：未暂存时比较直接报 `Unsupported snapshot file type` 或 `ENOTDIR`；执行 `git add -A` 后，两条变更都显示可采纳、无冲突，但实际采纳仍失败。

快照仍按旧索引路径逐项读取；发布预检不能表达“先删除占位文件、再创建目录”的依赖。建议对结构转换建模并按依赖执行，或在预览阶段明确标为不支持，保持现有链接和特殊文件防护。应补两个方向的未暂存比较和完整采纳回归。

### H07 启动配置保存失败仍改变运行时状态

位置：`cc-panes-core/src/services/launch_profile_service.rs:305`；创建、删除和默认配置更新也采用相同的提交顺序。

向配置存储注入写入失败后，`update_profile` 返回错误，但内存中的 `yolo_mode` 已从 false 变成 true，磁盘仍为 false。恢复存储、保存另一个不相关配置后，先前失败的修改也被一起写入磁盘。

应在临时副本上修改，持久化成功后再替换运行时配置，并覆盖默认项联动和创建/删除失败。此项不同于工作空间并发覆盖，也不是旧 Provider 数量上限问题。

### H08 macOS 成功的验收命令可能被标为失败

位置：`cc-panes-core/src/services/task_verification_service/process_tree.rs:44`；UI 判定为 `web/components/orchestration/TaskVerificationCard.tsx:25`。

在本机 macOS 26.7 上，以当前 core 的 public `TaskVerificationService` 运行 `echo verified`，得到退出码 0、正常 stdout、代码未改变且证据为 current，但 `executionError` 为 `Operation not permitted (os error 1)`。UI 要求该字段为 null，因此显示失败。两次独立 plain-command 调用得到相同结果。

runner 通过 WNOWAIT 保留已退出组长，随后仍执行 `killpg`。单独 OS 探针显示，对仅剩该退出成员的组发送信号返回 EPERM。Apple XNU 的 `killpg1` 实现过滤 zombie，未找到可投递成员时走 EPERM 分支，与本机证据一致；不能把这里的 EPERM 一概解释成仍有进程未清理。[Apple XNU 实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c#L1579-L1624)

建议区分没有存活成员与真正清理失败，保留进程身份校验，不能直接吞掉所有 EPERM。回归应同时断言简单成功命令的 exitCode、executionError 和 UI 通过状态。现有后台子进程测试的组内仍有活成员，未覆盖这个边界。此项不同于旧 ACP 终止句柄/进程树问题；Windows 未在本轮验证。

## 代码质量与设计检查

本轮最值得统一的三个约束，分别对应上述实际缺陷：

- **状态归属必须携带目标身份。** MCP 缓存和异步返回不能只维护一份全局值。
- **运行时状态应在持久化成功后提交。** Provider 已有类似保护，LaunchProfile 的原地修改路径仍绕开该约束。
- **快照条目缺失需要区分原因。** ignored、物理删除和文件形态变化不能全部压成一个 `None`。

现有设计 token、颜色、文案和行数防回退检查共 15 项通过，主题对比度检查通过。既有大文件、已有审阅中的功能边界及尚未完成复现的线索未重复计数。门禁通过只代表这些已配置的规则通过，不代表全部交互状态已经覆盖。

## 证据与范围

- 构建当前 HEAD 的 core 并记录 artifact/hash；没有运行完整测试套件或重启真实应用、daemon。
- 前端 3 个独立探针文件、6 条观察断言复现缺陷，使用实际组件与 Store，模拟后端 I/O；这些通过结果表示成功复现错误行为。
- 分叉、快照及启动配置通过当前 core 在隔离 Git 仓库和配置目录实际调用验证。
- macOS 验收仅以隔离仓库的普通成功命令独立确认；其他未闭环的后台清理/共享控制连接线索未计入结论。
- 业务源码和已有用户文件保持原状。审阅报告是本轮唯一新增的仓库文件。

证据目录：`/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-21-main-review/`。关键文件包括 `core-provenance.json`、`frontend/findings.json`、`frontend/probes.log`、`rust-data/findings.json`、`rust-data/results.log`、`runtime/verification-plain-root-check.json` 和 `runtime/zombie-group-result.log`。

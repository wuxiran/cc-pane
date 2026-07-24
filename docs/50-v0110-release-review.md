# 50 — v0.11.0 发版整体评审(跨批接缝专项)

> 只读评审。区间 `v0.10.21..v0.11.0`(约 10 个批次、9 个 worker 的合并成果)。
> 各批单独测试均绿;本评审**只聚焦跨批交互与接缝**,不重复单批正确性检查。
> 结论追加到文末「评审结论」,按 严重(须热修)/建议(下版)/确认无虞 三档分类。

## 重点接缝(按风险排序)

1. **会话生命周期三连改的组合行为**(最高优先):
   - E2 `159427f`:桥接 poll 改按会话存在性拆除(hook-Exited 不拆);
   - H `cc7b83c`:daemon kill 无订阅者时 control WS 广播兜底、pinned tab 不再无视 backend kill、对账 completed 判定收紧;
   - I `e5fcafa`:状态查询侧"10 分钟无 hook/OSC 事件的 busy 回落 Idle" + 补投 60s 电平扫描 + TTL 可见化。
   审:①I 的陈旧回落对"长时间静默但真忙"的会话(终端跑长编译/大输出但无 hook 事件——PTY 输出算不算它的'事件'?)是否误判 Idle,连锁影响:电平扫描向真忙 leader 注入 [worker-report]、UI 状态灯、以及任何以 Idle 为前提的消费方;②三改动对 docs/38 kill 语义的叠加是否仍自洽(kill→关标签在 桥在/桥不在/pinned/starred 四象限);③E2 后桥接对 hook-Exited 会话长期保活的资源面 × I 的回落是否互相干扰。
2. **F 的 spawn_pty cwd 封堵**(`f828572`):守卫是否严格限定 local runtime——WSL(cwd 是 Windows 侧给 wsl.exe 的)、SSH(本机 HOME)、daemon 内 spawn 各路径逐一确认不被误拒;host_path 分类器与 D 的 canonical 身份(`project_identity.rs`)对同一路径的判定是否一致(一个放行一个拒绝会造成"能注册不能启动")。
3. **A 的 watcher key × D 的 canonical 归一化**:HistoryWatchManager/history repos 的 key 用 `normalize_project_path`,项目身份用 canonical(跨形式)——同一项目以 /mnt 形式启动会话时,watcher key 与 D 迁移后的注册 path 是否同源,会不会出现双 watcher 或 stats 对不上。
4. **A+ 有界通道整批丢弃**(`6b01200`)× A 的 debounce/事件管道:丢弃语义与 Local History 的删除事件(依赖快照 diff?已不存在——0.11.0 无扫描器,删除靠 notify 事件)是否有一致性问题。
5. **G 的 NSIS hook**(`d4e8e5a`,仅静态校验过):宏名/语法对 Tauri 2.11 NSIS 模板是否正确;taskkill 全路径过滤的引号/空格路径;MessageBox 在 POSTUNINSTALL 的时序(文件已删后?);`IfSilent` 分支。
6. **C1/C2 git 层 × F 的错误面板**:GitService 错误是否也走了新 launchError 渲染路径或各自为政(允许各自为政,但确认无相互破坏)。

## 明确不在范围

单批内部逻辑正确性(已各自测试/评审)、样式/命名、性能微优化。

## 评审结论

(评审者追加)

### 总体结论

区间 `v0.10.21..v0.11.0` 的六个接缝中发现 **3 项严重(须热修)**、
**1 项建议(下版)**；其余组合链路未发现相互破坏。当前不应把各批单测均绿视为
跨批可直接放行：第 1 项会误向仍在执行工具的 leader 提交输入，第 2 项会让 Linux/WSL
原生宿主上的 `/mnt/<drive>` 项目注册后无法启动，第 4 项会永久漏记批量删除 tombstone。

### 严重(须热修)

1. **[接缝 1] 10 分钟陈旧 busy 回落会把持续输出的长工具误判为 Idle，并触发
   worker-report 误注入。**

   - **触发场景：**leader 已通过 hook 进入 `Thinking`/`ToolRunning`，随后执行超过
     10 分钟的编译、测试或其他长工具；期间即使 PTY 持续产生大量普通输出，只要没有
     新的 hook/OSC hook 标记，同时至少有一条 worker report 在补投队列中，下一轮 60s
     电平扫描就可能把 report 连同 Enter 提交给仍在运行的前台进程。
   - **证据：**`SessionStateMachine` 只在处理 hook/OSC 事件时刷新
     `last_hook_event_at`（`cc-panes-core/src/services/session_state_machine.rs:173-199`）；
     PTY 普通输出只更新独立的 `last_output_at`，OSC detector 也只把识别出的控制标记送入
     状态机（`cc-panes-core/src/services/terminal_service.rs:2254-2275`）。查询侧在状态机和
     backend 都为 busy 时，仅按 `last_hook_event_at` 超过 10 分钟回落 Idle
     （`cc-panes-core/src/services/session_state_machine.rs:347-381`，阈值见
     `cc-panes-core/src/constants.rs:82-86`）。
   - **连锁行为：**所有状态查询都会套用该回落，桌面状态列表也不例外
     （`src-tauri/src/commands/terminal_commands.rs:318-326`），所以 UI 状态灯会显示 Idle。
     更关键的是补投扫描直接读取这个有效状态并执行 flush
     （`src-tauri/src/services/orchestrator_service.rs:7964-7993`），随后构造
     `[worker-report]` 并调用智能提交（`src-tauri/src/services/orchestrator_service.rs:8199-8211`）；
     智能提交会真实写入文本、等待并发送 Enter
     （`cc-panes-core/src/services/terminal_service.rs:2761-2784`），不是只更新 UI。
   - **热修要求：**陈旧回落不得仅凭 hook 静默把 busy 变成可注入的 Idle。至少应把近期
     PTY 输出/前台工具存活纳入判断；更稳妥的是区分“展示降级”和“允许自动提交”，补投
     只能由明确 `TurnEnd`/`WaitingInput` 或等价强证据放行。纯 shell 且从未建立 hook
     状态机条目的会话不会走此回落，但这不消除 agent 长工具场景。

2. **[接缝 2] D 的跨形式 canonical 与 F 的宿主路径守卫在 Unix 上互相冲突，形成
   “能注册、不能启动”。**

   - **触发场景：**在 Linux 或 WSL 原生运行的 CC-Panes 中添加一个真实存在的
     `/mnt/d/repo`（任意 `/mnt/<字母>/...` 同理），或升级时迁移已有该路径的项目。
     添加阶段先按原 Unix 路径检查存在并成功，之后却把持久化路径改成 `D:\repo`；从
     侧栏启动 local session 时，F 的 Unix 宿主分类器将其判为 Windows 路径并返回
     `PATH_PLATFORM_MISMATCH`。
   - **证据：**canonical 无宿主/运行时条件，明确把 `/mnt/<drive>` 变为盘符路径
     （`cc-panes-core/src/utils/project_identity.rs:9-29,84-96`）。新增项目先验证原路径，
     再保存 canonical 值（`cc-panes-core/src/services/project_service.rs:22-45`）；启动迁移也
     会把既有行更新为该值（`cc-panes-core/src/repository/project_repo.rs:57-63,87-98`）。
     F 的分类器则在 Unix 宿主拒绝所有 Windows absolute path
     （`cc-panes-core/src/utils/host_path.rs:75-93`），且 session 创建入口确实调用该守卫
     （`cc-panes-core/src/services/terminal_service.rs:1313-1320`）。
   - **热修要求：**项目“身份 key”和“可执行/持久化展示路径”必须分离；不要在 Unix
     宿主把可访问的 `/mnt/d/...` 持久化改写成 `D:\...`。迁移应保留宿主可用原路径，
     只用独立 identity key 去重，并覆盖 Linux/WSL 原生回归用例。

3. **[接缝 4] 128 路径 debounce 上限会整批丢弃删除事件，且没有 rescan，自此无法
   生成删除恢复点。**

   - **触发场景：**活跃项目在同一 500ms debounce 窗口内批量删除/移动 129 个以上未被
     ignore 的源文件（删除目录、生成器清理、mass refactor 均可）；或者事件通道积压到
     30,000 批后恰好丢掉删除批次。
   - **证据：**窗口为 500ms（`cc-panes-core/src/constants.rs:42-46`），唯一文件路径上限
     仅 128（`cc-panes-core/src/services/history_service.rs:25-26`）；第 129 个路径会清空
     已收集事件并把整个 batch 标成 overflow，之后 `into_events` 返回 `None`
     （`cc-panes-core/src/services/history_service.rs:58-85`），事件循环据此整批跳过
     （`cc-panes-core/src/services/history_service.rs:203-233`）。删除 tombstone 只能由
     `FileRemoved` 执行 `save_version(..., is_deleted=true)` 产生
     （`cc-panes-core/src/services/history_service.rs:433-474`），而 notify 的 Rescan/error
     又被明确告警后忽略（`cc-panes-core/src/services/history_service.rs:654-684`）。因此提交
     说明中的“下次写入自然补”只适用于部分修改事件，不适用于已经不存在的文件。
   - **热修要求：**溢出时至少把项目标记 dirty 并安排一次有界、可取消的对账；或在限流
     时保留/合并删除事件，不能把 deletion 与可由后续写入覆盖的 modification 同等丢弃。

### 建议(下版)

1. **[接缝 5] NSIS hook 的宏名、时序和静默分支静态上正确，但 `$INSTDIR` 的
   PowerShell 单引号字面量未转义。**

   `NSIS_HOOK_PREINSTALL/PREUNINSTALL/POSTUNINSTALL` 名称与 Tauri 2.11 hook 契约一致，
   `POSTUNINSTALL` 在安装文件/注册项移除后执行不妨碍删除三个外部数据目录；
   `IfSilent ccpanes_keep_user_data 0` 也确实让 `/S` 跳过询问和删除
   （`src-tauri/nsis/installer-hooks.nsh:8-25`）。空格路径被 PowerShell 单引号保护，
   但 `$INSTDIR` 若含 `'`（例如用户 profile/自定义安装目录含撇号），第 4 行生成的
   `@('...')` 会语法破裂，进程未杀而 hook 结果又未作为安装失败处理。建议改为不把路径
   插入 PowerShell 源码的参数/环境变量传递方式，并在 Windows 真机补交互卸载、`/S`、
   passive updater、空格及撇号路径矩阵。本次遵守约束未运行安装器构建或执行验证。

### 确认无虞

1. **[接缝 1 其余组合] kill、hook-Exited、桥接和 pinned/starred 的叠加语义闭合。**
   桥接 poll 以 daemon session 是否仍存在决定存活，hook-Exited 不拆桥
   （`src-tauri/src/services/terminal_daemon_event_bridge.rs:300-329,441-448`）；有桥时
   killed 帧转发 `session-killed` 并终止桥，无订阅者时 daemon 改走 control WS
   （`cc-panes-daemon/src/ws_emitter.rs:111-135`）。前端对 `user-close/mcp` 关标签、对
   reclaim/reaper 保留退出壳（`web/services/terminalService.ts:348-370`），而
   `closeTabBySessionId` 遍历普通与 starred 布局并对 backend kill 强制越过 pinned
   （`web/stores/usePanesStore.ts:2797-2846`）。I 的查询侧 Idle 不参与 bridge teardown，
   所以不会和 E2 保活互相拆桥；真实 WS exit/killed 或 session map 消失后桥仍会释放。

2. **[接缝 2 的 spawn 层] `spawn_pty` 的最终守卫实际只检查宿主本地 cwd，未把 SSH
   remote path 或 WSL remote path 当本机目录。**SSH 分支使用本机 home
   （`cc-panes-core/src/services/terminal_service.rs:1608-1622`）；Windows WSL 分支给
   `wsl.exe` 的 PTY cwd 是本机 project/workspace path，远端 cwd 单独进入命令
   （`cc-panes-core/src/services/terminal_service.rs:1623-1634,1741-1817`）；local 分支同样
   使用本机路径（`cc-panes-core/src/services/terminal_service.rs:1818-1823`）。因此 F
   守卫本身没有误拒 SSH/Windows WSL；严重项来自 D 把 Unix 可执行路径改坏。

3. **[接缝 3] 在当前可实际启动的同一宿主路径集合内，没有形成双 watcher 或 stats
   分裂。**manager 先 `normalize_project_path` 并要求路径在本机确为目录，再用
   `paths_equivalent` 复用已有 key
   （`cc-panes-core/src/services/history_watch_manager.rs:56-84`）；盘符大小写、分隔符和
   尾分隔符均可合并，WSL UNC/SSH 路径在建 watcher 前直接跳过
   （`cc-panes-core/src/services/history_watch_manager.rs:169-177`）。`/mnt` 与盘符跨形式
   没有在 watcher 内合并，但标准 Windows 上前者不是 local dir、标准 Unix 上后者不是
   local dir，所以它不会单独制造两个活 watcher；Unix `/mnt` 被 D 改坏的问题已归入
   接缝 2 热修项。

4. **[接缝 6] Git 错误面与 terminal `launchError` 各自闭环，未发现相互覆盖。**
   Git C1/C2 只经 `gitService` 的独立 IPC/HTTP API
   （`web/services/gitService.ts:61-110`），Explorer 将 repo/detail 错误保存在组件局部状态
   并原位渲染（`web/components/sidebar/ExplorerGitSection.tsx:115-169,181-197`），timeline
   也使用独立的 `logError/filesError/diffError`。`launchError` 只写 terminal leaf，且只在
   TerminalView 初始化失败时经 `onLaunchError` 进入
   （`web/components/panes/TerminalTabContent.tsx:105-175`、
   `web/stores/usePanesStore.ts:2076-2098`）。两者没有共享 store 字段或错误转换入口，
   允许各自为政且不会把 Git 失败误渲染成终端启动失败。

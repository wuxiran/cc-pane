# 66 · 0.11.4 计划：会话恢复转正

> 单主线版本。0.11.3 把重复恢复事故的基础设施全部建完，但功能**默认关闭**——
> 用户手上跑的仍是旧行为，事故仍会复现。0.11.4 的唯一定义性内容是**把开关打开**，
> 并补齐打开它所需的灰度与验收。
>
> **叙事**：0.11.3 建能力，0.11.4 开能力。

## 1. 为什么这是唯一主线

`docs/61` 开头写下的红线：

> UI 接管、daemon lease、启动认领与时序屏障已落地；**自动认领仍默认关闭**，
> 尚未完成独立 dev daemon 灰度和 Windows 桌面验收，**因此不得宣称事故已被"根治"**。

待办 19 项打了 18 个勾，只剩最后一条：**独立 dev daemon 灰度与 Windows 桌面验收**。

事故本体（单机 50 个 `claude.exe`、约 19GB、21 个 uuid 里 22 个进程重复 `--resume`）
在 `autoAdoptDaemonSessions` 默认关闭的前提下**没有被消除**。
0.11.3 交付的是能力，不是修复——这笔账必须在 0.11.4 还清。

## 2. 主线 A：把 `autoAdoptDaemonSessions` 推到默认开启

### A1 · 独立 dev daemon 灰度环境

灰度不能污染生产会话。当前 dev / release 已按 `APP_DIR_NAME` 隔离数据目录，
但 daemon 侧需确认灰度期间两条链路互不串扰（`docs/63` 的 R5「dev daemon 连坐」曾标注**未独立验证**）。

- 确认 dev daemon 的 manifest / 端口 / token 与 release 完全独立
- 灰度开关可热切换（已实现 `autoAdoptDaemonSessions` 热禁用，需验证热启用同样成立）
- 灰度期间保留 detach + release claim 回退路径（**解除挂载但不 kill PTY**）

### A2 · Windows 桌面验收

验收用例直接对着事故的失败模式写，每条都要能复现原始故障：

| 用例 | 期望 | 对应原始故障 |
|---|---|---|
| 两个 app 实例先后启动，同一批 daemon 会话 | 只认领，不重建；无重复 `--resume` 进程 | 第二批 19 个重复进程 |
| app 正常关闭后重启 | 会话被认领并回到原 leaf/pane | 匹配全落空 → 逐 tab 重建 |
| provenance 缺失的历史会话 | **拒绝自动认领**，仅允许人工接管 | fail-closed 不变式 |
| generation / birth nonce 不匹配 | 阻断，不启动 | 版本错配下的误认领 |
| 会话中执行 `/clear` | 不被标记 Exited，不发合成 `terminal-exit(-1)` | docs/44 |
| 另一实例持有租约时写入 | 面板转只读 + 去重提示（30s 冷却） | 租约闸门 |
| 灰度开关关闭 | 停止自动认领，**不杀任何 PTY** | 回退安全性 |

> 验收必须在 **Windows 桌面壳**上跑。按 MEMORY 的教训：WSL 侧测试全绿 ≠ Windows 通过，
> 合并后必须在 Windows 宿主补跑一轮。

### A3 · 开关转正

A1/A2 全绿后把默认值翻到开启，并保留显式关闭入口。

### A4 · 更新 docs/61 措辞

**只有走完 A1–A3 才允许把「不得宣称根治」那句撤掉。** 未完成前文档保持现状。

## 3. 随主线一起做的零散项

| 项 | 理由 | 体量 |
|---|---|---|
| `/mnt` 回归测试去掉条件跳过 | `workspace_health.rs` 的 `mounted_drive_path_uses_host_usable_probe_when_available` 在 `/mnt/d` 不可用时 `eprintln!` 后直接跳过——**Windows CI 上必然跳过，0.11.3 那条阻断项的护栏在 CI 里是空的**。改成可注入 probe 的确定性测试 | 小 |
| `TaskBinding` 补 `runtime_kind` | 今天排查串台时从 binding 上看不出 worker 跑在本地还是 WSL；且是后续聚合契约的前置。跨层：model / repo / service / MCP / TS 类型 | 小 |
| 确认 `list_panes` 缺会话的成因 | `docs/63` 记了一个**未验证关联**：有 active 会话完全不出现在 `list_panes` 里，怀疑是经 daemon 直创未经 orchestrator 落位。A2 本来就要比对 daemon 会话与 panes，顺手确认，**只出结论不改行为** | 极小 |

## 4. 明确不纳入本版

### R7（`ctl launch` 的 daemon 降级）—— 与主线 A 冲突

R7 的内容：orchestrator 挂掉时 `launch` 完全不可用，但 daemon 的 `POST /api/sessions`
接受几乎全套参数（`cliTool` / `initialPrompt` / `resumeId` / `yoloMode` / `launchProfileId` /
`projectPath` / `wsl` / `ssh` / `extraEnv` / `cwd`）——**不降级是编排语义没接线，不是底层做不到**。

不纳入的理由，按强度排序：

1. **与 A 的不变式直接冲突。** daemon 直创的会话拿不到 TaskBinding、`mcp-<sessionId>.json`、
   启动历史、pane 落位——这正是 A 的 fail-closed 机制判定为「provenance 缺失、禁止自动认领」
   的那一类会话。同版本里一边建守卫、一边造守卫要拦的东西，验收标准会自相矛盾。
2. **A 先落地对 R7 是利好。** 有了 provenance / claim 模型后，daemon 直创可以一并登记来源，
   R7 在 0.11.5 能做得干净得多。
3. `docs/63` 自己把 R7 排在中后段并注明「**慎做**」。

实施时的红线（留给 0.11.5，先记下来）：
**必须是显式降级入口**（`--daemon-fallback` 或独立子命令），要求调用方自行提供已解析的 id，
并明确告知「该会话不会出现在 UI 布局中」。**绝不能做成自动静默降级**——
那会退回「看起来成功、实则语义不同」的老模式。

### docs/62 遗留两条 —— 排 0.11.5

- 跨全部工作空间的一次性扫描清理（现只覆盖当前展开的工作空间）
- 主仓库未注册时的「导入主仓库」引导

不冲突，纯粹是为了保住单主线的版本叙事。

### WSL Grok 不注入 MCP

`cc-panes-core/src/services/terminal_service/wsl_codex.rs:1039` 的 TODO。Grok 使用面窄，低优先。

### AI 面板模板 / fleet 拓扑

见 [`docs/64`](./64-ai-panel-templates.md)，已标未排期。

## 5. 完成判据

按 [`docs/65`](./65-skill-observation-contract.md) §6 的收尾字段：

1. `autoAdoptDaemonSessions` 默认值已翻为开启，且显式关闭入口仍在。
2. A2 表中 7 条用例在 **Windows 桌面壳**上逐条通过，附真实输出（判定成败不加 `| tail`，
   用 `echo "EXIT=${PIPESTATUS[0]}"`）。
3. `docs/61` 的待办最后一项打勾，红线措辞更新。
4. `/mnt` 测试在 Windows CI 上**实际执行**而非跳过。
5. 剩余 NEXT 显式列出：R7、docs/62 两条、WSL Grok MCP 均已排到 0.11.5 或之后。

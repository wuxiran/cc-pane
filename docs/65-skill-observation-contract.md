# 65 · Skill 观测契约：AI 驱动会话时的状态判读与停手规则

> 本文是**给 skill 用的共享约定**，不是设计文档。所有 launch / 监控 / 编排类 skill 回引本文，
> 不再各自复述状态语义。结构参考 [Nacos skill-sync](https://nacos.io/skill-sync/SKILL.md) 的
> 「状态词表 + 规定动作 + 安全提问清单 + 收尾字段」四段式；**内容全部换成 CC-Panes 自己的真相**。

## 0. 为什么需要它

CC-Panes 的 skill 生态里，「这个观测意味着什么」一直是散在 CLAUDE.md 的 Known Gotchas、
各 skill 的正文和人的记忆里。后果是同一个坑反复踩：

- `wait_for_session` 返回 `idle` + `turnSeq: 0`，看着像"跑完了"，实际是 prompt 停在 TUI 从没提交；
- `status: running` 的 worker 已经死了 12 分钟，因为判活只看了 `status`；
- 整场在驱动另一个实例，MCP 工具全部正常返回（只是别人的数据）。

这些都不是 bug，是**判断空间太大**。本文把它压到查表。

## 1. 权威来源：组合信号，不是 `status`

> Nacos 那份写「`status` 是每次操作后的唯一真相」。**这条在 CC-Panes 不成立**——
> 我们的 `status` 会撒谎（见 §3 同形陷阱）。可借鉴的是形式（指定唯一权威 + 每次操作后重读），
> 不是内容。

判定一个会话的真实处境，权威来源是这三者的**组合**：

| 信号 | 来源 | 单独可信吗 |
|---|---|---|
| `status` | `get_session_status` / `wait_for_session` | **否**，见 §3 |
| `lastOutputAt` 停滞时长 | 同上 | 否，与"刚启动"同形 |
| 进程存活 | `ps aux \| grep` / `wsl.exe -d <发行版> -- bash -lc "..."` | 否，活着≠在干活 |

**每次写操作后重新读组合信号，不要用自己对操作结果的推断代替观测。**

## 2. 观测 → 动作表

会话状态取值：`initializing` / `idle` / `thinking` / `toolRunning` / `compacting` /
`waitingInput` / `error` / `exited` / `active`。

| 观测 | 含义 | 动作 |
|---|---|---|
| `idle` + `turnSeq: 0` + PTY 零输出 | **prompt 未提交**，停在 TUI 里 | `write_to_session(id, "\r")` 发裸 CR。**不要 kill 重发**（大概率再次命中） |
| `idle` + `turnSeq: 0` + **PTY 有输出** | 多半在等你选（AskUserQuestion / 权限确认） | 读 `get_session_output` 看它问什么。**绝不能发裸 CR**——会在选择框里盲选一项 |
| `running`/`active` + `lastOutputAt` 停滞 > 5min | 疑似假活 | 先 `ps` 确认进程存活；活着 → 发裸 CR；不在 → 按真实退出处理 |
| `running`/`active` + `lastOutputAt` 新鲜 | 正常工作中 | **等**。不要打扰，不要重复投递 |
| `waitingInput` | 真在等人 | 读 `get_session_output` 看它问什么，再决定投什么 |
| `exited` 且 exit code `-1` | **合成码，非真实进程退出** | 查 SessionEnd reason；`clear` 不是退出（docs/44） |
| `exited` 且 exit code 非 `-1` | 真退出 | 读输出取结论，不要盲目 resume |
| `compacting` | 正在压缩上下文 | 等，此时投递会被吞 |
| `error` | 通道级错误 | 读输出；若是 MCP/端点问题先做 §4 身份核对 |
| 会话 ID 查不到 + daemon 有该会话 | orchestrator 死了，daemon 还活着 | 走 `cc-panes-ctl --release sessions list/read/submit` 降级接管 |

### 控制键写入

- 控制键**只能**用 `write_to_session`，且必须 JSON `\u` 转义：
  回车 `"\r"`、Esc `""`、Ctrl+C `""`、Shift+Tab `"[Z"`。
- **提交 prompt 用 `submit_to_session`**（它会自动追加 CR）。
  不要用它发控制键——Esc 会变成 Esc+Enter。
- Windows PowerShell 只认 CR，**永远不要用 `\n` 代替 `\r`**。

## 3. 同形陷阱：外观相同、必须靠第三信号区分

> Nacos 那份没有这一节，因为它的状态两两可分。我们的不行——**这是本文存在的主要理由**。

| 表象 | 情形 A | 情形 B | 区分方法 |
|---|---|---|---|
| PTY 零输出、进程活着 | 刚派发，还没开始吐字 | prompt 未提交，永久卡死 | 看**存活时长**：< 90s 属正常；已存活数分钟仍零输出 = 卡死 |
| `status: running`、无输出 | 在跑长工具（编译/测试） | 假活 | `ps` 看 CPU 占用；零占用 + 零输出 = 假活 |
| MCP 工具全部正常返回 | 连的是本实例 | **串台**，连的是另一个实例 | §4 身份核对 |
| 项目路径 `Path::exists()` 为 false | 目录真的没了 | WSL 发行版没运行，暂时看不到 | 先过 `canonical_project_path`；三态判定，不要判成 missing（docs/62） |

## 4. 身份核对：动手写之前必须做一次

> Nacos 是单机单 CLI，没有这个问题。CC-Panes 有，**且 agent 完全无法自察**。

`healthy_orchestrator_info()` 为 `None` 时，`CC_PANES_API_PORT/TOKEN/BASE_URL` 一个都不注入，
CLI 会**静默回退**到 `~/.claude.json` 的 project 级单例——那份可能是另一个实例最后写的。
表现是：工具全部正常返回（只是别人的数据）、派出去的 worker 在别的实例里、
它的 `report_to_leader` 被对侧丢弃（日志 `leader session not found`）。

**判据**：`$CC_PANES_LAUNCH_ID` 必须等于所连 MCP URL 里的 `launchId`。不等即串台。

```bash
echo "$CC_PANES_LAUNCH_ID"        # 与 MCP endpoint 的 launchId 比对
```

命中串台 → **立即停止一切写操作**，报告用户，不要试图"顺手修一下"。

## 5. 必须停下来问人的时刻

> 借鉴 Nacos 的 Safe Human Prompts：把可以问的时刻穷举出来，
> **反过来定义「不在这张表上的事，自己决定，不要问」**。

只在以下情形提问：

1. **多个候选来源不一致**，且没有依据挑出赢家（哪个 worktree 的实现胜出、resume 哪个会话）。
2. **删除类操作**：删项目记录、删 worktree、清理会话、清空 backup。
   即便判定为"孤儿"也要问——存在性判定是三态的，可能只是暂时看不到（§3）。
3. **绕过不变式**：`bindings` 写默认禁止；要用 `--force-offline-db` 逃生阀必须先说明后果。
4. **命中串台**（§4）。报告，不自行切换实例。
5. **kill 一个还活着的会话**。先给出"发裸 CR 唤醒"这个非破坏选项。
6. **重启 daemon / orchestrator**：会影响其他在途 worker。
7. **发布类动作**：打 tag、push、建 PR、改版本号。

反向规则（同样重要）：

- **不要把活推回给用户**——除非涉及外部 UI 操作或拿不到的凭据。
  「提醒用户去 UI 手动移除」这类措辞是 docs/62 那条单向流的根因之一：
  活推出去了，没人做，攒出 14 条指向已删目录的项目记录。
- 常规判断（用哪个 runtime、prompt 怎么写、先跑哪个检查）**自己决定**，事后在收尾里交代。

## 6. 收尾报告必须包含的字段

> 借鉴 Nacos 的 Completion Criteria：不是"总结一下做了什么"，是**硬字段清单**。

1. **落在哪**：实例 launchId / 工作空间 / 项目路径（或 worktree）。
2. **改了什么**：文件清单，或"未改动任何文件"。
3. **每个会话的最终状态**：按 §2 的词表报，不要用"应该好了"这类推断词。
4. **验证结果与真实输出**：跑了什么、退出码多少。
   管道会掩码退出码——判定成败用 `echo "EXIT=${PIPESTATUS[0]}"` 或不加管道。
5. **剩余的 NEXT**：还没做完的、被跳过的、需要人接手的。
   **这条最容易被省掉，也最贵**——省掉它等于把"没做完"报成"完成"。

## 7. 与既有文档的关系

| 本文 | 既有出处 |
|---|---|
| §2 `-1` 是合成码 | [docs/44](./44-clear-sessionend-exit-bug.md) |
| §3 路径三态 | [docs/62](./62-worktree-project-hygiene.md) |
| §2 daemon 降级接管 | [docs/57](./57-ccpanes-ctl-and-mcp-orphan.md) |
| §4 串台自查 | CLAUDE.md Known Gotchas |
| §6 PIPESTATUS | CLAUDE.md Known Gotchas |

本文只做**汇总与规定动作**，不重复根因分析——根因去上表的原文看。
上表与本文冲突时，以原文的事实为准，以本文的动作规定为准。

# 81 · 异常退出后的会话恢复

状态：实施中  
日期：2026-08-05

## 1. 问题

应用异常退出后，布局快照仍能恢复，但连接到旧版 daemon 时，
`/api/sessions/adoption-snapshot` 会降级为 `claimsSupported=false`。当前前端把所有待恢复
终端标记为 `claims-unsupported`，只显示“会话恢复已阻断”和诊断日志，没有继续恢复的
操作，用户只能删除标签或从其他入口重新启动。

当前截图中的关键日志为：

```text
daemon-snapshot.end {"sessionCount":1,"claimsSupported":false,"complete":true,"daemonGeneration":null}
daemon-snapshot.blocked {"reason":"claims-unsupported"}
```

这说明布局数据没有丢失，真正缺少的是旧 daemon 的 claim / provenance 协议。

## 2. 参考实现

参考 `F:\C26\gitee.com\zhengjunkj\ccpanel` 的异常退出恢复：

1. 周期性保存打开终端的启动配置。
2. 启动时读取上次会话并让用户确认恢复。
3. 恢复前清掉旧快照，避免重复消费。
4. 读取 CLI 会话 ID；目标存在时给新终端注入 `--resume`。
5. 单个终端失败不阻断其他终端恢复。

CC-Panes 已经在布局快照中保存了逐 leaf 的 `resumeId`、项目路径、CLI 类型、运行时和
Provider 信息，不需要复制 ccpanel 的数据库结构；只复用“旧 PTY 不可接管时，明确确认后
按原配置冷启动并恢复 CLI 对话”的行为。

## 3. 恢复决策

| 后端状态 | 行为 |
|---|---|
| claim 快照完整 | 保持现有热恢复：校验 provenance，取得 claim 后原位 attach |
| 进程内后端，旧 PTY 仍存活 | 进程内 PTY 由本 app 独占，直接按 `savedSessionId` 原位 reattach |
| claim 不支持，但状态列表显示该 leaf 的旧 PTY 已退出或不存在 | 自动转冷恢复：清除失效 PTY id，保留 `resumeId`，按原配置重建 |
| daemon 不支持 claim，且对应旧 PTY 仍存活 | 不自动复制进程；显示可执行的冷恢复入口 |
| claim 能力存在但快照不完整，或快照查询失败 | 保持 fail-closed，不提供可能制造重复进程的自动降级 |
| 身份冲突、多候选、其他实例持有 claim | 保持现有阻断逻辑 |

旧 daemon 有活会话时，用户点击冷恢复的执行顺序必须是：

1. leaf 先解除旧 `savedSessionId` 引用，但继续保持阻断，避免 daemon 的 kill 事件关闭标签。
2. 请求 daemon 结束对应旧 PTY。
3. kill 成功后清除阻断并递增 launch attempt。
4. `TerminalView` 使用原项目、CLI、运行时、Provider 和 `resumeId` 创建新 PTY。
5. kill 失败则还原旧引用与阻断状态，不启动第二个 `--resume` 进程。

## 4. 用户文案

标题：

```text
需要恢复旧会话
```

说明：

```text
当前终端后端版本较旧，无法安全接管仍在运行的终端。可结束旧终端，并按上次的配置恢复会话。
```

主操作：

```text
结束旧终端并恢复
```

执行中：

```text
正在结束旧终端...
```

失败：

```text
旧终端未能结束，未启动新的恢复进程。请重试或在资源管理器中处理旧会话。
```

旧 daemon 的兼容快照虽然没有 claim/provenance，但仍提供逐会话状态列表；只有这个列表明确显示
旧 `savedSessionId` 不再存活时才允许自动冷恢复。对于其他阻断原因，继续使用现有“会话恢复已阻断”
文案与恢复日志。

## 5. 验收标准

- `claimsSupported=false + sessions=[]`：不写 `restoreBlockedReason`，当前布局和后台布局都能继续冷恢复。
- `mode=in-process + savedSessionId live`：直接 reattach，不显示阻断页，不创建第二个 PTY。
- `mode=daemon + claimsSupported=false + savedSessionId live`：显示“结束旧终端并恢复”，不自动创建新 PTY。
- 点击恢复：先解除旧引用，再 kill；kill 成功后只创建一个新 PTY，并携带原 `resumeId`。
- kill 失败：仍停留在阻断页，旧 `savedSessionId` 被还原，不创建新 PTY。
- 其他阻断原因不出现破坏性恢复按钮。
- 中英文文案、store 行为、恢复协调 hook 和组件交互均有聚焦测试。
- Windows 桌面最终需实测：异常结束应用、保留旧 daemon、重新打开、点击恢复，确认旧 PID 退出且仅出现一个新的 resume 进程。

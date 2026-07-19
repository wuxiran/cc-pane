# MCP 端口漂移：长期会话失联

> 状态：A 待实施 / C 排期 | 优先级：**高** | 关联：`docs/18-mcp-startup-token-analysis.md`

## ⚠️ 约束

**只许碰**：

- `src-tauri/src/services/orchestrator_service.rs`（端口选择 + manifest 写入）
- `cc-panes-core/src/utils/orchestrator_manifest.rs`
- 必要的常量定义位置（如 `cc-panes-core/src/utils/app_paths.rs` 的 `APP_DIR_NAME` 同级）
- 对应测试

**不要碰**：`web/` 下任何文件、`cc-cli-adapters/`、`cc-panes-cli-hook/`、
`cc-panes-daemon/`、`cc-panes-web/`、`cc-panes-core/src/services/terminal_service.rs`。
**禁止任何 git 写操作**（工作树里有十三个主题的未提交成果）。
**绝对不要杀用户的进程**（`cc-panes` / `cc-panes-daemon` / `cc-panes-web` 正在运行）；
`cargo test --workspace` 可能被 daemon 文件锁阻塞，改用分 crate 测试并说明哪些没跑到。

## 现象

已打开很久的 CLI 会话（Claude/Codex），在 CC-Panes 重启且端口变化后，
`ccpanes` MCP 工具全部失效。**会话看起来还活着**，只是工具调用静默失败——
用户往往误以为是 AI 出问题。

## 根因

MCP 服务不是独立进程，它挂在 **Tauri 主进程**的 orchestrator HTTP server 上
（`/mcp` 与 REST `/api/*` 同一个 server）。

端口选择 `src-tauri/src/services/orchestrator_service.rs:584-604`：

```rust
async fn bind_reusing_port(bind_host: &str, preferred: Option<u16>) -> Option<TcpListener> {
    if let Some(port) = preferred.filter(|p| *p != 0) {
        match TcpListener::bind(format!("{bind_host}:{port}")).await {
            Ok(l) => return Some(l),
            Err(_) => warn!(...),          // ← 静默降级
        }
    }
    TcpListener::bind(format!("{bind_host}:0")).await.ok()   // ← OS 随机端口
}
```

「复用上次端口，占用了就静默换随机端口」。而随机端口落在 Windows 的
**ephemeral 范围 49152-65535**——正是系统分配给随机出站连接与其它开发工具的区间。
实测用户机器上两个 orchestrator 分别在 `58199` / `65241`，都在该区间内，
重启时被占用的概率不低。

## 为什么修不好：两类消费者只有一类会自愈

| 消费者 | 解析时机 | 端口变化后 |
|---|---|---|
| CC-Panes hooks | **每次调用重新解析**（`cc-panes-cli-hook/src/common/orchestrator.rs:39-57` `resolve_api_endpoint()`：探活 → 失败则重读 manifest） | ✅ 自愈 |
| **CLI 自己的 MCP client** | **进程启动时一次**（Claude `--mcp-config` 写死 `http://127.0.0.1:{port}/mcp`，`cc-cli-adapters/src/claude.rs:159-213`；Codex `-c mcp_servers.ccpanes.url=...`，`codex.rs:156-181`） | ❌ **永久失联** |

`docs/18-mcp-startup-token-analysis.md:507` 已明确记载 CLI 在会话启动时初始化
MCP client 且不再重读配置。

**关键教训**：v0.10.11 的持久化改进把力气全花在了 hook / spawn 这两条**本来就能
自愈**的路径上，而 `docs/18:496` 把「持久化端口被占用时回落到动态端口」列为
**验收接受的行为**——唯一无法自愈的那条路从未被处理。

## 结构性原因

MCP 挂在 **Tauri 进程**（最常重启：更新、崩溃、dev 重编译），
而 **daemon 被刻意设计成比它活得久**（`docs/18:22`「会话可以比应用进程活得久」）。
**会话活下来了，它的端点没有。**

---

## 方案 A：固定端口 + 失败报错（本次实施）

把 `bind_reusing_port` 的策略改为固定端口，占用时**显式报错**而非静默漂移。

### 端口选取

必须在 **Windows ephemeral 范围（49152-65535）之外**，避免与系统随机分配冲突。
建议 `47821` 一类的值（无主流服务占用）。**在代码里定义为具名常量并注释说明选取理由。**

### Dev/Release 隔离（必须处理）

`~/.cc-panes/` 与 `~/.cc-panes-dev/` 要能并行运行（CLAUDE.md 的 Dev/Release 隔离约定），
两者**必须使用不同的固定端口**。参照 `APP_DIR_NAME` 的 `cfg!(debug_assertions)` 模式，
给 dev 一个固定偏移（如 `47821` / `47822`）。

用户机器上**当前就有两个 orchestrator 同时活着**——这不是理论情况。

### 失败行为

固定端口被占用时**不要静默回落到 `:0`**。要：

- 明确 `error!` 日志，写清端口号与"可能被什么占用"的排查提示
- 让用户可见（若有 UI 通知通道则走它；没有就确保日志足够醒目）
- **保留一个逃生阀**：允许通过环境变量或配置覆盖端口，
  否则用户端口真被占用时应用直接不可用。**这个逃生阀不要走 `:0` 随机分配**，
  必须是用户显式指定的确定值。

### manifest 仍然要写

固定端口后 manifest 依然有用（token 复用 + 逃生阀覆盖后的实际端口）。不要删除。

---

## 硬化项 1：manifest 原子写

`orchestrator_service.rs:1033-1057` 目前是裸 `std::fs::write`。
崩溃或断电时可能写出**截断的 manifest**，下次启动 `read_endpoint` 返回 `None`
→ 丢失 preferred port 与 token。

仓库已有 `fs_atomic::write_atomic`（见 `docs/18:519-521`）——改用它。

## 硬化项 2：dev/release manifest 歧义

`docs/18:536`（#9）标为「暂接受」。两套数据目录各有独立 manifest 与端口，
但当前实现对"我该读哪个"没有明确表达。结合方案 A 的固定端口偏移一并理清，
并在代码注释里写明 dev/release 的端口与 manifest 对应关系。

---

## 方案 C（本次不做，仅记录为后续计划）

**stdio 代理**：给 CLI 配一个 stdio MCP server（小二进制），
它自身每次请求都用现有的 `resolve_api_endpoint()` 逻辑解析真实端点。
CLI 配置里**彻底不出现端口**。

- 优点：结构性正解，复用已有且经过验证的解析逻辑；stdio 是 MCP 支持最好的传输
- 代价：每会话多一个进程
- 注意：`claude.rs` 里目前会剥掉一个遗留的失效 `ccpanes-proxy` stdio 条目
  （`docs/18:330`）——**这个方向以前尝试过并放弃了，重做前必须先查清当初为什么放弃**

方案 A 与 C 不冲突，A 可作为 C 落地前的兵家。

---

## 验收

- `cargo check --workspace`
- `cargo clippy --workspace -- -D warnings`
- `cargo test -p cc-panes-core`（workspace 全量可能被 daemon 文件锁阻塞，说明即可）
- 补测试：固定端口常量的 dev/release 差异；manifest 原子写在中断下不产生截断文件
- **手动验证不可省**：改动影响应用能否启动，必须确认 dev 实例能正常起来并被 CLI 连上
- 在汇报里明确：选了哪个端口号、dev/release 分别是多少、逃生阀怎么用

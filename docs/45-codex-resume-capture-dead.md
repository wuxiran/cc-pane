# 45 — Codex resume 失效:OSC 捕获链对 v0.145 全灭 + 交叉污染

> 状态:已定位待修(Worker F 执行依据)。Claude resume 正常,仅 Codex 失效。

## 现象与实证

- 用户 resume Codex(WSL)会话 → 打开的是全新会话。
- **launch_history 实证**:所有近期 codex 记录(含 2026-07-23 当天 6 条 cc-panes 启动的 v0.145 WSL 会话)`resume_session_id` **全为 null**——OSC 标题捕获链对 Codex 完全没落库,resume 时无 id 可传,必然新会话。
- **交叉污染实证**:记录 id 2243 `cli_tool="claude"` 但 resume_session_id=`019f79b6-...`(UUIDv7 = Codex id 格式)——捕获链曾把 Codex thread-id 错关联到 Claude 记录。
- 环境已排除:WSL 内 `CODEX_HOME` 未设置;rollout 布局未变(`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuidv7>.jsonl`,文件名含完整 id);`codex resume <SESSION_ID>` 位置参数语法在 v0.145 仍有效(`codex resume --help` 实测)。

## 已查实的链路(调查报告摘要)

- 启动注入 `-c tui.terminal_title=["activity","project","thread-id"]`(本地 codex.rs:151-154;WSL wsl_codex.rs:1300-1301),`osc_resume_capture.rs` 在 PTY 读线程扫 OSC 0/2 标题取 thread-id 前缀(~29 字符),用前缀 `find` sessions 目录解析完整 UUID(:315 本地 / :352 WSL),emit `terminal-resume-id-detected` → `resume_binding_service.rs` 落库。
- WSL 启动前有 `codex_rollout_exists` 预检(wsl_codex.rs:1315-1334):查无 rollout 时**静默降级为新会话**(仅 warn);预检硬编码 `~/.codex/sessions` 不尊重 CODEX_HOME(本机未触发,但同批修掉)。
- 无任何"恢复成功"正向校验;`wait_resume_diag` 只在退出时记日志。

## 修复要求

1. **先诊断再修**(worker 第一步):在 WSL 起一个 codex v0.145 交互会话(可经 script/pty 捕获),观察其 OSC 0/2 标题实际内容——确认 `tui.terminal_title` 配置是否仍被接受、thread-id 是否还出现在标题、格式是否变化;比对 `osc_resume_capture.rs` 的解析正则,修到能命中 v0.145 的实际标题。若 v0.145 已移除/改名该配置,寻找替代(查 codex 发布说明/config 文档)。
2. **兜底捕获源**:标题捕获之外增加 rollout 目录兜底——launch 后监测 `${CODEX_HOME:-~/.codex}/sessions` 新增的 rollout 文件(创建时间 > launch 时间,且 jsonl 首行 meta 的 cwd 与本会话 cwd 匹配),解析文件名 UUID 作为 resume id 落库(source=`rollout-scan`,优先级低于 osc-title)。两源不一致时以 osc-title 为准并 warn。
3. **修交叉污染**:`resume_binding_service` 关联 id 时校验 id 格式与 cliTool 匹配(UUIDv7→codex、UUIDv4→claude 仅作 sanity warn 不作硬门),更重要的是**绑定必须按 pty_session_id 精确路由**,排查为何 Codex 的 id 会写进 Claude 记录(可能是 OSC 事件带错 session 归属或标题串台),修复归属。
4. **预检与降级可见化**:`resolve_full_id_wsl`/`codex_rollout_exists` 尊重 `${CODEX_HOME:-$HOME/.codex}`;预检失败降级新会话时向前端 emit 警告事件(toast),不再只留后端 warn。
5. **UX**:tab/历史无 resumeSessionId 时,resume 入口禁用或明确提示"该会话未捕获到恢复 ID",不再静默开新会话。
6. 测试:标题解析对 v0.145 实际样本的用例;rollout 兜底扫描用例(含 CODEX_HOME);绑定归属用例;预检降级事件用例。

## 验证

- 手工:cc-panes 启动 Codex(WSL)→ 对话几轮 → launch_history 出现非空 resumeSessionId → 关闭 → resume → 历史对话恢复。
- Claude resume 回归不受影响。

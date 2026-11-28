# 112 · GitHub 交付链（一）：agent 可用的 PR / CI / Issue 能力

> 交付链第一步：让 agent 在 CC-Panes 里直接看 PR 状态、开 PR、读失败 CI 日志、重跑 CI、合并 PR，
> 并让人把 GitHub Issue 一键导入成项目 Todo。参考 t3code #26751（PR 工具）、#26752（CI 日志 / 重跑）、
> `apps/server/src/issue`（Issue 接入）。

## 1. 原则

- **一律走用户本机的 `gh` CLI**，复用 `gh auth login` 的登录态。CC-Panes 不保存、不读取、不转发任何 token。
- **没装 / 没登录 = 入口隐藏**：不弹横幅、不出提示条；MCP 工具调用返回可操作的错误
  （「请安装 https://cli.github.com」/「请运行 `gh auth login`」）。
- **子进程必须显式给 cwd**：`gh` / `git` 都在 `projectPath` 下执行；可用性探测（`gh auth status`）与仓库无关，
  也显式给系统临时目录，绝不继承宿主进程 cwd（dev 下是 `src-tauri/`，见 CLAUDE.md Gotchas）。
- **非交互**：`GH_PROMPT_DISABLED=1`、`NO_COLOR=1`、stdin 置空、90s 超时、8MB 输出上限。GUI 子进程没有终端可答提示，宁可报错。
- **返回摘要不返回原文**：PR checks 只给计数 + 前 10 个失败项；Issue 正文截 6000 字、只带最近 5 条评论；
  CI 日志按 job 只留尾部（见 §4）。

## 2. 分层

| 层 | 位置 | 职责 |
|---|---|---|
| 命令执行抽象 | `cc-panes-core/src/services/github_cli/runner.rs` | `CliRunner` trait（`gh` / `git`，必传 cwd）；生产实现 `SystemCliRunner` 走 `resolve_executable` + `output_with_timeout_limit` |
| 解析与截断 | `github_cli/parse.rs`（纯函数） | auth / PR / checks / run / job / issue 的 JSON 解析，日志分组与截断 |
| 业务 | `github_cli/mod.rs` | `GithubCliService`：可用性缓存、PR / CI / Issue 操作 |
| Issue → Todo | `github_cli/import.rs` | `issue_to_todo_request` + `import_issues` + `mark_imported` |
| MCP | `src-tauri/src/services/orchestrator_service/github_tools.rs` | 7 个 `gh_*` 工具；合并确认往返 |
| Tauri 命令 | `src-tauri/src/commands/github_commands.rs` | `github_cli_status` / `github_list_issues` / `github_import_issues` |
| 前端 | `web/services/githubService.ts`、`web/stores/useGithubStore.ts`、`web/components/todo/GithubIssueImportDialog.tsx`、`web/hooks/useGithubMergeConfirm.ts` | 状态探测、导入对话框、合并确认框 |

测试全部注入假 `CliRunner`（`github_cli/service_tests.rs`），**单测里绝不真调 GitHub**。

## 3. MCP 工具（ccpanes 编排 MCP，已入 `CORE_MCP_TOOLS`）

| 工具 | 参数 | 行为 |
|---|---|---|
| `gh_pr_status` | `projectPath` | 当前分支的 PR：state / draft / reviewDecision / mergeable / mergeStateStatus / checks 摘要；没有 PR 时 `{"pr": null}` |
| `gh_pr_create` | `projectPath, title, body, base?, draft?` | `--head` 取当前分支；`base` 缺省取仓库默认分支（`gh repo view --json defaultBranchRef`）。当前分支 == base 直接拒绝 |
| `gh_pr_merge` | `projectPath, method?` | 见 §5。`method` 缺省 squash |
| `gh_ci_failed_logs` | `projectPath, runId?` | `runId` 缺省取**当前分支**最近一次 `failure` 的 run；返回 run 摘要、失败 job（含失败 step 名）、日志尾部 |
| `gh_ci_rerun` | `projectPath, runId, failedOnly=true` | `gh run rerun <id> [--failed]` |
| `gh_issue_list` | `projectPath, query?` | 默认 open、最多 30 条；`query` 走 GitHub 搜索语法 |
| `gh_issue_view` | `projectPath, number` | 正文（截断）+ 最近 5 条评论 |

**base 分支规范不写进工具**：本仓库的 PR base 是当前 `dev/v*`（docs/87），由调用方（agent / skill）显式传 `base`；
工具本身保持通用，缺省只回落仓库默认分支。

## 4. CI 日志截断

`gh run view <id> --log-failed` 的每行形如 `job\tstep\t<ISO 时间戳> 内容`。处理顺序：

1. 去 ANSI 转义（CSI / OSC）；
2. 按 job 分组，step 切换处插入 `── step ──` 小标题；
3. 去掉行首时间戳，单行截到 400 字符；
4. 每个 job 只留末尾 80 行，最多展示 3 个 job（其余进 `omittedJobs`）；
5. 合计 16KB 预算均分给展示的 job，从尾部按字节截（落在字符边界）。

`--log-failed` 失败（run 还在跑、日志已过期）不算整体失败：返回 run 与失败 job，原因放 `logError`。

## 5. 合并确认（不可逆操作）

仓库里没有通用的 MCP 审批机制（CLAUDE.md Gotchas「给 MCP 开放删除前先问能不能换成可逆操作」）。
合并无法换成可逆操作，所以补了一条**只服务于合并**的前端确认往返，复用已有的 `pending_queries` 通道：

1. 后端先 `gh pr view` 拿到 PR（编号、标题、head/base、`headRefOid`），非 OPEN 直接拒绝；
2. `emit_to("main", "orchestrator-confirm-gh-merge", {requestId, ...})`；
3. 前端 `useGithubMergeConfirm` 弹系统确认框（`nativeConfirm`），经 `respond_orchestrator_query` 回 `{"approved": bool}`；
4. 只有显式 `approved: true` 才合并；拒绝、超时（180s）、前端不在、通道关闭一律拒绝；
5. 合并时带 `--match-head-commit <headRefOid>`：用户确认后若有新推送，gh 拒绝合并，确认的就是被合并的。

## 6. Issue 导入 Todo

- 入口：项目 Todo 视图（`scope=project`）头部的「从 GitHub Issue 导入」按钮，仅 gh 就绪时出现。
- 数据：migration **V47** 给 `todos` 加 `issue_url TEXT` / `issue_number INTEGER`，`issue_url` 上建部分唯一索引
  （`WHERE issue_url IS NOT NULL`），普通任务不受影响。
- 去重：`TodoService::create_or_get_issue_todo` 先按 URL 查，已存在则返回已有任务（`alreadyImported=true`）；唯一索引兜底并发。
  列表接口给每条 issue 标 `importedTodoId`，前端置灰。
- 映射：标题 `#<number> <title>`，描述首行是 issue 链接、其后为正文（已截断），标签沿用 issue labels，scope=project。
- 重复任务（recurrence）生成下一轮时**不继承** issue 链接。

## 7. 未做 / 后续

- Web 壳（cc-panes-web）未开 GitHub 路由：`githubService` 在非 Tauri 运行时视为不可用，入口隐藏。
- 没有 PR 评论 / review / 更新 PR 正文、没有 stack 合并（t3code #38973）——交付链后续步骤再加。
- 需要真机验证：确认框在 macOS / Windows 上的表现；`gh` 2.6x 以前版本没有 `auth status --json`，已回退看退出码，但未在旧版本上实测。

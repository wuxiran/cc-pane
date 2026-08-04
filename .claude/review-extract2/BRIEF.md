# 交叉评审请求 · 老分支抽取第 2 批（OpenCode 会话反查）

你是**独立评审人**。只读评审，**不要改任何代码**。产出问题清单。

仓库根：`/mnt/d/04_workspace_rust/cc-book`（WSL 路径）。
已合入 `/mnt/d/04_workspace_rust/cc-book-merge` 的 main（commit `ade2050`）。
diff 见 `.claude/review-extract2/opencode.diff`（859 行）。

## 背景

从 `feat/opencode-parity`（5 周未合，基线旧）抽取 main 真缺的部分。
整分支合会回退：该分支 `opencode.rs` 停在 761 行，main 已迭代到 1121 行。

main 已能启动 OpenCode 并传 resume 参数，但**拿不到会话 id**——Claude 靠发号、
Codex 靠 OSC 自报，OpenCode 两者都没有，会话只存在它自己的 SQLite 库里。

本批加了：
- `cc-panes-core/src/services/opencode_session_service.rs`（597 行，原样抽取 + 溯源注释）
- `cc-panes-web`：`GET /api/opencode/sessions`
- `src-tauri`：`list_opencode_sessions` 命令
- `web/services/opencodeService.ts` + test

接入方式刻意对齐既有的 `codex_session_service` / `codexService.ts`。

## 请重点攻击

1. **`opencode_session_service.rs` 是 5 周前的代码，原样抽取有没有语境错配？**
   上一批评审你指出过「不能原样复制旧文件，main 的 backend 合约已变」，
   那次确实编译失败（`cleanup_all` 不在 trait 上）。这次它编译过了，
   但**编译过不等于语义对**。请核对它依赖的 core 侧 API/工具函数
   （`no_window_command`、路径规范化、WSL 路径转换等）在 main 上语义是否变过。

2. **SQLite 读取的健壮性**。它直接开 OpenCode 的库文件：
   - OpenCode 正在写时读会怎样（WAL / 锁 / 半写入）？
   - schema 变了（OpenCode 升版）会 panic 还是优雅降级？
   - 路径不存在 / 权限不足的处理？
   - 是否用了只读打开（`OpenFlags`）？有没有可能污染用户的 OpenCode 数据？

3. **WSL 变体的路径处理**。`list_wsl_sessions` / `detect_wsl_session`：
   CLAUDE.md 记着「判断项目路径必须先过 canonical_project_path，注册路径可能以
   `/mnt/d/x` 或 `\\wsl.localhost\...` 形式存着」。这份 5 周前的代码是否遵守了
   这条？跨形式匹配会不会漏/误匹配？

4. **与 codex 版的一致性**。我按 codex 的模式接的路由与命令，
   请核对是否有 codex 那边后来加了、而 opencode 这边缺失的处理
   （错误映射、limit 边界、runtime_kind 判定等）。

5. **是否漏抽**。原分支还有 24 个文件我判定为「main 已有更新版本」。
   请核对 `git diff main...feat/opencode-parity` ——有没有**真正的修复**
   被我当成旧版本误丢了？（上一批你就抓到过这类，两条都成立。）

6. 有没有更该改而没改的地方。

## 输出格式

按严重度排序，每条给 `文件:行` + 问题 + **具体失败场景**。
拿不准的标「存疑」并给验证方法。没问题的部分直接跳过。

注意：本机**没有安装 OpenCode**，你无法实跑验证它的库结构，
这类结论请标注为静态推理，不要假装验证过。

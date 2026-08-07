# 87 — Git 协作规范

> 自 v0.12.1 起生效。此前仓库是「单人直推 main + 偶发 PR」，0.12.1 周期里多人（wuxiran / zhengjunkj / Curl-007）+ 多 AI 实例并行后暴露了一批协作问题：PR 提错 base、main 被误以为动过而重提 PR、发版提交差点混入并行会话的半成品、release 分支不跑 CI。本文固化规则。

## 分支模型

```
main                    稳定线：永远指向最近一次正式发版（或其后的热修）
  └─ dev/v0.12.2        下个版本的集成分支（开发主战场）
       ├─ feat/xxx      功能分支，从 dev/v* 切出，PR 回 dev/v*
       ├─ fix/xxx       修复分支，同上
       └─ (外部贡献)     fork 分支，PR base 选 dev/v*
  └─ release/0.12.1     发版分支：冻结期收尾 + 打 tag 的地方，发完合回 main
```

| 分支 | 谁能推 | 进入方式 | 生命周期 |
|---|---|---|---|
| `main` | 维护者 | 仅从 `release/*` 快进合并（或紧急热修 PR） | 永久 |
| `dev/v*` | 维护者直推 / 其他人 PR | PR（rebase 或 squash，见下） | 到该版本发布，随后并入下个 dev |
| `release/*` | 维护者 | 从 `dev/v*`（或 main）切出 | 发版后合回 main 即冻结 |
| `feat/* fix/*` | 作者 | — | 合并后删除 |

**当前活跃**：`dev/v0.12.2`（日常开发都往这提）；`release/0.12.1`（仅接发版阻断级修复）。

## 核心规则

### 1. PR 的 base 永远选当前 `dev/v*`，不是 main

0.12.1 期间 #56/#57/#58 全部提到了 main，逐个手动改 base 才没把 main 弄乱。**main 上没有开发活动**——你看到 main「没动」不是有人忘了合，是设计如此。

例外：对**已发布版本**的紧急热修（用户在流血）→ base 选 main，合并后由维护者 cherry-pick 进 dev。

### 2. 不要因为「看到自己的 PR 合了但 main 没变」而重提 PR

PR 显示 MERGED 但目标是 `release/*` 或 `dev/*` 时，改动要等发版才进 main。#58 就是这么来的（作者以为 main 被别人动了，基于 main 重做了一遍）。确认去向：PR 页面看 base 分支名。

### 3. 合并方式

- **默认 squash**（仓库既有惯例，历史干净）。
- 作者**刻意组织了多 commit 结构**（如 #56 的 6 个有边界 commit）→ rebase 合并保留结构。在 PR 描述里声明即可。
- 禁止 merge commit 方式合 PR（时间线会和多实例并行开发搅在一起）。
- **squash 流的后果**：判断分支能否删不能用 `git branch -d`，要 `git cherry origin/main <branch>` 按内容比（CLAUDE.md gotcha，判据三层见 docs/72）。

### 4. 发版流程（v0.12.1 实录固化）

```
1. 从 dev/v* 切 release/X.Y.Z（或直接改名，无并行需求时）
2. 收尾修复全进 release 分支，CI 必须全绿（含 macos）
3. bump：恰好 7 个文件一次提交，message 固定 `release: vX.Y.Z`
   CHANGELOG.md / package.json / package-lock.json /
   src-tauri/Cargo.toml / Cargo.lock / src-tauri/tauri.conf.json /
   cc-panes-mobile/pubspec.yaml（恒 +1 后缀）
   ⚠ lock 必须 `npx -y npm@10 install --package-lock-only` 生成
     并 `npx -y npm@10 ci --dry-run` 验证（本地 npm 11 的 lock 会挂 CI）
   ⚠ 提交用精确文件清单 add，禁 `git add -A`——并行会话可能有半成品在工作树
4. 等该提交的 CI 全绿 → 打 tag `vX.Y.Z` 推送 → Release workflow 起飞
5. 产物核对：latest.json 的 darwin 条目是否齐全（并行写竞态未修，
   缺了跑 backfill-macos-updater）
6. `git checkout main && git merge --ff-only release/X.Y.Z && git push`
7. 开下个 dev/v* 分支
```

### 5. 多 AI 实例并行的纪律

同一工作树可能有多个 Claude/Codex 实例在干活（0.12.1 发版提交前 12 分钟，另一实例落了 29 文件的修复）：

- **提交前必看** `git status` + `git log -3`——工作树里不认识的改动是别的实例的半成品，**别 add 进来**；不认识的新提交要读一遍（它会随你的 tag 发出去，CHANGELOG 该补就补）。
- 发现工作树有并行实例的未提交改动时，自己的提交一律精确文件清单。
- 一个实例做发版（bump/tag/push）期间，其他实例不要 commit——发版实例锁定 tip 的窗口要干净。
- 根目录的 0 字节乱码文件是 heredoc/grep 引号事故的产物，见到即删（已多次混入发版提交，bab1376 里有几十个）。

### 6. CI 门禁

- 触发范围：`main` / `develop` / `release/*` / `dev/*` 的 push 与 PR。**新增长期分支模式必须同步 ci.yml**——`release/*` 曾整整一个周期不跑 CI。
- backend-check 三平台（windows/ubuntu/**macos**）缺一不可——macos 是 0.12.1 才加的，此前 mac 代码只在打 tag 时被编译过。
- `cargo test` 带 `--no-fail-fast`：单个 flaky 不得掩盖其他包的真实失败。
- 本地判断 CI 命令成败**禁止 `| tail`**（管道吃掉退出码），用 `${PIPESTATUS[0]}`。
- 改 `cfg` 分支代码必须过对应平台编译（WSL E0425 毒丸法，见 CLAUDE.md gotcha）；mac-only 分支靠 CI macos runner。

### 7. 提交信息

- 语言随作者（中文为主），格式 `type(scope): 摘要 —— 背景/根因`（现有历史风格）。
- 修 bug 的提交要写**为什么错**，不只写改了什么——这个仓库的 CLAUDE.md gotcha 全靠提交信息考古。
- 发版提交恒为 `release: vX.Y.Z`，CHANGELOG 补录用 `docs(changelog): ...`。

## 与既有文档的关系

- 老分支处置判据 → docs/72
- 发版 lock/npm10 细节 → 项目记忆 `release-lockfile-npm10`
- worktree 隔离开发 → `.cargo/config.toml` 共享 target-dir 的两个坑见 CLAUDE.md gotcha

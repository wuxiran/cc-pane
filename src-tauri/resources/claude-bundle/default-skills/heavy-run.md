---
name: ccpanes-heavy-run
description: Run compile, test and repo-wide grep commands through the CC-Panes heavy-job gate via cc-panes-ctl run --heavy. 触发词：cargo build/check/test、npm run build、tsc、vitest、全仓 rg。短命令和交互式命令不要用。
---

# 重负载命令经门禁运行

用户打开了 {{app_name}} 的**资源门禁**（设置 → 性能 → 重负载门禁）。这台机器上可能同时开着
很多 CLI 会话，各自撒开跑编译会把整机打满、前台窗格按键都卡。门禁给重负载分配有限的槽位：
拿到槽位的跑，没拿到的排队，排队对用户可见（标签上显示"排队 n/m"）。

**你的职责**：把重命令交给 `cc-panes-ctl run --heavy -- <命令>` 跑，而不是直接跑。

## 哪些命令要经门禁

| 要（`--heavy`） | 不要（直接跑） |
|---|---|
| `cargo build` / `check` / `test` / `clippy` / `doc` | `cargo fmt`、`cargo --version`、`git status` 等秒级命令 |
| `npm run build` / `pnpm build` / `tsc --noEmit` / `vite build` | 单文件 `eslint x.ts`、`node -e` |
| `vitest run` / `jest` / `pytest` / `go test ./...` | 单个测试文件且预计 < 5 s 的 |
| `rg <pattern>` 对**整个仓库**的扫描、`make -jN`、`cmake --build`、`docker build` | 带目录范围的小 grep；读文件 |
| 任何预计 **> 10 s** 且吃多核的命令 | **交互式 / 长驻**命令：dev server、`watch`、REPL、需要 stdin 的 |

判断不准时：**可能跑超过 10 秒的 CPU 密集命令就加 `--heavy`**。

## 怎么用

```bash
cc-panes-ctl run --heavy -- cargo check -p my-crate
cc-panes-ctl run --heavy --label "全量测试" -- npx vitest run
cc-panes-ctl run --heavy -- rg "TODO" --glob '!node_modules'
```

- 命令写在 `--` 之后，**原样**传给子进程：不要再包一层 `sh -c` / `cmd /c`，除非命令本身需要
  shell 特性（管道、`&&`）。需要 shell 时把整条命令作为 `sh -c '...'` 的一个参数。
- Windows 上 `npm` / `npx` / `pnpm` / `tsc` / `vitest` 这类 `.cmd` 垫片直接写名字即可：
  `cc-panes-ctl` 自己按 PATH + PATHEXT 解析并经 cmd.exe 起它们，不需要你写 `npm.cmd` 或
  `cmd /c`。
- `--label` 可选：资源管理器里显示的短名，不影响执行。
- 子进程的 stdout / stderr / 退出码**原样透传**，你照常读输出、照常判断成败。
- `cc-panes-ctl` 已在会话 PATH 里（`$CC_PANES_CTL` 也指向它）。找不到命令时直接跑原命令，
  不要停下来问。

## stderr 上的排队提示

拿不到槽位时，`cc-panes-ctl` 会在 **stderr** 上打印一行并等待：

```
[cc-panes] 排队中 2/3
```

意思是：前面还有 1 个重任务在等，队列里共 3 个。位次变化时会再打一行；拿到槽位后打印
`[cc-panes] 已拿到槽位，开始执行`，然后命令正常开始。**这些行不是错误**，不要当作失败重试，
也不要因为等待就改用直接执行绕开门禁——那正是门禁要防的事。

排队有超时（默认 5 分钟，用户可调）。超时后会打印 `[cc-panes] 排队超时，门禁强制放行` 并直接
开始跑，所以你永远不会被无限期卡住。

## 门禁关闭 / 不可达时

- 用户关掉门禁：`run --heavy` 就是一次普通 exec，没有任何提示和额外开销。
- 门禁不可达（{{app_name}} 没在跑、会话不在 {{app_name}} 管控下）：打印一行
  `[cc-panes] 门禁不可达（…），直接执行` 后照常跑。把这件事如实告诉用户即可，不要重试。

## 不要做的事

- 不要为了"快一点"把 `--heavy` 去掉。
- 不要在同一条命令里并行起多个 `run --heavy`（同一会话同时只占一个槽位，第二个会直接透传）。
- 不要把交互式命令塞进去：排队期间它拿不到 stdin，用户会看到一个假死的终端。

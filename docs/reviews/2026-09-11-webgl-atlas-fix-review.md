# WebGL 共享图集花屏修复 — 审阅记录与遗留清单

- 日期：2026-09-11
- 树：`dev/v0.12.17`，HEAD `dc2a7620`（已提交）+ 工作树未提交修正
- 性质：只读审阅。本文不改产品代码；改动由指定会话执行。
- 关联：`2026-09-10-ccpanes-orca-full-audit.md`、`…-verification.md`

## 1. 花屏根因（已确认）

截图特征：颜色对、位置对、字形错（CJK 笔画碎块、错位 Latin）。这是渲染层不是数据层——desync/丢字节会给完整字形的乱序文本，不会给碎字形。

机制（`@xterm/addon-webgl 0.19.0`，从 bundle 直接核对）：

- 同配置终端共用一张 char atlas。任一 pane 输出新字形触发加页/`_mergePages` 时，纹理里所有字形 UV 变化。
- 每个 pane 各自持有顶点模型。`terminalAtlasRefresh.ts` 的广播让别的 pane 调 `term.refresh()`，但 `WebglRenderer._updateModel` 对 code/fg/bg 未变的格子 **skip**，不会重新查 UV。所以旧修复（`7790f30c`）只把症状从"大片黑+碎片"变成"颜色对、字形碎"。
- `v0.12.15..v0.12.16` 在 `web/components/panes` 下只改了 `Panel.tsx`，渲染器零改动；不是 16 引入。Windows auto 曾在 `e0e81697`（v0.12.5）前默认降 DOM 就是为了这个 bug（`windows-cjk-guard`）。

## 2. 第一版修复（dc2a7620）为什么把颜色抹掉了

`dc2a7620` 在广播回调里调 `_clearModel(true)`，缺 `_clearModel` 时回退公开 `renderer.clear()`。

bundle 里的实现：

```
_clearModel(e){ this._model.clear(); e && this._glyphRenderer.value?.clear() }
GlyphRenderer.clear(){ this.cells.fill(0,0); this.lineLengths.fill(0,0) }
WebglRenderer.clear(){ this._clearModel(!0); renderLayers.reset(); ... }
renderRows(e,t){ ... beginFrame() ? (_clearModel(!0), _updateModel(0,rows-1)) : _updateModel(e,t);
                 rectangleRenderer.renderBackgrounds(); glyphRenderer.render(model); ... }
```

- `true` 除了清 CPU 侧 `_model`（skip 缓存），还把 `GlyphRenderer.cells`/`lineLengths` 填 0——那是 `render()` 直接画的顶点数据。清完到下一次全量 `_updateModel(0,rows-1)` 之间，任何一次 draw 都画不出字形；`_model` 清空后 `updateBackgrounds(model)` 也拿到全 0，背景色一并消失。
- 广播用自己的 rAF 合批，`term.refresh()` 又走 RenderDebouncer 的 rAF。Claude 真彩色输出每帧都可能加图集页 → 每帧广播 → 每帧清顶点。抹除持续发生，用户看到的就是"没颜色"。
- 公开 `renderer.clear()` 同样是 `_clearModel(!0)`，回退路径一样坏。

工作树修正（未提交）改为 `_clearModel(false)`、删掉 `clear()` 回退：只清 `_model` 让下次 `_updateModel` 把每格视为变化、重写 UV；顶点数据保留，中间帧最多画一帧旧 UV。**方向正确**。

审阅验证：`vitest` 两个文件 17/17 通过；`tsc --noEmit` 退出 0。未做浏览器实测。

## 3. 修复本身的遗留

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| A1 | `_clearModel(false)` 修正未提交 | 待提交 | `terminalAtlasRefresh.ts`、`terminalRendererController.ts`、两个测试、双语 CHANGELOG 都在工作树。dc2a7620 已提交的是错版本，不能只推 HEAD。 |
| A2 | 浏览器实测缺 | 待做 | 需要：≥6 个 WebGL pane + 一个 Claude 真彩色长输出 + 一个 CJK 密集 pane，跑 5 分钟。看：花屏是否复现、颜色是否被抹、`renderer.webgl.atlas.change` 频率。 |
| A3 | `_model.clear()` 后的部分渲染窗口 | 需确认 | `false` 仍会把 `_model` 清空；若在广播 rAF 之后、全量 refresh 的 rAF 之前有任何**部分范围**的 `renderRows(e,t)`，`updateBackgrounds(model)` 会对范围外行拿到 0。理论上 RenderDebouncer 会把 `refresh(0,rows-1)` 合并成全量，但未在运行时证实。A2 实测时专门盯"是否闪一帧无背景"。 |
| A4 | 私有 API 依赖 | 待加守卫 | `_renderer._clearModel` 是 addon-webgl 内部字段。建议 `package.json` 锁死 `@xterm/addon-webgl` 精确版本（现在是 `^0.19.0`），并在 `invalidateWebglGlyphModel` 返回 false 时打一条 `renderer.webgl.atlas.invalidate.unavailable` 日志，升级时能看见退化。 |
| A5 | Windows CJK 场景是否恢复默认 DOM | 决策 | 兜底路径修好后可以继续 auto-WebGL；但 `windows-cjk-guard` 被拿掉的理由是"运行时兜底够用"，这次证明兜底曾经不够。建议 A2 通过后再保留 auto，否则先恢复 guard。 |
| A6 | 工作树杂项 | 待处理 | `pelican-coast-ride.html`、`src-tauri/tauri.local-hotfix.conf.json`（version 0.12.12）、`.ccpanes/history/` 未跟踪；提交 A1 时不要 `git add -A`。 |

## 4. 全量审计里仍未完成的项（按我 09-10 的排序）

对证文档判定"成立"且我读代码复核过的，全部还没动：

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| B1 | daemon 创建持全局写锁 45s，write/resize/claim 全部排队 | `cc-panes-daemon/src/server.rs:867` 写锁到 handler 返回；`:1010`-`:1423` 14 处读锁 | 未动 |
| B2 | daemon `write_session` 在 tokio worker 上同步 `backend.write`（512B 分片 × 30ms） | `server.rs:1257-1279`；`terminal_service.rs:1376-1378` | 未动 |
| B3 | web WS 接收循环同步调 backend；100ms 同步轮询 | `cc-panes-web/src/ws_handler.rs:141-165`、`:183-198` | 未动 |
| B4 | 前端输入队列无上限、无超时 | `web/services/terminalService.ts:243-270`、`:366-374` | 未动 |
| B5 | kill 与 wait 线程双 reap，退出码记 -1 | `pty/mod.rs:210-215`、`terminal_service.rs:4160` | 未动 |
| B6 | 磁盘库失败静默切内存库，无 UI 提示 | `src-tauri/src/lib.rs:1610-1622` | 未动 |
| B7 | SSH 满通道整段丢弃，desync 不带 seq | `terminal_service.rs:4025-4058` | 未动，已降 P2（有 ReplayBuffer + desync 兜底） |

## 5. 审阅方法记录

- 每条结论都以当前树的文件:行为准，不引用两份旧审计的行号。
- addon-webgl 的行为从 `node_modules/@xterm/addon-webgl/lib/addon-webgl.js` 直接 grep 核对，不凭记忆。
- 本次没有运行浏览器，A2/A3 是明确的未验证项，不能因为单测过就宣称修好。
- 自改自用风险：CC-Panes 正在运行的实例就是被改的产品；渲染器改动出错会让审阅用的终端本身花屏/失色。建议改动方在独立 dev 实例验证，不在承载当前会话的实例上热替换。

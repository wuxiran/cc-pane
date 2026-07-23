# 47 — 卸载残留清理(独立批次 plan)

> 状态:plan 待用户确认后派发。调查结论见下,残留全景已由只读 agent 盘点(2026-07-24)。

## 背景与调查结论

用户反馈"卸载 CC-Panes 删不干净"。盘点确认:**卸载器是纯默认 NSIS**(`tauri.conf.json:36` targets=all,无自定义模板/hook,`deleteAppDataOnUninstall` 未配置),只删安装目录与 `ccpanes://` 协议注册表。五类残留:

1. **`~/.cc-panes/` 数据目录全量残留**(data.db/memory.db/providers/workspaces/壁纸媒体/skills/crash.log…;用户若自定义 data_dir 则更不可控);
2. **Tauri 平台目录**:`%APPDATA%\com.ccpanes.app\logs\`(KeepAll 永不清)、`%LOCALAPPDATA%\com.ccpanes.app\EBWebView\`(WebView2 缓存,可达数百 MB);
3. **注入到其他 CLI 全局目录**(最隐蔽):`~/.claude/commands/ccpanes/*`、`~/.codex/skills/ccpanes-*`、**`~/.grok/config.toml` 含 token 的 MCP URL**、`~/.claude.json.ccpanes.bak`;
4. **项目目录死配置**(最高危,持续报错):每个被管理项目的 `.claude/settings.local.json` hooks 指向 `cc-panes-cli-hook.exe` 绝对路径,卸载后每次 Claude 会话尝试执行死路径;`.codex/config.toml`/`.codex/hooks.json` 同理;
5. **进程占用**:daemon/web 无卸载前 kill,exe 被占用删除失败 → 安装目录残留一半。

`RunEvent::Exit`(lib.rs:2416-2444)只清进程/存状态,不删盘——已核实。

## 方案(五件套)

### 1. NSIS 卸载 hook:进程清理(修复残留 #5)

- `tauri.conf.json` 配 `bundle.windows.nsis.installerHooks` 自定义 NSIS hook 文件;`NSIS_HOOK_PREUNINSTALL` 中 `taskkill /F /IM cc-panes.exe /IM cc-panes-daemon.exe /IM cc-panes-web.exe`(容错:进程不存在不报错)。
- 同时覆盖升级路径(updater passive 安装前同样需要,配 `NSIS_HOOK_PREINSTALL`)。

### 2. 卸载可选删除用户数据(修复 #1/#2)——2026-07-24 修订

> 原方案的 `deleteAppDataOnUninstall` 在本项目 Tauri 2.11.0 的 NsisConfig schema 中不存在
> (additionalProperties: false,配置即构建非法),Worker G 查实后按纪律停工。修订如下:

- **不用配置字段,改在 `NSIS_HOOK_POSTUNINSTALL` 里用 `MessageBox MB_YESNO|MB_ICONQUESTION`** 询问"是否同时删除应用数据(设置、工作空间、会话历史)?此操作不可恢复"——选是则删:`$APPDATA\com.ccpanes.app`、`$LOCALAPPDATA\com.ccpanes.app`、`$PROFILE\.cc-panes`;选否(**默认按钮设为否**,`MB_DEFBUTTON2`)全部保留。
- 静默卸载(`/S`,含 updater 的 passive 卸载路径)检测 `IfSilent` **一律不删**——升级绝不能清数据。
- 删除实现用固定字面路径 + `RMDir /r`,拒绝跟随 junction 的额外防护若 NSIS 原语不支持则在文档注明残留边界;自定义 data_dir 场景 hook 无法感知,文档注明需应用内清理(第 3 件套)或手动。

### 3. 应用内「干净卸载」入口(修复 #3/#4,只有应用自己知道注入过哪)

设置 → 关于 新增「卸载前清理」:
- 反注入 CLI 全局目录:删 `~/.claude/commands/ccpanes/`、`~/.claude/skills/` 中 ccpanes 项、`~/.codex/skills/ccpanes-*`、`~/.grok/config.toml` 的 `[mcp_servers.ccpanes]`(含 token,**优先级最高**);复用 `default_skill_service` 已有的 stale 清理逻辑反向全量化。
- 撤销项目 hook:遍历已注册项目,移除 `.claude/settings.local.json` 中指向 cc-panes-cli-hook 的 hooks 条目与 `.codex/` 等注入(复用注入代码的定位逻辑做逆操作;只删自己写入的条目,不碰用户手写内容)。
- 清理 `~/.claude.json.ccpanes.bak`(提示后删)。
- 执行完展示清理报告(删了什么、哪些项目不可达跳过)。

### 4. hook 死路径自愈(保护已卸载的存量用户)

- cli-hook 注入的命令包一层存在性探测(如 `cmd /c if exist "<exe>" "<exe>" %*` 或等价最短形式),exe 不在时静默退出零干扰——新注入立即生效;
- 应用启动时的 hook 注入维护逻辑顺带把旧格式(裸绝对路径)升级为新格式,老用户升级一次后即获得自愈。
- 注意 docs/44 刚加的 SessionEnd reason 过滤不受影响(包装层在外)。

### 5. 文档

- `docs/13-packaging.md` 补「卸载」章节:卸载器行为、勾选语义、残留清单;
- `docs/guide/appendix-a` 补手动清理指引(给已经卸载的老用户):逐条路径 + 注册表键。

## 边界与风险

| 风险 | 缓解 |
|---|---|
| NSIS hook 语法错误导致安装器构建失败 | CI 构建即验证;hook 保持最小 |
| 误删用户数据 | `~/.cc-panes` 默认不勾;hook 内仅删固定相对路径,拒绝跟随 junction |
| 反注入误删用户手写配置 | 只删带 ccpanes 签名/URL 特征的条目(注入代码已有 ownership 判定,复用) |
| taskkill 杀掉用户另一实例(dev/release 并存) | 按 exe 完整路径过滤仅杀本安装目录进程;dev 的 identifier 不同天然隔离 |
| hook 包装层改变 stdin/退出码语义 | cli-hook 测试覆盖包装前后行为一致;SessionEnd reason 过滤回归 |

## 验证

- CI 构建 NSIS 安装包成功;本地安装 → 运行(触发各注入)→ 卸载(勾/不勾两种)→ 对照残留清单逐项检查。
- 应用内清理:执行后检查 `~/.claude`/`~/.codex`/`~/.grok` 与两个测试项目的 hook 条目;清理报告与实际一致。
- 死路径自愈:删掉 exe 后启动 Claude 会话,hook 静默跳过无报错。
- 单独发版(如 0.11.1),不与 0.11.0 混批。

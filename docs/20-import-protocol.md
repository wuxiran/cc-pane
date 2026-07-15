# CC-Panes 一键导入协议（`ccpanes://`）

> OS 级自定义 URL 协议规范。任何网页 / 工具都可以生成一个 `ccpanes://` 链接，用户点击后
> **唤起 CC-Panes 桌面端**（应用未运行也会被拉起），弹出**确认框**，用户确认后把 Provider /
> Skill / MCP 一键导入到 CC-Panes 全局配置。设计对齐 cc-switch 的 `ccswitch://`。

- 实现：`src-tauri/src/import/mod.rs`（解析）、`src-tauri/src/commands/import_commands.rs`（执行）、`src-tauri/src/lib.rs`（deep-link 接线）、`web/components/resources/ImportConfirmDialog.tsx`（确认弹窗）。
- 相关：[资源中心与全局资源管理](19-borrow-cli-manager-features.md)。

---

## 1. URL 结构

```
ccpanes://v1/import?resource=<type>&<params...>
```

| 部分 | 值 | 说明 |
|------|----|------|
| scheme | `ccpanes`（正式版）/ `ccpanes-dev`（开发版） | dev 与 release 隔离，互不抢协议 |
| host（版本） | `v1` | 协议版本，目前仅 `v1` |
| path | `/import` | 固定 |
| `resource` | `provider` \| `skill` \| `mcp` | 必填，决定后续参数 |

- 所有参数值遵循标准 URL query 编码（`encodeURIComponent`）。
- 含二进制/结构化内容的参数（如 mcp `config`）用 **Base64（标准，非 URL-safe）** 承载再 URL 编码。
- 未知参数会被忽略；缺少必填参数会解析失败并提示。

**行为**：链接被解析后，CC-Panes **不会静默导入**——先弹确认框展示内容（API Key 掩码显示），
用户点「确认导入」才落盘。不信任的链接可直接取消。

---

## 2. `resource=provider` — 导入供应商

| 参数 | 必填 | 说明 |
|------|:---:|------|
| `name` | ✅ | 供应商显示名 |
| `app` | ✅ | 目标 CLI：`claude` \| `codex` \| `gemini` \| `kimi` \| `glm` \| `cursor` \| `opencode` |
| `endpoint` | ⬜ | Base URL；可逗号分隔多个，**第一个**作为主 `base_url` |
| `apiKey` | ⬜ | API 密钥（确认框中掩码显示） |

`app` → CC-Panes ProviderType 映射：`codex→OpenAI`、`gemini→Gemini`、`kimi→Kimi`、
`glm→Glm`、`cursor→Cursor`、`opencode→OpenCode`、其余（含 `claude`）→ `Anthropic`。

**示例**
```
ccpanes://v1/import?resource=provider&name=My%20Relay&app=claude&endpoint=https://api.example.com&apiKey=sk-ant-xxx
```

---

## 3. `resource=skill` — 导入技能

| 参数 | 必填 | 说明 |
|------|:---:|------|
| `id` | 二选一 | CC-Panes Skill 市场条目 id（走市场安装，**sha256 校验**落 `~/.cc-panes/skills/user/<id>/`） |
| `repo` | 二选一 | `owner/name` 形式的 Git 仓库（**已可解析，执行导入后续支持**） |

> 至少提供 `id` 或 `repo` 之一。当前执行仅支持 `id`（市场安装）；`repo` 克隆导入在路线图上。

**示例**
```
ccpanes://v1/import?resource=skill&id=rust-review-patterns
```

---

## 4. `resource=mcp` — 导入共享 MCP

| 参数 | 必填 | 说明 |
|------|:---:|------|
| `name` | ✅ | 共享 MCP 服务名 |
| `config` | ✅ | **Base64(JSON)**，标准 MCP server 定义：`{ "command": "...", "args": [...], "env": {...} }`，必须含非空 `command` |

导入后作为**共享 MCP**（进程托管、自动分配端口、健康检查），`bridge_mode` 默认 `McpProxy`、`shared=false`。

**示例**（`config` = Base64 of `{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}`）
```
ccpanes://v1/import?resource=mcp&name=fs&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZXJ2ZXItZmlsZXN5c3RlbSIsIi90bXAiXX0=
```

---

## 5. 生成链接（网页侧示例）

```html
<a id="btn">在 CC-Panes 中导入</a>
<script>
  const params = new URLSearchParams({
    resource: "provider",
    name: "My Relay",
    app: "claude",
    endpoint: "https://api.example.com",
    apiKey: "sk-ant-xxx",
  });
  document.getElementById("btn").href = `ccpanes://v1/import?${params}`;

  // mcp：config 需 Base64(JSON)
  const mcpConfig = btoa(JSON.stringify({ command: "npx", args: ["-y", "server-x"] }));
  const mcpUrl = `ccpanes://v1/import?resource=mcp&name=srv&config=${encodeURIComponent(mcpConfig)}`;
</script>
```

开发版把 scheme 换成 `ccpanes-dev://`。命令行冒烟测试：
- Windows：`start ccpanes-dev://v1/import?resource=skill&id=x`
- macOS：`open 'ccpanes-dev://v1/import?resource=skill&id=x'`
- Linux：`xdg-open 'ccpanes-dev://v1/import?resource=skill&id=x'`

---

## 6. 跨平台唤起路径（实现说明）

| 平台 | 唤起路径 |
|------|---------|
| Windows / Linux | 第二次启动的进程把 `ccpanes://` URL 放进 `argv`，经 `tauri-plugin-single-instance` 回调解析 |
| macOS | `tauri-plugin-deep-link` 的 `on_open_url` + `RunEvent::Opened` |

解析成功后后端 `emit("ccpanes-import", <ImportRequest>)`；失败 `emit("ccpanes-import-error", <msg>)`。
前端 `ImportConfirmDialog` 监听并弹确认框，确认后调 `execute_import`。

---

## 7. HTTP 兜底（应用已运行时）

deep-link 负责「应用关着也能唤起」；若应用**已在运行**，网页也可直接 POST 到本机
`cc-panes-web` 的 loopback 接口（受 `web_auth` 保护）：

- Provider：`POST /api/providers`（body 为 Provider JSON）
- 共享 MCP：`POST /api/shared-mcp/servers`

> Skill 市场安装目前仅走桌面端（deep-link / 资源中心 UI），无 HTTP 安装端点。

---

## 8. 安全约定

1. **绝不静默导入**：所有导入必须经用户在确认框中点确认。
2. **密钥掩码**：确认框只展示掩码后的 `apiKey`。
3. **只解析、后落盘**：`parse_import_url` 纯解析不写盘；写盘走确认后的 `execute_import`。
4. 用户应只点击**信任来源**的 `ccpanes://` 链接（等同于导入一份配置/凭证）。

---

## 9. 版本与兼容

- 当前版本 `v1`。新增字段应保持**向后兼容**（未知参数忽略）。破坏性变更走 `v2`（新 host 段），旧版拒绝并提示「不支持的协议版本」。

# 清理僵尸进程

扫描并清理系统中残留的僵尸进程（如 `npx serve`、孤儿 node/cmd 等）。

---

## 工作流程

### 步骤 1: 扫描进程现状

统计当前 node.exe 和 cmd.exe 总数：

```bash
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|cmd)\.exe$' } | Group-Object Name | Select-Object Name, Count | Format-Table -AutoSize"
```

### 步骤 2: 分类识别

将 node 进程按用途分类，区分正常进程和僵尸进程：

```bash
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { if($_.CommandLine -match 'claude|mcp|Desktop.Commander') { 'mcp-related' } elseif($_.CommandLine -match 'serve.*dist|npx.*serve') { 'npx-serve-zombie' } elseif($_.CommandLine -match 'next|vite|webpack|turbo') { 'dev-server' } elseif($_.CommandLine -match 'pnpm|npm|yarn') { 'pkg-manager' } else { 'other' } } | Group-Object | Select-Object Name, Count | Sort-Object Count -Descending | Format-Table -AutoSize"
```

**分类说明：**

| 类别 | 是否可杀 | 说明 |
|------|----------|------|
| `mcp-related` | 不可杀 | 当前 Claude Code 会话的 MCP 服务器 |
| `dev-server` | 谨慎 | Next.js/Vite 等开发服务器，确认不需要再杀 |
| `pkg-manager` | 谨慎 | pnpm/npm 正在执行的任务 |
| `npx-serve-zombie` | 可以杀 | 残留的 npx serve 静态服务器 |
| `other` | 需确认 | 抽样查看命令行后决定 |

### 步骤 3: 展示待清理目标

列出所有匹配僵尸特征的进程详情（PID、命令行、创建时间）：

```bash
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'serve.*dist|npx.*serve' } | Select-Object ProcessId, @{N='Created';E={$_.CreationDate.ToString('MM-dd HH:mm')}}, @{N='Cmd';E={ if($_.CommandLine.Length -gt 100) { $_.CommandLine.Substring(0,100)+'...' } else { $_.CommandLine } }} | Format-Table -AutoSize"
```

### 步骤 4: 确认并清理

**必须先向用户展示步骤 3 的结果，获得确认后才执行！**

杀掉确认的僵尸进程：

```bash
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'serve.*dist|npx.*serve' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"
```

### 步骤 5: 验证结果

确认清理效果：

```bash
powershell -Command "$remaining = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'serve.*dist|npx.*serve' }).Count; Write-Host \"残留 serve 进程: $remaining\"; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|cmd)\.exe$' } | Group-Object Name | Select-Object Name, Count | Format-Table -AutoSize"
```

### 步骤 6: 报告

向用户汇报清理结果，格式：

```
## 清理完成

- 清理前: X 个 node / Y 个 cmd
- 已杀掉: Z 个僵尸进程（npx serve dist）
- 清理后: A 个 node / B 个 cmd
- 跳过: MCP 服务器 N 个、开发服务器 M 个（正常运行中）
```

## 注意事项

- **绝对不能杀 MCP 相关进程**（命令行含 `claude`、`mcp`、`Desktop.Commander`），否则当前 Claude 会话会断开
- 清理前必须向用户确认范围
- 如果 `other` 类别数量较多，应抽样展示命令行让用户判断
- Windows 平台专用（使用 PowerShell + Get-CimInstance）

import Foundation

/// `-mockMirror YES` 的内置样例：八个布局（含左右 / 上下嵌套分屏）、四种相位、真实形态的 TUI 输出。
/// 只用于离线截图 / UI 调试，不参与正常数据流。
enum MirrorFixture {
    private static let root = "/Users/dev/workspace"

    static func snapshot() -> LayoutSnapshot {
        let iso = Date.now.addingTimeInterval(-8).formatted(.iso8601)
        return LayoutSnapshot(currentLayoutId: "L-main", layouts: [
            LayoutEntry(id: "L-main", name: "cc-pane", rootPane: .split([
                panel("p1", [tab("t1", "cc-pane (Claude)", "cc-pane", "s-wait", "claude")]),
                panel("p2", [tab("t2", "cc-pane (Claude)", "cc-pane", "s-run", "claude")]),
                panel("p3", [tab("t3", "cc-pane-ios (Codex)", "cc-pane", "s-idle", "codex"),
                             LayoutTab(id: "b1", title: "飞书 - 登录", contentType: "browser", projectPath: "")]),
            ], horizontal: true, sizes: [40, 30, 30])),
            LayoutEntry(id: "L-api", name: "api-server", rootPane: .split([
                panel("p4", [tab("t4", "api-server (Claude)", "api-server", "s-api", "claude")]),
                .split([
                    panel("p5", [tab("t5", "Terminal", "api-server", "s-shell", nil)]),
                    panel("p6", [tab("t6", "web-console (Codex)", "web-console", "s-web", "codex")]),
                ], horizontal: false, sizes: [55, 45]),
            ], horizontal: true, sizes: [50, 50])),
            LayoutEntry(id: "L-docs", name: "发版 · release 0.13", rootPane: .split([
                panel("p7", [tab("t7", "docs-site 发 release", "docs-site", "s-docs", "claude")]),
                panel("p8", [tab("t8", "mobile-app (Claude)", "mobile-app", "s-exit", "claude")]),
            ], horizontal: true, sizes: [50, 50])),
            LayoutEntry(id: "L-notes", name: "notes", rootPane:
                panel("p9", [tab("t9", "notes (Claude)", "notes", "s-notes", "claude")])),
            LayoutEntry(id: "L-ios", name: "ios 客户端", rootPane: .split([
                panel("p10", [tab("t10", "cc-panes-ios (Claude)", "cc-panes-ios", "s-ios", "claude")]),
                panel("p11", [tab("t11", "simctl", "cc-panes-ios", "s-sim", nil)]),
            ], horizontal: false, sizes: [65, 35])),
            LayoutEntry(id: "L-infra", name: "infra · k8s", rootPane: .split([
                panel("p12", [tab("t12", "infra (Codex)", "infra", "s-k8s", "codex")]),
                panel("p13", [tab("t13", "kubectl logs", "infra", "s-logs", nil)]),
                panel("p14", [tab("t14", "terraform (Claude)", "infra", "s-tf", "claude")]),
                panel("p15", [tab("t15", "helm", "infra", "s-helm", nil)]),
            ], horizontal: true, sizes: [25, 25, 25, 25])),
            LayoutEntry(id: "L-review", name: "review #87 session-cost", rootPane: .split([
                panel("p16", [tab("t16", "review (Codex)", "cc-pane", "s-review", "codex")]),
                panel("p17", [tab("t17", "cc-pane (Claude)", "cc-pane", "s-fix", "claude")]),
            ], horizontal: true, sizes: [50, 50])),
            LayoutEntry(id: "L-scratch", name: "scratch", rootPane:
                panel("p18", [tab("t18", "Terminal", "scratch", "s-scratch", nil)])),
        ], savedAt: iso, workspaceName: "cc-pane", source: "mock")
    }

    static func sessions() -> [SessionInfo] {
        let now = Int64(Date.now.timeIntervalSince1970 * 1000)
        func info(_ id: String, _ status: String, ago: Int64, tool: String? = nil, exit: Int? = nil) -> SessionInfo {
            SessionInfo(sessionId: id, status: status, lastOutputAt: now - ago * 1000, updatedAt: now - ago * 1000,
                        exitCode: exit, currentToolName: tool)
        }
        return [
            info("s-wait", "waitingInput", ago: 40),
            info("s-run", "toolRunning", ago: 2, tool: "Bash"),
            info("s-idle", "idle", ago: 600),
            info("s-api", "thinking", ago: 5),
            info("s-shell", "idle", ago: 3600),
            info("s-web", "waitingInput", ago: 90),
            info("s-docs", "active", ago: 12),
            info("s-exit", "exited", ago: 7200, exit: 0),
            info("s-notes", "idle", ago: 86_400),
            info("s-ios", "toolRunning", ago: 3, tool: "Edit"),
            info("s-sim", "idle", ago: 300),
            info("s-k8s", "waitingInput", ago: 20),
            info("s-logs", "active", ago: 1),
            info("s-tf", "thinking", ago: 8),
            info("s-helm", "idle", ago: 1800),
            info("s-review", "idle", ago: 240),
            info("s-fix", "waitingInput", ago: 15),
            info("s-scratch", "exited", ago: 5400, exit: 1),
        ]
    }

    static func output(_ sessionId: String) -> [String] {
        let footer = ["", String(repeating: "─", count: 60), "❯", String(repeating: "─", count: 60),
                      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt"]
        switch sessionId {
        case "s-wait":
            return [" Do you want to proceed?", " ❯ 1. Yes", "   2. No, and tell Claude what to do differently",
                    " Enter to confirm · Esc to cancel"]
        case "s-run":
            return ["⏺ Bash(xcodebuild -scheme CCPanes build)", "  ⎿  Running… (42s · timeout 10m)",
                    "     (ctrl+b to run in background)", "", "✻ Compiling… (1m 12s · ↓ 2.1k tokens)"] + footer
        case "s-idle":
            return ["※ recap: 终端 tab 的布局切换已经完成，测试全绿。下一步等你确认截图后再合并。", "  (turn off recaps in /config)"] + footer
        case "s-api":
            return ["⏺ Read(src/routes/sessions.rs)", "", "✻ Pondering… (18s · ↓ 640 tokens)"] + footer
        case "s-shell":
            return ["$ cargo test -p api-server", "test result: ok. 128 passed; 0 failed; 0 ignored", "$"]
        case "s-web":
            return ["Allow command `npm run build`?", "  [y] Yes  [n] No  [a] Always"]
        case "s-docs":
            return ["⏺ 正在生成 CHANGELOG，汇总 0.13 的 42 个提交…", "", "✻ Writing… (2m 3s)"] + footer
        case "s-exit":
            return ["Process exited with code 0"]
        case "s-ios":
            return ["⏺ Update(CCPanes/Features/LayoutPickerSheet.swift)", "", "✻ Editing… (34s)"] + footer
        case "s-k8s", "w-engine":
            return [" Run `kubectl rollout restart deploy/api`?", " ❯ 1. Yes", "   2. No"]
        case "s-fix":
            return [" Do you want to make this edit to MirrorScope.swift?", " ❯ 1. Yes", "   2. No"]
        case "s-logs":
            return ["api-7d9f 200 GET /api/sessions 3ms", "api-7d9f 200 GET /api/layout-snapshot 5ms"]
        default:
            return footer
        }
    }

    /// 额外的虚拟电脑（只在「终端」tab 的 `-mockMirror` 下追加，测多电脑密度）：一台在线 Windows、一台离线 NAS。
    static func extraComputers(now: Date = .now) -> [(id: String, name: String, online: Bool, state: MirrorState)] {
        let iso = now.addingTimeInterval(-25).formatted(.iso8601)
        let win = LayoutSnapshot(currentLayoutId: "W-game", layouts: [
            LayoutEntry(id: "W-game", name: "game-engine", rootPane: .split([
                panel("w1", [tab("wt1", "engine (Claude)", "game-engine", "w-engine", "claude")]),
                .split([
                    panel("w2", [tab("wt2", "shaders (Codex)", "game-engine", "w-shader", "codex")]),
                    panel("w3", [tab("wt3", "PowerShell", "game-engine", "w-ps", nil)]),
                ], horizontal: false, sizes: [50, 50]),
            ], horizontal: true, sizes: [60, 40])),
            LayoutEntry(id: "W-wsl", name: "WSL · ubuntu", rootPane: .split([
                panel("w4", [tab("wt4", "wsl-codex (Codex)", "wsl", "w-wsl", "codex")]),
                panel("w5", [tab("wt5", "bash", "wsl", "w-bash", nil)]),
            ], horizontal: true, sizes: [50, 50])),
            LayoutEntry(id: "W-docs", name: "docs", rootPane:
                panel("w6", [tab("wt6", "docs (Gemini)", "docs", "w-docs", "gemini")])),
        ], savedAt: iso, workspaceName: "game", source: "mock")
        let stamp = Int64(now.timeIntervalSince1970 * 1000)
        func info(_ id: String, _ status: String, ago: Int64) -> SessionInfo {
            SessionInfo(sessionId: id, status: status, lastOutputAt: stamp - ago * 1000, updatedAt: stamp - ago * 1000)
        }
        let winSessions = [info("w-engine", "waitingInput", ago: 30), info("w-shader", "toolRunning", ago: 2),
                           info("w-ps", "idle", ago: 900), info("w-wsl", "thinking", ago: 6),
                           info("w-bash", "idle", ago: 1200), info("w-docs", "idle", ago: 3600)]
        return [
            ("mock-win", "Windows 工作站", true,
             buildMirrorState(snapshot: win, running: winSessions, localLaunches: [:], now: now)),
            ("mock-nas", "build-nas", false, MirrorState()),
        ]
    }

    private static func panel(_ id: String, _ tabs: [LayoutTab]) -> PaneNode {
        .panel(id: id, activeTabId: tabs.first?.id, tabs: tabs)
    }

    private static func tab(_ id: String, _ title: String, _ project: String, _ sid: String, _ cli: String?) -> LayoutTab {
        LayoutTab(id: id, title: title, projectPath: "\(root)/\(project)", sessionId: sid, cliTool: cli)
    }
}

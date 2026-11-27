import Foundation

/// GET /api/auth/status
struct AuthStatus: Decodable, Sendable {
    var authRequired: Bool
    var authenticated: Bool
    var username: String?
    var readOnly: Bool
    var remoteAuthenticatedWrite: Bool?

    /// 远程只读模式下，只有开了「允许已登录的远程会话写入」才可操作终端。
    var canWrite: Bool { !readOnly || (remoteAuthenticatedWrite ?? false) }
}

/// GET /api/sessions 元素（cc-panes-core SessionStatusInfo）。
struct SessionInfo: Decodable, Identifiable, Sendable, Hashable {
    var sessionId: String
    var status: String
    var lastOutputAt: Int64?
    var updatedAt: Int64?
    var pid: Int?
    var exitCode: Int?
    var currentToolName: String?
    var currentToolSummary: String?
    var runtimeKind: String?

    var id: String { sessionId }
    var exited: Bool { exitCode != nil || status == "exited" }
}

/// GET /api/launch-history 元素：会话起名 + 启动 sheet 的「最近启动（可恢复）」。
struct LaunchRecord: Decodable, Sendable, Equatable {
    var id: Int?
    var projectName: String?
    var projectPath: String?
    var ptySessionId: String?
    var cliTool: String?
    var workspaceName: String?
    var launchedAt: String?
    var resumeSessionId: String?
    var lastPrompt: String?

    var canResume: Bool { resumeSessionId?.isEmpty == false }
}

/// GET /api/workspaces 元素。
struct Workspace: Decodable, Identifiable, Sendable, Hashable {
    var id: String
    var name: String
    var alias: String?
    var path: String?
    var hidden: Bool?
    var pinned: Bool?
    var archivedAt: String?
    var projects: [WorkspaceProject]

    var displayName: String { (alias?.isEmpty == false ? alias : nil) ?? name }
    var isPinned: Bool { pinned ?? false }
    var isHidden: Bool { hidden ?? false }

    enum CodingKeys: String, CodingKey { case id, name, alias, path, hidden, pinned, archivedAt, projects }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? name
        alias = try c.decodeIfPresent(String.self, forKey: .alias)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned)
        archivedAt = try c.decodeIfPresent(String.self, forKey: .archivedAt)
        projects = try c.decodeIfPresent([WorkspaceProject].self, forKey: .projects) ?? []
    }
}

struct WorkspaceProject: Decodable, Identifiable, Sendable, Hashable {
    var id: String
    var path: String
    var alias: String?

    var displayName: String {
        if let alias, !alias.isEmpty { return alias }
        return pathBasename(path)
    }
}

/// 项目显示名：路径最后一段（兼容 Windows 反斜杠）。
func pathBasename(_ path: String) -> String {
    let parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" })
    return parts.last.map(String.init) ?? path
}

struct TerminalGeometry: Decodable, Sendable, Equatable {
    var cols: Int
    var rows: Int
}

struct TerminalCheckpoint: Decodable, Sendable {
    var snapshotAnsi: String
    var cols: Int
    var rows: Int
}

/// GET /api/sessions/{id}/recovery-snapshot：照片（直写）+ delta（raw 字节）+ 末尾序号。
struct RecoverySnapshot: Decodable, Sendable {
    var checkpoint: TerminalCheckpoint?
    var delta: String
    var endSeq: UInt64
    var deltaGeometry: TerminalGeometry?

    /// 当前 PTY 网格：优先 delta 起点尺寸，其次照片尺寸。
    var geometry: TerminalGeometry? {
        deltaGeometry ?? checkpoint.map { TerminalGeometry(cols: $0.cols, rows: $0.rows) }
    }
}

/// 旧版 GET /api/sessions/{id}/snapshot（无序号），recovery 不可用时兜底。
struct ReplaySnapshot: Decodable, Sendable {
    var data: String
}

enum CliTool: String, CaseIterable, Identifiable, Sendable {
    case claude, codex, none
    var id: String { rawValue }
    var label: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .none: "终端"
        }
    }
    var systemImage: String {
        switch self {
        case .claude: "sparkles"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .none: "terminal"
        }
    }
}

import Foundation
import Observation

/// 「工作区」tab：工作空间树 + 启动历史（启动 sheet 的「最近启动」）。进入加载一次，下拉刷新。
@MainActor
@Observable
final class WorkspacesModel {
    private(set) var workspaces: [Workspace] = []
    private(set) var history: [LaunchRecord] = []
    private(set) var loaded = false
    private(set) var error: String?

    private let api: APIClient

    init(api: APIClient) { self.api = api }

    var metrics: WorkspaceMetrics { WorkspaceMetrics(workspaces) }

    func reload() async {
        let api = self.api
        async let list = api.workspaces()
        async let records = api.launchHistory(limit: 100)
        do {
            workspaces = Self.sorted(try await list)
            error = nil
        } catch {
            if workspaces.isEmpty { self.error = error.localizedDescription }
        }
        history = (try? await records) ?? history
        loaded = true
    }

    /// 某项目最近可恢复的启动记录（最多 5 条）。
    func resumable(for project: WorkspaceProject) -> [LaunchRecord] {
        let key = normalizeProjectPath(project.path)
        return Array(history.filter { $0.canResume && normalizeProjectPath($0.projectPath ?? "") == key }.prefix(5))
    }

    /// 最近启动过的项目（按启动时间倒序、同项目去重），仅限仍在工作空间里的项目。
    func recentProjects(limit: Int = 8) -> [RecentProject] {
        var index: [String: (Workspace, WorkspaceProject)] = [:]
        for ws in workspaces {
            for project in ws.projects { index[normalizeProjectPath(project.path)] = index[normalizeProjectPath(project.path)] ?? (ws, project) }
        }
        var seen = Set<String>()
        var result: [RecentProject] = []
        for record in history {
            let key = normalizeProjectPath(record.projectPath ?? "")
            guard let (ws, project) = index[key], seen.insert(key).inserted else { continue }
            result.append(RecentProject(workspace: ws, project: project, record: record))
            if result.count >= limit { break }
        }
        return result
    }

    /// 置顶在前，其余按显示名；已归档的不展示（Flutter 版未过滤归档）。
    nonisolated static func sorted(_ list: [Workspace]) -> [Workspace] {
        list.filter { $0.archivedAt == nil }.sorted { a, b in
            if a.isPinned != b.isPinned { return a.isPinned }
            return a.displayName.localizedStandardCompare(b.displayName) == .orderedAscending
        }
    }
}

struct WorkspaceMetrics: Equatable, Sendable {
    var workspaces: Int
    var projects: Int
    var pinned: Int
    var hidden: Int

    init(workspaces: Int, projects: Int, pinned: Int, hidden: Int) {
        self.workspaces = workspaces
        self.projects = projects
        self.pinned = pinned
        self.hidden = hidden
    }

    init(_ list: [Workspace]) {
        workspaces = list.count
        projects = list.reduce(0) { $0 + $1.projects.count }
        pinned = list.filter(\.isPinned).count
        hidden = list.filter(\.isHidden).count
    }
}

struct RecentProject: Identifiable {
    let workspace: Workspace
    let project: WorkspaceProject
    let record: LaunchRecord
    var id: String { workspace.id + "/" + project.id }
    var launchedAt: Date? { record.launchedAt.flatMap(parseLooseISO8601) }
}

/// 兼容微秒精度 / 带时区偏移的 ISO8601（launch-history 的 `2026-11-27T09:59:00.649625+00:00`）。
func parseLooseISO8601(_ text: String) -> Date? {
    if let date = parseISO8601(text) { return date }
    // 小数秒截到 3 位再试
    guard let dot = text.firstIndex(of: ".") else { return nil }
    let tail = text[text.index(after: dot)...]
    let digits = tail.prefix(while: \.isNumber)
    let rest = tail.dropFirst(digits.count)
    return parseISO8601(String(text[..<dot]) + "." + String(digits.prefix(3)) + rest)
}

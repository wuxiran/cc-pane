import SwiftUI

/// 「工作区」tab：指标条 + 工作空间卡（名/路径/pills/⋯）+ 项目行（点按 → 选 Claude/Codex/终端启动）。
struct WorkspaceTabView: View {
    let api: APIClient
    let model: WorkspacesModel
    let mirror: MirrorModel
    let onRefresh: () async -> Void
    @Environment(AppModel.self) private var app
    @State private var path: [TerminalRoute] = []
    @State private var launching: LaunchTarget?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    MetricsRow(metrics: model.metrics)
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                        .listRowBackground(Color.clear)
                } footer: {
                    if let error = model.error {
                        Text(error).foregroundStyle(.red)
                    } else if !app.canWrite {
                        Text("只读模式：电脑端未允许远程写入，无法新建会话")
                    }
                }
                ForEach(model.workspaces) { workspace in
                    WorkspaceSection(workspace: workspace, mirror: mirror.state) { project in
                        launching = LaunchTarget(workspace: workspace, project: project)
                    }
                }
            }
            .readableContentWidth()
            .overlay { emptyState }
            .refreshable { await onRefresh() }
            .navigationTitle("工作区")
            .navigationDestination(for: TerminalRoute.self) { route in
                TerminalScreen(sessionId: route.sessionId, title: route.title, api: api, canWrite: app.canWrite)
            }
            .sheet(item: $launching) { target in
                LaunchSheet(target: target, records: model.resumable(for: target.project),
                            canWrite: app.canWrite) { tool, resumeId in
                    let id = try await mirror.launch(project: target.project, workspaceName: target.workspace.name,
                                                     tool: tool, resumeId: resumeId)
                    launching = nil
                    path.append(TerminalRoute(sessionId: id, title: target.project.displayName))
                }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if !model.loaded {
            ProgressView()
        } else if model.workspaces.isEmpty, model.error == nil {
            ContentUnavailableView("桌面端还没有工作空间", systemImage: "folder")
        }
    }
}

struct LaunchTarget: Identifiable {
    let workspace: Workspace
    let project: WorkspaceProject
    var id: String { workspace.id + "/" + project.id }
}

/// 四格指标：工作区 / 项目 / 置顶 / 隐藏。
private struct MetricsRow: View {
    let metrics: WorkspaceMetrics

    var body: some View {
        HStack(spacing: 8) {
            cell(metrics.workspaces, "工作区", .accentColor)
            cell(metrics.projects, "项目", .accentColor)
            cell(metrics.pinned, "置顶", .accentColor)
            cell(metrics.hidden, "隐藏", .purple)
        }
    }

    private func cell(_ value: Int, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)").font(.title3.weight(.bold)).foregroundStyle(color).monospacedDigit()
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }
}

/// 一个工作空间 = 一个 Section：首行是工作空间卡头，其下是项目行。
private struct WorkspaceSection: View {
    let workspace: Workspace
    let mirror: MirrorState
    let onLaunch: (WorkspaceProject) -> Void

    var body: some View {
        Section {
            header
            if workspace.projects.isEmpty {
                Text("无项目").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(workspace.projects) { project in
                let key = normalizeProjectPath(project.path)
                Button { onLaunch(project) } label: {
                    ProjectRow(project: project,
                               desktopCount: mirror.desktopProjectCounts[key] ?? 0,
                               mobileCount: mirror.mobileProjectCounts[key] ?? 0)
                }
                .tint(.primary)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "folder")
                .font(.system(size: 17))
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .background(.background.tertiary, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                Text(workspace.displayName).font(.headline).lineLimit(1)
                if let path = workspace.path, !path.isEmpty {
                    Text(path).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                HStack(spacing: 6) {
                    if workspace.isPinned { StatusPill(systemImage: "pin.fill", text: "已置顶") }
                    if workspace.isHidden { StatusPill(systemImage: "eye.slash", text: "已隐藏") }
                    StatusPill(text: "\(workspace.projects.count) 个项目")
                }
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
            actionsMenu
        }
        .padding(.vertical, 2)
    }

    private var actionsMenu: some View {
        Menu {
            if let first = workspace.projects.first {
                Button("打开终端（\(first.displayName)）", systemImage: "terminal") { onLaunch(first) }
            }
            Section("置顶 / 别名 / 重命名 / 删除请在桌面端操作") {}
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 20))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
        }
    }
}

/// 项目行：名称 + 路径，右侧「电脑在跑 N / 手机打开 N」徽标。
private struct ProjectRow: View {
    let project: WorkspaceProject
    let desktopCount: Int
    let mobileCount: Int

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "terminal")
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(project.displayName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(project.path).font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 4)
            if desktopCount > 0 {
                StatusPill(systemImage: "desktopcomputer", text: badge("电脑在跑", desktopCount), color: .blue)
            }
            if mobileCount > 0 {
                StatusPill(systemImage: "iphone", text: badge("手机", mobileCount), color: .purple)
            }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
    }

    private func badge(_ label: String, _ count: Int) -> String {
        count > 1 ? "\(label) \(count)" : label
    }
}

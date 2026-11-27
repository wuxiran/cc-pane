import SwiftUI

/// 新建对话：选引擎（/api/acp/engines）+ 选项目（工作空间树）。
struct NewChatSheet: View {
    let model: ChatListModel
    let workspaces: WorkspacesModel
    let onCreated: (ChatRoute) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var engineId: String?
    @State private var projectPath: String?
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("引擎") {
                    if model.engines.isEmpty { Text("加载中…").foregroundStyle(.secondary) }
                    ForEach(sortedEngines) { engine in engineRow(engine) }
                }
                Section("项目") {
                    if workspaces.workspaces.isEmpty { Text("没有可用项目").foregroundStyle(.secondary) }
                    ForEach(workspaces.workspaces) { ws in
                        if !ws.projects.isEmpty {
                            DisclosureGroup(ws.displayName) {
                                ForEach(ws.projects) { project in projectRow(project) }
                            }
                        }
                    }
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            .navigationTitle("新建对话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if creating { ProgressView() } else {
                        Button("开始") { Task { await create() } }.disabled(engineId == nil || projectPath == nil)
                    }
                }
            }
            .task {
                if model.engines.isEmpty { await model.reload() }
                if engineId == nil { engineId = sortedEngines.first(where: \.available)?.id }
                if workspaces.workspaces.isEmpty { await workspaces.reload() }
            }
        }
    }

    /// 已安装优先（与桌面 EnginePicker 同口径）。
    private var sortedEngines: [AcpEngineInfo] {
        model.engines.filter(\.available) + model.engines.filter { !$0.available }
    }

    private func engineRow(_ engine: AcpEngineInfo) -> some View {
        Button {
            engineId = engine.id
        } label: {
            HStack(spacing: 10) {
                EngineIcon(engineId: engine.id)
                VStack(alignment: .leading, spacing: 2) {
                    Text(engine.label).foregroundStyle(.primary)
                    if !engine.available {
                        Text(engine.requirement).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer()
                if engineId == engine.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
        .disabled(!engine.available)
    }

    private func projectRow(_ project: WorkspaceProject) -> some View {
        Button {
            projectPath = project.path
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.displayName).foregroundStyle(.primary)
                    Text(project.path).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.head)
                }
                Spacer()
                if projectPath == project.path { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
    }

    private func create() async {
        guard let engineId, let projectPath else { return }
        creating = true
        defer { creating = false }
        do {
            onCreated(try await model.create(engineId: engineId, cwd: projectPath))
        } catch {
            self.error = error.localizedDescription
        }
    }
}

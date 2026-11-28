import SwiftUI

/// 新建对话：选电脑（含伪电脑「本机 iPhone」；默认上次用的）+ 选引擎（/api/acp/engines）+ 选项目（该电脑的工作空间树）。
/// 选「本机 iPhone」时改为选本机供应商 + 模型，对话在手机上直连 LLM API（docs/112 §6）。
struct NewChatSheet: View {
    let hub: ConnectionHub
    let onCreated: (ChatRoute) -> Void
    @Environment(\.dismiss) private var dismiss
    @AppStorage("ccpanes.lastChatComputer") private var lastComputer = ""
    @State private var computerId = ""
    @State private var engineId: String?
    @State private var projectPath: String?
    @State private var creating = false
    @State private var error: String?
    @AppStorage("ccpanes.lastLocalProvider") private var lastLocalProvider = ""
    @State private var localProviderId = ""
    @State private var localModelId = ""
    @State private var managingLocal = false
    private let local = LocalEnvironment.shared
    private var isLocal: Bool { computerId == LocalChatListItem.computerId }

    var body: some View {
        NavigationStack {
            Form {
                Section("在哪里运行") {
                    Picker("在哪台电脑上", selection: $computerId) {
                        ForEach(candidates) { link in Text(hub.name(link.id)).tag(link.id) }
                        Label(LocalChatListItem.computerName, systemImage: "iphone").tag(LocalChatListItem.computerId)
                    }
                }
                if isLocal {
                    LocalNewChatSection(env: local, providerId: $localProviderId, modelId: $localModelId) {
                        managingLocal = true
                    }
                } else {
                    remoteSections
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            .navigationTitle("新建对话")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(isPresented: $managingLocal) {
                LocalProvidersView(targets: hub.importTargets, env: local)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if creating { ProgressView() } else {
                        Button("开始") { Task { await create() } }.disabled(!canStart)
                    }
                }
            }
            .task(id: computerId) {
                if computerId.isEmpty {
                    computerId = candidates.first { $0.id == lastComputer }?.id
                        ?? (lastComputer == LocalChatListItem.computerId || candidates.isEmpty
                            ? LocalChatListItem.computerId : candidates.first?.id) ?? LocalChatListItem.computerId
                    return
                }
                if isLocal {
                    selectDefaultLocal()
                    return
                }
                engineId = nil
                projectPath = nil
                if let model, model.engines.isEmpty { await model.reload() }
                if engineId == nil { engineId = sortedEngines.first(where: \.available)?.id }
                if let workspaces, workspaces.workspaces.isEmpty { await workspaces.reload() }
            }
            .onChange(of: managingLocal) { _, open in if !open { selectDefaultLocal() } }
        }
    }

    private var canStart: Bool {
        isLocal ? (!localProviderId.isEmpty && !localModelId.trimmingCharacters(in: .whitespaces).isEmpty)
                : (engineId != nil && projectPath != nil)
    }

    private func selectDefaultLocal() {
        guard local.providers.provider(localProviderId) == nil || !local.providers.hasKey(localProviderId) else { return }
        if let pick = local.defaultSelection(last: lastLocalProvider) {
            localProviderId = pick.provider.id
            localModelId = pick.model
        }
    }

    @ViewBuilder private var remoteSections: some View {
                Section("引擎") {
                    if model?.engines.isEmpty ?? true { Text("加载中…").foregroundStyle(.secondary) }
                    ForEach(sortedEngines) { engine in engineRow(engine) }
                }
                Section("项目") {
                    if workspaces?.workspaces.isEmpty ?? true { Text("没有可用项目").foregroundStyle(.secondary) }
                    ForEach(workspaces?.workspaces ?? []) { ws in
                        if !ws.projects.isEmpty {
                            DisclosureGroup(ws.displayName) {
                                ForEach(ws.projects) { project in projectRow(project) }
                            }
                        }
                    }
                }
    }

    /// 能新建对话的电脑：在线、支持对话、可写。
    private var candidates: [ComputerLink] {
        hub.links.filter { $0.status.isOnline && !$0.chatsUnsupported && !$0.hostDown && $0.canWrite }
    }

    private var link: ComputerLink? { hub.link(computerId) }
    private var model: ChatListModel? { link?.chats }
    private var workspaces: WorkspacesModel? { link?.workspaces }

    /// 已安装优先（与桌面 EnginePicker 同口径）。
    private var sortedEngines: [AcpEngineInfo] {
        let engines = model?.engines ?? []
        return engines.filter(\.available) + engines.filter { !$0.available }
    }

    private func engineRow(_ engine: AcpEngineInfo) -> some View {
        Button {
            engineId = engine.id
        } label: {
            HStack(spacing: 10) {
                EngineIcon(engineId: engine.id, size: 34)
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
        if isLocal {
            let chat = local.chats.create(providerId: localProviderId,
                                          modelId: localModelId.trimmingCharacters(in: .whitespaces))
            lastComputer = LocalChatListItem.computerId
            lastLocalProvider = localProviderId
            onCreated(LocalEnvironment.route(chat))
            return
        }
        guard let engineId, let projectPath, let model else { return }
        creating = true
        defer { creating = false }
        do {
            let route = try await model.create(engineId: engineId, cwd: projectPath)
            lastComputer = computerId
            onCreated(route)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

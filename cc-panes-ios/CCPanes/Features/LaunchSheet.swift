import SwiftUI

/// 项目启动 sheet：项目头 + 三个启动磁贴（Claude / Codex / 终端）+ 该项目正在运行的会话 + 最近可恢复的启动。
struct LaunchSheet: View {
    let target: LaunchTarget
    let records: [LaunchRecord]
    var running: [MirrorCard] = []
    var previews: [String: String] = [:]
    let canWrite: Bool
    var onOpen: (MirrorCard) -> Void = { _ in }
    /// 启动并跳转；抛错时 sheet 内显示错误。
    let onLaunch: (CliTool, String?) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    header.listRowBackground(Color.clear).listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 8, trailing: 4))
                    tiles.listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets())
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                    else if !canWrite { Text("只读模式：电脑端未允许远程写入") }
                }
                if !running.isEmpty {
                    Section {
                        ForEach(running) { card in runningRow(card) }
                    } header: {
                        SectionLabel(title: "正在运行", systemImage: "bolt.horizontal", trailing: "\(running.count)")
                    }
                }
                if !records.isEmpty {
                    Section {
                        ForEach(Array(records.enumerated()), id: \.offset) { _, record in recordRow(record) }
                    } header: {
                        SectionLabel(title: "最近启动 · 点按恢复", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
            .listSectionSpacing(16)
            .navigationTitle("新建会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                if busy != nil { ToolbarItem(placement: .confirmationAction) { ProgressView() } }
            }
            .disabled(busy != nil)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var header: some View {
        HStack(spacing: 12) {
            ProjectMonogram(name: target.project.displayName, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(target.project.displayName).font(.title3.weight(.bold)).lineLimit(1)
                Text("\(target.workspace.displayName) · \(abbreviatePath(target.project.path))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
        }
    }

    private var tiles: some View {
        HStack(spacing: 10) {
            ForEach(CliTool.allCases) { tool in
                Button {
                    run(tool, resumeId: nil)
                } label: {
                    VStack(spacing: 8) {
                        if busy == tool.rawValue {
                            ProgressView().frame(width: 40, height: 40)
                        } else {
                            CLIGlyph(tool: tool == .none ? nil : tool.rawValue, size: 40)
                        }
                        Text(tool == .claude ? "Claude" : tool.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(DK.card, in: RoundedRectangle(cornerRadius: DK.cardRadius, style: .continuous))
                }
                .buttonStyle(PressableCardStyle())
                .disabled(!canWrite)
                .opacity(canWrite ? 1 : 0.5)
            }
        }
    }

    private func runningRow(_ card: MirrorCard) -> some View {
        Button { onOpen(card) } label: {
            HStack(spacing: 12) {
                CLIGlyph(tool: card.cliTool, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.displayTitle).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let preview = previews[card.sessionId] {
                        Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                PhaseCapsule(phase: card.phase)
            }
        }
        .tint(.primary)
    }

    private func recordRow(_ record: LaunchRecord) -> some View {
        let tool = CliTool(rawValue: record.cliTool ?? "") ?? .claude
        return Button {
            run(tool, resumeId: record.resumeSessionId)
        } label: {
            HStack(spacing: 12) {
                CLIGlyph(tool: tool.rawValue, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(recordTitle(record)).font(.subheadline).lineLimit(2).foregroundStyle(.primary)
                    Text(recordMeta(record)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                Image(systemName: "arrow.uturn.forward.circle").foregroundStyle(Color.accentColor)
            }
        }
        .disabled(!canWrite)
    }

    private func recordTitle(_ record: LaunchRecord) -> String {
        if let prompt = nonEmpty(record.lastPrompt) { return prompt }
        return "会话 \(record.resumeSessionId?.prefix(8) ?? "")…"
    }

    private func recordMeta(_ record: LaunchRecord) -> String {
        let tool = cliDisplayName(record.cliTool ?? "claude")
        let ago = record.launchedAt.flatMap(parseLooseISO8601).flatMap { shortRelative($0) }
        return [tool, ago].compactMap { $0 }.joined(separator: " · ")
    }

    private func run(_ tool: CliTool, resumeId: String?) {
        busy = resumeId ?? tool.rawValue
        error = nil
        Task {
            do {
                try await onLaunch(tool, resumeId)
            } catch APIError.forbidden {
                self.error = "远程只读模式已拦截。可在桌面端开启「允许已登录的远程会话写入」。"
            } catch {
                self.error = error.localizedDescription
            }
            busy = nil
        }
    }
}

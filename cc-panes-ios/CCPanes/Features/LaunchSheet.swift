import SwiftUI

/// 项目启动 sheet：Claude / Codex / 纯终端 + 该项目最近可恢复的启动记录。
struct LaunchSheet: View {
    let target: LaunchTarget
    let records: [LaunchRecord]
    let canWrite: Bool
    /// 启动并跳转；抛错时 sheet 内显示错误。
    let onLaunch: (CliTool, String?) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    buttons
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(target.project.displayName).font(.title3.weight(.semibold)).foregroundStyle(.primary)
                        Text(target.project.path).font(.caption).lineLimit(1).truncationMode(.middle)
                    }
                    .textCase(nil)
                    .padding(.bottom, 6)
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                    else if !canWrite { Text("只读模式：电脑端未允许远程写入") }
                }
                if !records.isEmpty {
                    Section("最近启动（点按恢复会话）") {
                        ForEach(Array(records.enumerated()), id: \.offset) { _, record in recordRow(record) }
                    }
                }
            }
            .navigationTitle("新建会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                if busy { ToolbarItem(placement: .confirmationAction) { ProgressView() } }
            }
            .disabled(busy || !canWrite)
        }
        .presentationDetents([.medium, .large])
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            launchButton(.claude, title: "Claude").buttonStyle(.borderedProminent)
            launchButton(.codex, title: "Codex").buttonStyle(.bordered)
            launchButton(.none, title: "终端").buttonStyle(.bordered)
        }
        .controlSize(.large)
    }

    private func launchButton(_ tool: CliTool, title: String) -> some View {
        Button {
            run(tool, resumeId: nil)
        } label: {
            Label(title, systemImage: tool.systemImage)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
        }
    }

    private func recordRow(_ record: LaunchRecord) -> some View {
        let tool = CliTool(rawValue: record.cliTool ?? "") ?? .claude
        return Button {
            run(tool, resumeId: record.resumeSessionId)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: tool.systemImage).foregroundStyle(.secondary).frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(recordTitle(record)).lineLimit(1).foregroundStyle(.primary)
                    Text(record.launchedAt?.split(separator: "T").first.map(String.init) ?? "")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func recordTitle(_ record: LaunchRecord) -> String {
        if let prompt = nonEmpty(record.lastPrompt) { return prompt }
        return "会话 \(record.resumeSessionId?.prefix(8) ?? "")…"
    }

    private func run(_ tool: CliTool, resumeId: String?) {
        busy = true
        error = nil
        Task {
            do {
                try await onLaunch(tool, resumeId)
            } catch APIError.forbidden {
                self.error = "远程只读模式已拦截。可在桌面端开启「允许已登录的远程会话写入」。"
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

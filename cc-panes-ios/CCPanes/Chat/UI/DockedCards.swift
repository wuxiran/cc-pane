import SwiftUI

/// 停靠在输入框上方的审批卡：选项全部来自服务端 payload（optionId/name/kind）。
struct PermissionCard: View {
    let request: PendingPermission
    let queued: Int
    let readOnly: Bool
    let onRespond: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text("需要你的授权").font(.subheadline.weight(.semibold))
                if let kind = request.toolKind { TagBadge(text: AcpToolCall.kindLabel(kind)) }
                Spacer()
                if queued > 0 { Text("还有 \(queued) 项").font(.caption2).foregroundStyle(.secondary) }
            }
            Text(request.title).font(.subheadline)
            if let detail = request.detail {
                Text(detail)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .truncationMode(.middle)
            }
            if let error = request.error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            options
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.orange.opacity(0.4)))
    }

    @ViewBuilder private var options: some View {
        if readOnly {
            Text("远程只读模式，请在电脑端处理").font(.caption).foregroundStyle(.secondary)
        } else if request.options.isEmpty {
            Button("取消请求", role: .cancel) { onRespond(nil) }
        } else {
            // 选项多于 3 个时纵向排列，避免挤压
            let layout = request.options.count > 3 ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
            layout {
                ForEach(request.options) { option in
                    Button {
                        onRespond(option.optionId)
                    } label: {
                        Text(option.name).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(option.isAllow ? (option.kind == "allow_once" ? .accentColor : .green) : .red)
                    .disabled(request.responding)
                }
            }
            .overlay { if request.responding { ProgressView() } }
        }
    }
}

/// 停靠的提问卡（elicitation 表单）。看不懂的 schema 只给「跳过 / 取消」。
struct QuestionCardView: View {
    let request: PendingQuestion
    let readOnly: Bool
    let onRespond: (JSONValue) -> Void
    @State private var draft: [String: JSONValue] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("agent 提问", systemImage: "questionmark.bubble.fill").font(.subheadline.weight(.semibold))
                Spacer()
                Button { onRespond(.from(["action": "cancel"])) } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .disabled(request.responding || readOnly)
            }
            if !request.message.isEmpty { Text(request.message).font(.subheadline) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(request.form.fields) { field in QuestionFieldView(field: field, value: binding(field.id)) }
                }
            }
            .frame(maxHeight: 260)
            .fixedSize(horizontal: false, vertical: true)
            if request.form.unsupported {
                Text("部分问题手机端暂不支持，请到电脑端回答或跳过").font(.caption).foregroundStyle(.orange)
            }
            if let error = request.error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("跳过") { onRespond(.from(["action": "decline"])) }.buttonStyle(.bordered)
                Button("发送") {
                    if let content = request.form.content(from: draft) {
                        onRespond(.object(["action": .string("accept"), "content": .object(content)]))
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(request.form.unsupported || request.form.content(from: draft) == nil)
            }
            .disabled(request.responding || readOnly)
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private func binding(_ id: String) -> Binding<JSONValue?> {
        Binding(get: { draft[id] }, set: { draft[id] = $0 })
    }
}

struct QuestionFieldView: View {
    let field: QuestionForm.Field
    @Binding var value: JSONValue?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(field.title + (field.required ? "" : "（可选）")).font(.footnote.weight(.medium))
            if let description = field.description { Text(description).font(.caption).foregroundStyle(.secondary) }
            control
        }
    }

    @ViewBuilder private var control: some View {
        if !field.choices.isEmpty {
            ForEach(field.choices, id: \.value) { choice in
                Button { toggle(choice.value) } label: {
                    HStack {
                        Image(systemName: isSelected(choice.value) ? "checkmark.circle.fill" : "circle")
                        Text(choice.title)
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
            }
        } else if field.type == .boolean {
            Toggle(field.title, isOn: Binding(get: { value?.bool ?? false }, set: { value = .bool($0) }))
                .labelsHidden()
        } else {
            TextField("输入回答", text: Binding(get: { value?.string ?? "" }, set: { value = .string($0) }))
                .textFieldStyle(.roundedBorder)
                .keyboardType(field.type == .string ? .default : .decimalPad)
        }
    }

    private func isSelected(_ choice: String) -> Bool {
        if let list = value?.array { return list.contains(.string(choice)) }
        return value?.string == choice
    }

    private func toggle(_ choice: String) {
        guard field.type == .array else { value = .string(choice); return }
        var list = value?.array ?? []
        if let i = list.firstIndex(of: .string(choice)) { list.remove(at: i) } else { list.append(.string(choice)) }
        value = .array(list)
    }
}

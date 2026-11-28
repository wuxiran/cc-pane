import SwiftUI

/// 停靠在输入框上方的审批卡：选项全部来自服务端 payload（optionId/name/kind）。
struct PermissionCard: View {
    let request: PendingPermission
    let queued: Int
    let readOnly: Bool
    let onRespond: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(.orange, in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text("需要你的授权").font(.subheadline.weight(.bold))
                    Text([request.toolKind.map(AcpToolCall.kindLabel), queued > 0 ? "还有 \(queued) 项排队" : nil]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(request.title).font(.callout.weight(.medium))
                if let detail = request.detail {
                    Text(detail)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(DK.inset, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
            if let error = request.error {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red)
            }
            options
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(.orange.opacity(0.55), lineWidth: 1.5))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    @ViewBuilder private var options: some View {
        if readOnly {
            Label("远程只读模式，请在电脑端处理", systemImage: "lock").font(.caption).foregroundStyle(.secondary)
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
                        Text(option.name)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .frame(maxWidth: .infinity, minHeight: 40)
                            .foregroundStyle(style(option).fg)
                            .background(style(option).bg, in: Capsule())
                    }
                    .buttonStyle(PressableCardStyle())
                    .disabled(request.responding)
                }
            }
            .opacity(request.responding ? 0.5 : 1)
            .overlay { if request.responding { ProgressView() } }
        }
    }

    /// 单次允许 = 实心强调色（主操作）；始终允许 = 绿色浅底；拒绝 = 红色浅底。
    private func style(_ option: PermissionOption) -> (fg: Color, bg: Color) {
        if !option.isAllow { return (.red, Color.red.opacity(0.14)) }
        if option.kind == "allow_once" { return (.white, Color.accentColor) }
        return (.green, Color.green.opacity(0.16))
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
                Label("agent 提问", systemImage: "questionmark.bubble.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.accentColor)
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
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.accentColor.opacity(0.4), lineWidth: 1.5))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
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

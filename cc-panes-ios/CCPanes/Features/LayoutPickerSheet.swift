import SwiftUI

/// 选择器的两种视角（记住上次选择；`-layoutPickerMode layouts|computers` 可覆盖）。
enum LayoutPickerMode: String, CaseIterable, Identifiable {
    case layouts, computers
    static let storageKey = "layoutPickerMode"
    var id: Self { self }
    var title: String { self == .layouts ? "按布局" : "按电脑" }
}

/// 「终端」tab 的布局 / 电脑选择器（标题点按弹出）：按布局 = 两列卡片网格（多电脑分节）；
/// 按电脑 = 电脑列表，点行选「这台电脑的全部布局」，展开可直接选它的某个布局。顶部搜索按名称过滤。
struct LayoutPickerSheet: View {
    let computers: [MirrorComputer]
    let resolved: ResolvedMirrorScope
    let current: MirrorScope
    /// 电脑状态（状态点）；nil = 按 isOnline 推断。
    let status: (String) -> ComputerLink.Status?
    let onSelect: (MirrorScope) -> Void

    @AppStorage(LayoutPickerMode.storageKey) private var modeRaw = LayoutPickerMode.layouts.rawValue
    // 调试：`-layoutPickerQuery <文本>` 预填搜索、`-layoutPickerDetent large` 直接展开（截图用）
    @State private var query = UserDefaults.standard.string(forKey: "layoutPickerQuery") ?? ""
    @State private var detent: PresentationDetent =
        UserDefaults.standard.string(forKey: "layoutPickerDetent") == "large" ? .large : .medium
    @State private var expanded: Set<String> = []
    @Environment(\.dismiss) private var dismiss

    private var mode: LayoutPickerMode { LayoutPickerMode(rawValue: modeRaw) ?? .layouts }
    private var multi: Bool { computers.count > 1 }
    private var filtered: [MirrorComputer] { filterMirrorComputers(computers, query: query) }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch mode {
                    case .layouts: layoutsContent
                    case .computers: computersContent
                    }
                }
                .padding(.horizontal, DK.gutter)
                .padding(.bottom, 24)
                .padding(.top, 6)
                .animation(.snappy, value: query)
            }
            .background(DK.canvas)
            .overlay { if filtered.isEmpty && searching { ContentUnavailableView.search(text: query) } }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索布局或电脑")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("视角", selection: $modeRaw) {
                        ForEach(LayoutPickerMode.allCases) { Text($0.title).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .onAppear {
            if let id = resolved.layout?.computerId ?? resolved.computerId { expanded.insert(id) }
        }
    }

    private func choose(_ scope: MirrorScope) {
        onSelect(scope)
        dismiss()
    }

    // MARK: - 按布局

    @ViewBuilder private var layoutsContent: some View {
        if !searching { everythingCard }
        let sections = filtered.filter { !$0.groups.isEmpty }
        ForEach(sections) { computer in
            VStack(alignment: .leading, spacing: 8) {
                if multi {
                    SectionLabel(title: computer.name, systemImage: "desktopcomputer",
                                 trailing: "\(computer.groups.count) 个布局")
                        .padding(.horizontal, 4)
                }
                layoutGrid(computer.groups) { current.selectingLayout($0) }
            }
        }
    }

    /// 首项「全部会话」：全部电脑、全部布局。
    private var everythingCard: some View {
        let selected = resolved.isAll && resolved.computerId == nil
        let sessions = computers.reduce(0) { $0 + $1.sessionCount }
        let waiting = computers.reduce(0) { $0 + $1.waitingCount }
        let layouts = computers.reduce(0) { $0 + $1.groups.count }
        return Button { choose(.everything) } label: {
            HStack(spacing: 12) {
                Image(systemName: "square.grid.2x2.fill")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 40, height: 40)
                    .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("全部会话").font(.subheadline.weight(.semibold))
                    Text(multi ? "\(computers.count) 台电脑 · \(layouts) 个布局 · \(sessions) 会话"
                               : "\(layouts) 个布局 · \(sessions) 会话")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if waiting > 0 { WaitingBadge(count: waiting) }
                checkmark(selected)
            }
            .cardSurface(stroke: selected ? .accentColor : nil, padding: 12)
        }
        .buttonStyle(PressableCardStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func layoutGrid(_ groups: [MirrorGroup], scope: @escaping (MirrorGroup) -> MirrorScope) -> some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(groups) { group in
                Button { choose(scope(group)) } label: {
                    // 电脑名已由分节标题 / 电脑行表达，卡上只标「桌面当前」
                    LayoutGridCard(group: group, selected: resolved.layout?.id == group.id)
                }
                .buttonStyle(PressableCardStyle())
            }
        }
    }

    // MARK: - 按电脑

    @ViewBuilder private var computersContent: some View {
        if !searching {
            computerRow(id: nil, name: "全部电脑", status: nil,
                        detail: "\(computers.reduce(0) { $0 + $1.groups.count }) 个布局 · "
                            + "\(computers.reduce(0) { $0 + $1.sessionCount }) 会话",
                        waiting: computers.reduce(0) { $0 + $1.waitingCount }, expandable: false)
        }
        ForEach(filtered) { computer in
            VStack(alignment: .leading, spacing: 10) {
                computerRow(id: computer.id, name: computer.name,
                            status: status(computer.id) ?? (computer.isOnline ? .online : .offline),
                            detail: detail(computer), waiting: computer.waitingCount,
                            expandable: !computer.groups.isEmpty)
                if isExpanded(computer.id), !computer.groups.isEmpty {
                    layoutGrid(computer.groups) { MirrorScope.layout($0, onComputer: true) }
                        .padding(.leading, 12)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private func isExpanded(_ id: String) -> Bool { searching || expanded.contains(id) }

    private func detail(_ computer: MirrorComputer) -> String {
        var parts: [String] = []
        if let route = computer.route { parts.append(route) }
        if !computer.isOnline {
            parts.append(status(computer.id)?.label ?? "离线")
        } else {
            parts.append("\(computer.groups.count) 个布局")
            parts.append("\(computer.sessionCount) 会话")
        }
        return parts.joined(separator: " · ")
    }

    private func computerRow(id: String?, name: String, status: ComputerLink.Status?, detail: String,
                             waiting: Int, expandable: Bool) -> some View {
        let selected = resolved.isAll && resolved.computerId == id
        return HStack(spacing: 12) {
            Button { choose(id.map(MirrorScope.computer) ?? .everything) } label: {
                HStack(spacing: 12) {
                    Image(systemName: id == nil ? "rectangle.3.group" : "desktopcomputer")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 36)
                        .background(DK.inset, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .overlay(alignment: .bottomTrailing) {
                            if id != nil {
                                LinkStatusDot(status: status)
                                    .overlay(Circle().strokeBorder(DK.card, lineWidth: 2))
                                    .offset(x: 3, y: 3)
                            }
                        }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if waiting > 0 { WaitingBadge(count: waiting) }
                    checkmark(selected)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
            if expandable, let id, !searching {
                Button {
                    withAnimation(.snappy) {
                        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
                    }
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.semibold))
                        .rotationEffect(.degrees(expanded.contains(id) ? 0 : -90))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .background(DK.inset, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded.contains(id) ? "收起 \(name) 的布局" : "展开 \(name) 的布局")
            }
        }
        .cardSurface(stroke: selected ? .accentColor : nil, padding: 12)
    }

    @ViewBuilder private func checkmark(_ selected: Bool) -> some View {
        if selected {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
        }
    }
}

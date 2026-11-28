import SwiftUI

/// 分屏几何缩略图：按 LayoutShape 递归切分，每个 pane 按其最紧急相位着色；可选显示序号、点按回调。
struct LayoutThumbnail: View {
    let shape: LayoutShape
    let phaseOf: (Int) -> SessionPhase?
    var spacing: CGFloat = 2
    var radius: CGFloat = 3
    var showsOrdinals = false
    /// 紧凑序号（小号数字、不带相位点；等待输入的格子加粗橙框）——布局条用。
    var compactOrdinals = false
    var highlighted: Int?
    var onTapPane: ((Int) -> Void)?

    var body: some View {
        GeometryReader { proxy in
            node(shape, size: proxy.size)
        }
    }

    private func node(_ shape: LayoutShape, size: CGSize) -> AnyView {
        switch shape {
        case .pane(let ordinal):
            return AnyView(cell(ordinal).frame(width: max(0, size.width), height: max(0, size.height)))
        case .split(let horizontal, let children, let weights):
            let total = weights.reduce(0, +)
            let gaps = spacing * CGFloat(children.count - 1)
            let room = (horizontal ? size.width : size.height) - gaps
            let sizes = weights.map { CGFloat($0 / max(total, 0.0001)) * max(0, room) }
            let layout = horizontal ? AnyLayout(HStackLayout(spacing: spacing)) : AnyLayout(VStackLayout(spacing: spacing))
            return AnyView(layout {
                ForEach(Array(children.enumerated()), id: \.offset) { index, child in
                    let length = sizes[index]
                    node(child, size: horizontal ? CGSize(width: length, height: size.height)
                                                 : CGSize(width: size.width, height: length))
                }
            })
        }
    }

    @ViewBuilder private func cell(_ ordinal: Int) -> some View {
        let phase = phaseOf(ordinal)
        let fill = phase?.color ?? Color.secondary
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        shape
            .fill(fill.opacity(phase == nil ? 0.12 : 0.28))
            .overlay {
                shape.strokeBorder(highlighted == ordinal ? Color.accentColor : fill.opacity(phase == nil ? 0.25 : 0.7),
                                   lineWidth: highlighted == ordinal || (compactOrdinals && phase == .waiting) ? 2 : 1)
            }
            .overlay {
                if compactOrdinals {
                    Text("\(ordinal)")
                        .font(.system(size: 9, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(phase == nil ? Color.secondary : Color.primary)
                        .minimumScaleFactor(0.6)
                } else if showsOrdinals {
                    VStack(spacing: 3) {
                        Text("\(ordinal)").font(.caption.weight(.bold)).monospacedDigit()
                        if let phase { PhaseDot(phase: phase, size: 6) }
                    }
                    .foregroundStyle(phase == nil ? Color.secondary : Color.primary)
                }
            }
            .contentShape(shape)
            .onTapGesture { onTapPane?(ordinal) }
            .accessibilityElement()
            .accessibilityLabel("窗格 \(ordinal)，\(phase?.label ?? "无终端")")
            .accessibilityAddTraits(onTapPane == nil ? [] : .isButton)
    }
}

/// 布局缩略图（无几何的组 = 图标占位：手机远程会话 / 未归入布局）。
struct LayoutPreview: View {
    let group: MirrorGroup

    var body: some View {
        if let shape = group.shape {
            LayoutThumbnail(shape: shape, phaseOf: group.phase(ofPane:))
        } else {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(Color.secondary.opacity(0.12))
                .overlay {
                    Image(systemName: group.kind == .mobileRemote ? "iphone" : "questionmark.square.dashed")
                        .foregroundStyle(.secondary)
                }
        }
    }
}

/// 相位计数：彩点 + 数字（等待 / 运行 / 空闲 / 结束，0 不显示）。
struct PhaseCountsRow: View {
    let counts: PhaseCounts

    var body: some View {
        HStack(spacing: 8) {
            ForEach([SessionPhase.waiting, .running, .idle, .exited], id: \.self) { phase in
                let n = count(phase)
                if n > 0 {
                    HStack(spacing: 3) {
                        Circle().fill(phase.color).frame(width: 6, height: 6)
                        Text("\(n)").monospacedDigit()
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(n) 个\(phase.label)")
                }
            }
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(.secondary)
    }

    private func count(_ phase: SessionPhase) -> Int {
        switch phase {
        case .waiting: counts.waiting
        case .running: counts.running
        case .idle: counts.idle
        case .exited: counts.exited
        }
    }
}

/// 橙色「等待输入」角标。
struct WaitingBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .frame(minWidth: 20, minHeight: 20)
            .padding(.horizontal, count > 9 ? 4 : 0)
            .background(.orange, in: Capsule())
            .accessibilityLabel("\(count) 个等待输入")
    }
}

/// 选择器里的布局卡：缩略图 + 名称（桌面当前标记）+ 电脑名 + 相位汇总；等待输入角标、选中勾。
struct LayoutGridCard: View {
    let group: MirrorGroup
    let selected: Bool
    var computerName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LayoutPreview(group: group)
                .frame(height: 58)
            VStack(alignment: .leading, spacing: 2) {
                Text(group.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 4) {
                    if group.isCurrentLayout {
                        Image(systemName: "desktopcomputer")
                            .foregroundStyle(Color.accentColor)
                            .accessibilityLabel("桌面当前布局")
                    }
                    if let computerName {
                        Text(computerName).lineLimit(1)
                    } else if group.isCurrentLayout {
                        Text("桌面当前").foregroundStyle(Color.accentColor)
                    } else {
                        Text(kindDetail).lineLimit(1)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            HStack(spacing: 0) {
                PhaseCountsRow(counts: group.counts)
                Spacer(minLength: 4)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.body)
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: 20)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Color.accentColor.opacity(0.12) : DK.card,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.06), lineWidth: selected ? 2 : 1)
        }
        .overlay(alignment: .topTrailing) {
            if group.counts.waiting > 0 {
                WaitingBadge(count: group.counts.waiting)
                    .overlay(Capsule().strokeBorder(DK.canvas, lineWidth: 2))
                    .offset(x: 5, y: -5)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private var kindDetail: String {
        switch group.kind {
        case .layout: group.shape.map { "\($0.paneCount) 个窗格" } ?? "布局"
        case .mobileRemote: "手机启动"
        case .orphan: "未在电脑布局中"
        }
    }
}

/// 布局页顶部的细条（~36pt）：左侧分屏小地图（相位着色、小序号、等待格橙框；点格跳到该会话），右侧一行相位汇总。
/// 单窗格布局不显示（调用方判断 `LayoutStrip.isUseful`）。
struct LayoutStrip: View {
    let group: MirrorGroup
    var onTapPane: (Int) -> Void

    static func isUseful(_ group: MirrorGroup) -> Bool { (group.shape?.paneCount ?? 0) > 1 }

    var body: some View {
        HStack(spacing: 10) {
            if let shape = group.shape {
                LayoutThumbnail(shape: shape, phaseOf: group.phase(ofPane:), spacing: 2, radius: 4,
                                compactOrdinals: true, onTapPane: onTapPane)
                    .frame(width: min(132, CGFloat(shape.paneCount) * 26 + 20), height: 30)
            }
            Text(group.counts.compactSummary)
                .font(.caption.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
        }
        .frame(height: 36)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("布局地图，\(group.counts.compactSummary)")
    }
}

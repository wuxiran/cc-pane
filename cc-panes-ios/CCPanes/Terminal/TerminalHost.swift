import SwiftTerm
import SwiftUI
import UIKit

/// SwiftUI 包装：把 SwiftTerm 的 TerminalView 绑定到 TerminalSession。
struct TerminalHost: UIViewRepresentable {
    let session: TerminalSession
    let fitRequest: Int

    func makeUIView(context: Context) -> TerminalContainer {
        let container = TerminalContainer()
        container.onInput = { [weak session] text in session?.send(text) }
        session.sink = container
        return container
    }

    func updateUIView(_ container: TerminalContainer, context: Context) {
        container.ptyGeometry = session.ptyGeometry
        container.isEditable = session.isInteractive
        if context.coordinator.lastFit != fitRequest {
            context.coordinator.lastFit = fitRequest
            if fitRequest > 0, let grid = container.comfortableGrid() {
                session.resizePty(cols: grid.cols, rows: grid.rows)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator { var lastFit = 0 }
}

/// 承载 TerminalView 的容器。
///
/// 共享 PTY 的网格属于电脑端：默认不 resize，而是按 PTY 列数缩小字号，让本端
/// 网格列数恰好等于 PTY 列数（否则 Ink 等 TUI 的折行/光标定位会错乱）。用户点
/// 「适配手机」才把 PTY 改成手机舒适网格。
@MainActor
final class TerminalContainer: UIView, TerminalSink, TerminalViewDelegate {
    var onInput: ((String) -> Void)?
    var ptyGeometry: TerminalGeometry? {
        didSet { if oldValue != ptyGeometry { setNeedsLayout() } }
    }
    var isEditable = true

    private var terminalView: TerminalView
    private var appliedFontSize: CGFloat = 0

    private var maxFontSize: CGFloat {
        traitCollection.horizontalSizeClass == .regular ? 15 : 13
    }

    override init(frame: CGRect) {
        terminalView = TerminalView(frame: .zero)
        super.init(frame: frame)
        backgroundColor = .black
        installTerminalView()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // MARK: TerminalSink

    func reset(geometry: TerminalGeometry?) {
        // 每次 attach 换一个全新的 TerminalView：避免旧屏幕/滚动区残留
        let wasFirstResponder = terminalView.isFirstResponder
        terminalView.removeFromSuperview()
        terminalView = TerminalView(frame: .zero)
        appliedFontSize = 0
        ptyGeometry = geometry
        installTerminalView()
        layoutIfNeeded()
        if wasFirstResponder { _ = terminalView.becomeFirstResponder() }
    }

    func write(_ text: String) {
        terminalView.feed(text: text)
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0 else { return }
        let cols = ptyGeometry?.cols ?? 0
        let size = cols > 0 ? fittingFontSize(cols: cols) : maxFontSize
        if abs(size - appliedFontSize) > 0.01 {
            appliedFontSize = size
            terminalView.font = Self.font(size)
        }
        var width = bounds.width
        if cols > 0 {
            // 恰好 cols 列宽 + 半格余量，避免像素取整少一列
            width = min(bounds.width, CGFloat(cols) * Self.cellWidth(appliedFontSize) + Self.cellWidth(appliedFontSize) * 0.5)
        }
        terminalView.frame = CGRect(x: 0, y: 0, width: width, height: bounds.height)
    }

    /// 以舒适字号计算的手机网格（「适配手机」用）。
    func comfortableGrid() -> TerminalGeometry? {
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let size = maxFontSize
        let cols = Int(bounds.width / Self.cellWidth(size))
        let rows = Int(bounds.height / (Self.font(size).lineHeight.rounded(.up)))
        return TerminalGeometry(cols: max(cols, 20), rows: max(rows, 5))
    }

    private func fittingFontSize(cols: Int) -> CGFloat {
        let perPoint = Self.cellWidth(100) / 100
        let fit = bounds.width / (CGFloat(cols) * perPoint)
        return max(4, min(maxFontSize, (fit * 4).rounded(.down) / 4))
    }

    private func installTerminalView() {
        terminalView.terminalDelegate = self
        terminalView.nativeBackgroundColor = .black
        terminalView.nativeForegroundColor = UIColor(white: 0.9, alpha: 1)
        terminalView.optionAsMetaKey = true
        addSubview(terminalView)
        setNeedsLayout()
    }

    private static func font(_ size: CGFloat) -> UIFont {
        UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    private static func cellWidth(_ size: CGFloat) -> CGFloat {
        let scale = UIScreen.main.scale
        let w = ("W" as NSString).size(withAttributes: [.font: font(size)]).width
        return (w * scale).rounded(.up) / scale
    }

    // MARK: TerminalViewDelegate

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        guard isEditable else { return }
        let text = String(decoding: data, as: UTF8.self)
        if TerminalReplyFilter.isAutomaticReply(text) { return }
        onInput?(text)
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        if let url = URL(string: link), ["http", "https"].contains(url.scheme) {
            UIApplication.shared.open(url)
        }
    }
    func bell(source: TerminalView) {}
    func clipboardCopy(source: TerminalView, content: Data) {
        if let text = String(data: content, encoding: .utf8) { UIPasteboard.general.string = text }
    }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

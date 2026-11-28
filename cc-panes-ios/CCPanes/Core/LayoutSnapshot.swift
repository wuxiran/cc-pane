import Foundation

/// GET /api/layout-snapshot/{profileId} —— 电脑前端 usePanesStore 的布局树镜像。
/// 结构对齐 web/types：payload.layouts[] → rootPane(Panel|Split) → tabs[] → terminalRootPane(leaf|split)。
/// 解析口径照搬 Flutter 版 `models/layout_snapshot.dart`：所有字段可缺失，未知/坏元素跳过不炸。
struct LayoutSnapshot: Decodable, Sendable {
    var currentLayoutId: String?
    var layouts: [LayoutEntry]
    /// ISO8601 字符串，桌面前端最后一次落库时间（用于陈旧判断与新旧 profileId 择新）。
    var savedAt: String?
    var workspaceName: String?
    var source: String?

    var savedAtDate: Date? { savedAt.flatMap(parseISO8601) }

    init(currentLayoutId: String? = nil, layouts: [LayoutEntry] = [], savedAt: String? = nil,
         workspaceName: String? = nil, source: String? = nil) {
        self.currentLayoutId = currentLayoutId
        self.layouts = layouts
        self.savedAt = savedAt
        self.workspaceName = workspaceName
        self.source = source
    }

    private enum CodingKeys: String, CodingKey { case payload, savedAt, workspaceName, source }
    private enum PayloadKeys: String, CodingKey { case currentLayoutId, layouts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        savedAt = try? c.decodeIfPresent(String.self, forKey: .savedAt)
        workspaceName = try? c.decodeIfPresent(String.self, forKey: .workspaceName)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        let payload = try? c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
        currentLayoutId = try? payload?.decodeIfPresent(String.self, forKey: .currentLayoutId)
        layouts = (try? payload?.decodeIfPresent(LossyArray<LayoutEntry>.self, forKey: .layouts))??.items ?? []
    }
}

struct LayoutEntry: Decodable, Sendable {
    var id: String
    var name: String
    var kind: String?
    var activePaneId: String?
    var rootPane: PaneNode?

    init(id: String, name: String, kind: String? = nil, rootPane: PaneNode?) {
        self.id = id
        self.name = name
        self.kind = kind
        self.rootPane = rootPane
    }

    private enum CodingKeys: String, CodingKey { case id, name, kind, activePaneId, rootPane }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        activePaneId = try? c.decodeIfPresent(String.self, forKey: .activePaneId)
        rootPane = try? c.decodeIfPresent(PaneNode.self, forKey: .rootPane)
    }
}

/// 分屏树节点：Panel（含标签页）| Split（递归子面板）。判别字段 type，缺省当 Panel。
/// Split 的 `horizontal` = 左右分割（web `direction: "horizontal"`），`sizes` 为各子面板占比（缺省等分）。
indirect enum PaneNode: Decodable, Sendable {
    case panel(id: String, activeTabId: String?, tabs: [LayoutTab])
    case split([PaneNode], horizontal: Bool = true, sizes: [Double] = [])

    private enum CodingKeys: String, CodingKey { case type, id, activeTabId, tabs, children, direction, sizes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if (try? c.decodeIfPresent(String.self, forKey: .type)) == "split" {
            self = .split((try? c.decodeIfPresent(LossyArray<PaneNode>.self, forKey: .children))??.items ?? [],
                          horizontal: (try? c.decodeIfPresent(String.self, forKey: .direction)) != "vertical",
                          sizes: ((try? c.decodeIfPresent([Double].self, forKey: .sizes)) ?? nil) ?? [])
            return
        }
        self = .panel(
            id: (try? c.decodeIfPresent(String.self, forKey: .id)) ?? "",
            activeTabId: try? c.decodeIfPresent(String.self, forKey: .activeTabId),
            tabs: (try? c.decodeIfPresent(LossyArray<LayoutTab>.self, forKey: .tabs))??.items ?? []
        )
    }
}

struct LayoutTab: Decodable, Sendable {
    var id: String
    var title: String
    var contentType: String
    var projectPath: String
    var sessionId: String?
    var savedSessionId: String?
    var cliTool: String?
    var terminalRootPane: TerminalNode?
    var activeTerminalPaneId: String?

    var isTerminal: Bool { contentType == "terminal" }

    init(id: String, title: String, contentType: String = "terminal", projectPath: String,
         sessionId: String? = nil, savedSessionId: String? = nil, cliTool: String? = nil,
         terminalRootPane: TerminalNode? = nil, activeTerminalPaneId: String? = nil) {
        self.id = id
        self.title = title
        self.contentType = contentType
        self.projectPath = projectPath
        self.sessionId = sessionId
        self.savedSessionId = savedSessionId
        self.cliTool = cliTool
        self.terminalRootPane = terminalRootPane
        self.activeTerminalPaneId = activeTerminalPaneId
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, contentType, projectPath, sessionId, savedSessionId, cliTool, terminalRootPane, activeTerminalPaneId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        contentType = (try? c.decodeIfPresent(String.self, forKey: .contentType)) ?? ""
        projectPath = (try? c.decodeIfPresent(String.self, forKey: .projectPath)) ?? ""
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        savedSessionId = try? c.decodeIfPresent(String.self, forKey: .savedSessionId)
        cliTool = try? c.decodeIfPresent(String.self, forKey: .cliTool)
        terminalRootPane = try? c.decodeIfPresent(TerminalNode.self, forKey: .terminalRootPane)
        activeTerminalPaneId = try? c.decodeIfPresent(String.self, forKey: .activeTerminalPaneId)
    }
}

/// tab 内终端分屏：leaf（持有 sessionId）| split（递归）。缺省当 leaf。
indirect enum TerminalNode: Decodable, Sendable {
    case leaf(TerminalLeaf)
    case split([TerminalNode])

    private enum CodingKeys: String, CodingKey { case type, children }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if (try? c.decodeIfPresent(String.self, forKey: .type)) == "split" {
            self = .split((try? c.decodeIfPresent(LossyArray<TerminalNode>.self, forKey: .children))??.items ?? [])
            return
        }
        self = .leaf(try TerminalLeaf(from: decoder))
    }
}

struct TerminalLeaf: Decodable, Sendable {
    var id: String
    var sessionId: String?
    /// 「恢复中但尚未 attach」的会话（桌面没切到该布局时常见），背后是真实存在的 PTY。
    var savedSessionId: String?
    var cliTool: String?

    init(id: String, sessionId: String? = nil, savedSessionId: String? = nil, cliTool: String? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.savedSessionId = savedSessionId
        self.cliTool = cliTool
    }

    private enum CodingKeys: String, CodingKey { case id, sessionId, savedSessionId, cliTool }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        savedSessionId = try? c.decodeIfPresent(String.self, forKey: .savedSessionId)
        cliTool = try? c.decodeIfPresent(String.self, forKey: .cliTool)
    }

    /// 实际会话 id：已 attach 的 sessionId 优先，其次 savedSessionId。
    var effectiveSessionId: String? { nonEmpty(sessionId) ?? nonEmpty(savedSessionId) }
}

/// 解码数组时跳过坏元素（服务端字段演进不应让整份快照解析失败）。
struct LossyArray<Element: Decodable & Sendable>: Decodable, Sendable {
    var items: [Element]

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var result: [Element] = []
        while !c.isAtEnd {
            if let item = try? c.decode(Element.self) {
                result.append(item)
            } else {
                _ = try? c.decode(Discard.self)
            }
        }
        items = result
    }

    /// 接受任意 JSON 值、只为推进游标（坏元素可能是字符串/null，不能要求是对象）。
    private struct Discard: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

func nonEmpty(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

/// ISO8601（带/不带毫秒）。
func parseISO8601(_ text: String) -> Date? {
    if let d = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) { return d }
    return try? Date.ISO8601FormatStyle().parse(text)
}

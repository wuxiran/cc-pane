import 'workspace.dart' show pathBasename;

/// GET /api/layout-snapshot/{profileId} —— 电脑前端 usePanesStore 的布局树镜像。
/// 结构对齐 web/types：payload.layouts[] → rootPane(Panel|Split) → tabs[] → terminalRootPane(leaf|split)。
class LayoutSnapshot {
  const LayoutSnapshot({
    required this.currentLayoutId,
    required this.layouts,
    this.savedAt,
    this.workspaceName,
    this.source,
  });

  final String? currentLayoutId;
  final List<LayoutEntry> layouts;

  /// ISO8601 字符串，桌面前端最后一次落库时间（用于陈旧判断）。
  final String? savedAt;
  final String? workspaceName;
  final String? source;

  DateTime? get savedAtTime =>
      savedAt == null ? null : DateTime.tryParse(savedAt!)?.toUtc();

  factory LayoutSnapshot.fromJson(Map<String, dynamic> json) {
    final payload = json['payload'] as Map<String, dynamic>? ?? const {};
    return LayoutSnapshot(
      currentLayoutId: payload['currentLayoutId'] as String?,
      layouts: (payload['layouts'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(LayoutEntry.fromJson)
          .toList(),
      savedAt: json['savedAt'] as String?,
      workspaceName: json['workspaceName'] as String?,
      source: json['source'] as String?,
    );
  }
}

class LayoutEntry {
  const LayoutEntry({
    required this.id,
    required this.name,
    required this.rootPane,
    this.kind,
    this.activePaneId,
  });

  final String id;
  final String name;
  final String? kind;
  final String? activePaneId;
  final PaneNode? rootPane;

  factory LayoutEntry.fromJson(Map<String, dynamic> json) => LayoutEntry(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        kind: json['kind'] as String?,
        activePaneId: json['activePaneId'] as String?,
        rootPane: PaneNode.tryParse(json['rootPane']),
      );
}

/// 分屏树节点：Panel（含标签页）| Split（递归子面板）。判别字段 type。
sealed class PaneNode {
  const PaneNode();

  static PaneNode? tryParse(dynamic node) {
    if (node is! Map<String, dynamic>) return null;
    if (node['type'] == 'split') {
      return SplitPane(
        children: (node['children'] as List<dynamic>? ?? const [])
            .map(PaneNode.tryParse)
            .whereType<PaneNode>()
            .toList(),
      );
    }
    // type == "panel"（或缺省）当作 Panel
    return Panel(
      id: node['id'] as String? ?? '',
      activeTabId: node['activeTabId'] as String?,
      tabs: (node['tabs'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(Tab.fromJson)
          .toList(),
    );
  }
}

final class Panel extends PaneNode {
  const Panel({required this.id, required this.tabs, this.activeTabId});
  final String id;
  final String? activeTabId;
  final List<Tab> tabs;
}

final class SplitPane extends PaneNode {
  const SplitPane({required this.children});
  final List<PaneNode> children;
}

class Tab {
  const Tab({
    required this.id,
    required this.title,
    required this.contentType,
    required this.projectPath,
    this.sessionId,
    this.cliTool,
    this.terminalRootPane,
    this.activeTerminalPaneId,
  });

  final String id;
  final String title;
  final String contentType;
  final String projectPath;
  final String? sessionId;
  final String? cliTool;
  final TerminalNode? terminalRootPane;
  final String? activeTerminalPaneId;

  bool get isTerminal => contentType == 'terminal';

  factory Tab.fromJson(Map<String, dynamic> json) => Tab(
        id: json['id'] as String? ?? '',
        title: json['title'] as String? ?? '',
        contentType: json['contentType'] as String? ?? '',
        projectPath: json['projectPath'] as String? ?? '',
        sessionId: json['sessionId'] as String?,
        cliTool: json['cliTool'] as String?,
        terminalRootPane: TerminalNode.tryParse(json['terminalRootPane']),
        activeTerminalPaneId: json['activeTerminalPaneId'] as String?,
      );
}

/// tab 内终端分屏：leaf（持有 sessionId）| split（递归）。
sealed class TerminalNode {
  const TerminalNode();

  static TerminalNode? tryParse(dynamic node) {
    if (node is! Map<String, dynamic>) return null;
    if (node['type'] == 'split') {
      return TerminalSplit(
        children: (node['children'] as List<dynamic>? ?? const [])
            .map(TerminalNode.tryParse)
            .whereType<TerminalNode>()
            .toList(),
      );
    }
    // type == "leaf"（或缺省）
    return TerminalLeaf(
      id: node['id'] as String? ?? '',
      sessionId: node['sessionId'] as String?,
    );
  }
}

final class TerminalLeaf extends TerminalNode {
  const TerminalLeaf({required this.id, this.sessionId});
  final String id;
  final String? sessionId;
}

final class TerminalSplit extends TerminalNode {
  const TerminalSplit({required this.children});
  final List<TerminalNode> children;
}

/// 从布局树提取的一张会话卡（一个终端 leaf = 一张卡）。
class SessionCard {
  const SessionCard({
    required this.sessionId,
    required this.title,
    required this.projectPath,
    required this.layoutId,
    required this.layoutName,
    required this.isCurrentLayout,
    required this.paneOrdinal,
    required this.isActiveLeaf,
    this.cliTool,
  });

  final String sessionId;
  final String title;
  final String projectPath;
  final String? cliTool;
  final String layoutId;
  final String layoutName;
  final bool isCurrentLayout;

  /// pane 在所属布局里的序号（1-based），用于卡片显示 "Pane N"。
  final int paneOrdinal;

  /// 该 leaf 是否是 tab 当前聚焦的终端分屏。
  final bool isActiveLeaf;

  String get projectName => pathBasename(projectPath);
}

/// 规范化项目路径，用于跨来源（布局快照 / 手机 localMeta / 工作区列表）相等比较。
/// 去 `\\?\` / `//?/` 长路径前缀 → 反斜杠转正斜杠 → 小写 → 去尾部斜杠。
String normalizeProjectPath(String p) {
  var s = p.trim();
  if (s.startsWith(r'\\?\')) s = s.substring(4);
  s = s.replaceAll(r'\', '/');
  if (s.startsWith('//?/')) s = s.substring(4);
  s = s.toLowerCase();
  while (s.length > 1 && s.endsWith('/')) {
    s = s.substring(0, s.length - 1);
  }
  return s;
}

/// 递归收集一个 rootPane 下的所有 Panel（保持左→右/上→下顺序）。
List<Panel> collectPanels(PaneNode? node) {
  if (node is Panel) return [node];
  if (node is SplitPane) return node.children.expand(collectPanels).toList();
  return const [];
}

/// 递归收集一个 terminalRootPane 下的所有 leaf。
List<TerminalLeaf> collectTerminalLeaves(TerminalNode? node) {
  if (node is TerminalLeaf) return [node];
  if (node is TerminalSplit) return node.children.expand(collectTerminalLeaves).toList();
  return const [];
}

/// 把布局树拍平成会话卡列表（一个终端 leaf 一张卡）。
///
/// 解析规则（吸收 Codex 评审必修 3）：
/// - 只处理 contentType=="terminal" 的 tab；
/// - 有 terminalRootPane → 递归 leaves，取每个非空 sessionId；
/// - 无 terminalRootPane → fallback tab.sessionId；
/// - 全局按 sessionId 去重（防同一 sessionId 出现在 tab 顶层 + leaf 或异常重复）；
/// - 空 sessionId / 非 terminal tab 跳过。
List<SessionCard> collectSessionCards(LayoutSnapshot snapshot) {
  final cards = <SessionCard>[];
  final seen = <String>{};

  void addCard({
    required String sessionId,
    required Tab tab,
    required LayoutEntry layout,
    required int paneOrdinal,
    required bool isActiveLeaf,
  }) {
    if (sessionId.isEmpty || !seen.add(sessionId)) return;
    cards.add(SessionCard(
      sessionId: sessionId,
      title: tab.title.isNotEmpty ? tab.title : pathBasename(tab.projectPath),
      projectPath: tab.projectPath,
      cliTool: tab.cliTool,
      layoutId: layout.id,
      layoutName: layout.name,
      isCurrentLayout: layout.id == snapshot.currentLayoutId,
      paneOrdinal: paneOrdinal,
      isActiveLeaf: isActiveLeaf,
    ));
  }

  for (final layout in snapshot.layouts) {
    final panels = collectPanels(layout.rootPane);
    for (var i = 0; i < panels.length; i++) {
      final panel = panels[i];
      for (final tab in panel.tabs) {
        if (!tab.isTerminal) continue;
        final leaves = collectTerminalLeaves(tab.terminalRootPane);
        if (leaves.isNotEmpty) {
          for (final leaf in leaves) {
            final sid = leaf.sessionId;
            if (sid == null) continue;
            addCard(
              sessionId: sid,
              tab: tab,
              layout: layout,
              paneOrdinal: i + 1,
              isActiveLeaf: leaf.id == tab.activeTerminalPaneId,
            );
          }
        } else if (tab.sessionId != null) {
          // fallback：无 terminalRootPane 的旧/最小快照
          addCard(
            sessionId: tab.sessionId!,
            tab: tab,
            layout: layout,
            paneOrdinal: i + 1,
            isActiveLeaf: tab.id == panel.activeTabId,
          );
        }
      }
    }
  }
  return cards;
}

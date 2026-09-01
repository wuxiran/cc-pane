import { asArray, asRecord, jsonGetRecord, jsonGetRecords, jsonGetString, jsonGetStringOpt } from '../common/Json';
import { pathBasename } from '../common/Format';

/**
 * GET /api/layout-snapshot/{profileId} —— 电脑前端 usePanesStore 的布局树镜像。
 * 结构对齐 web/types：payload.layouts[] → rootPane(Panel|Split) → tabs[] → terminalRootPane(leaf|split)。
 * 解析规则与 Dart layout_snapshot.dart 逐条对应（有单测锁定语义）。
 */
export class LayoutSnapshot {
  readonly currentLayoutId: string | undefined;
  readonly layouts: LayoutEntry[];

  /** ISO8601 字符串，桌面前端最后一次落库时间（用于陈旧判断）。 */
  readonly savedAt: string | undefined;
  readonly workspaceName: string | undefined;
  readonly source: string | undefined;

  constructor(
    currentLayoutId: string | undefined,
    layouts: LayoutEntry[],
    savedAt: string | undefined,
    workspaceName: string | undefined,
    source: string | undefined
  ) {
    this.currentLayoutId = currentLayoutId;
    this.layouts = layouts;
    this.savedAt = savedAt;
    this.workspaceName = workspaceName;
    this.source = source;
  }

  /** savedAt 解析为 epoch 毫秒（UTC）；缺失或非法返回 undefined（对齐 Dart savedAtTime）。 */
  savedAtMs(): number | undefined {
    if (this.savedAt === undefined || this.savedAt.length === 0) {
      return undefined;
    }
    let ms: number = Date.parse(this.savedAt);
    return Number.isNaN(ms) ? undefined : ms;
  }

  static fromJson(root: Record<string, Object>): LayoutSnapshot {
    let payload: Record<string, Object> | undefined = jsonGetRecord(root, 'payload');
    let layouts: LayoutEntry[] = [];
    if (payload !== undefined) {
      let layoutRecs: Record<string, Object>[] = jsonGetRecords(payload, 'layouts');
      for (let item of layoutRecs) {
        layouts.push(LayoutEntry.fromJson(item));
      }
    }
    return new LayoutSnapshot(
      payload !== undefined ? jsonGetStringOpt(payload, 'currentLayoutId') : undefined,
      layouts,
      jsonGetStringOpt(root, 'savedAt'),
      jsonGetStringOpt(root, 'workspaceName'),
      jsonGetStringOpt(root, 'source')
    );
  }
}

export class LayoutEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: string | undefined;
  readonly activePaneId: string | undefined;
  readonly rootPane: PaneNode | undefined;

  constructor(
    id: string,
    name: string,
    kind: string | undefined,
    activePaneId: string | undefined,
    rootPane: PaneNode | undefined
  ) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.activePaneId = activePaneId;
    this.rootPane = rootPane;
  }

  static fromJson(rec: Record<string, Object>): LayoutEntry {
    return new LayoutEntry(
      jsonGetString(rec, 'id', ''),
      jsonGetString(rec, 'name', ''),
      jsonGetStringOpt(rec, 'kind'),
      jsonGetStringOpt(rec, 'activePaneId'),
      PaneNode.tryParse(rec['rootPane'])
    );
  }
}

/** 分屏树节点基类：Panel（含标签页）| SplitPane（递归子面板）。判别字段 type。 */
export class PaneNode {
  static tryParse(node: Object | undefined): PaneNode | undefined {
    let rec: Record<string, Object> | undefined = asRecord(node);
    if (rec === undefined) {
      return undefined;
    }
    if (jsonGetString(rec, 'type', '') === 'split') {
      let children: PaneNode[] = [];
      let rawChildren: Object[] | undefined = asArray(rec['children']);
      if (rawChildren !== undefined) {
        for (let item of rawChildren) {
          let child: PaneNode | undefined = PaneNode.tryParse(item);
          if (child !== undefined) {
            children.push(child);
          }
        }
      }
      return new SplitPane(children);
    }
    // type == "panel"（或缺省）当作 Panel
    let tabs: Tab[] = [];
    let tabRecs: Record<string, Object>[] = jsonGetRecords(rec, 'tabs');
    for (let item of tabRecs) {
      tabs.push(Tab.fromJson(item));
    }
    return new Panel(jsonGetString(rec, 'id', ''), jsonGetStringOpt(rec, 'activeTabId'), tabs);
  }
}

export class Panel extends PaneNode {
  readonly id: string;
  readonly activeTabId: string | undefined;
  readonly tabs: Tab[];

  constructor(id: string, activeTabId: string | undefined, tabs: Tab[]) {
    super();
    this.id = id;
    this.activeTabId = activeTabId;
    this.tabs = tabs;
  }
}

export class SplitPane extends PaneNode {
  readonly children: PaneNode[];

  constructor(children: PaneNode[]) {
    super();
    this.children = children;
  }
}

export class Tab {
  readonly id: string;
  readonly title: string;
  readonly contentType: string;
  readonly projectPath: string;
  readonly sessionId: string | undefined;
  readonly cliTool: string | undefined;
  readonly terminalRootPane: TerminalNode | undefined;
  readonly activeTerminalPaneId: string | undefined;

  constructor(
    id: string,
    title: string,
    contentType: string,
    projectPath: string,
    sessionId: string | undefined,
    cliTool: string | undefined,
    terminalRootPane: TerminalNode | undefined,
    activeTerminalPaneId: string | undefined
  ) {
    this.id = id;
    this.title = title;
    this.contentType = contentType;
    this.projectPath = projectPath;
    this.sessionId = sessionId;
    this.cliTool = cliTool;
    this.terminalRootPane = terminalRootPane;
    this.activeTerminalPaneId = activeTerminalPaneId;
  }

  get isTerminal(): boolean {
    return this.contentType === 'terminal';
  }

  static fromJson(rec: Record<string, Object>): Tab {
    return new Tab(
      jsonGetString(rec, 'id', ''),
      jsonGetString(rec, 'title', ''),
      jsonGetString(rec, 'contentType', ''),
      jsonGetString(rec, 'projectPath', ''),
      jsonGetStringOpt(rec, 'sessionId'),
      jsonGetStringOpt(rec, 'cliTool'),
      TerminalNode.tryParse(rec['terminalRootPane']),
      jsonGetStringOpt(rec, 'activeTerminalPaneId')
    );
  }
}

/** tab 内终端分屏节点基类：leaf（持有 sessionId）| split（递归）。 */
export class TerminalNode {
  static tryParse(node: Object | undefined): TerminalNode | undefined {
    let rec: Record<string, Object> | undefined = asRecord(node);
    if (rec === undefined) {
      return undefined;
    }
    if (jsonGetString(rec, 'type', '') === 'split') {
      let children: TerminalNode[] = [];
      let rawChildren: Object[] | undefined = asArray(rec['children']);
      if (rawChildren !== undefined) {
        for (let item of rawChildren) {
          let child: TerminalNode | undefined = TerminalNode.tryParse(item);
          if (child !== undefined) {
            children.push(child);
          }
        }
      }
      return new TerminalSplit(children);
    }
    // type == "leaf"（或缺省）
    return new TerminalLeaf(jsonGetString(rec, 'id', ''), jsonGetStringOpt(rec, 'sessionId'));
  }
}

export class TerminalLeaf extends TerminalNode {
  readonly id: string;
  readonly sessionId: string | undefined;

  constructor(id: string, sessionId: string | undefined) {
    super();
    this.id = id;
    this.sessionId = sessionId;
  }
}

export class TerminalSplit extends TerminalNode {
  readonly children: TerminalNode[];

  constructor(children: TerminalNode[]) {
    super();
    this.children = children;
  }
}

/** 从布局树提取的一张会话卡（一个终端 leaf = 一张卡）。 */
export class SessionCard {
  readonly sessionId: string;
  readonly title: string;
  readonly projectPath: string;
  readonly cliTool: string | undefined;
  readonly layoutId: string;
  readonly layoutName: string;
  readonly isCurrentLayout: boolean;

  /** pane 在所属布局里的序号（1-based），用于卡片显示 "Pane N"。 */
  readonly paneOrdinal: number;

  /** 该 leaf 是否是 tab 当前聚焦的终端分屏。 */
  readonly isActiveLeaf: boolean;

  constructor(
    sessionId: string,
    title: string,
    projectPath: string,
    cliTool: string | undefined,
    layoutId: string,
    layoutName: string,
    isCurrentLayout: boolean,
    paneOrdinal: number,
    isActiveLeaf: boolean
  ) {
    this.sessionId = sessionId;
    this.title = title;
    this.projectPath = projectPath;
    this.cliTool = cliTool;
    this.layoutId = layoutId;
    this.layoutName = layoutName;
    this.isCurrentLayout = isCurrentLayout;
    this.paneOrdinal = paneOrdinal;
    this.isActiveLeaf = isActiveLeaf;
  }

  get projectName(): string {
    return pathBasename(this.projectPath);
  }
}

/**
 * 规范化项目路径，用于跨来源（布局快照 / 手机 localMeta / 工作区列表）相等比较。
 * 去 `\\?\` / `//?/` 长路径前缀 → 反斜杠转正斜杠 → 小写 → 去尾部斜杠。
 */
export function normalizeProjectPath(p: string): string {
  let s: string = p.trim();
  if (s.startsWith('\\\\?\\')) {
    s = s.substring(4);
  }
  s = s.split('\\').join('/');
  if (s.startsWith('//?/')) {
    s = s.substring(4);
  }
  s = s.toLowerCase();
  while (s.length > 1 && s.endsWith('/')) {
    s = s.substring(0, s.length - 1);
  }
  return s;
}

/** 递归收集一个 rootPane 下的所有 Panel（保持左→右/上→下顺序）。 */
export function collectPanels(node: PaneNode | undefined): Panel[] {
  if (node instanceof Panel) {
    return [node];
  }
  if (node instanceof SplitPane) {
    let out: Panel[] = [];
    for (let child of node.children) {
      let collected: Panel[] = collectPanels(child);
      for (let panel of collected) {
        out.push(panel);
      }
    }
    return out;
  }
  return [];
}

/** 递归收集一个 terminalRootPane 下的所有 leaf。 */
export function collectTerminalLeaves(node: TerminalNode | undefined): TerminalLeaf[] {
  if (node instanceof TerminalLeaf) {
    return [node];
  }
  if (node instanceof TerminalSplit) {
    let out: TerminalLeaf[] = [];
    for (let child of node.children) {
      let collected: TerminalLeaf[] = collectTerminalLeaves(child);
      for (let leaf of collected) {
        out.push(leaf);
      }
    }
    return out;
  }
  return [];
}

/**
 * 把布局树拍平成会话卡列表（一个终端 leaf 一张卡）。
 *
 * 解析规则（吸收 Codex 评审必修 3）：
 * - 只处理 contentType=="terminal" 的 tab；
 * - 有 terminalRootPane → 递归 leaves，取每个非空 sessionId；
 * - 无 terminalRootPane → fallback tab.sessionId；
 * - 全局按 sessionId 去重（防同一 sessionId 出现在 tab 顶层 + leaf 或异常重复）；
 * - 空 sessionId / 非 terminal tab 跳过。
 */
export function collectSessionCards(snapshot: LayoutSnapshot): SessionCard[] {
  let cards: SessionCard[] = [];
  let seen: Set<string> = new Set();

  let addCard = (sessionId: string, tab: Tab, layout: LayoutEntry, paneOrdinal: number, isActiveLeaf: boolean): void => {
    if (sessionId.length === 0 || seen.has(sessionId)) {
      return;
    }
    seen.add(sessionId);
    cards.push(new SessionCard(
      sessionId,
      tab.title.length > 0 ? tab.title : pathBasename(tab.projectPath),
      tab.projectPath,
      tab.cliTool,
      layout.id,
      layout.name,
      layout.id === snapshot.currentLayoutId,
      paneOrdinal,
      isActiveLeaf
    ));
  };

  for (let layout of snapshot.layouts) {
    let panels: Panel[] = collectPanels(layout.rootPane);
    for (let i = 0; i < panels.length; i++) {
      let panel: Panel = panels[i];
      for (let tab of panel.tabs) {
        if (!tab.isTerminal) {
          continue;
        }
        let leaves: TerminalLeaf[] = collectTerminalLeaves(tab.terminalRootPane);
        if (leaves.length > 0) {
          for (let leaf of leaves) {
            let sid: string | undefined = leaf.sessionId;
            if (sid === undefined) {
              continue;
            }
            addCard(sid, tab, layout, i + 1, leaf.id === tab.activeTerminalPaneId);
          }
        } else if (tab.sessionId !== undefined) {
          // fallback：无 terminalRootPane 的旧/最小快照
          addCard(tab.sessionId, tab, layout, i + 1, tab.id === panel.activeTabId);
        }
      }
    }
  }
  return cards;
}

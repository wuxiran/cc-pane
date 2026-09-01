import { describe, it, expect } from '@ohos/hypium';
import {
  collectSessionCards,
  LayoutSnapshot,
  normalizeProjectPath
} from '../../../main/ets/model/LayoutSnapshot';
import { SavedSession } from '../../../main/ets/model/SavedSession';
import { SessionInfo } from '../../../main/ets/model/SessionInfo';
import { buildMirrorState, MirrorGroupKind } from '../../../main/ets/model/MirrorState';

/**
 * 构造 layout-snapshot JSON（对齐 Dart test 的 snap()/termTab() 助手）。
 * null 字段用"键缺省"表达（jsonGetStringOpt 对缺省键返回 undefined，语义同 null）。
 */
function snap(currentLayoutId: string, layouts: Record<string, Object>[]): Record<string, Object> {
  let payload: Record<string, Object> = {
    'currentLayoutId': currentLayoutId,
    'layouts': layouts
  };
  return {
    'source': 'test',
    'payload': payload
  };
}

function termTab(id: string, title: string, sid: string | null, activeLeaf?: string | null): Record<string, Object> {
  let leafId: string = activeLeaf !== undefined && activeLeaf !== null ? activeLeaf : `leaf-${id}`;
  let leaf: Record<string, Object> = {
    'type': 'leaf',
    'id': leafId
  };
  if (sid !== null) {
    leaf['sessionId'] = sid;
  }
  let tab: Record<string, Object> = {
    'id': id,
    'title': title,
    'contentType': 'terminal',
    'projectPath': 'D:\\work\\repo',
    'cliTool': 'claude',
    'terminalRootPane': leaf
  };
  if (activeLeaf !== undefined && activeLeaf !== null) {
    tab['activeTerminalPaneId'] = activeLeaf;
  }
  return tab;
}

function infoFromJson(id: string, updatedAt: number, exitCode?: number): SessionInfo {
  let rec: Record<string, Object> = {
    'sessionId': id,
    'status': 'idle',
    'lastOutputAt': updatedAt,
    'updatedAt': updatedAt
  };
  if (exitCode !== undefined) {
    rec['exitCode'] = exitCode;
  }
  return SessionInfo.fromJson(rec);
}

export default function layoutSnapshotTest() {
  describe('collectSessionCards', () => {
    it('singleLayoutSingleTerminalLeaf', 0, () => {
      let tab: Record<string, Object> = termTab('t1', 'cc-book Claude', 'sess-a', 'leaf-1');
      let panel: Record<string, Object> = {
        'type': 'panel',
        'id': 'p1',
        'activeTabId': 't1',
        'tabs': [tab]
      };
      let layout: Record<string, Object> = {
        'id': 'L1',
        'name': '布局1',
        'rootPane': panel
      };
      let s: LayoutSnapshot = LayoutSnapshot.fromJson(snap('L1', [layout]));
      let cards = collectSessionCards(s);
      expect(cards.length).assertEqual(1);
      expect(cards[0].sessionId).assertEqual('sess-a');
      expect(cards[0].title).assertEqual('cc-book Claude');
      expect(cards[0].isCurrentLayout).assertTrue();
      expect(cards[0].paneOrdinal).assertEqual(1);
      expect(cards[0].isActiveLeaf).assertTrue();
    });

    it('nestedSplitPanesFlattenWithPaneOrdinal', 0, () => {
      let panelA: Record<string, Object> = {
        'type': 'panel', 'id': 'p1', 'activeTabId': 'ta',
        'tabs': [termTab('ta', 'A', 'sess-a')]
      };
      let panelB: Record<string, Object> = {
        'type': 'panel', 'id': 'p2', 'activeTabId': 'tb',
        'tabs': [termTab('tb', 'B', 'sess-b')]
      };
      let root: Record<string, Object> = {
        'type': 'split', 'direction': 'horizontal', 'sizes': [50, 50],
        'children': [panelA, panelB]
      };
      let layout: Record<string, Object> = { 'id': 'L1', 'name': 'L', 'rootPane': root };
      let cards = collectSessionCards(LayoutSnapshot.fromJson(snap('L1', [layout])));
      expect(cards.length).assertEqual(2);
      expect(cards[0].sessionId).assertEqual('sess-a');
      expect(cards[1].sessionId).assertEqual('sess-b');
      expect(cards[0].paneOrdinal).assertEqual(1);
      expect(cards[1].paneOrdinal).assertEqual(2);
    });

    it('multipleLeavesWithinOneTab', 0, () => {
      let leaf1: Record<string, Object> = { 'type': 'leaf', 'id': 'lf1', 'sessionId': 'sess-x' };
      let leaf2: Record<string, Object> = { 'type': 'leaf', 'id': 'lf2', 'sessionId': 'sess-y' };
      let terminalRoot: Record<string, Object> = {
        'type': 'split', 'children': [leaf1, leaf2]
      };
      let tab: Record<string, Object> = {
        'id': 't1', 'title': 'split tab', 'contentType': 'terminal',
        'projectPath': 'D:\\repo', 'terminalRootPane': terminalRoot
      };
      let panel: Record<string, Object> = {
        'type': 'panel', 'id': 'p1', 'activeTabId': 't1', 'tabs': [tab]
      };
      let layout: Record<string, Object> = { 'id': 'L1', 'name': 'L', 'rootPane': panel };
      let cards = collectSessionCards(LayoutSnapshot.fromJson(snap('L1', [layout])));
      expect(cards.length).assertEqual(2);
      expect(cards[0].sessionId).assertEqual('sess-x');
      expect(cards[1].sessionId).assertEqual('sess-y');
    });

    it('fallbackToTabSessionId', 0, () => {
      let tab: Record<string, Object> = {
        'id': 't1', 'title': 'legacy', 'contentType': 'terminal',
        'projectPath': 'D:\\repo'
      };
      tab['sessionId'] = 'sess-legacy';
      let panel: Record<string, Object> = {
        'type': 'panel', 'id': 'p1', 'activeTabId': 't1', 'tabs': [tab]
      };
      let layout: Record<string, Object> = { 'id': 'L1', 'name': 'L', 'rootPane': panel };
      let cards = collectSessionCards(LayoutSnapshot.fromJson(snap('L1', [layout])));
      expect(cards.length).assertEqual(1);
      expect(cards[0].sessionId).assertEqual('sess-legacy');
      expect(cards[0].isActiveLeaf).assertTrue();
    });

    it('dedupSameSessionId', 0, () => {
      let leaf: Record<string, Object> = { 'type': 'leaf', 'id': 'lf', 'sessionId': 'sess-dup' };
      let tab: Record<string, Object> = {
        'id': 't1', 'title': 'dup', 'contentType': 'terminal',
        'projectPath': 'D:\\repo', 'terminalRootPane': leaf
      };
      tab['sessionId'] = 'sess-dup';
      let panel: Record<string, Object> = {
        'type': 'panel', 'id': 'p1', 'activeTabId': 't1', 'tabs': [tab]
      };
      let layout: Record<string, Object> = { 'id': 'L1', 'name': 'L', 'rootPane': panel };
      expect(collectSessionCards(LayoutSnapshot.fromJson(snap('L1', [layout]))).length).assertEqual(1);
    });

    it('skipsEmptySessionIdAndNonTerminalTabs', 0, () => {
      let emptyTab: Record<string, Object> = {
        'id': 't1', 'title': 'empty term', 'contentType': 'terminal',
        'projectPath': '',
        'terminalRootPane': { 'type': 'leaf', 'id': 'lf' }
      };
      let editorTab: Record<string, Object> = {
        'id': 't2', 'title': 'editor', 'contentType': 'editor',
        'projectPath': 'D:\\repo'
      };
      editorTab['sessionId'] = 'not-a-terminal';
      let panel: Record<string, Object> = {
        'type': 'panel', 'id': 'p1', 'activeTabId': 't1', 'tabs': [emptyTab, editorTab]
      };
      let layout: Record<string, Object> = { 'id': 'L1', 'name': 'L', 'rootPane': panel };
      expect(collectSessionCards(LayoutSnapshot.fromJson(snap('L1', [layout]))).length).assertEqual(0);
    });
  });

  describe('buildMirrorState', () => {
    const nowMs: number = Date.parse('2026-07-05T12:00:00.000Z');

    it('groupsByLayoutCurrentFirst', 0, () => {
      let layouts: Record<string, Object>[] = [];
      let pairs: string[][] = [['L1', '布局1'], ['L2', '布局2']];
      for (let pair of pairs) {
        let lid: string = pair[0];
        let lname: string = pair[1];
        let sid: string = `sess-${lid}`;
        let tab: Record<string, Object> = termTab(`t-${sid}`, `${lname} sess`, sid);
        let panel: Record<string, Object> = {
          'type': 'panel', 'id': `p-${lid}`, 'activeTabId': `t-${sid}`, 'tabs': [tab]
        };
        let entry: Record<string, Object> = { 'id': lid, 'name': lname, 'rootPane': panel };
        layouts.push(entry);
      }
      let root: Record<string, Object> = snap('L2', layouts);
      root['savedAt'] = '2026-07-05T12:00:00.000Z';
      let snapshot = LayoutSnapshot.fromJson(root);
      let running: SessionInfo[] = [infoFromJson('sess-L1', nowMs), infoFromJson('sess-L2', nowMs)];
      let state = buildMirrorState(snapshot, running, new Map<string, SavedSession>(), nowMs);
      expect(state.groups.length).assertEqual(2);
      expect(state.groups[0].isCurrentLayout).assertTrue();
      expect(state.groups[0].title).assertEqual('布局2');
      expect(state.groups[1].title).assertEqual('布局1');
      expect(state.stale).assertFalse();
    });

    it('snapshotSessionNotRunningDropped', 0, () => {
      let tab: Record<string, Object> = termTab('t-sess-dead', 'L sess', 'sess-dead');
      let panel: Record<string, Object> = {
        'type': 'panel', 'id': 'p-L1', 'activeTabId': 't-sess-dead', 'tabs': [tab]
      };
      let root: Record<string, Object> = snap('L1', [{ 'id': 'L1', 'name': 'L', 'rootPane': panel }]);
      root['savedAt'] = '2026-07-05T12:00:00.000Z';
      let state = buildMirrorState(
        LayoutSnapshot.fromJson(root), [], new Map<string, SavedSession>(), nowMs);
      expect(state.groups.length).assertEqual(0);
    });

    it('mobileLaunchedSessionDedicatedGroup', 0, () => {
      let localMeta: Map<string, SavedSession> = new Map();
      localMeta.set('sess-m', new SavedSession('sess-m', 'D:\\work\\repo-x',
        undefined, undefined, undefined, 'claude', undefined, undefined));
      let state = buildMirrorState(undefined, [infoFromJson('sess-m', nowMs)], localMeta, nowMs);
      expect(state.groups.length).assertEqual(1);
      expect(state.groups[0].kind === MirrorGroupKind.MobileRemote).assertTrue();
      expect(state.groups[0].cards[0].projectName).assertEqual('repo-x');
    });

    it('orphanFiltersExitedAndStale', 0, () => {
      let running: SessionInfo[] = [
        infoFromJson('sess-live', nowMs),
        infoFromJson('sess-exited', nowMs, 0),
        infoFromJson('sess-old', nowMs - 600000)
      ];
      let state = buildMirrorState(undefined, running, new Map<string, SavedSession>(), nowMs);
      expect(state.groups.length).assertEqual(1);
      expect(state.groups[0].kind === MirrorGroupKind.Orphan).assertTrue();
      expect(state.groups[0].cards.length).assertEqual(1);
      expect(state.groups[0].cards[0].sessionId).assertEqual('sess-live');
      expect(state.groups[0].cards[0].orphanReason !== undefined).assertTrue();
    });

    it('staleSnapshotFlagged', 0, () => {
      let tab: Record<string, Object> = termTab('t-sess-1', 'L sess', 'sess-1');
      let panel: Record<string, Object> = {
        'type': 'panel', 'id': 'p-L1', 'activeTabId': 't-sess-1', 'tabs': [tab]
      };
      let root: Record<string, Object> = snap('L1', [{ 'id': 'L1', 'name': 'L', 'rootPane': panel }]);
      root['savedAt'] = '2026-07-05T11:55:00.000Z';
      let state = buildMirrorState(
        LayoutSnapshot.fromJson(root), [infoFromJson('sess-1', nowMs)], new Map<string, SavedSession>(), nowMs);
      expect(state.stale).assertTrue();
      expect(state.snapshotAvailable).assertTrue();
    });

    it('nullSnapshotNotAvailable', 0, () => {
      let state = buildMirrorState(undefined, [], new Map<string, SavedSession>(), nowMs);
      expect(state.snapshotAvailable).assertFalse();
      expect(state.isEmpty).assertTrue();
    });

    it('desktopMobileProjectPaths', 0, () => {
      let tab: Record<string, Object> = termTab('t-a', 'A', 'sess-a');
      tab['projectPath'] = 'D:\\work\\proj-a';
      let panel: Record<string, Object> = {
        'type': 'panel', 'id': 'p1', 'activeTabId': 't-a', 'tabs': [tab]
      };
      let root: Record<string, Object> = snap('L1', [{ 'id': 'L1', 'name': 'L', 'rootPane': panel }]);
      root['savedAt'] = '2026-07-05T12:00:00.000Z';
      let localMeta: Map<string, SavedSession> = new Map();
      localMeta.set('sess-b', new SavedSession('sess-b', 'D:\\work\\proj-b',
        undefined, undefined, undefined, 'claude', undefined, undefined));
      let state = buildMirrorState(
        LayoutSnapshot.fromJson(root),
        [infoFromJson('sess-a', nowMs), infoFromJson('sess-b', nowMs)],
        localMeta,
        nowMs
      );
      expect(state.desktopProjectPaths.has('d:/work/proj-a')).assertTrue();
      expect(state.desktopProjectPaths.has('d:/work/proj-b')).assertFalse();
      expect(state.mobileProjectPaths.has('d:/work/proj-b')).assertTrue();
      expect(state.mobileProjectPaths.has('d:/work/proj-a')).assertFalse();
    });
  });

  describe('normalizeProjectPath', () => {
    it('normalizesPrefixCaseAndTrailingSlash', 0, () => {
      expect(normalizeProjectPath('\\\\?\\D:\\Work\\Repo\\')).assertEqual('d:/work/repo');
      expect(normalizeProjectPath('D:/work/repo')).assertEqual('d:/work/repo');
      expect(normalizeProjectPath('\\\\?\\D:\\Work\\Repo\\'))
        .assertEqual(normalizeProjectPath('d:/work/repo/'));
    });
  });
}

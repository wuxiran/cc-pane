import 'package:cc_panes_mobile/models/layout_snapshot.dart';
import 'package:cc_panes_mobile/models/saved_session.dart';
import 'package:cc_panes_mobile/models/session_info.dart';
import 'package:cc_panes_mobile/state/mirror_controller.dart';
import 'package:flutter_test/flutter_test.dart';

/// 构造 layout-snapshot JSON 的辅助。
Map<String, dynamic> snap({
  required String currentLayoutId,
  required List<Map<String, dynamic>> layouts,
  String? savedAt,
  String? workspaceName,
}) =>
    {
      'savedAt': savedAt,
      'workspaceName': workspaceName,
      'source': 'test',
      'payload': {'currentLayoutId': currentLayoutId, 'layouts': layouts},
    };

Map<String, dynamic> termTab(String id, String title, String sid,
        {String? project, String cli = 'claude', String? activeLeaf}) =>
    {
      'id': id,
      'title': title,
      'contentType': 'terminal',
      'projectPath': project ?? r'D:\work\repo',
      'sessionId': null,
      'cliTool': cli,
      'activeTerminalPaneId': activeLeaf,
      'terminalRootPane': {'type': 'leaf', 'id': activeLeaf ?? 'leaf-$id', 'sessionId': sid},
    };

void main() {
  group('collectSessionCards', () {
    test('single layout single terminal leaf', () {
      final s = LayoutSnapshot.fromJson(snap(
        currentLayoutId: 'L1',
        layouts: [
          {
            'id': 'L1',
            'name': '布局1',
            'rootPane': {
              'type': 'panel',
              'id': 'p1',
              'activeTabId': 't1',
              'tabs': [termTab('t1', 'cc-book Claude', 'sess-a', activeLeaf: 'leaf-1')],
            },
          },
        ],
      ));
      final cards = collectSessionCards(s);
      expect(cards, hasLength(1));
      expect(cards[0].sessionId, 'sess-a');
      expect(cards[0].title, 'cc-book Claude');
      expect(cards[0].isCurrentLayout, isTrue);
      expect(cards[0].paneOrdinal, 1);
      expect(cards[0].isActiveLeaf, isTrue);
    });

    test('nested split panes flatten with pane ordinal', () {
      final s = LayoutSnapshot.fromJson(snap(
        currentLayoutId: 'L1',
        layouts: [
          {
            'id': 'L1',
            'name': 'L',
            'rootPane': {
              'type': 'split',
              'direction': 'horizontal',
              'sizes': [50, 50],
              'children': [
                {
                  'type': 'panel',
                  'id': 'p1',
                  'activeTabId': 'ta',
                  'tabs': [termTab('ta', 'A', 'sess-a')],
                },
                {
                  'type': 'panel',
                  'id': 'p2',
                  'activeTabId': 'tb',
                  'tabs': [termTab('tb', 'B', 'sess-b')],
                },
              ],
            },
          },
        ],
      ));
      final cards = collectSessionCards(s);
      expect(cards.map((c) => c.sessionId), ['sess-a', 'sess-b']);
      expect(cards[0].paneOrdinal, 1);
      expect(cards[1].paneOrdinal, 2);
    });

    test('multiple terminal leaves within one tab (tab-internal split)', () {
      final s = LayoutSnapshot.fromJson(snap(
        currentLayoutId: 'L1',
        layouts: [
          {
            'id': 'L1',
            'name': 'L',
            'rootPane': {
              'type': 'panel',
              'id': 'p1',
              'activeTabId': 't1',
              'tabs': [
                {
                  'id': 't1',
                  'title': 'split tab',
                  'contentType': 'terminal',
                  'projectPath': r'D:\repo',
                  'sessionId': null,
                  'terminalRootPane': {
                    'type': 'split',
                    'direction': 'vertical',
                    'sizes': [50, 50],
                    'children': [
                      {'type': 'leaf', 'id': 'lf1', 'sessionId': 'sess-x'},
                      {'type': 'leaf', 'id': 'lf2', 'sessionId': 'sess-y'},
                    ],
                  },
                },
              ],
            },
          },
        ],
      ));
      final cards = collectSessionCards(s);
      expect(cards.map((c) => c.sessionId), ['sess-x', 'sess-y']);
    });

    test('fallback to tab.sessionId when terminalRootPane missing', () {
      final s = LayoutSnapshot.fromJson(snap(
        currentLayoutId: 'L1',
        layouts: [
          {
            'id': 'L1',
            'name': 'L',
            'rootPane': {
              'type': 'panel',
              'id': 'p1',
              'activeTabId': 't1',
              'tabs': [
                {
                  'id': 't1',
                  'title': 'legacy',
                  'contentType': 'terminal',
                  'projectPath': r'D:\repo',
                  'sessionId': 'sess-legacy',
                  // 无 terminalRootPane
                },
              ],
            },
          },
        ],
      ));
      final cards = collectSessionCards(s);
      expect(cards, hasLength(1));
      expect(cards[0].sessionId, 'sess-legacy');
      expect(cards[0].isActiveLeaf, isTrue); // t1 是 activeTabId
    });

    test('dedup: same sessionId in tab top-level and leaf → one card', () {
      final s = LayoutSnapshot.fromJson(snap(
        currentLayoutId: 'L1',
        layouts: [
          {
            'id': 'L1',
            'name': 'L',
            'rootPane': {
              'type': 'panel',
              'id': 'p1',
              'activeTabId': 't1',
              'tabs': [
                {
                  'id': 't1',
                  'title': 'dup',
                  'contentType': 'terminal',
                  'projectPath': r'D:\repo',
                  'sessionId': 'sess-dup',
                  'terminalRootPane': {'type': 'leaf', 'id': 'lf', 'sessionId': 'sess-dup'},
                },
              ],
            },
          },
        ],
      ));
      expect(collectSessionCards(s), hasLength(1));
    });

    test('skips empty sessionId and non-terminal tabs', () {
      final s = LayoutSnapshot.fromJson(snap(
        currentLayoutId: 'L1',
        layouts: [
          {
            'id': 'L1',
            'name': 'L',
            'rootPane': {
              'type': 'panel',
              'id': 'p1',
              'activeTabId': 't1',
              'tabs': [
                {
                  'id': 't1',
                  'title': 'empty term',
                  'contentType': 'terminal',
                  'projectPath': '',
                  'sessionId': null,
                  'terminalRootPane': {'type': 'leaf', 'id': 'lf', 'sessionId': null},
                },
                {
                  'id': 't2',
                  'title': 'editor',
                  'contentType': 'editor',
                  'projectPath': r'D:\repo',
                  'sessionId': 'not-a-terminal',
                },
              ],
            },
          },
        ],
      ));
      expect(collectSessionCards(s), isEmpty);
    });
  });

  group('buildMirrorState', () {
    SessionInfo info(String id, {String status = 'idle', int updatedAt = 0, int? exitCode}) =>
        SessionInfo.fromJson({
          'sessionId': id,
          'status': status,
          'lastOutputAt': updatedAt,
          'updatedAt': updatedAt,
          if (exitCode != null) 'exitCode': exitCode,
        });

    LayoutSnapshot layoutWith(String current, List<(String, String, String)> byLayout,
            {String? savedAt}) =>
        LayoutSnapshot.fromJson(snap(
          currentLayoutId: current,
          savedAt: savedAt,
          layouts: [
            for (final (lid, lname, sid) in byLayout)
              {
                'id': lid,
                'name': lname,
                'rootPane': {
                  'type': 'panel',
                  'id': 'p-$lid',
                  'activeTabId': 't-$sid',
                  'tabs': [termTab('t-$sid', '$lname sess', sid)],
                },
              },
          ],
        ));

    final now = DateTime.utc(2026, 7, 5, 12, 0, 0);

    test('groups by layout, current layout first', () {
      final snapshot = layoutWith('L2', [
        ('L1', '布局1', 'sess-1'),
        ('L2', '布局2', 'sess-2'),
      ], savedAt: now.toIso8601String());
      final state = buildMirrorState(
        snapshot: snapshot,
        running: [info('sess-1'), info('sess-2')],
        localMeta: const {},
        now: now,
      );
      expect(state.groups, hasLength(2));
      expect(state.groups[0].isCurrentLayout, isTrue);
      expect(state.groups[0].title, '布局2');
      expect(state.groups[1].title, '布局1');
      expect(state.stale, isFalse);
    });

    test('session in snapshot but not running is dropped', () {
      final snapshot = layoutWith('L1', [('L1', 'L', 'sess-dead')],
          savedAt: now.toIso8601String());
      final state = buildMirrorState(
        snapshot: snapshot,
        running: const [],
        localMeta: const {},
        now: now,
      );
      expect(state.groups, isEmpty);
    });

    test('mobile-launched session goes to dedicated group', () {
      final state = buildMirrorState(
        snapshot: null,
        running: [info('sess-m')],
        localMeta: {
          'sess-m': const SavedSession(
              sessionId: 'sess-m', projectPath: r'D:\work\repo-x', cliTool: 'claude'),
        },
        now: now,
      );
      expect(state.groups, hasLength(1));
      expect(state.groups[0].kind, MirrorGroupKind.mobileRemote);
      expect(state.groups[0].cards.single.projectName, 'repo-x');
    });

    test('orphan filters exited and stale sessions', () {
      final state = buildMirrorState(
        snapshot: null,
        running: [
          info('sess-live', updatedAt: now.millisecondsSinceEpoch),
          info('sess-exited', exitCode: 0, updatedAt: now.millisecondsSinceEpoch),
          info('sess-old',
              updatedAt: now.millisecondsSinceEpoch - const Duration(minutes: 10).inMilliseconds),
        ],
        localMeta: const {},
        now: now,
      );
      expect(state.groups, hasLength(1));
      expect(state.groups[0].kind, MirrorGroupKind.orphan);
      expect(state.groups[0].cards.single.sessionId, 'sess-live');
      expect(state.groups[0].cards.single.orphanReason, isNotNull);
    });

    test('stale snapshot flagged by savedAt age', () {
      final old = now.subtract(const Duration(minutes: 5));
      final snapshot = layoutWith('L1', [('L1', 'L', 'sess-1')],
          savedAt: old.toIso8601String());
      final state = buildMirrorState(
        snapshot: snapshot,
        running: [info('sess-1')],
        localMeta: const {},
        now: now,
      );
      expect(state.stale, isTrue);
      expect(state.snapshotAvailable, isTrue);
    });

    test('null snapshot means not available', () {
      final state = buildMirrorState(
        snapshot: null,
        running: const [],
        localMeta: const {},
        now: now,
      );
      expect(state.snapshotAvailable, isFalse);
      expect(state.isEmpty, isTrue);
    });

    test('desktop/mobile project paths populated from layout + localMeta', () {
      // 布局里 A 项目有活会话；手机 launch B 项目。
      final snapshot = LayoutSnapshot.fromJson(snap(
        currentLayoutId: 'L1',
        savedAt: now.toIso8601String(),
        layouts: [
          {
            'id': 'L1',
            'name': 'L',
            'rootPane': {
              'type': 'panel',
              'id': 'p1',
              'activeTabId': 't-a',
              'tabs': [termTab('t-a', 'A', 'sess-a', project: r'D:\work\proj-a')],
            },
          },
        ],
      ));
      final state = buildMirrorState(
        snapshot: snapshot,
        running: [info('sess-a'), info('sess-b')],
        localMeta: {
          'sess-b': const SavedSession(
              sessionId: 'sess-b', projectPath: r'D:\work\proj-b', cliTool: 'claude'),
        },
        now: now,
      );
      // A 在电脑布局（规范化后小写正斜杠）；B 在手机组，不在电脑组。
      expect(state.desktopProjectPaths, contains('d:/work/proj-a'));
      expect(state.desktopProjectPaths, isNot(contains('d:/work/proj-b')));
      expect(state.mobileProjectPaths, contains('d:/work/proj-b'));
      expect(state.mobileProjectPaths, isNot(contains('d:/work/proj-a')));
    });

    test('desktop path excludes snapshot session that is not running', () {
      final snapshot = layoutWith('L1', [('L1', 'L', 'sess-dead')],
          savedAt: now.toIso8601String());
      final state = buildMirrorState(
        snapshot: snapshot,
        running: const [],
        localMeta: const {},
        now: now,
      );
      expect(state.desktopProjectPaths, isEmpty);
    });
  });

  group('normalizeProjectPath', () {
    test('long-path prefix, backslashes, case and trailing slash normalize equal', () {
      expect(normalizeProjectPath(r'\\?\D:\Work\Repo\'), 'd:/work/repo');
      expect(normalizeProjectPath('D:/work/repo'), 'd:/work/repo');
      expect(normalizeProjectPath(r'\\?\D:\Work\Repo\'),
          normalizeProjectPath('d:/work/repo/'));
    });
  });
}

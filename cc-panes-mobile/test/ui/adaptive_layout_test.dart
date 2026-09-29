import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cc_panes_mobile/ui/widgets/adaptive_layout.dart';

Widget _scaffold({required int selected, ValueChanged<int>? onSelect}) {
  return MaterialApp(
    home: AdaptiveTabScaffold(
      appBar: AppBar(title: const Text('t')),
      selectedIndex: selected,
      onDestinationSelected: onSelect ?? (_) {},
      destinations: const [
        AdaptiveDestination(
          icon: Icons.folder_outlined,
          selectedIcon: Icons.folder,
          label: '工作区',
        ),
        AdaptiveDestination(
          icon: Icons.terminal_outlined,
          selectedIcon: Icons.terminal,
          label: '终端',
          badgeCount: 3,
        ),
      ],
      body: const Text('body'),
    ),
  );
}

Future<void> _setSize(WidgetTester tester, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

void main() {
  group('AdaptiveTabScaffold', () {
    testWidgets('手机宽度用底部 NavigationBar', (tester) async {
      await _setSize(tester, const Size(390, 844));
      await tester.pumpWidget(_scaffold(selected: 0));

      expect(find.byType(NavigationBar), findsOneWidget);
      expect(find.byType(NavigationRail), findsNothing);
      expect(find.text('3'), findsOneWidget);
    });

    testWidgets('iPad 宽度用侧边 NavigationRail，点击切换 tab', (tester) async {
      await _setSize(tester, const Size(1024, 768));
      int? tapped;
      await tester.pumpWidget(_scaffold(selected: 0, onSelect: (i) => tapped = i));

      expect(find.byType(NavigationRail), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
      expect(find.text('body'), findsOneWidget);

      await tester.tap(find.text('终端'));
      expect(tapped, 1);
    });

    testWidgets('iPad 分屏窄窗口退回底部导航', (tester) async {
      await _setSize(tester, const Size(375, 1024));
      await tester.pumpWidget(_scaffold(selected: 1));

      expect(find.byType(NavigationBar), findsOneWidget);
    });
  });

  group('Breakpoints.centered', () {
    const base = EdgeInsets.fromLTRB(12, 8, 12, 80);

    test('窄于最大宽度时保持原 padding', () {
      expect(Breakpoints.centered(600, base), base);
    });

    test('宽屏两侧均分留白，内容不超过最大宽度', () {
      final padding = Breakpoints.centered(1240, base);
      expect(padding.left, 12 + 200);
      expect(padding.right, 12 + 200);
      expect(padding.top, 8);
      expect(padding.bottom, 80);
    });
  });
}

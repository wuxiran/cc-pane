import 'package:flutter/material.dart';

/// 平板/分屏适配断点：按**可用宽度**而非设备类型判断——
/// iPad 分屏（Split View / Slide Over）下窗口可能只有手机宽，应退回手机布局。
abstract final class Breakpoints {
  /// ≥ 此宽度改用侧边 NavigationRail（Material 3 medium 起点）。
  static const railMinWidth = 600.0;

  /// 列表类内容的最大阅读宽度，超出部分居中留白。
  static const contentMaxWidth = 840.0;

  /// 表单（连接页）的最大宽度。
  static const formMaxWidth = 480.0;

  /// 平板判定：最短边 ≥ 600 视为 iPad 等大屏设备（与旋转无关）。
  static bool isTablet(BuildContext context) =>
      MediaQuery.sizeOf(context).shortestSide >= 600;

  /// 宽屏时让列表内容居中且不超过 [maxWidth]：在 [base] 两侧叠加留白。
  /// 用 padding 而不是外包 ConstrainedBox，两侧留白处仍能滚动和下拉刷新。
  static EdgeInsets centered(
    double width,
    EdgeInsets base, {
    double maxWidth = contentMaxWidth,
  }) {
    final extra = ((width - maxWidth) / 2).clamp(0.0, double.infinity);
    return base.copyWith(left: base.left + extra, right: base.right + extra);
  }
}

/// 把子组件限制在 [maxWidth] 内并水平居中；窄屏时不起作用。
class ContentWidth extends StatelessWidget {
  const ContentWidth({
    super.key,
    required this.child,
    this.maxWidth = Breakpoints.contentMaxWidth,
  });

  final Widget child;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: child,
      ),
    );
  }
}

/// 首页 tab 目的地：两种导航形态共用一份定义。
class AdaptiveDestination {
  const AdaptiveDestination({
    required this.icon,
    required this.selectedIcon,
    required this.label,
    this.badgeCount = 0,
  });

  final IconData icon;
  final IconData selectedIcon;
  final String label;
  final int badgeCount;

  Widget _icon(IconData data) => Badge(
        isLabelVisible: badgeCount > 0,
        label: Text('$badgeCount'),
        child: Icon(data),
      );
}

/// 窄屏底部 NavigationBar / 宽屏左侧 NavigationRail 的 tab 首页骨架。
class AdaptiveTabScaffold extends StatelessWidget {
  const AdaptiveTabScaffold({
    super.key,
    required this.appBar,
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.destinations,
    required this.body,
  });

  final PreferredSizeWidget appBar;
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final List<AdaptiveDestination> destinations;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= Breakpoints.railMinWidth;
    if (!wide) {
      return Scaffold(
        appBar: appBar,
        body: body,
        bottomNavigationBar: NavigationBar(
          selectedIndex: selectedIndex,
          onDestinationSelected: onDestinationSelected,
          destinations: [
            for (final d in destinations)
              NavigationDestination(
                icon: d._icon(d.icon),
                selectedIcon: d._icon(d.selectedIcon),
                label: d.label,
              ),
          ],
        ),
      );
    }
    return Scaffold(
      appBar: appBar,
      body: Row(
        children: [
          SafeArea(
            right: false,
            child: NavigationRail(
              selectedIndex: selectedIndex,
              onDestinationSelected: onDestinationSelected,
              labelType: NavigationRailLabelType.all,
              destinations: [
                for (final d in destinations)
                  NavigationRailDestination(
                    icon: d._icon(d.icon),
                    selectedIcon: d._icon(d.selectedIcon),
                    label: Text(d.label),
                  ),
              ],
            ),
          ),
          const VerticalDivider(width: 1, thickness: 1),
          Expanded(child: body),
        ],
      ),
    );
  }
}

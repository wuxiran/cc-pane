import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/result.dart';
import '../../state/auth_controller.dart';
import '../../state/mirror_controller.dart';
import '../../state/workspaces_controller.dart';
import '../widgets/mirror_card.dart';
import 'terminal_screen.dart';
import 'workspace_tab.dart';

/// 双 tab 首页（照 mobile-prototype.html demo）：
/// 「工作区」= 工作空间浏览 → 项目 → 选 Claude/Codex/终端启动；
/// 「终端」= 电脑在跑的所有会话镜像（layout-snapshot join /api/sessions）→ 点接管。
class MirrorHomeScreen extends ConsumerStatefulWidget {
  const MirrorHomeScreen({super.key, required this.auth});

  final AuthReady auth;

  @override
  ConsumerState<MirrorHomeScreen> createState() => _MirrorHomeScreenState();
}

class _MirrorHomeScreenState extends ConsumerState<MirrorHomeScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final auth = widget.auth;
    final mirror = ref.watch(mirrorControllerProvider);
    final onTerminalTab = _tab == 1;
    final sessionCount = mirror.value?.groups.fold<int>(0, (n, g) => n + g.cards.length) ?? 0;

    return Scaffold(
      appBar: AppBar(
        title: onTerminalTab
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(mirror.value?.workspaceName ?? auth.client.profile.name),
                  _SyncSubtitle(state: mirror.value),
                ],
              )
            : const Text('CC-Panes Mobile'),
        actions: [
          if (onTerminalTab && mirror.value?.stale == true)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Chip(
                label: Text('数据陈旧'),
                visualDensity: VisualDensity.compact,
                avatar: Icon(Icons.history_toggle_off, size: 16),
              ),
            ),
          if (auth.readOnly)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Chip(label: Text('只读'), visualDensity: VisualDensity.compact),
            ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              ref.invalidate(mirrorControllerProvider);
              ref.invalidate(workspacesControllerProvider);
            },
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: [
          const WorkspaceTab(),
          mirror.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (error, _) => _ErrorView(
              error: error,
              onRetry: () => ref.invalidate(mirrorControllerProvider),
            ),
            data: (state) => _MirrorBody(state: state, auth: auth),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          const NavigationDestination(
            icon: Icon(Icons.folder_outlined),
            selectedIcon: Icon(Icons.folder),
            label: '工作区',
          ),
          NavigationDestination(
            icon: Badge(
              isLabelVisible: sessionCount > 0,
              label: Text('$sessionCount'),
              child: const Icon(Icons.terminal_outlined),
            ),
            selectedIcon: const Icon(Icons.terminal),
            label: '终端',
          ),
        ],
      ),
    );
  }
}

class _MirrorBody extends ConsumerWidget {
  const _MirrorBody({required this.state, required this.auth});

  final MirrorState state;
  final AuthReady auth;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.isEmpty) {
      return RefreshIndicator(
        onRefresh: () async => ref.invalidate(mirrorControllerProvider),
        child: ListView(
          children: [
            const SizedBox(height: 120),
            Icon(Icons.desktop_access_disabled,
                size: 48, color: Theme.of(context).colorScheme.outline),
            const SizedBox(height: 12),
            Center(
              child: Text(
                state.snapshotAvailable
                    ? '电脑当前没有在跑的会话'
                    : '电脑未运行或未打开 CC-Panes 前端',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
            const SizedBox(height: 8),
            Center(
              child: Text('右下角 + 可在项目里启动一个',
                  style: Theme.of(context).textTheme.bodySmall),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(mirrorControllerProvider),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 80),
        children: [
          for (final group in state.groups) ...[
            _GroupHeader(group: group),
            for (final card in group.cards)
              MirrorCardTile(
                card: card,
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => TerminalScreen(
                      sessionId: card.sessionId,
                      title: card.title,
                    ),
                  ),
                ),
                onKill: auth.readOnly ? null : () => _kill(context, ref, card),
              ),
          ],
        ],
      ),
    );
  }

  Future<void> _kill(BuildContext context, WidgetRef ref, MirrorCard card) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('关闭会话？'),
        content: Text('将终止「${card.title}」及其整棵进程树。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('关闭')),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    final result =
        await ref.read(mirrorControllerProvider.notifier).killSession(card.sessionId);
    if (!context.mounted) return;
    result.when(
      ok: (_) {},
      err: (failure) {
        final message = failure.kind == FailureKind.readOnly
            ? '远程只读模式已拦截。可在桌面端开启「允许已登录的远程会话写入」。'
            : failure.message;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
      },
    );
  }
}

class _GroupHeader extends StatelessWidget {
  const _GroupHeader({required this.group});

  final MirrorGroup group;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, suffix) = switch (group.kind) {
      MirrorGroupKind.layout =>
        (Icons.dashboard_outlined, group.isCurrentLayout ? ' · 当前' : ''),
      MirrorGroupKind.mobileRemote => (Icons.smartphone, ''),
      MirrorGroupKind.orphan => (Icons.help_outline, ''),
    };
    return Container(
      width: double.infinity,
      color: scheme.surfaceContainerHigh,
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
      child: Row(
        children: [
          Icon(icon, size: 15, color: scheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '${group.title}$suffix',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context)
                  .textTheme
                  .labelLarge
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
          Text('${group.cards.length}',
              style: Theme.of(context)
                  .textTheme
                  .labelMedium
                  ?.copyWith(color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}

class _SyncSubtitle extends StatelessWidget {
  const _SyncSubtitle({this.state});

  final MirrorState? state;

  @override
  Widget build(BuildContext context) {
    final saved = state?.savedAt;
    final text = saved == null
        ? '电脑镜像'
        : '同步于 ${_ago(DateTime.now().toUtc().difference(saved))}';
    return Text(
      text,
      style: Theme.of(context)
          .textTheme
          .bodySmall
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    );
  }

  static String _ago(Duration d) {
    if (d.inSeconds < 10) return '刚刚';
    if (d.inSeconds < 60) return '${d.inSeconds} 秒前';
    if (d.inMinutes < 60) return '${d.inMinutes} 分钟前';
    return '${d.inHours} 小时前';
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('加载失败: $error'),
          const SizedBox(height: 8),
          FilledButton(onPressed: onRetry, child: const Text('重试')),
        ],
      ),
    );
  }
}

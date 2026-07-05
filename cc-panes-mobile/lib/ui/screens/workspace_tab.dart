import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/workspace.dart';
import '../../state/workspaces_controller.dart';
import '../widgets/launch_sheet.dart';
import '../widgets/workspace_actions_sheet.dart';

/// 工作区首页（照 mobile-prototype.html demo）：
/// 指标条 + 工作空间卡片(名/路径/pills/⋯操作) + 项目行(点开→选 Claude/Codex/终端)。
class WorkspaceTab extends ConsumerWidget {
  const WorkspaceTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspaces = ref.watch(workspacesControllerProvider);

    return workspaces.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('加载失败: $error'),
            const SizedBox(height: 8),
            FilledButton(
              onPressed: () => ref.invalidate(workspacesControllerProvider),
              child: const Text('重试'),
            ),
          ],
        ),
      ),
      data: (list) => RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(workspacesControllerProvider);
          ref.invalidate(launchHistoryProvider);
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 80),
          children: [
            _MetricsRow(workspaces: list),
            const SizedBox(height: 8),
            if (list.isEmpty)
              const Padding(
                padding: EdgeInsets.all(40),
                child: Center(child: Text('桌面端还没有工作空间')),
              )
            else
              for (final workspace in list)
                _WorkspaceCard(workspace: workspace),
          ],
        ),
      ),
    );
  }
}

class _MetricsRow extends StatelessWidget {
  const _MetricsRow({required this.workspaces});

  final List<Workspace> workspaces;

  @override
  Widget build(BuildContext context) {
    final projects = workspaces.fold<int>(0, (n, w) => n + w.projectCount);
    final pinned = workspaces.where((w) => w.pinned).length;
    final hidden = workspaces.where((w) => w.hidden).length;
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        _metric(context, '${workspaces.length}', '工作区', scheme.primary),
        _metric(context, '$projects', '项目', scheme.primary),
        _metric(context, '$pinned', '置顶', scheme.primary),
        _metric(context, '$hidden', '隐藏', scheme.tertiary),
      ],
    );
  }

  Widget _metric(BuildContext context, String value, String label, Color color) {
    return Expanded(
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 3),
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        ),
        child: Column(
          children: [
            Text(value,
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: color)),
            const SizedBox(height: 2),
            Text(label,
                style: TextStyle(
                    fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }
}

class _WorkspaceCard extends ConsumerWidget {
  const _WorkspaceCard({required this.workspace});

  final Workspace workspace;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(Icons.folder_outlined, size: 20, color: scheme.onSurfaceVariant),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(workspace.displayName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
                      if (workspace.path != null)
                        Text(workspace.path!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                      const SizedBox(height: 6),
                      Wrap(spacing: 6, runSpacing: 6, children: [
                        if (workspace.pinned) const _Pill(label: '已置顶'),
                        if (workspace.hidden) const _Pill(label: '已隐藏'),
                        _Pill(label: '${workspace.projectCount} 个项目'),
                      ]),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.more_horiz),
                  visualDensity: VisualDensity.compact,
                  tooltip: '工作区操作',
                  onPressed: () => showWorkspaceActions(context, ref, workspace: workspace),
                ),
              ],
            ),
            const SizedBox(height: 8),
            for (final project in workspace.projects)
              _ProjectRow(workspace: workspace, project: project),
          ],
        ),
      ),
    );
  }
}

class _ProjectRow extends ConsumerWidget {
  const _ProjectRow({required this.workspace, required this.project});

  final Workspace workspace;
  final WorkspaceProject project;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(top: 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => showLaunchSheet(context, ref,
            project: project, workspaceName: workspace.name),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.terminal, size: 18, color: scheme.onSurfaceVariant),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(project.displayName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                        Text(project.path,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
                      ],
                    ),
                  ),
                  Icon(Icons.chevron_right, size: 18, color: scheme.outline),
                ],
              ),
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Divider(height: 1),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('点按打开项目终端',
                    style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(label,
          style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
    );
  }
}

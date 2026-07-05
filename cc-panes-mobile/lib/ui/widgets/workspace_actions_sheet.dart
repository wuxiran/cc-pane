import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/workspace.dart';
import 'launch_sheet.dart';

/// 工作区操作 sheet（照 demo 的 ⋯ 菜单）。
/// 「打开终端」已接；置顶/别名/重命名/删除/打开文件夹是桌面端能力，手机暂只提示。
Future<void> showWorkspaceActions(
  BuildContext context,
  WidgetRef ref, {
  required Workspace workspace,
}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (_) => _WorkspaceActions(workspace: workspace),
  );
}

class _WorkspaceActions extends ConsumerWidget {
  const _WorkspaceActions({required this.workspace});

  final Workspace workspace;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final firstProject = workspace.projects.isNotEmpty ? workspace.projects.first : null;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('工作区操作', style: Theme.of(context).textTheme.labelMedium),
            Text(workspace.displayName, style: Theme.of(context).textTheme.titleMedium),
            if (workspace.path != null)
              Text(workspace.path!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 12),
            ListTile(
              leading: const Icon(Icons.terminal),
              title: const Text('打开终端'),
              subtitle: Text(firstProject == null
                  ? '当前工作空间没有项目'
                  : '打开第一个项目 ${firstProject.displayName}'),
              enabled: firstProject != null,
              onTap: firstProject == null
                  ? null
                  : () {
                      Navigator.of(context).pop();
                      showLaunchSheet(context, ref,
                          project: firstProject, workspaceName: workspace.name);
                    },
            ),
            const Divider(),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text(
                '置顶 / 别名 / 重命名 / 删除 / 打开文件夹等请在桌面端操作',
                style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

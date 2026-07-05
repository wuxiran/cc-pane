/// GET /api/workspaces 元素（web/types/workspace.ts 的 Workspace）。
class Workspace {
  const Workspace({
    required this.id,
    required this.name,
    required this.projects,
    this.alias,
    this.path,
    this.pinned = false,
    this.hidden = false,
  });

  final String id;
  final String name;
  final String? alias;
  final String? path;
  final bool pinned;
  final bool hidden;
  final List<WorkspaceProject> projects;

  String get displayName => alias?.isNotEmpty == true ? alias! : name;
  int get projectCount => projects.length;

  factory Workspace.fromJson(Map<String, dynamic> json) => Workspace(
        id: json['id'] as String? ?? json['name'] as String,
        name: json['name'] as String,
        alias: json['alias'] as String?,
        path: json['path'] as String?,
        pinned: json['pinned'] as bool? ?? false,
        hidden: json['hidden'] as bool? ?? false,
        projects: (json['projects'] as List<dynamic>? ?? const [])
            .map((item) => WorkspaceProject.fromJson(item as Map<String, dynamic>))
            .toList(),
      );
}

class WorkspaceProject {
  const WorkspaceProject({required this.id, required this.path, this.alias});

  final String id;
  final String path;
  final String? alias;

  String get displayName =>
      alias?.isNotEmpty == true ? alias! : pathBasename(path);

  factory WorkspaceProject.fromJson(Map<String, dynamic> json) => WorkspaceProject(
        id: json['id'] as String,
        path: json['path'] as String,
        alias: json['alias'] as String?,
      );
}

/// 项目显示名：路径最后一段（Windows 反斜杠 / POSIX 正斜杠都兼容）。
String pathBasename(String path) {
  final parts = path.split(RegExp(r'[/\\]')).where((s) => s.isNotEmpty);
  return parts.isEmpty ? path : parts.last;
}

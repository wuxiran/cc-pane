import '../core/result.dart';
import '../models/layout_snapshot.dart';
import 'api_client.dart';

/// 桌面端 0.12.11 起按布局空间保存快照，单布局下固定为这个 profileId
/// （web/hooks/useSessionLayoutPersistence.ts::currentLayoutProfileId，
/// scope `workspace:default` 转义后的结果）。
const scopedLayoutProfileId = 'layout-scope.workspace.default';

/// 0.12.11 之前桌面端写的 profileId；升级后不再更新，只留作旧版桌面兼容。
const legacyLayoutProfileId = 'default';

/// GET /api/layout-snapshot/{profileId} —— 电脑当前布局镜像。
class LayoutSnapshotApi {
  const LayoutSnapshotApi(this._client);

  final ApiClient _client;

  /// 返回快照；桌面前端从未落库时后端可能返回空 body / null，此时得到 null。
  Future<Result<LayoutSnapshot?>> fetch({required String profileId}) => guard(
        () => _client.dio.get<dynamic>('/api/layout-snapshot/$profileId'),
        (response) {
          final data = response.data;
          if (data is! Map<String, dynamic>) return null;
          return LayoutSnapshot.fromJson(data);
        },
      );

  /// 电脑当前布局：新旧两个 profileId 都读，取较新的一份。
  /// 只读旧 id 会拿到升级前停更的陈旧快照，布局里的会话早已关闭。
  Future<Result<LayoutSnapshot?>> fetchCurrent() async {
    final results = await Future.wait([
      fetch(profileId: scopedLayoutProfileId),
      fetch(profileId: legacyLayoutProfileId),
    ]);
    return pickCurrentSnapshot(results[0], results[1]);
  }
}

/// 在新旧两份快照结果里选当前生效的一份（纯函数，便于单测）：
/// 两份都有取 savedAt 较新者；只有一份成功就用它；都失败返回新 id 的错误。
Result<LayoutSnapshot?> pickCurrentSnapshot(
  Result<LayoutSnapshot?> scoped,
  Result<LayoutSnapshot?> legacy,
) {
  if (scoped is Err<LayoutSnapshot?> && legacy is Err<LayoutSnapshot?>) {
    return scoped;
  }
  final a = scoped.valueOrNull;
  final b = legacy.valueOrNull;
  if (a == null) return legacy is Err<LayoutSnapshot?> ? scoped : Ok(b);
  if (b == null) return Ok(a);
  final aTime = a.savedAtTime;
  final bTime = b.savedAtTime;
  if (aTime == null || bTime == null) return Ok(aTime == null ? b : a);
  return Ok(bTime.isAfter(aTime) ? b : a);
}

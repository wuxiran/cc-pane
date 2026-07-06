import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/layout_snapshot_api.dart';
import '../api/sessions_api.dart';
import '../core/config.dart';
import '../core/result.dart';
import '../models/layout_snapshot.dart';
import '../models/saved_session.dart';
import '../models/session_info.dart';
import '../models/workspace.dart' show pathBasename;
import 'auth_controller.dart';

enum MirrorGroupKind { layout, mobileRemote, orphan }

/// 一张镜像卡：一个活会话 = 布局里的一个终端 leaf / 手机远程会话 / 孤儿会话。
class MirrorCard {
  const MirrorCard({
    required this.sessionId,
    required this.title,
    required this.info,
    this.projectName,
    this.cliTool,
    this.paneOrdinal,
    this.isActiveLeaf = false,
    this.orphanReason,
  });

  final String sessionId;
  final String title;
  final SessionInfo info;
  final String? projectName;
  final String? cliTool;
  final int? paneOrdinal;
  final bool isActiveLeaf;
  final String? orphanReason;
}

class MirrorGroup {
  const MirrorGroup({
    required this.kind,
    required this.title,
    required this.cards,
    this.layoutId,
    this.isCurrentLayout = false,
  });

  final MirrorGroupKind kind;
  final String title;
  final List<MirrorCard> cards;
  final String? layoutId;
  final bool isCurrentLayout;
}

/// 镜像视图：分组的会话卡 + 陈旧标记 + 元信息。
class MirrorState {
  const MirrorState({
    required this.groups,
    required this.snapshotAvailable,
    required this.stale,
    this.savedAt,
    this.workspaceName,
    this.desktopProjectPaths = const {},
    this.mobileProjectPaths = const {},
  });

  final List<MirrorGroup> groups;

  /// 电脑布局里有活会话的项目路径（规范化）——用于工作区 tab 标「电脑在跑」。
  final Set<String> desktopProjectPaths;

  /// 手机自己 launch 的项目路径（规范化）——用于工作区 tab 标「手机打开」。
  final Set<String> mobileProjectPaths;

  /// 桌面前端是否落过快照（false = 电脑未运行/未开前端）。
  final bool snapshotAvailable;

  /// 快照过旧（savedAt 超阈值）——数据可能不反映电脑当前状态。
  final bool stale;
  final DateTime? savedAt;
  final String? workspaceName;

  bool get isEmpty => groups.isEmpty;
}

/// 合成镜像状态（纯函数，便于单测）。
///
/// - 布局组：collectSessionCards join /api/sessions 活会话；当前布局优先。
/// - 手机远程会话组：localMeta 记录的手机 launch 会话（在 /api/sessions、不在布局）。
/// - 未归入布局组（孤儿）：/api/sessions 有、不在布局、不在 localMeta，过滤 exited/过旧。
MirrorState buildMirrorState({
  required LayoutSnapshot? snapshot,
  required List<SessionInfo> running,
  required Map<String, SavedSession> localMeta,
  required DateTime now,
}) {
  final runningById = {for (final s in running) s.sessionId: s};
  final cards = snapshot == null ? const <SessionCard>[] : collectSessionCards(snapshot);
  final inLayout = <String>{};
  final desktopProjectPaths = <String>{};
  final mobileProjectPaths = <String>{};

  // 按布局分组，保留 collectSessionCards 的顺序，当前布局提前。
  final layoutOrder = <String>[];
  final byLayout = <String, List<MirrorCard>>{};
  final layoutMeta = <String, ({String name, bool current})>{};
  for (final card in cards) {
    final info = runningById[card.sessionId];
    if (info == null) continue; // 快照有但已不在活会话（刚关闭）→ 跳过
    inLayout.add(card.sessionId);
    if (card.projectPath.isNotEmpty) {
      desktopProjectPaths.add(normalizeProjectPath(card.projectPath));
    }
    if (!byLayout.containsKey(card.layoutId)) {
      byLayout[card.layoutId] = [];
      layoutOrder.add(card.layoutId);
      layoutMeta[card.layoutId] = (name: card.layoutName, current: card.isCurrentLayout);
    }
    byLayout[card.layoutId]!.add(MirrorCard(
      sessionId: card.sessionId,
      title: card.title,
      info: info,
      projectName: card.projectName,
      cliTool: card.cliTool,
      paneOrdinal: card.paneOrdinal,
      isActiveLeaf: card.isActiveLeaf,
    ));
  }
  layoutOrder.sort((a, b) {
    final ca = layoutMeta[a]!.current, cb = layoutMeta[b]!.current;
    if (ca != cb) return ca ? -1 : 1;
    return 0; // 其余保持插入顺序
  });

  final groups = <MirrorGroup>[
    for (final id in layoutOrder)
      MirrorGroup(
        kind: MirrorGroupKind.layout,
        title: layoutMeta[id]!.name,
        layoutId: id,
        isCurrentLayout: layoutMeta[id]!.current,
        cards: byLayout[id]!,
      ),
  ];

  // 孤儿 + 手机远程
  final mobileCards = <MirrorCard>[];
  final orphanCards = <MirrorCard>[];
  for (final info in running) {
    if (inLayout.contains(info.sessionId)) continue;
    final meta = localMeta[info.sessionId];
    if (meta != null) {
      if (meta.projectPath.isNotEmpty) {
        mobileProjectPaths.add(normalizeProjectPath(meta.projectPath));
      }
      mobileCards.add(MirrorCard(
        sessionId: info.sessionId,
        title: meta.displayTitle,
        info: info,
        projectName: pathBasename(meta.projectPath),
        cliTool: meta.cliTool,
      ));
      continue;
    }
    // 非手机启动的孤儿：过滤已退出 / 过旧（陈旧缺失、僵尸残留）
    if (info.exited) continue;
    final age = now.millisecondsSinceEpoch - info.updatedAt;
    if (age > AppConfig.orphanStale.inMilliseconds) continue;
    orphanCards.add(MirrorCard(
      sessionId: info.sessionId,
      title: info.sessionId,
      info: info,
      orphanReason: '未在电脑布局中',
    ));
  }
  if (mobileCards.isNotEmpty) {
    groups.add(MirrorGroup(
      kind: MirrorGroupKind.mobileRemote,
      title: '手机远程会话',
      cards: mobileCards,
    ));
  }
  if (orphanCards.isNotEmpty) {
    groups.add(MirrorGroup(
      kind: MirrorGroupKind.orphan,
      title: '未归入布局',
      cards: orphanCards,
    ));
  }

  final savedAt = snapshot?.savedAtTime;
  final stale = savedAt != null &&
      now.toUtc().difference(savedAt) > AppConfig.snapshotStale;

  return MirrorState(
    groups: groups,
    snapshotAvailable: snapshot != null,
    stale: stale,
    savedAt: savedAt,
    workspaceName: snapshot?.workspaceName,
    desktopProjectPaths: desktopProjectPaths,
    mobileProjectPaths: mobileProjectPaths,
  );
}

/// 镜像控制器：5s 轮询 layout-snapshot + /api/sessions，合成镜像视图。
class MirrorController extends AsyncNotifier<MirrorState> {
  Timer? _timer;

  /// 手机自己 launch 的会话元数据（sessionId → 项目/CLI），进程内缓存。
  final Map<String, SavedSession> _localMeta = {};

  @override
  Future<MirrorState> build() async {
    final auth = await ref.watch(authControllerProvider.future);
    if (auth is! AuthReady) {
      return const MirrorState(groups: [], snapshotAvailable: false, stale: false);
    }
    final snapshotApi = LayoutSnapshotApi(auth.client);
    final sessionsApi = SessionsApi(auth.client);
    _timer?.cancel();
    _timer = Timer.periodic(
        AppConfig.sessionPollInterval, (_) => _refresh(snapshotApi, sessionsApi));
    ref.onDispose(() => _timer?.cancel());
    return _fetch(snapshotApi, sessionsApi);
  }

  Future<MirrorState> _fetch(LayoutSnapshotApi snapshotApi, SessionsApi sessionsApi) async {
    final snapResult = await snapshotApi.fetch();
    final running = (await sessionsApi.list()).valueOrNull ?? const <SessionInfo>[];
    if (snapResult is Err<LayoutSnapshot?>) {
      if (snapResult.failure.kind == FailureKind.unauthorized) {
        unawaited(ref.read(authControllerProvider.notifier).reconnect());
      }
      throw snapResult.failure;
    }
    return buildMirrorState(
      snapshot: snapResult.valueOrNull,
      running: running,
      localMeta: _localMeta,
      now: DateTime.now(),
    );
  }

  Future<void> _refresh(LayoutSnapshotApi snapshotApi, SessionsApi sessionsApi) async {
    try {
      state = AsyncData(await _fetch(snapshotApi, sessionsApi));
    } on ApiFailure catch (failure) {
      if (state.value == null) state = AsyncError(failure, StackTrace.current);
    }
  }

  ({LayoutSnapshotApi snapshot, SessionsApi sessions})? _apis() {
    final auth = ref.read(authControllerProvider).value;
    if (auth is! AuthReady) return null;
    return (snapshot: LayoutSnapshotApi(auth.client), sessions: SessionsApi(auth.client));
  }

  /// 手机在项目里启动会话 → 记入 localMeta（进「手机远程会话」组）。
  Future<Result<String>> launch({
    required String projectPath,
    String cliTool = 'none',
    String? workspaceName,
    String? resumeId,
  }) async {
    final apis = _apis();
    if (apis == null) return const Err(ApiFailure(FailureKind.local, '未连接服务器'));
    final result = await apis.sessions.create(
      projectPath: projectPath,
      cliTool: cliTool,
      launchClaude: cliTool != 'none',
      workspaceName: workspaceName,
      resumeId: resumeId,
    );
    if (result is Ok<String>) {
      _localMeta[result.value] = SavedSession(
        sessionId: result.value,
        projectPath: projectPath,
        workspaceName: workspaceName,
        cliTool: cliTool,
        resumeId: resumeId,
      );
      await _refresh(apis.snapshot, apis.sessions);
    }
    return result;
  }

  Future<Result<void>> killSession(String sessionId) async {
    final apis = _apis();
    if (apis == null) return const Err(ApiFailure(FailureKind.local, '未连接服务器'));
    final result = await apis.sessions.kill(sessionId);
    _localMeta.remove(sessionId);
    await _refresh(apis.snapshot, apis.sessions);
    return result;
  }
}

final mirrorControllerProvider =
    AsyncNotifierProvider<MirrorController, MirrorState>(MirrorController.new);

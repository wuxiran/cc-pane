import 'package:flutter_test/flutter_test.dart';

import 'package:cc_panes_mobile/api/layout_snapshot_api.dart';
import 'package:cc_panes_mobile/core/result.dart';
import 'package:cc_panes_mobile/models/layout_snapshot.dart';

LayoutSnapshot _snap(String? savedAt, String name) => LayoutSnapshot(
      currentLayoutId: null,
      layouts: const [],
      savedAt: savedAt,
      workspaceName: name,
    );

const _network = ApiFailure(FailureKind.network, 'down');

void main() {
  group('pickCurrentSnapshot', () {
    test('新 id 较新时取新 id（桌面 0.12.11+ 旧 id 已停更）', () {
      final picked = pickCurrentSnapshot(
        Ok(_snap('2026-09-29T04:34:45Z', 'scoped')),
        Ok(_snap('2026-09-06T09:39:40Z', 'legacy')),
      );
      expect(picked.valueOrNull?.workspaceName, 'scoped');
    });

    test('旧版桌面只写旧 id 时回退到旧 id', () {
      final picked = pickCurrentSnapshot(
        const Ok(null),
        Ok(_snap('2026-09-06T09:39:40Z', 'legacy')),
      );
      expect(picked.valueOrNull?.workspaceName, 'legacy');
    });

    test('旧 id 更新时取旧 id', () {
      final picked = pickCurrentSnapshot(
        Ok(_snap('2026-09-01T00:00:00Z', 'scoped')),
        Ok(_snap('2026-09-02T00:00:00Z', 'legacy')),
      );
      expect(picked.valueOrNull?.workspaceName, 'legacy');
    });

    test('一份失败时使用另一份', () {
      final picked = pickCurrentSnapshot(
        const Err(_network),
        Ok(_snap('2026-09-06T09:39:40Z', 'legacy')),
      );
      expect(picked.valueOrNull?.workspaceName, 'legacy');
    });

    test('新 id 为空、旧 id 失败时返回空快照而非错误', () {
      final picked = pickCurrentSnapshot(const Ok(null), const Err(_network));
      expect(picked, isA<Ok<LayoutSnapshot?>>());
      expect(picked.valueOrNull, isNull);
    });

    test('两份都失败时返回错误', () {
      final picked = pickCurrentSnapshot(const Err(_network), const Err(_network));
      expect(picked.failureOrNull?.kind, FailureKind.network);
    });
  });
}

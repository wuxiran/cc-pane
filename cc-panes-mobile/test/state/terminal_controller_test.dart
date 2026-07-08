import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cc_panes_mobile/state/terminal_controller.dart';

void main() {
  group('RefitPolicy', () {
    test('默认不跟随 metrics 变化（共享 PTY 不被动 resize）', () {
      fakeAsync((async) {
        final policy = RefitPolicy();
        var fired = 0;

        policy.onMetricsChanged(() => fired++);
        async.elapse(const Duration(seconds: 1));

        expect(policy.userFitted, isFalse);
        expect(fired, 0);
      });
    });

    test('手动适配后 metrics 变化经去抖触发一次', () {
      fakeAsync((async) {
        final policy = RefitPolicy(debounce: const Duration(milliseconds: 300));
        var fired = 0;

        policy.markUserFitted();
        policy.onMetricsChanged(() => fired++);
        async.elapse(const Duration(milliseconds: 100));
        expect(fired, 0);

        async.elapse(const Duration(milliseconds: 250));
        expect(fired, 1);
      });
    });

    test('去抖窗口内连续变化只触发最后一次', () {
      fakeAsync((async) {
        final policy = RefitPolicy(debounce: const Duration(milliseconds: 300));
        var fired = 0;

        policy.markUserFitted();
        policy.onMetricsChanged(() => fired++);
        async.elapse(const Duration(milliseconds: 100));
        policy.onMetricsChanged(() => fired++);
        async.elapse(const Duration(milliseconds: 100));
        policy.onMetricsChanged(() => fired++);

        async.elapse(const Duration(seconds: 1));
        expect(fired, 1);
      });
    });

    test('dispose 取消挂起的去抖回调', () {
      fakeAsync((async) {
        final policy = RefitPolicy();
        var fired = 0;

        policy.markUserFitted();
        policy.onMetricsChanged(() => fired++);
        policy.dispose();

        async.elapse(const Duration(seconds: 1));
        expect(fired, 0);
      });
    });
  });
}

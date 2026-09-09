import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:cc_panes_mobile/api/api_client.dart';
import 'package:cc_panes_mobile/api/terminal_socket.dart';
import 'package:cc_panes_mobile/core/result.dart';
import 'package:cc_panes_mobile/models/auth_status.dart';
import 'package:cc_panes_mobile/state/auth_controller.dart';
import 'package:cc_panes_mobile/state/terminal_controller.dart';

class _Client extends Mock implements ApiClient {}

class _Socket extends Fake implements TerminalSocket {
  final stream = StreamController<TerminalEvent>.broadcast(sync: true);
  final inputs = <String>[];
  final sizes = <(int, int)>[];
  int closes = 0;
  Completer<void>? closeGate;
  @override
  Stream<TerminalEvent> get events => stream.stream;
  @override
  void sendInput(String data) => inputs.add(data);
  @override
  void sendResize(int cols, int rows) => sizes.add((cols, rows));
  @override
  Future<void> close() {
    closes++;
    return closeGate?.future ?? Future<void>.value();
  }
}

AuthReady _auth({bool readOnly = false}) => AuthReady(
    client: _Client(),
    status: AuthStatus(
      authRequired: true,
      authenticated: true,
      username: 'test',
      passwordConfigured: true,
      readOnly: readOnly,
      remoteAuthenticatedWrite: !readOnly,
    ));

void main() {
  test('large snapshots are prepared off-screen without splitting emoji', () {
    fakeAsync((time) {
      final data = '${List.filled(32767, 'x').join()}🌟';
      final controller = TerminalSessionController(
          sessionId: 's1',
          auth: _auth(),
          loadSnapshot: () async => Ok(data),
          connectSocket: () async => _Socket());
      final original = controller.terminal;
      time.flushMicrotasks();
      expect(controller.terminal, same(original));
      expect(controller.phase, TerminalPhase.connecting);
      time.elapse(Duration.zero);
      expect(controller.phase, TerminalPhase.connected);
      expect(controller.terminal, isNot(same(original)));
      expect(controller.terminal.buffer.getText(), contains('🌟'));
      controller.dispose();
    });
  });

  test(
      'reconnect replaces old replay and ignores duplicate disconnect callbacks',
      () {
    fakeAsync((time) {
      final sockets = [_Socket(), _Socket()];
      var opens = 0;
      var snapshots = 0;
      final controller = TerminalSessionController(
        sessionId: 's1',
        auth: _auth(),
        loadSnapshot: () async => Ok(++snapshots == 1 ? 'OLD' : 'NEW'),
        connectSocket: () async => sockets[opens++],
      );
      time.flushMicrotasks();
      final original = controller.terminal;
      sockets[0].closeGate = Completer<void>();
      sockets[0].stream.addError(StateError('offline'));
      sockets[0].stream.close();
      expect(controller.phase, TerminalPhase.reconnecting);
      expect(controller.terminal, same(original));
      time.elapse(const Duration(seconds: 1));
      expect(opens, 2);
      expect(controller.phase, TerminalPhase.connected);
      expect(controller.terminal.buffer.getText(), contains('NEW'));
      expect(controller.terminal.buffer.getText(), isNot(contains('OLD')));
      controller.sendSequence('yes\r');
      expect(sockets[1].inputs, ['yes\r']);
      time.elapse(const Duration(minutes: 1));
      expect(opens, 2);
      controller.dispose();
    });
  });

  test('a late snapshot cannot replace the newer connection', () {
    fakeAsync((time) {
      final old = Completer<Result<String>>();
      var reads = 0;
      var opens = 0;
      final controller = TerminalSessionController(
        sessionId: 's1',
        auth: _auth(),
        loadSnapshot: () =>
            ++reads == 1 ? old.future : Future.value(const Ok('CURRENT')),
        connectSocket: () async {
          opens++;
          return _Socket();
        },
      );
      unawaited(controller.reconnect());
      time.flushMicrotasks();
      old.complete(const Ok('STALE'));
      time.flushMicrotasks();
      expect(opens, 1);
      expect(controller.terminal.buffer.getText(), contains('CURRENT'));
      expect(controller.terminal.buffer.getText(), isNot(contains('STALE')));
      controller.dispose();
    });
  });

  test('a late socket is closed after a new connection wins', () {
    fakeAsync((time) {
      final late = Completer<TerminalSocket>();
      final oldSocket = _Socket();
      final currentSocket = _Socket();
      var opens = 0;
      final controller = TerminalSessionController(
        sessionId: 's1',
        auth: _auth(),
        loadSnapshot: () async => const Ok('READY'),
        connectSocket: () =>
            ++opens == 1 ? late.future : Future.value(currentSocket),
      );
      time.flushMicrotasks();
      unawaited(controller.reconnect());
      time.flushMicrotasks();
      late.complete(oldSocket);
      time.flushMicrotasks();
      expect(oldSocket.closes, 1);
      controller.sendSequence('a');
      expect(currentSocket.inputs, ['a']);
      expect(oldSocket.inputs, isEmpty);
      controller.dispose();
    });
  });

  test('suspends retry while backgrounded and reconnects on resume', () {
    fakeAsync((time) {
      var opens = 0;
      final first = _Socket();
      final controller = TerminalSessionController(
        sessionId: 's1',
        auth: _auth(),
        loadSnapshot: () async => const Ok('VISIBLE'),
        connectSocket: () async {
          opens++;
          return opens == 1 ? first : _Socket();
        },
      );
      time.flushMicrotasks();
      final original = controller.terminal;
      controller.suspend();
      time.elapse(const Duration(minutes: 2));
      expect(opens, 1);
      expect(first.closes, 1);
      expect(controller.terminal, same(original));
      expect(controller.canWrite, isFalse);
      controller.resume();
      time.flushMicrotasks();
      expect(opens, 2);
      expect(controller.canWrite, isTrue);
      controller.dispose();
    });
  });

  test('read-only clients cannot write or resize the shared terminal', () {
    fakeAsync((time) {
      final socket = _Socket();
      final controller = TerminalSessionController(
          sessionId: 's1',
          auth: _auth(readOnly: true),
          loadSnapshot: () async => const Ok('READY'),
          connectSocket: () async => socket);
      time.flushMicrotasks();
      controller.sendSequence('rm');
      controller.toggleCtrl();
      expect(controller.resizeToView(), isFalse);
      expect(controller.ctrlLatched, isFalse);
      expect(socket.inputs, isEmpty);
      expect(socket.sizes, isEmpty);
      controller.dispose();
    });
  });

  test('exit is terminal and is not retried after foregrounding', () {
    fakeAsync((time) {
      final socket = _Socket();
      var opens = 0;
      final controller = TerminalSessionController(
          sessionId: 's1',
          auth: _auth(),
          loadSnapshot: () async => const Ok('DONE'),
          connectSocket: () async {
            opens++;
            return socket;
          });
      time.flushMicrotasks();
      socket.stream.add(const TerminalExit(0));
      controller.suspend();
      controller.resume();
      time.elapse(const Duration(minutes: 1));
      expect(opens, 1);
      expect(controller.phase, TerminalPhase.exited);
      controller.dispose();
    });
  });

  test('network retries back off and authentication failures stop retrying',
      () {
    fakeAsync((time) {
      var reads = 0;
      final controller = TerminalSessionController(
          sessionId: 's1',
          auth: _auth(),
          loadSnapshot: () async => ++reads < 3
              ? const Err(ApiFailure(FailureKind.network, 'offline'))
              : const Err(
                  ApiFailure(FailureKind.unauthorized, 'login required')),
          connectSocket: () async => _Socket());
      time.flushMicrotasks();
      time.elapse(const Duration(seconds: 1));
      expect(reads, 2);
      time.elapse(const Duration(seconds: 2));
      expect(controller.phase, TerminalPhase.error);
      time.elapse(const Duration(minutes: 1));
      expect(reads, 3);
      controller.dispose();
    });
  });

  test('dispose invalidates an in-flight snapshot', () {
    fakeAsync((time) {
      final snapshot = Completer<Result<String>>();
      var opens = 0;
      final controller = TerminalSessionController(
          sessionId: 's1',
          auth: _auth(),
          loadSnapshot: () => snapshot.future,
          connectSocket: () async {
            opens++;
            return _Socket();
          });
      controller.dispose();
      snapshot.complete(const Ok('LATE'));
      time.elapse(const Duration(minutes: 1));
      expect(opens, 0);
    });
  });
}

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:xterm/xterm.dart';

import '../api/sessions_api.dart';
import '../api/terminal_socket.dart';
import '../core/result.dart';
import 'auth_controller.dart';

enum TerminalPhase {
  connecting,
  reconnecting,
  connected,
  suspended,
  exited,
  error
}

Future<TerminalSocket> _connectSocket(AuthReady auth, String sessionId) async =>
    TerminalSocket.connect(
      baseUrl: auth.client.profile.baseUrl,
      sessionId: sessionId,
      cookieHeader: await auth.client.sessionCookieHeader(),
    );

/// 尺寸变化自动再适配策略：共享 PTY 默认不动（避免破坏桌面端渲染），
/// 只有用户手动适配过（opt-in）后才跟随 metrics 变化下发 resize，
/// 并做去抖合并——conpty 每次 resize 都整屏重绘，高频下发会留残行。
class RefitPolicy {
  RefitPolicy({this.debounce = const Duration(milliseconds: 300)});

  final Duration debounce;
  bool _userFitted = false;
  Timer? _timer;

  bool get userFitted => _userFitted;

  void markUserFitted() => _userFitted = true;

  /// metrics（旋转/键盘）变化时调用；未手动适配过则忽略。
  void onMetricsChanged(void Function() fire) {
    if (!_userFitted) return;
    _timer?.cancel();
    _timer = Timer(debounce, fire);
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
  }
}

/// 单个会话的终端状态机：
/// snapshot 初始化 → 连 WS 收输出流 → 键盘输入经 WS input 回传。
/// Enter 发 \r（CC-Panes PTY 约定，xterm 键盘默认即 CR）。
/// 重连与后台恢复使用独立世代，迟到的旧连接不能覆盖当前会话。
class TerminalSessionController extends ChangeNotifier {
  TerminalSessionController({
    required this.sessionId,
    required AuthReady auth,
    Future<Result<String>> Function()? loadSnapshot,
    Future<TerminalSocket> Function()? connectSocket,
  })  : _auth = auth,
        _loadSnapshot = loadSnapshot ??
            (() => SessionsApi(auth.client).snapshot(sessionId)),
        _openSocket = connectSocket ?? (() => _connectSocket(auth, sessionId)) {
    terminal.onOutput = _handleUserInput;
    unawaited(reconnect());
  }

  final String sessionId;
  final AuthReady _auth;
  final Future<Result<String>> Function() _loadSnapshot;
  final Future<TerminalSocket> Function() _openSocket;
  Terminal _terminal = Terminal(maxLines: 5000);
  Terminal get terminal => _terminal;

  TerminalPhase _phase = TerminalPhase.connecting;
  TerminalPhase get phase => _phase;
  int? exitCode;
  String? errorMessage;

  /// Ctrl 粘滞：点亮后下一个字母键转为 ctrl-code。
  bool ctrlLatched = false;

  TerminalSocket? _socket;
  StreamSubscription<TerminalEvent>? _sub;
  final RefitPolicy _refitPolicy = RefitPolicy();
  bool _disposed = false;
  bool _suspended = false;
  int _generation = 0;
  int _retryAttempt = 0;
  Timer? _retryTimer;

  bool get canWrite =>
      !_auth.readOnly &&
      !_disposed &&
      !_suspended &&
      _phase == TerminalPhase.connected;

  bool _isCurrent(int generation) =>
      !_disposed && !_suspended && generation == _generation;

  Future<void> reconnect() async {
    if (_disposed || _suspended || _phase == TerminalPhase.exited) return;
    final generation = ++_generation;
    _retryTimer?.cancel();
    _releaseConnection();
    _setPhase(_retryAttempt == 0
        ? TerminalPhase.connecting
        : TerminalPhase.reconnecting);
    try {
      final snapshot = await _loadSnapshot();
      if (!_isCurrent(generation)) return;
      final failure = snapshot.failureOrNull;
      if (failure != null) {
        if (failure.kind == FailureKind.network) {
          _retry(generation);
          return;
        }
        _setPhase(TerminalPhase.error, message: failure.message);
        return;
      }
      final restored =
          await _restoreSnapshot(snapshot.valueOrNull ?? '', generation);
      if (restored == null || !_isCurrent(generation)) return;
      final socket = await _openSocket();
      if (!_isCurrent(generation)) {
        _closeSocket(socket);
        return;
      }
      _socket = socket;
      _terminal.onOutput = null;
      _terminal = restored..onOutput = _handleUserInput;
      _sub = socket.events.listen(
        (event) => _handleEvent(generation, event),
        onError: (Object _) => _retry(generation),
        onDone: () => _retry(generation),
      );
      _retryAttempt = 0;
      _setPhase(TerminalPhase.connected);
    } on Object {
      _retry(generation);
    }
  }

  Future<Terminal?> _restoreSnapshot(String data, int generation) async {
    final restored = Terminal(maxLines: 5000)
      ..resize(terminal.viewWidth, terminal.viewHeight);
    for (var start = 0; start < data.length;) {
      if (!_isCurrent(generation)) return null;
      var end = (start + 32768).clamp(0, data.length);
      if (end < data.length &&
          data.codeUnitAt(end - 1) >= 0xd800 &&
          data.codeUnitAt(end - 1) <= 0xdbff) {
        end--;
      }
      restored.write(data.substring(start, end));
      start = end;
      if (start < data.length) await Future<void>.delayed(Duration.zero);
    }
    return restored;
  }

  void _handleEvent(int generation, TerminalEvent event) {
    if (!_isCurrent(generation)) return;
    switch (event) {
      case TerminalOutput(data: final data):
        terminal.write(data);
      case TerminalExit(exitCode: final code):
        exitCode = code;
        _setPhase(TerminalPhase.exited);
        ++_generation;
        _releaseConnection();
      case TerminalDesync():
        _retry(generation);
    }
  }

  void _retry(int generation) {
    if (!_isCurrent(generation) || _phase == TerminalPhase.exited) return;
    ++_generation;
    _releaseConnection();
    final seconds = (1 << _retryAttempt.clamp(0, 5)).clamp(1, 30);
    _retryAttempt++;
    _setPhase(TerminalPhase.reconnecting, message: '连接中断，正在重试…');
    _retryTimer?.cancel();
    _retryTimer =
        Timer(Duration(seconds: seconds), () => unawaited(reconnect()));
  }

  void suspend() {
    if (_disposed || _suspended) return;
    _suspended = true;
    ++_generation;
    _retryTimer?.cancel();
    _releaseConnection();
    if (_phase != TerminalPhase.exited) _setPhase(TerminalPhase.suspended);
  }

  void resume() {
    if (_disposed || !_suspended) return;
    _suspended = false;
    _retryAttempt = 0;
    unawaited(reconnect());
  }

  void _releaseConnection() {
    final sub = _sub;
    final socket = _socket;
    _sub = null;
    _socket = null;
    if (sub != null) {
      unawaited(sub.cancel().catchError((Object error) =>
          debugPrint('Terminal subscription cleanup: ${error.runtimeType}')));
    }
    if (socket != null) _closeSocket(socket);
  }

  void _closeSocket(TerminalSocket socket) {
    unawaited(socket.close().catchError((Object error) =>
        debugPrint('Terminal socket cleanup: ${error.runtimeType}')));
  }

  void _handleUserInput(String data) {
    if (!canWrite) return;
    var out = data;
    if (ctrlLatched && data.length == 1) {
      final code = data.toLowerCase().codeUnitAt(0);
      if (code >= 0x61 && code <= 0x7a) {
        out = String.fromCharCode(code - 0x60);
      }
      ctrlLatched = false;
      notifyListeners();
    }
    _socket?.sendInput(out);
  }

  /// 快捷键条直发原始序列。
  void sendSequence(String sequence) => _handleUserInput(sequence);

  void toggleCtrl() {
    if (!canWrite) return;
    ctrlLatched = !ctrlLatched;
    notifyListeners();
  }

  /// 「跟随手机尺寸」：把共享 PTY 调整为当前 TerminalView 的 cols/rows。
  /// 仅由用户在 AppBar 手动触发（默认不 resize 共享 PTY，避免破坏桌面端渲染）；
  /// 手动适配过后旋转/键盘变化会经 [onViewMetricsChanged] 自动再适配。
  bool resizeToView() {
    if (!canWrite) return false;
    _refitPolicy.markUserFitted();
    final cols = terminal.viewWidth;
    final rows = terminal.viewHeight;
    if (cols > 0 && rows > 0) {
      _socket?.sendResize(cols, rows);
      return true;
    }
    return false;
  }

  /// 屏幕 metrics 变化（旋转/软键盘）回调；仅用户手动适配过才生效。
  void onViewMetricsChanged() {
    _refitPolicy.onMetricsChanged(() {
      if (_disposed || _phase != TerminalPhase.connected) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_disposed || _phase != TerminalPhase.connected) return;
        resizeToView();
      });
    });
  }

  void _setPhase(TerminalPhase next, {String? message}) {
    if (_disposed) return;
    _phase = next;
    errorMessage = message;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    ++_generation;
    _retryTimer?.cancel();
    _refitPolicy.dispose();
    _releaseConnection();
    terminal.onOutput = null;
    super.dispose();
  }
}

/// per-session controller；离开页面自动销毁连接及重试定时器。
final terminalControllerProvider = ChangeNotifierProvider.autoDispose
    .family<TerminalSessionController, String>((ref, sessionId) {
  final auth = ref.watch(authControllerProvider).value;
  if (auth is! AuthReady) {
    throw const ApiFailure(FailureKind.local, '未连接服务器');
  }
  return TerminalSessionController(sessionId: sessionId, auth: auth);
});

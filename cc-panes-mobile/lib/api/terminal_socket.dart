import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// 服务器 → 客户端的终端帧。
sealed class TerminalEvent {
  const TerminalEvent();
}

final class TerminalOutput extends TerminalEvent {
  const TerminalOutput(this.data);
  final String data;
}

final class TerminalExit extends TerminalEvent {
  const TerminalExit(this.exitCode);
  final int? exitCode;
}

final class TerminalDesync extends TerminalEvent {
  const TerminalDesync();
}

/// /ws/{sessionId} 终端流：文本 JSON 帧。
/// 下行 {"type":"output","data"} / {"type":"exit","exitCode"}；
/// 上行 {"type":"input","data"} / {"type":"resize","cols","rows"}。
/// 握手带 Cookie（ccp_web_session），与 REST 同一会话。
class TerminalSocket {
  TerminalSocket._(this._channel);

  final WebSocketChannel _channel;

  static Future<TerminalSocket> connect({
    required String baseUrl,
    required String sessionId,
    String? cookieHeader,
  }) async {
    final base = Uri.parse(baseUrl);
    final wsUri = base.replace(
      scheme: base.scheme == 'https' ? 'wss' : 'ws',
      path: '/ws/$sessionId',
    );
    final channel = IOWebSocketChannel.connect(
      wsUri,
      headers: {if (cookieHeader != null) 'Cookie': cookieHeader},
      connectTimeout: const Duration(seconds: 10),
    );
    await channel.ready;
    return TerminalSocket._(channel);
  }

  Stream<TerminalEvent> get events => _channel.stream
      .map(_parse)
      .where((event) => event != null)
      .cast<TerminalEvent>();

  void sendInput(String data) {
    _channel.sink.add(jsonEncode({'type': 'input', 'data': data}));
  }

  void sendResize(int cols, int rows) {
    _channel.sink
        .add(jsonEncode({'type': 'resize', 'cols': cols, 'rows': rows}));
  }

  Future<void> close() => _channel.sink.close();

  static TerminalEvent? _parse(dynamic message) {
    if (message is! String) return null;
    final Object? decoded;
    try {
      decoded = jsonDecode(message);
    } on FormatException {
      return null;
    }
    if (decoded is! Map<String, dynamic>) return null;
    return switch (decoded['type']) {
      'output' => TerminalOutput(decoded['data'] as String? ?? ''),
      'exit' => TerminalExit((decoded['exitCode'] as num?)?.toInt()),
      'desync' => const TerminalDesync(),
      _ => null,
    };
  }
}

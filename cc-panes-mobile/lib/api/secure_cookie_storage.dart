import 'dart:convert';

import 'package:cookie_jar/cookie_jar.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// iOS 会话 Cookie 存 Keychain，命名空间与服务器配置、CookieJar 模式绑定。
class SecureCookieStorage extends Storage {
  SecureCookieStorage(this.storage, String profileId)
      : _namespace =
            'ccpanes.cookies.v1.${base64Url.encode(utf8.encode(profileId))}.';

  final FlutterSecureStorage storage;
  final String _namespace;
  late String _prefix;

  @override
  Future<void> init(bool persistSession, bool ignoreExpires) async {
    _prefix =
        '${_namespace}ie${ignoreExpires ? 1 : 0}_ps${persistSession ? 1 : 0}.';
  }

  String _key(String key) => '$_prefix${base64Url.encode(utf8.encode(key))}';

  @override
  Future<String?> read(String key) => storage.read(key: _key(key));

  @override
  Future<void> write(String key, String value) =>
      storage.write(key: _key(key), value: value);

  @override
  Future<void> delete(String key) => storage.delete(key: _key(key));

  @override
  Future<void> deleteAll(List<String> keys) async {
    final entries = await storage.readAll();
    final ownedKeys =
        entries.keys.where((key) => key.startsWith(_prefix)).toList();
    for (final key in ownedKeys) {
      await storage.delete(key: key);
    }
  }
}

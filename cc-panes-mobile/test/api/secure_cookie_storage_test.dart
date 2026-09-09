import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cc_panes_mobile/api/secure_cookie_storage.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const storage = FlutterSecureStorage();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('cookies are isolated between profiles and retained across instances',
      () async {
    final first = SecureCookieStorage(storage, 'server/a');
    final second = SecureCookieStorage(storage, 'server/b');
    await first.init(true, false);
    await second.init(true, false);
    await first.write('host', 'session-a');
    expect(await second.read('host'), isNull);
    final restored = SecureCookieStorage(storage, 'server/a');
    await restored.init(true, false);
    expect(await restored.read('host'), 'session-a');
  });

  test(
      'deleting cookies leaves other profiles and non-cookie credentials intact',
      () async {
    final first = SecureCookieStorage(storage, 'a');
    final second = SecureCookieStorage(storage, 'b');
    await first.init(true, false);
    await second.init(true, false);
    await first.write('host', 'a');
    await second.write('host', 'b');
    await storage.write(key: 'server_profiles', value: 'profile-data');
    await first.deleteAll([]);
    expect(await first.read('host'), isNull);
    expect(await second.read('host'), 'b');
    expect(await storage.read(key: 'server_profiles'), 'profile-data');
  });

  test('cookie persistence modes do not share storage', () async {
    final first = SecureCookieStorage(storage, 'a');
    final second = SecureCookieStorage(storage, 'a');
    await first.init(true, false);
    await second.init(false, false);
    await first.write('host', 'a');
    expect(await second.read('host'), isNull);
  });
}

import 'dart:io';

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:path_provider/path_provider.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/config.dart';
import '../core/result.dart';
import '../models/server_profile.dart';
import 'secure_cookie_storage.dart';

/// 单个 ServerProfile 的 HTTP 客户端：dio + 持久化 cookie jar。
/// cookie（ccp_web_session）按 profile 分目录落盘，切换服务器互不污染。
class ApiClient {
  ApiClient._(this.profile, this.dio, this.cookieJar);

  final ServerProfile profile;
  final Dio dio;
  final PersistCookieJar cookieJar;

  static Future<ApiClient> create(ServerProfile profile) async {
    final Storage storage;
    if (Platform.isIOS) {
      storage = SecureCookieStorage(
          const FlutterSecureStorage(
            iOptions: IOSOptions(
                accessibility: KeychainAccessibility.first_unlock_this_device),
          ),
          profile.id);
    } else {
      final supportDir = await getApplicationSupportDirectory();
      final cookieDir = Directory('${supportDir.path}/cookies/${profile.id}');
      await cookieDir.create(recursive: true);
      storage = FileStorage(cookieDir.path);
    }
    final jar = PersistCookieJar(storage: storage);

    final dio = Dio(BaseOptions(
      baseUrl: profile.baseUrl,
      connectTimeout: AppConfig.httpTimeout,
      receiveTimeout: AppConfig.httpTimeout,
      // 4xx/5xx 也走正常返回，由 guard() 统一归类为 ApiFailure
      validateStatus: (_) => true,
    ));
    dio.interceptors.add(CookieManager(jar));
    return ApiClient._(profile, dio, jar);
  }

  /// 读取当前会话 cookie（供 WebSocket 握手 header 复用）。
  Future<String?> sessionCookieHeader() async {
    final cookies = await cookieJar.loadForRequest(Uri.parse(profile.baseUrl));
    if (cookies.isEmpty) return null;
    return cookies.map((c) => '${c.name}=${c.value}').join('; ');
  }

  Future<void> close() async {
    dio.close();
  }
}

/// 把一次 dio 请求归一化为 Result：网络异常、401/403/其他状态码显式分类。
Future<Result<T>> guard<T>(
  Future<Response<dynamic>> Function() request,
  T Function(Response<dynamic> response) parse,
) async {
  final Response<dynamic> response;
  try {
    response = await request();
  } on DioException catch (error) {
    return Err(ApiFailure(FailureKind.network, error.message ?? '网络请求失败'));
  }

  final status = response.statusCode ?? 0;
  if (status == 401) {
    return Err(ApiFailure(FailureKind.unauthorized, '会话已过期，请重新登录',
        statusCode: status));
  }
  if (status == 403) {
    final code = _errorCode(response.data);
    final kind = code == 'READ_ONLY'
        ? FailureKind.readOnly
        : FailureKind.remoteForbidden;
    return Err(ApiFailure(kind, _errorMessage(response.data) ?? '访问被拒绝',
        statusCode: status));
  }
  if (status < 200 || status >= 300) {
    return Err(ApiFailure(
      FailureKind.http,
      _errorMessage(response.data) ?? 'HTTP $status',
      statusCode: status,
    ));
  }

  try {
    return Ok(parse(response));
  } on Object catch (error) {
    return Err(ApiFailure(FailureKind.local, '响应解析失败: $error'));
  }
}

String? _errorCode(dynamic data) =>
    data is Map<String, dynamic> ? data['code'] as String? : null;

String? _errorMessage(dynamic data) {
  if (data is Map<String, dynamic>) return data['message'] as String?;
  if (data is String && data.isNotEmpty) return data;
  return null;
}

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode, this.code});
  final String message;
  final int? statusCode;
  final String? code;

  @override
  String toString() => message;
}

class VexoApi {
  VexoApi({http.Client? client}) : _client = client ?? http.Client();

  static const apiBase = String.fromEnvironment(
    'VEXOSTREAM_API_BASE',
    defaultValue: 'https://api.vexostream.bond/api/v1',
  );
  static const _tokenKey = 'vexostream.api.bearer.v1';
  static const _secureStorage = FlutterSecureStorage();

  final http.Client _client;
  String? _token;

  Future<String?> loadToken() async {
    _token ??= await _secureStorage.read(key: _tokenKey);
    return _token;
  }

  Future<void> saveToken(String token) async {
    _token = token;
    await _secureStorage.write(key: _tokenKey, value: token);
  }

  Future<void> clearToken() async {
    _token = null;
    await _secureStorage.delete(key: _tokenKey);
  }

  Uri _uri(String path, [Map<String, Object?>? query]) {
    final base = Uri.parse(apiBase);
    final normalizedBase = base.path.endsWith('/') ? base.path.substring(0, base.path.length - 1) : base.path;
    final normalizedPath = path.startsWith('/') ? path : '/$path';
    final parameters = <String, String>{};
    query?.forEach((key, value) {
      if (value != null && value.toString().isNotEmpty) parameters[key] = value.toString();
    });
    return base.replace(
      path: '$normalizedBase$normalizedPath',
      queryParameters: parameters.isEmpty ? null : parameters,
      fragment: null,
    );
  }

  Map<String, String> _headers({bool authenticated = false}) {
    final headers = <String, String>{'Accept': 'application/json'};
    final token = _token;
    if (authenticated && token != null && token.isNotEmpty) {
      headers['Authorization'] = 'Bearer $token';
    }
    return headers;
  }

  Future<dynamic> get(String path, {Map<String, Object?>? query, bool authenticated = false}) async {
    final response = await _client.get(_uri(path, query), headers: _headers(authenticated: authenticated));
    return _decode(response);
  }

  Future<dynamic> post(String path, {Map<String, Object?>? body, bool authenticated = false}) async {
    final headers = _headers(authenticated: authenticated)..['Content-Type'] = 'application/json';
    final response = await _client.post(_uri(path), headers: headers, body: jsonEncode(body ?? const {}));
    return _decode(response);
  }

  dynamic _decode(http.Response response) {
    dynamic data;
    try {
      data = jsonDecode(utf8.decode(response.bodyBytes));
    } catch (_) {
      data = <String, dynamic>{};
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final map = data is Map ? data : const <String, dynamic>{};
      throw ApiException(
        (map['error'] ?? map['message'] ?? 'The server returned ${response.statusCode}.').toString(),
        statusCode: response.statusCode,
        code: map['code']?.toString(),
      );
    }
    return data;
  }

  Uri streamUri(Map<String, dynamic> quality) {
    final encoded = (quality['x_url'] ?? '').toString();
    if (encoded.isEmpty) throw const ApiException('The stream link is missing.');
    try {
      final encodedUrl = utf8.decode(base64.decode(base64.normalize(encoded)));
      final rawUrl = Uri.decodeComponent(encodedUrl);
      final isHls = Uri.parse(rawUrl).path.toLowerCase().endsWith('.m3u8');
      final base = Uri.parse(apiBase);
      final proxyPath = isHls ? '/proxy-m3u8' : '/proxy-video';
      return base.replace(
        path: proxyPath,
        queryParameters: {
          'url': rawUrl,
          'sig': (quality['x_sig'] ?? '').toString(),
          'exp': (quality['x_exp'] ?? '').toString(),
        },
      );
    } catch (_) {
      throw const ApiException('Could not decode the stream link.');
    }
  }

  void close() => _client.close();
}

Map<String, dynamic> asMap(dynamic value) => value is Map<String, dynamic>
    ? value
    : value is Map
        ? value.map((key, item) => MapEntry(key.toString(), item))
        : <String, dynamic>{};

List<dynamic> asList(dynamic value) => value is List ? value : <dynamic>[];

String firstText(Map<String, dynamic> map, List<String> keys, {String fallback = ''}) {
  for (final key in keys) {
    final value = map[key];
    if (value != null && value.toString().trim().isNotEmpty) return value.toString();
  }
  return fallback;
}

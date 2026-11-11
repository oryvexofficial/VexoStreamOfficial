import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vexostream_app/api/vexo_api.dart';

void main() {
  test('catalog JSON helpers accept maps and lists', () {
    expect(asMap({'title': 'Demo'})['title'], 'Demo');
    expect(asMap(null), isEmpty);
    expect(asList([1, 2]), [1, 2]);
    expect(asList(null), isEmpty);
  });

  test('signed HLS URLs use the Worker media proxy', () {
    final original = Uri.encodeComponent('https://cdn.example.test/playlist.m3u8?key=abc');
    final encoded = base64.encode(utf8.encode(original));
    final uri = VexoApi().streamUri({'x_url': encoded, 'x_sig': 'signed', 'x_exp': '123'});
    expect(uri.host, 'api.vexostream.bond');
    expect(uri.path, '/proxy-m3u8');
    expect(uri.queryParameters['url'], 'https://cdn.example.test/playlist.m3u8?key=abc');
    expect(uri.queryParameters['sig'], 'signed');
  });
}

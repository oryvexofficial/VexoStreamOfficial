import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vexostream_app/api/vexo_api.dart';

void main() {
  test('JSON helpers accept maps and lists', () {
    expect(asMap({'title': 'Demo'})['title'], 'Demo');
    expect(asMap(null), isEmpty);
    expect(asList([1, 2]), [1, 2]);
    expect(asList(null), isEmpty);
  });

  test('catalogue filter keeps only playable cards with real thumbnails', () {
    final items = videoItems([
      {'url': 'https://www.xvideos.com/video1', 'thumbnail': 'https://img.example.test/a.jpg'},
      {'url': 'https://www.xvideos.com/video2', 'thumbnail': 'https://img.example.test/blank.gif'},
      {'url': '', 'thumbnail': 'https://img.example.test/c.jpg'},
    ]);
    expect(items.length, 1);
  });

  test('durations render like the site', () {
    expect(formatDuration(75), '1:15');
    expect(formatDuration('3725'), '1:02:05');
    expect(formatDuration('12:30'), '12:30');
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

  test('images go through the Worker image proxy', () {
    final url = Uri.parse(VexoApi().imageUrl('//img.example.test/a.jpg'));
    expect(url.path, '/api/v1/image');
    expect(url.queryParameters['url'], 'https://img.example.test/a.jpg');
  });
}

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'vexo_api.dart';

/// Polls `/api/v1/live` for the public "watching now" series and ticks smoothly
/// every second, matching the website's live viewer counter.
class LiveViewersController extends ValueNotifier<int?> {
  LiveViewersController(this.api) : super(null);

  final VexoApi api;
  static const _sidKey = 'vexostream.live.sid';

  String _sid = '';
  List<int> _values = const [];
  int _startSec = 0;
  double _skewSec = 0;
  Timer? _tickTimer;
  Timer? _pollTimer;
  bool _started = false;
  bool _paused = false;
  bool _fetching = false;

  Future<void> start() async {
    if (_started) return;
    _started = true;
    await _ensureSid();
    unawaited(refresh());
    _tickTimer = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
    _pollTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      if (!_paused) unawaited(refresh());
    });
  }

  void pause() {
    _paused = true;
  }

  void resume() {
    if (!_started) return;
    _paused = false;
    unawaited(refresh());
  }

  Future<void> _ensureSid() async {
    if (_sid.isNotEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = (prefs.getString(_sidKey) ?? '').trim();
      if (RegExp(r'^[a-z0-9]{16,40}$').hasMatch(saved)) {
        _sid = saved;
        return;
      }
      _sid = _randomSid();
      await prefs.setString(_sidKey, _sid);
    } catch (_) {
      _sid = _randomSid();
    }
  }

  static String _randomSid() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    final rng = Random.secure();
    return List.generate(24, (_) => chars[rng.nextInt(chars.length)]).join();
  }

  Future<void> refresh() async {
    if (_fetching || _paused) return;
    _fetching = true;
    try {
      if (_sid.isEmpty) await _ensureSid();
      final data = asMap(await api.get(
        '/live',
        query: _sid.isNotEmpty ? {'sid': _sid} : null,
        timeout: const Duration(seconds: 12),
      ));
      if (data['enabled'] != true) {
        _values = const [];
        value = null;
        return;
      }
      final rawValues = asList(data['values']);
      final parsed = <int>[];
      for (final item in rawValues) {
        final n = item is num ? item.round() : int.tryParse(item.toString());
        if (n != null && n >= 0) parsed.add(n);
      }
      if (parsed.isEmpty) {
        _values = const [];
        value = null;
        return;
      }
      final start = data['start'] is num
          ? (data['start'] as num).toInt()
          : int.tryParse(data['start']?.toString() ?? '') ?? 0;
      _values = parsed;
      _startSec = start;
      _skewSec = start + 0.5 - DateTime.now().millisecondsSinceEpoch / 1000.0;
      _tick();
    } catch (_) {
      // Keep the last known count on transient network errors.
    } finally {
      _fetching = false;
    }
  }

  void _tick() {
    if (_paused || _values.isEmpty) return;
    final nowSec = (DateTime.now().millisecondsSinceEpoch / 1000.0 + _skewSec).floor();
    final idx = (nowSec - _startSec).clamp(0, _values.length - 1);
    final next = _values[idx];
    if (value != next) value = next;
  }

  static String formatCount(int count, {bool compact = false}) {
    if (compact && count >= 10000) {
      if (count >= 1000000) {
        return '${(count / 1000000).toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')}M';
      }
      return '${(count / 1000).toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')}K';
    }
    final s = count.toString();
    final buf = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
      buf.write(s[i]);
    }
    return buf.toString();
  }

  @override
  void dispose() {
    _tickTimer?.cancel();
    _pollTimer?.cancel();
    super.dispose();
  }
}

import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';

import '../api/vexo_api.dart';
import '../widgets/vexo_theme.dart';

class PlayerPage extends StatefulWidget {
  const PlayerPage({super.key, required this.api, required this.video, required this.onSignIn});
  final VexoApi api;
  final Map<String, dynamic> video;
  final VoidCallback onSignIn;

  @override
  State<PlayerPage> createState() => _PlayerPageState();
}

class _PlayerPageState extends State<PlayerPage> {
  late final Player _player = Player(configuration: PlayerConfiguration(title: 'VexoStream'));
  late final VideoController _controller = VideoController(_player);
  List<Map<String, dynamic>> _qualities = [];
  String? _selected;
  String? _error;
  ApiException? _apiError;
  bool _loading = true;
  String _title = '';

  String get _target => firstText(widget.video, const ['url', 'video_url', 'link', 'href']);

  @override
  void initState() {
    super.initState();
    _title = firstText(widget.video, const ['title', 'name']);
    _configurePlayer();
    _load();
  }

  Future<void> _configurePlayer() async {
    // mpv's default user agent ("libmpv") is rejected by the Worker's bot filter.
    try {
      await (_player.platform as dynamic).setProperty('user-agent', VexoApi.userAgent);
    } catch (_) {}
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  static int _height(String q) {
    if (RegExp('4k', caseSensitive: false).hasMatch(q)) return 2160;
    return int.tryParse(RegExp(r'\d+').firstMatch(q)?.group(0) ?? '') ?? 0;
  }

  Future<void> _load() async {
    if (_target.isEmpty) {
      setState(() {
        _error = 'This video has no playable source link.';
        _loading = false;
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
      _apiError = null;
    });
    try {
      final response = asMap(await widget.api.post('/videos/extract', body: {'url': _target}, authenticated: true, timeout: const Duration(seconds: 70)));
      if (response['status'] != 'success') throw ApiException((response['error'] ?? 'This video couldn’t be resolved.').toString(), code: response['code']?.toString());
      final apiTitle = firstText(response, const ['title']);
      if (apiTitle.isNotEmpty) _title = apiTitle;
      final list = asList(asMap(response['streams'])['qualities']).map(asMap).where((q) {
        final label = (q['quality'] ?? '').toString().replaceAll(RegExp(r'[\[\]]'), '').trim();
        return (q['x_url'] ?? '').toString().isNotEmpty && label.isNotEmpty && !RegExp(r'^(source|auto)$', caseSensitive: false).hasMatch(label);
      }).toList()
        ..sort((a, b) => _height((b['quality'] ?? '').toString()).compareTo(_height((a['quality'] ?? '').toString())));
      if (list.isEmpty) throw const ApiException('No playable streams were returned for this video.');
      _qualities = list;
      // Start at the best quality up to 1080p, like the site's auto pick.
      final start = list.firstWhere((q) => _height((q['quality'] ?? '').toString()) <= 1080, orElse: () => list.first);
      await _play(start);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _apiError = e is ApiException ? e : null;
          _loading = false;
        });
      }
    }
  }

  Future<void> _play(Map<String, dynamic> q) async {
    final at = _player.state.position;
    final resume = _selected != null && at > const Duration(seconds: 2);
    try {
      final uri = widget.api.streamUri(q);
      setState(() {
        _selected = (q['quality'] ?? 'Auto').toString();
        _loading = false;
        _error = null;
      });
      await _player.open(Media(uri.toString(), httpHeaders: const {'User-Agent': VexoApi.userAgent}), play: true);
      if (resume) {
        await _player.stream.duration.firstWhere((d) => d > Duration.zero).timeout(const Duration(seconds: 15), onTimeout: () => Duration.zero);
        await _player.seek(at);
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = firstText(widget.video, const ['provider']);
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(_title.isEmpty ? 'Player' : _title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(tooltip: 'Reload stream', onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh_rounded)),
          const SizedBox(width: 10),
        ],
      ),
      body: PageBody(maxWidth: 1240, padding: const EdgeInsets.fromLTRB(28, 24, 28, 40), children: [
        AspectRatio(
          aspectRatio: 16 / 9,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(Vx.radiusXl),
            child: ColoredBox(color: Colors.black, child: _surface()),
          ),
        ),
        const SizedBox(height: 22),
        Text(_title.isEmpty ? 'Untitled video' : _title, style: t.headlineSmall?.copyWith(fontSize: 24)),
        const SizedBox(height: 10),
        Row(children: [
          if (provider.isNotEmpty) ...[
            ProviderIcon(id: provider.toLowerCase(), name: provider, size: 22),
            const SizedBox(width: 8),
            Text(provider[0].toUpperCase() + provider.substring(1), style: Vx.sans(size: 14, color: Vx.text2, weight: FontWeight.w500)),
            const SizedBox(width: 14),
          ],
          Expanded(child: Text(_target, maxLines: 1, overflow: TextOverflow.ellipsis, style: Vx.mono(size: 12))),
        ]),
        if (_qualities.isNotEmpty) ...[
          const SizedBox(height: 22),
          Container(
            padding: const EdgeInsets.all(18),
            decoration: Vx.surface(),
            child: Row(children: [
              Text('QUALITY', style: Vx.mono(size: 12, spacing: 1.4)),
              const SizedBox(width: 18),
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: PillTabs<String>(
                    items: [for (final q in _qualities) ((q['quality'] ?? '').toString(), (q['quality'] ?? '').toString().replaceAll(RegExp(r'[\[\]]'), ''))],
                    value: _selected ?? '',
                    onChanged: (label) => _play(_qualities.firstWhere((q) => (q['quality'] ?? '').toString() == label)),
                  ),
                ),
              ),
            ]),
          ),
        ],
      ]),
    );
  }

  Widget _surface() {
    if (_loading) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(width: 30, height: 30, child: CircularProgressIndicator(strokeWidth: 2.6)),
          const SizedBox(height: 16),
          Text('Finding the best stream…', style: Vx.sans(size: 14, color: Vx.text2)),
        ]),
      );
    }
    if (_error != null) {
      final login = _apiError?.needsLogin == true;
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(color: (login ? Vx.blue : Vx.red).withValues(alpha: .16), borderRadius: BorderRadius.circular(16)),
              child: Icon(login ? Icons.lock_outline_rounded : Icons.error_outline_rounded, color: login ? Vx.blue : Vx.red),
            ),
            const SizedBox(height: 14),
            Text(login ? 'Please log in first.' : 'Can’t play this video', style: Vx.sans(size: 21, weight: FontWeight.w700, color: Colors.white, spacing: -.4)),
            const SizedBox(height: 6),
            ConstrainedBox(constraints: const BoxConstraints(maxWidth: 440), child: Text(_error!, textAlign: TextAlign.center, style: Vx.sans(size: 14, color: Vx.text2))),
            const SizedBox(height: 16),
            if (login) FilledButton(onPressed: widget.onSignIn, child: const Text('Log in')) else OutlinedButton.icon(onPressed: _load, icon: const Icon(Icons.refresh_rounded, size: 18), label: const Text('Try again')),
          ]),
        ),
      );
    }
    final theme = MaterialDesktopVideoControlsThemeData(
      seekBarPositionColor: Vx.blue,
      seekBarThumbColor: Vx.blue,
      seekBarBufferColor: Color(0x55FFFFFF),
      seekBarColor: Color(0x33FFFFFF),
    );
    return MaterialDesktopVideoControlsTheme(
      normal: theme,
      fullscreen: theme,
      child: Video(controller: _controller, fit: BoxFit.contain, controls: MaterialDesktopVideoControls),
    );
  }
}

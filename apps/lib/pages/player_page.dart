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
  late final Player _player;
  late final VideoController _controller;
  List<Map<String, dynamic>> _qualities = [];
  String? _selectedQuality;
  String? _error;
  bool _loading = true;
  bool _extracting = false;

  String get _target => firstText(widget.video, const ['url', 'video_url', 'link', 'href']);
  String get _title => firstText(widget.video, const ['title', 'name'], fallback: _target.isEmpty ? 'VexoStream player' : _target);

  @override
  void initState() {
    super.initState();
    _player = Player();
    _controller = VideoController(_player);
    _loadStream();
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _loadStream({Map<String, dynamic>? preferred}) async {
    if (_target.isEmpty) {
      setState(() { _error = 'This video card did not include a playable source link.'; _loading = false; });
      return;
    }
    setState(() { _extracting = true; _error = null; });
    try {
      final response = asMap(await widget.api.post('/videos/extract', body: {'url': _target}, authenticated: true));
      if (response['status'] != 'success') throw ApiException((response['error'] ?? 'The source could not be resolved.').toString());
      final streamMap = asMap(response['streams']);
      final qualityList = asList(streamMap['qualities']);
      final usable = qualityList.map(asMap).where((q) => (q['x_url'] ?? '').toString().isNotEmpty).toList();
      if (usable.isEmpty) throw const ApiException('No playable streams were returned for this video.');
      _qualities = usable;
      if (mounted) setState(() { _loading = false; _extracting = false; });
      final selected = preferred ?? usable.first;
      await _playQuality(selected);
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; _extracting = false; });
    }
  }

  Future<void> _playQuality(Map<String, dynamic> item) async {
    try {
      final uri = widget.api.streamUri(item);
      _selectedQuality = (item['quality'] ?? item['label'] ?? 'Auto').toString();
      if (mounted) setState(() { _error = null; _loading = false; });
      await _player.open(Media(uri.toString()), play: true);
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  Widget _playerSurface() {
    if (_loading) {
      return const Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        CircularProgressIndicator(),
        SizedBox(height: 16),
        Text('Finding a playable stream…', style: TextStyle(color: Colors.white70)),
      ]));
    }
    if (_error == null) {
      return Video(controller: _controller, fit: BoxFit.contain, controls: MaterialVideoControls);
    }
    return Center(child: Padding(padding: const EdgeInsets.all(24), child: Column(mainAxisSize: MainAxisSize.min, children: [
      const Icon(Icons.error_outline, size: 38, color: Colors.orangeAccent),
      const SizedBox(height: 12),
      Text(_error!, textAlign: TextAlign.center),
      if (_error!.contains('Sign in')) ...[
        const SizedBox(height: 16),
        FilledButton(onPressed: widget.onSignIn, child: const Text('Sign in')),
      ],
    ])));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_title, maxLines: 1, overflow: TextOverflow.ellipsis), actions: [
        if (_extracting) const Padding(padding: EdgeInsets.symmetric(horizontal: 18), child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))),
        IconButton(tooltip: 'Retry', onPressed: _loadStream, icon: const Icon(Icons.refresh_rounded)),
        const SizedBox(width: 8),
      ]),
      body: ListView(padding: const EdgeInsets.fromLTRB(24, 16, 24, 28), children: [
        Center(child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1200),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            AspectRatio(
              aspectRatio: 16 / 9,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: ColoredBox(color: Colors.black, child: _playerSurface()),
              ),
            ),
            const SizedBox(height: 20),
            Text(_title, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Text(_target, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white54)),
            if (_qualities.isNotEmpty) ...[
              const SizedBox(height: 22),
              const Text('Quality', style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 10),
              Wrap(spacing: 9, runSpacing: 8, children: _qualities.map((q) {
                final label = (q['quality'] ?? q['label'] ?? 'Auto').toString();
                return ChoiceChip(label: Text(label), selected: _selectedQuality == label, onSelected: (_) => _playQuality(q));
              }).toList()),
            ],
            const SizedBox(height: 18),
            Card(child: Padding(padding: const EdgeInsets.all(16), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Icon(Icons.info_outline, color: vexoPurple),
              const SizedBox(width: 12),
              const Expanded(child: Text('Playback depends on the configured VexoStream Core backend and the source provider. Only publicly playable, non-DRM streams are supported.', style: TextStyle(color: Colors.white70, height: 1.4))),
            ]))),
          ]),
        )),
      ]),
    );
  }
}

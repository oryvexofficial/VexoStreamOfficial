import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/provider_embed.dart';
import '../api/vexo_api.dart';
import '../api/watch_history.dart';
import '../widgets/provider_embed_view.dart';
import '../widgets/android_embed_view.dart';
import '../widgets/vexo_theme.dart';
import '../widgets/video_card.dart';

String recommendationQuery(String title) {
  if (title.trim().isEmpty || title == 'VexoStream player') return 'trending';
  final words = title.toLowerCase().replaceAll(RegExp(r'[^a-z0-9\s]'), ' ')
      .split(RegExp(r'\s+')).where((word) => word.length > 3).take(3).join(' ');
  return words.isEmpty ? 'trending' : words;
}

/// The app's playback surface is VexoStream's own web player, hosted in a
/// first-party WebView. There is no native media-kit playback path.
class PlayerPage extends StatefulWidget {
  const PlayerPage({
    super.key,
    required this.api,
    required this.video,
    required this.onSignIn,
  });

  final VexoApi api;
  final Map<String, dynamic> video;
  final Future<void> Function() onSignIn;

  @override
  State<PlayerPage> createState() => _PlayerPageState();
}

class _PlayerPageState extends State<PlayerPage> {
  final GlobalKey<VexoEmbedViewState> _embedKey = GlobalKey<VexoEmbedViewState>();
  final GlobalKey<AndroidEmbedViewState> _androidEmbedKey = GlobalKey<AndroidEmbedViewState>();
  EmbeddedQualityState _qualityState = const EmbeddedQualityState();
  List<Map<String, dynamic>> _related = [];
  bool _relatedLoading = true;
  String? _relatedError;
  Timer? _historyTimer;
  bool _savingHistory = false;

  @override
  void initState() {
    super.initState();
    _loadRelated();
    _historyTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => unawaited(_savePlaybackProgress()),
    );
  }

  Future<void> _loadRelated() async {
    final embed = providerEmbedForVideo(widget.video);
    if (embed == null) {
      if (mounted) setState(() => _relatedLoading = false);
      return;
    }
    try {
      final data = await widget.api.get('/catalog', query: {
        'provider': embed.provider,
        'q': recommendationQuery(_title),
        'page': 1,
      });
      if (mounted) setState(() {
        _related = videoItems(data).where((item) => videoTarget(item) != _target).take(8).toList();
        _relatedLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() { _relatedError = 'Recommendations could not be loaded.'; _relatedLoading = false; });
    }
  }

  String get _title => firstText(widget.video, const ['title', 'name']);
  String get _target => firstText(widget.video, const ['url', 'video_url', 'link', 'href']);

  void _updateQualityState(EmbeddedQualityState state) {
    if (!mounted) return;
    setState(() => _qualityState = state);
  }

  Future<void> _selectQuality(int? index) async {
    if (Platform.isAndroid) {
      await _androidEmbedKey.currentState?.selectQuality(index);
    } else {
      await _embedKey.currentState?.selectQuality(index);
    }
  }

  Future<void> _savePlaybackProgress() async {
    if (_savingHistory) return;
    _savingHistory = true;
    try {
      final progress = Platform.isAndroid
          ? await _androidEmbedKey.currentState?.readPlaybackProgress()
          : await _embedKey.currentState?.readPlaybackProgress();
      if (progress == null || progress.positionSeconds <= 0) return;
      final target = _target;
      final targetUri = Uri.tryParse(target);
      if (targetUri == null ||
          (targetUri.scheme != 'https' && targetUri.scheme != 'http') ||
          targetUri.host.isEmpty) {
        return;
      }
      await WatchHistoryStore.save(WatchHistoryEntry(
        url: target,
        title: _title.isEmpty ? 'VexoStream Player' : _title,
        provider: firstText(widget.video, const ['provider', 'source']),
        thumbnail: videoThumbnail(widget.video),
        position: progress.positionSeconds.floor(),
        duration: progress.durationSeconds.floor(),
        updatedAt: DateTime.now().millisecondsSinceEpoch,
      ));
    } finally {
      _savingHistory = false;
    }
  }

  Future<void> _copy(BuildContext context, String value, String message) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final embed = providerEmbedForVideo(widget.video);
    final title = _title.isEmpty ? 'VexoStream Player' : _title;
    final provider = firstText(widget.video, const ['provider']);

    return Scaffold(
      appBar: AppBar(
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          if (embed != null)
            IconButton(
              tooltip: 'Share or embed this video',
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => _ShareEmbedDialog(
                  sourceUrl: embed.sourceUri.toString(),
                  embedUrl: embed.embedUri.toString(),
                ),
              ),
              icon: const Icon(Icons.ios_share_rounded),
            ),
          if (embed != null)
            IconButton(
              tooltip: 'Copy VexoStream embed link',
              onPressed: () => _copy(context, embed.embedUri.toString(), 'VexoStream embed link copied'),
              icon: const Icon(Icons.link_rounded),
            ),
          const SizedBox(width: 8),
        ],
      ),
      body: PageBody(
        maxWidth: 1240,
        padding: const EdgeInsets.fromLTRB(28, 24, 28, 40),
        children: [
          AspectRatio(
            aspectRatio: 16 / 9,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(Vx.radiusXl),
              child: ColoredBox(
                color: Colors.black,
                child: embed == null
                    ? _unsupportedSource(context)
                    : Platform.isAndroid
                    ? AndroidEmbedView(
                        key: _androidEmbedKey,
                        embed: embed,
                        video: widget.video,
                        api: widget.api,
                        onBack: () => Navigator.of(context).maybePop(),
                        onSignIn: widget.onSignIn,
                        onQualityStateChanged: _updateQualityState,
                      )
                    : VexoEmbedView(
                        key: _embedKey,
                        embed: embed,
                        video: widget.video,
                        api: widget.api,
                        onBack: () => Navigator.of(context).maybePop(),
                        onSignIn: widget.onSignIn,
                        onQualityStateChanged: _updateQualityState,
                      ),
              ),
            ),
          ),
          if (embed != null) ...[
            const SizedBox(height: 20),
            _qualityCard(),
          ],
          const SizedBox(height: 20),
          Text(title, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontSize: 24)),
          const SizedBox(height: 10),
          Row(children: [
            if (provider.isNotEmpty) ...[
              ProviderIcon(id: provider.toLowerCase(), name: provider, size: 22),
              const SizedBox(width: 8),
              Text(
                provider[0].toUpperCase() + provider.substring(1),
                style: Vx.sans(size: 14, color: Vx.text2, weight: FontWeight.w500),
              ),
              const SizedBox(width: 14),
            ],
            Expanded(
              child: Text(
                _target,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Vx.mono(size: 12),
              ),
            ),
            TextButton.icon(
              onPressed: () => _copy(context, _target, 'Original video link copied'),
              icon: const Icon(Icons.copy_rounded, size: 16),
              label: const Text('Copy link'),
            ),
          ]),
          const SizedBox(height: 32),
          _shortcuts(),
          const SizedBox(height: 32),
          const PageHeading(title: 'More like this', large: false),
          if (_relatedError != null)
            Text(_relatedError!, style: Vx.sans(size: 14, color: Vx.text2))
          else if (!_relatedLoading && _related.isEmpty)
            Text('No similar videos found.', style: Vx.sans(size: 14, color: Vx.text2))
          else
            VideoGrid(
              api: widget.api, items: _related, loading: _relatedLoading, skeletons: 4,
              onPlay: (video) => Navigator.of(context).pushReplacement(MaterialPageRoute(
                builder: (_) => PlayerPage(api: widget.api, video: video, onSignIn: widget.onSignIn),
              )),
            ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _historyTimer?.cancel();
    super.dispose();
  }

  Widget _shortcuts() => Container(
    padding: const EdgeInsets.all(18),
    decoration: Vx.surface(),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Shortcuts', style: Vx.sans(size: 15, weight: FontWeight.w600)),
      const SizedBox(height: 12),
      Text('When the player has keyboard focus:', style: Vx.sans(size: 13, color: Vx.text2)),
      const SizedBox(height: 10),
      Wrap(spacing: 18, runSpacing: 8, children: [
        for (final item in const ['K  Play / pause', 'F  Full screen', '← / →  5 seconds', 'J / L  10 seconds', 'M  Mute', 'T  Theater'])
          Text(item, style: Vx.sans(size: 13, color: Vx.text2)),
      ]),
    ]),
  );

  Widget _qualityCard() {
    final state = _qualityState;
    final options = state.options;
    final selectedResolution = state.currentLabel;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: Vx.surface(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.high_quality_outlined, color: Vx.blue, size: 20),
              const SizedBox(width: 10),
              Expanded(child: Text('Playback quality', style: Vx.sans(size: 15, weight: FontWeight.w600))),
              if (options.isEmpty)
                Flexible(child: Text('Loading options…', overflow: TextOverflow.ellipsis, style: Vx.sans(size: 12, color: Vx.text3)))
              else
                Flexible(child: Text(
                  state.isAuto && selectedResolution != null
                      ? 'Auto · $selectedResolution'
                      : (selectedResolution ?? 'Choose a resolution'),
                  overflow: TextOverflow.ellipsis,
                  style: Vx.mono(size: 11, color: Vx.text2),
                )),
            ],
          ),
          const SizedBox(height: 14),
          if (options.isEmpty)
            Row(
              children: [
                const SizedBox(
                  width: 15,
                  height: 15,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 10),
                Expanded(child: Text(
                  'Waiting for the embedded player’s stream options.',
                  style: Vx.sans(size: 12, color: Vx.text2),
                )),
              ],
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ChoiceChip(
                  label: const Text('Auto'),
                  selected: state.isAuto,
                  onSelected: (_) => _selectQuality(null),
                ),
                for (final quality in options)
                  ChoiceChip(
                    label: Text(quality.label),
                    selected: !state.isAuto && state.currentIndex == quality.index,
                    onSelected: (_) => _selectQuality(quality.index),
                    avatar: quality.format.isEmpty
                        ? null
                        : Text(
                            quality.format,
                            style: Vx.mono(size: 8, color: Vx.text2),
                          ),
                  ),
              ],
            ),
          if (options.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(
              'Changes here control the VexoStream embedded player.',
              style: Vx.sans(size: 12, color: Vx.text3),
            ),
          ],
        ],
      ),
    );
  }

  Widget _unsupportedSource(BuildContext context) => ColoredBox(
        color: Colors.black,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.link_off_rounded, size: 42, color: Colors.white70),
                const SizedBox(height: 14),
                Text(
                  'Unsupported video link',
                  textAlign: TextAlign.center,
                  style: Vx.sans(size: 20, color: Colors.white, weight: FontWeight.w700),
                ),
                const SizedBox(height: 8),
                Text(
                  'This link does not match a supported provider video page, so it cannot be opened in the VexoStream player.',
                  textAlign: TextAlign.center,
                  style: Vx.sans(size: 14, color: Vx.text2),
                ),
                const SizedBox(height: 14),
                OutlinedButton.icon(
                  onPressed: () => _copy(context, _target, 'Original video link copied'),
                  icon: const Icon(Icons.copy_rounded, size: 16),
                  label: const Text('Copy original link'),
                ),
              ],
            ),
          ),
        ),
      );
}

class _ShareEmbedDialog extends StatefulWidget {
  const _ShareEmbedDialog({
    required this.sourceUrl,
    required this.embedUrl,
  });

  final String sourceUrl;
  final String embedUrl;

  @override
  State<_ShareEmbedDialog> createState() => _ShareEmbedDialogState();
}

class _ShareEmbedDialogState extends State<_ShareEmbedDialog> {
  bool _useWebComponent = false;

  String get _embedCode {
    final origin = Uri.parse(widget.embedUrl).origin;
    if (_useWebComponent) {
      return '<script src="$origin/embed.js"></script>\n'
          '<vexo-player src="${widget.sourceUrl}"></vexo-player>';
    }
    return '<div style="position:relative;padding-top:56.25%">\n'
        '  <iframe src="${widget.embedUrl}" '
        'style="position:absolute;inset:0;width:100%;height:100%;border:0" '
        'allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>\n'
        '</div>';
  }

  Future<void> _copy(String value, String label) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$label copied')),
    );
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Share or embed this video'),
        content: SizedBox(
          width: 520,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: false, label: Text('iframe')),
                  ButtonSegment(value: true, label: Text('Web component')),
                ],
                selected: {_useWebComponent},
                onSelectionChanged: (value) =>
                    setState(() => _useWebComponent = value.first),
              ),
              const SizedBox(height: 14),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                decoration: Vx.surface(color: Vx.well),
                child: SelectableText(
                  _embedCode,
                  style: Vx.mono(size: 12, color: Vx.text2),
                ),
              ),
              const SizedBox(height: 10),
              SelectableText(
                widget.embedUrl,
                style: Vx.mono(size: 11, color: Vx.text3),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
          OutlinedButton(
            onPressed: () => _copy(widget.embedUrl, 'Embed link'),
            child: const Text('Copy VexoStream link'),
          ),
          FilledButton.icon(
            onPressed: () => _copy(_embedCode, 'Embed code'),
            icon: const Icon(Icons.copy_rounded),
            label: const Text('Copy code'),
          ),
        ],
      );
}

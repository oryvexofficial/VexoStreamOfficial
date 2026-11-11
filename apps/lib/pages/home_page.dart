import 'package:flutter/material.dart';

import '../api/vexo_api.dart';
import '../widgets/vexo_theme.dart';
import '../widgets/video_card.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key, required this.api, required this.onPlay, required this.onBrowse, required this.onSearch});
  final VexoApi api;
  final ValueChanged<Map<String, dynamic>> onPlay;
  final VoidCallback onBrowse;
  final void Function(String query, String provider) onSearch;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final _linkController = TextEditingController();
  final _searchController = TextEditingController();
  List<dynamic> _videos = [];
  List<dynamic> _providers = [];
  String _provider = '';
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _linkController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final config = asMap(await widget.api.get('/config'));
      _providers = asList(config['providers']);
      _provider = (_provider.isNotEmpty ? _provider : (config['defaultProvider'] ?? '').toString());
      if (_provider.isNotEmpty) {
        final result = await widget.api.get('/catalog', query: {'provider': _provider, 'q': 'trending', 'page': 1});
        _videos = _itemsFrom(result);
      }
      if (mounted) setState(() => _loading = false);
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  List<dynamic> _itemsFrom(dynamic value) {
    if (value is List) return value;
    final map = asMap(value);
    return asList(map['videos'] ?? map['results'] ?? map['items'] ?? map['data']);
  }

  void _openLink() {
    final target = _linkController.text.trim();
    if (target.isEmpty) return;
    widget.onPlay({'url': target, 'title': target});
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.fromLTRB(28, 28, 28, 42), children: [
        _hero(context),
        const SizedBox(height: 28),
        Row(children: [
          const Expanded(child: PageHeading(title: 'Trending now', subtitle: 'Browse the latest from your enabled libraries.')),
          TextButton.icon(onPressed: widget.onBrowse, icon: const Icon(Icons.grid_view_rounded), label: const Text('Browse all')),
        ]),
        if (_loading) const SizedBox(height: 180, child: PageLoader(label: 'Loading trending videos…'))
        else if (_error != null) SizedBox(height: 210, child: ErrorPanel(message: _error!, onRetry: _load))
        else if (_videos.isEmpty) const _EmptyTrend()
        else LayoutBuilder(builder: (context, constraints) {
            final count = constraints.maxWidth > 1250 ? 4 : constraints.maxWidth > 860 ? 3 : constraints.maxWidth > 560 ? 2 : 1;
            return GridView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: _videos.length,
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: count, crossAxisSpacing: 16, mainAxisSpacing: 16, childAspectRatio: count == 1 ? 1.35 : 1.23),
              itemBuilder: (_, i) {
                final item = asMap(_videos[i]);
                return VideoCard(video: item, onTap: () => widget.onPlay(item));
              },
            );
          }),
      ]);

  Widget _hero(BuildContext context) => Container(
        padding: const EdgeInsets.all(30),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(26),
          gradient: const LinearGradient(colors: [Color(0xFF241440), Color(0xFF17142A), Color(0xFF111722)], begin: Alignment.topLeft, end: Alignment.bottomRight),
          border: Border.all(color: vexoPurple.withValues(alpha: .25)),
        ),
        child: LayoutBuilder(builder: (context, constraints) {
          final narrow = constraints.maxWidth < 800;
          final copy = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), decoration: BoxDecoration(color: vexoPink.withValues(alpha: .13), borderRadius: BorderRadius.circular(40)), child: const Text('18+ ONLY', style: TextStyle(color: Color(0xFFFF8DBA), fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.2))),
            const SizedBox(height: 17),
            Text('Your video library,\none clean player.', style: Theme.of(context).textTheme.headlineLarge?.copyWith(fontWeight: FontWeight.w900, height: 1.06, letterSpacing: -1.2)),
            const SizedBox(height: 12),
            const Text('Paste a supported video link or browse the enabled libraries. No noisy ad layers, just the player.', style: TextStyle(color: Colors.white70, height: 1.5)),
            const SizedBox(height: 21),
            TextField(controller: _linkController, onSubmitted: (_) => _openLink(), decoration: InputDecoration(hintText: 'Paste a supported video URL', prefixIcon: const Icon(Icons.link_rounded), suffixIcon: IconButton(tooltip: 'Play link', onPressed: _openLink, icon: const Icon(Icons.arrow_forward_rounded, color: Colors.white)), filled: true, fillColor: Colors.black.withValues(alpha: .23))),
            const SizedBox(height: 11),
            Row(children: [
              Expanded(child: TextField(controller: _searchController, onSubmitted: (q) => widget.onSearch(q.trim(), _provider), decoration: const InputDecoration(hintText: 'Search videos', prefixIcon: Icon(Icons.search_rounded)))),
              const SizedBox(width: 10),
              FilledButton(onPressed: () => widget.onSearch(_searchController.text.trim(), _provider), child: const Text('Search')),
            ]),
          ]);
          if (narrow) return copy;
          return Row(children: [
            Expanded(flex: 7, child: copy),
            const SizedBox(width: 36),
            Expanded(flex: 4, child: Container(height: 270, decoration: BoxDecoration(borderRadius: BorderRadius.circular(22), color: Colors.black.withValues(alpha: .18)), child: Center(child: Image.asset('assets/brand/vexostream-mark-512.png', width: 155, height: 155, errorBuilder: (_, __, ___) => const Icon(Icons.play_circle_outline_rounded, size: 120, color: vexoPurple))))),
          ]);
        }),
      );
}

class _EmptyTrend extends StatelessWidget {
  const _EmptyTrend();
  @override
  Widget build(BuildContext context) => Card(child: Padding(padding: const EdgeInsets.all(26), child: Row(children: [const Icon(Icons.video_library_outlined), const SizedBox(width: 13), const Expanded(child: Text('No videos returned. Check that the Worker has a catalog backend configured.'))])));
}

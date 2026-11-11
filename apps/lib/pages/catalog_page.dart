import 'package:flutter/material.dart';

import '../api/vexo_api.dart';
import '../widgets/vexo_theme.dart';
import '../widgets/video_card.dart';

class CatalogPage extends StatefulWidget {
  const CatalogPage({super.key, required this.api, required this.onPlay, this.initialQuery = '', this.initialProvider = ''});
  final VexoApi api;
  final ValueChanged<Map<String, dynamic>> onPlay;
  final String initialQuery;
  final String initialProvider;

  @override
  State<CatalogPage> createState() => _CatalogPageState();
}

class _CatalogPageState extends State<CatalogPage> {
  final _queryController = TextEditingController();
  List<dynamic> _providers = [];
  List<dynamic> _videos = [];
  String _provider = '';
  String _query = '';
  int _page = 1;
  bool _loading = true;
  String? _error;
  bool _hasMore = false;

  @override
  void initState() {
    super.initState();
    _query = widget.initialQuery;
    _queryController.text = _query;
    _provider = widget.initialProvider;
    _loadConfigAndResults();
  }

  @override
  void dispose() {
    _queryController.dispose();
    super.dispose();
  }

  Future<void> _loadConfigAndResults() async {
    try {
      final config = asMap(await widget.api.get('/config'));
      _providers = asList(config['providers']);
      if (_provider.isEmpty) _provider = (config['defaultProvider'] ?? '').toString();
      if (mounted) setState(() {});
      await _load();
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  Future<void> _load() async {
    if (_provider.isEmpty) {
      setState(() { _loading = false; _videos = []; _error = null; });
      return;
    }
    setState(() { _loading = true; _error = null; });
    try {
      final result = await widget.api.get('/catalog', query: {'provider': _provider, 'q': _query.isEmpty ? 'trending' : _query, 'page': _page});
      final map = asMap(result);
      _videos = result is List ? result : asList(map['videos'] ?? map['results'] ?? map['items'] ?? map['data']);
      _hasMore = map['has_more'] == true || map['hasMore'] == true || (_videos.length >= 20);
      if (mounted) setState(() => _loading = false);
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  void _submitSearch() {
    setState(() { _query = _queryController.text.trim(); _page = 1; });
    _load();
  }

  @override
  Widget build(BuildContext context) => Column(children: [
        Padding(padding: const EdgeInsets.fromLTRB(28, 28, 28, 0), child: Column(children: [
          PageHeading(title: _query.isEmpty ? 'Browse videos' : 'Search results', subtitle: _query.isEmpty ? 'Choose a library, then explore its latest catalog.' : 'Showing matches for “$_query”.'),
          Row(children: [
            Expanded(child: TextField(controller: _queryController, onSubmitted: (_) => _submitSearch(), decoration: const InputDecoration(hintText: 'Search videos', prefixIcon: Icon(Icons.search_rounded)))),
            const SizedBox(width: 10),
            FilledButton.icon(onPressed: _submitSearch, icon: const Icon(Icons.search_rounded), label: const Text('Search')),
          ]),
          const SizedBox(height: 16),
          if (_providers.isNotEmpty) SizedBox(height: 45, child: ListView.separated(scrollDirection: Axis.horizontal, itemCount: _providers.length, separatorBuilder: (_, __) => const SizedBox(width: 8), itemBuilder: (context, i) {
            final p = asMap(_providers[i]);
            final id = (p['id'] ?? '').toString();
            return ChoiceChip(label: Text((p['name'] ?? id).toString()), selected: _provider == id, onSelected: (_) { setState(() { _provider = id; _page = 1; }); _load(); });
          })),
          const SizedBox(height: 10),
        ])),
        Expanded(child: _loading ? const PageLoader(label: 'Loading videos…') : _error != null
            ? ErrorPanel(message: _error!, onRetry: _load)
            : _videos.isEmpty
                ? const Center(child: Text('No videos found. Try another search or library.', style: TextStyle(color: Colors.white60)))
                : LayoutBuilder(builder: (context, constraints) {
                    final count = constraints.maxWidth > 1450 ? 5 : constraints.maxWidth > 1050 ? 4 : constraints.maxWidth > 720 ? 3 : constraints.maxWidth > 480 ? 2 : 1;
                    return GridView.builder(
                      padding: const EdgeInsets.fromLTRB(28, 4, 28, 24),
                      itemCount: _videos.length,
                      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: count, crossAxisSpacing: 16, mainAxisSpacing: 16, childAspectRatio: count == 1 ? 1.35 : 1.22),
                      itemBuilder: (context, index) { final item = asMap(_videos[index]); return VideoCard(video: item, onTap: () => widget.onPlay(item)); },
                    );
                  })),
        if (!_loading && _error == null) Padding(padding: const EdgeInsets.fromLTRB(28, 0, 28, 20), child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          OutlinedButton.icon(onPressed: _page > 1 ? () { setState(() => _page--); _load(); } : null, icon: const Icon(Icons.chevron_left), label: const Text('Previous')),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 18), child: Text('Page $_page', style: const TextStyle(color: Colors.white70))),
          OutlinedButton.icon(onPressed: _hasMore ? () { setState(() => _page++); _load(); } : null, icon: const Icon(Icons.chevron_right), label: const Text('Next')),
        ])),
      ]);
}

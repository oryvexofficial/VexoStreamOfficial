import 'package:flutter/material.dart';

import '../api/vexo_api.dart';
import '../widgets/vexo_theme.dart';

class ModelsPage extends StatefulWidget {
  const ModelsPage({super.key, required this.api, required this.onSignIn});
  final VexoApi api;
  final VoidCallback onSignIn;

  @override
  State<ModelsPage> createState() => _ModelsPageState();
}

class _ModelsPageState extends State<ModelsPage> {
  final _search = TextEditingController();
  String _gender = 'women';
  int _page = 1;
  List<dynamic> _models = [];
  bool _loading = true;
  bool _hasMore = false;
  String? _error;

  @override
  void initState() { super.initState(); _load(); }
  @override
  void dispose() { _search.dispose(); super.dispose(); }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final result = asMap(await widget.api.get('/models', query: {'gender': _gender, 'search': _search.text.trim(), 'page': _page}, authenticated: true));
      _models = asList(result['models'] ?? result['results'] ?? result['items']);
      _hasMore = result['has_more'] == true || result['hasMore'] == true;
      if (mounted) setState(() => _loading = false);
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  void _open(Map<String, dynamic> model) {
    final slug = firstText(model, const ['slug', 'id']);
    if (slug.isEmpty) return;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => ModelProfilePage(api: widget.api, slug: slug, initial: model)));
  }

  @override
  Widget build(BuildContext context) => Column(children: [
        Padding(padding: const EdgeInsets.fromLTRB(28, 28, 28, 12), child: Column(children: [
          const PageHeading(title: 'Performers', subtitle: 'Browse public profile cards and directory details.'),
          Row(children: [
            Expanded(child: TextField(controller: _search, onSubmitted: (_) { setState(() => _page = 1); _load(); }, decoration: const InputDecoration(hintText: 'Search performers', prefixIcon: Icon(Icons.search_rounded)))),
            const SizedBox(width: 12),
            SegmentedButton<String>(segments: const [ButtonSegment(value: 'women', label: Text('Women')), ButtonSegment(value: 'both', label: Text('All')), ButtonSegment(value: 'men', label: Text('Men'))], selected: {_gender}, onSelectionChanged: (values) { setState(() { _gender = values.first; _page = 1; }); _load(); }),
          ]),
        ])),
        Expanded(child: _loading ? const PageLoader(label: 'Loading performers…') : _error != null
            ? ErrorPanel(message: _error!, onRetry: _load, action: _error!.contains('Sign in') ? FilledButton(onPressed: widget.onSignIn, child: const Text('Sign in')) : null)
            : _models.isEmpty ? const Center(child: Text('No profiles found.', style: TextStyle(color: Colors.white60))) : LayoutBuilder(builder: (context, constraints) {
                final count = constraints.maxWidth > 1400 ? 6 : constraints.maxWidth > 1050 ? 5 : constraints.maxWidth > 760 ? 4 : constraints.maxWidth > 520 ? 3 : 2;
                return GridView.builder(padding: const EdgeInsets.fromLTRB(28, 0, 28, 24), itemCount: _models.length, gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: count, crossAxisSpacing: 14, mainAxisSpacing: 14, childAspectRatio: .73), itemBuilder: (context, i) {
                  final model = asMap(_models[i]);
                  final name = firstText(model, const ['name', 'title'], fallback: 'Profile');
                  final image = firstText(model, const ['image_url', 'image', 'thumbnail', 'photo']);
                  final country = firstText(model, const ['country_name', 'country']);
                  return Card(clipBehavior: Clip.antiAlias, child: InkWell(onTap: () => _open(model), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Expanded(child: image.isEmpty ? const ColoredBox(color: vexoCard, child: Center(child: Icon(Icons.person_outline, size: 46, color: Colors.white38))) : Image.network(image, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const ColoredBox(color: vexoCard, child: Center(child: Icon(Icons.person_outline, size: 46, color: Colors.white38))))),
                    Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)), if (country.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 5), child: Text(country, style: const TextStyle(color: Colors.white54, fontSize: 12)))])),
                  ])));
                });
              })),
        if (!_loading && _error == null) Padding(padding: const EdgeInsets.only(bottom: 18), child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          OutlinedButton(onPressed: _page > 1 ? () { setState(() => _page--); _load(); } : null, child: const Text('Previous')),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 18), child: Text('Page $_page')),
          OutlinedButton(onPressed: _hasMore ? () { setState(() => _page++); _load(); } : null, child: const Text('Next')),
        ])),
      ]);
}

class ModelProfilePage extends StatefulWidget {
  const ModelProfilePage({super.key, required this.api, required this.slug, required this.initial});
  final VexoApi api;
  final String slug;
  final Map<String, dynamic> initial;

  @override
  State<ModelProfilePage> createState() => _ModelProfilePageState();
}

class _ModelProfilePageState extends State<ModelProfilePage> {
  late Map<String, dynamic> _model = widget.initial;
  bool _loading = true;
  String? _error;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    try {
      final result = await widget.api.get('/models/${Uri.encodeComponent(widget.slug)}', authenticated: true);
      final map = asMap(result);
      _model = asMap(map['model'] ?? map['profile'] ?? result);
      if (mounted) setState(() => _loading = false);
    } catch (e) { if (mounted) setState(() { _error = e.toString(); _loading = false; }); }
  }

  @override
  Widget build(BuildContext context) {
    final name = firstText(_model, const ['name', 'title'], fallback: 'Performer profile');
    final image = firstText(_model, const ['image_url', 'image', 'thumbnail', 'photo']);
    final summary = firstText(_model, const ['description', 'bio', 'about']);
    final details = _model.entries.where((e) => !{'image_url', 'image', 'thumbnail', 'photo', 'gallery', 'images', 'description', 'bio', 'about'}.contains(e.key) && e.value != null && e.value.toString().trim().isNotEmpty).toList();
    return Scaffold(appBar: AppBar(title: Text(name)), body: _loading ? const PageLoader(label: 'Loading profile…') : _error != null ? ErrorPanel(message: _error!, onRetry: _load) : ListView(padding: const EdgeInsets.all(28), children: [
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (image.isNotEmpty) ClipRRect(borderRadius: BorderRadius.circular(22), child: Image.network(image, width: 250, height: 320, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const SizedBox(width: 250, height: 320, child: Icon(Icons.person, size: 70)))) else const SizedBox(width: 250, height: 320, child: Icon(Icons.person, size: 70)),
        const SizedBox(width: 28),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(name, style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800)), if (summary.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 14), child: Text(summary, style: const TextStyle(color: Colors.white70, height: 1.5))), const SizedBox(height: 18), Wrap(spacing: 10, runSpacing: 10, children: details.map((e) => Chip(label: Text('${_label(e.key)}: ${e.value}'))).toList())])),
      ]),
      const SizedBox(height: 26),
      const Text('Photo gallery', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
      const SizedBox(height: 12),
      _gallery(_model['gallery'] ?? _model['images']),
    ]));
  }

  String _label(String value) => value.replaceAll('_', ' ').replaceAll(RegExp(r'([a-z])([A-Z])'), r'$1 $2').split(' ').map((s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}').join(' ');
  Widget _gallery(dynamic value) {
    final images = asList(value)
        .map((e) => e is Map ? (e['url'] ?? e['image_url'] ?? '').toString() : e.toString())
        .where((e) => e.startsWith('https://'))
        .toList();
    if (images.isEmpty) return const Text('No public gallery photos.', style: TextStyle(color: Colors.white54));
    return Wrap(
      spacing: 12,
      runSpacing: 12,
      children: images.map((url) => ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Image.network(
          url,
          width: 190,
          height: 140,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => const SizedBox(width: 190, height: 140, child: Icon(Icons.broken_image_outlined)),
        ),
      )).toList(),
    );
  }
}

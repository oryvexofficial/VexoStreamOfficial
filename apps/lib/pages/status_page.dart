import 'package:flutter/material.dart';

import '../api/vexo_api.dart';
import '../widgets/vexo_theme.dart';

class StatusPage extends StatefulWidget {
  const StatusPage({super.key, required this.api});
  final VexoApi api;
  @override
  State<StatusPage> createState() => _StatusPageState();
}

class _StatusPageState extends State<StatusPage> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _status = {};
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try { _status = asMap(await widget.api.get('/status')); if (mounted) setState(() => _loading = false); }
    catch (e) { if (mounted) setState(() { _error = e.toString(); _loading = false; }); }
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(28), children: [
        PageHeading(title: 'System status', subtitle: 'Live health checks for the Worker, extraction backend, and enabled libraries.', trailing: IconButton(onPressed: _load, tooltip: 'Refresh', icon: const Icon(Icons.refresh_rounded))),
        if (_loading) const SizedBox(height: 240, child: PageLoader(label: 'Checking VexoStream…'))
        else if (_error != null) ErrorPanel(message: _error!, onRetry: _load)
        else ...[
          Card(child: Padding(padding: const EdgeInsets.all(22), child: Row(children: [Icon(_status['overall'] == 'operational' ? Icons.check_circle_rounded : Icons.warning_rounded, color: _color((_status['overall'] ?? '').toString()), size: 32), const SizedBox(width: 14), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Overall: ${_human((_status['overall'] ?? 'unknown').toString())}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)), Text('Checked ${_time(_status['checked_at'])}', style: const TextStyle(color: Colors.white54))]))]))),
          const SizedBox(height: 14),
          Wrap(spacing: 12, runSpacing: 12, children: _status.entries.where((e) => e.key != 'overall' && e.key != 'checked_at' && e.value is String).map((entry) => SizedBox(width: 230, child: Card(child: Padding(padding: const EdgeInsets.all(16), child: Row(children: [Icon(Icons.circle, size: 12, color: _color(entry.value.toString())), const SizedBox(width: 12), Expanded(child: Text(_human(entry.key), style: const TextStyle(fontWeight: FontWeight.w700))), Text(_human(entry.value.toString()), style: TextStyle(color: _color(entry.value.toString()), fontSize: 12))]))))).toList()),
          const SizedBox(height: 22),
          const Text('Video libraries', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
          const SizedBox(height: 10),
          ...asList(_status['providers']).map((raw) { final p = asMap(raw); final available = p['available'] == true; return Card(child: ListTile(leading: Icon(available ? Icons.check_circle : Icons.pause_circle, color: available ? Colors.greenAccent : Colors.orangeAccent), title: Text((p['name'] ?? p['id'] ?? 'Library').toString()), trailing: Text(available ? 'Available' : _human((p['status'] ?? 'unavailable').toString()), style: TextStyle(color: available ? Colors.greenAccent : Colors.orangeAccent)))); }),
        ],
      ]);

  String _human(String value) => value.replaceAll('_', ' ').split(' ').map((x) => x.isEmpty ? x : '${x[0].toUpperCase()}${x.substring(1)}').join(' ');
  Color _color(String value) => value == 'operational' ? Colors.greenAccent : value == 'degraded' ? Colors.amberAccent : Colors.redAccent;
  String _time(dynamic value) { final date = value is num ? DateTime.fromMillisecondsSinceEpoch(value.toInt()) : DateTime.tryParse((value ?? '').toString()); return date == null ? 'recently' : date.toLocal().toString().split('.').first; }
}

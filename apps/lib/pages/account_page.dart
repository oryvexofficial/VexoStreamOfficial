import 'package:flutter/material.dart';

import '../api/vexo_api.dart';
import '../widgets/vexo_theme.dart';

class AccountPage extends StatefulWidget {
  const AccountPage({super.key, required this.api, required this.onSignIn, required this.onSignedOut});
  final VexoApi api;
  final VoidCallback onSignIn;
  final VoidCallback onSignedOut;
  @override
  State<AccountPage> createState() => _AccountPageState();
}

class _AccountPageState extends State<AccountPage> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _account = {};
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final response = asMap(await widget.api.get('/account', authenticated: true));
      _account = asMap(response['account']);
      if (mounted) setState(() => _loading = false);
    } catch (e) { if (mounted) setState(() { _error = e.toString(); _loading = false; }); }
  }
  Future<void> _signOut() async {
    try { await widget.api.post('/auth/logout', authenticated: true); } catch (_) {}
    await widget.api.clearToken();
    widget.onSignedOut();
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(28), children: [
        const PageHeading(title: 'Account', subtitle: 'Manage your VexoStream app session.'),
        if (_loading) const SizedBox(height: 220, child: PageLoader(label: 'Loading account…'))
        else if (_error != null) ErrorPanel(message: _error!, onRetry: _load, action: FilledButton(onPressed: widget.onSignIn, child: const Text('Sign in')))
        else Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 700), child: Card(child: Padding(padding: const EdgeInsets.all(24), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [CircleAvatar(radius: 28, backgroundColor: vexoPurple.withValues(alpha: .2), child: const Icon(Icons.person, color: vexoPurple, size: 30)), const SizedBox(width: 15), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text((_account['username'] ?? 'Member').toString(), style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)), const Text('VexoStream member', style: TextStyle(color: Colors.white54))]))]),
          const Divider(height: 32),
          _row('Account ID', (_account['id'] ?? '').toString()),
          _row('Joined', (_account['createdAt'] ?? 'Unknown').toString()),
          _row('Last sign-in', (_account['lastLoginAt'] ?? 'Not available').toString()),
          const SizedBox(height: 15),
          const Text('Your app session expires after 30 days. Signing out revokes this device session.', style: TextStyle(color: Colors.white60, height: 1.4)),
          const SizedBox(height: 16),
          OutlinedButton.icon(onPressed: _signOut, icon: const Icon(Icons.logout_rounded), label: const Text('Sign out')),
        ]))))),
      ]);
  Widget _row(String title, String value) => Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Row(children: [SizedBox(width: 135, child: Text(title, style: const TextStyle(color: Colors.white54))), Expanded(child: Text(value))]));
}

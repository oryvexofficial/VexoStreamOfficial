import 'package:flutter/material.dart';

import '../api/vexo_api.dart';
import '../widgets/vexo_theme.dart';

class AuthPage extends StatefulWidget {
  const AuthPage({super.key, required this.api, this.initialSignup = false});
  final VexoApi api;
  final bool initialSignup;

  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  bool _signup = false;
  bool _adult = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() { super.initState(); _signup = widget.initialSignup; }
  @override
  void dispose() { _username.dispose(); _password.dispose(); _confirm.dispose(); super.dispose(); }

  Future<void> _submit() async {
    if (_signup && !_adult) { setState(() => _error = 'Confirm you are 18 or older to create an account.'); return; }
    setState(() { _busy = true; _error = null; });
    try {
      final response = asMap(await widget.api.post(_signup ? '/auth/signup' : '/auth/login', body: {
        'username': _username.text.trim(),
        'password': _password.text,
        if (_signup) 'passwordConfirm': _confirm.text,
        if (_signup) 'adult': _adult,
      }));
      final token = (response['token'] ?? '').toString();
      if (token.isEmpty) throw const ApiException('The server did not issue a session token.');
      await widget.api.saveToken(token);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('VexoStream account')),
        body: Center(child: SingleChildScrollView(padding: const EdgeInsets.all(24), child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 460), child: Card(child: Padding(padding: const EdgeInsets.all(28), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Image.asset('assets/brand/vexostream-logo.png', height: 48, alignment: Alignment.centerLeft, errorBuilder: (_, __, ___) => const Text('VexoStream', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w900))),
          const SizedBox(height: 18),
          Text(_signup ? 'Create your account' : 'Welcome back', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 7),
          const Text('Accounts are protected with an encrypted connection and revocable app sessions.', style: TextStyle(color: Colors.white60)),
          const SizedBox(height: 22),
          TextField(controller: _username, textInputAction: TextInputAction.next, autofillHints: const [AutofillHints.username], decoration: const InputDecoration(labelText: 'Username', prefixIcon: Icon(Icons.person_outline))),
          const SizedBox(height: 13),
          TextField(controller: _password, obscureText: true, textInputAction: _signup ? TextInputAction.next : TextInputAction.done, onSubmitted: (_) => _signup ? null : _submit(), autofillHints: [_signup ? AutofillHints.newPassword : AutofillHints.password], decoration: const InputDecoration(labelText: 'Password', prefixIcon: Icon(Icons.lock_outline))),
          if (_signup) ...[
            const SizedBox(height: 13),
            TextField(controller: _confirm, obscureText: true, textInputAction: TextInputAction.done, onSubmitted: (_) => _submit(), decoration: const InputDecoration(labelText: 'Confirm password', prefixIcon: Icon(Icons.lock_reset_rounded))),
            const SizedBox(height: 8),
            CheckboxListTile(contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading, value: _adult, onChanged: (value) => setState(() => _adult = value ?? false), title: const Text('I confirm that I am 18 or older.', style: TextStyle(fontSize: 13))),
          ],
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(color: Colors.orangeAccent))),
          const SizedBox(height: 15),
          FilledButton(onPressed: _busy ? null : _submit, child: Padding(padding: const EdgeInsets.symmetric(vertical: 11), child: _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : Text(_signup ? 'Create account' : 'Sign in'))),
          const SizedBox(height: 10),
          TextButton(onPressed: _busy ? null : () => setState(() { _signup = !_signup; _error = null; }), child: Text(_signup ? 'Already have an account? Sign in' : 'New here? Create an account')),
          const SizedBox(height: 5),
          const Text('18+ only. Keep your login private and use a unique password.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white38, fontSize: 12)),
        ])))))) ,
      );
}

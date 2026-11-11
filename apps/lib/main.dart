import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:media_kit/media_kit.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api/vexo_api.dart';
import 'pages/account_page.dart';
import 'pages/auth_page.dart';
import 'pages/catalog_page.dart';
import 'pages/check_host_page.dart';
import 'pages/developers_page.dart';
import 'pages/home_page.dart';
import 'pages/models_page.dart';
import 'pages/player_page.dart';
import 'pages/social_page.dart';
import 'pages/status_page.dart';
import 'widgets/vexo_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  MediaKit.ensureInitialized();
  runApp(const VexoApp());
}

class VexoApp extends StatefulWidget {
  const VexoApp({super.key});
  @override
  State<VexoApp> createState() => _VexoAppState();
}

class _VexoAppState extends State<VexoApp> {
  final VexoApi _api = VexoApi();
  bool _ready = false;
  bool _ageAccepted = false;
  bool _blocked = false;
  bool _hasToken = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final preferences = await SharedPreferences.getInstance();
    final token = await _api.loadToken();
    if (!mounted) return;
    setState(() {
      _ready = true;
      _ageAccepted = preferences.getBool('vexostream.adult.confirmed') == true;
      _hasToken = token != null && token.isNotEmpty;
    });
  }

  Future<void> _acceptAge() async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setBool('vexostream.adult.confirmed', true);
    if (mounted) setState(() { _ageAccepted = true; _blocked = false; });
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'VexoStream',
        debugShowCheckedModeBanner: false,
        theme: buildVexoTheme(),
        home: !_ready
            ? const Scaffold(body: PageLoader(label: 'Starting VexoStream…'))
            : _blocked
                ? const _AgeBlockedPage()
                : !_ageAccepted
                    ? _AgeGate(onAccept: _acceptAge, onReject: () => setState(() => _blocked = true))
                    : VexoShell(api: _api, hasToken: _hasToken, onTokenChanged: (value) => setState(() => _hasToken = value)),
      );
}

class _AgeGate extends StatelessWidget {
  const _AgeGate({required this.onAccept, required this.onReject});
  final VoidCallback onAccept;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 620), child: Card(child: Padding(padding: const EdgeInsets.all(34), child: Column(mainAxisSize: MainAxisSize.min, children: [
        Image.asset('assets/brand/vexostream-logo.png', height: 52, errorBuilder: (_, __, ___) => const Text('VexoStream', style: TextStyle(fontSize: 30, fontWeight: FontWeight.w900))),
        const SizedBox(height: 25),
        const Icon(Icons.lock_rounded, size: 52, color: vexoPink),
        const SizedBox(height: 14),
        Text('Adults only', style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w900)),
        const SizedBox(height: 10),
        const Text('This app is intended only for adults aged 18 or older. By continuing, you confirm you meet the legal age requirement where you live and agree to use the app responsibly.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white70, height: 1.5)),
        const SizedBox(height: 24),
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [FilledButton(onPressed: onAccept, child: const Text('I am 18 or older')), const SizedBox(width: 12), OutlinedButton(onPressed: onReject, child: const Text('Exit'))]),
      ]))))));
}

class _AgeBlockedPage extends StatelessWidget {
  const _AgeBlockedPage();
  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [const Icon(Icons.lock_outline, size: 44, color: Colors.white54), const SizedBox(height: 14), const Text('VexoStream is for adults only.', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)), const SizedBox(height: 14), OutlinedButton(onPressed: SystemNavigator.pop, child: const Text('Close app'))])));
}

class VexoShell extends StatefulWidget {
  const VexoShell({super.key, required this.api, required this.hasToken, required this.onTokenChanged});
  final VexoApi api;
  final bool hasToken;
  final ValueChanged<bool> onTokenChanged;
  @override
  State<VexoShell> createState() => _VexoShellState();
}

class _VexoShellState extends State<VexoShell> {
  int _selected = 0;
  String _searchQuery = '';
  String _searchProvider = '';
  int _catalogRefresh = 0;
  int _accountRefresh = 0;

  static const _titles = ['Home', 'Browse', 'Performers', 'System status', 'Social', 'Developers', 'Check host', 'Account'];
  static const _icons = [Icons.home_rounded, Icons.video_library_rounded, Icons.people_alt_rounded, Icons.monitor_heart_rounded, Icons.forum_rounded, Icons.code_rounded, Icons.dns_rounded, Icons.person_rounded];

  Future<void> _openAuth({bool signup = false}) async {
    final ok = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => AuthPage(api: widget.api, initialSignup: signup)));
    if (ok == true && mounted) {
      widget.onTokenChanged(true);
      setState(() { _selected = 7; _accountRefresh++; });
    }
  }

  void _openPlayer(Map<String, dynamic> video) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => PlayerPage(api: widget.api, video: video, onSignIn: () => _openAuth())));
  }

  void _openBrowse() {
    setState(() { _selected = 1; _searchQuery = ''; _searchProvider = ''; _catalogRefresh++; });
  }

  void _startSearch(String query, String provider) {
    setState(() {
      _searchQuery = query;
      _searchProvider = provider;
      _catalogRefresh++;
      _selected = 1;
    });
  }

  Widget _page() {
    switch (_selected) {
      case 0:
        return HomePage(api: widget.api, onPlay: _openPlayer, onBrowse: _openBrowse, onSearch: _startSearch);
      case 1:
        return CatalogPage(key: ValueKey('catalog-$_catalogRefresh'), api: widget.api, onPlay: _openPlayer, initialQuery: _searchQuery, initialProvider: _searchProvider);
      case 2:
        return ModelsPage(api: widget.api, onSignIn: () => _openAuth());
      case 3:
        return StatusPage(api: widget.api);
      case 4:
        return SocialPage(api: widget.api);
      case 5:
        return DevelopersPage(api: widget.api);
      case 6:
        return CheckHostPage(api: widget.api);
      case 7:
        return AccountPage(key: ValueKey('account-$_accountRefresh'), api: widget.api, onSignIn: () => _openAuth(), onSignedOut: () { widget.onTokenChanged(false); setState(() => _selected = 0); });
      default:
        return HomePage(api: widget.api, onPlay: _openPlayer, onBrowse: _openBrowse, onSearch: _startSearch);
    }
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, constraints) {
        final extended = constraints.maxWidth >= 1160;
        return Scaffold(
          appBar: AppBar(
            title: Row(children: [Image.asset('assets/brand/vexostream-mark-512.png', width: 30, height: 30, errorBuilder: (_, __, ___) => const Icon(Icons.play_circle_fill, color: vexoPurple)), const SizedBox(width: 10), const Text('VexoStream', style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: -.3)), const SizedBox(width: 14), Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4), decoration: BoxDecoration(color: vexoPink.withValues(alpha: .12), borderRadius: BorderRadius.circular(20)), child: const Text('18+', style: TextStyle(color: Color(0xFFFF8DBA), fontSize: 10, fontWeight: FontWeight.w800))) ]),
            actions: [
              if (widget.hasToken) IconButton(tooltip: 'Account', onPressed: () => setState(() => _selected = 7), icon: const Icon(Icons.account_circle_outlined))
              else TextButton.icon(onPressed: () => _openAuth(), icon: const Icon(Icons.login_rounded), label: const Text('Sign in')),
              const SizedBox(width: 12),
            ],
          ),
          body: Row(children: [
            NavigationRail(
              extended: extended,
              selectedIndex: _selected,
              onDestinationSelected: (index) => setState(() => _selected = index),
              leading: Padding(padding: const EdgeInsets.only(bottom: 18), child: Tooltip(message: 'VexoStream', child: Container(width: 44, height: 44, decoration: BoxDecoration(gradient: const LinearGradient(colors: [vexoPurple, vexoPink]), borderRadius: BorderRadius.circular(14)), child: const Icon(Icons.play_arrow_rounded, color: Colors.white, size: 28)))),
              destinations: List.generate(_titles.length, (i) => NavigationRailDestination(icon: Icon(_icons[i]), selectedIcon: Icon(_icons[i]), label: Text(_titles[i]))),
            ),
            const VerticalDivider(width: 1, thickness: 1),
            Expanded(child: _page()),
          ]),
        );
      });
}

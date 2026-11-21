import 'dart:async';
import 'dart:io';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api/live_viewers.dart';
import 'api/release_update.dart';
import 'api/vexo_api.dart';
import 'pages/account_page.dart';
import 'pages/admin_page.dart';
import 'pages/auth_page.dart';
import 'pages/catalog_page.dart';
import 'pages/check_host_page.dart';
import 'pages/developers_page.dart';
import 'pages/home_page.dart';
import 'pages/models_page.dart';
import 'pages/embedded_player_page.dart' as embedded_player;
import 'pages/social_page.dart';
import 'pages/status_page.dart';
import 'widgets/vexo_theme.dart';
import 'widgets/offline_monitor.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
    statusBarBrightness: Brightness.dark,
    systemNavigationBarColor: Vx.bg,
    systemNavigationBarIconBrightness: Brightness.light,
  ));
  runApp(const VexoApp());
}

class VexoApp extends StatefulWidget {
  const VexoApp({super.key});
  @override
  State<VexoApp> createState() => _VexoAppState();
}

class _VexoAppState extends State<VexoApp> {
  final VexoApi _api = VexoApi();
  final ReleaseUpdateChecker _updateChecker = ReleaseUpdateChecker();
  bool _ready = false;
  bool _adult = false;
  bool _blocked = false;
  bool _signedIn = false;
  bool _checkingUpdate = false;
  bool _continueWithoutUpdateCheck = false;
  UpdateCheckResult? _updateResult;
  AppLifecycleListener? _lifecycleListener;

  @override
  void initState() {
    super.initState();
    _lifecycleListener = AppLifecycleListener(
      onExitRequested: () async {
        _updateChecker.close();
        _api.close();
        return AppExitResponse.exit;
      },
      onDetach: () {
        _updateChecker.close();
        _api.close();
      },
    );
    _init();
  }

  Future<void> _init() async {
    var adultConfirmed = false;
    try { adultConfirmed = (await SharedPreferences.getInstance()).getBool('vexostream.adult.confirmed') == true; } catch (_) {}
    String? token;
    try { token = await _api.loadToken(); } catch (_) {}
    if (adultConfirmed) await _checkForUpdates();
    if (!mounted) return;
    setState(() {
      _ready = true;
      _adult = adultConfirmed;
      _signedIn = (token ?? '').isNotEmpty;
    });
  }

  Future<void> _acceptAge() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool('vexostream.adult.confirmed', true);
    } catch (_) {}
    if (!mounted) return;
    setState(() => _adult = true);
    await _checkForUpdates();
  }

  Future<void> _checkForUpdates() async {
    if (!mounted) return;
    setState(() {
      _checkingUpdate = true;
      _continueWithoutUpdateCheck = false;
    });
    final platform = Platform.isWindows
        ? ReleasePlatform.windows
        : Platform.isAndroid
            ? ReleasePlatform.android
            : ReleasePlatform.other;
    final result = await _updateChecker.check(platform: platform);
    if (!mounted) return;
    setState(() {
      _updateResult = result;
      _checkingUpdate = false;
    });
  }

  void _onReconnected() {
    final status = _updateResult?.status;
    if (_adult &&
        !_checkingUpdate &&
        _updateChecker.isConfigured &&
        (status == UpdateCheckStatus.failed || _continueWithoutUpdateCheck)) {
      unawaited(_checkForUpdates());
    }
  }

  Widget _home() {
    if (!_ready) return const _AppStartupLoader();
    if (_blocked) return const _AgeBlockedPage();
    if (!_adult) {
      return _AgeGate(
        onAccept: _acceptAge,
        onReject: () => setState(() => _blocked = true),
      );
    }
    if (_checkingUpdate) return const _UpdateCheckingPage();

    final result = _updateResult;
    if (result?.status == UpdateCheckStatus.updateAvailable &&
        result?.release != null) {
      return _MandatoryUpdatePage(
        release: result!.release!,
        onRetry: _checkForUpdates,
      );
    }
    if (!_continueWithoutUpdateCheck &&
        (result == null ||
            result.status == UpdateCheckStatus.failed ||
            result.status == UpdateCheckStatus.notConfigured)) {
      return _UpdateCheckAttentionPage(
        message: result?.message ??
            'The installed version has not been verified.',
        onRetry: _checkForUpdates,
        onContinue: () => setState(() => _continueWithoutUpdateCheck = true),
      );
    }

    final shell = ValueListenableBuilder<BannedAccountInfo?>(
      valueListenable: _api.bannedAccount,
      builder: (context, banned, _) {
        if (banned != null) {
          return _BannedAccountPage(
            info: banned,
            onDismiss: () {
              _api.bannedAccount.value = null;
              setState(() => _signedIn = false);
            },
          );
        }
        return VexoShell(
          api: _api,
          signedIn: _signedIn,
          onSessionChanged: (value) => setState(() => _signedIn = value),
        );
      },
    );
    if (!_continueWithoutUpdateCheck) return shell;
    return Material(
      color: Vx.bg,
      child: Column(
        children: [
          MaterialBanner(
            leading: const Icon(Icons.warning_amber_rounded, color: Vx.amber),
            content: const Text(
              'Update check was skipped. This version has not been verified.',
            ),
            actions: [
              TextButton(
                onPressed: _checkForUpdates,
                child: const Text('Retry'),
              ),
            ],
          ),
          Expanded(child: shell),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'VexoStream',
        debugShowCheckedModeBanner: false,
        theme: buildVexoTheme(),
        darkTheme: buildVexoTheme(),
        themeMode: ThemeMode.dark,
        builder: (context, child) => OfflineMonitor(
          onReconnected: _onReconnected,
          child: child ?? const SizedBox.shrink(),
        ),
        home: _home(),
      );

  @override
  void dispose() {
    _lifecycleListener?.dispose();
    _updateChecker.close();
    _api.close();
    super.dispose();
  }
}

class _UpdateCheckingPage extends StatelessWidget {
  const _UpdateCheckingPage();

  @override
  Widget build(BuildContext context) => const _UpdateModalFrame(
        icon: Icons.system_update_alt_rounded,
        title: 'Checking for updates',
        body: 'Checking the latest stable VexoStream release…',
        child: Padding(
          padding: EdgeInsets.only(top: 20),
          child: CircularProgressIndicator(),
        ),
      );
}

class _UpdateCheckAttentionPage extends StatelessWidget {
  const _UpdateCheckAttentionPage({
    required this.message,
    required this.onRetry,
    required this.onContinue,
  });

  final String message;
  final VoidCallback onRetry;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) => _UpdateModalFrame(
        icon: Icons.cloud_off_rounded,
        title: 'Update check unavailable',
        body: message.contains('not been verified')
            ? message
            : '$message\n\nYour installed version has not been verified.',
        child: Padding(
          padding: const EdgeInsets.only(top: 22),
          child: Wrap(
            alignment: WrapAlignment.center,
            spacing: 10,
            runSpacing: 8,
            children: [
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Retry'),
              ),
              TextButton(
                onPressed: onContinue,
                child: const Text('Continue without checking'),
              ),
            ],
          ),
        ),
      );
}

class _MandatoryUpdatePage extends StatefulWidget {
  const _MandatoryUpdatePage({required this.release, required this.onRetry});

  final AppRelease release;
  final VoidCallback onRetry;

  @override
  State<_MandatoryUpdatePage> createState() => _MandatoryUpdatePageState();
}

class _MandatoryUpdatePageState extends State<_MandatoryUpdatePage> {
  bool _launchFailed = false;

  Future<void> _openDownload() async {
    var opened = false;
    try {
      opened = await launchUrl(
        widget.release.downloadUrl,
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {}
    if (mounted) setState(() => _launchFailed = !opened);
  }

  Future<void> _copyDownloadLink() async {
    await Clipboard.setData(
      ClipboardData(text: widget.release.downloadUrl.toString()),
    );
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Download link copied')),
    );
  }

  @override
  Widget build(BuildContext context) => _UpdateModalFrame(
        icon: Icons.system_update_rounded,
        title: 'Update required',
        body:
            'VexoStream ${widget.release.version} is available. Install the latest stable version to continue.',
        child: Padding(
          padding: const EdgeInsets.only(top: 22),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              FilledButton.icon(
                onPressed: _openDownload,
                icon: const Icon(Icons.download_rounded),
                label: const Text('Download update'),
              ),
              if (_launchFailed) ...[
                const SizedBox(height: 10),
                Text(
                  'Could not open the download. Copy the verified link or view the release page.',
                  textAlign: TextAlign.center,
                  style: Vx.sans(size: 13, color: Vx.text2),
                ),
                Wrap(
                  alignment: WrapAlignment.center,
                  children: [
                    TextButton(
                      onPressed: _copyDownloadLink,
                      child: const Text('Copy download link'),
                    ),
                    TextButton(
                      onPressed: () async {
                        try {
                          await launchUrl(
                            widget.release.releaseUrl,
                            mode: LaunchMode.externalApplication,
                          );
                        } catch (_) {}
                      },
                      child: const Text('Release page'),
                    ),
                  ],
                ),
              ],
              TextButton(
                onPressed: widget.onRetry,
                child: const Text('Check again'),
              ),
            ],
          ),
        ),
      );
}

class _UpdateModalFrame extends StatelessWidget {
  const _UpdateModalFrame({
    required this.icon,
    required this.title,
    required this.body,
    this.child,
  });

  final IconData icon;
  final String title;
  final String body;
  final Widget? child;

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Vx.bg,
        body: Stack(
          fit: StackFit.expand,
          children: [
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment(0, -.2),
                  radius: 1.1,
                  colors: [Color(0xFF111923), Vx.bg],
                ),
              ),
            ),
            const ModalBarrier(
              dismissible: false,
              color: Color(0xAA000000),
            ),
            Center(
              child: Dialog(
                insetPadding: const EdgeInsets.all(24),
                backgroundColor: Vx.panel,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(Vx.radius2xl),
                  side: const BorderSide(color: Vx.line),
                ),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 470),
                  child: Padding(
                    padding: const EdgeInsets.all(30),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(icon, color: Vx.blue, size: 42),
                        const SizedBox(height: 18),
                        Text(
                          title,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        const SizedBox(height: 10),
                        Text(
                          body,
                          textAlign: TextAlign.center,
                          style: Vx.sans(size: 14, color: Vx.text2, height: 1.5),
                        ),
                        if (child != null) child!,
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );
}

class _AppStartupLoader extends StatelessWidget {
  const _AppStartupLoader();

  @override
  Widget build(BuildContext context) => Scaffold(
        body: DecoratedBox(
          decoration: const BoxDecoration(
            gradient: RadialGradient(
              center: Alignment(0, -.15),
              radius: 1.1,
              colors: [Color(0xFF111923), Vx.bg],
            ),
          ),
          child: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Container(
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  color: Vx.panel,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: Vx.line),
                  boxShadow: const [BoxShadow(color: Color(0x55000000), blurRadius: 36, offset: Offset(0, 14))],
                ),
                child: const _BrandMark(size: 58),
              ),
              const SizedBox(height: 28),
              const SizedBox(width: 30, height: 30, child: CircularProgressIndicator(strokeWidth: 2.6)),
              const SizedBox(height: 16),
              Text('Getting VexoStream ready…', style: Vx.sans(size: 14, color: Vx.text2, weight: FontWeight.w500)),
            ]),
          ),
        ),
      );
}

class _BrandMark extends StatelessWidget {
  const _BrandMark({this.size = 32});
  final double size;
  @override
  Widget build(BuildContext context) => Image.asset('assets/brand/vexostream-mark-512.png', width: size, height: size, filterQuality: FilterQuality.medium);
}

class _AgeGate extends StatelessWidget {
  const _AgeGate({required this.onAccept, required this.onReject});
  final VoidCallback onAccept;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Container(
            margin: const EdgeInsets.all(24),
            padding: const EdgeInsets.fromLTRB(34, 36, 34, 30),
            decoration: BoxDecoration(
              color: Vx.panel,
              borderRadius: BorderRadius.circular(Vx.radius2xl),
              border: Border.all(color: Vx.line),
              boxShadow: const [BoxShadow(color: Color(0xE6000000), blurRadius: 50, offset: Offset(0, 26), spreadRadius: -24)],
            ),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const _BrandMark(size: 60),
              const SizedBox(height: 22),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                decoration: BoxDecoration(color: Vx.red.withValues(alpha: .12), borderRadius: BorderRadius.circular(999)),
                child: Text('18+', style: Vx.mono(size: 13, weight: FontWeight.w600, color: Vx.red, spacing: 1)),
              ),
              const SizedBox(height: 16),
              Text('Adults only', style: t.headlineMedium),
              const SizedBox(height: 10),
              Text(
                'VexoStream shows adult content. Continue only if you are 18 or older and it is legal where you live.',
                textAlign: TextAlign.center,
                style: t.bodyMedium?.copyWith(fontSize: 15),
              ),
              const SizedBox(height: 26),
              FilledButton(onPressed: onAccept, style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)), child: const Text('I am 18 or older, enter')),
              const SizedBox(height: 10),
              TextButton(onPressed: onReject, child: Text('Leave', style: Vx.sans(size: 14, color: Vx.text3))),
            ]),
          ),
        ),
      ),
    );
  }
}

class _AgeBlockedPage extends StatelessWidget {
  const _AgeBlockedPage();
  @override
  Widget build(BuildContext context) => Scaffold(
        body: ErrorPanel(
          title: 'VexoStream is for adults only.',
          message: 'You can close the app now.',
          icon: Icons.lock_outline_rounded,
          action: OutlinedButton(onPressed: () => exit(0), child: const Text('Close app')),
        ),
      );
}

class _AppMaintenancePage extends StatefulWidget {
  const _AppMaintenancePage({required this.api, this.onSignIn});
  final VexoApi api;
  final VoidCallback? onSignIn;
  @override
  State<_AppMaintenancePage> createState() => _AppMaintenancePageState();
}

class _AppMaintenancePageState extends State<_AppMaintenancePage> {
  bool _checking = false;
  Future<void> _checkAgain() async {
    setState(() => _checking = true);
    try { await widget.api.get('/config'); } catch (_) {}
    if (mounted) setState(() => _checking = false);
  }

  @override
  Widget build(BuildContext context) => Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.build_circle_outlined, size: 52, color: Vx.amber),
              const SizedBox(height: 20),
              Text('We’ll be right back.', style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
              const SizedBox(height: 10),
              Text('VexoStream is getting a quick tune-up. Try again in a few minutes.', style: Vx.sans(size: 15, color: Vx.text2), textAlign: TextAlign.center),
              const SizedBox(height: 20),
              if (widget.onSignIn != null) ...[
                FilledButton.icon(onPressed: widget.onSignIn, icon: const Icon(Icons.login_rounded), label: const Text('Owner / Admin log in')),
                const SizedBox(height: 10),
              ],
              OutlinedButton.icon(onPressed: _checking ? null : _checkAgain, icon: const Icon(Icons.refresh_rounded), label: Text(_checking ? 'Checking…' : 'Check again')),
            ]),
          ),
        ),
      );
}

class _AdminToolsLockedPage extends StatelessWidget {
  const _AdminToolsLockedPage();

  @override
  Widget build(BuildContext context) => Center(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.lock_outline_rounded, size: 34, color: Vx.blue),
                const SizedBox(height: 12),
                Text(
                  'Owner or admin access required',
                  style: Vx.sans(size: 18, weight: FontWeight.w700),
                ),
                const SizedBox(height: 6),
                Text(
                  'Sign in with an owner or admin account to open developer tools.',
                  textAlign: TextAlign.center,
                  style: Vx.sans(size: 14, color: Vx.text2),
                ),
              ],
            ),
          ),
        ),
      );
}

enum _Page { home, browse, models, social, developers, status, checkHost, admin, account }

class VexoShell extends StatefulWidget {
  const VexoShell({super.key, required this.api, required this.signedIn, required this.onSessionChanged});
  final VexoApi api;
  final bool signedIn;
  final ValueChanged<bool> onSessionChanged;
  @override
  State<VexoShell> createState() => _VexoShellState();
}

class _VexoShellState extends State<VexoShell> with WidgetsBindingObserver {
  _Page _page = _Page.home;
  String _query = '';
  String _provider = '';
  int _homeKey = 0;
  int _browseKey = 0;
  int _accountKey = 0;
  List<Map<String, dynamic>> _providers = [];
  List<Map<String, dynamic>> _notices = [];
  Map<String, String> _dismissedNotices = {};
  String _username = '';
  bool _isAdmin = false;
  final _search = TextEditingController();
  late final LiveViewersController _liveViewers = LiveViewersController(widget.api);
  Timer? _maintenancePoll;
  bool _maintenanceProbeRunning = false;

  static const _nav = [
    (_Page.home, 'Home', Icons.home_outlined, Icons.home_rounded),
    (_Page.browse, 'Browse', Icons.video_library_outlined, Icons.video_library_rounded),
    (_Page.models, 'Models', Icons.people_alt_outlined, Icons.people_alt_rounded),
    (_Page.social, 'Social media', Icons.forum_outlined, Icons.forum_rounded),
    (_Page.developers, 'Developer tools', Icons.code_rounded, Icons.code_rounded),
    (_Page.status, 'Status', Icons.monitor_heart_outlined, Icons.monitor_heart_rounded),
    (_Page.checkHost, 'Check host', Icons.dns_outlined, Icons.dns_rounded),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadProviders();
    _loadAccount();
    unawaited(_liveViewers.start());
    _maintenancePoll = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_probeMaintenance()));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _liveViewers.resume();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      _liveViewers.pause();
    }
  }

  Future<void> _probeMaintenance() async {
    if (_maintenanceProbeRunning || !mounted) return;
    _maintenanceProbeRunning = true;
    try { await widget.api.get('/config', timeout: const Duration(seconds: 10)); } catch (_) {}
    finally { _maintenanceProbeRunning = false; }
  }

  @override
  void didUpdateWidget(covariant VexoShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.signedIn != widget.signedIn) _loadAccount();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _maintenancePoll?.cancel();
    _liveViewers.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _loadProviders() async {
    try {
      final config = asMap(await widget.api.get('/config'));
      final rawList = asList(config['notices']).map(asMap).toList();
      if (rawList.isEmpty && asMap(config['notice']).isNotEmpty) {
        rawList.add(asMap(config['notice']));
      }
      final dismissed = <String, String>{};
      try {
        final prefs = await SharedPreferences.getInstance();
        for (final item in rawList) {
          final id = (item['id'] ?? 'default').toString();
          final v = prefs.getString('vexostream.notice.dismissed.$id');
          if (v != null) dismissed[id] = v;
        }
      } catch (_) {}
      if (mounted) {
        setState(() {
          _providers = asList(config['providers']).map(asMap).toList();
          _notices = rawList;
          _dismissedNotices = dismissed;
        });
      }
    } catch (_) {}
  }

  List<Map<String, dynamic>> get _visibleNotices => _notices.where((n) {
        if (n['enabled'] != true) return false;
        if (firstText(n, const ['title', 'message']).isEmpty) return false;
        final aud = (n['audience'] ?? 'all').toString();
        if (aud == 'in' && !widget.signedIn) return false;
        if (aud == 'out' && widget.signedIn) return false;
        final id = (n['id'] ?? 'default').toString();
        final stamp = (n['updatedAt'] ?? 0).toString();
        if (n['dismissible'] != false && stamp != '0' && _dismissedNotices[id] == stamp) {
          return false;
        }
        return true;
      }).toList();

  Future<void> _dismissNotice(Map<String, dynamic> notice) async {
    final id = (notice['id'] ?? 'default').toString();
    final stamp = (notice['updatedAt'] ?? 0).toString();
    if (mounted) {
      setState(() => _dismissedNotices = {..._dismissedNotices, id: stamp});
    }
    if (stamp != '0') {
      try {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('vexostream.notice.dismissed.$id', stamp);
      } catch (_) {}
    }
  }

  Future<void> _openNoticeLink(String rawUrl) async {
    final u = rawUrl.trim();
    if (u.isEmpty) return;
    if (u.startsWith('/')) {
      if (u.startsWith('/models')) _go(_Page.models);
      else if (u.startsWith('/browse') || u.startsWith('/search')) _go(_Page.browse);
      else if (u.startsWith('/status')) _go(_Page.status);
      else if (u.startsWith('/social')) _go(_Page.social);
      return;
    }
    final uri = Uri.tryParse(u);
    if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  Future<void> _loadAccount() async {
    if (!widget.signedIn) {
      if (mounted) setState(() {
        _username = '';
        _isAdmin = false;
        if (_page == _Page.developers || _page == _Page.admin) {
          _page = _Page.home;
        }
      });
      return;
    }
    try {
      final data = asMap(await widget.api.get('/account', authenticated: true));
      final account = asMap(data['account']);
      if (!widget.signedIn) return;
      final canAccessTools = canAccessDeveloperTools(account);
      if (mounted) setState(() {
        _username = (account['username'] ?? '').toString();
        _isAdmin = canAccessTools;
        if (!canAccessTools &&
            (_page == _Page.developers || _page == _Page.admin)) {
          _page = _Page.home;
        }
      });
      if (_isAdmin) _loadProviders();
    } on ApiException catch (e) {
      if (e.needsLogin) {
        await widget.api.clearToken();
        widget.onSessionChanged(false);
      }
    } catch (_) {}
  }

  Future<void> _openAuth({bool signup = false}) async {
    final ok = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => AuthPage(api: widget.api, initialSignup: signup)));
    if (ok == true && mounted) {
      widget.onSessionChanged(true);
      setState(() => _accountKey++);
    }
  }

  void _openPlayer(Map<String, dynamic> video) {
    Navigator.of(context).push<void>(MaterialPageRoute(
      builder: (_) => embedded_player.PlayerPage(
        api: widget.api,
        video: video,
        onSignIn: () => _openAuth(),
      ),
    )).then((_) {
      if (mounted) setState(() => _homeKey++);
    });
  }

  void _browse(String provider, {String query = ''}) {
    setState(() {
      _provider = provider;
      _query = query;
      _browseKey++;
      _page = _Page.browse;
    });
  }

  void _go(_Page page) {
    if (page == _Page.browse) return _browse(_provider);
    if ((page == _Page.developers || page == _Page.admin) && !_isAdmin) {
      return;
    }
    setState(() => _page = page);
  }

  Widget _body() => switch (_page) {
        _Page.home => HomePage(key: ValueKey('home-$_homeKey'), api: widget.api, liveViewers: _liveViewers, onPlay: _openPlayer, onBrowse: (p) => _browse(p), onSearch: (q, p) => _browse(p, query: q)),
        _Page.browse => CatalogPage(key: ValueKey('browse-$_browseKey'), api: widget.api, onPlay: _openPlayer, initialQuery: _query, initialProvider: _provider),
        _Page.models => ModelsPage(api: widget.api, onSignIn: () => _openAuth(), onPlay: _openPlayer, onSearch: (q, p) => _browse(p, query: q)),
        _Page.social => SocialPage(api: widget.api),
        _Page.developers => _isAdmin
            ? DevelopersPage(api: widget.api)
            : const _AdminToolsLockedPage(),
        _Page.status => StatusPage(api: widget.api),
        _Page.checkHost => CheckHostPage(api: widget.api),
        _Page.admin => _isAdmin
            ? AdminPage(
                api: widget.api,
                onNavigate: (destination) => setState(() {
                  _page = switch (destination) {
                    AdminDestination.home => _Page.home,
                    AdminDestination.social => _Page.social,
                    AdminDestination.status => _Page.status,
                  };
                }),
              )
            : const _AdminToolsLockedPage(),
        _Page.account => AccountPage(
            key: ValueKey('account-$_accountKey-${widget.signedIn}'),
            api: widget.api,
            onSignIn: () => _openAuth(),
            onOpenAdmin: () => _go(_Page.admin),
            onSignedOut: () {
              widget.onSessionChanged(false);
              setState(() => _page = _Page.home);
              _loadProviders();
            },
          ),
      };

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<SiteSuspensionInfo?>(
        valueListenable: widget.api.siteSuspension,
        builder: (context, suspension, _) {
          if (suspension != null && !_isAdmin) {
            return Scaffold(
              backgroundColor: const Color(0xFF05070C),
              body: SafeArea(
                child: _SiteSuspendedPage(api: widget.api, info: suspension, onSignIn: () => _openAuth()),
              ),
            );
          }
          return ValueListenableBuilder<bool>(
            valueListenable: widget.api.maintenanceMode,
            builder: (context, maintenance, _) {
              if (maintenance && !_isAdmin) {
                return Scaffold(
                  backgroundColor: Vx.bg,
                  body: SafeArea(
                    child: _AppMaintenancePage(api: widget.api, onSignIn: () => _openAuth()),
                  ),
                );
              }
              return LayoutBuilder(builder: (context, c) {
                final wide = c.maxWidth >= 1100;
                final phone = c.maxWidth < 600;
                return Scaffold(
                  drawer: phone ? Drawer(child: SafeArea(child: _sidebar(true, drawer: true))) : null,
                  body: Column(children: [
                    ColoredBox(
                      color: Vx.bg,
                      child: SafeArea(
                        bottom: false,
                        child: _topBar(wide, phone),
                      ),
                    ),
                    Expanded(
                      child: SafeArea(
                        top: false,
                        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          if (!phone) _sidebar(wide),
                          Expanded(
                            child: Column(children: [
                              for (final n in _visibleNotices)
                                _OwnerNoticeBanner(
                                  key: ValueKey('notice-${n['id'] ?? 'default'}-${n['updatedAt'] ?? 0}'),
                                  notice: n,
                                  onDismiss: n['dismissible'] != false ? () => _dismissNotice(n) : null,
                                  onLinkTap: _openNoticeLink,
                                ),
                              Expanded(
                                child: AnimatedSwitcher(
                                  duration: const Duration(milliseconds: 260),
                                  switchInCurve: Vx.ease,
                                  transitionBuilder: (child, a) => FadeTransition(opacity: a, child: ScaleTransition(scale: Tween(begin: .985, end: 1.0).animate(a), child: child)),
                                  child: KeyedSubtree(key: ValueKey('${_page.name}-$_browseKey-$_accountKey'), child: _body()),
                                ),
                              ),
                            ]),
                          ),
                        ]),
                      ),
                    ),
                  ]),
                );
              });
            },
          );
        },
      );

  Widget _topBar(bool wide, bool phone) => Container(
        height: phone ? 60 : 64,
        padding: EdgeInsets.symmetric(horizontal: phone ? 10 : 20),
        decoration: const BoxDecoration(color: Vx.bg, border: Border(bottom: BorderSide(color: Vx.line))),
        child: Row(children: [
          if (phone)
            Builder(builder: (context) => IconButton(
              tooltip: 'Open navigation',
              onPressed: () => Scaffold.of(context).openDrawer(),
              icon: const Icon(Icons.menu),
            )),
          MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: () => _go(_Page.home),
              child: wide ? Image.asset('assets/brand/vexostream-logo-dark.png', height: 26) : _BrandMark(size: phone ? 28 : 30),
            ),
          ),
          SizedBox(width: phone ? 8 : 24),
          Expanded(
            child: Align(
              alignment: Alignment.center,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 560),
                child: SizedBox(
                  height: 40,
                  child: TextField(
                    controller: _search,
                    textAlignVertical: TextAlignVertical.center,
                    onSubmitted: (q) {
                      final query = q.trim();
                      if (query.isNotEmpty) _browse(_provider, query: query);
                    },
                    style: Vx.sans(size: 14),
                    decoration: const InputDecoration(
                      hintText: 'Search videos',
                      contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 0),
                      prefixIcon: Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.search_rounded, size: 18)),
                      prefixIconConstraints: BoxConstraints(minWidth: 38, minHeight: 38),
                    ),
                  ),
                ),
              ),
            ),
          ),
          SizedBox(width: phone ? 6 : 16),
          if (!phone)
            ValueListenableBuilder<int?>(
              valueListenable: _liveViewers,
              builder: (context, count, _) {
                if (count == null) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: Tooltip(
                    message: 'People watching right now',
                    child: StatusPill(
                      label: '${LiveViewersController.formatCount(count, compact: true)} watching',
                      color: Vx.green,
                      dense: true,
                    ),
                  ),
                );
              },
            ),
          if (!phone) Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
            decoration: BoxDecoration(color: Vx.red.withValues(alpha: .12), borderRadius: BorderRadius.circular(999)),
            child: Text('18+', style: Vx.mono(size: 12, weight: FontWeight.w600, color: Vx.red)),
          ),
          if (!phone) const SizedBox(width: 12),
          if (widget.signedIn)
            Tooltip(
              message: _username.isEmpty ? 'Account' : _username,
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => setState(() => _page = _Page.account),
                child: Container(
                  width: 36,
                  height: 36,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: Vx.blue, borderRadius: BorderRadius.circular(12)),
                  child: Text(_username.isEmpty ? '•' : _username[0].toUpperCase(), style: Vx.sans(size: 16, weight: FontWeight.w700, color: Colors.white)),
                ),
              ),
            )
          else if (phone)
            IconButton(onPressed: () => _openAuth(), tooltip: 'Log in', icon: const Icon(Icons.person_outline))
          else ...[
            TextButton(onPressed: () => _openAuth(), child: Text('Log in', style: Vx.sans(size: 14, weight: FontWeight.w500, color: Vx.text))),
            const SizedBox(width: 6),
            FilledButton(onPressed: () => _openAuth(signup: true), style: FilledButton.styleFrom(minimumSize: const Size(0, 38)), child: const Text('Sign up')),
          ],
        ]),
      );

  Widget _sidebar(bool wide, {bool drawer = false}) {
    final live = _providers.where((p) => p['available'] == true).toList();
    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      curve: Vx.ease,
      width: wide ? 248 : 76,
      decoration: const BoxDecoration(color: Vx.bg, border: Border(right: BorderSide(color: Vx.line))),
      child: ListView(padding: const EdgeInsets.fromLTRB(12, 16, 12, 16), children: [
        for (final item in _nav.where((item) =>
            item.$1 != _Page.developers || _isAdmin))
          _NavItem(label: item.$2, icon: item.$3, activeIcon: item.$4, active: _page == item.$1, wide: wide, onTap: () { if (drawer) Navigator.of(context).pop(); _go(item.$1); }),
        if (_isAdmin)
          _NavItem(label: 'Admin', icon: Icons.admin_panel_settings_outlined, activeIcon: Icons.admin_panel_settings_rounded, active: _page == _Page.admin, wide: wide, onTap: () { if (drawer) Navigator.of(context).pop(); _go(_Page.admin); }),
        if (live.isNotEmpty) ...[
          const SizedBox(height: 18),
          if (wide)
            Padding(padding: const EdgeInsets.fromLTRB(12, 0, 12, 10), child: Text('LIBRARIES', style: Vx.mono(size: 11, spacing: 1.4)))
          else
            const Padding(padding: EdgeInsets.symmetric(vertical: 8, horizontal: 14), child: Divider()),
          for (final p in live)
            _NavItem(
              label: (p['name'] ?? '').toString(),
              leading: ProviderIcon(id: (p['id'] ?? '').toString(), name: (p['name'] ?? '').toString(), size: 24),
              active: _page == _Page.browse && _provider == p['id'] && _query.isEmpty,
              wide: wide,
              onTap: () { if (drawer) Navigator.of(context).pop(); _browse((p['id'] ?? '').toString()); },
            ),
        ],
        const SizedBox(height: 18),
        _NavItem(label: widget.signedIn ? 'Account' : 'Log in', icon: Icons.person_outline_rounded, activeIcon: Icons.person_rounded, active: _page == _Page.account, wide: wide, onTap: () { if (drawer) Navigator.of(context).pop(); if (widget.signedIn) { setState(() => _page = _Page.account); } else { _openAuth(); } }),
      ]),
    );
  }
}

class _NavItem extends StatefulWidget {
  const _NavItem({required this.label, required this.active, required this.wide, required this.onTap, this.icon, this.activeIcon, this.leading});
  final String label;
  final IconData? icon;
  final IconData? activeIcon;
  final Widget? leading;
  final bool active;
  final bool wide;
  final VoidCallback onTap;
  @override
  State<_NavItem> createState() => _NavItemState();
}

class _NavItemState extends State<_NavItem> {
  bool _hover = false;
  @override
  Widget build(BuildContext context) {
    final color = widget.active ? Vx.text : (_hover ? Vx.text : Vx.text2);
    final leading = widget.leading ?? Icon(widget.active ? widget.activeIcon : widget.icon, size: 20, color: widget.active ? Vx.blue : color);
    final tile = MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          height: 42,
          margin: const EdgeInsets.only(bottom: 2),
          padding: EdgeInsets.symmetric(horizontal: widget.wide ? 12 : 0),
          decoration: BoxDecoration(
            color: widget.active ? Vx.well2 : (_hover ? Vx.well : Colors.transparent),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(mainAxisAlignment: widget.wide ? MainAxisAlignment.start : MainAxisAlignment.center, children: [
            leading,
            if (widget.wide) ...[
              const SizedBox(width: 12),
              Expanded(child: Text(widget.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: Vx.sans(size: 14, weight: FontWeight.w500, color: color))),
            ],
          ]),
        ),
      ),
    );
    return widget.wide ? tile : Tooltip(message: widget.label, waitDuration: const Duration(milliseconds: 400), child: tile);
  }
}


class _SiteSuspendedPage extends StatefulWidget {
  const _SiteSuspendedPage({required this.api, required this.info, this.onSignIn});
  final VexoApi api;
  final SiteSuspensionInfo info;
  final VoidCallback? onSignIn;

  @override
  State<_SiteSuspendedPage> createState() => _SiteSuspendedPageState();
}

class _SiteSuspendedPageState extends State<_SiteSuspendedPage> {
  bool _checking = false;

  String _categoryLabel(String cat) => switch (cat) {
        'hosting' => 'HOSTING PROVIDER',
        'legal' => 'LEGAL & COMPLIANCE',
        'dmca' => 'COPYRIGHT / DMCA',
        'network' => 'NETWORK OPERATOR',
        'custom' => 'OFFICIAL NOTICE',
        _ => 'PLATFORM ADMINISTRATION',
      };

  String _formatUtc(int ms) {
    final dt = (ms > 0 ? DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true) : DateTime.now().toUtc());
    String two(int n) => n.toString().padLeft(2, '0');
    return '${dt.year}-${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}:${two(dt.second)} UTC';
  }

  Future<void> _retry() async {
    if (_checking) return;
    setState(() => _checking = true);
    try {
      await widget.api.get('/config');
    } catch (_) {
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _openContact() async {
    final raw = widget.info.contactUrl.trim();
    if (raw.isEmpty) return;
    final uri = Uri.tryParse(raw.startsWith('/') ? 'https://${widget.info.host}$raw' : raw);
    if (uri != null) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  Widget _docketRow(String label, String value, {bool isRed = false, bool mono = false}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: const Color(0xFF111622),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label.toUpperCase(), style: Vx.mono(size: 10, color: const Color(0xFF7C8496), weight: FontWeight.w700)),
          const SizedBox(height: 5),
          Text(
            value,
            style: mono
                ? Vx.mono(size: 13, color: isRed ? const Color(0xFFF87171) : const Color(0xFFF4F5F8), weight: FontWeight.w600)
                : TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: isRed ? const Color(0xFFF87171) : const Color(0xFFF4F5F8)),
          ),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final info = widget.info;
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFF05070C),
        gradient: RadialGradient(
          center: Alignment(0, -1.1),
          radius: 1.15,
          colors: [Color(0x2EEF4444), Color(0xFF05070C)],
        ),
      ),
      child: Column(children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: const BoxDecoration(
            gradient: LinearGradient(colors: [Color(0xFF991B1B), Color(0xFFDC2626), Color(0xFF991B1B)]),
          ),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Container(width: 8, height: 8, decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle)),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                'ACCESS RESTRICTED · OFFICIAL SUSPENSION NOTICE · HTTP ${info.statusCode}',
                style: Vx.mono(size: 11, color: Colors.white, weight: FontWeight.w700),
                textAlign: TextAlign.center,
              ),
            ),
          ]),
        ),
        Expanded(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 640),
                child: Container(
                  decoration: BoxDecoration(
                    color: const Color(0xFF0B0E16),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: const Color(0xFFEF4444).withValues(alpha: 0.38)),
                    boxShadow: const [BoxShadow(color: Color(0x99000000), blurRadius: 48, offset: Offset(0, 20))],
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(26),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Container(
                        width: 68,
                        height: 68,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: const Color(0xFFEF4444).withValues(alpha: 0.14),
                          border: Border.all(color: const Color(0xFFEF4444), width: 2),
                        ),
                        child: const Icon(Icons.gpp_maybe_rounded, color: Color(0xFFF87171), size: 34),
                      ),
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                        decoration: BoxDecoration(
                          color: const Color(0xFFEF4444).withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: const Color(0xFFEF4444).withValues(alpha: 0.35)),
                        ),
                        child: Text(_categoryLabel(info.category), style: Vx.mono(size: 10, color: const Color(0xFFFCA5A5), weight: FontWeight.w700)),
                      ),
                      const SizedBox(height: 14),
                      Text(
                        info.title.toUpperCase(),
                        style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: Colors.white, letterSpacing: -0.6, height: 1.15),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        info.message,
                        style: const TextStyle(fontSize: 15, color: Color(0xFFB8BECB), height: 1.55),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 22),
                      LayoutBuilder(builder: (context, c) {
                        final cols = c.maxWidth >= 460 ? 2 : 1;
                        final cells = <Widget>[
                          _docketRow('Domain', info.host, mono: true),
                          _docketRow('Issued By', info.issuer),
                          _docketRow('Service Status', 'SUSPENDED (HTTP ${info.statusCode})', isRed: true, mono: true),
                          if (info.referenceId.isNotEmpty) _docketRow('Reference / Case ID', info.referenceId, mono: true),
                          _docketRow('Effective (UTC)', _formatUtc(info.updatedAt), mono: true),
                        ];
                        if (cols == 1) {
                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [for (var i = 0; i < cells.length; i++) ...[if (i > 0) const SizedBox(height: 8), cells[i]]],
                          );
                        }
                        return Wrap(
                          spacing: 10,
                          runSpacing: 10,
                          children: cells.map((w) => SizedBox(width: (c.maxWidth - 10) / 2, child: w)).toList(),
                        );
                      }),
                      const SizedBox(height: 22),
                      Wrap(spacing: 10, runSpacing: 10, alignment: WrapAlignment.center, children: [
                        if (info.contactUrl.isNotEmpty)
                          FilledButton.icon(
                            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626), foregroundColor: Colors.white),
                            onPressed: _openContact,
                            icon: const Icon(Icons.open_in_new_rounded, size: 16),
                            label: Text(info.contactLabel.isNotEmpty ? info.contactLabel : 'Contact support'),
                          ),
                        OutlinedButton.icon(
                          onPressed: _checking ? null : _retry,
                          icon: _checking
                              ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                              : const Icon(Icons.refresh_rounded, size: 16),
                          label: Text(_checking ? 'Checking…' : 'Retry'),
                        ),
                        if (widget.onSignIn != null)
                          TextButton.icon(
                            onPressed: widget.onSignIn,
                            icon: const Icon(Icons.admin_panel_settings_outlined, size: 16),
                            label: const Text('Admin sign in'),
                          ),
                      ]),
                    ]),
                  ),
                ),
              ),
            ),
          ),
        ),
      ]),
    );
  }
}

class _BannedAccountPage extends StatelessWidget {
  const _BannedAccountPage({required this.info, required this.onDismiss});
  final BannedAccountInfo info;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final reason = info.reason.trim().isNotEmpty
        ? info.reason.trim()
        : 'Your account was suspended by an administrator for violating VexoStream’s terms or community guidelines.';
    return Scaffold(
      backgroundColor: Vx.bg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 500),
              child: Container(
                padding: const EdgeInsets.fromLTRB(32, 34, 32, 30),
                decoration: BoxDecoration(
                  color: Vx.panel,
                  borderRadius: BorderRadius.circular(Vx.radius2xl),
                  border: Border.all(color: Vx.red.withValues(alpha: .35)),
                  boxShadow: const [BoxShadow(color: Color(0xE6000000), blurRadius: 50, offset: Offset(0, 26), spreadRadius: -24)],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const _BrandMark(size: 52),
                    const SizedBox(height: 20),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                      decoration: BoxDecoration(color: Vx.red.withValues(alpha: .14), borderRadius: BorderRadius.circular(999)),
                      child: Text('ACCOUNT SUSPENDED', style: Vx.mono(size: 11, weight: FontWeight.w700, color: Vx.red, spacing: 1.2)),
                    ),
                    const SizedBox(height: 16),
                    Text('This account has been banned.', style: t.headlineSmall, textAlign: TextAlign.center),
                    if (info.username.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Text('Account: ${info.username}', style: Vx.sans(size: 14, weight: FontWeight.w600, color: Vx.text)),
                    ],
                    const SizedBox(height: 10),
                    Text(reason, textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(fontSize: 15, color: Vx.text2)),
                    if (info.bannedAt.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Text('Suspended at ${info.bannedAt} UTC', style: Vx.mono(size: 11, color: Vx.text3)),
                    ],
                    const SizedBox(height: 24),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: onDismiss,
                        child: const Text('Back to Home'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _OwnerNoticeBanner extends StatefulWidget {
  const _OwnerNoticeBanner({
    super.key,
    required this.notice,
    required this.onLinkTap,
    this.onDismiss,
  });

  final Map<String, dynamic> notice;
  final VoidCallback? onDismiss;
  final ValueChanged<String> onLinkTap;

  @override
  State<_OwnerNoticeBanner> createState() => _OwnerNoticeBannerState();
}

class _OwnerNoticeBannerState extends State<_OwnerNoticeBanner> with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  late final Animation<double> _fade;
  late final Animation<Offset> _slide;
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 320),
      reverseDuration: const Duration(milliseconds: 240),
    );
    _fade = CurvedAnimation(parent: _ctrl, curve: Curves.easeOutCubic, reverseCurve: Curves.easeInCubic);
    _slide = Tween<Offset>(begin: const Offset(0, -0.14), end: Offset.zero).animate(_fade);
    _ctrl.forward();
  }

  Future<void> _handleDismiss() async {
    if (_closing || widget.onDismiss == null) return;
    setState(() => _closing = true);
    await _ctrl.reverse();
    if (mounted) widget.onDismiss?.call();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  TextDirection _noticeTextDirection(String text) =>
      RegExp(r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]').hasMatch(text)
          ? TextDirection.rtl
          : TextDirection.ltr;

  @override
  Widget build(BuildContext context) {
    final notice = widget.notice;
    final tone = (notice['tone'] ?? 'info').toString();
    final iconKey = (notice['icon'] ?? 'campaign').toString();
    final accent = switch (tone) {
      'success' => Vx.green,
      'warning' => Vx.amber,
      'urgent' => Vx.red,
      _ => Vx.blue,
    };
    final icon = switch (iconKey) {
      'sparkles' => Icons.auto_awesome_rounded,
      'info' => Icons.info_outline_rounded,
      'check' => Icons.check_circle_outline_rounded,
      'warning' => Icons.warning_amber_rounded,
      'shield' => Icons.verified_user_outlined,
      'campaign' => Icons.campaign_rounded,
      _ => switch (tone) {
        'success' => Icons.check_circle_outline_rounded,
        'warning' => Icons.warning_amber_rounded,
        'urgent' => Icons.verified_user_outlined,
        _ => Icons.campaign_rounded,
      },
    };
    final title = (notice['title'] ?? '').toString().trim();
    final message = (notice['message'] ?? '').toString().trim();
    final linkText = (notice['linkText'] ?? '').toString().trim();
    final linkUrl = (notice['linkUrl'] ?? '').toString().trim();

    return AnimatedSize(
      duration: const Duration(milliseconds: 240),
      curve: Curves.easeInOutCubic,
      alignment: Alignment.topCenter,
      child: _closing && _ctrl.isDismissed
          ? const SizedBox.shrink()
          : FadeTransition(
              opacity: _fade,
              child: SlideTransition(
                position: _slide,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 10, 20, 2),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 1240),
                      child: Container(
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(18),
                          border: Border.all(color: accent.withValues(alpha: .38)),
                          gradient: LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [accent.withValues(alpha: .16), Vx.panel],
                          ),
                          boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 24, offset: Offset(0, 10))],
                        ),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(17),
                          child: IntrinsicHeight(
                            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                              Container(width: 4, color: accent),
                              Expanded(
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
                                  child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                                    Container(
                                      width: 38,
                                      height: 38,
                                      decoration: BoxDecoration(
                                        color: accent.withValues(alpha: .18),
                                        borderRadius: BorderRadius.circular(11),
                                        border: Border.all(color: accent.withValues(alpha: .34)),
                                      ),
                                      child: Icon(icon, color: accent, size: 20),
                                    ),
                                    const SizedBox(width: 14),
                                    Expanded(
                                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                                        Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                                          Container(
                                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                            decoration: BoxDecoration(color: accent.withValues(alpha: .2), borderRadius: BorderRadius.circular(999)),
                                            child: Text('NOTICE', style: Vx.mono(size: 10, color: accent, spacing: .9)),
                                          ),
                                          if (title.isNotEmpty) Text(title, textDirection: _noticeTextDirection(title), style: Vx.sans(size: 14.5, weight: FontWeight.w700)),
                                        ]),
                                        if (message.isNotEmpty) ...[
                                          const SizedBox(height: 3),
                                          Text(message, textDirection: _noticeTextDirection(message), style: Vx.sans(size: 13.5, color: Vx.text2)),
                                        ],
                                      ]),
                                    ),
                                    if (linkText.isNotEmpty && linkUrl.isNotEmpty) ...[
                                      const SizedBox(width: 12),
                                      FilledButton(
                                        onPressed: () => widget.onLinkTap(linkUrl),
                                        style: FilledButton.styleFrom(
                                          backgroundColor: accent,
                                          foregroundColor: Colors.white,
                                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                                          minimumSize: Size.zero,
                                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                        ),
                                        child: Text(linkText, style: Vx.sans(size: 12.5, weight: FontWeight.w600, color: Colors.white)),
                                      ),
                                    ],
                                    if (widget.onDismiss != null) ...[
                                      const SizedBox(width: 6),
                                      IconButton(
                                        tooltip: 'Dismiss notice',
                                        onPressed: _closing ? null : _handleDismiss,
                                        icon: const Icon(Icons.close_rounded, size: 18, color: Vx.text2),
                                      ),
                                    ],
                                  ]),
                                ),
                              ),
                            ]),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
    );
  }
}

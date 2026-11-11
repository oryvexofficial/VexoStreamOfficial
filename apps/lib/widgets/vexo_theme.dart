import 'package:flutter/material.dart';

const vexoBackground = Color(0xFF090B10);
const vexoSurface = Color(0xFF12151D);
const vexoCard = Color(0xFF181C26);
const vexoPurple = Color(0xFF8B5CF6);
const vexoPink = Color(0xFFF43F8E);

ThemeData buildVexoTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: vexoPurple,
    brightness: Brightness.dark,
    surface: vexoSurface,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme.copyWith(primary: vexoPurple, secondary: vexoPink),
    scaffoldBackgroundColor: vexoBackground,
    cardColor: vexoCard,
    appBarTheme: const AppBarTheme(
      backgroundColor: vexoBackground,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: vexoCard,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: Colors.white.withValues(alpha: .07))),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: vexoPurple, width: 1.4)),
    ),
    cardTheme: CardThemeData(
      color: vexoCard,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: Colors.white.withValues(alpha: .06))),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: vexoSurface,
      indicatorColor: vexoPurple.withValues(alpha: .2),
      selectedIconTheme: const IconThemeData(color: vexoPurple),
      unselectedIconTheme: IconThemeData(color: Colors.white.withValues(alpha: .55)),
      labelType: NavigationRailLabelType.all,
    ),
  );
}

class PageHeading extends StatelessWidget {
  const PageHeading({super.key, required this.title, this.subtitle, this.trailing});
  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 22),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -.6)),
            if (subtitle != null) ...[
              const SizedBox(height: 7),
              Text(subtitle!, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white60)),
            ],
          ])),
          if (trailing != null) trailing!,
        ]),
      );
}

class PageLoader extends StatelessWidget {
  const PageLoader({super.key, this.label = 'Loading VexoStream…'});
  final String label;
  @override
  Widget build(BuildContext context) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 2.6)),
        const SizedBox(height: 14),
        Text(label, style: const TextStyle(color: Colors.white60)),
      ]));
}

class ErrorPanel extends StatelessWidget {
  const ErrorPanel({super.key, required this.message, this.onRetry, this.action});
  final String message;
  final VoidCallback? onRetry;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 500),
        child: Card(child: Padding(padding: const EdgeInsets.all(24), child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.cloud_off_rounded, size: 34, color: Colors.white54),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null || action != null) ...[
            const SizedBox(height: 16),
            Wrap(spacing: 10, runSpacing: 8, alignment: WrapAlignment.center, children: [
              if (onRetry != null) OutlinedButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Try again')),
              if (action != null) action!,
            ]),
          ],
        ]))),
      ));
}

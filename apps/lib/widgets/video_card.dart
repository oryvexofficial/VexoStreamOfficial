import 'package:flutter/material.dart';

import '../api/vexo_api.dart';

class VideoCard extends StatelessWidget {
  const VideoCard({super.key, required this.video, required this.onTap});
  final Map<String, dynamic> video;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final title = firstText(video, const ['title', 'name', 'video_title'], fallback: 'Untitled video');
    final image = firstText(video, const ['thumbnail', 'thumb', 'poster', 'image', 'image_url']);
    final duration = firstText(video, const ['duration', 'length']);
    final provider = firstText(video, const ['provider', 'source']);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          AspectRatio(
            aspectRatio: 16 / 9,
            child: Stack(fit: StackFit.expand, children: [
              if (image.isNotEmpty)
                Image.network(image, fit: BoxFit.cover, errorBuilder: (_, __, ___) => _placeholder())
              else
                _placeholder(),
              if (duration.isNotEmpty)
                Positioned(right: 9, bottom: 9, child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
                  decoration: BoxDecoration(color: Colors.black.withValues(alpha: .78), borderRadius: BorderRadius.circular(6)),
                  child: Text(duration, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                )),
            ]),
          ),
          Padding(padding: const EdgeInsets.fromLTRB(13, 12, 13, 13), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, height: 1.2)),
            if (provider.isNotEmpty) ...[
              const SizedBox(height: 7),
              Text(provider, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white54, fontSize: 12)),
            ],
          ])),
        ]),
      ),
    );
  }

  Widget _placeholder() => Container(
        color: const Color(0xFF242735),
        child: const Center(child: Icon(Icons.play_circle_outline_rounded, size: 42, color: Colors.white38)),
      );
}

String videoTarget(Map<String, dynamic> item) => firstText(item, const ['url', 'video_url', 'link', 'href']);

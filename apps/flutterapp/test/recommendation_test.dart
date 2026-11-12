import 'package:flutter_test/flutter_test.dart';
import 'package:vexostream_app/pages/embedded_player_page.dart';

void main() {
  test('recommendation search matches the site title strategy', () {
    expect(recommendationQuery('The Bright, amazing video title here'), 'bright amazing video');
    expect(recommendationQuery('A to be'), 'trending');
    expect(recommendationQuery('VexoStream player'), 'trending');
    expect(recommendationQuery(''), 'trending');
  });
}

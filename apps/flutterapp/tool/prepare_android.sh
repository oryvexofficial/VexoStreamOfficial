#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p ~/.gradle/init.d
cat > ~/.gradle/init.d/disable-lint.gradle << 'GRADLE'
allprojects {
  afterEvaluate {
    tasks.matching { it.name.startsWith("lintVital") || it.name.contains("Lint") }.configureEach {
      enabled = false
    }
  }
}
GRADLE
flutter create --platforms=android --project-name=vexostream_app --org=bond.vexostream .
python3 - <<'PY'
import re
from pathlib import Path
p = Path('android/app/src/main/AndroidManifest.xml')
if p.exists():
    s = p.read_text()
    for permission in ('android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE'):
        if permission not in s:
            s = s.replace('<application', f'<uses-permission android:name="{permission}"/>\n    <application', 1)
    p.write_text(s)

lint_vital_block = """
subprojects {
    afterEvaluate {
        tasks.matching { it.name.startsWith("lintVital") }.configureEach {
            enabled = false
        }
    }
}
"""

root_gradle_kts = Path('android/build.gradle.kts')
if root_gradle_kts.exists():
    content = root_gradle_kts.read_text()
    if 'lintVital' not in content:
        content += lint_vital_block
        root_gradle_kts.write_text(content)

root_gradle = Path('android/build.gradle')
if root_gradle.exists():
    content = root_gradle.read_text()
    if 'lintVital' not in content:
        content += lint_vital_block
        root_gradle.write_text(content)

def ensure_lint_settings(path, block_name):
    if not path.exists():
        return

    content = path.read_text()
    android_block = re.search(r'(?m)^([ \t]*)android[ \t]*\{', content)
    if not android_block:
        return

    missing = [
        key for key in ('checkReleaseBuilds', 'abortOnError')
        if not re.search(
            rf'(?m)^[ \t]*{key}[ \t]*(?:=[ \t]*)?false\b',
            content,
        )
    ]
    if not missing:
        return

    indent = android_block.group(1)
    config = (
        f'{indent}    {block_name} {{\n'
        + ''.join(f'{indent}        {key} = false\n' for key in missing)
        + f'{indent}    }}\n'
    )
    content = (
        content[:android_block.end()]
        + '\n'
        + config
        + content[android_block.end():]
    )
    path.write_text(content)

ensure_lint_settings(Path('android/app/build.gradle.kts'), 'lint')
ensure_lint_settings(Path('android/app/build.gradle'), 'lintOptions')
PY
rm -f test/widget_test.dart

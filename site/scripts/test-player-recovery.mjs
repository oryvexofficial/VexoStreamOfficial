import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const playerFile = await readFile(new URL('../src/templates/03-player.ts', import.meta.url), 'utf8');
const playerStart = playerFile.indexOf('const PLAYER_JS = String.raw`');
const playerEnd = playerFile.indexOf('\n`;\n\nconst WATCH_JS', playerStart);
assert.ok(playerStart >= 0 && playerEnd > playerStart, 'active player script is present');
const playerSource = playerFile.slice(playerStart, playerEnd);
const bundledWorker = await readFile(new URL('../dist/worker.js', import.meta.url), 'utf8');

function rawPlayerBlock(text) {
  const start = text.indexOf('const PLAYER_JS = String.raw`');
  const watch = text.indexOf('const WATCH_JS', start);
  const end = text.lastIndexOf('`;', watch) + 2;
  assert.ok(start >= 0 && end > start, 'player bundle block exists');
  return text.slice(start, end);
}

function functionSource(name) {
  const start = playerSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `player function ${name} exists`);
  const open = playerSource.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < playerSource.length; i++) {
    if (playerSource[i] === '{') depth++;
    if (playerSource[i] === '}') {
      depth--;
      if (depth === 0) return playerSource.slice(start, i + 1);
    }
  }
  assert.fail(`player function ${name} has balanced braces`);
}

const context = vm.createContext({
  URL,
  URLSearchParams,
  atob,
  Date,
  location: { origin: 'https://vexostream.bond', href: 'https://vexostream.bond/embed/test' }
});
vm.runInContext(`
  var queue = [], tried = Object.create(null), qualityGroups = [], groupLookup = Object.create(null);
  var autoQ = true, attachedAt = 11, lastProgressAt = 22, lastT = 4, stallStep = 2;
`, context);
for (const name of [
  'decodeUrl',
  'heightOf',
  'proxyUrl',
  'isHlsStream',
  'buildQueue',
  'firstUntriedInGroup',
  'nextRecoveryIndex',
  'resetWatchdog',
  'activeNativeSource'
]) {
  vm.runInContext(functionSource(name), context);
}

function encodedUrl(url) {
  return Buffer.from(encodeURIComponent(url), 'utf8').toString('base64');
}

function stream(quality, url, extra = {}) {
  return {
    quality,
    url,
    x_url: encodedUrl(url),
    x_sig: `sig-${quality}`,
    x_exp: '1794596400',
    ...extra
  };
}

test('generated Worker carries the active embed player source', () => {
  assert.equal(rawPlayerBlock(bundledWorker), rawPlayerBlock(playerFile));
});

test('HLS detection recognizes extensionless, uppercase, MIME, type, and query hints', () => {
  context.buildQueue({
    streams: {
      qualities: [
        stream('1080p', 'https://cdn.example.test/master.M3U8?token=abc'),
        stream('720p', 'https://cdn.example.test/live?id=123', { mime_type: 'application/vnd.apple.mpegurl' }),
        stream('480p', 'https://cdn.example.test/play?format=M3U8'),
        stream('360p', 'https://cdn.example.test/watch?id=456', { type: 'HLS' }),
        stream('240p', 'https://cdn.example.test/video.mp4', { mime_type: 'video/mp4' })
      ],
      fallback: []
    }
  });
  assert.deepEqual(Array.from(context.queue, (item) => item.isHls), [true, true, true, true, false]);
});

test('same-quality alternate URLs are retained while exact duplicates are collapsed', () => {
  const primary = 'https://cdn.example.test/720.mp4?token=one';
  const alternate = 'https://backup.example.test/720.mp4?token=two';
  context.buildQueue({
    streams: {
      qualities: [
        stream('720p', primary),
        stream('720p', primary),
        stream('720p', alternate),
        stream('480p', 'https://cdn.example.test/480.mp4')
      ],
      fallback: []
    }
  });
  assert.equal(context.queue.length, 3);
  assert.deepEqual(Array.from(context.queue, (item) => item.visible), [true, false, true]);
  assert.deepEqual(
    Array.from(context.queue.slice(0, 2), (item) => new URL(item.url).searchParams.get('url')),
    [primary, alternate]
  );
});

test('automatic recovery tries same-quality alternates, lower qualities, then fallback streams', () => {
  context.buildQueue({
    streams: {
      qualities: [
        stream('1080p', 'https://cdn.example.test/1080-a.mp4'),
        stream('1080p', 'https://cdn2.example.test/1080-b.mp4'),
        stream('720p', 'https://cdn.example.test/720-a.mp4'),
        stream('720p', 'https://cdn2.example.test/720-b.mp4')
      ],
      fallback: [stream('MP4', 'https://fallback.example.test/video', { format: 'video/mp4' })]
    }
  });
  context.autoQ = true;
  context.tried[0] = true;
  assert.equal(context.nextRecoveryIndex(0), 1, 'try the selected quality alternate first');
  context.tried[1] = true;
  assert.equal(context.nextRecoveryIndex(0), 2, 'then step down one quality');
  context.tried[2] = true;
  assert.equal(context.nextRecoveryIndex(0), 3, 'try the lower-quality alternate');
  context.tried[3] = true;
  assert.equal(context.nextRecoveryIndex(0), 4, 'use the explicit fallback after quality candidates');
});

test('manual quality recovery stays on the selected quality and exhausts its alternates first', () => {
  context.buildQueue({
    streams: {
      qualities: [
        stream('720p', 'https://cdn.example.test/720-a.mp4'),
        stream('720p', 'https://cdn2.example.test/720-b.mp4'),
        stream('480p', 'https://cdn.example.test/480.mp4')
      ],
      fallback: [stream('MP4', 'https://fallback.example.test/video')]
    }
  });
  context.autoQ = false;
  context.tried[0] = true;
  assert.equal(context.nextRecoveryIndex(0), 1, 'manual choice gets its same-quality alternate');
  context.tried[1] = true;
  assert.equal(context.nextRecoveryIndex(0), -1, 'manual choice does not step down or use generic fallback');
});

test('same-source native retries preserve the watchdog clock and its escalation step', () => {
  context.attachedAt = 100;
  context.lastProgressAt = 200;
  context.lastT = 12;
  context.stallStep = 2;
  context.resetWatchdog(true);
  assert.equal(context.attachedAt, 100);
  assert.equal(context.lastProgressAt, 200);
  assert.equal(context.lastT, 12);
  assert.equal(context.stallStep, 2);

  context.resetWatchdog(false);
  assert.ok(context.attachedAt >= 200);
  assert.equal(context.lastProgressAt, context.attachedAt);
  assert.equal(context.lastT, -1);
  assert.equal(context.stallStep, 0);
  assert.match(playerSource, /attach\(idx, t, \{ preserveWatchdog: true \}\)/, 'watchdog kick preserves the clock');
  assert.match(playerSource, /attach\(idx, t, \{ preserveWatchdog: true \}\); \}, Math\.min\(6000, 1800 \* n\)\)/, 'native error retry preserves the clock');
  assert.match(playerSource, /resetWatchdog\(my === preserveWatchdogGeneration\)/, 'metadata readiness cannot silently reset a preserved stall');
  assert.match(playerSource, /if \(!downshift\('stall'\)\) refresh\('stall'\)/, 'manual stalls try their same-quality alternatives before refreshing');
});

test('stale native media events cannot be attributed to the newly selected quality', () => {
  context.buildQueue({
    streams: {
      qualities: [
        stream('720p', 'https://cdn.example.test/720.mp4'),
        stream('480p', 'https://cdn.example.test/480.mp4')
      ],
      fallback: []
    }
  });
  context.idx = 1;
  context.video = { currentSrc: context.queue[0].url };
  assert.equal(context.activeNativeSource(), false);
  context.video.currentSrc = context.queue[1].url;
  assert.equal(context.activeNativeSource(), true);
  context.video.currentSrc = '';
  assert.equal(context.activeNativeSource(), false);
  assert.match(playerSource, /!activeNativeSource\(\)/, 'old-source errors are ignored while the new source watchdog remains active');
});

test('source loading and requested playback both have bounded recovery timers', () => {
  assert.match(playerSource, /function armSourceLoadTimer\(my\)/);
  assert.match(playerSource, /!ready && !failedNow && !refreshing\) skip\(my, 'load-timeout'\)/);
  assert.match(playerSource, /function armPlayStartTimer\(my\)/);
  assert.match(playerSource, /skip\(my, 'play-start-timeout'\)/);
  assert.match(playerSource, /function fallback\(\)[\s\S]*?}, 9000\)/, 'HLS fallback cannot leave source setup pending forever');
});

test('signed media URLs survive browser proxy serialization without canonicalization changes', () => {
  const rawUrl = 'https://cdn.example.test/hls/master.M3U8?token=abc%2B123&path=%2Fprivate';
  const signature = 'a'.repeat(64);
  context.buildQueue({
    streams: {
      qualities: [stream('720p', rawUrl, { type: 'application/vnd.apple.mpegurl', x_sig: signature, x_exp: '1794596400' })],
      fallback: []
    }
  });
  const proxied = new URL(context.queue[0].url);
  assert.equal(proxied.pathname, '/proxy-m3u8.m3u8');
  assert.equal(proxied.searchParams.get('url'), rawUrl);
  assert.equal(proxied.searchParams.get('sig'), signature);
  assert.equal(proxied.searchParams.get('exp'), '1794596400');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/templates/02-home.ts', import.meta.url), 'utf8');
const start = source.indexOf('const CARD_JS = String.raw`');
const end = source.indexOf('\n`;\n\n// Home page', start);
assert.ok(start >= 0 && end > start, 'card script must be present');
let cardScript = source.slice(start + 'const CARD_JS = String.raw`'.length, end);
cardScript = cardScript.replace('var PLAY = ` + JSON.stringify(ICONS.play) + String.raw`;', 'var PLAY = "";');

const VIDEO_URL = 'https://www.xvideos.com/video123456/example';
const ORIGINAL_POSTER = 'https://img.example.test/original-poster.jpg';

function fixture({ decode = () => new Promise(() => {}), poster = '' } = {}) {
  const timers = [];
  const classList = () => {
    const values = new Set();
    return { add: (...items) => items.forEach(x => values.add(x)), remove: (...items) => items.forEach(x => values.delete(x)), contains: x => values.has(x) };
  };
  const attributes = {};
  const image = { classList: classList(), decode, onload: null, onerror: null, src: '' };
  const probes = [];
  const wrap = {
    querySelector: s => s === 'img' ? image : null,
    setAttribute: (k, v) => { attributes[k] = v; },
    removeAttribute: k => { delete attributes[k]; },
  };
  const card = { classList: classList(), querySelector: s => s === '.vthumb' ? wrap : null };
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const context = {
    URL, Promise, Date, encodeURIComponent,
    location: { href: 'https://vexostream.bond/', origin: 'https://vexostream.bond' },
    VX: { token: 'test' }, localStorage: storage, sessionStorage: storage,
    document: { readyState: 'complete', querySelectorAll: () => [] },
    fetch: () => Promise.resolve({
      ok: true,
      json: async () => ({ posters: poster ? { [VIDEO_URL]: poster } : {}, pending: [] })
    }),
    Image: class {
      constructor() { this.onload = null; this.onerror = null; this._src = ''; probes.push(this); }
      set src(value) { this._src = value; }
      get src() { return this._src; }
    },
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    addEventListener: () => {},
  };
  context.window = context;
  vm.runInNewContext(cardScript, context);
  return { context, image, card, attributes, timers, probes };
}

async function resolvePosterRequest(f) {
  const requestTimer = f.timers.find(t => t.ms === 80 && !t.cleared);
  assert.ok(requestTimer, 'poster lookup should be queued');
  requestTimer.fn();
  await new Promise(resolve => setImmediate(resolve));
}

test('card never shows a listing frame and reveals only the loaded original poster', async () => {
  const f = fixture({ poster: ORIGINAL_POSTER });
  f.context.vxThumb(f.card, {
    url: VIDEO_URL,
    preview_url: 'https://img.example.test/random-video-frame.jpg'
  }, { now: true });
  assert.equal(f.card.classList.contains('is-loading'), true);
  assert.equal(f.attributes['aria-busy'], 'true');
  assert.equal(f.image.src, '', 'listing frame must not be assigned while poster resolves');

  await resolvePosterRequest(f);
  assert.equal(f.probes.length, 1);
  assert.ok(f.probes[0].src.includes('original-poster.jpg'));
  f.probes[0].onload();
  assert.ok(f.image.src.includes('original-poster.jpg'));
  assert.equal(f.image.src.includes('random-video-frame'), false);

  f.image.onload();
  assert.equal(f.card.classList.contains('is-loading'), true, 'wait until the original image is ready to paint');
  const reveal = f.timers.find(t => t.ms === 1000 && !t.cleared);
  assert.ok(reveal, 'decode watchdog should reveal an image even if decode stalls');
  reveal.fn();
  assert.equal(f.card.classList.contains('is-loading'), false);
  assert.equal(f.card.classList.contains('thumb-real'), true);
  assert.equal(f.card.classList.contains('thumb-listing'), false);
  assert.equal(f.image.classList.contains('ok'), true);
  assert.equal(f.attributes['aria-busy'], undefined);
});

test('when no original poster exists, show the branded fallback without a listing frame', async () => {
  const f = fixture();
  f.context.vxThumb(f.card, {
    url: VIDEO_URL,
    thumbnail: 'https://img.example.test/random-video-frame.jpg'
  }, { now: true });
  assert.equal(f.image.src, '');
  await resolvePosterRequest(f);
  assert.equal(f.image.src, '');
  assert.equal(f.card.classList.contains('is-loading'), false);
  assert.equal(f.card.classList.contains('thumb-failed'), true);
  assert.equal(f.attributes['aria-busy'], undefined);
});

test('if the original poster image fails, show the branded fallback, not a listing frame', async () => {
  const f = fixture({ poster: ORIGINAL_POSTER });
  f.context.vxThumb(f.card, {
    url: VIDEO_URL,
    thumbnail: 'https://img.example.test/random-video-frame.jpg'
  }, { now: true });
  await resolvePosterRequest(f);
  f.probes[0].onload();
  assert.ok(f.image.src.includes('original-poster.jpg'));
  f.image.onerror();
  assert.equal(f.image.src.includes('random-video-frame'), false);
  assert.equal(f.card.classList.contains('is-loading'), false);
  assert.equal(f.card.classList.contains('thumb-failed'), true);
  assert.equal(f.attributes['aria-busy'], undefined);
});

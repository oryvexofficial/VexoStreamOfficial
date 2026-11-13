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

function fixture({ decode = () => new Promise(() => {}) } = {}) {
  const timers = [];
  const classList = () => {
    const values = new Set();
    return { add: (...items) => items.forEach(x => values.add(x)), remove: (...items) => items.forEach(x => values.delete(x)), contains: x => values.has(x) };
  };
  const attributes = {};
  const image = { classList: classList(), decode, onload: null, onerror: null, src: '' };
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
    fetch: () => new Promise(() => {}),
    Image: class {},
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    addEventListener: () => {},
  };
  context.window = context;
  vm.runInNewContext(cardScript, context);
  return { context, image, card, attributes, timers };
}

test('card stays busy while loading, then reveals a loaded image even if decode stalls', () => {
  const f = fixture();
  f.context.vxThumb(f.card, { url: 'https://www.xvideos.com/video123456/example', preview_url: 'https://img.example.test/cover.jpg' }, { now: true });
  assert.equal(f.card.classList.contains('is-loading'), true);
  assert.equal(f.attributes['aria-busy'], 'true');
  assert.match(f.image.src, /proxy-image\?url=/);
  f.image.onload();
  assert.equal(f.card.classList.contains('is-loading'), true);
  const reveal = f.timers.find(t => t.ms === 1000 && !t.cleared);
  assert.ok(reveal);
  reveal.fn();
  assert.equal(f.card.classList.contains('is-loading'), false);
  assert.equal(f.card.classList.contains('thumb-listing'), true);
  assert.equal(f.image.classList.contains('ok'), true);
  assert.equal(f.attributes['aria-busy'], undefined);
});

test('failed image stops loading and shows the fallback state', () => {
  const f = fixture();
  f.context.vxThumb(f.card, { url: 'https://www.xvideos.com/video123456/example', thumbnail: 'https://img.example.test/broken.jpg' }, { now: true });
  f.image.onerror();
  assert.equal(f.card.classList.contains('is-loading'), false);
  assert.equal(f.card.classList.contains('thumb-failed'), true);
  assert.equal(f.attributes['aria-busy'], undefined);
});

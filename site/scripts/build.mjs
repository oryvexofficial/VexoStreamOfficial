import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { compile } from 'tailwindcss';
import { Scanner } from '@tailwindcss/oxide';
import { createRequire } from 'node:module';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  'src/types.ts',
  'src/00-config-runtime.ts',
  'src/04-antiscrape.ts',
  'src/templates/01-design-shell.ts',
  'src/templates/02-home.ts',
  'src/templates/03-player.ts',
  'src/templates/04-status.ts',
  'src/05-settings-admin.ts',
  'src/05a-admin-users.ts',
  'src/05b-social.ts',
  'src/05c-members.ts',
  'src/05e-api-v1.ts',
  'src/05d-checkhost.ts',
  'src/templates/05-checkhost.ts',
  'src/06a-seo.ts',
  'src/06-telegram.ts',
  'src/07-router.ts',
];

/**
 * Convert oklch(L C H [/ A]) to standard sRGB rgb()/rgba() for universal
 * compatibility across older, lightweight, WebView, and rare browsers.
 */
function oklchToRgbString(L, C, Hdeg, alpha) {
  const H = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const gamma = (c) => {
    const v = Math.max(0, Math.min(1, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };
  const R = Math.round(gamma(rLin) * 255);
  const G = Math.round(gamma(gLin) * 255);
  const B = Math.round(gamma(bLin) * 255);
  if (alpha !== undefined && alpha !== '') {
    let aVal = alpha.trim();
    if (aVal.endsWith('%')) aVal = String(+(parseFloat(aVal) / 100).toFixed(4));
    return `rgba(${R},${G},${B},${aVal})`;
  }
  return `rgb(${R},${G},${B})`;
}

/**
 * Lower Tailwind CSS v4 output so it loads cleanly in rare/legacy/WebView
 * browsers that do not support @layer, @property, oklch(), color-mix(),
 * :where(), dvh, or inset.
 */
export function lowerCssForUniversalBrowsers(rawCss) {
  let css = rawCss;

  // 1. Extract @property initial-values and strip @property blocks
  const twDefaults = [];
  css = css.replace(/@property\s+(--[a-zA-Z0-9_-]+)\s*\{([^{}]*)\}/g, (_, prop, body) => {
    const m = body.match(/initial-value\s*:\s*([^;]+);?/);
    if (m && m[1].trim()) twDefaults.push(`${prop}:${m[1].trim()}`);
    return '';
  });

  // 2. Remove bare @layer order declarations (e.g. "@layer theme, base, components, utilities;")
  css = css.replace(/@layer\s+[^{;]+;/g, '');

  // 3. Unwrap all @layer <name> { ... } blocks iteratively using balanced braces
  const unwrapAtRule = (src, pattern) => {
    let out = src;
    while (true) {
      const m = pattern.exec(out);
      if (!m) break;
      const start = m.index;
      const braceStart = start + m[0].length - 1;
      let depth = 0;
      let i = braceStart;
      for (; i < out.length; i++) {
        if (out[i] === '{') depth++;
        else if (out[i] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) break;
      const inner = out.slice(braceStart + 1, i);
      out = out.slice(0, start) + inner + out.slice(i + 1);
    }
    return out;
  };
  css = unwrapAtRule(css, /@layer(?:\s+[^{]+)?\s*\{/);

  // 4. Convert any remaining oklch(...) functions to rgb()/rgba()
  css = css.replace(
    /oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+([0-9.]+(?:deg)?)(?:\s*\/\s*([0-9.]+%?))?\s*\)/g,
    (_, lStr, cStr, hStr, aStr) => {
      const L = lStr.endsWith('%') ? parseFloat(lStr) / 100 : parseFloat(lStr);
      return oklchToRgbString(L, parseFloat(cStr), parseFloat(hStr), aStr);
    }
  );

  // 5. Lower Tailwind v4 color-mix(in oklab, <color> <pct>%, transparent) -> rgba(...)
  const varToRgb = {
    '--color-brand': 'var(--blue-rgb)',
    '--blue': 'var(--blue-rgb)',
    '--color-bad': 'var(--red-rgb)',
    '--red': 'var(--red-rgb)',
    '--color-ok': 'var(--green-rgb)',
    '--green': 'var(--green-rgb)',
    '--color-warn': 'var(--amber-rgb)',
    '--amber': 'var(--amber-rgb)',
    '--color-bg': 'var(--bg-rgb)',
    '--bg': 'var(--bg-rgb)',
    '--color-fg': 'var(--text-rgb)',
    '--text': 'var(--text-rgb)',
    '--color-surface': 'var(--panel-rgb)',
    '--panel': 'var(--panel-rgb)',
    '--color-white': '255,255,255',
    '--color-black': '0,0,0',
  };
  css = css.replace(
    /color-mix\(\s*in\s+(?:oklab|srgb)\s*,\s*var\((--[a-zA-Z0-9_-]+)\)\s+([0-9.]+)%\s*,\s*transparent\s*\)/g,
    (_, vName, pct) => {
      const a = +(parseFloat(pct) / 100).toFixed(3);
      const rgb = varToRgb[vName];
      return rgb ? `rgba(${rgb},${a})` : `var(${vName})`;
    }
  );
  css = css.replace(
    /color-mix\(\s*in\s+(?:oklab|srgb)\s*,\s*#([0-9a-fA-F]{3,6})\s+([0-9.]+)%\s*,\s*transparent\s*\)/g,
    (_, hex, pct) => {
      const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
      const R = parseInt(full.slice(0, 2), 16);
      const G = parseInt(full.slice(2, 4), 16);
      const B = parseInt(full.slice(4, 6), 16);
      const a = +(parseFloat(pct) / 100).toFixed(3);
      return `rgba(${R},${G},${B},${a})`;
    }
  );
  css = css.replace(
    /color-mix\(\s*in\s+(?:oklab|srgb)\s*,\s*(white|#fff|#ffffff)\s+([0-9.]+)%\s*,\s*transparent\s*\)/gi,
    (_, __, pct) => `rgba(255,255,255,${+(parseFloat(pct) / 100).toFixed(3)})`
  );
  css = css.replace(
    /color-mix\(\s*in\s+(?:oklab|srgb)\s*,\s*(black|#000|#000000)\s+([0-9.]+)%\s*,\s*transparent\s*\)/gi,
    (_, __, pct) => `rgba(0,0,0,${+(parseFloat(pct) / 100).toFixed(3)})`
  );

  // 6. Add physical fallbacks for inset: 0 and 100dvh / overflow-x: clip
  css = css.replace(/(^|[;{])\s*inset\s*:\s*0\s*(?=[;}])/g, '$1top:0;right:0;bottom:0;left:0;inset:0');
  css = css.replace(/min-height\s*:\s*100dvh/g, 'min-height:100vh;min-height:100dvh');
  css = css.replace(/overflow-x\s*:\s*clip/g, 'overflow-x:hidden;overflow-x:clip');

  // 7. Strip simple :where(...) wrappers so older browsers never drop the selector
  css = css.replace(/:where\(([^()]+)\)/g, '$1');

  // 8. Prepend universal --tw-* defaults if @property blocks were stripped
  if (twDefaults.length) {
    css = `*,*::before,*::after,::backdrop{${twDefaults.join(';')}}\n` + css;
  }

  return css;
}

const sections = await Promise.all(sourceFiles.map(async (file) => {
  const source = await readFile(resolve(projectRoot, file), 'utf8');
  return `\n/* ── ${file} ───────────────────────────────────────────────── */\n${source}`;
}));
async function assetSection() {
  const out = {};
  for (const dir of ['providers', 'brand', 'fonts', 'icons', 'flags', 'logos']) {
    let files = [];
    try { files = await readdir(resolve(projectRoot, 'assets', dir)); } catch (_) {}
    for (const f of files.sort()) {
      if (!/\.(png|svg|ttf|otf|woff|woff2)$/i.test(f)) continue;
      const buf = await readFile(resolve(projectRoot, 'assets', dir, f));
      const mime = /\.svg$/i.test(f) ? 'image/svg+xml' : /\.png$/i.test(f) ? 'image/png' : /\.woff2$/i.test(f) ? 'font/woff2' : /\.woff$/i.test(f) ? 'font/woff' : /\.otf$/i.test(f) ? 'font/otf' : 'font/ttf';
      out['/assets/' + dir + '/' + f] = [mime, buf.toString('base64')];
    }
  }
  // Social/bot icons: inline SVG markup (title removed, currentColor) for the templates.
  const icons = {};
  let iconFiles = [];
  try { iconFiles = await readdir(resolve(projectRoot, 'assets', 'icons')); } catch (_) {}
  for (const f of iconFiles.sort()) {
    if (!/\.svg$/i.test(f)) continue;
    let svg = (await readFile(resolve(projectRoot, 'assets', 'icons', f), 'utf8')).trim();
    svg = svg.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/\s(role|xmlns)="[^"]*"/g, '').replace(/\s+/g, ' ');
    if (!/^<svg[^>]*\s(fill|stroke)=/.test(svg)) svg = svg.replace(/^<svg/, '<svg fill="currentColor"');
    icons[f.replace(/\.svg$/i, '').toLowerCase()] = svg.replace(/^<svg/, '<svg aria-hidden="true" focusable="false"');
  }
  return '\n/* ── assets/ (embedded at build time) ── */\nconst STATIC_ASSETS: Record<string, [string, string]> = ' + JSON.stringify(out) + ';\n' +
    'const SOCIAL_ICON_FILES: Record<string, string> = ' + JSON.stringify(icons) + ';\n';
}
sections.unshift(await assetSection());
// Tailwind CSS: src/styles/app.css is the only stylesheet. It is compiled here
// (utilities found in every src/**/*.ts template), lowered for universal browser
// compatibility (no @layer/@property/oklch/color-mix), and embedded as APP_CSS.
async function tailwindSection() {
  const require = createRequire(import.meta.url);
  const twDir = dirname(require.resolve('tailwindcss/package.json'));
  const entry = resolve(projectRoot, 'src/styles/app.css');
  const input = await readFile(entry, 'utf8');
  const compiler = await compile(input, {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const file = id === 'tailwindcss' ? resolve(twDir, 'index.css') : id.startsWith('tailwindcss/') ? resolve(twDir, id.slice('tailwindcss/'.length)) : resolve(base, id);
      return { path: file, base: dirname(file), content: await readFile(file, 'utf8') };
    },
  });
  const scanner = new Scanner({ sources: [{ base: resolve(projectRoot, 'src'), pattern: '**/*.ts', negated: false }] });
  let css = compiler.build(scanner.scan());
  css = lowerCssForUniversalBrowsers(css);
  const min = await transform(css, { loader: 'css', minify: true });
  css = min.code.trim();
  await writeFile(resolve(projectRoot, 'dist/app.css'), css);
  return '\n/* ── src/styles/app.css (Tailwind CSS, compiled & lowered at build time) ── */\nconst APP_CSS: string = ' + JSON.stringify(css) + ';\n';
}
await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
sections.unshift(await tailwindSection());

const combined = sections.join('\n');
const typecheckSource = resolve(projectRoot, '.build/worker.ts');
await mkdir(dirname(typecheckSource), { recursive: true });
await writeFile(typecheckSource, combined);
const result = await transform(combined, {
  loader: 'ts',
  target: 'es2022',
  format: 'esm',
  legalComments: 'none',
  sourcemap: true,
  sourcefile: 'src/worker.ts',
});
const output = resolve(projectRoot, 'dist/worker.js');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, result.code);
await writeFile(`${output}.map`, result.map);
console.log(`Built ${sourceFiles.length} source sections → dist/worker.js`);

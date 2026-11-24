// 線画チェック: お手本画像と手元の画像を、アプリと同じ線画化コード（src/lineart.ts）で変換し、
// 「元画像・変更前・変更後・差分（・正解の線）」を並べた比較画像と、数字の表を作る。
//
//   npm run linecheck                  … 変更前 = origin/main（なければ main）
//   npm run linecheck -- --base HEAD~1 … 変更前を好きなコミットにする
//   npm run linecheck -- --base none   … 変更前なし（今の版だけ）
//   npm run linecheck -- --only hair   … 名前に hair を含む画像だけ
//
// 結果は linecheck-output/ に出る（index.html をブラウザで開くと一覧で見られる）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { SCENES, linesSvg, sceneSvg, type Scene } from './scenes';
import { inkMask, measure, type Metrics } from './metrics';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'linecheck-output');
const TMP = join(ROOT, 'tools/linecheck/.tmp');
const PRIVATE_DIR = join(ROOT, 'test-images/private');

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const argValue = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = argValue('--only');
let baseRef = argValue('--base');
if (!baseRef) {
  baseRef = gitOk(['rev-parse', '--verify', '-q', 'origin/main']) ? 'origin/main' : 'main';
}

function gitOk(a: string[]): boolean {
  try {
    execFileSync('git', a, { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
function git(a: string[]): string {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// ---------------------------------------------------------------------------
// アプリと同じ前処理の設定（src/main.ts から読み取る）
// ---------------------------------------------------------------------------
function readConst(src: string, name: string, fallback: number): number {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)`).exec(src);
  return m ? Number(m[1]) : fallback;
}
const mainSrc = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
const WORK_SIZE = readConst(mainSrc, 'WORK_SIZE', 1600);
const MAX_UPSCALE = readConst(mainSrc, 'MAX_UPSCALE', 4);

// ---------------------------------------------------------------------------
// 線画化コード（今の版と、変更前の版）
// ---------------------------------------------------------------------------
type LineArt = typeof import('../../src/lineart');

async function loadVersions(): Promise<{ label: string; ref: string; mod: LineArt }[]> {
  const after = (await import('../../src/lineart')) as LineArt;
  const list = [] as { label: string; ref: string; mod: LineArt }[];
  if (baseRef && baseRef !== 'none') {
    let code: string | null = null;
    try {
      code = git(['show', `${baseRef}:src/lineart.ts`]);
    } catch {
      console.warn(`※ ${baseRef} の src/lineart.ts が読めないので、変更前の比較はしません`);
    }
    if (code !== null) {
      mkdirSync(TMP, { recursive: true });
      const file = join(TMP, 'lineart.before.ts');
      writeFileSync(file, code);
      const before = (await import(/* @vite-ignore */ file)) as LineArt;
      const sha = git(['rev-parse', '--short', baseRef]).trim();
      list.push({ label: `変更前（${baseRef} ${sha}）`, ref: baseRef, mod: before });
    }
  }
  let head = '作業中';
  try {
    head = git(['rev-parse', '--short', 'HEAD']).trim();
    if (git(['status', '--porcelain', 'src/lineart.ts']).trim()) head += ' + 未コミットの変更';
  } catch {
    /* git がなくても動かす */
  }
  list.push({ label: `変更後（${head}）`, ref: 'HEAD', mod: after });
  return list;
}

// ---------------------------------------------------------------------------
// 入力画像
// ---------------------------------------------------------------------------
interface Input {
  id: string;
  title: string;
  checks: string[];
  /** 元画像（エンコード済み） */
  image: Buffer;
  scene?: Scene;
}

async function loadInputs(): Promise<Input[]> {
  const inputs: Input[] = [];
  for (const s of SCENES) {
    let img = await sharp(Buffer.from(sceneSvg(s))).png().toBuffer();
    if (s.jpegQuality) img = await sharp(img).jpeg({ quality: s.jpegQuality }).toBuffer();
    inputs.push({ id: s.id, title: s.title, checks: s.checks, image: img, scene: s });
  }
  if (existsSync(PRIVATE_DIR)) {
    for (const f of readdirSync(PRIVATE_DIR).sort()) {
      if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(f)) continue;
      inputs.push({
        id: `private-${basename(f, extname(f))}`,
        title: `手元の画像: ${f}`,
        checks: ['目で見て確かめる（docs/線画チェック.md の観点）'],
        image: readFileSync(join(PRIVATE_DIR, f)),
      });
    }
  }
  return only ? inputs.filter((i) => i.id.includes(only)) : inputs;
}

/** アプリと同じく、長辺 WORK_SIZE（拡大は MAX_UPSCALE 倍まで）にして白地に置く */
async function prepare(image: Buffer) {
  const meta = await sharp(image).metadata();
  const sw = meta.width!, sh = meta.height!;
  const scale = Math.min(WORK_SIZE / Math.max(sw, sh), MAX_UPSCALE);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const { data } = await sharp(image)
    .flatten({ background: '#ffffff' })
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { w, h, scale, rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

async function renderMask(svg: string): Promise<Uint8Array> {
  const { data, info } = await sharp(Buffer.from(svg)).flatten({ background: '#fff' }).raw().toBuffer({ resolveWithObject: true });
  return inkMask(data, info.width, info.height, info.channels);
}

// ---------------------------------------------------------------------------
// 比較画像
// ---------------------------------------------------------------------------
const PANEL_H = 700;
const LABEL_H = 44;

function label(text: string, w: number, color = '#333') {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${LABEL_H}"><rect width="100%" height="100%" fill="${color}"/>` +
      `<text x="12" y="30" font-family="sans-serif" font-size="24" font-weight="bold" fill="#fff">${esc}</text></svg>`,
  );
}

/** 変更前と変更後の違いを色で示す（赤 = 消えた線、青 = 増えた線、灰 = 同じ線） */
function diffImage(before: Uint8Array, after: Uint8Array, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 3, 255);
  for (let i = 0; i < w * h; i++) {
    const b = before[i], a = after[i];
    const o = i * 3;
    if (b && a) out.fill(170, o, o + 3);
    else if (b) (out[o] = 230), (out[o + 1] = 30), (out[o + 2] = 30);
    else if (a) (out[o] = 30), (out[o + 1] = 90), (out[o + 2] = 230);
  }
  return out;
}

function maskToRgb(mask: Uint8Array, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 3, 255);
  for (let i = 0; i < w * h; i++) if (mask[i]) out.fill(0, i * 3, i * 3 + 3);
  return out;
}

async function panel(raw: Buffer, w: number, h: number, channels: 3 | 4, text: string, color?: string) {
  const pw = Math.round((w * PANEL_H) / h);
  const img = await sharp(raw, { raw: { width: w, height: h, channels } }).resize(pw, PANEL_H, { kernel: 'lanczos3' }).png().toBuffer();
  return {
    width: pw,
    buf: await sharp({ create: { width: pw, height: PANEL_H + LABEL_H, channels: 3, background: '#fff' } })
      .composite([
        { input: label(text, pw, color), top: 0, left: 0 },
        { input: img, top: LABEL_H, left: 0 },
      ])
      .png()
      .toBuffer(),
  };
}

async function sideBySide(panels: { width: number; buf: Buffer }[], file: string) {
  const gap = 12;
  const width = panels.reduce((s, p) => s + p.width, 0) + gap * (panels.length - 1);
  let left = 0;
  const comps = panels.map((p) => {
    const c = { input: p.buf, top: 0, left };
    left += p.width + gap;
    return c;
  });
  await sharp({ create: { width, height: PANEL_H + LABEL_H, channels: 3, background: '#888' } })
    .composite(comps)
    .png()
    .toFile(file);
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
interface Row {
  input: Input;
  preset: string;
  file: string;
  metrics: (Metrics | null)[]; // versions の順
}

async function main() {
  const versions = await loadVersions();
  const after = versions[versions.length - 1].mod;
  const presets: [string, { thickness: number; detail: number; centerLine?: boolean }][] = [
    ...Object.entries(after.PRESETS).map(([k, p]) => [`${k}（${p.label}）`, { thickness: p.thickness, detail: p.detail }] as [string, { thickness: number; detail: number }]),
    ['max-detail（太さ6・細かさ10）', { thickness: 6, detail: 10 }],
  ];
  const inputs = await loadInputs();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'full'), { recursive: true });

  const rows: Row[] = [];
  for (const input of inputs) {
    const t0 = Date.now();
    const { w, h, scale, rgba } = await prepare(input.image);
    let truth: { required: Record<string, Uint8Array>; allowed: Uint8Array } | undefined;
    let truthAll: Uint8Array | undefined;
    if (input.scene) {
      const s = input.scene;
      truth = { required: {}, allowed: await renderMask(linesSvg(s, s.groups.map((g) => g.id), w, h)) };
      for (const g of s.groups.filter((g) => g.required)) truth.required[g.label] = await renderMask(linesSvg(s, [g.id], w, h));
      truthAll = truth.allowed;
    }
    const maps = versions.map((v) => {
      try {
        return v.mod.computeEdgeMaps(new Uint8ClampedArray(rgba), w, h, scale);
      } catch (e) {
        console.warn(`※ ${v.label} で読み込みに失敗: ${e}`);
        return null;
      }
    });
    for (const [pname, params] of presets) {
      const masks = versions.map((v, k) => {
        if (!maps[k]) return null;
        try {
          return inkMask(v.mod.renderLineArt(maps[k]!, { ...params, centerLine: true }), w, h);
        } catch (e) {
          console.warn(`※ ${v.label} で線画化に失敗: ${e}`);
          return null;
        }
      });
      const metrics = masks.map((m) => (m ? measure(m, w, h, truth) : null));
      const key = `${input.id}__${pname.split('（')[0]}`;
      const panels = [await panel(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length), w, h, 4, 'ORIGINAL', '#555')];
      const vColors = ['#9a6a00', '#1d7a3a'];
      for (let k = 0; k < versions.length; k++) {
        const m = masks[k];
        const isAfter = k === versions.length - 1;
        const text = isAfter ? 'AFTER (this branch)' : `BEFORE (${versions[k].ref})`;
        panels.push(await panel(m ? maskToRgb(m, w, h) : Buffer.alloc(w * h * 3, 200), w, h, 3, text, vColors[isAfter ? 1 : 0]));
        if (m) await sharp(maskToRgb(m, w, h), { raw: { width: w, height: h, channels: 3 } }).png().toFile(join(OUT, 'full', `${key}__${isAfter ? 'after' : 'before'}.png`));
      }
      if (versions.length === 2 && masks[0] && masks[1]) {
        panels.push(await panel(diffImage(masks[0], masks[1], w, h), w, h, 3, 'DIFF red=lost blue=new', '#444'));
      }
      if (truthAll) panels.push(await panel(maskToRgb(truthAll, w, h), w, h, 3, 'IDEAL LINES', '#335'));
      const file = `${key}.png`;
      await sideBySide(panels, join(OUT, file));
      rows.push({ input, preset: pname, file, metrics });
    }
    console.log(`✓ ${input.id}（${w}x${h}、${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  }

  writeFileSync(join(OUT, 'index.html'), html(rows, versions.map((v) => v.label)));
  writeFileSync(join(OUT, 'summary.md'), summary(rows, versions.map((v) => v.label)));
  console.log(`\n比較画像: ${join(OUT, 'index.html')}`);
  const worse = rows.filter((r) => r.metrics.length === 2 && verdict(r.metrics[0], r.metrics[1]).worse.length);
  if (worse.length) {
    console.log(`\n⚠ 悪くなったかもしれない組み合わせが ${worse.length} 件あります（summary.md を見てください）`);
    if (args.includes('--strict')) process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 判定とレポート
// ---------------------------------------------------------------------------
/** 数字がどれだけ変わったら「良くなった／悪くなった」と言うか（% ポイント） */
const MARGIN = 2;

function verdict(b: Metrics | null, a: Metrics | null) {
  const better: string[] = [], worse: string[] = [];
  if (!b || !a) return { better, worse };
  for (const [k, va] of Object.entries(a.recall ?? {})) {
    const vb = b.recall?.[k];
    if (vb === undefined) continue;
    if (va > vb + MARGIN) better.push(`${k}の見つかり率`);
    if (va < vb - MARGIN) worse.push(`${k}の見つかり率`);
  }
  if (a.noise !== undefined && b.noise !== undefined) {
    if (a.noise < b.noise - MARGIN) better.push('余計な線');
    if (a.noise > b.noise + MARGIN) worse.push('余計な線');
  }
  if (a.blob < b.blob - MARGIN) better.push('黒い塊');
  if (a.blob > b.blob + MARGIN) worse.push('黒い塊');
  return { better, worse };
}

const f = (v: number | undefined) => (v === undefined ? '-' : v.toFixed(1));

function metricCells(rows: Row[], versions: string[]) {
  return rows.map((r) => {
    const keys = Object.keys(r.metrics.find((m) => m)?.recall ?? {});
    const cols: { name: string; vals: string[] }[] = [
      ...keys.map((k) => ({ name: `${k}の見つかり率 %（高いほど良い）`, vals: r.metrics.map((m) => f(m?.recall?.[k])) })),
    ];
    if (r.input.scene) cols.push({ name: '余計な線・二重線 %（低いほど良い）', vals: r.metrics.map((m) => f(m?.noise)) });
    cols.push({ name: '黒い塊 %（低いほど良い）', vals: r.metrics.map((m) => f(m?.blob)) });
    cols.push({ name: '黒の割合 %（参考）', vals: r.metrics.map((m) => f(m?.ink)) });
    const v = r.metrics.length === 2 ? verdict(r.metrics[0], r.metrics[1]) : { better: [], worse: [] };
    return { r, cols, v, versions };
  });
}

function summary(rows: Row[], versions: string[]): string {
  const lines = [`## 線画チェックの結果`, '', `比べたもの: ${versions.join(' → ')}`, ''];
  lines.push('| 画像 | 設定 | 判定 | ' + (versions.length === 2 ? '見つかり率（前→後） | 余計な線（前→後） | 黒い塊（前→後） |' : '見つかり率 | 余計な線 | 黒い塊 |'));
  lines.push('|---|---|---|---|---|---|');
  for (const { r, v } of metricCells(rows, versions)) {
    const mark = r.metrics.length < 2 ? '（比較なし）' : v.worse.length ? `⚠ 悪化: ${v.worse.join('、')}` : v.better.length ? `◎ 改善: ${v.better.join('、')}` : '― 変化なし';
    const rec = r.metrics.map((m) => (m?.recall ? Object.entries(m.recall).map(([k, x]) => `${k} ${f(x)}`).join(' / ') : '-')).join(' → ');
    const noise = r.metrics.map((m) => f(m?.noise)).join(' → ');
    const blob = r.metrics.map((m) => f(m?.blob)).join(' → ');
    lines.push(`| ${r.input.title} | ${r.preset} | ${mark} | ${rec} | ${noise} | ${blob} |`);
  }
  lines.push('', '比較画像は、このページ下の Artifacts の「linecheck」をダウンロードして index.html を開くと見られます。');
  lines.push('数字の意味とチェック観点は docs/線画チェック.md にあります。');
  return lines.join('\n') + '\n';
}

function html(rows: Row[], versions: string[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const blocks = metricCells(rows, versions)
    .map(({ r, cols, v }) => {
      const mark = r.metrics.length < 2
        ? ''
        : v.worse.length
        ? `<span class="bad">⚠ 悪化: ${esc(v.worse.join('、'))}</span>`
        : v.better.length
          ? `<span class="good">◎ 改善: ${esc(v.better.join('、'))}</span>`
          : '<span>― 大きな変化なし</span>';
      const table =
        `<table><tr><th></th>${versions.map((x) => `<th>${esc(x)}</th>`).join('')}</tr>` +
        cols.map((c) => `<tr><td>${esc(c.name)}</td>${c.vals.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('') +
        '</table>';
      return `<section><h2>${esc(r.input.title)} ― ${esc(r.preset)}</h2>
<p class="checks">見るところ: ${r.input.checks.map(esc).join(' ／ ')}</p>
<p>${mark}</p>${table}
<a href="${r.file}" target="_blank"><img src="${r.file}" loading="lazy"></a></section>`;
    })
    .join('\n');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>線画チェック</title>
<style>body{font-family:sans-serif;margin:16px;background:#faf7f2}section{background:#fff;border-radius:8px;padding:12px;margin:0 0 20px}
img{max-width:100%;border:1px solid #ccc}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ddd;padding:4px 8px;font-size:14px;text-align:right}
td:first-child{text-align:left}.bad{color:#c00;font-weight:bold}.good{color:#080;font-weight:bold}.checks{color:#555}</style>
<h1>線画チェック</h1><p>比べたもの: ${versions.map(esc).join(' → ')}</p>
<p>画像の並び: 元画像 ／ 変更前 ／ 変更後 ／ 差分（赤 = 消えた線、青 = 増えた線） ／ 正解の線（お手本画像のみ）。画像をクリックすると大きく開きます。<br>
等倍の結果は full/ フォルダにあります。数字の意味は docs/線画チェック.md を見てください。</p>
${blocks}</html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

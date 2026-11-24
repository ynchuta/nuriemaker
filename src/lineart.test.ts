import { describe, expect, it } from 'vitest';
import { computeEdgeMaps, distanceTransform, removeSmallComponents, renderLineArt, thin } from './lineart';

function makeImage(w: number, h: number, paint: (x: number, y: number) => [number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  return px;
}

const isBlack = (out: Uint8ClampedArray, w: number, x: number, y: number) => out[(y * w + x) * 4] < 128;

describe('lineart', () => {
  it('細い黒線を拾い、白地は白のまま', () => {
    const w = 200, h = 200;
    const img = makeImage(w, h, (x) => (x >= 99 && x <= 101 ? [0, 0, 0] : [255, 255, 255]));
    const out = renderLineArt(computeEdgeMaps(img, w, h), { thickness: 1, detail: 5 });
    expect(isBlack(out, w, 100, 100)).toBe(true);
    expect(isBlack(out, w, 50, 100)).toBe(false);
  });

  it('黒く塗られた広い面は輪郭だけ残す', () => {
    const w = 200, h = 200;
    const img = makeImage(w, h, (x, y) => (x > 40 && x < 160 && y > 40 && y < 160 ? [10, 10, 10] : [255, 255, 255]));
    for (const centerLine of [true, false]) {
      const out = renderLineArt(computeEdgeMaps(img, w, h), { thickness: 1, detail: 5, centerLine });
      let edge = false;
      for (let x = 40; x <= 50; x++) if (isBlack(out, w, x, 100)) edge = true;
      expect(edge).toBe(true); // 縁
      expect(isBlack(out, w, 100, 100)).toBe(false); // 中
    }
  });

  it('太い黒線は中心線モードで 1 本の線になる（白抜きにならない）', () => {
    const w = 300, h = 300;
    // 元画像 4px の線を 4 倍に拡大した想定（16px 幅）
    const img = makeImage(w, h, (x) => (x >= 142 && x < 158 ? [0, 0, 0] : [255, 255, 255]));
    const maps = computeEdgeMaps(img, w, h, 4);
    const row = (out: Uint8ClampedArray) => {
      let s = '';
      for (let x = 130; x < 170; x++) s += isBlack(out, w, x, 150) ? '#' : '.';
      return s;
    };
    const center = row(renderLineArt(maps, { thickness: 3, detail: 5, centerLine: true }));
    // 黒い部分が 1 かたまりだけ
    expect(center.replace(/\.+/g, ' ').trim().split(' ')).toHaveLength(1);
    // 太さは元の線（16px）ではなく「線の太さ」で決まる
    expect(center.split('#').length - 1).toBeLessThan(12);
  });

  it('細線化で幅 1px の線になる', () => {
    const w = 30, h = 30;
    const m = new Uint8Array(w * h);
    for (let y = 5; y < 25; y++) for (let x = 10; x < 17; x++) m[y * w + x] = 1;
    thin(m, w, h);
    let widthAtMiddle = 0;
    for (let x = 0; x < w; x++) widthAtMiddle += m[15 * w + x];
    expect(widthAtMiddle).toBe(1);
  });

  it('色の境目にも線が出る', () => {
    const w = 200, h = 200;
    const img = makeImage(w, h, (x) => (x < 100 ? [240, 120, 120] : [120, 160, 240]));
    const out = renderLineArt(computeEdgeMaps(img, w, h), { thickness: 1, detail: 8 });
    const row = 100;
    let found = false;
    for (let x = 95; x <= 105; x++) if (isBlack(out, w, x, row)) found = true;
    expect(found).toBe(true);
    expect(isBlack(out, w, 30, row)).toBe(false);
  });

  it('太さを上げると黒い画素が増える', () => {
    const w = 200, h = 200;
    const img = makeImage(w, h, (x) => (x === 100 ? [0, 0, 0] : [255, 255, 255]));
    const maps = computeEdgeMaps(img, w, h);
    const count = (o: Uint8ClampedArray) => { let c = 0; for (let i = 0; i < o.length; i += 4) if (o[i] < 128) c++; return c; };
    expect(count(renderLineArt(maps, { thickness: 8, detail: 5 }))).toBeGreaterThan(count(renderLineArt(maps, { thickness: 1, detail: 5 })));
  });

  it('小さな点を消す', () => {
    const w = 10, h = 10;
    const m = new Uint8Array(w * h);
    m[11] = 1; // 1 画素の点
    for (let x = 2; x < 9; x++) m[5 * w + x] = 1; // 7 画素の線
    removeSmallComponents(m, w, h, 3);
    expect(m[11]).toBe(0);
    expect(m[5 * w + 4]).toBe(1);
  });

  it('距離変換', () => {
    const m = new Uint8Array(25);
    m[12] = 1;
    const d = distanceTransform(m, 5, 5);
    expect(d[12]).toBe(0);
    expect(d[13]).toBeCloseTo(1);
    expect(d[18]).toBeCloseTo(Math.SQRT2);
  });
});

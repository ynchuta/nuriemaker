import { describe, expect, it } from 'vitest';
import { computeEdgeMaps, distanceTransform, removeSmallComponents, renderLineArt } from './lineart';

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
    const out = renderLineArt(computeEdgeMaps(img, w, h), { thickness: 1, detail: 5 });
    expect(isBlack(out, w, 42, 100)).toBe(true); // 縁
    expect(isBlack(out, w, 100, 100)).toBe(false); // 中
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

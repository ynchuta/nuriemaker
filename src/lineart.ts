// 線画化の処理本体。DOM に依存しないので Web Worker とテストの両方から使える。
//
// 流れ:
//   1. 色を少しぼかしてノイズや JPEG のモヤを消す
//   2. 「線らしさ」を 3 種類の手がかりで拾う
//        - DoG（ぼかし幅の違う 2 枚の差）: 周りより暗い細い線
//        - 色の境目（Sobel）: 線が描かれていない色の切り替わり
//        - 暗い領域の縁: 太い黒線はそのまま、黒く塗られた広い面（髪や影）は輪郭だけ
//   3. しきい値で白黒にする（「細かさ」）
//   4. 小さな黒い点を消す
//   5. 線を太らせる（「線の太さ」）

export interface LineArtParams {
  /** 線の太さ 1〜10 */
  thickness: number;
  /** 細かさ 1〜10（大きいほど細かい線まで残す） */
  detail: number;
}

/** 画像から一度だけ計算しておけば、スライダー操作のたびに使い回せる中間データ */
export interface EdgeMaps {
  width: number;
  height: number;
  /** DoG 応答（周りより暗いほど大きい、0〜255 程度） */
  dog: Float32Array;
  /** 色の境目の強さ（0〜1020 程度） */
  colorEdge: Float32Array;
  /** 暗い領域の縁（0/1）。暗さのしきい値ごとに用意 */
  darkOutline: Uint8Array[];
}

/** 暗い領域とみなす明るさの候補（細かさに応じて選ぶ） */
const DARK_LEVELS = [60, 75, 90, 105];
/** 黒く塗られた面の輪郭として残す幅（px） */
const DARK_BAND = 3;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 分離型ガウスぼかし（端は端の値で延長） */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice();
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  // 横方向
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = clamp(x + k, 0, w - 1);
        acc += src[row + xx] * kernel[k + r];
      }
      tmp[row + x] = acc;
    }
  }
  // 縦方向
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = clamp(y + k, 0, h - 1);
        acc += tmp[yy * w + x] * kernel[k + r];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * 2 値画像に対する近似ユークリッド距離変換（チャンファー 3-4）。
 * 各画素から「target === 1 の画素」までの距離（px 単位）を返す。
 */
export function distanceTransform(target: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = target[i] ? 0 : INF;
  const a = 1;
  const b = Math.SQRT2;
  // 前方走査
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  }
  // 後方走査
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

/** 8 近傍でつながった黒画素のかたまりのうち、面積が minArea 未満のものを消す */
export function removeSmallComponents(mask: Uint8Array, w: number, h: number, minArea: number): void {
  if (minArea <= 1) return;
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const members = new Int32Array(w * h);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let sp = 0;
    let count = 0;
    stack[sp++] = start;
    visited[start] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      members[count++] = i;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !visited[j]) {
            visited[j] = 1;
            stack[sp++] = j;
          }
        }
      }
    }
    if (count < minArea) {
      for (let k = 0; k < count; k++) mask[members[k]] = 0;
    }
  }
}

/**
 * RGBA 画像から中間データを作る。重い処理はここに集めてあり、画像ごとに 1 回だけ呼ぶ。
 * 透明な部分は白として扱う。
 */
export function computeEdgeMaps(rgba: Uint8ClampedArray, w: number, h: number): EdgeMaps {
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    r[i] = rgba[i * 4] * alpha + 255 * (1 - alpha);
    g[i] = rgba[i * 4 + 1] * alpha + 255 * (1 - alpha);
    b[i] = rgba[i * 4 + 2] * alpha + 255 * (1 - alpha);
  }

  // 1. ごく弱くぼかす
  const rb = gaussianBlur(r, w, h, 0.8);
  const gb = gaussianBlur(g, w, h, 0.8);
  const bb = gaussianBlur(b, w, h, 0.8);
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * rb[i] + 0.587 * gb[i] + 0.114 * bb[i];

  // 2a. DoG: 広くぼかした画像 − 狭くぼかした画像。暗い線の上で正の値になる
  //     太い線（拡大したスクショなど）も拾えるよう、細かいものと粗いものの 2 段階で見る
  const g1 = gaussianBlur(gray, w, h, 1.0);
  const g2 = gaussianBlur(gray, w, h, 2.2);
  const g3 = gaussianBlur(gray, w, h, 4.8);
  const dog = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const fine = g2[i] - g1[i];
    const coarse = (g3[i] - g2[i]) * 0.8;
    dog[i] = Math.max(0, fine, coarse);
  }

  // 2b. 色の境目: RGB それぞれの Sobel の強さの最大値
  const colorEdge = new Float32Array(n);
  const chans = [rb, gb, bb];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = 0;
      for (const c of chans) {
        const gx =
          c[i - w + 1] + 2 * c[i + 1] + c[i + w + 1] - c[i - w - 1] - 2 * c[i - 1] - c[i + w - 1];
        const gy =
          c[i + w - 1] + 2 * c[i + w] + c[i + w + 1] - c[i - w - 1] - 2 * c[i - w] - c[i - w + 1];
        const m = Math.sqrt(gx * gx + gy * gy);
        if (m > best) best = m;
      }
      colorEdge[i] = best;
    }
  }
  // Sobel は境目の両側で反応して線が 2 本になりやすいので、勾配方向の極大だけ残す（簡易版）
  const thinEdge = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = colorEdge[i];
      if (v === 0) continue;
      const horizMax = v >= colorEdge[i - 1] && v >= colorEdge[i + 1];
      const vertMax = v >= colorEdge[i - w] && v >= colorEdge[i + w];
      if (horizMax || vertMax) thinEdge[i] = v;
    }
  }

  // 2c. 暗い領域の縁: 暗い画素のうち、明るい画素から DARK_BAND 以内のものだけ残す
  //     → 細い黒線は丸ごと、黒い面は輪郭の帯だけになる
  const darkOutline = DARK_LEVELS.map((level) => {
    const light = new Uint8Array(n);
    for (let i = 0; i < n; i++) light[i] = gray[i] >= level ? 1 : 0;
    const distToLight = distanceTransform(light, w, h);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = !light[i] && distToLight[i] <= DARK_BAND ? 1 : 0;
    return out;
  });

  return { width: w, height: h, dog, colorEdge: thinEdge, darkOutline };
}

/** 細かさ 1〜10 からしきい値類を決める */
export function thresholdsFor(detail: number) {
  const t = clamp((detail - 1) / 9, 0, 1);
  return {
    dogThreshold: lerp(16, 3.5, t),
    colorThreshold: lerp(520, 150, t),
    darkLevelIndex: Math.round(lerp(0, DARK_LEVELS.length - 1, t)),
    minArea: Math.round(lerp(160, 30, t)),
  };
}

/** 線の太さ 1〜10 から、線を太らせる半径（px）を決める */
export function radiusFor(thickness: number, width: number, height: number): number {
  // 長辺 1600px を基準にし、画像が小さいときは比例して細くする
  const scale = Math.max(width, height) / 1600;
  return (clamp(thickness, 1, 10) - 1) * 0.75 * scale;
}

/**
 * 中間データとパラメータから線画を作る。戻り値は RGBA（白地に黒線、縁は少しなめらか）。
 */
export function renderLineArt(maps: EdgeMaps, params: LineArtParams): Uint8ClampedArray {
  const { width: w, height: h, dog, colorEdge, darkOutline } = maps;
  const n = w * h;
  const th = thresholdsFor(params.detail);
  const dark = darkOutline[th.darkLevelIndex];

  // 3. 白黒にする
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (dog[i] > th.dogThreshold || colorEdge[i] > th.colorThreshold || dark[i]) mask[i] = 1;
  }
  // 画像の外周 2px は誤検出が多いので消す
  for (let x = 0; x < w; x++) {
    for (const y of [0, 1, h - 2, h - 1]) if (y >= 0 && y < h) mask[y * w + x] = 0;
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, 1, w - 2, w - 1]) if (x >= 0 && x < w) mask[y * w + x] = 0;
  }

  // 4. 小さな点を消す（画像サイズに合わせて面積を調整）
  const areaScale = (Math.max(w, h) / 1600) ** 2;
  removeSmallComponents(mask, w, h, Math.max(2, Math.round(th.minArea * areaScale)));

  // 5. 線を太らせる。距離変換を使うと丸いペンでなぞったような太り方になる
  const radius = radiusFor(params.thickness, w, h);
  const dist = distanceTransform(mask, w, h);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    // 縁を 1px ぶんなめらかにする
    const ink = clamp(radius + 1 - dist[i], 0, 1);
    const v = Math.round(255 * (1 - ink));
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** 年齢別プリセット */
export const PRESETS: Record<string, LineArtParams & { label: string }> = {
  age3: { label: '3歳向け', thickness: 7, detail: 2 },
  age5: { label: '5歳向け', thickness: 4, detail: 5 },
  age8: { label: '8歳向け', thickness: 2, detail: 8 },
};

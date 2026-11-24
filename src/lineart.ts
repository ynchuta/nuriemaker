// 線画化の処理本体。DOM に依存しないので Web Worker とテストの両方から使える。
//
// 流れ:
//   1. 色を少しぼかしてノイズや JPEG のモヤを消す
//   2. 「線らしさ」を 2 種類の手がかりで拾う
//        - 周りより暗い細い部分（ブラックトップハット）: 描かれた線。背景が赤や黒でも、
//          「その場所の周りと比べてどれだけ暗いか」で見るので、暗い色の面そのものは線にならない
//        - 色の境目（Sobel）: 線が描かれていない色の切り替わり（髪と背景の境目など）
//   3. しきい値で白黒にする（「細かさ」）
//   4. 小さな黒い点を消す
//   5. （中心線モード）線を 1px の中心線まで細くする
//   6. 線を太らせる（「線の太さ」）

export interface LineArtParams {
  /** 線の太さ 1〜10 */
  thickness: number;
  /** 細かさ 1〜10（大きいほど細かい線まで残す） */
  detail: number;
  /**
   * 太い輪郭線を白抜きにせず、線の中心を取り出して「線の太さ」で描き直す（初期値 true）。
   * false のときは見つけた線をそのまま太らせる。
   */
  centerLine?: boolean;
}

/** 画像から一度だけ計算しておけば、スライダー操作のたびに使い回せる中間データ */
export interface EdgeMaps {
  width: number;
  height: number;
  /** 線らしさ（周りの明るさに比べてどれだけ暗いか、0〜255） */
  line: Float32Array;
  /** 色の境目の強さ（0〜1020 程度、境目の中心だけ） */
  colorEdge: Float32Array;
  /** 線とみなす最大の太さの半分（作業用画像の px） */
  lineRadius: number;
}

/** 元画像で、1 本の線とみなす太さの半分（px） */
const LINE_HALF_WIDTH_SOURCE = 4;
/** 強い線につながっていれば残す、弱い線のしきい値の割合 */
const WEAK_RATIO = 0.45;

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

/** 1 次元の最大値／最小値フィルタ（van Herk / Gil-Werman 法、半径 r） */
function minMax1D(src: Float32Array, dst: Float32Array, len: number, offset: number, stride: number, r: number, isMax: boolean) {
  const k = 2 * r + 1;
  const n = len + 2 * r;
  const ext = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.min(len - 1, Math.max(0, i - r));
    ext[i] = src[offset + j * stride];
  }
  const g = new Float32Array(n);
  const hbuf = new Float32Array(n);
  const pick = isMax ? Math.max : Math.min;
  for (let i = 0; i < n; i++) g[i] = i % k === 0 ? ext[i] : pick(g[i - 1], ext[i]);
  for (let i = n - 1; i >= 0; i--) hbuf[i] = i % k === k - 1 || i === n - 1 ? ext[i] : pick(hbuf[i + 1], ext[i]);
  for (let x = 0; x < len; x++) {
    // 窓 [x, x + 2r]（ext 上）
    dst[offset + x * stride] = pick(hbuf[x], g[x + 2 * r]);
  }
}

/** 正方形の窓での最大値／最小値フィルタ */
export function rankFilter(src: Float32Array, w: number, h: number, r: number, isMax: boolean): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) minMax1D(src, tmp, w, y * w, 1, r, isMax);
  for (let x = 0; x < w; x++) minMax1D(tmp, out, h, x, w, r, isMax);
  return out;
}

/**
 * RGBA 画像から中間データを作る。重い処理はここに集めてあり、画像ごとに 1 回だけ呼ぶ。
 * 透明な部分は白として扱う。sourceScale は元画像 1px が作業用画像で何 px になったか。
 */
export function computeEdgeMaps(rgba: Uint8ClampedArray, w: number, h: number, sourceScale = 1): EdgeMaps {
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
  const blurSigma = clamp(0.5 * sourceScale, 0.7, 1.6);
  const rb = gaussianBlur(r, w, h, blurSigma);
  const gb = gaussianBlur(g, w, h, blurSigma);
  const bb = gaussianBlur(b, w, h, blurSigma);
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * rb[i] + 0.587 * gb[i] + 0.114 * bb[i];

  // 2a. ブラックトップハット: 「線の太さより広い範囲での明るさ（クロージング）」と自分の差。
  //     線より広い暗い面（黒髪・赤い背景など）は差が 0 になるので線にならない。
  //     暗い背景の上の線も拾えるよう、周りの明るさで割って比率にする。
  const lineRadius = Math.round(clamp(LINE_HALF_WIDTH_SOURCE * sourceScale, 3, 16));
  const closed = rankFilter(rankFilter(gray, w, h, lineRadius, true), w, h, lineRadius, false);
  const line = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = closed[i];
    line[i] = Math.max(0, ((c - gray[i]) / Math.max(c, 110)) * 255);
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

  return { width: w, height: h, line, colorEdge: thinEdge, lineRadius };
}

/** 細かさ 1〜10 からしきい値類を決める */
export function thresholdsFor(detail: number) {
  const t = clamp((detail - 1) / 9, 0, 1);
  return {
    lineThreshold: lerp(80, 16, t),
    colorThreshold: lerp(480, 140, t),
    minArea: Math.round(lerp(160, 30, t)),
  };
}

/** 線の太さ 1〜10 から、線を太らせる半径（px）を決める */
export function radiusFor(thickness: number, width: number, height: number): number {
  // 長辺 1600px を基準にし、画像が小さいときは比例して細くする
  const scale = Math.max(width, height) / 1600;
  return (clamp(thickness, 1, 10) - 1) * 0.75 * scale;
}

/** 中心線モードの線の半径（px）。中心線は 1px なので、太さ 1 でも見える太さから始める */
export function centerRadiusFor(thickness: number, width: number, height: number): number {
  const scale = Math.max(width, height) / 1600;
  return (1.2 + (clamp(thickness, 1, 10) - 1) * 0.8) * scale;
}

/**
 * Zhang-Suen 法による細線化。黒画素（1）の線を、つながりを保ったまま幅 1px の中心線にする（mask を直接書き換える）。
 */
export function thin(mask: Uint8Array, w: number, h: number): void {
  // 端の 1px は扱いを簡単にするため白にする
  for (let x = 0; x < w; x++) {
    mask[x] = 0;
    mask[(h - 1) * w + x] = 0;
  }
  for (let y = 0; y < h; y++) {
    mask[y * w] = 0;
    mask[y * w + w - 1] = 0;
  }
  // 調べる候補（黒画素）の一覧。消えた画素は次の回から外す
  let candidates: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) candidates.push(i);
  const toDelete: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      toDelete.length = 0;
      for (const i of candidates) {
        if (!mask[i]) continue;
        // 近傍 P2..P9（上から時計回り）
        const p2 = mask[i - w], p3 = mask[i - w + 1], p4 = mask[i + 1], p5 = mask[i + w + 1];
        const p6 = mask[i + w], p7 = mask[i + w - 1], p8 = mask[i - 1], p9 = mask[i - w - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a =
          (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
          (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
        if (a !== 1) continue;
        if (step === 0) {
          if (p2 && p4 && p6) continue;
          if (p4 && p6 && p8) continue;
        } else {
          if (p2 && p4 && p8) continue;
          if (p2 && p6 && p8) continue;
        }
        toDelete.push(i);
      }
      if (toDelete.length) {
        changed = true;
        for (const i of toDelete) mask[i] = 0;
      }
    }
    if (changed) candidates = candidates.filter((i) => mask[i] === 1);
  }
}

/**
 * 1px の中心線から、分かれ道から伸びた maxLen px 未満の短い枝を取り除く（mask を直接書き換える）。
 * 分かれ道につながっていない線（1 本だけの線）は残す。
 */
export function pruneSpurs(mask: Uint8Array, w: number, h: number, maxLen: number): void {
  const offsets = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  const neighbors = (i: number, out: number[]) => {
    out.length = 0;
    const x = i % w;
    for (const o of offsets) {
      const j = i + o;
      if (j < 0 || j >= w * h) continue;
      const xx = j % w;
      if (Math.abs(xx - x) > 1) continue;
      if (mask[j]) out.push(j);
    }
    return out;
  };
  const nb: number[] = [];
  const endpoints: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] && neighbors(i, nb).length === 1) endpoints.push(i);
  const onPath = new Uint8Array(mask.length);
  for (const start of endpoints) {
    if (!mask[start]) continue;
    const path = [start];
    onPath[start] = 1;
    let cur = start;
    let reachedJunction = false;
    while (path.length < maxLen) {
      const next = neighbors(cur, nb).filter((j) => !onPath[j]);
      if (next.length === 0) break; // 線の反対の端まで来た
      // 今いる画素以外に 2 方向以上へ分かれていたら分かれ道
      if (next.length >= 2 && path.length > 1) {
        reachedJunction = true;
        break;
      }
      if (next.length >= 2) break;
      cur = next[0];
      if (neighbors(cur, nb).length >= 3) {
        reachedJunction = true;
        break;
      }
      path.push(cur);
      onPath[cur] = 1;
    }
    for (const i of path) onPath[i] = 0;
    if (reachedJunction && path.length < maxLen) for (const i of path) mask[i] = 0;
  }
}

/**
 * 中間データとパラメータから線画を作る。戻り値は RGBA（白地に黒線、縁は少しなめらか）。
 */
export function renderLineArt(maps: EdgeMaps, params: LineArtParams): Uint8ClampedArray {
  const { width: w, height: h, line, colorEdge, lineRadius } = maps;
  const n = w * h;
  const th = thresholdsFor(params.detail);
  const centerLine = params.centerLine ?? true;

  // 3. 白黒にする。はっきりした線（強）から、つながっている薄めの線（弱）までたどって残す
  //    （ヒステリシスしきい値。線が途切れ途切れになるのを防ぐ）
  const mask = new Uint8Array(n);
  const weak = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = line[i];
    const c = colorEdge[i];
    if (l > th.lineThreshold || c > th.colorThreshold) {
      mask[i] = 1;
      stack.push(i);
    } else if (l > th.lineThreshold * WEAK_RATIO || c > th.colorThreshold * WEAK_RATIO) {
      weak[i] = 1;
    }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (weak[j] && !mask[j]) {
          mask[j] = 1;
          stack.push(j);
        }
      }
    }
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

  // 5. 中心線モードでは、線を 1px の中心線まで細くしてから描き直す（太い線も細い線も同じ太さになる）
  //    その前に、線の中の小さな白いすき間を埋めておく（埋めないと小さな輪っかが残る）
  if (centerLine) {
    const holes = new Uint8Array(n);
    for (let i = 0; i < n; i++) holes[i] = mask[i] ? 0 : 1;
    const before = holes.slice();
    removeSmallComponents(holes, w, h, Math.round(Math.max(20, (lineRadius * 1.2) ** 2)));
    for (let i = 0; i < n; i++) if (before[i] && !holes[i]) mask[i] = 1;
    thin(mask, w, h);
    // 輪郭から生えた短いヒゲ（ノイズ由来の枝）を取る
    const spur = Math.round(clamp(lineRadius * 3, 8, 45));
    pruneSpurs(mask, w, h, spur);
    pruneSpurs(mask, w, h, spur);
  }

  // 6. 線を太らせる。距離変換を使うと丸いペンでなぞったような太り方になる
  const radius = centerLine ? centerRadiusFor(params.thickness, w, h) : radiusFor(params.thickness, w, h);
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

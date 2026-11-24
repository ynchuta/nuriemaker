// 線画の出来を数字で測るための道具。
// アプリ側の関数を変えても物差しが変わらないよう、アプリのコードは使わずにここに独自に持つ。

/** 各画素から、mask が 1 の画素までのおおよその距離（チャンファー 3-4） */
export function distanceTo(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : 1e9;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  return d;
}

/** Zhang-Suen 法で 1px の中心線にする（コピーを返す） */
export function skeleton(src: Uint8Array, w: number, h: number): Uint8Array {
  const m = src.slice();
  for (let x = 0; x < w; x++) m[x] = m[(h - 1) * w + x] = 0;
  for (let y = 0; y < h; y++) m[y * w] = m[y * w + w - 1] = 0;
  const del: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1];
          const p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a =
            (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
            (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
          if (a !== 1) continue;
          if (step === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(i);
        }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  return m;
}

/** RGBA の画像から「黒（線）」の画素を 1 にした配列を作る */
export function inkMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, channels = 4): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = rgba[i * channels] < 128 ? 1 : 0;
  return m;
}

export interface Metrics {
  /** 黒い画素の割合（%） */
  ink: number;
  /** 黒い塊の割合（印刷して幅 3mm を超える、塗りつぶしのようになった部分。黒い画素のうちの %） */
  blob: number;
  /** 正解の線のうち、見つかった割合（%）。グループごと */
  recall?: Record<string, number>;
  /** 線の中心のうち、正解の線から離れている（余計な線・二重線・ゴミ）割合（%） */
  noise?: number;
}

/**
 * @param ink 変換結果の黒画素
 * @param truth グループごとの正解の線（required のものだけ見つかり率を出す）と、あってもよい線をすべて合わせたもの
 */
export function measure(
  ink: Uint8Array,
  w: number,
  h: number,
  truth?: { required: Record<string, Uint8Array>; allowed: Uint8Array },
): Metrics {
  const n = w * h;
  const s = Math.max(w, h) / 1600;
  let inkCount = 0;
  for (let i = 0; i < n; i++) inkCount += ink[i];

  // 黒い塊: 太さが 18px（長辺 1600px のとき。A4 に印刷して約 3mm）を超える黒いところ。
  // 一番太い設定の線でもここまでは太くならないので、塗りつぶしのようになった部分だけが引っかかる
  const white = new Uint8Array(n);
  for (let i = 0; i < n; i++) white[i] = ink[i] ? 0 : 1;
  const toWhite = distanceTo(white, w, h);
  const blobCore = 9 * s;
  // 芯から塊の太さぶん広げた範囲を「塊」として数える
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = toWhite[i] > blobCore ? 1 : 0;
  const toCore = distanceTo(core, w, h);
  let blobCount = 0;
  for (let i = 0; i < n; i++) if (ink[i] && toCore[i] <= blobCore) blobCount++;

  const m: Metrics = {
    ink: (100 * inkCount) / n,
    blob: inkCount ? (100 * blobCount) / inkCount : 0,
  };
  if (!truth) return m;

  // 位置のずれの許容量（長辺 1600px で 8px ≒ A4 印刷で約 1.3mm）
  const tol = 8 * s;
  const toInk = distanceTo(ink, w, h);
  m.recall = {};
  for (const [label, gt] of Object.entries(truth.required)) {
    let total = 0, hit = 0;
    for (let i = 0; i < n; i++)
      if (gt[i]) {
        total++;
        if (toInk[i] <= tol) hit++;
      }
    m.recall[label] = total ? (100 * hit) / total : 100;
  }
  const skel = skeleton(ink, w, h);
  const toAllowed = distanceTo(truth.allowed, w, h);
  let sk = 0, off = 0;
  for (let i = 0; i < n; i++)
    if (skel[i]) {
      sk++;
      if (toAllowed[i] > tol) off++;
    }
  m.noise = sk ? (100 * off) / sk : 0;
  return m;
}

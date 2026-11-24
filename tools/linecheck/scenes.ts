// 線画チェック用の「お手本画像」。
//
// よしひろさんが実際に困った絵（太い輪郭線のキャラ、髪のツヤ、小さい顔がたくさん並んだ低解像度の絵、
// 陰影の多い絵）と同じ「つまずきポイント」を持つ絵を、SVG で描いています。
// 図形の形が分かっているので「本来あるべき線（正解の線）」も同時に作れ、
// 変換結果が正解の線にどれだけ近いかを数字で測れます。
//
// 実際のアニメ・ゲームの絵は著作権があるため、公開リポジトリには入れません。
// 手元で確かめたい実際の絵は test-images/private/ に置いてください（Git には入りません）。

/** 図形 1 つ分 */
export interface Shape {
  /** SVG の要素名（path / ellipse / circle / rect / polygon など） */
  tag: string;
  /** 形を決める属性（d, cx, cy, rx など） */
  attrs: Record<string, string | number>;
  /** 塗りの色（'none' で塗らない、'url(#id)' でグラデーション） */
  fill?: string;
  /** 輪郭線の色と太さ（元の絵の座標で） */
  stroke?: string;
  sw?: number;
  /**
   * 正解の線のグループ名。省略すると「線にしてはいけない」図形（陰影・ぼかしなど）。
   * グループは Scene.groups で「必ず残すべき線」か「あってもよい線」かを決める。
   */
  group?: string;
  /** 正解の線として使う形（省略時はこの図形の輪郭そのもの） */
  lineAttrs?: Record<string, string | number>;
  lineTag?: string;
  /** その他の SVG 属性（opacity, transform, filter など） */
  extra?: string;
}

export interface Scene {
  /** ファイル名に使う名前 */
  id: string;
  /** 日本語の説明 */
  title: string;
  /** 何を確かめる絵か */
  checks: string[];
  /** 元画像の大きさ（px）。小さくすると「低解像度の絵」になる */
  width: number;
  height: number;
  /** SVG の座標の大きさ */
  viewW: number;
  viewH: number;
  background: string;
  /** グラデーションなどの <defs> の中身 */
  defs?: string;
  shapes: Shape[];
  /** 正解の線のグループ。required: true は「消えたら困る線」 */
  groups: { id: string; label: string; required: boolean }[];
  /** JPEG で保存し直して、圧縮ノイズを足す（0〜100 の画質） */
  jpegQuality?: number;
}

const attrStr = (a: Record<string, string | number>) =>
  Object.entries(a)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');

/** 色付きの元画像の SVG */
export function sceneSvg(s: Scene, w = s.width, h = s.height): string {
  const body = s.shapes
    .map(
      (sh) =>
        `<${sh.tag} ${attrStr(sh.attrs)} fill="${sh.fill ?? 'none'}" stroke="${sh.stroke ?? 'none'}" stroke-width="${sh.sw ?? 0}" stroke-linejoin="round" stroke-linecap="round" ${sh.extra ?? ''}/>`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${s.viewW} ${s.viewH}">
<defs>${s.defs ?? ''}</defs>
<rect x="0" y="0" width="${s.viewW}" height="${s.viewH}" fill="${s.background}"/>
${body}
</svg>`;
}

/**
 * 正解の線（細い黒線）だけを描いた SVG。groupIds に入っているグループだけ描く。
 * 後ろに隠れた線が正解に入らないよう、図形を元の絵と同じ順に白で塗りながら描く。
 */
export function linesSvg(s: Scene, groupIds: string[], w: number, h: number): string {
  // 出来上がりの画像で 2px 前後の細い線になるようにする
  const sw = (2 * s.viewW) / w;
  const body = s.shapes
    .filter((sh) => sh.group)
    .map((sh) => {
      const tag = sh.lineTag ?? sh.tag;
      const a = sh.lineAttrs ?? sh.attrs;
      const transform = (sh.extra ?? '').match(/(transform|clip-path)="[^"]*"/g)?.join(' ') ?? '';
      // 不透明に塗られた図形だけが、後ろの線を隠す
      const opaque = sh.fill && sh.fill !== 'none' && !/opacity/.test(sh.extra ?? '');
      const stroke = groupIds.includes(sh.group!) ? '#000' : 'none';
      return `<${tag} ${attrStr(a)} fill="${opaque ? '#fff' : 'none'}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round" ${transform}/>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${s.viewW} ${s.viewH}">
<defs>${s.defs ?? ''}</defs>
<rect x="0" y="0" width="${s.viewW}" height="${s.viewH}" fill="#fff"/>
${body}
</svg>`;
}

// ---------------------------------------------------------------------------
// 1. 太い黒い輪郭線のキャラ（白抜き・二重線になりやすい）
// ---------------------------------------------------------------------------
function thickOutline(): Scene {
  const shapes: Shape[] = [];
  const O = 'outline';
  // 体
  shapes.push({ tag: 'path', attrs: { d: 'M380 900 C330 700 330 450 420 300 C470 220 560 220 600 300 C680 450 680 700 620 900 Z' }, fill: '#7d7f86', stroke: '#111', sw: 16, group: O });
  // 頭の赤い飾り
  shapes.push({ tag: 'ellipse', attrs: { cx: 505, cy: 230, rx: 70, ry: 45 }, fill: '#c9302c', stroke: '#111', sw: 14, group: O });
  // 黄色い円盤（重なりながら並ぶ）
  for (let i = 0; i < 6; i++) {
    const cy = 330 + i * 85;
    shapes.push({ tag: 'ellipse', attrs: { cx: 400, cy, rx: 62, ry: 40 }, fill: '#e8c21c', stroke: '#111', sw: 14, group: O });
    shapes.push({ tag: 'ellipse', attrs: { cx: 400, cy, rx: 36, ry: 20 }, fill: '#8f9198', stroke: '#111', sw: 8, group: O });
    shapes.push({ tag: 'ellipse', attrs: { cx: 610, cy: cy + 30, rx: 62, ry: 40 }, fill: '#e8c21c', stroke: '#111', sw: 14, group: O });
    shapes.push({ tag: 'ellipse', attrs: { cx: 610, cy: cy + 30, rx: 36, ry: 20 }, fill: '#8f9198', stroke: '#111', sw: 8, group: O });
  }
  // 白いトゲ
  shapes.push({ tag: 'polygon', attrs: { points: '300,520 160,470 230,560 140,600 300,590' }, fill: '#fff', stroke: '#111', sw: 12, group: O });
  shapes.push({ tag: 'polygon', attrs: { points: '700,520 840,470 770,560 860,600 700,590' }, fill: '#fff', stroke: '#111', sw: 12, group: O });
  // 足先の赤い丸
  shapes.push({ tag: 'circle', attrs: { cx: 430, cy: 900, r: 55 }, fill: '#e8c21c', stroke: '#111', sw: 16, group: O });
  shapes.push({ tag: 'circle', attrs: { cx: 430, cy: 900, r: 28 }, fill: '#c9302c', stroke: '#111', sw: 8, group: O });
  shapes.push({ tag: 'circle', attrs: { cx: 590, cy: 900, r: 55 }, fill: '#e8c21c', stroke: '#111', sw: 16, group: O });
  shapes.push({ tag: 'circle', attrs: { cx: 590, cy: 900, r: 28 }, fill: '#c9302c', stroke: '#111', sw: 8, group: O });
  // 体の暗い影（線にしてはいけない）
  shapes.push({ tag: 'path', attrs: { d: 'M560 320 C640 450 640 700 600 880 L560 880 C590 700 590 450 540 330 Z' }, fill: '#5b5d63' });
  return {
    id: 'thick-outline',
    title: '太い黒い輪郭線のキャラ（低解像度）',
    checks: ['太い輪郭線が二重線（白抜き）にならず 1 本の線になる', '体の暗い影が線にならない', '灰色の背景が線にならない'],
    width: 480,
    height: 470,
    viewW: 1000,
    viewH: 980,
    background: '#e4e4e4',
    shapes,
    groups: [{ id: O, label: '輪郭線', required: true }],
  };
}

// ---------------------------------------------------------------------------
// 2. 髪のツヤ＋眼鏡の顔（ツヤの間が黒い塊になりやすい）
// ---------------------------------------------------------------------------
function hairHighlight(): Scene {
  const shapes: Shape[] = [];
  // 黄色い背景の六角形もよう（うっすら。線にしてはいけない）
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 6; x++) {
      const cx = x * 190 + (y % 2) * 95;
      const cy = y * 165 + 60;
      const pts = Array.from({ length: 6 }, (_, k) => {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        return `${cx + 90 * Math.cos(a)},${cy + 90 * Math.sin(a)}`;
      }).join(' ');
      shapes.push({ tag: 'polygon', attrs: { points: pts }, fill: '#ffc400', stroke: '#ffd21f', sw: 6 });
    }
  // 首と服
  shapes.push({ tag: 'path', attrs: { d: 'M440 600 L560 600 L580 700 L420 700 Z' }, fill: '#fde3cf', stroke: '#2a1d1a', sw: 4, group: 'outline' });
  shapes.push({ tag: 'path', attrs: { d: 'M250 1000 C260 780 330 700 420 690 L580 690 C670 700 740 780 750 1000 Z' }, fill: '#eee8ff', stroke: '#2a1d1a', sw: 4, group: 'outline' });
  // ネクタイ
  shapes.push({ tag: 'path', attrs: { d: 'M480 700 L520 700 L540 900 L500 950 L460 900 Z' }, fill: '#b0185a', stroke: '#2a1d1a', sw: 4, group: 'outline' });
  // 顔
  shapes.push({ tag: 'path', attrs: { d: 'M360 380 C360 560 430 640 500 640 C570 640 640 560 640 380 Z' }, fill: '#fde3cf', stroke: '#2a1d1a', sw: 4, group: 'outline' });
  // 髪（暗い緑がかった黒）
  shapes.push({
    tag: 'path',
    attrs: { d: 'M320 470 C280 300 330 170 470 140 C520 100 560 110 590 150 C700 170 740 300 690 470 L650 400 L610 450 L590 360 L540 420 L520 340 L470 410 L440 340 L410 430 L370 380 Z' },
    fill: '#1d2b33',
    stroke: '#0b1013',
    sw: 4,
    group: 'outline',
  });
  // 髪のツヤ（細長い光が、すき間をあけずに帯のように並ぶ）。ふちはあってもよい線
  for (let k = 0; k < 11; k++) {
    const t = -0.8 + k * 0.16; // 頭のまわりの角度
    const cx = 505 + 175 * Math.sin(t);
    const cy = 310 - 120 * Math.cos(t);
    const ang = (t * 180) / Math.PI;
    shapes.push({
      tag: 'path',
      attrs: { d: `M${cx - 9} ${cy - 30} C${cx - 2} ${cy - 10} ${cx + 2} ${cy + 10} ${cx + 4} ${cy + 34} C${cx + 8} ${cy + 10} ${cx + 9} ${cy - 10} ${cx + 9} ${cy - 30} Z` },
      fill: k % 2 ? '#bfe6f5' : '#eefaff',
      group: 'highlight',
      extra: `transform="rotate(${ang.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})"`,
    });
  }
  // 髪の毛すじ（暗い髪の中の、さらに暗い細い線）。あってもよい線
  for (const d of ['M420 200 C440 260 445 320 430 380', 'M590 190 C575 250 570 310 585 370', 'M505 160 C510 230 505 290 495 340']) {
    shapes.push({ tag: 'path', attrs: { d }, stroke: '#05080a', sw: 3, group: 'strand' });
  }
  // 目（白目・瞳・まつげ）
  for (const cx of [440, 560]) {
    shapes.push({ tag: 'ellipse', attrs: { cx, cy: 470, rx: 34, ry: 22 }, fill: '#fff', stroke: '#2a1d1a', sw: 4, group: 'face' });
    shapes.push({ tag: 'circle', attrs: { cx, cy: 472, r: 15 }, fill: '#2e9b6a', stroke: '#13392a', sw: 3, group: 'face' });
    shapes.push({ tag: 'circle', attrs: { cx, cy: 472, r: 6 }, fill: '#0c1a14', group: 'face-detail' });
    shapes.push({ tag: 'path', attrs: { d: `M${cx - 40} 452 C${cx - 15} 438 ${cx + 15} 438 ${cx + 40} 452` }, stroke: '#111', sw: 7, group: 'face' });
    // 眼鏡
    shapes.push({ tag: 'rect', attrs: { x: cx - 52, y: 440, width: 104, height: 64, rx: 10 }, stroke: '#111', sw: 7, group: 'face' });
  }
  shapes.push({ tag: 'path', attrs: { d: 'M492 470 L508 470' }, stroke: '#111', sw: 7, group: 'face' });
  // 口
  shapes.push({ tag: 'path', attrs: { d: 'M480 575 C495 583 507 583 522 575' }, stroke: '#7a3b33', sw: 4, group: 'face' });
  // 頬のぼかし（線にしてはいけない）
  shapes.push({ tag: 'ellipse', attrs: { cx: 410, cy: 540, rx: 30, ry: 14 }, fill: '#f7b9b0', extra: 'opacity="0.6" filter="url(#blur)"' });
  shapes.push({ tag: 'ellipse', attrs: { cx: 590, cy: 540, rx: 30, ry: 14 }, fill: '#f7b9b0', extra: 'opacity="0.6" filter="url(#blur)"' });
  return {
    id: 'hair-highlight',
    title: '髪のツヤと眼鏡の顔',
    checks: ['髪のツヤとツヤの間が黒い塊にならない', '目・眼鏡・口が残る', '背景の六角形もようや頬のぼかしが線にならない'],
    width: 560,
    height: 560,
    viewW: 1000,
    viewH: 1000,
    background: '#ffcc00',
    defs: '<filter id="blur"><feGaussianBlur stdDeviation="8"/></filter>',
    shapes,
    groups: [
      { id: 'outline', label: '輪郭線', required: true },
      { id: 'face', label: '目・眼鏡・口', required: true },
      { id: 'highlight', label: '髪のツヤのふち', required: false },
      { id: 'strand', label: '髪の毛すじ', required: false },
      { id: 'face-detail', label: '瞳の中', required: false },
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. 赤い背景に小さい顔がたくさん並ぶ集合絵（低解像度・JPEG）
// ---------------------------------------------------------------------------
function smallFaces(): Scene {
  const shapes: Shape[] = [];
  // 赤い背景の六角形もよう（線にしてはいけない）
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 10; x++) {
      const cx = x * 150 + (y % 2) * 75;
      const cy = y * 130 + 40;
      const pts = Array.from({ length: 6 }, (_, k) => {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        return `${cx + 72 * Math.cos(a)},${cy + 72 * Math.sin(a)}`;
      }).join(' ');
      shapes.push({ tag: 'polygon', attrs: { points: pts }, fill: '#d0121c', stroke: '#e0202a', sw: 5 });
    }
  const skins = ['#fde3cf', '#d9a07a', '#f6d2b6', '#fff0e6', '#f3a7b6'];
  const hairs = ['#16323a', '#1a1a1a', '#e6b93a', '#e9eef2', '#f3a7b6'];
  const shirts = ['#3a2b2b', '#1c2340', '#f2c9a5', '#f4f4f4', '#5a2a3a'];
  for (let i = 0; i < 5; i++) {
    const cx = 130 + i * 260;
    const cy = 200;
    // 体
    shapes.push({ tag: 'path', attrs: { d: `M${cx - 110} 520 C${cx - 100} 330 ${cx - 60} 300 ${cx} 300 C${cx + 60} 300 ${cx + 100} 330 ${cx + 110} 520 Z` }, fill: shirts[i], stroke: '#1a0c0c', sw: 3, group: 'outline' });
    // 顔
    shapes.push({ tag: 'ellipse', attrs: { cx, cy, rx: 62, ry: 76 }, fill: skins[i], stroke: '#3a1e14', sw: 3, group: 'outline' });
    // 髪
    shapes.push({
      tag: 'path',
      attrs: { d: `M${cx - 72} ${cy + 10} C${cx - 80} ${cy - 90} ${cx + 80} ${cy - 110} ${cx + 72} ${cy + 10} L${cx + 50} ${cy - 30} L${cx + 20} ${cy - 15} L${cx} ${cy - 40} L${cx - 25} ${cy - 15} L${cx - 50} ${cy - 30} Z` },
      fill: hairs[i],
      stroke: '#1a0c0c',
      sw: 3,
      group: 'outline',
    });
    // 小さい目（アニメ塗り: 上まつげの太い線と、色の付いた瞳だけ）と、うすい口
    for (const dx of [-24, 24]) {
      shapes.push({ tag: 'ellipse', attrs: { cx: cx + dx, cy: cy + 14, rx: 8, ry: 9 }, fill: ['#2e9b6a', '#4a2a1a', '#6b4a1a', '#5a6ad0', '#3a2a2a'][i], group: 'face' });
      shapes.push({ tag: 'path', attrs: { d: `M${cx + dx - 13} ${cy + 8} C${cx + dx - 5} ${cy + 1} ${cx + dx + 5} ${cy + 1} ${cx + dx + 13} ${cy + 6}` }, stroke: '#1a0c08', sw: 4, group: 'face' });
    }
    shapes.push({ tag: 'path', attrs: { d: `M${cx - 8} ${cy + 47} C${cx - 3} ${cy + 50} ${cx + 3} ${cy + 50} ${cx + 8} ${cy + 47}` }, stroke: '#b06a5a', sw: 2.5, group: 'face' });
    // 顔の影（線にしてはいけない）
    shapes.push({ tag: 'path', attrs: { d: `M${cx + 20} ${cy - 60} C${cx + 60} ${cy - 30} ${cx + 62} ${cy + 30} ${cx + 30} ${cy + 70} C${cx + 50} ${cy + 20} ${cx + 45} ${cy - 30} ${cx + 20} ${cy - 60} Z` }, fill: '#000', extra: 'opacity="0.12"' });
  }
  return {
    id: 'small-faces',
    title: '赤い背景の集合絵（小さい顔・低解像度・JPEG）',
    checks: ['小さい顔の目と口が残る', '赤い背景のもようがゴミにならない', '顔の影が線にならない'],
    width: 640,
    height: 260,
    viewW: 1300,
    viewH: 528,
    background: '#d0121c',
    shapes,
    groups: [
      { id: 'outline', label: '輪郭線', required: true },
      { id: 'face', label: '目・口', required: true },
    ],
    jpegQuality: 70,
  };
}

// ---------------------------------------------------------------------------
// 4. 陰影の多い絵（グラデーション・アニメ塗りの影・腹筋のような影）
// ---------------------------------------------------------------------------
function shading(): Scene {
  const shapes: Shape[] = [];
  // 胴体（輪郭線あり、グラデーション塗り）
  shapes.push({ tag: 'path', attrs: { d: 'M300 950 C280 700 260 450 330 300 C380 220 620 220 670 300 C740 450 720 700 700 950 Z' }, fill: 'url(#skin)', stroke: '#5a2e1e', sw: 5, group: 'outline' });
  // 腕
  shapes.push({ tag: 'path', attrs: { d: 'M330 320 C230 380 170 520 180 700 L240 700 C240 560 280 450 350 400 Z' }, fill: 'url(#skin)', stroke: '#5a2e1e', sw: 5, group: 'outline' });
  shapes.push({ tag: 'path', attrs: { d: 'M670 320 C770 380 830 520 820 700 L760 700 C760 560 720 450 650 400 Z' }, fill: 'url(#skin)', stroke: '#5a2e1e', sw: 5, group: 'outline' });
  // アニメ塗りの影（はっきりした境目。ふちは線になってもよい）
  shapes.push({ tag: 'path', attrs: { d: 'M600 280 C690 380 700 650 690 940 L640 940 C660 650 640 420 560 300 Z' }, fill: '#c98a68', extra: 'opacity="0.8" clip-path="url(#body)"', group: 'cel' });
  // 肌のざらつき（写真やブラシ塗りのような細かいムラ。線にしてはいけない）
  shapes.push({ tag: 'rect', attrs: { x: 150, y: 200, width: 700, height: 760 }, fill: '#7a4a30', extra: 'filter="url(#grain)" opacity="0.35" clip-path="url(#body)"' });
  // 腹筋のような、ぼんやりした影のかたまり（線にしてはいけない）
  for (let r = 0; r < 3; r++)
    for (const dx of [-60, 60]) {
      shapes.push({ tag: 'ellipse', attrs: { cx: 500 + dx, cy: 560 + r * 110, rx: 45, ry: 38 }, fill: '#8f4f2f', extra: 'opacity="0.55" filter="url(#soft)"' });
    }
  // 胸の影（ぼんやり）
  shapes.push({ tag: 'path', attrs: { d: 'M360 430 C420 470 480 470 495 440 C480 500 400 500 360 470 Z' }, fill: '#a8643f', extra: 'opacity="0.4" filter="url(#soft)"' });
  shapes.push({ tag: 'path', attrs: { d: 'M640 430 C580 470 520 470 505 440 C520 500 600 500 640 470 Z' }, fill: '#a8643f', extra: 'opacity="0.4" filter="url(#soft)"' });
  // ベルト（線あり）
  shapes.push({ tag: 'rect', attrs: { x: 300, y: 860, width: 400, height: 60, rx: 6 }, fill: '#8b2b1e', stroke: '#2b0e08', sw: 5, group: 'outline' });
  shapes.push({ tag: 'rect', attrs: { x: 470, y: 865, width: 60, height: 50, rx: 4 }, fill: '#e2b23a', stroke: '#2b0e08', sw: 4, group: 'outline' });
  return {
    id: 'shading',
    title: '陰影の多い絵（グラデーション・ぼんやりした影）',
    checks: ['ぼんやりした影や肌のムラがガサガサの線にならない', '輪郭線とベルトが残る', 'グラデーションが線にならない'],
    width: 600,
    height: 600,
    viewW: 1000,
    viewH: 1000,
    background: '#ffffff',
    defs:
      '<linearGradient id="skin" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#f6d2b6"/><stop offset="0.6" stop-color="#eebc98"/><stop offset="1" stop-color="#d89a76"/></linearGradient>' +
      '<filter id="soft"><feGaussianBlur stdDeviation="14"/></filter>' +
      '<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="3" seed="3"/><feColorMatrix type="matrix" values="0 0 0 0 0.48  0 0 0 0 0.29  0 0 0 0 0.19  0 0 0 1.6 -0.75"/></filter>' +
      '<clipPath id="body"><path d="M300 950 C280 700 260 450 330 300 C380 220 620 220 670 300 C740 450 720 700 700 950 Z"/></clipPath>',
    shapes,
    groups: [
      { id: 'outline', label: '輪郭線', required: true },
      { id: 'cel', label: 'アニメ塗りの影のふち', required: false },
    ],
    jpegQuality: 80,
  };
}

export const SCENES: Scene[] = [thickOutline(), hairHighlight(), smallFaces(), shading()];

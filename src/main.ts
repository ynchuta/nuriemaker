import './style.css';
import { PRESETS, type LineArtParams } from './lineart';
import type { WorkerRequest, WorkerResponse } from './worker';

/** 線画化するときの長辺の大きさ（px）。A4 に印刷して約 150dpi */
const WORK_SIZE = 1600;
/** 小さい画像を拡大する上限倍率 */
const MAX_UPSCALE = 4;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const startSection = $<HTMLElement>('start');
const editorSection = $<HTMLElement>('editor');
const cropSection = $<HTMLElement>('crop');
const pasteBox = $<HTMLDivElement>('paste-box');
const fileInput = $<HTMLInputElement>('file-input');
const clipboardBtn = $<HTMLButtonElement>('clipboard-btn');
const startMessage = $<HTMLParagraphElement>('start-message');
const editorMessage = $<HTMLParagraphElement>('editor-message');
const sheet = $<HTMLDivElement>('sheet');
const resultCanvas = $<HTMLCanvasElement>('result-canvas');
const originalCanvas = $<HTMLCanvasElement>('original-canvas');
const busy = $<HTMLDivElement>('busy');
const busyText = busy.querySelector<HTMLSpanElement>('.busy-text')!;
const compareBtn = $<HTMLButtonElement>('compare-btn');
const thicknessInput = $<HTMLInputElement>('thickness');
const detailInput = $<HTMLInputElement>('detail');
const thicknessOut = $<HTMLOutputElement>('thickness-out');
const detailOut = $<HTMLOutputElement>('detail-out');
const centerLineInput = $<HTMLInputElement>('center-line');
const printBtn = $<HTMLButtonElement>('print-btn');
const saveBtn = $<HTMLButtonElement>('save-btn');
const cropBtn = $<HTMLButtonElement>('crop-btn');
const resetBtn = $<HTMLButtonElement>('reset-btn');
const cropCanvas = $<HTMLCanvasElement>('crop-canvas');
const cropApply = $<HTMLButtonElement>('crop-apply');
const cropFull = $<HTMLButtonElement>('crop-full');
const cropCancel = $<HTMLButtonElement>('crop-cancel');
const printImg = $<HTMLImageElement>('print-img');

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let source: ImageBitmap | HTMLImageElement | null = null;
let sourceW = 0;
let sourceH = 0;
let crop: Rect | null = null;

// ---------------------------------------------------------------------------
// Worker とのやりとり（最新のリクエストだけを処理する）
// ---------------------------------------------------------------------------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let requestId = 0;
let loadedId = -1; // Worker に読み込ませた画像の id
let renderInFlight = false;
let renderPending = false;
let pendingLoadId = -1;

function currentParams(): LineArtParams {
  return {
    thickness: Number(thicknessInput.value),
    detail: Number(detailInput.value),
    centerLine: centerLineInput.checked,
  };
}

function send(msg: WorkerRequest, transfer: Transferable[] = []) {
  worker.postMessage(msg, transfer);
}

function requestRender() {
  if (loadedId < 0 || pendingLoadId >= 0) {
    renderPending = true;
    return;
  }
  if (renderInFlight) {
    renderPending = true;
    return;
  }
  renderInFlight = true;
  renderPending = false;
  showBusy(lastResult !== null);
  send({ type: 'render', id: loadedId, params: currentParams() });
}

/**
 * 処理中の表示。
 * すでに線画があるとき（スライダーを動かしている最中など）は、絵を隠さないよう
 * 角に小さく「なおしています」とだけ出す。
 */
function showBusy(soft: boolean) {
  busy.classList.toggle('soft', soft);
  busyText.textContent = soft ? 'なおしています…' : '線画にしています…';
  busy.hidden = false;
}

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  if (msg.type === 'loaded') {
    if (msg.id !== pendingLoadId) return; // 古い画像
    loadedId = msg.id;
    pendingLoadId = -1;
    renderInFlight = false;
    requestRender();
  } else if (msg.type === 'rendered') {
    renderInFlight = false;
    if (msg.id === loadedId) {
      drawResult(msg.width, msg.height, msg.pixels);
    }
    if (renderPending || pendingLoadId >= 0) {
      if (pendingLoadId < 0) requestRender();
    } else {
      busy.hidden = true;
    }
  } else if (msg.type === 'error') {
    renderInFlight = false;
    busy.hidden = true;
    editorMessage.textContent = `うまく処理できませんでした（${msg.message}）`;
  }
};

worker.onerror = () => {
  busy.hidden = true;
  editorMessage.textContent = 'このブラウザでは処理できませんでした。別のブラウザでお試しください。';
};

// 線画の元データ（白黒）。線の色を変えるときは、これに色を付け直すだけで済む
let lastResult: { w: number; h: number; pixels: Uint8ClampedArray } | null = null;

function drawResult(w: number, h: number, pixels: ArrayBuffer) {
  lastResult = { w, h, pixels: new Uint8ClampedArray(pixels) };
  paintResult();
  editorMessage.textContent = '';
}

/** 白黒の線画に、選んだ線の色を付けてキャンバスに描く */
function paintResult() {
  if (!lastResult) return;
  const { w, h, pixels } = lastResult;
  const [cr, cg, cbl] = lineColor;
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const ink = 1 - pixels[i] / 255; // 0 = 白、1 = 線
    out[i] = 255 - (255 - cr) * ink;
    out[i + 1] = 255 - (255 - cg) * ink;
    out[i + 2] = 255 - (255 - cbl) * ink;
    out[i + 3] = 255;
  }
  resultCanvas.width = w;
  resultCanvas.height = h;
  resultCanvas.getContext('2d')!.putImageData(new ImageData(out, w, h), 0, 0);
  if (!zoomOverlay.hidden) refreshZoomImage();
}

// ---------------------------------------------------------------------------
// 線の色
// ---------------------------------------------------------------------------
let lineColor: [number, number, number] = [0, 0, 0];
document.querySelectorAll<HTMLButtonElement>('[data-line-color]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const hex = btn.dataset.lineColor!;
    lineColor = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number];
    document.querySelectorAll('[data-line-color]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    paintResult();
  });
});

// ---------------------------------------------------------------------------
// 拡大して確認
// ---------------------------------------------------------------------------
const zoomOverlay = $<HTMLDivElement>('zoom');
const zoomScroller = $<HTMLDivElement>('zoom-scroller');
const zoomImg = $<HTMLImageElement>('zoom-img');
const zoomLevelOut = $<HTMLSpanElement>('zoom-level');
const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6];
let zoomIndex = 2;

function refreshZoomImage() {
  zoomImg.src = resultCanvas.toDataURL('image/png');
}

function applyZoom(keepCenter = true) {
  const scroller = zoomScroller;
  // 拡大の前後で、見ている場所の中心がずれないようにする
  const cx = (scroller.scrollLeft + scroller.clientWidth / 2) / Math.max(1, scroller.scrollWidth);
  const cy = (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(1, scroller.scrollHeight);
  const z = ZOOM_STEPS[zoomIndex];
  // 「1倍」= 画面の幅にちょうど収まる大きさ
  const fitW = scroller.clientWidth - 16;
  const fitH = scroller.clientHeight - 16;
  const fit = Math.min(fitW / resultCanvas.width, fitH / resultCanvas.height);
  zoomImg.style.width = `${Math.round(resultCanvas.width * fit * z)}px`;
  zoomLevelOut.textContent = `${z}ばい`;
  if (keepCenter) {
    scroller.scrollLeft = cx * scroller.scrollWidth - scroller.clientWidth / 2;
    scroller.scrollTop = cy * scroller.scrollHeight - scroller.clientHeight / 2;
  }
}

$<HTMLButtonElement>('zoom-btn').addEventListener('click', () => {
  refreshZoomImage();
  zoomOverlay.hidden = false;
  document.body.classList.add('no-scroll');
  zoomIndex = 2;
  applyZoom(false);
  // 真ん中あたりから見せる
  zoomScroller.scrollLeft = (zoomScroller.scrollWidth - zoomScroller.clientWidth) / 2;
  zoomScroller.scrollTop = (zoomScroller.scrollHeight - zoomScroller.clientHeight) / 2;
});
$<HTMLButtonElement>('zoom-in').addEventListener('click', () => {
  zoomIndex = Math.min(ZOOM_STEPS.length - 1, zoomIndex + 1);
  applyZoom();
});
$<HTMLButtonElement>('zoom-out').addEventListener('click', () => {
  zoomIndex = Math.max(0, zoomIndex - 1);
  applyZoom();
});
$<HTMLButtonElement>('zoom-close').addEventListener('click', () => {
  zoomOverlay.hidden = true;
  document.body.classList.remove('no-scroll');
});

// 指やマウスでつかんで動かす
let pan: { x: number; y: number; left: number; top: number; id: number } | null = null;
zoomScroller.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return; // スマホは標準のスクロールに任せる
  pan = { x: e.clientX, y: e.clientY, left: zoomScroller.scrollLeft, top: zoomScroller.scrollTop, id: e.pointerId };
  zoomScroller.setPointerCapture(e.pointerId);
});
zoomScroller.addEventListener('pointermove', (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  zoomScroller.scrollLeft = pan.left - (e.clientX - pan.x);
  zoomScroller.scrollTop = pan.top - (e.clientY - pan.y);
});
const endPan = () => {
  pan = null;
};
zoomScroller.addEventListener('pointerup', endPan);
zoomScroller.addEventListener('pointercancel', endPan);
window.addEventListener('resize', () => {
  if (!zoomOverlay.hidden) applyZoom();
});

// ---------------------------------------------------------------------------
// 画像の読み込み
// ---------------------------------------------------------------------------
async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  // <img> で読むと、スマホ写真の向き（EXIF）が正しく反映される
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    // 一部ブラウザは createImageBitmap の方が読める形式が多い
    return await createImageBitmap(blob);
  } finally {
    // decode 後は描画に URL が不要
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function loadBlob(blob: Blob) {
  startMessage.textContent = '';
  if (!blob.type.startsWith('image/') && blob.type !== '') {
    startMessage.textContent = '画像ファイルを選んでください。';
    return;
  }
  try {
    const img = await decodeImage(blob);
    const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
    const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
    if (!w || !h) throw new Error('empty');
    source = img;
    sourceW = w;
    sourceH = h;
    crop = null;
    showEditor();
    prepareAndSend();
  } catch {
    startMessage.textContent =
      'この画像は読み込めませんでした。スクショを撮って貼り付けるか、JPEG・PNG の画像でお試しください。';
  }
}

/** 切り抜き範囲を作業サイズに合わせて描き、Worker に送る */
function prepareAndSend() {
  if (!source) return;
  const r = crop ?? { x: 0, y: 0, w: sourceW, h: sourceH };
  const scale = Math.min(WORK_SIZE / Math.max(r.w, r.h), MAX_UPSCALE);
  const w = Math.max(1, Math.round(r.w * scale));
  const h = Math.max(1, Math.round(r.h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);

  // 比較用の元画像
  originalCanvas.width = w;
  originalCanvas.height = h;
  originalCanvas.getContext('2d')!.drawImage(canvas, 0, 0);

  // 用紙の向きをプレビューに反映
  const landscape = w > h;
  sheet.classList.toggle('landscape', landscape);
  sheet.classList.toggle('portrait', !landscape);

  // 前の結果は消しておく
  resultCanvas.width = w;
  resultCanvas.height = h;
  const rctx = resultCanvas.getContext('2d')!;
  rctx.fillStyle = '#fff';
  rctx.fillRect(0, 0, w, h);

  const id = ++requestId;
  pendingLoadId = id;
  loadedId = -1;
  lastResult = null; // 前の画像の線画で色の塗り直しをしないように
  showBusy(false);
  send({ type: 'load', id, width: w, height: h, pixels: data.data.buffer as ArrayBuffer, sourceScale: scale }, [
    data.data.buffer as ArrayBuffer,
  ]);
}

function imageFromClipboardData(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith('image/')) return file;
  }
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

// 画面のどこで貼り付けても受け取る
document.addEventListener('paste', (e) => {
  const file = imageFromClipboardData(e.clipboardData);
  e.preventDefault();
  pasteBox.innerHTML = '';
  if (file) {
    void loadBlob(file);
    return;
  }
  const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
  const msg = /^https?:\/\//.test(text)
    ? 'URL からの読み込みは今後対応予定です。画像を長押し（PCは右クリック）して「コピー」してから貼り付けてください。'
    : 'コピーされているのが画像ではないようです。画像をコピーするか、スクショを撮ってから貼り付けてください。';
  (editorSection.hidden ? startMessage : editorMessage).textContent = msg;
});

// 貼り付け欄に文字などが入ってしまったら消す
pasteBox.addEventListener('input', () => {
  const img = pasteBox.querySelector('img');
  if (img && img.src.startsWith('data:')) {
    // 一部ブラウザは paste イベントでファイルを渡さず <img> を直接挿入する
    void fetch(img.src)
      .then((r) => r.blob())
      .then(loadBlob);
  }
  pasteBox.innerHTML = '';
});

// クリップボード API で読み取るボタン（対応ブラウザのみ表示）
if (navigator.clipboard && 'read' in navigator.clipboard) {
  clipboardBtn.hidden = false;
  clipboardBtn.addEventListener('click', async () => {
    startMessage.textContent = '';
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          await loadBlob(await item.getType(type));
          return;
        }
      }
      startMessage.textContent = 'コピーされている画像が見つかりませんでした。';
    } catch {
      startMessage.textContent = '貼り付けが許可されませんでした。上の枠を長押しして「ペースト」をお試しください。';
    }
  });
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadBlob(file);
  fileInput.value = '';
});

// ドラッグ＆ドロップ
document.addEventListener('dragover', (e) => {
  e.preventDefault();
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = imageFromClipboardData(e.dataTransfer);
  if (file) void loadBlob(file);
});

// ---------------------------------------------------------------------------
// 調整
// ---------------------------------------------------------------------------
function updateOutputs() {
  thicknessOut.textContent = thicknessInput.value;
  detailOut.textContent = detailInput.value;
  const p = currentParams();
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
    const preset = PRESETS[btn.dataset.preset!];
    btn.classList.toggle('active', preset.thickness === p.thickness && preset.detail === p.detail);
  });
}

centerLineInput.addEventListener('change', requestRender);

for (const input of [thicknessInput, detailInput]) {
  input.addEventListener('input', () => {
    updateOutputs();
    requestRender();
  });
}

document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset!];
    thicknessInput.value = String(preset.thickness);
    detailInput.value = String(preset.detail);
    updateOutputs();
    requestRender();
  });
});

// 押している間だけ元の絵を見せる
const showOriginal = (on: boolean) => {
  originalCanvas.hidden = !on;
};
compareBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  showOriginal(true);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
  compareBtn.addEventListener(ev, () => showOriginal(false));
}
compareBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// 印刷・保存
// ---------------------------------------------------------------------------
let pageStyle: HTMLStyleElement | null = null;

function setPrintOrientation(landscape: boolean) {
  pageStyle?.remove();
  pageStyle = document.createElement('style');
  // A4 = 210×297mm、余白 10mm。ブラウザによっては少し余白が増えるので控えめに
  const [maxW, maxH] = landscape ? [272, 185] : [185, 272];
  pageStyle.textContent = `
    @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 10mm; }
    @media print { #print-img { max-width: ${maxW}mm; max-height: ${maxH}mm; } }
  `;
  document.head.appendChild(pageStyle);
}

printBtn.addEventListener('click', () => {
  if (!busy.hidden) {
    editorMessage.textContent = '線画ができるまで少しお待ちください。';
    return;
  }
  setPrintOrientation(resultCanvas.width > resultCanvas.height);
  printImg.onload = () => {
    printImg.onload = null;
    // 画像の描画を待ってから印刷画面を開く
    requestAnimationFrame(() => setTimeout(() => window.print(), 50));
  };
  printImg.src = resultCanvas.toDataURL('image/png');
});

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

saveBtn.addEventListener('click', async () => {
  const blob = await canvasToBlob(resultCanvas);
  const name = `nurie-${new Date().toISOString().slice(0, 10)}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  // スマホは共有シートから「画像を保存」できる方が分かりやすい
  const isTouch = matchMedia('(pointer: coarse)').matches;
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ---------------------------------------------------------------------------
// 画面の切り替え
// ---------------------------------------------------------------------------
function showEditor() {
  document.body.classList.add('editing');
  startSection.hidden = true;
  cropSection.hidden = true;
  editorSection.hidden = false;
  editorMessage.textContent = '';
  window.scrollTo({ top: 0 });
}

resetBtn.addEventListener('click', () => {
  source = null;
  crop = null;
  document.body.classList.remove('editing');
  editorSection.hidden = true;
  cropSection.hidden = true;
  startSection.hidden = false;
  startMessage.textContent = '';
  window.scrollTo({ top: 0 });
});

// ---------------------------------------------------------------------------
// 切り抜き
// ---------------------------------------------------------------------------
let cropDraft: Rect | null = null;
let cropScale = 1; // 表示用キャンバス px → 元画像 px
let dragStart: { x: number; y: number } | null = null;

function openCrop() {
  if (!source) return;
  const maxSide = 1200;
  cropScale = Math.max(1, Math.max(sourceW, sourceH) / maxSide);
  cropCanvas.width = Math.round(sourceW / cropScale);
  cropCanvas.height = Math.round(sourceH / cropScale);
  cropDraft = crop ? { ...crop } : null;
  document.body.classList.remove('editing');
  editorSection.hidden = true;
  cropSection.hidden = false;
  drawCrop();
  window.scrollTo({ top: 0 });
}

function drawCrop() {
  if (!source) return;
  const ctx = cropCanvas.getContext('2d')!;
  const W = cropCanvas.width;
  const H = cropCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(source, 0, 0, W, H);
  if (!cropDraft) return;
  const r = {
    x: cropDraft.x / cropScale,
    y: cropDraft.y / cropScale,
    w: cropDraft.w / cropScale,
    h: cropDraft.h / cropScale,
  };
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, W, r.y);
  ctx.fillRect(0, r.y + r.h, W, H - r.y - r.h);
  ctx.fillRect(0, r.y, r.x, r.h);
  ctx.fillRect(r.x + r.w, r.y, W - r.x - r.w, r.h);
  const lw = Math.max(2, W / 300);
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#ff8a3d';
  ctx.setLineDash([lw * 4, lw * 2]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
}

function toSourceCoords(e: PointerEvent) {
  const rect = cropCanvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * sourceW;
  const y = ((e.clientY - rect.top) / rect.height) * sourceH;
  return { x: Math.min(Math.max(x, 0), sourceW), y: Math.min(Math.max(y, 0), sourceH) };
}

cropCanvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  cropCanvas.setPointerCapture(e.pointerId);
  dragStart = toSourceCoords(e);
  cropDraft = null;
  drawCrop();
});
cropCanvas.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const p = toSourceCoords(e);
  cropDraft = {
    x: Math.min(dragStart.x, p.x),
    y: Math.min(dragStart.y, p.y),
    w: Math.abs(p.x - dragStart.x),
    h: Math.abs(p.y - dragStart.y),
  };
  drawCrop();
});
const endDrag = () => {
  dragStart = null;
  // 小さすぎる範囲（タップしただけなど）は無視
  const minSide = Math.max(sourceW, sourceH) * 0.03;
  if (cropDraft && (cropDraft.w < minSide || cropDraft.h < minSide)) {
    cropDraft = null;
    drawCrop();
  }
};
cropCanvas.addEventListener('pointerup', endDrag);
cropCanvas.addEventListener('pointercancel', endDrag);

cropApply.addEventListener('click', () => {
  crop = cropDraft
    ? {
        x: Math.round(cropDraft.x),
        y: Math.round(cropDraft.y),
        w: Math.round(cropDraft.w),
        h: Math.round(cropDraft.h),
      }
    : null;
  showEditor();
  prepareAndSend();
});
cropFull.addEventListener('click', () => {
  cropDraft = null;
  drawCrop();
});
cropCancel.addEventListener('click', () => {
  showEditor();
});
cropBtn.addEventListener('click', openCrop);

updateOutputs();

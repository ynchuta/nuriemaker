// 画面が固まらないよう、線画化は Web Worker で行う
import { computeEdgeMaps, renderLineArt, type EdgeMaps, type LineArtParams } from './lineart';

export type WorkerRequest =
  | { type: 'load'; id: number; width: number; height: number; pixels: ArrayBuffer; sourceScale: number }
  | { type: 'render'; id: number; params: LineArtParams };

export type WorkerResponse =
  | { type: 'loaded'; id: number }
  | { type: 'rendered'; id: number; width: number; height: number; pixels: ArrayBuffer }
  | { type: 'error'; id: number; message: string };

let maps: EdgeMaps | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      maps = computeEdgeMaps(new Uint8ClampedArray(msg.pixels), msg.width, msg.height, msg.sourceScale);
      post({ type: 'loaded', id: msg.id });
    } else if (msg.type === 'render') {
      if (!maps) throw new Error('画像がまだ読み込まれていません');
      const out = renderLineArt(maps, msg.params);
      post(
        { type: 'rendered', id: msg.id, width: maps.width, height: maps.height, pixels: out.buffer as ArrayBuffer },
        [out.buffer as ArrayBuffer],
      );
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};

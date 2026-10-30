// Copied from Better Arrow Vortex (src/analysis/syncWorker.ts).
// Computes the sharp onset curve of the whole song off the main thread (for the sync map).

import { sharpOnsets } from './sharpOnsets';

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  try {
    const curve = sharpOnsets(e.data.samples, e.data.sampleRate);
    self.postMessage({ curve }, { transfer: [curve.env.buffer] });
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};

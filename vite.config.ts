import { defineConfig } from 'vite';

// base: './' にしておくと GitHub Pages のサブパス (/nuriemaker/) でもそのまま動く
export default defineConfig({
  base: './',
  worker: { format: 'es' },
});

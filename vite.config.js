import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';
import { cp } from 'fs/promises';

/**
 * copyAssetsPlugin — build 完成後把 public/assets/ 複製到 dist/assets/
 * 讓 chrome.runtime.getURL('assets/...') 在 dist 版本中可以正確讀到素材
 */
function copyAssetsPlugin() {
    return {
        name: 'copy-assets',
        async closeBundle() {
            const src = resolve(__dirname, 'public/assets');
            const dest = resolve(__dirname, 'dist-v3/assets');
            try {
                await cp(src, dest, { recursive: true, force: true });
                console.log('[copy-assets] ✅ public/assets → dist-v3/assets 複製完成');
            } catch (e) {
                console.warn('[copy-assets] ⚠️ 複製失敗:', e.message);
            }
        }
    };
}

export default defineConfig({
  plugins: [crx({ manifest }), copyAssetsPlugin()],
  build: {
    outDir: 'dist-v3',
    // 確保輸出的 JS 檔案不會太分散，利於 Chrome 載入
    rollupOptions: {
      input: {
        reader: 'src/reader/result.html',
        mobile: 'src/mobile/index.html'
      },
      output: {
        manualChunks: undefined,
      },
    },
  },
});

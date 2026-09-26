import { normalizeChapterUrl } from '../utils/chapter-parser.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Jestful injects its reader pages after the initial HTML response. Read them in
// a temporary tab belonging to the source window so incognito stays incognito.
export async function crawlJestfulChapterInTab(chromeApi, chapterUrl, sourceTabId, ensureInjected, pause = wait) {
    const source = await chromeApi.tabs.get(sourceTabId);
    if (!source?.windowId) throw new Error('找不到來源視窗');
    const target = normalizeChapterUrl(chapterUrl, chapterUrl);
    let preview;
    try {
        preview = await chromeApi.tabs.create({ url: chapterUrl, active: false, windowId: source.windowId });
        if (!preview?.id) throw new Error('無法開啟下一話預覽分頁');
        let lastSignature = '';
        let stable = 0;
        for (let attempt = 0; attempt < 20; attempt++) {
            await pause(500);
            const tab = await chromeApi.tabs.get(preview.id);
            if (tab.incognito !== source.incognito) throw new Error('預覽分頁的私密模式不符');
            const actual = normalizeChapterUrl(tab.url || tab.pendingUrl, chapterUrl);
            if (actual && actual !== target) throw new Error('下一話預覽被轉向其他頁面');
            if (tab.status !== 'complete') continue;
            if (!await ensureInjected(preview.id)) continue;
            const result = await chromeApi.tabs.sendMessage(preview.id, { action: 'crawlImages' });
            const images = result?.images?.map(item => item?.src || item).filter(Boolean) || [];
            if (result?.error || images.length < 2) continue;
            const signature = images.join('\n');
            stable = signature === lastSignature ? stable + 1 : 0;
            lastSignature = signature;
            if (attempt >= 5 && stable >= 2) {
                const after = await chromeApi.tabs.get(preview.id);
                if (normalizeChapterUrl(after.url, chapterUrl) !== target) throw new Error('下一話預覽已離開原章節');
                return { images, navLinks: result.navLinks || { prev: null, next: null } };
            }
        }
        throw new Error('下一話圖片未完整載入');
    } finally {
        if (preview?.id) await chromeApi.tabs.remove(preview.id).catch(() => {});
    }
}

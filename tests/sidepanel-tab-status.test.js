import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/sidepanel/main.js', import.meta.url), 'utf8');
const start = source.indexOf('let tabStateRequestId = 0;');
const end = source.indexOf('// 監聽瀏覽器分頁切換', start);
if (start < 0 || end < 0) throw new Error('Tab status sync boundary missing');

describe('sidepanel active-tab translation state', () => {
    it('does not show tab A translating after switching to idle tab B', async () => {
        let activeId = 1;
        const replies = new Map();
        const elements = new Map(['mt-stop-btn', 'mt-start-btn', 'mt-pause-btn'].map(id =>
            [id, { style: {}, classList: { remove: vi.fn() }, textContent: '' }]));
        const chrome = {
            tabs: { query: (_query, callback) => {
                const tab = { id: activeId, url: activeId >= 3
                    ? `chrome-extension://test/src/${activeId === 3 ? 'reader/result.html' : 'options/index.html'}`
                    : `https://manga.test/${activeId}` };
                return callback ? callback([tab]) : Promise.resolve([tab]);
            } },
            runtime: { sendMessage: (request, callback) => replies.set(request.payload.tabId, callback), lastError: null }
        };
        const show = vi.fn();
        const hide = vi.fn();
        const sync = new Function('chrome', 'document', 'refreshGlossaryStatus', 'showTranslatingCard',
            'hideTranslatingCard', source.slice(start, end) + '\nreturn syncCurrentTabState;')(
            chrome, { getElementById: id => elements.get(id) }, vi.fn(), show, hide);
        await sync();
        activeId = 2;
        await sync();
        replies.get(2)({ isTranslating: false });
        replies.get(1)({ isTranslating: true, jobInfo: { imgCount: 10 } });
        expect(show).not.toHaveBeenCalled();
        expect(hide).toHaveBeenCalledOnce();
        expect(elements.get('mt-start-btn').style.display).toBe('flex');
        expect(elements.get('mt-stop-btn').style.display).toBe('none');

        activeId = 3;
        await sync();
        replies.get(3)({ isTranslating: true, jobInfo: { imgCount: 5 } });
        expect(show).toHaveBeenCalledWith(5);
        activeId = 4;
        await sync();
        replies.get(4)({ isTranslating: false });
        expect(elements.get('mt-start-btn').style.display).toBe('flex');
        expect(elements.get('mt-stop-btn').style.display).toBe('none');
    });
});

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPretranslationSnapshot } from '../src/background/pretranslation-checkpoint.js';

const source = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');

function handler(startMarker, endMarker, dependencies, message, sender, sendResponse) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Background message boundary missing');
    return new Function(...Object.keys(dependencies), 'message', 'sender', 'sendResponse',
        source.slice(start, end))(...Object.values(dependencies), message, sender, sendResponse);
}

describe('background asynchronous message failures', () => {
    it('returns serializable completed pretranslation status after a reader has consumed it', async () => {
        const url = 'https://manga.test/ch2';
        const data = { url, images: ['https://manga.test/p.jpg'], results: [{ results: [] }],
            isDone: true, consumptionReady: Promise.resolve(), foregroundJob: { id: 'private-implementation' } };
        const reply = vi.fn();
        handler("if (message.action === 'CHECK_PRETRANSLATED_CHAPTER')", "if (message.action === 'RETRY_PRETRANSLATED_CHAPTER')",
            { pretranslatedChaptersMap: new Map([[url, data]]), isSuccessfulPretranslation: () => true,
                createPretranslationSnapshot }, { action: 'CHECK_PRETRANSLATED_CHAPTER', payload: { nextUrl: url } }, {}, reply);
        await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
        const response = reply.mock.calls[0][0];
        expect(response.data).not.toHaveProperty('consumptionReady');
        expect(response.data).not.toHaveProperty('foregroundJob');
        expect(() => structuredClone(response)).not.toThrow();
    });
    it('replies when metadata or manga key storage reads fail', async () => {
        const state = { get: async () => { throw new Error('storage unavailable'); } };
        for (const [start, end] of [
            ["if (message.action === 'getResultMetadata')", "if (message.action === 'getTabMangaKey')"],
            ["if (message.action === 'getTabMangaKey')", "if (message.action === 'getGlossaryDetail')"]
        ]) {
            const reply = vi.fn();
            expect(handler(start, end, { state }, { action: start.includes('Metadata') ? 'getResultMetadata' : 'getTabMangaKey' },
                { tab: { id: 1, url: 'about:blank' } }, reply)).toBe(true);
            await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
            expect(reply.mock.calls[0][0].error).toBe('storage unavailable');
        }
    });

    it('replies when saving the pause state fails', async () => {
        const reply = vi.fn();
        expect(handler("if (message.action === 'toggleBatchPause')", "if (message.action === 'SET_BATCH_PAUSE')",
            { state: { get: async () => false, set: async () => { throw new Error('write failed'); } },
                log: { info: vi.fn() } }, { action: 'toggleBatchPause' }, {}, reply)).toBe(true);
        await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ status: 'error', error: 'write failed' }));
    });
});

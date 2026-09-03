import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { beginMangaRun, cancelMangaRun, clearMangaRun, getMangaAbortSignal, isMangaRunAborted } from '../src/background/manga-cancellation.js';
import { callGeminiAPIBatch } from '../src/background/translate-api.js';
import { executeHybridRequest, HybridRequestAbortedError } from '../src/background/hybrid-retry.js';
import { executeFallbackImages } from '../src/background/manga-lifecycle.js';
import { state } from '../src/utils/state.js';

describe('Manga Mode: Active Gemini Request Abort on STOP', () => {

    describe('1. Manga Cancellation Registry Lifecycle', () => {
        beforeEach(() => {
            clearMangaRun();
        });

        afterEach(() => {
            clearMangaRun();
        });

        it('A: beginMangaRun creates an active controller with non-aborted signal', () => {
            const controller = beginMangaRun();
            expect(controller).toBeDefined();
            expect(controller.signal.aborted).toBe(false);
            expect(isMangaRunAborted()).toBe(false);

            const signal = getMangaAbortSignal();
            expect(signal.aborted).toBe(false);
            expect(signal).toBe(controller.signal);
        });

        it('B: cancelMangaRun aborts current signal and is idempotent', () => {
            beginMangaRun();
            const signal = getMangaAbortSignal();
            expect(signal.aborted).toBe(false);

            cancelMangaRun();
            expect(signal.aborted).toBe(true);
            expect(isMangaRunAborted()).toBe(true);

            // 重複 cancel 不 throw
            expect(() => cancelMangaRun()).not.toThrow();
            expect(signal.aborted).toBe(true);
        });

        it('C: beginMangaRun aborts previous running controller when superseded', () => {
            beginMangaRun();
            const signal1 = getMangaAbortSignal();

            beginMangaRun();
            const signal2 = getMangaAbortSignal();

            expect(signal1.aborted).toBe(true);
            expect(signal2.aborted).toBe(false);
            expect(signal2).not.toBe(signal1);
        });

        it('D: clearMangaRun aborts signal and cleans up state (fail-closed)', () => {
            beginMangaRun();
            const signal = getMangaAbortSignal();

            clearMangaRun();
            expect(signal.aborted).toBe(true);
            expect(isMangaRunAborted()).toBe(true);

            // 清理後再次取得 signal 仍回傳已中斷的 signal，落實 fail-closed
            const querySignal = getMangaAbortSignal();
            expect(querySignal.aborted).toBe(true);
        });
    });

    describe('2. callGeminiAPIBatch AbortSignal Integration', () => {
        beforeEach(() => {
            vi.restoreAllMocks();
            globalThis.chrome = {
                storage: {
                    local: {
                        get: vi.fn().mockResolvedValue({}),
                        set: vi.fn().mockResolvedValue({})
                    },
                    onChanged: {
                        addListener: vi.fn(),
                        removeListener: vi.fn()
                    }
                }
            };
            state.cache = { apiKey: 'test-api-key', modelName: 'gemini-3.1-flash-lite' };
            state.isInitialized = true;
        });

        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        it('E: pre-aborted signal throws cancellation error with 0 fetch calls', async () => {
            const controller = new AbortController();
            controller.abort();

            const fetchSpy = vi.spyOn(globalThis, 'fetch');

            await expect(callGeminiAPIBatch(
                ['base64-image-1'],
                'Test Prompt',
                '',
                'test-key',
                'gemini-3.1-flash-lite',
                controller.signal
            )).rejects.toMatchObject({
                isCancelled: true,
                isExternalAbort: true
            });

            expect(fetchSpy).toHaveBeenCalledTimes(0);
        });

        it('F: external abort during pending batch fetch aborts fetch and does NOT disguise as timeout', async () => {
            const controller = new AbortController();

            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
                return new Promise((resolve, reject) => {
                    options.signal?.addEventListener('abort', () => {
                        const err = new Error('The user aborted a request.');
                        err.name = 'AbortError';
                        reject(err);
                    }, { once: true });
                });
            });

            const batchPromise = callGeminiAPIBatch(
                ['base64-image-1'],
                'Test Prompt',
                '',
                'test-key',
                'gemini-3.1-flash-lite',
                controller.signal
            );

            await new Promise(r => setTimeout(r, 10));
            controller.abort();

            await expect(batchPromise).rejects.toMatchObject({
                isCancelled: true,
                isExternalAbort: true
            });

            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('G: internal timeout triggers timeout error rather than cancellation error', async () => {
            vi.useFakeTimers();

            vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
                return new Promise((resolve, reject) => {
                    options.signal?.addEventListener('abort', () => {
                        const err = new Error('The user aborted a request.');
                        err.name = 'AbortError';
                        reject(err);
                    }, { once: true });
                });
            });

            const externalController = new AbortController(); // 未 abort
            const batchPromise = callGeminiAPIBatch(
                ['base64-image-1'],
                'Test Prompt',
                '',
                'test-key',
                'gemini-3.1-flash-lite',
                externalController.signal
            );

            const assertion = expect(batchPromise).rejects.toThrow('批次翻譯逾時');

            // 推進超時時間 (1 張圖片 timeout = 28000ms)
            await vi.advanceTimersByTimeAsync(30000);

            await assertion;
        });
    });

    describe('3. Hybrid Retry & Failover Interruption', () => {
        it('H: external abort in request immediately throws HybridRequestAbortedError without key rotation or model fallback', async () => {
            let callCount = 0;
            const mockRequest = vi.fn().mockImplementation(async () => {
                callCount++;
                const cancelErr = new Error('Request aborted by user STOP');
                cancelErr.isCancelled = true;
                cancelErr.isExternalAbort = true;
                throw cancelErr;
            });

            await expect(executeHybridRequest({
                candidateKeys: ['key-1', 'key-2'],
                scheduledKey: 'key-1',
                scheduledModel: 'gemini-3.1-flash-lite',
                primaryModel: 'gemini-3.1-flash-lite',
                secondaryModel: 'gemini-2.5-flash',
                isHybrid: true,
                request: mockRequest,
                shouldContinue: () => true
            })).rejects.toBeInstanceOf(HybridRequestAbortedError);

            // 絕對沒有進行後續 key-2 或 secondaryModel 的重試，只嘗試了第 1 次即終止
            expect(callCount).toBe(1);
        });
    });

    describe('4. Fallback Single-Image & Sub-Batches Cancellation', () => {
        it('I: executeFallbackImages stops immediately when translateSingle throws cancellation error', async () => {
            let processedImages = 0;
            const mockTranslateSingle = vi.fn().mockImplementation(async () => {
                processedImages++;
                if (processedImages === 1) {
                    const cancelErr = new Error('Request aborted by user STOP');
                    cancelErr.isCancelled = true;
                    cancelErr.isExternalAbort = true;
                    throw cancelErr;
                }
                return { results: [{ original: '日文', translation: '中文' }] };
            });

            const validItems = [
                { originalIdx: 0, b64: 'img0' },
                { originalIdx: 1, b64: 'img1' },
                { originalIdx: 2, b64: 'img2' }
            ];

            const result = await executeFallbackImages({
                validItems,
                fallbackModelName: 'fallback-model',
                getNextApiKey: () => 'test-key',
                translateSingle: mockTranslateSingle,
                shouldContinue: async () => true,
                broadcastStatus: () => {}
            });

            expect(result.wasStopped).toBe(true);
            expect(mockTranslateSingle).toHaveBeenCalledTimes(1); // 第 2、3 張完全不處理
            expect(result.fallbackResults[0].error).toBe('翻譯已停止');
            expect(result.fallbackResults[1].error).toBe('翻譯已停止');
            expect(result.fallbackResults[2].error).toBe('翻譯已停止');
        });
    });
});

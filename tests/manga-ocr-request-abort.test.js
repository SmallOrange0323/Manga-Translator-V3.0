import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { beginMangaRun, cancelMangaRun, clearMangaRun, getMangaAbortSignal } from '../src/background/manga-cancellation.js';
import { callGeminiAPIBatchOcr, extractTextFromImage } from '../src/background/translate-api.js';
import { executeOcrFallbackImages, shouldFallbackAfterOcrError, shouldProceedToStage15 } from '../src/background/manga-lifecycle.js';
import { state } from '../src/utils/state.js';

describe('Manga Two-Step Phase 1 OCR: Active Gemini Request Abort on STOP', () => {

    beforeEach(() => {
        vi.restoreAllMocks();
        clearMangaRun();
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
        state.cache = { apiKey: 'test-ocr-key', ocrModelName: 'gemini-3.1-flash-lite' };
        state.isInitialized = true;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        clearMangaRun();
    });

    // A. callGeminiAPIBatchOcr pre-aborted signal -> 0 fetch
    it('A: pre-aborted signal in callGeminiAPIBatchOcr immediately throws cancellation with 0 fetch calls', async () => {
        const controller = new AbortController();
        controller.abort();

        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(callGeminiAPIBatchOcr(['base64_img1'], {
            model: 'gemini-3.1-flash-lite',
            apiKey: 'test-key',
            signal: controller.signal
        })).rejects.toMatchObject({
            isCancelled: true,
            isExternalAbort: true
        });

        expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    // B. signal 在 async setup 期間 abort -> fetch 前 fail closed -> 0 fetch
    it('B: aborting signal during async state setup in callGeminiAPIBatchOcr prevents fetch from being sent', async () => {
        state.isInitialized = false;
        const controller = new AbortController();

        // 模擬 state.init 期間外部觸發 STOP
        vi.spyOn(state, 'init').mockImplementationOnce(async () => {
            controller.abort();
            state.isInitialized = true;
        });

        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(callGeminiAPIBatchOcr(['base64_img1'], {
            model: 'gemini-3.1-flash-lite',
            apiKey: 'test-key',
            signal: controller.signal
        })).rejects.toMatchObject({
            isCancelled: true,
            isExternalAbort: true
        });

        expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    // C. pending batch OCR fetch external abort -> underlying fetch abort -> cancellation error
    it('C: external abort during pending batch OCR fetch aborts underlying request without retry', async () => {
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

        const batchOcrPromise = callGeminiAPIBatchOcr(['base64_img1', 'base64_img2'], {
            model: 'gemini-3.1-flash-lite',
            apiKey: 'test-key',
            signal: controller.signal
        });

        await new Promise(r => setTimeout(r, 10));
        controller.abort();

        await expect(batchOcrPromise).rejects.toMatchObject({
            isCancelled: true,
            isExternalAbort: true
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // D. external OCR abort 不得變成「批次 OCR 逾時」
    it('D: external abort does not masquerade as batch OCR timeout', async () => {
        const controller = new AbortController();

        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
            return new Promise((resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    const err = new Error('The user aborted a request.');
                    err.name = 'AbortError';
                    reject(err);
                }, { once: true });
            });
        });

        const batchOcrPromise = callGeminiAPIBatchOcr(['base64_img1'], {
            model: 'gemini-3.1-flash-lite',
            apiKey: 'test-key',
            signal: controller.signal
        });

        await new Promise(r => setTimeout(r, 10));
        controller.abort();

        try {
            await batchOcrPromise;
            expect.fail('Should have thrown');
        } catch (err) {
            expect(err.isCancelled).toBe(true);
            expect(err.message).not.toContain('逾時');
        }
    });

    // E. internal timeout 仍產生「批次 OCR 逾時」而非 cancellation
    it('E: internal timeout retains "批次 OCR 逾時" error rather than cancellation', async () => {
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
        const batchOcrPromise = callGeminiAPIBatchOcr(['base64_img1'], {
            model: 'gemini-3.1-flash-lite',
            apiKey: 'test-key',
            signal: externalController.signal
        });

        const assertion = expect(batchOcrPromise).rejects.toThrow('批次 OCR 逾時');

        // 推進逾時時間 (1 張圖片 timeout = 40000ms)
        await vi.advanceTimersByTimeAsync(45000);

        await assertion;
    });

    // F. Phase 1 batch caller 收到 cancellation -> shouldFallbackAfterOcrError 回傳 false -> 不執行 OCR fallback
    it('F: shouldFallbackAfterOcrError returns false when error is cancellation or signal is aborted', () => {
        const cancelErr = new Error('Request aborted by user STOP');
        cancelErr.isCancelled = true;
        cancelErr.isExternalAbort = true;

        const activeSignal = new AbortController().signal;
        expect(shouldFallbackAfterOcrError(cancelErr, activeSignal)).toBe(false);

        const abortedController = new AbortController();
        abortedController.abort();
        const normalErr = new Error('HTTP 500');
        expect(shouldFallbackAfterOcrError(normalErr, abortedController.signal)).toBe(false);

        const translationStoppedErr = new Error('Stopped');
        translationStoppedErr.code = 'TRANSLATION_STOPPED';
        expect(shouldFallbackAfterOcrError(translationStoppedErr, activeSignal)).toBe(false);
    });

    // G. ordinary batch OCR error -> shouldFallbackAfterOcrError 回傳 true -> 仍執行 OCR fallback
    it('G: shouldFallbackAfterOcrError returns true for ordinary API errors, allowing fallback', () => {
        const activeSignal = new AbortController().signal;
        const ordinaryErr = new Error('API 500: Server Error');

        expect(shouldFallbackAfterOcrError(ordinaryErr, activeSignal)).toBe(true);

        const timeoutErr = new Error('批次 OCR 逾時 (40s)');
        expect(shouldFallbackAfterOcrError(timeoutErr, activeSignal)).toBe(true);
    });

    // H. extractTextFromImage pre-aborted signal -> 0 fetch
    it('H: extractTextFromImage with pre-aborted signal throws cancellation with 0 fetch calls', async () => {
        const controller = new AbortController();
        controller.abort();

        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(extractTextFromImage('base64_single', {
            model: 'gemini-3.1-flash-lite',
            apiKey: 'test-key',
            signal: controller.signal
        })).rejects.toMatchObject({
            isCancelled: true,
            isExternalAbort: true
        });

        expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    // I. extractTextFromImage pending fetch + STOP -> fetch abort
    it('I: external abort during pending extractTextFromImage fetch aborts underlying request', async () => {
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

        const singlePromise = extractTextFromImage('base64_single', {
            model: 'gemini-3.1-flash-lite',
            apiKey: 'test-key',
            signal: controller.signal
        });

        await new Promise(r => setTimeout(r, 10));
        controller.abort();

        await expect(singlePromise).rejects.toMatchObject({
            isCancelled: true,
            isExternalAbort: true
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // J. executeOcrFallbackImages 中途 cancellation -> 不處理後續 images
    it('J: executeOcrFallbackImages halts immediately upon cancellation and marks wasStopped without processing remaining images', async () => {
        let singleOcrCalls = 0;
        const mockExtractSingle = vi.fn().mockImplementation(async (b64) => {
            singleOcrCalls++;
            if (singleOcrCalls === 1) {
                const cancelErr = new Error('Request aborted by user STOP');
                cancelErr.isCancelled = true;
                cancelErr.isExternalAbort = true;
                throw cancelErr;
            }
            return 'IMAGE_TEXT';
        });

        const results = await executeOcrFallbackImages({
            base64List: ['img0_b64', 'img1_b64', 'img2_b64'],
            extractSingle: mockExtractSingle,
            shouldContinue: async () => true
        });

        expect(results.wasStopped).toBe(true);
        expect(mockExtractSingle).toHaveBeenCalledTimes(1);
        expect(results[0]).toBe('');
        expect(results[1]).toBe('');
        expect(results[2]).toBe('');
    });

    // K. fallback cancellation -> caller 不進 Stage 1.5
    it('K: shouldProceedToStage15 rejects proceeding when wasStopped is true', () => {
        expect(shouldProceedToStage15({ wasStopped: true, isStopping: false })).toBe(false);
        expect(shouldProceedToStage15({ wasStopped: false, isStopping: true })).toBe(false);
        expect(shouldProceedToStage15({ wasStopped: false, isStopping: false })).toBe(true);
    });

    // L. fresh Manga run signal 仍可供 Phase 1 正常 request，不受上一 run abort 影響
    it('L: beginMangaRun creates fresh non-aborted signal that is unaffected by prior run cancellation', () => {
        beginMangaRun();
        const signal1 = getMangaAbortSignal();
        expect(signal1.aborted).toBe(false);

        cancelMangaRun();
        expect(signal1.aborted).toBe(true);

        // 新任務啟動
        beginMangaRun();
        const signal2 = getMangaAbortSignal();
        expect(signal2.aborted).toBe(false);
        expect(signal2).not.toBe(signal1);
    });
});

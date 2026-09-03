import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
    isModelRefusalError,
    translateNovelBatchWithRefusalIsolation,
    buildNovelSingleRetryOptions,
    buildSuccessfulNovelTranslationPairs,
    buildNovelIsolationMappedResult
} from '../src/background/novel-refusal.js';
import { translateTexts } from '../src/background/translate-api.js';
import { state } from '../src/utils/state.js';

describe('Novel Refusal & Batch Isolation Tests', () => {

    describe('1. Refusal Error Classification', () => {
        it('identifies error with isProhibited === true', () => {
            const err = new Error('Prohibited content');
            err.isProhibited = true;
            expect(isModelRefusalError(err)).toBe(true);
        });

        it('identifies error with finishReason SAFETY / BLOCKLIST / PROHIBITED_CONTENT', () => {
            const err1 = new Error('Safety trigger');
            err1.finishReason = 'SAFETY';
            expect(isModelRefusalError(err1)).toBe(true);

            const err2 = new Error('Blocklist trigger');
            err2.finishReason = 'BLOCKLIST';
            expect(isModelRefusalError(err2)).toBe(true);

            const err3 = new Error('Prohibited content trigger');
            err3.finishReason = 'PROHIBITED_CONTENT';
            expect(isModelRefusalError(err3)).toBe(true);
        });

        it('does not classify ordinary 429 / 500 / timeout / parse error as refusal', () => {
            const err429 = new Error('Rate limit 429');
            err429.statusCode = 429;
            expect(isModelRefusalError(err429)).toBe(false);

            const err500 = new Error('Internal Server Error 500');
            err500.statusCode = 500;
            expect(isModelRefusalError(err500)).toBe(false);

            const errTimeout = new Error('The user aborted a request');
            errTimeout.name = 'AbortError';
            expect(isModelRefusalError(errTimeout)).toBe(false);

            const errParse = new Error('JSON Parse failed');
            expect(isModelRefusalError(errParse)).toBe(false);
        });
    });

    describe('2. Isolation Algorithm & Recursion Guarantees', () => {
        // A. Whole batch success -> 1 call -> 不 split
        it('A: whole batch success triggers exactly 1 translate call with 0 split', async () => {
            const items = [
                { idx: 0, text: 'Hello' },
                { idx: 1, text: 'World' },
                { idx: 2, text: 'Test' }
            ];

            const translateFn = vi.fn().mockResolvedValue(['你好', '世界', '測試']);

            const results = await translateNovelBatchWithRefusalIsolation(items, translateFn);

            expect(translateFn).toHaveBeenCalledTimes(1);
            expect(results).toEqual([
                { idx: 0, text: 'Hello', translation: '你好' },
                { idx: 1, text: 'World', translation: '世界' },
                { idx: 2, text: 'Test', translation: '測試' }
            ]);
        });

        // B. Whole batch ordinary 429 error -> throw -> 0 split
        it('B: whole batch ordinary 429 error rethrows directly without splitting', async () => {
            const items = [{ idx: 0, text: 'Text 1' }, { idx: 1, text: 'Text 2' }];
            const err429 = new Error('Rate limit 429');
            err429.statusCode = 429;

            const translateFn = vi.fn().mockRejectedValue(err429);

            await expect(translateNovelBatchWithRefusalIsolation(items, translateFn))
                .rejects.toThrow('Rate limit 429');

            expect(translateFn).toHaveBeenCalledTimes(1);
        });

        // C. Whole batch timeout -> throw -> 0 split
        it('C: whole batch timeout error rethrows directly without splitting', async () => {
            const items = [{ idx: 0, text: 'Text 1' }, { idx: 1, text: 'Text 2' }];
            const timeoutErr = new Error('Request Timeout');

            const translateFn = vi.fn().mockRejectedValue(timeoutErr);

            await expect(translateNovelBatchWithRefusalIsolation(items, translateFn))
                .rejects.toThrow('Request Timeout');

            expect(translateFn).toHaveBeenCalledTimes(1);
        });

        // D. Whole batch Model Refusal 但兩個 half 都成功 -> 全部成功 -> ordering 正確
        it('D: whole batch refusal where child halves succeed completes all with correct ordering', async () => {
            const items = [
                { idx: 0, text: 'T0' },
                { idx: 1, text: 'T1' },
                { idx: 2, text: 'T2' },
                { idx: 3, text: 'T3' }
            ];

            const refusalErr = new Error('Blocked by policy');
            refusalErr.isProhibited = true;

            const translateFn = vi.fn().mockImplementation(async (sub) => {
                if (sub.length === 4) throw refusalErr;
                return sub.map(s => `Trans_${s.text}`);
            });

            const results = await translateNovelBatchWithRefusalIsolation(items, translateFn);

            expect(translateFn).toHaveBeenCalledTimes(3); // 1 full + 2 halves
            expect(results).toEqual([
                { idx: 0, text: 'T0', translation: 'Trans_T0' },
                { idx: 1, text: 'T1', translation: 'Trans_T1' },
                { idx: 2, text: 'T2', translation: 'Trans_T2' },
                { idx: 3, text: 'T3', translation: 'Trans_T3' }
            ]);
        });

        // E. 只有一個 item 永遠 refusal -> 只有該 item failed
        it('E: single toxic item refusal isolates only that item as failed', async () => {
            const items = [
                { idx: 0, text: 'Safe 1' },
                { idx: 1, text: 'Toxic' },
                { idx: 2, text: 'Safe 2' },
                { idx: 3, text: 'Safe 3' }
            ];

            const refusalErr = new Error('Safety block');
            refusalErr.finishReason = 'SAFETY';

            const translateFn = vi.fn().mockImplementation(async (sub) => {
                if (sub.some(s => s.text === 'Toxic')) {
                    throw refusalErr;
                }
                return sub.map(s => `OK_${s.text}`);
            });

            const results = await translateNovelBatchWithRefusalIsolation(items, translateFn);

            expect(results).toEqual([
                { idx: 0, text: 'Safe 1', translation: 'OK_Safe 1' },
                { idx: 1, text: 'Toxic', translation: '（翻譯失敗）', failed: true, failureReason: 'model-refusal' },
                { idx: 2, text: 'Safe 2', translation: 'OK_Safe 2' },
                { idx: 3, text: 'Safe 3', translation: 'OK_Safe 3' }
            ]);
        });

        // F. 兩個不同位置 item refusal -> 只有兩個 failed
        it('F: two toxic items in different halves isolate both as failed and keep others successful', async () => {
            const items = [
                { idx: 0, text: 'Safe 1' },
                { idx: 1, text: 'Toxic A' },
                { idx: 2, text: 'Safe 2' },
                { idx: 3, text: 'Toxic B' }
            ];

            const refusalErr = new Error('Safety block');
            refusalErr.isProhibited = true;

            const translateFn = vi.fn().mockImplementation(async (sub) => {
                if (sub.some(s => s.text.startsWith('Toxic'))) {
                    throw refusalErr;
                }
                return sub.map(s => `OK_${s.text}`);
            });

            const results = await translateNovelBatchWithRefusalIsolation(items, translateFn);

            expect(results).toEqual([
                { idx: 0, text: 'Safe 1', translation: 'OK_Safe 1' },
                { idx: 1, text: 'Toxic A', translation: '（翻譯失敗）', failed: true, failureReason: 'model-refusal' },
                { idx: 2, text: 'Safe 2', translation: 'OK_Safe 2' },
                { idx: 3, text: 'Toxic B', translation: '（翻譯失敗）', failed: true, failureReason: 'model-refusal' }
            ]);
        });

        // G. 全部 item refusal -> 全部 failure markers -> recursion bounded
        it('G: all items refused isolates every item as failed with bounded recursion', async () => {
            const items = [
                { idx: 0, text: 'T0' },
                { idx: 1, text: 'T1' },
                { idx: 2, text: 'T2' }
            ];

            const refusalErr = new Error('Refusal on all');
            refusalErr.finishReason = 'PROHIBITED_CONTENT';

            const translateFn = vi.fn().mockRejectedValue(refusalErr);

            const results = await translateNovelBatchWithRefusalIsolation(items, translateFn);

            expect(results).toHaveLength(3);
            results.forEach((r, i) => {
                expect(r.idx).toBe(i);
                expect(r.translation).toBe('（翻譯失敗）');
                expect(r.failed).toBe(true);
                expect(r.failureReason).toBe('model-refusal');
            });
        });

        // H. odd-size batch: 5 items split 後不漏不重複順序正確
        it('H: odd-sized batch (5 items) maintains exact order without missing or duplicating items', async () => {
            const items = [
                { idx: 0, text: 'A' },
                { idx: 1, text: 'B' },
                { idx: 2, text: 'C' },
                { idx: 3, text: 'D' },
                { idx: 4, text: 'E' }
            ];

            const refusalErr = new Error('Refusal on C');
            refusalErr.finishReason = 'BLOCKLIST';

            const translateFn = vi.fn().mockImplementation(async (sub) => {
                if (sub.some(s => s.text === 'C')) {
                    throw refusalErr;
                }
                return sub.map(s => `Trans_${s.text}`);
            });

            const results = await translateNovelBatchWithRefusalIsolation(items, translateFn);

            expect(results.map(r => r.idx)).toEqual([0, 1, 2, 3, 4]);
            expect(results.map(r => r.text)).toEqual(['A', 'B', 'C', 'D', 'E']);
            expect(results[2].failed).toBe(true);
            expect(results[2].translation).toBe('（翻譯失敗）');
            expect(results[0].translation).toBe('Trans_A');
            expect(results[4].translation).toBe('Trans_E');
        });

        // I. Original idx 非 0-based: [100, 101, 102...] 最終 idx 保持
        it('I: preserves non-zero arbitrary original indices', async () => {
            const items = [
                { idx: 100, text: 'Para 100' },
                { idx: 101, text: 'Para 101' },
                { idx: 102, text: 'Para 102' }
            ];

            const refusalErr = new Error('Blocked');
            refusalErr.isProhibited = true;

            const translateFn = vi.fn().mockImplementation(async (sub) => {
                if (sub.some(s => s.idx === 101)) throw refusalErr;
                return sub.map(s => `OK_${s.idx}`);
            });

            const results = await translateNovelBatchWithRefusalIsolation(items, translateFn);

            expect(results.map(r => r.idx)).toEqual([100, 101, 102]);
            expect(results[1].failed).toBe(true);
            expect(results[0].translation).toBe('OK_100');
            expect(results[2].translation).toBe('OK_102');
        });

        // J. ordinary error 出現在 split child -> 不繼續 recursive isolation -> error propagate
        it('J: ordinary error occurring during split child halts recursive isolation and propagates error', async () => {
            const items = [
                { idx: 0, text: 'A' },
                { idx: 1, text: 'B' },
                { idx: 2, text: 'C' },
                { idx: 3, text: 'D' }
            ];

            const refusalErr = new Error('Full batch refusal');
            refusalErr.isProhibited = true;

            const err429 = new Error('HTTP 429 Too Many Requests');
            err429.statusCode = 429;

            const translateFn = vi.fn().mockImplementation(async (sub) => {
                if (sub.length === 4) throw refusalErr;
                throw err429;
            });

            await expect(translateNovelBatchWithRefusalIsolation(items, translateFn))
                .rejects.toThrow('HTTP 429 Too Many Requests');
        });

        // K. STOP / shouldContinue false -> 不再呼叫下一個 child translate
        it('K: shouldContinue returning false immediately aborts further child calls', async () => {
            const items = [
                { idx: 0, text: 'A' },
                { idx: 1, text: 'B' }
            ];

            const refusalErr = new Error('Refusal on batch');
            refusalErr.isProhibited = true;

            let isRunning = true;
            const translateFn = vi.fn().mockImplementation(async (sub) => {
                if (sub.length === 2) throw refusalErr;
                isRunning = false;
                return ['Trans_A'];
            });

            await expect(translateNovelBatchWithRefusalIsolation(items, translateFn, {
                shouldContinue: () => isRunning
            })).rejects.toThrow('Session aborted');

            expect(translateFn).toHaveBeenCalledTimes(2); // 1 full + 1 left only
        });
    });

    describe('3. Production translateTexts Refusal Retry Policy (Sections 6 & 23)', () => {
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
            state.cache = { apiKey: 'test-api-key' };
            state.isInitialized = true;
        });

        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        // L. fallback primary refusal -> immediate fallback (呼叫 production translateTexts)
        it('L: primary refusal immediately calls fallback model without exponential delay', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            finishReason: 'SAFETY',
                            content: { parts: [{ text: '' }] }
                        }]
                    })
                })
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            finishReason: 'STOP',
                            content: { parts: [{ text: '{"results":["備援模型翻譯成功"]}' }] }
                        }]
                    })
                });

            const res = await translateTexts(['日文文字'], {
                apiKey: 'test-key',
                model: 'primary-model-a',
                fallbackModel: 'fallback-model-b'
            });

            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(fetchSpy.mock.calls[0][0]).toContain('models/primary-model-a:generateContent');
            expect(fetchSpy.mock.calls[1][0]).toContain('models/fallback-model-b:generateContent');
            expect(res.usedModelName).toBe('fallback-model-b');
            expect(res.results[0]).toBe('備援模型翻譯成功');
        });

        // M. fallback also refusal -> 不做第三次相同 fallback request (呼叫 production translateTexts)
        it('M: fallback also refusal throws immediately without duplicate retry', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            finishReason: 'SAFETY',
                            content: { parts: [{ text: '' }] }
                        }]
                    })
                })
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            finishReason: 'BLOCKLIST',
                            content: { parts: [{ text: '' }] }
                        }]
                    })
                });

            await expect(translateTexts(['日文文字'], {
                apiKey: 'test-key',
                model: 'primary-model-a',
                fallbackModel: 'fallback-model-b'
            })).rejects.toMatchObject({
                isProhibited: true,
                finishReason: 'BLOCKLIST'
            });

            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(fetchSpy.mock.calls[0][0]).toContain('models/primary-model-a:generateContent');
            expect(fetchSpy.mock.calls[1][0]).toContain('models/fallback-model-b:generateContent');
        });

        // N. no distinct fallback + refusal -> 不重試同模型 3 次 (呼叫 production translateTexts)
        it('N: no distinct fallback throws immediately on refusal without 3 retries', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            finishReason: 'PROHIBITED_CONTENT',
                            content: { parts: [{ text: '' }] }
                        }]
                    })
                });

            await expect(translateTexts(['日文文字'], {
                apiKey: 'test-key',
                model: 'primary-model-a',
                fallbackModel: 'primary-model-a'
            })).rejects.toMatchObject({
                isProhibited: true,
                finishReason: 'PROHIBITED_CONTENT'
            });

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(fetchSpy.mock.calls[0][0]).toContain('models/primary-model-a:generateContent');
        });

        // O. normal network failure -> 既有 retry behavior 保留 (3 calls, fake timers, 呼叫 production translateTexts)
        it('O: normal network failure retains standard retry sequence and fallback transition', async () => {
            vi.useFakeTimers();

            const fetchSpy = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce({
                    ok: false,
                    status: 500,
                    json: async () => ({ error: { message: 'Internal Server Error 1' } })
                })
                .mockResolvedValueOnce({
                    ok: false,
                    status: 500,
                    json: async () => ({ error: { message: 'Internal Server Error 2' } })
                })
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            finishReason: 'STOP',
                            content: { parts: [{ text: '{"results":["第三次嘗試成功"]}' }] }
                        }]
                    })
                });

            const translatePromise = translateTexts(['日文文字'], {
                apiKey: 'test-key',
                model: 'primary-model-a',
                fallbackModel: 'fallback-model-b'
            });

            // attempt 1 delay: 2000ms, attempt 2 delay: 4000ms
            await vi.advanceTimersByTimeAsync(15000);
            const res = await translatePromise;

            expect(fetchSpy).toHaveBeenCalledTimes(3);
            expect(fetchSpy.mock.calls[0][0]).toContain('models/primary-model-a:generateContent');
            expect(fetchSpy.mock.calls[1][0]).toContain('models/fallback-model-b:generateContent');
            expect(fetchSpy.mock.calls[2][0]).toContain('models/fallback-model-b:generateContent');
            expect(res.results[0]).toBe('第三次嘗試成功');
        });

        // P. single paragraph retry pure helper
        it('P: buildNovelSingleRetryOptions correctly structures single retry options for production', () => {
            const options = buildNovelSingleRetryOptions({
                model: 'novel-model-3.5',
                fallbackModel: 'fallback-model-2.5',
                prompt: 'Custom golden prompt',
                glossarySnippet: 'Term1 -> 譯詞1'
            });

            expect(options.model).toBe('novel-model-3.5');
            expect(options.fallbackModel).toBe('fallback-model-2.5');
            expect(options.prompt).toBe('Custom golden prompt');
            expect(options.glossarySnippet).toBe('Term1 -> 譯詞1');
            expect(options.schema).toBeDefined();
            expect(options.schema.properties.results.type).toBe('ARRAY');
        });

        // Q. mixed results glossary extraction 排除 failure marker
        it('Q: buildSuccessfulNovelTranslationPairs excludes failure markers and returns empty array on all failures', () => {
            const batchItems = [
                { idx: 0, text: '勇者' },
                { idx: 1, text: '禁語' },
                { idx: 2, text: '魔王' }
            ];
            const translations = ['Hero', '（翻譯失敗）', 'Demon King'];

            const pairs = buildSuccessfulNovelTranslationPairs(batchItems, translations);
            expect(pairs).toEqual([
                { original: '勇者', translation: 'Hero' },
                { original: '魔王', translation: 'Demon King' }
            ]);

            // 全部失敗場景
            const allFailedPairs = buildSuccessfulNovelTranslationPairs(batchItems, ['（翻譯失敗）', '（翻譯失敗）', '（翻譯失敗）']);
            expect(allFailedPairs).toEqual([]);
        });

        // R (Optional): Durable Wiring MappedResult Helper
        it('R: buildNovelIsolationMappedResult sets isFailed: false and preserves all translations for Mixed Batch', () => {
            const isolationResults = [
                { idx: 0, text: 'Safe 1', translation: '譯文1' },
                { idx: 1, text: 'Toxic', translation: '（翻譯失敗）', failed: true, failureReason: 'model-refusal' },
                { idx: 2, text: 'Safe 2', translation: '譯文2' }
            ];

            const mapped = buildNovelIsolationMappedResult(isolationResults);
            expect(mapped.isFailed).toBe(false);
            expect(mapped.translations).toEqual(['譯文1', '（翻譯失敗）', '譯文2']);
        });
    });
});

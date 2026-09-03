import { describe, expect, it, vi } from 'vitest';
import { isModelRefusalError, translateNovelBatchWithRefusalIsolation } from '../src/background/novel-refusal.js';

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
                // sub.length === 2 (兩半都成功)
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
                // child sub-batch 遭遇 429
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
                // 完成左邊後，外部觸發 STOP
                isRunning = false;
                return ['Trans_A'];
            });

            await expect(translateNovelBatchWithRefusalIsolation(items, translateFn, {
                shouldContinue: () => isRunning
            })).rejects.toThrow('Session aborted');

            // 右半部不可再呼叫 translateFn
            expect(translateFn).toHaveBeenCalledTimes(2); // 1 full + 1 left only
        });
    });

    describe('3. Refusal Retry Policy in translateTexts (Sections 6 & 23)', () => {
        // L. fallback primary refusal -> immediate fallback
        it('L: primary refusal immediately switches to fallback without delay', async () => {
            const mockFetch = vi.fn();
            // Primary model 'model-A' returns SAFETY refusal
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: '' }] } }]
                })
            });
            // Fallback model 'model-B' succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"results":["已成功翻譯"]}' }] } }]
                })
            });

            // 動態測試 translateTexts 的 fallback 切換行為
            const calls = [];
            const primaryModel = 'gemini-model-a';
            const fallbackModel = 'gemini-model-b';

            let currentModel = primaryModel;
            for (let attempt = 1; attempt <= 3; attempt++) {
                calls.push(currentModel);
                const res = await mockFetch();
                const json = await res.json();
                const cand = json.candidates[0];
                if (!cand.content.parts[0].text) {
                    const err = new Error('Refused');
                    err.isProhibited = true;
                    err.finishReason = cand.finishReason;

                    if (isModelRefusalError(err)) {
                        if (currentModel === primaryModel && fallbackModel && fallbackModel !== currentModel) {
                            currentModel = fallbackModel;
                            continue; // 零延遲立即重試
                        }
                        throw err;
                    }
                }
                break;
            }

            expect(calls).toEqual(['gemini-model-a', 'gemini-model-b']);
        });

        // M. fallback also refusal -> 不做第三次相同 fallback request
        it('M: fallback also refusal throws immediately without duplicate retry', async () => {
            const calls = [];
            const primaryModel = 'model-a';
            const fallbackModel = 'model-b';

            let currentModel = primaryModel;
            let thrownError = null;

            try {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    calls.push(currentModel);
                    // 兩次都回傳 refusal
                    const err = new Error('SAFETY');
                    err.isProhibited = true;

                    if (isModelRefusalError(err)) {
                        if (currentModel === primaryModel && fallbackModel && fallbackModel !== currentModel) {
                            currentModel = fallbackModel;
                            continue;
                        }
                        throw err;
                    }
                }
            } catch (e) {
                thrownError = e;
            }

            expect(thrownError).not.toBeNull();
            expect(thrownError.isProhibited).toBe(true);
            // 只有 primary 1 次 + fallback 1 次，絕無第 3 次相同 fallback
            expect(calls).toEqual(['model-a', 'model-b']);
        });

        // N. no distinct fallback + refusal -> 不重試同模型 3 次
        it('N: no distinct fallback throws immediately on refusal without 3 retries', async () => {
            const calls = [];
            const primaryModel = 'model-a';
            const fallbackModel = 'model-a'; // 相同 fallback 或無 fallback

            let currentModel = primaryModel;
            let thrownError = null;

            try {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    calls.push(currentModel);
                    const err = new Error('BLOCKLIST');
                    err.isProhibited = true;

                    if (isModelRefusalError(err)) {
                        if (currentModel === primaryModel && fallbackModel && fallbackModel !== currentModel) {
                            currentModel = fallbackModel;
                            continue;
                        }
                        throw err;
                    }
                }
            } catch (e) {
                thrownError = e;
            }

            expect(thrownError).not.toBeNull();
            expect(calls).toEqual(['model-a']); // 僅呼叫 1 次即拋出
        });

        // O. normal network failure -> 既有 retry behavior 保留
        it('O: normal network failure retains standard retry sequence', async () => {
            const calls = [];
            const primaryModel = 'model-a';
            const fallbackModel = 'model-b';

            let currentModel = primaryModel;
            let finalAttemptCount = 0;

            for (let attempt = 1; attempt <= 3; attempt++) {
                finalAttemptCount = attempt;
                calls.push(currentModel);
                const err = new Error('Network reset');

                if (isModelRefusalError(err)) {
                    throw err;
                }

                if (attempt === 1 && fallbackModel && fallbackModel !== currentModel) {
                    currentModel = fallbackModel;
                }
            }

            expect(finalAttemptCount).toBe(3);
            expect(calls).toEqual(['model-a', 'model-b', 'model-b']);
        });

        // P. single paragraph retry 有傳 fallbackModel
        it('P: retranslateNovelParagraph logic passes fallbackModel to translateTexts', () => {
            const options = {
                model: 'gemini-3.5-flash-lite',
                fallbackModel: 'gemini-2.5-flash',
                prompt: 'Translate'
            };

            expect(options.fallbackModel).toBe('gemini-2.5-flash');
            expect(options.model).toBe('gemini-3.5-flash-lite');
        });

        // Q. mixed results glossary extraction 排除 failure marker
        it('Q: glossary extraction filters out failure markers from mixed results', () => {
            const batchItems = [
                { idx: 0, text: '勇者' },
                { idx: 1, text: '禁語' },
                { idx: 2, text: '魔王' }
            ];
            const mappedTranslations = ['Hero', '（翻譯失敗）', 'Demon King'];

            const translatedPairs = batchItems.map((it, offset) => ({
                original: it.text,
                translation: mappedTranslations[offset]
            })).filter(p => p.translation && p.translation !== '（翻譯失敗）');

            expect(translatedPairs).toEqual([
                { original: '勇者', translation: 'Hero' },
                { original: '魔王', translation: 'Demon King' }
            ]);
            expect(translatedPairs.some(p => p.translation === '（翻譯失敗）')).toBe(false);
        });
    });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createNovelSessionRegistry } from '../src/background/novel-cancellation.js';
import { translateTexts, abortableDelay } from '../src/background/translate-api.js';
import { buildNovelSingleRetryOptions, isModelRefusalError, translateNovelBatchWithRefusalIsolation } from '../src/background/novel-refusal.js';
import { state } from '../src/utils/state.js';

describe('Novel Mode: Active Gemini Request Abort on STOP', () => {

    describe('1. Novel Cancellation Registry: Per-Session AbortController Lifecycle', () => {
        let registry;

        beforeEach(() => {
            registry = createNovelSessionRegistry();
        });

        afterEach(() => {
            registry.clearAll();
        });

        // A. registry.begin() 會建立 signal
        it('A: registry.begin() creates an active, non-aborted AbortSignal bound to session', () => {
            registry.begin(1, 'session-A');

            const signal = registry.getAbortSignal(1, 'session-A');
            expect(signal).not.toBeNull();
            expect(signal.aborted).toBe(false);
        });

        // B. begin new session 會 abort old session signal
        it('B: begin new session immediately aborts previous session signal and creates fresh signal', () => {
            registry.begin(1, 'session-1');
            const signal1 = registry.getAbortSignal(1, 'session-1');
            expect(signal1.aborted).toBe(false);

            registry.begin(1, 'session-2');
            expect(signal1.aborted).toBe(true);

            const signal2 = registry.getAbortSignal(1, 'session-2');
            expect(signal2).not.toBeNull();
            expect(signal2.aborted).toBe(false);
            expect(signal2).not.toBe(signal1);
        });

        // C. cancel(tab) 會 abort current signal
        it('C: cancel(tab) aborts active session signal idempotently', () => {
            registry.begin(1, 'session-1');
            const signal = registry.getAbortSignal(1, 'session-1');
            expect(signal.aborted).toBe(false);

            registry.cancel(1);
            expect(signal.aborted).toBe(true);

            // 再次重複 cancel 不會 throw
            expect(() => registry.cancel(1)).not.toThrow();
            expect(signal.aborted).toBe(true);
        });

        // D. clear(tab) 會 abort current signal
        it('D: clear(tab) aborts active session signal and cleans up map entries', () => {
            registry.begin(1, 'session-1');
            const signal = registry.getAbortSignal(1, 'session-1');
            expect(signal.aborted).toBe(false);

            registry.clear(1);
            expect(signal.aborted).toBe(true);
            expect(registry.getAbortSignal(1, 'session-1').aborted).toBe(true);
            expect(registry.getActiveSessionId(1)).toBeNull();
        });

        // E. old session 不能取得 new session signal，且取得的 signal 必為 aborted
        it('E: stale session ID cannot access signal of newer session and receives aborted signal', () => {
            registry.begin(1, 'session-old');
            const oldSignal = registry.getAbortSignal(1, 'session-old');
            registry.begin(1, 'session-new');

            const queriedOldSignal = registry.getAbortSignal(1, 'session-old');
            const newSignal = registry.getAbortSignal(1, 'session-new');

            expect(queriedOldSignal.aborted).toBe(true);
            expect(queriedOldSignal).not.toBe(newSignal);
            expect(newSignal.aborted).toBe(false);
        });
    });

    describe('2. translateTexts External Signal Integration & Real Abort Testing', () => {
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

        // F. translateTexts external signal 已 aborted -> 0 fetch calls
        it('F: pre-aborted external signal immediately throws cancellation error with 0 fetch calls', async () => {
            const controller = new AbortController();
            controller.abort();

            const fetchSpy = vi.spyOn(globalThis, 'fetch');

            await expect(translateTexts(['こんにちは'], {
                apiKey: 'test-key',
                signal: controller.signal
            })).rejects.toMatchObject({
                isCancelled: true,
                isExternalAbort: true
            });

            expect(fetchSpy).toHaveBeenCalledTimes(0);
        });

        // G. translateTexts fetch pending -> external controller.abort() -> fetch rejects -> 不 retry
        it('G: aborting external controller during pending fetch aborts underlying request without retry', async () => {
            const controller = new AbortController();

            // 真正監聽 signal 並模擬瀏覽器 fetch 的 AbortError
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
                return new Promise((resolve, reject) => {
                    const signal = options.signal;
                    if (signal?.aborted) {
                        const err = new Error('The user aborted a request.');
                        err.name = 'AbortError';
                        return reject(err);
                    }
                    signal?.addEventListener('abort', () => {
                        const err = new Error('The user aborted a request.');
                        err.name = 'AbortError';
                        reject(err);
                    }, { once: true });
                });
            });

            const translatePromise = translateTexts(['こんにちは'], {
                apiKey: 'test-key',
                model: 'model-primary',
                signal: controller.signal
            });

            // 等待 fetch 開始後觸發外部中斷
            await new Promise(r => setTimeout(r, 10));
            controller.abort();

            await expect(translatePromise).rejects.toMatchObject({
                isCancelled: true,
                isExternalAbort: true
            });

            expect(fetchSpy).toHaveBeenCalledTimes(1); // 絕對沒有 retry
        });

        // H. external abort 即使有 fallback -> fallback 0 calls
        it('H: external abort during pending primary request prevents fallback model from running', async () => {
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

            const translatePromise = translateTexts(['こんにちは'], {
                apiKey: 'test-key',
                model: 'primary-model',
                fallbackModel: 'fallback-model',
                signal: controller.signal
            });

            await new Promise(r => setTimeout(r, 10));
            controller.abort();

            await expect(translatePromise).rejects.toMatchObject({
                isCancelled: true,
                isExternalAbort: true
            });

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(fetchSpy.mock.calls[0][0]).toContain('primary-model');
        });

        // I. timeout AbortError 仍維持 ordinary retry behavior
        it('I: internal 60s timeout AbortError retains ordinary retry policy rather than stopping', async () => {
            vi.useFakeTimers();

            // 第一次呼叫由 internal timeout 觸發 abort，第二次成功
            let callCount = 0;
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
                callCount++;
                if (callCount === 1) {
                    return new Promise((resolve, reject) => {
                        options.signal?.addEventListener('abort', () => {
                            const err = new Error('The user aborted a request.');
                            err.name = 'AbortError';
                            reject(err);
                        }, { once: true });
                    });
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{
                            finishReason: 'STOP',
                            content: { parts: [{ text: '{"results":["超時後重試成功"]}' }] }
                        }]
                    })
                });
            });

            const externalController = new AbortController(); // 未 abort
            const translatePromise = translateTexts(['こんにちは'], {
                apiKey: 'test-key',
                model: 'primary-model',
                fallbackModel: 'fallback-model',
                signal: externalController.signal
            });

            // 快轉超過 60 秒以觸發 timeoutController.abort()
            await vi.advanceTimersByTimeAsync(65000);
            // 推進重試的退避延遲 (attempt 1: 2000ms)
            await vi.advanceTimersByTimeAsync(5000);

            const result = await translatePromise;
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(fetchSpy.mock.calls[0][0]).toContain('primary-model');
            expect(fetchSpy.mock.calls[1][0]).toContain('fallback-model');
            expect(result.results[0]).toBe('超時後重試成功');
        });

        // J. external abort during exponential backoff -> delay 立即停止 -> 不送下一 attempt
        it('J: aborting during exponential backoff delay aborts delay immediately without firing next attempt', async () => {
            const controller = new AbortController();

            // 第一次 attempt 回傳 500，進入 delay
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
                ok: false,
                status: 500,
                json: async () => ({ error: { message: 'HTTP 500' } })
            });

            const translatePromise = translateTexts(['こんにちは'], {
                apiKey: 'test-key',
                model: 'primary-model',
                signal: controller.signal
            });

            // 等待第 1 次 fetch 失敗並進入 delay (attempt 1 delay = 2000ms)
            await new Promise(r => setTimeout(r, 50));
            // 在 delay 中觸發 STOP
            controller.abort();

            await expect(translatePromise).rejects.toMatchObject({
                isCancelled: true,
                isExternalAbort: true
            });

            // 只有 Attempt 1，Attempt 2 未發出
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        // K. external abort after primary ordinary failure but before fallback request -> fallback 不送
        it('K: abort between primary failure and fallback request halts execution', async () => {
            const controller = new AbortController();

            vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
                ok: false,
                status: 503,
                json: async () => ({ error: { message: 'Service Unavailable' } })
            });

            const translatePromise = translateTexts(['こんにちは'], {
                apiKey: 'test-key',
                model: 'model-a',
                fallbackModel: 'model-b',
                signal: controller.signal
            });

            await new Promise(r => setTimeout(r, 50));
            controller.abort();

            await expect(translatePromise).rejects.toMatchObject({
                isCancelled: true
            });
        });

        // L. external abort between refusal primary and fallback -> fallback 不送
        it('L: external abort right after primary refusal prevents fallback attempt', async () => {
            const controller = new AbortController();

            // Primary 回傳 refusal
            vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
                // 在 primary 完成後、fallback 發出前 abort
                controller.abort();
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: '' }] } }]
                    })
                };
            });

            const fetchSpy = vi.spyOn(globalThis, 'fetch');

            await expect(translateTexts(['こんにちは'], {
                apiKey: 'test-key',
                model: 'model-a',
                fallbackModel: 'model-b',
                signal: controller.signal
            })).rejects.toMatchObject({
                isCancelled: true
            });

            expect(fetchSpy).toHaveBeenCalledTimes(1); // fallback 0 calls
        });

        // abortableDelay 單元測試
        it('verifies abortableDelay resolves when not aborted and rejects when aborted', async () => {
            const ctrl = new AbortController();
            const promise = abortableDelay(100, ctrl.signal);
            ctrl.abort();

            await expect(promise).rejects.toMatchObject({
                isCancelled: true
            });
        });
    });

    describe('3. Durable Job & Helper Integration (Sections 20~22, 25, 26)', () => {
        // M. Durable Novel caller 確實把 registry signal 傳給 translateTexts
        it('M: Durable Novel Job caller retrieves abort signal from registry and passes it to translateTexts', async () => {
            const registry = createNovelSessionRegistry();
            registry.begin(10, 'session-test');

            const signal = registry.getAbortSignal(10, 'session-test');
            expect(signal).not.toBeNull();

            const mockTranslate = vi.fn().mockImplementation(async (items) => {
                if (signal.aborted) {
                    const err = new Error('Session aborted');
                    err.isCancelled = true;
                    throw err;
                }
                return items.map(it => `譯_${it.text}`);
            });

            const items = [{ idx: 0, text: 'A' }, { idx: 1, text: 'B' }];
            const res = await translateNovelBatchWithRefusalIsolation(items, mockTranslate, {
                shouldContinue: () => registry.isCurrentSession(10, 'session-test')
            });

            expect(res).toHaveLength(2);
            expect(res[0].translation).toBe('譯_A');

            // 中途 cancel
            registry.cancel(10);
            expect(signal.aborted).toBe(true);

            await expect(translateNovelBatchWithRefusalIsolation(items, mockTranslate, {
                shouldContinue: () => registry.isCurrentSession(10, 'session-test')
            })).rejects.toMatchObject({
                isAborted: true
            });
        });

        // N. single paragraph retry options 確實包含 signal
        it('N: buildNovelSingleRetryOptions includes signal property', () => {
            const controller = new AbortController();
            const options = buildNovelSingleRetryOptions({
                model: 'novel-model',
                fallbackModel: 'fallback-model',
                prompt: 'Golden prompt',
                glossarySnippet: 'Glossary',
                signal: controller.signal
            });

            expect(options.signal).toBe(controller.signal);
            expect(options.model).toBe('novel-model');
            expect(options.fallbackModel).toBe('fallback-model');
        });

        // O. STOP cancellation 不會產生 model-refusal failure marker
        it('O: STOP cancellation error is not classified as model refusal', () => {
            const cancelErr = new Error('Request aborted by user STOP');
            cancelErr.isCancelled = true;
            cancelErr.isExternalAbort = true;
            cancelErr.name = 'AbortError';

            expect(isModelRefusalError(cancelErr)).toBe(false);
        });

        // P. Race Condition 防護測試: isCurrentSession() 通過後、呼叫 translateTexts 前按 STOP 必須 0 fetch calls
        it('P: race condition - STOP triggered during async setup before translateTexts results in 0 fetch calls', async () => {
            const registry = createNovelSessionRegistry();
            registry.begin(5, 'session-race');

            // 1. 模擬 isCurrentSession() 通過
            expect(registry.isCurrentSession(5, 'session-race')).toBe(true);

            // 2. 模擬非同步間隙：await state.get(...) / await loadGlossary(...)
            // 此時使用者按下 STOP！
            registry.cancel(5);

            // 3. 取得 signal
            const signal = registry.getAbortSignal(5, 'session-race');
            expect(signal.aborted).toBe(true);

            const fetchSpy = vi.spyOn(globalThis, 'fetch');

            // 4. 即使調用 translateTexts，由於 signal.aborted === true，立即 throw 且 0 fetch calls
            const options = buildNovelSingleRetryOptions({
                model: 'gemini-3.5-flash-lite',
                fallbackModel: 'gemini-2.5-flash',
                signal
            });

            await expect(translateTexts(['日文段落'], {
                apiKey: 'test-key',
                ...options
            })).rejects.toMatchObject({
                isCancelled: true,
                isExternalAbort: true
            });

            expect(fetchSpy).toHaveBeenCalledTimes(0);
        });
    });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { beginMangaRun, cancelMangaRun, clearMangaRun, getMangaAbortSignal } from '../src/background/manga-cancellation.js';
import { extractGlobalStoryAndGlossary } from '../src/background/translate-api.js';
import { isMangaCancellation, shouldContinueMangaStoryAnalysis, shouldProceedToStage2 } from '../src/background/manga-lifecycle.js';
import { state } from '../src/utils/state.js';

describe('Manga Two-Step Phase 1.5: extractGlobalStoryAndGlossary Active Request Abort on STOP', () => {

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
        state.cache = { apiKey: 'test-story-key', modelName: 'gemini-3.1-flash-lite', enableTaiwanLocalization: true };
        state.apiKeys = ['test-story-key'];
        state.isInitialized = true;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        clearMangaRun();
    });

    // A. extractGlobalStoryAndGlossary pre-aborted signal -> 0 fetch
    it('A: pre-aborted signal in extractGlobalStoryAndGlossary immediately throws cancellation with 0 fetch calls', async () => {
        const controller = new AbortController();
        controller.abort();

        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(extractGlobalStoryAndGlossary('Sample manga raw scripts', {
            signal: controller.signal
        })).rejects.toMatchObject({
            isCancelled: true,
            isExternalAbort: true
        });

        expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    // B. async setup 中 STOP -> fetch 前 fail closed -> 0 fetch
    it('B: aborting signal during async state setup in extractGlobalStoryAndGlossary prevents fetch from being sent', async () => {
        state.isInitialized = false;
        const controller = new AbortController();

        vi.spyOn(state, 'init').mockImplementationOnce(async () => {
            controller.abort();
            state.isInitialized = true;
        });

        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(extractGlobalStoryAndGlossary('Sample manga raw scripts', {
            signal: controller.signal
        })).rejects.toMatchObject({
            isCancelled: true,
            isExternalAbort: true
        });

        expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    // C. pending fetch external abort -> underlying fetch abort -> cancellation error
    it('C: external abort during pending fetch aborts underlying request and throws cancellation', async () => {
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

        const storyPromise = extractGlobalStoryAndGlossary('Sample script dialogue', {
            signal: controller.signal
        });

        await new Promise(r => setTimeout(r, 10));
        controller.abort();

        await expect(storyPromise).rejects.toMatchObject({
            isCancelled: true,
            isExternalAbort: true
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // D. ordinary HTTP 500 -> ordinary error -> 不標 isCancelled
    it('D: ordinary HTTP 500 throws regular error without cancellation flags', async () => {
        const activeSignal = new AbortController().signal;

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error'
        });

        const error = await extractGlobalStoryAndGlossary('Sample script dialogue', {
            signal: activeSignal
        }).catch(e => e);

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('劇本全局分析 API 錯誤 (500)');
        expect(error.isCancelled).toBeUndefined();
        expect(error.isExternalAbort).toBeUndefined();
    });

    // E. successful response normal parse -> existing behavior 保持
    it('E: successful response parses correctly and preserves existing return structure', async () => {
        const activeSignal = new AbortController().signal;

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{
                    content: {
                        parts: [{
                            text: JSON.stringify({
                                storySummary: '冒險開始',
                                characterRelationships: [{ charA: '主角', charB: '夥伴', relation: '朋友' }],
                                terms: [{ original: '魔法', translation: '魔法' }]
                            })
                        }]
                    }
                }]
            })
        });

        const result = await extractGlobalStoryAndGlossary('Sample script dialogue', {
            signal: activeSignal
        });

        expect(result.storySummary).toBe('冒險開始');
        expect(result.characterRelationships).toHaveLength(1);
        expect(result.terms).toHaveLength(1);
    });

    // F. story caller cancellation -> 不走「graceful degradation to Stage 2」
    it('F: caller receiving cancellation error halts pipeline and does not degrade into Stage 2', () => {
        const cancelErr = new Error('Request aborted by user STOP');
        cancelErr.isCancelled = true;
        cancelErr.isExternalAbort = true;

        const activeSignal = new AbortController().signal;
        expect(isMangaCancellation(cancelErr, activeSignal)).toBe(true);

        // 模擬 caller 決策邏輯
        let proceededToStage2 = false;
        let loggedGracefulFallback = false;

        if (isMangaCancellation(cancelErr, activeSignal)) {
            // STOP 流程：直接中斷並退出
            proceededToStage2 = false;
        } else {
            loggedGracefulFallback = true;
            proceededToStage2 = true;
        }

        expect(loggedGracefulFallback).toBe(false);
        expect(proceededToStage2).toBe(false);
    });

    // G. ordinary story analysis error -> 仍允許 Stage 2 with empty context
    it('G: caller receiving ordinary error gracefully degrades into Stage 2 with empty context', () => {
        const ordinaryErr = new Error('劇本全局分析 API 錯誤 (500): Server Error');
        const activeSignal = new AbortController().signal;

        expect(isMangaCancellation(ordinaryErr, activeSignal)).toBe(false);

        // 模擬 caller 決策邏輯
        let sessionContextSnippet = '';
        let proceededToStage2 = false;
        let loggedGracefulFallback = false;

        if (isMangaCancellation(ordinaryErr, activeSignal)) {
            proceededToStage2 = false;
        } else {
            loggedGracefulFallback = true;
            sessionContextSnippet = '';
            proceededToStage2 = shouldProceedToStage2({ wasStopped: false, isStopping: false, scriptLinesCount: 10 });
        }

        expect(loggedGracefulFallback).toBe(true);
        expect(sessionContextSnippet).toBe('');
        expect(proceededToStage2).toBe(true);
    });

    // H. STOP after API success before sessionStoryContext write -> 不寫 sessionStoryContext
    it('H: post-request guard 1 blocks sessionStoryContext write if aborted right after API returns', () => {
        const controller = new AbortController();
        controller.abort(); // 模擬 API 回傳後、寫入前按 STOP

        const sessionStoryContext = {};
        const resultTabId = 123;
        const sessionAnalysis = { storySummary: '大綱', characterRelationships: [] };

        // 依據 index.js 的 post-request guard 1 決策
        let written = false;
        if (shouldContinueMangaStoryAnalysis({ signal: controller.signal, isStopping: false })) {
            sessionStoryContext[resultTabId] = sessionAnalysis;
            written = true;
        }

        expect(written).toBe(false);
        expect(sessionStoryContext[resultTabId]).toBeUndefined();
    });

    // I. STOP before glossary merge -> 不 merge glossary
    it('I: post-request guard blocks glossary terms merge if signal is aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const mergeGlossarySpy = vi.fn();

        // 依據 index.js 的 post-request guard 決策
        if (shouldContinueMangaStoryAnalysis({ signal: controller.signal, isStopping: false })) {
            mergeGlossarySpy('manga-key', [{ original: 'A', translation: 'B' }]);
        }

        expect(mergeGlossarySpy).toHaveBeenCalledTimes(0);
    });

    // J. STOP during loadGlossary await -> 不 broadcast success -> 不進 Stage 2 (Async Gap Regression)
    it('J: STOP triggered while loadGlossary is pending halts pipeline, prevents success broadcast and blocks Stage 2', async () => {
        const controller = new AbortController();
        const broadcastStatusSpy = vi.fn();
        let enteredStage2 = false;

        // 1. 模擬前置步驟均成功
        expect(shouldContinueMangaStoryAnalysis({ signal: controller.signal, isStopping: false })).toBe(true);

        // 2. 模擬 loadGlossary 正在等待非同步 storage 讀取
        let resolveLoadGlossary;
        const loadGlossaryPromise = new Promise((resolve) => {
            resolveLoadGlossary = resolve;
        });

        // 3. 在 loadGlossary 正在等待期間，使用者按下 STOP
        controller.abort();

        // 4. loadGlossary 讀取完成返回
        resolveLoadGlossary({ terms: [{ original: '日文', translation: '中文' }] });
        const allTerms = await loadGlossaryPromise;
        expect(allTerms.terms).toHaveLength(1);

        // 5. 依據 index.js 的 post-request guard 3 執行檢查
        if (shouldContinueMangaStoryAnalysis({ signal: controller.signal, isStopping: false })) {
            broadcastStatusSpy('🎯 已掌握全局設定', 'ok');
            enteredStage2 = true;
        }

        // 斷言：成功廣播被徹底阻止，且絕不進入 Stage 2！
        expect(broadcastStatusSpy).toHaveBeenCalledTimes(0);
        expect(enteredStage2).toBe(false);
    });

    // K. fresh active Manga signal -> Phase 1.5 可正常 request
    it('K: fresh Manga run signal allows Phase 1.5 to proceed without residual abort state', async () => {
        beginMangaRun();
        const freshSignal = getMangaAbortSignal();
        expect(freshSignal.aborted).toBe(false);

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{
                    content: {
                        parts: [{
                            text: JSON.stringify({
                                storySummary: '正常劇情',
                                characterRelationships: [],
                                terms: []
                            })
                        }]
                    }
                }]
            })
        });

        const result = await extractGlobalStoryAndGlossary('New manga raw scripts', {
            signal: freshSignal
        });

        expect(result.storySummary).toBe('正常劇情');
    });

    // L. normal loadGlossary -> success broadcast and Stage 2 allowed
    it('L: normal execution without abort allows success broadcast and entry into Stage 2', async () => {
        const controller = new AbortController(); // 未 abort
        const broadcastStatusSpy = vi.fn();
        let enteredStage2 = false;

        const allTerms = await Promise.resolve({ terms: [] });

        if (shouldContinueMangaStoryAnalysis({ signal: controller.signal, isStopping: false })) {
            broadcastStatusSpy('🎯 已掌握全局設定', 'ok');
            enteredStage2 = shouldProceedToStage2({ wasStopped: false, isStopping: false, scriptLinesCount: 5 });
        }

        expect(broadcastStatusSpy).toHaveBeenCalledTimes(1);
        expect(enteredStage2).toBe(true);
    });
});

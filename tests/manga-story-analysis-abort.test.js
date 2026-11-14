import { describe, expect, it, vi } from 'vitest';
import * as TranslateApi from '../src/background/translate-api.js';
import * as MangaLifecycle from '../src/background/manga-lifecycle.js';

describe('V3.2.2 一階段架構收斂與劇本預讀退役符號清理驗證', () => {
    it('已退役的兩階段劇本分析與階段守衛符號不再匯出', () => {
        expect(TranslateApi.extractGlobalStoryAndGlossary).toBeUndefined();
        expect(MangaLifecycle.executeOcrFallbackImages).toBeUndefined();
        expect(MangaLifecycle.shouldFallbackAfterOcrError).toBeUndefined();
        expect(MangaLifecycle.shouldContinueMangaStoryAnalysis).toBeUndefined();
        expect(MangaLifecycle.shouldProceedToStage15).toBeUndefined();
        expect(MangaLifecycle.shouldProceedToStage2).toBeUndefined();
    });

    it('現役漫畫生命週期函式正常匯出且行為正確', async () => {
        expect(typeof MangaLifecycle.executeFallbackImages).toBe('function');
        expect(typeof MangaLifecycle.isMangaCancellation).toBe('function');
        expect(typeof MangaLifecycle.shouldCompleteMangaTranslation).toBe('function');
        expect(typeof MangaLifecycle.shouldPublishMangaBatchResults).toBe('function');

        // 驗證 isMangaCancellation 判斷邏輯
        const controller = new AbortController();
        expect(MangaLifecycle.isMangaCancellation(new Error('HTTP 500'), controller.signal)).toBe(false);
        expect(MangaLifecycle.isMangaCancellation({ isCancelled: true }, controller.signal)).toBe(true);
        controller.abort();
        expect(MangaLifecycle.isMangaCancellation(new Error('HTTP 500'), controller.signal)).toBe(true);

        // 驗證完成與發布守衛
        expect(MangaLifecycle.shouldCompleteMangaTranslation({ wasStopped: false, wasAborted: false, isStopping: false })).toBe(true);
        expect(MangaLifecycle.shouldCompleteMangaTranslation({ wasStopped: true, wasAborted: false, isStopping: false })).toBe(false);
        expect(MangaLifecycle.shouldPublishMangaBatchResults({ wasStopped: false, wasAborted: false })).toBe(true);
        expect(MangaLifecycle.shouldPublishMangaBatchResults({ wasStopped: true, wasAborted: false })).toBe(false);

        // 驗證逐張備援翻譯正常執行與 STOP 中斷
        const translateSingle = vi.fn().mockResolvedValue({ results: [{ original: 'あ', translation: '啊' }] });
        const result = await MangaLifecycle.executeFallbackImages({
            validItems: [{ b64: 'img1', originalIdx: 0 }],
            fallbackModelName: 'gemini-2.5-flash',
            getNextApiKey: async () => 'test-key',
            translateSingle,
            shouldContinue: async () => true
        });
        expect(result.wasStopped).toBe(false);
        expect(translateSingle).toHaveBeenCalledTimes(1);
        expect(result.fallbackResults[0].usedModelName).toBe('gemini-2.5-flash');
    });
});

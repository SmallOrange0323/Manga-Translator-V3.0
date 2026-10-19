import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convertCnToTwLocal } from '../src/utils/zh-tw-localizer.js';
import { createMangaImageReceiver } from '../src/utils/manga-image-messages.js';
import {
    DEFAULT_PROMPT_ONE_STEP,
    DEFAULT_PROMPT_TWO_STEP,
    LEGACY_DEFAULT_PROMPT_ONE_STEP,
    SYSTEM_BATCH_RULES,
    computeMangaTargetDimensions,
    resolveMangaOneStepPrompt
} from '../src/utils/constants.js';
import { callGeminiAPIBatch } from '../src/background/translate-api.js';
import { createMangaRecovery } from '../src/background/manga-recovery.js';

describe('V3.2.0 台灣正體中文與慣用語在地化引擎 (zh-tw-localizer)', () => {
    it('能將常見簡體字與大陸用語精準轉換為台灣繁體中文與慣用語', () => {
        const input = '前辈，这个视频的画质太差了，简直让人无法理解！为什么你会这么说？';
        const output = convertCnToTwLocal(input);
        expect(output).toBe('前輩，這個影片的畫質太差了，簡直讓人無法理解！為什麼你會這麼說？');
    });

    it('一簡對多繁保護：能正確區分「後/后」、「發/髮」、「裡/里」、「乾/幹」且不誤傷正體字', () => {
        expect(convertCnToTwLocal('太后与皇后坐在后面等以后再说')).toBe('太后與皇后坐在後面等以後再說');
        expect(convertCnToTwLocal('她的头发在出发前剪短了')).toBe('她的頭髮在出發前剪短了');
        expect(convertCnToTwLocal('房间里面看得到五公里外的故里')).toBe('房間裡面看得到五公里外的故里');
        expect(convertCnToTwLocal('把衣服擦干净，你到底想干嘛？')).toBe('把衣服擦乾淨，你到底想幹嘛？');
    });
});

describe('V3.2.0 漫畫直向縮圖尺寸計算與 Prompt 自動升級 (constants)', () => {
    it('直向與橫向雙頁漫畫均以短邊為基準縮放，避免長邊壓縮導致小字與跨頁文字模糊', () => {
        // 典型直向漫畫 1200 x 1800，maxDim = 1024 -> 寬度 1024, 高度 1536
        const portrait = computeMangaTargetDimensions(1200, 1800, 1024);
        expect(portrait).toEqual({ width: 1024, height: 1536 });

        // 超長條漫 1200 x 5000，長邊會受到 maxDim * 2.2 (2253) 上限保護
        const webtoon = computeMangaTargetDimensions(1200, 5000, 1024);
        expect(webtoon.height).toBe(2253);
        expect(webtoon.width).toBe(541);

        // 橫向雙頁跨頁 2400 x 1800，以短邊（高度 1024）為基準，保留雙頁寬度 1365
        const spread = computeMangaTargetDimensions(2400, 1800, 1024);
        expect(spread).toEqual({ width: 1365, height: 1024 });
    });

    it('resolveMangaOneStepPrompt 能將舊版預設 Prompt 自動升級為 V3.2.0 新版，同時保留使用者自訂 Prompt', () => {
        expect(resolveMangaOneStepPrompt('', 'gemini-2.5-flash')).toBe(DEFAULT_PROMPT_ONE_STEP);
        expect(resolveMangaOneStepPrompt(LEGACY_DEFAULT_PROMPT_ONE_STEP, 'gemini-2.5-flash')).toBe(DEFAULT_PROMPT_ONE_STEP);
        const custom = '請用搞笑風格翻譯這本漫畫';
        expect(resolveMangaOneStepPrompt(custom, 'gemini-2.5-flash')).toBe(custom);
    });

    it('100% 遵守 R18 破甲防禦規範：宣告 consenting adult characters、移除 and age，且包含職場稱謂與禁假名規則', () => {
        expect(DEFAULT_PROMPT_ONE_STEP).toContain('consenting adult characters');
        expect(DEFAULT_PROMPT_ONE_STEP).not.toContain('and age');
        expect(DEFAULT_PROMPT_ONE_STEP).toContain('先輩 (Senpai) / 後輩 (Kouhai)');
        expect(DEFAULT_PROMPT_ONE_STEP).toContain('～さん');
        expect(DEFAULT_PROMPT_ONE_STEP).toContain('NO JAPANESE KANA LEAKAGE');
        expect(DEFAULT_PROMPT_TWO_STEP).toContain('先輩/後輩');
        expect(SYSTEM_BATCH_RULES).toContain('先輩/後輩');
    });
});

describe('V3.2.0 批次 API 穩定度、temperature 0.3、跨批上下文與 JSON 錯誤拋出重試 (translate-api)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        globalThis.chrome = {
            storage: {
                local: {
                    get: vi.fn((_keys, cb) => {
                        if (typeof cb === 'function') cb({});
                        return Promise.resolve({});
                    }),
                    set: vi.fn((_val, cb) => {
                        if (typeof cb === 'function') cb();
                        return Promise.resolve();
                    })
                },
                onChanged: { addListener: vi.fn() }
            },
            runtime: {
                sendMessage: vi.fn(() => Promise.resolve())
            }
        };
    });

    it('callGeminiAPIBatch 會傳入 temperature: 0.3 與 <previous_dialogue_reference>，並將簡體譯文轉為台灣正體', async () => {
        let capturedBody = null;
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        finishReason: 'STOP',
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    pages: [
                                        { pageIndex: 0, results: [{ original: '先輩、ありがとう', translation: '前辈，谢谢你' }] }
                                    ]
                                })
                            }]
                        }
                    }]
                })
            };
        }));

        const res = await callGeminiAPIBatch(
            ['AAAA'],
            DEFAULT_PROMPT_ONE_STEP,
            '詞彙A -> 詞彙B',
            'TEST_KEY',
            'gemini-2.5-flash',
            null,
            '佐藤 -> 好的，前輩'
        );

        expect(capturedBody.generationConfig.temperature).toBe(0.3);
        const sysPromptText = capturedBody.system_instruction.parts[0].text;
        expect(sysPromptText).toContain('<previous_dialogue_reference>');
        expect(sysPromptText).toContain('佐藤 -> 好的，前輩');
        expect(res[0].results[0].translation).toBe('前輩，謝謝你');
    });

    it('當模型回傳損毀的 JSON 時，callGeminiAPIBatch 會拋出 Error 以觸發外層切換 Key 或降級單張重試', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{
                    finishReason: 'STOP',
                    content: {
                        parts: [{ text: '這不是合法的 JSON 輸出 {{{' }]
                    }
                }]
            })
        })));

        await expect(callGeminiAPIBatch(
            ['AAAA'],
            DEFAULT_PROMPT_ONE_STEP,
            '',
            'TEST_KEY',
            'gemini-2.5-flash'
        )).rejects.toThrow(/批次 JSON 解析失敗/);
    });
});

describe('V3.2.0 暫存圖片 (Canvas / data:image) 跨批次記憶體快取保活 (manga-recovery)', () => {
    it('在同一次 Service Worker 生命週期內，data:image 跨批次 commit 與 snapshot 仍可保持顯示，且不會寫入 storage.local', async () => {
        const storageData = {};
        const publishedSnapshots = [];
        const publishedImages = new Map();
        const receive = createMangaImageReceiver(() => publishedSnapshots.at(-1), (index, image) => publishedImages.set(index, image));
        const mockChrome = {
            extension: { inIncognitoContext: false },
            runtime: { getURL: p => 'chrome-extension://test/' + p },
            storage: {
                local: {
                    get: vi.fn(async k => structuredClone({ [k]: storageData[k] })),
                    set: vi.fn(async v => { Object.assign(storageData, structuredClone(v)); })
                }
            },
            tabs: {
                query: vi.fn(async () => []),
                get: vi.fn(async id => ({ id, url: 'https://manga.test/ch1', incognito: false })),
                sendMessage: vi.fn(async (_tabId, msg) => {
                    if (msg.action === 'mangaSnapshot') publishedSnapshots.push(msg.job);
                    else if (msg.action === 'mangaImageChunk') receive(msg);
                })
            }
        };

        const recovery = createMangaRecovery(mockChrome);
        const dataImg1 = 'data:image/jpeg;base64,PAGE1_BYTES';
        const dataImg2 = 'data:image/jpeg;base64,PAGE2_BYTES';

        const job = await recovery.begin({
            sourceTabId: 1,
            resultTabId: 2,
            images: [dataImg1, dataImg2],
            batchSize: 1
        });

        await recovery.commit(job, 1, [{
            image: dataImg1,
            pageIndex: 1,
            batchIndex: 0,
            results: [{ original: '1', translation: '一' }]
        }]);

        await recovery.commit(job, 2, [{
            image: dataImg2,
            pageIndex: 2,
            batchIndex: 1,
            results: [{ original: '2', translation: '二' }]
        }]);

        const latestSnapshot = await recovery.snapshot(2);
        expect(latestSnapshot.results[0].image).toBe(dataImg1);
        expect(latestSnapshot.results[1].image).toBe(dataImg2);
        expect(publishedSnapshots.at(-1).results.map(row => row.image)).toEqual(['', '']);
        expect(publishedImages.get(1)).toBe(dataImg1);
        expect(publishedImages.get(2)).toBe(dataImg2);

        // 確認 storage.local 絕對不包含暫存圖片 bytes
        expect(JSON.stringify(storageData)).not.toContain('PAGE1_BYTES');
        expect(JSON.stringify(storageData)).not.toContain('PAGE2_BYTES');
    });
});

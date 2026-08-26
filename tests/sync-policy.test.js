import { beforeEach, describe, expect, it, vi } from 'vitest';
const assert = {
    equal: (actual, expected) => expect(actual).toBe(expected),
    deepEqual: (actual, expected) => expect(actual).toEqual(expected)
};

import {
    SYNCABLE_SETTING_KEYS,
    normalizeApiKeyPool,
    sanitizeSyncableSettings,
    resolveApiKeySync,
    saveApiKeyPoolIfChanged
} from '../src/utils/sync-policy.js';

describe('Google Drive Sync Policy & API Key Conflict Isolation Tests', () => {

    describe('Test 1: 雙軌時間戳隔離 — General Settings 變新絕不踩踏 API Key', () => {
        it('當手機端僅修改 requestDelay (settingsLastModified 變新)，API Key 仍以獨立時間戳判定，絕不覆蓋桌面端較新的 API Key', () => {
            // 情境：桌面端已設定最新 KEY_A (apiKeyLastModified = 200)
            // 手機端持有舊 KEY_B (apiKeyLastModified = 100)，但剛剛修改了 requestDelay (settingsLastModified = 300)
            const result = resolveApiKeySync({
                localApiKey: 'KEY_A',
                localApiKeyLastModified: 200,
                localSettingsLastModified: 150,

                cloudApiKey: 'KEY_B',
                cloudApiKeyLastModified: 100,
                cloudSettingsLastModified: 300 // 雲端一般設定時間戳雖然較新，但不能綁架 API Key
            });

            // 斷言：判定本地 KEY_A 獲勝，絕不被 KEY_B 覆蓋
            assert.equal(result.resolvedApiKey, 'KEY_A');
            assert.equal(result.resolvedTimestamp, 200);
            assert.equal(result.source, 'local');
            assert.equal(result.shouldWriteLocal, false);
            assert.equal(result.shouldUploadCloud, true);
        });
    });

    describe('Test 2: Cloud API Key 較新時正確更新 Local', () => {
        it('當 Cloud apiKeyLastModified > local 時，本地 API Key 被安全更新', () => {
            const result = resolveApiKeySync({
                localApiKey: 'OLD_LOCAL_KEY',
                localApiKeyLastModified: 100,

                cloudApiKey: 'NEW_CLOUD_KEY',
                cloudApiKeyLastModified: 200
            });

            assert.equal(result.resolvedApiKey, 'NEW_CLOUD_KEY');
            assert.equal(result.resolvedTimestamp, 200);
            assert.equal(result.source, 'cloud');
            assert.equal(result.shouldWriteLocal, true);
            assert.equal(result.shouldUploadCloud, false);
        });
    });

    describe('Test 3: Local API Key 較新時準備上傳 Cloud', () => {
        it('當 local apiKeyLastModified > cloud 時，本地 API Key 保留並標記上傳', () => {
            const result = resolveApiKeySync({
                localApiKey: 'NEW_LOCAL_KEY',
                localApiKeyLastModified: 300,

                cloudApiKey: 'OLD_CLOUD_KEY',
                cloudApiKeyLastModified: 200
            });

            assert.equal(result.resolvedApiKey, 'NEW_LOCAL_KEY');
            assert.equal(result.resolvedTimestamp, 300);
            assert.equal(result.source, 'local');
            assert.equal(result.shouldWriteLocal, false);
            assert.equal(result.shouldUploadCloud, true);
        });
    });

    describe('Test 4: 雲端刪除 API Key (Intentional Deletion)', () => {
        it('當雲端 apiKey 為空字串且時間戳較新時，本地 API Key 正確被清空', () => {
            const result = resolveApiKeySync({
                localApiKey: 'EXISTING_KEY',
                localApiKeyLastModified: 100,

                cloudApiKey: '',
                cloudApiKeyLastModified: 200
            });

            assert.equal(result.resolvedApiKey, '');
            assert.equal(result.resolvedTimestamp, 200);
            assert.equal(result.source, 'cloud');
            assert.equal(result.shouldWriteLocal, true);
        });
    });

    describe('Test 5: 本地刪除 API Key (Local Intentional Deletion)', () => {
        it('當本地 apiKey 刪除為空字串且時間戳較新時，保留空字串並標記上傳至雲端', () => {
            const result = resolveApiKeySync({
                localApiKey: '',
                localApiKeyLastModified: 200,

                cloudApiKey: 'OLD_CLOUD_KEY',
                cloudApiKeyLastModified: 100
            });

            assert.equal(result.resolvedApiKey, '');
            assert.equal(result.resolvedTimestamp, 200);
            assert.equal(result.source, 'local');
            assert.equal(result.shouldUploadCloud, true);
        });
    });

    describe('Test 6: Old Cloud Schema 舊版向後相容 Migration', () => {
        it('舊版雲端僅有 settings.apiKey 與 settingsLastModified 時，能平滑提取為 legacy 候選', () => {
            const result = resolveApiKeySync({
                localApiKey: 'LOCAL_KEY',
                localApiKeyLastModified: 100,

                cloudApiKey: undefined,
                cloudApiKeyLastModified: undefined,
                cloudSettingsLastModified: 200,
                legacyCloudSettingsApiKey: 'LEGACY_CLOUD_KEY'
            });

            assert.equal(result.resolvedApiKey, 'LEGACY_CLOUD_KEY');
            assert.equal(result.resolvedTimestamp, 200);
            assert.equal(result.source, 'cloud');
            assert.equal(result.shouldWriteLocal, true);
        });
    });

    describe('Test 7: Old Local Schema 舊版向後相容 Migration', () => {
        it('舊版本機未設定 apiKeyLastModified 時，安全 fallback 使用 settingsLastModified 作為初始時間戳', () => {
            const result = resolveApiKeySync({
                localApiKey: 'LOCAL_LEGACY_KEY',
                localApiKeyLastModified: 0,
                localSettingsLastModified: 300,

                cloudApiKey: 'CLOUD_KEY',
                cloudApiKeyLastModified: 200
            });

            assert.equal(result.resolvedApiKey, 'LOCAL_LEGACY_KEY');
            assert.equal(result.resolvedTimestamp, 300);
            assert.equal(result.source, 'local');
            assert.equal(result.shouldUploadCloud, true);
        });
    });

    describe('Test 8: General Settings Whitelist 嚴格過濾 — settings 絕不包含 apiKey', () => {
        it('sanitizeSyncableSettings 僅保留白名單設定，徹底過濾 apiKey、未知機密與 runtime 狀態', () => {
            const raw = {
                apiKey: 'SECRET_KEY',
                translationMode: 'one-step',
                modelName: 'gemini-3.1-flash-lite',
                hybridModeEnabled: true,
                secondaryModelName: 'gemini-3.5-flash-lite',
                autoPretranslateNextChapter: true,
                isStopping: true,
                isBatchPaused: false,
                novelQueue: [1, 2, 3],
                randomUnknownSecret: 'SECRET_DATA'
            };

            const sanitized = sanitizeSyncableSettings(raw);

            // 斷言：一般設定保留
            assert.equal(sanitized.translationMode, 'one-step');
            assert.equal(sanitized.modelName, 'gemini-3.1-flash-lite');
            assert.equal(sanitized.hybridModeEnabled, true);
            assert.equal(sanitized.secondaryModelName, 'gemini-3.5-flash-lite');
            assert.equal(sanitized.autoPretranslateNextChapter, true);

            // 斷言：apiKey 與 runtime 狀態被徹底過濾
            expect(sanitized).not.toHaveProperty('apiKey');
            expect(sanitized).not.toHaveProperty('isStopping');
            expect(sanitized).not.toHaveProperty('isBatchPaused');
            expect(sanitized).not.toHaveProperty('novelQueue');
            expect(sanitized).not.toHaveProperty('randomUnknownSecret');
        });
    });

    describe('Test 9: Malformed Cloud API Key 安全防禦', () => {
        it('當雲端 apiKey 為 null/object/數值等異常型態時，絕不破壞或清空合法本機 Key Pool', () => {
            const invalidCloudPayloads = [null, { key: '123' }, [1, 2, 3], 12345, true];

            for (const malformed of invalidCloudPayloads) {
                const result = resolveApiKeySync({
                    localApiKey: 'VALID_LOCAL_KEY',
                    localApiKeyLastModified: 100,

                    cloudApiKey: malformed,
                    cloudApiKeyLastModified: 999 // 即使時間戳標記為最新
                });

                assert.equal(result.resolvedApiKey, 'VALID_LOCAL_KEY');
                assert.equal(result.source, 'local');
                assert.equal(result.shouldWriteLocal, false);
                assert.equal(result.shouldUploadCloud, true);
            }
        });
    });

    describe('Test 10: 多組 Newline Key Pool 完整性與格式保全', () => {
        it('多行金鑰在正規化與衝突消解中保持完整順序與內容', () => {
            const multiKey = 'KEY_1\nKEY_2\nKEY_3';
            const normalized = normalizeApiKeyPool('  KEY_1  \n\n  KEY_2\nKEY_3  \n');

            assert.equal(normalized, multiKey);

            const result = resolveApiKeySync({
                localApiKey: 'OLD_KEY',
                localApiKeyLastModified: 100,

                cloudApiKey: normalized,
                cloudApiKeyLastModified: 200
            });

            assert.equal(result.resolvedApiKey, multiKey);
            assert.equal(result.resolvedApiKey.split('\n').length, 3);
        });
    });

    describe('Test 11: Normalization 邊界測試 (Whitespace & Empty Lines)', () => {
        it('僅有空格與空行的差異不會被視為實質內容變更', () => {
            const rawA = 'KEY_A\nKEY_B';
            const rawB = '  KEY_A  \n\n  KEY_B \n ';

            assert.equal(normalizeApiKeyPool(rawA), normalizeApiKeyPool(rawB));
        });
    });

    describe('Test 12: Empty String 合法 Intentional Deletion', () => {
        it('normalizeApiKeyPool 對空字串回傳 "" 而非 null，視為合法空值', () => {
            assert.equal(normalizeApiKeyPool(''), '');
            assert.equal(normalizeApiKeyPool('   \n  \n '), '');
            assert.equal(normalizeApiKeyPool(null), null);
            assert.equal(normalizeApiKeyPool(undefined), null);
        });
    });

    describe('Test 13: Equal Timestamp + Same Key (No-op)', () => {
        it('時間戳相等且金鑰內容相同時，不觸發任何多餘寫入或上傳', () => {
            const result = resolveApiKeySync({
                localApiKey: 'SAME_KEY',
                localApiKeyLastModified: 200,

                cloudApiKey: 'SAME_KEY',
                cloudApiKeyLastModified: 200
            });

            assert.equal(result.resolvedApiKey, 'SAME_KEY');
            assert.equal(result.shouldWriteLocal, false);
            assert.equal(result.shouldUploadCloud, false);
        });
    });

    describe('Test 14: Equal Timestamp + Different Key (Deterministic Cloud Win)', () => {
        it('時間戳相等但內容相異時，採確定性規則以合法 Cloud 為準，避免雙端震盪', () => {
            const result = resolveApiKeySync({
                localApiKey: 'LOCAL_TIE_KEY',
                localApiKeyLastModified: 200,

                cloudApiKey: 'CLOUD_TIE_KEY',
                cloudApiKeyLastModified: 200
            });

            assert.equal(result.resolvedApiKey, 'CLOUD_TIE_KEY');
            assert.equal(result.source, 'cloud');
            assert.equal(result.shouldWriteLocal, true);
            assert.equal(result.shouldUploadCloud, false);
        });
    });

    describe('Test 15: Options 頁面儲存行為防護 (saveApiKeyPoolIfChanged)', () => {
        it('使用者僅修改 requestDelay 並按儲存時，apiKey 與 apiKeyLastModified 保持不變', async () => {
            let mockStorage = {
                apiKey: 'KEY_A\nKEY_B',
                apiKeyLastModified: 1000
            };

            const mockStateManager = {
                get: vi.fn(async (key, defaultVal) => mockStorage[key] ?? defaultVal),
                set: vi.fn(async (key, val) => { mockStorage[key] = val; })
            };

            // 模擬 Options 頁面一般儲存：傳入未變更的 API Keys
            const updated = await saveApiKeyPoolIfChanged('KEY_A\nKEY_B', mockStateManager);

            assert.equal(updated, false);
            assert.equal(mockStorage.apiKeyLastModified, 1000);
            expect(mockStateManager.set).not.toHaveBeenCalled();
        });

        it('使用者真正修改了 API Key (新增 KEY_C) 時，正確更新 apiKey 與 apiKeyLastModified', async () => {
            let mockStorage = {
                apiKey: 'KEY_A\nKEY_B',
                apiKeyLastModified: 1000
            };

            const mockStateManager = {
                get: vi.fn(async (key, defaultVal) => mockStorage[key] ?? defaultVal),
                set: vi.fn(async (key, val) => { mockStorage[key] = val; })
            };

            const updated = await saveApiKeyPoolIfChanged('KEY_A\nKEY_B\nKEY_C', mockStateManager);

            assert.equal(updated, true);
            assert.equal(mockStorage.apiKey, 'KEY_A\nKEY_B\nKEY_C');
            expect(mockStorage.apiKeyLastModified).toBeGreaterThan(1000);
            expect(mockStateManager.set).toHaveBeenCalledWith('apiKey', 'KEY_A\nKEY_B\nKEY_C');
            expect(mockStateManager.set).toHaveBeenCalledWith('apiKeyLastModified', expect.any(Number));
        });
    });
});

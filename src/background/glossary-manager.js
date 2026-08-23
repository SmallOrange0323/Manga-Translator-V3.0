import { state } from '../utils/state.js';
import { log } from '../utils/logger.js';

/**
 * GlossaryManager: 作品專屬詞彙對照表系統
 * 移植自 V1.8.6 的實戰邏輯，適配 V3.0 模組化架構。
 * 
 * 設計守則：
 * 1. 只增不覆寫：AI 萃取的詞彙只能新增不存在的原文，不可覆蓋現有條目。
 * 2. 使用者權威：source: "user" 的條目永久鎖定。
 * 3. 500 詞限制：防止 storage 溢出。
 */

export const GLOSSARY_STORAGE_KEY = 'mangaGlossaries';
export const GLOSSARY_MAX_TERMS = 500;

/**
 * 作品 Key 歸一化：轉小寫、去除多餘標點符號與多餘空白
 * 例如 "KAMIGAMI NO KAGO..." 與 "Kamigami No Kago..." 歸一化後皆為 "kamigami no kago"
 */
export function normalizeMangaKey(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .toLowerCase()
        .replace(/[\-_:!?'"()（）\[\]【】／/\\.,~～]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 智慧查找既有詞庫 Key (精確匹配 ➔ 歸一化匹配 ➔ 前綴包含匹配)
 */
export function findExistingGlossaryKey(allGlossaries, mangaKey) {
    if (!mangaKey || !allGlossaries) return null;
    if (allGlossaries[mangaKey]) return mangaKey;

    const targetNorm = normalizeMangaKey(mangaKey);
    if (!targetNorm) return null;

    const keys = Object.keys(allGlossaries);

    // 1. 歸一化完全匹配 (忽略大小寫、標點與多餘空格)
    for (const key of keys) {
        if (normalizeMangaKey(key) === targetNorm) {
            return key;
        }
    }

    // 2. 前綴包含匹配 (例如 "Kamigami no Kago de Seisan Kakumei" 與 "Kamigami no Kago de Seisan Kakumei 15")
    for (const key of keys) {
        const keyNorm = normalizeMangaKey(key);
        if (keyNorm.length >= 8 && targetNorm.length >= 8) {
            if (keyNorm.startsWith(targetNorm) || targetNorm.startsWith(keyNorm)) {
                return key;
            }
        }
    }

    return null;
}

/**
 * 自動合併歷史累積的重複大小寫詞庫 (Auto Deduplicate & Merge)
 */
export function deduplicateGlossaries(allGlossaries) {
    if (!allGlossaries || typeof allGlossaries !== 'object') return {};
    const deduplicated = {};
    const normMap = new Map(); // normKey -> canonicalKey

    for (const [key, entry] of Object.entries(allGlossaries)) {
        if (!entry) continue;
        const normKey = normalizeMangaKey(key);
        if (!normKey) continue;

        if (!normMap.has(normKey)) {
            // 新的分組：選定當前 key 作為代表
            normMap.set(normKey, key);
            deduplicated[key] = {
                displayName: entry.displayName || key,
                rawJapanese: entry.rawJapanese || null,
                romanKey: entry.romanKey || key,
                terms: Array.isArray(entry.terms) ? [...entry.terms] : [],
                lastUsed: entry.lastUsed || Date.now()
            };
        } else {
            // 已存在相同作品：進行條目深度合併與去重
            const canonicalKey = normMap.get(normKey);
            const target = deduplicated[canonicalKey];
            
            // 優先挑選首字母大寫或包含日文的漂亮名稱
            if (entry.displayName && (!target.displayName || entry.displayName.length > target.displayName.length)) {
                target.displayName = entry.displayName;
            }
            if (entry.rawJapanese && !target.rawJapanese) {
                target.rawJapanese = entry.rawJapanese;
            }

            // 合併詞彙條目 (保留使用者手動詞彙)
            const { terms: mergedTerms } = mergeGlossaryTerms(target.terms, entry.terms || []);
            target.terms = mergedTerms;
            target.lastUsed = Math.max(target.lastUsed || 0, entry.lastUsed || 0);
        }
    }

    return deduplicated;
}

/**
 * 讀取指定作品的詞庫 (支援大小寫不敏感歸一化比對)
 * @param {string} mangaKey 
 * @returns {Promise<Object|null>}
 */
export async function loadGlossary(mangaKey) {
    if (!mangaKey) return null;
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        let all = data[GLOSSARY_STORAGE_KEY] || {};

        const matchedKey = findExistingGlossaryKey(all, mangaKey);
        if (matchedKey && all[matchedKey]) {
            return all[matchedKey];
        }
        return null;
    } catch (e) {
        log.warn('Glossary', `讀取失敗: ${e.message}`);
        return null;
    }
}

/**
 * 儲存詞庫 (自動匹配既有同名作品進行覆蓋合併，絕不產生大小寫重複項)
 * @param {string} mangaKey 
 * @param {Object} glossaryEntry 
 */
export async function saveGlossary(mangaKey, glossaryEntry) {
    if (!mangaKey || !glossaryEntry) return;
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        let all = data[GLOSSARY_STORAGE_KEY] || {};

        // 自動執行全局去重合併
        all = deduplicateGlossaries(all);

        // 智慧尋找既有 Key
        const targetKey = findExistingGlossaryKey(all, mangaKey) || mangaKey;

        // 執行 500 詞上限修剪
        let terms = glossaryEntry.terms || [];
        if (terms.length > GLOSSARY_MAX_TERMS) {
            const userTerms = terms.filter(t => t.source === 'user');
            const aiTerms = terms.filter(t => t.source === 'ai');
            const remainingSlots = GLOSSARY_MAX_TERMS - userTerms.length;
            const trimmedAi = remainingSlots > 0 ? aiTerms.slice(-remainingSlots) : [];
            terms = [...userTerms, ...trimmedAi];
            log.info('Glossary', `詞庫已修剪至 ${terms.length} 詞 (保留全部使用者條目)`);
        }

        const oldEntry = all[targetKey] || {};
        all[targetKey] = {
            displayName: glossaryEntry.displayName || oldEntry.displayName || targetKey,
            rawJapanese: glossaryEntry.rawJapanese || oldEntry.rawJapanese || null,
            romanKey: glossaryEntry.romanKey || oldEntry.romanKey || targetKey,
            terms,
            lastUsed: Date.now()
        };

        // 若本次使用的 targetKey 與傳入的不同，清理舊的不同格式 key
        if (targetKey !== mangaKey && all[mangaKey]) {
            delete all[mangaKey];
        }

        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已儲存作品 "${targetKey}" 詞庫，共 ${terms.length} 詞`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey: targetKey, termCount: terms.length } 
        }).catch(() => {});

    } catch (e) {
        log.warn('Glossary', `儲存失敗: ${e.message}`);
    }
}

/**
 * 整併 AI 萃取的新術語
 */
export function mergeGlossaryTerms(existingTerms, newTerms) {
    const safeExisting = Array.isArray(existingTerms) ? existingTerms : [];
    if (!Array.isArray(newTerms) || newTerms.length === 0) {
        return { terms: safeExisting, addedCount: 0 };
    }

    const existingOriSet = new Set(
        safeExisting.map(t => (t?.ori || t?.original || '').toLowerCase().trim()).filter(Boolean)
    );
    let addedCount = 0;
    const merged = [...safeExisting];

    for (const newTerm of newTerms) {
        if (!newTerm) continue;
        const ori = (newTerm.ori || newTerm.original || '').trim();
        const trans = (newTerm.trans || newTerm.translation || '').trim();
        if (!ori || !trans) continue;

        const oriKey = ori.toLowerCase();
        if (existingOriSet.has(oriKey)) continue;

        merged.push({
            ori: ori,
            trans: trans,
            source: newTerm.source || 'ai'
        });
        existingOriSet.add(oriKey);
        addedCount++;
    }

    if (addedCount > 0) {
        log.info('Glossary', `詞庫整併完成，新增了 ${addedCount} 個術語`);
    }

    return { terms: merged, addedCount };
}

/**
 * 刪除指定作品詞庫中的某個詞條
 * @param {string} mangaKey 
 * @param {string} oriText 
 */
export async function deleteGlossaryTerm(mangaKey, oriText) {
    if (!mangaKey || !oriText) return { success: false };
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        const targetKey = findExistingGlossaryKey(all, mangaKey) || mangaKey;
        const entry = all[targetKey];
        
        if (!entry || !entry.terms) return { success: false, message: '找不到該作品的詞庫' };
        
        const originalLength = entry.terms.length;
        entry.terms = entry.terms.filter(t => t.ori.toLowerCase().trim() !== oriText.toLowerCase().trim());
        
        if (entry.terms.length === originalLength) {
            return { success: false, message: '未找到該詞條' };
        }
        
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已從 "${targetKey}" 刪除詞條: ${oriText}`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey: targetKey, termCount: entry.terms.length } 
        }).catch(() => {});
        
        return { success: true, termCount: entry.terms.length };
    } catch (e) {
        log.warn('Glossary', `刪除詞條失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 批次刪除指定作品詞庫中的多個詞條
 * @param {string} mangaKey 
 * @param {Array} oriTexts 
 */
export async function deleteMultipleGlossaryTerms(mangaKey, oriTexts) {
    if (!mangaKey || !Array.isArray(oriTexts) || oriTexts.length === 0) return { success: false, message: '參數錯誤' };
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        const targetKey = findExistingGlossaryKey(all, mangaKey) || mangaKey;
        const entry = all[targetKey];
        
        if (!entry || !entry.terms) return { success: false, message: '找不到該作品的詞庫' };
        
        const originalLength = entry.terms.length;
        const deleteSet = new Set(oriTexts.map(t => t.toLowerCase().trim()));
        
        entry.terms = entry.terms.filter(t => !deleteSet.has(t.ori.toLowerCase().trim()));
        
        const deletedCount = originalLength - entry.terms.length;
        
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已從 "${targetKey}" 批次刪除 ${deletedCount} 筆詞條`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey: targetKey, termCount: entry.terms.length } 
        }).catch(() => {});
        
        return { success: true, deletedCount, termCount: entry.terms.length };
    } catch (e) {
        log.warn('Glossary', `批次刪除詞條失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 刪除整個作品的詞庫
 * @param {string} mangaKey 
 */
export async function deleteGlossary(mangaKey) {
    if (!mangaKey) return { success: false };
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        const targetKey = findExistingGlossaryKey(all, mangaKey) || mangaKey;
        
        if (!all[targetKey]) return { success: false, message: '找不到該作品的詞庫' };
        
        delete all[targetKey];
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已刪除作品 "${targetKey}" 的完整詞庫`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey: targetKey, deleted: true } 
        }).catch(() => {});
        
        return { success: true };
    } catch (e) {
        log.warn('Glossary', `刪除詞庫失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 更新作品詞庫的顯示名稱 (DisplayName)
 * @param {string} mangaKey 
 * @param {string} newDisplayName 
 */
export async function updateGlossaryDisplayName(mangaKey, newDisplayName) {
    if (!mangaKey || !newDisplayName) return { success: false };
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        const targetKey = findExistingGlossaryKey(all, mangaKey) || mangaKey;
        
        if (!all[targetKey]) return { success: false, message: '找不到該作品的詞庫' };
        
        all[targetKey].displayName = newDisplayName.trim();
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已更新 "${targetKey}" 的顯示名稱為: ${newDisplayName}`);
        return { success: true };
    } catch (e) {
        log.warn('Glossary', `更新名稱失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 匯入外部術語到指定作品
 * @param {string} mangaKey 
 * @param {Array<{ori: string, trans: string}>} terms 
 */
export async function importGlossaryTerms(mangaKey, terms) {
    if (!mangaKey || !Array.isArray(terms)) return { success: false, error: '參數錯誤' };
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        let all = data[GLOSSARY_STORAGE_KEY] || {};
        all = deduplicateGlossaries(all);
        const targetKey = findExistingGlossaryKey(all, mangaKey) || mangaKey;
        
        const entry = all[targetKey] || {
            displayName: targetKey,
            terms: [],
            lastUsed: Date.now()
        };

        const existingTerms = entry.terms || [];
        const existingMap = new Map();
        existingTerms.forEach(t => existingMap.set(t.ori.toLowerCase().trim(), t));

        let addedCount = 0;
        for (const item of terms) {
            if (!item.ori || !item.trans) continue;
            const oriKey = item.ori.toLowerCase().trim();
            if (existingMap.has(oriKey)) {
                // 若已存在但為 AI 產生的，使用者匯入可升級為 user 權威
                const exist = existingMap.get(oriKey);
                if (exist.source === 'ai') {
                    exist.trans = item.trans.trim();
                    exist.source = 'user';
                }
            } else {
                existingTerms.push({
                    ori: item.ori.trim(),
                    trans: item.trans.trim(),
                    source: 'user',
                    createdAt: Date.now()
                });
                existingMap.set(oriKey, true);
                addedCount++;
            }
        }

        entry.terms = existingTerms;
        entry.lastUsed = Date.now();
        all[targetKey] = entry;

        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `成功匯入 ${addedCount} 筆術語至 "${targetKey}"`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey: targetKey, termCount: entry.terms.length } 
        }).catch(() => {});
        
        return { success: true, addedCount, termCount: entry.terms.length };
    } catch (e) {
        log.warn('Glossary', `匯入術語失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 生成 Prompt 注入片段 (強約束 XML / 列表格式，確保 LLM 100% 遵守指定譯名)
 */
export function buildGlossaryPromptSnippet(terms) {
    if (!terms || terms.length === 0) return '';
    const formattedList = terms
        .filter(t => t && t.ori && t.trans)
        .map(t => `• 原文: "${t.ori}" ➔ 強制譯名: "${t.trans}"`)
        .join('\n');

    return `
【最高優先級 - 專屬名詞與人名強制定名表 (CRITICAL GLOSSARY OVERRIDE)】
遇到以下日文詞彙/人名時，你【必須 100% 強制使用】指定的繁體中文譯名，嚴禁擅自意譯、音譯或替換為其他名稱：
${formattedList}
`;
}

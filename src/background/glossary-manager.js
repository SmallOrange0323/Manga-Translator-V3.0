import { state } from '../utils/state.js';
import { log } from '../utils/logger.js';

/**
 * GlossaryManager: 作品專屬詞彙對照表系統
 * 移植自 V1.8.6 的實戰邏輯，適配 V2.0 模組化架構。
 * 
 * 設計守則：
 * 1. 只增不覆寫：AI 萃取的詞彙只能新增不存在的原文，不可覆蓋現有條目。
 * 2. 使用者權威：source: "user" 的條目永久鎖定。
 * 3. 500 詞限制：防止 storage 溢出。
 */

export const GLOSSARY_STORAGE_KEY = 'mangaGlossaries';
export const GLOSSARY_MAX_TERMS = 500;

/**
 * 讀取指定作品的詞庫
 * @param {string} mangaKey 
 * @returns {Promise<Object|null>}
 */
export async function loadGlossary(mangaKey) {
    if (!mangaKey) return null;
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        return all[mangaKey] || null;
    } catch (e) {
        log.warn('Glossary', `讀取失敗: ${e.message}`);
        return null;
    }
}

/**
 * 儲存詞庫並執行上限修剪
 * @param {string} mangaKey 
 * @param {Object} glossaryEntry 
 */
export async function saveGlossary(mangaKey, glossaryEntry) {
    if (!mangaKey || !glossaryEntry) return;
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};

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

        const oldEntry = all[mangaKey] || {};
        all[mangaKey] = {
            displayName: oldEntry.displayName || glossaryEntry.displayName || mangaKey,
            rawJapanese: glossaryEntry.rawJapanese || oldEntry.rawJapanese || null,
            romanKey: glossaryEntry.romanKey || oldEntry.romanKey || mangaKey,
            terms,
            lastUsed: Date.now()
        };

        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已儲存作品 "${mangaKey}" 詞庫，共 ${terms.length} 詞`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey, termCount: terms.length } 
        }).catch(() => {});

    } catch (e) {
        log.warn('Glossary', `儲存失敗: ${e.message}`);
    }
}

/**
 * 整併 AI 萃取的新術語
 */
export function mergeGlossaryTerms(existingTerms, newTerms) {
    if (!Array.isArray(newTerms) || newTerms.length === 0) {
        return { terms: existingTerms, addedCount: 0 };
    }

    const existingOriSet = new Set(existingTerms.map(t => t.ori.toLowerCase().trim()));
    let addedCount = 0;
    const merged = [...existingTerms];

    for (const newTerm of newTerms) {
        if (!newTerm.ori || !newTerm.trans) continue;
        const oriKey = newTerm.ori.toLowerCase().trim();

        if (existingOriSet.has(oriKey)) continue;

        merged.push({
            ori: newTerm.ori.trim(),
            trans: newTerm.trans.trim(),
            source: 'ai'
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
        const entry = all[mangaKey];
        
        if (!entry || !entry.terms) return { success: false, message: '找不到該作品的詞庫' };
        
        const originalLength = entry.terms.length;
        entry.terms = entry.terms.filter(t => t.ori.toLowerCase().trim() !== oriText.toLowerCase().trim());
        
        if (entry.terms.length === originalLength) {
            return { success: false, message: '未找到該詞條' };
        }
        
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已從 "${mangaKey}" 刪除詞條: ${oriText}`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey, termCount: entry.terms.length } 
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
        const entry = all[mangaKey];
        
        if (!entry || !entry.terms) return { success: false, message: '找不到該作品的詞庫' };
        
        const originalLength = entry.terms.length;
        const deleteSet = new Set(oriTexts.map(t => t.toLowerCase().trim()));
        
        entry.terms = entry.terms.filter(t => !deleteSet.has(t.ori.toLowerCase().trim()));
        
        const deletedCount = originalLength - entry.terms.length;
        
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已從 "${mangaKey}" 批次刪除 ${deletedCount} 筆詞條`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey, termCount: entry.terms.length } 
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
        
        if (!all[mangaKey]) return { success: false, message: '找不到該作品的詞庫' };
        
        delete all[mangaKey];
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已刪除作品 "${mangaKey}" 的完整詞庫`);
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey, termCount: 0 } 
        }).catch(() => {});
        
        return { success: true };
    } catch (e) {
        log.warn('Glossary', `刪除詞庫失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 更新作品詞庫的顯示名稱
 * @param {string} mangaKey 
 * @param {string} newDisplayName 
 */
export async function updateGlossaryDisplayName(mangaKey, newDisplayName) {
    if (!mangaKey || !newDisplayName) return { success: false };
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        const entry = all[mangaKey];
        
        if (!entry) return { success: false, message: '找不到該作品的詞庫' };
        
        entry.displayName = newDisplayName.trim();
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        log.info('Glossary', `已更新 "${mangaKey}" 的顯示名稱為: ${newDisplayName}`);
        
        return { success: true };
    } catch (e) {
        log.warn('Glossary', `更新名稱失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 匯入術語列表
 * @param {string} mangaKey 
 * @param {Array} terms 
 */
export async function importGlossaryTerms(mangaKey, terms) {
    if (!mangaKey || !Array.isArray(terms)) return { success: false, message: '參數錯誤' };
    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        const entry = all[mangaKey] || { terms: [] };
        
        const existingOriSet = new Set(entry.terms.map(t => t.ori.toLowerCase().trim()));
        let addedCount = 0;
        
        for (const term of terms) {
            if (!term.ori || !term.trans) continue;
            const oriKey = term.ori.toLowerCase().trim();
            if (existingOriSet.has(oriKey)) continue;
            
            entry.terms.push({
                ori: term.ori.trim(),
                trans: term.trans.trim(),
                source: 'user',
                createdAt: Date.now()
            });
            existingOriSet.add(oriKey);
            addedCount++;
        }
        
        all[mangaKey] = entry;
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        
        // 通知 UI 更新
        chrome.runtime.sendMessage({ 
            action: 'GLOSSARY_UPDATED', 
            payload: { mangaKey, termCount: entry.terms.length } 
        }).catch(() => {});
        
        return { success: true, addedCount, termCount: entry.terms.length };
    } catch (e) {
        log.warn('Glossary', `匯入術語失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 生成 Prompt 注入片段
 */
export function buildGlossaryPromptSnippet(terms) {
    if (!terms || terms.length === 0) return '';
    const pairs = terms.map(t => `${t.ori}→${t.trans}`).join('、');
    return `\n\n【專屬名詞對照表 - 絕對遵守】以下術語請嚴格使用指定譯名，不可更改：${pairs}`;
}

import { state } from '../utils/state.js';
import { log } from '../utils/logger.js';
import { SYSTEM_BATCH_RULES } from '../utils/constants.js';
import { sanitizeJsonForParsing } from '../utils/json-utils.js';

/**
 * TranslateAPI: 封裝實戰級的 Gemini API 呼叫
 * 特色：
 * 1. 指數退避重試 (Exponential Backoff)
 * 2. 自動清理不完整的 JSON 回傳
 * 3. 備份模型切換邏輯
 */

export async function translateTexts(texts, options = {}) {
    // Bug #3 修復：確保 state 初始化完成，避免 SW 冷啟動時 API Key 池為空
    if (!state.isInitialized) await state.init();
    const {
        model = 'gemini-1.5-flash',
        fallbackModel = null,
        prompt = 'Translate the following texts to Traditional Chinese. Return only JSON.',
        schema = null,
        glossarySnippet = '' // 加入術語對照表片段
    } = options;

    let { apiKey } = options;

    if (!apiKey) {
        apiKey = state.getNextApiKey();
    }

    if (!apiKey) throw new Error('API Key is missing and pool is empty');

    // 將術語片段植入系統指令
    const systemPrompt = glossarySnippet ? `${prompt}\n\n${glossarySnippet}` : prompt;

    // 建立 User Parts (僅包含待翻譯文字)
    const userParts = [];
    if (options.imageBase64) {
        userParts.push({
            inlineData: {
                mimeType: "image/jpeg",
                data: options.imageBase64
            }
        });
    }
    
    if (texts && texts.length > 0) {
        userParts.push({ text: JSON.stringify(texts) });
    }

    // 防護：確保 user parts 不為空，避免 Gemini API 回傳 400 錯誤
    if (userParts.length === 0) {
        userParts.push({ text: 'Please proceed.' });
    }

    const body = {
        system_instruction: {
            parts: [{ text: systemPrompt }]
        },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
            response_mime_type: 'application/json',
            ...(schema ? { response_schema: schema } : {})
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
    };

    
    // ... (原本的抓取邏輯保持不變)
    let lastError = null;
    let currentModel = model;

    for (let attempt = 1; attempt <= 3; attempt++) {
        const startTime = performance.now();
        // 每次嘗試都重新嘗試獲取下一個可用 Key (如果是因為 Key 被限速，換 Key 是正確的)
        const currentKey = (attempt > 1) ? (state.getNextApiKey() || apiKey) : apiKey;
        const keyAlias = state.getApiKeyAlias(currentKey);

        try {
            // 自動修正模型名稱 (Gemini API 規範)
            if (currentModel === 'gemini-1.5-pro') {
                currentModel = 'gemini-1.5-pro-latest';
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${currentKey}`;
            
            // 加入 60 秒超時控制
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                const latencyMs = Math.round(performance.now() - startTime);

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const apiError = errorData.error?.message || '未知錯誤';
                    const statusCode = response.status;
                    
                    log.api('TranslateAPI', 'API 請求失敗', { 
                        model: currentModel, 
                        latencyMs, 
                        keyAlias, 
                        status: `HTTP ${statusCode}`,
                        error: apiError 
                    });

                    throw new Error(`API 錯誤 ${statusCode}: ${apiError}`);
                }

                const json = await response.json();
                const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                const cleanJsonStr = sanitizeJsonForParsing(rawText);
                const parsed = JSON.parse(cleanJsonStr);
                parsed.usedModelName = currentModel;
                
                log.api('TranslateAPI', '翻譯成功', { model: currentModel, latencyMs, keyAlias, status: 'OK' });
                return parsed;

            } finally {
                clearTimeout(timeoutId);
            }

        } catch (err) {
            const latencyMs = Math.round(performance.now() - startTime);
            log.warn('TranslateAPI', `第 ${attempt} 次嘗試失敗: ${err.message}`, { model: currentModel, latencyMs, keyAlias });
            
            lastError = err;
            
            // 統一在此處（catch 區塊）檢查是否需要切換至備援模型（不論是 API 錯誤還是連線錯誤）
            if (attempt === 1 && fallbackModel && fallbackModel !== currentModel) {
                log.info('TranslateAPI', `偵測到主要模型發生異常 (${err.message})，立即切換至使用者設定的備援模型: ${fallbackModel}`);
                currentModel = fallbackModel;
            }
            
            // 指數退避延遲
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise(r => setTimeout(r, delay));
        }
    }

    throw lastError;
}

/**
 * 從翻譯結果中非同步萃取術語
 */
/**
 * 從翻譯結果中非同步萃取術語 (強化版：支援分片處理與重試)
 */
export async function extractTermsFromTranslation(pairs, options = {}) {
    const { model = 'gemini-1.5-flash' } = options;
    const apiKey = state.getNextApiKey();
    if (!apiKey || pairs.length === 0) return [];

    // 分片處理：每 50 組對話為一組，防止單次 Payload 過大
    const chunkSize = 50;
    const chunks = [];
    for (let i = 0; i < pairs.length; i += chunkSize) {
        chunks.push(pairs.slice(i, i + chunkSize));
    }

    log.info('TranslateAPI', `[術語萃取] 開始分片處理：共 ${pairs.length} 組對話，分為 ${chunks.length} 個批次執行。`);

    const allNewTerms = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const inputText = chunk.map(p => `${p.original} → ${p.translation}`).join('\n');
        
        const extractPrompt = `You are a professional linguistic analyzer for Japanese Manga and Light Novels. 
Your task: Extract ONLY "Proper Nouns" (人名, 地名, 招式名) that are written in Katakana (片假名).

STRICT EXTRACTION RULES:
1. ONLY KATAKANA: The "original" term must consist EXCLUSIVELY of Katakana (e.g. フリーレン, シュタルク).
2. NO KANJI: Strictly exclude any word containing Kanji (e.g. 勇者, 王都, 老師 are FORBIDDEN).
3. NO COMMON NOUNS: Exclude common objects or titles even if in Katakana (e.g. ケーキ, ギルド, センセイ, ボス are FORBIDDEN).
4. NO ONOMATOPOEIA: Strictly exclude sound effects (e.g. ドカン, バキッ, ザーザー are FORBIDDEN).
5. MINIMUM LENGTH: Proper nouns usually have 2+ characters.
6. CORRESPONDENCE: Ensure the Traditional Chinese (zh-TW) translation matches the original name's sound and context.
7. NO MULTI-TO-ONE MISMATCH: Strictly avoid mapping phonetically distinct Katakana names to the exact same Traditional Chinese translation (e.g., mapping both "ミュディ" and "アミュディ" to "謬蒂" is FORBIDDEN).

Input Text to Analyze (Chunk ${i + 1}/${chunks.length}):
${inputText}`;

        const body = {
            contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
            generationConfig: {
                response_mime_type: 'application/json',
                response_schema: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            ori: { type: 'string' },
                            trans: { type: 'string' }
                        },
                        required: ['ori', 'trans']
                    }
                }
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
            ]
        };

        // 實作內部重試 (最多 2 次)
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const startTime = performance.now();
            const currentKey = (attempt > 1) ? (state.getNextApiKey() || apiKey) : apiKey;
            const keyAlias = state.getApiKeyAlias(currentKey);

            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                const latencyMs = Math.round(performance.now() - startTime);

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const apiError = errorData.error?.message || '未知錯誤';
                    log.api('TranslateAPI', `術語萃取失敗 (${i + 1}/${chunks.length})`, { 
                        model, latencyMs, keyAlias, status: `HTTP ${response.status}`, error: apiError 
                    });
                    throw new Error(`API Error ${response.status}: ${apiError}`);
                }

                const json = await response.json();
                const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
                const cleanStr = sanitizeJsonForParsing(rawText);
                const parsed = JSON.parse(cleanStr);
                
                if (Array.isArray(parsed)) {
                    // 執行嚴格的後置物理過濾，防止大模型幻覺與中中對照污染詞庫
                    const katakanaOnlyTerms = parsed.filter(t => {
                        if (!t.ori || !t.trans) return false;
                        
                        const oriTrimmed = t.ori.trim();
                        const transTrimmed = t.trans.trim();
                        
                        // 1. 原文與譯文不可相同 (排除中中對照)
                        if (oriTrimmed === transTrimmed) return false;
                        
                        // 2. 原文必須完全由片假名、長音符、中黑點組成 (排除漢字、平假名、英文與中文)
                        // 片假名區間 \u30a0-\u30ff，長音符 \u30fc，點號 \u30fb
                        const isPureKatakana = /^[・ー\u30a0-\u30ff]+$/.test(oriTrimmed);
                        if (!isPureKatakana) return false;
                        
                        return true;
                    });
                    allNewTerms.push(...katakanaOnlyTerms);
                }
                
                log.api('TranslateAPI', `術語萃取成功 (${i + 1}/${chunks.length})`, { model, latencyMs, keyAlias, status: 'OK' });
                lastErr = null; 
                break; // 成功則中斷重試迴圈
            } catch (err) {
                lastErr = err;
                if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        if (lastErr) {
            log.warn('TranslateAPI', `[術語萃取] 分片 ${i + 1} 最終失敗: ${lastErr.message}`);
        }
    }

    return allNewTerms;
}

/**
 * 多圖批次打包翻譯 (移植自 V1.8.6 callGeminiAPIBatch)
 * 將多張圖片打包進單一 API 請求，搭配嚴格的 JSON Schema 確保輸出對位。
 * @param {string[]} base64Array - 圖片 base64 陣列
 * @param {string} customPrompt - 使用者自訂或預設翻譯 Prompt
 * @param {string} glossarySnippet - 術語注入片段
 * @returns {Array} 長度固定等於 base64Array.length 的結果陣列
 */
export async function callGeminiAPIBatch(base64Array, customPrompt, glossarySnippet = '', apiKey = null) {
    const n = base64Array.length;
    const model = await state.get('modelName', 'gemini-1.5-flash');

    // 若未指定 Key，從 Key 池自動選取
    const resolvedKey = apiKey || state.getNextApiKey();
    if (!resolvedKey) throw new Error('API Key is missing');

    // 組合系統指令 (System Instruction) - 這是觸發 Context Caching 的關鍵穩定前綴
    const systemPrompt = glossarySnippet 
        ? `${customPrompt || 'You are a professional manga translator.'}\n\n${glossarySnippet}\n\n${SYSTEM_BATCH_RULES}`
        : `${customPrompt || 'You are a professional manga translator.'}\n\n${SYSTEM_BATCH_RULES}`;

    // 建立 User Parts
    const userParts = [];
    base64Array.forEach((b64, idx) => {
        userParts.push({ text: `\n=== PAGE_BOUNDARY: IMAGE_INDEX=${idx} ===\n` });
        userParts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
    });

    const body = {
        system_instruction: {
            parts: [{ text: systemPrompt }]
        },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
            response_mime_type: 'application/json',
            response_schema: {
                type: 'OBJECT',
                properties: {
                    pages: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                pageIndex: { type: 'INTEGER' },
                                results: {
                                    type: 'ARRAY',
                                    items: {
                                        type: 'OBJECT',
                                        properties: {
                                            original: { type: 'STRING' },
                                            translation: { type: 'STRING' }
                                        },
                                        required: ['original', 'translation']
                                    }
                                }
                            },
                            required: ['pageIndex', 'results']
                        }
                    }
                },
                required: ['pages']
            }
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
    };


    // 超時時間動態計算：基準 60 秒 + 每張 20 秒，上限 300 秒
    const timeoutMs = Math.min(60 + n * 20, 300) * 1000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = performance.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${resolvedKey}`;
    const keyAlias = state.getApiKeyAlias(resolvedKey);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const latencyMs = Math.round(performance.now() - startTime);

        if (!response.ok) {
            const errorText = await response.text();
            log.api('TranslateAPI', '批次翻譯失敗', { model, latencyMs, keyAlias, status: `HTTP ${response.status}` });
            const err = new Error(`批次 API 錯誤 (${response.status}): ${errorText}`);
            err.statusCode = response.status;
            throw err;
        }

        const json = await response.json();
        const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleanStr = sanitizeJsonForParsing(rawText);
        let data;
        try {
            data = JSON.parse(cleanStr);
        } catch (parseErr) {
            log.warn('TranslateAPI', `[批次解析] JSON 解析失敗，回傳空結果。原始文字前 200 字: ${cleanStr.slice(0, 200)}`);
            data = { pages: [] };
        }

        log.api('TranslateAPI', `批次翻譯成功 (${n} 張)`, { model, latencyMs, keyAlias, status: 'OK' });

        // 將 pageIndex 對應結果放回正確位置，長度固定等於 n
        const results = parseBatchOutput(data, n);
        results.forEach(r => { r.usedModelName = model; });
        return results;

    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`批次翻譯逾時 (${timeoutMs / 1000}s)`);
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * 解析多圖批次輸出，回傳長度固定為 batchSize 的陣列 (移植自 V1.8.6 parseBatchOneStepOutput)
 */
export function parseBatchOutput(data, batchSize) {
    const finalResults = Array(batchSize).fill(null).map(() => ({ results: [] }));

    if (data.pages && Array.isArray(data.pages)) {
        data.pages.forEach(p => {
            const idx = typeof p.pageIndex === 'number' ? p.pageIndex : -1;
            if (idx >= 0 && idx < batchSize) {
                finalResults[idx] = { results: Array.isArray(p.results) ? p.results : [] };
            } else {
                log.warn('TranslateAPI', `[批次解析] 偵測到無效索引: ${idx}（批次大小: ${batchSize}）`);
            }
        });
    }

    const missingIndices = finalResults
        .map((r, i) => r.results.length === 0 ? i : -1)
        .filter(i => i >= 0);
    if (missingIndices.length > 0) {
        log.warn('TranslateAPI', `[批次解析] 以下頁碼模型未回傳結果: [${missingIndices.join(', ')}]`);
    }

    return finalResults;
}

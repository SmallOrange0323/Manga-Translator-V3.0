import { state } from '../utils/state.js';
import { log } from '../utils/logger.js';
import { SYSTEM_BATCH_RULES } from '../utils/constants.js';
import { sanitizeJsonForParsing } from '../utils/json-utils.js';
import { isModelRefusalError } from './novel-refusal.js';
import { convertCnToTwLocal } from '../utils/zh-tw-localizer.js';

/**
 * 遞迴遍歷 JSON 物件，將所有譯文欄位進行台灣用語在地化轉換
 */
function localizeObjectStrings(obj) {
    if (!obj || typeof obj !== 'object') return;
    
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const val = obj[key];
            if (typeof val === 'string') {
                if (key === 'translation' || key === 'text' || key === 'translationText' || Array.isArray(obj)) {
                    obj[key] = convertCnToTwLocal(val);
                }
            } else if (typeof val === 'object') {
                localizeObjectStrings(val);
            }
        }
    }
}


/**
 * 可被 AbortSignal 中斷的延遲函式
 * @param {number} ms 
 * @param {AbortSignal} [signal] 
 * @returns {Promise<void>}
 */
export function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const cancelErr = new Error('Request aborted by user STOP');
            cancelErr.name = 'AbortError';
            cancelErr.isCancelled = true;
            cancelErr.isExternalAbort = true;
            return reject(cancelErr);
        }

        let timerId = null;
        let abortHandler = null;

        if (signal) {
            abortHandler = () => {
                if (timerId) clearTimeout(timerId);
                const cancelErr = new Error('Request aborted by user STOP');
                cancelErr.name = 'AbortError';
                cancelErr.isCancelled = true;
                cancelErr.isExternalAbort = true;
                reject(cancelErr);
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        timerId = setTimeout(() => {
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            resolve();
        }, ms);
    });
}

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
        model = 'gemini-3.1-flash-lite',
        fallbackModel = null,
        prompt = 'Translate the following texts to Traditional Chinese. Return only JSON.',
        schema = null,
        glossarySnippet = '', // 加入術語對照表片段
        signal = null
    } = options;

    if (signal?.aborted) {
        const cancelErr = new Error('Request aborted by user STOP');
        cancelErr.name = 'AbortError';
        cancelErr.isCancelled = true;
        cancelErr.isExternalAbort = true;
        throw cancelErr;
    }

    let { apiKey } = options;

    if (!apiKey) {
        apiKey = state.getNextApiKey();
    }

    if (!apiKey) throw new Error('API Key is missing and pool is empty');

    // 將術語片段植入系統指令 (升級為 XML 標籤包裹結構，針對 Gemini 3.1 Flash-Lite 優化)
    const systemPrompt = `
<system_instructions>
${prompt}
</system_instructions>
${glossarySnippet ? `\n<glossary>\n${glossarySnippet}\n</glossary>` : ''}`;

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
            temperature: 0.3,
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
        // 每次 attempt 開始前檢查外部 signal
        if (signal?.aborted) {
            const cancelErr = new Error('Request aborted by user STOP');
            cancelErr.name = 'AbortError';
            cancelErr.isCancelled = true;
            cancelErr.isExternalAbort = true;
            throw cancelErr;
        }

        const startTime = performance.now();
        // 每次嘗試都重新嘗試獲取下一個可用 Key (如果是因為 Key 被限速，換 Key 是正確的)
        const currentKey = (attempt > 1) ? (state.getNextApiKey() || apiKey) : apiKey;
        const keyAlias = state.getApiKeyAlias(currentKey);

        // 加入 60 秒超時控制並橋接 external signal
        const timeoutController = new AbortController();
        let externalAborted = false;
        let externalAbortHandler = null;

        if (signal) {
            externalAbortHandler = () => {
                externalAborted = true;
                timeoutController.abort();
            };
            if (signal.aborted) {
                externalAborted = true;
                timeoutController.abort();
            } else {
                signal.addEventListener('abort', externalAbortHandler, { once: true });
            }
        }

        const timeoutId = setTimeout(() => timeoutController.abort(), 60000);

        try {
            // 自動修正模型名稱 (Gemini API 規範)
            if (currentModel === 'gemini-1.5-pro') {
                currentModel = 'gemini-1.5-pro-latest';
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${currentKey}`;

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: timeoutController.signal
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
                const candidate = json.candidates?.[0];
                const finishReason = candidate?.finishReason;
                const rawText = candidate?.content?.parts?.[0]?.text || '';

                if (!rawText) {
                    if (finishReason === 'SAFETY' || finishReason === 'BLOCKLIST' || finishReason === 'PROHIBITED_CONTENT') {
                        const err = new Error(`觸發 Google AI 安全性過濾器 (finishReason: ${finishReason})，模型拒絕翻譯 (Prohibited Content)`);
                        err.isProhibited = true;
                        err.finishReason = finishReason;
                        throw err;
                    }
                    throw new Error(`API 回傳為空 (finishReason: ${finishReason || 'UNKNOWN'})`);
                }

                const cleanJsonStr = sanitizeJsonForParsing(rawText);
                let parsed;
                try {
                    parsed = JSON.parse(cleanJsonStr);
                } catch (pe) {
                    throw new Error(`JSON 解析失敗: ${pe.message} (Raw: ${cleanJsonStr.slice(0, 100)})`);
                }
                
                // 台灣用語在地化轉換
                if (await state.get('enableTaiwanLocalization', true)) {
                    localizeObjectStrings(parsed);
                }
                
                parsed.usedModelName = currentModel;
                
                log.api('TranslateAPI', '翻譯成功', { model: currentModel, latencyMs, keyAlias, status: 'OK' });
                return parsed;

            } finally {
                clearTimeout(timeoutId);
                if (signal && externalAbortHandler) {
                    signal.removeEventListener('abort', externalAbortHandler);
                }
            }

        } catch (err) {
            // 外部 STOP 中斷判定：不進入重試，立即終止
            if (externalAborted || signal?.aborted || err?.isCancelled || err?.isExternalAbort) {
                const cancelErr = new Error('Request aborted by user STOP');
                cancelErr.name = 'AbortError';
                cancelErr.isCancelled = true;
                cancelErr.isExternalAbort = true;
                log.info('TranslateAPI', '偵測到外部 STOP 中斷訊號，立即終止請求且不進行重試');
                throw cancelErr;
            }

            const latencyMs = Math.round(performance.now() - startTime);
            log.warn('TranslateAPI', `第 ${attempt} 次嘗試失敗: ${err.message}`, { model: currentModel, latencyMs, keyAlias });
            
            lastError = err;
            
            // Model Refusal 專屬重試策略 (PR #12)
            if (isModelRefusalError(err)) {
                // 6A. Primary 明確拒絕：若有不同 fallbackModel，立即切換 fallback，不等待 exponential backoff
                if (currentModel === model && fallbackModel && fallbackModel !== currentModel) {
                    if (signal?.aborted) {
                        const cancelErr = new Error('Request aborted by user STOP');
                        cancelErr.name = 'AbortError';
                        cancelErr.isCancelled = true;
                        cancelErr.isExternalAbort = true;
                        throw cancelErr;
                    }
                    log.info('TranslateAPI', `[Refusal Policy] 主要模型明確拒絕，立即切換至備援模型 ${fallbackModel}，零延遲重試`);
                    currentModel = fallbackModel;
                    continue;
                }
                
                // 6B. Fallback 也明確拒絕 (目前已是 fallbackModel)：立即 throw，不重複重試相同 fallback
                // 6C. 沒有不同 fallback (fallback 不存在或與 primary 相同)：主模型拒絕時立即 throw，不重複重試
                log.warn('TranslateAPI', `[Refusal Policy] 模型明確拒絕且無其他備援模型可切換，終止重試並拋出 Refusal 錯誤`);
                throw err;
            }

            // 普通錯誤 (429, 5xx, network, timeout, parse) 維持既有重試與備援行為 (Section 7)
            if (attempt === 1 && fallbackModel && fallbackModel !== currentModel) {
                log.info('TranslateAPI', `偵測到主要模型發生異常 (${err.message})，立即切換至使用者設定的備援模型: ${fallbackModel}`);
                currentModel = fallbackModel;
            }
            
            // 指數退避延遲 (可被 signal 立即中斷)
            const delay = Math.pow(2, attempt) * 1000;
            await abortableDelay(delay, signal);
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
    const model = options.model || options.modelName || 'gemini-3.1-flash-lite';
    const apiKey = options.apiKey || state.getNextApiKey();
    if (!apiKey || !pairs || pairs.length === 0) return [];

    const existingTerms = Array.isArray(options.existingTerms) ? options.existingTerms : [];
    const sceneContext = String(options.sceneContext || '').trim();

    // 分片處理：每 50 組對話為一組，防止單次 Payload 過大
    const chunkSize = 50;
    const chunks = [];
    for (let i = 0; i < pairs.length; i += chunkSize) {
        chunks.push(pairs.slice(i, i + chunkSize));
    }

    log.info('TranslateAPI', `[術語萃取] 開始分片處理：共 ${pairs.length} 組對話，分為 ${chunks.length} 個批次執行。`);

    const existingGlossaryBlock = existingTerms.length > 0
        ? `\n<existing_glossary>\nAlready established terms (STRICTLY FORBIDDEN to overwrite, reuse, or map new Katakana to these translations):\n${existingTerms.map(t => `• "${t.ori}" ➔ "${t.trans}"`).join('\n')}\n</existing_glossary>`
        : '';
    const sceneContextBlock = sceneContext
        ? `\n<scene_context>\n${sceneContext}\n</scene_context>`
        : '';

    const allRawExtractedTerms = [];

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
7. ONE-TO-ONE MAPPING ONLY (STRICT): Each distinct Japanese original name (ori) MUST have a unique Chinese translation (trans). Strictly FORBIDDEN to map new Katakana or character names to translations already established in the existing glossary, or to have two different "ori" share the same "trans" within the output! If names sound similar or you are unsure, transliterate independently according to kana pronunciation or skip.
8. OPTIONAL NOTE: If confident about the character's gender or social/workplace relationship (referring to scene_context if provided), provide a brief note in Traditional Chinese (e.g., "女", "男", "女/前輩", "男/上司"). If uncertain or not a character name, leave note empty "".
${existingGlossaryBlock}${sceneContextBlock}

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
                            trans: { type: 'string' },
                            note: { type: 'string' }
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
                    allRawExtractedTerms.push(...parsed);
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

    // 執行嚴格的後置物理過濾，防止大模型幻覺、中中對照污染詞庫與撞名
    // 1. 篩選基本合規的片假名詞條
    const validCandidateTerms = allRawExtractedTerms.filter(t => {
        if (!t || typeof t !== 'object') return false;
        if (!t.ori || !t.trans) return false;

        const oriTrimmed = String(t.ori).trim();
        const transTrimmed = String(t.trans).trim();

        // 原文與譯文不可相同 (排除中中對照)
        if (oriTrimmed === transTrimmed) return false;

        // 原文必須完全由片假名、長音符、中黑點組成 (排除漢字、平假名、英文與中文)
        // 片假名區間 \u30a0-\u30ff，長音符 \u30fc，點號 \u30fb
        const isPureKatakana = /^[・ー\u30a0-\u30ff]+$/.test(oriTrimmed);
        if (!isPureKatakana) return false;

        return true;
    });

    // 2. 建立既有詞庫索引
    const existingOriSet = new Set(existingTerms.map(t => String(t.ori || '').trim().toLowerCase()));
    const existingTransMap = new Map();
    existingTerms.forEach(t => {
        const o = String(t.ori || '').trim().toLowerCase();
        const tr = String(t.trans || '').trim().toLowerCase();
        if (tr) existingTransMap.set(tr, o);
    });

    // 3. 檢查本批次萃取出的項目中，是否有 2 個以上不同的 oriKey 指向同一個 transKey (張冠李戴衝突)
    const transToOriKeys = new Map();
    for (const item of validCandidateTerms) {
        const oriKey = String(item.ori).trim().toLowerCase();
        const transKey = String(item.trans).trim().toLowerCase();
        if (!transToOriKeys.has(transKey)) {
            transToOriKeys.set(transKey, new Set());
        }
        transToOriKeys.get(transKey).add(oriKey);
    }
    const conflictedTransKeys = new Set();
    for (const [transKey, oriKeys] of transToOriKeys.entries()) {
        if (oriKeys.size > 1) {
            conflictedTransKeys.add(transKey);
        }
    }

    // 4. 逐筆過濾與在地化
    const enableTwLoc = (await state.get('enableTaiwanLocalization', true)) !== false;
    const finalTerms = [];
    const seenOriKeys = new Set();

    for (const item of validCandidateTerms) {
        const oriTrimmed = String(item.ori).trim();
        const transTrimmed = String(item.trans).trim();
        const oriKey = oriTrimmed.toLowerCase();
        const transKey = transTrimmed.toLowerCase();

        // 剔除同批次張冠李戴衝突
        if (conflictedTransKeys.has(transKey)) continue;

        // 若已存在於既有詞庫的原文，跳過
        if (existingOriSet.has(oriKey)) continue;

        // 若與既有詞庫已存在的譯名衝突 (且對應原文不同)，直接剔除
        if (existingTransMap.has(transKey) && existingTransMap.get(transKey) !== oriKey) continue;

        // 同批次去重
        if (seenOriKeys.has(oriKey)) continue;
        seenOriKeys.add(oriKey);

        const localizedTrans = enableTwLoc ? convertCnToTwLocal(transTrimmed) : transTrimmed;
        const rawNote = typeof item.note === 'string' ? item.note.trim() : '';
        const localizedNote = (enableTwLoc && rawNote) ? convertCnToTwLocal(rawNote) : rawNote;

        finalTerms.push({
            ori: oriTrimmed,
            trans: localizedTrans,
            ...(localizedNote ? { note: localizedNote } : {})
        });
    }

    return finalTerms;
}

/**
 * 多圖批次打包翻譯 (移植自 V1.8.6 callGeminiAPIBatch)
 * 將多張圖片打包進單一 API 請求，搭配嚴格的 JSON Schema 確保輸出對位。
 * @param {string[]} base64Array - 圖片 base64 陣列
 * @param {string} customPrompt - 使用者自訂或預設翻譯 Prompt
 * @param {string} glossarySnippet - 術語注入片段
 * @returns {Array} 長度固定等於 base64Array.length 的結果陣列
 */
export async function callGeminiAPIBatch(base64Array, customPrompt, glossarySnippet = '', apiKey = null, modelOverride = null, signal = null, previousContextSnippet = '', options = {}) {
    if (signal?.aborted) {
        const cancelErr = new Error('Request aborted by user STOP');
        cancelErr.name = 'AbortError';
        cancelErr.isCancelled = true;
        cancelErr.isExternalAbort = true;
        throw cancelErr;
    }

    const n = base64Array.length;
    const model = modelOverride || await state.get('modelName', 'gemini-3.1-flash-lite');

    // 若未指定 Key，從 Key 池自動選取
    const resolvedKey = apiKey || state.getNextApiKey();
    if (!resolvedKey) throw new Error('API Key is missing');

    const enableSceneContext = options.enableSceneContext !== undefined
        ? Boolean(options.enableSceneContext)
        : (await state.get('enableSceneContext', true)) !== false;
    let useSceneContext = enableSceneContext;

    function buildBatchBody(useSceneCtx) {
        const sceneAnchorPrompt = useSceneCtx
            ? '\n[SCENE & CHARACTER ANCHOR]: Before translating pages, populate "sceneContext" in Traditional Chinese (1 short sentence, <= 60 chars) noting ONLY the setting (e.g., 職場辦公室/校園/奇幻) and visible characters\' gender & social/workplace relationship (e.g., 男下屬與女上司/女前輩與男後輩). Strictly DO NOT describe nudity, body parts, or intimate acts.'
            : '';

        const systemPrompt = `
<system_instructions>
${customPrompt || 'You are a professional manga translator.'}
${SYSTEM_BATCH_RULES}${sceneAnchorPrompt}
</system_instructions>
${glossarySnippet ? `\n<glossary>\n${glossarySnippet}\n</glossary>` : ''}${previousContextSnippet ? `\n<previous_dialogue_reference>\nFor character name, gender, and honorific consistency across batches, here are the most recent translated lines from the preceding pages:\n${previousContextSnippet}\n</previous_dialogue_reference>` : ''}`;

        const userParts = [];
        base64Array.forEach((b64, idx) => {
            userParts.push({ text: `\n=== PAGE_BOUNDARY: IMAGE_INDEX=${idx} ===\n` });
            if (typeof b64 === 'string' && b64.length > 50) {
                userParts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
            } else {
                userParts.push({ text: `[IMAGE_INDEX=${idx} IS EMPTY OR CORRUPTED, PLEASE OUTPUT {"pageIndex": ${idx}, "results": []}]` });
            }
        });
        userParts.push({ text: `\n=== VERIFICATION REQUIREMENT: Total ${n} images provided (Index 0 to ${n - 1}). Your output JSON "pages" array MUST have EXACTLY ${n} objects for each image in sequential order. Do NOT skip any page. ===\n` });

        const responseSchema = useSceneCtx
            ? {
                type: 'OBJECT',
                properties: {
                    sceneContext: { type: 'STRING' },
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
                required: ['sceneContext', 'pages']
            }
            : {
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
            };

        return {
            system_instruction: {
                parts: [{ text: systemPrompt }]
            },
            contents: [{ role: 'user', parts: userParts }],
            generationConfig: {
                temperature: 0.3,
                response_mime_type: 'application/json',
                response_schema: responseSchema
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
            ]
        };
    }

    const timeoutMs = Math.min(25 + n * 3, 60) * 1000;
    const controller = new AbortController();
    let externalAborted = false;
    let externalAbortHandler = null;

    if (signal) {
        externalAbortHandler = () => {
            externalAborted = true;
            controller.abort();
        };
        if (signal.aborted) {
            externalAborted = true;
            controller.abort();
        } else {
            signal.addEventListener('abort', externalAbortHandler, { once: true });
        }
    }

    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = performance.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${resolvedKey}`;
    const keyAlias = state.getApiKeyAlias(resolvedKey);

    try {
        let body = buildBatchBody(useSceneContext);
        let response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        let latencyMs = Math.round(performance.now() - startTime);

        if (!response.ok) {
            const errorText = await response.text();
            log.api('TranslateAPI', '批次翻譯失敗', { model, latencyMs, keyAlias, status: `HTTP ${response.status}` });
            const err = new Error(`批次 API 錯誤 (${response.status}): ${errorText}`);
            err.statusCode = response.status;
            throw err;
        }

        let json = await response.json();
        let candidate = json.candidates?.[0];
        let finishReason = candidate?.finishReason;
        let blockReason = json.promptFeedback?.blockReason;
        let isBlocked = finishReason === 'SAFETY' || finishReason === 'BLOCKLIST' || finishReason === 'PROHIBITED_CONTENT' || (!candidate && Boolean(blockReason));

        // 安全審查撞牆自動降級重試（Safety Fallback）
        if (isBlocked && useSceneContext) {
            console.warn('[API Batch] 觸發安全審查，自動關閉 sceneContext 原地重試一次...');
            log.warn('TranslateAPI', '[API Batch] 觸發安全審查，自動關閉 sceneContext 原地重試一次...');
            useSceneContext = false;
            body = buildBatchBody(false);
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            latencyMs = Math.round(performance.now() - startTime);

            if (!response.ok) {
                const errorText = await response.text();
                log.api('TranslateAPI', '批次翻譯失敗 (降級後)', { model, latencyMs, keyAlias, status: `HTTP ${response.status}` });
                const err = new Error(`批次 API 錯誤 (${response.status}): ${errorText}`);
                err.statusCode = response.status;
                throw err;
            }

            json = await response.json();
            candidate = json.candidates?.[0];
            finishReason = candidate?.finishReason;
            blockReason = json.promptFeedback?.blockReason;
            isBlocked = finishReason === 'SAFETY' || finishReason === 'BLOCKLIST' || finishReason === 'PROHIBITED_CONTENT' || (!candidate && Boolean(blockReason));
        }

        const rawText = candidate?.content?.parts?.[0]?.text || '';

        if (!rawText) {
            if (isBlocked) {
                const reason = finishReason || blockReason;
                log.warn('TranslateAPI', `[批次] 觸發模型安全審查過濾 (finishReason: ${reason})`);
                const err = new Error(`觸發 Google AI 安全性審查過濾 (finishReason: ${reason})，模型拒絕翻譯 (Prohibited Content)`);
                err.isProhibited = true;
                err.finishReason = reason;
                throw err;
            }
            throw new Error(`批次 API 回傳為空 (finishReason: ${finishReason || 'UNKNOWN'})`);
        }

        const cleanStr = sanitizeJsonForParsing(rawText);
        let data;
        const enableTwLoc = (await state.get('enableTaiwanLocalization', true)) !== false;
        try {
            data = JSON.parse(cleanStr);
            
            // 台灣用語在地化轉換
            if (enableTwLoc) {
                localizeObjectStrings(data);
            }
        } catch (parseErr) {
            log.warn('TranslateAPI', `[批次解析] JSON 解析失敗，拋出錯誤以觸發備援重試。原始文字前 200 字: ${cleanStr.slice(0, 200)}`);
            throw new Error(`批次 JSON 解析失敗 (finishReason: ${finishReason || 'UNKNOWN'}): ${parseErr.message}`);
        }

        log.api('TranslateAPI', `批次翻譯成功 (${n} 張)`, { model, latencyMs, keyAlias, status: 'OK' });

        // 將 pageIndex 對應結果放回正確位置，長度固定等於 n
        const results = parseBatchOutput(data, n);
        results.forEach(r => { r.usedModelName = model; });

        const rawSceneContext = (useSceneContext && typeof data.sceneContext === 'string')
            ? data.sceneContext.trim()
            : '';
        results.sceneContext = (enableTwLoc && rawSceneContext)
            ? convertCnToTwLocal(rawSceneContext)
            : rawSceneContext;

        return results;

    } catch (e) {
        if (externalAborted || signal?.aborted || e?.isCancelled || e?.isExternalAbort) {
            const cancelErr = new Error('Request aborted by user STOP');
            cancelErr.name = 'AbortError';
            cancelErr.isCancelled = true;
            cancelErr.isExternalAbort = true;
            log.info('TranslateAPI', '[批次] 偵測到外部 STOP 中斷訊號，立即終止請求');
            throw cancelErr;
        }
        if (e.name === 'AbortError') throw new Error(`批次翻譯逾時 (${timeoutMs / 1000}s)`);
        throw e;
    } finally {
        clearTimeout(timeoutId);
        if (signal && externalAbortHandler) {
            signal.removeEventListener('abort', externalAbortHandler);
        }
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

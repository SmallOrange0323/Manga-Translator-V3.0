import { state } from '../utils/state.js';
import { log } from '../utils/logger.js';
import { SYSTEM_BATCH_RULES } from '../utils/constants.js';
import { sanitizeJsonForParsing } from '../utils/json-utils.js';

/**
 * 將簡體字與大陸常用詞彙轉換為台灣繁體慣用詞彙
 */
function convertCnToTwLocal(text) {
    if (typeof text !== 'string' || !text) return text;
    
    // 1. 簡體字基礎對照轉換 (針對 Gemini 偶爾吐出簡體字的防禦性機制)
    const CN_TO_TW_CHARS = {
        '个': '個', '这': '這', '国': '國', '时': '時', '样': '樣', '说': '說',
        '会': '會', '对': '對', '机': '機', '开': '開', '关': '關', '动': '動',
        '发': '發', '问': '問', '么': '麼', '无': '無', '线': '線', '处': '處',
        '经': '經', '给': '給', '后': '後', '点': '點', '见': '見', '两': '兩',
        '业': '業', '进': '進', '头': '頭', '战': '戰', '书': '書', '门': '門',
        '体': '體', '风': '風', '乐': '樂', '东': '東', '车': '車', '儿': '兒',
        '长': '長', '万': '萬', '问': '問', '间': '間', '义': '義', '与': '與',
        '写': '寫', '马': '馬', '么': '麼', '么': '麼', '响': '響', '声': '聲',
        '听': '聽', '脸': '臉', '变': '變', '轻': '輕', '细': '細', '红': '紅',
        '绿': '綠', '蓝': '藍', '气': '氣', '记': '記', '认': '認', '让': '讓',
        '边': '邊', '过': '過', '还': '還', '进': '進', '运': '運', '选': '選',
        '题': '題', '样': '樣', '头': '頭', '买': '買', '卖': '賣', '东': '東',
        '西': '西', '爱': '愛', '热': '熱', '写': '寫', '画': '畫', '话': '話',
        '语': '語', '双': '雙', '体': '體', '办': '辦', '当': '當', '县': '縣',
        '号': '號', '处': '處', '备': '備', '图': '圖', '团': '團', '园': '園',
        '场': '場', '声': '聲', '报': '報', '极': '極', '样': '樣', '标': '標',
        '检': '檢', '压': '壓', '类': '類', '质': '質', '脑': '腦', '齿': '齒',
        '农': '農', '师': '師', '专': '專', '术': '術', '应': '應', '志': '志'
    };
    
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        result += CN_TO_TW_CHARS[char] || char;
    }
    
    // 2. 台灣常用詞彙替換
    const TW_LOCALIZATION_MAP = {
        '屏幕': '螢幕',
        '视频': '影片',
        '視頻': '影片',
        '音频': '音訊',
        '音頻': '音訊',
        '硬盤': '硬碟',
        '硬盘': '硬碟',
        '光盤': '光碟',
        '光盘': '光碟',
        '鼠標': '滑鼠',
        '鼠标': '滑鼠',
        '默認': '預設',
        '默认': '預設',
        '用戶': '使用者',
        '用户': '使用者',
        '網絡': '網路',
        '网络': '網路',
        '菜單': '選單',
        '菜单': '選單',
        '二進制': '二進位',
        '二进制': '二進位',
        '複制': '複製',
        '复制': '複製',
        '激活': '啟用',
        '充值': '儲值',
        '程序': '程式',
        '信息': '訊息'
    };

    for (const [key, value] of Object.entries(TW_LOCALIZATION_MAP)) {
        result = result.replaceAll(key, value);
    }
    
    return result;
}

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
        glossarySnippet = '' // 加入術語對照表片段
    } = options;

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
                const candidate = json.candidates?.[0];
                const finishReason = candidate?.finishReason;
                const rawText = candidate?.content?.parts?.[0]?.text || '';

                if (!rawText) {
                    if (finishReason === 'SAFETY' || finishReason === 'BLOCKLIST') {
                        throw new Error(`觸發 Google 安全性過濾器 (finishReason: ${finishReason})，即將切換備援模型重試`);
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
    const { model = 'gemini-3.1-flash-lite' } = options;
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
    const model = await state.get('modelName', 'gemini-3.1-flash-lite');

    // 若未指定 Key，從 Key 池自動選取
    const resolvedKey = apiKey || state.getNextApiKey();
    if (!resolvedKey) throw new Error('API Key is missing');

    // 組合系統指令 (System Instruction) - 升級為 XML 約束結構並包裹術語庫，觸發 Gemini Context Caching
    const systemPrompt = `
<system_instructions>
${customPrompt || 'You are a professional manga translator.'}
${SYSTEM_BATCH_RULES}
</system_instructions>
${glossarySnippet ? `\n<glossary>\n${glossarySnippet}\n</glossary>` : ''}`;

    // 建立 User Parts (支援單圖損毀防禦，避免空圖片觸發 API 400 錯誤)
    const userParts = [];
    base64Array.forEach((b64, idx) => {
        userParts.push({ text: `\n=== PAGE_BOUNDARY: IMAGE_INDEX=${idx} ===\n` });
        if (typeof b64 === 'string' && b64.length > 50) {
            userParts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
        } else {
            userParts.push({ text: `[IMAGE_INDEX=${idx} IS EMPTY OR CORRUPTED, PLEASE OUTPUT {"pageIndex": ${idx}, "results": []}]` });
        }
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
            
            // 台灣用語在地化轉換
            if (await state.get('enableTaiwanLocalization', true)) {
                localizeObjectStrings(data);
            }
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

/**
 * 【雙階段模式】多圖批次打包日文 OCR 提取
 * 將多張圖片打包進單一 API 請求，大幅縮減網絡延遲並提升速度。
 * @param {string[]} base64Array - 圖片 Base64 陣列
 * @param {Object} options - 選項（包含 model, pageOffset, apiKey 等）
 * @returns {Promise<string[]>} 長度固定為 base64Array.length 的各頁日文對白字串陣列
 */
export async function callGeminiAPIBatchOcr(base64Array, options = {}) {
    if (!state.isInitialized) await state.init();
    const n = base64Array.length;
    if (n === 0) return [];

    const model = options.model || (await state.get('ocrModelName', 'gemini-3.1-flash-lite'));
    const resolvedKey = options.apiKey || state.getNextApiKey();
    if (!resolvedKey) throw new Error('API Key is missing and pool is empty');

    const keyAlias = state.getApiKeyAlias(resolvedKey);
    const customOcrPrompt = (await state.get('customPromptOcr', '')) || '';

    const systemPrompt = `
<system_instructions>
You are an expert manga text extractor specialized in Japanese manga OCR.
Task: Extract ALL Japanese text for each manga image in reading order, INCLUDING speech bubbles, narrations, character thoughts, in-world signs, synopses (あらすじ), and author's afterwords/notes (あとがき/巻末コメント).
Rules:
1. Return pure Japanese raw text for each image. Do NOT translate.
2. If an image contains no text (e.g. pure artwork without text), return an empty string for that image.
3. Strictly correlate each page with its zero-based pageIndex (0 to ${n - 1}).
${customOcrPrompt ? `Custom extraction rules:\n${customOcrPrompt}` : ''}
</system_instructions>`;

    const userParts = [];
    base64Array.forEach((b64, idx) => {
        userParts.push({ text: `\n=== PAGE_BOUNDARY: IMAGE_INDEX=${idx} ===\n` });
        if (typeof b64 === 'string' && b64.length > 50) {
            userParts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
        } else {
            userParts.push({ text: `[IMAGE_INDEX=${idx} IS EMPTY OR CORRUPTED, PLEASE OUTPUT {"pageIndex": ${idx}, "text": ""}]` });
        }
    });

    const body = {
        system_instruction: {
            parts: [{ text: systemPrompt }]
        },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
            temperature: 0.1,
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
                                text: { type: 'STRING' }
                            },
                            required: ['pageIndex', 'text']
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

    const timeoutMs = Math.min(30 + n * 10, 180) * 1000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = performance.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${resolvedKey}`;

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
            log.api('TranslateAPI', '批次 OCR 失敗', { model, latencyMs, keyAlias, status: `HTTP ${response.status}` });
            throw new Error(`批次 OCR API 錯誤 (${response.status}): ${errorText}`);
        }

        const json = await response.json();
        const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleanStr = sanitizeJsonForParsing(rawText);
        let data = { pages: [] };
        try {
            data = JSON.parse(cleanStr);
        } catch (parseErr) {
            log.warn('TranslateAPI', `[批次 OCR 解析] JSON 解析失敗: ${cleanStr.slice(0, 200)}`);
        }

        log.api('TranslateAPI', `批次 OCR 成功 (${n} 張)`, { model, latencyMs, keyAlias, status: 'OK' });

        // 對齊索引，長度固定為 n
        const pageScripts = Array(n).fill('');
        if (Array.isArray(data.pages)) {
            data.pages.forEach(p => {
                const idx = typeof p.pageIndex === 'number' ? p.pageIndex : -1;
                if (idx >= 0 && idx < n) {
                    pageScripts[idx] = (p.text || '').trim();
                }
            });
        }

        return pageScripts;
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`批次 OCR 逾時 (${timeoutMs / 1000}s)`);
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * 【雙階段模式】單張圖片純文字 OCR 提取（備援或單頁模式使用）
 */
export async function extractTextFromImage(imageBase64, options = {}) {
    if (!state.isInitialized) await state.init();
    const {
        model = await state.get('ocrModelName', 'gemini-3.1-flash-lite'),
        prompt = (await state.get('customPromptOcr', '')) || 'Extract ALL Japanese story dialogue from this manga image. Return pure text only.'
    } = options;

    const apiKey = options.apiKey || state.getNextApiKey();
    if (!apiKey) throw new Error('未設定 API Key');

    const body = {
        contents: [
            {
                role: 'user',
                parts: [
                    { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
                    { text: prompt }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.1
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OCR API 錯誤 (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

/**
 * 【雙階段模式 - 階段 1.5】全域劇本通讀：分析全本漫畫台詞草稿，掌握當話劇情大綱、角色互動與專屬術語
 */
export async function extractGlobalStoryAndGlossary(rawScriptText, options = {}) {
    if (!state.isInitialized) await state.init();
    const model = options.model || (await state.get('modelName', 'gemini-3.1-flash-lite'));
    const apiKey = options.apiKey || state.apiKeys[0];
    if (!apiKey) throw new Error('未設定 API Key');

    const systemPrompt = `你是一位專業漫畫翻譯總監。以下是一部完整漫畫中所有頁面的日文對白與台詞草稿（包含 [P.1]、[P.2] 等頁碼標註）。
請通讀全篇台詞，深度分析並輸出 JSON 格式的全局設定：
1. storySummary: 本話/本章劇情大綱（簡述故事背景、核心衝突、登場情境與情節發展，約 80~150 字）。
2. characterRelationships: 角色互動與稱謂說明（例如：A是隊長語氣威嚴、B是部下稱呼A為隊長、C與D是情侶等）。
3. terms: 專有名詞、角色姓名、地名與招式術語對照表（日文原名 original、繁體中文推薦譯名 translation）。`;

    const schema = {
        type: 'OBJECT',
        properties: {
            storySummary: { type: 'STRING' },
            characterRelationships: { type: 'STRING' },
            terms: {
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
        required: ['storySummary', 'characterRelationships', 'terms']
    };

    const body = {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: `${systemPrompt}\n\n【全篇漫畫劇本台詞】：\n${rawScriptText}` }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.2,
            response_mime_type: 'application/json',
            response_schema: schema
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`劇本全局分析 API 錯誤 (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const cleanStr = sanitizeJsonForParsing(rawText);
    try {
        const parsed = JSON.parse(cleanStr);
        if (await state.get('enableTaiwanLocalization', true)) {
            localizeObjectStrings(parsed);
        }
        return parsed;
    } catch (e) {
        log.warn('TranslateAPI', `[劇本解析失敗] 原始文字: ${cleanStr}`);
        return { storySummary: '', characterRelationships: '', terms: [] };
    }
}

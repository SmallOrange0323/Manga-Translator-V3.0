export function mapPretranslationBatchResults(currentBatch, base64List, validItems, subResults, modelName, apiError = null) {
    const batchResults = currentBatch.map((image, idx) => {
        if (typeof base64List[idx] !== 'string' || !base64List[idx]) {
            return { image, error: '圖片載入失敗', usedModelName: modelName };
        }
        return null;
    });

    validItems.forEach((item, apiIndex) => {
        const image = currentBatch[item.originalIdx];
        if (apiError) {
            batchResults[item.originalIdx] = { image, error: apiError.message || String(apiError), usedModelName: modelName };
            return;
        }
        const matched = subResults?.[apiIndex];
        batchResults[item.originalIdx] = matched
            ? (matched.error
                ? { image, error: matched.error, usedModelName: modelName }
                : { image, results: matched.results || [], usedModelName: modelName })
            : { image, error: '批次結果不足', usedModelName: modelName };
    });

    return batchResults.map((result, idx) => result || ({
        image: currentBatch[idx], error: '預翻結果缺失', usedModelName: modelName
    }));
}

export function getPretranslationCompletion({ isCancelled, resultCount, imageCount }) {
    if (isCancelled) return { status: 'cancelled', isDone: false };
    if (resultCount === imageCount) return { status: 'completed', isDone: true };
    return { status: 'error', isDone: false, error: '預翻結果不完整' };
}

export function shouldCompleteMangaTranslation({ wasStopped, wasAborted, isStopping }) {
    return !wasStopped && !wasAborted && !isStopping;
}

/**
 * 判斷當前批次是否應將翻譯結果發布/提交至 UI
 * 若在批次處理或備援降級期間已被使用者 STOP 中止，必須立即放棄發布，防止渲染錯誤卡片
 * @param {Object} params
 * @param {boolean} params.wasStopped - 是否已被 STOP 中止
 * @param {boolean} [params.wasAborted] - 是否已被整體中斷
 * @returns {boolean}
 */
export function shouldPublishMangaBatchResults({ wasStopped, wasAborted = false } = {}) {
    return !wasStopped && !wasAborted;
}

/**
 * 執行批次失敗後的逐張 fallback 備援翻譯，保證在 STOP 觸發時立即中斷，不再發送後續 API 請求
 */
export async function executeFallbackImages({
    validItems,
    fallbackModelName,
    getNextApiKey,
    translateSingle,
    shouldContinue = async () => true,
    broadcastStatus = () => {}
}) {
    const fallbackResults = Array(validItems.length).fill(null);
    let wasStopped = false;

    for (let k = 0; k < validItems.length; k++) {
        const item = validItems[k];

        if (!await shouldContinue()) {
            wasStopped = true;
            break;
        }

        const apiKey = await getNextApiKey();

        if (!await shouldContinue()) {
            wasStopped = true;
            break;
        }

        try {
            const result = await translateSingle({
                imageBase64: item.b64,
                model: fallbackModelName,
                apiKey
            });

            fallbackResults[k] = {
                ...result,
                usedModelName: result.usedModelName || fallbackModelName
            };
            broadcastStatus(`第 ${item.originalIdx + 1} 張備援翻譯成功`, 'ok');
        } catch (singleErr) {
            if (singleErr?.isCancelled || singleErr?.isExternalAbort) {
                wasStopped = true;
                break;
            }
            fallbackResults[k] = { error: singleErr.message || String(singleErr) };
            broadcastStatus(`❌ 第 ${item.originalIdx + 1} 張備援失敗: ${(singleErr.message || '').slice(0, 30)}`, 'err');
        }

        if (!await shouldContinue()) {
            wasStopped = true;
            break;
        }
    }

    return { fallbackResults, wasStopped };
}

/**
 * 判斷批次 OCR 發生錯誤時是否允許執行逐張 OCR fallback 重試
 * 若收到外部 STOP 中斷訊號或任務已被取消，必須立即拒絕 fallback，防止發送無效請求
 * @param {Error} error 
 * @param {AbortSignal} [signal] 
 * @returns {boolean}
 */
export function shouldFallbackAfterOcrError(error, signal) {
    return !(
        signal?.aborted ||
        error?.isCancelled ||
        error?.isExternalAbort ||
        error?.code === 'TRANSLATION_STOPPED'
    );
}

/**
 * 執行批次 OCR 失敗後的逐張 fallback 重試，保證在 STOP 觸發時立即中斷，不再發送後續 API 請求
 */
export async function executeOcrFallbackImages({
    base64List,
    extractSingle,
    shouldContinue = async () => true
}) {
    const results = Array(base64List.length).fill('');
    let wasStopped = false;
    for (let idx = 0; idx < base64List.length; idx++) {
        if (!await shouldContinue()) {
            wasStopped = true;
            break;
        }
        const b64 = base64List[idx];
        if (!b64) continue;
        try {
            results[idx] = await extractSingle(b64, idx);
        } catch (err) {
            if (err?.isCancelled || err?.isExternalAbort || err?.code === 'TRANSLATION_STOPPED') {
                wasStopped = true;
                break;
            }
            results[idx] = '';
        }
        if (!await shouldContinue()) {
            wasStopped = true;
            break;
        }
    }
    Object.defineProperty(results, 'wasStopped', {
        value: wasStopped,
        enumerable: false,
        writable: true,
        configurable: true
    });
    return results;
}

/**
 * 判斷 Two-step Stage 1 (OCR) 結束後是否允許進入 Stage 1.5 (全域劇本分析)
 */
export function shouldProceedToStage15({ wasStopped, isStopping }) {
    if (wasStopped || isStopping) return false;
    return true;
}

/**
 * 判斷 Two-step Stage 1.5 結束後是否允許進入 Stage 2 (Translation)
 */
export function shouldProceedToStage2({ wasStopped, isStopping, scriptLinesCount = 0 }) {
    if (wasStopped || isStopping) return false;
    return true;
}

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

export function getPretranslationCompletion({ isCancelled, resultCount, imageCount, errorCount = 0 }) {
    if (isCancelled) return { status: 'cancelled', isDone: false };
    if (errorCount > 0) return { status: 'error', isDone: false, error: `${errorCount} 頁預翻失敗，可重試` };
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
 * 判斷是否為使用者主動 STOP 觸發的漫畫中斷（非普通 API 錯誤）
 * @param {Error} [error]
 * @param {AbortSignal} [signal]
 * @returns {boolean}
 */
export function isMangaCancellation(error, signal) {
    return !!(
        signal?.aborted ||
        error?.isCancelled ||
        error?.isExternalAbort ||
        error?.code === 'TRANSLATION_STOPPED'
    );
}

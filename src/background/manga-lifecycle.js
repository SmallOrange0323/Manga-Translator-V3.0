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
            for (let rest = k; rest < validItems.length; rest++) {
                fallbackResults[rest] = { error: '翻譯已停止' };
            }
            break;
        }

        const apiKey = await getNextApiKey();

        if (!await shouldContinue()) {
            wasStopped = true;
            for (let rest = k; rest < validItems.length; rest++) {
                fallbackResults[rest] = { error: '翻譯已停止' };
            }
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
            fallbackResults[k] = { error: singleErr.message || String(singleErr) };
            broadcastStatus(`❌ 第 ${item.originalIdx + 1} 張備援失敗: ${(singleErr.message || '').slice(0, 30)}`, 'err');
        }

        if (!await shouldContinue()) {
            wasStopped = true;
            for (let rest = k + 1; rest < validItems.length; rest++) {
                fallbackResults[rest] = { error: '翻譯已停止' };
            }
            break;
        }
    }

    return { fallbackResults, wasStopped };
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

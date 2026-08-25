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

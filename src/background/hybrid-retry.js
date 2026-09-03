import { getFailoverModel } from './hybrid-scheduler.js';

export function isHybridFailoverError(error) {
    const status = error?.statusCode ?? error?.status;
    return status === 429 || status === 503 || /\b(429|503)\b/.test(error?.message || '');
}

export class HybridRequestAbortedError extends Error {
    constructor() {
        super('Translation stopped before hybrid retry');
        this.name = 'HybridRequestAbortedError';
        this.code = 'TRANSLATION_STOPPED';
    }
}

export async function executeHybridRequest({ candidateKeys, scheduledKey, scheduledModel, primaryModel, secondaryModel, isHybrid, request, shouldContinue = () => true }) {
    const orderedKeys = [scheduledKey, ...candidateKeys.filter(key => key !== scheduledKey)];
    let lastError;
    for (const key of orderedKeys) {
        const models = [scheduledModel];
        const failover = getFailoverModel(scheduledModel, primaryModel, secondaryModel);
        if (isHybrid && failover && failover !== scheduledModel) models.push(failover);
        for (let index = 0; index < models.length; index++) {
            if (!await shouldContinue()) throw new HybridRequestAbortedError();
            const modelName = models[index];
            try {
                const results = await request({ apiKey: key, modelName, shouldContinue });
                return { results, usedKey: key, usedModelName: modelName };
            } catch (error) {
                lastError = error;
                // 若收到外部 STOP 中斷訊號，立即終止所有重試與備援模型切換
                if (error?.isCancelled || error?.isExternalAbort || error?.code === 'TRANSLATION_STOPPED' || !await shouldContinue()) {
                    throw new HybridRequestAbortedError();
                }
                if (!isHybridFailoverError(error)) break;
            }
        }
    }
    throw lastError || new Error('Hybrid request failed');
}

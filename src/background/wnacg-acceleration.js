export const WNACG_ACCELERATION_KEY = 'wnacgAccelerationEnabled';
export const WNACG_RULESET_ID = 'wnacg_local_jquery';

// Storage is authoritative; the queue only serializes work in this worker.
export function createWnacgAccelerationController(chromeApi) {
    let queue = Promise.resolve();
    const enqueue = task => {
        const result = queue.then(task);
        queue = result.catch(() => {});
        return result;
    };
    const readEnabled = async () => {
        const data = await chromeApi.storage.local.get(WNACG_ACCELERATION_KEY);
        return data[WNACG_ACCELERATION_KEY] !== false;
    };
    const applyStored = async () => {
        const enabled = await readEnabled();
        const rulesets = await chromeApi.declarativeNetRequest.getEnabledRulesets();
        if (rulesets.includes(WNACG_RULESET_ID) !== enabled) {
            await chromeApi.declarativeNetRequest.updateEnabledRulesets(enabled
                ? { enableRulesetIds: [WNACG_RULESET_ID] }
                : { disableRulesetIds: [WNACG_RULESET_ID] });
        }
        return { enabled };
    };

    return {
        reconcile: () => enqueue(applyStored),
        setEnabled: enabled => enqueue(async () => {
            if (typeof enabled !== 'boolean') throw new Error('加速設定必須為開啟或關閉');
            const previous = await readEnabled();
            // A single-key set is atomic and does not overwrite other settings.
            await chromeApi.storage.local.set({ [WNACG_ACCELERATION_KEY]: enabled });
            try {
                return await applyStored();
            } catch (error) {
                // Restore the previous preference only if no other context changed it.
                if (await readEnabled() === enabled) {
                    await chromeApi.storage.local.set({ [WNACG_ACCELERATION_KEY]: previous });
                }
                await applyStored();
                throw error;
            }
        })
    };
}

export function installWnacgAcceleration(chromeApi, onError = console.error) {
    const controller = createWnacgAccelerationController(chromeApi);
    const reconcile = () => { controller.reconcile().catch(onError); };

    // Static ruleset enablement resets on extension updates. Restore the saved choice.
    chromeApi.runtime.onInstalled.addListener(reconcile);
    chromeApi.runtime.onStartup.addListener(reconcile);
    chromeApi.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && Object.hasOwn(changes, WNACG_ACCELERATION_KEY)) reconcile();
    });
    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action !== 'GET_WNACG_ACCELERATION' && message.action !== 'SET_WNACG_ACCELERATION') {
            return false;
        }
        const operation = message.action === 'SET_WNACG_ACCELERATION'
            ? controller.setEnabled(message.enabled)
            : controller.reconcile();
        operation.then(result => sendResponse({ success: true, ...result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    });
    reconcile();
    return controller;
}

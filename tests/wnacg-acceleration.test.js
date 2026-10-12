import { describe, expect, it, vi } from 'vitest';
import { createWnacgAccelerationController, installWnacgAcceleration,
    WNACG_ACCELERATION_KEY as key, WNACG_RULESET_ID as ruleset } from '../src/background/wnacg-acceleration.js';
import { initWnacgSettings } from '../src/options/wnacg-settings.js';

function fixture(enabled) {
    const data = enabled === undefined ? {} : { [key]: enabled };
    const active = new Set([ruleset, 'unrelated_rules']);
    const event = () => {
        const listeners = [];
        return { listeners, addListener: fn => listeners.push(fn) };
    };
    const chrome = {
        storage: { local: {
            get: vi.fn(async name => ({ [name]: data[name] })),
            set: vi.fn(async values => Object.assign(data, values))
        }, onChanged: event() },
        declarativeNetRequest: {
            getEnabledRulesets: vi.fn(async () => [...active]),
            updateEnabledRulesets: vi.fn(async ({ enableRulesetIds = [], disableRulesetIds = [] }) => {
                enableRulesetIds.forEach(id => active.add(id));
                disableRulesetIds.forEach(id => active.delete(id));
            })
        },
        runtime: { onInstalled: event(), onStartup: event(), onMessage: event() }
    };
    return { chrome, data, active, controller: createWnacgAccelerationController(chrome) };
}

describe('WNACG acceleration preference', () => {
    it('keeps the existing acceleration on when there is no saved preference', async () => {
        const f = fixture();
        expect(await f.controller.reconcile()).toEqual({ enabled: true });
        expect(f.chrome.declarativeNetRequest.updateEnabledRulesets).not.toHaveBeenCalled();
    });

    it('disables all WNACG redirects without disabling unrelated rulesets', async () => {
        const f = fixture();
        expect(await f.controller.setEnabled(false)).toEqual({ enabled: false });
        expect(f.data[key]).toBe(false);
        expect([...f.active]).toEqual(['unrelated_rules']);
        expect(f.chrome.storage.local.set).toHaveBeenCalledWith({ [key]: false });
        expect(f.chrome.storage.local.set.mock.invocationCallOrder[0]).toBeLessThan(
            f.chrome.declarativeNetRequest.updateEnabledRulesets.mock.invocationCallOrder[0]);
        expect(await f.controller.setEnabled(true)).toEqual({ enabled: true });
        expect(f.active.has(ruleset)).toBe(true);
    });

    it('restores a saved off preference after a worker restart or ruleset reset on upgrade', async () => {
        const f = fixture(false);
        await f.controller.reconcile();
        f.active.add(ruleset); // Chrome resets static rules to their manifest defaults on update.
        const restarted = createWnacgAccelerationController(f.chrome);
        expect(await restarted.reconcile()).toEqual({ enabled: false });
        expect(f.active.has(ruleset)).toBe(false);
    });

    it('serializes rapid off/on requests and preserves the final saved choice', async () => {
        const f = fixture();
        await Promise.all([f.controller.setEnabled(false), f.controller.setEnabled(true), f.controller.setEnabled(false)]);
        expect(f.data[key]).toBe(false);
        expect(f.active.has(ruleset)).toBe(false);
    });

    it('leaves the browser unchanged if the preference cannot be saved', async () => {
        const f = fixture();
        f.chrome.storage.local.set.mockRejectedValueOnce(new Error('storage failed'));
        await expect(f.controller.setEnabled(false)).rejects.toThrow('storage failed');
        expect(f.active.has(ruleset)).toBe(true);
        expect(f.chrome.declarativeNetRequest.updateEnabledRulesets).not.toHaveBeenCalled();
        await expect(f.controller.setEnabled(false)).resolves.toEqual({ enabled: false });
    });

    it('rolls back a preference on a rule update failure and accepts a later retry', async () => {
        const f = fixture();
        f.chrome.declarativeNetRequest.updateEnabledRulesets.mockRejectedValueOnce(new Error('rules failed'));
        await expect(f.controller.setEnabled(false)).rejects.toThrow('rules failed');
        expect(f.data[key]).toBe(true);
        expect(f.active.has(ruleset)).toBe(true);
        await expect(f.controller.setEnabled(false)).resolves.toEqual({ enabled: false });
    });

    it('rejects invalid values without writing preferences or modifying rules', async () => {
        const f = fixture();
        await expect(f.controller.setEnabled('false')).rejects.toThrow();
        expect(f.chrome.storage.local.set).not.toHaveBeenCalled();
        expect(f.chrome.declarativeNetRequest.updateEnabledRulesets).not.toHaveBeenCalled();
    });

    it('handles settings messages asynchronously and returns errors instead of hanging the channel', async () => {
        const f = fixture();
        installWnacgAcceleration(f.chrome, vi.fn());
        const handler = f.chrome.runtime.onMessage.listeners[0];
        const reply = vi.fn();
        expect(handler({ action: 'SET_WNACG_ACCELERATION', enabled: false }, {}, reply)).toBe(true);
        await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true, enabled: false }));
        const failedReply = vi.fn();
        expect(handler({ action: 'SET_WNACG_ACCELERATION', enabled: null }, {}, failedReply)).toBe(true);
        await vi.waitFor(() => expect(failedReply).toHaveBeenCalledWith(expect.objectContaining({ success: false })));
        expect(handler({ action: 'UNRELATED' }, {}, vi.fn())).toBe(false);
    });

    it('reconciles install, startup, and external local preference changes', async () => {
        const f = fixture(false);
        installWnacgAcceleration(f.chrome, vi.fn());
        await vi.waitFor(() => expect(f.active.has(ruleset)).toBe(false));
        for (const event of [f.chrome.runtime.onInstalled, f.chrome.runtime.onStartup]) {
            f.active.add(ruleset);
            event.listeners[0]();
            await vi.waitFor(() => expect(f.active.has(ruleset)).toBe(false));
        }
        f.data[key] = true;
        f.chrome.storage.onChanged.listeners[0]({ [key]: { newValue: true } }, 'local');
        await vi.waitFor(() => expect(f.active.has(ruleset)).toBe(true));
        const reads = f.chrome.storage.local.get.mock.calls.length;
        f.chrome.storage.onChanged.listeners[0]({ unrelated: { newValue: true } }, 'local');
        f.chrome.storage.onChanged.listeners[0]({ [key]: { newValue: false } }, 'session');
        await Promise.resolve();
        expect(f.chrome.storage.local.get.mock.calls.length).toBe(reads);
    });
});

function controls() {
    let onChange;
    const toggle = { checked: true, disabled: true, addEventListener: (_, fn) => { onChange = fn; } };
    return { toggle, status: { textContent: '' }, change: enabled => { toggle.checked = enabled; onChange(); } };
}

describe('WNACG settings switch', () => {
    it('loads saved off state and enables the control', async () => {
        const c = controls();
        await initWnacgSettings({ ...c, sendAction: async () => ({ enabled: false }) });
        expect(c.toggle).toMatchObject({ checked: false, disabled: false });
        expect(c.status.textContent).toContain('原始載入');
    });

    it('waits for acknowledgement, then tells the user to refresh the website', async () => {
        const c = controls();
        let finish;
        const sendAction = vi.fn().mockResolvedValueOnce({ enabled: true })
            .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await initWnacgSettings({ ...c, sendAction });
        c.change(false);
        expect(c.toggle.disabled).toBe(true);
        expect(sendAction).toHaveBeenLastCalledWith('SET_WNACG_ACCELERATION', { enabled: false });
        finish({ enabled: false });
        await vi.waitFor(() => expect(c.toggle.disabled).toBe(false));
        expect(c.toggle.checked).toBe(false);
        expect(c.status.textContent).toContain('重新整理');
    });

    it('restores the acknowledged switch state and shows a retryable error on failure', async () => {
        const c = controls();
        const sendAction = vi.fn().mockResolvedValueOnce({ enabled: true }).mockRejectedValueOnce(new Error('rules failed'));
        await initWnacgSettings({ ...c, sendAction });
        c.change(false);
        await vi.waitFor(() => expect(c.toggle.disabled).toBe(false));
        expect(c.toggle.checked).toBe(true);
        expect(c.status.textContent).toContain('未能套用設定');
    });

    it('leaves the switch usable if the initial background read fails', async () => {
        const c = controls();
        await initWnacgSettings({ ...c, sendAction: async () => { throw new Error('disconnected'); } });
        expect(c.toggle.disabled).toBe(false);
        expect(c.status.textContent).toContain('無法讀取');
    });
});

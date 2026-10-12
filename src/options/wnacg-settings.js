export async function initWnacgSettings({ toggle, status, sendAction }) {
    if (!toggle || !status) return;
    let confirmedEnabled = true;
    const showResult = enabled => {
        confirmedEnabled = enabled;
        toggle.checked = enabled;
        status.textContent = enabled
            ? '加速已開啟。請重新整理紳士漫畫網頁。'
            : '加速已關閉，恢復網站原始載入方式。請重新整理紳士漫畫網頁。';
    };

    toggle.addEventListener('change', () => {
        const enabled = toggle.checked;
        toggle.disabled = true;
        status.textContent = '正在套用設定…';
        sendAction('SET_WNACG_ACCELERATION', { enabled })
            .then(result => showResult(result.enabled))
            .catch(error => {
                toggle.checked = confirmedEnabled;
                status.textContent = `未能套用設定：${error.message}。請重試。`;
            })
            .finally(() => { toggle.disabled = false; });
    });

    try {
        showResult((await sendAction('GET_WNACG_ACCELERATION')).enabled);
    } catch (error) {
        status.textContent = `無法讀取加速設定：${error.message}。可切換開關重試。`;
    } finally {
        toggle.disabled = false;
    }
}

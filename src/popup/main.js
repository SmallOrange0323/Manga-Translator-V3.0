/**
 * 漫譯 V3 - 純淨版彈出視窗邏輯
 */

const btnPanel    = document.getElementById('btn-open-panel');
const btnSettings = document.getElementById('btn-open-settings');
const statusMsg   = document.getElementById('status-msg');
const noticeEl    = document.getElementById('panel-not-available');
const panelDesc   = document.getElementById('panel-desc');

// ── 偵錯控制台綁定與劫持 ──
const debugSection = document.getElementById('debug-section');
const debugConsole = document.getElementById('debug-log-console');
const btnToggleDebug = document.getElementById('btn-toggle-debug');



function logToDebugConsole(level, ...args) {
    if (!debugConsole) return;
    const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.style.borderBottom = '1px solid rgba(0,0,0,0.05)';
    line.style.padding = '2px 0';
    if (level === 'error') line.style.color = '#ff3b30';
    if (level === 'warn') line.style.color = '#ff9500';
    line.textContent = `[${time}] [${level.toUpperCase()}] ${msg}`;
    debugConsole.appendChild(line);
    debugConsole.scrollTop = debugConsole.scrollHeight;
}

// 覆寫全域 console
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => { originalLog(...args); logToDebugConsole('info', ...args); };
console.warn = (...args) => { originalWarn(...args); logToDebugConsole('warn', ...args); };
console.error = (...args) => { originalError(...args); logToDebugConsole('error', ...args); };

// 偵錯日誌開關
if (btnToggleDebug && debugSection) {
    btnToggleDebug.addEventListener('click', () => {
        if (debugSection.style.display === 'none') {
            debugSection.style.display = 'block';
            btnToggleDebug.textContent = '隱藏偵錯資訊 (Hide Debug)';
        } else {
            debugSection.style.display = 'none';
            btnToggleDebug.textContent = '顯示偵錯資訊 (Show Debug)';
        }
    });
}

// 全域錯誤監聽 (Sync & Async)
window.onerror = function(msg, url, line) {
    console.error(`Sync Error: ${msg} at ${url}:${line}`);
    if (statusMsg) {
        statusMsg.style.color = "red";
        statusMsg.textContent = "Error: " + msg;
    }
    if (debugSection) debugSection.style.display = 'block'; // 報錯時自動展開偵錯資訊
    return false;
};

window.addEventListener('unhandledrejection', (event) => {
    const errorMsg = event.reason ? (event.reason.message || event.reason) : 'Unknown promise rejection';
    console.error(`Promise Error: ${errorMsg}`, event.reason);
    if (statusMsg) {
        statusMsg.style.color = "red";
        statusMsg.textContent = "Promise Error: " + errorMsg;
    }
    if (debugSection) debugSection.style.display = 'block'; // 報錯時自動展開偵錯資訊
});

// ── 開啟設定頁 ──
// 根本原因已診斷：chrome.runtime.openOptionsPage() 在 Edge Android 上
// 只會關閉 Popup，但不會開啟設定頁面。
// 正確做法是使用 chrome.tabs.create 明確開啟設定頁。
// 注意：Edge Android 在 tabs.create 後會自動關閉 popup，不需要 window.close()。
async function openSettings(e) {
    if (e && e.cancelable) e.preventDefault();
    console.log("⚙️ 開啟設定觸發（事件類型: " + (e ? e.type : 'unknown') + "）");

    if (statusMsg) {
        statusMsg.style.color = 'inherit';
        statusMsg.textContent = "正在開啟設定頁面...";
    }

    try {
        const url = chrome.runtime.getURL('src/options/index.html');
        console.log("準備使用 tabs.create 開啟: " + url);
        await chrome.tabs.create({ url: url });
        console.log("✅ tabs.create 成功");
        window.close(); // 明確關閉 popup
    } catch (err) {
        console.error("tabs.create 失敗:", err.message);
        if (statusMsg) {
            statusMsg.style.color = "red";
            statusMsg.textContent = "開啟設定失敗: " + err.message;
        }
    }
}

let settingsTouched = false;
btnSettings.addEventListener('touchend', (e) => {
    settingsTouched = true;
    openSettings(e);
    setTimeout(() => { settingsTouched = false; }, 500);
});

btnSettings.addEventListener('click', (e) => {
    if (settingsTouched) return;
    openSettings(e);
});


// ── 開啟翻譯面板 ──
btnPanel.addEventListener('click', async () => {
    try {
        if (statusMsg) statusMsg.textContent = "正在啟動...";
        
        // 行動端 query 較寬鬆，不使用 currentWindow: true
        const tabs = await chrome.tabs.query({ active: true });
        const tab = tabs && tabs.length > 0 ? tabs[0] : null;
        
        // 優先嘗試電腦版 SidePanel
        if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
            try {
                if (tab) {
                    await chrome.sidePanel.open({ tabId: tab.id });
                    window.close();
                    return;
                }
            } catch (err) {
                console.warn('SidePanel open failed, falling back to mobile tab');
            }
        }

        // 行動端備援：直接開啟行動版分頁
        // 注意：在 Vite 打包後，路徑依然會維持 src/mobile/index.html
        const mobileUrl = chrome.runtime.getURL('src/mobile/index.html') + (tab ? '?sourceTabId=' + tab.id : '');
        
        if (statusMsg) statusMsg.textContent = "正在跳轉至行動版頁面...";
        
        await chrome.tabs.create({ url: mobileUrl });
        window.close();

    } catch (e) {
        console.error('Popup Error:', e);
        if (statusMsg) {
            statusMsg.style.color = "red";
            statusMsg.textContent = "啟動失敗: " + e.message;
        }
    }
});


// 初始檢查：行動端隱藏「開啟翻譯面板」按鈕（對行動端無意義）
// 注意：Edge Android 上 chrome.sidePanel API 存在但側邊欄 UI 無法使用，
//       改用 userAgent 偵測才準確
const isMobileEnv = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
if (isMobileEnv) {
    // 行動端：完全隱藏面板按鈕
    if (btnPanel) btnPanel.style.display = 'none';
} else {
    // 電腦端：確保面板按鈕可見（預設就是可見）
    if (panelDesc) panelDesc.textContent = '在側邊欄開啟';
}

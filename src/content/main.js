import { log } from '../utils/logger.js';
import { initDesktopMode } from './desktop-main.js';
import { initMobileMode } from './mobile-main.js';
import { detectNavigationLinks } from '../utils/nav-detector.js';

/**
 * 偵測是否為行動端環境 (Edge Android / Kiwi / etc.)
 */
function isMobileDevice() {
    // 1. 標準 UA 偵測 (涵蓋 Android, iPhone, 舊版 iPad 等)
    const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    // 2. iPadOS 13+ 偽裝偵測 (桌面模式下會隱藏 iPad 字樣，特徵為 MacIntel 且支援多點觸控)
    const isIPadOS = (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // 3. Android 平板「桌面模式」偵測：Edge/Chrome 在大平板上開啟桌面模式後會移除 UA 中的 Android，
    //    但觸控點數特徵仍在。條件：多點觸控 + 非 Windows 平台（排除 Surface 等 Windows 觸控筆電）
    const isAndroidTabletDesktopMode = (
        navigator.maxTouchPoints >= 2 &&
        !navigator.userAgent.includes('Windows') &&
        !navigator.platform.toLowerCase().startsWith('win')
    );

    return uaMobile || isIPadOS || isAndroidTabletDesktopMode;
}

function bootstrap() {
    const isMobile = isMobileDevice();
    log.info('Content', `系統啟動 - 偵測到環境: ${isMobile ? '行動端' : '電腦端'}`);

    if (isMobile) {
        initMobileMode();
    } else {
        initDesktopMode();
    }
}

// 在網頁載入後啟動
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    bootstrap();
} else {
    window.addEventListener('load', bootstrap);
}

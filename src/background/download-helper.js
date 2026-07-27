import JSZip from 'jszip';
import { log } from '../utils/logger.js';

// 監聽來自 Content Script 或 UI 的訊息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'FETCH_HTML') {
    const { url } = message;
    log.info('DownloadHelper', `正在抓取 HTML: ${url}`);
    
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP 錯誤: ${res.status}`);
        return res.text();
      })
      .then(html => {
        sendResponse({ success: true, html });
      })
      .catch(err => {
        log.error('DownloadHelper', `抓取 HTML 失敗: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      });
      
    return true; // 保持非同步通道
  }

  if (message.action === 'DOWNLOAD_IMAGES_ZIP') {
    const { urls, filename } = message;
    log.info('DownloadHelper', `開始批次下載 ${urls.length} 張圖片，準備打包成 ZIP`);

    (async () => {
      try {
        const zip = new JSZip();
        const folder = zip.folder("images");

        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          // 產生檔名，補零對齊以維持排序關係，如 001.jpg
          let ext = 'jpg';
          if (url.includes('.png')) ext = 'png';
          else if (url.includes('.webp')) ext = 'webp';
          else if (url.includes('.gif')) ext = 'gif';

          const fileIndex = String(i + 1).padStart(3, '0');
          const imgName = `${fileIndex}.${ext}`;

          try {
            if (url.startsWith('data:')) {
              const base64Content = url.split(',')[1];
              folder.file(imgName, base64Content, { base64: true });
            } else {
              const res = await fetch(url);
              if (!res.ok) throw new Error(`HTTP 錯誤: ${res.status}`);
              const blob = await res.blob();
              folder.file(imgName, blob);
            }
            log.info('DownloadHelper', `下載圖片成功 (${i + 1}/${urls.length}): ${imgName}`);
          } catch (imgErr) {
            log.error('DownloadHelper', `下載單張圖片失敗 (${i + 1}/${urls.length}): ${url}`, imgErr);
            folder.file(`${imgName}_failed.txt`, `下載失敗: ${url}`);
          }
        }

        // Service Worker 環境下禁用 URL.createObjectURL，改用 base64 data URL
        const base64Data = await zip.generateAsync({ type: 'base64' });
        const zipUrl = `data:application/zip;base64,${base64Data}`;

        // 使用 chrome.downloads 下載 ZIP
        chrome.downloads.download({
          url: zipUrl,
          filename: filename || 'manga_images.zip',
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            log.error('DownloadHelper', `下載 ZIP 失敗: ${chrome.runtime.lastError.message}`);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            log.info('DownloadHelper', `已觸發 ZIP 下載，ID: ${downloadId}`);
            sendResponse({ success: true, downloadId });
          }
        });
      } catch (err) {
        log.error('DownloadHelper', `打包 ZIP 失敗: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // 保持非同步通道
  }
});

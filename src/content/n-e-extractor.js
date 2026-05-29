import { log } from '../utils/logger.js';

export function initNEExtractor() {
  const url = window.location.href;
  const isNHentai = url.includes('nhentai.net');
  const isEHentai = url.includes('e-hentai.org') || url.includes('exhentai.org');

  if (!isNHentai && !isEHentai) return;

  log.info('NEExtractor', '偵測到 N/E 網站漫畫頁面，準備載入串聯流式閱讀器功能');

  // 監聽訊息以供 Sidepanel 或 Mobile 查詢
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'extractNEMetadata') {
      extractMangaMetadata(isNHentai, isEHentai)
        .then(meta => {
          sendResponse({ success: true, metadata: meta });
        })
        .catch(err => {
          sendResponse({ success: false, error: err.message });
        });
      return true; // 保持非同步通道
    }
  });

  // 建立流式閱讀的按鈕或將其掛載到適當位置
  injectStreamButton(isNHentai, isEHentai);
}

function injectStreamButton(isNHentai, isEHentai) {
  // 建立 Shadow DOM 或直接在網頁適當處掛載按鈕
  // 為了極簡且不破壞宿主 CSS，我們在頂部/側邊或特定標籤列旁加入一個精美浮動按鈕或按鈕列
  let targetContainer = null;
  
  if (isNHentai) {
    targetContainer = document.querySelector('#info');
  } else if (isEHentai) {
    targetContainer = document.querySelector('#gd5');
  }

  if (!targetContainer) return;

  // 避免重複注入
  if (document.querySelector('.mt-stream-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'mt-stream-btn';
  btn.innerText = '📖 集中流式閱讀 / 翻譯';
  
  // 基本樣式設定
  btn.style.cssText = `
    display: inline-block;
    margin: 10px 0;
    padding: 8px 16px;
    background-color: #f24e1e;
    color: #ffffff;
    font-size: 14px;
    font-weight: bold;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    transition: background-color 0.2s;
  `;
  
  btn.onmouseover = () => btn.style.backgroundColor = '#d13f14';
  btn.onmouseout = () => btn.style.backgroundColor = '#f24e1e';

  btn.addEventListener('click', async () => {
    try {
      btn.innerText = '⏳ 正在提取分頁資訊...';
      const metadata = await extractMangaMetadata(isNHentai, isEHentai);
      
      if (!metadata) {
        alert('無法解析此漫畫資訊！請確認是否在漫畫詳情首頁。');
        btn.innerText = '📖 集中流式閱讀 / 翻譯';
        return;
      }

      // 將資料存入 chrome.storage.local
      await chrome.storage.local.set({ mt_current_stream: metadata });

      // 開啟流式閱讀器網頁
      const readerUrl = chrome.runtime.getURL('src/reader/stream-reader.html');
      window.open(readerUrl, '_blank');
      btn.innerText = '📖 集中流式閱讀 / 翻譯';
    } catch (err) {
      log.error('NEExtractor', '啟動流式閱讀失敗', err);
      alert('啟動失敗: ' + err.message);
      btn.innerText = '📖 集中流式閱讀 / 翻譯';
    }
  });

  targetContainer.appendChild(btn);
}

async function extractMangaMetadata(isNHentai, isEHentai) {
  const url = window.location.href;
  
  if (isNHentai) {
    const match = url.match(/\/g\/(\d+)/);
    if (!match) return null;
    const mangaId = match[1];

    // 取得標題
    const title = document.querySelector('#info h1')?.textContent?.trim() || 
                  document.querySelector('#info h2')?.textContent?.trim() || `NHentai-${mangaId}`;

    // 取得總頁數
    let totalPages = 0;
    const tagContainers = document.querySelectorAll('.tag-container');
    for (const container of tagContainers) {
      if (container.textContent.includes('Pages')) {
        totalPages = parseInt(container.querySelector('.name')?.textContent || '0', 10);
        break;
      }
    }
    
    if (!totalPages) {
      totalPages = document.querySelectorAll('.thumb-container').length;
    }

    // 產生分頁頁面的 URL 清單 (例如：https://nhentai.net/g/12345/1/)
    const pageUrls = [];
    for (let i = 1; i <= totalPages; i++) {
      pageUrls.push(`https://nhentai.net/g/${mangaId}/${i}/`);
    }

    return {
      site: 'nhentai',
      mangaId,
      title,
      totalPages,
      pageUrls,
      galleryUrl: url
    };
  }

  if (isEHentai) {
    // E-hentai / Exhentai 網址範例: https://e-hentai.org/g/2926715/4d0a514d7a/
    const match = url.match(/\/g\/(\d+)\/([a-z0-9]+)/);
    if (!match) return null;
    const mangaId = match[1];
    const token = match[2];

    const title = document.querySelector('#gn')?.textContent?.trim() || `EHentai-${mangaId}`;

    // 總頁數
    let totalPages = 0;
    const gddText = document.getElementById('gdd')?.textContent || '';
    const pagesMatch = gddText.match(/(\d+)\s+pages/);
    if (pagesMatch) {
      totalPages = parseInt(pagesMatch[1], 10);
    }

    // 收集第一頁的頁面網址
    const pageUrls = [];
    document.querySelectorAll('#gdt a').forEach(a => {
      if (a.href) pageUrls.push(a.href);
    });

    return {
      site: 'e-hentai',
      mangaId,
      token,
      title,
      totalPages,
      pageUrls, // 之後在 stream-reader 中若長度小於 totalPages，可以抓取後續 gallery 頁面的 URLs
      galleryUrl: url
    };
  }

  return null;
}

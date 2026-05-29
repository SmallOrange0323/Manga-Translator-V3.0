# 實施計畫：圖片提取與集中流式閱讀/翻譯功能 (N網/E網模式)

本計畫旨在為 Manga Translator V3.0 實作針對「點擊換頁型網站（以 N網、E網為代表）」的**「批次預載、集中串聯、流式條漫閱讀與翻譯」**功能。

---

## 📋 使用者審查與交互設計確認

> [!IMPORTANT]
> **依據您的具體回饋，我們將「一鍵流式串聯閱讀」的觸發按鈕完美融入現有的 UI 中，不破壞原有網頁版面：**
> 
> 1. **PC 版（側邊欄 UI 整合）**：
>    * **觸發路徑**：使用者在側邊欄點擊「手動選取」進入圖片選取介面。
>    * **按鈕位置**：在上方「全選 / 取消全選」控制列（即 `mt-select-all-btn` 與返回按鈕的位置）旁邊，新增一個精美的**「串聯流式閱讀」**按鈕。
>    * **效果**：點擊該按鈕後，會直接抓取當前漫畫的所有頁面，並自動開啟新分頁進行集中流式閱讀與翻譯。
> 
> 2. **行動版（網頁注入控制台 UI 整合）**：
>    * **觸發路徑**：行動版進入圖片選取介面（懸浮控制台）。
>    * **按鈕位置**：在「全選 / 取消」按鈕的旁邊，新增一個**「串聯流式閱讀」**按鈕。

---

## 💬 開放性問題

> [!NOTE]
> * **按鈕視覺風格**：新增的按鈕將採用符合 Manga Translator V3.0 的紫色漸層現代風格，並配上 `📖` 或 `⚡` 圖示，以醒目的特徵標示。您對此視覺設計是否滿意？

---

## 🗺 介面通訊契約 (Message Protocol Contract)

Content Script 與 Background Service Worker 之間的通訊遵循以下命名與格式契約：

### 1. 異步抓取分頁 HTML (FETCH_HTML)
* **傳送端**：Content Script ➡️ Background
* **格式**：
  ```json
  {
    "action": "FETCH_HTML",
    "url": "https://example.com/g/123456/2/"
  }
  ```
* **回傳端**：Background ➡️ Content Script
* **格式**：回傳 HTML 網頁文字內容 (`string`)。

### 2. 批次下載圖片 Blob (DOWNLOAD_IMAGES_ZIP)
* **傳送端**：UI 頁面 ➡️ Background
* **格式**：
  ```json
  {
    "action": "DOWNLOAD_IMAGES_ZIP",
    "urls": ["image_url_1", "image_url_2", "..."]
  }
  ```
* **回傳端**：Background ➡️ UI 頁面
* **格式**：`{ "success": true, "downloadId": 123 }`。

---

## 🛠 預計變更

### 1. 基礎設定與編譯配置
#### [MODIFY] [manifest.json](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/manifest.json)
* 在 `permissions` 中新增 `"downloads"` 權限。
* 將 `src/reader/stream-reader.html` 加入 `web_accessible_resources` 的 `resources` 陣列中。

#### [MODIFY] [vite.config.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/vite.config.js)
* 於 `rollupOptions.input` 中新增 `'stream-reader': 'src/reader/stream-reader.html'`，確保 Vite 能將流式閱讀器打包編譯。

---

### 2. 背景服務與通訊中繼 (Background)
#### [NEW] [download-helper.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/background/download-helper.js)
* 實作 `FETCH_HTML` 監聽：利用背景免除 CORS 的優勢抓取分頁內容。
* 實作 `DOWNLOAD_IMAGES_ZIP` 監聽：整合 `jszip`（在打包時引入），在背景下載所有圖片 Blob 並打包為 `.zip`，再呼叫 `chrome.downloads.download` 下載。

#### [MODIFY] [index.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/background/index.js)
* 掛載與初始化 `download-helper.js`。

---

### 3. UI 整合與探針 (Content & Sidepanel)
#### [MODIFY] [src/sidepanel/index.html](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/sidepanel/index.html)
* 在圖片選取的控制區（`#mt-select-all-btn` 附近）新增「串聯流式閱讀」的 HTML 按鈕。

#### [MODIFY] [src/sidepanel/main.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/sidepanel/main.js)
* 綁定新按鈕的點擊事件，當處於支援網站（N網/E網）時顯示該按鈕，點擊後觸發流式沙盒頁面載入。

#### [MODIFY] [src/mobile/main.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/mobile/main.js)
* 在行動版圖片選取控制台的「全選 / 取消」按鈕旁，動態新增「串聯流式閱讀」按鈕，並綁定跳轉至行動流式閱讀器的事件。

#### [NEW] [n-e-extractor.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/content/n-e-extractor.js)
* 負責對 N網/E網 的 DOM 結構進行總頁數解析與各分頁圖片的非同步預載策略。

---

### 4. 獨立流式集中閱讀器 (UI Page)
#### [NEW] [stream-reader.html](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/reader/stream-reader.html)
* 提供條漫式垂直串聯的 HTML 骨架、控制面板（打包下載、一鍵翻譯、進度條）。

#### [NEW] [stream-reader.css](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/reader/stream-reader.css)
* 流式條漫垂直排列 CSS、現代化精緻暗色調面板樣式。

#### [NEW] [stream-reader.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/reader/stream-reader.js)
* 串接背景資料獲取、流式動態渲染圖片、串接現有的翻譯與 OCR 引擎、調用 ZIP 下載功能。

---

## 📈 驗證計劃

### 1. 自動化三道綠燈自檢
* **第一道：語法靜態檢查**：確保程式碼無 ES6 Modules 語法衝突。
* **第二道：自動編譯打包 (Build Check)**：執行 `npm run build`，確保 `dist-v3/` 能成功生成 `stream-reader.html` 及所有關聯 JS/CSS 資源，且 `jszip` 成功打包。

### 2. 手動功能驗證
* **下載測試**：進入 Chrome 開發者模式載入 `dist-v3`，實地在測試分頁點擊按鈕，驗證是否能成功打包下載 `.zip` 壓縮檔，並依序命名。
* **翻譯測試**：在流式頁面點擊「一鍵翻譯」，驗證 OCR 與翻譯層是否能正確覆蓋於圖片上方。

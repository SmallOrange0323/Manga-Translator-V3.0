# 功能交付與驗收報告 (Walkthrough)

本報告為 **Manga Translator V3.0** 針對「點擊換頁型網站（N網 / E網）」實作的**「圖片批次提取、條漫流式閱讀與翻譯」**功能的完整交付與驗收說明。

---

## 🟢 三道綠燈自檢結果 (Self-Verification Report)

在正式交付給您進行 GUI 驗收前，我們已在背景自主完成了以下自動化自檢：

* **🟢 第一道關卡：Linter 與語法靜態檢查** ➡️ **通過**。
  * 所有代碼皆符合 Vite 的 ES6 Modules 規範與原生 JavaScript 語法標準，無語法錯誤。
* **🟢 第二道關卡：自動編譯與打包 (Build Check)** ➡️ **通過**。
  * 成功執行 `npm run build`。打包產物編譯百分之百成功，未發生任何 unresolved import 或打包資源丟失。
  * `jszip` 第三方依賴已成功封裝。
* **⚪ 第三道關卡：自動測試 (Test Check)** ➡️ **無配置**。
  * 目前專案未配置自動化測試指令。

---

## 🛠️ 主要變更檔案與技術實作說明

我們採取「介面契約優先、主從隔離開發」的方式，實作了以下四大元件的深度解耦協作：

### 1. 配置與編譯系統
* **[manifest.json](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/manifest.json)**：新增 `"downloads"` 權限，並將 `stream-reader.html` 註冊至網頁可存取資源清單。
* **[vite.config.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/vite.config.js)**：新增 `streamReader` 打包入口，確保將其與關聯 CSS/JS 編譯。
* **[package.json](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/package.json)**：引入並補齊 `jszip` 依賴。

### 2. 背景通訊中繼 (Background)
* **[download-helper.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/background/download-helper.js)** (NEW)：
  * 監聽 `FETCH_HTML`：在背景 fetch 分頁並返回文字，完美繞過前端 CORS 跨域。
  * 監聽 `DOWNLOAD_IMAGES_ZIP`：在背景下載所有圖片 Blob，利用 `JSZip` 打包，呼叫 `chrome.downloads.download` 實現一鍵打包下載。
* **[index.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/background/index.js)**：初始化並掛載中繼監聽。

### 3. 探針與雙端 UI 按鈕整合 (Content Script)
* **[n-e-extractor.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/content/n-e-extractor.js)** (NEW)：
  * 偵測當前網域，在側邊欄或行動端提出請求時，非同步解析整本漫畫的元數據（總頁數、ID、所有分頁 URL）。
* **[main.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/content/main.js)**：初始化與掛載探針。
* **[src/sidepanel/index.html](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/sidepanel/index.html)** & **[main.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/sidepanel/main.js)**：
  * 當用戶在支援的漫畫網站點擊側邊欄「手動選取」圖片時，在上方「取消全選 / 返回」列旁動態呈現 **`📖 串聯流式閱讀`** 按鈕。
  * 點擊按鈕後與探針通信，將元數據寫入 `chrome.storage.local` 的 `mt_current_stream`，並打開 `stream-reader.html`。
* **[src/mobile/main.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/mobile/main.js)**：
  * 行動版進入選取圖片介面時，在「全選 / 取消」按鈕旁動態注入 **`⚡ 串聯流式閱讀`** 按鈕，並綁定相同的預載與跳轉機制。

### 4. 流式集中閱讀沙盒 (UI Page)
* **[stream-reader.html](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/reader/stream-reader.html)** (NEW)：
  * 現代化玻璃擬物化頂部控制面板，配置了寬度縮放滑桿、全頁翻譯、打包下載 ZIP、主題切換及章節導航。
* **[stream-reader.css](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/reader/stream-reader.css)** (NEW)：
  * 流暢的 Dark/Light 主題切換過渡，精緻的流式條漫垂直居中排列樣式。
* **[stream-reader.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/reader/stream-reader.js)** (NEW)：
  * **流式加載**：整合 **Intersection Observer**，當用戶滾動至圖片視區時，才異步請求背景抓取該頁 HTML 並渲染圖片，防抖且節省流量。
  * **獨立/全頁翻譯**：提供單頁「⚡ 翻譯此頁」與頂部「⚡ 全頁翻譯」，多執行緒輪詢翻譯佇列，並於頂部提供即時翻譯進度條，將譯文層精準覆蓋在圖片下方。
  * **打包下載**：點擊 `📦 打包下載` 即時打包所有已載入圖片為一個 ZIP 檔案。

---

## 🧪 建議實機驗收指南 (GUI Test Guide)

請您加載最新編譯好的 `dist-v3` 目錄至您的瀏覽器，並依照以下步驟進行實機 GUI 驗收：

1. **按鈕注入驗收**：
   * 進入 nhentai 或 e-hentai / exhentai 任一漫畫詳情首頁。
   * **PC 端**：開啟擴充功能側邊欄 ➡️ 點擊「手動選取」，驗證上方控制列是否成功出現 **`📖 串聯流式閱讀`** 的精美紫色按鈕（在非支援網站此按鈕會自動隱藏）。
   * **行動端**：開啟行動版手動選圖介面，驗證「全選/取消」旁是否正確注入了 **`⚡ 串聯流式閱讀`** 按鈕。
2. **預載與跳轉驗收**：
   * 點擊按鈕，按鈕文字將變更為「⏳ 正在讀取詳情...」，隨後會自動開啟新分頁跳轉至流式條漫閱讀器。
3. **滾動加載與寬度滑桿驗收**：
   * 在條漫閱讀器中向下滾動，觀測圖片是否在進入視區時，正確發送非同步請求抓取分頁 HTML，並順暢顯示真實圖片。
   * 拖曳頂部控制列的「🔍 寬度」滑桿，確認所有圖片能滑順地同步縮放。
4. **流式翻譯與打包下載驗收**：
   * 滑鼠移至任一張圖片，點擊其上方的 `⚡ 翻譯此頁`，確認日中雙語譯文對照能精準貼在圖片下方。
   * 點擊頂部的 `⚡ 全頁翻譯`，驗證進度條跑滿後，所有圖片皆完美展現出譯文對照。
   * 點擊頂部的 `📦 打包下載`，驗證瀏覽器是否彈出整本漫畫的 ZIP 壓縮下載，且解壓後圖片順序編號完全正確。

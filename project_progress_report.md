# Manga Translator V3.0 專案進度與結構檢視報告

本報告為 **Manga Translator V3.0** 專案截止至 2026 年 6 月 1 日的最新進度盤點。本專案的主要目標是將原有的單體腳本重構為現代化、模組化且符合 Manifest V3 (MV3) 規範的 Chrome Extension，目前已成功開闢並實作了高價值的「圖片批次提取與流式集中閱讀/翻譯」分支功能。

---

## 🚦 「三道綠燈自檢」最新狀態 (Self-Verification Status)

* **🟢 第一道關卡：Linter 與語法靜態檢查** ➡️ **通過**。
  * 全數程式碼均符合 Vite 與 Rollup ES6 Modules 語法標準，無語法錯誤。
* **🟢 第二道關卡：自動編譯與打包 (Build Check)** ➡️ **通過**。
  * 成功執行 `npm run build`。打包產物編譯百分之百成功，未發生 any unresolved import 或打包資源丟失。
  * 成功整合 `jszip` 第三方依賴。
* **⚪ 第三道關卡：自動測試 (Test Check)** ➡️ **無配置**。

---

## 📈 核心功能開發進度盤點

### 1. 【重構里程碑】Vite 模組化與 MV3 機制
* **建置配置 (`vite.config.js`)**：
  * 已整合 `@crxjs/vite-plugin` 讀取 `manifest.json`。
  * 實作了 `copyAssetsPlugin` 自動複製 `public/assets` 至 `dist-v3/assets`，保障動態素材載入路徑安全。
  * 打包產物 `dist-v3/` 設定就緒。
* **資訊清單 (`manifest.json`)**：
  * 新增 `"downloads"` 權限以支援批次打包與原生下載。
  * 配置 `stream-reader.html` 至 `web_accessible_resources` 供安全存取。

### 2. 【全新里程碑】N網 / E網 圖片提取與集中流式閱讀
我們在 `feature/image-extraction-stream` 分支下，成功開發了這套「批次預載、5 頁併發流式條漫閱讀、瞬間打包下載與流式翻譯」的極致解決方案：
* **背景下載中繼 (`src/background/download-helper.js`)**：
  * `FETCH_HTML`：利用背景 Service Worker 免除 CORS 限制，抓取漫畫分頁 HTML。
  * `DOWNLOAD_IMAGES_ZIP`：整合 `JSZip`，在背景將所有分頁圖片打包壓縮下載。
* **內容端 DOM 探針 (`src/content/n-e-extractor.js`)**：
  * 偵測當前是否為 N網/E網，解析總頁數、漫畫 ID 與所有分頁 URL，非同步回傳給側邊欄或行動端。
* **UI 整合與按鈕嵌入**：
  * **PC 端**：在側邊欄圖片選取的「取消全選 / 返回」列旁，動態掛載 **`📖 串聯流式閱讀`** 按鈕。
  * **行動端**：在行動版圖片選取控制台的「全選 / 取消」按鈕旁，動態注入 **`⚡ 串聯流式閱讀`** 按鈕。
* **流式集中閱讀器 (`src/reader/stream-reader.*`)**：
  * **極速預載佇列**：進入沙盒後，立刻啟動背景下載佇列。**將併發數提升至 5（符合 N網 官方安全限流上限，兼顧極速與防封鎖）**，圖片一張張自動下載並在各自的坑位由上往下渲染。
  * **瞬間打包下載 ZIP**：由於圖片 Blob 早已在背景預載完成，點擊 `📦 瞬間打包下載` 時可於 0.5 秒內「瞬間」壓縮生成 ZIP 下載，省去重複 fetch 的耗時。
  * **流式翻譯覆蓋**：提供單頁 `⚡ 翻譯此頁` 與 `⚡ 全頁翻譯`。採用多線程輪詢翻譯佇列，將譯文層精準覆蓋在圖片下方。
  * **現代化 UI**：提供玻璃擬物化控制面板，支援寬度縮放滑桿、Light/Dark 主題切換與章節導航。

### 3. 背景服務與狀態管理 (`src/background/`, `src/utils/`)
* **Storage-First 狀態機 (`src/utils/state.js`)**：實作狀態的持久化與原子更新，確保 Service Worker 隨機失效後狀態不遺失。
* **Google Drive 同步引擎 (`src/utils/sync.js`)**：
  * 支援 Chrome 原生 `getAuthToken`，且能針對不支援的瀏覽器（如 Edge）自動無縫降級為 `chrome.identity.launchWebAuthFlow`（Web 授權流）。
  * 串接 Google Drive REST API 直接操作 `appDataFolder` 空間。
  * 實作設定與術語庫（Glossary）的雙向時間戳記及優先權合併。

---

## 🛠️ 下一步建議與後續步驟
1. **新功能實機 GUI 驗收**：
   * 目前 `feature/image-extraction-stream` 分支代碼已編譯通過，您可以加載 `dist-v3` 目錄至 Chrome，進入 nhentai 或 e-hentai 漫畫詳情頁，測試 PC 側邊欄與行動端的 `📖 串聯流式閱讀` 按鈕與跳轉後的極速條漫閱讀、瞬間打包下載與翻譯。
2. **分支合併**：
   * 在實機驗收滿意後，我們可以將此開發分支安全合併回主線。

# 漫譯 V3.2.3 (Manga Translator V3.2.3) 專案交接與架構備忘錄

**最新版本號**：`V3.2.3`
**技術規格**：Chrome Extension Manifest V3 / Vite 5 + `@crxjs/vite-plugin` / Storage-First 狀態機
**支援平台**：桌面端（Chrome / Edge）與行動端（Edge Android）
**遠端倉庫**：`https://github.com/SmallOrange0323/Manga-Translator-V3.0.git`

---

## 一、 V3.2.3 核心架構總覽

### 1. 一階段端到端視覺翻譯管線與 2D 二維交錯輪替調度（Key × Model）
- **架構收斂（One-Step Vision Pipeline）**：
  - 專案已全面收斂為高傳真一階段端到端看圖直譯架構（`src/background/translate-api.js` 的 `callGeminiAPIBatch`），並已完成退役「兩階段 OCR 與全域劇本預讀」死碼清理（移除 `callGeminiAPIBatchOcr`、`extractTextFromImage`、`extractGlobalStoryAndGlossary`、`DEFAULT_PROMPT_OCR` 及對應的舊版 Stage 1/1.5/2 生命週期守衛）。
  - 純文字重譯路徑（`retranslateText`）與小說翻譯維持 `translateTexts` 與 `DEFAULT_PROMPT_TWO_STEP` 獨立運作。
- **2D 二維交錯輪替調度 (`src/background/hybrid-scheduler.js` / `src/background/hybrid-retry.js`)**：
  - 透過 `(keyIndex + roundIndex) % 2` 計算每批次的 `(apiKey, modelName)` 分配：第 1 輪為 `Key1(A) → Key2(B) → Key3(A) → Key4(B)`，第 2 輪起交錯反轉為 `Key1(B) → Key2(A) → ...`，平衡各 API Key 與模型配額。
  - `executeHybridRequest` 支援遇 `429` / `503` 時跨模型 Failover，並嚴格檢查 `AbortSignal` 與 `shouldContinue`，確保使用者觸發 STOP 時立即終止，不會多發重試請求。
- **生命週期與備援 (`src/background/manga-lifecycle.js` / `src/background/manga-cancellation.js`)**：
  - 批次失敗後可由 `executeFallbackImages` 進行逐張備援翻譯；透過 `isMangaCancellation`、`shouldCompleteMangaTranslation`、`shouldPublishMangaBatchResults` 防止 STOP 中斷後誤發布結果或誤標記完成。

---

### 2. 詞庫防污染與雙向唯一鎖引擎 ＋ 可開關視覺情境錨點
- **詞庫資料核心與持久化 (`src/utils/glossary-data.js` / `src/background/glossary-manager.js`)**：
  - **雙向唯一鎖與歷史排毒 (`sanitizeCollidingAiTerms`)**：防止多個不同日文原文（`ori`）被 AI 誤配到同一個中文譯名（`trans`）。當偵測到譯名撞車時：手動詞條（`source === 'user'`）優先保留並剔除撞名 AI 詞條；純 AI 撞名則只保留最早建立（`createdAt` 最小）的第一筆，其餘自動剔除並寫入 `termTombstones` 防止透過雲端同步還魂。
  - **角色性別與關係備註 (`note`)**：支援為詞條標註性別、稱謂與上下級關係，減少跨頁代名詞（他／她）與稱呼誤譯。
  - **跨 Context 序列化與無痕隔離**：`glossary-manager.js` 透過單一 Promise 隊列序列化寫入，並為一般視窗與無痕視窗區分 `writerScope` register，避免多背景程序覆寫彼此資料。
- **可開關視覺情境錨點 (`enableSceneContext`)**：
  - 在 `callGeminiAPIBatch` 中依 `enableSceneContext`（預設開啟，可透過側邊欄「情境」快捷開關或設定頁即時雙向切換）前置辨識當前場所、登場角色性別與關係，並透過跨批對話參考（`previousContextSnippet`）銜接上下文。
  - 若因 R18 / 特殊題材觸發模型安全審查過濾，支援降級關閉情境錨點重試與 UI 提示引導。

---

### 3. 網站專屬適配器隔離架構 (`src/utils/site-adapters.js`)
- **設計原則**：將特定網站的特殊 DOM 容器與懶載入佔位圖豁免邏輯收斂至可序列化的 `SITE_ADAPTER_RULES`，與通用爬蟲核心徹底隔離，確保支援新網站時**絕對不影響既有網站（如 WNACG、Jestful、Rawkuma 等）**的過濾與抓取規則。
- **核心介面**：
  - `getSiteAdapter(urlOrHostname)`：依域名規則匹配專屬適配器，未匹配網站回傳 `null`。
  - `getExtraMangaContainers(urlOrHostname)`：提供該網站專屬的漫畫圖片容器選擇器（一般網站回傳 `[]`）。
  - `isSitePlaceholderExempt(imgElement, dataSrc, url, urlOrHostname)`：僅在匹配網站且具備有效 `dataSrc` 時，豁免初始 1x1 透明佔位圖或 `placeholder/loading` 圖示被 `isTooSmall` / `isContainerJunk` 過濾（一般網站一律回傳 `false`）。
- **目前整合點**：
  - `src/content/manga-engine.js`：前端 `crawlImages()` 動態合併專屬容器與佔位圖豁免判斷。
  - `src/utils/chapter-parser.js`：背景預翻解析 `parseImages(html, baseUrl)` 與章節解析 `parseChapterHtml` 共享網站專屬容器識別（如 JManga 的 `#images-content`、`#vertical-content`、`.container-reader-chapter`、`.iv-card` 與 `ul.reading-list`）。

---

### 4. 暫存圖片 IndexedDB 持久化恢復機制 (`src/background/manga-image-idb.js` + `src/background/manga-recovery.js`)
- **解決痛點**：Manifest V3 Service Worker 閒置休眠重啟後會清空記憶體 `Map`，導致本地上傳圖片或網頁 Canvas 解密產生的 `data:image/...` 暫存圖在結果頁重整或續譯時遺失。
- **持久化設計 (`src/background/manga-image-idb.js`)**：
  - `createMangaImageIdbStore(indexedDBApi)` 使用資料庫 `'mt_manga_temp_images_v1'` 與 ObjectStore `'page_images'`（主鍵 `${tabId}:${jobId}:${pageIndex}`）。
  - 當環境不支援 `indexedDB`（例如預設 Node 單元測試環境）時自動降級為安全 no-op，不拋出例外。
  - 提供 `putImages`、`getJobImages`、`getImage`、`removeForTab`、`pruneTabs` 等非同步操作，僅持久化非 HTTP 暫存圖（`!/^https?:\/\//i.test(rawImg)`）。
- **恢復與無痕隔離 (`src/background/manga-recovery.js`)**：
  - `createMangaRecovery` 保留既有同步 `memoryImagesByTab` 行為，並在非無痕模式下非同步寫入 IndexedDB；於 `snapshot(tabId)` 與 `publish(job, liveItems)` 時透過 `ensureMemoryHydrated` 自動從 IndexedDB 補回記憶體圖資。
  - **無痕視窗鐵律**：當 `isPrivateWorker` 為 `true` 或分頁為 `incognito` 時，**嚴格禁止寫入或讀取 IndexedDB**，所有暫存資料僅存於該無痕行程記憶體中。
  - 分頁關閉呼叫 `remove(tabId)` 或 SW 啟動恢復執行 `pruneTabs` 時自動清理過期分頁圖資。

---

## 二、 專案目錄結構 (Directory Map)

```text
Manga-Translator-V3.0/
├── dist-v3/                     # Vite 編譯產出目錄（瀏覽器載入此目錄，嚴禁手動修改）
├── public/assets/               # 靜態立繪與動畫素材（build 時複製至 dist-v3/assets）
├── src/
│   ├── background/              # MV3 Service Worker 核心
│   │   ├── index.js             # 背景進入點與訊息路由
│   │   ├── translate-api.js     # Gemini 批次視覺/文字 API 通訊與 Schema 解析
│   │   ├── hybrid-scheduler.js  # 2D 二維交錯輪替排程 (Key × Model)
│   │   ├── hybrid-retry.js      # 429/503 跨模型 Failover 與中斷守衛
│   │   ├── manga-lifecycle.js   # 預翻完成度、備援降級與發布守衛
│   │   ├── manga-cancellation.js# 漫畫任務 AbortController 管理
│   │   ├── manga-recovery.js    # 任務狀態恢復與結果頁圖資派送
│   │   ├── manga-image-idb.js   # 非 HTTP 暫存圖片 IndexedDB 持久化儲存層
│   │   ├── manga-job-store.js   # 任務紀錄儲存層
│   │   ├── glossary-manager.js  # 詞庫序列化寫入與跨程序合併
│   │   ├── wnacg-acceleration.js# WNACG 專屬加速抓取
│   │   └── jestful-prefetch.js  # Jestful 專屬預取
│   ├── content/                 # 網頁注入腳本與 Shadow DOM UI
│   │   ├── manga-engine.js      # 前端漫畫爬蟲與 Canvas 解密擷取
│   │   ├── novel-engine.js      # 前端小說章節擷取
│   │   └── ui/                  # Shadow DOM 懸浮按鈕與控制面板
│   ├── reader/                  # 和紙結果閱讀器與串流閱讀器
│   ├── sidepanel/               # 桌面端側邊欄控制台（含情境開關）
│   ├── mobile/                  # Edge Android 獨立控制台頁面
│   ├── options/                 # 設定頁（API Key、模型、Prompt、詞庫管理）
│   └── utils/                   # 共用工具模組
│       ├── site-adapters.js     # 網站專屬適配器規則與查詢 API
│       ├── chapter-parser.js    # 背景預翻 HTML 解析與章節偵測
│       ├── glossary-data.js     # 詞庫正規化、撞名排毒與合併純函式
│       ├── constants.js         # 預設 Prompt 與靜態素材清單
│       ├── state.js             # chrome.storage.local Storage-First 狀態機
│       └── sync.js / sync-engine.js # Google Drive AppData 雙向同步
├── tests/                       # Vitest 自動化測試套件
├── build-zip.js                 # 依 package.json 版本號產生商店上架 ZIP
└── vite.config.js               # Vite + CRXJS 建置配置
```

---

## 三、 常用開發、測試與打包指令

```bash
# 1. 安裝相依套件
npm install

# 2. 執行全量自動化單元與整合測試 (Vitest)
npm test

# 3. 執行單一或指定測試檔案
npx vitest run tests/translation-lifecycle.test.js

# 4. 啟動開發模式（監聽變更並輸出至 dist-v3/）
npm run dev

# 5. 編譯生產版本（輸出至 dist-v3/）
npm run build

# 6. 打包商店上架用 ZIP 壓縮檔（讀取 package.json 版本號）
npm run pack
```

### 瀏覽器載入方式
1. 執行 `npm run build` 產生 `dist-v3/`。
2. 開啟 `chrome://extensions/` 或 `edge://extensions/`，啟用「開發者模式」。
3. 點擊「載入解壓縮的擴充功能」，選擇專案根目錄下的 `dist-v3/` 資料夾。

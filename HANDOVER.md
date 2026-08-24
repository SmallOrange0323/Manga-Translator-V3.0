# 漫譯 V3.1.5 (Manga Translator V3.1.5) 專案交接與進度備忘錄

**文件生成時間**：2026-08-24  
**目前 Git 分支**：`feature/prompt-xml-upgrade`  
**最新版本號**：`V3.1.5`  
**遠端倉庫**：`https://github.com/SmallOrange0323/Manga-Translator-V3.0.git`  
**工作區狀態**：已全面升級為 **V3.1.5**。完成【跨話無縫連續追漫與自動預翻機制 (Seamless Next-Chapter Pipeline：閱讀當前話時背景靜默預翻下一話 + 結果頁 0ms 原地秒開 SPA 換話 + 鏈式接力 + 分頁關閉自動銷毀快取)】、【整批觸發模型審查拒絕 (SAFETY / BLOCKLIST / Prohibited Content) 於第一張卡片呈現專屬朱紅警示橫幅與自癒重試指引】、【4 大經典字型即時切換系統（宋體/圓體/源石黑體/楷體）+ 偏好持久化記憶】、【極簡純粹導航列（上一話/下一話）】、【Google OAuth 2.0 雙平台通用 Client ID 配置打通】、【詞庫 Key 智慧歸一化與歷史重複詞庫自動合併去重】與【滿版漢字「漫」全新圖示升級】。已通過 Vite 生產構建並產出最新三款 `Manga_Translator_V3.1.5_Store_Package*.zip`。

---

## 💻 一、 家用電腦無縫接手指令 (Quick Start for Home PC)

回到家裡電腦打開終端機，執行以下指令即可拉取最新環境：

```bash
# 1. 切換至目標分支並拉取最新程式碼
git fetch origin
git checkout feature/prompt-xml-upgrade
git pull origin feature/prompt-xml-upgrade

# 2. 安裝依賴套件 (如有更新)
npm install

# 3. 執行編譯與上架 ZIP 打包
npm run build
npm run pack
```

---

## 🚀 二、 本次工作區間完成之重大里程碑與功能

### 1. 🏪 Edge 商店審核與版本號升級 (`3.0.1`)
- **版本號升級**：將 `package.json` 與 `manifest.json` 同步由 `3.0.0` 升級為 **`3.0.1`**，解決 Microsoft Partner Center「版本號必須高於前版」的提交限制。
- **動態打包腳本**：更新 `build-zip.js`，自動讀取 `package.json` 的版本號動態產出上架檔名：
  - `Manga_Translator_V3.0.1_Store_Package.zip` (9.59 MB)
  - `Manga_Translator_V3.0.1_Store_Package_Light.zip` (2.80 MB)
- **認證注意事項範本**：已擬定專業的「認證注意事項 (Notes for Certification)」測試說明文案，可直接複製貼入合作夥伴中心。

---

### 2. 📱 行動端 (Edge Android) 兩大體驗痛點修復
- **解除批次容器橫滑綁定 (單頁 100vw 平滑滑動)**：
  - 修復 `result.css` 中 `.batch-section` 容器干擾 `scroll-snap` 的問題，讓每張卡片 (`.result-card`) 重獲獨立單頁寬度。
  - 在手機上往左右滑動時，實現精準 1 頁 1 頁切換，徹底消除「滑一次跳過一整批 10 頁」的問題。
- **翻譯面板與頁碼實時動態連動**：
  - 在 `result.js` 中優化 `IntersectionObserver` 滾動感測，滑動至 P.2、P.3 時，浮動按鈕與彈窗自動實時更新為「📖 查看 P.2 翻譯」、「📄 P.2 翻譯內容」，譯文 100% 對應當前頁面。
- **行動控制台主動觸發串流按鈕**：
  - 在 `src/mobile/index.html` 內置主動按鈕：`⚡ 啟動串聯流式閱讀 (N網/E網專屬)`。
  - 即使宿主網頁沒有成功注入按鈕，使用者也能在行動控制台隨時點擊主動開啟集中流式閱讀器。

---

### 3. 📖 雙階段模式 (Two-Step Story Pipeline) 重大升級
將原本預留的「雙階段模式」重構為**「全書劇本預讀 ➔ 單話劇情暫存 ➔ 帶全域背景 Vision 精翻」**的高品質工作流：

#### 🏛️ 核心資料分層設計：
1. **長期持久層 (Persistent Glossary)**：
   - 僅長期存放作品通用名詞、角色日中對照、招式名。
   - 透過 `saveGlossary(mangaKey, terms)` 跨話數持久化保存。
2. **短期任務暫存層 (Episodic Session Context)**：
   - 存放於當次任務記憶體變數 `sessionStoryContext[resultTabId]`。
   - 包含：`storySummary` (當話劇情大綱)、`characterRelationships` (角色互動與稱謂)。
   - **任務完成後自動釋放，絕不污染長期詞庫，更不干擾後續話數的獨立劇情！**

#### 🔄 雙階段三步執行流程：
- **階段 1 (OCR 劇本提取)**：依 `ocrBatchSize` 使用指定的 `ocrModelName` 提取全書日文對白，拼成純文字劇本。
- **階段 1.5 (全域劇本通讀)**：發送 **1 次輕量純文字請求 (`extractGlobalStoryAndGlossary`)**，大模型 1 秒讀完全書台詞，萃取大綱與角色設定。
- **階段 2 (帶背景精翻)**：封裝【暫存劇情 + 暫存角色稱謂 + 術語庫】為 `sessionContextSnippet`，進行批次 Vision 精翻。

#### ⚙️ 設定頁面 (`options`) UI 升級：
- 選擇雙階段模式時，自動展開「階段一：文字辨識 OCR 模型」下拉選單：
  - `Gemini 3.1 Flash-Lite (推薦)`
  - `Gemini 3.5 Flash-Lite`
  - `Gemma 4 26B (視覺專用)`
  - `💻 瀏覽器本地端 OCR (WebAssembly / 0 API 消耗 / 支援手機)`
- **一條龍模式 (One-Step)** 100% 保持現狀，雙軌並行互不干擾。

---

## 📁 三、 核心異動檔案清單 (Key Files Modified)

| 檔案路徑 | 異動摘要 |
| :--- | :--- |
| `manifest.json` / `package.json` | 升級版本號至 `3.0.1` |
| `build-zip.js` | 支援動態讀取版本號產出 ZIP 檔案 |
| `src/background/translate-api.js` | 新增 `extractGlobalStoryAndGlossary` 與 `extractTextFromImage` |
| `src/background/index.js` | 實作 `processMangaBatchTwoStepMode`、`dispatchMangaBatchProcessing` 與 `sessionStoryContext` 短期暫存 |
| `src/options/index.html` | 新增 `ocrModelContainer` 與本地端 WASM OCR 選項 |
| `src/options/main.js` | 新增模式切換動態展開 OCR 選擇區事件 |
| `src/reader/result.css` | 解除 `.batch-section` 對 `scroll-snap` 的綁定，實現單頁 100vw 橫滑 |
| `src/reader/result.js` | 實作行動版頁碼與浮動面板實時動態連動 |
| `src/mobile/index.html` / `main.js` | 新增主動觸發 `⚡ 啟動串聯流式閱讀` 按鈕與事件綁定 |

---

## 🎯 四、 家用電腦接手後的測試重點 (Verification Checklist)

1. **一條龍模式驗證**：在設定頁選「⚡ 一條龍模式」，開啟任意漫畫，確認即時分批看圖直翻功能運作正常。
2. **雙階段模式驗證**：在設定頁切換為「📖 雙階段劇本預讀模式」，觀察背景是否依序執行：
   - 階段 1：提取全書劇本。
   - 階段 1.5：通讀劇本並輸出劇情大綱（確認記憶體暫存，不污染詞庫）。
   - 階段 2：帶著全域背景輸出精翻。
3. **行動版閱讀體驗**：使用手機 Edge 開啟 `result.html`，測試左右單頁滑動與翻譯面板頁碼連動。

# 漫畫翻譯器 V3.0 (Manga Translator V3.0)

![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)
![Manifest](https://img.shields.io/badge/Manifest-V3-green.svg)
![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Edge%20Android-informational.svg)

**漫畫翻譯器 V3.0** 是一款現代化、功能強大的瀏覽器翻譯擴充套件。專為漫畫與小說愛好者打造，提供極速流暢的集中閱讀體驗、精緻的圖文對照對話框翻譯，以及完美適配手機與電腦全平台的閱讀環境。

---

## 🌟 核心功能特色

### 🎨 1. 經典對照結果頁與獨立重翻譯 (`result.html`)
- **圖文並排對照與對話框編輯**：桌機版支援左右圖文對照，行動端支援順暢滑動；可隨時點擊文字框進行校對與修改。
- **靈活的雙重重翻譯**：
  - **`🔄 重新翻譯全漫畫`**：一鍵將整本作品交給 AI 重新翻譯。
  - **`⚡ 重翻指定批次`**：將漫畫自動分組，您可以只選擇重翻出錯的特定小批次，完全不影響其他已經翻好的頁面。
- **閱讀體驗優化**：自動淨化譯文格式，去除多餘的換行，拼接為連貫順暢的句子，最適合漫畫對話框閱讀。
- **一鍵跳轉翻譯**：在流式閱讀器中瀏覽漫畫時，點擊「🚀 開新分頁全本翻譯」即可自動帶入結果頁進行對照翻譯。

### 📖 2. 條漫集中流式閱讀器 for E網與N網 (Stream Reader)
- **免等待極速載入**：直接擷取漫畫媒體庫，打開頁面瞬間載入圖片，遠離載入轉圈圈與限制。
- **全自動依序背景預載**：開啟閱讀器後，系統會自動在背景按順序下載整本漫畫圖片，完全不需要您手動往下滑動。
- **看哪裡先載哪裡**：若您快速滑動到後面的頁面，系統會優先下載您當前正在看的頁面，帶來流暢無卡頓的閱讀體驗。
- **自動斷線救援**：遇到網路波動或伺服器繁忙時，系統會自動重試並救援失敗的圖片，確保整本漫畫 100% 完整載入。

### 📦 3. 一鍵打包下載與多格式匯出
- **整本漫畫 ZIP 打包**：預載完成後，點擊「打包下載」按鈕即可將整本漫畫的所有圖片一鍵下載成 ZIP 壓縮檔。
- **多元匯出**：支援將翻譯結果一鍵儲存為 HTML、PDF 或 TXT 文字檔。

### 📱 4. 行動端 (Edge Android) 專屬優化
- **極速觸控響應**：針對手機觸控螢幕優化，點擊與選擇圖片無延遲。
- **按鈕防鎖死與自動恢復**：解決手機切換 App 或背景時按鈕灰掉鎖死的問題，切回瀏覽器時自動恢復點擊活性。

---

## 🏗️ 技術架構與設計細節 (For Developers)

本章節為開發者提供 MV3 專案的底層技術細節：

| 模組 / 功能 | 技術實現細節 |
| :--- | :--- |
| **建置系統** | Vite 5 + `@crxjs/vite-plugin` 防禦性 MV3 建置 |
| **網頁解析** | **0-HTML Direct CDN Engine**：直連媒體庫 `media_id` 解析，避免 200+ HTML 分頁爬蟲請求 |
| **預載與佇列** | **Self-Healing Queue**：背景 5 Worker 併發 + 可見區域 `IntersectionObserver` VIP 插隊 + 4秒心跳監控 |
| **狀態管理** | **Storage-First 狀態機**：基於 `chrome.storage.local`，SW 重啟進度無縫恢復 |
| **UI 隔離** | Shadow DOM 注入，完全隔離宿主網頁 CSS |
| **壓縮下載** | **JSZip (Base64 Data URL 模式)**：解決 Service Worker 環境下禁用 `URL.createObjectURL` 的限制 |
| **行動端適配** | `touch-action: manipulation` 消除 300ms 觸控延遲 + 5秒超時自動解鎖定時器 |
| **譯文處理** | `sanitizeTranslationText` 強力過濾 `\n` 並自動拼合長句 |

---

## 📁 專案結構 (Directory Map)

```
Manga-Translator-V3.0/
├── dist-v3/             # Vite 打包產出目錄（擴充功能載入此目錄）
├── src/
│   ├── background/      # Service Worker 背景服務、下載中繼 (download-helper.js)
│   ├── content/         # 網頁探針、Shadow DOM UI、N網/E網 提取器 (n-e-extractor.js)
│   ├── reader/          # 閱讀器組件 (result.html/js, stream-reader.html/js)
│   ├── sidepanel/       # 桌機版側邊欄控制台
│   ├── mobile/          # 行動端 (Edge Android) 專屬獨立 App 控制頁面
│   └── utils/           # 狀態機 (state.js)、雲端同步 (sync.js)、常數與日誌
├── build-zip.js         # 商店與套件 ZIP 自動打包腳本
└── vite.config.js       # Vite + CRXJS 建置配置
```

---

## 🚀 安裝與開發說明

### 1. 安裝依賴與啟動開發
```bash
npm install
npm run dev
```

### 2. 生產打包
```bash
npm run build
npm run pack
```

### 📥 載入擴充功能 (Unpacked Installation)
1. 前往瀏覽器擴充功能頁面（`chrome://extensions/`）。
2. 開啟右上角的 **「開發者模式 (Developer Mode)」**。
3. 點擊 **「載入解壓縮擴充功能 (Load Unpacked)」**，選擇專案中的 **`dist-v3`** 資料夾即可。

---

## 📜 授權協議 (License)

MIT License © 2026 Manga Translator Team

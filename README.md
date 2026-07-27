# 漫畫翻譯器 V3.0 (Manga Translator V3.0)

![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)
![Manifest](https://img.shields.io/badge/Manifest-V3-green.svg)
![Build](https://img.shields.io/badge/Build-Vite-blueviolet.svg)
![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Edge%20Android-informational.svg)

**Manga Translator V3.0** 是一個基於 Chrome Extension Manifest V3 規範現代化重構的瀏覽器擴充套件。專為漫畫與小說愛好者設計，提供高穩定度、極速圖片預載、經典圖文對照與行動端優化的全方位翻譯解決方案。

---

## 🌟 V3.0 核心亮點與功能特點

### 📖 1. N網 / E網 集中流式閱讀器 (Stream Reader)
- **0-HTML 直連 CDN 媒體庫解析引擎 (Direct CDN Engine)**：
  - 參考專業下載軟體（如 *Tachiyomi* / *Gallery-DL*）技術，直接從詳情頁提取媒體庫 ID (`media_id`) 與縮圖副檔名。
  - **0 次背景 HTML 請求**，直接推導生成 200+ 頁圖片的直連 CDN 網址，100% 繞過伺服器 Rate-Limit 429 封鎖。
- **全自動依序背景預載 (Auto-Sequential Preload)**：
  - 開啟頁面即自動啟動 5 條 Worker 全自動從第 1 頁排隊預載全本圖片，完全無需手動往下滑動。
- **可見區域 VIP 動態插隊 (Observer VIP Priority)**：
  - 當手動滑動至特定頁面時，該頁自動置頂至預載佇列最前端享秒速下載。
- **自癒式不死預載佇列 (Self-Healing Queue & Heartbeat)**：
  - 遇到網路繁忙時，受阻圖片自動重推回佇列末尾並拉長休眠；配合 4 秒心跳監視器，確保全本 100% 自動下載完畢永不中斷。

### 🎨 2. 經典結果頁與雙重重翻控制 (`result.html`)
- **精緻圖文對照與對話框校對**：
  - 桌機版左右圖文對照，行動端平滑滑動；支援即時對話框文字編輯與校對。
- **雙軌獨立重翻譯機制**：
  - **`🔄 重新翻譯全漫畫`**：一鍵將整作品圖片重新發送 AI 翻譯。
  - **`⚡ 重翻指定批次`**：卡片依 `📦 批次 #1`, `#2` 自動包裹於獨立區塊，標頭帶有獨立重翻按鈕，支援單獨重翻特定批次（如重翻第 4 批次，100% 原地歸位不竄改其他批次）。
- **強效譯文淨化過濾 (`sanitizeTranslationText`)**：
  - 自動過濾移除譯文中的所有 `\n` 與多餘換行，拼接為無縫單一連貫長句，徹底提升漫畫對話框閱讀體驗。
- **🚀 串流模式一鍵開新分頁翻譯**：
  - 串流閱讀器頂部配有「🚀 開新分頁全本翻譯」按鈕，可將流式閱讀器快取的圖片打包發送至獨立結果頁進行翻譯對照。

### 📦 3. Manifest V3 專用 Base64 ZIP 打包與多格式匯出
- **Service Worker 相容 Base64 ZIP 打包**：
  - 針對 MV3 Service Worker 禁用 `URL.createObjectURL` 的限制，採用標準 `data:application/zip;base64,` 轉譯，實現一鍵點擊秒級發起全本漫畫 ZIP 下載。
- **多格式匯出**：
  - 支援一鍵匯出 HTML / PDF / TXT 等格式。

### 📱 4. 行動端適配與抗凍結防護 (Edge Android Optimization)
- **`touch-action: manipulation;` 觸控加速**：
  - 徹底消滅 Android 系統 300ms 點擊延遲與滑動手勢吸收，點擊秒響應。
- **按鈕 5 秒超時自動解鎖保險 (Auto-Unlock Safety Timer)**：
  - 解決 Android WebView 切換 App 背景凍結導致按鈕灰掉鎖死問題，5 秒自動復甦。
- **頁面切回自癒 (`visibilitychange`)**：
  - 重獲焦點時自動檢查並恢復 UI 活性與掃描狀態。

### ☁️ 5. Storage-First 狀態機與雲端同步刷新
- **雲端金鑰即時刷新 (`refreshCache`)**：
  - 解決雲端金鑰同步至 `chrome.storage.local` 後選項頁面與狀態機未即時感知的痛點。
- **API 金鑰輪詢與自動降級**：
  - 多 Key 並列與模型自動降級 (如 Gemini 系列)，確保翻譯穩定不中斷。

---

## 🏗️ 技術架構 (Tech Stack)

| 模組 | 使用技術 / 規範 |
| :--- | :--- |
| **建置工具** | Vite 5 + `@crxjs/vite-plugin` |
| **瀏覽器規範** | Chrome Extension Manifest V3 (MV3) |
| **背景服務** | Service Worker (`src/background/index.js`) |
| **UI 隔離** | Shadow DOM (`src/content/`) 隔離宿主網頁 CSS |
| **狀態管理** | `chrome.storage.local` (Storage-First 狀態機) |
| **壓縮打包** | `JSZip` (Base64 Data URL 模式) |

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

## 🚀 開發與建置說明 (Getting Started)

### 1. 安裝依賴
```bash
npm install
```

### 2. 啟動開發模式
```bash
npm run dev
```

### 3. 生產打包與 ZIP 建立
```bash
# 編譯 dist-v3
npm run build

# 打包 ZIP 商店發布包
npm run pack
```

### 📥 載入套件方式 (Unpacked Installation)
本擴充功能主要以封裝套件/解壓縮載入方式使用：
1. 開啟 Chrome 或 Edge 瀏覽器，前往 `chrome://extensions/`。
2. 開啟右上角的 **「開發者模式 (Developer Mode)」**。
3. 點擊 **「載入解壓縮擴充功能 (Load Unpacked)」**。
4. 選擇本專案根目錄下的 **`dist-v3`** 資料夾即可完成載入！

---

## 📜 授權協議 (License)

MIT License © 2026 Manga Translator Team

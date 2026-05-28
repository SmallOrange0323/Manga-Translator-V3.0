# Manga Translator V2.0

![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)
![Manifest](https://img.shields.io/badge/Manifest-V3-green.svg)
![Build](https://img.shields.io/badge/Build-Vite-blueviolet.svg)

Manga Translator V2.0 是一個基於 Chrome Extension Manifest V3 的現代化重構專案。本專案旨在提供更穩定、更流暢的漫畫與小說翻譯體驗，並解決 Service Worker 隨機失效、CSS 污染以及行動端適配等實務痛點。

## 🌟 核心特色

- **防禦性建置系統**：採用 Vite 與 CRXJS，確保 background scripts 與資源路徑在 MV3 環境下穩定運作。
- **Storage-First 狀態機**：以 `chrome.storage.local` 為唯一真理來源，即使 Background 重啟，翻譯進度與 UI 狀態也能瞬間恢復。
- **Shadow DOM 懸浮介面**：透過 Shadow DOM 注入翻譯 UI，完全隔離宿主網頁 CSS，支援桌機與行動端瀏覽器。
- **混合式翻譯引擎**：
  - **漫畫模式**：支援局部預覽與批次圖框畫布。
  - **小說模式**：支援即時串流（Streaming）與預加載（Prefetch）技術，並配備「一鍵整批重試」功能，自動搜集並批次重譯所有失敗段落，實現零延遲閱讀體驗。

## 🏗️ 技術架構

- **建置工具**：Vite + `@crxjs/vite-plugin`
- **狀態管理**：基於 `chrome.storage.onChanged` 的響應式同步機制。
- **UI 策略**：Shadow DOM 注入模式，取代傳統 Popup，提供更好的互動穩定性。
- **資料流**：解耦複雜 JSON 解析，小說模式採用 Text Streaming。

## 🚀 開發說明

### 環境要求
- Node.js (推薦最新 LTS 版本)
- npm 或 pnpm

### 安裝依賴
```bash
npm install
```

### 開發模式
```bash
npm run dev
```
執行後，將 `dist` 資料夾載入 Chrome 擴充功能頁面（開發者模式）。

### 打包編譯
```bash
npm run build
```

## 📁 專案結構

- `src/background/`: 背景服務邏輯（Manifest V3 Service Worker）。
- `src/content/`: 網頁注入腳本、小說解析引擎與 Shadow DOM UI。
- `src/sidepanel/`: 側邊欄 UI 控制中心（包含核心交互面板、小說/漫畫模式開關與一鍵重試等）。
- `src/mobile/`: 行動端（如 Edge Android）專屬 App 頁面路線（跳轉避開 Sidepanel 限制）。
- `src/utils/`: 共用狀態管理（Storage-First）與通訊協議封裝。
- `src/reader/`: 翻譯閱讀器組件。
- `dist/`: Vite 打包後的正式產出目錄（擴充功能載入此處）。

---
*本專案為 Manga Translator Extension 的現代化重構版本。*

# Manga Translator V2.0 開發規範 (AGENTS.md)

## 📌 專案脈絡 (Context)
本專案為 Manga Translator Extension 的現代化重構版本（V2.0）。主要目標是從「單體腳本」重構為符合 Vite 模組化規範的專案，解決 Manifest V3 下 Service Worker 隨機失效的痛點，並實現 PC 模式與行動端（Mobile）的差異化 UI 策略。

## 🛠 技術棧 (Tech Stack)
- **建置工具**：Vite + `@crxjs/vite-plugin`
- **瀏覽器規範**：Chrome Extension Manifest V3
- **狀態管理**：`chrome.storage.local` (Storage-First 狀態機)
- **UI 隔離**：Shadow DOM

## 🗺 目錄地圖 (Directory Map)
- `src/background/`：背景服務邏輯（Manifest V3 Service Worker）。
- `src/content/`：網頁注入腳本與 Shadow DOM UI。
- `src/utils/`：共用工具函式與狀態管理（如 `state.js`）。
- `src/mobile/`：行動端專屬頁面（獨立 App 頁面路線 B）。
- `dist/`：編譯產出目錄（嚴禁手動修改）。

## 📜 執行指令 (Scripts)
- `npm run dev`：啟動開發模式，產出 `dist` 資料夾。
- `npm run build`：打包編譯生產版本。

## 🎯 特有規則 (Custom Rules)
1. **Storage-First 狀態機**：不依賴背景腳本的全域變數，所有關鍵狀態皆持久化於 `chrome.storage.local`。更新狀態時需使用原子更新，防止衝突。
2. **背景通訊協議**：遵循「同步回應回傳 `false`，非同步回應回傳 `true`」原則。所有非同步 Promise 必須加入 `.catch` 攔截，防止通道死鎖。
3. **行動端適配**：Edge Android 不支援 SidePanel，需偵測平台並跳轉至 `src/mobile/index.html`。

## ⚠️ 開發限制 (Constraints)
- **嚴禁寫死路徑**：所有動態載入的資源必須透過 chrome.runtime.getURL 獲取。
- **UI 隔離**：注入網頁的 UI 必須使用 Shadow DOM，嚴禁污染宿主網頁 CSS。

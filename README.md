# 漫譯 V3.1.8 (Manga Translator V3.1.8) 🎌

![Version](https://img.shields.io/badge/version-3.1.8-blue.svg?style=flat-square)
![Manifest](https://img.shields.io/badge/Manifest-V3-green.svg?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Edge%20Android-informational.svg?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-purple.svg?style=flat-square)

**漫譯 V3.1.8** 是一款現代化、具備工業級穩定度與沉浸式和風美學的**跨平台漫畫與小說 AI 翻譯擴充功能**。  
支援電腦端（Chrome / Edge）與手機端（Edge Android），深度整合 Google Gemini 系列多模態模型，提供**2D 二維交錯輪替調度（Key × Model 負載分配）、核心狀態隊列鎖防護、跨話自動連續預翻、流暢無阻的集中閱讀、左右/上下對話框對照、4 大經典字型切換、全書劇本預讀與 Google Drive 雙向雲端同步**！

---

## 🌟 核心功能特色 (Key Features)

### ⚡ 1. 2D 二維交錯輪替調度 (2D Alternating Round-Robin Pipeline: Key × Model)
* **二維交錯輪替 (Key1-A → Key2-B → Key3-A → Key4-B → Round 2: Key1-B → ...)**：
  * **第 1 輪 (Round 0)**：Key 1 ➔ Model A、Key 2 ➔ Model B、Key 3 ➔ Model A、Key 4 ➔ Model B。
  * **第 2 輪 (Round 1)**：一輪結束後由 **Key 1 ➔ Model B** 接棒開始，依序 Key 2 ➔ Model A、Key 3 ➔ Model B、Key 4 ➔ Model A！
  * **第 3 輪 (Round 2)**：回歸 Key 1 ➔ Model A 循環，實現極致的 Key 與模型負載均衡！
* **負載分配與容錯**：多 Key 可協助排程與容錯；若 Key 屬於不同 Gemini API Project，才可能具備獨立 project quota。同一 Project 的多個 Key 仍共享 project-level quota。
* **雙模型分流**：可分散不同模型的 rate-limit / quota 使用；實際速度與額度仍取決於 Google API 當前 quota 與 Project 設定。
* **智慧 429 跨模型容錯 (Failover)**：若單一模型繁忙或撞限，自動 0 毫秒切換另一個模型接力救援。

---

### ⚡ 2. 跨話無縫連續追漫 (Seamless Next-Chapter Pipeline)
* **背景自動預翻**：當讀者在閱讀當前話時，系統已在背景靜默將下一話翻譯就緒。
* **0 毫秒 SPA 原地秒開**：點擊「下一話 ➔」時，畫面不重整、不閃爍，瞬間平滑展開已翻好內容，並鏈式啟動下下一話預翻，享受無縫暢讀到底的極致追漫感！
* **精準生命週期管理**：預翻快取與當前閱讀分頁共存亡，分頁關閉瞬間自動釋放所有快取，零記憶體殘留。

---

### 🔤 2. 4 大經典字型即時切換系統（所見即所得）
* **0 毫秒極速切換**：在結果頁右上角自由切換 4 大經典風格字型，文字瞬間全局變換：
  * 🌸 **典雅宋體** (`Noto Serif TC` / 思源宋體) —— 文藝古風、戀愛、旁白與心聲
  * 🍡 **日漫圓體** (`Zen Maru Gothic` / 萌系圓體) —— 日常搞笑、校園喜劇（最貼近日漫原版對白感！）
  * 🪨 **源石黑體** (`GenSenGothic` / 復古鉛字黑體) —— 少年熱血、戰鬥冒險，兼具俐落好讀與紙本書質感
  * 📜 **古典楷體** (`DFKai-SB` / 標楷體) —— 武俠仙俠、忍術招式與豪邁對白
* **偏好記憶**：自動記錄您喜愛的字體，開啟任何新漫畫自動套用。

---

### 📱 3. 行動端 (Edge Android) 旗艦級體驗
* **100vw 單頁精準橫向滑動 (Horizontal Scroll-Snap)**：專為行動裝置打造，左右滑動時精準逐頁切換，享受如翻閱實體漫畫般的絲滑手感。
* **全域 Bottom Sheet 翻譯抽屜**：隨時由下往上滑出，直覺瀏覽當頁所有對話，橫向滑動卡片時抽屜內容自動同步切換。
* **智慧懸浮按鈕 (FAB)**：滿版和風「漫」字按鈕，支援自由拖曳、邊緣智慧吸附記憶與閒置自動靠邊微縮。

---

### 🧠 3. 雙階段工作流 (Two-Step Pipeline)
* **全書劇本通讀 + 劇情暫存精翻**：
  1. **階段一 (OCR 劇本提取)**：高速提取全書台詞並生成章節大綱與人物關係表。
  2. **階段二 (Vision 視覺精翻)**：結合全書前情提要與上下文，深度潤色每一頁漫畫對白。

---

### 🚫 4. 模型審查拒絕 (Prohibited Content) 專屬警示與自癒指引
* 當漫畫畫面或台詞觸發 AI 安全過濾器 (`SAFETY` / `BLOCKLIST`) 時：
* **首張卡片自動呈現 Prohibited 朱紅警示橫幅**，清晰標註受限原因並提供單頁重試與純文字翻譯指引。

---

### ☁️ 5. Google Drive 專屬沙盒雙向雲端同步 (OAuth 2.0)
* **雙平台通用授權**：電腦端 Chrome / Edge 與手機端 Edge 均可一鍵登入各自的 Gmail 帳號。
* **自訂專屬詞庫同步**：自動在使用者個人的 Google Drive AppData 安全備份漫畫專用名詞、人名與術語對照表，多裝置無縫延續。

---

### 💓 6. Chrome Alarms 雙重保活中繼器 (SW Keep-Alive Guardian)
* 透過 Chrome 官方 Alarms API + 內部心跳機制，確保長篇漫畫（100+ 頁）在背景穩定完成連續翻譯。

---

## 🏗️ 技術架構一覽 (Architecture)

```mermaid
graph LR
    A[漫畫網頁 / 宿主探針] -->|圖片爬取 / Scrambled 解密| B[Service Worker 背景服務]
    B -->|雙緩衝流水線預載預壓| C[Google Gemini API]
    C -->|結構化 JSON 輸出| D[和紙閱讀結果頁 / 行動端抽屜]
    D -->|4 大字型即時渲染| E[讀者沉浸閱讀]
    B <-->|AppData 專屬沙盒| F[Google Drive 雲端同步]
```

| 模組 | 核心技術與設計亮點 |
| :--- | :--- |
| **建置系統** | Vite 5 + `@crxjs/vite-plugin` 模組化打包 |
| **圖片解密** | 支援 Canvas 解密還原圖層優先擷取，破譯 DOM 碎片拼接之圖片混淆 (DRM) |
| **流水線** | 雙緩衝管線預載預壓 (Pipeline Prefetching) + 非同步圖片解碼 (`decoding="async"`) |
| **字型架構** | 雲端 CDN 鏡像 + 本機字體優先 Fallback，套件極致超輕量（1.15MB） |
| **保活機制** | Chrome Alarms 雙重系統鬧鐘 + 心跳輪詢保活 |
| **隱私防護** | 無痕視窗 (Incognito) 完全隔離，不留歷史紀錄、不自動同步雲端 |

---

## 📁 專案目錄結構 (Directory Map)

```
Manga-Translator-V3.0/
├── dist-v3/             # Vite 編譯產出（瀏覽器載入此目錄）
├── src/
│   ├── background/      # Service Worker、API 通訊 (translate-api.js)、詞庫管理
│   ├── content/         # 網頁探針、行動端懸浮按鈕 (mobile-main.js)、漫畫爬蟲
│   ├── reader/          # 和風閱讀器 (result.html/css/js, stream-reader.*)
│   ├── sidepanel/       # 桌機側邊欄控制台
│   ├── mobile/          # 行動端獨立設定與操作頁
│   ├── options/         # 選項設定頁面 (API Key、模型選擇、Prompt 配置)
│   └── utils/           # 狀態機 (state.js)、雲端同步 (sync.js)、常數與日誌
├── build-zip.js         # 商店上架 ZIP 自動動態打包腳本
└── vite.config.js       # Vite 建置配置
```

---

## 🚀 快速開始 (Quick Start)

### 1. 安裝依賴與編譯
```bash
# 安裝相依套件
npm install

# 執行生產環境編譯與 ZIP 打包
npm run build
npm run pack
```

### 2. 載入瀏覽器使用 (Unpacked Extension)
1. 開啟 Chrome 或 Edge，前往擴充功能管理頁面：
   * Chrome: `chrome://extensions/`
   * Edge: `edge://extensions/`
2. 開啟右上角的 **「開發者模式 (Developer Mode)」**。
3. 點擊 **「載入解壓縮的擴充功能 (Load Unpacked)」**，選擇專案根目錄下的 **`dist-v3`** 資料夾即可開始享受！

---

## 📜 授權協議 (License)

MIT License © 2026 Manga Translator Team

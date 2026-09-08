# JManga 漫畫「下一話 / 上一話」導航與連續追漫適配計畫

本計畫旨在解決在 **JManga.email** 等現代 SPA / 自訂章節清單型漫畫網站上，翻譯閱讀器無法辨識「下一話」導航連結，導致**無法手動切換下一話**以及**無法觸發跨話自動連續預翻**的問題。

---

## 1. 現狀診斷與根本原因分析

### 1.1 現有機制 (`src/utils/nav-detector.js`)
目前擴充套件主要依賴兩大偵測機制：
1. **原生 `<select>` 下拉選單抽取**：
   - 查詢 `select#chapter, select#select-chapter, .chapter-select select` 等標籤。
   - 解析 `<option>` 取得章節清單，並透過數字推算正序/倒序以決定上下一話。
2. **全頁 `<a>` 標籤文字比對**：
   - 查詢頁面所有 `<a>` 標籤，比對是否包含 `next`、`prev`、`下一話`、`上一話` 等字樣或 `rel="next"` 屬性。

### 1.2 JManga.email 的特殊架構
經檢視 JManga 的實體 HTML 與 JavaScript 原始碼，發現兩大衝突點：
1. **導航按鈕為純 JS 呼叫**：
   ```html
   <button type="button" class="btn btn-navi" onclick="read.prev()">
   <button type="button" class="btn btn-navi" onclick="read.next()">
   ```
   按鈕是 `<button>` 而非 `<a>`，且沒有 `href` 屬性，因此無法透過全頁超連結字樣被抓取。
2. **章節選單採用自訂 `<ul> / <li>` 清單而非 `<select>`**：
   ```html
   <div class="chapters-list-ul">
     <ul class="ulclear reading-list lang-chapters" id="ja-chapters">
       <li class="item reading-item chapter-item" data-id="1854166" data-number="8.2">
         <a href="https://jmanga.email/read/.../chapter-8.2-raw/">8.2</a>
       </li>
       ...
       <li class="item reading-item chapter-item" data-id="1776620" data-number="2">
         <a href="https://jmanga.email/read/.../chapter-2-raw/">2</a>
       </li>
       <li class="item reading-item chapter-item highlight" data-id="1776619" data-number="1">
         <a href="https://jmanga.email/read/.../chapter-1-raw/">1</a>
       </li>
     </ul>
   </div>
   ```
   - 選單為 `<ul>`，現有的 `chapterSelects`（只抓 `select`）直接略過。
   - 目前選中的章節帶有 `class="highlight"`。
   - 清單預設為**倒序（Descending）**，最新話在陣列前端（index 0）。

---

## 2. 建議架構與修改方案

### 元件 1：前台 DOM 導航偵測器 (`src/utils/nav-detector.js`)

在現有的 `<select>` 檢測邏輯之後，加入「自訂章節清單（Custom Chapter List）」解析流程：

#### 核心演算法流程：
1. **選擇器查詢**：
   ```javascript
   const chapterUls = document.querySelectorAll(
       'ul.reading-list, ul.chapters-list, .chapters-list-ul ul, ul.chapter-list, .chapter-list-read ul, .list-chapter ul'
   );
   ```
2. **項目抽取與當前話鎖定**：
   遍歷每組 `li`，抓取其內部 `<a>` 的 `href` 與章節文字。判斷當前話數的條件：
   - 節點包含 `highlight`、`active`、`current`、`selected` class。
   - 或超連結標準化後與當前視窗網址（`window.location.href`）完全相符。
3. **多語系清單過濾**：
   - 優先鎖定非隱藏（`display !== 'none'`）或內部包含當前話數連結的特定 `<ul>`（例如 `#ja-chapters`）。
4. **正序 / 倒序動態判斷**：
   抽取清單第一項與最後一項的章節數字：
   ```javascript
   const getChapNum = (t) => {
       const m = (t || '').match(/[\d\.]+/);
       return m ? parseFloat(m[0]) : 0;
   };
   const isDescending = getChapNum(list[0].title) >= getChapNum(list[list.length - 1].title);
   ```
5. **上下話指派**：
   - **倒序（最新在最前）**：
     - 下一話（較新）：`list[selectedIdx - 1].url`
     - 上一話（較舊）：`list[selectedIdx + 1].url`
   - **正序（第 1 話在最前）**：
     - 下一話（較新）：`list[selectedIdx + 1].url`
     - 上一話（較舊）：`list[selectedIdx - 1].url`

---

### 元件 2：背景靜默抓取器 (`src/background/index.js`)

當開啟「跨話連續追漫」時，背景腳本會透過 fetch 抓取下一話的靜態 HTML 並分析「下下一話」的導航連結。

#### 修改重點：
在 `crawlChapterImagesAndNav(chapterUrl)` 函式中，除了目前比對 `<select>` 與 `<a rel="next">` 外，新增對 `ul.reading-list` 類似結構的正則解析：
- 若目標頁面為 JManga，背景抓到 HTML 時也能透過清單正則提取下下一話，保持連續預翻不中斷。

---

## 3. 變更檔案清單

| 檔案路徑 | 變更類型 | 說明 |
| :--- | :--- | :--- |
| `docs/JMANGA_NAV_PLAN.md` | **新增** | 本適配計畫說明文件 |
| `src/utils/nav-detector.js` | **修改** | 新增對 `ul.reading-list` 等非 `select` 清單結構的支援，支援章節順序推算與上一話/下一話指派 |
| `src/background/index.js` | **修改** | 於後台 HTML 探針中加入自訂清單解析，確保靜默預翻能延續至後續話數 |
| `tests/nav-detector.test.js` | **新增** | 新增 JManga 實體 HTML 結構單元測試，涵蓋倒序推算、第一話無上一話、最後一話無下一話等邊界條件 |

---

## 4. 關鍵技術討論點（供多 AI 審查討論）

1. **SPA 異步載入時序問題**：
   - JManga 的章節清單在原始 HTML 中已經存在（由伺服器端渲染好放於 `#dropdown-chapters` 中），因此在 Content Script 執行時可以直接抓到，無需等待 AJAX 回傳。
2. **多語系清單衝突防範**：
   - JManga 下拉選單中可能同時包含 `id="ja-chapters"` 與 `id="en-chapters"` 等不同語系的 `<ul>`。
   - **解法**：優先採用當前活躍顯示的 `ul:not([style*="display:none"])`，或以其內部連結網址與當前頁面比對一致者為準，避免誤抓其他語系的章節。
3. **數字解析邊界**：
   - 例如章節名稱為「8.2 話」、「Extra」、「特別篇」，需確保正則解析 `[\d\.]+` 在純文字標題下具備安全的 fallback（若皆無數字則預設採 DOM 順序倒序）。

---

## 5. 驗證計畫

### 自動化測試 (Automated Tests)
- 撰寫 `tests/nav-detector.test.js`：
  1. 輸入 JManga 12 個章節的真實 DOM 結構，驗證第 1 話時 `next` 正確指向第 2 話、`prev` 為 `null`。
  2. 驗證第 5 話時，`next` 指向第 6 話、`prev` 指向第 4 話。
  3. 驗證第 8.2 話（最新話）時，`next` 為 `null`、`prev` 指向第 8.1 話。
  4. 執行 `npm test` 確認既有 339 項測試依然 100% 綠燈。

### 手動驗收 (Manual Verification)
1. 載入編譯後的擴充套件，開啟 JManga 第 1 話。
2. 開啟翻譯側邊欄點擊整頁翻譯，進入結果頁（`result.html`）。
3. 觀察結果頁頂部導航列：
   - 「下一話」按鈕應變為可點擊狀態。
   - 點擊「下一話」，應無縫跳轉並開始翻譯第 2 話。
   - 若開啟「連續追漫」，背景日誌應能看見開始靜默預翻第 2 話。

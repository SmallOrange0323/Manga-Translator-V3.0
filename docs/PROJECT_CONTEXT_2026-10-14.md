# Manga Translator 專案接續脈絡 — 2026-10-14

本紀錄依當前工作目錄、Git 差異與現有測試整理，用於接續 AGY 的修改。
舊交接文件和 README 的版本、測試數及未修問題不可直接當成現況。
開始下一輪工作仍須重新確認 Git 狀態。

後續更新：本日審查的四項缺陷已依使用者授權修正，新增 20 項回歸測試，
最新驗證為 36 檔、490 項通過。參考 REVIEW_FIXES_2026-10-14.md。
下文的 Git 行數與 470 項測試數為本日掌握專案時的原始快照。

## 版本與工作目錄

- package.json 與 manifest.json 均為 **3.2.0**。
- 分支：`codex/stability-and-retire-two-step`。
- 已提交 HEAD：`8b8e16f`，2026-10-12，WNACG 本機 CDN 替換與加速開關。
- AGY 的 3.2.0 修改仍未提交：11 個追蹤檔案約 537 行新增、283 行刪除，
  另有 `src/utils/zh-tw-localizer.js`、`tests/manga-v320-upgrade.test.js` 未追蹤。
- 本次新增此接續紀錄，未改動功能原始碼。
- 本機已有 2026-10-13 產出的 3.2.0 完整、輕量與超輕量 ZIP，
  不能僅憑檔名視為已發布版本；本輪未重打包這些 ZIP。
- 一般沙箱讀取部分 OneDrive 檔案與 Git loose objects 會 Permission denied；
  本輪用經自動審核允許的升權唯讀操作成功取得，並非據此判定 Git 損毀。

## 主架構與功能入口

| 區域 | 責任與關鍵檔案 |
| --- | --- |
| 背景服務 | `src/background/index.js` 是任務派發、訊息與整合主入口，約 3,568 行；不可因目錄已模組化便假設所有工作已拆開。 |
| 翻譯請求 | `translate-api.js` 處理 Gemini 請求、輸出解析、錯誤與中斷；`hybrid-scheduler.js`、`hybrid-retry.js` 管理 Key × Model 輪替及容錯。 |
| 網頁注入 | `src/content/main.js` 判斷桌面或行動端；`manga-engine.js` 負責抓圖、Canvas、懶載入與框選，桌面及行動端共用圖片轉換。 |
| 漫畫任務 | `manga-job-store.js` 持久化一般模式任務、游標與結果；`manga-recovery.js` 負責恢復、快照、更新與暫存圖片補回。 |
| 換話與預翻 | `manga-navigation-store.js` 按來源分頁保存待辦及原子 claim；`pretranslation-queue-store.js`、`pretranslation-checkpoint.js` 保存佇列與進行中工作，`jestful-prefetch.js` 處理動態預抓。 |
| 小說 | `novel-job-checkpoint.js`、`novel-session-state.js`、`novel-result-store.js` 等使用 storage.session 管理 Session、排程、中止及恢復；content 的 `novel-rehydrate-client.js` 比對原文、附掛與補快照。 |
| 閱讀器 | `src/reader/result.js` 是圖文結果、重譯、換話、預翻狀態及快照 UI；`stream-reader.js` 是 N/E 網集中串流閱讀及整本翻譯入口。 |
| 設定與詞庫 | Sidepanel、Options、Mobile、Popup 共用狀態；`glossary-manager.js` 管理作品詞庫，`sync-policy.js`、`sync-engine.js` 等處理 Google Drive 同步。 |
| WNACG 加速 | 靜態規則 `public/rules/wnacg.json` 精確替換三個同版本依賴；`wnacg-acceleration.js` 與 Options 開關管理本機偏好，更新後恢復選擇。 |

漫畫主流程：網頁抓圖／框選 → 背景建立任務 → 圖片縮放及 Base64 →
Key／模型調度 → Gemini 直譯 → 解析及在地化 → 提交任務結果 →
閱讀器快照呈現 → 下一話預翻／導航／重試。

主漫畫工作仍為全域單一 lifecycle，以 start lock、STOP／AbortSignal 和
active run tracking 協調，不能直接當作各分頁彼此獨立的並行翻譯器。

## AGY 本輪 3.2.0 變更

1. **台灣用語與繁體轉換獨立模組。** 新增約 494 行的 `zh-tw-localizer.js`，
   先處理詞彙，再處理字元映射；後／后、發／髮、裡／里、乾／幹等易混字
   避免無條件單字轉換。API 回應的譯文欄位沿用 enableTaiwanLocalization 控制。
2. **漫畫翻譯規則與預設升級。** 強化人稱、稱謂、閱讀順序與假名處理；
   `resolveMangaOneStepPrompt` 將空值／舊版預設升級，保留非預設的自訂規則。
   Gemma 仍使用專屬提示詞。temperature 在文字／看圖請求與多圖批次設為 0.3。
3. **跨批對話上下文。** 主漫畫多圖批次保留最近五組原文／譯文，加入下一批的
   `previous_dialogue_reference`，恢復任務時也從已保存結果建立。
4. **圖片清晰度。** 共用 `computeMangaTargetDimensions`：直向以短邊為基準、
   高度最多約 maxDim × 2.2；橫向寬度最多約 maxDim × 1.5，高度最多 maxDim。
   JPEG 品質提高至 0.90；背景及 content 的縮圖共用計算。
5. **錯誤進入重試。** 批次空回應及損毀 JSON 改為拋錯，交給外層 Key／模型
   容錯與單張救援；不再以空 pages 假裝 JSON 解析成功。
6. **重譯結果同步保存。** 圖片、整頁文字與單行文字重譯攜帶 pageIndex，
   單行另帶 lineIndex；更新 mangaRecovery 及前台 item.results，保留實際模型資訊。
7. **暫存圖片顯示。** mangaRecovery 按結果分頁與原頁碼保存記憶體圖片，
   在後續 commit／publish／snapshot 補回 Canvas／data:image 圖片，
   圖片 bytes 不寫入 storage.local；重譯也能取回活躍記憶體圖片。
8. **詞庫總開關一致性。** 更多漫畫、預翻、框選與重譯路徑檢查
   globalGlossaryEnabled；關閉時不注入詞庫、不自動萃取及保存。
9. **框選與行動端。** 框選先取得乾淨截圖才顯示遮罩，不在按下滑鼠時重拍遮罩；
   行動端補上 fetchBase64 與 ping，桌面圖片轉換抽到 manga-engine 共用。
10. **閱讀器與抓圖效率。** 快照合併使用 Map／Set，批次清單集中更新；
    抓圖先做輕量篩選，必要時才讀取元素渲染尺寸；每日張數統計按模型批量累加。
11. **串流閱讀器。** 整本翻譯先解析真正圖片網址，不再把 HTML 閱讀頁當圖片；
    動態錯誤及譯文以 textContent 呈現，按鈕使用事件監聽器。

## 已知適用範圍與接續注意

- 跨批上下文目前僅送入主漫畫 `batchSize > 1` 的 callGeminiAPIBatch 路徑。
  `batchSize=1` 的 translateTexts 以及下一話預翻呼叫未帶該片段。
  不應描述為所有翻譯路徑都已具有跨批上下文。
- 暫存圖片 Map 只在同一次 Service Worker 生命週期有效。任務與文字結果可保存，
  但 data:image 像素不會跨 SW 重啟持久化；恢復未完成暫存圖片仍可能需重新抓取。
- 簡繁轉換是本機詞彙及字元映射，易混字靠已列出的詞彙處理，
  不是完整的語意轉換器；不可宣稱所有一簡多繁情況皆正確。
- 主漫畫派發仍固定 one-step，雙階段模式未重新啟用。
  DEFAULT_PROMPT_TWO_STEP 現仍用於純文字重譯；OCR／舊常數的存在不等於恢復雙階段產品功能。
- 介面及說明版本尚未全面更新：Options 標題、Sidepanel 顯示與 README 仍有 3.1.11。
- `git diff --check` 發現 constants.js 第 128、139 行有行尾空白，本輪掌握脈絡未修改。
- 遵守根 AGENTS.md：重要狀態持久化、原子更新、非同步訊息回傳 true 並捕捉錯誤、
  注入 UI 使用 Shadow DOM、動態資源透過 chrome.runtime.getURL。
- 狀態須依實際程式區分 local、session 與為隱私保留的記憶體資料。
  StateManager 的更新鎖僅在同一 instance 內序列化，不是跨 context 的儲存交易。
- 舊文件的「未修」清單需逐一對照當前程式，不能直接重做已在後續提交修好的問題。

## 本次驗證

- 全套本機測試：**35 個測試檔，470 項通過**；包含 8 項 V3.2.0 新增測試。
- `npm run build` 成功，更新 dist-v3；重複 icon 輸出警告仍存在。
- `git diff --check` 未通過：constants.js 第 128、139 行有既有行尾空白。
- 測試使用模擬翻譯回應，未呼叫真實付費翻譯 API；本輪未做網站實站翻譯驗證。
- 本輪目的為掌握專案，不是完整程式審核。測試通過不代表所有新增 UI、
  模型輸出品質、瀏覽器休眠與不同網站相容性皆已實測。

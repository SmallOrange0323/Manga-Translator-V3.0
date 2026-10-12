# WNACG 首頁載入延遲修正（2026-10-04）

## 實站觀察

使用 Codex 內建 Chromium 瀏覽器讀取 https://www.wnacg.com/。
使用者日常使用的 Chrome 尚未連接，未直接量測該 Chrome 設定檔。

首頁同步載入的外部依賴：
`https://upcdn.b0.upaiyun.com/libs/jquery/jquery-1.10.2.min.js`。
該 script 沒有 async 或 defer，下載期間阻塞 HTML 解析及首次顯示。

| 項目 | 原始載入 | 只替换同版本 jQuery 來源的對照測試 |
| --- | ---: | ---: |
| jQuery 請求耗時 | 19,491.7 ms | 135.6 ms |
| 首次內容顯示（FCP） | 20,184 ms | 532 ms |
| DOMContentLoaded | 20,233.3 ms | 550.7 ms |
| load | 22,005.6 ms | 981.9 ms |
| 成功載入圖片 | 68/68 | 68/68 |

對照測試停用瀏覽器快取，使用 CDP 將單一 jQuery script 請求改從
`https://code.jquery.com/jquery-1.10.2.min.js` 讀取。
測試後清除攔截並恢復快取設定。確認 jQuery 版本仍為 1.10.2，
jquery.lazyload 功能仍存在。這是替換來源的實站驗證，
尚非安裝新版擴充功能後的 extensionPath 重導驗證。
單次量測不代表所有網路環境的固定速度。

## 修正

- 將官方相同版本的原始 jQuery 與 MIT 授權隨擴充功能打包。
- 新增啟用的靜態 declarativeNetRequest 規則，Chrome 在送出請求前
  將該特定 CDN URL 指向擴充功能內的檔案。
- 僅處理 wnacg.com 及其子網域發起的 script 請求；保留其他網站、
  jQuery 版本、圖片、登入及漫畫閱讀器資料請求。
- 使用 declarativeNetRequestWithHostAccess，沿用已有的 host_permissions。
- 靜態 extensionPath 由 Chrome 解析，無需背景服務啟動、內容腳本觀察器
  或寫死擴充功能 ID。

## 搜尋頁補充驗證

使用者澄清首頁變快時仍是原本的 wnacg.com 網域，搜尋依然很慢，
不能將首頁變快解釋為換網域的效果。

指定搜尋：
https://www.wnacg.com/search/?q=%E7%8C%BF%E9%A7%95&f=_all&s=create_time_DESC&syn=yes

搜尋頁使用 jQuery **1.6.2**，並在稍後同步載入 jQuery UI **1.8.24**，
兩者皆來自 upcdn.b0.upaiyun.com。第一版只有 jQuery 1.10.2 的規則，
未涵蓋這兩個搜尋頁依賴。

- 原始搜尋主文件首位元組等待 414.1 ms、收取完成 452.5 ms。
- 77,882.1 ms 時仍在等待 jQuery 1.6.2，readyState=loading，沒有 paint，
  尚未發生 DOMContentLoaded；這是等待時間下限，不是完成下載的耗時。
- 用官方同版本來源替換兩個依賴後，FCP=948 ms、
  DOMContentLoaded=926.6 ms、load=1,433.2 ms。
- 24 個結果項目及 25/25 圖片載入，搜尋框值維持「猿駕」。
- jQuery 仍為 1.6.2、jQuery UI 仍為 1.8.24，autocomplete 函式存在，
  該測試頁未記錄 JavaScript error。
- 原 jQuery UI 檔案宣告長度 200,719 bytes；15 秒只收到 6,845 bytes，
  這部分與官方檔案的前綴逐位元組相同，完整原始檔案雜湊未取得。

這是停用快取並透過 CDP 替換外部來源的實站對照測試，
仍未在使用者日常 Chrome 直接安裝並驗證 extensionPath 重導。
測試後清除攔截並恢復快取設定。此次已新增搜尋頁兩個版本的規則。

Chrome 官方 API 說明：
https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest

## 本機驗證與使用

### 加速開關

設定頁「漫畫設定」的雲端同步區塊下方新增「WNACG 加速」。
預設保持開啟，以延續本次加速修正。切換立即儲存，不依賴「儲存設定」按鈕。
關閉會停用整個 wnacg_local_jquery 規則組，讓三個檔案恢復網站原始載入。
開關只影響下一次請求，切換後須重新整理網站；不會替換已執行中的 JavaScript。

偏好持久化於 chrome.storage.local 的 wnacgAccelerationEnabled。
背景服務啟動、瀏覽器啟動、擴充功能安裝或更新以及該本機設定變更時，
皆依持久化偏好恢復規則組。僅修改 WNACG 規則，不影響其他規則組。
規則套用失敗時回復上一個偏好、回傳錯誤，設定頁顯示失敗並可重試。

以實際設定頁 HTML 與正式開關模組建立本機預覽，使用模擬的 Chrome
儲存與規則 API 驗證開啟、關閉、重新載入後仍關閉及重新開啟。
使用者日常 Chrome 的原生規則 API 仍需載入新版擴充功能後驗證。

`npm test`：34 個測試檔、462 項測試通過（含加速開關）。
`npm run build`：通過。建置輸出包含 rules/wnacg.json 及三個同版本依賴檔案。
`git diff --check`：通過。

若 Chrome 現在載入的是本專案的 dist-v3，請到擴充功能頁按漫譯的
「重新載入」，再重新整理 WNACG。如果載入的是其他解壓目錄，
請改載入此次測試包的解壓目錄。

更新後可在 Chrome 開發人員工具的 Network 搜尋 jquery-1.10.2，
確認該請求重導至 chrome-extension://.../vendor/jquery-1.10.2.min.js。
搜尋頁另確認 jquery-1.6.2 及 jquery.ui-1.8.24 請求重導至
vendor/jquery-1.6.2.min.js 及 vendor/jquery-ui-1.8.24.min.js。
檢查首頁、列表、登入介面與漫畫閱讀頁是否正常。
此修正不保證改善網站主機或圖片圖床本身的連線延遲。

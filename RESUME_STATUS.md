# 修正接續紀錄 — 2026-09-24 台灣時間

## 11:50 最新狀態

先前下列待修項目已於 `codex/stability-and-retire-two-step` 未提交修改中修復：無痕漫畫紀錄隔離、預翻交接、閱讀器即時快照、詞庫跨視窗寫入、詞庫別名刪除、詞庫編輯時保留輸入。背景章節解析另補延遲載入圖片與清單邊界測試。全套測試 25 檔／387 項通過，`npm run build` 與 `git diff --check` 通過。獨立 GPT-6 Astra 複核沒有剩餘明確 P1/P2。真實擴充套件在使用者指定網站上的端到端操作與真實翻譯／雲端 API 尚未驗證。未 commit、push、發布。五小時額度 92% 已用，點數餘額 93.378277；不得花點數。以下為歷史交接紀錄，已由本段狀態取代。

## 2026-09-24 後續補記

使用者允許五小時額度用到 0%，但仍不得動用點數。續作時額度 81%，在使用 98% 時為避免跨到點數，已停止／中斷全部代理；點數餘額仍為 95.419773。詞庫別名刪除修正已完成，聚焦測試 13/13 通過。跨一般與無痕背景的詞庫序列化仍未解決；Web Locks 在 private session 為獨立 lock manager，不可直接當作共享鎖。漫畫代理增加 tests/manga-recovery.test.js 並修改相關程式，但因額度停工，尚未收交接或驗證新測試。選項編輯畫面代理也遭停工，需先檢查當前修改與測試。使用者被詢問希望優先處理的網站，尚待回覆；網站實測未開始。先前 365 測試與 build 是本次新修改前的結果，須重跑。先查額度與點數，再續作。

## 暫停原因

五小時額度使用 77%，為遵守不得花點數要求已停止全部代理。此次 06:30 恢復後點數餘額維持 95.419773；未兌換重設券。單次排程不再自動重跑。下次需使用者授權接續，先檢查 ordinaryUsageAllowed 與五小時額度，預留停止緩衝。

## 工作狀態

- 分支 codex/stability-and-retire-two-step，保留全部未提交修改；未 commit、push、發布。
- 雙階段退場、詞庫同步與序列寫入、章節解析、安全詞庫 DOM、漫畫持久化基本整合已寫入。
- GPT-6 Sol 負責詞庫與解析等修正；GPT-6 Astra 負責漫畫恢復，另由獨立 Astra 審核。
- 全套 npm test：22 個測試檔、365 項通過。npm run build 成功（重複 icon 輸出警告）。測試未覆蓋新漫畫恢復流程，不能視為審核通過。
- 沙箱 EPERM 可透過已核准提升權限讀取與測試；勿當作檔案毀損。

## 接續必修（獨立審核）

1. P1：src/background/manga-recovery.js 約 13 行，split incognito worker 也呼叫 local.recover，但 tabs.query 只看到無痕 tabs，會刪掉共享 local storage 中一般視窗任務。無痕背景必須避免對一般 store 的 recover、stop、remove 操作，並補測。
2. P2：src/background/glossary-manager.js 約 129 行，刪除整本後 tombstone 只比對原始 key；大小寫／標點／既有別名策略可能繞過刪除標記。修正 save 與 cloud merge 的別名比對，測試刪除後別名 stale save/merge。
3. P2：glossary-manager 的 pendingWrite 只有單 worker 鎖，manifest incognito split 的兩個背景共享 chrome.storage.local，仍可能讀改寫互相覆蓋。需跨 context 協調或單一權威寫入者，補雙 context 測試。
4. P2：src/options/main.js 約 47 行，每次背景儲存广播 GLOSSARY_UPDATED 就 rerender，會取代正在編輯的 input，丟掉後续輸入或焦點。保留進行中編輯或延後刷新並補互動測試。

## 漫畫代理交接

- 已新增 manga-job-store.js、manga-recovery.js 並串接 index.js、reader/result.js；先保存批次再送 UI、版本快照、明確續翻、來源 URL 保護、停止、單頁 retry 保存。
- 一般 local、無痕記憶體；8 任務／800 頁／4 MB 限制；不保存 image bytes、API key、prompt。
- 預翻消費目前先設定 consumedResultTabId，再設定 consumptionReady，中間批次完成可能以 undefined foregroundJob commit。需調整順序或同時檢查 consumptionReady，確保中間完成結果不遺失。
- consumptionReady Promise 掛在 jobData，需確認 savePretranslatedChapterToStorage 白名單序列化，避免保存 Promise。
- 必補 production-flow 測試：首批完成後 worker 重啟、只續送剩餘圖片、STOP 後 API 晚到、舊 run 不覆寫新任務、快照和即時事件競爭、預翻消費、無痕隔離、建立分頁前後重啟。
- 讀取 sessionStorage 恢復已移除，模式切換仍寫入，可清理。
- 舊 saveGlossaryTerm 回傳 count，現在 upsert 回傳 termCount；result.js 仍讀 count（後續刷新會補正，低優先）。

## 完成前

先修上述問題與驗證恢復流程，再由獨立 Astra 重審，必要時重跑測試及 build。尚未真實網站／真實 API 驗證。不要發布或推送。

## 2026-09-24 Wnacg slide reader compatibility

Verified the user-provided chapter https://www.wnacg.com/photos-slide-aid-387480.html in the browser. Its reader has 80 .v-slot placeholders but only six initial img elements. The same-origin /photos-item-aid-387480.html script contains an ordered 80-URL page_url list (signed img5.qy0.ru links). Added a data-only parser and a bounded same-origin reader-list fetch in crawlImagesForRequest, with slide/album ID matching, expected page count and first visible image checks. Missing or inconsistent data returns an error and zero candidate images. Desktop, mobile page, and mobile drawer use this path. Full suite: 398/398 passed; production build passed; git diff --check passed. Independent GPT-6 Sol high review found no P1/P2. Actual extension translation on the live site has not yet been exercised. Five-hour ordinary usage was 54%, credits stayed at 93.378277; no credits spent, no commit/push/publish.

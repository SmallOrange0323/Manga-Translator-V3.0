# 任務清單：翻譯提示詞工程與 XML 約束結構化升級

- `[x]` 黃金提示詞庫 XML 改造 (Constants)
  - `[x]` 改造 `DEFAULT_PROMPT_ONE_STEP`：新增 `<system_instructions>`、`<critical_rules>` 與 XML 結構
  - `[x]` 改造 `DEFAULT_PROMPT_NOVEL`：將小說去道德審查與口吻規則以 XML 標籤包裹
  - `[x]` 改造 `SYSTEM_BATCH_RULES`：以 XML 包裹多圖批次與 Katakana 音譯要求
- `[x]` API 系統指令組裝優化 (Translate API)
  - `[x]` 修改 `translateTexts`：重構系統指令拼裝，將 `glossarySnippet` 包裹於 `<glossary>` 標籤中
  - `[x]` 修改 `callGeminiAPIBatch`：升級批次系統指令為 XML 結構
- `[x]` 驗證與測試 (Verification)
  - `[x]` 執行 `npm run build` 進行自動化編譯與打包檢查
  - `[x]` 手動測試：驗證 Gemini Flash-Lite 在 XML 約束下的 JSON 格式穩定度與術語庫對照精準度

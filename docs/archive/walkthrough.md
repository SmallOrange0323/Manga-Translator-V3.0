# 功能交付與驗收報告 (Walkthrough) - 提示詞 XML 約束化升級

本報告為 **Manga Translator V3.0** 針對 **Gemini 3.1 Flash-Lite** 模型物理特性進行的**「翻譯提示詞工程 XML 標籤化約束與 API 智慧組裝升級」**功能的完整交付與驗收說明。

---

## 🟢 三道綠燈自檢結果 (Self-Verification Report)

在正式交付給您進行驗收前，我們已在背景自主完成了自動化自檢：

* **🟢 第一道關卡：Linter 與語法靜態檢查** ➡️ **通過**。
  * 所有 XML 常數字串與 `translate-api.js` 中繼代碼均完全符合 ES6 規範與 JS 語法標準，無任何語法錯誤。
* **🟢 第二道關卡：自動編譯與打包 (Build Check)** ➡️ **通過**。
  * 成功執行 `npm run build`。打包產物編譯百分之百成功，耗時 802ms，未發生任何 unresolved import 或打包資源丟失。
* **⚪ 第三道關卡：自動測試 (Test Check)** ➡️ **無配置**。

---

## 🛠️ 主要變更檔案與技術實作說明

我們針對 Gemini 原生的 XML 注意力機制，重構了以下核心模組：

### 1. 黃金提示詞庫 XML 標籤化升級
* **[src/utils/constants.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/utils/constants.js)** (MODIFY)：
  * **`DEFAULT_PROMPT_ONE_STEP`**：改造成由 `<system_instructions>`、`<critical_rules>` 與 `<translation_rules>` 包裹的 XML 約束結構。
  * **`DEFAULT_PROMPT_GEMMA_ONE_STEP`**：使用 `<content_rules>`、`<text_merging_rules>` 與 `<json_schema>` 包裹。
  * **`DEFAULT_PROMPT_TWO_STEP`** & **`DEFAULT_PROMPT_OCR`**：進行標準 XML 格式優化。
  * **`SYSTEM_BATCH_RULES`**：將批次多圖翻譯規則、邊界解析規則與 Katakana 人名精確音譯要求以 XML 標籤分層包裹。
  * **`DEFAULT_PROMPT_NOVEL`**：將「去道德審查」、「口吻保持」、「1:1 段落對照」三大核心規則以 XML 標籤分層包裹。

### 2. API 系統指令 XML 智慧組裝
* **[src/background/translate-api.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/background/translate-api.js)** (MODIFY)：
  * **優化 `translateTexts`**：
    以前將術語直接以簡單的 newline 拼貼在 prompt 後。現在升級為結構化 XML 注入，將自定義的 `glossarySnippet` 自動包裹在 **`<glossary>`** 標籤中，強制 Gemini Flash-Lite 遵守系統指令與動態術語庫規則：
    ```javascript
    const systemPrompt = `
<system_instructions>
${prompt}
</system_instructions>
${glossarySnippet ? `\n<glossary>\n${glossarySnippet}\n</glossary>` : ''}`;
    ```
  * **優化 `callGeminiAPIBatch`**：
    同樣改裝為 XML 標籤化前綴：
    ```javascript
    const systemPrompt = `
<system_instructions>
${customPrompt || 'You are a professional manga translator.'}
${SYSTEM_BATCH_RULES}
</system_instructions>
${glossarySnippet ? `\n<glossary>\n${glossarySnippet}\n</glossary>` : ''}`;
    ```

---

## 🧪 建議實機驗收指南 (Translation Quality Test Guide)

請您加載最新編譯好的 `dist-v3` 目錄至您的瀏覽器，並依照以下步驟進行翻譯品質與紀律的實機驗收：

1. **小說翻譯格式與敏感度驗收**：
   * 進入任一輕小說網站，開啟小說翻譯。
   * 觀測翻譯輸出：驗證在強大的 `<safety_and_censorship_rules>` XML 包裹約束下，即使遇到露骨成人（NSFW）或極度敏感描寫，Gemini Flash-Lite 是否能 100% 穩定還原對白、拒絕任何道德自我審查，且 JSON 格式完美無損。
2. **術語庫 (Glossary) 嚴格遵守度驗收**：
   * 在擴充功能的術語管理中，手動新增一個漫畫角色的 Katakana 譯名對照（例如 `ココア -> 可可亞醬`）。
   * 前往漫畫頁面點擊「手動選取」➡️「翻譯此頁」。
   * 觀測譯文：驗證在 `<glossary>` XML 標籤約束防火牆的保護下，Gemini Flash-Lite 是否能 **100% 完美且穩定地採用該術語**，徹底消除輕量級模型容易忘記術語的物理痛點。
3. **漫畫批次 JSON 穩定度驗收**：
   * 點擊「全頁翻譯」或批次翻譯多張圖片。
   * 觀測控制台日誌：驗證在 `<output_rules>` XML 約束下，Gemini 3.1 Flash-Lite 是否能 100% 穩定回傳結構化 JSON，不再產生 ```json 標記外包的解析異常。

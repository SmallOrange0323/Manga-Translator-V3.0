# 實施計畫：翻譯品質提示詞工程與 XML 約束結構化升級 (針對 Gemini 3.1 Flash-Lite 優化)

本計畫旨在針對 **Gemini 3.1 Flash-Lite** 原生的 XML 標籤注意力機制與 1M 超長上下文特性，對 Manga Translator V3.0 的核心翻譯提示詞庫與 API 中繼器進行結構化升級，以最低成本換取極致的翻譯品質與高度紀律的格式輸出。

---

## 📋 使用者審查請求

> [!IMPORTANT]
> **本計畫為純粹的代碼內部優化，無任何權限與外部依賴變更，亦不破壞現有的 UI 交互：**
> 
> 1. **XML 約束化常數改造**：將 `src/utils/constants.js` 中的預設提示詞庫升級為 XML 標籤包裹與 Few-Shot 結構。
> 2. **API 調用組裝升級**：修改 `src/background/translate-api.js` 中對「系統提示詞」與「術語庫 (Glossary)」的組裝方式，以前期文字拼接改為結構化 XML 包裹。

---

## 🗺 提示詞 XML 結構規範 (XML Tag Specification)

為了使 Gemini Flash-Lite 發揮 100% 的翻譯水準，系統指令將按照以下 XML 架構進行封裝：

```xml
<system_instructions>
  [系統核心翻譯角色與原則]
  
  <safety_rules>
    [虛構藝術創作免道德審查與和諧化說明]
  </safety_rules>
  
  <format_rules>
    [Strict output JSON guidelines / Line combination logic]
  </format_rules>
</system_instructions>

<glossary>
  [動態注入的術語與人名 Key-Value 對照表]
</glossary>

<examples>
  <example>
    <original>[原文樣本]</original>
    <translation>[Traditional Chinese 完美翻譯樣本]</translation>
  </example>
</examples>

<input_data>
  [本次待翻譯的 JSON 段落數據]
</input_data>
```

---

## 🛠 預計變更

### 1. 黃金提示詞庫改造 (Constants)
#### [MODIFY] [src/utils/constants.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/utils/constants.js)
* **`DEFAULT_PROMPT_ONE_STEP`**：改造成由 `<system_instructions>`、`<critical_rules>` 與 `<examples>` 包裹的 XML 約束結構，包含氣泡文字合併合併規則。
* **`DEFAULT_PROMPT_NOVEL`**：將「道德去敏感化」、「口吻保持」、「1:1 段落對照」三大核心規則以 XML 標籤分層包裹。
* **`SYSTEM_BATCH_RULES`**：將多圖批次處理規則、JSON Schema 要求與 Katakana 人名精確音譯要求進行 XML 約束包裹。

---

### 2. API 系統指令組裝升級 (Translate API)
#### [MODIFY] [src/background/translate-api.js](file:///C:/Users/user/.gemini/antigravity/worktrees/Manga-Translator-V3.0/check-project-progress/src/background/translate-api.js)

* **優化 `translateTexts` (L34 附近)**：
  以前將術語直接以 newline 拼貼：
  ```javascript
  const systemPrompt = glossarySnippet ? `${prompt}\n\n${glossarySnippet}` : prompt;
  ```
  升級為結構化 XML 注入：
  ```javascript
  const systemInstructions = `
<system_instructions>
${prompt}
</system_instructions>
${glossarySnippet ? `\n<glossary>\n${glossarySnippet}\n</glossary>` : ''}`;
  ```

* **優化 `callGeminiAPIBatch` (L306 附近)**：
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

## 📈 驗證計劃

### 1. 自動化三道綠燈自檢
* **第一道：Linter 靜態檢查**：確保 XML 字串引號、變數拼接正確，無語法錯誤。
* **第二道：自動編譯打包 (Build Check)**：執行 `npm run build`，確保新打包的 `dist-v3/` 無 Rollup 解析錯誤。

### 2. 手動翻譯品質對位驗證
* **格式穩定度測試**：在手動選取模式下，測試多張漫畫的「全頁翻譯」，觀測 Gemini Flash-Lite 在 XML 約束下，是否能 100% 穩定輸出 JSON，且無 any "```json" 幻覺外包裹。
* **術語對位測試**：手動在術語庫中加入 Katakana 專有名詞（例如 `ココア -> 可可亞`），測試翻譯，驗證 Gemini Flash-Lite 是否能 100% 嚴格遵守 `<glossary>` 約束完成譯名對照。

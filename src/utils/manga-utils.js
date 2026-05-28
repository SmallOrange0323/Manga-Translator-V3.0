/**
 * 從網頁標題字串中解析作品識別碼。
 * 支援標題格式：
 * 1. 日文 + 羅馬拼音 (e.g. "呪術廻戦 Jujutsu Kaisen 第250話")
 * 2. 純日/中 (e.g. "葬送のフリーレン 第100話")
 * 3. 純英文 (e.g. "Frieren Chapter 100")
 * 
 * @param {string} titleStr - 網頁 document.title
 * @returns {Object|null} { displayName, romanKey, rawJapanese }
 */
export function extractMangaTitle(titleStr) {
  if (!titleStr || typeof titleStr !== 'string') return null;
  let str = titleStr.trim();

  // 1. 預先清洗：移除常見網站名稱尾綴
  str = str.replace(/\s*[|｜\-–—].*$/, ''); // 移除分隔符後的所有內容
  str = str.replace(/\s*-\s*Read\s*.*$/i, ''); // 移除 " - Read Manga Online" 之類
  str = str.replace(/ \/ [^/]+$/, ''); // 移除小說網站常見的層級路徑

  // 模式 1：日文 + 空格 + 羅馬拼音（生肉常用格式）
  const match = str.match(
    /^([\u3040-\u30FF\u4E00-\u9FFF]{2,})\s+([A-Za-z0-9][A-Za-z0-9\s:!'\-\(\)]{2,})?(?:\s+(?:第|話|话|Ch|Chap|Chapter|EP|Vol|v\.|ch\.|ep\.|cheapter)[\s.]*\d+|\s+\d+)/i
  );
  if (match) {
    const rawJP = match[1].trim();
    const roman = match[2] ? match[2].trim() : rawJP;
    return {
      displayName: rawJP,
      rawJapanese: rawJP,
      romanKey: roman,
    };
  }

  // 模式 2：純日文或中日混排
  const jpMatch = str.match(/^([\u3040-\u30FF\u4E00-\u9FFF\s]{2,})?(?:\s+(?:第|話|话|Ch|EP|Vol|v\.)[\s.]*\d+|\s+\d+)/i);
  if (jpMatch && jpMatch[1]) {
    const name = jpMatch[1].trim();
    return { displayName: name, rawJapanese: name, romanKey: name };
  }

  // 模式 3：純英文/羅馬拼音
  const enMatch = str.match(/^([A-Za-z0-9][A-Za-z0-9\s:!'\-\(\)]{3,})?(?:\s+(?:Chapter|Chap|Cheapter|Ch|EP|Vol|v\.|episode|ep\.)[\s.]*\d+|\s+\d+)/i);
  if (enMatch && enMatch[1]) {
    const name = enMatch[1].trim();
    return { displayName: name, rawJapanese: null, romanKey: name };
  }

  // 模式 4：萬用降級 (Fallback)
  const fallbackMatch = str.match(/^([^|｜\-–—\n]{3,})/);
  if (fallbackMatch) {
      let name = fallbackMatch[1].trim();
      // 二次清洗：針對純數字結尾或 Chap. 結尾
      name = name.replace(/\s+(?:Chapter|Chap|Ch|EP|Vol|v\.|ep|episode)[\s.]*\d+.*$/i, '');
      name = name.replace(/\s+\d+\s*$/g, '');
      name = name.replace(/\s*\([^)]*$/, '');
      if (name.length >= 2) {
          return { displayName: name, rawJapanese: null, romanKey: name };
      }
  }

  return null;
}

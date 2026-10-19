const sameLine = (a, b) => a?.original === b?.original && a?.translation === b?.translation;

// Returned updater runs inside the durable store's serialized mutation.
// Unrelated line edits can merge; changed targets reject a late response.
export function createMangaResultUpdate(expectedRow, update, lineIndex = null) {
    if (!Array.isArray(update.results) || !update.results.length) throw new Error('重譯回應沒有有效的譯文');
    return current => {
        const expected = expectedRow?.results;
        if (!Array.isArray(expected) || !Array.isArray(current.results)) return null;
        if (lineIndex !== null) {
            if (!Number.isInteger(lineIndex) || lineIndex < 0 || !expected[lineIndex] || !current.results[lineIndex]) return null;
            if (!sameLine(current.results[lineIndex], expected[lineIndex])) return null;
            return {
                results: current.results.map((line, index) => index === lineIndex ? update.results[0] : line),
                usedModelName: update.usedModelName || current.usedModelName
            };
        }
        if (current.results.length !== expected.length || !current.results.every((line, index) => sameLine(line, expected[index]))) return null;
        return { ...update, usedModelName: update.usedModelName || current.usedModelName };
    };
}

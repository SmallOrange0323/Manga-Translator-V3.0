async function processNovelQueue() {
    const isProcessing = await state.get('isProcessingNovel', false);
    if (isProcessing) return;

    await state.set('isProcessingNovel', true);
    
    try {
        while (true) {
            const queue = await state.get('novelQueue', []);
            if (queue.length === 0) break;

            const task = queue.shift();
            await state.set('novelQueue', queue);

            // 詞庫與標題識別邏輯
            let mangaKey = navigationContext[task.tabId];
            if (!mangaKey && task.tabId) {
                try {
                    const tabInfo = await chrome.tabs.get(task.tabId);
                    const titleResult = extractMangaTitle(tabInfo.title || '');
                    if (titleResult) {
                        mangaKey = titleResult.romanKey;
                        navigationContext[task.tabId] = mangaKey;
                    }
                } catch (e) {}
            }

            let glossarySnippet = '';
            if (mangaKey) {
                const currentGlossary = await loadGlossary(mangaKey);
                if (currentGlossary?.terms?.length > 0) {
                    glossarySnippet = buildGlossaryPromptSnippet(currentGlossary.terms);
                }
            }

            // 讀取設定
            const modelName = await state.get('novelModelName', 'gemini-1.5-flash');
            const novelPrompt = await state.get('novelPrompt', 'Translate to Traditional Chinese.');
            const requestDelay = await state.get('requestDelay', 3000);

            // 回歸最穩定的單段翻譯模式 (桌機版做法)
            for (let i = 0; i < task.texts.length; i++) {
                const text = task.texts[i];
                if (!text.trim()) continue;

                // 檢查是否停止
                if (await state.get('isStopping')) {
                    log.warn('Background', '小說翻譯任務已被強制停止');
                    break;
                }

                // 暫停輪詢（對齊 v1.8.7 toggleBatchPause 功能）
                while (await state.get('isBatchPaused', false)) {
                    await new Promise(r => setTimeout(r, 500));
                    if (await state.get('isStopping')) break;
                }
                // Warning #1 修復：從暫停退出後，再次確認是否應停止，防止多呼叫一次 API
                if (await state.get('isStopping')) break;

                try {
                    const result = await translateTexts([text], { 
                        model: modelName,
                        prompt: novelPrompt,
                        glossarySnippet
                    }); 
                    
                    // 容錯解析：translateTexts 可能回傳字串或物件
                    const translatedText = (typeof result === 'object') 
                        ? (result.translation || result.trans || result[0]) 
                        : result;

                    const resultItem = { 
                        tabId: task.tabId, 
                        idx: task.startIndex + i,
                        original: text,
                        translation: translatedText || '（翻譯失敗）'
                    };

                    await state.update('novelResults', (current = []) => [...current, resultItem]);
                    await state.setThrottled('novelProgress', {
                        status: `正在翻譯第 ${i + 1} / ${task.texts.length} 段...`,
                        current: i + 1,
                        total: task.texts.length
                    });
                    
                    // 段落間延遲，防止 429 錯誤
                    if (i < task.texts.length - 1) {
                        await new Promise(r => setTimeout(r, requestDelay / 2));
                    }
                } catch (singleErr) {
                    log.error('Background', `第 ${i} 段翻譯失敗:`, singleErr);
                    
                    // 修正：失敗時也推入結果，讓前端顯示重試按鈕
                    const failedItem = { 
                        tabId: task.tabId, 
                        idx: task.startIndex + i,
                        original: text,
                        translation: '（翻譯失敗）',
                        failed: true
                    };
                    await state.update('novelResults', (current = []) => [...current, failedItem]);
                }
            }
        }
    } catch (globalErr) {
        log.error('Background', '小說隊列處理發生全域錯誤:', globalErr);
    } finally {
        await state.set('isProcessingNovel', false);
        await state.set('novelProgress', null);
    }
}

// src/content/ui/MainPanel.js

/**
 * MainPanel: 翻譯控制與進度顯示面板
 */
export function createMainPanel() {
  const panel = document.createElement('div');
  panel.className = 'mt-main-panel';

  panel.innerHTML = `
    <div class="mt-panel-header">
      <span style="font-weight: 600; font-size: 16px;">Manga Translator V3.0</span>
      <button id="mt-close-btn" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 20px;">&times;</button>
    </div>
    <div class="mt-panel-content">
      <div id="mt-status-text" style="font-size: 14px; margin-bottom: 5px;">準備就緒</div>
      <div id="mt-progress-desc" style="font-size: 12px; color: #94a3b8;">等待任務開始...</div>
      
      <div class="mt-progress-wrapper">
        <div id="mt-progress-bar" class="mt-progress-inner"></div>
      </div>

      <!-- Phase 4: 即時譯文預覽區 -->
      <div id="mt-streaming-box" style="margin-top: 15px; height: 80px; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px; font-size: 13px; line-height: 1.5; overflow: hidden; position: relative;">
        <div id="mt-streaming-content" style="transition: transform 0.3s ease;">
          <p style="color: #666; margin: 0;">等待串流數據...</p>
        </div>
        <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 30px; background: linear-gradient(transparent, rgba(15,23,42,0.9)); pointer-events: none;"></div>
      </div>

      <div style="margin-top: 15px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        <button style="background: rgba(255,255,255,0.1); border: none; padding: 10px; border-radius: 8px; color: white; font-size: 13px;">設定</button>
        <button style="background: #4f46e5; border: none; padding: 10px; border-radius: 8px; color: white; font-size: 13px;">切換模式</button>
      </div>
    </div>
  `;

  // 內部狀態更新方法
  panel.updateProgress = (percent, statusText, descText) => {
    const bar = panel.querySelector('#mt-progress-bar');
    const status = panel.querySelector('#mt-status-text');
    const desc = panel.querySelector('#mt-progress-desc');
    
    if (bar) bar.style.width = `${percent}%`;
    if (status && statusText) status.textContent = statusText;
    if (desc && descText) desc.textContent = descText;
  };

  /**
   * 增加串流譯文 (Phase 4)
   */
  panel.addStreamingText = (text) => {
    const content = panel.querySelector('#mt-streaming-content');
    if (!content) return;

    if (content.innerHTML.includes('等待串流數據')) {
        content.innerHTML = '';
    }

    const p = document.createElement('p');
    p.style.margin = '0 0 8px 0';
    p.style.opacity = '0';
    p.style.transition = 'opacity 0.5s';
    p.textContent = text;
    
    content.appendChild(p);
    
    // 觸發淡入與自動捲動
    requestAnimationFrame(() => {
        p.style.opacity = '1';
        const box = panel.querySelector('#mt-streaming-box');
        box.scrollTo({ top: content.scrollHeight, behavior: 'smooth' });
    });
  };

  const closeBtn = panel.querySelector('#mt-close-btn');
  closeBtn.onclick = () => panel.classList.remove('is-visible');

  return panel;
}

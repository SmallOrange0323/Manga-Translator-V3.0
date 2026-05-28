// src/content/ui/FloatingButton.js

/**
 * FloatingButton: 懸浮進入點組件
 * 負責處理觸控拖拽與 3 秒自動靠邊邏輯
 */
export function createFloatingButton(onClick) {
  const btn = document.createElement('div');
  btn.className = 'mt-floating-button';
  
  // 注入圖示 (Vite 會處理路徑)
  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('icon128.png');
  btn.appendChild(img);

  let isDragging = false;
  let startX, startY, initialX, initialY;
  let dockTimer = null;

  // 重設自動靠邊計時器
  const resetDockTimer = () => {
    btn.classList.remove('is-docked');
    clearTimeout(dockTimer);
    dockTimer = setTimeout(() => {
      btn.classList.add('is-docked');
    }, 3000);
  };

  // 初始化計時器
  resetDockTimer();

  // 指標按下事件 (支援滑鼠與觸控)
  btn.onpointerdown = (e) => {
    isDragging = false;
    startX = e.clientX;
    startY = e.clientY;
    
    // 取得目前位置
    const rect = btn.getBoundingClientRect();
    initialX = rect.left;
    initialY = rect.top;

    btn.setPointerCapture(e.pointerId);
    resetDockTimer();
  };

  // 指標移動事件
  btn.onpointermove = (e) => {
    if (e.buttons !== 1) return;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      isDragging = true;
      btn.classList.remove('is-docked');
    }

    if (isDragging) {
      // 優先使用視覺視口 (Visual Viewport) 以處理行動端縮放
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      
      const newX = Math.max(0, Math.min(viewportWidth - 60, initialX + dx));
      const newY = Math.max(0, Math.min(viewportHeight - 60, initialY + dy));
      
      btn.style.left = `${newX}px`;
      btn.style.top = `${newY}px`;
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    }
  };

  // 指標放開事件
  btn.onpointerup = (e) => {
    btn.releasePointerCapture(e.pointerId);
    if (!isDragging) {
      onClick();
    }
    resetDockTimer();
  };

  return btn;
}

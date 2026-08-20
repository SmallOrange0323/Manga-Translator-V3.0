// src/content/ui/FloatingButton.js

/**
 * FloatingButton: 行動端懸浮按鈕完全體組件
 * 支援：自由拖曳、左/右自動吸附、位置持久化記憶、2秒閒置半透明貼邊微縮
 */
export function createFloatingButton(onClick) {
  const btn = document.createElement('div');
  btn.className = 'mt-floating-button';
  btn.dataset.side = 'right'; // 預設靠右
  
  // 注入和風圖示
  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('icon128.png');
  btn.appendChild(img);

  let isDragging = false;
  let hasMoved = false;
  let startX, startY, initialX, initialY;
  let dockTimer = null;

  // 讀取上次記憶的位置
  try {
    chrome.storage.local.get(['mt_fab_position'], (res) => {
      const pos = res?.mt_fab_position;
      if (pos && typeof pos.topPercent === 'number') {
        const viewportHeight = window.visualViewport?.height || window.innerHeight;
        const targetTop = Math.max(50, Math.min(viewportHeight - 100, (viewportHeight * pos.topPercent) / 100));
        btn.style.top = `${targetTop}px`;
        btn.style.bottom = 'auto';

        if (pos.side === 'left') {
          btn.style.left = '0px';
          btn.style.right = 'auto';
          btn.dataset.side = 'left';
        } else {
          btn.style.right = '0px';
          btn.style.left = 'auto';
          btn.dataset.side = 'right';
        }
      }
    });
  } catch (_) {}

  // 重設自動貼邊微縮計時器 (2 秒閒置自動收納)
  const resetDockTimer = () => {
    btn.classList.remove('is-docked');
    clearTimeout(dockTimer);
    dockTimer = setTimeout(() => {
      if (!isDragging) {
        btn.classList.add('is-docked');
      }
    }, 2000);
  };

  resetDockTimer();

  // 指標按下事件 (支援滑鼠與觸控)
  btn.onpointerdown = (e) => {
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    
    const rect = btn.getBoundingClientRect();
    initialX = rect.left;
    initialY = rect.top;

    btn.setPointerCapture(e.pointerId);
    btn.classList.remove('is-docked');
    clearTimeout(dockTimer);
  };

  // 指標移動事件 (拖曳中)
  btn.onpointermove = (e) => {
    if (!isDragging) return;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
      hasMoved = true;
    }

    if (hasMoved) {
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      
      const newX = Math.max(0, Math.min(viewportWidth - 52, initialX + dx));
      const newY = Math.max(20, Math.min(viewportHeight - 70, initialY + dy));
      
      btn.style.left = `${newX}px`;
      btn.style.top = `${newY}px`;
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    }
  };

  // 指標放開事件 (自動邊緣吸附與記憶)
  btn.onpointerup = (e) => {
    if (!isDragging) return;
    isDragging = false;
    btn.releasePointerCapture(e.pointerId);

    if (hasMoved) {
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const rect = btn.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;

      // 判斷靠左還是靠右
      const isLeft = centerX < viewportWidth / 2;
      btn.dataset.side = isLeft ? 'left' : 'right';

      btn.style.left = isLeft ? '0px' : 'auto';
      btn.style.right = isLeft ? 'auto' : '0px';

      const topPercent = Math.round((rect.top / viewportHeight) * 100);

      // 持久化儲存位置偏好
      try {
        chrome.storage.local.set({
          mt_fab_position: { side: isLeft ? 'left' : 'right', topPercent }
        });
      } catch (_) {}
    } else {
      // 純點擊
      onClick();
    }

    resetDockTimer();
  };

  btn.onpointercancel = () => {
    isDragging = false;
    resetDockTimer();
  };

  return btn;
}

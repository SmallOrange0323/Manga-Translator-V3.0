// src/content/ui-manager.js
import styles from './ui/styles.css?inline';

/**
 * UIManager: 負責管理 Shadow DOM 的生命週期與 UI 注入
 */
class UIManager {
  constructor() {
    this.host = null;
    this.shadowRoot = null;
    this.container = null;
  }

  /**
   * 初始化 Shadow DOM 容器
   */
  init() {
    if (this.host) return;

    // 1. 建立 Host 元素
    this.host = document.createElement('div');
    this.host.id = 'mt-v2-host';
    
    // 2. 使用 closed 模式確保純淨隔離
    this.shadowRoot = this.host.attachShadow({ mode: 'closed' });

    // 3. 注入 CSS 
    const styleTag = document.createElement('style');
    styleTag.textContent = styles;
    this.shadowRoot.appendChild(styleTag);

    // 4. 建立 UI 根容器
    this.container = document.createElement('div');
    this.container.className = 'mt-root-container';
    this.shadowRoot.appendChild(this.container);

    // 5. 注入到宿主網頁的 Body
    document.body.appendChild(this.host);
    console.log('[Manga Translator V2] Shadow UI Manager Initialized');
  }

  /**
   * 將組件掛載到 Shadow Root 內
   * @param {HTMLElement} element 
   */
  addComponent(element) {
    if (!this.container) this.init();
    this.container.appendChild(element);
  }
}

export const uiManager = new UIManager();

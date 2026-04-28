/**
 * @fileoverview Main page thumbnail save buttons
 * 
 * Uses site-configs.js for site-specific selectors and URL patterns.
 * Uses thumb-button-config.js for button styles.
 * 
 * To add a new site:
 * 1. Add entry to SITE_CONFIGS in site-configs.js
 * 2. Add URL patterns to manifest.json
 * 
 * @module main-page-buttons
 */

class MainPageButtons {
  constructor() {
    /** @type {Set<string>} Track which post IDs already have buttons */
    this.processedPosts = new Set();
    
    /** @type {Map<string, HTMLElement>} Map of post ID to button element */
    this.buttonMap = new Map();
    
    /** @type {MutationObserver|null} Observer for new thumbnails */
    this.observer = null;
    
    /** @type {string|null} Current site hostname */
    this.hostname = window.location.hostname;
    
    /** @type {Object|null} Current site config */
    this.siteConfig = null;
    
    /** @type {string|null} Site config key */
    this.siteConfigKey = null;
    
    /** @type {number|null} Long press timer */
    this._longPressTimer = null;
    
    /** @type {boolean} Whether a long press was triggered */
    this._longPressTriggered = false;
    
    /** @type {number} Long press duration in ms */
    this.LONG_PRESS_DURATION = 500;
    
    // Initialize
    this.init();
  }

  /**
   * Initialize the main page buttons system
   */
  init() {
    // Find site config
    const found = findSiteConfig();
    if (!found) {
      console.warn('[BooruEagle MainPageButtons] No site config found for:', this.hostname);
      return;
    }
    
    this.siteConfig = found.config;
    this.siteConfigKey = found.key;
    
    console.log('[BooruEagle MainPageButtons] Initializing on:', this.siteConfig.name);
    
    // Inject CSS
    this.injectStyles();
    
    // Add buttons to existing thumbnails
    this.scanAndAddButtons();
    
    // Watch for new thumbnails (infinite scroll, SPA navigation)
    this.observeNewThumbnails();
    
    // Listen for save results from background (for hidden tab saves)
    this._setupSaveResultListener();
    
    console.log('[BooruEagle MainPageButtons] Initialized');
  }

  /**
   * Listen for saveResult messages from background worker
   * Updates button state when hidden tab save completes
   */
  _setupSaveResultListener() {
    if (window._booruEagleMainPageMsgListener) return;
    window._booruEagleMainPageMsgListener = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'saveResult' && message.taskId?.startsWith('hidden-')) {
        // Extract post ID from taskId: "hidden-{postId}-{timestamp}-{random}"
        const parts = message.taskId.split('-');
        // parts[0] = "hidden", parts[1] = postId, rest = timestamp+random
        const postId = parts[1];

        // Find the button for this post
        const btn = this.buttonMap.get(postId);
        if (btn) {
          if (message.success) {
            btn.classList.remove('saving');
            btn.classList.add('success');
            btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipSuccess);

            setTimeout(() => {
              btn.classList.remove('success');
              btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipDefault);
            }, 2000);
          } else {
            btn.classList.remove('saving');
            btn.classList.add('error');
            btn.setAttribute('data-tooltip', `${THUMB_BUTTON_CONFIG.tooltipError}${message.error || 'Unknown'}`);

            setTimeout(() => {
              btn.classList.remove('error');
              btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipDefault);
            }, 3000);
          }
        }

        sendResponse({ ok: true });
      }
    });

    // ALSO listen for progress updates from storage (global sync)
    this._setupStorageSyncListener();
  }

  /**
   * Listen for save-progress changes in chrome.storage
   * This keeps buttons synced across ALL tabs
   */
  _setupStorageSyncListener() {
    if (window._booruEagleMainPageStorageListener) return;
    window._booruEagleMainPageStorageListener = true;

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (!changes['save-progress']) return;

      const progressData = changes['save-progress'].newValue;
      if (!progressData) return;

      // Update all buttons that are in "saving" state
      document.querySelectorAll(`.${THUMB_BUTTON_CONFIG.buttonClass}.saving`).forEach(btn => {
        // Update tooltip to show progress
        if (progressData.text) {
          btn.setAttribute('data-tooltip', progressData.text);
        }
      });

      // When save is complete, reset buttons
      if (progressData.progress >= 100) {
        setTimeout(() => {
          document.querySelectorAll(`.${THUMB_BUTTON_CONFIG.buttonClass}.saving`).forEach(btn => {
            btn.classList.remove('saving');
            btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipDefault);
          });
        }, 1500);
      }
    });
  }

  /**
   * Inject CSS styles for the buttons
   */
  injectStyles() {
    // Check if styles already injected
    if (document.getElementById('booru-eagle-main-page-styles')) return;
    
    const styleEl = document.createElement('style');
    styleEl.id = 'booru-eagle-main-page-styles';
    styleEl.textContent = THUMB_BUTTON_CONFIG.css;
    
    document.head.appendChild(styleEl);
    console.log('[BooruEagle MainPageButtons] Styles injected');
  }

  /**
   * Scan the page for thumbnails and add buttons
   */
  scanAndAddButtons() {
    const posts = this.getPostElements();

    posts.forEach(postEl => {
      this.addButtonToPost(postEl);
    });

    // Prune stale entries on very long-lived pages (infinite scroll)
    // Reduced limit from 5000 to 1000 to keep memory usage low
    if (this.processedPosts.size > 1000) {
      console.log('[BooruEagle MainPageButtons] Pruning stale processed posts');
      
      // Keep only buttons that are still in the DOM
      const activeIds = new Set();
      document.querySelectorAll(`.${THUMB_BUTTON_CONFIG.containerClass}`).forEach(container => {
        if (container.dataset.postId) activeIds.add(container.dataset.postId);
      });

      // Clear Set/Map and only re-add active ones
      const oldProcessed = new Set(this.processedPosts);
      this.processedPosts.clear();
      this.buttonMap.clear();

      activeIds.forEach(id => {
        if (oldProcessed.has(id)) {
          this.processedPosts.add(id);
          const btn = document.querySelector(`div[data-post-id="${id}"] .${THUMB_BUTTON_CONFIG.buttonClass}`);
          if (btn) this.buttonMap.set(id, btn);
        }
      });
      
      console.log(`[BooruEagle MainPageButtons] Pruned. Active posts kept: ${this.processedPosts.size}`);
    }
  }

  /**
   * Get all post thumbnail elements on the page using site config selectors
   * @returns {HTMLElement[]} Array of post elements
   */
  getPostElements() {
    if (!this.siteConfig) return [];
    
    const elements = [];
    for (const selector of this.siteConfig.thumbSelectors) {
      const found = document.querySelectorAll(selector);
      if (found.length > 0) {
        found.forEach(el => elements.push(el));
        break; // Use first matching selector
      }
    }
    
    return elements;
  }

  /**
   * Add a save button to a single post element
   * @param {HTMLElement} postEl - The post container element
   */
  addButtonToPost(postEl) {
    if (!this.siteConfig) return;
    
    // Get post ID
    const postId = this.siteConfig.idExtractor(postEl);
    if (!postId) {
      console.warn('[BooruEagle MainPageButtons] Could not get post ID for element:', postEl);
      return;
    }
    
    // Skip if already processed
    if (this.processedPosts.has(postId)) {
      return;
    }
    
    this.processedPosts.add(postId);
    
    // Create button container
    const container = document.createElement('div');
    container.className = THUMB_BUTTON_CONFIG.containerClass;
    container.dataset.postId = postId;
    
    // Create save button
    const btn = document.createElement('button');
    btn.className = THUMB_BUTTON_CONFIG.buttonClass;
    btn.innerHTML = THUMB_BUTTON_CONFIG.icon;
    btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipDefault);
    btn.setAttribute('aria-label', THUMB_BUTTON_CONFIG.tooltipDefault);
    
    // Store reference
    this.buttonMap.set(postId, btn);
    
    // Long press handler (set parent)
    this._setupLongPress(btn, postId);
    
    // Click handler
    btn.addEventListener('click', (e) => {
      // Don't handle click if long press was triggered
      if (this._longPressTriggered) {
        this._longPressTriggered = false;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.handleSaveClick(postId, btn, postEl);
    });
    
    container.appendChild(btn);
    
    // Append to post element
    const targetContainer = postEl.querySelector(this.siteConfig.thumbContainerSelector) || postEl;
    targetContainer.style.position = 'relative';
    targetContainer.appendChild(container);
    
  }

  /**
   * Handle save button click
   * @param {string} postId - Post ID
   * @param {HTMLElement} btn - Button element
   * @param {HTMLElement} postEl - Post container element
   */
  async handleSaveClick(postId, btn, postEl) {
    // Prevent double-click
    if (btn.classList.contains('saving')) {
      return;
    }

    console.log('[BooruEagle MainPageButtons] Save clicked for post:', postId);

    // Update button state
    btn.classList.add('saving');
    btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipSaving);

    try {
      // Get locked parent ID from storage (set via long press or panel)
      const storageResult = await chrome.storage.local.get('locked-parent-id');
      const lockedParentId = storageResult['locked-parent-id'] || null;

      // Send message to background to open hidden tab and enqueue
      const result = await chrome.runtime.sendMessage({
        action: 'saveFromMainPage',
        postId: postId,
        hostname: this.hostname,
        lockedParentId: lockedParentId
      });

      if (result?.success) {
        // Task was enqueued successfully
        // Show queue position
        btn.setAttribute('data-tooltip', `Queue #${result.position}`);

        // Store taskId on button for tracking
        if (result.taskId) {
          btn.dataset.taskId = result.taskId;
        }

        // The button will be updated when the queue completes via saveResult message
        // No need to wait - the queue handles the rest
      } else {
        throw new Error(result?.error || 'Unknown error');
      }
    } catch (error) {
      console.error('[BooruEagle MainPageButtons] Save failed:', error);

      btn.classList.remove('saving');
      btn.classList.add('error');
      btn.setAttribute('data-tooltip', `${THUMB_BUTTON_CONFIG.tooltipError}${error.message}`);

      // Reset after delay
      setTimeout(() => {
        btn.classList.remove('error');
        btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipDefault);
      }, 3000);
    }
  }

  /**
   * Setup long press handler on button
   * Long press (500ms) sets the post as parent, same as panel's Set Parent button
   * @param {HTMLElement} btn - Button element
   * @param {string} postId - Post ID
   * @private
   */
  _setupLongPress(btn, postId) {
    const startLongPress = (e) => {
      // Don't trigger on right click
      if (e.button === 2) return;
      
      this._longPressTriggered = false;
      
      this._longPressTimer = setTimeout(() => {
        this._longPressTriggered = true;
        this._handleSetParent(postId, btn);
      }, this.LONG_PRESS_DURATION);
    };
    
    const cancelLongPress = () => {
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
    };
    
    // Mouse events
    btn.addEventListener('mousedown', startLongPress);
    btn.addEventListener('mouseup', cancelLongPress);
    btn.addEventListener('mouseleave', cancelLongPress);
    
    // Touch events for mobile
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startLongPress(e);
    });
    btn.addEventListener('touchend', cancelLongPress);
    btn.addEventListener('touchcancel', cancelLongPress);
  }

  /**
   * Handle long press - set post as parent
   * Syncs with panel's Set Parent state via chrome.storage
   * @param {string} postId - Post ID to set as parent
   * @param {HTMLElement} btn - Button element for visual feedback
   * @private
   */
  async _handleSetParent(postId, btn) {
    console.log('[BooruEagle MainPageButtons] Long press - setting parent:', postId);
    
    // Visual feedback
    btn.classList.add('parent-set');
    btn.setAttribute('data-tooltip', `Parent: #${postId}`);
    
    // Save parent state to chrome.storage (synced with panel)
    try {
      await chrome.storage.local.set({
        'set-parent-enabled': true,
        'locked-parent-id': postId
      });
      
      // Show toast via panel if available
      // The panel will pick up the storage change and update its UI
      
      // Reset button visual after short delay
      setTimeout(() => {
        btn.classList.remove('parent-set');
        btn.setAttribute('data-tooltip', `Parent set: #${postId}`);
      }, 1500);
    } catch (e) {
      console.error('[BooruEagle MainPageButtons] Failed to save parent state:', e);
      btn.classList.remove('parent-set');
      btn.setAttribute('data-tooltip', 'Failed to set parent');
    }
  }

  /**
   * Observe the page for new thumbnails (infinite scroll, SPA navigation)
   */
  observeNewThumbnails() {
    if (!this.siteConfig) return;
    
    if (this.observer) {
      this.observer.disconnect();
    }
    
    // Build selector list from site config
    const selectors = this.siteConfig.thumbSelectors.join(', ');
    
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if added node is a post element or contains one
              if (node.matches?.(selectors) || node.querySelector?.(selectors)) {
                shouldScan = true;
                break;
              }
            }
          }
        }
        if (shouldScan) break;
      }
      
      if (shouldScan) {
        // Debounce to avoid excessive scanning
        clearTimeout(this._scanTimeout);
        this._scanTimeout = setTimeout(() => {
          this.scanAndAddButtons();
        }, 500);
      }
    });
    
    // Observe the content area for changes
    const target = document.querySelector(this.siteConfig.observerTarget) || document.body;
    
    if (target) {
      this.observer.observe(target, {
        childList: true,
        subtree: true
      });
      console.log('[BooruEagle MainPageButtons] Observer attached to:', this.siteConfig.observerTarget);
    }
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    // Clear pending scan timeout
    if (this._scanTimeout) {
      clearTimeout(this._scanTimeout);
      this._scanTimeout = null;
    }

    // Clear pending long press timer
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }

    // Mark as destroyed to abort any pending operations
    this._destroyed = true;

    // Remove all buttons
    document.querySelectorAll(`.${THUMB_BUTTON_CONFIG.containerClass}`).forEach(el => el.remove());

    this.processedPosts.clear();
    this.buttonMap.clear();

    console.log('[BooruEagle MainPageButtons] Destroyed');
  }
}

// Export for use in main.js
window.MainPageButtons = MainPageButtons;
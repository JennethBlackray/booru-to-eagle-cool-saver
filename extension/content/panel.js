/**
 * @fileoverview Booru to Eagle Saver - Floating Panel Module
 * 
 * Handles panel creation, dragging, collapsing, and full cross-tab synchronization.
 * Uses chrome.storage.local for cross-domain communication between all supported sites.
 * 
 * Cross-Tab Sync Architecture:
 * - All panels write to chrome.storage.local['panel-sync-data']
 * - All panels listen for changes via chrome.storage.onChanged
 * - Each message has a unique tabId + timestamp to prevent echo
 * - Debounce prevents storage flooding during drag
 * 
 * @module panel
 */

class BooruEaglePanel {
  constructor() {
    // DOM element
    this.panel = null;
    
    // Drag state
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.hasBeenDragged = false;
    this._dragDebounceTimer = null;
    
    // Collapse state
    this.isCollapsed = false;
    
    // Unique ID for this panel instance (prevents echo)
    this._panelId = `panel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this._lastBroadcastId = null;
    
     /**
      * Current panel state - synced across all tabs/domains
      * @type {Object}
      * @property {string|null} site - Current site display name
      * @property {string|null} imageUrl - Original image URL
      * @property {string[]} tags - Array of tags
      * @property {string} status - Status type: idle|ready|loading|error|success|warning
      * @property {string} statusMessage - Human-readable status text
      * @property {boolean} setParentEnabled - Set Parent toggle state
      * @property {string|null} lockedParentId - Locked parent post ID (when Set Parent is ON)
      * @property {boolean} postSaveEnabled - Post-save action toggle (close tab after save)
      * @property {boolean} buttonsEnabled - Whether buttons are enabled
      * @property {string|null} postId - Post ID from URL
      * @property {Object|null} dimensions - Image dimensions {width, height}
      */
     this.state = {
       site: null,
       imageUrl: null,
       tags: [],
       status: 'idle',
       statusMessage: 'Ready',
       setParentEnabled: false,
       lockedParentId: null,
       postSaveEnabled: false,
       buttonsEnabled: false,
       postId: null,
       dimensions: null
     };
    
    // Saved position from localStorage
    this.savedPosition = null;
    
    // Storage listener reference (for cleanup)
    this._storageListener = null;
    
    // Initialize cross-tab sync
    this._initStorageSync();
    
    // Load saved position
    this.loadPosition();
    
    // Load saved states from chrome.storage
    this._loadSetParentState();
    this._loadPostSaveState();
    
    // Create panel
    this.init();
    
    // Listen for tab visibility changes to update post ID
    this._initTabVisibilityListener();
  }

  /**
   * Listen for tab visibility changes (when user switches tabs)
   * Updates post ID from current page when Set Parent is OFF
   * @private
   */
  _initTabVisibilityListener() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.state.setParentEnabled) {
        // Tab became visible and Set Parent is OFF - update post ID from current page
        this._updatePostIdFromCurrentPage();
        this.updatePostIdDisplay();
      }
    });
    
    // Also listen for focus events for faster response
    window.addEventListener('focus', () => {
      if (!this.state.setParentEnabled) {
        this._updatePostIdFromCurrentPage();
        this.updatePostIdDisplay();
      }
    });
  }

  /**
   * Initialize chrome.storage listener for cross-tab synchronization
   * This listener receives messages from panels on OTHER domains
   */
  _initStorageSync() {
    this._storageListener = (changes, areaName) => {
      if (areaName !== 'local') return;
      
      // Handle panel sync messages (cross-tab communication)
      if (changes['panel-sync-data']) {
        const message = changes['panel-sync-data'].newValue;
        if (message && message.sourceId !== this._panelId) {
          this.handleSyncMessage(message);
        }
      }
      
      // Handle set-parent state changes (from thumbnail button long press)
      if (changes['set-parent-enabled'] || changes['locked-parent-id']) {
        const enabled = changes['set-parent-enabled']?.newValue ?? this.state.setParentEnabled;
        const lockedId = changes['locked-parent-id']?.newValue ?? this.state.lockedParentId;

        if (this.state.setParentEnabled !== enabled || this.state.lockedParentId !== lockedId) {
          this.state.setParentEnabled = enabled;
          this.state.lockedParentId = lockedId;

          // Update UI
          if (this.panel) {
            this.updateToggleButton('#panel-set-parent-btn', enabled);
            this.updatePostIdDisplay();

            // Show toast notification
            if (enabled && lockedId) {
              this.showToast(`Parent set: #${lockedId}`, 'success');
            }
          }
        }
      }
    };
    
    try {
      chrome.storage.onChanged.addListener(this._storageListener);
    } catch (e) {
      console.warn('[BooruEagle Panel] Storage sync not available:', e);
    }
  }

  /**
   * Clean up storage listener to prevent memory leaks
   */
  _cleanupStorageSync() {
    if (this._storageListener) {
      try {
        chrome.storage.onChanged.removeListener(this._storageListener);
      } catch (e) {
        // Ignore cleanup errors
      }
      this._storageListener = null;
    }
  }

  /**
   * Initialize the panel element
   */
  init() {
    try {
      this.panel = document.createElement('div');
      this.panel.id = 'booru-eagle-panel';
      this.panel.innerHTML = this.getPanelHTML();
      
      // Add to document
      if (!document.body) {
        console.error('[BooruEagle Panel] document.body not available');
        return;
      }
      document.body.appendChild(this.panel);
      
      // Setup event listeners
      this.setupDragListeners();
      this.setupControlListeners();
      
      // Apply saved position or use CSS default
      this.applyPosition();
      
      // Panel is visible by default
      this.panel.classList.add('panel-visible');
      
      console.log('[BooruEagle Panel] Panel created, ID:', this._panelId);
    } catch (e) {
      console.error('[BooruEagle Panel] Failed to create panel:', e);
    }
  }

  /**
   * Get panel HTML template
   * @returns {string} HTML string
   */
  getPanelHTML() {
    return `
      <div class="panel-header">
        <div class="panel-title">
          <span class="panel-icon">🦅</span>
          <span>Eagle Saver</span>
        </div>
        <div class="panel-controls">
        </div>
      </div>
      <div class="panel-body">
        <div class="panel-info">
          <span class="status-dot"></span>
           <span class="panel-info-post-id" id="panel-info-post-id">-</span>
          <span class="panel-info-separator">|</span>
          <span class="panel-info-resolution">-</span>
          <span class="panel-info-separator">|</span>
          <span class="panel-info-tags">0 tags</span>
        </div>
        <div class="btn-row">
          <button class="action-btn action-btn-primary" id="panel-save-btn" disabled>
            <span class="btn-text">Save</span>
            <span class="btn-progress-fill" style="--progress: 0%"></span>
          </button>
        </div>
        <div class="btn-row">
          <button class="action-btn action-btn-secondary action-btn-toggle" id="panel-set-parent-btn">
            Set Parent
          </button>
          <button class="action-btn action-btn-secondary" id="panel-stop-btn">
            Stop
          </button>
           <button class="action-btn action-btn-secondary action-btn-toggle" id="panel-post-save-btn" disabled title="Post-save auto-close page">
             ⏻
           </button>
        </div>
      </div>
    `;
  }

  // ==================== DRAG & DROP ====================

  /**
   * Setup drag and drop listeners
   * Uses capture phase to intercept events before site handlers
   */
  setupDragListeners() {
    const header = this.panel?.querySelector('.panel-header');
    if (!header) return;
    
    // Bind methods to preserve `this`
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    
    // Use capture phase to intercept before site handlers
    header.addEventListener('mousedown', this._onPointerDown, true);
    document.addEventListener('mousemove', this._onPointerMove, true);
    document.addEventListener('mouseup', this._onPointerUp, true);
  }

  _onPointerDown(e) {
    // Don't drag when clicking buttons
    if (e.target.closest('.panel-btn') || e.target.closest('.action-btn')) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    this.isDragging = true;
    this.panel.classList.add('panel-dragging');
    
    const rect = this.panel.getBoundingClientRect();
    this.dragOffset.x = e.clientX - rect.left;
    this.dragOffset.y = e.clientY - rect.top;
  }

  _onPointerMove(e) {
    if (!this.isDragging) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const x = e.clientX - this.dragOffset.x;
    const y = e.clientY - this.dragOffset.y;
    
    // Clamp to viewport
    const w = this.panel.offsetWidth;
    const h = this.panel.offsetHeight;
    const clampedX = Math.max(0, Math.min(x, window.innerWidth - w));
    const clampedY = Math.max(0, Math.min(y, window.innerHeight - h));
    
    // Use setProperty with 'important' priority to override site styles
    this.panel.style.setProperty('left', clampedX + 'px', 'important');
    this.panel.style.setProperty('top', clampedY + 'px', 'important');
  }

  _onPointerUp(e) {
    if (!this.isDragging) return;
    
    this.isDragging = false;
    this.panel.classList.remove('panel-dragging');
    this.savePosition();
    
    // Broadcast position to other tabs (debounced)
    const rect = this.panel.getBoundingClientRect();
    this._broadcastDebounced({
      type: 'position',
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      hasBeenDragged: true
    });
  }

  // ==================== BUTTON HANDLERS ====================

  /**
   * Setup control button listeners
   */
  setupControlListeners() {
    // Use event delegation for action buttons to handle disabled state changes
    const panelBody = this.panel?.querySelector('.panel-body');
    if (panelBody) {
      panelBody.addEventListener('click', (e) => {
        const target = e.target.closest('.action-btn');
        if (!target) return;

        const id = target.id;
        if (id === 'panel-save-btn') {
          this.onSaveClick();
        } else if (id === 'panel-set-parent-btn') {
          e.preventDefault();
          this.onSetParentClick();
        } else if (id === 'panel-stop-btn') {
          this.onStopClick();
        } else if (id === 'panel-post-save-btn') {
          this.onPostSaveClick();
        }
      });
    }
    
    // Tags element - click to copy tags
    const tagsEl = this.panel?.querySelector('.panel-info-tags');
    if (tagsEl) {
      tagsEl.addEventListener('click', () => this.onTagsClick());
      tagsEl.style.cursor = 'pointer';
      tagsEl.title = 'Click to copy tags';
    }
  }

  /**
   * Handle click on tag count - copy all tags to clipboard
   * Tags are formatted as they are sent to Eagle: artist:name, rating:rating, etc.
   * Underscores are replaced with spaces
   */
  async onTagsClick() {
    const tags = this.state.tags || [];
    if (tags.length === 0) {
      this.showToast('No tags to copy', 'error');
      return;
    }
    
    // Format tags: replace underscores with spaces, keep prefixes like artist:, rating:, etc.
    const formattedTags = tags.map(tag => tag.replace(/_/g, ' '));
    const tagsText = formattedTags.join(', ');
    
    try {
      await navigator.clipboard.writeText(tagsText);
      this.showToast(`Copied ${tags.length} tags`, 'success');
    } catch (e) {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = tagsText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        this.showToast(`Copied ${tags.length} tags`, 'success');
      } catch (err) {
        this.showToast('Failed to copy tags', 'error');
      }
      document.body.removeChild(textarea);
    }
  }


  /**
   * Close the panel and clean up resources
   */
  close() {
    this.panel?.classList.remove('panel-visible');
    this._cleanupStorageSync();
    this.broadcast({ type: 'close' });

    // Remove immediately - no delay
    if (this.panel && this.panel.parentNode) {
      this.panel.remove();
    }
    this.panel = null;
  }

  // ==================== STATE UPDATES ====================

  /**
   * Update panel status dot color
   * @param {string} status - Status type
   * @param {string} [message] - Optional message (not displayed, only for sync)
   */
  updateStatus(status, message) {
    if (!this.panel) return;
    
    this.state.status = status;
    if (message) this.state.statusMessage = message;
    
    const dot = this.panel.querySelector('.status-dot');
    if (!dot) return;
    
    dot.className = 'status-dot';
    
    switch (status) {
      case 'ready':
      case 'success':
        // Green dot (default)
        break;
      case 'loading':
      case 'warning':
        dot.classList.add('status-warning');
        break;
      case 'error':
        dot.classList.add('status-error');
        break;
    }
  }

  /**
   * Update panel with parsed data
   * @param {Object} data - Parsed data from booru-parser
   */
  updateData(data) {
    if (!this.panel) return;
    
    this.state = { ...this.state, ...data };
    
    // Update post ID
    if (data.postId) {
      const postIdEl = this.panel.querySelector('.panel-info-post-id');
      if (postIdEl) postIdEl.textContent = `#${data.postId}`;
    }
    
    // Update post ID display (handles locked parent highlight)
    this.updatePostIdDisplay();
    
    // Update resolution
    if (data.dimensions && data.dimensions.width > 0 && data.dimensions.height > 0) {
      const resEl = this.panel.querySelector('.panel-info-resolution');
      if (resEl) resEl.textContent = `[${data.dimensions.width}x${data.dimensions.height}]`;
    }
    
    // Update tag count
    const tagCount = data.tags?.length || 0;
    const tagsEl = this.panel.querySelector('.panel-info-tags');
    if (tagsEl) tagsEl.textContent = `${tagCount} tags`;
    
    // Update rating highlight
    this.updateRatingHighlight(data.tags || []);
    
    // Broadcast data to other tabs
    this.broadcast({
      type: 'data',
      data: this.state
    });
  }

  /**
   * Update save button progress bar (synced across all tabs)
   * Only updates the visual progress bar, does NOT disable the button
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} [text] - Button text (default: 'Saving...')
   */
  updateSaveProgress(percent, text) {
    const saveBtn = this.panel?.querySelector('#panel-save-btn');
    if (!saveBtn) return;
    
    const progressFill = saveBtn.querySelector('.btn-progress-fill');
    const btnText = saveBtn.querySelector('.btn-text');
    
    if (progressFill) {
      progressFill.style.setProperty('--progress', `${Math.min(100, Math.max(0, percent))}%`);
    }
    
    if (btnText && text) {
      btnText.textContent = text;
    }
    
    // Add/remove saving class for visual styling only
    if (percent > 0 && percent < 100) {
      saveBtn.classList.add('saving');
    } else if (percent >= 100) {
      saveBtn.classList.remove('saving');
    }
  }

  /**
   * Reset save button to default state
   */
  resetSaveButton() {
    const saveBtn = this.panel?.querySelector('#panel-save-btn');
    if (!saveBtn) return;
    
    const progressFill = saveBtn.querySelector('.btn-progress-fill');
    const btnText = saveBtn.querySelector('.btn-text');
    
    if (progressFill) {
      progressFill.style.setProperty('--progress', '0%');
    }
    if (btnText) {
      btnText.textContent = 'Save';
    }
    saveBtn.classList.remove('saving');
    saveBtn.disabled = false;
  }

  /**
   * Enable only the Post-Save toggle button (used on non-post pages)
   * Set Parent is disabled but can be turned OFF if it was ON from a post page
   * @param {boolean} enabled
   */
  setPostSaveEnabled(enabled) {
    const postSaveBtn = this.panel?.querySelector('#panel-post-save-btn');
    if (postSaveBtn) {
      postSaveBtn.disabled = !enabled;
    }

    // Disable save button (stop button stays enabled)
    const saveBtn = this.panel?.querySelector('#panel-save-btn');
    if (saveBtn) saveBtn.disabled = true;

    // Always refresh postId from current page
    this._updatePostIdFromCurrentPage();
    this.updatePostIdDisplay();
  }

  /**
   * Enable/disable all buttons (Stop button is always enabled)
   * On post pages: all buttons enabled, Set Parent works both ways
   * @param {boolean} enabled
   */
  setButtonsEnabled(enabled) {
    this.state.buttonsEnabled = enabled;

    // Stop button is always enabled
    const stopBtn = this.panel?.querySelector('#panel-stop-btn');
    if (stopBtn) stopBtn.disabled = false;

    // Save button
    const saveBtn = this.panel?.querySelector('#panel-save-btn');
    if (saveBtn) saveBtn.disabled = !enabled;

    // Post-Save toggle
    const postSaveBtn = this.panel?.querySelector('#panel-post-save-btn');
    if (postSaveBtn) postSaveBtn.disabled = !enabled;

    // Set Parent: always enabled (onSetParentClick validates postId internally)
    const setParentBtn = this.panel?.querySelector('#panel-set-parent-btn');
    if (setParentBtn) {
      setParentBtn.disabled = false;
      setParentBtn.removeAttribute('disabled');
    }
  }

  // ==================== BUTTON ACTIONS ====================


  /**
   * Flash Stop button with red animation (synced across all tabs)
   */
  flashStopButton() {
    const stopBtn = this.panel?.querySelector('#panel-stop-btn');
    if (!stopBtn) return;
    
    // Remove class to reset animation
    stopBtn.classList.remove('panel-btn-stop-flash');
    
    // Force reflow to restart animation
    void stopBtn.offsetWidth;
    
    // Add animation class
    stopBtn.classList.add('panel-btn-stop-flash');
    
    // Remove class after animation completes
    setTimeout(() => {
      stopBtn.classList.remove('panel-btn-stop-flash');
    }, 1000);
  }

  /**
   * Handle save button click
   */
  async onSaveClick() {
    const saveBtn = this.panel?.querySelector('#panel-save-btn');
    if (saveBtn) {
      saveBtn.disabled = true;
      const btnText = saveBtn.querySelector('.btn-text');
      if (btnText) btnText.textContent = 'Saving...';
    }
    
    this.updateStatus('loading', 'Saving to Eagle...');
    
    // Dispatch custom event for main.js to handle
    window.dispatchEvent(new CustomEvent('booru-eagle-save', {
      detail: { ...this.state }
    }));
  }

  /**
   * Handle Set Parent button click (toggle on/off)
   * When enabled: locks current post ID as parent for all subsequent saves
   * Synced across all tabs
   */
  onSetParentClick() {
    const newState = !this.state.setParentEnabled;

    if (newState) {
      // Enabling: try to get postId from state, or extract from URL directly
      let postIdToLock = this.state.postId;

      if (!postIdToLock) {
        // Try extracting from URL directly (before parsing completes)
        const url = window.location.href;
        const patterns = [
          /\/post\/show\/([a-zA-Z0-9]+)/i,
          /\/posts\/([a-zA-Z0-9]+)/i,
          /\/post\/view\/([a-zA-Z0-9]+)/i,
          /[?&]id=([a-zA-Z0-9]+)/i,
          /\/en\/posts\/([a-zA-Z0-9]+)/i,  // Sankaku
        ];

        for (const pattern of patterns) {
          const match = url.match(pattern);
          if (match) {
            postIdToLock = match[1];
            break;
          }
        }
      }

      if (!postIdToLock) {
        console.warn('[BooruEagle Panel] Cannot enable Set Parent — no post ID available');
        this.showToast('Set Parent requires a post page', 'warning');
        return;
      }

      this.state.lockedParentId = postIdToLock;
      this.state.postId = postIdToLock;
    } else {
      // Disabling: unlock and refresh post ID from current page
      this.state.lockedParentId = null;
      this._updatePostIdFromCurrentPage();
    }

    this.state.setParentEnabled = newState;

    // Update UI
    this.updateToggleButton('#panel-set-parent-btn', newState);
    this.updatePostIdDisplay();

    // Persist to chrome.storage
    this._saveSetParentState(newState, this.state.lockedParentId);

    // Broadcast to all other tabs
    this.broadcast({
      type: 'setParent',
      enabled: newState,
      lockedParentId: this.state.lockedParentId
    });

    console.log('[BooruEagle Panel] Set Parent:', newState ? 'ON' : 'OFF',
                newState ? `(locked: ${this.state.lockedParentId})` : '');
  }

  /**
   * Handle Stop button click - clears queue and stops current operation
   * Synced across all tabs (flash animation + queue clear)
   */
  onStopClick() {
    console.log('[BooruEagle Panel] Stop clicked');
    
    // Flash the button locally
    this.flashStopButton();
    
    // Broadcast to all other tabs to flash their Stop buttons too
    this.broadcast({
      type: 'stopFlash'
    });
    
    // Clear the queue via background worker
    chrome.runtime.sendMessage({ action: 'clearQueue' }, (response) => {
      if (response?.cleared) {
        console.log('[BooruEagle Panel] Queue cleared');
        this.showToast('Queue cleared', 'info');
      }
    });
  }

  /**
   * Handle Post-Save button click (toggle on/off)
   * When enabled: closes tab after successful save to Eagle
   * Synced across all tabs
   */
  onPostSaveClick() {
    const newState = !this.state.postSaveEnabled;
    this.state.postSaveEnabled = newState;
    
    // Update UI
    this.updateToggleButton('#panel-post-save-btn', newState);
    
    // Persist to chrome.storage for cross-page/navigation persistence
    this._savePostSaveState(newState);
    
    // Broadcast to all other tabs
    this.broadcast({
      type: 'toggle',
      button: 'postSave',
      enabled: newState
    });
    
    console.log('[BooruEagle Panel] Post-Save (close tab):', newState ? 'ON' : 'OFF');
  }

  /**
   * Update toggle button visual state
   * @param {string} selector - CSS selector for button
   * @param {boolean} isActive - Whether button is active
   */
  updateToggleButton(selector, isActive) {
    const btn = this.panel?.querySelector(selector);
    if (!btn) return;

    btn.classList.toggle('active', isActive);
  }

  /**
   * Show toast notification
   * @param {string} message - Toast text
   * @param {string} [type='info'] - Toast type: info|success|error
   */
  showToast(message, type = 'info') {
    // Create toast element if not exists
    let toast = this.panel?.querySelector('.panel-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'panel-toast';
      this.panel?.querySelector('.panel-body')?.appendChild(toast);
    }
    
    if (!toast) return;
    
    toast.textContent = message;
    toast.className = `panel-toast panel-toast-${type} toast-visible`;
    
    setTimeout(() => {
      toast.classList.remove('toast-visible');
    }, 3000);
  }

  // ==================== POSITION PERSISTENCE ====================

  /**
   * Save panel position to localStorage
   */
  savePosition() {
    if (!this.panel) return;
    
    const rect = this.panel.getBoundingClientRect();
    try {
      localStorage.setItem('booru-eagle-panel-x', String(Math.round(rect.left)));
      localStorage.setItem('booru-eagle-panel-y', String(Math.round(rect.top)));
      localStorage.setItem('booru-eagle-panel-dragged', 'true');
    } catch (e) {
      console.warn('[BooruEagle Panel] Could not save position:', e);
    }
  }

  /**
   * Load panel position from localStorage
   */
  loadPosition() {
    try {
      const x = localStorage.getItem('booru-eagle-panel-x');
      const y = localStorage.getItem('booru-eagle-panel-y');
      const dragged = localStorage.getItem('booru-eagle-panel-dragged');
      
      if (x !== null && y !== null) {
        this.savedPosition = {
          x: parseInt(x, 10),
          y: parseInt(y, 10)
        };
        this.hasBeenDragged = dragged === 'true';
      }
    } catch (e) {
      console.warn('[BooruEagle Panel] Could not load position:', e);
    }
  }

  /**
   * Apply saved position to panel
   */
  applyPosition() {
    if (!this.panel) return;
    
    if (this.savedPosition && this.hasBeenDragged) {
      const x = Math.max(0, Math.min(this.savedPosition.x, window.innerWidth - 220));
      const y = Math.max(0, Math.min(this.savedPosition.y, window.innerHeight - 100));
      
      // Use setProperty with 'important' priority to override site styles
      this.panel.style.setProperty('left', x + 'px', 'important');
      this.panel.style.setProperty('top', y + 'px', 'important');
    }
    // Otherwise CSS default (calc(50% - 110px))
  }

  // ==================== CROSS-TAB SYNC ====================

  /**
   * Broadcast message to all other tabs across ALL domains
   * Uses chrome.storage.local for cross-domain communication
   * 
   * Message format:
   * {
   *   sourceId: string,     // Unique panel ID to prevent echo
   *   timestamp: number,    // Message timestamp
   *   type: string,         // Message type
   *   ...other data
   * }
   * 
   * @param {Object} message - Message to broadcast
   */
  broadcast(message) {
    if (!this._panelId) return;
    
    try {
      const fullMessage = {
        sourceId: this._panelId,
        timestamp: Date.now(),
        ...message
      };
      
      this._lastBroadcastId = fullMessage.timestamp;
      
      chrome.storage.local.set({ 'panel-sync-data': fullMessage }, () => {
        // Check for runtime errors (extension context invalidated, etc.)
        if (chrome.runtime.lastError) {
          console.warn('[BooruEagle Panel] Broadcast error:', chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.warn('[BooruEagle Panel] Broadcast failed:', e);
    }
  }

  /**
   * Broadcast with debounce to prevent storage flooding
   * Used for high-frequency events like drag
   * @param {Object} message
   */
  _broadcastDebounced(message) {
    if (this._dragDebounceTimer) {
      clearTimeout(this._dragDebounceTimer);
    }
    
    this._dragDebounceTimer = setTimeout(() => {
      this._dragDebounceTimer = null;
      this.broadcast(message);
    }, 100); // 100ms debounce
  }

  /**
   * Handle sync messages from other tabs
   * 
   * Supported message types:
   * - position: Panel position {x, y, hasBeenDragged}
   * - collapse: Collapsed state {collapsed}
   * - toggle: Toggle button {button, enabled}
   * - data: Panel data {data}
   * - close: Close panel
   * 
   * @param {Object} message - Sync message
   */
  handleSyncMessage(message) {
    if (!this.panel) return;
    
    // Double-check: ignore our own messages
    if (message.sourceId === this._panelId) return;
    if (message.timestamp === this._lastBroadcastId) return;
    
    switch (message.type) {
      case 'close':
        // Don't auto-close, just log
        break;
        
      case 'position':
        if (message.hasBeenDragged) {
          this.hasBeenDragged = true;
          // Use setProperty with 'important' priority to override site styles
          this.panel.style.setProperty('left', message.x + 'px', 'important');
          this.panel.style.setProperty('top', message.y + 'px', 'important');
        }
        break;
        
      case 'data':
        if (message.data) {
          // Preserve local state that shouldn't be overwritten by broadcasts from other tabs:
          // - setParent/lockedParentId: controlled by storage and setParent messages
          // - postId: local to each tab, main pages have null postId which would overwrite post pages
          const localSetParentEnabled = this.state.setParentEnabled;
          const localLockedParentId = this.state.lockedParentId;
          const localPostId = this.state.postId;

          this.state = { ...this.state, ...message.data };
          this.state.setParentEnabled = localSetParentEnabled;
          this.state.lockedParentId = localLockedParentId;
          this.state.postId = localPostId;

          this.updatePostIdDisplay();
        }
        break;

      case 'setParent':
        this.state.setParentEnabled = message.enabled;
        this.state.lockedParentId = message.lockedParentId || null;
        this.updateToggleButton('#panel-set-parent-btn', message.enabled);

        // If Set Parent was turned OFF, update post ID from current page to avoid phantom IDs
        if (!message.enabled) {
          this._updatePostIdFromCurrentPage();
        }

        this.updatePostIdDisplay();
        this._saveSetParentState(message.enabled, message.lockedParentId);

        // If on non-post page and Set Parent was turned ON from another tab,
        // enable the button so user can turn it OFF
        const setParentBtn = this.panel?.querySelector('#panel-set-parent-btn');
        if (setParentBtn) {
          setParentBtn.disabled = false;
          setParentBtn.removeAttribute('disabled');
        }
        break;
        
      case 'toggle':
        if (message.button === 'postSave') {
          this.state.postSaveEnabled = message.enabled;
          this.updateToggleButton('#panel-post-save-btn', message.enabled);
          // Also persist to chrome.storage
          this._savePostSaveState(message.enabled);
        }
        break;
        
      case 'stopFlash':
        // Flash Stop button when another tab clicked Stop
        this.flashStopButton();
        break;
    }
  }

  /**
   * Update rating highlight on tag count element
   * @param {string[]} tags - Array of tags
   */
  updateRatingHighlight(tags) {
    const tagsEl = this.panel?.querySelector('.panel-info-tags');
    if (!tagsEl) return;
    
    // Remove existing rating classes
    tagsEl.classList.remove('rating-sfw', 'rating-questionable', 'rating-explicit');
    tagsEl.removeAttribute('title');
    
    // Find rating tag
    const ratingTag = tags.find(t => t.startsWith('rating:'));
    if (!ratingTag) return;
    
    const rating = ratingTag.replace('rating:', '');
    
    switch (rating) {
      case 'sfw':
        tagsEl.classList.add('rating-sfw');
        tagsEl.title = 'Rating: Safe';
        break;
      case 'questionable':
        tagsEl.classList.add('rating-questionable');
        tagsEl.title = 'Rating: Questionable';
        break;
      case 'explicit':
        tagsEl.classList.add('rating-explicit');
        tagsEl.title = 'Rating: Explicit';
        break;
    }
  }

  /**
   * Update the post ID display with green highlight if parent is locked
   * On main pages (no post ID), shows the site name instead
   */
  updatePostIdDisplay() {
    const postIdEl = this.panel?.querySelector('#panel-info-post-id');
    if (!postIdEl) return;
    
    if (this.state.setParentEnabled && this.state.lockedParentId) {
      // Show locked parent ID with green highlight
      postIdEl.textContent = `#${this.state.lockedParentId}`;
      postIdEl.classList.add('post-id-locked');
    } else if (this.state.postId) {
      // Show current post ID normally
      postIdEl.textContent = `#${this.state.postId}`;
      postIdEl.classList.remove('post-id-locked');
    } else {
      // No post ID - show site name (main page)
      const siteName = this.state.site || 'Unknown';
      postIdEl.textContent = `#${siteName}`;
      postIdEl.classList.remove('post-id-locked');
    }
  }

  /**
   * Update state.postId from the current page URL
   * Called when Set Parent is turned OFF to avoid showing phantom IDs from other pages
   * @private
   */
  _updatePostIdFromCurrentPage() {
    // Extract post ID from URL based on common booru patterns
    const url = window.location.href;
    let postId = null;

    // Try common patterns: /post/show/12345, /posts/12345, ?id=12345
    // Note: Sankaku uses alphanumeric IDs (e.g., abc123def), so we use [a-zA-Z0-9]+
    const patterns = [
      /\/post\/show\/([a-zA-Z0-9]+)/i,      // Gelbooru, Konachan
      /\/posts\/([a-zA-Z0-9]+)/i,           // Danbooru
      /\/en\/posts\/([a-zA-Z0-9]+)/i,       // Sankaku
      /\/post\/view\/([a-zA-Z0-9]+)/i,      // Rule34
      /[?&]id=([a-zA-Z0-9]+)/i,             // Sankaku, others
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        postId = match[1];
        break;
      }
    }

    this.state.postId = postId;
  }

  /**
   * Set the current site display name
   * @param {string} site
   */
  setSite(site) {
    this.state.site = site;
  }

  /**
   * Load saved Set Parent state from chrome.storage
   * Applies immediately if panel exists, otherwise queues for later
   * @private
   */
  async _loadSetParentState() {
    try {
      const result = await chrome.storage.local.get(['set-parent-enabled', 'locked-parent-id']);
      if (result['set-parent-enabled'] !== undefined) {
        this.state.setParentEnabled = result['set-parent-enabled'];
        this.state.lockedParentId = result['locked-parent-id'] || null;

        // Apply to UI immediately if panel exists
        if (this.panel) {
          this.updateToggleButton('#panel-set-parent-btn', this.state.setParentEnabled);
          this.updatePostIdDisplay();
        }
      }
    } catch (e) {
      console.warn('[BooruEagle Panel] Could not load set-parent state:', e);
    }
  }

  /**
   * Save Set Parent state to chrome.storage for persistence
   * @param {boolean} enabled
   * @param {string|null} lockedId
   * @private
   */
  _saveSetParentState(enabled, lockedId) {
    try {
      chrome.storage.local.set({ 
        'set-parent-enabled': enabled,
        'locked-parent-id': lockedId
      });
    } catch (e) {
      console.warn('[BooruEagle Panel] Could not save set-parent state:', e);
    }
  }

  /**
   * Load saved post-save state from chrome.storage
   * This ensures the state persists across page reloads and navigation
   * @private
   */
  async _loadPostSaveState() {
    try {
      const result = await chrome.storage.local.get('post-save-enabled');
      if (result['post-save-enabled'] !== undefined) {
        this.state.postSaveEnabled = result['post-save-enabled'];
        
        // Apply to UI after panel is created
        setTimeout(() => {
          this.updateToggleButton('#panel-post-save-btn', this.state.postSaveEnabled);
        }, 200);
      }
    } catch (e) {
      console.warn('[BooruEagle Panel] Could not load post-save state:', e);
    }
  }

  /**
   * Save post-save state to chrome.storage for persistence
   * @param {boolean} enabled
   * @private
   */
  _savePostSaveState(enabled) {
    try {
      chrome.storage.local.set({ 'post-save-enabled': enabled });
    } catch (e) {
      console.warn('[BooruEagle Panel] Could not save post-save state:', e);
    }
  }
}

// Export for use in main.js
window.BooruEaglePanel = BooruEaglePanel;
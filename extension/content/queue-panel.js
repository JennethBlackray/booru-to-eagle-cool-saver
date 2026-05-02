/**
 * @fileoverview Queue Panel — Visual queue display for multi-save operations
 *
 * Appears when queue has >1 tasks. Shows tiles for each queued post,
 * with status indicators (downloading, saving, waiting, completed, failed).
 * Collapses extra tasks beyond 5 into a "+N more" tile.
 * Synced across all tabs via chrome.storage.local.
 *
 * @module queue-panel
 */

class BooruEagleQueuePanel {
  constructor() {
    /** @type {HTMLElement|null} Root DOM element */
    this.panel = null;

    /** @type {HTMLElement|null} Container for task tiles */
    this.listEl = null;

    /** @type {HTMLElement|null} Close button */
    this.closeBtn = null;

    /** @type {HTMLElement|null} Title area */
    this.titleEl = null;

    /** @type {HTMLElement|null} Count badge */
    this.countEl = null;

    /** @type {Array} Last known queue state from storage */
    this._lastQueueState = null;

    /** @type {boolean} Whether user has manually hidden the panel */
    this._hiddenByUser = false;

    /** @type {boolean} Whether storage listener is registered */
    this._listenerRegistered = false;

    /** @type {number} Debounce timer ID */
    this._renderTimer = null;

    // Max tiles to display before collapsing
    this.MAX_TILES = 5;

    this.init();
  }

  /**
   * Initialize the queue panel: create DOM, inject CSS, start listening.
   */
  init() {
    this._injectCSS();
    this._createDOM();
    this._initStorageSync();
    this._loadInitialState();

    console.log('[BooruEagle QueuePanel] Initialized');
  }

  /**
   * Inject queue-panel.css into the page.
   * @private
   */
  _injectCSS() {
    if (document.getElementById('booru-eagle-queue-panel-styles')) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.id = 'booru-eagle-queue-panel-styles';
    link.href = chrome.runtime.getURL('content/queue-panel.css');
    (document.head || document.documentElement).appendChild(link);
  }

  /**
   * Create the panel DOM elements.
   * @private
   */
  _createDOM() {
    this.panel = document.createElement('div');
    this.panel.className = 'booru-eagle-queue-panel';
    this.panel.id = 'booru-eagle-queue-panel';

    this.panel.innerHTML = `
      <div class="booru-eagle-queue-header">
        <div class="booru-eagle-queue-title">
          <span class="queue-icon">&#x1F4E5;</span>
          <span>Queue</span>
          <span class="booru-eagle-queue-count" id="booru-eagle-queue-count">0</span>
        </div>
        <button class="booru-eagle-queue-close" id="booru-eagle-queue-close" title="Hide queue panel">&#x2715;</button>
      </div>
      <div class="booru-eagle-queue-list" id="booru-eagle-queue-list"></div>
    `;

    this.listEl = this.panel.querySelector('#booru-eagle-queue-list');
    this.countEl = this.panel.querySelector('#booru-eagle-queue-count');
    this.closeBtn = this.panel.querySelector('#booru-eagle-queue-close');

    this.closeBtn.addEventListener('click', () => {
      this._hiddenByUser = true;
      this.panel.classList.add('hidden-by-user');
      chrome.storage.local.set({ 'queue-panel-hidden': true }).catch(() => {});
    });

    document.body.appendChild(this.panel);
  }

  /**
   * Load initial hidden state from storage.
   * @private
   */
  async _loadInitialState() {
    try {
      const result = await chrome.storage.local.get('queue-panel-hidden');
      if (result['queue-panel-hidden']) {
        this._hiddenByUser = true;
      }
    } catch (e) {
      // Ignore
    }
  }

  /**
   * Listen for queue-state changes in chrome.storage.local.
   * Debounced to avoid excessive re-renders.
   * @private
   */
  _initStorageSync() {
    if (this._listenerRegistered) return;

    // Store handler reference so we can remove it later
    this._storageHandler = (changes, areaName) => {
      if (areaName !== 'local') return;

      // Handle hidden state
      if (changes['queue-panel-hidden']) {
        this._hiddenByUser = !!changes['queue-panel-hidden'].newValue;
        if (this._hiddenByUser) {
          this.panel.classList.add('hidden-by-user');
        } else {
          this.panel.classList.remove('hidden-by-user');
        }
        return;
      }

      // Handle queue state changes
      if (!changes['queue-state']) return;

      const newState = changes['queue-state']?.newValue;
      if (!newState) {
        // Queue cleared or state removed
        this._renderQueue({ tasks: [], total: 0, processing: false });
        return;
      }

      // Debounce rapid updates
      if (this._renderTimer) clearTimeout(this._renderTimer);
      this._renderTimer = setTimeout(() => {
        this._renderQueue(newState);
      }, 100);
    };

    chrome.storage.onChanged.addListener(this._storageHandler);
    this._listenerRegistered = true;
  }

  /**
   * Render the queue panel based on state from storage.
   * Shows/hides panel based on task count and user preference.
   * @param {Object} state - Queue state
   * @param {Array} state.tasks - Array of task objects
   * @param {number} state.total - Total task count
   * @param {boolean} state.processing - Whether queue is actively processing
   * @private
   */
  _renderQueue(state) {
    const { tasks = [], total = 0, processing = false } = state;

    // Update counter
    if (this.countEl) {
      this.countEl.textContent = String(total);
    }

    // Show/hide panel based on queue size
    if (total <= 1 && !this._hiddenByUser) {
      // Not enough tasks to show — hide panel
      this.panel.classList.remove('visible');
      return;
    }

    if (this._hiddenByUser && total <= 1) {
      // User hid it and queue is small — stay hidden
      this.panel.classList.remove('visible');
      return;
    }

    // Show panel (unless user hid it)
    if (!this._hiddenByUser) {
      this.panel.classList.add('visible');
    }

    // Build tiles
    if (this.listEl) {
      this._buildTiles(tasks, total);
    }
  }

  /**
   * Build tile elements based on task list.
   * @param {Array} tasks - Full task list from queue state
   * @param {number} total - Actual total (may be more than tasks.length if collapsed)
   * @private
   */
  _buildTiles(tasks, total) {
    // Clear existing
    this.listEl.innerHTML = '';

    const displayCount = Math.min(tasks.length, this.MAX_TILES);
    const remaining = total - this.MAX_TILES;

    for (let i = 0; i < displayCount; i++) {
      const task = tasks[i];
      const tile = this._createTile(task, i);
      this.listEl.appendChild(tile);
    }

    // Collapsed tile if there are more tasks
    if (remaining > 0) {
      const collapsedTile = document.createElement('div');
      collapsedTile.className = 'booru-eagle-queue-tile booru-eagle-queue-tile--collapsed';
      collapsedTile.innerHTML = `<span class="booru-eagle-queue-tile__post-id">+${remaining} more</span>`;
      this.listEl.appendChild(collapsedTile);
    }
  }

  /**
   * Create a single tile element for a task.
   * @param {Object} task - Task object from queue state
   * @param {number} index - Position in queue (0-based)
   * @returns {HTMLElement}
   * @private
   */
  _createTile(task, index) {
    const tile = document.createElement('div');
    const stateClass = this._getStateClass(task.state);
    tile.className = `booru-eagle-queue-tile ${stateClass}`;

    const postId = task.postId || this._extractPostId(task.taskId);
    const statusText = this._getStatusText(task.state, task.progress);

    // Only show progress bar when actively downloading
    let progressHTML = '';
    if (task.state === 'downloading' && task.progress != null && task.progress > 0 && task.progress < 100) {
      progressHTML = `<div class="booru-eagle-queue-tile__progress"><div class="booru-eagle-queue-tile__progress-fill" style="width:${task.progress}%"></div></div>`;
    }

    tile.innerHTML = `
      <span class="booru-eagle-queue-tile__dot"></span>
      <span class="booru-eagle-queue-tile__post-id" title="Post #${postId}">#${postId}</span>
      <span class="booru-eagle-queue-tile__status">${statusText}</span>
      ${progressHTML}
    `;

    return tile;
  }

  /**
   * Map task state to CSS class.
   * @param {string} state
   * @returns {string}
   * @private
   */
  _getStateClass(state) {
    switch (state) {
      case 'downloading':
        return 'booru-eagle-queue-tile--downloading';
      case 'download_complete':
      case 'saving':
        return 'booru-eagle-queue-tile--saving';
      case 'completed':
        return 'booru-eagle-queue-tile--completed';
      case 'failed':
        return 'booru-eagle-queue-tile--failed';
      default:
        return 'booru-eagle-queue-tile--waiting';
    }
  }

  /**
   * Get human-readable status text for a task.
   * @param {string} state
   * @param {number|null} progress
   * @returns {string}
   * @private
   */
  _getStatusText(state, progress) {
    switch (state) {
      case 'pending_parse':
        return 'Parsing…';
      case 'pending_download':
        return 'Waiting';
      case 'downloading':
        if (progress != null && progress > 0) return `${progress}%`;
        return 'Downloading';
      case 'download_complete':
        return 'Saving…';
      case 'failed':
        return 'Failed';
      default:
        return 'Waiting';
    }
  }

  /**
   * Extract post ID from task ID string.
   * Task ID format: "hidden-{postId}-{timestamp}-{random}" or "task-{timestamp}-{random}"
   * @param {string} taskId
   * @returns {string|null}
   * @private
   */
  _extractPostId(taskId) {
    if (!taskId) return null;

    // Hidden tab tasks: "hidden-{postId}-..."
    if (taskId.startsWith('hidden-')) {
      const parts = taskId.split('-');
      return parts[1] || null;
    }

    return null;
  }

  /**
   * Remove the panel from DOM and clean up listeners.
   */
  close() {
    // Remove storage listener
    if (this._listenerRegistered && this._storageHandler) {
      chrome.storage.onChanged.removeListener(this._storageHandler);
      this._listenerRegistered = false;
      this._storageHandler = null;
    }

    // Clear pending render timer
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }

    // Remove DOM element
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }

    console.log('[BooruEagle QueuePanel] Closed');
  }
}

// Export for use in main.js
window.BooruEagleQueuePanel = BooruEagleQueuePanel;

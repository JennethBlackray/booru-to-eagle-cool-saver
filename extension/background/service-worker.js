/**
 * Booru to Eagle Saver - Background Service Worker
 * 
 * Architecture:
 * - Order is captured IMMEDIATELY at click time
 * - Downloads run in parallel (one per task)
 * - Saves run sequentially in FIFO order (order captured at click)
 * - Keep-alive alarm prevents Chrome from killing the worker during long downloads
 */

const EAGLE_API_URL = 'http://localhost:41595';
const DOWNLOAD_TIMEOUT_MS = 360000; // 6 minutes
const DOWNLOAD_WAIT_TIMEOUT_MS = 300000; // 5 minutes
const SAVE_DELAY_MS = 300;

// ==================== RULE34 CONFIGURATION ====================

// Inline configuration for rule34 handling
// (config.js is not available in background context)
const RULE34_CONFIG_BG = {
  MIN_REQUEST_INTERVAL: 800,
  RETRY_DELAY_429: 3000,
  RETRY_DELAY_CAPTCHA: 5000,
  MAX_RETRIES: 5
};

// ==================== RATE LIMITER & BLOCKER DETECTION ====================

/**
 * Rate limiter for rule34.xxx requests
 * Tracks last request time per domain to avoid 429 rate limiting
 */
class RateLimiter {
  constructor() {
    /** @type {Map<string, number>} Domain -> last request timestamp */
    this.lastRequestTime = new Map();
    /** @type {Map<string, number>} Domain -> current delay multiplier */
    this.delayMultiplier = new Map();
  }

  /**
   * Wait if needed to respect rate limits for a domain
   * @param {string} hostname - The domain to rate limit
   * @param {number} [minInterval=RULE34_CONFIG_BG.MIN_REQUEST_INTERVAL] - Minimum interval in ms
   * @returns {Promise<void>}
   */
  async waitIfNeeded(hostname, minInterval = RULE34_CONFIG_BG.MIN_REQUEST_INTERVAL) {
    const lastTime = this.lastRequestTime.get(hostname) || 0;
    const elapsed = Date.now() - lastTime;
    
    if (elapsed < minInterval) {
      const waitTime = minInterval - elapsed;
      console.log(`[RateLimiter] Waiting ${waitTime}ms before next request to ${hostname}`);
      await delay(waitTime);
    }
    
    this.lastRequestTime.set(hostname, Date.now());
  }

  /**
   * On 429, increase delay multiplier
   * @param {string} hostname
   */
  onRateLimited(hostname) {
    const current = this.delayMultiplier.get(hostname) || 1;
    const next = Math.min(current * 2, 8); // Max 8x multiplier
    this.delayMultiplier.set(hostname, next);
    // Also set lastRequestTime further in the past to enforce longer wait
    this.lastRequestTime.set(hostname, Date.now() - RULE34_CONFIG_BG.MIN_REQUEST_INTERVAL + (RULE34_CONFIG_BG.RETRY_DELAY_429 * current));
    console.log(`[RateLimiter] Rate limited on ${hostname}, multiplier: ${next}x`);
  }

  /**
   * On CAPTCHA, increase delay multiplier
   * @param {string} hostname
   */
  onCaptchaDetected(hostname) {
    const current = this.delayMultiplier.get(hostname) || 1;
    const next = Math.min(current * 2, 8);
    this.delayMultiplier.set(hostname, next);
    this.lastRequestTime.set(hostname, Date.now() - RULE34_CONFIG_BG.MIN_REQUEST_INTERVAL + (RULE34_CONFIG_BG.RETRY_DELAY_CAPTCHA * current));
    console.log(`[RateLimiter] CAPTCHA on ${hostname}, multiplier: ${next}x`);
  }

  /**
   * On success, gradually decrease multiplier
   * @param {string} hostname
   */
  onSuccess(hostname) {
    const current = this.delayMultiplier.get(hostname) || 1;
    if (current > 1) {
      const next = Math.max(current / 2, 1);
      this.delayMultiplier.set(hostname, next);
    }
  }

  /**
   * Reset multiplier for a domain
   * @param {string} hostname
   */
  reset(hostname) {
    this.delayMultiplier.delete(hostname);
    this.lastRequestTime.delete(hostname);
  }
}

/** Global rate limiter instance */
const rateLimiter = new RateLimiter();

// ==================== HOTKEYS ====================

const DEFAULT_HOTKEYS = {
  'hotkey-save': 'Alt+Z',
  'hotkey-parent': 'Alt+X',
  'hotkey-stop': 'Alt+C',
  'hotkey-postsave': 'Alt+A'
};

let currentHotkeys = { ...DEFAULT_HOTKEYS };

async function loadHotkeys() {
  try {
    const stored = await chrome.storage.local.get('hotkeys');
    if (stored.hotkeys) {
      currentHotkeys = stored.hotkeys;
      console.log('[Hotkeys] Loaded from storage:', currentHotkeys);
    }
  } catch (e) {
    console.warn('[Hotkeys] Could not load hotkeys:', e);
  }
}

// ==================== DOWNLOAD & SAVE QUEUE ====================

/**
 * Queue architecture:
 * 1. enqueue() - adds task to array IMMEDIATELY (order captured)
 * 2. Download starts in parallel for each task
 * 3. _processSaveQueue() waits for task[0] download, saves to Eagle, shifts, repeats
 * 
 * Task states:
 * - 'pending_parse' - Waiting for hidden tab to parse (thumbnail saves)
 * - 'pending_download' - Ready to download
 * - 'downloading' - Download in progress
 * - 'download_complete' - Ready to save
 * - 'saving' - Saving to Eagle
 * - 'completed' - Done
 * - 'failed' - Error occurred
 */
class DownloadSaveQueue {
  constructor() {
    this.tasks = [];
    this.processing = false;
    this.abortControllers = new Map();
  }

  /**
   * Add task to queue IMMEDIATELY (captures order)
   * For thumbnail saves, task starts in 'pending_parse' state
   * For post-page saves, task starts in 'pending_download' state
   */
  enqueue(taskId, tabId, url, referer, saveData, options = {}) {
    const { state = 'pending_download', base64 = null, useUrlDirect = false } = options;

    const task = {
      taskId,
      tabId,
      url,
      referer,
      saveData,
      base64,
      downloadComplete: false,
      downloadStarted: false,  // Always start as false; _startDownloadParallel sets it
      downloadError: null,
      state: state,  // Track task state explicitly
      useUrlDirect: useUrlDirect || saveData?.useUrlDirect || false
    };

    this.tasks.push(task);
    const position = this.tasks.length;

    console.log(`[Queue] Enqueued ${taskId} (position: ${position}, state: ${state}, total: ${this.tasks.length})`);

    // For useUrlDirect or already-having-base64 tasks, mark download as complete immediately
    if (task.useUrlDirect) {
      task.downloadComplete = true;
      task.downloadStarted = true;
      task.state = 'download_complete';
      console.log(`[Queue] ${taskId} uses URL direct, marking download complete`);
    } else if (base64) {
      task.downloadComplete = true;
      task.downloadStarted = true;
      task.state = 'download_complete';
      console.log(`[Queue] ${taskId} already has base64, marking download complete`);
    }

    // Start download immediately for tasks that have URL (parallel)
    if (state !== 'pending_parse') {
      this._startDownloadParallel(task);
    }

    // Start save processing (sequential - waits for downloads)
    this._ensureProcessing();

    // Keep service worker alive
    this._startKeepAlive();

    // Report queue state to content scripts
    reportQueueState();

    return { queued: true, position };
  }

  /**
   * Update a pending_parse task with parsed data from hidden tab
   * Called when hidden tab finishes parsing
   */
  updateParsedData(taskId, parsedData, base64 = null) {
    const task = this.tasks.find(t => t.taskId === taskId);
    if (!task) {
      console.warn(`[Queue] Task ${taskId} not found for update`);
      return false;
    }

    if (task.state !== 'pending_parse') {
      console.warn(`[Queue] Task ${taskId} is not in pending_parse state (current: ${task.state})`);
      return false;
    }

    // Update task with parsed data
    if (parsedData.imageUrl) {
      task.url = parsedData.imageUrl;
    }
    if (parsedData.tags) {
      // Merge: keep existing tags (e.g., parent:xxx) and add parsed tags
      const existingTags = task.saveData.tags || [];
      // Filter out any tags that were already in parsedData (avoid duplicates)
      const parsedSet = new Set(parsedData.tags);
      const uniqueExisting = existingTags.filter(t => !parsedSet.has(t));
      task.saveData.tags = [...uniqueExisting, ...parsedData.tags];
    }
    if (parsedData.annotation) {
      task.saveData.annotation = parsedData.annotation;
    }
    if (base64) {
      task.base64 = base64;
    }

    // Mark as ready for download
    task.state = 'pending_download';
    
    // Determine if download is already complete
    // - useUrlDirect: no download needed, Eagle will fetch URL
    // - base64 present: data already available, no download needed
    if (task.useUrlDirect) {
      task.downloadComplete = true;
      task.downloadStarted = true;
      task.state = 'download_complete';
    } else if (base64 !== null) {
      task.downloadComplete = true;
      task.downloadStarted = true;
      task.state = 'download_complete';
    } else {
      // Needs actual download
      task.downloadComplete = false;
      task.downloadStarted = false;
    }

    console.log(`[Queue] Task ${taskId} updated with parsed data, state: ${task.state}, downloadComplete: ${task.downloadComplete}, useUrlDirect: ${task.useUrlDirect}, hasBase64: ${!!base64}, tags: ${JSON.stringify(task.saveData.tags?.slice(0, 10))}`);

    // Start download if we have URL and not using URL direct and no base64
    if (task.url && !task.useUrlDirect && !task.downloadComplete) {
      this._startDownloadParallel(task);
    }

    // Report queue state after update
    reportQueueState();

    return true;
  }

  /**
   * Mark task as failed (e.g., hidden tab parse failed)
   */
  markTaskFailed(taskId, error) {
    const task = this.tasks.find(t => t.taskId === taskId);
    if (!task) return false;

    task.state = 'failed';
    task.downloadError = error;
    task.downloadComplete = true;

    console.log(`[Queue] Task ${taskId} marked as failed: ${error}`);
    reportQueueState();
    return true;
  }

  /**
   * Ensure processing loop is running
   */
  _ensureProcessing() {
    if (!this.processing) {
      this.processing = true;
      this._processSaveQueue();
    }
  }

  /**
   * Start downloading a task in parallel
   * For tasks with useUrlDirect flag (gelbooru), skip download and mark as complete
   */
  async _startDownloadParallel(task) {
    console.log(`[Queue] _startDownloadParallel called for ${task.taskId}, url=${!!task.url}, useUrlDirect=${task.useUrlDirect}, hasBase64=${!!task.base64}`);
    
    if (task.downloadStarted) {
      console.log(`[Queue] ${task.taskId} download already started, skipping`);
      return;
    }
    task.downloadStarted = true;
    task.state = 'downloading';

    // For gelbooru: skip download, URL will be sent directly to Eagle during save phase
    if (task.useUrlDirect) {
      task.downloadComplete = true;
      task.state = 'download_complete';
      console.log(`[Queue] ${task.taskId} uses URL direct (gelbooru), skipping download`);
      return;
    }

    // Check if we already have base64 data (e.g., from canvas extraction)
    if (task.base64) {
      task.downloadComplete = true;
      task.state = 'download_complete';
      console.log(`[Queue] ${task.taskId} already has base64 data, skipping download`);
      return;
    }

    // Check if we have a URL to download
    if (!task.url) {
      console.warn(`[Queue] ${task.taskId} has no URL, cannot download`);
      return;
    }

    console.log(`[Queue] ${task.taskId} starting download from ${task.url.substring(0, 80)}...`);

    const abortController = new AbortController();
    this.abortControllers.set(task.taskId, abortController);

    try {
      const result = await downloadImageAsBase64({
        url: task.url,
        referer: task.referer,
        tabId: task.tabId,
        taskId: task.taskId,
        signal: abortController.signal,
        isTopQueue: () => this.tasks[0]?.taskId === task.taskId
      });

      if (result.success) {
        task.base64 = result.base64;
        task.downloadComplete = true;
        task.state = 'download_complete';
        console.log(`[Queue] Downloaded ${task.taskId} (${result.base64.length} bytes)`);
      } else {
        task.downloadError = result.error;
        task.downloadComplete = true;
        task.state = 'failed';
        console.error(`[Queue] Download failed ${task.taskId}: ${result.error}`);
      }
    } catch (error) {
      task.downloadError = error.name === 'AbortError' ? 'Cancelled' : error.message;
      task.downloadComplete = true;
      task.state = 'failed';
      console.error(`[Queue] Download exception ${task.taskId}:`, error);
    } finally {
      this.abortControllers.delete(task.taskId);
    }
  }

  /**
   * Update progress display for top-of-queue task
   */
  _updateTopQueueProgress() {
    if (this.tasks.length === 0) {
      reportDownloadProgress(0, null, null, null);
      return;
    }

    const topTask = this.tasks[0];

    if (topTask.state === 'pending_parse') {
      reportDownloadProgress(0, 'Preparing...', topTask.taskId, 1);
    } else if (topTask.downloadComplete) {
      if (this.tasks.length > 1) {
        const nextTask = this.tasks[1];
        reportDownloadProgress(0, 'Saving...', nextTask.taskId, 1);
      } else {
        reportDownloadProgress(0, null, null, null);
      }
    } else if (!topTask.downloadStarted) {
      reportDownloadProgress(0, 'Preparing...', topTask.taskId, 1);
    } else {
      reportDownloadProgress(0, 'Saving...', topTask.taskId, 1);
    }
  }

  /**
   * Process save queue sequentially in FIFO order
   */
  async _processSaveQueue() {
    console.log(`[Queue] _processSaveQueue started, ${this.tasks.length} tasks`);

    // Track how long we've been waiting for pending_parse tasks
    const pendingParseStartTime = new Map();

    while (this.tasks.length > 0) {
      const task = this.tasks[0];

      // Skip tasks that are still waiting for hidden tab to parse
      if (task.state === 'pending_parse') {
        // Track how long we've been waiting
        if (!pendingParseStartTime.has(task.taskId)) {
          pendingParseStartTime.set(task.taskId, Date.now());
        }

        const waitTime = Date.now() - pendingParseStartTime.get(task.taskId);
        if (waitTime > 120000) { // 120 second timeout for parsing (rule34 may need retries)
          task.state = 'failed';
          task.downloadError = 'Parse timeout (30s)';
          task.downloadComplete = true;
          console.warn(`[Queue] Task ${task.taskId} timed out waiting for parse`);
          continue;
        }

        // Wait a bit and check again (don't block the queue, just poll)
        await delay(200);
        continue;
      }

      // Clear parse tracking when we move past this task
      pendingParseStartTime.delete(task.taskId);

      // Skip failed tasks
      if (task.state === 'failed') {
        this._sendResult(task, false, task.downloadError || 'Parse failed');
        this.tasks.shift();
        this._updateTopQueueProgress();
        reportQueueState();
        continue;
      }

      // Wait for download to complete (with timeout)
      if (!task.downloadComplete) {
        const completed = await this._waitForDownloadWithProgress(task);
        if (!completed) {
          task.downloadError = 'Download timeout (5 min)';
          task.downloadComplete = true;
        }
      }

      // Handle download failure
      if (task.downloadError) {
        this._sendResult(task, false, `Download failed: ${task.downloadError}`);
        this.tasks.shift();
        this._updateTopQueueProgress();
        reportQueueState();
        continue;
      }

      // Send to Eagle (90-99%)
      reportDownloadProgress(90, 'Saving to Eagle...', task.taskId, 1);
      
      let result;
      if (task.useUrlDirect) {
        // Gelbooru: send URL directly to Eagle (no CORS issues for desktop app)
        console.log(`[Queue] ${task.taskId} saving via URL direct`);
        result = await saveToEagleURL({ ...task.saveData, url: task.url });
      } else {
        // Standard: save base64
        result = await saveToEagleBase64({ ...task.saveData, base64: task.base64 });
      }
      
      // Report 100% on success
      if (result.success) {
        reportDownloadProgress(100, 'Saved!', task.taskId, 1);
      }
      
      this._sendResult(task, result.success, result.error, result.data);

      // Free memory before removing task from queue
      task.base64 = null;

      this.tasks.shift();
      console.log(`[Queue] Completed ${task.taskId}, ${this.tasks.length} remaining`);

      // Update progress for the next task in queue
      this._updateTopQueueProgress();

      // Report queue state after task removal
      reportQueueState();

      // Delay between saves
      await delay(SAVE_DELAY_MS);
    }

    // Double check for any tasks that might have been added while processing the last one
    if (this.tasks.length > 0) {
      return this._processSaveQueue();
    }

    this.processing = false;
    this._stopKeepAlive();
    console.log('[Queue] Empty');

    // Clean up queue-state from storage when done
    chrome.storage.local.remove('queue-state').catch(() => {});
  }

  /**
   * Wait for download to complete
   */
  async _waitForDownloadWithProgress(task) {
    const startTime = Date.now();
    const updateInterval = 2000;

    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (task.downloadComplete) {
          clearInterval(check);
          resolve(true);
          return;
        }

        const elapsed = Date.now() - startTime;
        if (elapsed >= DOWNLOAD_WAIT_TIMEOUT_MS) {
          clearInterval(check);
          resolve(false);
          return;
        }
      }, updateInterval);
    });
  }

  /**
   * Send result to content script
   * Includes postSaveEnabled so each tab knows if IT should close
   */
  async _sendResult(task, success, error = null, data = null) {
    // Prefer sourceTabId for thumbnail saves (always valid)
    // Fall back to task.tabId for post-page saves
    let targetTabId = task.saveData?.sourceTabId || task.tabId;

    // Don't try to send if no valid tab ID
    if (!targetTabId) {
      console.warn(`[Queue] No target tab for task ${task.taskId}`);
      return;
    }

    try {
      await chrome.tabs.sendMessage(targetTabId, {
        action: 'saveResult',
        taskId: task.taskId,
        success,
        error,
        data,
        postSaveEnabled: task.saveData?.postSaveEnabled || false
      });
    } catch {
      // Tab may be closed
    }
  }

  /**
   * Clear all tasks and abort downloads
   */
  async clear() {
    console.log(`[Queue] Clearing ${this.tasks.length} tasks`);

    for (const [, controller] of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();

    for (const task of this.tasks) {
      // For pending_parse tasks, mark as failed so they get a result
      if (task.state === 'pending_parse') {
        task.state = 'failed';
        task.downloadError = 'Cancelled by user';
        task.downloadComplete = true;
      }
      this._sendResult(task, false, 'Cancelled by user');
    }

    this.tasks = [];
    this.processing = false;
    reportDownloadProgress(0, null);
    reportQueueState();
    // Clear queue-state from storage when queue is fully empty
    chrome.storage.local.remove('queue-state').catch(() => {});
    this._stopKeepAlive();
  }

  _startKeepAlive() {
    chrome.alarms.create('booru-eagle-keepalive', { periodInMinutes: 0.5 });
  }

  _stopKeepAlive() {
    if (this.tasks.length === 0 && !this.processing) {
      chrome.alarms.clear('booru-eagle-keepalive');
    }
  }
}

// ==================== UTILITIES ====================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reportDownloadProgress(progress, text, taskId = null, queuePosition = null) {
  const data = {
    progress: Math.min(100, Math.max(0, progress)),
    text: text || null,
    taskId: taskId || null,
    queuePosition: queuePosition || null,
    timestamp: Date.now()
  };
  chrome.storage.local.set({ 'save-progress': data }).catch(() => {});
}

/**
 * Report full queue state to content scripts via chrome.storage.local.
 * Called whenever the queue changes (enqueue, shift, state change, clear).
 */
function reportQueueState() {
  const tasks = queue.tasks.map(t => ({
    taskId: t.taskId,
    postId: t.saveData?.postId || extractPostIdFromTaskId(t.taskId),
    state: t.state,
    progress: t.downloadComplete ? 100 : (t.useUrlDirect ? 100 : 0),
    error: t.downloadError || null
  }));

  const data = {
    tasks,
    total: queue.tasks.length,
    processing: queue.processing,
    timestamp: Date.now()
  };

  chrome.storage.local.set({ 'queue-state': data }).catch(() => {});
}

/**
 * Extract post ID from a task ID string.
 * @param {string} taskId
 * @returns {string|null}
 */
function extractPostIdFromTaskId(taskId) {
  if (!taskId) return null;
  // Hidden tab tasks: "hidden-{postId}-{timestamp}-{random}"
  if (taskId.startsWith('hidden-')) {
    const parts = taskId.split('-');
    return parts[1] || null;
  }
  return null;
}

// ==================== DOWNLOAD FUNCTIONS ====================

async function downloadImageAsBase64({ url, referer, tabId, taskId, signal, isTopQueue }) {
  if (!url) return { success: false, error: 'URL is required' };

  const log = (msg) => console.log(`[Download ${taskId || '?'}] ${msg}`);
  log(`Starting: ${url}`);

  let cookieHeader = '';
  if (tabId) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      if (cookies.length > 0) {
        cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    } catch (e) {
      console.warn('[Download] Could not get cookies:', e);
    }
  }

  const headers = {};
  if (referer) headers['Referer'] = referer;
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) return { success: false, error: 'Aborted' };

    try {
      if (attempt > 1) await delay(1000);

      let fetchUrl = url;
      if (attempt === 1) {
        try {
          const urlObj = new URL(url);
          urlObj.searchParams.set('_cb', Date.now().toString());
          fetchUrl = urlObj.toString();
        } catch {}
      }

      const response = await fetch(fetchUrl, {
        method: 'GET',
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        signal: signal || AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        cache: 'no-store'
      });

      if (!response.ok) {
        if (response.status === 403 && attempt === 1) {
          lastError = new Error('HTTP 403');
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      log(`Content-Length: ${contentLength} bytes`);

      const chunks = [];
      let receivedLength = 0;
      const reader = response.body.getReader();

      try {
        while (true) {
          if (signal?.aborted) {
            reader.cancel();
            return { success: false, error: 'Aborted' };
          }

          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          receivedLength += value.length;

          if (contentLength > 0 && taskId && (!isTopQueue || isTopQueue())) {
            const downloadPercent = Math.round((receivedLength / contentLength) * 89);
            reportDownloadProgress(downloadPercent, 'Saving...', taskId);
          }
        }
      } catch (readError) {
        if (readError.name === 'AbortError' || signal?.aborted) {
          return { success: false, error: 'Aborted' };
        }
        throw readError;
      }

      const blob = new Blob(chunks);
      const mimeType = response.headers.get('content-type') || 'image/jpeg';
      log(`Downloaded ${blob.size} bytes, type: ${mimeType}`);

      // Free chunk memory immediately after Blob creation
      chunks.length = 0;

      if (mimeType && mimeType.includes('text/html')) {
        log('ERROR: Received HTML instead of image');
        return { success: false, error: 'Received HTML instead of image' };
      }

      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ success: true, base64: reader.result, mimeType });
        reader.onerror = () => resolve({ success: false, error: 'Failed to convert to base64' });
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) {
        return { success: false, error: 'Aborted' };
      }
      lastError = error;
      if (error.message.includes('403') && attempt === 1) continue;
      break;
    }
  }

  return { success: false, error: lastError?.message || 'Download failed' };
}

/**
 * Save to Eagle using URL directly - Eagle downloads the image itself
 * Eagle is a desktop app, no CORS restrictions
 */
async function saveToEagleURL(data) {
  const { url, tags = [], name, website, annotation, referer, site, postId } = data;

  if (!url) return { success: false, error: 'URL is required' };

  const payload = {
    url: url,
    name: name || (postId ? `post_${postId}` : undefined),
    tags,
    website: website || referer || '',
    annotation: annotation || undefined
  };

  Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });

  console.log(`[Eagle] Saving URL: ${url}`);

  const response = await fetch(`${EAGLE_API_URL}/api/item/addFromURL`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  console.log('[Eagle] URL save successful');
  return { success: true, data: result };
}

async function saveToEagleBase64(data) {
  const { base64, tags = [], name, website, annotation, referer, site, postId } = data;

  if (!base64) return { success: false, error: 'Base64 data is required' };

  const payload = {
    url: base64,
    name: name || (postId ? `post_${postId}` : undefined),
    tags,
    website: website || referer || '',
    annotation: annotation || undefined
  };

  Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });

  console.log(`[Eagle] Saving ${base64.length} bytes...`);

  const response = await fetch(`${EAGLE_API_URL}/api/item/addFromURL`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  console.log('[Eagle] Save successful');
  return { success: true, data: result };
}

async function checkEagle() {
  try {
    const response = await fetch(`${EAGLE_API_URL}/api/item/list`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    return { connected: response.ok };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

async function handlePostSaveAction(tabId) {
  if (!tabId) return { success: false, error: 'No tab ID' };

  try {
    await chrome.tabs.get(tabId);
    try {
      await chrome.tabs.goBack(tabId);
      return { success: true, action: 'went_back' };
    } catch {
      await chrome.tabs.remove(tabId);
      return { success: true, action: 'closed' };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ==================== HIDDEN TAB SAVE ====================

/**
 * Build post page URL using site configuration
 * To add a new site, add entry to content/site-configs.js
 */
function buildPostPageUrl(hostname, postId) {
  // Site URL builders - must match site-configs.js keys
  const siteUrlBuilders = {
    'chan.sankakucomplex.com': (h, id) => `https://${h}/en/posts/${id}`,
    'danbooru.donmai.us': (h, id) => `https://${h}/posts/${id}`,
    'gelbooru.com': (h, id) => `https://${h}/index.php?page=post&s=view&id=${id}`,
    'konachan.com': (h, id) => `https://${h}/post/show/${id}`,
    'rule34.xxx': (h, id) => `https://${h}/index.php?page=post&s=view&id=${id}`,
    'yande.re': (h, id) => `https://${h}/post/show/${id}`
  };
  
  for (const [key, builder] of Object.entries(siteUrlBuilders)) {
    if (hostname.includes(key)) {
      return builder(hostname, postId);
    }
  }
  
  throw new Error(`Unsupported site: ${hostname}`);
}

/**
 * Parse a post page in a hidden tab, download the image, and enqueue save to Eagle.
 *
 * NEW ARCHITECTURE (order preserved at click time):
 * 1. Task is added to queue IMMEDIATELY in 'pending_parse' state
 * 2. Hidden tab parses in background
 * 3. Queue updates task with parsed data when ready
 * 4. Queue processes in FIFO order
 */
async function handleHiddenTabParse(postId, hostname, sourceTabId, lockedParentId = null) {
  const log = (msg) => console.log(`[HiddenTab ${postId}] ${msg}`);
  log('Starting hidden tab parse...');

  // Generate task ID IMMEDIATELY (order captured at click time)
  const taskId = `hidden-${postId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Build post page URL first
  const postUrl = buildPostPageUrl(hostname, postId);

  // Build save data - add parent tag if lockedParentId is set
  const baseTags = [];
  if (lockedParentId) {
    baseTags.push(`parent:${lockedParentId}`);
    log(`Added parent tag: parent:${lockedParentId}`);
  }

  const saveData = {
    tags: baseTags,
    name: `post_${postId}`,
    website: postUrl,
    annotation: undefined,
    referer: postUrl,
    site: hostname,
    postId: postId,
    postSaveEnabled: false,
    sourceTabId: sourceTabId
  };

  // ENQUEUE IMMEDIATELY in 'pending_parse' state (order preserved!)
  const queueResult = queue.enqueue(
    taskId,
    null, // No hidden tab ID yet (will be set later)
    null, // No URL yet (will be filled by hidden tab)
    postUrl,
    saveData,
    { state: 'pending_parse' }
  );

  log(`Task enqueued IMMEDIATELY: position ${queueResult.position}`);

  // Now open hidden tab to parse (async, doesn't block queue order)
  _parseHiddenTabInBackground(taskId, postId, hostname, sourceTabId, lockedParentId).catch(error => {
    log(`Background parse failed: ${error.message}`);
    queue.markTaskFailed(taskId, error.message);
  });

  // Return immediately - task is already in queue!
  return { success: true, position: queueResult.position, taskId };
}

/**
 * Background task: open hidden tab, parse, update queue task with data.
 * Includes rate limiting and retry logic for rule34.xxx to handle 429/CAPTCHA.
 * This runs asynchronously and doesn't block the queue order.
 * Queue order is preserved because tasks are enqueued BEFORE this function runs.
 */
async function _parseHiddenTabInBackground(taskId, postId, hostname, sourceTabId, lockedParentId = null) {
  const log = (msg) => console.log(`[HiddenTab BG ${taskId}] ${msg}`);
  log('Starting background parse...');

  const postUrl = buildPostPageUrl(hostname, postId);
  const isRule34 = hostname.includes('rule34.xxx');
  
  let retryCount = 0;
  const maxRetries = isRule34 ? RULE34_CONFIG_BG.MAX_RETRIES : 1;
  
  while (retryCount <= maxRetries) {
    let hiddenTabId = null;
    
    try {
      // Apply rate limiting for rule34 (wait if too many requests)
      if (isRule34) {
        await rateLimiter.waitIfNeeded(hostname);
      }
      
      // Create hidden tab
      const hiddenTab = await chrome.tabs.create({
        url: postUrl,
        active: false,
        selected: false,
        pinned: false,
        openerTabId: sourceTabId
      });

      hiddenTabId = hiddenTab.id;
      log(`Hidden tab created: ${hiddenTabId} (attempt ${retryCount + 1}/${maxRetries + 1})`);

      // Wait for content script to initialize
      const contentReady = await waitForContentScript(hiddenTabId, 15000);
      if (!contentReady) {
        throw new Error('Content script did not initialize');
      }

      // Request parse - this also checks for blocked pages
      const parseResult = await chrome.tabs.sendMessage(hiddenTabId, {
        action: 'parseForMainPageSave',
        checkBlocker: isRule34  // Tell content script to check for 429/CAPTCHA
      });

      if (!parseResult) {
        throw new Error('No response from content script');
      }

      // Check for blocked page (429 or CAPTCHA)
      if (parseResult.blocked) {
        const blockerType = parseResult.blockerType; // 'rate_limit' or 'captcha'
        
        if (blockerType === 'rate_limit') {
          rateLimiter.onRateLimited(hostname);
          log(`Rate limited (429), retrying in ${RULE34_CONFIG_BG.RETRY_DELAY_429}ms...`);
        } else if (blockerType === 'captcha') {
          rateLimiter.onCaptchaDetected(hostname);
          log(`CAPTCHA detected, retrying in ${RULE34_CONFIG_BG.RETRY_DELAY_CAPTCHA}ms...`);
          
          // Notify the user that CAPTCHA needs solving
          try {
            chrome.tabs.sendMessage(sourceTabId, {
              action: 'captchaDetected',
              postUrl: postUrl,
              taskId: taskId
            }).catch(() => {});
          } catch (e) {}
        } else {
          log(`Unknown blocker type: ${blockerType}, retrying...`);
        }
        
        // Close the blocked hidden tab
        try { await chrome.tabs.remove(hiddenTabId); } catch (e) {}
        hiddenTabId = null;
        
        retryCount++;
        
        if (retryCount > maxRetries) {
          const errorMsg = blockerType === 'captcha' 
            ? 'CAPTCHA: Open the post page manually to solve CAPTCHA'
            : 'Rate limited: Exceeded maximum retries';
          log(errorMsg);
          
          // Notify user on source tab about the failure
          try {
            chrome.tabs.sendMessage(sourceTabId, {
              action: 'hiddenTabBlocked',
              taskId: taskId,
              postId: postId,
              postUrl: postUrl,
              blockerType: blockerType
            }).catch(() => {});
          } catch (e) {}
          
          queue.markTaskFailed(taskId, errorMsg);
          return;
        }
        
        // Exponential backoff delay before retry
        const delayMs = blockerType === 'captcha' 
          ? RULE34_CONFIG_BG.RETRY_DELAY_CAPTCHA
          : RULE34_CONFIG_BG.RETRY_DELAY_429;
        await delay(delayMs * Math.min(retryCount, 3)); // Scale delay with retry count
        continue;
      }

      // Parse succeeded - process result
      if (!parseResult.success) {
        throw new Error(parseResult?.error || 'Failed to parse post page');
      }

      log(`Parsed: ${parseResult.data.imageUrl}, ${parseResult.data.tags?.length || 0} tags`);

      // Report success to rate limiter (gradually reduce multiplier)
      if (isRule34) {
        rateLimiter.onSuccess(hostname);
      }

      // For gelbooru: decide whether to use URL direct or base64
      const task = queue.tasks.find(t => t.taskId === taskId);
      if (task && hostname.includes('gelbooru')) {
        if (parseResult.base64) {
          log('Gelbooru: using base64 from canvas extraction');
          task.useUrlDirect = false;
          task.saveData.useUrlDirect = false;
        } else if (parseResult.data.imageUrl) {
          log('Gelbooru: setting useUrlDirect flag');
          task.useUrlDirect = true;
          task.saveData.useUrlDirect = true;
        }
      }

      // Update the queue task with parsed data
      const updated = queue.updateParsedData(taskId, parseResult.data, parseResult.base64 || null);

      if (!updated) {
        throw new Error('Failed to update queue task with parsed data');
      }

      // Update task's tabId for download cookies/referer
      if (task) {
        task.tabId = hiddenTabId;
      }

      log('Task updated with parsed data, waiting for queue processing');

      // Wait for download to complete before closing tab
      while (task && !task.downloadComplete) {
        await delay(500);
      }

      log('Download complete, closing hidden tab');
      try { await chrome.tabs.remove(hiddenTabId); } catch (e) {}
      log('Hidden tab closed');
      return; // Success!

    } catch (error) {
      log(`Attempt ${retryCount + 1} error: ${error.message}`);
      
      // Close hidden tab on error
      if (hiddenTabId) {
        try { await chrome.tabs.remove(hiddenTabId); } catch (e) {}
      }
      
      if (isRule34 && retryCount < maxRetries) {
        // For rule34, retry on transient errors too
        rateLimiter.onRateLimited(hostname);
        retryCount++;
        await delay(RULE34_CONFIG_BG.RETRY_DELAY_429 * retryCount);
        continue;
      }
      
      // Non-rule34 or exhausted retries: mark as failed
      queue.markTaskFailed(taskId, error.message);
      return;
    }
  }
}

function waitForContentScript(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const check = async () => {
      try {
        const result = await chrome.tabs.sendMessage(tabId, {
          action: 'pingContentScript'
        });
        if (result?.pong) {
          resolve(true);
          return;
        }
      } catch (e) {
        // Content script not ready yet
      }
      
      if (Date.now() - startTime > timeout) {
        resolve(false);
        return;
      }
      
      setTimeout(check, 200);
    };
    
    check();
  });
}

// ==================== MESSAGE HANDLER ====================

const queue = new DownloadSaveQueue();

async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;

  switch (message.action) {
    case 'checkEagleConnection':
      return await checkEagle();

    case 'enqueueDownload': {
      if (!tabId) return { queued: false, error: 'No tab ID' };

      const taskId = message.data?.taskId || `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const { url, referer, saveData } = message.data || {};

      if (!url) return { queued: false, error: 'Image URL is required' };

      return queue.enqueue(taskId, tabId, url, referer, saveData);
    }

    case 'panelReady':
      return { ok: true };

    case 'clearQueue':
      await queue.clear();
      return { cleared: true };

    case 'closeCurrentTab':
      return await handlePostSaveAction(tabId);

    case 'saveFromMainPage': {
      const { postId, hostname, lockedParentId } = message;
      if (!postId || !hostname) {
        return { success: false, error: 'Post ID and hostname are required' };
      }
      
      try {
        return await handleHiddenTabParse(postId, hostname, tabId, lockedParentId);
      } catch (error) {
        console.error('[BG] Hidden tab parse failed:', error);
        return { success: false, error: error.message };
      }
    }

    case 'updateHotkeys': {
      currentHotkeys = message.hotkeys || { ...DEFAULT_HOTKEYS };
      console.log('[Hotkeys] Updated:', currentHotkeys);
      // Broadcast to all tabs so they update their local listeners
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'hotkeysUpdated',
            hotkeys: currentHotkeys
          }).catch(() => {});
        });
      });
      return { ok: true };
    }

    case 'settingsChanged': {
      // Broadcast settings to all open tabs
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'settingsChanged',
            settings: message.settings
          }).catch(() => {});
        });
      });
      return { ok: true };
    }

    case 'focusTab': {
      // Focus a tab (for CAPTCHA solver)
      if (sender.tab?.id) {
        chrome.tabs.update(sender.tab.id, { active: true });
        chrome.windows.update(sender.tab.windowId, { focused: true });
      }
      return { ok: true };
    }

    case 'captchaSolved': {
      // CAPTCHA was solved on one tab - refresh other blocked rule34 tabs
      const hostname = message.hostname;
      console.log(`[BG] CAPTCHA solved on ${hostname}, refreshing blocked tabs...`);
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id === sender.tab?.id) return;
          if (!tab.url || !tab.url.includes(hostname)) return;
          
          // Tell content script that CAPTCHA was solved elsewhere
          chrome.tabs.sendMessage(tab.id, {
            action: 'captchaSolved',
            hostname: hostname
          }).catch(() => {});
        });
      });
      
      // Reset rate limiter since CAPTCHA is solved
      if (hostname) {
        rateLimiter.reset(hostname);
      }
      return { ok: true };
    }

    case 'hiddenTabBlocked': {
      // Notify user that a hidden tab was blocked (CAPTCHA or rate limit)
      console.log(`[BG] Hidden tab blocked: ${message.blockerType} for post ${message.postId}`);
      try {
        chrome.tabs.update(sender.tab.id, { active: true });
        chrome.windows.update(sender.tab.windowId, { focused: true });
      } catch (e) {}
      return { ok: true };
    }

    default:
      return { error: 'Unknown action' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => {
      console.error('[BG] Handler error:', error);
      sendResponse({ error: error.message });
    });

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'booru-eagle-keepalive') {
    if (queue.tasks.length === 0 && !queue.processing) {
      chrome.alarms.clear('booru-eagle-keepalive');
    }
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { action: 'showPanel' });
});

console.log('[BooruEagle BG] Service worker started');

// ==================== GLOBAL HOTKEYS ====================

loadHotkeys();

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) return;
  
  const hostname = new URL(tab.url).hostname;
  const supportedSites = [
    'danbooru.donmai.us',
    'gelbooru.com',
    'konachan.com',
    'rule34.xxx',
    'chan.sankakucomplex.com',
    'yande.re'
  ];
  
  if (!supportedSites.some(site => hostname.includes(site.split('.')[1] || site))) return;
  
  const commandToAction = {
    'hotkey-save': 'triggerSave',
    'hotkey-parent': 'triggerSetParent',
    'hotkey-stop': 'triggerStop',
    'hotkey-postsave': 'triggerPostSave'
  };
  
  const action = commandToAction[command];
  if (!action) return;
  
  console.log(`[Hotkeys] Command: ${command} -> ${action}`);
  
  chrome.tabs.sendMessage(tab.id, {
    action: 'hotkeyAction',
    type: action
  }).catch(() => {
    console.log('[Hotkeys] No content script on this tab');
  });
});
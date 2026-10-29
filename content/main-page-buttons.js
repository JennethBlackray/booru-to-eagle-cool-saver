/**
 * @fileoverview Main page thumbnail save buttons & "collected" badge indicator
 * 
 * Uses site-configs.js for site-specific selectors and URL patterns.
 * Uses thumb-button-config.js for button and badge styles.
 * 
 * @module main-page-buttons
 */

/**
 * Global floating tooltip attached to document.body.
 * Never clipped by thumbnail container overflow:hidden,
 * clamped to viewport boundaries, and dynamically updates on attribute change.
 */
class BooruEagleTooltip {
  constructor() {
    this.el = null;
    this.activeBtn = null;
    this.observer = null;
    this._init();
  }

  _init() {
    this.el = document.createElement('div');
    this.el.className = 'booru-eagle-global-tooltip';
    document.body.appendChild(this.el);

    this.observer = new MutationObserver(() => {
      if (this.activeBtn && this.el && this.el.classList.contains('visible')) {
        this.update();
      }
    });
  }

  show(btn) {
    if (!btn || !this.el) return;
    this.activeBtn = btn;
    this.observer.disconnect();
    this.observer.observe(btn, { attributes: true, attributeFilter: ['data-tooltip'] });
    this.update();
    this.el.classList.add('visible');
  }

  update() {
    if (!this.activeBtn || !this.el) return;
    const text = this.activeBtn.getAttribute('data-tooltip');
    if (!text) {
      this.hide();
      return;
    }
    this.el.textContent = text;

    const btnRect = this.activeBtn.getBoundingClientRect();
    const tipRect = this.el.getBoundingClientRect();

    let top = btnRect.top - tipRect.height - 6;
    let left = btnRect.left + (btnRect.width / 2) - (tipRect.width / 2);

    if (left < 6) left = 6;
    if (left + tipRect.width > window.innerWidth - 6) {
      left = window.innerWidth - tipRect.width - 6;
    }

    if (top < 6) {
      top = btnRect.bottom + 6;
    }

    this.el.style.top = `${Math.round(top)}px`;
    this.el.style.left = `${Math.round(left)}px`;
  }

  hide() {
    if (this.observer) this.observer.disconnect();
    this.activeBtn = null;
    if (this.el) {
      this.el.classList.remove('visible');
    }
  }

  destroy() {
    this.hide();
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

class MainPageButtons {
  constructor() {
    /** @type {Set<string>} Track which post IDs already have buttons */
    this.processedPosts = new Set();
    
    /** @type {Map<string, HTMLElement>} Map of post ID to button element */
    this.buttonMap = new Map();

    /** @type {Map<string, {postEl: HTMLElement, targetContainer: HTMLElement, postKey: string|null, pHash: string|null}>} */
    this.postInfoMap = new Map();

    /** @type {Map<string, Promise<string|null>>} thumbUrl -> in-page pHash computation (dedupes repeated checks) */
    this.inPageHashCache = new Map();

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
    
    /** @type {ComparisonCard|null} Interactive duplicate inspector popover */
    this.comparisonCard = (typeof ComparisonCard !== 'undefined') ? new ComparisonCard() : null;

    /** @type {BooruEagleTooltip|null} Global floating tooltip (outside thumbnail container) */
    this.tooltip = new BooruEagleTooltip();

    // Initialize
    this.init();
  }

  /**
   * Extract image dimensions from post container element if available
   */
  extractDimensionsFromPost(postEl) {
    if (!postEl) return { width: 0, height: 0 };

    // 1. Check data attributes on post container, image, and links
    const elementsToCheck = [
      postEl,
      postEl.querySelector('.post-preview-container'),
      postEl.querySelector('img'),
      postEl.querySelector('a')
    ].filter(Boolean);

    for (const el of elementsToCheck) {
      const w = el.dataset?.fileWidth || el.dataset?.width || el.dataset?.originalWidth ||
                el.getAttribute('data-file-width') || el.getAttribute('data-width') || el.getAttribute('data-original-width');
      const h = el.dataset?.fileHeight || el.dataset?.height || el.dataset?.originalHeight ||
                el.getAttribute('data-file-height') || el.getAttribute('data-height') || el.getAttribute('data-original-height');
      if (w && h) {
        const pw = parseInt(w, 10);
        const ph = parseInt(h, 10);
        if (pw > 0 && ph > 0) return { width: pw, height: ph };
      }
    }

    // 2. Search text attributes (data-auto_page for Sankaku, title, alt) on img/a and labels (.directlink-res, etc.)
    const img = postEl.querySelector('img');
    const a = postEl.querySelector('a');
    const resEl = postEl.querySelector('.directlink-res, .desc, .tags, .directlink-info');

    const texts = [
      img?.getAttribute('data-auto_page'),
      img?.getAttribute('title'),
      img?.getAttribute('alt'),
      a?.getAttribute('title'),
      resEl?.textContent,
      postEl.getAttribute('title'),
      postEl.textContent
    ].filter(Boolean).join(' ');

    const m = texts.match(/(?:Size:\s*)?(\d{3,5})\s*[\u00D7\u00D7xX?*]\s*(\d{3,5})/i);
    if (m) {
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    return { width: 0, height: 0 };
  }

  /**
   * Fetch post page in background to extract dimensions and file size when missing from thumbnail
   * @param {string} postId
   * @returns {Promise<{width: number, height: number, size: number}>}
   */
  async fetchPostDetails(postId) {
    if (!this.siteConfig?.postPageUrl) return { width: 0, height: 0, size: 0 };
    const url = this.siteConfig.postPageUrl(postId);
    try {
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) return { width: 0, height: 0, size: 0 };
      const html = await resp.text();
      const dims = this.extractDimensionsFromHtml(html);
      const size = this.extractFileSizeFromHtml(html);
      return { width: dims.width, height: dims.height, size };
    } catch (e) {
      return { width: 0, height: 0, size: 0 };
    }
  }

  /**
   * Extract image file size in bytes from raw HTML string
   * @param {string} html
   * @returns {number}
   */
  extractFileSizeFromHtml(html) {
    if (!html) return 0;

    // 1. data-file-size="12345"
    const dfs = html.match(/data-file-size=["'](\d+)["']/i);
    if (dfs) return parseInt(dfs[1], 10);

    // 2. "file_size": 12345 or "file_size":12345
    const fsJson = html.match(/["']file_size["']\s*:\s*(\d+)/i);
    if (fsJson) return parseInt(fsJson[1], 10);

    // 3. Text patterns like "(9.07 MB PNG)" or "File size: 6.58 MB"
    const humanMatch = html.match(/(?:file\s*size:?|\()\s*(\d+(?:\.\d+)?)\s*(GB|MB|KB|GiB|MiB|KiB)\b/i) ||
                       html.match(/\b(\d+(?:\.\d+)?)\s*(GB|MB|KB|GiB|MiB|KiB)\b/i);
    if (humanMatch) {
      const val = parseFloat(humanMatch[1]);
      const unit = humanMatch[2].toUpperCase();
      if (unit.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024);
      if (unit.startsWith('M')) return Math.round(val * 1024 * 1024);
      if (unit.startsWith('K')) return Math.round(val * 1024);
    }

    return 0;
  }

  /**
   * Extract the post's tags from thumbnail markup:
   * - Danbooru / Sankaku: data-tags on the post element
   * - Yande.re / Konachan: img title "Rating: … Score: … Tags: … User: …"
   * - Gelbooru / Rule34: img title is the plain tag list (with score:/rating: tokens)
   * @param {HTMLElement} postEl
   * @returns {string[]}
   */
  extractTagsFromPost(postEl) {
    if (!postEl) return [];
    const img = postEl.querySelector('img');
    let text = postEl.dataset.tags || postEl.querySelector('[data-tags]')?.dataset.tags || img?.title || img?.alt || '';
    const tagsSection = text.match(/Tags:\s*(.*?)(?:\s+User:|$)/i);
    if (tagsSection) text = tagsSection[1];
    const tokens = text.split(/\s+/).filter(t => t && !/^(rating|score|size|id|user|md5|width|height):/i.test(t));
    return [...new Set(tokens)];
  }

  /**
   * Fetch post page in background to extract dimensions when missing from thumbnail (e.g. Rule34, Gelbooru)
   * @param {string} postId
   * @returns {Promise<{width: number, height: number}>}
   */
  async fetchPostDimensions(postId) {
    const details = await this.fetchPostDetails(postId);
    return { width: details.width, height: details.height };
  }

  /**
   * Extract image dimensions from raw HTML page string
   * @param {string} html
   * @returns {{width: number, height: number}}
   */
  extractDimensionsFromHtml(html) {
    if (!html) return { width: 0, height: 0 };

    // 1. data-file-width / data-file-height or data-width / data-height
    const dw = html.match(/data-(?:file-)?width=["'](\d+)["']/i);
    const dh = html.match(/data-(?:file-)?height=["'](\d+)["']/i);
    if (dw && dh) {
      const w = parseInt(dw[1], 10);
      const h = parseInt(dh[1], 10);
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    // 2. Size: WxH (common on Rule34, Gelbooru, Sankaku)
    const sizeMatch = html.match(/Size:\s*(\d+)\s*[x×X*]\s*(\d+)/i);
    if (sizeMatch) {
      const w = parseInt(sizeMatch[1], 10);
      const h = parseInt(sizeMatch[2], 10);
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    // 3. og:image:width / height
    const ogW = html.match(/property=["']og:image:width["'][^>]*content=["'](\d+)["']/i) ||
                html.match(/content=["'](\d+)["'][^>]*property=["']og:image:width["']/i);
    const ogH = html.match(/property=["']og:image:height["'][^>]*content=["'](\d+)["']/i) ||
                html.match(/content=["'](\d+)["'][^>]*property=["']og:image:height["']/i);
    if (ogW && ogH) {
      const w = parseInt(ogW[1], 10);
      const h = parseInt(ogH[1], 10);
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    // 4. Any direct resolution pattern
    const resMatch = html.match(/\b(\d{3,5})\s*[x×X*]\s*(\d{3,5})\b/);
    if (resMatch) {
      const w = parseInt(resMatch[1], 10);
      const h = parseInt(resMatch[2], 10);
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    // 5. Flashvars / video resolution hints (e.g. 1080p, 720p)
    if (html.includes('1080p') || html.includes('video_alt_url3')) return { width: 1920, height: 1080 };
    if (html.includes('720p') || html.includes('video_alt_url2')) return { width: 1280, height: 720 };
    if (html.includes('480p')) return { width: 854, height: 480 };

    return { width: 0, height: 0 };
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
    
    // Listen for save results and cache updates from background
    this._setupSaveResultListener();
    
    console.log('[BooruEagle MainPageButtons] Initialized');
  }

  /**
   * Listen for saveResult & collected cache messages from background worker
   */
  _setupSaveResultListener() {
    window._currentMainPageButtonsInstance = this;

    if (window._booruEagleMainPageMsgListener) return;
    window._booruEagleMainPageMsgListener = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const self = window._currentMainPageButtonsInstance;
      if (!self || self._destroyed) return;

      if (message.action === 'saveResult' && message.taskId?.startsWith('hidden-')) {
        // Extract post ID from taskId: "hidden-{postId}-{timestamp}-{random}"
        const parts = message.taskId.split('-');
        const postId = parts[1];

        // Find the button for this post
        const btn = self.buttonMap.get(postId);
        if (btn) {
          if (message.success) {
            btn.classList.remove('saving');
            btn.classList.add('success');
            btn.setAttribute('data-tooltip', message.sampleOnly
              ? `${THUMB_BUTTON_CONFIG.tooltipSuccess} (sample only — original not found)`
              : THUMB_BUTTON_CONFIG.tooltipSuccess);
            self.setPostCollectedBadge(postId, true);

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
      } else if (message.action === 'collectedItemAdded') {
        // Mark any matching post on this page as collected immediately
        const { postKey } = message;
        if (postKey) {
          for (const [postId, info] of self.postInfoMap.entries()) {
            if (info.postKey === postKey) {
              self.setPostCollectedBadge(postId, true);
            }
          }
        }
        sendResponse({ ok: true });
      } else if (message.action === 'collectedCacheUpdated') {
        // Re-verify all thumbnails on the page
        self.recheckAllPostsCollected();
        sendResponse({ ok: true });
      }
    });

    // ALSO listen for progress updates from storage (global sync)
    this._setupStorageSyncListener();
  }

  /**
   * Listen for save-progress and collected-cache-timestamp changes in chrome.storage
   * This keeps buttons and badges synced across ALL tabs
   */
  _setupStorageSyncListener() {
    if (window._booruEagleMainPageStorageListener) return;
    window._booruEagleMainPageStorageListener = true;

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      if (changes['collected-cache-timestamp']) {
        const self = window._currentMainPageButtonsInstance;
        if (self && !self._destroyed) {
          self.recheckAllPostsCollected();
        }
      }

      if (!changes['save-progress']) return;

      const progressData = changes['save-progress'].newValue;
      if (!progressData) return;

      // Update all buttons that are in "saving" state
      document.querySelectorAll(`.${THUMB_BUTTON_CONFIG.buttonClass}.saving`).forEach(btn => {
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
   * Inject CSS styles for the buttons and collected badge
   */
  injectStyles() {
    if (document.getElementById('booru-eagle-main-page-styles')) return;
    
    const styleEl = document.createElement('style');
    styleEl.id = 'booru-eagle-main-page-styles';
    styleEl.textContent = THUMB_BUTTON_CONFIG.css;
    
    document.head.appendChild(styleEl);
    console.log('[BooruEagle MainPageButtons] Styles injected');
  }

  /**
   * Scan the page for thumbnails, add buttons, and batch-check collected state
   */
  scanAndAddButtons() {
    const posts = this.getPostElements();
    const newlyAddedToCheck = [];

    posts.forEach(postEl => {
      const addedInfo = this.addButtonToPost(postEl);
      if (addedInfo) {
        newlyAddedToCheck.push(addedInfo);
      }
    });

    if (newlyAddedToCheck.length > 0) {
      this.checkCollectedBatch(newlyAddedToCheck);
    }

    // Prune stale entries on very long-lived pages (infinite scroll)
    if (this.processedPosts.size > 1000) {
      const activeIds = new Set();
      document.querySelectorAll(`.${THUMB_BUTTON_CONFIG.containerClass}`).forEach(container => {
        if (container.dataset.postId) activeIds.add(container.dataset.postId);
      });

      const oldProcessed = new Set(this.processedPosts);
      this.processedPosts.clear();
      this.buttonMap.clear();

      for (const key of Array.from(this.postInfoMap.keys())) {
        if (!activeIds.has(key)) {
          this.postInfoMap.delete(key);
        }
      }

      activeIds.forEach(id => {
        if (oldProcessed.has(id)) {
          this.processedPosts.add(id);
          const btn = document.querySelector(`div[data-post-id="${id}"] .${THUMB_BUTTON_CONFIG.buttonClass}`);
          if (btn) this.buttonMap.set(id, btn);
        }
      });
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
   * Add a save button to a single post element and return its check descriptor
   * @param {HTMLElement} postEl - The post container element
   * @returns {{postId: string, postKey: string|null, pHash: string|null}|null}
   */
  addButtonToPost(postEl) {
    if (!this.siteConfig) return null;
    
    // Get post ID
    const postId = this.siteConfig.idExtractor(postEl);
    if (!postId) {
      return null;
    }
    
    // Skip if already processed and container still exists in DOM
    if (this.processedPosts.has(postId) && postEl.querySelector(`.${THUMB_BUTTON_CONFIG.containerClass}`)) {
      return null;
    }
    
    this.processedPosts.add(postId);

    // Remove any dead button containers left from SPA history cache restoration
    postEl.querySelectorAll(`.${THUMB_BUTTON_CONFIG.containerClass}`).forEach(el => el.remove());
    
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

    // Global tooltip listeners (never clipped by thumbnail overflow)
    if (this.tooltip) {
      btn.addEventListener('mouseenter', () => this.tooltip.show(btn));
      btn.addEventListener('mouseleave', () => this.tooltip.hide());
    }
    
    // Click handler
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this._longPressTriggered) {
        this._longPressTriggered = false;
        return;
      }
      this.handleSaveClick(postId, btn, postEl);
    });
    
    // Prevent clicks on container from triggering parent link navigation
    container.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    container.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
    container.addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });
    container.appendChild(btn);
    
    // Append to post element (prefer explicit container selector when defined, then image link wrapper)
    const img = postEl.querySelector('img');
    const targetContainer = (this.siteConfig.thumbContainerSelector && postEl.querySelector(this.siteConfig.thumbContainerSelector)) || img?.closest('a') || postEl;
    if (targetContainer) {
      const computed = window.getComputedStyle(targetContainer);
      if (computed.position === 'static') {
        targetContainer.style.position = 'relative';
      }
      if (computed.display === 'inline') {
        targetContainer.style.display = 'inline-block';
        targetContainer.style.verticalAlign = 'top';
      }
    }
    targetContainer.appendChild(container);

    // Extract postKey, dimensions, and pHash from thumbnail
    const postKey = typeof buildPostKey === 'function' ? buildPostKey(this.hostname, postId) : null;
    const dims = this.extractDimensionsFromPost(postEl);
    // currentSrc = the URL actually displayed (respects <picture>/<source srcset>, e.g. Danbooru)
    const thumbUrl = img?.currentSrc || img?.src || '';

    let fingerprint = null;
    if (img && img.complete && img.naturalWidth > 0 && typeof BlockHash !== 'undefined') {
      fingerprint = BlockHash.computeElementFingerprint(img);
    }
    const pHash = fingerprint?.pHash || null;

    this.postInfoMap.set(postId, {
      postEl,
      targetContainer,
      postKey,
      pHash,
      blocks: fingerprint?.blocks || null,
      thumbUrl,
      width: dims.width,
      height: dims.height,
      size: 0
    });

    if (img && !pHash) {
      const onImgLoad = () => {
        img.removeEventListener('load', onImgLoad);
        const info = this.postInfoMap.get(postId);
        if (!info) return;

        if (!info.width || !info.height) {
          const freshDims = this.extractDimensionsFromPost(postEl);
          info.width = freshDims.width;
          info.height = freshDims.height;
        }

        if (!info.pHash && typeof BlockHash !== 'undefined') {
          const fp = BlockHash.computeElementFingerprint(img);
          if (fp) {
            info.pHash = fp.pHash;
            info.blocks = fp.blocks;
          }
        }
        info.thumbUrl = img.currentSrc || img.src || info.thumbUrl;

        this.checkCollectedBatch([{
          postId,
          postKey: info.postKey,
          pHash: info.pHash,
          thumbUrl: info.thumbUrl,
          width: info.width,
          height: info.height
        }]);
      };

      if (!img.complete) {
        img.addEventListener('load', onImgLoad, { once: true });
      }
    }

    return {
      postId,
      postKey,
      pHash,
      thumbUrl,
      width: dims.width,
      height: dims.height
    };
  }

  /**
   * Batch check with background service worker whether posts are already collected in Eagle
   * @param {Array<{postId: string, postKey: string|null, pHash: string|null, thumbUrl: string, width: number, height: number}>} items
   */
  async checkCollectedBatch(items) {
    if (!items || items.length === 0) return;
    try {
      if (this.siteConfig?.hashThumbsInPage) {
        await this.fillPHashesInPage(items);
      }
      const response = await chrome.runtime.sendMessage({
        action: 'checkCollectedBatch',
        items
      });
      if (response && Array.isArray(response.collectedPostIds)) {
        const collectedSet = new Set(response.collectedPostIds.map(id => String(id)));
        const detailsMap = response.detailsMap || {};

        for (const item of items) {
          const pid = String(item.postId);
          const isCollected = collectedSet.has(pid);
          const details = detailsMap[pid] || null;
          // Keep the hash the background computed so rechecks don't re-download the thumbnail
          const info = this.postInfoMap.get(item.postId);
          if (info && !info.pHash && details?.queryPHash) {
            info.pHash = details.queryPHash;
          }
          if (info && !info.blocks && details?.queryBlocks) {
            info.blocks = details.queryBlocks;
          }
          this.setPostCollectedBadge(item.postId, isCollected, details);
        }

        if (collectedSet.size === 0 && items.length === this.postInfoMap.size) {
          const badgeClass = THUMB_BUTTON_CONFIG.collectedBadgeClass || 'booru-eagle-collected-badge';
          document.querySelectorAll(`.${badgeClass}`).forEach(el => el.remove());
        }
      }
    } catch (e) {
      // Ignore transient messaging errors during page unload
    }
  }

  /**
   * Compute missing thumbnail pHashes by fetching them from the page context.
   * Used on sites whose CDN rejects background-worker fetches (see SiteConfig.hashThumbsInPage);
   * items that still have no pHash fall back to the background fetch.
   * @param {Array<{postId: string, pHash: string|null, thumbUrl: string}>} items
   */
  async fillPHashesInPage(items) {
    if (typeof BlockHash === 'undefined') return;
    const pending = items.filter(item => !item.pHash && item.thumbUrl);
    const CONCURRENCY = 6;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      await Promise.all(pending.slice(i, i + CONCURRENCY).map(async (item) => {
        const fp = await this.computeThumbPHashInPage(item.thumbUrl);
        item.pHash = fp?.pHash || null;
        const info = this.postInfoMap.get(item.postId);
        if (info && fp) {
          info.pHash = fp.pHash;
          info.blocks = fp.blocks;
        }
      }));
    }
  }

  /**
   * @param {string} url
   * @returns {Promise<{pHash: string, blocks: string}|null>}
   */
  computeThumbPHashInPage(url) {
    if (!this.inPageHashCache.has(url)) {
      const promise = (async () => {
        try {
          const response = await fetch(url, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await BlockHash.computeBlobFingerprint(await response.blob());
        } catch (e) {
          console.warn('[BooruEagle MainPageButtons] In-page thumbnail pHash failed:', url, e.message);
          this.inPageHashCache.delete(url); // allow a retry on the next recheck
          return null;
        }
      })();
      this.inPageHashCache.set(url, promise);
    }
    return this.inPageHashCache.get(url);
  }

  /**
   * Re-verify all thumbnails currently on the page
   */
  recheckAllPostsCollected() {
    const items = [];
    for (const [postId, info] of this.postInfoMap.entries()) {
      if (!info.pHash && typeof BlockHash !== 'undefined') {
        const img = info.postEl.querySelector('img');
        const fp = img && img.complete ? BlockHash.computeElementFingerprint(img) : null;
        if (fp) {
          info.pHash = fp.pHash;
          info.blocks = fp.blocks;
        }
      }
      items.push({
        postId,
        postKey: info.postKey,
        pHash: info.pHash,
        thumbUrl: info.thumbUrl,
        width: info.width,
        height: info.height
      });
    }
    if (items.length > 0) {
      this.checkCollectedBatch(items);
    }
  }

  /**
   * Add or remove badge at the top-right of a thumbnail, with interactive comparison hover
   * @param {string} postId
   * @param {boolean} isCollected
   * @param {Object|null} [details=null]
   */
  setPostCollectedBadge(postId, isCollected, details = null) {
    const info = this.postInfoMap.get(postId);
    if (!info) return;

    let targetContainer = info.targetContainer;
    if (!targetContainer || !document.contains(targetContainer)) {
      const img = info.postEl?.querySelector('img');
      targetContainer = (this.siteConfig.thumbContainerSelector && info.postEl?.querySelector(this.siteConfig.thumbContainerSelector)) || img?.closest('a') || info.postEl;
      if (targetContainer) {
        info.targetContainer = targetContainer;
        const computed = window.getComputedStyle(targetContainer);
        if (computed.position === 'static') targetContainer.style.position = 'relative';
        if (computed.display === 'inline') {
          targetContainer.style.display = 'inline-block';
          targetContainer.style.verticalAlign = 'top';
        }
      }
    }
    if (!targetContainer) return;

    const badgeClass = THUMB_BUTTON_CONFIG.collectedBadgeClass || 'booru-eagle-collected-badge';
    let badge = targetContainer.querySelector(`.${badgeClass}`);

    if (isCollected) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = badgeClass;
        badge.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        badge.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
        badge.addEventListener('mouseup', (e) => {
          e.stopPropagation();
        });
        targetContainer.appendChild(badge);
      }

      badge.classList.remove('badge-upgrade', 'badge-similar');

      // Decide badge text and styling
      if (details?.type === 'phash') {
        const eagleW = details.eagleItem?.w || details.eagleItem?.width || 0;
        const eagleH = details.eagleItem?.h || details.eagleItem?.height || 0;
        const eaglePixels = eagleW * eagleH;

        const webW = info.width || 0;
        const webH = info.height || 0;
        const webPixels = webW * webH;

        if (webPixels > eaglePixels && eaglePixels > 0) {
          badge.textContent = 'upgrade';
          badge.classList.add('badge-upgrade');
        } else {
          badge.textContent = `${Math.round(details.similarity)}%`;
          badge.classList.add('badge-similar');
        }
      } else {
        badge.textContent = 'collected';
      }

      // Listeners are attached once per badge, so they must read the latest match details from the badge
      // (a recheck after save/sync/replace can point the same badge at a different Eagle item)
      badge._details = details;

      // Attach hover comparison card listeners
      if (!badge._hasComparisonListeners && this.comparisonCard) {
        badge._hasComparisonListeners = true;
        badge.style.cursor = 'pointer';

        let hoverTimer = null;

        badge.addEventListener('mouseenter', () => {
          const details = badge._details;
          const info = this.postInfoMap.get(postId);
          if (!info) return;

          // If exact post match, populate known dimensions directly from eagleItem without any network request
          if (details?.type === 'exact' && details.eagleItem) {
            if (!info.width && details.eagleItem.w) info.width = details.eagleItem.w;
            if (!info.height && details.eagleItem.h) info.height = details.eagleItem.h;
            if (!info.size && details.eagleItem.size) info.size = details.eagleItem.size;
          }

          if (!info.width || !info.height) {
            const freshDims = this.extractDimensionsFromPost(info.postEl);
            if (freshDims.width && freshDims.height) {
              info.width = freshDims.width;
              info.height = freshDims.height;
            }
          }

          const eagleId = details?.eagleItem?.id || null;
          this.comparisonCard.show({
            postId,
            eagleItem: details?.eagleItem || null,
            webItem: {
              width: info.width || 0,
              height: info.height || 0,
              size: info.size || 0,
              tagCount: this.extractTagsFromPost(info.postEl).length,
              thumbUrl: info.thumbUrl
            },
            similarity: details?.similarity || 100,
            distance: details?.distance ?? null,
            queryPHash: details?.queryPHash || info.pHash || null,
            queryBlocks: info.blocks || details?.queryBlocks || null,
            isExactMatch: details?.type === 'exact',
            onReplace: async () => {
              await this.handleReplaceClick(postId, eagleId);
            }
          }, badge);

          if (eagleId) {
            chrome.runtime.sendMessage({ action: 'getEagleItemInfo', id: eagleId })
              .then(res => this.comparisonCard.updateEagleInfo(postId, res?.info || null))
              .catch(() => this.comparisonCard.updateEagleInfo(postId, null));
          }

          // Clear any pending timer
          if (hoverTimer) {
            clearTimeout(hoverTimer);
            hoverTimer = null;
          }

          // Anti-Cloudflare hover intent debounce (300ms):
          // Never fire network requests if user is just sweeping cursor across the page!
          // Only fetch if user intentionally pauses on the badge for >= 300ms, and only for non-exact matches.
          if ((!info.width || !info.height) && details?.type !== 'exact') {
            hoverTimer = setTimeout(async () => {
              hoverTimer = null;
              const remote = await this.fetchPostDetails(postId);
              let updated = false;
              if (remote.width && remote.height && (!info.width || !info.height)) {
                info.width = remote.width;
                info.height = remote.height;
                updated = true;
              }
              if (remote.size && !info.size) {
                info.size = remote.size;
                updated = true;
              }
              if (updated) {
                this.comparisonCard.updateWebDetails(postId, info.width, info.height, info.size || 0);

                // Update badge text if upgrade is detected
                if (details?.type === 'phash' && details.eagleItem) {
                  const eagleW = details.eagleItem?.w || details.eagleItem?.width || 0;
                  const eagleH = details.eagleItem?.h || details.eagleItem?.height || 0;
                  if ((info.width * info.height) > (eagleW * eagleH) && (eagleW * eagleH) > 0) {
                    badge.textContent = 'upgrade';
                    badge.classList.remove('badge-similar');
                    badge.classList.add('badge-upgrade');
                  }
                }
              }
            }, 300);
          }
        });

        badge.addEventListener('mouseleave', () => {
          if (hoverTimer) {
            clearTimeout(hoverTimer);
            hoverTimer = null;
          }
          this.comparisonCard.scheduleHide();
        });
      }
    } else if (badge) {
      badge.remove();
    }
  }

  /**
   * Handle replace in Eagle when user clicks "Replace" in comparison popover
   * @param {string} postId
   * @param {string|null} oldEagleId
   */
  async handleReplaceClick(postId, oldEagleId) {
    const btn = this.buttonMap.get(postId);
    if (btn) btn.classList.add('saving');

    const safetyTimeout = setTimeout(() => {
      if (btn && btn.classList.contains('saving')) {
        btn.classList.remove('saving');
        btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipDefault);
      }
    }, 15000);

    try {
      const storageResult = await chrome.storage.local.get('locked-parent-id');
      const lockedParentId = storageResult['locked-parent-id'] || null;

      const result = await chrome.runtime.sendMessage({
        action: 'saveFromMainPage',
        postId: postId,
        hostname: this.hostname,
        lockedParentId: lockedParentId,
        replaceEagleId: oldEagleId || null
      });

      if (result?.success) {
        if (btn) {
          btn.setAttribute('data-tooltip', `Replacing in Eagle...`);
          if (result.taskId) btn.dataset.taskId = result.taskId;
        }
      } else {
        clearTimeout(safetyTimeout);
        if (btn) {
          btn.classList.remove('saving');
          btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipDefault);
        }
      }
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.error('[BooruEagle] Replace failed:', e);
      if (btn) {
        btn.classList.remove('saving');
        btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipDefault);
      }
    }
  }

  /**
   * Handle save button click
   * @param {string} postId - Post ID
   * @param {HTMLElement} btn - Button element
   * @param {HTMLElement} postEl - Post container element
   */
  async handleSaveClick(postId, btn, postEl) {
    if (btn.classList.contains('saving')) {
      return;
    }

    console.log('[BooruEagle MainPageButtons] Save clicked for post:', postId);

    btn.classList.add('saving');
    btn.setAttribute('data-tooltip', THUMB_BUTTON_CONFIG.tooltipSaving);

    try {
      const storageResult = await chrome.storage.local.get('locked-parent-id');
      const lockedParentId = storageResult['locked-parent-id'] || null;

      const linkEl = postEl.querySelector('a[href*="/video/"], a.th');
      const directPostUrl = linkEl?.href || null;

      const result = await chrome.runtime.sendMessage({
        action: 'saveFromMainPage',
        postId: postId,
        postUrl: directPostUrl,
        hostname: this.hostname,
        lockedParentId: lockedParentId
      });

      if (result?.success) {
        btn.setAttribute('data-tooltip', `Queue #${result.position}`);
        if (result.taskId) {
          btn.dataset.taskId = result.taskId;
        }
      } else {
        throw new Error(result?.error || 'Unknown error');
      }
    } catch (error) {
      console.error('[BooruEagle MainPageButtons] Save failed:', error);

      btn.classList.remove('saving');
      btn.classList.add('error');
      btn.setAttribute('data-tooltip', `${THUMB_BUTTON_CONFIG.tooltipError}${error.message}`);

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
      if (e.button === 2) return;
      e.stopPropagation();
      
      this._longPressTriggered = false;
      
      this._longPressTimer = setTimeout(() => {
        this._longPressTriggered = true;
        this._handleSetParent(postId, btn);
      }, this.LONG_PRESS_DURATION);
    };
    
    const cancelLongPress = (e) => {
      if (e) e.stopPropagation();
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
    };
    
    btn.addEventListener('mousedown', startLongPress);
    btn.addEventListener('mouseup', cancelLongPress);
    btn.addEventListener('mouseleave', cancelLongPress);
    
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startLongPress(e);
    });
    btn.addEventListener('touchend', (e) => {
      e.stopPropagation();
      cancelLongPress(e);
    });
    btn.addEventListener('touchcancel', (e) => {
      e.stopPropagation();
      cancelLongPress(e);
    });
  }

  /**
   * Handle long press - set post as parent
   * @param {string} postId - Post ID to set as parent
   * @param {HTMLElement} btn - Button element for visual feedback
   * @private
   */
  async _handleSetParent(postId, btn) {
    console.log('[BooruEagle MainPageButtons] Long press - setting parent:', postId);
    
    btn.classList.add('parent-set');
    btn.setAttribute('data-tooltip', `Parent: #${postId}`);
    
    try {
      await chrome.storage.local.set({
        'set-parent-enabled': true,
        'locked-parent-id': postId
      });
      
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
    
    const selectors = this.siteConfig.thumbSelectors.join(', ');
    
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
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
        clearTimeout(this._scanTimeout);
        this._scanTimeout = setTimeout(() => {
          this.scanAndAddButtons();
        }, 500);
      }
    });
    
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

    if (this._scanTimeout) {
      clearTimeout(this._scanTimeout);
      this._scanTimeout = null;
    }

    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }

    if (this.tooltip) {
      this.tooltip.destroy();
      this.tooltip = null;
    }

    this._destroyed = true;

    document.querySelectorAll(`.${THUMB_BUTTON_CONFIG.containerClass}`).forEach(el => el.remove());

    this.processedPosts.clear();
    this.buttonMap.clear();
    this.postInfoMap.clear();

    console.log('[BooruEagle MainPageButtons] Destroyed');
  }
}

// Export for use in main.js
window.MainPageButtons = MainPageButtons;

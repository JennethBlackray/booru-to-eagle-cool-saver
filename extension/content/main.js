/**
 * @fileoverview Booru to Eagle Saver - Main Content Script
 * 
 * Uses the Parser Registry system to automatically detect and use
 * the correct parser for the current site.
 * 
 * For Sankaku: buttons are enabled immediately, parsing happens in background.
 * When Save is clicked, we wait for elements and parse, then save.
 * 
 * @module main
 */

(function() {
  'use strict';

  console.log('[BooruEagle] Content script loaded on:', window.location.hostname);

  // ==================== TYPE DEFINITIONS ====================

  /**
   * @typedef {Object} PanelState
   * @property {string|null} site - Current site display name
   * @property {string|null} imageUrl - Original image URL
   * @property {string[]} tags - Array of tags
   * @property {string} status - Status type: idle|ready|loading|error|success|warning
   * @property {string} statusMessage - Human-readable status text
   * @property {boolean} setParentEnabled - Set Parent toggle state
   * @property {string|null} lockedParentId - Locked parent post ID
   * @property {boolean} postSaveEnabled - Post-save action toggle
   * @property {boolean} buttonsEnabled - Whether buttons are enabled
   * @property {string|null} postId - Post ID from URL
   * @property {ImageDimensions|null} dimensions - Image dimensions
   */

  // ==================== STATE ====================

  /** @type {ParsedData|null} */
  let currentParsedData = null;
  
  /** @type {BaseParser|null} */
  let currentParser = null;
  
  /** @type {BooruEaglePanel|null} */
  let currentPanel = null;
  
  /** @type {string|null} Current pending task ID */
  let currentTaskId = null;
  
  /** @type {boolean} Whether post-save close is pending */
  let pendingPostSaveClose = false;

  /** @type {Object} Custom hotkeys */
  let customHotkeys = {
    'hotkey-save': 'Alt+Z',
    'hotkey-parent': 'Alt+X',
    'hotkey-stop': 'Alt+C',
    'hotkey-postsave': 'Alt+A'
  };

  /** @type {Object} Extension settings (global, shared with parsers) */
  window.extensionSettings = window.extensionSettings || { parseNotes: true };

  // ==================== UTILITIES ====================

  /**
   * Check if we're on a Sankaku site
   * @returns {boolean}
   */
  function isSankakuSite() {
    return window.location.hostname.includes('sankakucomplex');
  }

  /**
   * Validate parsed data from parser
   * @param {ParsedData|null} data - Data to validate
   * @returns {boolean} True if data is valid and has required fields
   */
  function isValidParseResult(data) {
    return data !== null && 
           data !== undefined && 
           typeof data.imageUrl === 'string' && 
           data.imageUrl.length > 0;
  }

  /**
   * Wait for all critical page elements to appear
   * Uses SankakuParser.waitForElement with polling for reliability
   * @param {string[]} selectors - Array of CSS selectors to wait for
   * @param {number} [timeout] - Max time to wait per element (ms)
   * @returns {Promise<(Element|null)[]>} Array of found elements (null if not found)
   */
  async function waitForPageElements(selectors, timeout = TIMEOUTS.ELEMENT_WAIT) {
    return Promise.all(
      selectors.map(selector => SankakuParser.waitForElement(selector, timeout))
    );
  }

  /**
   * Wait for CRITICAL page elements only (needed for image URL and post ID)
   * Non-critical elements (like tag sidebar) are NOT waited for here
   * @param {number} [timeout] - Max time to wait per element (ms)
   * @returns {Promise<(Element|null)[]>} Array of found elements
   */
  async function waitForCriticalElements(timeout = TIMEOUTS.ELEMENT_WAIT) {
    return waitForPageElements([
      SANKAKU_SELECTORS.HIGHRES,
      SANKAKU_SELECTORS.HIDDEN_POST_ID,
      SANKAKU_SELECTORS.IMAGE
    ], timeout);
  }

  /**
   * Wait for non-critical elements (tags) in the background
   * Does not block the main flow - updates panel when tags become available
   * @param {BaseParser} parser - The site parser
   * @param {BooruEaglePanel} panel - The panel instance
   */
  async function waitForTagsInBackground(parser, panel) {
    try {
      const tagSidebar = await SankakuParser.waitForElement(
        SANKAKU_SELECTORS.TAG_SIDEBAR,
        TIMEOUTS.ELEMENT_WAIT
      );

      if (tagSidebar && currentParsedData) {
        // Re-parse to get tags now that sidebar is loaded
        const updatedData = await parser.parse();
        if (updatedData && updatedData.tags && updatedData.tags.length > 0) {
          currentParsedData.tags = updatedData.tags;
          panel.updateData({
            tags: updatedData.tags
          });
          console.log(`[BooruEagle] Tags updated: ${updatedData.tags.length} tags`);
        }
      }
    } catch (e) {
      console.warn('[BooruEagle] Background tags parsing failed:', e);
    }
  }

  /**
   * Wait for page elements and parse data
   * Centralized function that handles element waiting + parsing + validation
   * For Sankaku: tries immediate parse first, only waits if needed.
   * Tags are loaded in background when #tag-sidebar appears.
   * @param {BaseParser} parser - The site parser
   * @param {BooruEaglePanel} panel - The panel instance
   * @param {Object} [options] - Optional settings
   * @param {boolean} [options.waitForElements=true] - Whether to wait for elements
   * @param {number} [options.elementTimeout] - Custom element wait timeout
   * @param {boolean} [options.quickParse=false] - If true, try immediate parse first (Sankaku)
   * @returns {Promise<ParsedData|null>} Parsed data or null if failed
   */
  async function ensureParsedData(parser, panel, options = {}) {
    const {
      waitForElements = true,
      elementTimeout = TIMEOUTS.ELEMENT_WAIT,
      quickParse = false
    } = options;

    // For Sankaku quick parse: try parsing immediately first
    if (quickParse && isSankakuSite()) {
      const immediateData = await parser.parse();
      if (isValidParseResult(immediateData)) {
        // Immediate parse succeeded - no need to wait
        console.log('[BooruEagle] Sankaku immediate parse succeeded');
        currentParsedData = immediateData;
        panel.updateData({
          imageUrl: immediateData.imageUrl,
          tags: immediateData.tags,
          postId: immediateData.postId,
          dimensions: immediateData.dimensions
        });

        // Load tags in background
        waitForTagsInBackground(parser, panel);
        return immediateData;
      }
      console.log('[BooruEagle] Sankaku immediate parse failed, waiting for elements...');
    }

    // Wait for elements if needed (Sankaku-specific)
    if (waitForElements && isSankakuSite()) {
      if (quickParse) {
        // Quick mode: only wait for critical elements (URL, ID, image)
        await waitForCriticalElements(elementTimeout);
      } else {
        // Full mode: wait for all elements including tags
        await waitForPageElements([
          SANKAKU_SELECTORS.TAG_SIDEBAR,
          SANKAKU_SELECTORS.HIGHRES,
          SANKAKU_SELECTORS.HIDDEN_POST_ID,
          SANKAKU_SELECTORS.IMAGE
        ], elementTimeout);

        // Additional delay for rendering
        await new Promise(r => setTimeout(r, TIMEOUTS.ELEMENT_RENDER_DELAY));
      }
    }

    // Parse the page
    const data = await parser.parse();

    // Validate result
    if (!isValidParseResult(data)) {
      console.warn('[BooruEagle] Parse result invalid:', {
        hasData: !!data,
        hasImageUrl: !!data?.imageUrl,
        tagsCount: data?.tags?.length || 0,
        postId: data?.postId
      });
      return null;
    }

    // Store parsed data
    currentParsedData = data;

    // Update panel
    panel.updateData({
      imageUrl: data.imageUrl,
      tags: data.tags,
      postId: data.postId,
      dimensions: data.dimensions
    });

    // For Sankaku quick parse: start loading tags in background
    if (quickParse && isSankakuSite()) {
      waitForTagsInBackground(parser, panel);
    }

    return data;
  }

  /**
   * Update panel status with tag count
   * @param {BooruEaglePanel} panel - Panel instance
   * @param {string} status - Status type
   * @param {string} [message] - Optional message
   */
  function updateStatusWithTags(panel, status, message) {
    const tagsCount = currentParsedData?.tags?.length || 0;
    const msg = message || `${tagsCount} tags`;
    panel.updateStatus(status, msg);
  }

  // ==================== INITIALIZATION ====================

  /** @type {MainPageButtons|null} Main page buttons instance */
  let mainPageButtons = null;

  /** @type {BooruEagleQueuePanel|null} Queue panel instance */
  let queuePanel = null;

  /** @type {MicroFixes|null} Micro-fixes instance */
  let microFixes = null;

  /**
   * Initialize the extension using the parser registry system
   */
  async function init() {
    console.log('[BooruEagle] Initializing with parser registry...');

    // Load extension settings from storage
    try {
      const stored = await chrome.storage.local.get('settings');
      if (stored.settings) {
        window.extensionSettings = { ...window.extensionSettings, ...stored.settings };
      }
    } catch (e) {
      console.warn('[BooruEagle] Could not load settings:', e);
    }

    const registry = new ParserRegistry();
    const parser = registry.findParser();

    if (!parser) {
      console.warn('[BooruEagle] No parser found for this site:', window.location.hostname);
      return;
    }

    currentParser = parser;
    console.log('[BooruEagle] Using parser:', parser.getSiteName());

    const isPostPage = parser.isPostPage();

    // Create panel
    const panel = new BooruEaglePanel();
    currentPanel = panel;

    // Initialize queue panel (shows queue when >1 tasks)
    if (typeof BooruEagleQueuePanel !== 'undefined') {
      queuePanel = new BooruEagleQueuePanel();
    }

    // Initialize main page buttons (for main/search pages)
    initMainPageButtons();

    // Initialize micro-fixes
    if (typeof MicroFixes !== 'undefined') {
      microFixes = new MicroFixes();
      microFixes.applyAll(window.extensionSettings);
    }
    
    // Apply saved position
    setTimeout(() => panel.applyPosition(), TIMEOUTS.PANEL_POSITION_DELAY);
    
    // Set site name
    panel.setSite(parser.getSiteName());

    // Load custom hotkeys
    try {
      const stored = await chrome.storage.local.get('hotkeys');
      if (stored.hotkeys) {
        customHotkeys = { ...customHotkeys, ...stored.hotkeys };
      }
    } catch (e) {
      console.warn('[BooruEagle] Could not load hotkeys:', e);
    }

    // Register keyboard listener for custom hotkeys
    if (!window._booruEagleKeyboardListenerRegistered) {
      window._booruEagleKeyboardListenerRegistered = true;
      window.addEventListener('keydown', handleKeyDown, true);
    }
    
    // Set up storage listener BEFORE any early returns
    // This ensures progress is synced on ALL pages (main + post)
    // NOTE: This listener is registered only once per content script instance
    // (not re-registered on SPA navigation since init() is called once per URL change)
    if (!window._booruEagleStorageListenerRegistered) {
      window._booruEagleStorageListenerRegistered = true;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (!changes['save-progress']) return;
        
        const progressData = changes['save-progress'].newValue;
        
        // Handle case when progress is cleared (storage entry removed)
        if (!progressData) {
          if (currentPanel) {
            currentPanel.resetSaveButton();
          }
          return;
        }
        
        // Update ALL tabs uniformly - progress bar and button text
        if (currentPanel) {
          const saveBtn = currentPanel.panel?.querySelector('#panel-save-btn');
          const progressFill = saveBtn?.querySelector('.btn-progress-fill');
          const btnText = saveBtn?.querySelector('.btn-text');
          
          // Update progress bar fill
          if (progressFill) {
            progressFill.style.setProperty('--progress', `${Math.min(100, Math.max(0, progressData.progress))}%`);
          }
          
          // Update button text on ALL tabs
          if (btnText) {
            if (progressData.text) {
              btnText.textContent = progressData.text;
            } else if (progressData.progress === 0) {
              // No text and progress is 0 - reset to default
              btnText.textContent = 'Save';
            }
          }
          
          // Add/remove saving class for visual styling
          if (saveBtn) {
            if (progressData.progress > 0 && progressData.progress < 100) {
              saveBtn.classList.add('saving');
            } else {
              // Progress is 0 or 100+ - not in saving state
              saveBtn.classList.remove('saving');
            }
            
            // Re-enable button when progress is 0 (queue cleared or no active download)
            // Only if the button was previously disabled due to saving
            if (progressData.progress === 0 && saveBtn.disabled) {
              saveBtn.disabled = false;
            }
          }
        }
        
      // Clear progress when done (after a short delay for visual feedback)
      // Only the "source" tab should trigger removal to avoid multiple deletions
      if (progressData.progress >= 100 && progressData.taskId === currentTaskId) {
        setTimeout(() => {
          try {
            chrome.storage.local.remove('save-progress');
          } catch (e) {}
        }, 1500);
      }
      });
    }

    // Clean up save-progress on tab close to prevent stale entries
    window.addEventListener('beforeunload', () => {
      try {
        chrome.storage.local.remove('save-progress');
      } catch (e) {}
    });

    if (!isPostPage) {
      console.log('[BooruEagle] Not on a post page');
      panel.updateStatus('warning', 'Open an image post to save');
      panel.setPostSaveEnabled(true);
      // Initialize progress from storage even on main pages
      initProgressFromStorage();
      return;
    }

    // ==================== RULE34 BLOCKED PAGE DETECTION ====================
    // Check if current page is blocked (429 rate limit or CAPTCHA)
    if (window.location.hostname.includes('rule34') && typeof Rule34Parser !== 'undefined') {
      const blockerType = Rule34Parser.getBlockerType();
      
      if (blockerType === 'rate_limit') {
        // 429 rate limiting: auto-refresh after delay
        console.log('[BooruEagle] Rate limited (429), auto-refreshing in 2s...');
        panel.updateStatus('warning', 'Rate limited, retrying...');
        panel.showToast('429 rate limit detected. Retrying in 2 seconds...', 'warning');
        
        // Store current URL for post-refresh re-parse
        setTimeout(() => {
          window.location.reload();
        }, 2000);
        return;
      }
      
      if (blockerType === 'captcha') {
        // CAPTCHA page: notify user and wait
        console.log('[BooruEagle] CAPTCHA detected on post page');
        panel.updateStatus('warning', 'CAPTCHA blocked - solve in tab');
        panel.showToast('CAPTCHA detected! Solve it in this tab to continue...', 'warning');
        
        // Try to focus this tab so user can solve the CAPTCHA
        try {
          chrome.runtime.sendMessage({
            action: 'focusTab',
            tabId: null // Current tab
          });
        } catch (e) {}
        
        // Try to bring the panel to attention
        if (panel.panel) {
          panel.panel.style.setProperty('z-index', '99999', 'important');
          
          // Create a prominent notification banner
          const banner = document.createElement('div');
          banner.id = 'booru-eagle-captcha-banner';
          banner.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: #ff4444;
            color: white;
            padding: 12px 20px;
            text-align: center;
            font-size: 16px;
            font-weight: bold;
            z-index: 999999;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
          `;
          const postId = parser.getPostId ? parser.getPostId() : 'unknown';
          banner.textContent = `⚠️ CAPTCHA BLOCKED (post #${postId}): Solve the "I'm not a robot" checkbox on this page to continue saving.`;
          
          // Add close button
          const closeBtn = document.createElement('button');
          closeBtn.textContent = '✕';
          closeBtn.style.cssText = `
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            background: transparent;
            border: 1px solid rgba(255,255,255,0.5);
            color: white;
            font-size: 18px;
            cursor: pointer;
            padding: 2px 8px;
            border-radius: 3px;
          `;
          closeBtn.onclick = () => banner.remove();
          banner.appendChild(closeBtn);
          document.body.prepend(banner);
          
          // Auto-dismiss after solving CAPTCHA or after 2 minutes
          const checkCaptchaSolved = setInterval(() => {
            if (!Rule34Parser.isCaptchaPage()) {
              // CAPTCHA solved - remove banner and refresh
              banner.remove();
              clearInterval(checkCaptchaSolved);
              console.log('[BooruEagle] CAPTCHA solved, proceeding...');
              panel.updateStatus('info', 'Loading...');
              panel.showToast('CAPTCHA solved! Loading page...', 'success');
              
              // Re-init to let other blocked pages know
              chrome.runtime.sendMessage({
                action: 'captchaSolved',
                hostname: window.location.hostname
              }).catch(() => {});
              
              // Continue normal initialization
              setTimeout(() => {
                if (isSankakuSite()) {
                  parseInBackground(parser, panel).catch(e => {
                    console.warn('[BooruEagle] Background parse failed:', e);
                  });
                } else {
                  parsePage(parser, panel);
                }
              }, 500);
            }
          }, 1000);
          
          // Store interval for cleanup
          window._captchaCheckInterval = checkCaptchaSolved;
          
          // Remove banner after 2 minutes
          setTimeout(() => {
            clearInterval(checkCaptchaSolved);
            if (banner.parentNode) banner.remove();
          }, 120000);
        }
        
        return;
      }
    }
    
    // Sankaku: enable buttons immediately, parse in background
    if (isSankakuSite()) {
      console.log('[BooruEagle] Sankaku detected - enabling buttons immediately, parsing in background...');
      panel.updateStatus('info', 'Loading...');
      panel.setButtonsEnabled(true);
      
      // Parse in background - don't block UI
      parseInBackground(parser, panel).catch(e => {
        console.warn('[BooruEagle] Background parse failed:', e);
      });
    } else {
      // Other sites: parse normally
      await parsePage(parser, panel);
    }
    
    // Listen for save events from panel (registered ONCE to prevent duplication on SPA navigation)
    if (!window._booruEagleSaveListenerRegistered) {
      window._booruEagleSaveListenerRegistered = true;
      window.addEventListener('booru-eagle-save', async (event) => {
        const saveData = event.detail;
        await handleSave(currentParser, currentPanel, saveData);
      });
    }
    
    // Listen for messages from background (save results, hotkey actions, hidden tab)
    // Registered ONCE to prevent accumulation on SPA navigation
    if (!window._booruEagleRuntimeListenerRegistered) {
      window._booruEagleRuntimeListenerRegistered = true;
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Use current variables via closure but ensure we don't handle if destroyed
        // This is safe because main.js is an IIFE and its state is persistent
        // until a full page reload or SPA cleanup.
      if (message.action === 'saveResult') {
        // Handle both regular saves and hidden tab saves
        // Hidden tab saves have taskId starting with "hidden-"
        if (message.taskId?.startsWith('hidden-')) {
          // Hidden tab save result - handle success/failure
          if (message.success) {
            console.log('[BooruEagle] Hidden tab save completed successfully');
            if (currentPanel) {
              currentPanel.updateStatus('success', 'Saved to Eagle!');
              currentPanel.showToast('Image saved to Eagle successfully!', 'success');
              
              // Handle post-save close for hidden tab saves
              // Use per-message postSaveEnabled instead of global flag
              if (message.postSaveEnabled) {
                console.log('[BooruEagle] Post-Save enabled: closing tab in 1s...');
                currentPanel.showToast('Closing tab in 1 second...', 'info');
                
                setTimeout(() => {
                  try {
                    chrome.runtime.sendMessage({ action: 'closeCurrentTab' });
                  } catch (e) {
                    // Extension context may have been invalidated
                    console.warn('[BooruEagle] Could not send closeCurrentTab:', e);
                  }
                }, TIMEOUTS.POST_SAVE_CLOSE);
              }
            }
          } else {
            console.error('[BooruEagle] Hidden tab save failed:', message.error);
            if (currentPanel) {
              currentPanel.updateStatus('error', 'Save failed');
              currentPanel.showToast(`Save failed: ${message.error || 'Unknown error'}`, 'error');
            }
          }
          if (currentPanel) {
            currentPanel.resetSaveButton();
          }
        } else {
          handleSaveResult(message);
        }
        sendResponse({ ok: true });
      } else if (message.action === 'hotkeyAction') {
        handleHotkeyAction(message.type, parser, panel);
        sendResponse({ ok: true });
      } else if (message.action === 'parseForMainPageSave') {
        // Hidden tab requests parse data (async)
        handleParseForMainPageSave(message).then(sendResponse);
        return true; // Keep channel open for async response
      } else if (message.action === 'pingContentScript') {
        // Background checking if content script is ready
        sendResponse(handlePingContentScript());
      } else if (message.action === 'hotkeysUpdated') {
        // Hotkeys updated in popup
        if (message.hotkeys) {
          customHotkeys = { ...customHotkeys, ...message.hotkeys };
          console.log('[BooruEagle] Hotkeys updated:', customHotkeys);
        }
        sendResponse({ ok: true });
      } else if (message.action === 'settingsChanged') {
        // Settings changed in popup - update local settings
        if (message.settings) {
          window.extensionSettings = { ...window.extensionSettings, ...message.settings };
          console.log('[BooruEagle] Settings updated:', window.extensionSettings);

          // Re-apply micro-fixes with new settings
          if (microFixes) {
            microFixes.applyAll(window.extensionSettings);
          }
        }
        sendResponse({ ok: true });
      } else if (message.action === 'captchaDetected') {
        // Background tells us a hidden tab hit a CAPTCHA
        console.log('[BooruEagle] CAPTCHA detected on hidden tab:', message.postUrl);
        if (currentPanel) {
          currentPanel.showToast('CAPTCHA detected on hidden tab, retrying...', 'warning');
        }
        sendResponse({ ok: true });
      } else if (message.action === 'captchaSolved') {
        // CAPTCHA was solved elsewhere - reload this page if it's blocked
        console.log('[BooruEagle] CAPTCHA solved elsewhere, checking this page...');
        if (typeof Rule34Parser !== 'undefined' && Rule34Parser.getBlockerType()) {
          if (currentPanel) {
            currentPanel.updateStatus('info', 'CAPTCHA solved, reloading...');
            currentPanel.showToast('CAPTCHA solved on another tab! Reloading...', 'success');
          }
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        }
        sendResponse({ ok: true });
      } else if (message.action === 'hiddenTabBlocked') {
        // Background tells us a hidden tab save failed due to blocking
        console.log('[BooruEagle] Hidden tab blocked:', message.blockerType, 'for post', message.postId);
        if (currentPanel) {
          if (message.blockerType === 'captcha') {
            currentPanel.showToast('CAPTCHA blocked. Open rule34 in a tab and solve it.', 'warning');
          } else {
            currentPanel.showToast(`Rate limited for post #${message.postId}. Retrying...`, 'warning');
          }
        }
        sendResponse({ ok: true });
      }
    });
    }

    // Notify background script
    chrome.runtime.sendMessage({ action: 'panelReady' });
    
    // Check for active download progress from storage (in case we navigated to a different page)
    initProgressFromStorage();
    
    console.log('[BooruEagle] Initialization complete');
  }

  /**
   * Initialize main page buttons for main/search pages
   */
  function initMainPageButtons() {
    // Only initialize on main pages (not post pages)
    if (currentParser?.isPostPage()) {
      return;
    }
    
    console.log('[BooruEagle] Initializing main page buttons...');
    
    if (typeof MainPageButtons !== 'undefined') {
      mainPageButtons = new MainPageButtons();
    } else {
      console.warn('[BooruEagle] MainPageButtons class not available');
    }
  }

  /**
   * Download image by extracting from the page's <img> element via canvas
   * Uses the existing image element that's already loaded on the page
   * @param {string} url - Image URL (for reference)
   * @returns {Promise<string>} Base64 data URL
   */
  function downloadImageViaCanvas(url) {
    return new Promise((resolve, reject) => {
      // Find the main image element on the page (already loaded)
      const imgEl = document.querySelector('#image');
      
      if (!imgEl) {
        reject(new Error('Image element #image not found on page'));
        return;
      }
      
      console.log('[Gelbooru] Found image element:', imgEl.src);
      
      // Wait a moment for image to fully load
      if (imgEl.complete && imgEl.naturalWidth > 0) {
        extractFromImageElement(imgEl, resolve, reject);
      } else {
        imgEl.onload = function() {
          extractFromImageElement(imgEl, resolve, reject);
        };
        imgEl.onerror = function() {
          reject(new Error('Image failed to load'));
        };
      }
    });
  }
  
  /**
   * Extract image data from an already-loaded img element via canvas
   * Note: Will fail with tainted canvas if image has CORS restrictions
   */
  function extractFromImageElement(imgEl, resolve, reject) {
    try {
      // Create canvas and draw image
      const canvas = document.createElement('canvas');
      canvas.width = imgEl.naturalWidth;
      canvas.height = imgEl.naturalHeight;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgEl, 0, 0);
      
      // Convert to base64
      const base64 = canvas.toDataURL('image/png');
      console.log('[Gelbooru] Canvas extraction successful, size:', base64.length, 'bytes');
      resolve(base64);
    } catch (canvasError) {
      // Canvas tainted by CORS - cannot extract
      reject(new Error('Canvas tainted by CORS: ' + canvasError.message));
    }
  }

  /**
   * Handle parse request from hidden tab (for main page save)
   * Called when background worker sends 'parseForMainPageSave' message
   * Waits for page elements to load before parsing (important for Sankaku)
   * For rule34, checks for blocked pages (429/CAPTCHA) first
   * For gelbooru, also downloads the image as base64
   */
  async function handleParseForMainPageSave(message) {
    if (!currentParser) {
      return { success: false, error: 'No parser available' };
    }

    try {
      // Check for blocked pages (429 or CAPTCHA) - only if requested
      const shouldCheckBlocker = message?.checkBlocker === true;
      if (shouldCheckBlocker && typeof Rule34Parser !== 'undefined') {
        const blockerType = Rule34Parser.getBlockerType();
        if (blockerType) {
          console.log(`[BooruEagle] Hidden tab: page blocked (${blockerType}), notifying background`);
          return { 
            blocked: true, 
            blockerType: blockerType,
            success: false
          };
        }
      }

      // For Sankaku, wait for CRITICAL elements only (page is dynamic)
      // Tags are NOT needed for the save operation - they're added from parsed data
      if (isSankakuSite()) {
        console.log('[BooruEagle] Hidden tab: waiting for critical Sankaku elements...');
        const elements = await Promise.all([
          SankakuParser.waitForElement(SANKAKU_SELECTORS.HIGHRES, 10000),
          SankakuParser.waitForElement(SANKAKU_SELECTORS.HIDDEN_POST_ID, 10000),
          SankakuParser.waitForElement(SANKAKU_SELECTORS.IMAGE, 10000)
        ]);

        // Check if critical elements were found
        if (!elements[0] || !elements[1]) {
          console.warn('[BooruEagle] Hidden tab: critical elements not found');
        }

        // Minimal delay for rendering
        await new Promise(r => setTimeout(r, 300));
      }
      
      // Parse the page (async for rule34 notes support)
      const data = await currentParser.parse();

      if (!data || !data.imageUrl) {
        // If no image URL parsed and it's rule34, might be blocked
        if (shouldCheckBlocker && window.location.hostname.includes('rule34')) {
          const blockerType = Rule34Parser.getBlockerType();
          if (blockerType) {
            return { blocked: true, blockerType, success: false };
          }
        }
        return { success: false, error: 'Could not parse post data' };
      }

      console.log('[BooruEagle] Hidden tab parse result:', {
        imageUrl: data.imageUrl,
        tagsCount: data.tags?.length || 0,
        postId: data.postId
      });
      
      // For gelbooru, try canvas extraction but fall back to URL-only
      let base64Data = null;
      if (window.location.hostname.includes('gelbooru')) {
        console.log('[BooruEagle] Hidden tab: trying canvas extraction for gelbooru...');
        try {
          base64Data = await downloadImageViaCanvas(data.imageUrl);
          console.log('[BooruEagle] Hidden tab: image extracted via canvas, size:', base64Data.length, 'bytes');
        } catch (downloadError) {
          console.warn('[BooruEagle] Hidden tab: Canvas extraction failed, falling back to URL:', downloadError.message);
          // Don't throw - let background worker use saveToEagleURL instead
          base64Data = null;
        }
      }
      
      return { success: true, data, base64: base64Data };
    } catch (error) {
      console.error('[BooruEagle] Hidden tab parse error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle ping from background (for hidden tab readiness check)
   */
  function handlePingContentScript() {
    return { pong: true };
  }

  /**
   * Initialize progress from storage (for when navigating between pages during active downloads)
   */
  async function initProgressFromStorage() {
    try {
      const result = await chrome.storage.local.get('save-progress');
      if (result['save-progress'] && currentPanel) {
        const progressData = result['save-progress'];
        const saveBtn = currentPanel.panel?.querySelector('#panel-save-btn');
        const progressFill = saveBtn?.querySelector('.btn-progress-fill');
        const btnText = saveBtn?.querySelector('.btn-text');
        
        // Apply current progress
        if (progressFill) {
          progressFill.style.setProperty('--progress', `${Math.min(100, Math.max(0, progressData.progress))}%`);
        }
        
        if (btnText && progressData.text) {
          btnText.textContent = progressData.text;
        }
        
        if (saveBtn) {
          if (progressData.progress > 0 && progressData.progress < 100) {
            saveBtn.classList.add('saving');
          }
          // Re-enable button if progress is 0
          if (progressData.progress === 0 && saveBtn.disabled) {
            saveBtn.disabled = false;
          }
        }
      }
    } catch (e) {
      console.warn('[BooruEagle] Could not init progress from storage:', e);
    }
  }

  // ==================== PARSING ====================

  /**
   * Parse page data and update panel
   * Unified function used for all sites
   * @param {BaseParser} parser - The site parser
   * @param {BooruEaglePanel} panel - The panel instance
   * @param {Object} [options] - Optional settings
   * @param {boolean} [options.waitForElements=false] - Whether to wait for elements (Sankaku)
   */
  async function parsePage(parser, panel, options = {}) {
    const { waitForElements = false } = options;
    console.log('[BooruEagle] parsePage called, waitForElements:', waitForElements);

    const data = await ensureParsedData(parser, panel, {
      waitForElements,
      elementTimeout: TIMEOUTS.ELEMENT_WAIT
    });

    console.log('[BooruEagle] parsePage: ensureParsedData returned:', !!data);

    if (!data) {
      console.error('[BooruEagle] Failed to get image URL');
      panel.updateStatus('error', 'Could not find image');
      return;
    }

    console.log('[BooruEagle] parsePage: calling setButtonsEnabled(true)');
    panel.setButtonsEnabled(true);

    // Check Eagle connection
    try {
      const result = await chrome.runtime.sendMessage({ action: 'checkEagleConnection' });
      if (!result?.connected) {
        updateStatusWithTags(panel, 'warning', `${data.tags?.length || 0} tags - Eagle offline`);
        return;
      }
    } catch (e) {
      console.warn('[BooruEagle] Could not check Eagle:', e);
    }

    updateStatusWithTags(panel, 'ready');
    console.log('[BooruEagle] parsePage completed');
  }

  /**
   * Parse page data in background for Sankaku (doesn't block UI)
   * Uses quickParse mode - waits only for critical elements (URL, ID), then parses.
   * Tags are loaded asynchronously in background.
   * @param {BaseParser} parser - The site parser
   * @param {BooruEaglePanel} panel - The panel instance
   */
  async function parseInBackground(parser, panel) {
    console.log('[BooruEagle] Background parse started (quick mode)...');
    await parsePage(parser, panel, { waitForElements: true, quickParse: true });
  }

  // ==================== SAVE HANDLER ====================

  /**
   * Handle save button click - enqueues download+save in unified queue
   * Order is captured immediately at click time, download happens in parallel
   * Save queue processes tasks in FIFO order, waiting for downloads
   * @param {BaseParser} parser - The site parser
   * @param {BooruEaglePanel} panel - The panel instance
   * @param {Object} saveData - Data from panel state
   */
  async function handleSave(parser, panel, saveData) {
    // If we don't have parsed data yet, parse now
    if (!currentParsedData || !currentParsedData.imageUrl) {
      console.log('[BooruEagle] No parsed data, parsing now...');
      panel.updateStatus('info', 'Loading page...');

      const data = await ensureParsedData(parser, panel, {
        waitForElements: isSankakuSite(),
        quickParse: isSankakuSite()  // Sankaku: only wait for critical elements
      });

      if (!data) {
        panel.updateStatus('error', 'Could not find image');
        panel.showToast('Could not find image on page', 'error');
        reenableSaveButton(panel);
        return;
      }
    }
    
    const data = currentParsedData;
    
    // Build tags array - add parent tag if Set Parent is enabled
    // Use saveData.tags only if it has items, otherwise fall back to data.tags
    // (empty array [] is truthy, so we must check length explicitly)
    let finalTags = (saveData.tags && saveData.tags.length > 0) ? saveData.tags : (data.tags || []);
    if (saveData.setParentEnabled && saveData.lockedParentId) {
      finalTags = [`parent:${saveData.lockedParentId}`, ...finalTags];
      console.log('[BooruEagle] Added parent tag:', saveData.lockedParentId);
    }
    
    // Generate unique task ID for this save
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    currentTaskId = taskId;
    pendingPostSaveClose = saveData.postSaveEnabled || false;
    
    // Build save data for the queue
    const saveDataForQueue = {
      taskId,  // Include taskId for tracking
      tags: finalTags,
      name: data.postId ? `post_${data.postId}` : undefined,
      website: data.pageUrl || data.sourceUrl || '',
      annotation: data.annotation || undefined,  // Pass notes from parser (rule34)
      referer: data.pageUrl,
      site: data.site,
      postId: data.postId,
      postSaveEnabled: saveData.postSaveEnabled || false
    };

    // Gelbooru: use queue with useUrlDirect flag (Eagle downloads URL, no CORS)
    // This ensures gelbooru saves are in the same queue as other sites
    if (data.site === 'gelbooru.com' || window.location.hostname.includes('gelbooru')) {
      console.log('[BooruEagle] Gelbooru detected - using queue with URL direct');
      panel.updateStatus('info', 'Downloading image...');
      panel.showToast('Downloading original image...', 'info');
      
      // Mark as URL direct (skip download, Eagle will fetch URL)
      saveDataForQueue.useUrlDirect = true;
      
      try {
        const queueResult = await chrome.runtime.sendMessage({
          action: 'enqueueDownload',
          data: {
            taskId,
            url: data.imageUrl,
            referer: data.pageUrl,
            saveData: saveDataForQueue
          }
        });
        
        if (queueResult?.queued) {
          console.log(`[BooruEagle] Enqueued: ${taskId} (position: ${queueResult.position})`);
          panel.updateStatus('info', `Queue #${queueResult.position}`);
        } else {
          throw new Error(queueResult?.error || 'Failed to enqueue');
        }
      } catch (error) {
        console.error('[BooruEagle] Enqueue failed:', error);
        panel.updateStatus('error', 'Queue failed');
        panel.showToast(`Queue error: ${error.message}`, 'error');
        reenableSaveButton(panel);
      }
      return;
    }
    
    // Standard flow: enqueue download+save via background worker
    panel.updateStatus('info', 'Downloading image...');
    panel.showToast('Downloading original image...', 'info');
    
    try {
      const queueResult = await chrome.runtime.sendMessage({
        action: 'enqueueDownload',
        data: {
          taskId,
          url: data.imageUrl,
          referer: data.pageUrl,
          saveData: saveDataForQueue
        }
      });
      
      if (queueResult?.queued) {
        console.log(`[BooruEagle] Enqueued: ${taskId} (position: ${queueResult.position})`);
        panel.updateStatus('info', `Queue #${queueResult.position}`);
      } else {
        throw new Error(queueResult?.error || 'Failed to enqueue');
      }
    } catch (error) {
      console.error('[BooruEagle] Enqueue failed:', error);
      panel.updateStatus('error', 'Queue failed');
      panel.showToast(`Queue error: ${error.message}`, 'error');
      reenableSaveButton(panel);
    }
  }

  /**
   * Handle save result from background queue
   * Called when the background worker finishes processing this tab's save request
   * @param {Object} result - { taskId, success, error, data }
   */
  function handleSaveResult(result) {
    const { taskId, success, error, postSaveEnabled } = result;
    
    // Ignore results for tasks that are no longer current
    if (taskId !== currentTaskId) {
      console.log('[BooruEagle] Ignoring stale result for task:', taskId);
      return;
    }
    
    currentTaskId = null;
    
    if (success) {
      console.log('[BooruEagle] Save completed successfully');
      currentPanel?.updateStatus('success', 'Saved to Eagle!');
      currentPanel?.showToast('Image saved to Eagle successfully!', 'success');
      
      // Handle post-save action: close tab after successful save
      // Use per-message postSaveEnabled instead of global flag
      if (postSaveEnabled) {
        console.log('[BooruEagle] Post-Save enabled: closing tab in 1s...');
        currentPanel?.showToast('Closing tab in 1 second...', 'info');
        
        setTimeout(() => {
          try {
            chrome.runtime.sendMessage({ action: 'closeCurrentTab' });
          } catch (e) {
            console.warn('[BooruEagle] Could not send closeCurrentTab:', e);
          }
        }, TIMEOUTS.POST_SAVE_CLOSE);
      }
    } else {
      console.error('[BooruEagle] Save failed:', error);
      currentPanel?.updateStatus('error', 'Save failed');
      currentPanel?.showToast(`Save failed: ${error || 'Unknown error'}`, 'error');
    }
    
    // Re-enable save button
    reenableSaveButton(currentPanel);
  }

  /**
   * Re-enable the save button after save attempt
   * @param {BooruEaglePanel} panel - The panel instance
   */
  function reenableSaveButton(panel) {
    if (panel) {
      panel.resetSaveButton();
    }
  }

  // ==================== HOTKEY ACTIONS ====================

  /**
   * Keyboard event handler for custom hotkeys
   * @param {KeyboardEvent} e
   */
  function handleKeyDown(e) {
    // Don't trigger hotkeys if user is typing in an input/textarea
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) {
      return;
    }

    const combo = formatKeyCombo(e);
    if (!combo) return;

    // Map combo to action
    let actionType = null;
    if (combo === customHotkeys['hotkey-save']) actionType = 'triggerSave';
    else if (combo === customHotkeys['hotkey-parent']) actionType = 'triggerSetParent';
    else if (combo === customHotkeys['hotkey-stop']) actionType = 'triggerStop';
    else if (combo === customHotkeys['hotkey-postsave']) actionType = 'triggerPostSave';

    if (actionType) {
      console.log('[BooruEagle] Custom hotkey triggered:', combo, '->', actionType);
      e.preventDefault();
      e.stopPropagation();
      handleHotkeyAction(actionType, currentParser, currentPanel);
    }
  }

  /**
   * Format key combination for comparison
   * Must match the format used in popup/popup.js
   */
  function formatKeyCombo(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');

    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;

    let mainKey = e.key;
    if (mainKey.length === 1) {
      mainKey = mainKey.toUpperCase();
    } else if (mainKey === ' ') {
      mainKey = 'Space';
    } else if (mainKey === 'Escape') {
      mainKey = 'Esc';
    } else if (mainKey === 'Delete') {
      mainKey = 'Del';
    } else if (mainKey === 'Backspace') {
      mainKey = 'Bksp';
    } else if (mainKey === 'ArrowUp') {
      mainKey = '↑';
    } else if (mainKey === 'ArrowDown') {
      mainKey = '↓';
    } else if (mainKey === 'ArrowLeft') {
      mainKey = '←';
    } else if (mainKey === 'ArrowRight') {
      mainKey = '→';
    }

    parts.push(mainKey);
    return parts.join('+');
  }

  /**
   * Handle hotkey action from background or popup
   * Triggers the same visual effects as clicking the buttons
   * @param {string} type - Action type
   * @param {BaseParser} parser - The site parser
   * @param {BooruEaglePanel} panel - The panel instance
   */
  function handleHotkeyAction(type, parser, panel) {
    console.log('[BooruEagle] Hotkey action:', type);
    
    switch (type) {
      case 'triggerSave':
        // Trigger save button click visually
        const saveBtn = panel.panel?.querySelector('#panel-save-btn');
        if (saveBtn && !saveBtn.disabled) {
          saveBtn.click();
          // Visual feedback
          saveBtn.classList.add('active');
          setTimeout(() => saveBtn.classList.remove('active'), 200);
        }
        break;
        
      case 'triggerSetParent':
        // Call the panel method directly instead of simulating click
        if (panel && typeof panel.onSetParentClick === 'function') {
          panel.onSetParentClick();
        } else {
          // Fallback: try clicking the button
          const parentBtn = panel.panel?.querySelector('#panel-set-parent-btn');
          if (parentBtn) {
            parentBtn.click();
          }
        }
        break;
        
      case 'triggerStop':
        // Trigger stop button
        const stopBtn = panel.panel?.querySelector('#panel-stop-btn');
        if (stopBtn && !stopBtn.disabled) {
          stopBtn.click();
          // Visual feedback
          stopBtn.classList.add('active');
          setTimeout(() => stopBtn.classList.remove('active'), 200);
        }
        break;
        
      case 'triggerPostSave':
        // Trigger post-save toggle
        if (panel && typeof panel.onPostSaveClick === 'function') {
          panel.onPostSaveClick();
          
          // Visual feedback
          const postSaveBtn = panel.panel?.querySelector('#panel-post-save-btn');
          if (postSaveBtn) {
            postSaveBtn.classList.add('active-flash');
            setTimeout(() => postSaveBtn.classList.remove('active-flash'), 200);
          }
        }
        break;
        
      default:
        console.warn('[BooruEagle] Unknown hotkey action:', type);
    }
  }

  // ==================== SPA NAVIGATION ====================

  /**
   * Wait for DOM to be ready then initialize
   */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Sankaku and other sites use client-side routing (SPA).
  // Detect URL changes and re-initialize the parser.
  
  let lastUrl = window.location.href;
  let initTimeout = null;
  
  const observeUrlChanges = () => {
    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);
    
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
      originalPushState.apply(this, args);
      handleUrlChange();
    };
    
    const originalReplaceState = history.replaceState;
    history.replaceState = function(...args) {
      originalReplaceState.apply(this, args);
      handleUrlChange();
    };
  };
  
  const handleUrlChange = () => {
    if (initTimeout) clearTimeout(initTimeout);

    initTimeout = setTimeout(() => {
      const newUrl = window.location.href;
      if (newUrl !== lastUrl) {
        console.log('[BooruEagle] URL changed:', lastUrl, '->', newUrl);
        lastUrl = newUrl;

        // Clean up old panel (removes DOM + storage listener)
        if (currentPanel) {
          currentPanel.close();
          currentPanel = null;
          console.log('[BooruEagle] Closed old panel');
        }

        // Clean up old main page buttons (disconnects observer)
        if (mainPageButtons) {
          mainPageButtons.destroy();
          mainPageButtons = null;
          console.log('[BooruEagle] Destroyed old main page buttons');
        }

        // Clean up old queue panel (removes DOM element)
        if (queuePanel) {
          queuePanel.close();
          queuePanel = null;
          console.log('[BooruEagle] Closed old queue panel');
        }

        // Clean up micro-fixes
        if (microFixes) {
          microFixes.destroy();
          microFixes = null;
          console.log('[BooruEagle] Destroyed old micro-fixes');
        }

        // Reset state
        currentParsedData = null;
        currentParser = null;

        // Clear parser caches (register data from previous page)
        window._konachanRegisterData = undefined;
        window._yandereRegisterData = undefined;

        // Clear stale save-progress from previous page
        try {
          chrome.storage.local.remove('save-progress');
        } catch (e) {}

        // Re-initialize
        init();
      }
    }, TIMEOUTS.URL_CHANGE_DEBOUNCE);
  };
  
  observeUrlChanges();
  console.log('[BooruEagle] SPA navigation monitoring enabled');
})();
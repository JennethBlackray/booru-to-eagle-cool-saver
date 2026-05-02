/**
 * @fileoverview Configuration for Booru to Eagle Saver extension
 * 
 * This file contains all configurable settings for the extension.
 * To add support for a new site, add an entry to SUPPORTED_SITES.
 * 
 * @module config
 */

/**
 * Eagle API configuration
 * @constant {Object}
 */
const EAGLE_CONFIG = {
  /** @type {string} Base URL for Eagle local API */
  baseUrl: 'http://localhost:41595',
  
  /** @type {Object} API endpoints */
  endpoints: {
    /** GET - Check if Eagle is running (returns 200 if running) */
    status: '/api/item/list',
    /** POST - Add image from URL with tags */
    addItem: '/api/item/addFromURL'
  },
  
  /** @type {number} Timeout for status check (ms) */
  statusTimeout: 5000,
  
  /** @type {number} Timeout for add item (ms) */
  addItemTimeout: 60000
};



/**
 * Timeout configuration (milliseconds)
 * @constant {Object}
 */
const TIMEOUTS = {
  /** Max time to wait for page elements to appear */
  ELEMENT_WAIT: 15000,
  /** Max time for retry element wait */
  ELEMENT_WAIT_RETRY: 10000,
  /** Additional delay after elements appear (for rendering) */
  ELEMENT_RENDER_DELAY: 1000,
  /** Debounce for URL change detection */
  URL_CHANGE_DEBOUNCE: 300,
  /** Panel position apply delay */
  PANEL_POSITION_DELAY: 100,
  /** Post-save tab close delay */
  POST_SAVE_CLOSE: 1000,
  /** Eagle status check timeout */
  EAGLE_STATUS_CHECK: 5000,
  /** Eagle add item timeout */
  EAGLE_ADD_ITEM: 60000,
};

/**
 * CSS selectors for Sankaku page elements
 * @constant {string[]}
 */
const SANKAKU_SELECTORS = {
  TAG_SIDEBAR: '#tag-sidebar',
  HIGHRES: '#highres',
  HIDDEN_POST_ID: '#hidden_post_id',
  IMAGE: '#image',
  LOWRES: '#lowres',
  IMAGE_LINK: '#image-link'
};

/**
 * Rule34-specific configuration for handling rate limiting and CAPTCHA
 * @constant {Object}
 */
const RULE34_CONFIG = {
  /** Minimum delay (ms) between requests to rule34.xxx to avoid 429 */
  MIN_REQUEST_INTERVAL: 800,
  /** Delay (ms) before retrying after 429 */
  RETRY_DELAY_429: 3000,
  /** Delay (ms) before retrying after CAPTCHA */
  RETRY_DELAY_CAPTCHA: 5000,
  /** Maximum number of retry attempts for blocked pages */
  MAX_RETRIES: 5,
  /** Page ready check interval (ms) */
  PAGE_CHECK_INTERVAL: 1000,
  /** Maximum time to wait for page to become ready (ms) */
  PAGE_WAIT_TIMEOUT: 120000,
  
  /** Title text for 429 rate limiting page */
  TITLE_429: '429 Rate limiting',
  /** Title text for Cloudflare CAPTCHA page */
  TITLE_CAPTCHA: 'Один момент',
  
  /** Selector for Cloudflare Turnstile widget */
  CAPTCHA_SELECTOR: '#cf-chl-widget',
  /** Selector for CAPTCHA success state */
  CAPTCHA_SUCCESS_SELECTOR: '[data-cf-turnstile-response]'
};

/**
 * Extension metadata
 * @constant {Object}
 */
const EXTENSION_META = {
  name: 'Booru to Eagle Saver',
  version: '1.0.0',
  logPrefix: '[BooruEagle]'
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EAGLE_CONFIG, TIMEOUTS, SANKAKU_SELECTORS, RULE34_CONFIG, EXTENSION_META };
}
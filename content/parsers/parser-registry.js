/**
 * @fileoverview Parser Registry
 * 
 * Central registry for all site parsers. To add a new site:
 * 
 * 1. Create a new file: extension/content/parsers/yoursite-parser.js
 * 2. Extend BaseParser class
 * 3. Register it here by adding to the PARSERS array
 * 
 * @module parsers/registry
 * 
 * @example
 * // Adding a new site parser:
 * // 1. Create: extension/content/parsers/mysite-parser.js
 * // 2. Add to PARSERS array below:
 * //    { factory: () => new MySiteParser() }
 * // 3. Add the script to manifest.json content_scripts
 */

/**
 * Registry of all site parsers
 * 
 * Each entry has:
 * - factory: Function that creates the parser instance
 * - enabled: Whether this parser is active (default: true)
 * 
 * To DISABLE a site temporarily, set enabled: false
 * To REMOVE a site, delete its entry from this array
 * To ADD a site, add a new entry with a factory function
 */
const PARSERS = [
  // Danbooru
  {
    factory: () => new DanbooruParser(),
    enabled: true
  },
  
  // Gelbooru
  {
    factory: () => new GelbooruParser(),
    enabled: true
  },
  
  // Konachan
  {
    factory: () => new KonachanParser(),
    enabled: true
  },
  
  // Rule34.xxx
  {
    factory: () => new Rule34Parser(),
    enabled: true
  },
  
  // Sankaku Complex
  {
    factory: () => new SankakuParser(),
    enabled: true
  },
  
  // Yande.re
  {
    factory: () => new YandeReParser(),
    enabled: true
  }
  
  // ============================================
  // TO ADD A NEW SITE:
  // ============================================
  // 1. Create file: extension/content/parsers/yoursite-parser.js
  // 2. Copy template from base-parser.js documentation
  // 3. Add entry here:
  //    {
  //      factory: () => new YourSiteParser(),
  //      enabled: true
  //    }
  // 4. Add script to manifest.json content_scripts array
  // ============================================
];

/**
 * Parser Registry class
 * Manages registration and lookup of site parsers
 */
class ParserRegistry {
  constructor() {
    /** @type {Array<{parser: BaseParser, enabled: boolean}>} */
    this._parsers = [];
    
    // Initialize parsers from config
    this._init();
  }
  
  /**
   * Initialize parsers from PARSERS array
   * @private
   */
  _init() {
    for (const entry of PARSERS) {
      if (entry.enabled !== false) {
        try {
          const parser = entry.factory();
          this._parsers.push({ parser, enabled: true });
        } catch (e) {
          console.warn('[ParserRegistry] Failed to create parser:', e);
        }
      }
    }
  }
  
  /**
   * Find the parser that matches the current URL
   * @param {string} [url] - URL to check (defaults to current page)
   * @returns {BaseParser|null} Matching parser or null
   */
  findParser(url = window.location.href) {
    const hostname = new URL(url).hostname;
    
    for (const { parser, enabled } of this._parsers) {
      if (enabled && parser.matches(hostname)) {
        return parser;
      }
    }
    
    return null;
  }
  
  /**
   * Get all registered parsers
   * @returns {BaseParser[]}
   */
  getAllParsers() {
    return this._parsers.map(({ parser }) => parser);
  }
  
  /**
   * Get all supported site names
   * @returns {string[]}
   */
  getSupportedSites() {
    return this._parsers
      .filter(({ enabled }) => enabled)
      .map(({ parser }) => parser.getSiteName());
  }
  
  /**
   * Check if a site is supported
   * @param {string} hostname
   * @returns {boolean}
   */
  isSiteSupported(hostname) {
    return this._parsers.some(
      ({ parser, enabled }) => enabled && parser.matches(hostname)
    );
  }
  
  /**
   * Enable a parser by site type
   * @param {string} siteType
   */
  enableParser(siteType) {
    for (const entry of this._parsers) {
      if (entry.parser.getSiteType() === siteType) {
        entry.enabled = true;
        break;
      }
    }
  }
  
  /**
   * Disable a parser by site type
   * @param {string} siteType
   */
  disableParser(siteType) {
    for (const entry of this._parsers) {
      if (entry.parser.getSiteType() === siteType) {
        entry.enabled = false;
        break;
      }
    }
  }
}

// Export for use in other modules
window.ParserRegistry = ParserRegistry;
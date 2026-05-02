/**
 * @fileoverview Base Parser Interface
 * 
 * All site-specific parsers must extend this class and implement
 * the required methods. This provides a consistent interface for
 * the main BooruParser to interact with any site parser.
 * 
 * @module parsers/base-parser
 */

/**
 * @typedef {Object} ImageDimensions
 * @property {number} width - Image width in pixels
 * @property {number} height - Image height in pixels
 */

/**
 * @typedef {Object} ParsedData
 * @property {string} site - Site display name (e.g., "Sankaku Complex")
 * @property {string} siteType - Site type identifier (e.g., "sankaku_complex")
 * @property {string|null} imageUrl - Original/high-res image URL
 * @property {string[]} tags - Normalized array of tags
 * @property {ImageDimensions} dimensions - Image dimensions {width, height}
 * @property {string|null} postId - Post ID from URL or page
 * @property {string|null} sourceUrl - Source URL (pixiv, twitter, etc.) or null
 * @property {string|null} rating - Rating: 'sfw', 'questionable', or 'explicit'
 * @property {string|null} annotation - Notes/annotations for Eagle (e.g., rule34 notes)
 * @property {string} pageUrl - Full page URL
 */

/**
 * @typedef {Object} PreloadResult
 * @property {boolean} success - Whether preload succeeded
 * @property {string} [base64] - Base64 data URL (data:image/xxx;base64,...)
 * @property {string} [mimeType] - MIME type of the image
 * @property {string} [error] - Error message if failed
 */

/**
 * Base parser class - all site parsers must extend this
 * 
 * Required methods to implement:
 * - matches(url) - Check if this parser handles the given URL
 * - isPostPage() - Check if we're on a post/image page
 * - getImageUrl() - Get the original/high-res image URL
 * - getTags() - Get normalized tags from the page
 * - getPostId() - Get the post ID
 * 
 * Optional methods:
 * - getSiteName() - Get display name (defaults to 'Unknown')
 * - getImageDimensions() - Get image dimensions (defaults to 0x0)
 * - getSourceUrl() - Get source URL (defaults to null)
 */
class BaseParser {
  /**
   * Check if this parser handles the given URL/hostname
   * @param {string} url - The full URL or hostname
   * @returns {boolean}
   */
  matches(url) {
    throw new Error('matches() must be implemented');
  }

  /**
   * Get site display name
   * @returns {string}
   */
  getSiteName() {
    return 'Unknown';
  }

  /**
   * Get site type identifier (lowercase, no spaces)
   * @returns {string}
   */
  getSiteType() {
    return this.getSiteName().toLowerCase().replace(/\s+/g, '_');
  }

  /**
   * Check if we're on a post/image page
   * @returns {boolean}
   */
  isPostPage() {
    throw new Error('isPostPage() must be implemented');
  }

  /**
   * Get the original/high-res image URL
   * @returns {string|null}
   */
  getImageUrl() {
    throw new Error('getImageUrl() must be implemented');
  }

  /**
   * Get raw tags from the page (before normalization)
   * @returns {string[]}
   */
  getRawTags() {
    throw new Error('getRawTags() must be implemented');
  }

  /**
   * Get normalized tags (lowercase, no underscores)
   * By default, preserves artist: prefix but removes other category prefixes.
   * Override this method if you need different behavior.
   * @returns {string[]}
   */
  getTags() {
    const rawTags = this.getRawTags();
    return this.normalizeTags(rawTags);
  }

  /**
   * Normalize tags - shared implementation for all parsers
   * Preserves artist: prefix, removes other category prefixes (copyright:, character:, etc.)
   * @param {string[]} tags - Raw tags
   * @returns {string[]}
   */
  normalizeTags(tags) {
    const prefixesToRemove = [
      'copyright:', 'character:', 
      'general:', 'meta:', 'species:', 'rating:'
    ];
    
    return tags
      .map(tag => {
        let normalized = tag.toLowerCase();
        
        // Remove category prefixes EXCEPT artist:
        for (const prefix of prefixesToRemove) {
          if (normalized.startsWith(prefix)) {
            normalized = normalized.substring(prefix.length);
            break;
          }
        }
        
        // Replace underscores with spaces
        normalized = normalized.replace(/_/g, ' ');
        
        return normalized.trim();
      })
      .filter(tag => tag.length > 0);
  }

  /**
   * Get post ID from URL or page
   * @returns {string|null}
   */
  getPostId() {
    throw new Error('getPostId() must be implemented');
  }

  /**
   * Get image dimensions
   * @returns {{width: number, height: number}}
   */
  getImageDimensions() {
    // Try og:image meta tags first
    const metaWidth = document.querySelector('meta[property="og:image:width"]');
    const metaHeight = document.querySelector('meta[property="og:image:height"]');
    if (metaWidth && metaHeight) {
      return {
        width: parseInt(metaWidth.content, 10) || 0,
        height: parseInt(metaHeight.content, 10) || 0
      };
    }
    
    // Try the image element
    const image = document.querySelector('#image, .image, img#image');
    if (image) {
      return {
        width: image.naturalWidth || image.width || 0,
        height: image.naturalHeight || image.height || 0
      };
    }
    
    return { width: 0, height: 0 };
  }

  /**
   * Get rating from the page
   * Override this method in site-specific parsers
   * @returns {string|null} - 'sfw', 'questionable', or 'explicit'
   */
  getRating() {
    return null;
  }

  /**
   * Get source URL if available
   * @returns {string|null}
   */
  getSourceUrl() {
    // Try to find source link (pixiv, twitter, etc.)
    const sourceSelectors = [
      'a[href*="pixiv.net"]',
      'a[href*="twitter.com"]',
      'a[href*="x.com"]',
      'a[href*="fanbox.cc"]',
      'a[href*="skeb.co"]',
      '#source-url a',
      '.source-link a'
    ];

    for (const selector of sourceSelectors) {
      const link = document.querySelector(selector);
      if (link && link.href && link.href.startsWith('http')) {
        return link.href;
      }
    }

    return null;
  }

  /**
   * Get notes from the page (image annotations)
   * Override in site-specific parsers (e.g., Rule34Parser)
   * @returns {Promise<Array<{x: number, y: number, width: number, height: number, body: string}>>}
   */
  async getNotes() {
    return [];
  }

  /**
   * Parse all data from the current page
   * @returns {Object|null} Parsed data or null if not on a post page
   */
  parse() {
    if (!this.isPostPage()) {
      return null;
    }

    const imageUrl = this.getImageUrl();
    const tags = this.getTags();
    const dimensions = this.getImageDimensions();
    const postId = this.getPostId();
    const sourceUrl = this.getSourceUrl();
    const rating = this.getRating();

    // Build final tags array - add rating tag if found
    const finalTags = [...tags];
    if (rating) {
      finalTags.push(`rating:${rating}`);
    }

    // Debug: log artist tags
    const artistTags = finalTags.filter(t => t.startsWith('artist:'));
    console.log(`[${this.getSiteName()}] parse(): ${finalTags.length} total tags, ${artistTags.length} artist tags`, artistTags);

    return {
      site: this.getSiteName(),
      siteType: this.getSiteType(),
      imageUrl,
      tags: finalTags,
      dimensions,
      postId,
      sourceUrl,
      rating,
      pageUrl: window.location.href
    };
  }
}

// Export for use in other modules
window.BaseParser = BaseParser;
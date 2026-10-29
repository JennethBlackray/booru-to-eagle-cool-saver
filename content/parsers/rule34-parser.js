/**
 * @fileoverview Rule34.xxx Parser
 * 
 * Parses images and tags from rule34.xxx
 * 
 * Site structure notes:
 * - Post pages: ?page=post&s=view&id={id}
 * - Image URL: og:image meta > "Original image" link > #image element
 * - Tags: #tag-sidebar li.tag > a[href*="tags="] (SECOND anchor, first is wiki link)
 * - Each li has: <a href="wiki">?</a> <a href="?tags=xxx">tag name</a> <span class="tag-count">N</span>
 * 
 * @module parsers/rule34
 */
class Rule34Parser extends BaseParser {
  /**
   * Check if this parser handles rule34.xxx
   */
  matches(hostname) {
    return hostname.includes('rule34.xxx');
  }
  /**
   * Check if current page is a 429 rate limiting page
   * @static
   * @returns {boolean}
   */
  static isRateLimited() {
    const title = document.title.toLowerCase();
    return title.includes('429') && title.includes('rate limit');
  }
  /**
   * Check if current page is a Cloudflare CAPTCHA challenge page
   * @static
   * @returns {boolean}
   */
  static isCaptchaPage() {
    const title = (document.title || '').toLowerCase();
    // Russian: "Один момент…", English: "One moment…" / "Just a moment..."
    if (
      title.includes('один момент') ||
      title.includes('one moment') ||
      title.includes('just a moment') ||
      title.includes('attention required')
    ) {
      return true;
    }
    if (!document.querySelector('#image, #tag-sidebar')) {
      return !!document.querySelector(
        '#challenge-running, #challenge-stage, #cf-chl-widget, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]'
      );
    }
    return false;
  }
  /**
   * Check if current page is blocked (429 or CAPTCHA)
   * @static
   * @returns {string|null} 'rate_limit' | 'captcha' | null
   */
  static getBlockerType() {
    if (this.isRateLimited()) return 'rate_limit';
    if (this.isCaptchaPage()) return 'captcha';
    return null;
  }
  /**
   * Check if the Cloudflare CAPTCHA has been solved (success state)
   * @static
   * @returns {boolean}
   */
  static isCaptchaSolved() {
    // After solving, the page should redirect/reload to the actual content
    // Check if the blocker is no longer present
    if (!this.isCaptchaPage()) return true;
    // Check for turnstile success response
    const responseInput = document.querySelector('input[name="cf-turnstile-response"]');
    return !!(responseInput && responseInput.value);
  }
  /**
   * Wait for a blocked page to resolve (CAPTCHA solved or redirect happens)
   * @static
   * @param {number} [timeout=120000] - Maximum time to wait in ms
   * @returns {Promise<boolean>} True if page became ready
   */
  static waitForPageReady(timeout = RULE34_CONFIG.PAGE_WAIT_TIMEOUT) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      
      const check = () => {
        const blocker = this.getBlockerType();
        if (!blocker) {
          // Page is no longer blocked - it's ready
          resolve(true);
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          resolve(false);
          return;
        }
        
        setTimeout(check, RULE34_CONFIG.PAGE_CHECK_INTERVAL);
      };
      
      // Small initial delay to let the page stabilize
      setTimeout(check, 500);
    });
  }
  /**
   * Get site display name
   */
  getSiteName() {
    return 'Rule34.xxx';
  }
  /**
   * Check if we're on a post page
   * Pattern: ?page=post&s=view&id={id}
   */
  isPostPage() {
    const params = new URLSearchParams(window.location.search);
    return params.get('page') === 'post' && params.get('s') === 'view';
  }
  /**
   * Get original image URL
   * Priority: og:image meta > "Original image" link > #image element
   * 
   * The #image element is the SAMPLE (resized), not the original!
   */
  /**
   * Normalize Rule34 image URL to use api-cdn.rule34.xxx.
   * - Replaces wimg.rule34.xxx / us.rule34.xxx with api-cdn.rule34.xxx
   *   (wimg is protected by Cloudflare Turnstile challenge yielding 403,
   *    while api-cdn is the open CDN endpoint that serves binaries directly).
   * - Cleans up Rule34 double slashes (e.g. wimg.rule34.xxx//images/).
   * - Strips extraneous query strings like ?postId.
   */
  normalizeImageUrl(rawUrl) {
    if (!rawUrl) return null;
    let url = rawUrl;
    // Fix double slashes in path
    url = url.replace(/([^:])\/\/+/g, '$1/');
    // Switch to api-cdn.rule34.xxx
    url = url.replace(/https?:\/\/[^\/]*rule34\.xxx/i, 'https://api-cdn.rule34.xxx');
    // Strip query parameters
    try {
      const u = new URL(url);
      u.search = '';
      url = u.toString();
    } catch (e) {}
    return url;
  }
  getImageUrl() {
    let url = null;
    // Try og:image meta tag first (most reliable for original)
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage && ogImage.content) {
      url = ogImage.content;
    }
    
    // Try "Original image" link
    if (!url) {
      const originalLink = document.querySelector('a[onclick*="Post.highres"]');
      if (originalLink && originalLink.href) {
        url = originalLink.href;
      }
    }
    
    // Fallback: try any link to /images/ that is NOT in /samples/
    if (!url) {
      const allLinks = document.querySelectorAll('a[href*="/images/"]');
      for (const link of allLinks) {
        if (link.href && !link.href.includes('/samples/')) {
          url = link.href;
          break;
        }
      }
    }
    
    // Last resort: #image element (this is the sample, not original)
    if (!url) {
      const image = document.querySelector('#image');
      if (image && image.src) {
        url = image.src.replace('/samples/', '/images/').replace('sample_', '').replace('.jpg', '.png');
      }
    }
    
    return this.normalizeImageUrl(url);
  }
  /**
   * Get raw tags from the page with category prefixes
   * 
   * Structure of each tag item:
   * <li class="tag-type-{type} tag">
   *   <a href="wiki?search=xxx">?</a>        <- FIRST anchor (wiki link, skip)
   *   <a href="?tags=xxx">tag name</a>       <- SECOND anchor (actual tag, use this)
   *   <span class="tag-count">12345</span>   <- count (skip)
   * </li>
   * 
   * Tag types: copyright, character, general, artist, meta
   * 
   * Artist tags are prefixed with "artist:" for Eagle
   */
  getRawTags() {
    const tags = [];
    
    // Get all tag list items
    const tagItems = document.querySelectorAll('#tag-sidebar li.tag');
    
    tagItems.forEach(item => {
      // Determine tag type from CSS class
      let tagType = 'general'; // default
      if (item.classList.contains('tag-type-artist')) {
        tagType = 'artist';
      } else if (item.classList.contains('tag-type-copyright')) {
        tagType = 'copyright';
      } else if (item.classList.contains('tag-type-character')) {
        tagType = 'character';
      } else if (item.classList.contains('tag-type-meta')) {
        tagType = 'meta';
      }
      
      // Get all anchor links within this tag item
      const anchors = item.querySelectorAll('a[href*="tags="]');
      
      // The LAST anchor is the actual tag link (first is wiki link)
      if (anchors.length > 0) {
        const tagAnchor = anchors[anchors.length - 1];
        let tag = tagAnchor.textContent.trim();
        
        if (tag && tag !== '?' && !/^\d+$/.test(tag)) {
          tag = tag.replace(/\s+/g, '_');
          
          // Prefix artist tags with "artist:"
          if (tagType === 'artist') {
            tag = `artist:${tag}`;
          }
          
          tags.push(tag);
        }
      }
    });
    
    return [...new Set(tags)];
  }
  /**
   * Get normalized tags, preserving artist: prefix
   */
  getTags() {
    const rawTags = this.getRawTags();
    return this.normalizeTags(rawTags);
  }
  /**
   * Get post ID from URL
   */
  getPostId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('id');
  }
  /**
   * Get image dimensions
   * Rule34 has dimensions in #stats: "Size: 1120x955"
   * Also og:image:width/og:image:height meta tags
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
    
    // Try #stats "Size: WxH" text
    const statsEl = document.querySelector('#stats li');
    if (statsEl) {
      const allStats = document.querySelectorAll('#stats li');
      for (const stat of allStats) {
        const text = stat.textContent.trim();
        if (text.startsWith('Size:')) {
          const match = text.match(/Size:\s*(\d+)x(\d+)/);
          if (match) {
            return {
              width: parseInt(match[1], 10),
              height: parseInt(match[2], 10)
            };
          }
        }
      }
    }
    
    // Fallback to base implementation
    return super.getImageDimensions();
  }
  /**
   * Get rating from the page
   * Rule34 ratings: Questionable = questionable, Explicit = explicit
   * Found in #stats as "Rating: Questionable" or "Rating: Explicit"
   */
  getRating() {
    // Check #stats for rating
    const statsItems = document.querySelectorAll('#stats li');
    for (const item of statsItems) {
      const text = item.textContent.trim();
      if (text.startsWith('Rating:')) {
        const rating = text.replace('Rating:', '').trim().toLowerCase();
        if (rating === 'questionable') return 'questionable';
        if (rating === 'explicit') return 'explicit';
      }
    }
    // Fallback: check for rating in the page meta or hidden elements
    const ratingMeta = document.querySelector('meta[name="rating"]');
    if (ratingMeta) {
      const content = ratingMeta.content.toLowerCase();
      if (content.includes('questionable')) return 'questionable';
      if (content.includes('explicit')) return 'explicit';
    }
    return null;
  }
  /**
   * Get source URL
   * Rule34 has source in #stats: "Source: <a href="...">...</a>"
   */
  getSourceUrl() {
    const statsItems = document.querySelectorAll('#stats li');
    for (const item of statsItems) {
      const text = item.textContent.trim();
      if (text.startsWith('Source:')) {
        const link = item.querySelector('a[href^="http"]');
        if (link && link.href) {
          return link.href;
        }
      }
    }
    return super.getSourceUrl();
  }
  /**
   * Get notes from the page (image annotations)
   * Extracts note data directly from the live DOM to avoid duplicate HTTP requests
   * that trigger 429 rate limiting on rule34.xxx.
   * @returns {Promise<Array<{x: number, y: number, width: number, height: number, body: string}>>}
   */
  async getNotes() {
    // Check if note parsing is enabled in settings
    if (typeof window.extensionSettings !== 'undefined' && !window.extensionSettings.parseNotes) {
      return [];
    }
    const postId = this.getPostId();
    if (!postId) return [];
    // Cache to prevent duplicate work within a short timeframe
    const now = Date.now();
    if (this._lastNotesFetchId === postId && this._lastNotesResult && (now - this._lastNotesFetchTime < 10000)) {
      return this._lastNotesResult;
    }
    const notes = [];
    const noteBodyElements = document.querySelectorAll('.note-body[id^="note-body-"], #note-container .note-body');
    noteBodyElements.forEach(bodyEl => {
      const idAttr = bodyEl.id || '';
      const idMatch = idAttr.match(/note-body-(\d+)/);
      const noteId = idMatch ? idMatch[1] : null;
      let body = bodyEl.innerHTML || '';
      body = body.replace(/<br\s*\/?>/gi, '\n')
                 .replace(/<[^>]*>?/gm, '')
                 .replace(/&nbsp;/g, ' ')
                 .replace(/&#039;/g, "'")
                 .replace(/&amp;/g, '&')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/&quot;/g, '"')
                 .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
                 .trim();
      if (!body) return;
      let x = 0, y = 0, width = 0, height = 0;
      if (noteId) {
        const boxEl = document.getElementById(`note-box-${noteId}`);
        if (boxEl && boxEl.style) {
          x = parseInt(boxEl.style.left, 10) || 0;
          y = parseInt(boxEl.style.top, 10) || 0;
          width = parseInt(boxEl.style.width, 10) || 0;
          height = parseInt(boxEl.style.height, 10) || 0;
        }
      }
      notes.push({ x, y, width, height, body });
    });
    this._lastNotesFetchId = postId;
    this._lastNotesFetchTime = now;
    this._lastNotesResult = notes;
    return notes;
  }
  /**
   * Format notes array into plain text for Eagle annotation
   * Notes are separated with a clear visual divider
   * @param {Array<{x: number, y: number, width: number, height: number, body: string}>} notes
   * @returns {string|null}
   */
  _formatNotesForEagle(notes) {
    if (!notes || notes.length === 0) return null;
    if (notes.length === 1) {
      return notes[0].body;
    }
    // Multiple notes: separated by numbered headers and divider lines
    return notes.map((note, index) =>
      `--- Note ${index + 1} ---\n${note.body}`
    ).join('\n\n');
  }
  /**
   * Parse all data from the current page, including notes (async)
   * @returns {Promise<Object|null>} Parsed data or null if not on a post page
   */
  async parse() {
    if (!this.isPostPage()) {
      return null;
    }
    const imageUrl = this.getImageUrl();
    const tags = this.getTags();
    const dimensions = this.getImageDimensions();
    const postId = this.getPostId();
    const sourceUrl = this.getSourceUrl();
    const rating = this.getRating();
    const notes = await this.getNotes();
    // Build final tags array - add rating tag if found
    const finalTags = [...tags];
    if (rating) {
      finalTags.push(`rating:${rating}`);
    }
    // Format notes for Eagle annotation
    let annotation = null;
    if (notes.length > 0) {
      annotation = this._formatNotesForEagle(notes);
    }
    // Debug: log artist tags
    const artistTags = finalTags.filter(t => t.startsWith('artist:'));
    console.log(`[${this.getSiteName()}] parse(): ${finalTags.length} total tags, ${artistTags.length} artist tags, ${notes.length} notes`);
    return {
      site: this.getSiteName(),
      siteType: this.getSiteType(),
      imageUrl,
      tags: finalTags,
      dimensions,
      postId,
      sourceUrl,
      rating,
      annotation,
      pageUrl: window.location.href
    };
  }
}
// Export
window.Rule34Parser = Rule34Parser;

/**
 * @fileoverview Yande.re Parser
 * 
 * Parses images and tags from yande.re
 * Uses the same Moebooru engine as konachan.com
 * 
 * Site structure notes:
 * - Post pages: /post/show/{id}
 * - Main pages: /post?tags=...
 * - Image URL: Post.register_resp JSON data (file_url)
 * - Tags: #tag-sidebar li.tag-link[data-name]
 * - Dimensions: register_resp width/height
 * - Rating: register_resp rating (s/q/e)
 * 
 * @module parsers/yandere
 */

class YandeReParser extends BaseParser {
  /**
   * Check if this parser handles yande.re
   */
  matches(hostname) {
    return hostname.includes('yande.re');
  }

  /**
   * Get site display name
   */
  getSiteName() {
    return 'Yande.re';
  }

  /**
   * Check if we're on a post page
   * Pattern: /post/show/{id}
   */
  isPostPage() {
    return /\/post\/show\/\d+/.test(window.location.pathname);
  }

  /**
   * Parse Post JSON data from script tags
   * yande.re may use Post.register_resp, Post.register, or other function names
   * Content scripts CAN read script tag textContent, just not JS variables
   * @returns {Object|null}
   */
  _getRegisterData() {
    // Check cache first
    if (window._yandereRegisterData !== undefined) {
      return window._yandereRegisterData;
    }
    
    const scripts = document.querySelectorAll('script');
    
    // Try multiple function names that yande.re might use
    const functionNames = [
      'Post.register_resp(',
      'Post.register(',
      'Post.show('
    ];
    
    for (const script of scripts) {
      const text = script.textContent;
      if (!text) continue;
      
      // Find which function name is used
      let funcName = null;
      let startIdx = -1;
      for (const fn of functionNames) {
        const idx = text.indexOf(fn);
        if (idx !== -1) {
          funcName = fn;
          startIdx = idx;
          break;
        }
      }
      
      if (!funcName || startIdx === -1) continue;
      
      // Find the opening brace
      const braceIdx = text.indexOf('{', startIdx);
      if (braceIdx === -1) continue;
      
      // Brace counting
      const jsonStart = braceIdx;
      let braceCount = 1;
      let inString = false;
      let escapeNext = false;
      
      for (let i = jsonStart + 1; i < text.length; i++) {
        const char = text[i];
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{') braceCount++;
          else if (char === '}') {
            braceCount--;
            if (braceCount === 0) {
              const jsonStr = text.substring(jsonStart, i + 1);
              try {
                const data = JSON.parse(jsonStr);
                console.log('[Yande.re] Parsed register data:', Object.keys(data));
                window._yandereRegisterData = data; // Cache
                return data;
              } catch (e) {
                console.warn('[Yande.re] JSON parse error:', e);
              }
              break;
            }
          }
        }
      }
    }
    
    console.log('[Yande.re] No register data found in scripts');
    window._yandereRegisterData = null;
    return null;
  }

  /**
   * Get original image URL
   * Priority: register_resp file_url > sidebar PNG link > #image > og:image
   * 
   * yande.re shows a resized sample by default. The real original is in
   * the Post.register_resp JSON data as file_url (full resolution).
   */
  getImageUrl() {
    // 1. Parse register_resp data for file_url (best - original)
    const data = this._getRegisterData();
    if (data && data.posts && data.posts[0]) {
      const fileUrl = data.posts[0].file_url;
      if (fileUrl) return fileUrl;
    }
    
    // 2. Try sidebar "Download PNG" link (original full resolution)
    const pngLink = document.querySelector('#png, a[href*="/image/"]');
    if (pngLink && pngLink.href) return pngLink.href;
    
    // 3. Try "Download larger version" JPG link
    const jpgLink = document.querySelector('#highres, a[href*="/jpeg/"]');
    if (jpgLink && jpgLink.href) return jpgLink.href;
    
    // 4. Try the main image element (may be sample/resized)
    const image = document.querySelector('#image');
    if (image && image.src) return image.src;
    
    // 5. Try og:image meta tag
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) return ogImage.content;
    
    return null;
  }

  /**
   * Get raw tags from the page
   * Uses register_resp data which includes tag types (artist, copyright, etc.)
   * Falls back to sidebar elements, then page title, then edit form
   */
  getRawTags() {
    const tags = [];

    // Best: use register_resp data which has tag types
    const data = this._getRegisterData();
    if (data && data.tags) {
      // yande.re tags can be an array of tag names OR an object like {"tag_name": "type"}
      if (Array.isArray(data.tags)) {
        // Array of tag names — we can't determine types, so just add them all
        for (const tagName of data.tags) {
          if (tagName) tags.push(tagName);
        }
      } else if (typeof data.tags === 'object') {
        // Object like {"tag_name": "type", ...}
        for (const [tagName, tagType] of Object.entries(data.tags)) {
          if (tagType === 'artist') {
            tags.push('artist:' + tagName);
          } else {
            tags.push(tagName);
          }
        }
      }
      return [...new Set(tags)];
    }

    // Fallback 1: use sidebar elements
    const tagSelectors = [
      '#tag-sidebar li.tag-link[data-name]',
      '#tag-sidebar li[data-name]',
      '#tag-sidebar li a[href*="tags="]',
      '.tag-list li[data-name]',
      '.tag-list a.tag',
      '#sidebar li a[href*="tags="]'
    ];

    for (const selector of tagSelectors) {
      const tagItems = document.querySelectorAll(selector);
      if (tagItems.length > 0) {
        tagItems.forEach(item => {
          let tagName = item.getAttribute('data-name') ||
                        item.getAttribute('title') ||
                        item.textContent?.trim();
          const tagType = item.getAttribute('data-type') ||
                          item.className?.match(/tag-type-(\w+)/)?.[1];

          if (tagName && tagName.trim()) {
            // Clean up tag name
            tagName = tagName.trim().replace(/\s+/g, '_');
            if (tagType === 'artist') {
              tagName = 'artist:' + tagName;
            }
            tags.push(tagName);
          }
        });
        if (tags.length > 0) {
          return [...new Set(tags)];
        }
      }
    }

    // Fallback 2: parse tags from page title
    // Title format: "tag1 tag2 tag3 artist_name | yande.re"
    const title = document.title;
    if (title) {
      const titleMatch = title.match(/^(.+?)\s*\|/);
      if (titleMatch) {
        const titleTags = titleMatch[1].trim().split(/\s+/);
        if (titleTags.length > 0) {
          return titleTags.map(t => t.replace(/\s+/g, '_'));
        }
      }
    }

    // Fallback 3: try to get tags from edit form textarea
    const editTextarea = document.querySelector('#edit textarea[name*="tags"], textarea#post_tags');
    if (editTextarea && editTextarea.value) {
      return editTextarea.value.trim().split(/\s+/).map(t => t.replace(/\s+/g, '_'));
    }

    // Fallback 4: try to get tags from og:description meta
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc && ogDesc.content) {
      return ogDesc.content.trim().split(/\s+/).map(t => t.replace(/\s+/g, '_'));
    }

    return [];
  }

  /**
   * Get post ID from URL
   */
  getPostId() {
    const match = window.location.pathname.match(/\/post\/show\/([^/?]+)/);
    return match ? match[1] : null;
  }

  /**
   * Get rating from the page
   * yande.re ratings: Safe = sfw, Questionable = questionable, Explicit = explicit
   * Found in register_resp data or sidebar
   */
  getRating() {
    // Best: use register_resp data
    const data = this._getRegisterData();
    if (data && data.posts && data.posts[0]) {
      const rating = data.posts[0].rating;
      if (rating === 's' || rating === 'safe') return 'sfw';
      if (rating === 'q' || rating === 'questionable') return 'questionable';
      if (rating === 'e' || rating === 'explicit') return 'explicit';
    }

    // Fallback: check sidebar for rating text
    const statsEl = document.querySelector('#stats');
    if (statsEl) {
      const text = statsEl.textContent.toLowerCase();
      if (text.includes('rating: safe')) return 'sfw';
      if (text.includes('rating: questionable')) return 'questionable';
      if (text.includes('rating: explicit')) return 'explicit';
    }

    return null;
  }

  /**
   * Get image dimensions
   * Priority: register_resp width/height > data attributes > base implementation
   * 
   * Important: #image element shows the sample (resized), so naturalWidth/height
   * gives sample dimensions, not original. We must use register_resp data.
   */
  getImageDimensions() {
    // Best: use register_resp data (original dimensions)
    const data = this._getRegisterData();
    if (data && data.posts && data.posts[0]) {
      const post = data.posts[0];
      if (post.width && post.height) {
        return {
          width: post.width,
          height: post.height
        };
      }
    }
    
    // Fallback: try data attributes on image container
    const imageContainer = document.querySelector('#image');
    if (imageContainer) {
      const width = imageContainer.getAttribute('large_width') || 
                    imageContainer.getAttribute('data-file-width');
      const height = imageContainer.getAttribute('large_height') || 
                     imageContainer.getAttribute('data-file-height');
      if (width && height) {
        return {
          width: parseInt(width, 10) || 0,
          height: parseInt(height, 10) || 0
        };
      }
    }
    
    // Last fallback: base implementation
    return super.getImageDimensions();
  }
}

// Export
window.YandeReParser = YandeReParser;
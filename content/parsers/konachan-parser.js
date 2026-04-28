/**
 * @fileoverview Konachan Parser
 * 
 * Parses images and tags from konachan.com
 * 
 * Site structure notes:
 * - Post pages: /post/show/{id}
 * - Image URL: #image element src or /original/ link
 * - Tags: #tag-sidebar li.tag-link[data-name] (data-name has canonical names)
 * - Dimensions: data attributes on image container
 * 
 * @module parsers/konachan
 */

class KonachanParser extends BaseParser {
  /**
   * Check if this parser handles konachan.com
   */
  matches(hostname) {
    return hostname.includes('konachan');
  }

  /**
   * Get site display name
   */
  getSiteName() {
    return 'Konachan';
  }

  /**
   * Check if we're on a post page
   * Pattern: /post/show/{id}
   */
  isPostPage() {
    return /\/post\/show\/\d+/.test(window.location.pathname);
  }

  /**
   * Parse Post.register_resp JSON data from script tags
   * Content scripts CAN read script tag textContent, just not JS variables
   * @returns {Object|null}
   */
  _getRegisterData() {
    // Check cache first
    if (window._konachanRegisterData !== undefined) {
      return window._konachanRegisterData;
    }
    
    const scripts = document.querySelectorAll('script');
    
    for (const script of scripts) {
      const text = script.textContent;
      if (!text || !text.includes('Post.register_resp(')) continue;
      
      const startIdx = text.indexOf('Post.register_resp({');
      if (startIdx === -1) continue;
      
      // Brace counting
      const jsonStart = startIdx + 'Post.register_resp('.length;
      let braceCount = 1;
      let inString = false;
      let escapeNext = false;
      
      for (let i = jsonStart; i < text.length; i++) {
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
                window._konachanRegisterData = data; // Cache
                return data;
              } catch (e) {
                console.warn('[Konachan] JSON parse error:', e);
              }
              break;
            }
          }
        }
      }
    }
    
    window._konachanRegisterData = null;
    return null;
  }

  /**
   * Get original image URL
   * Priority: register_resp file_url > sidebar PNG link > #image > og:image
   * 
   * Konachan shows a resized sample by default. The real original is in
   * the Post.register_resp JSON data as file_url (full resolution PNG).
   */
  getImageUrl() {
    // 1. Parse register_resp data for file_url (best - original PNG)
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
   * Falls back to sidebar elements if register data is unavailable
   */
  getRawTags() {
    const tags = [];

    // Best: use register_resp data which has tag types
    const data = this._getRegisterData();
    if (data && data.tags) {
      // data.tags is an object like {"tag_name": "type", ...}
      for (const [tagName, tagType] of Object.entries(data.tags)) {
        if (tagType === 'artist') {
          tags.push('artist:' + tagName);
        } else {
          tags.push(tagName);
        }
      }
      return [...new Set(tags)];
    }

    // Fallback: use sidebar elements
    const tagItems = document.querySelectorAll('#tag-sidebar li.tag-link[data-name]');

    tagItems.forEach(item => {
      let tagName = item.getAttribute('data-name');
      const tagType = item.getAttribute('data-type');

      if (tagName && tagName.trim()) {
        if (tagType === 'artist') {
          tagName = 'artist:' + tagName.trim();
        }
        tags.push(tagName.trim());
      }
    });

    return [...new Set(tags)];
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
   * Konachan ratings: Safe = sfw, Questionable = questionable, Explicit = explicit
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
window.KonachanParser = KonachanParser;
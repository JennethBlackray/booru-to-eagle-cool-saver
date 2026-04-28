/**
 * @fileoverview Sankaku Complex (Modern) Parser
 * 
 * Parses images and tags from www.sankakucomplex.com
 * This site uses a React-based SPA architecture.
 * 
 * @module parsers/sankaku-complex
 */

class SankakuComplexParser extends BaseParser {
  /**
   * Check if this parser handles www.sankakucomplex.com
   */
  matches(hostname) {
    return hostname === 'www.sankakucomplex.com';
  }

  /**
   * Get site display name
   */
  getSiteName() {
    return 'Sankaku Complex';
  }

  /**
   * Check if we're on a post page
   * Pattern: /posts/{id}
   */
  isPostPage() {
    return /\/posts\/[^/?]+/.test(window.location.pathname);
  }

  /**
   * Get original image URL
   * 
   * Strategy:
   * 1. Try to find the image URL in the window.__PRELOADED_STATE__ (most reliable for original)
   * 2. Try to find the image URL in meta tags (og:image as fallback)
   */
  getImageUrl() {
    // 1. Try to parse from preloaded state
    try {
      if (window.__PRELOADED_STATE__) {
        const state = window.__PRELOADED_STATE__;
        let fileUrl = null;
        
        const findFileUrl = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          if (obj.file_url) {
            fileUrl = obj.file_url;
            return;
          }
          if (obj.fileUrl) {
            fileUrl = obj.fileUrl;
            return;
          }
          // In some cases it might be in an image object
          if (obj.image && (obj.image.file_url || obj.image.fileUrl)) {
            fileUrl = obj.image.file_url || obj.image.fileUrl;
            return;
          }
          
          for (const key in obj) {
            if (fileUrl) break;
            if (typeof obj[key] === 'object') findFileUrl(obj[key]);
          }
        };
        findFileUrl(state);
        
        if (fileUrl) {
          console.log('[SankakuComplexParser] Found image from state:', fileUrl);
          return fileUrl;
        }
      }
    } catch (e) {
      console.warn('[SankakuComplexParser] Error parsing state for image URL:', e);
    }

    // 2. Try og:image meta tag
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage && ogImage.content) {
      console.log('[SankakuComplexParser] Found image from og:image:', ogImage.content);
      return ogImage.content;
    }

    // 3. Try to find highres link if it exists
    const highres = document.querySelector('a[href*="sankakucomplex.com/data/"]');
    if (highres) {
       console.log('[SankakuComplexParser] Found image from link:', highres.href);
       return highres.href;
    }

    return null;
  }

  /**
   * Get raw tags from the page
   * 
   * Strategy:
   * Since the sidebar is obfuscated, we use window.__PRELOADED_STATE__ if available.
   * Otherwise fall back to meta tags or title.
   */
  getRawTags() {
    let tags = [];

    // 1. Try to parse from preloaded state
    try {
      if (window.__PRELOADED_STATE__ && window.__PRELOADED_STATE__.initialI18nStore) {
        // In the provided example, the tags are actually in the meta title within the state
        // but we'll also search for a tags array if it exists in a more complete state
        const state = window.__PRELOADED_STATE__;
        
        // Search through the state object for anything that looks like a tag list
        // This is a bit of a deep dive but safer than obfuscated DOM
        const findTags = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj.tags)) {
            obj.tags.forEach(t => {
              if (typeof t === 'string') tags.push(t);
              else if (t && t.tagName) tags.push(t.tagName);
              else if (t && t.name) tags.push(t.name);
            });
          }
          for (const key in obj) {
            if (tags.length > 0) break;
            if (typeof obj[key] === 'object') findTags(obj[key]);
          }
        };
        findTags(state);
      }
    } catch (e) {
      console.warn('[SankakuComplexParser] Error parsing state for tags:', e);
    }

    if (tags.length === 0) {
      // 2. Try parsing from twitter:title or title which usually contains tags
      const titleMeta = document.querySelector('meta[property="twitter:title"]');
      const titleText = titleMeta ? titleMeta.content : document.title;
      
      if (titleText) {
        // Sankaku titles are usually "Tag1 Tag2 Tag3 | Sankaku Complex"
        const cleanTitle = titleText.split('|')[0].trim();
        if (cleanTitle) {
          tags = cleanTitle.split(/\s+/).map(t => t.trim()).filter(t => t.length > 0);
        }
      }
    }

    // Sankaku uses spaces in tags in the title, but boorus usually use underscores
    tags = tags.map(t => t.replace(/\s+/g, '_'));
    
    console.log('[SankakuComplexParser] Extracted tags:', tags);
    return [...new Set(tags)];
  }

  /**
   * Get post ID from page
   */
  getPostId() {
    const match = window.location.pathname.match(/\/posts\/([^/?]+)/);
    return match ? match[1] : null;
  }

  /**
   * Get image dimensions
   */
  getImageDimensions() {
    // Modern Sankaku doesn't always show dimensions in a clear way on the page
    // without parsing the complex JSON state. 
    // We can try to get them from the image element if it exists.
    const img = document.querySelector('img[src*="/data/"]');
    if (img) {
      return {
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      };
    }
    return { width: 0, height: 0 };
  }

  /**
   * Get rating
   */
  getRating() {
    // Check if rating is in the title or meta
    const title = document.title.toLowerCase();
    if (title.includes('rating:g')) return 'sfw';
    if (title.includes('rating:q')) return 'questionable';
    if (title.includes('rating:e')) return 'explicit';
    
    return null;
  }
}

// Export
window.SankakuComplexParser = SankakuComplexParser;

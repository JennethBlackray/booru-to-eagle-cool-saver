/**
 * @fileoverview Sankaku Complex Parser
 * 
 * Parses images and tags from chan.sankakucomplex.com
 * 
 * Site structure notes:
 * - Post pages: /en/posts/{id} (e.g., /en/posts/WKaoQG248RJ)
 * - Post ID: #hidden_post_id element
 * - Original image URL: #highres link (temporary URL with auth token)
 * - Sample image: #image element (sample-*.webp)
 * - Tags: #tag-sidebar li.tag-type-{type} a.tag-link
 * - Tag types: artist, copyright, character, fashion, anatomy, pose, activity, role, entity, setting, medium, meta, automatic
 * 
 * IMPORTANT: Sankaku uses temporary URLs for original images.
 * The #highres link contains a time-limited URL with auth token.
 * When the token expires, the URL returns a placeholder image.
 * To get a stable original URL, we use the #highres href directly.
 * 
 * @module parsers/sankaku
 */

class SankakuParser extends BaseParser {
  /**
   * Check if this parser handles sankakucomplex.com
   */
  matches(hostname) {
    return hostname.includes('sankakucomplex');
  }

  /**
   * Get site display name
   */
  getSiteName() {
    return 'Sankaku Complex';
  }

  /**
   * Check if we're on a post page
   * Pattern: /en/posts/{id} or /post/show/{id}
   */
  isPostPage() {
    // New URL pattern: /en/posts/{id}
    if (/\/posts\/[^/?]+/.test(window.location.pathname)) {
      return true;
    }
    // Old URL pattern: /post/show/{id}
    if (/\/post\/show\/[^/?]+/.test(window.location.pathname)) {
      return true;
    }
    return false;
  }

  /**
   * Wait for a critical element to appear on the page.
   * Sankaku loads content dynamically, so we need to wait.
   * Uses both MutationObserver and polling for maximum reliability.
   * @param {string} selector - CSS selector to wait for
   * @param {number} timeout - Max time to wait in ms
   * @returns {Promise<Element|null>}
   */
  static async waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      // Check if element already exists
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }
      
      const startTime = Date.now();
      
      // Polling approach - more reliable for SPA navigation
      const pollInterval = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(pollInterval);
          if (observer) observer.disconnect();
          resolve(el);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(pollInterval);
          if (observer) observer.disconnect();
          resolve(null);
        }
      }, 100); // Check every 100ms
      
      // Also use MutationObserver for faster detection
      let observer = null;
      try {
        observer = new MutationObserver(() => {
          const el = document.querySelector(selector);
          if (el) {
            clearInterval(pollInterval);
            observer.disconnect();
            resolve(el);
          }
        });
        
        const target = document.body || document.documentElement;
        if (target) {
          observer.observe(target, {
            childList: true,
            subtree: true
          });
        }
      } catch (e) {
        // MutationObserver might fail if body not ready, polling will handle it
      }
      
      // Final timeout
      setTimeout(() => {
        clearInterval(pollInterval);
        if (observer) observer.disconnect();
        resolve(document.querySelector(selector));
      }, timeout);
    });
  }

  /**
   * Get original image URL
   * 
   * Sankaku uses temporary URLs with auth tokens for originals.
   * The #highres link contains the current valid original URL.
   * 
   * Strategy: Use the #highres href which is the actual original file URL.
   * This URL is temporary and expires, but it's the only way to get the original.
   * 
   * Note: The sample image (#image) is a resized webp version.
   * The original is a jpg/png accessible via #highres link.
   */
  getImageUrl() {
    // Try #highres link first (original image with temp auth URL)
    const highresLink = document.querySelector('#highres');
    if (highresLink && highresLink.href) {
      const href = highresLink.href;
      // Make sure it's an actual image URL, not a placeholder
      if (href && (href.includes('/data/') || href.includes('.jpg') || href.includes('.png'))) {
        console.log('[SankakuParser] Found #highres URL:', href);
        return href;
      }
    }
    
    // Try #image-link href (may point to original or sample)
    const imageLink = document.querySelector('#image-link');
    if (imageLink && imageLink.href) {
      const href = imageLink.href;
      if (href && (href.includes('/data/') || href.includes('.jpg') || href.includes('.png'))) {
        console.log('[SankakuParser] Found #image-link URL:', href);
        return href;
      }
    }
    
    // Try #image element (this is the sample, not original)
    const image = document.querySelector('#image');
    if (image && image.src) {
      // Try to convert sample URL to original
      // Sample: https://s.sankakucomplex.com/data/preview/4b/74/4b74e4c2f3efd01a7b80dbeb7b187abb.avif
      // Original: https://s.sankakucomplex.com/data/4b/74/4b74e4c2f3efd01a7b80dbeb7b187abb.jpg
      const sampleUrl = image.src;
      const originalUrl = sampleUrl
        .replace('/preview/', '/')
        .replace('sample-', '')
        .replace('.avif', '.jpg')
        .replace('.webp', '.jpg')
        .replace(/(\?e=\d+&m=)[^&]+/, ''); // Remove expired auth token
      
      // If we can construct a clean URL, use it
      if (originalUrl !== sampleUrl) {
        console.log('[SankakuParser] Constructed original URL from sample');
        return originalUrl.split('?')[0]; // Remove query params for clean URL
      }
      
      console.log('[SankakuParser] Using sample image URL:', image.src);
      return image.src;
    }
    
    // Try og:image meta tag as last resort
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage && ogImage.content) {
      console.log('[SankakuParser] Using og:image URL:', ogImage.content);
      return ogImage.content;
    }
    
    console.warn('[SankakuParser] Could not find any image URL');
    return null;
  }

  /**
   * Get raw tags from the page with category prefixes
   * 
   * Tag structure:
   * <li class="tag-type-artist">
   *   <a data-id="..." data-count="..." href="..." class="tag-link" id="..." itemprop="keywords">tagname</a>
   * </li>
   * 
   * Tag types:
   * - tag-type-artist: Artist tags
   * - tag-type-copyright: Copyright/franchise tags
   * - tag-type-character: Character tags
   * - tag-type-fashion, tag-type-anatomy, tag-type-pose, tag-type-activity, tag-type-role, tag-type-entity, tag-type-setting, tag-type-medium, tag-type-meta, tag-type-automatic: Various general categories
   */
  getRawTags() {
    const tags = [];
    const tagSidebar = document.querySelector('#tag-sidebar');
    
    if (!tagSidebar) {
      console.warn('[SankakuParser] #tag-sidebar not found');
      return tags;
    }
    
    const tagItems = tagSidebar.querySelectorAll('li');
    console.log('[SankakuParser] Found', tagItems.length, 'tag items in sidebar');
    
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
      
      // Get the tag link
      const tagLink = item.querySelector('a.tag-link');
      if (tagLink) {
        let tag = tagLink.textContent.trim();
        if (tag && tag.length > 0) {
          tag = tag.replace(/\s+/g, '_');
          
          // Prefix artist tags with "artist:"
          if (tagType === 'artist') {
            tag = `artist:${tag}`;
          }
          
          tags.push(tag);
        }
      }
    });
    
    console.log('[SankakuParser] Extracted', tags.length, 'tags');
    return [...new Set(tags)];
  }


  /**
   * Get post ID from page
   * Sankaku has the ID in #hidden_post_id element
   */
  getPostId() {
    // Try #hidden_post_id element first
    const hiddenPostId = document.querySelector('#hidden_post_id');
    if (hiddenPostId) {
      const id = hiddenPostId.textContent.trim();
      if (id) {
        console.log('[SankakuParser] Found post ID from #hidden_post_id:', id);
        return id;
      }
    }
    
    // Try URL pattern /en/posts/{id}
    const match = window.location.pathname.match(/\/posts\/([^/?]+)/);
    if (match) {
      console.log('[SankakuParser] Found post ID from URL:', match[1]);
      return match[1];
    }
    
    // Try old URL pattern /post/show/{id}
    const oldMatch = window.location.pathname.match(/\/post\/show\/([^/?]+)/);
    if (oldMatch) {
      console.log('[SankakuParser] Found post ID from old URL:', oldMatch[1]);
      return oldMatch[1];
    }
    
    console.warn('[SankakuParser] Could not find post ID');
    return null;
  }

  /**
   * Get image dimensions
   * Sankaku has orig_width and orig_height attributes on #image
   * Also can get dimensions from the "Resized" link text or "Original" link text
   */
  getImageDimensions() {
    const image = document.querySelector('#image');
    if (image) {
      const origWidth = image.getAttribute('orig_width');
      const origHeight = image.getAttribute('orig_height');
      if (origWidth && origHeight) {
        const w = parseInt(origWidth, 10);
        const h = parseInt(origHeight, 10);
        if (w > 0 && h > 0) {
          console.log('[SankakuParser] Dimensions from #image attributes:', w, 'x', h);
          return { width: w, height: h };
        }
      }
    }
    
    // Fallback: parse dimensions from "Resized" link text (e.g., "1193x2000")
    const resizedLink = document.querySelector('#lowres');
    if (resizedLink) {
      const text = resizedLink.textContent.trim();
      const match = text.match(/(\d+)x(\d+)/);
      if (match) {
        const w = parseInt(match[1], 10);
        const h = parseInt(match[2], 10);
        console.log('[SankakuParser] Dimensions from #lowres text:', w, 'x', h);
        return { width: w, height: h };
      }
    }
    
    // Fallback: parse dimensions from "Original" link text (e.g., "1231x2064 (1.34 MB JPG)")
    const originalLink = document.querySelector('#highres');
    if (originalLink) {
      const text = originalLink.textContent.trim();
      const match = text.match(/(\d+)x(\d+)/);
      if (match) {
        const w = parseInt(match[1], 10);
        const h = parseInt(match[2], 10);
        console.log('[SankakuParser] Dimensions from #highres text:', w, 'x', h);
        return { width: w, height: h };
      }
    }
    
    console.warn('[SankakuParser] Could not find image dimensions');
    return { width: 0, height: 0 };
  }

  /**
   * Get rating from the page
   * Sankaku ratings: G = sfw, R15+ = questionable, R18+ = explicit
   * Found in #stats as .rating-s, .rating-q, or .rating-e
   */
  getRating() {
    // Check for rating class in #stats
    const ratingEl = document.querySelector('#stats .rating-s, #stats .rating-q, #stats .rating-e');
    if (ratingEl) {
      const text = ratingEl.textContent.trim().toUpperCase();
      if (text === 'G') return 'sfw';
      if (text === 'R15+') return 'questionable';
      if (text === 'R18+') return 'explicit';
    }

    // Fallback: check radio buttons in edit form
    const checkedRadio = document.querySelector('#edit-form input[type="radio"]:checked');
    if (checkedRadio) {
      const value = checkedRadio.value;
      if (value === 'safe') return 'sfw';
      if (value === 'questionable') return 'questionable';
      if (value === 'explicit') return 'explicit';
    }

    return null;
  }

  /**
   * Get source URL
   * Sankaku may have source in post details
   */
  getSourceUrl() {
    // Try to find source link in the page
    const sourceSelectors = [
      'a[href*="pixiv.net"]',
      'a[href*="twitter.com"]',
      'a[href*="x.com"]',
      'a[href*="fanbox.cc"]',
      'a[href*="skeb.co"]'
    ];
    
    for (const selector of sourceSelectors) {
      const link = document.querySelector(selector);
      if (link && link.href && link.href.startsWith('http')) {
        return link.href;
      }
    }
    
    return super.getSourceUrl();
  }

  /**
   * Get notes from the page (image annotations)
   */
  getNotes() {
    const notes = [];
    const noteBodies = document.querySelectorAll('#note-container .note-body');
    
    if (noteBodies.length === 0) {
      console.log('[SankakuParser] No notes found in #note-container');
      return notes;
    }
    
    console.log('[SankakuParser] Found', noteBodies.length, 'notes');
    
    noteBodies.forEach(bodyEl => {
      let text = bodyEl.innerHTML;
      
      // Basic cleanup: <br> to newline, remove other HTML tags
      text = text.replace(/<br\s*\/?>/gi, '\n')
                 .replace(/<[^>]*>?/gm, '')
                 .replace(/&nbsp;/g, ' ')
                 .replace(/&/g, '&')
                 .replace(/</g, '<')
                 .replace(/>/g, '>')
                 .replace(/"/g, '"')
                 .replace(/&#039;/g, "'")
                 .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
                 .trim();
      
      if (text) {
        notes.push(text);
      }
    });
    
    return notes;
  }

  /**
   * Format notes array into plain text for Eagle annotation
   */
  _formatNotesForEagle(notes) {
    if (!notes || notes.length === 0) return null;
    if (notes.length === 1) return notes[0];

    return notes.map((note, index) => 
      `--- Note ${index + 1} ---\n${note}`
    ).join('\n\n');
  }

  /**
   * Parse all data from the current page (async)
   */
  async parse() {
    if (!this.isPostPage()) return null;

    const imageUrl = this.getImageUrl();
    const tags = this.getTags();
    const dimensions = this.getImageDimensions();
    const postId = this.getPostId();
    const sourceUrl = this.getSourceUrl();
    const rating = this.getRating();
    const notes = this.getNotes();
    const annotation = this._formatNotesForEagle(notes);

    // Build final tags array - add rating tag if found
    const finalTags = [...tags];
    if (rating) {
      finalTags.push(`rating:${rating}`);
    }

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
window.SankakuParser = SankakuParser;

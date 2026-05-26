/**
 * @fileoverview Danbooru Parser
 * 
 * Parses images and tags from danbooru.donmai.us
 * 
 * Site structure notes:
 * - Post pages: /posts/{id}
 * - Image URL: data-file-url attribute on #c-posts #a-show
 * - Tags: #tag-list a.search-tag
 * - Dimensions: data-file-width/data-file-height attributes
 * 
 * @module parsers/danbooru
 */

class DanbooruParser extends BaseParser {
  /**
   * Check if this parser handles danbooru.donmai.us
   */
  matches(hostname) {
    return hostname.includes('danbooru') && hostname.includes('donmai');
  }

  /**
   * Get site display name
   */
  getSiteName() {
    return 'Danbooru';
  }

  /**
   * Check if we're on a post page
   * Pattern: /posts/{id}
   */
  isPostPage() {
    return /\/posts\/\d+/.test(window.location.pathname);
  }

  /**
   * Check if current post is a video (mp4, webm)
   * @returns {boolean}
   */
  isVideoPost() {
    // Check for video element on the page
    if (document.querySelector('video')) return true;
    
    // Check data-file-ext attribute for video extensions
    const imageSection = document.querySelector('#c-posts #a-show');
    if (imageSection) {
      const ext = imageSection.getAttribute('data-file-ext');
      if (ext && ['mp4', 'webm'].includes(ext.toLowerCase())) return true;
    }
    
    // Check og:type for video
    const ogType = document.querySelector('meta[property="og:type"]');
    if (ogType && ogType.content && ogType.content.includes('video')) return true;
    
    return false;
  }

  /**
   * Get original image/video URL
   * Priority: data-file-url > video element source > original link > og:image
   * For video posts, avoids falling back to og:image (which is a .webp thumbnail)
   */
  getImageUrl() {
    // Try data attribute first (most reliable - works for both images and videos)
    const imageSection = document.querySelector('#c-posts #a-show');
    if (imageSection) {
      const fileUrl = imageSection.getAttribute('data-file-url');
      if (fileUrl) return fileUrl.trim();
    }
    
    // Try "View original" link
    const originalLink = document.querySelector('a.image-view-original-link');
    if (originalLink) return originalLink.href;
    
    // For video posts, try to get the video source URL
    if (this.isVideoPost()) {
      // Try video element source
      const video = document.querySelector('video');
      if (video) {
        // Try <source> element inside video
        const source = video.querySelector('source');
        if (source && source.src) return source.src;
        // Try video.src directly
        if (video.src) return video.src;
      }
      
      // Try to find a direct download link for the video
      const downloadLink = document.querySelector('a[href*="/download/"]');
      if (downloadLink) return downloadLink.href;
    }
    
    // Try og:image meta tag (only for non-video posts, since for videos
    // og:image points to a .webp thumbnail, not the actual video)
    if (!this.isVideoPost()) {
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) return ogImage.content;
    }
    
    return null;
  }

  /**
   * Get raw tags from the page with category prefixes
   * 
   * Tag type classes:
   * - tag-type-0 = general
   * - tag-type-1 = artist
   * - tag-type-3 = copyright
   * - tag-type-4 = character
   * - tag-type-5 = meta
   * 
   * Artist tags are prefixed with "artist:" for Eagle
   */
  getRawTags() {
    const tags = [];
    const tagItems = document.querySelectorAll('#tag-list li.flex');
    
    tagItems.forEach(item => {
      // Determine tag type from CSS class
      let tagType = 'general'; // default
      if (item.classList.contains('tag-type-1')) {
        tagType = 'artist';
      } else if (item.classList.contains('tag-type-3')) {
        tagType = 'copyright';
      } else if (item.classList.contains('tag-type-4')) {
        tagType = 'character';
      } else if (item.classList.contains('tag-type-5')) {
        tagType = 'meta';
      }
      
      // Get the actual tag link (second anchor, first is wiki link)
      const tagLink = item.querySelector('a.search-tag');
      if (tagLink) {
        let tag = tagLink.textContent.trim();
        if (tag) {
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
    const match = window.location.pathname.match(/\/posts\/([^/?]+)/);
    return match ? match[1] : null;
  }

  /**
   * Get image/video dimensions
   * Priority: data attributes > og:image meta > video/image element
   * For video posts, uses data-file-width/data-file-height (most reliable)
   */
  getImageDimensions() {
    // Try data attributes on image container (works for both images and videos)
    const imageSection = document.querySelector('#c-posts #a-show');
    if (imageSection) {
      const width = imageSection.getAttribute('data-file-width');
      const height = imageSection.getAttribute('data-file-height');
      if (width && height) {
        return {
          width: parseInt(width, 10) || 0,
          height: parseInt(height, 10) || 0
        };
      }
    }
    
    // For video posts, try video element dimensions
    if (this.isVideoPost()) {
      const video = document.querySelector('video');
      if (video) {
        return {
          width: video.videoWidth || video.width || 0,
          height: video.videoHeight || video.height || 0
        };
      }
    }
    
    // Fallback to base implementation
    return super.getImageDimensions();
  }

  /**
   * Get rating from the page
   * Danbooru ratings:
   * - General (s) = sfw
   * - Questionable (q) = questionable
   * - Sensitive (q) = questionable
   * - Explicit (e) = explicit
   * 
   * Found in #post-information as "Rating: s" or via meta tags
   */
  getRating() {
    // Check #post-information for rating
    // Danbooru uses: g=General, s=Safe, q=Questionable, e=Explicit
    // Both g and s should map to sfw
    const postInfo = document.querySelector('#post-information');
    if (postInfo) {
      const text = postInfo.textContent;
      const ratingMatch = text.match(/Rating:\s*([gsqe])/i);
      if (ratingMatch) {
        const rating = ratingMatch[1].toLowerCase();
        if (rating === 'g' || rating === 's') return 'sfw';
        if (rating === 'q') return 'questionable';
        if (rating === 'e') return 'explicit';
      }
    }

    // Check for rating meta tag
    const ratingMeta = document.querySelector('meta[property="og:rating"]');
    if (ratingMeta) {
      const content = ratingMeta.content.toLowerCase();
      if (content === 's' || content === 'safe') return 'sfw';
      if (content === 'q' || content === 'questionable') return 'questionable';
      if (content === 'e' || content === 'explicit') return 'explicit';
    }

    // Check for data attributes on post container
    const postContainer = document.querySelector('[data-rating]');
    if (postContainer) {
      const rating = postContainer.getAttribute('data-rating').toLowerCase();
      if (rating === 's' || rating === 'safe') return 'sfw';
      if (rating === 'q' || rating === 'questionable') return 'questionable';
      if (rating === 'e' || rating === 'explicit') return 'explicit';
    }

    return null;
  }

  /**
   * Get source URL
   * Danbooru has source links in the sidebar
   */
  getSourceUrl() {
    // Try explicit source link
    const sourceLink = document.querySelector('#post-information a[href^="http"]');
    if (sourceLink) return sourceLink.href;
    
    // Try to find pixiv/twitter links
    return super.getSourceUrl();
  }

  /**
   * Get notes from the page (image annotations)
   * Fetches notes from Danbooru's notes API endpoint.
   * Notes are stored separately and loaded via the API:
   * /notes.json?search[post_id]={postId}
   * @returns {Promise<Array<{x: number, y: number, width: number, height: number, body: string}>>}
   */
  async getNotes() {
    // Check if note parsing is enabled in settings
    if (typeof window.extensionSettings !== 'undefined' && !window.extensionSettings.parseNotes) {
      return [];
    }

    const postId = this.getPostId();
    if (!postId) return [];

    // Cache to prevent duplicate fetches within a short timeframe
    const now = Date.now();
    if (this._lastNotesFetchId === postId && this._lastNotesResult && (now - this._lastNotesFetchTime < 10000)) {
      return this._lastNotesResult;
    }

    try {
      // Fetch notes from Danbooru's JSON API
      const apiUrl = `/notes.json?search[post_id]=${postId}&_cb=${now}`;
      const response = await fetch(apiUrl);
      if (!response.ok) return [];

      const notesData = await response.json();
      
      // Danbooru notes API returns an array of note objects:
      // {
      //   "id": 123,
      //   "post_id": 456,
      //   "x": 100,
      //   "y": 200,
      //   "width": 300,
      //   "height": 50,
      //   "body": "Note text here",
      //   "created_at": "...",
      //   "updated_at": "..."
      // }
      if (!Array.isArray(notesData) || notesData.length === 0) return [];

      const notes = notesData.map(note => {
        // Decode HTML entities in body text
        let body = note.body || '';
        body = body.replace(/<br\s*\/?>/gi, '\n');
        
        // Use a function-based approach to avoid auto-formatting issues with escapes
        body = body.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
        body = body.replace(/&#039;/g, String.fromCharCode(39));  // apostrophe '
        body = body.replace(/([&])([lg]t|quot|amp);/g, decodeEntity);
        
        body = body.trim();

        return {
          x: parseInt(note.x, 10) || 0,
          y: parseInt(note.y, 10) || 0,
          width: parseInt(note.width, 10) || 0,
          height: parseInt(note.height, 10) || 0,
          body: body
        };
      }).filter(note => note.body.length > 0);
      
      /**
       * Helper to decode HTML entities like <, >, ", &
       * Uses a regex that matches the entity pattern and maps it
       */
      function decodeEntity(match, prefix, entity) {
        if (entity === 'amp') return String.fromCharCode(38);  // &
        if (entity === 'lt') return String.fromCharCode(60);   // <
        if (entity === 'gt') return String.fromCharCode(62);   // >
        if (entity === 'quot') return String.fromCharCode(34); // "
        return match;
      }

      this._lastNotesFetchId = postId;
      this._lastNotesFetchTime = now;
      this._lastNotesResult = notes;

      return notes;
    } catch (e) {
      console.warn('[Danbooru] Failed to load notes from API:', e);
      return [];
    }
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

    // Debug: log artist tags and notes
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
window.DanbooruParser = DanbooruParser;

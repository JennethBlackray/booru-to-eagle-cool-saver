/**
 * @fileoverview Gelbooru Parser
 * 
 * Parses images and tags from gelbooru.com
 * 
 * Site structure notes:
 * - Post pages: ?page=post&s=view&id={id}
 * - Image URL: #image element src or og:image
 * - Tags: #tag-list a[href*="tags="]
 * 
 * @module parsers/gelbooru
 */

class GelbooruParser extends BaseParser {
  /**
   * Check if this parser handles gelbooru.com
   */
  matches(hostname) {
    return hostname.includes('gelbooru');
  }

  /**
   * Get site display name
   */
  getSiteName() {
    return 'Gelbooru';
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
   * Gelbooru redirects direct image URLs to post pages when fetched from
   * service worker context. We return the URL for content script download.
   */
  getImageUrl() {
    // Best: "Original image" link (has target="_blank")
    const originalLink = document.querySelector('a[target="_blank"][href*="/images/"]');
    if (originalLink && originalLink.href) {
      const url = originalLink.href.replace(/([^:]\/)\/+/g, '$1');
      console.log('[Gelbooru] URL from Original image link:', url);
      return url;
    }
    
    // Fallback: og:image meta tag
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage && ogImage.content) {
      const url = ogImage.content.replace(/([^:]\/)\/+/g, '$1');
      console.log('[Gelbooru] URL from og:image:', url);
      return url;
    }
    
    // Fallback: #image element src
    const image = document.querySelector('#image');
    if (image && image.src) return image.src;
    
    return null;
  }

  /**
   * Download image via content script context (has access to page cookies)
   * Returns base64 data URL
   */
  async downloadImageAsBase64(imageUrl) {
    console.log('[Gelbooru] Downloading via content script:', imageUrl);
    
    try {
      const response = await fetch(imageUrl, {
        credentials: 'include',
        cache: 'no-store'
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const contentType = response.headers.get('content-type') || 'image/png';
      
      // Check if we got HTML instead of image
      if (contentType.includes('text/html')) {
        throw new Error('Received HTML instead of image - gelbooru is redirecting');
      }
      
      const blob = await response.blob();
      console.log('[Gelbooru] Downloaded blob:', blob.size, 'bytes, type:', contentType);
      
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({
          success: true,
          base64: reader.result,
          mimeType: contentType
        });
        reader.onerror = () => reject(new Error('Failed to convert to base64'));
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error('[Gelbooru] Download failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get raw tags from the page
   * Tags are in #tag-list li.tag-type-* with a[href*="tags="]
   * Skip count numbers
   * Add artist: prefix for artist tags
   */
  getRawTags() {
    const tags = [];
    const tagItems = document.querySelectorAll('#tag-list li[class*="tag-type-"]');

    console.log(`[Gelbooru] Found ${tagItems.length} tag elements`);

    tagItems.forEach(item => {
      const link = item.querySelector('a[href*="tags="]');
      if (!link) return;

      const tag = link.textContent.trim();
      if (!tag || /^\d+$/.test(tag)) return; // Skip count numbers

      // Check tag type from class
      const className = item.className || '';
      let tagName = tag.replace(/\s+/g, '_');

      if (className.includes('tag-type-artist')) {
        tagName = 'artist:' + tagName;
      }

      tags.push(tagName);
    });

    const artistTags = tags.filter(t => t.startsWith('artist:'));
    console.log(`[Gelbooru] Total raw tags: ${tags.length}, Artist tags: ${artistTags.length}`, artistTags);
    return [...new Set(tags)];
  }

  /**
   * Get post ID from URL
   */
  getPostId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('id');
  }

  /**
   * Get rating from the page
   * Gelbooru ratings:
   * - General (g) → sfw
   * - Sensitive (s) → questionable
   * - Questionable (q) → questionable
   * - Explicit (e) → explicit
   * Found in data-rating on .image-container or in stats
   */
  getRating() {
    // Best: read data-rating from .image-container
    const container = document.querySelector('.image-container');
    if (container) {
      const rating = container.getAttribute('data-rating');
      if (rating) {
        const ratingLower = rating.toLowerCase();
        // Gelbooru rating mapping:
        // general → sfw
        // sensitive → questionable
        // questionable → questionable
        // explicit → explicit
        if (ratingLower === 'general' || ratingLower === 'g') return 'sfw';
        if (ratingLower === 'sensitive' || ratingLower === 's') return 'questionable';
        if (ratingLower === 'questionable' || ratingLower === 'q') return 'questionable';
        if (ratingLower === 'explicit' || ratingLower === 'e') return 'explicit';
      }
    }

    // Fallback: check stats text (e.g., "Rating: Sensitive")
    const statsEl = document.querySelector('#stats');
    if (statsEl) {
      const text = statsEl.textContent.toLowerCase();
      const ratingMatch = text.match(/rating:\s*(general|sensitive|questionable|explicit)/i);
      if (ratingMatch) {
        const rating = ratingMatch[1].toLowerCase();
        if (rating === 'general') return 'sfw';
        if (rating === 'sensitive') return 'questionable';
        if (rating === 'questionable') return 'questionable';
        if (rating === 'explicit') return 'explicit';
      }
    }

    // Fallback: check radio buttons in edit form
    const ratingInput = document.querySelector('input[name="rating"]:checked');
    if (ratingInput) {
      const value = ratingInput.value.toLowerCase();
      if (value === 'g') return 'sfw';
      if (value === 's') return 'questionable';
      if (value === 'q') return 'questionable';
      if (value === 'e') return 'explicit';
    }

    return null;
  }

  /**
   * Get image dimensions
   * Gelbooru stores dimensions in data attributes on .image-container
   */
  getImageDimensions() {
    // Try data attributes on image container
    const container = document.querySelector('.image-container');
    if (container) {
      const width = container.getAttribute('data-width') || container.getAttribute('data-large-width');
      const height = container.getAttribute('data-height') || container.getAttribute('data-large-height');
      if (width && height) {
        return {
          width: parseInt(width, 10) || 0,
          height: parseInt(height, 10) || 0
        };
      }
    }
    
    // Fallback to base implementation
    return super.getImageDimensions();
  }

  /**
   * Get notes from the page (image annotations)
   * Gelbooru embeds notes directly in the DOM as <article> elements
   * inside <section id="notes">, with data-x, data-y, data-width, 
   * data-height, and data-body attributes.
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

    const notes = this._extractNotesFromDOM();
    if (notes.length > 0) {
      this._lastNotesFetchId = postId;
      this._lastNotesFetchTime = now;
      this._lastNotesResult = notes;
      return notes;
    }

    // Fallback: try fetching notes from Gelbooru's note API
    try {
      const apiUrl = `/index.php?page=note&s=list&post_id=${postId}&json=1&_cb=${now}`;
      const response = await fetch(apiUrl);
      if (!response.ok) return [];

      const notesData = await response.json();
      
      // Gelbooru note API returns either a direct array or an object with a notes property
      let notesArray = notesData;
      if (notesData && notesData.notes) {
        notesArray = notesData.notes;
      }
      
      if (!Array.isArray(notesArray) || notesArray.length === 0) return [];

      const apiNotes = notesArray.map(note => {
        let body = note.body || note.note_text || '';
        body = body.replace(/<br\s*\/?>/gi, '\n');
        body = body.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
        body = body.replace(/&#039;/g, String.fromCharCode(39));
        body = body.replace(/([&])([lg]t|quot|amp);/g, decodeNotesEntity);
        body = body.trim();

        return {
          x: parseInt(note.x || note.note_x, 10) || 0,
          y: parseInt(note.y || note.note_y, 10) || 0,
          width: parseInt(note.width || note.note_width, 10) || 0,
          height: parseInt(note.height || note.note_height, 10) || 0,
          body: body
        };
      }).filter(note => note.body.length > 0);

      this._lastNotesFetchId = postId;
      this._lastNotesFetchTime = now;
      this._lastNotesResult = apiNotes;

      return apiNotes;
    } catch (e) {
      console.warn('[Gelbooru] Failed to load notes from API:', e);
      return [];
    }
  }

  /**
   * Extract notes directly from the DOM.
   * Gelbooru renders notes as <article> elements inside <section id="notes">
   * with data-x, data-y, data-width, data-height, and data-body attributes.
   * @returns {Array<{x: number, y: number, width: number, height: number, body: string}>}
   */
  _extractNotesFromDOM() {
    const notesSection = document.getElementById('notes');
    if (!notesSection) return [];

    const articleElements = notesSection.querySelectorAll('article');
    if (!articleElements || articleElements.length === 0) return [];

    const notes = [];
    for (const article of articleElements) {
      // Use data-body attribute for the text (contains raw text with HTML entities)
      let body = article.getAttribute('data-body') || article.textContent || '';
      if (!body.trim()) continue;

      // Decode HTML entities
      body = body.replace(/<br\s*\/?>/gi, '\n');
      body = body.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
      body = body.replace(/&#039;/g, String.fromCharCode(39));
      body = body.replace(/([&])([lg]t|quot|amp);/g, decodeNotesEntity);
      body = body.trim();

      if (!body) continue;

      notes.push({
        x: parseInt(article.getAttribute('data-x'), 10) || 0,
        y: parseInt(article.getAttribute('data-y'), 10) || 0,
        width: parseInt(article.getAttribute('data-width'), 10) || 0,
        height: parseInt(article.getAttribute('data-height'), 10) || 0,
        body: body
      });
    }

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

/**
 * Helper to decode HTML entities like <, >, ", &
 * Lives outside the class to be accessible from the map callback.
 * Uses a regex that matches the entity pattern and maps it to the decoded character.
 */
function decodeNotesEntity(match, prefix, entity) {
  if (entity === 'amp') return String.fromCharCode(38);  // &
  if (entity === 'lt') return String.fromCharCode(60);   // <
  if (entity === 'gt') return String.fromCharCode(62);   // >
  if (entity === 'quot') return String.fromCharCode(34); // "
  return match;
}

// Export
window.GelbooruParser = GelbooruParser;

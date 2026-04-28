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
  getImageUrl() {
    // Try og:image meta tag first (most reliable for original)
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage && ogImage.content) {
      return ogImage.content;
    }
    
    // Try "Original image" link
    const originalLink = document.querySelector('a[onclick*="Post.highres"]');
    if (originalLink && originalLink.href) {
      return originalLink.href;
    }
    
    // Fallback: try any link to /images/ that is NOT in /samples/
    const allLinks = document.querySelectorAll('a[href*="/images/"]');
    for (const link of allLinks) {
      if (link.href && !link.href.includes('/samples/')) {
        return link.href;
      }
    }
    
    // Last resort: #image element (this is the sample, not original)
    const image = document.querySelector('#image');
    if (image && image.src) {
      // Convert sample URL to original URL
      // Sample: https://wimg.rule34.xxx/samples/2418/sample_50273c5875a6d396c39b3f440d41c4ef.jpg
      // Original: https://wimg.rule34.xxx/images/2418/50273c5875a6d396c39b3f440d41c4ef.png
      return image.src.replace('/samples/', '/images/').replace('sample_', '').replace('.jpg', '.png');
    }
    
    return null;
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
   * Fetches raw HTML from the post page and extracts note data from server-rendered markup.
   * Notes are only present in the raw HTML response, not in the DOM after JS execution.
   * HTML pattern: <div class="note-box" data-x="..." data-y="..." data-width="..." data-height="..." data-body="...">
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
      // Fetch raw HTML from the post page (bypass cache)
      const response = await fetch(`/index.php?page=post&s=view&id=${postId}&_cb=${now}`);
      if (!response.ok) return [];

      const html = await response.text();

      // Note structure in raw HTML:
      // <div class="note-box" style="width: 76px; height: 529px; top: 103px; left: 1326px; ..." id="note-box-296595">...</div>
      // <div class="note-body" id="note-body-296595" title="Click to edit">Note text here</div>
      //
      // Text is inside <div class="note-body"> as textContent, NOT as data attribute
      // Coordinates are in note-box style attribute

      // Parse note-body elements for text
      const noteBodyRegex = /<div\s+[^>]*class="note-body"[^>]*id="note-body-(\d+)"[^>]*>([\s\S]*?)<\/div>/g;
      const notes = [];

      let match;
      while ((match = noteBodyRegex.exec(html)) !== null) {
        const noteId = match[1];
        let body = match[2];

        // Decode HTML entities: &#039; -> ', <br /> -> \n, etc.
        body = body.replace(/<br\s*\/?>/gi, '\n')
                   .replace(/&#039;/g, "'")
                   .replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
                   .trim();

        if (!body) continue;

        // Find the corresponding note-box for coordinates
        const noteBoxRegex = new RegExp(`<div\\s+class="note-box"[^>]*id="note-box-${noteId}"[^>]*style="([^"]*)"[^>]*>`);
        const boxMatch = html.match(noteBoxRegex);
        const noteBoxRegex2 = new RegExp(`<div\\s+class="note-box"[^>]*style="([^"]*)"[^>]*id="note-box-${noteId}"[^>]*>`);
        const boxMatch2 = html.match(noteBoxRegex2);
        const boxStyle = (boxMatch ? boxMatch[1] : '') || (boxMatch2 ? boxMatch2[1] : '');

        let x = 0, y = 0, width = 0, height = 0;
        if (boxStyle) {
          const leftMatch = boxStyle.match(/left:\s*(\d+)px/);
          const topMatch = boxStyle.match(/top:\s*(\d+)px/);
          const widthMatch = boxStyle.match(/width:\s*(\d+)px/);
          const heightMatch = boxStyle.match(/height:\s*(\d+)px/);
          x = leftMatch ? parseInt(leftMatch[1], 10) : 0;
          y = topMatch ? parseInt(topMatch[1], 10) : 0;
          width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
          height = heightMatch ? parseInt(heightMatch[1], 10) : 0;
        }

        notes.push({ x, y, width, height, body });
      }

      this._lastNotesFetchId = postId;
      this._lastNotesFetchTime = now;
      this._lastNotesResult = notes;

      return notes;
    } catch (e) {
      console.warn('[Rule34] Failed to load notes from raw HTML:', e);
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
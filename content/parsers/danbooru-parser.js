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
   * Get original image URL
   * Priority: data-file-url > original link > og:image
   */
  getImageUrl() {
    // Try data attribute first (most reliable)
    const imageSection = document.querySelector('#c-posts #a-show');
    if (imageSection) {
      const fileUrl = imageSection.getAttribute('data-file-url');
      if (fileUrl) return fileUrl.trim();
    }
    
    // Try "View original" link
    const originalLink = document.querySelector('a.image-view-original-link');
    if (originalLink) return originalLink.href;
    
    // Try og:image meta tag
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) return ogImage.content;
    
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
   * Get image dimensions
   * Priority: data attributes > og:image meta > image element
   */
  getImageDimensions() {
    // Try data attributes on image container
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
}

// Export
window.DanbooruParser = DanbooruParser;
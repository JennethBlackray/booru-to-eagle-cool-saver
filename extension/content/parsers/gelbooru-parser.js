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
}

// Export
window.GelbooruParser = GelbooruParser;
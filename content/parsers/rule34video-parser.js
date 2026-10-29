/**
 * @fileoverview Rule34video.com Parser
 * 
 * Parses videos, metadata, and tags from rule34video.com
 * 
 * @module parsers/rule34video
 */

class Rule34VideoParser extends BaseParser {
  constructor() {
    super();
    this._cachedFlashvars = undefined;
  }

  matches(hostname) {
    return hostname.includes('rule34video.com');
  }

  getSiteName() {
    return 'Rule34Video';
  }

  isPostPage() {
    const path = window.location.pathname;
    return path.includes('/video/') || path.includes('/videos/') || path.includes('/embed/');
  }

  getPostId() {
    // 1. URL pattern: /video/{id}/... or /videos/{id}/...
    const match = window.location.pathname.match(/\/(?:video|videos)\/(\d+)/i);
    if (match) return match[1];

    // 2. From flashvars
    const fv = this._getFlashvars();
    if (fv?.video_id) return fv.video_id;

    // 3. From action buttons or meta
    const btn = document.querySelector('[data-video-id]');
    if (btn) return btn.getAttribute('data-video-id');

    return null;
  }

  /**
   * Helper to parse flashvars object from inline <script> tags
   * @private
   */
  _getFlashvars() {
    if (this._cachedFlashvars !== undefined) return this._cachedFlashvars;
    
    // Check if available on window directly
    if (typeof window !== 'undefined' && window.flashvars) {
      this._cachedFlashvars = window.flashvars;
      return this._cachedFlashvars;
    }

    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text.includes('flashvars')) continue;
      const match = text.match(/flashvars\s*=\s*\{([\s\S]*?)\};/);
      if (match) {
        const fv = {};
        const re = /([a-zA-Z0-9_]+)\s*:\s*'([^']*)'/g;
        let m;
        while ((m = re.exec(match[1])) !== null) {
          fv[m[1]] = m[2];
        }
        this._cachedFlashvars = fv;
        return fv;
      }
    }

    this._cachedFlashvars = null;
    return null;
  }

  /**
   * Get the highest resolution video URL.
   * Priority:
   * 1. <a> download links in DOM (.tag_item_download) - highest quality is first
   * 2. flashvars: video_alt_url3 (1080p) -> video_alt_url2 (720p) -> video_alt_url (480p) -> video_url (360p)
   */
  getImageUrl() {
    // 1. Try download links in DOM
    const downloadLinks = document.querySelectorAll('a.tag_item_download, a[href*="/get_file/"][href*=".mp4"]');
    if (downloadLinks.length > 0) {
      const href = downloadLinks[0].href;
      if (href) return href;
    }

    // 2. Try flashvars
    const fv = this._getFlashvars();
    if (fv) {
      const candidates = [
        fv.video_alt_url3,
        fv.video_alt_url2,
        fv.video_alt_url,
        fv.video_url,
        fv.event_reporting2
      ];
      for (const u of candidates) {
        if (u && typeof u === 'string' && u.includes('.mp4')) {
          return u;
        }
      }
    }

    // 3. Fallback: <video> element
    const video = document.querySelector('video');
    if (video && video.src) return video.src;

    return null;
  }

  getRawTags() {
    const tags = [];
    const fv = this._getFlashvars();

    // 1. From flashvars
    if (fv) {
      // Tags
      if (fv.video_tags) {
        const tList = fv.video_tags.split(',').map(t => t.trim()).filter(Boolean);
        tags.push(...tList);
      }
      // Creator / Model as artist tag
      if (fv.video_models) {
        const models = fv.video_models.split(',').map(m => m.trim()).filter(Boolean);
        for (const m of models) {
          tags.push(`artist:${m}`);
        }
      }
      // Category
      if (fv.video_categories) {
        const cats = fv.video_categories.split(',').map(c => c.trim()).filter(Boolean);
        tags.push(...cats);
      }
    }

    // 2. Also check strictly scoped video tag chips inside #tab_video_info .row.vp-tags
    const tagChips = document.querySelectorAll('#tab_video_info .row.vp-tags .tag_vote_chip[data-item-type="tag"] > a.tag_item');
    tagChips.forEach(a => {
      const txt = a.textContent.trim();
      if (txt && txt.length > 1) {
        tags.push(txt);
      }
    });

    const catChips = document.querySelectorAll('#tab_video_info .row.vp-tags .tag_vote_chip[data-item-type="category"] > a.video_meta_pill > span');
    catChips.forEach(s => {
      const txt = s.textContent.trim();
      if (txt && txt.length > 1) {
        tags.push(txt);
      }
    });

    const modelChips = document.querySelectorAll('#tab_video_info .row.vp-tags .tag_vote_chip[data-item-type="model"] > a.video_meta_pill > span');
    modelChips.forEach(s => {
      const txt = s.textContent.trim();
      if (txt && txt.length > 1 && !tags.some(t => t.toLowerCase() === `artist:${txt.toLowerCase()}`)) {
        tags.push(`artist:${txt}`);
      }
    });

    return [...new Set(tags)];
  }

  getImageDimensions() {
    const fv = this._getFlashvars();
    if (fv) {
      if (fv.video_alt_url3 && fv.video_alt_url3_text === '1080p') {
        return { width: 1920, height: 1080 };
      }
      if (fv.video_alt_url2 && fv.video_alt_url2_text === '720p') {
        return { width: 1280, height: 720 };
      }
      if (fv.video_alt_url && fv.video_alt_url_text === '480p') {
        return { width: 854, height: 480 };
      }
      if (fv.player_width && fv.player_height) {
        return {
          width: Math.round(parseFloat(fv.player_width)) || 0,
          height: Math.round(parseFloat(fv.player_height)) || 0
        };
      }
    }

    const dlLink = document.querySelector('a.tag_item_download');
    if (dlLink) {
      const text = dlLink.textContent || '';
      if (text.includes('1080')) return { width: 1920, height: 1080 };
      if (text.includes('720')) return { width: 1280, height: 720 };
      if (text.includes('480')) return { width: 854, height: 480 };
      if (text.includes('360')) return { width: 640, height: 360 };
      if (text.includes('2160') || text.includes('4k')) return { width: 3840, height: 2160 };
    }

    return { width: 0, height: 0 };
  }

  getTitle() {
    const fv = this._getFlashvars();
    if (fv?.video_title) return fv.video_title;
    const h1 = document.querySelector('h1.title, h1');
    if (h1) return h1.textContent.trim();
    return document.title.replace(' - Rule34Video', '').trim();
  }

  getPreviewUrl() {
    const fv = this._getFlashvars();
    if (fv?.preview_url) return fv.preview_url;
    const poster = document.querySelector('video[poster]');
    if (poster) return poster.getAttribute('poster');
    return null;
  }

  getRating() {
    return 'explicit';
  }

  /**
   * Extract the "About" description block for Eagle notes when parseNotes is enabled
   * @returns {string|null}
   */
  getAnnotation() {
    if (typeof window !== 'undefined' && typeof window.extensionSettings !== 'undefined' && !window.extensionSettings.parseNotes) {
      return null;
    }

    const descEl = document.querySelector('#tab_video_info .vp-about .vp-desc, .vp-about .vp-desc, .vp-desc.js-vp-desc');
    if (descEl) {
      let body = descEl.innerHTML || '';
      body = body
        .replace(/\r?\n?[ \t]*<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>?/gm, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/\r\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .trim();
      if (body) return body;
    }

    // Fallback: check JSON-LD VideoObject.description
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      try {
        const data = JSON.parse(script.textContent || '');
        if (data && typeof data.description === 'string' && data.description.trim()) {
          return data.description.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
        }
      } catch (e) {}
    }

    return null;
  }
}

// Export for module systems and global window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Rule34VideoParser };
}
if (typeof window !== 'undefined') {
  window.Rule34VideoParser = Rule34VideoParser;
}


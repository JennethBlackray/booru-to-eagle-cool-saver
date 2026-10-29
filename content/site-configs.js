/**
 * @fileoverview Site configurations for Booru to Eagle Saver
 * 
 * To add a new site:
 * 1. Add an entry to SITE_CONFIGS with the site's hostname pattern
 * 2. Add the URL pattern to manifest.json host_permissions
 * 3. Add the URL pattern to manifest.json content_scripts matches
 * 
 * @module site-configs
 */

/**
 * @typedef {Object} SiteConfig
 * @property {string} name - Display name for the site
 * @property {string[]} thumbSelectors - CSS selectors for thumbnail containers (ordered by priority)
 * @property {string} thumbContainerSelector - Selector for the element that gets position:relative
 * @property {(el: HTMLElement) => string|null} idExtractor - Function to extract post ID from element
 * @property {(postId: string) => string} postPageUrl - Function to build post page URL
 * @property {string} observerTarget - CSS selector for the element to observe for new thumbnails
 * @property {boolean} [hashThumbsInPage] - Fetch thumbnails for pHash from the page context instead of the background worker
 */

/**
 * Site configurations keyed by hostname pattern
 * The key is matched against window.location.hostname using includes()
 */
const SITE_CONFIGS = {
  'chan.sankakucomplex.com': {
    name: 'Sankaku Complex',
    thumbSelectors: ['article.post-preview'],
    thumbContainerSelector: '.post-preview-container',
    idExtractor: (el) => {
      // Sankaku: data-id attribute or id="p{id}"
      return el.dataset.id || (el.id?.startsWith('p') ? el.id.substring(1) : null);
    },
    postPageUrl: (postId) => `/en/posts/${postId}`,
    observerTarget: '#post-list'
  },

  'gelbooru.com': {
    name: 'Gelbooru',
    thumbSelectors: ['article.thumbnail-preview'],
    thumbContainerSelector: 'article.thumbnail-preview',
    idExtractor: (el) => {
      // Gelbooru: link href contains index.php?page=post&s=view&id={id}
      const link = el.querySelector('a[href*="page=post"]');
      if (link) {
        const match = link.href.match(/[?&]id=(\d+)/);
        if (match) return match[1];
      }
      return null;
    },
    postPageUrl: (postId) => `/index.php?page=post&s=view&id=${postId}`,
    observerTarget: '#content'
  },

  'danbooru.donmai.us': {
    name: 'Danbooru',
    thumbSelectors: ['article.post-preview'],
    thumbContainerSelector: '.post-preview',
    idExtractor: (el) => {
      // Danbooru: data-id attribute
      return el.dataset.id || null;
    },
    postPageUrl: (postId) => `/posts/${postId}`,
    observerTarget: '#posts-container',
    // cdn.donmai.us is Cloudflare-protected: background fetches get a 403 challenge,
    // so thumbnails are fetched for pHash from the page context (CORS granted by a DNR session rule)
    hashThumbsInPage: true
  },

  'konachan.com': {
    name: 'Konachan',
    thumbSelectors: ['ul#post-list-posts li'],
    thumbContainerSelector: 'li',
    idExtractor: (el) => {
      // Konachan: link href contains /post/show/{id}
      const link = el.querySelector('a[href*="post/show/"]');
      if (link) {
        const match = link.href.match(/\/post\/show\/(\d+)/);
        if (match) return match[1];
      }
      return null;
    },
    postPageUrl: (postId) => `/post/show/${postId}`,
    observerTarget: '#post-list-posts'
  },

  'rule34.xxx': {
    name: 'Rule34',
    thumbSelectors: ['span.thumb'],
    thumbContainerSelector: 'span.thumb',
    idExtractor: (el) => {
      // Rule34: link href contains index.php?page=post&s=view&id={id}
      const link = el.querySelector('a[href*="page=post"]');
      if (link) {
        const match = link.href.match(/[?&]id=(\d+)/);
        if (match) return match[1];
      }
      return null;
    },
    postPageUrl: (postId) => `/index.php?page=post&s=view&id=${postId}`,
    observerTarget: '#content'
  },

  'yande.re': {
    name: 'Yande.re',
    thumbSelectors: ['ul#post-list-posts li'],
    thumbContainerSelector: 'li',
    idExtractor: (el) => {
      // yande.re: link href contains /post/show/{id}
      const link = el.querySelector('a[href*="post/show/"]');
      if (link) {
        const match = link.href.match(/\/post\/show\/(\d+)/);
        if (match) return match[1];
      }
      return null;
    },
    postPageUrl: (postId) => `/post/show/${postId}`,
    observerTarget: '#post-list-posts'
  },

  'rule34video.com': {
    name: 'Rule34Video',
    thumbSelectors: ['.item.thumb[data-video-card-id]', '.item[data-video-card-id]', '.video-card[data-video-card-id]'],
    thumbContainerSelector: '.wrap_image, .img.wrap_image',
    idExtractor: (el) => {
      if (el.dataset?.videoCardId) return el.dataset.videoCardId;
      const link = el.querySelector('a[href*="/video/"]');
      if (link) {
        const match = link.href.match(/\/video\/(\d+)/);
        if (match) return match[1];
      }
      return null;
    },
    postPageUrl: (postId) => `/video/${postId}/video/`,
    observerTarget: '#custom_list_videos_most_recent_videos_items, .list-videos, .thumbs, #content, body'
  }
};

/**
 * Find the site config for the current hostname
 * @returns {{config: SiteConfig, key: string}|null}
 */
function findSiteConfig() {
  const hostname = window.location.hostname;
  
  for (const [key, config] of Object.entries(SITE_CONFIGS)) {
    if (hostname.includes(key)) {
      return { config, key };
    }
  }
  
  return null;
}

/**
 * Map a hostname or site name to a normalized short key used in collected post keys
 * @param {string} hostOrSite
 * @returns {string|null}
 */
function getSiteShortKey(hostOrSite) {
  if (!hostOrSite) return null;
  const s = String(hostOrSite).toLowerCase();
  if (s.includes('donmai') || s.includes('danbooru')) return 'danbooru';
  if (s.includes('gelbooru')) return 'gelbooru';
  if (s.includes('rule34video')) return 'rule34video';
  if (s.includes('rule34')) return 'rule34';
  if (s.includes('sankaku')) return 'sankaku';
  if (s.includes('konachan')) return 'konachan';
  if (s.includes('yande.re') || s.includes('yandere')) return 'yandere';
  return null;
}

/**
 * Build a normalized post key (e.g. "rule34:18983120", "danbooru:11835852")
 * @param {string} hostOrSite
 * @param {string|number} postId
 * @returns {string|null}
 */
function buildPostKey(hostOrSite, postId) {
  if (!postId) return null;
  const siteKey = getSiteShortKey(hostOrSite);
  if (!siteKey) return null;
  return `${siteKey}:${String(postId).trim()}`;
}

// Export for use in other modules
window.SITE_CONFIGS = SITE_CONFIGS;
window.findSiteConfig = findSiteConfig;
window.getSiteShortKey = getSiteShortKey;
window.buildPostKey = buildPostKey;

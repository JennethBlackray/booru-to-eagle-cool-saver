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
    observerTarget: '#posts-container'
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

// Export for use in other modules
window.SITE_CONFIGS = SITE_CONFIGS;
window.findSiteConfig = findSiteConfig;
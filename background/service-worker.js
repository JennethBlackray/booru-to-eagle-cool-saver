/**
 * Booru to Eagle Saver - Background Service Worker
 * 
 * Architecture:
 * - Order is captured IMMEDIATELY at click time
 * - Downloads run in parallel (one per task)
 * - Saves run sequentially in FIFO order (order captured at click)
 * - Keep-alive alarm prevents Chrome from killing the worker during long downloads
 */
importScripts('../content/blockhash.js');
const EAGLE_API_URL = 'http://localhost:41595';
const DOWNLOAD_TIMEOUT_MS = 360000; // 6 minutes
const DOWNLOAD_WAIT_TIMEOUT_MS = 300000; // 5 minutes
const SAVE_DELAY_MS = 300;
// ==================== RULE34 CONFIGURATION ====================
// Inline configuration for rule34 handling
// (config.js is not available in background context)
const RULE34_CONFIG_BG = {
  MIN_REQUEST_INTERVAL: 800,
  RETRY_DELAY_429: 3000,
  RETRY_DELAY_CAPTCHA: 5000,
  MAX_RETRIES: 5
};
// ==================== RATE LIMITER & BLOCKER DETECTION ====================
/**
 * Rate limiter for rule34.xxx requests
 * Tracks last request time per domain to avoid 429 rate limiting
 */
class RateLimiter {
  constructor() {
    /** @type {Map<string, number>} Domain -> last request timestamp */
    this.lastRequestTime = new Map();
    /** @type {Map<string, number>} Domain -> current delay multiplier */
    this.delayMultiplier = new Map();
  }
  /**
   * Wait if needed to respect rate limits for a domain
   * @param {string} hostname - The domain to rate limit
   * @param {number} [minInterval=RULE34_CONFIG_BG.MIN_REQUEST_INTERVAL] - Minimum interval in ms
   * @returns {Promise<void>}
   */
  async waitIfNeeded(hostname, minInterval = RULE34_CONFIG_BG.MIN_REQUEST_INTERVAL) {
    const lastTime = this.lastRequestTime.get(hostname) || 0;
    const elapsed = Date.now() - lastTime;
    
    if (elapsed < minInterval) {
      const waitTime = minInterval - elapsed;
      console.log(`[RateLimiter] Waiting ${waitTime}ms before next request to ${hostname}`);
      await delay(waitTime);
    }
    
    this.lastRequestTime.set(hostname, Date.now());
  }
  /**
   * On 429, increase delay multiplier
   * @param {string} hostname
   */
  onRateLimited(hostname) {
    const current = this.delayMultiplier.get(hostname) || 1;
    const next = Math.min(current * 2, 8); // Max 8x multiplier
    this.delayMultiplier.set(hostname, next);
    // Also set lastRequestTime further in the past to enforce longer wait
    this.lastRequestTime.set(hostname, Date.now() - RULE34_CONFIG_BG.MIN_REQUEST_INTERVAL + (RULE34_CONFIG_BG.RETRY_DELAY_429 * current));
    console.log(`[RateLimiter] Rate limited on ${hostname}, multiplier: ${next}x`);
  }
  /**
   * On CAPTCHA, increase delay multiplier
   * @param {string} hostname
   */
  onCaptchaDetected(hostname) {
    const current = this.delayMultiplier.get(hostname) || 1;
    const next = Math.min(current * 2, 8);
    this.delayMultiplier.set(hostname, next);
    this.lastRequestTime.set(hostname, Date.now() - RULE34_CONFIG_BG.MIN_REQUEST_INTERVAL + (RULE34_CONFIG_BG.RETRY_DELAY_CAPTCHA * current));
    console.log(`[RateLimiter] CAPTCHA on ${hostname}, multiplier: ${next}x`);
  }
  /**
   * On success, gradually decrease multiplier
   * @param {string} hostname
   */
  onSuccess(hostname) {
    const current = this.delayMultiplier.get(hostname) || 1;
    if (current > 1) {
      const next = Math.max(current / 2, 1);
      this.delayMultiplier.set(hostname, next);
    }
  }
  /**
   * Reset multiplier for a domain
   * @param {string} hostname
   */
  reset(hostname) {
    this.delayMultiplier.delete(hostname);
    this.lastRequestTime.delete(hostname);
  }
}
/** Global rate limiter instance */
const rateLimiter = new RateLimiter();
// ==================== COLLECTED / DOWNLOADED DATABASE ====================
/** @type {Set<string>} Set of normalized post keys ("siteKey:postId", e.g., "rule34:18983120") */
const collectedPostsSet = new Set();
/** @type {Array<Object>} List of Eagle items with pHash */
let pHashItems = [];
/** @type {Uint32Array|null} Flat buffer of all 256-bit pHashes (8x Uint32 per item) */
let pHashUint32Buffer = null;
/** @type {Map<string, Object>} postKey -> Eagle item */
const postToEagleItem = new Map();
/** @type {Map<string, Object>} eagleItemId -> Eagle item */
const eagleIdToItem = new Map();
/** @type {Promise<void>|null} */
let collectedDbReadyPromise = null;
/** @type {number} Timestamp of last Eagle API sync */
let lastEagleSyncTime = 0;
function rebuildPHashUint32Buffer() {
  const N = pHashItems.length;
  pHashUint32Buffer = new Uint32Array(N * 8);
  for (let i = 0; i < N; i++) {
    const uintArr = BlockHash.hexToUint32s(pHashItems[i].pHash);
    if (uintArr) {
      pHashUint32Buffer.set(uintArr, i * 8);
    }
  }
  console.log(`[CollectedDB] Rebuilt pHash buffer with ${N} items`);
}
/**
 * Perceptual hash similarity threshold (0.88 = 88% similarity, allows up to ~12% difference / max 30 bits out of 256).
 * This covers visual variants, alternate outfits/expressions, and recompressed images.
 */
const PHASH_SIMILARITY_THRESHOLD = 0.88;

function findBestPHashMatch(queryHex, threshold = PHASH_SIMILARITY_THRESHOLD) {
  if (!pHashUint32Buffer || pHashItems.length === 0 || !queryHex) return null;
  const q = BlockHash.hexToUint32s(queryHex);
  if (!q) return null;
  const N = pHashItems.length;
  const maxAllowedDist = Math.floor((1 - threshold) * 256);
  let bestDist = 256;
  let bestIdx = -1;
  for (let i = 0; i < N; i++) {
    const d = BlockHash.hammingDistance(q, pHashUint32Buffer, i * 8);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
      if (d === 0) break;
    }
  }
  if (bestDist <= maxAllowedDist && bestIdx !== -1) {
    const item = pHashItems[bestIdx];
    const similarity = (1 - (bestDist / 256)) * 100;
    return { item, similarity, distance: bestDist };
  }
  return null;
}
/**
 * Image hosts behind a Cloudflare challenge for requests made outside the page (HTTP 403 + HTML),
 * mapped to an open mirror that serves the same paths. Pages keep using the original host.
 * rule34: thumbnails are embedded from wimg.rule34.xxx; api-cdn.rule34.xxx serves the same files
 * (the rule34 parser uses the same mirror for originals).
 */
const BACKGROUND_FETCH_HOST_REWRITES = [
  { pattern: /^https?:\/\/(?!api-cdn\.)[^/]*rule34\.xxx\//i, replacement: 'https://api-cdn.rule34.xxx/' }
];
/**
 * @param {string} url
 * @returns {string} URL the service worker can actually download
 */
function toBackgroundFetchableUrl(url) {
  for (const { pattern, replacement } of BACKGROUND_FETCH_HOST_REWRITES) {
    if (pattern.test(url)) return url.replace(pattern, replacement);
  }
  return url;
}
/**
 * Fetch an image in the background and compute its 256-bit pHash + block brightness levels.
 * Cookies are sent on the first attempt: CDNs behind Cloudflare (e.g. cdn.donmai.us)
 * answer cookie-less requests with a 403 "challenge" page, while the browser session
 * already holds the clearance cookie. Falls back to a cookie-less request.
 * @param {string} url
 * @param {string|null} [referrer=null] Page URL the thumbnail belongs to
 * @returns {Promise<{pHash: string, blocks: string}|null>}
 */
async function computeFingerprintFromUrlBg(url, referrer = null) {
  if (!url) return null;
  const fetchUrl = toBackgroundFetchableUrl(url);
  for (const credentials of ['include', 'omit']) {
    try {
      const opts = { credentials, signal: AbortSignal.timeout(6000) };
      if (referrer) opts.referrer = referrer;
      const response = await fetch(fetchUrl, opts);
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) continue; // challenge / error page
      const blob = await response.blob();
      return await BlockHash.computeBlobFingerprint(blob);
    } catch (e) {
      // try next credentials mode
    }
  }
  return null;
}
/**
 * @param {string} url
 * @param {string|null} [referrer=null]
 * @returns {Promise<string|null>}
 */
async function computePHashFromUrlBg(url, referrer = null) {
  return (await computeFingerprintFromUrlBg(url, referrer))?.pHash || null;
}
/** Max thumbnails whose pHash is remembered (LRU) */
const THUMB_PHASH_CACHE_MAX = 5000;
/** A failed thumbnail fetch is retried only after this delay */
const THUMB_PHASH_RETRY_MS = 120000;
/** @type {Map<string, {promise: Promise<{pHash: string, blocks: string}|null>, failedAt: number}>} thumbUrl -> fingerprint */
const thumbPHashCache = new Map();
/**
 * Cached computeFingerprintFromUrlBg: every recheck of a page (sync, save, tab switch) would otherwise
 * re-download all of its thumbnails. Concurrent requests for one URL share a single fetch.
 * @param {string} url
 * @param {string|null} [referrer=null]
 * @returns {Promise<{pHash: string, blocks: string}|null>}
 */
function getThumbFingerprintBg(url, referrer = null) {
  if (!url) return Promise.resolve(null);
  const hit = thumbPHashCache.get(url);
  if (hit && !(hit.failedAt && Date.now() - hit.failedAt > THUMB_PHASH_RETRY_MS)) {
    // Refresh LRU position
    thumbPHashCache.delete(url);
    thumbPHashCache.set(url, hit);
    return hit.promise;
  }
  const entry = { promise: null, failedAt: 0 };
  entry.promise = computeFingerprintFromUrlBg(url, referrer).then(fp => {
    if (!fp) entry.failedAt = Date.now();
    return fp;
  });
  thumbPHashCache.delete(url);
  thumbPHashCache.set(url, entry);
  if (thumbPHashCache.size > THUMB_PHASH_CACHE_MAX) {
    thumbPHashCache.delete(thumbPHashCache.keys().next().value);
  }
  return entry.promise;
}
function normalizeSiteKeyBg(hostOrSite) {
  if (!hostOrSite) return null;
  const h = String(hostOrSite).toLowerCase();
  if (h.includes('sankaku')) return 'sankaku';
  if (h.includes('donmai') || h.includes('danbooru')) return 'danbooru';
  if (h.includes('gelbooru')) return 'gelbooru';
  if (h.includes('konachan')) return 'konachan';
  if (h.includes('rule34video')) return 'rule34video';
  if (h.includes('rule34')) return 'rule34';
  if (h.includes('yande.re') || h.includes('yandere')) return 'yandere';
  return null;
}
function buildPostKeyBg(hostOrSite, postId) {
  const siteKey = normalizeSiteKeyBg(hostOrSite);
  if (!siteKey || !postId) return null;
  return `${siteKey}:${String(postId).trim()}`;
}
function extractPostKeyFromUrlBg(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    let m;
    if (u.includes('rule34video.com')) {
      m = u.match(/\/video[s]?\/(\d+)/i);
      if (m) return `rule34video:${m[1]}`;
    } else if (u.includes('rule34.xxx')) {
      m = u.match(/[?&]id=(\d+)/i) || u.match(/\/post\/view\/(\d+)/i);
      if (m) return `rule34:${m[1]}`;
    } else if (u.includes('donmai.us')) {
      m = u.match(/\/posts\/(\d+)/i);
      if (m) return `danbooru:${m[1]}`;
    } else if (u.includes('sankakucomplex.com')) {
      m = u.match(/\/posts\/(?:show\/)?([a-zA-Z0-9]+)/i) || u.match(/[?&]id=([a-zA-Z0-9]+)/i);
      if (m) return `sankaku:${m[1]}`;
    } else if (u.includes('gelbooru.com')) {
      m = u.match(/[?&]id=(\d+)/i) || u.match(/\/post\/show\/(\d+)/i);
      if (m) return `gelbooru:${m[1]}`;
    } else if (u.includes('yande.re')) {
      m = u.match(/\/post\/show\/(\d+)/i);
      if (m) return `yandere:${m[1]}`;
    } else if (u.includes('konachan.')) {
      m = u.match(/\/post\/show\/(\d+)/i);
      if (m) return `konachan:${m[1]}`;
    }
  } catch (e) {}
  return null;
}
/**
 * Sync active posts and pHashes with live Eagle API.
 * If authoritative=true, removes any posts or pHash items that were deleted from Eagle.
 */
const recentlySavedPosts = new Map();
/** How long an unresolved temporary `saved_*` pHash item is kept while Eagle is still importing it */
const TEMP_PHASH_ITEM_TTL_MS = 180000;
/**
 * Reconcile a list of pHash items with the live Eagle library.
 * Eagle's /api/item/addFromURL does NOT return the new item ID, so freshly saved items
 * get a temporary `saved_<ts>` ID. Instead of purging them, resolve them to the real
 * Eagle ID via their postKey (Eagle stores the post page as the item URL).
 * The same applies to items whose old ID was trashed but the post was re-downloaded.
 * @returns {{list: Array<Object>, remapped: number}}
 */
function reconcilePHashListWithLive(list, liveIds, livePostKeyToId, nowTs) {
  const result = [];
  const seenIds = new Set();
  let remapped = 0;
  if (!Array.isArray(list)) return { list: result, remapped };
  // Pass 1: items already pointing at a live Eagle ID
  for (const it of list) {
    if (it && it.id && liveIds.has(it.id) && !seenIds.has(it.id)) {
      result.push(it);
      seenIds.add(it.id);
    }
  }
  // Pass 2: temporary / stale IDs -> resolve by postKey (newest saved entries first)
  const pending = list
    .filter(it => it && it.id && !liveIds.has(it.id))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  for (const it of pending) {
    const realId = it.postKey ? livePostKeyToId.get(it.postKey) : null;
    if (realId) {
      if (!seenIds.has(realId)) {
        it.id = realId;
        result.push(it);
        seenIds.add(realId);
        remapped++;
      }
      continue;
    }
    // Not yet visible in Eagle (still importing) -> keep for a while
    if (String(it.id).startsWith('saved_') && (nowTs - (it.savedAt || 0) < TEMP_PHASH_ITEM_TTL_MS)) {
      result.push(it);
    }
  }
  return { list: result, remapped };
}
/** @type {Promise<void>} Tail of the chrome.storage read-modify-write chain */
let storageWriteChain = Promise.resolve();
/**
 * Serialize read-modify-write operations on chrome.storage lists (customPostList / customPHashList):
 * two overlapping "get list -> push -> set list" calls would otherwise silently drop one entry.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withStorageLock(fn) {
  const run = storageWriteChain.then(fn, fn);
  storageWriteChain = run.then(() => {}, () => {});
  return run;
}
/** chrome.storage key: path of the Eagle library the collected data belongs to */
const HOME_LIBRARY_KEY = 'eagle-home-library';
/** Share of known Eagle IDs that must be present for an unfamiliar library path to count as the same (moved) library */
const SAME_LIBRARY_MIN_OVERLAP = 0.5;
/** Below this many known items there is too little to protect to block a sync */
const SYNC_GUARD_MIN_KNOWN = 20;
function normalizeLibraryPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
/**
 * Decide whether an authoritative sync may purge local data based on this Eagle item list.
 * Deletions are synced only against the library the data came from: another open library,
 * or an empty list while Eagle is still loading, would otherwise wipe every saved post/pHash.
 * @param {Set<string>} liveIds - IDs of non-deleted items in the live list
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function checkAuthoritativeSyncSafety(liveIds) {
  const knownIds = pHashItems.map(it => it.id).filter(id => id && !String(id).startsWith('saved_'));
  if (liveIds.size === 0 && (knownIds.length > 0 || collectedPostsSet.size > 0)) {
    return { ok: false, reason: 'Eagle returned an empty library (still loading?)' };
  }
  let livePath = null;
  try {
    const res = await fetch(`${EAGLE_API_URL}/api/library/info`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) livePath = (await res.json())?.data?.library?.path || null;
  } catch (e) {}
  const stored = await chrome.storage.local.get(HOME_LIBRARY_KEY);
  const homePath = stored[HOME_LIBRARY_KEY] || null;
  if (livePath && homePath && normalizeLibraryPath(homePath) === normalizeLibraryPath(livePath)) {
    return { ok: true };
  }
  // Unknown or different library path: Eagle item IDs are unique per library, so a low overlap
  // with the IDs we know means another library; a high one means the same library was moved/renamed
  if (knownIds.length >= SYNC_GUARD_MIN_KNOWN) {
    const overlap = knownIds.filter(id => liveIds.has(id)).length / knownIds.length;
    if (overlap < SAME_LIBRARY_MIN_OVERLAP) {
      return { ok: false, reason: `Eagle has another library open (${livePath || 'unknown path'}), only ${Math.round(overlap * 100)}% of known items found` };
    }
  }
  if (livePath) {
    await chrome.storage.local.set({ [HOME_LIBRARY_KEY]: livePath });
  }
  return { ok: true };
}
async function syncFromEagleApiBg(authoritative = false) {
  try {
    const response = await fetch(`${EAGLE_API_URL}/api/item/list?limit=10000000`, {
      method: 'GET',
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return { connected: false };
    const json = await response.json();
    if (!Array.isArray(json?.data)) return { connected: false };
    const items = json.data;
    if (authoritative) {
      const liveIdSet = new Set(items.filter(it => it && it.id && !it.isDeleted).map(it => it.id));
      const safety = await checkAuthoritativeSyncSafety(liveIdSet);
      if (!safety.ok) {
        console.warn(`[CollectedDB] Sync skipped to protect local data: ${safety.reason}`);
        return { connected: true, changed: false, skipped: true, reason: safety.reason };
      }
    }
    const livePosts = new Set();
    const liveIds = new Set();
    /** postKey -> newest live Eagle item ID (used to resolve temporary `saved_*` IDs) */
    const livePostKeyToId = new Map();
    const livePostKeyTime = new Map();
    for (const item of items) {
      if (item.isDeleted) continue;
      const pk = item.url ? extractPostKeyFromUrlBg(item.url) : null;
      if (pk) {
        livePosts.add(pk);
        if (item.id) {
          const t = item.btime || item.modificationTime || 0;
          if (!livePostKeyToId.has(pk) || t > (livePostKeyTime.get(pk) || 0)) {
            livePostKeyToId.set(pk, item.id);
            livePostKeyTime.set(pk, t);
          }
        }
      }
      if (item.id) liveIds.add(item.id);
    }
    // Keep recently saved posts (e.g. large videos still downloading in Eagle via addFromURL)
    const nowTs = Date.now();
    for (const [pk, savedAt] of recentlySavedPosts.entries()) {
      if (nowTs - savedAt < 90000) {
        livePosts.add(pk);
      } else {
        recentlySavedPosts.delete(pk);
      }
    }
    let changed = false;
    if (authoritative) {
      if (collectedPostsSet.size !== livePosts.size) {
        changed = true;
      } else {
        for (const pk of livePosts) {
          if (!collectedPostsSet.has(pk)) {
            changed = true;
            break;
          }
        }
      }
      collectedPostsSet.clear();
      for (const pk of livePosts) {
        collectedPostsSet.add(pk);
      }
      // Purge deleted items from pHashItems, resolving temporary/stale IDs to live Eagle IDs by postKey
      const prevPHashCount = pHashItems.length;
      const nowTsSync = Date.now();
      const reconciled = reconcilePHashListWithLive(pHashItems, liveIds, livePostKeyToId, nowTsSync);
      pHashItems = reconciled.list;
      if (reconciled.remapped > 0) {
        console.log(`[CollectedDB] Resolved ${reconciled.remapped} pHash item(s) to real Eagle IDs via postKey`);
      }
      if (pHashItems.length !== prevPHashCount || reconciled.remapped > 0) {
        changed = true;
      }
      postToEagleItem.clear();
      eagleIdToItem.clear();
      for (const it of pHashItems) {
        if (it.postKey) postToEagleItem.set(it.postKey, it);
        if (it.id) eagleIdToItem.set(it.id, it);
      }
      rebuildPHashUint32Buffer();
      // Clean up customPostList & customPHashList in chrome.storage.local
      try {
        await withStorageLock(async () => {
          const stored = await chrome.storage.local.get(['customPostList', 'customPHashList']);
          const updatedPosts = Array.isArray(stored.customPostList)
            ? stored.customPostList.filter(p => livePosts.has(p))
            : [];
          const updatedPHash = reconcilePHashListWithLive(stored.customPHashList, liveIds, livePostKeyToId, nowTsSync).list;
          await chrome.storage.local.set({ customPostList: updatedPosts, customPHashList: updatedPHash });
        });
      } catch (e) {}
    } else {
      for (const pk of livePosts) {
        if (!collectedPostsSet.has(pk)) {
          collectedPostsSet.add(pk);
          changed = true;
        }
      }
    }
    lastEagleSyncTime = Date.now();
    console.log(`[CollectedDB] Synced with Eagle API (authoritative=${authoritative}): ${collectedPostsSet.size} posts, ${pHashItems.length} pHash items (changed=${changed})`);
    // Broadcast only real changes: every broadcast makes each open tab recheck all of its thumbnails
    if (changed) {
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'collectedCacheUpdated'
          }).catch(() => {});
        });
      });
    }
    return { connected: true, changed, postsCount: collectedPostsSet.size, pHashCount: pHashItems.length };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}
/**
 * Load downloaded-db.json from extension directory into Sets/Map/pHash buffer
 */
async function loadBundledDbFile() {
  try {
    const dbUrl = chrome.runtime.getURL('downloaded-db.json');
    const res = await fetch(dbUrl, { cache: 'no-store' });
    if (!res.ok) return false;
    const db = await res.json();
    if (Array.isArray(db.posts)) {
      for (const p of db.posts) collectedPostsSet.add(p);
    }
    if (Array.isArray(db.items)) {
      pHashItems = [];
      postToEagleItem.clear();
      eagleIdToItem.clear();
      for (const item of db.items) {
        if (item && item.pHash && item.pHash.length === 64) {
          pHashItems.push(item);
          if (item.postKey) {
            postToEagleItem.set(item.postKey, item);
          }
          if (item.id) {
            eagleIdToItem.set(item.id, item);
          }
        }
      }
      rebuildPHashUint32Buffer();
    }
    console.log(`[CollectedDB] Loaded from downloaded-db.json: ${collectedPostsSet.size} posts, ${pHashItems.length} pHash items`);
    return true;
  } catch (e) {
    console.warn('[CollectedDB] Could not load downloaded-db.json:', e.message);
    return false;
  }
}
/**
 * Initialize the in-memory database of collected posts and pHashes
 */
/**
 * Safely extract real Eagle item ID from any API response format
 * (/api/item/addFromURL and /api/item/addFromPath)
 */
function extractEagleIdFromResult(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (result.eagleId && typeof result.eagleId === 'string') return result.eagleId;
  const d = result.data;
  if (!d) return null;
  if (typeof d === 'string') return d;
  if (d.data && typeof d.data === 'string') return d.data;
  if (d.data?.id && typeof d.data.id === 'string') return d.data.id;
  if (d.id && typeof d.id === 'string') return d.id;
  return null;
}

/**
 * Persist newly calculated pHash item to chrome.storage.local
 * so it survives service worker suspensions and browser restarts.
 */
async function saveCustomPHashItem(item) {
  if (!item || !item.pHash) return;
  try {
    await withStorageLock(async () => {
      const stored = await chrome.storage.local.get(['customPHashList']);
      const list = Array.isArray(stored.customPHashList) ? stored.customPHashList : [];
      const idx = list.findIndex(it => (it.id && item.id && it.id === item.id) || (it.postKey && item.postKey && it.postKey === item.postKey));
      if (idx !== -1) {
        list[idx] = item;
      } else {
        list.push(item);
      }
      await chrome.storage.local.set({ customPHashList: list });
    });
    console.log(`[CollectedDB] Persisted pHash item to storage: ${item.id} (${item.postKey})`);
  } catch (e) {
    console.warn('[CollectedDB] Failed to persist pHash item to storage:', e);
  }
}

async function ensureCollectedDatabase() {
  if (collectedDbReadyPromise) {
    return collectedDbReadyPromise;
  }
  collectedDbReadyPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get(['customPostList', 'customPHashList']);
      // 1. Load downloaded-db.json
      await loadBundledDbFile();
      // 2. Load any newly saved posts and pHashes from chrome.storage.local
      if (Array.isArray(stored.customPostList)) {
        for (const p of stored.customPostList) collectedPostsSet.add(p);
      }
      if (Array.isArray(stored.customPHashList)) {
        for (const it of stored.customPHashList) {
          if (it && it.pHash && it.pHash.length === 64) {
            const existingIdx = pHashItems.findIndex(p => p.id === it.id);
            if (existingIdx !== -1) {
              pHashItems[existingIdx] = it;
            } else {
              pHashItems.push(it);
            }
            if (it.postKey) postToEagleItem.set(it.postKey, it);
            if (it.id) eagleIdToItem.set(it.id, it);
          }
        }
        rebuildPHashUint32Buffer();
      }
      console.log(`[CollectedDB] Initialized: ${collectedPostsSet.size} posts, ${pHashItems.length} pHash items`);
      // 3. Auto-sync with live Eagle API on startup
      await syncFromEagleApiBg(true);
    } catch (e) {
      console.error('[CollectedDB] Init error:', e);
    }
  })();
  return collectedDbReadyPromise;
}
/**
 * Record a newly saved postKey into memory + chrome.storage.local
 */
async function recordCollectedItem({ postKey = null, postId = null, broadcast = true }) {
  await ensureCollectedDatabase();
  let addedPost = false;
  if (postKey) {
    recentlySavedPosts.set(postKey, Date.now());
    if (!collectedPostsSet.has(postKey)) {
      collectedPostsSet.add(postKey);
      addedPost = true;
    }
  }
  if (addedPost) {
    try {
      await withStorageLock(async () => {
        const stored = await chrome.storage.local.get(['customPostList']);
        const postList = Array.isArray(stored.customPostList) ? stored.customPostList : [];
        if (!postList.includes(postKey)) {
          postList.push(postKey);
          await chrome.storage.local.set({ customPostList: postList });
        }
      });
    } catch (e) {
      console.warn('[CollectedDB] Failed to persist post:', e);
    }
  }
  if (broadcast && (postKey || postId)) {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'collectedItemAdded',
          postKey,
          postId
        }).catch(() => {});
      });
    });
  }
}
// ==================== HOTKEYS ====================
const DEFAULT_HOTKEYS = {
  'hotkey-save': 'Alt+Z',
  'hotkey-parent': 'Alt+X',
  'hotkey-stop': 'Alt+C',
  'hotkey-postsave': 'Alt+A'
};
let currentHotkeys = { ...DEFAULT_HOTKEYS };
async function loadHotkeys() {
  try {
    const stored = await chrome.storage.local.get('hotkeys');
    if (stored.hotkeys) {
      currentHotkeys = stored.hotkeys;
      console.log('[Hotkeys] Loaded from storage:', currentHotkeys);
    }
  } catch (e) {
    console.warn('[Hotkeys] Could not load hotkeys:', e);
  }
}
// ==================== EXTENSION SETTINGS ====================
let currentSettings = {
  parseNotes: true,
  yandereFix: false,
  fileNameFormat: 'postId'
};
async function loadSettingsBg() {
  try {
    const stored = await chrome.storage.local.get('settings');
    if (stored && stored.settings) {
      currentSettings = { ...currentSettings, ...stored.settings };
      console.log('[Settings] Loaded in background:', currentSettings);
    }
  } catch (e) {
    console.warn('[Settings] Failed to load settings in background:', e);
  }
}
/**
 * Extract original filename without extension from an image URL
 * @param {string} url
 * @returns {string|null}
 */
function extractOriginalFilename(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const cleanUrl = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
    const lastPart = cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1);
    const decoded = decodeURIComponent(lastPart).trim();
    if (!decoded) return null;
    const nameWithoutExt = decoded.replace(/\.[a-zA-Z0-9]{2,5}$/i, '').trim();
    return nameWithoutExt || null;
  } catch (e) {
    return null;
  }
}
/**
 * Extract a lowercase file extension from an image URL path (e.g. "jpg", "png")
 * @param {string} url
 * @returns {string}
 */
function extractFileExtension(url) {
  if (!url || typeof url !== 'string' || url.startsWith('data:')) return '';
  try {
    const path = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
    const m = path.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch (e) {
    return '';
  }
}
/**
 * Resolve the item name according to current fileNameFormat setting
 * @param {string} url
 * @param {string|number} postId
 * @param {string|null} fallbackName
 * @returns {string|undefined}
 */
function resolveSaveName(url, postId, fallbackName = null) {
  if (currentSettings.fileNameFormat === 'original') {
    const orig = extractOriginalFilename(url);
    if (orig) return orig;
  }
  if (postId) {
    return 'post_' + postId;
  }
  return fallbackName || (url ? extractOriginalFilename(url) : undefined);
}
// ==================== DOWNLOAD & SAVE QUEUE ====================
/**
 * Queue architecture:
 * 1. enqueue() - adds task to array IMMEDIATELY (order captured)
 * 2. Download starts in parallel for each task
 * 3. _processSaveQueue() waits for task[0] download, saves to Eagle, shifts, repeats
 * 
 * Task states:
 * - 'pending_parse' - Waiting for hidden tab to parse (thumbnail saves)
 * - 'pending_download' - Ready to download
 * - 'downloading' - Download in progress
 * - 'download_complete' - Ready to save
 * - 'saving' - Saving to Eagle
 * - 'completed' - Done
 * - 'failed' - Error occurred
 */
class DownloadSaveQueue {
  constructor() {
    this.tasks = [];
    this.processing = false;
    this.abortControllers = new Map();
  }
  /**
   * Add task to queue IMMEDIATELY (captures order)
   * For thumbnail saves, task starts in 'pending_parse' state
   * For post-page saves, task starts in 'pending_download' state
   */
  enqueue(taskId, tabId, url, referer, saveData, options = {}) {
    const { state = 'pending_download', base64 = null, useUrlDirect = false } = options;
    const task = {
      taskId,
      tabId,
      url,
      referer,
      saveData,
      base64,
      downloadComplete: false,
      downloadStarted: false,  // Always start as false; _startDownloadParallel sets it
      downloadError: null,
      state: state,  // Track task state explicitly
      useUrlDirect: useUrlDirect || saveData?.useUrlDirect || false
    };
    this.tasks.push(task);
    const position = this.tasks.length;
    console.log(`[Queue] Enqueued ${taskId} (position: ${position}, state: ${state}, total: ${this.tasks.length})`);
    // For useUrlDirect or already-having-base64 tasks, mark download as complete immediately
    if (task.useUrlDirect) {
      task.downloadComplete = true;
      task.downloadStarted = true;
      task.state = 'download_complete';
      console.log(`[Queue] ${taskId} uses URL direct, marking download complete`);
    } else if (base64) {
      task.downloadComplete = true;
      task.downloadStarted = true;
      task.state = 'download_complete';
      console.log(`[Queue] ${taskId} already has base64, marking download complete`);
    }
    // Start download immediately for tasks that have URL (parallel)
    if (state !== 'pending_parse') {
      this._startDownloadParallel(task);
    }
    // Start save processing (sequential - waits for downloads)
    this._ensureProcessing();
    // Keep service worker alive
    this._startKeepAlive();
    // Report queue state to content scripts
    reportQueueState();
    return { queued: true, position };
  }
  /**
   * Update a pending_parse task with parsed data from hidden tab
   * Called when hidden tab finishes parsing
   */
  updateParsedData(taskId, parsedData, base64 = null) {
    const task = this.tasks.find(t => t.taskId === taskId);
    if (!task) {
      console.warn(`[Queue] Task ${taskId} not found for update`);
      return false;
    }
    if (task.state !== 'pending_parse') {
      console.warn(`[Queue] Task ${taskId} is not in pending_parse state (current: ${task.state})`);
      return false;
    }
    // Update task with parsed data
    if (parsedData.imageUrl) {
      task.url = parsedData.imageUrl;
      if (currentSettings.fileNameFormat === 'original') {
        const origName = extractOriginalFilename(task.url);
        if (origName) {
          task.saveData.name = origName;
        }
      }
    }
    if (parsedData.tags) {
      // Merge: keep existing tags (e.g., parent:xxx) and add parsed tags
      const existingTags = task.saveData.tags || [];
      // Filter out any tags that were already in parsedData (avoid duplicates)
      const parsedSet = new Set(parsedData.tags);
      const uniqueExisting = existingTags.filter(t => !parsedSet.has(t));
      task.saveData.tags = [...uniqueExisting, ...parsedData.tags];
    }
    if (parsedData.annotation && currentSettings.parseNotes !== false) {
      task.saveData.annotation = parsedData.annotation;
    }
    if (base64) {
      task.base64 = base64;
    }
    // Mark as ready for download
    task.state = 'pending_download';
    
    // Determine if download is already complete
    // - useUrlDirect: no download needed, Eagle will fetch URL
    // - base64 present: data already available, no download needed
    if (task.useUrlDirect) {
      task.downloadComplete = true;
      task.downloadStarted = true;
      task.state = 'download_complete';
    } else if (base64 !== null) {
      task.downloadComplete = true;
      task.downloadStarted = true;
      task.state = 'download_complete';
    } else {
      // Needs actual download
      task.downloadComplete = false;
      task.downloadStarted = false;
    }
    console.log(`[Queue] Task ${taskId} updated with parsed data, state: ${task.state}, downloadComplete: ${task.downloadComplete}, useUrlDirect: ${task.useUrlDirect}, hasBase64: ${!!base64}, tags: ${JSON.stringify(task.saveData.tags?.slice(0, 10))}`);
    // Start download if we have URL and not using URL direct and no base64
    if (task.url && !task.useUrlDirect && !task.downloadComplete) {
      this._startDownloadParallel(task);
    }
    // Report queue state after update
    reportQueueState();
    return true;
  }
  /**
   * Mark task as failed (e.g., hidden tab parse failed)
   */
  markTaskFailed(taskId, error) {
    const task = this.tasks.find(t => t.taskId === taskId);
    if (!task) return false;
    task.state = 'failed';
    task.downloadError = error;
    task.downloadComplete = true;
    console.log(`[Queue] Task ${taskId} marked as failed: ${error}`);
    reportQueueState();
    return true;
  }
  /**
   * Ensure processing loop is running
   */
  _ensureProcessing() {
    if (!this.processing) {
      this.processing = true;
      this._processSaveQueue();
    }
  }
  /**
   * Start downloading a task in parallel
   * For tasks with useUrlDirect flag (gelbooru), skip download and mark as complete
   */
  async _startDownloadParallel(task) {
    console.log(`[Queue] _startDownloadParallel called for ${task.taskId}, url=${!!task.url}, useUrlDirect=${task.useUrlDirect}, hasBase64=${!!task.base64}`);
    
    if (task.downloadStarted) {
      console.log(`[Queue] ${task.taskId} download already started, skipping`);
      return;
    }
    task.downloadStarted = true;
    task.state = 'downloading';
    // For gelbooru: skip download, URL will be sent directly to Eagle during save phase
    if (task.useUrlDirect) {
      task.downloadComplete = true;
      task.state = 'download_complete';
      console.log(`[Queue] ${task.taskId} uses URL direct (gelbooru), skipping download`);
      return;
    }
    // Check if we already have base64 data (e.g., from canvas extraction)
    if (task.base64) {
      task.downloadComplete = true;
      task.state = 'download_complete';
      console.log(`[Queue] ${task.taskId} already has base64 data, skipping download`);
      return;
    }
    // Check if we have a URL to download
    if (!task.url) {
      console.warn(`[Queue] ${task.taskId} has no URL, cannot download`);
      return;
    }
    console.log(`[Queue] ${task.taskId} starting download from ${task.url.substring(0, 80)}...`);
    const abortController = new AbortController();
    this.abortControllers.set(task.taskId, abortController);
    try {
      const result = await downloadImageAsBase64({
        url: task.url,
        referer: task.referer,
        tabId: task.tabId,
        taskId: task.taskId,
        signal: abortController.signal,
        isTopQueue: () => this.tasks[0]?.taskId === task.taskId
      });
      if (result.success) {
        task.base64 = result.base64;
        task.downloadComplete = true;
        task.state = 'download_complete';
        console.log(`[Queue] Downloaded ${task.taskId} (${result.base64.length} bytes)`);
      } else if (result.error !== 'Aborted' && result.error !== 'Cancelled' && !abortController.signal.aborted && task.url) {
        console.warn(`[Queue] Browser fetch failed for ${task.taskId} (${result.error}), falling back to Eagle URL direct`);
        task.useUrlDirect = true;
        task.downloadError = null;
        task.downloadComplete = true;
        task.state = 'download_complete';
      } else {
        task.downloadError = result.error;
        task.downloadComplete = true;
        task.state = 'failed';
        console.error(`[Queue] Download failed ${task.taskId}: ${result.error}`);
      }
    } catch (error) {
      if (error.name !== 'AbortError' && !abortController.signal.aborted && task.url) {
        console.warn(`[Queue] Download exception for ${task.taskId} (${error.message}), falling back to Eagle URL direct`);
        task.useUrlDirect = true;
        task.downloadError = null;
        task.downloadComplete = true;
        task.state = 'download_complete';
      } else {
        task.downloadError = error.name === 'AbortError' ? 'Cancelled' : error.message;
        task.downloadComplete = true;
        task.state = 'failed';
        console.error(`[Queue] Download exception ${task.taskId}:`, error);
      }
    } finally {
      this.abortControllers.delete(task.taskId);
    }
  }
  /**
   * Update progress display for top-of-queue task
   */
  _updateTopQueueProgress() {
    if (this.tasks.length === 0) {
      reportDownloadProgress(0, null, null, null);
      return;
    }
    const topTask = this.tasks[0];
    if (topTask.state === 'pending_parse') {
      reportDownloadProgress(0, 'Preparing...', topTask.taskId, 1);
    } else if (topTask.downloadComplete) {
      if (this.tasks.length > 1) {
        const nextTask = this.tasks[1];
        reportDownloadProgress(0, 'Saving...', nextTask.taskId, 1);
      } else {
        reportDownloadProgress(0, null, null, null);
      }
    } else if (!topTask.downloadStarted) {
      reportDownloadProgress(0, 'Preparing...', topTask.taskId, 1);
    } else {
      reportDownloadProgress(0, 'Saving...', topTask.taskId, 1);
    }
  }
  /**
   * Process save queue sequentially in FIFO order
   */
  async _processSaveQueue() {
    console.log(`[Queue] _processSaveQueue started, ${this.tasks.length} tasks`);
    // Track how long we've been waiting for pending_parse tasks
    const pendingParseStartTime = new Map();
    while (this.tasks.length > 0) {
      const task = this.tasks[0];
      // Skip tasks that are still waiting for hidden tab to parse
      if (task.state === 'pending_parse') {
        // Track how long we've been waiting
        if (!pendingParseStartTime.has(task.taskId)) {
          pendingParseStartTime.set(task.taskId, Date.now());
        }
        const waitTime = Date.now() - pendingParseStartTime.get(task.taskId);
        if (waitTime > 120000) { // 120 second timeout for parsing (rule34 may need retries)
          task.state = 'failed';
          task.downloadError = 'Parse timeout (30s)';
          task.downloadComplete = true;
          console.warn(`[Queue] Task ${task.taskId} timed out waiting for parse`);
          continue;
        }
        // Wait a bit and check again (don't block the queue, just poll)
        await delay(200);
        continue;
      }
      // Clear parse tracking when we move past this task
      pendingParseStartTime.delete(task.taskId);
      // Skip failed tasks
      if (task.state === 'failed') {
        this._sendResult(task, false, task.downloadError || 'Parse failed');
        this.tasks.shift();
        this._updateTopQueueProgress();
        reportQueueState();
        continue;
      }
      // Wait for download to complete (with timeout)
      if (!task.downloadComplete) {
        const completed = await this._waitForDownloadWithProgress(task);
        if (!completed) {
          task.downloadError = 'Download timeout (5 min)';
          task.downloadComplete = true;
        }
      }
      // Handle download failure
      if (task.downloadError) {
        this._sendResult(task, false, `Download failed: ${task.downloadError}`);
        this.tasks.shift();
        this._updateTopQueueProgress();
        reportQueueState();
        continue;
      }
      // Send to Eagle (90-99%)
      reportDownloadProgress(90, 'Saving to Eagle...', task.taskId, 1);
      if (task.saveData?.replaceEagleId) {
        await mergeReplacedItemMetadata(task.saveData);
      }

      let result;
      try {
        const finalSaveName = resolveSaveName(task.url, task.saveData?.postId, task.saveData?.name);
        if (task.localFilePath) {
          console.log(`[Queue] ${task.taskId} saving via local file path: ${task.localFilePath} (name: ${finalSaveName})`);
          result = await saveToEaglePath({ ...task.saveData, path: task.localFilePath, name: finalSaveName });
          if (task.downloadId) {
            chrome.downloads.removeFile(task.downloadId).catch(() => {});
            chrome.downloads.erase({ id: task.downloadId }).catch(() => {});
          }
        } else if (task.useUrlDirect) {
          // Gelbooru: send URL directly to Eagle (no CORS issues for desktop app)
          console.log(`[Queue] ${task.taskId} saving via URL direct (name: ${finalSaveName})`);
          result = await saveToEagleURL({ ...task.saveData, url: task.url, name: finalSaveName });
        } else {
          // Standard: save base64
          console.log(`[Queue] ${task.taskId} saving via base64 (name: ${finalSaveName})`);
          result = await saveToEagleBase64({ ...task.saveData, base64: task.base64, originalUrl: task.url, name: finalSaveName });
        }
      } catch (saveError) {
        // Safety net: catch any unexpected errors during save (should not happen
        // now that save functions are safe, but protects against runtime weirdness)
        console.error(`[Queue] Unexpected save error for ${task.taskId}:`, saveError);
        result = { success: false, error: saveError.message || 'Unknown save error' };
      }
      
      // Report 100% on success
      if (result.success) {
        reportDownloadProgress(100, 'Saved!', task.taskId, 1);
        // If replacing an old lower-resolution item, trash it now
        if (task.saveData?.replaceEagleId) {
          const oldId = task.saveData.replaceEagleId;
          fetch(`${EAGLE_API_URL}/api/item/moveToTrash`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemIds: [oldId] })
          }).then(() => {
            console.log(`[Eagle Replace] Successfully trashed old duplicate item: ${oldId}`);
            const idx = pHashItems.findIndex(it => it.id === oldId);
            if (idx !== -1) {
              pHashItems.splice(idx, 1);
              rebuildPHashUint32Buffer();
            }
          }).catch(e => {
            console.warn('[Eagle Replace] Failed to trash old item:', e);
          });
        }
        // Record saved post ID in the collected database
        const savedPostId = task.saveData?.postId || extractPostIdFromTaskId(task.taskId);
        const savedPostKey = buildPostKeyBg(task.saveData?.site || task.referer || task.saveData?.website, savedPostId)
          || extractPostKeyFromUrlBg(task.referer || task.saveData?.website);
        
        // Extract real Eagle ID from save result
        const realEagleId = extractEagleIdFromResult(result);

        recordCollectedItem({
          postKey: savedPostKey,
          postId: savedPostId ? String(savedPostId) : null,
          broadcast: true
        }).catch(() => {});

        // Compute and store pHash for the newly saved item (supports both base64 and url direct)
        if (typeof BlockHash !== 'undefined') {
          (async () => {
            try {
              let pHash = null;
              let blocks = null;
              let origW = task.saveData?.width || 0;
              let origH = task.saveData?.height || 0;
              let fileSize = 0;
              let ext = '';

              if (task.base64) {
                const res = await fetch(task.base64);
                const blob = await res.blob();
                fileSize = blob.size;
                // The downloaded Blob is untyped (application/octet-stream), so prefer the URL's extension
                const blobSubtype = blob.type.split('/')[1] || '';
                ext = extractFileExtension(task.url) || (blobSubtype && blobSubtype !== 'octet-stream' ? blobSubtype : '');
                const fullBmp = await createImageBitmap(blob);
                origW = fullBmp.width || origW;
                origH = fullBmp.height || origH;
                const fp = BlockHash.computeSourceFingerprint(fullBmp);
                pHash = fp?.pHash || null;
                blocks = fp?.blocks || null;
                fullBmp.close();
              } else if (task.url) {
                const fp = await computeFingerprintFromUrlBg(task.url, task.referer || null);
                pHash = fp?.pHash || null;
                blocks = fp?.blocks || null;
                ext = extractFileExtension(task.url);
              }

              if (pHash) {
                const newItem = {
                  id: realEagleId || `saved_${Date.now()}`,
                  pHash: pHash,
                  blocks: blocks,
                  w: origW,
                  h: origH,
                  size: fileSize,
                  ext: ext,
                  postKey: savedPostKey,
                  name: finalSaveName || (savedPostId ? `post_${savedPostId}` : undefined),
                  savedAt: Date.now()
                };
                pHashItems.push(newItem);
                if (savedPostKey) postToEagleItem.set(savedPostKey, newItem);
                if (newItem.id) eagleIdToItem.set(newItem.id, newItem);
                rebuildPHashUint32Buffer();

                // Persist to storage so it survives service worker lifecycle
                await saveCustomPHashItem(newItem);
                console.log(`[Queue] Successfully recorded & persisted pHash for: ${newItem.id} (${savedPostKey})`);
              }
            } catch (e) {
              console.warn('[Queue] Failed to compute/store pHash for newly saved item:', e);
            }
          })();
        }
      }
      
      this._sendResult(task, result.success, result.error, result.data);
      // Free memory before removing task from queue
      task.base64 = null;
      this.tasks.shift();
      console.log(`[Queue] Completed ${task.taskId}, ${this.tasks.length} remaining`);
      // Update progress for the next task in queue (if more tasks remain)
      if (this.tasks.length > 0) {
        this._updateTopQueueProgress();
      }
      // Report queue state after task removal
      reportQueueState();
      // Delay between saves
      await delay(SAVE_DELAY_MS);
    }
    // Double check for any tasks that might have been added while processing the last one
    if (this.tasks.length > 0) {
      // CRITICAL: Keep processing=true to prevent race condition with enqueue()
      // (enqueue -> _ensureProcessing checks this.processing -> skips if true)
      return this._processSaveQueue();
    }
    this.processing = false;
    this._stopKeepAlive();
    console.log('[Queue] Empty');
    // Clean up queue-state and reset save-progress when queue is completely done
    chrome.storage.local.remove('queue-state').catch(() => {});
    setTimeout(() => {
      if (this.tasks.length === 0 && !this.processing) {
        reportDownloadProgress(0, null, null, null);
        chrome.storage.local.remove('save-progress').catch(() => {});
      }
    }, 800);
  }
  /**
   * Wait for download to complete
   */
  async _waitForDownloadWithProgress(task) {
    const startTime = Date.now();
    const updateInterval = 2000;
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (task.downloadComplete) {
          clearInterval(check);
          resolve(true);
          return;
        }
        const elapsed = Date.now() - startTime;
        if (elapsed >= DOWNLOAD_WAIT_TIMEOUT_MS) {
          clearInterval(check);
          resolve(false);
          return;
        }
      }, updateInterval);
    });
  }
  /**
   * Send result to content script
   * Includes postSaveEnabled so each tab knows if IT should close
   */
  async _sendResult(task, success, error = null, data = null) {
    // Prefer sourceTabId for thumbnail saves (always valid)
    // Fall back to task.tabId for post-page saves
    let targetTabId = task.saveData?.sourceTabId || task.tabId;
    // Don't try to send if no valid tab ID
    if (!targetTabId) {
      console.warn(`[Queue] No target tab for task ${task.taskId}`);
      return;
    }
    try {
      await chrome.tabs.sendMessage(targetTabId, {
        action: 'saveResult',
        taskId: task.taskId,
        success,
        error,
        data,
        postSaveEnabled: task.saveData?.postSaveEnabled || false,
        sampleOnly: task.saveData?.sampleOnly || false
      });
    } catch {
      // Tab may be closed
    }
  }
  /**
   * Clear all tasks and abort downloads
   */
  async clear() {
    console.log(`[Queue] Clearing ${this.tasks.length} tasks`);
    for (const [, controller] of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
    for (const task of this.tasks) {
      if (task.downloadId) {
        chrome.downloads.cancel(task.downloadId).catch(() => {});
        chrome.downloads.erase({ id: task.downloadId }).catch(() => {});
      }
      // For pending_parse tasks, mark as failed so they get a result
      if (task.state === 'pending_parse') {
        task.state = 'failed';
        task.downloadError = 'Cancelled by user';
        task.downloadComplete = true;
      }
      this._sendResult(task, false, 'Cancelled by user');
    }
    this.tasks = [];
    this.processing = false;
    reportDownloadProgress(0, null);
    reportQueueState();
    // Clear queue-state from storage when queue is fully empty
    chrome.storage.local.remove('queue-state').catch(() => {});
    this._stopKeepAlive();
  }
  _startKeepAlive() {
    chrome.alarms.create('booru-eagle-keepalive', { periodInMinutes: 0.5 });
  }
  _stopKeepAlive() {
    if (this.tasks.length === 0 && !this.processing) {
      chrome.alarms.clear('booru-eagle-keepalive');
    }
  }
}
// ==================== UTILITIES ====================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function reportDownloadProgress(progress, text, taskId = null, queuePosition = null) {
  const data = {
    progress: Math.min(100, Math.max(0, progress)),
    text: text || null,
    taskId: taskId || null,
    queuePosition: queuePosition || null,
    timestamp: Date.now()
  };
  chrome.storage.local.set({ 'save-progress': data }).catch(() => {});
}
/**
 * Report full queue state to content scripts via chrome.storage.local.
 * Called whenever the queue changes (enqueue, shift, state change, clear).
 */
function reportQueueState() {
  const tasks = queue.tasks.map(t => ({
    taskId: t.taskId,
    postId: t.saveData?.postId || extractPostIdFromTaskId(t.taskId),
    state: t.state,
    progress: t.downloadComplete ? 100 : (t.useUrlDirect ? 100 : 0),
    error: t.downloadError || null
  }));
  const data = {
    tasks,
    total: queue.tasks.length,
    processing: queue.processing,
    timestamp: Date.now()
  };
  chrome.storage.local.set({ 'queue-state': data }).catch(() => {});
}
/**
 * Extract post ID from a task ID string.
 * @param {string} taskId
 * @returns {string|null}
 */
function extractPostIdFromTaskId(taskId) {
  if (!taskId) return null;
  // Hidden tab tasks: "hidden-{postId}-{timestamp}-{random}"
  if (taskId.startsWith('hidden-')) {
    const parts = taskId.split('-');
    return parts[1] || null;
  }
  return null;
}
// ==================== DOWNLOAD FUNCTIONS ====================
async function downloadImageAsBase64({ url, referer, tabId, taskId, signal, isTopQueue }) {
  if (!url) return { success: false, error: 'URL is required' };
  const log = (msg) => console.log(`[Download ${taskId || '?'}] ${msg}`);
  log(`Starting: ${url}`);
  let lastError = null;
  const isRule34Video = url.includes('rule34video.com');
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) return { success: false, error: 'Aborted' };
    try {
      if (attempt > 1) await delay(400);
      let fetchUrl = url;
      // On attempt 1, use the exact URL (modifying signed URLs like Sankaku ?e=...&m=... causes HTTP 403).
      // Only add cache-buster on retry if URL has no query signature.
      if (attempt > 1) {
        try {
          const urlObj = new URL(url);
          if (!urlObj.searchParams.has('e') && !urlObj.searchParams.has('m') && !urlObj.searchParams.has('token') && !urlObj.searchParams.has('v-acctoken') && !url.includes('rule34.xxx')) {
            urlObj.searchParams.set('_cb', Date.now().toString());
            fetchUrl = urlObj.toString();
          }
        } catch {}
      }
      const credMode = isRule34Video
        ? (attempt === 1 ? 'omit' : 'include')
        : (attempt === 1 ? 'include' : 'omit');
      const fetchOptions = {
        method: 'GET',
        credentials: credMode,
        signal: signal || AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        cache: 'no-store'
      };
      if (referer && !isRule34Video) {
        fetchOptions.referrer = referer;
      }
      const response = await fetch(fetchUrl, fetchOptions);
      if (!response.ok) {
        if (response.status === 403 && attempt === 1) {
          lastError = new Error('HTTP 403');
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      log(`Content-Length: ${contentLength} bytes`);
      // For very large files (>60MB), delegate download directly to Eagle desktop app to avoid base64 memory limits
      if (contentLength > 60 * 1024 * 1024) {
        try { response.body?.cancel(); } catch {}
        return { success: false, error: 'Large file - delegating to Eagle direct URL' };
      }
      const chunks = [];
      let receivedLength = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          if (signal?.aborted) {
            reader.cancel();
            return { success: false, error: 'Aborted' };
          }
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedLength += value.length;
          if (contentLength > 0 && taskId && (!isTopQueue || isTopQueue())) {
            const downloadPercent = Math.min(89, Math.round((receivedLength / contentLength) * 89));
            if (contentLength > 3 * 1024 * 1024) {
              const mbRec = (receivedLength / (1024 * 1024)).toFixed(1);
              const mbTotal = (contentLength / (1024 * 1024)).toFixed(1);
              reportDownloadProgress(downloadPercent, `Downloading ${mbRec}/${mbTotal}MB`, taskId);
            } else {
              reportDownloadProgress(downloadPercent, 'Saving...', taskId);
            }
          }
        }
      } catch (readError) {
        if (readError.name === 'AbortError' || signal?.aborted) {
          return { success: false, error: 'Aborted' };
        }
        throw readError;
      }
      const blob = new Blob(chunks);
      const mimeType = response.headers.get('content-type') || 'image/jpeg';
      log(`Downloaded ${blob.size} bytes, type: ${mimeType}`);
      // Free chunk memory immediately after Blob creation
      chunks.length = 0;
      if (mimeType && mimeType.includes('text/html')) {
        log('ERROR: Received HTML instead of image');
        return { success: false, error: 'Received HTML instead of image' };
      }
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ success: true, base64: reader.result, mimeType });
        reader.onerror = () => resolve({ success: false, error: 'Failed to convert to base64' });
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) {
        return { success: false, error: 'Aborted' };
      }
      lastError = error;
      if (attempt === 1) continue;
      break;
    }
  }
  return { success: false, error: lastError?.message || 'Download failed' };
}
/**
 * Fetch full item info from the live Eagle library
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function fetchEagleItemInfo(id) {
  if (!id || String(id).startsWith('saved_')) return null;
  try {
    const response = await fetch(`${EAGLE_API_URL}/api/item/info?id=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) return null;
    const json = await response.json();
    return json?.status === 'success' ? json.data : null;
  } catch (e) {
    return null;
  }
}
/** Tags that may appear only once per item: the new copy's value wins over the replaced one */
const SINGLE_VALUE_TAG_PREFIXES = ['rating:', 'parent:'];
/**
 * Carry the replaced Eagle item's user data (manual tags, parent tag, folder, rating, annotation)
 * over to the new save, so "Replace" upgrades the file without losing library organization.
 * @param {Object} saveData - Task save data (mutated)
 */
async function mergeReplacedItemMetadata(saveData) {
  if (saveData._replaceMerged) return;
  saveData._replaceMerged = true;
  const old = await fetchEagleItemInfo(saveData.replaceEagleId);
  if (!old) {
    console.warn(`[Eagle Replace] Could not read old item ${saveData.replaceEagleId}, metadata not carried over`);
    return;
  }
  const normalize = (t) => String(t).toLowerCase().replace(/_/g, ' ').trim();
  const tags = Array.isArray(saveData.tags) ? [...saveData.tags] : [];
  const seen = new Set(tags.map(normalize));
  const newPrefixes = new Set(SINGLE_VALUE_TAG_PREFIXES.filter(p => tags.some(t => normalize(t).startsWith(p))));
  for (const tag of old.tags || []) {
    const key = normalize(tag);
    const prefix = SINGLE_VALUE_TAG_PREFIXES.find(p => key.startsWith(p));
    if ((prefix && newPrefixes.has(prefix)) || seen.has(key)) continue;
    tags.push(tag);
    seen.add(key);
  }
  saveData.tags = tags;
  if (!saveData.folderId && Array.isArray(old.folders) && old.folders.length > 0) {
    saveData.folderId = old.folders[0];
  }
  if (saveData.star == null && old.star) {
    saveData.star = old.star;
  }
  if (old.annotation && old.annotation !== saveData.annotation) {
    saveData.annotation = saveData.annotation ? `${saveData.annotation}\n\n---\n${old.annotation}` : old.annotation;
  }
  console.log(`[Eagle Replace] Carried over metadata from ${old.id}: ${tags.length} tags, folder=${saveData.folderId || '-'}, star=${saveData.star || '-'}`);
}
/**
 * Save to Eagle using URL directly - Eagle downloads the image/video itself
 * Eagle is a desktop app, no CORS restrictions
 */
async function saveToEagleURL(data) {
  const { url, tags = [], name, website, annotation, referer, site, postId, folderId, star } = data;
  if (!url) return { success: false, error: 'URL is required' };
  const headers = {};
  if (referer || website) {
    headers.referer = referer || website;
  }
  try {
    const cookieUrl = referer || website || url;
    if (cookieUrl && typeof chrome !== 'undefined' && chrome.cookies) {
      const cookies = await chrome.cookies.getAll({ url: cookieUrl });
      if (cookies && cookies.length > 0) {
        headers.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    }
  } catch (e) {}
  if (typeof self !== 'undefined' && self.navigator?.userAgent) {
    headers['user-agent'] = self.navigator.userAgent;
  }
  const payload = {
    url: url,
    name: name || resolveSaveName(url, postId, name),
    tags,
    website: website || referer || '',
    annotation: annotation || undefined,
    folderId: folderId || undefined,
    star: star || undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined
  };
  Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });
  console.log(`[Eagle] Saving URL: ${url}`);
  try {
    const response = await fetch(`${EAGLE_API_URL}/api/item/addFromURL`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    const result = await response.json();
    console.log('[Eagle] URL save successful');
    return { success: true, data: result };
  } catch (error) {
    console.error('[Eagle] URL save failed:', error.message);
    return { success: false, error: error.name === 'TimeoutError' ? 'Eagle request timed out' : error.message };
  }
}
/**
 * Save file from local disk to Eagle via /api/item/addFromPath
 * Used for video downloads (rule34video) to avoid base64 memory overhead and DDoS-guard blocks
 */
async function saveToEaglePath(data) {
  const { path, tags = [], name, website, annotation, referer, site, postId, folderId } = data;
  if (!path) return { success: false, error: 'File path is required' };

  const payload = {
    path: path,
    name: name || resolveSaveName(path, postId, name),
    website: website || referer || '',
    tags: Array.isArray(tags) ? tags : []
  };
  if (annotation) {
    payload.annotation = annotation;
  }
  if (folderId) {
    payload.folderId = folderId;
  }
  
  try {
    const response = await fetch(`${EAGLE_API_URL}/api/item/addFromPath`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Eagle API HTTP ${response.status}: ${errorText}` };
    }
    
    const result = await response.json();
    if (result.status === 'success') {
      const eagleId = result.data;
      if (eagleId) {
        const siteKey = normalizeSiteKeyBg(site || referer || website);
        const postKey = siteKey && postId ? `${siteKey}:${postId}` : extractPostKeyFromUrlBg(website || referer);
        recordCollectedItem({
          postKey,
          postId: postId ? String(postId) : null,
          eagleId,
          broadcast: true
        }).catch(() => {});
      }
      return { success: true, eagleId: result.data };
    } else {
      return { success: false, error: result.message || 'Eagle rejected addFromPath' };
    }
  } catch (error) {
    return { success: false, error: `Eagle connection failed: ${error.message}` };
  }
}

async function saveToEagleBase64(data) {
  const { base64, tags = [], name, website, annotation, referer, site, postId, originalUrl, folderId, star } = data;
  if (!base64) return { success: false, error: 'Base64 data is required' };
  const payload = {
    url: base64,
    name: name || resolveSaveName(originalUrl, postId, name),
    tags,
    website: website || referer || '',
    annotation: annotation || undefined,
    folderId: folderId || undefined,
    star: star || undefined
  };
  Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });
  console.log(`[Eagle] Saving ${base64.length} bytes...`);
  try {
    const response = await fetch(`${EAGLE_API_URL}/api/item/addFromURL`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    const result = await response.json();
    console.log('[Eagle] Save successful');
    return { success: true, data: result };
  } catch (error) {
    console.error('[Eagle] Save failed:', error.message);
    return { success: false, error: error.name === 'TimeoutError' ? 'Eagle request timed out' : error.message };
  }
}
async function checkEagle() {
  try {
    const response = await fetch(`${EAGLE_API_URL}/api/item/list`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    return { connected: response.ok };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}
async function handlePostSaveAction(tabId) {
  if (!tabId) return { success: false, error: 'No tab ID' };
  try {
    await chrome.tabs.get(tabId);
    try {
      await chrome.tabs.goBack(tabId);
      return { success: true, action: 'went_back' };
    } catch {
      await chrome.tabs.remove(tabId);
      return { success: true, action: 'closed' };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}
// ==================== HIDDEN TAB SAVE ====================
/**
 * Build post page URL using site configuration
 * To add a new site, add entry to content/site-configs.js
 */
function buildPostPageUrl(hostname, postId) {
  // Site URL builders - must match site-configs.js keys
  const siteUrlBuilders = {
    'chan.sankakucomplex.com': (h, id) => `https://${h}/en/posts/${id}`,
    'danbooru.donmai.us': (h, id) => `https://${h}/posts/${id}`,
    'gelbooru.com': (h, id) => `https://${h}/index.php?page=post&s=view&id=${id}`,
    'konachan.com': (h, id) => `https://${h}/post/show/${id}`,
    'rule34.xxx': (h, id) => `https://${h}/index.php?page=post&s=view&id=${id}`,
    'rule34video.com': (h, id) => `https://${h}/video/${id}/video/`,
    'yande.re': (h, id) => `https://${h}/post/show/${id}`
  };
  
  for (const [key, builder] of Object.entries(siteUrlBuilders)) {
    if (hostname.includes(key)) {
      return builder(hostname, postId);
    }
  }
  
  throw new Error(`Unsupported site: ${hostname}`);
}
/**
 * Parse a post page in a hidden tab, download the image, and enqueue save to Eagle.
 *
 * NEW ARCHITECTURE (order preserved at click time):
 * 1. Task is added to queue IMMEDIATELY in 'pending_parse' state
 * 2. Hidden tab parses in background
 * 3. Queue updates task with parsed data when ready
 * 4. Queue processes in FIFO order
 */
async function handleHiddenTabParse(postId, hostname, sourceTabId, lockedParentId = null, replaceEagleId = null, directPostUrl = null) {
  const log = (msg) => console.log(`[HiddenTab ${postId}] ${msg}`);
  log('Starting hidden tab parse...');
  // Generate task ID IMMEDIATELY (order captured at click time)
  const taskId = `hidden-${postId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  // Build post page URL first
  const postUrl = directPostUrl || buildPostPageUrl(hostname, postId);
  // Build save data - add parent tag if lockedParentId is set
  const baseTags = [];
  if (lockedParentId) {
    baseTags.push(`parent:${lockedParentId}`);
    log(`Added parent tag: parent:${lockedParentId}`);
  }
  const saveData = {
    tags: baseTags,
    name: `post_${postId}`,
    website: postUrl,
    annotation: undefined,
    referer: postUrl,
    site: hostname,
    postId: postId,
    postSaveEnabled: false,
    sourceTabId: sourceTabId,
    replaceEagleId: replaceEagleId || null
  };
  // ENQUEUE IMMEDIATELY in 'pending_parse' state (order preserved!)
  const queueResult = queue.enqueue(
    taskId,
    null, // No hidden tab ID yet (will be set later)
    null, // No URL yet (will be filled by hidden tab)
    postUrl,
    saveData,
    { state: 'pending_parse' }
  );
  log(`Task enqueued IMMEDIATELY: position ${queueResult.position}`);
  // Now open hidden tab to parse (async, doesn't block queue order)
  _parseHiddenTabInBackground(taskId, postId, hostname, sourceTabId, lockedParentId, postUrl).catch(error => {
    log(`Background parse failed: ${error.message}`);
    queue.markTaskFailed(taskId, error.message);
  });
  // Return immediately - task is already in queue!
  return { success: true, position: queueResult.position, taskId };
}
/**
 * Background task: open hidden tab, parse, update queue task with data.
 * Includes rate limiting and retry logic for rule34.xxx to handle 429/CAPTCHA.
 * This runs asynchronously and doesn't block the queue order.
 * Queue order is preserved because tasks are enqueued BEFORE this function runs.
 */
async function _parseHiddenTabInBackground(taskId, postId, hostname, sourceTabId, lockedParentId = null, directPostUrl = null) {
  const log = (msg) => console.log(`[HiddenTab BG ${taskId}] ${msg}`);
  log('Starting background parse...');
  const postUrl = directPostUrl || buildPostPageUrl(hostname, postId);
  const isRule34 = hostname.includes('rule34.xxx');
  
  let retryCount = 0;
  const maxRetries = isRule34 ? RULE34_CONFIG_BG.MAX_RETRIES : 1;
  
  while (retryCount <= maxRetries) {
    let hiddenTabId = null;
    
    try {
      // Apply rate limiting for rule34 (wait if too many requests)
      if (isRule34) {
        await rateLimiter.waitIfNeeded(hostname);
      }
      
      // Create hidden tab
      const hiddenTab = await chrome.tabs.create({
        url: postUrl,
        active: false,
        selected: false,
        pinned: false,
        openerTabId: sourceTabId
      });
      hiddenTabId = hiddenTab.id;
      log(`Hidden tab created: ${hiddenTabId} (attempt ${retryCount + 1}/${maxRetries + 1})`);
      // Wait for content script to initialize
      const contentReady = await waitForContentScript(hiddenTabId, 15000);
      if (!contentReady) {
        throw new Error('Content script did not initialize');
      }
      // CRITICAL: Verify the correct post URL loaded before parsing
      // Prevents race condition where Chrome reuses a hidden tab
      // and the old content script parses the wrong post
      const correctUrl = await waitForCorrectUrl(hiddenTabId, postId, hostname, 15000);
      if (!correctUrl) {
        log(`WARNING: Wrong URL detected for post ${postId}, current tab URL does not match`);
        // If wrong URL, close and retry with a new tab
        throw new Error(`Tab URL does not match post ${postId}`);
      }
      log(`Correct post URL confirmed for post ${postId}`);
      // Request parse - this also checks for blocked pages
      let parseResult = await chrome.tabs.sendMessage(hiddenTabId, {
        action: 'parseForMainPageSave',
        checkBlocker: isRule34  // Tell content script to check for 429/CAPTCHA
      });
      if (!parseResult) {
        throw new Error('No response from content script');
      }
      // If hidden tab hit Cloudflare CAPTCHA, switch focus to it so the user can manually click the checkbox,
      // wait for them to solve it, and then switch back to sourceTabId automatically.
      if (parseResult.blocked && parseResult.blockerType === 'captcha') {
        log('CAPTCHA detected in hidden tab, activating tab for manual user solve...');
        try {
          await chrome.tabs.update(hiddenTabId, { active: true });
          if (hiddenTab.windowId) {
            await chrome.windows.update(hiddenTab.windowId, { focused: true });
          }
        } catch (e) {}
        try {
          chrome.tabs.sendMessage(sourceTabId, {
            action: 'captchaDetected',
            postUrl: postUrl,
            taskId: taskId
          }).catch(() => {});
        } catch (e) {}
        const solveStart = Date.now();
        while (Date.now() - solveStart < 45000) {
          await delay(1500);
          try {
            // Check if the user closed the tab manually
            const tabCheck = await chrome.tabs.get(hiddenTabId).catch(() => null);
            if (!tabCheck) break;
            const ready = await waitForContentScript(hiddenTabId, 4000);
            if (!ready) continue;
            const retryResult = await chrome.tabs.sendMessage(hiddenTabId, {
              action: 'parseForMainPageSave',
              checkBlocker: isRule34
            });
            if (retryResult && !retryResult.blocked && retryResult.success) {
              log('CAPTCHA solved manually in tab! Returning focus to source tab...');
              parseResult = retryResult;
              rateLimiter.reset(hostname);
              if (sourceTabId) {
                try { await chrome.tabs.update(sourceTabId, { active: true }); } catch (e) {}
              }
              break;
            }
          } catch (e) {
            // Tab is likely mid-reload after Turnstile solve, keep waiting
          }
        }
      }
      // Check for blocked page (429 or unresolved CAPTCHA)
      if (parseResult.blocked) {
        const blockerType = parseResult.blockerType; // 'rate_limit' or 'captcha'
        
        if (blockerType === 'rate_limit') {
          rateLimiter.onRateLimited(hostname);
          log(`Rate limited (429), retrying in ${RULE34_CONFIG_BG.RETRY_DELAY_429}ms...`);
        } else if (blockerType === 'captcha') {
          rateLimiter.onCaptchaDetected(hostname);
          log(`CAPTCHA still unsolved after wait, retrying in ${RULE34_CONFIG_BG.RETRY_DELAY_CAPTCHA}ms...`);
        } else {
          log(`Unknown blocker type: ${blockerType}, retrying...`);
        }
        
        // Close the blocked hidden tab
        try { await chrome.tabs.remove(hiddenTabId); } catch (e) {}
        hiddenTabId = null;
        
        retryCount++;
        
        if (retryCount > maxRetries) {
          const errorMsg = blockerType === 'captcha' 
            ? 'CAPTCHA: Open the post page manually to solve CAPTCHA'
            : 'Rate limited: Exceeded maximum retries';
          log(errorMsg);
          
          // Notify user on source tab about the failure
          try {
            chrome.tabs.sendMessage(sourceTabId, {
              action: 'hiddenTabBlocked',
              taskId: taskId,
              postId: postId,
              postUrl: postUrl,
              blockerType: blockerType
            }).catch(() => {});
          } catch (e) {}
          
          queue.markTaskFailed(taskId, errorMsg);
          return;
        }
        
        // Exponential backoff delay before retry
        const delayMs = blockerType === 'captcha' 
          ? RULE34_CONFIG_BG.RETRY_DELAY_CAPTCHA
          : RULE34_CONFIG_BG.RETRY_DELAY_429;
        await delay(delayMs * Math.min(retryCount, 3)); // Scale delay with retry count
        continue;
      }
      // Parse succeeded - process result
      if (!parseResult.success) {
        throw new Error(parseResult?.error || 'Failed to parse post page');
      }
      log(`Parsed: ${parseResult.data.imageUrl}, ${parseResult.data.tags?.length || 0} tags`);
      // Report success to rate limiter (gradually reduce multiplier)
      if (isRule34) {
        rateLimiter.onSuccess(hostname);
      }
      // For gelbooru: decide whether to use URL direct or base64
      const task = queue.tasks.find(t => t.taskId === taskId);
      if (task && hostname.includes('gelbooru')) {
        if (parseResult.base64) {
          log('Gelbooru: using base64 from canvas extraction');
          task.useUrlDirect = false;
          task.saveData.useUrlDirect = false;
        } else if (parseResult.data.imageUrl) {
          log('Gelbooru: setting useUrlDirect flag');
          task.useUrlDirect = true;
          task.saveData.useUrlDirect = true;
        }
      }
      // Update task's tabId for download cookies/referer BEFORE updateParsedData triggers _startDownloadParallel
      if (task) {
        task.tabId = hiddenTabId;
        if (parseResult.sampleOnly) {
          task.saveData.sampleOnly = true;
          log(`WARNING: original image link not found, saving a sample: ${parseResult.data.imageUrl}`);
        }
      }
      // Update the queue task with parsed data
      const updated = queue.updateParsedData(taskId, parseResult.data, parseResult.base64 || null);
      if (!updated) {
        throw new Error('Failed to update queue task with parsed data');
      }
      log('Task updated with parsed data, waiting for queue processing');
      // Wait for download to complete before closing tab
      while (task && !task.downloadComplete) {
        await delay(500);
      }
      log('Download complete, closing hidden tab');
      try { await chrome.tabs.remove(hiddenTabId); } catch (e) {}
      log('Hidden tab closed');
      return; // Success!
    } catch (error) {
      log(`Attempt ${retryCount + 1} error: ${error.message}`);
      
      // Close hidden tab on error
      if (hiddenTabId) {
        try { await chrome.tabs.remove(hiddenTabId); } catch (e) {}
      }
      
      if (isRule34 && retryCount < maxRetries) {
        // For rule34, retry on transient errors too
        rateLimiter.onRateLimited(hostname);
        retryCount++;
        await delay(RULE34_CONFIG_BG.RETRY_DELAY_429 * retryCount);
        continue;
      }
      
      // Non-rule34 or exhausted retries: mark as failed
      queue.markTaskFailed(taskId, error.message);
      return;
    }
  }
}
/**
 * Wait for the hidden tab to load the correct post URL
 * Prevents race condition where Chrome reuses a hidden tab
 * and the old content script responds before the new page loads
 * @param {number} tabId - Hidden tab ID
 * @param {string} expectedPostId - The post ID we expect to find in the URL
 * @param {string} hostname - Site hostname for URL matching
 * @param {number} [timeout=15000] - Max wait time in ms
 * @returns {Promise<boolean>} True if correct URL loaded
 */
async function waitForCorrectUrl(tabId, expectedPostId, hostname, timeout = 15000) {
  const startTime = Date.now();
  const idStr = String(expectedPostId).trim();
  while (Date.now() - startTime < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const curUrl = tab.url || tab.pendingUrl || '';
      if (curUrl.includes(idStr)) {
        return true;
      }
      try {
        const pingResp = await chrome.tabs.sendMessage(tabId, { action: 'pingContentScript' });
        if (pingResp?.url && pingResp.url.includes(idStr)) {
          return true;
        }
      } catch (e) {}
    } catch (e) {
      // Tab might not exist yet
    }
    await delay(300);
  }
  return false;
}
function waitForContentScript(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const check = async () => {
      try {
        const result = await chrome.tabs.sendMessage(tabId, {
          action: 'pingContentScript'
        });
        if (result?.pong) {
          resolve(true);
          return;
        }
      } catch (e) {
        // Content script not ready yet
      }
      
      if (Date.now() - startTime > timeout) {
        resolve(false);
        return;
      }
      
      setTimeout(check, 200);
    };
    
    check();
  });
}
// ==================== MESSAGE HANDLER ====================
const queue = new DownloadSaveQueue();
async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;
  switch (message.action) {
    case 'checkEagleConnection':
      return await checkEagle();
    case 'enqueueDownload': {
      if (!tabId) return { queued: false, error: 'No tab ID' };
      const taskId = message.data?.taskId || `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const { url, referer, saveData } = message.data || {};
      if (!url) return { queued: false, error: 'Image URL is required' };
      return queue.enqueue(taskId, tabId, url, referer, saveData);
    }
    case 'panelReady':
      return { ok: true };
    case 'clearQueue':
      await queue.clear();
      return { cleared: true };
    case 'closeCurrentTab':
      return await handlePostSaveAction(tabId);
    case 'saveFromMainPage': {
      const { postId, hostname, lockedParentId, replaceEagleId, postUrl } = message;
      if (!postId || !hostname) {
        return { success: false, error: 'Post ID and hostname are required' };
      }
      
      try {
        return await handleHiddenTabParse(postId, hostname, tabId, lockedParentId, replaceEagleId, postUrl);
      } catch (error) {
        console.error('[BG] Hidden tab parse failed:', error);
        return { success: false, error: error.message };
      }
    }
    case 'updateHotkeys': {
      currentHotkeys = message.hotkeys || { ...DEFAULT_HOTKEYS };
      console.log('[Hotkeys] Updated:', currentHotkeys);
      // Broadcast to all tabs so they update their local listeners
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'hotkeysUpdated',
            hotkeys: currentHotkeys
          }).catch(() => {});
        });
      });
      return { ok: true };
    }
    case 'settingsChanged': {
      if (message.settings) {
        currentSettings = { ...currentSettings, ...message.settings };
        console.log('[Settings] Updated in background:', currentSettings);
      }
      // Broadcast settings to all open tabs
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'settingsChanged',
            settings: message.settings
          }).catch(() => {});
        });
      });
      return { ok: true };
    }
    case 'focusTab': {
      // Focus the sender tab so the user can manually solve CAPTCHA
      if (sender.tab && sender.tab.id) {
        try {
          await chrome.tabs.update(sender.tab.id, { active: true });
          if (sender.tab.windowId) {
            await chrome.windows.update(sender.tab.windowId, { focused: true });
          }
        } catch (e) {
          console.warn('[BG] Could not focus tab:', e.message);
        }
      }
      return { ok: true };
    }
    case 'captchaSolved': {
      // CAPTCHA was solved on one tab - refresh other blocked rule34 tabs
      const hostname = message.hostname;
      console.log(`[BG] CAPTCHA solved on ${hostname}, refreshing blocked tabs...`);
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id === sender.tab?.id) return;
          if (!tab.url || !tab.url.includes(hostname)) return;
          
          // Tell content script that CAPTCHA was solved elsewhere
          chrome.tabs.sendMessage(tab.id, {
            action: 'captchaSolved',
            hostname: hostname
          }).catch(() => {});
        });
      });
      
      // Reset rate limiter since CAPTCHA is solved
      if (hostname) {
        rateLimiter.reset(hostname);
      }
      return { ok: true };
    }
    case 'hiddenTabBlocked': {
      // Log blocked state without stealing tab focus
      console.log(`[BG] Hidden tab blocked: ${message.blockerType} for post ${message.postId}`);
      return { ok: true };
    }
    case 'checkCollectedBatch': {
      await ensureCollectedDatabase();
      const items = Array.isArray(message.items) ? message.items : [];
      const collectedPostIds = [];
      const detailsMap = {};

      const pendingItems = [];
      for (const item of items) {
        if (!item || !item.postId) continue;
        const pid = String(item.postId);
        const pk = item.postKey || null;

        // 1. Priority 1: Exact match by post URL / ID (instant, no network)
        if (pk && collectedPostsSet.has(pk)) {
          const eagleItem = postToEagleItem.get(pk) || null;
          collectedPostIds.push(pid);
          detailsMap[pid] = {
            matched: true,
            type: 'exact',
            similarity: 100,
            eagleItem
          };
        } else {
          pendingItems.push(item);
        }
      }

      // 2. Parallel fetch for missing thumbnail pHashes (chunked to avoid socket exhaustion)
      const needFetch = pendingItems.filter(item => !item.pHash && item.thumbUrl);
      if (needFetch.length > 0) {
        const CONCURRENCY = 6;
        for (let i = 0; i < needFetch.length; i += CONCURRENCY) {
          const chunk = needFetch.slice(i, i + CONCURRENCY);
          await Promise.all(chunk.map(async (item) => {
            const fp = await getThumbFingerprintBg(item.thumbUrl, sender?.tab?.url || null);
            item.pHash = fp?.pHash || null;
            item.blocks = fp?.blocks || null;
          }));
        }
      }

      // 3. Priority 2: Perceptual hash (pHash) visual similarity
      for (const item of pendingItems) {
        const pid = String(item.postId);
        const pHash = item.pHash || null;
        if (pHash) {
          const pMatch = findBestPHashMatch(pHash, PHASH_SIMILARITY_THRESHOLD);
          if (pMatch) {
            collectedPostIds.push(pid);
            detailsMap[pid] = {
              matched: true,
              type: 'phash',
              similarity: pMatch.similarity,
              distance: pMatch.distance,
              queryPHash: pHash,
              queryBlocks: item.blocks || null,
              eagleItem: pMatch.item
            };
            continue;
          }
        }
        // Hand the computed hash back so the page can send it next time instead of the URL
        detailsMap[pid] = { matched: false, queryPHash: pHash, queryBlocks: item.blocks || null };
      }
      return { collectedPostIds, detailsMap };
    }
    case 'checkCollectedSingle': {
      await ensureCollectedDatabase();
      const pk = message.postKey || null;
      let pHash = message.pHash || null;
      // 1. Priority 1: postKey
      if (pk && collectedPostsSet.has(pk)) {
        const eagleItem = postToEagleItem.get(pk) || null;
        return {
          collected: true,
          matchedBy: 'post',
          type: 'exact',
          similarity: 100,
          eagleItem
        };
      }
      // 2. Priority 2: pHash
      if (!pHash && message.thumbUrl) {
        pHash = (await getThumbFingerprintBg(message.thumbUrl, sender?.tab?.url || null))?.pHash || null;
      }
      if (pHash) {
        const pMatch = findBestPHashMatch(pHash, PHASH_SIMILARITY_THRESHOLD);
        if (pMatch) {
          return {
            collected: true,
            matchedBy: 'phash',
            type: 'phash',
            similarity: pMatch.similarity,
            distance: pMatch.distance,
            eagleItem: pMatch.item
          };
        }
      }
      return { collected: false, matchedBy: null };
    }
    case 'computePHash': {
      const url = message.url;
      if (!url) return { pHash: null };
      const pHash = await computePHashFromUrlBg(url, message.referer || sender?.tab?.url || null);
      return { pHash };
    }
    case 'getEagleItemInfo': {
      const info = await fetchEagleItemInfo(message.id);
      if (!info) return { info: null };
      const { id, tags, folders, url, annotation, star, width, height, size, ext } = info;
      return { info: { id, tags: tags || [], folders: folders || [], url, annotation, star, width, height, size, ext } };
    }
    default:
      return { error: 'Unknown action' };
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => {
      console.error('[BG] Handler error:', error);
      sendResponse({ error: error.message });
    });
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'booru-eagle-keepalive') {
    if (queue.tasks.length === 0 && !queue.processing) {
      chrome.alarms.clear('booru-eagle-keepalive');
    }
  }
});
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { action: 'showPanel' });
});
// Auto-sync with Eagle when user switches tabs (e.g. returning to browser from Eagle)
let lastTabFocusSyncTime = 0;
chrome.tabs.onActivated.addListener(() => {
  const now = Date.now();
  if (now - lastTabFocusSyncTime > 15000) {
    lastTabFocusSyncTime = now;
    syncFromEagleApiBg(true).catch(() => {});
  }
});
console.log('[BooruEagle BG] Service worker started');
// ==================== NETWORK RULES ====================
// Ensure any leftover dynamic rules from previous versions are cleared
if (typeof chrome !== 'undefined' && chrome.declarativeNetRequest?.getDynamicRules) {
  chrome.declarativeNetRequest.getDynamicRules().then(rules => {
    const ids = rules.map(r => r.id);
    if (ids.length > 0) chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  }).catch(() => {});
}
// Danbooru's CDN (cdn.donmai.us) sits behind a Cloudflare challenge that rejects service-worker fetches,
// so thumbnails are hashed from the page context instead. Grant CORS to those page-initiated fetches only.
const THUMB_CORS_RULES = [
  { id: 9101, cdn: 'cdn.donmai.us', pageOrigin: 'https://danbooru.donmai.us' }
];
if (typeof chrome !== 'undefined' && chrome.declarativeNetRequest?.updateSessionRules) {
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: THUMB_CORS_RULES.map(r => r.id),
    addRules: THUMB_CORS_RULES.map(r => ({
      id: r.id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: r.pageOrigin },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' }
        ]
      },
      condition: {
        requestDomains: [r.cdn],
        initiatorDomains: [new URL(r.pageOrigin).hostname],
        resourceTypes: ['xmlhttprequest']
      }
    }))
  }).catch(e => console.warn('[BooruEagle BG] Failed to register thumbnail CORS rules:', e));
}
loadHotkeys();
loadSettingsBg();
ensureCollectedDatabase();
// ==================== GLOBAL HOTKEYS ====================
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) return;
  
  const hostname = new URL(tab.url).hostname;
  const supportedSites = [
    'danbooru.donmai.us',
    'gelbooru.com',
    'konachan.com',
    'rule34.xxx',
    'rule34video.com',
    'chan.sankakucomplex.com',
    'yande.re'
  ];
  
  if (!supportedSites.some(site => hostname.includes(site.split('.')[1] || site))) return;
  
  const commandToAction = {
    'hotkey-save': 'triggerSave',
    'hotkey-parent': 'triggerSetParent',
    'hotkey-stop': 'triggerStop',
    'hotkey-postsave': 'triggerPostSave'
  };
  
  const action = commandToAction[command];
  if (!action) return;
  
  console.log(`[Hotkeys] Command: ${command} -> ${action}`);
  
  chrome.tabs.sendMessage(tab.id, {
    action: 'hotkeyAction',
    type: action
  }).catch(() => {
    console.log('[Hotkeys] No content script on this tab');
  });
});

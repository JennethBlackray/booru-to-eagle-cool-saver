# Architecture Documentation

> Booru to Eagle Saver extension architecture.
> **Last updated:** May 2026

## Project Structure

```
extension/
├── manifest.json              # Chrome extension manifest
├── config.js                  # Centralized config (endpoints, timeouts, selectors)
├── content/                   # Content scripts
│   ├── parsers/               # Plugin-based parser system
│   │   ├── base-parser.js     # Base parser interface (all parsers extend this)
│   │   ├── parser-registry.js # Registry for managing site parsers
│   │   ├── {site}-parser.js   # Site-specific parsers
│   ├── site-configs.js        # Thumbnail button site configs
│   ├── thumb-button-config.js # Button styles
│   ├── main.js                # Entry point for content scripts
│   ├── main-page-buttons.js   # Thumbnail save buttons
│   ├── panel.js               # Floating UI panel (BooruEaglePanel)
│   ├── queue-panel.js         # Queue display panel
│   ├── micro-fixes.js         # Site-specific visual fixes
│   └── *.css                  # Styles
├── background/
│   └── service-worker.js      # Queue, Eagle API, messaging, hidden tabs, RateLimiter
├── popup/                     # Extension popup UI
└── icons/                     # Extension icons
```

## Key Modules

### content/main.js — Entry Point
- Creates `ParserRegistry`, finds matching parser, creates `BooruEaglePanel`
- **Sankaku Quick Parse**: `ensureParsedData` tries immediate parse first, tags load async via `waitForTagsInBackground` (waits for `#tag-sidebar` + `#image[orig_width][orig_height]`)
- **Rule34 blocked page detection**: checks for 429/CAPTCHA on post page load, auto-refresh or banner with polling
- Handles SPA navigation cleanup (panel, observers, timers, caches)
- Hidden tab parse handler (`parseForMainPageSave`) with blocker detection for rule34

### content/panel.js — Floating Panel
- Cross-domain sync via `chrome.storage.local` (unique `_panelId` prevents echo)
- Features: drag, collapse, Set Parent, Post-Save toggle, Stop, toast, rating highlight
- Event delegation on `.panel-body` for action buttons
- `updatePostIdDisplay()` shows `#site-name` on main pages; green highlight when parent locked

### content/main-page-buttons.js — Thumbnail Buttons
- Uses `SITE_CONFIGS` for site-specific selectors, `THUMB_BUTTON_CONFIG` for styles
- MutationObserver for infinite scroll
- Long press (~500ms) sets post as parent
- `processedPosts` and `buttonMap` auto-prune at 5000

### background/service-worker.js — Core Logic

**DownloadSaveQueue** — FIFO queue with parallel downloads + sequential saves:
- **Task states**: `pending_parse` → `pending_download` → `downloading` → `download_complete` → saved/failed
- **Two-phase enqueue**: thumbnail saves enqueue in `pending_parse` immediately (order captured), hidden tab parses async
- `updateParsedData()` merges parsed tags with existing (preserves `parent:xxx`)
- Downloads run in parallel, saves run sequentially (FIFO)
- Keep-alive alarm prevents worker suspension
- AbortController for cancellation, memory cleanup on completion

**Hidden Tab Save Flow** (with retry logic for rule34):
1. `handleHiddenTabParse()` creates task in `pending_parse` immediately → returns position
2. `_parseHiddenTabInBackground()` opens hidden tab (with rate limiting for rule34)
3. **NEW**: `waitForCorrectUrl()` verifies correct post URL loaded (prevents Chrome tab reuse race condition — old content script parsing wrong post)
4. Content script checks for 429/CAPTCHA (if `checkBlocker` flag set)
5. If blocked: closes tab, exponential backoff (3-15s), retries up to 5×
6. If parse succeeds: `queue.updateParsedData()` → queue processes FIFO
7. Hidden tab closed after download completes

**RateLimiter** — Per-domain request tracking:
- `waitIfNeeded(hostname)` — enforces 800ms minimum interval for rule34
- `onRateLimited/onCaptchaDetected` — doubles delay multiplier (up to 8×)
- `onSuccess` — gradually decreases multiplier

### content/parsers/ — Plugin System
- `BaseParser` defines interface: `matches()`, `isPostPage()`, `getImageUrl()`, `getRawTags()`, `getPostId()`
- Optional overrides: `getImageDimensions()`, `getSourceUrl()`, `getRating()`, `getNotes()`
- `SankakuParser.waitForElement(selector, timeout)` — static helper for dynamic content
- `Rule34Parser` includes static blocked page detection methods
- `parse()` is async for all parsers (sync parsers resolve immediately)

## Data Flow

### Post Page Save
```
main.js init() → parser.parse() → panel.updateData() → user clicks Save
  → chrome.runtime.sendMessage({action:'enqueueDownload'})
  → queue.enqueue() → parallel download → sequential FIFO save → Eagle API
```

### Thumbnail Save (Two-Phase Enqueue)
```
handleSaveClick() → sendMessage({action:'saveFromMainPage'})
  → handleHiddenTabParse() → queue.enqueue(state:'pending_parse') → return position
  → _parseHiddenTabInBackground() → chrome.tabs.create({url:postUrl})
  → waitForContentScript() → waitForCorrectUrl() ← NEW: prevents wrong-post race
  → sendMessage({action:'parseForMainPageSave'}) → parser.parse()
  → queue.updateParsedData() → download → FIFO save → close hidden tab
```

### Cross-Domain Sync
```
panel.updateData() → chrome.storage.local.set() → storage.onChanged on all tabs
  → handleSyncMessage() ← unique _panelId prevents echo
  → debounced position broadcasts (100ms)
```

## Key Design Decisions

1. **Two-phase enqueue** — Thumbnail saves enqueue immediately (`pending_parse`), parse async. Order captured at click time, queue processes FIFO.
2. **waitForCorrectUrl** (NEW) — Prevents race condition where Chrome reuses hidden tab and old content script parses wrong post.
3. **Sankaku quick parse** — Immediate parse first, critical elements only, tags in background.
4. **chrome.storage.local for sync** — Cross-domain communication (no BroadcastChannel), unique panel IDs prevent echo.
5. **Tag merging** — `updateParsedData()` preserves `parent:xxx` tags when merging parsed tags.
6. **Rule34 retry logic** — Preventive rate limiting (800ms), exponential backoff on 429/CAPTCHA, up to 5 retries.
7. **Gelbooru CORS workaround** — `useUrlDirect = true` sends URL to Eagle directly (Eagle downloads, not browser).
8. **Memory management** — `task.base64 = null`, `chunks.length = 0`, `processedPosts` capped at 5000.
9. **Event listener guards** — All listeners use `_booruEagle*Registered` flags to prevent accumulation on SPA navigation.
10. **SPA cleanup** — Panel, queue panel, observers, timers, caches all properly disposed on navigation.

## Supported Sites

| Site | Post Page | Thumbnail | Notes |
|------|-----------|-----------|-------|
| Danbooru | ✅ | ✅ | Standard |
| Gelbooru | ✅ | ✅ | URL direct to Eagle (CORS) |
| Konachan | ✅ | ✅ | Standard |
| Rule34.xxx | ✅ | ✅ | 429/CAPTCHA retry logic |
| Sankaku | ✅ | ✅ | Quick parse (async tags) |
| yande.re | ✅ | ✅ | Standard |

## Adding a New Site

1. Create `content/parsers/{site}-parser.js` extending `BaseParser`
2. Add to `PARSERS` array in `parser-registry.js`
3. For thumbnails: add entry to `SITE_CONFIGS` in `site-configs.js` + URL builder in `buildPostPageUrl()` in `service-worker.js`
4. Update `manifest.json` (content_scripts + matches/host_permissions)

## Eagle API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/item/list` | GET | Check Eagle connection |
| `/api/item/addFromURL` | POST | Add image with tags/annotation |

Payload: `{ url, tags, name, website, annotation }` → `localhost:41595`

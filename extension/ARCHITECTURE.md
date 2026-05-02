# Architecture Documentation

> This document describes the architecture of Booru to Eagle Saver extension.
> It is designed to help AI assistants understand and maintain the codebase.
>
> **Last updated:** May 2026

## Project Structure

```
extension/
├── manifest.json              # Chrome extension manifest (entry point config)
├── config.js                  # Centralized configuration (endpoints, timeouts, selectors, RULE34_CONFIG)
├── ARCHITECTURE.md            # This file
├── README.md                  # User-facing documentation
│
├── content/                   # Content scripts (injected into web pages)
│   ├── parsers/               # Plugin-based parser system
│   │   ├── base-parser.js     # Base parser interface (all parsers extend this)
│   │   ├── parser-registry.js # Registry for managing site parsers
│   │   ├── danbooru-parser.js # Danbooru-specific parser
│   │   ├── gelbooru-parser.js # Gelbooru-specific parser
│   │   ├── konachan-parser.js # Konachan-specific parser
│   │   ├── rule34-parser.js   # Rule34.xxx-specific parser (includes blocker detection)
│   │   ├── sankaku-parser.js  # Sankaku Complex-specific parser
│   │   └── yandere-parser.js  # yande.re-specific parser
│   ├── site-configs.js        # Site configurations for thumbnail buttons
│   ├── thumb-button-config.js # Centralized button styles
│   ├── main-page-buttons.js   # Thumbnail save buttons on main/search pages
│   ├── panel.js               # Floating UI panel class (BooruEaglePanel)
│   ├── panel.css              # Panel styles (glassmorphism)
│   ├── queue-panel.js         # Queue display panel class (BooruEagleQueuePanel)
│   ├── micro-fixes.js         # Site-specific visual fixes (e.g., fixing overlays)
│   ├── queue-panel.css        # Queue panel styles
│   └── main.js                # Entry point for content scripts
│
├── background/                # Background service worker
│   └── service-worker.js      # Download queue, Eagle API calls, messaging, hidden tab saves, RateLimiter
│
├── popup/                     # Extension popup UI
│   ├── popup.html             # Popup HTML
│   └── popup.js               # Popup JavaScript
│
└── icons/                     # Extension icons
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Script Loading Order

Content scripts are loaded in this order (see manifest.json):

1. **config.js** - Defines global constants (EAGLE_CONFIG, TIMEOUTS, SANKAKU_SELECTORS, RULE34_CONFIG)
2. **content/site-configs.js** - Site configurations for thumbnail buttons
3. **content/thumb-button-config.js** - Centralized button styles
4. **content/parsers/base-parser.js** - Defines BaseParser class (interface)
5. **content/parsers/danbooru-parser.js** - Danbooru parser (extends BaseParser)
6. **content/parsers/gelbooru-parser.js** - Gelbooru parser (extends BaseParser)
7. **content/parsers/konachan-parser.js** - Konachan parser (extends BaseParser)
8. **content/parsers/rule34-parser.js** - Rule34 parser (extends BaseParser)
9. **content/parsers/sankaku-parser.js** - Sankaku parser (extends BaseParser)
10. **content/parsers/yandere-parser.js** - yande.re parser (extends BaseParser)
11. **content/parsers/parser-registry.js** - Registry that ties all parsers together
12. **content/panel.js** - Defines BooruEaglePanel class (UI)
13. **content/queue-panel.js** - Defines BooruEagleQueuePanel class
14. **content/micro-fixes.js** - Site-specific visual fixes
15. **content/main-page-buttons.js** - Defines MainPageButtons class (thumbnail buttons)
16. **content/main.js** - Entry point, initializes everything

## Module Responsibilities

### config.js
**Purpose:** Centralized configuration
**Key exports:** `EAGLE_CONFIG`, `TIMEOUTS`, `SANKAKU_SELECTORS`, `RULE34_CONFIG`

`RULE34_CONFIG` contains:
- `MIN_REQUEST_INTERVAL` (800ms) — Minimum delay between rule34 requests
- `RETRY_DELAY_429` (3000ms) — Delay before retry after 429
- `RETRY_DELAY_CAPTCHA` (5000ms) — Delay before retry after CAPTCHA
- `MAX_RETRIES` (5) — Maximum retry attempts for blocked pages
- `PAGE_CHECK_INTERVAL` (1000ms) — How often to check if page is ready
- `PAGE_WAIT_TIMEOUT` (120000ms) — Max time to wait for page readiness
- `TITLE_429`, `TITLE_CAPTCHA` — Page title strings for detection
- `CAPTCHA_SELECTOR`, `CAPTCHA_SUCCESS_SELECTOR` — Selectors for Turnstile

### content/site-configs.js
**Purpose:** Site configurations for thumbnail save buttons
**Key exports:** `SITE_CONFIGS`, `findSiteConfig()`

Each site config contains:
- `name` - Display name
- `thumbSelectors` - CSS selectors for thumbnail containers
- `thumbContainerSelector` - Selector for element that gets position:relative
- `idExtractor(el)` - Function to extract post ID from element
- `postPageUrl(postId)` - Function to build post page URL
- `observerTarget` - CSS selector for MutationObserver target

**To add a new site:** Add an entry to `SITE_CONFIGS` object.

### content/thumb-button-config.js
**Purpose:** Centralized styles for thumbnail save buttons
**Key exports:** `THUMB_BUTTON_CONFIG`

Contains:
- `containerClass` - CSS class for button container
- `buttonClass` - CSS class for button
- `icon` - Button icon (emoji)
- `tooltipDefault`, `tooltipSaving`, `tooltipSuccess`, `tooltipError` - Tooltip texts
- `css` - Complete CSS styles

**To change button appearance:** Edit this file only.

### content/main-page-buttons.js
**Purpose:** Save buttons under thumbnails on main/search pages
**Key class:** `MainPageButtons`

**Features:**
- Uses `SITE_CONFIGS` for site-specific selectors
- Uses `THUMB_BUTTON_CONFIG` for button styles
- MutationObserver for infinite scroll support
- Listens for save results from background (hidden tab saves)
- Syncs button progress via `chrome.storage.onChanged` listener
- Long press (~500ms) sets the post as parent (same as panel's Set Parent)
- `processedPosts` and `buttonMap` auto-prune at 5000 entries to prevent memory bloat
- `destroy()` cleans up observer, timers, and DOM elements

**To add a new site:** Add entry to `SITE_CONFIGS` in site-configs.js.

### content/parsers/base-parser.js
**Purpose:** Base interface for all site parsers
**Key class:** `BaseParser`
**Required methods to implement:**
- `matches(hostname)` - Check if this parser handles the given URL
- `isPostPage()` - Check if we're on a post/image page
- `getImageUrl()` - Get the original/high-res image URL
- `getRawTags()` - Get raw tags from the page (before normalization)
- `getPostId()` - Get the post ID

**Optional methods (with default implementations):**
- `getSiteName()` - Get display name (defaults to 'Unknown')
- `getImageDimensions()` - Get image dimensions (tries og:image meta, then image element)
- `getSourceUrl()` - Get source URL (tries common selectors)
- `getRating()` - Get image rating (sfw/questionable/explicit)
- `getNotes()` - Get image notes/annotations (defaults to empty array; Rule34Parser overrides)
- `normalizeTags(tags)` - Normalize tags (shared implementation, removes prefixes EXCEPT artist:)
- `parse()` - Parse all data at once (uses above methods; Rule34Parser overrides as async)

### content/parsers/parser-registry.js
**Purpose:** Central registry for all site parsers
**Key class:** `ParserRegistry`
**Key methods:**
- `findParser(url)` - Find the parser that matches the current URL
- `getAllParsers()` - Get all registered parsers
- `getSupportedSites()` - Get all supported site names
- `isSiteSupported(hostname)` - Check if a site is supported
- `enableParser(siteType)` - Enable a parser
- `disableParser(siteType)` - Disable a parser

**PARSERS array:** To add/remove sites, edit this array.

### content/parsers/*.js (site-specific parsers)
Each site parser:
1. Extends `BaseParser`
2. Implements `matches(hostname)` to detect the site
3. Implements site-specific parsing methods
4. Can override `getImageDimensions()`, `getSourceUrl()`, `getRating()` if needed

**SankakuParser** has a static `waitForElement(selector, timeout)` method for waiting dynamic content.

**Rule34Parser** additionally includes static methods for blocked page detection:
- `isRateLimited()` — Check if current page is a 429 rate limiting page
- `isCaptchaPage()` — Check if current page is a Cloudflare CAPTCHA challenge
- `getBlockerType()` — Returns `'rate_limit' | 'captcha' | null`
- `isCaptchaSolved()` — Check if CAPTCHA has been solved
- `waitForPageReady(timeout)` — Wait for a blocked page to resolve

**Important:** All parsers must apply `[...new Set(tags)]` deduplication in `getRawTags()`. DanbooruParser and Rule34Parser use `this.normalizeTags()` from BaseParser (no override).

### content/panel.js
**Purpose:** Floating UI panel with full cross-domain synchronization
**Key class:** `BooruEaglePanel`

**Cross-Domain Sync Architecture:**
- Uses `chrome.storage.local` (not BroadcastChannel) for cross-domain communication
- Each panel instance has unique `_panelId` to prevent echo
- Messages include `sourceId` and `timestamp` for deduplication
- Debounce (100ms) on position broadcasts to prevent storage flooding
- Storage listener cleaned up on `close()` to prevent memory leaks
- `chrome.runtime.lastError` checked in broadcast callback

**Features:**
- Drag via mousedown/mousemove (capture phase)
- Collapse/expand
- Position persistence via localStorage
- Full cross-tab sync across ALL supported domains
- **Set Parent** toggle — always enabled; on click validates postId from state or URL; shows toast if no postId available
- **Post-Save** toggle (auto-close tab after save)
- **Stop** button (clears queue)
- Toast notifications
- Rating highlight (sfw/questionable/explicit)
- Post ID display: shows `#site-name` on main pages; green highlight when parent is locked
- Event delegation on `.panel-body` for action button clicks (avoids disabled attribute issues)

**Key methods:**
- `updateStatus(status, message)` - Update status dot color
- `updateData(data)` - Update panel with parsed data
- `showToast(message, type)` - Show notification
- `setButtonsEnabled(enabled)` - Enable/disable Save and Post-Save buttons; Set Parent is always enabled
- `setPostSaveEnabled(enabled)` - Enable only Post-Save toggle (main page context)
- `onSetParentClick()` - Toggle Set Parent; extracts postId from state or URL; shows toast if unavailable
- `onPostSaveClick()` - Toggle Post-Save auto-close (synced)
- `handleSyncMessage(message)` - Handle cross-tab sync messages; preserves local `postId` to avoid overwrite from main page broadcasts
- `broadcast(message)` - Send message to all other tabs
- `_broadcastDebounced(message)` - Debounced broadcast for drag
- `_initStorageSync()` - Setup chrome.storage listener
- `_cleanupStorageSync()` - Cleanup listener on close
- `updatePostIdDisplay()` - Shows post ID or #site-name; green highlight for locked parent
- `_updatePostIdFromCurrentPage()` - Extracts postId from URL using common booru patterns
- `close()` - Removes DOM element, cleans up storage listener, clears timers

**Message types:**
- `position` - Panel position {x, y, hasBeenDragged}
- `collapse` - Collapsed state {collapsed}
- `toggle` - Toggle button {button, enabled}
- `data` - Panel data {data}
- `setParent` - Set Parent toggle {enabled, lockedParentId}
- `stopFlash` - Flash Stop button animation
- `close` - Close panel

### content/queue-panel.js
**Purpose:** Visual queue display panel that slides in from the right when >1 tasks are queued
**Key class:** `BooruEagleQueuePanel`

**Features:**
- Appears when queue has >1 tasks, hides when <=1
- Max 5 tiles displayed; 5th tile shows `+N more` for excess
- Each tile shows: status dot, post ID, status text, mini progress bar (for downloads)
- Color-coded states: ⚪ waiting | 🔵 downloading | 🟡 saving | ✅ done | ❌ failed
- Close button hides panel; state persisted in `chrome.storage.local`
- Listens to `chrome.storage.local['queue-state']` for updates
- Debounced re-render (100ms) to avoid excessive DOM updates
- Properly cleaned up on SPA navigation: storage listener removed, DOM element removed, timers cleared

**Key methods:**
- `init()` - Creates DOM, injects CSS, starts storage listener
- `_renderQueue(state)` - Shows/hides panel based on task count, builds tiles
- `_buildTiles(tasks, total)` - Creates tile elements, collapses extras into `+N more`
- `_createTile(task, index)` - Creates individual tile with status indicators
- `_getStateClass(state)` - Maps task state to CSS class
- `close()` - Removes storage listener, clears timers, removes DOM element

### content/main.js
**Purpose:** Entry point for content scripts

**Flow:**
1. Create ParserRegistry
2. Find matching parser for current site
3. Create BooruEaglePanel
4. Create BooruEagleQueuePanel
5. Initialize MainPageButtons (for main/search pages)
6. **Rule34 blocked page detection** — check for 429 or CAPTCHA before parsing
7. Parse page data using the detected parser
8. Update panel with data
9. Listen for save events
10. Send save request to background

**Sankaku Quick Parse:**
- On Sankaku, `ensureParsedData` tries an **immediate parse** first (no waiting).
- If immediate parse succeeds, image URL and data appear instantly.
- Tags load asynchronously in background (`waitForTagsInBackground`).
- If immediate parse fails, waits for critical elements only (`#highres`, `#hidden_post_id`, `#image`).
- `#tag-sidebar` is NOT waited for — avoids blocking on slow tag sidebar loads.

**Rule34 Blocked Page Detection (post pages only):**
- On post page load, checks for 429 rate limit or Cloudflare CAPTCHA
- **429 detected:** Shows warning toast, auto-refreshes after 2 seconds
- **CAPTCHA detected:** Shows red banner at page top, tries to focus the tab, creates interval checking for solution. Once solved: broadcasts `captchaSolved` to background, continues normal parsing

**Key state variables:**
- `currentParsedData` - Cached parsed data from current page
- `currentParser` - Currently active parser instance
- `currentPanel` - Currently active panel instance
- `queuePanel` - Currently active queue panel instance
- `mainPageButtons` - Currently active main page buttons instance
- `currentTaskId` - ID of current pending save task
- `pendingPostSaveClose` - Whether to close tab after save

**Event listeners:**
- `booru-eagle-retry` - Retry parsing (from panel retry button)
- `booru-eagle-save` - Save to Eagle (from panel save button)
- `chrome.runtime.onMessage` - Handle messages from background (registered ONCE via guard flag)
- `chrome.storage.onChanged` - Sync progress across tabs (registered ONCE via guard flag)
- `beforeunload` - Cleans up `save-progress` from storage on tab close

**Message handlers (chrome.runtime.onMessage):**
- `saveResult` — Save completed/failed (handles both post-page and hidden tab saves)
- `hotkeyAction` — Hotkey triggered
- `parseForMainPageSave` — Hidden tab requests parse data (async, passes message object with `checkBlocker` flag)
- `pingContentScript` — Background checks if content script is ready
- `hotkeysUpdated` — Hotkeys changed in popup
- `settingsChanged` — Settings changed in popup
- `captchaDetected` — Background reports CAPTCHA on hidden tab
- `captchaSolved` — CAPTCHA solved on another tab → reload if this tab is also blocked
- `hiddenTabBlocked` — Background reports hidden tab save failure (CAPTCHA or rate limit)

**Hidden tab handling:**
- Listens for `parseForMainPageSave` message from background
- If `checkBlocker` flag is true, checks for 429/CAPTCHA first → returns `{blocked: true, blockerType}`
- Parses page and returns data for hidden tab saves
- For Sankaku: waits for critical elements only (no tag sidebar)
- For gelbooru: tries canvas extraction, falls back to URL-only
- Listens for `pingContentScript` for readiness checks

**SPA navigation cleanup:**
- Closes old panel (`currentPanel.close()`) — removes storage listener + DOM
- Destroys old main page buttons (`mainPageButtons.destroy()`) — disconnects observer, clears timers
- Closes old queue panel (`queuePanel.close()`) — removes storage listener + DOM
- Clears `currentParsedData`, `currentParser`
- Clears parser caches (`window._konachanRegisterData`, `window._yandereRegisterData`)
- Clears stale `save-progress` from storage
- Re-initializes everything

**Security notes:**
- `chrome.runtime.sendMessage` in setTimeout wrapped in try-catch (context invalidation)
- Storage listeners registered only once to prevent duplicate handlers
- `chrome.runtime.onMessage` listener registered only once via guard flag

### background/service-worker.js
**Purpose:** Download queue, Eagle API calls, cross-tab messaging, hidden tab saves, rate limiting

**RateLimiter (new):**
- `RateLimiter` class with per-domain request tracking
- `waitIfNeeded(hostname)` — Waits if the minimum interval (800ms for rule34) hasn't elapsed
- `onRateLimited(hostname)` — Doubles delay multiplier (up to 8x) on 429
- `onCaptchaDetected(hostname)` — Similar multiplier increase for CAPTCHA
- `onSuccess(hostname)` — Gradually decreases multiplier on success
- `reset(hostname)` — Resets all tracking for a domain
- Global instance `rateLimiter` shared across all background operations

**RULE34_CONFIG_BG (inline):**
- Since `config.js` is not available in background context, an inline configuration `RULE34_CONFIG_BG` is defined with matching values.

**Queue Architecture (Two-Phase Enqueue):**
- `DownloadSaveQueue` class manages parallel downloads + sequential saves
- **Task states:** `pending_parse` → `pending_download` → `downloading` → `download_complete` → saved
- **Phase 1 (enqueue):** Task added IMMEDIATELY in `pending_parse` state for thumbnail saves (order captured at click time)
- **Phase 2 (parse):** Hidden tab parses in background, calls `updateParsedData()` to transition task to `pending_download`
- **Downloads** run in parallel (one per task)
- **Saves** run sequentially in FIFO order
- `_processSaveQueue()` polls `pending_parse` tasks every 200ms with 120s timeout (increased from 30s for rule34 retries)
- Keep-alive alarm prevents Chrome from killing the worker during long downloads
- AbortController for each download (supports cancellation)
- `task.base64 = null` before task removal to free memory
- `chunks.length = 0` after Blob creation to free download chunks immediately

**Queue methods:**
- `enqueue(taskId, tabId, url, referer, saveData, options)` - Adds task; `options.state` can be `'pending_parse'` or `'pending_download'`
- `updateParsedData(taskId, parsedData, base64)` - Updates a pending_parse task with URL/tags/base64; **merges** parsed tags with existing tags (preserves `parent:xxx` tags)
- `markTaskFailed(taskId, error)` - Marks task as failed
- `clear()` - Clears all tasks, aborts downloads, cleans up `queue-state` from storage

**Hidden Tab Save Flow (with retry logic for rule34):**
1. User clicks thumbnail button on main page
2. `handleHiddenTabParse()` creates task in `pending_parse` state **immediately** with `website` and `referer` set to postUrl (order preserved!)
3. Returns `{success, position, taskId}` to the content script right away
4. `_parseHiddenTabInBackground()` opens hidden tab, **with rate limiting applied first**
5. Content script checks for 429/CAPTCHA (if `checkBlocker` flag is true)
6. If blocked: closes tab, applies exponential backoff (3-15s), retries up to `MAX_RETRIES` (5) times
7. If CAPTCHA persists: task marked as failed with message "CAPTCHA: Open the post page manually to solve CAPTCHA", user notified via `hiddenTabBlocked`
8. If parse succeeds: calls `queue.updateParsedData()`, queue processes in FIFO order
9. For gelbooru: sets `useUrlDirect = true` (Eagle downloads URL directly); if canvas extraction succeeds, uses base64 instead
10. Hidden tab closed after download completes
11. `reportQueueState()` writes queue state to `chrome.storage.local['queue-state']` after every queue change

**Functions:**
- `reportQueueState()` - Writes current queue state to storage for queue panel consumption; includes task list with postId, state, progress
- `extractPostIdFromTaskId(taskId)` - Extracts post ID from task ID string (`hidden-{postId}-...`)

**Messages it handles:**
- `checkEagleConnection` - Returns `{connected: boolean}`
- `enqueueDownload` - Enqueue a download+save task
- `clearQueue` - Clear all pending tasks
- `panelReady` - Logs panel initialization
- `closeCurrentTab` - Close or go back on current tab
- `saveFromContentScript` - Save from content script (base64 or URL)
- `saveFromMainPage` - Save post from main page via hidden tab (two-phase enqueue)
- `updateHotkeys` - Update hotkey configuration
- `settingsChanged` - Broadcast settings to all open tabs
- `focusTab` - Focus a tab (used for CAPTCHA solver notification)
- `captchaSolved` - CAPTCHA solved on one tab; notifies other blocked rule34 tabs to refresh; resets rate limiter
- `hiddenTabBlocked` - Notifies user tab that a hidden tab was blocked (focuses tab)

**Hotkeys:**
- `Alt+Z` - Save
- `Alt+X` - Set Parent
- `Alt+C` - Stop (clear queue)
- `Alt+A` - Toggle Post-Save auto-close

### popup/popup.js
**Purpose:** Extension popup UI
**Flow:**
1. Check Eagle connection via background
2. Display current site
3. Handle button clicks

## Data Flow

### Post Page Save (from post page)
```
User opens post page
        │
        ▼
┌─────────────────────┐
│   content/main.js   │ ← Entry point
└─────────┬───────────┘
          │
    ┌─────┴─────────────────────┐
    ▼                           ▼
┌──────────────────┐   ┌──────────────┐
│ ParserRegistry   │   │   Panel      │
│ .findParser()    │   │ (create UI)  │
└────────┬─────────┘   └──────┬───────┘
         │                    │
         │   [Rule34: check for 429/CAPTCHA]
         ▼                    │
  Detected Parser             │
  .parse()                    │
         │                    │
         ▼                    ▼
   {imageUrl,            updateData()
    tags, etc}               │
         │                   │
         └──────────┬────────┘
                    ▼
             Panel shows data

User clicks "Save"
        │
        ▼
┌─────────────────────┐
│   content/main.js   │ ← Listens for 'booru-eagle-save' event
└─────────┬───────────┘
          │
          ▼ chrome.runtime.sendMessage({action: 'enqueueDownload'})
┌─────────────────────────┐
│ background/service-     │
│ worker.js               │
│   queue.enqueue()       │ ← Order captured immediately
│   state: pending_download│
└─────────┬───────────────┘
          │
          ▼ parallel download
┌─────────────────────────┐
│ Download image          │
└─────────┬───────────────┘
          │
          ▼ sequential save (FIFO)
┌─────────────────────────┐
│ Eagle API               │
│ localhost:41595         │
└─────────────────────────┘
```

### Gelbooru Save Flow (special case - no CORS)
```
User clicks Save on gelbooru post page
        │
        ▼
┌─────────────────────┐
│   content/main.js   │
│ handleSave()        │
└─────────┬───────────┘
          │
          │ Detects gelbooru → sets useUrlDirect = true
          ▼
┌─────────────────────────┐
│ chrome.runtime.sendMessage({
│   action: 'enqueueDownload',
│   data: { url: imageUrl, saveData: {useUrlDirect: true}, ... }
│ })
└─────────┬───────────────┘
          │
          ▼
┌─────────────────────────┐
│ background/service-     │
│ worker.js               │
│   queue.enqueue()       │
│   useUrlDirect → no download
│   → saveToEagleURL()    │ ← Eagle downloads URL itself
└─────────┬───────────────┘
          │
          ▼ (Eagle is desktop app, no CORS)
┌─────────────────────────┐
│ Eagle API               │
│ /api/item/addFromURL    │
└─────────────────────────┘
```

### Thumbnail Save (from main/search page) — Two-Phase Enqueue with Rule34 Retry Logic
```
User clicks 🦅 button on thumbnail
        │
        ▼
┌─────────────────────────┐
│ main-page-buttons.js    │
│ handleSaveClick()       │
└─────────┬───────────────┘
          │
          ▼ chrome.runtime.sendMessage({action: 'saveFromMainPage'})
┌─────────────────────────┐
│ background/service-     │
│ worker.js               │
│                         │
│ 1. handleHiddenTabParse()│
│    → queue.enqueue()    │ ← ORDER CAPTURED HERE!
│      state: pending_parse│
│      website/referer set│
│    → return position     │ ← Returns immediately
└─────────────────────────┘
          │
          ▼ (async, doesn't block)
┌─────────────────────────────────────┐
│ _parseHiddenTabInBackground()       │
│                                     │
│ [If rule34: rateLimiter.waitIfNeeded()] │
│                                     │
│ Loop (up to MAX_RETRIES times):     │
│  - Open hidden tab                  │
│  - Wait for content script          │
│  - Request parse with checkBlocker  │
│  - If 429: close tab, delay, retry  │
│  - If CAPTCHA: close tab, delay,    │
│    notify user, retry               │
│  - If success: break loop           │
│                                     │
│ On success:                         │
│  - queue.updateParsedData()         │
│  - Wait for download complete       │
│  - Close hidden tab                 │
│                                     │
│ On all retries exhausted:           │
│  - queue.markTaskFailed()           │
│  - Notify user via hiddenTabBlocked │
└─────────────────────────────────────┘
          │
          ▼ queue processes in FIFO order
┌─────────────────────────┐
│ DownloadSaveQueue       │
│ - Download in parallel  │
│   (or skip if useUrlDirect) │
│ - Save sequentially     │
└─────────┬───────────────┘
          │
          ▼
┌─────────────────────────┐
│ Eagle API               │
│ localhost:41595         │
└─────────────────────────┘
          │
          ▼ saveResult message
┌─────────────────────────┐
│ main-page-buttons.js    │
│ Update button state     │
│ (green/red)             │
└─────────────────────────┘
```

### Post Page Rule34 Blocked Page Flow
```
User opens post page on rule34.xxx
        │
        ▼
┌─────────────────────┐
│   content/main.js   │
│   init()            │
└─────────┬───────────┘
          │
          ▼ Check for blocker
┌───────────────────────────────┐
│ Rule34Parser.getBlockerType() │
├───────────────────────────────┤
│ 'rate_limit' →                │
│  - Show "429 Retrying..." msg │
│  - Auto-refresh after 2s      │
│                               │
│ 'captcha' →                   │
│  - Show "CAPTCHA blocked" msg │
│  - Focus this tab for user    │
│  - Show red banner with       │
│    post ID and instructions   │
│  - Poll every 1s for solution │
│  - When solved:               │
│    → broadcast captchaSolved  │
│    → continue normal parse    │
│                               │
│ null →                        │
│  - Continue normal init       │
│  - Parse page, show panel     │
└───────────────────────────────┘
```

## Adding a New Site

### For Post Page Parsing

#### Step 1: Create parser file
Create `extension/content/parsers/mysite-parser.js` extending `BaseParser`.

#### Step 2: Register the parser
Add to `PARSERS` array in `parser-registry.js`.

#### Step 3: Update manifest.json
Add script to content_scripts and URL patterns to `matches`/`host_permissions`.

### For Thumbnail Buttons

#### Step 1: Add site config
Add entry to `SITE_CONFIGS` in `site-configs.js`.

#### Step 2: Add URL builder for hidden tabs
Add to `buildPostPageUrl()` in `service-worker.js`.

#### Step 3: Update manifest.json
Add URL patterns to `matches` and `host_permissions`.

### To REMOVE a site
1. Delete from `PARSERS` in `parser-registry.js`
2. Delete from `SITE_CONFIGS` in `site-configs.js`
3. Remove URL builder from `buildPostPageUrl()` in `service-worker.js`
4. Remove script from `manifest.json` content_scripts
5. Remove URL pattern from `manifest.json` matches/host_permissions

### To DISABLE a site temporarily
Set `enabled: false` in the `PARSERS` array.

## Key Design Decisions

1. **Plugin-based parser system:** Each site is a separate parser extending BaseParser.

2. **BaseParser interface:** All parsers share a common interface. Tag normalization preserves `artist:` prefix.

3. **Parser Registry:** Central registry — add a site by creating a file and registering it.

4. **Site Configs:** Thumbnail button configs centralized in `site-configs.js`.

5. **Thumb Button Config:** All button styles in `thumb-button-config.js`.

6. **Background for downloads + API:** Content scripts cannot make cross-origin requests to localhost.

7. **Two-phase enqueue:** Thumbnail saves create task in `pending_parse` state immediately. Hidden tab parses asynchronously. Queue processes FIFO, polling `pending_parse` every 200ms with 120s timeout (increased for rule34 retries).

8. **Queue states:** Explicit state tracking: `pending_parse` → `pending_download` → `downloading` → `download_complete` → saved/failed.

9. **Tag merging:** `updateParsedData()` merges parsed tags with existing tags (preserves `parent:xxx` from Set Parent). Also merges `annotation` from parsed data.

10. **Hidden tab saves:** Hidden tab closed after download completes.

11. **Gelbooru handling:** `useUrlDirect = true` → Eagle downloads URL directly. Canvas extraction fallback in hidden tab uses base64.

12. **Sankaku quick parse:** Immediate parse first, wait for critical elements only, tags load in background.

13. **chrome.storage.local for cross-domain sync:** Panel and queue state sync via storage. Unique panel IDs prevent echo.

14. **Set Parent:** Always enabled button. On click, extracts postId from state or URL. Shows toast if unavailable. Preserved across data sync messages (not overwritten by main page broadcasts).

15. **Queue panel:** Slides in from right when >1 tasks. Max 5 tiles. Storage listener properly cleaned up on close.

16. **Post ID extraction:** Specific URL patterns only (`/post/show/`, `/posts/`, `/en/posts/`, `?id=`). No generic catch-all.

17. **SPA navigation cleanup:** All resources properly disposed — panel storage listeners, queue panel storage listeners, MutationObservers, timers, parser caches.

18. **Memory management:** `task.base64 = null` before task removal. `chunks.length = 0` after Blob creation. `processedPosts` capped at 5000 with auto-prune.

19. **Disk cleanup:** `save-progress` cleared on tab close and SPA navigation. `queue-state` cleared when queue empties.

20. **Event delegation:** Action button clicks handled via delegation on `.panel-body` to avoid disabled attribute issues.

21. **Hotkey for Set Parent:** Calls `panel.onSetParentClick()` directly instead of simulating button click (avoids disabled button click issues).

22. **JSDoc comments:** All public methods documented.

23. **Security:**
    - `chrome.runtime.sendMessage` in setTimeout wrapped in try-catch
    - Storage listeners registered once via guard flags
    - `chrome.runtime.lastError` checked in broadcast callback
    - No dead code

24. **Rule34 notes parsing:** Rule34Parser overrides `parse()` as async to parse image notes from raw HTML. Notes are stored in the server-rendered HTML as `<div class="note-body" id="note-body-{id}">text</div>` elements (textContent, NOT data attributes). Coordinates are extracted from the corresponding `<div class="note-box" style="top:Ypx; left:Xpx; width:Wpx; height:Hpx">` style attributes. A `fetch()` request retrieves the raw post page HTML (bypassing browser cache). HTML entities are decoded (`&#039;` → `'`, `<br />` → `\n`). Single note is passed as plain text; multiple notes are formatted with numbered separators (`--- Note N ---`). The `annotation` field flows through the entire pipeline (parser → content script → queue → Eagle API). Gelbooru-based sites (rule34.xxx) don't have a JSON notes API, so notes are extracted from raw HTML — they are NOT present in the DOM after JavaScript execution.

25. **Async parse compatibility:** All `parser.parse()` calls in `main.js` are `await`ed. Sync parsers (all except Rule34Parser) return a value that `await` resolves immediately, so no behavioral change for existing sites.

26. **Advanced Settings (Collapsible):** The Settings view in popup.html has a collapsible "Advanced" section, toggled via a ▼/▲ arrow button. Clicking expands/collapses with CSS max-height animation. Currently contains a single toggle switch: "Parse image notes" (Rule34.xxx notes → Eagle annotation). Settings are stored in `chrome.storage.local['settings']` as `{ parseNotes: boolean }`. Changes are broadcast to all tabs via `settingsChanged` message through the background worker. Content scripts load settings on init and update dynamically. The toggle uses an iOS-style switch (CSS-only, no dependencies).

27. **Event listener protection:** `window.addEventListener` for `booru-eagle-retry`, `booru-eagle-save`, `chrome.storage.onChanged`, and `chrome.runtime.onMessage` are all guarded by `_booruEagle*ListenerRegistered` flags to prevent accumulation on SPA navigation. Listeners use `currentParser` and `currentPanel` globals instead of closure-captured references to avoid stale references after panel recreation.

28. **Rule34 rate limiting & CAPTCHA handling:**
    - **Preventive rate limiting:** `RateLimiter` in background enforces 800ms minimum interval between hidden tab requests to rule34.xxx, preventing most 429 errors.
    - **Retry on 429:** If a 429 occurs, the background worker closes the hidden tab, exponentially backs off (3s, 6s, 12s...), and retries up to 5 times. Queue order is preserved because the task was enqueued before the hidden tab was opened.
    - **Retry on CAPTCHA:** Similar retry logic for CAPTCHA pages (5s initial delay). If CAPTCHA persists after all retries, the user is notified via `hiddenTabBlocked` message and the tab is focused.
    - **Post page detection:** On user-opened post pages, the content script detects 429 (auto-refresh after 2s) and CAPTCHA (shows red banner, polls for solution). When CAPTCHA is solved on one tab, `captchaSolved` is broadcast to all other tabs, which also reload if they were blocked.
    - **Parse timeout:** Increased from 30s to 120s to accommodate rule34 retry delays.

## Eagle API Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/item/list` | GET | Check if Eagle is running (returns 200) |
| `/api/item/addFromURL` | POST | Add image from URL with tags |

### addFromURL Payload

```json
{
  "url": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  "tags": ["tag1", "tag2"],
  "name": "post_123",
  "website": "https://example.com/post/123",
  "annotation": "Note text / image notes (Rule34.xxx)"
}
```

## Common Modifications

### Change Eagle API port
Edit `EAGLE_CONFIG.baseUrl` in config.js

### Change panel appearance
Edit `content/panel.css`

### Change queue panel appearance
Edit `content/queue-panel.css`

### Change thumbnail button appearance
Edit `content/thumb-button-config.js`

### Add new panel features
Edit `content/panel.js` — BooruEaglePanel class

### Change tag parsing for a site
Edit `content/parsers/{site}-parser.js`

### Add thumbnail support for a new site
Add entry to `SITE_CONFIGS` in `content/site-configs.js`

### Add a new site (full support)
See "Adding a New Site" section above

### Change Set Parent behavior
Edit `onSetParentClick()` in `content/panel.js`

### Change Sankaku element wait behavior
Edit `ensureParsedData()`, `waitForCriticalElements()`, `waitForTagsInBackground()` in `content/main.js`

### Change queue panel behavior
Edit `content/queue-panel.js` — BooruEagleQueuePanel class

### Change rule34 rate limiting behavior
Edit `RULE34_CONFIG` in `config.js` or `RULE34_CONFIG_BG` in `background/service-worker.js`

### Change CAPTCHA/429 handling behavior
Edit the blocking detection section in `content/main.js` `init()` function

## Supported Sites

| Site | Post Page | Thumbnail | Notes | Rule34 Blocker Handling |
|------|-----------|-----------|-------|------------------------|
| Danbooru (donmai.us) | ✅ | ✅ | Standard flow | N/A |
| Gelbooru (gelbooru.com) | ✅ | ✅ | URL sent directly to Eagle (CORS workaround) | N/A |
| Konachan (konachan.com) | ✅ | ✅ | Standard flow | N/A |
| Rule34 (rule34.xxx) | ✅ | ✅ | Standard flow + blocked page detection | ✅ 429 auto-refresh + CAPTCHA banner + hidden tab retry logic |
| Sankaku (chan.sankakucomplex.com) | ✅ | ✅ | Quick parse: immediate parse first, tags load in background | N/A |
| yande.re | ✅ | ✅ | Standard flow | N/A |
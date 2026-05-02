# Booru to Eagle Saver - Browser Extension

A Chromium browser extension that helps save images from Booru directly to Eagle Cool with tags

## Supported Sites

- **Danbooru**
- **Gelbooru**
- **Konachan**
- **Rule34.xxx**
- **Sankaku Complex** (chan.sankakucomplex fork)
- **yande.re**

## Screenshots


| <img width="282" height="201" alt="brave_hb2kDoKPk5" src="https://github.com/user-attachments/assets/4b10f207-58a6-479c-9941-c9e4a0856348" /> | <img width="415" height="970" alt="Eagle_pHhopRJ09R" src="https://github.com/user-attachments/assets/c229cf62-a87b-4104-863f-f0e47a74dea5" /> |
| :---: | :---: |
| _Panel_ | _Eagle-side ss_ |

## Installation

### Step 1: Install Eagle App

Make sure you have [Eagle](https://eagle.cool/) installed and running on your computer. The extension communicates with Eagle via its local API (localhost:41595).

### Step 2: Load the Extension

1. Open Chrome/Edge/Brave browser
2. Navigate to `//extensions/` tab
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the `extension` folder from this project
6. The extension icon should appear in your browser toolbar

### Step 3: Pin the Extension (Optional)

1. Click the puzzle piece icon in the toolbar
2. Find "Booru to Eagle Saver"
3. Click the pin icon to keep it visible

## Usage

### On Post Pages

1. **Navigate to a supported booru site**
2. **Open an image post** — the panel appears automatically on post pages
3. **The floating panel shows:**
   - Connection status to Eagle
   - Current site name
   - Image dimensions
   - Tag count
   - Post ID (green highlight when Set Parent is active)
4. **Click "Save"** to enqueue the image with all tags
5. **Click "Copy Tags"** to copy tags to clipboard

### On Main / Search Pages

1. Each thumbnail gets a **🦅 save button**
2. **Click the button** to save that post (opens hidden tab, parses, enqueues)
3. **Long-press the button** (~500ms) to set that post as the parent for subsequent saves
4. Button shows visual feedback: saving (blue) → success (green) / error (red)

### Set Parent

Set Parent prepends `parent:{postId}` to all saved images, useful for grouping related saves.

### Post-Save Toggle

When enabled, the current tab closes (or navigates back) 1 second after a successful save. Synced across all tabs.

### Stop Button

Clears the save queue and aborts any in-progress downloads. Flash animation syncs across all tabs.

### Default hotkeys

| Hotkey | Action |
|--------|--------|
| `Alt+Z` | Save (only on post page) |
| `Alt+X` | Set Parent (only on post page) / Stop Parenting |
| `Alt+C` | Stop (clear queue) |
| `Alt+A` | Toggle Post-Save auto-close |

## Eagle API

This extension uses the Eagle Plugin API:
- **Endpoint**: `http://localhost:41595/api/item/addFromURL`
- **Method**: POST
- **Payload**: URL (base64 or direct), tags, website, name

Documentation: https://developer.eagle.cool/plugin-api

## License

MIT License - Feel free to modify and distribute.
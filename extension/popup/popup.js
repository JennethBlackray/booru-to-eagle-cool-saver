/**
 * Booru to Eagle Saver - Popup Script
 * Uses background service worker for Eagle connection checks
 */

// ==================== SWIPE NAVIGATION ====================

const swipeContainer = document.getElementById('swipe-container');
const btnSettings = document.getElementById('btn-settings');
const btnBack = document.getElementById('btn-back');

function switchToSettings() {
  swipeContainer.classList.add('view-settings');
  swipeContainer.classList.remove('view-main');
}

function switchToMain() {
  swipeContainer.classList.add('view-main');
  swipeContainer.classList.remove('view-settings');
}

btnSettings.addEventListener('click', switchToSettings);
btnBack.addEventListener('click', switchToMain);

// ==================== ADVANCED SETTINGS (COLLAPSIBLE) ====================

const btnAdvancedToggle = document.getElementById('btn-advanced-toggle');
const collapseArrow = document.getElementById('collapse-arrow');
const advancedContent = document.getElementById('advanced-content');
const toggleParseNotes = document.getElementById('toggle-parse-notes');
const toggleYandereFix = document.getElementById('toggle-yandere-fix');

let advancedExpanded = false;

btnAdvancedToggle.addEventListener('click', () => {
  advancedExpanded = !advancedExpanded;
  if (advancedExpanded) {
    collapseArrow.classList.add('expanded');
    advancedContent.classList.remove('collapsed');
    advancedContent.classList.add('expanded');
  } else {
    collapseArrow.classList.remove('expanded');
    advancedContent.classList.remove('expanded');
    advancedContent.classList.add('collapsed');
  }
});

/**
 * Load advanced settings from storage
 */
async function loadAdvancedSettings() {
  const stored = await chrome.storage.local.get('settings');
  const settings = stored.settings || { parseNotes: true, yandereFix: false }; // Default: ON, OFF
  toggleParseNotes.checked = settings.parseNotes;
  toggleYandereFix.checked = !!settings.yandereFix;
  return settings;
}

/**
 * Save advanced settings to storage
 */
async function saveAdvancedSettings(settings) {
  await chrome.storage.local.set({ settings });
}

toggleParseNotes.addEventListener('change', async () => {
  const settings = (await chrome.storage.local.get('settings')).settings || {};
  settings.parseNotes = toggleParseNotes.checked;
  await saveAdvancedSettings(settings);

  // Notify all tabs of settings change
  chrome.runtime.sendMessage({
    action: 'settingsChanged',
    settings: settings
  });
});

toggleYandereFix.addEventListener('change', async () => {
  const settings = (await chrome.storage.local.get('settings')).settings || {};
  settings.yandereFix = toggleYandereFix.checked;
  await saveAdvancedSettings(settings);

  // Notify all tabs of settings change
  chrome.runtime.sendMessage({
    action: 'settingsChanged',
    settings: settings
  });
});

// ==================== EAGLE CONNECTION ====================

async function checkEagleConnection() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'checkEagleConnection' });
    return response;
  } catch (e) {
    console.error('[BooruEagle Popup] Check failed:', e);
    return { connected: false, error: e.message };
  }
}

function updateEagleStatus(connected, error) {
  const dot = document.getElementById('eagle-status-dot');
  const text = document.getElementById('eagle-status-text');
  
  if (connected) {
    dot.className = 'status-dot';
    text.textContent = 'Connected';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = error ? 'Error' : 'Not Running';
  }
}

async function getCurrentSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return '-';
    
    const hostname = new URL(tab.url).hostname;
    
    const siteNames = {
      'danbooru.donmai.us': 'Danbooru',
      'gelbooru.com': 'Gelbooru',
      'konachan.com': 'Konachan',
      'rule34.xxx': 'Rule34.xxx',
      'chan.sankakucomplex.com': 'Sankaku Complex',
      'yande.re': 'Yande.re'
    };
    
    return siteNames[hostname] || hostname;
  } catch (e) {
    return '-';
  }
}

async function updateCurrentSite() {
  const siteEl = document.getElementById('current-site');
  const site = await getCurrentSite();
  siteEl.textContent = site;
}

// ==================== HOTKEYS ====================

/**
 * Default hotkey mappings
 * Easy to extend - just add new entries
 */
const DEFAULT_HOTKEYS = {
  'hotkey-save': 'Alt+Z',
  'hotkey-parent': 'Alt+X',
  'hotkey-stop': 'Alt+C',
  'hotkey-postsave': 'Alt+A'
};

/**
 * Action mapping: input ID -> action to send to content script
 */
const HOTKEY_ACTIONS = {
  'hotkey-save': 'triggerSave',
  'hotkey-parent': 'triggerSetParent',
  'hotkey-stop': 'triggerStop',
  'hotkey-postsave': 'triggerPostSave'
};

/**
 * Load saved hotkeys or use defaults
 */
async function loadHotkeys() {
  const stored = await chrome.storage.local.get('hotkeys');
  const hotkeys = stored.hotkeys || DEFAULT_HOTKEYS;
  
  for (const [id, value] of Object.entries(hotkeys)) {
    const input = document.getElementById(id);
    if (input) {
      input.value = value;
    }
  }
  
  return hotkeys;
}

/**
 * Save hotkeys to storage
 */
async function saveHotkeys(hotkeys) {
  await chrome.storage.local.set({ hotkeys });
}

/**
 * Format key combination for display
 */
function formatKeyCombo(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  
  // Don't record modifier keys alone
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
    return null;
  }
  
  // Format the main key
  let mainKey = e.key;
  if (mainKey.length === 1) {
    mainKey = mainKey.toUpperCase();
  } else if (mainKey === ' ') {
    mainKey = 'Space';
  } else if (mainKey === 'Escape') {
    mainKey = 'Esc';
  } else if (mainKey === 'Delete') {
    mainKey = 'Del';
  } else if (mainKey === 'Backspace') {
    mainKey = 'Bksp';
  } else if (mainKey === 'ArrowUp') {
    mainKey = '↑';
  } else if (mainKey === 'ArrowDown') {
    mainKey = '↓';
  } else if (mainKey === 'ArrowLeft') {
    mainKey = '←';
  } else if (mainKey === 'ArrowRight') {
    mainKey = '→';
  }
  
  parts.push(mainKey);
  return parts.join('+');
}

/**
 * Setup hotkey recording
 */
function setupHotkeyRecording() {
  const inputs = document.querySelectorAll('.hotkey-input');
  let recordingInput = null;
  
  inputs.forEach(input => {
    // Click to start recording
    input.addEventListener('focus', () => {
      recordingInput = input;
      input.classList.add('recording');
      input.value = '...';
    });
    
    input.addEventListener('blur', () => {
      if (recordingInput === input) {
        recordingInput = null;
        input.classList.remove('recording');
        // Restore value if empty
        if (input.value === '...' || input.value === '') {
          input.value = DEFAULT_HOTKEYS[input.id] || '';
        }
      }
    });
    
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      
      if (!recordingInput) return;
      
      const combo = formatKeyCombo(e);
      if (combo) {
        recordingInput.value = combo;
        recordingInput.classList.remove('recording');
        recordingInput.blur();
        
        // Save hotkey
        saveCurrentHotkeys();
      }
    });
  });
}

/**
 * Save current hotkey values
 */
async function saveCurrentHotkeys() {
  const hotkeys = {};
  const inputs = document.querySelectorAll('.hotkey-input');
  
  inputs.forEach(input => {
    hotkeys[input.id] = input.value;
  });
  
  await saveHotkeys(hotkeys);
  
  // Notify background script of hotkey changes
  chrome.runtime.sendMessage({
    action: 'updateHotkeys',
    hotkeys: hotkeys,
    actions: HOTKEY_ACTIONS
  });
}

/**
 * Send action to active tab's content script
 */
function sendActionToTab(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'hotkeyAction',
        type: action
      }).catch(() => {
        console.log('[BooruEagle Popup] No content script on this tab');
      });
    }
  });
}

// ==================== INITIALIZATION ====================

async function init() {
  console.log('[BooruEagle Popup] Initializing...');
  
  // Check Eagle connection
  const result = await checkEagleConnection();
  updateEagleStatus(result.connected, result.error);
  
  // Update current site
  await updateCurrentSite();
  
  // Load hotkeys
  await loadHotkeys();

  // Load advanced settings
  await loadAdvancedSettings();

  // Setup hotkey recording
  setupHotkeyRecording();
  
  // Button handlers
  document.getElementById('btn-check-eagle').addEventListener('click', async () => {
    const btn = document.getElementById('btn-check-eagle');
    btn.innerHTML = '<span>⏳</span> Checking...';
    btn.disabled = true;
    
    const result = await checkEagleConnection();
    updateEagleStatus(result.connected, result.error);
    
    btn.innerHTML = '<span>🔄</span> Check';
    btn.disabled = false;
  });
  
  console.log('[BooruEagle Popup] Initialized');
}

// Run on popup open
init();
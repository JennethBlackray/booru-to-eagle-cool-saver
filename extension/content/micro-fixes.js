/**
 * @fileoverview Booru to Eagle Saver - Micro-fixes for specific sites
 * 
 * This module contains small site-specific adjustments that can be
 * toggled via extension settings.
 */

class MicroFixes {
  constructor() {
    this.fixes = {
      yandereFix: {
        matches: ['yande.re'],
        handler: () => this.applyYandereFix()
      }
    };
    
    this._observers = new Map();
  }

  /**
   * Apply all fixes relevant to the current site and settings
   * @param {Object} settings - Extension settings from storage
   */
  applyAll(settings) {
    const hostname = window.location.hostname;
    
    for (const [key, fix] of Object.entries(this.fixes)) {
      const isMatch = fix.matches.some(m => hostname.includes(m));
      const isEnabled = settings && settings[key];
      
      if (isMatch && isEnabled) {
        console.log(`[BooruEagle MicroFixes] Applying fix: ${key}`);
        fix.handler();
      } else if (isMatch && !isEnabled) {
        console.log(`[BooruEagle MicroFixes] Disabling fix: ${key}`);
        this.stopFix(key);
      }
    }
  }

  /**
   * Stop a specific fix and its observers
   * @param {string} key 
   */
  stopFix(key) {
    if (this._observers.has(key)) {
      this._observers.get(key).disconnect();
      this._observers.delete(key);
    }
    
    // Site-specific cleanup if needed
    if (key === 'yandereFix') {
      // We don't necessarily want to re-hide elements that were already shown,
      // as it might be jarring, but we stop the observer.
    }
  }

  /**
   * Yande.re fix: show hidden NSFW posts and add a red border
   * Original user script by remisiki
   */
  applyYandereFix() {
    const fixAction = () => {
      document.querySelectorAll(".javascript-hide").forEach(x => {
        x.classList.remove("javascript-hide");
        x.style.border = "1px solid red";
      });
    };

    // Apply immediately
    fixAction();

    // Setup observer for infinite scroll/dynamic content
    if (!this._observers.has('yandereFix')) {
      const observer = new MutationObserver((mutations) => {
        fixAction();
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      
      this._observers.set('yandereFix', observer);
    }
  }
  
  /**
   * Cleanup all observers
   */
  destroy() {
    for (const observer of this._observers.values()) {
      observer.disconnect();
    }
    this._observers.clear();
  }
}

// Export
window.MicroFixes = MicroFixes;

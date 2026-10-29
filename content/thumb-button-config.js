/**
 * @fileoverview Thumbnail button style configuration
 * 
 * All visual styles for thumbnail save buttons are defined here.
 * To change button appearance, edit this file only.
 * 
 * @module thumb-button-config
 */

/**
 * @typedef {Object} ThumbButtonStyle
 * @property {string} containerClass - CSS class for the button container
 * @property {string} buttonClass - CSS class for the button itself
 * @property {string} icon - Button icon (emoji or text)
 * @property {string} tooltipDefault - Default tooltip text
 * @property {string} tooltipSaving - Tooltip text while saving
 * @property {string} tooltipSuccess - Tooltip text on success
 * @property {string} tooltipError - Tooltip text prefix on error
 * @property {string} css - Complete CSS styles for the buttons
 */

/**
 * Thumbnail button style configuration
 * @type {ThumbButtonStyle}
 */
const THUMB_BUTTON_CONFIG = {
  containerClass: 'booru-eagle-thumb-btn-container',
  buttonClass: 'booru-eagle-thumb-btn',
  icon: '🦅',
  tooltipDefault: 'Save to Eagle',
  tooltipSaving: 'Parsing...',
  tooltipSuccess: 'Saved!',
  tooltipError: 'Error: ',
  collectedBadgeClass: 'booru-eagle-collected-badge',
  
  css: `
    /* Always-visible compact pill badge at top-right of thumbnail */
    .booru-eagle-collected-badge {
      position: absolute !important;
      top: 4px !important;
      right: 4px !important;
      left: auto !important;
      bottom: auto !important;
      z-index: 101 !important;
      box-sizing: border-box !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      height: 18px !important;
      max-height: 18px !important;
      min-width: 24px !important;
      max-width: calc(100% - 8px) !important;
      padding: 0 6px !important;
      margin: 0 !important;
      border-radius: 9px !important;
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.95), rgba(109, 40, 217, 0.95)) !important;
      border: 1px solid rgba(216, 180, 254, 0.45) !important;
      color: #ffffff !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      line-height: 18px !important;
      letter-spacing: 0.3px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4) !important;
      backdrop-filter: blur(4px) !important;
      -webkit-backdrop-filter: blur(4px) !important;
      pointer-events: auto !important;
      cursor: pointer !important;
      user-select: none !important;
      text-transform: lowercase !important;
      vertical-align: top !important;
    }

    /* Container for save buttons under each thumbnail */
    .booru-eagle-thumb-btn-container {
      position: absolute !important;
      bottom: 4px !important;
      right: 4px !important;
      left: auto !important;
      top: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      z-index: 100 !important;
      display: flex !important;
      gap: 4px !important;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: auto !important;
    }

    /* Show on hover */
    .post-preview:hover .booru-eagle-thumb-btn-container,
    .post-preview-container:hover .booru-eagle-thumb-btn-container,
    article:hover .booru-eagle-thumb-btn-container,
    span.thumb:hover .booru-eagle-thumb-btn-container,
    li:hover .booru-eagle-thumb-btn-container,
    a:hover .booru-eagle-thumb-btn-container,
    .item:hover .booru-eagle-thumb-btn-container,
    .wrap_image:hover .booru-eagle-thumb-btn-container {
      opacity: 1;
    }

    /* Prevent thumbnail container baseline shifts on inline-block booru layouts */
    span.thumb,
    ul#post-list-posts li {
      vertical-align: top !important;
    }

    /* Main button */
    .booru-eagle-thumb-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      background: rgba(20, 20, 20, 0.7);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      padding: 0;
      line-height: 1;
    }

    .booru-eagle-thumb-btn:hover {
      background: rgba(40, 40, 40, 0.85);
      border-color: rgba(255, 255, 255, 0.35);
      transform: scale(1.1);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    .booru-eagle-thumb-btn:active {
      transform: scale(0.95);
    }

    /* Button states */
    .booru-eagle-thumb-btn.saving {
      background: rgba(255, 165, 0, 0.6);
      border-color: rgba(255, 165, 0, 0.8);
      cursor: wait;
      animation: booru-eagle-pulse 1s ease-in-out infinite;
    }

    .booru-eagle-thumb-btn.success {
      background: rgba(0, 180, 0, 0.7);
      border-color: rgba(0, 180, 0, 0.9);
    }

    .booru-eagle-thumb-btn.error {
      background: rgba(180, 0, 0, 0.7);
      border-color: rgba(180, 0, 0, 0.9);
    }

    /* Parent-set state (green glow) */
    .booru-eagle-thumb-btn.parent-set {
      background: rgba(0, 180, 0, 0.8) !important;
      border-color: rgba(0, 180, 0, 0.9) !important;
      box-shadow: 0 0 12px rgba(0, 180, 0, 0.5);
      animation: booru-eagle-parent-flash 0.5s ease-out;
    }

    @keyframes booru-eagle-parent-flash {
      0% { transform: scale(1.2); box-shadow: 0 0 20px rgba(0, 180, 0, 0.8); }
      100% { transform: scale(1); box-shadow: 0 0 12px rgba(0, 180, 0, 0.5); }
    }

    /* Pulse animation for saving state */
    @keyframes booru-eagle-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* Global Floating Tooltip (never clipped by thumbnail overflow) */
    .booru-eagle-global-tooltip {
      position: fixed !important;
      z-index: 2147483647 !important;
      background: rgba(20, 20, 20, 0.92) !important;
      backdrop-filter: blur(8px) !important;
      -webkit-backdrop-filter: blur(8px) !important;
      color: #ffffff !important;
      padding: 4px 8px !important;
      border-radius: 6px !important;
      font-size: 11px !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
      font-weight: 500 !important;
      line-height: 1.3 !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      border: 1px solid rgba(255, 255, 255, 0.18) !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4) !important;
      opacity: 0;
      transform: scale(0.92);
      transition: opacity 0.12s ease, transform 0.12s ease;
    }

    .booru-eagle-global-tooltip.visible {
      opacity: 1 !important;
      transform: scale(1) !important;
    }

    /* Dark theme adjustments */
    body.dark .booru-eagle-thumb-btn,
    body.style-dark .booru-eagle-thumb-btn {
      background: rgba(20, 20, 20, 0.75);
      border-color: rgba(255, 255, 255, 0.15);
    }

    /* Light theme adjustments */
    body:not(.dark):not(.style-dark) .booru-eagle-thumb-btn {
      background: rgba(255, 255, 255, 0.75);
      border-color: rgba(0, 0, 0, 0.15);
      color: #333;
    }

    body:not(.dark):not(.style-dark) .booru-eagle-thumb-btn:hover {
      background: rgba(255, 255, 255, 0.9);
      border-color: rgba(0, 0, 0, 0.3);
    }
  `
};

// Export for use in other modules
window.THUMB_BUTTON_CONFIG = THUMB_BUTTON_CONFIG;
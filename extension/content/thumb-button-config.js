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
  
  css: `
    /* Container for save buttons under each thumbnail */
    .booru-eagle-thumb-btn-container {
      position: absolute;
      bottom: 4px;
      right: 4px;
      z-index: 100;
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    /* Show on hover */
    .post-preview:hover .booru-eagle-thumb-btn-container,
    .post-preview-container:hover .booru-eagle-thumb-btn-container,
    article:hover .booru-eagle-thumb-btn-container,
    span.thumb:hover .booru-eagle-thumb-btn-container,
    li:hover .booru-eagle-thumb-btn-container {
      opacity: 1;
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

    /* Tooltip */
    .booru-eagle-thumb-btn::after {
      content: attr(data-tooltip);
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%) scale(0.8);
      background: rgba(20, 20, 20, 0.9);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #fff;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: all 0.15s ease;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }

    .booru-eagle-thumb-btn:hover::after {
      opacity: 1;
      transform: translateX(-50%) scale(1);
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

    body:not(.dark):not(.style-dark) .booru-eagle-thumb-btn::after {
      background: rgba(255, 255, 255, 0.9);
      color: #333;
      border-color: rgba(0, 0, 0, 0.15);
    }
  `
};

// Export for use in other modules
window.THUMB_BUTTON_CONFIG = THUMB_BUTTON_CONFIG;
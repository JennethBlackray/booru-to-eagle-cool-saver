/**
 * comparison-card.js - Interactive duplicate inspector & resolution comparison popup
 */

(function(global) {
  'use strict';

  /**
   * Max differing pHash bits (of 256) for two thumbnails to count as the same picture.
   * Calibrated on real data: the same image across sites differs by 0-5 bits, alt versions
   * with visible changes by ~16+. Small edits (eyes, censor bars) can stay under this and are not detectable.
   */
  const SAME_IMAGE_MAX_DISTANCE = 8;

  /**
   * Block brightness difference (in standard deviations, after normalizing each image's brightness/contrast)
   * above which a 16×16 block counts as changed. Calibrated on real data: the same image from different
   * sites stays at 0.02-0.09, alt versions with visible edits reach 1.4+.
   */
  const BLOCK_DIFF_THRESHOLD = 0.35;

  /** Eagle tags that describe the item rather than its content */
  const META_TAG_PREFIXES = ['rating:', 'parent:'];

  /**
   * Per-block difference mask between two 64-char hex pHashes (bit i = block y*16+x)
   * @returns {Uint8Array|null}
   */
  function pHashDiffMask(a, b) {
    if (!a || !b || a.length !== 64 || b.length !== 64) return null;
    const mask = new Uint8Array(256);
    for (let i = 0; i < 64; i++) {
      const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      for (let k = 0; k < 4; k++) mask[i * 4 + k] = (x >> (3 - k)) & 1;
    }
    return mask;
  }

  /** @param {Uint8Array} levels @returns {Float64Array} z-scores (removes global brightness/contrast differences) */
  function zScores(levels) {
    let sum = 0;
    for (let i = 0; i < levels.length; i++) sum += levels[i];
    const mean = sum / levels.length;
    let sq = 0;
    for (let i = 0; i < levels.length; i++) sq += (levels[i] - mean) ** 2;
    const std = Math.sqrt(sq / levels.length) || 1;
    const out = new Float64Array(levels.length);
    for (let i = 0; i < levels.length; i++) out[i] = (levels[i] - mean) / std;
    return out;
  }

  /**
   * Per-block mask of real brightness changes between two images (base64 block levels).
   * Unlike pHash bits ("above/below median"), this shows where the content actually differs:
   * pHash bits flip on noise for blocks sitting at the median and stay put for changes that don't cross it.
   * @returns {Uint8Array|null}
   */
  function blockDiffMask(a, b) {
    if (typeof BlockHash === 'undefined') return null;
    const la = BlockHash.decodeBlockLevels(a);
    const lb = BlockHash.decodeBlockLevels(b);
    if (!la || !lb) return null;
    const za = zScores(la);
    const zb = zScores(lb);
    const mask = new Uint8Array(256);
    for (let i = 0; i < 256; i++) mask[i] = Math.abs(za[i] - zb[i]) > BLOCK_DIFF_THRESHOLD ? 1 : 0;
    return mask;
  }

  class ComparisonCard {
    constructor() {
      this.popover = null;
      this.hideTimer = null;
      this.activeTrigger = null;
      this.currentData = null;
      this._init();
    }

    _init() {
      if (document.getElementById('booru-eagle-comparison-popover')) {
        this.popover = document.getElementById('booru-eagle-comparison-popover');
        return;
      }

      const el = document.createElement('div');
      el.id = 'booru-eagle-comparison-popover';
      el.className = 'booru-eagle-comparison-popover';
      el.innerHTML = `
        <div class="bec-header">
          <div class="bec-title">
            <span class="bec-icon">🦅</span>
            <span id="bec-title-text">In Eagle</span>
          </div>
          <span class="bec-similarity-badge" id="bec-badge-sim">100% Match</span>
        </div>
        <div class="bec-content">
          <div class="bec-row" id="bec-row-eagle">
            <span class="bec-row-label">Eagle:</span>
            <span class="bec-row-val" id="bec-val-eagle">-</span>
          </div>
          <div class="bec-row" id="bec-row-web">
            <span class="bec-row-label">Web:</span>
            <span class="bec-row-val" id="bec-val-web">-</span>
          </div>
          <div class="bec-row">
            <span class="bec-row-label">Image:</span>
            <span class="bec-row-val bec-verdict" id="bec-val-verdict">-</span>
          </div>
          <div class="bec-row">
            <span class="bec-row-label">Tags:</span>
            <span class="bec-row-val" id="bec-val-tags">-</span>
          </div>
          <div class="bec-row">
            <span class="bec-row-label">Eagle parent:</span>
            <span class="bec-row-val" id="bec-val-parent">-</span>
          </div>
        </div>
        <div class="bec-diff" id="bec-diff" style="display: none;">
          <div class="bec-diff-frame">
            <img id="bec-diff-img" alt="" draggable="false">
            <canvas id="bec-diff-canvas" width="16" height="16"></canvas>
          </div>
          <div class="bec-diff-caption">Red — areas that differ from the Eagle copy</div>
        </div>
        <div class="bec-upgrade-section" id="bec-upgrade-section" style="display: none;">
          <div class="bec-upgrade-text" id="bec-upgrade-text">★ Web version has higher resolution</div>
          <div class="bec-upgrade-warning" id="bec-upgrade-warning" style="display: none;"></div>
          <button class="bec-btn bec-btn-replace" id="bec-btn-replace">
            ⚡ Replace in Eagle (Upgrade)
          </button>
        </div>
      `;

      // Prevent closing when mouse is inside the popover
      el.addEventListener('mouseenter', () => this.cancelHide());
      el.addEventListener('mouseleave', () => this.scheduleHide());

      document.body.appendChild(el);
      this.popover = el;
    }

    formatBytes(bytes) {
      if (!bytes || bytes <= 0) return '';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    }

    /**
     * @param {Object} data
     * @param {Object|null} data.eagleItem - Matched item from the collected DB (id, pHash, w, h, size, ext)
     * @param {Object} data.webItem - {width, height, size, tagCount, thumbUrl}
     * @param {number} [data.similarity]
     * @param {number|null} [data.distance] - pHash Hamming distance (phash matches only)
     * @param {string|null} [data.queryPHash] - pHash of the web thumbnail
     * @param {string|null} [data.queryBlocks] - Block brightness levels of the web thumbnail (base64)
     * @param {boolean} [data.isExactMatch] - Matched by post URL
     * @param {Function} [data.onReplace]
     * @param {HTMLElement} triggerEl
     */
    show(data, triggerEl) {
      this.cancelHide();
      this.currentData = { ...data, eagleInfo: undefined };
      this.currentPostId = data?.postId ? String(data.postId) : null;
      this.activeTrigger = triggerEl;

      this._render();

      // Position Popover
      this._position(triggerEl);
      this.popover.classList.add('visible');
    }

    /**
     * Apply live Eagle item info (tags, folders, dimensions) once the background answers
     * @param {string} postId
     * @param {Object|null} info - null when Eagle is unreachable or the item is not resolved yet
     */
    updateEagleInfo(postId, info) {
      if (!this.currentData || String(postId) !== this.currentPostId) return;
      this.currentData.eagleInfo = info;
      this._render();
      this._position(this.activeTrigger);
    }

    updateWebDetails(postIdOrWidth, widthOrHeight, heightOrSize = 0, maybeSize = 0) {
      if (!this.popover || !this.currentData) return;

      // Support signature (postId, width, height, size) or legacy (width, height, size)
      let postId = null;
      let width = 0;
      let height = 0;
      let size = 0;

      if (typeof postIdOrWidth === 'string' || (typeof postIdOrWidth === 'number' && widthOrHeight !== undefined && heightOrSize !== undefined && maybeSize !== undefined && maybeSize > 0)) {
        postId = String(postIdOrWidth);
        width = widthOrHeight;
        height = heightOrSize;
        size = maybeSize;
      } else {
        width = postIdOrWidth;
        height = widthOrHeight;
        size = heightOrSize;
      }

      // Drop stale async response if user already moved cursor to another post
      if (postId && this.currentPostId && postId !== this.currentPostId) {
        return;
      }

      if (!width || !height) {
        const valWeb = this.popover.querySelector('#bec-val-web');
        if (valWeb) valWeb.textContent = 'Resolution not detected';
        return;
      }

      this.currentData.webItem = this.currentData.webItem || {};
      this.currentData.webItem.width = width;
      this.currentData.webItem.height = height;
      if (size > 0) {
        this.currentData.webItem.size = size;
      }
      this._render();
    }

    updateWebDimensions(width, height) {
      this.updateWebDetails(width, height, 0);
    }

    /** Eagle dimensions: live info when available, collected DB otherwise */
    _eagleDims() {
      const { eagleItem, eagleInfo } = this.currentData;
      return {
        w: eagleInfo?.width || eagleItem?.w || eagleItem?.width || 0,
        h: eagleInfo?.height || eagleItem?.h || eagleItem?.height || 0
      };
    }

    /**
     * Where the web thumbnail differs from the Eagle copy: block brightness when both sides have it
     * (database built by the current collector), pHash bits otherwise
     * @returns {{mask: Uint8Array|null, count: number, source: 'blocks'|'hash'|null}}
     */
    _diff() {
      const d = this.currentData;
      if (d.isExactMatch) return { mask: null, count: 0, source: null };
      let mask = blockDiffMask(d.queryBlocks, d.eagleItem?.blocks);
      let source = 'blocks';
      if (!mask) {
        mask = pHashDiffMask(d.queryPHash, d.eagleItem?.pHash);
        source = mask ? 'hash' : null;
      }
      const count = mask ? mask.reduce((a, b) => a + b, 0) : 0;
      return { mask, count, source };
    }

    /**
     * Decide whether the Eagle copy is the same picture or an alternate version
     * @param {{count: number, source: string|null}} diff
     * @returns {{cls: string, text: string}}
     */
    _verdict(diff) {
      const d = this.currentData;
      if (d.isExactMatch) return { cls: 'same', text: 'Same post' };
      if (diff.source === 'blocks') {
        return diff.count > 0
          ? { cls: 'alt', text: 'Alt version (visible changes)' }
          : { cls: 'maybe', text: 'Looks identical' };
      }
      if (d.distance != null && d.distance > SAME_IMAGE_MAX_DISTANCE) {
        return { cls: 'alt', text: 'Alt version? (visible changes)' };
      }
      return { cls: 'maybe', text: 'Looks identical' };
    }

    _render() {
      const d = this.currentData;
      if (!d) return;
      const { eagleItem, eagleInfo, webItem, similarity = 100 } = d;

      const { w: eagleW, h: eagleH } = this._eagleDims();
      const eaglePixels = eagleW * eagleH;
      const eagleSizeStr = this.formatBytes(eagleInfo?.size || eagleItem?.size);
      const eagleExtRaw = eagleInfo?.ext || eagleItem?.ext;
      const eagleExt = eagleExtRaw ? `.${eagleExtRaw}` : '';

      const webW = webItem?.w || webItem?.width || 0;
      const webH = webItem?.h || webItem?.height || 0;
      const webPixels = webW * webH;
      const isUpgrade = webPixels > eaglePixels && eaglePixels > 0;

      const simPct = Math.round(similarity);
      const isExact = simPct >= 99 || d.isExactMatch;

      // Header match badge
      const simBadge = this.popover.querySelector('#bec-badge-sim');
      const titleText = this.popover.querySelector('#bec-title-text');
      simBadge.classList.remove('exact', 'upgrade');

      if (isExact) {
        simBadge.textContent = '100% Match';
        simBadge.classList.add('exact');
        titleText.textContent = 'Already in Eagle';
      } else {
        simBadge.textContent = `${simPct}% Similarity`;
        titleText.textContent = 'Visual Duplicate';
      }

      // Format Eagle stats
      const valEagle = this.popover.querySelector('#bec-val-eagle');
      if (eagleW && eagleH) {
        let text = `${eagleW}×${eagleH}`;
        if (eagleSizeStr) {
          text += ` (${eagleSizeStr}${eagleExt ? ', ' + eagleExt : ''})`;
        }
        valEagle.textContent = text;
      } else {
        valEagle.textContent = eagleSizeStr ? eagleSizeStr : 'In Library';
      }

      // Format Web stats
      const valWeb = this.popover.querySelector('#bec-val-web');
      valWeb.classList.remove('better');
      const webSizeStr = this.formatBytes(webItem?.size);

      if (webW && webH) {
        let text = `${webW}×${webH}`;
        if (webSizeStr) {
          text += ` (${webSizeStr})`;
        }
        if (isUpgrade) {
          const ratio = (webPixels / eaglePixels).toFixed(1);
          text += ` [${ratio}× px]`;
          valWeb.classList.add('better');
        }
        valWeb.textContent = text;
      } else {
        valWeb.textContent = 'Detecting...';
      }

      // Same picture or alternate version
      const diff = this._diff();
      const verdict = this._verdict(diff);
      const valVerdict = this.popover.querySelector('#bec-val-verdict');
      valVerdict.textContent = verdict.text;
      valVerdict.className = `bec-row-val bec-verdict ${verdict.cls}`;

      this._renderTagsAndParent();
      this._renderDiffMap(verdict, diff);

      // Upgrade section
      const upgradeSection = this.popover.querySelector('#bec-upgrade-section');
      const upgradeText = this.popover.querySelector('#bec-upgrade-text');
      const upgradeWarning = this.popover.querySelector('#bec-upgrade-warning');
      const replaceBtn = this.popover.querySelector('#bec-btn-replace');

      if (isUpgrade) {
        const ratio = (webPixels / eaglePixels).toFixed(1);
        simBadge.textContent = 'Upgrade';
        simBadge.classList.add('upgrade');
        upgradeText.textContent = `★ Web version is ${ratio}× higher resolution`;
        upgradeSection.style.display = 'block';

        const isAlt = verdict.cls === 'alt';
        upgradeWarning.style.display = isAlt ? 'block' : 'none';
        upgradeWarning.textContent = isAlt ? '⚠ Looks like a different version — the Eagle copy will be trashed' : '';

        if (!replaceBtn.dataset.busy) {
          replaceBtn.disabled = false;
          replaceBtn.textContent = isAlt ? '⚡ Replace anyway' : '⚡ Replace in Eagle (Upgrade)';
        }
        replaceBtn.onclick = async (e) => {
          e.stopPropagation();
          replaceBtn.disabled = true;
          replaceBtn.dataset.busy = '1';
          replaceBtn.textContent = 'Replacing in Eagle...';
          try {
            if (typeof d.onReplace === 'function') {
              await d.onReplace();
            }
          } finally {
            delete replaceBtn.dataset.busy;
          }
          this.hide();
        };
      } else {
        upgradeSection.style.display = 'none';
      }
    }

    _renderTagsAndParent() {
      const { eagleInfo, webItem } = this.currentData;
      const valTags = this.popover.querySelector('#bec-val-tags');
      const valParent = this.popover.querySelector('#bec-val-parent');
      valParent.classList.remove('has-parent');

      const webCount = webItem?.tagCount || 0;
      if (eagleInfo === undefined) {
        valTags.textContent = `Eagle … · Web ${webCount}`;
        valParent.textContent = '…';
        return;
      }
      if (!eagleInfo) {
        valTags.textContent = `Eagle ? · Web ${webCount}`;
        valParent.textContent = 'unknown';
        return;
      }

      const eagleTags = eagleInfo.tags || [];
      const eagleCount = eagleTags.filter(t => !META_TAG_PREFIXES.some(p => String(t).toLowerCase().startsWith(p))).length;

      const eagleSpan = document.createElement('span');
      eagleSpan.textContent = `Eagle ${eagleCount}`;
      const webSpan = document.createElement('span');
      webSpan.textContent = `Web ${webCount}`;
      if (webCount > eagleCount) webSpan.className = 'better';
      else if (eagleCount > webCount) eagleSpan.className = 'better';
      valTags.replaceChildren(eagleSpan, ' · ', webSpan);

      const parentTag = eagleTags.find(t => String(t).toLowerCase().startsWith('parent:'));
      if (parentTag) {
        valParent.textContent = parentTag.slice('parent:'.length).trim();
        valParent.classList.add('has-parent');
      } else {
        valParent.textContent = 'none';
      }
    }

    /**
     * Overlay the 16×16 blocks that differ on top of the web thumbnail
     * @param {{cls: string}} verdict
     * @param {{mask: Uint8Array|null, count: number}} diff
     */
    _renderDiffMap(verdict, diff) {
      const d = this.currentData;
      const diffEl = this.popover.querySelector('#bec-diff');
      const { mask, count: diffCount } = diff;

      if (!mask || diffCount === 0 || !d.webItem?.thumbUrl || verdict.cls === 'same') {
        diffEl.style.display = 'none';
        return;
      }

      const img = this.popover.querySelector('#bec-diff-img');
      if (img.getAttribute('src') !== d.webItem.thumbUrl) {
        img.src = d.webItem.thumbUrl;
      }

      const canvas = this.popover.querySelector('#bec-diff-canvas');
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 16, 16);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
      for (let i = 0; i < 256; i++) {
        if (mask[i]) ctx.fillRect(i % 16, Math.floor(i / 16), 1, 1);
      }
      diffEl.style.display = 'block';
    }

    _position(triggerEl) {
      if (!triggerEl) return;
      const rect = triggerEl.getBoundingClientRect();
      const popW = 250;
      const popH = this.popover.offsetHeight || 100;

      let left = rect.right + 8;
      let top = rect.top;

      // Flip left if offscreen right
      if (left + popW > window.innerWidth - 10) {
        left = rect.left - popW - 8;
      }
      if (left < 10) {
        left = Math.max(10, (window.innerWidth - popW) / 2);
      }

      // Clamp vertical
      if (top + popH > window.innerHeight - 10) {
        top = window.innerHeight - popH - 10;
      }
      top = Math.max(10, top);

      this.popover.style.left = `${Math.round(left)}px`;
      this.popover.style.top = `${Math.round(top)}px`;
    }

    scheduleHide() {
      this.cancelHide();
      this.hideTimer = setTimeout(() => {
        this.hide();
      }, 250);
    }

    cancelHide() {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
    }

    hide() {
      this.cancelHide();
      if (this.popover) {
        this.popover.classList.remove('visible');
      }
      this.activeTrigger = null;
      this.currentPostId = null;
    }
  }

  global.ComparisonCard = ComparisonCard;
})(typeof self !== 'undefined' ? self : this);

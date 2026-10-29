/**
 * blockhash.js - Perceptual block hashing (bmvbhash, 256-bit)
 * Pure JavaScript, standalone, zero dependencies.
 * Compatible with find-by-media (bmvbhash 16-bit = 256 bits = 64 hex chars).
 */

(function(global) {
  'use strict';

  // 16-bit popcount lookup table for fast bit counting
  const POP16 = new Uint8Array(65536);
  for (let i = 1; i < 65536; i++) {
    POP16[i] = POP16[i >> 1] + (i & 1);
  }

  function median(data) {
    const mdarr = data.slice(0);
    mdarr.sort((a, b) => a - b);
    if (mdarr.length % 2 === 0) {
      return (mdarr[mdarr.length / 2 - 1] + mdarr[mdarr.length / 2]) / 2.0;
    }
    return mdarr[Math.floor(mdarr.length / 2)];
  }

  function translateBlocksToBits(blocks, pixelsPerBlock) {
    const halfBlockValue = pixelsPerBlock * 256 * 3 / 2;
    const bandsize = blocks.length / 4;

    for (let i = 0; i < 4; i++) {
      const m = median(blocks.slice(i * bandsize, (i + 1) * bandsize));
      for (let j = i * bandsize; j < (i + 1) * bandsize; j++) {
        const v = blocks[j];
        blocks[j] = Number(v > m || (Math.abs(v - m) < 1 && m > halfBlockValue));
      }
    }
  }

  function bitsToHexhash(bitsArray) {
    const hex = [];
    for (let i = 0; i < bitsArray.length; i += 4) {
      const nibble = bitsArray.slice(i, i + 4);
      hex.push(parseInt(nibble.join(''), 2).toString(16));
    }
    return hex.join('');
  }

  function bmvbhashEven(data, bits) {
    const blocksizeX = Math.floor(data.width / bits);
    const blocksizeY = Math.floor(data.height / bits);
    const result = [];

    for (let y = 0; y < bits; y++) {
      for (let x = 0; x < bits; x++) {
        let total = 0;
        for (let iy = 0; iy < blocksizeY; iy++) {
          for (let ix = 0; ix < blocksizeX; ix++) {
            const cx = x * blocksizeX + ix;
            const cy = y * blocksizeY + iy;
            const ii = (cy * data.width + cx) * 4;
            const alpha = data.data[ii + 3];
            total += (alpha === 0) ? 765 : data.data[ii] + data.data[ii + 1] + data.data[ii + 2];
          }
        }
        result.push(total);
      }
    }

    translateBlocksToBits(result, blocksizeX * blocksizeY);
    return bitsToHexhash(result);
  }

  function bmvbhash(data, bits = 16) {
    const evenX = data.width % bits === 0;
    const evenY = data.height % bits === 0;
    if (evenX && evenY) {
      return bmvbhashEven(data, bits);
    }

    const blocks = [];
    for (let i = 0; i < bits; i++) {
      blocks.push(new Array(bits).fill(0));
    }

    const blockWidth = data.width / bits;
    const blockHeight = data.height / bits;

    for (let y = 0; y < data.height; y++) {
      let blockTop, blockBottom, weightTop, weightBottom;
      if (evenY) {
        blockTop = blockBottom = Math.floor(y / blockHeight);
        weightTop = 1;
        weightBottom = 0;
      } else {
        const yMod = (y + 1) % blockHeight;
        const yFrac = yMod - Math.floor(yMod);
        const yInt = yMod - yFrac;
        weightTop = 1 - yFrac;
        weightBottom = yFrac;
        if (yInt > 0 || (y + 1) === data.height) {
          blockTop = blockBottom = Math.floor(y / blockHeight);
        } else {
          blockTop = Math.floor(y / blockHeight);
          blockBottom = Math.ceil(y / blockHeight);
        }
      }

      for (let x = 0; x < data.width; x++) {
        const ii = (y * data.width + x) * 4;
        const alpha = data.data[ii + 3];
        const avgvalue = (alpha === 0) ? 765 : data.data[ii] + data.data[ii + 1] + data.data[ii + 2];

        let blockLeft, blockRight, weightLeft, weightRight;
        if (evenX) {
          blockLeft = blockRight = Math.floor(x / blockWidth);
          weightLeft = 1;
          weightRight = 0;
        } else {
          const xMod = (x + 1) % blockWidth;
          const xFrac = xMod - Math.floor(xMod);
          const xInt = xMod - xFrac;
          weightLeft = 1 - xFrac;
          weightRight = xFrac;
          if (xInt > 0 || (x + 1) === data.width) {
            blockLeft = blockRight = Math.floor(x / blockWidth);
          } else {
            blockLeft = Math.floor(x / blockWidth);
            blockRight = Math.ceil(x / blockWidth);
          }
        }

        blocks[blockTop][blockLeft] += avgvalue * weightTop * weightLeft;
        blocks[blockTop][blockRight] += avgvalue * weightTop * weightRight;
        blocks[blockBottom][blockLeft] += avgvalue * weightBottom * weightLeft;
        blocks[blockBottom][blockRight] += avgvalue * weightBottom * weightRight;
      }
    }

    const result = [];
    for (let i = 0; i < bits; i++) {
      for (let j = 0; j < bits; j++) {
        result.push(blocks[i][j]);
      }
    }

    translateBlocksToBits(result, blockWidth * blockHeight);
    return bitsToHexhash(result);
  }

  /**
   * Convert 64-char hex hash string into Uint32Array(8) for fast comparison
   */
  function hexToUint32s(hex) {
    if (!hex || hex.length !== 64) return null;
    const arr = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
      arr[i] = parseInt(hex.substr(i * 8, 8), 16) >>> 0;
    }
    return arr;
  }

  /**
   * Fast Hamming distance between query Uint32Array(8) and a buffer offset
   */
  function hammingDistance(q, buffer, offset = 0) {
    const x0 = q[0] ^ buffer[offset];
    const x1 = q[1] ^ buffer[offset + 1];
    const x2 = q[2] ^ buffer[offset + 2];
    const x3 = q[3] ^ buffer[offset + 3];
    const x4 = q[4] ^ buffer[offset + 4];
    const x5 = q[5] ^ buffer[offset + 5];
    const x6 = q[6] ^ buffer[offset + 6];
    const x7 = q[7] ^ buffer[offset + 7];

    return (
      POP16[x0 & 0xffff] + POP16[x0 >>> 16] +
      POP16[x1 & 0xffff] + POP16[x1 >>> 16] +
      POP16[x2 & 0xffff] + POP16[x2 >>> 16] +
      POP16[x3 & 0xffff] + POP16[x3 >>> 16] +
      POP16[x4 & 0xffff] + POP16[x4 >>> 16] +
      POP16[x5 & 0xffff] + POP16[x5 >>> 16] +
      POP16[x6 & 0xffff] + POP16[x6 >>> 16] +
      POP16[x7 & 0xffff] + POP16[x7 >>> 16]
    );
  }

  /** Pillow's fixed-point precision for 8-bit resampling (PRECISION_BITS = 32 - 8 - 2) */
  const PRECISION_BITS = 22;
  const PRECISION_ONE = 2 ** PRECISION_BITS;
  const PRECISION_HALF = 2 ** (PRECISION_BITS - 1);

  /**
   * Precompute 1D resampling weights of a triangle (bilinear) filter with antialiasing.
   * Mirrors Pillow's precompute_coeffs() + normalize_coeffs_8bpc() (fixed-point integer weights),
   * so the 32×32 result is pixel-identical to pHash_collector.py (Image.resize BILINEAR).
   * @returns {{bounds: Int32Array, weights: Float64Array, kmax: number}}
   */
  function precomputeCoeffs(inSize, outSize) {
    const scale = inSize / outSize;
    const filterscale = Math.max(scale, 1);
    const support = filterscale; // bilinear filter support = 1
    const kmax = Math.ceil(support) * 2 + 1;
    const bounds = new Int32Array(outSize * 2);
    const weights = new Float64Array(outSize * kmax);

    for (let xx = 0; xx < outSize; xx++) {
      const center = (xx + 0.5) * scale;
      const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
      const xcount = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin;
      const ss = 1 / filterscale;
      let ww = 0;
      for (let x = 0; x < xcount; x++) {
        const d = Math.abs((x + xmin - center + 0.5) * ss);
        const w = d < 1 ? 1 - d : 0;
        weights[xx * kmax + x] = w;
        ww += w;
      }
      for (let x = 0; x < xcount; x++) {
        const k = ww !== 0 ? weights[xx * kmax + x] / ww : weights[xx * kmax + x];
        // Weights are never negative for the triangle filter: (int)(0.5 + k * (1 << PRECISION_BITS))
        weights[xx * kmax + x] = Math.trunc(0.5 + k * PRECISION_ONE);
      }
      bounds[xx * 2] = xmin;
      bounds[xx * 2 + 1] = xcount;
    }
    return { bounds, weights, kmax };
  }

  /** Pillow's clip8(): fixed-point accumulator -> 0..255 */
  function clampByte(v) {
    if (v <= 0) return 0;
    if (v >= 256 * PRECISION_ONE) return 255;
    return Math.floor(v / PRECISION_ONE);
  }

  /**
   * Downscale RGBA pixels with an antialiased bilinear filter (horizontal pass, then vertical — like Pillow).
   * Browser canvas/createImageBitmap downscaling skips pixels and makes the hash noisy (~89% self-similarity),
   * area-aware resampling keeps the same image at ~97-100%.
   * @param {{data: Uint8ClampedArray, width: number, height: number}} src
   * @returns {{data: Uint8ClampedArray, width: number, height: number}}
   */
  function resampleBilinearAA(src, outW, outH) {
    const { width: inW, height: inH, data } = src;

    const h = precomputeCoeffs(inW, outW);
    const tmp = new Uint8ClampedArray(outW * inH * 4);
    for (let y = 0; y < inH; y++) {
      for (let xx = 0; xx < outW; xx++) {
        const xmin = h.bounds[xx * 2];
        const xcount = h.bounds[xx * 2 + 1];
        let r = PRECISION_HALF, g = PRECISION_HALF, b = PRECISION_HALF, a = PRECISION_HALF;
        for (let x = 0; x < xcount; x++) {
          const w = h.weights[xx * h.kmax + x];
          const ii = (y * inW + xmin + x) * 4;
          r += data[ii] * w;
          g += data[ii + 1] * w;
          b += data[ii + 2] * w;
          a += data[ii + 3] * w;
        }
        const oi = (y * outW + xx) * 4;
        tmp[oi] = clampByte(r);
        tmp[oi + 1] = clampByte(g);
        tmp[oi + 2] = clampByte(b);
        tmp[oi + 3] = clampByte(a);
      }
    }

    const v = precomputeCoeffs(inH, outH);
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let yy = 0; yy < outH; yy++) {
      const ymin = v.bounds[yy * 2];
      const ycount = v.bounds[yy * 2 + 1];
      for (let x = 0; x < outW; x++) {
        let r = PRECISION_HALF, g = PRECISION_HALF, b = PRECISION_HALF, a = PRECISION_HALF;
        for (let y = 0; y < ycount; y++) {
          const w = v.weights[yy * v.kmax + y];
          const ii = ((ymin + y) * outW + x) * 4;
          r += tmp[ii] * w;
          g += tmp[ii + 1] * w;
          b += tmp[ii + 2] * w;
          a += tmp[ii + 3] * w;
        }
        const oi = (yy * outW + x) * 4;
        out[oi] = clampByte(r);
        out[oi + 1] = clampByte(g);
        out[oi + 2] = clampByte(b);
        out[oi + 3] = clampByte(a);
      }
    }
    return { data: out, width: outW, height: outH };
  }

  /** Sources larger than this are pre-shrunk by the browser before exact resampling (keeps big originals cheap) */
  const MAX_RESAMPLE_SOURCE = 1024;

  function createCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  /**
   * Brightness of the 16×16 hash blocks (2×2 px each of the 32×32 resample), 0-255 per block.
   * The pHash keeps only "above/below band median" per block, which cannot show WHERE two
   * images differ; these levels can. Must match block_levels() in pHash_collector.py exactly.
   * @param {{data: Uint8ClampedArray, width: number, height: number}} data - 32×32 RGBA
   * @returns {Uint8Array} 256 levels, row-major
   */
  function blockLevels(data) {
    const levels = new Uint8Array(256);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        let total = 0;
        for (let iy = 0; iy < 2; iy++) {
          for (let ix = 0; ix < 2; ix++) {
            const ii = ((y * 2 + iy) * data.width + x * 2 + ix) * 4;
            total += data.data[ii + 3] === 0 ? 765 : data.data[ii] + data.data[ii + 1] + data.data[ii + 2];
          }
        }
        // 4 px × 765 max = 3060 -> 0..255 (integer rounding, identical in Python)
        levels[y * 16 + x] = Math.floor((total + 6) / 12);
      }
    }
    return levels;
  }

  function encodeBlockLevels(levels) {
    let s = '';
    for (let i = 0; i < levels.length; i++) s += String.fromCharCode(levels[i]);
    return btoa(s);
  }

  /**
   * @param {string} encoded - base64 of 256 block levels
   * @returns {Uint8Array|null}
   */
  function decodeBlockLevels(encoded) {
    if (!encoded || typeof encoded !== 'string') return null;
    try {
      const s = atob(encoded);
      if (s.length !== 256) return null;
      const out = new Uint8Array(256);
      for (let i = 0; i < 256; i++) out[i] = s.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  /**
   * Compute pHash + block brightness levels for any drawable source (HTMLImageElement, ImageBitmap, canvas).
   * Throws on tainted (cross-origin) sources — callers decide how to fall back.
   * @param {CanvasImageSource} source
   * @returns {{pHash: string, blocks: string}|null} blocks = base64 of 256 levels
   */
  function computeSourceFingerprint(source) {
    const targetSize = 32;
    let w = source.naturalWidth || source.width;
    let h = source.naturalHeight || source.height;
    if (!w || !h) return null;

    const ratio = Math.min(1, MAX_RESAMPLE_SOURCE / Math.max(w, h));
    w = Math.max(targetSize, Math.round(w * ratio));
    h = Math.max(targetSize, Math.round(h * ratio));

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const small = resampleBilinearAA(ctx.getImageData(0, 0, w, h), targetSize, targetSize);
    // Levels first: bmvbhash() works on its own block array, but keep the order explicit
    const blocks = encodeBlockLevels(blockLevels(small));
    return { pHash: bmvbhash(small, 16), blocks };
  }

  /**
   * Compute pHash for any drawable source (HTMLImageElement, ImageBitmap, canvas).
   * Throws on tainted (cross-origin) sources — callers decide how to fall back.
   * @param {CanvasImageSource} source
   * @returns {string|null} 64-char hex pHash
   */
  function computeSourcePHash(source) {
    return computeSourceFingerprint(source)?.pHash || null;
  }

  /**
   * Compute pHash for an HTMLImageElement or ImageBitmap
   * @param {HTMLImageElement|ImageBitmap} img
   * @param {number} [targetSize=32]
   * @returns {string|null} 64-char hex pHash, or null if the image is not readable (e.g. tainted canvas)
   */
  function computeElementPHash(img) {
    return computeElementFingerprint(img)?.pHash || null;
  }

  /**
   * Like computeElementPHash, but also returns block brightness levels
   * @param {HTMLImageElement|ImageBitmap} img
   * @returns {{pHash: string, blocks: string}|null} null if the image is not readable (e.g. tainted canvas)
   */
  function computeElementFingerprint(img) {
    try {
      return computeSourceFingerprint(img);
    } catch (e) {
      return null;
    }
  }

  /**
   * Compute pHash + block levels for an image Blob (fetch response body)
   * @param {Blob} blob
   * @returns {Promise<{pHash: string, blocks: string}|null>}
   */
  async function computeBlobFingerprint(blob) {
    const bmp = await createImageBitmap(blob);
    try {
      return computeSourceFingerprint(bmp);
    } finally {
      bmp.close();
    }
  }

  /**
   * Compute pHash for an image Blob (fetch response body)
   * @param {Blob} blob
   * @returns {Promise<string|null>}
   */
  async function computeBlobPHash(blob) {
    return (await computeBlobFingerprint(blob))?.pHash || null;
  }

  const BlockHash = {
    bmvbhash,
    hexToUint32s,
    hammingDistance,
    resampleBilinearAA,
    blockLevels,
    encodeBlockLevels,
    decodeBlockLevels,
    computeSourcePHash,
    computeSourceFingerprint,
    computeElementPHash,
    computeElementFingerprint,
    computeBlobPHash,
    computeBlobFingerprint,
    POP16
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BlockHash;
  } else {
    global.BlockHash = BlockHash;
  }
})(typeof self !== 'undefined' ? self : this);


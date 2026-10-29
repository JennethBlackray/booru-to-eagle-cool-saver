#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Booru to Eagle Saver - Standalone pHash & Library Collector
Generates downloaded-db.json for the browser extension from an Eagle library.
"""

import os
import sys
import json
import base64
import re
import time
import urllib.request
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

try:
    from PIL import Image
except ImportError:
    print("\n[!] ERROR: Pillow library is not installed.")
    print("Install it by running: pip install pillow\n")
    sys.exit(1)

OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'downloaded-db.json')

def extract_post_key(url):
    if not url or not isinstance(url, str):
        return None
    try:
        if 'rule34video.com' in url:
            m = re.search(r'/video[s]?/(\d+)', url, re.I)
            if m:
                return f"rule34video:{m.group(1)}"
        elif 'rule34.xxx' in url:
            m = re.search(r'[?&]id=(\d+)', url, re.I) or re.search(r'/post/view/(\d+)', url, re.I)
            if m:
                return f"rule34:{m.group(1)}"
        elif 'donmai.us' in url:
            m = re.search(r'/posts/(\d+)', url, re.I)
            if m:
                return f"danbooru:{m.group(1)}"
        elif 'sankakucomplex.com' in url:
            m = re.search(r'/posts/(?:show/)?([a-zA-Z0-9]+)', url, re.I) or re.search(r'[?&]id=([a-zA-Z0-9]+)', url, re.I)
            if m:
                return f"sankaku:{m.group(1)}"
        elif 'gelbooru.com' in url:
            m = re.search(r'[?&]id=(\d+)', url, re.I) or re.search(r'/post/show/(\d+)', url, re.I)
            if m:
                return f"gelbooru:{m.group(1)}"
        elif 'yande.re' in url:
            m = re.search(r'/post/show/(\d+)', url, re.I)
            if m:
                return f"yandere:{m.group(1)}"
        elif 'konachan.' in url:
            m = re.search(r'/post/show/(\d+)', url, re.I)
            if m:
                return f"konachan:{m.group(1)}"
    except Exception:
        pass
    return None

def block_totals(img_path):
    """16x16 block sums (r+g+b of 2x2 px) of the 32x32 resample, as blockhash.js sees them."""
    with Image.open(img_path) as im:
        im = im.convert('RGBA').resize((32, 32), Image.Resampling.BILINEAR)
        pix = im.load()

        result = []
        for y in range(16):
            for x in range(16):
                tot = 0
                for iy in range(2):
                    for ix in range(2):
                        r, g, b, a = pix[x * 2 + ix, y * 2 + iy]
                        tot += 765 if a == 0 else (r + g + b)
                result.append(tot)
        return result

def bmvbhash_from_totals(totals):
    """
    Computes 256-bit bmvbhash (64 hex characters), 100% compatible
    with blockhash.js in the browser extension.
    """
    result = list(totals)

    # 4 bands of 64 blocks
    bandsize = len(result) // 4
    half_block = 2 * 2 * 256 * 3 / 2

    for i in range(4):
        band = result[i * bandsize : (i + 1) * bandsize]
        s = sorted(band)
        n = len(s)
        m = (s[n // 2 - 1] + s[n // 2]) / 2.0 if n % 2 == 0 else s[n // 2]
        for j in range(i * bandsize, (i + 1) * bandsize):
            v = result[j]
            result[j] = 1 if (v > m or (abs(v - m) < 1 and m > half_block)) else 0

    hex_chars = []
    for i in range(0, len(result), 4):
        nibble = result[i:i+4]
        val = (nibble[0] << 3) | (nibble[1] << 2) | (nibble[2] << 1) | nibble[3]
        hex_chars.append(f'{val:x}')

    return ''.join(hex_chars)

def block_levels_b64(totals):
    """
    Block brightness 0-255 (base64 of 256 bytes). The pHash keeps only "above/below median" per block;
    these levels let the extension show WHERE two images differ. Must match blockLevels() in blockhash.js.
    """
    return base64.b64encode(bytes((t + 6) // 12 for t in totals)).decode('ascii')

def compute_fingerprint(img_path):
    """(pHash, block levels) from one image read, or (None, None)."""
    try:
        totals = block_totals(img_path)
        return bmvbhash_from_totals(totals), block_levels_b64(totals)
    except Exception:
        return None, None

def compute_bmvbhash_from_image(img_path):
    return compute_fingerprint(img_path)[0]

EAGLE_API_URL = 'http://localhost:41595'

# Thumbnails are small random reads: parallel I/O helps even on HDD (~2.5x).
PHASH_WORKERS = 16

def find_thumbnail(folder_path):
    try:
        for f in os.listdir(folder_path):
            if f.endswith('_thumbnail.png') or f.endswith('_thumbnail.webp') or f.endswith('_thumbnail.jpg'):
                return os.path.join(folder_path, f)
    except Exception:
        pass
    return None

def original_file_path(images_dir, meta):
    if not meta.get('name') or not meta.get('ext'):
        return None
    return os.path.join(images_dir, f"{meta['id']}.info", f"{meta['name']}.{meta['ext']}")

def compute_item_fingerprint(images_dir, meta):
    """(pHash, block levels) from Eagle's thumbnail (falls back to the original when the thumbnail is missing)."""
    thumb_path = find_thumbnail(os.path.join(images_dir, f"{meta['id']}.info"))
    phash, blocks = compute_fingerprint(thumb_path) if thumb_path else (None, None)
    if not phash:
        orig_file = original_file_path(images_dir, meta)
        if orig_file and os.path.isfile(orig_file):
            phash, blocks = compute_fingerprint(orig_file)
    return phash, blocks

def store_fingerprint(item, fp):
    item['pHash'], item['blocks'] = fp if fp else (None, None)

def load_previous_items():
    """Items of the previous downloaded-db.json, keyed by Eagle ID (reused when the file did not change)."""
    try:
        with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
            db = json.load(f)
        return {it['id']: it for it in db.get('items', []) if it and it.get('id') and it.get('pHash')}
    except Exception:
        return {}

def fetch_metadata_from_eagle(images_dir):
    """
    All item metadata in one request from the running Eagle app (seconds instead of
    reading thousands of metadata.json files). Only used when Eagle has this exact library open.
    """
    try:
        with urllib.request.urlopen(f'{EAGLE_API_URL}/api/library/info', timeout=5) as r:
            lib_path = json.load(r)['data']['library']['path']
        lib_images = os.path.normcase(os.path.abspath(os.path.join(lib_path, 'images')))
        if lib_images != os.path.normcase(os.path.abspath(images_dir)):
            print(f"[i] Eagle has another library open ({lib_path}), reading metadata from disk")
            return None
        with urllib.request.urlopen(f'{EAGLE_API_URL}/api/item/list?limit=10000000', timeout=120) as r:
            data = json.load(r)['data']
        return [m for m in data if m.get('id') and not m.get('isDeleted')]
    except Exception:
        return None

def read_metadata_file(args):
    images_dir, folder_name = args
    try:
        with open(os.path.join(images_dir, folder_name, 'metadata.json'), 'r', encoding='utf-8') as f:
            meta = json.load(f)
    except Exception:
        return None
    if meta.get('isDeleted'):
        return None
    meta['id'] = meta.get('id') or folder_name.replace('.info', '')
    return meta

def fetch_metadata_from_disk(images_dir):
    info_folders = [d for d in os.listdir(images_dir) if d.endswith('.info')]
    if not info_folders:
        return []
    metas = []
    args = [(images_dir, name) for name in info_folders]
    with ThreadPoolExecutor(max_workers=PHASH_WORKERS) as executor:
        for i, meta in enumerate(executor.map(read_metadata_file, args), 1):
            if meta:
                metas.append(meta)
            if i % 200 == 0 or i == len(args):
                print(f"\r    metadata: {i}/{len(args)}", end="", flush=True)
    print()
    return metas

def run_parallel(label, fn, jobs, workers):
    """Run fn over jobs with progress/ETA; returns {job_index: result}. Ctrl+C stops early, keeping results."""
    results = {}
    total = len(jobs)
    if total == 0:
        return results
    start = time.time()
    last_print = 0
    executor = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = {executor.submit(fn, job): i for i, job in enumerate(jobs)}
        pending = set(futures)
        while pending:
            # Timed wait keeps the main thread responsive to Ctrl+C on Windows
            finished, pending = wait(pending, timeout=0.5, return_when=FIRST_COMPLETED)
            for future in finished:
                idx = futures[future]
                try:
                    results[idx] = future.result()
                except Exception:
                    results[idx] = None
            done = len(results)
            now = time.time()
            if now - last_print >= 0.25 or done == total:
                last_print = now
                elapsed = now - start
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                print(f"\r    {label}: {done}/{total} ({done / total * 100:5.1f}%) | {rate:5.1f}/s | ETA {eta / 60:4.1f} min ",
                      end="", flush=True)
    except KeyboardInterrupt:
        print(f"\n[!] Interrupted - keeping {len(results)} finished {label} results (the next run continues from here)")
        raise PartialResults(results)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    print()
    return results

class PartialResults(Exception):
    """Raised on Ctrl+C with the results finished so far, so they can still be saved."""
    def __init__(self, results):
        super().__init__('interrupted')
        self.results = results

def normalize_images_path(user_input):
    p = user_input.strip().strip('"').strip("'")
    if not p:
        return None
    p = os.path.abspath(p)

    # If the user specified the library root instead of images
    if os.path.isdir(p) and not p.lower().endswith('images'):
        sub_images = os.path.join(p, 'images')
        if os.path.isdir(sub_images):
            p = sub_images

    return p

def parse_args(argv):
    opts = {'path': None, 'full': False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--full':
            opts['full'] = True
        elif not a.startswith('--'):
            opts['path'] = a
        i += 1
    return opts

def main():
    print("=" * 70)
    print("      Booru to Eagle Saver - pHash & Post Database Collector")
    print("=" * 70)
    print("\nThis tool generates the database (downloaded-db.json) for the browser")
    print("extension from your existing Eagle image library.\n")
    print("Use this if:")
    print("  - You just installed or updated the extension, but already have")
    print("    an existing collection of images in Eagle.")
    print("  - You want the extension to recognize already downloaded posts")
    print("    ('collected') and find visual duplicates.\n")
    print("Instructions:")
    print("  Enter or drag-and-drop the path to your Eagle library's 'images'")
    print("  folder (e.g. E:\\Booru.library\\images).\n")
    print("Only new or changed items are processed; earlier results are reused.")
    print("Options: --full (recompute everything)")
    print("=" * 70)

    opts = parse_args(sys.argv[1:])
    images_dir = normalize_images_path(opts['path']) if opts['path'] else None

    while not images_dir or not os.path.isdir(images_dir):
        if images_dir:
            print(f"\n[!] Error: Folder not found: {images_dir}")
        print("\nEnter path to your Eagle library's 'images' folder.")
        print("Example: E:\\Booru.library\\images")
        try:
            val = input("\nEnter path to images folder: ")
            images_dir = normalize_images_path(val)
        except (KeyboardInterrupt, EOFError):
            print("\nCancelled by user.")
            sys.exit(0)

    start_time = time.time()

    # 1. Item metadata
    print(f"\n[+] Library: {images_dir}")
    metas = fetch_metadata_from_eagle(images_dir)
    if metas is not None:
        print(f"[+] Metadata loaded from running Eagle: {len(metas)} items")
    else:
        print("[+] Reading metadata.json files (open Eagle with this library to make this step instant)...")
        metas = fetch_metadata_from_disk(images_dir)
    if not metas:
        print("[!] No items found in the specified path! Please check the path.")
        sys.exit(1)

    # 2. Reuse hashes of unchanged files from the previous database
    previous = {} if opts['full'] else load_previous_items()
    posts_set = set()
    items = {}
    phash_jobs = []
    for meta in metas:
        post_key = extract_post_key(meta.get('url') or '')
        if post_key:
            posts_set.add(post_key)
        prev = previous.get(meta['id'])
        unchanged = prev and prev.get('size') == (meta.get('size') or 0) and prev.get('ext') == (meta.get('ext') or '')
        # Items from older databases lack block levels: recompute them once
        reuse = unchanged and prev.get('blocks')
        item = {
            'id': meta['id'],
            'pHash': prev['pHash'] if reuse else None,
            'blocks': prev['blocks'] if reuse else None,
            'w': meta.get('width') or 0,
            'h': meta.get('height') or 0,
            'size': meta.get('size') or 0,
            'ext': meta.get('ext') or '',
            'name': meta.get('name') or '',
            'postKey': post_key
        }
        items[meta['id']] = (item, meta)
        if not item['pHash']:
            phash_jobs.append(meta)

    print(f"[+] Items: {len(metas)} | pHash reused: {len(metas) - len(phash_jobs)} | to compute: {len(phash_jobs)}")

    interrupted = False
    try:
        # 3. pHash from thumbnails (parallel small reads)
        if phash_jobs:
            print(f"[+] Calculating pHashes ({PHASH_WORKERS} threads)...")
            res = run_parallel('pHash', lambda m: compute_item_fingerprint(images_dir, m), phash_jobs, PHASH_WORKERS)
            for i, fp in res.items():
                store_fingerprint(items[phash_jobs[i]['id']][0], fp)
    except PartialResults as partial:
        # Interrupted during pHash: keep what finished
        for i, fp in partial.results.items():
            store_fingerprint(items[phash_jobs[i]['id']][0], fp)
        interrupted = True
    except KeyboardInterrupt:
        interrupted = True

    items_list = [item for item, _ in items.values() if item['pHash']]

    print("\n[+] Building and saving database file...")
    db_data = {
        'updatedAt': datetime.now(timezone.utc).isoformat(),
        'posts': sorted(list(posts_set)),
        'items': items_list
    }

    tmp_file = OUTPUT_FILE + '.tmp'
    with open(tmp_file, 'w', encoding='utf-8') as f:
        json.dump(db_data, f, ensure_ascii=False)
    os.replace(tmp_file, OUTPUT_FILE)

    total_sec = time.time() - start_time
    file_size_mb = os.path.getsize(OUTPUT_FILE) / 1024 / 1024

    print("=" * 70)
    print("  Database saved (partial - run again to continue)" if interrupted else "  Database build completed successfully!")
    print(f"  Library items      : {len(metas)}")
    print(f"  Booru posts found  : {len(posts_set)}")
    print(f"  pHashes            : {len(items_list)}")
    print(f"  Database file size : {file_size_mb:.2f} MB")
    print(f"  Time elapsed       : {total_sec:.1f} s")
    print(f"  File saved to      : {OUTPUT_FILE}")
    print("=" * 70)
    print("The browser extension will automatically load and use this database.")

if __name__ == '__main__':
    main()

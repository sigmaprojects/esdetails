import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = process.env.CACHE_DIR || '/tmp/esdetails-cache';
const IMAGE_CACHE_TTL = parseInt(process.env.IMAGE_CACHE_SECONDS, 10) || 43200; // 12 hours
const PAGE_CACHE_TTL  = parseInt(process.env.PAGE_CACHE_SECONDS, 10)  || 3600;  // 1 hour

// Ensure cache directories exist
for (const sub of ['images', 'pages']) {
  fs.mkdirSync(path.join(CACHE_DIR, sub), { recursive: true });
}

function keyFor(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

/**
 * Get a cached buffer for an image URL, or null if expired/missing.
 */
export function getCachedImage(url) {
  const file = path.join(CACHE_DIR, 'images', keyFor(url));
  return readIfFresh(file, IMAGE_CACHE_TTL);
}

/**
 * Store an image buffer in the cache.
 */
export function setCachedImage(url, buffer) {
  const file = path.join(CACHE_DIR, 'images', keyFor(url));
  fs.writeFileSync(file, buffer);
}

/**
 * Get cached HTML for a page URL, or null if expired/missing.
 */
export function getCachedPage(url) {
  const buf = readIfFresh(path.join(CACHE_DIR, 'pages', keyFor(url)), PAGE_CACHE_TTL);
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

/**
 * Store page data (object) in the cache.
 */
export function setCachedPage(url, data) {
  const file = path.join(CACHE_DIR, 'pages', keyFor(url));
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

function readIfFresh(filePath, ttlSeconds) {
  try {
    const stat = fs.statSync(filePath);
    if ((Date.now() - stat.mtimeMs) / 1000 > ttlSeconds) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

import path from 'path';
import fs from 'fs';
import * as db from './db.js';
import { findListings, scrapeListings } from './scraper.js';
import { downloadImageToLocal, analyzeLocalImage } from './imageAnalysis.js';

let scanning = false;
let intervalTimer = null;

const LISTING_CACHE_MS = (parseFloat(process.env.LISTING_CACHE_HOURS) || 24) * 3600_000;
const IMAGE_CACHE_MS  = (parseFloat(process.env.IMAGE_CACHE_DAYS) || 7) * 86400_000;

// ── AI analysis queue (runs independently from scraping) ───────────────────
let _aiQueue = [];       // [{ listingUrl, settings, broadcast }]
let _aiRunning = false;
let _aiBroadcast = null;
let _aiStopped = false;

async function _drainAiQueue() {
  if (_aiRunning) return;  // already draining
  _aiRunning = true;

  while (_aiQueue.length > 0 && !_aiStopped) {
    const aiConfigs = db.getActiveAiConfigs(); // sorted by weight DESC
    const broadcast = _aiBroadcast || (() => {});

    if (aiConfigs.length === 0) {
      broadcast({ type: 'scan_progress', message: '⚠ No active AI configs (weight > 0). Skipping analysis.' });
      _aiQueue = [];
      break;
    }

    // Use concurrency from the highest-weight config
    const concurrency = Math.max(1, aiConfigs[0].ai_concurrency || 1);

    // Gather all pending items
    const batch = _aiQueue.splice(0, _aiQueue.length);

    // Collect all unanalyzed images across all queued listings
    const work = [];
    for (const item of batch) {
      const unanalyzed = db.getUnanalyzedImages(item.listingUrl);
      for (const img of unanalyzed) {
        work.push({ listingUrl: item.listingUrl, img });
      }
    }

    if (work.length === 0) continue;

    broadcast({ type: 'scan_progress', message: `🤖 AI queue: ${work.length} image${work.length !== 1 ? 's' : ''} to analyze (concurrency: ${concurrency}, ${aiConfigs.length} config${aiConfigs.length !== 1 ? 's' : ''})` });

    let cursor = 0;
    async function worker() {
      while (cursor < work.length && !_aiStopped) {
        const idx = cursor++;
        const { listingUrl, img } = work[idx];
        const localPath = path.join(db.IMAGES_DIR, img.local_filename);

        let analyzed = false;
        for (const cfg of aiConfigs) {
          if (_aiStopped) break;
          const maxRetries = Math.max(1, cfg.retry_count || 2);
          let lastErr = null;

          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              broadcast({ type: 'scan_progress', message: `  🔍 AI analyzing image ${idx + 1}/${work.length} [${cfg.name || 'config#' + cfg.id}]${attempt > 1 ? ` (retry ${attempt}/${maxRetries})` : ''}…` });
              const analysis = await analyzeLocalImage(localPath, {
                image_scale: String(cfg.image_scale),
                ai_prompt: cfg.ai_prompt || '',
                ollama_url: cfg.api_url,
                ollama_model: cfg.api_model,
                api_type: cfg.api_type,
                api_key: cfg.api_key,
                ai_timeout_seconds: String(cfg.ai_timeout_seconds),
              });
              const analysisMeta = { api: cfg.api_type, model: cfg.api_model, prompt: cfg.ai_prompt || '', url: cfg.api_url || '', config_name: cfg.name || '' };
              db.updateAnalysis(img.id, analysis, analysisMeta);
              const itemCount = analysis.split('\n').filter(l => l.trim()).length;
              broadcast({
                type: 'image_analyzed',
                listingUrl,
                imageId: img.id,
                analysis,
                message: `  ✅ AI returned ${itemCount} item${itemCount !== 1 ? 's' : ''} (image ${idx + 1}/${work.length}) [${cfg.name || cfg.api_model}]`,
              });
              analyzed = true;
              break; // success, exit retry loop
            } catch (err) {
              lastErr = err;
              console.error(`[Scanner] Analysis attempt ${attempt}/${maxRetries} failed for image ${img.id} [${cfg.name}]: ${err.message}`);
              if (attempt < maxRetries) {
                broadcast({ type: 'scan_progress', message: `  ⚠ Attempt ${attempt}/${maxRetries} failed [${cfg.name || cfg.api_model}]: ${err.message}` });
              }
            }
          }

          if (analyzed) break; // success with this config, don't try next
          // All retries exhausted for this config — try next one
          broadcast({ type: 'scan_progress', message: `  ⚠ All ${maxRetries} attempts failed for [${cfg.name || cfg.api_model}], trying next config…` });
        }

        if (!analyzed) {
          // All configs exhausted
          const analysisMeta = { api: aiConfigs[0].api_type, model: aiConfigs[0].api_model, prompt: aiConfigs[0].ai_prompt || '', url: aiConfigs[0].api_url || '', config_name: aiConfigs[0].name || '' };
          db.updateAnalysis(img.id, `ERROR: All AI configs failed`, analysisMeta);
          broadcast({ type: 'scan_progress', message: `  ⚠ All AI configs failed for image ${idx + 1}/${work.length}` });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, () => worker()));

    if (_aiStopped) {
      broadcast({ type: 'ai_status', status: 'stopped', message: '⏹ AI analysis stopped' });
      break;
    }
  }

  _aiRunning = false;
}

function enqueueAiAnalysis(listingUrl, broadcast) {
  _aiBroadcast = broadcast;
  _aiQueue.push({ listingUrl });
}

export function stopAiAnalysis(broadcast) {
  _aiStopped = true;
  _aiQueue = [];
  broadcast({ type: 'ai_status', status: 'stopped', message: '⏹ AI analysis stopped by user' });
}

export function resumeAiAnalysis(broadcast) {
  _aiStopped = false;
  _aiBroadcast = broadcast;
  // Merge DB listings with unanalyzed images into the existing queue
  const queued = new Set(_aiQueue.map(q => q.listingUrl));
  const urls = db.listingsWithUnanalyzed();
  for (const url of urls) {
    if (!queued.has(url)) _aiQueue.push({ listingUrl: url });
  }
  const total = _aiQueue.length;
  broadcast({ type: 'ai_status', status: 'running', message: `▶ AI analysis started — ${total} listing${total !== 1 ? 's' : ''} queued` });
  _drainAiQueue().catch(err => console.error('[AI Queue] Error:', err));
}

export function isAiRunning() { return _aiRunning && !_aiStopped; }

// ── Scheduler ──────────────────────────────────────────────────────────────

function msUntilNext(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

export function startScheduler(scanTime, broadcast) {
  stopScheduler();
  const schedule = () => {
    // Re-read scan time from DB each cycle in case it changed
    const currentTime = db.getSetting('scan_time') || scanTime;
    const ms = msUntilNext(currentTime);
    const nextDate = new Date(Date.now() + ms);
    console.log(`[Scheduler] Next scan at ${currentTime} (in ${Math.round(ms / 60000)} min — ${nextDate.toLocaleString()})`);
    intervalTimer = setTimeout(async () => {
      console.log(`[Scheduler] Daily scan triggered at ${new Date().toLocaleString()}`);
      try {
        await runFullScan(broadcast);
        // After scheduled scan completes, auto-resume AI analysis
        resumeAiAnalysis(broadcast);
      } catch (err) {
        console.error('[Scheduler] Scan error:', err);
      }
      schedule();
    }, ms);
  };
  schedule();

  // On startup, scan if never scanned or last scan was >24h ago
  const last = db.getSetting('last_scan_at');
  if (!last || (Date.now() - new Date(last).getTime()) > 86400_000) {
    setTimeout(() => runFullScan(broadcast), 5000);
  }
}

export function stopScheduler() {
  if (intervalTimer) clearTimeout(intervalTimer);
  intervalTimer = null;
}

export function isScanRunning() { return scanning; }

// ── Full scan (all zipcodes) ───────────────────────────────────────────────
export async function runFullScan(broadcast) {
  if (scanning) { broadcast({ type: 'scan_status', status: 'busy' }); return; }
  scanning = true;
  broadcast({ type: 'scan_status', status: 'running' });

  try {
    const zipcodes = db.getAllZipcodes();
    if (!zipcodes.length) {
      broadcast({ type: 'scan_progress', message: 'No zip codes configured' });
      return;
    }

    const settings = db.getAllSettings();
    const maxImages = parseInt(settings.max_images, 10) || 0;

    const totalZips = zipcodes.length;
    for (let zi = 0; zi < totalZips; zi++) {
      const { zipcode, distance } = zipcodes[zi];
      const searchDistance = distance || 10;
      broadcast({ type: 'scan_progress', message: `[Zip ${zi + 1}/${totalZips}] Finding listings near ${zipcode} (${searchDistance} mi)…` });

      let listingUrls;
      try {
        listingUrls = await findListings(zipcode, searchDistance, (d) =>
          broadcast({ type: 'scan_progress', ...d })
        );
      } catch (err) {
        broadcast({ type: 'scan_progress', message: `Error finding listings for ${zipcode}: ${err.message}` });
        continue;
      }
      broadcast({ type: 'scan_progress', message: `[Zip ${zi + 1}/${totalZips}] Found ${listingUrls.length} listings near ${zipcode}` });
      if (!listingUrls.length) continue;

      broadcast({ type: 'scan_progress', message: `Scraping ${listingUrls.length} listing pages…` });

      // Filter out listings that were scraped recently
      const now = Date.now();
      const staleUrls = listingUrls.filter(url => {
        const meta = db.getListingMeta(url);
        if (!meta || !meta.scraped_at) return true; // never scraped
        // Never re-scrape listings whose end date has passed
        if (meta.end_date && meta.end_date < new Date().toISOString().slice(0, 10)) return false;
        // Always re-scrape if address is missing
        if (!meta.address) return true;
        return (now - new Date(meta.scraped_at + 'Z').getTime()) > LISTING_CACHE_MS;
      });
      const cachedPages = listingUrls.length - staleUrls.length;
      if (cachedPages > 0) {
        broadcast({ type: 'scan_progress', message: `  ↳ ${cachedPages} listing page${cachedPages !== 1 ? 's' : ''} still cached (< ${process.env.LISTING_CACHE_HOURS || 24}h), scraping ${staleUrls.length} stale` });
      }

      // Scrape only stale listings — save each to DB as soon as it's scraped,
      // then kick off image download + AI analysis in the background
      let scraped;
      const imageDownloadPromises = [];
      try {
        scraped = await scrapeListings(staleUrls, (d) => {
          if (d.message) broadcast({ type: 'scan_progress', message: d.message });

          // Save listing to DB as soon as it's scraped (don't wait for image download/AI)
          if (d.type === 'listing_scraped' && d.listing && !d.listing.error) {
            const listing = d.listing;

            // Check ignore words — skip listing entirely if title matches
            const ignoreWords = (settings.ignore_words || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
            if (ignoreWords.length > 0) {
              const titleLower = (listing.title || '').toLowerCase();
              const matched = ignoreWords.find(w => titleLower.includes(w));
              if (matched) {
                broadcast({ type: 'scan_progress', message: `  ⏭ Skipped "${listing.title}" (ignore word: "${matched}")` });
                return;
              }
            }

            const { start_date, end_date } = db.parseDateRange(listing.dates);
            db.upsertListing({
              url: listing.url,
              title: listing.title || '',
              dates: listing.dates || '',
              address: listing.address || '',
              start_date,
              end_date,
            });
            broadcast({ type: 'listing_saved', listingUrl: listing.url, message: `Saved: ${listing.title || listing.url}` });

            // Fire off image download + AI in the background (don't block next scrape)
            const downloadPromise = downloadListingImages(listing, maxImages, broadcast)
              .then(() => enqueueAiAnalysis(listing.url, broadcast))
              .catch(err => console.error(`[Scanner] Image pipeline error for ${listing.url}: ${err.message}`));
            imageDownloadPromises.push(downloadPromise);
          }
        }, { zipcode });
      } catch (err) {
        broadcast({ type: 'scan_progress', message: `Scraping error for ${zipcode}: ${err.message}` });
        continue;
      }

      // Wait for all background image downloads to finish before moving to next zip
      await Promise.all(imageDownloadPromises);
    }

    db.setSetting('last_scan_at', new Date().toISOString());
    const totalListings = db.getAllListings().length;
    broadcast({ type: 'scan_complete', message: `Scan complete — ${totalListings} total listings in database` });
  } catch (err) {
    console.error('[Scanner] Fatal scan error:', err);
    broadcast({ type: 'scan_error', message: err.message });
  } finally {
    scanning = false;
    broadcast({ type: 'scan_status', status: 'idle' });
  }
}

// ── Download images for a single listing ───────────────────────────────────
async function downloadListingImages(listing, maxImages, broadcast) {
  const imgs = maxImages > 0 ? (listing.images || []).slice(0, maxImages) : (listing.images || []);
  const cachedCount = imgs.filter(url => db.imageExists(listing.url, url)).length;
  let newImageCount = 0;
  if (cachedCount > 0) {
    broadcast({ type: 'scan_progress', message: `  ↳ ${cachedCount} image${cachedCount !== 1 ? 's' : ''} already cached` });
  }
  for (const remoteUrl of imgs) {
    if (db.imageExists(listing.url, remoteUrl)) {
      const existingImg = db.getImagesByListing(listing.url).find(i => i.remote_url === remoteUrl);
      if (existingImg) {
        const filePath = path.join(db.IMAGES_DIR, existingImg.local_filename);
        if (fs.existsSync(filePath)) {
          const fileAge = Date.now() - fs.statSync(filePath).mtimeMs;
          if (fileAge < IMAGE_CACHE_MS) continue;
        }
      }
    }
    try {
      const localFilename = await downloadImageToLocal(remoteUrl, db.IMAGES_DIR);
      db.addImage({ listing_url: listing.url, remote_url: remoteUrl, local_filename: localFilename });
      newImageCount++;
    } catch (err) {
      console.error(`[Scanner] Download failed ${remoteUrl}: ${err.message}`);
    }
  }
  if (newImageCount) {
    broadcast({ type: 'scan_progress', message: `  ↳ Downloaded ${newImageCount} new image${newImageCount !== 1 ? 's' : ''} for ${listing.title || listing.url}` });
    broadcast({ type: 'listing_saved', listingUrl: listing.url });
  }
}

// ── Re-analyze a single listing ────────────────────────────────────────────
export async function reanalyzeListing(listingUrl, broadcast) {
  db.clearAnalysisForListing(listingUrl);
  // Remove any existing queue entry for this listing, then re-add
  _aiQueue = _aiQueue.filter(q => q.listingUrl !== listingUrl);
  _aiBroadcast = broadcast;
  _aiQueue.push({ listingUrl });
  broadcast({ type: 'scan_progress', message: `Re-analyze queued for listing (${db.getUnanalyzedImages(listingUrl).length} images)` });
}

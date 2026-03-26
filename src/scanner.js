import path from 'path';
import * as db from './db.js';
import { findListings, scrapeListings } from './scraper.js';
import { downloadImageToLocal, analyzeLocalImage } from './imageAnalysis.js';

let scanning = false;
let intervalTimer = null;

// ── Scheduler ──────────────────────────────────────────────────────────────
export function startScheduler(hours, broadcast) {
  stopScheduler();
  const ms = Math.max(hours, 0.1) * 3600_000;
  intervalTimer = setInterval(() => runFullScan(broadcast), ms);
  console.log(`[Scheduler] Will scan every ${hours}h (${ms}ms)`);

  // On startup, scan if last scan is stale or never happened
  const last = db.getSetting('last_scan_at');
  if (!last || (Date.now() - new Date(last).getTime()) > ms) {
    setTimeout(() => runFullScan(broadcast), 5000);
  }
}

export function stopScheduler() {
  if (intervalTimer) clearInterval(intervalTimer);
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
    const imageDomain = settings.image_domain || '';
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

      // Scrape all listings (always re-scrape to refresh addresses/images)
      let scraped;
      try {
        scraped = await scrapeListings(listingUrls, imageDomain, (d) => {
          if (d.message) broadcast({ type: 'scan_progress', message: d.message });
        }, { zipcode });
      } catch (err) {
        broadcast({ type: 'scan_progress', message: `Scraping error for ${zipcode}: ${err.message}` });
        continue;
      }

      broadcast({ type: 'scan_progress', message: `Scraped ${scraped.length} listings, processing details…` });

      for (let li = 0; li < scraped.length; li++) {
        const listing = scraped[li];
        // Parse dates and upsert listing
        const { start_date, end_date } = db.parseDateRange(listing.dates);
        db.upsertListing({
          url: listing.url,
          title: listing.title || '',
          dates: listing.dates || '',
          address: listing.address || '',
          start_date,
          end_date,
        });
        broadcast({ type: 'scan_progress', message: `[${li + 1}/${scraped.length}] Saved: ${listing.title || listing.url}` });

        // Download new images to local storage
        const imgs = maxImages > 0 ? (listing.images || []).slice(0, maxImages) : (listing.images || []);
        const cachedCount = imgs.filter(url => db.imageExists(listing.url, url)).length;
        let newImageCount = 0;
        if (cachedCount > 0) {
          broadcast({ type: 'scan_progress', message: `  ↳ ${cachedCount} image${cachedCount !== 1 ? 's' : ''} already cached` });
        }
        for (const remoteUrl of imgs) {
          if (db.imageExists(listing.url, remoteUrl)) continue;
          try {
            broadcast({ type: 'scan_progress', message: `  ↳ Downloading image ${newImageCount + 1 + cachedCount}/${imgs.length}…` });
            const localFilename = await downloadImageToLocal(remoteUrl, db.IMAGES_DIR);
            db.addImage({ listing_url: listing.url, remote_url: remoteUrl, local_filename: localFilename });
            newImageCount++;
          } catch (err) {
            console.error(`[Scanner] Download failed ${remoteUrl}: ${err.message}`);
            broadcast({ type: 'scan_progress', message: `  ↳ ⚠ Download failed: ${err.message}` });
          }
        }
        if (newImageCount) {
          broadcast({ type: 'scan_progress', message: `  ↳ Downloaded ${newImageCount} new image${newImageCount !== 1 ? 's' : ''}, ${cachedCount} cached` });
        } else if (imgs.length > 0 && cachedCount === imgs.length) {
          // all cached, already reported above
        }

        // Analyze unanalyzed images
        await analyzeUnanalyzed(listing.url, settings, broadcast);
      }
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

// ── Re-analyze a single listing ────────────────────────────────────────────
export async function reanalyzeListing(listingUrl, broadcast) {
  const settings = db.getAllSettings();
  db.clearAnalysisForListing(listingUrl);
  broadcast({ type: 'scan_progress', message: `Re-analyzing images for listing…` });
  await analyzeUnanalyzed(listingUrl, settings, broadcast);
  broadcast({ type: 'reanalyze_complete', listingUrl });
}

// ── Analyze unanalyzed images for a listing ────────────────────────────────
async function analyzeUnanalyzed(listingUrl, settings, broadcast) {
  const ollamaUrl = settings.ollama_url;
  const ollamaModel = settings.ollama_model;
  if (!ollamaUrl || !ollamaModel) return;

  const unanalyzed = db.getUnanalyzedImages(listingUrl);
  if (!unanalyzed.length) return;

  const apiType = settings.api_type || 'ollama';
  const modelName = ollamaModel;
  broadcast({ type: 'scan_progress', message: `  🤖 Sending ${unanalyzed.length} image${unanalyzed.length !== 1 ? 's' : ''} to AI (${apiType}/${modelName})…` });

  const concurrency = Math.max(1, parseInt(settings.ai_concurrency, 10) || 1);
  let cursor = 0;

  async function worker() {
    while (cursor < unanalyzed.length) {
      const img = unanalyzed[cursor++];
      try {
        const localPath = path.join(db.IMAGES_DIR, img.local_filename);
        broadcast({ type: 'scan_progress', message: `  🔍 AI analyzing image ${cursor}/${unanalyzed.length}…` });
        const analysis = await analyzeLocalImage(localPath, settings);
        db.updateAnalysis(img.id, analysis);
        // Count items in the analysis
        const itemCount = analysis.split('\n').filter(l => l.trim()).length;
        broadcast({
          type: 'image_analyzed',
          listingUrl,
          imageId: img.id,
          analysis,
          message: `  ✅ AI returned ${itemCount} item${itemCount !== 1 ? 's' : ''} (image ${cursor}/${unanalyzed.length})`,
        });
      } catch (err) {
        console.error(`[Scanner] Analysis failed for image ${img.id}: ${err.message}`);
        db.updateAnalysis(img.id, `ERROR: ${err.message}`);
        broadcast({ type: 'scan_progress', message: `  ⚠ AI failed for image ${cursor}/${unanalyzed.length}: ${err.message}` });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unanalyzed.length) }, () => worker()));
}

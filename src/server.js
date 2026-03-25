import express from 'express';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

import { findListings, scrapeListings } from './scraper.js';
import { analyzeImages, analyzeListing, analyzeSingleImage } from './imageAnalysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory job store ────────────────────────────────────────────────────
const jobs = new Map();

// Purge jobs older than 2 hours to avoid unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000);

// ── Start scan ─────────────────────────────────────────────────────────────
app.post('/api/start-scan', (req, res) => {
  const {
    searchableAreaUrl,
    filterPrefix,
    searchDistance,
    imageDomain,
    ollamaUrl,
    ollamaModel,
    apiType,
    apiKey,
    maxImages,
    imageScale,
    aiConcurrency,
    aiPrompt,
  } = req.body;

  if (!searchableAreaUrl?.trim() || !filterPrefix?.trim()) {
    return res.status(400).json({ error: 'searchableAreaUrl and filterPrefix are required' });
  }

  // Basic URL validation – reject non-http schemes to prevent SSRF
  for (const urlField of [searchableAreaUrl, filterPrefix, ollamaUrl].filter(Boolean)) {
    try {
      const parsed = new URL(urlField);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: `Invalid URL scheme in: ${urlField}` });
      }
    } catch {
      return res.status(400).json({ error: `Invalid URL: ${urlField}` });
    }
  }

  const jobId = randomUUID();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(30);

  const job = {
    id: jobId,
    emitter,
    status: 'running',
    results: null,
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  console.log(`\n=== NEW SCAN REQUEST [JOB: ${jobId}] ===`);
  console.log(`Area:   ${searchableAreaUrl}`);
  console.log(`Prefix: ${filterPrefix}`);
  console.log(`Domain: ${imageDomain || 'Any'}`);
  console.log(`AI:     ${ollamaUrl ? `${apiType} (${ollamaModel}) @ ${ollamaUrl}` : 'Disabled'}`);

  emitter.on('progress', (d) => {
    if (d.message) {
      console.log(`[JOB ${jobId}] ${d.message}${d.url ? ` | ${d.url}` : ''}${d.imageUrl ? ` | ${d.imageUrl}` : ''}`);
    }
  });
  emitter.on('done', (res) => console.log(`=== JOB ${jobId} COMPLETE === | Listings processed: ${res.length}\n`));
  emitter.on('scanError', (msg) => console.error(`=== JOB ${jobId} FAILED === | Error: ${msg}\n`));

  // Fire-and-forget async scan
  runScan(
    { searchableAreaUrl, filterPrefix, searchDistance, imageDomain, ollamaUrl, ollamaModel, apiType, apiKey, maxImages, imageScale, aiConcurrency, aiPrompt },
    emitter
  )
    .then((results) => {
      job.status = 'complete';
      job.results = results;
      emitter.emit('done', results);
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
      emitter.emit('scanError', err.message);
    });

  res.json({ jobId });
});

// ── Retry single image analysis ────────────────────────────────────────────
app.post('/api/retry-image', async (req, res) => {
  const { imageUrl, ollamaUrl, ollamaModel, apiType, apiKey, imageScale, aiPrompt } = req.body;
  if (!imageUrl || !ollamaUrl) {
    return res.status(400).json({ error: 'imageUrl and ollamaUrl are required' });
  }
  // Validate URLs
  for (const u of [imageUrl, ollamaUrl].filter(Boolean)) {
    try {
      const parsed = new URL(u);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: `Invalid URL scheme: ${u}` });
      }
    } catch { return res.status(400).json({ error: `Invalid URL: ${u}` }); }
  }
  try {
    console.log(`[RETRY] Analyzing image: ${imageUrl}`);
    const objects = await analyzeSingleImage(imageUrl, { ollamaUrl, ollamaModel, apiType, apiKey, imageScale, aiPrompt });
    console.log(`[RETRY] Success: ${objects.length} objects`);
    res.json({ objects });
  } catch (err) {
    console.error(`[RETRY] Failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── SSE progress stream ────────────────────────────────────────────────────
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx buffering
  res.flushHeaders();

  const send = (type, data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    }
  };

  // Already finished?
  if (job.status === 'complete') {
    send('complete', { results: job.results });
    return res.end();
  }
  if (job.status === 'error') {
    send('error', { message: job.error });
    return res.end();
  }

  const onProgress = (data) => send('progress', data);
  const onDone = (results) => {
    send('complete', { results });
    finish();
  };
  const onError = (message) => {
    send('error', { message });
    finish();
  };

  const finish = () => {
    if (!res.writableEnded) res.end();
    cleanup();
  };
  const cleanup = () => {
    job.emitter.off('progress', onProgress);
    job.emitter.off('done', onDone);
    job.emitter.off('scanError', onError);
    clearInterval(pingTimer);
  };

  job.emitter.on('progress', onProgress);
  job.emitter.on('done', onDone);
  job.emitter.on('scanError', onError);
  req.on('close', cleanup);

  // Keep-alive ping every 20 s so the browser connection doesn't time out
  const pingTimer = setInterval(() => {
    if (res.writableEnded) { clearInterval(pingTimer); return; }
    res.write(': ping\n\n');
  }, 20000);
});

// ── Core scan pipeline ─────────────────────────────────────────────────────
async function runScan(
  { searchableAreaUrl, filterPrefix, searchDistance, imageDomain, ollamaUrl, ollamaModel, apiType, apiKey, maxImages, imageScale, aiConcurrency, aiPrompt },
  emitter
) {
  const emit = (data) => emitter.emit('progress', data);

  // Phase 1 – find listing URLs
  emit({ type: 'phase', phase: 'finding_listings', message: 'Finding estate sale listings…' });

  const listingUrls = await findListings(searchableAreaUrl, filterPrefix, searchDistance, (d) =>
    emit({ type: 'finding_listings', ...d })
  );

  emit({
    type: 'listings_found',
    count: listingUrls.length,
    message: `Found ${listingUrls.length} listing${listingUrls.length !== 1 ? 's' : ''}`,
  });

  if (listingUrls.length === 0) {
    return [];
  }

  // Phase 2 & 3 – scrape each listing and pipeline AI analysis
  emit({ type: 'phase', phase: 'scraping', message: 'Scraping listing details and images…' });

  const hasAI = !!(ollamaUrl && ollamaModel);
  const aiConfig = hasAI
    ? { ollamaUrl, ollamaModel, apiType: apiType || 'ollama', apiKey, maxImages: maxImages || 0, imageScale: imageScale || 1, aiConcurrency: aiConcurrency || 1, aiPrompt }
    : null;

  // Shared counter for AI progress (mutable, shared across concurrent analysis promises)
  const aiCounter = { processed: 0, total: 0 };

  const results = [];
  const analysisPromises = [];

  const listings = await scrapeListings(listingUrls, imageDomain, (d) => {
    // Forward scraping progress
    if (d.type === 'listing_scraped' && hasAI) {
      const listing = d.listing;
      const imgCount = maxImages > 0
        ? Math.min((listing.images || []).length, maxImages)
        : (listing.images || []).length;
      aiCounter.total += imgCount;

      // Immediately kick off AI analysis for this listing (runs concurrently with further scraping)
      if (imgCount > 0) {
        const promise = analyzeListing(
          listing,
          aiConfig,
          (ad) => emit({ type: ad.type || 'analyzing', ...ad }),
          aiCounter
        ).then((enriched) => {
          results.push(enriched);
        }).catch((err) => {
          console.error(`[AI] Listing analysis failed: ${err.message}`);
          results.push({ ...listing, describedImages: [], allRecognizedObjects: '' });
        });
        analysisPromises.push(promise);
      } else {
        results.push({ ...listing, describedImages: [], allRecognizedObjects: '' });
      }
    } else if (d.type === 'listing_scraped' && !hasAI) {
      results.push({ ...d.listing, describedImages: [], allRecognizedObjects: '' });
    }
    emit({ type: d.type || 'scraping', ...d });
  });

  emit({
    type: 'scraping_done',
    message: `Scraped ${listings.length} listings`,
    totalImages: listings.reduce((n, l) => n + l.images.length, 0),
  });

  // Wait for any in-flight AI analysis to finish
  if (analysisPromises.length > 0) {
    emit({ type: 'phase', phase: 'analyzing', message: 'Waiting for remaining AI analysis…' });
    await Promise.all(analysisPromises);
    emit({ type: 'analyzing_done', message: 'Image analysis complete' });
  }

  return results;
}

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Estate Sale Scanner listening on http://0.0.0.0:${PORT}`);
});

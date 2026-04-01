import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import zipcodes from 'zipcodes';

import * as db from './db.js';
import { startScheduler, runFullScan, reanalyzeListing, isScanRunning, stopAiAnalysis, resumeAiAnalysis, isAiRunning } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use('/images', express.static(db.IMAGES_DIR, {
  maxAge: '12h',
  immutable: true,
}));

// ── SSE broadcast ──────────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    if (c.writableEnded) { sseClients.delete(c); continue; }
    c.write(msg);
  }
}

// Heartbeat to keep connections alive
setInterval(() => {
  for (const c of sseClients) {
    if (c.writableEnded) { sseClients.delete(c); continue; }
    c.write(': ping\n\n');
  }
}, 15000);

// ── Zip codes ──────────────────────────────────────────────────────────────
app.get('/api/zipcodes', (_req, res) => {
  res.json(db.getAllZipcodes());
});

app.post('/api/zipcodes', (req, res) => {
  const { zipcode, distance } = req.body;
  if (!zipcode || !/^\d{5}$/.test(zipcode)) {
    return res.status(400).json({ error: 'Valid 5-digit zip code required' });
  }
  db.addZipcode(zipcode, parseInt(distance, 10) || 10);
  res.json({ ok: true });
});

app.put('/api/zipcodes/:id', (req, res) => {
  const { zipcode, distance } = req.body;
  if (!zipcode || !/^\d{5}$/.test(zipcode)) {
    return res.status(400).json({ error: 'Valid 5-digit zip code required' });
  }
  db.updateZipcode(parseInt(req.params.id, 10), zipcode, parseInt(distance, 10) || 10);
  res.json({ ok: true });
});

app.delete('/api/zipcodes/:id', (req, res) => {
  db.removeZipcode(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ── Listings ───────────────────────────────────────────────────────────────
app.delete('/api/listings', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const imgs = db.deleteListing(url);
  // Clean up local image files
  for (const img of imgs) {
    const filePath = path.join(db.IMAGES_DIR, img.local_filename);
    fs.unlink(filePath, () => {}); // best-effort delete
  }
  res.json({ ok: true });
});

app.get('/api/listings', (req, res) => {
  const { from, to } = req.query;
  const listings = db.getListings(from || null, to || null);

  // Filter out listings matching ignore words
  const ignoreWords = (db.getSetting('ignore_words') || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);

  const result = listings
    .filter(l => {
      if (ignoreWords.length === 0) return true;
      const titleLower = (l.title || '').toLowerCase();
      return !ignoreWords.some(w => titleLower.includes(w));
    })
    .map(l => ({
    ...l,
    images: db.getImagesByListing(l.url).map(img => ({
      ...img,
      local_url: `/images/${img.local_filename}`,
    })),
  }));
  res.json(result);
});

// ── Zip distances ──────────────────────────────────────────────────────────
app.get('/api/zip-distances/:zip', (req, res) => {
  const refZip = req.params.zip;
  const refInfo = zipcodes.lookup(refZip);
  if (!refInfo) return res.json({});

  const allListings = db.getListings(null, null);
  const uniqueZips = new Set();
  const zipRegex = /(\d{5})(?:-\d{4})?\s*$/;
  for (const l of allListings) {
    if (l.address) {
      const m = l.address.match(zipRegex);
      if (m) uniqueZips.add(m[1]);
    }
  }

  const distances = {};
  for (const z of uniqueZips) {
    const info = zipcodes.lookup(z);
    if (info) {
      distances[z] = zipcodes.distance(refZip, z);
    }
  }
  res.json(distances);
});

// ── Scan ───────────────────────────────────────────────────────────────────
app.post('/api/scan', (_req, res) => {
  if (isScanRunning()) {
    return res.status(409).json({ error: 'Scan already in progress' });
  }
  runFullScan(broadcast).catch(err => console.error('[Scan] Error:', err));
  res.json({ ok: true });
});

app.get('/api/scan-status', (_req, res) => {
  res.json({ running: isScanRunning(), aiRunning: isAiRunning(), last_scan_at: db.getSetting('last_scan_at') || null });
});

// ── AI Analysis control ────────────────────────────────────────────────────
app.post('/api/ai/stop', (_req, res) => {
  stopAiAnalysis(broadcast);
  res.json({ ok: true });
});

app.post('/api/ai/resume', (_req, res) => {
  resumeAiAnalysis(broadcast);
  res.json({ ok: true });
});

// ── Re-analyze ─────────────────────────────────────────────────────────────
app.post('/api/reanalyze', (req, res) => {
  const { listingUrl } = req.body;
  if (!listingUrl) return res.status(400).json({ error: 'listingUrl required' });
  reanalyzeListing(listingUrl, broadcast).catch(err => console.error('[Reanalyze] Error:', err));
  res.json({ ok: true });
});

// ── Settings ───────────────────────────────────────────────────────────────
app.get('/api/settings', (_req, res) => {
  res.json(db.getAllSettings());
});

app.post('/api/settings', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    db.setSetting(key, value);
  }
  // Restart scheduler if scan time changed
  if (req.body.scan_time) {
    startScheduler(req.body.scan_time, broadcast);
  }
  res.json({ ok: true });
});

// ── AI Configs ─────────────────────────────────────────────────────────────
app.get('/api/ai-configs', (_req, res) => {
  res.json(db.getAllAiConfigs());
});

app.post('/api/ai-configs', (req, res) => {
  const { name, api_url, api_model, api_type, api_key, image_scale, ai_concurrency, ai_timeout_seconds, retry_count, weight, ai_prompt } = req.body;
  if (api_url) {
    try {
      const parsed = new URL(api_url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Invalid URL scheme' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid api_url' });
    }
  }
  const result = db.addAiConfig({
    name: name || '', api_url: api_url || '', api_model: api_model || '',
    api_type: api_type || 'native', api_key: api_key || '',
    image_scale: parseFloat(image_scale) || 0.5, ai_concurrency: parseInt(ai_concurrency, 10) || 1,
    ai_timeout_seconds: parseInt(ai_timeout_seconds, 10) || 500,
    retry_count: parseInt(retry_count, 10) || 2, weight: parseInt(weight, 10) || 0,
    ai_prompt: ai_prompt || '',
  });
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});

app.put('/api/ai-configs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.getAiConfig(id);
  if (!existing) return res.status(404).json({ error: 'Config not found' });
  const { name, api_url, api_model, api_type, api_key, image_scale, ai_concurrency, ai_timeout_seconds, retry_count, weight, ai_prompt } = req.body;
  if (api_url) {
    try {
      const parsed = new URL(api_url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Invalid URL scheme' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid api_url' });
    }
  }
  db.updateAiConfig({
    id, name: name ?? existing.name, api_url: api_url ?? existing.api_url,
    api_model: api_model ?? existing.api_model, api_type: api_type ?? existing.api_type,
    api_key: api_key ?? existing.api_key, image_scale: parseFloat(image_scale ?? existing.image_scale) || 0.5,
    ai_concurrency: parseInt(ai_concurrency ?? existing.ai_concurrency, 10) || 1,
    ai_timeout_seconds: parseInt(ai_timeout_seconds ?? existing.ai_timeout_seconds, 10) || 500,
    retry_count: parseInt(retry_count ?? existing.retry_count, 10) || 2,
    weight: parseInt(weight ?? existing.weight, 10) ?? 0,
    ai_prompt: ai_prompt ?? existing.ai_prompt ?? '',
  });
  res.json({ ok: true });
});

app.delete('/api/ai-configs/:id', (req, res) => {
  db.deleteAiConfig(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`Estate Sale Scanner running on port ${PORT}`);
  const scanTime = db.getSetting('scan_time') || '05:00';
  startScheduler(scanTime, broadcast);
});

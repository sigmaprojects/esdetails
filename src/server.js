import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';

import * as db from './db.js';
import { startScheduler, runFullScan, reanalyzeListing, isScanRunning } from './scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
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
app.get('/api/listings', (req, res) => {
  const { from, to } = req.query;
  const listings = db.getListings(from || null, to || null);
  const result = listings.map(l => ({
    ...l,
    images: db.getImagesByListing(l.url).map(img => ({
      ...img,
      local_url: `/images/${img.local_filename}`,
    })),
  }));
  res.json(result);
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
  res.json({ running: isScanRunning(), last_scan_at: db.getSetting('last_scan_at') || null });
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
  // Validate ollama_url if provided
  if (req.body.ollama_url) {
    try {
      const parsed = new URL(req.body.ollama_url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Invalid URL scheme for ollama_url' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid ollama_url' });
    }
  }
  for (const [key, value] of Object.entries(req.body)) {
    db.setSetting(key, value);
  }
  // Restart scheduler if interval changed
  if (req.body.scan_interval_hours) {
    startScheduler(parseFloat(req.body.scan_interval_hours) || 24, broadcast);
  }
  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`Estate Sale Scanner running on port ${PORT}`);
  const hours = parseFloat(db.getSetting('scan_interval_hours')) || 24;
  startScheduler(hours, broadcast);
});

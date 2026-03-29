import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export const DATA_DIR = process.env.DATA_DIR || '/data';
export const IMAGES_DIR = path.join(DATA_DIR, 'images');

fs.mkdirSync(IMAGES_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'esdetails.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ─────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS zipcodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zipcode TEXT UNIQUE NOT NULL,
    distance INTEGER DEFAULT 10,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Migrations ─────────────────────────────────────────────────────────────
const cols = db.prepare("PRAGMA table_info(zipcodes)").all().map(c => c.name);
if (!cols.includes('distance')) {
  db.exec("ALTER TABLE zipcodes ADD COLUMN distance INTEGER DEFAULT 10");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    title TEXT DEFAULT '',
    dates TEXT DEFAULT '',
    address TEXT DEFAULT '',
    start_date TEXT,
    end_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_url TEXT NOT NULL REFERENCES listings(url) ON DELETE CASCADE,
    remote_url TEXT NOT NULL,
    local_filename TEXT NOT NULL,
    analysis TEXT,
    analyzed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(listing_url, remote_url)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migration: add scraped_at to listings
const listCols = db.prepare("PRAGMA table_info(listings)").all().map(c => c.name);
if (!listCols.includes('scraped_at')) {
  db.exec("ALTER TABLE listings ADD COLUMN scraped_at TEXT");
}

// Migration: add foreign key constraint to images table if missing
{
  const fks = db.prepare("PRAGMA foreign_key_list(images)").all();
  if (fks.length === 0) {
    console.log('[DB] Migrating images table to add ON DELETE CASCADE foreign key…');
    db.exec(`
      CREATE TABLE IF NOT EXISTS images_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_url TEXT NOT NULL REFERENCES listings(url) ON DELETE CASCADE,
        remote_url TEXT NOT NULL,
        local_filename TEXT NOT NULL,
        analysis TEXT,
        analyzed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(listing_url, remote_url)
      );
      INSERT OR IGNORE INTO images_new (id, listing_url, remote_url, local_filename, analysis, analyzed_at, created_at)
        SELECT id, listing_url, remote_url, local_filename, analysis, analyzed_at, created_at
        FROM images
        WHERE listing_url IN (SELECT url FROM listings);
      DROP TABLE images;
      ALTER TABLE images_new RENAME TO images;
    `);
    // Clean up orphaned image files
    console.log('[DB] Migration complete. Orphaned images excluded.');
  }
}

// ── Default settings ───────────────────────────────────────────────────────
const DEFAULTS = {
  scan_time: '05:00',
  image_domain: 'picturescdn.estatesales.net',
  ollama_url: 'http://192.168.1.34:11434',
  ollama_model: 'llava-llama3:8b',
  api_type: 'native',
  api_key: '',
  max_images: '50',
  image_scale: '0.5',
  ai_concurrency: '1',
  ai_timeout_seconds: '300',
  ai_prompt: 'List every item in this image. For each item, provide only the name and the material/color.\nRules:\nDo NOT mention brands, models, or \'generic\'.\nDo NOT describe condition.\nFormat: [Item Name]: [Material/Color]\nBe extremely brief. Use one line per item.',
  last_scan_at: '',
};

const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(DEFAULTS)) insertDefault.run(key, value);

// ── Prepared statements ────────────────────────────────────────────────────
const stmts = {
  getAllZipcodes: db.prepare('SELECT * FROM zipcodes ORDER BY zipcode'),
  addZipcode: db.prepare('INSERT OR IGNORE INTO zipcodes (zipcode, distance) VALUES (?, ?)'),
  updateZipcode: db.prepare('UPDATE zipcodes SET zipcode = ?, distance = ? WHERE id = ?'),
  removeZipcode: db.prepare('DELETE FROM zipcodes WHERE id = ?'),

  upsertListing: db.prepare(`
    INSERT INTO listings (url, title, dates, address, start_date, end_date, updated_at, scraped_at)
    VALUES (@url, @title, @dates, @address, @start_date, @end_date, datetime('now'), datetime('now'))
    ON CONFLICT(url) DO UPDATE SET
      title = CASE WHEN @title != '' THEN @title ELSE listings.title END,
      dates = CASE WHEN @dates != '' THEN @dates ELSE listings.dates END,
      address = CASE WHEN @address != '' THEN @address ELSE listings.address END,
      start_date = COALESCE(@start_date, listings.start_date),
      end_date = COALESCE(@end_date, listings.end_date),
      updated_at = datetime('now'),
      scraped_at = datetime('now')
  `),

  getListingScrapedAt: db.prepare('SELECT scraped_at FROM listings WHERE url = ?'),

  getListingsCurrent: db.prepare(`
    SELECT * FROM listings
    WHERE end_date IS NULL OR end_date >= date('now')
    ORDER BY start_date ASC, created_at DESC
  `),

  getListingsRange: db.prepare(`
    SELECT * FROM listings
    WHERE (start_date IS NULL OR start_date <= @to)
    AND   (end_date IS NULL OR end_date >= @from)
    ORDER BY start_date ASC, created_at DESC
  `),

  getListingsAll: db.prepare('SELECT * FROM listings ORDER BY start_date ASC, created_at DESC'),

  getImagesByListing: db.prepare('SELECT * FROM images WHERE listing_url = ? ORDER BY id'),
  imageExists: db.prepare('SELECT 1 FROM images WHERE listing_url = ? AND remote_url = ?'),
  addImage: db.prepare(`
    INSERT OR IGNORE INTO images (listing_url, remote_url, local_filename)
    VALUES (@listing_url, @remote_url, @local_filename)
  `),
  updateAnalysis: db.prepare('UPDATE images SET analysis = ?, analyzed_at = datetime(\'now\') WHERE id = ?'),
  clearAnalysisForListing: db.prepare('UPDATE images SET analysis = NULL, analyzed_at = NULL WHERE listing_url = ?'),
  getUnanalyzedImages: db.prepare('SELECT * FROM images WHERE listing_url = ? AND analyzed_at IS NULL'),
  listingsWithUnanalyzed: db.prepare('SELECT DISTINCT listing_url FROM images WHERE analyzed_at IS NULL'),

  deleteListing: db.prepare('DELETE FROM listings WHERE url = ?'),
  deleteImagesByListing: db.prepare('DELETE FROM images WHERE listing_url = ?'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  getAllSettings: db.prepare('SELECT key, value FROM settings'),
};

// ── Exports ────────────────────────────────────────────────────────────────
export function getAllZipcodes() { return stmts.getAllZipcodes.all(); }
export function addZipcode(zip, distance = 10) { return stmts.addZipcode.run(zip, distance); }
export function updateZipcode(id, zip, distance) { return stmts.updateZipcode.run(zip, distance, id); }
export function removeZipcode(id) { return stmts.removeZipcode.run(id); }

export function upsertListing(data) { return stmts.upsertListing.run(data); }
export function getListingScrapedAt(url) { const r = stmts.getListingScrapedAt.get(url); return r ? r.scraped_at : null; }
export function getListings(from, to) {
  if (from && to) return stmts.getListingsRange.all({ from, to });
  if (from) return stmts.getListingsRange.all({ from, to: '2099-12-31' });
  return stmts.getListingsCurrent.all();
}
export function getAllListings() { return stmts.getListingsAll.all(); }

export function getImagesByListing(url) { return stmts.getImagesByListing.all(url); }
export function imageExists(listingUrl, remoteUrl) { return !!stmts.imageExists.get(listingUrl, remoteUrl); }
export function addImage(data) { return stmts.addImage.run(data); }
export function updateAnalysis(id, analysis) { return stmts.updateAnalysis.run(analysis, id); }
export function clearAnalysisForListing(url) { return stmts.clearAnalysisForListing.run(url); }
export function getUnanalyzedImages(url) { return stmts.getUnanalyzedImages.all(url); }
export function listingsWithUnanalyzed() { return stmts.listingsWithUnanalyzed.all().map(r => r.listing_url); }
export function deleteListing(url) {
  const imgs = stmts.getImagesByListing.all(url);
  // CASCADE will delete images rows, but we fetch them first for file cleanup
  stmts.deleteListing.run(url);
  return imgs;
}

export function getSetting(key) { const r = stmts.getSetting.get(key); return r ? r.value : null; }
export function setSetting(key, value) { return stmts.setSetting.run(key, String(value)); }
export function getAllSettings() {
  const rows = stmts.getAllSettings.all();
  const s = {};
  for (const { key, value } of rows) s[key] = value;
  return s;
}

// ── Date parser ────────────────────────────────────────────────────────────
export function parseDateRange(datesText) {
  if (!datesText) return { start_date: null, end_date: null };
  // Split on em-dash, en-dash, or " to "
  const parts = datesText.split(/\s*[–—]\s*|\s+to\s+/i).map(s => s.trim()).filter(Boolean);
  const toISO = (s) => {
    s = s.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s*/i, '');
    let d = new Date(s);
    if (isNaN(d.getTime())) {
      // Try appending current year
      d = new Date(s + ', ' + new Date().getFullYear());
    }
    if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return d.toISOString().split('T')[0];
    return null;
  };
  const start_date = parts.length > 0 ? toISO(parts[0]) : null;
  const end_date = parts.length > 1 ? toISO(parts[parts.length - 1]) : start_date;
  return { start_date, end_date };
}

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

// Migration: add analysis metadata columns to images
{
  const imgCols = db.prepare("PRAGMA table_info(images)").all().map(c => c.name);
  if (!imgCols.includes('analysis_api'))   db.exec("ALTER TABLE images ADD COLUMN analysis_api TEXT");
  if (!imgCols.includes('analysis_model')) db.exec("ALTER TABLE images ADD COLUMN analysis_model TEXT");
  if (!imgCols.includes('analysis_prompt')) db.exec("ALTER TABLE images ADD COLUMN analysis_prompt TEXT");
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

// ── AI Configs table ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    api_url TEXT NOT NULL DEFAULT '',
    api_model TEXT NOT NULL DEFAULT '',
    api_type TEXT NOT NULL DEFAULT 'native',
    api_key TEXT NOT NULL DEFAULT '',
    image_scale REAL NOT NULL DEFAULT 0.5,
    ai_concurrency INTEGER NOT NULL DEFAULT 1,
    ai_timeout_seconds INTEGER NOT NULL DEFAULT 500,
    retry_count INTEGER NOT NULL DEFAULT 2,
    weight INTEGER NOT NULL DEFAULT 10,
    ai_prompt TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migration: add ai_prompt column if missing (existing DBs before this change)
{
  const cols = db.prepare("PRAGMA table_info(ai_configs)").all().map(c => c.name);
  if (!cols.includes('ai_prompt')) {
    db.exec("ALTER TABLE ai_configs ADD COLUMN ai_prompt TEXT NOT NULL DEFAULT ''");
    // Copy prompt from site settings into all existing configs
    const legacyPrompt = db.prepare("SELECT value FROM settings WHERE key = 'ai_prompt'").get();
    if (legacyPrompt?.value) {
      db.prepare("UPDATE ai_configs SET ai_prompt = ?").run(legacyPrompt.value);
    }
    console.log('[DB] Migrated ai_prompt into ai_configs table.');
  }
}

// Migration: seed first ai_config from legacy settings if table is empty
{
  const count = db.prepare('SELECT COUNT(*) as cnt FROM ai_configs').get().cnt;
  if (count === 0) {
    // Try to migrate from existing flat settings
    const legacyUrl   = db.prepare("SELECT value FROM settings WHERE key = 'ollama_url'").get();
    const legacyModel = db.prepare("SELECT value FROM settings WHERE key = 'ollama_model'").get();
    const legacyType  = db.prepare("SELECT value FROM settings WHERE key = 'api_type'").get();
    const legacyKey   = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
    const legacyScale = db.prepare("SELECT value FROM settings WHERE key = 'image_scale'").get();
    const legacyConc  = db.prepare("SELECT value FROM settings WHERE key = 'ai_concurrency'").get();
    const legacyTout  = db.prepare("SELECT value FROM settings WHERE key = 'ai_timeout_seconds'").get();

    const legacyPrompt = db.prepare("SELECT value FROM settings WHERE key = 'ai_prompt'").get();
    db.prepare(`INSERT INTO ai_configs (name, api_url, api_model, api_type, api_key, image_scale, ai_concurrency, ai_timeout_seconds, retry_count, weight, ai_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 10, ?)`)
      .run(
        'Default',
        legacyUrl?.value   || 'http://192.168.1.34:11434',
        legacyModel?.value || 'llava-llama3:8b',
        legacyType?.value  || 'native',
        legacyKey?.value   || '',
        parseFloat(legacyScale?.value) || 0.5,
        parseInt(legacyConc?.value, 10)  || 1,
        parseInt(legacyTout?.value, 10)  || 500,
        legacyPrompt?.value || '',
      );
    console.log('[DB] Migrated legacy AI settings into ai_configs table.');
  }
}

// ── Default settings ───────────────────────────────────────────────────────
const DEFAULTS = {
  scan_time: '06:20',
  image_domain: 'picturescdn.estatesales.net',
  max_images: '100000',
  ignore_words: 'auction, online, warehouse, offsite, off-site, liquidation',
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
  updateAnalysis: db.prepare('UPDATE images SET analysis = ?, analyzed_at = datetime(\'now\'), analysis_api = ?, analysis_model = ?, analysis_prompt = ? WHERE id = ?'),
  clearAnalysisForListing: db.prepare('UPDATE images SET analysis = NULL, analyzed_at = NULL, analysis_api = NULL, analysis_model = NULL, analysis_prompt = NULL WHERE listing_url = ?'),
  getUnanalyzedImages: db.prepare('SELECT * FROM images WHERE listing_url = ? AND analyzed_at IS NULL'),
  listingsWithUnanalyzed: db.prepare('SELECT DISTINCT listing_url FROM images WHERE analyzed_at IS NULL'),

  deleteListing: db.prepare('DELETE FROM listings WHERE url = ?'),
  deleteImagesByListing: db.prepare('DELETE FROM images WHERE listing_url = ?'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  getAllSettings: db.prepare('SELECT key, value FROM settings'),

  // AI configs
  getAllAiConfigs: db.prepare('SELECT * FROM ai_configs ORDER BY weight DESC, id ASC'),
  getActiveAiConfigs: db.prepare('SELECT * FROM ai_configs WHERE weight > 0 ORDER BY weight DESC, id ASC'),
  getAiConfig: db.prepare('SELECT * FROM ai_configs WHERE id = ?'),
  addAiConfig: db.prepare(`INSERT INTO ai_configs (name, api_url, api_model, api_type, api_key, image_scale, ai_concurrency, ai_timeout_seconds, retry_count, weight, ai_prompt)
    VALUES (@name, @api_url, @api_model, @api_type, @api_key, @image_scale, @ai_concurrency, @ai_timeout_seconds, @retry_count, @weight, @ai_prompt)`),
  updateAiConfig: db.prepare(`UPDATE ai_configs SET name=@name, api_url=@api_url, api_model=@api_model, api_type=@api_type, api_key=@api_key,
    image_scale=@image_scale, ai_concurrency=@ai_concurrency, ai_timeout_seconds=@ai_timeout_seconds, retry_count=@retry_count, weight=@weight, ai_prompt=@ai_prompt WHERE id=@id`),
  deleteAiConfig: db.prepare('DELETE FROM ai_configs WHERE id = ?'),
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
export function updateAnalysis(id, analysis, meta = {}) { return stmts.updateAnalysis.run(analysis, meta.api || null, meta.model || null, meta.prompt || null, id); }
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

// ── AI Configs CRUD ────────────────────────────────────────────────────────
export function getAllAiConfigs() { return stmts.getAllAiConfigs.all(); }
export function getActiveAiConfigs() { return stmts.getActiveAiConfigs.all(); }
export function getAiConfig(id) { return stmts.getAiConfig.get(id); }
export function addAiConfig(data) { return stmts.addAiConfig.run(data); }
export function updateAiConfig(data) { return stmts.updateAiConfig.run(data); }
export function deleteAiConfig(id) { return stmts.deleteAiConfig.run(id); }

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

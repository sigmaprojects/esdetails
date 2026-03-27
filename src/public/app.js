/* ── State ─────────────────────────────────────────────────────────────── */
let listings = [];
let settings = {};
let zipcodes = [];
let scanning = false;
let sortCol = null;   // 'title' | 'dates' | 'address' | null
let sortDir = 1;      // 1 = asc, -1 = desc
let zipDistances = {};  // { zip: miles } cached from backend
let zipDistancesFor = ''; // the ref zip they were fetched for

const filterFrom = document.getElementById('filterFrom');
const filterTo   = document.getElementById('filterTo');
const filterText = document.getElementById('filterText');
const listingsArea = document.getElementById('listingsArea');

/* ── Init ──────────────────────────────────────────────────────────────── */
(async () => {
  // Set default date filter to today
  filterFrom.value = new Date().toISOString().split('T')[0];
  filterFrom.addEventListener('change', loadListings);
  filterTo.addEventListener('change', loadListings);

  await Promise.all([loadZipcodes(), loadSettings(), loadListings(), checkScanStatus()]);
  connectSSE();
})();

/* ── API helpers ───────────────────────────────────────────────────────── */
async function api(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

/* ── Zip codes ─────────────────────────────────────────────────────────── */
async function loadZipcodes() {
  zipcodes = await api('/api/zipcodes');
  renderZipcodes();
}

function renderZipcodes() {
  const el = document.getElementById('zipRows');
  el.innerHTML = zipcodes.map(z =>
    `<tr>
      <td><input type="text" value="${z.zipcode}" maxlength="5" style="width:80px" data-id="${z.id}" class="zip-edit"></td>
      <td style="display:flex;align-items:center;gap:.5rem">
        <input type="range" min="5" max="100" step="5" value="${z.distance || 10}" data-id="${z.id}" class="dist-edit" oninput="this.nextElementSibling.textContent=this.value+'mi'">
        <span>${z.distance || 10}mi</span>
      </td>
      <td>
        <button onclick="updateZipcode(${z.id})">Save</button>
        <button onclick="removeZipcode(${z.id})">&times;</button>
      </td>
    </tr>`
  ).join('');
}

async function addZipcode() {
  const inp = document.getElementById('zipInput');
  const distInp = document.getElementById('distInput');
  const zip = inp.value.trim();
  if (!/^\d{5}$/.test(zip)) return;
  const distance = parseInt(distInp.value, 10) || 10;
  await api('/api/zipcodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zipcode: zip, distance }) });
  inp.value = '';
  await loadZipcodes();
}

async function updateZipcode(id) {
  const zipEl = document.querySelector(`.zip-edit[data-id="${id}"]`);
  const distEl = document.querySelector(`.dist-edit[data-id="${id}"]`);
  if (!zipEl || !distEl) return;
  const zipcode = zipEl.value.trim();
  const distance = parseInt(distEl.value, 10) || 10;
  if (!/^\d{5}$/.test(zipcode)) return;
  await api(`/api/zipcodes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zipcode, distance }) });
  await loadZipcodes();
}

async function removeZipcode(id) {
  await api(`/api/zipcodes/${id}`, { method: 'DELETE' });
  await loadZipcodes();
}

// Allow Enter key in zip input
document.getElementById('zipInput').addEventListener('keydown', e => { if (e.key === 'Enter') addZipcode(); });

/* ── Settings ──────────────────────────────────────────────────────────── */
const SETTING_KEYS = [
  'ollama_url', 'ollama_model', 'api_type', 'api_key',
  'image_domain', 'max_images', 'image_scale', 'ai_concurrency', 'scan_interval_hours', 'ai_prompt'
];

async function loadSettings() {
  settings = await api('/api/settings');
  for (const key of SETTING_KEYS) {
    const el = document.getElementById('s_' + key);
    if (el) el.value = settings[key] || '';
  }
}

async function saveSettings() {
  const body = {};
  for (const key of SETTING_KEYS) {
    const el = document.getElementById('s_' + key);
    if (el) body[key] = el.value;
  }
  await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  settings = body;
}

/* ── Listings ──────────────────────────────────────────────────────────── */
async function loadListings() {
  const params = new URLSearchParams();
  if (filterFrom.value) params.set('from', filterFrom.value);
  if (filterTo.value) params.set('to', filterTo.value);
  listings = await api('/api/listings?' + params);
  renderListings();
}

function highlightText(str, term) {
  if (!term || !str) return esc(str);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  return esc(str).replace(re, '<mark class="highlight">$1</mark>');
}

function renderListings() {
  const text = (filterText.value || '').toLowerCase();
  const hasFilter = text.length > 0;
  let filtered = hasFilter
    ? listings.filter(l =>
        (l.title + l.address + l.dates + l.images.map(i => i.analysis || '').join(' ')).toLowerCase().includes(text)
      )
    : [...listings];

  // Sort
  if (sortCol) {
    filtered.sort((a, b) => {
      let av, bv;
      if (sortCol === 'title') {
        av = (a.title || '').toLowerCase();
        bv = (b.title || '').toLowerCase();
      } else if (sortCol === 'dates') {
        av = a.start_date || a.dates || '';
        bv = b.start_date || b.dates || '';
      } else if (sortCol === 'address') {
        if (Object.keys(zipDistances).length > 0) {
          const aZip = extractZip(a.address);
          const bZip = extractZip(b.address);
          const aDist = zipDistances[aZip] ?? 99999;
          const bDist = zipDistances[bZip] ?? 99999;
          if (aDist !== bDist) return (aDist - bDist) * sortDir;
        }
        av = (a.address || '').toLowerCase();
        bv = (b.address || '').toLowerCase();
      }
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
  }

  // Update sort arrows
  ['title', 'dates', 'address'].forEach(c => {
    const el = document.getElementById('sort-' + c);
    if (el) el.textContent = sortCol === c ? (sortDir === 1 ? '▲' : '▼') : '';
  });

  document.getElementById('listingCount').textContent = `${filtered.length} listing${filtered.length !== 1 ? 's' : ''}`;

  // Remember which rows are currently open
  const openUrls = new Set();
  listingsArea.querySelectorAll('.listing-body.open').forEach(el => {
    const card = el.closest('.listing-card');
    if (card) openUrls.add(card.dataset.url);
  });

  listingsArea.innerHTML = filtered.map(l => {
    const imgCount = l.images.length;
    const analyzedCount = l.images.filter(i => i.analyzed_at).length;
    const isOpen = hasFilter || openUrls.has(l.url);
    return `
      <div class="listing-card" data-url="${esc(l.url)}">
        <div class="listing-header" onclick="toggleListing(this)">
          <div class="listing-title">${highlightText(l.title || 'Untitled', text)}</div>
          <div class="listing-meta">${esc(formatDates(l.dates, l.start_date, l.end_date))}</div>
          <div class="listing-meta">${highlightText(l.address || 'Address pending', text)}</div>
          <div class="listing-badges">
            <span class="badge badge-img">${imgCount} img${imgCount !== 1 ? 's' : ''}</span>
            ${analyzedCount < imgCount ? `<span class="badge">${analyzedCount}/${imgCount} analyzed</span>` : ''}
          </div>
          <a href="${esc(l.url)}" target="_blank" onclick="event.stopPropagation()" style="color:var(--accent);font-size:0.8rem;">↗</a>
        </div>
        <div class="listing-body${isOpen ? ' open' : ''}" id="body-${esc(l.id)}">
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">
            ${l.address
              ? `<div class="listing-address" style="margin-bottom:0"><a href="https://www.google.com/maps/search/${encodeURIComponent(l.address)}" target="_blank">📍 ${highlightText(l.address, text)}</a></div>`
              : '<div class="listing-address" style="color:var(--muted);margin-bottom:0">Address not yet available</div>'}
            <a href="${esc(l.url)}" target="_blank" style="color:var(--accent);font-size:0.8rem;text-decoration:none;word-break:break-all;">🔗 ${esc(l.url)}</a>
          </div>
          <div class="listing-actions">
            <button class="btn-sm" onclick="reanalyze('${esc(l.url)}')">Re-analyze Images</button>              <button class="btn-sm" style="background:var(--red,#c0392b);color:#fff" onclick="deleteListing('${esc(l.url)}')">Delete Listing</button>          </div>
          <div class="image-grid">
            ${l.images.map(img => {
              const analysisText = img.analysis || '';
              const isMatch = hasFilter && analysisText.toLowerCase().includes(text);
              return `
              <div class="image-card${isMatch ? ' match' : ''}">
                <img src="${esc(img.local_url)}" loading="lazy" data-analysis="${esc(analysisText)}" onclick="openModal(this)" />
                ${img.analyzed_at
                  ? `<div class="analysis">${highlightText(analysisText, text)}</div>`
                  : `<div class="pending">Pending analysis…</div>`}
              </div>
            `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function toggleListing(headerEl) {
  const body = headerEl.nextElementSibling;
  body.classList.toggle('open');
}

function applyTextFilter() {
  renderListings();
}

async function toggleSort(col) {
  if (sortCol === col) {
    sortDir *= -1;
  } else {
    sortCol = col;
    sortDir = 1;
  }
  // Fetch real geographic distances when sorting by address with a zip
  if (col === 'address') {
    const zipVal = (document.getElementById('filterZip').value || '').trim();
    if (zipVal && zipVal !== zipDistancesFor) {
      zipDistances = await api('/api/zip-distances/' + encodeURIComponent(zipVal));
      zipDistancesFor = zipVal;
    } else if (!zipVal) {
      zipDistances = {};
      zipDistancesFor = '';
    }
  }
  renderListings();
}

function extractZip(address) {
  if (!address) return '';
  const m = address.match(/(\d{5})(?:-\d{4})?\s*$/);
  return m ? m[1] : '';
}

function resetDates() {
  filterFrom.value = new Date().toISOString().split('T')[0];
  filterTo.value = '';
  loadListings();
}

/* ── Date formatting ───────────────────────────────────────────────────── */
function formatDates(raw, startISO, endISO) {
  if (startISO) {
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    const start = new Date(startISO + 'T12:00:00');
    let s = start.toLocaleDateString('en-US', opts);
    if (endISO && endISO !== startISO) {
      const end = new Date(endISO + 'T12:00:00');
      s += ' – ' + end.toLocaleDateString('en-US', opts);
    }
    return s;
  }
  return raw || '';
}

/* ── Scan ──────────────────────────────────────────────────────────────── */
async function triggerScan() {
  const res = await api('/api/scan', { method: 'POST' });
  if (res.error) alert(res.error);
}

async function checkScanStatus() {
  const s = await api('/api/scan-status');
  setScanUI(s.running, s.last_scan_at);
}

function setScanUI(running, lastScanAt) {
  scanning = running;
  const dot = document.getElementById('scanDot');
  const text = document.getElementById('scanText');
  const btn = document.getElementById('scanBtn');
  const panel = document.getElementById('progressPanel');

  dot.className = 'dot' + (running ? ' running' : '');
  btn.disabled = running;

  if (running) {
    text.textContent = 'Scanning…';
    panel.style.display = '';
  } else {
    if (lastScanAt) {
      const ago = timeAgo(new Date(lastScanAt));
      text.textContent = `Last scan: ${ago}`;
    } else {
      text.textContent = 'No scans yet';
    }
    // Keep progress panel visible briefly so user can see final messages
  }
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

/* ── Re-analyze ────────────────────────────────────────────────────────── */
async function reanalyze(listingUrl) {
  await api('/api/reanalyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingUrl }) });
}

async function deleteListing(listingUrl) {
  if (!confirm('Delete this listing and all its images?')) return;
  await api('/api/listings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: listingUrl }) });
  loadListings();
}

/* ── Modal ─────────────────────────────────────────────────────────────── */
function openModal(imgEl) {
  document.getElementById('modalImg').src = imgEl.src;
  document.getElementById('modalAnalysis').textContent = imgEl.dataset.analysis || '';
  document.getElementById('modal').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
  document.getElementById('modalImg').src = '';
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ── SSE ───────────────────────────────────────────────────────────────── */
let _listingReloadTimer = null;
function scheduleListingReload(delayMs = 2000) {
  if (_listingReloadTimer) return;
  _listingReloadTimer = setTimeout(() => { _listingReloadTimer = null; loadListings(); }, delayMs);
}

function connectSSE() {
  const es = new EventSource('/api/events');
  const log = document.getElementById('progress-log');

  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    switch (d.type) {
      case 'scan_status':
        setScanUI(d.status === 'running', null);
        if (d.status === 'idle') {
          loadListings();
        } else if (d.status === 'running') {
          log.innerHTML = '';
        }
        break;
      case 'scan_progress':
        document.getElementById('progressPanel').style.display = '';
        if (d.message) {
          const p = document.createElement('p');
          p.textContent = d.message;
          if (d.message.includes('⚠')) p.style.color = 'var(--red)';
          else if (d.message.includes('✅')) p.style.color = 'var(--green)';
          else if (d.message.includes('🤖') || d.message.includes('🔍')) p.style.color = 'var(--accent)';
          else if (d.message.includes('cached')) p.style.color = '#8b8fa3';
          log.appendChild(p);
          log.scrollTop = log.scrollHeight;
          if (d.message.includes('Downloaded')) {
            scheduleListingReload();
          }
        }
        break;
      case 'listing_saved':
        if (d.message) {
          const p = document.createElement('p');
          p.style.color = 'var(--green)';
          p.textContent = d.message;
          log.appendChild(p);
          log.scrollTop = log.scrollHeight;
        }
        // Immediately refresh listings so they appear in the UI
        scheduleListingReload(500);
        break;
      case 'scan_complete':
        if (d.message) {
          const p = document.createElement('p');
          p.style.color = 'var(--green)';
          p.textContent = '✓ ' + d.message;
          log.appendChild(p);
          log.scrollTop = log.scrollHeight;
        }
        loadListings();
        checkScanStatus();
        break;
      case 'scan_error':
        log.innerHTML += `<p style="color:var(--red)">Error: ${esc(d.message)}</p>`;
        break;
      case 'image_analyzed':
        if (d.message) {
          const p = document.createElement('p');
          p.textContent = d.message;
          log.appendChild(p);
          log.scrollTop = log.scrollHeight;
        }
        scheduleListingReload();
        break;
      case 'reanalyze_complete':
        loadListings();
        break;
    }
  };

  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 5000);
  };
}

/* ── Util ──────────────────────────────────────────────────────────────── */
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

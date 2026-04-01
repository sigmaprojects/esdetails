/* ── State ─────────────────────────────────────────────────────────────── */
let listings = [];
let settings = {};
let zipcodes = [];
let scanning = false;
let sortCol = null;
let sortDir = 1;

const listingsArea = document.getElementById('listingsArea');

/* ── Init ──────────────────────────────────────────────────────────────── */
(async () => {
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

document.getElementById('zipInput').addEventListener('keydown', e => { if (e.key === 'Enter') addZipcode(); });

/* ── Settings ──────────────────────────────────────────────────────────── */
const SETTING_KEYS = [
  'ollama_url', 'ollama_model', 'api_type', 'api_key',
  'image_domain', 'max_images', 'image_scale', 'ai_concurrency', 'ai_timeout_seconds', 'scan_time', 'ai_prompt'
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
  listings = await api('/api/listings');
  renderListings();
}

function renderListings() {
  let sorted = [...listings];

  if (sortCol) {
    sorted.sort((a, b) => {
      let av, bv;
      if (sortCol === 'title') {
        av = (a.title || '').toLowerCase();
        bv = (b.title || '').toLowerCase();
      } else if (sortCol === 'dates') {
        av = a.start_date || a.dates || '';
        bv = b.start_date || b.dates || '';
      } else if (sortCol === 'address') {
        av = (a.address || '').toLowerCase();
        bv = (b.address || '').toLowerCase();
      }
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
  }

  ['title', 'dates', 'address'].forEach(c => {
    const el = document.getElementById('sort-' + c);
    if (el) el.textContent = sortCol === c ? (sortDir === 1 ? '▲' : '▼') : '';
  });

  document.getElementById('listingCount').textContent = `${sorted.length} listing${sorted.length !== 1 ? 's' : ''}`;

  const openUrls = new Set();
  listingsArea.querySelectorAll('.listing-body.open').forEach(el => {
    const card = el.closest('.listing-card');
    if (card) openUrls.add(card.dataset.url);
  });

  listingsArea.innerHTML = sorted.map(l => {
    const imgCount = l.images.length;
    const analyzedCount = l.images.filter(i => i.analyzed_at).length;
    const isOpen = openUrls.has(l.url);
    return `
      <div class="listing-card" data-url="${esc(l.url)}">
        <div class="listing-header" onclick="toggleListing(this)">
          <div class="listing-title">${esc(l.title || 'Untitled')}</div>
          <div class="listing-meta">${esc(formatDates(l.dates, l.start_date, l.end_date))}</div>
          <div class="listing-meta">${esc(l.address || 'Address pending')}</div>
          <div class="listing-badges">
            <span class="badge badge-img">${imgCount} img${imgCount !== 1 ? 's' : ''}</span>
            ${analyzedCount < imgCount ? `<span class="badge">${analyzedCount}/${imgCount} analyzed</span>` : ''}
          </div>
          <a href="${esc(l.url)}" target="_blank" onclick="event.stopPropagation()" style="color:var(--accent);font-size:0.8rem;">↗</a>
        </div>
        <div class="listing-body${isOpen ? ' open' : ''}" id="body-${esc(l.id)}">
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">
            ${l.address
              ? `<div class="listing-address" style="margin-bottom:0"><a href="https://www.google.com/maps/search/${encodeURIComponent(l.address)}" target="_blank">📍 ${esc(l.address)}</a></div>`
              : '<div class="listing-address" style="color:var(--muted);margin-bottom:0">Address not yet available</div>'}
            <a href="${esc(l.url)}" target="_blank" style="color:var(--accent);font-size:0.8rem;text-decoration:none;word-break:break-all;">🔗 ${esc(l.url)}</a>
          </div>
          <div class="listing-actions">
            <button class="btn-sm" onclick="reanalyze('${esc(l.url)}')">Re-analyze Images</button>
            <button class="btn-sm" style="background:var(--red,#c0392b);color:#fff" onclick="deleteListing('${esc(l.url)}')">Delete Listing</button>
          </div>
          <div class="image-grid">
            ${l.images.map(img => {
              const analysisText = img.analysis || '';
              return `
              <div class="image-card">
                ${img.analyzed_at ? `<span class="image-info">i<span class="info-tooltip"><b>Analyzed:</b> ${esc(img.analyzed_at)}<br><b>API:</b> ${esc(img.analysis_api || '—')}<br><b>Model:</b> ${esc(img.analysis_model || '—')}<br><b>Prompt:</b> ${esc((img.analysis_prompt || '—').substring(0, 80))}${(img.analysis_prompt || '').length > 80 ? '…' : ''}</span></span>` : ''}
                <img src="${esc(img.local_url)}" loading="lazy" data-analysis="${esc(analysisText)}" onclick="openModal(this)" />
                ${img.analyzed_at
                  ? `<div class="analysis">${esc(analysisText)}</div>`
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
  headerEl.nextElementSibling.classList.toggle('open');
}

function toggleSort(col) {
  if (sortCol === col) {
    sortDir *= -1;
  } else {
    sortCol = col;
    sortDir = 1;
  }
  renderListings();
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
  setAiUI(s.aiRunning);
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
  }
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

/* ── Re-analyze / Delete ───────────────────────────────────────────────── */
async function reanalyze(listingUrl) {
  await api('/api/reanalyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingUrl }) });
}

async function deleteListing(listingUrl) {
  if (!confirm('Delete this listing and all its images?')) return;
  await api('/api/listings', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: listingUrl }) });
  loadListings();
}

/* ── AI Analysis control ───────────────────────────────────────────────── */
async function stopAi() {
  await api('/api/ai/stop', { method: 'POST' });
}

async function resumeAi() {
  await api('/api/ai/resume', { method: 'POST' });
}

function setAiUI(running) {
  document.getElementById('aiStopBtn').style.display = running ? '' : 'none';
  document.getElementById('aiResumeBtn').style.display = running ? 'none' : '';
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
        setAiUI(true);
        scheduleListingReload();
        break;
      case 'ai_status':
        setAiUI(d.status === 'running');
        if (d.message) {
          document.getElementById('progressPanel').style.display = '';
          const p = document.createElement('p');
          p.style.color = d.status === 'running' ? 'var(--green)' : 'var(--accent)';
          p.textContent = d.message;
          log.appendChild(p);
          log.scrollTop = log.scrollHeight;
        }
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

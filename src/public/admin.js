/* ── State ─────────────────────────────────────────────────────────────── */
let listings = [];
let settings = {};
let zipcodes = [];
let aiConfigs = [];
let scanning = false;
let sortCol = null;
let sortDir = 1;

const listingsArea = document.getElementById('listingsArea');

/* ── Init ──────────────────────────────────────────────────────────────── */
(async () => {
  await Promise.all([loadZipcodes(), loadSettings(), loadAiConfigs(), loadListings(), checkScanStatus()]);
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

/* ── Settings (site-only) ──────────────────────────────────────────────── */
const SITE_SETTING_KEYS = ['image_domain', 'max_images', 'scan_time', 'ignore_words'];

async function loadSettings() {
  settings = await api('/api/settings');
  for (const key of SITE_SETTING_KEYS) {
    const el = document.getElementById('s_' + key);
    if (el) el.value = settings[key] || '';
  }
}

async function saveSettings() {
  const body = {};
  for (const key of SITE_SETTING_KEYS) {
    const el = document.getElementById('s_' + key);
    if (el) body[key] = el.value;
  }
  await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  settings = { ...settings, ...body };
}

/* ── AI Configs CRUD ──────────────────────────────────────────────────── */
async function loadAiConfigs() {
  aiConfigs = await api('/api/ai-configs');
  renderAiConfigs();
}

function renderAiConfigs() {
  const el = document.getElementById('aiConfigsList');
  if (!aiConfigs.length) {
    el.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No AI configurations yet.</p>';
    return;
  }
  el.innerHTML = `<table class="ai-config-table"><thead><tr>
    <th>Weight</th><th>Name</th><th>Type</th><th>Model</th><th>Concurrency</th><th>Retries</th><th></th>
  </tr></thead><tbody>${aiConfigs.map(c => `
    <tr class="${c.weight === 0 ? 'cfg-disabled' : ''}">
      <td class="cfg-weight">${c.weight}</td>
      <td class="cfg-name">${esc(c.name || '—')}</td>
      <td>${esc(c.api_type)}</td>
      <td>${esc(c.api_model)}</td>
      <td>${c.ai_concurrency}</td>
      <td>${c.retry_count}</td>
      <td class="cfg-actions">
        <button class="btn-sm btn-outline" onclick="editConfig(${c.id})">Edit</button>
        <button class="btn-sm btn-outline" style="color:var(--red);border-color:var(--red)" onclick="deleteConfig(${c.id})">×</button>
      </td>
    </tr>`).join('')}</tbody></table>`;
}

function showAddConfigForm() {
  document.getElementById('cfg_id').value = '';
  document.getElementById('cfg_name').value = '';
  document.getElementById('cfg_api_url').value = '';
  document.getElementById('cfg_api_model').value = '';
  document.getElementById('cfg_api_type').value = 'native';
  document.getElementById('cfg_api_key').value = '';
  document.getElementById('cfg_image_scale').value = '0.5';
  document.getElementById('cfg_ai_concurrency').value = '1';
  document.getElementById('cfg_ai_timeout_seconds').value = '300';
  document.getElementById('cfg_retry_count').value = '2';
  document.getElementById('cfg_weight').value = '10';
  document.getElementById('cfg_ai_prompt').value = "List every item in this image. For each item, provide only the name and the material/color.\nRules:\nDo NOT mention brands, models, or 'generic' unless you are extremely confident in the brand or model.\nDo NOT mention characters unless you are extremely confident what character is portrayed.\nDo NOT describe condition.\nFormat: [Brand (if any)] [Model (if any)] [Character (if any)] [Item Name]: [Material/Color]\nDo NOT include the brackets [] if there is no brand or model or character or unknown material/color, do NOT include empty brackets in the format.\nBe extremely brief. Use one line per item.";
  document.getElementById('aiConfigForm').style.display = '';
}

function editConfig(id) {
  const c = aiConfigs.find(x => x.id === id);
  if (!c) return;
  document.getElementById('cfg_id').value = c.id;
  document.getElementById('cfg_name').value = c.name || '';
  document.getElementById('cfg_api_url').value = c.api_url || '';
  document.getElementById('cfg_api_model').value = c.api_model || '';
  document.getElementById('cfg_api_type').value = c.api_type || 'native';
  document.getElementById('cfg_api_key').value = c.api_key || '';
  document.getElementById('cfg_image_scale').value = c.image_scale ?? 0.5;
  document.getElementById('cfg_ai_concurrency').value = c.ai_concurrency ?? 1;
  document.getElementById('cfg_ai_timeout_seconds').value = c.ai_timeout_seconds ?? 300;
  document.getElementById('cfg_retry_count').value = c.retry_count ?? 2;
  document.getElementById('cfg_weight').value = c.weight ?? 10;
  document.getElementById('cfg_ai_prompt').value = c.ai_prompt || '';
  document.getElementById('aiConfigForm').style.display = '';
}

function hideConfigForm() {
  document.getElementById('aiConfigForm').style.display = 'none';
}

async function saveConfig() {
  const id = document.getElementById('cfg_id').value;
  const body = {
    name: document.getElementById('cfg_name').value,
    api_url: document.getElementById('cfg_api_url').value,
    api_model: document.getElementById('cfg_api_model').value,
    api_type: document.getElementById('cfg_api_type').value,
    api_key: document.getElementById('cfg_api_key').value,
    image_scale: document.getElementById('cfg_image_scale').value,
    ai_concurrency: document.getElementById('cfg_ai_concurrency').value,
    ai_timeout_seconds: document.getElementById('cfg_ai_timeout_seconds').value,
    retry_count: document.getElementById('cfg_retry_count').value,
    weight: document.getElementById('cfg_weight').value,
    ai_prompt: document.getElementById('cfg_ai_prompt').value,
  };
  const opts = { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const url = id ? `/api/ai-configs/${id}` : '/api/ai-configs';
  const res = await api(url, opts);
  if (res.error) { alert(res.error); return; }
  hideConfigForm();
  await loadAiConfigs();
}

async function deleteConfig(id) {
  if (!confirm('Delete this AI configuration?')) return;
  await api(`/api/ai-configs/${id}`, { method: 'DELETE' });
  await loadAiConfigs();
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
                ${img.analyzed_at ? `<span class="image-info" onclick="event.stopPropagation();openInfoModal(this)" data-analyzed="${esc(img.analyzed_at)}" data-api="${esc(img.analysis_api || '—')}" data-model="${esc(img.analysis_model || '—')}" data-prompt="${esc(img.analysis_prompt || '—')}">i</span>` : ''}
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

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeInfoModal(); } });

function openInfoModal(el) {
  const c = document.getElementById('infoModalContent');
  c.innerHTML = `<div class="info-row"><b>Analyzed:</b> ${esc(el.dataset.analyzed)}</div>
    <div class="info-row"><b>API:</b> ${esc(el.dataset.api)}</div>
    <div class="info-row"><b>Model:</b> ${esc(el.dataset.model)}</div>
    <div class="info-row"><b>Prompt:</b><div class="info-prompt">${esc(el.dataset.prompt)}</div></div>`;
  document.getElementById('infoModal').classList.add('open');
}

function closeInfoModal() {
  document.getElementById('infoModal').classList.remove('open');
}

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

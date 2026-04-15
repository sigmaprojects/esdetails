/* ── State ─────────────────────────────────────────────────────────────── */
let listings = [];
let sortCol = null;   // 'title' | 'dates' | 'address' | null
let sortDir = 1;      // 1 = asc, -1 = desc
let zipDistances = {};  // { zip: miles } cached from backend
let zipDistancesFor = ''; // the ref zip they were fetched for
let hiddenUrls = JSON.parse(localStorage.getItem('hiddenListings') || '{}'); // { url: title }
let _hashListingId = null; // listing id to expand from hash
let _hashImgIdx = null;    // image index to open from hash
let _suppressHashPush = false;

const filterFrom = document.getElementById('filterFrom');
const filterTo   = document.getElementById('filterTo');
const filterText = document.getElementById('filterText');
const listingsArea = document.getElementById('listingsArea');
let _filterTimer = null;
filterText.addEventListener('keyup', () => {
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(() => applyTextFilter(), 500);
});

/* ── Hash State ────────────────────────────────────────────────────────── */
function pushHash() {
  if (_suppressHashPush) return;
  const p = new URLSearchParams();
  if (filterFrom.value) p.set('from', filterFrom.value);
  if (filterTo.value) p.set('to', filterTo.value);
  if (filterText.value.trim()) p.set('q', filterText.value.trim());
  const zipEl = document.getElementById('filterZip');
  if (zipEl && zipEl.value.trim()) p.set('zip', zipEl.value.trim());
  if (sortCol) { p.set('sort', sortCol); p.set('dir', String(sortDir)); }
  // Find open listing
  const openBody = listingsArea.querySelector('.listing-body.open');
  if (openBody) {
    const card = openBody.closest('.listing-card');
    if (card) p.set('listing', card.dataset.url);
  }
  // Find open modal image
  if (document.getElementById('modal').classList.contains('open') && _modalImages.length && _modalIdx >= 0) {
    const imgEl = _modalImages[_modalIdx];
    const idx = imgEl ? imgEl.dataset.imgIdx : null;
    if (idx != null) p.set('img', idx);
  }
  const hash = p.toString();
  if (location.hash.slice(1) !== hash) history.replaceState(null, '', '#' + hash);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    from: p.get('from') || '',
    to: p.get('to') || '',
    q: p.get('q') || '',
    zip: p.get('zip') || '',
    sort: p.get('sort') || '',
    dir: parseInt(p.get('dir'), 10) || 1,
    listing: p.get('listing') || '',
    img: p.get('img'),
  };
}

/* ── Init ──────────────────────────────────────────────────────────────── */
(async () => {
  const h = readHash();
  _suppressHashPush = true;

  // Restore filter state from hash (or defaults)
  filterFrom.value = h.from || new Date().toISOString().split('T')[0];
  filterTo.value = h.to || '';
  filterText.value = h.q || '';
  const zipEl = document.getElementById('filterZip');
  if (zipEl && h.zip) zipEl.value = h.zip;
  if (h.sort) { sortCol = h.sort; sortDir = h.dir; }
  if (h.listing) _hashListingId = h.listing;
  if (h.img != null) _hashImgIdx = parseInt(h.img, 10);

  filterFrom.addEventListener('change', () => { loadListings(); });
  filterTo.addEventListener('change', () => { loadListings(); });

  await loadListings();
  _suppressHashPush = false;
  pushHash();
  connectSSE();
})();

/* ── API helpers ───────────────────────────────────────────────────────── */
async function api(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

/* ── Listings ──────────────────────────────────────────────────────────── */
async function loadListings() {
  const params = new URLSearchParams();
  if (filterFrom.value) params.set('from', filterFrom.value);
  if (filterTo.value) params.set('to', filterTo.value);
  listings = await api('/api/listings?' + params);
  renderListings();
  restoreFromHash();
  pushHash();
}

function highlightText(str, term) {
  if (!term || !str) return esc(str);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  return esc(str).replace(re, '<mark class="highlight">$1</mark>');
}

function renderListings() {
  const text = (filterText.value || '').trim().toLowerCase();
  const hasFilter = text.length >= 3;
  let filtered = hasFilter
    ? listings.filter(l =>
        !hiddenUrls[l.url] &&
        (l.title + l.address + l.dates + l.images.map(i => i.analysis || '').join(' ')).toLowerCase().includes(text)
      )
    : listings.filter(l => !hiddenUrls[l.url]);

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

  renderHiddenPanel();

  // Remember which rows are currently open
  const openUrls = new Set();
  listingsArea.querySelectorAll('.listing-body.open').forEach(el => {
    const card = el.closest('.listing-card');
    if (card) openUrls.add(card.dataset.url);
  });

  listingsArea.innerHTML = filtered.map(l => {
    const imgCount = l.images.length;
    const analyzedCount = l.images.filter(i => i.analyzed_at).length;
    const isOpen = hasFilter || openUrls.has(l.url) || _hashListingId === l.url;
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
        <div class="listing-body${isOpen ? ' open' : ''}" id="body-${esc(l.id)}" style="position:relative">
          <button class="btn-hide" onclick="event.stopPropagation();hideListing('${esc(l.url)}','${esc(l.title || 'Untitled')}')">Hide</button>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">
            ${l.address
              ? `<div class="listing-address" style="margin-bottom:0"><a href="https://www.google.com/maps/search/${encodeURIComponent(l.address)}" target="_blank">📍 ${highlightText(l.address, text)}</a></div>`
              : '<div class="listing-address" style="color:var(--muted);margin-bottom:0">Address not yet available</div>'}
            <a href="${esc(l.url)}" target="_blank" style="color:var(--accent);font-size:0.8rem;text-decoration:none;word-break:break-all;">🔗 ${esc(l.url)}</a>
          </div>
          <div class="listing-actions">
            ${hasFilter ? `<button class="btn-sm show-all-btn" onclick="toggleShowAll(this)">Only showing images matching &quot;${esc(text)}&quot; — click to show all</button>` : ''}
          </div>
          <div class="image-grid">
            ${l.images.map((img, imgIdx) => {
              const analysisText = img.analysis || '';
              const isMatch = hasFilter && analysisText.toLowerCase().includes(text);
              const hidden = hasFilter && !isMatch;
              return `
              <div class="image-card${isMatch ? ' match' : ''}${hidden ? ' filtered-out' : ''}">
                ${img.analyzed_at ? `<span class="image-info" onclick="event.stopPropagation();openInfoModal(this)" data-analyzed="${esc(img.analyzed_at)}" data-api="${esc(img.analysis_api || '—')}" data-model="${esc(img.analysis_model || '—')}" data-prompt="${esc(img.analysis_prompt || '—')}" data-url="${esc(img.analysis_url || '')}" data-config="${esc(img.analysis_config_name || '')}">i</span>` : ''}
                <img src="${esc(img.local_url)}" loading="lazy" data-analysis="${esc(analysisText)}" data-img-idx="${imgIdx}" onclick="openModal(this)" />
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
  // Close all other listing bodies first
  listingsArea.querySelectorAll('.listing-body.open').forEach(el => {
    if (el !== body) el.classList.remove('open');
  });
  body.classList.toggle('open');
  pushHash();
}

function applyTextFilter() {
  renderListings();
  pushHash();
}

function toggleShowAll(btn) {
  const grid = btn.closest('.listing-body').querySelector('.image-grid');
  const showing = grid.classList.toggle('show-all');
  btn.textContent = showing
    ? 'Showing all images — click to filter again'
    : `Only showing images matching "${filterText.value}" — click to show all`;
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
  pushHash();
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

/* ── Deep-link restore (after render) ──────────────────────────────────── */
function restoreFromHash() {
  if (_hashListingId) {
    const card = listingsArea.querySelector(`.listing-card[data-url="${CSS.escape(_hashListingId)}"]`);
    if (card) {
      const body = card.querySelector('.listing-body');
      if (body && !body.classList.contains('open')) body.classList.add('open');
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });

      if (_hashImgIdx != null) {
        const img = card.querySelector(`img[data-img-idx="${_hashImgIdx}"]`);
        if (img) {
          setTimeout(() => openModal(img), 300);
        }
      }
    }
    _hashListingId = null;
    _hashImgIdx = null;
  }
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

/* ── Modal ─────────────────────────────────────────────────────────────── */
let _modalImages = [];
let _modalIdx = -1;

function getVisibleImages(imgEl) {
  const grid = imgEl.closest('.image-grid');
  if (!grid) return [];
  const showAll = grid.classList.contains('show-all');
  return [...grid.querySelectorAll('.image-card img[data-analysis]')].filter(img => {
    if (showAll) return true;
    return !img.closest('.image-card').classList.contains('filtered-out');
  });
}

function openModal(imgEl) {
  _modalImages = getVisibleImages(imgEl);
  _modalIdx = _modalImages.indexOf(imgEl);
  if (_modalIdx === -1) _modalIdx = 0;
  showModalImage();
  document.getElementById('modal').classList.add('open');
  pushHash();
}

function showModalImage() {
  if (!_modalImages.length) return;
  const img = _modalImages[_modalIdx];
  document.getElementById('modalImg').src = img.src;
  document.getElementById('modalAnalysis').textContent = img.dataset.analysis || '';
}

function modalNav(dir) {
  if (!_modalImages.length) return;
  _modalIdx = (_modalIdx + dir + _modalImages.length) % _modalImages.length;
  showModalImage();
  pushHash();
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
  document.getElementById('modalImg').src = '';
  _modalImages = [];
  _modalIdx = -1;
  pushHash();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeInfoModal(); }
  if (document.getElementById('modal').classList.contains('open')) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); modalNav(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); modalNav(1); }
  }
});

function openInfoModal(el) {
  const c = document.getElementById('infoModalContent');
  const apiType = el.dataset.api || '—';
  const apiUrl = el.dataset.url || '';
  const configName = el.dataset.config || '';
  let apiTypeLabel = apiType;
  if (apiType === 'native') apiTypeLabel = 'Ollama Native';
  else if (apiType === 'openai') apiTypeLabel = 'OpenAI Compatible';
  else if (apiType === 'openrouter') apiTypeLabel = 'OpenRouter';
  c.innerHTML = `${configName ? `<div class="info-row"><b>Config:</b> ${esc(configName)}</div>` : ''}
    <div class="info-row"><b>Analyzed:</b> ${esc(el.dataset.analyzed)}</div>
    <div class="info-row"><b>API Type:</b> ${esc(apiTypeLabel)}</div>
    ${apiUrl ? `<div class="info-row"><b>API URL:</b> ${esc(apiUrl)}</div>` : ''}
    <div class="info-row"><b>Model:</b> ${esc(el.dataset.model)}</div>
    <div class="info-row"><b>Prompt:</b><div class="info-prompt">${esc(el.dataset.prompt)}</div></div>`;
  document.getElementById('infoModal').classList.add('open');
}

function closeInfoModal() {
  document.getElementById('infoModal').classList.remove('open');
}

/* ─── Hidden listings ───────────────────────────────────────────────────── */
function hideListing(url, title) {
  hiddenUrls[url] = title || 'Untitled';
  localStorage.setItem('hiddenListings', JSON.stringify(hiddenUrls));
  renderListings();
}

function unhideListing(url) {
  delete hiddenUrls[url];
  localStorage.setItem('hiddenListings', JSON.stringify(hiddenUrls));
  renderListings();
}

function renderHiddenPanel() {
  const entries = Object.entries(hiddenUrls);
  const panel = document.getElementById('hiddenPanel');
  if (entries.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  document.getElementById('hiddenSummary').textContent = `Hidden Listings (${entries.length})`;
  document.getElementById('hiddenList').innerHTML = entries
    .map(([url, title]) => `<span class="hidden-chip" onclick="unhideListing('${esc(url)}')" title="Click to unhide">${esc(title)} ✕</span>`)
    .join('');
}

/* ── SSE ───────────────────────────────────────────────────────────────── */
let _listingReloadTimer = null;
function scheduleListingReload(delayMs = 2000) {
  if (_listingReloadTimer) return;
  _listingReloadTimer = setTimeout(() => { _listingReloadTimer = null; loadListings(); }, delayMs);
}

function connectSSE() {
  const es = new EventSource('/api/events');

  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    switch (d.type) {
      case 'scan_status':
        if (d.status === 'idle') loadListings();
        break;
      case 'listing_saved':
        scheduleListingReload(500);
        break;
      case 'scan_complete':
        loadListings();
        break;
      case 'image_analyzed':
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

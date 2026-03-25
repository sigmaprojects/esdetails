/* ─── Estate Sale Scanner — frontend app ─────────────────────────────── */

// ── Cached DOM refs ──────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const searchableAreaInput = $('searchableArea');
const filterPrefixInput   = $('filterPrefix');
const apiTypeSelect       = $('apiType');
const ollamaUrlInput      = $('ollamaUrl');
const ollamaModelInput    = $('ollamaModel');
const imageDomainInput    = $('imageDomain');
const apiKeyInput         = $('apiKey');
const apiKeyRow           = $('apiKeyRow');
const maxImagesInput      = $('maxImages');
const startBtn            = $('startBtn');
const formError           = $('formError');

const progressCard  = $('progressCard');
const phaseSteps    = [null, $('phaseStep1'), $('phaseStep2'), $('phaseStep3')];
const progressFill  = $('progressFill');
const logBox        = $('logBox');

const resultsSection = $('resultsSection');
const summaryBar     = $('summaryBar');
const resultsBody    = $('resultsBody');
const exportBtn      = $('exportBtn');

// ── State ────────────────────────────────────────────────────────────────
let currentResults = [];
let currentPhase   = 0;  // 1, 2, or 3
let phaseProgress  = { 2: { cur: 0, tot: 0 }, 3: { cur: 0, tot: 0 } };

// ── Auto-populate filter prefix from search area URL ────────────────────
searchableAreaInput.addEventListener('input', () => {
  if (filterPrefixInput.dataset.userEdited) return;
  const val = searchableAreaInput.value.trim();
  if (!val) return;
  try {
    const u = new URL(val);
    const parts = u.pathname.split('/').filter(Boolean);
    filterPrefixInput.value = parts.length
      ? `${u.origin}/${parts[0]}/`
      : u.origin + '/';
  } catch {
    // ignore parse error while typing
  }
});

filterPrefixInput.addEventListener('input', () => {
  filterPrefixInput.dataset.userEdited = '1';
});

// Show/hide API key field based on API type
apiTypeSelect.addEventListener('change', () => {
  apiKeyRow.classList.toggle('hidden', apiTypeSelect.value !== 'openai');
});

// ── Form submit ──────────────────────────────────────────────────────────
$('scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const payload = {
    searchableAreaUrl: searchableAreaInput.value.trim(),
    filterPrefix:      filterPrefixInput.value.trim(),
    ollamaUrl:         ollamaUrlInput.value.trim() || undefined,
    ollamaModel:       ollamaModelInput.value.trim() || 'llava',
    imageDomain:       imageDomainInput.value.trim(),
    apiType:           apiTypeSelect.value,
    apiKey:            apiKeyInput.value.trim() || undefined,
    maxImages:         parseInt(maxImagesInput.value, 10) || 0,
  };

  if (!payload.searchableAreaUrl || !payload.filterPrefix) {
    formError.textContent = 'Both URL fields are required.';
    return;
  }

  // Reset UI
  resetProgress();
  currentResults = [];
  resultsSection.classList.add('hidden');
  progressCard.classList.remove('hidden');
  setStartBusy(true);

  try {
    const resp = await fetch('/api/start-scan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to start scan');
    subscribeToProgress(data.jobId, !!payload.ollamaUrl);
  } catch (err) {
    formError.textContent = err.message;
    setStartBusy(false);
  }
});

// ── SSE subscription ─────────────────────────────────────────────────────
function subscribeToProgress(jobId, hasAI) {
  const es = new EventSource(`/api/progress/${jobId}`);

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleProgressEvent(msg, hasAI, es);
  };

  es.onerror = () => {
    log('Connection lost — check the server.', 'err');
    es.close();
    setStartBusy(false);
  };
}

function handleProgressEvent(msg, hasAI, es) {
  // Handle events by their actual type (SSE spread overwrites 'progress' with inner type)
  const eventType = msg.type;
  
  switch (eventType) {

    case 'progress':
    case 'finding_listings': {
      activatePhase(1);
      if (msg.count) {
        setProgress(10);
        log(`✓ Found ${msg.count} listings`, 'ok');
      } else if (msg.message) {
        log(msg.message);
      }
      break;
    }

    case 'scraping': {
      activatePhase(2);
      phaseProgress[2] = { cur: msg.current || 0, tot: msg.total || 1 };
      const pct = hasAI
        ? 10 + (msg.current / msg.total) * 40
        : 10 + (msg.current / msg.total) * 90;
      setProgress(pct);
      log(`[${msg.current}/${msg.total}] Scraping: ${msg.url || msg.message || ''}`);
      break;
    }

    case 'listing_scraped': {
      activatePhase(2);
      // Show results section immediately so users see the table building
      resultsSection.classList.remove('hidden');
      
      const existingIdx = currentResults.findIndex(r => r.url === msg.listing.url);
      if (existingIdx !== -1) {
        currentResults[existingIdx] = msg.listing;
      } else {
        currentResults.push(msg.listing);
      }
      renderResults(currentResults);
      log(`✓ Scraped: ${msg.listing.title || msg.listing.url.substring(0, 40)} (${msg.listing.images?.length || 0} images)`, 'ok');
      break;
    }

    case 'image_analyzed': {
      activatePhase(3);
      const listing = currentResults.find(r => r.url === msg.listingUrl);
      if (listing) {
        listing.describedImages = listing.describedImages || [];
        listing.describedImages.push({ path: msg.imageUrl, objects: msg.objects, error: msg.error });
        
        if (msg.objects && msg.objects.length > 0) {
          const allObjSet = new Set((listing.allRecognizedObjects || '').split(', ').filter(Boolean));
          msg.objects.forEach(o => allObjSet.add(o));
          listing.allRecognizedObjects = [...allObjSet].sort().join(', ');
        }
        renderResults(currentResults);
        if (msg.objects && msg.objects.length > 0) {
          log(`✓ AI found: ${msg.objects.slice(0, 5).join(', ')}${msg.objects.length > 5 ? ', ...' : ''}`, 'ok');
        } else if (msg.error) {
          log(`⚠ AI error: ${msg.error}`, 'err');
        }
      }
      break;
    }

    case 'analyzing': {
      activatePhase(3);
      phaseProgress[3] = { cur: msg.current || 0, tot: msg.total || 1 };
      const pct = 50 + (msg.current / msg.total) * 49;
      setProgress(pct);
      log(`[${msg.current}/${msg.total}] Analyzing: ${msg.imageUrl || msg.message || ''}`);
      break;
    }

    case 'phase': {
      log(msg.message || '');
      break;
    }

    case 'listings_found': {
      log(`✓ ${msg.message}`, 'ok');
      break;
    }

    case 'scraping_done': {
      log(`✓ ${msg.message} — ${msg.totalImages} images collected`, 'ok');
      break;
    }

    case 'analyzing_done': {
      log(`✓ ${msg.message}`, 'ok');
      break;
    }

    case 'complete':
      setProgress(100);
      donePhases(hasAI);
      log('Scan complete!', 'ok');
      es.close();
      setStartBusy(false);
      currentResults = msg.results || [];
      renderResults(currentResults);
      break;

    case 'error':
      log(`Error: ${msg.message}`, 'err');
      es.close();
      setStartBusy(false);
      break;

    default:
      // Handle any other progress-like messages
      if (msg.message) {
        log(msg.message);
      }
      break;
  }
}


// ── Progress helpers ─────────────────────────────────────────────────────
function resetProgress() {
  logBox.innerHTML = '';
  setProgress(0);
  currentPhase = 0;
  phaseSteps.forEach((el, i) => {
    if (i === 0) return;
    el.classList.remove('active', 'done');
  });
}

function setProgress(pct) {
  progressFill.style.width = Math.min(pct, 100) + '%';
}

function activatePhase(n) {
  if (currentPhase >= n) return;
  // Mark previous phases done
  for (let i = 1; i < n; i++) {
    phaseSteps[i].classList.remove('active');
    phaseSteps[i].classList.add('done');
  }
  phaseSteps[n].classList.add('active');
  currentPhase = n;
}

function donePhases(hasAI) {
  const last = hasAI ? 3 : 2;
  for (let i = 1; i <= last; i++) {
    phaseSteps[i].classList.remove('active');
    phaseSteps[i].classList.add('done');
  }
}

function log(msg, cls) {
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  line.textContent = `${timestamp()} ${msg}`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function timestamp() {
  const d = new Date();
  return `[${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}]`;
}

function setStartBusy(busy) {
  startBtn.disabled = busy;
  startBtn.innerHTML = busy
    ? '<span class="spinner"></span> Scanning…'
    : 'Start Scan';
}

// ── Render results ────────────────────────────────────────────────────────
function renderResults(results) {
  if (!results.length) {
    resultsSection.classList.remove('hidden');
    summaryBar.innerHTML = '<p style="color:var(--muted);font-size:.85rem">No listings found.</p>';
    resultsBody.innerHTML = '';
    return;
  }

  const totalImages  = results.reduce((n, r) => n + (r.images?.length || 0), 0);
  const totalAnalyzed = results.reduce((n, r) => n + (r.describedImages?.length || 0), 0);
  const allObjects   = new Set(
    results.flatMap((r) => (r.allRecognizedObjects || '').split(', ').filter(Boolean))
  );

  summaryBar.innerHTML = `
    <div class="stat-box"><div class="val">${results.length}</div><div class="lbl">Listings</div></div>
    <div class="stat-box"><div class="val">${totalImages}</div><div class="lbl">Total Images</div></div>
    <div class="stat-box"><div class="val">${totalAnalyzed}</div><div class="lbl">Images Analyzed</div></div>
    <div class="stat-box"><div class="val">${allObjects.size}</div><div class="lbl">Unique Objects</div></div>
  `;

  resultsBody.innerHTML = '';
  for (const r of results) {
    resultsBody.appendChild(buildRow(r));
  }

  resultsSection.classList.remove('hidden');
}

function buildRow(r) {
  const tr = document.createElement('tr');

  // Listing title + link
  const titleTd = document.createElement('td');
  titleTd.innerHTML = `<a class="listing-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a>`;
  if (r.error) {
    titleTd.innerHTML += ` <span class="badge badge-red">error</span>`;
  }

  // Dates
  const datesTd = document.createElement('td');
  datesTd.textContent = r.dates || '—';
  datesTd.style.whiteSpace = 'nowrap';

  // Address
  const addrTd = document.createElement('td');
  addrTd.textContent = r.address || '—';
  addrTd.style.maxWidth = '220px';

  // Images
  const imgTd = document.createElement('td');
  const strip = document.createElement('div');
  strip.className = 'thumb-strip';
  const MAX_THUMBS = 5;
  const imgs = r.images || [];
  imgs.slice(0, MAX_THUMBS).forEach((url) => {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { img.style.display = 'none'; };
    strip.appendChild(img);
  });
  if (imgs.length > MAX_THUMBS) {
    const more = document.createElement('div');
    more.className = 'thumb-more';
    more.textContent = `+${imgs.length - MAX_THUMBS}`;
    strip.appendChild(more);
  }
  if (imgs.length === 0) strip.innerHTML = '<span style="color:var(--muted);font-size:.75rem">none</span>';
  imgTd.appendChild(strip);
  imgTd.innerHTML += `<div style="font-size:.7rem;color:var(--muted);margin-top:4px">${imgs.length} image${imgs.length !== 1 ? 's' : ''}</div>`;

  // Recognized objects
  const objTd = document.createElement('td');
  const objects = r.allRecognizedObjects
    ? r.allRecognizedObjects.split(', ').filter(Boolean)
    : [];
  if (objects.length) {
    const MAX_TAGS = 20;
    const tagList = document.createElement('div');
    tagList.className = 'tag-list';
    objects.slice(0, MAX_TAGS).forEach((obj) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = obj;
      tagList.appendChild(tag);
    });
    if (objects.length > MAX_TAGS) {
      const ov = document.createElement('span');
      ov.className = 'tag-overflow';
      ov.textContent = `+${objects.length - MAX_TAGS} more`;
      tagList.appendChild(ov);
    }
    objTd.appendChild(tagList);
  } else {
    objTd.innerHTML = '<span style="color:var(--muted);font-size:.75rem">—</span>';
  }

  tr.append(titleTd, datesTd, addrTd, imgTd, objTd);
  return tr;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── CSV export ────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  if (!currentResults.length) return;

  const rows = [['Title', 'URL', 'Dates', 'Address', 'Image Count', 'Recognized Objects']];
  for (const r of currentResults) {
    rows.push([
      r.title || '',
      r.url || '',
      r.dates || '',
      r.address || '',
      (r.images?.length || 0).toString(),
      r.allRecognizedObjects || '',
    ]);
  }

  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `estate-sales-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

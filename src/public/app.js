/* ─── Estate Sale Scanner — frontend app ─────────────────────────────── */

// ── Cached DOM refs ──────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const zipCodeInput        = $('zipCode');
const apiTypeSelect       = $('apiType');
const ollamaUrlInput      = $('ollamaUrl');
const ollamaModelInput    = $('ollamaModel');
const imageDomainInput    = $('imageDomain');
const apiKeyInput         = $('apiKey');
const apiKeyRow           = $('apiKeyRow');
const searchDistanceInput = $('searchDistance');
const maxImagesInput      = $('maxImages');
const imageScaleInput     = $('imageScale');
const aiConcurrencyInput  = $('aiConcurrency');
const aiPromptInput       = $('aiPrompt');
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
const resultsFilter  = $('resultsFilter');

// ── State ────────────────────────────────────────────────────────────────
let currentResults = [];
let currentPhase   = 0;  // 1, 2, or 3
let phaseProgress  = { 2: { cur: 0, tot: 0 }, 3: { cur: 0, tot: 0 } };
let expandedUrl    = null;  // track which listing row is expanded

// Show/hide API key field based on API type
apiTypeSelect.addEventListener('change', () => {
  apiKeyRow.classList.toggle('hidden', apiTypeSelect.value !== 'openai');
});

// ── Form submit ──────────────────────────────────────────────────────────
$('scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const payload = {
    zipCode:           zipCodeInput.value.trim(),
    searchDistance:    parseInt(searchDistanceInput.value, 10) || 10,
    ollamaUrl:         ollamaUrlInput.value.trim() || undefined,
    ollamaModel:       ollamaModelInput.value.trim() || 'llava-llama3:8b',
    imageDomain:       imageDomainInput.value.trim(),
    apiType:           apiTypeSelect.value,
    apiKey:            apiKeyInput.value.trim() || undefined,
    maxImages:         parseInt(maxImagesInput.value, 10) || 0,
    imageScale:        parseFloat(imageScaleInput.value) || 0.5,
    aiConcurrency:     parseInt(aiConcurrencyInput.value, 10) || 1,
    aiPrompt:          aiPromptInput.value.trim() || undefined,
  };

  if (!payload.zipCode) {
    formError.textContent = 'Zip code is required.';
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

// ── Global heartbeat to keep browser connected ──────────────────────────
(function connectHeartbeat() {
  const hb = new EventSource('/api/heartbeat');
  hb.onerror = () => { hb.close(); setTimeout(connectHeartbeat, 3000); };
})();

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
    const tr = buildRow(r);
    resultsBody.appendChild(tr);
    // Restore expanded state
    if (expandedUrl && r.url === expandedUrl) {
      toggleExpandedRow(tr, r);
    }
  }

  resultsSection.classList.remove('hidden');
}

// ── Results filter ────────────────────────────────────────────────────────
resultsFilter.addEventListener('input', () => {
  const q = resultsFilter.value.toLowerCase();
  for (const tr of resultsBody.querySelectorAll(':scope > tr')) {
    if (tr.classList.contains('expanded-row')) {
      tr.style.display = '';
      continue;
    }
    const text = tr.textContent.toLowerCase();
    const match = !q || text.includes(q);
    tr.style.display = match ? '' : 'none';
    // Hide any expanded row following a hidden row
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('expanded-row')) {
      next.style.display = match ? '' : 'none';
    }
  }
});

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
  datesTd.textContent = formatDates(r.dates) || '—';
  datesTd.style.whiteSpace = 'nowrap';

  // Address
  const addrTd = document.createElement('td');
  addrTd.textContent = r.address || '—';
  addrTd.style.maxWidth = '220px';

  // Images — clickable thumbnails
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
    img.addEventListener('click', (e) => { e.stopPropagation(); openImageModal(r, url); });
    strip.appendChild(img);
  });
  if (imgs.length > MAX_THUMBS) {
    const more = document.createElement('div');
    more.className = 'thumb-more';
    more.textContent = `+${imgs.length - MAX_THUMBS}`;
    more.style.cursor = 'pointer';
    more.addEventListener('click', (e) => { e.stopPropagation(); openImageModal(r, imgs[MAX_THUMBS]); });
    strip.appendChild(more);
  }
  if (imgs.length === 0) strip.innerHTML = '<span style="color:var(--muted);font-size:.75rem">none</span>';
  imgTd.appendChild(strip);
  const imgCount = document.createElement('div');
  imgCount.style.cssText = 'font-size:.7rem;color:var(--muted);margin-top:4px';
  imgCount.textContent = `${imgs.length} image${imgs.length !== 1 ? 's' : ''}`;
  imgTd.appendChild(imgCount);

  // Recognized objects — clickable tags
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
      tag.className = 'tag clickable';
      tag.textContent = obj;
      tag.addEventListener('click', () => openObjectModal(r, obj));
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

  // Make row expandable on click
  tr.style.cursor = 'pointer';
  tr.addEventListener('click', () => toggleExpandedRow(tr, r));

  tr.append(titleTd, datesTd, addrTd, imgTd, objTd);
  return tr;
}

/** Toggle an expanded detail row below the clicked row. */
function toggleExpandedRow(tr, r) {
  const existing = tr.nextElementSibling;
  if (existing && existing.classList.contains('expanded-row')) {
    existing.remove();
    tr.classList.remove('row-expanded');
    expandedUrl = null;
    return;
  }
  // Remove any other expanded rows
  document.querySelectorAll('.expanded-row').forEach(el => el.remove());
  document.querySelectorAll('.row-expanded').forEach(el => el.classList.remove('row-expanded'));

  tr.classList.add('row-expanded');
  expandedUrl = r.url;
  const expTr = document.createElement('tr');
  expTr.className = 'expanded-row';
  const expTd = document.createElement('td');
  expTd.colSpan = 5;
  expTd.className = 'expanded-cell';

  const imgs = r.images || [];
  const described = r.describedImages || [];

  // All images grid
  if (imgs.length) {
    const title = document.createElement('div');
    title.className = 'expanded-section-title';
    title.textContent = `All Images (${imgs.length})`;
    expTd.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'expanded-img-grid';
    imgs.forEach((url) => {
      const wrap = document.createElement('div');
      wrap.className = 'expanded-img-card';
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { wrap.style.display = 'none'; };
      img.addEventListener('click', (e) => { e.stopPropagation(); openImageModal(r, url); });
      wrap.appendChild(img);

      // Show objects for this image if analyzed
      const desc = described.find(d => d.path === url);
      if (desc && desc.objects && desc.objects.length) {
        const objs = document.createElement('div');
        objs.className = 'expanded-img-objects';
        desc.objects.forEach(o => {
          const tag = document.createElement('span');
          tag.className = 'tag clickable';
          tag.textContent = o;
          tag.addEventListener('click', (e) => { e.stopPropagation(); openImageModal(r, url, o); });
          objs.appendChild(tag);
        });
        wrap.appendChild(objs);
      } else if (desc && desc.error) {
        const errWrap = document.createElement('div');
        errWrap.className = 'expanded-img-error';
        errWrap.textContent = 'AI error ';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'retry-btn';
        retryBtn.innerHTML = '&#x21bb; retry';
        retryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          retryImageAnalysis(r, url, errWrap);
        });
        errWrap.appendChild(retryBtn);
        wrap.appendChild(errWrap);
      }
      grid.appendChild(wrap);
    });
    expTd.appendChild(grid);
  }

  // All recognized objects
  const allObjs = (r.allRecognizedObjects || '').split(', ').filter(Boolean);
  if (allObjs.length) {
    const title = document.createElement('div');
    title.className = 'expanded-section-title';
    title.textContent = `All Recognized Objects (${allObjs.length})`;
    expTd.appendChild(title);

    const tagList = document.createElement('div');
    tagList.className = 'tag-list';
    allObjs.forEach(obj => {
      const tag = document.createElement('span');
      tag.className = 'tag clickable';
      tag.textContent = obj;
      tag.addEventListener('click', (e) => { e.stopPropagation(); openObjectModal(r, obj); });
      tagList.appendChild(tag);
    });
    expTd.appendChild(tagList);
  }

  expTr.appendChild(expTd);
  tr.after(expTr);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format date strings into a friendlier format like "Wed, Mar 25 - Fri, Mar 27" */
function formatDates(dateStr) {
  if (!dateStr) return '';
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function fmtDate(d) {
    return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  // Split on comma or " – " / " — " but NOT hyphens inside ISO dates
  const parts = dateStr.split(/\s*[,]\s*|\s+[–—]\s+/);
  const seen = new Set();
  const formatted = [];
  for (const part of parts) {
    const d = new Date(part.trim());
    if (isNaN(d.getTime())) {
      return dateStr; // Can't parse — return original
    }
    const ds = fmtDate(d);
    if (!seen.has(ds)) {
      seen.add(ds);
      formatted.push(ds);
    }
  }
  return formatted.join(' - ');
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

// ── Image Detail Modal ────────────────────────────────────────────────────
const imageModal    = $('imageModal');
const modalClose    = $('modalClose');
const modalImageWrap = $('modalImageWrap');
const modalNav      = $('modalNav');
const modalTags     = $('modalTags');
const modalObjSection = $('modalObjectsSection');
const modalError    = $('modalError');

// Close modal handlers
modalClose.addEventListener('click', closeModal);
imageModal.addEventListener('click', (e) => {
  if (e.target === imageModal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && imageModal.classList.contains('open')) closeModal();
});

function closeModal() {
  imageModal.classList.remove('open');
}

/**
 * Find the describedImages entry for a given image URL within a listing result.
 */
function findDescribed(listing, imageUrl) {
  return (listing.describedImages || []).find((d) => d.path === imageUrl);
}

// Track current modal listing for retry
let _modalListing = null;

/**
 * Open the modal showing a specific image and its AI-detected objects.
 * Also renders a thumbnail nav strip for all images in the listing.
 */
function openImageModal(listing, activeImageUrl, highlightObj) {
  const images = listing.images || [];
  if (!images.length) return;
  _modalListing = listing;

  // Render full-size image
  renderModalImage(activeImageUrl);

  // Render thumbnail nav
  modalNav.innerHTML = '';
  images.forEach((url) => {
    const thumb = document.createElement('img');
    thumb.className = 'modal-nav-thumb' + (url === activeImageUrl ? ' active' : '');
    thumb.src = url;
    thumb.alt = '';
    thumb.addEventListener('click', () => openImageModal(listing, url, highlightObj));
    modalNav.appendChild(thumb);
  });

  // Render detected objects for this image
  const described = findDescribed(listing, activeImageUrl);
  renderModalObjects(described, highlightObj);

  imageModal.classList.add('open');
}

/**
 * Open the modal focused on a recognized object — finds the first image containing
 * that object, shows it, and highlights the tag.
 */
function openObjectModal(listing, objectName) {
  const described = (listing.describedImages || []).find(
    (d) => d.objects && d.objects.includes(objectName)
  );
  const imageUrl = described ? described.path : (listing.images || [])[0];
  if (!imageUrl) return;
  openImageModal(listing, imageUrl, objectName);
}

function renderModalImage(url) {
  modalImageWrap.innerHTML = `<img src="${esc(url)}" alt="Estate sale image" />`;
}

function renderModalObjects(described, highlightObj) {
  modalTags.innerHTML = '';
  modalError.style.display = 'none';

  if (!described) {
    modalObjSection.style.display = 'none';
    modalError.style.display = 'block';
    modalError.textContent = 'No AI analysis available for this image.';
    return;
  }

  if (described.error) {
    modalObjSection.style.display = 'none';
    modalError.style.display = 'block';
    modalError.innerHTML = '';
    modalError.textContent = `AI error: ${described.error} `;
    const retryBtn = document.createElement('button');
    retryBtn.className = 'retry-btn';
    retryBtn.innerHTML = '&#x21bb; retry';
    retryBtn.addEventListener('click', () => {
      retryImageAnalysis(_modalListing, described.path, modalError);
    });
    modalError.appendChild(retryBtn);
    return;
  }

  const objs = described.objects || [];
  if (!objs.length) {
    modalObjSection.style.display = 'none';
    modalError.style.display = 'block';
    modalError.textContent = 'No objects were identified in this image.';
    return;
  }

  modalObjSection.style.display = '';
  modalError.style.display = 'none';
  objs.forEach((obj) => {
    const tag = document.createElement('span');
    tag.className = 'modal-tag' + (highlightObj && obj === highlightObj ? ' highlight' : '');
    tag.textContent = obj;
    modalTags.appendChild(tag);
  });
}

/** Retry AI analysis for a single failed image */
async function retryImageAnalysis(listing, imageUrl, errorEl) {
  const retryBtn = errorEl.querySelector('.retry-btn');
  if (retryBtn) {
    retryBtn.classList.add('retrying');
    retryBtn.innerHTML = '&#x21bb; retrying…';
  }
  try {
    const resp = await fetch('/api/retry-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageUrl,
        ollamaUrl:   ollamaUrlInput.value.trim(),
        ollamaModel: ollamaModelInput.value.trim() || 'llava',
        apiType:     apiTypeSelect.value,
        apiKey:      apiKeyInput.value.trim() || undefined,
        imageScale:  parseFloat(imageScaleInput.value) || 0.5,
        aiPrompt:    aiPromptInput.value.trim() || undefined,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Retry failed');

    // Update listing data in-place
    listing.describedImages = listing.describedImages || [];
    const idx = listing.describedImages.findIndex(d => d.path === imageUrl);
    const entry = { path: imageUrl, objects: data.objects };
    if (idx !== -1) listing.describedImages[idx] = entry;
    else listing.describedImages.push(entry);

    // Update allRecognizedObjects
    const allObjSet = new Set((listing.allRecognizedObjects || '').split(', ').filter(Boolean));
    data.objects.forEach(o => allObjSet.add(o));
    listing.allRecognizedObjects = [...allObjSet].sort().join(', ');

    // Re-render table and any open expanded row / modal
    renderResults(currentResults);
    log(`↻ Retry success for image: ${data.objects.length} objects found`, 'ok');
  } catch (err) {
    log(`↻ Retry failed: ${err.message}`, 'err');
    if (retryBtn) {
      retryBtn.classList.remove('retrying');
      retryBtn.innerHTML = '&#x21bb; retry';
    }
  }
}

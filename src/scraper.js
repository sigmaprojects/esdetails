import { chromium } from 'playwright';

const DELAY_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scroll the page progressively until all lazy-loaded content has appeared.
 * Keeps scrolling until the scroll height stops growing for several consecutive checks.
 */
async function scrollToLoadAll(page, { maxScrolls = 50, scrollPause = 300 } = {}) {
  let previousHeight = 0;
  let stableCount = 0;
  const stableThreshold = 2; // stop after height unchanged N times in a row

  for (let i = 0; i < maxScrolls; i++) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

    if (currentHeight === previousHeight) {
      stableCount++;
      if (stableCount >= stableThreshold) break;
    } else {
      stableCount = 0;
    }

    previousHeight = currentHeight;

    // Scroll to the bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(scrollPause);
  }

  // Scroll back to top so strategies like click-through work from the beginning
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
}

/** Returns true for URLs that look like real gallery photos (not icons/logos). */
function isGalleryImage(url, allowedDomain) {
  if (!url || typeof url !== 'string') return false;
  if (!/\.(jpg|jpeg|png|webp|gif)/i.test(url)) return false;
  if (/icon|logo|favicon|sprite|avatar|badge|banner|placeholder|pixel|blank|default/i.test(url)) return false;
  
  // Specific filter for estatesales.net thumbnails vs full-sized images
  // They use /1-1/ for full/large, /1-2/ for medium thumbnails, /1-3/ etc. for smaller
  if (url.includes('picturescdn.estatesales.net') && /\/1-[2-9]\//.test(url)) {
    return false;
  }

  if (allowedDomain && !url.includes(allowedDomain)) return false;
  return true;
}

/** Recursively walk any JSON value and collect image URLs into a Set. */
function collectImageUrls(obj, allowedDomain, urls = new Set(), depth = 0) {
  if (depth > 25) return urls;
  if (typeof obj === 'string') {
    if (/^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)/i.test(obj) && isGalleryImage(obj, allowedDomain)) {
      urls.add(obj);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectImageUrls(item, allowedDomain, urls, depth + 1);
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) collectImageUrls(val, allowedDomain, urls, depth + 1);
  }
  return urls;
}

/** Try to derive a full-size URL from a thumbnail URL by common patterns. */
function toFullSizeUrl(url) {
  // Pattern: URL contains /thumb/ → remove it
  if (/\/thumb\//i.test(url)) return url.replace(/\/thumb\//i, '/');
  // Pattern: size suffix like _300x200 or -thumb
  const cleaned = url.replace(/_\d+x\d+/i, '').replace(/-thumb/i, '');
  if (cleaned !== url) return cleaned;
  // Pattern: query params for resize
  try {
    const u = new URL(url);
    u.searchParams.delete('w');
    u.searchParams.delete('h');
    u.searchParams.delete('width');
    u.searchParams.delete('height');
    u.searchParams.delete('fit');
    u.searchParams.delete('resize');
    return u.toString();
  } catch {
    return url;
  }
}

/** Extract structured data from Next.js __NEXT_DATA__ JSON. */
function extractFromNextData(data, allowedDomain) {
  const result = { title: '', dates: '', address: '', images: [] };
  const props = data?.props?.pageProps;
  if (!props) return result;

  // Candidates for the listing object
  const candidates = [
    props.listing,
    props.sale,
    props.estatesale,
    props.saleDetails,
    props.pageData,
    props.data,
    props,
  ].filter(Boolean);

  for (const d of candidates) {
    if (!result.title) {
      result.title = d.title || d.name || d.companyName || d.saleTitle || d.heading || '';
    }
    if (!result.address) {
      if (typeof d.address === 'string') {
        result.address = d.address;
      } else if (d.address && typeof d.address === 'object') {
        result.address = [
          d.address.street || d.address.streetAddress,
          d.address.city,
          d.address.state || d.address.region,
          d.address.zip || d.address.postalCode,
        ]
          .filter(Boolean)
          .join(', ');
      } else if (d.streetAddress) {
        result.address = [d.streetAddress, d.city, d.state].filter(Boolean).join(', ');
      }
    }
    if (!result.dates) {
      if (Array.isArray(d.dates)) {
        result.dates = d.dates.join(', ');
      } else if (d.dates) {
        result.dates = String(d.dates);
      } else if (d.startDate) {
        result.dates = d.endDate ? `${d.startDate} – ${d.endDate}` : String(d.startDate);
      } else if (d.saleDate) {
        result.dates = String(d.saleDate);
      }
    }
  }

  // Collect all image URLs anywhere in the Next.js data
  const imageUrls = collectImageUrls(props, allowedDomain);
  result.images = [...imageUrls];

  return result;
}

/**
 * Search estatesales.net by zip code and return all listing hrefs.
 */
export async function findListings(zipCode, searchDistance, progressCallback) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    progressCallback?.({ message: 'Opening estatesales.net…' });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    });

    // Navigate to estatesales.net homepage
    await page.goto('https://www.estatesales.net/', { waitUntil: 'networkidle', timeout: 45000 });
    progressCallback?.({ message: `Entering zip code ${zipCode}…` });

    // Type the zip code into the search field and submit
    const searchInput = await page.waitForSelector('input[type="search"]', { timeout: 10000 });
    await searchInput.click({ clickCount: 3 });
    await searchInput.fill(zipCode);
    await sleep(1000);

    // Submit the search and wait for navigation to the results page
    await Promise.all([
      page.waitForURL(/estatesales\.net\/[A-Z]{2}\//, { timeout: 30000 }),
      searchInput.press('Enter'),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // The URL should now be like https://www.estatesales.net/CA/Rowland-Heights/91748
    const currentUrl = page.url();
    progressCallback?.({ message: `Search resolved to: ${currentUrl}` });

    // Derive filter prefix from the state portion of the URL (e.g. https://www.estatesales.net/CA/)
    let filterPrefix = 'https://www.estatesales.net/';
    try {
      const u = new URL(currentUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 1 && /^[A-Z]{2}$/i.test(parts[0])) {
        filterPrefix = `${u.origin}/${parts[0]}/`;
      }
    } catch { /* use default */ }

    progressCallback?.({ message: 'Configuring search filters…' });

    // Configure distance and sale type filters
    await configureSearchForm(page, searchDistance || 10, progressCallback);

    progressCallback?.({ message: 'Collecting listing links…' });

    const links = await page.evaluate((prefix) => {
      return [
        ...new Set(
          [...document.querySelectorAll('a[href]')]
            .map((a) => a.href)
            .filter((href) => {
              if (!href.startsWith(prefix) || href.length <= prefix.length) return false;
              // Only keep actual listing URLs (end with /numericId)
              return /\/\d+$/.test(href.replace(/\/+$/, ''));
            })
        ),
      ];
    }, filterPrefix);

    progressCallback?.({ message: `Found ${links.length} listing links`, count: links.length });
    return links;
  } finally {
    await browser.close();
  }
}

/**
 * Configure the estatesales.net search form:
 * - Select only "Estate Sales" and "Moving Sales" checkboxes
 * - Uncheck "Additional Liquidations" options
 * - Set the distance slider to the specified value
 */
async function configureSearchForm(page, distance, progressCallback) {
  try {
    // Look for the distance/radius control and set it
    // estatesales.net uses a distance slider or input — try several selectors
    const distanceSet = await page.evaluate((dist) => {
      // Try slider input
      const slider = document.querySelector('input[type="range"][name*="distance" i], input[type="range"][name*="radius" i], input[type="range"][name*="mile" i], input.distance-slider, input#distance, input#radius');
      if (slider) {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSet.call(slider, dist);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        return `slider: ${dist}`;
      }
      // Try a number input or select near "miles" or "distance" text
      const labels = [...document.querySelectorAll('label, span, div')];
      for (const el of labels) {
        if (/mile|distance|radius/i.test(el.textContent)) {
          const input = el.querySelector('input, select') || el.parentElement?.querySelector('input, select');
          if (input) {
            const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSet.call(input, dist);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return `input: ${dist}`;
          }
        }
      }
      return null;
    }, distance);
    if (distanceSet) {
      progressCallback?.({ message: `Set search distance to ${distance} miles` });
    }

    // Configure sale type checkboxes:
    // - Keep checked: Estate Sales, Moving Sales
    // - Uncheck all "Additional Liquidations": Business Closings, Moved Offsite To Store,
    //   Outside Sales, Single Item Type Collections, Buyouts Or Cleanouts, Demolition Sales
    const uncheckedLabels = await page.evaluate(() => {
      const unchecked = [];
      const uncheckPatterns = [
        'business closing', 'moved offsite', 'outside sale',
        'single item', 'buyout', 'cleanout', 'demolition',
        'auction', 'online', 'dealer', 'other',
        'additional', 'liquidation', 'tag sale', 'garage',
      ];
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      for (const cb of checkboxes) {
        const label = cb.closest('label') || document.querySelector(`label[for="${cb.id}"]`);
        const text = (label?.textContent || cb.getAttribute('aria-label') || cb.name || '').trim().toLowerCase();

        if (text.includes('estate sale') || text.includes('estate sales')) {
          if (!cb.checked) cb.click();
        } else if (text.includes('moving sale') || text.includes('moving sales')) {
          if (!cb.checked) cb.click();
        } else if (uncheckPatterns.some((p) => text.includes(p))) {
          if (cb.checked) {
            cb.click();
            unchecked.push(text);
          }
        }
      }
      return unchecked;
    });
    if (uncheckedLabels.length > 0) {
      progressCallback?.({ message: `Unchecked Additional Liquidations: ${uncheckedLabels.join(', ')}` });
    }
    progressCallback?.({ message: 'Configured sale type filters (Estate Sales + Moving Sales only)' });

    // Look for an "Apply" or "Search" or "Update" button to submit the filter
    const applied = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, input[type="submit"], a.btn, a.button')];
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').trim().toLowerCase();
        if (text.includes('apply') || text.includes('update') || text.includes('search') || text.includes('filter')) {
          btn.click();
          return text;
        }
      }
      return null;
    });

    if (applied) {
      progressCallback?.({ message: `Clicked "${applied}" to apply filters, waiting for results…` });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    } else {
      // If no apply button, wait briefly for any dynamic updates
      await sleep(2000);
    }
  } catch (err) {
    console.warn(`[SCRAPER] Could not configure search form: ${err.message}`);
    progressCallback?.({ message: `Warning: Could not fully configure search form: ${err.message}` });
  }
}

/**
 * Scrape each listing URL for title, dates, address, and images.
 * Returns an array of listing objects.
 */
export async function scrapeListings(listingUrls, imageDomain, progressCallback, { zipcode } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  const zipLabel = zipcode ? `[${zipcode}] ` : '';

  try {
    for (let i = 0; i < listingUrls.length; i++) {
      const url = listingUrls[i];
      const shortUrl = url.split('/').slice(-2).join('/');
      progressCallback?.({
        current: i + 1,
        total: listingUrls.length,
        url,
        message: `${zipLabel}Scraping listing ${i + 1}/${listingUrls.length}: ${shortUrl}`,
      });

      try {
        const listing = await scrapeListing(browser, url, imageDomain);
        results.push(listing);
        progressCallback?.({
          type: 'listing_scraped',
          listing,
          message: `${zipLabel}Scraped: ${listing.title || shortUrl} (${listing.images.length} images)`,
        });
      } catch (err) {
        const errorListing = {
          url,
          title: '(error)',
          dates: '',
          address: '',
          images: [],
          error: err.message,
        };
        results.push(errorListing);
        progressCallback?.({
          type: 'listing_scraped',
          listing: errorListing,
          message: `${zipLabel}Scrape failed for ${shortUrl}: ${err.message}`,
        });
      }

      if (i < listingUrls.length - 1) await sleep(DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  return results;
}

async function scrapeListing(browser, url, imageDomain) {
  const page = await browser.newPage();
  const networkImages = new Set();

  try {
    await page.setExtraHTTPHeaders({
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    });

    // Intercept responses to capture large (full-size) images
    page.on('response', async (response) => {
      try {
        const resUrl = response.url();
        const ct = response.headers()['content-type'] || '';
        const cl = parseInt(response.headers()['content-length'] || '0', 10);
        if (ct.startsWith('image/') && cl > 25000 && isGalleryImage(resUrl, imageDomain)) {
          networkImages.add(resUrl);
        }
      } catch {
        // ignore response listener errors
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    // Best-effort wait for JS gallery to hydrate
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // Scroll the page to trigger lazy-loaded gallery images
    await scrollToLoadAll(page);

    let title = '';
    let dates = '';
    let address = '';
    let images = [];

    // --- Strategy 1: Next.js __NEXT_DATA__ (most reliable) ---
    const nextDataText = await page
      .$eval('#__NEXT_DATA__', (el) => el.textContent)
      .catch(() => null);
    if (nextDataText) {
      try {
        const extracted = extractFromNextData(JSON.parse(nextDataText), imageDomain);
        title = extracted.title;
        dates = extracted.dates;
        address = extracted.address;
        images = extracted.images;
      } catch {
        // fall through
      }
    }

    // --- Strategy 2: JSON-LD structured data ---
    if (!title || !address) {
      const ldTexts = await page.$$eval('script[type="application/ld+json"]', (els) =>
        els.map((el) => el.textContent)
      );
      for (const ldText of ldTexts) {
        try {
          const ld = JSON.parse(ldText);
          if (!title) title = ld.name || '';
          if (!address && ld.address) {
            address = [
              ld.address.streetAddress,
              ld.address.addressLocality,
              ld.address.addressRegion,
            ]
              .filter(Boolean)
              .join(', ');
          }
          if (!dates && ld.startDate) {
            dates = ld.endDate
              ? `${ld.startDate} – ${ld.endDate}`
              : String(ld.startDate);
          }
        } catch {
          // ignore malformed LD+JSON
        }
      }
    }

    // --- Strategy 3: DOM fallback for title / address / dates ---
    if (!title) {
      title = await page
        .$eval('h1', (el) => el.innerText.trim())
        .catch(() => '');
    }
    if (!address) {
      address = await page
        .$eval(
          '[class*="address" i], [itemprop="streetAddress"], [class*="Address" i], [class*="location" i]',
          (el) => el.innerText.trim()
        )
        .catch(() => '');
    }
    // --- Strategy 3b: Google Maps link fallback for address ---
    if (!address) {
      address = await page
        .evaluate(() => {
          const link = document.querySelector('a[href*="maps.google.com/maps?q="]');
          if (!link) return '';
          try {
            const url = new URL(link.href);
            const q = url.searchParams.get('q');
            return q ? decodeURIComponent(q).replace(/\+/g, ' ') : '';
          } catch { return ''; }
        })
        .catch(() => '');
    }
    if (!dates) {
      dates = await page
        .$eval(
          '[class*="date" i], [class*="Date" i], time, [class*="schedule" i]',
          (el) => el.innerText.trim()
        )
        .catch(() => '');
    }

    // --- Strategy 4: always collect img[src] from DOM (may include scroll-loaded images) ---
    const domImgs = await page.evaluate(() =>
      [...document.querySelectorAll('img')]
        .flatMap((img) => [
          img.src,
          img.getAttribute('data-src'),
          img.getAttribute('data-full'),
          img.getAttribute('data-original'),
        ])
        .filter(Boolean)
    );
    const filteredDomImgs = domImgs.filter((img) => isGalleryImage(img, imageDomain));
    // Merge DOM images with any already found (e.g. from __NEXT_DATA__)
    images = [...new Set([...images, ...filteredDomImgs])];

    // --- Strategy 5: try clicking thumbnails for full-size modal images ---
    if (images.length < 3) {
      const galleryImages = await clickThroughGallery(page, imageDomain);
      if (galleryImages.length > images.length) images = galleryImages;
    }

    // Attempt to resolve any thumbnail URLs to full-size
    images = images.map(toFullSizeUrl);

    // Merge network-captured images (deduplicated)
    const allImages = [...new Set([...images, ...networkImages])].filter((img) => isGalleryImage(img, imageDomain));

    const result = { url, title, dates, address, images: allImages };
    console.log(`[Scraper] Extracted: ${url} (${allImages.length} images)`);
    return result;
  } finally {
    await page.close();
  }
}

async function clickThroughGallery(page, imageDomain) {
  const collected = new Set();

  const thumbSelectors = [
    '[class*="gallery" i] img',
    '[class*="photos" i] img',
    '[class*="carousel" i] img',
    '[class*="slideshow" i] img',
    '[class*="thumbnail" i]',
    '[class*="thumb" i] img',
  ];

  let thumbs = [];
  for (const sel of thumbSelectors) {
    thumbs = await page.$$(sel);
    if (thumbs.length > 0) break;
  }

  for (const thumb of thumbs.slice(0, 40)) {
    try {
      await thumb.click({ timeout: 2000 });
      await sleep(400);

      // Capture the full-size image displayed in any modal/lightbox
      const fullImg = await page
        .$eval(
          '[class*="modal" i] img[src], [class*="lightbox" i] img[src], [class*="overlay" i] img[src], [role="dialog"] img[src], .middle-image-container img[src]',
          (el) => el.src
        )
        .catch(() => null);

      if (fullImg && isGalleryImage(fullImg, imageDomain)) collected.add(fullImg);

      // Close modal
      await page.keyboard.press('Escape');
      await sleep(200);
    } catch {
      // Ignore failures for individual thumbnails
    }
  }

  return [...collected];
}

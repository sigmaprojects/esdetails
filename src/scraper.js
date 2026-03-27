import { chromium } from 'playwright';
import axios from 'axios';

const DELAY_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Extract the numeric sale ID from an estatesales.net listing URL.
 * e.g. "https://www.estatesales.net/CA/Glendora/91740/4809504" → "4809504"
 */
function extractSaleId(url) {
  const match = url.match(/\/(\d+)\/?$/);
  return match ? match[1] : null;
}

/**
 * Fetch all gallery image URLs for a listing via the estatesales.net API.
 * Returns full-size (1-1) image URLs from sale.pictures[].url
 */
async function fetchImagesFromApi(saleId) {
  const query = JSON.stringify({ saleId: parseInt(saleId, 10), userId: null, isSuper: false });
  const apiUrl = `https://www.estatesales.net/api/legacy/queries/traditional-sales/traditional-sale?query=${encodeURIComponent(query)}&explicitTypes=DateTime`;

  const resp = await axios.get(apiUrl, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
  });

  const sale = resp.data?.sale;
  if (!sale) {
    console.warn(`[Scraper] API response missing 'sale' key for saleId ${saleId}`);
    return [];
  }

  const pictures = sale.pictures || [];
  // Use the full-size url (1-1 pattern) from each picture object
  const imageUrls = pictures
    .map(p => p.url)
    .filter(u => u && typeof u === 'string');

  console.log(`[Scraper] API returned ${imageUrls.length} images for saleId ${saleId}`);
  return imageUrls;
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
export async function scrapeListings(listingUrls, progressCallback, { zipcode } = {}) {
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
        const listing = await scrapeListing(browser, url);
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

async function scrapeListing(browser, url) {
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders({
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    let title = '';
    let dates = '';
    let address = '';

    // --- JSON-LD structured data ---
    const ldTexts = await page.$$eval('script[type="application/ld+json"]', (els) =>
      els.map((el) => el.textContent)
    ).catch(() => []);
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

    // --- DOM fallback for title / address / dates ---
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
    if (!address) {
      address = await page
        .evaluate(() => {
          const link = document.querySelector('a[href*="maps.google.com/maps?q="]');
          if (!link) return '';
          try {
            const u = new URL(link.href);
            const q = u.searchParams.get('q');
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

    // --- Fetch images from API ---
    const saleId = extractSaleId(url);
    let images = [];
    if (saleId) {
      images = await fetchImagesFromApi(saleId);
    } else {
      console.warn(`[Scraper] Could not extract sale ID from URL: ${url}`);
    }

    const result = { url, title, dates, address, images };
    console.log(`[Scraper] Extracted: ${url} — ${title} (${images.length} images)`);
    return result;
  } finally {
    await page.close();
  }
}

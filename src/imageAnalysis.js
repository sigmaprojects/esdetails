import axios from 'axios';
import sharp from 'sharp';
import { getCachedImage, setCachedImage } from './cache.js';

const DEFAULT_PROMPT =
  'List every item in this image. For each item, provide only the name and the material/color.\n' +
  'Rules:\n' +
  '    Do NOT mention brands, models, or \'generic\'.\n' +
  '    Do NOT describe condition.\n' +
  '    Format: [Item Name]: [Material/Color]\n' +
  '    Be extremely brief. Use one line per item.';

/** Download an image URL and return it as a base64 string, optionally resized. */
async function fetchBase64(imageUrl, scale = 1) {
  // Check cache first (caches the raw downloaded buffer before resize)
  let buffer = getCachedImage(imageUrl);

  if (!buffer) {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 20 * 1024 * 1024, // 20 MB cap
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    });
    buffer = Buffer.from(response.data);
    setCachedImage(imageUrl, buffer);
  } else {
    console.log(`[AI] Image cache hit: ${imageUrl.slice(0, 80)}`);
  }

  if (scale > 0 && scale < 1) {
    try {
      const meta = await sharp(buffer).metadata();
      const newWidth = Math.round(meta.width * scale);
      buffer = await sharp(buffer)
        .resize({ width: newWidth, withoutEnlargement: true })
        .toBuffer();
      console.log(`[AI] Resized image from ${meta.width}x${meta.height} to ${newWidth}x${Math.round(meta.height * scale)}`);
    } catch (err) {
      console.warn(`[AI] Could not resize image, sending original: ${err.message}`);
    }
  }

  return buffer.toString('base64');
}

/**
 * Call the Ollama native /api/generate endpoint.
 * Expects baseUrl like "http://localhost:11434".
 */
async function callOllama(baseUrl, model, imageBase64, prompt) {
  const url = baseUrl.replace(/\/$/, '') + '/api/generate';
  const resp = await axios.post(
    url,
    { model, prompt, images: [imageBase64], stream: false },
    { timeout: 300000 } // 5 min timeout for complex images
  );
  return resp.data.response || '';
}

/**
 * Call an OpenAI-compatible endpoint (e.g. open-webui).
 * Expects baseUrl like "http://localhost:3000".
 */
async function callOpenAICompat(baseUrl, model, imageBase64, apiKey, prompt) {
  const url = baseUrl.replace(/\/$/, '') + '/api/chat/completions';
  const resp = await axios.post(
    url,
    {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey || 'ollama'}`,
        'Content-Type': 'application/json',
      },
      timeout: 90000,
    }
  );
  return resp.data.choices?.[0]?.message?.content || '';
}

/**
 * Analyze a single image and return { objects, error }.
 * Exported for the retry endpoint.
 */
export async function analyzeSingleImage(imageUrl, config) {
  const { ollamaUrl, ollamaModel, apiType = 'ollama', apiKey, imageScale = 1, aiPrompt } = config;
  const prompt = aiPrompt || DEFAULT_PROMPT;
  const b64 = await fetchBase64(imageUrl, imageScale);
  let responseText;
  if (apiType === 'openai') {
    responseText = await callOpenAICompat(ollamaUrl, ollamaModel, b64, apiKey, prompt);
  } else {
    responseText = await callOllama(ollamaUrl, ollamaModel, b64, prompt);
  }
  return parseObjects(responseText);
}

/** Parse a comma-separated (or newline-separated) object list into a clean array. */
function parseObjects(text) {
  return [
    ...new Set(
      text
        .split(/[,\n]+/)
        .map((s) => s.replace(/^[-•*\d.]+\s*/, '').trim().toLowerCase())
        .filter((s) => s.length > 1 && s.length < 80)
    ),
  ];
}

/**
 * Analyze all images for a single listing using the configured AI.
 * Returns the enriched listing object.
 *
 * @param {object} listing          - A single listing from scrapeListings()
 * @param {object} config
 * @param {Function} progressCallback
 * @param {{ processed: number, total: number }} counter - shared mutable counter
 */
export async function analyzeListing(listing, config, progressCallback, counter) {
  const { ollamaUrl, ollamaModel, apiType = 'ollama', apiKey, maxImages = 0, imageScale = 1, aiConcurrency = 1, aiPrompt } = config;
  const prompt = aiPrompt || DEFAULT_PROMPT;
  const concurrency = Math.max(1, aiConcurrency);

  const images = maxImages > 0 ? (listing.images || []).slice(0, maxImages) : listing.images || [];
  const describedImages = new Array(images.length);
  const allObjectsSet = new Set();

  async function processImage(idx) {
    const imageUrl = images[idx];
    counter.processed++;
    progressCallback?.({
      current: counter.processed,
      total: counter.total,
      message: `Analyzing image ${counter.processed}/${counter.total}`,
      imageUrl,
      listingTitle: listing.title || listing.url,
    });

    try {
      console.log(`[AI] Fetching image & requesting evaluation via ${apiType} using '${ollamaModel}'${imageScale < 1 ? ` (scale: ${imageScale})` : ''}...`);
      const b64 = await fetchBase64(imageUrl, imageScale);
      let responseText;

      if (apiType === 'openai') {
        responseText = await callOpenAICompat(ollamaUrl, ollamaModel, b64, apiKey, prompt);
      } else {
        responseText = await callOllama(ollamaUrl, ollamaModel, b64, prompt);
      }

      const objects = parseObjects(responseText);
      console.log(`[AI] Success: identified ${objects.length} objects -> ${objects.slice(0, 5).join(', ')}${objects.length > 5 ? ', ...' : ''}`);

      describedImages[idx] = { path: imageUrl, objects };
      for (const obj of objects) allObjectsSet.add(obj);

      progressCallback?.({
        type: 'image_analyzed',
        listingUrl: listing.url,
        imageUrl,
        objects,
        message: `Identified ${objects.length} objects in image`,
      });
    } catch (err) {
      console.error(`[AI] Analysis failed for image: ${err.message}`);
      describedImages[idx] = { path: imageUrl, objects: [], error: err.message };

      progressCallback?.({
        type: 'image_analyzed',
        listingUrl: listing.url,
        imageUrl,
        error: err.message,
        message: `Analysis failed: ${err.message}`,
      });
    }
  }

  // Process images with controlled concurrency using a worker pool
  const indices = images.map((_, i) => i);
  let cursor = 0;
  async function worker() {
    while (cursor < indices.length) {
      const idx = cursor++;
      await processImage(idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, images.length) }, () => worker()));

  return {
    ...listing,
    describedImages: describedImages.filter(Boolean),
    allRecognizedObjects: [...allObjectsSet].sort().join(', '),
  };
}

/**
 * Analyze all images across an array of listings using the configured AI.
 * Mutates each listing in-place and returns the enriched array.
 *
 * @param {Array}  listings        - Output from scrapeListings()
 * @param {object} config
 *   @param {string}  config.ollamaUrl   - Base URL of the AI API
 *   @param {string}  config.ollamaModel - Model name
 *   @param {string}  [config.apiType]   - 'ollama' (default) | 'openai'
 *   @param {string}  [config.apiKey]    - API key for OpenAI-compat endpoints
 *   @param {number}  [config.maxImages] - Max images per listing (0 = unlimited)
 * @param {Function} progressCallback
 */
export async function analyzeImages(listings, config, progressCallback) {
  const { maxImages = 0 } = config;
  const cappedListings = listings.map((l) => ({
    ...l,
    images: maxImages > 0 ? (l.images || []).slice(0, maxImages) : l.images || [],
  }));
  const totalImages = cappedListings.reduce((sum, l) => sum + l.images.length, 0);
  const counter = { processed: 0, total: totalImages };

  const results = [];
  for (const listing of cappedListings) {
    results.push(await analyzeListing(listing, config, progressCallback, counter));
  }
  return results;
}

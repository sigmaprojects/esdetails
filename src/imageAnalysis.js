import axios from 'axios';

const IMAGE_PROMPT =
  'You are an expert visual analyst. When analyzing an image, identify every visible object and provide maximum detail about each one. Never give vague answers — always attempt to identify brands, models, categories, and specific attributes even if only partially confident. ';

/** Download an image URL and return it as a base64 string. */
async function fetchBase64(imageUrl) {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: 20 * 1024 * 1024, // 20 MB cap
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    },
  });
  return Buffer.from(response.data).toString('base64');
}

/**
 * Call the Ollama native /api/generate endpoint.
 * Expects baseUrl like "http://localhost:11434".
 */
async function callOllama(baseUrl, model, imageBase64) {
  const url = baseUrl.replace(/\/$/, '') + '/api/generate';
  const resp = await axios.post(
    url,
    { model, prompt: IMAGE_PROMPT, images: [imageBase64], stream: false },
    { timeout: 90000 }
  );
  return resp.data.response || '';
}

/**
 * Call an OpenAI-compatible endpoint (e.g. open-webui).
 * Expects baseUrl like "http://localhost:3000".
 */
async function callOpenAICompat(baseUrl, model, imageBase64, apiKey) {
  const url = baseUrl.replace(/\/$/, '') + '/api/chat/completions';
  const resp = await axios.post(
    url,
    {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: IMAGE_PROMPT },
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
  const { ollamaUrl, ollamaModel, apiType = 'ollama', apiKey, maxImages = 0 } = config;

  // Total images across all listings (respecting per-listing cap)
  const cappedListings = listings.map((l) => ({
    ...l,
    images: maxImages > 0 ? (l.images || []).slice(0, maxImages) : l.images || [],
  }));

  const totalImages = cappedListings.reduce((sum, l) => sum + l.images.length, 0);
  let processed = 0;

  const results = [];

  for (const listing of cappedListings) {
    const describedImages = [];
    const allObjectsSet = new Set();

    for (const imageUrl of listing.images) {
      processed++;
      progressCallback?.({
        current: processed,
        total: totalImages,
        message: `Analyzing image ${processed}/${totalImages}`,
        imageUrl,
        listingTitle: listing.title || listing.url,
      });

      try {
        console.log(`[AI] Fetching image & requesting evaluation via ${apiType} using '${ollamaModel}'...`);
        const b64 = await fetchBase64(imageUrl);
        let responseText;

        if (apiType === 'openai') {
          responseText = await callOpenAICompat(ollamaUrl, ollamaModel, b64, apiKey);
        } else {
          responseText = await callOllama(ollamaUrl, ollamaModel, b64);
        }

        const objects = parseObjects(responseText);
        console.log(`[AI] Success: identified ${objects.length} objects -> ${objects.slice(0, 5).join(', ')}${objects.length > 5 ? ', ...' : ''}`);

        describedImages.push({ path: imageUrl, objects });
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
        describedImages.push({ path: imageUrl, objects: [], error: err.message });
        
        progressCallback?.({
          type: 'image_analyzed',
          listingUrl: listing.url,
          imageUrl,
          error: err.message,
          message: `Analysis failed: ${err.message}`,
        });
      }
    }

    results.push({
      ...listing,
      describedImages,
      allRecognizedObjects: [...allObjectsSet].sort().join(', '),
    });
  }

  return results;
}

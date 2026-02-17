const https = require('https');

// ── HELPERS ──────────────────────────────────────────────────────────────────

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Invalid JSON: ' + raw)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: headers || {}
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Invalid JSON: ' + raw)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── BUILD CHRONO24 SEARCH URL ─────────────────────────────────────────────────

function buildChrono24Url(query) {
  const encoded = encodeURIComponent(query);
  return `https://www.chrono24.com/search/index.htm?dosearch=true&query=${encoded}&maxAgeInDays=0`;
}

// ── PARSE PRICE STRING TO NUMBER ─────────────────────────────────────────────

function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ── AVERAGE PRICES FROM LISTINGS ─────────────────────────────────────────────

function calculatePriceStats(listings) {
  const prices = listings
    .map(l => parsePrice(l.price || l.Price || l.priceValue))
    .filter(p => p !== null && p > 500); // filter out junk values

  if (prices.length === 0) return null;

  prices.sort((a, b) => a - b);

  // Remove top and bottom 10% outliers
  const trim = Math.floor(prices.length * 0.1);
  const trimmed = prices.slice(trim, prices.length - trim || undefined);

  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  const min = trimmed[0];
  const max = trimmed[trimmed.length - 1];

  return {
    average: Math.round(avg),
    min: Math.round(min),
    max: Math.round(max),
    count: prices.length,
    currency: 'USD'
  };
}

function formatCurrency(num) {
  return '$' + num.toLocaleString('en-US');
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const APIFY_API_KEY = process.env.APIFY_API_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!APIFY_API_KEY || !ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Missing API keys in environment variables' })
    };
  }

  let query;
  try {
    const body = JSON.parse(event.body);
    query = body.query;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!query || query.trim().length < 3) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Query too short' }) };
  }

  try {

    // ── STEP 1: Run Apify Chrono24 scraper ──────────────────────────────────
    console.log(`[watch-lookup] Searching Chrono24 for: ${query}`);

    const chrono24Url = buildChrono24Url(query);
    const ACTOR_ID = 'misterkhan~chrono24-search-scraper';

    const runResponse = await httpsPost(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_API_KEY}`,
      {
        startUrls: [{ url: chrono24Url }],
        maxItems: 20,
        useApifyProxy: true
      },
      {}
    );

    if (!runResponse.data || !runResponse.data.id) {
      throw new Error('Failed to start Apify run: ' + JSON.stringify(runResponse));
    }

    const runId = runResponse.data.id;
    const datasetId = runResponse.data.defaultDatasetId;
    console.log(`[watch-lookup] Apify run started: ${runId}`);

    // ── STEP 2: Poll until run completes (max 60 seconds) ───────────────────
    let status = 'RUNNING';
    let attempts = 0;
    const maxAttempts = 20;

    while (status === 'RUNNING' || status === 'READY' || status === 'INITIALIZING') {
      await sleep(3000);
      attempts++;
      if (attempts > maxAttempts) break;

      const statusResponse = await httpsGet(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_KEY}`
      );
      status = statusResponse.data?.status || 'UNKNOWN';
      console.log(`[watch-lookup] Run status: ${status} (attempt ${attempts})`);
    }

    // ── STEP 3: Fetch results from dataset ──────────────────────────────────
    let listings = [];

    if (status === 'SUCCEEDED') {
      const datasetResponse = await httpsGet(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}&limit=20`
      );
      listings = Array.isArray(datasetResponse) ? datasetResponse : [];
      console.log(`[watch-lookup] Got ${listings.length} listings from Chrono24`);
    } else {
      console.warn(`[watch-lookup] Apify run did not succeed: ${status}. Falling back to AI-only.`);
    }

    // ── STEP 4: Calculate price stats from real listings ────────────────────
    const priceStats = listings.length > 0 ? calculatePriceStats(listings) : null;

    // Build listings summary for Claude
    let listingsSummary = '';
    if (listings.length > 0) {
      const sample = listings.slice(0, 10).map(l => {
        const price = l.price || l.Price || 'N/A';
        const condition = l.condition || l.Condition || 'Unknown';
        const year = l.year || l.Year || '';
        const location = l.location || l.Location || '';
        return `- ${price} | ${condition}${year ? ' | ' + year : ''}${location ? ' | ' + location : ''}`;
      }).join('\n');
      listingsSummary = `\n\nLIVE CHRONO24 LISTINGS (${listings.length} found):\n${sample}`;

      if (priceStats) {
        listingsSummary += `\n\nCALCULATED PRICE STATS:\n- Average: ${formatCurrency(priceStats.average)}\n- Range: ${formatCurrency(priceStats.min)} – ${formatCurrency(priceStats.max)}\n- Based on ${priceStats.count} listings`;
      }
    } else {
      listingsSummary = '\n\nNo live listings found — use your knowledge of current secondary market prices.';
    }

    // ── STEP 5: Call Claude to build full report ─────────────────────────────
    console.log('[watch-lookup] Calling Claude for full report...');

    const prompt = `You are a luxury watch market expert. A user has searched for: "${query}"
${listingsSummary}

Using the live listing data above (if available) as your primary price source, return a JSON object with EXACTLY this structure (no markdown, no explanation, just raw JSON):
{
  "brand": "Brand name",
  "model": "Full model name",
  "reference": "Reference number",
  "marketPrice": "${priceStats ? formatCurrency(priceStats.average) : 'use your knowledge'}",
  "priceRange": "${priceStats ? formatCurrency(priceStats.min) + ' – ' + formatCurrency(priceStats.max) : 'use your knowledge'}",
  "specs": {
    "caseDiameter": "XXmm",
    "caseMaterial": "Material",
    "movement": "Calibre XXXX",
    "powerReserve": "XX hours",
    "waterResistance": "XXXm",
    "yearIntroduced": "XXXX"
  },
  "pricing": {
    "msrp": "$XX,XXX",
    "secondaryAvg": "${priceStats ? formatCurrency(priceStats.average) : 'estimated'}",
    "premiumDiscount": "calculated vs retail",
    "trend12m": "based on market knowledge",
    "liquidity": "High / Medium / Low",
    "updated": "Feb 2026",
    "listingsFound": "${listings.length}"
  },
  "byCondition": {
    "mint": "estimated from avg + 15%",
    "excellent": "estimated from avg + 5%",
    "veryGood": "estimated from avg",
    "good": "estimated from avg - 10%",
    "fair": "estimated from avg - 20%"
  },
  "investment": {
    "verdict": "Strong Buy | Hold | Caution",
    "analysis": "2-3 sentences on investment merit, mentioning the live data found if available.",
    "bars": [
      { "label": "Value Retention", "value": 85 },
      { "label": "Market Demand", "value": 90 },
      { "label": "Liquidity", "value": 80 },
      { "label": "Price Stability", "value": 75 }
    ]
  }
}`;

    const claudeResponse = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    );

    const rawText = (claudeResponse.content || [])
      .map(b => b.text || '')
      .join('');

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const watchData = JSON.parse(cleaned);

    // Add metadata
    watchData.dataSource = listings.length > 0 ? 'live' : 'ai-estimated';
    watchData.listingsFound = listings.length;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(watchData)
    };

  } catch (err) {
    console.error('[watch-lookup] Error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Lookup failed',
        message: err.message
      })
    };
  }
};
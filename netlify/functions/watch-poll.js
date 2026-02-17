const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET'
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) || num < 500 ? null : num;
}

function calcStats(listings) {
  const prices = listings
    .map(l => parsePrice(l.price || l.Price || l.priceValue))
    .filter(p => p !== null);

  if (prices.length === 0) return null;

  prices.sort((a, b) => a - b);
  const trim = Math.floor(prices.length * 0.1);
  const trimmed = prices.slice(trim, prices.length - (trim || undefined));
  const avg = Math.round(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
  const fmt = n => '$' + n.toLocaleString('en-US');

  return {
    average: fmt(avg),
    min: fmt(trimmed[0]),
    max: fmt(trimmed[trimmed.length - 1]),
    count: prices.length
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const APIFY_API_KEY = process.env.APIFY_API_KEY;
  if (!APIFY_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing APIFY_API_KEY' }) };

  const { runId, datasetId } = event.queryStringParameters || {};
  if (!runId || !datasetId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing runId or datasetId' }) };
  }

  try {
    // Check run status
    const statusResponse = await httpsGet(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_KEY}`
    );

    const status = statusResponse.data?.status || 'UNKNOWN';
    console.log(`[watch-poll] Run ${runId} status: ${status}`);

    if (status === 'RUNNING' || status === 'READY' || status === 'INITIALIZING') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'RUNNING' })
      };
    }

    if (status !== 'SUCCEEDED') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'FAILED', error: 'Apify run did not succeed' })
      };
    }

    // Fetch dataset items
    const datasetResponse = await httpsGet(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}&limit=10`
    );

    const listings = Array.isArray(datasetResponse) ? datasetResponse : [];
    console.log(`[watch-poll] Got ${listings.length} listings`);

    if (listings.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'SUCCEEDED', listings: 0, prices: null })
      };
    }

    const stats = calcStats(listings);

    // Sample listings for display
    const sample = listings.slice(0, 5).map(l => ({
      price: l.price || l.Price || 'N/A',
      condition: l.condition || l.Condition || 'Unknown',
      year: l.year || l.Year || '',
      location: l.location || l.Location || ''
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'SUCCEEDED',
        listings: listings.length,
        prices: stats,
        sample
      })
    };

  } catch (err) {
    console.error('[watch-poll] Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
const https = require('https');

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
        catch (e) { reject(new Error('Invalid JSON: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const APIFY_API_KEY = process.env.APIFY_API_KEY;
  if (!APIFY_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing APIFY_API_KEY' }) };

  let query;
  try {
    query = JSON.parse(event.body).query;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  try {
    const encoded = encodeURIComponent(query);
    const chrono24Url = `https://www.chrono24.com/search/index.htm?dosearch=true&query=${encoded}&maxAgeInDays=0`;
    const ACTOR_ID = 'misterkhan~chrono24-search-scraper';

    console.log(`[watch-prices] Starting Apify run for: ${query}`);

    const runResponse = await httpsPost(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_API_KEY}`,
      {
        startUrls: [{ url: chrono24Url }],
        maxItems: 10,
        useApifyProxy: true
      },
      {}
    );

    if (!runResponse.data || !runResponse.data.id) {
      throw new Error('Failed to start Apify run');
    }

    const runId = runResponse.data.id;
    const datasetId = runResponse.data.defaultDatasetId;
    console.log(`[watch-prices] Run started: ${runId}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ runId, datasetId, status: 'RUNNING' })
    };

  } catch (err) {
    console.error('[watch-prices] Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
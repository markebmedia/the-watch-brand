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

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY' }) };

  let query;
  try {
    query = JSON.parse(event.body).query;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!query || query.trim().length < 3) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Query too short' }) };
  }

  try {
    const prompt = `You are a luxury watch market expert based in the UK. A user has searched for: "${query}"

CRITICAL: You MUST express every single price in British Pounds (£ GBP). Never use $ USD. Convert all prices to GBP. Example: £12,500 not $15,000.

Return a JSON object with EXACTLY this structure (no markdown, no explanation, just raw JSON):
{
  "brand": "Brand name",
  "model": "Full model name",
  "reference": "Reference number",
  "marketPrice": "£XX,XXX",
  "priceRange": "£XX,XXX - £XX,XXX",
  "specs": {
    "caseDiameter": "XXmm",
    "caseMaterial": "Material",
    "movement": "Calibre XXXX",
    "powerReserve": "XX hours",
    "waterResistance": "XXXm",
    "yearIntroduced": "XXXX"
  },
  "pricing": {
    "msrp": "£XX,XXX",
    "secondaryAvg": "£XX,XXX",
    "premiumDiscount": "+XX% over retail",
    "trend12m": "+X.X%",
    "liquidity": "High",
    "updated": "Feb 2026",
    "listingsFound": "0"
  },
  "byCondition": {
    "mint": "£XX,XXX",
    "excellent": "£XX,XXX",
    "veryGood": "£XX,XXX",
    "good": "£XX,XXX",
    "fair": "£XX,XXX"
  },
  "investment": {
    "verdict": "Strong Buy",
    "analysis": "2-3 sentences on investment merit, value retention, and market context.",
    "bars": [
      { "label": "Value Retention", "value": 85 },
      { "label": "Market Demand", "value": 90 },
      { "label": "Liquidity", "value": 80 },
      { "label": "Price Stability", "value": 75 }
    ]
  }
}

Use realistic 2025-2026 secondary market data. Express ALL prices in GBP (£). Use UK English spelling throughout. If not found, set brand to "Not Found" and explain in the analysis field.`;

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

    const rawText = (claudeResponse.content || []).map(b => b.text || '').join('');
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const watchData = JSON.parse(cleaned);

    watchData.dataSource = 'ai-estimated';
    watchData.listingsFound = 0;

    return { statusCode: 200, headers, body: JSON.stringify(watchData) };

  } catch (err) {
    console.error('[watch-lookup] Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed', message: err.message }) };
  }
};
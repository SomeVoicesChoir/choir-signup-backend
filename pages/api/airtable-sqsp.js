// api/airtable-sqsp.js
export default async function handler(req, res) {
  // Only allow requests from your domain
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://somevoices.co.uk',
    'https://www.somevoices.co.uk',
    'http://localhost:3000', // for local testing
  ];
  
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Set CORS headers
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get params from query string
  const { baseId, table, view, fields, filterByFormula, maxRecords, offset } = req.query;

  if (!baseId || !table) {
    return res.status(400).json({ error: 'Missing required parameters: baseId and table' });
  }

  // Build Airtable API URL
  const url = new URL(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`);
  if (view) url.searchParams.set('view', view);
  if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
  if (maxRecords) url.searchParams.set('maxRecords', maxRecords);
  if (offset) url.searchParams.set('offset', offset);
  url.searchParams.set('timeZone', 'Europe/London');
  url.searchParams.set('userLocale', 'en-GB');
  
  // Handle fields array (comma-separated string)
  if (fields) {
    const fieldArray = fields.split(',');
    fieldArray.forEach(f => {
      const field = f.trim();
      if (field) url.searchParams.append('fields[]', field);
    });
  }

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY_SQSP}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Airtable Proxy] Error:', response.status, error);
      return res.status(response.status).json({ error: `Airtable error: ${response.status}` });
    }

    const data = await response.json();
    
    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    
    return res.status(200).json(data);
  } catch (error) {
    console.error('[Airtable Proxy] Exception:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

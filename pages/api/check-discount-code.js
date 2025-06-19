import Airtable from 'airtable';

// Airtable config from environment variables
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight support
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body;

  if (!code) return res.status(400).json({ error: 'No code provided' });

  try {
    // Adjust the field name if it's different!
    const cleanedCode = code.trim();

    // Airtable formula for exact match (case-sensitive)
    const formula = `{Discount Code} = "${cleanedCode}"`;

    // Query Airtable
    const records = await base('Discount Codes')
      .select({ filterByFormula: formula, maxRecords: 1 })
      .firstPage();

    if (records.length === 0) {
      return res.status(200).json({ valid: false });
    }
    return res.status(200).json({ valid: true });
  } catch (error) {
    console.error('Airtable error:', error);
    res.status(500).json({ error: 'Lookup failed' });
  }
}

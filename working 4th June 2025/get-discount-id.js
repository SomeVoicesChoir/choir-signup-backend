import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body;

  if (!code) return res.status(400).json({ error: 'No discount code provided' });

  try {
    const cleanedCode = code.trim().toLowerCase();

    const records = await base('Discount Codes')
      .select({
        filterByFormula: `LOWER(TRIM({Discount Code})) = '${cleanedCode}'`,
        maxRecords: 1,
      })
      .firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'Discount code not found' });
    }

    const id = records[0].id;
    res.status(200).json({ id });
  } catch (error) {
    console.error('Airtable lookup error:', error);
    res.status(500).json({ error: 'Failed to look up discount code' });
  }
}

import Airtable from 'airtable';

// Set up Airtable with API key and Base ID from environment variables
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  // ✅ Allow requests from any origin (or change '*' to your Squarespace domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ✅ Respond to CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // Fetch records from the 'Choirs MASTER' table, using the correct view
    const records = await base('Choirs MASTER')
      .select({ view: 'Choir CURRENT (SqSp Signup)' })
      .all();

    // Format the choir records
    const choirs = records.map(record => ({
      id: record.id,
      name: record.get('Name'),
    }));

    // Return the list of choirs
    res.status(200).json({ records: choirs });
  } catch (error) {
    console.error('Airtable fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch choirs' });
  }
}

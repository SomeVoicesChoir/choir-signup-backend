import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  // Add CORS headers to allow requests from any origin (or replace '*' with your Squarespace domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const records = await base('Choirs MASTER')
      .select({ view: 'Choir CURRENT (SqSp Signup)' })
      .all();

    const choirs = records.map(record => ({
      id: record.id,
      name: record.get('Name'),
    }));

    res.status(200).json({ records: choirs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch choirs' });
  }
}

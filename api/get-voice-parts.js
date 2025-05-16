import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const records = await base('Voice Parts')
      .select({ fields: ['Name'], view: 'Grid view' })
      .firstPage();

    const voiceParts = records.map(record => ({
      id: record.id,
      name: record.fields['Name'],
    }));

    res.status(200).json({ voiceParts });
  } catch (error) {
    console.error('Airtable error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

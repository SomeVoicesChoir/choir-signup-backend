import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const records = await base('Members')
      .select({
        filterByFormula: `{Email} = '${email}'`,
        maxRecords: 1,
      })
      .firstPage();

      if (records.length > 0) {
        const record = records[0];
        const fullName = record.fields['Full Name'] || null;
        const firstName = record.fields['First Name'] || null;
        const latestChoir = record.fields['LATEST CHOIR (conc)'] || null;
      
        res.status(200).json({ found: true, fullName, firstName, latestChoir });
      } else {
        res.status(200).json({ found: false });
      }
  } catch (err) {
    console.error('Airtable error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

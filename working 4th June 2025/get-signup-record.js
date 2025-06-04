import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { recordId } = req.query;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });

  try {
    const record = await base('Signup Queue').find(recordId);

    const rawAmount = record.fields['Total Cost Initial Invoice'];
    const rawDescription = record.fields['Initial Payment Description'];

    const amount = Array.isArray(rawAmount) ? Number(rawAmount[0]) : Number(rawAmount);
    const description = Array.isArray(rawDescription) ? rawDescription[0] : rawDescription;

    if (!amount || isNaN(amount)) {
      return res.status(202).json({ ready: false }); // Still calculating
    }

    return res.status(200).json({
      ready: true,
      amount,
      description: description || '',
      email: record.fields['Email'],
      metadata: {
        choir: record.fields['Choir']?.[0] || '',
        voicePart: record.fields['Voice Part'] || '',
        firstName: record.fields['First Name'] || '',
        surname: record.fields['Surname'] || '',
        chartCode: record.fields['Chart of Accounts Code']?.[0] || '',
        chartDescription: record.fields['Chart of Accounts Full Length']?.[0] || ''
      }
    });
  } catch (err) {
    console.error('Airtable fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch record' });
  }
}

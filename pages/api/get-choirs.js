import Airtable from 'airtable';

// Set up Airtable with API key and Base ID from environment variables
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  // ✅ Allow requests from any origin (or restrict to Squarespace domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ✅ Respond to CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // Fetch records from the correct view of the Choirs MASTER table
    const records = await base('Choirs MASTER')
      .select({ view: 'Choir CURRENT (SqSp Signup)' })
      .all();

    // Format and return each choir record with all required fields
    const choirs = records.map(record => {
      // Currency might be an array if it's a lookup field
      let currencyRaw = record.get("Stripe 'default_price_data[currency]'");
      let currency = '';
      if (Array.isArray(currencyRaw)) {
        currency = (currencyRaw[0] || '').toLowerCase();
      } else {
        currency = (currencyRaw || '').toLowerCase();
      }

      return {
        id: record.id,
        name: record.get('Name'),
        priceId: record.get('Stripe PRICE_ID') || null,
        unitAmount: record.get("Stripe 'default_price_data[unit_amount]'") || null,
        chartCode: record.get('Chart of Accounts Code') || null,
        chartFull: record.get('Chart of Accounts Full Length') || null,
        currency: currency || null
      };
    });

    res.status(200).json({ records: choirs });
  } catch (error) {
    console.error('Airtable fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch choirs' });
  }
}

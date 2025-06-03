// pages/api/consolidated-signup.js
import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type } = req.query;

  try {
    switch (type) {
      case 'check-discount-code': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'No code provided' });
        const cleanedCode = code.trim();
        const formula = `{Discount Code} = "${cleanedCode}"`;
        const records = await base('Discount Codes').select({ filterByFormula: formula, maxRecords: 1 }).firstPage();
        return res.status(200).json({ valid: records.length > 0 });
      }

      case 'get-choirs': {
        const records = await base('Choirs MASTER').select({ view: 'Choir CURRENT (SqSp Signup)' }).all();
        const choirs = records.map(record => {
          let currencyRaw = record.get("Stripe 'default_price_data[currency]'");
          let currency = Array.isArray(currencyRaw) ? (currencyRaw[0] || '').toLowerCase() : (currencyRaw || '').toLowerCase();
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
        return res.status(200).json({ records: choirs });
      }

      case 'get-discount-id': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'No discount code provided' });
        const cleanedCode = code.trim().toLowerCase();
        const records = await base('Discount Codes').select({
          filterByFormula: `LOWER(TRIM({Discount Code})) = '${cleanedCode}'`,
          maxRecords: 1
        }).firstPage();
        if (records.length === 0) return res.status(404).json({ error: 'Discount code not found' });
        return res.status(200).json({ id: records[0].id });
      }

      case 'get-signup-record': {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const { recordId } = req.query;
        if (!recordId) return res.status(400).json({ error: 'Missing recordId' });
        const record = await base('Signup Queue').find(recordId);
        const rawAmount = record.fields['Total Cost Initial Invoice'];
        const rawDescription = record.fields['Initial Payment Description'];
        const amount = Array.isArray(rawAmount) ? Number(rawAmount[0]) : Number(rawAmount);
        const description = Array.isArray(rawDescription) ? rawDescription[0] : rawDescription;
        if (!amount || isNaN(amount)) return res.status(202).json({ ready: false });
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
      }

      case 'get-voice-parts': {
        const records = await base('Voice Parts').select({ fields: ['Voice Part'], view: 'Voice Parts' }).firstPage();
        const voiceParts = records.map(record => ({ id: record.id, name: record.fields['Voice Part'] }));
        return res.status(200).json({ voiceParts });
      }

      case 'lookup-email': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const records = await base('Members').select({ filterByFormula: `{Email} = '${email}'`, maxRecords: 1 }).firstPage();
        if (records.length === 0) return res.status(200).json({ found: false });
        const record = records[0];
        const customerLinks = record.fields['*Customer Record'] || [];
        let stripeCustomerId = null, stripeSubscriptionId = null;
        if (customerLinks.length > 0) {
          const customerRecord = await base('Customer Record').find(customerLinks[0]);
          stripeCustomerId = customerRecord.fields['Stripe Customer_ID'] || null;
          stripeSubscriptionId = customerRecord.fields['Stripe Subscription_ID'] || null;
        }
        return res.status(200).json({
          found: true,
          firstName: record.fields['First Name'] || null,
          surname: record.fields['Surname'] || null,
          latestChoir: record.fields['LATEST CHOIR (conc)'] || null,
          voicePart: record.fields['Voice Part'] || null,
          stripeCustomerId,
          stripeSubscriptionId
        });
      }

      default:
        return res.status(400).json({ error: 'Invalid type parameter' });
    }
  } catch (err) {
    console.error('Airtable error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

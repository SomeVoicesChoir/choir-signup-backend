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

  const {
    email,
    firstName,
    surname,
    choir,
    voicePart,
    chartCode,
    chartDescription,
    discountCode,
    stripeCustomerId,
    stripeSubscriptionId,
    billingAnchor
  } = req.body;

  try {
    const record = await base('Signup Queue').create({
      'Email': email,
      'First Name': firstName,
      'Surname': surname,
      'Choir': choir,
      'Voice Part': voicePart,
      'Chart Code': chartCode,
      'Chart Description': chartDescription,
      'Discount Code': discountCode || '',
      'Stripe Customer_ID': stripeCustomerId || '',
      'Stripe Subscription_ID': stripeSubscriptionId || '',
      'Billing Anchor': billingAnchor || '',
      'Status': 'Pending'
    });

    res.status(200).json({ success: true, recordId: record.id });
  } catch (error) {
    console.error('Airtable error:', error);
    res.status(500).json({ error: 'Failed to create Airtable record' });
  }
}

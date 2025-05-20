import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    firstName,
    surname,
    email,
    choir,
    voicePart,
    billingAnchor,
    stripeCustomerId,
    stripeSubscriptionId,
    discountCode
  } = req.body;

  try {
    const airtableRecord = await base('Signup Queue').create({
      'First Name': firstName || '',
      'Surname': surname || '',
      'Email': email || '',
      'Choir': choir ? [choir] : undefined, // record ID array
      'Voice Part': voicePart || '',
      'Billing Anchor': billingAnchor || '',
      'Stripe Customer ID': stripeCustomerId || '',
      'Stripe Subscription ID': stripeSubscriptionId || '',
      'Discount Code': discountCode && discountCode.length > 0 ? discountCode : undefined // record ID array
    });

    res.status(200).json({ success: true, recordId: airtableRecord.id });
  } catch (error) {
    console.error('Airtable error:', error);
    res.status(500).json({ error: 'Failed to create record in Airtable' });
  }
}

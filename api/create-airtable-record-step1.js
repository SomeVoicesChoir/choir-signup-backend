import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Helper function to look up Discount Code record ID by code string
async function getDiscountCodeRecordId(code) {
  if (!code) return null;
  const records = await base('Discount Codes').select({
    filterByFormula: `{Code} = "${code}"`,
    maxRecords: 1
  }).firstPage();

  return records && records.length > 0 ? records[0].id : null;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight request
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    firstName,
    surname,
    email,
    choir,
    voicePart,
    billingAnchor,
    stripeCustomerId,
    stripeSubscriptionId,
    discountCodeString,     // <-- Now expecting this from frontend
    existingMemberRecordId
  } = req.body;

  try {
    // If discountCodeString provided, look up its Airtable record ID
    let discountCodeRecordId = undefined;
    if (discountCodeString && discountCodeString.length > 0) {
      discountCodeRecordId = await getDiscountCodeRecordId(discountCodeString.trim());
      if (!discountCodeRecordId) {
        return res.status(400).json({ error: 'Discount Code Not Valid' });
      }
    }

    const airtableRecord = await base('Signup Queue').create({
      'First Name': firstName || '',
      'Surname': surname || '',
      'Email': email || '',
      'Choir': choir ? [choir] : undefined,
      'Voice Part': voicePart || '',
      'Billing Anchor': billingAnchor || '',
      'Stripe Customer ID': stripeCustomerId || '',
      'Stripe Subscription ID': stripeSubscriptionId || '',
      'Discount Code': discountCodeRecordId ? [discountCodeRecordId] : undefined, // Correct linked record
      'Existing Member Record ID': existingMemberRecordId || ''
    });

    res.status(200).json({ success: true, recordId: airtableRecord.id });
  } catch (error) {
    console.error('Airtable error:', error);
    res.status(500).json({ error: 'Failed to create record in Airtable' });
  }
}

// create-airtable-record-step1.js
import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Helper: Lookup Discount Code record ID by code string in Discount Codes table
async function getDiscountCodeRecordId(codeString) {
  if (!codeString) return null;
  const safeCode = codeString.replace(/'/g, "\\'");
  const filter = `LOWER({Discount Code}) = '${safeCode.toLowerCase()}'`;
  const records = await base('Discount Codes').select({
    filterByFormula: filter,
    maxRecords: 1,
  }).firstPage();
  return records.length > 0 ? records[0].id : null;
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
    discountCodeString, // User input as code, not record ID!
    existingMemberRecordId,
  } = req.body;

  try {
    // Lookup Discount Code record ID if provided
    let discountCodeRecordId = undefined;
    if (discountCodeString && discountCodeString.trim().length > 0) {
      discountCodeRecordId = await getDiscountCodeRecordId(discountCodeString.trim());
      if (!discountCodeRecordId) {
        return res.status(400).json({ error: 'Discount Code Not Valid' });
      }
    }

    // Create Signup Queue record, linking Discount Code if found
    const airtableRecord = await base('Signup Queue').create({
      'First Name': firstName || '',
      'Surname': surname || '',
      'Email': email || '',
      'Choir': choir ? [choir] : undefined,
      'Voice Part': voicePart || '',
      'Billing Anchor': billingAnchor || '',
      'Stripe Customer ID': stripeCustomerId || '',
      'Stripe Subscription ID': stripeSubscriptionId || '',
      'Discount Code': discountCodeRecordId ? [discountCodeRecordId] : undefined,
      'Existing Member Record ID': existingMemberRecordId || ''
    });

    res.status(200).json({ success: true, recordId: airtableRecord.id });
  } catch (error) {
    console.error('Airtable error:', error);
    res.status(500).json({ error: 'Failed to create record in Airtable' });
  }
}

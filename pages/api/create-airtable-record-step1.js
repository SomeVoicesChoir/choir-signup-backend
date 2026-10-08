// create-airtable-record-step1.js
import Airtable from 'airtable';
import { resolveDiscountCode } from '../../lib/discountCodes.js';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

/**
 * Look up the Airtable `Discount Codes` row for a code, if one exists.
 *
 * ⚠️ NO LONGER THE GATE. Stripe decides whether a code is valid (see
 * lib/discountCodes.js); this is only here to keep the {Discount Code} LINK on
 * the Signup Queue row populated, because {Percentage Off (from Discount Code)}
 * hangs off it and sv-app's signup audit reports that column.
 *
 * So a missing row is now fine and is NOT an error: most live Stripe codes have
 * never had one. Returning null just means the audit shows no discount for that
 * signup, which is a reporting gap rather than a broken checkout.
 */
async function getDiscountCodeRecordId(codeString) {
  if (!codeString) return null;
  try {
    const safeCode = codeString.replace(/'/g, "\\'");
    const filter = `LOWER({Discount Code}) = '${safeCode.toLowerCase()}'`;
    const records = await base('Discount Codes').select({
      filterByFormula: filter,
      maxRecords: 1,
    }).firstPage();
    return records.length > 0 ? records[0].id : null;
  } catch (err) {
    // Never let a reporting nicety block a signup.
    console.error('Discount Codes link lookup failed (continuing):', err.message);
    return null;
  }
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
    discountCode, // <-- field from frontend
    existingMemberRecordId,
  } = req.body;

  try {
    // ── Validate against STRIPE, which is where the discount actually lives.
    // Previously this gated on an Airtable row existing, which rejected 119
    // live Stripe codes outright and waved through 2 that did nothing.
    let discountCodeRecordId = undefined;
    if (discountCode && discountCode.trim().length > 0) {
      const resolved = await resolveDiscountCode(discountCode.trim());
      if (!resolved.ok) {
        return res.status(400).json({
          error: resolved.message || 'Discount Code Not Valid',
          reason: resolved.reason,
        });
      }
      // Best-effort link for reporting only — never a gate.
      discountCodeRecordId = await getDiscountCodeRecordId(discountCode.trim());
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

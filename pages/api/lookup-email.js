import Airtable from 'airtable';
import Stripe from 'stripe';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Subscription statuses that count as "this person is still a member."
// Used to warn customers who try to sign up again while already subscribed.
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

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
    // 1. Airtable Members lookup (existing behaviour)
    // Case- and whitespace-insensitive — matches the pattern used in other endpoints.
    const escapedEmail = email.replace(/'/g, "\\'"); // escape single quotes in formula
    const records = await base('Members')
      .select({
        filterByFormula: `LOWER(TRIM({Email})) = LOWER(TRIM('${escapedEmail}'))`,
        maxRecords: 1,
      })
      .firstPage();

    let memberFields = {
      found: false,
      firstName: null,
      surname: null,
      latestChoir: null,
      voicePart: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };

    if (records.length > 0) {
      const record = records[0];
      memberFields.found = true;
      memberFields.firstName = record.fields['First Name'] || null;
      memberFields.surname = record.fields['Surname'] || null;
      memberFields.latestChoir = record.fields['LATEST CHOIR (conc)'] || null;
      memberFields.voicePart = record.fields['Voice Part'] || null;

      const customerLinks = record.fields['*Customer Record'] || [];
      if (customerLinks.length > 0) {
        const customerRecordId = customerLinks[0];
        const customerRecord = await base('Customer Record').find(customerRecordId);
        memberFields.stripeCustomerId = customerRecord.fields['Stripe Customer_ID'] || null;
        memberFields.stripeSubscriptionId = customerRecord.fields['Stripe Subscription_ID'] || null;
      }
    }

    // 2. Stripe direct check — list active subscriptions for this email.
    // Source of truth (Airtable may be stale or out of sync).
    const activeSubscriptions = [];
    try {
      const customers = await stripe.customers.list({ email, limit: 10 });
      for (const customer of customers.data) {
        const subs = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'all',
          limit: 20,
        });
        for (const sub of subs.data) {
          if (!ACTIVE_STATUSES.includes(sub.status)) continue;
          const periodEnd = sub.current_period_end
            ? new Date(sub.current_period_end * 1000)
            : null;
          activeSubscriptions.push({
            id: sub.id,
            status: sub.status,
            customerId: customer.id,
            choirName: sub.metadata?.choirName || sub.metadata?.choir || null,
            currentPeriodEnd: sub.current_period_end || null,
            currentPeriodEndReadable: periodEnd
              ? periodEnd.toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })
              : null,
            trialEnd: sub.trial_end || null,
          });
        }
      }
    } catch (stripeErr) {
      // Non-fatal — return Airtable info even if Stripe is unreachable.
      // Logged so we can investigate if customers slip through the warning.
      console.error('Stripe subscription lookup failed (non-fatal):', stripeErr.message);
    }

    res.status(200).json({
      ...memberFields,
      activeSubscriptions,
    });

  } catch (err) {
    console.error('Lookup error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

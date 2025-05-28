import Stripe from 'stripe';
import Airtable from 'airtable';

// Disable Vercel's default body parsing for this API route!
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Helper: Read raw buffer for signature validation
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Helper: Get next 1st or 15th
function getNextAnchorDate(anchorDay) {
  const now = new Date();
  let next;
  if (anchorDay === 15) {
    next = now.getDate() >= 15
      ? new Date(now.getFullYear(), now.getMonth() + 1, 15)
      : new Date(now.getFullYear(), now.getMonth(), 15);
  } else {
    // Default to 1st of next month
    next = now.getDate() >= 1
      ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
      : new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return next;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // 1. Get raw body and signature
  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET // Set in Stripe Dashboard!
    );
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. Handle only successful one-off payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Only if initial payment (not subscription mode)
    if (session.mode === 'payment') {
      const recordId = session.metadata?.recordId;
      if (!recordId) return res.status(200).send('No recordId');

      // Fetch record from Airtable
      let record;
      try {
        record = await base('Signup Queue').find(recordId);
      } catch (err) {
        console.error('Airtable lookup error:', err);
        return res.status(500).send('Airtable lookup error');
      }

      // Collect info for subscription
      const priceId = record.fields['Stripe PRICE_ID'];
      const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || undefined;
      const billingAnchor = Number(record.fields['Billing Anchor']) || 1;
      const chartCode = (record.fields['Chart of Accounts Code'] || [])[0] || '';
      const chartDescription = (record.fields['Chart of Accounts Full Length'] || [])[0] || '';

      // Calculate anchor date (1st or 15th)
      const anchorDate = getNextAnchorDate(billingAnchor);
      const anchorUnix = Math.floor(anchorDate.getTime() / 1000);

      // 3. Create the Stripe subscription
      try {
        await stripe.subscriptions.create({
          customer: session.customer, // This is the customer ID from the initial payment
          items: [{ price: Array.isArray(priceId) ? priceId[0] : priceId }],
          billing_cycle_anchor: anchorUnix,
          coupon: couponId,
          metadata: {
            airtable_record_id: recordId,
            choir: record.fields['Choir']?.[0] || '',
            chartCode,
            chartDescription
          },
        });

        // Optionally update Airtable to confirm
        await base('Signup Queue').update(recordId, {
          'Subscription Status': 'Active', // Or your chosen status
        });

        console.log(`Subscription created for customer: ${session.customer}`);
        return res.status(200).send('Subscription created');
      } catch (err) {
        console.error('Stripe subscription error:', err);
        return res.status(500).send('Failed to create subscription');
      }
    }
  }

  // Return for other events
  res.status(200).send('Event received');
}

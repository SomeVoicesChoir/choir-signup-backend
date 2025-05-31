// pages/api/create-subscription.js
import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recordId } = req.body;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });

  try {
    // Fetch record from Airtable
    const record = await base('Signup Queue').find(recordId);
    const stripeCustomerId = record.fields['Stripe Customer ID'];
    const rawPriceId = record.fields['Stripe PRICE_ID'];
    let priceId = '';
    if (typeof rawPriceId === 'string') {
      priceId = rawPriceId;
    } else if (Array.isArray(rawPriceId)) {
      priceId = rawPriceId[0];
    }
    if (!stripeCustomerId || !priceId) {
      return res.status(400).json({ error: 'Missing Stripe Customer ID or Price ID.' });
    }

    // Coupon (optional)
    const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || null;

    // Build subscription params
    let params = {
      customer: stripeCustomerId,
      items: [{ price: priceId }],
      metadata: {
        recordId,
        choir: record.fields['Choir']?.[0] || '',
        voicePart: record.fields['Voice Part'] || '',
        firstName: record.fields['First Name'] || '',
        surname: record.fields['Surname'] || '',
      }
    };

    if (couponId) {
      params.discounts = [{ coupon: couponId }];
    }

    // Create the subscription
    const subscription = await stripe.subscriptions.create(params);

    // Optionally: store the subscription ID in Airtable
    await base('Signup Queue').update(recordId, {
      'Stripe Subscription ID': subscription.id,
    });

    res.status(200).json({ success: true, subscriptionId: subscription.id });
  } catch (error) {
    console.error('Stripe subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
}

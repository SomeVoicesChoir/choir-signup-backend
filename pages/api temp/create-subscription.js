// /api/create-subscription.js
import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recordId } = req.body;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });

  try {
    const record = await base('Signup Queue').find(recordId);
    const email = record.fields['Email'];
    const firstName = record.fields['First Name'] || '';
    const surname = record.fields['Surname'] || '';
    const rawPriceId = record.fields['Stripe PRICE_ID'];
    let priceId = '';
    if (typeof rawPriceId === 'string') {
      priceId = rawPriceId;
    } else if (Array.isArray(rawPriceId)) {
      priceId = rawPriceId[0];
    }
    if (!priceId) return res.status(400).json({ error: 'Missing Price ID.' });

    let customerId = record.fields['Stripe Customer ID'];

    // Create customer if missing
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name: `${firstName} ${surname}`,
        metadata: {
          choir: record.fields['Choir']?.[0] || '',
          chartCode: record.fields['Chart of Accounts Code']?.[0] || '',
          chartDescription: record.fields['Chart of Accounts Full Length']?.[0] || '',
          airtableRecordId: record.id
        }
      });
      customerId = customer.id;
      await base('Signup Queue').update(recordId, { 'Stripe Customer ID': customerId });
    }

    const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || undefined;
    const billingAnchor = Number(record.fields['Billing Anchor'] || 1);
    const today = new Date();
    const trialEndDate = new Date(today.getFullYear(), today.getMonth() + (today.getDate() >= billingAnchor ? 1 : 0), billingAnchor);
    const trialEndUnix = Math.floor(trialEndDate.getTime() / 1000);

    const metadata = {
      recordId,
      choir: record.fields['Choir']?.[0] || '',
      voicePart: record.fields['Voice Part'] || '',
      firstName,
      surname,
      chartCode: record.fields['Chart of Accounts Code']?.[0] || '',
      chartDescription: record.fields['Chart of Accounts Full Length']?.[0] || '',
      airtableRecordId: record.id
    };

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      trial_end: trialEndUnix,
      coupon: couponId,
      metadata
    });

    await base('Signup Queue').update(recordId, {
      'Stripe Subscription ID': subscription.id,
      'Subscription Status': 'Active'
    });

    res.status(200).json({ success: true, subscriptionId: subscription.id });
  } catch (error) {
    console.error('Stripe subscription error:', error);
    res.status(500).json({ error: error.message });
  }
}

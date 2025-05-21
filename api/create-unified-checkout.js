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
    const record = await base('Signup Queue').find(recordId);

    const email = record.fields['Email'];
    const customerId = record.fields['Stripe Customer ID'] || undefined;
    const priceId = record.fields['Stripe PRICE_ID'];
    const billingAnchor = record.fields['Billing Anchor'] === '15' ? 15 : 1;
    const discountCode = record.fields['Discount Code']?.[0]; // linked record ID
    const metadata = {
      choir: record.fields['Choir']?.[0] || '',
      voicePart: record.fields['Voice Part'] || '',
      firstName: record.fields['First Name'] || '',
      surname: record.fields['Surname'] || '',
      chartCode: record.fields['Chart of Accounts Code']?.[0] || '',
      chartDescription: record.fields['Chart of Accounts Full Length']?.[0] || ''
    };

    // Build the subscription data
    const subscriptionData = {
      items: [{ price: priceId }],
      billing_cycle_anchor: Math.floor(new Date(new Date().getFullYear(), new Date().getMonth() + 1, billingAnchor).getTime() / 1000),
      metadata
    };

    // Apply coupon if Discount Code exists
    if (discountCode) {
      const couponRecord = await base('Discount Codes').find(discountCode);
      const stripeCouponId = couponRecord.fields['Stripe Coupon ID'];
      if (stripeCouponId) {
        subscriptionData.discounts = [{ coupon: stripeCouponId }];
      }
    }

    // Create session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card', 'ideal', 'sepa_debit'],
      customer: customerId,
      customer_email: customerId ? undefined : email,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: subscriptionData,
      metadata,
      success_url: 'https://somevoices.co.uk/success',
      cancel_url: 'https://somevoices.co.uk/cancelled'
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err);
    return res.status(500).json({ error: 'Failed to create unified checkout session' });
  }
}

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
    // 1. Load Airtable record
    const record = await base('Signup Queue').find(recordId);

    // Stripe Customer ID logic
    const email = record.fields['Email'];
    const customerId = record.fields['Stripe Customer ID'] || null;

    // Get recurring priceId (subscription)
    const rawPriceId = record.fields['Stripe PRICE_ID'];
    let priceId = '';
    if (typeof rawPriceId === 'string') {
      priceId = rawPriceId;
    } else if (Array.isArray(rawPriceId)) {
      priceId = rawPriceId[0];
    } else if (rawPriceId && typeof rawPriceId === 'object') {
      const values = Object.values(rawPriceId);
      if (values.length && typeof values[0] === 'string') {
        priceId = values[0];
      }
    }
    if (!priceId || typeof priceId !== 'string') {
      return res.status(400).json({ error: 'Invalid Stripe PRICE_ID format' });
    }

    // Get one-off initial payment amount (pro-rata)
    const initialAmount = Number(record.fields['Month 1 Initial Cost (from Choir)'] || 0);
    const initialDesc = record.fields['Initial Payment Description'] || 'Some Voices – Initial Pro-Rata Payment';

    // Subscription meta
    const chartCode = (record.fields['Chart of Accounts Code'] || [])[0] || '';
    const chartDescription = (record.fields['Chart of Accounts Full Length'] || [])[0] || '';
    const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || null;

    const metadata = {
      choir: record.fields['Choir']?.[0] || '',
      voicePart: record.fields['Voice Part'] || '',
      firstName: record.fields['First Name'] || '',
      surname: record.fields['Surname'] || '',
      chartCode,
      chartDescription
    };

    let payment_method_types = ['card'];
    let discounts = couponId ? [{ coupon: couponId }] : undefined;

    let line_items = [
      {
        price_data: {
          currency: 'gbp',
          unit_amount: initialAmount,
          product_data: {
            name: initialDesc
          }
        },
        quantity: 1
      },
      {
        price: priceId,
        quantity: 1
      }
    ];

    // --- CREATE STRIPE CHECKOUT SESSION ---
    const payload = {
      mode: 'subscription',
      payment_method_types,
      line_items,
      subscription_data: {
        metadata,
        discounts
      },
      metadata: {
        recordId,
        chartCode,
        chartDescription
      },
      customer: customerId || undefined,              // Key improvement!
      customer_email: customerId ? undefined : email,  // Only set if NOT using customerId
      success_url: 'https://somevoices.co.uk/success',
      cancel_url: 'https://somevoices.co.uk/cancelled'
    };

    console.log('Creating Stripe Checkout session with payload:', payload);

    const session = await stripe.checkout.sessions.create(payload);

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe session creation error:', error);
    res.status(500).json({ error: 'Failed to create unified checkout session' });
  }
}

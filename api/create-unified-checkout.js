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

  const { recordId, discountCodeRaw } = req.body;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });

  try {
    const record = await base('Signup Queue').find(recordId);

    const email = record.fields['Email'];
    const rawPriceId = record.fields['Stripe PRICE_ID'];

    // Clean Stripe PRICE_ID
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

    const amount = Number((record.fields['Total Cost Initial Invoice'] || [])[0] || 0);
    const chartCode = (record.fields['Chart of Accounts Code'] || [])[0] || '';
    const chartDescription = (record.fields['Chart of Accounts Full Length'] || [])[0] || '';
    const description = (record.fields['Initial Payment Description'] || [])[0] || 'Some Voices – Initial Payment';
    const customerId = record.fields['Stripe Customer ID'] || null;
    const billingAnchor = Number(record.fields['Billing Anchor'] || 1);

    // Trial end date logic (next 1st or 15th)
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    const nowDay = today.getDate();

    let trialEndDate;
    if (billingAnchor === 1 && nowDay >= 15) {
      trialEndDate = new Date(currentYear, currentMonth + 1, 1);
    } else if (billingAnchor === 15 && nowDay >= 1) {
      trialEndDate = new Date(currentYear, currentMonth + 1, 15);
    } else {
      trialEndDate = new Date(currentYear, currentMonth, billingAnchor);
    }
    const trialEndUnix = Math.floor(trialEndDate.getTime() / 1000);

    // Match discount code to a Stripe coupon by name
    let couponId = null;
    if (discountCodeRaw) {
      const coupons = await stripe.coupons.list({ limit: 100 });
      const match = coupons.data.find(c => c.name?.toLowerCase() === discountCodeRaw.trim().toLowerCase());
      if (match) {
        couponId = match.id;
        console.log('Matched discount code to coupon:', couponId);
      } else {
        console.warn('No matching coupon found for code:', discountCodeRaw);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId || undefined,
      customer_email: customerId ? undefined : email,
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: amount,
            product_data: {
              name: description
            }
          },
          quantity: 1
        },
        {
          price: priceId,
          quantity: 1
        }
      ],
      subscription_data: {
        trial_end: trialEndUnix,
        metadata: {
          choir: record.fields['Choir']?.[0] || '',
          voicePart: record.fields['Voice Part'] || '',
          firstName: record.fields['First Name'] || '',
          surname: record.fields['Surname'] || '',
          chartCode,
          chartDescription
        }
      },
      metadata: {
        recordId,
        chartCode,
        chartDescription
      },
      discounts: couponId ? [{ coupon: couponId }] : undefined,
      success_url: 'https://somevoices.co.uk/success',
      cancel_url: 'https://somevoices.co.uk/cancelled'
    });

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe session creation error:', error);
    res.status(500).json({ error: 'Failed to create unified checkout session' });
  }
}

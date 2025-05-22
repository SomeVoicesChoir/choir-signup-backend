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
    const rawPriceId = record.fields['Stripe PRICE_ID'];

    // Clean up Stripe price ID for subscription
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

    // Currency and field handling
    const currencyField = record.fields["Stripe 'default_price_data[currency]'"] || 'gbp';
    const currency = typeof currencyField === 'string'
      ? currencyField.toLowerCase()
      : Array.isArray(currencyField)
        ? currencyField[0].toLowerCase()
        : 'gbp';

    // Pro-rata amount for one-off charge
    const amount = Number((record.fields['Total Cost Initial Invoice'] || [])[0] || 0);
    const description = (record.fields['Initial Payment Description'] || [])[0] || 'Some Voices – Initial Payment';

    // Coupon (must be a Stripe Coupon ID)
    const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || null;

    const customerId = record.fields['Stripe Customer ID'] || null;
    const chartCode = (record.fields['Chart of Accounts Code'] || [])[0] || '';
    const chartDescription = (record.fields['Chart of Accounts Full Length'] || [])[0] || '';
    const billingAnchor = Number(record.fields['Billing Anchor'] || 1);

    // Calculate trial_end (next 1st or 15th)
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

    // Build line_items array based on currency
    let line_items = [];
    if (currency === 'gbp') {
      // Card flow: add one-off pro-rata and subscription
      if (amount > 0) {
        line_items.push({
          price_data: {
            currency: 'gbp',
            unit_amount: amount,
            product_data: {
              name: description
            }
          },
          quantity: 1
        });
      }
      line_items.push({
        price: priceId,
        quantity: 1
      });
    } else if (currency === 'eur') {
      // EUR (SEPA/iDEAL): only recurring, no one-off allowed
      line_items = [
        {
          price: priceId,
          quantity: 1
        }
      ];
    } else {
      // Fallback: treat as GBP/card
      if (amount > 0) {
        line_items.push({
          price_data: {
            currency: currency,
            unit_amount: amount,
            product_data: {
              name: description
            }
          },
          quantity: 1
        });
      }
      line_items.push({
        price: priceId,
        quantity: 1
      });
    }

    // Payment method types
    let payment_method_types = ['card'];
    if (currency === 'eur') {
      payment_method_types = ['card', 'ideal', 'sepa_debit'];
    }

    // Discounts only apply to the subscription part
    let discounts = undefined;
    if (couponId) {
      discounts = [{ coupon: couponId }];
    }

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId || undefined,
      customer_email: customerId ? undefined : email,
      payment_method_types,
      line_items,
      subscription_data: {
        metadata: {
          choir: record.fields['Choir']?.[0] || '',
          voicePart: record.fields['Voice Part'] || '',
          firstName: record.fields['First Name'] || '',
          surname: record.fields['Surname'] || '',
          chartCode,
          chartDescription
        },
        discounts,
      },
      metadata: {
        recordId,
        chartCode,
        chartDescription
      },
      success_url: 'https://somevoices.co.uk/success',
      cancel_url: 'https://somevoices.co.uk/cancelled'
    });

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe session creation error:', error);
    res.status(500).json({ error: 'Failed to create unified checkout session' });
  }
}

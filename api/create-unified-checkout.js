import Stripe from 'stripe';
import Airtable from 'airtable';
import dayjs from 'dayjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

function calculateTrialEnd(billingAnchor) {
  const today = dayjs();
  const nextMonth = today.add(1, 'month');
  const targetDay = parseInt(billingAnchor, 10);
  const trialDate = nextMonth.date(targetDay).hour(0).minute(0).second(0);
  return Math.floor(trialDate.valueOf() / 1000); // UNIX timestamp
}

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
    const priceId = record.fields['Stripe PRICE_ID'];
    const unitAmount = record.fields['Total Cost Initial Invoice'];
    const description = (record.fields['Initial Payment Description'] || 'Initial Membership Fee').toString();
    const billingAnchor = record.fields['Billing Anchor'];
    const discountId = (record.fields['Discount Code'] || [])[0];

    const metadata = {
      choir: record.fields['Choir']?.[0] || '',
      voicePart: record.fields['Voice Part'] || '',
      firstName: record.fields['First Name'] || '',
      surname: record.fields['Surname'] || '',
      chartCode: (record.fields['Chart of Accounts Code'] || [])[0] || '',
      chartDescription: (record.fields['Chart of Accounts Full Length'] || [])[0] || '',
      existingMemberId: record.fields['Existing Member Record ID'] || ''
    };

    const trialEnd = calculateTrialEnd(billingAnchor);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card', 'ideal', 'sepa_debit'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: parseInt(unitAmount),
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
        trial_end: trialEnd,
        metadata,
        ...(discountId && { discounts: [{ coupon: discountId }] })
      },
      metadata,
      success_url: 'https://somevoices.co.uk/success',
      cancel_url: 'https://somevoices.co.uk/cancelled'
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe Checkout creation error:', err);
    res.status(500).json({ error: 'Failed to create unified Stripe Checkout session' });
  }
}

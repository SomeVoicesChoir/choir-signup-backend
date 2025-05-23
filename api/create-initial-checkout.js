// create-initial-checkout.js
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

    // Always fetch the amount from Airtable!
    const amount = Number(record.fields['Total Cost Initial Invoice'] || 0);
    console.log('Initial payment amount:', amount);

    // Dynamically determine currency (default gbp)
    const currencyField = record.fields["Stripe 'default_price_data[currency]'"] || 'gbp';
    const currency = typeof currencyField === 'string'
      ? currencyField.toLowerCase()
      : Array.isArray(currencyField)
        ? currencyField[0].toLowerCase()
        : 'gbp';

    const description = record.fields['Initial Payment Description'] || 'Some Voices – Initial Pro-Rata Payment';

    // Try to get an existing Stripe Customer ID from the record, fallback to email
    const customerId = record.fields['Stripe Customer ID'] || null;

    const metadata = {
      choir: record.fields['Choir']?.[0] || '',
      voicePart: record.fields['Voice Part'] || '',
      firstName: record.fields['First Name'] || '',
      surname: record.fields['Surname'] || '',
      chartCode: (record.fields['Chart of Accounts Code'] || [])[0] || '',
      chartDescription: (record.fields['Chart of Accounts Full Length'] || [])[0] || ''
    };

    // Support multiple payment methods if EUR
    let payment_method_types = ['card'];
    if (currency === 'eur') {
      payment_method_types = ['card', 'ideal', 'sepa_debit'];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types,
      // If you have a Stripe Customer ID, use it; otherwise use customer_email (Stripe will create a new customer if needed)
      customer: customerId || undefined,
      customer_email: customerId ? undefined : email,
      line_items: [
        {
          price_data: {
            currency: currency,
            unit_amount: amount,
            product_data: {
              name: description
            }
          },
          quantity: 1
        }
      ],
      metadata,
      success_url: 'https://somevoices.co.uk/success-initial?recordId={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://somevoices.co.uk/cancelled'
    });

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

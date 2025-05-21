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

  const { recordId, amount } = req.body;

  if (!recordId || !amount) {
    return res.status(400).json({ error: 'Missing recordId or amount' });
  }

  try {
    // Fetch the Airtable record using the recordId
    const record = await base('Signup Queue').find(recordId);

    const email = record.get('Email');
    const metadata = {
        choir: String(record.get('Choir')?.[0] || ''),
        voicePart: String(record.get('Voice Part') || ''),
        firstName: String(record.get('First Name') || ''),
        surname: String(record.get('Surname') || ''),
        chartCode: String(
          Array.isArray(record.get('Chart of Accounts Code'))
            ? record.get('Chart of Accounts Code')[0]
            : record.get('Chart of Accounts Code') || ''
        ),
        chartDescription: String(
          Array.isArray(record.get('Chart of Accounts Full Length'))
            ? record.get('Chart of Accounts Full Length')[0]
            : record.get('Chart of Accounts Full Length') || ''
        )
      };

    if (!email) {
      return res.status(400).json({ error: 'Email not found in Airtable record' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: Number(amount), // already in pence
            product_data: {
              name: 'Some Voices – Initial Pro-Rata Payment'
            }
          },
          quantity: 1
        }
      ],
      metadata,
      success_url: 'https://somevoices.co.uk/success',
      cancel_url: 'https://somevoices.co.uk/cancelled'
    });

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

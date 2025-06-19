import Airtable from 'airtable';
import Stripe from 'stripe';
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, firstName, surname, choir, voicePart, billingAnchor, discountCode, stripeCustomerId } = req.body;
  if (!email || !choir) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const record = await base('Signup Queue').create({
      'Email': email,
      'First Name': firstName,
      'Surname': surname,
      'Choir': [choir],
      'Voice Part': voicePart,
      'Billing Anchor': billingAnchor,
      'Discount Code': discountCode,
      'Stripe Customer ID': stripeCustomerId
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer: stripeCustomerId || undefined,
      customer_email: stripeCustomerId ? undefined : email,
      line_items: [{ price_data: { currency: 'gbp', unit_amount: 100, product_data: { name: 'Some Voices Initial Payment' } }, quantity: 1 }],
      success_url: `https://somevoices.co.uk/success-initial?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: 'https://somevoices.co.uk/cancelled'
    });

    return res.status(200).json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

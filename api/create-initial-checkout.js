import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, amount, metadata } = req.body;

  if (!email || !amount) {
    return res.status(400).json({ error: 'Missing email or amount' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: Math.round(parseFloat(amount) * 100), // convert to pence
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

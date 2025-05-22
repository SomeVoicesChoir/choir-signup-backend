import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    priceId,
    email,
    customerId,
    metadata,
    discountCode,
    currency = 'gbp',
    paymentMethod = 'card'  // e.g. 'card', 'ideal', 'sepa_debit'
  } = req.body;

  try {
    let promotionCodeId = null;

    // Lookup Stripe Promotion Code if discountCode is provided
    if (discountCode) {
      const promoList = await stripe.promotionCodes.list({
        code: discountCode,
        active: true,
        limit: 1
      });
      if (promoList.data.length > 0) {
        promotionCodeId = promoList.data[0].id;
      } else {
        console.warn(`Discount code "${discountCode}" not found or inactive.`);
      }
    }

    // Dynamically set allowed payment methods based on currency
    let payment_method_types = ['card'];
    if (currency.toLowerCase() === 'eur') {
      payment_method_types = ['card', 'ideal', 'sepa_debit'];
    }

    // Stripe Checkout session for a subscription
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata,
      customer: customerId || undefined,
      customer_email: customerId ? undefined : email,
      discounts: promotionCodeId ? [{ promotion_code: promotionCodeId }] : undefined,
      success_url: 'https://somevoices.co.uk/success',
      cancel_url: 'https://somevoices.co.uk/cancelled',
    });

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: 'Unable to create checkout session' });
  }
}

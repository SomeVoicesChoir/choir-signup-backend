import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Change from req.body to req.query since this is a GET request
  const { session_id, recordId, priceId, discountCode, customer } = req.query;

  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  if (!priceId) return res.status(400).json({ error: 'Missing priceId' });

  try {
    // 1. Retrieve the checkout session
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['payment_intent', 'customer']
    });

    // 2. Verify payment status
    if (session.payment_status !== 'paid') {
      return res.status(400).json({
        error: 'Payment not completed',
        status: session.payment_status
      });
    }

    const customerId = session.customer.id;
    const paymentMethodId = session.payment_intent.payment_method;

    // 3. Set default payment method for future payments
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId
      }
    });

    // 4. Create subscription with immediate charging
    let subscriptionData = {
      customer: customerId,
      items: [{ price: priceId }],
      default_payment_method: paymentMethodId,  // Use the payment method from initial payment
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription'
      },
      metadata: {
        ...session.metadata,
        recordId: recordId || '',
        discountCode: discountCode || ''
      },
      expand: ['latest_invoice.payment_intent']
    };

    // Add discount if provided
    if (discountCode) {
      const coupon = await stripe.coupons.retrieve(discountCode);
      if (coupon) {
        subscriptionData.coupon = discountCode;
      }
    }

    console.log('Creating subscription with data:', subscriptionData);
    
    const subscription = await stripe.subscriptions.create(subscriptionData);

    const session_url = `https://somevoices.co.uk/successed`;

    res.redirect(302, `https://somevoices.co.uk/successed?` + 
      `subscriptionId=${subscription.id}&` +
      `status=${subscription.status}`
    );

  } catch (error) {
    console.error('Success Initial Error:', {
      message: error.message,
      stack: error.stack,
      sessionId: session_id
    });
    res.redirect(302, `https://somevoices.co.uk/cancelled?error=${encodeURIComponent(error.message)}`);
  }
}
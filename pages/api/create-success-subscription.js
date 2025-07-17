import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

function getBillingAnchorTimestamp(billing_date) {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const currentDay = now.getDate();
  
  // Parse billing_date (expecting format like "1st" or "15th" or just "1" or "15")
  const dayOfMonth = parseInt(billing_date.replace(/\D/g, ''));
  let billingDate;
  // if the billing date is passed then change the month
  if (currentDay > dayOfMonth || currentDay === dayOfMonth) {
      billingDate = new Date(currentYear, currentMonth + 1, dayOfMonth);
  }else {
      billingDate = new Date(currentYear, currentMonth, dayOfMonth);
  }
  return Math.floor(billingDate.getTime() / 1000);
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Change from req.body to req.query since this is a GET request
  const { session_id, recordId, priceId, discountCode, customer, billing_date } = req.query;

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

    const customerId = customer;
    const paymentMethodId = session.payment_intent.payment_method;

    // 3. Set default payment method for future payments
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId
      }
    });

    // 4. Create subscription with billing anchor
    let subscriptionData = {
      customer: customerId,
      items: [{ price: priceId }],
      default_payment_method: paymentMethodId,
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription'
      },
      // Set billing anchor to charge on specific date it would be 1 or 15 of next month
      billing_cycle_anchor: getBillingAnchorTimestamp(billing_date),
      proration_behavior: 'none', // Don't prorate the first invoice
      metadata: {
        ...session.metadata,
        recordId: recordId || '',
        discountCode: discountCode || '',
        billing_date: billing_date || ''
      },
      expand: ['latest_invoice.payment_intent']
    };

    // Add discount if provided
    if (discountCode) {
      try {
        // First try to retrieve as a coupon
        const coupon = await stripe.coupons.retrieve(discountCode);
        if (coupon) {
          subscriptionData.coupon = discountCode;
          console.log('Applied coupon:', discountCode);
        }
      } catch (couponError) {
        try {
          // If coupon fails, try as promotion code
          const promotionCodes = await stripe.promotionCodes.list({
            code: discountCode,
            limit: 1
          });
          
          if (promotionCodes.data.length > 0) {
            const promotionCode = promotionCodes.data[0];
            if (promotionCode.active) {
              // Use discounts array instead of promotion_code
              subscriptionData.discounts = [{
                promotion_code: promotionCode.id
              }];
              console.log('Applied promotion code:', promotionCode.id);
            } else {
              console.log('Promotion code is inactive:', discountCode);
            }
          } else {
            console.log('No valid discount found for code:', discountCode);
          }
        } catch (promoError) {
          console.error('Error applying discount:', promoError.message);
          // Don't throw error, just continue without discount
        }
      }
    }

    console.log('Creating subscription with data:', subscriptionData);
    
    const subscription = await stripe.subscriptions.create(subscriptionData);

    const session_url = `https://somevoices.co.uk/success`;

    res.redirect(302, `https://somevoices.co.uk/success?` + 
      `subscriptionId=${subscription.id}&` +
      `status=${subscription.status}`
    );

  } catch (error) {
    console.error('Success Initial Error:', {
      message: error.message,
      stack: error.stack,
      sessionId: session_id
    });
    res.status(500).json({
      error: 'Failed to create success subscription',
      message: error.message
    });
    // res.redirect(302, `https://somevoices.co.uk/cancelled?error=${encodeURIComponent(error.message)}`);
  }
}

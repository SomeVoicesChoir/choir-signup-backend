import Stripe from 'stripe';
import Airtable from 'airtable';
import { firstChargeFor } from '../../lib/firstCharge.js';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// ⚠️ No live traffic: all 1,370 trialled subscriptions from Apr–Oct 2026 came through
// create-subscription-first's Checkout. Kept on the shared first-charge rule anyway, so a
// revived path cannot quietly charge before the term starts.
async function firstTermAnchorFor(recordId) {
  if (!recordId) return null;
  try {
    const record = await base('Signup Queue').find(recordId);
    return record.fields['First Term Anchor'] || null;
  } catch (err) {
    // Fails to the legacy date (no deferral) — never to a later one.
    console.error('Could not read First Term Anchor (using legacy date):', err.message);
    return null;
  }
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });  // Change from req.body to req.query since this is a GET request
  const { session_id, recordId, priceId, discountCode, customer, billing_date, skipNextMonth } = req.query;  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  if (!priceId) return res.status(400).json({ error: 'Missing priceId' });  try {
    // 1. Retrieve the checkout session
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['payment_intent', 'customer']
    });    // 2. Verify payment status
    if (session.payment_status !== 'paid') {
      return res.status(400).json({
        error: 'Payment not completed',
        status: session.payment_status
      });
    }    const customerId = customer;
    const paymentMethodId = session.payment_intent.payment_method;    // Get payment method details
    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);    // Only set as default if it's a card (not iDEAL)
    if (paymentMethod.type === 'card') {
      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId
        }
      });
    }
    const { trialEnd, deferredMonths } = firstChargeFor({
      billingDate: billing_date,
      skipNextMonth,
      firstTermAnchor: await firstTermAnchorFor(recordId),
    });
    if (deferredMonths > 0) {
      // This path applies the coupon straight onto the subscription, so a REPEATING discount
      // would lose `deferredMonths` of its free months (Stripe counts from now). Logged rather
      // than handled because the path carries no traffic — handle it before reviving it.
      console.warn(`[first-charge] deferred ${deferredMonths} month(s) on the unused iDEAL path; a repeating discount is NOT extended here`);
    }
    // For subscription, use a different approach if payment was via iDEAL
    let subscriptionData = {
      customer: customerId,
      items: [{ price: priceId }],
      payment_settings: {
        payment_method_types: ['card'], // Force card for recurring payments
        save_default_payment_method: 'on_subscription'
      },
      // Set billing anchor to charge on specific date it would be 1 or 15 of next month
      // billing_cycle_anchor: getBillingAnchorTimestamp(billing_date, skipNextMonth),
      // set the trial period to 0
      trial_end: trialEnd,
      proration_behavior: 'none', // Don't prorate the first invoice
      automatic_tax: { enabled: true },
      metadata: {
        ...session.metadata,
        recordId: recordId || '',
        discountCode: discountCode || '',
        billing_date: billing_date || ''
      },
      expand: ['latest_invoice.payment_intent']
    };    // Add discount if provided
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
    }    console.log('Creating subscription with data:', subscriptionData);
    
    const subscription = await stripe.subscriptions.create(subscriptionData);    const session_url = `https://somevoices.co.uk/success`;    res.redirect(302, `https://somevoices.co.uk/success?` + 
      `subscriptionId=${subscription.id}&` +
      `status=${subscription.status}`
    );  } catch (error) {
    console.error('Success Initial Error:', {
      message: error.message,
      stack: error.stack,
      sessionId: session_id
    });
    // res.status(500).json({
    //   error: 'Failed to create success subscription',
    //   message: error.message
    // });
    res.redirect(302, `https://somevoices.co.uk/cancelled?error=${encodeURIComponent(error.message)}`);
  }
}

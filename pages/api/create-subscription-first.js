// create-subscription-first.js
import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app_url = process.env.APP_URL || 'https://choir-signup-backend-atuj.vercel.app';
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

function getBillingAnchorTimestamp(billing_date, skipNextMonth) {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const currentDay = now.getDate();
  
  // Parse billing_date (expecting format like "1st" or "15th" or just "1" or "15")
  const dayOfMonth = parseInt(billing_date.replace(/\D/g, ''));
  let billingDate;
  // if the billing date is passed then change the month
  if (currentDay > dayOfMonth || currentDay === dayOfMonth || skipNextMonth === 'Yes') {
      billingDate = new Date(currentYear, currentMonth + 1, dayOfMonth);
  } else {
      billingDate = new Date(currentYear, currentMonth, dayOfMonth);
  }
  // Stripe requires trial_end to be at least 48 hours in the future.
  // If the anchor is too close, push to next month.
  const minTrialEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  if (billingDate < minTrialEnd) {
    billingDate = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, dayOfMonth);
  }

  return Math.floor(billingDate.getTime() / 1000);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recordId, priceId, discountCode, billing_date, paymentMethod } = req.body;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });
  if (!priceId) return res.status(400).json({ error: 'Missing priceId' });

  try {
    // Fetch the record from Airtable
    const record = await base('Signup Queue').find(recordId);
    const email = record.fields['Email'];
    const existingCustomerId = record.fields['Stripe Customer ID'] || undefined;
    const skipNextMonth = record.fields['Skip Next Month'] || 'No';
    
    const amount = Number(record.fields['Total Cost Initial Invoice'] || 0);
    
    const currencyField = record.fields["Stripe 'default_price_data[currency]'"] || 'gbp';
    const currency = typeof currencyField === 'string'
      ? currencyField.toLowerCase()
      : Array.isArray(currencyField)
        ? currencyField[0].toLowerCase()
        : 'gbp';
    
    // Metadata for both subscription and initial payment
    const metadata = {
      choir: record.fields['Choir']?.[0] || '',
      voicePart: record.fields['Voice Part'] || '',
      firstName: record.fields['First Name'] || '',
      surname: record.fields['Surname'] || '',
      chartCode: (record.fields['Chart of Accounts Code'] || [])[0] || '',
      chartDescription: (record.fields['Chart of Accounts Full Length'] || [])[0] || '',
      trackingCode: String(record.fields['Tracking Code'] || ''),
      sku: String(record.fields['SKU'] || ''),
      choirName: String(record.fields['Choir Name'] || ''),
      skipNextMonth: skipNextMonth === 'Yes' ? 'Yes' : 'No',
      recordId,
    };

    // Validate existing customer ID or create a new one
    let finalCustomerId = '';
    if (email) {
      // Verify customer id base on email
      const customers = await stripe.customers.list({
        email: email,
        limit: 1
      });
      if (customers.data.length > 0) {
        finalCustomerId = customers.data[0].id;
        console.log('Found existing customer:', finalCustomerId);
      } else {
        const customer = await stripe.customers.create({
          email,
          name: `${record.fields['First Name'] || ''} ${record.fields['Surname'] || ''}`.trim(),
          metadata: {
            airtable_record_id: recordId
          }
        });
        finalCustomerId = customer.id;
        // Update Airtable with new customer ID
        await base('Signup Queue').update(recordId, {
          'Stripe Customer ID': finalCustomerId
        });
        console.log('Created new customer:', finalCustomerId);
      }
    }

    if (!finalCustomerId) {
      throw new Error('Unable to create or validate customer');
    }

    // Snapshot the pricing inputs as they stand RIGHT NOW, at the moment of sale.
    // {Billing Anchor Rehearsals Left Multiplier} and {Tier (Current)} are formulas
    // keyed on TODAY(), so they drift every day — by tomorrow the record no longer
    // shows what this customer was priced on. Nothing else can recover these after
    // the fact (the charge amount can be reconciled from Stripe later; the multiplier
    // and tier cannot). Non-fatal: never block a paying signup on bookkeeping.
    // typecast:true so a newly-added tier name creates its select option rather than 422ing.
    try {
      await base('Signup Queue').update(recordId, {
        'Multiplier at Signup': record.fields['Billing Anchor Rehearsals Left Multiplier'] ?? null,
        'Tier at Signup': record.fields['Tier (Current)'] || null,
      }, { typecast: true });
      console.log('Wrote signup snapshot:', record.fields['Tier (Current)'],
                  'x' + record.fields['Billing Anchor Rehearsals Left Multiplier']);
    } catch (snapshotErr) {
      console.error('Could not write signup snapshot (non-fatal):', snapshotErr.message);
    }

    // We'll create the subscription through the Stripe hosted page
    // No need to create it separately here

    console.log('Creating Stripe hosted subscription page');
    
    // Configure payment methods based on currency
    let payment_method_types = ['card'];
    
    // For EUR currency, offer SEPA Direct Debit (supports recurring payments)
    if (currency === 'eur') {
      payment_method_types = ['card', 'ideal'];
    }
    
    // Airtable's own summary string. No longer shown to the customer — the checkout
    // copy below is built from `amount`, the same number Stripe charges, so the two
    // cannot drift apart. Kept for the log, as a readable record of what Airtable
    // computed for this row.
    const description = record.fields['Initial Payment Description'] || 'Some Voices – Initial Pro-Rata Payment';
    console.log('Airtable summary for this signup:', description);

    // Retrieve the price to get the product ID
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const productId = typeof price.product === 'string' ? price.product : price.product.id;

    // --- Checkout copy -------------------------------------------------------
    // Split the one figure people actually care about into its two parts, so the
    // line items can say what each is for instead of repeating one long string.
    const choirName = record.fields['Choir Name'] || 'Some Voices';
    const sym = currency === 'eur' ? '€' : '£';
    const fmt = (pence) => sym + (Number(pence || 0) / 100).toFixed(2);
    const activationFee = Number(record.fields['Activation Fee'] || 0);
    const rehearsalPortion = Math.max(0, amount - activationFee);
    const monthlyAmount = Number(record.fields['Monthly Subscription Cost (inc Discount)']) || price.unit_amount;
    const joinMonth = new Date(record.fields['Created'] || Date.now())
      .toLocaleDateString('en-GB', { month: 'long' });

    // The product is shared by EVERY member of this choir, so it must never carry
    // one person's figures — two people checking out at once would each see the
    // other's amount, and whoever finished last would leave their number frozen
    // there for the next person. Personal detail belongs on the one-off line item
    // and in custom_text, both of which are per-session.
    await stripe.products.update(productId, {
      description: `Your monthly ${choirName} membership, billed on the same date each month.`,
    });

    // Compute trial_end once and format a human-readable date string for customer-facing messaging.
    // The "trial" here is Stripe's mechanism for delaying the first subscription invoice to the
    // customer's billing anchor — not a complimentary period.
    const trialEnd = getBillingAnchorTimestamp(billing_date, skipNextMonth);
    const trialEndDate = new Date(trialEnd * 1000);
    const trialEndReadable = trialEndDate.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    // Create a subscription session
    const sessionConfig = {
      customer: finalCustomerId,
      billing_address_collection: 'required',
      payment_method_collection: 'always',
      payment_method_types,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
        // Add initial payment if amount is greater than 0
        ...(amount > 0 ? [{
          price_data: {
            currency,
            unit_amount: amount,
            product_data: {
              // Name deliberately unchanged: it lands on the Stripe invoice line that
              // Zapier forwards to Xero, so it may be matched on downstream.
              name: `${record.fields['Choir Name'] || ''} - Initial Payment`,
              description: rehearsalPortion > 0
                ? `Rehearsals for the rest of ${joinMonth} ${fmt(rehearsalPortion)}, plus a one-off ${fmt(activationFee)} activation fee.`
                : `One-off ${fmt(activationFee)} activation fee. Your first monthly payment is ${fmt(monthlyAmount)} on ${trialEndReadable}.`,
            },
          },
          quantity: 1,
        }] : [])
      ],
      mode: 'subscription',
      success_url: `https://somevoices.co.uk/success?&recordId=${recordId}&status=active`,
      cancel_url: 'https://somevoices.co.uk/cancelled',
      metadata,
      subscription_data: {
        trial_end: trialEnd,
        description: `${choirName} monthly membership — first payment ${trialEndReadable}`,
        metadata,
      },
      custom_text: {
        submit: {
          // Lead with what they pay, then head off the "free" badge above. Stripe
          // renders any trial_end as "N days free" and gives us no way to relabel
          // it, so the wait until the first monthly payment has to be named here.
          message: `You'll pay ${fmt(amount)} today${rehearsalPortion > 0
            ? ` — ${fmt(rehearsalPortion)} for the rest of ${joinMonth}, plus a one-off ${fmt(activationFee)} activation fee`
            : ` — a one-off ${fmt(activationFee)} activation fee`}. Your ${fmt(monthlyAmount)} monthly payments then start on ${trialEndReadable}. Stripe shows that gap as "free" above — it isn't a free trial, just the wait until your first monthly payment date.`
        }
      },
      automatic_tax: { enabled: true },
      consent_collection: {
        terms_of_service: 'required'
      },
      phone_number_collection: {
        enabled: true
      },
      customer_update: {
        address: 'auto'
      },
    };

    // Add discount if provided
    if (discountCode) {
      try {
        // First try to retrieve as a coupon
        const coupon = await stripe.coupons.retrieve(discountCode);
        if (coupon) {
          sessionConfig.discounts = [{ coupon: discountCode }];
          console.log('Applied coupon to checkout:', discountCode);
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
              sessionConfig.discounts = [{ promotion_code: promotionCode.id }];
              console.log('Applied promotion code to checkout:', promotionCode.id);
            } else {
              console.log('Promotion code is inactive:', discountCode);
            }
          } else {
            console.log('No valid discount found for code:', discountCode);
          }
        } catch (promoError) {
          console.error('Error applying discount to checkout:', promoError.message);
          // Don't throw error, just continue without discount
        }
      }
    }

    console.log('Creating Stripe Checkout session with config:', sessionConfig);
    const session = await stripe.checkout.sessions.create(sessionConfig);

    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    const errorMessage = error instanceof Stripe.errors.StripeError 
      ? error.message 
      : 'Failed to create subscription checkout session';

    console.error('Detailed error:', {
      message: error.message,
      stack: error.stack,
      data: req.body
    });

    res.status(500).json({ 
      error: error.message,
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
}

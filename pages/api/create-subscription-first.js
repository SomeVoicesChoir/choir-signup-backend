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

    // We'll create the subscription through the Stripe hosted page
    // No need to create it separately here

    console.log('Creating Stripe hosted subscription page');
    
    // Configure payment methods based on currency and requested payment method
    let payment_method_types = ['card'];
    if (currency === 'eur' && paymentMethod === 'ideal') {
      payment_method_types = ['card', 'ideal']; // Include both options for EUR, with iDEAL as an option
    }
    
    const description = record.fields['Initial Payment Description'] || 'Some Voices – Initial Pro-Rata Payment';
    console.log('Using description:', description);

    // Retrieve the price to get the product ID
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const productId = typeof price.product === 'string' ? price.product : price.product.id;
    
    // Update the product description in Stripe
    await stripe.products.update(productId, {
      description: description
    });
    console.log('Updated product description in Stripe for product ID:', productId);

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
      ],
      mode: 'subscription',
      success_url: `${app_url}/api/initial-payment?session_id={CHECKOUT_SESSION_ID}&recordId=${recordId}&paymentMethod=${paymentMethod}&customer=${finalCustomerId}`,
      cancel_url: 'https://somevoices.co.uk/cancelled',
      metadata,
      subscription_data: {
        trial_end: getBillingAnchorTimestamp(billing_date, skipNextMonth),
        metadata,
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

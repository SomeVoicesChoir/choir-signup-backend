// create-initial-checkout.js
import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app_url = process.env.APP_URL || 'https://choir-signup-backend-atuj.vercel.app';
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recordId, priceId, discountCode, billing_date } = req.body;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });
  if (!priceId) return res.status(400).json({ error: 'Missing priceId' });

  try {

    // success page link
    const record = await base('Signup Queue').find(recordId);

    console.log('Creating checkout session for record:', record);
    const email = record.fields['Email'];
    const existingCustomerId = record.fields['Stripe Customer ID'] || undefined;

    const amount = Number(record.fields['Total Cost Initial Invoice'] || 0);

    const currencyField = record.fields["Stripe 'default_price_data[currency]'"] || 'gbp';
    const currency = typeof currencyField === 'string'
      ? currencyField.toLowerCase()
      : Array.isArray(currencyField)
        ? currencyField[0].toLowerCase()
        : 'gbp';

    const description = record.fields['Initial Payment Description'] || 'Some Voices – Initial Pro-Rata Payment';

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
    };

    console.log('Customer ID:', metadata);

    let payment_method_types = ['card'];
    if (currency === 'eur') {
      payment_method_types = ['card', 'ideal', 'sepa_debit'];
    }

    // Validate existing customer ID with Stripe
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
          console.log('Created new customer :', finalCustomerId);
        }
    }

    if (!finalCustomerId) {
      throw new Error('Unable to create or validate customer');
    }

    const successUrl = `${app_url}/api/create-success-subscription?session_id={CHECKOUT_SESSION_ID}&recordId=${recordId}&customer=${finalCustomerId}&priceId=${priceId}&discountCode=${discountCode}&billing_date=${billing_date}`;
    const sessionPayload = {
      mode: 'payment',
      payment_method_types,
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: amount,
            product_data: {
              name: description
            }
          },
          quantity: 1
        }
      ],
      automatic_tax: { enabled: true },
      customer: finalCustomerId,
      success_url: successUrl,
      cancel_url: 'https://somevoices.co.uk/cancelled',
      payment_intent_data: {
        setup_future_usage: 'off_session'
      },
      metadata,
      billing_address_collection: 'required',
      phone_number_collection: {
        enabled: true
      },
      consent_collection: {
        terms_of_service: 'required'
      },
      customer_update: {
        address: 'auto'
      },
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: 'Initial Pro-Rata Payment'
        }
      }
    };
    console.log('Creating Stripe Checkout session with payload:', sessionPayload);

    const session = await stripe.checkout.sessions.create(sessionPayload);

    res.status(200).json({ url: session.url });
  } catch (error) {
      const errorMessage = error instanceof Stripe.errors.StripeError 
      ? error.message 
      : 'Failed to create checkout session';

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

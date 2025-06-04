// create-initial-checkout.js
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

  const { recordId } = req.body;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });

  try {
    const record = await base('Signup Queue').find(recordId);

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
      chartDescription: (record.fields['Chart of Accounts Full Length'] || [])[0] || ''
    };

    let payment_method_types = ['card'];
    if (currency === 'eur') {
      payment_method_types = ['card', 'ideal', 'sepa_debit'];
    }

    // Ensure a Stripe customer exists
    let finalCustomerId = existingCustomerId;

    if (!finalCustomerId && email) {
      const customer = await stripe.customers.create({
        email,
        name: `${record.fields['First Name'] || ''} ${record.fields['Surname'] || ''}`.trim(),
        metadata: {
          airtable_record_id: recordId
        }
      });
      finalCustomerId = customer.id;

      await base('Signup Queue').update(recordId, {
        'Stripe Customer ID': finalCustomerId
      });
    }

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
      success_url: 'https://somevoices.co.uk/success-initial?session_id={CHECKOUT_SESSION_ID}',
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
      custom_fields: [
        {
          key: 'terms_confirmed',
          label: {
            type: 'custom',
            custom: 'I agree to the Terms & Conditions'
          },
          type: 'checkbox',
          optional: false
        }
      ],
      custom_text: {
        terms_of_service: {
          message: 'By continuing, you agree to our Membership Policy.',
          link: {
            text: 'Read the full policy',
            url: 'https://somevoices.co.uk/membership-policy'
          }
        }
      }
    };

    const session = await stripe.checkout.sessions.create(sessionPayload);

    res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

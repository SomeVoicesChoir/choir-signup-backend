// pages/api/stripe-webhook.js
import Stripe from 'stripe';
import Airtable from 'airtable';

// Disable Vercel's default body parsing for this API route!
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Helper to read raw buffer for signature validation
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Helper to get next 1st or 15th date
function getNextAnchorDate(anchorDay) {
  const now = new Date();
  let next;
  if (anchorDay === 15) {
    next = now.getDate() >= 15
      ? new Date(now.getFullYear(), now.getMonth() + 1, 15)
      : new Date(now.getFullYear(), now.getMonth(), 15);
  } else {
    next = now.getDate() >= 1
      ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
      : new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return next;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    if (session.mode === 'payment') {
      const recordId = session.metadata?.recordId;
      if (!recordId) return res.status(200).send('No recordId');

      try {
        const record = await base('Signup Queue').find(recordId);
        const customerId = session.customer; // Use Stripe customer ID from session
        const priceId = record.fields['Stripe PRICE_ID'];
        const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || undefined;
        const billingAnchor = Number(record.fields['Billing Anchor']) || 1;

        // Save Stripe Customer ID into Signup Queue
        await base('Signup Queue').update(recordId, {
          'Stripe Customer ID': customerId,
          'Initial Payment Status': 'Success',
        });

        // Create Stripe subscription
        const anchorDate = getNextAnchorDate(billingAnchor);
        const anchorUnix = Math.floor(anchorDate.getTime() / 1000);
        const chartCode = (record.fields['Chart of Accounts Code'] || [])[0] || '';
        const chartDescription = (record.fields['Chart of Accounts Full Length'] || [])[0] || '';

        await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: Array.isArray(priceId) ? priceId[0] : priceId }],
          billing_cycle_anchor: anchorUnix,
          coupon: couponId,
          metadata: {
            airtable_record_id: recordId,
            choir: record.fields['Choir']?.[0] || '',
            chartCode,
            chartDescription
          },
        });

        console.log(`Subscription created for customer: ${customerId}`);
      } catch (err) {
        console.error('Stripe subscription error:', err);
      }
    }
  }

  if (event.type === 'invoice.created') {
    const invoice = event.data.object;

    try {
      // Check if customer exists in Customer Record table
      const customerId = invoice.customer;
      const email = invoice.customer_email || '';
      const customerRecords = await base('Customer Record').select({
        filterByFormula: `{Stripe Customer_ID} = '${customerId}'`,
        maxRecords: 1,
      }).firstPage();

      let customerRecordId;
      if (customerRecords.length > 0) {
        customerRecordId = customerRecords[0].id;
      } else {
        // If no existing customer record, create one
        const newCustomer = await base('Customer Record').create({
          'Email': email,
          'Stripe Customer_ID': customerId,
        });
        customerRecordId = newCustomer.id;
      }

      // Create invoice record in Stripe Invoices table
      await base('Stripe Invoices').create({
        'Invoice_ID': invoice.id,
        'Invoice Number': invoice.number?.toString() || '',
        '*Link Customer Record': [customerRecordId],
        'Gross Amount': invoice.amount_due,
        'Currency': invoice.currency?.toUpperCase() || 'GBP',
        'Description': invoice.description || '',
        'Stripe Timestamp': new Date(invoice.created * 1000).toISOString(),
        'Subscription ID': invoice.subscription || '',
        'Status': invoice.status || '',
      });

      console.log(`Invoice logged for ${invoice.id}`);
    } catch (err) {
      console.error('Airtable error logging invoice:', err);
    }
  }

  res.status(200).send('Event received');
}
